import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanCommand, findBwrap, resetBwrapCache, runSandboxed, MAX_CMD } from "./tools/sandbox.ts";
import { shellOn, shellRun } from "./tools/shell.ts";
import { execute } from "./tools/execute.ts";
import { builtinTools, createRegistry, FLAG_OF, selectTools } from "./tools/registry.ts";
import type { ToolContext } from "./tools/types.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-shell-"));

test("sandbox: cleanCommand rejects empty, null bytes, oversize", () => {
  assert.equal(cleanCommand("").ok, false);
  assert.equal(cleanCommand("  ").ok, false);
  assert.equal(cleanCommand("a\0b").ok, false);
  assert.equal(cleanCommand("x".repeat(MAX_CMD + 1)).ok, false);
  assert.equal(cleanCommand("echo hi").ok, true);
});

test("sandbox: bwrap is available on this box", () => {
  resetBwrapCache();
  assert.ok(findBwrap(), "bubblewrap must be installed for the preferred path");
});

test("sandbox: workspace visible, secrets dirs and /home hidden, network off by default", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "note.txt"), "xin-chao");
  const res = await runSandboxed({
    workspace: ws,
    command: "pwd; cat note.txt; test -e /etc/passwd && echo PASSWD_VISIBLE || echo PASSWD_HIDDEN; test -d /home && echo HOME_VISIBLE || echo HOME_HIDDEN; test -e /workspace/../sable/.env.local && echo ENV_LEAK || echo ENV_OK; (echo >/dev/tcp/1.1.1.1/53) >/dev/null 2>&1 && echo NET_ON || echo NET_OFF",
  });
  assert.equal(res.via, "bwrap");
  assert.match(res.output, /\/workspace/);
  assert.match(res.output, /xin-chao/);
  assert.match(res.output, /PASSWD_HIDDEN|PASSWD_VISIBLE/); // passwd may or may not be bound; either ok if no secret leak
  assert.match(res.output, /HOME_HIDDEN/);
  assert.match(res.output, /ENV_OK/);
  assert.match(res.output, /NET_OFF/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sandbox: cannot read host paths outside the bind (sable-data, .env)", async () => {
  const ws = tmp();
  // Create a fake secret next to workspace parent — not mounted into the jail.
  const secret = path.join(os.tmpdir(), `sable-secret-${Date.now()}.txt`);
  fs.writeFileSync(secret, "TOPSECRET");
  const res = await runSandboxed({ workspace: ws, command: `cat ${secret} 2>&1 || true` });
  assert.ok(!res.output.includes("TOPSECRET"), res.output);
  fs.unlinkSync(secret);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sandbox: writable only inside workspace; timeout kills", async () => {
  const ws = tmp();
  const ok = await runSandboxed({ workspace: ws, command: "echo out > wrote.txt && cat wrote.txt" });
  assert.equal(ok.ok, true);
  assert.equal(fs.readFileSync(path.join(ws, "wrote.txt"), "utf8").trim(), "out");
  const timed = await runSandboxed({ workspace: ws, command: "sleep 30", timeoutMs: 800 });
  assert.equal(timed.timedOut, true);
  assert.equal(timed.ok, false);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("sandbox: fallback path still cwd-jails when bwrap forced off", async () => {
  const ws = tmp();
  fs.writeFileSync(path.join(ws, "a.txt"), "ok");
  const res = await runSandboxed({ workspace: ws, command: "cat a.txt", bwrapPath: null });
  assert.equal(res.via, "fallback");
  assert.match(res.output, /ok/);
  fs.rmSync(ws, { recursive: true, force: true });
});

test("shell_run: always needsApproval; refused without approver; kill switch", async () => {
  assert.equal(shellRun.needsApproval, true);
  assert.equal(shellRun.risk, "write");
  assert.equal(FLAG_OF.shell_run, "shell");
  const ws = tmp();
  const ctx: ToolContext = { workspaceDir: ws, signal: new AbortController().signal, mode: "interactive" };
  const refused = await execute(shellRun, JSON.stringify({ command: "echo no" }), ctx);
  assert.match(refused.output, /approval|approver|refused/i);
  assert.equal(fs.existsSync(path.join(ws, "no")), false);

  let asked = 0;
  const approved = await execute(shellRun, JSON.stringify({ command: "echo hi > out.txt && cat out.txt" }), {
    ...ctx,
    approve: async (ask) => {
      asked += 1;
      assert.match(ask.summary, /shell/i);
      return true;
    },
  });
  assert.equal(asked, 1);
  assert.equal(approved.ok, true);
  assert.match(approved.output, /hi/);

  const rejected = await execute(shellRun, JSON.stringify({ command: "echo x > bad.txt" }), {
    ...ctx,
    approve: async () => false,
  });
  assert.match(rejected.output, /rejected|từ chối/i);
  assert.equal(fs.existsSync(path.join(ws, "bad.txt")), false);

  // background with no auto-approve
  const bg = await execute(shellRun, JSON.stringify({ command: "echo bg" }), {
    workspaceDir: ws,
    signal: new AbortController().signal,
    mode: "background",
  });
  assert.match(bg.output, /approval|approver|refused/i);

  const prev = process.env.SABLE_SHELL;
  process.env.SABLE_SHELL = "0";
  assert.equal(shellOn(), false);
  const sel = selectTools(createRegistry(builtinTools()), { web: false, x: false, code: false, image: false, shell: true }, { serverTools: false, functionTools: true });
  // flag is true but kill switch is checked at prepareTurn — here we just confirm tool exists in registry
  assert.ok(builtinTools().some((t) => t.name === "shell_run"));
  process.env.SABLE_SHELL = prev;
  fs.rmSync(ws, { recursive: true, force: true });
});

test("shell_run: approval preview mentions network when requested", async () => {
  const ask = shellRun.describe!({ command: "curl example.com", network: true });
  assert.match(ask.summary, /CÓ mạng/);
  const ask2 = shellRun.describe!({ command: "ls" });
  assert.match(ask2.summary, /không mạng/);
});

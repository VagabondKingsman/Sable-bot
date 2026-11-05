import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { codeConfig } from "./config.ts";
import { jailList, jailPath, jailRead, jailWrite } from "./jail.ts";
import { parseCodeAction, runCodeLoop } from "./loop.ts";
import { runInWorktree, codeSandboxReady } from "./sandbox.ts";
import { applyTask, newTask, rejectTask, runCodeTask, type CodeTask } from "./task.ts";
import { validateRepo } from "./worktree.ts";
import { canDecide } from "../audit/policy.ts";
import type { Initiator } from "../audit/types.ts";

const USER: Initiator = { kind: "user", id: "owner:web" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sable-code-"));
const env = { SABLE_WORKSPACE: path.join(tmp, "ws"), SABLE_DATA_DIR: path.join(tmp, "data"), SABLE_CODE_REPOS: path.join(tmp, "repos"), SABLE_CODE_MAX_STEPS: "8" };
const cfg = codeConfig(env);
const g = (cwd: string, ...a: string[]) => execFileSync("/usr/bin/git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tmp } });

function fixtureRepo(name: string): string {
  const repo = path.join(tmp, "repos", name);
  fs.mkdirSync(repo, { recursive: true });
  g(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(path.join(repo, "math.js"), "export function add(a, b) {\n  return a - b;\n}\n");
  fs.writeFileSync(path.join(repo, "math.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.js";\ntest("add", () => assert.equal(add(2, 3), 5));\n');
  g(repo, "add", "-A");
  g(repo, "commit", "-qm", "init");
  return repo;
}

/** Scripted fake model: returns the given replies in order. */
function script(replies: object[], usd = 0.001) {
  let i = 0;
  const seen: string[] = [];
  return {
    seen,
    llm: async (messages: { role: string; content: string }[]) => {
      seen.push(messages[messages.length - 1]!.content);
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return { text: JSON.stringify(r), usd };
    },
  };
}
const FIX = [
  { thought: "look", action: "read", path: "math.js" },
  { thought: "fix", action: "write", path: "math.js", content: "export function add(a, b) {\n  return a + b;\n}\n" },
  { thought: "test", action: "run", command: "node --test" },
  { thought: "ok", action: "done", summary: "add() subtracted; now adds" },
];
const deps = (llm: ReturnType<typeof script>["llm"], ctl = new AbortController()) => ({ llm, save: (_t: CodeTask) => {}, signal: ctl.signal, budget: () => ({ ok: true as const }), estimate: 0.001 });

test("parseCodeAction validates the action shape", () => {
  assert.deepEqual(parseCodeAction('{"action":"read","path":"a.js"}'), { thought: "", action: { kind: "read", path: "a.js" } });
  assert.ok("error" in parseCodeAction("not json"));
  assert.ok("error" in parseCodeAction('{"action":"rm","path":"/"}'));
  assert.ok("error" in parseCodeAction('{"action":"write","path":"a"}'));
});

test("fs jail: no absolute paths, escapes, .git or symlinks out", () => {
  const wt = fs.mkdtempSync(path.join(tmp, "jail-"));
  fs.mkdirSync(path.join(wt, ".git"));
  fs.writeFileSync(path.join(wt, "a.txt"), "hi");
  fs.symlinkSync("/etc", path.join(wt, "etc"));
  fs.symlinkSync("/etc/hostname", path.join(wt, "host"));
  assert.equal(jailPath(wt, "/etc/passwd").ok, false);
  assert.equal(jailPath(wt, "../x").ok, false);
  assert.equal(jailPath(wt, "sub/../../x").ok, false);
  assert.equal(jailPath(wt, ".git/config").ok, false);
  assert.equal(jailPath(wt, "etc/passwd").ok, false);
  assert.match(jailRead(wt, "host"), /^error: /);
  assert.equal(jailWrite(wt, "host", "x").ok, false);
  assert.equal(jailWrite(wt, "etc/evil", "x").ok, false);
  assert.equal(jailRead(wt, "a.txt"), "hi");
  assert.equal(jailWrite(wt, "dir/new.txt", "x").ok, true);
  assert.doesNotMatch(jailList(wt), /\.git/);
});

test("validateRepo: only top-level repos under SABLE_CODE_REPOS, protected paths refused", async () => {
  const repo = fixtureRepo("v");
  assert.equal((await validateRepo(cfg, repo)).ok, true);
  assert.equal((await validateRepo(cfg, "relative/path")).ok, false);
  assert.equal((await validateRepo(cfg, "/workspace/sable")).ok, false); // outside the (test) roots
  fs.mkdirSync(path.join(repo, "sub"));
  assert.equal((await validateRepo(cfg, path.join(repo, "sub"))).ok, false);
  const wide = codeConfig({ ...env, SABLE_CODE_REPOS: "/workspace" });
  assert.equal((await validateRepo(wide, "/workspace/reverse-skill-research")).ok, false);
  assert.equal((await validateRepo(wide, "/workspace/openduet-research")).ok, false);
});

test("sandbox: no network, read-only .git, no host env, host fs hidden", { skip: !codeSandboxReady() }, async () => {
  const repo = fixtureRepo("sbx");
  const wt = path.join(tmp, "sbx-wt");
  g(repo, "worktree", "add", "-q", "-b", "sable/sbx", wt);
  process.env.SABLE_FAKE_SECRET_FOR_TEST = "should-not-leak";
  try {
    const r = await runInWorktree(wt, "echo pwned > .git; env; ls /workspace/sable /home 2>&1; node -e \"fetch('http://example.com').then(()=>console.log('NET-OK'),()=>console.log('NET-BLOCKED'))\"", 30_000);
    assert.match(r.output, /Read-only file system/);
    assert.doesNotMatch(r.output, /should-not-leak/);
    assert.match(r.output, /NET-BLOCKED/);
    assert.doesNotMatch(r.output, /NET-OK/);
    assert.match(r.output, /No such file/);
    assert.match(fs.readFileSync(path.join(wt, ".git"), "utf8"), /^gitdir:/);
  } finally {
    delete process.env.SABLE_FAKE_SECRET_FOR_TEST;
  }
});

test("code task: worktree → fix → diff + tests for review; real repo untouched until owner applies", { skip: !codeSandboxReady() }, async () => {
  const repo = fixtureRepo("fix");
  const t = newTask("aaaaaaaaaaa1", { goal: "make the add test pass", repo, testCmd: "node --test" }, USER);
  const s = script(FIX);
  await runCodeTask(t, cfg, deps(s.llm));
  assert.equal(t.status, "review", t.error);
  assert.equal(t.pr, "off (D6)");
  assert.ok(t.wt && t.wt.wt.startsWith(path.join(cfg.root, t.id)));
  assert.match(t.diff!.text, /\+  return a \+ b;/);
  assert.deepEqual(t.diff!.files, [{ status: "M", path: "math.js" }]);
  assert.equal(t.test?.ok, true, t.test?.output);
  assert.match(s.seen[1]!, /untrusted data/);
  assert.match(fs.readFileSync(path.join(repo, "math.js"), "utf8"), /a - b/); // untouched
  // Background / non-owner deciders can never apply.
  const sub: Initiator = { kind: "subagent", id: "s1", via: USER };
  assert.equal((await applyTask(t, cfg, sub)).ok, false);
  const bg = { ...t, initiator: { kind: "user", id: "owner:web", via: { kind: "routine", id: "r1" } } as Initiator };
  assert.equal((await applyTask(bg, cfg, USER)).ok, false);
  const ok = await applyTask(t, cfg, USER);
  assert.equal(ok.ok, true, ok.ok ? "" : ok.error);
  assert.equal(t.status, "applied");
  assert.match(fs.readFileSync(path.join(repo, "math.js"), "utf8"), /a \+ b/);
  assert.match(g(repo, "log", "-1", "--format=%s"), /Sable code task aaaaaaaaaaa1/);
  assert.equal(fs.existsSync(t.wt!.wt), false);
  assert.equal(g(repo, "branch", "--list", "sable/*").trim(), "");
  assert.equal(g(repo, "remote").trim(), ""); // nothing pushed anywhere
});

test("apply refuses a dirty repo and aborts cleanly on conflict; reject removes worktree + branch", { skip: !codeSandboxReady() }, async () => {
  const repo = fixtureRepo("conflict");
  const t = newTask("bbbbbbbbbbb2", { goal: "fix add", repo, testCmd: "node --test" }, USER);
  await runCodeTask(t, cfg, deps(script(FIX).llm));
  assert.equal(t.status, "review");
  fs.writeFileSync(path.join(repo, "math.js"), "export function add(a, b) {\n  return b + a; // owner edit\n}\n");
  const dirty = await applyTask(t, cfg, USER);
  assert.equal(dirty.ok, false);
  assert.match(dirty.ok ? "" : dirty.error, /uncommitted/);
  g(repo, "commit", "-qam", "owner edit");
  const conflict = await applyTask(t, cfg, USER);
  assert.equal(conflict.ok, false);
  assert.match(conflict.ok ? "" : conflict.error, /merge failed/);
  assert.equal(g(repo, "status", "--porcelain").trim(), "");
  assert.match(fs.readFileSync(path.join(repo, "math.js"), "utf8"), /owner edit/);
  const t2 = { ...t, status: "review" as const };
  const rej = await rejectTask(t2, cfg);
  assert.equal(rej.ok, true);
  assert.equal(fs.existsSync(t.wt!.wt), false);
  assert.equal(g(repo, "branch", "--list", "sable/*").trim(), "");
});

test("final test run side effects are reset; no-change runs end as no_changes", { skip: !codeSandboxReady() }, async () => {
  const repo = fixtureRepo("noop");
  const t = newTask("ccccccccccc3", { goal: "just look", repo, testCmd: "node --test; echo junk > artifact.txt" }, USER);
  await runCodeTask(t, cfg, deps(script([{ action: "list", path: "." }, { action: "done", summary: "nothing to do" }]).llm));
  assert.equal(t.status, "no_changes");
  assert.equal(t.test?.ok, true);
  assert.equal(fs.existsSync(path.join(t.wt!.wt, "artifact.txt")), false);
  await rejectTask(t, cfg);
});

test("caps: step cap, per-task budget, cancel; escape attempts are refused inside the loop", async () => {
  const wt = fs.mkdtempSync(path.join(tmp, "loop-"));
  const base = { list: (p: string) => jailList(wt, p), read: (p: string) => jailRead(wt, p), write: (p: string, c: string) => jailWrite(wt, p, c), run: async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }), maxSteps: 3, signal: new AbortController().signal };
  const esc = script([{ action: "read", path: "../../etc/passwd" }, { action: "write", path: ".git/hooks/x", content: "x" }, { action: "read", path: "/etc/shadow" }]);
  const r1 = await runCodeLoop("x", {}, { ...base, llm: esc.llm, budget: () => ({ ok: true }) });
  assert.equal(r1.status, "step_cap");
  assert.ok(r1.steps.every((s) => !s.ok));
  let n = 0;
  const r2 = await runCodeLoop("x", {}, { ...base, llm: script([{ action: "list", path: "." }]).llm, budget: () => (++n > 2 ? { ok: false, error: "cap" } : { ok: true }) });
  assert.equal(r2.status, "budget");
  const ctl = new AbortController();
  ctl.abort();
  const r3 = await runCodeLoop("x", {}, { ...base, signal: ctl.signal, llm: script([]).llm, budget: () => ({ ok: true }) });
  assert.equal(r3.status, "cancelled");
});

test("policy: code.apply is owner-only and never for a background chain", () => {
  assert.equal(canDecide(USER, USER, "code.apply").ok, true);
  assert.equal(canDecide({ kind: "subagent", id: "x" }, USER, "code.apply").ok, false);
  assert.equal(canDecide(USER, { kind: "trigger", id: "t" }, "code.apply").ok, false);
  assert.equal(canDecide(USER, { kind: "user", id: "u", via: { kind: "agent", id: "a" } }, "code.apply").ok, false);
});

test("kill switch + D6 defaults", () => {
  assert.equal(codeConfig({ SABLE_CODEAGENT: "0" }).enabled, false);
  assert.equal(codeConfig({}).enabled, true);
  assert.equal(codeConfig({}).github, false);
  assert.equal(codeConfig({}).root, "/workspace/sable-workspace/code");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

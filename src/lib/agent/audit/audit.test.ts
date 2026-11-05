import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { canDecide } from "./policy.ts";
import { AuditLog } from "./log.ts";
import { BACKGROUND_KINDS, INITIATOR_KINDS, USER, isInitiatorKind, type Initiator } from "./types.ts";
import { initiatorFor } from "../jobs/runner.ts";
import { execute } from "../tools/execute.ts";
import type { FunctionTool, ToolContext } from "../tools/types.ts";
import { chatAdapter } from "../adapters.ts";
import type { Transport } from "../loop.ts";
import { createSpawner } from "../spawn.ts";
import type { Frame } from "../sse.ts";

const routine: Initiator = { kind: "routine", id: "r1" };

test("policy: background kinds can never decide (incl. their own ask)", () => {
  for (const kind of BACKGROUND_KINDS) {
    const me: Initiator = { kind, id: "x" };
    assert.equal(canDecide(me, me).ok, false, `${kind} self-approve`);
    assert.equal(canDecide(me, USER).ok, false, `${kind} approving user ask`);
    assert.equal(canDecide(me, null).ok, false);
  }
  assert.deepEqual([...BACKGROUND_KINDS].sort(), ["agent", "routine", "subagent", "trigger"]);
});

test("policy: owner (user) and allow-listed channels may decide; webhook self-approval denied", () => {
  assert.equal(canDecide(USER, routine).ok, true);
  assert.equal(canDecide({ kind: "channel", id: "telegram:42" }, routine).ok, true);
  assert.equal(canDecide({ kind: "channel", id: "telegram:42" }, { kind: "channel", id: "telegram:42" }).ok, true, "owner's own telegram chat is a human");
  const peer: Initiator = { kind: "channel", id: "webhook:app1" };
  assert.equal(canDecide(peer, routine).ok, true);
  const self = canDecide(peer, peer);
  assert.equal(self.ok, false);
  assert.match((self as { reason: string }).reason, /self-approval/);
  // a sub-agent spawned under the peer's run is the same chain
  assert.equal(canDecide(peer, { kind: "subagent", id: "s", via: peer }).ok, false);
  assert.equal(canDecide({ kind: "channel", id: "sms:1" }, routine).ok, false, "unknown channel");
});

test("initiatorFor maps job origins", () => {
  assert.deepEqual(initiatorFor({ origin: { channel: "telegram", chatId: 7 } as never }), { kind: "channel", id: "telegram:7" });
  assert.deepEqual(initiatorFor({ origin: { channel: "webhook", peerId: "p" } as never }), { kind: "channel", id: "webhook:p" });
  assert.deepEqual(initiatorFor({ routineId: "r9" }), { kind: "routine", id: "r9" });
  assert.deepEqual(initiatorFor({ routineId: "r9", manual: true }), { kind: "user", id: "owner:run-now:r9" });
  assert.deepEqual(initiatorFor({}), { kind: "user", id: "owner:web" });
  for (const k of INITIATOR_KINDS) assert.ok(isInitiatorKind(k));
  assert.equal(isInitiatorKind("root"), false);
});

test("AuditLog: 0600, initiator_kind on every record, filters, redaction, rotation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-audit-"));
  const log = new AuditLog(dir);
  log.record({ type: "side_effect", initiator: routine, tool: "fs_write", summary: "fs_write · a.txt", ok: true, jobId: "j1" });
  log.record({ type: "approval.requested", initiator: { kind: "subagent", id: "s1", via: routine }, approvalId: "a1", jobId: "j1" });
  log.record({ type: "approval.denied_policy", initiator: routine, decider: routine, approvalId: "a1", reason: "routine initiators can never approve" });
  log.record({ type: "side_effect", initiator: USER, tool: "http", summary: "token xai-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef", ok: true });
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  const all = log.list();
  assert.equal(all.length, 4);
  assert.ok(all.every((r) => isInitiatorKind(r.initiator_kind) && r.initiator_id));
  assert.equal(log.list({ jobId: "j1" }).length, 2);
  assert.equal(log.list({ kind: "subagent" })[0].via_kind, "routine");
  assert.equal(log.list({ type: "approval.denied_policy" })[0].decider_kind, "routine");
  assert.doesNotMatch(JSON.stringify(log.list({ kind: "user" })), /xai-ABCDEFGHIJ/);
  for (let i = 0; i < 5_000; i++) log.record({ type: "side_effect", initiator: USER, tool: "t", summary: String(i) });
  const lines = fs.readFileSync(log.file, "utf8").split("\n").filter(Boolean).length;
  assert.ok(lines <= 5_000 && lines >= 4_000, `rotated to ${lines}`);
  assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

const tool = (name: string, risk: FunctionTool["risk"], needsApproval = false): FunctionTool<{ p: string }> => ({
  kind: "function",
  name,
  description: name,
  parameters: { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
  risk,
  needsApproval,
  timeoutMs: 1000,
  maxOutput: 1000,
  label: (a) => `${name} · ${a.p}`,
  run: async () => ({ ok: true, output: "ok" }),
});

test("execute: non-read tools are audited with the initiator; read tools are not; denials audited too", async () => {
  const seen: { tool: string; initiator: Initiator; ok: boolean }[] = [];
  const base: ToolContext = { workspaceDir: "/tmp/x", signal: new AbortController().signal, mode: "background", initiator: routine, audit: (e) => seen.push(e) };
  await execute(tool("fs_read", "read") as FunctionTool, JSON.stringify({ p: "a" }), base);
  assert.equal(seen.length, 0);
  await execute(tool("fs_write", "write", true) as FunctionTool, JSON.stringify({ p: "a" }), base);
  assert.equal(seen.length, 1, "refused write (no approver) still audited");
  assert.equal(seen[0].ok, false);
  assert.equal(seen[0].initiator.kind, "routine");
  await execute(tool("http_post", "network") as FunctionTool, JSON.stringify({ p: "b" }), { ...base, initiator: USER });
  assert.equal(seen[1].tool, "http_post");
  assert.equal(seen[1].initiator.kind, "user");
});

test("spawn: child side effects carry initiator_kind subagent chained to the parent", async () => {
  const frames: Frame[][] = [
    [{ event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "fs_write", arguments: JSON.stringify({ p: "a" }) } }] }, finish_reason: "tool_calls" }] } }],
    [{ event: "", json: { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] } }],
  ];
  let n = 0;
  const transport: Transport = async function* () {
    for (const f of frames[n++] ?? []) yield f;
  };
  const w = tool("fs_write", "write", true) as FunctionTool;
  const seen: { initiator: Initiator }[] = [];
  const spawn = createSpawner({ adapter: chatAdapter, transport, opts: { model: "m", effort: "low", maxTokens: 100 }, functions: [w] }, [w], () => {}, { maxChildren: 1, maxSteps: 3, timeoutMs: 5000 });
  await spawn(
    { task: "t", profile: "writer" },
    { workspaceDir: "/tmp/x", signal: new AbortController().signal, mode: "background", stepId: "tool-0-p1", initiator: routine, audit: (e) => seen.push(e), approve: async () => false },
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].initiator.kind, "subagent");
  assert.equal(seen[0].initiator.via?.kind, "routine");
});

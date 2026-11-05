import test from "node:test";
import assert from "node:assert/strict";
import { actionMark, describeAction, needsApproval, parseAction, xdotoolSteps } from "./actions.ts";
import { desktopRefusal, desktopTools } from "./tools.ts";
import { desktopConfig, DESKTOP_DISPLAY } from "./config.ts";
import { canDecide } from "../audit/policy.ts";
import { execute } from "../tools/execute.ts";
import { createApprovals } from "../tools/approvals.ts";
import type { ToolContext } from "../tools/types.ts";

const B = { width: 1280, height: 800 };
const USER = { kind: "user", id: "owner:web" } as const;

test("config: display is always :99, caps hold", () => {
  assert.equal(DESKTOP_DISPLAY, ":99");
  const c = desktopConfig({ SABLE_DESKTOP_MAX_STEPS: "999", SABLE_HEAVY_MAX: "9" } as never);
  assert.equal(c.maxSteps, 40);
  assert.equal(c.heavyMax, 2);
  assert.equal(desktopConfig({ SABLE_DESKTOP: "0" } as never).enabled, false);
  assert.equal(desktopConfig({} as never).enabled, true);
});

test("parseAction: bounds checks", () => {
  assert.equal(parseAction({ kind: "click", x: 10, y: 10 }, B).ok, true);
  assert.equal(parseAction({ kind: "click", x: 1280, y: 10 }, B).ok, false);
  assert.equal(parseAction({ kind: "click", x: -1, y: 10 }, B).ok, false);
  assert.equal(parseAction({ kind: "click", x: 5, y: 800 }, B).ok, false);
  assert.equal(parseAction({ kind: "click", x: "a", y: 1 }, B).ok, false);
  assert.equal(parseAction({ kind: "scroll", direction: "down", x: 2000, y: 1 }, B).ok, false);
  assert.equal(parseAction({ kind: "click", x: 1, y: 1, button: "evil" }, B).ok, false);
  assert.equal(parseAction({ kind: "rm" }, B).ok, false);
});

test("parseAction: keys whitelist + banned combos", () => {
  assert.equal(parseAction({ kind: "key", keys: "ctrl+l Return" }, B).ok, true);
  assert.equal(parseAction({ kind: "key", keys: "ctrl+alt+BackSpace" }, B).ok, false);
  assert.equal(parseAction({ kind: "key", keys: "ctrl+alt+F1" }, B).ok, false);
  assert.equal(parseAction({ kind: "key", keys: "$(reboot)" }, B).ok, false);
  assert.equal(parseAction({ kind: "key", keys: "a b c d e f g" }, B).ok, false);
});

test("parseAction: type limits", () => {
  assert.equal(parseAction({ kind: "type", text: "x".repeat(2001) }, B).ok, false);
  assert.equal(parseAction({ kind: "type", text: "a\u0007b" }, B).ok, false);
  assert.equal(parseAction({ kind: "type", text: "" }, B).ok, false);
  assert.equal(parseAction({ kind: "wait", ms: 50 }, B).ok, false);
});

test("xdotool: typed text only on stdin, never argv", () => {
  const p = parseAction({ kind: "type", text: "hunter2-secret", secret: true, enter: true }, B);
  assert.ok(p.ok);
  const steps = xdotoolSteps(p.value);
  assert.equal(steps[0]!.input, "hunter2-secret");
  for (const s of steps) assert.ok(!s.args.join(" ").includes("hunter2"));
  assert.deepEqual(steps[0]!.args.slice(-2), ["--file", "-"]);
  assert.deepEqual(steps[1]!.args, ["key", "--clearmodifiers", "Return"]);
});

test("describeAction redacts secret text", () => {
  const p = parseAction({ kind: "type", text: "hunter2-secret", secret: true }, B);
  assert.ok(p.ok);
  const d = describeAction(p.value);
  assert.ok(!d.includes("hunter2"));
  assert.match(d, /secret/);
  const c = parseAction({ kind: "click", x: 5, y: 6 }, B);
  assert.ok(c.ok);
  assert.deepEqual(actionMark(c.value), { x: 5, y: 6 });
  assert.equal(needsApproval(c.value), true);
  const w = parseAction({ kind: "wait", ms: 500 }, B);
  assert.ok(w.ok);
  assert.equal(needsApproval(w.value), false);
});

test("policy: desktop asks only by owner web, never background", () => {
  assert.equal(canDecide(USER, USER, "desktop_click").ok, true);
  assert.equal(canDecide({ kind: "channel", id: "telegram:1" }, USER, "desktop_click").ok, false);
  assert.equal(canDecide(USER, { kind: "routine", id: "r1" }, "desktop_click").ok, false);
  assert.equal(canDecide(USER, { kind: "user", id: "x", via: { kind: "trigger", id: "t" } }, "desktop.agent").ok, false);
  assert.equal(canDecide({ kind: "agent", id: "a" }, USER, "desktop_click").ok, false);
  // non-desktop tools unchanged
  assert.equal(canDecide({ kind: "channel", id: "telegram:1" }, USER, "fs_write").ok, true);
});

test("desktopRefusal: background + non-owner refused", () => {
  assert.ok(desktopRefusal({ mode: "background", initiator: USER }));
  assert.ok(desktopRefusal({ mode: "interactive", initiator: { kind: "channel", id: "telegram:1" } }));
  assert.ok(desktopRefusal({ mode: "interactive" }));
  assert.equal(desktopRefusal({ mode: "interactive", initiator: USER }), null);
});

function harness() {
  const log: string[] = [];
  const execd: unknown[] = [];
  const tools = desktopTools({
    bounds: () => B,
    ensure: async () => {},
    shot: async () => ({ id: "ab".repeat(12), url: `/api/desktop/shot/${"ab".repeat(12)}` }),
    exec: async (a) => void execd.push(a),
    title: async () => "Test page",
    registerAsk: (id) => log.push(`ask:${id}`),
    settleAsk: (id, s) => log.push(`settle:${id}:${s}`),
  });
  const by = (n: string) => tools.find((t) => t.name === n)!;
  return { tools, by, log, execd };
}

function ctxWith(approve: boolean | null, extra: Partial<ToolContext> = {}): { ctx: ToolContext; asks: unknown[]; audits: string[] } {
  const asks: unknown[] = [];
  const audits: string[] = [];
  const approvals = createApprovals(5_000, () => "id1");
  const ctx: ToolContext = {
    workspaceDir: "/tmp",
    signal: new AbortController().signal,
    mode: "interactive",
    initiator: USER,
    audit: (e) => void audits.push(e.summary),
    approve: approve === null ? undefined : async (ask) => {
      asks.push(ask);
      const p = approvals.request(ask, () => {}, new AbortController().signal);
      approvals.decide("id1", approve);
      return p;
    },
    ...extra,
  };
  return { ctx, asks, audits };
}

test("desktop_click: approval card carries screenshot + mark, executes only when approved", async () => {
  const h = harness();
  const ok = ctxWith(true);
  const r = await execute(h.by("desktop_click"), JSON.stringify({ x: 200, y: 280 }), ok.ctx);
  assert.equal(r.ok, true, r.output);
  const ask = ok.asks[0] as { image: string; mark: { x: number } };
  assert.match(ask.image, /^\/api\/desktop\/shot\//);
  assert.equal(ask.mark.x, 200);
  assert.equal(h.execd.length, 1);
  assert.deepEqual(h.log, ["ask:id1", "settle:id1:approved"]);
  const no = ctxWith(false);
  const r2 = await execute(h.by("desktop_click"), JSON.stringify({ x: 200, y: 280 }), no.ctx);
  assert.equal(r2.ok, false);
  assert.equal(h.execd.length, 1);
});

test("desktop tools refuse background before any card", async () => {
  const h = harness();
  const bg = ctxWith(true, { mode: "background" });
  const r = await execute(h.by("desktop_type"), JSON.stringify({ text: "hi" }), bg.ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /background/);
  assert.equal(bg.asks.length, 0);
  assert.equal(h.execd.length, 0);
  const shot = await execute(h.by("desktop_screenshot"), "{}", bg.ctx);
  assert.equal(shot.ok, false);
});

test("secret text never reaches card, audit or output", async () => {
  const h = harness();
  const c = ctxWith(true);
  const r = await execute(h.by("desktop_type"), JSON.stringify({ text: "s3cr3t-value-xyz", secret: true }), c.ctx);
  assert.equal(r.ok, true, r.output);
  const blob = JSON.stringify(c.asks) + c.audits.join("\n") + r.output + (r.detail ?? "");
  assert.ok(!blob.includes("s3cr3t-value-xyz"));
  assert.equal((h.execd[0] as { text: string }).text, "s3cr3t-value-xyz");
});

test("out-of-bounds click refused before approval", async () => {
  const h = harness();
  const c = ctxWith(true);
  const r = await execute(h.by("desktop_click"), JSON.stringify({ x: 5000, y: 1 }), c.ctx);
  assert.equal(r.ok, false);
  assert.equal(c.asks.length, 0);
});

test("screenshot + wait need no approval", async () => {
  const h = harness();
  const c = ctxWith(null);
  const r = await execute(h.by("desktop_screenshot"), "{}", c.ctx);
  assert.equal(r.ok, true, r.output);
  const w = await execute(h.by("desktop_wait"), JSON.stringify({ ms: 100 }), c.ctx);
  assert.equal(w.ok, true, w.output);
});

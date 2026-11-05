/**
 * W3 desktop server singleton: the :99 session, idle auto-stop, the noVNC bridge target.
 * Tools (item 2) and the vision loop (item 3) build on this. Kill switch SABLE_DESKTOP=0.
 */
import path from "node:path";
import { desktopConfig } from "@/lib/agent/desktop/config";
import { DesktopSession } from "@/lib/agent/desktop/session";
import { parseAllowlist } from "@/lib/agent/tools/fetch";
import { dataDir } from "@/server/paths";
import { setVncTarget } from "@/server/desktop-ws";
import crypto from "node:crypto";
import { xdotoolSteps, type DesktopAction } from "@/lib/agent/desktop/actions";
import { desktopTools } from "@/lib/agent/desktop/tools";
import { LOOK_SYSTEM, visionCall } from "@/lib/agent/desktop/vision";
import { resolveEndpoints } from "@/lib/agent/provider";
import { estimateUsd } from "@/lib/agent/budget/prices";
import { forSource } from "@/lib/agent/connectors/select";
import type { FunctionTool } from "@/lib/agent/tools/types";
import { plannerBundle } from "@/server/planner.server";

export type PendingAsk = { id: string; tool: string; summary: string; image: string; mark?: { x: number; y: number; w: number; h: number }; at: number; source: "chat" | "agent" };
type State = {
  session: DesktopSession;
  viewers: number;
  idleTimer: ReturnType<typeof setInterval> | null;
  busy: () => boolean;
  shots: Map<string, Buffer>;
  pending: Map<string, PendingAsk>;
};
const KEY = Symbol.for("sable.desktop.v1");

export function desktopOn() {
  return desktopConfig().enabled;
}

export function desktopState(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) {
    const session = new DesktopSession({
      config: () => desktopConfig(),
      dir: path.join(dataDir(), "desktop"),
      egress: { allow: parseAllowlist(process.env.SABLE_FETCH_ALLOW), fakeIpEgress: process.env.SABLE_FETCH_FAKE_IP === "1" },
      log: (m) => console.warn(m),
    });
    g[KEY] = { session, viewers: 0, idleTimer: null, busy: () => false, shots: new Map(), pending: new Map() };
    // Server exit: take the desktop down with us (Chrome already dies with its bwrap parent).
    process.once("exit", () => {
      for (const p of session.procs) p.child.kill("SIGKILL");
    });
    setVncTarget({
      port: desktopConfig().wsPort,
      running: () => desktopOn() && session.state === "running",
      viewer: (d) => {
        const s = g[KEY]!;
        s.viewers = Math.max(0, s.viewers + d);
        session.touch();
      },
    });
  }
  return g[KEY]!;
}

export function desktopSession() {
  return desktopState().session;
}

/** Item 3 registers "a run is active" so idle auto-stop never kills a working agent. */
export function setDesktopBusy(fn: () => boolean) {
  desktopState().busy = fn;
}

function armIdle() {
  const st = desktopState();
  if (st.idleTimer) return;
  st.idleTimer = setInterval(() => {
    const s = st.session;
    if (s.state !== "running") return;
    if (!desktopOn()) return void s.stop("switched off (SABLE_DESKTOP=0)");
    if (st.busy() || st.viewers > 0) return s.touch();
    if (Date.now() - s.lastActivity > desktopConfig().idleMin * 60_000) void s.stop("idle auto-stop");
  }, 30_000);
  (st.idleTimer as { unref?: () => void }).unref?.();
}

export async function startDesktop(url?: string) {
  if (!desktopOn()) throw new Error("Desktop đang tắt (SABLE_DESKTOP=0).");
  armIdle();
  await desktopSession().start({ url });
  return desktopStatus();
}

export async function stopDesktop(reason = "stopped by owner") {
  await desktopSession().stop(reason);
  return desktopStatus();
}

export function desktopStatus() {
  const st = desktopState();
  const s = st.session.status();
  const cfg = desktopConfig();
  const pw = st.session.vncPassword;
  return {
    enabled: cfg.enabled,
    ...s,
    viewers: st.viewers,
    idleMin: cfg.idleMin,
    // Owner-only (behind the desk auth) and no-store; the VNC password is per session and lives in the URL hash.
    viewUrl:
      s.state === "running" && pw
        ? `/api/desktop/novnc/vnc.html#autoconnect=1&resize=scale&reconnect=1&view_only=1&path=api/desktop/vnc&password=${encodeURIComponent(pw)}`
        : null,
  };
}

// ---- screenshots (ring of 40, random ids, served by /api/desktop/shot/<id>) ----
const SHOT_RING = 40;
export async function takeShot(signal?: AbortSignal): Promise<{ id: string; url: string; jpeg: Buffer }> {
  const st = desktopState();
  const jpeg = await st.session.screenshot(signal);
  const id = crypto.randomBytes(12).toString("hex");
  st.shots.set(id, jpeg);
  while (st.shots.size > SHOT_RING) st.shots.delete(st.shots.keys().next().value!);
  return { id, url: `/api/desktop/shot/${id}`, jpeg };
}
export function getShot(id: string): Buffer | null {
  return /^[a-f0-9]{24}$/.test(id) ? (desktopState().shots.get(id) ?? null) : null;
}

// ---- pending desktop approval cards (mirrored in the Desktop panel) ----
export function addPending(p: PendingAsk) {
  desktopState().pending.set(p.id, p);
}
export function settlePending(id: string) {
  desktopState().pending.delete(id);
}
export function pendingAsks(): PendingAsk[] {
  return [...desktopState().pending.values()];
}

export async function execAction(action: DesktopAction, signal?: AbortSignal) {
  const s = desktopSession();
  if (s.state !== "running") throw new Error("desktop is not running");
  for (const step of xdotoolSteps(action)) await s.xdotool(step.args, step.input, signal);
  if (action.kind === "wait") await new Promise((r) => setTimeout(r, action.ms));
}

/** Vision endpoint (xAI preferred) — key stays server-side, never logged. */
export function visionEndpoint() {
  const eps = resolveEndpoints(process.env);
  return eps.find((e) => e.xai) ?? eps[0] ?? null;
}

/** Budget-checked + recorded vision call about a stored screenshot. */
export async function lookAt(jpeg: Buffer, system: string, prompt: string, signal: AbortSignal, scopeId: string, json = false, maxTokens = 600) {
  const ep = visionEndpoint();
  if (!ep) throw new Error("no vision model endpoint configured");
  const model = desktopConfig().model;
  const meter = plannerBundle().budget;
  const verdict = meter.check({ addUsd: estimateUsd(model, 2_000, maxTokens) });
  if (!verdict.ok) throw new Error(verdict.error);
  const reply = await visionCall({ base: ep.base, key: ep.key, model, system, prompt, jpeg, signal, json, maxTokens });
  meter.record({ scope: "desktop", scopeId, model, promptTokens: reply.promptTokens, completionTokens: reply.completionTokens });
  return reply;
}

/** desktop_* tools: owner interactive chat only; none for jobs/routines or when switched off. */
export function desktopToolsFor(source: string): FunctionTool[] {
  if (!desktopOn() || source !== "chat") return [];
  const cfg = () => desktopConfig();
  const tools = desktopTools({
    bounds: () => ({ width: cfg().width, height: cfg().height }),
    ensure: async () => {
      if (desktopSession().state !== "running") await startDesktop();
    },
    shot: async (signal) => {
      const s = await takeShot(signal);
      return { id: s.id, url: s.url };
    },
    exec: (a, signal) => execAction(a, signal),
    title: () => desktopSession().activeWindowTitle(),
    look: async (shotId, question, signal) => {
      const jpeg = getShot(shotId);
      if (!jpeg) return "";
      return (await lookAt(jpeg, LOOK_SYSTEM, question, signal, "chat:look")).text.slice(0, 2_500);
    },
    registerAsk: (id, _initiator, tool, info) => addPending({ id, tool, summary: info.summary, image: info.image, mark: info.mark, at: Date.now(), source: "chat" }),
    settleAsk: (id) => settlePending(id),
  });
  return forSource(tools, source);
}

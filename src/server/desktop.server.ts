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

type State = { session: DesktopSession; viewers: number; idleTimer: ReturnType<typeof setInterval> | null; busy: () => boolean };
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
    g[KEY] = { session, viewers: 0, idleTimer: null, busy: () => false };
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

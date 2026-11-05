/**
 * W3 desktop computer-use defaults (Full Agentic plan):
 *  D1 one dedicated Xvfb display ":99" — fixed, never configurable, other displays never touched.
 *  D2 every input action (click/type/key/scroll) needs an owner approval card; screenshot/wait do not.
 *  D7 at most SABLE_HEAVY_MAX (default 2) heavy agents at once.
 * Kill switch: SABLE_DESKTOP=0 (nothing starts, tools hidden, API refuses).
 */
export const DESKTOP_DISPLAY = ":99";
export const DESKTOP_DISPLAY_NUM = 99;

export type DesktopConfig = {
  enabled: boolean;
  width: number;
  height: number;
  /** Auto-stop after this many idle minutes (no run, no viewer, no action). */
  idleMin: number;
  maxSteps: number;
  model: string;
  vncPort: number;
  wsPort: number;
  heavyMax: number;
  /** SABLE_DESKTOP_WM=none skips the window manager (saves ~80 MB with xfwm4). */
  wm: boolean;
};

const int = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.min(max, Math.max(min, Math.floor(n))) : def;
};

export function desktopConfig(env: Record<string, string | undefined> = process.env): DesktopConfig {
  return {
    enabled: env.SABLE_DESKTOP !== "0",
    width: 1280,
    height: 800,
    idleMin: int(env.SABLE_DESKTOP_IDLE_MIN, 10, 1, 240),
    maxSteps: int(env.SABLE_DESKTOP_MAX_STEPS, 15, 1, 40),
    model: (env.SABLE_DESKTOP_MODEL || "grok-4.7").trim().slice(0, 60),
    vncPort: int(env.SABLE_DESKTOP_VNC_PORT, 5999, 1024, 65535),
    wsPort: int(env.SABLE_DESKTOP_WS_PORT, 6099, 1024, 65535),
    heavyMax: int(env.SABLE_HEAVY_MAX, 2, 1, 2),
    wm: env.SABLE_DESKTOP_WM !== "none",
  };
}

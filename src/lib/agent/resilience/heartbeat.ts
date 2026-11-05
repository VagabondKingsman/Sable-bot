/**
 * Box-suspend / crash heartbeat. Pure helpers + tiny file store under dataDir.
 * A gap larger than `suspendGapMs` after wake means the box likely slept —
 * callers should run one routine catch-up tick (never a burst).
 */
import fs from "node:fs";
import path from "node:path";

export const HEARTBEAT_FILE = "heartbeat.json";
export const DEFAULT_SUSPEND_GAP_MS = 90_000; // > watchdog sleep (20s) + tick slack
export const DEFAULT_CATCHUP_ENV = "SABLE_CATCHUP";

export type HeartbeatState = {
  lastTickAt: number;
  lastWakeAt?: number;
  lastGapMs?: number;
  wokeFromSuspend?: boolean;
  pid?: number;
};

export function catchUpOn(env: NodeJS.ProcessEnv = process.env): boolean {
  // Fail-open for catch-up unless explicitly off. Alias SABLE_ROUTINE_CATCHUP.
  const catchup = (env.SABLE_CATCHUP ?? env.SABLE_ROUTINE_CATCHUP ?? "1").trim();
  return catchup !== "0";
}

export function readHeartbeat(dir: string): HeartbeatState | null {
  try {
    const raw = fs.readFileSync(path.join(dir, HEARTBEAT_FILE), "utf8");
    const parsed = JSON.parse(raw) as HeartbeatState;
    if (!parsed || typeof parsed.lastTickAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeHeartbeat(dir: string, state: HeartbeatState): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, HEARTBEAT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Detect suspend/crash gap and stamp a new tick. */
export function tickHeartbeat(
  dir: string,
  now = Date.now(),
  opts: { suspendGapMs?: number; pid?: number } = {},
): HeartbeatState {
  const gapMs = opts.suspendGapMs ?? DEFAULT_SUSPEND_GAP_MS;
  const prev = readHeartbeat(dir);
  const gap = prev ? Math.max(0, now - prev.lastTickAt) : 0;
  const woke = Boolean(prev && gap >= gapMs);
  const next: HeartbeatState = {
    lastTickAt: now,
    pid: opts.pid ?? process.pid,
    lastGapMs: prev ? gap : undefined,
    wokeFromSuspend: woke || undefined,
    lastWakeAt: woke ? now : prev?.lastWakeAt,
  };
  writeHeartbeat(dir, next);
  return next;
}

export type HealthSnapshot = {
  ok: true;
  now: number;
  heartbeat: HeartbeatState | null;
  catchUpEnabled: boolean;
  suspendGapMs: number;
  jobsRecoverHint: string;
};

export function healthSnapshot(dir: string, env: NodeJS.ProcessEnv = process.env, now = Date.now()): HealthSnapshot {
  return {
    ok: true,
    now,
    heartbeat: readHeartbeat(dir),
    catchUpEnabled: catchUpOn(env),
    suspendGapMs: DEFAULT_SUSPEND_GAP_MS,
    jobsRecoverHint: "JobRunner.recover() requeues interrupted running/waiting_approval jobs; scheduler planDue fires at most one catch-up per routine when enabled.",
  };
}

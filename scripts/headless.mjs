#!/usr/bin/env node
/**
 * Headless 24/7 runner for Sable on :8080.
 *
 * Keeps `vite dev` (or SABLE_HEADLESS_CMD) alive: restarts on crash with
 * backoff, writes pid/log under .grok/, and pings /api/jobs so background
 * jobs, routines, Telegram and webhooks start without opening a browser.
 *
 *   node scripts/headless.mjs start|stop|status|restart
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, ".grok");
const PID_FILE = join(DIR, "headless.pid");
const CHILD_PID_FILE = join(DIR, "headless-child.pid");
const LOG_FILE = join(DIR, "headless.log");
const PORT = Number(process.env.SABLE_PORT || 8080);
const PING = process.env.SABLE_HEADLESS_PING || `http://127.0.0.1:${PORT}/api/jobs`;
const CMD = process.env.SABLE_HEADLESS_CMD || "npm";
const ARGS = (process.env.SABLE_HEADLESS_ARGS || "run dev").split(/\s+/).filter(Boolean);
const MAX_BACKOFF_MS = 60_000;

function ensureDir() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function readPid(file) {
  try {
    const n = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function log(line) {
  const stamp = new Date().toISOString();
  const text = `[${stamp}] ${line}\n`;
  try {
    writeFileSync(LOG_FILE, text, { flag: "a", mode: 0o600 });
  } catch {
    /* ignore */
  }
  process.stdout.write(text);
}

async function pingOnce() {
  try {
    const res = await fetch(PING, { signal: AbortSignal.timeout(15_000) });
    return res.status;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function stopPid(pid, label) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline && alive(pid)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (alive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
  log(`stopped ${label} pid=${pid}`);
}

function stopAll() {
  stopPid(readPid(CHILD_PID_FILE), "child");
  stopPid(readPid(PID_FILE), "watchdog");
  rmSync(PID_FILE, { force: true });
  rmSync(CHILD_PID_FILE, { force: true });
}

function status() {
  const watch = readPid(PID_FILE);
  const child = readPid(CHILD_PID_FILE);
  const out = {
    watchdog: watch && alive(watch) ? { pid: watch, running: true } : { pid: watch, running: false },
    child: child && alive(child) ? { pid: child, running: true } : { pid: child, running: false },
    port: PORT,
    ping: PING,
    log: LOG_FILE,
  };
  console.log(JSON.stringify(out, null, 2));
  return out.watchdog.running && out.child.running ? 0 : 1;
}

function spawnChild() {
  ensureDir();
  const fd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn(CMD, ARGS, {
    cwd: ROOT,
    env: { ...process.env, SABLE_PUBLIC: process.env.SABLE_PUBLIC ?? "1" },
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
  writeFileSync(CHILD_PID_FILE, String(child.pid), { mode: 0o600 });
  log(`spawned child pid=${child.pid} cmd=${CMD} ${ARGS.join(" ")}`);
  return child.pid;
}

async function watchLoop() {
  ensureDir();
  writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
  log(`watchdog start pid=${process.pid}`);
  let backoff = 2_000;
  let childPid = readPid(CHILD_PID_FILE);
  if (!alive(childPid)) childPid = spawnChild();

  const shutdown = (sig) => {
    log(`watchdog got ${sig}`);
    stopPid(readPid(CHILD_PID_FILE), "child");
    rmSync(PID_FILE, { force: true });
    rmSync(CHILD_PID_FILE, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    childPid = readPid(CHILD_PID_FILE);
    if (!alive(childPid)) {
      log(`child dead; restart in ${backoff}ms`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(MAX_BACKOFF_MS, Math.round(backoff * 1.6));
      childPid = spawnChild();
      continue;
    }
    const code = await pingOnce();
    if (code === 200 || code === 401) {
      // 401 = basic auth in front — process is up.
      backoff = 2_000;
    } else {
      log(`ping ${PING} → ${code}`);
    }
  }
}

function startDetachedWatchdog() {
  ensureDir();
  const existing = readPid(PID_FILE);
  if (alive(existing)) {
    console.log(JSON.stringify({ ok: true, already: true, pid: existing }));
    return;
  }
  const fd = openSync(LOG_FILE, "a", 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", fd, fd],
    detached: true,
  });
  child.unref();
  // run mode writes PID_FILE itself; give it a moment
  setTimeout(() => {
    console.log(JSON.stringify({ ok: true, pid: readPid(PID_FILE) || child.pid, log: LOG_FILE }));
  }, 400);
}

const action = process.argv[2] || "status";
if (action === "start") startDetachedWatchdog();
else if (action === "run") void watchLoop();
else if (action === "stop") {
  stopAll();
  console.log(JSON.stringify({ ok: true, stopped: true }));
} else if (action === "restart") {
  stopAll();
  startDetachedWatchdog();
} else if (action === "status") process.exit(status());
else if (action === "ping") {
  pingOnce().then((code) => {
    console.log(JSON.stringify({ ping: PING, result: code }));
  });
} else {
  console.error("usage: node scripts/headless.mjs start|stop|status|restart|ping");
  process.exit(2);
}

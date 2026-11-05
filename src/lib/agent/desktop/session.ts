/**
 * W3 desktop session manager. Owns exactly one display, ":99" (D1):
 *   Xvfb :99 (no TCP, abstract socket only) → a light WM if one is installed →
 *   Chrome in bubblewrap (cleared env, read-only system, its own profile dir under sable-data,
 *   no view of /workspace, /home or sable-data; egress only through the SSRF-guard proxy) →
 *   x11vnc on 127.0.0.1 (per-session password, deleted from disk once read) → websockify on
 *   127.0.0.1 for noVNC (reached only through Sable's authenticated /api/desktop/vnc).
 * Children get a minimal env (PATH, DISPLAY) — never Sable's secrets. Pids are recorded so a
 * restart can clean up its own leftovers; a :99 owned by anything else is refused, not killed.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DESKTOP_DISPLAY, DESKTOP_DISPLAY_NUM, type DesktopConfig } from "./config.ts";
import { startEgressProxy, type EgressDeps, type EgressProxy } from "./proxy.ts";

export type DesktopState = "stopped" | "starting" | "running" | "stopping" | "error";

export type SessionStatus = {
  state: DesktopState;
  display: string;
  width: number;
  height: number;
  startedAt: number | null;
  lastActivity: number;
  wm: string | null;
  error: string | null;
  stoppedReason: string | null;
  blockedRequests: number;
  pids: Record<string, number>;
};

type Proc = { name: string; child: ChildProcess; marker: string };
type PidRec = { name: string; pid: number; marker: string };

const WMS: { bin: string; args: string[] }[] = [
  { bin: "openbox", args: [] },
  { bin: "matchbox-window-manager", args: ["-use_titlebar", "no"] },
  { bin: "jwm", args: [] },
  { bin: "fluxbox", args: [] },
  { bin: "xfwm4", args: ["--compositor=off", "--sm-client-disable"] },
];

const SYS_PATH = "/usr/local/bin:/usr/bin:/bin";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function which(bin: string): string | null {
  for (const dir of SYS_PATH.split(":")) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Minimal env for every desktop child: no secrets, only the dedicated display. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: SYS_PATH, DISPLAY: DESKTOP_DISPLAY, LANG: "C.UTF-8", ...extra };
}

function cmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch {
    return "";
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

async function waitPort(port: number, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const c = net.connect({ host: "127.0.0.1", port }, () => (c.destroy(), resolve(true)));
      c.on("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

export function run(bin: string, args: string[], opts: { input?: string | Buffer; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 10_000);
    const onAbort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size <= 16 * 1024 * 1024) out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on("error", (e) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: err });
    });
    child.stdin.end(opts.input ?? "");
  });
}

export type SessionDeps = {
  config: () => DesktopConfig;
  /** sable-data/desktop */
  dir: string;
  egress?: EgressDeps;
  log?: (msg: string) => void;
  extraChromeArgs?: string[];
};

export class DesktopSession {
  deps: SessionDeps;
  procs: Proc[] = [];
  proxy: EgressProxy | null = null;
  state: DesktopState = "stopped";
  startedAt: number | null = null;
  lastActivity = Date.now();
  wm: string | null = null;
  error: string | null = null;
  stoppedReason: string | null = null;
  vncPassword: string | null = null;
  starting: Promise<void> | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  get profileDir() {
    return path.join(this.deps.dir, "chrome-profile");
  }
  get pagesDir() {
    return path.join(this.deps.dir, "pages");
  }
  get pidFile() {
    return path.join(this.deps.dir, "pids.json");
  }

  touch() {
    this.lastActivity = Date.now();
  }

  status(): SessionStatus {
    const cfg = this.deps.config();
    return {
      state: this.state,
      display: DESKTOP_DISPLAY,
      width: cfg.width,
      height: cfg.height,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      wm: this.wm,
      error: this.error,
      stoppedReason: this.stoppedReason,
      blockedRequests: this.proxy?.blocked() ?? 0,
      pids: Object.fromEntries(this.procs.filter((p) => p.child.pid).map((p) => [p.name, p.child.pid as number])),
    };
  }

  private savePids() {
    const recs: PidRec[] = this.procs.filter((p) => p.child.pid).map((p) => ({ name: p.name, pid: p.child.pid as number, marker: p.marker }));
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.pidFile, JSON.stringify(recs), { mode: 0o600 });
  }

  /** Kill only processes this manager recorded earlier AND whose cmdline still carries our marker. */
  cleanupStale(): number {
    let recs: PidRec[] = [];
    try {
      recs = JSON.parse(fs.readFileSync(this.pidFile, "utf8"));
    } catch {
      return 0;
    }
    let n = 0;
    for (const r of Array.isArray(recs) ? recs : []) {
      if (typeof r?.pid !== "number" || typeof r.marker !== "string" || !r.marker) continue;
      if (this.procs.some((p) => p.child.pid === r.pid)) continue;
      if (alive(r.pid) && cmdline(r.pid).includes(r.marker)) {
        try {
          process.kill(r.pid, "SIGKILL");
          n += 1;
        } catch {
          /* gone */
        }
      }
    }
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    return n;
  }

  /** null when :99 is free (or only our own stale lock); otherwise why we refuse. */
  displayBusy(): string | null {
    const lock = `/tmp/.X${DESKTOP_DISPLAY_NUM}-lock`;
    if (!fs.existsSync(lock)) return null;
    const pid = Number(fs.readFileSync(lock, "utf8").trim());
    if (!Number.isFinite(pid) || !alive(pid)) return `stale ${lock} (pid ${pid} not running) — not removing a lock Sable did not create`;
    return `display ${DESKTOP_DISPLAY} is in use by another process (pid ${pid}); Sable never touches other displays`;
  }

  private spawnProc(name: string, bin: string, args: string[], marker: string, env = childEnv()) {
    const child = spawn(bin, args, { env, stdio: ["ignore", "ignore", "pipe"], detached: false });
    let tail = "";
    child.stderr?.on("data", (d: Buffer) => (tail = (tail + d.toString()).slice(-1500)));
    child.on("exit", (code, sig) => {
      const idx = this.procs.findIndex((p) => p.child === child);
      if (idx >= 0) this.procs.splice(idx, 1);
      if (this.state === "running" && (name === "xvfb" || name === "chrome")) {
        this.deps.log?.(`[sable-desktop] ${name} exited (${code ?? sig}); stopping session`);
        void this.stop(`${name} exited`);
      }
    });
    child.on("error", (e) => this.deps.log?.(`[sable-desktop] ${name} spawn error: ${e.message}`));
    const proc = { name, child, marker };
    this.procs.push(proc);
    (proc as Proc & { tail: () => string }).tail = () => tail;
    return proc;
  }

  async start(opts: { url?: string } = {}): Promise<void> {
    if (this.state === "running") return;
    if (this.starting) return this.starting;
    this.starting = this.doStart(opts).finally(() => (this.starting = null));
    return this.starting;
  }

  private async doStart(opts: { url?: string }) {
    const cfg = this.deps.config();
    if (!cfg.enabled) throw new Error("desktop is switched off (SABLE_DESKTOP=0)");
    for (const bin of ["Xvfb", "xdotool", "ffmpeg", "bwrap", "x11vnc", "websockify"]) if (!which(bin)) throw new Error(`missing ${bin}`);
    const chrome = ["/opt/google/chrome/chrome", "/usr/bin/google-chrome"].find((p) => fs.existsSync(p));
    if (!chrome) throw new Error("missing google-chrome");
    this.state = "starting";
    this.error = null;
    this.stoppedReason = null;
    try {
      this.cleanupStale();
      await sleep(200);
      const busy = this.displayBusy();
      if (busy) throw new Error(busy);
      for (const port of [cfg.vncPort, cfg.wsPort]) if (!(await portFree(port))) throw new Error(`127.0.0.1:${port} is already in use`);
      fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.pagesDir, { recursive: true, mode: 0o700 });

      this.spawnProc("xvfb", which("Xvfb")!, [DESKTOP_DISPLAY, "-screen", "0", `${cfg.width}x${cfg.height}x24`, "-nolisten", "tcp", "-nolisten", "unix", "-noreset"], `Xvfb ${DESKTOP_DISPLAY}`);
      this.savePids();
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) {
        await sleep(150);
        ready = (await run(which("xdotool")!, ["getdisplaygeometry"], { timeoutMs: 2000 }).catch(() => ({ code: 1 }))).code === 0;
      }
      if (!ready) throw new Error("Xvfb :99 did not come up");

      const wm = cfg.wm ? WMS.find((w) => which(w.bin)) : undefined;
      if (wm) {
        this.spawnProc("wm", which(wm.bin)!, wm.bin === "xfwm4" ? [`--display=${DESKTOP_DISPLAY}`, ...wm.args] : wm.args, wm.bin);
        this.wm = wm.bin;
      } else this.wm = null;

      this.proxy = await startEgressProxy({
        ...this.deps.egress,
        onBlock: (target, reason) => this.deps.log?.(`[sable-desktop] egress blocked: ${target.split("?")[0]} (${reason})`),
      });
      const start = opts.url && /^(https?:\/\/|file:\/\/\/pages\/)/.test(opts.url) ? opts.url : "about:blank";
      const jail = [
        // Not --unshare-all: Chrome paints via MIT-SHM, so the IPC namespace is shared with Xvfb.
        "--unshare-user-try", "--unshare-pid", "--unshare-uts", "--unshare-cgroup-try", "--die-with-parent", "--new-session", "--clearenv",
        "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp",
        "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin",
        "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
        "--ro-bind", "/opt/google", "/opt/google",
        "--ro-bind-try", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/etc/ssl", "/etc/ssl",
        "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates", "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
        "--ro-bind-try", "/etc/hosts", "/etc/hosts", "--ro-bind-try", "/etc/localtime", "/etc/localtime",
        "--ro-bind-try", "/etc/passwd", "/etc/passwd", "--ro-bind-try", "/etc/group", "/etc/group",
        "--bind", this.profileDir, "/profile", "--ro-bind", this.pagesDir, "/pages",
        "--setenv", "HOME", "/profile", "--setenv", "DISPLAY", DESKTOP_DISPLAY, "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
        "--", chrome,
      ];
      const chromeArgs = [
        "--no-sandbox", // the bwrap jail above is the sandbox boundary
        "--user-data-dir=/profile", "--no-first-run", "--no-default-browser-check", "--disable-sync", "--hide-crash-restore-bubble", "--disable-session-crashed-bubble", "--noerrdialogs",
        "--disable-gpu", "--disable-dev-shm-usage", "--password-store=basic", "--renderer-process-limit=3",
        "--disable-features=Translate,MediaRouter,OptimizationHints", "--disable-background-networking",
        `--window-position=0,0`, `--window-size=${cfg.width},${cfg.height}`,
        `--proxy-server=http://127.0.0.1:${this.proxy.port}`, "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--sable-desktop-chrome",
        ...(this.deps.extraChromeArgs ?? []),
        start,
      ];
      this.spawnProc("chrome", which("bwrap")!, [...jail, ...chromeArgs], "--sable-desktop-chrome");

      this.vncPassword = crypto.randomBytes(12).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 8).padEnd(8, "x");
      const pwFile = path.join(this.deps.dir, `vncpw-${crypto.randomBytes(6).toString("hex")}`);
      fs.writeFileSync(pwFile, `${this.vncPassword}\n`, { mode: 0o600 });
      this.spawnProc("x11vnc", which("x11vnc")!, ["-display", DESKTOP_DISPLAY, "-localhost", "-no6", "-rfbport", String(cfg.vncPort), "-passwdfile", `rm:${pwFile}`, "-forever", "-shared", "-noxdamage", "-quiet", "-nossl"], `x11vnc -display ${DESKTOP_DISPLAY}`);
      this.spawnProc("websockify", which("websockify")!, [`127.0.0.1:${cfg.wsPort}`, `127.0.0.1:${cfg.vncPort}`], `127.0.0.1:${cfg.wsPort}`);
      this.savePids();
      if (!(await waitPort(cfg.vncPort, 8000))) throw new Error("x11vnc did not start");
      if (!(await waitPort(cfg.wsPort, 8000))) throw new Error("websockify did not start");
      try {
        fs.rmSync(pwFile, { force: true });
      } catch {
        /* x11vnc already removed it */
      }
      this.state = "running";
      this.startedAt = Date.now();
      this.touch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stop("start failed");
      this.state = "error";
      this.error = message;
      throw error;
    }
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    const procs = [...this.procs].reverse();
    for (const p of procs) p.child.kill("SIGTERM");
    const deadline = Date.now() + 2500;
    while (this.procs.length && Date.now() < deadline) await sleep(100);
    for (const p of [...this.procs]) p.child.kill("SIGKILL");
    this.procs = [];
    await this.proxy?.close().catch(() => {});
    this.proxy = null;
    this.vncPassword = null;
    try {
      fs.rmSync(this.pidFile, { force: true });
    } catch {
      /* ignore */
    }
    this.state = "stopped";
    this.startedAt = null;
    this.stoppedReason = reason;
  }

  /** JPEG of the whole :99 screen. */
  async screenshot(signal?: AbortSignal): Promise<Buffer> {
    if (this.state !== "running") throw new Error("desktop is not running");
    const cfg = this.deps.config();
    const r = await run(which("ffmpeg")!, ["-loglevel", "error", "-f", "x11grab", "-video_size", `${cfg.width}x${cfg.height}`, "-i", DESKTOP_DISPLAY, "-frames:v", "1", "-q:v", "5", "-f", "image2", "-c:v", "mjpeg", "pipe:1"], { timeoutMs: 10_000, signal });
    if (r.code !== 0 || r.stdout.length < 100) throw new Error(`screenshot failed: ${r.stderr.slice(0, 200)}`);
    this.touch();
    return r.stdout;
  }

  /** Runs one xdotool invocation against :99 (argv only — never a shell). */
  async xdotool(args: string[], input?: string, signal?: AbortSignal) {
    if (this.state !== "running") throw new Error("desktop is not running");
    const r = await run(which("xdotool")!, args, { input, timeoutMs: 30_000, signal });
    this.touch();
    if (r.code !== 0) throw new Error(`xdotool failed (${r.code})`);
    return r.stdout.toString();
  }

  async activeWindowTitle(): Promise<string> {
    try {
      return (await this.xdotool(["getactivewindow", "getwindowname"])).trim();
    } catch {
      return "";
    }
  }
}

/**
 * Bubblewrap (bwrap) launcher for the shell_run tool.
 *
 * Design (OpenClaw sandbox docs / bwrap PR notes, MIT — reimplemented fresh for Sable):
 *  - New namespaces (--unshare-all); network off unless the call opts in (--share-net).
 *  - Only the workspace is writable; /usr /bin /lib(64) are read-only.
 *  - Secrets dirs (.env files, sable-data, home) are never mounted.
 *  - Cleared env; PATH/HOME/LANG only. --die-with-parent.
 * Falls back to a restricted spawn (cwd=workspace, stripped env, no new namespaces)
 * when bwrap is missing — still behind the approval gate.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const MAX_CMD = 4_000;
export const MAX_OUTPUT = 32_000;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const HARD_TIMEOUT_MS = 120_000;

export type SandboxResult = {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  network: boolean;
  via: "bwrap" | "fallback";
};

export type SandboxOpts = {
  workspace: string;
  command: string;
  timeoutMs?: number;
  network?: boolean;
  signal?: AbortSignal;
  /** Injected for tests. */
  bwrapPath?: string | null;
  spawnImpl?: typeof spawn;
};

let bwrapCached: string | null | undefined;
export function findBwrap(override?: string | null): string | null {
  if (override !== undefined) return override;
  if (bwrapCached !== undefined) return bwrapCached;
  for (const p of ["/usr/bin/bwrap", "/bin/bwrap"]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return (bwrapCached = p);
    } catch {
      /* try next */
    }
  }
  return (bwrapCached = null);
}

/** Reset the cached lookup (tests). */
export function resetBwrapCache() {
  bwrapCached = undefined;
}

export function cleanCommand(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Thiếu lệnh." };
  if (raw.includes("\0")) return { ok: false, error: "Lệnh chứa ký tự null." };
  const cmd = raw.trim();
  if (!cmd) return { ok: false, error: "Lệnh trống." };
  if (cmd.length > MAX_CMD) return { ok: false, error: `Lệnh quá dài (tối đa ${MAX_CMD} ký tự).` };
  return { ok: true, value: cmd };
}

function bwrapArgs(workspace: string, network: boolean): string[] {
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/nsswitch.conf", "/etc/nsswitch.conf",
    "--ro-bind-try", "/etc/hosts", "/etc/hosts",
    "--ro-bind-try", "/etc/localtime", "/etc/localtime",
    "--bind", workspace, "/workspace",
    "--chdir", "/workspace",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin:/usr/sbin:/sbin",
    "--setenv", "HOME", "/workspace",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "SABLE_SHELL", "1",
    "--setenv", "TMPDIR", "/tmp",
  ];
  if (network) args.splice(1, 0, "--share-net"); // after --unshare-all
  return args;
}

function fallbackEnv(workspace: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: workspace,
    LANG: "C.UTF-8",
    SABLE_SHELL: "1",
    TMPDIR: workspace,
  };
}

/**
 * Run `command` via /bin/sh -c inside the sandbox. Captures stdout+stderr, caps
 * output, kills the process tree on timeout/abort.
 */
export function runSandboxed(opts: SandboxOpts): Promise<SandboxResult> {
  const cleaned = cleanCommand(opts.command);
  if (!cleaned.ok) return Promise.resolve({ ok: false, output: cleaned.error, exitCode: null, timedOut: false, truncated: false, network: false, via: "fallback" });
  const workspace = path.resolve(opts.workspace);
  const network = Boolean(opts.network);
  const timeoutMs = Math.min(HARD_TIMEOUT_MS, Math.max(1_000, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const bwrap = findBwrap(opts.bwrapPath);
  const spawnFn = opts.spawnImpl ?? spawn;

  const argv = bwrap
    ? [bwrap, ...bwrapArgs(workspace, network), "--", "/bin/sh", "-c", cleaned.value]
    : ["/bin/sh", "-c", cleaned.value];

  return new Promise((resolve) => {
    let stdout = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawnFn(argv[0]!, argv.slice(1), {
      cwd: bwrap ? undefined : workspace,
      env: bwrap ? {} : fallbackEnv(workspace),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const out = truncated ? `${stdout}\n…[cắt bớt]` : stdout;
      resolve({
        ok: exitCode === 0 && !timedOut,
        output: out || (timedOut ? `timed out after ${timeoutMs} ms` : `(không có output, exit ${exitCode})`),
        exitCode,
        timedOut,
        truncated,
        network,
        via: bwrap ? "bwrap" : "fallback",
      });
    };

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }
    };

    const onAbort = () => {
      timedOut = false;
      killTree();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) {
      killTree();
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const take = (chunk: Buffer) => {
      if (truncated) return;
      const next = stdout + chunk.toString("utf8");
      if (next.length > MAX_OUTPUT) {
        stdout = next.slice(0, MAX_OUTPUT);
        truncated = true;
      } else stdout = next;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (err) => {
      stdout = (stdout ? stdout + "\n" : "") + `spawn error: ${err.message}`;
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}

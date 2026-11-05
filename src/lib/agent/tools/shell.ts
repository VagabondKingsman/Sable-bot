/**
 * shell_run — run a shell command inside the workspace jail (bubblewrap when available).
 * Always needsApproval. Network is off unless the model sets network:true (shown in the
 * approval card). Kill switch: SABLE_SHELL=0 (tool not registered / flag off).
 */
import { cleanCommand, DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS, MAX_CMD, runSandboxed } from "./sandbox.ts";
import type { FunctionTool } from "./types.ts";

export function shellOn() {
  return (process.env.SABLE_SHELL ?? "1").trim() !== "0";
}

export const shellRun: FunctionTool<{ command: string; network?: boolean; timeoutSec?: number }> = {
  kind: "function",
  name: "shell_run",
  description:
    "Run a shell command inside Sable's workspace jail (cwd = the workspace). No access to .env, home secrets, or Sable's data dir. Network is OFF by default; set network=true only when the command needs the internet (shown on the approval card). Always requires the user's approval. Prefer fs_* tools for simple file reads/writes.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run (sh -c).", maxLength: MAX_CMD },
      network: { type: "boolean", description: "Allow network inside the sandbox (default false)." },
      timeoutSec: { type: "integer", description: "Timeout in seconds (1–120, default 30).", minimum: 1, maximum: 120 },
    },
    required: ["command"],
    additionalProperties: false,
  },
  risk: "write",
  needsApproval: true,
  timeoutMs: HARD_TIMEOUT_MS + 5_000,
  maxOutput: 40_000,
  label: (args) => `Shell · ${(args.command || "").slice(0, 60)}${(args.command || "").length > 60 ? "…" : ""}`,
  describe: (args) => ({
    tool: "shell_run",
    summary: `Chạy lệnh shell${args.network ? " (CÓ mạng)" : " (không mạng)"}: ${(args.command || "").slice(0, 120)}`,
    preview: args.command,
  }),
  check: async (args) => {
    const c = cleanCommand(args.command);
    return c.ok ? null : c.error;
  },
  async run(args, ctx) {
    const timeoutMs = Math.min(HARD_TIMEOUT_MS, Math.max(1_000, (args.timeoutSec ?? DEFAULT_TIMEOUT_MS / 1000) * 1000));
    const res = await runSandboxed({
      workspace: ctx.workspaceDir,
      command: args.command,
      network: Boolean(args.network),
      timeoutMs,
      signal: ctx.signal,
    });
    const head = [
      `via=${res.via}`,
      `network=${res.network ? "on" : "off"}`,
      res.exitCode !== null ? `exit=${res.exitCode}` : "exit=?",
      res.timedOut ? "timed_out" : null,
      res.truncated ? "truncated" : null,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      ok: res.ok,
      output: `${head}\n${res.output}`,
      detail: res.ok ? `exit ${res.exitCode}` : res.timedOut ? "timeout" : `exit ${res.exitCode ?? "?"}`,
    };
  },
};

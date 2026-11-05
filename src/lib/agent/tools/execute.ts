import { parseArgs } from "./validate.ts";
import type { FunctionTool, ToolContext, ToolResult } from "./types.ts";

function clipOut(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n…[cắt bớt ${text.length - max} ký tự]` : text;
}

/** Validate → approval gate → run with timeout → clip. Never throws. Side effects are audited (W2a). */
export async function execute(def: FunctionTool, raw: string, ctx: ToolContext): Promise<ToolResult> {
  const result = await executeInner(def, raw, ctx);
  if (def.risk !== "read" && ctx.audit && ctx.initiator) {
    try {
      let summary = def.name;
      try {
        const parsed = parseArgs(raw, def.parameters);
        if (parsed.ok) summary = def.label(parsed.value);
      } catch {
        /* keep tool name */
      }
      ctx.audit({ tool: def.name, risk: def.risk, summary, ok: result.ok, stepId: ctx.stepId, initiator: ctx.initiator, reason: result.ok ? undefined : result.output.slice(0, 200) });
    } catch {
      /* auditing must never break a tool call */
    }
  }
  return result;
}

async function executeInner(def: FunctionTool, raw: string, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseArgs(raw, def.parameters);
  if (!parsed.ok) return { ok: false, output: `invalid args: ${parsed.error}` };
  if (def.check) {
    try {
      const problem = await def.check(parsed.value, ctx);
      if (problem) return { ok: false, output: problem };
    } catch (error) {
      return { ok: false, output: `tool error: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}` };
    }
  }
  if (ctx.assertScope) {
    const needsGate =
      Boolean(def.requiresScope) ||
      Boolean(ctx.scopeId && (def.risk === "write" || def.risk === "network"));
    const scope = ctx.assertScope(def.name, needsGate);
    if (!scope.ok) {
      return { ok: false, output: `refused: scope gate — ${scope.reason}`, detail: "ScopeGate" };
    }
  }
  if (def.needsApproval) {

    // Interactive chat and background jobs both pass an approver that waits for the
    // user's click; nothing auto-approves. No approver → refuse.
    if (!ctx.approve) {
      return { ok: false, output: "refused: this tool needs the user's approval and no approver is available" };
    }
    const ask = def.describe ? def.describe(parsed.value) : { tool: def.name, summary: def.label(parsed.value) };
    let approved = false;
    try {
      approved = await ctx.approve(ask);
    } catch {
      approved = false;
    }
    if (!approved) return { ok: false, output: "the user rejected this action (or approval timed out); nothing was changed", detail: "Bị từ chối" };
    // Approved, but the run was cancelled in the meantime: the write must not happen.
    if (ctx.signal.aborted) return { ok: false, output: "cancelled before the approved action ran; nothing was changed", detail: "Đã hủy" };
  }
  if (ctx.signal.aborted) return { ok: false, output: "cancelled; nothing was run", detail: "Đã hủy" };
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(def.timeoutMs)]);
  try {
    const out = await withAbort(def.run(parsed.value, { ...ctx, signal }), signal);
    return { ...out, output: clipOut(out.output, def.maxOutput) };
  } catch (error) {
    const timedOut = signal.aborted && !ctx.signal.aborted;
    const message = timedOut ? `timed out after ${def.timeoutMs} ms` : error instanceof Error ? error.message : String(error);
    return { ok: false, output: `tool error: ${message.slice(0, 300)}` };
  }
}

function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

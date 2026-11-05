/**
 * Learned-memory tools. They only touch Sable's own memory file through
 * `ctx.memory` (no paths, no network, no recipients). Saving and forgetting
 * happen only in an interactive chat the user is in; background runs may recall.
 */
import type { FunctionTool, ToolContext } from "./types.ts";

function noMemory(ctx: ToolContext) {
  return ctx.memory ? null : "memory is off for this turn";
}

export const memoryRecall: FunctionTool<{ query: string; limit?: number }> = {
  kind: "function",
  name: "memory_recall",
  description: "Search what Sable has remembered about the user (preferences, projects, past events). Use when the user refers to something from an earlier conversation.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to look for", maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  risk: "read",
  timeoutMs: 5_000,
  maxOutput: 4_000,
  label: (args) => `memory_recall · ${String(args.query).slice(0, 40)}`,
  check: async (_args, ctx) => noMemory(ctx),
  async run(args, ctx) {
    const found = await ctx.memory!.recall(args.query, args.limit ?? 8);
    if (!found.length) return { ok: true, output: "No matching memories.", detail: "Không có" };
    return {
      ok: true,
      output: found.map((item) => `- [${item.kind}] ${item.text}${item.eventDate ? ` (${item.eventDate})` : ""}`).join("\n"),
      detail: `${found.length} mục`,
    };
  },
};

export const memorySave: FunctionTool<{ text: string; kind?: string; eventDate?: string }> = {
  kind: "function",
  name: "memory_save",
  description: "Remember one fact about the user for future chats. Only when the user asks you to remember something, or states a lasting preference/instruction. Never for passwords, keys, card numbers or other secrets.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "One short sentence, third person", maxLength: 300 },
      kind: { type: "string", enum: ["profile", "journal"], description: "profile = lasting fact/preference; journal = dated event" },
      eventDate: { type: "string", description: "YYYY-MM-DD for journal entries, if known", maxLength: 10 },
    },
    required: ["text"],
    additionalProperties: false,
  },
  risk: "memory",
  timeoutMs: 5_000,
  maxOutput: 600,
  label: (args) => `memory_save · ${String(args.text).slice(0, 40)}`,
  check: async (_args, ctx) => noMemory(ctx) ?? (ctx.memory!.canWrite && ctx.mode === "interactive" ? null : "memory_save is not available in this conversation"),
  async run(args, ctx) {
    const result = ctx.memory!.save(args.text, args.kind === "journal" ? "journal" : "profile", args.eventDate);
    if (result.status === "skipped") return { ok: false, output: "Not saved: empty, or it looked like a secret (secrets are never stored).", detail: "Không lưu" };
    return { ok: true, output: `${result.status === "merged" ? "Updated" : "Saved"}: ${result.text}`, detail: result.status === "merged" ? "Đã cập nhật" : "Đã nhớ" };
  },
};

export const memoryForget: FunctionTool<{ query: string }> = {
  kind: "function",
  name: "memory_forget",
  description: "Delete remembered facts that match the query, when the user asks you to forget something.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "What to forget (keywords or the fact)", maxLength: 200 } },
    required: ["query"],
    additionalProperties: false,
  },
  risk: "memory",
  timeoutMs: 5_000,
  maxOutput: 2_000,
  label: (args) => `memory_forget · ${String(args.query).slice(0, 40)}`,
  check: async (_args, ctx) => noMemory(ctx) ?? (ctx.memory!.canWrite && ctx.mode === "interactive" ? null : "memory_forget is not available in this conversation"),
  async run(args, ctx) {
    const removed = ctx.memory!.forget(args.query);
    if (!removed.length) return { ok: true, output: "Nothing matched; nothing was deleted.", detail: "Không có gì để quên" };
    return { ok: true, output: `Forgot ${removed.length}:\n${removed.map((text) => `- ${text}`).join("\n")}`, detail: `Đã quên ${removed.length}` };
  },
};

export const MEMORY_TOOLS = [memoryRecall, memorySave, memoryForget];

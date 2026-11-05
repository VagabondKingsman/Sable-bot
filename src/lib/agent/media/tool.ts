/**
 * W2c: `media_image` agent tool — the agent can generate an image through the
 * existing media module, but only after the owner approves a card that shows
 * the estimated cost and the media spend vs. cap. Never offered to routines
 * (dropped by forSource + mediaToolsFor). Kill switches: SABLE_MEDIA=0 or
 * SABLE_MEDIA_TOOL=0.
 */
import type { FunctionTool, ToolResult } from "../tools/types.ts";

export const MEDIA_TOOL_ASPECTS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;
const MAX_PROMPT = 2_000;

export function mediaToolOn(env: NodeJS.ProcessEnv = process.env) {
  return env.SABLE_MEDIA !== "0" && env.SABLE_MEDIA_TOOL !== "0";
}

export type MediaQuote = { usd: number; spentUsd: number; capUsd: number | null; budgetOk: boolean; reason?: string };

export type MediaToolDeps = {
  /** Cost estimate + whether the global/media budget allows one more image. */
  quote(): MediaQuote;
  generate(prompt: string, aspect: string, signal: AbortSignal): Promise<{ ok: true; id: string; model?: string } | { ok: false; message: string }>;
  fileUrl(id: string): string;
};

type Args = { prompt?: unknown; aspect?: unknown };

const clean = (args: Args) => ({
  prompt: typeof args.prompt === "string" ? args.prompt.trim().slice(0, MAX_PROMPT) : "",
  aspect: MEDIA_TOOL_ASPECTS.find((a) => a === args.aspect) ?? "1:1",
});

const money = (n: number) => `$${n.toFixed(2)}`;

function refusal(q: MediaQuote): string | null {
  if (!q.budgetOk) return q.reason ?? "Vượt ngân sách.";
  if (q.capUsd !== null && q.spentUsd + q.usd > q.capUsd)
    return `Vượt trần media: đã dùng ${money(q.spentUsd)} + ${money(q.usd)} > ${money(q.capUsd)} (SABLE_MEDIA_MAX_USD).`;
  return null;
}

export function mediaImageTool(deps: MediaToolDeps): FunctionTool<Args> {
  return {
    kind: "function",
    name: "media_image",
    description:
      "Generate ONE image from a text prompt and save it to the owner's media library. Costs money: the owner must approve each call. Use only when the owner asked for an image.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "What the image should show (max 2000 chars)." },
        aspect: { type: "string", enum: [...MEDIA_TOOL_ASPECTS], description: "Aspect ratio, default 1:1." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    risk: "write",
    needsApproval: true,
    timeoutMs: 180_000,
    maxOutput: 2_000,
    label: (args) => `media_image · ${clean(args).prompt.slice(0, 48)}`,
    describe(args) {
      const { prompt, aspect } = clean(args);
      const q = deps.quote();
      const cap = q.capUsd === null ? "không đặt trần" : `trần ${money(q.capUsd)}`;
      return {
        tool: "media_image",
        summary: `Tạo 1 ảnh (${aspect}) · ước tính ${money(q.usd)} · media đã dùng ${money(q.spentUsd)} (${cap})`,
        preview: prompt,
      };
    },
    async check(args) {
      const { prompt } = clean(args);
      if (!prompt) return "Thiếu prompt.";
      return refusal(deps.quote());
    },
    async run(args, ctx): Promise<ToolResult> {
      const { prompt, aspect } = clean(args);
      if (!prompt) return { ok: false, output: "Thiếu prompt." };
      const why = refusal(deps.quote());
      if (why) return { ok: false, output: why };
      const out = await deps.generate(prompt, aspect, ctx.signal);
      if (!out.ok) return { ok: false, output: `Không tạo được ảnh: ${out.message}` };
      const url = deps.fileUrl(out.id);
      return { ok: true, output: `Đã tạo ảnh (id ${out.id}). Hiển thị cho chủ: ![ảnh](${url})`, detail: `${aspect}${out.model ? ` · ${out.model}` : ""}` };
    },
  };
}

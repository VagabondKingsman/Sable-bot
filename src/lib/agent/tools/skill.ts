/** load_skill: read one skill's instructions into this turn (never grants tools). */
import type { FunctionTool } from "./types.ts";

export const loadSkill: FunctionTool<{ name: string }> = {
  kind: "function",
  name: "load_skill",
  description: "Load the full instructions of one skill from the Skills list, then follow them for this task. Skills do not enable any tool.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Skill name from the Skills list.", maxLength: 48 } },
    required: ["name"],
    additionalProperties: false,
  },
  risk: "read",
  timeoutMs: 5_000,
  maxOutput: 9_000,
  label: (a) => `load_skill · ${String(a.name ?? "")}`,
  async run(args, ctx) {
    if (!ctx.skills) return { ok: false, output: "refused: skills are off (SABLE_SKILLS=0)" };
    const text = ctx.skills.load(String(args.name ?? ""));
    if (!text) return { ok: false, output: `unknown skill: ${String(args.name).slice(0, 48)}. Available: ${ctx.skills.names().join(", ") || "(none)"}` };
    return { ok: true, output: text, detail: "đã nạp skill" };
  },
};

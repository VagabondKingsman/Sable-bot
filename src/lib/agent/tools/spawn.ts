/**
 * spawn_agent: hand one self-contained task to a sub-agent. The sub-agent runs
 * the same loop with a narrower tool set (profile ∩ what this turn allows),
 * cannot spawn again (depth 1), has its own step/time budget, and its writes
 * still go through the user's approval. Its trace shows nested under this step.
 */
import type { FunctionTool, SpawnProfile } from "./types.ts";

export const SPAWN_PROFILES: Record<SpawnProfile, { tools: readonly string[]; brief: string }> = {
  research: {
    tools: ["web_search", "x_search", "http_fetch", "fs_list", "fs_read", "memory_recall"],
    brief: "Research: find and read sources, then report findings with links. Never write files.",
  },
  writer: {
    tools: ["fs_list", "fs_read", "fs_write", "memory_recall"],
    brief: "Writer: draft or edit text, and save it to the workspace when the task asks (writes need the user's approval).",
  },
  coder: {
    tools: ["fs_list", "fs_read", "fs_write", "http_fetch", "code_interpreter"],
    brief: "Coder: read and change code/files in the workspace (writes need the user's approval); explain what changed.",
  },
};

type SpawnArgs = { task: string; profile: SpawnProfile; context?: string };

export const spawnAgent: FunctionTool<SpawnArgs> = {
  kind: "function",
  name: "spawn_agent",
  description:
    "Delegate one self-contained sub-task to a focused sub-agent and get its final report back. Profiles: research / writer / coder builtins, or a custom profile id (Settings → Profiles). The sub-agent sees only `task` and `context` (not this chat), cannot ask questions, cannot spawn more agents, and its file writes still need the user's approval. Use it for parallelisable or long side-tasks; do simple things yourself.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "Complete instructions for the sub-agent, including the expected output.", maxLength: 8000 },
      profile: { type: "string", description: "Builtin research|writer|coder, or a custom multi-agent profile id from Settings → Profiles." },
      context: { type: "string", description: "Optional facts/data from this chat the sub-agent needs.", maxLength: 8000 },
    },
    required: ["task", "profile"],
    additionalProperties: false,
  },
  risk: "agent",
  // The child enforces its own (shorter) budget; this is only a hard backstop.
  timeoutMs: 660_000,
  maxOutput: 14_000,
  label: (args) => `spawn_agent · ${args.profile ?? "?"}: ${String(args.task ?? "").replace(/\s+/g, " ").slice(0, 60)}`,
  async run(args, ctx) {
    if (!ctx.spawn) return { ok: false, output: "refused: sub-agents are not available here (sub-agents cannot spawn further agents, or SABLE_SPAWN=0)" };
    return ctx.spawn({ task: args.task, profile: args.profile, context: args.context }, ctx);
  },
};

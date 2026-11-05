import type { FunctionTool } from "../tools/types.ts";

/** Routine/trigger runs never get connector tools that need approval (same rule as MCP). */
export function forSource(tools: FunctionTool[], source: string): FunctionTool[] {
  return source === "routine" ? tools.filter((t) => !t.needsApproval) : tools;
}

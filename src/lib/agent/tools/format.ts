/** Render registry tools to each provider's wire format. Pure. */
import type { FunctionTool, ToolDef, ToolResult } from "./types.ts";

export type ResponsesTool =
  | { type: string }
  | { type: "function"; name: string; description: string; parameters: FunctionTool["parameters"] };

export type ChatTool = {
  type: "function";
  function: { name: string; description: string; parameters: FunctionTool["parameters"] };
};

/** xAI /v1/responses: server tools as `{type}`, function tools flat. */
export function toResponsesTools(defs: ToolDef[]): ResponsesTool[] {
  return defs.map((def) =>
    def.kind === "server"
      ? { type: def.responsesType }
      : { type: "function" as const, name: def.name, description: def.description, parameters: def.parameters },
  );
}

/** OpenAI / DeepSeek /v1/chat/completions: function tools only (no server tools exist there). */
export function toChatTools(defs: ToolDef[]): ChatTool[] {
  return defs
    .filter((def): def is FunctionTool => def.kind === "function")
    .map((def) => ({ type: "function" as const, function: { name: def.name, description: def.description, parameters: def.parameters } }));
}

/** Text the model sees back for one call. */
export function resultText(result: ToolResult) {
  return result.ok ? result.output : `ERROR: ${result.output}`;
}

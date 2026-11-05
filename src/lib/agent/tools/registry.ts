/**
 * The one list of tools Sable knows. Static (never loaded from the client):
 * the client only sends ToolFlags; the server intersects them with what the
 * provider can run.
 */
import type { ToolFlags } from "../types.ts";
import { createHttpFetch } from "./fetch.ts";
import { fsList, fsRead, fsWrite } from "./fs.ts";
import { MEMORY_TOOLS } from "./memory.ts";
import { knowledgeRecall } from "./knowledge.ts";
import { spawnAgent } from "./spawn.ts";
import { loadSkill } from "./skill.ts";
import { shellRun } from "./shell.ts";
import { browserTool } from "./browser.ts";
import { canvasWrite } from "./canvas.ts";
import { SERVER_TOOLS } from "./server-tools.ts";
import type { FunctionTool, ToolDef } from "./types.ts";

export { SERVER_TOOLS };

const NAME = /^[a-z][a-z0-9_]{1,48}$/;

/** Which ToolFlags switch turns a tool on. */
export const FLAG_OF: Record<string, keyof ToolFlags> = {
  web_search: "web",
  x_search: "x",
  code_interpreter: "code",
  image_generation: "image",
  fs_list: "files",
  fs_read: "files",
  fs_write: "files",
  http_fetch: "fetch",
  memory_recall: "learned",
  memory_save: "learned",
  memory_forget: "learned",
  knowledge_recall: "learned",
  spawn_agent: "agents",
  load_skill: "skills",
  shell_run: "shell",
  browser: "browser",
  canvas_write: "canvas",
};

export type Registry = {
  get(name: string): ToolDef | undefined;
  list(): ToolDef[];
};

export function createRegistry(defs: ToolDef[]): Registry {
  const map = new Map<string, ToolDef>();
  for (const def of defs) {
    if (!NAME.test(def.name)) throw new Error(`bad tool name: ${def.name}`);
    if (map.has(def.name)) throw new Error(`duplicate tool: ${def.name}`);
    if (def.kind === "function") {
      if (def.parameters.type !== "object") throw new Error(`${def.name}: parameters must be an object schema`);
      if (def.risk === "write" && !def.needsApproval) throw new Error(`${def.name}: write tools must need approval`);
    }
    map.set(def.name, def);
  }
  return { get: (name) => map.get(name), list: () => [...map.values()] };
}

export function builtinTools(): ToolDef[] {
  return [...SERVER_TOOLS, fsList, fsRead, fsWrite, createHttpFetch(), ...MEMORY_TOOLS, knowledgeRecall, spawnAgent, loadSkill, shellRun, browserTool, canvasWrite];
}

let shared: Registry | null = null;
export function defaultRegistry(): Registry {
  shared ??= createRegistry(builtinTools());
  return shared;
}

export type Capabilities = {
  /** xAI server-side tools (Responses API on an xAI host). */
  serverTools: boolean;
  /** Sable-run function tools (function calling). */
  functionTools: boolean;
};

export type Selection = {
  active: ToolDef[];
  functions: FunctionTool[];
  /** Tool names the user enabled that this provider cannot run. */
  skipped: string[];
};

export function selectTools(registry: Registry, flags: ToolFlags, caps: Capabilities): Selection {
  const active: ToolDef[] = [];
  const skipped: string[] = [];
  for (const def of registry.list()) {
    const flag = FLAG_OF[def.name];
    if (!flag || !flags[flag]) continue;
    const ok = def.kind === "server" ? caps.serverTools : caps.functionTools;
    if (ok) active.push(def);
    else if (!skipped.includes(def.name)) skipped.push(def.name);
  }
  return { active, functions: active.filter((def): def is FunctionTool => def.kind === "function"), skipped };
}

/**
 * Notices for tools the user enabled but this turn cannot use. Function tools are only
 * ever skipped by the SABLE_TOOLS=0 kill switch; server tools by a non-xAI provider.
 */
export function skipNotices(selection: Selection, who: string, functionToolsOn: boolean): string[] {
  const out: string[] = [];
  const killed = functionToolsOn ? [] : selection.skipped.filter((name) => FLAG_OF[name] === "files" || FLAG_OF[name] === "fetch" || FLAG_OF[name] === "learned" || FLAG_OF[name] === "agents" || FLAG_OF[name] === "skills" || FLAG_OF[name] === "shell" || FLAG_OF[name] === "browser");
  const rest = selection.skipped.filter((name) => !killed.includes(name));
  if (killed.length) out.push(`Công cụ ${killed.join(", ")} đang tắt trên máy chủ (SABLE_TOOLS=0). Lượt này trả lời không dùng các công cụ đó.`);
  if (rest.length) {
    out.push(
      `${who} không chạy được ${rest.join(", ")} — các công cụ này cần endpoint Responses của xAI.` +
        (selection.functions.length ? ` Lượt này dùng ${selection.functions.map((tool) => tool.name).join(", ")}.` : " Lượt này trả lời không dùng các công cụ đó."),
    );
  }
  return out;
}

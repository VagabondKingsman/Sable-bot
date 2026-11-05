import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { createMcpManager, type McpManager } from "@/lib/agent/mcp/client";
import { cleanServer, mergeConfig, parseFileConfig, type FileConfig } from "@/lib/agent/mcp/config";
import type { FunctionTool } from "@/lib/agent/tools/types";
import { dataDir } from "@/server/paths";

/** SABLE_MCP=0 is the kill switch: no MCP connections, no mcp__ tools. */
export function mcpOn() {
  return (process.env.SABLE_MCP ?? "1").trim() !== "0";
}

const file = () => path.join(dataDir(), "mcp-servers.json");

export function readMcpFile(): FileConfig {
  try {
    return parseFileConfig(fs.readFileSync(file(), "utf8"));
  } catch {
    return { servers: [], disabled: [] };
  }
}

function writeMcpFile(cfg: FileConfig) {
  fs.mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeAtomic(file(), JSON.stringify(cfg, null, 2));
}

export function mcpConfig() {
  return mergeConfig(process.env.MCP_SERVERS, readMcpFile());
}

const g = globalThis as { __sableMcp?: McpManager };
export function mcpManager(): McpManager {
  g.__sableMcp ??= createMcpManager(() => (mcpOn() ? mcpConfig().servers : []), {
    env: process.env,
    fakeIpEgress: process.env.SABLE_FETCH_FAKE_IP === "1",
  });
  return g.__sableMcp;
}

/** Await (≤4 s) a cache refresh before preparing a turn; cached tools are used either way. */
export async function mcpWarm() {
  if (!mcpOn()) return;
  await mcpManager().refresh(false, 4_000);
}

/** MCP tools for one turn. Routine runs never get data-changing MCP tools. */
export function mcpToolsFor(source: string): FunctionTool[] {
  if (!mcpOn()) return [];
  const defs = mcpManager().toolDefs();
  return source === "routine" ? defs.filter((d) => !d.needsApproval) : defs;
}

/** UI edits: only file-config servers can be saved/deleted; any server can be toggled. */
export function saveFileServer(input: unknown): string | null {
  const clean = cleanServer(input, "file");
  if (typeof clean === "string") return clean;
  const env = mergeConfig(process.env.MCP_SERVERS, null).servers;
  if (env.some((s) => s.name === clean.name)) return `${clean.name} được khai báo trong MCP_SERVERS (chỉ sửa được qua env)`;
  const cur = readMcpFile();
  const { source: _s, allowLocal: _l, ...stored } = clean;
  const servers = cur.servers.filter((s) => (s as { name?: string }).name !== clean.name);
  if (servers.length >= 12) return "tối đa 12 máy chủ MCP";
  writeMcpFile({ ...cur, servers: [...servers, { ...stored, timeoutS: clean.timeoutMs / 1000 } as never] });
  return null;
}

export function deleteFileServer(name: string): boolean {
  const cur = readMcpFile();
  const servers = cur.servers.filter((s) => (s as { name?: string }).name !== name);
  if (servers.length === cur.servers.length) return false;
  writeMcpFile({ servers, disabled: cur.disabled.filter((n) => n !== name) });
  return true;
}

export function toggleServer(name: string, enabled: boolean): boolean {
  if (!mcpConfig().servers.some((s) => s.name === name)) return false;
  const cur = readMcpFile();
  const disabled = new Set(cur.disabled);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeMcpFile({ ...cur, disabled: [...disabled] });
  return true;
}

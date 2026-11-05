/**
 * MCP client manager: one SDK Client per enabled server, `tools/list` cached 5 min,
 * every MCP tool mapped to a FunctionTool `mcp__<server>__<tool>`.
 * Risk: write (needs approval) unless the server annotates readOnlyHint=true.
 * Results are wrapped as untrusted data and clipped; calls have timeouts.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FunctionTool, ToolResult } from "../tools/types.ts";
import { cleanSchema, MAX_TOOLS_PER_SERVER, mcpToolName, untrusted, type McpServerConfig } from "./config.ts";
import { checkMcpUrl, mcpFetch } from "./net.ts";

export const MCP_TTL_MS = 5 * 60_000;
const CONNECT_MS = 10_000;
const MAX_RESULT_TEXT = 10_000;

export type McpToolInfo = { name: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean } };
export type ServerStatus = {
  name: string;
  source: "env" | "file";
  url: string;
  enabled: boolean;
  state: "off" | "ok" | "error" | "idle";
  transport?: "http" | "sse";
  error?: string;
  tools: { name: string; mcpName: string; readOnly: boolean }[];
  fetchedAt?: number;
  headers: { header: string; env: string; set: boolean }[];
  allowTools: string[];
  allowLocal: boolean;
  timeoutS: number;
};

type State = { cfg: McpServerConfig; key: string; client?: Client; transport?: "http" | "sse"; infos: McpToolInfo[]; fetchedAt: number; error?: string };

export type ManagerDeps = { env: Record<string, string | undefined>; fakeIpEgress?: boolean; ttlMs?: number };

const keyOf = (c: McpServerConfig) => JSON.stringify([c.url, c.transport, c.headers, c.allowLocal, c.timeoutMs]);

function headerValues(cfg: McpServerConfig, env: ManagerDeps["env"]) {
  const out: Record<string, string> = {};
  for (const [h, ref] of Object.entries(cfg.headers)) {
    const v = env[ref];
    if (!v) throw new Error(`biến môi trường ${ref} chưa đặt`);
    out[h] = v;
  }
  return out;
}

function safeMessage(e: unknown, env: ManagerDeps["env"], cfg: McpServerConfig) {
  let m = e instanceof Error ? e.message : String(e);
  for (const ref of Object.values(cfg.headers)) {
    const v = env[ref];
    if (v && v.length >= 4) m = m.split(v).join("[ẩn]");
  }
  return m.replace(/\s+/g, " ").slice(0, 240);
}

async function connect(cfg: McpServerConfig, deps: ManagerDeps): Promise<{ client: Client; transport: "http" | "sse" }> {
  const url = checkMcpUrl(cfg.url, cfg.allowLocal);
  const headers = headerValues(cfg, deps.env);
  const fetchImpl = mcpFetch(cfg.allowLocal, deps.fakeIpEgress);
  const tryOne = async (kind: "http" | "sse") => {
    const client = new Client({ name: "sable", version: "1.0.0" });
    const transport =
      kind === "http"
        ? new StreamableHTTPClientTransport(url, { requestInit: { headers }, fetch: fetchImpl })
        : new SSEClientTransport(url, { requestInit: { headers }, eventSourceInit: { fetch: (u, i) => fetchImpl(u, { ...i, headers: { ...headers, ...(i?.headers as Record<string, string>) } }) }, fetch: fetchImpl });
    const timer = AbortSignal.timeout(CONNECT_MS);
    await Promise.race([
      client.connect(transport, { signal: timer, timeout: CONNECT_MS }),
      new Promise((_, reject) => timer.addEventListener("abort", () => reject(new Error("kết nối MCP quá 10 s")), { once: true })),
    ]).catch(async (e) => {
      await client.close().catch(() => undefined);
      throw e;
    });
    return { client, transport: kind };
  };
  if (cfg.transport === "http") return tryOne("http");
  if (cfg.transport === "sse") return tryOne("sse");
  try {
    return await tryOne("http");
  } catch (first) {
    try {
      return await tryOne("sse");
    } catch {
      throw first;
    }
  }
}

function textOf(result: unknown): { text: string; isError: boolean } {
  const r = (result ?? {}) as { content?: unknown[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };
  const parts: string[] = [];
  for (const item of Array.isArray(r.content) ? r.content : []) {
    const c = item as { type?: string; text?: string; resource?: { text?: string; uri?: string }; mimeType?: string };
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "resource" && c.resource) parts.push(typeof c.resource.text === "string" ? c.resource.text : `[resource ${String(c.resource.uri ?? "").slice(0, 200)}]`);
    else if (c.type === "resource_link") parts.push(`[link ${String((c as { uri?: string }).uri ?? "").slice(0, 200)}]`);
    else parts.push(`[${c.type ?? "content"} ${c.mimeType ?? ""} omitted]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  if (!parts.length && r.toolResult !== undefined) parts.push(JSON.stringify(r.toolResult));
  return { text: parts.join("\n"), isError: r.isError === true };
}

export function createMcpManager(getServers: () => McpServerConfig[], deps: ManagerDeps) {
  const ttl = deps.ttlMs ?? MCP_TTL_MS;
  const states = new Map<string, State>();
  let inflight: Promise<void> | null = null;

  function sync() {
    const cfgs = getServers();
    const names = new Set(cfgs.map((c) => c.name));
    for (const [name, st] of states) {
      if (!names.has(name) || !cfgs.find((c) => c.name === name)!.enabled || keyOf(cfgs.find((c) => c.name === name)!) !== st.key) {
        void st.client?.close().catch(() => undefined);
        states.delete(name);
      }
    }
    for (const cfg of cfgs) {
      const st = states.get(cfg.name);
      if (st) st.cfg = cfg;
      else if (cfg.enabled) states.set(cfg.name, { cfg, key: keyOf(cfg), infos: [], fetchedAt: 0 });
    }
    return cfgs;
  }

  async function refreshOne(st: State) {
    try {
      if (!st.client) {
        const c = await connect(st.cfg, deps);
        st.client = c.client;
        st.transport = c.transport;
      }
      const listed = await st.client.listTools(undefined, { timeout: CONNECT_MS });
      st.infos = (listed.tools as McpToolInfo[]).slice(0, 200);
      st.error = undefined;
    } catch (e) {
      st.error = safeMessage(e, deps.env, st.cfg);
      void st.client?.close().catch(() => undefined);
      st.client = undefined;
      st.infos = [];
    }
    st.fetchedAt = Date.now();
  }

  /** Connect + list stale servers (5-min cache). Never throws. */
  async function refresh(force = false, waitMs = 12_000) {
    sync();
    const stale = [...states.values()].filter((st) => force || Date.now() - st.fetchedAt > (st.error ? Math.min(ttl, 60_000) : ttl));
    if (!stale.length) return;
    inflight ??= Promise.all(stale.map(refreshOne)).then(() => undefined).finally(() => (inflight = null));
    await Promise.race([inflight, new Promise((r) => setTimeout(r, waitMs))]);
  }

  function allowed(st: State) {
    const allow = st.cfg.allowTools;
    return st.infos.filter((t) => !allow.length || allow.includes(t.name)).slice(0, MAX_TOOLS_PER_SERVER);
  }

  function toolDefs(): FunctionTool[] {
    sync();
    const taken = new Set<string>();
    const out: FunctionTool[] = [];
    for (const st of states.values()) {
      if (!st.cfg.enabled || st.error) continue;
      for (const info of allowed(st)) {
        const readOnly = info.annotations?.readOnlyHint === true;
        const server = st.cfg.name;
        const mcpName = info.name;
        const name = mcpToolName(server, mcpName, taken);
        const timeoutMs = st.cfg.timeoutMs;
        const def: FunctionTool = {
          kind: "function",
          name,
          description: `[MCP ${server}] ${String(info.description ?? mcpName).replace(/\s+/g, " ").slice(0, 500)}`,
          parameters: cleanSchema(info.inputSchema) as FunctionTool["parameters"],
          risk: readOnly ? "network" : "write",
          needsApproval: !readOnly,
          timeoutMs: timeoutMs + 2_000,
          maxOutput: MAX_RESULT_TEXT + 600,
          label: () => `mcp · ${server}/${mcpName}`,
          describe: (args) => ({
            tool: name,
            summary: `MCP ${server}: ${mcpName} (có thể thay đổi dữ liệu)`,
            preview: JSON.stringify(args, null, 1).slice(0, 1500),
          }),
          async run(args, ctx): Promise<ToolResult> {
            const live = states.get(server);
            if (!live || !live.cfg.enabled) return { ok: false, output: `MCP server ${server} is disabled` };
            try {
              if (!live.client) await refreshOne(live);
              if (!live.client) return { ok: false, output: `MCP server ${server} unavailable: ${live.error ?? "?"}` };
              const res = await live.client.callTool({ name: mcpName, arguments: args }, undefined, { signal: ctx.signal, timeout: timeoutMs, maxTotalTimeout: timeoutMs });
              const { text, isError } = textOf(res);
              const clipped = text.length > MAX_RESULT_TEXT ? `${text.slice(0, MAX_RESULT_TEXT)}\n…[cắt bớt ${text.length - MAX_RESULT_TEXT} ký tự]` : text;
              return { ok: !isError, output: untrusted(server, mcpName, clipped || "(empty)"), detail: `${server}/${mcpName}${isError ? " · lỗi" : ""}` };
            } catch (e) {
              const msg = safeMessage(e, deps.env, live.cfg);
              if (/closed|not connected|ECONNRESET|socket/i.test(msg)) {
                void live.client?.close().catch(() => undefined);
                live.client = undefined;
              }
              return { ok: false, output: `MCP error: ${msg}` };
            }
          },
        };
        out.push(def);
      }
    }
    return out;
  }

  function status(): ServerStatus[] {
    return getServers().map((cfg) => {
      const st = states.get(cfg.name);
      const taken = new Set<string>();
      return {
        name: cfg.name,
        source: cfg.source,
        url: cfg.url,
        enabled: cfg.enabled,
        state: !cfg.enabled ? "off" : !st || !st.fetchedAt ? "idle" : st.error ? "error" : "ok",
        transport: st?.transport,
        error: st?.error,
        tools: st && !st.error ? allowed(st).map((t) => ({ name: mcpToolName(cfg.name, t.name, taken), mcpName: t.name, readOnly: t.annotations?.readOnlyHint === true })) : [],
        fetchedAt: st?.fetchedAt || undefined,
        headers: Object.entries(cfg.headers).map(([header, env]) => ({ header, env, set: Boolean(deps.env[env]) })),
        allowTools: cfg.allowTools,
        allowLocal: cfg.allowLocal,
        timeoutS: cfg.timeoutMs / 1000,
      };
    });
  }

  async function close() {
    for (const st of states.values()) await st.client?.close().catch(() => undefined);
    states.clear();
  }

  return { refresh, toolDefs, status, close };
}

export type McpManager = ReturnType<typeof createMcpManager>;

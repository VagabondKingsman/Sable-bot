/** W4: text chat call + xAI web_search call (Responses API). Pure; fetch injected; key never logged. */
import type { SearchHit } from "./sources.ts";

export type Usage = { promptTokens: number; completionTokens: number };

export async function textCall(opts: {
  base: string;
  key: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
  maxTokens?: number;
  json?: boolean;
  fetchFn?: typeof fetch;
  /** Multi-turn (W4 code agent): replaces system+user when given. */
  messages?: { role: "system" | "user" | "assistant"; content: string }[];
}): Promise<{ text: string } & Usage> {
  const f = opts.fetchFn ?? fetch;
  const r = await f(`${opts.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 1000,
      temperature: 0.1,
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages: opts.messages ?? [
        { role: "system", content: opts.system },
        { role: "user", content: opts.user },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(`model HTTP ${r.status}`);
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  return { text: String(d.choices?.[0]?.message?.content ?? ""), promptTokens: d.usage?.prompt_tokens ?? 0, completionTokens: d.usage?.completion_tokens ?? 0 };
}

const httpUrl = (v: unknown) => {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
};

/** Pull cited URLs (+titles) out of a non-streamed Responses API result. */
export function hitsFromResponse(d: unknown): SearchHit[] {
  const out = new Map<string, SearchHit>();
  const add = (url: unknown, title?: unknown) => {
    const u = httpUrl(url);
    if (u && !out.has(u)) out.set(u, { url: u, title: typeof title === "string" ? title.slice(0, 200) : undefined });
  };
  const o = (d ?? {}) as Record<string, unknown>;
  const output = Array.isArray(o.output) ? o.output : [];
  for (const item of output as Record<string, unknown>[]) {
    for (const c of (Array.isArray(item?.content) ? item.content : []) as Record<string, unknown>[]) {
      for (const a of (Array.isArray(c?.annotations) ? c.annotations : []) as Record<string, unknown>[]) add(a?.url, a?.title);
    }
    const action = item?.action as Record<string, unknown> | undefined;
    for (const s of (Array.isArray(action?.sources) ? action!.sources : []) as Record<string, unknown>[]) add(s?.url, s?.title);
  }
  for (const u of Array.isArray(o.citations) ? o.citations : []) add(typeof u === "string" ? u : (u as Record<string, unknown>)?.url, (u as Record<string, unknown>)?.title);
  return [...out.values()];
}

/** xAI server-side web_search for one query → cited result URLs (the pages themselves are fetched by Sable). */
export async function xaiSearch(opts: { base: string; key: string; model: string; query: string; signal: AbortSignal; fetchFn?: typeof fetch }): Promise<{ hits: SearchHit[] } & Usage> {
  const f = opts.fetchFn ?? fetch;
  const r = await f(`${opts.base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
    body: JSON.stringify({
      model: opts.model,
      tools: [{ type: "web_search" }],
      max_output_tokens: 700,
      input: [
        {
          role: "user",
          content: `Search the web for: ${opts.query}\nList the 6 most relevant, authoritative pages (prefer primary sources). For each give one line "URL — title". Cite every page you list.`,
        },
      ],
    }),
    signal: opts.signal,
  });
  if (!r.ok) throw new Error(`search HTTP ${r.status}`);
  const d = (await r.json()) as { usage?: { input_tokens?: number; output_tokens?: number } };
  return { hits: hitsFromResponse(d), promptTokens: d.usage?.input_tokens ?? 0, completionTokens: d.usage?.output_tokens ?? 0 };
}

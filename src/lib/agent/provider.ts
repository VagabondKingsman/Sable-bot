/**
 * Provider-agnostic LLM endpoint resolution.
 *
 * Any OpenAI-compatible API (xAI, DeepSeek, OpenAI, OpenRouter, a local
 * gateway…) can drive the desk. Several can be configured at once; each chat
 * model is routed to the endpoint that owns it. Pure module (env passed in) so
 * it runs under `node --experimental-strip-types` tests.
 */

export type ApiStyle = "responses" | "chat";
export type ProviderId = "llm" | "xai" | "openai" | "deepseek" | "ollama" | "local";

export type Endpoint = {
  id: ProviderId;
  label: string;
  base: string;
  key: string;
  style: ApiStyle;
  models: string[];
  /** Native xAI host: server-side web/x/code tools and Imagine media work. */
  xai: boolean;
};

export type Env = Record<string, string | undefined>;

export const GROK_MODELS = ["grok-4.7", "grok-4.6", "grok-4.5"] as const;
export const DEEPSEEK_MODELS = ["deepseek-chat", "deepseek-reasoner"] as const;
export const OPENAI_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o"] as const;

const MODEL_ID = /^[\w./:@-]{1,120}$/;

export function isModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

/** Strip trailing slashes and a trailing `/v1` so callers can append `/v1/...`. */
export function normalizeBase(raw: string) {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function isXaiHost(base: string) {
  return /(^|\/\/|\.)api\.x\.ai(\/|$)/.test(base) || base.includes("cli-chat-proxy");
}

function list(raw: string | undefined) {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(isModelId);
}

function style(base: string, explicit: string | undefined): ApiStyle {
  const value = (explicit ?? "").trim().toLowerCase();
  if (value === "responses" || value === "chat") return value;
  return isXaiHost(base) ? "responses" : "chat";
}

function pick(env: Env, name: string) {
  const value = env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/** Every configured endpoint, primary first: LLM_* → XAI_* → OPENAI_* → DEEPSEEK_*. */
export function resolveEndpoints(env: Env): Endpoint[] {
  const out: Endpoint[] = [];

  const llmKey = pick(env, "LLM_API_KEY");
  if (llmKey) {
    const base = normalizeBase(pick(env, "LLM_BASE_URL") || pick(env, "XAI_BASE_URL") || "https://api.x.ai");
    const xai = isXaiHost(base);
    const models = list(env.LLM_MODELS);
    out.push({
      id: "llm",
      label: xai ? "xAI" : hostLabel(base),
      base,
      key: llmKey,
      style: style(base, env.LLM_API_STYLE),
      models: models.length ? models : xai ? [...GROK_MODELS] : [],
      xai,
    });
  }

  const xaiBase = normalizeBase(pick(env, "XAI_BASE_URL") || "https://api.x.ai");
  const proxy = pick(env, "GROK_PROXY_TOKEN");
  const xaiKey = xaiBase.includes("cli-chat-proxy") && proxy ? proxy : pick(env, "XAI_API_KEY") || proxy;
  if (xaiKey && !(llmKey && out[0]?.base === xaiBase && out[0]?.key === xaiKey)) {
    out.push({
      id: "xai",
      label: "xAI",
      base: xaiBase,
      key: xaiKey,
      style: style(xaiBase, env.XAI_API_STYLE),
      models: list(env.XAI_MODELS).length ? list(env.XAI_MODELS) : [...GROK_MODELS],
      xai: isXaiHost(xaiBase),
    });
  }

  const openaiKey = pick(env, "OPENAI_API_KEY");
  if (openaiKey) {
    const base = normalizeBase(pick(env, "OPENAI_BASE_URL") || "https://api.openai.com");
    out.push({
      id: "openai",
      label: "OpenAI",
      base,
      key: openaiKey,
      style: style(base, env.OPENAI_API_STYLE),
      models: list(env.OPENAI_MODELS).length ? list(env.OPENAI_MODELS) : [...OPENAI_MODELS],
      xai: isXaiHost(base),
    });
  }

  const deepseekKey = pick(env, "DEEPSEEK_API_KEY");
  if (deepseekKey) {
    const base = normalizeBase(pick(env, "DEEPSEEK_BASE_URL") || "https://api.deepseek.com");
    out.push({
      id: "deepseek",
      label: "DeepSeek",
      base,
      key: deepseekKey,
      style: style(base, env.DEEPSEEK_API_STYLE),
      models: list(env.DEEPSEEK_MODELS).length ? list(env.DEEPSEEK_MODELS) : [...DEEPSEEK_MODELS],
      xai: isXaiHost(base),
    });
  }


  // Ollama (OpenAI-compatible /v1). Key optional — defaults to "ollama".
  // Set OLLAMA_BASE_URL (default http://127.0.0.1:11434 when OLLAMA_MODELS or SABLE_OLLAMA=1)
  // or just OLLAMA_MODELS. Models are listed as-is (e.g. llama3.2:1b). No auto-pull.
  const ollamaOn = (env.SABLE_OLLAMA ?? "1").trim() !== "0";
  const ollamaModels = list(env.OLLAMA_MODELS);
  const ollamaBaseRaw = pick(env, "OLLAMA_BASE_URL") || (ollamaOn && ollamaModels.length ? "http://127.0.0.1:11434" : "");
  if (ollamaOn && ollamaBaseRaw) {
    const base = normalizeBase(ollamaBaseRaw);
    out.push({
      id: "ollama",
      label: "Ollama",
      base,
      key: pick(env, "OLLAMA_API_KEY") || "ollama",
      style: style(base, env.OLLAMA_API_STYLE || "chat"),
      models: ollamaModels,
      xai: false,
    });
  }

  // Any other OpenAI-compatible local server (LM Studio, vLLM, llama.cpp server…).
  // LOCAL_BASE_URL + LOCAL_MODELS; key optional (defaults to "local").
  const localModels = list(env.LOCAL_MODELS);
  const localBaseRaw = pick(env, "LOCAL_BASE_URL");
  if (localBaseRaw) {
    const base = normalizeBase(localBaseRaw);
    out.push({
      id: "local",
      label: hostLabel(base) === "127.0.0.1" || hostLabel(base) === "localhost" ? "Local" : hostLabel(base),
      base,
      key: pick(env, "LOCAL_API_KEY") || "local",
      style: style(base, env.LOCAL_API_STYLE || "chat"),
      models: localModels,
      xai: false,
    });
  }

  return out;
}

function hostLabel(base: string) {
  try {
    return new URL(base).hostname.replace(/^api\./, "");
  } catch {
    return "custom";
  }
}

/** Models for the picker. `LLM_MODELS` (when set) is the whole list. */
export function availableModels(env: Env, endpoints = resolveEndpoints(env)): string[] {
  const explicit = list(env.LLM_MODELS);
  if (explicit.length) return explicit;
  const seen = new Set<string>();
  for (const endpoint of endpoints) for (const model of endpoint.models) seen.add(model);
  return seen.size ? [...seen] : [...GROK_MODELS];
}

const PREFIX: [RegExp, ProviderId][] = [
  [/^grok/i, "xai"],
  [/^deepseek/i, "deepseek"],
  [/^(gpt|o\d|chatgpt)/i, "openai"],
  [/^(llama|mistral|qwen|phi|gemma|tinyllama|nomic)/i, "ollama"],
];

/** Endpoint that serves `model`: owner list → name prefix → primary. */
export function endpointFor(model: string, endpoints: Endpoint[]): Endpoint | undefined {
  const owned = endpoints.find((endpoint) => endpoint.models.includes(model));
  if (owned) return owned;
  for (const [pattern, id] of PREFIX) {
    if (!pattern.test(model)) continue;
    const match = endpoints.find((endpoint) => endpoint.id === id);
    if (match) return match;
  }
  return endpoints[0];
}

/** First endpoint that speaks xAI Imagine (images/videos). */
export function imagineEndpoint(endpoints: Endpoint[]) {
  return endpoints.find((endpoint) => endpoint.xai);
}

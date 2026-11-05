---
name: llm-api
description: >
  Call any OpenAI-compatible LLM API (xAI Grok, DeepSeek, OpenAI, OpenRouter,
  a local gateway, …) from this app's server code: chat/LLM features, plus
  image/video (Imagine) and voice when the wired provider offers them. Use when
  the app needs any "AI" / "assistant" / "chatbot" / "LLM" functionality,
  runtime image/video generation, or speech. Triggers on "AI", "LLM",
  "chatbot", "assistant", "Grok", "xAI", "DeepSeek", "OpenAI", "OpenRouter",
  "generate text", "summarize", "generate image", "AI video", "voice", "TTS".
metadata:
  short-description: "Any OpenAI-compatible LLM API (Grok, DeepSeek, OpenAI, …): chat, media, voice"
user-invocable: false
---

# LLM API (multi-provider)

This app talks to **whichever OpenAI-compatible API is wired in** — xAI Grok,
DeepSeek, OpenAI, OpenRouter, Together, a self-hosted vLLM/Ollama gateway, etc.
No provider is privileged: **every skill in `.grok/skills` (auth, neon,
design-ui, games, threejs, og, multiplayer, imagine guidance, …) applies the
same way regardless of which LLM API is connected.** Never gate a feature or a
skill on "xAI only", and never tell the user to swap providers to use a skill.

Use the real API for AI features instead of mocking responses. **Keys are the
app owner's: every call spends their quota and credits** — see
[Spend responsibly](#spend-responsibly).

## Env vars — do **not** create a `.env` file

Read them server-side only. Resolution order (first match wins):

| Purpose | Variables |
|---|---|
| API key | `LLM_API_KEY` → `XAI_API_KEY` → `OPENAI_API_KEY` → `DEEPSEEK_API_KEY` |
| Base URL | `LLM_BASE_URL` → `XAI_BASE_URL` → provider default (`https://api.x.ai`, `https://api.openai.com`, `https://api.deepseek.com`) |
| Model picker | `LLM_MODELS` — optional comma list, e.g. `deepseek-chat,deepseek-reasoner` |
| API shape | `LLM_API_STYLE` — `chat` (`/v1/chat/completions`) or `responses` (`/v1/responses`); default `responses` on xAI hosts, `chat` elsewhere |
| Output cap | `LLM_MAX_TOKENS` — chat/completions `max_tokens` (default 8192) |

Several providers may be set at once (e.g. `XAI_API_KEY` + `DEEPSEEK_API_KEY`);
route each model id to the provider that serves it. Per-provider overrides:
`OPENAI_BASE_URL`/`OPENAI_MODELS`, `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODELS`,
`XAI_MODELS`. A base with or without a trailing `/v1` both work.

Keys are **server-only**: `process.env.*` inside `createServerFn` handlers /
server routes, never in client components, never via a `VITE_` variable or an
API response. Any of them can be **absent** — degrade gracefully with a
friendly "AI features are unavailable" state instead of crashing.

In this repo the resolution lives in `src/lib/agent/provider.ts`
(`resolveEndpoints`, `availableModels`, `endpointFor`, `imagineEndpoint`);
reuse it rather than reading env vars ad hoc.

## Calling the API (server-only)

Plain `fetch`, OpenAI-compatible shape — works on every provider:

```ts
import { createServerFn } from "@tanstack/react-start";
import { endpointFor, resolveEndpoints } from "@/lib/agent/provider";

export const ask = createServerFn({ method: "POST" })
  .validator((input: { prompt: string; model: string }) => input)
  .handler(async ({ data }) => {
    const endpoint = endpointFor(data.model, resolveEndpoints(process.env));
    if (!endpoint) return { ok: false as const, error: "AI is not available" };

    const res = await fetch(`${endpoint.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` },
      body: JSON.stringify({
        model: data.model, // e.g. grok-4.7, deepseek-chat, gpt-4.1, openai/gpt-4o
        max_tokens: 1024,
        messages: [{ role: "user", content: data.prompt }],
      }),
    });
    if (!res.ok) return { ok: false as const, error: `LLM API error ${res.status}` };
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return { ok: true as const, text: body.choices[0]?.message.content ?? "" };
  });
```

Streaming: `stream: true` returns SSE `data:` lines with
`choices[0].delta.content` (reasoning models such as `deepseek-reasoner` also
send `delta.reasoning_content`). Check the provider's docs for model ids and
limits (e.g. [docs.x.ai](https://docs.x.ai), [api-docs.deepseek.com](https://api-docs.deepseek.com),
[platform.openai.com/docs](https://platform.openai.com/docs)); don't guess.

## Provider capabilities (feature-detect, don't hard-gate)

Chat works on every provider. Some extras are provider-specific — detect them
and degrade with a clear message, never crash and never block other skills:

- **Server-side tools** (`web_search`, `x_search`, `code_interpreter`,
  `image_generation` inside a turn) run through the xAI **Responses API**
  (`/v1/responses`). On a chat/completions provider, answer without them and
  tell the user which tools were skipped, or implement the tool yourself
  (function calling + your own search/code runner).
- **Imagine (image/video generation)**: `POST /v1/images/generations`,
  `/v1/images/edits`, async `/v1/videos/generations` on an xAI host
  (`grok-imagine-image-quality`, `grok-imagine-image`, `grok-imagine-video`).
  OpenAI-compatible image endpoints elsewhere (e.g. OpenAI `gpt-image-1`) take
  a similar shape — use them when that provider is wired. If no image-capable
  endpoint exists, return a clear JSON error.
- **Voice**: xAI `POST /v1/tts` / `GET /v1/tts/voices`, OpenAI
  `/v1/audio/speech`; serve audio from the server, never call from the browser.

Runtime media (inside the running app) is distinct from the build-time
`imagine_*` tools in the `imagine-grok-build` skill, which you use to create
static assets while building — those work no matter which LLM API the app uses.

## Spend responsibly

Every call — including ones triggered by anonymous visitors of the deployed app
— spends the **app owner's** quota on whichever provider is wired:

- **Cap output** (`max_tokens`) and keep prompts small for visitor-facing
  features. Image, and especially video, generation cost far more than chat.
- **Never call the API in a loop, on every keystroke, or on page load** —
  user-initiated calls only, debounced.
- **Cache or persist results** (see the `neon` skill).
- **Gate expensive flows** — on an app that already has sign-in, put them
  behind `authMiddleware` (the **`auth` skill**). Sign-in is off by default and
  adding the middleware without it breaks the deployed app (AGENTS.md §0.5), so
  without accounts cap usage instead: small limits, cached results.
- No retry storms: surface API errors, retry at most once.

import assert from "node:assert/strict";
import test from "node:test";
import { availableModels, endpointFor, imagineEndpoint, normalizeBase, resolveEndpoints } from "./provider.ts";

test("xAI key alone keeps the Grok Responses path", () => {
  const list = resolveEndpoints({ XAI_API_KEY: "x" });
  assert.equal(list.length, 1);
  assert.equal(list[0].base, "https://api.x.ai");
  assert.equal(list[0].style, "responses");
  assert.deepEqual(availableModels({ XAI_API_KEY: "x" }), ["grok-4.7", "grok-4.6", "grok-4.5"]);
  assert.ok(imagineEndpoint(list));
});

test("DeepSeek key alone uses chat/completions on api.deepseek.com", () => {
  const env = { DEEPSEEK_API_KEY: "d" };
  const list = resolveEndpoints(env);
  assert.equal(list[0].base, "https://api.deepseek.com");
  assert.equal(list[0].style, "chat");
  assert.deepEqual(availableModels(env), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(imagineEndpoint(list), undefined);
});

test("xAI + DeepSeek together route each model to its owner", () => {
  const env = { XAI_API_KEY: "x", DEEPSEEK_API_KEY: "d" };
  const list = resolveEndpoints(env);
  assert.deepEqual(availableModels(env), ["grok-4.7", "grok-4.6", "grok-4.5", "deepseek-chat", "deepseek-reasoner"]);
  assert.equal(endpointFor("deepseek-reasoner", list)?.id, "deepseek");
  assert.equal(endpointFor("grok-4.7", list)?.id, "xai");
  assert.equal(endpointFor("some/custom-model", list)?.id, "xai");
});

test("LLM_* wins and LLM_MODELS is the picker list", () => {
  const env = {
    LLM_API_KEY: "k",
    LLM_BASE_URL: "https://openrouter.ai/api/v1/",
    LLM_MODELS: "deepseek/deepseek-chat, openai/gpt-4o",
    XAI_API_KEY: "x",
  };
  const list = resolveEndpoints(env);
  assert.equal(list[0].id, "llm");
  assert.equal(list[0].base, "https://openrouter.ai/api");
  assert.equal(list[0].style, "chat");
  assert.deepEqual(availableModels(env), ["deepseek/deepseek-chat", "openai/gpt-4o"]);
  assert.equal(endpointFor("openai/gpt-4o", list)?.id, "llm");
  assert.equal(imagineEndpoint(list)?.id, "xai");
});

test("LLM_API_STYLE forces the Responses API", () => {
  const list = resolveEndpoints({ LLM_API_KEY: "k", LLM_BASE_URL: "https://api.openai.com", LLM_API_STYLE: "responses" });
  assert.equal(list[0].style, "responses");
});

test("normalizeBase strips /v1 and slashes", () => {
  assert.equal(normalizeBase("https://api.deepseek.com/v1/"), "https://api.deepseek.com");
});

test("no key → no endpoints", () => {
  assert.deepEqual(resolveEndpoints({}), []);
});

test("ollama endpoint from OLLAMA_BASE_URL + OLLAMA_MODELS (no key needed)", () => {
  const list = resolveEndpoints({
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODELS: "llama3.2:1b,qwen2.5:0.5b",
  });
  const o = list.find((e) => e.id === "ollama");
  assert.ok(o);
  assert.equal(o!.base, "http://127.0.0.1:11434");
  assert.equal(o!.key, "ollama");
  assert.equal(o!.style, "chat");
  assert.equal(o!.xai, false);
  assert.deepEqual(o!.models, ["llama3.2:1b", "qwen2.5:0.5b"]);
  assert.equal(endpointFor("llama3.2:1b", list)?.id, "ollama");
});

test("ollama from OLLAMA_MODELS alone uses default localhost base", () => {
  const list = resolveEndpoints({ OLLAMA_MODELS: "tinyllama" });
  assert.equal(list.find((e) => e.id === "ollama")?.base, "http://127.0.0.1:11434");
});

test("SABLE_OLLAMA=0 kills ollama even when configured", () => {
  const list = resolveEndpoints({
    SABLE_OLLAMA: "0",
    OLLAMA_BASE_URL: "http://127.0.0.1:11434",
    OLLAMA_MODELS: "llama3.2:1b",
  });
  assert.equal(list.find((e) => e.id === "ollama"), undefined);
});

test("LOCAL_BASE_URL adds a generic OpenAI-compatible local endpoint (LM Studio / vLLM)", () => {
  const list = resolveEndpoints({
    LOCAL_BASE_URL: "http://127.0.0.1:1234/v1",
    LOCAL_MODELS: "local-model",
    LOCAL_API_KEY: "lm-studio",
  });
  const loc = list.find((e) => e.id === "local");
  assert.ok(loc);
  assert.equal(loc!.base, "http://127.0.0.1:1234");
  assert.equal(loc!.key, "lm-studio");
  assert.deepEqual(loc!.models, ["local-model"]);
  assert.equal(endpointFor("local-model", list)?.id, "local");
});

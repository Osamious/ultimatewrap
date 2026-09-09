import { test } from "node:test";
import assert from "node:assert/strict";
import { discoveryIndex } from "../keysync/keysync.mjs";

// #107. Google's listing returns resource names (`models/x`), which are rejected
// as model ids because `generateContent` already carries `models/` in its path.

test("discoveryIndex strips google's models/ resource prefix", () => {
  const idx = discoveryIndex({ google: { outcome: "ok", models: [
    { id: "models/gemini-3.8-flash", capabilityRaw: "chat" },
    { id: "models/aqa" },
  ] } });
  assert.deepEqual(idx.get("google").map((m) => m.id), ["gemini-3.8-flash", "aqa"]);
});

test("discoveryIndex carries every other field through the strip untouched", () => {
  const idx = discoveryIndex({ google: { models: [
    { id: "models/gemini-3.8-flash", capabilityRaw: "chat", contextLength: 1000000 },
  ] } });
  const [m] = idx.get("google");
  assert.equal(m.capabilityRaw, "chat");
  assert.equal(m.contextLength, 1000000, "the strip must not drop enrichment fields");
});

test("discoveryIndex dedupes a stripped id onto its bare twin, first writer winning", () => {
  // 46 of google's 55 prefixed ids collapse onto a row that already exists.
  // Without the dedupe the picker shows the same model twice under one name.
  const idx = discoveryIndex({ google: { models: [
    { id: "gemini-3.5-flash", capabilityRaw: "bare-first" },
    { id: "models/gemini-3.5-flash", capabilityRaw: "prefixed-second" },
  ] } });
  const rows = idx.get("google");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capabilityRaw, "bare-first");
});

test("discoveryIndex leaves every other provider's ids alone, prefix or not", () => {
  // PROVIDER-SCOPED. A blanket strip would rewrite a provider that legitimately
  // serves a model whose name begins `models/`.
  const idx = discoveryIndex({
    openrouter: { models: [{ id: "models/something" }, { id: "google/gemma-4" }] },
    kilo: { models: [{ id: "models/x" }] },
  });
  assert.deepEqual(idx.get("openrouter").map((m) => m.id), ["models/something", "google/gemma-4"]);
  assert.deepEqual(idx.get("kilo").map((m) => m.id), ["models/x"]);
});

test("discoveryIndex drops an id that is nothing but the prefix", () => {
  const idx = discoveryIndex({ google: { models: [{ id: "models/" }, { id: "gemma-4" }] } });
  assert.deepEqual(idx.get("google").map((m) => m.id), ["gemma-4"]);
});

test("discoveryIndex still rejects a non-string or empty id, as before", () => {
  const idx = discoveryIndex({ google: { models: [
    { id: "" }, { id: null }, {}, { id: "models/ok" },
  ] } });
  assert.deepEqual(idx.get("google").map((m) => m.id), ["ok"]);
});

// --- #108: the transport for direct OpenAI ----------------------------------
//
// gpt-5.x refuses function tools on /v1/chat/completions entirely (MEASURED
// down to one tool), and Claude Code always sends tools, so those rows can only
// work on the Responses transport.

import { resolveProtocol } from "../keysync/keysync.mjs";

test("direct OpenAI gets the Responses transport, matched on host", () => {
  assert.equal(resolveProtocol({ baseUrl: "https://api.openai.com/v1" }).type, "openai_responses");
  assert.equal(resolveProtocol({ baseUrl: "https://API.OpenAI.com/v1" }).type, "openai_responses",
    "host match is case-insensitive");
});

test("a router reselling OpenAI models keeps chat completions", () => {
  // They speak it natively, and the Responses shape would be wrong for them.
  for (const base of ["https://openrouter.ai/api/v1", "https://api.orcarouter.ai/v1",
                      "https://api.groq.com/openai/v1", "https://api.deepseek.com/v1"]) {
    assert.equal(resolveProtocol({ baseUrl: base }).type, "openai_chat_completions", base);
  }
});

test("the OpenAI host match cannot be fooled by a path or query mentioning it", () => {
  // `includes("api.openai.com")` would have accepted all three.
  for (const base of ["https://evil.example.com/api.openai.com/v1",
                      "https://router.example.com/v1?upstream=api.openai.com",
                      "https://api.openai.com.evil.example.com/v1"]) {
    assert.equal(resolveProtocol({ baseUrl: base }).type, "openai_chat_completions", base);
  }
});

test("the other two protocol branches are unchanged", () => {
  assert.equal(resolveProtocol({ baseUrl: "https://generativelanguage.googleapis.com/v1beta" }).type,
    "gemini_generate_content");
  assert.equal(resolveProtocol({ baseUrl: "https://api.anthropic.com" }).type, "anthropic_messages");
  assert.equal(resolveProtocol({ baseUrl: "http://127.0.0.1:4517" }).type, "openai_chat_completions");
});

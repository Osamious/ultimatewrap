// #114: the benchmark engine. No network: a fake stream with an injected clock
// makes the timing arithmetic exact, and the scheduler tests use real timers with
// millisecond latencies to prove the caps hold under actual concurrency.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { toStored, mergeRecord, isFresh } from "../refresh/bench-store.mjs";
import { cleanRecord, PREVIEW_CHARS } from "../menu/bench-data.mjs";
import {
  createSseParser, classifyHttp, probeOne, buildTargets, estimateCost, worstCost, isFree, runSweep, billedCost,
  UNPRICED_PER_M, STREAM_CUT_FACTOR, looksLikeNotice,
} from "../refresh/bench.mjs";

// ------------------------------------------------------------- fake stream

const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`;
const delta = (d) => ev("content_block_delta", { index: 0, delta: d });
const textDelta = (text) => delta({ type: "text_delta", text });
const thinkDelta = (thinking) => delta({ type: "thinking_delta", thinking });
const usage = (n) => ev("message_delta", { usage: { output_tokens: n } });
const stop = () => ev("message_stop", {});

/**
 * steps: [{at, chunk}] -- each `read()` advances the injected clock to `at`, so
 * the probe observes exactly these arrival times.
 */
function streamFetch(steps, { status = 200, headers = {} } = {}) {
  const clock = { t: 0 };
  const fetchImpl = async (_url, init) => {
    let i = 0;
    return {
      ok: status >= 200 && status < 300, status,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      text: async () => steps.map((s) => s.chunk).join(""),
      body: { getReader: () => ({
        read: async () => {
          if (init.signal?.aborted) throw new Error("aborted");
          if (i >= steps.length) return { done: true, value: undefined };
          const s = steps[i++];
          clock.t = s.at;
          return { done: false, value: new TextEncoder().encode(s.chunk) };
        },
        cancel: async () => {},
      }) },
    };
  };
  return { fetchImpl, now: () => clock.t };
}

const probe = (steps, over = {}) => {
  const { fetchImpl, now } = streamFetch(steps, over);
  return probeOne({ fetchImpl, now, url: "http://gw/v1/messages", key: "k", model: "p/m", ...over.probe });
};

// --------------------------------------------------------------------- SSE

test("the SSE parser emits complete events and tolerates chunk boundaries anywhere", () => {
  const full = ev("message_start", { message: { id: "x" } }) + textDelta("Hello there");
  for (let cut = 1; cut < full.length; cut += 7) {
    const p = createSseParser();
    const got = [...p.push(full.slice(0, cut)), ...p.push(full.slice(cut))];
    assert.deepEqual(got.map((e) => e.type), ["message_start", "content_block_delta"], `cut at ${cut}`);
  }
});

test("the SSE parser handles CRLF split across chunks, comments, [DONE] and bad JSON", () => {
  const p = createSseParser();
  const a = p.push("event: ping\r");
  const b = p.push("\ndata: {\"n\":1}\r\n\r\n: keep-alive comment\n\ndata: [DONE]\n\ndata: {not json\n\n");
  const all = [...a, ...b];
  assert.equal(all[0].type, "ping");
  assert.deepEqual(all[0].data, { n: 1 });
  assert.equal(all.length, 2, "a comment and [DONE] emit nothing");
  assert.equal(all[1].data, null, "unparseable JSON is kept as an event with no data");
});

test("the SSE parser cannot be grown without bound by a stream that never ends an event", () => {
  const p = createSseParser();
  for (let i = 0; i < 30; i++) p.push("x".repeat(100_000));
  // The overflow discarded the buffer (3 MB pushed, bounded at 1 MB), so the stream
  // is desynced until the next blank line; after that it must parse normally again.
  assert.deepEqual(p.push("\n\nevent: ok\ndata: {}\n\n").filter((e) => e.type).map((e) => e.type), ["ok"]);
});

// ---------------------------------------------------------- classification

test("HTTP outcomes map onto the closed status vocabulary", () => {
  assert.equal(classifyHttp(401, "bad key"), "auth");
  assert.equal(classifyHttp(402, ""), "pay");
  assert.equal(classifyHttp(404, "model_retired"), "gone");
  assert.equal(classifyHttp(429, "slow down"), "rate");
  assert.equal(classifyHttp(500, "boom"), "error");
  assert.equal(classifyHttp(403, "This model requires lite tier or higher"), "pay");
  assert.equal(classifyHttp(403, "Access denied"), "auth");
  assert.equal(classifyHttp(400, "Insufficient balance"), "pay");
});

test("a quota message that mentions recharging is a rate limit, not an empty account", () => {
  // aihubmix, measured: "accounts that have not been recharged can only try 10 times"
  assert.equal(classifyHttp(400, "accounts that have not been recharged can only try 10 times"), "rate");
  assert.equal(classifyHttp(429, "daily quota exceeded"), "rate", "a 429 quota is a cap, not a balance");
  assert.equal(classifyHttp(429, "Insufficient balance"), "pay");
});

// A model the provider does not have is `gone` whatever HTTP status the provider used,
// because they say it with 400, 422 and 500 as often as with 404. Real messages first.
// STRONG: an explicit "this model is absent", `gone` at ANY status, a 5xx included.
const GONE_STRONG_REAL = [
  "The requested model 'omni-moderation-2024-09-26' does not exist",          // openai
  "Model 'Voxtral-Mini-3B-2507' does not exist",                              // llm7
  "The model 'meta/llama-3.1-8b-instruct' does not exist",                    // bluesminds
  "model gpt-5.5-pro-2026-04-23 does not exist",                              // infron
  "Upstream request failed: Model glm-4.6 not found",                         // opencode
  "The model `foo` does not exist or you do not have access to it.",
  "No such model: foo/bar", "Unknown model 'x'", "model_not_found", "'x' is not a valid model ID",
  "Model not exist.",                                                         // alibaba (222 real rows)
  "Unsupported model `qwen-vl-max-2025-01-25`", "models/flan-t5-xl-3b is not found for API version v1beta",
  "model 'command-r' was removed on September 15, 2025. See the docs", "The model `gpt-4o-search-preview` has been deprecated, learn more",
  "The model gemma-7b-it has been decommissioned",                            // groq
];
// LOOSE wording: `gone` only at a non-5xx status; at 5xx it stays a transient `error`.
const GONE_LOOSE_REAL = [
  "Requested model is not valid",                                             // zenmux
  "This model is no longer available", "The model has been deprecated and removed",
  "The model was retired on 2026-01-01", "Invalid model: x",
  "Could not find the requested model", "model claude-2 is not supported",
  "model MiMo-V2-Flash is not supported",                                     // aihubmix
];
const GONE_REAL = [...GONE_STRONG_REAL, ...GONE_LOOSE_REAL];
const NOT_GONE = [
  ["nararouter", "The model rejected this request", "error"],
  ["anymodel", "The selected model is temporarily unavailable", "error"],
  ["overload", "The model is currently overloaded, please try again later", "error"],
  ["upstream", "Upstream request failed", "error"],
  ["unavailable", "Service unavailable", "error"],
  ["bare word", "model", "error"],
  ["parameter", "The parameter 'foo' does not exist for this model", "error"],
  ["parameter deprecated", "The max_tokens parameter is deprecated for this model", "error"],
  ["streaming", "Streaming is not supported for this model", "error"],
  ["streaming 2", "Model x is not supported for streaming", "error"],
  ["sentence break", "The model is fine. The route was not found in the cache", "error"],
  ["rate w/ model", "Rate limit reached for model gpt-4o in organization org-1 on requests per min", "rate"],
  ["rate w/ 'not found'", "Too many requests: model foo not found in the warm pool", "rate"],
  ["quota beats gone", "Accounts that have not been recharged can only try 10 times: model does not exist", "rate"],
  ["pay w/ model", "Insufficient balance to use this model. Model qwen not found in your funded tier", "pay"],
  ["plan", "Model xyz not found in your plan, upgrade to use it", "pay"],
  ["premium", "The model requires a premium subscription", "pay"],
];

test("a not-found / removed-model message is `gone` at any 4xx; only the STRONG anchors are `gone` at a 5xx", () => {
  for (const msg of GONE_REAL) {
    for (const status of [400, 404, 410, 422]) {
      assert.equal(classifyHttp(status, JSON.stringify({ error: { message: msg } })), "gone", `${status}: ${msg}`);
      assert.equal(classifyHttp(status, msg), "gone", `${status} (plain text): ${msg}`);
    }
  }
  for (const msg of GONE_STRONG_REAL) {
    for (const status of [500, 502, 503]) assert.equal(classifyHttp(status, JSON.stringify({ error: { message: msg } })), "gone", `${status}: ${msg}`);
  }
  for (const msg of GONE_LOOSE_REAL) {
    for (const status of [500, 502, 503]) assert.equal(classifyHttp(status, JSON.stringify({ error: { message: msg } })), "error", `${status} stays transient: ${msg}`);
  }
  assert.equal(classifyHttp(404, "anything at all"), "gone", "a 404 is a 404");
  assert.equal(classifyHttp(400, JSON.stringify({ error: { message: "x", code: "model_not_found" } })), "gone", "the error code counts too");
  assert.equal(classifyHttp(400, JSON.stringify({ message: "Model foo does not exist" })), "gone", "top-level message");
  assert.equal(classifyHttp(400, JSON.stringify({ error: "Model foo does not exist" })), "gone", "bare error string");
});

test("adversarial messages: the phrases must be about the MODEL; rate, pay and transient readings keep precedence", () => {
  for (const [name, msg, want] of NOT_GONE) {
    for (const status of name === "premium" ? [400] : [400, 500]) {   // a 5xx is never `pay` for a mere plan phrase
      assert.equal(classifyHttp(status, JSON.stringify({ error: { message: msg } })), want, `${name} (${status}): ${msg}`);
    }
  }
  // status codes that name a class still win over a not-found sentence
  assert.equal(classifyHttp(401, "Model foo does not exist"), "auth");
  assert.equal(classifyHttp(402, "Model foo does not exist"), "pay");
  assert.equal(classifyHttp(429, "Model foo does not exist"), "rate");
  assert.equal(classifyHttp(403, "Model foo does not exist"), "auth");
  assert.equal(classifyHttp(500, "boom"), "error");
});

test("a message that says the model is in the account's plan is `pay`, not `gone`", () => {
  // The model exists; upgrading is the fix. `gone` would bury a usable model in the
  // sweep's data, whereas `pay` keeps it in the "needs money" reading.
  assert.equal(classifyHttp(400, "Model xyz not found in your plan, upgrade to use it"), "pay");
  assert.equal(classifyHttp(500, "The model 'x' is not available under your current subscription"), "pay");
});

// The study's classifier gaps (plans/bench-study/REPORT.md sec 3.8 / 6), each pinned by its REAL sentence.

const body = (m, extra = {}) => JSON.stringify({ error: { message: m, ...extra } });

test("gateway-opaque 'Upstream request failed.' is mapped by the HTTP status alone, and the sentence is kept in `m`", async () => {
  const SENT = "veniceai: Upstream request failed.";
  for (const [status, want] of [[402, "pay"], [404, "gone"], [401, "auth"], [403, "auth"], [500, "error"], [502, "error"]]) {
    assert.equal(classifyHttp(status, body(SENT)), want, `${status}`);
    const r = await probe([{ at: 5, chunk: body(SENT) }], { status });
    assert.equal(r.s, want, `${status} through the probe`);
    assert.equal(r.m, SENT, "the raw sentence is kept");
    assert.equal(r.http, status);
  }
  assert.equal(classifyHttp(400, body("huggingface: Upstream request failed.")), "error", "at a status that names nothing it stays a transient error");
});

test("google 'no longer available to new users' is ACCOUNT state: `auth`, not `gone` (the model exists and works for others)", () => {
  const SENT = "This model models/gemini-2.0-flash is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.";
  for (const status of [400, 404, 410, 500]) {
    assert.equal(classifyHttp(status, JSON.stringify({ error: { code: status, message: SENT, status: "NOT_FOUND" } })), "auth", `${status}`);
    assert.equal(classifyHttp(status, SENT), "auth");
  }
  // ...while google's own not-found sentence stays `gone`
  assert.equal(classifyHttp(404, body("models/flan-t5-xl-3b is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models and their supported methods.")), "gone");
  // 401/403/402 keep their own reading whatever the sentence says
  assert.equal(classifyHttp(403, SENT), "auth"); assert.equal(classifyHttp(401, SENT), "auth"); assert.equal(classifyHttp(402, SENT), "pay");
});

test("aihubmix 'cannot be served at the moment. Check the model ID' is a transient `error`, never `gone`", () => {
  const SENT = "aihubmix: The model hy3-preview cannot be served at the moment. Check the model ID at https://aihubmix.com/models try again later, or contact support with the request id 202609291254551571097.";
  for (const status of [400, 500, 502, 503]) assert.equal(classifyHttp(status, body(SENT)), "error", `${status}`);
  for (const s of ["Model is unavailable", "No available providers", "cannot be served at the moment", "The model is currently overloaded",
                   "infron: bad response status code 400 (request id: 20260929133859)"]) {
    assert.equal(classifyHttp(500, body(s)), "error", s);
  }
});

test("nararouter's 429 'Insufficient credits ... try again in a few minutes' is `pay` even when the body also says rate_limit", () => {
  const SENT = "nararouter: Insufficient credits. Please top up your balance and try again in a few minutes.";
  assert.equal(classifyHttp(429, JSON.stringify({ error: { type: "rate_limit_error", message: SENT } })), "pay", "the rate_limit type must not win");
  assert.equal(classifyHttp(429, body(SENT)), "pay");
  assert.equal(classifyHttp(400, body(SENT)), "pay");
  assert.equal(classifyHttp(401, body("Insufficient permissions")), "auth", "insufficient PERMISSIONS is not a balance");
  // and the true rate limits keep being rate
  for (const s of ["aihubmix: Model coding-xiaomi-mimo-v2.5 rate limited by provider - contact support to request higher concurrency or try again later. (tid: 20260929)",
                   "Rate limit exceeded", "Accounts that have not been recharged can only try 10 times", "Too many requests"]) {
    assert.equal(classifyHttp(429, body(s)), "rate", s);
  }
});

test("orcarouter 'Free models are not available to this account yet' is account state: `auth`, not `rate`", () => {
  const SENT = "orcarouter: Free models are not available to this account yet. They require the workspace owner to link a GitHub account that has been registered for some time";
  assert.equal(classifyHttp(429, body(SENT)), "auth");
  assert.equal(classifyHttp(403, body(SENT)), "auth");
});

test("the unchanged neighbours of those rules, by their real sentences", () => {
  assert.equal(classifyHttp(429, body("google: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.")), "rate");
  assert.equal(classifyHttp(402, body("kilo: Add credits to continue, or switch to a free model")), "pay");
  assert.equal(classifyHttp(403, body("commandcode: Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.")), "pay");
  assert.equal(classifyHttp(400, body("zenmux: model_requires_purchase: x is locked on your account until you make a purchase. Buy credits")), "pay");
  assert.equal(classifyHttp(404, body("openai: The requested model `x` does not exist or you do not have access to it.")), "gone");
  assert.equal(classifyHttp(400, body("mistral: Model x is a Labs model. An admin must enable it")), "error", "unchanged");
});

test("provider text is REDACTED in `m` and the head of `p`, and the classification still read the raw body", async () => {
  const r = await probe([{ at: 5, chunk: body("sambanova: Incorrect API key provided: 7f3a9c*****e21d.") }], { status: 401 });
  assert.equal(r.s, "auth");
  assert.equal(r.m, "sambanova: Incorrect API key provided: [masked-key].");
  assert.equal(/7f3a9c|e21d/.test(JSON.stringify(r)), false, "no fragment of the key anywhere in the result");
  const go = await probe([{ at: 5, chunk: body("commandcode: Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.") }], { status: 403 });
  assert.equal(go.s, "pay");
  assert.equal(/https?:|commandcode\.ai/.test(JSON.stringify(go)), false);
  assert.match(go.m, /Upgrade to Provider or higher at \[url\]/);
  const net = await probeOne({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5 via https://internal.example.com/x sk-abcdefgh12345678"); }, url: "u", key: "k", model: "p/m" });
  assert.equal(/example\.com|sk-abcdefgh/.test(JSON.stringify(net)), false);
  const stream = await probe([{ at: 30, chunk: ev("error", { error: { message: "Bearer abc12345def67890 rejected at https://x.ai/y" } }) }]);
  assert.equal(/abc12345def67890|x\.ai/.test(JSON.stringify(stream)), false);
});

test("a `gone` result is a final fact: the row is not retried", async () => {
  const { fn, st } = tracked(1, () => ({ s: "gone", http: 400, m: "Model x does not exist" }));
  const { out, onResult } = collect();
  await runSweep({ groups: group({ p: mk("p", 5) }), probe: fn, onResult, probeAll: true, coolAfter: 1000, ...fast });
  assert.equal(st.calls.length, 5, "one attempt per row: `gone` is not `error`, so no retry");
  assert.ok(out.every((r) => r.s === "gone"));
});

// ------------------------------------------------------------------- probe

test("every non-ok result carries the provider's whole sentence in `m` (up to 160), while `p` stays a 40-character cell", async () => {
  const long = "The requested model 'omni-moderation-2024-09-26' does not exist. " + "detail ".repeat(60);
  const body = JSON.stringify({ error: { message: long } });
  const gone = await probe([{ at: 5, chunk: body }], { status: 400 });
  assert.equal(gone.s, "gone");
  assert.equal([...gone.p].length, PREVIEW_CHARS, "p is the head of the sentence, clipped to the stored preview length");
  assert.equal([...gone.m].length, 160);
  assert.ok(gone.m.startsWith("The requested model 'omni-moderation-2024-09-26' does not exist."));
  assert.ok(gone.m.startsWith(gone.p.trimEnd().slice(0, 30)));
  for (const [status, s] of [[401, "auth"], [402, "pay"], [429, "rate"], [500, "error"]]) {
    const r = await probe([{ at: 5, chunk: JSON.stringify({ error: { message: `msg for ${status}` } }) }], { status });
    assert.equal(r.s, s); assert.equal(r.m, `msg for ${status}`);
  }
  const bare = await probe([{ at: 5, chunk: "" }], { status: 502 });
  assert.equal(bare.m, "HTTP 502", "an empty body still says what happened");
  const empty = await probe([{ at: 10, chunk: ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) + stop() }]);
  assert.equal(empty.s, "empty"); assert.match(empty.m, /no content.*end_turn/);
  const hidden = await probe([{ at: 10, chunk: ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 61 } }) + stop() }]);
  assert.match(hidden.m, /hidden reasoning.*61 tokens/);
  const streamErr = await probe([{ at: 30, chunk: ev("error", { error: { message: "upstream exploded " + "z".repeat(300) } }) }]);
  assert.equal(streamErr.s, "error"); assert.equal([...streamErr.m].length, 160);
  const net = await probeOne({ fetchImpl: async () => { throw new Error("ECONNRESET on socket"); }, url: "u", key: "k", model: "p/m" });
  assert.equal(net.m, "ECONNRESET on socket");
  const ok = await probe([{ at: 10, chunk: textDelta("Hello") }, { at: 20, chunk: usage(12) + stop() }]);
  assert.equal("m" in ok, false, "an ok result has no message");
});

test("`m` on a timeout says how long it waited and when the first token came", async () => {
  let n = 0;
  const fetchImpl = async (_u, init) => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({
      read: () => new Promise((resolve, reject) => {
        if (n++ === 0) return resolve({ done: false, value: new TextEncoder().encode(textDelta("hi")) });
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      cancel: async () => {},
    }) },
  });
  let t = 0;
  const r = await probeOne({ fetchImpl, now: () => (t += 10), url: "u", key: "k", model: "p/m", timeoutMs: 30 });
  assert.equal(r.s, "timeout");
  assert.match(r.m, /no complete answer within 30 ms; first token at \d+ ms/);
});

test("`m` is hostile-text safe on write: no escape sequence, control or bidi character survives", async () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;pwned\x07‮bad​\x00 tail";
  const r = await probe([{ at: 5, chunk: JSON.stringify({ error: { message: hostile } }) }], { status: 400 });
  assert.equal(/[\x00-\x1f\x7f-\x9f]|[​-‏‪-‮⁦-⁩]/.test(r.m), false, JSON.stringify(r.m));
  assert.match(r.m, /red/);
  const thrown = await probeOne({ fetchImpl: async () => { throw new Error(hostile); }, url: "u", key: "k", model: "p/m" });
  assert.equal(/[\x1b‮]/.test(thrown.m), false);
});

test("the engine's own error for a probe that throws carries `m` as well", async () => {
  const { out, onResult } = collect();
  await runSweep({ groups: group({ p: mk("p", 1) }), probe: async () => { throw new Error("kaboom in the probe"); }, onResult, deadAfter: 99, maxRetries: { rate: 0, other: 0 }, ...fast });
  assert.equal(out[0].m, "kaboom in the probe");
});

test("TTFT, total and throughput come from arrival times and the provider's own token count", async () => {
  const r = await probe([
    { at: 40, chunk: ev("message_start", { message: {} }) },
    { at: 800, chunk: textDelta("Hello") },
    { at: 1300, chunk: textDelta(" there friend") },
    { at: 1800, chunk: textDelta(" today ok") },
    { at: 1900, chunk: usage(40) + stop() },
  ]);
  assert.equal(r.s, "ok");
  assert.equal(r.t, 800, "TTFT is the first content delta, not message_start");
  assert.equal(r.d, 1900);
  assert.equal(r.o, 40);
  assert.equal(r.r, 40, "40 tokens over the 1000 ms between first and last delta");
  assert.equal(r.p, "Hello there friend today ok");
  assert.equal(r.k, 0);
});

test("a thinking-first stream reports TTFT at the first thinking delta and marks the preview", async () => {
  const r = await probe([
    { at: 300, chunk: thinkDelta("Let me consider the request") },
    { at: 900, chunk: thinkDelta(" carefully.") },
    { at: 1000, chunk: usage(64) + stop() },
  ]);
  assert.equal(r.s, "ok");
  assert.equal(r.t, 300);
  assert.equal(r.k, 1, "no text arrived: the preview is thinking and must say so");
  assert.match(r.p, /Let me consider/);
});

test("text is preferred over thinking for the preview when both arrive", async () => {
  const r = await probe([
    { at: 100, chunk: thinkDelta("hmm") }, { at: 200, chunk: textDelta("Hi") },
    { at: 300, chunk: usage(10) + stop() },
  ]);
  assert.equal(r.p, "Hi");
  assert.equal(r.k, 0);
});

test("throughput is null, never estimated, when it is not measurable", async () => {
  const noUsage = await probe([{ at: 100, chunk: textDelta("a") }, { at: 900, chunk: textDelta("b") }, { at: 950, chunk: stop() }]);
  assert.equal(noUsage.r, null, "no provider token count: no throughput");
  const few = await probe([{ at: 100, chunk: textDelta("a") }, { at: 900, chunk: usage(3) + stop() }]);
  assert.equal(few.r, null, "fewer than 8 output tokens is noise");
  const instant = await probe([{ at: 100, chunk: textDelta("a") + textDelta("b") + usage(50) + stop() }]);
  assert.equal(instant.r, null, "a 0 ms window would divide by nothing");
});

test("HTTP 200 with a stream but no content is `empty`", async () => {
  const r = await probe([{ at: 50, chunk: ev("message_start", { message: {} }) }, { at: 90, chunk: stop() }]);
  assert.equal(r.s, "empty");
});

test("a model that spends its whole budget on hidden reasoning is `empty` and says why", async () => {
  // The exact shape MEASURED through the gateway for inceptionlabs mercury-2.5:
  // message_start, one message_delta (61 tokens, stop_reason max_tokens), message_stop.
  const r = await probe([
    { at: 2124, chunk: ev("message_start", { message: { id: "x" } }) },
    { at: 2127, chunk: ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 61 } }) + stop() },
  ]);
  assert.equal(r.s, "empty");
  assert.equal(r.o, 61, "the provider's token count is kept");
  assert.match(r.p, /hidden reasoning/);
  assert.equal("t" in r, false, "there was no first content, so there is no TTFT to report");
});

test("an empty stream that did NOT hit max_tokens carries no reasoning claim", async () => {
  const r = await probe([{ at: 10, chunk: ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } }) + stop() }]);
  assert.equal(r.s, "empty");
  assert.equal("p" in r, false);
});

test("an error event before any content is an `error` carrying the message", async () => {
  const r = await probe([{ at: 30, chunk: ev("error", { error: { message: "upstream exploded" } }) }]);
  assert.equal(r.s, "error");
  assert.match(r.p, /upstream exploded/);
});

test("non-2xx responses classify, carry the error text, and honour Retry-After", async () => {
  const body = (m) => JSON.stringify({ error: { message: m } });
  const auth = await probe([{ at: 5, chunk: body("Invalid API key") }], { status: 401 });
  assert.equal(auth.s, "auth"); assert.equal(auth.http, 401); assert.match(auth.p, /Invalid API key/);
  const rate = await probe([{ at: 5, chunk: body("slow down") }], { status: 429, headers: { "retry-after": "7" } });
  assert.equal(rate.s, "rate"); assert.equal(rate.ra, 7000);
  const gone = await probe([{ at: 5, chunk: body("No endpoints available") }], { status: 404 });
  assert.equal(gone.s, "gone");
});

test("a timeout is `timeout`, and keeps TTFT when the first token had already arrived", async () => {
  let n = 0;
  const fetchImpl = async (_u, init) => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({
      read: () => new Promise((resolve, reject) => {
        if (n++ === 0) return resolve({ done: false, value: new TextEncoder().encode(textDelta("hi")) });
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
      cancel: async () => {},
    }) },
  });
  let t = 0;
  const r = await probeOne({ fetchImpl, now: () => (t += 10), url: "u", key: "k", model: "p/m", timeoutMs: 30 });
  assert.equal(r.s, "timeout");
  assert.ok(Number.isFinite(r.t), "the first token time survives the timeout");
});

test("a network failure is `error`; a caller abort is reported as aborted, not recorded", async () => {
  const boom = await probeOne({ fetchImpl: async () => { throw new Error("ECONNRESET"); }, url: "u", key: "k", model: "p/m" });
  assert.equal(boom.s, "error"); assert.match(boom.p, /ECONNRESET/);
  const ac = new AbortController();
  const p = probeOne({
    fetchImpl: (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    url: "u", key: "k", model: "p/m", signal: ac.signal, timeoutMs: 5000,
  });
  ac.abort();
  assert.deepEqual(await p, { aborted: true });
});

test("model output is untrusted: escape sequences and bidi overrides never reach a stored preview", async () => {
  const hostile = "\x1b[2J\x1b]0;pwned\x07evil‮txt​\x00ok";
  const r = await probe([{ at: 10, chunk: textDelta(hostile) }, { at: 20, chunk: usage(12) + stop() }]);
  assert.equal(/[\x00-\x1f\x7f-\x9f]|[​-‏‪-‮⁦-⁩]/.test(r.p), false, JSON.stringify(r.p));
  assert.match(r.p, /evil/);
  const err = await probe([{ at: 5, chunk: JSON.stringify({ error: { message: "\x1b[31mred\x1b[0m‮bad" } }) }], { status: 500 });
  assert.equal(/[\x1b‮]/.test(err.p), false);
});

test("a preview is capped at PREVIEW_CHARS (120) code points", async () => {
  const r = await probe([{ at: 10, chunk: textDelta("x".repeat(500)) }, { at: 20, chunk: usage(20) + stop() }]);
  assert.equal([...r.p].length, PREVIEW_CHARS); assert.equal(PREVIEW_CHARS, 120);
});

// ---------------------------------------------------------------- targets

const snap = (rows) => ({ rows });
const row = (provider, models, health = "ok") => ({ provider, health, models });
const M = (id, o = {}) => ({ id, badge: "", pin: null, pout: null, outputKind: "text", routable: true, ...o });

test("targets: non-text and known-unroutable rows are not probed; unknown routability is", () => {
  const g = buildTargets(snap([row("a", [
    M("chat"), M("img", { outputKind: "nontext" }), M("dead", { routable: false }), M("unk", { routable: null }),
  ])]));
  assert.deepEqual(g.get("a").map((t) => t.id), ["chat", "unk"]);
});

test("targets: one probe per provider/bare-id, with the [1m] suffix stripped", () => {
  const g = buildTargets(snap([row("a", [M("m"), M("m[1m]"), M("n[1m]")])]));
  assert.deepEqual(g.get("a").map((t) => t.key), ["a/m", "a/n"]);
  assert.equal(g.get("a")[1].id, "n", "the probe selector is the bare id");
});

test("targets: canary first -- free rows in catalogue order, then paid rows cheapest first", () => {
  const g = buildTargets(snap([row("a", [
    M("dear", { pin: 100, pout: 300 }), M("free1", { badge: "FREE" }), M("cheap", { pin: 0.1, pout: 0.2 }),
    M("free2", { pin: 0, pout: 0 }), M("unk"),
  ])]));
  // dear costs ~$0.03 per probe, cheap is well under it, and the unpriced row goes LAST whatever its assumed cost.
  assert.deepEqual(g.get("a").map((t) => t.id), ["free1", "free2", "cheap", "dear", "unk"]);
});

test("targets: --only narrows by provider and by exact row", () => {
  const s = snap([row("a", [M("x"), M("y")]), row("b", [M("z")])]);
  assert.deepEqual([...buildTargets(s, { only: ["b"] }).keys()], ["b"]);
  assert.deepEqual(buildTargets(s, { only: ["a/y"] }).get("a").map((t) => t.id), ["y"]);
});

test("cost estimates: free is 0; priced is per million tokens; expected uses a typical answer, worst case the full max_tokens", () => {
  assert.equal(isFree(M("f", { badge: "FREE?" })), true);
  assert.equal(estimateCost(M("f", { badge: "FREE" })), 0);
  assert.equal(worstCost(M("f", { badge: "FREE" })), 0);
  const p = M("p", { pin: 10, pout: 30 });
  assert.equal(estimateCost(p), (15 * 10 + 48 * 30) / 1e6, "expected: a 48-token answer");
  assert.equal(worstCost(p, 96), (15 * 10 + 96 * 30) / 1e6, "worst: every allowed token billed");
  assert.ok(worstCost(p) > estimateCost(p));
  // unpriced and not free: the documented conservative price ($0.60 in / $3.00 out per million), on the tokens the probe sees
  assert.equal(UNPRICED_PER_M.in, 0.6); assert.equal(UNPRICED_PER_M.out, 3);
  assert.equal(estimateCost(M("u")), (15 * 0.6 + 48 * 3) / 1e6, "unpriced expected: a 48-token answer at the documented price");
  assert.equal(worstCost(M("u"), 96), (15 * 0.6 + 96 * 3) / 1e6, "unpriced worst case: the ceiling on tokens at the documented price");
  assert.equal(worstCost(M("u"), 384), (15 * 0.6 + 384 * 3) / 1e6, "and it follows the token ceiling (the stream cut allowance)");
});

// --------------------------------------------------------------- scheduler

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mk = (provider, n, over = {}) => Array.from({ length: n }, (_, i) =>
  ({ key: `${provider}/m${i}`, provider, id: `m${i}`, free: true, cost: 0, ...over }));
const group = (obj) => new Map(Object.entries(obj));
const OK = { s: "ok", t: 1, d: 2, r: null, o: 5, p: "hi", k: 0 };

/** A probe that records concurrency, per provider and overall. */
function tracked(latency = 4, decide = () => OK) {
  const st = { active: 0, max: 0, per: {}, perMax: {}, calls: [], starts: {} };
  const fn = async (t) => {
    st.active += 1; st.max = Math.max(st.max, st.active);
    st.per[t.provider] = (st.per[t.provider] ?? 0) + 1;
    st.perMax[t.provider] = Math.max(st.perMax[t.provider] ?? 0, st.per[t.provider]);
    st.calls.push(t.key); (st.starts[t.provider] ??= []).push(performance.now());
    await sleep(latency);
    const res = decide(t, st);
    st.active -= 1; st.per[t.provider] -= 1;
    return res;
  };
  return { fn, st };
}
const collect = () => { const out = []; return { out, onResult: (r) => out.push(r) }; };
const fast = { backoffBaseMs: 3, backoffMaxMs: 20 };

test("scheduler: neither the global nor the per-provider cap is ever exceeded, and every row is recorded", async () => {
  const { fn, st } = tracked();
  const { out, onResult } = collect();
  const groups = group({ a: mk("a", 20), b: mk("b", 20), c: mk("c", 20) });
  const sum = await runSweep({ groups, probe: fn, onResult, concurrency: 4, perProvider: 2, ...fast });
  assert.ok(st.max <= 4, `global max ${st.max}`);
  for (const p of ["a", "b", "c"]) assert.ok(st.perMax[p] <= 2, `${p} max ${st.perMax[p]}`);
  assert.equal(out.length, 60);
  assert.equal(new Set(out.map((r) => r.key)).size, 60, "no row recorded twice");
  assert.equal(sum.counts.ok, 60);
});

test("scheduler: a provider gets exactly one request until its first answer (the canary)", async () => {
  const { fn, st } = tracked(25);
  await runSweep({ groups: group({ a: mk("a", 6) }), probe: fn, onResult: () => {}, concurrency: 8, perProvider: 3, ...fast });
  const [s0, s1, s2] = st.starts.a;
  assert.ok(s1 - s0 >= 20, `second request began ${s1 - s0} ms after the first, before it could have answered`);
  assert.ok(s2 - s1 < 20, "once the canary answered, the rest ran in parallel");
});

test("scheduler: round-robin means a huge provider cannot starve a small one", async () => {
  const { fn } = tracked(6);
  const done = {};
  await runSweep({
    groups: group({ big: mk("big", 60), small: mk("small", 5) }), probe: fn, concurrency: 2, perProvider: 2, ...fast,
    onResult: (r) => { done[r.provider] = (done[r.provider] ?? 0) + 1; if (r.provider === "small" && done.small === 5) done.bigAtSmallDone = done.big ?? 0; },
  });
  assert.ok(done.bigAtSmallDone < 30, `small finished while big had only done ${done.bigAtSmallDone} of 60`);
});

test("scheduler: consecutive auth refusals with no success kill the provider with no further requests", async () => {
  const { fn, st } = tracked(3, (t) => (t.provider === "bad" ? { s: "auth", http: 401 } : OK));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ bad: mk("bad", 9), good: mk("good", 4) }), probe: fn, onResult, deadAfter: 3, ...fast });
  const sent = st.calls.filter((k) => k.startsWith("bad/")).length;
  assert.ok(sent >= 3 && sent <= 4, `${sent} requests: deadAfter 3 plus at most perProvider-1 in flight`);
  const bad = out.filter((r) => r.provider === "bad");
  assert.equal(bad.length, 9, "every row is still recorded");
  assert.equal(bad.filter((r) => r.s === "skip" && r.w === "provider-dead").length, 9 - sent);
  assert.equal(out.filter((r) => r.provider === "good" && r.s === "ok").length, 4);
  assert.deepEqual(sum.dead, ["bad"]);
});

test("scheduler: ONE auth refusal does not condemn a provider (a per-model opt-in is not a bad key)", async () => {
  // mistral: the 2nd row said "is a Labs model" -> 401. The rest of the catalogue answers fine.
  const { fn } = tracked(3, (t) => (t.key === "mis/m1" ? { s: "auth", http: 401 } : OK));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ mis: mk("mis", 8) }), probe: fn, onResult, deadAfter: 3, ...fast });
  assert.equal(out.filter((r) => r.s === "skip").length, 0);
  assert.equal(out.filter((r) => r.s === "ok").length, 7);
  assert.deepEqual(sum.dead, []);
});

test("scheduler: gone and rate between refusals neither add to nor reset the run, and a success resets it", async () => {
  const seq = ["auth", "gone", "auth", "ok", "auth", "auth", "ok", "ok"];
  let i = 0;
  const { fn } = tracked(1, () => { const s = seq[i++]; return s === "ok" ? OK : { s, http: s === "gone" ? 404 : 401 }; });
  const sum = await runSweep({ groups: group({ p: mk("p", 8) }), probe: fn, onResult: () => {}, deadAfter: 3, concurrency: 1, perProvider: 1, ...fast });
  assert.deepEqual(sum.dead, [], "auth,gone,auth then a success: the run never reached 3");
});

test("scheduler: free-row pay refusals, three in a row with no success, mean the account is unusable", async () => {
  const { fn, st } = tracked(3, (t) => (t.provider === "broke" ? { s: "pay", http: 402 } : OK));
  const { out, onResult } = collect();
  await runSweep({ groups: group({ broke: mk("broke", 8) }), probe: fn, onResult, deadAfter: 3, ...fast });
  assert.ok(st.calls.length >= 3 && st.calls.length <= 4, `${st.calls.length} requests`);
  assert.equal(out.filter((r) => r.w === "provider-dead").length, 8 - st.calls.length);
});

test("scheduler: consecutive errors with no success mark a provider dead", async () => {
  const { fn, st } = tracked(2, () => ({ s: "error", p: "boom" }));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ down: mk("down", 12) }), probe: fn, onResult, deadAfter: 3, ...fast });
  assert.ok(st.calls.length <= 5, `${st.calls.length} requests to a provider that never answered (deadAfter 3, 2 in flight)`);
  assert.equal(out.length, 12);
  assert.deepEqual(sum.dead, ["down"]);
});

test("scheduler: a provider that HAS answered is not killed by later errors", async () => {
  let n = 0;
  const { fn } = tracked(2, () => (n++ === 0 ? OK : { s: "error", p: "flaky" }));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ flaky: mk("flaky", 8) }), probe: fn, onResult, ...fast });
  assert.deepEqual(sum.dead, []);
  assert.equal(out.filter((r) => r.w === "provider-dead").length, 0);
});

test("scheduler: unfunded paid rows stop after the breaker, and free rows never count toward it", async () => {
  const free = mk("aih", 3);
  const paid = mk("aih", 12, { free: false, cost: 0.001 }).map((t, i) => ({ ...t, key: `aih/p${i}`, id: `p${i}` }));
  const { fn, st } = tracked(2, (t) => (t.free ? OK : { s: "pay", http: 402 }));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ aih: [...free, ...paid] }), probe: fn, onResult, unfundedAfter: 5, ...fast });
  assert.equal(out.filter((r) => r.provider === "aih" && r.id.startsWith("m") && r.s === "ok").length, 3, "the free rows all ran");
  const sent = st.calls.filter((k) => k.startsWith("aih/p")).length;
  assert.ok(sent >= 5 && sent <= 5 + 2 - 1, `${sent} paid probes: the breaker's five plus at most perProvider-1 already in flight`);
  assert.equal(out.filter((r) => r.w === "unfunded").length, 12 - sent);
  assert.deepEqual(sum.unfunded, ["aih"]);
});

test("scheduler: 429 pauses the provider, retries the row, and other providers keep running", async () => {
  let hits = 0;
  const { fn, st } = tracked(2, (t) => (t.key === "slow/m1" && hits++ < 2 ? { s: "rate", http: 429 } : OK));
  const { out, onResult } = collect();
  const t0 = performance.now();
  const sum = await runSweep({
    groups: group({ slow: mk("slow", 3), other: mk("other", 8) }), probe: fn, onResult,
    backoffBaseMs: 15, backoffMaxMs: 60,
  });
  assert.equal(out.find((r) => r.key === "slow/m1").s, "ok", "the row was retried through the limit");
  assert.equal(st.calls.filter((k) => k === "slow/m1").length, 3, "one try plus two retries");
  assert.equal(out.filter((r) => r.provider === "other" && r.s === "ok").length, 8);
  assert.ok(performance.now() - t0 >= 15, "the backoff was honoured");
  assert.equal(sum.counts.rate ?? 0, 0);
});

test("scheduler: a row still rate-limited after its retries is recorded as `rate`", async () => {
  const { fn } = tracked(1, (t) => (t.key === "p/m0" ? { s: "rate" } : OK));
  const { out, onResult } = collect();
  await runSweep({ groups: group({ p: mk("p", 2) }), probe: fn, onResult, maxRetries: { rate: 2, other: 1 }, ...fast });
  assert.equal(out.find((r) => r.key === "p/m0").s, "rate");
});

test("scheduler: Retry-After overrides the exponential backoff", async () => {
  let first = true;
  const { fn } = tracked(1, () => (first ? ((first = false), { s: "rate", ra: 25 }) : OK));
  const t0 = performance.now();
  await runSweep({ groups: group({ p: mk("p", 1) }), probe: fn, onResult: () => {}, backoffBaseMs: 1, backoffMaxMs: 500 });
  assert.ok(performance.now() - t0 >= 24);
});

test("scheduler: the spend cap and the per-row ceiling skip paid rows without a request; free rows are unaffected", async () => {
  const tg = [
    ...mk("x", 3), // free
    ...["a", "b", "c", "d"].map((n) => ({ key: `x/${n}`, provider: "x", id: n, free: false, cost: 0.004 })),
    { key: "x/huge", provider: "x", id: "huge", free: false, cost: 0.02 },
  ];
  const { fn, st } = tracked(1);
  const { out, onResult } = collect();
  await runSweep({ groups: group({ x: tg }), probe: fn, onResult, maxSpend: 0.01, maxRowCost: 0.01, ...fast });
  assert.equal(st.calls.filter((k) => /x\/[abcd]$/.test(k)).length, 2, "0.004 x2 fits under 0.01; the third does not");
  assert.equal(out.filter((r) => r.w === "spend-cap").length, 2);
  assert.equal(out.find((r) => r.key === "x/huge").w, "row-cost");
  assert.equal(out.filter((r) => r.provider === "x" && r.id.startsWith("m") && r.s === "ok").length, 3);
});

test("scheduler: probes that FAIL are not billed, so they never eat the spend cap", async () => {
  // 20 paid rows at $0.004 against a $0.01 cap. Every probe fails with 402 (which no
  // provider bills), so none may count -- the unfunded breaker, not the cap, ends it.
  const tg = Array.from({ length: 20 }, (_, i) => ({ key: `p/r${i}`, provider: "p", id: `r${i}`, free: false, cost: 0.004 }));
  const { fn } = tracked(1, () => ({ s: "pay", http: 402 }));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: tg }), probe: fn, onResult, maxSpend: 0.01, unfundedAfter: 5, ...fast });
  assert.equal(sum.spent, 0, "nothing was billed");
  assert.equal(out.filter((r) => r.w === "spend-cap").length, 0, "the cap was never the reason a row was skipped");
  assert.ok(out.filter((r) => r.w === "unfunded").length > 0, "the breaker was");
});

test("scheduler: in-flight paid probes are reserved, so concurrency cannot overshoot the cap", async () => {
  // Six paid rows at $0.004 with a $0.01 cap and room to run six at once. Without a
  // reservation all six would be dispatched before any is billed: $0.024 against $0.01.
  const tg = Array.from({ length: 6 }, (_, i) => ({ key: `p/r${i}`, provider: "p", id: `r${i}`, free: false, cost: 0.004 }));
  const { fn, st } = tracked(8);
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: tg }), probe: fn, onResult, maxSpend: 0.01, concurrency: 6, perProvider: 6, ...fast });
  assert.ok(sum.spent <= 0.01 + 1e-9, `billed ${sum.spent} against a 0.01 cap`);
  assert.ok(st.calls.length <= 2, `${st.calls.length} paid probes were sent`);
  assert.equal(out.filter((r) => r.w === "spend-cap").length, 6 - st.calls.length);
});

test("scheduler: abort stops dispatching, lets in-flight finish, and records nothing it did not run", async () => {
  const ac = new AbortController();
  const { fn, st } = tracked(15);
  const { out, onResult } = collect();
  const p = runSweep({ groups: group({ a: mk("a", 40), b: mk("b", 40) }), probe: fn, onResult, signal: ac.signal, concurrency: 4, perProvider: 2, ...fast });
  await sleep(50); ac.abort();
  const sum = await p;
  assert.equal(sum.aborted, true);
  assert.ok(out.length < 80 && out.length > 0);
  assert.equal(out.filter((r) => r.s === "skip").length, 0, "undispatched rows are left for a resume, not recorded as skips");
  assert.equal(st.active, 0, "nothing left in flight");
});

test("scheduler: a probe that throws is recorded as `error` rather than crashing the sweep", async () => {
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: mk("p", 2) }), probe: async () => { throw new Error("kaboom"); }, onResult, deadAfter: 99, ...fast });
  assert.equal(out.length, 2);
  assert.ok(out.every((r) => r.s === "error"));
  assert.equal(sum.probes >= 2, true);
});

test("scheduler: scales -- 6,000 rows over 60 providers finish with every row recorded once", async () => {
  // Immediate probes (a microtask, no timer): this measures the SCHEDULER, not
  // Windows' ~15 ms timer granularity.
  const groups = new Map();
  for (let p = 0; p < 60; p++) groups.set(`p${p}`, mk(`p${p}`, 100));
  let active = 0, max = 0;
  const fn = async () => { active += 1; max = Math.max(max, active); await Promise.resolve(); active -= 1; return OK; };
  const seen = new Set();
  const t0 = performance.now();
  await runSweep({ groups, probe: fn, onResult: (r) => seen.add(r.key), concurrency: 16, perProvider: 2, ...fast });
  assert.equal(seen.size, 6000);
  assert.ok(max <= 16, `max in flight ${max}`);
  assert.ok(performance.now() - t0 < 2000, `scheduling 6,000 rows took ${Math.round(performance.now() - t0)} ms`);
});

test("buildTargets: the canary is never a moderation, embedding or opt-in labs model when a chat model exists", () => {
  const m = (id, pin) => ({ id, ctx: 1000, pin, pout: pin, badge: "PAID", outputKind: "text", routable: true });
  const snap = { rows: [{ provider: "openai", models: [m("text-moderation-007", 0.1), m("text-embedding-3-small", 0.2),
                                                      m("labs-devstral", 0.3), m("gpt-5-mini", 1), m("gpt-5", 5)] }] };
  const list = buildTargets(snap).get("openai").map((t) => t.id);
  assert.deepEqual(list.slice(0, 2), ["gpt-5-mini", "gpt-5"], "chat models first, cheapest first among them");
  assert.deepEqual(list.slice(2).sort(), ["labs-devstral", "text-embedding-3-small", "text-moderation-007"]);
  assert.equal(list.length, 5, "nothing is dropped, only reordered");
});

// ------------------------------------------------- retried rows and the cap

test("scheduler: a row being RETRIED still faces the spend cap (retries used to bypass it)", async () => {
  // 30 paid rows at an expected $0.004, cap $0.05, room to run 6 at once. Every first
  // attempt fails AFTER tokens flowed (an error with a reported count is billed), then the row is retried. Before the fix the
  // retries skipped the gate: 12 first tries fit ($0.048) and all 12 retries were added on
  // top, $0.096 against a $0.05 cap.
  const tg = (p) => Array.from({ length: 15 }, (_, i) => ({ key: `${p}/r${i}`, provider: p, id: `r${i}`, free: false, cost: 0.004, worst: 0.01 }));
  const tries = {};
  const { fn } = tracked(2, (t) => ((tries[t.key] = (tries[t.key] ?? 0) + 1) === 1 ? { s: "error", o: 20 } : OK));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ a: tg("a"), b: tg("b") }), probe: fn, onResult,
    maxSpend: 0.05, maxRowCost: 0.1, concurrency: 6, perProvider: 3, deadAfter: 1000, ...fast });
  const largestWorst = 0.01;
  assert.ok(sum.spent <= 0.05 + 1e-9, `billed ${sum.spent} against a 0.05 cap`);
  assert.ok(sum.spent <= 0.05 + largestWorst, "and never more than one worst-case row over");
  assert.equal(out.length, 30, "every row is recorded");
  assert.equal(new Set(out.map((r) => r.key)).size, 30, "a retry is not a second row");
  const retriedSkips = out.filter((r) => r.w === "spend-cap" && tries[r.key] === 1);
  assert.ok(retriedSkips.length > 0, "a retry that no longer fits is recorded skip:spend-cap");
  assert.match(retriedSkips[0].p, /retry not sent: spend cap reached \(first try error\)/, "and says why");
  assert.equal(sum.skips["spend-cap"], out.filter((r) => r.w === "spend-cap").length);
  assert.ok(out.every((r) => r.s === "skip" || r.s === "ok"));
});

test("scheduler: a retried row that DOES fit is still retried and billed once per request", async () => {
  const tries = {};
  const { fn } = tracked(1, (t) => ((tries[t.key] = (tries[t.key] ?? 0) + 1) === 1 ? { s: "error", o: 20 } : OK));
  const tg = [{ key: "p/r0", provider: "p", id: "r0", free: false, cost: 0.004, worst: 0.01 }];
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: tg }), probe: fn, onResult, maxSpend: 0.05, ...fast });
  assert.deepEqual(out.map((r) => r.s), ["ok"]);
  assert.ok(Math.abs(sum.spent - (0.004 + 0.004)) < 1e-9, `a stream error after tokens is charged its cost, then the answer its cost: ${sum.spent}`);
});

test("scheduler: under retries and concurrency the billed estimate never exceeds the cap by a row", async () => {
  const cap = 0.1, largest = 0.02;
  const groups = new Map();
  for (const p of ["a", "b", "c", "d"]) {
    groups.set(p, Array.from({ length: 40 }, (_, i) => ({
      key: `${p}/r${i}`, provider: p, id: `r${i}`, free: false,
      cost: 0.001 * (1 + (i % 5)), worst: i % 5 === 4 ? largest : 0.005 })));
  }
  const n = {};
  // Mixed outcomes: first tries cycle rate / timeout / error / ok, so retries are everywhere.
  const kinds = [{ s: "rate", ra: 1 }, { s: "timeout" }, { s: "error", p: "x" }, OK];
  const { fn } = tracked(2, (t) => { const k = n[t.key] = (n[t.key] ?? 0) + 1; return k === 1 ? kinds[Number(t.id.slice(1)) % 4] : OK; });
  const { out, onResult } = collect();
  const sum = await runSweep({ groups, probe: fn, onResult, maxSpend: cap, maxRowCost: 0.1, concurrency: 8, perProvider: 3,
    probeAll: true, coolGapMs: 1, ...fast });
  assert.ok(sum.spent <= cap + largest, `billed ${sum.spent} against ${cap}`);
  assert.ok(sum.spent <= cap + 1e-9, "the gate is on expected cost, so in fact it holds exactly");
  assert.equal(out.length, 160);
  assert.equal(new Set(out.map((r) => r.key)).size, 160);
  assert.ok((sum.skips["spend-cap"] ?? 0) > 0, "the cap did bind, so the test measured something");
});

// --------------------------------------------------------------- probe-all

/** A clock that only moves when a timer fires; timers fire on the next macrotask, and can be cancelled. */
function fakeClock() {
  const c = { t: 1_000_000 };
  const timers = {
    set: (fn, ms) => { const h = { live: true }; setImmediate(() => { if (h.live) { c.t += ms; fn(); } }); return h; },
    clear: (h) => { if (h) h.live = false; },
  };
  return { c, now: () => c.t, timers };
}
const ticks = async (n = 2) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const RESULT = {
  auth: { s: "auth", http: 401 }, pay: { s: "pay", http: 402 }, error: { s: "error", p: "boom" },
  gone: { s: "gone", http: 404 }, timeout: { s: "timeout" }, ok: OK, empty: { s: "empty" },
};

test("probe-all: a provider that refuses or errors on EVERY row is still probed on every row, never skipped", async () => {
  const clock = fakeClock();
  const groups = new Map();
  for (const kind of ["auth", "pay", "error", "gone", "timeout"]) {
    // mixed: 10 free rows and 30 paid ones, so both the dead and the unfunded breaker would fire
    groups.set(kind, [
      ...Array.from({ length: 10 }, (_, i) => ({ key: `${kind}/f${i}`, provider: kind, id: `f${i}`, free: true, cost: 0, worst: 0 })),
      ...Array.from({ length: 30 }, (_, i) => ({ key: `${kind}/p${i}`, provider: kind, id: `p${i}`, free: false, cost: 0.001, worst: 0.002 })),
    ]);
  }
  const calls = {};
  const probe = async (t) => { await ticks(); calls[t.provider] = (calls[t.provider] ?? 0) + 1; return RESULT[t.provider]; };
  const { out, onResult } = collect();
  const sum = await runSweep({ groups, probe, onResult, probeAll: true, maxRowCost: 0.1, maxSpend: 5,
    maxRetries: { rate: 2, other: 0 }, now: clock.now, timers: clock.timers });
  for (const kind of groups.keys()) {
    assert.equal(calls[kind], 40, `${kind}: every row was actually sent`);
    assert.equal(out.filter((r) => r.provider === kind && r.s === kind).length, 40, `${kind}: every row recorded with its own result`);
  }
  assert.equal(out.filter((r) => r.s === "skip").length, 0);
  assert.equal(sum.counts.skip ?? 0, 0);
  assert.deepEqual(sum.dead, []); assert.deepEqual(sum.unfunded, []);
  assert.deepEqual(sum.skips, {});
});

test("probe-all: an erroring provider's rows are retried once and still never skipped", async () => {
  const clock = fakeClock();
  const rows = Array.from({ length: 25 }, (_, i) => ({ key: `e/m${i}`, provider: "e", id: `m${i}`, free: true, cost: 0, worst: 0 }));
  let calls = 0;
  const { out, onResult } = collect();
  await runSweep({ groups: group({ e: rows }), probe: async () => { await ticks(1); calls += 1; return RESULT.error; }, onResult,
    probeAll: true, coolAfter: 1000, now: clock.now, timers: clock.timers });
  assert.equal(calls, 50, "each row once plus its one retry");
  assert.equal(out.filter((r) => r.s === "skip").length, 0);
  assert.equal(out.length, 25);
});

test("without probeAll the breakers still fire (the normal path is unchanged)", async () => {
  const rows = mk("bad", 20);
  const { fn } = tracked(1, () => RESULT.auth);
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ bad: rows }), probe: fn, onResult, ...fast });
  assert.deepEqual(sum.dead, ["bad"]);
  assert.ok(out.some((r) => r.w === "provider-dead"));
  assert.deepEqual(sum.cooled, [], "cooling is a probe-all behaviour only");
});

test("probe-all: a cooled provider runs one at a time, spaced by the gap, and recovers on its next ok", async () => {
  const clock = fakeClock();
  const GAP = 400, AFTER = 3;
  const seq = ["auth", "auth", "gone", "pay", "error", "timeout", "auth", "auth"]; // then ok forever
  const bad = mk("bad", 30).map((t) => ({ ...t, worst: 0 }));
  const good = mk("good", 40).map((t) => ({ ...t, worst: 0 }));
  const bl = { calls: [], active: 0, decided: 0, streak: 0, okSeen: false, maxAfterOk: 0 };
  const gl = { active: 0, max: 0 };
  const probe = async (t) => {
    if (t.provider === "good") { gl.active += 1; gl.max = Math.max(gl.max, gl.active); await ticks(); gl.active -= 1; return OK; }
    bl.calls.push({ at: clock.now(), before: bl.active, streak: bl.streak });
    bl.active += 1; if (bl.okSeen) bl.maxAfterOk = Math.max(bl.maxAfterOk, bl.active);
    await ticks();
    bl.active -= 1;
    const kind = bl.decided < seq.length ? seq[bl.decided] : "ok";
    bl.decided += 1;
    if (kind === "ok") { bl.streak = 0; bl.okSeen = true; }
    else if (["auth", "pay", "error", "timeout"].includes(kind)) bl.streak += 1;
    return RESULT[kind];
  };
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ bad, good }), probe, onResult, probeAll: true,
    coolAfter: AFTER, coolGapMs: GAP, concurrency: 8, perProvider: 2, now: clock.now, timers: clock.timers });

  const cooled = bl.calls.map((c, i) => ({ ...c, prev: bl.calls[i - 1] })).filter((c) => c.streak >= AFTER);
  assert.ok(cooled.length >= 3, `${cooled.length} dispatches happened while cooled, so the test measured something`);
  for (const c of cooled) {
    assert.equal(c.before, 0, "a cooled provider never has two requests in flight");
    assert.ok(c.at - c.prev.at >= GAP, `dispatched ${c.at - c.prev.at} ms after the previous one, under the ${GAP} ms gap`);
  }
  assert.ok(bl.maxAfterOk >= 2, `after an ok the provider is back to concurrency 2 (saw ${bl.maxAfterOk})`);
  const afterOk = bl.calls.filter((c) => c.streak === 0 && bl.calls.indexOf(c) > 0);
  assert.ok(afterOk.some((c, i) => i > 0 && c.at - afterOk[i - 1].at < GAP), "and the gap is gone once it answers");

  assert.equal(out.filter((r) => r.provider === "bad").length, 30, "no bad row was skipped or lost");
  assert.equal(out.filter((r) => r.provider === "bad" && r.s === "skip").length, 0);
  assert.equal(out.filter((r) => r.provider === "good" && r.s === "ok").length, 40, "the healthy provider finished all its rows");
  assert.equal(gl.max, 2, "and ran at its full per-provider concurrency, unaffected by the cooling next door");
  assert.deepEqual(sum.cooled, ["bad"]);
});

test("probe-all: only auth/pay/error/timeout build the cool streak; gone, rate and empty neither add nor reset it", async () => {
  const run = async (seq) => {
    const clock = fakeClock();
    let i = 0;
    const { fn } = tracked(1, () => RESULT[seq[i++] ?? "ok"]);
    return runSweep({ groups: group({ p: mk("p", seq.length + 1) }), probe: fn, onResult: () => {}, probeAll: true,
      coolAfter: 3, coolGapMs: 5, concurrency: 1, perProvider: 1, maxRetries: { rate: 0, other: 0 }, now: clock.now, timers: clock.timers });
  };
  assert.deepEqual((await run(["auth", "auth", "gone", "auth"])).cooled, ["p"], "gone in the middle does not reset the run");
  assert.deepEqual((await run(["auth", "auth", "empty", "pay"])).cooled, ["p"], "nor does empty");
  assert.deepEqual((await run(["error", "timeout", "gone", "gone", "gone"])).cooled, [], "and gone does not add to it");
  assert.deepEqual((await run(["auth", "auth", "ok", "auth", "auth", "gone", "ok"])).cooled, [], "an ok resets the run");
});

test("probe-all: a cooled provider's gap is honoured with the real clock too (nothing is skipped, nothing hangs)", async () => {
  const rows = mk("slowbad", 6);
  const t0 = performance.now();
  const { fn } = tracked(1, () => RESULT.auth);
  const { out, onResult } = collect();
  await runSweep({ groups: group({ slowbad: rows }), probe: fn, onResult, probeAll: true, coolAfter: 2, coolGapMs: 30,
    concurrency: 4, perProvider: 2 });
  assert.equal(out.length, 6);
  assert.equal(out.filter((r) => r.s === "auth").length, 6);
  // rows 3..6 are dispatched while cooled: at least 4 gaps of 30 ms
  assert.ok(performance.now() - t0 >= 80, `finished in ${Math.round(performance.now() - t0)} ms`);
});

test("cooling exists only in probe-all: runSweep forces it off otherwise, whatever coolAfter says", async () => {
  const clock = fakeClock();
  let n = 0;
  const rows = mk("p", 14);
  const sum = await runSweep({ groups: group({ p: rows }), probe: async () => { await ticks(1); return n++ === 0 ? OK : RESULT.auth; },
    onResult: () => {}, coolAfter: 3, coolGapMs: 400, now: clock.now, timers: clock.timers, ...fast });
  assert.deepEqual(sum.cooled, []);
  assert.equal(clock.c.t, 1_000_000, "no gap timer fired");
});

test("probe-all: a cooled provider gets no second attempt at a failing row", async () => {
  const clock = fakeClock();
  let calls = 0;
  const { out, onResult } = collect();
  await runSweep({ groups: group({ e: mk("e", 25) }), probe: async () => { await ticks(1); calls += 1; return RESULT.error; },
    onResult, probeAll: true, coolAfter: 3, coolGapMs: 10, now: clock.now, timers: clock.timers });
  assert.equal(out.length, 25);
  assert.ok(calls >= 25 && calls <= 25 + 3, `${calls} attempts: retries only before the provider cooled`);
});

// ---------------------------------------------- billing from reported tokens

test("billedCost: charged from the tokens the provider reported, not from the typical-answer estimate", () => {
  const priced = { free: false, pin: 1, pout: 100, cost: (15 + 48 * 100) / 1e6, worst: (15 + 96 * 100) / 1e6 };
  assert.ok(Math.abs(billedCost(priced, { s: "ok", o: 96 }) - (15 + 96 * 100) / 1e6) < 1e-12, "a reasoning model that ran to the ceiling");
  assert.ok(Math.abs(billedCost(priced, { s: "ok", o: 12 }) - (15 + 12 * 100) / 1e6) < 1e-12);
  assert.equal(billedCost(priced, { s: "ok" }), priced.cost, "no usage reported: the typical figure");
  assert.equal(billedCost(priced, { s: "timeout" }), priced.worst, "a cut-off stream is charged its ceiling");
  assert.equal(billedCost(priced, { s: "auth" }), 0);
  assert.equal(billedCost(priced, { s: "pay" }), 0);
  assert.equal(billedCost(priced, { s: "gone" }), 0);
  assert.equal(billedCost(priced, { s: "rate" }), 0);
  assert.equal(billedCost(priced, { s: "error", d: 5 }), 0, "an error with no tokens is not billed");
  assert.ok(billedCost(priced, { s: "error", o: 30 }) > 0, "but a stream that failed AFTER tokens flowed is");
  assert.equal(billedCost({ ...priced, free: true }, { s: "ok", o: 96 }), 0);
  const un = { free: false, unpriced: true, cost: (15 * 0.6 + 48 * 3) / 1e6, worst: (15 * 0.6 + 384 * 3) / 1e6 };
  assert.ok(Math.abs(billedCost(un, { s: "ok", o: 96 }) - (15 * 0.6 + 96 * 3) / 1e6) < 1e-12, "an unpriced row is charged the documented price on the tokens seen");
  assert.ok(Math.abs(billedCost(un, { s: "ok", o: 7559 }) - 0.02269) < 1e-5, "a 7,559-token unpriced answer costs about $0.02, not a linear multiple of a flat guess");
  assert.ok(Math.abs(billedCost(un, { s: "ok", o: 384, x: 1 }) - (15 * 0.6 + 384 * 3) / 1e6) < 1e-12, "a cut stream is charged the allowance it reached");
  assert.equal(billedCost(un, { s: "timeout" }), un.worst, "a timeout is still charged its worst case");
  assert.equal(billedCost(un, { s: "ok" }), un.cost, "no usage reported: the typical estimate");
  assert.equal(billedCost({ free: false, cost: 0.004 }, { s: "ok", o: 5 }), 0.004, "a hand-built target is charged its cost");
});

test("buildTargets carries the prices and the unpriced flag the sweep bills from", () => {
  const snap = { rows: [{ provider: "p", models: [
    { id: "cheap", ctx: 1, pin: 1, pout: 4, badge: "PAID", outputKind: "text", routable: true },
    { id: "who-knows", ctx: 1, badge: "PAID", outputKind: "text", routable: true }] }] };
  const list = buildTargets(snap, { maxTokens: 96 }).get("p"); const a = list.find((t) => t.id === "cheap"), b = list.find((t) => t.id === "who-knows");
  assert.deepEqual([a.pin, a.pout, a.unpriced, a.maxTokens], [1, 4, undefined, 96]);
  assert.deepEqual([b.pin, b.unpriced], [undefined, true]);
});

test("spend: BILLED cost recomputed from the reported tokens stays within the cap, where the estimate alone would not", async () => {
  // pout $100/M: the expected cost assumes 48 tokens ($0.0048) but every probe answers with 96.
  const cap = 0.1;
  const groups = new Map();
  for (const p of ["a", "b", "c"]) {
    groups.set(p, Array.from({ length: 30 }, (_, i) => ({
      key: `${p}/r${i}`, provider: p, id: `r${i}`, free: false, pin: 1, pout: 100,
      cost: (15 + 48 * 100) / 1e6, worst: (15 + 96 * 100) / 1e6, maxTokens: 96 })));
  }
  const reported = { s: "ok", t: 1, d: 2, o: 96, p: "hi", k: 0 };
  const { fn } = tracked(2, () => reported);
  const { out, onResult } = collect();
  const sum = await runSweep({ groups, probe: fn, onResult, maxSpend: cap, maxRowCost: 0.1, concurrency: 8, perProvider: 3, ...fast });
  // Independent of the engine: price every recorded answer from ITS OWN reported tokens.
  const billed = out.filter((r) => r.s === "ok").reduce((s, r) => s + (15 * 1 + r.o * 100) / 1e6, 0);
  const largestWorst = (15 + 96 * 100) / 1e6;
  assert.ok(billed <= cap + largestWorst, `billed ${billed} against a ${cap} cap`);
  assert.ok(billed <= cap + 1e-9, "in fact the worst-case reservation holds it under the cap");
  assert.ok(Math.abs(sum.spent - billed) < 1e-4, `the engine's own figure ${sum.spent} matches ${billed}`);
  const okRows = out.filter((r) => r.s === "ok").length;
  assert.ok(okRows <= Math.floor(cap / largestWorst) + 1 && okRows >= 8, `${okRows} rows answered`);
  assert.ok(okRows * (15 + 48 * 100) / 1e6 < cap * 0.6, "an estimate-only gate would have admitted about twice as many");
  assert.ok((sum.skips["spend-cap"] ?? 0) > 0);
});

test("spend: a row that fits only until in-flight reservations release WAITS, and is not recorded as spend-cap", async () => {
  // Two paid rows at 0.006 against a 0.01 cap, on two providers so both could start at once.
  // Each fits alone; together they do not. The first FAILS unbilled (402), which frees the
  // reservation, so the second must be probed, not skipped.
  const row = (p) => ({ key: `${p}/r`, provider: p, id: "r", free: false, cost: 0.006, worst: 0.006 });
  const { fn, st } = tracked(6, (t) => (t.provider === "a" ? RESULT.pay : OK));
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ a: [row("a")], b: [row("b")] }), probe: fn, onResult, maxSpend: 0.01, maxRowCost: 0.1, ...fast });
  assert.equal(st.calls.length, 2, "both rows were probed");
  assert.equal(out.filter((r) => r.w === "spend-cap").length, 0);
  assert.equal(out.find((r) => r.key === "b/r").s, "ok");
  assert.deepEqual(sum.skips, {});
  // ...and when the first DOES bill, the second is skipped because spent alone no longer fits.
  const both = tracked(6);
  const o2 = collect();
  const s2 = await runSweep({ groups: group({ a: [row("a")], b: [row("b")] }), probe: both.fn, onResult: o2.onResult, maxSpend: 0.01, maxRowCost: 0.1, ...fast });
  assert.equal(both.st.calls.length, 1);
  assert.equal(s2.skips["spend-cap"], 1);
});

// ------------------------------------------------------------ wall clock

test("maxMs stops dispatching like an abort: resumable, in-flight finish, the rest is not recorded", async () => {
  const { fn, st } = tracked(6);
  const { out, onResult } = collect();
  const t0 = performance.now();
  const sum = await runSweep({ groups: group({ a: mk("a", 200) }), probe: fn, onResult, concurrency: 1, perProvider: 1, maxMs: 80, ...fast });
  assert.equal(sum.stopped, "time"); assert.equal(sum.aborted, true);
  assert.ok(out.length > 0 && out.length < 200, `${out.length} recorded`);
  assert.equal(out.filter((r) => r.s === "skip").length, 0, "the unreached rows are left for a resume, not recorded");
  assert.equal(st.active, 0);
  assert.ok(performance.now() - t0 < 1500);
});

test("a provider that answers 429 to everything cannot pin the run past maxMs", async () => {
  const { fn } = tracked(1, () => ({ s: "rate", http: 429, ra: 40 }));
  const { out, onResult } = collect();
  const t0 = performance.now();
  const sum = await runSweep({ groups: group({ slow: mk("slow", 100) }), probe: fn, onResult, maxMs: 150, backoffBaseMs: 40, backoffMaxMs: 40 });
  assert.equal(sum.stopped, "time");
  assert.ok(out.length < 100, `${out.length} of 100 recorded`);
  assert.ok(performance.now() - t0 < 1500, `stopped after ${Math.round(performance.now() - t0)} ms, not the ~12 s it would take`);
});

// ------------------------------------------------------------ outage breaker

/** A gateway that is up until `fail()`; the probe answers ok while up and `error` while down. */
function gatewayWorld(clock, { checksUntilUp = 4 } = {}) {
  const gw = { up: true, checks: 0, downChecks: 0 };
  const probe = async (t) => {
    await ticks(2);
    return gw.up ? OK : { s: "error", http: 502, p: "bad gateway" };
  };
  const gatewayCheck = async () => {
    gw.checks += 1;
    if (!gw.up) { gw.downChecks += 1; if (checksUntilUp && gw.downChecks >= checksUntilUp) gw.up = true; }
    return gw.up;
  };
  return { gw, probe, gatewayCheck };
}

test("outage: a dead gateway is detected, dispatch pauses and polls, the hit rows are re-probed and NOT recorded as errors", async () => {
  const clock = fakeClock();
  const groups = new Map(["a", "b", "c"].map((p) => [p, mk(p, 30)]));
  const { gw, probe, gatewayCheck } = gatewayWorld(clock, { checksUntilUp: 4 });
  let answered = 0;
  const { out, onResult } = collect();
  const wrapped = async (t) => { const r = await probe(t); if (r.s === "ok" && ++answered === 6) gw.up = false; return r; };
  const t0 = clock.c.t;
  const sum = await runSweep({ groups, probe: wrapped, onResult, gatewayCheck, outageAfter: 10, outagePollMs: 10000, outageWaitMs: 600000,
    maxRetries: { rate: 2, other: 0 }, now: clock.now, timers: clock.timers, ...fast });
  assert.equal(sum.outage.events, 1, "one outage");
  assert.ok(sum.outage.requeued >= 10, `${sum.outage.requeued} rows put back`);
  assert.equal(out.filter((r) => r.s === "error").length, 0, "no error record was written for a failure the gateway caused");
  assert.equal(out.length, 90, "every row is recorded exactly once, and each as ok");
  assert.equal(new Set(out.map((r) => r.key)).size, 90);
  assert.ok(out.every((r) => r.s === "ok"));
  assert.ok(gw.checks >= 4, `${gw.checks} health checks: the first, then polls until it answered`);
  assert.ok(clock.c.t - t0 >= 30000, `the poll interval was honoured on the clock (${clock.c.t - t0} ms)`);
  assert.equal(sum.stopped, null); assert.equal(sum.aborted, false);
  assert.ok(sum.probes > 90, "the affected rows cost extra probes");
});

test("outage: nothing is dispatched while the gateway is down", async () => {
  const clock = fakeClock();
  const { gw, probe, gatewayCheck } = gatewayWorld(clock, { checksUntilUp: 5 });
  let confirmedAt = null, resumedAt = null, paused = false, during = 0;
  const check = async () => {
    const r = await gatewayCheck();
    if (!r && confirmedAt === null) confirmedAt = clock.now();
    if (!r) paused = true;
    if (r && paused) { paused = false; resumedAt = clock.now(); }
    return r;
  };
  let answered = 0;
  const wrapped = async (t) => { if (paused) during += 1; const r = await probe(t); if (r.s === "ok" && ++answered === 4) gw.up = false; return r; };
  const groups = new Map(["a", "b"].map((p) => [p, mk(p, 20)]));
  const { out, onResult } = collect();
  await runSweep({ groups, probe: wrapped, onResult, gatewayCheck: check, outageAfter: 6, outagePollMs: 10000,
    maxRetries: { rate: 2, other: 0 }, now: clock.now, timers: clock.timers, ...fast });
  assert.equal(out.length, 40);
  assert.ok(confirmedAt !== null && resumedAt !== null && resumedAt - confirmedAt >= 40000, "the outage lasted five polls on the fake clock");
  assert.equal(during, 0, `${during} probes were dispatched between confirmation and recovery`);
});

test("outage: a gateway that stays down past the wait limit stops the run like an abort, recording nothing false", async () => {
  const clock = fakeClock();
  const { gw, probe, gatewayCheck } = gatewayWorld(clock, { checksUntilUp: 0 });   // never comes back
  let answered = 0;
  const wrapped = async (t) => { const r = await probe(t); if (r.s === "ok" && ++answered === 5) gw.up = false; return r; };
  const groups = new Map(["a", "b", "c"].map((p) => [p, mk(p, 30)]));
  const { out, onResult } = collect();
  const t0 = clock.c.t;
  const sum = await runSweep({ groups, probe: wrapped, onResult, gatewayCheck, outageAfter: 8, outagePollMs: 10000, outageWaitMs: 60000,
    maxRetries: { rate: 2, other: 0 }, now: clock.now, timers: clock.timers, ...fast });
  assert.equal(sum.stopped, "outage"); assert.equal(sum.aborted, true);
  assert.equal(sum.outage.gaveUp, true);
  assert.equal(out.filter((r) => r.s !== "ok").length, 0, "only real answers were recorded");
  assert.equal(out.length, 5, "the five answers from before the gateway died");
  assert.ok(out.length < 90, "the rest is left for a resume");
  assert.ok(clock.c.t - t0 >= 60000, "it waited the full limit first");
  assert.ok(gw.checks >= 7, `${gw.checks} checks over the 60 s wait`);
});

test("outage: a health check that says UP releases the held results as ordinary records (a provider that really fails is not hidden)", async () => {
  const clock = fakeClock();
  const { out, onResult } = collect();
  let checks = 0;
  const sum = await runSweep({ groups: group({ bad: mk("bad", 12) }), probe: async () => { await ticks(1); return RESULT.auth; }, onResult,
    gatewayCheck: async () => { checks += 1; return true; }, outageAfter: 5, probeAll: true, coolAfter: 1000,
    now: clock.now, timers: clock.timers });
  assert.ok(checks >= 1);
  assert.equal(sum.outage.events, 0);
  assert.equal(out.filter((r) => r.s === "auth").length, 12, "every refusal was recorded");
});

test("outage: without a gatewayCheck nothing is held or re-queued (the breaker is off)", async () => {
  const { fn } = tracked(1, () => RESULT.error);
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: mk("p", 40) }), probe: fn, onResult, probeAll: true, coolAfter: 1000, outageAfter: 3, ...fast });
  assert.equal(out.length, 40); assert.equal(sum.outage.events, 0);
});

// ------------------------------------------------------- a stalled stream

test("probeOne: a stream whose cancel() never settles does not hold the slot", { timeout: 4000 }, async () => {
  const enc = new TextEncoder();
  const chunks = [delta({ type: "text_delta", text: "hello" }), usage(3), stop()].map((c) => enc.encode(c));
  let i = 0;
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
                                cancel: () => new Promise(() => {}) }) },
  });
  const t0 = performance.now();
  const r = await probeOne({ fetchImpl, url: "http://gw/v1/messages", key: "k", model: "p/m", cancelMs: 30 });
  assert.equal(r.s, "ok");
  assert.ok(performance.now() - t0 < 1500, `took ${Math.round(performance.now() - t0)} ms`);
});

// ------------------------------------------- loose wording must not condemn a working model

test("a transient provider fault that merely uses gone-ish words stays `error` at 5xx (and at 400 unless it is about the model)", () => {
  const cases = [
    [500, "Failed to load model: file not found on worker gpu-3"],
    [502, "model was retired from pool, retrying"],
    [500, "Model temporarily unavailable, was removed from rotation"],
    [500, "model not found in KV cache"],
    [500, "Could not find the requested model replica; retry"],
    [500, "we are decommissioning capacity in region"],
    [400, "invalid model parameter 'temperature'"],
    [400, "unsupported model type for embeddings"],
    [400, "invalid model type"],
    [500, "invalid model parameter x"],
    [500, "The model parameter 'foo' does not exist"],
    [503, "model deprecated_param is not supported for streaming"],
  ];
  for (const [status, msg] of cases) {
    for (const wrap of [(m) => m, (m) => JSON.stringify({ error: { message: m } })]) {
      assert.equal(classifyHttp(status, wrap(msg)), "error", `${status}: ${msg}`);
    }
  }
});

test("the strong anchors keep their `gone` at 5xx, and a named-model rule needs a real name", () => {
  for (const [status, msg] of [[500, "The model gpt-x does not exist"], [500, "model_not_found"], [502, "no such model: abc"], [500, "unknown model gpt-9"],
                               [400, "Invalid model: mistral-foo"], [500, "Unsupported model `qwen-vl-max-2025-01-25`"]]) {
    assert.equal(classifyHttp(status, msg), "gone", `${status}: ${msg}`);
  }
  assert.equal(classifyHttp(500, JSON.stringify({ error: { code: "model_not_found", message: "x" } })), "gone", "the machine code counts");
  assert.equal(classifyHttp(400, JSON.stringify({ error: { code: "model_decommissioned", message: "x" } })), "gone");
  assert.equal(classifyHttp(500, "model not exist"), "gone");
});

test("regression on the study's 1,138 real `gone` messages: tightening the 5xx rules costs none of them at 404, 400 or 422", async (t) => {
  const { default: fs } = await import("node:fs");
  const { default: path } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const csv = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plans", "bench-study", "models.csv");
  if (!fs.existsSync(csv)) return t.skip("no study data in this checkout");
  const { parseCsv } = await import("../plans/bench-study/scripts/make-lists.mjs");
  const gone = parseCsv(fs.readFileSync(csv, "utf8")).filter((r) => r.status === "gone" && r.message);
  assert.equal(gone.length, 1138);
  // Baselines measured with the rules BEFORE the tightening (the study's records were classified by them):
  // 404 files all 1,138 as gone by status; the message alone files 678 at a 400/422 (the other 460 are
  // opaque "No endpoints ..." / "Upstream request failed." sentences that only a 404 made `gone`).
  assert.equal(gone.filter((r) => classifyHttp(404, r.message) === "gone").length, 1138);
  for (const status of [400, 422]) assert.equal(gone.filter((r) => classifyHttp(status, r.message) === "gone").length, 678, `at ${status}`);
  // At a 5xx only the strong anchors hold. The study did not record statuses, so this is the worst case:
  // 28 of the 678 (aihubmix "model X is not supported", zenmux "Requested model is not valid", and a few
  // "was removed" wordings) would be a transient `error` had their provider answered with a 5xx.
  const at500 = gone.filter((r) => classifyHttp(500, r.message) === "gone").length;
  assert.equal(at500, 650);
});

// ------------------------------------------ pay / plan rules and their statuses

test("'insufficient permissions' is an authorisation failure (`auth`), never an empty account (`pay`)", () => {
  for (const status of [400, 403, 422, 500]) {
    assert.equal(classifyHttp(status, JSON.stringify({ error: { message: "Insufficient permissions to use this model" } })), "auth", `${status}`);
  }
  assert.equal(classifyHttp(403, "insufficient scope"), "auth");
  assert.equal(classifyHttp(400, "Insufficient balance"), "pay", "and an empty balance is still pay");
});

test("a 5xx that only MENTIONS billing, quota, payment or a purchase is a transient `error`, not a final `pay`", () => {
  for (const [status, msg] of [[500, "billing service unavailable"], [503, "payment gateway timeout, try again"], [500, "quota service unreachable"],
                               [502, "purchase lookup failed"], [500, "deposit ledger locked"], [500, "recharge worker crashed"]]) {
    assert.equal(classifyHttp(status, msg), "error", `${status}: ${msg}`);
  }
  // the words about an EMPTY account still count at a 5xx, and every 4xx keeps the old reading
  assert.equal(classifyHttp(500, "Insufficient Balance"), "pay");
  assert.equal(classifyHttp(500, "please top up your account"), "pay");
  for (const s of [400, 403]) assert.equal(classifyHttp(s, "model_requires_purchase: x is locked on your account until you make a purchase"), "pay", `${s}`);
  assert.equal(classifyHttp(402, "quota"), "pay");
});

test("a 404 that names the plan is `pay`; a 404 that only says 'upgrade to' is still `gone`", () => {
  assert.equal(classifyHttp(404, "Model xyz not found in your plan, upgrade to use it"), "pay");
  assert.equal(classifyHttp(404, "The model `x` is not available under your current subscription"), "pay");
  assert.equal(classifyHttp(404, "This model is deprecated, upgrade to gpt-5"), "gone");
  assert.equal(classifyHttp(404, "not found"), "gone");
});

test("a timeout is never retried (it already waited the whole deadline); an error still is, once", async () => {
  const tries = {};
  const rowsT = mk("t", 4), rowsE = mk("e", 4);
  const { fn, st } = tracked(1, (t) => { tries[t.key] = (tries[t.key] ?? 0) + 1; return t.provider === "t" ? { s: "timeout", d: 240000 } : { s: "error", p: "boom" }; });
  const { out, onResult } = collect();
  await runSweep({ groups: group({ t: rowsT, e: rowsE }), probe: fn, onResult, probeAll: true, coolAfter: 1000, maxRetries: { rate: 2, other: 1 }, ...fast });
  assert.equal(rowsT.every((r) => tries[r.key] === 1), true, "one wait per timed-out row");
  assert.equal(rowsE.every((r) => tries[r.key] === 2), true, "an error gets its one retry");
  assert.equal(out.filter((r) => r.s === "timeout").length, 4);
  assert.equal(st.calls.length, 12);
});

// -------------------------------- a 200 stream that is really an error notice (false `ok`)

const realOkPreviews = () => {
  const f = new URL("./fixtures/real-ok-previews.txt", import.meta.url);
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
};

test("looksLikeNotice: the pollinations sentence is an account notice; credit, quota and plain-error notices map to pay / error", () => {
  assert.equal(looksLikeNotice("The account behind this API key doesn't have access to this model."), "auth");
  assert.equal(looksLikeNotice("The account behind this API key doesn't "), "auth", "the 40-character preview alone is enough");
  for (const s of ["Invalid API key provided", "Your API key has expired", "Unauthorized", "Authentication failed: bad token", "Please sign in to continue",
                   "This API key is not valid for that model"]) assert.equal(looksLikeNotice(s), "auth", s);
  for (const s of ["Insufficient credits. Please top up.", "You have run out of credits", "You have exceeded your quota", "Quota exceeded for today",
                   "No credits remaining", "Please subscribe to use this model"]) assert.equal(looksLikeNotice(s), "pay", s);
  for (const s of ["Error: upstream request failed", "An error occurred while processing your request", "Service unavailable", "Internal server error",
                   "Something went wrong.", "Failed to generate a response"]) assert.equal(looksLikeNotice(s), "error", s);
});

test("looksLikeNotice: the extended START-ANCHORED wordings, each mapped to its status", () => {
  const want = {
    auth: ["API key required", "An API key is required", "API key is missing", "Not authorized", "You are not authorized to use this model", "Login required", "Sign in required",
           "Sign in to continue", "Access forbidden", "Access denied for this key"],
    pay: ["Free tier limit reached", "Free tier limit exceeded", "Your free trial has ended", "Credits exhausted", "Not enough credits", "Payment required", "Daily quota exceeded",
          "Monthly limit reached", "Your free plan has expired", "Balance depleted"],
    rate: ["Rate limited", "Rate limit reached, try later", "Too many requests", "Too many requests, slow down"],
    gone: ["Model not found", "The model does not exist", "Model x is not available"],
    error: ["Service temporarily unavailable", "Service unavailable", "Sorry, an error occurred", "Sorry an error has occurred", "Something went wrong"],
  };
  for (const [status, list] of Object.entries(want)) for (const s of list) assert.equal(looksLikeNotice(s), status, `${JSON.stringify(s)} -> ${status}`);
});

test("looksLikeNotice: any text that says hello is never a notice (the guard), and contrived hello sentences keep their `ok`", () => {
  for (const s of ["Your account says hello", "Error handling? Hello!", "Token hello for you", "Sign in to say hello", "Unauthorized greetings: hello there",
                   "The API key is: hello world", "Insufficient credits to say hello", "Rate limited hello", "Model not found, hello", "Service unavailable hello to you",
                   "API key required to say hello", "Free tier hello reached", "Not authorized to hello", "Payment required hello", "HELLO, account holder"]) {
    assert.equal(looksLikeNotice(s), null, s);
  }
});

test("looksLikeNotice: non-English wordings are NOT guessed at", () => {
  for (const s of ["Clave API requerida", "Zu viele Anfragen", "Modèle introuvable", "APIキーが必要です", "请提供 API 密钥", "Nicht autorisiert"]) assert.equal(looksLikeNotice(s), null, s);
});

test("looksLikeNotice: nothing that can answer 'Say hello in 5 words.' is a notice", () => {
  for (const s of ["Hello, how are you today?", "Hello! Your account is welcome here", "Hi there, nice to meet you", "Hey! The account is fine", "Greetings, friend of mine, welcome",
                   "The user wants me to say hello in exactly five words", "Here you go: Hello, how are you?", "Sure! Hello there, how are you?", "Okay, let me think about this",
                   "I'm sorry, I can't do that", "As an AI, I say: hello there my friend", "**Hello** there, friend", "\"Hello, how are you today?\"", ""]) {
    assert.equal(looksLikeNotice(s), null, s);
  }
  assert.equal(looksLikeNotice("Error: ".padEnd(700, "x")), null, "a long text is never a notice");
  assert.equal(looksLikeNotice(null), null);
});

test("looksLikeNotice: NONE of the 534 distinct genuine previews recorded in the real bench.json changes", () => {
  const previews = realOkPreviews();
  assert.ok(previews.length > 500, `${previews.length} previews`);
  const hits = previews.filter((p) => looksLikeNotice(p));
  assert.deepEqual(hits, [], `would have been reclassified: ${hits.slice(0, 5).join(" | ")}`);
});

test("probeOne: a 200 stream whose whole text is an account notice becomes `auth`, with the sentence in `m`", async () => {
  const r = await probe([
    { at: 10, chunk: ev("message_start", { message: {} }) },
    { at: 900, chunk: textDelta("The account behind this API key doesn't have access to this model.") },
    { at: 950, chunk: usage(0) + stop() },
  ]);
  assert.equal(r.s, "auth"); assert.equal(r.http, 200);
  assert.match(r.m, /HTTP 200 stream carried a notice, not an answer: The account behind this API key doesn't have access/);
  assert.equal("t" in r, false, "a notice has no time to first token");
  const pay = await probe([{ at: 5, chunk: textDelta("Insufficient credits. Please top up your balance.") }, { at: 9, chunk: stop() }]);
  assert.equal(pay.s, "pay");
  const err = await probe([{ at: 5, chunk: textDelta("Error: the upstream service is unavailable") }, { at: 9, chunk: stop() }]);
  assert.equal(err.s, "error");
});

test("probeOne: a genuine greeting, a long text, and a thinking-only stream stay `ok`", async () => {
  const hello = await probe([{ at: 500, chunk: textDelta("Hello, how are you today?") }, { at: 600, chunk: usage(8) + stop() }]);
  assert.equal(hello.s, "ok");
  const long = await probe([{ at: 500, chunk: textDelta("Error handling in Go " + "is done with explicit returns. ".repeat(30)) }, { at: 600, chunk: usage(200) + stop() }]);
  assert.equal(long.s, "ok");
  const think = await probe([{ at: 300, chunk: thinkDelta("Error: I should say hello") }, { at: 400, chunk: usage(20) + stop() }]);
  assert.equal(think.s, "ok"); assert.equal(think.k, 1);
});

test("a notice is a real refusal for the scheduler: it counts toward cooling like any auth result", async () => {
  const clock = fakeClock();
  const { out, onResult } = collect();
  const sum = await runSweep({ groups: group({ p: mk("p", 14) }), onResult, probeAll: true, coolAfter: 3, coolGapMs: 5, now: clock.now, timers: clock.timers,
    probe: async () => ({ s: "auth", http: 200, m: "HTTP 200 stream carried a notice, not an answer: x" }) });
  assert.equal(out.length, 14); assert.deepEqual(sum.cooled, ["p"]);
});

// ------------------------------------------ a stream that ignores max_tokens is cut

/** An endless SSE stream: `n` chars per delta every `every` ms of the injected clock; `cancel` is spied. */
function endlessStream({ chars = 40, every = 100, first = 500, usageAt = null, ch = "x" } = {}) {
  const clock = { t: 0 }, spy = { cancels: 0, reads: 0 };
  let i = 0;
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    body: { getReader: () => ({
      read: async () => {
        spy.reads += 1;
        if (spy.reads > 3000) return { done: true, value: undefined };     // "endless" for the test's purposes, but a missing cut fails instead of hanging
        clock.t = first + i * every;
        const chunk = i === 0 ? ev("message_start", { message: {} }) + textDelta((ch === "x" ? "x" : ch).repeat(chars)) : textDelta((ch === "x" ? "y" : ch).repeat(chars)) + (usageAt === i ? usage(1000) : "");
        i += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      cancel: async () => { spy.cancels += 1; },
    }) },
  });
  return { fetchImpl, now: () => clock.t, clock, spy };
}

test("probeOne: a stream past the allowance (4 x max_tokens) is cut, recorded as ok with x:1, and the request is cancelled", async () => {
  assert.equal(STREAM_CUT_FACTOR, 4);
  const s = endlessStream({ chars: 40, every: 100 });       // 10 tokens per 100 ms, forever
  const r = await probeOne({ fetchImpl: s.fetchImpl, now: s.now, url: "u", key: "k", model: "p/m", maxTokens: 96 });
  assert.equal(r.s, "ok"); assert.equal(r.x, 1);
  assert.ok(r.o >= 384 && r.o <= 384 + 10, `o = ${r.o}: the allowance, not the thousands it would have streamed`);
  assert.equal(r.t, 500, "TTFT is the first content delta");
  assert.ok(r.d >= 500 && r.d < 500 + 100 * 45, `d = ${r.d} (up to the cut, not to the end of an endless stream)`);
  assert.ok(Number.isFinite(r.r) && r.r > 50 && r.r < 200, `throughput ${r.r} tok/s over the window before the cut (~100 tok/s)`);
  assert.equal(r.p.startsWith("xxxx"), true);
  assert.equal(s.spy.cancels, 1, "the body reader was cancelled");
  assert.ok(s.spy.reads < 60, `${s.spy.reads} reads: it stopped reading`);
});

test("probeOne: the cut can be off (0) or moved (an explicit allowance), and a normal answer is untouched", async () => {
  const normal = await probe([{ at: 500, chunk: textDelta("Hello, how are you today?") }, { at: 600, chunk: usage(8) + stop() }]);
  assert.equal(normal.s, "ok"); assert.equal("x" in normal, false, "an answer under the allowance carries no marker");
  const big = await probe([{ at: 500, chunk: textDelta("z".repeat(3000)) }, { at: 600, chunk: usage(750) + stop() }], { probe: { cutAt: 0 } });
  assert.equal(big.s, "ok"); assert.equal("x" in big, false, "cut off: the whole answer is read");
  assert.equal(big.o, 750, "and o stays the provider's own count");
  const moved = await probe([{ at: 500, chunk: textDelta("z".repeat(3000)) }, { at: 600, chunk: usage(750) + stop() }], { probe: { cutAt: 100 } });
  assert.equal(moved.x, 1);
});

test("probeOne: the provider's own count, when it arrives mid-stream, can trigger the cut; a stream that has shown NOTHING is never cut", async () => {
  const s = endlessStream({ chars: 8, every: 50, usageAt: 3 });     // usage says 1000 tokens after only ~32 chars
  const r = await probeOne({ fetchImpl: s.fetchImpl, now: s.now, url: "u", key: "k", model: "p/m", maxTokens: 96 });
  assert.equal(r.x, 1); assert.equal(r.o, 1000, "the provider's count wins when it is larger");
  // no content delta yet: however large the reported count, nothing is cut and `empty` semantics are unchanged
  const empty = await probe([{ at: 10, chunk: ev("message_delta", { delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 5000 } }) + stop() }]);
  assert.equal(empty.s, "empty"); assert.equal("x" in empty, false);
});

test("the cut's token estimate counts a CJK, kana or Hangul character as about one token (chars/4 alone under-counts them 4x)", async () => {
  const s = endlessStream({ chars: 40, every: 100, ch: "汉" });     // 40 CJK characters per delta = ~40 tokens per 100 ms
  const r = await probeOne({ fetchImpl: s.fetchImpl, now: s.now, url: "u", key: "k", model: "p/m", maxTokens: 96 });
  assert.equal(r.x, 1);
  assert.ok(s.spy.reads <= 12, `${s.spy.reads} reads: the cut came after ~10 deltas (400 CJK characters), not the ~39 that chars/4 would have needed`);
  assert.ok(r.o >= 384 && r.o <= 440, `o = ${r.o}, about the true token count at the cut, not a quarter of it`);
  assert.ok(r.r > 300 && r.r < 500, `${r.r} tok/s (~400 tokens over ~0.9 s), not ~4x too low`);
  for (const ch of ["あ", "ア", "한"]) {
    const t = endlessStream({ chars: 40, every: 100, ch });
    const x = await probeOne({ fetchImpl: t.fetchImpl, now: t.now, url: "u", key: "k", model: "p/m", maxTokens: 96 });
    assert.ok(x.x === 1 && t.spy.reads <= 12, `${ch}: ${t.spy.reads} reads`);
  }
  const mixed = endlessStream({ chars: 40, every: 100, ch: "a" });                 // ordinary text still needs ~4 chars per token
  await probeOne({ fetchImpl: mixed.fetchImpl, now: mixed.now, url: "u", key: "k", model: "p/m", maxTokens: 96 });
  assert.ok(mixed.spy.reads > 30, `${mixed.spy.reads} reads for ASCII`);
});

test("an `error` event AFTER content is not swallowed: the row stays ok (its TTFT and preview are real) with the failure in `m`", async () => {
  const r = await probe([
    { at: 10, chunk: ev("message_start", { message: {} }) },
    { at: 800, chunk: textDelta("Hello there, my") },
    { at: 900, chunk: ev("error", { error: { message: "upstream exploded" } }) },
    { at: 950, chunk: stop() },
  ]);
  assert.equal(r.s, "ok"); assert.equal(r.t, 800); assert.match(r.p, /Hello there/);
  assert.equal(r.m, "stream error after first token: upstream exploded");
  assert.equal("m" in (await probe([{ at: 800, chunk: textDelta("Hello there") }, { at: 900, chunk: usage(8) + stop() }])), false, "a clean ok carries no message");
  // the message survives the store and the loader, so the picker can show it
  const stored = toStored({ ...r, a: 5 });
  assert.equal(stored.m, r.m, "an ok record keeps its m");
  assert.equal(cleanRecord({ ...stored }).m, r.m);
  const empty = await probe([{ at: 30, chunk: ev("error", { error: { message: "upstream exploded" } }) }]);
  assert.equal(empty.s, "error", "an error BEFORE any content is still an error");
});

test("loadBench exposes the cut marker `x` (and an ok record's message) to readers", async () => {
  const { loadBench } = await import("../menu/bench-data.mjs");
  const os = await import("node:os"); const path = await import("node:path");
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uw-x-")), "bench.json");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, generatedAt: "x", models: {
    "a/cut": { s: "ok", t: 500, d: 4500, r: 95, o: 390, a: 1, p: "xxxx", x: 1 },
    "a/err": { s: "ok", t: 500, d: 900, a: 1, p: "Hello there", m: "stream error after first token: boom" },
    "a/plain": { s: "ok", t: 500, d: 900, a: 1, p: "Hello there" } } }));
  const b = loadBench(f);
  assert.equal(b.get("a/cut").x, 1);
  assert.equal(b.get("a/err").m, "stream error after first token: boom");
  assert.equal("x" in b.get("a/plain"), false); assert.equal("m" in b.get("a/plain"), false);
});

test("a cut record is an ordinary ok for the merge rules and the store", () => {
  const cut = { s: "ok", t: 500, d: 4500, r: 95, o: 390, a: 1790000000, p: "xxxxxxxx", x: 1 };
  assert.equal(toStored(cut).x, 1);
  assert.equal(cleanRecord(cut).x, 1); assert.equal("x" in cleanRecord({ ...cut, x: 2 }), false, "only 1 is a valid marker");
  assert.equal("x" in cleanRecord({ s: "ok", a: 1 }), false);
  const opts = { ttlMs: 7 * 864e5, nowMs: 1790000100 * 1000 };
  assert.equal(mergeRecord(cut, { s: "error", a: 1790000090 }, opts), cut, "a newer transient result does not replace it");
  const newer = { s: "ok", t: 400, a: 1790000090, o: 10 };
  assert.equal(mergeRecord(cut, newer, opts), newer);
  assert.equal(isFresh(cut, opts), true);
});

test("spend: a cut stream is charged the allowance it reached, and the cap holds with the cut's bound", async () => {
  // 40 unpriced rows: each probe streams 'forever' but is cut at 384 tokens; the row's reservation is the allowance
  const worst = worstCost({ pin: undefined }, 384);
  const groups = new Map([["u", Array.from({ length: 40 }, (_, i) => ({ key: `u/r${i}`, provider: "u", id: `r${i}`, free: false, unpriced: true,
    cost: estimateCost({}), worst }))]]);
  const cutOk = { s: "ok", t: 500, d: 4500, r: 95, o: 390, p: "x", k: 0, x: 1 };
  const { fn } = tracked(1, () => cutOk);
  const { out, onResult } = collect();
  const sum = await runSweep({ groups, probe: fn, onResult, maxSpend: 0.02, maxRowCost: 0.1, ...fast });
  const each = (15 * 0.6 + 390 * 3) / 1e6;
  assert.ok(sum.spent <= 0.02 + 1e-9, `spent ${sum.spent}`);
  assert.ok(sum.spent > 0.015 && sum.spent <= 0.02, `the cap bound the run: spent ${sum.spent} of 0.02 (each probe ${each})`);
  assert.ok(out.filter((r) => r.s === "ok").length >= 10 && out.some((r) => r.w === "spend-cap"));
});

// ------------------------------- the real cluster messages: nothing real changes class by accident

test("regression on the study's real pay / auth / rate messages: the tightened rules change only the intended rows", async (t) => {
  const csv = new URL("../plans/bench-study/models.csv", import.meta.url);
  if (!fs.existsSync(csv)) return t.skip("no study data in this checkout");
  const { parseCsv } = await import("../plans/bench-study/scripts/make-lists.mjs");
  const rows = parseCsv(fs.readFileSync(csv, "utf8")).filter((r) => r.message);
  const cls = (list, st) => list.reduce((a, r) => { const k = classifyHttp(st, r.message); a[k] = (a[k] ?? 0) + 1; return a; }, {});
  const pay = rows.filter((r) => r.status === "pay"), auth = rows.filter((r) => r.status === "auth"), rate = rows.filter((r) => r.status === "rate");
  assert.equal(pay.length, 1972); assert.equal(auth.length, 88); assert.equal(rate.length, 72);
  assert.equal(cls(pay, 402).pay, 1972, "every real pay message is pay at the 402 it came with");
  assert.equal(cls(auth, 401).auth, 88); assert.equal(cls(auth, 403).auth, 88, "every real auth message is auth at 401/403");
  // rate: 49 stay rate; the 18 nararouter 'Insufficient credits' rows are pay and the 5 orcarouter account gates are auth (both intended)
  assert.deepEqual(cls(rate, 429), { rate: 49, pay: 18, auth: 5 });
  // a 5xx that merely mentions billing is no longer a final pay (worst case: counted)
  assert.equal(cls(pay, 500).pay, 968, "at a hypothetical 5xx only the words about an empty account still read as pay");
});

test("targets: within a provider's paid tier PRICED rows come first (cheapest first), UNPRICED rows last; free rows still lead", () => {
  const snap = { rows: [{ provider: "p", models: [
    M("u1"), M("cheap", { pin: 1, pout: 2 }), M("free1", { pin: 0, pout: 0 }), M("u2"), M("dear", { pin: 30, pout: 90 }), M("mid", { pin: 5, pout: 10 }),
    M("free2", { badge: "FREE?" }), M("text-moderation-x", { pin: 0.1, pout: 0.1 }) ] }] };
  const ids = buildTargets(snap).get("p").map((t) => t.id);
  assert.deepEqual(ids.slice(0, 2).sort(), ["free1", "free2"], "free rows first");
  assert.deepEqual(ids.slice(2, 5), ["cheap", "mid", "dear"], "priced, cheapest first");
  assert.deepEqual(ids.slice(5, 7), ["u1", "u2"], "unpriced after every priced chat row, in catalogue order");
  assert.equal(ids[7], "text-moderation-x", "an odd-looking id still goes to the very back");
  // an unpriced row, however cheap its assumed cost, never sorts ahead of a priced one
  const t = buildTargets(snap).get("p");
  const u = t.find((x) => x.id === "u1"), c = t.find((x) => x.id === "dear");
  assert.ok(u.cost < c.cost && t.indexOf(u) > t.indexOf(c));
});

// ------------------- a 5xx that names a model or a balance but describes the provider's own machinery

test("a 5xx sentence with a transient marker is never `gone` and never `pay`, however much it says about a model or a balance", () => {
  const gone500 = [
    [500, "model 'gpt-4o' was removed from the pool, retrying"],
    [500, "model `llama-3-70b` is deprecated in this region; retry on another node"],
    [502, "Model glm-4.6 not found in KV cache; reloading"],
    [500, "model shard 3 does not exist on worker gpu-7, retry"],
    [500, "Model qwen-max-1 not found on worker, retrying"],
    [500, "Unsupported model: streaming-1 is not enabled on this node"],
    [503, "The model gpt-x does not exist in this replica, try again"],
    [500, "model has been decommissioned from rotation"],
  ];
  const pay500 = [[500, "Insufficient GPU capacity"], [503, "insufficient capacity, try later"], [500, "balance check service unavailable"],
                  [502, "credits ledger temporarily unavailable"], [500, "Insufficient memory on this worker"]];
  for (const [status, msg] of [...gone500, ...pay500]) {
    for (const wrap of [(m) => m, (m) => JSON.stringify({ error: { message: m } })]) assert.equal(classifyHttp(status, wrap(msg)), "error", `${status}: ${msg}`);
  }
});

test("the same wordings WITHOUT a transient marker keep their class (the veto is narrow), and a machine code is never vetoed", () => {
  for (const [status, msg, want] of [
    [500, "The model gpt-x does not exist", "gone"], [500, "model 'command-r' was removed on September 15, 2025", "gone"],
    [500, "Insufficient Balance", "pay"], [500, "Insufficient credits", "pay"], [500, "insufficient_quota", "pay"], [402, "Insufficient account funds", "pay"],
    [400, "opencode: Upstream request failed: Insufficient account funds", "pay"], [400, "User's credit limit is insufficient", "pay"],
  ]) assert.equal(classifyHttp(status, msg), want, `${status}: ${msg}`);
  assert.equal(classifyHttp(500, JSON.stringify({ error: { code: "model_not_found", message: "model not found on worker, retrying" } })), "gone", "the provider's own code wins");
});

test("'insufficient' needs a money noun; permissions stay auth; and 'Invalid model output/format/parameter/type' is never gone", () => {
  assert.equal(classifyHttp(400, "Insufficient GPU capacity"), "error");
  assert.equal(classifyHttp(403, "Insufficient permissions"), "auth");
  assert.equal(classifyHttp(400, "insufficient quota for this model"), "pay");
  for (const s of ["Invalid model output format requested", "Invalid model output", "invalid model response", "invalid model parameter 'temperature'", "Invalid model type",
                   "invalid model input", "invalid model mode", "unsupported model capability"]) {
    for (const status of [400, 422]) assert.equal(classifyHttp(status, s), "error", `${status}: ${s}`);
  }
  assert.equal(classifyHttp(400, "Invalid model: mistral-foo"), "gone");
  assert.equal(classifyHttp(400, "Invalid model name: mistral-foo"), "gone", "a NAME is a fact about the row");
});

// ------------------------------------------------------- Retry-After, for real

import { parseRetryAfter } from "../refresh/bench.mjs";

/** probeOne over a REAL fetch Response, so the header handling is the platform's own. */
const realResponse = (status, headers = {}) => probeOne({
  fetchImpl: async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status, headers }),
  url: "u", key: "k", model: "p/m",
});

test("a real 429 with NO Retry-After header carries no `ra` (it used to read as 0 ms and hammer the provider)", async () => {
  const r = await realResponse(429);
  assert.equal(r.s, "rate");
  assert.equal("ra" in r, false, `ra was ${r.ra}`);
  assert.equal(Number(new Response("x").headers.get("retry-after")), 0, "the trap: an absent header is null, and Number(null) is 0");
});

test("Retry-After: delta-seconds, decimals and HTTP dates are read; empty, zero, negative, garbage and past dates are no hint", async () => {
  assert.equal((await realResponse(429, { "retry-after": "7" })).ra, 7000);
  assert.equal((await realResponse(503, { "retry-after": "1.5" })).ra, 1500);
  for (const v of ["", "   ", "0", "0.0", "-5", "soon", "12abc", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
    const r = await realResponse(429, { "retry-after": v });
    assert.equal("ra" in r, false, `${JSON.stringify(v)} gave ra ${r.ra}`);
  }
  const future = new Date(Date.now() + 30_000).toUTCString();
  const d = (await realResponse(429, { "retry-after": future })).ra;
  assert.ok(d > 27_000 && d <= 30_000, `an HTTP date 30 s ahead gave ${d}`);
  assert.equal(parseRetryAfter("999999999"), 3_600_000, "an absurd value is clamped to an hour");
  assert.equal(parseRetryAfter(null), null); assert.equal(parseRetryAfter(undefined), null);
});

test("scheduler: a provider that answers 429 with no hint (or ra 0) is backed off exponentially, not re-hit at once", async () => {
  for (const hint of [{}, { ra: 0 }]) {
    const clock = fakeClock();
    const starts = [];
    const sum = await runSweep({
      groups: group({ p: mk("p", 1) }), onResult: () => {}, now: clock.now, timers: clock.timers,
      backoffBaseMs: 1000, backoffMaxMs: 60000, maxRetries: { rate: 2, other: 0 },
      probe: async () => { starts.push(clock.now()); return { s: "rate", http: 429, ...hint }; },
    });
    assert.equal(starts.length, 3, "one try plus two retries");
    const gaps = [starts[1] - starts[0], starts[2] - starts[1]];      // the wake timer adds 1 ms of slack
    assert.ok(gaps[0] >= 1000 && gaps[0] <= 1002 && gaps[1] >= 2000 && gaps[1] <= 2002, `gaps ${gaps} for ${JSON.stringify(hint)}`);
    assert.equal(sum.counts.rate, 1);
  }
});

test("scheduler: a real Retry-After hint still wins over the exponential delay, capped by backoffMaxMs", async () => {
  const clock = fakeClock();
  const starts = [];
  await runSweep({
    groups: group({ p: mk("p", 1) }), onResult: () => {}, now: clock.now, timers: clock.timers,
    backoffBaseMs: 1000, backoffMaxMs: 5000, maxRetries: { rate: 1, other: 0 },
    probe: async () => { starts.push(clock.now()); return { s: "rate", ra: 40_000 }; },
  });
  const gap = starts[1] - starts[0];
  assert.ok(gap >= 5000 && gap <= 5002, `the hint is honoured up to backoffMaxMs, gap ${gap}`);
});

test("probeOne: an error event that arrives after tokens carries the reported count, so it can be billed", async () => {
  const r = await probe([{ at: 1, chunk: usage(20) }, { at: 2, chunk: ev("error", { error: { message: "overloaded" } }) }]);
  assert.equal(r.s, "error"); assert.equal(r.o, 20);
});

// ------------------------------------------------- an empty filter selects nothing

test("buildTargets: an `only` list that was given but is empty selects NOTHING (it used to select every row)", () => {
  const snap = { rows: [{ provider: "a", models: [M("x"), M("y")] }, { provider: "b", models: [M("z")] }] };
  assert.equal(buildTargets(snap, { only: [] }).size, 0);
  assert.equal(buildTargets(snap, { only: null }).size, 2, "no filter at all is still everything");
  assert.equal(buildTargets(snap).size, 2);
  assert.deepEqual([...buildTargets(snap, { only: ["a"] }).keys()], ["a"]);
  assert.deepEqual([...buildTargets(snap, { only: ["b/z"] }).keys()], ["b"]);
  assert.equal(buildTargets(snap, { only: ["nope"] }).size, 0);
});

// ------------------------------------------------- every probe carries the client tag

test("probeOne: every request carries x-ccr-client: uw-probe, on success, refusal and a thrown error alike", async () => {
  const seen = [];
  const record = (inner) => async (url, init) => { seen.push({ url, headers: init.headers }); return inner(url, init); };
  const ok = streamFetch([{ at: 5, chunk: textDelta("Hello there friend") + stop() }]);
  await probeOne({ fetchImpl: record(ok.fetchImpl), now: ok.now, url: "http://gw/v1/messages", key: "k", model: "p/m" });
  const refused = streamFetch([{ at: 5, chunk: JSON.stringify({ error: { message: "nope" } }) }], { status: 401 });
  await probeOne({ fetchImpl: record(refused.fetchImpl), now: refused.now, url: "http://gw/v1/messages", key: "k", model: "p/m" });
  await probeOne({ fetchImpl: record(async () => { throw new Error("ECONNRESET"); }), url: "http://gw/v1/messages", key: "k", model: "p/m" });
  assert.equal(seen.length, 3);
  for (const s of seen) {
    assert.equal(s.headers["x-ccr-client"], "uw-probe", "exact header name and value");
    assert.equal(s.headers["x-api-key"], "k", "the existing headers are unchanged");
    assert.equal(s.headers["anthropic-version"], "2023-06-01");
    assert.equal(s.headers["content-type"], "application/json");
  }
});

test("probeOne: the tag comes from the CCR contract, not a literal in the engine", () => {
  const src = fs.readFileSync(new URL("../refresh/bench.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /x-ccr-client|uw-probe/, "bench.mjs must name neither string; ccr-client.mjs owns both");
});

test("runSweep: a retried row is tagged on every attempt", async () => {
  const seen = [];
  let n = 0;
  const fetchImpl = async (_url, init) => {
    seen.push(init.headers["x-ccr-client"]);
    n += 1;
    return { ok: false, status: n === 1 ? 429 : 200, headers: { get: () => null }, text: async () => "{}", body: null };
  };
  await runSweep({
    groups: new Map([["p", [{ key: "p/m", provider: "p", id: "m", free: true, cost: 0, worst: 0 }]]]),
    onResult: () => {}, backoffBaseMs: 1, backoffMaxMs: 2, maxRetries: { rate: 1, other: 0 },
    probe: (t) => probeOne({ fetchImpl, url: "u", key: "k", model: t.key }),
  });
  assert.ok(seen.length >= 2, `the row was attempted more than once (${seen.length})`);
  assert.deepEqual([...new Set(seen)], ["uw-probe"]);
});

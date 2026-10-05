// The tool-fidelity ladder, fix round: thinking blocks, size versus schema refusals, limits, the L1 retry, required and streamed arguments, the big step.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { ev, stream, fakeFetch, ok, http, goodModel } from "./fixtures/tool-fidelity-helpers.mjs";
import { runLevel, probeModel, levelSize, STREAM_LIMITS } from "../refresh/tool-fidelity-probe.mjs";

guardRealState(after, assert);
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", timeoutMs: 5000, ...extra });
const lvl = async (n, answer, extra) => { const f = fakeFetch(answer); const r = await runLevel(n, conn(f, extra)); return { r, f }; };
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const thinking = (index, text) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } })
  + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }) + sse("content_block_stop", { type: "content_block_stop", index });

test("a THINKING block is not content: an answer that thinks, then stops on max_tokens with no text or tool call, is inconclusive at EVERY level", async () => {
  for (const level of [1, 2, 3, 4, 5]) {
    const { r } = await lvl(level, () => ok(stream(thinking(0, "let me think about the tools"), ev.stop("max_tokens"))));
    assert.deepEqual([r.v, r.s], ["i", "empty"], `L${level}`);
  }
  const withCall = await lvl(1, () => ok(stream(thinking(0, "hmm"), ev.tool(1, "fx_echo", '{"message":"ping"}'), ev.stop("tool_use"))));
  assert.equal(withCall.r.v, "p", "judged on the call, thinking or not");
  const thinkOnly = await lvl(1, () => ok(stream(thinking(0, "hmm"), ev.stop("end_turn"))));
  assert.equal(thinkOnly.r.v, "f", "thinking and a normal stop with no call is a real miss, not a budget problem");
});

test("a 404 or 400 that says the route has no tool support is a VERDICT (failed), not 'gone' or inconclusive", async () => {
  for (const [status, msg] of [[404, "No endpoints found that support tool use. Try disabling \"fx_echo\"."], [400, "tools are not supported by this model"], [422, "this model does not support function calling"], [404, "Tool use is not supported for this model"]]) {
    const { r } = await lvl(1, () => http(status, msg));
    assert.deepEqual([r.v, r.kind], ["f", "schema"], `${status}: ${msg}`);
  }
  const gone = await lvl(1, () => http(404, "model xyz not found"));
  assert.deepEqual([gone.r.v, gone.r.s], ["i", "gone"], "an ordinary 404 is still gone");
});

test("400, 413 and 422 are read with the TIGHT classifier: an echoed tool name that looks like billing is not an empty account", async () => {
  const echoed = await lvl(1, () => http(400, "tool 'purchase_item' has an invalid schema: payment_method is required"));
  assert.deepEqual([echoed.r.v, echoed.r.kind], ["f", "schema"], "the loose reading would have called this `pay` and left the model queued forever");
  const empty = await lvl(1, () => http(400, "insufficient balance, please top up"));
  assert.deepEqual([empty.r.v, empty.r.s], ["i", "pay"]);
  const gone = await lvl(1, () => http(400, "The model `xyz-1` does not exist"));
  assert.deepEqual([gone.r.v, gone.r.s], ["i", "gone"], "an unambiguous 'model does not exist' is still the model's absence");
});

test("a SIZE refusal is told from a schema refusal: 413, or a body about size or context length, is kind size; a 400 about a schema is kind schema; the big step is always size", async () => {
  const k = async (level, status, msg) => (await lvl(level, () => http(status, msg))).r;
  assert.equal((await k(3, 413, "request entity too large")).kind, "size");
  assert.equal((await k(3, 400, "maximum context length is 131072 tokens, you sent 160000")).kind, "size");
  assert.equal((await k(3, 400, "payload exceeds the limit")).kind, "size");
  assert.equal((await k(3, 400, "tools[7].input_schema: unsupported keyword anyOf")).kind, "schema");
  assert.equal((await k(1, 413, "too large")).kind, "size");
  const big = await k(5, 400, "bad request");
  assert.deepEqual([big.v, big.kind], ["f", "size"], "a refusal only at the big step, after 157 KB was accepted, is about size");
});

test("a 413, 400 or 422 that is really a RATE or tokens-per-minute limit stays inconclusive: never a verdict, never a size cap", async () => {
  for (const [status, msg] of [[413, "Request too large for model on tokens per minute (TPM): Limit 6000, Requested 40000"], [400, "Rate limit reached: 30 requests per minute"], [422, "quota exceeded, try again in 20s"], [413, "too many tokens per minute; retry after 12s"]]) {
    const { r } = await lvl(3, () => http(status, msg));
    assert.deepEqual([r.v, r.s], ["i", "rate"], `${status}: ${msg}`);
  }
  const big = await lvl(5, () => http(400, "rate limit exceeded"));
  assert.deepEqual([big.r.v, big.r.s], ["i", "rate"], "at the big step too");
  const { r } = await lvl(5, () => http(429, "rate limit"));
  assert.deepEqual([r.v, r.s], ["i", "rate"]);
});

test("L1: a 400 that names tool_choice is retried ONCE with the choice left to the model; the retry is judged normally and counts as a request", async () => {
  const seen = [];
  const f = fakeFetch((c) => { seen.push(c.body.tool_choice?.type); return c.body.tool_choice?.type === "tool" ? http(400, "tool_choice is not supported with this model") : ok(stream(ev.tool(0, "fx_echo", '{"message":"ping"}'), ev.stop("tool_use"))); });
  const r = await runLevel(1, conn(f));
  assert.deepEqual(seen, ["tool", "auto"]);
  assert.deepEqual([r.v, r.reqs, r.retriedAuto], ["p", 2, true]);
  const noCall = fakeFetch((c) => (c.body.tool_choice?.type === "tool" ? http(422, "unsupported parameter: tool_choice") : ok(stream(ev.text(0, "sure, ping"), ev.stop()))));
  const r2 = await runLevel(1, conn(noCall));
  assert.deepEqual([r2.v, r2.reqs], ["f", 2], "left free to choose, it still did not call the tool: now it is a verdict");
  const r3 = await runLevel(1, conn(fakeFetch(() => http(400, "schema rejected"))));
  assert.deepEqual([r3.v, r3.reqs], ["f", 1], "a 400 that does not mention tool_choice is not retried");
  const l2 = await lvl(2, () => http(400, "tool_choice unsupported"));
  assert.equal(l2.f.calls.length, 1, "only L1 forces a tool, only L1 retries");
});

test("L1 needs the REQUIRED argument: a call to the right tool with the wrong or missing argument fails", async () => {
  const none = await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", "{}"), ev.stop("tool_use"))));
  assert.deepEqual([none.r.v, none.r.why], ["f", "a tool call lacks the required argument `message`"]);
  assert.equal((await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", '{"msg":"ping"}'), ev.stop("tool_use"))))).r.v, "f");
  assert.equal((await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", '{"message":5}'), ev.stop("tool_use"))))).r.v, "f", "the argument must be a string");
});

test("L4 needs STREAMED arguments: two calls whose whole input arrives in the start event, with no argument deltas, fail", async () => {
  const whole = (i, id, input) => sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: "fx_echo", input } })
    + sse("content_block_stop", { type: "content_block_stop", index: i });
  const notStreamed = await lvl(4, () => ok(stream(whole(0, "a", { message: "a" }), whole(1, "b", { message: "b" }), ev.stop("tool_use"))));
  assert.deepEqual([notStreamed.r.v, notStreamed.r.why], ["f", "the tool call arguments were not streamed (no argument deltas)"]);
  const missing = await lvl(4, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "a"), ev.tool(1, "fx_echo", "{}", "b"), ev.stop("tool_use"))));
  assert.equal(missing.r.v, "f", "the second call lacks its argument");
  assert.equal((await lvl(4, goodModel)).r.v, "p");
});

test("L5 (the big step) sends the ~400 KB fixture, only after L3 passed; a model that did not pass L3 is asked nothing", async () => {
  const { bytes, inTokens } = levelSize(5);
  assert.ok(bytes > 390000 && bytes < 410000, `about 400 KB, got ${bytes}`);
  assert.ok(inTokens > 95000 && inTokens < 105000);
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [5], prior: "pppn", ...conn(f) });
  assert.equal(r.requests, 1);
  assert.equal(r.done[5].v, "p");
  assert.ok(r.done[5].bytes > 390000, "the size sent is carried");
  const f2 = fakeFetch(goodModel);
  const none = await probeModel({ levels: [5], prior: "ppnn", ...conn(f2) });
  assert.deepEqual([none.requests, none.done[5].v, f2.calls.length], [0, "n", 0]);
  const together = await probeModel({ levels: [3, 5], prior: "ppnn", ...conn(fakeFetch((c) => (c.bytes > 300000 ? http(400, "bad request") : goodModel(c)))) });
  assert.deepEqual([together.done[3].v, together.done[5].v, together.done[5].kind], ["p", "f", "size"], "L5 runs after an L3 pass in the same invocation, and its refusal is a size one");
});

test("a hostile stream is bounded: too many blocks, events or bytes end the read with a failure instead of growing without limit", async () => {
  const blocks = Array.from({ length: STREAM_LIMITS.blocks + 5 }, (_, i) => ev.text(i, "x")).join("");
  const many = await lvl(3, () => ok(stream(blocks, ev.stop())));
  assert.deepEqual([many.r.v, many.r.kind], ["f", "schema"]);
  assert.match(many.r.why, /passed the size limits/);
  let sent = 0;
  const endless = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(sse("ping", { type: "ping" }))); sent += 1; if (sent > 100000) c.close(); } }), { status: 200 });
  const t0 = Date.now();
  const e = await runLevel(1, conn(endless));
  assert.equal(e.v, "f");
  assert.ok(sent < STREAM_LIMITS.events + 100, `stopped reading after ${sent} events`);
  assert.ok(Date.now() - t0 < 5000);
  let pulled = 0;
  const huge = async () => new Response(new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode(sse("ping", { pad: "z".repeat(100000) }))); if (pulled >= 60) c.close(); } }), { status: 200 });
  const big = await runLevel(1, conn(huge));
  assert.equal(big.v, "f");
  assert.match(big.why, /passed the size limits/, "stopped for the byte limit, not for what the answer lacked");
  assert.ok(pulled < 40, `stopped reading after ${pulled} chunks of 100 KB (the limit is ${STREAM_LIMITS.bytes} bytes)`);
});

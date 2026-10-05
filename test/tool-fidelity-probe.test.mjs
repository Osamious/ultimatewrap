// The tool-fidelity ladder against fake streams: every level, every failure mode, offline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { ev, stream, fakeFetch, ok, http, goodModel } from "./fixtures/tool-fidelity-helpers.mjs";
import { runLevel, probeModel, buildBody, levelSize, judge } from "../refresh/tool-fidelity-probe.mjs";

guardRealState(after, assert);
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", timeoutMs: 5000, ...extra });
const lvl = async (n, answer, extra) => { const f = fakeFetch(answer); const r = await runLevel(n, conn(f, extra)); return { r, f }; };

test("request shapes: L1 forces the one tool, L2 is a tool_result round trip with a matching id, L3 and L4 send the large fixture", () => {
  const b1 = buildBody(1, "p/m");
  assert.deepEqual(b1.tool_choice, { type: "tool", name: "fx_echo" });
  assert.equal(b1.tools.length, 1);
  assert.equal(b1.stream, true);
  const b2 = buildBody(2, "p/m");
  const [u, a, r] = b2.messages;
  assert.equal(u.role, "user"); assert.equal(a.role, "assistant"); assert.equal(r.role, "user");
  assert.equal(a.content[0].type, "tool_use");
  assert.equal(r.content[0].type, "tool_result");
  assert.equal(r.content[0].tool_use_id, a.content[0].id, "the tool_result answers the assistant's tool_use id");
  assert.equal(b2.tool_choice, undefined, "the round trip does not force a call: the model must be free to answer");
  for (const n of [3, 4]) {
    const { bytes, inTokens } = levelSize(n);
    assert.ok(bytes > 150000 && bytes < 165000, `L${n} is about 157 KB, got ${bytes}`);
    assert.ok(inTokens > 37000 && inTokens < 42000, `L${n} is about 40,000 input tokens, got ${inTokens}`);
    assert.ok(buildBody(n, "p/m").system.length >= 8000, "a roughly 9 KB system prompt rides with the tools");
  }
  assert.ok(levelSize(1).bytes < 2000 && levelSize(2).bytes < 2000, "L1 and L2 are small requests");
});

test("every level is sent through the gateway URL with the probe client tag and stream:true", async () => {
  const { f } = await lvl(1, goodModel);
  const c = f.calls[0];
  assert.equal(c.url, "http://gw.test/v1/messages");
  assert.equal(c.body.model, "p/m");
  assert.equal(c.headers["x-api-key"], "k");
  assert.equal(c.headers["x-ccr-client"], "uw-probe");
  assert.equal(c.body.stream, true);
});

test("L1: a forced tool call with valid JSON arguments passes", async () => {
  const { r } = await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"ping"}'), ev.stop("tool_use"))));
  assert.equal(r.v, "p");
});

test("L1 failure modes: text instead of a call, no content, invalid JSON, a tool that was not offered", async () => {
  const text = await lvl(1, () => ok(stream(ev.text(0, "ping"), ev.stop())));
  assert.deepEqual([text.r.v, text.r.why], ["f", "answered in text instead of calling the tool"]);
  const none = await lvl(1, () => ok(stream(ev.stop())));
  assert.deepEqual([none.r.v, none.r.why], ["f", "no tool call in the answer"]);
  const bad = await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"pi'), ev.stop("tool_use"))));
  assert.deepEqual([bad.r.v, bad.r.why], ["f", "tool call arguments are not valid JSON"]);
  const arr = await lvl(1, () => ok(stream(ev.tool(0, "fx_echo", '["x"]'), ev.stop("tool_use"))));
  assert.equal(arr.r.v, "f", "arguments must be a JSON object");
  const other = await lvl(1, () => ok(stream(ev.tool(0, "rm_rf", '{"message":"x"}'), ev.stop("tool_use"))));
  assert.deepEqual([other.r.v, other.r.why], ["f", "tool call names a tool that was not offered"]);
});

test("HTTP 400, 413 and 422 on a tool-bearing request are verdicts: failed, with the reason redacted and clipped", async () => {
  for (const status of [400, 413, 422]) {
    const { r } = await lvl(1, () => http(status, `schema rejected ${"y".repeat(500)}`));
    assert.equal(r.v, "f", `HTTP ${status}`);
    assert.equal(r.http, status);
    assert.ok(r.why.length <= 160, "clipped");
  }
  const fake = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");           // built at run time: no key-shaped literal in the source
  const leaky = await lvl(1, () => http(400, `bad request for key ${fake}`));
  assert.ok(!leaky.r.why.includes(fake.slice(0, 12)), "a key-shaped string in the provider's sentence is masked");
});

test("account and moment failures are INCONCLUSIVE, never a failed verdict: 429 rate, 402 pay, 401 auth, 404 gone, 500 error", async () => {
  const cases = [[429, "slow down", "rate"], [402, "payment required", "pay"], [401, "bad key", "auth"], [404, "not found", "gone"], [500, "oops", "error"], [503, "unavailable", "error"]];
  for (const [status, msg, s] of cases) {
    const { r } = await lvl(1, () => http(status, msg));
    assert.deepEqual([r.v, r.s], ["i", s], `HTTP ${status}`);
  }
  const ra = await lvl(1, () => http(429, "slow down", { "retry-after": "7" }));
  assert.equal(ra.r.ra, 7000, "Retry-After is carried for the engine's backoff");
  const quota = await lvl(1, () => http(400, "insufficient balance, please top up"));
  assert.deepEqual([quota.r.v, quota.r.s], ["i", "pay"], "a 400 that says the account is empty is the account's state, not the model's");
});

test("stream error events: an account/overload sentence is inconclusive; an unexplained one before any content is a failure", async () => {
  const over = await lvl(1, () => ok(stream(ev.error("Overloaded, try again"))));
  assert.deepEqual([over.r.v, over.r.s], ["i", "error"]);
  const bad = await lvl(1, () => ok(stream(ev.error("unsupported schema keyword anyOf"))));
  assert.equal(bad.r.v, "f");
  const none = await lvl(1, () => ok(""));
  assert.deepEqual([none.r.v, none.r.s], ["i", "error"], "a 200 with no stream events says nothing about tools");
});

test("a budget spent on hidden reasoning (max_tokens, no content) is inconclusive, never a failed tool call", async () => {
  const { r } = await lvl(1, () => ok(stream(ev.stop("max_tokens"))));
  assert.deepEqual([r.v, r.s], ["i", "empty"]);
});

test("a hung request is inconclusive `timeout`; an abort from the caller is reported as aborted, not as a result", async () => {
  const f = async (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const t = await runLevel(1, conn(f, { timeoutMs: 30 }));
  assert.deepEqual([t.v, t.s], ["i", "timeout"]);
  const ac = new AbortController();
  const p = runLevel(1, conn(f, { signal: ac.signal, timeoutMs: 5000 }));
  ac.abort();
  assert.deepEqual(await p, { aborted: true });
  const net = await runLevel(1, conn(async () => { throw new Error("socket hang up"); }));
  assert.deepEqual([net.v, net.s], ["i", "error"]);
});

test("L2: a final text answer passes; calling the tool again, no answer, and an error all fail", async () => {
  const good = await lvl(2, () => ok(stream(ev.text(0, "It returned ping."), ev.stop())));
  assert.equal(good.r.v, "p");
  const again = await lvl(2, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"ping"}'), ev.stop("tool_use"))));
  assert.deepEqual([again.r.v, again.r.why], ["f", "called the tool again instead of answering"]);
  const empty = await lvl(2, () => ok(stream(ev.stop())));
  assert.deepEqual([empty.r.v, empty.r.why], ["f", "no final answer after the tool result"]);
  const rejected = await lvl(2, () => http(400, "messages.2: tool_result blocks are not supported"));
  assert.equal(rejected.r.v, "f", "a 400 on the round trip is exactly what L2 exists to catch");
  const midErr = await lvl(2, () => ok(stream(ev.text(0, "It returned"), ev.error("upstream decode failed"))));
  assert.equal(midErr.r.v, "f");
});

test("L3: the large request is accepted and answered (text or a call); the size sent is reported; a refusal at that size fails", async () => {
  const asText = await lvl(3, () => ok(stream(ev.text(0, "ok"), ev.stop())));
  assert.equal(asText.r.v, "p");
  assert.ok(asText.r.bytes > 150000 && asText.r.bytes < 165000, `bytes sent: ${asText.r.bytes}`);
  const asTool = await lvl(3, goodModel);
  assert.equal(asTool.r.v, "p");
  const tooBig = await lvl(3, () => http(413, "request entity too large"));
  assert.deepEqual([tooBig.r.v, tooBig.r.http], ["f", 413]);
  const empty = await lvl(3, () => ok(stream(ev.stop())));
  assert.deepEqual([empty.r.v, empty.r.why], ["f", "empty answer to the large request"]);
  const badArgs = await lvl(3, () => ok(stream(ev.tool(0, "fx_read_0", '{"path":'), ev.stop("tool_use"))));
  assert.equal(badArgs.r.v, "f");
});

test("L4: two parallel calls with streamed arguments pass; one call, a shared id, or broken arguments fail", async () => {
  const two = await lvl(4, goodModel);
  assert.equal(two.r.v, "p");
  assert.ok(two.f.calls[0].bytes > 150000, "L4 rides on the large fixture");
  const one = await lvl(4, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}'), ev.stop("tool_use"))));
  assert.deepEqual([one.r.v, one.r.why], ["f", "one tool call instead of 2 parallel calls"]);
  const same = await lvl(4, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "same"), ev.tool(1, "fx_echo", '{"message":"b"}', "same"), ev.stop("tool_use"))));
  assert.deepEqual([same.r.v, same.r.why], ["f", "parallel tool calls share one id"]);
  const cut = await lvl(4, () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "x"), ev.tool(1, "fx_echo", '{"message":"b', "y"), ev.stop("tool_use"))));
  assert.equal(cut.r.v, "f", "the second call's arguments were cut off");
});

test("argument deltas arrive split across many events and chunks and are reassembled", async () => {
  const body = stream(ev.tool(0, "fx_echo", JSON.stringify({ message: "x".repeat(300) })), ev.stop("tool_use"));
  const chunks = body.match(/[\s\S]{1,13}/g);
  const f = async () => new Response(new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(new TextEncoder().encode(k)); c.close(); } }), { status: 200 });
  assert.equal((await runLevel(1, conn(f))).v, "p");
});

test("judge is pure over a parsed stream: a no-body response is inconclusive", () => {
  assert.equal(judge(1, { noBody: true, blocks: [] }).v, "i");
});

test("probeModel: asks only the requested levels, in order, and returns the verdicts with the size L3 sent", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [1, 2, 3, 4], ...conn(f) });
  assert.deepEqual(Object.fromEntries(Object.entries(r.done).map(([k, v]) => [k, v.v])), { 1: "p", 2: "p", 3: "p", 4: "p" });
  assert.equal(r.requests, 4);
  assert.ok(r.done[3].bytes > 150000 && r.done[4].bytes > 150000, "the size each large level sent is carried");
  const f2 = fakeFetch(goodModel);
  const r2 = await probeModel({ levels: [1, 2], ...conn(f2) });
  assert.equal(r2.requests, 2);
  assert.equal(r2.done[3], undefined, "L3 did not run: no size is claimed");
});

test("probeModel: a model that failed L1 or L2 is NOT sent the 157 KB levels (zero requests, level recorded as not run)", async () => {
  const f = fakeFetch((c) => (c.body.tool_choice ? ok(stream(ev.text(0, "no"), ev.stop())) : goodModel(c)));
  const r = await probeModel({ levels: [1, 2, 3, 4], ...conn(f) });
  assert.equal(r.requests, 2, "L1 and L2 only");
  assert.deepEqual([r.done[1].v, r.done[2].v, r.done[3].v, r.done[4].v], ["f", "p", "n", "n"]);
  assert.ok(f.calls.every((c) => c.bytes < 2000), "no large request was sent");
  // the same through a stored prior: lazy L3 on a model whose record says L1 and L2 did not both pass
  const f2 = fakeFetch(goodModel);
  const r2 = await probeModel({ levels: [3, 4], prior: "pfnn", ...conn(f2) });
  assert.equal(r2.requests, 0);
  assert.deepEqual([r2.done[3].v, r2.done[4].v], ["n", "n"]);
  // and lazy L3 and L4 on a model whose record says pp: both run, L1 and L2 are not asked again
  const f3 = fakeFetch(goodModel);
  const r3 = await probeModel({ levels: [3, 4], prior: "ppnn", ...conn(f3) });
  assert.equal(r3.requests, 2);
  assert.ok(f3.calls.every((c) => c.bytes > 150000));
});

test("probeModel: an inconclusive level returns no verdicts at all (nothing to record); a retry repeats only that level", async () => {
  let n = 0;
  const f = fakeFetch((c) => (c.body.messages.length === 3 && ++n === 1 ? http(429, "slow down") : goodModel(c)));
  const done = {};
  const first = await probeModel({ levels: [1, 2], done, ...conn(f) });
  assert.equal(first.inconclusive.s, "rate");
  assert.equal(first.done, undefined, "no result object to record");
  assert.equal(done[1].v, "p", "L1 had a verdict and keeps it");
  assert.equal(done[2], undefined);
  const second = await probeModel({ levels: [1, 2], done, ...conn(f) });
  assert.equal(second.requests, 1, "only L2 is asked again");
  assert.deepEqual([second.done[1].v, second.done[2].v], ["p", "p"]);
});

test("probeModel: an abort drops the model without a verdict", async () => {
  const ac = new AbortController();
  const f = async (url, init) => { ac.abort(); throw new Error("aborted"); };
  assert.deepEqual(await probeModel({ levels: [1, 2], ...conn(f, { signal: ac.signal }) }), { aborted: true });
});

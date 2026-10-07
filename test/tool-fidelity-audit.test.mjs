// The audit round: an unusable answer (empty, cut, thinking-only, filtered) is a verdict about the model only when the budget, the stream and the provider cannot be the reason; the record keeps
// a short note of what the answer looked like (l3w, spw, l4w); the gateway's id rewrite is tagged; a generic rejection names nothing. Offline: fake streams, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, ok, ev, stream, streamWith, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { runKind, probeModel, judge, namesRequest, GATEWAY_WORDS, ESCALATED_MAX_TOKENS } from "../refresh/tool-fidelity-probe.mjs";
import { main } from "../refresh/tool-fidelity-cli.mjs";
import { buildRecord, cleanFidelity, summaryOf, loadFidelity, saveFidelity, migrateTransient, reopenReason, transientReason, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-06T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const kinds = (f) => f.calls.map(kindOf);
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const think = (i, t) => sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } })
  + sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: t } }) + sse("content_block_stop", { type: "content_block_stop", index: i });
const empty = (stop = "end_turn", out = 0) => ok(streamWith(40210, ev.stop(stop, out)));
const cutStream = (...parts) => ok(stream(...parts));                                // no message_delta, no message_stop: the connection closed

// ---------------------------------------------------------------- the empty answer and what it looked like

test("an EMPTY answer to the constructs request is a verdict, and the failure keeps what the answer looked like (stop reason, block kinds, tokens) in at most 60 printable characters", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? empty("end_turn", 0) : goodModel(c)));
  const r = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual([r.done[3].v, r.done[3].why], ["f", "[3a] empty answer to the constructs request"]);
  assert.equal(r.done[3].w, "stop=end_turn blocks=none in=40210 out=0");
  assert.match(r.done[3].w, /^[ -~]{1,60}$/);
  const hostile = await runKind("3a", conn(fakeFetch(() => ok(streamWith(7, think(0, "x"), ev.stop("end\u0007_turné".repeat(5), 1))))));
  assert.match(hostile.w ?? "", /^[ -~]{1,60}$/, "an upstream's own words never reach the record unprintable or long");
  const big = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "3b" ? empty("end_turn", 0) : goodModel(c)))) });
  assert.deepEqual([big.done[3].v, big.done[3].why.startsWith("[3b] empty answer to the large request"), big.done[3].w], ["f", true, "stop=end_turn blocks=none in=40210 out=0"]);
});

test("an empty answer whose OUTPUT TOKENS used the budget up is the budget (inconclusive empty, asked once more, larger), whatever stop reason the gateway reports; one that ended on max_tokens is too", async () => {
  for (const [stop, out] of [["end_turn", 1], ["end_turn", 0.9], ["max_tokens", 0]]) {          // out: the share of the budget the request was sent with that the output used
    const f = fakeFetch((c) => (kindOf(c) === "3a" ? empty(stop, Math.ceil(out * c.body.max_tokens)) : goodModel(c)));
    const r = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(f) });
    assert.deepEqual(kinds(f).slice(0, 2), ["3a", "3a"], `${stop} ${out}: asked once more with the larger budget`);
    assert.equal(f.calls[1].body.max_tokens, ESCALATED_MAX_TOKENS);
    assert.equal(r.inconclusive?.reason, "reasoning-budget", `${stop} ${out}: never a verdict`);
  }
  const room = fakeFetch((c) => (kindOf(c) === "3a" ? empty("end_turn", 100) : goodModel(c)));
  const r = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(room) });
  assert.equal(r.done[3].v, "f", "100 of 256 tokens used and a normal stop: the budget was not the reason");
});

test("a moderation or refusal stop with no content is the PROVIDER's: inconclusive upstream-unavailable with the stop reason as the hint, never a verdict", async () => {
  for (const stop of ["refusal", "content_filter", "safety", "blocked"]) {
    const r = await runKind("3a", conn(fakeFetch(() => empty(stop, 0))));
    assert.deepEqual([r.v, r.s, r.reason], ["i", "error", "upstream-unavailable"], stop);
    assert.match(r.hint, new RegExp(`stop_reason ${stop}`));
  }
  const withContent = await runKind("3a", conn(fakeFetch(() => ok(stream(ev.text(0, "I cannot do that"), ev.stop("refusal", 5))))));
  assert.equal(withContent.v, "p", "an answer that has text is judged as before");
});

test("a CUT stream (no stop reason, no message_stop) with no content or with unfinished call arguments is inconclusive, not a verdict; a complete stream with bad arguments still fails", async () => {
  const none = await runKind("3a", conn(fakeFetch(() => cutStream())));
  assert.deepEqual([none.v, none.s], ["i", "error"]);
  assert.match(none.why, /without a stop event/);
  const half = await runKind("3b", conn(fakeFetch(() => cutStream(ev.tool(0, "fx_echo", '{"message":"a', "toolu_a")))));
  assert.deepEqual([half.v, half.s], ["i", "error"], "arguments unfinished because the stream was cut");
  const complete = await runKind("3b", conn(fakeFetch(() => ok(stream(ev.tool(0, "fx_echo", '{"message":"a', "toolu_a"), ev.stop("tool_use", 20))))));
  assert.deepEqual([complete.v, complete.why], ["f", "tool call arguments are not valid JSON"], "a stream that ended properly with broken arguments is the model's");
  const used = await runKind("3b", conn(fakeFetch(() => ok(stream(ev.tool(0, "fx_echo", '{"message":"a', "toolu_a"), ev.stop("end_turn", 250))))));
  assert.deepEqual([used.v, used.s], ["i", "empty"], "the output tokens used the budget: the call was cut by it, whatever the stop reason says");
});

test("L4: fewer than two calls because the BUDGET ran out is inconclusive (asked again, larger); one call and a normal stop is a failure that keeps the stop reason (l4w)", async () => {
  const cutByBudget = (c) => (kindOf(c) === "3b" ? ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "toolu_a"), ev.stop("max_tokens", 256))) : goodModel(c));
  const f = fakeFetch(cutByBudget);
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b", "3b"], "3b asked once more with the larger budget");
  assert.equal(f.calls[2].body.max_tokens, ESCALATED_MAX_TOKENS);
  assert.equal(r.inconclusive?.reason, "reasoning-budget");
  const g = fakeFetch((c) => (kindOf(c) === "3b" ? ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "toolu_a"), ev.stop("tool_use", 30))) : goodModel(c)));
  const s = await probeModel({ levels: [3, 4], prior: "ppnn", ...FREE, ...conn(g) });
  assert.deepEqual([s.done[3].v, s.done[4].v, s.done[4].w], ["p", "f", "1 call of 2 stop=tool_use"]);
});

test("the spawn failure keeps a short note of what was wrong and the stop reason (spw): text instead of delegating, no call, an unknown subagent_type", async () => {
  const text = await probeModel({ levels: [6], prior: "ppnn", ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "6" ? ok(stream(ev.text(0, "I will do it myself"), ev.stop("end_turn", 8))) : goodModel(c)))) });
  assert.deepEqual([text.done[6].v, text.done[6].w], ["f", "text, not delegating stop=end_turn"]);
  const other = await probeModel({ levels: [6], prior: "ppnn", ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "6" ? ok(stream(ev.tool(0, "Agent", JSON.stringify({ description: "d", prompt: "Investigate the auth module", subagent_type: "Nope" })), ev.stop("tool_use", 20))) : goodModel(c)))) });
  assert.equal(other.done[6].w, "unknown subagent_type stop=tool_use");
});

// ---------------------------------------------------------------- the cache_control re-ask on an empty constructs answer

test("an empty 3a answer is asked once more WITHOUT the cache_control markers: when that one answers, the markers are the cause (cc f, the level is learned and the later requests keep them off)", async () => {
  const f = fakeFetch((c) => {
    if (kindOf(c) !== "3a") return goodModel(c);
    const marked = JSON.stringify(c.body).includes("cache_control");
    return marked ? empty("end_turn", 0) : goodModel(c);
  });
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a", "3b"]);
  assert.equal(JSON.stringify(f.calls[1].body).includes("cache_control"), false);
  assert.equal(JSON.stringify(f.calls[2].body).includes("cache_control"), false, "the 157 KB request is sent without them too");
  assert.deepEqual([r.done[3].v, r.done[3].cc], ["p", "f"]);
});

test("when the second answer is empty too the markers were not the cause: the failure stands, the markers are not blamed (cc not f) and the next requests keep them", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? empty("end_turn", 0) : goodModel(c)));
  const state = {};
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", state, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a"]);
  assert.deepEqual([r.done[3].v, r.done[3].cc, state.noCc], ["f", "p", false]);
  assert.equal(r.done[3].w, "stop=end_turn blocks=none in=40210 out=0");
  const s = await probeModel({ levels: [3], prior: "ppnn", state: {}, ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "3a" ? ok(stream(ev.text(0, "no tool"), ev.stop("end_turn", 3))) : goodModel(c)))) });
  assert.equal(s.done[3].v, "p", "an answer with text is not empty: no re-ask");
});

// ---------------------------------------------------------------- the record keeps the notes

test("l3w and spw are stored (printable, at most 60 characters), shown in the summary, kept by a later probe that did not look, and cleared by a pass", () => {
  const f3 = { v: "f", why: "[3a] empty answer to the constructs request", kind: "schema", w: "stop=end_turn blocks=none in=40210 out=0" };
  const first = buildRecord(record("ppnn"), { 3: f3 }, { now: NOW });
  assert.equal(first.strikes, 1);
  assert.equal(first.l3w, "stop=end_turn blocks=none in=40210 out=0", "stored at the first strike too: it is the evidence");
  const second = buildRecord(first, { 3: f3 }, { now: NOW });
  assert.deepEqual([second.t, second.l3w], ["x", "stop=end_turn blocks=none in=40210 out=0"]);
  assert.ok(cleanFidelity(second), "the cleaner accepts it");
  assert.equal(cleanFidelity({ ...second, l3w: "x".repeat(61) }), null);
  assert.equal(cleanFidelity({ ...second, l3w: "bad\u0007" }), null);
  assert.ok(summaryOf(second).notes.some((n) => /L3 answer: stop=end_turn/.test(n)));
  const healed = buildRecord(second, { 3: { v: "p", bytes: 1 } }, { now: NOW });
  assert.equal(healed.l3w, undefined);
  const sp1 = buildRecord(record("pppp"), { 6: { v: "f", why: "answered in text instead of delegating", w: "text, not delegating stop=end_turn" } }, { now: NOW });
  assert.equal(sp1.spw, "text, not delegating stop=end_turn");
  assert.ok(cleanFidelity(sp1) && summaryOf(sp1).notes.some((n) => /spawn failed: text, not delegating/.test(n)));
  assert.equal(buildRecord(sp1, { 6: { v: "p" } }, { now: NOW }).spw, undefined);
  assert.equal(buildRecord(second, { 1: { v: "p", af: "p" } }, { now: NOW }).l3w, second.l3w, "a probe that did not ask L3 leaves the note");
});

// ---------------------------------------------------------------- the gateway's id rewrite and the generic rejection

test("\"Tool call id was toolu_... but must be a-z, A-Z, 0-9, with a length of 9\" is the gateway's translation failing: the verdict stays and carries the gateway tag (the provider's own wording, redacted forms too)", async () => {
  for (const msg of ["mistral: Tool call id was toolu_fx0001 but must be a-z, A-Z, 0-9, with a length of 9.", "infron: Tool call id was lu_fx0001 but must be a-z, A-Z, 0-9, with a length of 9. (request id: [id])"]) {
    assert.ok(GATEWAY_WORDS.test(msg), msg);
    const f = fakeFetch((c) => (kindOf(c) === "2" ? http(400, msg) : goodModel(c)));
    const r = await probeModel({ levels: [1, 2], ...FREE, ...conn(f) });
    assert.deepEqual([r.done[2].v, r.done[2].gw], ["f", true]);
    const rec = buildRecord(buildRecord(null, r.done, { now: NOW }), r.done, { now: NOW });                 // two strikes confirm the failure
    assert.deepEqual([rec.t, rec.xw], ["x", "gateway"]);
  }
  const stored = { "mistral/voxtral": record("pfnn", { why: "L2: HTTP 400: {\"error\":{\"message\":\"mistral: Tool call id was toolu_fx0001 but must be a-z, A-Z, 0-9, with a length of 9.\"", strikes: 2, sl: 2 }) };
  const m = migrateTransient(stored);
  assert.deepEqual(m.tagged, ["mistral/voxtral"]);
  assert.equal(m.store["mistral/voxtral"].xw, "gateway");
  assert.equal(m.cleared.length, 0, "it stays a failure");
});

test("a GENERIC rejection (provider rejected the request, invalid request error, check the model, input, and parameters, a trace or request id) names nothing: pending upstream-unavailable, never a verdict; naming a tool or a schema still is one", async () => {
  for (const msg of [
    "anymodel: The provider rejected the request as invalid. Check the model, input, and parameters.",
    "experientiallabs: provider rejected the request: invalid request error trace_id: abc123",
    "Invalid request error (request id: 9f2c)"]) {
    assert.equal(namesRequest(msg), false, msg);
    for (const kind of ["1", "3a"]) {
      const r = await runKind(kind, conn(fakeFetch(() => http(400, msg))));
      assert.deepEqual([r.v, r.reason], ["i", "upstream-unavailable"], `${kind}: ${msg}`);
    }
  }
  for (const msg of ["provider rejected the request: tools.0.input_schema: unsupported keyword anyOf", "invalid request error: the tool name is too long", "Invalid request: parameter `limit` is not allowed"]) {
    assert.equal(namesRequest(msg), true, msg);
    const r = await runKind("3a", conn(fakeFetch(() => http(400, msg))));
    assert.equal(r.v, "f", msg);
  }
});

test("--reset-transient: the three anymodel L1 records and the experientiallabs L3 record that rest on a generic rejection are cleared; an L3 empty answer is reopened (counted apart); a real schema rejection and a gateway failure are not", () => {
  const anymodel = "L1: HTTP 400: {\"error\":{\"message\":\"anymodel: The provider rejected the request as invalid. Check the model, input, and parameters.\",\"target_providers\":[\"openai\"";
  const exp = "L3: [3a] HTTP 400: {\"error\":{\"message\":\"experientiallabs: provider rejected the request: invalid request error trace_id: [redacted]\",\"target_providers\":[\"openai";
  assert.deepEqual(transientReason(anymodel), { level: 1, shape: "unnamed 400" });
  assert.deepEqual(transientReason(exp), { level: 3, shape: "unnamed 400" });
  assert.equal(transientReason("L3: [3a] HTTP 400: {\"error\":{\"message\":\"tools.0.input_schema: unsupported keyword anyOf\""), null);
  assert.deepEqual(reopenReason("L3: [3a] empty answer to the constructs request"), { level: 3, shape: "empty L3 answer", reopen: true });
  assert.deepEqual(reopenReason("L3: [3b] tool call arguments are not valid JSON"), { level: 3, shape: "L3 arguments not valid JSON", reopen: true });
  assert.equal(reopenReason("L3: [3b] HTTP 413: too large"), null);
  const store = {
    "anymodel/a": record("ffnn", { why: anymodel, strikes: 2, sl: 1 }),
    "experientiallabs/d": record("ppfn", { why: exp, strikes: 2, sl: 3, af: "p", cc: "p", d3: "a" }),
    "codecraftapi/c": record("ppfn", { why: "L3: [3a] empty answer to the constructs request", strikes: 2, sl: 3, af: "f", cc: "p", d3: "a", l3w: "stop=end_turn blocks=none in=1 out=0" }),
    "nscale/q": record("ppfn", { why: "L3: [3b] empty answer to the large request", strikes: 2, sl: 3, nm: "p", cc: "p", d3: "b" }),
    "real/s": record("ppfn", { why: "L3: [3a] HTTP 400: {\"error\":{\"message\":\"tools.0.input_schema: unsupported keyword anyOf\"", strikes: 2, sl: 3, d3: "a" }),
  };
  const m = migrateTransient(store);
  assert.deepEqual(m.cleared.map((c) => c.key).sort(), ["anymodel/a", "codecraftapi/c", "experientiallabs/d", "nscale/q"]);
  assert.deepEqual(m.cleared.filter((c) => c.reopen).map((c) => c.key).sort(), ["codecraftapi/c", "nscale/q"]);
  assert.equal(m.store["real/s"].t, "x", "a real schema rejection stays a failure");
  const c = m.store["codecraftapi/c"];
  assert.deepEqual([c.lvr, c.t, c.strikes, c.l3w, c.d3, c.why], ["ppnn", "t", undefined, undefined, undefined, undefined]);
  assert.equal(m.store["anymodel/a"], undefined, "nothing else known: removed, asked again from scratch");
});

test("--reset-transient on a copy reports the reopened L3 failures apart and writes nothing without --live", async () => {
  const dir = freshDir(), file = path.join(dir, FILE_NAME);
  saveFidelity(file, {
    "codecraftapi/c": record("ppfn", { why: "L3: [3a] empty answer to the constructs request", strikes: 2, sl: 3, d3: "a" }),
    "real/s": record("ppfn", { why: "L3: [3a] HTTP 400: {\"error\":{\"message\":\"tools.0.input_schema: unsupported keyword anyOf\"", strikes: 2, sl: 3, d3: "a" }),
  }, { now: NOW });
  const out = [], lg = console.log;
  console.log = (...a) => out.push(a.join(" "));
  let code;
  try { code = await main(["--reset-transient"], { outFile: file, now: () => NOW }); } finally { console.log = lg; }
  assert.equal(code, 0);
  const text = out.join("\n");
  assert.match(text, /of those, 1 are L3 failures that rest on an empty answer or unfinished call arguments/);
  assert.match(text, /empty L3 answer 1/);
  assert.match(text, /nothing was written/);
  assert.equal(loadFidelity(file).models["codecraftapi/c"].t, "x");
});

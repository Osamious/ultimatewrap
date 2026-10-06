// The tool-fidelity engine (`probeModel`): the ladder orchestration, the deep-probe clamp, the cache_control flow, early cancel, thinking-only escalation, big-first order,
// telemetry and the stream limits. Offline, fake streams.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { ev, stream, streamWith, fakeFetch, ok, http, goodModel, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { runKind, probeModel, STREAM_LIMITS, ESCALATED_MAX_TOKENS, LIFTS, deepAllowed, NOT_FREE_REASON } from "../refresh/tool-fidelity-probe.mjs";
import { liftDeepProbes } from "../refresh/tool-fidelity.mjs";
import { LONG_TOOL } from "../refresh/tool-fidelity-fixture.mjs";

guardRealState(after, assert);
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const thinking = (index, text) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } })
  + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }) + sse("content_block_stop", { type: "content_block_stop", index });
const kinds = (f) => f.calls.map(kindOf);
const verdicts = (r) => Object.fromEntries(Object.entries(r.done).map(([k, v]) => [k, v.v]));
const FREE = { tier: "free" };

test("the full ladder on a good model: 1, 1a, 2, 6, 2e, 3a, 3b, 5 (cheap first) are the only requests (L4 rides in 3b), and every level has its verdict and markers", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [1, 2, 3, 4, 5, 6, 7], ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["1", "1a", "2", "6", "2e", "3a", "3b", "5"]);
  assert.deepEqual(verdicts(r), { 1: "p", 2: "p", 3: "p", 4: "p", 5: "p", 6: "p", 7: "p" });
  assert.deepEqual([r.done[1].af, r.done[2].br, r.done[3].nm, r.done[3].cc], ["p", "p", "p", "p"]);
  assert.ok(r.done[3].bytes > 150000 && r.done[5].bytes > 390000);
  assert.equal(r.requests, 8);
  assert.equal(r.tele.length, 8, "one telemetry entry per request");
});

test("L3 is TWO requests: a construct rejection at 3a is the schema verdict and the model NEVER pays the 157 KB request; 3a passing does not imply L3", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? http(400, "tools.0.input_schema: unsupported keyword anyOf") : goodModel(c)));
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a"], "no 3b");
  assert.equal(f.calls[0].bytes < 12000, true);
  assert.deepEqual([r.done[3].v, r.done[3].kind, r.done[3].why.startsWith("[3a] ")], ["f", "schema", true]);
  assert.deepEqual([r.done[4].v, r.done[4].why], ["n", "not run: L3 did not pass"], "L4 is not answered by a 3a rejection");
  const f2 = fakeFetch((c) => (kindOf(c) === "3b" ? http(413, "request entity too large") : goodModel(c)));
  const r2 = await probeModel({ levels: [3, 4], prior: "ppnn", ...FREE, ...conn(f2) });
  assert.deepEqual(kinds(f2), ["3a", "3b"], "3a passed and still 3b was needed");
  assert.deepEqual([r2.done[3].v, r2.done[3].kind, r2.done[3].why.startsWith("[3b] ")], ["f", "size", true], "size acceptance needs the 157 KB request: 3a passing implied nothing");
});

test("an inconclusive 3b keeps 3a's verdict: the retry asks 3b only (a verdict is never re-asked)", async () => {
  let n = 0;
  const f = fakeFetch((c) => (kindOf(c) === "3b" && ++n === 1 ? http(429, "slow down") : goodModel(c)));
  const state = {}, done = {};
  const first = await probeModel({ levels: [3, 4], prior: "ppnn", state, done, ...FREE, ...conn(f) });
  assert.equal(first.inconclusive.s, "rate");
  assert.deepEqual(kinds(f), ["3a", "3b"]);
  const second = await probeModel({ levels: [3, 4], prior: "ppnn", state, done, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b", "3b"], "only 3b again");
  assert.deepEqual([second.done[3].v, second.done[4].v, second.done[3].nm], ["p", "p", "p"]);
});

test("NEVER re-send a confirmed level: a model with L1+L2 done and L3 pending sends only L3 (3a, 3b); L4 alone sends only 3b; a model that already has everything sends nothing", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [1, 2, 3, 4], prior: "ppnn", done: { 1: { v: "p" }, 2: { v: "p" } }, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b"]);
  assert.equal(r.requests, 2);
  const f2 = fakeFetch(goodModel);
  await probeModel({ levels: [4], prior: "pppn", ...FREE, ...conn(f2) });
  assert.deepEqual(kinds(f2), ["3b"]);
  const f3 = fakeFetch(goodModel);
  const none = await probeModel({ levels: [1, 2], prior: "pppp", done: { 1: { v: "p" }, 2: { v: "p" } }, ...FREE, ...conn(f3) });
  assert.deepEqual([f3.calls.length, none.requests], [0, 0]);
});

test("ordering rules: L3, L4 and spawn and the error result need L1 and L2 passed; the big step needs L3; nothing deep is sent to a model that failed the pair", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "1" || kindOf(c) === "1f" ? ok(stream(ev.text(0, "no"), ev.stop())) : goodModel(c)));
  const r = await probeModel({ levels: [1, 2, 3, 4, 5, 6, 7], ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["1", "1f", "2"], "L1 failed (auto and forced): L2 still asked, nothing deep");
  assert.deepEqual(verdicts(r), { 1: "f", 2: "p", 3: "n", 4: "n", 5: "n", 6: "n", 7: "n" });
  assert.ok(f.calls.every((c) => c.bytes < 25000), "no large request was sent");
  const f2 = fakeFetch(goodModel);
  const r2 = await probeModel({ levels: [5], prior: "ppnn", ...FREE, ...conn(f2) });
  assert.deepEqual([f2.calls.length, r2.done[5].v], [0, "n"]);
  const f3 = fakeFetch(goodModel);
  const r3 = await probeModel({ levels: [3, 5], prior: "ppnn", ...FREE, ...conn(f3) });
  assert.deepEqual(kinds(f3), ["3a", "3b", "5"]);
  assert.deepEqual([r3.done[3].v, r3.done[5].v], ["p", "p"]);
});

test("cache_control: a 400 naming it is `cc` f, the SAME request is asked again without the markers (the level is still learned) and the model is never sent them again", async () => {
  const seen = [];
  const f = fakeFetch((c) => { seen.push([kindOf(c), JSON.stringify(c.body).includes("cache_control")]); return JSON.stringify(c.body).includes("cache_control") ? http(400, "system.0.cache_control: Extra inputs are not permitted") : goodModel(c); });
  const state = {};
  const r = await probeModel({ levels: [3, 4, 5], prior: "ppnn", state, ...FREE, ...conn(f) });
  assert.deepEqual(seen, [["3a", true], ["3a", false], ["3b", false], ["5", false]]);
  assert.deepEqual([r.done[3].v, r.done[3].cc, r.done[4].v, r.done[5].v, state.noCc], ["p", "f", "p", "p", true]);
  const f2 = fakeFetch(goodModel);
  const r2 = await probeModel({ levels: [3], prior: "ppnn", flags: { cc: "f" }, ...FREE, ...conn(f2) });
  assert.equal(f2.calls.some((c) => JSON.stringify(c.body).includes("cache_control")), false, "a stored cc f is honoured: no marker is sent");
  assert.equal(r2.done[3].cc, undefined, "and nothing new is claimed about it");
  const okAll = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(fakeFetch(goodModel)) });
  assert.equal(okAll.done[3].cc, "p", "accepted markers are `cc` p");
});

test("name round trip: `nm` comes from the constructs request (p / f); a 400 naming the tool name is `nm` f and the L3 schema verdict", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? http(400, "tools.0.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'") : goodModel(c)));
  const r = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual([r.done[3].v, r.done[3].nm, r.done[3].kind], ["f", "f", "schema"]);
  const wrong = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "3a" ? ok(stream(ev.tool(0, "mcp__plugin_demo__a_long", "{}"), ev.stop("tool_use"))) : goodModel(c)))) });
  assert.deepEqual([wrong.done[3].v, wrong.done[3].nm], ["p", "f"]);
});

test("FREE-KEYS-ONLY RULE in the engine: a model whose tier is not `free` (paid, free-deposit, management, UNLABELLED, null) is not probed AT ALL, at ANY level including L1 and L2: zero requests", async () => {
  for (const tier of ["paid", "free-deposit", "management", "subscription", "", undefined, null, "FREE", "free ", "gold"]) {
    for (const levels of [[1, 2], [1], [2], [3], [1, 2, 3, 4, 5, 6, 7]]) {
      const f = fakeFetch(goodModel), done = {};
      const r = await probeModel({ levels, prior: "nnnn", tier, done, ...conn(f) });
      assert.deepEqual(kinds(f), [], `tier ${JSON.stringify(tier)} levels ${levels}: not one request`);
      assert.equal(r.requests, 0);
      assert.deepEqual(r.clamped, levels, JSON.stringify(tier));
      assert.deepEqual([done[levels[0]].v, done[levels[0]].why, done[levels[0]].clamped], ["n", NOT_FREE_REASON, true]);
    }
    assert.equal(deepAllowed(tier), false);
  }
  const f = fakeFetch(goodModel);
  const free = await probeModel({ levels: [1, 2, 3, 5, 6], prior: "nnnn", tier: "free", ...conn(f) });
  assert.deepEqual([kinds(f), free.clamped], [["1", "1a", "2", "6", "3a", "3b", "5"], []]);
  const lifted = liftDeepProbes({ includeTiers: ["paid"], levelsExplicit: true, levels: [1, 2], live: true, maxSpendExplicit: true, printed: true }).lift;
  const g = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2], tier: "paid", lift: lifted, ...conn(g) });
  assert.deepEqual(kinds(g), ["1", "1a", "2"], "a LIFTED tier gets any level that was asked, L1 and L2 included: lifting them is the same lift");
});

test("nothing but a validated capability lifts the rule: a forged object, a plain flag, a copy of a real one, an empty object and a string do not", async () => {
  const real = liftDeepProbes({ includeTiers: ["paid"], levelsExplicit: true, levels: [3], live: true, maxSpendExplicit: true, printed: true });
  assert.equal(real.ok, true);
  assert.equal(deepAllowed("paid", real.lift), true);
  assert.equal(deepAllowed("free-deposit", real.lift), false, "only the tiers it names");
  assert.equal(deepAllowed("management", real.lift), false);
  for (const forged of [{ tiers: ["paid"] }, { tiers: Object.freeze(["paid"]) }, { ...real.lift }, JSON.parse(JSON.stringify(real.lift)), "paid", true, {}, null, undefined]) {
    assert.equal(deepAllowed("paid", forged), false, JSON.stringify(forged));
    const f = fakeFetch(goodModel);
    await probeModel({ levels: [3], prior: "ppnn", tier: "paid", lift: forged, ...conn(f) });
    assert.equal(f.calls.length, 0);
  }
  const f = fakeFetch(goodModel);
  await probeModel({ levels: [3], prior: "ppnn", tier: "paid", lift: real.lift, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b"], "the real capability works");
  assert.equal(LIFTS.has(real.lift), true);
  assert.equal(Object.isFrozen(real.lift) && Object.isFrozen(real.lift.tiers), true);
  assert.throws(() => { "use strict"; real.lift.tiers.push("management"); });
});

test("EARLY CANCEL: once the expected calls are closed and the usage is seen the stream is cancelled; a model that keeps emitting costs nothing more; without usage a few more events are read, then it stops", async () => {
  let pulled = 0, cancelled = false;
  const endless = async () => new Response(new ReadableStream({
    pull(c) {
      pulled += 1;
      const head = pulled === 1 ? ev.start(500) + ev.tool(0, "fx_echo", '{"message":"hello"}') + sse("message_delta", { type: "message_delta", delta: { stop_reason: null }, usage: { output_tokens: 30 } }) : "";
      c.enqueue(new TextEncoder().encode(head + sse("content_block_delta", { type: "content_block_delta", index: 5, delta: { type: "text_delta", text: "and more and more " } })));
      if (pulled > 100000) c.close();
    },
    cancel() { cancelled = true; },
  }), { status: 200 });
  const r = await runKind("1", conn(endless));
  assert.equal(r.v, "p");
  assert.ok(pulled <= 3, `stopped after ${pulled} reads`);
  assert.equal(cancelled, true, "the upstream stream was cancelled");
  assert.deepEqual([r.inTok, r.outTok, r.early], [500, 30, true], "usage was read before stopping");
  pulled = 0;
  const noUsage = async () => new Response(new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode((pulled === 1 ? ev.start() + ev.tool(0, "fx_echo", '{"message":"a"}') + ev.tool(1, "fx_echo", '{"message":"b"}') : "") + sse("ping", { type: "ping" }))); if (pulled > 100000) c.close(); } }), { status: 200 });
  const r2 = await runKind("3b", conn(noUsage));
  assert.equal(r2.v, "p");
  assert.ok(pulled < 120, `no usage event: it read ${pulled} chunks, then gave up waiting`);
  // a text answer (L2) is read to its end: the early cancel is for calls only
  const f = fakeFetch((c) => ok(stream(ev.text(0, `The code is ZK-7731-QX.`), ev.stop())));
  assert.equal((await runKind("2", conn(f))).br, "p");
});

test("a normal stream is read through message_stop; a call-less 3a answer in text is not cut short", async () => {
  const r = await runKind("3a", conn(fakeFetch(() => ok(stream(ev.text(0, "I will call it now. "), ev.text(1, "Done."), ev.stop())))));
  assert.equal(r.v, "p");
  assert.equal(r.early, false);
});

test("TELEMETRY: every request reports its bytes, time, kind and the usage the provider sent (input and output tokens) when it sent any", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "2" ? ok(streamWith(5300, ev.text(0, "ZK-7731-QX"), ev.stop("end_turn", 12))) : goodModel(c)));
  const r = await probeModel({ levels: [1, 2], ...FREE, ...conn(f) });
  const [t1, t1a, t2] = r.tele;
  assert.deepEqual([t1.kind, t1.level, t1.v], ["1", 1, "p"]);
  assert.deepEqual([t1a.kind, t1a.level, t1a.v], ["1a", 1, "p"], "the argument-fidelity request is part of level 1");
  assert.deepEqual([t2.kind, t2.level, t2.inTok, t2.outTok], ["2", 2, 5300, 12]);
  assert.ok(t1.bytes > 300 && t2.bytes > 19000 && Number.isFinite(t1.ms) && t1.inTok === null, "no usage reported: null, never guessed");
});

test("THINKING-ONLY escalation: the first empty answer is asked again ONCE with 2048 tokens, the model's later requests use 2048, and a pass after the bump is a verdict", async () => {
  const seen = [];
  const f = fakeFetch((c) => { seen.push(c.body.max_tokens); return c.body.max_tokens < 2048 ? ok(stream(thinking(0, "hmm"), ev.stop("max_tokens"))) : goodModel(c); });
  const state = {};
  const r = await probeModel({ levels: [1, 2], state, ...FREE, ...conn(f) });
  assert.deepEqual(seen, [256, 2048, 2048, 2048], "L1 at its 256 (empty), L1 again at 2048, then 1a and L2 straight at 2048");
  assert.deepEqual([r.done[1].v, r.done[2].v, r.requests, r.escalated], ["p", "p", 4, true]);
  assert.deepEqual({ ...state }, { escalated: true, maxTokens: 2048, requests: 4 });
  const kept = [];
  const f2 = fakeFetch((c) => { kept.push(c.body.max_tokens); return goodModel(c); });
  await probeModel({ levels: [1], state, done: {}, ...FREE, ...conn(f2) });
  assert.deepEqual(kept, [2048, 2048], "L1 and 1a: state kept by the caller across the engine's retries: no second bump, and no return to the small budget");
  assert.equal(ESCALATED_MAX_TOKENS, 2048);
});

test("THINKING-ONLY escalation: still empty after the bump is inconclusive `reasoning-budget` (never a failure), once per model; a budget already at the bump gets no bump; a real miss does not escalate", async () => {
  const seen = [];
  const f = fakeFetch((c) => { seen.push(c.body.max_tokens); return ok(stream(thinking(0, "hmm"), ev.stop("max_tokens"))); });
  const state = {};
  const r = await probeModel({ levels: [1, 2], state, ...FREE, ...conn(f) });
  assert.deepEqual(seen, [256, 2048]);
  assert.deepEqual([r.inconclusive.s, r.inconclusive.reason, r.inconclusive.escalated, r.requests], ["empty", "reasoning-budget", true, 2]);
  assert.equal(r.done, undefined, "nothing to record");
  seen.length = 0;
  const again = await probeModel({ levels: [1], state, ...FREE, ...conn(f) });
  assert.deepEqual(seen, [2048], "a second visit asks once at the raised budget and does not bump again");
  assert.equal(again.inconclusive.reason, "reasoning-budget");
  const high = [];
  const f3 = fakeFetch((c) => { high.push(c.body.max_tokens); return ok(stream(thinking(0, "hmm"), ev.stop("max_tokens"))); });
  const h = await probeModel({ levels: [1], state: {}, ...FREE, ...conn(f3, { maxTokens: 4096 }) });
  assert.deepEqual(high, [4096]);
  assert.deepEqual([h.inconclusive.reason, h.inconclusive.escalated], ["reasoning-budget", undefined]);
  const miss = [];
  const st = {};
  const m = await probeModel({ levels: [1], state: st, ...FREE, ...conn(fakeFetch((c) => { miss.push(c.body.max_tokens); return ok(stream(ev.text(0, "ping"), ev.stop())); })) });
  assert.deepEqual([miss.length, st.escalated, m.done[1].v], [2, undefined, "f"], "(auto, then forced: two requests, no escalation)");
});

test("BIG-FIRST order (a known context of 200,000 or more): the big step runs ahead of L3; a pass IMPLIES L3 (recorded, 3a and 3b skipped, the 40k saved); a failure then runs L3 to locate the cause", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [1, 2, 3, 5], order: "big-first", ctx: 256000, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["1", "1a", "2", "5"], "no 3a, no 3b");
  assert.deepEqual([r.done[5].v, r.done[3].v, r.done[3].implied], ["p", "p", "big"]);
  assert.ok(r.done[3].bytes > 390000);
  const fail = fakeFetch((c) => (kindOf(c) === "5" ? http(400, "request too large") : goodModel(c)));
  const r2 = await probeModel({ levels: [1, 2, 3, 5], order: "big-first", ctx: 256000, ...FREE, ...conn(fail) });
  assert.deepEqual(kinds(fail), ["1", "1a", "2", "5", "3a", "3b"], "the big step failed (a size refusal): L3 is asked to tell size from schema");
  assert.deepEqual([r2.done[5].v, r2.done[5].kind, r2.done[3].v], ["f", "size", "p"]);
  const small = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2, 3, 5], order: "big-first", ctx: 128000, ...FREE, ...conn(small) });
  assert.deepEqual(kinds(small), ["1", "1a", "2", "3a", "3b", "5"], "a context under 200,000 (or unknown) keeps the l3-first order");
  const unk = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2, 3, 5], order: "big-first", ctx: 0, ...FREE, ...conn(unk) });
  assert.deepEqual(kinds(unk), ["1", "1a", "2", "3a", "3b", "5"]);
  const l3 = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2, 3, 5], order: "l3-first", ctx: 256000, ...FREE, ...conn(l3) });
  assert.deepEqual(kinds(l3), ["1", "1a", "2", "3a", "3b", "5"]);
  const notDeep = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2, 3, 5], order: "big-first", ctx: 256000, tier: "paid", ...conn(notDeep) });
  assert.deepEqual(kinds(notDeep), [], "big-first cannot bypass the free-keys-only rule");
});

test("a hostile stream is bounded: too many blocks, events or bytes end the read with a failure instead of growing without limit", async () => {
  const blocks = Array.from({ length: STREAM_LIMITS.blocks + 5 }, (_, i) => ev.text(i, "x")).join("");
  const many = await runKind("3b", conn(fakeFetch(() => ok(stream(blocks, ev.stop())))));
  assert.deepEqual([many.v, many.kind], ["f", "schema"]);
  assert.match(many.why, /passed the size limits/);
  let sent = 0;
  const endless = async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new TextEncoder().encode(sse("ping", { type: "ping" }))); sent += 1; if (sent > 100000) c.close(); } }), { status: 200 });
  const t0 = Date.now();
  const e = await runKind("1", conn(endless));
  assert.equal(e.v, "f");
  assert.ok(sent < STREAM_LIMITS.events + 100, `stopped reading after ${sent} events`);
  assert.ok(Date.now() - t0 < 30000);
  let pulled = 0;
  const huge = async () => new Response(new ReadableStream({ pull(c) { pulled += 1; c.enqueue(new TextEncoder().encode(sse("ping", { pad: "z".repeat(100000) }))); if (pulled >= 60) c.close(); } }), { status: 200 });
  const big = await runKind("1", conn(huge));
  assert.equal(big.v, "f");
  assert.match(big.why, /passed the size limits/, "stopped for the byte limit, not for what the answer lacked");
  assert.ok(pulled < 40, `stopped reading after ${pulled} chunks of 100 KB (the limit is ${STREAM_LIMITS.bytes} bytes)`);
});

test("an abort drops the model without a verdict", async () => {
  const ac = new AbortController();
  const f = async () => { ac.abort(); throw new Error("aborted"); };
  assert.deepEqual(await probeModel({ levels: [1, 2], ...FREE, ...conn(f, { signal: ac.signal }) }), { aborted: true });
});

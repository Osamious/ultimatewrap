// The pattern-construct re-ask: a gateway that answers EMPTY (stop end_turn, 0 output tokens) to a request carrying one JSON-schema pattern (a path pattern ending in [^\0]+) says nothing about the model.
// The probe asks that request once more with every `pattern` keyword stripped; a pass is a PASS marked `pt` f, and the model's later requests go out without patterns. Offline: fake gateways.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { fakeFetch, goodModel, ok, ev, streamWith, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { probeModel, buildBody, stripPatterns, kindSize, MAX_MODEL_REQUESTS } from "../refresh/tool-fidelity-probe.mjs";
import { buildRecord, cleanFidelity, summaryOf, classOf, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { FIXTURE_ID } from "../refresh/tool-fidelity-fixture.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-06T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const kinds = (f) => f.calls.map(kindOf);
const empty = () => ok(streamWith(0, ev.stop("end_turn", 0)));
// the defect: the path pattern ending in [^\0]+ (JSON-escaped as [^\\0]) anywhere in the tools
const BAD = JSON.stringify("[^\\0]").slice(1, -1);
const hasBad = (c) => JSON.stringify(c.body.tools ?? []).includes(BAD);
const hasPattern = (c) => JSON.stringify(c.body.tools ?? []).includes('"pattern":"');
const silentOnBad = (c) => (hasBad(c) && kindOf(c) !== "1" && kindOf(c) !== "6" ? empty() : goodModel(c));

test("stripPatterns removes the pattern KEYWORD wherever it nests, keeps a PROPERTY named pattern, and does not touch its input", () => {
  const tools = [{ name: "t", input_schema: { type: "object", properties: {
    pattern: { type: "string", pattern: "^a$" },
    path: { type: "string", pattern: "^(?=.{1,5}$)[^\\0]+$" },
    list: { type: "array", items: { type: "string", pattern: "x" } },
    any: { anyOf: [{ type: "string", pattern: "y" }, { type: "null" }] },
    obj: { type: "object", properties: { name: { type: "string", pattern: "z" } }, additionalProperties: { type: "string", pattern: "w" } },
  } } }];
  const before = JSON.stringify(tools);
  const out = stripPatterns(tools);
  assert.equal(JSON.stringify(tools), before, "pure");
  const s = JSON.stringify(out);
  assert.equal(s.includes('"pattern":"'), false, "no pattern keyword left anywhere");
  assert.ok(out[0].input_schema.properties.pattern && out[0].input_schema.properties.pattern.type === "string", "the PROPERTY named pattern stays");
  assert.deepEqual(Object.keys(out[0].input_schema.properties).sort(), ["any", "list", "obj", "path", "pattern"]);
});

test("buildBody: the default body is byte for byte what it was (sizes, fixture id unchanged); noPat strips every pattern from the tools of 3a, 3b and the big step; the bad construct is in the default 3a, 3b and big", () => {
  for (const k of ["3a", "3b", "5"]) {
    assert.equal(hasBad({ body: buildBody(k, "p/m") }), true, `${k}: the construct is in the default request`);
    const stripped = buildBody(k, "p/m", undefined, { noPat: true });
    assert.equal(hasPattern({ body: stripped }), false, `${k}: no pattern in the stripped one`);
    assert.equal(JSON.stringify({ ...stripped, tools: 0 }), JSON.stringify({ ...buildBody(k, "p/m"), tools: 0 }), `${k}: nothing else differs`);
    assert.equal(kindSize(k).bytes, Buffer.byteLength(JSON.stringify(buildBody(k, "provider/model"))), `${k}: the planner measures the default body`);
  }
  assert.equal(FIXTURE_ID, "cc-tools-2", "the fixture id is unchanged: no mass outdating");
});

test("a gateway empty for the bad construct: 3a is asked without the cache markers, then without the patterns (a pass), then the full request once more (empty again: pt f CONFIRMED); 3b follows with no patterns (one request, no re-ask) and passes with pt f", async () => {
  const f = fakeFetch(silentOnBad);
  const state = {};
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", state, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a", "3a", "3a", "3b"]);
  assert.deepEqual(f.calls.map(hasPattern), [true, true, false, true, false], "the full request, the one without markers (patterns still in), the one without patterns, the full one again (the flake check), then 3b without patterns");
  assert.equal(JSON.stringify(f.calls[1].body).includes("cache_control"), false, "the cache re-ask is unchanged");
  assert.equal(JSON.stringify(f.calls[2].body).includes("cache_control"), true, "the markers are back for the pattern re-ask: they were not the cause");
  assert.equal(JSON.stringify(f.calls[3].body).includes("cache_control"), true, "and for the flake check: the markers as they were");
  assert.deepEqual([r.done[3].v, r.done[3].pt, r.done[3].cc, r.done[4]?.v], ["p", "f", "p", "p"]);
  assert.equal(state.noPat, true);
  assert.equal(r.done[3].why, undefined);
  assert.ok(state.requests <= MAX_MODEL_REQUESTS);
});

test("the big step follows with noPat: one request, pt f; a model whose stored record says pt f is not sent the pattern at the big step at all", async () => {
  const f = fakeFetch(silentOnBad);
  const r = await probeModel({ levels: [3, 5], prior: "ppnn", state: {}, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a", "3a", "3a", "3b", "5"]);
  assert.equal(hasPattern(f.calls[5]), false);
  assert.deepEqual([r.done[3].pt, r.done[5].v, r.done[5].pt], ["f", "p", "f"]);
  const g = fakeFetch(silentOnBad);
  const s = await probeModel({ levels: [5], prior: "pppn", flags: { pt: "f" }, state: {}, ...FREE, ...conn(g) });
  assert.deepEqual(kinds(g), ["5"], "asked once, without patterns, from the stored marker");
  assert.deepEqual([s.done[5].v, s.done[5].pt], ["p", "f"]);
});

test("big-first: an empty big answer is re-asked without patterns; a pass implies L3 and both carry pt f", async () => {
  const f = fakeFetch(silentOnBad);
  const r = await probeModel({ levels: [3, 5], prior: "ppnn", order: "big-first", ctx: 300000, state: {}, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["5", "5"]);
  assert.deepEqual([r.done[5].v, r.done[5].pt, r.done[3].v, r.done[3].implied, r.done[3].pt], ["p", "f", "p", "big", "f"]);
});

test("a model that is empty for another reason still fails: all three 3a requests are empty, no pt, the failure stands, the markers and patterns come back; an answer that spent output tokens is not re-asked", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? empty() : goodModel(c)));
  const state = {};
  const r = await probeModel({ levels: [3], prior: "ppnn", state, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a", "3a"]);
  assert.deepEqual([r.done[3].v, r.done[3].pt, state.noPat, state.noCc], ["f", undefined, false, false]);
  assert.match(r.done[3].why, /^\[3a\] empty answer to the constructs request/);
  // the answer cost output tokens (out=3): not the silent-gateway shape, no pattern re-ask
  const g = fakeFetch((c) => (kindOf(c) === "3a" ? ok(streamWith(40210, ev.stop("end_turn", 3))) : goodModel(c)));
  await probeModel({ levels: [3], prior: "ppnn", state: {}, ...FREE, ...conn(g) });
  assert.equal(g.calls.some((c) => kindOf(c) === "3a" && !hasPattern(c)), false, "never asked without patterns");
  // a model that answers normally is never asked twice and carries pt p
  const h = fakeFetch(goodModel);
  const ok3 = await probeModel({ levels: [3], prior: "ppnn", state: {}, ...FREE, ...conn(h) });
  assert.deepEqual([kinds(h).length, ok3.done[3].pt], [2, "p"], "the full request passed: pt p");
});

test("no extra ask when the pattern is not the cause: 3a passed WITH patterns then 3b is empty: one request, the failure stands; 3b passed with patterns then the big step is empty: one request; a stored pt p does the same; 3a not tested in this run keeps the re-ask", async () => {
  const g = fakeFetch((c) => (kindOf(c) === "3b" ? empty() : goodModel(c)));
  const a = await probeModel({ levels: [3], prior: "ppnn", state: {}, ...FREE, ...conn(g) });
  assert.deepEqual(kinds(g), ["3a", "3b"], "3b is not asked a second time");
  assert.deepEqual([a.done[3].v, a.done[3].pt, a.done[3].why.startsWith("[3b] empty")], ["f", undefined, true]);
  const f = fakeFetch((c) => (kindOf(c) === "5" ? empty() : goodModel(c)));
  const r = await probeModel({ levels: [3, 5], prior: "ppnn", state: {}, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b", "5"], "3a and 3b passed with the patterns: the big step is not asked a second time");
  assert.deepEqual([r.done[3].pt, r.done[5].v, r.done[5].pt], ["p", "f", undefined]);
  const stored = fakeFetch((c) => (kindOf(c) === "5" ? empty() : goodModel(c)));
  await probeModel({ levels: [5], prior: "pppn", flags: { pt: "p" }, state: {}, ...FREE, ...conn(stored) });
  assert.deepEqual(kinds(stored), ["5"], "a stored pt p: the pattern passed before, no extra ask");
  const untested = fakeFetch((c) => (kindOf(c) === "5" ? empty() : goodModel(c)));
  await probeModel({ levels: [5], prior: "pppn", state: {}, ...FREE, ...conn(untested) });
  assert.deepEqual(kinds(untested), ["5", "5"], "no pattern result for this model: the big step is asked with and without");
});

test("flake control: the first full answers are empty at random, the stripped request passes, the full request asked once more PASSES: the level passes with pt p (no f), the patterns stay on for 3b", async () => {
  let n = 0;
  const f = fakeFetch((c) => (kindOf(c) === "3a" && ++n <= 2 ? empty() : goodModel(c)));
  const state = {};
  const r = await probeModel({ levels: [3, 4], prior: "ppnn", state, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a", "3a", "3a", "3b"]);
  assert.deepEqual(f.calls.map(hasPattern), [true, true, false, true, true], "the third request is the stripped one, the fourth the full one: it passed, so 3b is sent with the patterns");
  assert.deepEqual([r.done[3].v, r.done[3].pt, r.done[4]?.v, state.noPat, !!state.patFail], ["p", "p", "p", false, false]);
  assert.ok(state.requests <= MAX_MODEL_REQUESTS);
  // a flake at 3b does not get another ask: 3a passed with the patterns
  const g = fakeFetch((c) => (kindOf(c) === "3b" ? empty() : goodModel(c)));
  await probeModel({ levels: [3], prior: "ppnn", state: {}, ...FREE, ...conn(g) });
  assert.equal(kinds(g).length, 2);
});

test("an extra ask that cannot be answered (the request ceiling, a timeout) returns the ORIGINAL failure, not request-cap or timeout: the model is recorded failed as before", async () => {
  const cap = fakeFetch((c) => (kindOf(c) === "5" ? empty() : goodModel(c)));
  const a = await probeModel({ levels: [5], prior: "pppn", state: { requests: MAX_MODEL_REQUESTS - 1 }, ...FREE, ...conn(cap) });
  assert.deepEqual(kinds(cap), ["5"], "the extra ask was refused by the ceiling, never sent");
  assert.equal(a.inconclusive, undefined, JSON.stringify(a.inconclusive));
  assert.deepEqual([a.done[5].v, a.done[5].why.startsWith("empty answer to the large request")], ["f", true]);
  const base = fakeFetch((c) => (kindOf(c) === "5" ? empty() : goodModel(c)));
  const hang = (url, init) => {
    const call = { body: JSON.parse(init.body) };
    if (kindOf(call) === "5" && !hasPattern(call)) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    return base(url, init);
  };
  const b = await probeModel({ levels: [5], prior: "pppn", state: {}, ...FREE, ...conn(hang, { timeouts: { small: 40, "157": 40, big: 40 } }) });
  assert.equal(b.inconclusive, undefined, "a timeout of the extra ask is not the model's timeout");
  assert.deepEqual([b.done[5].v, b.done[5].why.startsWith("empty answer to the large request")], ["f", true]);
});

test("recheckPattern: a stored pt f is ignored, the patterns go out; a pass writes pt p and drops the f; a re-confirmed failure keeps pt f", async () => {
  const fixed = fakeFetch(goodModel);
  const a = await probeModel({ levels: [3], prior: "pppp", flags: { pt: "f" }, recheckPattern: true, state: {}, ...FREE, ...conn(fixed) });
  assert.deepEqual(f_has(fixed), [true, true], "3a and 3b both carry the patterns");
  assert.deepEqual([a.done[3].v, a.done[3].pt], ["p", "p"]);
  const silent = fakeFetch(silentOnBad);
  const b = await probeModel({ levels: [3], prior: "pppp", flags: { pt: "f" }, recheckPattern: true, state: {}, ...FREE, ...conn(silent) });
  assert.deepEqual([b.done[3].v, b.done[3].pt], ["p", "f"], "still silent on the construct: pt f again");
  const normal = fakeFetch(silentOnBad);
  const c = await probeModel({ levels: [5], prior: "pppp", flags: { pt: "f" }, state: {}, ...FREE, ...conn(normal) });
  assert.deepEqual([f_has(normal), c.done[5].pt], [[false], "f"], "without the flag the stored f keeps the patterns off");
  // the record: what the probe saw replaces the stored marker
  const base = buildRecord(null, { 1: { v: "p" }, 2: { v: "p" }, 3: { v: "p", pt: "f" }, 4: { v: "p" } }, { now: NOW });
  assert.equal(base.pt, "f");
  assert.equal(buildRecord(base, { 3: { v: "p", pt: "p" } }, { now: NOW }).pt, "p", "a clean pass drops the f");
  assert.equal(buildRecord(base, { 3: { v: "p", pt: "f" } }, { now: NOW }).pt, "f", "a re-confirmed failure keeps it");
});
const f_has = (f) => f.calls.map(hasPattern);


test("the request ceiling holds: the worst case (everything empty, big-first, every level asked) stays under it and the count includes the extra asks", async () => {
  const f = fakeFetch((c) => (["3a", "5"].includes(kindOf(c)) ? empty() : goodModel(c)));
  const state = {};
  const r = await probeModel({ levels: [1, 2, 3, 5, 6, 7], prior: "nnnn", order: "big-first", ctx: 300000, state, ...FREE, ...conn(f) });
  assert.equal(r.done[3].v, "f");
  assert.equal(f.calls.length, state.requests, "every request sent is counted");
  assert.ok(state.requests <= MAX_MODEL_REQUESTS, `${state.requests} requests against the ceiling of ${MAX_MODEL_REQUESTS}`);
  assert.equal(state.requests, 10, "L1, L1a, L2, L6, L7 (5), the big step twice (2), 3a three times (3)");
  // the other worst case: the stripped requests PASS and the full one is empty again at the flake check: 3a four times, 3b and the big step once each, so 5 + 4 + 1 + 1 = 11 requests
  const h = fakeFetch(silentOnBad);
  const hs = {};
  const hr = await probeModel({ levels: [1, 2, 3, 5, 6, 7], prior: "nnnn", state: hs, ...FREE, ...conn(h) });
  assert.deepEqual([hr.done[3].pt, hr.done[5].pt], ["f", "f"]);
  assert.equal(hs.requests, 11, "L1, L1a, L2, L6, L7 (5), 3a four times (4), 3b (1), the big step (1)");
  assert.ok(hs.requests <= MAX_MODEL_REQUESTS);
  // at the ceiling the extra ask is refused, never sent: the model ends inconclusive (request-cap), not failed
  const g = fakeFetch(silentOnBad);
  const capped = await probeModel({ levels: [3], prior: "ppnn", state: { requests: MAX_MODEL_REQUESTS - 2 }, ...FREE, ...conn(g) });
  assert.ok(capped.inconclusive?.reason === "request-cap" || capped.done?.[3]?.v === "f", "no request past the ceiling");
  assert.ok(g.calls.length <= 2);
});

test("the marker is not part of lvr and does not change the class: pt f on a passing L3 leaves class v; the record keeps it, a clean pass says p, and f wins over p", () => {
  const done = { 1: { v: "p" }, 2: { v: "p" }, 3: { v: "p", pt: "f", bytes: 157000 }, 4: { v: "p" } };
  const rec = buildRecord(null, done, { now: NOW });
  const clean = buildRecord(null, { ...done, 3: { v: "p", pt: "p", bytes: 157000 } }, { now: NOW });
  assert.equal(rec.pt, "f");
  assert.equal(clean.pt, "p");
  assert.deepEqual([rec.lvr, rec.t], [clean.lvr, clean.t], "the same lvr and the same class");
  assert.equal(classOf({ lvr: rec.lvr }), rec.t);
  const both = buildRecord(null, { ...done, 3: { v: "p", pt: "p" }, 5: { v: "p", pt: "f", bytes: 400000 } }, { now: NOW });
  assert.equal(both.pt, "f", "f wins");
  // a probe that does not look at L3 keeps the stored marker
  const kept = buildRecord(rec, { 6: { v: "p" } }, { now: NOW });
  assert.equal(kept.pt, "f");
  // the reader tolerates it and rejects nonsense; the summary says it
  const store = JSON.parse(JSON.stringify({ models: { "p/a": rec } }));
  assert.equal(cleanFidelity(store.models["p/a"]).pt, "f");
  assert.equal(cleanFidelity({ ...rec, pt: "x" }), null, "a pt that is not p or f is not a record");
  assert.equal(cleanFidelity({ ...record("pppp"), pt: undefined }).pt, undefined, "absent stays absent");
  assert.equal(summaryOf(rec).pt, "f");
  assert.match(summaryOf(rec).notes.join(" "), /pattern construct made the answer empty/);
  assert.equal(summaryOf(clean).notes.some((n) => /pattern/.test(n)), false);
});

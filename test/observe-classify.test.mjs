// Live status C3, section B: row -> event classification, key derivation, the per-key state machine and the overlay writer.
// Pure functions on hand-made rows, plus runs against a TEMP sqlite and a TEMP state directory (never the real ones).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { classifyEvent, applyEvents, deriveKey, pruneOverlay, mergedView, readOverlay, writeAtomicRetry, sweepTmp, buildProv, findBakeBench } from "../refresh/observe.mjs";
import { mkEnv, writeBench, fake, fakeCore, T0, NOW, iso, epoch } from "./fixtures/observe-fixture.mjs";
import { redactClip } from "../menu/redact.mjs";

const ROUTES = ["prov/m1", "prov/m2", "prov/m3", "prov/m4", "other/x", "third/y", "anthropic/claude-sonnet-5", "nvidia/nvidia/x", "nvidia/y", "prov/m1[1m]"];
const ctx = { routeSet: new Set(ROUTES), probeClient: "uw-probe", nowS: epoch(NOW) };
const row = (o = {}) => ({ id: 1, created_at: iso(T0), request_id: "r1", client: "Profile: Claude Code", provider: "prov", model: "m1",
  status_code: 200, duration_ms: 500, output_tokens: 5, ...o });
const info = (o = {}) => ({ msg: "", code: "", typ: "", st: "", error: "", gerr: "", ...o });
const ev = (o, i) => classifyEvent(row(o), i ?? null, ctx);

// ----------------------------------------------------------------- one case per status of the plan's F9 list

const CASES = [
  ["200 with output", { status_code: 200 }, null, { kind: "ok", s: "ok" }],
  ["200 with 0 output tokens", { status_code: 200, output_tokens: 0 }, null, { skip: "zeroTok" }],
  ["429", { status_code: 429 }, null, { kind: "hard", s: "rate" }],
  ["429 saying the balance is empty", { status_code: 429 }, info({ msg: "Insufficient credits. Please top up your balance." }), { kind: "hard", s: "pay" }],
  ["402", { status_code: 402 }, null, { kind: "hard", s: "pay" }],
  ["401", { status_code: 401 }, null, { kind: "hard", s: "auth" }],
  ["403 (auth)", { status_code: 403 }, null, { kind: "hard", s: "auth" }],
  ["403 (pay text)", { status_code: 403 }, info({ msg: "Insufficient credits, please add funds." }), { kind: "hard", s: "pay" }],
  ["404", { status_code: 404 }, null, { kind: "hard", s: "gone" }],
  ["410", { status_code: 410 }, null, { kind: "hard", s: "gone" }],
  ["400 with no message", { status_code: 400 }, null, { skip: "ignored400" }],
  ["400 saying the model does not exist", { status_code: 400 }, info({ msg: "The model `gpt-9-mini` does not exist" }), { kind: "hard", s: "gone" }],
  ["400 tool-schema text", { status_code: 400 }, info({ msg: "tools.0.input_schema: JSON schema is invalid" }), { skip: "ignored400" }],
  ["413", { status_code: 413 }, null, { skip: "ignored400" }],
  ["422", { status_code: 422 }, null, { skip: "ignored400" }],
  ["499 client abort", { status_code: 499 }, null, { skip: "abort499" }],
  ["500", { status_code: 500 }, null, { kind: "amb", s: "error" }],
  ["502", { status_code: 502 }, null, { kind: "amb", s: "error" }],
  ["502 with an empty body (the chain threw)", { status_code: 502 }, info(), { kind: "amb", s: "error" }],
  ["503", { status_code: 503 }, null, { kind: "amb", s: "error" }],
  ["529", { status_code: 529 }, null, { kind: "amb", s: "error" }],
  ["504", { status_code: 504 }, null, { kind: "amb", s: "timeout" }],
  ["522", { status_code: 522 }, null, { kind: "amb", s: "timeout" }],
  ["524", { status_code: 524 }, null, { kind: "amb", s: "timeout" }],
  ["5xx whose text says the model was removed", { status_code: 500 }, info({ msg: "Model 'command-r' was removed on September 15" }), { kind: "hard", s: "gone" }],
  ["a status the plan does not name", { status_code: 408 }, null, { skip: "otherStatus" }],
  ["a probe row", { status_code: 429, client: "uw-probe" }, null, { skip: "probe" }],
  ["a row 10 minutes in the future", { created_at: iso(NOW + 600_000) }, null, { skip: "skew" }],
  ["a row with no usable time", { created_at: "garbage" }, null, { skip: "badRow" }],
];
for (const [name, r, i, want] of CASES) {
  test(`classify: ${name}`, () => {
    const e = ev(r, i);
    for (const [k, v] of Object.entries(want)) assert.equal(e[k], v, `${name}: ${k}`);
  });
}

test("an event carries the time of completion, the duration, the output tokens and the sanitized request id", () => {
  const e = ev({ created_at: iso(T0), duration_ms: 2500, output_tokens: 7, request_id: "abc\u001b[31m-1" });
  assert.equal(e.a, epoch(T0) + 2);
  assert.equal(e.d, 2500);
  assert.equal(e.o, 7);
  assert.equal(e.q, "abc-1");
});

// ----------------------------------------------------------------- keys

test("key: anthropic resolves to one key whether the router says claude-sonnet-5 or anthropic/claude-sonnet-5", () => {
  assert.equal(deriveKey("anthropic", "claude-sonnet-5", ctx.routeSet), "anthropic/claude-sonnet-5");
  assert.equal(deriveKey("anthropic", "anthropic/claude-sonnet-5", ctx.routeSet), "anthropic/claude-sonnet-5");
});

test("key: nvidia tries provider/model first, so a real nvidia/x id is not blindly stripped", () => {
  assert.equal(deriveKey("nvidia", "nvidia/x", ctx.routeSet), "nvidia/nvidia/x");
  assert.equal(deriveKey("nvidia", "nvidia/y", new Set(["nvidia/y"])), "nvidia/y", "a route that is the stripped form");
  assert.equal(deriveKey("nvidia", "y", ctx.routeSet), "nvidia/y");
});

test("key: the [1m] suffix is dropped and an unknown model is null", () => {
  assert.equal(deriveKey("prov", "m1[1m]", ctx.routeSet), "prov/m1");
  assert.equal(deriveKey("prov", "nope", ctx.routeSet), null);
  assert.equal(deriveKey("", "m1", ctx.routeSet), null);
  assert.equal(ev({ model: "nope" }).skip, "unknownKey");
});

// ----------------------------------------------------------------- what is stored

test("classification reads the FULL sentence: a decisive phrase beyond character 160 still says pay, and the stored clip is 160 characters", () => {
  const msg = `${"x".repeat(200)} Insufficient credits`;
  const e = ev({ status_code: 429 }, info({ msg }));
  assert.equal(e.s, "pay");
  assert.ok(e.m.length <= 160);
  assert.doesNotMatch(e.m, /Insufficient/);
});

test("raw classification input (code, type, status, gateway text) never appears in the event", () => {
  const e = ev({ status_code: 429 }, info({ msg: "boom", code: "SECRET_CODE_99", typ: "SECRET_TYPE_99", st: "SECRET_ST_99", error: "SECRET_ERR_99", gerr: "SECRET_GERR_99" }));
  assert.doesNotMatch(JSON.stringify(e), /SECRET_/);
  assert.equal(e.m, "boom");
});

test("a code alone can classify (json_extract's $.error.code) while the stored message stays the fallback", () => {
  const e = ev({ status_code: 500 }, info({ code: "model_not_found" }));
  assert.equal(e.s, "gone");
  assert.equal(e.m, "HTTP 500 (provider message not kept)");
});

test("the stored message is redacted: a key shape and a URL do not survive, and it is clipped to 160", () => {
  const e = ev({ status_code: 429 }, info({ msg: `bad key ${fake("sk")} at https://evil.example.com/path?token=${"abc" + "1234567"}` }));
  assert.ok(!e.m.includes(fakeCore("sk")), "the key is masked");
  assert.doesNotMatch(e.m, /evil.example/);
  assert.ok(ev({ status_code: 429 }, info({ msg: "y".repeat(500) })).m.length <= 160);
});

test("no message keeps the fixed fallback text", () => {
  assert.equal(ev({ status_code: 429 }, null).m, "HTTP 429 (provider message not kept)");
});

test("no regex literal in observe.mjs duplicates a classifier pattern", () => {
  const body = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "refresh", "observe.mjs"), "utf8");
  assert.doesNotMatch(body, /insufficient|not found|rate.?limit/i);
});

// ----------------------------------------------------------------- the state machine

const run = (rows, opts = {}) => {
  const events = rows.map((r) => classifyEvent(row(r), r.info ?? null, ctx)).filter((e) => !e.skip);
  events.sort((x, y) => x.a - y.a || x.id - y.id);
  const state = { models: opts.models ?? {}, pend: opts.pend ?? {} };
  const out = applyEvents(events, { ...state, benchGet: opts.benchGet ?? (() => null), providerOkRecent: opts.providerOkRecent ?? (() => false), nowS: ctx.nowS });
  return { ...state, ...out };
};
const at = (s) => iso(T0 + s * 1000);
let n = 0;
const f = (status, s, o = {}) => ({ id: (n += 1), status_code: status, created_at: at(s), request_id: `q${n}`, ...o });

test("hard signals act at once: 429 rate, 402 pay, 401 auth, 404 gone", () => {
  for (const [status, s] of [[429, "rate"], [402, "pay"], [401, "auth"], [404, "gone"]]) {
    const r = run([f(status, 0)]);
    assert.equal(r.models["prov/m1"].s, s);
    assert.equal(r.models["prov/m1"].l, 1);
  }
});

test("one 502 marks nothing; it is remembered as the first failure", () => {
  const r = run([f(502, 0)]);
  assert.deepEqual(r.models, {});
  assert.equal(r.pend["prov/m1"].n, 1);
});

test("two 502 within 10 s are a retry burst: nothing is marked and the first failure is kept", () => {
  const r = run([f(502, 0), f(502, 10)]);
  assert.deepEqual(r.models, {});
  assert.equal(r.skip.retry, 1);
  assert.equal(r.pend["prov/m1"].a, epoch(T0));
});

test("two 502 three minutes apart mark the model error and clear the pending failure", () => {
  const r = run([f(502, 0), f(502, 180)]);
  assert.equal(r.models["prov/m1"].s, "error");
  assert.equal(r.models["prov/m1"].m, "2 failures >= 2 min apart, no 200 between: HTTP 502");
  assert.equal(r.models["prov/m1"].a, epoch(T0) + 180);
  assert.deepEqual(r.pend, {});
});

test("two 504 three minutes apart mark the model timeout", () => {
  assert.equal(run([f(504, 0), f(504, 180)]).models["prov/m1"].s, "timeout");
});

test("two failures 1 s apart straddling a 5-minute boundary are a retry burst, not two failures; exactly 120 s apart they are two", () => {
  const burst = run([f(502, 299), f(502, 300)]);
  assert.deepEqual(burst.models, {});
  assert.equal(burst.skip.retry, 1);
  assert.equal(run([f(502, 10), f(502, 129)]).skip.retry, 1, "119 s is still a burst");
  assert.equal(run([f(502, 10), f(502, 130)]).models["prov/m1"].s, "error", "exactly 120 s counts");
});

test("two 502 a day and an hour apart are two first failures: the second replaces the first", () => {
  const r = run([f(502, -25 * 3600), f(502, 0)]);
  assert.deepEqual(r.models, {});
  assert.equal(r.pend["prov/m1"].a, epoch(T0));
});

test("502, 200, 502: the 200 between them resets the count", () => {
  const r = run([f(502, 0), f(200, 60), f(502, 400)]);
  assert.equal(r.models["prov/m1"].s, "ok");
  assert.equal(r.pend["prov/m1"].a, epoch(T0) + 400, "a fresh first failure, not a second");
});

test("502 then 429 takes the hard class and clears the pending failure", () => {
  const r = run([f(502, 0), f(429, 200)]);
  assert.equal(r.models["prov/m1"].s, "rate");
  assert.deepEqual(r.pend, {});
});

test("a repeated request id counts once", () => {
  const r = run([f(502, 0, { request_id: "same" }), f(502, 200, { request_id: "same" })]);
  assert.deepEqual(r.models, {});
  assert.equal(r.skip.dupId, 1);
});

test("an already error/timeout record is refreshed, and a same-class repeat inside 6 h is a duplicate", () => {
  const prior = { "prov/m1": { s: "error", a: epoch(T0) - 60, l: 1, m: "x" } };
  assert.equal(run([f(502, 0)], { models: structuredClone(prior) }).skip.dup, 1);
  const r = run([f(504, 0)], { models: structuredClone(prior) });
  assert.equal(r.models["prov/m1"].s, "timeout", "a different class replaces it at once");
});

test("gateway outage guard: 502 on three different providers inside one minute is the gateway, not the models", () => {
  const r = run([f(502, 0), f(502, 5, { provider: "other", model: "x" }), f(502, 10, { provider: "third", model: "y" })]);
  assert.equal(r.skip.outage, 3);
  assert.deepEqual(r.models, {});
  assert.deepEqual(r.pend, {}, "the dropped failures do not even count as first failures");
});

test("the outage guard does not apply when a model answered 200 in the same minute", () => {
  const r = run([f(502, 0), f(502, 5, { provider: "other", model: "x" }), f(502, 10, { provider: "third", model: "y" }), f(200, 12, { model: "m2" })]);
  assert.equal(r.skip.outage ?? 0, 0);
  assert.equal(Object.keys(r.pend).length, 3);
});

test("provider-wide 404: three models of one provider with no message become ambiguous errors when the provider recently worked", () => {
  const rows = [f(404, 0), f(404, 1, { model: "m2" }), f(404, 2, { model: "m3" })];
  const guarded = run(rows, { providerOkRecent: () => true });
  assert.deepEqual(guarded.models, {});
  assert.equal(Object.keys(guarded.pend).length, 3);
  const plain = run(rows.map((r) => ({ ...r, request_id: `p${r.id}` })), { providerOkRecent: () => false });
  assert.deepEqual(Object.values(plain.models).map((r) => r.s), ["gone", "gone", "gone"]);
});

test("provider-wide 404 guard needs no 200 for the provider in the run, and no message", () => {
  const withOk = run([f(404, 0), f(404, 1, { model: "m2" }), f(404, 2, { model: "m3" }), f(200, 3, { model: "m4" })], { providerOkRecent: () => true });
  assert.equal(withOk.models["prov/m1"].s, "gone");
  const said = info({ msg: "no such model" });
  const withMsg = run([f(404, 10, { info: said }), f(404, 11, { model: "m2", info: said }), f(404, 12, { model: "m3", info: said })], { providerOkRecent: () => true });
  assert.equal(withMsg.models["prov/m1"].s, "gone");
});

test("a provider-wide 404 wave that repeats 400 s later becomes an error carrying the path/base-URL note", () => {
  const rows = [f(404, 0), f(404, 1, { model: "m2" }), f(404, 2, { model: "m3" }), f(404, 400)];
  const r = run(rows, { providerOkRecent: () => true });
  assert.equal(r.models["prov/m1"].s, "error");
  assert.match(r.models["prov/m1"].m, /404 across 3 models of prov: path or base URL\?/);
});

test("ok over ok writes nothing (a real reply preview must not be replaced by an empty one)", () => {
  const benchGet = () => ({ s: "ok", a: epoch(T0) - 100, p: "hello there" });
  const r = run([f(200, 0)], { benchGet });
  assert.deepEqual(r.models, {});
  assert.equal(r.skip.okSeen, 1);
});

test("a failing -> ok flip writes the record and asks for a confirmation; never for anthropic; never for a never-benched key", () => {
  const failing = () => ({ s: "rate", a: epoch(T0) - 100 });
  const flip = run([f(200, 0)], { benchGet: failing });
  assert.deepEqual(flip.models["prov/m1"], { s: "ok", d: 500, a: epoch(T0), q: flip.models["prov/m1"].q, l: 1, o: 5, cf: 1, cfa: ctx.nowS });
  assert.deepEqual(flip.confirm, ["prov/m1"]);
  const anth = run([f(200, 0, { provider: "anthropic", model: "claude-sonnet-5" })], { benchGet: failing });
  assert.equal(anth.models["anthropic/claude-sonnet-5"].s, "ok");
  assert.equal(anth.models["anthropic/claude-sonnet-5"].cf, undefined);
  assert.deepEqual(anth.confirm, []);
  const fresh = run([f(200, 0)]);
  assert.equal(fresh.models["prov/m1"].cf, undefined);
  assert.deepEqual(fresh.confirm, []);
});

test("an event not newer than the probe record is stale and changes nothing", () => {
  const r = run([f(429, 0)], { benchGet: () => ({ s: "ok", a: epoch(T0) + 5 }) });
  assert.deepEqual(r.models, {});
  assert.equal(r.skip.stale, 1);
});

test("a same-class hard failure inside 6 h with the same message is a duplicate; after 6 h it is written again", () => {
  const prior = { "prov/m1": { s: "rate", a: epoch(T0) - 3600, l: 1, m: "HTTP 429 (provider message not kept)" } };
  assert.equal(run([f(429, 0)], { models: structuredClone(prior) }).skip.dup, 1);
  const old = { "prov/m1": { s: "rate", a: epoch(T0) - 7 * 3600, l: 1, m: "HTTP 429 (provider message not kept)" } };
  assert.equal(run([f(429, 0)], { models: old }).models["prov/m1"].a, epoch(T0));
});

// ----------------------------------------------------------------- overlay maintenance

test("pruning: unknown keys, entries not newer than the probe record, entries over 14 days, then the oldest above 800", () => {
  const t = epoch(NOW);
  const models = {
    "prov/m1": { s: "rate", a: t - 10 },
    "gone/model": { s: "rate", a: t - 10 },
    "prov/m2": { s: "rate", a: t - 100 },
    "prov/m3": { s: "rate", a: t - 15 * 86400 },
  };
  const benchGet = (k) => (k === "prov/m2" ? { s: "ok", a: t - 50 } : null);
  const pend = { a: { a: t - 25 * 3600 }, b: { a: t - 60 } };
  const conf = { x: t - 8 * 86400, y: t - 100 };
  pruneOverlay({ models, pend, conf }, { routeSet: ctx.routeSet, benchGet, nowS: t });
  assert.deepEqual(Object.keys(models), ["prov/m1"]);
  assert.deepEqual(Object.keys(pend), ["b"]);
  assert.deepEqual(Object.keys(conf), ["y"]);
  const many = {};
  const routes = new Set();
  for (let i = 0; i < 900; i++) { many[`k/${i}`] = { s: "rate", a: t - 1000 + i }; routes.add(`k/${i}`); }
  pruneOverlay({ models: many, pend: {}, conf: {} }, { routeSet: routes, benchGet: () => null, nowS: t });
  assert.equal(Object.keys(many).length, 800);
  assert.ok(many["k/899"] && !many["k/0"], "the oldest went");
});

test("the merged view: the newer record wins, a tie goes to the probe, and the age stamp is the probe's only", () => {
  const bench = { "a/1": { s: "ok", a: 100 }, "a/2": { s: "ok", a: 100 } };
  const benchGet = (k) => bench[k] ?? null;
  benchGet.stamp = (k) => bench[k]?.a ?? null;
  const g = mergedView(benchGet, { "a/1": { s: "rate", a: 200, l: 1 }, "a/2": { s: "rate", a: 100, l: 1 }, "a/3": { s: "rate", a: 300, l: 1 } });
  assert.equal(g("a/1").s, "rate");
  assert.equal(g("a/2").s, "ok", "a tie goes to the probe");
  assert.equal(g("a/3").s, "rate", "an overlay-only key is visible");
  assert.equal(g.stamp("a/3"), null, "and gives no age credit");
  assert.equal(g.stamp("a/1"), 100);
  assert.equal(g.isLive("a/1"), true);
  assert.equal(g.isLive("a/2"), false);
});

test("writeAtomicRetry retries only EPERM/EBUSY/EACCES, succeeds on a later try, gives up quietly after five, and rethrows the rest", () => {
  let calls = 0;
  const eperm = () => { calls += 1; if (calls < 3) throw Object.assign(new Error("x"), { code: "EPERM" }); };
  assert.deepEqual(writeAtomicRetry("f", "t", { write: eperm, sleep: () => {} }), { ok: true, tries: 3 });
  calls = 0;
  const always = () => { calls += 1; throw Object.assign(new Error("x"), { code: "EBUSY" }); };
  const r = writeAtomicRetry("f", "t", { write: always, sleep: () => {} });
  assert.equal(r.ok, false);
  assert.equal(calls, 5);
  assert.throws(() => writeAtomicRetry("f", "t", { write: () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, sleep: () => {} }), /full/);
});

test("stale observed.json.tmp-* debris older than five minutes is swept; a fresh one and other files stay", async () => {
  const e = await mkEnv();
  const old = path.join(e.stateDir, "observed.json.tmp-111");
  const fresh = path.join(e.stateDir, "observed.json.tmp-222");
  const other = path.join(e.stateDir, "bench.json.tmp-333");
  for (const p of [old, fresh, other]) fs.writeFileSync(p, "x");
  const past = new Date(Date.now() - 10 * 60000);
  fs.utimesSync(old, past, past);
  fs.utimesSync(other, past, past);
  assert.equal(sweepTmp(e.stateDir), 1);
  assert.deepEqual(fs.readdirSync(e.stateDir).sort(), ["bench.json.tmp-333", "observed.json.tmp-222"]);
});

// ----------------------------------------------------------------- the whole run, on a temp database

test("a batch delivered in id order but created_at-reversed is sorted before the state machine", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 502, created_at: at(300), request_id: "late" });      // lower id, later time
  e.u.insert({ status_code: 502, created_at: at(0), request_id: "early" });
  const r = await e.run();
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "error");
  assert.equal(r.wouldWrite.length, 1);
});

test("the drift tripwire: more than half of the non-anthropic rows unknown says key mapping changed; anthropic rows do not count", async () => {
  const e = await mkEnv();
  await e.init();
  for (let i = 0; i < 12; i++) e.u.insert({ model: `unknown-${i}`, request_id: `u${i}` });
  assert.equal((await e.run()).feed, "warn:key-mapping");
  assert.equal(readOverlay(e.P.overlay).feed, "warn:key-mapping");
  const g = await mkEnv();
  await g.init();
  for (let i = 0; i < 12; i++) g.u.insert({ provider: "anthropic", model: `mystery-${i}`, request_id: `a${i}` });
  for (let i = 0; i < 10; i++) g.u.insert({ request_id: `k${i}` });
  assert.equal((await g.run()).feed, "ok");
  const h = await mkEnv();
  await h.init();
  for (let i = 0; i < 3; i++) h.u.insert({ model: `unknown-${i}`, request_id: `u${i}` });
  assert.equal((await h.run()).feed, "ok", "a handful of unknown rows is noise, not a drift");
});

test("the overlay is written only when its content changes: a run with nothing new leaves observed.json byte-identical, observed.run moves", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429, request_id: "x1" });
  await e.run();
  const before = fs.readFileSync(e.P.overlay, "utf8");
  const stat = fs.statSync(e.P.overlay).mtimeMs;
  const r = await e.run({ nowMs: NOW + 60_000 });
  assert.equal(r.changed, false);
  assert.equal(fs.readFileSync(e.P.overlay, "utf8"), before);
  assert.equal(fs.statSync(e.P.overlay).mtimeMs, stat);
  assert.equal(JSON.parse(fs.readFileSync(e.P.run, "utf8")).ranAt, iso(NOW + 60_000));
});

test("the overlay has the plan's shape, and ranAt and per-run stats are NOT in it", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429, request_id: "x1", duration_ms: 412 });
  await e.run();
  const o = readOverlay(e.P.overlay);
  assert.deepEqual(Object.keys(o), ["schema", "writtenAt", "feed", "wm", "tagId", "models", "pend", "conf", "confDay"]);
  assert.equal(o.writtenAt, iso(NOW));
  assert.deepEqual(o.models["prov/m1"], { s: "rate", d: 412, a: epoch(T0) + 2, q: "x1", l: 1, m: "HTTP 429 (provider message not kept)" });
  assert.equal(o.wm.id, 2);
  assert.equal(typeof o.wm.at, "string");
});

test("prov: baked per provider through the seam when bakeBench is available, absent otherwise", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429, request_id: "x1" });
  e.u.insert({ status_code: 429, request_id: "x2", model: "m2" });
  const bake = (row, get) => ({ bench: { n: row.models.length, m1: get(`${row.provider}/m1`)?.s }, benchFlags: { alive: false }, benchAgeHist: [] });
  await e.run({ bake });
  const o = readOverlay(e.P.overlay);
  assert.deepEqual(Object.keys(o.prov), ["prov.key"], "only providers that have an overlay record");
  assert.deepEqual(o.prov["prov.key"], { bench: { n: 4, m1: "rate" }, benchFlags: { alive: false }, benchAgeHist: [], live: 2, liveOk: 0 });
  const g = await mkEnv();
  await g.init();
  g.u.insert({ status_code: 429 });
  await g.run({ bake: null });
  assert.equal("prov" in readOverlay(g.P.overlay), false);
});

test("findBakeBench returns a function once a picker module exports bakeBench, and null until then (the seam)", async () => {
  const b = await findBakeBench();
  assert.ok(b === null || typeof b === "function");
});

test("buildProv counts live records and how many of them are ok, per provider", () => {
  const rows = [{ keyId: "p.key", provider: "p", models: [{ id: "a" }, { id: "b" }, { id: "c" }] }];
  const benchGet = (k) => (k === "p/c" ? { s: "ok", a: 500 } : null);
  const models = { "p/a": { s: "ok", a: 100, l: 1 }, "p/b": { s: "rate", a: 100, l: 1 }, "p/c": { s: "rate", a: 50, l: 1 } };
  const prov = buildProv(rows, models, benchGet, () => ({ bench: null, benchFlags: null, benchAgeHist: [] }), NOW);
  assert.equal(prov["p.key"].live, 2, "p/c is beaten by the newer probe record");
  assert.equal(prov["p.key"].liveOk, 1);
});

// ----------------------------------------------------------------- the probe view vs the merged view (loadBench now merges the overlay)

test("two runs: a winning overlay entry survives a run with no new events, and is dropped once a probe record newer than it exists", async () => {
  const e = await mkEnv();
  writeBench(e.benchFile, { "prov/m1": { s: "ok", a: epoch(T0) - 3600 } });
  await e.init();
  e.u.insert({ status_code: 429, request_id: "win" });
  await e.run();
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "rate", "run 1 wrote a winning entry");
  const r2 = await e.run({ nowMs: NOW + 60_000 });
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "rate", "run 2, nothing new, keeps it (the merged reader must not be read as the probe)");
  assert.equal(r2.changed, false);
  writeBench(e.benchFile, { "prov/m1": { s: "ok", a: epoch(NOW) + 120 } });          // a sweep probed it after the observation
  await e.run({ nowMs: NOW + 120_000 });
  assert.deepEqual(readOverlay(e.P.overlay).models, {}, "older than the probe record: dropped");
});

test("a skip probe record is not a measurement: a live record beats it whatever the timestamps, and is not pruned by it", async () => {
  const e = await mkEnv();
  writeBench(e.benchFile, { "prov/m1": { s: "skip", w: "spend-cap", a: epoch(T0) + 100_000 } });
  await e.init();
  e.u.insert({ status_code: 429, request_id: "vs-skip" });
  await e.run();
  const rec = readOverlay(e.P.overlay).models["prov/m1"];
  assert.equal(rec.s, "rate", "the event is not stale against a NEWER skip record");
  await e.run({ nowMs: NOW + 60_000 });
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "rate", "and the next run does not prune it");
});

test("a skip probe record is absent for the effective record, the prune and the merged view", () => {
  const t = epoch(NOW);
  const skipNewer = (k) => (k === "prov/m1" ? { s: "skip", w: "x", a: t + 100 } : null);
  skipNewer.stamp = () => null;
  const r = run([f(200, 0)], { benchGet: skipNewer });
  assert.equal(r.models["prov/m1"].s, "ok", "an ok is written over a newer skip (no flip: nothing measured before)");
  assert.equal(r.models["prov/m1"].cf, undefined);
  const models = { "prov/m1": { s: "rate", a: t - 10 } };
  pruneOverlay({ models, pend: {}, conf: {} }, { routeSet: ctx.routeSet, benchGet: skipNewer, nowS: t });
  assert.deepEqual(Object.keys(models), ["prov/m1"]);
  const g = mergedView(skipNewer, { "prov/m1": { s: "rate", a: t - 10, l: 1 } }, NOW);
  assert.equal(g("prov/m1").s, "rate");
  assert.equal(g.isLive("prov/m1"), true);
  assert.equal(g.stamp("prov/m1"), null);
  const noOverlay = mergedView(skipNewer, {}, NOW);
  assert.equal(noOverlay("prov/m1").s, "skip", "with nothing live the probe's skip is what there is");
});

test("the merged view ignores a live record dated in the future, as loadBench does", () => {
  const b = () => ({ s: "ok", a: 100 });
  const g = mergedView(b, { "a/1": { s: "rate", a: epoch(NOW) + 3600, l: 1 } }, NOW);
  assert.equal(g("a/1").s, "ok");
});

// ----------------------------------------------------------------- review round: tight anchors for live text (HIGH-1), what is stored (SEC-M1)

const TIGHT = [
  ["400 echoing an MCP tool named purchase_item", 400, "tool purchase_item is not available in this workspace", { skip: "ignored400" }],
  ["400 echoing an MCP tool named billing_lookup", 400, "unknown tool billing_lookup", { skip: "ignored400" }],
  ["422 tools.1.description too long naming billing_lookup", 422, "tools.1.description too long; tool 'billing_lookup'", { skip: "ignored400" }],
  ["400 about output tokens for balance-sonnet", 400, "max output tokens for balance-sonnet exceeded", { skip: "ignored400" }],
  ["413 that mentions quota", 413, "request too large for the quota of this tier", { skip: "ignored400" }],
  ["502 Upstream load balancer error (balancer is not balance)", 502, "Upstream load balancer error", { kind: "amb", s: "error" }],
  ["503 Rate limit exceeded is one failing gateway, not a hard rate", 503, "Rate limit exceeded", { kind: "amb", s: "error" }],
  ["502 balance check service unavailable", 502, "balance check service unavailable, retry", { kind: "amb", s: "error" }],
  ["504 with throttling words stays a timeout", 504, "too many requests", { kind: "amb", s: "timeout" }],
  ["400 saying the balance is empty is a tight pay anchor", 400, "Insufficient credits. Please top up your balance.", { kind: "hard", s: "pay" }],
  ["500 with an account-state sentence is a tight auth anchor", 500, "insufficient permissions for this model", { kind: "hard", s: "auth" }],
  ["422 saying the model does not exist is a tight gone anchor", 422, "The model `gpt-9-mini` does not exist", { kind: "hard", s: "gone" }],
];
for (const [name, status, msg, want] of TIGHT) {
  test(`tight anchors: ${name}`, () => {
    const e = ev({ status_code: status }, info({ msg }));
    for (const [k, v] of Object.entries(want)) assert.equal(e[k], v, `${name}: ${k}`);
    if (e.m) assert.equal(e.m, `HTTP ${status} (provider message not kept)`, "a class that came from reclassifying a non-hard status never stores the sentence");
  });
}

test("the sweep classification is unchanged: classifyHttp still reads loose payment words, and 'balancer' is no longer a balance", async () => {
  const { classifyHttp } = await import("../refresh/bench.mjs");
  assert.equal(classifyHttp(402, "anything"), "pay");
  assert.equal(classifyHttp(400, "please purchase a plan"), "pay");
  assert.equal(classifyHttp(503, "Insufficient balance, top up"), "pay");
  assert.equal(classifyHttp(500, "your balance is empty"), "pay");
  assert.equal(classifyHttp(502, "Upstream load balancer error"), "error", "the fix: balancer is not balance");
  assert.equal(classifyHttp(429, "slow down"), "rate");
  assert.equal(classifyHttp(404, "nothing here"), "gone");
});

test("the provider sentence is stored ONLY for 401/402/403/404/410/429; every other status keeps the fixed text", () => {
  for (const status of [401, 402, 403, 404, 410, 429]) {
    const e = ev({ status_code: status }, info({ msg: "Provider says: check your key" }));
    assert.equal(e.m, "Provider says: check your key", String(status));
    assert.equal(e.msgPresent, true);
  }
  for (const status of [400, 413, 422, 500, 502, 503, 504, 529]) {
    const e = ev({ status_code: status }, info({ msg: "Insufficient credits. Please top up your balance. Provider says: check your key" }));
    assert.equal(e.m, `HTTP ${status} (provider message not kept)`, String(status));
    assert.equal(e.msgPresent, false);
  }
});

test("a pydantic-style 422 and a JSON-parse-snippet 400 never put the echoed input in a record, even when an anchor makes them hard", () => {
  const pyd = "1 validation error for Request messages.0.content Input should be a valid string [type=string_type, input_value='SECRET-CONVERSATION-TEXT', input_type=str]";
  const json = "Unexpected token 'S', \"SECRET-CONVERSATION-TEXT\" is not valid JSON";
  assert.equal(ev({ status_code: 422 }, info({ msg: pyd })).skip, "ignored400");
  assert.equal(ev({ status_code: 400 }, info({ msg: json })).skip, "ignored400");
  for (const [status, msg] of [[422, `${pyd} model does not exist`], [400, `${json} Insufficient credits`], [500, `${pyd} model_not_found`]]) {
    const e = ev({ status_code: status }, info({ msg }));
    assert.equal(e.kind, "hard");
    assert.equal(e.m, `HTTP ${status} (provider message not kept)`);
    assert.doesNotMatch(JSON.stringify(e), /SECRET-CONVERSATION-TEXT/);
  }
});

// ----------------------------------------------------------------- review round: state machine

test("a 200 or a hard failure that is dropped as stale still clears the pending failure", () => {
  const pend = () => ({ "prov/m1": { n: 1, s: "error", a: epoch(T0) - 500, q: "old" } });
  const probe = () => ({ s: "ok", a: epoch(T0) + 5 });
  const ok = run([f(200, 0)], { pend: pend(), benchGet: probe });
  assert.equal(ok.skip.stale, 1);
  assert.deepEqual(ok.pend, {});
  const hard = run([f(429, 0)], { pend: pend(), benchGet: probe });
  assert.equal(hard.skip.stale, 1);
  assert.deepEqual(hard.pend, {});
  const amb = run([f(502, 0)], { pend: pend(), benchGet: probe });
  assert.equal(Object.keys(amb.pend).length, 1, "an ambiguous stale event does not clear it");
});

test("outage guard is a sliding window: a 2+1 burst across a minute boundary is one outage; three spread over 80 s are not", () => {
  const split = run([f(502, 59), f(502, 61, { provider: "other", model: "x" }), f(502, 65, { provider: "third", model: "y" })]);
  assert.equal(split.skip.outage, 3);
  assert.deepEqual(split.pend, {});
  const spread = run([f(502, 0), f(502, 40, { provider: "other", model: "x" }), f(502, 80, { provider: "third", model: "y" })]);
  assert.equal(spread.skip.outage ?? 0, 0);
  assert.equal(Object.keys(spread.pend).length, 3);
  const withOk = run([f(502, 59), f(502, 61, { provider: "other", model: "x" }), f(502, 65, { provider: "third", model: "y" }), f(200, 100, { model: "m2" })]);
  assert.equal(withOk.skip.outage ?? 0, 0, "an ok within a minute of the burst says the gateway was up");
});

test("the tripwire ignores rows with no provider", async () => {
  const e = await mkEnv();
  await e.init();
  for (let i = 0; i < 12; i++) e.u.insert({ provider: i % 2 ? null : "", model: `unknown-${i}`, request_id: `n${i}` });
  assert.equal((await e.run()).feed, "ok");
});

test("prov.liveOk counts only UNVERIFIED live oks: a probe-confirmed record (v:1) is live but not a live ok", () => {
  const rows = [{ keyId: "p.key", provider: "p", models: [{ id: "a" }, { id: "b" }, { id: "c" }] }];
  const models = { "p/a": { s: "ok", a: 100, l: 1, v: 1 }, "p/b": { s: "ok", a: 100, l: 1 }, "p/c": { s: "rate", a: 100, l: 1 } };
  const prov = buildProv(rows, models, () => null, () => ({ bench: null, benchFlags: null, benchAgeHist: [] }), NOW);
  assert.equal(prov["p.key"].live, 3);
  assert.equal(prov["p.key"].liveOk, 1, "p/a is verified, p/c is not ok");
});

test("the runtime-built fake secrets really are the shapes redactClip masks", () => {
  for (const kind of ["sk", "hf", "bearer", "keyed"]) {
    const masked = redactClip(`prefix ${fake(kind)} suffix`, 200);
    assert.equal(masked.includes(fakeCore(kind)), false, `${kind}: redactClip masks it`);
  }
});

test("the runtime-built fake secrets really are the shapes redactClip masks", () => {
  for (const kind of ["sk", "hf", "bearer", "keyed"]) {
    const masked = redactClip(`prefix ${fake(kind)} suffix`, 200);
    assert.equal(masked.includes(fakeCore(kind)), false, `${kind}: redactClip masks it`);
  }
});

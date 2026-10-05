// The tool-fidelity CLI end to end, offline: a fixture snapshot and bench, a fake gateway, a temp state directory.
// Nothing real is read or written (guardRealState), and nothing goes on the network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { freshDir, fakeFetch, ev, stream, ok, http, goodModel, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, parseLevels, plan, printPlan, liveRefusal, runIncremental } from "../refresh/tool-fidelity-cli.mjs";
import { loadFidelity, saveFidelity, buildRecord, probeSet, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";

guardRealState(after, assert);
after(() => { assert.equal(rawExists(REAL_FILE), false, "state/tool-fidelity.json must not exist after the tests"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const world = () => {
  const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
  const rows = [
    { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN", pin: 3, pout: 15 })] },
    { provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3", { tools: false }), m("auto")] },
    { provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 1, pout: 4 }), m("b2", { badge: "PAID", pin: 2, pout: 8 }), m("b3", { badge: null, pin: null, pout: null })] },
  ];
  const good = (a = 1790699779) => ({ s: "ok", t: 400, a });
  const b = Object.fromEntries(["anthropic/claude-x", "fa/a1", "fa/a2", "fa/a3", "fa/auto", "pb/b1", "pb/b2", "pb/b3"].map((k) => [k, good()]));
  return { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => b[k] ?? null } };
};

function env(extra = {}) {
  const dir = freshDir();
  const w = world();
  const benchFile = path.join(dir, "bench.json");
  fs.writeFileSync(benchFile, JSON.stringify({ schema: 1, models: { "fa/a1": { s: "ok", a: 1 } } }));
  const f = fakeFetch(extra.answer ?? goodModel);
  const deps = { ...w, outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f,
    now: () => NOW, isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1, ...extra.deps };
  return { dir, deps, f, benchFile, out: deps.outFile, ...w };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const probeCalls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const listing = (d) => fs.readdirSync(d).sort();

test("arguments: levels parse as digits 1-5 once each (5 is the big step); caps are positive numbers; --l3 needs `yes`; an empty --only is refused", () => {
  assert.deepEqual(parseLevels("12"), [1, 2]);
  assert.deepEqual(parseLevels("4,3"), [3, 4]);
  assert.deepEqual(parseLevels("1+2+3+4"), [1, 2, 3, 4]);
  assert.deepEqual(parseLevels("5"), [5]);
  assert.deepEqual(parseLevels("354"), [3, 4, 5]);
  for (const bad of ["", "6", "0", "112", "ab", "1 6"]) assert.equal(parseLevels(bad), null, JSON.stringify(bad));
  const o = parseArgs([]);
  assert.deepEqual([o.live, o.levels, o.tfMaxTokens, o.maxSpend, o.maxRowCost, o.force, o.l3], [false, [1, 2], 150000, 5, 0.1, false, false]);
  assert.ok(parseArgs(["--levels", "9"]).error);
  assert.equal(parseArgs(["--retry-failed"]).retryFailed, true);
  assert.ok(parseArgs(["--retry-failed", "--force"]).error, "they contradict each other");
  assert.ok(parseArgs(["--l3"]).error);
  assert.ok(parseArgs(["--l3", "maybe"]).error);
  assert.ok(parseArgs(["--only", ","]).error);
  assert.ok(parseArgs(["--limit", "0"]).error);
  assert.ok(parseArgs(["--tf-max-tokens-per-provider", "1.5"]).error);
  assert.ok(parseArgs(["--tf-max-tokens-per-provider", "-3"]).error);
  assert.ok(parseArgs(["--frobnicate"]).error);
  const full = parseArgs(["--live", "--only", "fa,pb/b1", "--limit", "5", "--levels", "34", "--l3", "yes", "--force", "--tf-max-tokens-per-provider", "9000", "--max-spend", "1"]);
  assert.deepEqual([full.live, full.only, full.limit, full.levels, full.l3, full.force, full.tfMaxTokens, full.maxSpend], [true, ["fa", "pb/b1"], 5, [3, 4], true, true, 9000, 1]);
});

test("DRY RUN (the default): prints the counts with denominators and the estimates, sends nothing, writes nothing, takes no lock", async () => {
  const e = env();
  const before = listing(e.dir), hb = sha(e.benchFile);
  const r = await run([], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(e.f.calls, [], "not one request, not even a health check");
  assert.deepEqual(listing(e.dir), before, "no file or lock was created");
  assert.equal(sha(e.benchFile), hb);
  assert.match(r.out, /DRY RUN, nothing is sent/);
  assert.match(r.out, /models: 8 probe-ok; 1 Anthropic relay model\(s\) not probed \(provenance: known good\); 7 in the probe set/);
  assert.match(r.out, /with a record: 0 of 7; with a record against the current fixture: 0 of 7/);
  assert.match(r.out, /tools:false in the probe set: 1 of 7 .*probed like the rest/);
  assert.match(r.out, /context length unknown: 0 of 7 model\(s\) in the probe set/);
  assert.match(r.out, /7 model\(s\) queued of 7/);
  assert.match(r.out, /requests 14 /);
  assert.match(r.out, /free tier 4 model\(s\): no money; paid tier 3 model\(s\): estimate \$/);
  assert.match(r.out, /no request was made\. Re-run with --live to probe\./);
  assert.ok(!/\b(D-a[a-z]|QB-\d+|CQ\d|G[1-7]\b)/.test(r.out), "plan ids are not user-visible");
});

test("DRY RUN with levels 3 and 4 prints the large-request estimate BEFORE anything is spent, and says what a live run needs", async () => {
  const e = env();
  saveFidelity(e.out, Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, buildRecord(null, { 1: { v: "p" }, 2: { v: "p" } }, { now: NOW })])), { now: NOW });
  const r = await run(["--levels", "34"], e.deps);
  assert.equal(r.code, 0);
  assert.match(r.out, /requests 4 /, "the default per-provider cap of 150,000 input tokens fits 2 models of 2 large requests each, per provider");
  assert.match(r.out, /whole queue, before the cap: 14 requests, ~5\d\dk input tokens/);
  assert.match(r.out, /L3 and L4 each send ~15\d KB \(~39k input tokens\) per request/);
  assert.match(r.out, /needs --l3 yes and --only/);
  assert.equal(e.f.calls.length, 0);
});

test("the dry run's counts follow the store: with a record, against the CURRENT fixture, against an older one (not queued), and the cap", async () => {
  const e = env();
  saveFidelity(e.out, { "fa/a1": record("ppnn"), "fa/a2": record("ffnn", { strikes: 2, sl: 1 }), "pb/b1": record("ppnn", { fx: "cc-tools-0" }) }, { now: NOW });
  const h = sha(e.out);
  const r = await run(["--tf-max-tokens-per-provider", "600"], e.deps);
  assert.match(r.out, /with a record: 3 of 7; with a record against the current fixture: 2 of 7; against an older fixture: 1 \(a recommendation to re-sweep, not queued\)/);
  assert.match(r.out, /4 model\(s\) queued of 7/);
  assert.match(r.out, /3 fit the per-provider cap of 600 input tokens, 1 wait for the next run|\d fit the per-provider cap of 600/);
  assert.equal(sha(e.out), h, "the dry run did not touch the store");
});

test("a corrupt or foreign tool-fidelity.json stops the run before anything is planned or sent, and is never overwritten", async () => {
  const e = env();
  fs.writeFileSync(e.out, "{broken");
  const h = sha(e.out);
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /is corrupt; it is not touched/);
  assert.equal(sha(e.out), h);
  assert.equal(e.f.calls.length, 0);
  fs.writeFileSync(e.out, JSON.stringify({ schema: 1, models: { "fa/a1": { s: "ok", a: 1 } } }));
  const r2 = await run(["--live"], e.deps);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /schema/);
});

test("--live refusals: levels 3 and 4 need --l3 yes AND a named provider or an explicit cap; an estimate over the spend cap refuses to start; each sends nothing", async () => {
  const e = env();
  saveFidelity(e.out, Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, buildRecord(null, { 1: { v: "p" }, 2: { v: "p" } }, { now: NOW })])), { now: NOW });
  const a = await run(["--live", "--levels", "34"], e.deps);
  assert.equal(a.code, 2); assert.match(a.err, /add --l3 yes/);
  const b = await run(["--live", "--levels", "34", "--l3", "yes"], e.deps);
  assert.equal(b.code, 2); assert.match(b.err, /named provider subset \(--only\) or an explicit cap/);
  const e2 = env();
  const c = await run(["--live", "--max-spend", "0.0000001", "--max-row-cost", "1"], e2.deps);
  assert.equal(c.code, 2); assert.match(c.err, /the estimate \$[\d.]+ is above the cap \$0\.0000?001?|above the cap/);
  assert.equal(e.f.calls.length + e2.f.calls.length, 0, "refused before the gateway was even asked");
  assert.ok(!fs.existsSync(e2.deps.lockFile));
});

test("--live L1+L2: every probe-ok model gets a record, the relay does not, nothing else is written; the report says what happened", async () => {
  const e = env();
  const hb = sha(e.benchFile);
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const calls = probeCalls(e.f);
  assert.equal(calls.length, 14, "2 requests x 7 models");
  assert.ok(!calls.some((c) => c.body.model.startsWith("anthropic/")), "the relay is never probed");
  const s = loadFidelity(e.out);
  assert.equal(s.ok, true);
  assert.deepEqual(Object.keys(s.models).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto", "pb/b1", "pb/b2", "pb/b3"]);
  for (const rec of Object.values(s.models)) assert.deepEqual([rec.lvr, rec.t, rec.ok, rec.fx], ["ppnn", "t", true, "cc-tools-1"]);
  assert.equal(s.models["fa/auto"].alias, true, "a pool alias is marked");
  assert.equal(s.models["fa/a3"].t, "t", "the tools:false model passed and is recorded as it behaved");
  assert.equal(s.generatedAt, NOW.toISOString());
  assert.equal(sha(e.benchFile), hb, "bench data untouched");
  assert.deepEqual(listing(e.dir), ["bench.json", FILE_NAME], "no lock left behind, no temp debris");
  assert.match(r.out, /7 record\(s\) written/);
  assert.match(r.out, /now: with a record 7 of 7 probe-ok \(8 incl\. relay not probed\); against the current fixture 7 of 7; still queued 0/);
});

test("AUTOMATIC INCREMENTAL: a second run probes NOTHING (every model has a record); a newly discovered model is the only one asked", async () => {
  const e = env();
  await run(["--live"], e.deps);
  e.f.calls.length = 0;
  const again = await run(["--live"], e.deps);
  assert.equal(again.code, 0);
  assert.match(again.out, /nothing to probe/);
  assert.equal(e.f.calls.length, 0, "no request at all, not even a health check");
  // a newly discovered probe-ok model
  const fresh = JSON.parse(JSON.stringify(e.snapshot));
  fresh.snap.rows[1].models.push({ id: "a-new", outModality: "chat", tools: true, pin: 0, pout: 0, badge: "FREE" });
  const bench = { get: (k) => (k === "fa/a-new" ? { s: "ok", a: 1790699779 } : e.bench.get(k)) };
  const third = await run(["--live"], { ...e.deps, snapshot: fresh, bench });
  assert.equal(third.code, 0, third.err);
  assert.deepEqual(probeCalls(e.f).map((c) => c.body.model), ["fa/a-new", "fa/a-new"], "only the new model, its 2 small requests");
  assert.ok(loadFidelity(e.out).models["fa/a-new"]);
});

test("a record against an OUTDATED fixture is NOT re-queued by a run (its `*` is a recommendation); --force re-asks it", async () => {
  const e = env();
  const old = buildRecord(null, { 1: { v: "p" }, 2: { v: "p" } }, { now: NOW, fixtureId: "cc-tools-0" });
  const all = Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, old]));
  saveFidelity(e.out, all, { now: NOW });
  const r = await run(["--live"], e.deps);
  assert.match(r.out, /nothing to probe/);
  assert.equal(e.f.calls.length, 0);
  const f = await run(["--live", "--force", "--only", "fa/a1"], e.deps);
  assert.equal(f.code, 0, f.err);
  assert.equal(probeCalls(e.f).length, 2);
  assert.equal(loadFidelity(e.out).models["fa/a1"].fx, "cc-tools-1", "re-swept: now against the current fixture");
  assert.equal(loadFidelity(e.out).models["fa/a2"].fx, "cc-tools-0", "the others keep their older record");
});

test("a model with a record is never re-probed by the incremental pass, whatever its result", async () => {
  const e = env();
  const recs = Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, record("ffnn", { strikes: 2, sl: 1 })]));
  saveFidelity(e.out, recs, { now: NOW });
  const r = await run(["--live"], e.deps);
  assert.match(r.out, /nothing to probe/);
  assert.equal(e.f.calls.length, 0, "failed models are not asked again by an ordinary run");
});

test("TWO STRIKES end to end: a first failure is provisional and asked again by the next run, the second CONFIRMS it as x; an account or rate failure is never recorded", async () => {
  const e = env({ answer: (c) => {
    const m = c.body.model;
    if (m === "fa/a2") return c.body.tool_choice ? ok(stream(ev.text(0, "nope"), ev.stop())) : goodModel(c);
    if (m === "pb/b1") return http(402, "payment required");
    if (m === "pb/b2") return http(429, "slow down");
    return goodModel(c);
  } });
  const r = await run(["--live"], e.deps);
  let s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a2"].lvr, s["fa/a2"].t, s["fa/a2"].ok, s["fa/a2"].strikes, s["fa/a2"].sl], ["nnnn", "u", false, 1, 1], "first strike: untested, not x");
  assert.match(s["fa/a2"].why, /^L1: answered in text/);
  assert.equal(s["pb/b1"], undefined, "402 is the account's state, not a verdict about the model");
  assert.equal(s["pb/b2"], undefined, "429 neither");
  assert.ok(s["pb/b3"] && s["fa/a1"]);
  assert.match(r.out, /failed once, asked again next run 1/);
  assert.match(r.out, /not recorded \(they stay queued; a refusal about the account is not a verdict on the model\): .*\b(pay|rate) \d/);
  assert.match(r.out, /still queued 3\b/, "a2 (one strike), b1 and b2");
  const second = await run(["--live", "--only", "fa"], e.deps);
  assert.equal(second.code, 0, second.err);
  s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a2"].lvr, s["fa/a2"].t, s["fa/a2"].ok, s["fa/a2"].strikes], ["fpnn", "x", false, 2], "second strike at the same level: confirmed");
  assert.deepEqual(probeCalls(e.f).filter((c) => c.body.model === "fa/a2").length, 4, "a2: 2 requests per run, 2 runs");
  e.f.calls.length = 0;
  const third = await run(["--live", "--only", "fa"], e.deps);
  assert.match(third.out, /nothing to probe/, "a confirmed failure is not asked again by an ordinary run");
  const next = await run(["--live", "--only", "pb"], { ...e.deps, fetch: fakeFetch(goodModel) });
  assert.equal(next.code, 0, next.err);
  assert.ok(loadFidelity(e.out).models["pb/b1"], "the next run picks the two up and records them");
});

test("FREE TIER FIRST: every free-model request is sent before any paid-model request", async () => {
  const e = env();
  await run(["--live"], e.deps);
  const order = probeCalls(e.f).map((c) => c.body.model);
  const paidFirst = order.findIndex((m) => m.startsWith("pb/"));
  assert.ok(paidFirst > 0);
  assert.ok(order.slice(0, paidFirst).every((m) => m.startsWith("fa/")) && order.slice(paidFirst).every((m) => m.startsWith("pb/")), order.join(" "));
});

test("the per-provider token cap: a provider stops at the cap, the rest wait for the next run, and the next run continues where it stopped", async () => {
  const e = env();
  const r = await run(["--live", "--tf-max-tokens-per-provider", "600"], e.deps);
  assert.equal(r.code, 0, r.err);
  const first = Object.keys(loadFidelity(e.out).models).sort();
  assert.deepEqual(first, ["fa/a1", "fa/a2", "pb/b1", "pb/b2"], "2 models (574 tokens) per provider fit 600; the next one of each does not");
  assert.match(r.out, /3 model\(s\) waited for the per-provider cap of 600 input tokens: run again to continue/);
  const r2 = await run(["--live", "--tf-max-tokens-per-provider", "600"], e.deps);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(Object.keys(loadFidelity(e.out).models).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto", "pb/b1", "pb/b2", "pb/b3"], "covered over two runs");
  assert.equal(probeCalls(e.f).length, 14, "no model was asked twice across the runs");
});

test("L3 and L4 on named models: --l3 yes --only; L4 passing with L3 failing writes lvr ppfp and the file compiles it as `t`", async () => {
  const e = env({ answer: (c) => (c.bytes > 150000 && !/twice/.test(String(c.body.messages[0].content)) ? http(413, "request entity too large") : goodModel(c)) });
  const first = await run(["--live"], e.deps);
  assert.equal(first.code, 0);
  e.f.calls.length = 0;
  const r = await run(["--live", "--levels", "34", "--l3", "yes", "--only", "fa/a1"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const calls = probeCalls(e.f);
  assert.deepEqual(calls.map((c) => c.body.model), ["fa/a1", "fa/a1"]);
  assert.ok(calls.every((c) => c.bytes > 150000), "both are the large fixture; L1 and L2 were not asked again");
  const rec = loadFidelity(e.out).models["fa/a1"];
  assert.equal(rec.lvr, "ppfp");
  assert.equal(rec.t, "t", "compiles as t");
  assert.equal(rec.lv, 1);
  assert.match(rec.why, /^L3: HTTP 413/);
  assert.ok(rec.maxBytes > 150000);
  assert.equal(loadFidelity(e.out).models["fa/a2"].lvr, "ppnn", "the other models are untouched");
});

test("L3 and L4 are not sent to a model that failed L1 or L2 (it costs no 40,000 tokens), even when named", async () => {
  const e = env();
  saveFidelity(e.out, { "fa/a1": record("fpnn", { strikes: 2, sl: 1 }) }, { now: NOW });
  const r = await run(["--live", "--levels", "34", "--l3", "yes", "--only", "fa/a1"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(probeCalls(e.f).length, 0);
  assert.equal(loadFidelity(e.out).models["fa/a1"].lvr, "fpnn", "unchanged: L3 and L4 stay `n`");
});

test("paid models go through the spend cap and the row ceiling: a row over the ceiling is skipped, not probed, and reported", async () => {
  const e = env();
  const r = await run(["--live", "--only", "pb", "--max-row-cost", "0.0000001"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(probeCalls(e.f).length, 0, "no paid request was sent");
  assert.match(r.out, /3 row\(s\) remain unprobed/);
  assert.match(r.out, /row ceiling/);
  assert.equal(loadFidelity(e.out).models["pb/b1"], undefined);
});

test("one sweep at a time: a live lock held by a running process refuses the run with exit 5 and sends nothing", async () => {
  const e = env();
  fs.writeFileSync(e.deps.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: "probe-all", maxMinutes: 150 }));
  const r = await run(["--live"], { ...e.deps, isAlive: () => true });
  assert.equal(r.code, 5);
  assert.equal(probeCalls(e.f).length, 0);
  assert.ok(!fs.existsSync(e.out));
});

test("a gateway that is down: nothing is sent and nothing is written", async () => {
  const e = env({ deps: { fetch: async () => { throw new Error("ECONNREFUSED"); } } });
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /gateway is not answering; nothing was sent/);
  assert.ok(!fs.existsSync(e.out));
});

test("an unknown --only is an error, never 'everything'", async () => {
  const e = env();
  const r = await run(["--only", "nosuch"], e.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /matches no probe-ok model/);
});

test("an interrupted run keeps what finished: records written so far are saved and not asked again", async () => {
  const e = env();
  // a partial run (--limit) stands for an interrupted one: what finished is saved, and the next run asks only for the rest
  const r = await run(["--live", "--limit", "3"], e.deps);
  assert.equal(r.code, 0);
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 3);
  const r2 = await run(["--live"], e.deps);
  assert.equal(r2.code, 0);
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 7);
  assert.equal(probeCalls(e.f).length, 14, "3 models, then the 4 others: each exactly once");
});

test("runIncremental: the function a scheduler can call: the queue is the probe-ok models with no record, inside the per-provider cap", () => {
  const { snapshot, bench } = world();
  const store = { "fa/a1": record("ppnn"), "pb/b1": record("ffnn", { strikes: 2, sl: 1, fx: "cc-tools-0" }) };
  const r = runIncremental({ snap: snapshot.snap, bench, store });
  assert.deepEqual(r.queue.map((e) => e.key).sort(), ["fa/a2", "fa/a3", "fa/auto", "pb/b2", "pb/b3"]);
  assert.equal(r.counts.withRecord, 2);
  assert.deepEqual(r.queue.map((e) => e.todo.join()), r.queue.map(() => "1,2"));
  const capped = runIncremental({ snap: snapshot.snap, bench, store, tfMaxTokens: 400 });
  assert.equal(capped.queue.length, 2, "one model per provider fits 400 tokens");
  assert.equal(capped.waiting.length, 3);
  assert.deepEqual(runIncremental({ snap: snapshot.snap, bench, store: Object.fromEntries(probeSet(snapshot.snap, bench).models.map((m) => [m.key, store["fa/a1"]])) }).queue, []);
});

test("plan, printPlan and liveRefusal are pure over their inputs", () => {
  const { snapshot, bench } = world();
  const o = parseArgs(["--levels", "34"]);
  const have = Object.fromEntries(probeSet(snapshot.snap, bench).models.map((m) => [m.key, record("ppnn")]));
  const p = plan({ snap: snapshot.snap, bench, store: have, o });
  assert.equal(p.queued.length, 7);
  assert.equal(plan({ snap: snapshot.snap, bench, store: {}, o }).queued.length, 0, "no L3 or L4 for a model with no L1+L2 result yet");
  const text = printPlan(p, o);
  assert.match(text, /levels L3\+L4/);
  assert.match(liveRefusal(o, p), /--l3 yes/);
  assert.equal(liveRefusal(parseArgs([]), plan({ snap: snapshot.snap, bench, store: {}, o: parseArgs([]) })), null);
  assert.match(text, /^tool-fidelity: /);
});

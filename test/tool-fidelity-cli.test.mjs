// The tool-fidelity CLI end to end, offline: a fixture snapshot and bench, a fake gateway, a temp state directory.
// Nothing real is read or written (guardRealState), and nothing goes on the network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, fakeFetch, ev, stream, ok, http, goodModel, record, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, parseLevels, plan, printPlan, liveRefusal, runIncremental } from "../refresh/tool-fidelity-cli.mjs";
import { loadFidelity, saveFidelity, buildRecord, probeSet, cellOf, fidelityCounts, cleanFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { FIXTURE_ID, BIG_FIXTURE_ID } from "../refresh/tool-fidelity-fixture.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

const world = () => {
  const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
  const rows = [
    { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN", pin: 3, pout: 15 })] },
    { provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3", { tools: false }), m("auto")] },
    { provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 1, pout: 4 }), m("b2", { badge: "PAID", pin: 2, pout: 8 }), m("b3", { badge: null, pin: 3, pout: 12 })] },
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
    now: () => NOW, isAlive: () => false, findRunning: () => [], sweep: { ...SWEEP_FAST }, retryDelayMs: 1, rateBackoffMs: 1, tiers: { fa: "free", pb: "free" }, ...extra.deps };
  return { dir, deps, f, benchFile, out: deps.outFile, ...w };
}
// a live run with priced models needs an explicit --max-spend (liveRefusal): these tests add the default value so the rule is exercised on its own in one test, with `raw`
const spendFor = (argv) => (argv.includes("--live") && !argv.includes("--max-spend") ? [...argv, "--max-spend", "5"] : argv);
async function run(argv, deps, { raw = false } = {}) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(raw ? argv : pinL12(spendFor(argv)), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const probeCalls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const listing = (d) => fs.readdirSync(d).sort();

test("arguments: levels parse as digits 1-7 once each (5 is the big step, 6 spawn, 7 the error result); caps are positive numbers; --l3 needs `yes`; an empty --only is refused", () => {
  assert.deepEqual(parseLevels("12"), [1, 2]);
  assert.deepEqual(parseLevels("4,3"), [3, 4]);
  assert.deepEqual(parseLevels("1+2+3+4"), [1, 2, 3, 4]);
  assert.deepEqual(parseLevels("5"), [5]);
  assert.deepEqual(parseLevels("354"), [3, 4, 5]);
  assert.deepEqual(parseLevels("6"), [6]);
  assert.deepEqual(parseLevels("7531"), [1, 3, 5, 7]);
  for (const bad of ["", "8", "0", "112", "ab", "1 8"]) assert.equal(parseLevels(bad), null, JSON.stringify(bad));
  const o = parseArgs([]);
  assert.deepEqual([o.live, o.levels, o.tfMaxTokens, o.maxSpend, o.maxRowCost, o.force, o.l3], [false, [1, 2, 6, 7], 150000, 5, 0.1, false, false]);
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
  assert.match(r.out, /models: 8 probe-ok; 1 Anthropic relay model\(s\) not probed \(provenance: known good\); 0 skipped for now because the provider's key tier is not free; 7 in the probe set \(free-labelled providers only\)/);
  assert.match(r.out, /with a record: 0 of 7; with a record against the current fixture: 0 of 7/);
  assert.match(r.out, /tools:false in the probe set: 1 of 7 .*probed like the rest/);
  assert.match(r.out, /context length unknown: 0 of 7 model\(s\) in the probe set/);
  assert.match(r.out, /7 model\(s\) queued of 7/);
  assert.match(r.out, /requests 21 /);
  assert.match(r.out, /free tier 4 model\(s\): no money; paid tier 3 model\(s\): estimate \$/);
  assert.match(r.out, /no request was made\. Re-run with --live to probe\./);
  assert.ok(!/\b(D-a[a-z]|QB-\d+|CQ\d|G[1-7]\b)/.test(r.out), "plan ids are not user-visible");
});

test("DRY RUN with levels 3 and 4 prints the per-request cost BEFORE anything is spent, leaves the paid-key provider out of the probe set altogether and says what a live run needs", async () => {
  const e = env({ deps: { tiers: { fa: "free", pb: "paid" } } });
  saveFidelity(e.out, Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, buildRecord(null, { 1: { v: "p" }, 2: { v: "p" } }, { now: NOW })])), { now: NOW });
  const r = await run(["--levels", "34"], e.deps);
  assert.equal(r.code, 0);
  assert.match(r.out, /4 model\(s\) queued of 4/, "only the four free-tier models: the paid provider's three are not in the probe set at all");
  assert.match(r.out, /3 skipped for now because the provider's key tier is not free \(paid 3\); 4 in the probe set/);
  assert.match(r.out, /probe-ok models by key tier \(relay apart\): free 4, paid 3/);
  assert.match(r.out, /requests 6 /, "the default per-provider cap of 150,000 input tokens fits 3 models of 2 requests (3a + 3b) each");
  assert.match(r.out, /whole queue, before the cap: 8 requests, ~1\d\dk input tokens/);
  assert.match(r.out, /L3 constructs \+ 157 KB \(\+L4 parallel\) 2 req ~4\dk in/);
  assert.match(r.out, /output budgets: .*3b 256/);
  assert.match(r.out, /timeouts: adaptive per model, 3 x its bench time, small 45-120 s, 157 KB 90-180 s, 400 KB 120-240 s \(this run's small requests: .*a timeout is asked once more at double/);
  assert.match(r.out, /per tier this run: free 3 model\(s\)/);
  assert.match(r.out, /needs --l3 yes and --only|deep levels need --l3 yes and --only/);
  assert.equal(e.f.calls.length, 0);
});

test("the dry run's counts follow the store: with a record, against the CURRENT fixture, against an older one (not queued), and the cap", async () => {
  const e = env();
  saveFidelity(e.out, { "fa/a1": record("ppnn"), "fa/a2": record("ffnn", { strikes: 2, sl: 1 }), "pb/b1": record("ppnn", { fx: "cc-tools-0" }) }, { now: NOW });
  const h = sha(e.out);
  const r = await run(["--tf-max-tokens-per-provider", "12000"], e.deps);
  assert.match(r.out, /with a record: 3 of 7; with a record against the current fixture: 2 of 7; against an older fixture: 1 \(a recommendation to re-sweep, not queued\)/);
  assert.match(r.out, /4 model\(s\) queued of 7/);
  assert.match(r.out, /\d fit the per-provider cap of 12,000 input tokens/);
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
  const b = await run(["--live", "--levels", "34", "--l3", "yes"], e.deps, { raw: true });
  assert.equal(b.code, 2); assert.match(b.err, /named provider subset \(--only\) or an explicit cap/);
  const e2 = env();
  const c = await run(["--live", "--max-spend", "0.0000001", "--max-row-cost", "1"], e2.deps);
  assert.equal(c.code, 2); assert.match(c.err, /the estimate \$[\d.]+ is above the cap \$0\.0000?001?|above the cap/);
  const priced = env();
  const d = await run(["--live"], priced.deps, { raw: true });
  assert.equal(d.code, 2);
  assert.match(d.err, /3 priced model\(s\) are queued .*a live run with money at stake needs an explicit --max-spend \(the default is not accepted\)/, "the priced-run rule: no explicit --max-spend, no live run");
  assert.equal((await run(["--live", "--only", "fa"], env().deps, { raw: true })).code, 0, "a run with nothing priced in it needs none");
  assert.equal(priced.f.calls.length, 0);
  assert.equal(e.f.calls.length + e2.f.calls.length, 0, "refused before the gateway was even asked");
  assert.ok(!fs.existsSync(e2.deps.lockFile));
});

test("--live L1+L2: every probe-ok model gets a record, the relay does not, nothing else is written; the report says what happened", async () => {
  const e = env();
  const hb = sha(e.benchFile);
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const calls = probeCalls(e.f);
  assert.equal(calls.length, 21, "3 requests x 7 models");
  assert.ok(!calls.some((c) => c.body.model.startsWith("anthropic/")), "the relay is never probed");
  const s = loadFidelity(e.out);
  assert.equal(s.ok, true);
  assert.deepEqual(Object.keys(s.models).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto", "pb/b1", "pb/b2", "pb/b3"]);
  for (const rec of Object.values(s.models)) assert.deepEqual([rec.lvr, rec.t, rec.ok, rec.fx], ["ppnn", "t", true, FIXTURE_ID]);
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
  assert.deepEqual(probeCalls(e.f).map((c) => c.body.model), ["fa/a-new", "fa/a-new", "fa/a-new"], "only the new model, its 3 small requests (the simple call, argument fidelity, L2)");
  assert.ok(loadFidelity(e.out).models["fa/a-new"]);
});

test("the fixture ids are cc-tools-3 / cc-tools-big-3 (the path pattern lost its [^\\0] tail); a record measured on cc-tools-2 shows * (outdated), still counts as TESTED, is NOT queued by a normal run at any level, and nothing asks it again by itself", async () => {
  assert.deepEqual([FIXTURE_ID, BIG_FIXTURE_ID], ["cc-tools-3", "cc-tools-big-3"]);
  const e = env();
  const old = buildRecord(null, { 1: { v: "p" }, 2: { v: "p" }, 3: { v: "p", bytes: 150000 }, 4: { v: "p" }, 5: { v: "p", bytes: 400000 }, 6: { v: "p" }, 7: { v: "p" } }, { now: NOW, fixtureId: "cc-tools-2" });       // every level answered, so only the fixture id says "old"
  assert.equal(old.fx, "cc-tools-2");
  assert.match(cellOf(old), /\*$/, "the picker cell carries the * of an older fixture");
  assert.doesNotMatch(cellOf({ ...old, fx: FIXTURE_ID }), /\*$/);
  const all = Object.fromEntries(probeSet(e.snapshot.snap, e.bench).models.map((m) => [m.key, old]));
  saveFidelity(e.out, all, { now: NOW });
  const n = Object.keys(all).length;
  const c = fidelityCounts(probeSet(e.snapshot.snap, e.bench), all);
  assert.deepEqual([c.withRecord, c.outdated, c.withRecordCurrent], [n, n, 0], "every record is TESTED (it has a result) and every one is outdated");
  // a normal run, also one that asks L3, the big step, spawn and the error result: nothing is queued, nothing is sent
  for (const argv of [[], ["--levels", "123", "--l3", "yes", "--tf-max-tokens-per-provider", "5000000"], ["--levels", "1235", "--l3", "yes", "--max-spend", "5"]]) {
    const r = await run(["--live", ...argv], e.deps);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /nothing to probe/);
    assert.match(r.out, /against an older fixture: \d+ \(a recommendation to re-sweep, not queued\)/);
  }
  assert.equal(probeCalls(e.f).filter((x) => ["3a", "3b", "5"].includes(kindOf(x))).length, 0, "no L3 or big request was sent for an outdated record");
  assert.deepEqual(Object.values(loadFidelity(e.out).models).map((x) => x.fx), Array(n).fill("cc-tools-2"), "and the records stayed as they were");
});

test("a record that carries the LEGACY pt field (written by the removed pattern re-ask) stays readable, round-trips through the file, and changes neither the class nor the queue nor the verdict", async () => {
  const e = env();
  const base = buildRecord(null, { 1: { v: "p" }, 2: { v: "p" }, 3: { v: "p", bytes: 150000 }, 4: { v: "p" } }, { now: NOW, fixtureId: "cc-tools-2" });
  const withPt = { ...base, pt: "f" };
  assert.deepEqual([withPt.t, cleanFidelity(withPt).t, cleanFidelity(withPt).pt], [base.t, base.t, "f"], "readable, preserved, same class");
  assert.equal(cleanFidelity({ ...base, pt: "x" }), null, "a pt that is not p or f is still not a record");
  assert.equal(cellOf(withPt), cellOf(base), "the picker cell does not show it");
  const keys = probeSet(e.snapshot.snap, e.bench).models.map((m) => m.key);
  saveFidelity(e.out, Object.fromEntries(keys.map((k, j) => [k, j === 0 ? withPt : base])), { now: NOW });
  const back = loadFidelity(e.out);
  assert.equal(back.models[keys[0]].pt, "f", "the file round-trips it");
  assert.equal(back.models[keys[1]].pt, undefined);
  const r = await run(["--live", "--levels", "123", "--l3", "yes", "--max-spend", "5"], e.deps);
  assert.match(r.out, /nothing to probe/, "it is not queued");
  assert.equal(loadFidelity(e.out).models[keys[0]].pt, "f", "and a run does not drop it");
  // a probe that touches the record (L6/L7 asked) keeps the legacy field as it was
  const kept = buildRecord(withPt, { 6: { v: "p" } }, { now: NOW });
  assert.deepEqual([kept.pt, kept.t, kept.lvr], ["f", base.t, base.lvr]);
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
  assert.equal(probeCalls(e.f).length, 3, "L1, argument fidelity, L2");
  assert.equal(loadFidelity(e.out).models["fa/a1"].fx, FIXTURE_ID, "re-swept: now against the current fixture");
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
    if (m === "fa/a2") return kindOf(c) === "1" || kindOf(c) === "1f" ? ok(stream(ev.text(0, "nope"), ev.stop())) : goodModel(c);
    if (m === "pb/b1") return http(402, "payment required");
    if (m === "pb/b2") return http(402, "payment required");
    return goodModel(c);
  } });
  const r = await run(["--live", "--per-provider", "1"], e.deps);          // one at a time per provider: the evidence of the first answers is in before the next one is asked
  let s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a2"].lvr, s["fa/a2"].t, s["fa/a2"].ok, s["fa/a2"].strikes, s["fa/a2"].sl], ["nnnn", "u", false, 1, 1], "first strike: untested, not x");
  assert.match(s["fa/a2"].why, /^L1: answered in text/);
  assert.equal(s["pb/b1"], undefined, "402 is the account's state, not a verdict about the model");
  assert.equal(s["pb/b2"], undefined, "nor is the second 402: two distinct models out of credit pause the provider");
  assert.ok(s["fa/a1"]);
  assert.equal(s["pb/b3"], undefined, "two models of pb were out of credit: the rest of the provider is left alone, with ZERO further requests");
  assert.equal(probeCalls(e.f).filter((c) => c.body.model.startsWith("pb/")).length, 2, "two requests to pb in the whole run");
  assert.match(r.out, /providers needing attention \(an account state, not a verdict on any model; fix the account, then run again; nothing was retried in this run\):/);
  assert.match(r.out, /pb: pay \(no credit or the plan does not allow it\) -- 3 model\(s\) skipped/, "the provider, the state, and how many models were skipped");
  assert.match(r.out, /failed once, asked again next run 1/);
  assert.match(r.out, /not recorded \(they stay queued; a refusal about the account is not a verdict on the model\): .*\b(pay|rate) \d/);
  assert.match(r.out, /still queued 4\b/, "a2 (one strike) and the three pb models");
  const second = await run(["--live", "--only", "fa"], e.deps);
  assert.equal(second.code, 0, second.err);
  s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a2"].lvr, s["fa/a2"].t, s["fa/a2"].ok, s["fa/a2"].strikes], ["fpnn", "x", false, 2], "second strike at the same level: confirmed");
  assert.deepEqual(probeCalls(e.f).filter((c) => c.body.model === "fa/a2").length, 6, "a2: L1, the forced L1 and L2 per run, 2 runs");
  e.f.calls.length = 0;
  const third = await run(["--live", "--only", "fa"], e.deps);
  assert.match(third.out, /nothing to probe/, "a confirmed failure is not asked again by an ordinary run");
  const held = await run(["--live", "--only", "pb"], { ...e.deps, fetch: fakeFetch(goodModel) });
  assert.match(held.out, /held providers .*: 1 provider\(s\)/, "pb's account state is a HOLD: the very next run does not ask it at all");
  const next = await run(["--live", "--only", "pb", "--retry-accounts"], { ...e.deps, fetch: fakeFetch(goodModel) });
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
  const r = await run(["--live", "--tf-max-tokens-per-provider", "12000"], e.deps);
  assert.equal(r.code, 0, r.err);
  const first = Object.keys(loadFidelity(e.out).models).sort();
  assert.deepEqual(first, ["fa/a1", "fa/a2", "pb/b1", "pb/b2"], "2 models (about 5,500 tokens each: L1 and L2 with the 20 KB result) per provider fit 12,000; the next one of each does not");
  assert.match(r.out, /3 model\(s\) waited for the per-provider cap of 12,000 input tokens: run again to continue/);
  const r2 = await run(["--live", "--tf-max-tokens-per-provider", "12000"], e.deps);
  assert.equal(r2.code, 0, r2.err);
  assert.deepEqual(Object.keys(loadFidelity(e.out).models).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto", "pb/b1", "pb/b2", "pb/b3"], "covered over two runs");
  assert.equal(probeCalls(e.f).length, 21, "no model was asked twice across the runs");
});

test("L3 on a named FREE-tier model: --l3 yes --only; a size refusal at the 157 KB request writes lvr ppfn, class t, a payload cap and d3 b; L1 and L2 are not asked again", async () => {
  const e = env({ answer: (c) => (c.bytes > 150000 ? http(413, "request entity too large") : goodModel(c)) });
  const first = await run(["--live"], e.deps);
  assert.equal(first.code, 0);
  e.f.calls.length = 0;
  const r = await run(["--live", "--levels", "34", "--l3", "yes", "--only", "fa/a1"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const calls = probeCalls(e.f);
  assert.deepEqual(calls.map((c) => [c.body.model, c.bytes > 100000 ? "3b" : "3a"]), [["fa/a1", "3a"], ["fa/a1", "3b"]], "the constructs request, then the 157 KB one; L4 rides in the latter");
  const rec = loadFidelity(e.out).models["fa/a1"];
  assert.deepEqual([rec.lvr, rec.t, rec.lv, rec.capBelow, rec.d3, rec.nm, rec.cc], ["ppfn", "t", 1, 150000, "b", "p", "p"]);
  assert.match(rec.why, /^L3: \[3b\] HTTP 413/);
  assert.equal(loadFidelity(e.out).models["fa/a2"].lvr, "ppnn", "the other models are untouched");
});

test("a construct rejection at 3a is the schema verdict: two strikes make it x, and the 157 KB request is NEVER sent", async () => {
  const e = env({ answer: (c) => (c.bytes > 3000 && c.bytes < 12000 ? http(400, "tools.0.input_schema: unsupported keyword anyOf") : goodModel(c)) });
  await run(["--live"], e.deps);
  e.f.calls.length = 0;
  const args = ["--live", "--levels", "34", "--l3", "yes", "--only", "fa/a1"];
  await run(args, e.deps);
  assert.deepEqual([loadFidelity(e.out).models["fa/a1"].strikes, loadFidelity(e.out).models["fa/a1"].lvr], [1, "ppnn"]);
  await run(args, e.deps);
  const rec = loadFidelity(e.out).models["fa/a1"];
  assert.deepEqual([rec.lvr, rec.t, rec.strikes, rec.d3], ["ppfn", "x", 2, "a"]);
  assert.ok(probeCalls(e.f).every((c) => c.bytes < 12000), "no 157 KB request in either run");
  assert.equal(probeCalls(e.f).length, 2);
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
  assert.equal(probeCalls(e.f).length, 21, "3 models, then the 4 others: each exactly once");
});

test("runIncremental: the function a scheduler can call: the queue is the probe-ok models with no record, inside the per-provider cap", () => {
  const { snapshot, bench } = world();
  const store = { "fa/a1": record("ppnn", { sp: "p", er: "p" }), "pb/b1": record("ffnn", { strikes: 2, sl: 1, fx: "cc-tools-0" }) };       // a1 has every baseline level (L1, L2, spawn, error result)
  const tiers = { fa: "free", pb: "free" };
  assert.deepEqual(runIncremental({ snap: snapshot.snap, bench, store }).queue, [], "default-deny: with no tier data nothing is probed");
  assert.deepEqual(runIncremental({ snap: snapshot.snap, bench, store, tiers: { fa: "free", pb: "paid" } }).queue.map((e) => e.key).sort(), ["fa/a2", "fa/a3", "fa/auto"], "a paid-key provider is not probed at all, not even L1+L2");
  const r = runIncremental({ snap: snapshot.snap, bench, store, tiers });
  assert.deepEqual(r.queue.map((e) => e.key).sort(), ["fa/a2", "fa/a3", "fa/auto", "pb/b2", "pb/b3"]);
  assert.equal(r.counts.withRecord, 2);
  assert.deepEqual(r.queue.map((e) => e.todo.join()), r.queue.map(() => "1,2,6,7"), "the baseline is L1+L2+L6+L7");
  const capped = runIncremental({ snap: snapshot.snap, bench, store, tiers, tfMaxTokens: 6600 });
  assert.equal(capped.queue.length, 2, "one model per provider fits 6,600 tokens (a model is about 6,100)");
  assert.equal(capped.waiting.length, 3);
  assert.deepEqual(runIncremental({ snap: snapshot.snap, bench, store: Object.fromEntries(probeSet(snapshot.snap, bench).models.map((m) => [m.key, store["fa/a1"]])), tiers }).queue, []);
});

test("plan, printPlan and liveRefusal are pure over their inputs", () => {
  const { snapshot, bench } = world();
  const o = parseArgs(["--levels", "34"]);
  const have = Object.fromEntries(probeSet(snapshot.snap, bench).models.map((m) => [m.key, record("ppnn")]));
  const tiers = { fa: "free", pb: "free" };
  const p = plan({ snap: snapshot.snap, bench, store: have, o, tiers });
  assert.equal(p.queued.length, 7);
  assert.equal(plan({ snap: snapshot.snap, bench, store: have, o }).queued.length, 0, "default-deny: with no tier data nothing deep is queued");
  assert.equal(plan({ snap: snapshot.snap, bench, store: have, o, tiers: { fa: "free", pb: "paid" } }).queued.length, 4, "a paid-key provider is not in the probe set");
  assert.equal(plan({ snap: snapshot.snap, bench, store: {}, o, tiers }).queued.length, 0, "no L3 or L4 for a model with no L1+L2 result yet");
  const text = printPlan(p, o);
  assert.match(text, /levels L3\+L4/);
  assert.match(liveRefusal(o, p), /--l3 yes/);
  assert.equal(liveRefusal(parseArgs([]), plan({ snap: snapshot.snap, bench, store: {}, o: parseArgs([]) })), null);
  assert.match(text, /^tool-fidelity: /);
});

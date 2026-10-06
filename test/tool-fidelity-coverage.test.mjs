// The candidates step, the coverage ledger and the inheritance marks of the tool-fidelity probe. Offline: fixtures only, in temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs } from "../refresh/tool-fidelity-cli.mjs";
import {
  probeSet, selectCandidates, presetUnion, loadTiers, envelope, ctxNeededFor, BIG_MIN_CTX, coverage, assertPartition, coverageLines, ledgerUniverses, updatePending, cleanPending, inherited, defaultIdentity, queueFor,
  loadFidelity, saveFidelity, loadPolicy, renderFile, FILE_NAME, REAL_FILE,
} from "../refresh/tool-fidelity.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");

/** A snapshot of `fa` with `n` models m1..mn (ctx given per id), a free provider `fb`, and the relay; every one probe-ok except `dead`. */
function world(ctxOf = () => 200000, n = 6) {
  const m = (id, ctx = 200000) => ({ id, outModality: "chat", ctx, tools: true, pin: 0, pout: 0, badge: "FREE" });
  const rows = [
    { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x")] },
    { provider: "fa", keyId: "k.fa.free", models: Array.from({ length: n }, (_, i) => m(`m${i + 1}`, ctxOf(i + 1))) },
    { provider: "fb", keyId: "k.fb.free", models: [m("b1"), m("b2"), m("dead")] },
  ];
  const ok = { s: "ok", t: 400, a: 1790699779 };
  const bench = { get: (k) => (k === "fb/dead" ? { s: "gone", a: 1 } : /^(anthropic|fa|fb)\//.test(k) ? ok : null) };
  return { snap: { rows }, bench };
}
const POLICY = (...rows) => ({ schema: 1, models: rows.map(([s, c]) => ({ s, c })) });

// ---------------------------------------------------------------- candidates

const TIERS = { fa: "free", fb: "free", fp: "paid", fd: "free-deposit", fm: "management", anthropic: "subscription" };

/** The mixed world of the candidates rule: free, paid, deposit and management providers, unknown and small contexts, the relay. */
function mixed() {
  const m = (id, ctx = 200000, over = {}) => ({ id, outModality: "chat", ctx, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
  const rows = [
    { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x")] },
    { provider: "fa", keyId: "k.fa.free", models: [m("big1", 1000000), m("big2", 200000), m("mid", 130000), m("small", 100000), m("tiny", 32000), m("unk", null), m("zero", 0), m("priced", 200000, { badge: "PAID", pin: 5, pout: 9 })] },
    { provider: "fb", keyId: "k.fb.free", models: [m("b1", 300000), m("b2", null)] },
    { provider: "fp", keyId: "k.fp.paid", models: [m("p1", 200000, { badge: "PAID", pin: 1, pout: 2 })] },
    { provider: "fd", keyId: "k.fd.free-deposit", models: [m("d1")] },
    { provider: "fm", keyId: "k.fm.management", models: [m("g1")] },
    { provider: "fx", keyId: "k.fx.free", models: [m("t1")] },                    // a provider with no tier at all
  ];
  const ok = { s: "ok", t: 400, a: 1790699779 };
  return { snap: { rows }, bench: { get: (k) => (/^(anthropic|fa|fb|fp|fd|fm|fx)\//.test(k) ? ok : null) } };
}

test("CANDIDATES: every probe-ok model on a FREE-tier provider, whether or not its context is known; paid, deposit, management, relay and tier-less providers are excluded with their reason", () => {
  const { snap, bench } = mixed();
  const set = probeSet(snap, bench);
  const c = selectCandidates({ set, policy: POLICY(["fa/big1", 1000000]), tiers: TIERS });
  assert.deepEqual(c.entries.map((e) => e.key).sort(), ["fa/big1", "fa/big2", "fa/mid", "fa/priced", "fa/small", "fa/unk", "fa/zero", "fb/b1", "fb/b2"].sort(), "unknown ctx (null and 0) is IN");
  const why = Object.fromEntries(c.excluded.map((e) => [e.key, e.reason]));
  assert.deepEqual(why, { "fa/tiny": "ctx-too-small-for-fixture", "fp/p1": "not-free-tier (skipped for now)", "fd/d1": "not-free-tier (skipped for now)", "fm/g1": "not-free-tier (skipped for now)", "fx/t1": "not-free-tier (skipped for now)", "anthropic/claude-x": "relay-by-provenance" });
  assert.equal(c.entries.length + c.excluded.length, set.models.length + set.relay.length, "every probe-ok model and the relay is in exactly one list");
  assert.ok(c.entries.every((e) => e.tier === "free"));
  const priced = c.entries.find((e) => e.key === "fa/priced");
  assert.deepEqual([priced.free ?? false, priced.pricedOnFree], [false, true], "a free-tier KEY does not make a LISTED price free: the model is costed at $5 / $9 so the row ceiling and the spend cap apply");
  assert.ok(c.entries.filter((e) => e.key !== "fa/priced" && e.tier === "free").every((e) => e.free === true && !e.pricedOnFree), "a free-tier key with no listed price (or a free listing) costs nothing");
  const lifted = selectCandidates({ set, policy: POLICY(), tiers: TIERS, includeTiers: ["paid", "free-deposit"] });
  assert.deepEqual(lifted.entries.filter((e) => e.tier !== "free").map((e) => [e.key, e.tier, e.free]), [["fd/d1", "free-deposit", true], ["fp/p1", "paid", false]], "--include-tier lifts the exclusion; a paid model keeps its price (not free)");
  assert.equal(lifted.excluded.find((e) => e.key === "fm/g1").reason, "not-free-tier (skipped for now)", "management stays out unless asked");
  assert.equal(selectCandidates({ set, policy: POLICY(), tiers: TIERS, includeTiers: ["management"] }).entries.some((e) => e.key === "fm/g1"), true);
  assert.equal(selectCandidates({ set, policy: POLICY(), tiers: {} }).entries.length, 0, "no tiers at all: nothing is assumed free");
});

test("SIZE rule: a KNOWN context too small for the 157 KB fixture is excluded (threshold from the fixture's token count with margin); the big step is skipped below 200,000", () => {
  const need = ctxNeededFor(3);
  assert.ok(need > 55000 && need < 62000, `about 1.5 x 39,223 tokens plus the answer budget: ${need}`);
  assert.equal(ctxNeededFor(4) >= need, true);
  assert.equal(BIG_MIN_CTX, 200000);
  const { snap, bench } = mixed();
  const set = probeSet(snap, bench);
  const c = selectCandidates({ set, policy: POLICY(), tiers: TIERS });
  assert.equal(c.excluded.find((e) => e.key === "fa/tiny").reason, "ctx-too-small-for-fixture", "32,000 is below the need");
  assert.equal(c.entries.some((e) => e.key === "fa/small"), true, "100,000 is enough for the fixture");
  const edge = world(() => need, 1), edgeBelow = world(() => need - 1, 1);
  const tiers = { fa: "free", fb: "free" };
  assert.equal(selectCandidates({ set: probeSet(edge.snap, edge.bench), policy: POLICY(), tiers }).entries.some((e) => e.key === "fa/m1"), true, "exactly the need is in");
  assert.equal(selectCandidates({ set: probeSet(edgeBelow.snap, edgeBelow.bench), policy: POLICY(), tiers }).entries.some((e) => e.key === "fa/m1"), false, "one token less is out");
});

test("PRIORITY queue (an ordering, never a limit): 1 policy allowed >= 128,000 and pins, 2 preset union, 3 other >= 128,000, 4 unknown, 5 known below 128,000; the policy's rank inside a level", () => {
  const { snap, bench } = mixed();
  const set = probeSet(snap, bench);
  const policy = POLICY(["fa/big2", 200000], ["fb/b1", 300000], ["fa/mid", 100000], ["fa/big1", 1000000]);
  const presetKeys = new Set(["fa/priced", "fa/mid"]);
  const c = selectCandidates({ set, policy, tiers: TIERS, presetKeys });
  assert.deepEqual(c.entries.map((e) => [e.key, e.prio]), [["fa/big2", 1], ["fb/b1", 1], ["fa/big1", 1], ["fa/mid", 2], ["fa/priced", 2], ["fa/unk", 4], ["fa/zero", 4], ["fb/b2", 4], ["fa/small", 5]]);
  assert.deepEqual(c.entries.map((e) => e.prio), [1, 1, 1, 2, 2, 4, 4, 4, 5], "priority levels never decrease down the list");
  assert.deepEqual(c.entries.slice(0, 3).map((e) => e.key), ["fa/big2", "fb/b1", "fa/big1"], "level 1 follows the POLICY's own rank, not the probe-set order");
  assert.equal(c.entries.find((e) => e.key === "fa/mid").prio, 2, "mid is in the policy at 100,000 (below the floor) but in the preset union");
  assert.equal(c.entries.find((e) => e.key === "fa/small").prio, 5, "known 100,000 below the floor, in no preset: last");
  const noPresets = selectCandidates({ set, policy, tiers: TIERS });
  assert.equal(noPresets.entries.length, c.entries.length, "without the preset union nothing is dropped, only level 2 is empty");
  assert.ok(!noPresets.entries.some((e) => e.prio === 2));
  assert.equal(noPresets.entries.find((e) => e.key === "fa/priced").prio, 3, "known >= 128,000, not in the policy: level 3");
  const pinned = selectCandidates({ set, policy, tiers: TIERS, pins: ["fp/p1", "fa/tiny", "fa/small", "fx/t1"] });
  assert.deepEqual(pinned.entries.slice(0, 2).map((e) => e.key), ["fa/tiny", "fa/small"], "pins come first, in the order given, whatever their context");
  assert.ok(!pinned.entries.some((e) => e.key === "fp/p1" || e.key === "fx/t1"), "but a pin does NOT get round the tier rule: a paid or unlabelled provider is not probed");
  assert.deepEqual(pinned.excluded.filter((e) => e.key === "fp/p1" || e.key === "fx/t1").map((e) => e.reason), ["not-free-tier (skipped for now)", "not-free-tier (skipped for now)"]);
  assert.ok(pinned.entries.slice(0, 2).every((e) => e.pinned && e.prio === 1));
  assert.deepEqual(selectCandidates({ set, policy, tiers: TIERS, pins: ["fa/nosuch"] }).pinned, ["fa/nosuch"], "a pin that is not a probe-ok model is reported, not invented");
});

test("presetUnion: the union of every preset's allowed set, computed with the funnel; a funnel that cannot run gives no keys and says so", () => {
  const { snap, bench } = mixed();
  const r = presetUnion({ snap, bench, tiers: TIERS, nowMs: 1790700000000 });
  assert.ok(r.keys instanceof Set);
  assert.equal(r.note, "8 presets");
  assert.ok(r.keys.has("fa/big1") && r.keys.has("fb/b1"), "free-tier models are in a preset");
  assert.ok(!r.keys.has("fm/g1"), "an excluded tier is in no preset");
  const bad = presetUnion({ snap, bench: { get() { throw new Error("boom"); } }, tiers: TIERS });
  assert.equal(bad.keys, null);
  assert.match(bad.note, /could not be computed offline \(boom\); priority level 2 is empty/);
});

test("loadTiers reads {provider: tier}, a compiled policy's `tiers`, or the vault registry array; anything else is null", () => {
  const d = freshDir(), f = path.join(d, "t.json");
  for (const [raw, want] of [[{ fa: "free", fp: "paid" }, { fa: "free", fp: "paid" }], [{ tiers: { fa: "free" }, models: [] }, { fa: "free" }], [[{ provider: "fa", tier: "free" }, { provider: "fp", tier: "paid" }, { nope: 1 }], { fa: "free", fp: "paid" }], [{ fa: 5 }, null], ["x", null]]) {
    fs.writeFileSync(f, JSON.stringify(raw));
    assert.deepEqual(loadTiers(f), want, JSON.stringify(raw));
  }
  fs.writeFileSync(f, "{");
  assert.equal(loadTiers(f), null);
  assert.equal(loadTiers(path.join(d, "absent.json")), null);
});

test("the ENVELOPE of a queue: its requests and tokens, the cap that finishes it in one run, the runs at a cap, the models that can never run", () => {
  const e = (provider, i, tin) => ({ key: `${provider}/${i}`, provider, tin, reqs: 5 });
  const rated = [...Array.from({ length: 10 }, (_, i) => e("a", i, 1000)), ...Array.from({ length: 3 }, (_, i) => e("b", i, 1000)), e("c", 0, 9000)];
  const env1 = envelope(rated, 4500);
  assert.deepEqual([env1.models, env1.providers, env1.requests, env1.tokens, env1.oneRunCap], [14, 3, 70, 22000, 10000]);
  assert.deepEqual(env1.perProvider.map((p) => [p.provider, p.tokens]), [["a", 10000], ["c", 9000], ["b", 3000]]);
  assert.deepEqual([env1.runs, env1.neverRuns], [3, 1], "a: 4 + 4 + 2 over 3 runs; c alone is 9000 > 4500 and never runs");
  assert.deepEqual([envelope(rated, 10000).runs, envelope(rated, 10000).neverRuns], [1, 0], "at the one-run cap everything runs once");
  assert.deepEqual([envelope(rated, 100).runs, envelope(rated, 100).neverRuns], [0, 14], "a cap below every model: no run, all never");
  assert.equal(envelope([], 100).models, 0);
});

test("loadPolicy accepts a compiled policy shape and nothing else", () => {
  const d = freshDir(), f = path.join(d, "policy.json");
  fs.writeFileSync(f, JSON.stringify(POLICY(["fa/m1", 200000])));
  assert.equal(loadPolicy(f).models.length, 1);
  for (const bad of ["{", JSON.stringify({ models: "x" }), JSON.stringify({ models: [{ c: 1 }] }), JSON.stringify([])]) { fs.writeFileSync(f, bad); assert.equal(loadPolicy(f), null, bad); }
  assert.equal(loadPolicy(path.join(d, "absent.json")), null);
});

test("the big step is asked in the SAME run as the L3 it follows, and the ladder stops it when L3 does not pass", () => {
  const set = { models: [{ key: "fa/a", provider: "fa", id: "a", free: true }] };
  assert.deepEqual(queueFor(set, {}, [1, 2, 3, 5]).map((e) => e.todo), [[1, 2, 3, 5]]);
  assert.deepEqual(queueFor(set, { "fa/a": record("ppnn") }, [1, 2, 3, 5]).map((e) => e.todo), [[3, 5]]);
  assert.deepEqual(queueFor(set, { "fa/a": record("pppn") }, [1, 2, 3, 5]).map((e) => e.todo), [[5]], "L3 already passed: only the big step");
  assert.deepEqual(queueFor(set, { "fa/a": record("pppn", { big: "p" }) }, [1, 2, 3, 5]), [], "everything answered");
  assert.deepEqual(queueFor(set, {}, [3, 5]), [], "no L1+L2 result and not asked here: nothing");
});

// ---------------------------------------------------------------- the ledger

const U = (...keys) => keys.map((k) => (Array.isArray(k) ? { key: k[0], excluded: k[1] } : { key: k }));

test("the ledger PARTITIONS a mixed universe: tested (tier and evidence), pending (reason) and excluded (reason) add up to every model, once each", () => {
  const store = {
    "p/v": record("pppp", { big: "p" }), "p/t": record("ppnn"), "p/x": record("ffnn", { strikes: 2, sl: 1, why: "L1: no" }), "p/strike": record("nnnn", { strikes: 1, sl: 1, why: "L1: text" }),
    "p/old": record("pppn", { fx: "cc-tools-0" }), "p/cap": record("ppfn", { capBelow: 150000 }),
  };
  const pending = { "p/rate": { r: "rate", n: 4, at: NOW.toISOString() }, "p/waiting": { r: "cap", n: 1, at: NOW.toISOString() } };
  const universe = U("p/v", "p/t", "p/x", "p/strike", "p/old", "p/cap", "p/rate", "p/waiting", "p/fresh", ["p/relay", "relay-by-provenance"], ["p/dead", "not-probe-ok"], ["p/bad id", "invalid-id"]);
  const l12 = coverage(universe, store, { level: "l12", pending });
  assert.deepEqual(l12.counts, { total: 12, tested: 5, pending: 4, excluded: 3, held: 0, byHeld: {}, byTier: { v: 2, t: 2, x: 1 }, byPending: { "first-strike": 1, rate: 1, cap: 1, "not-run": 1 }, byExcluded: { "relay-by-provenance": 1, "not-probe-ok": 1, "invalid-id": 1 } }, "L1+L2: p/cap passed L1+L2 (tier t)");
  assert.equal(l12.tested.length + l12.pending.length + l12.excluded.length, universe.length);
  const keys = [...l12.tested, ...l12.pending, ...l12.excluded].map((e) => e.key).sort();
  assert.deepEqual(keys, universe.map((u) => u.key).sort(), "every model exactly once");
  assert.deepEqual(l12.tested.find((e) => e.key === "p/cap"), { key: "p/cap", tier: "t", evidence: "ppfn cap<150000" });
  assert.deepEqual(l12.tested.find((e) => e.key === "p/v"), { key: "p/v", tier: "v", evidence: "pppp big p" });
  assert.deepEqual(l12.provisional.list, [{ key: "p/strike", level: 1, why: "L1: text" }], "a model that failed ONCE is reported as provisional, not as x");
  assert.equal(l12.tested.some((e) => e.key === "p/strike"), false, "and it is not tested");
  assert.equal(l12.pending.find((e) => e.key === "p/strike").reason, "first-strike");
  assert.deepEqual(l12.stuck.list, [{ key: "p/rate", reason: "rate", runs: 4 }], "pending for 4 runs in a row (3 or more is stuck)");
  assert.deepEqual(l12.outdated.list, [{ key: "p/old", fx: "cc-tools-0" }], "tested, but against an older fixture: a recommendation");
  assert.equal(l12.tested.some((e) => e.key === "p/old"), true, "an outdated record is still tested");
  const l3 = coverage(universe, store, { level: "l3", pending });
  assert.equal(l3.counts.tested, 4, "L3: v, x (L1/L2 failed for good, so L3 can never run), old (L3 passed), cap (L3 refused); p/t has no L3 yet -> pending");
  assert.equal(l3.tested.some((e) => e.key === "p/x" && e.tier === "x"), true);
  assert.equal(l3.pending.find((e) => e.key === "p/t").reason, "not-run");
  assert.equal(l3.counts.tested + l3.counts.pending + l3.counts.excluded, 12);
});

test("this run's PLAN is the pending reason for a model that has not run yet: queued, or cap", () => {
  const cov = coverage(U("p/a", "p/b", "p/c"), {}, { level: "l3", plan: { "p/a": "queued", "p/b": "cap" }, pending: { "p/c": { r: "pay", n: 1, at: NOW.toISOString() } } });
  assert.deepEqual(cov.pending.map((e) => [e.key, e.reason]), [["p/a", "queued"], ["p/b", "cap"], ["p/c", "pay"]]);
});

test("a model dropped, duplicated or put in two states by a bug is a LOUD failure: assertPartition throws", () => {
  const universe = U("p/a", "p/b", "p/c");
  const ok = { tested: [{ key: "p/a" }], pending: [{ key: "p/b" }], excluded: [{ key: "p/c" }] };
  assertPartition(universe, ok);
  assert.throws(() => assertPartition(universe, { ...ok, excluded: [] }), /1 model\(s\) are in no state, first p\/c/, "dropped");
  assert.throws(() => assertPartition(universe, { ...ok, pending: [{ key: "p/b" }, { key: "p/a" }] }), /p\/a is in two states/, "in two states");
  assert.throws(() => assertPartition(universe, { ...ok, excluded: [{ key: "p/c" }, { key: "p/c" }] }), /two states/, "twice");
  assert.throws(() => assertPartition(universe, { ...ok, excluded: [{ key: "p/c" }, { key: "p/zzz" }] }), /not in the universe/, "invented");
  assert.throws(() => assertPartition([...universe, { key: "p/a" }], ok), /appears twice in the universe/);
  assert.throws(() => assertPartition(universe, { tested: [], pending: [], excluded: [] }), /no state/);
});

test("the ledger holds over a broad mixed universe: every record shape the cleaner accepts, with and without exclusions, at both levels", () => {
  const variants = [{}, { strikes: 1, sl: 1 }, { strikes: 1, sl: 3 }, { strikes: 2, sl: 1 }, { strikes: 2, sl: 3 }, { capBelow: 150000 }, { big: "p" }, { fx: "cc-tools-0" }];
  const store = {}, universe = [];
  let n = 0;
  for (const a of "pfn") for (const b of "pfn") for (const c of "pfn") for (const d of "pfn") for (const v of variants) {
    const r = record(a + b + c + d, v);
    const key = `p/m${n++}`;
    if (n % 7 === 0) universe.push({ key, excluded: "ctx-below-floor" }); else { store[key] = r; universe.push({ key }); }
    if (n % 5 === 0) universe.push({ key: `p/none${n}` });
  }
  for (const level of ["l12", "l3"]) {
    const cov = coverage(universe, store, { level });
    assert.equal(cov.tested.length + cov.pending.length + cov.excluded.length, universe.length, level);
    assert.ok(cov.counts.tested > 100 && cov.counts.pending > 100 && cov.counts.excluded > 50, JSON.stringify(cov.counts));
  }
});

test("the ledger's printed lines carry the denominators and the three capped lists", () => {
  const store = { "p/s": record("nnnn", { strikes: 1, sl: 2, why: "L2: x" }), "p/o": record("pppn", { fx: "cc-tools-0" }) };
  const pending = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`p/w${i}`, { r: "rate", n: 5, at: NOW.toISOString() }]));
  const cov = coverage(U("p/s", "p/o", ...Object.keys(pending), ["p/e", "ctx-unknown"]), store, { level: "l12", pending });
  const lines = coverageLines(cov, "L1+L2");
  assert.match(lines[0], /^coverage L1\+L2: 18 model\(s\) = tested 1 \(v 1\) \+ pending 16 \(rate 15, first-strike 1\) \+ excluded 1 \(ctx-unknown 1\)$/);
  assert.match(lines.join("\n"), /failed once \(provisional, asked again, not yet x\) 1 of 18: p\/s L2/);
  assert.match(lines.join("\n"), /pending too long 15 of 18: .*x5, and 5 more/, "capped at 10 with the rest counted");
  assert.match(lines.join("\n"), /against an older fixture \(\*, re-sweep recommended\) 1 of 18: p\/o cc-tools-0/);
});

test("the ledger universes: L1+L2 covers every listed model (relay, not probe-ok and invalid ids excluded with their reason), L3 covers the candidates and the rest", () => {
  const { snap, bench } = world();
  snap.rows[2].models.push({ id: "has space", outModality: "chat", tools: true });
  const set = probeSet(snap, { get: (k) => (k === "fb/has space" ? { s: "ok", a: 1 } : bench.get(k)) });
  const cand = selectCandidates({ set, policy: POLICY(["fa/m1", 200000], ["fa/m2", 200000]), tiers: { fa: "free", fb: "free" } });
  const u = ledgerUniverses({ set, cand });
  const why = Object.fromEntries(u.l12.filter((x) => x.excluded).map((x) => [x.key, x.excluded]));
  assert.deepEqual(why, { "anthropic/claude-x": "relay-by-provenance", "fb/dead": "not-probe-ok", "fb/has space": "invalid-id" });
  assert.equal(u.l12.length, set.models.length + 3);
  assert.equal(u.l3.length, set.models.length + set.relay.length, "the same probe-ok models, now as candidates or excluded");
  assert.equal(ledgerUniverses({ set }).l3, null, "no L3 universe without candidates");
  coverage(u.l12, {}, { level: "l12" }); coverage(u.l3, {}, { level: "l3" });
});

// ---------------------------------------------------------------- the pending map

test("updatePending: a model in the queue that ends the run untested gets one more run and its reason; a result or a second-strike wait clears it; leavers are pruned", () => {
  const store = { "p/done": record("ppnn"), "p/strike": record("nnnn", { strikes: 1, sl: 1 }) };
  const before = { "p/a": { r: "rate", n: 2, at: "2026-10-01T00:00:00.000Z" }, "p/done": { r: "cap", n: 1, at: "2026-10-01T00:00:00.000Z" }, "p/gone": { r: "cap", n: 1, at: "2026-10-01T00:00:00.000Z" } };
  const out = updatePending(before, { queue: U("p/a", "p/b", "p/done", "p/strike", "p/c"), recorded: new Set(["p/done"]), store, now: NOW, keepKeys: new Set(["p/a", "p/b", "p/done", "p/strike", "p/c"]),
    reasonOf: (k) => ({ "p/a": "pay", "p/c": "Spend Cap!" })[k] });
  const T = NOW.toISOString();
  assert.deepEqual(out, { "p/a": { r: "pay", n: 3, at: T, since: T, rn: 1 }, "p/b": { r: "not-run", n: 1, at: T, since: T, rn: 1 }, "p/c": { r: "spend-cap-", n: 1, at: T, since: T, rn: 1 } }, "since: the first time THIS reason was recorded (p/a was rate before, so pay starts now)");
  const again = updatePending(out, { queue: U("p/a", "p/b"), recorded: new Set(), store, now: new Date(NOW.getTime() + 86400000), keepKeys: null, reasonOf: (k) => ({ "p/a": "pay" })[k] });
  assert.deepEqual([again["p/a"].n, again["p/a"].since, again["p/a"].at], [4, T, new Date(NOW.getTime() + 86400000).toISOString()], "the same reason again: since stays");
  const legacy = updatePending({ "p/a": { r: "error", n: 2, at: "2026-10-01T00:00:00.000Z" } }, { queue: U("p/a"), recorded: new Set(), store, now: NOW, keepKeys: null, reasonOf: () => "error" });
  assert.equal(legacy["p/a"].since, "2026-10-01T00:00:00.000Z", "an entry written before `since` existed reads as since its last time");
  assert.deepEqual(before["p/a"], { r: "rate", n: 2, at: "2026-10-01T00:00:00.000Z" }, "pure: the input is not changed");
  assert.deepEqual(cleanPending({ "p/ok": { r: "cap", n: 1, at: NOW.toISOString() }, "p/badr": { r: "BAD R", n: 1, at: NOW.toISOString() }, "p/badn": { r: "cap", n: 0, at: NOW.toISOString() },
    "p/bada": { r: "cap", n: 1, at: "x" }, "no slash": { r: "cap", n: 1, at: NOW.toISOString() } }), { "p/ok": { r: "cap", n: 1, at: NOW.toISOString() } });
});

test("the pending map is stored in the same file, counted in the size cap, and survives a save and a load; a file without one loads with none", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  const pending = { "p/a": { r: "rate", n: 3, at: NOW.toISOString() } };
  saveFidelity(f, { "p/m": record("ppnn") }, { realFile: path.join(d, "x", FILE_NAME), now: NOW, pending });
  const back = loadFidelity(f);
  assert.deepEqual(back.pending, pending);
  assert.ok(back.models["p/m"]);
  const text = renderFile([["p/m", record("ppnn")]], NOW, pending);
  assert.equal(fs.readFileSync(f, "utf8"), text, "the file is exactly the rendered text");
  saveFidelity(f, back.models, { realFile: path.join(d, "x", FILE_NAME), now: NOW });
  assert.deepEqual(loadFidelity(f).pending, {}, "a save without a pending map writes none");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, kind: "tool-fidelity", models: {} }));
  assert.deepEqual(loadFidelity(f).pending, {});
});

// ---------------------------------------------------------------- inheritance marks (data only)

test("inherited: a CONFIRMED failure at another provider is `likely-x`; an L3 pass is only an upper bound; a pass never becomes a pass", () => {
  const store = { "groq/llama-3.3-70b": record("pppn"), "other/llama-3.3-70b": record("ffnn", { strikes: 2, sl: 1 }), "fa/alone": record("pppp") };
  assert.deepEqual(inherited("reseller/llama-3.3-70b", { "groq/llama-3.3-70b": store["groq/llama-3.3-70b"] }), { kind: "upper-bound", level: 3, from: "groq/llama-3.3-70b" });
  assert.deepEqual(inherited("reseller/llama-3.3-70b:free", { "other/llama-3.3-70b": store["other/llama-3.3-70b"] }), { kind: "likely-x", from: "other/llama-3.3-70b" }, "a tier suffix does not hide the same model");
  assert.deepEqual(inherited("reseller/llama-3.3-70b", store), { kind: "likely-x", from: "other/llama-3.3-70b", conflict: true }, "a failure wins over a pass, and says there was a conflict");
  assert.equal(inherited("reseller/unrelated", store), null, "no other provider has it");
  for (const r of [inherited("reseller/llama-3.3-70b", { "groq/llama-3.3-70b": store["groq/llama-3.3-70b"] })]) assert.notEqual(r.kind, "pass");
});

test("inherited: own evidence wins; provisional, alias, same-provider and untested sources are ignored; the catalogue claim is a prior only", () => {
  const src = { "a/m1": record("pppp") };
  assert.equal(inherited("b/m1", { ...src, "b/m1": record("ppnn") }), null, "a model with its own confirmed result needs no inheritance");
  assert.deepEqual(inherited("b/m1", { ...src, "b/m1": record("nnnn", { strikes: 1, sl: 1 }) }), { kind: "upper-bound", level: 3, from: "a/m1" }, "a provisional own record is not a result");
  assert.equal(inherited("b/m1", { "a/m1": record("ffnn", { strikes: 1, sl: 1 }) }), null, "a source that failed once is not evidence");
  assert.equal(inherited("b/m1", { "a/m1": record("pppp", { alias: true }) }), null, "an alias row says nothing about the model behind it");
  assert.equal(inherited("a/m1", { "a/m1x": record("pppp"), "a/other": record("pppp") }), null, "the same provider is not another provider");
  assert.equal(inherited("a/m1", { "a/m1:free": record("ffnn", { strikes: 2, sl: 1 }) }), null, "the same model under the SAME provider (a tier suffix) is not another provider");
  assert.equal(inherited("b/m1", { "a/m1": record("nnnn") }), null);
  assert.deepEqual(inherited("b/m1", {}, { toolsClaim: () => true }), { kind: "claim-only", prior: "c" }, "the claim alone is a prior, never a verdict");
  assert.deepEqual(inherited("b/m1", src, { toolsClaim: () => true }), { kind: "upper-bound", level: 3, from: "a/m1", prior: "c" });
  assert.equal(inherited("b/m1", {}, { toolsClaim: () => false }), null);
  assert.equal(inherited("b/m1", src, { resellers: ["c"] }), null, "only the named resellers get a mark");
  assert.ok(inherited("b/m1", src, { resellers: ["b"] }));
  assert.deepEqual(inherited("b/foo", { "a/bar": record("ffnn", { strikes: 2, sl: 1 }) }, { identityOf: () => "same" }), { kind: "likely-x", from: "a/bar" }, "the catalogue decides what the same model is");
  assert.equal(defaultIdentity("openrouter/meta-llama/Llama-3.3-70B:free"), "llama-3.3-70b");
  assert.equal(defaultIdentity("x/model[1m]"), "model");
});

// ---------------------------------------------------------------- the CLI

function env(models, { policy, answer, tiers = { fa: "free", fb: "free" }, presetKeys = null } = {}) {
  const dir = freshDir();
  const rows = [{ provider: "anthropic", keyId: RELAY_KEY_ID, models: [{ id: "claude-x", outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "PLAN" }] }];
  const by = new Map();
  for (const [p, id, ctx = 200000] of models) { if (!by.has(p)) by.set(p, []); by.get(p).push({ id, outModality: "chat", ctx, tools: true, pin: 0, pout: 0, badge: "FREE" }); }
  for (const [provider, ms] of by) rows.push({ provider, keyId: `k.${provider}.free`, models: ms });
  const known = new Set(models.map(([p, id]) => `${p}/${id}`)).add("anthropic/claude-x");
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, policy: policy === null ? null : { ...(policy ?? POLICY()), tiers }, presetKeys,
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
  return { dir, deps, f, out: deps.outFile };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const SIX = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id) => ["fa", id, id === "m4" ? 64000 : id === "m5" ? 0 : 200000]);
const POL = POLICY(["fa/m3", 200000], ["fa/m1", 200000], ["fa/m2", 200000], ["fa/m4", 64000], ["fa/m5", 0]);
const CAP = ["--tf-max-tokens-per-provider", "400000"];

test("arguments: --candidates policy and --sample make the default levels 1 to 7 (an explicit --levels wins); the new flags are validated", () => {
  assert.deepEqual(parseArgs(["--candidates", "policy"]).levels, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseArgs(["--candidates", "policy", "--levels", "35"]).levels, [3, 5]);
  const s = parseArgs(["--sample"]);
  assert.deepEqual([s.sample, s.candidates, s.levels, s.seed], [60, true, [1, 2, 3, 4, 5, 6, 7], "1"], "a bare --sample is 60 models and implies the candidates");
  assert.deepEqual([parseArgs(["--sample", "20", "--seed", "abc"]).sample, parseArgs(["--sample", "20", "--seed", "abc"]).seed], [20, "abc"]);
  assert.equal(parseArgs(["--sample", "--live"]).sample, 60, "a following flag is not the number");
  assert.deepEqual(parseArgs(["--candidates", "policy", "--include-tier", "paid,free-deposit"]).includeTiers, ["paid", "free-deposit"]);
  for (const bad of [["--candidates", "policy", "--include-tier", "free"], ["--candidates", "policy", "--include-tier", "gold"], ["--candidates", "policy", "--include-tier"], ["--include-tier", "paid"], ["--key-choices-file", "c.json"],
    ["--candidates", "policy", "--tiers-file"], ["--sample", "0"], ["--sample", "5", "--seed"], ["--candidates", "all"], ["--candidates", "policy", "--allow", "nomodel"], ["--candidates", "policy", "--retry-failed"]]) assert.ok(parseArgs(bad).error, bad.join(" "));
  assert.equal(parseArgs(["--candidates", "policy", "--tiers-file", "t.json", "--pending-runs", "5"]).pendingRuns, 5);
  assert.equal(parseArgs(["--tiers-file", "t.json", "--key-choices-file", "c.json"]).keyChoicesFile, "c.json", "the tier file and the owner's key choices apply to every run, not only the candidates");
});

test("DRY RUN with --candidates policy: the candidate block with priority counts and exclusions, the ENVELOPE of the whole queue, both ledgers; nothing is sent or written", async () => {
  const e = env([...SIX, ["fb", "b1", 20000], ["fb", "b2", 100000]], { policy: POL, presetKeys: new Set(["fa/m6"]) });
  const before = fs.readdirSync(e.dir).sort();
  const r = await run(["--candidates", "policy"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(e.f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(e.dir).sort(), before);
  assert.match(r.out, /levels L1\+L2\+L3\+L4\+big\+L6\+L7/);
  assert.match(r.out, /candidates \(free tier\): 7 of 8 model\(s\) in the probe set, whether or not their context is known; priority 1 policy allowed >= 128,000 or pinned 3, 2 preset union 1, 3 other >= 128,000 0, 4 unknown context 1, 5 known below 128,000 2 \(an ordering, never a limit\)/);
  assert.match(r.out, /excluded: ctx-too-small-for-fixture 1, relay-by-provenance 1/);
  assert.match(r.out, /big step skipped for 2 model\(s\) whose known context is below 200,000 \(never recorded as a failure\)/);
  assert.match(r.out, /envelope, the WHOLE queue at full depth \(before any cap\): \d+ requests, ~[\d.]+[Mk] input tokens, 8 model\(s\) of 8 in the probe set on 2 provider\(s\)/, "the small-context model is in the queue too: for its small requests only");
  assert.match(r.out, /finishing in ONE run needs --tf-max-tokens-per-provider [\d,]+ \(largest: fa [\d.]+[Mk].*\); at the cap of 150,000 it takes about \d+ run\(s\)/);
  assert.doesNotMatch(r.out, /WARNING: .* cost more than the cap on their own/, "a fully tested model is about 150,000 tokens: it fits the default cap of 150,000 (just)");
  assert.match(r.out, /per request \(a full-depth model sends each row once/);
  assert.match(r.out, /wall time, an estimate: about .* to .* for this run/);
  assert.match(r.out, /coverage L3 .*: 9 model\(s\) = tested 0 \(none\) \+ pending 7 \(.*\) \+ excluded 2 \(/);
});

test("--candidates policy needs the provider key tiers (the policy's `tiers`, or --tiers-file) and a compiled policy: otherwise an error that plans nothing", async () => {
  const noTiers = env(SIX, { policy: POL, tiers: undefined });
  noTiers.deps.policy = { ...POL };
  const a = await run(["--candidates", "policy"], noTiers.deps);
  assert.equal(a.code, 1);
  assert.match(a.err, /needs the provider key tiers/);
  const fromFile = path.join(noTiers.dir, "tiers.json");
  fs.writeFileSync(fromFile, JSON.stringify({ fa: "free" }));
  const b = await run(["--candidates", "policy", "--tiers-file", fromFile], noTiers.deps);
  assert.equal(b.code, 0, b.err);
  assert.match(b.out, /candidates \(free tier\): 6 of 6 model\(s\) in the probe set/);
  const e = env(SIX, { policy: null });
  const c = await run(["--candidates", "policy", "--policy-file", path.join(e.dir, "nope.json")], e.deps);
  assert.equal(c.code, 1);
  assert.match(c.err, /needs a compiled policy .*missing or is not one/);
});

test("LIVE candidates: every free-tier model in PRIORITY order; the per-provider cap stops the run and the tail is pending: cap and picked up by the next; the big step is skipped below 200,000 of known context", async () => {
  const e = env(SIX, { policy: POL });
  const args = ["--candidates", "policy", "--l3", "yes", ...CAP];
  const r1 = await run(["--live", ...args], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  assert.deepEqual(calls(e.f).filter((c) => c.bytes > 300000).map((c) => c.body.model), ["fa/m3", "fa/m1"], "two models of 178,000 tokens fit 400,000, in the policy's rank: m3 then m1");
  const s1 = loadFidelity(e.out);
  assert.deepEqual(Object.keys(s1.models).sort(), ["fa/m1", "fa/m3"]);
  assert.deepEqual([s1.models["fa/m3"].lvr, s1.models["fa/m3"].big, s1.models["fa/m3"].t], ["pppp", "p", "v"], "L1, L2, L3, L4 and the big step all passed");
  assert.deepEqual(Object.keys(s1.pending).sort(), ["fa/m2", "fa/m4", "fa/m5", "fa/m6"], "the whole tail waits, not just the next ones");
  assert.ok(Object.values(s1.pending).every((p) => p.r === "cap" && p.n === 1));
  assert.match(r1.out, /coverage L3 .*: 7 model\(s\) = tested 2 \(v 2\) \+ pending 4 \(cap 4\) \+ excluded 1 \(relay-by-provenance 1\)/);
  const r2 = await run(["--live", ...args], e.deps);
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.deepEqual(calls(e.f).filter((c) => c.bytes > 300000).map((c) => c.body.model).slice(2), ["fa/m2", "fa/m6"], "next in rank: m2 (policy), then m6 (other >= 128,000)");
  const r3 = await run(["--live", ...args], e.deps);
  const s3 = loadFidelity(e.out);
  assert.deepEqual(Object.keys(s3.models).sort(), ["fa/m1", "fa/m2", "fa/m3", "fa/m4", "fa/m5", "fa/m6"], "every candidate covered after three runs");
  assert.deepEqual(s3.pending, {});
  assert.equal(s3.models["fa/m4"].big, undefined, "m4's known context is 64,000: the big step was never asked, and nothing was recorded as failed");
  assert.equal(calls(e.f).filter((c) => c.body.model === "fa/m4" && c.bytes > 300000).length, 0);
  assert.equal(s3.models["fa/m5"].big, "p", "an UNKNOWN context is tested at the big step");
  assert.match(r3.out, /coverage L3 .*= tested 6 \(v 6\) \+ pending 0 \(none\) \+ excluded 1/);
  assert.match((await run(["--live", ...args], e.deps)).out, /nothing to probe/);
});

test("--include-tier paid does NOT make the paid provider probeable by itself: it stays out of the probe set (reason `not-free-tier (skipped for now)`) and the dry run says what is still missing", async () => {
  const e = env([["fa", "m1"], ["fp", "p1"]], { policy: POLICY(["fa/m1", 200000]), tiers: { fa: "free", fp: "paid" } });
  e.deps.snapshot.snap.rows.find((r) => r.provider === "fp").models[0] = { id: "p1", outModality: "chat", ctx: 200000, tools: true, pin: 1, pout: 2, badge: "PAID" };
  const base = await run(["--candidates", "policy", ...CAP], e.deps);
  assert.match(base.out, /1 skipped for now because the provider's key tier is not free \(paid 1\); 1 in the probe set/);
  assert.match(base.out, /candidates \(free tier\): 1 of 1 model\(s\) in the probe set/);
  assert.match(base.out, /excluded: relay-by-provenance 1, not-free-tier \(skipped for now\) 1/);
  assert.match(base.out, /free tier 1 model\(s\): no money; paid tier 0 model\(s\): estimate \$0\.000/);
  const req = await run(["--candidates", "policy", "--include-tier", "paid", ...CAP], e.deps);
  assert.match(req.out, /candidates \(free tier \+ paid\): 1 of 1 model\(s\) in the probe set/, "still one candidate");
  assert.match(req.out, /excluded: relay-by-provenance 1, not-free-tier \(skipped for now\) 1/);
  assert.match(req.out, /deep probes for paid stay skipped until all of these hold: an explicit --levels that lists the levels to run; --live; an explicit --max-spend/);
  assert.equal(e.f.calls.length, 0, "dry");
});

test("pins: --allow puts a model first in line, whatever its tier or context", async () => {
  const e = env(SIX, { policy: POL });
  const r = await run(["--candidates", "policy", "--allow", "fa/m4,fa/m6"], e.deps);
  assert.match(r.out, /priority 1 policy allowed >= 128,000 or pinned 5,/, "m3, m1, m2 from the policy and the two pins");
});

test("the pending map records WHY: a rate-limited model is pending `rate` and counted run by run until it is tested; a stuck one is listed", async () => {
  let limited = true;
  const e = env([["fa", "m1"], ["fa", "m2"]], { policy: POLICY(["fa/m1", 200000], ["fa/m2", 200000]), answer: (c) => (limited && c.body.model === "fa/m2" ? http(429, "slow down") : goodModel(c)) });
  const args = ["--candidates", "policy", "--l3", "yes", ...CAP, "--pending-runs", "2"];
  const a = await run(["--live", ...args], e.deps);
  assert.equal(loadFidelity(e.out).pending["fa/m2"].r, "rate");
  assert.equal(loadFidelity(e.out).pending["fa/m2"].n, 1);
  assert.match(a.out, /pending 1 \(rate 1\)/);
  const b = await run(["--live", ...args], e.deps);
  assert.equal(loadFidelity(e.out).pending["fa/m2"].n, 2);
  assert.match(b.out, /pending too long 1 of \d+: fa\/m2 rate x2/);
  limited = false;
  await run(["--live", ...args], e.deps);
  assert.deepEqual(loadFidelity(e.out).pending, {}, "tested at last: no longer pending");
  assert.ok(loadFidelity(e.out).models["fa/m2"]);
});

test("a model that failed once shows in the report as provisional (first-strike), never as failed", async () => {
  const e = env([["fa", "m1"]], { policy: POLICY(["fa/m1", 200000]), answer: (c) => (c.body.tool_choice ? { status: 200, body: "event: message_start\ndata: {}\n\n" + "event: message_stop\ndata: {}\n\n" } : goodModel(c)) });
  const r = await run(["--live", "--candidates", "policy", "--l3", "yes", ...CAP], e.deps);
  assert.match(r.out, /failed once \(provisional, asked again, not yet x\) 1 of \d+: fa\/m1 L1/);
  assert.match(r.out, /pending 1 \(first-strike 1\)/);
  assert.doesNotMatch(r.out, /tested \d+ \([^)]*x \d/, "no x in the tested counts");
  assert.equal(loadFidelity(e.out).models["fa/m1"].strikes, 1);
});

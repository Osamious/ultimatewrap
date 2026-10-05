// The candidates step, the coverage ledger and the inheritance marks of the tool-fidelity probe. Offline: fixtures only, in temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { freshDir, fakeFetch, goodModel, http, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs } from "../refresh/tool-fidelity-cli.mjs";
import {
  probeSet, selectCandidates, coverage, assertPartition, coverageLines, ledgerUniverses, updatePending, cleanPending, inherited, defaultIdentity, queueFor,
  loadFidelity, saveFidelity, loadPolicy, renderFile, FILE_NAME, REAL_FILE,
} from "../refresh/tool-fidelity.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";

guardRealState(after, assert);
after(() => { assert.equal(rawExists(REAL_FILE), false, "state/tool-fidelity.json must not exist after the tests"); });
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

test("candidates: the policy's ALLOWED set with a known ctx of at least 128,000, in the policy's own rank, NOT limited to 3 per provider; pins first and exempt from the filters", () => {
  const { snap, bench } = world((i) => (i === 4 ? 64000 : i === 5 ? 0 : 200000), 8);
  const set = probeSet(snap, bench);
  const policy = POLICY(["fa/m3", 200000], ["fb/b1", 1000000], ["fa/m1", 200000], ["fa/m4", 64000], ["fa/m5", 0], ["fa/m6", 200000], ["fa/m7", 128000], ["fa/m8", 200000]);
  const c = selectCandidates({ set, policy });
  assert.deepEqual(c.entries.map((e) => e.key), ["fa/m3", "fb/b1", "fa/m1", "fa/m6", "fa/m7", "fa/m8"], "policy order; 6 of fa's models are candidates, not 3 (and 128,000 exactly is at the floor)");
  assert.equal(c.entries.filter((e) => e.provider === "fa").length, 5, "five fa models: far beyond the router's top 3");
  const why = Object.fromEntries(c.excluded.map((e) => [e.key, e.reason]));
  assert.deepEqual(why, { "fa/m4": "ctx-below-floor", "fa/m5": "ctx-unknown", "fa/m2": "outside-toggles", "fb/b2": "outside-toggles", "anthropic/claude-x": "relay-by-provenance" });
  assert.equal(c.entries.length + c.excluded.length, set.models.length + set.relay.length, "every probe-ok model and the relay is in exactly one list");
  const pinned = selectCandidates({ set, policy, pins: ["fa/m4", "fb/b2", "fa/m1", "fa/nosuch"] });
  assert.deepEqual(pinned.entries.map((e) => e.key).slice(0, 3), ["fa/m4", "fb/b2", "fa/m1"], "pins come first, in the order given, whatever their ctx or toggles");
  assert.deepEqual(pinned.entries.filter((e) => e.pinned).map((e) => e.key), ["fa/m4", "fb/b2", "fa/m1"]);
  assert.equal(pinned.entries.filter((e) => e.key === "fa/m1").length, 1, "a pin that is also allowed is listed once");
  assert.deepEqual(pinned.pinned, ["fa/nosuch"], "a pin that is not a probe-ok model is reported, not invented");
  assert.deepEqual(selectCandidates({ set, policy: POLICY() }).entries, [], "an empty policy: no candidates");
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
  assert.deepEqual(l12.counts, { total: 12, tested: 5, pending: 4, excluded: 3, byTier: { v: 2, t: 2, x: 1 }, byPending: { "first-strike": 1, rate: 1, cap: 1, "not-run": 1 }, byExcluded: { "relay-by-provenance": 1, "not-probe-ok": 1, "invalid-id": 1 } }, "L1+L2: p/cap passed L1+L2 (tier t)");
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
  const cand = selectCandidates({ set, policy: POLICY(["fa/m1", 200000], ["fa/m2", 200000]) });
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
  assert.deepEqual(out, { "p/a": { r: "pay", n: 3, at: NOW.toISOString() }, "p/b": { r: "not-run", n: 1, at: NOW.toISOString() }, "p/c": { r: "spend-cap-", n: 1, at: NOW.toISOString() } });
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

function env(models, { policy, answer } = {}) {
  const dir = freshDir();
  const rows = [{ provider: "anthropic", keyId: RELAY_KEY_ID, models: [{ id: "claude-x", outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "PLAN" }] }];
  const by = new Map();
  for (const [p, id, ctx = 200000] of models) { if (!by.has(p)) by.set(p, []); by.get(p).push({ id, outModality: "chat", ctx, tools: true, pin: 0, pout: 0, badge: "FREE" }); }
  for (const [provider, ms] of by) rows.push({ provider, keyId: `k.${provider}.free`, models: ms });
  const known = new Set(models.map(([p, id]) => `${p}/${id}`)).add("anthropic/claude-x");
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, policy,
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
const SIX = ["m1", "m2", "m3", "m4", "m5", "m6"].map((id, i) => ["fa", id, id === "m4" ? 64000 : id === "m5" ? 0 : 200000]);
const POL = POLICY(["fa/m3", 200000], ["fa/m1", 200000], ["fa/m2", 200000], ["fa/m4", 64000], ["fa/m5", 0]);

test("arguments: --candidates policy makes the default levels 1,2,3,5 (an explicit --levels wins); --allow and --policy-file need it; it is its own pass", () => {
  const o = parseArgs(["--candidates", "policy"]);
  assert.deepEqual([o.candidates, o.levels, o.allow, o.pendingRuns], [true, [1, 2, 3, 5], [], 3]);
  assert.deepEqual(parseArgs(["--candidates", "policy", "--levels", "35"]).levels, [3, 5]);
  assert.deepEqual(parseArgs(["--candidates", "policy", "--allow", "fa/m4,fb/b2", "--policy-file", "p.json", "--pending-runs", "5"]).allow, ["fa/m4", "fb/b2"]);
  assert.equal(parseArgs(["--candidates", "policy", "--pending-runs", "5"]).pendingRuns, 5);
  for (const bad of [["--candidates", "all"], ["--candidates"], ["--allow", "fa/m1"], ["--policy-file", "x"], ["--candidates", "policy", "--allow", "nomodel"], ["--candidates", "policy", "--retry-failed"], ["--candidates", "policy", "--policy-file"]]) {
    assert.ok(parseArgs(bad).error, bad.join(" "));
  }
});

test("DRY RUN with --candidates policy: the candidate block, the exclusions, both ledgers and the estimate; nothing is sent or written", async () => {
  const e = env([...SIX, ["fb", "b1"]], { policy: POL });
  const before = fs.readdirSync(e.dir).sort();
  const r = await run(["--candidates", "policy"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(e.f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(e.dir).sort(), before);
  assert.match(r.out, /candidates \(policy\): 3 of 7 probe-ok model\(s\) can be picked by the router \(known context of at least 128,000\); in the policy's own rank, best first/);
  assert.match(r.out, /excluded: .*outside-toggles 2.*relay-by-provenance 1.*ctx-below-floor 1.*ctx-unknown 1|excluded: .*ctx-below-floor 1/);
  assert.match(r.out, /coverage L1\+L2 \(every listed model\): 8 model\(s\) = tested 0 \(none\) \+ pending 7 \(.*\) \+ excluded 1 \(relay-by-provenance 1\)/);
  assert.match(r.out, /coverage L3 \(candidates and the rest of the probe set\): 8 model\(s\) = tested 0 \(none\) \+ pending 3 \(.*\) \+ excluded 5 \(/);
  assert.match(r.out, /L3 and L4 each send/);
});

test("--candidates policy needs a compiled policy: missing or not one is an error that plans nothing", async () => {
  const e = env(SIX, { policy: null });
  const r = await run(["--candidates", "policy", "--policy-file", path.join(e.dir, "nope.json")], e.deps);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a compiled policy .*missing or is not one/);
});

test("LIVE candidates: L3 and the big step in the policy's own rank; the per-provider cap stops the run, the tail is pending: cap and the next run picks it up; counts and the ledger add up", async () => {
  const e = env(SIX, { policy: POL });
  const args = ["--candidates", "policy", "--l3", "yes", "--tf-max-tokens-per-provider", "300000"];
  const r1 = await run(["--live", ...args], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  const order = calls(e.f).filter((c) => c.bytes > 300000).map((c) => c.body.model);
  assert.deepEqual(order, ["fa/m3", "fa/m1"], "two models fit 300,000 input tokens (L1+L2+L3+big is about 140,000 each), in the policy's rank: m3 then m1");
  const s1 = loadFidelity(e.out);
  assert.deepEqual(Object.keys(s1.models).sort(), ["fa/m1", "fa/m3"]);
  assert.deepEqual([s1.models["fa/m3"].lvr, s1.models["fa/m3"].big, s1.models["fa/m3"].t], ["ppp" + "n", "p", "v"], "L1, L2, L3 passed, the big step passed");
  assert.deepEqual(s1.pending, { "fa/m2": { r: "cap", n: 1, at: NOW.toISOString() } }, "the untested tail of the CANDIDATES waits, with its reason and one run counted; non-candidates are not in this run");
  assert.match(r1.out, /coverage L3 \(candidates and the rest of the probe set\): 7 model\(s\) = tested 2 \(v 2\) \+ pending 1 \(cap 1\) \+ excluded 4 \(/);
  assert.match(r1.out, /coverage L1\+L2 \(every listed model\): 7 model\(s\) = tested 2 \(.*\) \+ pending 4 \(.*\) \+ excluded 1 \(relay-by-provenance 1\)/);
  const r2 = await run(["--live", ...args], e.deps);
  assert.equal(r2.code, 0, r2.err + r2.out);
  const s2 = loadFidelity(e.out);
  assert.deepEqual(Object.keys(s2.models).sort(), ["fa/m1", "fa/m2", "fa/m3"], "the tail is covered by the next run");
  assert.deepEqual(s2.pending, {}, "and its pending entry is gone");
  assert.equal(calls(e.f).filter((c) => c.body.model === "fa/m3").length, 4, "m3 was asked its 4 levels once, in the first run");
  assert.match(r2.out, /coverage L3 .*: 7 model\(s\) = tested 3 \(v 3\) \+ pending 0 \(none\) \+ excluded 4/);
  const r3 = await run(["--live", ...args], e.deps);
  assert.match(r3.out, /nothing to probe/);
});

test("pins: --allow adds a model that is outside the toggles or below the ctx floor, first in line", async () => {
  const e = env(SIX, { policy: POL });
  const r = await run(["--candidates", "policy", "--allow", "fa/m4,fa/m6"], e.deps);
  assert.match(r.out, /candidates \(policy\): 5 of 6 probe-ok model\(s\).*2 pinned by --allow/);
  assert.match(r.out, /excluded: .*ctx-unknown 1/, "m5 is still out: it was not pinned");
});

test("the pending map records WHY: a rate-limited model is pending `rate` and counted run by run until it is tested; a stuck one is listed", async () => {
  let limited = true;
  const e = env([["fa", "m1"], ["fa", "m2"]], { policy: POLICY(["fa/m1", 200000], ["fa/m2", 200000]), answer: (c) => (limited && c.body.model === "fa/m2" ? http(429, "slow down") : goodModel(c)) });
  const args = ["--candidates", "policy", "--l3", "yes", "--tf-max-tokens-per-provider", "300000", "--pending-runs", "2"];
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
  const r = await run(["--live", "--candidates", "policy", "--l3", "yes", "--tf-max-tokens-per-provider", "300000"], e.deps);
  assert.match(r.out, /failed once \(provisional, asked again, not yet x\) 1 of \d+: fa\/m1 L1/);
  assert.match(r.out, /pending 1 \(first-strike 1\)/);
  assert.doesNotMatch(r.out, /tested \d+ \([^)]*x \d/, "no x in the tested counts");
  assert.equal(loadFidelity(e.out).models["fa/m1"].strikes, 1);
});

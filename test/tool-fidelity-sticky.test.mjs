// The sweep loop (owner rule 2026-10-06): hard reasons (pay, auth, gone) are STICKY: a hold never expires by time and a model pending one of them is not queued again by a normal run; only a manual lift
// (`--recheck-hard`, `--retry-accounts`, `--release-holds`) re-asks them. A run ends with a verdict (recoverable / hard-blocked / tested, each with its denominator) and a machine-readable
// `SATURATION ...` line a loop script can stop on. Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, fakeFetch, goodModel, http, record, kindOf, ev, stream, ok } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan, toolSweepExit, verdictLines, saturationLines, hardLines, scopeOf, capReasonOf, pendingReasonOf, trendLine, liveRefusal } from "../refresh/tool-fidelity-cli.mjs";
import { runKind, isQuotaSentence, hasMoneyWords, probeModel, MAX_MODEL_REQUESTS } from "../refresh/tool-fidelity-probe.mjs";
import { runSweep } from "../refresh/bench.mjs";
import { SWEEP_SOFT, SWEEP_HARD } from "../menu/subagent-funnel.mjs";
import { activeHolds, hardState, recheckCovers, releaseHolds, sweepVerdict, saturation, coverage, confirmedProviders, saveFidelity, loadFidelity, cleanMeta, cleanPending, migrateAvailabilityPay, payHoldsOnBareEvidence, PENDING_WHY_CHARS, appendHistory, historyOf, PAUSED_REASONS, STUCK_REASONS, OWNER_REASONS, DEFAULT_LEVELS, diminishingReturns, runGain, testedState, capRecords, renderFile, updatePending, TRIED_REASONS, HELD_PLAN, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-06T12:00:00.000Z");
const DAY = 86400000;
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
const many = (p, n) => ({ provider: p, keyId: `k.${p}.free`, models: Array.from({ length: n }, (_, i) => m(`m${i}`)) });
const CAP = ["--tf-max-tokens-per-provider", "17100"];            // three models of about 5,670 tokens per provider

function cliEnv(rows, { answer, store, held, pending } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], rateBackoffMs: 1, sweep: { ...SWEEP_FAST }, retryDelayMs: 1 };
  if (store || held || pending) saveFidelity(deps.outFile, store ?? {}, { now: NOW, held: held ?? {}, pending: pending ?? {} });
  return { dir, deps, f, out: deps.outFile, rows };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(pinL12(argv), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n"), lines: out.join("\n").split("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const byProv = (f) => { const o = {}; for (const c of calls(f)) { const p = c.body.model.split("/")[0]; o[p] = (o[p] ?? 0) + 1; } return o; };
const planOf = (e, argv, { store = {}, pending = {}, held = {}, nowMs = NOW.getTime() } = {}) => plan({ snap: { rows: e.rows }, bench: e.deps.bench, store, o: parseArgs(pinL12(argv)), tiers: e.deps.tiers, pending, held, nowMs });
const keys = (p) => p.queued.map((x) => x.key).sort();
const pend = (r, n = 2, h = 1) => ({ r, n, at: hoursAgo(h) });

// ---------------------------------------------------------------- holds never expire by time

test("a hold does not expire: 7 days, 400 days later the provider is still left out of the queue; --hold-hours is an opt-in expiry; --retry-accounts and --recheck-hard lift it", () => {
  const e = cliEnv([many("pa", 2), many("pb", 2)]);
  for (const days of [0.25, 7, 400]) {
    const nowMs = NOW.getTime() + days * DAY;
    assert.deepEqual(keys(planOf(e, [], { held: { pb: { r: "pay", at: NOW.toISOString() } }, nowMs })), ["pa/m0", "pa/m1"], `${days} days after the hold: pb is still held`);
  }
  const later = NOW.getTime() + 7 * DAY, held = { pb: { r: "pay", at: NOW.toISOString() } };
  assert.deepEqual(keys(planOf(e, ["--hold-hours", "6"], { held, nowMs: later })), ["pa/m0", "pa/m1", "pb/m0", "pb/m1"], "opt-in expiry: --hold-hours 6 ends a 7-day-old hold");
  assert.deepEqual(keys(planOf(e, ["--retry-accounts"], { held, nowMs: later })), ["pa/m0", "pa/m1", "pb/m0", "pb/m1"]);
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "pay"], { held, nowMs: later })), ["pa/m0", "pa/m1", "pb/m0", "pb/m1"]);
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "gone"], { held, nowMs: later })), ["pa/m0", "pa/m1"], "rechecking gone does not lift a pay hold");
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "pay,pa"], { held, nowMs: later })), ["pa/m0", "pa/m1"], "rechecking pay for pa only does not lift pb");
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "pb"], { held, nowMs: later })), ["pa/m0", "pa/m1", "pb/m0", "pb/m1"], "a provider alone: every hard reason of that provider");
  assert.equal(Object.keys(activeHolds(held, later, null)).length, 1);
  assert.equal(activeHolds(held, later).pb.until, null);
  assert.equal(parseArgs([]).holdHours, null);
  assert.equal(parseArgs(["--hold-hours", "6"]).holdHours, 6, "still accepted");
});

test("--recheck-hard parses reasons and providers; no reason named means all three; junk and an empty list are refused", () => {
  assert.deepEqual(parseArgs(["--recheck-hard", "pay,auth"]).recheckHard, { reasons: ["pay", "auth"], providers: [] });
  assert.deepEqual(parseArgs(["--recheck-hard", "gone,pa,pb"]).recheckHard, { reasons: ["gone"], providers: ["pa", "pb"] });
  assert.deepEqual(parseArgs(["--recheck-hard", "pa"]).recheckHard, { reasons: ["pay", "auth", "gone"], providers: ["pa"] });
  assert.equal(parseArgs([]).recheckHard, null);
  assert.ok(parseArgs(["--recheck-hard"]).error);
  assert.ok(parseArgs(["--recheck-hard", "pay,bad name!"]).error);
  assert.ok(recheckCovers({ reasons: ["pay"], providers: [] }, "pay", "x"));
  assert.ok(!recheckCovers({ reasons: ["pay"], providers: ["y"] }, "pay", "x"));
  assert.ok(!recheckCovers(null, "pay", "x"));
});

// ---------------------------------------------------------------- hard pending reasons are not queued again

test("a model pending pay, auth or gone (also canary-*) is NOT queued by a normal run, with no hold in the file; rate, error, timeout, cap, not-run and the rest are queued", () => {
  const rows = [many("pa", 12)];
  const e = cliEnv(rows);
  const hard = ["pay", "auth", "gone", "canary-pay", "canary-auth", "canary-gone"], soft = ["rate", "error", "timeout", "cap", "not-run", "empty", "slow", "reasoning-budget", "upstream-unavailable", "request-cap", "spend"];
  const pending = {};
  hard.forEach((r, i) => { pending[`pa/m${i}`] = pend(r, 5); });
  soft.slice(0, 6).forEach((r, i) => { pending[`pa/m${i + 6}`] = pend(r, 5); });
  const p = planOf(e, ["--tf-max-tokens-per-provider", "1000000"], { pending });
  assert.deepEqual(p.queued.map((x) => x.key.slice(3)).sort(), ["m10", "m11", "m6", "m7", "m8", "m9"].sort(), "only the six models with no hard reason: the soft ones and the one never asked");
  assert.deepEqual(p.hardBlocked, { models: 6, by: { pay: 2, auth: 2, gone: 2 } });
  // the soft reasons all stay queued
  const e2 = cliEnv([many("pb", soft.length)]);
  const pend2 = Object.fromEntries(soft.map((r, i) => [`pb/m${i}`, pend(r, 5)]));
  assert.equal(planOf(e2, ["--tf-max-tokens-per-provider", "1000000"], { pending: pend2 }).queued.length, soft.length);
  // a manual lift puts them back
  for (const argv of [["--retry-accounts"], ["--recheck-hard", "pay,auth,gone"], ["--recheck-hard", "pa"]]) {
    assert.equal(planOf(e, ["--tf-max-tokens-per-provider", "1000000", ...argv], { pending }).queued.length, 12, argv.join(" "));
  }
  const some = planOf(e, ["--tf-max-tokens-per-provider", "1000000", "--recheck-hard", "pay"], { pending });
  assert.deepEqual(some.queued.map((x) => x.key.slice(3)).filter((k) => hard.map((_, i) => `m${i}`).includes(k)).sort(), ["m0", "m3"], "pay and canary-pay only; auth and gone stay blocked");
  // the ledger keeps the stored reasons (they are the audit trail) and the verdict calls them hard
  assert.deepEqual(p.ledger.l12.counts.byPending.pay, 1);
  assert.deepEqual(p.verdict.byHard, { pay: 2, auth: 2, gone: 2 });
});

test("canary-pay / canary-gone of a provider that has CONFIRMED results is not a hard block (the provider answered); canary-auth and a plain pay still are", () => {
  const confirmed = { pa: 1 };
  assert.equal(hardState("canary-pay", "pa", confirmed), null);
  assert.equal(hardState("canary-gone", "pa", confirmed), null);
  assert.equal(hardState("canary-auth", "pa", confirmed), "auth");
  assert.equal(hardState("pay", "pa", confirmed), "pay", "a model's own pay answer stays");
  assert.equal(hardState("canary-pay", "pb", confirmed), "pay");
  assert.equal(hardState("rate", "pb"), null);
  assert.equal(hardState(undefined, "pb"), null);
  const e = cliEnv([many("pa", 2), many("pb", 2)]);
  const pending = { "pa/m0": pend("canary-pay"), "pb/m0": pend("canary-pay") };
  const p = planOf(e, [], { pending, store: { "pa/known": record("ppnn") } });
  assert.deepEqual(keys(p), ["pa/m0", "pa/m1", "pb/m1"], "pa/m0 is asked again, pb/m0 is blocked");
});

test("a model with a result is never queued again by a normal run; a recoverable one is; a first strike is asked again", () => {
  const e = cliEnv([many("pa", 4)]);
  const store = { "pa/m0": record("ppnn"), "pa/m1": record("ffnn", { strikes: 2, sl: 1 }), "pa/m2": record("fnnn", { strikes: 1, sl: 1 }) };
  const p = planOf(e, [], { store, pending: { "pa/m3": pend("rate", 4) } });
  assert.deepEqual(keys(p), ["pa/m2", "pa/m3"], "m0 and m1 have results; the first strike and the rate-limited one are asked again");
  assert.deepEqual(p.verdict.byRecoverable, { "first-strike": 1, rate: 1 });
});

// ---------------------------------------------------------------- the verdict is the ledger's partition

test("the verdict counts match the ledger partition (tested + pending + held + excluded) and name their denominator", () => {
  const rows = [many("pa", 6), many("pb", 3), many("pc", 3), { provider: "pd", keyId: "k.pd.free", models: [m("m0"), m("m1", { badge: "PAID", pin: 500, pout: 500 })] }];       // pd/m1 is priced over the row ceiling: its stored row-cost is NEEDS-OWNER
  const e = cliEnv(rows);
  const store = { "pa/m0": record("ppnn"), "pa/m1": record("ppnn"), "pd/m0": record("ppnn") };
  const pending = { "pa/m2": pend("rate"), "pa/m3": pend("error"), "pa/m4": pend("pay"), "pc/m0": pend("gone"), "pc/m1": pend("auth"), "pd/m1": pend("row-cost") };
  const p = planOf(e, [], { store, pending, held: { pb: { r: "pay", at: hoursAgo(100) } } });
  const l = p.ledger.l12.counts, v = p.verdict;
  assert.equal(v.tested, l.tested);
  assert.equal(v.hard, l.held + 3, "the held provider's three models plus pay, gone and auth models (pa/m4, pc/m0, pc/m1)");
  assert.equal(v.owner, 1);
  assert.equal(v.recoverable, l.pending - 3 - 1, "the pending ones that are neither hard nor needs-owner");
  assert.equal(v.total, v.tested + v.recoverable + v.hard + v.owner);
  assert.equal(v.total, l.total - l.excluded);
  assert.deepEqual(v.byHard, { gone: 1, auth: 1, pay: 4 });
  assert.deepEqual(v.byOwner, { "row-cost": 1 });
  assert.equal(v.byRecoverable.rate, 1);
  assert.equal(v.byRecoverable.error, 1);
  const text = verdictLines(v);
  assert.match(text[0], /^sweep verdict: RECOVERABLE \d+ of 14 \(.*\) \| HARD-BLOCKED 6 of 14 \(.*pay 4.*; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 14 \(complete for every level it is eligible for 0 of 3; tested but optional levels not run: 3 of 3 model\(s\), 6 level gap\(s\) \(a model can have more than one\): .*spawn 3.*\) \| NEEDS-OWNER 1 of 14 \(row-cost 1: raise --max-row-cost; a re-run alone changes nothing\)/);
  assert.match(text[1], /population: 14 model\(s\) of the ledger that are not excluded \(0 more are excluded/);
  assert.ok(!text.some((x) => x.startsWith("DONE")), "something is recoverable");
});

test("candidates: a model counts once across the two ledgers, the worst state winning; excluded ones are outside the denominator", () => {
  const l12 = coverage([{ key: "pa/a" }, { key: "pa/b" }, { key: "pa/c" }, { key: "pa/x", excluded: "not-probe-ok" }], { "pa/a": record("ppnn"), "pa/b": record("ppnn") }, { pending: {}, plan: {} });
  const l3 = coverage([{ key: "pa/a" }, { key: "pa/b" }, { key: "pa/c" }, { key: "pa/x", excluded: "ctx-floor" }], { "pa/a": record("pppp"), "pa/b": record("ppnn") }, { level: "l3", pending: {}, plan: { "pa/b": "queued" } });
  const v = sweepVerdict({ l12, l3 });
  assert.deepEqual([v.tested, v.recoverable, v.hard, v.total, v.excluded], [1, 2, 0, 3, 1], "a: tested in both; b: tested at L1+L2 but L3 is waiting; c: never asked; x excluded in both");
});

test("no model recoverable: the verdict prints DONE; the stored reason (not this run's plan) names what a re-run is up against", () => {
  const l12 = coverage([{ key: "pa/a" }, { key: "pa/b" }, { key: "pb/a" }], { "pa/a": record("ppnn") }, { pending: { "pa/b": pend("gone") }, plan: {}, heldWhy: { pb: "pay" } });
  const v = sweepVerdict({ l12 });
  assert.deepEqual([v.recoverable, v.hard, v.tested], [1, 1, 1], "pb/a is not held in this fixture: it is simply never asked");
  const done = verdictLines(sweepVerdict({ l12: coverage([{ key: "pa/a" }, { key: "pa/b" }], { "pa/a": record("ppnn") }, { pending: { "pa/b": pend("gone") }, plan: {} }) }));
  assert.match(done.at(-1), /^DONE: nothing recoverable left \(1 of 2 model\(s\) tested, 1 hard-blocked\)/);
  const queuedOver = sweepVerdict({ l12: coverage([{ key: "pa/a" }], {}, { pending: { "pa/a": pend("rate", 3) }, plan: { "pa/a": "queued" } }), pending: { "pa/a": pend("rate", 3) } });
  assert.deepEqual(queuedOver.byRecoverable, { rate: 1 }, "queued this run, but the last ask was a rate limit");
});

// ---------------------------------------------------------------- the saturation signal

test("saturation (pure): zero new records, or at least 80% of the requests rate/error/timeout, or nothing recoverable -> saturated; otherwise not", () => {
  assert.equal(saturation({ requests: 10, rate: 3, failing: 3, newResults: 7, recoverable: 5 }).saturated, false);
  assert.equal(saturation({ requests: 10, rate: 8, failing: 8, newResults: 2, recoverable: 5 }).saturated, true, "exactly 80%");
  assert.equal(saturation({ requests: 10, rate: 7, failing: 7, newResults: 3, recoverable: 5 }).saturated, false, "70%");
  assert.equal(saturation({ requests: 10, rate: 2, failing: 9, newResults: 1, recoverable: 5 }).saturated, true, "rate 20% but rate+error+timeout 90%");
  const none = saturation({ requests: 10, rate: 0, failing: 0, newResults: 0, recoverable: 5 });
  assert.deepEqual([none.saturated, none.why], [true, "no new result in this run"]);
  assert.equal(saturation({ requests: 10, newResults: 9, recoverable: 0 }).why, "nothing recoverable left");
  const empty = saturation({});
  assert.equal(empty.saturated, true, "a run that sent nothing recorded nothing");
  assert.equal(empty.failShare, 0);
  const r = saturation({ requests: 4, rate: 1, failing: 2, newResults: 2, recoverable: 1 });
  assert.deepEqual([r.rateShare, r.failShare], [0.25, 0.5]);
});

test("the dry run prints the verdict and a final SATURATION line (saturated=unknown: nothing was sent); with nothing recoverable it says DONE and saturated=yes", async () => {
  const e = cliEnv([many("pa", 4), many("pb", 2)], { store: { "pa/m0": record("ppnn") }, pending: { "pa/m1": pend("pay"), "pa/m2": pend("rate", 6) }, held: { pb: { r: "auth", at: hoursAgo(24 * 30) } } });
  const r = await run([], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /sweep verdict: RECOVERABLE 2 of 6 \(.*\) \| HARD-BLOCKED 3 of 6 \(auth 2, pay 1; lift only with --recheck-hard\/--release-holds\) \| TESTED 1 of 6/);
  assert.match(r.out, /hard-blocked, not asked .*: 1 of 5 model\(s\) in the scope \(pay 1\)/);
  assert.equal(r.lines.at(-1), "SATURATION saturated=unknown recoverable=2 hard=3 new_results=0 requests=0 reason=unknown");
  assert.equal(calls(e.f).length, 0);
  const done = cliEnv([many("pa", 2)], { store: { "pa/m0": record("ppnn") }, pending: { "pa/m1": pend("gone") } });
  const d = await run([], done.deps);
  assert.match(d.out, /DONE: nothing recoverable left \(1 of 2 model\(s\) tested, 1 hard-blocked\)/);
  assert.equal(d.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0 requests=0 reason=done");
  const live = await run(["--live"], done.deps);
  assert.match(live.out, /tool-fidelity: nothing to probe\./);
  assert.match(live.out, /DONE: nothing recoverable left/);
  assert.equal(live.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0 requests=0 reason=done");
  assert.equal(calls(done.f).length, 0, "nothing sent: the only untested model is hard-blocked");
});

test("a live run ends with the verdict, its saturation line and, last, the machine-readable line; progress -> saturated=no, then the finishing run -> DONE", async () => {
  const e = cliEnv([many("pa", 6)]);
  const r1 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  assert.match(r1.out, /sweep verdict: RECOVERABLE 3 of 6 \(cap 3\) \| HARD-BLOCKED 0 of 6 \(none; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 6/);
  assert.match(r1.out, /saturation of this run: \d+ request\(s\) sent: 0 ended rate-limited or over quota \(0% of \d+\), 0 ended rate, error, timeout, quota or empty \(a thinking-only answer\) \(0% of \d+\); 3 new record\(s\); saturated: no/);
  assert.match(r1.lines.at(-1), /^SATURATION saturated=no recoverable=3 hard=0 new_results=3 requests=\d+ reason=none$/);
  const r2 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.match(r2.out, /DONE: nothing recoverable left \(6 of 6 model\(s\) tested, 0 hard-blocked\)/);
  assert.match(r2.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=3 requests=\d+ reason=done$/);
});

test("a run where every request is rate-limited records nothing and says saturated=yes with its rate-limited share; the models stay recoverable (rate)", async () => {
  const e = cliEnv([many("pa", 4), many("pb", 4)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const sat = r.lines.at(-1);
  assert.match(sat, /^SATURATION saturated=yes recoverable=8 hard=0 new_results=0 requests=\d+ reason=zero-new$/);
  assert.match(r.out, /sweep verdict: RECOVERABLE 8 of 8 \((rate|rate-paused) \d+, (rate|rate-paused) \d+\)/);
  assert.match(r.out, /saturation of this run: (\d+) request\(s\) sent: \1 ended rate-limited or over quota \(100% of \1\), \1 ended rate, error, timeout, quota or empty \(a thinking-only answer\) \(100% of \1\); 0 new record\(s\); saturated: yes \(no new result in this run\)/);
  assert.deepEqual(loadFidelity(e.out).held, {}, "a rate limit is the moment's: never a hold");
});

test("80% failing with some progress is saturated: three providers keep rate-limiting, one records its only model", async () => {
  const e = cliEnv([many("pa", 5), many("pc", 5), many("pd", 5), many("pb", 1)], { answer: (c) => (c.body.model.startsWith("pb/") ? goodModel(c) : http(429, "slow down", { "retry-after": "0" })) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=15 hard=0 new_results=1 requests=\d+ reason=failing$/);
  assert.match(r.out, /saturated: yes \(\d+% of the requests ended rate, error, timeout or quota\)/);
});

// ---------------------------------------------------------------- live: sticky across runs, lifted by hand

test("live: a pay canary writes a hold; a run 7 days later still sends that provider nothing; --recheck-hard pay,pb asks it again and an answering provider is released, its stale canary entries gone", async () => {
  let open = false;
  const e = cliEnv([many("pa", 3), many("pb", 3)], { answer: (c) => (!open && c.body.model.startsWith("pb/") ? http(402, "no credit") : goodModel(c)) });
  const r1 = await run(["--live", "--per-provider", "1"], e.deps);
  const s1 = loadFidelity(e.out);
  assert.deepEqual(s1.held, { pb: { r: "pay", at: NOW.toISOString() } });
  assert.equal(s1.pending["pb/m2"].r, "canary-pay");
  assert.match(r1.out, /HARD-BLOCKED 3 of 6 \(pay 3;/);
  assert.match(r1.out, /pb: pay \(.*\) -- 3 model\(s\) skipped -- held until lifted \(sticky; --recheck-hard or --retry-accounts lifts it\)/);
  assert.match(r1.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=3 new_results=3 requests=\d+ reason=done$/, "pa answered (3 records) but nothing recoverable is left: the loop stops, hard-blocked 3 left");
  open = true;
  e.f.calls.length = 0;
  e.deps.now = () => new Date(NOW.getTime() + 7 * DAY);
  const r2 = await run(["--live", "--per-provider", "1"], e.deps);
  assert.equal(byProv(e.f).pb, undefined, "7 days later a normal run still sends pb not one request");
  assert.match(r2.out, /nothing to probe/);
  assert.deepEqual(Object.keys(loadFidelity(e.out).held), ["pb"], "and the hold is still in the file");
  const gone = await run(["--live", "--per-provider", "1", "--recheck-hard", "gone"], e.deps);
  assert.equal(byProv(e.f).pb, undefined, "gone is not pay: the pay hold stays");
  void gone;
  const r3 = await run(["--live", "--per-provider", "1", "--recheck-hard", "pay,pb"], e.deps);
  assert.ok(byProv(e.f).pb > 0, "the manual lift asked pb again");
  const s3 = loadFidelity(e.out);
  assert.deepEqual(Object.keys(s3.models).filter((k) => k.startsWith("pb/")).sort(), ["pb/m0", "pb/m1", "pb/m2"]);
  assert.deepEqual(s3.held, {}, "a provider that re-answers during a manual recheck clears its hold");
  assert.deepEqual(Object.keys(s3.pending), [], "and nothing stays pending");
  assert.match(r3.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=3 requests=\d+ reason=done$/);
  assert.match(r3.out, /DONE: nothing recoverable left \(6 of 6 model\(s\) tested, 0 hard-blocked\)/);
});

test("live: a recheck that is still out of credit writes the hold again (fresh time); the models stay hard-blocked and cost one canary", async () => {
  const e = cliEnv([many("pb", 4)], { answer: () => http(402, "no credit") });
  await run(["--live", "--per-provider", "1"], e.deps);
  e.f.calls.length = 0;
  const later = new Date(NOW.getTime() + 3 * DAY);
  e.deps.now = () => later;
  const r = await run(["--live", "--per-provider", "1", "--recheck-hard", "pay"], e.deps);
  assert.equal(calls(e.f).length, 2, "the two-model canary again, no more");
  assert.deepEqual(loadFidelity(e.out).held, { pb: { r: "pay", at: later.toISOString() } });
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=4 new_results=0 requests=\d+ reason=done$/);
  e.f.calls.length = 0;
  const again = await run(["--live", "--per-provider", "1"], e.deps);
  assert.equal(calls(e.f).length, 0, "a normal run afterwards asks nothing");
  assert.match(again.out, /DONE: nothing recoverable left/);
});

test("a model-level pay answer (the provider has results) is sticky for that model: later normal runs skip it while the rest of the provider is still asked; --retry-accounts asks it again", async () => {
  let open = false;
  const e = cliEnv([many("pa", 6)], { store: { "pa/known": record("ppnn") }, answer: (c) => (!open && c.body.model === "pa/m0" ? http(402, "this model needs credit") : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], e.deps);
  assert.equal(loadFidelity(e.out).pending["pa/m0"].r, "pay");
  e.f.calls.length = 0;
  await run(["--live", "--per-provider", "1", "--force", "--only", "pa/m1"], e.deps);       // anything that still asks pa
  assert.equal(calls(e.f).some((c) => c.body.model === "pa/m0"), false);
  open = true;
  e.f.calls.length = 0;
  const dry = await run([], e.deps);
  assert.match(dry.out, /this run: 0 model\(s\) queued of 6/);
  assert.match(dry.out, /sweep verdict: RECOVERABLE 0 of 6 \(none\) \| HARD-BLOCKED 1 of 6 \(pay 1;/);
  const r = await run(["--live", "--retry-accounts"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(loadFidelity(e.out).models["pa/m0"], "asked again by the manual lift");
  assert.ok(!loadFidelity(e.out).pending["pa/m0"]);
});

// ---------------------------------------------------------------- --release-holds lifts the model-level hard reasons of a NAMED provider

test("releaseHolds (pure): a NAMED provider's models pending pay/auth/gone (also canary-*) are lifted with its hold; a hold released as wrong lifts only the canary entries; other providers are untouched", () => {
  const store = { "pa/k": record("ppnn") };
  const held = { pa: { r: "gone", at: hoursAgo(1) }, pb: { r: "pay", at: hoursAgo(1) } };
  const pending = { "pa/m0": pend("gone"), "pa/m1": pend("canary-gone"), "pa/m2": pend("rate"), "pb/m0": pend("pay"), "pb/m1": pend("canary-pay"), "pb/m2": pend("auth") };
  const named = releaseHolds(store, pending, held, { providers: ["pb"] });
  assert.deepEqual(Object.keys(named.pending).sort(), ["pa/m0", "pa/m1", "pa/m2"], "pb's hard entries are gone");
  assert.deepEqual(Object.keys(named.held), ["pa"]);
  const wrong = releaseHolds(store, pending, held, { wrong: true });
  assert.deepEqual(Object.keys(wrong.pending).sort(), ["pa/m0", "pa/m2", "pb/m0", "pb/m1", "pb/m2"], "pa has confirmed results, so its hold is wrong: only its canary entry goes");
  assert.deepEqual(confirmedProviders(store), { pa: 1 });
});

test("--release-holds --live then a normal run asks the released provider's models again", async () => {
  const e = cliEnv([many("pb", 3)], { held: { pb: { r: "pay", at: hoursAgo(1) } }, pending: { "pb/m0": pend("pay"), "pb/m1": pend("pay"), "pb/m2": pend("canary-pay") } });
  const before = await run([], e.deps);
  assert.match(before.out, /this run: 0 model\(s\) queued of 3/);
  const rel = await run(["--release-holds", "pb", "--live"], e.deps);
  assert.equal(rel.code, 0, rel.err);
  assert.deepEqual(loadFidelity(e.out).pending, {});
  const after_ = await run([], e.deps);
  assert.match(after_.out, /this run: 3 model\(s\) queued of 3/);
});

test("saturationLines: a dry run is unknown unless nothing is recoverable; the machine line is always last and has the four fields", () => {
  const v = { recoverable: 4, hard: 2 };
  assert.equal(saturationLines(v, null).at(-1), "SATURATION saturated=unknown recoverable=4 hard=2 new_results=0 requests=0 reason=unknown");
  assert.equal(saturationLines({ recoverable: 0, hard: 2 }, null).at(-1), "SATURATION saturated=yes recoverable=0 hard=2 new_results=0 requests=0 reason=done");
  const sat = saturation({ requests: 10, rate: 1, failing: 1, newResults: 6, recoverable: 4 });
  assert.equal(saturationLines(v, sat).at(-1), "SATURATION saturated=no recoverable=4 hard=2 new_results=6 requests=10 reason=none");
  assert.equal(saturationLines(v, sat).length, 2);
});

// ================================================================ lifecycle review addendum (2026-10-06)

// ---------------------------------------------------------------- 1. naming ONE model is a manual act

test("--only provider/model (an exact id) lifts that model's own hard block and says so; --only <provider> alone does not", async () => {
  const e = cliEnv([many("pa", 3), many("pb", 3)]);
  const pending = { "pa/m0": { r: "pay", n: 4, at: hoursAgo(2), since: "2026-09-20T08:30:00.000Z" }, "pa/m1": pend("gone"), "pb/m0": pend("auth") };
  const exact = planOf(e, ["--only", "pa/m0"], { pending });
  assert.deepEqual(keys(exact), ["pa/m0"], "the named model is asked");
  assert.deepEqual(exact.namedLifts.map((x) => [x.key, x.state, x.since, x.viaHold]), [["pa/m0", "pay", "2026-09-20T08:30:00.000Z", false]]);
  assert.deepEqual(exact.hardBlocked.models, 0, "m1 and pb/m0 are outside --only, so nothing else is blocked in THIS queue");
  const dry = await run(["--only", "pa/m0"], cliEnv([many("pa", 3), many("pb", 3)], { pending }).deps);
  assert.match(dry.out, /pa\/m0: hard-blocked pay since 2026-09-20 08:30; asking it because you named it/);
  assert.match(dry.out, /this run: 1 model\(s\) queued of 6 \(--only pa\/m0\)/);
  // a provider name alone lifts nothing
  const prov = planOf(e, ["--only", "pa"], { pending });
  assert.deepEqual(keys(prov), ["pa/m2"], "m0 (pay) and m1 (gone) stay blocked");
  assert.deepEqual([prov.namedLifts.length, prov.hardBlocked], [0, { models: 2, by: { pay: 1, gone: 1 } }]);
  assert.doesNotMatch((await run(["--only", "pa"], cliEnv([many("pa", 3), many("pb", 3)], { pending }).deps)).out, /because you named it/);
  // naming two models lifts both; a model that is not blocked prints nothing
  const two = planOf(e, ["--only", "pa/m0,pa/m1,pa/m2"], { pending });
  assert.deepEqual(keys(two), ["pa/m0", "pa/m1", "pa/m2"]);
  assert.deepEqual(two.namedLifts.map((x) => x.key).sort(), ["pa/m0", "pa/m1"]);
  // only the named one: its neighbours with a hard block stay out
  assert.deepEqual(keys(planOf(e, ["--only", "pa/m1,pb"], { pending })), ["pa/m1", "pb/m1", "pb/m2"]);
});

test("naming a model of a HELD provider asks that one model (the hold stays for the rest, and the ledger does not call it held); naming only the provider does not", () => {
  const e = cliEnv([many("pb", 3)]);
  const held = { pb: { r: "pay", at: "2026-10-01T00:00:00.000Z" } };
  const one = planOf(e, ["--only", "pb/m1"], { held });
  assert.deepEqual(keys(one), ["pb/m1"]);
  assert.deepEqual(one.namedLifts.map((x) => [x.key, x.state, x.since, x.viaHold]), [["pb/m1", "pay", "2026-10-01T00:00:00.000Z", true]]);
  assert.equal(one.ledger.l12.counts.held, 2, "pb/m0 and pb/m2 stay held; pb/m1 is queued");
  assert.deepEqual(keys(planOf(e, ["--only", "pb"], { held })), [], "the provider name alone does not lift a hold");
  assert.match(hardLines(one).join("\n"), /pb\/m1: hard-blocked pay \(its provider is held\) since 2026-10-01 00:00; asking it because you named it/);
});

test("live: a named model with a stored pay block is asked, nobody else of its provider is, and an answer clears its pending entry", async () => {
  let open = false;
  const e = cliEnv([many("pa", 3)], { store: { "pa/known": record("ppnn") }, answer: (c) => (!open && c.body.model === "pa/m0" ? http(402, "this model needs credit") : goodModel(c)), pending: { "pa/m0": pend("pay", 2) } });
  open = true;
  const r = await run(["--live", "--only", "pa/m0", "--per-provider", "1"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual([...new Set(calls(e.f).map((c) => c.body.model))], ["pa/m0"]);
  assert.match(r.out, /pa\/m0: hard-blocked pay since .*; asking it because you named it/);
  assert.ok(loadFidelity(e.out).models["pa/m0"]);
  assert.ok(!loadFidelity(e.out).pending["pa/m0"]);
});

// ---------------------------------------------------------------- 2. since dates and run counts

test("ledger rows carry `since` (the first time the stored reason was recorded) and the run count; a held row carries the hold's time; the verdict prints the oldest since per reason", () => {
  const pending = { "pa/m0": { r: "rate", n: 4, at: hoursAgo(1), since: "2026-10-02T00:00:00.000Z" }, "pa/m1": { r: "rate", n: 1, at: hoursAgo(1), since: "2026-10-05T00:00:00.000Z" }, "pa/m2": { r: "error", n: 2, at: "2026-10-05T10:00:00.000Z" } };
  const cov = coverage([{ key: "pa/m0" }, { key: "pa/m1" }, { key: "pa/m2" }, { key: "pa/m3" }, { key: "pb/m0" }], {}, { pending, plan: { "pb/m0": HELD_PLAN }, heldWhy: { pb: "pay" }, heldSince: { pb: "2026-09-28T00:00:00.000Z" } });
  const row = Object.fromEntries(cov.pending.map((x) => [x.key, x]));
  assert.deepEqual([row["pa/m0"].since, row["pa/m0"].runs], ["2026-10-02T00:00:00.000Z", 4]);
  assert.equal(row["pa/m2"].since, "2026-10-05T10:00:00.000Z", "an entry from before `since` existed reads as since its last time");
  assert.equal(row["pa/m3"].since, null, "never asked: no date");
  assert.deepEqual([cov.held[0].reason, cov.held[0].since], ["pay", "2026-09-28T00:00:00.000Z"]);
  const v = sweepVerdict({ l12: cov, pending });
  assert.deepEqual(v.oldestSince, { rate: "2026-10-02T00:00:00.000Z", error: "2026-10-05T10:00:00.000Z", pay: "2026-09-28T00:00:00.000Z" });
  const text = verdictLines(v).join("\n");
  assert.match(text, /oldest since, per reason \(the first time that reason was recorded, among the 5 model\(s\) not tested\): pay 2026-09-28, rate 2026-10-02, error 2026-10-05/);
  assert.ok(!verdictLines(sweepVerdict({ l12: coverage([{ key: "pa/a" }], { "pa/a": record("ppnn") }, {}) })).some((l) => l.includes("oldest since")), "nothing to say when everything is tested");
});

test("live: `since` stays at the first run of a reason across runs, restarts when the reason changes; the dry run shows the oldest since", async () => {
  const e = cliEnv([many("pa", 2)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  await run(["--live", "--per-provider", "1"], e.deps);
  const day2 = new Date(NOW.getTime() + DAY);
  e.deps.now = () => day2;
  await run(["--live", "--per-provider", "1"], e.deps);
  const p = loadFidelity(e.out).pending["pa/m0"];
  assert.deepEqual([p.r, p.n, p.since, p.at], ["rate", 2, NOW.toISOString(), day2.toISOString()]);
  const dry = await run([], e.deps);
  assert.match(dry.out, /oldest since, per reason .*: rate 2026-10-06/);
  const e2 = cliEnv([many("pa", 1)], { answer: () => http(500, "boom") });
  await run(["--live", "--per-provider", "1"], e2.deps);
  e2.deps.now = () => day2;
  e2.deps.fetch = fakeFetch(() => http(429, "slow down", { "retry-after": "0" }));
  await run(["--live", "--per-provider", "1"], e2.deps);
  const q = loadFidelity(e2.out).pending["pa/m0"];
  assert.deepEqual([q.r, q.since], ["rate", day2.toISOString()], "error became rate: since starts again");
});

test("saveFidelity keeps `since` in the pending map; cleanPending drops only a malformed since, not the entry", () => {
  const d = freshDir(), file = path.join(d, FILE_NAME);
  saveFidelity(file, {}, { now: NOW, pending: { "pa/m0": { r: "rate", n: 2, at: hoursAgo(1), since: hoursAgo(30) }, "pa/m1": { r: "rate", n: 1, at: hoursAgo(1), since: "nope" } } });
  const back = loadFidelity(file).pending;
  assert.equal(back["pa/m0"].since, hoursAgo(30));
  assert.deepEqual(back["pa/m1"], { r: "rate", n: 1, at: hoursAgo(1) });
});

// ---------------------------------------------------------------- 3. soft but stuck, and the meta block

test("soft-but-stuck: error, timeout, empty or slow for 3 or more runs in a row stay recoverable but are counted apart; rate, cap and a lower count are not stuck", () => {
  const rows = [many("pa", 9)];
  const e = cliEnv(rows);
  const pending = { "pa/m0": pend("error", 3), "pa/m1": pend("timeout", 7), "pa/m2": pend("empty", 3), "pa/m3": pend("slow", 5), "pa/m4": pend("error", 2), "pa/m5": pend("rate", 20), "pa/m6": pend("cap", 9), "pa/m7": pend("upstream-unavailable", 9) };
  const p = planOf(e, ["--tf-max-tokens-per-provider", "1000000"], { pending });
  const v = p.verdict;
  assert.equal(v.recoverable, 9, "all nine are still recoverable (m8 was never asked)");
  assert.equal(v.stuck, 4);
  assert.deepEqual(v.byStuck, { error: 1, timeout: 1, empty: 1, slow: 1 });
  assert.equal(p.queued.length, 9, "stuck-soft models are still queued: a manual re-run asks them");
  assert.match(verdictLines(v)[0], /RECOVERABLE 9 of 9 \(.*; of which STUCK 4 \(.*; the same soft reason 3 or more runs in a row, still recoverable\)\) \| HARD-BLOCKED 0 of 9/);
  assert.equal(sweepVerdict({ l12: p.ledger.l12, pending, stuckRuns: 5 }).stuck, 2, "the threshold is the --pending-runs option's");
  assert.equal(planOf(e, ["--pending-runs", "5", "--tf-max-tokens-per-provider", "1000000"], { pending }).verdict.stuck, 2);
  assert.ok(!verdictLines(planOf(e, [], { pending: { "pa/m0": pend("error", 1) } }).verdict)[0].includes("STUCK"));
});

test("saturation (pure): the recoverable set that did not shrink against the previous run is saturated; one that shrank, or an unknown previous count, is not", () => {
  const base = { requests: 10, rate: 0, failing: 0, newResults: 4 };
  const same = saturation({ ...base, recoverable: 5, prevRecoverable: 5 });
  assert.deepEqual([same.saturated, same.why], [true, "the recoverable set did not shrink: 5 now, 5 at the end of the previous run (fallback: this scope has no run history yet)"]);
  assert.equal(saturation({ ...base, recoverable: 7, prevRecoverable: 5 }).saturated, true, "grew");
  assert.equal(saturation({ ...base, recoverable: 4, prevRecoverable: 5 }).saturated, false, "shrank: progress");
  assert.equal(saturation({ ...base, recoverable: 5, prevRecoverable: null }).saturated, false, "no previous run on record");
  assert.equal(saturation({ ...base, recoverable: 5 }).saturated, false);
  assert.equal(saturation({ ...base, recoverable: 0, prevRecoverable: 0 }).why, "nothing recoverable left", "that reason comes first");
  assert.equal(saturation({ ...base, newResults: 0, recoverable: 5, prevRecoverable: 9 }).why, "no new result in this run");
});

test("the meta block (additive): cleanMeta keeps only a sane recoverable count with a date; it survives save and load; a writer that does not mention it keeps the one in the file; the size cap counts it", () => {
  const SC = "a1b2c3d4e5f60718";
  assert.deepEqual(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), junk: 1 }), { recoverable: 3, scope: SC, at: NOW.toISOString() });
  for (const bad of [null, [], "x", { recoverable: -1, scope: SC, at: NOW.toISOString() }, { recoverable: 1.5, scope: SC, at: NOW.toISOString() }, { recoverable: 2, scope: SC }, { recoverable: 2, scope: SC, at: "nope" }, { recoverable: 2, at: NOW.toISOString() }, { recoverable: 2, scope: "XYZ!", at: NOW.toISOString() }]) assert.equal(cleanMeta(bad), null);
  const d = freshDir(), file = path.join(d, FILE_NAME);
  saveFidelity(file, { "fa/a": record("ppnn") }, { now: NOW, meta: { recoverable: 7, scope: SC, at: NOW.toISOString() } });
  assert.deepEqual(loadFidelity(file).meta, { recoverable: 7, scope: SC, at: NOW.toISOString() });
  assert.match(fs.readFileSync(file, "utf8"), /"meta":\{"recoverable":7/);
  saveFidelity(file, { "fa/a": record("ppnn"), "fa/b": record("ppnn") }, { now: NOW });
  assert.equal(loadFidelity(file).meta.recoverable, 7, "a save that does not mention the meta keeps it");
  saveFidelity(file, { "fa/a": record("ppnn") }, { now: NOW, meta: null });
  assert.equal(loadFidelity(file).meta, null, "an explicit null clears it");
  const models = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`fa/m${i}`, record("ppnn", { at: new Date(NOW.getTime() + i).toISOString() })]));
  const fit = Buffer.byteLength(renderFile(Object.entries(models), NOW, null, null));
  assert.ok(capRecords(models, { now: NOW, maxBytes: fit, meta: { recoverable: 7, scope: SC, at: NOW.toISOString() } }).dropped.length >= 1, "the meta text is part of the size");
});

test("live: the run leaves its recoverable count in the meta block; the next run that does not shrink it is saturated even though it recorded something; one that shrinks it is not; a manual lift ignores the rule", async () => {
  const mk = (metaCount, argv = []) => {
    const e = cliEnv([many("pa", 2)], { answer: (c) => (c.body.model === "pa/m0" ? http(500, "boom") : goodModel(c)), pending: { "pa/m0": pend("error", 5) } });
    saveFidelity(e.out, {}, { now: NOW, pending: { "pa/m0": pend("error", 5) }, meta: metaCount === null ? null : { recoverable: metaCount, scope: scopeOf(parseArgs(pinL12(["--live", "--per-provider", "1"]))), at: hoursAgo(5) } });
    return { e, argv };
  };
  // previous run left 1 recoverable; this run records pa/m1 but pa/m0 (stuck error) is still there: 1 now, no shrink
  const a = mk(1);
  const ra = await run(["--live", "--per-provider", "1"], a.e.deps);
  assert.match(ra.lines.at(-1), /^SATURATION saturated=yes recoverable=1 hard=0 new_results=1 requests=\d+ reason=no-shrink$/, ra.out);
  assert.match(ra.out, /saturated: yes \(the recoverable set did not shrink: 1 now, 1 at the end of the previous run \(fallback: this scope has no run history yet\)\)/);
  { const mm = loadFidelity(a.e.out).meta; assert.deepEqual({ recoverable: mm.recoverable, scope: mm.scope, at: mm.at }, { recoverable: 1, scope: scopeOf(parseArgs(pinL12(["--live", "--per-provider", "1"]))), at: NOW.toISOString() }); assert.equal(mm.history.length, 1, "and the run's own record"); }
  // previous run left 2: now 1, it shrank
  const b = mk(2);
  const rb = await run(["--live", "--per-provider", "1"], b.e.deps);
  assert.match(rb.lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+ reason=none$/);
  assert.deepEqual(loadFidelity(b.e.out).meta.recoverable, 1);
  // no previous count on record
  const c = mk(null);
  assert.match((await run(["--live", "--per-provider", "1"], c.e.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+ reason=none$/);
  // a manual lift is allowed to grow the set
  const d = mk(1);
  assert.match((await run(["--live", "--per-provider", "1", "--retry-accounts"], d.e.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+ reason=none$/);
});

// ---------------------------------------------------------------- 4. tier completeness

test("the verdict says how many TESTED models are complete for every level they are eligible for and how many have optional levels not run, with the missing levels named; the tested partition is unchanged", () => {
  const full = record("pppp", { big: "p", sp: "p", er: "p" });
  const store = {
    "pa/full": full,
    "pa/core": record("ppnn"),                                   // L3 never asked: not eligible-missing for L4/big, but spawn and error-result have not run
    "pa/noerr": record("pppp", { big: "p", sp: "p" }),
    "pa/nobig": record("pppp", { sp: "p", er: "p" }),
    "pa/nol4": record("pppn", { big: "p", sp: "p", er: "p" }),
    "pa/failed": record("ffnn"),                                 // a failure: nothing more is asked
  };
  const universe = Object.keys(store).map((key) => ({ key }));
  const l12 = coverage(universe, store, {});
  const v = sweepVerdict({ l12, store });
  assert.equal(v.tested, l12.counts.tested, "the partition itself is untouched");
  assert.deepEqual([v.tested, v.complete, v.incomplete], [6, 2, 4]);
  assert.deepEqual(v.byMissing, { spawn: 1, "error-result": 2, big: 1, L4: 1 });
  assert.equal(v.complete + v.incomplete, v.tested);
  const line = verdictLines(v)[0];
  assert.match(line, /TESTED 6 of 6 \(complete for every level it is eligible for 2 of 6; tested but optional levels not run: 4 of 6 model\(s\), \d+ level gap\(s\) \(a model can have more than one\): /);
  assert.match(line, /spawn 1/);
  assert.match(line, /error-result 2/);
});

test("completeness goes with the tier: a tested model whose tier does not allow deep levels is complete for what it is eligible for; first strikes are not tested at all", () => {
  const store = { "pa/x": record("ppnn"), "pb/x": record("ppnn"), "pa/s": record("fnnn", { strikes: 1, sl: 1 }) };
  const l12 = coverage([{ key: "pa/x" }, { key: "pb/x" }, { key: "pa/s" }], store, { deepOk: (k) => k.startsWith("pa/") });
  const v = sweepVerdict({ l12, store });
  assert.deepEqual([v.tested, v.complete, v.incomplete, v.recoverable], [2, 1, 1, 1], "pb is not eligible for the deep levels; pa/s is a first strike (recoverable)");
});

test("dry run: the completeness figures reach the printed verdict with their denominator", async () => {
  const e = cliEnv([many("pa", 3)], { store: { "pa/m0": record("ppnn"), "pa/m1": record("pppp", { big: "p", sp: "p", er: "p" }) } });
  const r = await run([], e.deps);
  assert.match(r.out, /TESTED 2 of 3 \(complete for every level it is eligible for 1 of 2; tested but optional levels not run: 1 of 2 model\(s\), 2 level gap\(s\) \(a model can have more than one\): error-result 1, spawn 1\)/);
});

// ================================================================ fix round (review cr-sweep-lifecycle on 184686c + d4d3a82)

// ---------------------------------------------------------------- finding 1: blocked models are filtered BEFORE --limit and --sample

test("finding 1: --limit counts only models that can be asked: 10 models, the first 4 pending pay, --limit 4 keeps 4 askable ones (and a held provider takes no place either)", async () => {
  const e = cliEnv([many("pa", 10)]);
  const pending = Object.fromEntries([0, 1, 2, 3].map((i) => [`pa/m${i}`, pend("pay", 3)]));
  const p = planOf(e, ["--limit", "4"], { pending });
  assert.deepEqual(keys(p), ["pa/m4", "pa/m5", "pa/m6", "pa/m7"], "four askable models, not the four blocked ones");
  assert.deepEqual(p.hardBlocked, { models: 4, by: { pay: 4 } });
  const dry = await run(["--limit", "4"], cliEnv([many("pa", 10)], { pending }).deps);
  assert.match(dry.out, /this run: 4 model\(s\) queued of 10 \(--limit 4\)/);
  // a held provider listed first must not take places either
  const e2 = cliEnv([many("pb", 6), many("pa", 6)]);
  const p2 = planOf(e2, ["--limit", "4"], { held: { pb: { r: "pay", at: hoursAgo(2) } } });
  assert.deepEqual(keys(p2).map((k) => k.slice(0, 2)), ["pa", "pa", "pa", "pa"]);
  // blocked models stay in the ledger as what they are
  assert.equal(p.ledger.l12.counts.byPending.pay, 4);
  assert.equal(p.verdict.byHard.pay, 4);
});

test("finding 1: --sample draws only from models that can be asked", async () => {
  const rows = [many("pa", 6)];
  const e = cliEnv(rows);
  e.deps.policy = { schema: 1, models: [{ s: "pa/m0", c: 256000 }], tiers: { pa: "free" } };
  saveFidelity(e.out, {}, { now: NOW, pending: Object.fromEntries([0, 1, 2].map((i) => [`pa/m${i}`, pend("pay", 3)])) });
  const dry = await run(["--sample", "3"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /this run: 3 model\(s\) queued of 6/, "the sample is three askable models");
});

// ---------------------------------------------------------------- finding 2: meta carries a scope

test("finding 2: scopeOf is a stable hash of the flags that decide which models the count is about; it ignores the flags that do not", () => {
  const sc = (...a) => scopeOf(parseArgs(a));
  assert.match(sc(), /^[0-9a-f]{16}$/);
  assert.equal(sc(), sc("--limit", "5", "--per-provider", "1", "--retry-accounts", "--live", "--tf-max-tokens-per-provider", "17100"), "limit, concurrency, live, lifts and caps do not change the scope");
  assert.equal(sc("--only", "pa,pb"), sc("--only", "pb,pa"), "the order of a list is not the scope");
  for (const other of [["--only", "pa"], ["--levels", "123"], ["--candidates", "policy"], ["--sample", "5"], ["--sample", "5", "--seed", "x"], ["--candidates", "policy", "--include-tier", "paid"], ["--candidates", "policy", "--allow", "pa/m1"], ["--policy-file", "p.json"]]) {
    assert.notEqual(sc(...other), sc(), other.join(" "));
  }
  assert.notEqual(sc("--sample", "5"), sc("--sample", "5", "--seed", "x"));
});

test("finding 2: the previous count is compared only for an equal scope; another scope, a named-model lift, --recheck-hard and --retry-accounts compare nothing; an old meta without scope reads as no previous count", async () => {
  const live = ["--live", "--per-provider", "1"];
  const mk = (argv, metaCount, scopeArgv = argv, pending = { "pa/m0": pend("error", 5) }) => {
    const e = cliEnv([many("pa", 2)], { answer: (c) => (c.body.model === "pa/m0" ? http(500, "boom") : goodModel(c)) });
    saveFidelity(e.out, {}, { now: NOW, pending, meta: { recoverable: metaCount, scope: scopeOf(parseArgs(pinL12(scopeArgv))), at: hoursAgo(5) } });
    return e;
  };
  // equal scope, no shrink: saturated
  const same = await run(live, mk(live, 1).deps);
  assert.match(same.lines.at(-1), /^SATURATION saturated=yes recoverable=1 hard=0 new_results=1 requests=\d+ reason=no-shrink$/);
  // a meta written under ANOTHER scope compares with nothing
  const other = await run(live, mk(live, 1, ["--live", "--only", "pb"]).deps);
  assert.match(other.lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+ reason=none$/, other.out);
  // the run's own scope is what is stored
  const e = mk(live, 1);
  await run(live, e.deps);
  assert.equal(loadFidelity(e.out).meta.scope, scopeOf(parseArgs(pinL12(live))));
  // a manual lift compares nothing even under an equal scope
  const lifted = await run([...live, "--recheck-hard", "pay"], mk(live, 1).deps);
  assert.match(lifted.lines.at(-1), /^SATURATION saturated=no /);
  const named = ["--live", "--per-provider", "1", "--only", "pa/m0,pa/m1"];
  const nm = await run(named, mk(named, 1, named, { "pa/m0": pend("pay", 2) }).deps);
  assert.match(nm.out, /pa\/m0: hard-blocked pay since .*; asking it because you named it/);
  assert.doesNotMatch(nm.out, /did not shrink/, "a named-model lift compares nothing");
  // an old meta (no scope) reads as no previous count
  const old = cliEnv([many("pa", 2)], { answer: (c) => (c.body.model === "pa/m0" ? http(500, "boom") : goodModel(c)), pending: { "pa/m0": pend("error", 5) } });
  const raw = JSON.parse(fs.readFileSync(old.out, "utf8"));
  raw.meta = { recoverable: 1, at: hoursAgo(5) };
  fs.writeFileSync(old.out, JSON.stringify(raw));
  assert.equal(loadFidelity(old.out).meta, null);
  assert.match((await run(live, old.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+ reason=none$/);
});

test("finding 2: --release-holds and --reset-gone-holds (live) clear the meta: the next run compares with nothing", async () => {
  const e = cliEnv([many("pa", 2)], { held: { pa: { r: "pay", at: hoursAgo(1) } }, pending: { "pa/m0": pend("pay") } });
  saveFidelity(e.out, {}, { now: NOW, held: { pa: { r: "pay", at: hoursAgo(1) } }, pending: { "pa/m0": pend("pay") }, meta: { recoverable: 4, scope: scopeOf(parseArgs([])), at: hoursAgo(2) } });
  assert.equal(loadFidelity(e.out).meta.recoverable, 4);
  const r = await run(["--release-holds", "pa", "--live"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(loadFidelity(e.out).meta, null);
});

// ---------------------------------------------------------------- finding 5: partial runs claim nothing

test("finding 5 / C: a live run that sends nothing because nothing is queueable under its scope says saturated=yes with a scope-exhausted note (a loop on that scope stops)", async () => {
  const e = cliEnv([many("pa", 2), many("pb", 2)], { store: { "pa/m0": record("ppnn"), "pa/m1": record("ppnn") } });
  const r = await run(["--live", "--only", "pa"], e.deps);
  assert.match(r.out, /nothing to probe/);
  assert.equal(r.lines.at(-1), "SATURATION saturated=yes recoverable=2 hard=0 new_results=0 requests=0 reason=scope-exhausted");
  assert.match(r.out, /this run sent nothing; scope-exhausted: 2 recoverable model\(s\) are outside this run's scope\/levels/);
  assert.doesNotMatch(r.out, /DONE:/);
  const done = cliEnv([many("pa", 1)], { store: { "pa/m0": record("ppnn") } });
  assert.equal((await run(["--live"], done.deps)).lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0 reason=done");
});

test("finding 5: a run stopped early prints saturated=unknown, no DONE, and does not write the meta; exit codes are the sweep's", async () => {
  const e = cliEnv([many("pa", 6)]);
  e.deps.sweep = { ...SWEEP_FAST, maxMs: 1 };
  const slow = e.deps.fetch;
  e.deps.fetch = async (url, init) => { await new Promise((r) => setTimeout(r, 15)); return slow(url, init); };
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.out, /stopped \(/);
  assert.match(r.lines.at(-1), /^SATURATION saturated=unknown recoverable=\d+ hard=0 new_results=\d+ requests=\d+ reason=unknown$/);
  assert.match(r.out, /saturation: not judged, the run was interrupted or stopped early/);
  assert.doesNotMatch(r.out, /DONE: nothing recoverable/);
  assert.equal(loadFidelity(e.out).meta, null, "a partial run writes no meta");
});

// ---------------------------------------------------------------- finding 6: rn

test("finding 6: `rn` counts the runs in a row with THIS reason and restarts when the reason changes; `n` is unchanged; a legacy entry reads as rn = n; STUCK uses rn", () => {
  const store = {};
  const q = (k) => [{ key: k }];
  let pend1 = {};
  const step = (reason, day) => { pend1 = updatePending(pend1, { queue: q("p/a"), recorded: new Set(), store, now: new Date(NOW.getTime() + day * DAY), reasonOf: () => reason }); return pend1["p/a"]; };
  assert.deepEqual([step("error", 0).n, pend1["p/a"].rn], [1, 1]);
  assert.deepEqual([step("error", 1).n, pend1["p/a"].rn], [2, 2]);
  const sw = step("rate", 2);
  assert.deepEqual([sw.n, sw.rn], [3, 1], "n keeps counting (the funnel reads it); rn restarts");
  assert.deepEqual([step("error", 3).n, pend1["p/a"].rn], [4, 1]);
  assert.equal(updatePending({ "p/a": { r: "error", n: 2, at: hoursAgo(5) } }, { queue: q("p/a"), recorded: new Set(), store, now: NOW, reasonOf: () => "error" })["p/a"].rn, 3, "legacy: rn = n, then one more");
  // stuck reads rn
  const pending = { "pa/a": { r: "error", n: 9, rn: 1, at: hoursAgo(1) }, "pa/b": { r: "error", n: 2, rn: 3, at: hoursAgo(1) }, "pa/c": { r: "timeout", n: 3, at: hoursAgo(1) } };
  const v = sweepVerdict({ l12: coverage([{ key: "pa/a" }, { key: "pa/b" }, { key: "pa/c" }], {}, { pending }), pending });
  assert.equal(v.stuck, 2, "a: nine runs but only one with this reason (not stuck); b: rn 3 (stuck); c: legacy n 3 (stuck)");
  assert.deepEqual(v.byStuck, { error: 1, timeout: 1 });
});

test("finding 6: rn and why survive save and load; a malformed rn or an empty why is dropped, not the entry", () => {
  const d = freshDir(), file = path.join(d, FILE_NAME);
  saveFidelity(file, {}, { now: NOW, pending: { "pa/a": { r: "quota", n: 4, rn: 3, at: hoursAgo(1), why: "Daily limit reached" }, "pa/b": { r: "rate", n: 1, rn: 0, at: hoursAgo(1), why: "   " }, "pa/c": { r: "rate", n: 1, at: hoursAgo(1), why: "x".repeat(400) } } });
  const back = loadFidelity(file).pending;
  assert.deepEqual([back["pa/a"].rn, back["pa/a"].why], [3, "Daily limit reached"]);
  assert.deepEqual(back["pa/b"], { r: "rate", n: 1, at: hoursAgo(1) });
  assert.ok(back["pa/c"].why.length <= 120, "the sentence is clipped");
});

// ---------------------------------------------------------------- finding 14 + 7: NEEDS-OWNER reasons are not queued

test("finding 14: a model pending route-shape is not queued by a normal run (zero requests); --recheck-hard owner, a named model and nothing else ask it", async () => {
  const e = cliEnv([many("pa", 3)]);
  const pending = { "pa/m0": pend("route-shape", 3) };
  assert.deepEqual(keys(planOf(e, [], { pending })), ["pa/m1", "pa/m2"]);
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "owner"], { pending })), ["pa/m0", "pa/m1", "pa/m2"]);
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "pa"], { pending })), ["pa/m1", "pa/m2"], "a provider alone means pay, auth and gone: owner must be named");
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "owner,pa"], { pending })), ["pa/m0", "pa/m1", "pa/m2"]);
  assert.deepEqual(keys(planOf(e, ["--recheck-hard", "pay,auth,gone"], { pending })), ["pa/m1", "pa/m2"], "the hard reasons do not lift it");
  assert.deepEqual(keys(planOf(e, ["--retry-accounts"], { pending })), ["pa/m1", "pa/m2"], "--retry-accounts is about accounts");
  const named = planOf(e, ["--only", "pa/m0"], { pending });
  assert.deepEqual(keys(named), ["pa/m0"]);
  assert.match(hardLines(named).join("\n"), /pa\/m0: needs-owner route-shape since .*; asking it because you named it/);
  const normal = planOf(e, [], { pending });
  assert.equal(normal.verdict.byOwner["route-shape"], 1);
  assert.match(hardLines(normal).join("\n"), /needs-owner, not asked .*: 1 of 3 model\(s\) in the scope \(route-shape 1\)/);
  // live: zero requests for it
  const live = cliEnv([many("pa", 1)], { pending });
  const r = await run(["--live"], live.deps);
  assert.match(r.out, /nothing to probe/);
  assert.equal(calls(live.f).length, 0);
  assert.equal(r.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0 reason=done");
  assert.match(r.out, /NEEDS-OWNER 1 of 1 \(route-shape 1: fix the route/);
});

test("finding 14: row-cost / priced-over-row-cap are not queued while the model is still over the row ceiling; raising --max-row-cost (or lifting) queues it", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("plain"), m("opus", { badge: "PAID", pin: 50, pout: 250 })] }];       // about $0.54 for L1+L2: over the default $0.10 row ceiling
  const e = cliEnv(rows);
  const pending = { "fa/opus": pend("priced-over-row-cap", 2) };
  const keysOf = (argv) => keys(plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs(pinL12(argv)), tiers: e.deps.tiers, pending, nowMs: NOW.getTime() }));
  assert.deepEqual(keysOf([]), ["fa/plain"], "over the default row ceiling: not queued");
  assert.deepEqual(keysOf(["--max-row-cost", "1"]), ["fa/opus", "fa/plain"], "the ceiling was raised: it runs");
  assert.deepEqual(keysOf(["--recheck-hard", "owner"]), ["fa/opus", "fa/plain"]);
  assert.deepEqual(keysOf(["--only", "fa/opus"]), ["fa/opus"]);
  const noStored = keys(plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs([]), tiers: e.deps.tiers, pending: {}, nowMs: NOW.getTime() }));
  assert.deepEqual(noStored, ["fa/opus", "fa/plain"], "without a stored reason the model is queued as before (the engine skips it at run time)");
});

test("finding 7: a model whose own estimate exceeds the per-provider cap is pending cap-too-big (NEEDS-OWNER: raise --tf-max-tokens-per-provider), not cap", async () => {
  const e = cliEnv([many("pa", 2)]);
  const p = planOf(e, ["--tf-max-tokens-per-provider", "1000"]);
  assert.equal(p.tooBig.length, 2);
  assert.equal(p.kept.length, 0);
  assert.deepEqual(p.ledger.l12.counts.byPending, { "cap-too-big": 2 });
  assert.deepEqual([p.verdict.owner, p.verdict.byOwner, p.verdict.recoverable], [2, { "cap-too-big": 2 }, 0]);
  const dry = await run(["--tf-max-tokens-per-provider", "1000"], e.deps);
  assert.match(dry.out, /NEEDS-OWNER 2 of 2 \(cap-too-big 2: raise --tf-max-tokens-per-provider; a re-run alone changes nothing\)/);
  assert.match(dry.out, /will never run under it: raise --tf-max-tokens-per-provider/);
  // models that wait for the cap (they fit alone) stay plain cap: recoverable
  const w = planOf(e, ["--tf-max-tokens-per-provider", "6000"]);
  assert.deepEqual([w.kept.length, w.waiting.length, w.tooBig.length], [1, 1, 0]);
  assert.deepEqual(w.ledger.l12.counts.byPending, { queued: 1, cap: 1 });
  // the run's pending reason for each kind
  assert.equal(capReasonOf({ waiting: [{ key: "a" }], tooBig: [{ key: "b" }] }, "a"), "cap");
  assert.equal(capReasonOf({ waiting: [{ key: "a" }], tooBig: [{ key: "b" }] }, "b"), "cap-too-big");
  assert.equal(capReasonOf({ waiting: [], tooBig: [] }, "c"), null);
});

// ---------------------------------------------------------------- finding 8: --release-holds clears a provider's hard entries even with no hold

test("finding 8: --release-holds <provider> clears that provider's pay/auth/gone/canary-* entries even when no hold exists; there is no early 'nothing to release'", async () => {
  const pending = { "pb/m0": pend("pay"), "pb/m1": pend("canary-pay"), "pb/m2": pend("rate"), "pa/m0": pend("pay") };
  const r1 = releaseHolds({}, pending, {}, { providers: ["pb"] });
  assert.deepEqual(r1.released, []);
  assert.deepEqual(r1.cleared.sort(), ["pb/m0", "pb/m1"]);
  assert.deepEqual(Object.keys(r1.pending).sort(), ["pa/m0", "pb/m2"]);
  assert.deepEqual(r1.missing, [], "named, and it had entries: not 'not held'");
  assert.deepEqual(releaseHolds({}, pending, {}, { providers: ["pz"] }).missing, ["pz"]);
  const e = cliEnv([many("pb", 3), many("pa", 1)], { pending });
  const dry = await run(["--release-holds", "pb"], e.deps);
  assert.match(dry.out, /0 of 0 hold\(s\) would be released; 2 pay\/auth\/gone\/canary pending entries would be cleared/);
  assert.doesNotMatch(dry.out, /not held/);
  const live = await run(["--release-holds", "pb", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /0 hold\(s\) released and 2 pending entries cleared/);
  assert.deepEqual(Object.keys(loadFidelity(e.out).pending).sort(), ["pa/m0", "pb/m2"]);
  assert.match((await run(["--release-holds", "pb", "--live"], e.deps)).out, /nothing to release/);
});

// ---------------------------------------------------------------- finding 9: the repeat message

test("finding 9: a lift deferred by the cap says to repeat the lift, not 'run again'", async () => {
  const pending = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`pb/m${i}`, pend("pay", 3)]));
  const e = cliEnv([many("pb", 6)], { pending });
  const r = await run(["--live", "--per-provider", "1", ...CAP, "--recheck-hard", "pay"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /3 model\(s\) waited for the per-provider cap of 17,100 input tokens: repeat the same --recheck-hard command to continue \(a normal run would leave the lifted ones blocked\)/);
  assert.doesNotMatch(r.out, /run again to continue/);
  const again = await run(["--live", "--per-provider", "1", ...CAP, "--recheck-hard", "pay"], e.deps);
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 6, "repeating the same command finishes the lifted set");
  void again;
  const normal = cliEnv([many("pa", 6)]);
  assert.match((await run(["--live", "--per-provider", "1", ...CAP], normal.deps)).out, /waited for the per-provider cap of 17,100 input tokens: run again to continue/);
});

// ---------------------------------------------------------------- finding 10: --merge-unsaved folds held and pending

test("finding 10: --merge-unsaved folds the side file's held and pending in (the newer time wins) and drops the pending of a model that got its record", async () => {
  const e = cliEnv([many("pa", 4), many("pb", 1), many("pc", 1)]);
  const day = (d) => new Date(NOW.getTime() + d * DAY).toISOString();
  saveFidelity(e.out, { "pa/old": record("ppnn", { at: day(-3) }) }, { live: true, now: NOW, pending: { "pa/m0": { r: "rate", n: 1, at: day(-1) }, "pa/m1": { r: "error", n: 2, at: day(1) }, "pa/m3": { r: "rate", n: 1, at: day(-1) } }, held: { pb: { r: "pay", at: day(-1) } } });
  const kind = JSON.parse(fs.readFileSync(e.out, "utf8")).kind;
  const side = path.join(e.dir, "tool-fidelity.unsaved.json");
  fs.writeFileSync(side, JSON.stringify({ schema: 1, kind, generatedAt: NOW.toISOString(), models: { "pa/m3": record("ppnn", { at: day(0) }) },
    pending: { "pa/m0": { r: "error", n: 2, at: day(0) }, "pa/m1": { r: "rate", n: 1, at: day(-2) }, "pa/m2": { r: "timeout", n: 1, at: day(1) }, "pa/m3": { r: "rate", n: 9, at: day(0) } },
    held: { pb: { r: "auth", at: day(0) }, pc: { r: "gone", at: day(1) } } }));
  const dry = await run(["--merge-unsaved"], e.deps);
  assert.match(dry.out, /holds 1 record\(s\): 1 would be taken .*; 3 pending entries and 2 hold\(s\) would be folded in \(the newer time wins\)/);
  const live = await run(["--merge-unsaved", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /1 record\(s\), 3 pending entries and 2 hold\(s\) merged into tool-fidelity\.json/);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["pa/m0"].r, "error", "the side file's entry is newer");
  assert.equal(st.pending["pa/m1"].r, "error", "the state file's entry is newer: it stays");
  assert.equal(st.pending["pa/m2"].r, "timeout", "new from the side file");
  assert.ok(!st.pending["pa/m3"], "pa/m3 got its record from the side file: no longer pending");
  assert.ok(st.models["pa/m3"]);
  assert.deepEqual([st.held.pb.r, st.held.pc.r], ["auth", "gone"]);
  assert.ok(!fs.existsSync(side));
  // pending/held only: still merged
  const e2 = cliEnv([many("pa", 1)]);
  saveFidelity(e2.out, {}, { live: true, now: NOW });
  const k2 = JSON.parse(fs.readFileSync(e2.out, "utf8")).kind;
  fs.writeFileSync(path.join(e2.dir, "tool-fidelity.unsaved.json"), JSON.stringify({ schema: 1, kind: k2, generatedAt: NOW.toISOString(), models: {}, pending: { "pa/m0": { r: "rate", n: 1, at: day(1) } }, held: {} }));
  const r2 = await run(["--merge-unsaved", "--live"], e2.deps);
  assert.match(r2.out, /0 record\(s\), 1 pending entry and 0 hold\(s\) merged/);
  assert.equal(loadFidelity(e2.out).pending["pa/m0"].r, "rate");
});

// ---------------------------------------------------------------- finding 11: a first strike counts only at a level the run asks

test("finding 11: a first strike is recoverable only when its level is one of the run's levels; otherwise it counts tested, with a note", () => {
  const store = { "pa/a": record("ppfn", { strikes: 1, sl: 3 }), "pa/b": record("fnnn", { strikes: 1, sl: 1 }) };
  const universe = [{ key: "pa/a" }, { key: "pa/b" }];
  const l12 = coverage(universe, store, {});
  const at12 = sweepVerdict({ l12, store, levels: [1, 2] });
  assert.deepEqual([at12.tested, at12.recoverable, at12.byRecoverable, at12.strikeOutOfLevels], [1, 1, { "first-strike": 1 }, 1], "L3 is not among 1 and 2: pa/a counts tested; pa/b (L1) is recoverable");
  const at3 = sweepVerdict({ l12, store, levels: [1, 2, 3] });
  assert.deepEqual([at3.tested, at3.recoverable, at3.strikeOutOfLevels], [0, 2, 0]);
  assert.deepEqual(sweepVerdict({ l12, store }).recoverable, 2, "no levels given: every strike is recoverable (as before)");
  assert.match(verdictLines(at12).join("\n"), /note: 1 first strike\(s\) failed at a level this run does not ask; they count as tested here/);
  assert.ok(!verdictLines(at3).join("\n").includes("note:"));
  const e = cliEnv([many("pa", 2)]);
  const st2 = { "pa/m0": store["pa/a"], "pa/m1": store["pa/b"] };
  assert.equal(planOf(e, [], { store: st2 }).verdict.strikeOutOfLevels, 1, "default levels 1+2: the L3 strike is out of levels");
  assert.equal(planOf(e, ["--levels", "3"], { store: st2 }).verdict.strikeOutOfLevels, 1, "levels 3: now the L1 strike is the one out of levels");
});

// ---------------------------------------------------------------- finding 13: when a hold is released

test("D: a provider counts as ANSWERED when the run produced any verdict record for it (t, v or x): every model failing (no tool support) still clears an auth hold and its stale entries", async () => {
  const held = { pb: { r: "auth", at: hoursAgo(3) } };
  const pending = { "pb/m1": pend("canary-auth", 2) };
  const bad = cliEnv([many("pb", 2)], { held, pending, answer: () => http(400, "tools.0.input_schema: unsupported keyword anyOf") });
  const r1 = await run(["--live", "--per-provider", "1", "--recheck-hard", "auth"], bad.deps);
  assert.equal(r1.code === 0 || r1.code === 3, true, r1.err + r1.out);
  const s1 = loadFidelity(bad.out);
  assert.ok(Object.values(s1.models).length === 2 && Object.values(s1.models).every((x) => x.strikes === 1 && x.t !== "t" && x.t !== "v"), "it answered, with failures (first strikes), no confirmed record");
  assert.deepEqual(s1.held, {}, "the provider answered: the auth hold is cleared");
  assert.ok(!s1.pending["pb/m1"], "and so is its stale canary entry (the model has a record now)");
  // a provider that never answered keeps its hold
  const dead = cliEnv([many("pb", 2)], { held, answer: () => http(401, "bad key") });
  await run(["--live", "--per-provider", "1", "--recheck-hard", "auth"], dead.deps);
  assert.equal(loadFidelity(dead.out).held.pb.r, "auth", "no answer: the hold stays (re-stamped)");
  // holdIsWrong is untouched: a gone hold on a provider with only x records is still a hold the queue honours
  const gone = cliEnv([many("pd", 2)], { held: { pd: { r: "gone", at: hoursAgo(1) } }, store: { "pd/old": record("ffnn", { strikes: 2, sl: 1 }) } });
  const p = planOf(gone, [], { held: { pd: { r: "gone", at: hoursAgo(1) } }, store: { "pd/old": record("ffnn", { strikes: 2, sl: 1 }) } });
  assert.deepEqual(keys(p), [], "an x record is not a confirmed result: the gone hold is not wrong");
});

test("finding 13: a named model's answer releases only that model's own entry: the provider's hold and its other pending entries stay", async () => {
  const e = cliEnv([many("pb", 3)], { held: { pb: { r: "pay", at: hoursAgo(3) } }, pending: { "pb/m0": pend("pay"), "pb/m1": pend("canary-pay"), "pb/m2": pend("canary-pay") } });
  const r = await run(["--live", "--only", "pb/m0", "--per-provider", "1"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const st = loadFidelity(e.out);
  assert.ok(st.models["pb/m0"], "the named model got its record");
  assert.ok(!st.pending["pb/m0"], "its own entry is gone");
  assert.deepEqual(Object.keys(st.held), ["pb"], "the provider is still held");
  assert.deepEqual(Object.keys(st.pending).sort(), ["pb/m1", "pb/m2"], "and its other entries stay");
});

// ---------------------------------------------------------------- QUOTA: a bare quota sentence is soft

const kindRun = async (status, msg) => { const f = fakeFetch(() => http(status, msg)); const r = await runKind("1", { fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "fa/m", timeoutMs: 5000 }); return r.s; };

test("quota: the sentence table: a bare quota/limit/allowance sentence is `quota` (soft); money words, 402 and a rate limit keep their reading", async () => {
  const table = [
    [400, "Daily limit reached for this model", "quota"],
    [400, "You have no remaining quota for today", "quota"],
    [400, "out of quota", "quota"],
    [422, "Your monthly allowance has been used", "quota"],
    [400, "Insufficient quota", "quota"],
    [403, "Quota exceeded for this API key", "quota"],
    [429, "insufficient_quota: daily limit reached", "quota"],
    [400, "Your wallet balance is insufficient. Recharge at [url] to continue.", "pay"],
    [400, "insufficient credits, please top up", "pay"],
    [429, "insufficient_quota: You exceeded your current quota, please check your plan and billing details.", "pay"],
    [402, "Daily quota reached", "pay"],
    [402, "Payment required", "pay"],
    [400, "payment required", "pay"],
    [400, "credit limit reached", "pay"],
    [400, "Rate limit reached: 30 requests per minute", "rate"],
    [422, "quota exceeded, try again in 20s", "rate"],
    [429, "slow down", "rate"],
  ];
  for (const [status, msg, want] of table) assert.equal(await kindRun(status, msg), want, `${status}: ${msg}`);
  assert.equal(isQuotaSentence("per day limit"), true);
  assert.equal(isQuotaSentence("balance quota"), false);
  assert.equal(isQuotaSentence(undefined), false);
});

test("quota: a quota model is pending quota (soft) with the provider's sentence in `why`, no hold is written, and a normal run queues it again; a pay model is not queued", async () => {
  const e = cliEnv([many("pa", 3)], { store: { "pa/known": record("ppnn") }, answer: (c) => (c.body.model === "pa/m0" ? http(400, "Daily limit reached for this model") : c.body.model === "pa/m1" ? http(402, "no credit") : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["pa/m0"].r, "quota");
  assert.equal(st.pending["pa/m0"].why, "Daily limit reached for this model");
  assert.equal(st.pending["pa/m1"].r, "pay");
  assert.match(st.pending["pa/m1"].why, /no credit/);
  assert.deepEqual(st.held, {}, "a quota sentence is never a hold");
  assert.match(r.out, /RECOVERABLE 1 of 3 \(quota 1\) \| HARD-BLOCKED 1 of 3 \(pay 1;/);
  const p = planOf(e, [], { store: st.models, pending: st.pending });
  assert.deepEqual(keys(p), ["pa/m0"], "the quota model is asked again; the pay model is not");
  assert.equal(p.verdict.byRecoverable.quota, 1);
  assert.equal(p.verdict.byHard.pay, 1);
});

test("quota: quota counts toward stuck at rn >= 3 and is listed with its since date; it never escalates to pay by itself", () => {
  const pending = { "pa/a": { r: "quota", n: 5, rn: 3, at: hoursAgo(1), since: "2026-10-01T00:00:00.000Z" }, "pa/b": { r: "quota", n: 5, rn: 2, at: hoursAgo(1), since: "2026-10-04T00:00:00.000Z" } };
  const v = sweepVerdict({ l12: coverage([{ key: "pa/a" }, { key: "pa/b" }], {}, { pending }), pending });
  assert.deepEqual([v.recoverable, v.stuck, v.hard], [2, 1, 0]);
  assert.equal(v.oldestSince.quota, "2026-10-01T00:00:00.000Z");
  assert.equal(hardState("quota", "pa"), null);
  assert.ok(TRIED_REASONS.has("quota"));
});

test("quota / G: a provider that keeps answering quota is left alone for the rest of the run (no wait); the models it was never asked about are `quota-paused` (not a fresh quota answer, not stuck); no hold", async () => {
  const e = cliEnv([many("pa", 8)], { answer: () => http(400, "Daily limit reached for this model") });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.out, /left alone for the rest of this run, their models stay pending: pa \(quota exhausted\)/);
  assert.ok(calls(e.f).length <= 4, `${calls(e.f).length} requests: three, then nothing`);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.values(st.pending).map((x) => x.r).sort(), ["quota", "quota", "quota", ...Array(5).fill("quota-paused")].sort());
  assert.deepEqual(st.held, {});
  assert.match(r.out, /RECOVERABLE 8 of 8 \(quota-paused 5, quota 3\)/);
});

test("quota: `why` is the clipped, redacted sentence (at most 120 characters)", async () => {
  const long = `Daily limit reached. ${"please wait for the allowance to reset ".repeat(8)}`;
  const e = cliEnv([many("pa", 1)], { answer: () => http(400, long) });
  await run(["--live", "--per-provider", "1"], e.deps);
  const why = loadFidelity(e.out).pending["pa/m0"].why;
  assert.ok(why.startsWith("Daily limit reached.") && why.length <= 120, why);
});

// ================================================================ round 2 (re-review of a880722)

// the same as `run`, but the argv is NOT pinned to L1+L2: these tests are about the new default levels
async function runRaw(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n"), lines: out.join("\n").split("\n") };
}
const kindsOf = (f) => calls(f).map(kindOf);
const FREE_TIER = { tier: "free" };
const probeConn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });

// ---------------------------------------------------------------- A: a bare quota sentence on a 403 is quota, not an auth hold

test("A: a bare quota sentence on a 403 (or a pay-looking status) is `quota`; real auth words stay auth; 402 and money words stay pay", async () => {
  const table = [
    [403, "Daily limit reached for free tier", "quota"],
    [403, "Quota exceeded for this API key", "quota"],
    [403, "You have used your monthly allowance", "quota"],
    [403, "Invalid API key", "auth"],
    [403, "forbidden: this key cannot use this model", "auth"],
    [403, "Unauthorized", "auth"],
    [401, "Daily limit reached", "auth"],
    [401, "Invalid API key", "auth"],
    [403, "Insufficient balance, billing required", "pay"],
    [403, "quota exceeded; upgrade your plan", "pay"],
    [402, "Daily limit reached for free tier", "pay"],
  ];
  for (const [status, msg, want] of table) assert.equal(await kindRun(status, msg), want, `${status}: ${msg}`);
});

test("A: a 403 quota sentence does not hold the provider as auth: the first models are quota (soft), nothing is held", async () => {
  const e = cliEnv([many("pa", 4)], { answer: () => http(403, "Daily limit reached for free tier") });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual(st.held, {}, "not an auth hold");
  assert.ok(Object.values(st.pending).every((x) => x.r === "quota" || x.r === "quota-paused"));
  assert.doesNotMatch(r.out, /providers needing attention/);
});

// ---------------------------------------------------------------- C: requests= on the machine line

test("C: the SATURATION line ends with requests=<n>: 0 for a dry run and a run that sent nothing, the requests sent otherwise", async () => {
  const e = cliEnv([many("pa", 2)]);
  const dry = await run([], e.deps);
  assert.match(dry.lines.at(-1), /^SATURATION saturated=unknown recoverable=2 hard=0 new_results=0 requests=0 reason=unknown$/);
  const live = await run(["--live", "--per-provider", "1"], e.deps);
  const sent = calls(e.f).length;
  assert.ok(sent > 0);
  assert.match(live.lines.at(-1), new RegExp(`^SATURATION saturated=yes recoverable=0 hard=0 new_results=2 requests=${sent} reason=done$`));
  const nothing = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(nothing.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0 reason=done$/);
});

// ---------------------------------------------------------------- E: the provider's words go first when the file is over its cap

test("E: over the size cap the provider's words go first: `why` is stripped from the OLDEST pending entries before any model record is dropped", () => {
  const models = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`fa/m${i}`, record("ppnn", { at: new Date(NOW.getTime() + i).toISOString() })]));
  const pending = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`fb/p${i}`, { r: "rate", n: 1, at: new Date(NOW.getTime() + i * 1000).toISOString(), why: "slow down and try again later ".repeat(4).slice(0, 100) }]));
  const full = Buffer.byteLength(renderFile(Object.entries(models), NOW, pending, null));
  const r = capRecords(models, { now: NOW, maxBytes: full - 250, pending });
  assert.deepEqual(r.dropped, [], "no model record is dropped");
  assert.equal(r.whyStripped, 3, "250 bytes: three sentences of about 110 bytes");
  assert.deepEqual([0, 1, 2].map((i) => r.pending[`fb/p${i}`].why), [undefined, undefined, undefined], "the oldest lose theirs");
  assert.deepEqual([3, 4, 5].map((i) => r.pending[`fb/p${i}`].why?.length), [100, 100, 100]);
  assert.ok(pending["fb/p0"].why, "the input is not changed");
  assert.equal(r.pending["fb/p0"].r, "rate", "the entry itself stays");
  // words alone cannot meet a tight cap: every sentence goes first, then records
  const stripped = Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, { r: v.r, n: v.n, at: v.at }]));
  const tight = capRecords(models, { now: NOW, maxBytes: Buffer.byteLength(renderFile([], NOW, stripped, null)) + 300, pending });
  assert.equal(tight.whyStripped, 6);
  assert.ok(tight.dropped.length > 0 && tight.dropped.length < 10);
  // no pressure: nothing stripped
  assert.equal(capRecords(models, { now: NOW, pending }).whyStripped, 0);
  // through saveFidelity
  const d = freshDir(), file = path.join(d, FILE_NAME);
  const full2 = Buffer.byteLength(renderFile(Object.entries(models), NOW, cleanPending(pending), null));       // the size of what saveFidelity really writes (the sentences are cleaned on the way in)
  const w = saveFidelity(file, models, { now: NOW, pending, maxBytes: full2 - 250 });
  assert.equal(w.dropped.length, 0);
  assert.ok(w.whyStripped >= 2 && w.whyStripped <= 3, String(w.whyStripped));
  assert.ok(w.bytes <= full2 - 250);
  const back = loadFidelity(file);
  assert.equal(Object.keys(back.models).length, 10);
  assert.equal(back.pending["fb/p0"].why, undefined);
  assert.ok(back.pending["fb/p5"].why.length > 50);
});

// ---------------------------------------------------------------- F: a released hold does not come back from an old side file

test("F: --merge-unsaved takes a side-only hold or pending entry only if its time is after the state file's own last write; an entry in both files: the newer wins", async () => {
  const e = cliEnv([many("pa", 3), many("pb", 1), many("pc", 1)]);
  const plus = (h) => new Date(NOW.getTime() + h * 3600000).toISOString();
  saveFidelity(e.out, {}, { live: true, now: NOW, held: { pd: { r: "auth", at: plus(-30) } }, pending: { "pa/m2": { r: "rate", n: 1, at: plus(-30) } } });   // pb's hold was released since (it is not in the file)
  const kind = JSON.parse(fs.readFileSync(e.out, "utf8")).kind;
  const side = path.join(e.dir, "tool-fidelity.unsaved.json");
  fs.writeFileSync(side, JSON.stringify({ schema: 1, kind, generatedAt: plus(-40), models: {},
    held: { pb: { r: "pay", at: plus(-5) }, pc: { r: "gone", at: plus(1) }, pd: { r: "gone", at: plus(-1) } },
    pending: { "pa/m0": { r: "rate", n: 1, at: plus(-5) }, "pa/m1": { r: "timeout", n: 1, at: plus(1) }, "pa/m2": { r: "error", n: 3, at: plus(-2) } } }));
  const dry = await run(["--merge-unsaved"], e.deps);
  assert.match(dry.out, /2 pending entries and 2 hold\(s\) would be folded in/, "pa/m1 and pa/m2 (newer than the file's own entry), pc and pd");
  const live = await run(["--merge-unsaved", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.held).sort(), ["pc", "pd"], "pb (released since, older than the last write) does not come back; pd is in both files and the side's is newer");
  assert.equal(st.held.pd.r, "gone");
  assert.deepEqual(Object.keys(st.pending).sort(), ["pa/m1", "pa/m2"], "pa/m0 (side-only, older than the write) does not come back");
  assert.equal(st.pending["pa/m2"].r, "error");
});

// ---------------------------------------------------------------- G: quota-paused and the stuck words

test("G: a model a quota pause never asked keeps its previous reason (or is `quota-paused`, a reason that never counts toward stuck); the provider's words are printed once per stuck provider", () => {
  const prev = { "p/a": { r: "quota", n: 4, rn: 2, at: hoursAgo(5), since: hoursAgo(50), why: "Daily limit reached" } };
  const out = updatePending(prev, { queue: [{ key: "p/a" }, { key: "p/b" }], recorded: new Set(), store: {}, now: NOW, reasonOf: () => "quota-paused" });
  assert.deepEqual(out["p/a"], prev["p/a"], "never asked: unchanged (rn does not grow)");
  assert.equal(out["p/b"].r, "quota-paused");
  assert.equal(pendingReasonOf({ s: "skip", w: "quota-paused" }), "quota-paused");
  assert.equal(pendingReasonOf({ s: "skip", w: "rate-paused" }), "rate-paused");
  const pend2 = { "pa/b": { r: "quota-paused", n: 9, rn: 9, at: hoursAgo(1) } };
  const v0 = sweepVerdict({ l12: coverage([{ key: "pa/b" }], {}, { pending: pend2 }), pending: pend2 });
  assert.deepEqual([v0.recoverable, v0.stuck], [1, 0], "quota-paused never counts toward stuck, however long");
  const pending = {
    "pa/m0": { r: "error", n: 3, rn: 3, at: hoursAgo(1), why: "upstream boom" }, "pa/m1": { r: "error", n: 3, rn: 3, at: hoursAgo(1), why: "upstream boom" }, "pa/m2": { r: "timeout", n: 3, rn: 3, at: hoursAgo(1), why: "no answer in 45 s" },
    "pb/m0": { r: "quota", n: 4, rn: 3, at: hoursAgo(1), why: "Daily limit reached" }, "pc/m0": { r: "error", n: 1, rn: 1, at: hoursAgo(1), why: "fresh" }, "pd/m0": { r: "slow", n: 3, rn: 3, at: hoursAgo(1) },
  };
  const universe = Object.keys(pending).map((key) => ({ key }));
  const v = sweepVerdict({ l12: coverage(universe, {}, { pending }), pending });
  assert.deepEqual(v.stuckWhy, { pa: { total: 3, why: "upstream boom", n: 2 }, pb: { total: 1, why: "Daily limit reached", n: 1 }, pd: { total: 1 } });
  const text = verdictLines(v).join("\n");
  assert.match(text, /stuck on pa: "upstream boom" \(2 of its 3 stuck model\(s\) say so; the provider's own words\)/);
  assert.match(text, /stuck on pb: "Daily limit reached" \(1 of its 1 stuck/);
  assert.doesNotMatch(text, /stuck on pc|stuck on pd/, "pc is not stuck; pd has no words to show");
});

// ---------------------------------------------------------------- H: the cheap levels first

test("H: the levels run in cost order 1, 1a, 2, 6, 7, then 3, 4, 5, whatever order they are listed in; the request ceiling holds", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [5, 3, 7, 2, 6, 1, 4], ...FREE_TIER, ...probeConn(f) });
  assert.deepEqual(kindsOf(f), ["1", "1a", "2", "6", "2e", "3a", "3b", "5"]);
  assert.ok(r.requests <= MAX_MODEL_REQUESTS);
  const g = fakeFetch(goodModel);
  await probeModel({ levels: [1, 2, 6, 7], ...FREE_TIER, ...probeConn(g) });
  assert.deepEqual(kindsOf(g), ["1", "1a", "2", "6", "2e"], "the baseline: five requests, about 6,100 input tokens");
  // the worst case without a timeout or an escalation: every L1-type request needs its forced retry, 3a and 3b their cache_control retry: still counted, still <= 12
  const text = (k) => ok(stream(ev.text(0, "no call"), ev.stop()));
  const h = fakeFetch((c) => (["1", "1a"].includes(kindOf(c)) ? text() : goodModel(c)));
  const w = await probeModel({ levels: [1, 2, 3, 4, 5, 6, 7], ...FREE_TIER, ...probeConn(h) });
  assert.ok(w.requests <= MAX_MODEL_REQUESTS, `${w.requests} requests`);
  assert.deepEqual(kindsOf(h).slice(0, 4), ["1", "1f", "1a", "1af"]);
});

test("H: a stop at L3 (a rate limit) keeps what finished: L1, L2, spawn and the error result are in `done`, in the record, and not asked again", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "3a" ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)));
  const done = {};
  const r = await probeModel({ levels: [1, 2, 3, 5, 6, 7], done, ...FREE_TIER, ...probeConn(f) });
  assert.equal(r.inconclusive.s, "rate");
  assert.deepEqual(["1", "2", "6", "7"].map((l) => done[l]?.v), ["p", "p", "p", "p"], "the cheap levels finished before L3 stopped the model");
  assert.equal(done[3], undefined);
  // through the CLI: the partial record is saved, the stopped level waits
  const e = cliEnv([many("pa", 1)], { answer: (c) => (kindOf(c) === "3a" ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const argv = ["--live", "--levels", "123567", "--l3", "yes", "--only", "pa", "--per-provider", "1", "--tf-max-tokens-per-provider", "1000000"];
  const r1 = await run(argv, e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual([st.models["pa/m0"]?.lvr, st.models["pa/m0"]?.sp, st.models["pa/m0"]?.er], ["ppnn", "p", "p"], r1.out);
  assert.equal(st.pending["pa/m0"], undefined, "no pending reason beside a record that was saved (the queue asks the stopped level again)");
  assert.match(r1.out, /1 of those 1 record\(s\) are partial/);
  e.f.calls.length = 0;
  e.deps.fetch = fakeFetch(goodModel);
  const r2 = await run(argv, e.deps);
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.deepEqual(kindsOf(e.deps.fetch), ["3a", "3b", "5"], "only the stopped levels are asked again");
  assert.equal(loadFidelity(e.out).models["pa/m0"].lvr[2], "p");
  assert.ok(!loadFidelity(e.out).pending["pa/m0"]);
});

test("H: L1 alone is never saved as a partial record (it would read as tested and L2 would never be asked); a stop before L1+L2 both have a verdict records nothing", async () => {
  const e = cliEnv([many("pa", 1)], { answer: (c) => (kindOf(c) === "2" ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.equal(st.models["pa/m0"], undefined, "L1 passed, L2 was rate limited: no record");
  assert.equal(st.pending["pa/m0"].r, "rate");
});

test("H: a flaky L6 or L7 (an error, a timeout, an empty answer) does not block L3 or the big step; it is set aside for a later run; a limit or an account state on L6 stops the model as before", async () => {
  for (const flaky of [http(500, "boom"), http(400, "Upstream request failed.")]) {
    const f = fakeFetch((c) => (kindOf(c) === "6" ? flaky : goodModel(c)));
    const done = {};
    const r = await probeModel({ levels: [1, 2, 3, 5, 6, 7], done, ...FREE_TIER, ...probeConn(f) });
    assert.equal(r.inconclusive, undefined, "the model got a result");
    assert.deepEqual([done[3].v, done[5].v, done[7].v, done[6]], ["p", "p", "p", undefined]);
    assert.deepEqual(r.deferred.map((x) => [x.level, x.s]), [[6, "error"]]);
    assert.deepEqual(kindsOf(f), ["1", "1a", "2", "6", "2e", "3a", "3b", "5"], "L7 and the big levels went on");
  }
  // both small levels flaky: still L3
  const g = fakeFetch((c) => (["6", "2e"].includes(kindOf(c)) ? http(500, "boom") : goodModel(c)));
  const d2 = {};
  const r2 = await probeModel({ levels: [1, 2, 3, 6, 7], done: d2, ...FREE_TIER, ...probeConn(g) });
  assert.deepEqual([d2[3].v, r2.deferred.map((x) => x.level)], ["p", [6, 7]]);
  // a rate limit, or an account state, on L6 would hit the next request too: the model stops
  for (const stopper of [http(429, "slow down"), http(402, "no credit"), http(401, "bad key")]) {
    const s = fakeFetch((c) => (kindOf(c) === "6" ? stopper : goodModel(c)));
    const d3 = {};
    const r3 = await probeModel({ levels: [1, 2, 3, 6, 7], done: d3, ...FREE_TIER, ...probeConn(s) });
    assert.ok(r3.inconclusive, String(stopper.status));
    assert.ok(!kindsOf(s).includes("3a"), "L3 was not asked");
    assert.equal(d3[2].v, "p", "L1 and L2 are kept in done");
  }
});

test("H: through the CLI a flaky spawn level leaves a record with L1, L2 and the error result, says so, and the next run asks spawn alone", async () => {
  let open = false;
  const e = cliEnv([many("pa", 1)], { answer: (c) => (!open && kindOf(c) === "6" ? http(500, "boom") : goodModel(c)) });
  const r1 = await runRaw(["--live", "--per-provider", "1"], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  const rec = loadFidelity(e.out).models["pa/m0"];
  assert.deepEqual([rec.lvr, rec.er, rec.sp], ["ppnn", "p", undefined]);
  assert.match(r1.out, /1 model\(s\) kept their other levels while a small level was set aside \(spawn 1;/);
  assert.deepEqual(kindsOf(e.f), ["1", "1a", "2", "6", "2e"]);
  open = true;
  e.f.calls.length = 0;
  const r2 = await runRaw(["--live", "--per-provider", "1"], e.deps);
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.deepEqual(kindsOf(e.f), ["6"], "only the set-aside level");
  assert.equal(loadFidelity(e.out).models["pa/m0"].sp, "p");
});

test("H: the default levels are L1+L2+L6+L7 (the baseline); --levels 12 is L1+L2 alone; the ledger's l12 universe still means L1+L2; the big-request gate does not trip on 6 and 7", async () => {
  assert.deepEqual(parseArgs([]).levels, [1, 2, 6, 7]);
  assert.deepEqual([...DEFAULT_LEVELS], [1, 2, 6, 7]);
  assert.deepEqual(parseArgs(["--levels", "12"]).levels, [1, 2]);
  const e = cliEnv([many("pa", 2)]);
  const dry = await runRaw([], e.deps);
  assert.match(dry.out, /levels L1\+L2\+L6\+L7  incremental/);
  assert.deepEqual(plan({ snap: { rows: e.rows }, bench: e.deps.bench, store: {}, o: parseArgs([]), tiers: e.deps.tiers, nowMs: NOW.getTime() }).queued.map((x) => x.todo.join()), ["1,2,6,7", "1,2,6,7"]);
  const l12 = await runRaw(["--levels", "12"], e.deps);
  assert.match(l12.out, /levels L1\+L2  incremental/);
  assert.deepEqual(plan({ snap: { rows: e.rows }, bench: e.deps.bench, store: {}, o: parseArgs(["--levels", "12"]), tiers: e.deps.tiers, nowMs: NOW.getTime() }).queued.map((x) => x.todo.join()), ["1,2", "1,2"]);
  // a model with L1+L2 only is tested at l12 and queued for the two small levels alone
  const p = plan({ snap: { rows: e.rows }, bench: e.deps.bench, store: { "pa/m0": record("ppnn") }, o: parseArgs([]), tiers: e.deps.tiers, nowMs: NOW.getTime() });
  assert.deepEqual(p.queued.map((x) => [x.key, x.todo.join()]), [["pa/m0", "6,7"], ["pa/m1", "1,2,6,7"]]);
  assert.equal(p.ledger.l12.counts.tested, 1);
  // a live default run needs no --l3 yes (6 and 7 are a few hundred tokens), and a model ends complete
  const live = await runRaw(["--live", "--per-provider", "1"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.deepEqual(Object.values(loadFidelity(e.out).models).map((x) => [x.lvr, x.sp, x.er]), [["ppnn", "p", "p"], ["ppnn", "p", "p"]]);
  assert.match(live.out, /TESTED 2 of 2 \(complete for every level it is eligible for 2 of 2;/);
  const again = await runRaw([], e.deps);
  assert.match(again.out, /nothing to probe/);
});

test("H: a timeout on L6 (asked once more at double, then given up) is set aside too: L7 and L3 still run", async () => {
  const inner = fakeFetch(goodModel);
  const f = (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body && kindOf({ body }) === "6") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }));
    return inner(url, init);
  };
  f.calls = inner.calls;
  const done = {};
  const r = await probeModel({ levels: [1, 2, 3, 6, 7], done, ...FREE_TIER, ...probeConn(f, { timeouts: { small: 60, "157": 5000, big: 5000 } }) });
  assert.equal(r.inconclusive, undefined);
  assert.deepEqual([done[3].v, done[7].v, r.deferred.map((x) => [x.level, x.s])], ["p", "p", [[6, "timeout"]]]);
});

// ================================================================ round 3 (re-review of ccb681c)

const kindRes = async (status, msg) => { const f = fakeFetch(() => http(status, msg)); return runKind("1", { fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "fa/m", timeoutMs: 5000 }); };

// ---------------------------------------------------------------- 1: the default baseline shows in the verdict and the stop signal

test("round 3 / 1: six models tested at L1+L2 only, default levels: recoverable 6 (optional-not-run), a non-empty queue, no DONE, saturated not yes", async () => {
  const rows = [many("pa", 6)];
  const store = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`pa/m${i}`, record("ppnn")]));
  const e = cliEnv(rows, { store });
  const dry = await runRaw([], e.deps);
  assert.match(dry.out, /sweep verdict: RECOVERABLE 6 of 6 \(optional-not-run 6\) \| HARD-BLOCKED 0 of 6 \(none;[^\n]*\) \| TESTED 0 of 6/);
  assert.match(dry.out, /this run: 6 model\(s\) queued of 6/);
  assert.doesNotMatch(dry.out, /DONE:/);
  assert.match(dry.lines.at(-1), /^SATURATION saturated=unknown recoverable=6 hard=0 new_results=0 requests=0 reason=unknown$/);
  // --levels 12: the baseline is L1+L2, nothing is missing, the run says DONE as before
  const l12 = await runRaw(["--levels", "12"], e.deps);
  assert.match(l12.out, /RECOVERABLE 0 of 6 \(none\)[^\n]*TESTED 6 of 6/);
  assert.match(l12.out, /DONE: nothing recoverable left/);
  // the pure rule: a non-empty queue never prints DONE, whatever the counts say
  const v = { recoverable: 0, hard: 0, tested: 2, total: 2, owner: 0, byRecoverable: {}, byHard: {}, byOwner: {}, excluded: 0, oldestSince: {} };
  assert.ok(verdictLines(v).some((x) => x.startsWith("DONE")));
  assert.ok(!verdictLines(v, { queued: 2 }).some((x) => x.startsWith("DONE")));
  // a run that rate-limits L6 and L7 everywhere finds nothing new: still 6 recoverable, no DONE
  const limited = cliEnv(rows, { store, answer: (c) => (["6", "2e"].includes(kindOf(c)) ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const r1 = await runRaw(["--live", "--per-provider", "1"], limited.deps);
  assert.match(r1.out, /RECOVERABLE 6 of 6 \((rate|rate-paused) \d+, (rate|rate-paused) \d+\)/);
  assert.doesNotMatch(r1.out, /DONE:/);
  assert.match(r1.lines.at(-1), /^SATURATION saturated=yes recoverable=6 hard=0 new_results=0 requests=\d+ reason=zero-new$/, "yes because the run recorded nothing new (everything rate-limited), not because nothing is recoverable");
  assert.match(r1.out, /saturated: yes \(no new result in this run\)/);
  // half of them answer: progress, three left
  const mixed = cliEnv([many("pa", 3), many("pb", 3)], { store: Object.fromEntries(["pa", "pb"].flatMap((p) => [0, 1, 2].map((i) => [`${p}/m${i}`, record("ppnn")]))), answer: (c) => (c.body.model.startsWith("pb/") && ["6", "2e"].includes(kindOf(c)) ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const r2 = await runRaw(["--live", "--per-provider", "1"], mixed.deps);
  assert.match(r2.out, /RECOVERABLE 3 of 6 \((rate|rate-paused) \d+(, (rate|rate-paused) \d+)?\)/);
  assert.match(r2.lines.at(-1), /^SATURATION saturated=no recoverable=3 hard=0 new_results=3 requests=\d+ reason=none$/, r2.out);
  // and when they all answer: nothing left, DONE
  const open = cliEnv(rows, { store });
  const r3 = await runRaw(["--live", "--per-provider", "1"], open.deps);
  assert.match(r3.out, /DONE: nothing recoverable left \(6 of 6 model\(s\) tested/);
  assert.match(r3.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=6 requests=\d+ reason=done$/);
});

test("round 3 / 1: a level above L2 counts as missing only when the run ASKS for it and the model is eligible: --levels 123 makes the L3 of an L1+L2 model recoverable, the default does not", async () => {
  const e = cliEnv([many("pa", 2)], { store: { "pa/m0": record("ppnn", { sp: "p", er: "p" }), "pa/m1": record("ppnn", { sp: "p", er: "p" }) } });
  const base = await runRaw([], e.deps);
  assert.match(base.out, /RECOVERABLE 0 of 2 \(none\)/, "the baseline levels are all there");
  assert.match(base.out, /DONE:/);
  const deep = await runRaw(["--levels", "123"], e.deps);
  assert.match(deep.out, /RECOVERABLE 2 of 2 \(optional-not-run 2\)/);
  assert.doesNotMatch(deep.out, /DONE:/);
  // a provider that is held cannot be asked: its missing levels are hard, not recoverable
  const held = cliEnv([many("pa", 2)], { store: { "pa/m0": record("ppnn"), "pa/m1": record("ppnn") }, held: { pa: { r: "auth", at: hoursAgo(1) } } });       // (a pay or gone hold is ignored for a provider with confirmed results: holdIsWrong)
  const h = await runRaw([], held.deps);
  assert.match(h.out, /RECOVERABLE 0 of 2 \(none\) \| HARD-BLOCKED 2 of 2 \(auth 2;/);
});

// ---------------------------------------------------------------- 2: a 400 that says the credentials are wrong is auth

test("round 3 / 2: a refusal whose own sentence says the key or token is wrong is `auth` at 400, 401, 403 and 422; a schema 400 that merely contains the word key is not", async () => {
  for (const [status, msg] of [[400, "Invalid API key provided."], [400, "incorrect API key"], [400, "Incorrect api key provided: sk-..."], [400, "Unauthorized"], [400, "unauthorised request"], [400, "Authentication failed"], [400, "authentication error: invalid token"],
    [400, "Missing API key"], [400, "Your API key is invalid"], [400, "invalid access token"], [400, "expired credentials"], [422, "invalid api key"], [401, "Invalid API key provided."], [403, "Invalid API key provided."], [401, "Unauthorized"]]) {
    const r = await kindRes(status, msg);
    assert.equal(r.s, "auth", `${status}: ${msg}`);
    assert.equal(r.v, "i", "never a verdict: no strike");
  }
  for (const [status, msg] of [[400, "tools.0.input_schema: unknown key 'foo' in properties"], [400, "invalid key name in schema"], [400, "Unknown key in properties: additionalProperties"], [400, "property key must be a string"], [400, "Invalid parameter: tools.1.name"]]) {
    const r = await kindRes(status, msg);
    assert.notEqual(r.s, "auth", `${status}: ${msg}`);
  }
  assert.equal((await kindRes(400, "tools.0.input_schema: unknown key 'foo' in properties")).v, "f", "a schema refusal stays a verdict");
});

test("round 3 / 2: a provider that answers every request 400 'Invalid API key' is held as auth: no strikes, no records, nothing released", async () => {
  const e = cliEnv([many("pa", 4)], { answer: () => http(400, "Invalid API key provided.") });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.models), [], "no schema strike, no record");
  assert.equal(st.held.pa.r, "auth");
  assert.match(r.out, /pa: auth \(the key was rejected\)/);
  // a hold is not released by an answer that never came
  e.deps.fetch = fakeFetch(() => http(400, "Invalid API key provided."));
  await run(["--live", "--per-provider", "1", "--recheck-hard", "auth"], e.deps);
  assert.equal(loadFidelity(e.out).held.pa.r, "auth");
});

// ---------------------------------------------------------------- 3: a saved partial record leaves no pending reason beside it

test("round 3 / 3: a partial record is saved WITHOUT a pending reason (no newer pending entry beside a good L1+L2 record), and the queue still asks the missing level", async () => {
  const e = cliEnv([many("pa", 1)], { answer: (c) => (kindOf(c) === "3a" ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const argv = ["--live", "--levels", "123567", "--l3", "yes", "--only", "pa", "--per-provider", "1", "--tf-max-tokens-per-provider", "1000000"];
  const r1 = await run(argv, e.deps);
  const st = loadFidelity(e.out);
  const rec = st.models["pa/m0"];
  assert.deepEqual([rec.lvr, rec.sp, rec.er], ["ppnn", "p", "p"]);
  assert.equal(st.pending["pa/m0"], undefined, "no pending entry beside the record that was saved");
  assert.ok(!(st.pending["pa/m0"] && Date.parse(st.pending["pa/m0"].at) >= Date.parse(rec.at)), "the (record.at, pending) pair never shows a good L1+L2 record with a newer pending entry");
  assert.match(r1.out, /RECOVERABLE 1 of 1 \(optional-not-run 1\)/, "the missing level is still counted: it is asked again");
  const p = planOf(e, ["--levels", "123567", "--l3", "yes", "--only", "pa"], { store: st.models, pending: st.pending });
  assert.deepEqual(p.queued.map((x) => [x.key, x.todo.join()]), [["pa/m0", "3,5"]], "queueFor still re-asks the stopped level");
});

// ---------------------------------------------------------------- 4: a flaky spawn / error-result level leaves a deferral marker

test("round 3 / 4: a flaky L6 leaves the marker `optional-flaky` (since, rn, the provider's words), not a growing not-run; it counts toward stuck at rn >= 3 and is cleared when the level finally runs", async () => {
  let open = false;
  const e = cliEnv([many("pa", 1)], { answer: (c) => (!open && kindOf(c) === "6" ? http(500, "boom upstream") : goodModel(c)) });
  const day = (d) => new Date(NOW.getTime() + d * DAY);
  const states = [];
  for (let d = 0; d < 3; d++) {
    e.deps.now = () => day(d);
    const r = await runRaw(["--live", "--per-provider", "1"], e.deps);
    assert.equal(r.code, 0, r.err + r.out);
    states.push(loadFidelity(e.out).pending["pa/m0"]);
  }
  assert.deepEqual(states.map((x) => [x.r, x.rn, x.n]), [["optional-flaky", 1, 1], ["optional-flaky", 2, 2], ["optional-flaky", 3, 3]], "the same reason in a row: rn counts, never a not-run");
  assert.equal(states[2].since, day(0).toISOString());
  assert.match(states[2].why, /boom upstream/);
  e.deps.now = () => day(3);
  const dry = await runRaw([], e.deps);
  assert.match(dry.out, /RECOVERABLE 1 of 1 \(optional-flaky 1; of which STUCK 1 \(optional-flaky 1;/);
  assert.match(dry.out, /stuck on pa: "boom upstream"/);
  open = true;
  e.deps.now = () => day(4);
  await runRaw(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["pa/m0"], undefined, "the level ran: the marker is gone");
  assert.equal(st.models["pa/m0"].sp, "p");
});

// ---------------------------------------------------------------- 5: stuck sentences are the last to go; the report says what was stripped

test("round 3 / 5: under the size cap the sentences of NON-stuck models go first, a stuck model's sentence last; the run summary says how many were stripped", async () => {
  const at = (i) => new Date(NOW.getTime() + i * 1000).toISOString();
  const words = "the provider says wait and try again later ".repeat(4).slice(0, 100);
  const pending = {
    "fa/s1": { r: "error", n: 5, rn: 5, at: at(0), why: words }, "fa/s2": { r: "timeout", n: 4, rn: 4, at: at(1), why: words },     // stuck, the OLDEST
    "fa/n1": { r: "rate", n: 1, rn: 1, at: at(2), why: words }, "fa/n2": { r: "error", n: 1, rn: 1, at: at(3), why: words }, "fa/n3": { r: "quota", n: 2, rn: 2, at: at(4), why: words },
  };
  const models = { "fa/m": record("ppnn") };
  const full = Buffer.byteLength(renderFile(Object.entries(models), NOW, pending, null));
  const r = capRecords(models, { now: NOW, maxBytes: full - 250, pending });
  assert.equal(r.whyStripped, 3, "three sentences of about 110 bytes");
  assert.deepEqual(["fa/n1", "fa/n2", "fa/n3"].map((k) => r.pending[k].why), [undefined, undefined, undefined], "the non-stuck went first although they are newer");
  assert.ok(r.pending["fa/s1"].why && r.pending["fa/s2"].why, "the stuck models keep theirs");
  const more = capRecords(models, { now: NOW, maxBytes: full - 450, pending });
  assert.equal(more.whyStripped, 5, "when the non-stuck are not enough, the stuck follow, oldest first");
  // through a live run: the summary line
  const e = cliEnv([many("pa", 1)]);
  saveFidelity(e.out, {}, { now: NOW, pending: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`pz/p${i}`, { r: "rate", n: 1, at: at(i), why: words }])) });
  e.deps.snapshot.snap.rows.push({ provider: "pz", keyId: "k.pz.free", models: Array.from({ length: 40 }, (_, i) => m(`p${i}`)) });
  const keepKeys = Object.keys(loadFidelity(e.out).pending);
  const stripped = Object.fromEntries(keepKeys.map((k) => [k, { r: "rate", n: 1, at: at(0) }]));
  const cap = Buffer.byteLength(renderFile([], NOW, stripped, null)) + 1200;
  e.deps.saveImpl = (file, mods, opts) => saveFidelity(file, mods, { ...opts, maxBytes: cap });
  e.deps.bench = { get: (k) => (k.startsWith("pa/") || k.startsWith("pz/") ? { s: "ok", t: 400, a: 1790699779 } : null) };
  e.deps.tiers.pz = "free";
  const live = await run(["--live", "--only", "pa", "--per-provider", "1"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /NOTE: the file's size cap stripped the provider's sentence \(why\) from \d+ pending entries \(oldest first, the sentences of stuck models last\) before any record was dropped/);
});

// ---------------------------------------------------------------- 6: the suite cannot hang

test("round 3 / 6: the sweep seam bounds the wake timer: a wake the engine failed to arm (a pause that ends between its launch pass and its wake reading) costs at most 50 ms, never the 150-minute backstop", async () => {
  const fired = await new Promise((resolve) => { const t0 = Date.now(); SWEEP_FAST.timers.set(() => resolve(Date.now() - t0), 9000000); });
  assert.ok(fired < 1000, `${fired} ms`);
  // an engine run with a controlled clock and the backstop armed, as the CLI arms it: it finishes
  let c = 0, calls = 0;
  const probe = async () => (++calls === 1 ? { s: "rate" } : { s: "ok" });
  const groups = new Map([["pa", [{ key: "pa/m", provider: "pa", id: "m", free: true, cost: 0, worst: 0 }]]]);
  let wd;
  const done = await Promise.race([
    runSweep({ groups, probe, now: () => ++c, backoffBaseMs: 3, backoffMaxMs: 3, coolGapMs: 1, maxMs: 150 * 60000, timers: SWEEP_FAST.timers, concurrency: 1, perProvider: 1 }),
    new Promise((_, reject) => { wd = setTimeout(() => reject(new Error("the sweep engine hung")), 5000); }),
  ]).finally(() => clearTimeout(wd));
  assert.equal(calls, 2);
  assert.equal(done.counts.ok, 1);
});

// ================================================================ round 3 addendum: saturation is DIMINISHING RETURNS

const SC = "a1b2c3d4e5f60718";
const entry = (newTested, asked, { deepened = 0, testedTotal = 950, rateShare = 0, scope = SC, recoverable = 100 } = {}) => ({ at: NOW.toISOString(), scope, asked, newTested, deepened, rateShare, testedTotal, recoverable });
// feed a series of runs through the rule, one by one, the way the loop meets them: [[saturated, reason], ...]
function series(runs, opts = {}) {
  const hist = [], out = [];
  for (const e of runs) {
    const r = saturation({ requests: 100, rate: 0, failing: 0, newResults: Math.max(1, e.newTested), recoverable: 100, history: [...hist], thisRun: e, ...opts });
    out.push([r.saturated, r.reason]);
    hist.push(e);
  }
  return out;
}
const parseLine = (line) => Object.fromEntries(line.replace(/^SATURATION /, "").split(" ").map((kv) => kv.split("=")));

test("diminishing returns (pure): the tested total converges, each loop adds little: +40 of 950, then +9, then +4 -> no, no, yes", () => {
  assert.deepEqual(series([entry(40, 300), entry(9, 280), entry(4, 260)]), [[false, null], [false, null], [true, "diminishing"]]);
  const last = saturation({ requests: 100, newResults: 4, recoverable: 100, history: [entry(40, 300), entry(9, 280)], thisRun: entry(4, 260) });
  assert.match(last.why, /diminishing returns over the last 2 run\(s\): newly tested \+9, \+4 of 950\/950 tested \(each under 1%\), and \(new \+ deepened\) of the models asked 3.2%, 1.5% \(each under 5%\)/);
});

test("diminishing returns (pure): a big series never says yes; steady cap-rotation gains stay no; a low gain with a high yield per model asked stays no", () => {
  assert.deepEqual(series([entry(60, 300), entry(55, 300), entry(70, 300), entry(65, 300), entry(80, 300)]).map((x) => x[0]), [false, false, false, false, false]);
  assert.deepEqual(series(Array.from({ length: 6 }, () => entry(30, 300))).map((x) => x[0]), Array(6).fill(false), "3.2% of the tested total each run, steadily: a cap that rotates through the models");
  assert.deepEqual(series([entry(5, 20), entry(5, 20), entry(5, 20)]).map((x) => x[0]), [false, false, false], "0.5% of 950 is little, but 5 of the 20 models asked is a 25% yield");
  assert.deepEqual(series([entry(3, 300), entry(3, 300)]).map((x) => x[1]), [null, "diminishing"], "0.3% and 1% yield: little");
});

test("diminishing returns (pure): deepened models count toward the yield; --saturate-runs, --saturate-gain and --saturate-yield move the thresholds", () => {
  assert.deepEqual(series([entry(2, 100, { deepened: 20 }), entry(2, 100, { deepened: 20 })]).map((x) => x[0]), [false, false], "2 new + 20 deepened of 100 asked is a 22% yield");
  assert.deepEqual(series([entry(2, 100, { deepened: 1 }), entry(2, 100, { deepened: 1 })]).map((x) => x[1]), [null, "diminishing"], "3% yield");
  const three = [entry(3, 300), entry(3, 300), entry(3, 300)];
  assert.deepEqual(series(three, { runs: 3 }).map((x) => x[1]), [null, null, "diminishing"], "three runs in a row when asked for three");
  assert.deepEqual(series(three, { runs: 1 }).map((x) => x[1]), ["diminishing", "diminishing", "diminishing"], "one run is enough when asked for one");
  assert.deepEqual(series([entry(15, 600), entry(15, 600)], { gain: 2 }).map((x) => x[1]), [null, "diminishing"], "1.6% of 950 is under a 2% gain threshold");
  assert.deepEqual(series([entry(15, 600), entry(15, 600)]).map((x) => x[1]), [null, null], "and over the default 1%");
  assert.deepEqual(series([entry(3, 40), entry(3, 40)], { yieldPct: 10 }).map((x) => x[1]), [null, "diminishing"], "7.5% yield is under a 10% yield threshold");
  assert.equal(diminishingReturns({ history: [], thisRun: entry(1, 100), runs: 2 }), null, "fewer entries than runs: not saturated");
  assert.equal(diminishingReturns({ history: null, thisRun: entry(1, 100), runs: 1 }), null, "a run that is not recorded has no history to compare");
  assert.equal(diminishingReturns({ history: [], thisRun: entry(0, 100, { testedTotal: 0 }), runs: 1 }), null, "no tested total: nothing has converged");
});

test("saturation reasons come in a fixed order: done, zero-new, failing, diminishing, then the no-shrink fallback only while the scope has no history", () => {
  const base = { requests: 100, rate: 0, failing: 0, newResults: 5, recoverable: 10, history: [entry(1, 300)], thisRun: entry(1, 300) };
  assert.equal(saturation({ ...base, recoverable: 0 }).reason, "done");
  assert.equal(saturation({ ...base, newResults: 0 }).reason, "zero-new");
  assert.equal(saturation({ ...base, failing: 85, rate: 85 }).reason, "failing");
  assert.equal(saturation(base).reason, "diminishing");
  assert.equal(saturation({ ...base, history: [] , prevRecoverable: 10 }).reason, "no-shrink", "no history for the scope: the fallback");
  assert.equal(saturation({ ...base, history: [entry(40, 300)], prevRecoverable: 10 }).reason, null, "with history the fallback is not used");
  assert.equal(saturation({ ...base, history: null, thisRun: null, prevRecoverable: null }).reason, null, "a run that is not recorded: only done, zero-new and failing apply");
});

test("the next action: rate-limited share >= 50% -> resume later; otherwise converged (stuck, review them); the trend line names its denominators", () => {
  const v = { recoverable: 120, hard: 3 };
  const hist = [entry(52, 300), entry(14, 280), entry(6, 260)];
  const rl = saturation({ requests: 100, rate: 60, failing: 60, newResults: 4, recoverable: 120, history: [entry(1, 300)], thisRun: entry(1, 300, { rateShare: 0.6 }) });
  assert.equal(rl.reason, "diminishing");
  const textA = saturationLines(v, rl, null, { history: [entry(1, 300), entry(1, 300)] }).join("\n");
  assert.match(textA, /next: resume later when rate limits clear \(120 recoverable model\(s\); 60% of this run's 100 request\(s\) were rate-limited or over quota\)/);
  const cv = saturation({ requests: 100, rate: 10, failing: 10, newResults: 4, recoverable: 120, history: [entry(1, 300)], thisRun: entry(1, 300) });
  const textB = saturationLines(v, cv, null, { history: [entry(1, 300), entry(1, 300)] }).join("\n");
  assert.match(textB, /next: converged: the 120 remaining recoverable model\(s\) are stuck \(error\/timeout\/quota\/optional-flaky\); a re-run is unlikely to change them, review them/);
  const fl = saturation({ requests: 100, rate: 90, failing: 90, newResults: 4, recoverable: 120 });
  assert.equal(fl.reason, "failing");
  assert.match(saturationLines(v, fl, null, {}).join("\n"), /next: resume later when rate limits clear \(120 recoverable model\(s\); 90%/);
  assert.equal(trendLine(hist), "last runs: +52, +14, +6 newly tested (of 950 tested now; 5.5% 1.5% 0.6% of each run's own tested total), asked 300/280/260 model(s), deepened 0/0/0");
  assert.equal(trendLine([]), null);
  // not saturated or done: no next action
  assert.doesNotMatch(saturationLines(v, saturation({ requests: 10, newResults: 5, recoverable: 120 }), null, {}).join("\n"), /next:/);
});

test("the SATURATION line is parseable: the fields come in a fixed order and the reason is last", () => {
  const v = { recoverable: 7, hard: 2 };
  const lines = [saturationLines(v, saturation({ requests: 50, newResults: 3, recoverable: 7, history: [entry(1, 300)], thisRun: entry(1, 300) }), null, {}).at(-1),
    saturationLines(v, saturation({ requests: 50, newResults: 3, recoverable: 7 }), null, {}).at(-1), saturationLines(v, null).at(-1), saturationLines({ recoverable: 0, hard: 2 }, null).at(-1),
    saturationLines(v, null, "none").at(-1), saturationLines(v, null, "aborted").at(-1), saturationLines({ recoverable: 0, hard: 0 }, null, "none").at(-1)];
  for (const l of lines) assert.deepEqual(Object.keys(parseLine(l)), ["saturated", "recoverable", "hard", "new_results", "requests", "reason"], l);
  assert.deepEqual(lines.map((l) => [parseLine(l).saturated, parseLine(l).reason]), [["yes", "diminishing"], ["no", "none"], ["unknown", "unknown"], ["yes", "done"], ["yes", "scope-exhausted"], ["unknown", "unknown"], ["yes", "done"]]);
});

test("the flags --saturate-gain, --saturate-yield and --saturate-runs are validated: percents above 0 up to 100, runs a whole number from 1 to 5; the defaults are 1%, 5% and 2", () => {
  const d = parseArgs([]);
  assert.deepEqual([d.saturateGain, d.saturateYield, d.saturateRuns], [1, 5, 2]);
  const ok = parseArgs(["--saturate-gain", "2.5", "--saturate-yield", "10", "--saturate-runs", "3"]);
  assert.deepEqual([ok.saturateGain, ok.saturateYield, ok.saturateRuns], [2.5, 10, 3]);
  assert.equal(parseArgs(["--saturate-gain", "100"]).saturateGain, 100);
  assert.equal(parseArgs(["--saturate-runs", "5"]).saturateRuns, 5);
  for (const bad of [["--saturate-gain", "0"], ["--saturate-gain", "-1"], ["--saturate-gain", "101"], ["--saturate-gain", "x"], ["--saturate-yield", "0"], ["--saturate-yield", "150"], ["--saturate-runs", "0"], ["--saturate-runs", "6"], ["--saturate-runs", "1.5"], ["--saturate-runs", "-2"], ["--saturate-gain"]]) {
    assert.ok(parseArgs(bad).error, bad.join(" "));
  }
});

test("meta.history: cleanMeta keeps at most the last 12 well-formed runs and drops the malformed ones; an old meta without history reads as no history; it survives save and load", () => {
  const good = (i) => entry(i, 100, { rateShare: 0.123456 });
  const m = cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), history: Array.from({ length: 14 }, (_, i) => good(i + 1)) });
  assert.deepEqual(m.history.map((h) => h.newTested), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], "the last twelve");
  assert.equal(m.history[0].rateShare, 0.123, "rounded");
  const junk = [null, "x", [], { ...good(1), scope: "ZZZ" }, { ...good(1), at: "nope" }, { ...good(1), asked: -1 }, { ...good(1), newTested: 1.5 }, { ...good(1), rateShare: 2 }, { ...good(1), rateShare: "0.1" }, { at: NOW.toISOString() }, good(9)];
  assert.deepEqual(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), history: junk }).history.map((h) => h.newTested), [9], "only the well-formed one");
  assert.deepEqual(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString() }), { recoverable: 3, scope: SC, at: NOW.toISOString() }, "an old meta: no history key");
  for (const notAnArray of ["x", 5, { a: 1 }, null]) assert.equal(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), history: notAnArray }).history, undefined);
  assert.equal(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), history: junk.slice(0, 5) }).history, undefined, "nothing valid left: no key");
  const d = freshDir(), file = path.join(d, FILE_NAME);
  saveFidelity(file, { "fa/a": record("ppnn") }, { now: NOW, meta: { recoverable: 3, scope: SC, at: NOW.toISOString(), history: [good(1), good(2)] } });
  assert.deepEqual(loadFidelity(file).meta.history.map((h) => h.newTested), [1, 2]);
  assert.ok(Buffer.byteLength(JSON.stringify(cleanMeta({ recoverable: 3, scope: SC, at: NOW.toISOString(), history: Array.from({ length: 5 }, (_, i) => good(i)) }))) < 1200, "small");
});

test("runGain (pure): newly tested = not tested before, tested now (x included); a first strike is not tested, resolving one is; a partial record IS counted (its L1+L2 verdicts); deepened = a tested model that gained a level the run asked for", () => {
  const before = { "a/strike": record("fnnn", { strikes: 1, sl: 1 }), "a/tested": record("ppnn"), "a/deep": record("pppn", { sp: "p", er: "p" }), "a/same": record("ppnn", { sp: "p", er: "p" }) };
  const after = {
    ...before,
    "a/new": record("ppnn", { sp: "p", er: "p" }),                  // never tested: newly tested
    "a/newx": record("ffnn", { strikes: 2, sl: 1 }),                // a confirmed failure is tested too
    "a/newstrike": record("fnnn", { strikes: 1, sl: 1 }),           // a provisional first strike is not
    "a/strike": record("ffnn", { strikes: 2, sl: 1 }),              // resolving a strike IS
    "a/part": record("ppnn", { sp: "p", er: "p" }),                 // saved as a partial record (stopped at a later level): its L1+L2 verdicts make it tested
    "a/tested": record("ppnn", { sp: "p", er: "p" }),               // gained spawn and the error result
    "a/deep": record("pppn", { sp: "p", er: "p", big: "p" }),       // gained the big step
  };
  assert.deepEqual(runGain(before, after, { levels: [1, 2, 6, 7] }), { newTested: 4, deepened: 1 }, "levels 1,2,6,7: new, newx, part, strike resolved; a/tested gained 6 and 7; a/deep gained only 5, which was not asked");
  assert.deepEqual(runGain(before, after, { levels: [1, 2, 5, 6, 7] }), { newTested: 4, deepened: 2 }, "asked for 5 too: a/deep counts");
  assert.deepEqual(runGain(before, before, { levels: [1, 2, 6, 7] }), { newTested: 0, deepened: 0 });
  assert.ok(testedState(record("ppnn")) && !testedState(record("fnnn", { strikes: 1, sl: 1 })) && !testedState(undefined) && testedState(record("ffnn", { strikes: 2, sl: 1 })));
});

// ---------------------------------------------------------------- the CLI: history, scope, lifts

function bigWorld({ testedN = 200, fresh = 41 } = {}) {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: testedN }, (_, i) => m(`t${i}`)) }, { provider: "pb", keyId: "k.pb.free", models: Array.from({ length: fresh }, (_, i) => m(`n${i}`)) }];
  const store = Object.fromEntries(Array.from({ length: testedN }, (_, i) => [`pa/t${i}`, record("ppnn", { sp: "p", er: "p" })]));
  const bad = http(400, "tools.0.input_schema: unsupported keyword anyOf");
  return cliEnv(rows, { store, answer: (c) => (c.body.model === "pb/n0" || c.body.model.startsWith("pa/") ? goodModel(c) : bad) });
}
const BIG = ["--live", "--saturate-gain", "2", "--per-provider", "2", "--tf-max-tokens-per-provider", "1000000"];
function seedHistory(e, history, scopeArgv = BIG) {
  const cur = loadFidelity(e.out);
  saveFidelity(e.out, cur.models, { now: NOW, pending: cur.pending, held: cur.held, meta: { recoverable: 40, scope: scopeOf(parseArgs(scopeArgv)), at: hoursAgo(5), ...(history.length ? { history } : {}) } });
}
const hist1 = (over = {}) => entry(1, 50, { testedTotal: 200, recoverable: 40, scope: scopeOf(parseArgs(BIG)), ...over });

test("CLI: a second low-yield run of the same scope is saturated by diminishing returns (converged text, trend line, history of two); the same run without that history is not", async () => {
  const e = bigWorld();
  seedHistory(e, [hist1()]);
  const r = await runRaw(BIG, e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /RECOVERABLE 40 of 241 \(first-strike 40\)/);
  const line = parseLine(r.lines.at(-1));
  assert.deepEqual([line.saturated, line.reason, line.recoverable, line.new_results], ["yes", "diminishing", "40", "41"]);
  assert.match(r.out, /saturated: yes \(diminishing returns over the last 2 run\(s\): newly tested \+1, \+1 of 200\/201 tested \(each under 2%\), and \(new \+ deepened\) of the models asked 2%, 2.4% \(each under 5%\)\)/);
  assert.match(r.out, /next: converged: the 40 remaining recoverable model\(s\) are stuck/);
  assert.match(r.out, /last runs: \+1, \+1 newly tested \(of 201 tested now; 0.5% 0.5% of each run's own tested total\), asked 50\/41 model\(s\), deepened 0\/0/);
  const meta = loadFidelity(e.out).meta;
  assert.deepEqual(meta.history.map((h) => [h.asked, h.newTested, h.deepened, h.testedTotal, h.recoverable]), [[50, 1, 0, 200, 40], [41, 1, 0, 201, 40]]);
  // no history: the same run is not saturated (nothing to compare with)
  const e2 = bigWorld();
  const r2 = await runRaw(BIG, e2.deps);
  const l2 = parseLine(r2.lines.at(-1));
  assert.deepEqual([l2.saturated, l2.reason], ["no", "none"]);
  assert.equal(loadFidelity(e2.out).meta.history.length, 1, "and this run starts the history");
  // with the default gain of 1% the same run (0.5%) is also low: it takes the second run to say yes
  const e3 = bigWorld();
  seedHistory(e3, [hist1()]);
  assert.equal(parseLine((await runRaw(["--live", "--per-provider", "2", "--tf-max-tokens-per-provider", "1000000"], e3.deps)).lines.at(-1)).reason, "diminishing", "the default gain of 1% also holds (0.5%); the thresholds are not part of the scope, so the seeded history counts");
});

test("CLI: a run of ANOTHER scope starts a fresh comparison: history of a different scope is not compared (and is kept, for its own loop)", async () => {
  const e = bigWorld();
  seedHistory(e, [hist1({ scope: scopeOf(parseArgs(["--only", "pa"])) }), hist1({ scope: scopeOf(parseArgs(["--only", "pa"])) })], ["--only", "pa"]);       // the meta itself is of the other scope too: the no-shrink fallback has nothing to compare with
  const r = await runRaw(BIG, e.deps);
  const l = parseLine(r.lines.at(-1));
  assert.deepEqual([l.saturated, l.reason], ["no", "none"], "two low runs of another scope do not count");
  const meta = loadFidelity(e.out).meta;
  assert.equal(meta.history.length, 3, "the other scope's two entries are kept; this run adds its own");
  assert.equal(meta.history.at(-1).scope, scopeOf(parseArgs(BIG)));
  assert.equal(historyOf(meta.history, scopeOf(parseArgs(BIG))).length, 1, "and only its own entry counts for this scope");
});

test("CLI: a lift, a named model, a forced or retried pass is not recorded and does not reset the history; --release-holds keeps it", async () => {
  const keep = (e) => loadFidelity(e.out).meta.history.map((h) => h.at);
  const e = bigWorld();
  seedHistory(e, [hist1()]);
  const before = keep(e);
  const lift = await runRaw([...BIG, "--retry-accounts"], e.deps);
  assert.notEqual(parseLine(lift.lines.at(-1)).reason, "diminishing", "a lift compares nothing");
  assert.deepEqual(keep(e), before, "--retry-accounts: not recorded, history untouched");
  const e2 = bigWorld();
  seedHistory(e2, [hist1()]);
  await runRaw([...BIG, "--recheck-hard", "pay"], e2.deps);
  assert.deepEqual(keep(e2), [hist1().at], "--recheck-hard: not recorded");
  const e3 = bigWorld();
  seedHistory(e3, [hist1()]);
  await runRaw([...BIG, "--force", "--only", "pb/n0"], e3.deps);
  assert.deepEqual(keep(e3), [hist1().at], "--force (a named model too): not recorded");
  // --release-holds keeps the history (it only breaks the old no-shrink comparison, which a history makes unnecessary)
  const e4 = bigWorld();
  const cur = loadFidelity(e4.out);
  saveFidelity(e4.out, cur.models, { now: NOW, held: { pz: { r: "pay", at: hoursAgo(1) } }, pending: {}, meta: { recoverable: 40, scope: scopeOf(parseArgs(BIG)), at: hoursAgo(5), history: [hist1()] } });
  const rel = await run(["--release-holds", "pz", "--live"], e4.deps);
  assert.equal(rel.code, 0, rel.err);
  assert.deepEqual(keep(e4), [hist1().at], "history kept");
  // ... but without a history it clears the meta, as before
  const e5 = bigWorld();
  saveFidelity(e5.out, loadFidelity(e5.out).models, { now: NOW, held: { pz: { r: "pay", at: hoursAgo(1) } }, pending: {}, meta: { recoverable: 40, scope: scopeOf(parseArgs(BIG)), at: hoursAgo(5) } });
  await run(["--release-holds", "pz", "--live"], e5.deps);
  assert.equal(loadFidelity(e5.out).meta, null);
});

test("CLI: a low-gain run that is mostly rate-limited says failing with the resume-later action; --saturate-runs 1 decides on one run; an interrupted run is not recorded", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 200 }, (_, i) => m(`t${i}`)) }, ...["pb", "pc", "pd", "pe", "pf", "pg"].map((p) => ({ provider: p, keyId: `k.${p}.free`, models: Array.from({ length: 12 }, (_, i) => m(`n${i}`)) }))];
  const store = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`pa/t${i}`, record("ppnn", { sp: "p", er: "p" })]));
  const e = cliEnv(rows, { store, answer: (c) => (c.body.model === "pb/n0" ? goodModel(c) : http(429, "slow down", { "retry-after": "0" })) });
  const r = await runRaw(["--live", "--per-provider", "1", "--tf-max-tokens-per-provider", "1000000"], e.deps);
  const l = parseLine(r.lines.at(-1));
  assert.deepEqual([l.saturated, l.reason], ["yes", "failing"], r.out);
  assert.match(r.out, /next: resume later when rate limits clear \(\d+ recoverable model\(s\); \d+% of this run's \d+ request\(s\) were rate-limited or over quota\)/);
  // one run is enough when asked for one (a low-gain run that is not mostly failing)
  const e2 = bigWorld();
  const one = await runRaw([...BIG, "--saturate-runs", "1"], e2.deps);
  assert.deepEqual([parseLine(one.lines.at(-1)).saturated, parseLine(one.lines.at(-1)).reason], ["yes", "diminishing"]);
  // an interrupted / stopped run is not recorded and says unknown
  const e3 = bigWorld();
  seedHistory(e3, [hist1()]);
  e3.deps.sweep = { ...SWEEP_FAST, maxMs: 1 };
  const slow = e3.deps.fetch;
  e3.deps.fetch = async (url, init) => { await new Promise((r2) => setTimeout(r2, 10)); return slow(url, init); };
  const part = await runRaw(BIG, e3.deps);
  assert.equal(parseLine(part.lines.at(-1)).saturated, "unknown");
  assert.deepEqual(loadFidelity(e3.out).meta.history.map((h) => h.at), [hist1().at], "a partial run adds nothing to the history");
});

test("CLI: the dry run shows the stored trend of the scope and a parseable line; a corrupt meta history is ignored and the no-shrink fallback still works", async () => {
  const e = bigWorld();
  seedHistory(e, [entry(40, 300, { testedTotal: 160, scope: scopeOf(parseArgs(BIG)), recoverable: 40 }), hist1()]);
  const dry = await runRaw(BIG.filter((x) => x !== "--live"), e.deps);
  assert.match(dry.out, /last runs: \+40, \+1 newly tested \(of 200 tested now; 25% 0.5% of each run's own tested total\), asked 300\/50 model\(s\)/);
  assert.deepEqual(Object.keys(parseLine(dry.lines.at(-1))), ["saturated", "recoverable", "hard", "new_results", "requests", "reason"]);
  // corrupt history in the file: ignored, and the old fallback applies (one run of the same scope, recoverable did not shrink)
  const e2 = bigWorld();
  const raw = JSON.parse(fs.readFileSync(e2.out, "utf8"));
  raw.meta = { recoverable: 40, scope: scopeOf(parseArgs(BIG)), at: hoursAgo(5), history: [{ at: "nope" }, 5, null] };
  fs.writeFileSync(e2.out, JSON.stringify(raw));
  assert.equal(loadFidelity(e2.out).meta.history, undefined);
  const r2 = await runRaw(BIG, e2.deps);
  const l2 = parseLine(r2.lines.at(-1));
  assert.deepEqual([l2.saturated, l2.reason], ["yes", "no-shrink"], "no usable history: the recoverable set (40) did not shrink against the previous run's 40");
  assert.match(r2.out, /fallback: this scope has no run history yet/);
});

// ================================================================ a model a PAUSED provider never asked is not a rate (or quota) answer

test("rate-paused (pure): a model the pause never let in keeps the reason of its last real ask; with none it becomes `rate-paused`, once, and the pause never grows n or rn", () => {
  const T0 = NOW.toISOString(), later = (d) => new Date(NOW.getTime() + d * DAY);
  const prev = {
    "p/rate": { r: "rate", n: 2, rn: 2, at: hoursAgo(30), since: hoursAgo(60), why: "slow down" }, "p/err": { r: "error", n: 4, rn: 4, at: hoursAgo(30), since: hoursAgo(90) },
    "p/cap": { r: "cap", n: 1, rn: 1, at: hoursAgo(30), since: hoursAgo(30) },
  };
  const step = (pending, day, reason = "rate-paused") => updatePending(pending, { queue: ["p/rate", "p/err", "p/cap", "p/new"].map((key) => ({ key })), recorded: new Set(), store: {}, now: later(day), reasonOf: () => reason });
  const one = step(prev, 0);
  assert.deepEqual(one["p/rate"], prev["p/rate"], "a rate answer from a real ask stays untouched: rn is not 3");
  assert.deepEqual(one["p/err"], prev["p/err"], "so does an error");
  assert.equal(one["p/cap"].r, "rate-paused", "a scheduling reason is replaced");
  assert.deepEqual([one["p/new"].r, one["p/new"].n, one["p/new"].rn], ["rate-paused", 1, 1]);
  const two = step(one, 1), three = step(two, 2);
  assert.deepEqual(three, one, "the pause again, and again: nothing changes (no new at, no n, no rn)");
  for (const k of ["p/cap", "p/new"]) assert.deepEqual([three[k].n, three[k].rn], [one[k].n, 1]);
  // the same for a quota pause
  const q = updatePending({ "p/rate": prev["p/rate"] }, { queue: [{ key: "p/rate" }, { key: "p/new" }], recorded: new Set(), store: {}, now: later(3), reasonOf: (k) => (k === "p/rate" ? "quota-paused" : "quota-paused") });
  assert.deepEqual(q["p/rate"], prev["p/rate"]);
  assert.deepEqual(updatePending(q, { queue: [{ key: "p/new" }], recorded: new Set(), store: {}, now: later(4), reasonOf: () => "quota-paused" })["p/new"], q["p/new"]);
  // a real ask after the pause starts counting from 1 for ITS reason
  const asked = updatePending(three, { queue: [{ key: "p/new" }], recorded: new Set(), store: {}, now: later(5), reasonOf: () => "rate" });
  assert.deepEqual([asked["p/new"].r, asked["p/new"].rn], ["rate", 1]);
  void T0;
  assert.ok(PAUSED_REASONS.has("rate-paused") && PAUSED_REASONS.has("quota-paused") && PAUSED_REASONS.size === 2);
});

test("rate-paused is never stuck, never a soft or hard reason of the policy funnel, and is counted as recoverable (not hard) in the verdict", () => {
  const pending = { "pa/a": { r: "rate-paused", n: 9, rn: 9, at: hoursAgo(1), since: hoursAgo(500) }, "pa/b": { r: "quota-paused", n: 9, rn: 9, at: hoursAgo(1) } };
  const v = sweepVerdict({ l12: coverage([{ key: "pa/a" }, { key: "pa/b" }], {}, { pending }), pending });
  assert.deepEqual([v.recoverable, v.hard, v.stuck], [2, 0, 0]);
  assert.deepEqual(v.byRecoverable, { "rate-paused": 1, "quota-paused": 1 });
  assert.ok(!STUCK_REASONS.has("rate-paused") && !TRIED_REASONS.has("rate-paused") && !OWNER_REASONS.has("rate-paused") && hardState("rate-paused", "pa") === null);
  // the funnel reads only the reasons it knows: the paused ones are in neither of its lists, so it ignores them
  assert.ok(!SWEEP_SOFT.includes("rate-paused") && !SWEEP_HARD.includes("rate-paused") && !SWEEP_SOFT.includes("quota-paused") && !SWEEP_HARD.includes("quota-paused"));
  assert.ok(SWEEP_SOFT.includes("rate") && SWEEP_SOFT.includes("quota"), "while the real rate and quota answers are soft demote reasons");
});

test("every skip reason of the sweep maps to what it says: a model a provider pause never asked gets a paused reason; the canary-* hard reasons stay as documented; nothing else is written for a model that was not asked", () => {
  const map = (w) => pendingReasonOf({ s: "skip", w });
  assert.deepEqual(["rate-paused", "quota-paused", "canary-pay", "canary-auth", "canary-gone", "spend-cap", "row-cost"].map(map), ["rate-paused", "quota-paused", "canary-pay", "canary-auth", "canary-gone", "spend", "row-cost"]);
  assert.equal(pendingReasonOf({ s: "rate" }), "rate", "a model that WAS asked and rate limited");
  assert.equal(pendingReasonOf({ s: "skip", w: "rate-paused" }) === pendingReasonOf({ s: "rate" }), false);
});

test("CLI: over three runs a provider that keeps rate limiting never makes a model that was only paused accrue rn, n or stuck; only the models it was really asked about count", async () => {
  const e = cliEnv([many("pa", 10)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  const day = (d) => new Date(NOW.getTime() + d * DAY);
  const seen = [];
  for (let d = 0; d < 3; d++) {
    e.deps.now = () => day(d);
    const r = await run(["--live", "--per-provider", "1"], e.deps);
    assert.equal(r.code === 0 || r.code === 3, true, r.err + r.out);
    seen.push(loadFidelity(e.out).pending);
  }
  const paused = (p) => Object.entries(p).filter(([, v]) => v.r === "rate-paused");
  assert.ok(paused(seen[0]).length > 0, "the pause left some models unasked");
  for (const p of seen) for (const [, v] of paused(p)) assert.deepEqual([v.n, v.rn], [1, 1], "a paused model never accrues");
  const asked = (p) => Object.entries(p).filter(([, v]) => v.r === "rate");
  assert.ok(asked(seen[2]).length > asked(seen[0]).length, "models rotate in: those really asked again keep counting");
  const dry = await runRaw(["--levels", "12"], e.deps);
  const stuckLine = dry.out.split("\n").find((l) => l.startsWith("sweep verdict"));
  assert.doesNotMatch(stuckLine, /STUCK/, "rate is not a stuck reason and the paused ones never count");
  assert.match(stuckLine, /rate-paused \d+/);
});

// ================================================================ round 4 (final review)

// ---------------------------------------------------------------- 1: a partial record's L1+L2 is newly tested

test("round 4 / 1: 100 fresh models given L1+L2 and stopped at L6 by a rate limit are 100 newly tested; two such runs are never 'diminishing'", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => many(`pq${i}`, 1));
  const e = cliEnv(rows, { answer: (c) => (["6", "2e"].includes(kindOf(c)) ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const argv = ["--live", "--tf-max-tokens-per-provider", "1000000"];
  const r1 = await runRaw(argv, e.deps);
  assert.equal(r1.code === 0 || r1.code === 3, true, r1.err);
  const h1 = loadFidelity(e.out).meta.history;
  assert.deepEqual([h1[0].asked, h1[0].newTested, h1[0].testedTotal], [100, 100, 100], "their L1+L2 verdicts made them tested");
  assert.notEqual(parseLine(r1.lines.at(-1)).reason, "diminishing");
  const r2 = await runRaw(argv, e.deps);
  const h2 = loadFidelity(e.out).meta.history;
  assert.deepEqual([h2.at(-1).newTested, h2.at(-1).testedTotal], [0, 100], "the second run adds nothing: they were tested already");
  assert.notEqual(parseLine(r2.lines.at(-1)).reason, "diminishing", "rate limits everywhere end it as zero-new, not as convergence");
  assert.equal(parseLine(r2.lines.at(-1)).reason, "zero-new");
  assert.deepEqual(series([entry(100, 100, { testedTotal: 100 }), entry(100, 100, { testedTotal: 200 })]).map((x) => x[0]), [false, false]);
});

// ---------------------------------------------------------------- 2: empty answers fail; a starved run is not converged

const sseT = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const thinkingOnly = () => ok(stream(sseT("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }) + sseT("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }) + sseT("content_block_stop", { type: "content_block_stop", index: 0 }), ev.stop("max_tokens", 100000)));

test("round 4 / 2: empty (thinking-only) answers count toward the failing share; when it fires and most asked models produced no record the run says STARVED, with the resume-later action, not 'converged'", async () => {
  const e = cliEnv([many("pa", 200)], { answer: (c) => (["pa/m0", "pa/m1", "pa/m2", "pa/m3", "pa/m4"].includes(c.body.model) ? goodModel(c) : thinkingOnly()) });
  const r = await runRaw(["--live", "--per-provider", "2", "--tf-max-tokens-per-provider", "5000000"], e.deps);
  assert.equal(r.code === 0 || r.code === 3, true, r.err);
  const l = parseLine(r.lines.at(-1));
  assert.deepEqual([l.saturated, l.reason, l.new_results], ["yes", "failing", "5"], r.out.slice(-1800));
  assert.match(r.out, /starved: 195 of 200 asked model\(s\) produced no record \(reasoning-budget 195\)/);
  assert.match(r.out, /next: resume later \(195 recoverable model\(s\)\): most asked models got no usable answer/);
  assert.doesNotMatch(r.out, /converged/);
  assert.match(r.out, /ended rate, error, timeout, quota or empty \(a thinking-only answer\)/);
});

test("round 4 / 2 (pure): diminishing with asked 200, newTested 5 twice and mostly no record: starved text and resume later; with most asked models recorded: converged", () => {
  const v = { recoverable: 150, hard: 0 };
  const hist = [entry(5, 200, { testedTotal: 1000 })], now2 = entry(5, 200, { testedTotal: 1005 });
  const sat = saturation({ requests: 400, rate: 0, failing: 100, newResults: 5, recoverable: 150, history: hist, thisRun: now2 });
  assert.equal(sat.reason, "diminishing");
  const starved = saturationLines(v, sat, null, { history: [...hist, now2], starved: { asked: 200, noRecord: 195, reasons: { empty: 120, "reasoning-budget": 60, rate: 15 } } }).join("\n");
  assert.match(starved, /starved: 195 of 200 asked model\(s\) produced no record \(empty 120, reasoning-budget 60, rate 15\)/);
  assert.match(starved, /next: resume later \(150 recoverable model\(s\)\)/);
  assert.doesNotMatch(starved, /converged/);
  const fine = saturationLines(v, sat, null, { history: [...hist, now2], starved: { asked: 200, noRecord: 60, reasons: { error: 60 } } }).join("\n");
  assert.match(fine, /next: converged: the 150 remaining/);
  assert.doesNotMatch(fine, /starved:/);
  assert.doesNotMatch(saturationLines(v, sat, null, { history: [now2] }).join("\n"), /starved:/, "no data: no claim");
});

// ---------------------------------------------------------------- 3: the history is written unfiltered, capped per scope and overall

test("round 4 / 3: appendHistory keeps at most 5 entries per scope and 12 in all, in order; alternating loops of two scopes each reach diminishing on their own series", () => {
  const A = "aaaaaa111111", B = "bbbbbb222222", C = "cccccc333333";
  let h = [];
  for (let i = 0; i < 30; i++) h = appendHistory(h, entry(i, 100, { scope: i % 2 ? A : B }));
  assert.ok(h.length <= 12, String(h.length));
  assert.equal(historyOf(h, A).length, 5);
  assert.equal(historyOf(h, B).length, 5);
  assert.deepEqual(h.map((x) => x.newTested), [...h.map((x) => x.newTested)].sort((a, b) => a - b), "order kept");
  h = [];
  for (let i = 0; i < 20; i++) h = appendHistory(h, entry(i, 100, { scope: [A, B, C][i % 3] }));
  assert.ok(h.length <= 12 && h.at(-1).newTested === 19, "the newest is always kept");
  assert.deepEqual(appendHistory(null, entry(1, 10)).map((x) => x.newTested), [1]);
  let hist = [];
  const verdicts = [];
  for (const [scope, e] of [[A, entry(3, 300, { scope: A })], [B, entry(2, 300, { scope: B })], [A, entry(2, 300, { scope: A })], [B, entry(1, 300, { scope: B })], [A, entry(1, 300, { scope: A })]]) {
    const r = saturation({ requests: 100, newResults: 2, recoverable: 50, history: historyOf(hist, scope), thisRun: e });
    verdicts.push([scope === A ? "A" : "B", r.reason]);
    hist = appendHistory(hist, e);
  }
  assert.deepEqual(verdicts, [["A", null], ["B", null], ["A", "diminishing"], ["B", "diminishing"], ["A", "diminishing"]], "each scope compares only with its own runs");
});

test("round 4 / 3: through the CLI a run of one scope does not disturb the other scope's history, and each scope's second low run is diminishing", async () => {
  const A = BIG, B = [...BIG, "--only", "pa,pb"];
  for (const [run1, other] of [[A, B], [B, A]]) {
    const e = bigWorld();
    const cur = loadFidelity(e.out);
    const hA = hist1({ scope: scopeOf(parseArgs(A)) }), hB = entry(1, 77, { testedTotal: 200, recoverable: 40, scope: scopeOf(parseArgs(B)) });
    saveFidelity(e.out, cur.models, { now: NOW, meta: { recoverable: 40, scope: scopeOf(parseArgs(other)), at: hoursAgo(5), history: [hA, hB] } });
    const r = await runRaw(run1, e.deps);
    assert.equal(parseLine(r.lines.at(-1)).reason, "diminishing", r.out.slice(-600));
    const meta = loadFidelity(e.out).meta;
    assert.equal(meta.history.length, 3);
    assert.deepEqual(historyOf(meta.history, scopeOf(parseArgs(other))).map((x) => x.asked), [run1 === A ? 77 : 50], "the other scope's entry is untouched");
  }
});

// ---------------------------------------------------------------- 4: a 400 auth sentence is anchored and is evidence about the model only

test("round 4 / 4: the auth sentence is anchored to the start of the message and must be its whole subject: schema sentences that contain the words do not read as auth", async () => {
  for (const [status, msg] of [[400, "tool_choice: missing credentials field in tool schema"], [400, "authentication required for tool x"], [400, "Missing credentials field in tool schema"], [400, "tools.0: invalid credentials schema"], [400, "unauthorized_tool_name must match ^[a-z_]+$"],
    [422, "tools.2.input_schema: expected an api key property"], [400, "Invalid parameter: the API key field is missing in the request body schema"], [400, "tool x: unknown key in properties"],
    [400, "tools.0.input_schema: invalid credentials"], [400, "Schema error: Unauthorized"], [400, "Request failed validation: missing api key"]]) {
    assert.notEqual((await kindRes(status, msg)).s, "auth", `${status}: ${msg}`);
  }
  for (const [status, msg] of [[400, "Invalid API key provided."], [400, "Incorrect API key"], [400, "Unauthorized"], [422, "Invalid API key provided: sk-xxxx"], [400, "Error: Invalid API key"], [400, "Authentication failed."], [401, "Invalid API key provided."], [403, "Unauthorized"], [401, "tool_choice: missing credentials field"]]) {
    assert.equal((await kindRes(status, msg)).s, "auth", `${status}: ${msg}`);
  }
});

test("round 4 / 4: a 400 auth sentence is evidence about THAT MODEL: one model alone holds nothing, two distinct models hold the provider; a 401 still holds it at the first answer", async () => {
  const bad400 = () => http(400, "Invalid API key provided.");
  const one = cliEnv([many("pa", 1)], { answer: bad400 });
  await run(["--live", "--per-provider", "1"], one.deps);
  const s1 = loadFidelity(one.out);
  assert.deepEqual(s1.held, {}, "one model's 400: no provider hold");
  assert.equal(s1.pending["pa/m0"].r, "auth", "but that model is auth-blocked");
  const two = cliEnv([many("pa", 4)], { answer: bad400 });
  await run(["--live", "--per-provider", "1"], two.deps);
  assert.equal(calls(two.f).length, 2, "two distinct models asked, then the provider is held");
  const s2 = loadFidelity(two.out);
  assert.equal(s2.held.pa.r, "auth");
  assert.deepEqual([s2.pending["pa/m2"].r, s2.pending["pa/m3"].r], ["canary-auth", "canary-auth"]);
  const mixed = cliEnv([many("pa", 3)], { answer: (c) => (c.body.model === "pa/m0" ? bad400() : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], mixed.deps);
  const s3 = loadFidelity(mixed.out);
  assert.deepEqual(s3.held, {}, "the provider answered for the other models: no hold");
  assert.equal(s3.pending["pa/m0"].r, "auth");
  const k401 = cliEnv([many("pa", 4)], { answer: () => http(401, "Invalid API key provided.") });
  await run(["--live", "--per-provider", "1"], k401.deps);
  assert.equal(calls(k401.f).length, 1, "a 401 holds the provider at the first answer");
  assert.equal(loadFidelity(k401.out).held.pa.r, "auth");
});

// ---------------------------------------------------------------- 5: how many of the recoverable and hard-blocked are already tested at L1+L2

test("round 4 / 5: the verdict says how many of the RECOVERABLE and of the HARD-BLOCKED models are tested at L1+L2, each with its denominator", async () => {
  const rows = [many("pa", 5), many("pb", 3)];
  const store = { "pa/m0": record("ppnn"), "pa/m1": record("ppnn"), "pa/m2": record("ppnn"), "pb/m0": record("ppnn") };
  const e = cliEnv(rows, { store, held: { pb: { r: "auth", at: hoursAgo(1) } } });
  const r = await runRaw([], e.deps);
  assert.match(r.out, /RECOVERABLE 5 of 8 \(/);
  assert.match(r.out, /HARD-BLOCKED 3 of 8 \(auth 3;/);
  assert.match(r.out, /of which tested at L1\+L2 \(a record with both verdicts\): RECOVERABLE 3 of 5, HARD-BLOCKED 1 of 3/);
  const none = cliEnv([many("pa", 1)], { store: { "pa/m0": record("ppnn", { sp: "p", er: "p" }) } });
  assert.doesNotMatch((await runRaw([], none.deps)).out, /of which tested at L1\+L2/, "nothing recoverable or hard: nothing to split");
});

// ---------------------------------------------------------------- 6: a queue with nothing counted recoverable is not 'done'

test("round 4 / 6: a dry run with a queue but nothing recoverable (--force) is saturated=unknown reason=queued, never done", async () => {
  const store = Object.fromEntries([0, 1, 2].map((i) => [`pa/m${i}`, record("ppnn", { sp: "p", er: "p" })]));
  const e = cliEnv([many("pa", 3)], { store });
  const plain = await runRaw([], e.deps);
  assert.match(plain.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0 reason=done$/);
  const forced = await runRaw(["--force"], e.deps);
  assert.match(forced.out, /this run: 3 model\(s\) queued of 3/);
  assert.match(forced.lines.at(-1), /^SATURATION saturated=unknown recoverable=0 hard=0 new_results=0 requests=0 reason=queued$/);
  assert.match(forced.out, /nothing is counted recoverable but 3 model\(s\) are queued/);
  assert.equal(saturationLines({ recoverable: 0, hard: 0 }, null, "dry", { queued: 2 }).at(-1), "SATURATION saturated=unknown recoverable=0 hard=0 new_results=0 requests=0 reason=queued");
  assert.equal(saturationLines({ recoverable: 0, hard: 0 }, null, "dry", { queued: 0 }).at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0 reason=done");
});

// ================================================================ the spend ESTIMATE: an unlisted price on a free-labelled key is $0

test("spend estimate: a mixed fixture: unlisted on a free key $0, LISTED on a free key at its price, free-tagged $0, paid-LIFTED listed at its price and paid-lifted unlisted at the pessimistic fallback", () => {
  const rows = [
    { provider: "pa", keyId: "k.pa.free", models: [m("listed", { badge: "PAID", pin: 1, pout: 4 }), m("unlisted", { badge: null, pin: null, pout: null }), m("tagged")] },
    { provider: "pb", keyId: "k.pb.paid", models: [m("p1", { badge: "PAID", pin: 2, pout: 8 }), m("p2", { badge: null, pin: null, pout: null })] },
  ];
  const e = cliEnv(rows);
  const tiers = { pa: "free", pb: "paid" };
  const policy = { schema: 1, models: [{ s: "pa/listed", c: 256000 }], tiers };
  const argv = ["--candidates", "policy", "--include-tier", "paid", "--levels", "12", "--live", "--max-spend", "5", "--max-row-cost", "1"];
  const p = plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs(argv), policy, tiers, printed: true, nowMs: NOW.getTime() });
  assert.equal(p.lift.ok, true, "the paid tier is lifted");
  const by = Object.fromEntries(p.run.entries.map((x) => [x.key, x]));
  assert.deepEqual([by["pa/unlisted"].cost, by["pa/unlisted"].free, by["pa/unlisted"].unlistedOnFree], [0, true, true], "unlisted on a free-labelled key: $0");
  assert.equal(by["pa/tagged"].cost, 0);
  assert.equal(by["pa/listed"].pricedOnFree, true);
  assert.ok(Math.abs(by["pa/listed"].cost - (by["pa/listed"].tin * 1 + by["pa/listed"].tout * 4) / 1e6) < 1e-12 && by["pa/listed"].cost > 0, "listed on a free key: its listed price");
  assert.ok(Math.abs(by["pb/p1"].cost - (by["pb/p1"].tin * 2 + by["pb/p1"].tout * 8) / 1e6) < 1e-12, "paid, lifted, listed: its price");
  // the paid-lifted fallback is the HIGHEST listed paid price of the whole probe set (here 2 in, 8 out from pb/p1), unchanged
  assert.ok(Math.abs(by["pb/p2"].cost - (by["pb/p2"].tin * 2 + by["pb/p2"].tout * 8) / 1e6) < 1e-12 && by["pb/p2"].cost > 0, "paid, lifted, unlisted: the pessimistic fallback");
  assert.equal(p.run.paidModels, 3, "listed on the free key, and the two paid ones; the unlisted and the tagged on the free key are free");
  // the same models on a key that is NOT lifted do not change anything for the free key
  const plain = plan({ snap: { rows: [rows[0]] }, bench: e.deps.bench, store: {}, o: parseArgs(["--levels", "12"]), tiers: { pa: "free" }, nowMs: NOW.getTime() });
  assert.deepEqual(plain.run.entries.map((x) => [x.id, x.cost === 0]).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [["listed", false], ["tagged", true], ["unlisted", true]]);
});

test("spend estimate: a live --levels 6,7 over hundreds of models with no listed price is NOT refused at --max-spend 5 (it was charged at the highest listed price of the whole set); a listed price above the row ceiling still stays pending", async () => {
  const rows = [
    { provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 200 }, (_, i) => m(`u${i}`, { badge: null, pin: null, pout: null })) },
    { provider: "pb", keyId: "k.pb.free", models: [m("big", { badge: "PAID", pin: 500, pout: 500 })] },
  ];
  const store = Object.fromEntries([...Array.from({ length: 200 }, (_, i) => `pa/u${i}`), "pb/big"].map((k) => [k, record("ppnn")]));
  const e = cliEnv(rows, { store });
  const argv = ["--levels", "67", "--max-spend", "5", "--tf-max-tokens-per-provider", "10000000"];
  const p = plan({ snap: { rows }, bench: e.deps.bench, store, o: parseArgs(["--live", ...argv]), tiers: e.deps.tiers, nowMs: NOW.getTime() });
  assert.equal(p.kept.length, 201);
  assert.ok(p.run.usd < 5, `the estimate is ${p.run.usd}`);
  assert.equal(liveRefusal(parseArgs(["--live", ...argv]), p), null, "no refusal");
  const dry = await runRaw(argv, e.deps);
  assert.match(dry.out, /an unlisted price on a free-labelled key: \$0 \(200 model\(s\) of this run\)/);
  assert.match(dry.out, /priced-over-row-cap/, "the listed 500/500 model is over the $0.10 row ceiling at levels 6 and 7");
  const live = await runRaw(["--live", ...argv], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.equal(calls(e.f).some((c) => c.body.model === "pb/big"), false, "the over-ceiling model is not asked");
  assert.equal(calls(e.f).filter((c) => c.body.model.startsWith("pa/")).length, 400, "L6 and L7 for the 200 models with no listed price");
  assert.equal(loadFidelity(e.out).pending["pb/big"].r, "priced-over-row-cap");
  // and a paid-priced total that really is over the cap is still refused
  const pricey = plan({ snap: { rows }, bench: e.deps.bench, store, o: parseArgs(["--live", ...argv, "--max-row-cost", "100", "--max-spend", "0.05"]), tiers: e.deps.tiers, nowMs: NOW.getTime() });
  assert.match(liveRefusal(parseArgs(["--live", ...argv, "--max-row-cost", "100", "--max-spend", "0.05"]), pricey) ?? "", /is above the cap/);
});

// ---------------------------------------------------------------- label oddities

test("verdict labels: a model this run QUEUES is not projected as `cap`, a model that waits for the cap now is `cap`; the optional-gap breakdown says models and level gaps apart", async () => {
  const rows = [many("pa", 30)];
  const store = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pa/m${i}`, record("ppnn")]));
  const stale = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`pa/m${i}`, pend("cap", 4)]));
  const e = cliEnv(rows, { store, pending: stale });
  const run1 = (argv) => plan({ snap: { rows }, bench: e.deps.bench, store, o: parseArgs(argv), tiers: e.deps.tiers, pending: stale, nowMs: NOW.getTime() });
  const all = run1(["--levels", "67", "--tf-max-tokens-per-provider", "10000000"]);
  assert.deepEqual([all.kept.length, all.waiting.length], [30, 0], "the plan queues all 30 and nothing waits for the cap");
  assert.deepEqual(all.verdict.byRecoverable, { "optional-not-run": 30 }, "a stale cap from an earlier run is not projected onto models queued now");
  const some = run1(["--levels", "67", "--tf-max-tokens-per-provider", "5000"]);
  assert.ok(some.waiting.length > 0 && some.kept.length > 0);
  assert.deepEqual(some.verdict.byRecoverable, { "optional-not-run": some.kept.length, cap: some.waiting.length }, "the models that really wait for the cap are cap");
  const dry = await runRaw(["--levels", "67", "--tf-max-tokens-per-provider", "10000000"], e.deps);
  assert.match(dry.out, /RECOVERABLE 30 of 30 \(optional-not-run 30\)/);
  // a stale cap on an UNTESTED model that is queued now: not-run, not cap
  const fresh = plan({ snap: { rows: [many("pb", 3)] }, bench: cliEnv([many("pb", 3)]).deps.bench, store: {}, o: parseArgs(["--levels", "12"]), tiers: { pb: "free" }, pending: { "pb/m0": pend("cap", 2), "pb/m1": pend("rate", 2) }, nowMs: NOW.getTime() });
  assert.deepEqual(fresh.verdict.byRecoverable, { "not-run": 2, rate: 1 }, "m0 was cap, is queued now: not-run; m1's rate limit is still what it is up against");
  // the headline counts models, the breakdown counts level gaps: both are named
  const gaps = cliEnv([many("pa", 4)], { store: { "pa/m0": record("ppnn"), "pa/m1": record("ppnn", { sp: "p" }), "pa/m2": record("ppnn", { sp: "p", er: "p" }), "pa/m3": record("pppn", { sp: "p", er: "p", big: "p" }) } });
  const t = await runRaw(["--levels", "12"], gaps.deps);
  assert.match(t.out, /TESTED 4 of 4 \(complete for every level it is eligible for 1 of 4; tested but optional levels not run: 3 of 4 model\(s\), 4 level gap\(s\) \(a model can have more than one\): /);
  const sums = /level gap\(s\) \(a model can have more than one\): ([^)]*)\)/.exec(t.out)[1].split(", ").map((x) => Number(x.split(" ").at(-1)));
  assert.equal(sums.reduce((a, b) => a + b, 0), 4, "the breakdown adds up to the gaps it names");
});

// ================================================================ an HTTP 402 with an availability-only sentence is not a sticky pay

test("402 + an availability-only sentence ('anymodel: Upstream request failed.') is `upstream-unavailable` (soft); a money word, or any sentence that is not availability, keeps pay; other statuses are unchanged", async () => {
  const soft = async (status, msg) => { const r = await kindRes(status, msg); return [r.s, r.reason ?? null]; };
  for (const msg of ["anymodel: Upstream request failed.", "Upstream request failed.", "The selected model is temporarily unavailable. Try another model.", "Service unavailable, please retry", "upstream error"]) {
    assert.deepEqual(await soft(402, msg), ["error", "upstream-unavailable"], `402: ${msg}`);
  }
  for (const msg of ["Payment required", "Insufficient balance", "no credits", "Your wallet balance is insufficient. Recharge at [url]", "Upstream request failed. Please top up your account", "Upstream error: billing problem", "Your plan does not include this model", "Forbidden", "This model requires a subscription"]) {
    assert.deepEqual((await soft(402, msg))[0], "pay", `402: ${msg}`);
  }
  // the status is only softened at 402: the others read as before (the table the owner asked about)
  assert.deepEqual([await soft(401, "anymodel: Upstream request failed."), await soft(403, "anymodel: Upstream request failed."), await soft(404, "anymodel: Upstream request failed.")].map((x) => x[0]), ["auth", "auth", "gone"]);
  assert.deepEqual([await soft(400, "anymodel: Upstream request failed."), await soft(500, "anymodel: Upstream request failed."), await soft(429, "anymodel: Upstream request failed.")].map((x) => x[0]), ["error", "error", "rate"]);
  assert.equal(hasMoneyWords("Upstream request failed."), false);
  assert.equal(hasMoneyWords("Please top up"), true);
});

test("402 availability sentences in a live run: the models are pending upstream-unavailable (soft, asked again), no pay entry, no canary-pay and no hold, even when every model of the provider answers that way", async () => {
  const bad = () => http(402, "anymodel: Upstream request failed.");
  const all = cliEnv([many("anymodel", 5)], { answer: bad });
  const r = await run(["--live", "--per-provider", "1"], all.deps);
  const st = loadFidelity(all.out);
  assert.deepEqual(st.held, {}, "two models out of credit would hold a provider; an availability sentence is not that");
  assert.ok(Object.values(st.pending).length === 5 && Object.values(st.pending).every((x) => x.r === "upstream-unavailable"), JSON.stringify(Object.values(st.pending).map((x) => x.r)));
  assert.equal(calls(all.f).length, 5, "every model was asked: no pay pause");
  assert.match(r.out, /RECOVERABLE 5 of 5 \(upstream-unavailable 5\)/);
  assert.match(Object.values(st.pending)[0].why, /Upstream request failed/);
  // a real pay sentence still holds the provider on two models
  const pay = cliEnv([many("pb", 5)], { answer: () => http(402, "Payment required") });
  await run(["--live", "--per-provider", "1"], pay.deps);
  assert.equal(loadFidelity(pay.out).held.pb.r, "pay");
  // a normal run asks the unavailable ones again (soft); a pay one is not asked
  assert.equal(planOf(all, [], { store: {}, pending: st.pending }).queued.length, 5);
});

// ---------------------------------------------------------------- the migration

test("migrateAvailabilityPay (pure): pay entries whose stored sentence is availability-only and has no money word are dropped; no sentence, a money word, another reason, another kind of hard reason: untouched", () => {
  const e = (r, why, extra = {}) => ({ r, n: 12, at: hoursAgo(3), since: hoursAgo(3), rn: 1, ...(why ? { why } : {}), ...extra });
  const pending = {
    "anymodel/a": e("pay", "anymodel: Upstream request failed."), "anymodel/b": e("pay", "Upstream request failed."), "anymodel/c": e("pay", "The selected model is temporarily unavailable. Try another model."),
    "anymodel/d": e("pay"), "anymodel/d2": { r: "pay", n: 7, at: hoursAgo(30) },
    "anymodel/f": e("pay", "Your wallet balance is insufficient. Recharge at [url]"), "anymodel/g": e("pay", "Upstream request failed. Please top up your account"), "anymodel/h": e("pay", "Payment required"),
    "anymodel/i": e("rate", "Upstream request failed."), "anymodel/j": e("gone", "Upstream request failed."), "anymodel/k": e("canary-pay", "Upstream request failed."), "anymodel/l": e("auth", "Upstream request failed."),
  };
  const before = JSON.stringify(pending);
  const r = migrateAvailabilityPay(pending);
  assert.equal(JSON.stringify(pending), before, "pure");
  assert.deepEqual(r.cleared.map((x) => x.key).sort(), ["anymodel/a", "anymodel/b", "anymodel/c"]);
  assert.deepEqual(Object.keys(r.pending).sort(), ["anymodel/d", "anymodel/d2", "anymodel/f", "anymodel/g", "anymodel/h", "anymodel/i", "anymodel/j", "anymodel/k", "anymodel/l"]);
  assert.deepEqual(migrateAvailabilityPay(r.pending).cleared, [], "idempotent");
  assert.deepEqual(migrateAvailabilityPay(null).cleared, []);
});

test("--reset-transient also drops the pay entries that rest on an availability sentence (dry by default, --live under the lock); --release-holds <provider> --live lifts the ones with no sentence; then the models are queued again", async () => {
  const pend2 = (r, why, n = 12) => ({ r, n, at: hoursAgo(3), since: hoursAgo(3), rn: 1, ...(why ? { why } : {}) });
  const pending = {
    "anymodel/m0": pend2("pay", "anymodel: Upstream request failed."), "anymodel/m1": pend2("pay", "anymodel: Upstream request failed.", 14), "anymodel/m2": pend2("pay", "Upstream request failed."),
    "anymodel/m3": { r: "pay", n: 7, at: hoursAgo(30) }, "anymodel/m4": pend2("pay", "Your wallet balance is insufficient"), "anymodel/m5": pend2("rate", "slow down", 2),
  };
  const e = cliEnv([many("anymodel", 8)], { store: { "anymodel/m7": record("ppnn", { sp: "p", er: "p" }) }, pending });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--reset-transient"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /pending pay entries that rest on an availability sentence only .*: 3 of 5 would be dropped, the models asked again \(anymodel 3\); pay entries with no stored sentence, or one cut at the clip length \(0\), cannot be judged and stay/);
  assert.match(dry.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before, "dry: not a byte changed");
  const live = await run(["--reset-transient", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /3 pending pay entries on an availability sentence dropped/);
  let st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.pending).sort(), ["anymodel/m3", "anymodel/m4", "anymodel/m5"], "no sentence, a money sentence and a rate entry stay");
  assert.ok(st.models["anymodel/m7"], "records untouched");
  assert.match((await run(["--reset-transient", "--live"], e.deps)).out, /nothing to change/);
  // the three are asked again by a normal run; the pay ones with no usable sentence are still blocked
  const p = planOf(e, [], { store: st.models, pending: st.pending });
  assert.deepEqual(keys(p), ["anymodel/m0", "anymodel/m1", "anymodel/m2", "anymodel/m5", "anymodel/m6"], "m3 and m4 (pay) stay hard-blocked");
  // the ones with no sentence are lifted by hand, with the existing command
  const rel = await run(["--release-holds", "anymodel", "--live"], e.deps);
  assert.equal(rel.code, 0, rel.err);
  st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.pending), ["anymodel/m5"], "every pay entry of the provider is gone (and the soft rate entry stays)");
  assert.equal(planOf(e, [], { store: st.models, pending: st.pending }).queued.length, 7);
});

// ---------------------------------------------------------------- the estimate counts only the models the run will ASK

test("row ceiling: the refusal estimate counts only the models that will be asked: it falls as --max-row-cost falls, an over-ceiling model adds $0, and the printed figure is the one liveRefusal compares", async () => {
  const prices = [[1, 1], [10, 10], [100, 100], [500, 500]];
  const rows = [{ provider: "pb", keyId: "k.pb.free", models: [...prices.map(([a, b], i) => m(`p${i}`, { badge: "PAID", pin: a, pout: b })), m("free1"), m("unlisted", { badge: null, pin: null, pout: null })] }];
  const e = cliEnv(rows);
  const argv = ["--live", "--levels", "12", "--max-spend", "5", "--tf-max-tokens-per-provider", "10000000"];
  const at = (ceiling) => plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs([...argv, "--max-row-cost", String(ceiling)]), tiers: e.deps.tiers, nowMs: NOW.getTime() });
  const all = at(1000), by = Object.fromEntries(all.run.entries.map((x) => [x.id, x.cost]));
  assert.ok(by.p0 < by.p1 && by.p1 < by.p2 && by.p2 < by.p3 && by.p0 > 0, "four listed prices, four costs");
  assert.equal(by.free1, 0); assert.equal(by.unlisted, 0);
  assert.equal(all.heldBack.entries.length, 0, "a ceiling above every row holds nothing back");
  // a ceiling between the 3rd and the 4th cost: the 4th is not asked and adds nothing
  const mid = at((by.p2 + by.p3) / 2);
  assert.deepEqual(mid.run.entries.map((x) => x.id).sort(), ["free1", "p0", "p1", "p2", "unlisted"]);
  assert.ok(Math.abs(mid.run.usd - (by.p0 + by.p1 + by.p2)) < 1e-12, "the estimate is the sum of the models under the ceiling");
  assert.ok(Math.abs(mid.heldBack.usd - by.p3) < 1e-12 && mid.heldBack.entries.length === 1, "what the held-back model would cost is kept apart, never charged");
  assert.equal(mid.kept.length, 6 - 0, "the model over the ceiling is still in kept: it is recorded as pending, not dropped");
  // the estimate moves with the ceiling, step by step
  const usd = [1000, (by.p2 + by.p3) / 2, (by.p1 + by.p2) / 2, (by.p0 + by.p1) / 2, by.p0 / 2].map((c) => at(c).run.usd);
  for (let i = 1; i < usd.length; i++) assert.ok(usd[i] < usd[i - 1], `a lower ceiling gives a lower estimate: ${usd.join(" > ")}`);
  assert.equal(usd.at(-1), 0, "a ceiling below every priced row: nothing costs money");
  assert.equal(at(by.p0 / 2).run.paidModels, 0);
  // liveRefusal compares THAT figure: a cap under the whole estimate refuses when the ceiling lets every model in, and accepts when the ceiling holds the dear one back
  const cap = String(1.5 * (by.p0 + by.p1 + by.p2));
  const withCap = (ceiling) => { const a = [...argv.slice(0, -4), '--max-spend', cap, '--tf-max-tokens-per-provider', '10000000', '--max-row-cost', String(ceiling)]; return { a, p: plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs(a), tiers: e.deps.tiers, nowMs: NOW.getTime() }) }; };
  const wide = withCap(1000), narrow = withCap((by.p2 + by.p3) / 2);
  assert.match(liveRefusal(parseArgs(wide.a), wide.p) ?? '', /is above the cap/);
  assert.equal(liveRefusal(parseArgs(narrow.a), narrow.p), null, 'the dear model is held back by the ceiling: the same cap passes');
  // the figure the dry run prints is the figure the refusal quotes
  const dryWide = await runRaw(wide.a.filter((x) => x !== "--live"), e.deps);
  const printed = /estimate (\$[\d.,]+) \(input and output priced/.exec(dryWide.out)?.[1], quoted = /the estimate (\$[\d.,]+) is above the cap/.exec(liveRefusal(parseArgs(wide.a), wide.p))?.[1];
  assert.ok(printed && printed === quoted, `printed ${printed} against refused ${quoted}`);
  const dryNarrow = await runRaw(narrow.a.filter((x) => x !== "--live"), e.deps);
  assert.match(dryNarrow.out, /over the \$[\d.]+ row ceiling, NOT asked and not in the estimate: 1 priced model\(s\)/);
  assert.match(dryNarrow.out, /costliest models asked \(3 of 5 cost money\): pb\/p2 \$/);
  assert.match(dryNarrow.out, /per tier this run: free 5 model\(s\)/);
});

// ================================================================ round 5

// ---------------------------------------------------------------- 1: the spend tripwire for a row priced at $0 that reports a cost

const withCost = (c) => (call) => { const a = goodModel(call); return typeof a.body === "string" ? { ...a, body: a.body.replace('"output_tokens":5', '"output_tokens":5,"cost":' + c) } : a; };

test("tripwire: an unlisted-price row on a free-labelled key whose response REPORTS a cost is charged to the spend, counted in the summary, and its PROVIDER is left alone for the rest of the run (pending spend); a provider that reports nothing is unaffected", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 4 }, (_, i) => m("u" + i, { badge: null, pin: null, pout: null })) }, { provider: "pb", keyId: "k.pb.free", models: Array.from({ length: 2 }, (_, i) => m("v" + i, { badge: null, pin: null, pout: null })) }];
  const e = cliEnv(rows, { answer: (call) => (call.body.model.startsWith("pa/") ? withCost(0.002)(call) : goodModel(call)) });
  const r = await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const asked = (pv) => calls(e.f).filter((c) => c.body.model.startsWith(pv + "/")).map((c) => c.body.model);
  assert.deepEqual([...new Set(asked("pa"))], ["pa/u0"], "the first model of pa reported a cost: no other model of pa is asked");
  assert.equal(new Set(asked("pb")).size, 2, "pb reported nothing: both models asked");
  const want = asked("pa").length * 0.002;
  const spent = Number(/est\. spend \$([\d.]+) of the/.exec(r.out)[1]);
  assert.ok(Math.abs(spent - want) < 1e-3, "the reported cost is in the spend: " + spent + " against " + want);
  assert.match(r.out, /1 unlisted-free model\(s\) reported a cost: \$[\d.]+ \(pa 1\)/);
  assert.match(r.out, /NOTE: spend tripwire: 1 unlisted-free model\(s\) reported a cost/, "and the verdict says so");
  const st = loadFidelity(e.out);
  assert.deepEqual(["pa/u1", "pa/u2", "pa/u3"].map((k) => st.pending[k]?.r), ["spend-tripwire", "spend-tripwire", "spend-tripwire"], "the provider's other models are pending spend-tripwire (NEEDS-OWNER)");
  assert.ok(st.models["pa/u0"] && st.models["pb/v0"] && st.models["pb/v1"], "the model that reported the cost keeps its result");
  assert.match(r.out, /NEEDS-OWNER 3|3 need the owner/, "the three are the owner's to lift");
  // it PERSISTS: the next normal run does not ask that provider again; only the owner's lifts do
  const nextKeys = (argv) => keys(planOf(e, argv, { store: st.models, pending: st.pending }));
  assert.deepEqual(nextKeys([]), [], "pb has its records, pa is tripped: nothing to ask");
  assert.deepEqual(nextKeys(["--retry-accounts"]), [], "--retry-accounts is about account states: it does not lift the tripwire");
  assert.deepEqual(nextKeys(["--recheck-hard", "pay"]), []);
  assert.deepEqual(nextKeys(["--recheck-hard", "spend-tripwire"]), ["pa/u1", "pa/u2", "pa/u3"]);
  assert.deepEqual(nextKeys(["--recheck-hard", "spend-tripwire,pb"]), [], "scoped to another provider");
  assert.deepEqual(nextKeys(["--recheck-hard", "owner"]), ["pa/u1", "pa/u2", "pa/u3"]);
  assert.deepEqual(nextKeys(["--only", "pa/u2"]), ["pa/u2"], "a named model is a manual lift");
  // and the end-to-end: a second live run sends nothing to pa
  const before = asked("pa").length;
  await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5"], e.deps);
  assert.equal(asked("pa").length, before, "pa was not asked again");
});

test("tripwire: a reported cost is clamped to --max-spend (1e308 never reaches the figure; a non-finite or negative one is ignored)", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 2 }, (_, i) => m("u" + i, { badge: null, pin: null, pout: null })) }];
  const e = cliEnv(rows, { answer: withCost("1e308") });
  const r = await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const n = calls(e.f).length, spent = Number(/est\. spend \$([\d.]+) of the/.exec(r.out)[1]);
  assert.ok(Number.isFinite(spent) && Math.abs(spent - 5 * n) < 1e-6, "each request is charged at most the cap: " + spent + " for " + n + " requests");
  const neg = cliEnv(rows, { answer: withCost("-1") });
  const q = await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5"], neg.deps);
  assert.equal(/reported a cost/.test(q.out), false, "a negative cost is not a cost");
});

test("tripwire: the dry run says it is inactive through CCR 3.0.22 and why, only when unlisted-price models on free-labelled keys are in the run", async () => {
  const unl = cliEnv([{ provider: "pa", keyId: "k.pa.free", models: [m("u0", { badge: null, pin: null, pout: null })] }]);
  const d = await run([], unl.deps);
  assert.match(d.out, /spend tripwire: inactive through CCR 3\.0\.22 \(the gateway does not forward usage\.cost\); unlisted-price models on free-labelled keys are trusted to be free by the key-tier label/);
  const none = cliEnv([many("pa", 2)]);
  assert.equal(/spend tripwire: inactive/.test((await run([], none.deps)).out), false, "no unlisted-price model in the run: nothing to say");
});

test("tripwire: a row tagged free that reports a cost is NOT an unlisted-free row: no tripwire, the provider goes on", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 3 }, (_, i) => m("t" + i)) }];       // tagged free (pin 0, pout 0)
  const e = cliEnv(rows, { answer: withCost(0.5) });
  const r = await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(new Set(calls(e.f).map((c) => c.body.model)).size, 3);
  assert.equal(/reported a cost/.test(r.out), false);
  assert.match(r.out, /est\. spend \$0\.0+ of/);
});

// ---------------------------------------------------------------- 2: the 402 money-word gate

test("402: subscription, upgrade, spend, limit reached, paid, purchase, deposit, billing, invoice, usage limit, monthly, plan keep a 402 a PAY (also in the migration); a bare availability sentence stays upstream-unavailable", async () => {
  const pay = ["Upstream request failed: subscription required", "Upstream request failed: monthly spend limit reached for your organization", "anymodel: Upstream request failed. Please upgrade your account",
    "Upstream request failed: paid models only", "Upstream request failed. Purchase credits to continue", "Upstream error: deposit required", "Upstream request failed: unpaid invoice", "Upstream request failed: usage limit exceeded",
    "Upstream request failed (billing)", "Upstream request failed: your plan does not include this model", "Upstream request failed: this model requires a paid plan", "Service unavailable: monthly cap hit", "Upstream request failed: spending limit"];
  for (const msg of pay) {
    const r = await kindRes(402, msg);
    assert.equal(r.s, "pay", "402: " + msg);
    assert.equal(hasMoneyWords(msg), true, msg);
  }
  for (const msg of ["Upstream request failed.", "anymodel: Upstream request failed.", "The selected model is temporarily unavailable. Try another model.", "Upstream error", "Service unavailable, please retry"]) {
    const r = await kindRes(402, msg);
    assert.deepEqual([r.s, r.reason], ["error", "upstream-unavailable"], "402: " + msg);
    assert.equal(hasMoneyWords(msg), false, msg);
  }
  assert.equal(hasMoneyWords("Upstream request failed: rapid retry advised"), false, "whole words: rapid is not paid");
  // the quota reading is NOT widened: a bare "daily limit reached" stays quota on a 403
  const q = await kindRes(403, "Daily limit reached for free tier");
  assert.equal(q.reason ?? q.s, "quota");
  // the migration keeps every one of those entries pending pay
  const pending = Object.fromEntries(pay.map((w, i) => ["anymodel/m" + i, { r: "pay", n: 12, at: hoursAgo(3), why: w }]));
  const mig = migrateAvailabilityPay(pending);
  assert.deepEqual(mig.cleared, [], "no money-worded entry is dropped");
  assert.equal(Object.keys(mig.pending).length, pay.length);
  assert.equal(migrateAvailabilityPay({ "anymodel/x": { r: "pay", n: 1, at: hoursAgo(1), why: "Upstream request failed." } }).cleared.length, 1);
});

// ---------------------------------------------------------------- 3: an entry cut at the clip length is unjudgeable; holds that rest on a bare 402 are named

test("migrateAvailabilityPay: a sentence at the clip length (a money word after the cut is invisible) is left alone like one with no sentence; a shorter identical sentence is dropped", () => {
  const head = "anymodel: Upstream request failed. ";
  const cut = head + "x".repeat(PENDING_WHY_CHARS - head.length);
  assert.equal(cut.length, PENDING_WHY_CHARS);
  const e = (why) => ({ r: "pay", n: 12, at: hoursAgo(3), why });
  const r = migrateAvailabilityPay({ "anymodel/cut": e(cut), "anymodel/short": e(head.trim()), "anymodel/near": e(cut.slice(0, -1)) });
  assert.deepEqual(r.cleared.map((x) => x.key).sort(), ["anymodel/near", "anymodel/short"]);
  assert.deepEqual(r.clipped, ["anymodel/cut"]);
  assert.ok("anymodel/cut" in r.pending, "kept: pay");
});

test("payHoldsOnBareEvidence: a pay hold with no money-word sentence among its pay entries is named; one with a money sentence, or an auth hold, is not", () => {
  const held = { anymodel: { r: "pay", at: hoursAgo(2) }, other: { r: "pay", at: hoursAgo(2) }, authp: { r: "auth", at: hoursAgo(2) } };
  const pending = { "anymodel/a": { r: "pay", n: 2, at: hoursAgo(1) }, "other/a": { r: "pay", n: 2, at: hoursAgo(1), why: "Your wallet balance is insufficient" }, "anymodel/b": { r: "pay", n: 2, at: hoursAgo(1), why: "Upstream request failed." } };
  assert.deepEqual(payHoldsOnBareEvidence(held, pending), [{ provider: "anymodel", entries: 2, availabilityOnly: 1, otherSentence: 0, noSentence: 1 }], "the evidence is split: one entry with no sentence, one with an availability-only sentence");
  const other = payHoldsOnBareEvidence({ p: { r: "pay", at: hoursAgo(1) }, q: { r: "pay", at: hoursAgo(1) } }, { "p/a": { r: "pay", n: 1, at: hoursAgo(1), why: "Forbidden" } });
  assert.deepEqual(other.map((x) => [x.provider, x.entries, x.availabilityOnly, x.otherSentence, x.noSentence]), [["p", 1, 0, 1, 0], ["q", 0, 0, 0, 0]], "another sentence with no money word; a hold with no pay entry at all");
  assert.deepEqual(payHoldsOnBareEvidence({}, pending), []);
  assert.deepEqual(payHoldsOnBareEvidence(null, null), []);
});

test("--reset-transient names the providers STILL held on pay with no money sentence, in the dry run and after applying", async () => {
  const pending = { "anymodel/m0": { r: "pay", n: 12, at: hoursAgo(3), why: "anymodel: Upstream request failed." }, "anymodel/m1": { r: "pay", n: 7, at: hoursAgo(30) }, "good/m0": { r: "pay", n: 3, at: hoursAgo(3), why: "Payment required" }, "cutp/m0": { r: "pay", n: 3, at: hoursAgo(3), why: ("Upstream request failed. " + "x".repeat(200)).slice(0, PENDING_WHY_CHARS) } };
  const e = cliEnv([many("anymodel", 3), many("good", 2), many("cutp", 1)], { pending, held: { anymodel: { r: "pay", at: hoursAgo(3) }, good: { r: "pay", at: hoursAgo(3) }, cutp: { r: "pay", at: hoursAgo(3) } } });
  const dry = await run(["--reset-transient"], e.deps);
  const line = dry.out.split("\n").find((l) => l.includes("STILL held")) ?? "";
  assert.match(line, /STILL held on pay with no sentence of money words on record .*: anymodel \(1 pay entry: 1 no sentence stored\); cutp \(1 pay entry: 1 availability-only sentence stored\); `--release-holds/);
  assert.equal(/\bgood\b/.test(line), false, "a hold with a money sentence is not named");
  const live = await run(["--reset-transient", "--live"], e.deps);
  assert.equal(live.code, 0, live.err);
  assert.match(live.out, /STILL held on pay with no sentence of money words on record: anymodel \(1 pay entry: 1 no sentence stored\); cutp \(1 pay entry: 1 availability-only sentence stored\) /);
});

// ---------------------------------------------------------------- 4: a NEEDS-OWNER reason of a model this run QUEUES reads not-run

test("verdict: a model queued THIS run whose stored reason is priced-over-row-cap (the ceiling was raised), row-cost or route-shape (named, lifted) reads not-run, not NEEDS-OWNER; still over the ceiling it stays NEEDS-OWNER", () => {
  const rows = [{ provider: "pb", keyId: "k.pb.free", models: [m("big", { badge: "PAID", pin: 500, pout: 500 }), m("rs"), m("rc", { badge: "PAID", pin: 400, pout: 400 }), m("fine")] }];
  const e = cliEnv(rows);
  const pending = { "pb/big": pend("priced-over-row-cap", 3), "pb/rc": pend("row-cost", 3), "pb/rs": pend("route-shape", 3) };
  const low = planOf(e, [], { pending });
  assert.equal(low.verdict.owner, 3, "default ceiling: the two cost reasons and route-shape are NEEDS-OWNER");
  assert.deepEqual(keys(low), ["pb/fine"]);
  const raised = planOf(e, ["--max-row-cost", "100"], { pending });
  assert.deepEqual(keys(raised), ["pb/big", "pb/fine", "pb/rc"], "the ceiling is raised: they are queued (route-shape stays out unless lifted)");
  assert.equal(raised.verdict.byRecoverable["not-run"], 3, JSON.stringify(raised.verdict.byRecoverable));
  assert.equal(raised.verdict.owner, 1, "only route-shape is left for the owner");
  const lifted = planOf(e, ["--max-row-cost", "100", "--only", "pb/rs"], { pending });
  assert.deepEqual(keys(lifted), ["pb/rs"], "named: route-shape is lifted");
  assert.equal(lifted.verdict.owner, 2, "the two cost models are not in this --only scope: they keep their stored reason");
  assert.equal(lifted.verdict.byRecoverable["not-run"], 2, "route-shape lifted and queued, plus the untested model that this --only scope does not ask: not-run");
});

// ---------------------------------------------------------------- exit code of the tool sweep

test("exit code: toolSweepExit is 0 for records written or nothing sent, 0 for Ctrl-C and for rate limits, 4 for the gateway give-up, and 3 only for 'requests sent, no record, an unexplained failure'", () => {
  assert.equal(toolSweepExit({ requests: 12, records: 42, outcomes: { error: 3, timeout: 2 } }), 0, "42 records: the run worked, whatever else failed");
  assert.equal(toolSweepExit({ requests: 0, records: 0 }), 0, "nothing queueable");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { rate: 9 } }), 0, "all rate limited: saturation");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { quota: 4, pay: 3, auth: 2 } }), 0, "quota and account states are reported, not an outage");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { rate: 8, error: 1 } }), 0, "one failure among eight rate limits: saturation, not an outage");
  assert.equal(toolSweepExit({ requests: 99, records: 0, outcomes: { rate: 98, timeout: 1 } }), 0, "one timeout among 99 rate limits");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { rate: 4, error: 3, timeout: 1 } }), 3, "unexplained failures are half of the models that ended without a result");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { rate: 3, error: 1, timeout: 2 } }), 3, "half or more");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { rate: 4, error: 1, timeout: 2 } }), 0, "under half");
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { timeout: 1 } }), 3);
  assert.equal(toolSweepExit({ requests: 9, records: 0, outcomes: { error: 9 }, signal: true }), 0, "Ctrl-C is the user's decision");
  assert.equal(toolSweepExit({ gaveUp: true, requests: 9, records: 5 }), 4);
  assert.equal(toolSweepExit(), 0);
});

test("exit code, live: a run that wrote records exits 0 though no probe counts as ok; all requests rate limited with no record exits 0 with a SATURATION line; every request failing exits 3", async () => {
  const good = cliEnv([many("pa", 3)]);
  assert.equal((await run(["--live"], good.deps)).code, 0);
  const rate = cliEnv([many("pa", 3)], { answer: () => http(429, "slow down", { "retry-after": "1" }) });
  const r = await run(["--live"], rate.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /SATURATION saturated=/);
  assert.deepEqual(Object.keys(loadFidelity(rate.out).models), []);
  const bad = cliEnv([many("pa", 3)], { answer: () => http(500, "internal boom") });
  const b = await run(["--live"], bad.deps);
  assert.equal(b.code, 3, b.err + b.out);
  assert.deepEqual(Object.keys(loadFidelity(bad.out).models), [], "nothing worked: no record");
});

test("exit code: a failed save is exit 1 even when no record was written and the models errored (it outranks the 3); the same run with a working save is 3", async () => {
  const bad = cliEnv([many("pa", 3)], { answer: () => http(500, "internal boom") });
  assert.equal((await run(["--live"], bad.deps)).code, 3, "no record, every model errored, saved fine: 3");
  const lost = cliEnv([many("pa", 3)], { answer: () => http(500, "internal boom") });
  lost.deps.saveImpl = () => { throw new Error("read-only volume"); };
  const r = await run(["--live"], lost.deps);
  assert.equal(r.code, 1, r.err + r.out);
  assert.match(r.err, /could not save/);
});

test("tripwire: the models of the provider that WAIT for the per-provider cap are pending spend-tripwire too, not cap (a later normal run must not ask them)", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: Array.from({ length: 4 }, (_, i) => m("u" + i, { badge: null, pin: null, pout: null })) }];
  const e = cliEnv(rows, { answer: withCost(0.002) });
  const r = await run(["--live", "--concurrency", "1", "--per-provider", "1", "--max-spend", "5", ...CAP], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const st = loadFidelity(e.out);
  assert.deepEqual(["pa/u1", "pa/u2", "pa/u3"].map((k) => st.pending[k]?.r), ["spend-tripwire", "spend-tripwire", "spend-tripwire"], "u3 waited for the cap: still spend-tripwire");
  assert.deepEqual(keys(planOf(e, [], { store: st.models, pending: st.pending })), []);
});

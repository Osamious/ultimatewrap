// The sweep loop (owner rule 2026-10-06): hard reasons (pay, auth, gone) are STICKY: a hold never expires by time and a model pending one of them is not queued again by a normal run; only a manual lift
// (`--recheck-hard`, `--retry-accounts`, `--release-holds`) re-asks them. A run ends with a verdict (recoverable / hard-blocked / tested, each with its denominator) and a machine-readable
// `SATURATION ...` line a loop script can stop on. Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, freshDir, fakeFetch, goodModel, http, record, kindOf, ev, stream, ok } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan, verdictLines, saturationLines, hardLines, scopeOf, capReasonOf, pendingReasonOf } from "../refresh/tool-fidelity-cli.mjs";
import { runKind, isQuotaSentence, probeModel, MAX_MODEL_REQUESTS } from "../refresh/tool-fidelity-probe.mjs";
import { activeHolds, hardState, recheckCovers, releaseHolds, sweepVerdict, saturation, coverage, confirmedProviders, saveFidelity, loadFidelity, cleanMeta, cleanPending, DEFAULT_LEVELS, capRecords, renderFile, updatePending, TRIED_REASONS, HELD_PLAN, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

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
    isAlive: () => false, findRunning: () => [], rateBackoffMs: 1, sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
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
  const rows = [many("pa", 6), many("pb", 3), many("pc", 3), many("pd", 2)];
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
  assert.match(text[0], /^sweep verdict: RECOVERABLE \d+ of 14 \(.*\) \| HARD-BLOCKED 6 of 14 \(.*pay 4.*; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 14 \(complete for every level it is eligible for 0 of 3; tested but optional levels not run 3 of 3: .*spawn 3.*\) \| NEEDS-OWNER 1 of 14 \(row-cost 1: raise --max-row-cost; a re-run alone changes nothing\)/);
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
  assert.equal(r.lines.at(-1), "SATURATION saturated=unknown recoverable=2 hard=3 new_results=0 requests=0");
  assert.equal(calls(e.f).length, 0);
  const done = cliEnv([many("pa", 2)], { store: { "pa/m0": record("ppnn") }, pending: { "pa/m1": pend("gone") } });
  const d = await run([], done.deps);
  assert.match(d.out, /DONE: nothing recoverable left \(1 of 2 model\(s\) tested, 1 hard-blocked\)/);
  assert.equal(d.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0 requests=0");
  const live = await run(["--live"], done.deps);
  assert.match(live.out, /tool-fidelity: nothing to probe\./);
  assert.match(live.out, /DONE: nothing recoverable left/);
  assert.equal(live.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0 requests=0");
  assert.equal(calls(done.f).length, 0, "nothing sent: the only untested model is hard-blocked");
});

test("a live run ends with the verdict, its saturation line and, last, the machine-readable line; progress -> saturated=no, then the finishing run -> DONE", async () => {
  const e = cliEnv([many("pa", 6)]);
  const r1 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  assert.match(r1.out, /sweep verdict: RECOVERABLE 3 of 6 \(cap 3\) \| HARD-BLOCKED 0 of 6 \(none; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 6/);
  assert.match(r1.out, /saturation of this run: \d+ request\(s\) sent: 0 ended rate-limited \(0% of \d+\), 0 ended rate, error or timeout \(0% of \d+\); 3 new record\(s\); saturated: no/);
  assert.match(r1.lines.at(-1), /^SATURATION saturated=no recoverable=3 hard=0 new_results=3 requests=\d+$/);
  const r2 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.match(r2.out, /DONE: nothing recoverable left \(6 of 6 model\(s\) tested, 0 hard-blocked\)/);
  assert.match(r2.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=3 requests=\d+$/);
});

test("a run where every request is rate-limited records nothing and says saturated=yes with its rate-limited share; the models stay recoverable (rate)", async () => {
  const e = cliEnv([many("pa", 4), many("pb", 4)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const sat = r.lines.at(-1);
  assert.match(sat, /^SATURATION saturated=yes recoverable=8 hard=0 new_results=0 requests=\d+$/);
  assert.match(r.out, /sweep verdict: RECOVERABLE 8 of 8 \(rate 8\)/);
  assert.match(r.out, /saturation of this run: (\d+) request\(s\) sent: \1 ended rate-limited \(100% of \1\), \1 ended rate, error or timeout \(100% of \1\); 0 new record\(s\); saturated: yes \(no new result in this run\)/);
  assert.deepEqual(loadFidelity(e.out).held, {}, "a rate limit is the moment's: never a hold");
});

test("80% failing with some progress is saturated: three providers keep rate-limiting, one records its only model", async () => {
  const e = cliEnv([many("pa", 5), many("pc", 5), many("pd", 5), many("pb", 1)], { answer: (c) => (c.body.model.startsWith("pb/") ? goodModel(c) : http(429, "slow down", { "retry-after": "0" })) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=15 hard=0 new_results=1 requests=\d+$/);
  assert.match(r.out, /saturated: yes \(\d+% of the requests ended rate, error or timeout\)/);
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
  assert.match(r1.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=3 new_results=3 requests=\d+$/, "pa answered (3 records) but nothing recoverable is left: the loop stops, hard-blocked 3 left");
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
  assert.match(r3.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=3 requests=\d+$/);
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
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=4 new_results=0 requests=\d+$/);
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
  assert.equal(saturationLines(v, null).at(-1), "SATURATION saturated=unknown recoverable=4 hard=2 new_results=0 requests=0");
  assert.equal(saturationLines({ recoverable: 0, hard: 2 }, null).at(-1), "SATURATION saturated=yes recoverable=0 hard=2 new_results=0 requests=0");
  const sat = saturation({ requests: 10, rate: 1, failing: 1, newResults: 6, recoverable: 4 });
  assert.equal(saturationLines(v, sat).at(-1), "SATURATION saturated=no recoverable=4 hard=2 new_results=6 requests=10");
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
  assert.deepEqual([same.saturated, same.why], [true, "the recoverable set did not shrink: 5 now, 5 at the end of the previous run"]);
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
  assert.match(ra.lines.at(-1), /^SATURATION saturated=yes recoverable=1 hard=0 new_results=1 requests=\d+$/, ra.out);
  assert.match(ra.out, /saturated: yes \(the recoverable set did not shrink: 1 now, 1 at the end of the previous run\)/);
  assert.deepEqual(loadFidelity(a.e.out).meta, { recoverable: 1, scope: scopeOf(parseArgs(pinL12(["--live", "--per-provider", "1"]))), at: NOW.toISOString() });
  // previous run left 2: now 1, it shrank
  const b = mk(2);
  const rb = await run(["--live", "--per-provider", "1"], b.e.deps);
  assert.match(rb.lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+$/);
  assert.deepEqual(loadFidelity(b.e.out).meta.recoverable, 1);
  // no previous count on record
  const c = mk(null);
  assert.match((await run(["--live", "--per-provider", "1"], c.e.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+$/);
  // a manual lift is allowed to grow the set
  const d = mk(1);
  assert.match((await run(["--live", "--per-provider", "1", "--retry-accounts"], d.e.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+$/);
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
  assert.match(line, /TESTED 6 of 6 \(complete for every level it is eligible for 2 of 6; tested but optional levels not run 4 of 6: /);
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
  assert.match(r.out, /TESTED 2 of 3 \(complete for every level it is eligible for 1 of 2; tested but optional levels not run 1 of 2: error-result 1, spawn 1\)/);
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
  assert.match(same.lines.at(-1), /^SATURATION saturated=yes recoverable=1 hard=0 new_results=1 requests=\d+$/);
  // a meta written under ANOTHER scope compares with nothing
  const other = await run(live, mk(live, 1, ["--live", "--only", "pb"]).deps);
  assert.match(other.lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+$/, other.out);
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
  assert.match((await run(live, old.deps)).lines.at(-1), /^SATURATION saturated=no recoverable=1 hard=0 new_results=1 requests=\d+$/);
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
  assert.equal(r.lines.at(-1), "SATURATION saturated=yes recoverable=2 hard=0 new_results=0 requests=0");
  assert.match(r.out, /this run sent nothing; scope-exhausted: 2 recoverable model\(s\) are outside this run's scope\/levels/);
  assert.doesNotMatch(r.out, /DONE:/);
  const done = cliEnv([many("pa", 1)], { store: { "pa/m0": record("ppnn") } });
  assert.equal((await run(["--live"], done.deps)).lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0");
});

test("finding 5: a run stopped early prints saturated=unknown, no DONE, and does not write the meta; exit codes are the sweep's", async () => {
  const e = cliEnv([many("pa", 6)]);
  e.deps.sweep = { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1, maxMs: 1 };
  const slow = e.deps.fetch;
  e.deps.fetch = async (url, init) => { await new Promise((r) => setTimeout(r, 15)); return slow(url, init); };
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.out, /stopped \(/);
  assert.match(r.lines.at(-1), /^SATURATION saturated=unknown recoverable=\d+ hard=0 new_results=\d+ requests=\d+$/);
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
  assert.equal(r.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0");
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
  assert.match(dry.lines.at(-1), /^SATURATION saturated=unknown recoverable=2 hard=0 new_results=0 requests=0$/);
  const live = await run(["--live", "--per-provider", "1"], e.deps);
  const sent = calls(e.f).length;
  assert.ok(sent > 0);
  assert.match(live.lines.at(-1), new RegExp(`^SATURATION saturated=yes recoverable=0 hard=0 new_results=2 requests=${sent}$`));
  const nothing = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(nothing.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=0 requests=0$/);
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
  assert.equal(pendingReasonOf({ s: "skip", w: "rate-paused" }), "rate");
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
  assert.equal(st.pending["pa/m0"].r, "rate", "the stopped level stays pending with its reason");
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

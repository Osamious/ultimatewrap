// The sweep loop (owner rule 2026-10-06): hard reasons (pay, auth, gone) are STICKY: a hold never expires by time and a model pending one of them is not queued again by a normal run; only a manual lift
// (`--recheck-hard`, `--retry-accounts`, `--release-holds`) re-asks them. A run ends with a verdict (recoverable / hard-blocked / tested, each with its denominator) and a machine-readable
// `SATURATION ...` line a loop script can stop on. Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan, verdictLines, saturationLines } from "../refresh/tool-fidelity-cli.mjs";
import { activeHolds, hardState, recheckCovers, releaseHolds, sweepVerdict, saturation, coverage, confirmedProviders, saveFidelity, loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

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
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n"), lines: out.join("\n").split("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const byProv = (f) => { const o = {}; for (const c of calls(f)) { const p = c.body.model.split("/")[0]; o[p] = (o[p] ?? 0) + 1; } return o; };
const planOf = (e, argv, { store = {}, pending = {}, held = {}, nowMs = NOW.getTime() } = {}) => plan({ snap: { rows: e.rows }, bench: e.deps.bench, store, o: parseArgs(argv), tiers: e.deps.tiers, pending, held, nowMs });
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
  assert.match(text[0], /^sweep verdict: RECOVERABLE \d+ of 14 \(.*\) \| HARD-BLOCKED 6 of 14 \(.*pay 4.*; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 14 \| NEEDS-OWNER 1 of 14/);
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
  assert.match(r.out, /hard-blocked, not asked .*: 1 of 5 model\(s\) in the whole queue \(pay 1\)/);
  assert.equal(r.lines.at(-1), "SATURATION saturated=unknown recoverable=2 hard=3 new_results=0");
  assert.equal(calls(e.f).length, 0);
  const done = cliEnv([many("pa", 2)], { store: { "pa/m0": record("ppnn") }, pending: { "pa/m1": pend("gone") } });
  const d = await run([], done.deps);
  assert.match(d.out, /DONE: nothing recoverable left \(1 of 2 model\(s\) tested, 1 hard-blocked\)/);
  assert.equal(d.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0");
  const live = await run(["--live"], done.deps);
  assert.match(live.out, /tool-fidelity: nothing to probe\./);
  assert.match(live.out, /DONE: nothing recoverable left/);
  assert.equal(live.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=1 new_results=0");
  assert.equal(calls(done.f).length, 0, "nothing sent: the only untested model is hard-blocked");
});

test("a live run ends with the verdict, its saturation line and, last, the machine-readable line; progress -> saturated=no, then the finishing run -> DONE", async () => {
  const e = cliEnv([many("pa", 6)]);
  const r1 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.equal(r1.code, 0, r1.err + r1.out);
  assert.match(r1.out, /sweep verdict: RECOVERABLE 3 of 6 \(cap 3\) \| HARD-BLOCKED 0 of 6 \(none; lift only with --recheck-hard\/--release-holds\) \| TESTED 3 of 6/);
  assert.match(r1.out, /saturation of this run: \d+ request\(s\) sent: 0 ended rate-limited \(0% of \d+\), 0 ended rate, error or timeout \(0% of \d+\); 3 new record\(s\); saturated: no/);
  assert.equal(r1.lines.at(-1), "SATURATION saturated=no recoverable=3 hard=0 new_results=3");
  const r2 = await run(["--live", "--per-provider", "1", ...CAP], e.deps);
  assert.match(r2.out, /DONE: nothing recoverable left \(6 of 6 model\(s\) tested, 0 hard-blocked\)/);
  assert.equal(r2.lines.at(-1), "SATURATION saturated=yes recoverable=0 hard=0 new_results=3");
});

test("a run where every request is rate-limited records nothing and says saturated=yes with its rate-limited share; the models stay recoverable (rate)", async () => {
  const e = cliEnv([many("pa", 4), many("pb", 4)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const sat = r.lines.at(-1);
  assert.match(sat, /^SATURATION saturated=yes recoverable=8 hard=0 new_results=0$/);
  assert.match(r.out, /sweep verdict: RECOVERABLE 8 of 8 \(rate 8\)/);
  assert.match(r.out, /saturation of this run: (\d+) request\(s\) sent: \1 ended rate-limited \(100% of \1\), \1 ended rate, error or timeout \(100% of \1\); 0 new record\(s\); saturated: yes \(no new result in this run\)/);
  assert.deepEqual(loadFidelity(e.out).held, {}, "a rate limit is the moment's: never a hold");
});

test("80% failing with some progress is saturated: three providers keep rate-limiting, one records its only model", async () => {
  const e = cliEnv([many("pa", 5), many("pc", 5), many("pd", 5), many("pb", 1)], { answer: (c) => (c.body.model.startsWith("pb/") ? goodModel(c) : http(429, "slow down", { "retry-after": "0" })) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=15 hard=0 new_results=1$/);
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
  assert.match(r1.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=3 new_results=3$/, "pa answered (3 records) but nothing recoverable is left: the loop stops, hard-blocked 3 left");
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
  assert.match(r3.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=0 new_results=3$/);
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
  assert.match(r.lines.at(-1), /^SATURATION saturated=yes recoverable=0 hard=4 new_results=0$/);
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
  assert.equal(saturationLines(v, null).at(-1), "SATURATION saturated=unknown recoverable=4 hard=2 new_results=0");
  assert.equal(saturationLines({ recoverable: 0, hard: 2 }, null).at(-1), "SATURATION saturated=yes recoverable=0 hard=2 new_results=0");
  const sat = saturation({ requests: 10, rate: 1, failing: 1, newResults: 6, recoverable: 4 });
  assert.equal(saturationLines(v, sat).at(-1), "SATURATION saturated=no recoverable=4 hard=2 new_results=6");
  assert.equal(saturationLines(v, sat).length, 2);
});

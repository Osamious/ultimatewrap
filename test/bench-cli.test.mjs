// #114: the CLI's pure parts (argument validation, resume filtering, sampling,
// the plan's numbers) and the gateway helper that hands out a live credential.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import {
  parseArgs, dropFresh, limitGroups, summarize, medianSeconds, DEFAULTS, ECONOMY_DEFAULTS, ECONOMY_BREAKERS, printPlan, unprobedLines,
  sweepOptions, sweepExit,
} from "../refresh/bench-cli.mjs";
import { runSweep } from "../refresh/bench.mjs";
import { parseOnlyList, withBudget, main, EXIT_BUSY, gatewayUp, cutTokens, ceilTokens } from "../refresh/bench-cli.mjs";
import { acquireLock } from "../refresh/bench-lock.mjs";
import { BENCH_SCHEMA } from "../menu/bench-data.mjs";
import { gatewayConnection } from "../menu/ccr-client.mjs";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const T = (provider, id, o = {}) => ({ key: `${provider}/${id}`, provider, id, free: true, cost: 0, worst: 0, ...o });

// -------------------------------------------------------------------- args

test("defaults are the ones the plan states", () => {
  const o = parseArgs([]);
  assert.equal(o.live, false, "dry by default");
  assert.deepEqual([o.concurrency, o.perProvider, o.maxSpend, o.maxRowCost, o.maxTokens, o.ttlDays, o.timeoutSec],
    [8, 2, 5, 0.1, 96, 7, 240], "the defaults ARE probe-all's: $0.10 a row, $5 total, 4 minutes a probe");
  assert.equal(parseArgs(["--economy"]).timeoutSec, 240, "economy has no reason to keep 35 s: its breakers already cut a hanging provider after 3");
  assert.equal(o.maxMinutes, 150);
  assert.equal(o.only, null); assert.equal(o.limit, null);
  assert.equal(Object.isFrozen(DEFAULTS), true);
});

test("flags and values parse", () => {
  const o = parseArgs(["--live", "--force", "--only", "a, b/c ,", "--limit", "40", "--max-spend", "0.5", "--per-provider", "3"]);
  assert.equal(o.live, true); assert.equal(o.force, true);
  assert.deepEqual(o.only, ["a", "b/c"]);
  assert.equal(o.limit, 40); assert.equal(o.maxSpend, 0.5); assert.equal(o.perProvider, 3);
  assert.equal(parseArgs(["--compact"]).compact, true);
});

test("bad input is an error, not a silent default", () => {
  for (const argv of [["--nope"], ["--only"], ["--limit", "0"], ["--limit", "-3"], ["--limit", "1.5"],
                      ["--concurrency", "abc"], ["--max-spend", "NaN"], ["--ttl"], ["--per-provider", "0"]]) {
    assert.ok(parseArgs(argv).error, JSON.stringify(argv));
  }
  assert.equal(parseArgs(["--max-spend", "0.25"]).error, undefined, "fractions are fine where money is meant");
});

test("probe-all is the default: no flag needed, and --probe-all is an accepted no-op alias", () => {
  const d = parseArgs([]);
  assert.equal(d.economy, false); assert.equal(d.probeAll, true);
  assert.deepEqual([d.maxRowCost, d.maxSpend, d.maxMinutes, d.coolAfter, d.coolGapMs], [0.1, 5, 150, 10, 400]);
  assert.deepEqual(parseArgs(["--probe-all"]), d, "--probe-all changes nothing");
  assert.deepEqual(parseArgs(["--live", "--probe-all"]), parseArgs(["--live"]));
  assert.equal(parseArgs(["--probe-all"]).error, undefined, "and is not an error");
  assert.deepEqual([DEFAULTS.maxRowCost, DEFAULTS.maxSpend, DEFAULTS.maxMinutes], [0.1, 5, 150]);
});

test("--economy restores the old budget: $0.01 a row, $2 total, no wall-clock limit", () => {
  const o = parseArgs(["--economy"]);
  assert.equal(o.economy, true); assert.equal(o.probeAll, false);
  assert.deepEqual([o.maxRowCost, o.maxSpend, o.maxMinutes], [0.01, 2, null]);
  assert.deepEqual({ ...ECONOMY_DEFAULTS }, { maxSpend: 2, maxRowCost: 0.01, maxMinutes: null });
  assert.deepEqual({ ...ECONOMY_BREAKERS }, { deadAfter: 3, unfundedAfter: 5 });
  assert.ok(parseArgs(["--economy", "--probe-all"]).error, "the two contradict each other");
  assert.ok(parseArgs(["--probe-all", "--economy"]).error);
});

test("an explicit --max-spend / --max-row-cost / --max-minutes wins over either mode's default, in either order", () => {
  for (const argv of [["--max-spend", "8", "--max-row-cost", "0.5", "--max-minutes", "30"],
                      ["--economy", "--max-spend", "8", "--max-row-cost", "0.5", "--max-minutes", "30"],
                      ["--max-spend", "8", "--max-row-cost", "0.5", "--max-minutes", "30", "--economy"]]) {
    const o = parseArgs(argv);
    assert.deepEqual([o.maxSpend, o.maxRowCost, o.maxMinutes], [8, 0.5, 30], JSON.stringify(argv));
  }
  const half = parseArgs(["--economy", "--max-spend", "1"]);
  assert.deepEqual([half.maxSpend, half.maxRowCost], [1, 0.01], "only the flag that was given wins; the other takes the mode default");
  assert.equal(parseArgs(["--max-spend", "5", "--economy"]).maxSpend, 5, "an explicit value equal to the other mode's default still wins");
  assert.equal(parseArgs(["--economy", "--max-minutes", "150"]).maxMinutes, 150);
});

test("--cool-after and --cool-gap-ms parse, and reject bad values", () => {
  const o = parseArgs(["--cool-after", "4", "--cool-gap-ms", "250"]);
  assert.deepEqual([o.coolAfter, o.coolGapMs], [4, 250]);
  for (const argv of [["--cool-after"], ["--cool-after", "0"], ["--cool-after", "2.5"], ["--cool-after", "x"],
                      ["--cool-gap-ms"], ["--cool-gap-ms", "0"], ["--cool-gap-ms", "-5"], ["--cool-gap-ms", "NaN"]]) {
    assert.ok(parseArgs(argv).error, JSON.stringify(argv));
  }
});

// ------------------------------------------------------------------ resume

test("resume drops rows measured within the ttl and keeps everything else", () => {
  const groups = new Map([["a", [T("a", "fresh"), T("a", "stale"), T("a", "new"), T("a", "limited")]], ["b", [T("b", "x")]]]);
  const existing = new Map([
    ["a/fresh", { s: "ok", a: Math.floor((NOW - 864e5) / 1000) }],
    ["a/stale", { s: "ok", a: Math.floor((NOW - 30 * 864e5) / 1000) }],
    ["a/limited", { s: "rate", a: Math.floor(NOW / 1000) }],
    ["b/x", { s: "ok", a: Math.floor(NOW / 1000) }],
  ]);
  const { groups: out, fresh } = dropFresh(groups, existing, { ttlMs: 7 * 864e5, nowMs: NOW });
  assert.deepEqual(out.get("a").map((t) => t.id), ["stale", "new", "limited"]);
  assert.equal(out.has("b"), false, "a provider with nothing left is dropped");
  assert.equal(fresh, 2);
});

test("--force keeps every row", () => {
  const groups = new Map([["a", [T("a", "x")]]]);
  const { groups: out, fresh } = dropFresh(groups, new Map([["a/x", { s: "ok", a: Math.floor(NOW / 1000) }]]), { ttlMs: 864e5, nowMs: NOW, force: true });
  assert.equal(out.get("a").length, 1); assert.equal(fresh, 0);
});

// ------------------------------------------------------------------ limit

test("--limit samples round-robin, so every provider's canary is in a small sample", () => {
  const groups = new Map([["big", Array.from({ length: 50 }, (_, i) => T("big", `m${i}`))],
                          ["mid", Array.from({ length: 5 }, (_, i) => T("mid", `m${i}`))],
                          ["tiny", [T("tiny", "only")]]]);
  const out = limitGroups(groups, 6);
  assert.equal([...out.values()].flat().length, 6);
  assert.deepEqual([...out.keys()].sort(), ["big", "mid", "tiny"], "all three providers are represented");
  assert.equal(out.get("tiny").length, 1);
  assert.deepEqual(out.get("big").map((t) => t.id), ["m0", "m1", "m2"].slice(0, out.get("big").length), "each provider's own order is kept");
});

test("--limit larger than the work, or absent, changes nothing", () => {
  const groups = new Map([["a", [T("a", "x"), T("a", "y")]]]);
  assert.equal(limitGroups(groups, null), groups);
  assert.equal([...limitGroups(groups, 99).values()].flat().length, 2);
});

// ------------------------------------------------------------------- plan

test("the plan counts free and paid rows, sums expected spend, and flags rows over the ceiling", () => {
  const o = { ...parseArgs(["--economy"]), avgSec: null };
  const groups = new Map([["a", [T("a", "f"), T("a", "p1", { free: false, cost: 0.001, worst: 0.002 }),
                                  T("a", "p2", { free: false, cost: 0.003, worst: 0.02 })]],
                          ["b", [T("b", "f")]]]);
  const s = summarize(groups, o);
  assert.deepEqual([s.rows, s.free, s.paid, s.providers], [4, 2, 2, 2]);
  assert.equal(s.overRow, 1, "p2's worst case exceeds the 0.01 ceiling");
  assert.ok(Math.abs(s.estSpend - 0.001) < 1e-12, "only rows under the ceiling count toward the estimate");
  assert.equal(s.spendCapped, false);
});

test("the spend estimate is an upper bound and reports when the cap would bind", () => {
  const rows = Array.from({ length: 10 }, (_, i) => T("a", `p${i}`, { free: false, cost: 0.5, worst: 0.5 }));
  const s = summarize(new Map([["a", rows]]), { ...DEFAULTS, maxRowCost: 1, maxSpend: 2, avgSec: null });
  assert.equal(s.estSpend, 5); assert.equal(s.spendCapped, true);
});

test("wall time is bounded by the largest provider, not only by the total", () => {
  const big = Array.from({ length: 100 }, (_, i) => T("big", `m${i}`));
  const s = summarize(new Map([["big", big]]), { ...DEFAULTS, concurrency: 8, perProvider: 2, avgSec: 4 });
  assert.equal(s.wallSec, (100 * 4) / 2, "one provider at 2 concurrent, however many slots are free");
  const wide = new Map(Array.from({ length: 50 }, (_, p) => [`p${p}`, [T(`p${p}`, "m")]]));
  assert.equal(summarize(wide, { ...DEFAULTS, concurrency: 8, perProvider: 2, avgSec: 4 }).wallSec, (50 * 4) / 8);
});

test("the per-probe latency comes from earlier measurements when there are any", () => {
  assert.equal(medianSeconds(new Map()), null);
  assert.equal(medianSeconds(new Map([["a/x", { s: "pay", d: 9999 }]])), null, "only answered probes count");
  const m = new Map([["a/1", { s: "ok", d: 2000 }], ["a/2", { s: "ok", d: 10000 }], ["a/3", { s: "ok", d: 4000 }]]);
  assert.equal(medianSeconds(m), 4);
  const withData = summarize(new Map([["a", [T("a", "x")]]]), { ...DEFAULTS, avgSec: 10 });
  const without = summarize(new Map([["a", [T("a", "x")]]]), { ...DEFAULTS, avgSec: null });
  assert.ok(withData.wallSec > without.wallSec);
});

test("default (probe-all) plan: numbers, the rows over the ceiling (top by cost), the billing note and the cap", () => {
  const o = { ...parseArgs(["--probe-all"]), avgSec: null };
  const paid = (id, cost, worst) => T("a", id, { free: false, cost, worst });
  const groups = new Map([["a", [T("a", "f"), paid("p1", 0.001, 0.002), paid("big1", 0.05, 0.3), paid("big2", 0.04, 0.2),
                                  paid("big3", 0.03, 0.15), paid("big4", 0.02, 0.12), paid("big5", 0.02, 0.11), paid("big6", 0.02, 0.101)]],
                          ["b", [T("b", "f")]]]);
  const s = summarize(groups, o);
  assert.equal(s.overRow, 6);
  assert.deepEqual(s.overTop.map((r) => r.key), ["a/big1", "a/big2", "a/big3", "a/big4", "a/big5"], "the five costliest, costliest first");
  assert.ok(Math.abs(s.estSpend - 0.001) < 1e-12, "only rows under the $0.10 ceiling are estimated");
  const text = printPlan(s, o, 0, true);
  assert.match(text, /^mode: probe-all \(default\)\n9 row\(s\)/);
  assert.match(text, /no provider is skipped/);
  assert.match(text, /\$0\.10 row ceiling/);
  assert.match(text, /\$5\.00 cap/);
  assert.match(text, /6 paid row\(s\) whose worst case exceeds \$0\.10 will be skipped \(recorded skip:row-cost\)/);
  assert.match(text, /\$0\.30  a\/big1/);
  assert.match(text, /and 1 more/);
  assert.match(text, /worst case ~\$/, "the worst-case exposure is printed next to the estimate");
  assert.match(text, /ESTIMATE/);
  assert.match(text, /not a hard bound/);
  assert.match(text, /refused or errored requests .* normally not billed/);
  assert.doesNotMatch(text, /failed probes .* are not billed by providers/, "the old absolute claim is gone");
  assert.match(text, /OPTIMISTIC .* worst case ~/, "the ETA says it is optimistic and gives a bound");
  assert.match(text, /stops itself after 150 min \(--max-minutes\)/);
  const eco = { ...parseArgs(["--economy"]), avgSec: null };
  const plain = printPlan(summarize(groups, eco), eco, 0, true);
  assert.match(plain, /^mode: economy \(breakers on; --economy\)/);
  assert.match(plain, /3 consecutive refusals or errors with no success mark a provider dead, and 5 pay results/);
  assert.doesNotMatch(plain, /probe-all|cooled|no provider is skipped|stops itself after/, "the economy plan describes the old behaviour only");
  assert.match(plain, /worst case exceeds \$0\.010 will be skipped/, "and the $0.01 ceiling");
});

test("the plan says the cap will bind when the estimate is above it", () => {
  const o = { ...parseArgs(["--max-spend", "1"]), avgSec: null };
  const rows = Array.from({ length: 10 }, (_, i) => T("a", `p${i}`, { free: false, cost: 0.5, worst: 0.05 }));
  const s = summarize(new Map([["a", rows]]), o);
  assert.match(printPlan(s, o, 0, true), /the cap WILL bind/);
});

test("the after-run summary lists unprobed rows by reason and count", () => {
  const o = parseArgs([]);
  assert.equal(unprobedLines({}, o), null);
  assert.equal(unprobedLines(undefined, o), null);
  const t = unprobedLines({ "row-cost": 3, "spend-cap": 12 }, o);
  assert.match(t, /15 row\(s\) remain unprobed/);
  assert.match(t, /3 over the \$0\.10 row ceiling \(row-cost\)/);
  assert.match(t, /12 past the \$5\.00 spend cap \(spend-cap\)/);
  assert.match(unprobedLines({ "provider-dead": 2 }, parseArgs([])), /2 skipped as provider-dead/);
});

test("plan: the estimate AND the worst case are both printed, with the tier the cap cuts", () => {
  const o = { ...parseArgs(["--max-spend", "1"]), avgSec: null };
  const rows = Array.from({ length: 10 }, (_, i) => T("a", `p${i}`, { free: false, cost: 0.05, worst: 0.09 }));
  const s = summarize(new Map([["a", rows]]), o);
  assert.ok(Math.abs(s.estSpend - 0.5) < 1e-9 && Math.abs(s.worstSpend - 0.9) < 1e-9);
  assert.equal(s.spendCapped, false);
  assert.equal(s.spendMayBind, false, "0.90 worst case is under the $1 cap");
  const tight = summarize(new Map([["a", rows]]), { ...o, maxSpend: 0.6 });
  assert.equal(tight.spendCapped, false); assert.equal(tight.spendMayBind, true);
  const txt = printPlan(tight, { ...o, maxSpend: 0.6 }, 0, true);
  assert.match(txt, /the worst case is above it, so it MAY bind/);
  assert.match(txt, /cheapest-first within each provider, so the cap cuts the LATE, expensive rows/);
  assert.match(txt, /skip:spend-cap are re-probed on the next run/);
});

test("the ETA is labelled optimistic and comes with a worst-case bound", () => {
  const big = Array.from({ length: 100 }, (_, i) => T("big", `m${i}`));
  const o = { ...DEFAULTS, concurrency: 8, perProvider: 2, timeoutSec: 35, avgSec: 3 };   // explicit: the arithmetic is the point
  const s = summarize(new Map([["big", big]]), o);
  assert.equal(s.wallSec, 150);
  assert.equal(s.worstWallSec, (100 * 35 * 2) / 2, "one provider hanging to the timeout, two attempts a row, two at a time");
  const txt = printPlan(s, o, 0, true);
  assert.match(txt, /OPTIMISTIC/); assert.match(txt, /worst case ~58 min/);
});

// --------------------------------------------- the option mapping main builds

test("sweepOptions: the default is probe-all (no breakers, cooling, wall-clock limit); --economy is the breakers and NO cooling", () => {
  const all = sweepOptions(parseArgs(["--live"]));
  assert.deepEqual([all.probeAll, all.coolAfter, all.coolGapMs, all.maxMs, all.maxSpend, all.maxRowCost],
    [true, 10, 400, 150 * 60000, 5, 0.1]);
  assert.equal("deadAfter" in all, false, "no breaker thresholds are passed");
  assert.deepEqual([all.outageAfter, all.outageWaitMs], [30, 10 * 60000]);
  assert.deepEqual(sweepOptions(parseArgs(["--probe-all"])), sweepOptions(parseArgs([])), "the alias maps to the same options");
  const eco = sweepOptions(parseArgs(["--live", "--economy", "--cool-after", "3", "--cool-gap-ms", "5000"]));
  assert.equal(eco.probeAll, false);
  assert.equal(eco.coolAfter, Infinity, "cooling is off in economy whatever --cool-after says");
  assert.deepEqual([eco.deadAfter, eco.unfundedAfter, eco.maxSpend, eco.maxRowCost, eco.maxMs], [3, 5, 2, 0.01, Infinity]);
  const custom = sweepOptions(parseArgs(["--outage-after", "7", "--outage-wait-min", "2", "--max-minutes", "20"]));
  assert.deepEqual([custom.outageAfter, custom.outageWaitMs, custom.maxMs], [7, 120000, 20 * 60000]);
});

const fakeTimers = () => {
  const c = { t: 1_000_000 };
  return { c, now: () => c.t, timers: {
    set: (fn, ms) => { const h = { live: true }; setImmediate(() => { if (h.live) { c.t += ms; fn(); } }); return h; },
    clear: (h) => { if (h) h.live = false; } } };
};
const failingRows = (n, free = true, tag = "") => Array.from({ length: n }, (_, i) => ({
  key: `p/m${tag}${i}`, provider: "p", id: `m${tag}${i}`, free, cost: free ? 0 : 0.001, worst: free ? 0 : 0.002 }));
const tick = () => new Promise((r) => setImmediate(r));

test("the DEFAULT run, built from the CLI's own options, probes every row of a provider that refuses all of them", async () => {
  const clk = fakeTimers();
  let calls = 0;
  const seen = [];
  const rows = [...failingRows(20), ...failingRows(20, false, "x")];
  const sum = await runSweep({ groups: new Map([["p", rows]]),
    probe: async () => { await tick(); calls += 1; return { s: calls % 2 ? "auth" : "pay", http: 401 }; },
    onResult: (r) => seen.push(r), now: clk.now, timers: clk.timers, ...sweepOptions(parseArgs(["--live"])),
    maxRetries: { rate: 2, other: 0 } });
  assert.equal(calls, 40, "every row was sent");
  assert.equal(seen.filter((r) => r.s === "skip").length, 0);
  assert.deepEqual([sum.dead, sum.unfunded, sum.skips], [[], [], {}]);
  assert.deepEqual(sum.cooled, ["p"], "politeness, not skipping");
});

test("--economy restores the breakers: the same provider is declared dead after 3 and its rows are skipped", async () => {
  const clk = fakeTimers();
  let calls = 0;
  const seen = [];
  const sum = await runSweep({ groups: new Map([["p", failingRows(20)]]),
    probe: async () => { await tick(); calls += 1; return { s: "auth", http: 401 }; },
    onResult: (r) => seen.push(r), now: clk.now, timers: clk.timers, ...sweepOptions(parseArgs(["--live", "--economy"])) });
  assert.ok(calls <= 4, `${calls} requests`);
  assert.deepEqual(sum.dead, ["p"]);
  assert.ok(seen.filter((r) => r.w === "provider-dead").length >= 16);
  assert.deepEqual(sum.cooled, []);
});

test("economy: unfunded paid rows stop after 5 pay results, as before", async () => {
  const clk = fakeTimers();
  let calls = 0;
  const seen = [];
  const sum = await runSweep({ groups: new Map([["p", failingRows(20, false)]]),
    probe: async () => { await tick(); calls += 1; return { s: "pay", http: 402 }; },
    onResult: (r) => seen.push(r), now: clk.now, timers: clk.timers, ...sweepOptions(parseArgs(["--live", "--economy"])) });
  assert.ok(calls >= 5 && calls <= 6, `${calls} paid probes`);
  assert.deepEqual(sum.unfunded, ["p"]);
  assert.ok(seen.some((r) => r.w === "unfunded"));
});

test("an economy run driven by the CLI's own option mapping is not throttled after one ok then many failures", async () => {
  const clk = fakeTimers();
  const rows = failingRows(14);
  let n = 0;
  const probe = async () => { await tick(); return n++ === 0 ? { s: "ok", t: 1, d: 2, o: 5, p: "hi", k: 0 } : { s: "auth", http: 401 }; };
  const sum = await runSweep({ groups: new Map([["p", rows]]), probe, onResult: () => {}, now: clk.now, timers: clk.timers,
    ...sweepOptions(parseArgs(["--live", "--economy", "--cool-after", "3"])), backoffBaseMs: 1 });
  assert.deepEqual(sum.cooled, []);
  assert.equal(clk.c.t, 1_000_000, "no gap timer ever fired: nothing was throttled");
  assert.equal(sum.probes, 14);
});

test("exit codes: 0 for a normal outcome or a Ctrl-C, 3 when probes were sent and nothing answered ok, 4 when the gateway never came back", () => {
  assert.equal(sweepExit({ probes: 10, counts: { ok: 4, auth: 6 }, stopped: null }), 0);
  assert.equal(sweepExit({ probes: 10, counts: { auth: 10 }, stopped: null }), 3);
  assert.equal(sweepExit({ probes: 10, counts: {}, stopped: null }), 3);
  assert.equal(sweepExit({ probes: 0, counts: { skip: 5 }, stopped: null }), 0, "nothing was sent: not a failure");
  assert.equal(sweepExit({ probes: 3, counts: { auth: 3 }, stopped: "signal" }), 0, "the user stopped it");
  assert.equal(sweepExit({ probes: 3, counts: { auth: 3 }, stopped: "time" }), 3);
  assert.equal(sweepExit({ probes: 3, counts: { ok: 1 }, stopped: "outage", outage: { gaveUp: true } }), 4);
});

test("new flags parse and reject bad values", () => {
  const o = parseArgs(["--outage-after", "12", "--outage-wait-min", "0.5", "--max-minutes", "45"]);
  assert.deepEqual([o.outageAfter, o.outageWaitMin, o.maxMinutes], [12, 0.5, 45]);
  for (const argv of [["--outage-after", "0"], ["--outage-after", "2.5"], ["--outage-wait-min", "-1"], ["--max-minutes", "x"], ["--max-minutes"]]) {
    assert.ok(parseArgs(argv).error, JSON.stringify(argv));
  }
});

// ------------------------------------------------ the 240 s probe timeout

test("the plan is honest about a 240 s timeout: worst case in hours, and the --max-minutes stop named as the real backstop", () => {
  const o = { ...parseArgs([]), avgSec: 3 };
  assert.equal(o.timeoutSec, 240);
  const rows = Array.from({ length: 400 }, (_, i) => T("big", `m${i}`));
  const s = summarize(new Map([["big", rows]]), o);
  assert.equal(s.worstWallSec, (400 * 240 * 2) / 2, "one provider hanging on every row: two attempts, two at a time");
  const text = printPlan(s, o, 0, true);
  assert.match(text, /240s timeout -- OPTIMISTIC \(typical answer times\); worst case ~27 h if providers hang to the timeout/);
  assert.match(text, /the run stops itself after 150 min \(--max-minutes\) -- the worst case above is 11x longer, so THAT stop is the real backstop; probes still in flight are dropped/);
  const eco = { ...parseArgs(["--economy"]), avgSec: 3 };
  assert.match(printPlan(summarize(new Map([["big", rows]]), eco), eco, 0, true), /no wall-clock limit \(economy\): add --max-minutes N/);
  const small = summarize(new Map([["a", [T("a", "x")]]]), o);
  assert.doesNotMatch(printPlan(small, o, 0, true), /THAT stop/, "no backstop claim when the worst case fits inside the limit");
  assert.match(printPlan(small, o, 0, true), /worst case ~4 min/);
});

test("--timeout still overrides the default, and feeds the outage idle trigger (one full timeout plus a minute)", () => {
  assert.equal(parseArgs(["--timeout", "35"]).timeoutSec, 35);
  assert.equal(sweepOptions(parseArgs([])).outageIdleMs, 300000, "240 s + 60 s");
  assert.equal(sweepOptions(parseArgs(["--timeout", "35"])).outageIdleMs, 95000);
  assert.equal(sweepOptions(parseArgs(["--economy"])).outageIdleMs, 300000, "both modes");
});

// ------------------------------------------------ the stream cut, unpriced pricing, the health gate

test("--stream-cut: default is 4 x max_tokens, 0 turns it off, an explicit value moves it; bad values are errors", () => {
  assert.equal(parseArgs([]).streamCut, null);
  assert.equal(cutTokens(parseArgs([])), 384);
  assert.equal(cutTokens(parseArgs(["--max-tokens", "1024"])), 4096, "it follows --max-tokens");
  assert.equal(cutTokens(parseArgs(["--stream-cut", "0"])), 0);
  assert.equal(cutTokens(parseArgs(["--stream-cut", "200"])), 200);
  assert.equal(ceilTokens(parseArgs([])), 384, "the ceiling on what one probe can bill is the cut allowance");
  assert.equal(ceilTokens(parseArgs(["--stream-cut", "0"])), 96, "with no cut it is max_tokens");
  assert.equal(ceilTokens(parseArgs(["--stream-cut", "50"])), 96, "and never below max_tokens");
  for (const argv of [["--stream-cut"], ["--stream-cut", "-1"], ["--stream-cut", "1.5"], ["--stream-cut", "x"]]) assert.ok(parseArgs(argv).error, JSON.stringify(argv));
});

test("the plan states the cut, the ceiling in tokens, and the documented price of unpriced rows; the wall-clock estimate does not change", () => {
  const o = { ...parseArgs([]), avgSec: 3 };
  const rows = Array.from({ length: 50 }, (_, i) => T("p", `m${i}`));
  const s = summarize(new Map([["p", rows]]), o);
  const text = printPlan(s, o, 0, true);
  assert.match(text, /at up to 384 tokens \(max_tokens 96; a stream is cut at 384, --stream-cut\)/);
  assert.match(text, /0 paid row\(s\) have no catalogue price: their cost is an ASSUMPTION \(\$0\.60 in \/ \$3\.00 out per million tokens, on the tokens the probe saw\), and they are probed after the priced rows/);
  const withUn = summarize(new Map([["p", [T("p", "a", { free: false, cost: 0.001, worst: 0.002 }), T("p", "u", { free: false, cost: 0.0002, worst: 0.001, unpriced: true }), T("p", "v", { free: false, cost: 0.0002, worst: 0.001, unpriced: true })]]]), o);
  assert.equal(withUn.unpricedRows, 2);
  assert.match(printPlan(withUn, o, 0, true), /2 paid row\(s\) have no catalogue price: their cost is an ASSUMPTION/);
  assert.match(text, /max_tokens 96, cut at 384, 240s timeout/);
  const off = { ...parseArgs(["--stream-cut", "0"]), avgSec: 3 };
  assert.match(printPlan(summarize(new Map([["p", rows]]), off), off, 0, true), /no stream cut/);
  assert.equal(summarize(new Map([["p", rows]]), off).worstWallSec, s.worstWallSec, "time bounds do not depend on the cut");
});

test("gatewayUp: one slow or failed answer does not refuse the start; the retry waits, and a persistent failure still refuses", async () => {
  const seen = [];
  const sleeps = [];
  const mk = (...outs) => async (url, init) => { seen.push({ url, hasSignal: !!init?.signal }); const o = outs.shift(); if (o instanceof Error) throw o; return { status: o }; };
  const sleep = async (ms) => { sleeps.push(ms); };
  assert.equal(await gatewayUp("http://gw", { fetchImpl: mk(200), sleep, retries: 1 }), true);
  assert.deepEqual(sleeps, [], "no retry when the first answer is fine");
  assert.equal(await gatewayUp("http://gw", { fetchImpl: mk(new Error("timeout"), 200), sleep, retries: 1 }), true, "a first failure is retried once");
  assert.deepEqual(sleeps, [2000], "after 2 s");
  assert.equal(await gatewayUp("http://gw", { fetchImpl: mk(503, 200), sleep, retries: 1 }), true, "a 5xx counts as a failed attempt");
  assert.equal(await gatewayUp("http://gw", { fetchImpl: mk(new Error("a"), new Error("b")), sleep, retries: 1 }), false, "two failures refuse");
  assert.equal(await gatewayUp("http://gw", { fetchImpl: mk(new Error("a"), 200), sleep }), false, "with no retries (the outage check) one failure is a failure");
  assert.ok(seen.every((c) => c.url === "http://gw/health" && c.hasSignal), "every attempt is a /health call with a timeout signal");
});

test("gatewayUp: each attempt gets a 10 s timeout (the old 3 s refused a busy but healthy gateway)", async () => {
  let signal;
  const fetchImpl = async (_u, init) => { signal = init.signal; return { status: 200 }; };
  await gatewayUp("http://gw", { fetchImpl });
  assert.equal(signal.aborted, false);
  const start = Date.now();
  let aborted = null;
  const slow = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { aborted = Date.now() - start; rej(new Error("aborted")); }));
  assert.equal(await gatewayUp("http://gw", { fetchImpl: slow, timeoutMs: 60 }), false);
  assert.ok(aborted >= 55 && aborted < 1000, `aborted after ${aborted} ms of a 60 ms timeout`);
});

// ------------------------------------------------ --only-file, --redact, the budget

test("--only-file and --redact parse; a missing path is an error; --redact refuses to combine", () => {
  const o = parseArgs(["--only-file", "plans/x.txt", "--only", "aihubmix", "--force", "--max-tokens", "1024", "--timeout", "90"]);
  assert.equal(o.onlyFile, "plans/x.txt"); assert.deepEqual(o.only, ["aihubmix"]);
  assert.deepEqual([o.maxTokens, o.timeoutSec, o.force], [1024, 90, true]);
  assert.equal(parseArgs([]).onlyFile, null); assert.equal(parseArgs([]).redact, false);
  assert.equal(parseArgs(["--redact"]).redact, true);
  for (const argv of [["--only-file"], ["--redact", "--live"], ["--redact", "--compact"]]) assert.ok(parseArgs(argv).error, JSON.stringify(argv));
});

test("--only with no usable entry is an error: an empty list would mean every row", () => {
  for (const v of [",", " , ,", ",,"]) assert.match(parseArgs(["--only", v]).error, /--only needs at least one provider or provider\/id/, JSON.stringify(v));
  assert.deepEqual(parseArgs(["--only", "a,,b/c"]).only, ["a", "b/c"]);
});

test("parseOnlyList: one provider/id per line, # comments, blanks, CRLF and BOM, [1m] stripped, duplicates folded", () => {
  const text = "﻿# a comment\r\naihubmix/gpt-5\r\n\r\n  openrouter/openai/o4-mini   # trailing comment\r\nkilo/qwen/x:free\r\ngoogle/gemini-2.5-flash[1m]\r\naihubmix/gpt-5\r\n";
  const { keys, errors } = parseOnlyList(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(keys, ["aihubmix/gpt-5", "openrouter/openai/o4-mini", "kilo/qwen/x:free", "google/gemini-2.5-flash"]);
  assert.deepEqual(parseOnlyList("").keys, []); assert.deepEqual(parseOnlyList("# only comments\n\n").keys, []);
});

test("parseOnlyList: a bare word is an ERROR (it would mean a whole provider), as is a line with spaces", () => {
  const r = parseOnlyList("aihubmix\nopenrouter/ok\n/leading\ntrailing/\ntwo words/x\n");
  assert.deepEqual(r.keys, ["openrouter/ok"]);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0], /line 1: expected one provider\/id, got "aihubmix"/);
  assert.match(r.errors[3], /line 5/);
});

test("withBudget records a non-default max_tokens on the result, and leaves the default and an abort alone", () => {
  assert.deepEqual(withBudget({ s: "ok", t: 1 }, 1024), { s: "ok", t: 1, b: 1024 });
  const same = { s: "ok" };
  assert.equal(withBudget(same, 96), same, "the default budget adds nothing");
  const aborted = { aborted: true };
  assert.equal(withBudget(aborted, 1024), aborted);
});

test("the checked-in re-probe lists are well-formed and every line parses", () => {
  for (const [name, expect] of [["empty55.txt", 55], ["timeout42.txt", 42]]) {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plans", "bench-study", "lists", name);
    if (!fs.existsSync(f)) continue;              // the study is optional in a checkout
    const r = parseOnlyList(fs.readFileSync(f, "utf8"));
    assert.deepEqual(r.errors, [], name);
    assert.equal(r.keys.length, expect, name);
  }
});

const cap = async (fn) => {
  const err = [], log = [], e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { code: await fn(), err, log }; } finally { console.error = e; console.log = l; }
};
const scratch = () => mkTmp("uw-redact-");
const none = () => [];

test("main --redact rewrites the given bench.json, prints the count, and releases the lock", async () => {
  const dir = scratch(); const benchFile = path.join(dir, "bench.json"); const logFile = path.join(dir, "bench.jsonl"); const lockFile = path.join(dir, "bench.lock");
  fs.writeFileSync(benchFile, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: {
    "s/a": { s: "auth", a: 1, m: "sambanova: Incorrect API key provided: 7f3a9c*****e21d." }, "o/b": { s: "ok", a: 1, t: 5, p: "hi" } } }));
  const out = await cap(() => main(["--redact"], { benchFile, logFile, lockFile, findRunning: none }));
  assert.equal(out.code, 0);
  assert.match(out.log.join("\n"), /bench: redacted 1 of 2 record\(s\) in bench\.json/);
  assert.equal(/7f3a9c/.test(fs.readFileSync(benchFile, "utf8")), false);
  assert.equal(fs.existsSync(lockFile), false, "the lock is released");
  const again = await cap(() => main(["--redact"], { benchFile, logFile, lockFile, findRunning: none }));
  assert.match(again.log.join("\n"), /redacted 0 of 2 record\(s\).*nothing needed it/);
});

test("main --redact is refused while a sweep holds the lock (exit 5), and touches nothing", async () => {
  const dir = scratch(); const benchFile = path.join(dir, "bench.json"); const lockFile = path.join(dir, "bench.lock");
  const raw = JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: { "s/a": { s: "auth", a: 1, m: "key 7f3a9c*****e21d" } } });
  fs.writeFileSync(benchFile, raw);
  acquireLock({ file: lockFile, pid: 4001, now: () => Date.now(), findRunning: none });
  const out = await cap(() => main(["--redact"], { benchFile, logFile: path.join(dir, "l"), lockFile, isAlive: (p) => p === 4001, findRunning: none }));
  assert.equal(out.code, EXIT_BUSY);
  assert.match(out.err.join("\n"), /cannot redact -- another sweep is running \(pid 4001/);
  assert.equal(fs.readFileSync(benchFile, "utf8"), raw, "the file is byte-for-byte untouched");
  const stray = await cap(() => main(["--redact"], { benchFile, logFile: path.join(dir, "l"), lockFile: path.join(dir, "other.lock"), findRunning: () => [{ pid: 24400, cmd: "x bench-cli.mjs --live" }] }));
  assert.equal(stray.code, EXIT_BUSY);
  assert.equal(fs.readFileSync(benchFile, "utf8"), raw);
});

test("main --redact on a missing file says so and exits 1", async () => {
  const dir = scratch();
  const out = await cap(() => main(["--redact"], { benchFile: path.join(dir, "none.json"), logFile: path.join(dir, "l"), lockFile: path.join(dir, "k"), findRunning: none }));
  assert.equal(out.code, 1);
  assert.match(out.err.join("\n"), /cannot redact -- no readable bench\.json/);
});

// ------------------------------------------------- the gateway credential

const settingsFile = (obj) => {
  const f = path.join(mkTmp("uw-gw-"), "settings.json");
  fs.writeFileSync(f, typeof obj === "string" ? obj : JSON.stringify(obj));
  return f;
};

test("gatewayConnection: returns the loopback base and the helper's key, trimmed", () => {
  const seen = [];
  const f = settingsFile({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/" }, apiKeyHelper: '"C:\\bin\\key.cmd"' });
  const c = gatewayConnection({ settingsFile: f, run: (h) => { seen.push(h); return "  sk-test\n"; } });
  assert.deepEqual(c, { base: "http://127.0.0.1:3456", key: "sk-test" });
  assert.deepEqual(seen, ["C:\\bin\\key.cmd"], "the helper is run once, with its quotes removed");
});

test("gatewayConnection: a NON-loopback base is refused, so the key can never be sent off the machine", () => {
  for (const base of ["https://api.example.com", "http://192.168.1.5:3456", "http://gw.internal:3456", "http://127.0.0.1.evil.com"]) {
    const f = settingsFile({ env: { ANTHROPIC_BASE_URL: base }, apiKeyHelper: "k.cmd" });
    let ran = false;
    assert.equal(gatewayConnection({ settingsFile: f, run: () => { ran = true; return "sk"; } }), null, base);
    assert.equal(ran, false, `the key helper must not even run for ${base}`);
  }
  for (const base of ["http://localhost:3456", "http://[::1]:3456"]) {
    const f = settingsFile({ env: { ANTHROPIC_BASE_URL: base }, apiKeyHelper: "k.cmd" });
    assert.ok(gatewayConnection({ settingsFile: f, run: () => "sk" }), base);
  }
});

test("gatewayConnection: missing settings, missing halves, a failing helper and an empty key are all null", () => {
  assert.equal(gatewayConnection({ settingsFile: path.join(os.tmpdir(), "uw-none", "settings.json"), run: () => "sk" }), null);
  assert.equal(gatewayConnection({ settingsFile: settingsFile("{not json"), run: () => "sk" }), null);
  assert.equal(gatewayConnection({ settingsFile: settingsFile({ apiKeyHelper: "k" }), run: () => "sk" }), null, "no base URL");
  assert.equal(gatewayConnection({ settingsFile: settingsFile({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" } }), run: () => "sk" }), null, "no helper");
  const ok = settingsFile({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1" }, apiKeyHelper: "k" });
  assert.equal(gatewayConnection({ settingsFile: ok, run: () => { throw new Error("nope"); } }), null);
  assert.equal(gatewayConnection({ settingsFile: ok, run: () => "   \n" }), null);
});

test("gatewayConnection tolerates a BOM in the settings file", () => {
  const f = settingsFile("\uFEFF" + JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" }, apiKeyHelper: "k" }));
  assert.ok(gatewayConnection({ settingsFile: f, run: () => "sk" }));
});

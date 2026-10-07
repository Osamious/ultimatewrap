// STRICT latency check of the policy router (router/uw-router.next.cjs) against the plan's numbers, as a standalone script (O4a). The suite
// (test/subagent-router.test.mjs) asserts only LOOSE ceilings, because a loaded machine or a parallel test run must not fail a build; this script is what to run on a QUIET machine:
//
//   node test/perf/subagent-router-perf.mjs
//
// It exits 1 when a number misses and prints every number it measured with its denominator. Workload: 1,800 rows over 60 providers, three batches, the BEST batch per metric is judged
// (a one-off pause of the machine is not the router's latency). It reuses the suite's harness (env, mkPolicy, bigWorld, measurePool, measureHandoff) by importing the test file with
// UW_HELPERS_ONLY=1, which registers no test; nothing here copies those helpers. Everything runs in fresh scratch trees under os.tmpdir(): no daemon, no state, no network.
import process from "node:process";

process.env.UW_HELPERS_ONLY = "1";                                  // must be set BEFORE the test file is evaluated (a dynamic import, never a static one)
const H = await import("../subagent-router.test.mjs");

const BATCHES = 3;
// the plan's numbers (6.1b E.6 and 12.6 QB-1), p99 in milliseconds
const LIMITS = { enforceWarm: 1, shadowWarm: 1, shadowNew: 1, enforceNew: 3, handoff: 3 };
const LABELS = {
  enforceWarm: "enforce, warm sticky hit", shadowWarm: "shadow, warm repeat", shadowNew: "shadow, decision of a new agent",
  enforceNew: "enforce, first decision of a NEW agent", handoff: "handoff (cooling and overlay reads active)",
};
const fmt = (x) => x.toFixed(3).padStart(8);

const per = { enforceWarm: [], shadowWarm: [], shadowNew: [], enforceNew: [], handoff: [] };
let rows = 0, providers = 0;
for (let b = 1; b <= BATCHES; b++) {
  const en = await H.measurePool("enforce", "all-providers", { rounds: 20, fresh: 400 });
  const sh = await H.measurePool("shadow", "all-providers", { rounds: 20, fresh: 400 });
  const ho = await H.measureHandoff(`p${b}`, { n: 300 });
  rows = en.rows; providers = en.providers;
  if (ho.accounted !== 300) { console.error(`FAIL: ${ho.accounted} of 300 handoff requests were accounted for`); process.exit(1); }
  const got = { enforceWarm: H.latencyStats(en.warm), enforceNew: H.latencyStats(en.fresh), shadowWarm: H.latencyStats(sh.warm), shadowNew: H.latencyStats(sh.fresh), handoff: H.latencyStats(ho.times) };
  for (const k of Object.keys(per)) per[k].push(got[k]);
  console.log(`batch ${b}/${BATCHES}: ${rows} rows over ${providers} providers`);
  for (const k of Object.keys(per)) console.log(`  ${LABELS[k].padEnd(46)} n=${String(got[k].n).padStart(5)}  p50 ${fmt(got[k].p50)} ms  p99 ${fmt(got[k].p99)} ms  max ${fmt(got[k].max)} ms`);
}

console.log(`\nbest of ${BATCHES} batches (p99, ms) against the plan's number:`);
let miss = 0;
for (const k of Object.keys(LIMITS)) {
  const best = Math.min(...per[k].map((s) => s.p99)), ok = best < LIMITS[k];
  if (!ok) miss += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${LABELS[k].padEnd(46)} ${fmt(best)} ms  (limit ${LIMITS[k]} ms)`);
}
if (miss) { console.error(`\n${miss} number(s) missed: run again on a quiet machine before judging the router`); process.exit(1); }
console.log("\nall strict latency numbers met");
process.exit(0);

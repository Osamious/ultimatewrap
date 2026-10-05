// The only entry point of the tool-fidelity probe (#121). It follows `refresh/bench-cli.mjs`: dry by default, `--live` is the consent,
// one sweep at a time (the bench's lock), the bench's pacing, cooling, outage and wall-clock rules (`runSweep`), resumable.
//
//   node refresh/tool-fidelity-cli.mjs                          plan the incremental pass (L1+L2 for every probe-ok model with no record), send nothing
//   node refresh/tool-fidelity-cli.mjs --live --only groq       probe one provider
//   node refresh/tool-fidelity-cli.mjs --live --limit 40        a sample, one model per provider first
//   node refresh/tool-fidelity-cli.mjs --levels 34 --l3 yes --live --only groq/some-model
//                                                              the large fixture and the parallel-call level, on named models
//   node refresh/tool-fidelity-cli.mjs --levels 5 --l3 yes --live --only groq     the ~400 KB step, only for models that passed L3
//   node refresh/tool-fidelity-cli.mjs --live --force --only groq   ask the requested levels again for models that have a record
//   node refresh/tool-fidelity-cli.mjs --live --retry-failed    ask again ONLY the models of class x, at the levels that failed
//   node refresh/tool-fidelity-cli.mjs --candidates policy --l3 yes --live --tf-max-tokens-per-provider 600000
//                                                              L3 and the big step for every model the router could ever pick (see CANDIDATES)
//
// WHAT RUNS. The set is every model the bench found answering (probe-ok), the `tools: false` ones included (the catalogue claim is what
// is being tested) and the Anthropic relay's excluded (known good by provenance; reported as "not probed"). A model with a record is not
// asked again by an ordinary run: results never expire, and an older fixture only earns the record a `*`. A model with a probe-ok bench
// record and no tool record is "newly discovered" and is what an incremental run picks up. A first failure is only provisional (two strikes):
// that model is asked once more by the next run before it is called failed.
//
// CANDIDATES. `--candidates policy` aims L3, L4 and the 400 KB step (for the models that pass L3) at EVERY probe-ok model on a FREE-TIER provider, whether or not
// its context is known. The tier is the provider's key tier (the compiled policy's `tiers`, or `--tiers-file`). OWNER RULE: ONLY providers whose key tier is free are probed at all (any level, L1 and L2 too); paid, free-deposit, management and
// unlabelled providers are skipped entirely (`not-free-tier (skipped for now)`), the relay and subscription are `relay-by-provenance`; `--include-tier paid[,free-deposit]` lifts
// one (five conditions; the dollar caps still apply). A model whose KNOWN context is too small for the 157 KB fixture is out (`ctx-too-small-for-fixture`), the 400 KB step is skipped below 200,000 tokens
// of known context (never a failure), an unknown context is tested. The ORDER is a priority queue and never a limit: 1 the compiled policy's allowed set with a known context
// of at least 128,000, plus the models you pin with `--allow provider/model,...`; 2 the union of every preset's allowed set; 3 other models with a known context of at least
// 128,000; 4 unknown context; 5 known context below 128,000; the policy's rank inside a level. The per-provider token cap and the spend cap stop a run; the rest stays
// `pending: cap` for the next one. The report is a COVERAGE LEDGER and prints the cost of the whole queue and the runs it takes.
// `--sample [N]` (default 60, `--seed`) is a deterministic stratified PILOT of free-tier candidates (a few per provider, mixing reasoning and plain models and the context
// classes): L1+L2+L3, plus the big step for passers; it prints the L3 failure rate among the L1+L2 passers, overall and per provider.
//
// WHAT IT COSTS. L1 and L2 are two small requests per model. L3 and L4 send the ~157 KB fixture (about 40,000 input tokens each) and the big
// step ~400 KB (about 100,000), so they need `--l3 yes` AND a named provider (`--only`) or an explicit cap (`--max-spend` or
// `--tf-max-tokens-per-provider`). The dry run prints the request, token and dollar estimates first; paid rows go through the bench's row ceiling
// and spend cap, measured on this pass's INPUT-aware estimate BEFORE each request (a probe that stops part way is charged for the levels it
// completed); a provider that reaches `--tf-max-tokens-per-provider` waits for the next run.
//
// WHAT IT WRITES. Only state/tool-fidelity.json (refresh/tool-fidelity.mjs), atomically, only under --live. Not bench.json, not the
// snapshot. Nothing here is scheduled: `runIncremental` is the function a scheduler can call.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { loadBench } from "../menu/bench-data.mjs";
import { gatewayConnection } from "../menu/ccr-client.mjs";
import { sanitizeDisplay } from "../menu/sanitize.mjs";
import { writeAtomic } from "../menu/atomic.mjs";
import { runSweep } from "./bench.mjs";
import { DEFAULTS, sweepOptions, sweepExit, gatewayUp, unprobedLines, EXIT_BUSY } from "./bench-cli.mjs";
import { acquireLock } from "./bench-lock.mjs";
import {
  REAL_FILE, KIND, SCHEMA, DEFAULT_TOKENS_PER_PROVIDER, DEFAULT_LEVELS, loadFidelity, saveFidelity, probeSet, fidelityCounts, queueFor, selectOnly, limitEntries,
  estimate, paidFallback, applyProviderCap, buildRecord, loadPolicy, loadTiers, POLICY_FILE, selectCandidates, ledgerUniverses, coverage, coverageLines, updatePending,
  presetUnion, drawSample, l3Rates, envelope, LIFTABLE_TIERS, BIG_MIN_CTX, liftDeepProbes, clampDeep, migrateStrikes, migrateTransient, gatewayInsights, restrictToFree, NOT_FREE_REASON, loadTiersInfo, describeTiers, TIERS_STALE_DAYS, levelCosts, wallEstimate, orderCosts, DEEP_REASON, DEEP_TIERS,
} from "./tool-fidelity.mjs";
import { FIXTURE_ID } from "./tool-fidelity-fixture.mjs";
import { probeModel, PROBE_MAX_TOKENS, ESCALATED_MAX_TOKENS, TIMEOUTS_MS, TIMEOUT_CAPS_MS, TIMEOUT_FACTOR, timeoutsFor, BUDGETS, kindSize, deepAllowed } from "./tool-fidelity-probe.mjs";

const NUMERIC = {
  "--limit": ["limit", true], "--tf-max-tokens-per-provider": ["tfMaxTokens", true], "--max-spend": ["maxSpend", false], "--max-row-cost": ["maxRowCost", false],
  "--max-tokens": ["maxTokens", true], "--concurrency": ["concurrency", true], "--per-provider": ["perProvider", true], "--timeout": ["timeoutSec", false],
  "--max-minutes": ["maxMinutes", false], "--pending-runs": ["pendingRuns", true],
  "--timeout-small": ["timeoutSmall", false], "--timeout-157": ["timeout157", false], "--timeout-big": ["timeoutBig", false],
  "--timeout-max-small": ["timeoutMaxSmall", false], "--timeout-max-157": ["timeoutMax157", false], "--timeout-max-big": ["timeoutMaxBig", false],
};
export const LIFT_PREVIEW = "  lifting would cost, per tier (computed as if --live were given):";
const PRICED_OVER_ROW = "priced-over-row-cap";   // a model on a free-tier key whose listing has a price above the row ceiling: pending, never an error
const RATE_PAUSE_AFTER = 3;                         // consecutive rate limits after which a provider is left alone for the rest of the run
const SAVE_EVERY = 25;
const usd = (v) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
const num = (n) => Math.round(n).toLocaleString("en-US");
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const show = (s, max = 60) => sanitizeDisplay(s, max);                      // provider names and ids are provider-controlled text
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDur = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} days`);

/** Parses `--levels`: digits 1-7 with optional commas or plus signs ("12", "1,2", "34", "5", "1234567"); each at most once. 3 is the constructs + 157 KB request (4, parallel calls, rides in it), 5 the big step, 6 spawn, 7 the error result. */
export function parseLevels(text) {
  const digits = String(text).replace(/[,+\s]/g, "");
  if (!/^[1-7]+$/.test(digits) || new Set(digits).size !== digits.length) return null;
  return [...digits].map(Number).sort((a, b) => a - b);
}

/** Parses argv into options, or `{ error }`. */
export function parseArgs(argv) {
  const o = { ...DEFAULTS, maxTokens: null, order: "l3-first", timeoutSmall: TIMEOUTS_MS.small / 1000, timeout157: TIMEOUTS_MS["157"] / 1000, timeoutBig: TIMEOUTS_MS.big / 1000, timeoutMaxSmall: TIMEOUT_CAPS_MS.small / 1000, timeoutMax157: TIMEOUT_CAPS_MS["157"] / 1000, timeoutMaxBig: TIMEOUT_CAPS_MS.big / 1000, tfMaxTokens: DEFAULT_TOKENS_PER_PROVIDER, levels: [...DEFAULT_LEVELS], live: false, force: false, retryFailed: false, l3: false, only: null, limit: null, economy: false,
    candidates: false, policyFile: null, tiersFile: null, includeTiers: [], allow: [], pendingRuns: 3, levelsExplicit: false, sample: 0, seed: "1" };
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") o.live = true;
    else if (a === "--force") o.force = true;
    else if (a === "--retry-failed") o.retryFailed = true;
    else if (a === "--merge-unsaved") o.mergeUnsaved = true;
    else if (a === "--reset-awkward-json") o.resetAwkwardJson = true;
    else if (a === "--reset-transient") o.resetTransient = true;
    else if (a === "--only-gateway") o.onlyGateway = true;
    else if (a === "--l3") { if (argv[++i] !== "yes") return { error: "--l3 needs the word yes (it allows the 157 KB level 3 and level 4 requests and the 400 KB big step)" }; o.l3 = true; }
    else if (a === "--levels") {
      const l = parseLevels(argv[++i]);
      if (!l) return { error: "--levels needs digits from 1 to 7, each at most once, e.g. 12 (the default), 34, 5 (the big step), 6 (spawn) or 1234567" };
      o.levels = l; o.levelsExplicit = true;
    } else if (a === "--order") {
      o.order = argv[++i];
      if (o.order !== "l3-first" && o.order !== "big-first") return { error: "--order needs l3-first (the default) or big-first" };
    } else if (a === "--candidates") {
      if (argv[++i] !== "policy") return { error: "--candidates only knows the word policy (the compiled policy's allowed set)" };
      o.candidates = true;
    } else if (a === "--sample") {
      o.sample = argv[i + 1] && /^\d+$/.test(argv[i + 1]) ? Number(argv[++i]) : 60;
      if (!(o.sample >= 1)) return { error: "--sample needs a positive number of models (default 60)" };
      o.candidates = true;
    } else if (a === "--seed") {
      o.seed = argv[++i];
      if (!o.seed) return { error: "--seed needs a value (any text or number)" };
    } else if (a === "--include-tier") {
      o.includeTiers = (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!o.includeTiers.length || o.includeTiers.some((x) => !LIFTABLE_TIERS.includes(x))) return { error: `--include-tier needs one or more of ${LIFTABLE_TIERS.join(", ")} (free is always included)` };
    } else if (a === "--key-choices-file") {
      o.keyChoicesFile = argv[++i];
      if (!o.keyChoicesFile) return { error: "--key-choices-file needs a path (a {provider: key id} file: the owner's key choices)" };
    } else if (a === "--tiers-file") {
      o.tiersFile = argv[++i];
      if (!o.tiersFile) return { error: "--tiers-file needs a path (a {provider: tier} file or the vault registry)" };
    } else if (a === "--policy-file") {
      o.policyFile = argv[++i];
      if (!o.policyFile) return { error: "--policy-file needs a path (a compiled policy.json)" };
    } else if (a === "--allow") {
      o.allow = (argv[++i] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (!o.allow.length || o.allow.some((x) => !x.includes("/"))) return { error: "--allow needs provider/model, comma separated" };
    } else if (a === "--only") {
      const v = argv[++i];
      o.only = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!o.only.length) return { error: "--only needs a provider or provider/model, e.g. --only groq,openrouter/some-model (an empty list would mean every model)" };
    } else if (NUMERIC[a]) {
      const [key, integer] = NUMERIC[a];
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) return { error: `${a} needs a positive ${integer ? "integer" : "number"}` };
      o[key] = v; explicit.add(key);
    } else return { error: `unrecognised argument ${JSON.stringify(a)}` };
  }
  if (o.candidates && o.retryFailed) return { error: "--candidates and --retry-failed are different passes: run them one at a time" };
  if (!o.candidates && (o.allow.length || o.includeTiers.length)) return { error: "--allow and --include-tier go with --candidates policy" };
  if (o.keyChoicesFile && !o.tiersFile) return { error: "--key-choices-file goes with --tiers-file (the vault registry): a compiled policy already holds the compiler's key choice" };
  if (o.candidates && !o.levelsExplicit) o.levels = [1, 2, 3, 4, 5, 6, 7];   // L1+L2 for the ones with no result, then L3 (with L4 inside it), the big step, spawn and the error result
  if (o.onlyGateway && !o.retryFailed) return { error: "--only-gateway goes with --retry-failed: it asks again only the models whose failure was the gateway's request translation (xw gateway)" };
  if (o.retryFailed && o.force) return { error: "--retry-failed and --force contradict each other (retry-failed asks again only the failed levels of failed models)" };
  for (const [lo, hi, name] of [["timeoutSmall", "timeoutMaxSmall", "small"], ["timeout157", "timeoutMax157", "157"], ["timeoutBig", "timeoutMaxBig", "big"]]) {
    if (o[lo] > o[hi]) return { error: `the ${name} timeout floor (${o[lo]} s) is above its cap (${o[hi]} s): raise --timeout-max-${name} or lower --timeout-${name}` };
  }
  o.explicit = explicit;
  return o;
}

/** The plan of one invocation, with every figure computed and nothing sent. Pure over its inputs. */
export function plan({ snap, bench, store, o, policy = null, pending = {}, tiers = null, presetKeys = null, presetNote = null, printed = false, tierMeta = null, nowMs = Date.now() }) {
  const fullSet = probeSet(snap, bench);
  // candidates: every probe-ok free-tier model, in priority order; otherwise the whole probe set in its own order
  // deep levels (above L2) are for tier `free` only: a lift needs --include-tier AND an explicit --levels AND --live AND an explicit --max-spend AND this printed estimate
  const lift = o.includeTiers?.length ? liftDeepProbes({ includeTiers: o.includeTiers, levelsExplicit: !!o.levelsExplicit, levels: o.levels, live: !!o.live, maxSpendExplicit: !!o.explicit?.has("maxSpend"), printed: !!printed }) : { ok: false, missing: [] };
  // what is still missing once the cost preview of THIS invocation has been printed (reporting only: the capability the engine uses is the one above, made only after main saw the preview printed)
  const missingAfterPrint = !o.includeTiers?.length || lift.ok ? [] : (liftDeepProbes({ includeTiers: o.includeTiers, levelsExplicit: !!o.levelsExplicit, levels: o.levels, live: !!o.live, maxSpendExplicit: !!o.explicit?.has("maxSpend"), printed: true }).missing ?? []);
  const liftCap = lift.ok ? lift.lift : null;
  // the owner's rule: only providers whose key tier is free are probed at all (a lifted tier too, once the five conditions hold): the rest are out of the probe set and counted
  const set = restrictToFree(fullSet, tiers, liftCap);
  const counts = fidelityCounts(set, store);
  const all = o.candidates ? selectCandidates({ set, policy, tiers: tiers ?? {}, includeTiers: lift.ok ? lift.lift.tiers : [], requestedTiers: o.includeTiers ?? [], pins: o.allow ?? [], presetKeys, maxTokens: o.maxTokens }) : null;
  let cand = all, sample = null;
  if (all && o.sample) {
    sample = drawSample({ entries: all.entries, n: o.sample, seed: o.seed ?? "1" });
    const keep = new Set(sample.entries.map((e) => e.key));
    cand = { ...all, entries: sample.entries, excluded: [...all.excluded, ...all.entries.filter((e) => !keep.has(e.key)).map((e) => ({ key: e.key, reason: "not-in-sample" }))] };
  }
  const base = cand ? { ...set, models: cand.entries } : set;
  // the big step is not asked of a model whose KNOWN context is below BIG_MIN_CTX (never recorded as a failure)
  let bigSkipped = 0;
  const asked = queueFor(base, store, o.levels, { force: o.force, retryFailed: o.retryFailed }).map((e) => {
    if (!e.todo.includes(5) || !(e.ctx > 0 && e.ctx < BIG_MIN_CTX)) return e;
    bigSkipped += 1;
    return { ...e, todo: e.todo.filter((l) => l !== 5) };
  }).filter((e) => e.todo.length);
  if (o.onlyGateway) { const keep = asked.filter((e) => e.prior?.xw === "gateway"); asked.length = 0; asked.push(...keep); }
  const tierOf = (e) => e.tier ?? tiers?.[e.provider] ?? null;
  const tiered = asked.map((e) => ({ ...e, tier: tierOf(e) }));
  const cl = clampDeep(tiered, { lift: liftCap });
  const queued = limitEntries(selectOnly(cl.entries, o.only), o.limit);
  const fallback = paidFallback(fullSet.models);                      // the whole set, so a narrowed run is charged like a full one
  const est = estimate(queued, { maxTokens: o.maxTokens, fallback });
  const { kept, waiting, tooBig, needed } = applyProviderCap(est.entries, o.tfMaxTokens);
  const run = estimate(kept, { maxTokens: o.maxTokens, fallback });
  // free-tier keys whose listing carries a price are costed at it: how many, what they cost at full depth, and which are over the row ceiling (they stay pending: priced-over-row-cap)
  const pricedOnFree = estimate(queued.filter((e) => e.pricedOnFree).map((e) => ({ ...e, todo: [1, 2, 3, 5, 6, 7] })), { maxTokens: o.maxTokens, fallback });
  const overRowAll = est.entries.filter((e) => e.pricedOnFree && e.cost > o.maxRowCost).length;                // over the ceiling at the levels this run asks, in the whole queue
  const overRow = new Set(run.entries.filter((e) => e.pricedOnFree && e.cost > o.maxRowCost).map((e) => e.key));   // and the ones of them that would run this time
  // the cost of lifting, per tier, at the levels asked and as if --live were given: the numbers a person approves BEFORE the paid tier is touched
  let liftPreview = null;
  if (all && o.includeTiers?.length) {
    const want = o.includeTiers.filter((t) => DEEP_TIERS.includes(t));
    const wantSet = { ...fullSet, models: fullSet.models.filter((e) => want.includes(tiers?.[e.provider])) };
    const prev = selectCandidates({ set: wantSet, policy, tiers: tiers ?? {}, includeTiers: want, requestedTiers: [], pins: o.allow ?? [], presetKeys, maxTokens: o.maxTokens });
    const rows = prev.entries.filter((e) => want.includes(e.tier));
    const asked2 = queueFor({ ...wantSet, models: rows }, store, o.levels, { force: o.force, retryFailed: o.retryFailed }).map((e) => (!e.todo.includes(5) || !(e.ctx > 0 && e.ctx < BIG_MIN_CTX) ? e : { ...e, todo: e.todo.filter((l) => l !== 5) })).filter((e) => e.todo.length);
    liftPreview = Object.fromEntries(want.map((t) => { const x = estimate(asked2.filter((e) => e.tier === t), { maxTokens: o.maxTokens, fallback }); return [t, { models: x.entries.length, requests: x.requests, inTokens: x.inTokens, usd: x.usd }]; }));
  }
  const planned = (levels) => Object.fromEntries([...kept.map((e) => [e.key, overRow.has(e.key) ? PRICED_OVER_ROW : "queued"]), ...waiting.map((e) => [e.key, "cap"]), ...tooBig.map((e) => [e.key, "cap"])]
    .filter(([k]) => [...kept, ...waiting, ...tooBig].find((e) => e.key === k).todo.some((l) => levels.includes(l))));
  const universes = ledgerUniverses({ set, cand });
  const deepOk = (key) => deepAllowed(tiers?.[key.slice(0, key.indexOf("/"))] ?? null, liftCap);
  const ledger = { l12: coverage(universes.l12, store, { level: "l12", pending, plan: planned([1, 2]), stuckRuns: o.pendingRuns ?? 3, deepOk }),
                   l3: universes.l3 ? coverage(universes.l3, store, { level: "l3", pending, plan: planned([3]), stuckRuns: o.pendingRuns ?? 3, deepOk }) : null };
  const ttfts = queued.map((e) => bench?.get?.(e.key)?.t).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  const latencyMs = ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : 3000;
  const heavy = kept.some((e) => e.kinds.some((k) => kindSize(k).bytes >= 100000));
  const perProvider = heavy ? 1 : o.perProvider ?? 2;
  const floorS = o.timeoutSmall * 1000, capS = o.timeoutMaxSmall * 1000;
  const smalls = kept.map((e) => timeoutsFor(bench?.get?.(e.key), { small: floorS, "157": o.timeout157 * 1000, big: o.timeoutBig * 1000 }, { small: capS, "157": o.timeoutMax157 * 1000, big: o.timeoutMaxBig * 1000 }).small).sort((a, b) => a - b);
  const timeoutStats = smalls.length ? `${Math.round(smalls[0] / 1000)} s at the least, ${Math.round(smalls[Math.floor(smalls.length / 2)] / 1000)} s median, ${Math.round(smalls.at(-1) / 1000)} s at the most` : null;
  const wall = wallEstimate(run.entries, { concurrency: o.concurrency ?? 8, perProvider, latencyMs });
  return { gateway: gatewayInsights(store), timeoutStats, overRowAll, liftPreview, missingAfterPrint, tierInfo: tiers ? describeTiers({ info: tierMeta?.info ?? null, source: tierMeta?.source ?? "tiers given by the caller", tiers, providers: fullSet.models.map((m) => m.provider), nowMs }) : null, pricedOnFree, overRow: overRow.size, set, counts, queued, est, run, kept, waiting, tooBig, needed, cand, ledger, sample, bigSkipped, presetNote, envelope: envelope(est.entries, o.tfMaxTokens), lift, clamped: cl.clamped, fullSet, wall, latencyMs, heavy, perProvider, tiers };
}

/** Where the provider tiers came from, how old they are and which providers they do not cover (printed in the plan and in the report). */
export function tierLines(p) {
  const L = [];
  if (p.tierInfo) {
    const t = p.tierInfo, age = t.ageDays === null ? "age unknown" : `${t.stampIs} ${t.stamp.slice(0, 16).replace("T", " ")}, ${t.ageDays < 1 ? "under a day" : `${Math.round(t.ageDays * 10) / 10} days`} old`;
    L.push(`  provider tiers: ${t.source} (${age}); ${num(t.absent.length)} of ${num(new Set(p.fullSet.models.map((m) => m.provider)).size)} provider(s) with probe-ok models have no tier in it${t.absent.length ? ` (${show(t.absent.slice(0, 6).join(", "), 120)}${t.absent.length > 6 ? ", ..." : ""}: default-deny: not probed at all)` : ""}${t.conflicts.length ? `; ${num(t.conflicts.length)} provider(s) with keys of different tiers take the most restrictive one` : ""}`);
    if (t.absent.length) L.push(`  WARNING: ${num(t.absent.length)} provider(s) with probe-ok models are missing from the tier map: they count as NOT free (default-deny), so they are not probed at all; refresh the policy or the tiers file if some of them have a free key`);
    for (const d of t.detail.slice(0, 12)) L.push(show(`  keys of ${d.provider}: ${d.keys} (${d.tiers.join(", ")}) -> ${d.tier}, ${d.how === "choice" ? `the owner's key choice (${d.id})` : d.how === "same-tier" ? "all of one tier, no choice needed" : d.how === "management-ignored" ? "the management key is ignored" : "NO key choice, so the most restrictive tier"}`, 200));
    if (t.detail.length > 12) L.push(`  ... and ${t.detail.length - 12} more provider(s) with several keys`);
    if (t.conflicts.length) L.push(`  providers that fell back to the most restrictive tier (no key choice recorded): ${show(t.conflicts.join(", "), 300)}`);
    if (t.stale) L.push(`  WARNING: the provider tiers are older than ${TIERS_STALE_DAYS} days: recompile the policy (or pass a fresh --tiers-file) before trusting who counts as free`);
  }
  return L;
}

/**
 * `--merge-unsaved`: puts the records of `tool-fidelity.unsaved.json` (written next to the state file when a final save failed) back into the state file. Dry by default (counts only); with
 * `--live` a record is taken when the state file has none for the model or the side file's is newer, the file is written under the lock, and the side file is deleted only after that save.
 */
async function mergeUnsaved(o, outFile, deps) {
  const side = path.join(path.dirname(outFile), "tool-fidelity.unsaved.json");
  const u = loadFidelity(side);
  if (!u.ok) { console.error(`tool-fidelity: ${path.basename(side)} is ${u.reason}; nothing was merged`); return 1; }
  if (u.absent) { console.log(`tool-fidelity: no ${path.basename(side)} next to ${path.basename(outFile)}: nothing to merge`); return 0; }
  const cur = loadFidelity(outFile);
  if (!cur.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is ${cur.reason}; nothing was merged`); return 1; }
  const take = Object.keys(u.models).filter((k) => !cur.models[k] || Date.parse(u.models[k].at) > Date.parse(cur.models[k].at));
  console.log(`tool-fidelity: ${path.basename(side)} holds ${num(Object.keys(u.models).length)} record(s): ${num(take.length)} would be taken (new, or newer than the state file's), ${num(Object.keys(u.models).length - take.length)} left alone`);
  if (!o.live) { console.log("nothing was written. Re-run with --merge-unsaved --live to merge."); return 0; }
  if (!take.length) { console.log("tool-fidelity: nothing newer to merge; the side file is left where it is"); return 0; }
  const got = acquireLock({ ...(deps.lockFile ? { file: deps.lockFile } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}), ...(deps.findRunning ? { findRunning: deps.findRunning } : {}), mode: "tool-fidelity", maxMinutes: o.maxMinutes });
  if (!got.ok) { console.error(`tool-fidelity: ${got.message}`); return EXIT_BUSY; }
  try {
    const fresh = loadFidelity(outFile);
    if (!fresh.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is now ${fresh.reason}; nothing was merged`); return 1; }
    const merged = { ...fresh.models };
    for (const k of take) if (!merged[k] || Date.parse(u.models[k].at) > Date.parse(merged[k].at)) merged[k] = u.models[k];
    (deps.saveImpl ?? saveFidelity)(outFile, merged, { live: true, now: (deps.now ?? (() => new Date()))(), preserve: fresh.rejected ?? {}, pending: fresh.pending ?? {} });
    try { fs.unlinkSync(side); } catch (e) { console.error(`tool-fidelity: merged, but could not delete ${path.basename(side)} (${e?.message ?? e})`); }
    console.log(`tool-fidelity: ${num(take.length)} record(s) merged into ${path.basename(outFile)}; ${path.basename(side)} removed`);
    return 0;
  } catch (e) { console.error(`tool-fidelity: could not merge (${e?.message ?? e}); the side file is untouched`); return 1; }
  finally { got.release(); }
}

/** Why a model that did not get a result ends the run pending: the short code kept in the pending map (a reason is never an error, and never a verdict). */
export function pendingReasonOf(r, entry) {
  if (r.reason === "reasoning-budget" || r.reason === "request-cap" || r.reason === "slow") return r.reason;
  if (r.s !== "skip") return r.s;
  if (r.w === "spend-cap") return "spend";
  if (r.w === "row-cost") return entry?.pricedOnFree ? PRICED_OVER_ROW : "row-cost";
  if (r.w === "rate-paused") return "rate";
  return r.w ?? "skip";
}

/**
 * `--reset-awkward-json`: clears the strikes (and confirmed failures) that the old awkward-content L1 produced ("tool call arguments are not valid JSON", or a server's refusal of the AUTO
 * tool choice), so the next run asks L1 again with the plain echo call. Dry by default (counts only); `--live` applies it under the lock, atomically.
 */
async function resetAwkward(o, outFile, deps) {
  const cur = loadFidelity(outFile);
  if (!cur.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is ${cur.reason}; nothing was changed`); return 1; }
  const plan1 = migrateStrikes(cur.models);
  const by = (f) => { const x = {}; for (const c of plan1.cleared) x[f(c)] = (x[f(c)] ?? 0) + 1; return Object.entries(x).map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none"; };
  const total = Object.keys(cur.models).length;
  console.log(`tool-fidelity: ${num(plan1.cleared.length)} of ${num(total)} record(s) came from the awkward-content L1 or a refused auto tool choice: ${by((c) => c.kind === "strike" ? "first strikes" : "confirmed failures")}; reason: ${by((c) => c.reason)}; ${num(plan1.cleared.filter((c) => c.removed).length)} would be removed (asked again from scratch), ${num(plan1.cleared.filter((c) => !c.removed).length)} keep their other results`);
  const prov = {};
  for (const c of plan1.cleared) { const p = c.key.slice(0, c.key.indexOf("/")); prov[p] = (prov[p] ?? 0) + 1; }
  const top = Object.entries(prov).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${show(k, 18)} ${num(n)}`).join(", ");
  if (top) console.log(`  by provider: ${top}`);
  if (!o.live) { console.log("nothing was written. Re-run with --reset-awkward-json --live to apply it."); return 0; }
  if (!plan1.cleared.length) { console.log("tool-fidelity: nothing to clear"); return 0; }
  const got = acquireLock({ ...(deps.lockFile ? { file: deps.lockFile } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}), ...(deps.findRunning ? { findRunning: deps.findRunning } : {}), mode: "tool-fidelity", maxMinutes: o.maxMinutes });
  if (!got.ok) { console.error(`tool-fidelity: ${got.message}`); return EXIT_BUSY; }
  try {
    const fresh = loadFidelity(outFile);
    if (!fresh.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is now ${fresh.reason}; nothing was changed`); return 1; }
    const m = migrateStrikes(fresh.models);
    const pending = { ...(fresh.pending ?? {}) };
    for (const c of m.cleared) delete pending[c.key];
    (deps.saveImpl ?? saveFidelity)(outFile, m.store, { live: true, now: (deps.now ?? (() => new Date()))(), preserve: fresh.rejected ?? {}, pending });
    console.log(`tool-fidelity: ${num(m.cleared.length)} record(s) cleared in ${path.basename(outFile)}; the next run asks L1 again with the plain echo call`);
    return 0;
  } catch (e) { console.error(`tool-fidelity: could not save (${e?.message ?? e}); nothing was changed`); return 1; }
  finally { got.release(); }
}

/**
 * `--reset-transient`: clears the records an AVAILABILITY or unnamed 400 produced ("The selected model is temporarily unavailable. Try another model.", "Upstream request failed.", ...: never a verdict
 * about tools) and tags the failures caused by the gateway's request translation (`xw: gateway`, they stay x). Dry by default (counts per shape and provider); `--live` applies it under the lock, atomically.
 */
async function resetTransient(o, outFile, deps) {
  const cur = loadFidelity(outFile);
  if (!cur.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is ${cur.reason}; nothing was changed`); return 1; }
  const m1 = migrateTransient(cur.models);
  const tally = (list, f) => { const x = {}; for (const c of list) x[f(c)] = (x[f(c)] ?? 0) + 1; return Object.entries(x).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none"; };
  console.log(`tool-fidelity: ${num(m1.cleared.length)} of ${num(Object.keys(cur.models).length)} record(s) came from an availability or unnamed refusal, never a verdict about tools: ${tally(m1.cleared, (c) => (c.kind === "strike" ? "first strikes" : "confirmed failures"))}; shapes: ${tally(m1.cleared, (c) => c.shape)}; ${num(m1.cleared.filter((c) => c.removed).length)} would be removed (asked again from scratch), ${num(m1.cleared.filter((c) => !c.removed).length)} keep their other results`);
  const prov = {};
  for (const c of m1.cleared) { const p = c.key.slice(0, c.key.indexOf("/")); prov[p] = (prov[p] ?? 0) + 1; }
  const top = Object.entries(prov).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${show(k, 18)} ${num(n)}`).join(", ");
  if (top) console.log(`  by provider: ${top}`);
  console.log(`  failures caused by the gateway's request translation: ${num(m1.tagged.length)} would be tagged xw gateway (they stay x)`);
  console.log(`  argument-fidelity failures that came from the old test content (a path with an escape look-alike, an optional parameter left out): ${num(m1.afReset.length)} would be cleared (ask again with --force --levels 1 --only provider/model)`);
  if (!o.live) { console.log("nothing was written. Re-run with --reset-transient --live to apply it."); return 0; }
  if (!m1.cleared.length && !m1.tagged.length && !m1.afReset.length) { console.log("tool-fidelity: nothing to change"); return 0; }
  const got = acquireLock({ ...(deps.lockFile ? { file: deps.lockFile } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}), ...(deps.findRunning ? { findRunning: deps.findRunning } : {}), mode: "tool-fidelity", maxMinutes: o.maxMinutes });
  if (!got.ok) { console.error(`tool-fidelity: ${got.message}`); return EXIT_BUSY; }
  try {
    const fresh = loadFidelity(outFile);
    if (!fresh.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is now ${fresh.reason}; nothing was changed`); return 1; }
    const m = migrateTransient(fresh.models);
    const pending = { ...(fresh.pending ?? {}) };
    for (const c of m.cleared) delete pending[c.key];
    (deps.saveImpl ?? saveFidelity)(outFile, m.store, { live: true, now: (deps.now ?? (() => new Date()))(), preserve: fresh.rejected ?? {}, pending });
    console.log(`tool-fidelity: ${num(m.cleared.length)} record(s) cleared, ${num(m.tagged.length)} tagged xw gateway and ${num(m.afReset.length)} argument-fidelity result(s) cleared in ${path.basename(outFile)}; the next run asks the cleared ones again`);
    return 0;
  } catch (e) { console.error(`tool-fidelity: could not save (${e?.message ?? e}); nothing was changed`); return 1; }
  finally { got.release(); }
}

/** The insights block: the failures caused by the gateway's own request translation (fixable there), by provider, with the provider's words. */
export function gatewayLines(g) {
  if (!g.length) return [];
  return [`  failing because of the gateway's request translation (fixable there, not limits of the models; they stay x for routing; \`--retry-failed --only-gateway\` asks them again after a fix): ${num(g.reduce((a, x) => a + x.n, 0))} record(s)`,
    ...g.slice(0, 10).map((x) => `    ${x.provider}: ${x.n} -- ${x.hint}`)];
}

/** The text of the dry run. */
export function printPlan(p, o) {
  const c = p.counts, L = [];
  const big = p.queued.some((e) => e.todo.some((l) => l >= 3));
  const lv = o.retryFailed ? "the failed levels of failed models" : o.levels.map((l) => (l === 5 ? "big" : `L${l}`)).join("+");
  L.push(`tool-fidelity: ${o.live ? "LIVE" : "DRY RUN, nothing is sent"}  fixture ${FIXTURE_ID}  levels ${lv}  ${o.force ? "force (asks again)" : o.retryFailed ? "retry-failed" : "incremental (only what has no result yet)"}`);
  const tierOrder = ["free", "free-deposit", "paid", "management", "subscription", "unlabelled"];
  const byTier = c.byTier ? Object.entries(c.byTier).sort((a, b) => tierOrder.indexOf(a[0]) - tierOrder.indexOf(b[0])).map(([t, n]) => `${t} ${num(n)}`).join(", ") : "";
  const nf = {};
  for (const e of p.set.notFree ?? []) { const t = e.tier ?? "unlabelled"; nf[t] = (nf[t] ?? 0) + 1; }
  L.push(`models: ${num(c.probeOk)} probe-ok; ${num(c.relay)} Anthropic relay model(s) not probed (provenance: known good); ${num(c.notFree)} skipped for now because the provider's key tier is not free${c.notFree ? ` (${Object.entries(nf).map(([t, n]) => `${t} ${num(n)}`).join(", ")})` : ""}; ${num(c.probeSet)} in the probe set (free-labelled providers only)`);
  if (byTier) L.push(`  probe-ok models by key tier (relay apart): ${byTier}`);
  L.push(`  with a record: ${num(c.withRecord)} of ${num(c.probeSet)}; with a record against the current fixture: ${num(c.withRecordCurrent)} of ${num(c.probeSet)}` +
    `${c.outdated ? `; against an older fixture: ${num(c.outdated)} (a recommendation to re-sweep, not queued)` : ""}` +
    `${c.pending ? `; ${num(c.pending)} failed once and wait for a second try` : ""}`);
  L.push(`  tools:false in the probe set: ${num(c.toolsFalse)} of ${num(c.probeSet)} (probed like the rest: the catalogue claim is what is being tested); of those, ${num(c.toolsFalseWithRecord)} have a record`);
  L.push(`  context length unknown: ${num(c.ctxUnknown)} of ${num(c.probeSet)} model(s) in the probe set${c.badId ? `; ${num(c.badId)} id(s) this file cannot hold were left out` : ""}`);
  if (p.cand) {
    const ex = p.ledger.l3.counts.byExcluded;
    const pr = {};
    for (const e of (p.sample ? p.sample.entries : p.cand.entries)) pr[e.prio] = (pr[e.prio] ?? 0) + 1;
    L.push(`candidates (free tier${o.includeTiers?.length ? ` + ${o.includeTiers.join(", ")}` : ""}): ${num(p.cand.entries.length)} of ${num(c.probeSet)} model(s) in the probe set, whether or not their context is known; ` +
      `priority 1 policy allowed >= ${num(p.cand.floor)} or pinned ${num(pr[1] ?? 0)}, 2 preset union ${num(pr[2] ?? 0)}, 3 other >= ${num(p.cand.floor)} ${num(pr[3] ?? 0)}, 4 unknown context ${num(pr[4] ?? 0)}, 5 known below ${num(p.cand.floor)} ${num(pr[5] ?? 0)} (an ordering, never a limit)`);
    L.push(`  excluded: ${Object.entries(ex).map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none"}${p.cand.pinned.length ? `; pins that are not probe-ok models and were ignored: ${p.cand.pinned.map((x) => show(x)).join(", ")}` : ""}`);
    if (p.presetNote && !/presets$/.test(p.presetNote)) L.push(`  note: ${show(p.presetNote, 200)}`);
    if (p.bigSkipped) L.push(`  big step skipped for ${num(p.bigSkipped)} model(s) whose known context is below ${num(BIG_MIN_CTX)} (never recorded as a failure)`);
  }
  if (p.sample) {
    const st = p.sample.strata, big = p.run.sizes[5].inTokens, firm = p.est.entries.reduce((a, e) => a + e.tin - (e.todo.includes(5) ? big : 0), 0);
    const fmt = (m) => Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ");
    L.push(`sample (seed ${show(o.seed, 20)}): ${num(st.n)} of ${num(st.of)} free-tier candidates across ${num(st.providers)} provider(s); reasoning/plain: ${fmt(st.byReasoning)}; context: ${fmt(st.byCtx)}`);
    L.push(`  estimated input tokens: ~${tok(firm)} for L1+L2+L3, and up to ~${tok(st.n * big)} more for the big step (only the models that pass L3 are asked it)`);
  }
  L.push(`this run: ${num(p.queued.length)} model(s) queued of ${num(c.probeSet)}${o.only ? ` (--only ${show(o.only.join(","), 80)})` : ""}${o.limit ? ` (--limit ${o.limit})` : ""}; ` +
    `${num(p.kept.length)} fit the per-provider cap of ${num(o.tfMaxTokens)} input tokens, ${num(p.waiting.length)} wait for the next run`);
  if (p.tooBig.length) L.push(`  WARNING: ${num(p.tooBig.length)} queued model(s) cost more than the cap on their own and will never run under it: raise --tf-max-tokens-per-provider to at least ${num(p.needed)}`);
  L.push(`  requests ${num(p.run.requests)}   input tokens ~${tok(p.run.inTokens)}   output tokens up to ~${tok(p.run.outTokens)}   (whole queue, before the cap: ${num(p.est.requests)} requests, ~${tok(p.est.inTokens)} input tokens)`);
  const free = p.run.entries.filter((e) => e.free).length, paid = p.run.paidModels;
  L.push(`  free tier ${num(free)} model(s): no money; paid tier ${num(paid)} model(s): estimate ${usd(p.run.usd)} (input and output priced, cap ${usd(o.maxSpend)}, row ceiling ${usd(o.maxRowCost)}; an unlisted price is charged at the highest listed paid price of the whole probe set)`);
  L.push(...tierLines(p));
  L.push(...gatewayLines(p.gateway ?? []));
  if (!p.tierInfo) L.push("  no provider tier data (no compiled policy and no --tiers-file): no provider counts as free, so nothing is probed (default-deny)");
  if (p.pricedOnFree?.entries.length) L.push(`  free-tier keys with a LISTED price: ${num(p.pricedOnFree.entries.length)} of ${num(p.queued.length)} queued model(s) are costed at the listed price, not as free: ${usd(p.pricedOnFree.usd)} at full depth (input and output priced); ${num(p.overRowAll)} of them are over the ${usd(o.maxRowCost)} row ceiling at the levels asked (${num(p.overRow)} of those within this run's cap) and stay pending: ${PRICED_OVER_ROW} (raise --max-row-cost to probe them)`);
  if (p.cand && p.envelope.models) {
    const e = p.envelope, top = e.perProvider.slice(0, 3).map((r) => `${show(r.provider, 18)} ${tok(r.tokens)}`).join(", ");
    L.push(`envelope, the WHOLE queue at full depth (before any cap): ${num(e.requests)} requests, ~${tok(e.tokens)} input tokens, ${num(e.models)} model(s) of ${num(c.probeSet)} in the probe set on ${num(e.providers)} provider(s)`);
    L.push(`  finishing in ONE run needs --tf-max-tokens-per-provider ${num(e.oneRunCap)} (largest: ${top}); at the cap of ${num(e.cap)} it takes about ${num(e.runs)} run(s)${e.neverRuns ? `, and ${num(e.neverRuns)} model(s) can never run under it` : ""} (every model assumed to complete all its levels)`);
    const w = Math.max(o.tfMaxTokens, p.needed);
    if (w > o.tfMaxTokens) L.push(`  the smallest cap that lets every model run is ${num(w)}: at that cap about ${num(envelope(p.est.entries, w).runs)} run(s)`);
  }
  if (big || p.queued.length) {
    L.push(`  per request (a full-depth model sends each row once; the stream is cancelled once the needed calls are closed): ${levelCosts(o.maxTokens).map((x) => `${x.label} ${x.requests} req ~${tok(x.inTokens)} in, up to ${x.outTokens} out`).join("; ")}`);
    L.push(`  output budgets: ${Object.entries(BUDGETS).filter(([k]) => k !== "1f" && k !== "1af").map(([k, v]) => `${k} ${o.maxTokens ?? v}`).join(", ")} tokens (a thinking-only stop is asked once more at ${ESCALATED_MAX_TOKENS}); timeouts: adaptive per model, ${TIMEOUT_FACTOR} x its bench time, small ${o.timeoutSmall}-${o.timeoutMaxSmall} s, 157 KB ${o.timeout157}-${o.timeoutMax157} s, 400 KB ${o.timeoutBig}-${o.timeoutMaxBig} s (${p.timeoutStats ? `this run's small requests: ${p.timeoutStats}; ` : ""}a timeout is asked once more at double, then pending timeout, or slow on L1: never a verdict); in flight per provider: ${p.perProvider} (1 for requests of 100 KB or more), ${o.concurrency ?? 8} overall`);
  }
  if (big) L.push(`  deep levels need --l3 yes and --only or an explicit --max-spend or --tf-max-tokens-per-provider`);
  { // per-tier totals and the deep-probe rule
    const byTier = {};
    for (const e of p.run.entries) { const t = e.tier ?? "unlabelled"; const x = (byTier[t] ??= { models: 0, tokens: 0, usd: 0 }); x.models += 1; x.tokens += e.tin; x.usd += e.cost; }
    if (Object.keys(byTier).length) L.push(`  per tier this run: ${Object.entries(byTier).map(([t, x]) => `${t} ${num(x.models)} model(s) ~${tok(x.tokens)} tokens ${usd(x.usd)}`).join("; ")}`);
    if (o.includeTiers?.length && p.liftPreview) L.push(`${LIFT_PREVIEW}${Object.entries(p.liftPreview).map(([t, x]) => ` ${t} ${num(x.models)} model(s), ${num(x.requests)} requests, ~${tok(x.inTokens)} input tokens, ${usd(x.usd)}`).join(";")} (input and output priced at the listed price; caps in force: ${usd(o.maxSpend)} spend, ${usd(o.maxRowCost)} per row)`);
    if (o.includeTiers?.length) L.push(p.lift.ok ? `  deep probes UNLOCKED for ${p.lift.lift.tiers.join(", ")}: the dollar caps apply (cap ${usd(o.maxSpend)}, row ceiling ${usd(o.maxRowCost)})` : `  deep probes for ${o.includeTiers.join(", ")} stay skipped until all of these hold: ${(p.lift.missing.includes("the printed per-tier cost estimate") ? [...p.missingAfterPrint, "the printed per-tier cost estimate above"] : p.lift.missing).join("; ")}`);
    if (p.queued.length) L.push(`  wall time, an estimate: about ${fmtDur(p.wall.lowSec)} to ${fmtDur(p.wall.highSec)} for this run (typical first-token ${num(p.latencyMs)} ms from the bench, prefill by request size, ${p.perProvider} per provider and ${o.concurrency ?? 8} overall; the high end assumes rate limits)`);
  }
  for (const r of p.run.perProvider.slice(0, 12)) L.push(`  ${show(r.provider, 18).padEnd(18)} ${String(r.models).padStart(5)} model(s)  ${String(r.requests).padStart(5)} requests  ~${tok(r.inTokens).padStart(5)} tokens  ${usd(r.usd)}`);
  if (p.run.perProvider.length > 12) L.push(`  ... and ${p.run.perProvider.length - 12} more provider(s)`);
  for (const line of coverageLines(p.ledger.l12, "L1+L2 (every listed model)")) L.push(show(line, 600));
  if (p.ledger.l3) for (const line of coverageLines(p.ledger.l3, "L3 (candidates and the rest of the probe set)")) L.push(show(line, 600));
  if (!p.queued.length) L.push(`  nothing to probe: ${o.retryFailed ? "no model has a confirmed failure" : "every model in the set already has a result for these levels (use --force to ask again)"}`);
  return L.join("\n");
}

/** Returns the refusal text for a live invocation that has not asked for what it would cost, else null. */
export function liveRefusal(o, p) {
  const big = p.queued.some((e) => e.todo.some((l) => l >= 3));        // also a retry of an L3 failure: it sends the 157 KB fixture again
  if (big && !o.l3) return "levels 3, 4 and 5 send the 157 KB and 400 KB fixtures (about 40,000 to 100,000 input tokens per request): add --l3 yes";
  if (big && !o.only && !o.explicit.has("maxSpend") && !o.explicit.has("tfMaxTokens")) return "levels 3, 4 and 5 need a named provider subset (--only) or an explicit cap (--max-spend or --tf-max-tokens-per-provider)";
  if (o.includeTiers?.length && o.levelsExplicit && o.levels.some((l) => l > 2) && !p.lift.ok) return `deep probes on the paid or deposit tier need ALL of: ${p.lift.missing.join("; ")}`;
  const priced = p.kept.filter((e) => !e.free);
  if (priced.length && !o.explicit.has("maxSpend")) return `${num(priced.length)} priced model(s) are queued (a listed price counts, also on a free-labelled provider): a live run with money at stake needs an explicit --max-spend (the default is not accepted); the estimate for them is ${usd(p.run.usd)}`;
  if (!p.kept.length && p.tooBig.length) return `--tf-max-tokens-per-provider ${num(o.tfMaxTokens)} is below the cost of one model for these levels: nothing would run. Use at least ${num(p.needed)}`;
  if (p.run.usd > o.maxSpend) return `the estimate ${usd(p.run.usd)} is above the cap ${usd(o.maxSpend)}: narrow the run (--only, --limit, --levels) or raise --max-spend`;
  return null;
}

/**
 * One model for the engine: the levels it still needs, the verdicts kept across the engine's retries, and the abort signals. Spend is kept here as
 * well as in the engine: every level a probe COMPLETED is charged, also when a later level errors (the engine charges only what a finished result
 * reports), so the report and the budget of the next phase count it.
 */
function makeProbe({ o, gw, fetchImpl, ac, spend, lift, telemetry, prov, clampedKeys, bench = null, stats = { started: new Set(), active: new Map() } }) {
  // Spend is charged per REQUEST that was sent and billed, from what the answer reported (or the estimate when it did not): a level that was only part way, an answer that was all thinking
  // (and the larger-budget request asked again after it) count; a rate limit, a dead key, a server error and a TIME-OUT (no complete answer: nothing was delivered) cost nothing.
  const BILLED = new Set(["empty"]);
  const charge = (t, tele) => {
    const price = t.entry.price ?? { in: 0, out: 0 };
    for (const x of tele) {
      if (!(x.v === "p" || x.v === "f" || BILLED.has(x.s))) continue;
      const inT = x.inTok ?? kindSize(x.kind).inTokens, outT = x.outTok ?? (x.s === "timeout" ? 0 : x.max ?? BUDGETS[x.kind]);
      spend.total += (inT * price.in + outT * price.out) / 1e6;
    }
  };
  const floors = { small: o.timeoutSmall * 1000, "157": o.timeout157 * 1000, big: o.timeoutBig * 1000 };
  const caps = { small: o.timeoutMaxSmall * 1000, "157": o.timeoutMax157 * 1000, big: o.timeoutMaxBig * 1000 };
  return async (t, ctx) => {
    t.done ??= {};
    // a provider whose first answer was a dead key, an empty balance or a missing model costs nothing more; one that keeps rate-limiting is left for the next run
    const ps = (prov[t.provider] ??= { rateStreak: 0, paused: false, blocked: null, answered: false });
    if (ps.blocked) return { s: "skip", w: `canary-${ps.blocked}` };
    if (ps.paused) return { s: "skip", w: "rate-paused" };
    const tele = [];
    stats.started.add(t.key);
    stats.active.set(t.provider, (stats.active.get(t.provider) ?? 0) + 1);
    const timeouts = timeoutsFor(bench?.get?.(t.key), floors, caps);                       // adaptive: 3 x this model's bench time, between the floor and the cap of each request class
    let r;
    try {
    r = await probeModel({ levels: t.entry.todo, prior: t.entry.prior?.lvr ?? "nnnn", flags: t.entry.prior, done: t.done, state: (t.pstate ??= {}), tier: t.entry.tier ?? null, lift, order: o.order, ctx: t.entry.ctx ?? 0, tele,
      fetchImpl, url: `${gw.base}/v1/messages`, key: gw.key, model: t.key, ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}), timeouts, signal: ctx?.signal ? AbortSignal.any([ac.signal, ctx.signal]) : ac.signal });
    } finally { stats.active.set(t.provider, Math.max(0, (stats.active.get(t.provider) ?? 1) - 1)); }
    for (const x of tele) telemetry.add(t.provider, x);
    charge(t, tele);
    if (r.aborted) return { aborted: true };
    for (const l of r.clamped ?? []) clampedKeys.add(t.key);
    const sx = r.inconclusive?.s;
    if (sx === "rate") { if (++ps.rateStreak >= RATE_PAUSE_AFTER) ps.paused = true; } else ps.rateStreak = 0;
    if (!ps.answered) { if (sx === "auth" || sx === "pay" || sx === "gone") ps.blocked = sx; else if (!r.inconclusive) ps.answered = true; }
    if (r.inconclusive?.reason === "route-shape" || r.inconclusive?.reason === "upstream-unavailable") return { s: "skip", w: r.inconclusive.reason, ...(r.inconclusive.hint ? { hint: r.inconclusive.hint } : {}) };
    if (r.inconclusive) return { s: r.inconclusive.s, ...(r.inconclusive.escalated ? { escalated: true } : {}), ...(r.inconclusive.reason ? { reason: r.inconclusive.reason } : {}), ...(r.inconclusive.secs !== undefined ? { secs: r.inconclusive.secs } : {}), ...(r.inconclusive.ra !== undefined ? { ra: r.inconclusive.ra } : {}), ...(r.inconclusive.http ? { http: r.inconclusive.http } : {}), p: r.inconclusive.why, m: r.inconclusive.why };
    return { s: "ok", tf: { done: t.done }, ...(r.escalated ? { escalated: true } : {}) };
  };
}

/** The measured cost of a run, per request kind and per provider, against the estimate (so the estimates can be calibrated). */
function makeTelemetry() {
  const blank = () => ({ n: 0, ms: 0, inTok: 0, inEst: 0, outTok: 0, outEst: 0, usage: 0, early: 0, timeouts: 0, lat: [] });
  const kinds = new Map(), provs = new Map();
  return {
    kinds, provs,
    /** The totals so far, for the heartbeat. */
    total() { return [...kinds.values()].reduce((a, r) => ({ n: a.n + r.n, ms: a.ms + r.ms, inTok: a.inTok + r.inTok, inEst: a.inEst + r.inEst, outTok: a.outTok + r.outTok, usage: a.usage + r.usage, timeouts: a.timeouts + r.timeouts }), { n: 0, ms: 0, inTok: 0, inEst: 0, outTok: 0, usage: 0, timeouts: 0 }); },
    /** One line per provider that timed out or was slow: how many requests timed out, the median and the longest seconds, how many models were pending slow. A slow provider must read as slow, not as untested. */
    timeoutLines(slowBy = {}) {
      const rows = [...provs].filter(([k, r]) => r.timeouts || slowBy[k]).sort(([, a], [, b]) => b.timeouts - a.timeouts);
      if (!rows.length) return [];
      const med = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
      return [`  provider latency where requests timed out (seconds per request; slow = models whose L1 timed out twice, left pending: slow):`, ...rows.slice(0, 15).map(([k, r]) => `    ${show(k, 18).padEnd(18)} ${r.timeouts} timeout(s) of ${r.n} request(s), median ${(med(r.lat) / 1000).toFixed(1)} s, max ${(Math.max(0, ...r.lat) / 1000).toFixed(1)} s, slow ${slowBy[k] ?? 0}`), ...(rows.length > 15 ? [`    ... and ${rows.length - 15} more provider(s)`] : [])];
    },
    add(provider, x) {
      for (const rec of [kinds.get(x.kind) ?? kinds.set(x.kind, blank()).get(x.kind), provs.get(provider) ?? provs.set(provider, blank()).get(provider)]) {
        rec.n += 1; rec.ms += x.ms ?? 0; rec.lat.push(x.ms ?? 0); if (x.early) rec.early += 1; if (x.s === "timeout") rec.timeouts += 1;
        // usage counts only when the provider REALLY reported tokens (a zero is "not reported", not a measurement)
        const hasIn = x.inTok > 0, hasOut = x.outTok > 0;
        if (hasIn || hasOut) rec.usage += 1;
        if (hasIn) { rec.inTok += x.inTok; rec.inEst += kindSize(x.kind).inTokens; }
        if (hasOut) { rec.outTok += x.outTok; rec.outEst += x.max ?? BUDGETS[x.kind]; }
      }
    },
    lines(wallSec) {
      const L = [], t = [...kinds.values()].reduce((a, r) => ({ n: a.n + r.n, inTok: a.inTok + r.inTok, inEst: a.inEst + r.inEst, outTok: a.outTok + r.outTok, outEst: a.outEst + r.outEst, usage: a.usage + r.usage, timeouts: a.timeouts + r.timeouts, early: a.early + r.early }), { n: 0, inTok: 0, inEst: 0, outTok: 0, outEst: 0, usage: 0, timeouts: 0, early: 0 });
      if (!t.n) return L;
      const row = (name, r) => `${name} x${r.n} ${r.usage ? `in ${tok(r.inTok)} of ~${tok(r.inEst)} estimated, out ${tok(r.outTok)} of up to ${tok(r.outEst)}` : "no usage reported"}, ${(r.ms / Math.max(1, r.n) / 1000).toFixed(1)} s each${r.early ? `, ${r.early} cut early` : ""}${r.timeouts ? `, ${r.timeouts} timed out` : ""}`;
      L.push(`telemetry, actual against estimate, per request kind: ${[...kinds].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, r]) => row(k, r)).join("; ")}`);
      const top = [...provs].sort(([, a], [, b]) => b.ms - a.ms).slice(0, 5).map(([k, r]) => `${show(k, 18)} ${(r.ms / 1000).toFixed(0)} s over ${r.n} request(s)`).join(", ");
      L.push(`  slowest providers: ${top}; total wall time ${fmtDur(wallSec)}`);
      L.push(`  calibration (this run, not stored): input tokens actual/estimate ${t.inEst ? (t.inTok / t.inEst).toFixed(2) : "n/a"}, output actual/budget ${t.outEst ? (t.outTok / t.outEst).toFixed(2) : "n/a"} over ${t.usage} of ${t.n} request(s) that reported usage${t.usage ? "" : " (no usage was reported by any request: these ratios say nothing)"}; ${t.early} cut early, ${t.timeouts} timed out`);
      return L;
    },
  };
}

const target = (e) => ({ key: e.key, provider: e.provider, id: e.id, free: e.free, cost: e.cost, worst: e.cost, entry: e });
const groupsOf = (entries) => { const g = new Map(); for (const e of entries) { if (!g.has(e.provider)) g.set(e.provider, []); g.get(e.provider).push(target(e)); } return g; };

/**
 * `deps` exists for tests: `snapshot`, `bench`, `outFile`, `lockFile`, `gateway`, `fetch`, `now`, `isAlive`, `findRunning`, `saveImpl`, `afterLock`, `sweep`.
 * A run with no `outFile` reads and (under --live only) writes the real state file.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`tool-fidelity: ${o.error}`); return 2; }
  const outFile = deps.outFile ?? REAL_FILE;
  if (o.mergeUnsaved) return mergeUnsaved(o, outFile, deps);
  if (o.resetAwkwardJson) return resetAwkward(o, outFile, deps);
  if (o.resetTransient) return resetTransient(o, outFile, deps);
  const loaded = deps.snapshot ?? loadSnapshot();
  if (!loaded.ok) { console.error(`tool-fidelity: no usable snapshot (${loaded.reason}) -- run: node menu/snapshot.mjs --build`); return 1; }
  const stored = loadFidelity(outFile);
  if (!stored.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is ${stored.reason}; it is not touched and nothing was planned (fix or move it first)`); return 1; }
  const bench = deps.bench ?? loadBench();
  const policy = o.candidates ? (deps.policy ?? loadPolicy(o.policyFile ?? POLICY_FILE)) : null;
  if (o.candidates && !policy) { console.error(`tool-fidelity: --candidates policy needs a compiled policy (${o.policyFile ? show(o.policyFile, 120) : "state/subagent/policy.json"}); it is missing or is not one. Nothing was planned`); return 1; }
  let tiers = null, presets = { keys: null, note: null }, tierMeta = null;
  const policyPath = o.policyFile ?? POLICY_FILE;
  // where the tiers come from: a tiers file, the policy given by the caller, or the compiled policy file (its compiledAt tells how old they are)
  const tiersFrom = () => {
    if (o.tiersFile) { const info = loadTiersInfo(o.tiersFile, { choicesFile: o.keyChoicesFile ?? null }); tierMeta = { info, source: `tiers file ${show(o.tiersFile, 100)}` }; return info?.tiers ?? null; }
    if (deps.tiers !== undefined) { tierMeta = { info: null, source: "tiers given by the caller" }; return deps.tiers; }
    const pol = policy ?? (deps.policy !== undefined ? deps.policy : loadPolicy(policyPath));
    tierMeta = { info: pol ? { kind: "policy", compiledAt: typeof pol.compiledAt === "string" && Number.isFinite(Date.parse(pol.compiledAt)) ? pol.compiledAt : null, mtime: null, conflicts: [] } : null, source: deps.policy !== undefined ? "policy given by the caller" : `compiled policy ${show(policyPath, 100)}` };
    return pol?.tiers ?? null;
  };
  // the provider tiers decide who is probed AT ALL (default-deny: no tier data means nothing is probed), so every run looks for them
  if (!o.candidates) tiers = tiersFrom();
  if (o.candidates) {
    tiers = tiersFrom();
    if (!tiers) { console.error("tool-fidelity: --candidates needs the provider key tiers: the policy's `tiers`, or --tiers-file (a {provider: tier} file or the vault registry). Nothing was planned"); return 1; }
    presets = deps.presetKeys !== undefined ? { keys: deps.presetKeys, note: null } : presetUnion({ snap: loaded.snap, bench, tiers, nowMs: (deps.now?.() ?? new Date()).getTime() });
  }
  const ctxOf = { tiers, tierMeta, nowMs: (deps.now?.() ?? new Date()).getTime(), presetKeys: presets.keys, presetNote: presets.note };
  // The lift needs the per-tier cost estimate to have been PRINTED in this invocation. The plan is made on the expectation that it will be, and what was actually shown is checked:
  // when the preview line is not in the text, the plan is made again without it (the paid tier stays clamped) and that is what is shown and run.
  const planWith = (printed) => plan({ snap: loaded.snap, bench, store: stored.models, o, policy, pending: stored.pending, ...ctxOf, printed });
  let printed = o.includeTiers.length > 0;
  let p = planWith(printed);
  let text = printPlan(p, { ...o, live: o.live });
  if (printed && !text.split(String.fromCharCode(10)).some((l) => l.startsWith(LIFT_PREVIEW))) { printed = false; p = planWith(false); text = printPlan(p, { ...o, live: o.live }); }
  if (o.only && !p.set.models.some((m) => selectOnly([m], o.only).length)) { console.error(`tool-fidelity: --only ${show(o.only.join(","), 80)} matches no probe-ok model`); return 1; }
  console.log(text);
  if (stored.dropped) console.log(`  note: ${num(stored.dropped)} stored record(s) could not be read by this version; they stay in the file and count as untested`);
  if (!o.live) { console.log("\nno request was made. Re-run with --live to probe."); return 0; }
  const refusal = liveRefusal(o, p);
  if (refusal) { console.error(`tool-fidelity: refused: ${refusal}`); return 2; }
  if (!p.kept.length) { console.log("tool-fidelity: nothing to probe."); return 0; }

  const gw = deps.gateway ?? gatewayConnection();
  if (!gw) { console.error("tool-fidelity: cannot find the gateway address or its key in Claude Code's settings"); return 1; }
  const fetchImpl = deps.fetch ?? fetch;
  if (!(await gatewayUp(gw.base, { fetchImpl, retries: 1, retryDelayMs: deps.retryDelayMs ?? 2000 }))) { console.error("tool-fidelity: the gateway is not answering; nothing was sent"); return 1; }
  const got = acquireLock({ ...(deps.lockFile ? { file: deps.lockFile } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}), ...(deps.findRunning ? { findRunning: deps.findRunning } : {}),
    mode: "tool-fidelity", maxMinutes: o.maxMinutes });
  if (!got.ok) { console.error(`tool-fidelity: ${got.message}`); return EXIT_BUSY; }
  try {
    await deps.afterLock?.();
    // The plan above was made before the lock: another run may have written results while this one waited, and writing a stale store back would erase them.
    const fresh = loadFidelity(outFile);
    if (!fresh.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is now ${fresh.reason}; nothing was sent`); return 1; }
    const p2 = plan({ snap: loaded.snap, bench, store: fresh.models, o, policy, pending: fresh.pending, ...ctxOf, printed });
    const again = liveRefusal(o, p2);
    if (again) { console.error(`tool-fidelity: refused: ${again}`); return 2; }
    if (!p2.kept.length) { console.log("tool-fidelity: nothing to probe (another run finished the work while this one waited for the lock)."); return 0; }
    return await runLive({ o, p: p2, loaded, stored: fresh, outFile, gw, fetchImpl, deps, bench });
  } finally { got.release(); }
}

async function runLive({ o, p, loaded, stored, outFile, gw, fetchImpl, deps, bench = null }) {
  const now = deps.now ?? (() => new Date());
  const save = deps.saveImpl ?? saveFidelity;
  const store = { ...stored.models };
  const keep = new Set((loaded.snap.rows ?? []).flatMap((r) => (r.models ?? []).map((m) => `${r.provider}/${m.id}`)));
  const ac = new AbortController();
  const spend = { total: 0 };
  let interrupts = 0, sinceSave = 0, saveWarned = false;
  const onSigint = () => { try { periodic(); } catch { /* the final save retries */ } if (++interrupts > 1) process.exit(130); console.error("\ntool-fidelity: stopping -- probes in flight are dropped (not recorded) and what finished is saved (Ctrl-C again to force)"); ac.abort(); };
  process.on("SIGINT", onSigint);
  let pending = { ...(stored.pending ?? {}) };
  let capDropped = [];                                           // records the file's size cap pushed out in the last save
  const writeOnce = () => { const w = save(outFile, store, { live: true, now: now(), keep, preserve: stored.rejected ?? {}, pending }); capDropped = Array.isArray(w?.dropped) ? w.dropped : []; };
  // A failed periodic save never stops the run: the records stay in memory and the next save (or the final one) carries them.
  const periodic = () => { try { writeOnce(); sinceSave = 0; } catch (e) { if (!saveWarned) { saveWarned = true; console.error(`tool-fidelity: warning: could not save (${e?.message ?? e}); the records are kept and the save is retried`); } } };
  const tally = { t: 0, v: 0, x: 0, u: 0, pending: 0 }, other = {}, why = new Map(), got = new Set(), escalated = new Set(), clampedKeys = new Set(), telemetry = makeTelemetry(), prov = {};
  let recorded = 0;
  const stats = { started: new Set(), active: new Map() }, slowBy = {}, slowList = [], routeBy = {}, unavailBy = {};
  const onResult = (r) => {
    if (r.escalated) escalated.add(r.key);
    if (r.w === "upstream-unavailable") { const pv = r.key.slice(0, r.key.indexOf("/")); const x = (unavailBy[pv] ??= { n: 0, hint: r.hint ?? "" }); x.n += 1; }
    if (r.w === "route-shape") { const pv = r.key.slice(0, r.key.indexOf("/")); const x = (routeBy[pv] ??= { n: 0, hint: r.hint ?? "" }); x.n += 1; }
    if (r.reason === "slow") { const pv = r.key.slice(0, r.key.indexOf("/")); slowBy[pv] = (slowBy[pv] ?? 0) + 1; slowList.push({ key: r.key, secs: r.secs }); }
    if (r.s !== "ok" || !r.tf) { other[r.s] = (other[r.s] ?? 0) + 1; why.set(r.key, pendingReasonOf(r, p.kept.find((k) => k.key === r.key))); return; }
    const e = p.kept.find((k) => k.key === r.key);
    const rec = buildRecord(store[r.key] ?? null, r.tf.done, { now: now(), alias: !!e?.alias });
    if (!rec) { other.norecord = (other.norecord ?? 0) + 1; return; }       // no level actually ran: nothing is recorded
    got.add(r.key);
    store[r.key] = rec;                                                       // this run holds the lock and built the record from the current one: it replaces it
    if (rec.strikes === 1) tally.pending += 1; else tally[rec.t] += 1;
    recorded += 1;
    if (++sinceSave >= SAVE_EVERY) periodic();
  };
  const lift = p.lift.ok ? p.lift.lift : null;
  const probe = makeProbe({ o, gw, fetchImpl, ac, spend, lift, telemetry, prov, clampedKeys, bench, stats });
  const opts = { ...sweepOptions(o), perProvider: p.perProvider, ...(deps.sweep ?? {}) };
  const phases = [["free tier", p.kept.filter((e) => e.free)], ["paid tier", p.kept.filter((e) => !e.free)]].filter(([, l]) => l.length);
  const started = Date.now();
  // A long live run is never silent: one line per heartbeat with the progress, the requests, the tokens so far against the estimate, who is active, who is paused and, from the pace seen so far
  // (per request kind), how long the rest should take.
  const planned = {};
  for (const e of p.run.entries) for (const k of e.kinds) planned[k] = (planned[k] ?? 0) + 1;
  const heartbeat = () => {
    const tot = telemetry.total(), el = (Date.now() - started) / 1000;
    const act = [...stats.active].filter(([, n]) => n > 0).map(([k, n]) => `${show(k, 14)} ${n}`).join(", ") || "none";
    const stopped = Object.entries(prov).filter(([, x]) => x.paused || x.blocked).map(([k, x]) => `${show(k, 14)} (${x.blocked ?? "rate"})`).join(", ") || "none";
    const toks = tot.usage ? `${tok(tot.inTok)} in / ${tok(tot.outTok)} out reported so far (estimate for the run ~${tok(p.run.inTokens)} in)` : `no usage reported yet (estimate for the run ~${tok(p.run.inTokens)} in)`;
    let remain = 0, known = tot.n > 0;
    for (const [k, n] of Object.entries(planned)) { const r = telemetry.kinds.get(k), left = Math.max(0, n - (r?.n ?? 0)); remain += left * ((r?.n ? r.ms / r.n : tot.n ? tot.ms / tot.n : 0) / 1000); }
    const live = new Set(p.kept.map((e) => e.provider).filter((pv) => !(prov[pv]?.paused || prov[pv]?.blocked)));
    const conc = Math.max(1, Math.min(o.concurrency ?? 8, live.size * p.perProvider));
    console.log(show(`  [heartbeat ${fmtDur(el)}] models: ${recorded} recorded, ${stats.started.size} attempted of ${num(p.kept.length)} queued; requests ${tot.n} of ~${num(p.run.requests)} (${tot.timeouts} timed out); ${toks}; active: ${act}; paused: ${stopped}${known ? `; at the pace seen so far about ${fmtDur(remain / conc)} remain` : ""}`, 700));
  };
  const hb = setInterval(heartbeat, deps.heartbeatMs ?? 60000);
  hb.unref?.();
  let probes = 0, code = 0, saved = true;
  const skips = {};
  try {
    for (const [name, list] of phases) {
      console.log(`\n${name}: ${num(list.length)} model(s)`);
      const result = await runSweep({ groups: groupsOf(list), signal: ac.signal, ...opts, maxSpend: Math.max(0, o.maxSpend - spend.total),
        gatewayCheck: () => gatewayUp(gw.base, { fetchImpl }), probe, onResult });
      probes += result.probes;
      for (const [w, n] of Object.entries(result.skips)) skips[w] = (skips[w] ?? 0) + n;
      code = Math.max(code, sweepExit(result));
      if (result.aborted) { console.log(`  stopped (${result.stopped}); re-run to resume: models with a result are not asked again`); break; }
    }
  } finally {
    clearInterval(hb);
    if (interrupts) heartbeat();
    process.removeListener("SIGINT", onSigint);
    // The final save is retried, and when it still fails the records go to a side file: a finished probe is never thrown away.
    const queue = [...p.kept, ...p.waiting, ...p.tooBig];
    const before = JSON.stringify(pending);
    pending = updatePending(pending, { queue, recorded: got, store, now: now(), keepKeys: new Set([...p.set.models.map((m) => m.key), ...p.set.relay]),
      reasonOf: (k) => (p.waiting.some((e) => e.key === k) || p.tooBig.some((e) => e.key === k) ? "cap" : why.get(k) ?? "not-run") });
    if (recorded || JSON.stringify(pending) !== before) {
      saved = false;
      for (let i = 0; i < 3 && !saved; i++) { try { writeOnce(); saved = true; } catch (e) { if (i < 2) await sleep(deps.retryDelayMs ?? 500); else saveWarned = e?.message ?? String(e); } }
      if (!saved) {
        const side = path.join(path.dirname(outFile), "tool-fidelity.unsaved.json");
        try { writeAtomic(side, JSON.stringify({ schema: SCHEMA, kind: KIND, generatedAt: now().toISOString(), models: store, pending })); console.error(`tool-fidelity: ERROR: could not save ${path.basename(outFile)} (${saveWarned}); ${recorded} new record(s) were written to ${side} instead`); }
        catch (e) { console.error(`tool-fidelity: ERROR: could not save (${saveWarned}) and could not write the side file (${e?.message ?? e}); ${recorded} record(s) are lost`); }
        code = Math.max(code, 1);
      }
    }
  }
  if (capDropped.length) {
    const gone = capDropped.filter((k) => !keep.has(k)).length;
    console.log(`  WARNING: the file's size cap pushed ${num(capDropped.length)} record(s) out of ${path.basename(outFile)}: ${num(gone)} of models that have left the catalogue, ${num(capDropped.length - gone)} the oldest ones (capacity, not expiry; they are asked again by a later run)`);
  }
  const after = fidelityCounts(p.set, store);
  let ledgerLines = [];
  try {
    const u = ledgerUniverses({ set: p.set, cand: p.cand });
    ledgerLines = [...coverageLines(coverage(u.l12, store, { level: "l12", pending, stuckRuns: o.pendingRuns }), "L1+L2 (every listed model)"),
      ...(u.l3 ? coverageLines(coverage(u.l3, store, { level: "l3", pending, stuckRuns: o.pendingRuns }), "L3 (candidates and the rest of the probe set)") : [])];
  } catch (e) { ledgerLines = [`coverage: the ledger could not be built (${e?.message ?? e}); this is a bug, not a result`]; }
  console.log(`\ntool-fidelity: ${recorded} record(s) ${saved ? "written" : "NOT saved"} in ${Math.round((Date.now() - started) / 1000)}s; est. spend ${usd(spend.total)} of the ${usd(o.maxSpend)} cap; ${probes} model(s) attempted`);
  for (const line of tierLines(p)) console.log(show(line, 600));
  console.log(`  verified (v) ${tally.v}   tools at small size (t) ${tally.t}   failed (x) ${tally.x}   failed once, asked again next run ${tally.pending}`);
  const notRecorded = Object.entries(other).map(([s, n]) => `${s} ${n}`).join(", ");
  if (notRecorded) console.log(`  not recorded (they stay queued; a refusal about the account is not a verdict on the model): ${notRecorded}`);
  if (p.waiting.length) console.log(`  ${num(p.waiting.length)} model(s) waited for the per-provider cap of ${num(o.tfMaxTokens)} input tokens: run again to continue`);
  const left = unprobedLines(skips, o);
  if (left) console.log(left);
  console.log(`  now: with a record ${num(after.withRecord)} of ${num(after.probeSet)} probe-ok (${num(after.probeOk)} incl. relay not probed); against the current fixture ${num(after.withRecordCurrent)} of ${num(after.probeSet)}; still queued ${num(after.queued)}; context length unknown ${num(after.ctxUnknown)} of ${num(after.probeSet)}`);
  for (const line of telemetry.lines((Date.now() - started) / 1000)) console.log(show(line, 900));
  for (const line of telemetry.timeoutLines(slowBy)) console.log(show(line, 300));
  if (slowList.length) console.log(show(`  pending: slow (the L1 request timed out twice, at the doubled time; never a verdict, a later run asks again): ${slowList.slice(0, 12).map((x) => `${x.key} (${x.secs} s)`).join(", ")}${slowList.length > 12 ? `, ... and ${slowList.length - 12} more` : ""}`, 900));
  const paused = Object.entries(prov).filter(([, x]) => x.paused && !x.blocked).map(([k]) => `${show(k, 18)} (rate-limited)`);
  if (paused.length) console.log(`  left alone for the rest of this run, their models stay pending: ${paused.join(", ")}`);
  if (Object.keys(routeBy).length) {
    console.log("  providers needing a routing fix (the route says the model must be called another way: a different endpoint or message shape; not a model failure, never a strike; pending: route-shape):");
    for (const [k, x] of Object.entries(routeBy)) console.log(show(`    ${k}: ${x.n} model(s) -- the provider said: ${x.hint}`, 260));
  }
  if (Object.keys(unavailBy).length) {
    console.log("  providers whose upstream was unavailable or answered nothing about the request (pending: upstream-unavailable; never a verdict, never a strike toward x; a later run asks again):");
    for (const [k, x] of Object.entries(unavailBy).sort((p, q) => q[1].n - p[1].n).slice(0, 12)) console.log(show(`    ${k}: ${x.n} model(s) -- the provider said: ${x.hint}`, 260));
  }
  for (const line of gatewayLines(gatewayInsights(store))) console.log(show(line, 300));
  const attention = Object.entries(prov).filter(([, x]) => x.blocked);
  if (attention.length) {
    const WHAT = { auth: "the key was rejected", pay: "no credit or the plan does not allow it", gone: "the route or model no longer exists" };
    console.log("  providers needing attention (an account state, not a verdict on any model; fix the account, then run again; nothing was retried in this run):");
    for (const [k, x] of attention) {
      const n = [...why].filter(([key, r]) => key.slice(0, key.indexOf("/")) === k && (r === x.blocked || r === `canary-${x.blocked}`)).length;
      console.log(show(`    ${k}: ${x.blocked} (${WHAT[x.blocked] ?? "account state"}) -- ${n} model(s) skipped`, 200));
    }
  }
  if (clampedKeys.size) console.log(`  ${NOT_FREE_REASON}: ${num(clampedKeys.size)} model(s) were refused by the engine itself (no request sent)`);
  if (escalated.size) console.log(`  escalated: ${num(escalated.size)} model(s) spent their whole output budget on thinking and were asked again once with ${ESCALATED_MAX_TOKENS} tokens instead of their small budget; the ones still empty are pending: reasoning-budget (never failed)`);
  if (p.sample) {
    const r = l3Rates(store, p.sample.entries.map((e) => e.key)), pc = (x) => (x.rate === null ? "n/a" : `${(x.rate * 100).toFixed(1)}%`);
    console.log(`pilot: L3 failure rate among the models that passed L1+L2: ${pc(r.overall)} (${r.overall.failed} failed of ${r.overall.tested} tested; ${r.overall.passers} passers, ${r.overall.waiting} not yet tested)`);
    for (const [pv, x] of Object.entries(r.perProvider)) console.log(show(`  ${pv}: ${pc(x)} (${x.failed} of ${x.tested}; ${x.passers} passers)`, 120));
    const bigs = p.sample.entries.map((e) => store[e.key]).filter((x) => x && x.lvr[2] === "p" && (x.big === "p" || x.big === "f"));
    const oc = r.overall.rate === null || !bigs.length ? null : orderCosts({ r3: 1 - r.overall.rate, rb: bigs.filter((x) => x.big === "p").length / bigs.length });
    console.log(oc ? `  order, expected input tokens per L1+L2 passer from these rates (L3 pass ${((1 - r.overall.rate) * 100).toFixed(0)}%, big pass ${((bigs.filter((x) => x.big === "p").length / bigs.length) * 100).toFixed(0)}% of L3 passers): l3-first ~${tok(oc.l3First)}, big-first ~${tok(oc.bigFirst)} (${oc.bigFirst < oc.l3First ? "big-first" : "l3-first"} is cheaper)` : "  order: not enough pilot results yet to compare l3-first with big-first");
  }
  for (const line of ledgerLines) console.log(show(line, 600));
  return code;
}

/**
 * The incremental pass as a function, for a scheduler to call later (nothing calls it yet): L1 and L2 for the probe-ok models that have no
 * record, inside the per-provider token cap. A model with a record is never in it, whatever its fixture version.
 */
export function runIncremental({ snap, bench, store, tiers = null, tfMaxTokens = DEFAULT_TOKENS_PER_PROVIDER, maxTokens = PROBE_MAX_TOKENS }) {
  const o = { levels: [...DEFAULT_LEVELS], force: false, retryFailed: false, only: null, limit: null, maxTokens, tfMaxTokens, candidates: false, allow: [], pendingRuns: 3 };
  const p = plan({ snap, bench, store, o, tiers });
  return { queue: p.kept, waiting: p.waiting, counts: p.counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`tool-fidelity: ${e?.message ?? e}`); process.exitCode = 1; });
}


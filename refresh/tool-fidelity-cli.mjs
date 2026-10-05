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
// CANDIDATES. `--candidates policy` aims L3 (and the 400 KB step, for the models that pass it) at every probe-ok model the router could ever pick: the
// compiled policy's ALLOWED set (state/subagent/policy.json, or `--policy-file`) with a known context of at least 128,000, plus the models you pin with
// `--allow provider/model,...`. Not the top 3 of each provider: that is the router's spread, not a test boundary. They run in the policy's own rank, best
// first; the per-provider token cap and the spend cap stop the run and the untested tail waits for the next one (pending: cap). L1+L2 is still asked of
// every probe-ok model with no result. The report is a COVERAGE LEDGER: every model ends in exactly one of tested, pending (with the reason) or excluded.
//
// WHAT IT COSTS. L1 and L2 are two small requests per model. L3 and L4 send the ~157 KB fixture (about 40,000 input tokens each) and the big
// step ~400 KB (about 100,000), so they need `--l3 yes` AND a named provider (`--only`) or an explicit cap (`--max-spend` or
// `--tf-max-tokens-per-provider`). The dry run prints the request, token and dollar estimates first; paid rows go through the bench's row ceiling
// and spend cap, measured on this pass's INPUT-aware estimate BEFORE each request (a probe that stops part way is charged for the levels it
// completed); a provider that reaches `--tf-max-tokens-per-provider` waits for the next run.
//
// WHAT IT WRITES. Only state/tool-fidelity.json (refresh/tool-fidelity.mjs), atomically, only under --live. Not bench.json, not the
// snapshot. Nothing here is scheduled: `runIncremental` is the function a scheduler can call.

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
  estimate, paidFallback, applyProviderCap, buildRecord, loadPolicy, POLICY_FILE, selectCandidates, ledgerUniverses, coverage, coverageLines, updatePending,
} from "./tool-fidelity.mjs";
import { FIXTURE_ID } from "./tool-fidelity-fixture.mjs";
import { probeModel, PROBE_MAX_TOKENS } from "./tool-fidelity-probe.mjs";

const NUMERIC = {
  "--limit": ["limit", true], "--tf-max-tokens-per-provider": ["tfMaxTokens", true], "--max-spend": ["maxSpend", false], "--max-row-cost": ["maxRowCost", false],
  "--max-tokens": ["maxTokens", true], "--concurrency": ["concurrency", true], "--per-provider": ["perProvider", true], "--timeout": ["timeoutSec", false],
  "--max-minutes": ["maxMinutes", false], "--pending-runs": ["pendingRuns", true],
};
const SAVE_EVERY = 25;
const usd = (v) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;
const num = (n) => Math.round(n).toLocaleString("en-US");
const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
const show = (s, max = 60) => sanitizeDisplay(s, max);                      // provider names and ids are provider-controlled text
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parses `--levels`: digits 1-5 with optional commas or plus signs ("12", "1,2", "34", "5", "12345"); each at most once. Level 5 is the big step. */
export function parseLevels(text) {
  const digits = String(text).replace(/[,+\s]/g, "");
  if (!/^[1-5]+$/.test(digits) || new Set(digits).size !== digits.length) return null;
  return [...digits].map(Number).sort((a, b) => a - b);
}

/** Parses argv into options, or `{ error }`. */
export function parseArgs(argv) {
  const o = { ...DEFAULTS, maxTokens: PROBE_MAX_TOKENS, tfMaxTokens: DEFAULT_TOKENS_PER_PROVIDER, levels: [...DEFAULT_LEVELS], live: false, force: false, retryFailed: false, l3: false, only: null, limit: null, economy: false,
    candidates: false, policyFile: null, allow: [], pendingRuns: 3, levelsExplicit: false };
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") o.live = true;
    else if (a === "--force") o.force = true;
    else if (a === "--retry-failed") o.retryFailed = true;
    else if (a === "--l3") { if (argv[++i] !== "yes") return { error: "--l3 needs the word yes (it allows the 157 KB level 3 and level 4 requests and the 400 KB big step)" }; o.l3 = true; }
    else if (a === "--levels") {
      const l = parseLevels(argv[++i]);
      if (!l) return { error: "--levels needs digits from 1 to 5, each at most once, e.g. 12 (the default), 34, 5 (the big step) or 12345" };
      o.levels = l; o.levelsExplicit = true;
    } else if (a === "--candidates") {
      if (argv[++i] !== "policy") return { error: "--candidates only knows the word policy (the compiled policy's allowed set)" };
      o.candidates = true;
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
  if (!o.candidates && (o.allow.length || o.policyFile)) return { error: "--allow and --policy-file go with --candidates policy" };
  if (o.candidates && !o.levelsExplicit) o.levels = [1, 2, 3, 5];       // L1+L2 for the ones with no result, then L3 and the big step
  if (o.retryFailed && o.force) return { error: "--retry-failed and --force contradict each other (retry-failed asks again only the failed levels of failed models)" };
  o.explicit = explicit;
  return o;
}

/** The plan of one invocation, with every figure computed and nothing sent. Pure over its inputs. */
export function plan({ snap, bench, store, o, policy = null, pending = {} }) {
  const set = probeSet(snap, bench);
  const counts = fidelityCounts(set, store);
  // candidates: the models the router could ever pick, in the policy's own rank (pins first); otherwise the whole probe set in its own order
  const cand = o.candidates ? selectCandidates({ set, policy, pins: o.allow ?? [] }) : null;
  const base = cand ? { ...set, models: cand.entries } : set;
  const queued = limitEntries(selectOnly(queueFor(base, store, o.levels, { force: o.force, retryFailed: o.retryFailed }), o.only), o.limit);
  const fallback = paidFallback(set.models);                      // the whole set, so a narrowed run is charged like a full one
  const est = estimate(queued, { maxTokens: o.maxTokens, fallback });
  const { kept, waiting, tooBig, needed } = applyProviderCap(est.entries, o.tfMaxTokens);
  const run = estimate(kept, { maxTokens: o.maxTokens, fallback });
  const planned = (levels) => Object.fromEntries([...kept.map((e) => [e.key, "queued"]), ...waiting.map((e) => [e.key, "cap"]), ...tooBig.map((e) => [e.key, "cap"])]
    .filter(([k]) => [...kept, ...waiting, ...tooBig].find((e) => e.key === k).todo.some((l) => levels.includes(l))));
  const universes = ledgerUniverses({ set, cand });
  const ledger = { l12: coverage(universes.l12, store, { level: "l12", pending, plan: planned([1, 2]), stuckRuns: o.pendingRuns ?? 3 }),
                   l3: universes.l3 ? coverage(universes.l3, store, { level: "l3", pending, plan: planned([3]), stuckRuns: o.pendingRuns ?? 3 }) : null };
  return { set, counts, queued, est, run, kept, waiting, tooBig, needed, cand, ledger };
}

/** The text of the dry run. */
export function printPlan(p, o) {
  const c = p.counts, L = [];
  const big = p.queued.some((e) => e.todo.some((l) => l >= 3));
  const lv = o.retryFailed ? "the failed levels of failed models" : o.levels.map((l) => (l === 5 ? "big" : `L${l}`)).join("+");
  L.push(`tool-fidelity: ${o.live ? "LIVE" : "DRY RUN, nothing is sent"}  fixture ${FIXTURE_ID}  levels ${lv}  ${o.force ? "force (asks again)" : o.retryFailed ? "retry-failed" : "incremental (only what has no result yet)"}`);
  L.push(`models: ${num(c.probeOk)} probe-ok; ${num(c.relay)} Anthropic relay model(s) not probed (provenance: known good); ${num(c.probeSet)} in the probe set`);
  L.push(`  with a record: ${num(c.withRecord)} of ${num(c.probeSet)}; with a record against the current fixture: ${num(c.withRecordCurrent)} of ${num(c.probeSet)}` +
    `${c.outdated ? `; against an older fixture: ${num(c.outdated)} (a recommendation to re-sweep, not queued)` : ""}` +
    `${c.pending ? `; ${num(c.pending)} failed once and wait for a second try` : ""}`);
  L.push(`  tools:false in the probe set: ${num(c.toolsFalse)} of ${num(c.probeSet)} (probed like the rest: the catalogue claim is what is being tested); of those, ${num(c.toolsFalseWithRecord)} have a record`);
  L.push(`  context length unknown: ${num(c.ctxUnknown)} of ${num(c.probeSet)} model(s) in the probe set${c.badId ? `; ${num(c.badId)} id(s) this file cannot hold were left out` : ""}`);
  if (p.cand) {
    const ex = p.ledger.l3.counts.byExcluded;
    L.push(`candidates (policy): ${num(p.cand.entries.length)} of ${num(c.probeSet)} probe-ok model(s) can be picked by the router (known context of at least ${num(p.cand.floor)}${p.cand.entries.some((e) => e.pinned) ? `, ${num(p.cand.entries.filter((e) => e.pinned).length)} pinned by --allow` : ""}); in the policy's own rank, best first`);
    L.push(`  excluded: ${Object.entries(ex).map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none"}${p.cand.pinned.length ? `; pins that are not probe-ok models and were ignored: ${p.cand.pinned.map((x) => show(x)).join(", ")}` : ""}`);
  }
  L.push(`this run: ${num(p.queued.length)} model(s) queued of ${num(c.probeSet)}${o.only ? ` (--only ${show(o.only.join(","), 80)})` : ""}${o.limit ? ` (--limit ${o.limit})` : ""}; ` +
    `${num(p.kept.length)} fit the per-provider cap of ${num(o.tfMaxTokens)} input tokens, ${num(p.waiting.length)} wait for the next run`);
  if (p.tooBig.length) L.push(`  WARNING: ${num(p.tooBig.length)} queued model(s) cost more than the cap on their own and will never run under it: raise --tf-max-tokens-per-provider to at least ${num(p.needed)}`);
  L.push(`  requests ${num(p.run.requests)}   input tokens ~${tok(p.run.inTokens)}   output tokens up to ~${tok(p.run.outTokens)}   (whole queue, before the cap: ${num(p.est.requests)} requests, ~${tok(p.est.inTokens)} input tokens)`);
  const free = p.run.entries.filter((e) => e.free).length, paid = p.run.paidModels;
  L.push(`  free tier ${num(free)} model(s): no money; paid tier ${num(paid)} model(s): estimate ${usd(p.run.usd)} (input and output priced, cap ${usd(o.maxSpend)}, row ceiling ${usd(o.maxRowCost)}; an unlisted price is charged at the highest listed paid price of the whole probe set)`);
  if (big) L.push(`  L3 and L4 each send ~${kb(p.run.sizes[3].bytes)} (~${tok(p.run.sizes[3].inTokens)} input tokens) per request, the big step ~${kb(p.run.sizes[5].bytes)} (~${tok(p.run.sizes[5].inTokens)}); a live run needs --l3 yes and --only or an explicit --max-spend or --tf-max-tokens-per-provider`);
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
  if (!p.kept.length && p.tooBig.length) return `--tf-max-tokens-per-provider ${num(o.tfMaxTokens)} is below the cost of one model for these levels: nothing would run. Use at least ${num(p.needed)}`;
  if (p.run.usd > o.maxSpend) return `the estimate ${usd(p.run.usd)} is above the cap ${usd(o.maxSpend)}: narrow the run (--only, --limit, --levels) or raise --max-spend`;
  return null;
}

/**
 * One model for the engine: the levels it still needs, the verdicts kept across the engine's retries, and the abort signals. Spend is kept here as
 * well as in the engine: every level a probe COMPLETED is charged, also when a later level errors (the engine charges only what a finished result
 * reports), so the report and the budget of the next phase count it.
 */
function makeProbe({ o, gw, fetchImpl, ac, spend }) {
  const charge = (t) => {
    t.charged ??= new Set();
    for (const [l, d] of Object.entries(t.done ?? {})) if ((d.v === "p" || d.v === "f") && !t.charged.has(l)) { t.charged.add(l); spend.total += t.entry.lc?.[l] ?? 0; }
  };
  return async (t, ctx) => {
    t.done ??= {};
    const r = await probeModel({ levels: t.entry.todo, prior: t.entry.prior?.lvr ?? "nnnn", done: t.done, fetchImpl, url: `${gw.base}/v1/messages`, key: gw.key, model: t.key,
      maxTokens: o.maxTokens, timeoutMs: o.timeoutSec * 1000, signal: ctx?.signal ? AbortSignal.any([ac.signal, ctx.signal]) : ac.signal });
    charge(t);
    if (r.aborted) return { aborted: true };
    if (r.inconclusive) return { s: r.inconclusive.s, ...(r.inconclusive.ra !== undefined ? { ra: r.inconclusive.ra } : {}), ...(r.inconclusive.http ? { http: r.inconclusive.http } : {}), p: r.inconclusive.why, m: r.inconclusive.why };
    return { s: "ok", tf: { done: t.done } };
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
  const loaded = deps.snapshot ?? loadSnapshot();
  if (!loaded.ok) { console.error(`tool-fidelity: no usable snapshot (${loaded.reason}) -- run: node menu/snapshot.mjs --build`); return 1; }
  const stored = loadFidelity(outFile);
  if (!stored.ok) { console.error(`tool-fidelity: ${path.basename(outFile)} is ${stored.reason}; it is not touched and nothing was planned (fix or move it first)`); return 1; }
  const bench = deps.bench ?? loadBench();
  const policy = o.candidates ? (deps.policy ?? loadPolicy(o.policyFile ?? POLICY_FILE)) : null;
  if (o.candidates && !policy) { console.error(`tool-fidelity: --candidates policy needs a compiled policy (${o.policyFile ? show(o.policyFile, 120) : "state/subagent/policy.json"}); it is missing or is not one. Nothing was planned`); return 1; }
  const p = plan({ snap: loaded.snap, bench, store: stored.models, o, policy, pending: stored.pending });
  if (o.only && !p.set.models.some((m) => selectOnly([m], o.only).length)) { console.error(`tool-fidelity: --only ${show(o.only.join(","), 80)} matches no probe-ok model`); return 1; }
  console.log(printPlan(p, { ...o, live: o.live }));
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
    const p2 = plan({ snap: loaded.snap, bench, store: fresh.models, o, policy, pending: fresh.pending });
    const again = liveRefusal(o, p2);
    if (again) { console.error(`tool-fidelity: refused: ${again}`); return 2; }
    if (!p2.kept.length) { console.log("tool-fidelity: nothing to probe (another run finished the work while this one waited for the lock)."); return 0; }
    return await runLive({ o, p: p2, loaded, stored: fresh, outFile, gw, fetchImpl, deps });
  } finally { got.release(); }
}

async function runLive({ o, p, loaded, stored, outFile, gw, fetchImpl, deps }) {
  const now = deps.now ?? (() => new Date());
  const save = deps.saveImpl ?? saveFidelity;
  const store = { ...stored.models };
  const keep = new Set((loaded.snap.rows ?? []).flatMap((r) => (r.models ?? []).map((m) => `${r.provider}/${m.id}`)));
  const ac = new AbortController();
  const spend = { total: 0 };
  let interrupts = 0, sinceSave = 0, saveWarned = false;
  const onSigint = () => { if (++interrupts > 1) process.exit(130); console.error("\ntool-fidelity: stopping -- probes in flight are dropped (not recorded) and what finished is saved (Ctrl-C again to force)"); ac.abort(); };
  process.on("SIGINT", onSigint);
  let pending = { ...(stored.pending ?? {}) };
  const writeOnce = () => save(outFile, store, { live: true, now: now(), keep, preserve: stored.rejected ?? {}, pending });
  // A failed periodic save never stops the run: the records stay in memory and the next save (or the final one) carries them.
  const periodic = () => { try { writeOnce(); sinceSave = 0; } catch (e) { if (!saveWarned) { saveWarned = true; console.error(`tool-fidelity: warning: could not save (${e?.message ?? e}); the records are kept and the save is retried`); } } };
  const tally = { t: 0, v: 0, x: 0, u: 0, pending: 0 }, other = {}, why = new Map(), got = new Set();
  let recorded = 0;
  const onResult = (r) => {
    if (r.s !== "ok" || !r.tf) { other[r.s] = (other[r.s] ?? 0) + 1; why.set(r.key, r.s === "skip" ? (r.w === "spend-cap" ? "spend" : r.w ?? "skip") : r.s); return; }
    const e = p.kept.find((k) => k.key === r.key);
    const rec = buildRecord(store[r.key] ?? null, r.tf.done, { now: now(), alias: !!e?.alias });
    if (!rec) { other.norecord = (other.norecord ?? 0) + 1; return; }       // no level actually ran: nothing is recorded
    got.add(r.key);
    store[r.key] = rec;                                                       // this run holds the lock and built the record from the current one: it replaces it
    if (rec.strikes === 1) tally.pending += 1; else tally[rec.t] += 1;
    recorded += 1;
    if (++sinceSave >= SAVE_EVERY) periodic();
  };
  const probe = makeProbe({ o, gw, fetchImpl, ac, spend });
  const opts = { ...sweepOptions(o), ...(deps.sweep ?? {}) };
  const phases = [["free tier", p.kept.filter((e) => e.free)], ["paid tier", p.kept.filter((e) => !e.free)]].filter(([, l]) => l.length);
  const started = Date.now();
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
  const after = fidelityCounts(p.set, store);
  let ledgerLines = [];
  try {
    const u = ledgerUniverses({ set: p.set, cand: p.cand });
    ledgerLines = [...coverageLines(coverage(u.l12, store, { level: "l12", pending, stuckRuns: o.pendingRuns }), "L1+L2 (every listed model)"),
      ...(u.l3 ? coverageLines(coverage(u.l3, store, { level: "l3", pending, stuckRuns: o.pendingRuns }), "L3 (candidates and the rest of the probe set)") : [])];
  } catch (e) { ledgerLines = [`coverage: the ledger could not be built (${e?.message ?? e}); this is a bug, not a result`]; }
  console.log(`\ntool-fidelity: ${recorded} record(s) ${saved ? "written" : "NOT saved"} in ${Math.round((Date.now() - started) / 1000)}s; est. spend ${usd(spend.total)} of the ${usd(o.maxSpend)} cap; ${probes} model(s) attempted`);
  console.log(`  verified (v) ${tally.v}   tools at small size (t) ${tally.t}   failed (x) ${tally.x}   failed once, asked again next run ${tally.pending}`);
  const notRecorded = Object.entries(other).map(([s, n]) => `${s} ${n}`).join(", ");
  if (notRecorded) console.log(`  not recorded (they stay queued; a refusal about the account is not a verdict on the model): ${notRecorded}`);
  if (p.waiting.length) console.log(`  ${num(p.waiting.length)} model(s) waited for the per-provider cap of ${num(o.tfMaxTokens)} input tokens: run again to continue`);
  const left = unprobedLines(skips, o);
  if (left) console.log(left);
  console.log(`  now: with a record ${num(after.withRecord)} of ${num(after.probeSet)} probe-ok (${num(after.probeOk)} incl. relay not probed); against the current fixture ${num(after.withRecordCurrent)} of ${num(after.probeSet)}; still queued ${num(after.queued)}; context length unknown ${num(after.ctxUnknown)} of ${num(after.probeSet)}`);
  for (const line of ledgerLines) console.log(show(line, 600));
  return code;
}

/**
 * The incremental pass as a function, for a scheduler to call later (nothing calls it yet): L1 and L2 for the probe-ok models that have no
 * record, inside the per-provider token cap. A model with a record is never in it, whatever its fixture version.
 */
export function runIncremental({ snap, bench, store, tfMaxTokens = DEFAULT_TOKENS_PER_PROVIDER, maxTokens = PROBE_MAX_TOKENS }) {
  const o = { levels: [...DEFAULT_LEVELS], force: false, retryFailed: false, only: null, limit: null, maxTokens, tfMaxTokens, candidates: false, allow: [], pendingRuns: 3 };
  const p = plan({ snap, bench, store, o });
  return { queue: p.kept, waiting: p.waiting, counts: p.counts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`tool-fidelity: ${e?.message ?? e}`); process.exitCode = 1; });
}


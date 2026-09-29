// The only entry point for `refresh/bench.mjs` (#114).
//
//   node refresh/bench-cli.mjs                       plan the sweep, send nothing
//   node refresh/bench-cli.mjs --live                probe every eligible row (probe-all mode)
//   node refresh/bench-cli.mjs --live --only aihubmix,openrouter/free
//   node refresh/bench-cli.mjs --live --limit 40     a sample, one row per provider first
//   node refresh/bench-cli.mjs --live --economy      the old breaker behaviour, opt-in
//   node refresh/bench-cli.mjs --compact             fold an interrupted run's log into bench.json
//   node refresh/bench-cli.mjs --redact              one-shot: redact provider text already stored
//   node refresh/bench-cli.mjs --live --only-file list.txt --force --max-tokens 1024
//                                                    re-probe exactly the rows in list.txt (provider/id per
//                                                    line, # comments; combinable with --only). A row not in
//                                                    the current snapshot is reported and skipped.
//
// The provider's own sentences (`m`, and the head of a non-ok `p`) are REDACTED before they are stored and
// again when loaded (masked keys, key shapes, URLs, e-mail addresses, opaque ids: menu/redact.mjs).
// --reclassify-notices [--dry] turns the `ok` records whose reply is really an error or account notice (a 200 stream carrying a
// refusal) into auth / pay / error, in bench.json and the log, once (same lock and atomic write as --redact).
// --redact applies the same pass to bench.json once; it takes the sweep lock, so it refuses under a running sweep.
// A probe sent with a non-default --max-tokens records that budget (`b`) on its result.
//
// EACH PROBE MAY TAKE 4 MINUTES (--timeout, default 240 s, both modes). Slow models and slow gateways
// are the reason; the cost is that a provider whose rows all hang can take hours, so --max-minutes
// (150 by default) is the real backstop. Nothing waits out a hung probe: Ctrl-C, the wall-clock stop
// and a confirmed gateway outage each abort the probes in flight (dropped, re-probed on resume). A
// probe that only fails after an outage began is put back, not recorded. And since 30 consecutive
// failures can take a quarter of an hour to arrive at 240 s each, a full timeout plus a minute with
// not one ok anywhere also triggers the gateway check.
//
// PROBE-ALL IS THE DEFAULT. The aim is to find every operational model, so no provider
// is ever skipped as `provider-dead` or `unfunded`, however many of its models were
// refused (auth, pay) or errored. Politeness replaces skipping: after --cool-after (10)
// consecutive auth/pay/error/timeout results with no ok, a provider drops to one
// request in flight with at least --cool-gap-ms (400) between dispatches, no second
// attempt at its failing rows, and goes back to normal on its next ok. Budget defaults:
// a $0.10 per-row ceiling, a $5 total cap and a 150 min wall-clock limit
// (--max-minutes); an explicit --max-row-cost / --max-spend / --max-minutes always wins.
// Rows over the ceiling or past the cap are still recorded `skip` (`row-cost` /
// `spend-cap`) and the run lists how many remain unprobed. The cap is an ESTIMATE charged
// from the output tokens each provider reports, not a hard bound on the invoice; refused
// requests (401/402/404/5xx) are normally not billed, a stream that fails after tokens
// flowed can be. `--probe-all` is accepted and does nothing (it is the default).
//
// --economy restores the old breakers, for a cheap first look: 3 consecutive refusals or
// errors with no success mark a provider dead, 5 consecutive pay results on paid rows stop
// its paid rows, both recorded `skip`; ceiling $0.01, cap $2, no wall-clock limit, and no
// cooling. Explicit flags still win over these defaults.
//
// ONE SWEEP AT A TIME. A live run holds an exclusive lock file (state/bench.lock: pid,
// start time, mode); a second `--live`, or a `--compact` while one runs, is refused with
// exit code 5 before anything is sent or written. A lock whose process is gone, or that
// outlived its own --max-minutes plus a margin, is taken over with a notice. A running
// `bench-cli.mjs --live` process from code that predates the lock is looked for too
// (best effort, through the OS). The cap and ceiling are PER INVOCATION: a resumed run
// starts with a fresh budget.
//
// EVERY live run (either mode) watches for a dead gateway: after --outage-after (30)
// consecutive hard results with no ok anywhere it checks /health; if down it pauses, puts
// the affected rows back UNRECORDED, polls, and gives up (resumable, exit 4) after
// --outage-wait-min (10). Exit 3 means requests were sent and not one model answered ok.
//
// DRY BY DEFAULT, for the reason `refresh/cli.mjs` records: a live run is ~6,000
// real completions through the gateway your running sessions share, on accounts
// that may bill. A bare invocation, a typo or a shell-history recall must cost
// nothing. `--live` is the consent, and it is per invocation: this is never
// scheduled (the project's standing decision is that nothing privileged runs on
// a timer).
//
// It reads the picker's snapshot for WHAT to probe and Claude Code's own settings
// for WHERE (the gateway) -- never the vault, never a provider key.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { gatewayConnection } from "../menu/ccr-client.mjs";
import { BENCH_MAX_TOKENS, BENCH_FILE, BENCH_FRESH_MS, benchKeyOf } from "../menu/bench-data.mjs";
import { buildTargets, probeOne, runSweep, billedCost, STREAM_CUT_FACTOR, UNPRICED_PER_M } from "./bench.mjs";
import { createLogWriter, loadExisting, isFresh, compact, redactBench, reclassifyNotices } from "./bench-store.mjs";
import fs from "node:fs";
import { acquireLock, sweepStatus } from "./bench-lock.mjs";

export const DEFAULTS = Object.freeze({
  concurrency: 8, perProvider: 2, maxSpend: 5, maxRowCost: 0.1,
  maxTokens: BENCH_MAX_TOKENS, streamCut: null, ttlDays: 7, timeoutSec: 240, limit: null,
  coolAfter: 10, coolGapMs: 400, outageAfter: 30, outageWaitMin: 10, maxMinutes: 150,
});

// What --economy puts the budget back to (the pre-probe-all behaviour), for any of these
// the user did not set. The breaker thresholds live in `sweepOptions`.
export const ECONOMY_DEFAULTS = Object.freeze({ maxSpend: 2, maxRowCost: 0.01, maxMinutes: null });
export const ECONOMY_BREAKERS = Object.freeze({ deadAfter: 3, unfundedAfter: 5 });

const NUMERIC = {
  "--concurrency": ["concurrency", true], "--per-provider": ["perProvider", true],
  "--max-spend": ["maxSpend", false], "--max-row-cost": ["maxRowCost", false],
  "--max-tokens": ["maxTokens", true], "--ttl": ["ttlDays", false],
  "--timeout": ["timeoutSec", false], "--limit": ["limit", true],
  "--cool-after": ["coolAfter", true], "--cool-gap-ms": ["coolGapMs", false],
  "--outage-after": ["outageAfter", true], "--outage-wait-min": ["outageWaitMin", false],
  "--max-minutes": ["maxMinutes", false],
};

/**
 * The scheduler options this invocation implies, minus the things only `main` has
 * (the probe, the signal, the sink). Pure, so the mapping is testable. Probe-all (the
 * default) has no breakers and cools instead; --economy has the breakers and NO cooling,
 * whatever `--cool-after` says.
 */
export function sweepOptions(o) {
  return {
    concurrency: o.concurrency, perProvider: o.perProvider, maxSpend: o.maxSpend, maxRowCost: o.maxRowCost,
    probeAll: !o.economy, coolAfter: o.economy ? Infinity : o.coolAfter, coolGapMs: o.coolGapMs,
    ...(o.economy ? ECONOMY_BREAKERS : {}),
    maxMs: o.maxMinutes ? o.maxMinutes * 60000 : Infinity,
    outageAfter: o.outageAfter, outageWaitMs: o.outageWaitMin * 60000,
    // With a long per-probe timeout, 30 consecutive failures can take a quarter of an hour to arrive; a full
    // timeout plus a minute with not one ok anywhere is the second, time-based, trigger for the gateway check.
    outageIdleMs: o.timeoutSec * 1000 + 60000,
  };
}

/**
 * The process exit code for a finished sweep: 4 when the run gave up on a dead gateway,
 * 3 when requests were sent and NOTHING answered ok (a wholesale failure the caller
 * should not read as success), else 0. A Ctrl-C is the user's own decision: 0.
 */
export function sweepExit(result) {
  if (result.outage?.gaveUp) return 4;
  if (result.stopped === "signal") return 0;
  return result.probes > 0 && !(result.counts?.ok > 0) ? 3 : 0;
}

/**
 * A `--only-file` list: one `provider/id` per line; `#` starts a comment (whole line or after
 * the id); blank lines, CRLF and a BOM are ignored; a `[1m]` suffix is stripped the way bench
 * keys are. A line without a `/` is an ERROR, not a provider name: `buildTargets` reads a
 * bare word as "the whole provider", and a typo in a list must never widen a run.
 */
export function parseOnlyList(text) {
  const keys = [], errors = [];
  const seen = new Set();
  String(text ?? "").replace(/^﻿/, "").split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    if (/\s/.test(line) || !line.includes("/") || line.startsWith("/") || line.endsWith("/")) {
      errors.push(`line ${i + 1}: expected one provider/id, got ${JSON.stringify(raw.trim().slice(0, 60))}`);
      return;
    }
    const key = benchKeyOf(line);
    if (!seen.has(key)) { seen.add(key); keys.push(key); }
  });
  return { keys, errors };
}

/** The `max_tokens` a non-default probe was sent with is recorded (`b`) so a 1024-token answer is not read as a 96-token one. */
/** The token count at which a probe's stream is cut: `--stream-cut N`, else 4 x max_tokens; 0 means off. */
export const cutTokens = (o) => (o.streamCut === 0 ? 0 : o.streamCut ?? STREAM_CUT_FACTOR * o.maxTokens);
/** The most tokens one probe can bill: max_tokens, or the cut allowance when providers ignore max_tokens. The ceiling and the reservation use this. */
export const ceilTokens = (o) => Math.max(o.maxTokens, cutTokens(o));

export function withBudget(res, maxTokens) {
  return res?.aborted || maxTokens === BENCH_MAX_TOKENS ? res : { ...res, b: maxTokens };
}

/** Parses argv into options, or `{ error }`. Every number must be a positive finite value. */
export function parseArgs(argv) {
  const o = { ...DEFAULTS, live: false, force: false, compact: false, redact: false, reclassify: false, dry: false, economy: false, only: null, onlyFile: null };
  let sawProbeAll = false;
  const explicit = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") o.live = true;
    else if (a === "--force") o.force = true;
    else if (a === "--compact") o.compact = true;
    else if (a === "--redact") o.redact = true;
    else if (a === "--reclassify-notices") o.reclassify = true;
    else if (a === "--dry") o.dry = true;
    else if (a === "--only-file") {
      const v = argv[++i];
      if (!v) return { error: "--only-file needs a path: one provider/id per line, # for comments" };
      o.onlyFile = v;
    } else if (a === "--stream-cut") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 0) return { error: "--stream-cut needs a non-negative integer (tokens; 0 turns the cut off)" };
      o.streamCut = v;
    } else if (a === "--probe-all") sawProbeAll = true;   // the default now: accepted, does nothing
    else if (a === "--economy") o.economy = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v) return { error: "--only needs a value, e.g. --only aihubmix,openrouter/free" };
      o.only = v.split(",").map((s) => s.trim()).filter(Boolean);
      if (!o.only.length) return { error: "--only needs at least one provider or provider/id (an empty list would mean every row)" };
    } else if (NUMERIC[a]) {
      const [key, integer] = NUMERIC[a];
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0 || (integer && !Number.isInteger(v))) {
        return { error: `${a} needs a positive ${integer ? "integer" : "number"}` };
      }
      o[key] = v; explicit.add(key);
    } else return { error: `unrecognised argument ${JSON.stringify(a)}` };
  }
  if (o.reclassify && (o.live || o.compact || o.redact)) return { error: "--reclassify-notices is a maintenance command of its own: do not combine it with --live, --compact or --redact" };
  if (o.dry && !o.reclassify) return { error: "--dry only applies to --reclassify-notices (it previews the change and writes nothing)" };
  if (o.redact && (o.live || o.compact)) return { error: "--redact is a maintenance command of its own: do not combine it with --live or --compact" };
  if (o.economy && sawProbeAll) return { error: "--economy and --probe-all contradict each other (probe-all is the default)" };
  if (o.economy) for (const [k, v] of Object.entries(ECONOMY_DEFAULTS)) if (!explicit.has(k)) o[k] = v;
  o.probeAll = !o.economy;
  return o;
}

// How long a good record is protected from being replaced by a newer transient one (a
// flaky re-probe must not erase a measurement the picker would still show).
const keepMs = (o) => Math.max(o.ttlDays * 864e5, BENCH_FRESH_MS);

/** Drop rows that a resume should not re-probe. `force` keeps everything. */
export function dropFresh(groups, existing, { ttlMs, nowMs = Date.now(), force = false }) {
  if (force) return { groups, fresh: 0 };
  let fresh = 0;
  const out = new Map();
  for (const [p, list] of groups) {
    const keep = list.filter((t) => {
      if (isFresh(existing.get(t.key), { ttlMs, nowMs })) { fresh += 1; return false; }
      return true;
    });
    if (keep.length) out.set(p, keep);
  }
  return { groups: out, fresh };
}

/**
 * At most `n` rows in total, taken round-robin across providers so a small sample
 * still contains every provider's canary instead of 40 rows of one provider.
 */
export function limitGroups(groups, n) {
  if (!n) return groups;
  const lists = [...groups].map(([p, l]) => [p, l, 0]);
  const out = new Map(lists.map(([p]) => [p, []]));
  let left = n;
  while (left > 0 && lists.some(([, l, i]) => i < l.length)) {
    for (const e of lists) {
      if (left <= 0) break;
      if (e[2] < e[1].length) { out.get(e[0]).push(e[1][e[2]++]); left -= 1; }
    }
  }
  for (const [p, l] of out) if (!l.length) out.delete(p);
  return out;
}

/** Median total time, in seconds, of the real measurements already on disk; null when there are none. */
export function medianSeconds(existing) {
  const ds = [];
  for (const rec of existing.values()) if (rec?.s === "ok" && Number.isFinite(rec.d) && rec.d > 0) ds.push(rec.d);
  if (!ds.length) return null;
  ds.sort((a, b) => a - b);
  return ds[Math.floor((ds.length - 1) / 2)] / 1000;
}

/** The numbers the dry run prints. Pure, so it can be asserted on. */
export function summarize(groups, o) {
  let rows = 0, free = 0, paid = 0, est = 0, worstSum = 0, overRow = 0, unpricedRows = 0;
  const per = [], overList = [];
  for (const [p, list] of groups) {
    const f = list.filter((t) => t.free).length;
    const over = (t) => !t.free && (t.worst ?? t.cost) > o.maxRowCost;
    const cost = list.filter((t) => !t.free && !over(t)).reduce((s, t) => s + t.cost, 0);
    worstSum += list.filter((t) => !t.free && !over(t)).reduce((s, t) => s + (t.worst ?? t.cost), 0);
    overRow += list.filter(over).length;
    for (const t of list) if (over(t)) overList.push({ key: t.key, worst: t.worst ?? t.cost });
    rows += list.length; free += f; paid += list.length - f; est += cost; unpricedRows += list.filter((t) => !t.free && t.unpriced).length;
    per.push({ provider: p, rows: list.length, free: f, paid: list.length - f, cost });
  }
  per.sort((a, b) => b.rows - a.rows);
  // Per-probe latency: the MEDIAN of what earlier runs measured on this machine when
  // there is any, else 3 s. The fallback was measured once (2-4 s) and a live sample
  // the same day ran 8-24 s on slower providers, so a fixed guess understates badly.
  const AVG_S = o.avgSec ?? 3;
  const largest = per[0]?.rows ?? 0;
  const wallSec = Math.max((rows * AVG_S) / o.concurrency, (largest * AVG_S) / o.perProvider);
  // The optimistic figure above assumes every probe answers in the typical time. If a
  // provider hangs to the timeout, a row costs up to two attempts (one retry) of it,
  // and a provider serves at most `perProvider` (or, cooled, one) at a time.
  const T = o.timeoutSec ?? DEFAULTS.timeoutSec;
  const worstWallSec = Math.max((rows * T * 2) / o.concurrency, (largest * T * 2) / o.perProvider);
  // `estSpend` is what typical-length answers would bill if every paid row under the
  // ceiling answered; `worstSpend` is every one of them billed at the full max_tokens.
  // Refused rows bill nothing, so the real figure is lower than either when providers refuse.
  overList.sort((a, b) => b.worst - a.worst || (a.key < b.key ? -1 : 1));
  return { rows, free, paid, unpricedRows, providers: groups.size, estSpend: est, worstSpend: worstSum,
           spendCapped: est > o.maxSpend, spendMayBind: worstSum > o.maxSpend,
           overRow, overTop: overList.slice(0, 5), wallSec, worstWallSec, per };
}

const fmtDur = (s) => (s < 90 ? `${Math.round(s)}s` : s < 180 * 60 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(s < 36000 ? 1 : 0)} h`);
const usd = (v) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;

/**
 * What the answers already on file would have cost, ESTIMATED: the latest record per
 * model, priced the way the sweep prices a probe (`billedCost`). It is not a ledger:
 * a row measured twice counts once, and a record from before the sweep kept a token
 * count is priced at the typical figure.
 */
export function recordedSpend(targets, existing) {
  let sum = 0;
  for (const list of targets.values()) for (const t of list) sum += billedCost(t, existing.get(t.key) ?? {});
  return sum;
}

/**
 * `info` (all optional): `recorded` the estimate above; `running` a sweepStatus() whose
 * `message` says another sweep holds the lock right now.
 */
const tokensNote = (o) => `${ceilTokens(o)} tokens (max_tokens ${o.maxTokens}${cutTokens(o) ? `; a stream is cut at ${cutTokens(o)}, --stream-cut` : "; no stream cut"})`;

export function printPlan(sum, o, fresh, gw, info = {}) {
  const L = [];
  const pa = !o.economy;
  if (info.running?.message) L.push(`NOTE: ${info.running.message.replace("; nothing was sent", "")} -- a --live run would refuse to start`);
  L.push(`mode: ${pa ? "probe-all (default)" : "economy (breakers on; --economy)"}`);
  L.push(`${sum.rows} row(s) to probe across ${sum.providers} provider(s)` +
    `${fresh ? `  (${fresh} already fresh within ${o.ttlDays} d, skipped)` : ""}`);
  if (pa) {
    L.push(`  no provider is skipped for refusals or errors; after ${o.coolAfter} in a row with no success a provider is ` +
      `cooled to 1 request at a time, >= ${o.coolGapMs} ms apart, until it answers`);
    L.push(`  free ${sum.free}   paid ${sum.paid}   spend, paid rows under the ${usd(o.maxRowCost)} row ceiling: ` +
      `estimate ~${usd(sum.estSpend)} (typical answers), worst case ~${usd(sum.worstSpend)} (every one at up to ${tokensNote(o)})`);
    L.push(`  the ${usd(o.maxSpend)} cap is an ESTIMATE, charged from the output tokens each provider reports; each in-flight ` +
      "probe holds its worst case, so the estimate cannot pass the cap. It is not a hard bound on the invoice" +
      `${sum.spendCapped ? "; the estimate is above it, so the cap WILL bind" : sum.spendMayBind ? "; the worst case is above it, so it MAY bind" : ""}`);
    if (sum.spendCapped || sum.spendMayBind) {
      L.push("  paid rows are queued cheapest-first within each provider, so the cap cuts the LATE, expensive rows; " +
        "rows recorded skip:spend-cap are re-probed on the next run");
    }
    L.push("  refused or errored requests (401/402/404/5xx) are normally not billed and cost nothing here; a stream that " +
      "fails after tokens flowed can be billed, and is charged when the provider reported them");
  } else {
    L.push(`  ${ECONOMY_BREAKERS.deadAfter} consecutive refusals or errors with no success mark a provider dead, and ` +
      `${ECONOMY_BREAKERS.unfundedAfter} pay results stop its paid rows: the rest are recorded skip and NOT probed`);
    L.push(`  free ${sum.free}   paid ${sum.paid}   spend: up to ${usd(sum.estSpend)} if every paid row answers` +
      `${sum.spendCapped ? `, stopped at the ${usd(o.maxSpend)} cap` : ""}` +
      `, worst case ~${usd(sum.worstSpend)} at up to ${tokensNote(o)}` +
      " (refused probes are not billed; unfunded providers stop early, so expect far less)");
  }
  L.push(`  ${sum.unpricedRows ?? 0} paid row(s) have no catalogue price: their cost is an ASSUMPTION ($${UNPRICED_PER_M.in.toFixed(2)} in / ` +
    `$${UNPRICED_PER_M.out.toFixed(2)} out per million tokens, on the tokens the probe saw), and they are probed after the priced rows of their provider`);
  L.push(`  the ${usd(o.maxSpend)} cap and the ${usd(o.maxRowCost)} ceiling apply PER INVOCATION: a resumed or repeated run starts with ` +
    "a fresh budget" +
    `${Number.isFinite(info.recorded) ? `; the answers already on record would have cost ~${usd(info.recorded)} (estimate, latest record per model)` : ""}`);
  if (sum.overRow) {
    L.push(`  ${sum.overRow} paid row(s) whose worst case exceeds ${usd(o.maxRowCost)} will be skipped` +
      `${pa ? " (recorded skip:row-cost)" : ""}`);
    if (pa) {
      for (const r of sum.overTop) L.push(`    ${usd(r.worst)}  ${r.key}`);
      if (sum.overRow > sum.overTop.length) L.push(`    ... and ${sum.overRow - sum.overTop.length} more; raise --max-row-cost to probe them`);
    }
  }
  L.push(`  ~${fmtDur(sum.wallSec)} at concurrency ${o.concurrency}, ${o.perProvider} per provider, ` +
    `max_tokens ${o.maxTokens}${cutTokens(o) ? `, cut at ${cutTokens(o)}` : ""}, ${o.timeoutSec}s timeout -- OPTIMISTIC (typical answer times); ` +
    `worst case ~${fmtDur(sum.worstWallSec)} if providers hang to the timeout`);
  if (o.maxMinutes) {
    L.push(`  the run stops itself after ${o.maxMinutes} min (--max-minutes)` +
      `${sum.worstWallSec > o.maxMinutes * 60 ? ` -- the worst case above is ${Math.round(sum.worstWallSec / (o.maxMinutes * 60))}x longer, so THAT stop is the real backstop` : ""}` +
      "; probes still in flight are dropped and the rest resumes on the next run");
  } else L.push("  no wall-clock limit (economy): add --max-minutes N to bound a run whose providers hang");
  L.push(`  gateway: ${gw ? "settings found (loopback)" : "NOT FOUND -- a live run would refuse to start"}`);
  L.push("");
  for (const r of sum.per.slice(0, 12)) {
    L.push(`  ${r.provider.padEnd(18)} ${String(r.rows).padStart(5)} rows   free ${String(r.free).padStart(4)}   paid ${String(r.paid).padStart(4)}   ${usd(r.cost)}`);
  }
  if (sum.per.length > 12) L.push(`  ... and ${sum.per.length - 12} more provider(s)`);
  return L.join("\n");
}

/** After a run: how many rows were left unprobed by a budget rule, by reason. Null when none. */
export function unprobedLines(skips, o) {
  const rc = skips?.["row-cost"] ?? 0, sc = skips?.["spend-cap"] ?? 0;
  const other = Object.entries(skips ?? {}).filter(([w]) => w !== "row-cost" && w !== "spend-cap");
  if (!rc && !sc && !other.length) return null;
  const L = [`  ${rc + sc + other.reduce((s, [, n]) => s + n, 0)} row(s) remain unprobed:`];
  if (rc) L.push(`    ${rc} over the ${usd(o.maxRowCost)} row ceiling (row-cost) -- raise --max-row-cost`);
  if (sc) L.push(`    ${sc} past the ${usd(o.maxSpend)} spend cap (spend-cap) -- raise --max-spend, then re-run to resume`);
  for (const [w, n] of other) L.push(`    ${n} skipped as ${w}`);
  return L.join("\n");
}

/**
 * Is the gateway answering `/health`? The start-up gate retries once (`retries: 1`, after 2 s): the first
 * call can take longer than a few seconds while the gateway is busy with a live session, and refusing to
 * start over one slow answer wasted a run. Each attempt waits up to 10 s. Everything is injectable.
 */
export async function gatewayUp(base, {
  fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 10000, retries = 0, retryDelayMs = 2000,
} = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.status < 500) return true;
    } catch { /* refused, reset or timed out: counts as not answering */ }
    if (attempt < retries) await sleep(retryDelayMs);
  }
  return false;
}

/** Exit code for "another sweep is running" (and for a --compact refused because of one). */
export const EXIT_BUSY = 5;

/**
 * `deps` exists for tests: `lockFile`, `isAlive`, `findRunning` (the OS scan for a
 * lockless sweep). Nothing else is injectable, and a test that reaches past the lock
 * check would touch the real state directory, so tests stop at the lock.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const o = parseArgs(argv);
  if (o.error) { console.error(`bench: ${o.error}`); return 2; }
  const lockDeps = { ...(deps.lockFile ? { file: deps.lockFile } : {}), ...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
                     ...(deps.findRunning ? { findRunning: deps.findRunning } : {}) };

  // --redact rewrites bench.json in place: it takes the sweep lock for the duration, so it
  // refuses under a running sweep and no sweep can start under it.
  if (o.redact) {
    const got = acquireLock({ ...lockDeps, mode: "redact" });
    if (!got.ok) { console.error(`bench: cannot redact -- ${got.message.replace("; nothing was sent", "")}`); return EXIT_BUSY; }
    try {
      const r = redactBench({ ...(deps.benchFile ? { benchFile: deps.benchFile } : {}), ...(deps.logFile ? { logFile: deps.logFile } : {}) });
      if (!r.ok) { console.error(`bench: cannot redact -- ${r.reason}`); return 1; }
      if (!r.benchOk) console.error(`bench: note: no readable ${path.basename(deps.benchFile ?? BENCH_FILE)} (missing, corrupt or another schema); only the log was redacted`);
      console.log(`bench: redacted ${r.changed} of ${r.records} record(s) in ${path.basename(deps.benchFile ?? BENCH_FILE)}` +
        `${r.logRecords ? `; ${r.logChanged} of ${r.logRecords} in the log` : ""}` +
        `${r.changed || r.logChanged ? "" : " (nothing needed it)"}`);
      return 0;
    } finally { got.release(); }
  }
  // --reclassify-notices: an `ok` whose reply is really an error or account notice (a provider's refusal delivered as a 200
  // stream) becomes auth / pay / error. Same pattern as --redact: it takes the sweep lock and writes atomically. `--dry` is
  // the preview: it counts and lists what WOULD change and writes nothing (so it needs no lock).
  if (o.reclassify) {
    const paths = { ...(deps.benchFile ? { benchFile: deps.benchFile } : {}), ...(deps.logFile ? { logFile: deps.logFile } : {}) };
    const show = (r) => {
      const base = path.basename(deps.benchFile ?? BENCH_FILE);
      if (!r.benchOk) console.error(`bench: note: no readable ${base} (missing, corrupt or another schema); only the log was examined`);
      const kinds = Object.entries(r.byStatus).map(([k, n]) => `ok -> ${k} ${n}`).join(", ");
      console.log(`bench: ${o.dry ? "would reclassify" : "reclassified"} ${r.changed} of ${r.records} record(s) in ${base}` +
        `${r.logRecords ? `; ${r.logChanged} of ${r.logRecords} in the log` : ""}` +
        `${kinds ? ` (${kinds})` : " (nothing needed it)"}`);
      for (const x of r.samples) console.log(`  ${x.key}  ->  ${x.to}   ${JSON.stringify(x.p)}`);
    };
    if (o.dry) {
      const r = reclassifyNotices({ ...paths, dry: true });
      if (!r.ok) { console.error(`bench: cannot reclassify -- ${r.reason}`); return 1; }
      show(r);
      console.log("bench: --dry: nothing was written");
      return 0;
    }
    const got = acquireLock({ ...lockDeps, mode: "reclassify" });
    if (!got.ok) { console.error(`bench: cannot reclassify -- ${got.message.replace("; nothing was sent", "")}`); return EXIT_BUSY; }
    try {
      const r = reclassifyNotices(paths);
      if (!r.ok) { console.error(`bench: cannot reclassify -- ${r.reason}`); return 1; }
      show(r);
      return 0;
    } finally { got.release(); }
  }
  // A --compact rewrites bench.json and truncates the log: never under a running sweep.
  if (o.compact) {
    const st = sweepStatus(lockDeps);
    if (st.running) { console.error(`bench: cannot compact -- ${st.message.replace("; nothing was sent", "")}`); return EXIT_BUSY; }
  }
  // A live run holds the lock for its whole life, however it ends.
  let lock = null, onExit = null;
  if (o.live) {
    const got = acquireLock({ ...lockDeps, mode: o.economy ? "economy" : "probe-all", maxMinutes: o.maxMinutes });
    if (!got.ok) { console.error(`bench: ${got.message}`); return EXIT_BUSY; }
    lock = got;
    if (got.tookOver) console.error(`bench: took over a stale sweep lock (${got.tookOver.why})`);
    if (got.unchecked) console.error("bench: note: could not look for a sweep started before the lock existed; relying on the lock only");
    onExit = () => lock.release();
    process.on("exit", onExit);
  }
  try {
    return await runMain(o, lockDeps, deps);
  } finally {
    if (lock) { lock.release(); process.removeListener("exit", onExit); }
  }
}

async function runMain(o, lockDeps, deps = {}) {
  const loaded = deps.snapshot ?? loadSnapshot();
  if (!loaded.ok) {
    console.error(`bench: no usable snapshot (${loaded.reason}) -- run: node menu/snapshot.mjs --build`);
    return 1;
  }
  // The whole catalogue at the DEFAULT budget: the keep-set for compaction, and the base of the
  // recorded-spend estimate (a timeout is charged its row's worst case, which must not swell just
  // because this invocation asks for a larger max_tokens).
  const all = buildTargets(loaded.snap, { maxTokens: BENCH_MAX_TOKENS * STREAM_CUT_FACTOR });
  const keep = new Set([...all.values()].flat().map((t) => t.key));

  if (o.compact) {
    const n = compact({ keep, ttlMs: keepMs(o) });
    console.log(`bench: compacted the log into ${BENCH_FILE} (${n} record(s))`);
    return 0;
  }

  let only = o.only;
  if (o.onlyFile) {
    let text;
    try { text = fs.readFileSync(o.onlyFile, "utf8"); }
    catch (e) { console.error(`bench: --only-file ${o.onlyFile}: cannot read it (${e?.code ?? e?.message})`); return 1; }
    const list = parseOnlyList(text);
    if (list.errors.length) {
      console.error(`bench: --only-file ${o.onlyFile}: ${list.errors.slice(0, 5).join("; ")}${list.errors.length > 5 ? `; and ${list.errors.length - 5} more` : ""}`);
      return 1;
    }
    if (!list.keys.length) { console.error(`bench: --only-file ${o.onlyFile} lists no rows`); return 1; }
    const present = list.keys.filter((k) => keep.has(k));
    const missing = list.keys.filter((k) => !keep.has(k));
    console.log(`bench: --only-file ${path.basename(o.onlyFile)}: ${list.keys.length} row(s) listed, ${present.length} probeable in the current snapshot` +
      `${missing.length ? `; ${missing.length} not in it (or not probeable), skipped: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", ..." : ""}` : ""}`);
    // A list that contributes NOTHING is an error even when --only would still select rows: --only-file is the narrowing
    // half of the pair, and an all-unknown list must never quietly become "the whole provider".
    if (!present.length) { console.error(`bench: --only-file ${path.basename(o.onlyFile)} contributes no probeable row (none of its ${list.keys.length} listed row(s) is in the current snapshot); nothing was planned`); return 1; }
    only = [...(o.only ?? []), ...present];
    if (o.only?.length) {
      const viaOnly = [...buildTargets(loaded.snap, { only: o.only, maxTokens: ceilTokens(o) }).values()].flat().length;
      const union = [...buildTargets(loaded.snap, { only, maxTokens: ceilTokens(o) }).values()].flat().length;
      console.log(`bench: selection is the UNION of --only ${o.only.join(",")} (${viaOnly} row(s)) and --only-file (${present.length} row(s)): ${union} row(s)`);
    }
  }
  const targets = buildTargets(loaded.snap, { only, maxTokens: ceilTokens(o) });
  if (only && !targets.size) { console.error(`bench: --only ${only.join(",")} matches no probeable row`); return 1; }
  const existing = deps.existing ?? loadExisting({ ttlMs: keepMs(o) });
  const { groups: pending, fresh } = dropFresh(targets, existing, { ttlMs: o.ttlDays * 864e5, force: o.force });
  const work = limitGroups(pending, o.limit);
  const sum = summarize(work, { ...o, avgSec: medianSeconds(existing) });

  const recorded = recordedSpend(all, existing);
  if (!o.live) {
    const gw = gatewayConnection({ run: () => "-" });    // presence check only: nothing is executed
    console.log(printPlan(sum, o, fresh, gw, { recorded, running: sweepStatus(lockDeps) }));
    console.log("\nno request was made. Re-run with --live to probe.");
    return 0;
  }
  if (!sum.rows) { console.log("bench: nothing to probe (everything is fresh). Use --force to re-probe."); return 0; }

  const gw = gatewayConnection();
  if (!gw) { console.error("bench: cannot find the gateway address or its key in Claude Code's settings"); return 1; }
  if (!(await gatewayUp(gw.base, { retries: 1 }))) { console.error("bench: the gateway is not answering; nothing was sent"); return 1; }

  console.log(printPlan(sum, o, fresh, gw, { recorded }));
  console.log("");

  const ac = new AbortController();
  let interrupts = 0;
  process.on("SIGINT", () => {
    if (++interrupts > 1) process.exit(130);
    console.error("\nbench: stopping -- probes still in flight are dropped (not recorded; they are re-probed on resume) " +
      "and what finished is saved (Ctrl-C again to force)");
    ac.abort();
  });

  const writer = createLogWriter();
  const tally = {}; let done = 0;
  const started = Date.now();
  // A carriage-return progress line is right for a terminal and garbage in a log
  // or a pipe, where every tick becomes part of one enormous line.
  const tty = !!process.stderr.isTTY;
  const tick = setInterval(() => {
    const parts = Object.entries(tally).map(([s, n]) => `${s} ${n}`).join("  ");
    const line = `  ${done}/${sum.rows}  ${parts}   ${fmtDur((Date.now() - started) / 1000)}`;
    process.stderr.write(tty ? `\r${line}   ` : `${line}\n`);
  }, tty ? 2000 : 30000);

  let result;
  try {
    result = await runSweep({
      groups: work, signal: ac.signal,
      ...sweepOptions(o),
      gatewayCheck: () => gatewayUp(gw.base),
      // Ctrl-C (`ac`) and the engine's own per-probe signal (a time stop, a confirmed outage) both abort a probe.
      probe: async (t, ctx) => withBudget(await probeOne({ url: `${gw.base}/v1/messages`, key: gw.key, model: t.key,
                               maxTokens: o.maxTokens, cutAt: cutTokens(o), timeoutMs: o.timeoutSec * 1000,
                               signal: ctx?.signal ? AbortSignal.any([ac.signal, ctx.signal]) : ac.signal }), o.maxTokens),
      onResult: (r) => { writer.append(r.key, r); tally[r.s] = (tally[r.s] ?? 0) + 1; done += 1; },
    });
  } finally {
    clearInterval(tick);
    writer.close();
  }
  if (tty) process.stderr.write("\r".padEnd(60) + "\r");

  const n = compact({ keep, ttlMs: keepMs(o) });
  const stoppedBy = { signal: "stopped early (Ctrl-C)", time: `stopped at the ${o.maxMinutes} min limit (--max-minutes; probes still in flight were dropped and are re-probed on resume)`,
                      outage: "STOPPED: the gateway stayed down" }[result.stopped] ?? "finished";
  console.log(`bench: ${stoppedBy} -- ${done} recorded in ${fmtDur((Date.now() - started) / 1000)}, ` +
    `est. spend ${usd(result.spent)} this run (the ${usd(o.maxSpend)} cap is per invocation; a resumed run gets a fresh one); ` +
    `${n} record(s) in ${path.basename(BENCH_FILE)}`);
  console.log("  " + Object.entries(result.counts).map(([s, c]) => `${s} ${c}`).join("   "));
  if (result.dead.length) console.log(`  providers skipped as dead: ${result.dead.join(", ")}`);
  if (result.unfunded.length) console.log(`  providers whose paid rows were skipped as unfunded: ${result.unfunded.join(", ")}`);
  if (result.cooled?.length) console.log(`  providers cooled (1 at a time) after repeated refusals: ${result.cooled.join(", ")}`);
  const left = unprobedLines(result.skips, o);
  if (left) console.log(left);
  if (result.outage?.events) {
    console.log(`  the gateway stopped answering ${result.outage.events} time(s); ${result.outage.requeued} row(s) hit by it were ` +
      "put back UNRECORDED (they are re-probed on the next run)" +
      `${result.outage.gaveUp ? `, and the run gave up after ${o.outageWaitMin} min down` : "; the run resumed once it was back"}`);
  }
  if (result.aborted && sum.rows > done) console.log(`  ${sum.rows - done} row(s) not reached before the stop`);
  if (result.aborted) console.log("  re-run with --live to resume; finished rows are not re-probed");
  const code = sweepExit(result);
  if (code === 3) console.log("  NO model answered ok in this run: check the gateway and the provider keys (exit code 3)");
  if (code === 4) console.log("  exit code 4: the gateway did not come back");
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; },
              (e) => { console.error(`bench: ${e?.message ?? e}`); process.exitCode = 1; });
}

// Tool fidelity (issue #121): what each model ACTUALLY did under a tool-bearing request, kept in its OWN file, `state/tool-fidelity.json`.
//
// WHY ITS OWN FILE. The bench record is a whitelist (`FIELDS`, `toStored`, `cleanRecord`) and `mergeRecord` there returns the whole newer
// record: a tool field put on it would be dropped on the next write, or overwritten by a fresher probe that lacks it. So this file has its
// own cleaner, its own writer, and imports nothing from the bench store. The bench is READ (which models answered a bare chat probe),
// never written; a test pins that.
//
// RESULTS NEVER EXPIRE BY AGE. A record changes only when a re-sweep replaces it. Two things annotate it without invalidating it: an
// outdated fixture id (`fx` differs from the current fixture: the picker shows `*`, a re-sweep is recommended) and the alias cap (a pool
// alias row may be served by a different model tomorrow, so its compiled class stays `u` unless it failed). Neither re-queues anything.
//
// RECORD (one per `provider/id`), every field:
//   lvr       four characters, one per level L1..L4: p passed, f failed, n not run. Only CONFIRMED results are written here.
//   lv        highest level passed in a row: 0 none, 1 L1+L2, 3 L3, 4 L4              (derived from lvr)
//   t         the compiled class v | t | x | u                                          (derived: see classOf; never set by hand)
//   ok        boolean verdict: usable with tools (t is v or t)                          (derived)
//   why       the first failed level's reason, redacted and clipped
//   at        ISO time of the last probe       fx  the fixture id the L3/L4 result was measured against
//   maxBytes  the largest request the model ANSWERED (a lower bound; it never sets a payload cap)
//   alias     true for a pool alias (advisory: the model behind such an id can change)
//   big       p | f, the ~400 KB step (cc-tools-big-1), asked only of a model that passed L3; absent means not run. Kept OUT of lvr.
//   capBelow  bytes: the provider REFUSED a request of about this size or larger (an observed upper bound; the compiler lowers the
//             model's payload cap `pb` to it, so big requests skip the model and small subagents may still use it). Written only for a
//             refusal about SIZE (413, a body naming size or context length, any refusal at the big step), never for a rate limit.
//   strikes   1 | 2 and sl 1..3: TWO STRIKES. A first failure at level sl (L1, L2, or L3 for a reason that is not size) is only
//             PROVISIONAL: lvr keeps what it was (nnnn for a model never tested), strikes is 1, and the model stays queued for one retry.
//             The second failure at the same level CONFIRMS it (strikes 2, the `f` is written). A confirmed L1/L2 failure is class x; a
//             confirmed L3 failure that is not about size is class x too. A pass clears both fields.
//   fc        p: L1 passed ONLY when the call was forced (auto yielded none): class t at best, not clean.  f: forced failed too.  Absent: auto passed.
//   af        argument fidelity of the L1 call: every field byte for byte, the boolean a boolean, the integer an integer (p / f)
//   br        the answer after the ~20 KB tool_result used the fact at the END of it (p / f), from L2.   er  the is_error tool_result case answered, not empty (p / f), L7
//   nm        an MCP-style ~60-character tool name came back exactly (p / f), from the L3 constructs request (3a)
//   cc        the cache_control markers Claude Code sends were accepted (p) or rejected by name (f); a model that rejected them is not sent them again
//   sp        the Agent (spawn) tool: a valid call with a prompt and a recognised subagent_type (p / f), L6. Two strikes like L1-L3 (sl 6); never lowers the class
//   afw, l4w, l3w, spw  what differed when argument fidelity (af), the parallel-call check (L4), L3 or the spawn call (L6) failed: a few printable words, at most 60 characters ("old_string: newline lost",
//             "1 call of 2 stop=tool_use", "stop=end_turn blocks=none in=40210 out=0"). Never a verdict; cleared by a later pass
//   d3        what decided L3: a (failed at the 3a constructs request), b (failed at the 157 KB request), i (passed by implication: the big step passed first)
// L4 (parallel calls) is answered by the same 157 KB request as L3. None of these fields is part of lvr, and none changes the class except fc (class t at best).
// Compiler reads `t`, `alias`, `capBelow`, `big` and `lvr[3]` (L4): inside class v a model ranks big p, then big not run, then big f, and
// then L4 p, not run, f. The picker cell grammar still comes from lvr; a confirmed L3 failure that is not about size shows `x`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomic } from "../menu/atomic.mjs";
import { redactClip } from "../menu/redact.mjs";
import { benchKey } from "../menu/bench-data.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { RELAY_KEY_ID, isTier } from "../menu/tiers.mjs";
import { SUBSTITUTE_FLOOR, funnel } from "../menu/subagent-funnel.mjs";
import { isFree, UNPRICED_PER_M } from "./bench.mjs";
import { kindSize, kindsOf, BUDGETS, PROBE_MAX_TOKENS, LIFTS, deepAllowed, NOT_FREE_REASON, accountOrRoute, GATEWAY_WORDS, isAvailabilityText, namesRequest, hasMoneyWords } from "./tool-fidelity-probe.mjs";
export { NOT_FREE_REASON };
import { FIXTURE_ID } from "./tool-fidelity-fixture.mjs";

export const FILE_NAME = "tool-fidelity.json";
export const REAL_FILE = path.join(os.homedir(), ".uw", "state", FILE_NAME);
export const SCHEMA = 1;
export const KIND = "tool-fidelity";
export const MAX_FILE_BYTES = 1024 * 1024;           // the size of the file AS WRITTEN: about 7,000 records of about 140 bytes
export const MAX_READ_BYTES = 4 * 1024 * 1024;       // a file bigger than this is refused on read, never parsed
export const DEFAULT_TOKENS_PER_PROVIDER = 150000;   // input tokens per provider per invocation (the first free-tier pass)
export const DEFAULT_LEVELS = Object.freeze([1, 2, 6, 7]);       // the baseline: L1+L2 and the two cheap levels behind them (spawn, error result); `--levels 12` is L1+L2 alone
export const BIG_LEVEL = 5;                          // the ~400 KB step, a level of its own that is not part of lvr

const LVR_RE = /^[pfn]{4}$/;
const FX_RE = /^[A-Za-z0-9._-]{1,40}$/;
const FIELDS = new Set(["lv", "lvr", "t", "ok", "why", "at", "fx", "maxBytes", "alias", "big", "capBelow", "strikes", "sl", "fc", "af", "nm", "cc", "br", "er", "sp", "d3", "afw", "l4w", "l3w", "spw", "xw"]);
const NOTE_FIELDS = ["afw", "l4w", "l3w", "spw"];                                      // short reasons of non-blocking marker failures (printable ASCII, at most 60 characters): what differed, never a verdict
export const GATEWAY_WHY = GATEWAY_WORDS;                                  // the reason text of a failure caused by the gateway's own request translation
const noteOk = (x) => typeof x === "string" && /^[ -~]{1,60}$/.test(x);
const PF_FIELDS = ["fc", "af", "nm", "cc", "br", "er", "sp"];            // the one-letter p / f markers, in the order they are written
const WHY_CHARS = 160;
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// ------------------------------------------------------------------ derivation (the only place a class is computed)

/** Highest level passed in a row: the largest k such that levels 1..k all passed. */
export const contiguous = (lvr) => { let k = 0; while (k < 4 && lvr[k] === "p") k += 1; return k; };
/** The levels that passed above a gap (a pass after a level that did not pass): `ppfp` gives [4]. Never counted by the digit. */
export const outOfOrder = (lvr) => { const out = []; let gap = false; for (let i = 0; i < 4; i++) { if (lvr[i] !== "p") gap = true; else if (gap) out.push(i + 1); } return out; };
export const lvOf = (lvr) => { const k = contiguous(lvr); return k >= 4 ? 4 : k === 3 ? 3 : k === 2 ? 1 : 0; };
/**
 * The compiled class of a record (or of a bare lvr string): `u` nothing run; `v` L3 passed; `t` L1 and L2 passed; `x` otherwise (L1 failed, or L2
 * did not pass). One refinement: L3 failed, CONFIRMED (two strikes) and NOT about size (no capBelow) is `x` too: the model cannot take the real
 * tool set. A size refusal is never `x`: it caps the payload instead. A lone lvr string has no strikes, so it never gets that refinement.
 */
export function classOf(r) {
  const o = typeof r === "string" ? { lvr: r } : r;
  const lvr = o.lvr;
  if (lvr[0] === "n") return "u";
  const k = contiguous(lvr);
  if (k >= 3) return o.fc === "p" ? "t" : "v";               // a model that took the tool call only when it was FORCED is not clean: t at best
  if (k === 2) return lvr[2] === "f" && o.strikes >= 2 && o.sl === 3 && !o.capBelow ? "x" : "t";
  return "x";
}
/** What the compiler does with a record: an alias row stays `u` unless it failed (the same rule as `funnel`, which re-derives it from the id). */
export const compiledClass = (rec) => (rec.alias && rec.t !== "x" ? "u" : rec.t);
/** Is the record a first, unconfirmed failure? It keeps its earlier class and is asked again once. */
export const isProvisional = (rec) => !!rec && rec.strikes === 1;
/** The picker cell: the digit, `x` for L1 failed or a confirmed L3 failure, `-` for nothing run, and `*` when the record is against an older fixture. */
export function cellOf(rec, fixtureId = FIXTURE_ID) {
  if (!rec) return "-";
  const k = contiguous(rec.lvr);
  const base = rec.lvr[0] === "f" || (rec.lvr[0] === "p" && classOf(rec) === "x" && k >= 2) ? "x" : rec.lvr[0] === "n" ? "-" : String(Math.max(1, k));
  return base !== "-" && rec.fx !== fixtureId ? `${base}*` : base;
}
/** Rank keys inside class v (smaller ranks first): the big step, then L4. p 0, not run 1, failed 2. */
export const rankInV = (rec) => [{ p: 0, n: 1, f: 2 }[rec.big ?? "n"] ?? 1, { p: 0, n: 1, f: 2 }[rec.lvr?.[3] ?? "n"] ?? 1];
/** The payload cap an observed refusal sets, in bytes, or 0 for none. `maxBytes` is a lower bound and never sets one. */
export const payloadCapOf = (rec) => (Number.isInteger(rec?.capBelow) && rec.capBelow > 0 ? rec.capBelow : 0);
/** Just under the size that was refused, to a round figure: 156,892 bytes gives 150,000. */
export const capBelowFor = (bytes) => Math.max(10000, Math.floor((bytes - 1) / 10000) * 10000);

// ------------------------------------------------------------------ the cleaner

/** One stored record, or null when it is malformed in any way (unknown field, wrong range, a `t`/`lv`/`ok` that is not what the fields derive). */
export function cleanFidelity(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  for (const k of Object.keys(raw)) if (!FIELDS.has(k)) return null;
  const { lvr, lv, t, ok, why, at, fx, maxBytes, alias, big, capBelow, strikes, sl, d3 } = raw;
  if (typeof lvr !== "string" || !LVR_RE.test(lvr)) return null;
  if (typeof at !== "string" || at.length > 40 || !Number.isFinite(Date.parse(at))) return null;
  if (typeof fx !== "string" || !FX_RE.test(fx)) return null;
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 4_000_000) return null;
  if (alias !== undefined && typeof alias !== "boolean") return null;
  if (why !== undefined && (typeof why !== "string" || why.length > 400)) return null;
  if (big !== undefined && !/^[pfn]$/.test(big)) return null;
  if (capBelow !== undefined && !(Number.isInteger(capBelow) && capBelow >= 1 && capBelow <= 4_000_000)) return null;
  if ((strikes === undefined) !== (sl === undefined)) return null;
  if (strikes !== undefined && !((strikes === 1 || strikes === 2) && [1, 2, 3, 6].includes(sl))) return null;
  for (const k of PF_FIELDS) if (raw[k] !== undefined && !/^[pf]$/.test(raw[k])) return null;
  if (d3 !== undefined && !/^[abi]$/.test(d3)) return null;
  for (const k of NOTE_FIELDS) if (raw[k] !== undefined && !noteOk(raw[k])) return null;
  if (raw.xw !== undefined && raw.xw !== "gateway") return null;
  const d = classOf({ lvr, strikes, sl, capBelow, fc: raw.fc });
  if (lv !== lvOf(lvr) || t !== d || ok !== (d === "v" || d === "t")) return null;
  const w = why ? redactClip(why, WHY_CHARS) : "";
  return { lv, lvr, t, ok, ...(w ? { why: w } : {}), at, fx, maxBytes, ...(alias ? { alias: true } : {}),
           ...(big === "p" || big === "f" ? { big } : {}), ...(capBelow ? { capBelow } : {}), ...(strikes ? { strikes, sl } : {}),
           ...Object.fromEntries(PF_FIELDS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])), ...(d3 ? { d3 } : {}),
           ...Object.fromEntries(NOTE_FIELDS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]])), ...(raw.xw ? { xw: raw.xw } : {}) };
}

/** A key this file may hold: `provider/id`, no whitespace, at most 200 characters, never a prototype name. */
export const keyOk = (k) => typeof k === "string" && k.length <= 200 && /^[^\s/]+\/\S+$/.test(k) && !BAD_KEYS.has(k.split("/")[0]);

/**
 * Reads the file. `{ ok: true, absent: true, models: {} }` when there is none (every row is untested, not failed);
 * `{ ok: false, reason }` for a file that is unreadable, too large, or not this file; otherwise `{ ok: true, models, rejected, generatedAt, dropped }`.
 * `rejected` holds the RAW value of every record the cleaner refused under a good key (a newer writer's fields, say): they read as untested, never as
 * failed, and the writer keeps them (`preserve`) instead of silently deleting them. `dropped` counts everything refused, bad keys included.
 */
export function loadFidelity(file = REAL_FILE) {
  let text;
  try {
    if (fs.statSync(file).size > MAX_READ_BYTES) return { ok: false, reason: "too-large" };
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) { return e?.code === "ENOENT" ? { ok: true, absent: true, models: {}, rejected: {}, pending: {}, held: {}, meta: null, generatedAt: null, dropped: 0 } : { ok: false, reason: "unreadable" }; }
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: "corrupt" }; }
  if (!raw || raw.kind !== KIND || raw.schema !== SCHEMA || !raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) return { ok: false, reason: "schema" };
  const models = {}, rejected = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(raw.models)) {
    const rec = keyOk(k) ? cleanFidelity(v) : null;
    if (rec) models[k] = rec;
    else { dropped += 1; if (keyOk(k)) rejected[k] = v; }
  }
  return { ok: true, models, rejected, pending: cleanPending(raw.pending), held: cleanHeld(raw.held), meta: cleanMeta(raw.meta), generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null, dropped };
}

// ------------------------------------------------------------------ writing

/**
 * The PENDING map: for a model that was in a run's queue and ended it still untested, why, and in how many runs in a row. It is bookkeeping for the
 * coverage ledger (a model that waits for many runs is starving), not a result: it is dropped as soon as the model has one. `r` is a short reason code
 * (rate, pay, auth, timeout, error, gone, empty, reasoning-budget, request-cap, priced-over-row-cap, slow, route-shape, upstream-unavailable, cap, spend, row-cost, not-run), `n` the runs, `at` the last one,
 * `since` (additive, optional) the first time THIS reason was recorded in a row (an entry written before `since` existed reads as since its `at`), `rn` (additive, optional) the runs in a row
 * with THIS reason (it restarts at 1 when the reason changes; `n` is unchanged and counts every run; an entry without `rn` reads as rn = n) and `why` (additive, optional) the provider's own sentence,
 * clipped and redacted, so every block can be audited.
 */
export const PENDING_MAX = 5000;
export const PENDING_WHY_CHARS = 120;
export function cleanPending(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!keyOk(k) || !v || typeof v !== "object") continue;
    if (typeof v.r !== "string" || !/^[a-z0-9-]{1,24}$/.test(v.r) || !Number.isInteger(v.n) || v.n < 1 || v.n > 9999) continue;
    if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) continue;
    out[k] = { r: v.r, n: v.n, at: v.at, ...(typeof v.since === "string" && Number.isFinite(Date.parse(v.since)) ? { since: v.since } : {}),
      ...(Number.isInteger(v.rn) && v.rn >= 1 && v.rn <= 9999 ? { rn: v.rn } : {}), ...(typeof v.why === "string" && v.why.trim() ? { why: redactClip(v.why, PENDING_WHY_CHARS) } : {}) };
    if (Object.keys(out).length >= PENDING_MAX) break;
  }
  return out;
}
/**
 * The HELD providers: a provider whose last canary was an account state (pay, auth) or two distinct models gone is not asked at all for a while (`--hold-hours`, default 6) and not even
 * canaried again until the window ends (`--retry-accounts` forces it). Stored as an additive top-level `held` object: `{provider: {r: "pay" | "auth" | "gone", at: ISO}}`, at most `HELD_MAX`.
 */
export const HELD_MAX = 500;
export const HELD_STATES = Object.freeze(["pay", "auth", "gone"]);
const providerOk = (p) => typeof p === "string" && /^[A-Za-z0-9._@+-]{1,60}$/.test(p);
export function cleanHeld(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [p, v] of Object.entries(raw)) {
    if (!providerOk(p) || !v || typeof v !== "object" || !HELD_STATES.includes(v.r) || typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) continue;
    out[p] = { r: v.r, at: v.at };
    if (Object.keys(out).length >= HELD_MAX) break;
  }
  return out;
}
/**
 * The holds still in force at `nowMs`: `{provider: {r, at, until}}`. Hard reasons are STICKY: with no `holdHours` (the default) a hold never ends by time (`until: null`) and only a manual lift
 * (`--recheck-hard`, `--retry-accounts`, `--release-holds`) or a provider that answers removes it. `holdHours` (`--hold-hours`) is an opt-in expiry.
 */
export function activeHolds(held, nowMs, holdHours = null) {
  const out = {}, expires = Number.isFinite(holdHours) && holdHours > 0;
  for (const [p, v] of Object.entries(held ?? {})) {
    if (!expires) { out[p] = { ...v, until: null }; continue; }
    const until = Date.parse(v.at) + holdHours * 3600000;
    if (until > nowMs) out[p] = { ...v, until };
  }
  return out;
}
/**
 * The HARD state (pay, auth, gone) of a stored pending reason, or null when the reason is recoverable. A model pending `pay`, `auth` or `gone` (or `canary-*` of those: skipped behind a provider's
 * canary) is not asked again by a normal run. Exception: `canary-pay` / `canary-gone` of a provider that has CONFIRMED results is not hard (the provider answered, so it was never a verdict about those models:
 * the same reason a pay or gone hold on such a provider is wrong, see `holdIsWrong`).
 */
export function hardState(reason, provider, confirmed = {}) {
  const m = /^(canary-)?(pay|auth|gone)$/.exec(reason ?? "");
  if (!m) return null;
  if (m[1] && m[2] !== "auth" && (confirmed?.[provider] ?? 0) > 0) return null;
  return m[2];
}
/** `--recheck-hard pay,auth,gone,<providers>`: does the manual lift `recheck` (`{reasons, providers}`, or null) cover this hard `state` of `provider`? An empty provider list means every provider. */
export const recheckCovers = (recheck, state, provider) => !!recheck && recheck.reasons.includes(state) && (!recheck.providers.length || recheck.providers.includes(provider));
/**
 * The META block (additive): what the last live run left behind for the next one. `recoverable` is the verdict's recoverable count at the END of that run, so the next run can tell whether the recoverable
 * set shrank (a loop must not spin forever on soft-but-stuck models); `scope` is a stable hash of the flags that decide WHICH models the count is about (candidates, sample, --only, --include-tier, levels): only an
 * equal scope is compared; `at` is when. `history` (additive, optional, at most 5 per scope and 12 in all) is one small record per recorded run: `{at, scope, asked, newTested, deepened, rateShare, testedTotal, recoverable}`.
 */
export function cleanMeta(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.recoverable) || raw.recoverable < 0 || raw.recoverable > 10000000 || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
  if (typeof raw.scope !== "string" || !/^[0-9a-f]{6,40}$/.test(raw.scope)) return null;                 // a count without its scope compares with nothing: it reads as no previous count
  const history = Array.isArray(raw.history) ? raw.history.map(cleanRun).filter(Boolean).slice(-HISTORY_TOTAL) : [];
  return { recoverable: raw.recoverable, scope: raw.scope, at: raw.at, ...(history.length ? { history } : {}) };
}
/** The last runs of one scope, for the diminishing-returns rule: one small record per run (see `saturation`). Anything malformed is dropped, not repaired. */
export const HISTORY_PER_SCOPE = 5, HISTORY_TOTAL = 12;
/** The history after a recorded run: written unfiltered, so that runs of different scopes (a plain loop and a --candidates loop, say) each build their own series; at most 5 entries per scope and 12 in all. */
export function appendHistory(history, entry) {
  const all = [...(history ?? []), entry], seen = {}, keep = [];
  for (let i = all.length - 1; i >= 0; i -= 1) { const sc = all[i].scope; seen[sc] = (seen[sc] ?? 0) + 1; if (seen[sc] <= HISTORY_PER_SCOPE) keep.unshift(all[i]); }
  return keep.slice(-HISTORY_TOTAL);
}
/** The entries of ONE scope: the only ones the rule compares. */
export const historyOf = (history, scope) => (history ?? []).filter((h) => h.scope === scope);
function cleanRun(h) {
  if (!h || typeof h !== "object" || Array.isArray(h)) return null;
  if (typeof h.at !== "string" || !Number.isFinite(Date.parse(h.at)) || typeof h.scope !== "string" || !/^[0-9a-f]{6,40}$/.test(h.scope)) return null;
  const ints = ["asked", "newTested", "deepened", "testedTotal", "recoverable"];
  if (ints.some((k) => !Number.isInteger(h[k]) || h[k] < 0 || h[k] > 10000000)) return null;
  if (typeof h.rateShare !== "number" || !(h.rateShare >= 0 && h.rateShare <= 1)) return null;
  return { at: h.at, scope: h.scope, asked: h.asked, newTested: h.newTested, deepened: h.deepened, rateShare: Math.round(h.rateShare * 1000) / 1000, testedTotal: h.testedTotal, recoverable: h.recoverable };
}
const metaText = (meta) => (meta ? `"meta":${JSON.stringify(meta)},` : "");
const heldText = (held) => (held && Object.keys(held).length ? `"held":${JSON.stringify(held)},` : "");
const pendingText = (pending) => (pending && Object.keys(pending).length ? `"pending":${JSON.stringify(pending)},` : "");
const head = (now, pending, held = null, meta = null) => `{"schema":${SCHEMA},"kind":${JSON.stringify(KIND)},"generatedAt":${JSON.stringify(now.toISOString())},${pendingText(pending)}${heldText(held)}${metaText(meta)}"models":{`;
const lineOf = (k, v) => `${JSON.stringify(k)}:${JSON.stringify(v)}`;
/** The file text: one record per line. The size cap is measured on exactly this string. */
export function renderFile(entries, now = new Date(), pending = null, held = null, meta = null) {
  const lines = entries.map(([k, v]) => lineOf(k, v));
  return `${head(now, pending, held, meta)}${lines.length ? `\n${lines.join(",\n")}\n` : ""}}}\n`;
}
const bytesOf = (sizes, now, pending, held = null, meta = null) => Buffer.byteLength(head(now, pending, held, meta)) + (sizes.length ? 2 + sizes.reduce((a, b) => a + b, 0) + 2 * (sizes.length - 1) : 0) + 3;

/**
 * Capacity, not expiry: when the FILE AS WRITTEN would pass `maxBytes`, records of models that have left the catalogue go first, then the oldest;
 * records this reader did not understand (`preserve`) go last of all. Returns the kept `models` and `preserve` and the `dropped` keys.
 */
export function capRecords(models, { keep = null, maxBytes = MAX_FILE_BYTES, preserve = {}, now = new Date(), pending = null, held = null, meta = null } = {}) {
  const all = [...Object.entries(models).map(([k, v]) => ({ k, v, own: true })), ...Object.entries(preserve).filter(([k]) => !(k in models)).map(([k, v]) => ({ k, v, own: false }))];
  const size = new Map(all.map((e) => [e.k, Buffer.byteLength(lineOf(e.k, e.v))]));
  let total = bytesOf([...size.values()], now, pending, held, meta);
  // The provider's words (`why` of a pending entry) are the first thing to go: a sentence is worth less than a model's record. Oldest entries first, before any record is dropped.
  let pend = pending, whyStripped = 0;
  if (pending && total > maxBytes) {
    pend = { ...pending };
    // the sentence of a STUCK model is the one the owner needs to judge it: it goes last
    const stuck = (v) => (STUCK_REASONS.has(v.r) && (v.rn ?? v.n) >= STUCK_RUNS ? 1 : 0);
    const withWhy = Object.keys(pend).filter((k) => pend[k].why !== undefined).sort((a, b) => stuck(pend[a]) - stuck(pend[b]) || Date.parse(pend[a].at) - Date.parse(pend[b].at) || (a < b ? -1 : 1));
    for (const k of withWhy) {
      if (total <= maxBytes) break;
      const { why, ...rest } = pend[k];
      total -= Buffer.byteLength(JSON.stringify(pend[k])) - Buffer.byteLength(JSON.stringify(rest));
      pend[k] = rest; whyStripped += 1;
    }
  }
  const at = (e) => (e.own ? Date.parse(e.v.at) : Infinity);
  const order = [...all].sort((a, b) => {
    const ga = (a.own ? 0 : 2) + (keep && !keep.has(a.k) ? 0 : 1), gb = (b.own ? 0 : 2) + (keep && !keep.has(b.k) ? 0 : 1);
    return ga - gb || at(a) - at(b) || (a.k < b.k ? -1 : 1);
  });
  const dropped = new Set();
  for (const e of order) {
    if (total <= maxBytes) break;
    const n = size.get(e.k);
    total -= n + 2; size.delete(e.k); dropped.add(e.k);
  }
  return { models: Object.fromEntries(all.filter((e) => e.own && !dropped.has(e.k)).map((e) => [e.k, e.v])),
           preserve: Object.fromEntries(all.filter((e) => !e.own && !dropped.has(e.k)).map((e) => [e.k, e.v])), dropped: [...dropped], pending: pend, whyStripped };
}

const wait = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* no wait available */ } };
/** The canonical form of a path for comparing two of them: the real directory (it may not exist yet: the path as given) plus the file name. */
function canon(file) {
  const abs = path.resolve(file);
  let dir = path.dirname(abs);
  try { dir = fs.realpathSync(dir); } catch { /* not there yet */ }
  const p = path.join(dir, path.basename(abs));
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Writes the file atomically (temp file, then rename), retrying a rename that a scanner or an open reader holds for a moment.
 * Three refusals come first, because this is the one writer of a file that other tools read:
 *   - the file must be named tool-fidelity.json (never bench.json, a snapshot, a settings file);
 *   - the REAL state file (`realFile`, by default the one under the user's home) is written only when `live` is true, and a test names a
 *     temp file as `realFile` so that "the real file" is, by construction, never the one under the user's home;
 *   - an existing file that is not this file (no `kind` marker, another schema, unreadable, too large) is never overwritten.
 * `preserve` holds raw records this reader did not understand: they are written back unchanged unless a valid record replaces them.
 */
export function saveFidelity(file, models, { live = false, now = new Date(), keep = null, retries = 5, retryMs = 40, writeImpl = writeAtomic, realFile = REAL_FILE, preserve = {}, pending = {}, held, meta, maxBytes = MAX_FILE_BYTES } = {}) {
  const target = path.resolve(file);
  if (path.basename(target) !== FILE_NAME) throw new Error(`refused: the tool-fidelity writer only writes a file named ${FILE_NAME}, not ${path.basename(target)}`);
  if (canon(target) === canon(realFile) && !live) throw new Error("refused: the real state file is written only by a --live run");
  const cur = loadFidelity(target);
  if (!cur.ok) throw new Error(`refused: ${target} exists and is not a tool-fidelity file (${cur.reason}); it is not overwritten`);
  const good = Object.fromEntries(Object.entries(models).filter(([k]) => keyOk(k)));
  const keepRaw = Object.fromEntries(Object.entries(preserve).filter(([k]) => keyOk(k) && !(k in good)));
  const pend = cleanPending(pending);
  const hold = held === undefined ? cur.held : cleanHeld(held);                  // a writer that does not mention the holds keeps the ones in the file
  const metaV = meta === undefined ? cur.meta : cleanMeta(meta);                  // a writer that does not mention the meta keeps the one in the file
  const capped = capRecords(good, { keep, preserve: keepRaw, now, pending: pend, held: hold, meta: metaV, maxBytes });
  const entries = [...Object.entries(capped.models), ...Object.entries(capped.preserve)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = renderFile(entries, now, capped.pending ?? pend, hold, metaV);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (let i = 0; ; i++) {
    try { writeImpl(target, text); break; }
    catch (e) { if (i >= retries || !/^(EPERM|EBUSY|EACCES)$/.test(e?.code ?? "")) throw e; wait(retryMs * (i + 1)); }
  }
  return { records: entries.length, preserved: Object.keys(capped.preserve).length, dropped: capped.dropped, whyStripped: capped.whyStripped, bytes: Buffer.byteLength(text) };
}

// ------------------------------------------------------------------ building and merging a record

/**
 * The record after a probe, or null when no level actually ran (nothing to record). `done` maps a level (1-4, 5 for the big step, 6 for spawn, 7 for the error-result case) to
 * `{v: "p"|"f"|"n", why?, kind?: "size"|"schema", bytes?, ...markers}`; `n` means asked but not run. Levels that ran replace their character of lvr; the rest keep the prior
 * result. The one-letter markers (af, fc, br, er, nm, cc, sp, d3) come from the levels that carry them. TWO STRIKES: a failure at L1, L2 or L3 (L3 only when it is not about size)
 * is provisional the first time (see the header), and a provisional probe keeps EVERYTHING it learned out of the record; a failed spawn is struck the same way (sl 6) but never
 * lowers the class; a size refusal at L3 or at the big step lowers `capBelow` instead of failing the model.
 */
export function buildRecord(prior, done, { now = new Date(), fixtureId = FIXTURE_ID, alias = false } = {}) {
  const verdict = (l) => done[l]?.v === "p" || done[l]?.v === "f";
  const l3Passed = done[3]?.v ? done[3].v === "p" : prior?.lvr?.[2] === "p";
  const pairOk = (done[1]?.v ?? prior?.lvr?.[0]) === "p" && (done[2]?.v ?? prior?.lvr?.[1]) === "p";
  // the big step means something only behind an L3 pass (or an L3 implied by it); spawn and the error result only behind a passed L1+L2
  const ran = (l) => verdict(l) && (l !== BIG_LEVEL || l3Passed) && ((l !== 6 && l !== 7) || pairOk);
  if (![1, 2, 3, 4, BIG_LEVEL, 6, 7].some(ran)) return null;
  const base = prior?.lvr ?? "nnnn";
  const next = base.split("");
  for (let l = 1; l <= 4; l++) if (done[l]?.v) next[l - 1] = done[l].v;
  const strikeable = (l) => done[l]?.v === "f" && !(l === 3 && done[l].kind === "size");
  const F = [1, 2, 3].find(strikeable) ?? 0;
  let lvr = next.join(""), strikes, sl, provisional = false;
  if (F) {
    const confirmed = !!prior && (prior.strikes === 2 || (prior.strikes === 1 && prior.sl === F));
    if (confirmed) { strikes = 2; sl = F; }
    else {
      // first strike: the earlier result stands. Only levels above the failed one (and above the L1+L2 pair) keep what they learned.
      const keepBase = base.split("");
      for (let l = Math.max(F, 2) + 1; l <= 4; l++) if (done[l]?.v) keepBase[l - 1] = done[l].v;
      lvr = keepBase.join(""); strikes = 1; sl = F; provisional = true;
    }
  } else if (prior?.strikes === 1 && !ran(prior.sl)) { strikes = 1; sl = prior.sl; }       // this probe did not look at the struck level: the strike waits

  // the markers: a provisional probe changes none of them
  const keep = { ...Object.fromEntries(PF_FIELDS.map((k) => [k, prior?.[k]])), d3: prior?.d3, afw: prior?.afw, l4w: prior?.l4w, l3w: prior?.l3w, spw: prior?.spw };
  const m = { ...keep };
  if (ran(3)) m.l3w = done[3].v === "f" && noteOk(done[3].w) ? done[3].w : undefined;       // the evidence of a first strike is kept too
  if (!provisional) {
    if (ran(1)) { m.af = done[1].af; m.fc = done[1].fc; m.afw = m.af === "f" && noteOk(done[1].afw) ? done[1].afw : undefined; }
    if (ran(4)) m.l4w = done[4].v === "f" && noteOk(done[4].w) ? done[4].w : undefined;
    if (ran(2)) m.br = done[2].br;
    if (ran(7)) m.er = done[7].v;
    for (const l of [3, BIG_LEVEL]) { if (ran(l) && done[l].nm) m.nm = done[l].nm; if (ran(l) && done[l].cc) m.cc = done[l].cc; }
    if (ran(3)) m.d3 = done[3].v === "f" ? (String(done[3].why ?? "").startsWith("[3a]") ? "a" : "b") : done[3].implied ? "i" : undefined;
    if (ran(6)) {
      m.spw = done[6].v === "f" && noteOk(done[6].w) ? done[6].w : undefined;
      if (done[6].v === "p") m.sp = "p";
      else if (prior?.strikes === 1 && prior.sl === 6) { m.sp = "f"; strikes = 2; sl = 6; }
      else if (!strikes) { strikes = 1; sl = 6; }                               // the strike slot is free: the first spawn failure is only provisional
    }
  }

  let capBelow = prior?.capBelow;
  for (const l of [3, BIG_LEVEL]) if (ran(l) && done[l].v === "f" && done[l].kind === "size") capBelow = Math.min(capBelow ?? Infinity, capBelowFor(done[l].bytes ?? 0));
  const passedBytes = Math.max(0, ...[3, 4, BIG_LEVEL].filter((l) => ran(l) && done[l].v === "p").map((l) => done[l].bytes ?? 0));
  if (capBelow && passedBytes > capBelow) capBelow = undefined;           // a pass beyond the recorded refusal contradicts it
  let big = prior?.big;
  if (ran(BIG_LEVEL)) big = done[BIG_LEVEL].v;
  if (lvr[2] !== "p") { big = undefined; if (m.d3 === "i") m.d3 = undefined; }     // the big step is only meaningful after an L3 pass

  const t = classOf({ lvr, strikes, sl, capBelow, fc: m.fc });
  // the reason shown: the failed level of this probe's strike, else the first failed level of the record (this probe's words, or the stored ones)
  let why = "";
  if (F) why = `L${F}: ${done[F].why ?? ""}`;
  else if (lvr.includes("f")) { const f = lvr.indexOf("f") + 1; why = done[f]?.why ? `L${f}: ${done[f].why}` : prior?.lvr?.[f - 1] === "f" ? prior.why ?? "" : ""; }
  else if (big === "f" && done[BIG_LEVEL]?.why) why = `L5: ${done[BIG_LEVEL].why}`;
  const hadBig = prior && (prior.lvr[2] !== "n" || prior.lvr[3] !== "n");
  // a failure caused by the gateway's own request translation stays x (a subagent would fail through this gateway) but is tagged: it is fixable there, it is not a limit of the model
  const xw = lvr.includes("f") && ((F && done[F]?.gw) || GATEWAY_WHY.test(why)) ? "gateway" : undefined;
  return {
    lv: lvOf(lvr), lvr, t, ok: t === "v" || t === "t",
    ...(why ? { why: redactClip(why, WHY_CHARS) } : {}),
    at: now.toISOString(), fx: ran(3) || ran(4) || !hadBig ? fixtureId : prior.fx,
    maxBytes: Math.max(prior?.maxBytes ?? 0, passedBytes),
    ...(alias ? { alias: true } : {}),
    ...(big === "p" || big === "f" ? { big } : {}), ...(capBelow ? { capBelow } : {}), ...(strikes ? { strikes, sl } : {}),
    ...Object.fromEntries(PF_FIELDS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])), ...(m.d3 ? { d3: m.d3 } : {}),
    ...Object.fromEntries(NOTE_FIELDS.filter((k) => m[k] !== undefined).map((k) => [k, m[k]])),
    ...(xw ? { xw } : {}),
  };
}

/**
 * A fresh result replaces the stored one; a result whose time is older than the stored one (a slow run finishing late) does not.
 * Only this file's records are involved: nothing here reads or returns bench data.
 */
export function mergeRecord(prev, next) {
  if (!prev) return next;
  return Date.parse(next.at) >= Date.parse(prev.at) ? next : prev;
}

/**
 * After a provider's key tier changed (`retier`): the L3 failures of that provider, put back to "not run" so the next lazy L3 pass asks again
 * (a free key and a paid key can behave differently). Pure: returns the changed records only; wiring this to `retier` comes later.
 * A record whose L3 never ran, or passed, is untouched; a size cap and a pending L3 strike are cleared with the failure they came from.
 */
export function requeueL3Failures(store, provider) {
  const changed = {};
  for (const [k, r] of Object.entries(store)) {
    if (!k.startsWith(`${provider}/`)) continue;
    if (!(r.lvr[2] === "f" || (r.strikes && r.sl === 3))) continue;
    const lvr = `${r.lvr.slice(0, 2)}n${r.lvr[3]}`;
    const keepStrike = r.strikes && r.sl !== 3;
    const f = lvr.indexOf("f");
    const next = { lv: lvOf(lvr), lvr, at: r.at, fx: r.fx, maxBytes: r.maxBytes, ...(r.alias ? { alias: true } : {}), ...(keepStrike ? { strikes: r.strikes, sl: r.sl } : {}),
                   ...Object.fromEntries(PF_FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])), ...Object.fromEntries(NOTE_FIELDS.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])),
                   ...(f >= 0 && r.why?.startsWith(`L${f + 1}:`) ? { why: r.why } : {}) };
    next.t = classOf({ lvr, strikes: next.strikes, sl: next.sl, fc: next.fc });
    next.ok = next.t === "v" || next.t === "t";
    changed[k] = cleanFidelity(next);
  }
  return changed;
}

// ------------------------------------------------------------------ the probe set, the queue, the counts

const usable = (rec) => !!rec && rec.s === "ok" && Number.isFinite(rec.a);

/**
 * Every probe-ok model of the snapshot, one entry per `provider/id`: the models the BENCH found answering a bare chat request
 * (`bench.get(key)` is `{s, a}`), minus the Anthropic relay's, which are known good by provenance and are never probed.
 * The catalogue's `tools` claim is NOT a filter (the claim is exactly what is being tested): a model whose every route says
 * `tools: false` is in the set, and counted. An id this file could not hold (`keyOk`) is left out and counted (`badId`): it would be re-probed
 * every run and never recorded. `ctxUnknown` is how many have no listed context length. Order within a provider: free first, then cheapest.
 */
export function probeSet(snap, bench) {
  const seen = new Map(), relay = new Set(), bad = new Set();
  let universe = 0;
  for (const row of snap?.rows ?? []) {
    for (const m of row.models ?? []) {
      if (m.outputKind === "nontext" || m.routable === false) continue;
      const key = benchKey(row.provider, m.id);
      if (row.keyId === RELAY_KEY_ID) { relay.add(key); continue; }
      if (!keyOk(key)) { bad.add(key); continue; }
      let e = seen.get(key);
      if (!e) {
        universe += 1;
        const id = key.slice(row.provider.length + 1);
        e = { key, provider: row.provider, id, free: isFree(m), pin: Number.isFinite(m.pin) ? m.pin : null, pout: Number.isFinite(m.pout) ? m.pout : null,
              toolsFalse: true, alias: POOL_ALIAS_RE.test(id), ctx: 0 };
        seen.set(key, e);
      }
      if (m.tools !== false) e.toolsFalse = false;
      if (Number.isFinite(m.ctx) && m.ctx > e.ctx) e.ctx = m.ctx;
    }
  }
  const models = [], notOk = [];
  for (const e of seen.values()) (usable(bench?.get ? bench.get(e.key) : null) ? models : notOk).push(e);
  const relayOk = [...relay].filter((k) => usable(bench?.get ? bench.get(k) : null) && !seen.has(k));
  const rank = (e) => (e.free ? 0 : 1);
  models.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0) || rank(a) - rank(b) || (a.pin ?? Infinity) - (b.pin ?? Infinity) || (a.key < b.key ? -1 : 1));
  return { models, relay: relayOk, listed: universe, notProbeOk: notOk.length, badId: bad.size, notOkKeys: notOk.map((e) => e.key), badKeys: [...bad] };
}

/** The counts the dry run and the sweep report print; every number names its denominator. A provisional record (one failure so far) is not a result yet. */
export function fidelityCounts(set, store, fixtureId = FIXTURE_ID) {
  const n = set.models.length;
  const has = (m) => !!store[m.key] && store[m.key].lvr[0] !== "n";
  const withRecord = set.models.filter(has).length;
  const current = set.models.filter((m) => has(m) && store[m.key].fx === fixtureId).length;
  const notFree = set.notFree?.length ?? 0;
  return { probeOk: n + notFree + set.relay.length, relay: set.relay.length, notFree, byTier: set.byTier ?? null, probeSet: n, withRecord, withRecordCurrent: current,
           outdated: withRecord - current, pending: set.models.filter((m) => isProvisional(store[m.key])).length,
           toolsFalse: set.models.filter((m) => m.toolsFalse).length, toolsFalseWithRecord: set.models.filter((m) => m.toolsFalse && has(m)).length,
           ctxUnknown: set.models.filter((m) => !(m.ctx > 0)).length, badId: set.badId ?? 0, queued: n - withRecord };
}

/** The levels a confirmed failure would be asked again at, never one that passed: the L1/L2 pair members that are not `p`, and L3 after a confirmed L3 failure. */
export const failedLevels = (rec) => [...[1, 2].filter((l) => rec.lvr[l - 1] !== "p"), ...(rec.lvr[2] === "f" ? [3] : [])];

/**
 * Which levels each model still needs. Without `force` a model is asked only for what it has NO result for, so a model with a record is never re-probed at a level it already
 * answered (a model with L1+L2 done and L3 pending is sent L3 only), and a record against an outdated fixture is NOT queued again (its `*` is a recommendation, not an expiry). L1
 * and L2 are one pass: a record that ran anything answered both, except a model with ONE strike, which is asked the struck level again. L3 is the 3a constructs request and the 157 KB
 * request, which also answers L4: both are asked only of a model that passed L1 and L2 (or, for a model never tested, together with them), while their character is `n`; L4 alone only
 * after an L3 pass. The big step only of a model that passed L3 (or in the same run as the L3 being asked) and has no big result. L6 (spawn) and L7 (the error result) only of a model
 * that passed L1 and L2 and has no result for them, spawn also when it carries one strike. `force` asks every requested level again (still never past a failure the ladder would stop
 * at). `retryFailed` asks again ONLY the models of class x, and only the levels that failed: a record that passed is never touched. Deep levels of a provider that is not free are
 * clamped later, by `clampDeep` and by the engine itself.
 */
export function queueFor(set, store, levels = DEFAULT_LEVELS, { force = false, retryFailed = false } = {}) {
  const out = [];
  for (const m of set.models) {
    const prior = store[m.key] ?? null;
    if (retryFailed) {
      const todo = prior && prior.t === "x" ? failedLevels(prior) : [];
      if (todo.length) out.push({ ...m, todo, prior });
      continue;
    }
    const confirmed = !!prior && prior.lvr[0] !== "n";
    const pending = prior?.strikes === 1 ? prior.sl : 0;
    const pair = levels.includes(1) && levels.includes(2);
    const passedPair = confirmed && prior.lvr.startsWith("pp");
    const okToAsk = passedPair || (!confirmed && pair);
    const askL3 = levels.includes(3) && (pending === 3 || (okToAsk && (force || !prior || prior.lvr[2] === "n")));
    const todo = levels.filter((l) => {
      if (l <= 2) return force || !confirmed || (pending >= 1 && pending <= 2);
      if (l === 3) return askL3;
      if (l === 4) return okToAsk && (force || !prior || prior.lvr[3] === "n") && (askL3 || prior?.lvr[2] === "p");
      // the big step: after an L3 pass, or in the same run as the L3 that is being asked (the ladder stops it if L3 does not pass)
      if (l === 5) return askL3 || (confirmed && prior.lvr[2] === "p" && (force || prior.big === undefined));
      if (l === 6) return pending === 6 || (okToAsk && (force || !prior || prior.sp === undefined));
      if (l === 7) return okToAsk && (force || !prior || prior.er === undefined);
      return false;
    });
    if (todo.length) out.push({ ...m, todo, prior });
  }
  return out;
}

/** `--only provider` and `--only provider/id`, the same selection rule as the bench. */
export function selectOnly(entries, only) {
  if (!only) return entries;
  const prov = new Set(only.filter((o) => !o.includes("/"))), keys = namedKeys(only);
  return entries.filter((e) => prov.has(e.provider) || keys.has(e.key));
}
/** The EXACT model keys `--only` names (`provider/model`); a provider name alone is not in it. Naming a model is a manual act: it lifts that model's own hard block (pay, auth, gone). */
export function namedKeys(only) { return new Set((only ?? []).filter((o) => o.includes("/")).map((o) => benchKey(...splitKey(o)))); }
const splitKey = (s) => { const i = s.indexOf("/"); return [s.slice(0, i), s.slice(i + 1)]; };

/** `--limit N`: N models in total, taken round-robin across providers so a small sample touches every provider. */
export function limitEntries(entries, n) {
  if (!n) return entries;
  const by = new Map();
  for (const e of entries) { if (!by.has(e.provider)) by.set(e.provider, []); by.get(e.provider).push(e); }
  const lists = [...by.values()], out = [];
  for (let i = 0; out.length < n && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && out.length < n) out.push(l[i]);
  return out;
}

// ------------------------------------------------------------------ estimates and the per-provider cap

/**
 * The price an unpriced paid row is charged: the highest listed price among the paid rows of the WHOLE probe set (so a narrowed run, `--only`,
 * charges the same as a full one), and the bench's documented unpriced price when no paid row lists one.
 */
export function paidFallback(models) {
  const paid = models.filter((e) => !e.free);
  const inn = Math.max(0, ...paid.map((e) => e.pin ?? 0)), out = Math.max(0, ...paid.map((e) => e.pout ?? 0));
  return inn || out ? { in: inn, out } : UNPRICED_PER_M;
}

/** The request kinds that answer one LEVEL of a todo list (L4 rides in the L3 request: no cost of its own unless it is asked alone). */
const kindsOfLevel = (l, todo) => (l === 4 ? (todo.includes(3) ? [] : ["3b"]) : kindsOf([l]));
const BIG_LEVELS = Object.freeze({ 1: "L1 simple call + argument fidelity", 2: "L2 round trip (20 KB result)", 3: "L3 constructs + 157 KB (+L4 parallel)", 5: "big 400 KB", 6: "spawn (Agent)", 7: "error result" });
/** The per-level request, byte and token table the dry run prints (a full-depth model sends every row once). */
export function levelCosts(maxTokens = null) {
  return [1, 2, 3, 5, 6, 7].map((l) => {
    const kinds = kindsOfLevel(l, [l]);
    return { level: l, label: BIG_LEVELS[l], kinds, requests: kinds.length, bytes: kinds.reduce((a, k) => a + kindSize(k).bytes, 0), inTokens: kinds.reduce((a, k) => a + kindSize(k).inTokens, 0), outTokens: kinds.reduce((a, k) => a + (maxTokens ?? BUDGETS[k]), 0) };
  });
}

/**
 * Cost of what each entry still has to run, in requests, input tokens and dollars, BEFORE anything is sent. Input tokens come from the real request bytes of each REQUEST (bytes / 4);
 * output tokens are each request's own small budget (`maxTokens` overrides them all). `lc` is the dollar cost of each level, so a probe that stops part way can be charged for the
 * levels it did complete. `fallback` is `paidFallback(whole set)`. `sizes` is the per-level table (L3 is two requests, L4 none of its own).
 */
export function estimate(entries, { maxTokens = null, fallback = null } = {}) {
  const sizes = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((l) => { const k = kindsOfLevel(l, [l === 4 ? 3 : l]); return [l, { bytes: k.reduce((a, x) => a + kindSize(x).bytes, 0), inTokens: k.reduce((a, x) => a + kindSize(x).inTokens, 0), requests: k.length }]; }));
  const fb = fallback ?? paidFallback(entries);
  const per = new Map();
  let requests = 0, inTokens = 0, outTokens = 0, usd = 0, paidModels = 0;
  const rated = entries.map((e) => {
    const kinds = kindsOf(e.todo), reqs = kinds.length;
    const tin = kinds.reduce((a, k) => a + kindSize(k).inTokens, 0), tout = kinds.reduce((a, k) => a + (maxTokens ?? BUDGETS[k]), 0);
    const price = e.free ? { in: 0, out: 0 } : { in: e.pin ?? fb.in, out: e.pout ?? fb.out };
    const lc = Object.fromEntries(e.todo.map((l) => { const ks = kindsOfLevel(l, e.todo); return [l, (ks.reduce((a, k) => a + kindSize(k).inTokens, 0) * price.in + ks.reduce((a, k) => a + (maxTokens ?? BUDGETS[k]), 0) * price.out) / 1e6]; }));
    const cost = Object.values(lc).reduce((a, b) => a + b, 0);
    requests += reqs; inTokens += tin; outTokens += tout; usd += cost; if (!e.free) paidModels += 1;
    const p = per.get(e.provider) ?? { provider: e.provider, models: 0, requests: 0, inTokens: 0, usd: 0, free: 0 };
    p.models += 1; p.requests += reqs; p.inTokens += tin; p.usd += cost; if (e.free) p.free += 1;
    per.set(e.provider, p);
    return { ...e, reqs, tin, tout, cost, lc, kinds, price };
  });
  return { entries: rated, requests, inTokens, outTokens, usd, paidModels, perProvider: [...per.values()].sort((a, b) => b.models - a.models || (a.provider < b.provider ? -1 : 1)), sizes };
}

/**
 * An honest RANGE for the wall time of a queue: each request is taken to cost the provider's typical first-token time (`latencyMs`, from the bench) plus prefill at `prefillTokPerSec`
 * (the long requests dominate), a provider serves `perProvider` requests at once (one when the request is 100 KB or more), `concurrency` run at once overall. The low figure is
 * the typical case, the high one three times that with every provider rate-limited part of the time. It is an estimate, printed as one.
 */
export function wallEstimate(rated, { concurrency = 8, perProvider = 2, latencyMs = 3000, prefillTokPerSec = 8000 } = {}) {
  const prov = new Map();
  let total = 0;
  for (const e of rated) {
    for (const k of e.kinds ?? kindsOf(e.todo)) {
      const sz = kindSize(k), big = sz.bytes >= 100000, lat = latencyMs + (sz.inTokens / prefillTokPerSec) * 1000;
      const p = prov.get(e.provider) ?? { t: 0 };
      p.t += lat / (big ? 1 : Math.max(1, perProvider)); prov.set(e.provider, p); total += lat;
    }
  }
  const low = Math.max(0, ...[...prov.values()].map((p) => p.t), total / Math.max(1, concurrency)) / 1000;
  return { lowSec: low, highSec: low * 3, providers: prov.size };
}

/**
 * The expected cost per model of the two orders of the deep levels, from MEASURED pass rates: `r3` the share of L1+L2 passers that pass L3, `rb` the share of L3 passers that pass the
 * big step. l3-first sends 3a and 3b to everyone and the big step to the L3 passers; big-first sends the big step first (a pass implies L3, so those skip 3a and 3b) and 3a, 3b
 * to the rest. A big pass is taken to be r3 * rb of the passers. Tokens, input only.
 */
export function orderCosts({ r3, rb }) {
  const c3 = kindSize("3a").inTokens + kindSize("3b").inTokens, cb = kindSize("5").inTokens;
  if (!(r3 >= 0 && r3 <= 1 && rb >= 0 && rb <= 1)) return null;
  const pBig = r3 * rb;
  return { l3First: c3 + r3 * cb, bigFirst: cb + (1 - pBig) * c3, pBig, c3, cb };
}

/**
 * The per-provider input-token cap of one invocation: entries are taken in their order (free first) until the next one would pass the cap; the
 * rest of that provider waits for the next invocation (`waiting`). An entry that ALONE costs more than the cap can never run under it (`tooBig`,
 * with `needed`, the smallest cap that would let every queued model run): it does not block the models behind it. Nothing about them is stored.
 */
export function applyProviderCap(rated, cap = DEFAULT_TOKENS_PER_PROVIDER) {
  const used = new Map(), kept = [], waiting = [], tooBig = [];
  for (const e of rated) {
    if (e.tin > cap) { tooBig.push(e); continue; }
    const u = used.get(e.provider) ?? 0;
    if (u + e.tin > cap) { waiting.push(e); used.set(e.provider, cap + 1); continue; }   // once one waits, the later ones of that provider wait too
    used.set(e.provider, u + e.tin); kept.push(e);
  }
  return { kept, waiting, tooBig, needed: Math.max(0, ...rated.map((e) => e.tin)) };
}

// ------------------------------------------------------------------ candidates: every probe-ok model on a free-tier provider, in priority order

/** Reads a compiled policy file (`state/subagent/policy.json`, or a fixture of the same shape): `{models: [{s, c, ...}], tiers?: {provider: tier}}`, best first. Null when it is not one. */
export function loadPolicy(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return raw && Array.isArray(raw.models) && raw.models.every((m) => m && typeof m.s === "string") ? raw : null;
  } catch { return null; }
}
export const POLICY_FILE = path.join(os.homedir(), ".uw", "state", "subagent", "policy.json");

// From most to least restrictive: when a provider's rows cannot be told apart, the deepest probes go only where every candidate key allows them.
const TIER_STRICTNESS = Object.freeze(["management", "subscription", "paid", "free-deposit", "free"]);

/**
 * One tier per provider from the vault registry's rows (`[{provider, tier, id?}]`), by the rule the policy compiler applies to the same registry (`filterRegistry`, `chooseKeys` in
 * keysync): a management key is not a key anything is synced with, so its row is ignored when the provider has another; a provider with one key has that key's tier; a provider with
 * several keys has the tier of the key the OWNER CHOSE (`choices`, the key-choices file: `{provider: key id}`). Only when there is no choice (the compiler's "no deliberate choice"
 * case): keys of one tier give that tier, keys of DIFFERENT tiers give the MOST RESTRICTIVE tier (management, subscription, paid, free-deposit, free), which only ever keeps a probe
 * away. The result never depends on the order of the rows. A row with a tier outside the vocabulary leaves its provider unlabelled (default-deny). Returns `{tiers, conflicts, detail}`:
 * `conflicts` the providers that fell back to the most restrictive tier, `detail` one entry per provider that has more than one key (or a management key beside another):
 * `{provider, keys, tiers, tier, how: "choice" | "same-tier" | "most-restrictive" | "management-ignored", id?}`.
 */
export function resolveTierRows(rows, { choices = {} } = {}) {
  const by = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r.provider !== "string" || typeof r.tier !== "string") continue;
    if (!by.has(r.provider)) by.set(r.provider, []);
    by.get(r.provider).push({ tier: r.tier, id: typeof r.id === "string" ? r.id : null });
  }
  const entries = [], conflicts = [], detail = [];
  for (const [provider, all] of [...by].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
    if (!all.every((r) => isTier(r.tier))) continue;                                              // unlabelled
    const live = all.filter((r) => r.tier !== "management"), kept = live.length ? live : all;
    const tiers = all.map((r) => r.tier).sort();
    const want = Object.hasOwn(choices ?? {}, provider) ? choices[provider] : null;
    let tier, how = null, id;
    if (kept.length === 1) { tier = kept[0].tier; if (all.length > 1) how = "management-ignored"; }
    else if (want !== null && kept.some((r) => r.id === want)) { tier = kept.find((r) => r.id === want).tier; how = "choice"; id = want; }
    else {
      const distinct = [...new Set(kept.map((r) => r.tier))];
      tier = TIER_STRICTNESS.find((t) => distinct.includes(t));
      how = distinct.length === 1 ? "same-tier" : "most-restrictive";
      if (how === "most-restrictive") conflicts.push(provider);
    }
    if (how) detail.push({ provider, keys: all.length, tiers, tier, how, ...(id ? { id } : {}) });
    entries.push([provider, tier]);
  }
  return { tiers: Object.fromEntries(entries), conflicts, detail };
}

/**
 * Provider key tiers from a file, with where they came from: `{tiers, conflicts, detail, compiledAt, mtime, kind}`. The file is `{provider: tier}`, `{tiers: {...}}` (a compiled policy, whose
 * `compiledAt` is reported: the compiler's own answer, key choice included) or the vault registry's array (`resolveTierRows`, with the owner's key choices from `choicesFile`, a
 * `{provider: key id}` file). Null when it is none of them.
 */
export function loadTiersInfo(file, { choicesFile = null } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    let mtime = null;
    try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* no stat */ }
    let choices = {};
    if (choicesFile) { try { const c = JSON.parse(fs.readFileSync(choicesFile, "utf8").replace(/^﻿/, "")); if (c && typeof c === "object" && !Array.isArray(c)) choices = c; } catch { return null; } }
    let m, conflicts = [], detail = [], kind = "tiers-file";
    if (Array.isArray(raw)) { ({ tiers: m, conflicts, detail } = resolveTierRows(raw, { choices })); kind = "registry"; }
    else if (raw && typeof raw.tiers === "object" && raw.tiers) { m = raw.tiers; kind = "policy"; }
    else m = raw;
    const ok = m && typeof m === "object" && !Array.isArray(m) && Object.values(m).every((t) => typeof t === "string");
    if (!ok) return null;
    const stamp = typeof raw?.compiledAt === "string" && Number.isFinite(Date.parse(raw.compiledAt)) ? raw.compiledAt : null;
    return { tiers: m, conflicts, detail, compiledAt: stamp, mtime, kind };
  } catch { return null; }
}
export const loadTiers = (file) => loadTiersInfo(file)?.tiers ?? null;

/** Where the tiers came from, how old they are, and which providers with probe-ok models they do not cover (default-deny: a provider that is not `free` or has no tier is NOT probed at all, at any level). */
export const TIERS_STALE_DAYS = 2;
export function describeTiers({ info = null, source, tiers, providers = [], nowMs }) {
  const stamp = info?.compiledAt ?? info?.mtime ?? null, t = stamp ? Date.parse(stamp) : NaN;
  const ageDays = Number.isFinite(t) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - t) / 864e5) : null;
  const absent = [...new Set(providers)].filter((p) => !isTier(tiers?.[p]));
  return { source, kind: info?.kind ?? "injected", stamp, stampIs: info?.compiledAt ? "compiled" : info?.mtime ? "file modified" : null, ageDays, stale: ageDays !== null && ageDays > TIERS_STALE_DAYS, absent, conflicts: info?.conflicts ?? [], detail: info?.detail ?? [] };
}

// What a model's KNOWN context must be before a request of a given size is worth sending. The fixture is measured in bytes / 4; real tokenisers count
// JSON schema text at up to bytes / 3, so the margin is 1.5, plus the answer budget. The big step is about 100,000 tokens by the same count; below
// `BIG_MIN_CTX` it is not asked (it would only prove the window is small, which the listing already says).
export const FIXTURE_MARGIN = 1.5;
export const BIG_MIN_CTX = 200000;
export const ctxNeededFor = (level, maxTokens = null) => { const k = level === 5 ? "5" : "3b"; return Math.ceil(kindSize(k).inTokens * FIXTURE_MARGIN) + (maxTokens ?? BUDGETS[k]); };

// Tiers that are NOT tested for now, with their ledger reason. `--include-tier` lifts one (dollar caps still apply).
export const TIER_EXCLUSION = Object.freeze({ paid: "paid-tier", "free-deposit": "deposit-tier", management: "management-tier", subscription: "relay-by-provenance" });
export const LIFTABLE_TIERS = Object.freeze(["paid", "free-deposit", "management"]);
export const DEEP_TIERS = Object.freeze(["paid", "free-deposit"]);               // the only tiers a deep lift can name: management is never probed
export const DEEP_REASON = NOT_FREE_REASON;

/**
 * The ONLY way to unlock the deep levels (everything above L2) for a tier that is not `free`: a frozen capability, handed out only when ALL of these hold, else `{ok: false, missing}`:
 * `--include-tier paid[,free-deposit]`, an explicit `--levels` that lists a deep level, `--live`, an explicit `--max-spend`, and the per-tier cost estimate already printed. It cannot be
 * had from an environment variable, a config file, or the incremental and onboarding entry points (they never call this). `probeModel` accepts nothing else.
 */
export function liftDeepProbes({ includeTiers = [], levelsExplicit = false, levels = [], live = false, maxSpendExplicit = false, printed = false } = {}) {
  const tiers = includeTiers.filter((t) => DEEP_TIERS.includes(t));
  const missing = [];
  if (!tiers.length) missing.push("--include-tier paid[,free-deposit]");
  if (!(levelsExplicit && levels.length)) missing.push("an explicit --levels that lists the levels to run");
  if (!live) missing.push("--live");
  if (!maxSpendExplicit) missing.push("an explicit --max-spend");
  if (!printed) missing.push("the printed per-tier cost estimate");
  if (missing.length) return { ok: false, missing };
  const lift = Object.freeze({ tiers: Object.freeze([...tiers]) });
  LIFTS.add(lift);
  return { ok: true, lift };
}

/**
 * Applies the free-keys-only rule to a queue: an entry whose provider tier is not `free` (and not lifted) is dropped ENTIRELY (no level, not L1 or L2 either), listed in
 * `clamped` and counted (`byTier`, an unlabelled provider counts as `unlabelled`). Nothing is an error. The engine refuses such a model on its own; this is what the plan,
 * the estimate and the ledger show.
 */
export function clampDeep(entries, { tierOf = (e) => e.tier ?? null, lift = null } = {}) {
  const out = [], byTier = {};
  let models = 0;
  for (const e of entries) {
    if (deepAllowed(tierOf(e), lift)) { out.push(e); continue; }
    models += 1; const t = tierOf(e) ?? "unlabelled"; byTier[t] = (byTier[t] ?? 0) + 1;
  }
  return { entries: out, clamped: { models, byTier } };
}

/**
 * The probe set restricted to the providers whose key tier is `free` (or a lifted tier): the owner's rule is that only free-labelled providers are probed for tools at all. The others
 * (paid, free-deposit, management and any provider with no tier) are moved to `notFree` with their tier and counted: `byTier` counts the probe-ok models of the whole set by tier
 * (`unlabelled` for no tier), `notFree` is what was left out. The relay keeps its own handling (`relay`). Pure.
 */
/**
 * What a model costs on a key of tier `free` (the owner's rule): where the LISTING has no price it is free of charge like the free-tier models ($0, `unlistedOnFree`); a model with a LISTED price keeps its
 * listed-price cost and the row ceiling applies to it (`pricedOnFree`: over the ceiling it stays pending priced-over-row-cap). Paid tiers are not touched: a lifted run keeps the pessimistic fallback for an unlisted price.
 */
const freeKeyCost = (e) => {
  if (!e.free && (e.pin > 0 || e.pout > 0)) return { ...e, pricedOnFree: true };
  return e.free ? e : { ...e, free: true, unlistedOnFree: true };
};
export function restrictToFree(set, tiers, lift = null) {
  const byTier = {}, notFree = [], models = [];
  for (const e of set.models) {
    const tier = isTier(tiers?.[e.provider]) ? tiers[e.provider] : null;
    byTier[tier ?? "unlabelled"] = (byTier[tier ?? "unlabelled"] ?? 0) + 1;
    if (deepAllowed(tier, lift)) models.push(tier === "free" ? freeKeyCost(e) : e); else notFree.push({ key: e.key, provider: e.provider, tier });
  }
  return { ...set, models, notFree, byTier };
}

/**
 * The union of every preset's allowed set, computed offline with the policy funnel over the snapshot rows: dynamic (any context, 1M only) and `free` in each
 * of its three scopes (any context, 1M only). `inherit` allows only the main model, so it adds no list. Returns `{keys: Set|null, note}`: `keys` is null with a
 * note when the funnel cannot be run (the priority queue then has no second level and says so).
 */
export function presetUnion({ snap, bench, tiers, nowMs = Date.now() }) {
  const base = { source: "all-providers", unverified: "allow-warn", allow: [] };
  const presets = [{ mode: "dynamic", freeScope: "providers", ctx: "any" }, { mode: "dynamic", freeScope: "providers", ctx: "1m" },
    ...["models", "providers", "providers+deposit"].flatMap((freeScope) => ["any", "1m"].map((ctx) => ({ mode: "free", freeScope, ctx })))];
  try {
    const keys = new Set();
    for (const p of presets) {
      const res = funnel({ rows: snap?.rows ?? [], bench, nowMs, providers: null, tiers, toolFidelity: null, aliasValues: {}, defaultModel: null }, { ...base, ...p });
      for (const m of res.models ?? []) keys.add(m.s);
    }
    return { keys, note: `${presets.length} presets` };
  } catch (e) { return { keys: null, note: `the preset sets could not be computed offline (${e?.message ?? e}); priority level 2 is empty` }; }
}

/**
 * The models the L3 step (and L4 and the big step) targets: EVERY probe-ok model on a free-tier provider, whether or not its context is known. Excluded with a
 * ledger reason: `paid-tier`, `deposit-tier`, `management-tier`, `relay-by-provenance` (the relay and any subscription tier), `tier-unknown` (no registry tier), and
 * `ctx-too-small-for-fixture` (a KNOWN context too small for the ~157 KB fixture, `ctxNeededFor`). `includeTiers` are the LIFTED tiers (from `liftDeepProbes`); a tier that was only
 * `requestedTiers` stays out with the reason `deep-probes: not-free-tier`. Owner pins (`pins`) are
 * taken whatever their tier.
 * ORDER is a priority queue, never a limit: 1 the compiled policy's allowed set with a known context of at least `floor`, and the pins (pins first); 2 the union of
 * every preset's allowed set (`presetKeys`); 3 the other models with a known context of at least `floor`; 4 unknown context; 5 known context below `floor`. Inside a
 * level, the policy's own rank (then the probe-set order). `set` is `probeSet(...)`. Returns `{entries (each with prio and tier), excluded, floor, pinned}`.
 */
export function selectCandidates({ set, policy, tiers = {}, includeTiers = [], requestedTiers = [], pins = [], floor = SUBSTITUTE_FLOOR, presetKeys = null, maxTokens = null }) {
  const rank = new Map((policy?.models ?? []).map((m, i) => [m.s, { i, c: m.c }]));
  const pinList = [...new Set(pins.map((p) => benchKey(...splitKey(p))))];
  const byKey = new Set(set.models.map((e) => e.key));
  const allowed = new Set(["free", ...includeTiers]);
  const need = ctxNeededFor(3, maxTokens);
  const entries = [], excluded = [], small = [];
  set.models.forEach((e, order) => {
    const tier = tiers?.[e.provider];
    const pinIdx = pinList.indexOf(e.key);
    {                                                                                // the tier rule holds for a pin too: only free-labelled providers are probed at all
      if (!isTier(tier) || !allowed.has(tier)) { excluded.push({ key: e.key, reason: tier === "subscription" ? TIER_EXCLUSION.subscription : NOT_FREE_REASON, tier: isTier(tier) ? tier : null }); return; }
    }
    if (pinIdx < 0 && e.ctx > 0 && e.ctx < need) {
      excluded.push({ key: e.key, reason: "ctx-too-small-for-fixture" });
      const listed0 = !e.free && (e.pin > 0 || e.pout > 0);
      small.push({ ...e, ...(tier === "free" && !listed0 ? { free: true } : {}), ...(tier === "free" && listed0 ? { pricedOnFree: true } : {}), tier, prio: 5, smallOnly: true });       // too small for the 157 KB fixture, not for L1 and L2
      return;
    }
    const row = rank.get(e.key);
    const prio = pinIdx >= 0 || (row && Number.isFinite(row.c) && row.c >= floor) ? 1 : presetKeys?.has(e.key) ? 2 : e.ctx >= floor ? 3 : e.ctx > 0 ? 5 : 4;
    // a key of tier `free` is free of charge only where the LISTING is too (no listed price, or price 0 / a free tag). A model with a LISTED price is costed at that price, so the row ceiling
    // and the spend cap apply to it (`pricedOnFree`); the deep-probe rule still goes by the KEY tier (`tier`), not by this.
    const listed = !e.free && (e.pin > 0 || e.pout > 0);
    entries.push({ ...e, ...(tier === "free" && !listed ? { free: true } : {}), ...(tier === "free" && listed ? { pricedOnFree: true } : {}), tier: isTier(tier) ? tier : null, prio, ...(pinIdx >= 0 ? { pinned: true } : {}), _o: [prio, pinIdx >= 0 ? pinIdx : Infinity, row ? row.i : Infinity, order] });
  });
  entries.sort((a, b) => { for (let i = 0; i < 4; i++) if (a._o[i] !== b._o[i]) return a._o[i] < b._o[i] ? -1 : 1; return 0; });
  for (const e of entries) delete e._o;
  for (const k of set.relay) excluded.push({ key: k, reason: "relay-by-provenance" });
  return { entries, excluded, small, floor, pinned: pinList.filter((p) => !byKey.has(p)) };
}

// ------------------------------------------------------------------ the stratified pilot (`--sample`)

const REASONING_ID = /(^|[-_/:.])(r1|o1|o3|o4|qwq|magistral|gpt-oss)([-_/:.]|$)|think|reason/i;
/** The stratum of a model for the pilot: reasoning or plain (from the id: the snapshot has no such flag), and the context class unknown, small (under 128,000) or large. */
export const stratumOf = (e) => `${REASONING_ID.test(e.id) ? "reasoning" : "plain"}/${e.ctx > 0 ? (e.ctx >= SUBSTITUTE_FLOOR ? "large" : "small") : "unknown"}`;

function rng(seed) {                                            // mulberry32 over a 32-bit hash of the seed text: the same seed gives the same sample on every machine
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffled = (list, rand) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/**
 * A deterministic stratified pilot: `n` free-tier models drawn across providers (a few each, in rounds: one per provider per round, so no provider is
 * drawn twice before every provider once) and, inside a provider, across the strata reasoning or plain by context class, taking the least-used stratum
 * first. The same `seed` gives the same models. Returns `{entries, strata}`; `strata` carries the counts a dry run prints.
 */
export function drawSample({ entries, n = 60, seed = 1 }) {
  const rand = rng(seed);
  const pool = entries.filter((e) => e.tier === "free");
  const by = new Map();
  for (const e of pool) { if (!by.has(e.provider)) by.set(e.provider, new Map()); const m = by.get(e.provider); const s = stratumOf(e); if (!m.has(s)) m.set(s, []); m.get(s).push(e); }
  for (const m of by.values()) for (const [s, l] of m) m.set(s, shuffled(l, rand));
  const order = shuffled([...by.keys()].sort(), rand), used = new Map(order.map((p) => [p, new Map()])), overall = new Map(), out = [];
  while (out.length < n && order.some((p) => [...by.get(p).values()].some((l) => l.length))) {
    for (const p of order) {
      if (out.length >= n) break;
      const live = [...by.get(p)].filter(([, l]) => l.length);
      if (!live.length) continue;
      // least used inside this provider first, then least used across ALL providers (so reasoning and plain, and every context class, are drawn in proportion), then by name
      live.sort(([a], [b]) => (used.get(p).get(a) ?? 0) - (used.get(p).get(b) ?? 0) || (overall.get(a) ?? 0) - (overall.get(b) ?? 0) || (a < b ? -1 : 1));
      const [s, l] = live[0];
      out.push(l.shift());
      used.get(p).set(s, (used.get(p).get(s) ?? 0) + 1);
      overall.set(s, (overall.get(s) ?? 0) + 1);
    }
  }
  const tally = (f) => { const o = {}; for (const e of out) o[f(e)] = (o[f(e)] ?? 0) + 1; return o; };
  return { entries: out, strata: { n: out.length, of: pool.length, providers: new Set(out.map((e) => e.provider)).size, byProvider: tally((e) => e.provider),
    byReasoning: tally((e) => stratumOf(e).split("/")[0]), byCtx: tally((e) => stratumOf(e).split("/")[1]), byStratum: tally(stratumOf) } };
}

/**
 * The L3 failure rate among the models that PASSED L1 and L2, overall and per provider: `tested` have an L3 result (p or f), `failed` have f, `waiting` are
 * passers with no L3 result yet (including a first strike). `rate` is failed over tested, or null with nothing tested. For the owner's decision on promoting L3/L4.
 */
export function l3Rates(store, keys) {
  const per = new Map();
  const blank = () => ({ passers: 0, tested: 0, failed: 0, waiting: 0 });
  const all = blank();
  for (const k of keys) {
    const r = store[k];
    if (!r || !r.lvr.startsWith("pp")) continue;
    const prov = k.slice(0, k.indexOf("/"));
    const p = per.get(prov) ?? blank();
    per.set(prov, p);
    for (const t of [p, all]) {
      t.passers += 1;
      if (r.lvr[2] === "p" || r.lvr[2] === "f") { t.tested += 1; if (r.lvr[2] === "f") t.failed += 1; } else t.waiting += 1;
    }
  }
  const fin = (t) => ({ ...t, rate: t.tested ? t.failed / t.tested : null });
  return { overall: fin(all), perProvider: Object.fromEntries([...per].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, fin(v)])) };
}

// ------------------------------------------------------------------ the envelope: what the whole queue costs, and how many runs it takes

/**
 * What finishing a queue would cost at full depth, before any cap: its requests and input tokens, the cap per provider that would finish it in ONE run
 * (`oneRunCap`: the largest provider total), the per-provider totals, and how many runs it takes at `cap` (every model assumed to complete; a model that
 * alone costs more than the cap never runs: `neverRuns`). `rated` is `estimate(...).entries`.
 */
export function envelope(rated, cap = DEFAULT_TOKENS_PER_PROVIDER) {
  const per = new Map();
  let requests = 0, tokens = 0;
  for (const e of rated) {
    const p = per.get(e.provider) ?? { provider: e.provider, models: 0, requests: 0, tokens: 0 };
    p.models += 1; p.requests += e.reqs; p.tokens += e.tin; per.set(e.provider, p);
    requests += e.reqs; tokens += e.tin;
  }
  let runs = 0, rest = rated, neverRuns = 0;
  while (rest.length && runs < 100000) {
    const { kept, waiting, tooBig } = applyProviderCap(rest, cap);
    neverRuns += tooBig.length;
    if (!kept.length) { neverRuns += waiting.length; break; }
    runs += 1; rest = waiting;
  }
  const perProvider = [...per.values()].sort((a, b) => b.tokens - a.tokens || (a.provider < b.provider ? -1 : 1));
  return { models: rated.length, providers: per.size, requests, tokens, perProvider, oneRunCap: perProvider[0]?.tokens ?? 0, runs, neverRuns, cap };
}

// ------------------------------------------------------------------ the coverage ledger

/**
 * Splits a universe into exactly three states and refuses to return anything else. `universe` is `[{key, excluded?: reason}]`: every model the step
 * is about. THROWS when a model is in two states, in none, appears twice, or is not in the universe: a model dropped by a bug is a loud failure, never a
 * quietly smaller denominator.
 */
export function assertPartition(universe, { tested, pending, excluded, held = [] }) {
  const keys = universe.map((u) => u.key);
  if (new Set(keys).size !== keys.length) throw new Error("coverage: a model appears twice in the universe");
  const seen = new Map();
  for (const [state, list] of [["tested", tested], ["pending", pending], ["excluded", excluded], ["held", held]]) {
    for (const e of list) {
      if (seen.has(e.key)) throw new Error(`coverage: ${e.key} is in two states (${seen.get(e.key)} and ${state})`);
      seen.set(e.key, state);
    }
  }
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`coverage: ${missing.length} model(s) are in no state, first ${missing[0]}`);
  const extra = [...seen.keys()].filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`coverage: ${extra[0]} is in a state but not in the universe`);
  if (tested.length + pending.length + excluded.length + held.length !== keys.length) throw new Error("coverage: the states do not add up to the universe");
}

/**
 * The coverage ledger of one step. Every model of the universe ends in exactly ONE terminal state:
 *   tested    it has a result for this step: its tier (the compiled class) and the evidence (lvr, the big step, a size cap)
 *   pending   it is waiting, with the reason: first-strike (failed once, asked again), a stored reason from earlier runs (rate, pay, auth, timeout, error,
 *             gone, empty, cap, spend, row-cost, not-run), or this run's plan (`plan[key]`: queued, cap, spend)
 *   excluded  the universe said so, with the reason (ctx floor, outside the toggles, invalid id, relay by provenance, not probe-ok)
 * `level` is `l12` (a result for L1 and L2) or `l3` (L3 ran, or L1/L2 failed for good so L3 can never run). Lists, capped at `listCap`:
 * `provisional` models that failed once (a first strike is never reported as a failure), `stuck` models pending in `stuckRuns` or more runs in a row, and
 * `outdated` tested models whose record is against an older fixture (a `*`: re-sweep recommended, never automatic).
 */
export const HELD_PLAN = "held";
export function coverage(universe, store, { level = "l12", pending = {}, plan = {}, fixtureId = FIXTURE_ID, stuckRuns = 3, listCap = 10, deepOk = () => true, heldWhy = {}, heldSince = {} } = {}) {
  const tested = [], waiting = [], excluded = [], provisional = [], stuck = [], outdated = [], held = [], incomplete = [];
  const optional = { l4: 0, big: 0, sp: 0, er: 0 };
  for (const u of universe) {
    if (u.excluded) { excluded.push({ key: u.key, reason: u.excluded }); continue; }
    const r = store[u.key] ?? null;
    const strike = r && r.strikes === 1 ? r.sl : 0;
    const confirmedFail = !!r && r.lvr[0] !== "n" && r.t === "x" && !strike;
    const done = !!r && (level === "l12" ? r.lvr[0] !== "n" : r.lvr[2] === "p" || r.lvr[2] === "f" || confirmedFail);
    if (strike) provisional.push({ key: u.key, level: strike, why: r.why ?? "" });
    if (done) {
      tested.push({ key: u.key, tier: compiledClass(r), evidence: `${r.lvr}${r.big ? ` big ${r.big}` : ""}${r.capBelow ? ` cap<${r.capBelow}` : ""}${PF_FIELDS.filter((k) => r[k]).map((k) => ` ${k} ${r[k]}`).join("")}` });
      // OPTIONAL levels do not block `tested`: they are counted while they have not run (only where deep probes are allowed, and only behind an L3 pass or a passed pair)
      if (r.t !== "x" && r.lvr.startsWith("pp") && deepOk(u.key)) {
        const miss = [];
        if (r.lvr[2] === "p" && r.lvr[3] === "n") miss.push("l4");
        if (r.lvr[2] === "p" && r.big === undefined) miss.push("big");
        if (r.sp === undefined) miss.push("sp");
        if (r.er === undefined) miss.push("er");
        for (const k of miss) optional[k] += 1;
        if (miss.length) incomplete.push({ key: u.key, missing: miss });             // tested, but an optional level it is eligible for has not run (uncapped: the verdict reads it)
      }
      if (r.fx !== fixtureId) outdated.push({ key: u.key, fx: r.fx });
      continue;
    }
    const p = pending[u.key];
    if (plan[u.key] === HELD_PLAN) { const pv = u.key.slice(0, u.key.indexOf("/")); held.push({ key: u.key, reason: heldWhy[pv] ?? "held", since: heldSince[pv] ?? null }); continue; }          // its provider is held: not waiting, not 'pending too long'
    waiting.push({ key: u.key, reason: strike ? "first-strike" : plan[u.key] ?? p?.r ?? "not-run", runs: p?.n ?? 0, since: p ? p.since ?? p.at : null });       // since: when the stored reason was first recorded (null: never asked)
    if (p && p.n >= stuckRuns) stuck.push({ key: u.key, reason: p.r, runs: p.n });
  }
  assertPartition(universe, { tested, pending: waiting, excluded, held });
  const tally = (list, f) => { const o = {}; for (const e of list) o[f(e)] = (o[f(e)] ?? 0) + 1; return o; };
  const cap = (l) => ({ n: l.length, list: l.slice(0, listCap) });
  return {
    level, total: universe.length, tested, pending: waiting, excluded, held,
    counts: { total: universe.length, tested: tested.length, pending: waiting.length, excluded: excluded.length, held: held.length, byHeld: tally(held, (e) => e.reason),
              byTier: tally(tested, (e) => e.tier), byPending: tally(waiting, (e) => e.reason), byExcluded: tally(excluded, (e) => e.reason) },
    provisional: cap(provisional), stuck: cap(stuck), outdated: cap(outdated), optional, incomplete,
  };
}

/** The ledger as printed lines (dry run and sweep report); every figure names its denominator. */
export function coverageLines(cov, label) {
  const c = cov.counts, fmt = (o) => Object.entries(o).sort(([, a], [, b]) => b - a).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const L = [`coverage ${label}: ${c.total} model(s) = tested ${c.tested} (${fmt(c.byTier)}) + pending ${c.pending} (${fmt(c.byPending)}) + excluded ${c.excluded} (${fmt(c.byExcluded)})${c.held ? ` + held ${c.held} (${fmt(c.byHeld)}: a provider with an account state, not asked for a while)` : ""}`];
  const list = (name, l, f) => { if (l.n) L.push(`  ${name} ${l.n} of ${c.total}: ${l.list.map(f).join(", ")}${l.n > l.list.length ? `, and ${l.n - l.list.length} more` : ""}`); };
  list("failed once (provisional, asked again, not yet x)", cov.provisional, (e) => `${e.key} L${e.level}`);
  list("pending too long", cov.stuck, (e) => `${e.key} ${e.reason} x${e.runs}`);
  list("against an older fixture (*, re-sweep recommended)", cov.outdated, (e) => `${e.key} ${e.fx}`);
  const opt = Object.entries(cov.optional ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k === "l4" ? "L4" : k === "sp" ? "spawn" : k === "er" ? "error-result" : k} ${n}`);
  if (opt.length) L.push(`  optional level gaps not run yet among the ${c.tested} tested model(s) (a model can have more than one; they do not block being tested): ${opt.join(", ")}`);
  return L;
}

/** The two universes of the ledger: every listed model for L1+L2 (the not probe-ok, the invalid ids and the relay are excluded with their reason), and the L3 candidates with theirs. */
export function ledgerUniverses({ set, cand = null }) {
  const l12 = [...set.models.map((e) => ({ key: e.key })), ...(set.notFree ?? []).map((e) => ({ key: e.key, excluded: NOT_FREE_REASON })), ...set.relay.map((k) => ({ key: k, excluded: "relay-by-provenance" })),
    ...(set.notOkKeys ?? []).map((k) => ({ key: k, excluded: "not-probe-ok" })), ...(set.badKeys ?? []).map((k) => ({ key: k, excluded: "invalid-id" }))];
  const l3 = cand ? [...cand.entries.map((e) => ({ key: e.key })), ...cand.excluded.map((e) => ({ key: e.key, excluded: e.reason })), ...(set.notFree ?? []).map((e) => ({ key: e.key, excluded: NOT_FREE_REASON }))] : null;
  return { l12, l3 };
}

/**
 * The pending map after a run. A model that was in the run's queue and has NO result from it gets one more run counted and the reason it did not finish
 * (`reasonOf(key)`: a status such as rate or pay, spend, cap, not-run); one that got a result, or is waiting on its second strike (the strike is the
 * state), is dropped. Entries of models outside `keepKeys` are dropped. The ledger ignores an entry of a model that is tested. Pure.
 */
/** Pending reasons that come from an ASK (the model was sent a request and got no verdict): such a model queues behind the ones never asked, and a later `cap` wait does not erase that history. */
export const TRIED_REASONS = new Set(["rate", "quota", "optional-flaky", "pay", "auth", "gone", "error", "timeout", "empty", "slow", "reasoning-budget", "route-shape", "upstream-unavailable", "request-cap"]);
/** Pending reasons of models a paused provider was never asked about: not an answer, never counted (see updatePending). */
export const PAUSED_REASONS = new Set(["rate-paused", "quota-paused"]);
export function updatePending(pending, { queue, recorded, store, reasonOf, whyOf = null, flaky = null, now = new Date(), keepKeys = null }) {
  const out = { ...pending };
  if (keepKeys) for (const k of Object.keys(out)) if (!keepKeys.has(k)) delete out[k];             // a model that has left the probe set is not pending
  for (const e of queue) {
    const r = store[e.key];
    // a model that got its record but had a small level (spawn, error result) set aside as flaky keeps a DEFERRAL MARKER: `optional-flaky`, with since and rn like any other reason (it counts toward stuck at rn >= 3)
    const isFlaky = !!flaky?.has(e.key);
    if (!isFlaky && (recorded.has(e.key) || r?.strikes === 1)) { delete out[e.key]; continue; }
    const code = isFlaky ? "optional-flaky" : String(reasonOf(e.key) ?? "not-run").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "not-run";
    const prev = out[e.key];
    if (code === "cap" && prev && TRIED_REASONS.has(prev.r)) continue;                       // it waited for the cap this time: what the last ask said stays, and so does its place in the line
    // A model that was NEVER ASKED because its provider was paused (`rate-paused`, `quota-paused`) says nothing about the model: it keeps the reason of its last real ask, and an entry that is already one of these
    // stays as it is, so the pause never grows `n` or `rn`, never counts toward stuck, and the policy funnel (which reads only the real soft and hard reasons) has nothing to demote it for.
    if (PAUSED_REASONS.has(code) && prev && (TRIED_REASONS.has(prev.r) || prev.r === code)) continue;
    const same = !!prev && prev.r === code;
    const why = whyOf?.(e.key) ?? (same ? prev.why : undefined);
    out[e.key] = { r: code, n: Math.min(9999, (prev?.n ?? 0) + 1), at: now.toISOString(), since: same ? prev.since ?? prev.at : now.toISOString(),         // since: the first time THIS reason was recorded
      rn: same ? Math.min(9999, (prev.rn ?? prev.n) + 1) : 1,                                                                                         // rn: runs in a row with THIS reason (a legacy entry reads as rn = n)
      ...(why ? { why: redactClip(String(why), PENDING_WHY_CHARS) } : {}) };
  }
  return out;
}

// ------------------------------------------------------------------ migration: strikes that came from the awkward-content L1

/**
 * The first L1 requests of the probe carried awkward content (multi-line text, quotes, backslashes, unicode) in an Edit-style call, so a model that CAN call tools but emitted invalid JSON for
 * that content, or whose server refused the AUTO tool choice outright (`"auto" tool choice requires --enable-auto-tool-choice`), was recorded as an L1 failure and a strike. L1 is now a plain
 * echo call, argument fidelity is its own request, and a refused auto choice goes to the forced fallback. The records those requests produced say so in their `why`.
 */
export const OLD_L1_WHY = /^L1: (tool call arguments are not valid JSON|a tool call lacks the required argument `file_path`|HTTP 4\d\d: .*(auto(matic)?"? tool[ _-]?choice|enable-auto-tool-choice))/i;
/** Why a stored L1 reason is not about the model, or null: the old awkward-content L1, a refused auto choice, an empty wallet or a route that wants another shape (both read only since the later fixes). */
export function oldL1Reason(why) {
  if (typeof why !== "string") return null;
  if (OLD_L1_WHY.test(why)) return /JSON|file_path/.test(why) ? "awkward-json" : "auto-choice";
  const m = /^L1: HTTP 4\d\d: ([\s\S]*)$/.exec(why);
  const r = m ? accountOrRoute(m[1]) : null;
  return r === "pay" ? "wallet" : r === "route-shape" ? "route-shape" : null;
}
/**
 * Clears them. A record whose reason is one of the above and that is a strike (first or second) or an L1 failure is dropped when nothing else is known about the model (it asks L1 again from
 * scratch), otherwise only its strike and reason are removed and its class is worked out again. Pure: returns `{store, cleared: [{key, kind: "strike" | "failed", reason: "awkward-json" | "auto-choice" | "wallet" | "route-shape", removed}]}`.
 */
export function migrateStrikes(store) {
  const out = {}, cleared = [];
  for (const [key, rec] of Object.entries(store ?? {})) {
    const reason = rec ? oldL1Reason(rec.why) : null;
    const hit = reason !== null && (rec.strikes !== undefined || rec.lvr?.[0] === "f");
    if (!hit) { out[key] = rec; continue; }
    const removed = rec.lvr[0] !== "p";
    cleared.push({ key, kind: rec.strikes === 1 ? "strike" : "failed", reason, removed });
    if (removed) continue;
    const { strikes, sl, why, ...rest } = rec;
    const t = classOf({ lvr: rest.lvr, capBelow: rest.capBelow, fc: rest.fc });
    out[key] = { ...rest, t, ok: t === "v" || t === "t" };
  }
  return { store: out, cleared };
}

// ------------------------------------------------------------------ holds that were wrong, and the per-provider table of what is untested

/** The providers that have at least one CONFIRMED result (class t or v): a provider that has answered is never gone and never out of credit as a whole. `{provider: n}`. */
export function confirmedProviders(store) {
  const out = {};
  for (const [k, r] of Object.entries(store ?? {})) if (r && (r.t === "t" || r.t === "v")) { const p = k.slice(0, k.indexOf("/")); out[p] = (out[p] ?? 0) + 1; }
  return out;
}
/** A hold on gone or pay grounds for a provider that has confirmed results is wrong: gone and pay are answers about MODELS there. (An auth hold stays: the key is the account.) */
export const holdIsWrong = (h, confirmed, provider) => !!h && (h.r === "gone" || h.r === "pay") && (confirmed?.[provider] ?? 0) > 0;
/**
 * Releases holds: the named `providers` and, with `wrong`, every hold on gone or pay grounds whose provider has confirmed results. The `canary-*` pending entries of a released provider go too (they were
 * written by the pause and are judged again). Pure: `{held, pending, released: [{provider, r, confirmed, named}], cleared: [pending key], missing: [provider]}` (`missing`: named providers with neither a hold nor a hard entry).
 */
export function releaseHolds(store, pending, held, { providers = [], wrong = false } = {}) {
  const confirmed = confirmedProviders(store), hold = { ...(held ?? {}) }, pend = { ...(pending ?? {}) }, released = [];
  const named = new Set(providers);
  for (const [p, h] of Object.entries(held ?? {})) {
    const isNamed = named.has(p), isWrong = wrong && holdIsWrong(h, confirmed, p);
    if (!isNamed && !isWrong) continue;
    delete hold[p];
    released.push({ provider: p, r: h.r, confirmed: confirmed[p] ?? 0, named: isNamed });
  }
  const gone = new Set(released.map((x) => x.provider)), asked = new Set(providers), cleared = [];
  // the owner NAMED the provider (held or not): its models pending pay / auth / gone are lifted too (they are sticky otherwise); a hold released as wrong lifts only the canary entries its pause wrote
  for (const k of Object.keys(pend)) { const pv = k.slice(0, k.indexOf("/")); if ((gone.has(pv) && /^canary-/.test(pend[k].r)) || (asked.has(pv) && /^(canary-)?(pay|auth|gone)$/.test(pend[k].r))) { delete pend[k]; cleared.push(k); } }
  const clearedOf = new Set(cleared.map((k) => k.slice(0, k.indexOf("/"))));
  return { held: hold, pending: pend, released, cleared, missing: providers.filter((p) => !(held && Object.hasOwn(held, p)) && !clearedOf.has(p)) };
}

/**
 * Why the untested models of each provider are untested, from a ledger (`coverage(...)`): `[{provider, tested, untested, why: {reason: n}, runnable}]`, most untested first. `held:pay` the provider is
 * held, `paused:pay` the provider was paused by its canary in an earlier run, `cap` waiting for the per-provider cap, `queued` this run will ask it, the rest are the stored reasons (rate, pay, gone,
 * error, not-run, ...). `runnable`: the provider is not held and has models queued or waiting for the cap.
 */
export function untestedTable(cov) {
  const by = new Map(), prov = (k) => k.slice(0, k.indexOf("/"));
  const row = (p) => { if (!by.has(p)) by.set(p, { provider: p, tested: 0, untested: 0, why: {}, runnable: false }); return by.get(p); };
  for (const e of cov.tested) row(prov(e.key)).tested += 1;
  const add = (e, reason) => { const r = row(prov(e.key)); r.untested += 1; r.why[reason] = (r.why[reason] ?? 0) + 1; };
  for (const e of cov.pending) add(e, /^canary-/.test(e.reason) ? `paused:${e.reason.slice(7)}` : e.reason);
  for (const e of cov.held) add(e, `held:${e.reason}`);
  for (const r of by.values()) r.runnable = !Object.keys(r.why).some((k) => k.startsWith("held:")) && ((r.why.queued ?? 0) + (r.why.cap ?? 0) > 0);
  return [...by.values()].filter((r) => r.untested > 0).sort((a, b) => b.untested - a.untested || (a.provider < b.provider ? -1 : 1));
}

// ------------------------------------------------------------------ the sweep verdict: what a re-run can still change

/** Pending reasons that a re-run alone cannot change: the owner has to change a flag or the route (a row-cost ceiling, a route shape). Not recoverable, not an account state. */
export const OWNER_REASONS = new Set(["row-cost", "priced-over-row-cap", "route-shape", "cap-too-big"]);
/** The owner reasons a normal run does not queue: `route-shape` is not queued while it is the stored reason; `row-cost` and `priced-over-row-cap` are not queued while the model is still over the row ceiling (raise --max-row-cost and they run). `cap-too-big` is worked out from the cap each run (raise --tf-max-tokens-per-provider). A named model or `--recheck-hard owner` asks them. */
export const OWNER_STICKY = new Set(["route-shape"]);
export const OWNER_COST = new Set(["row-cost", "priced-over-row-cap"]);
/** A soft reason that has been the answer this many runs in a row is STILL recoverable, but counted apart as stuck: only these reasons (a rate limit or a cap says nothing about the model). */
export const STUCK_REASONS = new Set(["error", "timeout", "empty", "slow", "quota", "optional-flaky"]);
export const STUCK_RUNS = 3;
/** The optional levels of a tested model, by the short names the ledger uses, as the verdict names them. */
const OPTIONAL_NAME = { l4: "L4", big: "big", sp: "spawn", er: "error-result" };
/**
 * The one partition the loop reads, over the models of the ledger(s) that are not excluded (a model in both ledgers counts once; the worst state wins: hard, then recoverable, then needs-owner, then tested):
 *   tested       it has a result for the step: never asked again by a normal run. Split by completeness: `complete` (every level it is eligible for has run) and `incomplete` (tested, but an optional level it is
 *                eligible for has not run: L4, big, spawn, error-result); the `tested` partition itself is not changed by it
 *   recoverable  pending for a reason that a later run can change: rate, error, timeout, cap, spend, request-cap, empty, slow, reasoning-budget, upstream-unavailable, not-run (also `queued`), first-strike, ...
 *                `stuck` of them (error, timeout, empty or slow for `stuckRuns` or more runs in a row) stay recoverable but are counted apart
 *   hard         pay, auth, gone (a provider held for one of them, or a model pending it): non-recoverable by the engine, lifted only by a manual action (--recheck-hard, --retry-accounts, --release-holds, naming the model with --only)
 *   owner        row-cost, priced-over-row-cap, route-shape: a re-run changes nothing until the owner changes a flag or a route
 * `confirmed` is `confirmedProviders(store)` (see `hardState`), `pending` the stored pending map, `store` the records (a first strike is recoverable). `oldestSince` is, per reason, the oldest date it was first
 * recorded among the models that are not tested (the cool-down a re-run has had). Pure: `{total, tested, complete, incomplete, byMissing, recoverable, byRecoverable, stuck, byStuck, hard, byHard, owner, byOwner, excluded, oldestSince}`;
 * total = tested + recoverable + hard + owner.
 */
const SCHEDULING_REASONS = new Set(["cap", "cap-too-big", "not-run", "spend"]);
export function sweepVerdict({ l12, l3 = null, confirmed = {}, pending = {}, store = {}, stuckRuns = STUCK_RUNS, levels = null, optional = [] }) {
  const strikeOut = new Set();
  const RANK = { excluded: 0, tested: 1, owner: 2, recoverable: 3, hard: 4 };
  const by = new Map(), missing = new Map();
  const put = (key, s, reason, since = null, runs = 0) => { const cur = by.get(key); if (!cur || RANK[s] > RANK[cur.s]) by.set(key, { s, reason, since, runs }); };
  const prov = (k) => k.slice(0, k.indexOf("/"));
  for (const cov of [l12, l3]) {
    if (!cov) continue;
    for (const e of cov.excluded) put(e.key, "excluded", e.reason);
    // a FIRST STRIKE has a stored result but is provisional: the next run asks it again, so it is recoverable, not tested
    // (only when the level it failed at, `sl`, is one this run asks: otherwise nothing would ask it again here, so it counts as tested and is named in `strikeOutOfLevels`)
    for (const e of cov.tested) {
      const rec = store?.[e.key];
      if (rec?.strikes === 1 && (!levels || levels.includes(rec.sl))) put(e.key, "recoverable", "first-strike", rec.at ?? null);
      else { if (rec?.strikes === 1) strikeOut.add(e.key); put(e.key, "tested", null); }
    }
    for (const e of cov.incomplete ?? []) missing.set(e.key, [...new Set([...(missing.get(e.key) ?? []), ...e.missing])]);
    for (const e of cov.held) put(e.key, "hard", HELD_STATES.includes(e.reason) ? e.reason : "gone", e.since ?? null);
    for (const e of cov.pending) {
      // this run's plan (`queued`, `cap`) hides why the model was pending before: the stored reason is the one that says what a re-run is up against
      const st = pending?.[e.key];
      // this run's plan hides why the model was pending before: the stored reason says what a re-run is up against, EXCEPT a scheduling reason (cap, spend, not-run) or a NEEDS-OWNER one (row-cost, priced-over-row-cap, route-shape: the owner has since raised the ceiling or lifted it, so it is asked now): a model this run QUEUES is not waiting for the
      // cap any more, and one that waits for it now is `cap` whatever it was before
      const reason = (e.reason === "queued" || e.reason === "cap") && st ? (e.reason === "queued" ? (SCHEDULING_REASONS.has(st.r) || OWNER_REASONS.has(st.r) ? "not-run" : st.r) : (TRIED_REASONS.has(st.r) ? st.r : "cap")) : e.reason;
      const same = st ? st.r === reason : true;
      const since = same ? (st ? st.since ?? st.at : e.since ?? null) : null, runs = same ? (st ? st.rn ?? st.n : e.runs ?? 0) : 0;        // runs in a row with THIS reason (rn)
      const h = hardState(reason, prov(e.key), confirmed);
      if (h) put(e.key, "hard", h, since, runs);
      else if (OWNER_REASONS.has(reason)) put(e.key, "owner", reason, since, runs);
      else put(e.key, "recoverable", reason === "queued" ? "not-run" : reason, since, runs);
    }
  }
  // A TESTED model that is still missing a level the run ASKS for (spawn and the error result by default; 3 to 5 only when they are asked and the model is eligible: `optional` is what the queue would
  // send it) is not finished: it is recoverable (`optional-not-run`, or the reason of its pending entry, e.g. `optional-flaky` or `rate`), or hard when its provider is held.
  for (const o of optional) {
    const cur = by.get(o.key);
    if (!cur || cur.s !== "tested") continue;
    if (o.held) { put(o.key, "hard", HELD_STATES.includes(o.held) ? o.held : "gone", null); continue; }
    const st = pending?.[o.key];
    let reason = st ? st.r : "optional-not-run";
    if (o.plan === "queued" && st && (SCHEDULING_REASONS.has(st.r) || OWNER_REASONS.has(st.r))) reason = "optional-not-run";               // queued this run: not 'cap'
    else if (o.plan === "cap" && !(st && TRIED_REASONS.has(st.r))) reason = "cap";
    const since = st ? st.since ?? st.at : null, runs = st ? st.rn ?? st.n : 0;
    const h = hardState(reason, prov(o.key), confirmed);
    if (h) put(o.key, "hard", h, since, runs);
    else if (OWNER_REASONS.has(reason)) put(o.key, "owner", reason, since, runs);
    else put(o.key, "recoverable", reason, since, runs);
  }
  const tally = (s, f = () => true) => { const o = {}; for (const v of by.values()) if (v.s === s && f(v)) o[v.reason] = (o[v.reason] ?? 0) + 1; return o; };
  const count = (s, f = () => true) => [...by.values()].filter((v) => v.s === s && f(v)).length;
  const isStuck = (v) => STUCK_REASONS.has(v.reason) && v.runs >= stuckRuns;
  const oldestSince = {};
  for (const v of by.values()) if (v.s !== "tested" && v.s !== "excluded" && v.since && (!oldestSince[v.reason] || Date.parse(v.since) < Date.parse(oldestSince[v.reason]))) oldestSince[v.reason] = v.since;
  const testedKeys = [...by].filter(([, v]) => v.s === "tested").map(([k]) => k);
  const incompleteKeys = testedKeys.filter((k) => missing.get(k)?.length);
  const byMissing = {};
  for (const k of incompleteKeys) for (const m of missing.get(k)) byMissing[OPTIONAL_NAME[m] ?? m] = (byMissing[OPTIONAL_NAME[m] ?? m] ?? 0) + 1;
  // the provider's own words for the stuck models, one per provider: the most common sentence among its stuck models
  const stuckBy = {};
  for (const [k, x] of by) {
    if (x.s !== "recoverable" || !isStuck(x)) continue;
    const pv = prov(k), e = (stuckBy[pv] ??= { total: 0, sentences: new Map() });
    e.total += 1;
    const w = pending?.[k]?.why;
    if (w) e.sentences.set(w, (e.sentences.get(w) ?? 0) + 1);
  }
  const stuckWhy = {};
  for (const [pv, e] of Object.entries(stuckBy)) { const top = [...e.sentences].sort((a, b) => b[1] - a[1])[0]; stuckWhy[pv] = { total: e.total, ...(top ? { why: top[0], n: top[1] } : {}) }; }
  const testedOf = (s) => [...by].filter(([k, x]) => x.s === s && testedState(store?.[k])).length;
  const v = { recoverableTested: testedOf("recoverable"), hardTested: testedOf("hard"), stuckWhy, tested: testedKeys.length, complete: testedKeys.length - incompleteKeys.length, incomplete: incompleteKeys.length, byMissing, recoverable: count("recoverable"), byRecoverable: tally("recoverable"),
    stuck: count("recoverable", isStuck), byStuck: tally("recoverable", isStuck), strikeOutOfLevels: [...strikeOut].filter((k) => by.get(k)?.s === "tested").length, hard: count("hard"), byHard: tally("hard"), owner: count("owner"), byOwner: tally("owner"), excluded: count("excluded"), oldestSince };
  return { total: v.tested + v.recoverable + v.hard + v.owner, ...v };
}

/**
 * What one run ADDED, from the records before and after it: `newTested` models that went from not tested to tested (any class, x included; a provisional first strike is not tested, resolving one is; a
 * model saved as a PARTIAL record, stopped at a later level, IS: its L1+L2 verdicts are what makes it tested) and `deepened` tested models that gained a level the run asked for (`levels`: 3 to 7). Pure over the two stores.
 */
export const testedState = (r) => !!r && r.lvr?.[0] !== "n" && r.strikes !== 1;
const gained = (b, a, l) => (l === 3 ? b.lvr?.[2] === "n" && a.lvr?.[2] !== "n" : l === 4 ? b.lvr?.[3] === "n" && a.lvr?.[3] !== "n" : l === 5 ? b.big === undefined && a.big !== undefined
  : l === 6 ? b.sp === undefined && a.sp !== undefined : l === 7 ? b.er === undefined && a.er !== undefined : false);
export function runGain(before, after, { levels = [] } = {}) {
  let newTested = 0, deepened = 0;
  for (const [k, r] of Object.entries(after ?? {})) {
    const was = before?.[k];
    if (r === was) continue;
    if (!testedState(was)) { if (testedState(r)) newTested += 1; continue; }
    if (levels.some((l) => gained(was, r, l))) deepened += 1;
  }
  return { newTested, deepened };
}

/**
 * The loop's stop signal for ONE run. Saturation is DIMINISHING RETURNS, not "everything is blocked": the tested total converges and each pass adds little. `saturated` is true, with its `reason`, when
 * (a) `done`: nothing is recoverable any more; (b) `zero-new`: the run recorded no new result (a run that sent nothing included); (c) `failing`: at least 80% of its requests ended rate, error, timeout or quota;
 * (d) `diminishing`: the last `runs` runs of THIS scope (this one included) each added newly tested models under `gain` percent of their tested total AND (newly tested + deepened) under `yieldPct` percent of the
 * models they asked: `history` is the earlier runs of this scope (the caller filters by scope; null when this run is not a recorded one: a lift, a named model, a forced or retried pass), `thisRun` this run's
 * record `{asked, newTested, deepened, testedTotal}`; fewer entries than `runs` is simply not saturated; (e) `no-shrink`, ONLY as a fallback while the scope has no history at all: the recoverable set did not
 * shrink against `prevRecoverable`, the count the previous run left in the meta block (null for a lift or another scope). Pure.
 */
export const SATURATION_FAIL_SHARE = 0.8;
export const SATURATE_GAIN = 1, SATURATE_YIELD = 5, SATURATE_RUNS = 2;
const pct1 = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
export function diminishingReturns({ history = null, thisRun = null, runs = SATURATE_RUNS, gain = SATURATE_GAIN, yieldPct = SATURATE_YIELD } = {}) {
  const n = Math.max(1, Math.min(HISTORY_PER_SCOPE, runs));
  if (!thisRun || !Array.isArray(history) || history.length < n - 1) return null;
  const set = [...(n > 1 ? history.slice(-(n - 1)) : []), thisRun];
  const low = (e) => e.testedTotal > 0 && (e.newTested * 100) / e.testedTotal < gain && (e.asked > 0 ? ((e.newTested + e.deepened) * 100) / e.asked < yieldPct : true);
  if (!set.every(low)) return null;
  return `diminishing returns over the last ${n} run(s): newly tested ${set.map((e) => `+${e.newTested}`).join(", ")} of ${set.map((e) => e.testedTotal).join("/")} tested (each under ${gain}%), and (new + deepened) of the models asked ${set.map((e) => `${pct1(e.newTested + e.deepened, e.asked) ?? 0}%`).join(", ")} (each under ${yieldPct}%)`;
}
export function saturation({ requests = 0, rate = 0, failing = 0, newResults = 0, recoverable = 0, prevRecoverable = null, history = null, thisRun = null, runs = SATURATE_RUNS, gain = SATURATE_GAIN, yieldPct = SATURATE_YIELD }) {
  const failShare = requests ? failing / requests : 0, rateShare = requests ? rate / requests : 0;
  let reason = null, why = null;
  if (recoverable === 0) { reason = "done"; why = "nothing recoverable left"; }
  else if (newResults === 0) { reason = "zero-new"; why = "no new result in this run"; }
  else if (requests && failShare >= SATURATION_FAIL_SHARE) { reason = "failing"; why = `${Math.round(failShare * 100)}% of the requests ended rate, error, timeout or quota`; }
  else {
    const d = diminishingReturns({ history, thisRun, runs, gain, yieldPct });
    if (d) { reason = "diminishing"; why = d; }
    else if (!history?.length && prevRecoverable !== null && prevRecoverable !== undefined && recoverable >= prevRecoverable) { reason = "no-shrink"; why = `the recoverable set did not shrink: ${recoverable} now, ${prevRecoverable} at the end of the previous run (fallback: this scope has no run history yet)`; }
  }
  return { saturated: reason !== null, reason, why, requests, rate, failing, failShare, rateShare, newResults, recoverable, prevRecoverable: prevRecoverable ?? null };
}

// ------------------------------------------------------------------ canary migration

/**
 * The old canary logic paused a WHOLE provider on one 'gone' answer and recorded `canary-gone` for every model behind it, and kept asking the providers with an account state every run. Now a gone
 * canary is judged on two distinct models and an account state is a HOLD. This clears the `canary-gone` entries (to be re-evaluated) and turns the `pay` / `auth` / `canary-pay` / `canary-auth` entries
 * into holds (at their own timestamp) for providers with no newer record. Pure: `{pending, held, goneCleared: [key], goneProviders: [provider], seeded: [{provider, r, at}]}`.
 */
export function migrateCanary(store, pending, held) {
  const out = { ...(pending ?? {}) }, hold = { ...(held ?? {}) }, goneCleared = [], seeded = [];
  const newest = {};
  for (const [k, r] of Object.entries(store ?? {})) { const p = k.slice(0, k.indexOf("/")); const t = Date.parse(r?.at); if (Number.isFinite(t)) newest[p] = Math.max(newest[p] ?? 0, t); }
  const seed = {};
  for (const [k, v] of Object.entries(pending ?? {})) {
    const p = k.slice(0, k.indexOf("/"));
    if (v.r === "canary-gone") { delete out[k]; goneCleared.push(k); continue; }
    const st = /^(?:canary-)?(pay|auth)$/.exec(v.r)?.[1];
    if (!st) continue;
    const t = Date.parse(v.at);
    if (!providerOk(p) || !Number.isFinite(t) || (newest[p] ?? 0) > t) continue;
    if (!seed[p] || t > Date.parse(seed[p].at)) seed[p] = { r: st, at: v.at };
  }
  for (const [p, v] of Object.entries(seed)) { if (hold[p] && Date.parse(hold[p].at) >= Date.parse(v.at)) continue; hold[p] = v; seeded.push({ provider: p, ...v }); }
  const goneProviders = [...new Set(goneCleared.map((k) => k.slice(0, k.indexOf("/"))))];
  return { pending: out, held: hold, goneCleared, goneProviders, seeded };
}

// ------------------------------------------------------------------ gateway-compat insights and the transient migration

/** The records that fail because of the gateway's request translation: `[{provider, n, hint}]` by provider (the provider's own words, cut), most first. */
export function gatewayInsights(store) {
  const by = new Map();
  for (const [key, r] of Object.entries(store ?? {})) {
    if (!r || r.xw !== "gateway") continue;
    const p = key.slice(0, key.indexOf("/"));
    const x = by.get(p) ?? { provider: p, n: 0, hint: "" };
    x.n += 1;
    if (!x.hint) x.hint = redactClip(String(r.why ?? "").replace(/^L\d: (\[3[ab]\] )?HTTP \d+: /, "").replace(/^\{"error":\{"message":"/, ""), 110);
    by.set(p, x);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || (a.provider < b.provider ? -1 : 1));
}

/** The shape of an availability or unnamed refusal, for the migration's counts. */
export function transientShape(msg) {
  const m = String(msg ?? "");
  if (/temporar(il)?y[ -]?(un)?available/i.test(m)) return "temporarily unavailable";
  if (/try another model/i.test(m)) return "try another model";
  if (/upstream (request |provider |service )?(failed|error)/i.test(m)) return "upstream request failed";
  if (/upstream (provider )?rejected/i.test(m)) return "upstream rejected";
  if (/service (is )?(temporarily )?unavailable|currently unavailable|bad gateway|gateway time-?out/i.test(m)) return "service unavailable";
  if (/internal (server )?error/i.test(m)) return "internal error";
  if (/overload|at capacity/i.test(m)) return "overloaded";
  if (/please (re)?try|\bretry\b/i.test(m)) return "please retry";
  return null;
}
const REFUSAL_WHY = /^L([123467]): (?:\[3[ab]\] )?HTTP (4\d\d): ([\s\S]*)$/;
/** Why a stored reason is an availability (or an unnamed 400) and not a verdict about the model, or null: `{level, shape}`. */
export function transientReason(why) {
  const m = typeof why === "string" ? REFUSAL_WHY.exec(why) : null;
  if (!m) return null;
  const msg = extractMsg(m[3]);
  if (isAvailabilityText(m[3])) return { level: Number(m[1]), shape: transientShape(msg) ?? "availability" };
  if (m[2] === "400" && m[1] !== "5" && !namesRequest(msg)) return { level: Number(m[1]), shape: transientShape(msg) ?? "unnamed 400" };
  return null;
}
/**
 * A stored L3 failure whose reason is an EMPTY answer or unfinished tool-call arguments, written before the stop reason and the budget were looked at: the output budget, a cut stream or a moderation stop can
 * all produce it, so it is no verdict. Returns `{level: 3, shape, reopen: true}` or null.
 */
export function reopenReason(why) {
  const m = typeof why === "string" ? /^L3: \[3[ab]\] (empty answer to the (?:constructs|large) request|tool call arguments are not valid JSON)$/.exec(why) : null;
  return m ? { level: 3, shape: m[1].startsWith("empty") ? "empty L3 answer" : "L3 arguments not valid JSON", reopen: true } : null;
}
const extractMsg = (body) => { let t = String(body ?? ""); try { const j = JSON.parse(t); const c = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : null); if (typeof c === "string") t = c; } catch { /* as is */ } return t.replace(/\s+/g, " ").trim(); };
/**
 * Clears the records whose reason is an availability or unnamed 400 (never a verdict; an `x` or a strike that those texts produced) and tags the gateway-translation failures with `xw: gateway`.
 * The failed level is reset to untested; a record with nothing else known is removed (asked again from scratch). Also clears `af`/`afw` whose reason came from the old content design (`afReset`). Pure: `{store, cleared: [{key, kind, shape, level, removed}], tagged: [key], afReset: [key]}`.
 */
/**
 * Pending `pay` entries that rest on an AVAILABILITY sentence only ("anymodel: Upstream request failed.") with no money word: written when an HTTP 402 alone made it `pay`. Such an entry is not evidence about the
 * account and, being hard, would never be asked again: the migration drops it so the model is queued again (like `--reset-transient` does for records). An entry with no stored sentence (written before `why`
 * existed) has nothing to judge by and is left alone: `--release-holds <provider>` lifts those by hand. Pure: `{pending, cleared: [{key, why}]}`.
 */
export function migrateAvailabilityPay(pending) {
  const out = { ...(pending ?? {}) }, cleared = [], clipped = [];
  for (const [key, v] of Object.entries(pending ?? {})) {
    if (v?.r !== "pay" || typeof v.why !== "string" || !v.why.trim()) continue;
    // a sentence at the clip length was cut: a money word after the cut is invisible, so it cannot be judged (like an entry with no sentence)
    if (v.why.length >= PENDING_WHY_CHARS) { clipped.push(key); continue; }
    if (isAvailabilityText(v.why) && !hasMoneyWords(v.why)) { delete out[key]; cleared.push({ key, why: v.why }); }
  }
  return { pending: out, cleared, clipped };
}
/**
 * Providers HELD on `pay` whose pending pay entries carry no sentence with a money word (none stored, cut at the clip length, or availability-only): the hold may rest on an HTTP 402 alone. A hold keeps
 * every model of the provider out of the queue, so dropping the model entries does not ask them again while it stands (`--release-holds <provider> --live` lifts it). Pure: sorted provider names.
 */
export function payHoldsOnBareEvidence(held, pending) {
  const money = new Set();
  for (const [key, v] of Object.entries(pending ?? {})) if (v?.r === "pay" && typeof v.why === "string" && hasMoneyWords(v.why)) money.add(key.slice(0, key.indexOf("/")));
  return Object.entries(held ?? {}).filter(([p, h]) => h?.r === "pay" && !money.has(p)).map(([p]) => p).sort();
}
export const STALE_AFW = /^(file_path: (newline|backslash)|replace_all: missing|start_line: missing)/;
export function migrateTransient(store) {
  const out = {}, cleared = [], tagged = [], afReset = [];
  for (const [key, rec] of Object.entries(store ?? {})) {
    if (!rec) { out[key] = rec; continue; }
    const tr = rec.lvr?.includes("f") || rec.strikes !== undefined ? transientReason(rec.why) ?? reopenReason(rec.why) : null;
    if (tr) {
      const kind = rec.strikes === 1 ? "strike" : "failed";
      const chars = rec.lvr.split("");
      const reset = (i) => { for (let j = i; j < 4; j += 1) if (chars[j] !== "n") chars[j] = "n"; };
      if (tr.level <= 2) reset(0);                                  // L1 and L2 are one pass: a reset of either asks both again
      else if (tr.level === 3) reset(2);
      const lvr = chars.join("");
      const { strikes, sl, why, ...rest } = rec;
      const base = { ...rest, lvr, lv: lvOf(lvr) };
      delete base.xw;
      if (tr.level === 6) { delete base.sp; delete base.spw; }
      if (tr.level <= 3) { delete base.big; delete base.d3; delete base.capBelow; delete base.l4w; delete base.l3w; }
      if (tr.level <= 2) for (const k of ["af", "afw", "fc", "br", "er", "nm", "cc", "sp"]) delete base[k];
      const keepsNothing = lvr === "nnnn" && base.sp === undefined && ["af", "nm", "cc", "br", "er", "fc"].every((k) => base[k] === undefined);
      cleared.push({ key, kind, shape: tr.shape, level: tr.level, removed: keepsNothing, ...(tr.reopen ? { reopen: true } : {}) });
      if (keepsNothing) continue;
      const t = classOf({ lvr, capBelow: base.capBelow, fc: base.fc });
      out[key] = { ...base, t, ok: t === "v" || t === "t" };
      continue;
    }
    if (rec.lvr?.includes("f") && rec.xw !== "gateway" && GATEWAY_WHY.test(rec.why ?? "")) { out[key] = { ...rec, xw: "gateway" }; tagged.push(key); continue; }
    // argument-fidelity reasons that came from the old content design (a path with an escape look-alike, an optional parameter left out) say nothing: the result is cleared, to be asked again
    if (rec.af === "f" && STALE_AFW.test(rec.afw ?? "")) { const { af, afw, ...rest } = rec; out[key] = rest; afReset.push(key); continue; }
    out[key] = rec;
  }
  return { store: out, cleared, tagged, afReset };
}

// ------------------------------------------------------------------ the one-line summary of a record

/**
 * Everything one record says, flat and ready to print or rank on: the class, the four-letter result, and each marker as `p` (passed), `f` (failed) or `n` (not run) so a caller never
 * has to know which are stored where; `notes` lists the things a bare class hides (forced-only, L3 implied by the big step, where L3 failed, a size cap, a pending strike).
 * `text` is the compact form: `pppp big+ sp+ af+ nm+ cc+ br+ er+` (+ passed, - failed, ? not run). Pure; the funnel may read `sp` and `af` from it later.
 */
export function summaryOf(rec) {
  if (!rec) return null;
  const m = (v) => (v === "p" || v === "f" ? v : "n");
  const out = { class: rec.t, lvr: rec.lvr, l4: m(rec.lvr[3] === "n" ? undefined : rec.lvr[3]), big: m(rec.big), sp: m(rec.sp), af: m(rec.af), nm: m(rec.nm), cc: m(rec.cc), br: m(rec.br), er: m(rec.er), fc: m(rec.fc), d3: rec.d3 ?? null, capBelow: rec.capBelow ?? 0, notes: [] };
  if (rec.af === "f" && rec.afw) out.notes.push(`argument fidelity failed: ${rec.afw}`);
  if (rec.l4w) out.notes.push(`parallel calls failed: ${rec.l4w}`);
  if (rec.l3w) out.notes.push(`L3 answer: ${rec.l3w}`);
  if (rec.spw) out.notes.push(`spawn failed: ${rec.spw}`);
  if (rec.fc === "p") out.notes.push("passed only when the tool call was forced: class t at best");
  if (rec.d3 === "i") out.notes.push("L3 passed by implication (the big step passed first)");
  if (rec.d3 === "a") out.notes.push("L3 failed at the constructs request (3a), before the 157 KB request");
  if (rec.d3 === "b") out.notes.push("L3 failed at the 157 KB request (3b)");
  if (rec.capBelow) out.notes.push(`refuses requests of about ${rec.capBelow} bytes and more`);
  if (rec.strikes === 1) out.notes.push(`failed once at L${rec.sl}: asked again`);
  const sym = (v) => (v === "p" ? "+" : v === "f" ? "-" : "?");
  out.text = `${rec.lvr} big${sym(out.big)} sp${sym(out.sp)} af${sym(out.af)} nm${sym(out.nm)} cc${sym(out.cc)} br${sym(out.br)} er${sym(out.er)}`;
  return out;
}

// ------------------------------------------------------------------ inheritance marks (data only)

/** The default identity of a model across providers: the last path segment of the id, lowercased, without a tier suffix. Callers may pass their own. */
export const defaultIdentity = (key) => {
  const id = key.slice(key.indexOf("/") + 1);
  return id.split("/").pop().toLowerCase().replace(/\[1m\]$/, "").replace(/[:-](free|beta|nitro|exacto|extended|thinking)$/, "");
};

/**
 * What the records of OTHER providers say about a model that has none of its own. DATA ONLY: nothing here is read by the compiler or the picker, and a
 * pass NEVER propagates as a pass. `catalog` is `{identityOf?(key), toolsClaim?(key), resellers?: [provider]}`: the same model under another provider is
 * found by `identityOf` (default: `defaultIdentity`); with `resellers`, only those providers' keys get a mark.
 *   a CONFIRMED failure at another provider  ->  {kind: "likely-x", from}            (the model behind it probably cannot take the tool set)
 *   an L3 pass at another provider           ->  {kind: "upper-bound", level: 3, from}  (it could be at most that good; shown as `~3`)
 *   nothing from others, catalogue says tools -> {kind: "claim-only", prior: "c"}    (a prior only, never eligibility)
 * A failure wins over a pass when both exist (`conflict: true`). A model with its own confirmed result gets null: its own evidence is the only evidence.
 */
export function inherited(modelKey, store, catalog = {}) {
  const own = store[modelKey];
  if (own && own.lvr[0] !== "n" && own.strikes !== 1) return null;
  const identityOf = catalog.identityOf ?? defaultIdentity;
  const provider = (k) => k.slice(0, k.indexOf("/"));
  if (catalog.resellers && !catalog.resellers.includes(provider(modelKey))) return null;
  const id = identityOf(modelKey);
  const claim = catalog.toolsClaim?.(modelKey) === true ? "c" : null;
  let fail = null, pass = null;
  for (const [k, r] of Object.entries(store)) {
    if (k === modelKey || provider(k) === provider(modelKey) || identityOf(k) !== id) continue;
    if (r.strikes === 1 || r.lvr[0] === "n" || r.alias) continue;
    if (r.t === "x" && !fail) fail = k;
    else if (r.lvr[2] === "p" && !pass) pass = k;
  }
  if (fail) return { kind: "likely-x", from: fail, ...(pass ? { conflict: true } : {}), ...(claim ? { prior: claim } : {}) };
  if (pass) return { kind: "upper-bound", level: 3, from: pass, ...(claim ? { prior: claim } : {}) };
  return claim ? { kind: "claim-only", prior: claim } : null;
}

// ------------------------------------------------------------------ the flip diff (owner step: tighten `unverified`)

/**
 * What flipping `unverified` would do, from two compiled results of the same inputs (the current setting and the proposed one;
 * `funnel(...).models` is `[{s: "provider/id", ...}]`). Pure: it prints nothing and applies nothing.
 */
export function flipDiff(before, after, { to = null } = {}) {
  const had = new Set(before.map((m) => m.s)), has = new Set(after.map((m) => m.s));
  const removed = [...had].filter((s) => !has.has(s)).sort();
  const provOf = (s) => s.slice(0, s.indexOf("/"));
  const count = (ids) => { const c = new Map(); for (const s of ids) c.set(provOf(s), (c.get(provOf(s)) ?? 0) + 1); return c; };
  const was = count(had), now = count(has);
  const emptied = [...was.keys()].filter((p) => !now.has(p)).sort();
  const thinned = [...was.keys()].filter((p) => now.has(p) && now.get(p) < was.get(p)).sort();
  const text = `${to ? `unverified -> ${to}: ` : ""}this removes ${removed.length} of ${had.size} model(s)` +
    `${emptied.length ? ` and empties ${emptied.length} provider(s): ${emptied.join(", ")}` : " and empties no provider"}` +
    `${thinned.length ? `; ${thinned.length} more provider(s) keep fewer models` : ""}`;
  return { removed, remaining: has.size, before: had.size, emptied, thinned, text };
}

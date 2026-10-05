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
//   afw, l4w  what differed when argument fidelity (af) or the parallel-call check (L4) failed: a few printable words, at most 60 characters ("old_string: newline lost", "1 call of 2"). Never a verdict; cleared by a later pass
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
import { kindSize, kindsOf, BUDGETS, PROBE_MAX_TOKENS, LIFTS, deepAllowed, NOT_FREE_REASON, accountOrRoute, GATEWAY_WORDS, isAvailabilityText } from "./tool-fidelity-probe.mjs";
export { NOT_FREE_REASON };
import { FIXTURE_ID } from "./tool-fidelity-fixture.mjs";

export const FILE_NAME = "tool-fidelity.json";
export const REAL_FILE = path.join(os.homedir(), ".uw", "state", FILE_NAME);
export const SCHEMA = 1;
export const KIND = "tool-fidelity";
export const MAX_FILE_BYTES = 1024 * 1024;           // the size of the file AS WRITTEN: about 7,000 records of about 140 bytes
export const MAX_READ_BYTES = 4 * 1024 * 1024;       // a file bigger than this is refused on read, never parsed
export const DEFAULT_TOKENS_PER_PROVIDER = 150000;   // input tokens per provider per invocation (the first free-tier pass)
export const DEFAULT_LEVELS = Object.freeze([1, 2]);
export const BIG_LEVEL = 5;                          // the ~400 KB step, a level of its own that is not part of lvr

const LVR_RE = /^[pfn]{4}$/;
const FX_RE = /^[A-Za-z0-9._-]{1,40}$/;
const FIELDS = new Set(["lv", "lvr", "t", "ok", "why", "at", "fx", "maxBytes", "alias", "big", "capBelow", "strikes", "sl", "fc", "af", "nm", "cc", "br", "er", "sp", "d3", "afw", "l4w", "xw"]);
const NOTE_FIELDS = ["afw", "l4w"];                                      // short reasons of non-blocking marker failures (printable ASCII, at most 60 characters): what differed, never a verdict
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
  } catch (e) { return e?.code === "ENOENT" ? { ok: true, absent: true, models: {}, rejected: {}, pending: {}, generatedAt: null, dropped: 0 } : { ok: false, reason: "unreadable" }; }
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
  return { ok: true, models, rejected, pending: cleanPending(raw.pending), generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null, dropped };
}

// ------------------------------------------------------------------ writing

/**
 * The PENDING map: for a model that was in a run's queue and ended it still untested, why, and in how many runs in a row. It is bookkeeping for the
 * coverage ledger (a model that waits for many runs is starving), not a result: it is dropped as soon as the model has one. `r` is a short reason code
 * (rate, pay, auth, timeout, error, gone, empty, reasoning-budget, request-cap, priced-over-row-cap, slow, route-shape, upstream-unavailable, cap, spend, row-cost, not-run), `n` the runs, `at` the last one.
 */
export const PENDING_MAX = 5000;
export function cleanPending(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!keyOk(k) || !v || typeof v !== "object") continue;
    if (typeof v.r !== "string" || !/^[a-z0-9-]{1,24}$/.test(v.r) || !Number.isInteger(v.n) || v.n < 1 || v.n > 9999) continue;
    if (typeof v.at !== "string" || !Number.isFinite(Date.parse(v.at))) continue;
    out[k] = { r: v.r, n: v.n, at: v.at };
    if (Object.keys(out).length >= PENDING_MAX) break;
  }
  return out;
}
const pendingText = (pending) => (pending && Object.keys(pending).length ? `"pending":${JSON.stringify(pending)},` : "");
const head = (now, pending) => `{"schema":${SCHEMA},"kind":${JSON.stringify(KIND)},"generatedAt":${JSON.stringify(now.toISOString())},${pendingText(pending)}"models":{`;
const lineOf = (k, v) => `${JSON.stringify(k)}:${JSON.stringify(v)}`;
/** The file text: one record per line. The size cap is measured on exactly this string. */
export function renderFile(entries, now = new Date(), pending = null) {
  const lines = entries.map(([k, v]) => lineOf(k, v));
  return `${head(now, pending)}${lines.length ? `\n${lines.join(",\n")}\n` : ""}}}\n`;
}
const bytesOf = (sizes, now, pending) => Buffer.byteLength(head(now, pending)) + (sizes.length ? 2 + sizes.reduce((a, b) => a + b, 0) + 2 * (sizes.length - 1) : 0) + 3;

/**
 * Capacity, not expiry: when the FILE AS WRITTEN would pass `maxBytes`, records of models that have left the catalogue go first, then the oldest;
 * records this reader did not understand (`preserve`) go last of all. Returns the kept `models` and `preserve` and the `dropped` keys.
 */
export function capRecords(models, { keep = null, maxBytes = MAX_FILE_BYTES, preserve = {}, now = new Date(), pending = null } = {}) {
  const all = [...Object.entries(models).map(([k, v]) => ({ k, v, own: true })), ...Object.entries(preserve).filter(([k]) => !(k in models)).map(([k, v]) => ({ k, v, own: false }))];
  const size = new Map(all.map((e) => [e.k, Buffer.byteLength(lineOf(e.k, e.v))]));
  let total = bytesOf([...size.values()], now, pending);
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
           preserve: Object.fromEntries(all.filter((e) => !e.own && !dropped.has(e.k)).map((e) => [e.k, e.v])), dropped: [...dropped] };
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
export function saveFidelity(file, models, { live = false, now = new Date(), keep = null, retries = 5, retryMs = 40, writeImpl = writeAtomic, realFile = REAL_FILE, preserve = {}, pending = {} } = {}) {
  const target = path.resolve(file);
  if (path.basename(target) !== FILE_NAME) throw new Error(`refused: the tool-fidelity writer only writes a file named ${FILE_NAME}, not ${path.basename(target)}`);
  if (canon(target) === canon(realFile) && !live) throw new Error("refused: the real state file is written only by a --live run");
  const cur = loadFidelity(target);
  if (!cur.ok) throw new Error(`refused: ${target} exists and is not a tool-fidelity file (${cur.reason}); it is not overwritten`);
  const good = Object.fromEntries(Object.entries(models).filter(([k]) => keyOk(k)));
  const keepRaw = Object.fromEntries(Object.entries(preserve).filter(([k]) => keyOk(k) && !(k in good)));
  const pend = cleanPending(pending);
  const capped = capRecords(good, { keep, preserve: keepRaw, now, pending: pend });
  const entries = [...Object.entries(capped.models), ...Object.entries(capped.preserve)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const text = renderFile(entries, now, pend);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (let i = 0; ; i++) {
    try { writeImpl(target, text); break; }
    catch (e) { if (i >= retries || !/^(EPERM|EBUSY|EACCES)$/.test(e?.code ?? "")) throw e; wait(retryMs * (i + 1)); }
  }
  return { records: entries.length, preserved: Object.keys(capped.preserve).length, dropped: capped.dropped, bytes: Buffer.byteLength(text) };
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
  const keep = { ...Object.fromEntries(PF_FIELDS.map((k) => [k, prior?.[k]])), d3: prior?.d3, afw: prior?.afw, l4w: prior?.l4w };
  const m = { ...keep };
  if (!provisional) {
    if (ran(1)) { m.af = done[1].af; m.fc = done[1].fc; m.afw = m.af === "f" && noteOk(done[1].afw) ? done[1].afw : undefined; }
    if (ran(4)) m.l4w = done[4].v === "f" && noteOk(done[4].w) ? done[4].w : undefined;
    if (ran(2)) m.br = done[2].br;
    if (ran(7)) m.er = done[7].v;
    for (const l of [3, BIG_LEVEL]) { if (ran(l) && done[l].nm) m.nm = done[l].nm; if (ran(l) && done[l].cc) m.cc = done[l].cc; }
    if (ran(3)) m.d3 = done[3].v === "f" ? (String(done[3].why ?? "").startsWith("[3a]") ? "a" : "b") : done[3].implied ? "i" : undefined;
    if (ran(6)) {
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
  const prov = new Set(only.filter((o) => !o.includes("/"))), keys = new Set(only.filter((o) => o.includes("/")).map((o) => benchKey(...splitKey(o))));
  return entries.filter((e) => prov.has(e.provider) || keys.has(e.key));
}
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
export function restrictToFree(set, tiers, lift = null) {
  const byTier = {}, notFree = [], models = [];
  for (const e of set.models) {
    const tier = isTier(tiers?.[e.provider]) ? tiers[e.provider] : null;
    byTier[tier ?? "unlabelled"] = (byTier[tier ?? "unlabelled"] ?? 0) + 1;
    if (deepAllowed(tier, lift)) models.push(e); else notFree.push({ key: e.key, provider: e.provider, tier });
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
  const entries = [], excluded = [];
  set.models.forEach((e, order) => {
    const tier = tiers?.[e.provider];
    const pinIdx = pinList.indexOf(e.key);
    {                                                                                // the tier rule holds for a pin too: only free-labelled providers are probed at all
      if (!isTier(tier) || !allowed.has(tier)) { excluded.push({ key: e.key, reason: tier === "subscription" ? TIER_EXCLUSION.subscription : NOT_FREE_REASON, tier: isTier(tier) ? tier : null }); return; }
    }
    if (pinIdx < 0 && e.ctx > 0 && e.ctx < need) { excluded.push({ key: e.key, reason: "ctx-too-small-for-fixture" }); return; }
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
  return { entries, excluded, floor, pinned: pinList.filter((p) => !byKey.has(p)) };
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
export function assertPartition(universe, { tested, pending, excluded }) {
  const keys = universe.map((u) => u.key);
  if (new Set(keys).size !== keys.length) throw new Error("coverage: a model appears twice in the universe");
  const seen = new Map();
  for (const [state, list] of [["tested", tested], ["pending", pending], ["excluded", excluded]]) {
    for (const e of list) {
      if (seen.has(e.key)) throw new Error(`coverage: ${e.key} is in two states (${seen.get(e.key)} and ${state})`);
      seen.set(e.key, state);
    }
  }
  const missing = keys.filter((k) => !seen.has(k));
  if (missing.length) throw new Error(`coverage: ${missing.length} model(s) are in no state, first ${missing[0]}`);
  const extra = [...seen.keys()].filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`coverage: ${extra[0]} is in a state but not in the universe`);
  if (tested.length + pending.length + excluded.length !== keys.length) throw new Error("coverage: the three states do not add up to the universe");
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
export function coverage(universe, store, { level = "l12", pending = {}, plan = {}, fixtureId = FIXTURE_ID, stuckRuns = 3, listCap = 10, deepOk = () => true } = {}) {
  const tested = [], waiting = [], excluded = [], provisional = [], stuck = [], outdated = [];
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
        if (r.lvr[2] === "p" && r.lvr[3] === "n") optional.l4 += 1;
        if (r.lvr[2] === "p" && r.big === undefined) optional.big += 1;
        if (r.sp === undefined) optional.sp += 1;
        if (r.er === undefined) optional.er += 1;
      }
      if (r.fx !== fixtureId) outdated.push({ key: u.key, fx: r.fx });
      continue;
    }
    const p = pending[u.key];
    waiting.push({ key: u.key, reason: strike ? "first-strike" : plan[u.key] ?? p?.r ?? "not-run", runs: p?.n ?? 0 });
    if (p && p.n >= stuckRuns) stuck.push({ key: u.key, reason: p.r, runs: p.n });
  }
  assertPartition(universe, { tested, pending: waiting, excluded });
  const tally = (list, f) => { const o = {}; for (const e of list) o[f(e)] = (o[f(e)] ?? 0) + 1; return o; };
  const cap = (l) => ({ n: l.length, list: l.slice(0, listCap) });
  return {
    level, total: universe.length, tested, pending: waiting, excluded,
    counts: { total: universe.length, tested: tested.length, pending: waiting.length, excluded: excluded.length,
              byTier: tally(tested, (e) => e.tier), byPending: tally(waiting, (e) => e.reason), byExcluded: tally(excluded, (e) => e.reason) },
    provisional: cap(provisional), stuck: cap(stuck), outdated: cap(outdated), optional,
  };
}

/** The ledger as printed lines (dry run and sweep report); every figure names its denominator. */
export function coverageLines(cov, label) {
  const c = cov.counts, fmt = (o) => Object.entries(o).sort(([, a], [, b]) => b - a).map(([k, n]) => `${k} ${n}`).join(", ") || "none";
  const L = [`coverage ${label}: ${c.total} model(s) = tested ${c.tested} (${fmt(c.byTier)}) + pending ${c.pending} (${fmt(c.byPending)}) + excluded ${c.excluded} (${fmt(c.byExcluded)})`];
  const list = (name, l, f) => { if (l.n) L.push(`  ${name} ${l.n} of ${c.total}: ${l.list.map(f).join(", ")}${l.n > l.list.length ? `, and ${l.n - l.list.length} more` : ""}`); };
  list("failed once (provisional, asked again, not yet x)", cov.provisional, (e) => `${e.key} L${e.level}`);
  list("pending too long", cov.stuck, (e) => `${e.key} ${e.reason} x${e.runs}`);
  list("against an older fixture (*, re-sweep recommended)", cov.outdated, (e) => `${e.key} ${e.fx}`);
  const opt = Object.entries(cov.optional ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${k === "l4" ? "L4" : k === "sp" ? "spawn" : k === "er" ? "error-result" : k} ${n}`);
  if (opt.length) L.push(`  optional levels not run yet among the ${c.tested} tested (they do not block being tested): ${opt.join(", ")}`);
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
export function updatePending(pending, { queue, recorded, store, reasonOf, now = new Date(), keepKeys = null }) {
  const out = { ...pending };
  if (keepKeys) for (const k of Object.keys(out)) if (!keepKeys.has(k)) delete out[k];             // a model that has left the probe set is not pending
  for (const e of queue) {
    const r = store[e.key];
    if (recorded.has(e.key) || r?.strikes === 1) { delete out[e.key]; continue; }
    const code = String(reasonOf(e.key) ?? "not-run").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 24) || "not-run";
    out[e.key] = { r: code, n: Math.min(9999, (out[e.key]?.n ?? 0) + 1), at: now.toISOString() };
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
const NAMED_FOR_MIGRATION = /thought_signature|empty content|assistant messages?|schema|tools?\b|function|parameter|argument|format|propert|field|required|json|enum|anyof|oneof|\$ref|tool_choice|input|type\b|unsupported|not supported|invalid|malformed|validation|too (large|big|long)|context|token/i;
/** Why a stored reason is an availability (or an unnamed 400) and not a verdict about the model, or null: `{level, shape}`. */
export function transientReason(why) {
  const m = typeof why === "string" ? REFUSAL_WHY.exec(why) : null;
  if (!m) return null;
  const msg = extractMsg(m[3]);
  if (isAvailabilityText(m[3])) return { level: Number(m[1]), shape: transientShape(msg) ?? "availability" };
  if (m[2] === "400" && m[1] !== "5" && !NAMED_FOR_MIGRATION.test(msg)) return { level: Number(m[1]), shape: transientShape(msg) ?? "unnamed 400" };
  return null;
}
const extractMsg = (body) => { let t = String(body ?? ""); try { const j = JSON.parse(t); const c = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : null); if (typeof c === "string") t = c; } catch { /* as is */ } return t.replace(/\s+/g, " ").trim(); };
/**
 * Clears the records whose reason is an availability or unnamed 400 (never a verdict; an `x` or a strike that those texts produced) and tags the gateway-translation failures with `xw: gateway`.
 * The failed level is reset to untested; a record with nothing else known is removed (asked again from scratch). Also clears `af`/`afw` whose reason came from the old content design (`afReset`). Pure: `{store, cleared: [{key, kind, shape, level, removed}], tagged: [key], afReset: [key]}`.
 */
export const STALE_AFW = /^(file_path: (newline|backslash)|replace_all: missing|start_line: missing)/;
export function migrateTransient(store) {
  const out = {}, cleared = [], tagged = [], afReset = [];
  for (const [key, rec] of Object.entries(store ?? {})) {
    if (!rec) { out[key] = rec; continue; }
    const tr = rec.lvr?.includes("f") || rec.strikes !== undefined ? transientReason(rec.why) : null;
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
      if (tr.level === 6) delete base.sp;
      if (tr.level <= 3) { delete base.big; delete base.d3; delete base.capBelow; delete base.l4w; }
      if (tr.level <= 2) for (const k of ["af", "afw", "fc", "br", "er", "nm", "cc", "sp"]) delete base[k];
      const keepsNothing = lvr === "nnnn" && base.sp === undefined && ["af", "nm", "cc", "br", "er", "fc"].every((k) => base[k] === undefined);
      cleared.push({ key, kind, shape: tr.shape, level: tr.level, removed: keepsNothing });
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

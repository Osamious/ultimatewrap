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
// Compiler reads `t`, `alias`, `capBelow`, `big` and `lvr[3]` (L4): inside class v a model ranks big p, then big not run, then big f, and
// then L4 p, not run, f. The picker cell grammar still comes from lvr; a confirmed L3 failure that is not about size shows `x`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAtomic } from "../menu/atomic.mjs";
import { redactClip } from "../menu/redact.mjs";
import { benchKey } from "../menu/bench-data.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";
import { SUBSTITUTE_FLOOR } from "../menu/subagent-funnel.mjs";
import { isFree, UNPRICED_PER_M } from "./bench.mjs";
import { levelSize, PROBE_MAX_TOKENS } from "./tool-fidelity-probe.mjs";
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
const FIELDS = new Set(["lv", "lvr", "t", "ok", "why", "at", "fx", "maxBytes", "alias", "big", "capBelow", "strikes", "sl"]);
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
  if (k >= 3) return "v";
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
  const { lvr, lv, t, ok, why, at, fx, maxBytes, alias, big, capBelow, strikes, sl } = raw;
  if (typeof lvr !== "string" || !LVR_RE.test(lvr)) return null;
  if (typeof at !== "string" || at.length > 40 || !Number.isFinite(Date.parse(at))) return null;
  if (typeof fx !== "string" || !FX_RE.test(fx)) return null;
  if (!Number.isInteger(maxBytes) || maxBytes < 0 || maxBytes > 4_000_000) return null;
  if (alias !== undefined && typeof alias !== "boolean") return null;
  if (why !== undefined && (typeof why !== "string" || why.length > 400)) return null;
  if (big !== undefined && !/^[pfn]$/.test(big)) return null;
  if (capBelow !== undefined && !(Number.isInteger(capBelow) && capBelow >= 1 && capBelow <= 4_000_000)) return null;
  if ((strikes === undefined) !== (sl === undefined)) return null;
  if (strikes !== undefined && !((strikes === 1 || strikes === 2) && Number.isInteger(sl) && sl >= 1 && sl <= 3)) return null;
  const d = classOf({ lvr, strikes, sl, capBelow });
  if (lv !== lvOf(lvr) || t !== d || ok !== (d === "v" || d === "t")) return null;
  const w = why ? redactClip(why, WHY_CHARS) : "";
  return { lv, lvr, t, ok, ...(w ? { why: w } : {}), at, fx, maxBytes, ...(alias ? { alias: true } : {}),
           ...(big === "p" || big === "f" ? { big } : {}), ...(capBelow ? { capBelow } : {}), ...(strikes ? { strikes, sl } : {}) };
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
 * (rate, pay, auth, timeout, error, gone, empty, cap, spend, row-cost, not-run), `n` the runs, `at` the last one.
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
 * The record after a probe, or null when no level actually ran (nothing to record). `done` maps a level (1-4, and 5 for the big step) to
 * `{v: "p"|"f"|"n", why?, kind?: "size"|"schema", bytes?}`; `n` means asked but not run. Levels that ran replace their character of
 * lvr; the rest keep the prior result. TWO STRIKES: a failure at L1, L2 or L3 (L3 only when it is not about size) is provisional the
 * first time (see the header); a size refusal at L3 or at the big step lowers `capBelow` instead of failing the model.
 */
export function buildRecord(prior, done, { now = new Date(), fixtureId = FIXTURE_ID, alias = false } = {}) {
  const verdict = (l) => done[l]?.v === "p" || done[l]?.v === "f";
  const l3Passed = done[3]?.v ? done[3].v === "p" : prior?.lvr?.[2] === "p";
  const ran = (l) => verdict(l) && (l !== BIG_LEVEL || l3Passed);          // the big step means something only behind an L3 pass
  if (![1, 2, 3, 4, BIG_LEVEL].some(ran)) return null;
  const base = prior?.lvr ?? "nnnn";
  const next = base.split("");
  for (let l = 1; l <= 4; l++) if (done[l]?.v) next[l - 1] = done[l].v;
  const strikeable = (l) => done[l]?.v === "f" && !(l === 3 && done[l].kind === "size");
  const F = [1, 2, 3].find(strikeable) ?? 0;
  let lvr = next.join(""), strikes, sl;
  if (F) {
    const confirmed = !!prior && (prior.strikes === 2 || (prior.strikes === 1 && prior.sl === F));
    if (confirmed) { strikes = 2; sl = F; }
    else {
      // first strike: the earlier result stands. Only levels above the failed one (and above the L1+L2 pair) keep what they learned.
      const keepBase = base.split("");
      for (let l = Math.max(F, 2) + 1; l <= 4; l++) if (done[l]?.v) keepBase[l - 1] = done[l].v;
      lvr = keepBase.join(""); strikes = 1; sl = F;
    }
  } else if (prior?.strikes === 1 && !ran(prior.sl)) { strikes = 1; sl = prior.sl; }       // this probe did not look at the struck level: the strike waits

  let capBelow = prior?.capBelow;
  for (const l of [3, BIG_LEVEL]) if (ran(l) && done[l].v === "f" && done[l].kind === "size") capBelow = Math.min(capBelow ?? Infinity, capBelowFor(done[l].bytes ?? 0));
  const passedBytes = Math.max(0, ...[3, 4, BIG_LEVEL].filter((l) => ran(l) && done[l].v === "p").map((l) => done[l].bytes ?? 0));
  if (capBelow && passedBytes > capBelow) capBelow = undefined;           // a pass beyond the recorded refusal contradicts it
  let big = prior?.big;
  if (ran(BIG_LEVEL)) big = done[BIG_LEVEL].v;
  if (lvr[2] !== "p") big = undefined;                                    // the big step is only meaningful after an L3 pass

  const t = classOf({ lvr, strikes, sl, capBelow });
  // the reason shown: the failed level of this probe's strike, else the first failed level of the record (this probe's words, or the stored ones)
  let why = "";
  if (F) why = `L${F}: ${done[F].why ?? ""}`;
  else if (lvr.includes("f")) { const f = lvr.indexOf("f") + 1; why = done[f]?.why ? `L${f}: ${done[f].why}` : prior?.lvr?.[f - 1] === "f" ? prior.why ?? "" : ""; }
  else if (big === "f" && done[BIG_LEVEL]?.why) why = `L5: ${done[BIG_LEVEL].why}`;
  const hadBig = prior && (prior.lvr[2] !== "n" || prior.lvr[3] !== "n");
  return {
    lv: lvOf(lvr), lvr, t, ok: t === "v" || t === "t",
    ...(why ? { why: redactClip(why, WHY_CHARS) } : {}),
    at: now.toISOString(), fx: ran(3) || ran(4) || !hadBig ? fixtureId : prior.fx,
    maxBytes: Math.max(prior?.maxBytes ?? 0, passedBytes),
    ...(alias ? { alias: true } : {}),
    ...(big === "p" || big === "f" ? { big } : {}), ...(capBelow ? { capBelow } : {}), ...(strikes ? { strikes, sl } : {}),
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
                   ...(f >= 0 && r.why?.startsWith(`L${f + 1}:`) ? { why: r.why } : {}) };
    next.t = classOf({ lvr, strikes: next.strikes, sl: next.sl });
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
  return { probeOk: n + set.relay.length, relay: set.relay.length, probeSet: n, withRecord, withRecordCurrent: current,
           outdated: withRecord - current, pending: set.models.filter((m) => isProvisional(store[m.key])).length,
           toolsFalse: set.models.filter((m) => m.toolsFalse).length, toolsFalseWithRecord: set.models.filter((m) => m.toolsFalse && has(m)).length,
           ctxUnknown: set.models.filter((m) => !(m.ctx > 0)).length, badId: set.badId ?? 0, queued: n - withRecord };
}

/** The levels a confirmed failure would be asked again at, never one that passed: the L1/L2 pair members that are not `p`, and L3 after a confirmed L3 failure. */
export const failedLevels = (rec) => [...[1, 2].filter((l) => rec.lvr[l - 1] !== "p"), ...(rec.lvr[2] === "f" ? [3] : [])];

/**
 * Which levels each model still needs. Without `force` a model is asked only for what it has NO result for, so a model with a record is never
 * re-probed at a level it already answered, and a record against an outdated fixture is NOT queued again (its `*` is a recommendation, not an
 * expiry). L1 and L2 are one pass: a record that ran anything answered both, except a model with ONE strike, which is asked the struck level
 * again. L3 and L4 are asked only of a model that passed L1 and L2 (or, for a model never tested, together with them), while their character is
 * `n`; the big step only of a model that passed L3 and has no big result. `force` asks every requested level again (still never past a failure
 * the ladder would stop at). `retryFailed` asks again ONLY the models of class x, and only the levels that failed: a record that passed is never touched.
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
      if (l === 4) return okToAsk && (force || !prior || prior.lvr[3] === "n");
      // the big step: after an L3 pass, or in the same run as the L3 that is being asked (the ladder stops it if L3 does not pass)
      return askL3 || (confirmed && prior.lvr[2] === "p" && (force || prior.big === undefined));
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

/**
 * Cost of what each entry still has to run, in requests, input tokens and dollars, BEFORE anything is sent. Input tokens come from the real
 * request bytes of each level (bytes / 4); output tokens are the probe maximum per request. `lc` is the dollar cost of each level, so a
 * probe that stops part way can be charged for the levels it did complete. `fallback` is `paidFallback(whole set)`.
 */
export function estimate(entries, { maxTokens = PROBE_MAX_TOKENS, fallback = null } = {}) {
  const sizes = Object.fromEntries([1, 2, 3, 4, 5].map((l) => [l, levelSize(l, maxTokens)]));
  const fb = fallback ?? paidFallback(entries);
  const per = new Map();
  let requests = 0, inTokens = 0, outTokens = 0, usd = 0, paidModels = 0;
  const rated = entries.map((e) => {
    const reqs = e.todo.length, tin = e.todo.reduce((s, l) => s + sizes[l].inTokens, 0), tout = reqs * maxTokens;
    const price = e.free ? { in: 0, out: 0 } : { in: e.pin ?? fb.in, out: e.pout ?? fb.out };
    const lc = Object.fromEntries(e.todo.map((l) => [l, (sizes[l].inTokens * price.in + maxTokens * price.out) / 1e6]));
    const cost = Object.values(lc).reduce((a, b) => a + b, 0);
    requests += reqs; inTokens += tin; outTokens += tout; usd += cost; if (!e.free) paidModels += 1;
    const p = per.get(e.provider) ?? { provider: e.provider, models: 0, requests: 0, inTokens: 0, usd: 0, free: 0 };
    p.models += 1; p.requests += reqs; p.inTokens += tin; p.usd += cost; if (e.free) p.free += 1;
    per.set(e.provider, p);
    return { ...e, reqs, tin, cost, lc };
  });
  return { entries: rated, requests, inTokens, outTokens, usd, paidModels, perProvider: [...per.values()].sort((a, b) => b.models - a.models || (a.provider < b.provider ? -1 : 1)), sizes };
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

// ------------------------------------------------------------------ candidates: the models the router could ever pick

/** Reads a compiled policy file (`state/subagent/policy.json`, or a fixture of the same shape): `{models: [{s, c, ...}]}`, best first. Null when it is not one. */
export function loadPolicy(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    return raw && Array.isArray(raw.models) && raw.models.every((m) => m && typeof m.s === "string") ? raw : null;
  } catch { return null; }
}
export const POLICY_FILE = path.join(os.homedir(), ".uw", "state", "subagent", "policy.json");

/**
 * The models the L3 step targets: every probe-ok model the router could ever pick, which is the compiled policy's ALLOWED set (`policy.models`) with a
 * KNOWN context of at least `floor` (the substitute floor: a smaller or unknown context is never substituted), plus the owner's pins (`pins`, selectors
 * the owner allowed by hand; a pin needs no ctx and no place in the toggles, only a probe-ok model). It is NOT the top 3 of each provider: that is
 * the router's spread, not a test boundary. ORDER: the pins, then the policy's own rank, best first, so a capped run covers the likeliest picks first
 * and the untested tail waits for the next run. `set` is `probeSet(...)`. Returns `{entries, excluded}`: `entries` are probe-set entries in that order;
 * `excluded` is every other model of the L3 universe with its reason: ctx-below-floor, ctx-unknown, outside-toggles (probe-ok but not in the allowed
 * set), relay-by-provenance.
 */
export function selectCandidates({ set, policy, pins = [], floor = SUBSTITUTE_FLOOR }) {
  const rows = new Map((policy?.models ?? []).map((m) => [m.s, m]));
  const byKey = new Map(set.models.map((e) => [e.key, e]));
  const pinSet = new Set(pins.map((p) => benchKey(...splitKey(p))));
  const entries = [], taken = new Set(), excluded = [];
  for (const p of pinSet) if (byKey.has(p) && !taken.has(p)) { entries.push({ ...byKey.get(p), pinned: true }); taken.add(p); }
  for (const m of policy?.models ?? []) {
    const e = byKey.get(m.s);
    if (!e || taken.has(m.s)) continue;
    if (Number.isFinite(m.c) && m.c >= floor) { entries.push(e); taken.add(m.s); }
  }
  for (const e of set.models) {
    if (taken.has(e.key)) continue;
    const row = rows.get(e.key);
    excluded.push({ key: e.key, reason: !row ? "outside-toggles" : !(row.c > 0) ? "ctx-unknown" : "ctx-below-floor" });
  }
  for (const k of set.relay) excluded.push({ key: k, reason: "relay-by-provenance" });
  return { entries, excluded, floor, pinned: [...pinSet].filter((p) => !byKey.has(p)) };
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
export function coverage(universe, store, { level = "l12", pending = {}, plan = {}, fixtureId = FIXTURE_ID, stuckRuns = 3, listCap = 10 } = {}) {
  const tested = [], waiting = [], excluded = [], provisional = [], stuck = [], outdated = [];
  for (const u of universe) {
    if (u.excluded) { excluded.push({ key: u.key, reason: u.excluded }); continue; }
    const r = store[u.key] ?? null;
    const strike = r && r.strikes === 1 ? r.sl : 0;
    const confirmedFail = !!r && r.lvr[0] !== "n" && r.t === "x" && !strike;
    const done = !!r && (level === "l12" ? r.lvr[0] !== "n" : r.lvr[2] === "p" || r.lvr[2] === "f" || confirmedFail);
    if (strike) provisional.push({ key: u.key, level: strike, why: r.why ?? "" });
    if (done) {
      tested.push({ key: u.key, tier: compiledClass(r), evidence: `${r.lvr}${r.big ? ` big ${r.big}` : ""}${r.capBelow ? ` cap<${r.capBelow}` : ""}` });
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
    provisional: cap(provisional), stuck: cap(stuck), outdated: cap(outdated),
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
  return L;
}

/** The two universes of the ledger: every listed model for L1+L2 (the not probe-ok, the invalid ids and the relay are excluded with their reason), and the L3 candidates with theirs. */
export function ledgerUniverses({ set, cand = null }) {
  const l12 = [...set.models.map((e) => ({ key: e.key })), ...set.relay.map((k) => ({ key: k, excluded: "relay-by-provenance" })),
    ...(set.notOkKeys ?? []).map((k) => ({ key: k, excluded: "not-probe-ok" })), ...(set.badKeys ?? []).map((k) => ({ key: k, excluded: "invalid-id" }))];
  const l3 = cand ? [...cand.entries.map((e) => ({ key: e.key })), ...cand.excluded.map((e) => ({ key: e.key, excluded: e.reason }))] : null;
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

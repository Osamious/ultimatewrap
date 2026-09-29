// Per-model benchmark data: the closed status vocabulary, the record shape, the
// key function, the cell formatters, and the reader the picker uses (#114).
//
// THIS FILE IS IN THE PICKER'S IMPORT GRAPH, so it imports only fs, `atomic.mjs`
// and `sanitize.mjs`. The engine that produces the data (`refresh/bench.mjs`)
// imports FROM here, never the other way: the picker must not be able to reach
// a fetch, exactly as it must not reach one for routability (test/uwpick.test.mjs
// pins that).
//
// WHY A FILE OF ITS OWN AND NOT SNAPSHOT FIELDS. `snapshot.json` is already
// 1.39 MB for ~6,000 models and is parsed on every picker launch; four more
// numbers per model would tax every launch to serve a view most launches never
// open. And a field in the snapshot is rewritten by every `--build`, which is how
// `menu/snapshot.mjs` came to throw a whole probe sweep away once (the `limit`
// field, recorded there). Bench data has its own lifecycle and is read once, lazily,
// the first time a model list is drawn (never at startup).

import path from "node:path";
import os from "node:os";
import { readJsonOr } from "./atomic.mjs";
import { sanitizeDisplay, sanitizeCells } from "./sanitize.mjs";
import { redactClip } from "./redact.mjs";

const STATE_DIR = path.join(os.homedir(), ".uw", "state");
export const BENCH_FILE = path.join(STATE_DIR, "bench.json");
export const BENCH_LOG = path.join(STATE_DIR, "bench.jsonl");
export const BENCH_SCHEMA = 1;

// The request every probe sends. LLMtest's default prompt, verbatim, so numbers
// are comparable in kind; a long prompt would measure prefill instead of speed.
export const BENCH_PROMPT = "Say hello in 5 words.";
// Enough for a non-reasoning model to finish and for a reasoning model to reach
// its first content, small enough that a 6,000-row sweep stays cheap.
export const BENCH_MAX_TOKENS = 96;
// How much of a reply (or of a non-ok provider sentence) is STORED as the preview `p`. Records written before this
// was raised keep their 40-character previews until they are re-probed.
export const PREVIEW_CHARS = 120;
// The provider's own words for a non-ok result, kept for the post-sweep study and
// never rendered by the picker (`p` is the preview: the head of the reply, or of this sentence).
export const MESSAGE_CHARS = 160;

/**
 * CLOSED. A renderer that meets a status it does not know draws `?`, never a
 * guess, and a test asserts every member has a code and a tone.
 *
 *   ok       a stream with content arrived
 *   empty    HTTP 200 and a stream, but no content
 *   auth     401/403 -- the key, not the model
 *   pay      the account cannot use this model until funded
 *   rate     429 or a quota message
 *   gone     404: the model or its backend no longer exists
 *   timeout  no complete answer inside the deadline
 *   error    5xx, network failure, malformed stream
 *   skip     NOT probed; `w` says why (provider-dead, unfunded, spend-cap, row-cost)
 */
export const STATUSES = Object.freeze(
  ["ok", "empty", "auth", "pay", "rate", "gone", "timeout", "error", "skip"]);

const CODE = { ok: "ok", empty: "empt", auth: "auth", pay: "pay", rate: "rate",
               gone: "gone", timeout: "t/o", error: "err", skip: "skip" };
const TONE = { ok: "ok", empty: "bad", auth: "bad", pay: "warn", rate: "warn",
               gone: "bad", timeout: "warn", error: "bad", skip: "dim" };

/**
 * Statuses a later run should retry rather than trust. `skip` is here because
 * every reason for it (a dead provider, an unfunded account, a spend cap) is a
 * fact about the moment of the run, and the user may have changed it since.
 */
export const TRANSIENT = new Set(["rate", "timeout", "error", "skip"]);

export const statusCode = (s) => CODE[s] ?? "?";
export const statusTone = (s) => TONE[s] ?? "dim";

const stripSuffix = (id) => String(id).replace(/\[1m\]$/i, "");
/** `provider/id` with any `[1m]` suffix removed: routing and discovery key on the bare id (#113). */
export const benchKey = (provider, id) => `${provider}/${stripSuffix(id)}`;
export const benchKeyOf = (target) => stripSuffix(target);

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

/**
 * A record read from disk is untrusted: the file is ours, but a torn write, a
 * hand edit or a later schema must not be able to put a non-number in a cell or
 * an escape sequence in a preview. Returns null for anything unusable.
 *
 * `p` is third-party model output (or a third-party error message). It is
 * sanitized when WRITTEN and again here, because the second pass is the one a
 * hand-edited or older file cannot skip.
 */
export function cleanRecord(raw) {
  if (!raw || typeof raw !== "object" || !STATUSES.includes(raw.s)) return null;
  return {
    s: raw.s,
    t: num(raw.t), d: num(raw.d), r: num(raw.r), o: num(raw.o), a: num(raw.a),
    // A non-ok `p` is the head of a PROVIDER sentence, so it is redacted like `m`; an ok `p` is the model's own answer.
    // A non-ok record stores no `p` when `m` already starts with it (the store drops the duplicate), so it is derived here.
    p: typeof raw.p === "string" ? redactClip(raw.p, PREVIEW_CHARS, { links: raw.s !== "ok" })
      : raw.s !== "ok" && typeof raw.m === "string" ? redactClip(raw.m, PREVIEW_CHARS) : "",
    k: raw.k === 1 ? 1 : 0,                       // 1: the preview is thinking, not an answer
    w: typeof raw.w === "string" ? sanitizeDisplay(raw.w, 20) : "",
    // Third-party text like `p`, so sanitized again here. Present only when there is one,
    // so a record without a message has exactly the shape it always had.
    // The max_tokens a non-default probe used; absent for the default budget.
    ...(Number.isInteger(raw.b) && raw.b > 0 ? { b: raw.b } : {}),
    // 1 when the stream was CUT for ignoring max_tokens (`o` and `r` are then estimates over the part seen).
    ...(raw.x === 1 ? { x: 1 } : {}),
    ...(typeof raw.m === "string" && raw.m ? { m: redactClip(raw.m, MESSAGE_CHARS) } : {}),
  };
}

/** Milliseconds as a cell of at most five characters: `842ms`, `1.23s`, `12.3s`, `100s`. */
export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  // Each window is chosen from the ROUNDED value, so a value that rounds up across a boundary
  // (999.5 ms, 9.995 s, 99.95 s) moves to the next window instead of overflowing this one.
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`;
  if (Math.round(ms / 10) < 1000) return `${(Math.round(ms / 10) / 100).toFixed(2)}s`;
  if (Math.round(ms / 100) < 1000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s > 9999 ? "long" : `${s}s`;                    // five columns at most, and never a false number
}

/** Tokens per second as a cell of at most four characters, or `-` when it was not measurable. */
export function fmtTps(r) {
  if (!Number.isFinite(r) || r < 0) return "-";
  if (r < 10) return r.toFixed(1);
  if (r < 1000) return String(Math.round(r));
  if (r < 10000) return `${(r / 1000).toFixed(1)}k`;
  return `${Math.min(999, Math.round(r / 1000))}k`;
}

/**
 * The preview cell text, at most `width` code points. A thinking preview gets a
 * leading `~` so "the model answered" is never confused with "the model was still
 * reasoning when the budget ran out"; a skipped row shows WHY it was skipped in
 * the same cell, since that is the only place it fits.
 */
export function previewText(rec, width) {
  if (!rec || width <= 0) return "";
  const body = rec.s === "skip" ? (rec.w ? `skipped: ${rec.w}` : "skipped")
    : rec.k === 1 ? `~${rec.p}` : rec.p;
  return sanitizeCells(body, width);      // drawn text: one column per code point (see sanitizeCells)
}

const ISO_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d/;
// `get.records` is how many records stand behind a reader: the picker must tell "the file is
// missing or empty" (an unknown, drawn as a dash) from "benched, and none were ok" (a real 0).
const emptyGet = () => null;
emptyGet.records = 0;
const EMPTY = Object.freeze({ generatedAt: null, size: 0, get: emptyGet });

/**
 * Read `bench.json` once. Total: a missing, corrupt or wrong-schema file is an
 * empty result, never a throw -- the toggle must not be able to take the picker
 * down. `get` cleans on access, so 6,000 rows cost nothing until they are drawn
 * and only the ~25 on screen are ever cleaned.
 */
export function loadBench(file = BENCH_FILE) {
  const raw = readJsonOr(file, null);
  if (!raw || raw.schema !== BENCH_SCHEMA || !raw.models || typeof raw.models !== "object") return EMPTY;
  const models = raw.models;
  const size = Object.keys(models).length;
  const get = (target) => {
    const k = benchKeyOf(target);
    return Object.hasOwn(models, k) ? cleanRecord(models[k]) : null;
  };
  get.records = size;
  // The raw stamp only (no record cleaning): what `oldestStampOf` reads for every listed route.
  get.stamp = (target) => {
    const k = benchKeyOf(target);
    const a = Object.hasOwn(models, k) ? models[k]?.a : null;
    return Number.isFinite(a) ? a : null;
  };
  return {
    // A stamp is drawn, so it must LOOK like one: anything else is no stamp at all.
    generatedAt: typeof raw.generatedAt === "string" && ISO_STAMP.test(raw.generatedAt) ? raw.generatedAt : null,
    size,
    get,
  };
}

/**
 * The sweep engine's own retention window (refresh/ imports it for its keep-recent-records rule). The PICKER no longer has any
 * age limit: every reader uses a record whatever its age (see `isUsable`), and an old list is announced by the outdated
 * notice instead (`BENCH_OUTDATED_DAYS`).
 */
export const BENCH_FRESH_MS = 14 * 24 * 3600 * 1000;
/** A record is outdated when it is more than this many days old: the sweep's default `--ttl` (7). */
export const BENCH_OUTDATED_DAYS = 7;
/** The list is called outdated when MORE than this share of its records is outdated (strictly more: exactly half is not). */
export const BENCH_OUTDATED_SHARE = 0.5;
const DAY_S = 24 * 3600;
const OUTDATED_S = BENCH_OUTDATED_DAYS * DAY_S;
/**
 * The `oldest probe` column's colour bands, as ages in seconds, all derived from `BENCH_OUTDATED_DAYS` (T): green under
 * 2/7 T (2 days), yellow under 4/7 T (4 days), orange under T (7 days), red from T. The age TEXT carries the meaning.
 */
export const PROBE_AGE_BANDS_S = Object.freeze({ yellow: (BENCH_OUTDATED_DAYS * 2 / 7) * DAY_S, orange: (BENCH_OUTDATED_DAYS * 4 / 7) * DAY_S, red: OUTDATED_S });
/** The band of a probe age in seconds: `grn`, `yel`, `ora` or `red`. */
export const probeAgeTone = (ageS) => (ageS >= PROBE_AGE_BANDS_S.red ? "red" : ageS >= PROBE_AGE_BANDS_S.orange ? "ora"
  : ageS >= PROBE_AGE_BANDS_S.yellow ? "yel" : "grn");

/**
 * THE usability rule, used by every reader (the rows, the counts, the flags, the header, the filters): the record
 * has a timestamp and it is NOT in the future (a clock that ran ahead or a hand edit is not evidence). There is NO age
 * limit: an old result stays visible and counts; the outdated notice says when the list needs a new sweep.
 *
 * "In the future" is judged against the LATER of the caller's `nowMs` and the real clock, plus a
 * small skew allowance. The picker freezes `nowMs` when it starts, and a sweep in another window
 * keeps writing records after that: a record written a minute after the picker opened is newer
 * than `state.now`, and dropping it as "future" would blank a model that was just measured.
 * A record more than `FUTURE_SKEW_MS` beyond even the real clock is still refused (a hand edit, a
 * clock that ran ahead).
 */
export const FUTURE_SKEW_MS = 5 * 60 * 1000;
export function isUsable(rec, nowMs = Date.now()) {
  if (!rec || !Number.isFinite(rec.a)) return false;
  const at = rec.a * 1000;
  return at - Math.max(nowMs, Date.now()) <= FUTURE_SKEW_MS;
}

/**
 * When the list was last FULLY updated: the stamp (ISO, UTC) of the OLDEST usable record among the routes of `rows` that
 * have one (every listed route was probed at least then). `get.stamp(target)` is the cheap raw-stamp reader `loadBench`
 * provides; any other reader falls back to the record's own `a`. `null` when no route has a record.
 */
const routeStamp = (get, target) => (typeof get.stamp === "function" ? get.stamp(target) : get(target)?.a);
export function oldestStampOf(rows, get, nowMs = Date.now()) {
  if (typeof get !== "function") return null;
  let oldest = Infinity;
  for (const r of rows ?? []) {
    for (const m of r?.models ?? []) {
      const a = routeStamp(get, benchKey(r.provider, m?.id ?? ""));
      if (Number.isFinite(a) && a > 0 && isUsable({ a }, nowMs) && a < oldest) oldest = a;
    }
  }
  return Number.isFinite(oldest) ? new Date(oldest * 1000).toISOString() : null;
}

/**
 * One provider's AGE HISTOGRAM: `[[epochHour, count], ...]`, oldest first, of the usable bench records among its listed
 * routes (every status), each record's stamp floored to the hour. It is what the snapshot bakes on each row, so the picker
 * can work out, at open time and against its own clock, the provider's oldest probe age and the share of records over
 * `BENCH_OUTDATED_DAYS` old without reading bench.json. `null` for a reader that is not a function.
 */
export function ageHistOf(provider, models, get, nowMs = Date.now()) {
  if (typeof get !== "function") return null;
  const by = new Map();
  for (const m of models ?? []) {
    const a = routeStamp(get, benchKey(provider, m?.id ?? ""));
    if (!Number.isFinite(a) || !(a > 0) || !isUsable({ a }, nowMs)) continue;
    const h = Math.floor(a / 3600);
    by.set(h, (by.get(h) ?? 0) + 1);
  }
  return [...by].sort((x, y) => x[0] - y[0]);
}

/** A histogram read from a FILE, made safe: an array of `[integer hour, positive integer count]` pairs, else `null` (no data). */
export function cleanAgeHist(h) {
  if (!Array.isArray(h)) return null;
  const out = [];
  for (const e of h) {
    if (Array.isArray(e) && Number.isSafeInteger(e[0]) && e[0] > 0 && Number.isSafeInteger(e[1]) && e[1] > 0) out.push([e[0], e[1]]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

/** The age in seconds of a histogram's OLDEST record against `nowMs`: `null` for no records (or no histogram), never negative. */
export function oldestAgeOf(hist, nowMs = Date.now()) {
  const h = cleanAgeHist(hist);
  if (!h || h.length === 0) return null;
  return Math.max(0, Math.floor(nowMs / 1000 - h[0][0] * 3600));
}

/** `{ total, old }`: the records in these histograms, and how many are more than `BENCH_OUTDATED_DAYS` old at `nowMs`. */
export function outdatedShare(hists, nowMs = Date.now()) {
  let total = 0, old = 0;
  for (const hist of hists ?? []) {
    for (const [h, n] of cleanAgeHist(hist) ?? []) {
      total += n;
      if (nowMs / 1000 - h * 3600 > OUTDATED_S) old += n;
    }
  }
  return { total, old };
}

/**
 * The outdated notice's date, `YYYY-MM-DD` (UTC), or `null` when there is nothing to say. The notice shows when MORE than
 * `BENCH_OUTDATED_SHARE` of the records (`hists`: every provider's age histogram) are more than `BENCH_OUTDATED_DAYS`
 * old; the DATE is `oldestAt`, the OLDEST record (when the list was last fully updated). No records, or a stamp that is
 * not an ISO date or lies in the future (the text comes from a file), say nothing.
 */
export function outdatedNotice(oldestAt, hists, nowMs = Date.now()) {
  if (typeof oldestAt !== "string" || !ISO_STAMP.test(oldestAt)) return null;
  const t = Date.parse(oldestAt);
  if (!Number.isFinite(t) || t > nowMs + FUTURE_SKEW_MS) return null;
  const { total, old } = outdatedShare(hists, nowMs);
  return total > 0 && old / total > BENCH_OUTDATED_SHARE ? oldestAt.slice(0, 10) : null;
}

/** Whether a cleaned record says `gone` (the model is not found upstream) AND is fresh: what the hide-gone toggle hides. */
export function isGone(rec, nowMs = Date.now()) {
  return !!rec && rec.s === "gone" && isUsable(rec, nowMs);
}

/**
 * Whether a cleaned record says `ok` AND is fresh: the model-level `ok` filter and the header's
 * `ok` figures use this one definition.
 */
export function isOk(rec, nowMs = Date.now()) {
  return !!rec && rec.s === "ok" && isUsable(rec, nowMs);
}

/**
 * A provider's usable records, ONE PER MODEL ROW (a selectable route): `x` and `x[1m]` are two
 * routes that share one probe record, and both count -- the same rule the ok-only filter
 * applies, so a count, a verdict, a header figure and a filtered list always agree. Only fresh
 * records of a known status count. `null` when there is no reader to ask.
 */
function freshRecords(provider, models, get, nowMs) {
  if (typeof get !== "function") return null;
  const out = [];
  for (const m of models ?? []) {
    const rec = get(benchKey(provider, m?.id ?? ""));
    if (!rec || !STATUSES.includes(rec.s) || !isUsable(rec, nowMs)) continue;
    out.push(rec);
  }
  return out;
}

/**
 * How many of a provider's models have each RAW status, for the provider-level
 * columns. No grouping: one counter per member of STATUSES, so `ok 12, gone 40`
 * stays exactly what the probes said.
 *
 * Only fresh records count (one per model ROW), and a model with no fresh record appears in NO column
 * -- "never benched" is the absence of a status, not a tenth one -- so the columns
 * can sum to less than the provider's model count.
 *
 * `get` is `loadBench().get`. Returns `null` when there is nothing to count from,
 * which the renderer draws as blanks rather than as a wall of zeros.
 */
export function countStatuses(provider, models, get, nowMs = Date.now()) {
  const recs = freshRecords(provider, models, get, nowMs);
  if (!recs) return null;
  const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const r of recs) out[r.s] += 1;
  return out;
}

/**
 * The provider-level yes/no verdicts, over the same population as `countStatuses`.
 * Both describe the last sweep, not the provider's state today.
 *
 *   dead        there is at least one fresh record, NOTHING responded (no `ok`, no
 *               `empty`: both mean the provider answered), and EVERY record is a
 *               refusal or failure of the dead kind: `auth`, `error`, `timeout`,
 *               `gone`, or a legacy `skip` for `provider-dead` (older sweeps
 *               skipped a provider once it looked dead; the record still reads as dead).
 *               Anything else in the mix makes it no: `pay` (that provider needs money,
 *               it is not dead), `rate` (rate limited is not dead), any other skip.
 *   needsMoney  there is at least one fresh record, NONE answered (`ok` or `empty`
 *               both mean the provider responded), and EVERY one is `pay` or a
 *               `skip` for `unfunded`. One answering model flips it to no.
 *
 * `null` (drawn blank, never "no") when there is no reader or no fresh record: a
 * provider nobody benched has no verdict.
 */
export function providerFlags(provider, models, get, nowMs = Date.now()) {
  const recs = freshRecords(provider, models, get, nowMs);
  if (!recs?.length) return null;
  const unpaid = (r) => r.s === "pay" || (r.s === "skip" && r.w === "unfunded");
  const deadKind = (r) => r.s === "auth" || r.s === "error" || r.s === "timeout" || r.s === "gone"
    || (r.s === "skip" && r.w === "provider-dead");
  return {
    dead: recs.every(deadKind),
    needsMoney: recs.every(unpaid),
  };
}

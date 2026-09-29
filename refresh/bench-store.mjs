// Persistence for the benchmark sweep (#114): an append-only checkpoint log and
// its compaction into `state/bench.json`.
//
// THE LOG IS THE CHECKPOINT. A full sweep is ~6,000 real requests over tens of
// minutes; the process can be interrupted (Ctrl-C, sleep, a reboot). Every result
// is appended the moment it exists, so a resume loses at most the requests that
// were in flight, and nothing is ever held in memory that is not also on disk.
//
// `bench.json` is what the picker reads. It is rebuilt from (previous bench.json
// + log) by `compact`, written atomically, and only THEN is the log truncated --
// so a crash between the two replays the log over an already-updated file, which
// is idempotent because the log's records are keyed and last-wins.
//
// LAST-WINS HAS ONE EXCEPTION, so a flaky day cannot erase a good measurement. When the
// newer record for a model is TRANSIENT (rate / timeout / error / skip: a fact about the
// moment of a run) and the older one is a real result (ok, empty, auth, pay, gone) that is
// still fresh, the older one is kept and the transient one is dropped. A newer real result
// always wins, and so does any newer record over an older one past the freshness window.
// This changes only what is KEPT: the log still gets every result appended.

import fs from "node:fs";
import path from "node:path";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";
import {
  BENCH_FILE, BENCH_LOG, BENCH_SCHEMA, BENCH_PROMPT, BENCH_MAX_TOKENS,
  TRANSIENT, MESSAGE_CHARS, PREVIEW_CHARS, BENCH_FRESH_MS, cleanRecord,
} from "../menu/bench-data.mjs";
import { sanitizeDisplay } from "../menu/sanitize.mjs";
import { redactClip } from "../menu/redact.mjs";
import { looksLikeNotice } from "./bench.mjs";

// `b` is the max_tokens the probe was sent with, stored only when it is not the default budget
// (a 1024-token re-probe of a hidden-reasoning `empty` reads differently from a 96-token one).
const FIELDS = ["s", "t", "d", "r", "o", "a", "p", "k", "w", "m", "b", "x"];

/** The stored shape: only the fields that carry information, so 6,000 rows stay ~0.5 MB. */
export function toStored(rec) {
  const out = {};
  for (const f of FIELDS) {
    let v = rec[f];
    // `m` is a third party's sentence: sanitized on the way IN as well as on load.
    if (f === "m") v = typeof v === "string" ? redactClip(v, MESSAGE_CHARS) : null;
    // The head of a provider sentence (a non-ok `p`) is redacted the same way; an ok `p` is the model's answer.
    if (f === "p" && typeof v === "string") v = redactClip(v, PREVIEW_CHARS, { links: rec.s !== "ok" });
    if (v === null || v === undefined || v === "" || (f === "k" && v === 0)) continue;
    out[f] = v;
  }
  // On a non-ok result `m` (up to 160 characters) already IS `p` (its first 120): storing both would double the
  // bytes for nothing, and `cleanRecord` derives `p` from `m` again.
  if (rec.s !== "ok" && out.p && out.m && out.p === redactClip(out.m, PREVIEW_CHARS)) delete out.p;
  return out;
}

/**
 * Append-only writer. `fsync` is amortised (every `fsyncEvery` records or
 * `fsyncMs`, whichever comes first) rather than per record: at ~6,000 records an
 * fsync each would be the dominant cost of the whole sweep, and the loss it would
 * prevent is bounded by the same window anyway.
 */
export function createLogWriter(file = BENCH_LOG, { fsyncEvery = 25, fsyncMs = 2000, now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  let pending = 0, last = now(), closed = false;
  const sync = () => { try { fs.fsyncSync(fd); } catch { /* not every filesystem supports it */ } pending = 0; last = now(); };
  return {
    append(key, rec) {
      if (closed) return;
      fs.writeSync(fd, JSON.stringify({ key, ...toStored(rec) }) + "\n");
      pending += 1;
      if (pending >= fsyncEvery || now() - last >= fsyncMs) sync();
    },
    close() { if (closed) return; sync(); closed = true; fs.closeSync(fd); },
  };
}

/**
 * Which of two records for the same model survives. The newer, except that a transient
 * newer record never replaces an older real one that is still fresh (`ttlMs`, default the
 * picker's own 14-day window), and an unusable newer record never replaces anything.
 */
export function mergeRecord(older, newer, { ttlMs = BENCH_FRESH_MS, nowMs = Date.now() } = {}) {
  if (older === undefined || older === null) return newer;
  const n = cleanRecord(newer);
  if (!n) return older;
  if (TRANSIENT.has(n.s) && isFresh(older, { ttlMs, nowMs })) return older;
  return newer;
}

/**
 * Read the log into `key -> record`, last line wins (see `mergeRecord` for the exception). A line that does not parse is
 * skipped rather than fatal: the one place a torn line can occur is the LAST one,
 * from an interrupted write, and losing one probe is the right price for a resume
 * that still works.
 */
export function readLog(file = BENCH_LOG, opts = {}) {
  const out = new Map();
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { return out; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const { key, ...rec } = JSON.parse(line);
      if (typeof key === "string" && rec && typeof rec === "object") out.set(key, mergeRecord(out.get(key), rec, opts));
    } catch { /* torn or corrupt line */ }
  }
  return out;
}

/** `key -> record` from bench.json, empty when absent, corrupt or another schema. */
export function readBench(file = BENCH_FILE) {
  const raw = readJsonOr(file, null);
  const out = new Map();
  if (!raw || raw.schema !== BENCH_SCHEMA || !raw.models || typeof raw.models !== "object") return out;
  for (const [k, v] of Object.entries(raw.models)) out.set(k, v);
  return out;
}

/** Everything known so far: the last compacted state overlaid by the log. */
export function loadExisting({ benchFile = BENCH_FILE, logFile = BENCH_LOG, ttlMs, nowMs } = {}) {
  const opts = { ...(ttlMs ? { ttlMs } : {}), ...(nowMs ? { nowMs } : {}) };
  const merged = readBench(benchFile);
  for (const [k, v] of readLog(logFile, opts)) merged.set(k, mergeRecord(merged.get(k), v, opts));
  return merged;
}

/**
 * A record is fresh -- so a resume should not re-probe it -- when it is a real
 * measurement, younger than `ttlMs`, and not one of the statuses that describe
 * the moment of the run (`TRANSIENT`: rate limits, timeouts, errors and skips).
 */
export function isFresh(rec, { ttlMs, nowMs = Date.now() }) {
  const c = cleanRecord(rec);
  if (!c || c.a === null) return false;
  if (TRANSIENT.has(c.s)) return false;
  return nowMs - c.a * 1000 < ttlMs;
}

/**
 * A record with its provider text redacted: `m`, and `p` when the result is not an `ok`
 * (then it is the head of the provider's sentence; on an `ok` it is the model's answer).
 * `changed` says whether anything was different, so a maintenance pass can count.
 */
export function redactRecord(rec) {
  if (!rec || typeof rec !== "object") return { rec, changed: false };
  const out = { ...rec };
  let changed = false;
  if (typeof rec.m === "string") {
    const m = redactClip(rec.m, MESSAGE_CHARS);
    if (m !== rec.m) { changed = true; if (m) out.m = m; else delete out.m; }
  }
  if (typeof rec.p === "string") {
    // a non-ok `p` is provider text (links and all); an ok `p` is the model's answer: credentials and ids only
    const p = redactClip(rec.p, PREVIEW_CHARS, { links: rec.s !== "ok" });
    if (p !== rec.p) { changed = true; if (p) out.p = p; else delete out.p; }
  }
  return { rec: out, changed };
}

/**
 * The one-shot maintenance pass behind `bench-cli --redact`: rewrite bench.json (and a
 * non-empty log) with every record's provider text redacted. Atomic, idempotent, and it
 * touches nothing else: generatedAt, params and every measurement are carried over as they
 * were. Returns `{ ok, records, changed, logRecords, logChanged }`.
 */
export function redactBench({ benchFile = BENCH_FILE, logFile = BENCH_LOG } = {}) {
  const raw = readJsonOr(benchFile, null);
  // A bench.json that is missing or corrupt does not stop the LOG from being redacted: the log may hold
  // unredacted lines of its own (an interrupted run), and it is folded into bench.json later.
  const benchOk = !!raw && raw.schema === BENCH_SCHEMA && !!raw.models && typeof raw.models === "object";
  let changed = 0;
  const models = {};
  if (benchOk) {
    for (const [k, v] of Object.entries(raw.models)) {
      const r = redactRecord(v);
      if (r.changed) changed += 1;
      models[k] = r.rec;
    }
    if (changed) writeAtomic(benchFile, JSON.stringify({ ...raw, models }));
  }

  let logRecords = 0, logChanged = 0;
  let text = "";
  try { text = fs.readFileSync(logFile, "utf8"); } catch { /* no log */ }
  if (text) {
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const { key, ...rec } = JSON.parse(line);
        logRecords += 1;
        const r = redactRecord(rec);
        if (r.changed) logChanged += 1;
        lines.push(JSON.stringify({ key, ...r.rec }));
      } catch { lines.push(line); }        // a torn line is left exactly as it is
    }
    if (logChanged) writeAtomic(logFile, `${lines.join("\n")}\n`);
  }
  if (!benchOk && !logRecords) return { ok: false, reason: "no readable bench.json (missing, corrupt or another schema) and no log records" };
  return { ok: true, benchOk, records: Object.keys(models).length, changed, logRecords, logChanged };
}

/**
 * Fold the log into bench.json. `keep` (a Set of keys) prunes records for models
 * the catalogue no longer lists, so the file cannot accrete rows for ever.
 * Returns the count written. Truncates the log only after the write succeeded.
 */
export function compact({ benchFile = BENCH_FILE, logFile = BENCH_LOG, keep = null, now = () => new Date(), ttlMs } = {}) {
  const merged = loadExisting({ benchFile, logFile, ttlMs, nowMs: now().getTime() });
  const models = {};
  for (const [k, v] of merged) {
    if (keep && !keep.has(k)) continue;
    if (!cleanRecord(v)) continue;
    models[k] = redactRecord(v).rec;      // whatever is folded in is redacted, including a log from before redaction existed
  }
  fs.mkdirSync(path.dirname(benchFile), { recursive: true });
  writeAtomic(benchFile, JSON.stringify({
    schema: BENCH_SCHEMA, generatedAt: now().toISOString(),
    params: { prompt: BENCH_PROMPT, maxTokens: BENCH_MAX_TOKENS },
    models,
  }));
  try { fs.writeFileSync(logFile, ""); } catch { /* an un-truncated log just replays */ }
  return Object.keys(models).length;
}

// ------------------------------------------------------------ false ok -> notice

/**
 * One record through the false-notice rule (`looksLikeNotice`, the same one `probeOne` applies to a live
 * stream). An `ok` whose stored preview is an error or account notice becomes the status the rule names
 * (`auth` / `pay` / `error`), with the sentence in `m`; `t`, `r`, `o` and `k` are dropped (there was no answer to time,
 * rate or count); `a`, `d`, `p`, `b` and `x` are kept. Anything else is returned unchanged.
 */
export function reclassifyNotice(rec) {
  if (!rec || typeof rec !== "object" || rec.s !== "ok" || typeof rec.p !== "string" || rec.k === 1) return { rec, changed: false };
  const kind = looksLikeNotice(rec.p);
  if (!kind) return { rec, changed: false };
  const keep = { ...rec };
  for (const f of ["t", "r", "o", "k"]) delete keep[f];
  return { rec: { ...keep, s: kind, m: redactClip(`reclassified from ok (HTTP 200 notice): ${rec.p}`, MESSAGE_CHARS) }, changed: true, kind };
}

/**
 * The one-shot maintenance pass behind `bench-cli --reclassify-notices`: rewrite bench.json (and a non-empty log)
 * with every false-notice `ok` reclassified. `dry` reads and counts but writes nothing. Atomic, idempotent (a
 * reclassified record is no longer `ok`), a torn log line is left as it is. Returns
 * `{ ok, benchOk, records, changed, byStatus, samples, logRecords, logChanged }`.
 */
export function reclassifyNotices({ benchFile = BENCH_FILE, logFile = BENCH_LOG, dry = false } = {}) {
  const raw = readJsonOr(benchFile, null);
  const benchOk = !!raw && raw.schema === BENCH_SCHEMA && !!raw.models && typeof raw.models === "object";
  const byStatus = {}, samples = [];
  const tally = (key, res) => {
    byStatus[res.kind] = (byStatus[res.kind] ?? 0) + 1;
    if (samples.length < 5) samples.push({ key, to: res.kind, p: res.rec.p });
  };
  let changed = 0;
  const models = {};
  if (benchOk) {
    for (const [k, v] of Object.entries(raw.models)) {
      const r = reclassifyNotice(v);
      if (r.changed) { changed += 1; tally(k, r); }
      models[k] = r.rec;
    }
    if (changed && !dry) writeAtomic(benchFile, JSON.stringify({ ...raw, models }));
  }

  let logRecords = 0, logChanged = 0, text = "";
  try { text = fs.readFileSync(logFile, "utf8"); } catch { /* no log */ }
  if (text) {
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      try {
        const { key, ...rec } = JSON.parse(line);
        logRecords += 1;
        const r = reclassifyNotice(rec);
        if (r.changed) { logChanged += 1; tally(`(log) ${key}`, r); }
        lines.push(JSON.stringify({ key, ...r.rec }));
      } catch { lines.push(line); }
    }
    if (logChanged && !dry) writeAtomic(logFile, `${lines.join("\n")}\n`);
  }
  if (!benchOk && !logRecords) return { ok: false, reason: "no readable bench.json (missing, corrupt or another schema) and no log records" };
  return { ok: true, benchOk, records: Object.keys(models).length, changed, byStatus, samples, logRecords, logChanged };
}

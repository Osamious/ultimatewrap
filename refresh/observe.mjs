// Live model status, C3: the read-only usage feed, the event classifier and the overlay writer.
//
// WHAT THIS IS. A one-shot process (see observe-cli.mjs) that reads the router's OWN usage log for rows newer than a
// stored watermark, turns each row into one observation of a model (ok, or a failure class), applies a small state
// machine per model key and writes the result to `state/observed.json`, the OVERLAY the picker merges over bench.json.
// It never talks to the gateway, never writes the router's databases and never touches bench.json. The design, the
// numbers behind every rule and the privacy argument are in plans/live-observer-plan.md (sections A, B, C, F, G and the
// Revision 2 table); comments below point at the rule they implement, they do not repeat the evidence.
//
// PRIVACY (plan F). Only named columns are selected. The single statement that touches a response body is
// `failureSql`: the provider's error sentence is extracted INSIDE SQLite by json_extract behind a json_valid guard, so no
// body ever enters this process. The full sentence and three short codes are used in memory to classify and are never
// stored; the stored `m` is the 160-character redacted clip, or `HTTP <status> (provider message not kept)`.

import fs from "node:fs";
import path from "node:path";
import { spawn as childSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONTRACT as CCR, usageDb as routerUsageDb, requestLogsDb as routerLogsDb, gatewayConnection } from "../menu/ccr-client.mjs";
import { BENCH_FILE, BENCH_FRESH_MS, FUTURE_SKEW_MS, MESSAGE_CHARS, benchKey, benchKeyOf, cleanRecord, loadBench } from "../menu/bench-data.mjs";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";
import { redactClip } from "../menu/redact.mjs";
import { sanitizeDisplay } from "../menu/sanitize.mjs";
import { loadSnapshot, SNAPSHOT_FILE } from "../menu/snapshot.mjs";
import { classifyHttp, classifyTight, buildTargets, probeOne } from "./bench.mjs";
import { acquireLock, sweepStatus } from "./bench-lock.mjs";
import { toStored } from "./bench-store.mjs";

export const OVERLAY_SCHEMA = 1;
const BATCH_ROWS = 5000;
const BUDGET_MS = 1500;
const MAX_ROWS = 100000;
const OLD_TAG_WINDOW_DAYS = 3;
const SKEW_S = 300;
const HOLD_S = 6 * 3600;                 // a same-class failure inside this window is a duplicate, not news
const PEND_MAX_S = 24 * 3600;            // two ambiguous failures further apart than this are two first failures
const RETRY_GAP_S = 120;                 // Claude Code's own retries land inside this
const OUTAGE_WINDOW_S = 60;
const OUTAGE_PROVIDERS = 3;
const BODY_CAP_BYTES = 262144;           // a body larger than this is never handed to json_valid
const MAX_TEXT_IDS = 200;                // failing rows whose text is read per run
const HOLD_CONFIRM_S = 600;              // no re-reservation for this long after a child could not reach the gateway
const PROVIDER_404_MODELS = 3;
const PROVIDER_OK_DAYS = 14;
const TRIPWIRE_MIN_ROWS = 10;            // a share of fewer rows than this is noise, not a mapping drift
const MAX_ENTRIES = 800;
const CONF_KEEP_S = 7 * 24 * 3600;
const TMP_DEBRIS_MS = 5 * 60 * 1000;
const FIELD_CAP = 2000;
const CHUNK = 50;
const LOCKED_RUNS_BEFORE_NOTE = 3;

// ------------------------------------------------------------------ files

/** Every file of the feature, beside bench.json. The sentinel `observe.off` is the persistent kill switch. */
export function observePaths(stateDir = path.dirname(BENCH_FILE)) {
  return {
    dir: stateDir,
    overlay: path.join(stateDir, "observed.json"),
    run: path.join(stateDir, "observed.run"),
    lock: path.join(stateDir, "observed.lock"),
    off: path.join(stateDir, "observe.off"),
  };
}

export const observeEnabled = (stateDir) => !fs.existsSync(observePaths(stateDir).off);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * `writeAtomic` with a retry for the Windows rename that an antivirus scan or an open reader briefly refuses.
 * Retries ONLY those three codes; anything else is a real failure and is rethrown. After `tries` it gives up quietly
 * (the next open retries) and says so in the result. `menu/atomic.mjs` is not edited: it is on the picker's import graph.
 */
export function writeAtomicRetry(file, text, { tries = 5, waitMs = 40, write = writeAtomic, sleep = sleepSync } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try { write(file, text); return { ok: true, tries: i }; }
    catch (e) {
      if (!RETRY_CODES.has(e?.code)) throw e;
      last = e;
      if (i < tries) sleep(waitMs);
    }
  }
  return { ok: false, tries, error: `${last?.code}: gave up after ${tries} tries` };
}

/** Debris of a killed `writeAtomic`: `observed.json.tmp-<pid>` older than five minutes. Returns how many were removed. */
export function sweepTmp(dir, nowMs = Date.now()) {
  let n = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    if (!/^observed\.(json|run)\.tmp-/.test(f)) continue;
    try {
      const p = path.join(dir, f);
      if (nowMs - fs.statSync(p).mtimeMs > TMP_DEBRIS_MS) { fs.rmSync(p, { force: true }); n += 1; }
    } catch { /* raced with its owner */ }
  }
  return n;
}

// ------------------------------------------------------------------ the usage feed

const USAGE_COLS = ["id", "created_at", "request_id", "client", "provider", "model", "status_code", "duration_ms", "output_tokens"];
// The optional message source. `error` and `gateway_error` are short gateway columns, not bodies.
const LOG_COLS = ["request_id", "response_body_text", "response_body_size_bytes", "error", "gateway_error"];

/** node:sqlite with its one ExperimentalWarning swallowed (scoped: `emitWarning` is restored, nothing else is filtered). */
export function loadSqlite() {
  const orig = process.emitWarning;
  process.emitWarning = function (w, ...rest) {
    const text = typeof w === "string" ? w : w?.message ?? "";
    if (/sqlite/i.test(text) && /experimental/i.test(text)) return undefined;
    return orig.call(process, w, ...rest);
  };
  try { return process.getBuiltinModule?.("node:sqlite") ?? null; }
  catch { return null; }
  finally { process.emitWarning = orig; }
}

const columnsOf = (db, table) => {
  try { return new Set(db.prepare(`pragma table_info(${table})`).all().map((r) => r.name)); }
  catch { return new Set(); }
};
const hasTable = (db, table) => {
  try { return !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(table); }
  catch { return false; }
};
const openRead = (sqlite, file) => {
  const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 250 });
  db.exec("PRAGMA query_only = 1");
  return db;
};

/**
 * Open the usage database read-only and check its schema. Never throws: every failure is a value,
 * `{ ok: false, feed: "unavailable:<why>" }`. On success `{ ok: true, db, logs, close }`; `logs` is the handle that
 * holds `request_logs` (this file, or the router's request-log file) or null when there is no message source.
 */
export function openUsage({ usageDb, logsDb = null } = {}) {
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return { ok: false, feed: "unavailable:node-sqlite" };
  if (!usageDb || !fs.existsSync(usageDb)) return { ok: false, feed: "unavailable:missing" };
  const handles = [];
  const close = () => { for (const h of handles) { try { h.close(); } catch { /* closed */ } } };
  try {
    const db = openRead(sqlite, usageDb);
    handles.push(db);
    const have = columnsOf(db, "usage_events");
    const missing = USAGE_COLS.filter((c) => !have.has(c));
    if (missing.length) { close(); return { ok: false, feed: "unavailable:schema", missing }; }
    let logs = null;
    const usable = (h) => hasTable(h, "request_logs") && LOG_COLS.every((c) => columnsOf(h, "request_logs").has(c));
    try {
      if (usable(db)) logs = db;
      else if (logsDb && fs.existsSync(logsDb)) {
        const l = openRead(sqlite, logsDb);
        handles.push(l);
        if (usable(l)) logs = l;
      }
    } catch { logs = null; }          // messages are best effort: the feed stays OK without them
    return { ok: true, db, logs, close };
  } catch (e) {
    close();
    return { ok: false, feed: /locked|busy/i.test(String(e?.message)) ? "unavailable:locked" : /unable to open|no such file/i.test(String(e?.message)) ? "unavailable:missing" : "unavailable:locked", detail: String(e?.message ?? e).slice(0, 120) };
  }
}

/**
 * THE ONLY statement that touches a response body. `json_valid` is mandatory: json_extract on invalid JSON THROWS in this
 * node:sqlite, and a plain `and` does not short-circuit. Nothing but the named scalars leaves SQLite.
 */
export function failureSql(n) {
  // The size column gates every parse: an oversized body is never handed to json_valid. The call is synchronous and SQLite
  // cannot be interrupted from JS, so the child watchdog cannot cut it short; the 256 KB and 200-id caps are what bound it.
  const ok = `response_body_size_bytes <= ${BODY_CAP_BYTES} and json_valid(response_body_text)`;
  return `select request_id,
       case when ${ok} then json_extract(response_body_text, '$.error.message') end as msg,
       case when ${ok} then json_extract(response_body_text, '$.error.code')    end as code,
       case when ${ok} then json_extract(response_body_text, '$.error.type')    end as typ,
       case when ${ok} then json_extract(response_body_text, '$.error.status')  end as st,
       error, gateway_error
  from request_logs where request_id in (${Array(n).fill("?").join(", ")})`;
}

const short = (v) => (v === null || v === undefined || typeof v === "object" ? "" : String(v).slice(0, FIELD_CAP));

/** `Map<request_id, { msg, code, typ, st, error, gerr }>` for the given ids; short strings only. Best effort: never throws. */
export function readFailureText(logs, ids) {
  const out = new Map();
  if (!logs || !ids.length) return out;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    try {
      for (const r of logs.prepare(failureSql(chunk.length)).all(...chunk)) {
        out.set(String(r.request_id), { msg: short(r.msg), code: short(r.code), typ: short(r.typ), st: short(r.st), error: short(r.error), gerr: short(r.gateway_error) });
      }
    } catch { /* an unreadable chunk simply has no messages */ }
  }
  return out;
}

// ------------------------------------------------------------------ classification

const HARD = new Set([429, 402, 401, 403, 404, 410]);
const IGNORABLE_4XX = new Set([400, 413, 422]);
const TIMEOUT_STATUS = new Set([504, 522, 524]);

/**
 * Key derivation (plan B step 1) against the snapshot's route set: `provider/model` first, then the model with a leading
 * `provider/` removed. That order is what keeps nvidia (real ids start with `nvidia/`) right, while an anthropic model that
 * appears both as `claude-x` and as `anthropic/claude-x` resolves to one key. Null when neither is a route.
 */
export function deriveKey(provider, model, routeSet) {
  if (!provider || !model) return null;
  const k1 = benchKey(provider, model);
  if (routeSet.has(k1)) return k1;
  if (String(model).startsWith(`${provider}/`)) {
    const k2 = benchKey(provider, String(model).slice(provider.length + 1));
    if (routeSet.has(k2)) return k2;
  }
  return null;
}

/**
 * First look at a row, without any message. `{ skip }` (a reason, counted, never stored) or `{ key, kind, st, a, want }`;
 * `want` says the failure text is worth reading. Pure.
 */
export function triage(row, ctx) {
  if (row.client === ctx.probeClient) return { skip: "probe" };
  const key = deriveKey(row.provider, row.model, ctx.routeSet);
  if (!key) return { skip: "unknownKey" };
  const st = Number(row.status_code);
  if (st === 499) return { skip: "abort499" };
  const kind = st === 200 ? "ok" : HARD.has(st) ? "hard" : IGNORABLE_4XX.has(st) ? "maybe" : st >= 500 && st <= 599 ? "amb" : null;
  if (!kind) return { skip: "otherStatus" };
  const start = Date.parse(row.created_at);
  const dur = Number(row.duration_ms);
  if (!Number.isFinite(start) || !Number.isFinite(dur) || dur < 0) return { skip: "badRow" };
  const a = Math.floor((start + dur) / 1000);
  if (a > ctx.nowS + SKEW_S) return { skip: "skew" };
  return { key, kind, st, a, want: kind !== "ok" };
}

/**
 * One usage row (+ its failure text, or null) -> `{ skip }` or an event
 * `{ kind: ok|hard|amb, key, provider, s, a, d, o, q, id, status, m, msgPresent }`. Pure.
 * The classification input `raw` (full sentence plus code, type, status) exists only inside this function.
 */
export function classifyEvent(row, info, ctx) {
  const t = triage(row, ctx);
  if (t.skip) return t;
  const base = { key: t.key, provider: row.provider, a: t.a, d: Math.round(Number(row.duration_ms)), id: row.id,
                 q: sanitizeDisplay(row.request_id ?? "", 40), status: t.st };
  if (t.kind === "ok") {
    const o = Number(row.output_tokens);
    if (!(o >= 1)) return { skip: "zeroTok" };           // a 200 with no output is not proof of life (provider notices)
    return { ...base, kind: "ok", s: "ok", o };
  }
  const msg = String(info?.msg ?? "").replace(/\s+/g, " ").trim();
  const raw = [info?.msg, info?.code, info?.typ, info?.st, info?.error, info?.gerr].filter(Boolean).join(" ");
  // The provider's sentence is stored ONLY for the statuses whose bodies are auth, billing, rate or gone by construction.
  // Every other status can echo the conversation (validation errors quote the input), so it keeps the fixed text.
  const keep = t.kind === "hard";
  const clipped = keep && msg ? redactClip(msg, MESSAGE_CHARS) : "";
  const ev = { ...base, m: clipped || `HTTP ${t.st} (provider message not kept)`, msgPresent: !!clipped };
  if (t.kind === "hard") {
    const cls = classifyHttp(t.st, raw);
    return { ...ev, kind: "hard", s: cls === "error" ? "gone" : cls };                            // 410 says gone when the text is silent
  }
  // 400/413/422 and every 5xx: the text may be the user's own words (a tool named purchase_item, "balancer"), so only the TIGHT anchors
  // (empty balance, account state, a strong gone phrase or code) can give a hard class. Nothing else: 400s stay ignored, a 5xx stays
  // ambiguous (it needs two failures), and a 5xx worded as throttling is one failing gateway, not a throttled model.
  const tight = classifyTight(raw);
  if (tight) return { ...ev, kind: "hard", s: tight };
  if (t.kind === "maybe") return { skip: "ignored400" };
  return { ...ev, kind: "amb", s: TIMEOUT_STATUS.has(t.st) ? "timeout" : "error" };
}

// ------------------------------------------------------------------ the state machine

const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x));

const validRec = (r) => r && typeof r === "object" && typeof r.s === "string" && Number.isFinite(r.a);

/**
 * Apply sorted events to the overlay. `models` / `pend` are mutated (the caller passes copies). `benchGet(key)` is the
 * probe record (cleaned). `providerOkRecent(provider)` says whether a provider had an ok inside 14 days (the 404 guard).
 * Returns `{ skip, confirm, written }`: counts by reason, the keys whose failing -> ok flip wants a confirmation probe
 * (C4 acts on it), and `written` = [{ key, s }] of records written or replaced.
 */
export function applyEvents(events, { models, pend, benchGet, providerOkRecent = () => false, nowS }) {
  const skip = {};
  const bump = (k, n = 1) => { skip[k] = (skip[k] ?? 0) + n; };
  const confirm = [];
  const written = new Map();
  events = events.map((e) => ({ ...e }));

  // Provider-wide 404 guard: 3+ different models of ONE provider 404 in this run, no message, no 200 for that provider
  // in the run, and the provider worked within 14 days -> a wrong path, not 3 removed models: ambiguous `error`.
  const okProviders = new Set(events.filter((e) => e.kind === "ok").map((e) => e.provider));
  const by404 = new Map();
  for (const e of events) if (e.kind === "hard" && e.status === 404 && !e.msgPresent) (by404.get(e.provider) ?? by404.set(e.provider, []).get(e.provider)).push(e);
  for (const [prov, list] of by404) {
    const keys = new Set(list.map((e) => e.key));
    if (keys.size < PROVIDER_404_MODELS || okProviders.has(prov) || !providerOkRecent(prov)) continue;
    for (const e of list) { e.kind = "amb"; e.s = "error"; e.mOverride = `404 across ${keys.size} models of ${prov}: path or base URL?`; }
  }

  // Gateway-outage guard, a SLIDING window: ambiguous failures spanning at most 60 s across 3+ different providers, with no ok
  // within a minute of that span, are the gateway or the network failing, not the models. (Fixed minute buckets would split a 2+1 burst.)
  const dropped = new Set();
  const okTimes = events.filter((e) => e.kind === "ok").map((e) => e.a);                // sorted: the events are
  const okBetween = (from, to) => {                      // binary search: the first ok at or after `from`, is it <= `to`?
    let a = 0, b = okTimes.length;
    while (a < b) { const mid = (a + b) >> 1; if (okTimes[mid] < from) a = mid + 1; else b = mid; }
    return a < okTimes.length && okTimes[a] <= to;
  };
  const ambs = events.filter((e) => e.kind === "amb");
  const count = new Map();
  let lo = 0, marked = -1;
  for (let hi = 0; hi < ambs.length; hi++) {
    count.set(ambs[hi].provider, (count.get(ambs[hi].provider) ?? 0) + 1);
    while (ambs[hi].a - ambs[lo].a > OUTAGE_WINDOW_S) {
      const c = count.get(ambs[lo].provider) - 1;
      if (c) count.set(ambs[lo].provider, c); else count.delete(ambs[lo].provider);
      lo += 1;
    }
    if (count.size >= OUTAGE_PROVIDERS && !okBetween(ambs[lo].a - OUTAGE_WINDOW_S, ambs[hi].a + OUTAGE_WINDOW_S)) {
      for (let i = Math.max(lo, marked + 1); i <= hi; i++) { dropped.add(ambs[i]); bump("outage"); }
      marked = hi;
    }
  }

  const effOf = (key) => {
    const b = benchGet(key);
    const bench = b && b.s !== "skip" && Number.isFinite(b.a) ? b : null;
    const o = Object.hasOwn(models, key) && validRec(models[key]) ? models[key] : null;
    return o && (!bench || o.a > bench.a) ? o : bench;
  };
  const put = (key, rec) => { models[key] = rec; written.set(key, rec.s); };
  const seenIds = new Set();

  for (const e of events) {
    if (dropped.has(e)) continue;
    if (e.q && seenIds.has(e.q)) { bump("dupId"); continue; }
    if (e.q) seenIds.add(e.q);
    // A 200 or a hard failure ends any pending ambiguous failure, even when the event itself turns out to be stale.
    if (e.kind === "ok" || e.kind === "hard") delete pend[e.key];
    const eff = effOf(e.key);
    if (eff && e.a <= eff.a) { bump("stale"); continue; }        // a record at least as new is already there: newer wins
    const base = { d: e.d, a: e.a, q: e.q, l: 1 };

    if (e.kind === "ok") {
      delete pend[e.key];
      if (eff && eff.s === "ok") { bump("okSeen"); continue; }   // ok over ok would only replace a real reply preview with nothing
      const flip = eff && e.provider !== "anthropic";           // never benched -> no confirmation; the subscription route is never probed
      put(e.key, { s: "ok", ...base, o: e.o, ...(flip ? { cf: 1, cfa: nowS } : {}) });
      if (flip) confirm.push(e.key);
      continue;
    }

    if (e.kind === "hard") {
      delete pend[e.key];
      if (eff && eff.s === e.s && (eff.m ?? "") === e.m && e.a - eff.a <= HOLD_S) { bump("dup"); continue; }
      put(e.key, { s: e.s, ...base, m: e.m });
      continue;
    }

    // ambiguous: TWO failures, at least 2 minutes apart (no bucket clause: 1 s across a boundary is still a retry), at most 24 h apart, no 200 between
    if (eff && (eff.s === "error" || eff.s === "timeout")) {
      delete pend[e.key];
      if (eff.s === e.s && e.a - eff.a <= HOLD_S) { bump("dup"); continue; }
      put(e.key, { s: e.s, ...base, m: e.mOverride ?? e.m });
      continue;
    }
    const p = pend[e.key];
    if (!p || e.a - p.a > PEND_MAX_S || e.a < p.a) { pend[e.key] = { n: 1, s: e.s, a: e.a, q: e.q }; bump("pending"); continue; }
    if (e.q === p.q) { bump("dupId"); continue; }
    if (e.a - p.a < RETRY_GAP_S) { bump("retry"); continue; }                     // a retry burst: not counted, the first failure stays
    delete pend[e.key];
    put(e.key, { s: e.s, ...base, m: e.mOverride ?? `2 failures >= 2 min apart, no 200 between: HTTP ${e.status}` });
  }
  return { skip, confirm, written: [...written].map(([key, s]) => ({ key, s })) };
}

// ------------------------------------------------------------------ overlay maintenance

/** Prune (plan C): unknown keys, entries not newer than the probe record, older than 14 days, then above 800 the oldest. */
export function pruneOverlay({ models, pend, conf }, { routeSet, benchGet, nowS }) {
  for (const [k, r] of Object.entries(models)) {
    const b = benchGet(k);
    const bench = b && b.s !== "skip" && Number.isFinite(b.a) ? b : null;
    if (!validRec(r) || !routeSet.has(k) || (bench && bench.a >= r.a) || nowS - r.a > BENCH_FRESH_MS / 1000) delete models[k];
  }
  const keys = Object.keys(models);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((x, y) => models[x].a - models[y].a);
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete models[k];
  }
  for (const [k, p] of Object.entries(pend)) if (!p || !Number.isFinite(p.a) || nowS - p.a > PEND_MAX_S) delete pend[k];
  for (const [k, t] of Object.entries(conf)) if (!Number.isFinite(t) || nowS - t > CONF_KEEP_S) delete conf[k];
}

/**
 * The merged view level 1 uses: `loadBench`'s own rule, per key. `benchGet` is the PROBE reader (`loadBench(file, { observed: false }).probe`).
 * The overlay record wins when it is usable (not in the future) and the probe record is missing, a `skip` (not a measurement),
 * in the future, or OLDER; a tie goes to the probe. `stamp` is probe-only (age credit).
 */
export function mergedView(benchGet, models, nowMs = Date.now()) {
  const future = (a) => a * 1000 - nowMs > FUTURE_SKEW_MS;
  const pick = (target) => {
    const k = benchKeyOf(target);
    const b = benchGet(k);
    const p = b && b.s !== "skip" && Number.isFinite(b.a) && !future(b.a) ? b : null;
    const o = Object.hasOwn(models, k) ? cleanRecord(models[k]) : null;
    if (o && Number.isFinite(o.a) && !future(o.a) && (!p || o.a > p.a)) return { rec: o, live: true };
    return b ? { rec: b, live: false } : null;
  };
  const get = (target) => pick(target)?.rec ?? null;
  get.stamp = (target) => (typeof benchGet.stamp === "function" ? benchGet.stamp(target) : null);
  get.records = Object.keys(models).length;
  get.isLive = (target) => !!pick(target)?.live;
  return get;
}

/**
 * SEAM (picker agent's file). `bakeBench(row, get, nowMs)` is the recount `buildSnapshot` uses; it is imported from
 * `menu/snapshot.mjs` (or `menu/bench-data.mjs`) when one of them exports it, and is null until then. Without it the
 * overlay carries `models` only and no `prov` key.
 */
export async function findBakeBench() {
  for (const p of ["../menu/snapshot.mjs", "../menu/bench-data.mjs"]) {
    try { const m = await import(p); if (typeof m.bakeBench === "function") return m.bakeBench; } catch { /* not there */ }
  }
  return null;
}

/** Per-provider baked fields for every snapshot row that has at least one overlay record: `{ [keyId]: { bench, benchFlags, benchAgeHist, live, liveOk } }`.
 * `live` = routes whose winning record is a live observation (verified or not); `liveOk` = of those, the UNVERIFIED oks (no `v:1`). */
export function buildProv(rows, models, benchGet, bake, nowMs) {
  const get = mergedView(benchGet, models, nowMs);
  const prov = {};
  for (const r of rows) {
    if (!r?.keyId || !(r.models ?? []).some((m) => Object.hasOwn(models, benchKey(r.provider, m?.id ?? "")))) continue;
    const baked = bake(r, get, nowMs);
    let live = 0, liveOk = 0;
    for (const m of r.models ?? []) {
      const t = benchKey(r.provider, m?.id ?? "");
      const rec = get(t);
      if (!rec || !get.isLive(t)) continue;
      live += 1;
      // A probe-confirmed record (v:1) is a probe measurement now (the picker draws it lowercase): it is not an unverified live ok.
      if (rec.s === "ok" && models[t]?.v !== 1) liveOk += 1;
    }
    prov[r.keyId] = { bench: baked.bench, benchFlags: baked.benchFlags, benchAgeHist: baked.benchAgeHist, live, liveOk };
  }
  return prov;
}

// ------------------------------------------------------------------ the run

const emptyOverlay = () => ({ schema: OVERLAY_SCHEMA, feed: "ok", wm: null, tagId: null, models: {}, pend: {}, conf: {}, confDay: { d: null, n: 0 } });

const asObj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const asConfDay = (v) => ({ d: typeof v?.d === "string" ? v.d.slice(0, 10) : null, n: Number.isInteger(v?.n) && v.n >= 0 ? v.n : 0 });
const asHold = (v) => (Number.isFinite(v) ? v : null);

/** An overlay read from disk, made safe to work on: a hand-edited or damaged file cannot make the engine throw (`pend: null`, `conf: []` ...). */
function sanitizeOverlay(o) {
  const hold = asHold(o.confHold);
  return { ...emptyOverlay(), ...o, models: asObj(o.models), pend: asObj(o.pend), conf: asObj(o.conf), confDay: asConfDay(o.confDay),
           ...(hold !== null ? { confHold: hold } : {}) };
}

/**
 * The overlay file: `{ overlay }` (null when it does not exist, is torn or is another schema: a first run) or `{ error }` when it
 * could not be READ (EBUSY, EPERM, antivirus): that is not a first run, and treating it as one would reset the watermark and
 * drop every live record.
 */
export function readOverlayChecked(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return e?.code === "ENOENT" ? { overlay: null } : { error: e?.code ?? "read-error" }; }
  let o = null;
  try { o = JSON.parse(text.replace(/^﻿/, "")); } catch { return { overlay: null }; }
  return { overlay: o && o.schema === OVERLAY_SCHEMA && o.models && typeof o.models === "object" ? o : null };
}

/** The overlay file as an object, or null when it is missing, unreadable, torn or another schema. */
export function readOverlay(file) {
  return readOverlayChecked(file).overlay;
}

/** The snapshot's rows with anything unusable removed (a null row, `models` that is not an array), so no loop below can throw on it. */
export function normalizeSnapshot(snap) {
  const rows = [];
  for (const r of Array.isArray(snap?.rows) ? snap.rows : []) {
    if (!r || typeof r !== "object" || typeof r.provider !== "string") continue;
    rows.push({ ...r, models: (Array.isArray(r.models) ? r.models : []).filter((m) => m && typeof m === "object") });
  }
  return { ...snap, rows };
}

const isoOf = (ms) => new Date(ms).toISOString();

/** The overlay's fixed key order (plan C, as implemented): what is compared and what is written. */
const strip = ({ schema, feed, prov, wm, tagId, models, pend, conf, confDay, confHold }) => ({ schema, feed, ...(prov ? { prov } : {}), wm, tagId, models, pend, conf, confDay,
  ...(Number.isFinite(confHold) ? { confHold } : {}) });

/** Write `content` (stamped with `writtenAt`) only when it differs from `existing`. Returns whether it changed; throws when the write cannot land. */
function commitOverlay(file, existing, content, nowMs, dry = false) {
  const { writtenAt: _w, ...prevRest } = existing ?? {};
  if (existing && canon(prevRest) === canon(content)) return false;
  if (dry) return true;
  const r = writeAtomicRetry(file, JSON.stringify({ schema: content.schema, writtenAt: isoOf(nowMs), ...content }));
  if (!r.ok) throw new Error(`overlay not written (${r.error})`);
  return true;
}

function seqOf(db) {
  try { const r = db.prepare("select seq from sqlite_sequence where name = 'usage_events'").get(); return Number.isFinite(r?.seq) ? r.seq : null; }
  catch { return null; }
}
const one = (db, sql, ...p) => { try { return db.prepare(sql).get(...p) ?? null; } catch { return null; } };

/** Has the router's table been reset or rebuilt under our watermark? (plan G) */
function wasReset(db, wm, maxId, seq) {
  if (wm.id > maxId) return true;
  if (wm.at) {
    const r = one(db, "select created_at from usage_events where id = ?", wm.id);
    if (r && r.created_at !== wm.at) return true;
  }
  return Number.isFinite(seq) && Number.isFinite(wm.seq) && seq < wm.seq;
}

/** First run: where the watermark starts (plan A). Untagged history is NOT read unless `backfillDays` asks for it. */
function initialWatermark(db, { probeClient, backfillDays, nowMs, maxId }) {
  // FIRST RUN ONLY: `created_at >= ?` plans as a scan, which is fine once (about a millisecond per 10k rows) and never repeats: after it the id is the watermark.
  const idAtOrAfter = (days) => one(db, "select id from usage_events where created_at >= ? order by id limit 1", isoOf(nowMs - days * 86400000))?.id ?? null;
  let startId;                                    // the first id to read; null = read nothing yet
  const tagged = one(db, "select min(id) as id from usage_events where client = ?", probeClient)?.id ?? null;
  if (Number.isInteger(backfillDays) && backfillDays > 0) startId = idAtOrAfter(backfillDays);
  else if (tagged !== null) { const inWindow = idAtOrAfter(OLD_TAG_WINDOW_DAYS); startId = inWindow === null ? null : Math.max(tagged, inWindow); }   // no row in 3 days: start at the end
  else startId = null;
  const id = startId === null ? maxId : Math.max(0, startId - 1);
  const at = one(db, "select created_at from usage_events where id = ?", id)?.created_at ?? null;
  return { wm: { id, seq: seqOf(db), at }, tagId: tagged };
}

/**
 * One catch-up. Never throws for a feed problem (`feed` says what happened). `dry` computes everything and writes
 * nothing: no overlay, no run file, no lock, no temp sweep.
 *
 * Options are the test seams (temp directories, a fixed clock, small batches); the defaults are the real paths.
 * Returns `{ ok, skipped?, feed, examined, ms, wm, skip, wouldWrite, wrote, reset, error }`.
 */
export async function runCatchup({
  stateDir = path.dirname(BENCH_FILE), snapshotFile = SNAPSHOT_FILE, benchFile = path.join(stateDir, "bench.json"),
  usageDb = routerUsageDb(), logsDb = routerLogsDb(), dry = false, backfillDays = null, nowMs = Date.now(),
  batchSize = BATCH_ROWS, budgetMs = BUDGET_MS, maxRows = MAX_ROWS, clock = () => performance.now(), bake,
  spawn = childSpawn, confirmCeiling,
} = {}) {
  const t0 = clock();
  const P = observePaths(stateDir);
  const nowS = Math.floor(nowMs / 1000);
  const ms = () => Math.round(clock() - t0);
  const prevRun = readJsonOr(P.run, {}) ?? {};
  // Stamp the run FIRST. The picker's launcher throttles on this file's mtime, so a run that ends early (a bad snapshot, an
  // unreadable overlay, a feed problem, a busy lock, a crash) must still move it, or every open would spawn another child. The stamp
  // keeps everything else the file said (last error, counts) so a crash leaves the previous facts, with the new time.
  if (!dry) {
    try { fs.mkdirSync(P.dir, { recursive: true }); writeAtomicRetry(P.run, JSON.stringify({ ...asObj(prevRun), ranAt: isoOf(nowMs) })); } catch { /* bookkeeping only */ }
  }
  const finishRun = (extra) => {
    if (dry) return;
    try { writeAtomicRetry(P.run, JSON.stringify({ ranAt: isoOf(nowMs), ms: ms(), error: null, lockedRuns: 0, ...extra })); } catch { /* bookkeeping only */ }
  };

  const snap = loadSnapshot(snapshotFile);
  if (!snap.ok) {
    const error = `no usable snapshot (${snap.reason})`;
    finishRun({ error });
    return { ok: false, feed: "unavailable:snapshot", error, examined: 0, ms: ms(), skip: {}, wouldWrite: [], wrote: false };
  }
  let snapshot, routeSet, byProvider;
  try {
    snapshot = normalizeSnapshot(snap.snap);
    routeSet = new Set();
    byProvider = new Map();
    for (const r of snapshot.rows) for (const m of r.models) {
      const k = benchKey(r.provider, m.id ?? "");
      routeSet.add(k);
      (byProvider.get(r.provider) ?? byProvider.set(r.provider, []).get(r.provider)).push(k);
    }
  } catch (e) {
    const error = `unusable snapshot (${String(e?.message ?? e).slice(0, 100)})`;
    finishRun({ error });
    return { ok: false, feed: "unavailable:snapshot", error, examined: 0, ms: ms(), skip: {}, wouldWrite: [], wrote: false };
  }

  let lock = null;
  if (!dry) {
    fs.mkdirSync(P.dir, { recursive: true });
    sweepTmp(P.dir, nowMs);
    lock = acquireLock({ file: P.lock, findRunning: () => [], maxMinutes: 2, marginMs: 60000 });
    if (!lock.ok) return { ok: true, skipped: "locked", feed: null, examined: 0, ms: ms(), skip: {}, wouldWrite: [], wrote: false };
  }
  try {
    const read = readOverlayChecked(P.overlay);
    if (read.error) {
      finishRun({ error: `overlay-unreadable: ${read.error}`, reason: "overlay-unreadable" });
      return { ok: true, skipped: "overlay-unreadable", feed: null, examined: 0, ms: ms(), skip: {}, wouldWrite: [], wrote: false };
    }
    const existing = read.overlay;
    const overlay = existing ? sanitizeOverlay(existing) : emptyOverlay();

    const writeOverlay = (content) => commitOverlay(P.overlay, existing, content, nowMs, dry);

    // ---- open and check
    const feedOnly = (feed, extra = {}) => {
      const keep = existing || feed === "unavailable:schema" || feed === "unavailable:node-sqlite";
      const wrote = keep ? writeOverlay(strip({ ...overlay, feed })) : false;
      finishRun({ error: null, feed, wrote, lockedRuns: feed === "unavailable:locked" ? (prevRun.lockedRuns ?? 0) + 1 : 0, ...extra });
      return { ok: true, feed, examined: 0, ms: ms(), wm: overlay.wm, skip: {}, wouldWrite: [], wrote, ...extra };
    };
    const src = openUsage({ usageDb, logsDb });
    if (!src.ok) {
      if (src.feed === "unavailable:locked" && (prevRun.lockedRuns ?? 0) + 1 < LOCKED_RUNS_BEFORE_NOTE) {
        finishRun({ error: null, feed: src.feed, lockedRuns: (prevRun.lockedRuns ?? 0) + 1 });
        return { ok: true, feed: src.feed, examined: 0, ms: ms(), wm: overlay.wm, skip: {}, wouldWrite: [], wrote: false, detail: src.detail };
      }
      return feedOnly(src.feed, src.missing ? { missing: src.missing } : src.detail ? { detail: src.detail } : {});
    }

    try {
      const db = src.db;
      const maxId = one(db, "select max(id) as id from usage_events")?.id ?? 0;
      const seq = seqOf(db);
      let reset = false;
      let wm = overlay.wm && Number.isInteger(overlay.wm.id) ? overlay.wm : null;
      let tagId = overlay.tagId ?? null;
      if (wm && wasReset(db, wm, maxId, seq)) { reset = true; wm = null; }
      if (!wm) {
        const init = initialWatermark(db, { probeClient: CCR.probeClient, backfillDays, nowMs, maxId });
        wm = init.wm;
        tagId = tagId ?? init.tagId;
      }

      const benchGet = loadBench(benchFile, { observed: false }).probe;
      const ctx = { routeSet, probeClient: CCR.probeClient, nowS };
      const stmt = db.prepare(`select ${USAGE_COLS.join(", ")} from usage_events where id > ? order by id limit ?`);
      const events = [];
      const skip = {};
      const bump = (k) => { skip[k] = (skip[k] ?? 0) + 1; };
      let examined = 0, lastRow = null, nonAnthropic = 0, unknownNonAnthropic = 0;
      let cursor = wm.id;
      while (examined < maxRows) {
        const rows = stmt.all(cursor, batchSize);
        if (!rows.length) break;
        const wanted = [];
        for (const row of rows) {
          const t = triage(row, ctx);
          if (row.client !== CCR.probeClient && row.provider && row.provider !== "anthropic") { nonAnthropic += 1; if (t.skip === "unknownKey") unknownNonAnthropic += 1; }
          if (t.skip) { bump(t.skip); if (t.skip === "probe" && tagId === null) tagId = row.id; }
          else if (t.want) wanted.push(String(row.request_id));
        }
        const text = readFailureText(src.logs, wanted.slice(0, MAX_TEXT_IDS));
        for (const row of rows) {
          const ev = classifyEvent(row, text.get(String(row.request_id)) ?? null, ctx);
          if (ev.skip) { if (ev.skip !== "probe" && ev.skip !== "unknownKey" && ev.skip !== "abort499" && ev.skip !== "otherStatus" && ev.skip !== "skew" && ev.skip !== "badRow") bump(ev.skip); }
          else events.push(ev);
        }
        examined += rows.length;
        lastRow = rows[rows.length - 1];
        cursor = lastRow.id;
        if (rows.length < batchSize || clock() - t0 > budgetMs) break;
      }
      if (lastRow) wm = { id: lastRow.id, seq, at: lastRow.created_at };
      else wm = { ...wm, seq: wm.seq ?? seq };

      // ---- state machine
      events.sort((x, y) => x.a - y.a || x.id - y.id);
      const models = structuredClone(overlay.models);
      const pend = structuredClone(overlay.pend);
      const conf = structuredClone(overlay.conf);
      const providerOkRecent = (prov) => (byProvider.get(prov) ?? []).some((k) => {
        const b = benchGet(k), o = models[k];
        return [b, o].some((r) => r && r.s === "ok" && Number.isFinite(r.a) && nowS - r.a <= PROVIDER_OK_DAYS * 86400);
      });
      const applied = applyEvents(events, { models, pend, benchGet, providerOkRecent, nowS });
      for (const [k, n] of Object.entries(applied.skip)) skip[k] = (skip[k] ?? 0) + n;
      pruneOverlay({ models, pend, conf }, { routeSet, benchGet, nowS });

      const feed = nonAnthropic >= TRIPWIRE_MIN_ROWS && unknownNonAnthropic / nonAnthropic > 0.5 ? "warn:key-mapping" : "ok";
      const bakeFn = bake === undefined ? await findBakeBench() : bake;
      let prov = null;
      let provError = null;
      if (bakeFn) {
        try { prov = buildProv(snapshot.rows, models, benchGet, bakeFn, nowMs); }
        catch (e) { provError = `prov not baked: ${String(e?.message ?? e).slice(0, 100)}`; }
      }
      // C4: which failing -> ok flips get ONE confirmation probe. The reservation (conf, confDay) is part of the SAME write as the
      // records, so it is on disk before any child exists; a dry run computes it and reserves nothing.
      const confDay = structuredClone(overlay.confDay ?? { d: null, n: 0 });
      const req = await requestConfirms({ models, conf, confDay, hold: overlay.confHold, snapshot, nowS, stateDir, ceiling: confirmCeiling });
      const content = strip({ schema: OVERLAY_SCHEMA, feed, prov, wm, tagId, models, pend, conf, confDay: req.confDay, confHold: overlay.confHold > nowS ? overlay.confHold : null });
      const changed = writeOverlay(content);
      const spawned = dry ? [] : spawnConfirms(req.keys, { spawn }).spawned;
      const wouldWrite = applied.written.filter((w) => Object.hasOwn(models, w.key));
      finishRun({ error: provError, feed, examined, wm, skip, written: wouldWrite.length, wrote: changed, lockedRuns: 0, reset, provSeam: !!bakeFn, confirm: applied.confirm.length, confirmSpawned: spawned.length, confirmSkip: req.skip });
      return { ok: true, feed, examined, ms: ms(), wm, skip, wouldWrite, confirm: applied.confirm, confirmWould: req.keys, confirmSpawned: spawned, confirmSkip: req.skip, wrote: changed && !dry, changed, reset,
               tagId, msgSource: src.logs ? (src.logs === src.db ? "usage-db" : "request-log-db") : "none", provSeam: !!bakeFn, error: provError,
               overlay: content };
    } finally { src.close(); }
  } catch (e) {
    const error = String(e?.message ?? e).slice(0, 200);
    finishRun({ error });
    return { ok: false, feed: null, error, examined: 0, ms: ms(), skip: {}, wouldWrite: [], wrote: false };
  } finally { lock?.release?.(); }
}

// ==================================================================== C4: the confirmation probe (plan D)
//
// A failing -> ok flip seen in real use is a 200 with output tokens: proof of life, but not proof of an ANSWER (a provider can
// deliver a notice as a 200). ONE tiny probe of that one model, with OUR prompt, settles it. The catch-up decides and RESERVES
// (conf/confDay, in the same write as the records) and spawns detached children; a child probes and writes the result.

const CONFIRM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/[\]-]{0,200}$/;   // first character alphanumeric: a key can never look like a flag
const CONFIRM_PER_RUN = 3;
const CONFIRM_PER_DAY = 10;
const CONFIRM_KEY_HOLD_S = 6 * 3600;
const CONFIRM_FRESH_S = 3600;             // a flip older than this is not confirmed any more
const CONFIRM_RESERVED_S = 600;           // a child only starts on a reservation this young
const CONFIRM_LOCK_WAIT_MS = 3000;
const CONFIRM_MAX_TOKENS = 96;
const CONFIRM_TIMEOUT_MS = 45000;
const TRANSIENT_CLASSES = new Set(["rate", "timeout", "error"]);
const CLI_FILE = fileURLToPath(new URL("./observe-cli.mjs", import.meta.url));

export const isConfirmKey = (k) => typeof k === "string" && CONFIRM_KEY_RE.test(k) && !k.includes("..");

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The snapshot row (with its cost figures) of one key, or null: not listed, non-text or unroutable. */
function targetOf(snapshot, key) {
  for (const list of buildTargets(snapshot, { only: [key], maxTokens: CONFIRM_MAX_TOKENS }).values()) {
    const t = list.find((x) => x.key === key);
    if (t) return t;
  }
  return null;
}

const costOk = (t, ceiling) => t.free || (t.worst ?? t.cost) <= ceiling;

/**
 * Which flips to confirm, decided by the catch-up. Candidates are the overlay's `cf:1` records younger than an hour that
 * hold no reservation. Gates, in order: never `anthropic` (the subscription route: a probe spends quota), the key must be a
 * probeable row of the snapshot, a sweep must not be running (it re-probes the row anyway), one per key per 6 h, 10 per UTC day,
 * the worst-case row cost must fit `ceiling` ($0.01, the economy ceiling; free rows always fit), at most 3 per run. While `hold`
 * (an epoch second set by a child that found the gateway unreachable) is in the future, nothing is requested.
 * `conf` and `confDay` are updated IN PLACE for the admitted keys (the reservation). Returns `{ keys, confDay, skip }`.
 */
export async function requestConfirms({ models, conf, confDay, hold = null, snapshot, nowS, stateDir, ceiling }) {
  const skip = {};
  const bump = (k) => { skip[k] = (skip[k] ?? 0) + 1; };
  const cands = Object.entries(models)
    .filter(([, r]) => r && r.cf === 1 && r.s === "ok" && Number.isFinite(r.cfa) && nowS - r.cfa <= CONFIRM_FRESH_S)
    .sort((x, y) => y[1].cfa - x[1].cfa);
  const day = utcDay(nowS * 1000);
  const out = { keys: [], confDay, skip };
  if (!cands.length) return out;
  // A confirm child that could not reach the gateway asked for quiet: nothing is reserved (so nothing is rewritten) until it ends.
  if (Number.isFinite(hold) && nowS < hold) { skip.hold = cands.length; return out; }
  if (confDay.d !== day) { confDay.d = day; confDay.n = 0; }
  let sweeping = null;
  let limit = ceiling;
  for (const [key, rec] of cands) {
    if (Number.isFinite(conf[key]) && nowS - conf[key] < CONFIRM_KEY_HOLD_S) { bump("capKey"); continue; }
    if (key.startsWith("anthropic/")) { bump("anthropic"); continue; }
    if (!isConfirmKey(key)) { bump("badKey"); continue; }
    const t = targetOf(snapshot, key);
    if (!t) { bump("notRoutable"); continue; }
    sweeping ??= sweepStatus({ file: path.join(stateDir, "bench.lock"), findRunning: () => [] }).running;
    if (sweeping) { bump("sweep"); continue; }
    if (out.keys.length >= CONFIRM_PER_RUN) { bump("capRun"); continue; }
    if (confDay.n >= CONFIRM_PER_DAY) { bump("capDay"); continue; }
    limit ??= (await import("./bench-cli.mjs")).ECONOMY_DEFAULTS.maxRowCost;
    if (!costOk(t, limit)) { bump("cost"); continue; }
    conf[key] = nowS;
    confDay.n += 1;
    out.keys.push(key);
  }
  return out;
}

/**
 * Launch one detached child per key: `node --no-warnings observe-cli.mjs --confirm <key>`. Fixed argv, no shell, hard cap of
 * three, and every key must pass `isConfirmKey` (the caller has already matched it against the snapshot). `spawn` is injectable.
 * Never throws: a key whose spawn fails is returned in `failed`. The returned arrays are LIVE: a failure that arrives later (the child
 * process could not start) moves its key from `spawned` to `failed`.
 */
export function spawnConfirms(keys, { spawn = childSpawn, cli = CLI_FILE } = {}) {
  const spawned = [], failed = [];
  for (const key of keys ?? []) {
    if (!isConfirmKey(key)) { failed.push(key); continue; }
    if (spawned.length + failed.filter(isConfirmKey).length >= CONFIRM_PER_RUN) break;      // the hard cap counts valid keys only
    try {
      const child = spawn(process.execPath, ["--no-warnings", cli, "--confirm", key],
        { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      // An ASYNC spawn failure (ENOENT, EPERM) arrives as an 'error' event; without a listener it would be an uncaught exception.
      child?.on?.("error", () => {
        const i = spawned.indexOf(key);
        if (i >= 0) { spawned.splice(i, 1); failed.push(key); }
      });
      child?.unref?.();
      spawned.push(key);
    } catch { failed.push(key); }
  }
  return { spawned, failed };
}

/** `acquireLock` retried every `pollMs` for up to `waitMs`. Returns the lock result (`ok: false` when it never came). */
export function acquireLockRetry({ file, waitMs = CONFIRM_LOCK_WAIT_MS, pollMs = 100, sleep = sleepSync, now = Date.now } = {}) {
  const end = now() + waitMs;
  for (;;) {
    const got = acquireLock({ file, findRunning: () => [], maxMinutes: 2, marginMs: 60000 });
    if (got.ok || now() >= end) return got;
    sleep(pollMs);
  }
}

/**
 * The confirmation. `{ ok, outcome, reason?, s? }`; `outcome` is `confirmed` (the probe says ok: the record is the probe's),
 * `overruled` (the probe says otherwise: its class is the record), `kept` (a transient probe outcome: the live ok stays, the
 * flag is cleared), or `skipped` (nothing was probed; `reason` says why, and a reservation is handed back when the skip is
 * one that a later open can retry). One probe at most, through `probeOne`, never a second attempt.
 *
 * Test seams: `gateway` (`{ base, key }` or null), `health` (async base -> bool), `fetchImpl`, `probe`, `ceiling`, `sleep`.
 */
export async function runConfirm({
  key, stateDir = path.dirname(BENCH_FILE), snapshotFile = SNAPSHOT_FILE, benchFile = path.join(stateDir, "bench.json"),
  nowMs = Date.now(), bake, gateway, health, fetchImpl, probe = probeOne, ceiling, lockWaitMs = CONFIRM_LOCK_WAIT_MS, sleep = sleepSync,
} = {}) {
  const P = observePaths(stateDir);
  const nowS = Math.floor(nowMs / 1000);
  const skipped = (reason) => ({ ok: true, outcome: "skipped", reason });
  if (!isConfirmKey(key)) return skipped("bad-key");
  if (key.startsWith("anthropic/")) return skipped("anthropic");
  fs.mkdirSync(P.dir, { recursive: true });
  sweepTmp(P.dir, nowMs);

  const snap = loadSnapshot(snapshotFile);
  if (!snap.ok) return skipped("no-snapshot");
  const snapshot = normalizeSnapshot(snap.snap);
  const target = targetOf(snapshot, key);
  if (!target) return skipped("not-in-snapshot");
  const flip = (o) => o && o.models?.[key] && o.models[key].cf === 1 && o.models[key].s === "ok" && o.models[key].l === 1
    && Number.isFinite(o.models[key].cfa) && nowS - o.models[key].cfa <= CONFIRM_FRESH_S;
  const before = readOverlay(P.overlay);
  if (!flip(before)) return skipped("no-flip");
  if (!(Number.isFinite(before.conf?.[key]) && nowS - before.conf[key] <= CONFIRM_RESERVED_S)) return skipped("not-reserved");

  const bakeFn = bake === undefined ? await findBakeBench() : bake;
  // Under the overlay lock, read-modify-write. `fn(overlay)` returns the new content or null (nothing to write).
  const update = (fn) => {
    const got = acquireLockRetry({ file: P.lock, waitMs: lockWaitMs, sleep });
    if (!got.ok) return { locked: false };
    try {
      const cur = readOverlay(P.overlay);
      if (!cur) return { locked: true, wrote: false };
      const content = fn(structuredClone(sanitizeOverlay(cur)));
      if (!content) return { locked: true, wrote: false };
      const benchGet = loadBench(benchFile, { observed: false }).probe;
      const prov = bakeFn ? buildProv(snapshot.rows, content.models, benchGet, bakeFn, nowMs) : null;
      return { locked: true, wrote: commitOverlay(P.overlay, cur, strip({ ...content, prov }), nowMs) };
    } finally { got.release(); }
  };
  // A skip that happened BEFORE any request was sent gives the reservation back, so the next open may try again.
  const release = (reason) => {
    update((o) => {
      delete o.conf[key];
      if (o.confDay?.d === utcDay(nowMs) && o.confDay.n > 0) o.confDay.n -= 1;
      o.confHold = nowS + HOLD_CONFIRM_S;             // back off: without this every open would reserve and release again
      return o;
    });
    return skipped(reason);
  };

  const limit = ceiling ?? (await import("./bench-cli.mjs")).ECONOMY_DEFAULTS.maxRowCost;
  if (!costOk(target, limit)) return skipped("cost");
  if (sweepStatus({ file: path.join(stateDir, "bench.lock"), findRunning: () => [] }).running) return release("sweep");
  const gw = gateway === undefined ? gatewayConnection() : gateway;
  if (!gw) return release("no-gateway");
  const up = health ?? (await import("./bench-cli.mjs")).gatewayUp;
  if (!(await up(gw.base, { retries: 0 }))) return release("gateway-down");

  const res = await probe({ url: `${gw.base}/v1/messages`, key: gw.key, model: key, maxTokens: CONFIRM_MAX_TOKENS, timeoutMs: CONFIRM_TIMEOUT_MS,
                            ...(fetchImpl ? { fetchImpl } : {}) });
  if (res?.aborted) return skipped("aborted");                    // the flip record stays; it shows as plain live after two minutes

  // The probe's word overrules the flip, except a TRANSIENT outcome (rate, error, timeout): a probe that timed out a minute after
  // a real 200 says nothing about that 200. A 200 that carried a notice (`http: 200`) is different: it proves the 200 was no answer.
  const transient = TRANSIENT_CLASSES.has(res?.s) && res?.http !== 200;
  const done = { outcome: res?.s === "ok" ? "confirmed" : transient ? "kept" : "overruled", s: res?.s };
  const wrote = update((o) => {
    const cur = o.models[key];
    if (!(cur && cur.cf === 1 && cur.s === "ok")) return null;      // a newer event replaced the flip meanwhile: the result is dropped
    if (transient) {
      const { cf: _c, cfa: _f, ...rest } = cur;
      o.models[key] = rest;
    } else {
      o.models[key] = { ...toStored(res), a: nowS, l: 1, v: 1, ...(cur.q ? { q: cur.q } : {}) };
    }
    o.conf[key] = nowS;
    return o;
  });
  return { ok: true, ...done, ...(wrote.locked ? {} : { reason: "lock-busy" }), wrote: !!wrote.wrote };
}

/** `--reset`: remove the overlay and the run file. Returns the names removed. The watermark lives in the overlay, so a new run starts fresh. */
export function resetObserved(stateDir) {
  const P = observePaths(stateDir);
  const removed = [];
  for (const f of [P.overlay, P.run]) {
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch { /* in use: the next reset retries */ }
  }
  return removed;
}

/** `--off` / `--on`: the sentinel. Returns whether the state changed. */
export function setObserveOff(stateDir, off) {
  const P = observePaths(stateDir);
  const was = fs.existsSync(P.off);
  if (off && !was) { fs.mkdirSync(P.dir, { recursive: true }); fs.writeFileSync(P.off, "observe disabled: remove this file or run observe-cli --on\n"); }
  if (!off && was) fs.rmSync(P.off, { force: true });
  return was !== off;
}

/** Everything `--status` prints, as data. Reads two small files; never opens a database. Every string in it came from a file, so every one is sanitized. */
export function observeStatus(stateDir) {
  const P = observePaths(stateDir);
  const overlay = readOverlay(P.overlay);
  const run = asObj(readJsonOr(P.run, null));
  const str = (v, n = 120) => (typeof v === "string" ? sanitizeDisplay(v, n) : null);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const wm = overlay?.wm && typeof overlay.wm === "object" ? { id: num(overlay.wm.id), at: str(overlay.wm.at, 40) } : null;
  const skip = run.skip && typeof run.skip === "object" && !Array.isArray(run.skip)
    ? Object.fromEntries(Object.entries(run.skip).filter(([, v]) => Number.isFinite(v)).slice(0, 30).map(([k, v]) => [sanitizeDisplay(k, 30), v])) : null;
  return {
    enabled: observeEnabled(stateDir),
    ranAt: str(run.ranAt, 40),
    lastError: str(run.error, 200),
    feed: str(overlay?.feed ?? run.feed, 40),
    wm,
    models: overlay ? Object.keys(asObj(overlay.models)).length : 0,
    pend: overlay ? Object.keys(asObj(overlay.pend)).length : 0,
    writtenAt: str(overlay?.writtenAt, 40),
    missing: Array.isArray(run.missing) ? run.missing.filter((c) => typeof c === "string").slice(0, 12).map((c) => sanitizeDisplay(c, 40)) : [],
    lastSkip: skip,
    lastExamined: num(run.examined),
    lockedRuns: num(run.lockedRuns) ?? 0,
    reset: !!run.reset,
  };
}

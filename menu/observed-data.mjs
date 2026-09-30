// The live-status OVERLAY reader: `state/observed.json`, the file the recorder (`refresh/observe*.mjs`) writes from the router's own
// usage log, that `loadBench` merges over bench.json. THIS FILE IS IN THE PICKER'S IMPORT GRAPH, so it imports only fs, path, os,
// `atomic.mjs` and `sanitize.mjs`, and it is PURE READING: it never writes, never takes a lock, never touches bench.json.
//
// What the file is not trusted for: everything. It is a file another process wrote and anyone can edit, so the reader is total (a
// missing, torn, oversized, wrong-schema or hostile file is `null`, never a throw), and every entry is rebuilt field by field from a
// closed vocabulary (statuses, numbers, capped sanitized text, the flags `l` `v` `cf`), so nothing it says can reach the terminal or
// move a column. Free text (`m`, `p`, `w`) is only length-capped and sanitized here; `cleanRecord` in bench-data.mjs redacts it again
// when a record is read, exactly as it does for bench.json.
//
// THE KILL SWITCH: the sentinel `observe.off`, in the same directory as the overlay. While it exists the overlay is IGNORED (the
// reader returns null), so a user can turn the feature off at any time without editing source. The feature is ON otherwise; with no
// observed.json nothing changes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonOr } from "./atomic.mjs";
import { sanitizeDisplay } from "./sanitize.mjs";

export const OBSERVED_SCHEMA = 1;
export const OBSERVED_FILE = path.join(os.homedir(), ".uw", "state", "observed.json");
/** Refuse a file bigger than this (the recorder caps itself near 200 KB; a runaway or hand-edited file is not read). */
export const OBSERVED_MAX_BYTES = 4 * 1024 * 1024;
/** Keep at most this many entries (the newest by `a`); the recorder prunes to 800. */
export const OBSERVED_MAX_ENTRIES = 1000;
/** The statuses an observation can carry: the bench vocabulary WITHOUT `skip` (nothing is "observed" as skipped); a test asserts the subset. */
export const OBSERVED_STATUSES = Object.freeze(["ok", "empty", "auth", "pay", "rate", "gone", "timeout", "error"]);
export const OBSERVED_FEEDS = Object.freeze(["ok", "warn:key-mapping", "unavailable:schema", "unavailable:missing", "unavailable:locked", "unavailable:node-sqlite"]);

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const KEY_MAX = 200;
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : undefined);
const text = (v, cap) => (typeof v === "string" && v ? sanitizeDisplay(v, cap) : "");

/** The sentinel beside an overlay file. */
export const observeOffFile = (file = OBSERVED_FILE) => path.join(path.dirname(file), "observe.off");
/** Whether the feature is on for this overlay file's directory: the sentinel is ABSENT. */
export function observeEnabled(file = OBSERVED_FILE) {
  try { return !fs.existsSync(observeOffFile(file)); } catch { return true; }
}

/**
 * One overlay entry as a record, or `null` when it is not one: an object with a known status and a positive finite `a` (epoch
 * seconds). Only known fields survive, each checked; `l` is forced to 1 (everything here was observed live), `q` is the request id.
 */
export function cleanObservedRecord(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!OBSERVED_STATUSES.includes(raw.s)) return null;
  if (!(typeof raw.a === "number" && Number.isFinite(raw.a) && raw.a > 0)) return null;
  const out = { s: raw.s, a: raw.a, l: 1 };
  for (const k of ["t", "d", "r", "o"]) { const v = num(raw[k]); if (v !== undefined) out[k] = v; }
  const p = text(raw.p, 120), m = text(raw.m, 160), w = text(raw.w, 20), q = text(raw.q, 40);
  if (p) out.p = p;
  if (m) out.m = m;
  if (w) out.w = w;
  if (q) out.q = q;
  if (raw.k === 1) out.k = 1;
  if (raw.x === 1) out.x = 1;
  const b = posInt(raw.b); if (b !== undefined) out.b = b;
  if (raw.v === 1) out.v = 1;
  if (raw.cf === 1) { out.cf = 1; const cfa = num(raw.cfa); if (cfa !== undefined) out.cfa = cfa; }
  return out;
}

const cleanCounts = (o) => {
  const out = {};
  if (!o || typeof o !== "object" || Array.isArray(o)) return out;
  for (const st of [...OBSERVED_STATUSES, "skip"]) { const v = o[st]; if (Number.isSafeInteger(v) && v >= 0) out[st] = v; }
  return out;
};
const cleanFlags = (f) => {
  if (!f || typeof f !== "object" || Array.isArray(f)) return null;
  const out = {};
  for (const k of ["dead", "needsMoney", "alive"]) if (typeof f[k] === "boolean") out[k] = f[k];
  out.status = ["alive", "down", "dead"].includes(f.status) ? f.status : null;
  return out;
};
const cleanHist = (h) => (Array.isArray(h) ? h.filter((e) => Array.isArray(e) && Number.isSafeInteger(e[0]) && e[0] > 0 && Number.isSafeInteger(e[1]) && e[1] > 0).map((e) => [e[0], e[1]]) : null);

/** `prov`: per key id the baked recount the recorder computed (`bench`, `benchFlags`, `benchAgeHist`, `live`, `liveOk`), rebuilt field by field. */
function cleanProv(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = new Map();
  for (const [id, v] of Object.entries(raw)) {
    if (!id || id.length > KEY_MAX || !v || typeof v !== "object") continue;
    out.set(id, { bench: cleanCounts(v.bench), benchFlags: cleanFlags(v.benchFlags), benchAgeHist: cleanHist(v.benchAgeHist),
                  live: Number.isSafeInteger(v.live) && v.live >= 0 ? v.live : 0, liveOk: Number.isSafeInteger(v.liveOk) && v.liveOk >= 0 ? v.liveOk : 0 });
  }
  return out;
}

/**
 * Read the overlay. `null` when the feature is off (the sentinel exists), or the file is missing, unreadable, over the size cap, not
 * JSON, another schema, or has no `models` object. Otherwise
 * `{ schema, writtenAt, feed, wm, prov, models, dropped }`: `models` is a `Map` (a hostile key such as `__proto__` is just a key) of
 * cleaned records keyed by the bench key, the newest `OBSERVED_MAX_ENTRIES` at most; `dropped` counts the entries that were refused.
 */
export function loadObserved(file = OBSERVED_FILE) {
  try {
    if (!observeEnabled(file)) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > OBSERVED_MAX_BYTES) return null;
  } catch { return null; }
  const raw = readJsonOr(file, null);
  if (!raw || typeof raw !== "object" || raw.schema !== OBSERVED_SCHEMA || !raw.models || typeof raw.models !== "object" || Array.isArray(raw.models)) return null;
  let entries = [];
  let dropped = 0;
  for (const [key, v] of Object.entries(raw.models)) {
    const rec = key && key.length <= KEY_MAX ? cleanObservedRecord(v) : null;
    if (rec) entries.push([key, rec]); else dropped += 1;
  }
  if (entries.length > OBSERVED_MAX_ENTRIES) {
    entries.sort((x, y) => y[1].a - x[1].a);
    dropped += entries.length - OBSERVED_MAX_ENTRIES;
    entries = entries.slice(0, OBSERVED_MAX_ENTRIES);
  }
  const wm = raw.wm && typeof raw.wm === "object" ? { id: posInt(raw.wm.id) ?? null, seq: posInt(raw.wm.seq) ?? null, at: typeof raw.wm.at === "string" && ISO.test(raw.wm.at) ? raw.wm.at : null } : null;
  return {
    schema: OBSERVED_SCHEMA,
    writtenAt: typeof raw.writtenAt === "string" && ISO.test(raw.writtenAt) ? raw.writtenAt : null,
    feed: OBSERVED_FEEDS.includes(raw.feed) ? raw.feed : "ok",
    wm, prov: cleanProv(raw.prov), models: new Map(entries), dropped,
  };
}

/**
 * The note the picker shows when the live feed cannot be trusted, or `null` (nothing to say). Words only; never quotes the file.
 * `writtenAt` is drawn as UTC `HH:MMZ`, the picker's own stamp style.
 */
export function feedNote(observed) {
  if (!observed) return null;
  const at = typeof observed.writtenAt === "string" && ISO.test(observed.writtenAt) ? `${observed.writtenAt.slice(11, 16)}Z` : null;
  switch (observed.feed) {
    case "warn:key-mapping": return "live feed: key mapping changed";
    case "unavailable:schema": return "live feed unavailable (schema changed)";
    case "unavailable:missing": return "live feed unavailable (no router data)";
    case "unavailable:node-sqlite": return "live feed unavailable (no node:sqlite)";
    case "unavailable:locked": return at ? `live feed: locked, showing the last update ${at}` : "live feed: locked";
    default: return null;
  }
}

/** The overlay file's modification time, or `null` when it is missing or cannot be read (a failing `stat` is "absent", never an error). */
export function fileMtime(file = OBSERVED_FILE, stat = fs.statSync) {
  try { return stat(file).mtimeMs; } catch { return null; }
}

/**
 * THE OPEN-TIME READ, in the right order: `stat` FIRST, then read, so a write that lands between the two is seen as a newer mtime on the next
 * keystroke instead of being lost. Returns `{ observed, mtime }`. When the file EXISTS but could not be read (torn mid-rename, wrong schema) and
 * the feature is on, `mtime` is `undefined`: it never equals a real one, so the very next keystroke tries again.
 */
export function openOverlay({ file = OBSERVED_FILE, stat = fs.statSync, load = loadObserved, enabled = observeEnabled } = {}) {
  const mtime = fileMtime(file, stat);
  let observed = null;
  try { observed = load(file); } catch { observed = null; }
  const unreadable = !observed && mtime !== null && enabled(file);
  return { observed, mtime: unreadable ? undefined : mtime };
}

/**
 * THE RELOAD DECISION, pure and injectable (the picker calls it once per keystroke; tests hand it a fake `stat`, `load` and `enabled`).
 * `prevMtime` is what the last successful load saw. Returns `{ kind, mtime, observed }`:
 *   same   the mtime did not change: nothing to do (any change, backwards included, counts as a change)
 *   apply  a new mtime and a readable overlay: use `observed`, remember `mtime`
 *   clear  the file is GONE, or the kill switch `observe.off` exists: the overlay is cleared, remember `mtime`
 *   keep   the file EXISTS and is switched on but did not read (torn, half-renamed, wrong schema): KEEP the previous state and do NOT advance
 *          `mtime` (it stays `prevMtime`), so the next keystroke tries again. A transient bad read must never blank the live data.
 */
export function decideOverlayReload(prevMtime, { file = OBSERVED_FILE, stat = fs.statSync, load = loadObserved, enabled = observeEnabled } = {}) {
  const mtime = fileMtime(file, stat);
  if (mtime === prevMtime) return { kind: "same", mtime, observed: null };
  let observed = null;
  try { observed = load(file); } catch { observed = null; }
  if (observed) return { kind: "apply", mtime, observed };
  if (mtime === null || !enabled(file)) return { kind: "clear", mtime, observed: null };
  return { kind: "keep", mtime: prevMtime, observed: null };
}

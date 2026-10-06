// UW subagent-policy router, VERSION 2: DEVELOPED here, never wired and never required from this location (plan 4, 6.7).
// Deployed only by copying the exact bytes to the live router file through the section 6.7 protocol. CCR deletes the
// require cache entry and re-requires this ENTRY file on every request, so:
//   - there is NO module-scope side effect apart from the loader at the very bottom: no file read, no timer, no throw, no top-level async work (a load-time
//     failure makes CCR send EVERY request down its policy chain toward the anchor). The loader does exactly ONE statSync of this file, ONE globalThis
//     lookup and ONE guarded splice of this module out of its parent's `children` list per load (S-F2, SEC-1 and O4b, below);
//   - EVALUATED ONCE PER PROCESS (S-F2): every re-require creates a Module that Node pushes onto its permanent parent's `children` list and never frees, so a
//     router body evaluated on every request leaked about 12.5 KB a request (about 370 MB after 30,000 requests). The whole body below lives in a factory; the
//     loader at the end evaluates it ONCE per process and stores the result on globalThis, keyed by this file's own identity (path, mtime, size, inode, plus the length and a
//     hash of the compiled source itself: `require` reads the bytes BEFORE the stat, so a file swapped in between must not pin the old code under the new identity, SEC-1), and a later
//     load only re-exports it. A changed file (a hot redeploy of new bytes) has a new identity, so its first load evaluates the new code and replaces the old entry:
//     no restart is needed. The body is NOT re-indented, so the diff to the previous bytes stays readable;
//   - state that must survive lives in `globalThis.__uwSub` (created lazily, bounded) and in files under STATE;
//   - state is derived from this file's own location (`..\state\subagent`), with NO environment override, so an ambient
//     variable can never redirect the live router and a test gets isolated state by running a COPY in a scratch tree;
//   - nothing on the request path blocks: every write is either one small append, a synchronous rename-free write, or an
//     ASYNC write with a per-file in-flight guard (a timer exists only inside the failure branch of a write, never at module scope).
// Contract (read from the CCR dist): called as (request, config, ctx); the returned STRING is the model. Every path here
// returns the model that was asked for, its exact-match slot rewrite, or a vetted selector; never `undefined` unless the
// request carried no model (the legacy answer). Section 6.1 of the plan is the pseudo-code this file implements.
//
// Version 2 (router review ar-1 .. ar-17): agent ids with `@`, sticky state as an in-memory authority plus an append-only journal,
// a lazy resolvability index and a scan that stops at K usable rows, banded spread, per-worker status, decision log v2 (agents.jsonl),
// version negotiation and a verified content hash, cross-worker main freshness, an inert rollout field, a tripwire over the first
// 200 enforced requests, and retry-driven handoff with a cooling ladder. The denominators of the counters that changed meaning:
//   ctxSkip, payloadSkip   rows LOOKED AT and skipped before the K-th usable row was found (the scan is lazy), not every row of the list
//   stickyNew              enforced decisions that stored an entry (a null-model outcome is never stored, ar-3a)
//   retry                  requests carrying a retry signal, counted in shadow and enforce: for an agent WITH an id an unchanged messages length within 120 s (retryLen); for a
//                          billing-only subagent (no id) the SDK's retry-count header (retryHdr). The header alone is never acted on for an agent with an id (S-F3, D6)
//   enforced               enforced subagent requests seen by THIS worker (the tripwire window denominator)
//   coolLimited            failures of a FIFTH or later DISTINCT model of one session within an hour: marked at rung 0 (2 minutes) only, never escalated (O1)
//   stickyJournalTorn      journal lines that were unparsable, skipped for length, or a torn last line (counted once per offset)
// R-v3 (owner batch 2026-10-06; ROUTER_VERSION stays 2: it is the compiled-policy format the compiler writes for, and this changes none of it): the main-first shortcut of
// pickSubstitute applies only when main's row is in the lead band (banding on); an unknown payload cap ranks last for a request above 200 KB (204,800 bytes; a pb-0 row whose bk covers the request is a known fit); classify.jsonl rotates at 8 MiB and
// keeps 2 generations, and each classify line carries hasSid and ua. The identity of a redeploy is the loader's stat of this file, so no constant needs a bump.
const __uwImpl = function (IMPL_ID) {                            // IMPL_ID: this file's identity (the loader's stat), "" when unknown
const module = { exports: {} };                                    // the body assigns module.exports; here it fills the factory's own object, the loader re-exports it
const fs = require("node:fs");
const path = require("node:path");

const ROUTER_VERSION = 2;
const SLOT = path.join(__dirname, "slot.json");
const STATE = path.join(__dirname, "..", "state", "subagent");

// Claude Code and CCR names, duplicated as literals because a .cjs cannot import menu/cc-contract.mjs; the contract test
// asserts they equal the constants there (the parent-agent and retry-count names are pinned by literal in the test).
const H_AGENT = "x-claude-code-agent-id";
const H_PARENT = "x-claude-code-parent-agent-id";
const H_SID = "x-claude-code-session-id";
const H_SID_ALT = "x-claude-session-id";
const H_CLASS = "x-claude-code-request-class";
const H_TYPE = "x-claude-code-agent-type";
const H_BETA = "anthropic-beta";
const H_LEN = "content-length";
const H_RETRY = "x-stainless-retry-count";
const H_UA = "user-agent";
const BETA_1M = "context-1m";
const TAG_OPEN = "<CCR-SUBAGENT-MODEL>";
const MARK = "[uw-subagent-policy";
const NOTICE_MARK = "[UW handoff]";
const AGENT_TOOLS = ["agent", "task"];

const STATE_VERSION = 3;
const POLICY_MAX = 1024 * 1024;
const STICKY_TTL = 6 * 3600 * 1000, STICKY_ABS = 24 * 3600 * 1000, TOUCH_MS = 600000;
const MAIN_TTL_DEFAULT = 6 * 3600 * 1000, MAIN_RECHECK_MS = 5000, FUTURE_SLACK_MS = 5 * 60 * 1000;
const CAPS = { sticky: 512, stickySession: 128, main: 64, mainStatus: 8, auxModels: 16, byModel: 64, seen: 2048, journals: 512, learned: 512 };
const LOG_MAX = 1024 * 1024, CLASS_MAX = 8 * 1024 * 1024;         // R-v3: classify.jsonl rotates at 8 MiB and keeps 2 generations: 3 files, 24 MiB for one writer, plus at most 50 lines (200 KiB) a file for every worker that appends (each checks the size on its own 50th append; a worker whose file another worker rotated reopens the path at that check), plus a stray claim file after a crash, removed by the next rotation after 10 minutes
const BIG_REQ = 200 * 1024, BK_MAX = 64 * 1024 * 1024;           // R-v3: ABOVE 200 KB (204,800 bytes, content-length > 204800) a row with an UNKNOWN payload cap ranks lowest in a substitute pick; a row field bk (bytes the tool sweep proved the model accepts) above BK_MAX is garbage and ignored
const LINE_MAX = 4096, ASKED_MAX = 160;                           // a client-controlled string is never stored, keyed or logged unbounded
const JOURNAL_COMPACT = 64 * 1024, JOURNAL_MAX = 1024 * 1024;
const JOURNAL_READ_CAP = 256 * 1024, JOURNAL_LINES_MAX = 8192, SYNC_EVERY_MS = 1500, COMPACT_PER_PASS = 2;   // per request: at most 256 KiB read from a journal (the next miss resumes); per session and process: at most 8,192 lines loaded
const GC_STEP = 8, JFD_MAX = 32, JFD_IDLE_MS = 60000;                    // SEC-5: a gc pass looks at (and so unlinks) at most GC_STEP directory entries a request; at most JFD_MAX journal descriptors stay open, each closed after JFD_IDLE_MS without an append
const SESSION_IDLE_MS = 3600000, WR_MAX = 64;                         // a session file is evicted only when idle this long; at most this many files with a write in flight or waiting
const COOL_SID = { models: 4, windowMs: 3600000, max: 256 };           // per session and hour: at most 4 DISTINCT models take part in the ladder (O1: there is no per-session escalation limit; the cooldown lengths pace the ladder)
const SUBSTITUTE_FLOOR = 128000, K = 3;
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_RE = /^[A-Za-z0-9_@.:-]{1,128}$/;                     // real team agent ids look like `name@session-1a2b3c4d`; only `sid` ever reaches a file name
const SESSION_FILE_RE = /^(main|agents)-[A-Za-z0-9_-]{1,64}\.(json|jsonl)$/;
const STATUS_FILE_RE = /^status-[0-9a-z]{1,13}\.json$/;
const SESSION_FILES_MAX = 256;                                    // main-<sid>.json plus agents-<sid>.jsonl: past the cap the OLDEST session file is removed for a new one
const SEL_LOG_RE = /^[A-Za-z0-9_./:@+[\]~-]{1,160}$/;
const TOOLS_SCAN_MAX = 1024;                                      // ceiling: an Agent or Task tool beyond the 1,024th entry is not seen (upgrade path: a larger cap, the scan is O(n))
const WATCH_N = 200;                                              // the tripwire watches the first 200 enforced requests of a worker
const HAND = { maxHour: 3, trailMax: 5, hourMs: 3600000, backMs: 1800000, lenWindowMs: 120000, ladder: [2 * 60000, 10 * 60000, 60 * 60000, 6 * 3600000], quietMs: 3600000, streakMs: 24 * 3600000, provMs: 5 * 60000, coolMax: 64 };
// the observer overlay (state/observed.json, written by refresh/observe*.mjs): per model `s` (status) and `a` (epoch SECONDS of the observation). A model marked rate
// within 2 h, or pay or auth within 24 h, is demoted for new decisions and handoff picks (the same demotion as cooling).
const OV = { max: 1024 * 1024, entries: 1000, ages: { rate: 2 * 3600000, pay: 24 * 3600000, auth: 24 * 3600000 } };
// The owner fields that steer only HOW the router behaves are outside the hashed owner block (keysync/subagent-policy.mjs HASH_OWNER_EXCLUDE; a test pins the lists equal).
const HASH_KEYS = ["schema", "owner", "empty", "emptyProviders", "thinProviders", "tiers", "substitutable", "exempt", "ctxHints", "models", "lists"];
const HASH_OWNER_EXCLUDE = ["enforcement", "classLog", "handoffNotice"];
const LAT_EDGES = [0.1, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128];  // ms; 12 buckets, the last is everything above 128 ms
const COUNTERS = ["req", "main", "sub", "aux", "keep", "honourTag", "substitute", "inherit", "emptySet", "unknownMain", "unresolvable", "rejectUnresolvable",
  "error", "slotError", "injected", "detectorDisagree", "ctxUndelivered", "ctxSkip", "payloadSkip", "payloadUnknown", "stickyHit", "stickyNew", "stickyEvict",
  "policyBad", "slowReq", "auxOnRelay", "freeBreak", "blNoAgentId",
  "agentIdOdd", "journalFail", "journalCap", "logDropped", "retry", "stickyOverflow", "stickyCapEvict", "stickyNone", "enforced", "autoRollback",
  "handoff", "handoffNone", "handoffCap", "handoffWould", "noticeApplied", "noticeFail", "asyncWriteFail", "overlayBad",
  "retryHdr", "retryLen", "stickyJournalTorn", "stickyOut", "coolMark", "coolProvider", "coolLimited", "coolDemote", "overlayDemote", "sessionFileSkip"];
const RC_SET = ["main", "subagent", "workflow", "compaction", "auxiliary"];
// kind -> file, size cap, lines per second (burst 200), rotated generations kept
const LOGS = { d: { name: "decisions.jsonl", max: LOG_MAX, rate: 50, gens: 1 }, c: { name: "classify.jsonl", max: CLASS_MAX, rate: 50, gens: 2 },
  a: { name: "agents.jsonl", max: LOG_MAX, rate: 20, gens: 3 } };
const BURST = 200;

// Test seam (cr-M10): hangs off the exported function, unreachable by CCR (it calls only the function). `now` defaults to a
// MONOTONIC clock (wall time captured once, then advanced by performance.now()), so a wall-clock jump never ages or revives an entry.
const seam = { now: monoNow, fs, reset, flush: () => flushStatus(true, null, true) };
const nowMs = () => seam.now();
function monoNow() { return S().base + performance.now(); }
const workerId = () => process.pid.toString(36);

// SEC-2: the state object carries its own SHAPE (the ordered key list of a fresh one). A hot redeploy of code that adds, drops or renames a state field WITHOUT bumping
// STATE_VERSION would otherwise run the new code on an old-shaped object (a missing Map is a TypeError on the first request, then a tripwire trip). The version AND the shape
// are compared; either differing resets the state exactly like a version bump.
function freshState() {
  const counters = {};
  for (const k of COUNTERS) counters[k] = 0;
  const t = Date.now() - performance.now();
  return { v: STATE_VERSION, shape: "", base: t, main: new Map(), agent: new Map(), sessN: new Map(), logOnce: new Set(), warnings: new Map(), counters, matrix: {}, aux: new Map(), cache: null,
    calls: 0, appends: { d: 0, c: 0, a: 0 }, fds: { d: null, c: null, a: null }, bucket: { d: { tok: BURST, t: -1 }, c: { tok: BURST, t: -1 }, a: { tok: BURST, t: -1 } }, logDownUntil: 0,
    statusAt: 0, warnVer: 0, warnSeen: -1, since: null, mainBySession: new Map(), mainWrite: new Map(), gcAt: 0, jrn: new Map(), wr: new Map(), files: null, dirOk: false,
    cool: new Map(), coolSid: new Map(), learned: new Map(), coolKey: null, coolChk: -Infinity, ov: null, ovKey: null, ovChk: -Infinity, seen: new Map(), byModel: new Map(), byProvider: new Map(), lastP: null, hand: [], sidChk: new Map(), gcJob: null,
    lat: { new: new Array(12).fill(0), sticky: new Array(12).fill(0), shadow: new Array(12).fill(0), aux: new Array(12).fill(0) },
    enforced: 0, enforceOn: false, tripped: false, hadFlag: false, errTimes: [], impl: "" };
}
let SHAPE = null;                                                  // computed once per evaluation of this body, from a fresh state object
function S() {
  const g = globalThis;
  if (SHAPE === null) SHAPE = Object.keys(freshState()).join(",");
  if (!g.__uwSub || typeof g.__uwSub !== "object" || g.__uwSub.v !== STATE_VERSION || g.__uwSub.shape !== SHAPE) {
    const old = g.__uwSub;                                         // state of an older router in a long-lived worker: close what it held open, start clean
    closeAll(old);
    const fresh = freshState();
    fresh.shape = SHAPE; fresh.impl = IMPL_ID;
    g.__uwSub = fresh;
  }
  const st = g.__uwSub;
  if (st.impl !== IMPL_ID) { st.impl = IMPL_ID; st.cache = null; st.coolKey = null; st.ovKey = null; }   // new code (a hot redeploy) keeps the counters and sticky state but re-derives what it cached under the old rules (the policy verdict, the cooling and overlay views)
  return st;
}
// Closes every descriptor a state object holds (the log files); anything unexpected about an OLD object is ignored.
function closeAll(old) {
  try { if (old && old.fds) for (const k of Object.keys(old.fds)) { const f = old.fds[k]; if (f) { try { seam.fs.closeSync(f.fd); } catch { /* already closed */ } } } } catch { /* an old, differently shaped object */ }
  try { if (old && old.jrn) for (const j of old.jrn.values()) closeJfd(j); } catch { /* an old, differently shaped object */ }
}
function reset() {
  closeAll(globalThis.__uwSub);
  delete globalThis.__uwSub;
}
function count(k, n = 1) { const c = S().counters; c[k] = (c[k] || 0) + n; }
function warn(code, detail) {
  const w = S().warnings;
  if (!w.has(code)) { w.set(code, { since: new Date(nowMs()).toISOString(), detail: detail ? String(detail).slice(0, 120) : undefined }); S().warnVer += 1; }
}
function warnSet(code, detail) {                                    // like warn, but the detail follows the latest event (the first `since` is kept); only a NEW code forces a status flush, a new detail is written with the next one (at most 5 s later)
  const st = S(), w = st.warnings, d = detail ? String(detail).slice(0, 120) : undefined, cur = w.get(code);
  if (!cur) { w.set(code, { since: new Date(nowMs()).toISOString(), detail: d }); st.warnVer += 1; } else if (cur.detail !== d) cur.detail = d;
}

// ---------------------------------------------------------------- small pure helpers
const providerOf = (sel) => { const s = String(sel || ""); const i = s.indexOf("/"); return i < 0 ? s : s.slice(0, i); };
// S-F5: lower-cased, for the map key AND the file name: NTFS is case-insensitive, so `S1` and `s1` are ONE file and must be one session.
const cleanSid = (v) => (typeof v === "string" && SID_RE.test(v) ? v.toLowerCase() : "nosession");
const logSel = (v) => (typeof v === "string" && v.length <= ASKED_MAX && SEL_LOG_RE.test(v) ? v : "?");
// A key taken from a client-controlled string (a model, a provider, a session) is read ONLY as an own property: "__proto__",
// "constructor", "toString" and "hasOwnProperty" are valid selectors and must never reach Object.prototype or a method.
const own = (o, k) => (o && typeof o === "object" && typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const hdr = (h, k) => { const v = h[k]; return typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : ""; };
const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n) : String(s));

function fnv1a32(str) {
  let h = 2166136261;
  const b = Buffer.from(String(str), "utf8");
  for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// An agent id of a real team agent, or a hash of one that fails the charset: a header that is PRESENT is always an agent, never absent (an absent
// id would make the request look like main). The hash key starts with `~`, which no valid id contains, so a hashed key never equals a real one.
function agentIdOf(raw) {
  if (typeof raw !== "string" || raw === "") return { id: "", odd: false };
  if (AGENT_RE.test(raw) && raw.indexOf("bl:") !== 0) return { id: raw, odd: false };   // "bl:" is the billing-only key space
  return { id: `~${fnv1a32(`${raw.length}:${raw.slice(0, 4096)}`).toString(16)}`, odd: true };
}

// THE one resolvability rule (cr-m7), identical in the compiler: provider present, enabled !== false, models includes the rest.
// A lazy index: per `config.Providers` array a Map name -> first provider with that name, and per touched provider a Set of its models, built on first
// touch. The index is checked against the live array (length, the provider object at its slot, the models array and its length), so a config that
// is replaced or grown is re-indexed; an in-place edit that keeps the same arrays and lengths is not seen (ceiling: CCR hands over a fresh config).
const resIdx = new WeakMap();
function provIndex(list) {
  let ix = resIdx.get(list);
  if (!ix || ix.n !== list.length) {
    ix = { n: list.length, by: new Map() };
    for (let j = 0; j < list.length; j++) { const p = list[j]; if (p && typeof p.name === "string" && !ix.by.has(p.name)) ix.by.set(p.name, { p, j, models: null, len: -1, set: null }); }
    resIdx.set(list, ix);
  }
  return ix;
}
function resolvable(sel, config) {
  const s = String(sel || "");
  const i = s.indexOf("/");
  const list = config && config.Providers;
  if (i < 1 || !Array.isArray(list)) return false;
  const name = s.slice(0, i), rest = s.slice(i + 1);
  let e = provIndex(list).by.get(name);
  if (e && list[e.j] !== e.p) { resIdx.delete(list); e = provIndex(list).by.get(name); }
  if (!e) return false;
  const p = e.p;
  if (p.enabled === false || !Array.isArray(p.models)) return false;
  if (e.models !== p.models || e.len !== p.models.length) { e.models = p.models; e.len = p.models.length; e.set = new Set(p.models); }
  return e.set.has(rest);
}

// One pass over at most TOOLS_SCAN_MAX entries, no allocation: is there an Agent or Task tool? Exact spellings first; only a 4 or 5 character name is lower-cased.
function hasAgentToolIn(tools) {
  if (!Array.isArray(tools)) return false;
  const n = tools.length < TOOLS_SCAN_MAX ? tools.length : TOOLS_SCAN_MAX;
  for (let i = 0; i < n; i++) {
    const t = tools[i];
    const nm = (t && (typeof t.name === "string" ? t.name : t.function && typeof t.function.name === "string" ? t.function.name : "")) || "";
    if (nm === "Agent" || nm === "Task" || nm === "agent" || nm === "task") return true;
    const l = nm.length;
    if (l === 4 || l === 5) { const x = nm.toLowerCase(); if (x === "agent" || x === "task") return true; }
  }
  return false;
}

// SHA-256 in plain JS: the router may require only node:fs and node:path, and the compiled file's contentHash is a sha256 prefix (runs on a cache miss only).
const K256 = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
function sha256hex(str) {
  const msg = Buffer.from(str, "utf8"), len = msg.length;
  const nb = Math.ceil((len + 9) / 64) * 64;
  const buf = Buffer.alloc(nb);
  msg.copy(buf);
  buf[len] = 0x80;
  buf.writeUInt32BE(Math.floor(len / 0x20000000), nb - 8);
  buf.writeUInt32BE((len << 3) >>> 0, nb - 4);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < nb; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = buf.readUInt32BE(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  let out = "";
  for (let i = 0; i < 8; i++) out += H[i].toString(16).padStart(8, "0");
  return out;
}
// The compiler's hashOf, rule for rule: the allow-listed keys in order, the owner block without the behaviour-only fields, sha256, the first 12 hex characters.
function contentHashOf(p) {
  const owner = p.owner && typeof p.owner === "object" ? Object.fromEntries(Object.entries(p.owner).filter(([k]) => HASH_OWNER_EXCLUDE.indexOf(k) < 0)) : p.owner;
  return sha256hex(JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, k === "owner" ? owner : p[k]])))).slice(0, 12);
}

// ---------------------------------------------------------------- files
// Request-path reads never sleep: a failed read is a MISS (fail-open) and the next request tries again.
function readJsonNoRetry(file) { try { return JSON.parse(seam.fs.readFileSync(file, "utf8")); } catch { return null; } }
function ensureState() {
  const st = S();
  if (st.dirOk) return;
  seam.fs.mkdirSync(STATE, { recursive: true });
  st.dirOk = true;
}
// Synchronous temp-then-rename, no retry and no sleep (the compaction, the tripwire flag and the test flush use it). Returns false on any failure.
function syncWrite(file, text) {
  const f = seam.fs, tmp = `${file}.tmp-${process.pid}s`;
  try { ensureState(); f.writeFileSync(tmp, text); f.renameSync(tmp, file); return true; }
  catch { try { f.rmSync(tmp, { force: true }); } catch { /* ignore */ } return false; }
}
// ASYNC single-flight write per file with coalescing: only the newest text waits behind the one in flight. A failed EPERM/EBUSY rename is retried at most 3 times
// from a timer created HERE, inside the failure branch (never at module scope, `unref`ed so it cannot hold the process); any other failure drops this write (the next
// change writes again). A callback that never fires is cut loose after WRITE_STUCK_MS, so one stuck write cannot freeze a file for the life of the process.
const WRITE_STUCK_MS = 10000;
function writeAsync(file, text, keep) {
  const st = S(), now = nowMs();
  let rec = st.wr.get(file);
  if (!rec) {
    if (st.wr.size >= WR_MAX) { st.counters.asyncWriteFail = (st.counters.asyncWriteFail || 0) + 1; return false; }   // bounded: a write for a NEW file is dropped while WR_MAX files are busy (the caller is told: false)
    rec = { busy: false, pending: null, latest: null, gen: 0, tok: 0, tries: 0, since: 0, keep: null }; st.wr.set(file, rec);
  }
  rec.pending = text; rec.latest = text; rec.keep = keep || null;
  if (rec.busy && now - rec.since < WRITE_STUCK_MS) return true;
  pump(st, file, rec);
  return true;
}
function pump(st, file, rec) {
  const f = seam.fs, text = rec.pending, tok = ++rec.tok, gen = rec.gen;
  rec.pending = null; rec.busy = true; rec.since = nowMs();
  const tmp = `${file}.tmp-${process.pid}a${tok}`;                 // unique per attempt: a write cut loose as stuck can still land later without touching its successor's temp file
  const done = () => { rec.busy = false; rec.tries = 0; if (rec.pending !== null) pump(st, file, rec); else st.wr.delete(file); };
  const fail = (e) => {
    if (rec.tok !== tok) return;
    const next = () => {                                           // after the temp file is gone: retry from a timer, or give this write up
      if (rec.tok !== tok) return;
      if (e && (e.code === "EPERM" || e.code === "EBUSY") && rec.tries < 3) {
        const wait = 20 * 3 ** rec.tries;
        rec.tries += 1;
        const tm = setTimeout(() => { if (rec.tok === tok) { if (rec.pending === null) rec.pending = rec.latest; pump(st, file, rec); } }, wait);
        if (tm && typeof tm.unref === "function") tm.unref();
        return;
      }
      st.counters.asyncWriteFail = (st.counters.asyncWriteFail || 0) + 1;
      done();
    };
    try { f.rm(tmp, { force: true }, next); } catch { next(); }
  };
  try {
    ensureState();
    f.writeFile(tmp, text, (e1) => {
      if (rec.tok !== tok) return;
      if (e1) return fail(e1);
      f.rename(tmp, file, (e2) => {
        if (rec.tok !== tok) return;
        if (e2) return fail(e2);
        if (rec.gen !== gen && rec.latest !== null) syncWrite(file, rec.latest);       // a synchronous write (the test flush) overtook this one: leave the newest text on disk
        if (rec.keep && !rec.keep()) { try { f.rm(file, { force: true }, () => {}); } catch { /* ignore */ } }   // the file was evicted while this write was in flight: do not resurrect it
        done();
      });
    });
  } catch (e) { fail(e); }
}
// One cached append descriptor per log (opening a file per line costs more than the whole warm path). The size check runs on every 50th append;
// it also notices a file that vanished, and closes before a rotation (Windows cannot rename a file that is held open). A token bucket bounds the rate
// (burst 200, then LOGS[kind].rate lines a second; a dropped line is counted, never queued), an open or write failure silences the logs for 30 s, and a
// short write is terminated with a newline so the next line starts clean.
function dropped() { count("logDropped"); warn("LOG_DROPPED", "log lines were dropped (rate limit, a full disk or a failed write); counter logDropped"); }
function closeFd(st, kind) { const f = st.fds[kind]; st.fds[kind] = null; if (f) { try { seam.fs.closeSync(f.fd); } catch { /* already closed */ } } }
// R-v3 (F5): the file is CLAIMED first by a rename to a name of this worker (atomic: only one of several workers that saw the size gets it; a loser's rename fails with ENOENT and it
// rotates nothing, so no generation is shifted for nothing), then the generations shift and the claimed file becomes generation 1.
// A claim file left behind by a crash between the claim and the last rename (or an EPERM there) is removed by the next rotation once it is older than 10 minutes (by mtime; a younger
// one is another worker mid-rotation and is kept). Only names of the form <base>.rot-<id>.jsonl are ever looked at.
const STRAY_MS = 600000;
function rotate(file, gens) {
  const base = file.replace(/\.jsonl$/, ""), claim = `${base}.rot-${process.pid.toString(36)}.jsonl`;
  try {
    const dir = path.dirname(file), pre = `${path.basename(base)}.rot-`;
    for (const n of seam.fs.readdirSync(dir)) {
      if (!n.startsWith(pre) || !/^[A-Za-z0-9_-]+\.rot-[0-9a-z]{1,13}\.jsonl$/.test(n)) continue;
      const f = path.join(dir, n);
      try { if (Date.now() - seam.fs.statSync(f).mtimeMs > STRAY_MS) seam.fs.unlinkSync(f); } catch { /* gone, or not ours to remove: ignore */ }
    }
  } catch { /* an unreadable directory: rotation goes on */ }
  try { seam.fs.renameSync(file, claim); } catch (e) { if (e && e.code === "ENOENT") return; throw e; }   // another worker rotated it already
  for (let i = gens; i >= 2; i--) { try { seam.fs.renameSync(`${base}.${i - 1}.jsonl`, `${base}.${i}.jsonl`); } catch { /* generation missing */ } }
  seam.fs.renameSync(claim, `${base}.1.jsonl`);
}
function appendLog(kind, line) {
  const st = S(), L = LOGS[kind], now = nowMs();
  if (line.length > LINE_MAX) return;                            // every field is sanitised and bounded; a line this long is a bug, never written
  if (now < st.logDownUntil) { dropped(); return; }
  const b = st.bucket[kind];
  if (b.t < 0) b.t = now;
  if (now > b.t) { b.tok = Math.min(BURST, b.tok + ((now - b.t) * L.rate) / 1000); b.t = now; }
  if (b.tok < 1) { dropped(); return; }
  b.tok -= 1;
  const file = path.join(STATE, L.name);
  try {
    let f = st.fds[kind];
    if (!f || f.file !== file) {
      closeFd(st, kind);
      ensureState();
      f = st.fds[kind] = { file, fd: seam.fs.openSync(file, "a") };
    }
    const n = seam.fs.writeSync(f.fd, line);
    if (typeof n === "number" && n < Buffer.byteLength(line)) { try { seam.fs.writeSync(f.fd, "\n"); } catch { /* the next line starts after the torn one anyway */ } dropped(); }
    st.appends[kind] += 1;
    if (st.appends[kind] % 50 === 0) {
      let size = -1, moved = false;
      try {
        const ps = seam.fs.statSync(file);
        size = ps.size;
        const fsx = seam.fs.fstatSync(f.fd);                          // R-v3 (F5): another worker rotated the file, so this descriptor still points at the RENAMED one: reopen the path
        moved = ps.ino > 0 && fsx.ino > 0 && ps.ino !== fsx.ino;
      } catch { /* vanished: reopen on the next line */ }
      if (size < 0 || moved) closeFd(st, kind);
      else if (size >= L.max) { closeFd(st, kind); rotate(file, L.gens); }
    }
  } catch { closeFd(st, kind); st.dirOk = false; st.logDownUntil = now + 30000; dropped(); /* logging never breaks routing */ }
}

// ---------------------------------------------------------------- policy (stat + globalThis cache)
function loadPolicy() {
  const st = S(), file = path.join(STATE, "policy.json");
  let s;
  try { s = seam.fs.statSync(file); } catch { st.cache = null; return { state: "absent" }; }
  if (!s.isFile()) return { state: "corrupt" };
  if (s.size > POLICY_MAX) return { state: "oversize" };
  const c = st.cache;
  if (c && c.mtimeMs === s.mtimeMs && c.size === s.size && c.ino === s.ino) return c.result;
  let result;
  try {
    const p = JSON.parse(seam.fs.readFileSync(file, "utf8"));
    if (!p || p.schema !== 1 || !p.owner || !Array.isArray(p.models) || !p.lists || typeof p.lists !== "object") result = { state: "schema" };
    else if (Number.isFinite(p.minRouter) && p.minRouter > ROUTER_VERSION) result = { state: "newer", need: p.minRouter };
    else if (contentHashOf(p) !== p.contentHash) result = { state: "hash" };      // a hand-edited (or half-written, or older-compiler) file: never routed on
    else {
      const idx = new Map();
      for (let i = 0; i < p.models.length; i++) idx.set(p.models[i].s, i);
      result = { state: "ok", policy: p, idx };
    }
  } catch { result = { state: "corrupt" }; }
  st.cache = { mtimeMs: s.mtimeMs, size: s.size, ino: s.ino, result };
  return result;
}
// shadow.flag: the existence check runs on every subagent request; the CLI writes an ISO time into it, the tripwire writes `auto:<code>:<iso>`.
function rollbackFlag() {
  const st = S();
  let on = false;
  try { seam.fs.statSync(path.join(STATE, "shadow.flag")); on = true; } catch { /* absent */ }
  if (on) st.hadFlag = true;
  else if (st.hadFlag) { st.hadFlag = false; st.tripped = false; st.enforced = 0; st.errTimes = []; }       // `set` cleared it: a fresh watch window
  return on;
}
function flagContent() { try { return String(seam.fs.readFileSync(path.join(STATE, "shadow.flag"), "utf8")).trim(); } catch { return ""; } }

// ---------------------------------------------------------------- legacy slot (D-e): EXACT match only, never undefined
function legacySlot(asked) {
  if (asked !== "anthropic/claude-opus-5" && asked !== "claude-opus-5") return asked;
  try {
    const slot = JSON.parse(seam.fs.readFileSync(SLOT, "utf8"));
    if (slot && typeof slot.model === "string" && slot.model) return slot.model;
    count("slotError"); warn("SLOT_ERROR", "empty slot model");
  } catch { count("slotError"); warn("SLOT_ERROR", "slot unreadable"); }
  return asked;
}

// ---------------------------------------------------------------- session files (main-<sid>.json, agents-<sid>.jsonl)
const mainFile = (sid) => path.join(STATE, `main-${sid}.json`);
const agentsFile = (sid) => path.join(STATE, `agents-${sid}.jsonl`);
// A session file (main-<sid>.json, agents-<sid>.jsonl) is created only for a session id that has first sent a MAIN request carrying an Agent tool (S-F6: a flood of
// made-up ids that only send subagent-shaped requests creates no file; their state stays in memory). The folder holds at most SESSION_FILES_MAX of them; at the cap the
// OLDEST (least recently used) one is removed to make room ONLY when it has been idle for an hour, otherwise the new session is memory-only. `files` is a Map name -> last use, in recency order.
function sessionFiles() {
  const st = S();
  if (!st.files) {
    st.files = new Map();
    try {
      const found = [];
      for (const n of seam.fs.readdirSync(STATE)) if (SESSION_FILE_RE.test(n)) { let m = 0; try { m = seam.fs.statSync(path.join(STATE, n)).mtimeMs; } catch { /* raced */ } found.push([n, m]); }
      found.sort((a, b) => a[1] - b[1]);
      for (const [n, m] of found) st.files.set(n, m);
    } catch { /* no folder yet */ }
  }
  return st.files;
}
// RV-1: the index is read once and refreshed by the hourly gc, so a session first seen by ANOTHER worker (its main-<sid>.json created after this worker built the index) was unknown
// here, and this worker's decisions and handoffs for it stayed in memory with no journal line. On an index miss, ONE statSync of each of the session's two file names (at most
// every 5 s per sid, so a flood of made-up ids costs two stats each, once) adds an existing file to the index.
function sidKnown(sid) {
  const st = S();
  if (st.learned.has(sid)) return true;
  const fl = sessionFiles(), mn = `main-${sid}.json`, an = `agents-${sid}.jsonl`;
  if (fl.has(mn) || fl.has(an)) return true;
  const now = nowMs(), last = st.sidChk.get(sid);
  if (last !== undefined && now - last < MAIN_RECHECK_MS) return false;
  st.sidChk.set(sid, now);
  if (st.sidChk.size > CAPS.seen) st.sidChk.delete(st.sidChk.keys().next().value);
  let found = false;
  for (const [n, f] of [[mn, mainFile(sid)], [an, agentsFile(sid)]]) { try { seam.fs.statSync(f); fl.set(n, now); found = true; } catch { /* not there */ } }
  return found;
}
function sessionFileOk(file) {
  const st = S(), fl = sessionFiles(), name = path.basename(file), now = nowMs();
  if (fl.has(name)) { fl.delete(name); fl.set(name, now); return true; }
  if (fl.size >= SESSION_FILES_MAX) {
    warn("SESSION_FILE_CAP", `more than ${SESSION_FILES_MAX} session files: a file idle for an hour is removed to make room, otherwise the new session is kept in memory only`);
    const first = fl.keys().next().value;
    if (now - fl.get(first) < SESSION_IDLE_MS) { count("sessionFileSkip"); return false; }
    fl.delete(first);
    const m = /^agents-(.+).jsonl$/.exec(first);
    if (m) { const jj = st.jrn.get(m[1]); if (jj) closeJfd(jj); }      // the descriptor goes before the file does
    try { seam.fs.unlinkSync(path.join(STATE, first)); } catch { /* gone already */ }
    if (m) st.jrn.delete(m[1]);
  }
  fl.set(name, now);
  return true;
}
const persistedT = (v, now) => { const t = Date.parse(v) || 0; return t > now + FUTURE_SLACK_MS ? now : t; };   // a stored time far in the future (another clock) counts as now

// ---------------------------------------------------------------- main-model learning (6.3)
function learnMain(sid, model, beta1m) {
  const st = S(), t = nowMs();
  st.learned.set(sid, t);                                          // this session id has sent a main request with an Agent tool: it may own session files (S-F6)
  if (st.learned.size > CAPS.learned) trim(st.learned, CAPS.learned, (v) => v);
  const prev = st.main.get(sid);
  st.main.set(sid, { model, beta1m: !!beta1m, ms: t, chk: t, fm: undefined });
  trim(st.main, CAPS.main, (v) => v.ms);
  const changed = !prev || prev.model !== model;
  const lastWrite = st.mainWrite.get(sid) || 0;
  if (changed || t - lastWrite >= 60000) {
    const mf = mainFile(sid), mn = path.basename(mf);
    // SEC-4: `mainWrite` records a write that actually STARTED (or that there is nothing to write: a memory-only session). A write dropped at the WR_MAX cap leaves it unset, so the
    // next main request tries again instead of waiting 60 s.
    const started = sessionFileOk(mf) ? writeAsync(mf, JSON.stringify({ model, beta1m: !!beta1m, t: new Date(t).toISOString() }), () => !!(st.files && st.files.has(mn))) !== false : true;
    if (started) { st.mainWrite.set(sid, t); if (st.mainWrite.size > CAPS.main) trim(st.mainWrite, CAPS.main, (v) => v); }
  }
  st.mainBySession.set(sid.slice(0, 8), { model: logSel(model), t: new Date(t).toISOString() });
  trim(st.mainBySession, CAPS.mainStatus, (v) => Date.parse(v.t));
  return changed;
}
// Memory first. A file is read on a memory miss, and again (one stat, at most every 5 s) when another worker may have learned a newer main: the file wins
// only when the time it records is newer than the entry's.
function readMain(sid, ttlMs, now) {
  const st = S(), file = mainFile(sid);
  let m = st.main.get(sid);
  if (!m) {
    const j = readJsonNoRetry(file);
    if (j && typeof j.model === "string" && j.model.length <= ASKED_MAX) {
      let fm; try { fm = seam.fs.statSync(file).mtimeMs; } catch { /* vanished */ }
      m = { model: j.model, beta1m: !!j.beta1m, ms: persistedT(j.t, now), chk: now, fm };
      st.main.set(sid, m);
    }
  } else if (now - m.chk > MAIN_RECHECK_MS) {
    m.chk = now;
    let mt;
    try { mt = seam.fs.statSync(file).mtimeMs; } catch { /* no file: nothing newer */ }
    if (mt !== undefined && mt !== m.fm) {
      m.fm = mt;
      const j = readJsonNoRetry(file);
      if (j && typeof j.model === "string" && j.model.length <= ASKED_MAX) {
        const ms = persistedT(j.t, now);
        if (ms > m.ms) { m.model = j.model; m.beta1m = !!j.beta1m; m.ms = ms; }
      }
    }
  }
  return m && now - m.ms <= ttlMs ? m : null;
}
function trim(map, cap, tsOf) {
  while (map.size > cap) {
    let oldK = null, oldT = Infinity;
    for (const [k, v] of map) { const x = tsOf(v); if (x < oldT) { oldT = x; oldK = k; } }
    if (oldK === null) return;
    map.delete(oldK);
  }
}

// ---------------------------------------------------------------- stickiness (cr-B2): memory is the authority, agents-<sid>.jsonl is an append-only journal
// One journal line per decision `{"k":<key without the sid>,"m":<model>,"t":ms,"h":<policy hash>}` (a handoff line adds c, x, hp), and per touch
// `{"k":..,"u":ms,"n":..,"ts":..,"tm":..}`. The file is read ONCE per session per process (the first memory miss), then only its grown tail.
function dropAgent(st, key) {
  if (!st.agent.delete(key)) return;
  const sid = key.slice(0, key.indexOf(":")), n = (st.sessN.get(sid) || 1) - 1;
  if (n <= 0) st.sessN.delete(sid); else st.sessN.set(sid, n);
}
function oldestIn(st, sid, except) {                              // the least recently used entry of one session (never `except`)
  const prefix = `${sid}:`;
  let ok = null, ot = Infinity;
  for (const [k, v] of st.agent) if (k !== except && k.startsWith(prefix) && v.lt < ot) { ot = v.lt; ok = k; }
  return ok;
}
function addAgent(st, key, e) {
  const had = st.agent.has(key);
  st.agent.set(key, e);
  if (had) return;
  const sid = key.slice(0, key.indexOf(":")), n = (st.sessN.get(sid) || 0) + 1;
  st.sessN.set(sid, n);
  let over = n - CAPS.stickySession;
  while (over-- > 0) { const k = oldestIn(st, sid, key); if (!k) break; dropAgent(st, k); count("stickyCapEvict"); }
  if (st.agent.size > CAPS.sticky) {
    const k = oldestIn(st, sid, key);                              // inside the same session first: one fan-out must not evict other sessions
    if (k) { dropAgent(st, k); count("stickyCapEvict"); }
    else { let ok = null, ot = Infinity; for (const [kk, v] of st.agent) if (kk !== key && v.lt < ot) { ot = v.lt; ok = kk; } if (ok) { dropAgent(st, ok); count("stickyCapEvict"); } }
  }
}
function jState(st, sid) {
  let j = st.jrn.get(sid);
  if (!j) {
    j = { off: 0, sz: 0, mine: 0, fail: 0, retryAt: 0, chk: -Infinity, lines: 0, lead: true, fd: null, ino: 0, fdAt: 0, torn: -1 };
    st.jrn.set(sid, j);
    if (st.jrn.size > CAPS.journals) { const k = st.jrn.keys().next().value, old = st.jrn.get(k); if (old) closeJfd(old); st.jrn.delete(k); }
  }
  return j;
}
function journalSync(sid, now) {
  const st = S(), j = jState(st, sid), file = agentsFile(sid), f = seam.fs;
  if (j.fail >= 3 && now < j.retryAt) return;
  let size;
  let ino = 0;
  try { const s0 = f.statSync(file); size = s0.size; ino = s0.ino; } catch { return; }          // no journal yet
  if (j.fd !== null && ino && j.ino && ino !== j.ino) closeJfd(j);  // another worker replaced the file (a compaction): our descriptor points at the old one, reopen on the next append
  if (size < j.off) { j.off = 0; j.mine = 0; j.lines = 0; }        // compacted or truncated: read it again from the start (RV-3: and count its lines afresh, or a long multi-worker session stops refreshing early)
  j.sz = size;
  if (size === j.off) return;
  if (size - j.off === j.mine) { j.off = size; j.mine = 0; return; }   // the file grew by exactly what THIS worker appended: nothing to read
  if (j.lines >= JOURNAL_LINES_MAX) return;                        // this process has loaded as many lines of this session as it will (memory stays the authority)
  let buf;
  try {
    const fd = f.openSync(file, "r");
    try { const want = Math.min(size - j.off, JOURNAL_READ_CAP); buf = Buffer.allocUnsafe(want); buf = buf.subarray(0, f.readSync(fd, buf, 0, want, j.off)); }
    finally { f.closeSync(fd); }
  } catch { j.fail += 1; j.retryAt = now + 60000; return; }
  j.fail = 0; j.mine = 0;                                          // the tail read below includes this worker's own appends
  const end = buf.lastIndexOf(10);
  if (end < 0) {
    if (buf.length >= JOURNAL_READ_CAP) { j.off += buf.length; count("stickyJournalTorn"); }   // a line longer than a whole read is skipped, never waited for
    else if (buf.length > 0 && j.torn !== j.off) { j.torn = j.off; count("stickyJournalTorn"); }   // only a partial line so far: counted once per offset (it may be another worker mid-write; it is read again next time)
    return;
  }
  j.off += end + 1;                                                // loadedOffset: just after the last complete line; a trailing partial line is read next time
  if (buf.length > end + 1 && j.torn !== j.off) { j.torn = j.off; count("stickyJournalTorn"); }   // a torn last line (A): ignored, counted ONCE per offset however often the tail is read again
  const dec = new Map(), touch = new Map();
  for (const line of buf.toString("utf8", 0, end).split("\n")) {
    if (!line) continue;
    if (++j.lines > JOURNAL_LINES_MAX) break;
    let o;
    try { o = JSON.parse(line); } catch { count("stickyJournalTorn"); continue; }              // an unparsable line is skipped
    if (!o || typeof o.k !== "string" || o.k.length > 200) continue;
    if (typeof o.m === "string" && o.m.length <= ASKED_MAX && Number.isFinite(o.t)) dec.set(o.k, o);   // the last line per key wins
    else if (Number.isFinite(o.u)) { const p = touch.get(o.k); if (!p || o.u >= p.u) touch.set(o.k, o); }
  }
  for (const [k, o] of dec) {
    const key = `${sid}:${k}`, t = Math.min(o.t, now), cur = st.agent.get(key);
    if (cur && cur.t >= t) continue;
    const lt = Math.min(Number.isFinite(o.u) ? Math.max(o.u, t) : t, now);
    if (now - lt > STICKY_TTL) continue;
    const c = Number.isFinite(o.c) ? Math.min(o.c, now) : t;
    addAgent(st, key, { model: o.m, ph: typeof o.h === "string" ? o.h : "", t, c, lt, n: 0, ts: 0, tm: 0, ml: undefined, mt: 0, rp: 0,
      hops: Number.isFinite(o.hp) ? o.hp : 0, hist: Array.isArray(o.x) ? o.x.filter((z) => Array.isArray(z) && typeof z[0] === "string" && Number.isFinite(z[1])).slice(-3) : [] });
  }
  for (const [k, o] of touch) {
    const e = st.agent.get(`${sid}:${k}`);
    if (!e) continue;
    const u = Math.min(o.u, now);
    if (u > e.lt) e.lt = u;
    if (Number.isFinite(o.n) && o.n > e.n) e.n = o.n;
    if (Number.isFinite(o.ts) && o.ts > e.ts) e.ts = o.ts;
    if (Number.isFinite(o.tm) && o.tm > e.tm) e.tm = o.tm;
  }
}
// SEC-5: the journal descriptor stays open per session (opening and closing a file on every append stalled a request up to 160 ms on a busy Windows machine), like the logs'.
// At most JFD_MAX stay open (the least recently used one is closed to make room), every one is closed on a compaction, an eviction, a gc unlink, a state reset, and when a stat
// shows another worker replaced the file. A write that fails with EBADF or EPERM reopens the file ONCE and writes again; any other failure (or a second one) is journalFail,
// closes the descriptor and is fail-open: memory keeps the entry and the next decision opens the file afresh.
function closeJfd(j) { const fd = j.fd; j.fd = null; j.ino = 0; if (fd !== null && fd !== undefined) { try { seam.fs.closeSync(fd); } catch { /* already closed */ } } }
function openJfd(st, j, file) {
  let open = 0, lru = null;
  for (const o of st.jrn.values()) if (o.fd !== null) { open += 1; if (o !== j && (lru === null || o.fdAt < lru.fdAt)) lru = o; }
  if (open >= JFD_MAX && lru) closeJfd(lru);
  j.fd = seam.fs.openSync(file, "a");
  j.fdAt = nowMs();
  try { j.ino = seam.fs.fstatSync(j.fd).ino || 0; } catch { j.ino = 0; }
}
function journalWrite(st, j, file, line) {
  for (let attempt = 0; ; attempt++) {
    if (j.fd === null) openJfd(st, j, file);
    j.fdAt = nowMs();
    try {
      const n = seam.fs.writeSync(j.fd, line);
      if (typeof n === "number" && n < Buffer.byteLength(line)) { j.lead = true; count("journalFail"); }   // a short write: the next line starts with a newline so the torn one cannot swallow it
      return;
    } catch (e) {
      closeJfd(j);
      if (attempt >= 1 || !e || (e.code !== "EBADF" && e.code !== "EPERM")) throw e;
    }
  }
}
function journalAppend(sid, obj) {
  const st = S(), file = agentsFile(sid);
  const j = jState(st, sid);
  if (j.sz >= JOURNAL_MAX) { count("journalCap"); warn("JOURNAL_CAP", "a session journal reached its size cap: its new entries live in memory only"); return; }
  if (!sidKnown(sid)) { count("sessionFileSkip"); return; }       // S-F6: no main request with an Agent tool has named this session: memory only
  if (!sessionFileOk(file)) return;
  const line = (j.lead ? "\n" : "") + JSON.stringify(obj) + "\n";  // S-F10: the first append of a session per process, and the first after a failure, starts with a newline so a torn tail never swallows this entry
  try { ensureState(); journalWrite(st, j, file, line); j.sz += Buffer.byteLength(line); j.mine += Buffer.byteLength(line); j.lead = false; }
  catch { count("journalFail"); st.dirOk = false; j.lead = true; closeJfd(j); }  // memory keeps the entry; the next decision tries again
}
function stickyGet(sid, key, P, config, now) {
  const st = S(), j = jState(st, sid);
  let e = st.agent.get(key);
  if (!e) { j.chk = now; journalSync(sid, now); e = st.agent.get(key); }   // a miss: the first one loads the journal, later ones read only what other workers appended
  else if (now - j.chk >= SYNC_EVERY_MS) { j.chk = now; journalSync(sid, now); e = st.agent.get(key) || e; }   // a hit: at most every 1.5 s per session, one statSync when nothing grew, so another worker's handoff or touch is seen (R1)
  if (!e) return null;
  if (now - e.lt > STICKY_TTL || now - e.c > STICKY_ABS) { dropAgent(st, key); return null; }   // sliding six hours from the last touch, 24 hours from the first decision
  if (!resolvable(e.model, config)) { dropAgent(st, key); count("stickyEvict"); return null; }
  // S-F9 + O2 (owner: STARTED AGENTS STAY): a sticky model must still be in the WHOLE compiled allowed set (every provider: `lists.all`, which is the identity over the compiled
  // rows), not only in main's provider list. A forged or stale journal line therefore cannot pin an out-of-policy model, an entry whose model LEFT the set (the policy was
  // tightened) is decided again, but a `/model` switch to another provider no longer re-decides running agents under same-provider: only NEW agents follow the new main.
  // Not under inherit (it has no set). Independent of main, so an unknown main does not matter here.
  if (P.policy.owner.mode !== "inherit") {
    const all = P.policy.lists.all;
    if ((all !== null && !Array.isArray(all)) || !inSet(P, all, e.model)) { count("stickyOut"); return null; }
  }
  return e;
}
function stickyPut(sid, key, model, ph, now) {
  const st = S();
  const e = { model, ph, t: now, c: now, lt: now, n: 0, ts: 0, tm: 0, ml: undefined, mt: 0, rp: 0, hops: 0, hist: [] };
  addAgent(st, key, e);
  count("stickyNew");
  journalAppend(sid, { k: key.slice(sid.length + 1), m: model, t: now, h: ph });
  return e;
}
function journalTouch(sid, key, e) {
  journalAppend(sid, { k: key.slice(sid.length + 1), u: e.lt, n: e.n, ts: e.ts, tm: e.tm });
}
function pruneSticky(now) {
  const st = S();
  // SEC-5: on Windows a rename over a file that ANY process holds open fails (EPERM), so a journal descriptor held for ever by one worker would block every other worker's compaction of it.
  // A descriptor that has not been used for JFD_IDLE_MS is closed here (every 50th request, no timer): an active session keeps its descriptor, an idle one releases the file.
  for (const j of st.jrn.values()) if (j.fd !== null && now - j.fdAt > JFD_IDLE_MS) closeJfd(j);
  for (const [k, v] of st.agent) if (now - v.lt > STICKY_TTL || now - v.c > STICKY_ABS) dropAgent(st, k);
  for (const [k, v] of st.main) if (now - v.ms > MAIN_TTL_DEFAULT) st.main.delete(k);
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return !!e && e.code === "EPERM"; } }
// At most once an hour a PASS starts: session files older than 24 h are removed and the file index re-read; journals over 64 KB are rewritten from live memory;
// per-worker status files older than 24 h whose process is gone are removed; stale temp files are removed; expired cooling entries are dropped.
// SEC-5: the pass is SPREAD over requests. The directory listing is taken once (one readdirSync), then each request examines at most GC_STEP of its entries (a stat, and an unlink or a
// compaction at most), and the next request resumes: one request never pays for a whole folder (a stat or unlink stalled a request up to 80 ms on a busy machine).
// SEC-4: the index the pass builds must not LOSE what happened while it ran: a session file created (or seen) after the listing, and a file whose write is still in flight (it is
// not on disk yet, so the listing cannot hold it), are merged back in; otherwise the in-flight write's own `keep` check would find its file missing from the index and delete it.
function gcMaybe(now) {
  const st = S();
  if (!st.gcJob) {
    if (now - st.gcAt < 3600000) return;
    st.gcAt = now;
    for (const [k, v] of st.cool) if (now > v.u + HAND.quietMs && now - v.t0 > HAND.streakMs) st.cool.delete(k);
    let names;
    try { names = seam.fs.readdirSync(STATE); } catch { return; }     // no folder yet
    st.gcJob = { names, listed: new Set(names), i: 0, kept: [], compacted: 0 };
  }
  const job = st.gcJob, end = Math.min(job.names.length, job.i + GC_STEP);
  for (; job.i < end; job.i++) { try { gcOne(st, job, job.names[job.i], now); } catch { /* ignore */ } }
  if (job.i < job.names.length) return;
  st.gcJob = null;
  job.kept.sort((x, y) => x[1] - y[1]);
  const files = new Map(job.kept);
  if (st.files) for (const [n, t] of st.files) if (!job.listed.has(n) && !files.has(n)) files.set(n, t);       // created or seen after the listing
  for (const f of st.wr.keys()) { const n = path.basename(f); if (SESSION_FILE_RE.test(n) && !files.has(n)) files.set(n, now); }   // a write in flight
  st.files = files;
}
function gcOne(st, job, name, now) {
  const full = path.join(STATE, name);
  if (/\.tmp-\d+[as]\d*$/.test(name)) {                           // a temp file a crashed write left behind
    try { if (now - seam.fs.statSync(full).mtimeMs > 3600000) seam.fs.unlinkSync(full); } catch { /* raced */ }
    return;
  }
  if (STATUS_FILE_RE.test(name)) {
    try { if (now - seam.fs.statSync(full).mtimeMs > 24 * 3600000 && !pidAlive(parseInt(name.slice(7, -5), 36))) seam.fs.unlinkSync(full); } catch { /* raced */ }
    return;
  }
  if (!SESSION_FILE_RE.test(name)) return;
  const m = /^agents-(.+)\.jsonl$/.exec(name);
  let s;
  try {
    s = seam.fs.statSync(full);
    if (now - s.mtimeMs > 24 * 3600000) { if (m) { const jj = st.jrn.get(m[1]); if (jj) closeJfd(jj); } seam.fs.unlinkSync(full); return; }
  } catch { return; }
  job.kept.push([name, s.mtimeMs]);
  if (m && s.size > JOURNAL_COMPACT && job.compacted < COMPACT_PER_PASS) { compactJournal(m[1], now); job.compacted += 1; }   // at most two a pass: the rest next hour (R8)
}
function compactJournal(sid, now) {
  const st = S(), file = agentsFile(sid), prefix = `${sid}:`;
  journalSync(sid, now);                                           // fold in what other workers appended first
  const lines = [];
  for (const [k, e] of st.agent) {
    if (!k.startsWith(prefix)) continue;
    const o = { k: k.slice(prefix.length), m: e.model, t: e.t, h: e.ph, u: e.lt };
    if (e.c !== e.t) o.c = e.c;
    if (e.hops) { o.hp = e.hops; o.x = e.hist; }
    lines.push(JSON.stringify(o));
  }
  const text = lines.length ? lines.join("\n") + "\n" : "";
  closeJfd(jState(st, sid));                                       // the rename below replaces the file: never leave a descriptor on the old one
  if (syncWrite(file, text)) { const j = jState(st, sid); j.off = Buffer.byteLength(text); j.sz = j.off; j.mine = 0; j.lines = lines.length; }
}

// ---------------------------------------------------------------- cooling (ar-17): a model that just failed a retry is DEMOTED, never blocked
// state/subagent/cooling.json {"v":1,"models":{key:{u:until,l:rung,t:lastFail,n:streak,t0:streakStart}}} (u, t and t0 in epoch MILLISECONDS on the router's monotonic base; l 0..3), at most 64 keys (models and `prov:<provider>` entries
// together), shared across workers: read through stat + cache (at most once a second), written through the async writer. Rungs: 2 min, 10 min, 60 min, 6 h; a failure
// after a cooldown ended escalates one rung, the 6 h rung only on the 4th consecutive failure of the SAME model inside 24 hours (three before it), and the ladder starts over
// after the cooldown plus an hour of quiet. Two DIFFERENT models of one provider (one key) failing within 5 minutes of each other cool the provider key too.
const coolFile = () => path.join(STATE, "cooling.json");
function coolView(now) {
  const st = S();
  if (now - st.coolChk >= 1000) {
    st.coolChk = now;
    let s = null;
    try { s = seam.fs.statSync(coolFile()); } catch { /* none yet */ }
    const key = s ? `${s.mtimeMs}:${s.size}:${s.ino}` : "";
    if (key !== st.coolKey) {
      st.coolKey = key;
      if (s && s.isFile() && s.size <= 65536) {
        const j = readJsonNoRetry(coolFile());
        const m = j && typeof j === "object" ? j.models : null;
        if (m && typeof m === "object") {
          let n = 0;
          for (const k of Object.keys(m)) {
            if (++n > HAND.coolMax) break;
            const v = m[k];
            if (k.length > ASKED_MAX + 5 || !v || !Number.isFinite(v.u) || !Number.isFinite(v.t)) continue;
            const cur = st.cool.get(k);
            if (!cur || v.t > cur.t) {
              const t = Math.min(v.t, now);
              st.cool.set(k, { u: Math.min(v.u, now + HAND.ladder[3]), l: Number.isFinite(v.l) ? Math.max(0, Math.min(3, v.l | 0)) : 0, t, n: Number.isFinite(v.n) && v.n > 0 ? Math.min(v.n | 0, 99) : 1, t0: Number.isFinite(v.t0) ? Math.min(v.t0, t) : t });
            }
          }
        }
      }
    }
  }
  return st.cool;
}
// S-F3 + O1: a retry signal is client-attributable, so one session may put at most COOL_SID.models DISTINCT models on the ladder per hour. A failure of a FIFTH distinct
// model is "limited": it is NOT refused, it is marked at rung 0 (2 minutes) and never escalates, so a dead model is never left undemoted while the escalation (the
// 10 min / 60 min / 6 h rungs and the provider-key cooling input) stays bounded to four models per session and hour. There is no limit on escalating the same model:
// the cooldown lengths (2 / 10 / 60 min / 6 h) already pace the ladder. A single-user setup has one session id, so the cap is per session. RESIDUAL: a same-user
// attacker with many session ids can still escalate models (demotion only: a demoted model stays in the set and is used when nothing else is usable).
function coolAllowed(st, sid, sel, now) {
  let r = st.coolSid.get(sid);
  if (!r || now - r.t0 >= COOL_SID.windowMs) { r = { t0: now, models: new Set() }; st.coolSid.set(sid, r); if (st.coolSid.size > COOL_SID.max) st.coolSid.delete(st.coolSid.keys().next().value); }
  if (!r.models.has(sel) && r.models.size >= COOL_SID.models) return false;
  r.models.add(sel);
  return true;
}
function coolFail(sel, now, sid) {
  const st = S();
  st.coolChk = -Infinity;                                          // R15: read the shared file again just before computing (and so before writing): two workers failing different models within a second must not overwrite each other
  const view = coolView(now), cur = view.get(sel);
  if (cur && now < cur.u) return;                                  // already cooling: more failures in the same episode do not extend or escalate it
  let n = 1, t0 = now;
  if (cur && now <= cur.u + HAND.quietMs && now - cur.t0 <= HAND.streakMs) { n = cur.n + 1; t0 = cur.t0; }
  const allowed = coolAllowed(st, sid, sel, now);
  if (!allowed) count("coolLimited");
  const lvl = !allowed ? 0 : n >= 4 ? 3 : n - 1;                   // O1: a limited failure still marks rung 0 (2 min); its streak count n is kept
  view.set(sel, { u: now + HAND.ladder[lvl], l: lvl, t: now, n, t0 });
  count("coolMark");
  const prov = providerOf(sel), pk = `prov:${prov}`;
  for (const [k, v] of view) {
    if (k === sel || k.startsWith("prov:") || providerOf(k) !== prov || now - v.t > HAND.provMs) continue;
    const pc = view.get(pk);
    if (!(pc && pc.u > now)) { const l = allowed ? Math.max(lvl, v.l) : 0; view.set(pk, { u: now + HAND.ladder[l], l, t: now, n: Math.max(n, v.n), t0: Math.min(t0, v.t0) }); count("coolProvider"); }
    break;
  }
  while (view.size > HAND.coolMax) { let ok = null, ot = Infinity; for (const [k, v] of view) if (v.t < ot) { ot = v.t; ok = k; } if (ok === null) break; view.delete(ok); }
  const o = {};
  for (const [k, v] of view) Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: true });   // own keys only: a model may be named __proto__
  writeAsync(coolFile(), JSON.stringify({ v: 1, models: o }));
}
// The overlay hint: state/observed.json through stat + cache (key mtime, size, inode; read at most once a second), shape-checked like the policy, never trusted: a missing,
// torn, oversized or wrong-schema file is ignored (an existing but unusable one counts overlayBad), and the kill switch `observe.off` beside it turns the hint off.
// Only the entries that can demote survive parsing, as {s, at(ms)}; a time in the future counts as now.
function overlayView(now) {
  const st = S();
  if (now - st.ovChk >= 1000) {
    st.ovChk = now;
    const f = path.join(STATE, "..", "observed.json");
    let off = false, s = null;
    try { seam.fs.statSync(path.join(STATE, "..", "observe.off")); off = true; } catch { /* the feature is on */ }
    if (!off) { try { s = seam.fs.statSync(f); } catch { /* no overlay */ } }
    const key = off ? "off" : s ? `${s.mtimeMs}:${s.size}:${s.ino}` : "";
    if (key !== st.ovKey) {
      st.ovKey = key; st.ov = null;
      if (st.warnings.delete("OVERLAY_UNREADABLE")) st.warnVer += 1;
      if (s) {
        let m = null;
        if (s.isFile() && s.size <= OV.max) { const j = readJsonNoRetry(f); if (j && typeof j === "object" && !Array.isArray(j) && j.schema === 1 && j.models && typeof j.models === "object" && !Array.isArray(j.models)) m = j.models; }
        if (!m) { count("overlayBad"); warn("OVERLAY_UNREADABLE", "state/observed.json exists but could not be read or has the wrong shape: the overlay hint is ignored"); }
        else {
          st.ov = new Map();
          let n = 0;
          for (const k of Object.keys(m)) {
            if (++n > OV.entries * 4) break;
            const v = m[k];
            if (k.length > 200 || !v || typeof v !== "object" || !Object.prototype.hasOwnProperty.call(OV.ages, v.s) || !(typeof v.a === "number" && Number.isFinite(v.a) && v.a > 0)) continue;
            if (st.ov.size < OV.entries) st.ov.set(k, { s: v.s, at: v.a * 1000 });
          }
        }
      }
    }
  }
  return st.ov;
}
// The demotion predicate for new decisions and handoff picks: cooling (the model or its provider key) or an overlay mark that is still inside its age cap; null when neither
// source has anything (the common case: the scan then does no extra work).
function demotion(now) {
  const view = coolView(now), ov = overlayView(now);
  if (!view.size && !(ov && ov.size)) return null;
  return (sel) => {
    const e = view.get(sel);
    if (e && e.u > now) return 1;
    const pe = view.get(`prov:${providerOf(sel)}`);
    if (pe && pe.u > now) return 1;
    const o = ov && ov.get(sel);
    return o && now - Math.min(o.at, now) <= OV.ages[o.s] ? 2 : 0;
  };
}

// ---------------------------------------------------------------- decide (6.2)
function rowOf(P, sel) { const i = P.idx.get(sel); return i === undefined ? null : P.policy.models[i]; }
// A candidate list is an ascending array of row indexes, or null for "every row" (the compiler stores lists.all as null when it is the identity 0..n-1).
const lLen = (P, L) => (L === null ? P.policy.models.length : L.length);
const lAt = (L, i) => (L === null ? i : L[i]);
function lHas(P, L, idx) {
  if (L === null) return idx >= 0 && idx < P.policy.models.length;
  let lo = 0, hi = L.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1, v = L[mid]; if (v === idx) return true; if (v < idx) lo = mid + 1; else hi = mid - 1; }
  return false;
}
function inSet(P, L, sel) {
  if (L !== null && !Array.isArray(L)) return false;
  const i = P.idx.get(sel);
  return i !== undefined && lHas(P, L, i);
}
function fitsTokens(row, X, substitute) {
  if (!row) return !substitute;
  if (!(row.c > 0)) return !substitute;                         // unknown ctx: fails a substitute, passes the honour path
  if (typeof X.tokenCount !== "number" || !Number.isFinite(X.tokenCount)) return true;
  return X.tokenCount * 1.1 <= row.c;
}
function fitsBytes(row, X, quiet) {                              // quiet: a look-ahead probe that must not change a counter
  if (!row || !(row.pb > 0)) { if (X.bytes > 0 && !X.pbCounted && !quiet) { X.pbCounted = true; count("payloadUnknown"); } return true; }   // once per request, however many rows are tried
  return !(X.bytes > 0) || X.bytes <= row.pb;
}
function ctxFlags(row, beta1m) {
  const f = [];
  if (row && row.n === 1 && !beta1m) f.push("CTX_UNDELIVERED");
  if (row && !(row.c > 0)) f.push("CTX_UNKNOWN");
  return f;
}

/**
 * The deterministic spread substitute (plan 6.2, cr-M6), scanning LAZILY. Main's own model first (by index, when it is in the list, usable and not
 * excluded); then main's provider list in rank order collecting the first K usable rows; only when that finds none, the whole list. A row is usable when
 * resolvable, its context is at least the floor, and the token and byte fit hold. With banding off the K rows are exactly `pool2.slice(0, K)` of the
 * old whole-list pool; banded, only rows of the lead row's band count. `o.exclude` (a Set) is never picked; `o.cool(sel)` demotes a model: cooling rows are
 * used only when no other usable row exists. Returns {cand, fragile}.
 * R-v3: (1) with banding ON main's own model is taken first only when its row is in the LEAD band (the band of the first usable, non-cooling row of the pool the pick scans);
 * otherwise the fan-out spreads over the lead band. (2) for a request above 200 KB (204,800 bytes) a row with an unknown payload cap (pb 0) is never excluded but ranks LAST: it
 * is picked only when no known-cap row fits and nothing is cooling-only either (order: got, main cooling, chill, unknown, unknown cooling); it follows the same tier, cooling and
 * handoff rules as every row. A pb-0 row with a bk (bytes the sweep proved it accepts) of at least the request is a KNOWN fit and ranks by band and tier like any known row. For a smaller
 * request nothing is reordered.
 */
const tierRankOf = (row) => (!row ? -1 : row.t === "v" ? 0 : row.t === "t" ? 1 : 2);
function pickSubstitute(P, S0, main, X, config, floor, o) {
  const pol = P.policy, models = pol.models;
  const exclude = o && o.exclude, cool = o && o.cool, banded = !(o && o.banded === false);
  // O3 / D2 for a HANDOFF (o.t0 is the tier of the model being left): from a tested tier (v or t) the pick never falls to an untested one, WHATEVER the banding says (main's own
  // model included). A plain pool pick (no o.t0) with banding off is unchanged: the 5,000-case differential pins it.
  const noUntested = !!o && Number.isInteger(o.t0) && o.t0 >= 0 && o.t0 < 2;
  const noCool = !!(o && o.noCool);                                // a handoff: a row that is COOLING (its model or its provider key) is excluded, not merely demoted (6.1b E.3); an overlay-demoted row stays usable
  let silent = false;                                              // the look-ahead probe below counts nothing
  const usable = (row) => {
    if (!row || !resolvable(row.s, config)) return false;
    if (!(row.c >= floor)) { if (row.c > 0 && !silent) count("ctxSkip"); return false; }
    if (!fitsTokens(row, X, true)) { if (!silent) count("ctxSkip"); return false; }
    if (!fitsBytes(row, X, silent)) { if (!silent) count("payloadSkip"); return false; }
    return true;
  };
  // R-v3: an unknown payload cap on a big request ranks last. A row with pb 0 whose advisory field bk (bytes the sweep proved it accepts; never a refusal) covers the request is a KNOWN FIT.
  const unkBig = (row) => { if (!(X.bytes > BIG_REQ) || row.pb > 0) return false; const bk = row.bk; return !(typeof bk === "number" && bk > 0 && bk <= BK_MAX && bk >= X.bytes); };
  let coolMain = null, mainKind = 0, mainRow = null;
  if (main) {
    const mi = P.idx.get(main.model);
    if (mi !== undefined && lHas(P, S0, mi) && !(exclude && exclude.has(main.model))) {
      const row = models[mi];
      if (usable(row) && !(noUntested && tierRankOf(row) === 2) && !unkBig(row)) { mainKind = cool ? cool(main.model) : 0; if (mainKind === 1 && noCool) { /* a cooling main is no handoff target */ } else if (mainKind) coolMain = row; else if (!banded) return { cand: main.model, fragile: false }; else mainRow = row; }
    }
  }
  // scan one list: first K usable non-cooling rows (banded: of the lead's band) in `got`, the first K usable cooling rows in `chill`; for a big request the first K usable non-cooling
  // unknown-cap rows in `unk` and the first K usable cooling ones in `unkChill` (R-v3: they follow the SAME tier, cooling and handoff rules as every row, then rank after got, chill)
  const scan = (arr, filterProv, lim) => {
    const got = [], chill = [], unk = [], unkChill = [], n = arr === null ? lLen(P, S0) : arr.length;
    let lead = null, t0 = o && Number.isInteger(o.t0) ? o.t0 : -1, mask = mainKind, ut0 = t0, uLead = null;   // ut0, uLead: the tier rule's state for the unknown-cap rows, kept apart so they never set the lead or the tier of the known ones
    for (let i = 0; i < n && got.length < lim; i++) {
      const row = models[arr === null ? lAt(S0, i) : arr[i]];
      if (!row) continue;
      if (filterProv !== null && providerOf(row.s) !== filterProv) continue;
      if (exclude && exclude.has(row.s)) continue;
      if (banded && lead !== null && row.b !== lead.b) break;      // a band is a contiguous run of the ranked rows: the next band is never mixed in
      const big = unkBig(row);
      if (big && unk.length >= K && (!cool || unkChill.length >= K || !cool(row.s))) continue;   // neither unknown-cap bucket can change: skip the heavy checks (a list of mostly unknown rows is walked cheaply)
      if (!usable(row)) continue;
      const tr = tierRankOf(row);
      if (big) {                                                   // the same D2, O3 and cooling rules as below, on the unknown-cap rows' own state
        if (ut0 < 0) ut0 = tr;
        if (banded && uLead === null && tr === 2 && ut0 < 2) continue;
        if (noUntested && tr === 2) continue;
        const uk = cool ? cool(row.s) : 0;
        if (uk) { if (uk === 1 && noCool) continue; if (unkChill.length < K) unkChill.push(row); continue; }
        if (uLead === null) uLead = row;
        if (unk.length < K) unk.push(row);
        continue;
      }
      if (t0 < 0) t0 = tr;                                         // the tier of the first usable row, or of the model being handed off (o.t0)
      // D2: when the lead band is all demoted the scan may fall to a LOWER tool tier only if that tier is tested (v then t); never to an untested u from a tested tier.
      // Banding off keeps the old pool unchanged.
      if (banded && lead === null && tr === 2 && t0 < 2) continue;
      if (noUntested && tr === 2) continue;                        // O3: a handoff never lands on an untested tool tier, banded or not
      const dk = cool ? cool(row.s) : 0;
      if (dk) { mask |= dk; if (dk === 1 && noCool) continue; if (chill.length < K) chill.push(row); continue; }
      if (lead === null) lead = row;
      got.push(row);
    }
    return { got, chill, unk, unkChill, mask };
  };
  const pool = (lim) => {
    let res = null;
    if (main) {
      const mp = providerOf(main.model), pl = own(pol.lists.prov, mp);
      res = Array.isArray(pl) ? scan(pl, null, lim) : S0 !== null && S0.length > 0 && (pol.owner.source !== "all-providers") ? scan(S0, null, lim) : scan(S0, mp, lim);
    }
    let chill = res ? res.chill : [], unk = res ? res.unk : [], unkChill = res ? res.unkChill : [];
    if (!res || res.got.length === 0) {
      const r2 = scan(S0, null, lim);
      res = r2; if (chill.length === 0) chill = r2.chill; if (unk.length === 0) unk = r2.unk; if (unkChill.length === 0) unkChill = r2.unkChill;
    }
    return { res, chill, unk, unkChill };
  };
  if (mainRow) {                                                   // R-v3 (banded): main's own model is taken first only when it is in the lead band; a silent probe finds that band
    silent = true;
    const lead = pool(1).res.got[0];
    silent = false;
    if (!lead || !(mainRow.b > lead.b)) return { cand: main.model, fragile: false };
  }
  const { res, chill, unk, unkChill } = pool(K);
  let top = res.got;
  if (top.length && !(o && o.quiet)) { if (res.mask & 1) count("coolDemote"); if (res.mask & 2) count("overlayDemote"); }   // a demoted row was skipped for a non-demoted one
  if (top.length === 0) {                                          // nothing but cooling rows is usable: demoted, never blocked
    if (coolMain) return { cand: main.model, fragile: false, demoted: true };
    top = chill.length && banded ? chill.filter((r) => r.b === chill[0].b) : chill;
    if (top.length === 0) {                                        // R-v3: only unknown-cap rows of a big request are left: they rank last, never excluded: non-cooling ones, then cooling ones
      const uTop = unk.length ? unk : unkChill;
      top = uTop.length && banded ? uTop.filter((r) => r.b === uTop[0].b) : uTop;
      if (top.length === 0) return { cand: null, fragile: false };
      return { cand: top[fnv1a32(X.agentKey + ((o && o.seed) || "")) % top.length].s, fragile: top.length < K, ...(uTop === unkChill ? { demoted: true } : {}) };
    }
    return { cand: top[fnv1a32(X.agentKey + ((o && o.seed) || "")) % top.length].s, fragile: top.length < K, demoted: true };
  }
  return { cand: top[fnv1a32(X.agentKey + ((o && o.seed) || "")) % top.length].s, fragile: top.length < K };
}

function decide(P, main, want, asked, X, config, o) {
  const pol = P.policy, owner = pol.owner;
  const ok = (sel) => resolvable(sel, config);
  const hint = own(pol.ctxHints, asked), ctxAsked = typeof hint === "number" ? hint : 0;
  const floor = Math.max(ctxAsked, SUBSTITUTE_FLOOR);
  if (owner.mode === "inherit") {
    if (Array.isArray(pol.exempt) && pol.exempt.indexOf(asked) >= 0) return { act: "keep", model: asked, exempt: true, flags: [] };
    if (!main) return { act: "unknown-main", model: null, why: "main model not learned", flags: ["UNKNOWN_MAIN"] };
    if (!ok(main.model)) return { act: "unresolvable", model: null, why: "main model not in Providers", flags: ["UNRESOLVABLE_CANDIDATE"] };
    const flags = [];
    const mrow = rowOf(P, main.model);
    if (owner.ctx === "1m" && !main.beta1m && !(mrow && mrow.c >= 1000000)) flags.push("INHERIT_BELOW_CTX");
    if (mrow && mrow.p === 1) flags.push("INHERIT_PREMIUM_MAIN");
    return { act: main.model === asked ? "keep" : "inherit", model: main.model, flags };
  }
  const same = owner.source !== "all-providers";
  if (same && !main) return { act: "unknown-main", model: null, why: "main model not learned", flags: ["UNKNOWN_MAIN"] };
  const S0 = same ? own(pol.lists.byProvider, providerOf(main.model)) : pol.lists.all === null ? null : pol.lists.all;
  if (S0 === undefined || (S0 !== null && (!Array.isArray(S0) || S0.length === 0)) || (S0 === null && pol.models.length === 0)) {
    return { act: "empty-set", model: null, why: `mainProvider=${main ? logSel(providerOf(main.model)) : "?"}`, flags: ["EMPTY_SET"] };
  }
  const askedOk = ok(asked);
  if (inSet(P, S0, want) && ok(want) && fitsTokens(rowOf(P, want), X, false) && fitsBytes(rowOf(P, want), X)) {
    return { act: want === asked ? "keep" : "honour-tag", model: want, flags: ctxFlags(rowOf(P, want), X.beta1m) };
  }
  // not allowed, unresolvable or does not fit: the deterministic spread substitute
  const pick = pickSubstitute(P, S0, main, X, config, floor, { cool: o && o.cool, banded: owner.banded !== false });
  const cand = pick.cand;
  const inS = inSet(P, S0, want);
  if (cand) {
    const row = rowOf(P, cand);
    return { act: askedOk ? "substitute" : "reject-unresolvable", model: cand, requested: want, why: inS ? "unresolvable-or-no-fit" : "not-in-set",
      dropTag: X.hasTag && !inS, flags: [...ctxFlags(row, X.beta1m), ...(pick.fragile ? ["FRAGILE_SET"] : []), ...(pick.demoted ? ["ALL_DEMOTED"] : [])] };
  }
  return { act: "unresolvable", model: null, why: "no resolvable candidate that fits", dropTag: X.hasTag,
    flags: ["UNRESOLVABLE_CANDIDATE", ...(askedOk ? [] : ["UNRESOLVABLE_ASKED"])] };
}
// The candidate list a decision for this main works from (the same choice `decide` makes): undefined when there is none.
function listFor(pol, main) {
  if (pol.owner.mode === "inherit") return undefined;
  if (pol.owner.source !== "all-providers") return main ? own(pol.lists.byProvider, providerOf(main.model)) : undefined;
  return pol.lists.all === null ? null : pol.lists.all;
}

// ---------------------------------------------------------------- injection (6.4)
function injectTextFor(pol, provider) {
  const inj = pol.inject || {};
  if (pol.owner.source === "all-providers") return (pol.empty ? inj.empty : inj.all) || inj.empty || "";
  const t = own(inj.byProvider, provider);
  return (typeof t === "string" && t) || inj.empty || "";
}
function replaceBlock(desc, block) {
  const base = typeof desc === "string" ? desc : "";
  const i = base.indexOf(MARK);
  const head = i >= 0 ? base.slice(0, i).replace(/\n+$/, "") : base;
  return head ? `${head}\n\n${block}` : block;
}
function injectAgentTool(body, text, note) {
  if (!text || !Array.isArray(body.tools)) return false;
  let did = false;
  const n = body.tools.length < TOOLS_SCAN_MAX ? body.tools.length : TOOLS_SCAN_MAX;
  for (let i = 0; i < n; i++) {
    const t = body.tools[i];
    if (!t || typeof t !== "object") continue;
    const holder = typeof t.name === "string" ? t : t.function && typeof t.function.name === "string" ? t.function : null;
    if (!holder || AGENT_TOOLS.indexOf(holder.name.toLowerCase()) < 0) continue;
    const had = typeof holder.description === "string" ? holder.description : "";
    let block = text;
    if (had.indexOf(MARK) < 0 && had.indexOf(TAG_OPEN) >= 0) { block += "\nThis UW list replaces any list above."; warn("NATIVE_MENU_PRESENT"); }
    holder.description = replaceBlock(had, block);
    const schema = holder.input_schema || holder.parameters;
    const prompt = schema && schema.properties && schema.properties.prompt;
    if (note && prompt && typeof prompt === "object") prompt.description = replaceBlock(prompt.description, note);
    did = true;
  }
  return did;
}
// The handoff notice: ONE text block (at most 400 characters) appended to the subagent's SYSTEM prompt, string or array, on the first request after a handoff.
// It tells the new model it continues the same task and asks it to open its next reply with a visible line; messages and tools are never touched. Best effort:
// model compliance is not guaranteed, the prompt-cache prefix of that one request changes, and any error is swallowed by the caller (fail-open).
const ARROW = "\u21AA";
function noticeText(from, to) {
  const f = logSel(from), t = logSel(to);
  const full = `${NOTICE_MARK} Your previous model ${f} hit a limit. You are now ${t}. Continue the same task from the conversation above without restarting or re-planning. Begin your next reply with this exact line: ${ARROW} handoff: continued on ${t} after ${f} limit`;
  if (full.length <= 400) return full;
  const f2 = clip(f, 40), t2 = clip(t, 40);                        // long selectors: the same message, shorter names, so it stays within 400 characters
  return `${NOTICE_MARK} Your previous model ${f2} hit a limit. You are now ${t2}. Continue the same task without restarting. Begin your next reply with this exact line: ${ARROW} handoff: continued on ${t2} after ${f2} limit`;
}
function injectNotice(body, from, to) {
  const sys = body.system, text = noticeText(from, to);            // the text is built first and the single mutation comes last: an error leaves the body untouched
  if (typeof sys === "string") {
    if (sys.indexOf(NOTICE_MARK) >= 0) return true;
    const next = `${sys}\n\n${text}`;
    body.system = next;                                            // a frozen body silently ignores this assignment (sloppy mode): read it back before claiming it
    return body.system === next;
  }
  if (Array.isArray(sys)) {
    for (let i = 0; i < sys.length; i++) if (sys[i] && typeof sys[i].text === "string" && sys[i].text.indexOf(NOTICE_MARK) === 0) return true;   // a retried body that already carries it
    sys.push({ type: "text", text });
    return true;
  }
  return false;                                                    // no system prompt to append to: never invent one
}

// ---------------------------------------------------------------- logs and status
function baseLine(c, extra) {
  return { t: new Date(nowMs()).toISOString(), v: 1, w: workerId(), sid: c.sid.slice(0, 8), aid: c.aid, role: c.role, ag: c.ag ? 1 : 0, bl: c.bl ? 1 : 0, tools: c.nt, agentTool: c.ga ? 1 : 0,
    asked: logSel(c.asked0), tag: c.tag ? logSel(c.tag) : null, main: c.main ? logSel(c.main.model) : null, mp: c.main ? logSel(providerOf(c.main.model)) : null,
    pol: c.mode, ph: c.ph, stk: 0, ms: elapsed(c), ...extra };
}
const elapsed = (c) => (c.t0 === undefined ? 0 : Math.round(Number(process.hrtime.bigint() - c.t0) / 1e4) / 100);
function logDecision(c, extra) {
  const o = baseLine(c, extra);
  if (typeof o.would === "string") o.would = logSel(o.would);
  if (typeof o.ret === "string") o.ret = logSel(o.ret);
  appendLog("d", JSON.stringify(o) + "\n");
}
// agents.jsonl, v2: ONE line per NEW agent decision, never sampled (the first decision of an agent is what the owner reads back later; decisions.jsonl rotates).
function logAgent(c, d, pathName) {
  const tc = typeof c.tokenCount === "number" && Number.isFinite(c.tokenCount) ? c.tokenCount : null;
  const o = { v: 2, t: new Date(nowMs()).toISOString(), w: workerId(), sid: c.sid.slice(0, 8), aid: c.aid, pid8: c.pid8, asked: logSel(c.asked0), tag: c.tag ? logSel(c.tag) : null,
    main: c.main ? logSel(c.main.model) : null, act: d.act, would: typeof d.would === "string" ? logSel(d.would) : null, ret: typeof d.ret === "string" ? logSel(d.ret) : null,
    why: d.why ? String(d.why).slice(0, 120) : null, ph: c.ph, pol: c.mode, canary: c.canary, flags: d.flags || [], tc, ms: elapsed(c), path: pathName };
  if (d.from !== undefined) { o.from = logSel(d.from); o.to = logSel(d.to); o.hop = d.hop; o.rsrc = d.rsrc; o.reason = d.reason; o.aid_full = c.aidFull; }   // aid_full: the whole sanitised id (64), for a hook that matches an agent
  appendLog("a", JSON.stringify(o) + "\n");
}
function logOnce(c, code, extra, perMinute) {
  const st = S(), k = `${c.sid}:${code}:${extra.why || ""}${perMinute ? `:${Math.floor(nowMs() / 60000)}` : ""}`;
  if (st.logOnce.has(k)) return;
  st.logOnce.add(k);
  if (st.logOnce.size > 512) st.logOnce.clear();
  logDecision(c, extra);
}
function sizeBucket(len) { return len <= 0 ? "s0" : len < 2048 ? "s1" : len <= 16384 ? "s2" : "s3"; }
function byteBucket(n) { return !(n > 0) ? null : n < 50 * 1024 ? "b0" : n < 200 * 1024 ? "b1" : n < 1024 * 1024 ? "b2" : "b3"; }
function sysLen(sys) { try { return typeof sys === "string" ? sys.length : Array.isArray(sys) ? sys.reduce((a, b) => a + (b && typeof b.text === "string" ? b.text.length : 0), 0) : 0; } catch { return 0; } }
// R-v3: the user-agent as one of a closed set, never the raw header (at most 10 characters): claude-cli, sdk, other, none
function uaClass(ua) {
  if (!ua) return "none";
  const h = ua.slice(0, 128);
  return /sdk/i.test(h) || /^anthropic\//i.test(h) ? "sdk" : /^claude-cli\//i.test(h) ? "claude-cli" : "other";
}
function classLog(pol, c, cls) {
  if (pol.owner.classLog === "off") return;
  const rc = hdr(c.h, H_CLASS), at = hdr(c.h, H_TYPE);
  const o = { t: new Date(nowMs()).toISOString(), sid: c.sid.slice(0, 8), aid: c.aid, pid8: c.pid8, cls, ag: c.ag ? 1 : 0, bl: c.bl ? 1 : 0, nt: c.nt, ga: c.ga ? 1 : 0,
    sysb: c.sysb, m: logSel(c.asked0), rc: RC_SET.indexOf(rc) >= 0 ? rc : null, at: at && /^[A-Za-z0-9_.:@+-]{1,32}$/.test(at.slice(0, 32)) ? at.slice(0, 32) : null,
    bb: byteBucket(c.bytes), tc: typeof c.tokenCount === "number" && Number.isFinite(c.tokenCount) ? c.tokenCount : null,
    hasSid: c.sid !== "nosession", ua: uaClass(hdr(c.h, H_UA)) };
  appendLog("c", JSON.stringify(o) + "\n");
}
function auxStats(P, asked, bytes) {
  const a = S().aux, k = logSel(asked);                         // a Map keyed by the log-safe selector ("?" for anything else): never a client string on a plain object
  let e = a.get(k);
  if (!e) { if (a.size >= CAPS.auxModels) return; e = { n: 0, bytesSum: 0, bytesMax: 0 }; a.set(k, e); }
  const b = bytes > 0 ? bytes : 0;
  e.n += 1; e.bytesSum += b; e.bytesMax = Math.max(e.bytesMax, b);
  if (own(P.policy.tiers, providerOf(asked)) === "subscription") count("auxOnRelay");
}
function tally(sel) {                                           // by model and by provider, capped at 64 keys each (the rest count under ~other)
  const st = S(), m = logSel(sel);
  const bump = (map, k) => { if (!map.has(k) && map.size >= CAPS.byModel) k = "~other"; map.set(k, (map.get(k) || 0) + 1); };
  bump(st.byModel, m); bump(st.byProvider, m === "?" ? "?" : providerOf(m));
}
function latBucket(ms) { let i = 0; while (i < LAT_EDGES.length && ms >= LAT_EDGES[i]) i++; return i; }
function headline(P, flagText, autoInfo) {
  const state = (P && P.state) || "absent";
  if (state === "absent") return "policy absent: the router passes every request through unchanged";
  if (state === "newer") return `POLICY NEWER: the compiled policy needs router v${P.need} and this router is v${ROUTER_VERSION}; every request passes through unchanged`;
  if (state !== "ok") return `POLICY ${state.toUpperCase()}: the compiled policy is unusable; every request passes through unchanged (run rebuild)`;
  if (autoInfo) return `AUTO-ROLLBACK (${autoInfo.code} at ${autoInfo.at}): the router paused itself and returns every model as asked; only an explicit set clears it`;
  if (flagText !== null) return "PAUSED (shadow.flag): every subagent runs on the model it asked for until set clears the flag";
  return P.policy.owner.enforcement === "enforce" ? "ENFORCING: subagents may run on policy models" : "SHADOW: logging only, no subagent is changed";
}
function flushStatus(force, P, sync) {
  const st = S(), t = nowMs();
  if (!force && t - st.statusAt < 5000 && st.warnVer === st.warnSeen) return;
  if (P) st.lastP = P; else P = st.lastP;
  const pol = P && P.state === "ok" ? P.policy : null;
  let flagText = null;
  if (pol) { try { if (rollbackFlag()) flagText = flagContent(); } catch { /* ignore */ } }
  const auto = flagText !== null ? /^auto:([A-Z_]{1,40}):(\S{1,40})/.exec(flagText) : null;
  const autoInfo = auto ? { code: auto[1], at: auto[2] } : null;
  if (autoInfo) warnSet("AUTO_ROLLBACK", `${autoInfo.code} ${autoInfo.at}`);
  else if (st.warnings.delete("AUTO_ROLLBACK")) st.warnVer += 1;
  const cooling = [];
  for (const [k, v] of coolView(t)) if (v.u > t && cooling.length < HAND.coolMax) cooling.push({ key: logSel(k), rung: v.l, leftSec: Math.round((v.u - t) / 1000), fails: v.n });
  cooling.sort((a, b) => b.leftSec - a.leftSec);
  if (cooling.length) warnSet("COOLING", `${cooling.length} model or provider key(s) cooling (latest ${cooling[0].key}, rung ${cooling[0].rung})`);
  else if (st.warnings.delete("COOLING")) st.warnVer += 1;
  const hourAgo = t - HAND.hourMs;
  st.hand = st.hand.filter((x) => x.t >= hourAgo);
  const latest = st.hand.length ? st.hand[st.hand.length - 1] : null;
  if (!latest && st.warnings.delete("HANDOFF")) st.warnVer += 1;       // the HANDOFF warning clears an hour after the last handoff
  let head = headline(P, flagText, autoInfo);
  if (latest) head += `; HANDOFF: ${st.hand.length} in the last hour (latest ${logSel(latest.from)} -> ${logSel(latest.to)})`;
  st.statusAt = t; st.warnSeen = st.warnVer;
  if (!st.since) st.since = new Date(t).toISOString();
  const body = {
    schema: 1, updatedAt: new Date(t).toISOString(), since: st.since, pid: process.pid, w: workerId(), routerVersion: ROUTER_VERSION,
    policy: pol ? { state: "ok", compiledAt: pol.compiledAt, contentHash: pol.contentHash, enforcement: pol.owner.enforcement, inject: pol.owner.inject,
      banded: pol.owner.banded !== false, rollbackFlag: flagText !== null, unverifiedAllowed: pol.counts && pol.counts.unverified, premiumAllowed: pol.counts && pol.counts.premium,
      payloadRisk: pol.counts && pol.counts.payloadRisk, headline: head } : { state: (P && P.state) || "absent", headline: head },
    counters: st.counters, aux: { byModel: Object.fromEntries(st.aux), maxModels: CAPS.auxModels }, matrix: st.matrix,
    mainBySession: Object.fromEntries(st.mainBySession), byModel: Object.fromEntries(st.byModel), byProvider: Object.fromEntries(st.byProvider),
    latency: { edgesMs: LAT_EDGES, ...st.lat }, enforcedSeen: st.enforced, watch: { window: WATCH_N, enforced: st.enforced, tripped: st.tripped },
    cooling, overlay: { entries: st.ov ? st.ov.size : 0 },
    handoffs: { lastHour: st.hand.length, latest: latest ? { from: logSel(latest.from), to: logSel(latest.to), t: new Date(latest.t).toISOString() } : null },
    warnings: [...st.warnings].map(([code, v]) => ({ code, since: v.since, detail: v.detail })), last: {},
  };
  const text = JSON.stringify(body);
  // Every flush is async (coalesced, never blocks); only the test seam's `flush` is synchronous (QB-1: no synchronous write on the request path).
  for (const f of [path.join(STATE, `status-${workerId()}.json`), path.join(STATE, "status.json")]) {
    if (sync) { const rec = st.wr.get(f); if (rec) { rec.latest = text; rec.gen += 1; rec.pending = null; } syncWrite(f, text); } else writeAsync(f, text);
  }
}

// ---------------------------------------------------------------- tripwire: the first WATCH_N enforced requests of a worker are watched
// A trip writes shadow.flag (`auto:<code>:<iso>`), the same file the CLI's rollback writes, so every worker returns `asked` from its next request; only an
// explicit `set` (or a future resume) removes it. Trips: an aux or exempt request about to leave with a model other than the one it passes through with
// (an invariant that must never fail), and five router errors within 60 s.
function watchActive() { const st = S(); return st.enforceOn && st.enforced < WATCH_N && !st.tripped; }
function trip(code) {
  const st = S();
  if (st.tripped) return;
  st.tripped = true;
  count("autoRollback");
  const iso = new Date(nowMs()).toISOString();
  try {
    if (!syncWrite(path.join(STATE, "shadow.flag"), `auto:${code}:${iso}\n`)) seam.fs.writeFileSync(path.join(STATE, "shadow.flag"), `auto:${code}:${iso}\n`);
  } catch { /* the router still answers asked for this worker below */ }
  st.hadFlag = true;
  warnSet("AUTO_ROLLBACK", `${code} ${iso}`);
}
function recordError(now) {
  try {
    const st = S();
    st.errTimes.push(now);
    if (st.errTimes.length > 5) st.errTimes.shift();
    if (st.errTimes.length >= 5 && now - st.errTimes[0] <= 60000 && watchActive()) trip("ERRORS");
  } catch { /* never throws */ }
}

// ---------------------------------------------------------------- the route function
module.exports = async function route(req, config, ctx) {
  // The model check sits BEFORE the try and is a pure type test (S-F1): a body such as {"model":{"toString":1}} or a 150,000-deep nested array used to throw inside
  // String(...), counted as a router error, and five of them in a minute tripped the tripwire for every session. A non-string or empty model is the legacy answer.
  // SEC-6: the READ itself is guarded too: a throwing getter on body or model (a JSON-parsed body cannot do this, a caller's object could) must not reject the promise.
  let m0;
  try { m0 = req && req.body && req.body.model; } catch { return undefined; }
  if (typeof m0 !== "string" || !m0) return undefined;
  const t0 = process.hrtime.bigint();
  const asked0 = m0;
  let pathTag = null;
  let guarded = false;                                             // true once the request parse prefix is behind us: only an error raised after it counts toward the tripwire
  try {
    const out = (r) => (r === asked0 ? legacySlot(asked0) : r);   // D-e: exact-match slot rewrite, only when passing asked through; never undefined
    // asked0 is what is RETURNED (byte for byte); askedK is what is keyed, stored and logged: a client-controlled model of any
    // length must not grow a state file or a map key (a 2 MB model once produced a 10 MB agents file).
    const askedK = asked0.length <= ASKED_MAX ? asked0 : `~${asked0.length}~${asked0.slice(0, 40)}`;
    count("req");
    const P = loadPolicy();
    const st = S();
    st.lastP = P;
    if (P.state !== "ok") {
      // absent is SILENT: no status flush, so a router with no policy creates no state directory and writes nothing (F15)
      if (P.state !== "absent") {
        count("policyBad");
        warn(`POLICY_${P.state === "schema" ? "SCHEMA" : P.state === "oversize" ? "OVERSIZE" : P.state === "newer" ? "NEWER" : P.state === "hash" ? "HASH" : "CORRUPT"}`, P.need ? `needs router v${P.need}` : undefined);
        flushStatus(false, P);
      }
      return out(asked0);
    }
    const pol = P.policy;
    st.enforceOn = pol.owner.enforcement === "enforce";
    const h0 = req.headers;
    const h = h0 && typeof h0 === "object" ? h0 : {};
    const sid = cleanSid(req.sessionId || hdr(h, H_SID) || hdr(h, H_SID_ALT));
    const toolsArr = req.body.tools;
    const hasTools = Array.isArray(toolsArr) && toolsArr.length > 0;
    const hasAgentTool = hasAgentToolIn(toolsArr);
    const aid = agentIdOf(hdr(h, H_AGENT));
    if (aid.odd) count("agentIdOdd");
    const agentId = aid.id;
    const parent = hdr(h, H_PARENT);
    const ag = agentId !== "", bl = req.builtInClaudeCodeSubagent === true;
    const nt = Array.isArray(toolsArr) ? toolsArr.length : 0;
    const mk = `a${+ag}.b${+bl}.t${+hasTools}.g${+hasAgentTool}`;
    st.matrix[mk] = (st.matrix[mk] || 0) + 1;
    if (ag !== bl) count("detectorDisagree");
    const bytes = Number(hdr(h, H_LEN)) || 0;
    if (pol.gate && pol.gate.code === "CLASSIFIER_UNMEASURED") warn("CLASSIFIER_UNMEASURED");   // a rebuild kept enforcement off for an unmet precondition: loud in status
    else if (st.warnings.delete("CLASSIFIER_UNMEASURED")) st.warnVer += 1;                       // a later rebuild without the gate clears it (and the next status flush says so)
    const c = { t0, sid, h, ag, bl, nt, ga: hasAgentTool, asked0: askedK, bytes, tokenCount: req.tokenCount, sysb: sizeBucket(sysLen(req.body.system)), main: null,
      role: "main", tag: null, mode: "shadow", ph: pol.contentHash, aid: ag ? agentId.slice(0, 12) : null, aidFull: ag ? agentId.slice(0, 64) : null, pid8: parent ? (AGENT_RE.test(parent) ? parent.slice(0, 8) : "?") : null, canary: null };
    guarded = true;
    // The passthrough answer and the tripwire invariant: aux and exempt requests only ever leave with the model they came with.
    const finish = (cls, ret, pass) => {
      if (cls !== "sub" && ret !== pass) { if (watchActive()) trip("INVARIANT"); return pass; }
      return ret;
    };

    if (ag || bl) {
      if (!hasTools) {                                            // cr-M5: AUX class (helper call); I8a: any mode, never rewritten
        pathTag = "aux";
        count("aux"); auxStats(P, asked0, bytes); c.role = "aux"; classLog(pol, c, "aux");
        flushStatus(false, P);
        const pass = out(asked0);
        return finish("aux", pass, pass);
      }
      return handleSubagent();
    }
    // ---- main loop request
    classLog(pol, c, "main");
    count("main");
    if (hasAgentTool && sid !== "nosession") {                    // cr-m2: only Agent-tool requests with a session id teach main
      const changed = learnMain(sid, askedK, hdr(h, H_BETA).indexOf(BETA_1M) >= 0);
      if (changed) logOnce({ ...c, main: { model: askedK } }, "main-learn", { act: "main-learn", ret: askedK }, true);
      if (pol.owner.inject === "on" && pol.owner.mode !== "inherit" && !rollbackFlag()) {
        const text = injectTextFor(pol, providerOf(askedK));
        if (injectAgentTool(req.body, text, pol.inject && pol.inject.promptNote)) { count("injected"); logOnce(c, "main-inject", { act: "main-inject", ret: askedK }, true); }
      }
    }
    flushStatus(false, P);
    return out(asked0);

    function handleSubagent() {
      const now = nowMs();
      const flagged = rollbackFlag();
      let forced = flagged || pol.owner.enforcement !== "enforce";
      count("sub");
      st.calls += 1;
      if (st.calls % 50 === 0) pruneSticky(now);
      if (st.calls % 50 === 0 || st.gcJob) gcMaybe(now);              // a pass starts on every 50th call and, once started, continues on every request until its listing is done
      const main = readMain(sid, (pol.main && pol.main.ttlSec ? pol.main.ttlSec : 21600) * 1000, now);
      c.main = main;
      const tagRaw = req.builtInSubagentModel;
      const tag = typeof tagRaw === "string" && tagRaw ? tagRaw : null;
      c.tag = tag;
      const key = ag ? `${sid}:${agentId}` : `${sid}:bl:${askedK}`;      // a billing-only subagent has no agent id: one sticky key and one hash per session and asked model
      const agentKey = agentId || key;
      // rollout (ar-10): an agent outside the canary share is handled exactly like shadow, whatever the owner file says. The field is inert at 100 (the compiler writes 100).
      const ro = pol.rollout, pct = ro && Number.isFinite(ro.canaryPct) ? Math.max(0, Math.min(100, ro.canaryPct)) : 100;
      if (!forced && pct < 100) { c.canary = fnv1a32(`${sid}:${agentKey}:c${ro.salt === undefined ? "" : ro.salt}`) % 100 < pct ? 1 : 0; if (c.canary === 0) forced = true; }
      c.mode = forced ? "shadow" : "enforce";
      c.role = "sub";
      const dm = pol.owner.mode === "dynamic" || pol.owner.mode === "free";
      const retry = retrySignal(req, h, forced ? shadowSeen(key) : null);
      if (!forced) {
        st.enforced += 1; count("enforced");
        const s = stickyGet(sid, key, P, config, now);
        if (s) {
          pathTag = "sticky";
          count("stickyHit");
          s.n += 1;
          if (typeof req.tokenCount === "number" && Number.isFinite(req.tokenCount)) { s.ts += req.tokenCount; if (req.tokenCount > s.tm) s.tm = req.tokenCount; }
          const sig = retry || retrySignal(req, h, s);
          let ret = out(s.model), handed = null;                       // R-5: the entry holds the model the DECISION chose (in the set); the slot rewrite is applied on the way out, never stored
          if (sig && dm) { count("retry"); coolFail(s.model, now, sid); handed = handoff(s, sig, main, agentKey, key, now); if (handed) { ret = out(handed); pathTag = "new"; } }
          if (now - s.lt >= TOUCH_MS) { s.lt = now; journalTouch(sid, key, s); }
          tally(ret);
          classLog(pol, c, "sub");
          if (!handed && (s.n === 1 || s.n % 50 === 0)) logDecision(c, { act: "sticky", ret, stk: 1, price: priceOf(P, ret), flags: [] });   // the first hit, then one in 50
          flushStatus(false, P);
          return ret;
        }
      }
      if (!ag) count("blNoAgentId");
      const X = { beta1m: hdr(h, H_BETA).indexOf(BETA_1M) >= 0, tokenCount: req.tokenCount, bytes, agentKey, hasTag: tag !== null };
      const d = decide(P, main, tag || asked0, asked0, X, config, { cool: dm ? demotion(now) : null });
      classLog(pol, c, d.exempt ? "exempt" : "sub");
      const flags = (d.flags || []).slice();
      countAct(d.act, flags);
      if (forced) {
        pathTag = "shadow";
        const r0 = out(asked0);                                   // what is actually returned, logged as such (F16): evaluated once, the slot read counts once
        const x = { act: d.act, would: d.model, ret: r0, why: d.why, price: priceOf(P, d.model), flags };
        const sn = shadowSeen(key);
        if (d.act === "empty-set") logOnce(c, "EMPTY_SET", x); else logDecision(c, x);
        if (!sn.logged) { sn.logged = true; logAgent(c, x, "shadow"); }
        if (retry && dm) {                                        // shadow only LOGS the handoff it would make
          count("retry"); count("handoffWould");
          const alt = dm ? pickAlt(P, main, d.model || asked0, X, config, asked0, now) : null;
          logDecision(c, { act: "would-handoff", would: alt, ret: r0, why: `retry:${retry.src}:${retry.cnt}`, flags: [] });
        }
        tally(r0);
        flushStatus(false, P);
        return r0;
      }
      pathTag = "new";
      const ret0 = out(d.model || asked0);
      // A free-mode fall-through is a PROMISE BREAK (6.2 note h): visible, counted, never blocking.
      const broke = pol.owner.mode === "free" && d.model === null && !d.exempt;
      if (broke) { count("freeBreak"); warn("FREE_PROMISE_BREAK", d.why); flags.push("FREE_PROMISE_BREAK"); }
      // ar-3a: an outcome with NO model of its own (unknown main, empty set, nothing usable) is never stored: the next turn decides again, so a main learned later is used.
      let ret = ret0;
      if (d.model !== null) {
        const e = stickyPut(sid, key, d.model.length <= ASKED_MAX ? d.model : askedK, pol.contentHash, now);   // R-5: the PRE-rewrite model (ret0 may be the slot's model, which is outside the set)
        e.ml = Array.isArray(req.body.messages) ? req.body.messages.length : undefined; e.mt = now;
      } else count("stickyNone");
      ret = finish(d.exempt ? "exempt" : "sub", ret, d.exempt ? out(asked0) : ret);
      const dl = { act: d.act, would: d.model, ret, why: d.why, price: priceOf(P, d.model), flags };
      if (d.act === "empty-set") logOnce(c, "EMPTY_SET", { act: "empty-set", would: null, ret, why: d.why, flags });
      else if (broke) logOnce(c, d.act, { act: d.act, would: null, ret, why: d.why, flags });
      else if (d.model === null) logOnce(c, d.act, dl, true);
      else logDecision(c, dl);
      logAgent(c, dl, "new");
      // cr-m6 / E13: no out-of-set tag may survive to CCR's chain. A null model (unknown main, empty set, nothing usable) or an
      // unresolvable answer sends CCR down its chain, where the tag could be honoured: clear it in those cases too (F10).
      if (d.dropTag || (tag !== null && (d.model === null || !resolvable(ret, config)))) req.builtInSubagentModel = undefined;
      tally(ret);
      flushStatus(false, P);
      return ret;
    }
    // Per-agent memory of the last request, for the retry signal: the sticky entry in enforce, a bounded `seen` map in shadow.
    function shadowSeen(key) {
      let sn = st.seen.get(key);
      if (!sn) { sn = { ml: undefined, mt: 0, rp: 0, logged: false }; st.seen.set(key, sn); if (st.seen.size > CAPS.seen) st.seen.delete(st.seen.keys().next().value); }
      return sn;
    }
    // A retry is a RETRY of a request that already passed through here. For an agent WITH an id the signal is the same agent sending an unchanged messages length within 120 s
    // (the transcript did not grow, so no turn completed): `mem` holds ml/mt/rp and is updated in place. The SDK's retry-count header alone is NOT acted on there (a client can
    // forge it for any agent id; S-F3). A billing-only subagent has no agent id, so no stable previous length exists and one key is shared by every such request of a session
    // and asked model: for it the HEADER is the only signal (D6), and `len` is never used.
    function retrySignal(rq, hh, mem) {
      if (!ag) {
        const rc = Number(hdr(hh, H_RETRY));
        if (Number.isFinite(rc) && rc > 0) { count("retryHdr"); return { src: "hdr", cnt: Math.min(20, Math.floor(rc)) }; }
        return null;
      }
      if (!mem) return null;
      const now = nowMs();
      const len = Array.isArray(rq.body.messages) ? rq.body.messages.length : -1;
      if (len < 0) return null;
      let hit = false;
      if (mem.ml === len && now - mem.mt <= HAND.lenWindowMs) { mem.rp += 1; hit = true; } else mem.rp = 0;   // a normal turn adds 2 or more messages, a compaction shrinks the count: neither is a retry
      mem.ml = len; mem.mt = now;
      if (!hit) return null;
      count("retryLen");
      return { src: "len", cnt: mem.rp };
    }
    // The alternative the router WOULD hand over to: the candidate the next banded pick gives with `left` excluded (shadow logging; no state is changed).
    function pickAlt(PP, main, left, X, cfg, askedM, now) {
      const S0 = listFor(PP.policy, main);
      if (S0 === undefined || (S0 !== null && !Array.isArray(S0))) return null;
      const hint = own(PP.policy.ctxHints, askedM), floor = Math.max(typeof hint === "number" ? hint : 0, SUBSTITUTE_FLOOR);
      const r = pickSubstitute(PP, S0, main, { ...X, pbCounted: true }, cfg, floor, { exclude: new Set([left]), cool: demotion(now), banded: PP.policy.owner.banded !== false, seed: ":h", quiet: true, t0: tierRankOf(rowOf(PP, left)) });
      return r.cand;
    }
    // LIMIT OF THE REACTIVE PATH: a daily-limit answer (Retry-After above 60 s) makes Claude Code fail the subagent at once, and NO retry reaches the router, so nothing here can
    // react to it. What steers NEW agents away from such a model is the demotion (the cooling ladder and the overlay hint above), not this handoff.
    // ar-17: hand the agent over to the next banded candidate that fits THIS request (the retry request itself is the agent's first request after the failure, so it is
    // the first request on the new model: the messages API is stateless, no context is copied). The failed model is marked cooling first. Never back to a model left in the
    // last 30 minutes unless it is the only usable one (a trail of up to 5 per agent); at most 3 handoffs per agent per hour; none when no alternative exists (the agent
    // keeps its model). The sticky entry and its journal line move to the new model. Returns the new model or null.
    function handoff(s, sig, mainM, agentKey2, key, now) {
      const hist = (s.hist || []).filter((x) => now - x[1] < HAND.hourMs);
      if (hist.length >= HAND.maxHour) { count("handoffCap"); return null; }
      const S0 = listFor(pol, mainM);
      if (S0 === undefined || (S0 !== null && !Array.isArray(S0))) { count("handoffNone"); return null; }
      const from = s.model, hint = own(pol.ctxHints, asked0), floor = Math.max(typeof hint === "number" ? hint : 0, SUBSTITUTE_FLOOR);
      const X = { beta1m: hdr(h, H_BETA).indexOf(BETA_1M) >= 0, tokenCount: req.tokenCount, bytes, agentKey: agentKey2, hasTag: false };
      const cool = demotion(now), banded = pol.owner.banded !== false, seed = `:h${s.hops + 1}`;
      const recent = new Set(hist.filter((x) => now - x[1] < HAND.backMs).map((x) => x[0]));
      recent.add(from);
      const t0 = tierRankOf(rowOf(P, from));                       // D2: never from a tested tier to an untested one
      // 6.1b E.3: a handoff uses NON-cooling rows only (a demoted row is for NEW agents): when every row is demoted the agent keeps its model and handoffNone counts it. In free
      // mode the set holds only free models, so an all-cooling free set ends here too, never on a paid model (O3: no price cap, the toggles decide what is in the set).
      let r = pickSubstitute(P, S0, mainM, X, config, floor, { exclude: recent, cool, banded, seed, t0, noCool: true });
      if (!r.cand) r = pickSubstitute(P, S0, mainM, X, config, floor, { exclude: new Set([from]), cool, banded, seed, t0, noCool: true });
      if (!r.cand) { count("handoffNone"); return null; }
      s.model = r.cand; s.t = now; s.lt = now; s.ph = pol.contentHash; s.hops += 1;
      s.hist = [...hist, [from, now]].slice(-HAND.trailMax);
      journalAppend(sid, { k: key.slice(sid.length + 1), m: s.model, t: now, h: s.ph, c: s.c, hp: s.hops, x: s.hist, r: "handoff" });
      count("handoff");
      st.hand.push({ from, to: s.model, t: now }); if (st.hand.length > 50) st.hand.shift();
      warnSet("HANDOFF", `${logSel(from)} -> ${logSel(s.model)} at ${new Date(now).toISOString()}`);
      if (pol.owner.handoffNotice !== false) {
        try { if (injectNotice(req.body, from, s.model)) count("noticeApplied"); else count("noticeFail"); } catch { count("noticeFail"); /* the handoff stands without the notice */ }
      }
      const reason = `retry:${sig.src}:${sig.cnt}`;
      const dl = { act: "handoff", would: s.model, ret: s.model, why: reason, flags: [], from, to: s.model, hop: s.hops, rsrc: sig.src, reason };
      logAgent(c, dl, "handoff");
      logDecision(c, { act: "handoff", would: s.model, ret: s.model, why: reason, flags: [], stk: 1 });
      return s.model;
    }
    function countAct(act, flags) {
      const m = { "keep": "keep", "honour-tag": "honourTag", "substitute": "substitute", "inherit": "inherit", "empty-set": "emptySet", "unknown-main": "unknownMain",
        "unresolvable": "unresolvable", "reject-unresolvable": "rejectUnresolvable" };
      if (m[act]) count(m[act]);
      for (const f of flags) {
        if (f === "EMPTY_SET" || f === "UNKNOWN_MAIN" || f === "INHERIT_BELOW_CTX" || f === "INHERIT_PREMIUM_MAIN" || f === "UNRESOLVABLE_ASKED") warn(f, logSel(c.asked0));
        if (f === "CTX_UNDELIVERED") { count("ctxUndelivered"); warn(f); }
        if (f === "UNRESOLVABLE_CANDIDATE") warn("UNRESOLVABLE_CANDIDATE");
      }
    }
  } catch (e) {
    count("error"); warn("ROUTER_ERROR", e && e.name);             // the name only, never the message
    if (guarded) recordError(nowMs());
    return asked0;
  } finally {
    try {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms > 5) count("slowReq");
      if (pathTag) S().lat[pathTag][latBucket(ms)] += 1;
    } catch { /* never throws */ }
  }
};
function priceOf(P, sel) { const r = sel ? rowOf(P, sel) : null; return r ? r.i : null; }
module.exports.__test = seam;
return module.exports;
};

// The loader: the ONLY module-scope code. Three statements: ONE statSync of this file, ONE globalThis lookup, and ONE guarded removal of this module from its parent's `children` list.
// The identity of the body is (mtime, size, inode) of the file PLUS the compiled source's own length and a hash of its first and last 4,096 characters (SEC-1): `require` reads the
// file's bytes BEFORE this stat, so a file replaced in between would otherwise store the OLD code under the NEW file's identity and pin it silently; the source identity comes from
// the bytes that were actually compiled, so such a swap gives a different key on the next load and the new bytes are evaluated. A stat that fails means the identity is unknown, so
// the body is evaluated fresh and not stored (the pre-S-F2 behaviour, correct but leaky). The registry is bounded (an entry per file path, at most 64 paths).
// The splice (approved, O4b): every re-require makes Node push a Module onto its parent's `children` and never free it, which was the whole leak of the pre-S-F2 router; removing
// this module again (guarded: a missing or odd parent is harmless) keeps that list from growing. require.cache is untouched: CCR deletes that entry itself.
module.exports = (function load() {
  let id = "";
  try {
    const st = require("node:fs").statSync(__filename), src = __uwImpl.toString();
    let h = 2166136261;
    const ends = src.length <= 8192 ? src : src.slice(0, 4096) + src.slice(-4096);
    for (let i = 0; i < ends.length; i++) { h ^= ends.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    id = st.mtimeMs + ":" + st.size + ":" + st.ino + ":" + src.length + ":" + h;
  } catch { /* identity unknown */ }
  let impl;
  if (!id) impl = __uwImpl("");
  else {
    const g = globalThis;
    let reg = g.__uwRouterImpl;
    if (!reg || typeof reg !== "object") reg = g.__uwRouterImpl = Object.create(null);
    const hit = reg[__filename];
    if (hit && hit.id === id) impl = hit.impl;
    else {
      impl = __uwImpl(id);
      reg[__filename] = { id, impl };                              // replaces the older code of this file: it is no longer reachable from here
      const keys = Object.keys(reg);
      if (keys.length > 64) delete reg[keys[0]];
    }
  }
  try { const p = module.parent; if (p && Array.isArray(p.children)) { const i = p.children.lastIndexOf(module); if (i >= 0) p.children.splice(i, 1); } } catch { /* a missing or odd parent is harmless */ }
  return impl;
})();

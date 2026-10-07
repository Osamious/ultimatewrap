// The review fixes for the live-status feature (C2 + C5): the reload decision, a snapshot rebuilt after the overlay, the live clock, the
// unverified-only `(n live)`, the launcher's hardening. Temp directories and fake spawns only; a spy over the file system asserts that no test in
// this file touches the REAL `~/.uw/state`.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import { bakeBench, applyLive, buildSnapshot } from "../menu/snapshot.mjs";
import { loadBench } from "../menu/bench-data.mjs";
import { loadObserved, openOverlay, decideOverlayReload, fileMtime, feedNote, observeOffFile } from "../menu/observed-data.mjs";
import { launchObserver, childEnv, OBSERVE_SCRIPT, OBSERVE_CWD, LAUNCH_MIN_INTERVAL_MS } from "../menu/observe-launch.mjs";
import { detectCaps, frame, frameWidth, hhmmZ, liveReplyLead } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { metaFor } from "../menu/uwpick.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const ASCII = { TERM: "dumb" };
const sepOf = () => ":";
const NOW = Math.floor(Date.now() / 1000);
const NOW_MS = NOW * 1000;
const iso = (s) => new Date(s * 1000).toISOString();
const M = (id) => ({ id, ctx: 128000, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true, provenance: "listing-verified" });
const ROW = (provider, ids, o = {}) => ({ keyId: `personal.${provider}.free`, provider, free: 0, planCount: 0, health: "ok", models: ids.map(M), ...o });
const tmp = () => mkTmp("uw-livereview-");
const done = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (d, name, v) => fs.writeFileSync(path.join(d, name), typeof v === "string" ? v : JSON.stringify(v));
const overlayFile = (models, o = {}) => ({ schema: 1, writtenAt: iso(NOW), feed: "ok", wm: { id: 1, seq: 1, at: iso(NOW) }, models, pend: {}, conf: {}, ...o });

guardRealState(after, assert);

// =========================================================== M1: the reload decision

const fakeOpts = (o = {}) => {
  const calls = [];
  return { calls, file: "X", stat: (f) => { calls.push("stat"); if (o.mtime === null) throw new Error("ENOENT"); return { mtimeMs: o.mtime }; },
           load: () => { calls.push("load"); if (o.throws) throw new Error("boom"); return o.observed ?? null; }, enabled: () => o.enabled ?? true };
};
const OBS = { models: new Map(), prov: null, feed: "ok" };

test("reload decision: same mtime -> nothing; a new (or BACKWARDS) mtime with a readable file -> apply; nothing is read when the mtime is unchanged", () => {
  const same = fakeOpts({ mtime: 100, observed: OBS });
  assert.deepEqual(decideOverlayReload(100, same), { kind: "same", mtime: 100, observed: null });
  assert.deepEqual(same.calls, ["stat"], "one stat, no read");
  const newer = decideOverlayReload(100, fakeOpts({ mtime: 200, observed: OBS }));
  assert.deepEqual([newer.kind, newer.mtime, newer.observed], ["apply", 200, OBS]);
  const back = decideOverlayReload(200, fakeOpts({ mtime: 150, observed: OBS }));
  assert.deepEqual([back.kind, back.mtime], ["apply", 150], "a clock or a restore that moves the mtime backwards is still a change");
  assert.equal(decideOverlayReload(undefined, fakeOpts({ mtime: 5, observed: OBS })).kind, "apply", "an unreadable open (undefined) retries at once");
});

test("reload decision: a torn or half-written file KEEPS the previous state and is retried next time; only a missing file or the kill switch clears", () => {
  const torn = decideOverlayReload(100, fakeOpts({ mtime: 200, observed: null }));
  assert.deepEqual([torn.kind, torn.mtime], ["keep", 100], "kept, and the remembered mtime does NOT advance, so the next keystroke retries");
  // the retry, once the writer finished
  assert.equal(decideOverlayReload(torn.mtime, fakeOpts({ mtime: 200, observed: OBS })).kind, "apply");
  assert.equal(decideOverlayReload(100, fakeOpts({ mtime: 200, throws: true })).kind, "keep", "a throwing reader is a torn read");
  const gone = decideOverlayReload(100, fakeOpts({ mtime: null }));
  assert.deepEqual([gone.kind, gone.mtime, gone.observed], ["clear", null, null], "deleted: cleared");
  assert.equal(decideOverlayReload(null, fakeOpts({ mtime: null })).kind, "same", "still missing: nothing to do");
  const off = decideOverlayReload(100, fakeOpts({ mtime: 200, observed: null, enabled: false }));
  assert.deepEqual([off.kind, off.mtime], ["clear", 200], "the sentinel appears: cleared");
  assert.equal(decideOverlayReload(100, fakeOpts({ mtime: 200, observed: OBS, enabled: false })).kind, "apply", "a readable overlay is applied (the reader itself returns null while the sentinel exists)");
});

test("reload decision against real temp files: torn then repaired, deleted, sentinel", () => {
  const d = tmp();
  try {
    const file = path.join(d, "observed.json");
    put(d, "observed.json", overlayFile({ "p/a": { s: "rate", a: NOW } }));
    const o0 = openOverlay({ file });
    assert.ok(o0.observed && typeof o0.mtime === "number");
    fs.writeFileSync(file, '{"schema":1,"models":{"p/a":{"s":"ra');
    const t = new Date(Date.now() + 5000); fs.utimesSync(file, t, t);
    const torn = decideOverlayReload(o0.mtime, { file });
    assert.equal(torn.kind, "keep");
    put(d, "observed.json", overlayFile({ "p/a": { s: "pay", a: NOW } }));
    const t2 = new Date(Date.now() + 9000); fs.utimesSync(file, t2, t2);
    const fixed = decideOverlayReload(torn.mtime, { file });
    assert.equal(fixed.kind, "apply");
    assert.equal(fixed.observed.models.get("p/a").s, "pay");
    put(d, "observe.off", "");
    const t3 = new Date(Date.now() + 12000); fs.utimesSync(file, t3, t3);
    assert.equal(decideOverlayReload(fixed.mtime, { file }).kind, "clear", "the sentinel makes the reader null: cleared");
    fs.rmSync(path.join(d, "observe.off"));
    fs.rmSync(file);
    assert.equal(decideOverlayReload(fixed.mtime, { file }).kind, "clear", "deleted");
    assert.equal(fileMtime(file), null);
  } finally { done(d); }
});

test("L7 open-time order: the mtime is taken BEFORE the file is read; an unreadable file at open is retried on the first keystroke", () => {
  const f = fakeOpts({ mtime: 100, observed: OBS });
  const r = openOverlay(f);
  assert.deepEqual(f.calls, ["stat", "load"], "stat first, so a write landing between the two is a newer mtime next time");
  assert.deepEqual([r.observed, r.mtime], [OBS, 100]);
  const torn = openOverlay(fakeOpts({ mtime: 100, observed: null }));
  assert.equal(torn.observed, null);
  assert.equal(torn.mtime, undefined, "never equals a real mtime: the next keystroke retries");
  const missing = openOverlay(fakeOpts({ mtime: null }));
  assert.deepEqual([missing.observed, missing.mtime], [null, null], "missing: nothing to retry");
  assert.equal(openOverlay(fakeOpts({ mtime: 100, observed: null, enabled: false })).mtime, 100, "the kill switch is not 'unreadable'");
  assert.equal(openOverlay({ ...fakeOpts({ mtime: 100, throws: true }) }).mtime, undefined, "a throwing reader at open is unreadable too");
});

// ============================================= M2 and L1: a snapshot rebuilt AFTER the overlay agrees at both levels

test("bakeBench bakes live and liveOk (unverified only) when the reader is merged, and neither key otherwise", () => {
  const row = ROW("p", ["a", "b", "c", "d"]);
  const recs = { "p/a": { s: "ok", a: NOW - 5, l: 1 }, "p/b": { s: "ok", a: NOW - 5, l: 1, v: 1 }, "p/c": { s: "rate", a: NOW - 5, l: 1 }, "p/d": { s: "ok", a: NOW - 900 } };
  const plain = (t) => recs[t] ?? null; plain.records = 4;
  assert.deepEqual(Object.keys(bakeBench(row, plain, NOW_MS)).sort(), ["bench", "benchAgeHist", "benchFlags"]);
  const merged = Object.assign((t) => recs[t] ?? null, { records: 4, isLive: (t) => !!recs[t]?.l });
  const b = bakeBench(row, merged, NOW_MS);
  assert.equal(b.live, 2, "a (ok) and c (rate): the verified b is a probe measurement now");
  assert.equal(b.liveOk, 1, "only a is an unverified live ok");
  assert.equal(b.bench.ok, 3, "the counts themselves still include every ok");
});

test("a snapshot rebuilt after the overlay: level 0 (baked live counts, no applyLive) says what level 1 says, header and stamp", () => {
  const d = tmp();
  try {
    const rows = [ROW("p", ["a", "b", "c"])];
    put(d, "bench.json", { schema: 1, generatedAt: iso(NOW), models: { "p/a": { s: "auth", a: NOW - 3600 }, "p/b": { s: "ok", a: NOW - 3600 } } });
    put(d, "observed.json", overlayFile({ "p/a": { s: "ok", a: NOW - 20 }, "p/c": { s: "ok", a: NOW - 10 }, "p/b": { s: "ok", a: NOW - 50, v: 1 } }, { writtenAt: iso(NOW - 5) }));
    const bench = loadBench(path.join(d, "bench.json"));
    const snap = buildSnapshot({ generatedAt: "x", rows }, { bench: { generatedAt: iso(NOW), size: bench.size, get: bench.get }, nowMs: NOW_MS });
    assert.equal(snap.rows[0].benchLive, 2);
    assert.equal(snap.rows[0].benchLiveOk, 2, "a and c: unverified live oks (b is verified)");
    assert.equal(snap.rows[0].bench.ok, 3);
    assert.equal(snap.schemaVersion, 9, "additive optional row fields: no bump");
    const observed = loadObserved(path.join(d, "observed.json"));
    const built = { ...snap, builtAt: iso(NOW) };                      // built AFTER the overlay was written
    assert.equal(applyLive(built, observed), built, "so applyLive is a no-op");
    const meta = { ...metaFor(built, observed), keyIdW: 20 };
    assert.equal(meta.liveOkTotal, 2);
    assert.ok(meta.liveAt >= NOW - 20 && meta.liveAt <= NOW - 10, "the live stamp is there at level 0");
    const caps = detectCaps(ASCII, 134);
    const l0 = strip(frame(view(initState(built.rows, { nowMs: NOW_MS })), meta, { caps }).find((l) => l.includes("filter:")));
    let s = reduce(initState(built.rows, { nowMs: NOW_MS, termRows: 30 }), "\r").state;
    s = reduce(s, { benchOf: bench.get }).state;
    const l1 = strip(frame(view(s), { providers: 1, models: 3, benchOf: bench.get, benchAsOf: iso(NOW), keyIdW: 20, rows: built.rows, liveAt: bench.liveAt }, { caps }).find((l) => l.includes("filter:")));
    assert.ok(l0.includes("3 ok (2 live)"), l0);
    assert.ok(l1.includes("3 ok (2 live)"), l1);
    const idLine = strip(frame(view(initState(built.rows, { nowMs: NOW_MS })), meta, { caps }).find((l) => l.includes("id: ")));
    assert.match(idLine, /live \d\d:\d\dZ/);
    // kill switch: no overlay object -> no figure and no stamp at level 0, though the baked counts stay
    const off = metaFor(built, null);
    assert.deepEqual([off.liveOkTotal, off.liveAt], [0, null]);
    // a future-dated overlay entry is not a stamp
    const fut = loadObserved(path.join(d, "observed.json"));
    fut.models.set("p/z", { s: "ok", a: NOW + 3600, l: 1 });
    assert.ok(metaFor(built, fut).liveAt < NOW, "a record dated an hour ahead is ignored");
  } finally { done(d); }
});

test("a carried snapshot keeps its live row fields; a rebuild without the overlay has none", () => {
  const built = { generatedAt: "x", rows: [ROW("p", ["a"])] };
  const merged = Object.assign((t) => (t === "p/a" ? { s: "ok", a: NOW - 5, l: 1 } : null), { records: 1, isLive: (t) => t === "p/a" });
  const snap = buildSnapshot(built, { bench: { generatedAt: iso(NOW), size: 1, get: merged }, nowMs: NOW_MS });
  assert.deepEqual([snap.rows[0].benchLive, snap.rows[0].benchLiveOk], [1, 1]);
  const carried = buildSnapshot(built, { previous: snap, bench: null, nowMs: NOW_MS + 1000 });
  assert.deepEqual([carried.rows[0].benchLive, carried.rows[0].benchLiveOk], [1, 1]);
  const plain = Object.assign((t) => null, { records: 0 });
  assert.equal(Object.hasOwn(buildSnapshot(built, { bench: { generatedAt: iso(NOW), size: 0, get: plain }, nowMs: NOW_MS }).rows[0], "benchLive"), false);
});

test("L1: the header's (n live) excludes verified records at both model levels", () => {
  const ids = ["a", "b", "c"];
  const row = ROW("acme", ids);
  const recs = { a: { s: "ok", a: NOW - 5, l: 1, d: 5 }, b: { s: "ok", a: NOW - 5, l: 1, v: 1, t: 4, d: 9, p: "hi" }, c: { s: "ok", a: NOW - 500, t: 1, d: 2, p: "x" } };
  const benchOf = Object.assign((t) => recs[t.replace(/^acme\//, "")] ?? null, { records: 3 });
  let s = reduce(initState([row], { nowMs: NOW_MS, termRows: 40 }), "\r").state;
  s = reduce(s, { benchOf }).state;
  const meta = { providers: 1, models: 3, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [row] };
  const head = (st) => strip(frame(view(st), meta, { caps: detectCaps(ASCII, 134) }).find((l) => l.includes("filter:")));
  assert.ok(head(s).includes("3 ok (1 live) (100%)"), head(s));
  assert.ok(head(reduce(s, "\t").state).includes("3 ok (1 live)"));
});

// ========================================================= M3: the frozen open clock and the live clock

test("the live clock: `confirming...` reads liveNow, not the frozen open time; it expires in-session; the view carries liveNow", () => {
  const T = NOW - 600;                                                        // the picker was opened ten minutes ago
  const cfa = NOW - 1;                                                        // the child flipped it well after the open
  const rec = { s: "ok", a: NOW - 3, l: 1, d: 100, cf: 1, cfa };
  const benchOf = Object.assign((t) => (t === "acme/m" ? rec : null), { records: 1 });
  let s = reduce(initState([ROW("acme", ["m"])], { nowMs: T * 1000, termRows: 30 }), "\r").state;
  s = reduce(s, { benchOf }).state;
  assert.equal(view(s).now, T * 1000);
  assert.equal(view(s).liveNow, T * 1000, "a fresh state's live clock is the open time until the picker refreshes it");
  const meta = { providers: 1, models: 1, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [ROW("acme", ["m"])] };
  const reply = (liveNow) => strip(frame({ ...view(s), liveNow }, meta, { caps: detectCaps(ASCII, 200) }).find((l) => l.includes("reply:")));
  assert.match(reply(NOW * 1000), /worked live; confirming\.\.\./, "cfa is after the frozen open time and still shows confirming");
  assert.match(reply((cfa + 119) * 1000), /worked live; confirming\.\.\./);
  assert.match(reply((cfa + 130) * 1000), /answered HTTP 200/, "the window expires while the picker is open");
  assert.equal(liveReplyLead(rec, (T + 1) * 1000).body.startsWith("answered"), true, "judged against the frozen clock it would NOT be confirming: why the live one is used");
  // the reducer keeps a state's liveNow across events
  assert.equal(view(reduce({ ...s, liveNow: NOW * 1000 }, "\x1b[B").state).liveNow, NOW * 1000);
});

test("a live record written after the picker opened (past the 5-minute skew of the frozen clock) still draws, counts and shows its age", () => {
  const T = NOW - 600;
  const rec = { s: "ok", a: NOW - 20, l: 1, d: 50 };                         // 9m40s after the open: beyond the skew of state.now
  const probe = { s: "ok", a: NOW - 20, t: 1, d: 2, p: "x" };
  const benchOf = Object.assign((t) => ({ "acme/live": rec, "acme/probe": probe })[t] ?? null, { records: 2 });
  const row = ROW("acme", ["live", "probe"]);
  let s = reduce(initState([row], { nowMs: T * 1000, termRows: 30 }), "\r").state;
  s = reduce({ ...s, liveNow: NOW * 1000 }, { benchOf }).state;
  const meta = { providers: 1, models: 2, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [row] };
  const lines = frame(view({ ...s, cur: [0, 1, 0] }), meta, { caps: { ...detectCaps(ASCII, 200), colours: 0 } });
  const cells = (id) => strip(lines.find((l) => strip(l).split(sepOf())[0].trim().endsWith(id) && !l.includes("id:"))).split(sepOf());
  assert.equal(cells("live")[1].trim(), "OK", "drawn, uppercase");
  assert.equal(cells("live")[2].trim(), "20s".replace("20s", "<1m"), "its age is measured on the live clock, not refused");
  const head = strip(lines.find((l) => l.includes("filter:")));
  assert.ok(head.includes("2 ok (1 live)"), head);
  // a probe record keeps the FROZEN clock: its age is measured against the open time (stable while open)
  assert.equal(cells("probe")[2].trim(), "", "a probe record dated after the frozen open time is not aged against the wall clock");
});

// ========================================================== L3, L4, L6: smaller fixes

test("L4: an overlay with no entries and no bench.json is not the shared empty reader: its feed note survives entering a model screen", () => {
  const d = tmp();
  try {
    put(d, "observed.json", overlayFile({}, { feed: "unavailable:schema" }));
    const b = loadBench(path.join(d, "bench.json"));
    assert.equal(b.size, 0);
    assert.equal(b.get("p/a"), null);
    assert.equal(b.live, 0);
    assert.ok(b.overlay, "the overlay's metadata is there");
    assert.equal(feedNote(b.overlay), "live feed unavailable (schema changed)");
    assert.equal(b.get.records, 0);
    assert.equal(b.get.isLive("p/a"), false);
    assert.equal(loadBench(path.join(d, "bench.json"), { observed: false }).overlay, null);
    fs.rmSync(path.join(d, "observed.json"));
    assert.equal(loadBench(path.join(d, "bench.json")).overlay, null, "no overlay, no bench.json: the plain empty result");
  } finally { done(d); }
});

test("L6: applyLive clamps every count to the row's model count, and prov REPLACES the flags (a null included)", () => {
  const d = tmp();
  try {
    const prov = { "personal.p.free": { bench: { ok: 9e15, rate: 2, auth: 99999 }, benchFlags: null, benchAgeHist: null, live: 5000, liveOk: 9000 },
                   "personal.q.free": { bench: { ok: 1 }, benchFlags: { alive: true, status: "alive" }, live: -3, liveOk: 1 } };
    put(d, "observed.json", overlayFile({ "p/a": { s: "ok", a: NOW } }, { prov }));
    const observed = loadObserved(path.join(d, "observed.json"));
    const rows = [ROW("p", ["a", "b", "c"], { benchFlags: { alive: true, status: "alive" } }), ROW("q", ["x"], { benchFlags: { alive: false, status: "dead" } })];
    const out = applyLive({ schemaVersion: 9, builtAt: iso(NOW - 900), rows }, observed);
    assert.deepEqual([out.rows[0].bench.ok, out.rows[0].bench.rate, out.rows[0].bench.auth, out.rows[0].bench.gone], [3, 2, 3, 0], "counts never exceed the 3 models");
    assert.deepEqual([out.rows[0].benchLive, out.rows[0].benchLiveOk], [3, 3]);
    assert.equal(out.rows[0].benchFlags, null, "the recorder's null verdict replaces the older non-null one");
    assert.deepEqual([out.rows[1].benchLive, out.rows[1].benchLiveOk], [0, 0], "a negative count is 0 and liveOk never exceeds live");
    assert.equal(out.rows[1].benchFlags.status, "alive");
    for (const r of out.rows) for (const n of Object.values(r.bench)) assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= r.models.length);
    // and the frame stays whole with those numbers
    const meta = { ...metaFor(out, observed), keyIdW: 20 };
    for (const cols of [78, 134]) { const caps = detectCaps(ASCII, cols); for (const l of frame(view(initState(out.rows, { nowMs: NOW_MS })), meta, { caps })) assert.equal(cps(strip(l)), frameWidth(caps)); }
    assert.equal(applyLive({ schemaVersion: 9, builtAt: iso(NOW - 900), rows }, undefined).rows, rows, "no default reader: undefined applies nothing and reads nothing");
  } finally { done(d); }
});

// =============================================================== the launcher, hardened

const runGate = (o = {}) => {
  const d = tmp();
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  if (o.setup) o.setup(d);
  const res = launchObserver({ spawn, env: {}, now: NOW_MS, stateDir: d, session: { at: null }, ...o.args });
  done(d);
  return { res, calls };
};

test("launch (a): shell:false, cwd pinned to the repo root, fixed argv: no env, snapshot or overlay value can reach it", () => {
  const evil = { PATH: "p", UW_X: "--inspect", NODE_OPTIONS: "--require evil", CCR_INTERNAL_A: "1", "--catchup": "x", ARGV: "a b", COMSPEC: "cmd", Path: "P2" };
  const { calls } = runGate({ args: { env: evil } });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["--no-warnings", OBSERVE_SCRIPT, "--catchup"], "exactly the fixed argv");
  assert.equal(calls[0].opts.shell, false);
  assert.equal(calls[0].opts.cwd, OBSERVE_CWD);
  assert.equal(calls[0].cmd, process.execPath);
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "menu", "observe-launch.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/\bspawn\(process\.execPath, \["--no-warnings", script, "--catchup"\]/.test(src), true, "the argv is a literal in the call, built from nothing else");
  assert.equal(/\bexec(Sync|File)?\(|\bfork\(|shell: true/.test(src), false);
});

test("launch (b): the child gets an allowlisted environment: PATH-like names, user dirs, UW_* and CCR_INTERNAL_*, matched case-insensitively", () => {
  const env = { Path: "C:\\bin", PATHEXT: ".EXE", SystemRoot: "C:\\Windows", windir: "C:\\Windows", ComSpec: "cmd.exe", APPDATA: "a", LOCALAPPDATA: "l", USERPROFILE: "u", HOME: "h",
                HOMEDRIVE: "C:", HOMEPATH: "\\x", TEMP: "t", TMP: "t2", UW_OBSERVE_X: "1", uw_lower: "2", CCR_INTERNAL_DATA: "3",
                ANTHROPIC_API_KEY: "sk-secret", NODE_OPTIONS: "--require x", HTTPS_PROXY: "http://p", GITHUB_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", NPM_CONFIG_X: "y", UWX: "no", NOT_UW_X: "no", N: 5 };
  const out = childEnv(env);
  assert.deepEqual(Object.keys(out).sort(), ["APPDATA", "CCR_INTERNAL_DATA", "ComSpec", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATHEXT", "Path", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "UW_OBSERVE_X", "uw_lower", "windir"].sort());
  for (const k of ["ANTHROPIC_API_KEY", "NODE_OPTIONS", "HTTPS_PROXY", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "NPM_CONFIG_X", "NOT_UW_X"]) assert.equal(Object.hasOwn(out, k), false, k);
  for (const bad of [null, undefined, "x", 5]) assert.deepEqual(childEnv(bad), {});
  const { calls } = runGate({ args: { env: { PATH: "/x", ANTHROPIC_API_KEY: "sk-secret", UW_QA: "1" } } });
  assert.deepEqual(calls[0].opts.env, { PATH: "/x", UW_QA: "1" }, "the spawn option carries the allowlist, not the whole environment");
});

test("launch (c): the throttle does not fail open: a missing observed.run spawns, but one session never spawns twice inside 30 s", () => {
  const d = tmp();
  try {
    const calls = [];
    const spawn = () => { calls.push(1); return { on() {}, unref() {} }; };
    const session = { at: null };
    const go = (now) => launchObserver({ spawn, env: {}, now, stateDir: d, session });
    assert.equal(fs.existsSync(path.join(d, "observed.run")), false, "there is no observed.run at all");
    assert.deepEqual(go(NOW_MS), { spawned: true, reason: "spawned" });
    assert.deepEqual(go(NOW_MS + 1000), { spawned: false, reason: "session-throttle" });
    assert.deepEqual(go(NOW_MS + LAUNCH_MIN_INTERVAL_MS - 1), { spawned: false, reason: "session-throttle" });
    assert.equal(go(NOW_MS + LAUNCH_MIN_INTERVAL_MS + 1).spawned, true, "after the interval it may spawn again");
    assert.equal(calls.length, 2);
    // a file gate still wins first, and a refused spawn does not reset the guard
    put(d, "observed.run", "{}");
    const s2 = { at: null };
    assert.equal(launchObserver({ spawn, env: {}, now: NOW_MS, stateDir: d, session: s2 }).reason, "recent");
    assert.equal(s2.at, null);
    // a spawn that throws does not arm the guard (nothing started)
    const s3 = { at: null };
    fs.rmSync(path.join(d, "observed.run"));
    assert.equal(launchObserver({ spawn: () => { throw new Error("x"); }, env: {}, now: NOW_MS, stateDir: d, session: s3 }).spawned, false);
    assert.equal(s3.at, null);
  } finally { done(d); }
});

test("launch (d): stat-only (no read, no write), and no reason carries data beyond a gate word or the exception's own message, capped at 80", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "menu", "observe-launch.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(/\b(readFileSync|readFile|writeFileSync|writeFile|appendFile|openSync|readSync|createReadStream|readdirSync|mkdirSync|rmSync|unlinkSync|renameSync)\b/.test(src), false, "stat/exists only");
  assert.ok(/\bstatSync\b/.test(src) && /\bexistsSync\b/.test(src));
  const reasons = new Set();
  for (const o of [{ args: { env: { UW_OBSERVE: "0" } } }, { args: { env: { UW_OBSERVE_NO_SPAWN: "1" } } }, { args: { env: { UW_PICKER_QUIT_IMMEDIATELY: "1" } } },
    { setup: (d) => put(d, "observe.off", "") }, { args: { script: path.join(os.tmpdir(), "uw-none.mjs") } }, { setup: (d) => put(d, "observed.run", "1") }, { setup: (d) => put(d, "observed.lock", "1") }, {}]) reasons.add(runGate(o).res.reason);
  assert.deepEqual([...reasons].sort(), ["env-off", "kill-switch", "locked", "no-script", "no-spawn", "quit-immediately", "recent", "spawned"]);
  const secret = "sk-ROUTER-DATA-" + "z".repeat(200);
  const r = launchObserver({ spawn: () => { throw new Error(secret); }, env: {}, now: NOW_MS, stateDir: os.tmpdir(), session: { at: null } });
  assert.equal(r.reason.length <= 80, true);
  assert.match(r.reason, /^error: /);
  assert.equal(observeOffFile(path.join(os.tmpdir(), "observed.json")), path.join(os.tmpdir(), "observe.off"));
  void hhmmZ;
});

test("wording: the legend says what (n live) counts and what a live row's probed shows; the comments stayed with their functions", async () => {
  const { legendLines } = await import("../menu/legend.mjs");
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n").replace(/\s+/g, " ");
  assert.ok(text.includes("n = oks that came from real use (the live feed) and are not yet confirmed by a probe"));
  assert.ok(text.includes("A live (UPPERCASE) row shows the age of its live observation."));
  const ps = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "menu", "pick-state.mjs"), "utf8");
  assert.match(ps, /\/\/ How many routes of the open provider[^\n]*\n\/\/ denominator[^\n]*\nfunction liveGone\(/, "liveGone has its own comment again");
  assert.match(ps, /not yet confirmed by a probe[\s\S]{0,300}function liveLive\(/);
});

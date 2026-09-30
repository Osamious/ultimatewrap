// C5 of the live-status feature: the picker's side. bakeBench, the open-time recount (applyLive), the uppercase stat marker, the reply:
// prefixes, the `live HH:MMZ` stamp, `ok N (n live)`, the feed note line, and the launcher's gates. Temp directories and fake spawns only:
// nothing here reads or writes the real `~/.uw/state`, starts a process or touches the gateway.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bakeBench, applyLive, buildSnapshot } from "../menu/snapshot.mjs";
import { loadBench, countStatuses, STATUSES, statusCode, isLive } from "../menu/bench-data.mjs";
import { loadObserved, feedNote } from "../menu/observed-data.mjs";
import { launchObserver, childEnv, OBSERVE_CWD, OBSERVE_ARGS, OBSERVE_SCRIPT, LAUNCH_MIN_INTERVAL_MS, LAUNCH_LOCK_FRESH_MS } from "../menu/observe-launch.mjs";
import { detectCaps, frame, frameWidth, liveReplyLead, hhmmZ, layoutFor } from "../menu/style.mjs";
import { initState, reduce, view, carryAcrossRebuild } from "../menu/pick-state.mjs";
import { firstFrame, metaFor } from "../menu/uwpick.mjs";
import { legendLines } from "../menu/legend.mjs";

guardRealState(after, assert);

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const sepOf = (env) => (env === UNI ? "┆" : ":");
const NOW = Math.floor(Date.now() / 1000);
const NOW_MS = NOW * 1000;
const iso = (s) => new Date(s * 1000).toISOString();
const M = (id) => ({ id, ctx: 128000, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true, provenance: "listing-verified" });
const ROW = (provider, ids, o = {}) => ({ keyId: `personal.${provider}.free`, provider, free: 0, planCount: 0, health: "ok", models: ids.map(M), ...o });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-live-"));
const done = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (d, name, v) => fs.writeFileSync(path.join(d, name), typeof v === "string" ? v : JSON.stringify(v));
const overlayFile = (models, o = {}) => ({ schema: 1, writtenAt: iso(NOW), feed: "ok", wm: { id: 1, seq: 1, at: iso(NOW) }, models, pend: {}, conf: {}, ...o });
const benchFile = (models) => ({ schema: 1, generatedAt: iso(NOW), models });
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

// =============================================================== bakeBench

test("bakeBench is the one recount buildSnapshot uses, over any reader, and it is exported where the recorder looks first", async () => {
  const rows = [ROW("p", ["a", "b", "c"]), ROW("q", ["x"])];
  const recs = { "p/a": { s: "ok", a: NOW - 60, t: 5, d: 9 }, "p/b": { s: "auth", a: NOW - 30 }, "q/x": { s: "timeout", a: NOW - 5, d: 9000 } };
  const get = (t) => recs[t] ?? null; get.records = 3;
  const snap = buildSnapshot({ generatedAt: "x", rows }, { bench: { generatedAt: iso(NOW), size: 3, get }, nowMs: NOW_MS });
  for (const r of rows) {
    const baked = bakeBench(r, get, NOW_MS);
    const built = snap.rows.find((x) => x.keyId === r.keyId);
    assert.deepEqual([baked.bench, baked.benchFlags, baked.benchAgeHist], [built.bench, built.benchFlags, built.benchAgeHist], r.keyId);
  }
  assert.deepEqual(Object.keys(bakeBench(rows[0], get, NOW_MS)).sort(), ["bench", "benchAgeHist", "benchFlags"]);
  assert.equal(bakeBench(rows[0], get, NOW_MS).bench.ok, 1);
  assert.equal(bakeBench(rows[0], get, NOW_MS).benchFlags.status, "alive");
  assert.equal(bakeBench(rows[1], get, NOW_MS).benchFlags.status, "dead", "an empty timeout is no response");
  // the recorder's seam: `menu/snapshot.mjs` first
  const m = await import("../menu/snapshot.mjs");
  assert.equal(typeof m.bakeBench, "function");
  assert.equal(m.SNAPSHOT_SCHEMA, 9, "no schema bump: no field changed");
});

// ===================================================================== applyLive

const SNAP_ROWS = () => [ROW("p", ["a", "b", "c"], { bench: { ok: 1, empty: 0, auth: 2, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 }, benchFlags: { dead: false, needsMoney: false, alive: true, status: "alive" }, benchAgeHist: [[490000, 3]] }),
                        ROW("q", ["x"], { bench: { ok: 0, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 }, benchFlags: null, benchAgeHist: [] })];
const PROV = { "personal.p.free": { bench: { ok: 3, rate: 0 }, benchFlags: { dead: false, needsMoney: false, alive: true, status: "alive" }, benchAgeHist: [[490000, 3]], live: 2, liveOk: 2 } };

test("applyLive lays the recorder's recount over the rows it names, only when the overlay is NEWER than the snapshot, and changes nothing else", () => {
  const d = tmp();
  try {
    put(d, "observed.json", overlayFile({ "p/a": { s: "ok", a: NOW - 5 } }, { writtenAt: iso(NOW), prov: PROV }));
    const observed = loadObserved(path.join(d, "observed.json"));
    const snap = deepFreeze({ schemaVersion: 9, builtAt: iso(NOW - 600), benchOldestAt: iso(NOW - 3 * 86400), rows: SNAP_ROWS() });
    const out = applyLive(snap, observed);
    assert.notEqual(out, snap);
    assert.equal(out.rows[1], snap.rows[1], "a row the overlay does not name is the very same object");
    const p = out.rows[0];
    assert.deepEqual(p.bench, { ok: 3, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 }, "counts are zero-filled: a missing status is 0, never absent");
    assert.equal(p.benchLive, 2);
    assert.equal(p.benchLiveOk, 2);
    assert.deepEqual(p.benchAgeHist, snap.rows[0].benchAgeHist, "age histograms are probe-only and untouched");
    assert.equal(out.benchOldestAt, snap.benchOldestAt, "so is the oldest stamp");
    assert.equal(p.models, snap.rows[0].models);
    // a snapshot built AFTER the overlay was written already has it: untouched, the same object
    const later = deepFreeze({ ...snap, builtAt: iso(NOW + 5) });
    assert.equal(applyLive(later, observed), later);
    const equal = deepFreeze({ ...snap, builtAt: iso(NOW) });
    assert.equal(applyLive(equal, observed), equal, "writtenAt must be strictly newer");
    // nothing to apply
    for (const bad of [null, undefined, { ...observed, prov: null }, { ...observed, prov: new Map() }, { ...observed, writtenAt: null }]) assert.equal(applyLive(snap, bad), snap);
    const garbage = deepFreeze({ ...snap, builtAt: "garbage" });
    assert.equal(applyLive(garbage, observed), garbage, "an unreadable build stamp applies nothing");
    assert.equal(applyLive(null, observed), null);
  } finally { done(d); }
});

test("startup reads ONE small file: applyLive and firstFrame never read bench.json (a spy on the file reads)", () => {
  const d = tmp();
  try {
    put(d, "bench.json", benchFile({ "p/a": { s: "ok", a: NOW - 100 } }));
    put(d, "observed.json", overlayFile({ "p/a": { s: "ok", a: NOW - 5 } }, { prov: PROV }));
    const seen = [];
    const real = fs.readFileSync;
    fs.readFileSync = (p, ...rest) => { seen.push(String(p)); return real(p, ...rest); };
    try {
      const observed = loadObserved(path.join(d, "observed.json"));
      const snap = applyLive({ schemaVersion: 9, builtAt: iso(NOW - 600), rows: SNAP_ROWS() }, observed);
      firstFrame({ snap, observed, recents: [], favourites: [], caps: detectCaps(ASCII, 100), termRows: 30 });
    } finally { fs.readFileSync = real; }
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((p) => p.endsWith("observed.json")), `only the overlay was read: ${seen.join(", ")}`);
  } finally { done(d); }
});

test("the kill switch: with observe.off present the overlay is not read, applyLive is a no-op, the stamp and note are gone, and nothing spawns", () => {
  const d = tmp();
  try {
    put(d, "observed.json", overlayFile({ "p/a": { s: "ok", a: NOW - 5 } }, { prov: PROV, feed: "unavailable:schema" }));
    put(d, "observe.off", "");
    const observed = loadObserved(path.join(d, "observed.json"));
    assert.equal(observed, null);
    const snap = { schemaVersion: 9, builtAt: iso(NOW - 600), rows: SNAP_ROWS() };
    assert.equal(applyLive(snap, observed), snap);
    const f = firstFrame({ snap, observed, recents: [], favourites: [], caps: detectCaps(ASCII, 100), termRows: 30 });
    assert.equal(f.meta.liveAt, null);
    assert.equal(f.meta.liveOkTotal, 0);
    assert.equal(view(f.state).feedNote, null);
    assert.equal(/live/.test(strip(f.text)), false, "no stamp, no note");
    let spawned = 0;
    assert.deepEqual(launchObserver({ spawn: () => { spawned += 1; }, env: {}, now: NOW_MS, stateDir: d }), { spawned: false, reason: "kill-switch" });
    assert.equal(spawned, 0);
    fs.rmSync(path.join(d, "observe.off"));
    assert.ok(loadObserved(path.join(d, "observed.json")), "removing it restores the read");
  } finally { done(d); }
});

test("level-0 counts and level-1 rows agree: the recorder's recount over the merged view equals the merged reader's own counts", () => {
  const d = tmp();
  try {
    const rows = [ROW("p", ["a", "b", "c", "d"])];
    put(d, "bench.json", benchFile({ "p/a": { s: "ok", a: NOW - 3600 }, "p/b": { s: "ok", a: NOW - 3600 }, "p/c": { s: "auth", a: NOW - 3600 } }));
    put(d, "observed.json", overlayFile({ "p/a": { s: "rate", a: NOW - 10 }, "p/d": { s: "ok", a: NOW - 5 }, "p/c": { s: "auth", a: NOW - 7200 } }));
    const merged = loadBench(path.join(d, "bench.json")).get;
    const baked = bakeBench(rows[0], merged, NOW_MS);
    const prov = { [rows[0].keyId]: { ...baked, live: 2, liveOk: 1 } };
    put(d, "observed.json", overlayFile({ "p/a": { s: "rate", a: NOW - 10 }, "p/d": { s: "ok", a: NOW - 5 }, "p/c": { s: "auth", a: NOW - 7200 } }, { prov, writtenAt: iso(NOW) }));
    const observed = loadObserved(path.join(d, "observed.json"));
    const snap = applyLive({ schemaVersion: 9, builtAt: iso(NOW - 900), rows: [{ ...rows[0], bench: countStatuses("p", rows[0].models, loadBench(path.join(d, "bench.json"), { observed: false }).get, NOW_MS) }] }, observed);
    const level1 = countStatuses("p", rows[0].models, loadBench(path.join(d, "bench.json")).get, NOW_MS);
    assert.deepEqual(snap.rows[0].bench, level1, "the same merge, the same counts");
    assert.equal(level1.ok, 2);                 // b (probe) and d (live only)
    assert.equal(level1.rate, 1);               // a: the live rate beat the older probe ok
    assert.equal(snap.rows[0].benchLiveOk, 1);
    // and the header says both populations
    const meta = metaFor(snap, observed);
    assert.equal(meta.okTotal, 2);
    assert.equal(meta.liveOkTotal, 1);
    assert.ok(meta.liveAt > 0);
    const caps = detectCaps(ASCII, 134);
    const head = frame(view(initState(snap.rows, { nowMs: NOW_MS })), { ...meta, keyIdW: 20 }, { caps }).map(strip).find((l) => l.includes("filter:"));
    assert.ok(head.includes("2 ok (1 live) (50%)"), head);
    const none = frame(view(initState(snap.rows, { nowMs: NOW_MS })), { ...meta, liveOkTotal: 0, keyIdW: 20 }, { caps }).map(strip).find((l) => l.includes("filter:"));
    assert.ok(none.includes("2 ok (50%)") && !none.includes("live"), none);
  } finally { done(d); }
});

// ===================================================================== the marker

const CODES = STATUSES.filter((s) => s !== "skip");
const modelRows = (recs) => {
  const ids = Object.keys(recs);
  const row = ROW("acme", ids);
  const benchOf = Object.assign((t) => recs[t.replace(/^acme\//, "")] ?? null, { records: ids.length });
  let s = reduce(initState([row], { nowMs: NOW_MS, termRows: 60 }), "\r").state;
  s = reduce(s, { benchOf }).state;
  return { row, benchOf, s };
};
const rowCells = (lines, id, env) => strip(lines.find((l) => strip(l).split(sepOf(env))[0].trim().endsWith(id) && !l.includes("id:"))).split(sepOf(env));

test("the stat cell: a live record draws its code UPPERCASE in the same 4 columns; verified or plain records stay lowercase; all 8 codes, both glyph sets, colour off", () => {
  const recs = {};
  for (const s of CODES) {
    recs[`live${s}`] = { s, a: NOW - 5, l: 1, d: 100, ...(s === "ok" ? {} : { m: "x" }) };
    recs[`ver${s}`] = { s, a: NOW - 5, l: 1, v: 1, d: 100, ...(s === "ok" ? { p: "hello" } : { m: "x" }) };
    recs[`prb${s}`] = { s, a: NOW - 5, d: 100, p: "z" };
  }
  const { benchOf, s, row } = modelRows(recs);
  const meta = { providers: 1, models: Object.keys(recs).length, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [row] };
  for (const env of [UNI, ASCII]) for (const cols of [134, 240]) {
    const caps = { ...detectCaps(env, cols), colours: 0 };
    const lines = frame(view(s), meta, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `width at ${cols}`);
    assert.equal(/\x1b/.test(lines.join("")), false, "colour off draws no colour code");
    for (const st of CODES) {
      const code = statusCode(st);
      assert.ok(code.length <= 4);
      assert.equal(rowCells(lines, `live${st}`, env)[1], code.toUpperCase().padEnd(4), `live ${st}`);
      assert.equal(rowCells(lines, `ver${st}`, env)[1], code.padEnd(4), `verified ${st} is a probe measurement again`);
      assert.equal(rowCells(lines, `prb${st}`, env)[1], code.padEnd(4), `probe ${st}`);
    }
  }
  // the colour is the tone's, upper or lower
  const p256 = detectCaps(UNI, 240);
  const coloured = frame(view({ ...s, cur: [0, 5, 0] }), meta, { caps: { ...p256, colours: 256 } });
  const has = (id) => coloured.find((l) => strip(l).includes(id));
  assert.match(has("liveok "), /\x1b\[32mOK  /);
  assert.match(has("liverate"), /\x1b\[33mRATE/);
  assert.match(has("liveauth"), /\x1b\[31mAUTH/);
});

// ================================================================ reply: prefixes

test("reply: leads: unconfirmed live ok, confirming (only within 2 minutes of cfa), live failure, confirmed; UTC HH:MMZ", () => {
  const a = Date.parse("2026-09-30T14:32:10Z") / 1000;
  assert.equal(hhmmZ(a), "14:32Z");
  for (const bad of [NaN, 0, -5, Infinity, null, undefined, "7", 1e300, 253402300799, 253402300800, 8.64e12]) assert.equal(hhmmZ(bad), "", String(bad));
  assert.equal(hhmmZ(253402300798), "23:59Z", "the last second below the cap still formats");
  assert.equal(liveReplyLead({ s: "ok", a: NOW }, NOW_MS), null, "a probe record has no live lead");
  const ok = liveReplyLead({ s: "ok", a, l: 1, d: 1234 }, a * 1000 + 60_000);
  assert.deepEqual(ok, { lead: "[live 14:32Z] ", body: "answered HTTP 200 in 1.2 s; no reply text is kept for real requests" });
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, d: 420 }, a * 1000).body, "answered HTTP 200 in 420 ms; no reply text is kept for real requests");
  assert.equal(liveReplyLead({ s: "ok", a, l: 1 }, a * 1000).body, "answered HTTP 200; no reply text is kept for real requests");
  const cfa = a + 1;
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, d: 1, cf: 1, cfa }, (cfa + 119) * 1000).body, "worked live; confirming...");
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, d: 1, cf: 1, cfa }, (cfa + 120) * 1000).body, "worked live; confirming...", "the 2-minute edge is inclusive");
  assert.match(liveReplyLead({ s: "ok", a, l: 1, d: 1, cf: 1, cfa }, (cfa + 121) * 1000).body, /^answered HTTP 200/, "older than 2 minutes: plain live ok");
  assert.match(liveReplyLead({ s: "ok", a, l: 1, d: 1, cf: 1, cfa }, (cfa - 5) * 1000).body, /^answered HTTP 200/, "a cfa in the future is not 'confirming'");
  assert.match(liveReplyLead({ s: "ok", a, l: 1, d: 1, cf: 1 }, a * 1000).body, /^answered HTTP 200/, "cf without cfa is not 'confirming'");
  assert.deepEqual(liveReplyLead({ s: "rate", a, l: 1, m: "Rate limit exceeded\x1b[2J" }, a * 1000), { lead: "[live 14:32Z] ", body: "Rate limit exceeded" });
  assert.equal(liveReplyLead({ s: "gone", a, l: 1 }, a * 1000).body, "model not found seen in real use");
  assert.equal(liveReplyLead({ s: "timeout", a, l: 1 }, a * 1000).body, "timeout seen in real use", "a word, not the 4-column code t/o");
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, d: 999.6 }, a * 1000).body, "answered HTTP 200 in 1.0 s; no reply text is kept for real requests", "999.6 ms is 1.0 s, never 1000 ms");
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, d: 999.4 }, a * 1000).body, "answered HTTP 200 in 999 ms; no reply text is kept for real requests");
  assert.deepEqual(liveReplyLead({ s: "ok", a, l: 1, v: 1, t: 400, p: "hello" }, a * 1000), { lead: "[live+probe 14:32Z] ", body: null });
  assert.equal(liveReplyLead({ s: "ok", a, l: 1, v: 1, cf: 1, cfa }, a * 1000).lead, "[live+probe 14:32Z] ", "verified wins over a leftover cf");
});

const replyOf = (rec, cols, env = ASCII, now = NOW_MS) => {
  const { benchOf, s, row } = modelRows({ only: rec });
  const meta = { providers: 1, models: 1, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [row] };
  const caps = detectCaps(env, cols);
  const lines = frame({ ...view(s), now }, meta, { caps });
  for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
  return strip(lines.find((l) => strip(l).includes("reply:")) ?? "");
};

test("the reply: line carries the lead, is clipped at the 78-column floor with an ellipsis, and keeps the probe's own text after [live+probe]", () => {
  const a = NOW - 30;
  assert.match(replyOf({ s: "ok", a, l: 1, d: 1500 }, 134), /reply: \[live \d\d:\d\dZ\] answered HTTP 200 in 1\.5 s; no reply text is kept for real requests +[|│]$/);
  assert.match(replyOf({ s: "ok", a, l: 1, d: 1500, cf: 1, cfa: NOW - 10 }, 134), /\[live \d\d:\d\dZ\] worked live; confirming\.\.\./);
  assert.match(replyOf({ s: "rate", a, l: 1, m: "Rate limit exceeded for this key" }, 134), /\[live \d\d:\d\dZ\] Rate limit exceeded for this key/);
  assert.match(replyOf({ s: "ok", a, l: 1, v: 1, t: 400, d: 900, p: "Hello there, nice to meet you" }, 134), /\[live\+probe \d\d:\d\dZ\] Hello there, nice to meet you/);
  const tight = replyOf({ s: "ok", a, l: 1, d: 1500 }, 80);
  assert.ok(/\.\.\.| ?… ?/.test(tight) || tight.includes("…") || tight.includes("..."), tight);
  assert.ok(tight.includes("[live "));
  // a probe record's reply is exactly what it was
  assert.match(replyOf({ s: "ok", a, t: 5, d: 9, p: "Hello there" }, 134), /reply: Hello there +[|│]$/);
});

// ===================================================================== the stamp

test("the live stamp: `live HH:MMZ` on the id: line iff meta.liveAt, whole or dropped, never clipped, at 78..240 in both glyph sets", () => {
  const a = Date.parse("2026-09-30T14:32:10Z") / 1000;
  const { benchOf, s, row } = modelRows({ only: { s: "ok", a: NOW - 30, t: 5, d: 9, p: "x" } });
  const base = { providers: 1, models: 1, benchOf, benchAsOf: "2026-09-30T12:34:56Z", discoveredAsOf: "2026-09-29T09:00:00Z", keyIdW: 20, rows: [row] };
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 134, 240]) {
    const caps = detectCaps(env, cols);
    const idLine = (meta) => strip(frame(view(s), meta, { caps }).find((l) => strip(l).includes("id: ")));
    assert.equal(idLine(base).includes("live"), false, "no overlay: no stamp");
    const on = idLine({ ...base, liveAt: a });
    if (cols >= 100) assert.ok(on.includes("live 14:32Z"), `${cols}: ${on}`);
    else assert.ok(!on.includes("live 1") || on.includes("live 14:32Z"), `never a clipped stamp at ${cols}: ${on}`);
    assert.equal(cps(on), frameWidth(caps));
    for (const bad of [NaN, 0, -1, "9", null]) assert.equal(idLine({ ...base, liveAt: bad }).includes("live"), false, String(bad));
  }
});

// ================================================================== the feed note

const noteState = (note, o = {}) => initState([ROW("p", ["a", "b"])], { nowMs: NOW_MS, termRows: 24, feedNote: note, ...o });
const bare = (lines) => lines.map(strip);

test("the feed note takes the notice's line: drawn when there is no outdated notice, counted once in the page size, never above the footer's neighbour twice", () => {
  const base = noteState(null), withNote = noteState("live feed unavailable (schema changed)");
  assert.equal(view(base).legendAvail - view(withNote).legendAvail, 1, "it costs exactly one row");
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 134]) {
    const caps = detectCaps(env, cols);
    const lines = bare(frame(view(withNote), { providers: 1, models: 2, rows: [ROW("p", ["a", "b"])], keyIdW: 20 }, { caps }));
    const at = lines.findIndex((l) => l.includes("live feed unavailable (schema changed)"));
    assert.equal(at, lines.length - 2, `just above the footer at ${cols}`);
    for (const l of frame(view(withNote), { providers: 1, models: 2, rows: [ROW("p", ["a", "b"])], keyIdW: 20 }, { caps })) assert.equal(cps(strip(l)), frameWidth(caps));
    assert.ok(lines[at].endsWith(" │") || lines[at].endsWith(" |"), "right-aligned");
  }
  // the outdated notice wins the line; the two never cost two rows
  const H = Math.floor((NOW_MS - 9 * 86400_000) / 3600_000);
  const rows = [{ ...ROW("p", ["a", "b"]), benchAgeHist: [[H, 2]] }];
  const both = initState(rows, { nowMs: NOW_MS, termRows: 24, feedNote: "live feed: key mapping changed", benchOldestAt: iso(NOW - 9 * 86400) });
  assert.equal(view(both).notice !== null, true);
  const lines = bare(frame(view(both), { providers: 1, models: 2, rows, keyIdW: 20 }, { caps: detectCaps(ASCII, 134) }));
  assert.equal(lines.some((l) => l.includes("key mapping changed")), false, "the outdated notice wins the line");
  assert.equal(lines.filter((l) => /outdated|Outdated/.test(l)).length, 1);
  assert.equal(view(both).legendAvail, view(initState(rows, { nowMs: NOW_MS, termRows: 24, benchOldestAt: iso(NOW - 9 * 86400) })).legendAvail, "still one row, not two");
  // modals draw neither, so they lose no row
  assert.equal(view(reduce(withNote, "?").state).legendAvail, view(reduce(base, "?").state).legendAvail);
});

test("the note at every level and in flat scope keeps the frame inside the terminal, 10 to 50 rows", () => {
  const many = Array.from({ length: 40 }, (_, i) => ROW(`p${i}`, Array.from({ length: 20 }, (_, j) => `m${j}`)));
  for (const termRows of [10, 12, 14, 20, 24, 30, 50]) for (const cols of [78, 134]) {
    const caps = detectCaps(ASCII, cols);
    const meta = { providers: 40, models: 800, rows: many, keyIdW: 20, flatIdW: 30 };
    const st = initState(many, { nowMs: NOW_MS, termRows, feedNote: "live feed unavailable (no router data)" });
    for (const [name, s] of [["level 0", st], ["level 1", reduce(st, "\r").state], ["flat", reduce(st, "\t").state]]) {
      const lines = frame(view(s), meta, { caps });
      assert.ok(lines.length <= termRows, `${name} at ${termRows} rows drew ${lines.length}`);
      assert.ok(strip(lines.at(-2)).includes("live feed unavailable"), `${name}: the note is the last content line`);
    }
  }
});

test("the note and the overlay's bench fields ride a reload: carryAcrossRebuild keeps feedNote, and the reader event can set or clear it", () => {
  const s0 = noteState("live feed: key mapping changed");
  assert.equal(carryAcrossRebuild(s0, noteState(null)).feedNote, "live feed: key mapping changed");
  const get = () => null; get.records = 1;
  assert.equal(view(reduce(noteState(null), { benchOf: get, feedNote: "live feed unavailable (schema changed)" }).state).feedNote, "live feed unavailable (schema changed)");
  assert.equal(view(reduce(s0, { benchOf: get, feedNote: null }).state).feedNote, null);
  assert.equal(view(reduce(s0, { benchOf: get }).state).feedNote, "live feed: key mapping changed", "an event without the field leaves it");
  assert.equal(view(reduce(s0, { benchOf: get, feedNote: 5 }).state).feedNote, null, "a hostile value is no note");
  assert.equal(feedNote({ feed: "unavailable:schema" }), "live feed unavailable (schema changed)");
});

test("the model-level header counts its live oks: `N of M · K ok (n live) (P%)` at level 1 and in flat scope, and nothing when there are none", () => {
  const recs = { a: { s: "ok", a: NOW - 5, l: 1, d: 5 }, b: { s: "ok", a: NOW - 500, t: 1, d: 2, p: "x" }, c: { s: "rate", a: NOW - 5, l: 1, m: "x" } };
  const { benchOf, s, row } = modelRows(recs);
  const meta = { providers: 1, models: 3, benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [row] };
  const head = (state) => strip(frame(view(state), meta, { caps: detectCaps(ASCII, 134) }).find((l) => strip(l).includes("filter:")));
  assert.ok(head(s).includes("3 of 3 | 2 ok (1 live) (67%)"), head(s));
  assert.ok(head(reduce(s, "\t").state).includes("2 ok (1 live)"), "flat scope says it too");
  const plain = modelRows({ a: { s: "ok", a: NOW - 5, t: 1, d: 2, p: "x" } });
  assert.equal(strip(frame(view(plain.s), { providers: 1, models: 1, benchOf: plain.benchOf, benchAsOf: iso(NOW), keyIdW: 20, rows: [plain.row] }, { caps: detectCaps(ASCII, 134) }).find((l) => strip(l).includes("filter:"))).includes("live"), false);
  assert.equal(isLive(benchOf("acme/a")), true);
});

// ==================================================================== the legend

test("the ? page explains the marker, the prefixes, the stamp, the feed notes, the confirmation probe and the switch", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n").replace(/\s+/g, " ");
  for (const w of ["UPPERCASE", "OK, RATE, PAY, AUTH, GONE, ERR, T/O, EMPT", "[live 14:32Z]", "[live+probe]", "confirming...", "live 14:32Z", "feed note",
    "live feed unavailable (schema changed)", "key mapping changed", "ONE tiny confirmation probe", "never for the Anthropic subscription route",
    "state/observe.off", "node refresh/observe-cli.mjs --status, --off, --on, --reset", "(n live)", "No reply text of real use is ever stored"]) assert.ok(text.includes(w), w);
  assert.match(text, /Live results never refresh oldest probe, probed ages or the outdated line/);
});

// ================================================================== the launcher

const fresh = () => ({ at: null });
const gate = (o = {}) => {
  const d = tmp();
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() { calls.at(-1).unref = true; } }; };
  const res = launchObserver({ spawn, env: {}, now: NOW_MS, stateDir: d, session: fresh(), ...o.args, ...(o.setup ? (o.setup(d), {}) : {}) });
  done(d);
  return { res, calls };
};

test("launchObserver spawns ONE detached, fixed-argv, shell-free child when nothing gates it", () => {
  const { res, calls } = gate();
  assert.deepEqual(res, { spawned: true, reason: "spawned" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, process.execPath);
  assert.deepEqual(calls[0].args, ["--no-warnings", OBSERVE_SCRIPT, "--catchup"]);
  assert.deepEqual([...OBSERVE_ARGS], ["--no-warnings", OBSERVE_SCRIPT, "--catchup"]);
  assert.deepEqual(calls[0].opts, { shell: false, cwd: OBSERVE_CWD, env: {}, detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(calls[0].unref, true, "unref'd so the picker can exit first");
  assert.equal(calls[0].opts.shell, false, "no shell, stated explicitly");
  assert.equal(calls[0].opts.cwd, path.resolve(path.dirname(OBSERVE_SCRIPT), ".."), "pinned to the repository root");
  assert.ok(fs.existsSync(path.join(OBSERVE_CWD, "menu", "observe-launch.mjs")), "which is the repo root");
  assert.ok(path.isAbsolute(OBSERVE_SCRIPT) && OBSERVE_SCRIPT.replaceAll("\\", "/").endsWith("/refresh/observe-cli.mjs"));
  assert.ok(fs.existsSync(OBSERVE_SCRIPT), "the recorder's entry exists at the path the launcher computes");
});

test("launchObserver's gates: env off, no-spawn, quit-immediately, kill switch, missing script, recent run, fresh lock; a stale lock and an old run do not gate", () => {
  const cases = [
    [{ args: { env: { UW_OBSERVE: "0" } } }, "env-off"],
    [{ args: { env: { UW_OBSERVE_NO_SPAWN: "1" } } }, "no-spawn"],
    [{ args: { env: { UW_PICKER_QUIT_IMMEDIATELY: "1" } } }, "quit-immediately"],
    [{ setup: (d) => put(d, "observe.off", "") }, "kill-switch"],
    [{ args: { script: path.join(os.tmpdir(), "uw-no-such-script.mjs") } }, "no-script"],
    [{ setup: (d) => put(d, "observed.run", "{}") }, "recent"],
    [{ setup: (d) => put(d, "observed.lock", "1") }, "locked"],
  ];
  for (const [o, reason] of cases) { const { res, calls } = gate(o); assert.deepEqual(res, { spawned: false, reason }, reason); assert.equal(calls.length, 0, `${reason} spawns nothing`); }
  const ago = (d, name, ms) => { put(d, name, "x"); const t = new Date(NOW_MS - ms); fs.utimesSync(path.join(d, name), t, t); };
  assert.equal(gate({ setup: (d) => ago(d, "observed.run", LAUNCH_MIN_INTERVAL_MS + 1000) }).res.spawned, true, "a run older than 30 s does not gate");
  assert.equal(gate({ setup: (d) => ago(d, "observed.run", LAUNCH_MIN_INTERVAL_MS - 2000) }).res.reason, "recent");
  assert.equal(gate({ setup: (d) => ago(d, "observed.lock", LAUNCH_LOCK_FRESH_MS + 1000) }).res.spawned, true, "a stale lock does not gate (the recorder takes it over)");
  assert.equal(gate({ setup: (d) => ago(d, "observed.lock", LAUNCH_LOCK_FRESH_MS - 5000) }).res.reason, "locked");
});

test("launchObserver never throws into the picker: a throwing spawn, a spawn without on/unref, and hostile injected values are all just a reason", () => {
  const d = tmp();
  try {
    const boom = launchObserver({ spawn: () => { throw new Error("EPERM " + "x".repeat(500)); }, env: {}, now: NOW_MS, stateDir: d, session: fresh() });
    assert.equal(boom.spawned, false);
    assert.match(boom.reason, /^error: EPERM/);
    assert.ok(boom.reason.length <= 80, "at most 80 characters in all, the exception's own message only");
    assert.equal(launchObserver({ spawn: () => ({}), env: {}, now: NOW_MS, stateDir: d, session: fresh() }).spawned, true, "a bare handle is fine");
    assert.equal(launchObserver({ spawn: () => null, env: {}, now: NOW_MS, stateDir: d, session: fresh() }).spawned, true);
    assert.equal(launchObserver({ spawn: () => ({ on() { throw new Error("x"); }, unref() { throw new Error("y"); } }), env: {}, now: NOW_MS, stateDir: d, session: fresh() }).spawned, true);
    assert.doesNotThrow(() => launchObserver({ spawn: null, env: null, now: "x", stateDir: 5 }));
  } finally { done(d); }
});

test("the launcher is in the picker's graph and imports no engine; uwpick calls it once, after the startup record, with no await and no .then", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const own = fs.readFileSync(path.join(root, "menu", "observe-launch.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  const imports = [...own.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./observed-data.mjs", "node:child_process", "node:fs", "node:path", "node:url"]);
  assert.equal(/\b(await|\.then\()/.test(own), false);
  assert.equal(/import\(/.test(own), false, "no dynamic import either");
  const src = fs.readFileSync(path.join(root, "menu", "uwpick.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.equal((src.match(/\blaunchObserver\(/g) ?? []).length, 1);
  assert.ok(src.indexOf("recordStartup(Number(process.hrtime.bigint() - t0) / 1e6);") < src.indexOf("launchObserver();"), "after the first frame and the startup record");
  assert.ok(src.indexOf("launchObserver();") < src.indexOf("for (;;) {"), "before the key loop");
  assert.equal((src.match(/\bloadBench\(/g) ?? []).length, 1, "still one loadBench call site: the reload reuses it");
  assert.equal(/\b(await|\.then\()/.test(src), false);
  const od = fs.readFileSync(path.join(root, "menu", "observed-data.mjs"), "utf8");
  assert.match(od, /export function fileMtime\([^)]*\) \{\s*try \{ return stat\(file\)\.mtimeMs; \} catch \{ return null; \}/, "one stat, inside a try/catch");
  assert.equal((src.match(/\bdecideOverlayReload\(/g) ?? []).length, 1);
  assert.equal((src.match(/\bopenOverlay\(/g) ?? []).length, 1);
});

test("the startup overlay read is one small file: measured firstFrame cost with and without an overlay stays far inside the 300 ms budget", () => {
  const d = tmp();
  try {
    const rows = Array.from({ length: 57 }, (_, i) => ROW(`p${i}`, Array.from({ length: 100 }, (_, j) => `m${j}`), { bench: { ok: 50, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 } }));
    const prov = Object.fromEntries(rows.map((r) => [r.keyId, { bench: { ok: 51 }, benchFlags: { dead: false, needsMoney: false, alive: true, status: "alive" }, benchAgeHist: [[490000, 100]], live: 3, liveOk: 2 }]));
    const models = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`p${i % 57}/m${i % 100}`, { s: i % 3 ? "ok" : "rate", a: NOW - i, l: 1, d: 100, m: "Rate limit exceeded" }]));
    put(d, "observed.json", overlayFile(models, { prov }));
    const snap = { schemaVersion: 9, builtAt: iso(NOW - 600), generatedAt: "x", rows };
    const caps = detectCaps(ASCII, 134);
    const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
    const runs = (withOverlay) => Array.from({ length: 5 }, () => time(() => {
      const observed = withOverlay ? loadObserved(path.join(d, "observed.json")) : null;
      firstFrame({ snap: applyLive(snap, observed), observed, recents: [], favourites: [], caps, termRows: 30 });
    })).sort((a, b) => a - b)[2];
    runs(false); runs(true);                     // warm the code
    const plain = runs(false), live = runs(true);
    assert.ok(live < 100, `median with an 800-entry overlay: ${live.toFixed(1)} ms (without: ${plain.toFixed(1)} ms)`);
    assert.ok(live - plain < 60, `the overlay adds ${(live - plain).toFixed(1)} ms`);
    console.log(`# firstFrame median ms: without overlay ${plain.toFixed(1)}, with 800-entry overlay + 57 prov rows ${live.toFixed(1)}`);
  } finally { done(d); }
});

test("liveReplyLead never lets a hostile record reach the terminal", () => {
  for (const m of ["\x1b[2J\x1b]0;PWN\x07rate", "a".repeat(9000)]) {
    const r = liveReplyLead({ s: "rate", a: NOW, l: 1, m }, NOW_MS);
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(r.lead + r.body), false);
    assert.ok(r.body.length <= 400);
  }
  assert.equal(liveReplyLead({ s: "rate", a: "9", l: 1 }, NOW_MS).lead, "[live] ", "no readable time: no time, never a gap");
  void layoutFor;
});

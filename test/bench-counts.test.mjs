// #114, level 0: the per-provider status-count columns, and the snapshot fields that feed them.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import { STATUSES, statusCode, statusTone, countStatuses, providerFlags, loadBench, benchKey,
         BENCH_FRESH_MS } from "../menu/bench-data.mjs";
import { buildSnapshot, loadSnapshot, writeSnapshotFile, SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";
import { detectCaps, glyphsFor, painter, frame, frameWidth, layoutFor, statusCount, statusCellW, keyIdWidth, KEYID_MAX, W, FRAME_MIN, FRAME_MAX,
 } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { firstFrame } from "../menu/uwpick.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tmp = () => mkTmp("uw-benchcounts-");
const NOW = 1_800_000_000_000;                          // ms
const secs = (agoMs) => Math.floor((NOW - agoMs) / 1000);
const DAY = 24 * 3600 * 1000;

const rec = (s, agoMs = 1000) => ({ s, t: null, d: null, r: null, o: null, a: secs(agoMs), p: "", k: 0, w: "" });
const getFrom = (byKey) => (target) => byKey[String(target).replace(/\[1m\]$/i, "")] ?? null;
const M = (id) => ({ id });
const zero = () => Object.fromEntries(STATUSES.map((s) => [s, 0]));

// ------------------------------------------------------------- countStatuses

test("countStatuses counts each raw status once, with no grouping", () => {
  const models = STATUSES.map((s, i) => M(`m${i}`));
  const byKey = Object.fromEntries(STATUSES.map((s, i) => [`p/m${i}`, rec(s)]));
  const out = countStatuses("p", models, getFrom(byKey), NOW);
  assert.deepEqual(Object.keys(out), [...STATUSES], "one counter per status, in STATUSES order");
  for (const s of STATUSES) assert.equal(out[s], 1, s);
});

test("records of ANY age count: there is no age window", () => {
  const byKey = {
    "p/fresh": rec("ok", DAY),
    "p/edge": rec("ok", BENCH_FRESH_MS),
    "p/old": rec("ok", BENCH_FRESH_MS + 2000),
  };
  const out = countStatuses("p", [M("fresh"), M("edge"), M("old")], getFrom(byKey), NOW);
  assert.deepEqual(out, { ...zero(), ok: 3 }, "the 14-day edge, and 14 days and 2 s, both count");
  const older = { "p/a": rec("ok", 100 * DAY), "p/b": rec("gone", 400 * DAY) };
  assert.deepEqual(countStatuses("p", [M("a"), M("b")], getFrom(older), NOW), { ...zero(), ok: 1, gone: 1 }, "100- and 400-day-old records count");
  const future = { "p/f": rec("ok", -3 * DAY) };
  assert.deepEqual(countStatuses("p", [M("f")], getFrom(future), NOW), zero(), "a record dated in the future is still refused");
});

test("a model with no record is in NO column, so the columns can sum to less than the models", () => {
  const byKey = { "p/a": rec("ok"), "p/old": rec("gone", 30 * DAY) };
  const models = [M("a"), M("old"), M("never")];
  const out = countStatuses("p", models, getFrom(byKey), NOW);
  const sum = Object.values(out).reduce((n, v) => n + v, 0);
  assert.equal(sum, 2, "the 30-day-old record counts; only the never-benched model is in no column");
  assert.ok(sum < models.length);
});

test("x and x[1m] are two selectable routes and count twice", () => {
  const byKey = { "p/x": rec("ok") };
  assert.equal(benchKey("p", "x[1m]"), benchKey("p", "x"));
  assert.deepEqual(countStatuses("p", [M("x"), M("x[1m]")], getFrom(byKey), NOW), { ...zero(), ok: 2 },
    "one probe record, two rows the user can select: both are counted, the way the ok-only filter lists both");
});

test("countStatuses is null without a reader, and all zeros when nothing matches", () => {
  assert.equal(countStatuses("p", [M("a")], null, NOW), null);
  assert.equal(countStatuses("p", [M("a")], undefined, NOW), null);
  assert.deepEqual(countStatuses("p", [M("a"), M("b")], () => null, NOW), zero());
  assert.deepEqual(countStatuses("p", [], getFrom({}), NOW), zero());
  assert.deepEqual(countStatuses("p", undefined, getFrom({}), NOW), zero());
});

test("a status outside the closed vocabulary is ignored, never counted or thrown on", () => {
  const byKey = { "p/a": { ...rec("ok"), s: "banana" }, "p/b": { ...rec("ok"), s: "constructor" },
                  "p/c": rec("ok"), "p/d": { s: "ok" } };
  const out = countStatuses("p", [M("a"), M("b"), M("c"), M("d")], getFrom(byKey), NOW);
  assert.deepEqual(out, { ...zero(), ok: 1 }, "an unknown status, and a record with no timestamp, are skipped");
  assert.equal(Object.keys(out).length, STATUSES.length);
});

test("countStatuses over a real bench.json read: cleanRecord drops what is unusable, and an old record still counts", () => {
  const dir = tmp();
  const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: "2026-09-29T00:00:00.000Z", models: {
    "p/a": { s: "ok", a: secs(1000) }, "p/b": { s: "auth", a: secs(1000) },
    "p/c": { s: "nonsense", a: secs(1000) }, "p/d": { s: "gone", a: secs(20 * DAY) } } }));
  const b = loadBench(file);
  assert.deepEqual(countStatuses("p", [M("a"), M("b"), M("c"), M("d"), M("e")], b.get, NOW),
    { ...zero(), ok: 1, auth: 1, gone: 1 }, "the 20-day-old gone counts; the nonsense status and the unbenched model do not");
});

// -------------------------------------------------------------- providerFlags

const skip = (w, agoMs = 1000) => ({ ...rec("skip", agoMs), w });
const flags = (recs, models = Object.keys(recs).map((k) => M(k.split("/")[1]))) =>
  providerFlags("p", models, getFrom(recs), NOW);

test("dead: yes iff nothing responded and every fresh record is a refusal or failure of the dead kind", () => {
  // auth, error, timeout, gone and a legacy provider-dead skip are the dead kind.
  assert.equal(flags({ "p/a": rec("auth"), "p/b": rec("error"), "p/c": rec("timeout"), "p/d": rec("gone") }).dead, true);
  assert.equal(flags({ "p/a": rec("gone") }).dead, true, "one record is enough");
  assert.equal(flags({ "p/a": skip("provider-dead"), "p/b": rec("auth") }).dead, true, "a legacy provider-dead skip still reads as dead");
  assert.equal(flags({ "p/a": skip("provider-dead") }).dead, true);
  // Anything that responded, or anything not of the dead kind, makes it no.
  assert.equal(flags({ "p/a": rec("ok"), "p/b": rec("auth") }).dead, false, "one answer is enough to be alive");
  assert.equal(flags({ "p/a": rec("empty"), "p/b": rec("error") }).dead, false, "empty means it responded");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": rec("auth") }).dead, false, "pay: a needs-$ provider, not a dead one");
  assert.equal(flags({ "p/a": rec("rate"), "p/b": rec("error") }).dead, false, "rate limited is not dead");
  assert.equal(flags({ "p/a": skip("unfunded"), "p/b": rec("gone") }).dead, false);
  assert.equal(flags({ "p/a": skip("spend-cap"), "p/b": rec("gone") }).dead, false, "any other skip");
  assert.equal(flags({ "p/a": skip("row-cost") }).dead, false);
  // Age: there is no cutoff, so an old answer still keeps a provider alive and an old failure still counts.
  assert.equal(flags({ "p/a": rec("ok", 20 * DAY), "p/b": rec("auth") }).dead, false, "the old ok answered");
  assert.equal(flags({ "p/a": rec("auth", 20 * DAY), "p/b": rec("auth") }).dead, true, "the old auth counts");
  assert.equal(flags({ "p/a": rec("auth", -3 * DAY) }), null, "only a future-dated record: no verdict at all");
});

test("needs $: yes only when EVERY fresh record is a payment refusal and none answered", () => {
  assert.equal(flags({ "p/a": rec("pay"), "p/b": rec("pay"), "p/c": rec("pay") }).needsMoney, true, "all pay");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": skip("unfunded"), "p/c": skip("unfunded") }).needsMoney, true,
    "pay and unfunded skips mix");
  assert.equal(flags({ "p/a": skip("unfunded") }).needsMoney, true, "a lone unfunded skip");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": rec("pay"), "p/c": rec("ok") }).needsMoney, false,
    "one ok among many pay flips it to no");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": rec("empty") }).needsMoney, false, "empty means it responded");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": rec("gone") }).needsMoney, false, "pay + gone is not all-unpaid");
  for (const s of ["auth", "rate", "timeout", "error"]) {
    assert.equal(flags({ "p/a": rec("pay"), "p/b": rec(s) }).needsMoney, false, `pay + ${s}`);
  }
  assert.equal(flags({ "p/a": rec("pay"), "p/b": skip("provider-dead") }).needsMoney, false, "a provider-dead skip is not unpaid");
  assert.equal(flags({ "p/a": rec("pay"), "p/b": skip("spend-cap") }).needsMoney, false, "nor is a spend-cap skip");
});

test("dead and needs $ are mutually exclusive by construction, and skips still count in the raw skip column", () => {
  const recs = { "p/a": rec("pay"), "p/b": skip("unfunded"), "p/c": skip("provider-dead") };
  const models = [M("a"), M("b"), M("c")];
  assert.deepEqual(providerFlags("p", models, getFrom(recs), NOW), { dead: false, needsMoney: false },
    "a mix of pay and dead records is neither");
  assert.deepEqual(providerFlags("p", [M("a"), M("b")], getFrom(recs), NOW), { dead: false, needsMoney: true });
  assert.deepEqual(providerFlags("p", [M("c")], getFrom(recs), NOW), { dead: true, needsMoney: false });
  for (const kinds of [["pay", "auth"], ["ok"], ["gone", "pay"], ["auth"], ["pay"]]) {
    const f = flags(Object.fromEntries(kinds.map((k, i) => [`p/m${i}`, rec(k)])));
    assert.equal(f.dead && f.needsMoney, false, kinds.join("+"));
  }
  assert.equal(countStatuses("p", models, getFrom(recs), NOW).skip, 2, "the raw skip column keeps them");
});

test("old records decide like any other; nothing recorded is no verdict", () => {
  assert.deepEqual(flags({ "p/a": rec("pay", 20 * DAY), "p/b": rec("pay"), "p/c": rec("ok", 20 * DAY) }),
    { dead: false, needsMoney: false }, "the 20-day-old ok answered: not needs-money");
  assert.deepEqual(flags({ "p/a": rec("pay", 100 * DAY) }), { dead: false, needsMoney: true }, "a 100-day-old pay still says so");
  assert.equal(flags({ "p/a": rec("pay", -3 * DAY) }), null, "a future-dated record is not evidence");
  assert.equal(flags({}, [M("a"), M("b")]), null, "never benched: null, drawn blank");
  assert.equal(flags({}, []), null);
  assert.equal(providerFlags("p", [M("a")], null, NOW), null, "no reader: null");
  assert.equal(providerFlags("p", undefined, getFrom({}), NOW), null);
});

test("x and x[1m] both count for the verdicts (two routes), and an unknown status is not a record", () => {
  const recs = { "p/x": rec("pay"), "p/y": { ...rec("ok"), s: "banana" } };
  assert.deepEqual(flags(recs, [M("x"), M("x[1m]")]), { dead: false, needsMoney: true });
  assert.deepEqual(flags(recs, [M("x"), M("y")]), { dead: false, needsMoney: true }, "the unknown status is skipped, not an answer");
  const dup = { "p/x": skip("provider-dead") };
  assert.equal(flags(dup, [M("x"), M("x[1m]")]).dead, true);
});

test("providerFlags over a real bench.json read", () => {
  const dir = tmp();
  const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: "2026-09-29T00:00:00.000Z", models: {
    "p/a": { s: "pay", a: secs(1000) }, "p/b": { s: "skip", w: "unfunded", a: secs(1000) },
    "q/a": { s: "skip", w: "provider-dead", a: secs(1000) }, "q/b": { s: "ok", a: secs(1000) } } }));
  const b = loadBench(file);
  assert.deepEqual(providerFlags("p", [M("a"), M("b")], b.get, NOW), { dead: false, needsMoney: true });
  assert.deepEqual(providerFlags("q", [M("a"), M("b")], b.get, NOW), { dead: false, needsMoney: false }, "q/b answered");
  assert.deepEqual(providerFlags("q", [M("a")], b.get, NOW), { dead: true, needsMoney: false }, "a legacy provider-dead skip");
  assert.equal(providerFlags("r", [M("a")], b.get, NOW), null);
});

// ------------------------------------------------------------------ snapshot

const BUILT = {
  generatedAt: "2026-08-24T12:22:28.162Z",
  rows: [
    { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
      models: [{ id: "acme-1", ctx: null }, { id: "acme-1[1m]", ctx: null }, { id: "acme-2", ctx: null }] },
    { keyId: "personal.zed.free", provider: "zed", free: 0, planCount: 0, health: "ok",
      models: [{ id: "z1", ctx: null }] },
  ],
};

test("schema 9: buildSnapshot bakes per-status counts into every row, and stamps benchAsOf", () => {
  assert.equal(SNAPSHOT_SCHEMA, 9);
  const bench = { generatedAt: "2026-09-29T10:39:05.361Z", size: 2,
                  get: getFrom({ "acme/acme-1": rec("ok"), "acme/acme-2": rec("gone") }) };
  const s = buildSnapshot(BUILT, { bench, nowMs: NOW });
  assert.equal(s.schemaVersion, 9);
  assert.equal(s.benchAsOf, "2026-09-29T10:39:05.361Z");
  assert.deepEqual(s.rows[0].bench, { ...zero(), ok: 2, gone: 1 }, "acme-1 and acme-1[1m] are two routes");
  assert.deepEqual(s.rows[1].bench, zero(), "benched providers with no fresh results are zeros, not null");
  assert.deepEqual(s.rows[0].benchFlags, { dead: false, needsMoney: false, alive: true, status: "alive" }, "acme has a fresh ok: alive");
  assert.equal(s.rows[1].benchFlags, null, "nothing fresh to judge from: no verdict, not a `no`");
  const paid = { generatedAt: null, size: 2,
                 get: getFrom({ "zed/z1": { ...rec("skip"), w: "provider-dead" } }) };
  assert.deepEqual(buildSnapshot(BUILT, { bench: paid, nowMs: NOW }).rows[1].benchFlags,
    { dead: true, needsMoney: false, alive: null, status: null }, "a legacy provider-dead skip is not a probe result: no alive verdict, no status");
});

test("schema 9: with no bench data every row carries bench: null and benchAsOf is null, as own properties", () => {
  const s = JSON.parse(JSON.stringify(buildSnapshot(BUILT)));
  assert.equal(Object.hasOwn(s, "benchAsOf"), true);
  assert.equal(s.benchAsOf, null);
  for (const r of s.rows) {
    assert.equal(Object.hasOwn(r, "bench"), true, `${r.keyId} lost bench in serialization`);
    assert.equal(r.bench, null);
    assert.equal(Object.hasOwn(r, "benchFlags"), true, `${r.keyId} lost benchFlags in serialization`);
    assert.equal(r.benchFlags, null);
  }
  const noStamp = buildSnapshot(BUILT, { bench: { generatedAt: null, size: 1, get: () => null }, nowMs: NOW });
  assert.equal(noStamp.benchAsOf, null, "an unstamped bench file stamps null");
});

test("a schema-5 snapshot (and schema-6, 7 and 8 ones) is refused, so a stale file is rebuilt instead of drawing blanks", () => {
  const dir = tmp();
  const f = path.join(dir, "snapshot.json");
  fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: 5 }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.match(r.detail, /9/);
  assert.match(r.detail, /5/);
  writeSnapshotFile(buildSnapshot(BUILT), f);
  assert.equal(loadSnapshot(f).ok, true, "and the current schema loads");
  for (const old of [6, 7, 8]) {
    fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: old }));
    assert.equal(loadSnapshot(f).ok, false, `a schema-${old} file lacks the newer fields (an old file would silently never warn)`);
  }
});

test("firstFrame carries the snapshot's bench stamp under its own name", () => {
  const snap = buildSnapshot(BUILT, { bench: { generatedAt: "2026-09-29T10:39:05.361Z", size: 1, get: () => null },
                                      nowMs: NOW });
  const caps = detectCaps({ TERM: "dumb" }, 80);
  const { meta } = firstFrame({ snap, recents: [], favourites: [], caps, termRows: 30 });
  assert.equal(meta.benchCountsAsOf, "2026-09-29T10:39:05.361Z");
  assert.equal(Object.hasOwn(meta, "benchAsOf"), false, "benchAsOf stays the level-1 view's, from bench.json");
  const old = firstFrame({ snap: { ...snap, benchAsOf: undefined }, recents: [], favourites: [], caps, termRows: 30 });
  assert.equal(old.meta.benchCountsAsOf, null);
});

test("the picker's import graph does not reach the bench engine, the gateway or keysync", () => {
  // menu/snapshot.mjs is in uwpick's startup graph and now imports bench-data.mjs.
  // Walk every STATIC relative import from it: nothing under refresh/ or keysync/,
  // and not catalog.mjs (which the build reaches by dynamic import only).
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
      walk(path.resolve(path.dirname(file), m[1]));
    }
  };
  walk(path.join(root, "menu", "uwpick.mjs"));
  const rel = [...seen].map((f) => path.relative(root, f).replaceAll("\\", "/"));
  assert.ok(rel.includes("menu/bench-data.mjs") && rel.includes("menu/snapshot.mjs"), rel.join(", "));
  for (const f of rel) {
    assert.doesNotMatch(f, /^(refresh|keysync)\//, `${f} is on the picker's startup path`);
    assert.notEqual(f, "menu/catalog.mjs");
  }
});

// -------------------------------------------------------------------- layout
// (the level-0 layout and rendering tests moved to test/level0.test.mjs with the #114 redesign)

test("keyIdWidth: the longest key id over all rows, at least the header, at most KEYID_MAX", () => {
  const rows = (...ids) => ids.map((keyId) => ({ keyId }));
  assert.equal(keyIdWidth(rows("personal.acme.free", "x")), 18);
  assert.equal(keyIdWidth(rows("a", "b")), 6, "never narrower than `key id`");
  assert.equal(keyIdWidth([]), 6);
  assert.equal(keyIdWidth(undefined), 6);
  assert.equal(keyIdWidth(rows("z".repeat(500))), KEYID_MAX, "a hostile id is capped");
  assert.equal(keyIdWidth(rows("p".repeat(45))), 45, "a 45-character id is measured whole");
  assert.equal(keyIdWidth(rows("\x1b[31m" + "ab" + "\x1b[0m")), 6, "escapes are not measured");
});

// The 14-day display cutoff is gone: every reader uses a record whatever its age, and an OUTDATED NOTICE says when the
// list needs a new sweep (MORE THAN HALF of its records are over 7 days old; the date quoted is the oldest record's).
// The age histogram baked on each snapshot row feeds it. Also: the header total follows [no gone].
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BENCH_OUTDATED_DAYS, BENCH_OUTDATED_SHARE, outdatedNotice, outdatedShare, ageHistOf, cleanAgeHist, oldestAgeOf,
         oldestStampOf, loadBench, isUsable, countStatuses } from "../menu/bench-data.mjs";
import { DEFAULTS } from "../refresh/bench-cli.mjs";
import { buildSnapshot, loadSnapshot, writeSnapshotFile, SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";
import { detectCaps, painter, frame, frameWidth } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { providerStatus } from "../menu/route-hints.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 86400_000;
const CMD = "node refresh/bench-cli.mjs --live";
const iso = (ms) => new Date(ms).toISOString();
const sec = (ms) => Math.floor(ms / 1000);
const CTRL_X = "\x18", ENTER = "\r", TAB = "\t";

test("the outdated threshold is the sweep's own default --ttl, read from its source, so the two cannot drift", () => {
  assert.equal(BENCH_OUTDATED_DAYS, 7);
  assert.equal(DEFAULTS.ttlDays, BENCH_OUTDATED_DAYS);
  const src = fs.readFileSync(new URL("../refresh/bench-cli.mjs", import.meta.url), "utf8");
  assert.match(src, new RegExp(`ttlDays: ${BENCH_OUTDATED_DAYS},`));
});

// --------------------------------------------------------------------- no cutoff

const rec = (s, ms) => ({ s, a: sec(ms), p: "", w: "" });
const M = (id, o = {}) => ({ id, ctx: 128000, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true, ...o });
const row = (provider, models) => ({ keyId: `personal.${provider}.free`, provider, free: 0, planCount: 0, health: "ok", models });

test("age no longer excludes: 30- and 100-day-old records render, count, decide the provider status and hide with [no gone]", () => {
  const rows = [row("p", [M("d30"), M("d100"), M("gone100"), M("future")])];
  const recs = { "p/d30": rec("ok", NOW - 30 * DAY), "p/d100": rec("ok", NOW - 100 * DAY), "p/gone100": rec("gone", NOW - 100 * DAY), "p/future": rec("ok", NOW + 3 * DAY) };
  const get = (t) => recs[t] ?? null; get.records = 4;
  assert.equal(isUsable(recs["p/d100"], NOW), true);
  assert.equal(isUsable(recs["p/future"], NOW), false, "a record dated beyond the skew is still refused");
  assert.equal(countStatuses("p", rows[0].models, get, NOW).ok, 2);
  assert.equal(providerStatus("p", rows[0].models, get, NOW), "alive");
  assert.equal(providerStatus("p", [M("gone100")], get, NOW), "down");
  let s = reduce(reduce(initState(rows, { nowMs: NOW }), { benchOf: get }).state, ENTER).state;
  const text = frame(view(s), { providers: 1, models: 4, benchOf: get, benchAsOf: iso(NOW), keyIdW: 20 }, { caps: detectCaps(ASCII, 134) }).map(strip);
  const line = (id) => text.find((l) => l.split(":")[0].trim().endsWith(id) && !l.includes("id:"));
  assert.match(line("d100"), /:ok\s*:/, "the 100-day-old row still draws its status");
  assert.doesNotMatch(line("future"), /:ok\s*:/, "the future-dated one draws blank");
  s = reduce(s, CTRL_X).state;
  const ids = view({ ...s, termRows: 500 }).items.filter((i) => i.kind === "model").map((i) => i.model.id);
  assert.deepEqual(ids, ["d30", "d100", "future"], "[no gone] hides the 100-day-old gone row");
});

// ------------------------------------------------------------------- the oldest record

test("oldestStampOf: the OLDEST usable record among the listed routes, not the newest, and not routes that are not listed", () => {
  const rows = [row("p", [M("a"), M("b"), M("never")]), row("q", [M("c")])];
  const recs = { "p/a": rec("ok", NOW - 2 * DAY), "p/b": rec("gone", NOW - 20 * DAY), "q/c": rec("ok", NOW - DAY), "z/unlisted": rec("ok", NOW - 300 * DAY),
                 "q/future": rec("ok", NOW + 9 * DAY) };
  const get = (t) => recs[t] ?? null; get.records = 5;
  assert.equal(oldestStampOf(rows, get, NOW), iso(sec(NOW - 20 * DAY) * 1000));
  assert.equal(oldestStampOf([row("p", [M("never")])], get, NOW), null, "no route has a record");
  assert.equal(oldestStampOf(rows, null, NOW), null);
  assert.equal(oldestStampOf([row("q", [M("future")])], get, NOW), null, "a future-dated record is not a stamp");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-oldest-"));
  const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: iso(NOW), models: { "p/a": { s: "ok", a: sec(NOW - DAY) }, "p/b": { s: "gone", a: sec(NOW - 9 * DAY) } } }));
  const b = loadBench(file);
  assert.equal(typeof b.get.stamp, "function");
  assert.equal(b.get.stamp("p/a"), sec(NOW - DAY));
  assert.equal(b.get.stamp("p/none"), null);
  assert.equal(oldestStampOf([row("p", [M("a"), M("b")])], b.get, NOW), iso(sec(NOW - 9 * DAY) * 1000));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the snapshot bakes benchOldestAt (schema 9), carries it with the counts, and a schema-8 file is refused", () => {
  assert.equal(SNAPSHOT_SCHEMA, 9);
  const built = { generatedAt: "x", rows: [{ keyId: "personal.p.free", provider: "p", free: 0, planCount: 0, health: "ok", models: [M("a"), M("b")] }] };
  const recs = { "p/a": rec("ok", NOW - DAY), "p/b": rec("ok", NOW - 12 * DAY) };
  const get = (t) => recs[t] ?? null; get.records = 2;
  const snap = buildSnapshot(built, { bench: { generatedAt: iso(NOW), size: 2, get }, nowMs: NOW });
  assert.equal(snap.benchOldestAt, iso(sec(NOW - 12 * DAY) * 1000));
  const H = (ms) => Math.floor(ms / 3600_000);
  assert.deepEqual(snap.rows[0].benchAgeHist, [[H(NOW - 12 * DAY), 1], [H(NOW - DAY), 1]], "the age histogram: [epochHour, count], oldest first");
  assert.equal(buildSnapshot(built, { bench: null, nowMs: NOW }).benchOldestAt, null);
  assert.equal(buildSnapshot(built, { bench: null, nowMs: NOW }).rows[0].benchAgeHist, null, "no bench data: null, not an empty list");
  const empty = buildSnapshot(built, { bench: { generatedAt: iso(NOW), size: 0, get: Object.assign(() => null, { records: 0 }) }, nowMs: NOW });
  assert.deepEqual(empty.rows[0].benchAgeHist, [], "bench data with no record for this provider: an empty list");
  const carried = buildSnapshot(built, { previous: snap, bench: null, nowMs: NOW + 40 * DAY });
  assert.equal(carried.benchOldestAt, snap.benchOldestAt, "carried with the counts, whatever their age");
  assert.deepEqual(carried.rows[0].benchAgeHist, snap.rows[0].benchAgeHist, "and so is the age histogram");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-oldest2-"));
  const f = path.join(dir, "snapshot.json");
  writeSnapshotFile(snap, f);
  assert.equal(loadSnapshot(f).ok, true);
  fs.writeFileSync(f, JSON.stringify({ ...snap, schemaVersion: 8 }));
  assert.equal(loadSnapshot(f).ok, false, "an old file would silently never warn: it is rebuilt");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- the notifier line

const hr = (ms) => Math.floor(ms / 3600_000);
const ROWS0 = [row("p", Array.from({ length: 40 }, (_, i) => M(`m${i}`))), row("q", [M("q0")])];
// `OLDROWS`: every record 8 days old, so the notice shows; `FRESHROWS`: every record a day old, so it does not.
const OLDROWS = ROWS0.map((r) => ({ ...r, benchAgeHist: [[hr(NOW - 8 * DAY), r.models.length]] }));
const FRESHROWS = ROWS0.map((r) => ({ ...r, benchAgeHist: [[hr(NOW - DAY), r.models.length]] }));
const stateWith = (oldestAt, o = {}) => initState(o.rows ?? OLDROWS, { nowMs: NOW, termRows: 30, benchOldestAt: oldestAt, ...o });
const T1 = (d) => `Model Status might be outdated! Last time the list was fully updated was ${d}, run ${CMD} to update your list fully`;
const T2 = (d) => `Status may be outdated (full update ${d}): ${CMD}`;
const T3 = (d) => `Outdated since ${d}: ${CMD}`;
const noticeLine = (lines) => lines.map(strip).find((l) => /outdated|Outdated/.test(l) && l.includes("bench-cli"));
const at = (state, cols, env = ASCII, colours = null) => {
  const caps = { ...detectCaps(env, cols), ...(colours === null ? {} : { colours }) };
  return { caps, lines: frame(view(state), { providers: 2, models: 41, rows: ROWS0, keyIdW: 20 }, { caps }) };
};

test("the notice needs MORE THAN HALF of the records over 7 days old: exactly half does not trigger, one more does; a 7-day-old record is not old", () => {
  assert.equal(BENCH_OUTDATED_SHARE, 0.5);
  const oldest = iso(NOW - 40 * DAY);
  const H = (days, n) => [hr(NOW - days * DAY), n];
  assert.equal(outdatedNotice(oldest, [[H(9, 50), H(1, 50)]], NOW), null, "50 of 100 old: exactly half is not more than half");
  assert.equal(outdatedNotice(oldest, [[H(9, 51), H(1, 49)]], NOW), "2026-08-27", "51 of 100 old");
  assert.equal(outdatedNotice(oldest, [[H(9, 1)], [H(9, 1), H(1, 1)]], NOW), "2026-08-27", "spread over providers: 2 of 3 old");
  assert.equal(outdatedNotice(oldest, [[H(9, 1), H(1, 2)]], NOW), null, "1 of 3");
  assert.equal(outdatedNotice(oldest, [[H(9, 0)]], NOW), null, "an empty bucket is no record");
  assert.equal(outdatedNotice(oldest, [], NOW), null, "no records");
  assert.equal(outdatedNotice(oldest, null, NOW), null);
  // the boundary is 7 days, judged against the clock, at hour resolution
  assert.equal(outdatedShare([[[hr(NOW - 7 * DAY) - 1, 1]]], NOW).old, 1, "the bucket starting 7 days and an hour ago is older than 7 days");
  assert.equal(outdatedShare([[[hr(NOW), 1]]], NOW).old, 0);
  assert.deepEqual(outdatedShare([[[hr(NOW - 30 * DAY), 3], [hr(NOW - DAY), 2]]], NOW), { total: 5, old: 3 });
  // the date is the OLDEST record's, unchanged; a hostile or future stamp says nothing
  assert.equal(outdatedNotice(iso(NOW - 8 * DAY), [[H(9, 3)]], NOW), "2026-09-28");
  assert.equal(outdatedNotice(iso(NOW - 400 * DAY), [[H(9, 3)]], NOW), "2025-09-01");
  for (const bad of [null, undefined, "", "yesterday", 12345, {}, "\x1b]0;PWN\x07", "2026-99-99", iso(NOW + 3 * DAY), "2026-09-28"]) {
    assert.equal(outdatedNotice(bad, [[H(9, 3)]], NOW), null, JSON.stringify(bad));
  }
  assert.match(outdatedNotice("2026-09-28T00:00:00Z\x1b[2J", [[H(9, 3)]], NOW) ?? "2026-09-28", /^\d{4}-\d\d-\d\d$/, "whatever comes back is a plain date");
  // a hostile histogram counts nothing
  for (const bad of [null, "x", [["a", 1]], [[1.5, 2]], [[-4, 2]], [[hr(NOW - 9 * DAY), -3]], [[hr(NOW - 9 * DAY), "9"]], [[]], [null]]) {
    assert.deepEqual(outdatedShare([bad], NOW), { total: 0, old: 0 }, JSON.stringify(bad));
  }
});

test("the histogram: records floored to the hour, all statuses, oldest first, listed routes only; a file's copy is cleaned", () => {
  const models = [M("a"), M("b"), M("c"), M("d"), M("never"), M("future")];
  const t = NOW - 3 * DAY;
  const recs = { "p/a": rec("ok", t), "p/b": rec("gone", t + 1800_000), "p/c": rec("timeout", t + 3600_000), "p/d": rec("auth", NOW - 40 * DAY),
                 "p/future": rec("ok", NOW + 9 * DAY), "z/other": rec("ok", NOW - 90 * DAY) };
  const get = (x) => recs[x] ?? null; get.records = 6;
  const hist = ageHistOf("p", models, get, NOW);
  assert.deepEqual(hist, [[hr(NOW - 40 * DAY), 1], [hr(t), 2], [hr(t) + 1, 1]], "hour buckets, oldest first; the future record and the unlisted route are out");
  assert.deepEqual(ageHistOf("p", [M("never")], get, NOW), [], "no records: an empty list, not null");
  assert.equal(ageHistOf("p", models, null, NOW), null, "no reader: null");
  assert.deepEqual(cleanAgeHist([[5, 2], ["x", 1], [7.5, 1], [6, 0], null, [3, 1]]), [[3, 1], [5, 2]]);
  assert.equal(cleanAgeHist("nope"), null);
  assert.equal(oldestAgeOf(hist, NOW), Math.floor(NOW / 1000 - hr(NOW - 40 * DAY) * 3600));
  assert.equal(oldestAgeOf([], NOW), null);
  assert.equal(oldestAgeOf(null, NOW), null);
  assert.equal(oldestAgeOf([[hr(NOW) + 5, 1]], NOW), 0, "never negative");
});

test("the notice is absent with fresh records and with no bench data, present with mostly old ones, and quotes the OLDEST record", () => {
  assert.equal(view(stateWith(iso(NOW - 6 * DAY), { rows: FRESHROWS })).notice, null);
  assert.equal(view(stateWith(null, { rows: FRESHROWS })).notice, null);
  assert.equal(view(stateWith(null)).notice, null, "no stamp at all: nothing to quote");
  assert.equal(view(stateWith(iso(NOW - 8 * DAY))).notice, "2026-09-28");
  assert.equal(view(stateWith(iso(NOW - 8 * DAY), { rows: ROWS0 })).notice, null, "rows with no histogram (no bench data) say nothing");
  assert.equal(noticeLine(at(stateWith(iso(NOW - 6 * DAY), { rows: FRESHROWS }), 134).lines), undefined);
  assert.equal(noticeLine(at(stateWith(null), 134).lines), undefined);
  assert.ok(noticeLine(at(stateWith(iso(NOW - 8 * DAY)), 134).lines).includes("2026-09-28"));
  // one old oldest record among mostly fresh ones does not trigger (the oldest record alone no longer decides)
  const mixed = ROWS0.map((r) => ({ ...r, benchAgeHist: [[hr(NOW - 30 * DAY), 1], [hr(NOW - DAY), r.models.length - 1]] }));
  assert.equal(view(stateWith(iso(NOW - 30 * DAY), { rows: mixed })).notice, null);
  // hostile stamps draw nothing
  for (const bad of ["\x1b]0;PWN\x07", "not a date", 5, {}]) assert.equal(view(stateWith(bad)).notice, null);
});

test("the notice text, its yellow colour, and the command intact at 78/80/100/134/240 columns in both glyph sets", () => {
  const d = "2026-09-28", st = stateWith(iso(NOW - 8 * DAY));
  const want = { 78: T3, 80: T3, 100: T2, 134: T2, 240: T1 };
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 134, 240]) {
    const { caps, lines } = at(st, cols, env);
    const line = noticeLine(lines);
    assert.ok(line, `notice at ${cols}`);
    assert.equal(line.replace(/^[│|]\s*/, "").replace(/\s*[│|]$/, ""), want[cols](d), `text at ${cols}`);
    assert.ok(line.includes(CMD), "the command is whole");
    assert.equal(cps(line), frameWidth(caps));
    assert.ok(line.endsWith(" │") || line.endsWith(" |"), "right-aligned: one column of margin before the frame edge");
    const raw = lines.find((l) => strip(l).includes(CMD));
    const p = painter(caps);
    if (caps.colours) assert.ok(raw.includes(p.yel(want[cols](d))), "yellow (the existing warn colour)");
  }
  const bare = at(st, 134, ASCII, 0).lines.join("\n");
  assert.equal(/\x1b/.test(bare), false, "no colour codes when colour is off; the words still show");
  assert.ok(strip(bare).includes(CMD));
});

test("the notice line sits just above the footer, after the id: line, and adds exactly one line to the page-size arithmetic", () => {
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 134]) for (const termRows of [10, 14, 24, 40]) {
    const on = stateWith(iso(NOW - 8 * DAY), { termRows }), off = stateWith(iso(NOW - 6 * DAY), { termRows, rows: FRESHROWS });
    const ln = at(on, cols, env).lines;
    const text = ln.map(strip);
    const ni = text.findIndex((l) => l.includes("bench-cli")), fi = text.length - 1;
    assert.equal(ni, fi - 1, "the last content line, right above the footer");
    assert.ok(text.findIndex((l) => l.includes("id: ")) < ni, "after the id: line");
    assert.equal(view(off).legendAvail - view(on).legendAvail, 1, `page size at ${termRows} rows`);
    assert.ok(ln.length <= Math.max(termRows, 10), `${ln.length} lines in ${termRows} rows at ${cols}`);
  }
  // model level and flat scope too
  for (const which of ["l1", "flat"]) {
    let s = stateWith(iso(NOW - 8 * DAY), { termRows: 14 });
    s = which === "l1" ? reduce(s, ENTER).state : reduce(s, TAB).state;
    const lines = frame(view(s), { providers: 2, models: 41, rows: ROWS0, keyIdW: 20, flatIdW: 30 }, { caps: detectCaps(ASCII, 100) });
    assert.ok(lines.length <= 14, `${which}: ${lines.length}`);
    assert.ok(strip(lines.at(-2)).includes("bench-cli"), `${which}: just above the footer`);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(detectCaps(ASCII, 100)));
    assert.equal(view(s).notice, "2026-09-28");
  }
});

test("bench.json wins over the snapshot once loaded: the reader event replaces the stamp and the histograms", () => {
  let s = stateWith(iso(NOW - 30 * DAY));
  assert.equal(view(s).notice, "2026-09-06");
  const get = () => null; get.records = 1;
  const fresh = new Map(OLDROWS.map((r) => [r.keyId, [[hr(NOW - DAY), r.models.length]]]));
  s = reduce(s, { benchOf: get, benchOldestAt: iso(NOW - DAY), benchHist: fresh }).state;
  assert.equal(view(s).notice, null, "the loaded file says every record is a day old");
  s = reduce(stateWith(iso(NOW - 30 * DAY), { rows: FRESHROWS }), { benchOf: get, benchOldestAt: iso(NOW - 30 * DAY),
    benchHist: new Map(OLDROWS.map((r) => [r.keyId, r.benchAgeHist])) }).state;
  assert.equal(view(s).notice, "2026-09-06", "and the other way round: the snapshot said fresh, the file says old");
  s = reduce(s, { benchOf: get, benchOldestAt: null, benchHist: new Map() }).state;
  assert.equal(view(s).notice, null, "a file with no records for any listed route: no data, no notice");
  s = reduce(stateWith(iso(NOW - 30 * DAY)), { benchOf: get }).state;
  assert.equal(view(s).notice, "2026-09-06", "an event without the fields leaves the snapshot's");
  assert.equal(view(reduce(stateWith(iso(NOW - 30 * DAY)), { benchOf: get, benchHist: "junk" }).state).notice, "2026-09-06", "a hostile histogram falls back to the snapshot's");
});

// --------------------------------------------------------- the header total follows [no gone]

test("the header total: OFF = all models, ON = all models minus gone, the % over that same total; the provider count and N of M's M do not move", () => {
  const rows = [row("big", [M("x")])];
  const meta = { providers: 57, models: 6000, rows, keyIdW: 20, okTotal: 1780, goneTotal: 1146 };
  const head = (state, cols = 134, env = ASCII) => frame(view(state), meta, { caps: detectCaps(env, cols) }).map(strip).find((l) => l.includes("filter:"));
  const s0 = initState(rows, { nowMs: NOW });
  assert.ok(head(s0).includes("57 providers | 6,000 models | 1,780 ok (30%)"), head(s0));
  const on = reduce(s0, CTRL_X).state;
  assert.ok(head(on).includes("57 providers | 4,854 models | 1,780 ok (37%)"), head(on));          // 6000 - 1146 = 4854; 1780 / 4854 = 36.7%
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 134]) {
    const h = head(on, cols, env);
    assert.equal(cps(h), frameWidth(detectCaps(env, cols)));
    assert.ok(h.includes("4,854") && h.includes("[no gone]") && h.includes("(37%)"), h);
  }
  // the band follows the DISPLAYED percent: 37% is yellow
  const p = painter(detectCaps(UNI, 134));
  const raw = frame(view(on), meta, { caps: detectCaps(UNI, 134) }).find((l) => strip(l).includes("filter:"));
  assert.ok(raw.includes("1,780 ok (37%)"));
  // model level: M stays the provider's full count, so hidden gone rows show as N < M
  const models = Array.from({ length: 10 }, (_, i) => M(`m${i}`));
  const recs = {}; for (let i = 0; i < 3; i++) recs[`acme/m${i}`] = rec("gone", NOW - DAY);
  for (let i = 3; i < 7; i++) recs[`acme/m${i}`] = rec("ok", NOW - DAY);
  const bo = (t) => recs[t] ?? null; bo.records = 7;
  let s = reduce(reduce(initState([row("acme", models)], { nowMs: NOW }), { benchOf: bo }).state, ENTER).state;
  s = reduce(s, CTRL_X).state;
  const h1 = frame(view(s), { providers: 1, models: 10, benchOf: bo, keyIdW: 20 }, { caps: detectCaps(ASCII, 134) }).map(strip).find((l) => l.includes("filter:"));
  assert.ok(h1.includes("7 of 10 | 4 ok (57%)"), h1);
  void p;
});

test("with a full list the notice never pushes a frame past the terminal: level 0 (with pins), level 1 and flat, 10 to 50 rows", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...row(`p${i}`, Array.from({ length: 30 }, (_, j) => M(`m${j}`))), benchAgeHist: [[hr(NOW - 9 * DAY), 30]] }));
  const pins = { favourites: ["p1/m1"], recents: ["p2/m2", "p3/m3"] };
  for (const termRows of [10, 12, 14, 20, 24, 30, 40, 50]) for (const cols of [78, 100, 134]) {
    const caps = detectCaps(ASCII, cols);
    const base = (o = {}) => initState(many, { nowMs: NOW, termRows, benchOldestAt: iso(NOW - 9 * DAY), ...o });
    const meta = { providers: 60, models: 1800, rows: many, keyIdW: 20, flatIdW: 30 };
    for (const [name, st] of [["level 0", base()], ["level 0 + pins", base(pins)], ["level 1", reduce(base(), ENTER).state], ["flat", reduce(base(), TAB).state]]) {
      const lines = frame(view(st), meta, { caps });
      assert.ok(lines.length <= termRows, `${name} at ${termRows} rows drew ${lines.length}`);
      assert.ok(strip(lines.at(-2)).includes("bench-cli"), `${name}: the notice is the last content line`);
      assert.equal(view(st).items.length <= view(st).legendAvail, true);
    }
  }
});

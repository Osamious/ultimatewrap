// The provider list's `oldest probe` column: the age of the provider's OLDEST probe record (worst case), right-aligned in 12,
// coloured green / yellow / orange / red as it nears the outdated threshold, placed right after `status`, optional (after
// the whole key id, before `free`), and computed against the picker's own clock from the age histogram baked on each row.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BENCH_OUTDATED_DAYS, PROBE_AGE_BANDS_S, probeAgeTone } from "../menu/bench-data.mjs";
import { detectCaps, painter, glyphsFor, frame, frameWidth, layoutFor, ageLabel, probeCell, keyIdWidth, FRAME_MIN } from "../menu/style.mjs";
import { legendLines } from "../menu/legend.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const sepOf = (env) => (env === UNI ? "┆" : ":");
const NOW = Date.parse("2026-10-06T12:00:00Z");
const MIN = 60, HOUR = 3600, DAY = 86400;
const hr = (ms) => Math.floor(ms / 3600_000);

test("age text: minutes under an hour, hours under a day, days from a day, every unit rounded down", () => {
  const cases = [[0, "<1m"], [59, "<1m"], [60, "1m"], [45 * MIN, "45m"], [59 * MIN, "59m"], [59 * MIN + 59, "59m"], [60 * MIN, "1h"],
    [5 * HOUR, "5h"], [23 * HOUR, "23h"], [23 * HOUR + 59 * MIN, "23h"], [24 * HOUR, "1d"], [47 * HOUR, "1d"], [3 * DAY, "3d"],
    [6 * DAY + 23 * HOUR, "6d"], [7 * DAY, "7d"], [12 * DAY, "12d"], [40 * DAY, "40d"], [100 * DAY, "100d"], [3650 * DAY, "3650d"]];
  for (const [s, want] of cases) assert.equal(ageLabel(s), want, `${s}s`);
  for (const bad of [-1, NaN, Infinity, null, undefined, "3"]) assert.equal(ageLabel(bad), "-", String(bad));
  for (const [s] of cases) assert.ok(ageLabel(s).length <= 12);
});

test("the colour bands come from BENCH_OUTDATED_DAYS: green under 2d, yellow under 4d, orange under 7d, red 7d and older", () => {
  assert.equal(BENCH_OUTDATED_DAYS, 7);
  assert.deepEqual({ ...PROBE_AGE_BANDS_S }, { yellow: 2 * DAY, orange: 4 * DAY, red: 7 * DAY });
  const edges = [[0, "grn"], [2 * DAY - 1, "grn"], [2 * DAY, "yel"], [4 * DAY - 1, "yel"], [4 * DAY, "ora"], [7 * DAY - 1, "ora"], [7 * DAY, "red"],
                 [100 * DAY, "red"]];
  for (const [s, want] of edges) assert.equal(probeAgeTone(s), want, `${s}s`);
  // and the source does not repeat the numbers: the bands are fractions of the threshold
  const src = fs.readFileSync(new URL("../menu/bench-data.mjs", import.meta.url), "utf8");
  assert.match(src, /BENCH_OUTDATED_DAYS \* 2 \/ 7/);
  assert.match(src, /BENCH_OUTDATED_DAYS \* 4 \/ 7/);
});

test("the cell: 12 wide, right-aligned; each band in its colour; `-` when the provider has no records, blank with no bench data; text only when colour is off", () => {
  const p256 = painter({ ...detectCaps(UNI, 134), colours: 256 }), p16 = painter({ ...detectCaps(UNI, 134), colours: 16 }), p0 = painter({ ...detectCaps(ASCII, 134), colours: 0 });
  const cell = (s, p) => probeCell(s, p, "|");
  assert.equal(strip(cell(45 * MIN, p256)), "|         45m");
  assert.equal(strip(cell(12 * DAY, p256)), "|         12d");
  assert.equal(cps(strip(cell(100 * DAY, p256))), 13, "the rule plus 12");
  assert.equal(strip(cell(null, p256)), "|           -", "no records: a dash");
  assert.equal(cell(null, p256), "|" + p256.dim("           -"));
  assert.equal(cell(undefined, p256), "|" + " ".repeat(12), "no bench data: blank");
  assert.equal(cell(NaN, p256), "|" + p256.dim("           -"));
  // 256-colour: green, yellow, orange (208), red
  const w = (t) => t.padStart(12);
  assert.equal(cell(DAY, p256), "|" + p256.grn(w("1d")));
  assert.equal(cell(2 * DAY, p256), "|" + p256.yel(w("2d")));
  assert.equal(cell(4 * DAY, p256), "|" + `[38;5;208m${w("4d")}[0m`);
  assert.equal(cell(7 * DAY, p256), "|" + p256.red(w("7d")));
  // 16-colour: orange is bright red (91), distinct from the yellow (33) and red (31) beside it
  assert.equal(cell(5 * DAY, p16), "|" + `[91m${w("5d")}[0m`);
  assert.equal(new Set([cell(DAY, p16), cell(3 * DAY, p16), cell(5 * DAY, p16), cell(8 * DAY, p16)].map((c) => c.replace(/\d[dhm]/, ""))).size, 4, "four distinct colours");
  // colour off: text only
  for (const s of [45 * MIN, DAY, 3 * DAY, 5 * DAY, 9 * DAY, null]) assert.equal(/\x1b/.test(cell(s, p0)), false);
});

// ------------------------------------------------------------ the column in the frame

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "", tools: false, vision: false, reason: false, routable: null }));
const Z = { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };
const prow = (keyId, hist) => ({ keyId, provider: keyId.split(".")[1], free: 1, planCount: 0, health: "ok", models: mk(3), bench: Z,
  benchFlags: { status: "alive" }, benchAgeHist: hist });
const ROWS = [
  prow("personal.fresh.free", [[hr(NOW - 5 * HOUR * 1000), 3]]),   // 5h (a record is filed under the start of its hour)
  prow("personal.mixed.free", [[hr(NOW - 30 * DAY * 1000), 1], [hr(NOW - HOUR * 1000), 2]]),        // oldest is 30d, newest 1h
  prow("personal.week.free", [[hr(NOW - 7 * DAY * 1000), 3]]),                                      // 7d
  prow("personal.norecs.free", []),                                                                  // no records
  prow("personal.nobench.free", null),                                                               // no bench data
];
const META = { providers: 5, models: 15, rows: ROWS, keyIdW: keyIdWidth(ROWS), okTotal: 5 };
const shot = (st, env, cols) => frame(view(st), META, { caps: detectCaps(env, cols) });
const cellsOf = (lines, id, env) => lines.map(strip).find((l) => l.includes(id)).split(sepOf(env)).map((c) => c.trim());

test("the column reads the OLDEST record, not the newest: 30d, not 1h, for a provider with both", () => {
  for (const env of [UNI, ASCII]) {
    const lines = shot(initState(ROWS, { nowMs: NOW }), env, 240);
    assert.equal(cellsOf(lines, "personal.mixed.free", env)[2], "30d");
    assert.equal(cellsOf(lines, "personal.fresh.free", env)[2], "5h");
    assert.equal(cellsOf(lines, "personal.week.free", env)[2], "7d");
    assert.equal(cellsOf(lines, "personal.norecs.free", env)[2], "-", "no records: a dash");
    assert.equal(cellsOf(lines, "personal.nobench.free", env)[2], "", "no bench data: blank");
    // key id | status | oldest probe | models: the column is right after status
    assert.deepEqual(cellsOf(lines, "key id", env).slice(1, 4), ["status", "oldest probe", "models"]);
  }
});

test("the colours in the frame: the mixed provider is red, the 5-hour one green, the 7-day one red (the outdated edge)", () => {
  const caps = detectCaps(UNI, 240), p = painter(caps);
  const raw = (id) => shot({ ...initState(ROWS, { nowMs: NOW }), cur: [4, 0, 0] }, UNI, 240).find((l) => strip(l).includes(id));
  assert.ok(raw("personal.mixed.free").includes(p.red("30d".padStart(12))));
  assert.ok(raw("personal.fresh.free").includes(p.grn("5h".padStart(12))));
  assert.ok(raw("personal.week.free").includes(p.red("7d".padStart(12))));
});

test("ages are computed against the picker's own clock: they do not move while it is open, and follow the clock it started with", () => {
  const a = shot(initState(ROWS, { nowMs: NOW }), ASCII, 240), b = shot(initState(ROWS, { nowMs: NOW }), ASCII, 240);
  assert.deepEqual(a, b);
  const later = shot(initState(ROWS, { nowMs: NOW + 2 * DAY * 1000 }), ASCII, 240);
  assert.equal(cellsOf(later, "personal.week.free", ASCII)[2], "9d");
  assert.equal(cellsOf(later, "personal.fresh.free", ASCII)[2], "2d");
  const v = view(initState(ROWS, { nowMs: NOW }));
  assert.equal(v.probeAges.get("personal.mixed.free"), Math.floor(NOW / 1000 - hr(NOW - 30 * DAY * 1000) * 3600));
  assert.equal(v.probeAges.get("personal.norecs.free"), null);
  assert.equal(v.probeAges.has("personal.nobench.free"), false);
});

test("bench.json wins once loaded: the reader event's histograms replace the snapshot's", () => {
  let s = initState(ROWS, { nowMs: NOW });
  const get = () => null; get.records = 1;
  s = reduce(s, { benchOf: get, benchHist: new Map([["personal.fresh.free", [[hr(NOW - 3 * DAY * 1000), 1]]]]) }).state;
  const lines = shot(s, ASCII, 240);
  assert.equal(cellsOf(lines, "personal.fresh.free", ASCII)[2], "3d");
  assert.equal(cellsOf(lines, "personal.mixed.free", ASCII)[2], "-", "loaded file has no record for it: a dash, not the snapshot's 30d");
});

// -------------------------------------------------- layout: thresholds, widths, header == rows

test("layout: the column needs the whole key id first, and free needs the column: 107 / 117 columns for a 30-character id", () => {
  const first = (keyW, pred) => { for (let w = FRAME_MIN; w <= 260; w++) if (pred(layoutFor(w, { keyW }))) return w + 2; return null; };
  assert.equal(first(30, (L) => L.W.keyId === 30), 94, "key id whole from 94");
  assert.equal(first(30, (L) => L.showProbe), 107, "oldest probe from 107");
  assert.equal(first(30, (L) => L.showFree), 117, "free from 117");
  assert.equal(first(30, (L) => L.showTotal && L.showTps && L.showPreview), 103, "the model level is untouched: all its columns from 103");
  for (let w = FRAME_MIN; w <= 260; w++) {
    const L = layoutFor(w, { keyW: 30 });
    assert.ok(!L.showFree || L.showProbe, "free never shows without oldest probe");
    assert.ok(!L.showProbe || L.W.keyId === 30, "oldest probe never shows while the id is elided");
  }
  // the real snapshot's floor (an 80-column terminal): the id is elided and the column is off
  assert.equal(layoutFor(78, { keyW: 30 }).showProbe, false);
  assert.equal(layoutFor(78, { keyW: 30 }).W.keyId, 16);
});

test("header and rows have the same widths at 78/80/100/106/107/116/117/134/240, in both glyph sets; the header is `oldest probe`, never `probed`", () => {
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 106, 107, 116, 117, 134, 240]) {
    const caps = detectCaps(env, cols), S = sepOf(env);
    const L = layoutFor(frameWidth(caps), { keyW: META.keyIdW });
    const lines = shot(initState(ROWS, { nowMs: NOW }), env, cols);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const text = lines.map(strip);
    const head = text.find((l) => l.includes("key id"));
    assert.equal(head.includes("oldest probe"), L.showProbe, `header at ${cols}`);
    assert.equal(/probed/.test(text.join("\n")), false, "no `probed` header anywhere");
    const at = (l) => [...l].map((c, i) => (c === S ? i : -1)).filter((i) => i >= 0);
    // the rows follow the header in order (a narrow terminal elides the ids, so they are found by position)
    const hi = text.indexOf(head);
    ROWS.forEach((r, i) => assert.deepEqual(at(text[hi + 1 + i]), at(head), `${r.keyId} at ${cols}`));
    // the header text is 12 wide and lowercase, like the rest of the picker's headers
    if (L.showProbe) assert.ok(head.includes(`${S}oldest probe${S}models`) || head.includes(`${S}oldest probe${S} models`));
  }
});

test("hostile histograms draw blank or a dash and never break the frame", () => {
  const evil = [prow("p.a.free", "\x1b[2J"), prow("p.b.free", [["\x1b[31m", 3]]), prow("p.c.free", [[Infinity, 1], [NaN, 2]]), prow("p.d.free", { 0: [1, 1] }),
                prow("p.e.free", [[hr(NOW + 900 * DAY * 1000), 5]])];
  for (const env of [UNI, ASCII]) for (const cols of [80, 134, 240]) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(initState(evil, { nowMs: NOW })), { ...META, rows: evil, keyIdW: keyIdWidth(evil) }, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(strip(lines.join("\n"))), false);
  }
});

test("the legend defines the column exactly, says it is the oldest and not the latest, and draws the bands in their colours", () => {
  const p = painter({ ...detectCaps(UNI, 100), colours: 256 });
  const text = legendLines(glyphsFor(detectCaps(UNI, 100)), p, { provenanceDot: () => "#",
    age: (tone, t) => (tone === "ora" ? `\x1b[38;5;208m${t}\x1b[0m` : p[tone](t)) }).join("\n");
  const flat = strip(text).replace(/\s+/g, " ");
  assert.ok(flat.includes("age of the provider's oldest probe result; green under 2d, yellow under 4d, orange under 7d, red 7d or older"));
  assert.match(flat, /OLDEST probe, not the latest/);
  assert.ok(text.includes(p.grn("45m 5h")) && text.includes(p.yel("2d 3d")) && text.includes("\x1b[38;5;208m4d 6d") && text.includes(p.red("7d 12d 40d")));
  // the stated numbers are the bands', not a second copy
  assert.equal(PROBE_AGE_BANDS_S.yellow / DAY, 2);
  assert.equal(PROBE_AGE_BANDS_S.orange / DAY, 4);
  assert.equal(PROBE_AGE_BANDS_S.red / DAY, BENCH_OUTDATED_DAYS);
});

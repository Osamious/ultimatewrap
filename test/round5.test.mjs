// Round 5: the provider `models` cell never overflows, ok% leaves `gone` routes out of its denominator, the key id is
// drawn in full (no bucket), the ASCII elision marker is not a hyphen, and the hide-gone toggle (ctrl+x).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as Style from "../menu/style.mjs";
import { detectCaps, painter, glyphsFor, frame, frameWidth, layoutFor, countCell, pctLabel, pctTone, modalityHue, padId,
         KEYID_MAX, HELP1 } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { MODALITY_WORDS } from "../menu/modality.mjs";
import { isGone } from "../menu/bench-data.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const sepOf = (env) => (env === UNI ? "┆" : ":");
const CT = [40, 80, 100, 134, 240, 400];
const NOW = 1_800_000_000_000;
const nowS = Math.floor(NOW / 1000);
const Z = { ok: 0, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };

// ------------------------------------------------------------ A1: the models cell

test("the provider `models` cell is at most 7 wide for any N / M, so no column ever shifts (40..400 columns, both glyph sets)", () => {
  const pairs = [[469, 100], [9, 0], [1, 1], [1501, 1501], [12345, 12345], [99999, 99999], [100000, 100000], [5, 99999], [99999, 5], [3000, 7]];
  for (const [n, m] of pairs) assert.ok(countCell(n, m, 7).length <= 7, `${n}/${m} -> ${countCell(n, m, 7)}`);
  assert.equal(countCell(469, 100, 7), "469/100", "the worst real pair is exact");
  const rows = pairs.map(([n, m], i) => ({ keyId: `personal.f${i}.free`, provider: `f${i}`, free: 1, planCount: 0, health: "ok",
    models: new Array(n).fill({ id: "x" }), refused: new Array(m).fill({ id: "y" }), bench: { ...Z, ok: 1 }, benchFlags: { status: "alive" } }));
  for (const env of [UNI, ASCII]) for (const cols of CT) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(initState(rows, { termRows: 40 })), { providers: rows.length, models: 1, rows, keyIdW: 24 }, { caps });
    const text = lines.map(strip);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const head = text.find((l) => l.includes("key id"));
    const S = sepOf(env);
    const at = (l) => [...l].map((c, i) => (c === S ? i : -1)).filter((i) => i >= 0);
    const L = layoutFor(frameWidth(caps), { keyW: 24 });
    const tableRows = text.filter((l) => /f\d\.free|f\d.*free/.test(l) && l.includes(S) && !l.includes("id:"));
    for (const row of tableRows) {
      assert.deepEqual(at(row), at(head), `rules line up at ${cols}: ${row}`);
      const modelsCell = row.slice(1 + 2 + L.W.keyId + 7 + 1, 1 + 2 + L.W.keyId + 7 + 8);
      assert.equal(cps(modelsCell), 7);
    }
  }
});

// ------------------------------------------------ B: ok% denominator depends on [no gone] (ctrl+x, off by default)

const prow = (keyId, n, bench, o = {}) => ({ keyId, provider: keyId.split(".")[1], free: null, planCount: 0, health: "ok", bench,
  benchFlags: bench ? { status: bench.ok > 0 ? "alive" : "down" } : null,
  models: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "", tools: false, vision: false, reason: false, routable: null })), ...o });

test("provider-level ok%: OFF = ok / models, ON ([no gone]) = ok / (models - gone); free% always over all models; a zero denominator reads `-`", () => {
  const rows = [
    prow("p.a.free", 12, { ...Z, ok: 5, gone: 4 }, { free: 3 }),      // off 5/12 = 42%, on 5/8 = 63%
    prow("p.b.free", 12, { ...Z, ok: 6 }, { free: 3 }),               // 50% both, free 25%
    prow("p.c.free", 4, { ...Z, ok: 1, gone: 4 }, { free: 0 }),       // off 1/4 = 25%, on: denominator 0 -> `-`
    prow("p.d.free", 4, { ...Z, gone: 4 }),                           // nothing ok: `-` and `-`
    prow("p.e.free", 10, { ...Z, ok: 1, gone: 1 }, { free: 10 }),      // off 1/10 = 10%, on 1/9 = 11%
    prow("p.f.free", 100, { ...Z, ok: 50, gone: 20 }, { free: 10 }),  // off 50%, on 50/80 = 63%
  ];
  const meta = { providers: 6, models: 142, rows, keyIdW: 8, okTotal: 63, goneTotal: 33 };
  const st = initState(rows);
  for (const env of [UNI, ASCII]) {
    const S = sepOf(env);
    const cellsOf = (state) => { const text = frame(view(state), meta, { caps: detectCaps(env, 240) }).map(strip);
      return (id) => text.find((l) => l.includes(id)).split(S).map((c) => c.trim()); };   // 0 key, 1 status, 2 oldest probe, 3 models, 4 ok, 5 %, 6 free, 7 %
    const off = cellsOf(st), on = cellsOf(reduce(st, CTRL_X).state);
    assert.deepEqual(off("p.a.free").slice(4, 8), ["5", "42%", "3", "25%"]);
    assert.deepEqual(on("p.a.free").slice(4, 8), ["5", "63%", "3", "25%"]);
    assert.deepEqual(off("p.b.free").slice(4, 8), ["6", "50%", "3", "25%"]);
    assert.deepEqual(on("p.b.free").slice(4, 8), ["6", "50%", "3", "25%"], "nothing gone: the same");
    assert.deepEqual(off("p.c.free").slice(4, 6), ["1", "25%"]);
    assert.deepEqual(on("p.c.free").slice(4, 6), ["1", "-"], "ON with a zero denominator: `-`, never a division by zero");
    assert.deepEqual(off("p.d.free").slice(4, 6), ["-", "-"]);
    assert.deepEqual(on("p.e.free").slice(4, 8), ["1", "11%", "10", "100%"]);
    assert.deepEqual(off("p.e.free").slice(4, 6), ["1", "10%"]);
    assert.deepEqual([off("p.f.free")[5], on("p.f.free")[5]], ["50%", "63%"], "50 ok of 100 models with 20 gone: 50% off, 50/80 = 63% on");
    assert.deepEqual([off("p.f.free")[7], on("p.f.free")[7]], ["10%", "10%"], "free % is never changed by the toggle");
    // the raw gone column and the ok COUNT never change
    assert.equal(off("p.a.free").at(-3), on("p.a.free").at(-3));
    assert.equal(off("p.a.free")[4], on("p.a.free")[4]);
  }
  // the band follows the DISPLAYED value: 63% (on) is yellow, 42% (off) is yellow; 25% is red (checked on an unselected row)
  const p = painter(detectCaps(UNI, 240));
  const rawOf = (state, id) => frame(view(state), meta, { caps: detectCaps(UNI, 240) }).find((l) => strip(l).includes(id));
  assert.ok(rawOf(st, "p.c.free").includes(p.red(" 25%")));
  assert.ok(rawOf(reduce(st, CTRL_X).state, "p.f.free").includes(p.yel(" 63%")));
});

test("the header percent follows the toggle at every level: OFF over all models, ON over models minus gone (live at the model levels)", () => {
  const rows = [prow("p.a.free", 12, { ...Z, ok: 4, gone: 2 }), prow("p.b.free", 8, { ...Z, ok: 6, gone: 2 })];
  const meta = { providers: 2, models: 20, rows, keyIdW: 8, okTotal: 10, goneTotal: 4 };
  const head = (v, m, cols = 134, env = ASCII) => frame(v, m, { caps: detectCaps(env, cols) }).map(strip).find((l) => l.includes("filter:"));
  // level 0: 10 ok of 20 = 50% off; of (20 - 4) = 16 -> 63% on
  const s0 = initState(rows);
  assert.ok(head(view(s0), meta).includes("2 providers | 20 models | 10 ok (50%)"), head(view(s0), meta));
  const s0on = reduce(s0, CTRL_X).state;
  assert.ok(head(view(s0on), meta).includes("2 providers | 16 models | 10 ok (63%)"), "the header TOTAL leaves gone out too: " + head(view(s0on), meta));
  assert.ok(head(view(s0on), { ...meta, goneTotal: 0 }).includes("10 ok (50%)"), "nothing gone: the same");
  // model levels, live: acme has 10 models, 4 ok, 3 fresh gone (a stale gone does not count)
  const models = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "", tools: false, vision: false, reason: false, routable: null }));
  const row = { keyId: "personal.acme.free", provider: "acme", free: 0, planCount: 0, health: "ok", models };
  const recs = {};
  for (let i = 0; i < 4; i++) recs[`acme/m${i}`] = { s: "ok", a: nowS - 60, p: "", w: "" };
  for (let i = 4; i < 7; i++) recs[`acme/m${i}`] = { s: "gone", a: nowS - 60, p: "", w: "" };
  recs["acme/m7"] = { s: "gone", a: nowS - 40 * 86400, p: "", w: "" };            // an old gone counts too
  const benchOf = (t) => recs[t] ?? null; benchOf.records = 8;
  const st = reduce(initState([row], { nowMs: NOW }), { benchOf }).state;
  const m = { providers: 1, models: 10, benchOf };
  const l1 = reduce(st, "\r").state;
  assert.equal(view(l1).goneLive, 4);
  assert.ok(head(view(l1), m).includes("10 of 10 | 4 ok (40%)"), head(view(l1), m));
  const l1on = reduce(l1, CTRL_X).state;
  assert.ok(head(view(l1on), m).includes("6 of 10 | 4 ok (67%)"), head(view(l1on), m));       // 4 / (10 - 4)
  const flat = reduce(st, "\t").state;
  assert.ok(head(view(flat), m).includes("10 of 10 models | 4 ok (40%)"));
  assert.ok(head(view(reduce(flat, CTRL_X).state), m).includes("6 of 10 models | 4 ok (67%)"));
  // the flag is ONE state across levels: it survives drilling in and out
  assert.equal(view(reduce(reduce(s0, CTRL_X).state, "\r").state).hideGone, true, "drill in: still on");
  assert.equal(view(reduce(reduce(reduce(s0, CTRL_X).state, "\r").state, "\x1b").state).hideGone, true, "and back out: still on");
  // no reader: no gone figure, so the plain total
  assert.equal(view(reduce(initState([row], { nowMs: NOW }), "\r").state).goneLive, null);
  assert.equal(pctLabel(7, 7), "100%");
});

// ----------------------------------------------------- A6: one rounding rule for label and band

test("the percent label and its colour band share one rounding rule and cannot drift", () => {
  for (const total of [1, 2, 3, 7, 8, 9, 10, 99, 100, 101, 202, 469, 1000, 3000]) {
    for (let n = 0; n <= total; n += Math.max(1, Math.floor(total / 40))) {
      const label = pctLabel(n, total);
      const tone = pctTone(n, total);
      if (n === 0) { assert.equal(tone, null); continue; }
      const v = label === "<1%" ? 0 : Number(label.slice(0, -1));
      const want = v >= 70 ? "grn" : v >= 30 ? "yel" : "red";
      assert.equal(tone, want, `${n}/${total} reads ${label}`);
      if (n < total) assert.notEqual(label, "100%", `a partial ${n}/${total} is never 100%`);
    }
  }
  assert.equal(pctLabel(NaN, 5), "-");
  assert.equal(pctLabel(1, 0), "-", "no denominator");
  assert.equal(pctTone(1, 0), null);
});

test("modalityHue never returns a colour for a word that is not in the table", () => {
  const p = painter({ ...detectCaps(UNI, 100), colours: 256 });
  for (const w of MODALITY_WORDS) assert.notEqual(modalityHue(w, p), "2");
  for (const bad of ["?", "", "constructor", "__proto__", "poem", "\x1b[2J", undefined, null, 7]) assert.equal(modalityHue(bad, p), "2", String(bad));
});

// ------------------------------------------------------------- A4: the ASCII elision marker

test("the elision marker is `~` in ASCII (never a plain hyphen) and an em dash in Unicode, and it is one column", () => {
  const u = glyphsFor(detectCaps(UNI, 100)), a = glyphsFor(detectCaps(ASCII, 100));
  assert.equal(u.elide, "—");
  assert.equal(a.elide, "~");
  assert.notEqual(a.elide, "-");
  assert.equal(cps(a.elide), 1);
  const id = "openrouter-x-1-with-a-very-long-suffix";
  const cell = strip(padId(id, 16, "", a, painter({ ...detectCaps(ASCII, 100), colours: 0 })));
  assert.equal(cps(cell), 16);
  assert.ok(cell.includes("~") && !cell.slice(1, -1).includes("-x-") === false || cell.includes("~"), cell);
  assert.equal(cell.includes("~"), true);
});

// ------------------------------------------------------- C: the full key id, no bucket

test("the bucket helpers are gone: nothing omits a segment of the key id or notes it in the title", () => {
  assert.equal(Object.hasOwn(Style, "keyIdBucket"), false);
  assert.equal(Object.hasOwn(Style, "keyIdShown"), false);
  const rows = ["personal.google.free", "personal.openrouter.free", "personal.xai.paid"].map((k) => prow(k, 3, { ...Z, ok: 1 }));
  for (const env of [UNI, ASCII]) {
    const lines = frame(view(initState(rows)), { providers: 3, models: 9, rows, keyIdW: Style.keyIdWidth(rows) }, { caps: detectCaps(env, 134) }).map(strip);
    assert.equal(lines[0].includes("without"), false, lines[0]);
    for (const r of rows) assert.ok(lines.some((l) => l.includes(r.keyId) && l.includes(sepOf(env))), `${r.keyId} whole`);
  }
  assert.equal(KEYID_MAX, 64);
});

// ------------------------------------------------------------ D: the hide-gone toggle (ctrl+x)

const CTRL_X = "\x18", CTRL_O = "\x0f", ENTER = "\r", TAB = "\t";
const mm = (id, o = {}) => ({ id, ctx: 128000, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true, ...o });
const GROW = { keyId: "personal.g.free", provider: "g", free: 0, planCount: 0, health: "ok",
  models: [mm("ok-1"), mm("gone-1"), mm("nothing-1"), mm("gone-stale"), mm("ok-2"), mm("gone-2"), mm("pay-1")] };
const OTHER = { keyId: "personal.h.free", provider: "h", free: 0, planCount: 0, health: "ok", models: [mm("h-gone"), mm("h-ok")] };
const RECS = {
  "g/ok-1": { s: "ok", a: nowS - 60, p: "", w: "" }, "g/gone-1": { s: "gone", a: nowS - 60, p: "", w: "" },
  "g/gone-stale": { s: "gone", a: nowS - 30 * 86400, p: "", w: "" }, "g/ok-2": { s: "ok", a: nowS - 60, p: "", w: "" },
  "g/gone-2": { s: "gone", a: nowS - 60, p: "", w: "" }, "g/pay-1": { s: "pay", a: nowS - 60, p: "", w: "" },
  "h/h-gone": { s: "gone", a: nowS - 60, p: "", w: "" }, "h/h-ok": { s: "ok", a: nowS - 60, p: "", w: "" },
};
const benchOf = (t) => RECS[String(t).replace(/\[1m\]$/i, "")] ?? null; benchOf.records = Object.keys(RECS).length;
const open = () => reduce(reduce(initState([GROW, OTHER], { nowMs: NOW, termRows: 30 }), { benchOf }).state, ENTER).state;
const flat = () => reduce(reduce(initState([GROW, OTHER], { nowMs: NOW, termRows: 30 }), { benchOf }).state, TAB).state;
const ids = (s) => view({ ...s, termRows: 500 }).items.filter((i) => i.kind === "model").map((i) => i.model.id);
const head = (s, cols = 100, env = ASCII) => frame(view(s), { providers: 2, models: 9, benchOf, keyIdW: 20 }, { caps: detectCaps(env, cols) }).map(strip);

test("hide-gone: default SHOWN; ctrl+x hides rows whose record says gone (any age); rows with no record stay; again shows them", () => {
  let s = open();
  assert.equal(view(s).hideGone, false, "default: shown");
  assert.deepEqual(ids(s), ["ok-1", "gone-1", "nothing-1", "gone-stale", "ok-2", "gone-2", "pay-1"]);
  s = reduce(s, CTRL_X).state;
  assert.equal(view(s).hideGone, true);
  assert.deepEqual(ids(s), ["ok-1", "nothing-1", "ok-2", "pay-1"], "every gone row is out, including the 30-day-old one; the row with no record stays");
  s = reduce(s, CTRL_X).state;
  assert.equal(view(s).hideGone, false);
  assert.equal(ids(s).length, 7, "toggled back: everything is shown again");
});

test("hide-gone: the chip, the header count, the footer hint and the empty state", () => {
  for (const env of [UNI, ASCII]) for (const cols of CT) {
    const on = reduce(open(), CTRL_X).state;
    const caps = detectCaps(env, cols);
    const lines = frame(view(on), { providers: 2, models: 9, benchOf, keyIdW: 20 }, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const text = lines.map(strip);
    const h = text.find((l) => l.includes("filter:"));
    assert.ok(h.includes("[no gone]"), h);
    assert.ok(h.includes("4 of 7"), `N of M follows the filtered view: ${h}`);
    assert.ok(text.at(-1).includes("[^x]"), text.at(-1));
    const off = frame(view(open()), { providers: 2, models: 9, benchOf, keyIdW: 20 }, { caps }).map(strip).find((l) => l.includes("filter:"));
    assert.equal(off.includes("[no gone]"), false, "no chip by default");
    assert.ok(off.includes("7 of 7"));
  }
  assert.ok(HELP1.includes("[^x]gone") && HELP1.includes("[^e]free"));
  // combined with [ok]: both chips, the intersection, and an empty result names the toggles
  let s = reduce(reduce(open(), CTRL_X).state, CTRL_O).state;
  assert.deepEqual(ids(s), ["ok-1", "ok-2"]);
  assert.ok(head(s).find((l) => l.includes("filter:")).includes("[ok] [no gone]"));
  const allGone = { keyId: "personal.z.free", provider: "z", free: 0, planCount: 0, health: "ok", models: [mm("only")] };
  const gb = (t) => (t === "z/only" ? { s: "gone", a: nowS - 60, p: "", w: "" } : null); gb.records = 1;
  let e = reduce(reduce(initState([allGone], { nowMs: NOW }), { benchOf: gb }).state, ENTER).state;
  e = reduce(e, CTRL_X).state;
  const lines = frame(view(e), { providers: 1, models: 1, benchOf: gb, keyIdW: 20 }, { caps: detectCaps(ASCII, 100) }).map(strip);
  assert.ok(lines.some((l) => l.includes("filtered by gone routes hidden")), lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("ctrl+x gone")));
});

test("hide-gone: works in flat scope, hides no provider at level 0, and keeps the cursor on a visible row with a valid scroll", () => {
  let f = flat();
  f = reduce(f, CTRL_X).state;
  assert.deepEqual(ids(f), ["ok-1", "nothing-1", "ok-2", "pay-1", "h-ok"], "flat: gone rows of every provider are out");
  // level 0: the key flips the flag (it changes the % figures) but hides no provider row and keeps the cursor
  const l0 = reduce(initState([GROW, OTHER], { nowMs: NOW }), { benchOf }).state;
  const moved = reduce(l0, "\x1b[B").state;
  const after = reduce(moved, CTRL_X).state;
  assert.equal(after.hideGone, true);
  assert.equal(view(after).items.filter((i) => i.kind === "provider").length, 2, "both providers are still listed");
  assert.equal(view(after).cursor, view(moved).cursor, "the cursor did not move");
  assert.equal(reduce(after, CTRL_X).state.hideGone, false);
  // ctrl+o / ctrl+l / ctrl+e stay model-level only: no-ops at level 0
  for (const k of ["\x0f", "\x0c", "\x05"]) assert.equal(reduce(l0, k).state, l0, JSON.stringify(k));
  // cursor and scroll: many rows, the cursor far down, a short terminal
  const many = { keyId: "personal.m.free", provider: "m", free: 0, planCount: 0, health: "ok",
    models: Array.from({ length: 60 }, (_, i) => mm(`r${i}`)) };
  const recs = {};
  for (let i = 0; i < 60; i += 2) recs[`m/r${i}`] = { s: "gone", a: nowS - 60, p: "", w: "" };     // every other row is gone
  const bo = (t) => recs[t] ?? null; bo.records = 30;
  let s = reduce(reduce(initState([many], { nowMs: NOW, termRows: 14 }), { benchOf: bo }).state, ENTER).state;
  for (let i = 0; i < 45; i++) s = reduce(s, "\x1b[B").state;
  assert.ok(view(s).cursor >= 45);
  s = reduce(s, CTRL_X).state;
  const v = view(s);
  assert.equal(v.cursor, 0, "the cursor returns to the top, like the other toggles");
  assert.equal(v.top, 0);
  assert.equal(v.modelCount, 30);
  assert.ok(v.items.length > 0 && v.items.every((it) => it.kind !== "model" || !/^m\/r\d*[02468]$/.test(it.target)), "only visible rows are listed");
  for (let i = 0; i < 100; i++) s = reduce(s, "\x1b[B").state;                       // scroll to the end of the shorter list
  const end = view(s);
  assert.ok(end.cursor <= 29 && end.top >= 0 && end.top + end.items.length <= 30, `cursor ${end.cursor} top ${end.top} shown ${end.items.length}`);
  assert.equal(end.items[end.cursor - end.top]?.kind, "model", "the cursor is on a real, visible row");
});

test("hide-gone: the reducer is pure and the record rule is `usable and gone` (any age)", () => {
  const NOW2 = NOW;
  assert.equal(isGone({ s: "gone", a: nowS - 60 }, NOW2), true);
  assert.equal(isGone({ s: "gone", a: nowS - 20 * 86400 }, NOW2), true, "an old gone record still says gone");
  assert.equal(isGone({ s: "gone", a: nowS + 3 * 86400 }, NOW2), false, "a future-dated one is not evidence");
  assert.equal(isGone({ s: "ok", a: nowS - 60 }, NOW2), false);
  assert.equal(isGone({ s: "gone" }, NOW2), false, "no timestamp");
  assert.equal(isGone(null, NOW2), false);
  // asking for a hidden state before the bench reader is loaded hides nothing, and injecting it later applies it
  let s = reduce(initState([GROW, OTHER], { nowMs: NOW }), ENTER).state;
  s = reduce(s, CTRL_X).state;
  assert.equal(s.hideGone, true);
  assert.equal(ids(s).length, 7, "no reader yet: nothing to hide");
  s = reduce(s, { benchOf }).state;
  assert.equal(ids(s).length, 4, "the reader arrives: the toggle takes effect");
  assert.equal(view(s).cursor, 0);
});

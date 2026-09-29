// The model-level [free] toggle (ctrl+e), the [no gone] chip at the provider level, the chip row at 78/80 columns with every
// chip on, and the STAMPS legend section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps, frame, frameWidth, HELP1, glyphsFor, painter, provenanceDot } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { legendLines } from "../menu/legend.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const NOW = 1_800_000_000_000, nowS = Math.floor(NOW / 1000);
const CTRL_E = "\x05", CTRL_O = "\x0f", CTRL_L = "\x0c", CTRL_X = "\x18", ENTER = "\r", TAB = "\t", DOWN = "\x1b[B";
const mm = (id, badge, o = {}) => ({ id, ctx: 128000, pin: 0, pout: 0, badge, tools: true, vision: false, reason: false, routable: true, ...o });
const ROW = { keyId: "personal.f.free", provider: "f", free: 2, planCount: 0, health: "ok", models: [
  mm("free-a", "FREE"), mm("maybe-b", "FREE?"), mm("paid-c", "PAID"), mm("blanked-d", ""),       // a FREE? that the snapshot blanked (fresh probe said pay)
  mm("plan-e", "PLAN"), mm("free-f", "FREE"), mm("free-g", "FREE", { ctx: 2_000_000 }), mm("nobadge-h", "") ] };
const OTHER = { keyId: "personal.g.free", provider: "g", free: 1, planCount: 0, health: "ok", models: [mm("g-free", "FREE?"), mm("g-paid", "PAID")] };
const RECS = { "f/free-a": { s: "ok", a: nowS - 60, p: "", w: "" }, "f/paid-c": { s: "ok", a: nowS - 60, p: "", w: "" },
  "f/free-f": { s: "gone", a: nowS - 60, p: "", w: "" }, "f/maybe-b": { s: "ok", a: nowS - 60, p: "", w: "" } };
const benchOf = (t) => RECS[t] ?? null; benchOf.records = 4;
const start = () => reduce(initState([ROW, OTHER], { nowMs: NOW, termRows: 30 }), { benchOf }).state;
const open = () => reduce(start(), ENTER).state;
const flat = () => reduce(start(), TAB).state;
const ids = (s) => view({ ...s, termRows: 500 }).items.filter((i) => i.kind === "model").map((i) => i.model.id);

test("free-only: default OFF; ctrl+e keeps rows whose badge AS DRAWN is FREE or FREE?; a blanked FREE? does not match", () => {
  let s = open();
  assert.equal(view(s).freeOnly, false);
  assert.equal(ids(s).length, 8);
  s = reduce(s, CTRL_E).state;
  assert.equal(view(s).freeOnly, true);
  assert.deepEqual(ids(s), ["free-a", "maybe-b", "free-f", "free-g"], "FREE and FREE? only; PAID, PLAN, blank (including the blanked FREE?) are out");
  s = reduce(s, CTRL_E).state;
  assert.equal(ids(s).length, 8, "toggled back");
  assert.equal(HELP1.includes("[^e]free"), true);
});

test("free-only combines with ok-only, 1M+, hide-gone and typed text (all ANDs); flat scope works; level 0 ignores it", () => {
  const s = reduce(open(), CTRL_E).state;
  assert.deepEqual(ids(reduce(s, CTRL_O).state), ["free-a", "maybe-b"], "free AND ok");
  assert.deepEqual(ids(reduce(s, CTRL_L).state), ["free-g"], "free AND 1M+");
  assert.deepEqual(ids(reduce(s, CTRL_X).state), ["free-a", "maybe-b", "free-g"], "free AND no gone (free-f is gone)");
  let t = s; for (const ch of "free") t = reduce(t, ch).state;
  assert.deepEqual(ids(t), ["free-a", "free-f", "free-g"], "typed text too");
  const f = reduce(flat(), CTRL_E).state;
  assert.deepEqual(ids(f), ["free-a", "maybe-b", "free-f", "free-g", "g-free"], "flat: every provider's FREE / FREE? rows");
  const l0 = start();
  assert.equal(reduce(l0, CTRL_E).state, l0, "level 0: the very same state");
});

test("free-only: the cursor returns to the top and the scroll stays valid; an empty result keeps the chips and the way out", () => {
  const many = { keyId: "personal.m.free", provider: "m", free: 0, planCount: 0, health: "ok",
    models: Array.from({ length: 60 }, (_, i) => mm(`r${i}`, i % 3 === 0 ? "FREE" : "PAID")) };
  let s = reduce(initState([many], { nowMs: NOW, termRows: 14 }), ENTER).state;
  for (let i = 0; i < 45; i++) s = reduce(s, DOWN).state;
  s = reduce(s, CTRL_E).state;
  const v = view(s);
  assert.equal(v.cursor, 0); assert.equal(v.top, 0); assert.equal(v.modelCount, 20);
  for (let i = 0; i < 100; i++) s = reduce(s, DOWN).state;
  const end = view(s);
  assert.ok(end.cursor <= 19 && end.items[end.cursor - end.top]?.kind === "model");
  const none = { keyId: "personal.n.free", provider: "n", free: 0, planCount: 0, health: "ok", models: [mm("only-paid", "PAID")] };
  let e = reduce(initState([none], { nowMs: NOW }), ENTER).state;
  e = reduce(e, CTRL_E).state;
  for (const env of [UNI, ASCII]) {
    const lines = frame(view(e), { providers: 1, models: 1, keyIdW: 20 }, { caps: detectCaps(env, 80) }).map(strip);
    assert.ok(lines.find((l) => l.includes("filter:")).includes("[free]"));
    assert.ok(lines.some((l) => l.includes("filtered by FREE / FREE? only")), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes("ctrl+e free")), "the way out is named");
  }
});

test("all four chips at once never exceed the frame and never clip the counts, at 78/80/100/134 columns in both glyph sets", () => {
  const big = Array.from({ length: 6032 }, (_, i) => mm(`m${i}`, "FREE", { ctx: 2_000_000 }));
  const row = { keyId: "personal.big.free", provider: "big", free: 6032, planCount: 0, health: "ok", models: big };
  const bo = () => ({ s: "ok", a: nowS - 60, p: "", w: "" }); bo.records = 6032;
  let s = reduce(initState([row], { nowMs: NOW }), { benchOf: bo }).state;
  s = reduce(s, TAB).state;
  for (const k of [CTRL_O, CTRL_L, CTRL_X, CTRL_E]) s = reduce(s, k).state;
  const v0 = view(s);
  assert.equal(v0.okOnly && v0.oneM && v0.hideGone && v0.freeOnly, true);
  const rowsOfWidth = {};
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 134]) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(s), { providers: 1, models: 6032, benchOf: bo, keyIdW: 20, flatIdW: 30 }, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const h = strip(lines.find((l) => strip(l).includes("filter:")));
    assert.ok(/6,032 of 6,032 models . 6,032 ok \(\d+%\)/.test(h), `the counts are whole at ${cols}: ${h}`);
    assert.ok(h.includes("[ok]") && (h.includes("[1M+]") || h.includes("[1M]")) && (h.includes("[no gone]") || h.includes("[-gone]")) && h.includes("[free]"), `all four chips at ${cols}: ${h}`);
    rowsOfWidth[`${env === UNI ? "u" : "a"}${cols}`] = cps(h.slice(h.indexOf("filter:"), h.search(/6,032 of/)).trimEnd());
  }
  assert.ok(rowsOfWidth.a78 <= 75 && rowsOfWidth.u78 <= 75, JSON.stringify(rowsOfWidth));
});

test("the provider list shows [no gone] while active: the frame keeps its width and height, and no provider row disappears", () => {
  const rows = [ROW, OTHER];
  for (const env of [UNI, ASCII]) for (const cols of [40, 78, 80, 134, 240]) for (const termRows of [10, 14, 24, 40]) {
    const caps = detectCaps(env, cols);
    const off = initState(rows, { nowMs: NOW, termRows });
    const on = reduce(off, CTRL_X).state;
    const meta = { providers: 2, models: 10, rows, keyIdW: 16, okTotal: 3, goneTotal: 1 };
    const a = frame(view(off), meta, { caps }), b = frame(view(on), meta, { caps });
    assert.equal(b.length, a.length, `same height (${cols} cols, ${termRows} rows)`);
    for (const l of b) assert.equal(cps(strip(l)), frameWidth(caps));
    const h = strip(b.find((l) => strip(l).includes("filter:")));
    assert.ok(h.includes("[no gone]") || h.includes("[-gone]"), `chip at ${cols}: ${h}`);
    assert.equal(strip(a.find((l) => strip(l).includes("filter:"))).includes("[no gone]"), false);
    assert.equal(view(on).items.filter((i) => i.kind === "provider").length, view(off).items.filter((i) => i.kind === "provider").length);
    assert.ok(b.length <= Math.max(termRows, 10), `fits ${termRows} rows: ${b.length}`);
  }
  // model-level toggles draw no chip at the provider level even when their flags are set
  let s = reduce(reduce(initState(rows, { nowMs: NOW }), ENTER).state, CTRL_O).state;
  s = reduce(s, "\x1b").state;
  assert.equal(view(s).level, 0);
  const back = frame(view(s), { providers: 2, models: 10, rows, keyIdW: 16 }, { caps: detectCaps(ASCII, 100) }).map(strip).find((l) => l.includes("filter:"));
  assert.equal(back.includes("[ok]"), false, "only [no gone] is a provider-level chip");
});

// ---------------------------------------------------------------- STAMPS

const legendText = (env = UNI) => {
  const caps = { ...detectCaps(env, 100), colours: 0 };
  return legendLines(glyphsFor(caps), painter(caps), { provenanceDot }).join("\n").replace(/\s+/g, " ");
};

test("the legend's STAMPS section explains routable, bench, benched and discovered, with the level that shows each", () => {
  for (const env of [UNI, ASCII]) {
    const t = legendText(env);
    const dash = env === ASCII ? "-" : "—";
    assert.match(t, /STAMPS/);
    assert.match(t, /UTC \(MM-DD HH:MMZ\)/);
    assert.match(t, /routable provider list: when the snapshot last asked the gateway which routes it can serve/);
    assert.match(t, new RegExp(`'routable ${dash}' means never resolved, so nothing is dimmed \\(undimmed = routable OR nobody checked\\)`));
    assert.match(t, /bench provider list: when the probes behind the status, ok, % and empt\.\.err counts were taken/);
    assert.match(t, /benched model list: when the probe records behind the row cells \(stat, ttft, total, tok\/s, reply:\) were written, read live from bench\.json/);
    assert.match(t, new RegExp(`'benched ${dash} run bench-cli --live' means no probe data yet; an old record is still drawn`));
    assert.match(t, /discovered model list: when the providers' own model listings were last fetched/);
    assert.match(t, new RegExp(`'discovered ${dash}' \\(never\\) explains a blank provenance gutter`));
  }
});

test("the stamps the legend describes are the ones each level draws on the id: line, and nothing else", () => {
  const meta = { providers: 2, models: 10, keyIdW: 16, routableAsOf: "2026-09-29T09:18:00Z", benchCountsAsOf: "2026-09-29T14:29:00Z",
    benchAsOf: "2026-09-29T16:51:00Z", discoveredAsOf: "2026-09-29T09:16:00Z", benchOf };
  const idLine = (v) => strip(frame(v, meta, { caps: detectCaps(ASCII, 134) }).find((l) => /id: /.test(strip(l))));
  const l0 = idLine(view(start().level === 0 ? start() : start()));
  assert.ok(l0.includes("routable 09-29 09:18Z") && l0.includes("bench 09-29 14:29Z") && !/benched|discovered/.test(l0), l0);
  const l1 = idLine(view(open()));
  assert.ok(l1.includes("benched 09-29 16:51Z") && l1.includes("discovered 09-29 09:16Z") && !/routable/.test(l1), l1);
});

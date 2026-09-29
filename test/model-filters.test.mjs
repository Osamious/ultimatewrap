// #114, MODEL LEVEL: the two view filters (ctrl+o ok-only, ctrl+l 1M+ context), their chips
// and counts in the header, and the empty state that names them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view, isOneM } from "../menu/pick-state.mjs";
import { detectCaps, frame, frameWidth } from "../menu/style.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const CTRL_O = "\x0f", CTRL_L = "\x0c", CTRL_B = "\x02", DOWN = "\x1b[B", ESC = "\x1b", ENTER = "\r";
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };

const M = (id, ctx = null, o = {}) => ({ id, ctx, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false,
                                          reason: false, provenance: "listing-verified", routable: true, ...o });
const rec = (s, agoMs = 1000, o = {}) => ({ s, t: 500, d: 900, r: 20, o: 10, a: Math.floor((NOW - agoMs) / 1000), p: "hi", k: 0, w: "", ...o });
const BENCH = {
  "acme/big-ok": rec("ok"), "acme/big-empty": rec("empty"), "acme/big-tagged": rec("ok"),
  "acme/small-ok": rec("ok"), "acme/small-pay": rec("pay"), "acme/small-old-ok": rec("ok", 20 * DAY),
  "acme/exact-ok": rec("ok"), "acme/zero-ctx": rec("ok"),
  "zed/z-big": rec("ok"), "zed/z-small": rec("gone"),
};
const benchOf = (t) => BENCH[String(t).replace(/\[1m\]$/i, "")] ?? null;
const ACME = { keyId: "personal.acme.free", provider: "acme", free: 0, planCount: 0, health: "ok",
  bench: { ok: 5, empty: 1, auth: 0, pay: 1, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 },
  models: [M("big-ok", 2_000_000), M("big-empty", 1_500_000), M("big-tagged[1m]", null), M("small-ok", 128000),
           M("small-pay", 8192), M("small-old-ok", 32000), M("exact-ok", 1_000_000), M("zero-ctx", 0),
           M("never-run", 500000)] };
const ZED = { keyId: "personal.zed.free", provider: "zed", free: 0, planCount: 0, health: "ok", bench: null,
  models: [M("z-big", 3_000_000), M("z-small", 4000)] };
const ROWS = [ACME, ZED];
const ids = (s) => view(s).items.filter((i) => i.kind === "model").map((i) => i.model.id);
const all = (s) => {                                   // every model row across pages
  const big = { ...s, termRows: 500 };
  return view(big).items.filter((i) => i.kind === "model").map((i) => i.target);
};
const open = (rows = ROWS, o = {}) => {
  let s = initState(rows, { nowMs: NOW, ...o });
  s = reduce(s, { benchOf }).state;
  return reduce(s, ENTER).state;                      // level 1 on the first provider (acme)
};
const flat = (rows = ROWS) => reduce(reduce(initState(rows, { nowMs: NOW }), { benchOf }).state, "\t").state;

// ------------------------------------------------------------------ the rule

test("isOneM: ctx >= 1,000,000 or a [1m] tag, in any case, and nothing else", () => {
  assert.equal(isOneM({ id: "a", ctx: 1_000_000 }), true, "exactly 1M counts");
  assert.equal(isOneM({ id: "a", ctx: 2_000_000 }), true);
  assert.equal(isOneM({ id: "a", ctx: 999_999 }), false);
  assert.equal(isOneM({ id: "a", ctx: 0 }), false);
  assert.equal(isOneM({ id: "a", ctx: null }), false);
  assert.equal(isOneM({ id: "a" }), false);
  assert.equal(isOneM({ id: "k[1m]", ctx: null }), true, "a tagged id with no known ctx is included");
  assert.equal(isOneM({ id: "k[1M]", ctx: null }), true, "measured: the real snapshot has one upper-case [1M] with a null ctx");
  assert.equal(isOneM({ id: "k[1m]", ctx: 200_000 }), true, "a tag with a smaller ctx is included");
  assert.equal(isOneM({ id: "k[1m]x", ctx: null }), false, "only a trailing tag");
  assert.equal(isOneM({ id: "1m", ctx: 4 }), false);
  assert.equal(isOneM(null), false);
});

// ---------------------------------------------------------------- the toggles

test("ctrl+o and ctrl+l are independent toggles at level 1 and in flat scope", () => {
  for (const start of [open(), flat()]) {
    let s = start;
    assert.equal(view(s).okOnly, false);
    assert.equal(view(s).oneM, false);
    s = reduce(s, CTRL_O).state;
    assert.deepEqual([view(s).okOnly, view(s).oneM], [true, false]);
    s = reduce(s, CTRL_L).state;
    assert.deepEqual([view(s).okOnly, view(s).oneM], [true, true]);
    s = reduce(s, CTRL_O).state;
    assert.deepEqual([view(s).okOnly, view(s).oneM], [false, true]);
    s = reduce(s, CTRL_L).state;
    assert.deepEqual([view(s).okOnly, view(s).oneM], [false, false]);
    assert.deepEqual(view(s), view(start), "off again restores the list exactly");
  }
});

test("ok-only keeps exactly the models whose latest FRESH status is ok", () => {
  const s = reduce(open(), CTRL_O).state;
  assert.deepEqual(ids(s), ["big-ok", "big-tagged[1m]", "small-ok", "exact-ok", "zero-ctx"],
    "empty, pay, an old ok and a never-benched model are out; the [1m] row resolves to its bare id");
  assert.equal(view(s).modelCount, 5);
});

test("1M+ keeps ctx >= 1M and [1m]-tagged rows, whatever the tagged row's ctx", () => {
  const s = reduce(open(), CTRL_L).state;
  assert.deepEqual(ids(s), ["big-ok", "big-empty", "big-tagged[1m]", "exact-ok"]);
});

test("the two filters and the typed text combine with logical AND", () => {
  let s = reduce(reduce(open(), CTRL_O).state, CTRL_L).state;
  assert.deepEqual(ids(s), ["big-ok", "big-tagged[1m]", "exact-ok"]);
  s = reduce(s, "b").state; s = reduce(s, "i").state; s = reduce(s, "g").state;
  assert.deepEqual(ids(s), ["big-ok", "big-tagged[1m]"], "typing narrows further");
  s = reduce(s, CTRL_O).state;
  assert.deepEqual(ids(s), ["big-ok", "big-empty", "big-tagged[1m]"], "dropping one filter widens it again");
  assert.equal(view(s).filter, "big", "and the typed text was never touched");
});

test("flat scope filters over every provider's models by target", () => {
  let s = flat();
  assert.equal(all(s).length, 11);
  s = reduce(s, CTRL_O).state;
  assert.deepEqual(all(s), ["acme/big-ok", "acme/big-tagged[1m]", "acme/small-ok", "acme/exact-ok", "acme/zero-ctx", "zed/z-big"]);
  s = reduce(s, CTRL_L).state;
  assert.deepEqual(all(s), ["acme/big-ok", "acme/big-tagged[1m]", "acme/exact-ok", "zed/z-big"]);
});

test("ok-only with no bench data yields an empty list, not a crash", () => {
  let s = reduce(initState(ROWS, { nowMs: NOW }), "\t").state;         // benchOf never injected
  s = reduce(s, CTRL_O).state;
  assert.equal(view(s).empty, true);
  assert.equal(view(s).modelCount, 0);
  assert.equal(view(s).okOnly, true);
  // ...and it fills in when the lazy reader arrives.
  s = reduce(s, { benchOf }).state;
  assert.equal(view(s).empty, false);
  assert.equal(reduce(s, ENTER).exit.target.startsWith("acme/"), true);
  assert.doesNotThrow(() => reduce(reduce(initState(ROWS), "\t").state, CTRL_O));
});

test("ctrl+o and ctrl+l are no-ops at the provider level and never enter the filter", () => {
  const s0 = reduce(initState(ROWS, { nowMs: NOW }), { benchOf }).state;
  for (const key of [CTRL_O, CTRL_L, CTRL_B]) {
    const r = reduce(s0, key);
    assert.deepEqual(r.state, s0, `level 0: ${JSON.stringify(key)} changes nothing`);
    assert.equal(r.exit, null);
    assert.equal(view(r.state).filter, "");
  }
  let s = open();
  for (const key of [CTRL_O, CTRL_L, CTRL_B, "\x01", "\x04", "\x05", "\x0e", "\x10", "\x14", "\x15", "\x16", "\x17", "\x18", "\x19"]) {
    s = reduce(s, key).state;
    assert.equal(view(s).filter, "", `control key ${JSON.stringify(key)} never becomes a filter character`);
  }
});

test("modals swallow the keys: the legend closes, nothing toggles behind it", () => {
  const s = reduce(open(), "?").state;
  const r = reduce(s, CTRL_O).state;
  assert.equal(view(r).legend, false);
  assert.equal(view(r).okOnly, false);
  const withheld = { ...ACME, refused: [{ id: "x", reason: "r", removed: 1 }] };
  const m = reduce(open([withheld, ZED]), "\x12").state;              // ctrl+r opens the refusals overlay
  assert.ok(m.refusals);
  const after = reduce(m, CTRL_L).state;
  assert.equal(after.refusals, null);
  assert.equal(view(after).oneM, false);
});

test("the cursor and scroll clamp when the filtered list shrinks", () => {
  const many = { ...ACME, models: Array.from({ length: 60 }, (_, i) => M(`m${i}`, i % 6 === 0 ? 2_000_000 : 8000)) };
  let s = reduce(initState([many], { nowMs: NOW, termRows: 12 }), { benchOf }).state;
  s = reduce(s, ENTER).state;
  for (let i = 0; i < 40; i++) s = reduce(s, DOWN).state;
  assert.ok(view(s).cursor >= 30);
  s = reduce(s, CTRL_L).state;
  assert.equal(view(s).modelCount, 10);
  assert.equal(view(s).cursor, 0, "toggling resets to the top, like a typed filter");
  assert.equal(view(s).top, 0);
  for (let i = 0; i < 30; i++) s = reduce(s, DOWN).state;
  assert.ok(view(s).cursor <= 9);
});

test("the toggles persist for the session: back and forth between levels and into flat scope", () => {
  let s = reduce(open(), CTRL_O).state;
  s = reduce(s, ESC).state;                                            // back to the providers
  assert.equal(view(s).level, 0);
  assert.equal(view(s).okOnly, true, "still on at level 0 (it just does nothing there)");
  s = reduce(s, DOWN).state;
  s = reduce(s, ENTER).state;                                          // open zed
  assert.equal(view(s).provider.provider, "zed");
  assert.equal(view(s).okOnly, true, "and applies to the next provider too");
  assert.deepEqual(ids(s), ["z-big"]);                                 // only zed's ok model
  s = reduce(reduce(s, ESC).state, "\t").state;
  assert.equal(view(s).okOnly, true, "and to flat scope");
});

test("enter on a filtered row selects the right target", () => {
  let s = reduce(reduce(open(), CTRL_O).state, CTRL_L).state;
  s = reduce(s, DOWN).state;                                           // second row: big-tagged[1m]
  const r = reduce(s, ENTER);
  assert.equal(r.exit.target, "acme/big-tagged[1m]");
  let f = reduce(reduce(flat(), CTRL_O).state, CTRL_L).state;
  f = reduce(f, DOWN).state;
  f = reduce(f, DOWN).state;
  f = reduce(f, DOWN).state;
  assert.equal(reduce(f, ENTER).exit.target, "zed/z-big");
});

test("the withheld-list door is hidden while a filter is on, and back when it is off", () => {
  const withheld = { ...ACME, refused: [{ id: "x", reason: "r", removed: 1 }] };
  let s = open([withheld, ZED]);
  assert.equal(view(s).items[0].kind, "withheld-list");
  s = reduce(s, CTRL_L).state;
  assert.equal(view(s).items.some((i) => i.kind === "withheld-list"), false);
  s = reduce(s, CTRL_L).state;
  assert.equal(view(s).items[0].kind, "withheld-list");
});

// ------------------------------------------------------------------- render

const META = { providers: 2, models: 11, generatedAt: "2026-09-29T12:00:00Z", benchOf,
               benchAsOf: "2026-09-29T12:34:56Z", discoveredAsOf: "2026-09-07T13:37:38Z", okTotal: 5, flatIdW: 20 };
const header = (v, cols = 80, env = ASCII, meta = META) =>
  frame(v, meta, { caps: detectCaps(env, cols) }).map(strip).find((l) => l.includes("filter:"));
// The data stamps live at the right end of the `id:` line (#114 redesign).
const stamps = (v, cols = 80, env = ASCII, meta = META) =>
  frame(v, meta, { caps: detectCaps(env, cols) }).map(strip).find((l) => /id: |benched|routable|discovered/.test(l));

test("the chips are visible next to the filter, and nothing clips at the 78-column floor", () => {
  const s = open();
  assert.ok(!header(view(s)).includes("["), "no chips while nothing is on");
  const on = reduce(reduce(s, CTRL_O).state, CTRL_L).state;
  for (const env of [ASCII, UNI]) {
    const h = header(view(on), 80, env);
    assert.ok(h.includes("filter: ") && h.includes("[ok] [1M+]"), h);
    assert.equal(cps(h), 78);
    // Anchored: the right side ends the line, whole (stamp and UTC marker), then the frame's own edge.
    assert.ok(/3 of 9 . 5 ok \(56%\) .$/.test(h), h);
  }
  const one = header(view(reduce(s, CTRL_L).state));
  assert.ok(one.includes("[1M+]") && !one.includes("[ok]"));
  const typed = reduce(on, "z").state;
  assert.ok(header(view(typed)).includes("z"), "the typed text sits before the chips");
});

test("N of M counts the filtered list against the provider's models; K ok is computed live from the same records", () => {
  let s = open();
  assert.ok(header(view(s)).includes("9 of 9 | 5 ok (56%)"), header(view(s)));
  s = reduce(s, CTRL_O).state;
  assert.ok(header(view(s)).includes("5 of 9 | 5 ok ("), header(view(s)));
  s = reduce(s, CTRL_L).state;
  assert.ok(header(view(s)).includes("3 of 9 | 5 ok ("), header(view(s)));
  // Flat scope: N of the whole catalogue, and the total ok figure after it.
  let f = flat();
  assert.ok(header(view(f), 100).includes("11 of 11 models | 6 ok (55%)"), header(view(f), 100));
  f = reduce(reduce(f, CTRL_O).state, CTRL_L).state;
  assert.ok(header(view(f), 100).includes("4 of 11 models | 6 ok ("), header(view(f), 100));
});

test("the header at each level, exactly, with and without bench data (78 and 134 columns)", () => {
  const noBench = { providers: 2, models: 11, generatedAt: "x", discoveredAsOf: "2026-09-07T13:37:38Z", routableAsOf: "2026-09-29T09:18:00Z" };
  const lvl1 = view(open());
  // level 1: header `N of M | K ok (P%)`; the stamps are on the id line.
  assert.ok(header(lvl1, 80).endsWith("9 of 9 | 5 ok (56%) |"));
  assert.ok(header(lvl1, 134).endsWith("9 of 9 | 5 ok (56%) |"));
  assert.ok(stamps(lvl1, 80).endsWith("benched 09-29 12:34Z | discovered 09-07 13:37Z |"), stamps(lvl1, 80));
  assert.ok(stamps(lvl1, 134).endsWith("benched 09-29 12:34Z | discovered 09-07 13:37Z |"));
  // Real scale (424 models, 229 ok): the same header shape, thousands separators from 1,000.
  const real = { ...ACME, models: Array.from({ length: 424 }, (_, i) => M(`m${i}`)) };
  const realBench = (t) => { const m = /^acme\/m(\d+)$/.exec(t); return m && Number(m[1]) < 229 ? rec("ok") : null; };
  const realOpen = reduce(reduce(initState([real, ZED], { nowMs: NOW }), { benchOf: realBench }).state, ENTER).state;
  assert.ok(header(view(realOpen), 80).endsWith("424 of 424 | 229 ok (54%) |"));
  // No reader injected yet (bench.json not loaded): the live figure is unknown, drawn as a dash.
  const zedView = view(reduce(reduce(initState(ROWS, { nowMs: NOW }), DOWN).state, ENTER).state);
  assert.ok(header(zedView, 80).includes("2 of 2 | - ok"), "no bench counts on the provider: a dash, never `0 ok`");
  assert.ok(stamps(zedView, 100, ASCII, noBench).includes("benched - run bench-cli --live"), stamps(zedView, 100, ASCII, noBench));
  // flat: `N of M models | K ok (P%)`
  assert.ok(header(view(flat()), 80).endsWith("11 of 11 models | 6 ok (55%) |"));
  assert.ok(stamps(view(flat()), 134).endsWith("benched 09-29 12:34Z | discovered 09-07 13:37Z |"));
  assert.ok(header(view(reduce(initState(ROWS, { nowMs: NOW }), "\t").state), 80, ASCII, { ...noBench, okTotal: null }).includes("| - ok"));
  // level 0: `P providers | M models | K ok (P%)`, stamps on the id line
  const l0 = view(reduce(initState(ROWS, { nowMs: NOW }), { benchOf }).state);
  const m0 = { ...META, routableAsOf: "2026-09-29T09:18:00Z" };
  assert.ok(header(l0, 80, ASCII, m0).endsWith("2 providers | 11 models | 5 ok (45%) |"));
  assert.ok(stamps(l0, 80, ASCII, m0).includes("routable 09-29 09:18Z"), stamps(l0, 80, ASCII, m0));
  assert.ok(header(l0, 80, ASCII, { ...noBench, okTotal: null }).includes("11 models | - ok"));
});

test("the ok figure survives when space is short: it is part of the counts, and the counts are never dropped", () => {
  // 20,000 models, all ok: five digits in both figures at the 78-column floor.
  const many = { ...ACME, models: Array.from({ length: 20000 }, (_, i) => M(`m${i}`)) };
  const allOk = () => rec("ok");
  const st = reduce(initState([many, ZED], { nowMs: NOW }), { benchOf: allOk }).state;
  const h1 = header(view(reduce(st, ENTER).state), 80);
  assert.ok(h1.includes("20,000 of 20,000 | 20,000 ok (100%)"), h1);
  assert.equal(cps(h1), 78);
  const h = header(view(reduce(st, "\t").state), 80, ASCII, { ...META, models: 20002 });
  assert.ok(h.includes("20,002 of 20,002 models | 20,002 ok (100%)"), h);
  assert.equal(cps(h), 78);
});

test("an empty result names the active toggles, says so when there is no bench data, and keeps the way out", () => {
  let s = reduce(reduce(open(), CTRL_O).state, CTRL_L).state;
  s = reduce(s, "q").state;
  s = reduce(s, "z").state;                                            // nothing matches
  assert.equal(view(s).empty, true);
  const text = frame(view(s), META, { caps: detectCaps(ASCII, 80) }).map(strip);
  assert.ok(text.some((l) => l.includes('no match for "qz"') && l.includes("backspace to widen")));
  assert.ok(text.some((l) => l.includes("filtered by ok-only + 1M+ context only")), text.join("\n"));
  assert.ok(text.some((l) => l.includes("ctrl+o") && l.includes("ctrl+l")));
  for (const l of text) assert.equal(cps(l), 78);
  // no bench data at all: ok-only yields nothing, and it says why
  let n = reduce(initState(ROWS, { nowMs: NOW }), ENTER).state;
  n = reduce(n, CTRL_O).state;
  assert.equal(view(n).empty, true);
  const bare = frame(view(n), { providers: 2, models: 11, generatedAt: "x" }, { caps: detectCaps(ASCII, 80) }).map(strip);
  assert.ok(bare.some((l) => l.includes("filtered by ok-only") && l.includes("no benchmark data yet")), bare.join("\n"));
  // with nothing toggled the empty state is what it always was
  const plain = reduce(open(), "q").state;
  const quiet = frame(view(reduce(plain, "z").state), META, { caps: detectCaps(ASCII, 80) }).map(strip);
  assert.equal(quiet.some((l) => l.includes("filtered by")), false);
});

test("every line is exactly the frame width with the filters on, at every width, in both glyph sets", () => {
  const states = [reduce(reduce(open(), CTRL_O).state, CTRL_L).state, reduce(open(), CTRL_L).state,
                  reduce(reduce(flat(), CTRL_O).state, CTRL_L).state,
                  reduce(reduce(reduce(open(), CTRL_O).state, "q").state, "z").state];
  for (const st of states) {
    for (const env of [UNI, ASCII]) {
      for (const cols of [40, 80, 100, 134, 400]) {
        const caps = detectCaps(env, cols);
        for (const l of frame(view(st), META, { caps })) {
          assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}: ${strip(l)}`);
        }
      }
    }
  }
});

test("the footer names both toggles and fits the 78-column frame in both glyph sets", () => {
  for (const env of [UNI, ASCII]) {
    const foot = strip(frame(view(open()), META, { caps: detectCaps(env, 80) }).at(-1));
    assert.ok(foot.includes("^o") && foot.includes("^l") && foot.includes("[?]"), foot);
    assert.equal(cps(foot), 78);
  }
});

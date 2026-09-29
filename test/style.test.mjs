import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps, motionEnabled, glyphsFor, painter, badgeColour,
         provenanceDot, padId, countCell, highlight, frame, confirmLine, sleepSync,
         slideFrames, flashFrames, revealFrames, FRAME_W, FRAME_MIN, FRAME_MAX,
         frameWidth, layoutFor, MODEL_ID_MAX, KEYID_MAX, W } from "../menu/style.mjs";

const cps = (s) => [...s].length;
// The data stamps live at the right end of the `id:` line (#114 redesign); this finds that line.
const stampLine = (lines) => strip(lines.find((l) => /discovered|benched|routable|bench \d/.test(strip(l))) ?? "");
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const VT = detectCaps({ WT_SESSION: "1", COLORTERM: "truecolor" }, 120);
const PLAIN = detectCaps({ TERM: "dumb" }, 80);

const ROWS = [
  // `free` is the COUNT OF FREE MODELS in this row. With two models, one badged
  // FREE and one PAID, it is 1. It read 3, which is unreachable from two models,
  // and the exact-row literal below was transcribed from the frozen ASCII mock —
  // which shows this provider with THREE models — rather than generated from this
  // fixture. `proportionBar` hid half the mismatch: proportionBar(3, 2) saturates
  // to a full bar, the same glyphs the mock shows for 3-of-3, so only the count
  // column exposed it.
  { keyId: "personal.google.free", provider: "google", free: 1, planCount: 0, health: "ok",
    models: [{ id: "gemini-3.5-flash-lite", ctx: 1000000, pin: 0, pout: 0, badge: "FREE",
               tools: true, vision: true, reason: true },
             { id: "gemini-3.5-pro", ctx: 1000000, pin: 1.25, pout: 10, badge: "PAID",
               tools: true, vision: true, reason: false }] },
  { keyId: "personal.dead.free", provider: "dead", free: null, planCount: 0, health: "broken",
    models: [{ id: "dead-1", ctx: null, pin: null, pout: null, badge: "",
               tools: false, vision: false, reason: false }] },
];
const META = { providers: 2, models: 3, generatedAt: "2026-08-24T12:22:28.162Z" };
// Where the badge text begins on a model row (#114 model level): frame char 1, mark and
// glyph 4, the id, then stat 5, ttft 6, [total 6], [tok/s 6], ctx 7, $in 6, $out 6, and
// the badge cell's own leading gap. Derived from the layout the renderer used.
const modelBadgeCol = (L) => 1 + 4 + L.W.id + 5 + 6 + (L.showTotal ? 6 : 0) + (L.showTps ? 6 : 0) + 19 + 1;
// The longest id of ROWS[0]'s models: what the renderer sizes the id column to on V1.
const V1_ID_W = Math.max(...ROWS[0].models.map((m) => m.id.length));
const V0 = {
  level: 0, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false,
  provider: null, more: 0,
  items: ROWS.map((row) => ({ kind: "provider", row })),
};
const V1 = {
  level: 1, scope: "tree", filter: "flash", legend: false, cursor: 0, top: 0, empty: false,
  provider: ROWS[0], more: 0,
  items: [{ kind: "model", model: ROWS[0].models[0], target: "google/gemini-3.5-flash-lite" }],
};

test("detectCaps recognises Windows Terminal as a 256-colour VT host", () => {
  assert.equal(VT.vt, true);
  assert.equal(VT.unicode, true);
  assert.equal(VT.colours, 256);
});

test("detectCaps refuses everything for TERM=dumb", () => {
  assert.equal(PLAIN.vt, false);
  assert.equal(PLAIN.unicode, false);
  assert.equal(PLAIN.colours, 0);
});

test("detectCaps falls back to 16 colours when the host is unknown", () => {
  const c = detectCaps({ TERM: "xterm" }, 80);
  assert.equal(c.vt, true);
  assert.equal(c.colours, 16);
});

test("motion is off for the kill switch, the flag, a dumb terminal and a narrow one", () => {
  assert.equal(motionEnabled({ env: {}, flags: [], caps: VT }), true);
  assert.equal(motionEnabled({ env: { UW_PICKER_MOTION: "0" }, flags: [], caps: VT }), false);
  assert.equal(motionEnabled({ env: {}, flags: ["--no-motion"], caps: VT }), false);
  assert.equal(motionEnabled({ env: {}, flags: [], caps: PLAIN }), false);
  assert.equal(motionEnabled({ env: {}, flags: [], caps: { ...VT, cols: 59 } }), false);
});

test("badge colours are the whole badge set and nothing else", () => {
  assert.equal(badgeColour("FREE"), "grn");
  assert.equal(badgeColour("FREE?"), "yel");
  assert.equal(badgeColour("PLAN"), "cya");
  assert.equal(badgeColour("PAID"), "dim");
  assert.equal(badgeColour(""), "");
  assert.equal(badgeColour("NONSENSE"), "");
});

test("highlight bolds only the matched substring and is a no-op without a query", () => {
  const p = painter(VT);
  assert.equal(strip(highlight("gemini-3.5-flash", "flash", p)), "gemini-3.5-flash");
  assert.match(highlight("gemini-3.5-flash", "flash", p), /\x1b\[1mflash\x1b/);
  assert.equal(highlight("gemini-3.5-flash", "", p), "gemini-3.5-flash");
  assert.equal(highlight("gemini-3.5-flash", "zzz", p), "gemini-3.5-flash");
});

test("glyphs fall back to ASCII with no escape sequences at all", () => {
  const g = glyphsFor(PLAIN);
  assert.equal(g.marker, ">");
  assert.equal(g.frame.tl, "+");
  const lines = frame(V0, META, { caps: PLAIN });
  assert.equal(lines.join("").includes("\x1b"), false);
  assert.equal(/[^\x00-\x7f]/.test(lines.join("")), false);
});

// --- frame geometry --------------------------------------------------------
//
// A caution that this task earned. The two exact-row tests below were originally
// written as hand-composed string literals, and all three of the numbers involved
// disagreed: the literals were 76 columns, the renderer produced 77 for an
// in-range row and 80 for the badge row, and the invariant test asserted 78. None
// of the three had ever been executed. So the literals are kept -- they are the
// only thing that catches a column being silently swapped with its neighbour --
// but they are no longer the *only* geometry test, and they are not authoritative.
//
// The order of authority is: (1) the width invariant, which needs no literal;
// (2) the derived-offset test, which computes where each column must begin from
// the same W constants the renderer uses; (3) the literals, which are a
// human-readable transcript. When (3) disagrees with (1) or (2) after a
// deliberate change, regenerate (3) by running `frame()` and pasting the output.

test("level 0 renders the exact provider row, columns included", () => {
  // `rows` lets the key id column elide across ALL providers (distinct cells, visible marker).
  const lines = frame(V0, { ...META, rows: ROWS }, { caps: PLAIN });
  const row = lines.find((l) => l.startsWith("|> perso"));
  // Level 0: key id (16 at the floor: what the other columns leave) | status | models | ok | % | [free | %] | empt auth pay rate gone
  // t/o err. This fixture has no `bench` data, so status, ok and the raw cells are blank; there is no `free`
  // block at 78 (the full key id comes first, then free needs 10 more columns). Each cell is a dim rule (`:` in ASCII) plus right-aligned text;
  // the widths sum to the frame's 75 inner columns.
  const cells = ":" + " ".repeat(6) + ":" + "      2" + ":" + " ".repeat(4) + ":" + " ".repeat(4) +
    ":" + " ".repeat(4) + ":" + " ".repeat(4) + ":" + " ".repeat(3) + ":" + " ".repeat(4) +
    ":" + " ".repeat(4) + ":" + " ".repeat(3) + ":" + " ".repeat(3);
  assert.equal(row.slice(0, 3), "|> ");
  assert.equal(row.slice(3, 19).length, 16);
  assert.ok(row.slice(3, 19).includes(glyphsFor(PLAIN).elide), "the 20-character key id is elided with a visible marker");
  assert.equal(row.slice(19), cells + " |");
  assert.equal(cps(row), 78);
});

test("level 0 renders the exact status, ok and raw cells for a provider that was benched", () => {
  const row = { ...ROWS[0], bench: { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 1,
                                     timeout: 0, error: 0, skip: 0 },
                benchFlags: { dead: false, needsMoney: true, alive: true, status: "alive" } };
  const line = frame({ ...V0, items: [{ kind: "provider", row }] }, { ...META, rows: ROWS }, { caps: PLAIN })
    .find((l) => l.startsWith("|> perso"));
  assert.equal(line.slice(19),
    ":" + " alive" + ":" + "      2" + ":" + "   1" + ":" + " 50%" +
    ":" + "   -" + ":" + "   -" + ":" + "  -" + ":" + "   -" + ":" + "   1" + ":" + "  -" + ":" + "  -" + " |");
});

test("level 1 renders the exact model row, columns included", () => {
  // The model level is one view (#114): gutter, id (sized to the provider's longest id,
  // 21 here), stat, ttft, ctx, $in, $out, badge, type, TVR. This fixture has no bench data, so
  // stat/ttft are blank and the modality is unknown (`?`); `total`, `tok/s` and `output` do not fit at 78.
  const lines = frame(V1, META, { caps: PLAIN });
  const row = lines.find((l) => l.includes("gemini-3.5-flash-lite"));
  assert.equal(row,
    "|>   gemini-3.5-flash-lite" + ":" + " ".repeat(4) + ":" + " ".repeat(5) +
    ":" + "    1M" + ":" + " 0.00" + ":" + " 0.00" + ":" + "FREE " + ":" + "?       " + ":" + "TVR" + " ".repeat(1) + " |");
});

test("every column begins where the layout says it begins", () => {
  // Derived, not transcribed: if a cell width changes this names the column; if the header and the
  // row drift apart, it fails too. A wide terminal, so the optional `free` block is drawn.
  const caps0 = { ...PLAIN, cols: 134 };
  const LW0 = layoutFor(frameWidth(caps0), { keyW: 30 });
  assert.equal(LW0.showFree, true);
  const benched = { ...ROWS[0], bench: { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0,
                                         timeout: 0, error: 0, skip: 0 },
                    benchFlags: { dead: false, needsMoney: false, alive: false, status: "dead" } };
  const lines0 = frame({ ...V0, items: [{ kind: "provider", row: benched }] }, META, { caps: caps0 });
  const l0 = strip(lines0.find((l) => l.includes("personal.google.free")));   // 20 <= 30: not clipped at 134
  const h0 = strip(lines0.find((l) => l.includes("key id")));
  // key id | status | oldest probe | models | ok | ok% | free | free% | raw ...
  assert.equal(LW0.showProbe, true);
  const statusCol = 1 + 2 + LW0.W.keyId, probeCol = statusCol + 7, modelsCol = probeCol + 13, okCol = modelsCol + 8, okPctCol = okCol + 5;
  const freeCol = okPctCol + 5, freePctCol = freeCol + 5, rawCol = freePctCol + 5;
  assert.equal(h0.slice(statusCol, statusCol + 7), ":status", "status comes right after the key id");
  assert.equal(h0.slice(probeCol, probeCol + 13), ":oldest probe", "oldest probe comes right after status");
  assert.equal(h0.slice(modelsCol, modelsCol + 8), ": models");
  assert.equal(h0.slice(okCol, okCol + 5), ":  ok", "right-aligned dim headers over right-aligned cells");
  assert.equal(h0.slice(okPctCol, okPctCol + 5), ":   %");
  assert.equal(h0.slice(freeCol, freeCol + 5), ":free");
  assert.equal(h0.slice(freePctCol, freePctCol + 5), ":   %");
  assert.equal(h0.slice(rawCol, rawCol + 5), ":empt");
  assert.equal(l0.slice(statusCol, statusCol + 7), ":  dead", "dead, right-aligned under `status`");
  assert.equal(l0.slice(probeCol, probeCol + 13), ":" + " ".repeat(12), "no age data on this row: the cell is blank");
  assert.equal(l0.slice(modelsCol, modelsCol + 8), ":      2");
  assert.equal(l0.slice(okCol, okCol + 5), ":   1");
  assert.equal(l0.slice(okPctCol, okPctCol + 5), ": 50%", "the percent, right-aligned in 4");
  assert.equal(l0.slice(freeCol, freeCol + 5), ":   1", "free: 1 of the provider's 2 models");
  assert.equal(l0.slice(freePctCol, freePctCol + 5), ": 50%");

  const l1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("gemini-3.5-flash-lite"));
  const h1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("model "));
  const badgeCol = modelBadgeCol(layoutFor(frameWidth(PLAIN), { idW: V1_ID_W }));
  assert.equal(strip(l1).indexOf("FREE"), badgeCol, "badge column");
  assert.equal(strip(l1).indexOf("TVR"), badgeCol + 15, "caps column: badge 5 + a rule + modality 8 + a rule");
  assert.equal(strip(h1).indexOf("badge"), badgeCol);
  assert.equal(strip(h1).indexOf("modality"), badgeCol + 6, "the modality column sits right after the badge");
  assert.equal(strip(h1).indexOf("TVR"), badgeCol + 15);
});

test("a coloured badge occupies exactly W.badge visible columns", () => {
  // The specific defect: `pad` runs sanitizeDisplay, which strips CSI, so
  // colouring BEFORE padding deleted the colour and padded to W.badge + 9.
  // Both halves are asserted -- the colour survives, and the width is right.
  //
  // ON AN UNSELECTED ROW, and that matters. `V1` puts the cursor on its only
  // item, and the renderer draws a selected row as `p.inv(strip(body))` --
  // `strip` removes every SGR sequence before the inversion wraps it, so a
  // selected row carries the inversion escapes and nothing else. Asserting colour
  // there cannot pass, while the width half passes regardless because `strip`
  // removes the inversion too. The render is right: an inverted row is meant to
  // drop its colours. The fixture was wrong, and it was wrong inside the fix for
  // the very defect it was written to test.
  const p = painter(VT);
  const V1U = { ...V1, cursor: 1, items: [...V1.items,
    { kind: "model", model: ROWS[0].models[1], target: "google/gemini-3.5-pro" }] };
  // Strip BEFORE matching to find the row. V1's filter is "flash", so on a
  // colour-capable host `highlight` wraps that substring in bold -- the rendered
  // id reads `gemini-3.5-<ESC>[1mflash<ESC>[0m-lite`, and a raw `includes` of the
  // whole id finds nothing and hands `undefined` to the assertion below.
  const row = frame(V1U, META, { caps: VT })
    .find((l) => strip(l).includes("gemini-3.5-flash-lite"));
  assert.match(row, /\x1b\[3[0-9]m *FREE|\x1b\[3[0-9]mFREE/, "the badge must still be coloured");
  const s = strip(row);
  // R16: `1 + 2` (frame char + mark/space) is followed by the provenance
  // gutter (`W.prov` glyph + 1 space) before the id cell.
  //
  // WIDTHS COME FROM THE LAYOUT THE RENDERER USED, not from the base table.
  // `VT` reports 120 columns, so `id` absorbs the surplus and the badge sits
  // that much further right; deriving the offset from the fixed `W` asserted a
  // position the elastic frame never puts it in.
  const badgeCol = modelBadgeCol(layoutFor(frameWidth(VT), { idW: V1_ID_W }));
  assert.equal(s.slice(badgeCol, badgeCol + 5), "FREE ");
  assert.equal(s.indexOf("TVR"), badgeCol + 15);
});

test("the capability cell has three glyphs, not two, and still occupies W.caps", () => {
  // capsOf distinguishes "the catalogue says no" (false) from "the catalogue does
  // not say" (null). Rendering both as `-` would move the coercion one layer out
  // instead of removing it, so the correctness fix upstream is only real if this
  // cell is tri-state too.
  //
  // Width is asserted alongside, because the cell sits at the right-hand end of
  // the model row and a two-column "??" would push the frame character out --
  // which `every line of every frame is exactly FRAME_W` would report as a whole
  // frame failing, with nothing to say which cell caused it.
  const mk = (caps) => ({ kind: "model", target: "p/m", row: {},
    model: { id: "m", ctx: null, pin: null, pout: null, badge: "", routable: null, ...caps } });
  const cell = (caps) => {
    const v = { ...V1, filter: "", cursor: 9, items: [mk(caps)] };
    const line = frame(v, META, { caps: PLAIN }).find((l) => l.includes(" m "));
    // Sized like the renderer sized it: the id column holds this one id, `m`.
    const badgeCol = modelBadgeCol(layoutFor(frameWidth(PLAIN), { idW: V1_ID_W }));   // V1's provider
    return strip(line).slice(badgeCol + 15, badgeCol + 15 + W.caps);
  };
  assert.equal(cell({ tools: true, vision: true, reason: true }), "TVR");
  assert.equal(cell({ tools: false, vision: false, reason: false }), "---");
  assert.equal(cell({ tools: null, vision: null, reason: null }), "???");
  // Mixed, so the three are read per column rather than per row.
  assert.equal(cell({ tools: true, vision: false, reason: null }), "T-?");
  const seen = new Set(["TVR", "---", "???"]);
  assert.equal(seen.size, 3, "three states must render three distinct cells");
});

test("an astral id cannot render a short frame", () => {
  // NB-4's regression, and the reason one measure is authoritative. Thirty astral
  // code points are sixty UTF-16 code units. When `pad` counted units and `bar`
  // counted units while `sanitizeDisplay` capped by code point, this row rendered
  // roughly thirty columns short -- and depending on the exact lengths the width
  // test either failed loudly or PASSED while the terminal was wrong, which is
  // the outcome that would have shipped.
  const wide = {
    ...V0,
    items: [{ kind: "provider", row: {
      keyId: "\u{1F600}".repeat(30), provider: "p", free: 1, planCount: 0, health: "ok",
      models: [{ id: "a", routable: null }] } }],
  };
  for (const l of frame(wide, META, { caps: PLAIN })) {
    assert.equal([...strip(l)].length, FRAME_W, "code points, the measure style.mjs pads with");
  }
});

test("every line of every frame is exactly the frame width for that terminal", () => {
  // RETARGETED from a fixed `FRAME_W` when the frame became elastic. The
  // invariant is unchanged in strength -- every line of a frame still measures
  // exactly one width -- but that width is now `frameWidth(caps)` rather than
  // the constant, so a 120-column terminal must produce 118-column lines and a
  // test pinned to 78 would report correct output as a corrupt frame.
  //
  // The widths below straddle every branch of the clamp: below the floor, at
  // the floor, between, and past the ceiling.
  for (const v of [V0, V1, { ...V0, empty: true, items: [], filter: "zzz" },
                   { ...V0, legend: true }]) {
    for (const base of [VT, PLAIN]) {
      for (const cols of [40, 80, 100, 134, 400]) {
        const caps = { ...base, cols };
        const expected = frameWidth(caps);
        for (const l of frame(v, META, { caps })) {
          // Code points, the same measure style.mjs pads with. Using .length here
          // would let an astral row pass this test while rendering short.
          const w = [...strip(l)].length;
          assert.equal(w, expected, `cols ${cols}: width ${w}: ${strip(l)}`);
        }
      }
    }
  }
});

test("frameWidth clamps to [FRAME_MIN, FRAME_MAX] and keeps a two-column margin", () => {
  // The margin is where the original 78 came from -- an 80-column terminal minus
  // two -- so this pins that an 80-column terminal still renders exactly what it
  // rendered before the frame became elastic. Without it every existing width
  // fixture shifts by two and the change looks like a regression.
  assert.equal(frameWidth({ cols: 80 }), 78, "the historical default is unchanged");
  assert.equal(frameWidth({ cols: 100 }), 98);
  assert.equal(frameWidth({ cols: 134 }), 132, "the frame follows the terminal");
  assert.equal(frameWidth({ cols: 240 }), 238);
  assert.equal(FRAME_MAX, 260, "the ceiling is high enough that a wide terminal is used, not capped at 132");
  assert.equal(frameWidth({ cols: 400 }), FRAME_MAX, "clamped at the ceiling");
  assert.equal(frameWidth({ cols: 40 }), FRAME_MIN, "never narrower than the floor");
  assert.equal(frameWidth({}), FRAME_MIN, "a terminal that reports no width");
  assert.equal(frameWidth({ cols: NaN }), FRAME_MIN);
});

test("layoutFor spends surplus width on the name columns and nothing else", () => {
  const base = layoutFor(FRAME_MIN);
  const wide = layoutFor(FRAME_MIN + 20);
  // Level 0's other columns take 59 of the 75 inner columns (#114 redesign): the key id gets 16.
  assert.equal(base.W.keyId, 16, "at the floor the key id gets what the other level-0 columns leave");
  // Level 0 has its own budget: the key id takes its FULL content first (default 30 here), then the optional `free`
  // block (10); surplus beyond that is NOT poured into anything.
  assert.equal(wide.W.keyId, 30, "20 spare columns: the id is whole (30)");
  assert.equal(wide.showFree, false, "and the 7 left over do not buy `free`");
  assert.equal(layoutFor(FRAME_MAX, { keyW: 45 }).W.keyId, 45, "a 45-character id is whole");
  assert.equal(layoutFor(FRAME_MAX, { keyW: 12 }).W.keyId, 12, "a narrower content narrows it");
  assert.equal(layoutFor(FRAME_MAX, { keyW: 500 }).W.keyId, KEYID_MAX, "and a hostile one is capped");
  // The model level is one view with a priority list (see layoutFor): the always-drawn
  // cells take 49, the id keeps MODEL_ID_MIN (22), `total` then `tok/s` and the preview
  // come next, and only what is left grows the id toward its content.
  assert.equal(base.W.id, 22, "at the floor: 75 - 4 - 49 = 22 for the default 37-wide id");
  assert.equal(layoutFor(FRAME_MIN, { idW: 10 }).W.id, 10, "the id column is only as wide as its content");
  assert.equal(layoutFor(FRAME_MIN, { idW: 500 }).W.id, 22, "and a hostile length only ever fills what fits");
  assert.ok(wide.W.id >= 22 && wide.W.id <= MODEL_ID_MAX);
  // Everything else holds a value of known maximum width and gains nothing from
  // growing -- and a price cell that drifts as the terminal resizes is harder to
  // scan, not easier.
  for (const k of ["count", "ctx", "price", "badge", "caps", "prov"]) {
    assert.equal(wide.W[k], W[k], `${k} must not absorb surplus`);
  }
  assert.equal(wide.inner, wide.frameW - 3, "inner tracks the frame, same arithmetic as before");
});

test("an over-wide cell clips the row instead of breaking the frame", () => {
  // bar() truncates as well as pads. Without this a single long id pushed the
  // right-hand frame character past FRAME_W and failed the invariant above for
  // the whole frame, with nothing to say which cell caused it.
  const wide = {
    ...V1,
    items: [{ kind: "model", target: "acme/" + "z".repeat(300),
              model: { id: "z".repeat(300), ctx: 1e6, pin: 0, pout: 0, badge: "FREE",
                       tools: true, vision: true, reason: true, routable: null } }],
  };
  for (const l of frame(wide, META, { caps: PLAIN })) {
    // Code points, like every other width assertion in this task. This fixture is
    // all-ASCII so units and points agree at 78 today; the moment it gained an
    // astral character `.length` would read 153 and this test -- the one whose
    // whole subject is over-wide input -- would be the one measuring wrongly.
    assert.equal([...strip(l)].length, FRAME_W);
  }
});

test("level 0 no longer draws the provider health label (the snapshot field stays)", () => {
  // The single `health` column was replaced by the nine status counts (#114). The
  // row's `health` string is still on the snapshot for other readers, so a
  // provider carrying one must render without it rather than leak it into a cell.
  const v = { ...V0, items: [{ kind: "provider", row: {
    keyId: "personal.acme.paid", provider: "acme", free: 0, planCount: 0,
    health: "needs $", models: [{ id: "a", routable: null }] } }] };
  for (const cols of [80, 134]) {
    const lines = frame(v, META, { caps: { ...PLAIN, cols } }).map(strip);
    assert.equal(lines.some((l) => /health/.test(l)), false, `cols ${cols}`);
    // Look at the ROW only: the health string must not leak into any cell.
    const row = lines.find((l) => l.includes("personal.acme.p"));
    assert.equal(/needs \$/.test(row), false, `cols ${cols}: the health string leaked into a cell`);
  }
});

test("the empty state names the query, and the legend replaces the rows", () => {
  const e = frame({ ...V0, empty: true, items: [], filter: "zzz" }, META,
                  { caps: PLAIN }).join("\n");
  assert.match(e, /no match for "zzz"/);
  // The way out survives a filter long enough to overflow the row (NB-9).
  const longQ = "z".repeat(30);
  const overflow = frame({ ...V0, empty: true, items: [], filter: longQ }, META,
                         { caps: PLAIN }).find((l) => l.includes("backspace"));
  assert.match(strip(overflow), /backspace to widen, esc to clear/,
    "the instruction must never be the part that gets clipped");
  assert.equal([...strip(overflow)].length, FRAME_W);
  assert.equal(e.includes("personal.google.free"), false);
  const l = frame({ ...V0, legend: true }, META, { caps: PLAIN }).join("\n");
  assert.match(l, /\[\^f\]/);
  assert.match(l, /\[\?\]/);
});

test("the help line is present on every frame including the empty one", () => {
  for (const v of [V0, V1, { ...V0, empty: true, items: [], filter: "zzz" }]) {
    const lines = frame(v, META, { caps: PLAIN });
    assert.match(lines[lines.length - 1], /\[esc\]/);
  }
});

test("confirmLine is one line naming the selection", () => {
  const c = confirmLine("google/gemini-3.5-flash-lite", glyphsFor(PLAIN), painter(PLAIN));
  assert.equal(c.includes("\n"), false);
  assert.match(c, /google\/gemini-3\.5-flash-lite/);
});

test("transitions are a fixed, bounded number of frames", () => {
  const base = frame(V1, META, { caps: PLAIN });
  assert.equal(slideFrames(base).length, 3);
  assert.equal(revealFrames(base).length, 3);
  assert.equal(flashFrames(base, 4, painter(PLAIN)).length, 4);
  for (const f of slideFrames(base)) assert.equal(f.length, base.length);
});

test("sleepSync blocks for about the requested time and returns nothing", () => {
  const t = Date.now();
  assert.equal(sleepSync(40), undefined);
  const spent = Date.now() - t;
  assert.ok(spent >= 30 && spent < 400, `slept ${spent}ms`);
});

test("slide frames measure VISIBLE width, so colour does not truncate a line", () => {
  // The transition test above builds its frame with PLAIN caps, where raw length
  // and visible length are equal -- which is exactly why it never caught this.
  // slideFrames clipped with String.slice on the RAW string, so every SGR escape
  // in a line consumed a column of the budget and the line was cut before its
  // visible end, dropping the right-hand frame character and whatever trailed it.
  //
  // The title was the worst case by an order of magnitude, because `title` paints
  // it through `p.ramp` -- one escape PER CHARACTER. Measured before the fix: 453
  // raw characters for 69 visible, clipped to 8. On screen that is a title bar
  // reading `╭─ UW ▸` and nothing else, on every descend and every esc back,
  // repaired by the next keypress because an ordinary redraw does not come
  // through here.
  const vis = (s) => [...strip(String(s))].length;
  const settled = frame(V1, META, { caps: VT });

  // The frame is only worth measuring if it actually carries colour, or this
  // test degrades into the PLAIN one above without saying so.
  assert.ok(settled.some((l) => strip(l).length !== l.length),
            "fixture carries no SGR escapes; this test would prove nothing");

  const frames = slideFrames(settled);
  for (const [n, f] of frames.entries()) {
    for (const [i, l] of f.entries()) {
      assert.ok(vis(l) <= frameWidth(VT),
                `frame ${n} line ${i} is ${vis(l)} visible columns, over the frame width`);
    }
  }
  // At rest the slide must be a no-op: the settled frame the user is left looking
  // at has to be bit-for-bit the ordinary render, not a clipped approximation.
  assert.deepEqual(frames[frames.length - 1], settled);
});

test("flat scope gets its own chrome, not the provider chrome with model rows", () => {
  // frame() keyed every branch on v.level, and tab leaves level at 0. So pressing
  // it swapped the rows to models while the title still read "providers", the
  // header still read the provider columns (`key id / models / ...`) over model data, the
  // stamp still counted providers, and each row showed a bare model id naming no
  // row the user could act on. view() has always passed scope; frame() never read
  // it. Protocol step P9 failed on exactly this.
  const flat = { ...V0, scope: "flat", filter: "gemini",
                 items: [{ kind: "model", target: "google/gemini-3.5-flash-lite",
                           model: ROWS[0].models[0], row: ROWS[0] }] };
  // 110 columns: the id column holds the whole 28-character target only once every optional cell has its room.
  const lines = frame(flat, META, { caps: { ...PLAIN, cols: 110 } }).map(strip);
  const title = lines[0], head = lines[3], row = lines[4];

  assert.doesNotMatch(title, /providers/, "the title must not claim to list providers");
  assert.match(head, /provider\/model/, "the id column must be labelled provider/model");
  assert.doesNotMatch(head, /key id/, "provider columns must not head model rows");
  assert.match(row, /google\/gemini-3\.5-flash-lite/, "the row must show the full target");
  // The footer belongs to the level whose keys are live: in flat scope enter
  // selects, so it must offer select rather than scope.
  assert.match(lines[lines.length - 1], /pick/);
});

test("the legend lists every key, including the ones with no visible affordance", () => {
  // The footer is one line inside a 78-column frame and cannot hold them all, so
  // the legend is the only complete list -- which is why the footer now reads
  // "all keys" rather than "keys".
  //
  // Typing and backspace were both missing. They are the two a user reaches for
  // first, and the filter has no visible affordance saying it accepts text, so a
  // user who opened the legend to find out how to search found every key EXCEPT
  // the one that searches.
  const lines = frame({ ...V0, legend: true }, META, { caps: PLAIN }).map(strip).join("\n");
  for (const k of ["up/down", "type to filter", "backspace", "enter", "tab",
                   "ctrl+f", "ctrl+r", "esc", "ctrl+c", "?"]) {
    assert.ok(lines.includes(k), `legend does not mention ${k}`);
  }
  assert.match(lines, /wraps/, "the legend must say the cursor wraps");
});

test("both footers point at the legend as the complete list", () => {
  // The model footer says `[?] keys`: it carries two more toggles (ctrl+o, ctrl+l) than fit
  // beside the longer wording in the 78-column frame.
  for (const [v, re] of [[V0, /all keys/], [V1, /\[\?\] keys/]]) {
    const last = strip(frame(v, META, { caps: PLAIN }).at(-1));
    assert.match(last, re, "the footer must not imply it lists them all itself");
  }
  // The provider level offers enter, which opens a provider. It used to show
  // scope but not enter, so the key that descends was undocumented on screen.
  assert.match(strip(frame(V0, META, { caps: PLAIN }).at(-1)), /open/);
});

test("the context column never overflows, so the unit is never the thing clipped", () => {
  // ctxS used to emit the raw quotient: 1048576 -> "1.048576M", nine characters
  // in a six-wide column. bar() clips from the right, so the M fell off and a
  // 1,048,576-token window rendered as `1.0485` -- indistinguishable from a
  // number in the thousands, and wrong in the direction that matters, since the
  // column exists to tell a big window from a small one. Every power-of-two
  // window was affected; the operator hit it reading a real model's window off
  // the screen during P15.
  const mk = (ctx, extra = {}) => ({ kind: "model", target: "p/m",
    model: { id: "m", ctx, pin: 0, pout: 0, badge: "", tools: 0, vision: 0, reason: 0,
             ...extra },
    row: {} });
  const V = { level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0,
              empty: false, more: 0, provider: { keyId: "p", provider: "p", models: [1] },
              items: [] };
  // DERIVED, not the literal 38 this helper used to carry. The cell begins at
  // frame character + `${mark} ` + W.id = 37, so the old window was shifted one
  // column right and silently dropped the first character of the cell. Every
  // value here was at most five wide and right-aligned, so `.trim()` hid it --
  // until a six-column value filled the cell and read as `ochat`. A test whose
  // whole subject is a cell being clipped was itself clipping the cell.
  // R16: `+ (W.prov + 1)` for the provenance gutter inserted before the id.
  // Now derived from the layout the renderer used (the id column is sized to content).
  const ctxCol = modelBadgeCol(layoutFor(frameWidth(PLAIN), { idW: 5 })) - 19;
  const cell = (ctx, extra) => {
    V.items = [mk(ctx, extra)];
    return strip(frame(V, META, { caps: PLAIN })[4]).slice(ctxCol, ctxCol + W.ctx).trim();
  };
  assert.equal(cell(1048576), "1.05M", "2^20 must keep its unit");
  assert.equal(cell(2097152), "2.1M");
  assert.equal(cell(1000000), "1M", "a round million must not gain decimals");
  assert.equal(cell(262144), "262k");
  assert.equal(cell(8192), "8k");
  assert.equal(cell(null), "");
  assert.equal(cell(100e6), "100M", "precision steps down rather than being clipped");
  for (const c of [1048576, 2097152, 1048700, 999999, 1e6, 1e9]) {
    assert.ok(cell(c).length <= W.ctx, `${c} rendered ${cell(c).length} columns`);
    if (c >= 1e6) assert.match(cell(c), /M$/, `${c} lost its unit`);
  }

  // The cell is now polymorphic, so the same guard has to cover the other shape
  // it can take. This is the test that catches a label too wide for the column --
  // the failure mode it was written for, one `M` at a time.
  //
  // A number in this cell is a lie for a row that does not emit text:
  // google/veo-2 carries 480, a video duration in SECONDS, and google/lyria
  // carries 0. Both would render as very small chat models.
  assert.equal(cell(480, { outputKind: "nontext" }), "nochat", "480 seconds is not a window");
  assert.equal(cell(0, { outputKind: "nontext" }), "nochat");
  assert.equal(cell(null, { outputKind: "nontext" }), "nochat");
  assert.ok(cell(0, { outputKind: "nontext" }).length <= W.ctx);
  // Only that one class. A chat row and an unknown row keep their real number.
  assert.equal(cell(8192, { outputKind: "text" }), "8k");
  assert.equal(cell(8192, { outputKind: null }), "8k");
});

test("a non-chat row is dimmed whole, and a chat row beside it is not", () => {
  // Two dim classes now reach the same line. They stay distinguishable without
  // any new width: the non-chat row carries `nochat` in the ctx cell, a
  // non-routable one keeps its real window, and the header stamp says whether
  // routability was resolved at all.
  //
  // Dimming a row is `p.dim(strip(body))`, which strips every inner sequence
  // first, so a dimmed row's only codes are 2 and 0. A surviving capability or
  // badge colour is exact evidence the row was left alone -- a bare search for
  // \x1b[2m cannot express that, because PAID is dim by design.
  const mk = (id, extra) => ({ kind: "model", target: `p/${id}`, row: {},
    model: { id, ctx: 8192, pin: 0, pout: 0, badge: "FREE",
             tools: true, vision: true, reason: true, routable: null, ...extra } });
  const V = { level: 1, scope: "tree", filter: "", legend: false, cursor: 9, top: 0,
              empty: false, more: 0, provider: { keyId: "p", provider: "p",
                          models: [{ id: "chat" }, { id: "pic" }, { id: "unroutable" }] },
              items: [mk("chat", { outputKind: "text" }),
                      mk("pic", { outputKind: "nontext" }),
                      mk("unroutable", { outputKind: "text", routable: false })] };
  const lines = frame(V, META, { caps: VT });
  const codes = (id) => [...lines.find((l) => strip(l).includes(` ${id}`))
    .matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);

  assert.equal(codes("chat").some((c) => c !== "2" && c !== "0"), true,
    "a selectable, routable row must keep its colours");
  assert.deepEqual([...new Set(codes("pic"))].sort(), ["0", "2"],
    "a non-chat row is dimmed whole");
  assert.deepEqual([...new Set(codes("unroutable"))].sort(), ["0", "2"],
    "a non-routable row is dimmed the same way, though it stays selectable");
  // ...and the reason is still readable off the row.
  assert.match(strip(lines.find((l) => strip(l).includes(" pic"))), /nochat/);
  assert.match(strip(lines.find((l) => strip(l).includes(" unroutable"))), /8k/);
});

// --- R16: provenance gutter, id elision, count cell, WITHHELD LIST ---------

test("the provenance dot renders five distinct states, glyph carries the state not only colour", () => {
  const g = glyphsFor(VT), p = painter(VT);
  const gA = glyphsFor(PLAIN), pA = painter(PLAIN);
  const rungs = ["call-verified", "config-asserted", "listing-verified", "catalogue-only", null];

  const glyphs = rungs.map((r) => strip(provenanceDot(r, g, p)));
  assert.equal(new Set(glyphs).size, rungs.length,
    `${glyphs.join(",")} must be five distinct glyphs`);
  for (const one of glyphs) assert.equal([...one].length, 1, "one column each");

  // The no-colour path (caps.colours === 0, every ASCII terminal): the glyph
  // alone must still carry all five states, with zero SGR codes.
  const glyphsA = rungs.map((r) => provenanceDot(r, gA, pA));
  assert.equal(new Set(glyphsA).size, rungs.length);
  assert.equal(glyphsA.join("").includes("\x1b"), false);

  // call-verified is unfed on this branch (§2.3) -- nothing produces it today.
  // This is the only check on the top of the ladder; deleting it because "no
  // row can reach it" would remove the sole guard against it silently breaking.
  assert.equal(strip(provenanceDot("call-verified", g, p)), "◆");
  assert.equal(provenanceDot("call-verified", gA, pA), "#");

  // The relay row (catalog.mjs's CONFIG_ASSERTED) must render its OWN glyph --
  // not blank, and not call-verified's diamond, even though both are green.
  assert.equal(strip(provenanceDot("config-asserted", g, p)), "◈");
  assert.notEqual(strip(provenanceDot("config-asserted", g, p)),
                   strip(provenanceDot("call-verified", g, p)));
  assert.match(provenanceDot("config-asserted", g, p), /\x1b\[36m/, "config-asserted is cyan");

  // null / unknown renders ONE blank column, not a fifth glyph competing with
  // the other four for meaning -- the header's `discovered` stamp is where
  // that disclosure lives instead (Q1.3's pattern, restated for this field).
  assert.equal(provenanceDot(null, g, p), " ");
  assert.equal(provenanceDot(undefined, g, p), " ");
});

test("null provenance renders a blank row gutter, and the header discloses discovery separately", () => {
  const mk = (provenance) => ({ kind: "model", target: "p/m",
    model: { id: "m", ctx: 8192, pin: 0, pout: 0, badge: "",
             tools: null, vision: null, reason: null, routable: null, provenance } });
  const V = { level: 1, scope: "tree", filter: "", legend: false, cursor: 9, top: 0,
              empty: false, more: 0, provider: { keyId: "p", provider: "p", models: [1] },
              items: [mk(undefined)] };
  const row = strip(frame(V, META, { caps: PLAIN }).find((l) => l.includes(" m ")));
  // Absolute column: frame char (1) + mark-and-space (2) puts the gutter at 3.
  assert.equal(row[3], " ", "unknown provenance leaves the gutter blank, not a glyph");

  const relay = strip(frame({ ...V, items: [mk("config-asserted")] }, META,
    { caps: PLAIN }).find((l) => l.includes(" m ")));
  assert.equal(relay[3], "=", "config-asserted renders its own glyph, not blank");

  // The row staying blank is a different claim from "nobody has ever looked" --
  // the header's own stamp is the disclosure for the LATTER. On the MODEL
  // level header (beside `N of M`), not level 0's -- the plan is explicit that
  // level 0 is unchanged, already carrying four segments at 78 columns.
  // The bench stamp is the short one here (`benched MM-DD HH:MM`), so the discovered stamp
  // still fits beside it at 78 columns; with no bench data the longer hint wins the room.
  const withBench = { ...META, benchAsOf: "2026-09-29T10:39:05.361Z" };
  const noStamp = stampLine(frame(V, { ...withBench, discoveredAsOf: null }, { caps: PLAIN }));
  assert.match(noStamp, /discovered -/, "absent discovery data renders a dash, not silence");
  const stamped = stampLine(frame(V,
    { ...withBench, discoveredAsOf: "2026-09-07T13:37:38.115Z" }, { caps: PLAIN }));
  assert.match(stamped, /discovered 09-07 13:37/);
  // Level 0 stays exactly as before this task: no discoveredStamp appended.
  const level0 = stampLine(frame(V0,
    { ...META, discoveredAsOf: "2026-09-07T13:37:38.115Z" }, { caps: PLAIN }));
  assert.doesNotMatch(level0, /discovered/, "level 0's header is unchanged by this task");

  // Flat scope is a MODEL-level view too -- its rows run `provenanceDot`
  // exactly like level 1's, so the same disclosure applies. Missing this
  // left flat scope rendering blank gutters with nothing on screen saying
  // why -- the one branch that shows the thing being disclosed and skips
  // the stamp that discloses it.
  const flatV = { ...V1, scope: "flat",
    items: [{ kind: "model", target: "google/gemini-3.5-flash-lite", model: ROWS[0].models[0] }] };
  const flatHeader = stampLine(frame(flatV,
    { ...META, benchAsOf: "2026-09-29T10:39:05.361Z", discoveredAsOf: "2026-09-07T13:37:38.115Z" },
    { caps: PLAIN }));
  assert.match(flatHeader, /discovered 09-07 13:37/, "flat scope must disclose discovery too");
});

test("the discovered stamp is dropped whole, never clipped, when the id line is long; back in full when it fits", () => {
  // The stamps sit at the right end of the `id:` line and use only what the selected id leaves free:
  // the fullest candidate that fits, else the next, else none. Never a fragment.
  const bigMeta = { providers: 13, models: 1588, routableAsOf: "2026-09-07T13:37:38.115Z",
                    discoveredAsOf: "2026-09-07T13:37:38.115Z", benchAsOf: "2026-09-29T10:39:05.361Z" };
  const V = { level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false, more: 0,
              provider: { keyId: "p", provider: "p", models: new Array(1588).fill(1) }, items: [],
              fullId: "an-id-that-is-forty-characters-long-xxx" };
  const at78 = frame(V, bigMeta, { caps: PLAIN });
  for (const l of at78) assert.equal(cps(strip(l)), FRAME_W);
  const row = stampLine(at78);
  assert.match(row, /benched 09-29 10:39Z\s*\|$/, "the bench stamp is whole and right-aligned");
  assert.doesNotMatch(row, /discovered/, "and the stamp that would not fit is dropped, not mangled");
  const wide = stampLine(frame(V, bigMeta, { caps: { ...PLAIN, cols: 134 } }));
  assert.match(wide, /benched 09-29 10:39Z \| discovered 09-07 13:37Z\s*\|$/, "in full once there is room");
});

test("padId elides the MIDDLE, so ids sharing a long prefix keep their distinguishing suffix", () => {
  // MEASURED against the real 4,732-model catalogue (see style.mjs's own
  // comment on padId): right-truncating at the old W.id collided 33 rows into
  // 16 groups, and even at the new width, 21 into 10. This is the synthetic,
  // permanent version of that measurement -- two ids differing only after the
  // width where right-truncation would have cut them.
  const g = glyphsFor(PLAIN), p = painter(PLAIN);
  const a = "provider-shared-prefix-AAAA-2024-01-15";
  const b = "provider-shared-prefix-AAAA-2024-06-30";
  const n = 20;
  assert.equal(a.slice(0, n), b.slice(0, n),
    "sanity: the two ids share exactly this much of a common prefix");

  const outA = padId(a, n, "", g, p), outB = padId(b, n, "", g, p);
  assert.equal([...outA].length, n);
  assert.equal([...outB].length, n);
  assert.notEqual(outA, outB, "the differing suffix must survive elision");
});

test("a filter match inside the elided middle still shows, on the marker itself (#49)", () => {
  // The previous draft ran `highlight` against the already-truncated text, so a
  // match living in the dropped tail vanished with no visible trace -- the row
  // still passed the filter (pick-state.mjs matches the FULL id) but nothing on
  // screen explained why it was there. When the match falls entirely inside the
  // elided middle, the marker renders a DISTINCT GLYPH, not merely a colour.
  const id = "provider-shared-prefix-AAAA-HIDDEN-2024-01-15-suffix";
  const n = 20;

  const g = glyphsFor(VT), p = painter(VT);
  const out = padId(id, n, "HIDDEN", g, p);
  assert.equal([...strip(out)].length, n);
  assert.equal(strip(out).includes("HIDDEN"), false,
    "the match's own text is in the elided middle, not on screen");
  assert.equal(strip(out).includes("‡"), true, "the marker itself carries the distinct glyph");
  assert.match(out, /\x1b\[1m‡\x1b\[0m/, "the glyph is also bolded, as an enhancement");

  // The no-colour path (every ASCII terminal, `caps.colours === 0`): `p.bold`
  // is a no-op there, so if the state lived in colour alone this would render
  // an ordinary `-`, indistinguishable from an unfiltered row. The glyph
  // alone must still carry it.
  const gA = glyphsFor(PLAIN), pA = painter(PLAIN);
  const outA = padId(id, n, "HIDDEN", gA, pA);
  assert.equal(outA.includes("\x1b"), false);
  assert.equal(outA.includes("!"), true, "ASCII's distinct middle-match glyph, no colour needed");
  const outAUnmatched = padId(id, n, "", gA, pA);
  assert.notEqual(outA, outAUnmatched, "a matched middle must render differently from an unmatched one");
});

test("padId highlights a match that survives in the head or tail, same as any other cell", () => {
  const g = glyphsFor(VT), p = painter(VT);
  const short = "gemini-3.5-flash-lite";
  const out = padId(short, 37, "flash", g, p);
  assert.match(strip(out), /gemini-3\.5-flash-lite/);
  assert.match(out, /\x1b\[1mflash\x1b\[0m/);
});

test("padId never signals a middle match for a query that matches nothing (N5)", () => {
  // The containment check (`hasMatch`) guards the whole decision now. Without
  // it, `!inHead && !inTail` is true for ANY query absent from the id, not
  // just one hiding in the elided middle -- a positive "it's in the middle"
  // claim for a string that is not in the id anywhere. Unreachable from
  // `frame()` today (rows are pre-filtered on this same string at both level
  // 1 and flat), but `padId` is exported and this is hygiene on the function
  // itself, not a fixture-only concern.
  const g = glyphsFor(VT), p = painter(VT);
  const id = "provider-shared-prefix-AAAA-HIDDEN-2024-01-15-suffix";
  const out = padId(id, 20, "ZZNOMATCH", g, p);
  assert.equal(out.includes("\x1b"), false, "no query match means no highlight and no bold marker");
  assert.equal(strip(out).includes("‡"), false, "and no distinct match glyph either");
});

test("a match straddling the head/middle or middle/tail boundary still bolds the marker (#49 regression)", () => {
  // The first fix computed inHead/inTail from where the match STARTS and ENDS
  // in the full string. A match that starts in the head but runs into the
  // elided middle set inHead = true (no bold), while `highlight(head, ...)` --
  // which looks for the query as a whole SUBSTRING of head -- found nothing
  // there: the marker stayed plain AND the highlight vanished, leaving the row
  // blind. Checking CONTAINMENT in head/tail, the same test `highlight` itself
  // makes, is what closes both straddling directions.
  const g = glyphsFor(VT), p = painter(VT);
  const id = "provider-shared-prefixAAAA-HIDDEN-2024-01-15-suffix";
  const n = 20;
  for (const q of ["der-shared", "01-15-suf"]) {
    const out = padId(id, n, q, g, p);
    const s = strip(out);
    assert.equal([...s].length, n);
    assert.equal(s.toLowerCase().includes(q.toLowerCase()), false,
      `"${q}" straddles a boundary and must not appear whole on screen`);
    assert.equal(s.includes("‡"), true,
      `"${q}" straddles a boundary, so the marker must show the distinct match glyph`);
  }
});

test("the count cell is bare with nothing withheld, paired when something is, and never a plausible-wrong truncation", () => {
  // #51 (§2.5(a)), revision 11. A provider withholding nothing renders the bare
  // count -- never `343/0` -- because the count itself is never suppressed.
  assert.equal(countCell(343, 0), "343");
  assert.equal(countCell(343, undefined), "343");
  assert.equal(countCell(343, 5), "343/5");
  assert.equal(countCell(120, 30, 7), "120/30", "a pair that fits exactly stays exact");

  // `sanitizeDisplay("1501/1501", 7)` would return "1501/15" -- a PLAUSIBLE
  // WRONG PAIR, worse than truncation because nothing about it looks wrong.
  // A single decimal of abbreviation is not always enough to reach 7 columns
  // either: `1.5k/1.5k` is nine. Dropping the decimal only on that second
  // attempt reaches `2k/2k` without losing precision on the common case.
  assert.equal(countCell(1501, 1501, 7), "2k/2k",
    "a pair too wide even at one decimal steps down to integer-k");
  assert.notEqual(countCell(1501, 1501, 7), "1501/15", "never the truncated lie");

  // Six-digit-plus counts on both sides abbreviate to something still too
  // wide at any k-precision (MEASURED max real count today: 434, one
  // provider) -- CORRECT must beat TRUNCATED even past `width` here: the
  // function returns the honest exact pair rather than cut digits.
  assert.equal(countCell(100000, 100000, 7), "big/big",
    "unabbreviatable-to-width falls back to `big`: honest, and never wider than the cell");
  assert.equal(countCell(469, 100, 7), "469/100", "the worst real pair fits the 7-wide cell exactly");
  assert.equal(countCell(12345, 12345, 7), "12k/12k");
  for (const [t, r] of [[1, 1], [469, 100], [1501, 1501], [12345, 99999], [99999, 99999], [100000, 100000], [5e6, 7e6]]) assert.ok(countCell(t, r, 7).length <= 7, `${t}/${r}`);
});

test("the count cell's honest overflow survives all the way to the rendered row, not just the function's return", () => {
  // The plan's own words: this must be asserted on the RENDERED STRING, not
  // width alone (plans/model-discovery-resolver-plan.md:3419-3422) -- a
  // function-level assertion alone would have passed while `rpad` truncated
  // the very overflow this cell exists to render honestly.
  const wide = { ...ROWS[0], refused: new Array(1501).fill({ id: "x" }),
                 models: new Array(1501).fill(ROWS[0].models[0]) };
  const V = { ...V0, items: [{ kind: "provider", row: wide }] };
  const row = strip(frame(V, { ...META, rows: ROWS }, { caps: PLAIN }).find((l) => l.includes("2k/2k")));
  assert.match(row, /2k\/2k/, "the abbreviated pair must reach the actual rendered row");
  assert.doesNotMatch(row, /1501\/15\D/, "never the width-truncated plausible-wrong pair");
});

test("style.mjs renders a real WITHHELD LIST v.items member, with no knowledge of provider.refused", () => {
  // R18: the row is now a genuine, cursor-reachable `v.items` member that
  // `pick-state.mjs` places and sizes `rowsAvail` for like any other row --
  // R16's item-trim mitigation (needed only while this row was a static
  // addition OUTSIDE `v.items`) is retired along with it. `frame()` no
  // longer reads `v.provider.refused` at all; it renders whatever `v.items`
  // hands it. Whether the row appears, and where, is `pick-state.mjs`'s
  // decision now -- covered in `test/pick-state.test.mjs`, not here.
  const V = { ...V1, items: [{ kind: "withheld-list", count: 3 }, ...V1.items] };
  const lines = frame(V, META, { caps: PLAIN }).map(strip);
  assert.ok(lines.some((l) => l.includes("WITHHELD LIST (3)")),
    "a withheld-list item in v.items must render with its own count");

  // Selectable and markable like any other row -- the cursor can land on it.
  const selected = frame({ ...V, cursor: 0 }, META, { caps: VT })
    .map(strip).find((l) => l.includes("WITHHELD LIST"));
  assert.match(selected, /▶/, "the cursor must be able to mark this row");

  // Dimmed, matching the file's existing WITHHELD wording and dim styling.
  const row = frame({ ...V, cursor: 9 }, META, { caps: VT }).find((l) => l.includes("WITHHELD LIST"));
  assert.match(row, /\x1b\[2m/, "the row is dimmed like the rest of this file's informational rows");
});

// --- R18: the refusal drill-in overlay --------------------------------------

const V_REFUSALS = { level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0,
  empty: false, provider: ROWS[0], more: 0, items: [],
  refusals: { provider: "personal.acme.free", top: 0,
    items: [{ id: "bad-model", reason: "cap-exceeded", removed: 0 }], total: 1 } };

test("the overlay is a full-screen modal, an early return like the legend, wording WITHHELD not BLOCKED", () => {
  const lines = frame(V_REFUSALS, META, { caps: PLAIN }).map(strip);
  assert.match(lines[0], /WITHHELD/);
  assert.doesNotMatch(lines.join("\n"), /BLOCKED/i, "§2.5(c): the wording is WITHHELD, never BLOCKED");
  assert.match(lines.join("\n"), /bad-model/);
  assert.match(lines.join("\n"), /cap-exceeded/);
});

test("every overlay line measures exactly FRAME_W, including at the 128-code-point id limit", () => {
  const longId = "x".repeat(128);
  const V = { ...V_REFUSALS,
    refusals: { ...V_REFUSALS.refusals,
      items: [{ id: longId, reason: "too-long", removed: 5 }], total: 1 } };
  for (const caps of [VT, PLAIN]) {
    for (const l of frame(V, META, { caps })) {
      assert.equal([...strip(l)].length, frameWidth(caps), `caps ${caps.colours}: ${strip(l)}`);
    }
  }
});

test("the load-bearing security test: a hostile id and a bidi override render with no escape sequence and no override reaching the frame", () => {
  // Mirrors the existing "escape sequences in a model id cannot reach the
  // frame" test -- this is the one place in the product where a hostile
  // string is DELIBERATELY displayed. Asserted against the RENDERED STRING,
  // not against the sanitiser, and defence in depth over what
  // `denylist.mjs`'s `refusal()` already did upstream (§2.5): if this pass is
  // ever the ONLY thing standing between a hostile id and the terminal, R17
  // has regressed and #52 is open again.
  const V = { ...V_REFUSALS,
    refusals: { ...V_REFUSALS.refusals,
      items: [
        { id: "\x1b[2Jclear-screen", reason: "escape-sequence", removed: 6 },
        { id: "evil\u202Ereversed", reason: "invisible", removed: 1 },
      ], total: 2 } };
  const out = frame(V, META, { caps: VT }).join("\n");
  assert.equal(out.includes("\x1b[2J"), false, "the escape sequence itself must never reach the frame");
  assert.equal(out.includes("\u202E"), false, "the bidi override must never reach the frame");
  assert.match(strip(out), /clear-screen/, "the harmless remainder of the id still renders");
  assert.match(strip(out), /evilreversed/);
});

test("the overlay's header names the withheld total and the visible page, and the column header names its three fields", () => {
  const many = { ...V_REFUSALS.refusals,
    items: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, reason: "cap-exceeded", removed: 0 })),
    top: 5, total: 30 };
  const lines = frame({ ...V_REFUSALS, refusals: many }, META, { caps: PLAIN }).map(strip);
  assert.match(lines[1], /30 withheld/);
  assert.match(lines[1], /6-10 of 30/, "1-based, current page, against the real total");
  assert.match(lines.join("\n"), /\bid\b/);
  assert.match(lines.join("\n"), /reason/);
  assert.match(lines.join("\n"), /removed/);
});

test("the overlay's footer says how to close it, distinctly from the tree/flat footers", () => {
  const lines = frame(V_REFUSALS, META, { caps: PLAIN }).map(strip);
  assert.match(lines.at(-1), /scroll/);
  assert.match(lines.at(-1), /close/);
});

test("an empty refused page (all withheld already shown) renders no rows and no crash", () => {
  const V = { ...V_REFUSALS, refusals: { ...V_REFUSALS.refusals, items: [], total: 0 } };
  const lines = frame(V, META, { caps: PLAIN });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.equal([...strip(l)].length, FRAME_W);
});

// --- R18: #60, the capped-recents disclosure --------------------------------

test("a hidden-recents count renders \"... N more recents\" right after the pinned block, and is silent at zero", () => {
  const withPins = { ...V0,
    items: [{ kind: "pinned", target: "google/gemini-3.5-flash-lite", mark: "~" }, ...V0.items],
    recentsHidden: 4 };
  const lines = frame(withPins, META, { caps: PLAIN }).map(strip);
  const pinnedIdx = lines.findIndex((l) => l.includes("gemini-3.5-flash-lite"));
  assert.match(lines[pinnedIdx + 1], /4 more recents/,
    "the disclosure must sit immediately after the pinned block");

  const zero = frame({ ...withPins, recentsHidden: 0 }, META, { caps: PLAIN }).map(strip);
  assert.ok(zero.every((l) => !l.includes("more recents")), "must not read \"0 more recents\"");

  // Absent entirely without any pinned rows to disclose, even if the count
  // were somehow nonzero -- there is no pinned block to sit "immediately
  // after".
  const noPins = frame({ ...V0, recentsHidden: 4 }, META, { caps: PLAIN }).map(strip);
  assert.ok(noPins.every((l) => !l.includes("more recents")));

  // Not level 0, not this disclosure: flat and level 1 never show it.
  const flatV = { ...withPins, scope: "flat",
    items: [{ kind: "model", target: "google/gemini-3.5-flash-lite", model: ROWS[0].models[0] }] };
  assert.ok(frame(flatV, META, { caps: PLAIN }).map(strip).every((l) => !l.includes("more recents")));
});

test("the recents disclosure is suppressed while a filter is active (M4)", () => {
  // `recentsHidden` is computed ONCE in `initState`, over the UNFILTERED
  // recents list -- it does not shrink as `v.filter` narrows `v.items`.
  // Rendering it under an active filter would claim "N more recents" exist
  // below when the true count matching THIS filter could be anywhere from 0
  // to N -- an unfiltered number attached to a filtered view, the exact
  // failure shape [[counts-carry-their-denominator]] exists to catch. Hidden
  // under a filter is fine (same rule as the WITHHELD LIST row, §2.5(b)); a
  // wrong claim is not.
  const withPins = { ...V0, filter: "flash",
    items: [{ kind: "pinned", target: "google/gemini-3.5-flash-lite", mark: "~" }, ...V0.items],
    recentsHidden: 4 };
  const lines = frame(withPins, META, { caps: PLAIN }).map(strip);
  assert.ok(lines.every((l) => !l.includes("more recents")),
    "the disclosure must not render while v.filter is non-empty");

  // And it returns the instant the filter clears.
  const cleared = frame({ ...withPins, filter: "" }, META, { caps: PLAIN }).map(strip);
  assert.ok(cleared.some((l) => l.includes("4 more recents")));
});

test("the recents disclosure is distinct wording from the bottom overflow line, so the two truncations are never confused", () => {
  const V = { ...V0,
    items: [{ kind: "pinned", target: "google/gemini-3.5-flash-lite", mark: "~" }, ...V0.items],
    recentsHidden: 2, more: 7 };
  const lines = frame(V, META, { caps: PLAIN }).map(strip);
  assert.ok(lines.some((l) => l.includes("2 more recents")));
  assert.ok(lines.some((l) => l.includes("7 more") && !l.includes("7 more recents")),
    "the bottom overflow line must read plain \"more\", never \"more recents\"");
});

// --- level 0's removed columns (#114 redesign) -------------------------------

test("level 0 has no limit or needs-$ column at any width (they were removed with the health column)", () => {
  for (const cols of [80, 100, 134, 240]) {
    const lines = frame(V0, META, { caps: { ...PLAIN, cols } }).map(strip);
    assert.ok(!lines.some((l) => /limit|needs \$|skip/.test(l)), `cols ${cols}`);
    assert.equal(lines.join("").includes("\x1b"), false, "nothing is clipped, so no reset escape leaks into a colourless render");
  }
  const at = (cols) => frame(V0, META, { caps: { ...PLAIN, cols } }).map(strip).some((l) => l.includes("free") && l.includes("key id"));
  assert.equal(at(116), false, "the free column needs the full 30-character key id plus oldest probe (13) plus 10: a 117-column terminal");
  assert.equal(at(117), true);
});



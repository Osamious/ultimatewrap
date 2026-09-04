import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps, motionEnabled, glyphsFor, painter, badgeColour, proportionBar,
         healthDot, highlight, frame, confirmLine, sleepSync,
         slideFrames, flashFrames, revealFrames, FRAME_W, W } from "../menu/style.mjs";

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

test("the proportion bar reads at a glance and never lies about missing data", () => {
  const g = glyphsFor(VT);
  // Width is W.bar (6), the same constant the header reserves, so the bar and its
  // header cell cannot drift apart. The previous default of 5 was one narrower
  // than the header, which misaligned every column from `free` rightward.
  assert.equal(proportionBar(0, 12, g).length, W.bar);
  assert.equal(proportionBar(0, 12, g), "▱▱▱▱▱▱");
  assert.equal(proportionBar(12, 12, g), "▰▰▰▰▰▰");
  assert.equal(proportionBar(6, 12, g), "▰▰▰▱▱▱");
  assert.equal(proportionBar(1, 324, g), "▰▱▱▱▱▱");   // any non-zero free shows one block
  assert.equal(proportionBar(null, 12, g), " ".repeat(W.bar)); // no price data: no bar
  assert.equal(proportionBar(0, 0, g), " ".repeat(W.bar));
  assert.equal(proportionBar(6, 12, glyphsFor(PLAIN)), "###...");
});

test("the health dot carries the state in the glyph as well as the colour", () => {
  const g = glyphsFor(VT), p = painter(VT);
  const gA = glyphsFor(PLAIN), pA = painter(PLAIN);
  // Four states, four distinct glyphs, in BOTH glyph sets and with colour off.
  // This is the assertion the previous version of this test claimed to make and
  // then contradicted: it asserted healthDot("ok") and healthDot("broken") both
  // strip to "●", which is the defect, not the requirement.
  const states = ["ok", "needs $", "broken", "stale"];
  for (const [gl, pt, name] of [[g, p, "unicode"], [gA, pA, "ascii"]]) {
    const glyphs = states.map((s) => strip(healthDot(s, gl, pt)));
    assert.equal(new Set(glyphs).size, states.length,
      `${name}: ${glyphs.join(",")} must be four distinct glyphs`);
    for (const one of glyphs) assert.equal([...one].length, 1, `${name}: one column each`);
  }
  assert.equal(strip(healthDot("ok", g, p)), "●");
  assert.equal(strip(healthDot("broken", g, p)), "✖");
  assert.equal(strip(healthDot("needs $", g, p)), "◐");
  assert.equal(strip(healthDot("stale", g, p)), "○");
  assert.equal(healthDot("ok", gA, pA), "*");
  assert.equal(healthDot("broken", gA, pA), "x");
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
  const lines = frame(V0, META, { caps: PLAIN });
  const row = lines.find((l) => l.includes("personal.google.free"));
  assert.equal(row,
    // GENERATED by running the renderer against ROWS[0], not transcribed from the
    // mock. Count is r.models.length = 2; bar is proportionBar(1, 2) = "###...";
    // free text is "1". Verified at 78 code points.
    "|> personal.google.free" + " ".repeat(16) + "2" + " ".repeat(3) + "###..." +
    " " + "1" + " ".repeat(10) + "* ok" + " ".repeat(12) + "|");
});

test("level 1 renders the exact model row, columns included", () => {
  const lines = frame(V1, META, { caps: PLAIN });
  const row = lines.find((l) => l.includes("gemini-3.5-flash-lite"));
  assert.equal(row,
    "|> gemini-3.5-flash-lite" + " ".repeat(17) + "1M" + " ".repeat(4) + "0.00" +
    " ".repeat(3) + "0.00" + "  " + "FREE" + "  " + "TVR" + " ".repeat(8) + "|");
});

test("every column begins where the W constants say it begins", () => {
  // Derived, not transcribed: this is what makes the literals above checkable
  // rather than merely self-consistent. If a cell width changes, this fails and
  // names the column; if the header and the row drift apart, this fails too.
  const l0 = frame(V0, META, { caps: PLAIN }).find((l) => l.includes("personal.google.free"));
  const h0 = frame(V0, META, { caps: PLAIN }).find((l) => l.includes("key id"));
  const barCol    = 1 + 2 + W.keyId + W.count + 3;
  const healthCol = barCol + W.bar + 1 + (W.free - 1) + 2;
  // Derived from the fixture, not a saturated literal. ROWS[0] is 1 free of 2
  // models, so its bar is "###..." -- searching for "######" finds nothing and
  // reports -1. That literal survived from the draft where this row read
  // `free: 3`, which the fixture comment above records fixing.
  const bar0 = proportionBar(ROWS[0].free, ROWS[0].models.length, glyphsFor(PLAIN));
  assert.equal(strip(l0).indexOf(bar0), barCol, "proportion bar column");
  assert.equal(strip(l0).indexOf("ok", healthCol - 1), healthCol, "health label column");
  assert.equal(strip(h0).indexOf("free"), barCol, "the `free` header sits over the bar");
  assert.equal(strip(h0).indexOf("health"), healthCol, "the `health` header sits over the label");

  const l1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("gemini-3.5-flash-lite"));
  const h1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("model "));
  const badgeCol = 1 + 2 + W.id + W.ctx + 1 + W.price * 2 + 2;
  assert.equal(strip(l1).indexOf("FREE"), badgeCol, "badge column");
  assert.equal(strip(l1).indexOf("TVR"), badgeCol + W.badge, "caps column");
  assert.equal(strip(h1).indexOf("badge"), badgeCol);
  assert.equal(strip(h1).indexOf("TVR"), badgeCol + W.badge);
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
  const badgeCol = 1 + 2 + W.id + W.ctx + 1 + W.price * 2 + 2;
  assert.equal(s.slice(badgeCol, badgeCol + W.badge), "FREE  ");
  assert.equal(s.indexOf("TVR"), badgeCol + W.badge);
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

test("every line of every frame is exactly FRAME_W visible columns", () => {
  for (const v of [V0, V1, { ...V0, empty: true, items: [], filter: "zzz" },
                   { ...V0, legend: true }]) {
    for (const caps of [VT, PLAIN]) {
      for (const l of frame(v, META, { caps })) {
        // Code points, the same measure style.mjs pads with. Using .length here
        // would let an astral row pass this test while rendering short.
        const w = [...strip(l)].length;
        assert.equal(w, FRAME_W, `width ${w}: ${strip(l)}`);
      }
    }
  }
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

test("the longest health label is not clipped", () => {
  // "needs $" is 7 characters. The previous draft padded the label to
  // W.health - 2 = 6 and rendered "needs " -- while the frozen ASCII mock in this
  // task showed "* needs $" in full, so the mock and the code disagreed.
  const v = { ...V0, items: [{ kind: "provider", row: {
    keyId: "personal.acme.paid", provider: "acme", free: 0, planCount: 0,
    health: "needs $", models: [{ id: "a", routable: null }] } }] };
  const row = frame(v, META, { caps: PLAIN }).find((l) => l.includes("personal.acme.paid"));
  assert.match(strip(row), /needs \$/);
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
      assert.ok(vis(l) <= FRAME_W,
                `frame ${n} line ${i} is ${vis(l)} visible columns, over FRAME_W`);
    }
  }
  // At rest the slide must be a no-op: the settled frame the user is left looking
  // at has to be bit-for-bit the ordinary render, not a clipped approximation.
  assert.deepEqual(frames[frames.length - 1], settled);
});

test("flat scope gets its own chrome, not the provider chrome with model rows", () => {
  // frame() keyed every branch on v.level, and tab leaves level at 0. So pressing
  // it swapped the rows to models while the title still read "providers", the
  // header still read `key id / models / free / health` over model data, the
  // stamp still counted providers, and each row showed a bare model id naming no
  // row the user could act on. view() has always passed scope; frame() never read
  // it. Protocol step P9 failed on exactly this.
  const flat = { ...V0, scope: "flat", filter: "gemini",
                 items: [{ kind: "model", target: "google/gemini-3.5-flash-lite",
                           model: ROWS[0].models[0], row: ROWS[0] }] };
  const lines = frame(flat, META, { caps: PLAIN }).map(strip);
  const title = lines[0], head = lines[3], row = lines[4];

  assert.doesNotMatch(title, /providers/, "the title must not claim to list providers");
  assert.match(head, /provider\/model/, "the id column must be labelled provider/model");
  assert.doesNotMatch(head, /key id/, "provider columns must not head model rows");
  assert.match(row, /google\/gemini-3\.5-flash-lite/, "the row must show the full target");
  // The footer belongs to the level whose keys are live: in flat scope enter
  // selects, so it must offer select rather than scope.
  assert.match(lines[lines.length - 1], /select/);
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
  for (const k of ["up / down", "type to filter", "backspace", "enter", "tab",
                   "ctrl+f", "esc", "ctrl+c", "?"]) {
    assert.ok(lines.includes(k), `legend does not mention ${k}`);
  }
  assert.match(lines, /wraps/, "the legend must say the cursor wraps");
});

test("both footers point at the legend as the complete list", () => {
  for (const v of [V0, V1]) {
    const last = strip(frame(v, META, { caps: PLAIN }).at(-1));
    assert.match(last, /all keys/, "the footer must not imply it lists them all itself");
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
  const mk = (ctx) => ({ kind: "model", target: "p/m",
    model: { id: "m", ctx, pin: 0, pout: 0, badge: "", tools: 0, vision: 0, reason: 0 },
    row: {} });
  const V = { level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0,
              empty: false, more: 0, provider: { keyId: "p", provider: "p", models: [1] },
              items: [] };
  const cell = (ctx) => {
    V.items = [mk(ctx)];
    return strip(frame(V, META, { caps: PLAIN })[4]).slice(38, 38 + W.ctx).trim();
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
});

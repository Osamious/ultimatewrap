// The `?` page: five sections (KEYS, PROVIDER LIST, MODEL LIST, STAMPS, PROBES), each an aligned `term  meaning` list,
// terms in the colours they have in the picker, every line inside the narrowest frame.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legendLines, LEGEND_LENGTH, LINE_MAX } from "../menu/legend.mjs";
import { detectCaps, painter, glyphsFor, provenanceDot, frame, frameWidth, layoutFor, FRAME_MIN, modalityHue } from "../menu/style.mjs";
import { MODALITY_WORDS, MODALITY_COLOURS } from "../menu/modality.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const NL = "\n";
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const build = (env, colours = 256) => {
  const caps = { ...detectCaps(env, 100), colours: env === ASCII ? 0 : colours };
  const g = glyphsFor(caps), p = painter(caps);
  return legendLines(g, p, { provenanceDot,
    modality: (w) => (MODALITY_WORDS.includes(w) ? p.raw(modalityHue(w, p), w) : w),
    stat: (c) => c });
};

test("five sections, in order, each opened by a heading rule and separated by exactly one blank line", () => {
  for (const env of [UNI, ASCII]) {
    const lines = build(env, 0).map(strip);
    const heads = ["KEYS", "PROVIDER LIST", "MODEL LIST", "STAMPS", "PROBES"];
    const at = heads.map((h) => lines.findIndex((l) => l.includes(` ${h} `) && /^(──|--)/.test(l)));
    assert.ok(at.every((i) => i >= 0), `headings present (${env === UNI ? "unicode" : "ascii"}): ${at}`);
    assert.deepEqual([...at].sort((a, b) => a - b), at, "in the stated order");
    assert.equal(at[0], 0, "the page opens with a heading");
    for (const i of at.slice(1)) {
      assert.equal(lines[i - 1], "", "one blank line before a heading");
      assert.notEqual(lines[i - 2], "", "and only one");
    }
    assert.ok(lines[at[0]].startsWith(env === UNI ? "──" : "--"));
  }
});

test("no legend line is wider than LINE_MAX, and every legend screen fits the frame exactly, at 40..400 columns, in both glyph sets", () => {
  for (const env of [UNI, ASCII]) for (const l of build(env)) assert.ok(cps(strip(l)) <= LINE_MAX, `${cps(strip(l))}: ${strip(l)}`);
  assert.ok(LINE_MAX + 3 <= FRAME_MIN, "it fits the narrowest frame (78) with the frame's own 3 columns");
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok", models: [{ id: "m0" }] }];
  for (const env of [UNI, ASCII]) for (const cols of [40, 78, 80, 100, 134, 240, 400]) {
    const caps = detectCaps(env, cols);
    for (const termRows of [10, 24, 50]) {
      const v = view({ ...initState(rows, { termRows }), legend: true });
      for (const l of frame(v, { providers: 1, models: 1 }, { caps })) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
      assert.ok(frame(v, { providers: 1, models: 1 }, { caps }).length <= Math.max(termRows, 10), `height at ${termRows} rows`);
    }
  }
});

test("the ASCII legend has no non-ASCII character, and no escape code with colour off", () => {
  const text = build(ASCII).join(NL);
  assert.equal(/[^\x00-\x7f]/.test(text), false, text.match(/[^\x00-\x7f]/)?.[0]);
  assert.equal(/\x1b/.test(text), false);
  assert.equal(/\x1b/.test(build(UNI, 0).join(NL)), false, "colour off: no escape codes even on a Unicode terminal");
});

test("every column the pickers name in their headers is explained on the page (the header cells come from the renderer)", () => {
  const text = build(UNI, 0).map(strip).join(NL);
  // Terms: the first cell of every legend entry (`  term   meaning`), split on spaces too (`$in $out`).
  const terms = new Set();
  for (const l of text.split(NL)) {
    const m = /^ {2}(\S.*?) {2,}\S/.exec(l) ?? /^ {2}(\S+) \S/.exec(l) ?? /^ {2}(\S+)$/.exec(l);
    if (m) { terms.add(m[1]); for (const w of m[1].split(" ")) terms.add(w); }
  }
  const rows = [{ keyId: "personal.p.free", provider: "p", free: 1, planCount: 0, health: "ok",
    models: [{ id: "m0", ctx: 1, pin: 0, pout: 0, badge: "", tools: true, vision: true, reason: true, routable: true }],
    bench: { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 }, benchFlags: { status: "alive" } }];
  const headerCells = (v, env, cols) => {
    const S = env === ASCII ? ":" : "┆";
    const head = frame(v, { providers: 1, models: 1, rows, keyIdW: 20, benchOf: () => null }, { caps: detectCaps(env, cols) })
      .map(strip).find((l) => l.includes(S) && /(key id|stat)/.test(l));
    return head.replace(/^[│|]/, "").replace(/[│|]\s*$/, "").split(S).map((c) => c.trim()).filter(Boolean);
  };
  const st = initState(rows, { nowMs: Date.now() });
  const l1 = { ...st, level: 1, provider: rows[0] };
  const flat = reduce(st, "\t").state;
  const cells = new Set();
  for (const env of [UNI, ASCII]) for (const v of [view(st), view(l1), view(flat)]) headerCells(v, env, 240).forEach((c) => cells.add(c));
  assert.ok(cells.size >= 20, "the renderer's headers: " + [...cells].join(" | "));
  for (const c of cells) assert.ok(terms.has(c) || terms.has(c.split(" ")[0]), `the legend has no entry for the header cell "${c}"`);
  for (const w of ["alive", "down", "dead", "gutter", "reply:", "id:", "N of M"]) assert.ok(text.includes(w), w);
  assert.match(text, /never narrower than 78/);
  assert.equal(/14 days|14-day/.test(text), false, "the 14-day cutoff is gone from the legend");
  assert.match(text, /outdated\s+a yellow line just above the footer/);
  assert.match(text.replace(/\s+/g, " "), /more than 7 days old/);
  assert.equal(/91-column|89-column/.test(text), false, "the old free threshold is gone (it now follows the key id width)");
  // "All show from N columns": N is layoutFor's own answer for long ids, not a hand-copied number
  const n = Number(/All show from (\d+) columns/.exec(text)?.[1]);
  let first = null;
  for (let w = FRAME_MIN; w <= 260 && first === null; w++) { const L = layoutFor(w, { idW: 40 }); if (L.showTotal && L.showTps && L.showPreview) first = w + 2; }
  assert.equal(n, first, "the legend's all-columns width is layoutFor's");
});

test("the legend states what the percent and the free / models cells count, and the keys, exactly", () => {
  const text = build(UNI, 0).map(strip).join(NL).replace(/\s+/g, " ");
  assert.match(text, /% = ok \/ models normally; % = ok \/ \(models - gone\) while \[no gone\] is on/, "both denominators, in the same sentence as the percent");
  assert.match(text, /P = ok \/ models normally and ok \/ \(models - gone\) while \[no gone\] is on/, "the header percent's denominators");
  assert.match(text, /Beside free: always of all models/, "free % is never changed by the toggle");
  assert.equal(/routes marked gone are not counted/.test(text), false, "the always-on wording is gone");
  assert.match(text, /models badged FREE or FREE\? when the catalogue was read, and their share of ALL models \(never changed by \[no gone\]\); blank when the provider has no price data/);
  assert.match(text, /a FREE\? row whose fresh probe said payment is required does not match/, "free-only uses the badge as drawn");
  assert.match(text, /N\/M means N listed and M withheld \(ctrl\+r shows them\)/);
  assert.match(text, /provider\/model in flat search \(tab\) the first column reads provider\/model/);
  assert.match(text, /ctrl\+x toggle \[no gone\]: on model lists it hides routes marked gone; on either level it makes the % = ok \/ \(models - gone\) instead of ok \/ models \(off by default\)/);
  assert.match(text, /ctrl\+e toggle \[free\]: on model lists show only models badged FREE or FREE\?/);
  assert.match(text, /\[no gone\] ctrl\+x is on \(off by default\): gone routes are hidden on model lists and the % figures leave them out; the chip shows on both levels/);
  assert.match(text, /\[free\] the ctrl\+e filter is on: only models badged FREE or FREE\? as drawn/);
  assert.equal(/bucket is left off|ids shown without/.test(text), false, "the bucket note is gone");
  assert.match(text, /FULL id, bucket included/);
});

test("terms are drawn in the colours they have in the picker; nothing is coloured by colour alone", () => {
  const coloured = build(UNI, 256).join(NL);
  for (const w of MODALITY_WORDS) assert.ok(coloured.includes(`\x1b[38;5;${MODALITY_COLOURS[w].c256}m${w}\x1b[0m`), `${w} in its colour`);
  const p = painter({ ...detectCaps(UNI, 100), colours: 256 });
  for (const [w, f] of [["alive", p.grn], ["down", p.yel], ["dead", p.red]]) assert.ok(coloured.includes(f(w)), `${w} in its state colour`);
  for (const w of ["70% and up", "30% to 69%", "under 30%"]) assert.ok(coloured.includes(w), "the bands are named in words too");
  assert.ok(coloured.includes(p.grn("ok")) && coloured.includes(p.blu("free")), "ok green, free blue");
  assert.equal(strip(coloured).includes("\x1b"), false);
});

test("LEGEND_LENGTH is the real line count at every width (the page is static), and a hostile painter cannot change it", () => {
  assert.equal(build(UNI).length, LEGEND_LENGTH);
  assert.equal(build(ASCII).length, LEGEND_LENGTH);
  assert.ok(LEGEND_LENGTH > 60 && LEGEND_LENGTH < 300);
});

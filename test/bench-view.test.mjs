// #114: the model level is ONE view showing every column -- the existing ones plus the
// measured status / ttft / total / tok/s and an output preview -- with no toggle. These
// tests pin its geometry (which cells exist at which width, in what order they give way),
// the guarantees the frame already made (exact width, hostile text contained), and that
// the bench file is read lazily.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectCaps, frame, frameWidth, layoutFor, FRAME_MIN, FRAME_MAX, MODEL_ID_MAX, MODEL_ID_MIN } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { legendLines, LEGEND_LENGTH } from "../menu/legend.mjs";
import { loadBench, PREVIEW_CHARS } from "../menu/bench-data.mjs";
import { firstFrame } from "../menu/uwpick.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const VT = detectCaps({ WT_SESSION: "1", COLORTERM: "truecolor" }, 120);
const PLAIN = detectCaps({ TERM: "dumb" }, 80);
const cps = (s) => [...s].length;

const M = (id, o = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false,
                             reason: false, provenance: "listing-verified", routable: true, ...o });
const ROW = { keyId: "personal.acme.free", provider: "acme", free: 0, planCount: 0, health: "ok",
              models: [M("fast-one"), M("slow-one"), M("thinker"), M("never-run"), M("timed-out"), M("hostile"), M("gone-one")] };
const NOW_S = Math.floor(Date.now() / 1000);
const rec = (o) => ({ s: "ok", t: null, d: null, r: null, o: null, a: NOW_S, p: "", k: 0, w: "", ...o });
const BENCH = {
  "acme/fast-one": rec({ t: 842, d: 1230, r: 51.2, p: "Hello there, nice to meet you" }),
  "acme/slow-one": rec({ t: 12400, d: 31000, r: 4.4, p: "x".repeat(200) }),
  "acme/thinker": rec({ s: "empty", d: 9000, p: "budget spent on hidden reasoning" }),
  "acme/timed-out": rec({ s: "timeout", d: 35000 }),
  "acme/gone-one": rec({ s: "gone", p: "model not found" }),
  // Deliberately NOT cleaned: this is what a hand-edited or older file could hand the renderer.
  "acme/hostile": { s: "ok", t: 100, d: 200, r: 30, p: "\x1b[31mRED\x1b]0;pwned\x07 ‮evil\u0085 end", k: 0, w: "", a: NOW_S },
};
const META = { providers: 1, models: 7, generatedAt: "2026-09-29T12:00:00Z",
               benchOf: (t) => BENCH[t] ?? null, benchAsOf: "2026-09-29T12:34:56Z" };
const BARE = { providers: 1, models: 7, generatedAt: META.generatedAt };
const target = (m) => `acme/${m.id}`;
const V1 = (o = {}) => ({
  level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false, provider: ROW, more: 0,
  items: ROW.models.map((model) => ({ kind: "model", model, row: ROW, target: target(model) })), ...o,
});
const FLAT = (o = {}) => V1({ level: 0, scope: "flat", provider: null, ...o });
const V0 = { level: 0, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false, provider: null,
             more: 0, items: [{ kind: "provider", row: ROW }] };
// The longest id of ROW: what the renderer sizes the id column to.
const ROW_ID_W = Math.max(...ROW.models.map((m) => m.id.length));

// Where each cell of a model row begins: frame char 1 + gutter 4, the id, then every cell
// with its own leading space.
const colsOf = (L) => {
  let at = 1 + 4 + L.W.id;
  const out = {};
  const put = (name, w) => { out[name] = at + 1; at += 1 + w; };
  put("status", 4); put("ttft", 5);
  if (L.showTotal) put("total", 5);
  if (L.showTps) put("tps", 5);
  put("ctx", 6); put("in", 5); put("out", 5); put("badge", 5); put("modality", 8); put("caps", 3);
  if (L.showPreview) put("preview", L.W.preview);
  out.end = at;
  return out;
};

// ---------------------------------------------------------------- geometry

test("model layout: the optional cells give way in a fixed order, the preview first", () => {
  for (const idW of [5, 12, 20, 30, 40, 500]) {
    for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
      const l = layoutFor(w, { idW });
      // Priority, lowest last: preview goes first, then tok/s, then total; `modality` is always drawn.
      if (l.showPreview) assert.ok(l.showTps, `tok/s outlives the preview (w ${w}, idW ${idW})`);
      assert.equal(Object.hasOwn(l, "showLimit"), false, "the limit column is gone");
      if (l.showTps) assert.ok(l.showTotal, `total outlives tok/s (w ${w}, idW ${idW})`);
      const used = 4 + l.W.id + 46 + (l.showTotal ? 6 : 0) + (l.showTps ? 6 : 0)
        + (l.showPreview ? 1 + l.W.preview : 0);
      assert.ok(used <= l.inner, `nothing exceeds the inner width (w ${w}, idW ${idW}): ${used} > ${l.inner}`);
      assert.ok(l.W.id <= Math.min(idW, MODEL_ID_MAX), "the id never takes more than its content");
      if (l.showPreview) {
        assert.ok(l.W.preview >= 10, `preview ${l.W.preview} at ${w}`);   // no upper cap: the stored reply limits it
      }
      // What is left over is empty space at the right edge, never a gap between columns.
      assert.ok(l.inner - used >= 0);
    }
  }
});

test("the id column is sized to its content, capped, and keeps MODEL_ID_MIN before any optional cell goes", () => {
  assert.equal(layoutFor(134, { idW: 9 }).W.id, 9, "only as wide as the longest id");
  assert.equal(layoutFor(134, { idW: 500 }).W.id, MODEL_ID_MAX, "a hostile length is capped");
  assert.equal(layoutFor(FRAME_MIN, { idW: 500 }).W.id, 22, "at the floor: 75 - 4 - 49 for the always-drawn cells, modality included, leaves exactly the id floor");
  assert.equal(layoutFor(FRAME_MIN, { idW: 500 }).showTotal, false, "no room for total beside a 22-column id");
  assert.equal(layoutFor(FRAME_MIN, { idW: 500 }).showTps, false);
  const short = layoutFor(FRAME_MIN, { idW: 10 });
  assert.deepEqual([short.showTotal, short.showTps, short.showPreview], [true, true, false],
    "a short id leaves room for total and tok/s at 78 columns");
  assert.equal(MODEL_ID_MIN, 22);
  for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
    assert.ok(layoutFor(w, { idW: 500 }).W.id >= MODEL_ID_MIN, "the id never drops below its floor");
  }
});

test("the minimum terminal width at which EVERY column shows, and that the id gives way first", () => {
  const firstAll = (idW) => {
    for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
      const l = layoutFor(w, { idW });
      if (l.showTotal && l.showTps && l.showPreview) return { cols: w + 2, id: l.W.id, w };
    }
    return null;
  };
  // gutter 4 + id (at least 22) + fixed 49 (modality included) + total, tok/s 12 + the smallest preview 11 + frame 3 + margin 2.
  assert.equal(firstAll(20).cols, 4 + 20 + 49 + 12 + 11 + 3 + 2);
  assert.equal(firstAll(30).cols, 4 + 22 + 49 + 12 + 11 + 3 + 2, "a long id is elided to its floor rather than costing columns");
  assert.equal(firstAll(MODEL_ID_MAX).cols, 103, "every column shows from a 103-column terminal");
  assert.equal(firstAll(30).id, 22);
  assert.equal(firstAll(20).cols, 101);
  // Wider: the id grows toward its content first, then the preview takes the rest.
  const at = (w) => layoutFor(w, { idW: 30 });
  assert.equal(at(firstAll(30).w + 8).W.id, 30);
  assert.equal(at(firstAll(30).w + 8).W.preview, 10, "the id took the first 8 spare columns");
  assert.ok(at(firstAll(30).w + 20).W.preview > 10);
});

// ---------------------------------------------------------- frame invariants

test("every line of the model view is exactly the frame width, in both glyph sets", () => {
  const states = [
    ["level 1", V1()], ["flat", FLAT()],
    ["level 1 filtered", V1({ okOnly: true, oneM: true, filter: "fast" })],
    ["empty", V1({ okOnly: true, empty: true, items: [] })],
  ];
  for (const [name, v] of states) {
    for (const meta of [META, BARE]) {
      for (const base of [VT, PLAIN]) {
        for (const cols of [40, 80, 84, 100, 112, 134, 400]) {
          const caps = { ...base, cols };
          const expected = frameWidth(caps);
          for (const l of frame(v, meta, { caps })) {
            assert.equal(cps(strip(l)), expected, `${name} cols ${cols}: ${strip(l)}`);
          }
        }
      }
    }
  }
});

test("the longest preview cannot widen a row, and a hostile one cannot reach the terminal", () => {
  for (const cols of [80, 134, 400]) {
    const caps = { ...VT, cols };
    const lines = frame(V1(), META, { caps });
    const text = lines.map(strip).join("\n");
    for (const bad of ["\x07", "‮", "\u0085"]) {
      assert.equal(text.includes(bad), false, `cols ${cols}: leaked ${JSON.stringify(bad)}`);
    }
    assert.equal(/\x1b/.test(text), false, "no escape sequence survives a strip of SGR: nothing else was emitted");
    assert.equal(lines.every((l) => cps(strip(l)) === frameWidth(caps)), true);
  }
});

test("level 0 does not depend on bench data or on the model filters", () => {
  for (const caps of [VT, PLAIN, { ...VT, cols: 134 }]) {
    assert.deepEqual(frame(V0, META, { caps }), frame(V0, BARE, { caps }));
    assert.deepEqual(frame({ ...V0, okOnly: true, oneM: true }, META, { caps }), frame(V0, META, { caps }),
      "level 0 draws no chips and ignores the toggles");
  }
});

// ---------------------------------------------------------------- the cells

test("cells are aligned under their headers and show the measured values, all at once", () => {
  const caps = { ...VT, cols: 134, colours: 0 };
  const lines = frame(V1(), META, { caps }).map(strip);
  const head = lines.find((l) => l.includes("ttft"));
  assert.ok(head, "one header carries the measured AND the catalogue columns");
  const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
  const c = colsOf(L);
  assert.ok(L.showTotal && L.showTps && L.showPreview, "every column shows at 134");
  assert.equal(head.indexOf("stat"), c.status);
  assert.equal(head.slice(c.ttft, c.ttft + 5).trim(), "ttft");
  assert.equal(head.slice(c.total, c.total + 5).trim(), "total");
  assert.equal(head.slice(c.tps, c.tps + 5).trim(), "tok/s");
  assert.equal(head.slice(c.ctx, c.ctx + 6).trim(), "ctx");
  assert.equal(head.slice(c.in, c.in + 5).trim(), "$in");
  assert.equal(head.slice(c.out, c.out + 5).trim(), "$out");
  assert.equal(head.slice(c.badge, c.badge + 5).trim(), "badge");
  assert.equal(head.slice(c.caps, c.caps + 3), "TVR");
  assert.equal(head.slice(c.modality, c.modality + 8).trim(), "modality");
  assert.equal(head.includes("limit"), false, "the limit column is gone");
  assert.equal(head.indexOf("output"), c.preview, "the preview is the last column");

  const row = lines.find((x) => x.includes("fast-one"));
  assert.equal(row.slice(c.status, c.status + 4).trim(), "ok");
  assert.equal(row.slice(c.ttft, c.ttft + 5).trim(), "842ms");
  assert.equal(row.slice(c.total, c.total + 5).trim(), "1.23s");
  assert.equal(row.slice(c.tps, c.tps + 5).trim(), "51");
  assert.equal(row.slice(c.ctx, c.ctx + 6).trim(), "128k");
  assert.equal(row.slice(c.in, c.in + 5).trim(), "1.00");
  assert.equal(row.slice(c.out, c.out + 5).trim(), "2.00");
  assert.equal(row.slice(c.badge, c.badge + 5).trim(), "PAID");
  assert.equal(row.slice(c.caps, c.caps + 3), "T--");
  assert.equal(row.slice(c.preview).trim().startsWith("Hello there, nice to meet you"), true);
});

test("no two cells touch: every cell after the id is introduced by the dim column rule", () => {
  for (const cols of [80, 100, 134]) {
    const caps = { ...VT, cols: 134 === cols ? 134 : cols, colours: 0 };
    const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
    const c = colsOf(L);
    const lines = frame(V1(), META, { caps }).map(strip);
    for (const text of [lines.find((l) => l.includes("ttft")), lines.find((l) => l.includes("fast-one"))]) {
      for (const [name, at] of Object.entries(c)) {
        if (name === "end" || name === "status") continue;
        assert.equal(text[at - 1], "┆", `${name} at ${cols}`);
      }
    }
  }
});

test("the id sits directly beside the cells: leftover width is empty space at the right, not a gap", () => {
  const caps = { ...VT, cols: 400, colours: 0 };
  const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
  assert.equal(L.W.id, ROW_ID_W, "the id is its content width, not 37 + surplus");
  const head = frame(V1(), META, { caps }).map(strip).find((l) => l.includes("ttft"));
  assert.equal(head.indexOf("stat"), 1 + 4 + ROW_ID_W + 1);
  assert.ok(L.W.preview > PREVIEW_CHARS, "the output column is not capped at the stored length: it uses the width there is");
  const row = frame(V1(), META, { caps }).map(strip).find((l) => l.includes("fast-one"));
  assert.ok(/ {2,}│$/.test(row), "what is left over sits to the right of the last column");
});

test("each status draws only what it measured", () => {
  const caps = { ...VT, cols: 134, colours: 0 };
  const lines = frame(V1(), META, { caps }).map(strip);
  const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
  const c = colsOf(L);
  const cells = (name) => {
    const row = lines.find((x) => x.includes(name));
    return { code: row.slice(c.status, c.status + 4).trim(), ttft: row.slice(c.ttft, c.ttft + 5).trim(),
             total: row.slice(c.total, c.total + 5).trim(), tps: row.slice(c.tps, c.tps + 5).trim(),
             out: row.slice(c.preview).replace(/\s*│\s*$/, "").trim() };
  };
  assert.deepEqual(cells("thinker"), { code: "empt", ttft: "", total: "", tps: "", out: "budget spent on hidden reasoning" });
  assert.deepEqual(cells("timed-out"), { code: "t/o", ttft: "", total: "35.0s", tps: "", out: "" });
  assert.equal(cells("gone-one").code, "gone");
  assert.equal(cells("gone-one").ttft, "");
  const slow = cells("slow-one");
  assert.deepEqual([slow.code, slow.ttft, slow.total, slow.tps], ["ok", "12.4s", "31.0s", "4.4"]);
  assert.equal(slow.out.length <= L.W.preview, true);
});

test("a model nobody benched draws blanks in the measured cells, never zeros", () => {
  const caps = { ...VT, cols: 134, colours: 0 };
  const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
  const c = colsOf(L);
  const row = frame(V1(), META, { caps }).map(strip).find((x) => x.includes("never-run"));
  assert.equal(row.slice(c.status, c.ctx).replace(/[┆\s]/g, ""), "", "blank between the rules");
  assert.equal(row.slice(c.preview).replace(/\s*│\s*$/, "").trim(), "");
  assert.equal(/0ms|0\.0s/.test(row), false);
  assert.equal(row.slice(c.ctx, c.ctx + 6).trim(), "128k", "the catalogue cells are still there");
});

test("without any bench data every measured cell is blank and the header says how to get some", () => {
  const caps = { ...VT, cols: 134, colours: 0 };
  const lines = frame(V1(), BARE, { caps }).map(strip);
  assert.ok(lines.some((x) => x.includes("bench-cli --live")));
  assert.ok(lines.some((x) => x.includes("fast-one")));
});

test("the header stamp names when the measurements were taken, at the narrowest width too", () => {
  for (const cols of [80, 134]) {
    const caps = { ...VT, cols, colours: 0 };
    for (const v of [V1(), FLAT()]) {
      // The stamps sit at the right end of the `id:` line (#114 redesign), not in the filter header.
      const header = frame(v, META, { caps }).map(strip).find((x) => x.includes("benched"));
      assert.ok(header && header.includes("benched 09-29 12:34Z"), `${cols}: ${header}`);
    }
  }
});

test("flat scope keys the bench by the full target", () => {
  const caps = { ...VT, cols: 134, colours: 0 };
  const seen = [];
  const meta = { ...META, benchOf: (t) => { seen.push(t); return BENCH[t] ?? null; } };
  frame(FLAT(), meta, { caps });
  assert.ok(seen.includes("acme/fast-one"));
  assert.ok(seen.every((t) => t.startsWith("acme/")));
});

test("a non-chat row and a non-routable row are still dimmed whole in the unified view", () => {
  const rows = [M("pic", { outputKind: "nontext" }), M("dead", { routable: false }), M("fine", { routable: true })];
  const provider = { ...ROW, models: rows };
  const v = V1({ provider, cursor: 9, items: rows.map((model) => ({ kind: "model", model, row: provider, target: target(model) })) });
  const lines = frame(v, META, { caps: { ...VT, cols: 134 } });
  const codes = (id) => [...new Set([...lines.find((l) => strip(l).includes(` ${id} `)).matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]))].sort();
  assert.deepEqual(codes("pic"), ["0", "2"]);
  assert.deepEqual(codes("dead"), ["0", "2"]);
  assert.equal(codes("fine").some((x) => x !== "0" && x !== "2"), true);
});

// ------------------------------------------------------------- column rules

test("the rules are in the same columns in the header and every row, at several widths, in both glyph sets", () => {
  for (const [base, S] of [[VT, "┆"], [PLAIN, ":"]]) {
    for (const cols of [80, 84, 100, 112, 134, 400]) {
      const caps = { ...base, cols };
      const L = layoutFor(frameWidth(caps), { idW: ROW_ID_W });
      const c = colsOf(L);
      const lines = frame(V1(), META, { caps }).map(strip);
      const head = lines.find((l) => l.includes("ttft"));
      const positions = (line) => [...line].map((ch, i) => (ch === S ? i : -1)).filter((i) => i >= 0);
      const expected = Object.entries(c).filter(([n]) => n !== "end").map(([, at]) => at - 1);
      assert.deepEqual(positions(head), expected, `header at ${cols}`);
      for (const id of ["fast-one", "never-run", "gone-one", "hostile"]) {
        const row = lines.find((l) => l.includes(id));
        // A preview may itself contain the glyph (`:` in ASCII): compare only up to the preview.
        const upto = c.preview ? row.slice(0, c.preview) : row;
        assert.deepEqual(positions(upto), c.preview ? expected.slice(0, -1).concat(expected.at(-1)) : expected, `${id} at ${cols}`);
      }
    }
  }
});

test("the rule is dim and is not the frame's own glyph", () => {
  const caps = { ...VT, cols: 134 };
  const lines = frame(V1({ cursor: 3 }), META, { caps });
  const body = lines.find((l) => strip(l).includes("fast-one"));
  assert.ok(body.includes("\x1b[2m┆\x1b[0m"), "an unselected row draws each rule dim");
  assert.notEqual("┆", "│");
  assert.equal(frame(V1(), META, { caps: { ...PLAIN, cols: 134 } }).join("\n").includes("┆"), false, "ASCII stays ASCII");
  for (const l of frame(V1(), META, { caps: { ...PLAIN, cols: 134 } })) assert.equal(/[^\x00-\x7f]/.test(l), false);
});

test("a selected row is inverted whole, rules included; a dimmed row stays dimmed whole", () => {
  const caps = { ...VT, cols: 134 };
  const sel = frame(V1({ cursor: 0 }), META, { caps }).find((l) => strip(l).includes("fast-one"));
  assert.equal(sel.includes("\x1b[7m"), true);
  assert.equal(/\x1b\[3[0-9]m/.test(sel), false, "colours are dropped under the inverse, as always");
  assert.ok(strip(sel).includes("┆"), "the rules are still there");
  const rows = [M("pic", { outputKind: "nontext" })];
  const provider = { ...ROW, models: rows };
  const v = V1({ provider, cursor: 9, items: rows.map((model) => ({ kind: "model", model, row: provider, target: target(model) })) });
  const dimmed = frame(v, META, { caps }).find((l) => strip(l).includes("pic"));
  assert.deepEqual([...new Set([...dimmed.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]))].sort(), ["0", "2"]);
});

test("non-table rows are not broken by the rules: more, withheld door, pinned rows, empty state", () => {
  for (const env of [VT, PLAIN]) {
    for (const cols of [40, 80, 134]) {
      const caps = { ...env, cols };
      const withheld = { kind: "withheld-list", count: 3 };
      const v = V1({ items: [withheld, ...V1().items.slice(0, 2)], more: 5 });
      const lines = frame(v, META, { caps }).map(strip);
      const fw = frameWidth(caps);
      for (const l of lines) assert.equal(cps(l), fw, `cols ${cols}: ${l}`);
      assert.ok(lines.some((l) => l.includes("WITHHELD LIST (3)")));
      assert.ok(lines.some((l) => l.includes("5 more")));
      const door = lines.find((l) => l.includes("WITHHELD LIST"));
      assert.equal(/[┆:]/.test(door.replace(/^.{2}/, "").replace(/.$/, "")), false, "the door row carries no rules");
      const pinned = V0.items.length && { ...V0, items: [{ kind: "pinned", mark: "*", target: "acme/fast-one" }, ...V0.items] };
      for (const l of frame(pinned, META, { caps })) assert.equal(cps(strip(l)), fw);
    }
  }
});

// ------------------------------------------------------------------ reducer

const snapRows = (providers, per) => Array.from({ length: providers }, (_, p) => ({
  keyId: `personal.p${p}.free`, provider: `p${p}`, free: 0, planCount: 0, health: "ok",
  models: Array.from({ length: per }, (_, i) => M(`m${i}`)),
}));
const CTRL_B = "\x02";

test("ctrl+b is a harmless no-op everywhere and never enters the filter", () => {
  let s = initState(snapRows(3, 4));
  assert.equal(Object.hasOwn(view(s), "bench"), false, "there is no bench view any more");
  for (const level of [0, 1]) {
    if (level === 1) s = reduce(s, "\r").state;
    const before = JSON.stringify(view(s));
    const r = reduce(s, CTRL_B);
    assert.equal(r.exit, null);
    assert.equal(r.favourite, null);
    assert.deepEqual(r.state, s, `level ${level}: state untouched`);
    assert.equal(JSON.stringify(view(r.state)), before);
    assert.equal(view(r.state).filter, "");
  }
  s = reduce(s, "b").state;
  assert.equal(view(s).filter, "b", "a plain b is still a filter character");
  assert.deepEqual(reduce(reduce(initState(snapRows(2, 2)), "?").state, CTRL_B).state.legend, null, "a modal swallows it");
});

test("the legend documents the columns, the filters and the keys; the footer names them", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const lines = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" });
  const text = lines.join("\n");
  for (const needle of ["ctrl+o", "ctrl+l", "1M", "BENCH COLUMNS", "ttft", "tok/s", "NO tools", "bench-cli", "K ok"]) {
    assert.ok(text.includes(needle), needle);
  }
  assert.equal(text.includes("ctrl+b"), false, "the toggle is gone from the legend");
  assert.equal(text.includes("BENCH VIEW"), false);
  assert.equal(lines.length, LEGEND_LENGTH);
  const caps = { ...VT, cols: 134, colours: 0 };
  const foot = frame(V1(), META, { caps }).map(strip).at(-1);
  assert.ok(foot.includes("[^o] ok") && foot.includes("[^l] 1M+"));
  assert.equal(foot.includes("[^b]"), false);
});

// ------------------------------------------------------------------ lazy load

test("the bench file is not read at startup and level 0 never asks for a record", () => {
  const snap = { schemaVersion: 7, generatedAt: "x", builtAt: "x", rows: snapRows(3, 4) };
  let calls = 0;
  const f = firstFrame({ snap, recents: [], favourites: [], caps: PLAIN, termRows: 30 });
  assert.equal(f.meta.benchOf, undefined, "firstFrame does not load bench.json");
  assert.equal(f.meta.benchAsOf, undefined);
  const counting = { ...f.meta, benchOf: () => { calls += 1; return null; } };
  frame(view(initState(snap.rows)), counting, { caps: PLAIN });
  assert.equal(calls, 0, "the provider list never looks a record up");
});

test("uwpick loads bench.json exactly once, and only when a model screen is about to be drawn", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "menu", "uwpick.mjs"), "utf8")
    .replace(/\/\/.*$/gm, "");
  assert.equal((src.match(/\bloadBench\(/g) ?? []).length, 1, "one call site");
  assert.match(src, /state\.level > 0 \|\| state\.scope === "flat"\) && !meta\.benchOf/,
    "guarded by 'a model screen' and 'not loaded yet'");
  assert.equal(/\bstate\.bench\b/.test(src), false, "no bench toggle state is left");
});

// -------------------------------------------------------------------- scale

test("loading and drawing on a 6,000-row catalogue reads the bench file once and stays fast", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-benchview-"));
  const file = path.join(dir, "bench.json");
  const rows = snapRows(60, 100);
  const models = {};
  for (const r of rows) for (const m of r.models) {
    models[`${r.provider}/${m.id}`] = { s: "ok", t: 800, d: 1500, r: 42.5, o: 30, a: Math.floor(Date.now() / 1000), p: "Hello there friend, how are you", k: 0, w: "" };
  }
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: "2026-09-29T12:00:00Z", params: {}, models }));
  assert.ok(fs.statSync(file).size < 1.5e6, "6,000 rows stay under 1.5 MB on disk");

  const t0 = process.hrtime.bigint();
  const b = loadBench(file);
  const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(b.size, 6000);
  let s = reduce(initState(rows), "\t").state;             // flat scope: all 6,000 rows in play
  s = reduce(s, { benchOf: b.get }).state;
  const caps = { ...VT, cols: 134, colours: 0 };
  let calls = 0;
  const counting = { providers: 60, models: 6000, generatedAt: "x", benchAsOf: b.generatedAt,
                     benchOf: (t) => { calls += 1; return b.get(t); } };
  const t1 = process.hrtime.bigint();
  const lines = frame(view(s), counting, { caps });
  const drawMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.ok(lines.some((x) => strip(x).includes("Hello there friend")));
  assert.ok(calls <= 40, `only the visible rows are looked up (${calls})`);
  assert.ok(loadMs < 300, `loading a 6,000-row bench.json took ${loadMs.toFixed(0)} ms`);
  assert.ok(drawMs < 300, `the first model frame took ${drawMs.toFixed(0)} ms`);
  // ok-only over all 6,000 flat rows: one memoised pass, then instant.
  const t2 = process.hrtime.bigint();
  s = reduce(s, "\x0f").state;
  const first = Number(process.hrtime.bigint() - t2) / 1e6;
  const t3 = process.hrtime.bigint();
  s = reduce(s, "a").state;
  const again = Number(process.hrtime.bigint() - t3) / 1e6;
  assert.equal(view(s).modelCount, 0, "no record is fresh in this file? (a was set to now, so all are ok) -- filtered by 'a'");
  assert.ok(first < 1500, `first ok-only pass over 6,000 rows took ${first.toFixed(0)} ms`);
  assert.ok(again < 500, `a keystroke with ok-only on took ${again.toFixed(0)} ms`);
  fs.rmSync(dir, { recursive: true, force: true });
});

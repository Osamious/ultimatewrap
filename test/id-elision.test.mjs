// #114: distinctness-aware id elision, the FULL ID line, the withheld overlay's own id width,
// display-width safety, live ok counts, sanitised meta, header clipping and fmtMs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCaps, painter, glyphsFor, padId, elisionHeads, elisionPlan, frame, frameWidth, layoutFor } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { sanitizeCells, sanitizeDisplay } from "../menu/sanitize.mjs";
import { fmtMs, loadBench, previewText } from "../menu/bench-data.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const ENTER = "\r", DOWN = "\x1b[B", TAB = "\t";

// An independent display-width measure (a small wcwidth for the ranges that matter here): what a
// terminal would actually occupy, as opposed to the code-point count the frame pads with.
function wcwidth(cp) {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if (/\p{M}/u.test(String.fromCodePoint(cp))) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
    || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}
const width = (s) => [...s].reduce((n, ch) => n + wcwidth(ch.codePointAt(0)), 0);

const M = (id, o = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false,
                             reason: false, provenance: "listing-verified", routable: true, ...o });
const prow = (keyId, models, o = {}) => ({ keyId, provider: keyId.split(".")[1] ?? "p", free: 0, planCount: 0, health: "ok", models, ...o });
const cell = (str, n, h) => { const c = [...str]; if (c.length <= n) return str; const keep = n - 1; const hh = h ?? Math.ceil(keep / 2); return c.slice(0, hh).join("") + "-" + c.slice(c.length - (keep - hh)).join(""); };
const dupCount = (strs, n, heads) => { const m = new Map(); for (const s of strs) { const k = cell(s, n, heads?.get(s)); m.set(k, (m.get(k) ?? 0) + 1); } return [...m.values()].filter((c) => c > 1).reduce((a, c) => a + c, 0); };

// ------------------------------------------------------------------ elision

const VERSIONED = ["google/gemini-3.5-flash-lite", "google/gemini-3.6-flash-lite", "google/gemini-3.7-flash-lite",
                   "google/gemini-3.8-flash-lite", "google/gemini-3.5-flash:batch", "google/gemini-3.6-flash:batch",
                   "google/gemini-3.7-flash:batch", "google/gemini-3.8-flash:batch", "google/gemma-4-31b-it"];

test("a blind middle cut collides on versioned ids; the distinctness-aware split does not", () => {
  const n = 22;
  assert.ok(dupCount(VERSIONED, n) >= 6, "precondition: the old blind cut makes several cells identical");
  const { heads, dup } = elisionHeads(VERSIONED, n);
  assert.equal(dup, 0);
  assert.equal(dupCount(VERSIONED, n, heads), 0, "every displayed cell is distinct");
  for (const [str, h] of heads) assert.ok(h >= 0 && h <= n - 1, `${str}: head ${h}`);
  assert.equal(heads.has("google/gemma-4-31b-it"), false, "a string that fits (21 <= 22) is left alone");
});

test("strings that fit are never touched, and an empty or all-fitting column costs nothing", () => {
  const { heads, dup } = elisionHeads(["short", "also-short"], 22);
  assert.equal(heads.size, 0);
  assert.equal(dup, 0);
  assert.equal(elisionHeads([], 22).heads.size, 0);
  assert.equal(elisionHeads(undefined ?? [], 5).dup, 0);
});

test("uniqueness is reported honestly when the width physically cannot separate two ids", () => {
  const a = "x".repeat(30) + "1" + "y".repeat(30), b = "x".repeat(30) + "2" + "y".repeat(30);
  const { dup } = elisionHeads([a, b], 8);
  assert.equal(dup, 2, "the differing character is 30 columns from either end and the cell holds 7");
  assert.equal(elisionHeads([a, b], 40).dup, 2 - 2, "but a wide enough column separates them");
});

test("padId with a head hint keeps exactly that many head characters, and the default is unchanged", () => {
  const g = glyphsFor(detectCaps(ASCII, 80)), p = painter(detectCaps(ASCII, 80));
  const id = "abcdefghijklmnopqrstuvwxyz0123456789";
  assert.equal(padId(id, 12, "", g, p), "abcdef-56789".slice(0, 6) + g.elide + id.slice(-5), "blind: ceil(11/2) = 6 head");
  assert.equal(padId(id, 12, "", g, p, 3), "abc" + g.elide + id.slice(-8));
  assert.equal(padId(id, 12, "", g, p, 0), g.elide + id.slice(-11));
  assert.equal(padId(id, 12, "", g, p, 99), id.slice(0, 11) + g.elide, "clamped to the budget");
  assert.equal(cps(padId(id, 12, "", g, p, 3)), 12);
  // The marker still bolds when the match hides in the elided middle (the padId contract).
  const pv = painter(detectCaps(UNI, 80)), gv = glyphsFor(detectCaps(UNI, 80));
  assert.ok(padId(id, 12, "mnop", gv, pv, 3).includes(pv.bold(gv.dashMatch)));
  assert.equal(strip(padId(id, 12, "abc", gv, pv, 3)).includes(gv.dashMatch), false);
});

test("the plan is cached per provider, scope and width, and flat scope keeps the provider prefix readable", () => {
  const row = { provider: "google", models: VERSIONED.map((t) => M(t.split("/")[1])) };
  const a = elisionPlan(row, false, 22);
  assert.equal(elisionPlan(row, false, 22), a, "the same Map comes back (computed once)");
  assert.notEqual(elisionPlan(row, false, 26), a);
  const flat = elisionPlan(row, true, 34);
  const targets = VERSIONED;
  assert.equal(dupCount(targets, 34, flat), 0);
  for (const t of targets.filter((x) => cps(x) > 34)) assert.ok(flat.get(t) >= "google/".length, "the provider prefix is kept whole");
  assert.equal(elisionPlan(null, true, 30), null);
  assert.equal(elisionPlan({ models: 3 }, false, 30), null);
});

test("rows that differ only in a version are drawn as different cells on screen at the 78-column floor", () => {
  const models = VERSIONED.map((t) => M(t.split("/")[1]));
  const row = prow("personal.google.free", models);
  for (const env of [UNI, ASCII]) {
    for (const cols of [80, 90, 101, 110, 134]) {
      const caps = detectCaps(env, cols);
      let st = { ...initState([row]), level: 1, provider: row };
      const lines = frame(view(st), { providers: 1, models: models.length }, { caps }).map(strip);
      const L = layoutFor(frameWidth(caps), { idW: Math.max(...models.map((m) => m.id.length)) });
      const shown = lines.filter((l) => /gemin|gemma/.test(l) && !l.includes("id:")).map((l) => l.slice(5, 5 + L.W.id));
      assert.equal(new Set(shown).size, shown.length, `cols ${cols}: ${shown.join(" | ")}`);
    }
  }
});

test("elision stays cheap on a 6,000-model column", () => {
  const ids = Array.from({ length: 6000 }, (_, i) => `provider-${i % 50}/family-${i % 7}-model-v${i}.${i % 13}-instruct:batch-${i}`);
  const t0 = process.hrtime.bigint();
  const { heads } = elisionHeads(ids, 30);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(heads.size > 0);
  assert.ok(ms < 2500, `6,000 ids took ${ms.toFixed(0)} ms`);
});

// ------------------------------------------------------------- the id line

const long = "an-extremely-long-model-identifier-that-cannot-possibly-fit-in-the-column:2026-09-29-batch";
const ROW = prow("personal.acme.free", [M(long), M("plain-one"), M("pic", { outputKind: "nontext" })]);
const OTHER = prow("relay.zed.sub", [M("z1")]);
const metaFor = (rows) => ({ providers: rows.length, models: rows.reduce((n, r) => n + r.models.length, 0), keyIdBucket: "", keyIdW: 30 });
const idLine = (lines) => lines.map(strip).find((l) => l.startsWith("│  id:") || l.startsWith("|  id:"));

test("level 1 shows the selected row's full, unelided id on the line above the reply line and the footer", () => {
  for (const env of [UNI, ASCII]) {
    for (const cols of [80, 100, 134]) {
      const caps = detectCaps(env, cols);
      const st = { ...initState([ROW, OTHER]), level: 1, provider: ROW };
      const lines = frame(view(st), metaFor([ROW, OTHER]), { caps });
      const shown = idLine(lines);
      assert.ok(shown, `cols ${cols}`);
      const room = frameWidth(caps) - 3 - cps("  id: ");
      assert.equal(cps(strip(lines.at(-2))), frameWidth(caps));
      assert.ok(lines.map(strip).at(-3) === shown, "it is the line above the `reply:` line, which is above the footer");
      if (cps(long) <= room) assert.ok(shown.includes(long), "unelided");
      else assert.ok(shown.includes(long.slice(-(room - 3))) || shown.includes(long.slice(-(room - 1))), "clipped from the left, tail kept");
    }
  }
  const caps = detectCaps(UNI, 134);
  assert.ok(idLine(frame(view({ ...initState([ROW, OTHER]), level: 1, provider: ROW }), metaFor([ROW, OTHER]), { caps })).includes(long));
});

test("flat scope shows provider/model, level 0 shows the whole key id including the omitted bucket, pinned shows its target", () => {
  const caps = detectCaps(ASCII, 134);
  let f = reduce(initState([ROW, OTHER]), TAB).state;
  f = reduce(f, DOWN).state;
  assert.ok(idLine(frame(view(f), metaFor([ROW, OTHER]), { caps })).includes("acme/plain-one"));
  const m0 = { ...metaFor([ROW, OTHER]), keyIdBucket: "personal." };
  const l0 = reduce(initState([ROW, OTHER]), "").state;
  assert.ok(idLine(frame(view(l0), m0, { caps })).includes("id: personal.acme.free"), "the omitted bucket is spelled out");
  assert.ok(idLine(frame(view(reduce(l0, DOWN).state), m0, { caps })).includes("id: relay.zed.sub"));
  const pinnedV = { level: 0, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false, provider: null, more: 0,
    fullId: "acme/some-pinned-model", items: [{ kind: "pinned", mark: "*", target: "acme/some-pinned-model" }] };
  assert.ok(idLine(frame(pinnedV, m0, { caps })).includes("acme/some-pinned-model"));
});

test("the id line is blank when nothing is selectable, and never breaks the frame", () => {
  const caps = detectCaps(ASCII, 100);
  const nontext = { ...initState([ROW, OTHER]), level: 1, provider: ROW, cur: [0, 2, 0] };   // the non-chat row
  const lines = frame(view(nontext), metaFor([ROW, OTHER]), { caps }).map(strip);
  assert.equal(view(nontext).fullId, null);
  assert.equal(lines.some((l) => l.includes("id:")), false);
  assert.equal(cps(lines.at(-2)), frameWidth(caps), "still a full-width (blank) line");
  const withheld = { ...ROW, refused: [{ id: "x", reason: "r", removed: 1 }] };
  const door = { ...initState([withheld]), level: 1, provider: withheld };
  assert.equal(view(door).items[0].kind, "withheld-list");
  assert.equal(view(door).fullId, null);
  const empty = { ...initState([ROW]), level: 1, provider: ROW, q: ["", "zzzz", ""] };
  assert.equal(view(empty).fullId, null);
  assert.equal(frame(view(empty), metaFor([ROW]), { caps }).length > 0, true);
});

test("a hostile id is sanitised on the id line and a very long one is clipped from the left with an ellipsis", () => {
  const evil = "evil\x1b]0;PWN\x07\x1b[2J" + "z".repeat(200) + "-TAIL";
  const row = prow("personal.acme.free", [M(evil)]);
  for (const env of [UNI, ASCII]) {
    const caps = detectCaps(env, 80);
    const lines = frame(view({ ...initState([row]), level: 1, provider: row }), metaFor([row]), { caps });
    const all = lines.join("\n");
    assert.equal(/\x07/.test(all), false);
    assert.equal(/\x1b\]/.test(all), false);
    assert.equal(all.includes("\x1b[2J"), false);
    const shown = idLine(lines);
    assert.ok(shown.includes("-TAIL"), "the tail survives");
    assert.ok(shown.includes(glyphsFor(caps).ell), "and the clip is visible");
    assert.equal(cps(strip(lines.find((l) => strip(l).includes("id:")))), 78);
  }
});

test("the frame never exceeds the terminal height: the reducer and the renderer agree on the page size", () => {
  const many = prow("personal.acme.free", Array.from({ length: 200 }, (_, i) => M(`model-${i}`)));
  for (const termRows of [10, 14, 20, 24, 30, 50]) {
    for (const [name, st] of [["level 1", { ...initState([many], { termRows }), level: 1, provider: many }],
                              ["flat", reduce(initState([many], { termRows }), TAB).state],
                              ["level 0", initState([many, ROW, OTHER], { termRows })]]) {
      const v = view(st);
      const lines = frame(v, metaFor([many]), { caps: detectCaps(UNI, 100) });
      if (termRows >= 10) assert.ok(lines.length <= termRows, `${name} at ${termRows} rows drew ${lines.length}`);
      // The model level and flat spend one more line on the `reply:` line (#114 redesign).
      assert.equal(v.legendAvail, Math.max(1, termRows - 8 - (name === "level 0" ? 0 : 1)));
      assert.ok(v.items.length <= v.legendAvail);
    }
  }
});

// ---------------------------------------------------------- withheld overlay

test("the withheld overlay sizes its own id column instead of borrowing the shrunken model-list one", () => {
  const id52 = "accounts/fireworks/models/llama-v3p1-405b-instruct-x"; // 52
  assert.equal(cps(id52), 52);
  const withheld = prow("personal.acme.free", [M("m0")], { refused: [{ id: id52, reason: "cap-exceeded", removed: 3 }, { id: "short", reason: "cap-exceeded", removed: 1 }] });
  for (const [cols, expectFull] of [[101, true], [134, true], [80, false]]) {
    const caps = detectCaps(ASCII, cols);
    const st = reduce(reduce(initState([withheld]), ENTER).state, "\x12").state;   // ctrl+r at level 1
    assert.ok(st.refusals);
    const v = view(st);
    assert.equal(v.refusals.idMax, 52);
    const lines = frame(v, metaFor([withheld]), { caps }).map(strip);
    for (const l of lines) assert.equal(cps(l), frameWidth(caps), l);
    const row = lines.find((l) => l.includes("cap-exceeded") && l.includes("accounts"));
    const room = frameWidth(caps) - 3 - 35;
    if (expectFull) assert.ok(row.includes(id52), `cols ${cols}: the whole 52-character id fits (room ${room})`);
    else assert.equal(row.includes(id52), false, "and at 80 columns it is elided to what the row leaves");
    const header = lines.find((l) => l.includes("reason") && l.includes("removed"));
    assert.equal(header.indexOf("reason"), row.indexOf("cap-exceeded"), "header and rows share the column");
  }
});

// ------------------------------------------------------ display-width safety

const NASTY = ["你好世界", "🌟✨", "e\u0301\u0301\u0301", "👨‍👩‍👧‍👦", "ＡＢＣ", "ｶﾞ", "한국어", "a\u200Db"];

test("sanitizeCells leaves exactly one column per code point, whatever the input", () => {
  for (const s of NASTY) {
    const out = sanitizeCells(s, 80);
    assert.equal(width(out), cps(out), `${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
  }
  assert.equal(sanitizeCells("你好", 80), "??");
  assert.equal(sanitizeCells("🌟", 80), "?");
  assert.equal(sanitizeCells("plain-id/x_1:2", 80), "plain-id/x_1:2");
  assert.equal(sanitizeCells("é", 80), "é", "a precomposed accent is one column and stays");
  assert.equal(sanitizeDisplay("你好", 80), "你好", "the underlying sanitiser is unchanged: only DRAWN text is narrowed");
});

test("wide, astral and combining characters cannot move a row or the rules, in ids, previews and key ids", () => {
  const models = NASTY.map((s, i) => M(`id-${i}-${s}`));
  const bench = Object.fromEntries(models.map((m, i) => [`x/${m.id}`, { s: "ok", t: 100, d: 200, r: 30, a: Math.floor(Date.now() / 1000), p: `${NASTY[i]} answer ${NASTY[(i + 1) % NASTY.length]}`, k: 0, w: "" }]));
  const benchOf = (t) => bench[t] ?? null;
  const row = prow("personal_你好.x.free", models, { provider: "x" });
  const other = prow("personal.🌟.free", [M("m")], { provider: "y" });
  const rows = [row, other];
  for (const env of [UNI, ASCII]) {
    const S = env === UNI ? "┆" : ":";
    for (const cols of [40, 80, 100, 134, 400]) {
      const caps = detectCaps(env, cols);
      for (const mode of ["level0", "level1", "flat"]) {
        let st = reduce(initState(rows), { benchOf }).state;
        if (mode === "level1") st = { ...st, level: 1, provider: row };
        if (mode === "flat") st = reduce(st, TAB).state;
        const meta = { providers: 2, models: 6, keyIdBucket: "", keyIdW: 30, flatIdW: 40, benchOf, benchAsOf: "2026-09-29T12:00:00Z" };
        const lines = frame(view(st), meta, { caps }).map(strip);
        for (const l of lines) {
          assert.equal(cps(l), frameWidth(caps), `${mode} cols ${cols}`);
          assert.equal(width(l), frameWidth(caps), `${mode} cols ${cols}: display width ${width(l)} of ${JSON.stringify(l)}`);
        }
        if (mode !== "level0" && cols >= 100) {
          // the rules sit in the same display columns in the header and in every table row
          const at = (l) => { let col = 0, out = []; for (const ch of l) { if (ch === S) out.push(col); col += wcwidth(ch.codePointAt(0)); } return out; };
          const hi = lines.findIndex((l) => l.includes("ttft"));
          const ii = lines.findIndex((l) => l.includes("id:"));
          const head = lines[hi];
          for (const r of lines.slice(hi + 1, ii)) {
            if (r.includes("more")) continue;
            assert.deepEqual(at(r).slice(0, at(head).length - 1), at(head).slice(0, -1), r);
          }
        }
      }
    }
  }
});

test("previews are narrowed at draw time and the stored record is untouched", () => {
  const rec = { s: "ok", p: "用户现在需要 hello 🌟" };
  assert.equal(previewText(rec, 40), "??????" + " hello ?");
  assert.equal(rec.p, "用户现在需要 hello 🌟");
  assert.equal(previewText({ s: "skip", w: "unfunded" }, 40), "skipped: unfunded");
});

// ------------------------------------------------------------- live ok count

test("the model-level ok figure is computed live, so it agrees with the ok-only list and the stamp", () => {
  const models = Array.from({ length: 12 }, (_, i) => M(`m${i}`));
  // the snapshot BAKED 3 ok, but bench.json now says 7 are ok
  const row = prow("personal.acme.free", models, { provider: "acme", bench: { ok: 3, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 } });
  const now = 1_800_000_000_000;
  const benchOf = (t) => { const n = Number(/m(\d+)$/.exec(t)?.[1]); return n < 7 ? { s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" } : null; };
  let st = reduce(initState([row], { nowMs: now }), { benchOf }).state;
  st = reduce(st, ENTER).state;
  const caps = detectCaps(ASCII, 100);
  const meta = { providers: 1, models: 12, benchOf, benchAsOf: "2026-09-29T12:35:00Z" };
  const head = () => frame(view(st), meta, { caps }).map(strip).find((l) => l.includes("filter:"));
  assert.ok(head().includes("12 of 12 | 7 ok (58%)"), head());
  const stampsOf = () => frame(view(st), meta, { caps }).map(strip).find((l) => l.includes("id: "));
  assert.ok(stampsOf().includes("benched 09-29 12:35Z"), "the stamp is on the id line: " + stampsOf());
  st = reduce(st, "\x0f").state;
  assert.equal(view(st).modelCount, 7, "the ok-only list holds exactly the models the header counts");
  assert.ok(head().includes("7 of 12 | 7 ok ("), head());
  const flat = reduce(reduce(initState([row], { nowMs: now }), { benchOf }).state, TAB).state;
  assert.equal(view(flat).okLive, 7);
  assert.equal(view(reduce(initState([row], { nowMs: now }), ENTER).state).okLive, null, "no reader yet: unknown, not 0");
  // An `x` / `x[1m]` pair is two rows: the header counts both because the ok-only list shows both.
  const twin = prow("personal.acme.free", [M("x"), M("x[1m]"), M("y")], { provider: "acme" });
  const twinOf = (t) => (/^acme\/(x|y)/.test(t) ? { s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" } : null);
  let ts = reduce(reduce(initState([twin], { nowMs: now }), { benchOf: twinOf }).state, ENTER).state;
  const counted = view(ts).okLive;
  ts = reduce(ts, "\x0f").state;
  assert.equal(view(ts).modelCount, counted, "count and list agree even with a [1m] twin");
  assert.equal(counted, 3);
});

// ---------------------------------------------------------- sanitised meta

test("escape sequences injected into any meta string never reach the output", () => {
  const PWN = "\x1b]0;PWN\x07\x1b[2J\x1b[31m";
  const models = [M("m1")];
  const row = prow("personal.acme.free", models, { provider: "acme", bench: { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 } });
  const meta = { providers: 1, models: 1, keyIdW: 30, keyIdBucket: PWN, benchAsOf: PWN, routableAsOf: PWN, discoveredAsOf: PWN,
                 benchCountsAsOf: PWN, generatedAt: PWN, benchOf: () => null };
  for (const env of [UNI, ASCII]) {
    const caps = detectCaps(env, 134);
    const shots = [
      frame(view(initState([row])), meta, { caps }),
      frame(view({ ...initState([row]), level: 1, provider: row }), meta, { caps }),
      frame(view(reduce(initState([row]), TAB).state), meta, { caps }),
    ];
    for (const lines of shots) for (const l of lines) {
      const bare = l.replace(/\x1b\[[0-9;]*m/g, "");        // our own colour codes are the only ESC allowed
      assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(bare), false, JSON.stringify(bare));
      assert.equal(bare.includes("PWN\x07"), false);
    }
  }
});

test("loadBench rejects a generatedAt that does not look like a timestamp", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-idel-"));
  const write = (generatedAt) => { const f = path.join(dir, "b.json"); fs.writeFileSync(f, JSON.stringify({ schema: 1, generatedAt, models: { "a/b": { s: "ok", a: 1 } } })); return loadBench(f); };
  assert.equal(write("2026-09-29T12:35:00.000Z").generatedAt, "2026-09-29T12:35:00.000Z");
  assert.equal(write("\x1b]0;PWN\x07").generatedAt, null);
  assert.equal(write("yesterday").generatedAt, null);
  assert.equal(write(12345).generatedAt, null);
  assert.equal(write("2026-09-29T12:35:00.000Z").size, 1, "the data itself still loads");
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------- header clipping

test("typed text plus chips never cut a stamp mid-token or drop the ok figure at the 78-column floor", () => {
  const models = Array.from({ length: 30 }, (_, i) => M(`m${i}`));
  const row = prow("personal.acme.free", models, { provider: "acme" });
  const now = 1_800_000_000_000;
  const benchOf = () => ({ s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" });
  const meta = { providers: 1, models: 6032, benchOf, benchAsOf: "2026-09-29T12:35:00Z", discoveredAsOf: "2026-09-07T13:37:38Z", flatIdW: 30 };
  for (const env of [UNI, ASCII]) {
    for (const typed of ["", "zzzqqq", "a".repeat(20), "q".repeat(40)]) {
      let st = reduce(reduce(initState([row], { nowMs: now }), { benchOf }).state, TAB).state;
      st = reduce(reduce(st, "\x0f").state, "\x0c").state;
      for (const ch of typed) st = reduce(st, ch).state;
      const caps = detectCaps(env, 80);
      const h = strip(frame(view(st), meta, { caps }).find((l) => strip(l).includes("filter:")));
      assert.equal(cps(h), 78);
      assert.ok(/\d+ ok \(/.test(h), `the ok figure survives: ${h}`);
      // The stamps live on the `id:` line now; whatever of them is drawn is whole.
      const idl = strip(frame(view(st), meta, { caps }).find((l) => strip(l).includes("id: ")) ?? "");
      if (idl) assert.equal(cps(idl), 78);   // no row selected (nothing matches): no id line, so no stamps
      if (idl.includes("benched")) assert.ok(/benched \d\d-\d\d \d\d:\d\dZ/.test(idl), `a stamp is whole or absent: ${idl}`);
      assert.ok(!/ [0-9]{2}-[0-9]{2} [0-9]{1}\s*[│|]$/.test(idl), `not cut mid-time: ${idl}`);
    }
  }
  // level 0 too
  let s0 = initState([row], { nowMs: now });
  for (const ch of "z".repeat(30)) s0 = reduce(s0, ch).state;
  const h0 = strip(frame(view(s0), { providers: 1, models: 30, okTotal: 5, routableAsOf: "2026-09-29T09:18:00Z", benchCountsAsOf: "2026-09-29T09:18:00Z" }, { caps: detectCaps(ASCII, 80) }).find((l) => l.includes("filter:")));
  assert.equal(cps(h0), 78);
  assert.ok(h0.includes("5 ok"), h0);
});

// ------------------------------------------------------------------ fmtMs

test("fmtMs is at most five characters everywhere and monotonic across every window boundary", () => {
  const edges = [0, 0.4, 0.5, 999, 999.4, 999.5, 1000, 1004, 1005, 9994, 9995, 9999, 10000, 10049, 10050, 99949, 99950, 99999, 100000,
                 100499, 100500, 999499, 999500, 9_999_499, 9_999_500, 99_999_999, 1e12];
  for (const ms of edges) assert.ok(fmtMs(ms).length <= 5, `${ms} -> ${fmtMs(ms)}`);
  const num = (s) => (s.endsWith("ms") ? parseFloat(s) : parseFloat(s) * 1000);
  let prev = -1;
  for (let ms = 0; ms < 200_000; ms += 0.5) {
    const s = fmtMs(ms);
    assert.ok(s.length <= 5, `${ms} -> ${s}`);
    const v = num(s);
    assert.ok(v >= prev, `monotonic at ${ms}: ${s} after ${prev}`);
    prev = v;
  }
  assert.equal(fmtMs(999.4), "999ms");
  assert.equal(fmtMs(999.5), "1.00s");
  assert.equal(fmtMs(9994), "9.99s");
  assert.equal(fmtMs(9995), "10.0s");
  assert.equal(fmtMs(99949), "99.9s");
  assert.equal(fmtMs(99950), "100s");
  assert.equal(fmtMs(1e12), "long", "beyond 9999 s there is no honest five-column number");
  assert.equal(fmtMs(9_999_499), "9999s");
  assert.equal(fmtMs(9_999_500), "long");
  assert.equal(fmtMs(-1), "");
  assert.equal(fmtMs(NaN), "");
  assert.equal(fmtMs(842), "842ms");
  assert.equal(fmtMs(1230), "1.23s");
});

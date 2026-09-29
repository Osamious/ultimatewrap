// Second review round: `- ok` vs `0 ok`, an allowlist for drawn text (whole-BMP scan), flat-scope
// look-alikes, baked-vs-live wording, the 10-row terminal, and re-aged carried counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCaps, frame, frameWidth } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { loadBench } from "../menu/bench-data.mjs";
import { sanitizeCells, sanitizeDisplay } from "../menu/sanitize.mjs";
import { legendLines } from "../menu/legend.mjs";
import { buildSnapshot } from "../menu/snapshot.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const ASCII = { TERM: "dumb" }, UNI = { WT_SESSION: "1", COLORTERM: "truecolor" };
const DAY = 24 * 3600 * 1000;
const M = (id, o = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false,
                             reason: false, provenance: "listing-verified", routable: true, ...o });
const prow = (keyId, models, o = {}) => ({ keyId, provider: keyId.split(".")[1] ?? "p", free: 0, planCount: 0, health: "ok", models, ...o });

// -------------------------------------------------------------- 1. `- ok`

const tmpBench = (models) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-r2-"));
  const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), models }));
  return { file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const nowS = () => Math.floor(Date.now() / 1000);
const header = (st, meta, cols = 100) => strip(frame(view(st), meta, { caps: detectCaps(ASCII, cols) }).find((l) => l.includes("filter:")));
// The data stamps sit at the right end of the `id:` line (#114 redesign).
const stampLine = (st, meta, cols = 100) => strip(frame(view(st), meta, { caps: detectCaps(ASCII, cols) }).find((l) => strip(l).includes("id: ")) ?? "");

test("`- ok`, never `0 ok`, when the reader has no records at all (missing, empty or wrong-schema file)", () => {
  const rows = [prow("personal.a.free", [M("m1"), M("m2")], { provider: "a" })];
  for (const make of [() => loadBench(path.join(os.tmpdir(), "uw-r2-does-not-exist.json")),
                      () => { const t = tmpBench({}); const b = loadBench(t.file); t.done(); return b; }]) {
    const b = make();
    assert.equal(b.get.records, 0);
    let st = reduce(initState(rows), { benchOf: b.get }).state;
    const meta = { providers: 1, models: 2, benchOf: b.get, benchAsOf: null };
    assert.equal(view(reduce(st, "\r").state).okLive, null);
    const l1 = header(reduce(st, "\r").state, meta);
    assert.ok(l1.includes("- ok") && !l1.includes("0 ok"), l1);
    const s1 = stampLine(reduce(st, "\r").state, meta);
    assert.ok(s1.includes("benched - run bench-cli --live"), s1);
    const flat = header(reduce(st, "\t").state, meta);
    assert.ok(flat.includes("| - ok") && !flat.includes("0 ok"), flat);
  }
});

test("level 1: `- ok` for a provider with no fresh record, `0 ok` only with a fresh record and no ok, a count otherwise", () => {
  const A = prow("personal.a.free", [M("a1"), M("a2")], { provider: "a" });
  const B = prow("personal.b.free", [M("b1"), M("b2")], { provider: "b" });
  const C = prow("personal.c.free", [M("c1"), M("c2")], { provider: "c" });
  const D = prow("personal.d.free", [M("d1")], { provider: "d" });
  const t = tmpBench({
    "a/a1": { s: "gone", a: nowS() },                        // A: fresh, nothing ok  -> 0 ok
    "b/b1": { s: "ok", a: nowS() }, "b/b2": { s: "gone", a: nowS() },   // B: 1 ok
    "c/c1": { s: "ok", a: nowS() - 30 * 86400 },             // C: only a STALE record -> no fresh -> dash
    // D: never benched -> dash
  });
  const b = loadBench(t.file); t.done();
  assert.ok(b.get.records > 0);
  const rows = [A, B, C, D];
  const base = reduce(initState(rows), { benchOf: b.get }).state;
  const meta = { providers: 4, models: 7, benchOf: b.get, benchAsOf: new Date().toISOString() };
  const at = (i) => { let s = base; for (let k = 0; k < i; k++) s = reduce(s, "\x1b[B").state; return reduce(s, "\r").state; };
  assert.equal(view(at(0)).okLive, 0);
  assert.ok(header(at(0), meta).includes("2 of 2 | 0 ok (0%)"), header(at(0), meta));
  assert.equal(view(at(1)).okLive, 1);
  assert.ok(header(at(1), meta).includes("| 1 ok (50%)"), header(at(1), meta));
  assert.equal(view(at(2)).okLive, null, "only a stale record: nothing fresh");
  assert.ok(header(at(2), meta).includes("| - ok"), header(at(2), meta));
  assert.equal(view(at(3)).okLive, null, "never benched");
  // flat total: a number when at least one record is fresh, a dash when none is
  assert.equal(view(reduce(base, "\t").state).okLive, 1);
  const stale = tmpBench({ "a/a1": { s: "ok", a: nowS() - 40 * 86400 } });
  const sb = loadBench(stale.file); stale.done();
  const sst = reduce(reduce(initState(rows), { benchOf: sb.get }).state, "\t").state;
  assert.equal(view(sst).okLive, null, "no fresh record anywhere: `- ok`, not `0 ok`");
});

// -------------------------------------------- 2. allowlist, whole-BMP scan

// An INDEPENDENT display-width table (not the implementation's allowlist): what a terminal occupies.
const WIDE = [[0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab],
  [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50],
  [0x2b55, 0x2b55], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff01, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1faff], [0x20000, 0x3fffd]];
const ZERO = /[\p{M}\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/u;
function wcwidth(cp) {
  const ch = String.fromCodePoint(cp);
  if (ZERO.test(ch) || (cp >= 0x1160 && cp <= 0x11ff)) return 0;
  return WIDE.some(([a, b]) => cp >= a && cp <= b) ? 2 : 1;
}
const width = (s) => [...s].reduce((n, ch) => n + wcwidth(ch.codePointAt(0)), 0);

test("the width table used here really does catch the characters a denylist missed", () => {
  for (const cp of [0xfe10, 0xfe19, 0xa960, 0xa97c]) assert.equal(wcwidth(cp), 2, cp.toString(16));
  for (const cp of [0x00ad, 0x0600, 0x061c, 0x06dd, 0x070f, 0x0890, 0x08e2, 0x180e, 0x2060, 0x2064, 0x206a, 0x206f]) {
    assert.equal(wcwidth(cp), 0, cp.toString(16));
  }
  assert.equal(wcwidth(0x41), 1);
});

test("sanitizeCells leaves exactly ONE column per character for every BMP code point", () => {
  let checked = 0, kept = 0;
  for (let cp = 0; cp <= 0xffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;                     // lone surrogates are not characters
    const ch = String.fromCodePoint(cp);
    const out = sanitizeCells("a" + ch + "b", 80);
    assert.equal(width(out), cps(out), `U+${cp.toString(16).toUpperCase().padStart(4, "0")} -> ${JSON.stringify(out)}`);
    checked++;
    if (out === "a" + ch + "b") kept++;
  }
  assert.ok(checked > 60000);
  assert.ok(kept > 2000, `the allowlist is not empty: ${kept} code points survive as themselves`);
  // and outside the BMP: nothing survives, every character becomes one column
  for (const s of ["🌟", "👨‍👩‍👧‍👦", "\u{20000}", "\u{1D400}"]) {
    const out = sanitizeCells(s, 80);
    assert.equal(width(out), cps(out));
    assert.ok(/^\?+$/.test(out) || out === "", JSON.stringify(out));
  }
});

test("the two reviewer fixtures: 39 wide and 28 zero-width characters no longer move a row", () => {
  assert.equal(sanitizeCells("︐︑vertical", 80), "??vertical");
  assert.equal(width(sanitizeCells("︐︑vertical", 80)), 10);
  const zero = "a­b؀c؜d۝e܏f࢐g࣢h᠎i⁠j⁤k⁪l";
  const out = sanitizeCells(zero, 80);
  assert.equal(width(out), cps(out));
  assert.equal(width(out), 23, "each format character is now a drawn `?`, one column");
  // ordinary text is untouched, and so are Latin, Greek, Cyrillic and the arrows and boxes the renderer uses
  for (const ok of ["model-name_v2.5:latest/x@eu[1m]", "café Ünïcode", "αβγ ДЖЗ", "→ ← ─ │ ▶ ▸".replace("▶", "▸")]) {
    assert.equal(sanitizeCells(ok, 80), ok);
  }
  assert.equal(sanitizeDisplay("︐", 80), "︐", "the underlying sanitiser keeps the original");
});

test("frames built from those characters keep every line at the frame width, measured in display columns", () => {
  const nasty = ["︐︑vertical", "a­b⁠c", "你好", "🌟", "é", "᠎x", "ꥠy"];
  const models = nasty.map((s, i) => M(`id${i}-${s}`));
  const row = prow("personal.你好.free", models, { provider: "x" });
  const bench = Object.fromEntries(models.map((m, i) => [`x/${m.id}`, { s: "ok", t: 100, d: 200, r: 30, a: nowS(), p: `${nasty[i]}${nasty[(i + 1) % nasty.length]}`, k: 0, w: "" }]));
  const benchOf = (t) => bench[t] ?? null;
  for (const env of [ASCII, UNI]) for (const cols of [40, 80, 100, 134]) {
    const caps = detectCaps(env, cols);
    for (const mode of ["l0", "l1", "flat"]) {
      let st = reduce(initState([row]), { benchOf }).state;
      if (mode === "l1") st = { ...st, level: 1, provider: row };
      if (mode === "flat") st = reduce(st, "\t").state;
      const lines = frame(view(st), { providers: 1, models: models.length, keyIdW: 30, flatIdW: 40, benchOf, benchAsOf: new Date().toISOString(), rows: [row] }, { caps }).map(strip);
      for (const l of lines) assert.equal(width(l), frameWidth(caps), `${mode} ${cols}: ${JSON.stringify(l)}`);
    }
  }
});

// -------------------------------------------- 3. flat scope look-alikes

test("flat scope keeps a stable head of the provider name when it has to elide the whole target", () => {
  // The model part alone cannot be made distinct beside a 16-character provider name, so the plan
  // falls back to whole-target elision; two providers with the SAME model ids must still not draw
  // identical cells.
  const long = (d) => "a".repeat(16) + d + "b".repeat(23);
  const mk = (provider) => prow(`personal.${provider}.free`, ["1", "2", "3"].map((d) => M(long(d))), { provider });
  const rows = [mk("aihubmixprovider"), mk("nousresearchlabs")];
  for (const env of [ASCII, UNI]) {
    const caps = detectCaps(env, 80);
    let st = reduce(initState(rows), "\t").state;
    st = { ...st, termRows: 30 };
    const lines = frame(view(st), { providers: 2, models: 6, flatIdW: 60 }, { caps }).map(strip);
    const cells = lines.filter((l) => /aihu|nous/.test(l) && !l.includes("id:")).map((l) => l.slice(5, 5 + 25));
    assert.equal(cells.length, 6);
    assert.ok(cells.every((c) => /^(aihu|nous)/.test(c)), `every cell starts with its provider's first characters: ${cells.join(" | ")}`);
    assert.equal(new Set(cells.filter((c) => c.startsWith("aihu"))).size + new Set(cells.filter((c) => c.startsWith("nous"))).size >= 2, true);
    assert.notEqual(cells[0].slice(0, 4), cells[3].slice(0, 4), "the two providers are told apart");
  }
});

// -------------------------------------------- 4. baked versus live wording

test("the legend says exactly which figures are baked (provider list) and which are live (model lists)", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n");
  assert.match(text, /BAKED into the snapshot/);
  assert.match(text, /model lists read\s+bench\.json LIVE/);
  assert.match(text, /can differ after a new sweep/);
  assert.match(text, /BAKED at snapshot build/);
  assert.match(text, /Model lists count it LIVE/);
  assert.equal(/K ok is read when the snapshot is built/.test(text), false, "the old, wrong sentence is gone");
});

// ---------------------------------------------------- 5. the 10-row terminal

test("a 10-row terminal fits every list screen, even at level 0 with recents and a scroll line", () => {
  const models = Array.from({ length: 30 }, (_, i) => M(`m${i}`));
  const rows = Array.from({ length: 12 }, (_, i) => prow(`personal.p${i}.free`, models, { provider: `p${i}` }));
  const recents = Array.from({ length: 8 }, (_, i) => `p${i}/m${i}`);
  for (const termRows of [10, 11, 12, 24]) {
    const st = initState(rows, { termRows, recents });
    const v = view(st);
    assert.ok(v.recentsHidden > 0, "the `... more recents` line is present (the worst case)");
    assert.ok(v.more > 0, "and so is `... N more`");
    for (const env of [ASCII, UNI]) {
      const lines = frame(v, { providers: 12, models: 360, keyIdW: 30 }, { caps: detectCaps(env, 100) });
      assert.ok(lines.length <= termRows, `level 0 at ${termRows} rows drew ${lines.length}`);
      assert.ok(lines.map(strip).some((l) => l.includes("more recents")));
    }
    for (const [name, s] of [["level 1", { ...initState(rows, { termRows }), level: 1, provider: rows[0] }],
                             ["flat", reduce(initState(rows, { termRows }), "\t").state]]) {
      assert.ok(frame(view(s), { providers: 12, models: 360, flatIdW: 30 }, { caps: detectCaps(ASCII, 100) }).length <= termRows, `${name} at ${termRows}`);
    }
  }
  assert.equal(view(initState(rows, { termRows: 10 })).legendAvail, 2, "the true floor: two rows");
});

// ---------------------------------------- nit: carried counts are re-aged

test("carried counts older than the 14-day window are dropped, not carried", () => {
  const COUNTS = { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };
  const built = { generatedAt: "x", rows: [{ keyId: "personal.a.free", provider: "a", free: 0, planCount: 0, health: "ok", models: [{ id: "m" }] }] };
  const prev = (stamp) => ({ benchAsOf: stamp, rows: [{ keyId: "personal.a.free", provider: "a", bench: COUNTS, benchFlags: { dead: false, needsMoney: false } }] });
  const now = Date.parse("2026-10-01T00:00:00Z");
  const young = buildSnapshot(built, { previous: prev("2026-09-25T00:00:00.000Z"), bench: null, nowMs: now });
  assert.deepEqual(young.rows[0].bench, COUNTS);
  assert.equal(young.benchAsOf, "2026-09-25T00:00:00.000Z");
  const old = buildSnapshot(built, { previous: prev("2026-09-01T00:00:00.000Z"), bench: null, nowMs: now });
  assert.equal(old.rows[0].bench, null, "30 days old: not carried");
  assert.equal(old.benchAsOf, null);
  const future = buildSnapshot(built, { previous: prev("2026-11-01T00:00:00.000Z"), bench: null, nowMs: now });
  assert.equal(future.rows[0].bench, null, "a future stamp is not evidence either");
  assert.equal(buildSnapshot(built, { previous: prev("garbage"), bench: null, nowMs: now }).rows[0].bench, null);
});

// ------------------------------------------------ final cleanup round

import { firstFrame } from "../menu/uwpick.mjs";
import { glyphsFor, confirmLine, painter } from "../menu/style.mjs";

test("a valid but EMPTY bench.json (models: {}) is 'no data': no sweep date, and the empty state says so", () => {
  const rows = [prow("personal.a.free", [M("m1"), M("m2")], { provider: "a" })];
  const t = tmpBench({});
  const b = loadBench(t.file); t.done();
  assert.equal(b.size, 0);
  assert.ok(b.generatedAt, "the file carries a generatedAt, which must not be believed on its own");
  const meta = { providers: 1, models: 2, benchOf: b.get, benchAsOf: b.generatedAt };
  const st = reduce(reduce(initState(rows), { benchOf: b.get }).state, "\r").state;
  const h = stampLine(st, meta);
  assert.ok(h.includes("benched - run bench-cli --live"), h);
  assert.equal(/benched \d\d-\d\d/.test(h), false, "no date beside a dash");
  const flat = stampLine(reduce(reduce(initState(rows), { benchOf: b.get }).state, "\t").state, meta);
  assert.equal(/benched \d\d-\d\d/.test(flat), false, flat);
  // ok-only over no data: the empty state names the reason
  const okOnly = reduce(st, "\x0f").state;
  const lines = frame(view(okOnly), meta, { caps: detectCaps(ASCII, 100) }).map(strip);
  assert.ok(lines.some((l) => l.includes("no benchmark data yet")), lines.join("\n"));
  // a non-empty reader still shows its date and omits the note
  const t2 = tmpBench({ "a/m1": { s: "gone", a: nowS() } });
  const b2 = loadBench(t2.file); t2.done();
  const m2 = { ...meta, benchOf: b2.get, benchAsOf: b2.generatedAt };
  const st2 = reduce(reduce(initState(rows), { benchOf: b2.get }).state, "\r").state;
  assert.ok(/benched \d\d-\d\d/.test(stampLine(st2, m2)));
  assert.equal(frame(view(reduce(st2, "\x0f").state), m2, { caps: detectCaps(ASCII, 100) }).map(strip).some((l) => l.includes("no benchmark data yet")), false);
});

test("level 0: the baked total reads `- ok` unless at least one provider has a fresh record", () => {
  const zero = { ok: 0, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };
  const mk = (bench) => ({ schemaVersion: 7, generatedAt: "x", builtAt: "x", rows: [
    prow("personal.a.free", [M("m1")], { provider: "a", bench }), prow("personal.b.free", [M("m1")], { provider: "b", bench }) ] });
  const okOf = (snap) => firstFrame({ snap, recents: [], favourites: [], caps: detectCaps(ASCII, 100), termRows: 30 }).meta.okTotal;
  assert.equal(okOf(mk(zero)), null, "built with bench data, but nothing fresh: unknown, not 0");
  assert.equal(okOf(mk(null)), null);
  assert.equal(okOf(mk({ ...zero, gone: 3 })), 0, "a fresh record and none ok: a real 0");
  assert.equal(okOf(mk({ ...zero, ok: 2 })), 4);
  const f = firstFrame({ snap: mk(zero), recents: [], favourites: [], caps: detectCaps(ASCII, 100), termRows: 30 });
  const head = strip(f.text.split("\n").find((l) => l.includes("filter:")));
  assert.ok(head.includes("| - ok") && !head.includes("0 ok"), head);
});

test("every glyph the unicode table draws survives sanitizeCells, except the two deliberate, commented exceptions", () => {
  const caps = detectCaps(UNI, 100);
  const g = glyphsFor(caps);
  const flatten = (o) => Object.values(o).flatMap((v) => (typeof v === "object" ? flatten(v) : [v]));
  const EXCLUDED = new Set(["★", "✔"]);      // fav, check: emitted directly, never padded (see the NOTE above UNI)
  const altered = flatten(g).filter((s) => typeof s === "string" && sanitizeCells(s, 80) !== s);
  assert.deepEqual(new Set(altered), new Set([...altered].filter((s) => EXCLUDED.has(s))), `unexpected: ${altered.join(" ")}`);
  assert.deepEqual([...altered].sort(), [...EXCLUDED].sort(), "the exceptions are exactly these two");
  // and they really are drawn intact by the paths that emit them, never through pad
  const p = painter(caps);
  assert.ok(strip(confirmLine("a/b", g, p)).startsWith("✔"));
  const pinnedV = { level: 0, scope: "tree", filter: "", legend: false, cursor: 9, top: 0, empty: false, provider: null, more: 0,
    items: [{ kind: "pinned", mark: "*", target: "acme/x" }] };
  assert.ok(frame(pinnedV, { providers: 0, models: 0 }, { caps }).map(strip).some((l) => l.includes("★ acme/x")));
});

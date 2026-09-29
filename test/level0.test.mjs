// #114 redesign, LEVEL 0: key id | status | [oldest probe] | models | ok | % | [free | %] | empt | auth | pay | rate | gone | t/o | err,
// the pinned strip above the column header, the counts-only header, and the stamps on the id line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps, painter, glyphsFor, frame, frameWidth, layoutFor, pctLabel, pctBlock, pctTone, statusCell,
         statusCount, keyIdWidth, KEYID_MAX, FRAME_MIN, FRAME_MAX, W } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { buildSnapshot } from "../menu/snapshot.mjs";
import { legendLines } from "../menu/legend.mjs";
import { providerAlive, providerStatus, isNoResponse, NO_RESPONSE } from "../menu/route-hints.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const sepOf = (env) => (env === UNI ? "┆" : ":");
const CT = [40, 80, 100, 134, 240, 400];

const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "",
  tools: false, vision: false, reason: false, routable: null }));
const Z = { ok: 0, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };
const prow = (keyId, n, bench, flags = null, o = {}) =>
  ({ keyId, provider: "p", free: 3, planCount: 0, health: "ok", models: mk(n), bench, benchFlags: flags, ...o });
const ALIVE = { dead: false, needsMoney: false, alive: true, status: "alive" }, DEAD = { dead: true, needsMoney: false, alive: false, status: "dead" };
const DOWN = { dead: false, needsMoney: false, alive: true, status: "down" };
const ROWS = [
  prow("p.big.free", 469, { ...Z, ok: 236, empty: 3, auth: 6, pay: 119, rate: 1, gone: 86, timeout: 1, error: 17 }, ALIVE, { free: 20 }),
  prow("p.zero.free", 5, { ...Z }, DEAD, { free: 0 }),
  prow("p.nobench", 3, null, null, { free: null }),
  prow("p.huge.free", 3000, { ...Z, ok: 2500, error: 1000, pay: 999, rate: 5 }, ALIVE, { free: 1 }),
  prow("p.tiny.free", 469, { ...Z, ok: 1, gone: 2 }, ALIVE, { free: 469 }),
];
const META = { providers: ROWS.length, models: 3946, generatedAt: "2026-08-24T12:22:28.162Z", okTotal: 2737,
               routableAsOf: "2026-09-29T10:39:05.361Z", benchCountsAsOf: "2026-09-29T14:29:03.000Z", keyIdW: keyIdWidth(ROWS) };
const shot = (st, meta, env, cols) => frame(view(st), meta, { caps: detectCaps(env, cols) });

// ------------------------------------------------------------------ layout

test("level 0 layout: the key id gets its FULL width first, then oldest probe (13), then the free block (10); it is elided only when even the mandatory columns leave less", () => {
  for (const keyW of [6, 12, 16, 20, 30, 45, KEYID_MAX, 200]) {
    for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
      const L = layoutFor(w, { keyW });
      const avail = w - 3 - 59;                       // mark 2, status 7, models 8, ok 10 (count + percent), seven raw cells 32
      const want = Math.max(6, Math.min(keyW, KEYID_MAX));
      const key = Math.min(want, avail);
      const showProbe = avail - key >= 13;
      const showFree = showProbe && avail - key - 13 >= 10;          // free needs the oldest-probe column too
      assert.equal(L.showProbe, showProbe, `showProbe at ${w} keyW ${keyW}`);
      assert.equal(L.showFree, showFree, `showFree at ${w} keyW ${keyW}`);
      assert.equal(L.W.keyId, key, `keyId at ${w} keyW ${keyW}`);
      assert.equal(Object.hasOwn(L, "showLimit0"), false, "the level-0 limit cell is gone");
      assert.ok(2 + key + 7 + 8 + 10 + (showProbe ? 13 : 0) + (showFree ? 10 : 0) + 32 <= L.inner, `fits at ${w}`);
      // the key id is never cut below its content while the terminal has the room, and free never steals from it
      if (avail >= want) assert.equal(L.W.keyId, want, "whole");
    }
  }
  assert.equal(layoutFor(FRAME_MIN, { keyW: 30 }).W.keyId, 16, "the floor leaves the key id 16 (75 - 59)");
  assert.equal(layoutFor(FRAME_MIN, { keyW: 12 }).W.keyId, 12);
  assert.equal(layoutFor(FRAME_MIN, { keyW: 12 }).showFree, false);
  assert.equal(layoutFor(FRAME_MIN, { keyW: 12 }).showProbe, false, "4 spare columns at the floor: not enough for oldest probe (13)");
  assert.equal(layoutFor(FRAME_MAX, { keyW: 500 }).W.keyId, KEYID_MAX, "a hostile length is capped");
});

test("thresholds: the key id is whole first, then oldest probe, then free; a 30-character and a 45-character id", () => {
  const first = (keyW, pred) => { for (let w = FRAME_MIN; w <= FRAME_MAX; w++) if (pred(layoutFor(w, { keyW }))) return w + 2; return null; };
  // 59 fixed + the id (+ 10 for free) + 3 (frame) + 2 (margin). The longest REAL full key id (bucket included, read
  // from catalog/snapshot.json on 2026-09-30) is 30 characters: personal.experientiallabs.free and personal_maestro.deepseek.paid.
  assert.equal(first(30, (L) => L.W.keyId === 30), 94, "a 30-character id is whole from a 94-column terminal");
  assert.equal(first(30, (L) => L.showProbe), 107, "oldest probe appears 13 columns later");
  assert.equal(first(30, (L) => L.showFree), 117, "and free 10 columns after that: it needs oldest probe too");
  assert.equal(first(45, (L) => L.W.keyId === 45), 109);
  assert.equal(first(45, (L) => L.showProbe), 122);
  assert.equal(first(45, (L) => L.showFree), 132);
  assert.equal(first(27, (L) => L.W.keyId === 27), 91);
  assert.equal(first(27, (L) => L.showProbe), 104);
  assert.equal(first(27, (L) => L.showFree), 114);
  for (let w = FRAME_MIN; w <= FRAME_MAX; w++) { const L = layoutFor(w, { keyW: 30 }); assert.ok(!L.showFree || L.showProbe, "free never shows without oldest probe"); }
  assert.equal(layoutFor(FRAME_MAX, { keyW: 30 }).W.keyId, 30, "wide frames do not pour surplus into the key id");
  assert.equal(FRAME_MAX, 260);
});

// --------------------------------------------------------------- the cells

test("the percent label: nearest integer, <1% for a non-zero count, never 100% for a partial one", () => {
  assert.equal(pctLabel(236, 469), "50%");
  assert.equal(pctLabel(20, 469), "4%");
  assert.equal(pctLabel(1, 469), "<1%", "a non-zero count never reads 0%");
  assert.equal(pctLabel(2, 1000), "<1%");
  assert.equal(pctLabel(469, 469), "100%");
  assert.equal(pctLabel(3, 8), "38%", "37.5 rounds up");
  assert.equal(pctLabel(1, 200), "1%", "0.5 rounds to 1");
  assert.equal(pctLabel(2500, 3000), "83%");
  assert.equal(pctLabel(0, 469), "0%");
});

test("the count and percent sub-columns: no parentheses, right-aligned, 2k from a thousand, blank unknown, dash for zero", () => {
  const p = painter({ ...detectCaps(ASCII, 100), colours: 0 });
  const b = (n, t) => pctBlock(n, t, p, "|");
  assert.equal(b(236, 469), "| 236| 50%", "count in 4, percent in 4");
  assert.equal(b(20, 469), "|  20|  4%");
  assert.equal(b(1, 469), "|   1| <1%", "a non-zero count is never blank or 0%");
  assert.equal(b(469, 469), "| 469|100%");
  assert.equal(b(2500, 3000), "|  2k| 83%");
  assert.equal(b(200000, 300000), "| big| 67%");
  assert.equal(b(0, 469), "|   -|   -", "zero: a dash in both");
  assert.equal(b(NaN, 469), "|" + " ".repeat(4) + "|" + " ".repeat(4), "unknown is blank");
  assert.equal(b(undefined, 469), "|" + " ".repeat(4) + "|" + " ".repeat(4));
  assert.equal(b(5, 0), "|   5|   -", "no denominator: the count, a dash, never a division by zero");
  for (const n of [0, 1, 9, 99, 999, 1234, 99999, 5e6]) assert.equal(cps(b(n, 6000)), 1 + 4 + 1 + 4, String(n));
  for (const bad of [b(1, 469), b(0, 1), b(1, 1)]) assert.equal(/[()]/.test(bad), false);
  assert.equal(/[\u2581-\u2588]/.test(b(300, 469) + b(469, 469)), false, "no block glyph");
});

test("the percent's colour band: 70+ green, 30-69 yellow, under 30 red, zero dim", () => {
  assert.deepEqual([pctTone(70, 100), pctTone(69, 100), pctTone(30, 100), pctTone(29, 100), pctTone(100, 100), pctTone(1, 1000)], ["grn", "yel", "yel", "red", "grn", "red"]);
  assert.equal(pctTone(0, 100), null);
  assert.equal(pctTone(NaN, 100), null);
  assert.equal(pctTone(5, 0), null);
  assert.equal(pctTone(995, 1000), "grn", "a partial 99% is green");
  assert.equal(pctTone(697, 1000), "grn", "the band follows the DISPLAYED percent (69.7% reads 70%)");
  for (const env of [UNI, ASCII]) assert.equal(Object.hasOwn(glyphsFor(detectCaps(env, 100)), "bars"), false, "the block-glyph table is gone");
});

test("the cells are a rule plus right-aligned text of fixed width; ok count green, free count blue, the percent banded, zero dim", () => {
  const p = painter(detectCaps(UNI, 100));
  assert.equal(strip(pctBlock(236, 469, p, "┆")), "┆ 236┆ 50%");
  assert.equal(pctBlock(236, 469, p, "|", "grn"), "|" + p.grn(" 236") + "|" + p.yel(" 50%"), "ok: green count, yellow 50%");
  assert.equal(pctBlock(236, 469, p, "|", "blu"), "|" + p.blu(" 236") + "|" + p.yel(" 50%"), "free: blue count, the same band");
  assert.equal(pctBlock(400, 469, p, "|", "grn"), "|" + p.grn(" 400") + "|" + p.grn(" 85%"));
  assert.equal(pctBlock(20, 469, p, "|", "blu"), "|" + p.blu("  20") + "|" + p.red("  4%"));
  assert.equal(pctBlock(0, 469, p, "|"), "|" + p.dim("   -") + "|" + p.dim("   -"), "zero is dim");
  assert.equal(pctBlock(NaN, 469, p, "|"), "|" + " ".repeat(4) + "|" + " ".repeat(4), "unknown is blank");
  assert.equal(p.blu("x"), "\x1b[94mx\x1b[0m", "blue is bright blue (SGR 94)");
  // colour off: the numbers alone, no escape codes
  const bare = painter({ ...detectCaps(ASCII, 100), colours: 0 });
  assert.equal(pctBlock(236, 469, bare, "|", "blu"), "| 236| 50%");
  assert.equal(statusCell("alive", p, "|"), "|" + p.grn(" alive"));
  assert.equal(statusCell("down", p, "|"), "|" + p.yel("  down"));
  assert.equal(statusCell("dead", p, "|"), "|" + p.red("  dead"));
  assert.equal(statusCell(null, p, "|"), "|" + " ".repeat(6));
  assert.equal(statusCell(undefined, p, "|"), "|" + " ".repeat(6), "an old snapshot has no verdict: blank");
  assert.equal(statusCell(true, p, "|"), "|" + " ".repeat(6), "a boolean (the old flag) is not a status");
  assert.equal(statusCell("\x1b[2Jalive", p, "|"), "|" + " ".repeat(6), "a hostile string is not a status");
  for (const w of ["alive", "down", "dead"]) assert.equal(statusCell(w, bare, "|"), "|" + w.padStart(6));
});

test("the frame draws status, ok and free as designed, on rows that are not selected", () => {
  const caps = detectCaps(UNI, 134);
  const p = painter(caps);
  const st = { ...initState(ROWS), cur: [4, 0, 0] };
  const raw = (id) => shot(st, META, UNI, 134).find((l) => strip(l).includes(id));
  const big = raw("p.big.free");
  assert.ok(big.includes(p.grn(" alive")), "alive is green");
  assert.ok(big.includes(p.grn(" 236") + "\x1b[2m┆\x1b[0m" + p.yel(" 50%")), "ok: green count then a yellow 50% (236 of all 469 models: [no gone] is off)");
  assert.ok(big.includes(p.blu("  20") + "\x1b[2m┆\x1b[0m" + p.red("  4%")), "free: blue count then a red 4%");
  assert.ok(raw("p.zero.free").includes(p.red("  dead")), "dead is red");
  assert.ok(raw("p.zero.free").includes(p.dim("   -")), "zero ok and zero free are dim dashes");
  const t = strip(raw("p.tiny.free"));
  assert.ok(t.includes("   1┆ <1%") && t.includes(" 469┆100%"), t);
  const nb = strip(raw("p.nobench"));
  assert.equal(/alive|down|dead/.test(nb), false, "no bench data: no verdict");
  assert.ok(strip(raw("p.huge.free")).includes("  2k┆ 83%"));
  const table = shot(st, META, UNI, 134).map(strip).slice(3, 10).join("\n");
  for (const gone of ["needs $", "skip", "limit", "▰", "▱", "plan", "(", "▁", "█"]) assert.equal(table.includes(gone), false, `${gone} is gone from the provider list`);
});

// -------------------------------------------- alignment and frame invariants

test("every line is exactly the frame width at every width, in both glyph sets, with and without pins", () => {
  const pins = { favourites: ["p/m1"], recents: ["p/m2", "p/m3"] };
  for (const env of [UNI, ASCII]) for (const cols of CT) {
    const caps = detectCaps(env, cols);
    for (const st of [initState(ROWS), initState(ROWS, pins), { ...initState(ROWS, pins), cur: [1, 0, 0] }]) {
      for (const l of frame(view(st), META, { caps })) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}: ${strip(l)}`);
    }
  }
});

test("header and rows share their rule columns at every width, and the columns sit tight (no gap after free)", () => {
  for (const env of [UNI, ASCII]) {
    const S = sepOf(env);
    for (const cols of [78, 80, 91, 100, 106, 107, 116, 117, 134, 240, 400]) {
      const caps = detectCaps(env, cols);
      const L = layoutFor(frameWidth(caps), { keyW: META.keyIdW });
      const lines = shot(initState(ROWS), META, env, cols).map(strip);
      const head = lines.find((l) => l.includes("key id"));
      const at = (l) => [...l].map((c, i) => (c === S ? i : -1)).filter((i) => i >= 0);
      const want = 4 + (L.showProbe ? 1 : 0) + (L.showFree ? 2 : 0) + 7;              // status, [oldest probe], models, ok, %, [free, %], seven raw cells
      assert.equal(at(head).length, want, `rules in the header at ${cols}`);
      for (const id of ["p.big.free", "p.zero.free", "p.nobench", "p.huge.free"]) {
        const row = lines.find((l) => l.includes(id));
        assert.deepEqual(at(row), at(head), `${id} at ${cols}`);
      }
      const statusCol = 1 + 2 + L.W.keyId, probeCol = statusCol + 7, modelsCol = probeCol + (L.showProbe ? 13 : 0);
      assert.equal(head.slice(statusCol, statusCol + 7), `${S}status`, "status comes right after the key id");
      assert.equal(head.includes("oldest probe"), L.showProbe, `oldest probe at ${cols}`);
      if (L.showProbe) assert.equal(head.slice(probeCol, probeCol + 13), `${S}oldest probe`, "oldest probe comes right after status");
      assert.equal(head.slice(modelsCol, modelsCol + 8), `${S} models`);
      assert.equal(head.includes("free"), L.showFree, `free at ${cols}`);
      // the raw cells begin directly after the last of ok/free: `empt` follows with no blank gap
      const empt = head.indexOf("empt");
      assert.equal(empt, modelsCol + 8 + 10 + (L.showFree ? 10 : 0) + 1);
    }
  }
});

test("on very wide frames the extra width is empty space at the right, never a gap between columns", () => {
  const at = (cols) => shot(initState(ROWS), META, ASCII, cols).map(strip).find((l) => l.includes("key id")).indexOf("models");
  assert.equal(at(240), at(134), "the models column does not move as the frame widens");
  assert.equal(at(400), at(134));
  const row = shot(initState(ROWS), META, ASCII, 240).map(strip).find((l) => l.includes("p.big.free"));
  assert.ok(/err {0}|\d {5,}\|$/.test(row) || row.endsWith(" |"));
});

// ------------------------------------------------------------ header and id line

test("the header's right side is counts only: thousands separators, a middle dot, ok with its share", () => {
  const rows = [prow("p.a", 6000, { ...Z, ok: 1787, gone: 10 }, ALIVE)];
  const meta = { providers: 57, models: 6032, okTotal: 1787, keyIdW: 6 };
  const hdr = (env) => strip(shot(initState(rows), meta, env, 100).find((l) => l.includes("filter:")));
  assert.ok(hdr(UNI).endsWith("57 providers · 6,032 models · 1,787 ok (30%) │"), hdr(UNI));
  assert.ok(hdr(ASCII).endsWith("57 providers | 6,032 models | 1,787 ok (30%) |"), hdr(ASCII));
  assert.equal(hdr(UNI).includes("▸"), false, "no stamp separators in the header any more");
  assert.equal(/routable|bench|discovered/.test(hdr(UNI)), false, "the data stamps moved to the id line");
  const none = strip(shot(initState(rows), { ...meta, okTotal: null }, ASCII, 100).find((l) => l.includes("filter:")));
  assert.ok(none.includes("6,032 models | - ok"), none);
  const zero = strip(shot(initState(rows), { ...meta, okTotal: 0 }, ASCII, 100).find((l) => l.includes("filter:")));
  assert.ok(zero.includes("0 ok (0%)") && !zero.includes("- ok"), zero);
});

test("the stamps sit at the right end of the id: line, whole or dropped, never clipped mid-token", () => {
  for (const env of [UNI, ASCII]) {
    const dot = env === UNI ? "·" : "|";
    const wide = strip(shot(initState(ROWS), META, env, 134).find((l) => /id: /.test(strip(l))));
    assert.ok(wide.includes(`routable 09-29 10:39Z ${dot} bench 09-29 14:29Z`), wide);
    assert.ok(/bench 09-29 14:29Z\s*[│|]$/.test(wide), "right-aligned");
    const idText = wide.slice(0, wide.indexOf("routable")).trim();
    assert.ok(idText.includes("id: p.big.free"), idText);
    // at the floor with a long selected id the fuller stamp is dropped whole, then the next
    const idLine = (n) => strip(shot(initState([prow("p." + "x".repeat(n), 3, null, null)]), { ...META, keyIdW: 6 }, env, 80).find((l) => /id: /.test(strip(l))));
    const mid = idLine(40), long = idLine(50);
    assert.equal(cps(mid), 78);
    assert.ok(mid.includes("bench 09-29 14:29Z") && !mid.includes("routable"), `the fuller stamp is dropped whole: ${mid}`);
    assert.ok(!/routable|bench/.test(long), `then none: ${long}`);
  }
  // no selectable row: the stamps still show, the id does not
  const empty = strip(shot(initState([]), META, ASCII, 100).find((l) => /routable|bench/.test(strip(l))));
  assert.ok(!empty.includes("id:") && empty.includes("bench 09-29 14:29Z"), empty);
  // an invalid or hostile stamp is sanitised and validated exactly as before
  const evil = shot(initState(ROWS), { ...META, routableAsOf: "\x1b]0;PWN\x07\x1b[2J", benchCountsAsOf: "\x1b[31mX" }, UNI, 134).join("\n");
  assert.equal(/\x07|\x1b\]|\x1b\[2J/.test(evil), false);
});

test("the plan-covered count moved to the id line of the selected provider", () => {
  const rows = [prow("p.plan.free", 10, { ...Z, ok: 3 }, ALIVE, { planCount: 4 }), prow("p.none.free", 10, { ...Z, ok: 3 }, ALIVE, { planCount: 0 })];
  const l1 = strip(shot(initState(rows), { ...META, keyIdW: 12 }, ASCII, 134).find((l) => /id: /.test(strip(l))));
  assert.ok(l1.includes("id: p.plan.free  4 plan"), l1);
  const st = reduce(initState(rows), "\x1b[B").state;
  const l2 = strip(shot(st, { ...META, keyIdW: 12 }, ASCII, 134).find((l) => /id: /.test(strip(l))));
  assert.equal(l2.includes("plan"), false);
  assert.equal(view(initState(rows)).fullPlan, 4);
});

// ------------------------------------------------------------- alive / dead

test("alive = anything responded (errors included); dead = every fresh probe was a no-response failure", () => {
  const now = 1_800_000_000_000;
  const rec = (s, p = "", ago = 1000) => ({ s, p, a: Math.floor((now - ago) / 1000) });
  const get = (map) => (t) => map[t] ?? null;
  const models = ["a", "b", "c"].map((id) => ({ id }));
  const alive = (...recs) => providerAlive("x", models.slice(0, recs.length), get(Object.fromEntries(recs.map((r, i) => [`x/${models[i].id}`, r]))), now);
  assert.equal(alive(rec("ok")), true);
  for (const s of ["empty", "auth", "pay", "rate", "gone"]) assert.equal(alive(rec(s, "x: whatever")), true, s);
  for (const msg of ["x: Upstream request failed.", "x: system disk overloaded (current: 91.2%)", "x: bad response status code 503", "x: This model is currently experiencing high demand"]) {
    assert.equal(alive(rec("error", msg)), true, `a provider-side error is a response: ${msg}`);
  }
  assert.equal(alive(rec("timeout")), false);
  assert.equal(alive(rec("error", "x: fetch failed")), false);
  assert.equal(alive(rec("error", "x: Failed to reach upstream provider.")), false);
  assert.equal(alive(rec("error", "x: terminated")), false);
  assert.equal(alive(rec("error", "connect ECONNREFUSED 127.0.0.1:443")), false);
  assert.equal(alive(rec("error", "getaddrinfo ENOTFOUND api.example.com")), false);
  assert.equal(alive(rec("error", "socket hang up")), false);
  assert.equal(alive(rec("timeout"), rec("error", "x: fetch failed"), rec("timeout")), false, "every one is a no-response");
  assert.equal(alive(rec("timeout"), rec("ok")), true, "one response is enough");
  assert.equal(alive(rec("timeout"), rec("error", "x: Upstream request failed.")), true);
  assert.equal(alive(rec("ok", "", 20 * 24 * 3600 * 1000), rec("timeout")), true, "an old answer still keeps it alive: there is no age limit");
  assert.equal(alive(rec("ok", "", -3 * 24 * 3600 * 1000)), null, "a future-dated record is not evidence: no verdict");
  assert.equal(alive(rec("skip")), null, "a skip is not a probe result");
  assert.equal(providerAlive("x", models, null, now), null);
  assert.equal(isNoResponse(null), false);
  assert.ok(NO_RESPONSE instanceof RegExp);
  assert.equal(NO_RESPONSE.test("Upstream request failed."), false);
  assert.equal(NO_RESPONSE.test("terminated by the provider for policy reasons"), false, "only a bare `terminated` counts");
});

// ---------------------------------------------------------- hostile key ids

test("a hostile key id is contained and cannot move a cell", () => {
  const evil = "p.\x1b[2J\x07evil" + "z".repeat(200) + ".free";
  const rows = [prow(evil, 4, { ...Z, ok: 4 }, ALIVE), ROWS[0]];
  const meta = { ...META, keyIdW: keyIdWidth(rows), rows };
  for (const env of [UNI, ASCII]) for (const cols of [80, 134]) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(initState(rows)), meta, { caps });
    const all = lines.join("\n");
    assert.equal(all.includes("\x1b[2J") || all.includes("\x07"), false);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
    const L = layoutFor(frameWidth(caps), { keyW: meta.keyIdW });
    const row = strip(lines[4]);                      // the hostile row is the first table row
    const S = sepOf(env);
    assert.equal(row.slice(1 + 2 + L.W.keyId + 7, 1 + 2 + L.W.keyId + 15), `${S}      4`, "the models cell (after status) is where it always is");
  }
});

// ------------------------------------------------------------ pinned strip

test("pinned rows sit ABOVE the column header, closed by a dim rule; with no pins there is no strip and no rule", () => {
  const pins = { favourites: ["p/m1"], recents: ["p/m2", "p/m3"] };
  for (const env of [UNI, ASCII]) for (const cols of [80, 134, 240]) {
    const caps = detectCaps(env, cols);
    const H = glyphsFor(caps).frame.h;
    const lines = shot(initState(ROWS, pins), META, env, cols).map(strip);
    const head = lines.findIndex((l) => l.includes("key id"));
    const rule = lines.findIndex((l) => l.includes(H.repeat(20)) && !l.includes("UW >") && !/^[+╭╰]/.test(l));
    const pinAt = ["p/m1", "p/m2", "p/m3"].map((t) => lines.findIndex((l) => l.includes(t)));
    assert.deepEqual(pinAt, [3, 4, 5], `the pinned rows come first, right under the filter (cols ${cols})`);
    assert.equal(rule, head - 1, "the rule is the line directly above the column header");
    assert.ok(lines.findIndex((l) => l.includes("p.big.free")) > head, "provider rows follow the header");
    const plain = shot(initState(ROWS), META, env, cols).map(strip);
    const h0 = plain.findIndex((l) => l.includes("key id"));
    assert.equal(h0, 3, "no pins: the header is right under the filter line and its blank");
    assert.equal(plain.some((l, i) => i > 1 && i < h0 && l.includes(H.repeat(20))), false, "and there is no rule");
  }
});

test("the cursor walks the pinned strip first, then the providers, and the selected pinned row inverts whole", () => {
  const pins = { favourites: ["p/m1"], recents: [] };
  let st = initState(ROWS, pins);
  assert.equal(view(st).items[view(st).cursor - view(st).top].kind, "pinned");
  st = reduce(st, "\x1b[B").state;
  assert.equal(view(st).items[view(st).cursor - view(st).top].kind, "provider");
  const raw = shot(initState(ROWS, pins), META, UNI, 134);
  assert.ok(raw[3].includes("\x1b[7m") && strip(raw[3]).includes("p/m1"), "the selected row is the pinned one, inverted whole");
  const moved = shot(reduce(initState(ROWS, pins), "\x1b[B").state, META, UNI, 134);
  assert.equal(moved[3].includes("\x1b[7m"), false, "and the inverse moves with the cursor");
  assert.ok(moved.slice(4).some((l) => l.includes("\x1b[7m")));
});

// --------------------------------------------------------------- reply line

const NOW = 1_800_000_000_000;
const recOf = (p, extra = {}) => ({ s: "ok", a: Math.floor(NOW / 1000) - 60, p, w: "", ...extra });
const modelState = (models, benchOf, termRows = 30) => {
  const row = { keyId: "p.a.free", provider: "p", free: 0, planCount: 0, health: "ok", models };
  return { row, st: { ...initState([row], { nowMs: NOW, termRows }), level: 1, provider: row }, benchOf };
};
const metaFor = (benchOf) => ({ providers: 1, models: 2, benchOf, keyIdW: 30 });
const replyLine = (lines) => lines.map(strip).find((l) => /reply:/.test(l));

test("model level draws a `reply:` line under the id line: the selected row's stored reply, whole, sanitised", () => {
  const models = [{ ...mk(1)[0], id: "m0" }, { ...mk(1)[0], id: "m1" }];
  const said = "Hello there, nice to meet you and welcome to the picker";
  const benchOf = (t) => (t === "p/m0" ? recOf(said) : null);
  for (const env of [UNI, ASCII]) for (const cols of [80, 134, 240]) {
    const caps = detectCaps(env, cols);
    const { st } = modelState(models, benchOf);
    const lines = frame(view(st), metaFor(benchOf), { caps });
    const text = lines.map(strip);
    const idAt = text.findIndex((l) => /id: p\/m0|id: m0/.test(l));
    assert.ok(idAt > 0, "the id line is there");
    assert.equal(text[idAt + 1].includes("reply: " + said), true, `cols ${cols}: ${text[idAt + 1]}`);
    assert.equal(text.length - 2, idAt + 1, "the reply line is the last line before the footer");
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
    // moving to a row nobody benched: the line stays, empty
    const moved = frame(view(reduce(st, "\x1b[B").state), metaFor(benchOf), { caps }).map(strip);
    assert.equal(moved.some((l) => /reply:/.test(l)), false);
    assert.equal(moved.length, text.length, "the frame height does not change with the selection");
  }
});

test("the reply is clipped with an ellipsis only when longer than the frame; a hostile reply cannot break out", () => {
  const evil = "\x1b]0;PWN\x07\x1b[2Jhi " + "word ".repeat(200) + "TAIL";
  const benchOf = () => recOf(evil, { p: evil });
  for (const env of [UNI, ASCII]) for (const cols of [40, 80, 134]) {
    const caps = detectCaps(env, cols);
    const { st } = modelState(mk(2), benchOf);
    const lines = frame(view(st), metaFor(benchOf), { caps });
    const all = lines.join("\n");
    assert.equal(/\x07|\x1b\]/.test(all) || all.includes("\x1b[2J"), false);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const r = replyLine(lines);
    assert.ok(r && r.includes(glyphsFor(caps).ell), "an over-long reply ends in the ellipsis");
    assert.equal(r.includes("TAIL"), false, "clipped at the end, not the start");
  }
});

test("flat scope draws the reply line too", () => {
  const benchOf = (t) => (t.endsWith("m0") ? recOf("flat reply") : null);
  const row = { keyId: "p.a.free", provider: "p", free: 0, planCount: 0, health: "ok", models: mk(2) };
  const st = reduce(initState([row], { nowMs: NOW }), "\t").state;
  const lines = frame(view(st), { providers: 1, models: 2, benchOf, flatIdW: 30 }, { caps: detectCaps(ASCII, 100) });
  assert.ok(replyLine(lines)?.includes("reply: flat reply"), replyLine(lines));
});

// ----------------------------------------------------------------- heights

test("no screen exceeds the terminal height from 10 to 50 rows: reducer and renderer agree on the page size", () => {
  const many = { keyId: "p.many.free", provider: "p", free: 0, planCount: 0, health: "ok", models: mk(200) };
  const rows = [many, ...ROWS];
  const pins = { favourites: ["p/m1", "p/m2"], recents: ["p/m3", "p/m4", "p/m5"] };
  const benchOf = () => recOf("a reply");
  for (const termRows of [10, 11, 12, 14, 20, 24, 30, 40, 50]) {
    const cases = [
      ["level 0", initState(rows, { termRows }), 0],
      ["level 0 + pins", initState(rows, { ...pins, termRows }), 1],
      ["level 1", { ...initState(rows, { termRows, nowMs: NOW }), level: 1, provider: many }, 1],
      ["flat", reduce(initState(rows, { termRows, nowMs: NOW }), "\t").state, 1],
    ];
    for (const [name, st, extra] of cases) {
      const v = view(st);
      const lines = frame(v, { ...META, rows, benchOf, flatIdW: 30 }, { caps: detectCaps(UNI, 134) });
      assert.equal(v.legendAvail, Math.max(1, termRows - 8 - (name === "level 0 + pins" ? 1 : extra)), `${name} at ${termRows}`);
      assert.ok(v.items.length <= v.legendAvail || name === "level 0 + pins", `${name}: items fit the page`);
      assert.ok(lines.length <= termRows, `${name} at ${termRows} rows drew ${lines.length}`);
    }
  }
});

// ------------------------------------------------- cut and broken streams

test("a cut stream blanks total, draws tok/s as an estimate (~), and the reply line says [cut]; a stream error says [stream error]", () => {
  const recs = {
    "p/whole": recOf("Hello there", { t: 800, d: 1500, r: 40 }),
    "p/cut": recOf("Hello there and on and on", { t: 800, d: 9000, r: 56.4, o: 300, x: 1 }),
    "p/cutnorate": recOf("Hi", { t: 800, d: 9000, r: null, x: 1 }),
    "p/broke": recOf("Partial answer", { t: 800, d: 2000, r: null, m: "stream error after first token: upstream reset\x1b[2J" }),
  };
  const benchOf = (t) => recs[t] ?? null;
  const models = ["whole", "cut", "cutnorate", "broke"].map((id) => ({ ...mk(1)[0], id }));
  for (const env of [UNI, ASCII]) for (const cols of [134, 240]) {
    const caps = detectCaps(env, cols);
    const S = sepOf(env);
    const cellsOf = (name) => strip(frame(view(modelState(models, benchOf).st), metaFor(benchOf), { caps }).find((l) => strip(l).split(S)[0].trim().endsWith(name) && !l.includes("id:")));
    const at = (row, n) => row.split(S)[n].trim();   // 0 id, 1 stat, 2 ttft, 3 total, 4 tok/s
    assert.deepEqual([at(cellsOf("whole"), 3), at(cellsOf("whole"), 4)], ["1.50s", "40"]);
    assert.deepEqual([at(cellsOf("cut"), 3), at(cellsOf("cut"), 4)], ["", "~56"], "no total for a cut stream; an estimated rate");
    assert.deepEqual([at(cellsOf("cutnorate"), 3), at(cellsOf("cutnorate"), 4)], ["", "-"]);
    assert.equal(at(cellsOf("broke"), 3), "2.00s", "an ok record with a stream error keeps its cells");
  }
  const reply = (i) => {
    const { st } = modelState(models, benchOf);
    let s = st; for (let k = 0; k < i; k++) s = reduce(s, "\x1b[B").state;
    const lines = frame(view(s), metaFor(benchOf), { caps: detectCaps(ASCII, 134) });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(detectCaps(ASCII, 134)));
    assert.equal(lines.join("").includes("\x1b"), false);
    return replyLine(lines);
  };
  assert.match(reply(0), /reply: Hello there +\|$/);
  assert.match(reply(1), /reply: \[cut\] Hello there and on and on/);
  assert.match(reply(3), /reply: \[stream error\] Partial answer +\(upstream reset/);
  assert.equal((reply(3).match(/stream error/g) ?? []).length, 1, "the words are not doubled");
});

// ------------------------------------------------- what counts as no response

test("a timeout is no-response only when nothing came back: a timeout that got its first token is a response", () => {
  const now = 1_800_000_000_000, a = Math.floor(now / 1000) - 60;
  assert.equal(isNoResponse({ s: "timeout", d: 35000, a }), true, "no first token");
  assert.equal(isNoResponse({ s: "timeout", t: null, d: 35000, a }), true);
  assert.equal(isNoResponse({ s: "timeout", t: 900, d: 35000, a }), false, "it got a first token: something answered");
  assert.equal(isNoResponse({ s: "timeout", t: 0, d: 35000, a }), false, "0 ms is still a number");
  const get = (recs) => (t) => recs[t] ?? null;
  const models = [{ id: "a" }, { id: "b" }];
  assert.equal(providerAlive("x", models, get({ "x/a": { s: "timeout", d: 35000, a }, "x/b": { s: "timeout", t: 500, d: 35000, a } }), now), true,
    "one timeout with a first token keeps the provider alive");
  assert.equal(providerAlive("x", models, get({ "x/a": { s: "timeout", d: 35000, a }, "x/b": { s: "timeout", d: 35000, a } }), now), false);
});

test("each NO_RESPONSE pattern matches on its own, with the backslashes intact", () => {
  const now = 1_800_000_000_000, a = Math.floor(now / 1000) - 60;
  const yes = ["fetch failed", "Failed to reach upstream provider", "no complete answer within 35000 ms", "read ECONNRESET", "connect ECONNREFUSED 1.2.3.4:443",
    "ECONNABORTED", "getaddrinfo ENOTFOUND api.example.com", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "socket hang up",
    "socket hangup", "other side closed", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT: x",
    "connect timed out", "connection refused", "connection reset", "connection closed", "network error", "network request failed",
    "terminated", "terminated.", "x: terminated", "TERMINATED"];
  for (const t of yes) assert.equal(NO_RESPONSE.test(t), true, t);
  for (const t of ["UND_ERR", "UND_ERR_", "UND_ERRw", "terminated by the provider", "not terminated", "Upstream request failed.", "overloaded", "connect ok"]) {
    assert.equal(NO_RESPONSE.test(t), false, t);
  }
  // through isNoResponse, from either text field, with nothing else in the record
  for (const t of ["terminated", "x: terminated.", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]) {
    assert.equal(isNoResponse({ s: "error", m: t, a }), true, `m: ${t}`);
    assert.equal(isNoResponse({ s: "error", p: t, a }), true, `p: ${t}`);
    assert.equal(isNoResponse({ s: "error", m: "HTTP 200 fine", p: t, a }), true, `p after an unrelated m: ${t}`);
  }
  assert.equal(isNoResponse({ s: "error", m: "terminated by policy", a }), false);
  assert.equal(isNoResponse({ s: "gone", m: "terminated", a }), false, "only an error status can be a connection failure");
});

// ------------------------------------------------------ 100% means every one

test("a partial count is never 100%: 995 of 1000 and 201 of 202 read 99%, and the full count still reads 100%", () => {
  assert.equal(pctLabel(995, 1000), "99%");
  assert.equal(pctLabel(999, 1000), "99%");
  assert.equal(pctLabel(201, 202), "99%");
  assert.equal(pctLabel(1000, 1000), "100%");
  assert.equal(pctLabel(202, 202), "100%");
  assert.equal(pctLabel(1, 1), "100%");
  assert.equal(pctLabel(1, 300), "<1%");
  assert.equal(pctLabel(1, 200), "1%", "0.5% rounds to 1");
  assert.equal(pctLabel(994, 1000), "99%");
  // the row cells
  const p = painter(detectCaps(ASCII, 100));
  assert.equal(strip(pctBlock(995, 1000, p, ":")), ": 995: 99%", "a partial count reads 99%, never 100%");
  assert.equal(strip(pctBlock(1000, 1000, p, ":")), ":  1k:100%");
  assert.equal(strip(pctBlock(201, 202, p, ":")), ": 201: 99%");
  // the header's `K ok (P%)`, at level 1 and on the provider list
  const models = Array.from({ length: 202 }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "", tools: false, vision: false, reason: false, routable: null }));
  const now = 1_800_000_000_000;
  const benchOf = (t) => (Number(/m(\d+)$/.exec(t)?.[1]) < 201 ? { s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" } : null);
  const row = { keyId: "p.a.free", provider: "p", free: 0, planCount: 0, health: "ok", models };
  const st = { ...reduce(initState([row], { nowMs: now }), { benchOf }).state, level: 1, provider: row };
  const head = frame(view(st), { providers: 1, models: 202, benchOf, keyIdW: 30 }, { caps: detectCaps(ASCII, 100) }).map(strip).find((l) => l.includes("filter:"));
  assert.ok(head.includes("202 of 202 | 201 ok (99%)"), head);
  const all = { ...reduce(initState([row], { nowMs: now }), { benchOf: () => ({ s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" }) }).state, level: 1, provider: row };
  const head2 = frame(view(all), { providers: 1, models: 202, benchOf: () => ({ s: "ok", a: Math.floor(now / 1000) - 60, p: "", w: "" }), keyIdW: 30 }, { caps: detectCaps(ASCII, 100) }).map(strip).find((l) => l.includes("filter:"));
  assert.ok(head2.includes("202 ok (100%)"), head2);
});

test("the plan tail on the id line is drawn only for a real positive number: a tampered planCount draws nothing", () => {
  const idLine = (planCount) => {
    const row = { ...prow("p.plan.free", 3, null, null, { planCount }) };
    const lines = frame(view(initState([row])), { providers: 1, models: 3, keyIdW: 30 }, { caps: detectCaps(ASCII, 100) });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(detectCaps(ASCII, 100)));
    assert.equal(lines.join("").includes("\n"), false);
    return lines.map(strip).find((l) => l.includes("id: "));
  };
  assert.match(idLine(4), /id: p\.plan\.free  4 plan/);
  for (const bad of ["\n5", "5", "\x1b[2J5", NaN, Infinity, -3, 0, null, undefined, {}, [], true]) {
    assert.doesNotMatch(idLine(bad), /plan\b(?!\.)/, JSON.stringify(bad));
  }
});

test("a timeout that got its first token shows that ttft; one that got nothing shows none", () => {
  const recs = { "p/slow": recOf("", { s: "timeout", t: 1500, d: 35000, p: "" }), "p/dead": recOf("", { s: "timeout", t: null, d: 35000, p: "" }) };
  const benchOf = (t) => recs[t] ?? null;
  const models = ["slow", "dead"].map((id) => ({ ...mk(1)[0], id }));
  const caps = detectCaps(ASCII, 134);
  const rowOf = (name) => strip(frame(view(modelState(models, benchOf).st), metaFor(benchOf), { caps }).find((l) => strip(l).split(":")[0].trim().endsWith(name) && !l.includes("id:")));
  const cell = (row, n) => row.split(":")[n].trim();   // 0 id, 1 stat, 2 ttft, 3 total
  assert.equal(cell(rowOf("slow"), 2), "1.50s", "the first token did arrive");
  assert.equal(cell(rowOf("slow"), 3), "35.0s");
  assert.equal(cell(rowOf("dead"), 2), "", "nothing came back");
  assert.equal(cell(rowOf("dead"), 3), "35.0s");
});

// ------------------------------------------------ the three-state status

test("status: alive = a fresh ok; down = answered but nothing ok; dead = every fresh probe got no response; blank = nothing fresh", () => {
  const now = 1_800_000_000_000;
  const rec = (s, o = {}, ago = 1000) => ({ s, a: Math.floor((now - ago) / 1000), p: "", ...o });
  const models = ["a", "b", "c", "d"].map((id) => ({ id }));
  const get = (recs) => (t) => recs[Number(/\/(.)$/.exec(t)?.[1] ? "abcd".indexOf(/\/(.)$/.exec(t)[1]) : -1)] ?? null;
  const st = (...recs) => providerStatus("x", models, get(recs), now);
  // alive: one ok is enough, whatever else there is
  assert.equal(st(rec("ok")), "alive");
  assert.equal(st(rec("auth"), rec("ok"), rec("timeout")), "alive");
  // down: at least one record, none ok, at least one that answered
  for (const s of ["auth", "pay", "gone", "empty", "rate"]) assert.equal(st(rec(s)), "down", s);
  assert.equal(st(rec("error", { p: "x: Upstream request failed." })), "down", "a provider-side error body is an answer");
  assert.equal(st(rec("error", { m: "system disk overloaded" })), "down");
  assert.equal(st(rec("timeout", { t: 900, d: 35000 })), "down", "a timeout that returned a first token answered");
  assert.equal(st(rec("timeout"), rec("auth")), "down", "one answer among no-responses is enough");
  assert.equal(st(rec("error", { m: "fetch failed" }), rec("gone")), "down");
  // dead: every fresh record is a no-response
  assert.equal(st(rec("timeout")), "dead", "an empty timeout");
  assert.equal(st(rec("error", { m: "fetch failed" })), "dead");
  assert.equal(st(rec("error", { m: "Failed to reach upstream provider." }), rec("timeout"), rec("error", { p: "terminated" })), "dead");
  // blank: nothing usable
  assert.equal(st(), null);
  assert.equal(st(rec("ok", {}, 30 * 24 * 3600 * 1000)), "alive", "an old ok still counts");
  assert.equal(st(rec("ok", {}, -3 * 24 * 3600 * 1000)), null, "a future-dated record is not evidence");
  assert.equal(st(rec("skip")), null, "a skip is not a probe result");
  assert.equal(st(rec("ok", {}, 30 * 24 * 3600 * 1000), rec("timeout")), "alive", "an old ok is still an ok");
  assert.equal(st(rec("skip"), rec("auth")), "down", "a skip is ignored, not counted");
  assert.equal(providerStatus("x", models, null, now), null);
  assert.equal(providerStatus("x", [], get([]), now), null);
});

test("the tri-state is baked into benchFlags.status, next to the legacy alive/dead/needsMoney flags", () => {
  const now = 1_800_000_000_000;
  const a = Math.floor(now / 1000) - 60;
  const m = (id) => ({ id, ctx: null, pin: null, pout: null, badge: "", tools: null, vision: null, reason: null, outputKind: null, routable: null, provenance: null, mode: false });
  const built = (n, models) => ({ keyId: `p.${n}.free`, provider: n, free: 0, planCount: 0, health: "ok", models });
  const recs = { "up/a": { s: "ok", a }, "dn/a": { s: "auth", a }, "dd/a": { s: "timeout", a }, "dd/b": { s: "error", m: "fetch failed", a } };
  const bench = { generatedAt: "2026-09-29T00:00:00Z", size: 4, get: (t) => recs[t] ?? null };
  const snap = buildSnapshot({ generatedAt: "x", rows: [built("up", [m("a")]), built("dn", [m("a")]), built("dd", [m("a"), m("b")]), built("nb", [m("a")])] }, { bench, nowMs: now });
  const by = Object.fromEntries(snap.rows.map((r) => [r.provider, r.benchFlags]));
  assert.equal(by.up.status, "alive");
  assert.equal(by.dn.status, "down");
  assert.equal(by.dd.status, "dead");
  assert.equal(by.nb, null, "nothing fresh: no flags at all, drawn blank");
  assert.equal(by.dn.alive, true, "the legacy two-state flag is unchanged: it answered");
  assert.equal(by.dd.alive, false);
  assert.ok("dead" in by.dn && "needsMoney" in by.dn, "the sweep's own flags are still there");
  assert.equal(snap.schemaVersion, 9);
});

// ------------------------------------------- tampered data, legend, all widths

test("tampered counts and statuses draw blank, never data, and every line keeps the frame width in both glyph sets", () => {
  const evil = [{ ...prow("p.evil1.free", 10, { ...Z, ok: "\x1b[2J9", empty: {}, auth: "5" }, { ...ALIVE, status: "\x1b[31mdead" }, { free: "\x07" }) },
                { ...prow("p.evil2.free", 10, { ...Z, ok: Infinity, gone: -4 }, { ...ALIVE, status: 3 }, { free: NaN }) },
                { ...prow("p.evil3.free", 10, { ...Z, ok: 4 }, { ...ALIVE, status: "alive" }, { free: 1e12 }) }];
  for (const env of [UNI, ASCII]) for (const cols of CT) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(initState(evil)), { ...META, rows: evil, keyIdW: keyIdWidth(evil) }, { caps });
    const all = lines.join("\n");
    assert.equal(/\x07|\x1b\[2J|\x1b\[31m(?!.*\x1b\[0m)/.test(strip(all)), false);
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(strip(all)), false);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const row = (id) => strip(lines.find((l) => strip(l).includes(id)));
    assert.equal(/alive|down|dead/.test(row("evil1") + row("evil2")), false, "a hostile status is blank");
    assert.ok(row("evil3").includes("alive"));
  }
});

test("the legend defines the three states and the percent bands, with no block glyph", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  for (const env of [UNI, ASCII]) {
    const g = glyphsFor(detectCaps(env, 100));
    const text = legendLines(g, stub, { provenanceDot: () => "#" }).join("\n");
    for (const w of ["alive", "down", "dead", "70% and up", "30% to 69%", "under 30%", "%", "free"]) assert.ok(text.includes(w), `legend mentions ${w}`);
    assert.equal(/[\u2581-\u2588]/.test(text), false, "no block glyph");
    assert.equal(text.includes("(PCT%)"), false);
    assert.equal(/\x1b/.test(text), false);
  }
});

// ------------------------------------------------------ full key ids

test("the longest key ids are drawn whole whenever the terminal has the width, and elided (with a marker) only below it", () => {
  const long45 = "relay." + "x".repeat(12) + ".anthropic.subscription.longtier".slice(0, 27);       // 45 characters
  assert.equal(long45.length, 45);
  const ids = ["personal.google.free", "personal.openrouter.free", "personal_mxene.alibaba.paid", "personal.nousresearch.free", long45];
  const rows = ids.map((id) => prow(id, 3, { ...Z, ok: 1 }, ALIVE));
  const shown = (id) => id;                                  // the FULL id is drawn: no bucket is dropped
  const keyW = keyIdWidth(rows);
  assert.equal(keyW, 45, "the longest full id, over all rows");
  const meta = { ...META, rows, keyIdW: keyW, providers: rows.length };
  const need = 45 + 59 + 3 + 2;                              // the terminal width at which the 45-character id is whole
  for (const env of [UNI, ASCII]) {
    const ell = glyphsFor(detectCaps(env, 100)).elide;
    for (const cols of [134, 240, need]) {
      const lines = frame(view(initState(rows)), meta, { caps: detectCaps(env, cols) }).map(strip);
      for (const id of ids) assert.ok(lines.some((l) => l.includes(shown(id))), `${shown(id)} whole at ${cols}`);
      assert.equal(lines.some((l) => l.includes(ell) && /google|openrouter|alibaba|nousresearch|relay/.test(l) && l.split(sepOf(env))[0].includes(ell)), false, `no elision at ${cols}`);
    }
    const narrow = frame(view(initState(rows)), meta, { caps: detectCaps(env, need - 1) }).map(strip);
    assert.equal(narrow.some((l) => l.includes(shown(long45))), false, "one column short: the 45-character id is elided");
    assert.ok(narrow.some((l) => l.split(sepOf(env))[0].includes(ell)), "with a visible marker");
    for (const cols of [80, 100, 134, 240]) {
      const caps = detectCaps(env, cols);
      const lines = frame(view(initState(rows)), meta, { caps });
      for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
      const text = lines.map(strip);
      const head = text.find((l) => l.includes("key id"));
      const at = (l) => [...l].map((c, i) => (c === sepOf(env) ? i : -1)).filter((i) => i >= 0);
      const hi = text.indexOf(head);
      ids.forEach((id, i) => assert.deepEqual(at(text[hi + 1 + i]), at(head), `${id} at ${cols}`));
    }
  }
  // oldest probe and free never take the id's room: they appear only after the whole id
  const L = (cols) => layoutFor(cols - 2, { keyW: 45 });
  assert.equal(L(need).W.keyId, 45);
  assert.equal(L(need).showFree, false);
  assert.equal(L(need).showProbe, false);
  assert.equal(L(need + 13).showProbe, true, "oldest probe appears 13 columns after the whole id");
  assert.equal(L(need + 13).showFree, false);
  assert.equal(L(need + 23).showFree, true, "and free 10 columns after that");
  assert.equal(L(need + 23).W.keyId, 45);
});

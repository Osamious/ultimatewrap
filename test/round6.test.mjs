// Round 6: review fixes (carry across a rebuild, the empty-state explanation, the legend page size, probe-only stamps,
// stale wording) and the model list's `probed` column (per-model age, right after `stat`, no older column moves).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initState, reduce, view, carryAcrossRebuild, TOGGLE_DEFAULTS, BENCH_FIELDS } from "../menu/pick-state.mjs";
import { detectCaps, painter, frame, frameWidth, layoutFor, probedCell, ageLabel, FRAME_MIN, FRAME_MAX, MODEL_ID_MIN, MODEL_ID_MAX } from "../menu/style.mjs";
import { legendLines } from "../menu/legend.mjs";
import { loadSnapshot, SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";
import { ageHistOf, oldestStampOf, loadBench, recordAge, PROBE_AGE_BANDS_S, BENCH_OUTDATED_DAYS } from "../menu/bench-data.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const sepOf = (env) => (env === UNI ? "┆" : ":");
const NOW = Date.parse("2026-10-06T12:00:00Z");
const DAY = 86400, HOUR = 3600, MIN = 60;
const sec = (ms) => Math.floor(ms / 1000);
const M = (id, o = {}) => ({ id, ctx: 128000, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true, ...o });
const row = (provider, models, o = {}) => ({ keyId: `personal.${provider}.free`, provider, free: 0, planCount: 0, health: "ok", models, ...o });

// ------------------------------------------------------------------ A1: carry across a rebuild

test("carryAcrossRebuild keeps every toggle and the bench reader with its stamp and histograms", () => {
  const rows = [row("p", [M("a")])];
  const get = () => null; get.records = 1;
  const hist = new Map([["personal.p.free", [[1, 1]]]]);
  let old = initState(rows, { nowMs: NOW, benchOldestAt: "2026-09-01T00:00:00Z" });
  old = { ...old, okOnly: true, oneM: true, hideGone: true, freeOnly: true, benchOf: get, benchHist: hist, cur: [0, 3, 0], q: ["x", "y", "z"] };
  const rebuilt = carryAcrossRebuild(old, initState(rows, { nowMs: NOW, favourites: ["p/a"] }));
  assert.deepEqual([rebuilt.okOnly, rebuilt.oneM, rebuilt.hideGone, rebuilt.freeOnly], [true, true, true, true]);
  assert.equal(rebuilt.benchOf, get);
  assert.equal(rebuilt.benchHist, hist);
  assert.equal(rebuilt.benchOldestAt, "2026-09-01T00:00:00Z");
  assert.deepEqual(rebuilt.pinned.map((p) => p.target), ["p/a"], "what initState derived is the new one's");
  assert.deepEqual(rebuilt.q, ["", "", ""], "the cursor and filters restart");
});

test("the carried toggle list IS the toggle fields initState defines: a new toggle cannot be silently dropped", () => {
  const fresh = initState([row("p", [M("a")])], { nowMs: NOW });
  // every TOGGLE_DEFAULTS key is a real field of a fresh state with its default, and each one survives a rebuild (below); a future
  // boolean that is NOT a toggle needs no entry here, and a new toggle only has to be added to TOGGLE_DEFAULTS, the one list initState spreads
  for (const k of Object.keys(TOGGLE_DEFAULTS)) assert.equal(fresh[k], TOGGLE_DEFAULTS[k], k);
  for (const [k, v] of Object.entries(fresh)) if (typeof v === "boolean") assert.ok(Object.hasOwn(TOGGLE_DEFAULTS, k), `${k}: a boolean state flag that is not in TOGGLE_DEFAULTS is dropped by a rebuild; add it there`);
  // and each one really survives: flip it on the old state, read it back off the rebuilt one
  for (const k of [...Object.keys(TOGGLE_DEFAULTS)]) {
    const old = { ...fresh, [k]: !fresh[k] };
    assert.equal(carryAcrossRebuild(old, initState([row("p", [M("a")])], { nowMs: NOW }))[k], !fresh[k], k);
  }
  for (const k of BENCH_FIELDS) assert.ok(Object.hasOwn(fresh, k), `${k} is a state field`);
  assert.equal(fs.readFileSync(new URL("../menu/uwpick.mjs", import.meta.url), "utf8").includes("carryAcrossRebuild("), true, "uwpick uses it");
});

// -------------------------------------------------- A2: the empty-state explanation is never clipped

test("the empty-state explanation fits the frame with all four toggles on, at 78/80/100/240 columns in both glyph sets", () => {
  const rows = [row("p", [M("a")])];
  let s = reduce(initState(rows, { nowMs: NOW, termRows: 30 }), "\r").state;
  for (const k of ["\x0f", "\x0c", "\x18", "\x05"]) s = reduce(s, k).state;         // ok, 1M+, gone, free
  assert.equal(view(s).empty, true);
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 240]) {
    const caps = detectCaps(env, cols);
    const lines = frame(view(s), { providers: 1, models: 1, rows, keyIdW: 20 }, { caps }).map(strip);
    for (const l of lines) assert.equal(cps(l), frameWidth(caps));
    const line = lines.find((l) => l.includes("filtered by"));
    assert.ok(line, `explanation at ${cols}`);
    const body = line.replace(/^[│|]\s*/, "").replace(/\s*[│|]$/, "");
    const d = env === UNI ? "—" : "-";
    const tiers = [`filtered by ok-only + 1M+ context only + gone routes hidden + FREE / FREE? only ${d} no benchmark data yet`,
                   `filtered by ok + 1M+ + no gone + free ${d} no benchmark data yet`, `filtered by ok + 1M+ + no gone + free ${d} no data`];
    assert.ok(tiers.includes(body), `${cols}: not a whole tier: "${body}"`);
    if (cols === 240) assert.equal(body, tiers[0], "the long names when they fit");
    if (cols <= 100) assert.notEqual(body, tiers[0]);
  }
});

// ------------------------------------------ A3: the legend page keeps every row while the notice is active

test("the legend and the withheld overlay lose no row to the outdated notice, which they do not draw", () => {
  const H = Math.floor((NOW - 9 * DAY * 1000) / 3600_000);
  const old = [{ ...row("p", [M("a")]), benchAgeHist: [[H, 1]] }], fresh = [{ ...row("p", [M("a")]), benchAgeHist: [[Math.floor(NOW / 3600_000), 1]] }];
  const mk = (rows) => initState(rows, { nowMs: NOW, termRows: 24, benchOldestAt: "2026-09-27T00:00:00Z" });
  assert.equal(view(mk(old)).notice, "2026-09-27");
  assert.equal(view(mk(fresh)).notice, null);
  const avail = (st) => view(st).legendAvail;
  assert.equal(avail(reduce(mk(old), "?").state), avail(reduce(mk(fresh), "?").state), "the legend page size does not depend on the notice");
  assert.equal(avail(mk(old)) + 1, avail(mk(fresh)), "a list screen still gives up one row to it");
  for (const env of [UNI, ASCII]) {
    const caps = detectCaps(env, 100);
    const shown = (rows) => frame(view(reduce(mk(rows), "?").state), { providers: 1, models: 1, rows, keyIdW: 20 }, { caps });
    assert.equal(shown(old).length, shown(fresh).length, "the legend screen is the same height with and without the notice");
    assert.ok(shown(old).length <= 24);
    assert.equal(strip(shown(old).join(" ")).includes("bench-cli.mjs --live"), false, "and it does not draw the notice");
  }
  // the withheld overlay is a modal that does not draw the notice either: same page size with and without it
  const wrow = (r) => ({ ...r, refused: Array.from({ length: 40 }, (_, i) => ({ id: `w${i}`, reason: "x" })) });
  const overlay = (rows) => { const w = rows.map(wrow); return view(reduce(reduce(mk(w), "\r").state, "\x12").state); };
  assert.ok(overlay(old).refusals, "the overlay is open");
  assert.equal(overlay(old).refusals.items.length, overlay(fresh).refusals.items.length, "the withheld overlay page does not depend on the notice");
  // closing the legend re-clamps nothing it should not: the cursor stays on screen
  let s = mk(old);
  s = reduce(reduce(s, "?").state, "x").state;
  assert.ok(view(s).cursor >= view(s).top && view(s).cursor < view(s).top + Math.max(1, view(s).legendAvail));
});

// ---------------------------------- A4: only probe results have a stamp (a skip and an invalid status have none)

test("ageHistOf and oldestStampOf ignore skip records and records with an invalid status; get.stamp follows the same rule", () => {
  const models = ["ok", "skip", "bad", "nostatus", "noa"].map((id) => M(id));
  const a = sec(NOW - 3 * DAY * 1000);
  const recs = { "p/ok": { s: "ok", a }, "p/skip": { s: "skip", a: sec(NOW - 30 * DAY * 1000) }, "p/bad": { s: "weird", a: sec(NOW - 40 * DAY * 1000) },
                 "p/nostatus": { a: sec(NOW - 50 * DAY * 1000) }, "p/noa": { s: "ok" } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-r6-"));
  const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: new Date(NOW).toISOString(), models: recs }));
  const b = loadBench(file);
  const cleaned = (t) => { const r = recs[t]; return r && ["ok", "skip"].includes(r.s) ? { s: r.s, a: r.a } : null; };
  for (const get of [b.get, Object.assign(cleaned, { records: 5 })]) {
    assert.deepEqual(ageHistOf("p", models, get, NOW), [[Math.floor(a / 3600), 1]], "only the ok record");
    assert.equal(oldestStampOf([row("p", models)], get, NOW), new Date(a * 1000).toISOString(), "the skip is not the oldest stamp");
  }
  assert.equal(b.get.stamp("p/skip"), null);
  assert.equal(b.get.stamp("p/bad"), null);
  assert.equal(b.get.stamp("p/nostatus"), null);
  assert.equal(b.get.stamp("p/noa"), null);
  assert.equal(b.get.stamp("p/ok"), a);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- A5: wording and a distinct reason

test("a schema-9 file with no rows array is a damaged file with its own sentence, not 'expected 9, found 9'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-r6s-"));
  const f = path.join(dir, "snapshot.json");
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.doesNotMatch(r.detail, /expected.*found/);
  assert.match(r.detail, /no rows array/);
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 8, rows: [] }));
  assert.match(loadSnapshot(f).detail, /expected schemaVersion 9, found 8/, "an old file still says so");
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA, rows: [] }));
  assert.equal(loadSnapshot(f).ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the legend: `blank` no longer says 'recently', the plan tail is explained, and the header says five sections", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n").replace(/\s+/g, " ");
  assert.doesNotMatch(text, /nothing benched recently/);
  assert.match(text, /blank no probe record for this provider/);
  assert.match(text, /' N plan'/);
  assert.match(text, /subscription plan/);
  const src = fs.readFileSync(new URL("../menu/legend.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /LAYOUT\. Four sections/);
  const style = fs.readFileSync(new URL("../menu/style.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(style, /not shown as a current fact/);
});

test("no test still passes the dead keyIdBucket in meta", () => {
  assert.doesNotMatch(fs.readFileSync(new URL("../test/id-elision.test.mjs", import.meta.url), "utf8"), /keyIdBucket/);
});

// ============================================================ B: the model list's `probed` column

const BENCH = (recs) => Object.assign((t) => recs[t] ?? null, { records: Object.keys(recs).length });
const rec = (o = {}) => ({ s: "ok", t: 800, d: 1500, r: 40, o: null, a: sec(NOW), p: "Hello there", k: 0, w: "", ...o });
const PROV = row("acme", ["young", "hour", "day", "two", "four", "week", "old", "never", "future"].map((id) => M(id)));
const ID_W = Math.max(...PROV.models.map((m) => m.id.length));
const RECS = {
  "acme/young": rec({ a: sec(NOW) - 45 * MIN - 30 }),          // 45m30s: exact seconds, not hour-bucketed (a bucket would say 1h)
  "acme/hour": rec({ a: sec(NOW) - 5 * HOUR }),
  "acme/day": rec({ a: sec(NOW) - DAY }),
  "acme/two": rec({ a: sec(NOW) - 2 * DAY }),
  "acme/four": rec({ a: sec(NOW) - 4 * DAY }),
  "acme/week": rec({ a: sec(NOW) - 7 * DAY }),
  "acme/old": rec({ a: sec(NOW) - 100 * DAY }),
  "acme/future": rec({ a: sec(NOW) + 9 * DAY }),
};
const V1 = (o = {}) => ({ level: 1, scope: "tree", filter: "", legend: false, cursor: 99, top: 0, empty: false, provider: PROV, more: 0, now: NOW,
  items: PROV.models.map((model) => ({ kind: "model", model, row: PROV, target: `acme/${model.id}` })), ...o });
const META = { providers: 1, models: PROV.models.length, benchOf: BENCH(RECS), benchAsOf: new Date(NOW).toISOString(), keyIdW: 20 };
const shot = (env, cols, v = V1(), meta = META) => frame(v, meta, { caps: detectCaps(env, cols) });
const cell = (lines, id, env, n) => strip(lines.find((l) => strip(l).split(sepOf(env))[0].trim().endsWith(id) && !l.includes("id:"))).split(sepOf(env))[n].trim();

test("probed: the age of THAT model's record in exact seconds against the picker's clock, right after stat; blank without a record", () => {
  for (const env of [UNI, ASCII]) {
    const lines = shot(env, 240);
    // 0 id, 1 stat, 2 probed, 3 ttft
    assert.deepEqual(strip(lines.find((l) => l.includes("model "))).split(sepOf(env)).slice(1, 4).map((c) => c.trim()), ["stat", "probed", "ttft"]);
    assert.equal(cell(lines, "young", env, 2), "45m", "45m30s is 45m: not the hour bucket's 1h");
    assert.equal(cell(lines, "hour", env, 2), "5h");
    assert.equal(cell(lines, "day", env, 2), "1d");
    assert.equal(cell(lines, "two", env, 2), "2d");
    assert.equal(cell(lines, "week", env, 2), "7d");
    assert.equal(cell(lines, "old", env, 2), "100d");
    assert.equal(cell(lines, "never", env, 2), "", "never probed: blank");
    assert.equal(cell(lines, "future", env, 2), "", "a record dated in the future is not usable: blank, like every other cell");
  }
});

test("probed: a skip is not a probe result and draws no age; recordAge refuses a non-positive stamp and an age that would not fit the cell", () => {
  const skipped = { ...V1(), items: [...V1().items, { kind: "model", model: M("skp"), row: PROV, target: "acme/skp" }] };
  const recs = { ...RECS, "acme/skp": { s: "skip", w: "spend-cap", a: sec(NOW) - 5 * DAY } };
  for (const env of [UNI, ASCII]) {
    const line = strip(shot(env, 240, skipped, { ...META, benchOf: BENCH(recs) }).find((l) => strip(l).split(sepOf(env))[0].trim().endsWith("skp") && !l.includes("id:")));
    assert.equal(line.split(sepOf(env))[1].trim(), "skip");
    assert.equal(line.split(sepOf(env))[2].trim(), "", "no age for a skip");
  }
  assert.equal(recordAge({ s: "skip", a: 1_000_000 }, 2_000_000_000), null);
  for (const a of [-1e18, 0, -5, 1e300, NaN, Infinity]) assert.equal(recordAge({ s: "ok", a }, NOW), null, String(a));
  assert.equal(recordAge({ s: "ok", a: 1 }, NOW), sec(NOW) - 1, "a 1970 stamp is 20,000 days: five digits, still fits");
  assert.equal(recordAge({ s: "ok", a: 1 }, 1e13), null, "100,000 days or more would not fit the cell");
  assert.equal(recordAge({ s: "ok", a: 1000 }, (1000 + 99_999 * DAY) * 1000), 99_999 * DAY, "five digits of days still fit");
  // an uncleaned reader hands the renderer these: the cells stay blank and the frame stays whole
  const evil = { "acme/young": { s: "ok", a: -1e18, t: 1, d: 2, r: 3, p: "x" }, "acme/hour": { s: "ok", a: 1e300 }, "acme/day": { s: "ok", a: 0 } };
  const lines = shot(ASCII, 134, V1(), { ...META, benchOf: BENCH(evil) });
  for (const l of lines) assert.equal(cps(strip(l)), frameWidth(detectCaps(ASCII, 134)));
  for (const id of ["young", "hour", "day"]) assert.equal(cell(lines, id, ASCII, 2), "", id);
});

test("output sliver: below 8 columns the alias hint and skipped text draw blank, never a fragment; wider they draw", () => {
  const rows = ["alias", "skipped", "plain", "a-very-long-model-id-that-sets-the-id-column-to-its-cap"].map((id) => M(id));
  const prov = { ...PROV, models: rows };
  const recs = { "acme/alias": rec({ s: "gone", p: "model not found" }), "acme/skipped": { s: "skip", w: "spend-cap", a: sec(NOW) - DAY }, "acme/plain": rec({ p: "Hello there" }) };
  const v = V1({ provider: prov, items: rows.map((model) => ({ kind: "model", model, row: prov, target: `acme/${model.id}` })) });
  for (const env of [UNI, ASCII]) {
    for (const cols of [103, 110]) {
      const L = layoutFor(frameWidth(detectCaps(env, cols)), { idW: 43 });
      const lines = frame(v, { ...META, benchOf: BENCH(recs) }, { caps: detectCaps(env, cols) }).map(strip);
      const outCell = (id) => lines.find((l) => l.split(sepOf(env))[0].trim().endsWith(id) && !l.includes("id:")).split(sepOf(env)).at(-1).replace(/\s*[│|]$/, "");
      assert.equal(outCell("skipped").trim(), L.W.preview < 8 ? "" : "skipped: spend-cap".slice(0, L.W.preview).trim(), `skipped at ${cols}`);
      assert.equal(outCell("plain").trim(), "Hello there".slice(0, L.W.preview), "an ordinary reply is still trimmed, not blanked");
    }
    const wide = frame(v, { ...META, benchOf: BENCH(recs) }, { caps: detectCaps(env, 240) }).map(strip);
    assert.ok(wide.some((l) => l.includes("skipped: spend-cap")), "wide enough: the whole text");
  }
});

test("probed: age text edges reuse ageLabel; recordAge is the one place a record's age is decided", () => {
  const at = (ageS) => recordAge({ a: 1_000_000 }, (1_000_000 + ageS) * 1000);
  assert.equal(at(59 * MIN), 59 * MIN);
  for (const [s, want] of [[59 * MIN, "59m"], [60 * MIN, "1h"], [23 * HOUR, "23h"], [24 * HOUR, "1d"], [47 * HOUR, "1d"], [6 * DAY + 23 * HOUR, "6d"], [7 * DAY, "7d"], [100 * DAY, "100d"]]) {
    assert.equal(ageLabel(at(s)), want, `${s}s`);
    assert.equal(strip(probedCell(at(s), painter({ ...detectCaps(ASCII, 134), colours: 0 }), "|")), "|" + want.padStart(6));
  }
  assert.equal(recordAge({ a: 5 }, 1000), 0, "never negative");
  assert.equal(recordAge({}, 1000), null);
  assert.equal(recordAge(null, 1000), null);
  assert.equal(recordAge({ a: "9" }, 1000), null);
  assert.equal(recordAge({ a: NaN }, 1000), null);
});

test("probed: the same colour bands as oldest probe (constants from BENCH_OUTDATED_DAYS), orange 208 / 91, text only with colour off", () => {
  const p256 = painter({ ...detectCaps(UNI, 134), colours: 256 }), p16 = painter({ ...detectCaps(UNI, 134), colours: 16 }), p0 = painter({ ...detectCaps(ASCII, 134), colours: 0 });
  const w = (t) => t.padStart(6);
  const edges = [[0, "grn"], [PROBE_AGE_BANDS_S.yellow - 1, "grn"], [PROBE_AGE_BANDS_S.yellow, "yel"], [PROBE_AGE_BANDS_S.orange - 1, "yel"], [PROBE_AGE_BANDS_S.orange, "ora"],
                 [PROBE_AGE_BANDS_S.red - 1, "ora"], [PROBE_AGE_BANDS_S.red, "red"]];
  assert.equal(PROBE_AGE_BANDS_S.red, BENCH_OUTDATED_DAYS * DAY);
  for (const [s, tone] of edges) {
    const want = (p) => "|" + (tone === "ora" ? `\x1b[${p.depth >= 256 ? "38;5;208" : "91"}m${w(ageLabel(s))}\x1b[0m` : p[tone](w(ageLabel(s))));
    assert.equal(probedCell(s, p256, "|"), want(p256), `256: ${s}s`);
    assert.equal(probedCell(s, p16, "|"), want(p16), `16: ${s}s`);
    assert.equal(/\x1b/.test(probedCell(s, p0, "|")), false, "colour off: text only");
  }
  assert.equal(probedCell(null, p256, "|"), "|      ");
  assert.equal(probedCell(undefined, p256, "|"), "|      ");
  // in the frame, on an unselected row
  const caps = detectCaps(UNI, 240), p = painter(caps);
  const raw = frame(V1(), META, { caps }).find((l) => strip(l).includes(" day "));
  assert.ok(raw.includes(p.grn(w("1d"))) && !raw.includes(p.yel(w("1d"))));
  assert.ok(frame(V1(), META, { caps }).find((l) => strip(l).includes(" two ")).includes(p.yel(w("2d"))));
  assert.ok(frame(V1(), META, { caps }).find((l) => strip(l).includes(" four ")).includes(`\x1b[38;5;208m${w("4d")}\x1b[0m`));
  assert.ok(frame(V1(), META, { caps }).find((l) => strip(l).includes(" week ")).includes(p.red(w("7d"))));
});

// ---- the hard constraint: no older column moves; output pays

const OLD = (w, idW) => {                                   // the layout before `probed` existed, transcribed from the old source
  const inner = w - 3, want = Math.min(MODEL_ID_MAX, Math.max(1, Math.floor(idW) || 37)), idMin = Math.min(want, MODEL_ID_MIN);
  let free = inner - 4 - 49 - idMin;
  const take = (c) => (free >= c ? ((free -= c), true) : false);
  const showTotal = take(6), showTps = take(6), showPreview = take(11);
  const grow = Math.min(want - idMin, free); free -= grow;
  return { showTotal, showTps, showPreview, id: idMin + grow, preview: showPreview ? 10 + free : 0 };
};

test("no older column moves: total, tok/s and output appear at exactly the old widths, and the id is the old id wherever output shows AND wherever probed is absent, at every width and id length", () => {
  for (const idW of [5, 12, 20, 21, 22, 30, 43, 500]) for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
    const n = layoutFor(w, { idW }), o = OLD(w, idW);
    assert.deepEqual([n.showTotal, n.showTps, n.showPreview], [o.showTotal, o.showTps, o.showPreview], `visibility at ${w}, idW ${idW}`);
    // the id is the old id wherever output shows (from the all-columns width up); in the window where probed shows without output it
    // gives up its growth beyond the floor (never the floor) to probed, and it is never wider than before
    if (n.showPreview || !n.showProbed) assert.equal(n.W.id, o.id, `the id at ${w}, idW ${idW}`);
    else assert.ok(n.W.id <= o.id && n.W.id >= Math.min(idW, MODEL_ID_MIN), `the id at ${w}, idW ${idW}: ${n.W.id} vs old ${o.id}`);
    if (n.showPreview) assert.equal(n.W.preview, o.preview - 7, `output pays exactly probed's 7 at ${w}, idW ${idW}`);
    assert.ok(n.W.id >= Math.min(idW, MODEL_ID_MIN), "the id keeps its floor");
    if (n.showPreview) assert.ok(n.showProbed, "output only with probed");
    if (n.showProbed) assert.ok(n.showTotal && n.showTps, "probed is after total and tok/s");
  }
  const first = (idW, pred) => { for (let w = FRAME_MIN; w <= FRAME_MAX; w++) if (pred(layoutFor(w, { idW }))) return w + 2; return null; };
  const table = { 20: [84, 90, 101, 97], 21: [85, 91, 102, 98], 22: [86, 92, 103, 99], 30: [86, 92, 103, 99], 43: [86, 92, 103, 99] };
  for (const [idW, [total, tps, output, probed]] of Object.entries(table)) {
    assert.deepEqual([first(+idW, (L) => L.showTotal), first(+idW, (L) => L.showTps), first(+idW, (L) => L.showPreview), first(+idW, (L) => L.showProbed)], [total, tps, output, probed], `idW ${idW}`);
  }
  // output's width at 103 / 110 / 134 / 240 for a long id column, and at 78-80 nothing but the always-drawn cells + total for a short id
  assert.deepEqual([103, 110, 134, 240].map((c) => layoutFor(c - 2, { idW: 43 }).W.preview), [3, 3, 16, 122]);
  for (const c of [78, 80]) { const L = layoutFor(c - 2, { idW: 43 }); assert.deepEqual([L.showTotal, L.showTps, L.showProbed, L.showPreview], [false, false, false, false]); }
});

test("header and rows have the same rule columns at 78/80/100/103/104/110/134/240 in both glyph sets; every frame line is the frame width", () => {
  for (const env of [UNI, ASCII]) for (const cols of [78, 80, 100, 103, 104, 110, 134, 240]) {
    const caps = detectCaps(env, cols), S = sepOf(env);
    const L = layoutFor(frameWidth(caps), { idW: ID_W });
    const lines = shot(env, cols);
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const text = lines.map(strip), head = text.find((l) => l.includes("model "));
    assert.equal(head.includes("probed"), L.showProbed, `header at ${cols}`);
    const at = (l, upto) => [...(upto ? l.slice(0, upto) : l)].map((c, i) => (c === S ? i : -1)).filter((i) => i >= 0);
    // the output cell can contain the rule glyph in ASCII, so compare up to its start
    const cut = L.showPreview ? head.indexOf("out") : 0;
    for (const id of ["young", "never", "future", "old"]) {
      const r = text.find((l) => l.split(S)[0].trim().endsWith(id) && !l.includes("id:"));
      assert.deepEqual(at(r, cut), at(head, cut), `${id} at ${cols}`);
    }
    if (L.showPreview) assert.ok(head.includes("out"), "the output header is clipped to its width, never dropped");
  }
});

test("hostile record stamps draw blank and never break the frame", () => {
  const evil = { "acme/young": rec({ a: "\x1b[2J" }), "acme/hour": rec({ a: NaN }), "acme/day": rec({ a: -1e18 }), "acme/two": { s: "ok", t: 1, d: 2, r: 3, p: "x" } };
  for (const env of [UNI, ASCII]) for (const cols of [80, 134, 240]) {
    const caps = detectCaps(env, cols);
    const lines = frame(V1(), { ...META, benchOf: BENCH(evil) }, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f]/.test(strip(lines.join("\n"))), false);
  }
});

test("the legend defines probed and every model-list header cell is explained (derived from the renderer)", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n").replace(/\s+/g, " ");
  assert.match(text, /probed age of this model's own probe record/);
  assert.match(text, /Same colour bands as oldest probe: green under 2d, yellow under 4d, orange under 7d, red 7d or older/);
  assert.match(text, /Blank = never probed/);
  assert.match(text, /output first, then probed, then tok\/s, then total/);
});

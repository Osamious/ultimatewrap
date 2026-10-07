// #114 review fixes: freshness on drawn rows, level-0 key id elision, snapshot bench carry-forward,
// one dedupe rule, empty-state wording, UTC stamps, saturating cells, and the column-rule switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { detectCaps, glyphsFor, frame, frameWidth, statusCount, painter, elisionHeads, keyIdPlan } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { isUsable, isOk, BENCH_FRESH_MS, FUTURE_SKEW_MS, countStatuses, providerFlags } from "../menu/bench-data.mjs";
import { buildSnapshot, main, loadSnapshot } from "../menu/snapshot.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const sec = (agoMs) => Math.floor((NOW - agoMs) / 1000);
const M = (id, o = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false,
                             reason: false, provenance: "listing-verified", routable: true, ...o });
const rec = (agoMs, o = {}) => ({ s: "ok", t: 842, d: 1230, r: 51, o: 9, a: sec(agoMs), p: "hello there", k: 0, w: "", ...o });
const prow = (keyId, models, o = {}) => ({ keyId, provider: keyId.split(".")[1] ?? "p", free: 0, planCount: 0, health: "ok", models, ...o });

// ------------------------------------------------------------ 6. freshness

test("isUsable: a timestamp and not in the future; there is NO age limit", () => {
  assert.equal(isUsable(rec(1000), NOW), true);
  for (const days of [14, 15, 30, 100, 400]) assert.equal(isUsable(rec(days * DAY), NOW), true, `${days} days old still counts`);
  assert.equal(isUsable(rec(-DAY), NOW), false, "a record dated in the FUTURE is not evidence");
  assert.equal(isUsable(rec(-1000), NOW), true, "a second of clock skew is tolerated");
  assert.equal(isUsable(rec(-4 * 60 * 1000), NOW), true, "and so are a few minutes (a record written just after the picker started)");
  assert.equal(isUsable(rec(-10 * 60 * 1000), NOW), false, "ten minutes ahead of every clock is not evidence");
  assert.equal(isUsable({ s: "ok" }, NOW), false, "no timestamp");
  assert.equal(isUsable({ s: "ok", a: NaN }, NOW), false);
  assert.equal(isUsable(null, NOW), false);
  assert.equal(isOk(rec(-DAY), NOW), false, "and ok-ness needs a usable record too");
  assert.equal(isOk(rec(100 * DAY), NOW), true, "an old ok is still ok");
  assert.equal(isOk(rec(1000, { s: "gone" }), NOW), false);
  assert.equal(isOk(rec(1000), NOW), true);
});

test("counts and verdicts exclude a future-dated record but keep an old one", () => {
  const get = (t) => ({ "p/a": rec(-DAY), "p/b": rec(30 * DAY), "p/c": rec(1000) })[t] ?? null;
  assert.deepEqual(countStatuses("p", [{ id: "a" }, { id: "b" }, { id: "c" }], get, NOW).ok, 2, "the 30-day-old ok counts, the future-dated one does not");
  assert.equal(providerFlags("p", [{ id: "a" }], get, NOW), null, "only a future-dated record: no verdict");
});

test("a 30- or 100-day-old record STILL DRAWS its cells on the model list; a future-dated one draws blank", () => {
  const models = [M("fresh"), M("old"), M("future"), M("edge")];
  const bench = { "p/fresh": rec(DAY), "p/old": rec(30 * DAY), "p/future": rec(-3 * DAY), "p/edge": rec(100 * DAY) };
  const row = prow("personal.p.free", models, { provider: "p" });
  const benchOf = (t) => bench[t] ?? null;
  for (const env of [UNI, ASCII]) {
    const caps = detectCaps(env, 134);
    let st = reduce(initState([row], { nowMs: NOW }), { benchOf }).state;
    st = { ...st, level: 1, provider: row };
    const lines = frame(view(st), { providers: 1, models: 4, benchOf, benchAsOf: "2026-09-29T12:00:00Z" }, { caps }).map(strip);
    const cellsOf = (id) => lines.find((l) => l.includes(id));
    assert.match(cellsOf("fresh"), /ok\s+.*842ms/);
    assert.match(cellsOf("edge"), /842ms/);
    assert.match(cellsOf("old"), /842ms/, "an old measurement is still drawn (the outdated notice says so instead)");
    assert.doesNotMatch(cellsOf("future"), /842ms|hello there/, "nor is a future-dated one");
  }
});

// -------------------------------------------------- 7. level-0 key id elision

test("level-0 key ids elide with a visible marker and stay distinct where a hard cut collided", () => {
  const names = ["openrouter-x-1", "openrouter-x-2", "openrouter-x-3", "openrouter-x-4", "openrouter-x-5"];
  const rows = names.map((n) => prow(`personal.${n}.free`, [M("m")], { provider: n }));
  assert.equal(new Set(rows.map((r) => r.keyId.slice(0, 16))).size, 1, "precondition: a 16-column hard cut (the 80-column key id) gives one identical cell");
  const heads = keyIdPlan(rows, 16);
  const { dup } = elisionHeads(rows.map((r) => r.keyId), 16);
  assert.equal(dup, 0);
  for (const env of [UNI, ASCII]) {
    const caps = detectCaps(env, 80);
    const g = glyphsFor(caps);
    const meta = { providers: 5, models: 5, keyIdW: 30, rows };
    const lines = frame(view(initState(rows)), meta, { caps }).map(strip);
    const cells = lines.slice(4, 9).map((l) => l.slice(3, 19));
    assert.equal(new Set(cells).size, 5, cells.join(" | "));
    for (const c of cells) { assert.equal(cps(c), 16); assert.ok(c.includes(g.elide), `${c}: a visible marker, not a silent cut`); }
    for (const l of lines) assert.equal(cps(l), frameWidth(caps));
  }
  assert.ok(heads instanceof Map);
  assert.equal(keyIdPlan(rows, 16), heads, "cached per (rows, width)");
  assert.equal(keyIdPlan(undefined, 16), null);
});

test("wide enough for every key id, nothing is elided at level 0", () => {
  const rows = ["personal.google.free", "personal.openrouter.free"].map((k) => prow(k, [M("m")]));
  const caps = detectCaps(ASCII, 134);
  const lines = frame(view(initState(rows)), { providers: 2, models: 2, keyIdW: 30, rows }, { caps }).map(strip);
  assert.ok(lines.some((l) => l.includes("personal.openrouter.free ")));
});

// ------------------------------------------------ 8. snapshot bench carry

const BUILT = { generatedAt: "2026-09-29T00:00:00Z", rows: [
  { keyId: "personal.a.free", provider: "a", free: 0, planCount: 0, health: "ok", models: [{ id: "m1" }] },
  { keyId: "personal.b.free", provider: "b", free: 0, planCount: 0, health: "ok", models: [{ id: "m2" }] }] };
const COUNTS = { ok: 1, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 };

test("a build with no usable bench data keeps the previous counts, with the previous stamp", () => {
  const previous = { benchAsOf: "2026-09-20T10:00:00.000Z", rows: [
    { keyId: "personal.a.free", provider: "a", bench: COUNTS, benchFlags: { dead: false, needsMoney: false } },
    { keyId: "personal.b.free", provider: "b", bench: null, benchFlags: null }] };
  const s = buildSnapshot(BUILT, { previous, bench: null, nowMs: Date.parse("2026-09-25T00:00:00Z") });
  assert.deepEqual(s.rows[0].bench, COUNTS);
  assert.deepEqual(s.rows[0].benchFlags, { dead: false, needsMoney: false });
  assert.equal(s.rows[1].bench, null);
  assert.equal(s.benchAsOf, "2026-09-20T10:00:00.000Z", "the counts keep the stamp they belong to");
  // usable data always wins
  const get = () => ({ ...rec(1000), s: "gone" });
  const fresh = buildSnapshot(BUILT, { previous, bench: { generatedAt: "2026-09-29T12:00:00.000Z", size: 1, get }, nowMs: NOW });
  assert.equal(fresh.rows[0].bench.gone, 1);
  assert.equal(fresh.benchAsOf, "2026-09-29T12:00:00.000Z");
  // nothing to carry: a first build, or a previous snapshot that never had counts
  assert.equal(buildSnapshot(BUILT, { previous: { rows: [{ keyId: "personal.a.free" }] }, bench: null }).rows[0].bench, null);
  assert.equal(buildSnapshot(BUILT, { bench: null }).benchAsOf, null);
});

test("main() says what the provider columns were built from, and keeps counts when bench.json is unusable", async () => {
  const dir = mkTmp("uw-snap-");
  const file = path.join(dir, "snapshot.json");
  const STAMP = new Date(Date.now() - 2 * DAY).toISOString();      // inside the 14-day window, whenever this runs
  const empty = () => ({ generatedAt: null, size: 0, get: () => null });
  const run = async (benchLoader) => {
    const said = [];
    await main(["--build"], { rpc: async () => undefined, file, loadDiscovery: () => ({ discovery: new Map(), note: "canned" }),
                              loadRelayCatalog: async () => null, benchLoader, log: (l) => said.push(String(l)) });
    return { said: said.join("\n"), snap: loadSnapshot(file).snap };
  };
  // 1. a first build with nothing usable: the columns will be blank, and it says so
  const first = await run(empty);
  assert.match(first.said, /bench: no usable bench data, provider columns will be blank/);
  assert.ok(first.snap.rows.every((r) => r.bench === null));
  // 2. a build with usable data: how many records, as of when
  const withData = await run(() => ({ generatedAt: STAMP, size: 3, get: () => ({ ...rec(1000), s: "ok", a: Math.floor(Date.now() / 1000) }) }));
  assert.ok(withData.said.includes(`bench: 3 records as of ${STAMP}`), withData.said);
  assert.ok(withData.snap.rows.some((r) => r.bench && r.bench.ok > 0));
  const counted = withData.snap.rows.filter((r) => r.bench && r.bench.ok > 0).map((r) => [r.keyId, r.bench.ok]);
  // 3. the next build finds bench.json missing/corrupt/wrong-schema: the counts SURVIVE, with their own stamp
  const after = await run(empty);
  assert.ok(after.said.includes(`bench: no usable bench data; kept the previous counts as of ${STAMP}`), after.said);
  assert.equal(after.snap.benchAsOf, STAMP);
  assert.deepEqual(after.snap.rows.filter((r) => r.bench && r.bench.ok > 0).map((r) => [r.keyId, r.bench.ok]), counted);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------- 9. one dedupe rule: routes, everywhere

test("x and x[1m] are two routes and count twice in the count, the verdicts, the header and the filter", () => {
  const rows = [prow("personal.p.free", [M("x"), M("x[1m]"), M("y")], { provider: "p" })];
  const benchOf = (t) => (/^p\/(x|y)/.test(t.replace(/\[1m\]$/i, "")) ? rec(1000) : null);
  assert.equal(countStatuses("p", rows[0].models, benchOf, NOW).ok, 3);
  let st = reduce(reduce(initState(rows, { nowMs: NOW }), { benchOf }).state, "\r").state;
  assert.equal(view(st).okLive, 3);
  st = reduce(st, "\x0f").state;
  assert.equal(view(st).modelCount, 3, "the ok-only list shows both routes");
  const head = strip(frame(view(st), { providers: 1, models: 3, benchOf, benchAsOf: "2026-09-29T12:00:00Z" }, { caps: detectCaps(ASCII, 100) }).find((l) => l.includes("filter:")));
  assert.ok(head.includes("3 of 3 | 3 ok (100%)"), head);
});

// ------------------------------------------------------ 10. empty-state wording

test("with only toggles on there is no `no match for \"\"` line; typed text still gets one", () => {
  const rows = [prow("personal.p.free", [M("only")], { provider: "p" })];
  const caps = detectCaps(ASCII, 100);
  let st = reduce(initState(rows, { nowMs: NOW }), "\r").state;
  st = reduce(st, "\x0f").state;                                   // ok-only, no bench data: empty
  const bare = frame(view(st), { providers: 1, models: 1 }, { caps }).map(strip);
  assert.equal(bare.some((l) => l.includes("no match for")), false);
  assert.ok(bare.some((l) => l.includes("filtered by ok-only")));
  const typed = reduce(st, "z").state;
  assert.ok(frame(view(typed), { providers: 1, models: 1 }, { caps }).map(strip).some((l) => l.includes('no match for "z"')));
  // nothing typed, nothing toggled, still empty (a provider with no models)
  const none = { ...initState([prow("personal.q.free", [])]), level: 1, provider: prow("personal.q.free", []) };
  const lines = frame(view(none), { providers: 1, models: 0 }, { caps }).map(strip);
  assert.equal(lines.some((l) => l.includes('no match for ""')), false);
  assert.ok(lines.some((l) => l.includes("nothing to list here")));
});

// ------------------------------------------------------------ 11. UTC stamps

test("every header stamp says it is UTC, at the model level and the provider list", () => {
  const rows = [prow("personal.p.free", [M("only")], { provider: "p" })];
  const caps = detectCaps(ASCII, 134);
  const meta = { providers: 1, models: 1, routableAsOf: "2026-09-29T09:18:00.000Z", discoveredAsOf: "2026-09-29T09:16:00.000Z",
                 benchAsOf: "2026-09-29T12:35:00.000Z", benchCountsAsOf: "2026-09-29T11:56:00.000Z", okTotal: 1 };
  // The stamps sit at the right end of the `id:` line (#114 redesign).
  const idLineOf = (v, m = meta, c = caps) => strip(frame(v, m, { caps: c }).find((l) => strip(l).includes("id: ")));
  const l0 = idLineOf(view(initState(rows)));
  assert.ok(l0.includes("routable 09-29 09:18Z"), l0);
  const l1 = idLineOf(view({ ...initState(rows), level: 1, provider: rows[0] }));
  assert.ok(l1.includes("benched 09-29 12:35Z") && l1.includes("discovered 09-29 09:16Z"), l1);
  for (const cols of [40, 80, 134]) for (const l of frame(view({ ...initState(rows), level: 1, provider: rows[0] }), meta, { caps: detectCaps(ASCII, cols) })) {
    assert.equal(cps(strip(l)), frameWidth(detectCaps(ASCII, cols)));
  }
  // a stamp that is not UTC-shaped gets no marker (we do not claim what we do not know)
  const odd = idLineOf(view(initState(rows)), { ...meta, routableAsOf: "2026-09-29T09:18:00+03:00" });
  assert.ok(odd.includes("routable 09-29 09:18") && !odd.includes("09:18Z"), odd);
});

// ---------------------------------------------------- 12. cells never lie

test("statusCount never truncates a big number into a smaller one", () => {
  const p = painter(detectCaps(ASCII, 80));
  const cell = (n, st = "ok") => strip(statusCount(n, false, st, p));
  assert.equal(cell(999), ":".replace(":", " ") + "999");
  assert.equal(cell(1000), "  1k");
  assert.equal(cell(99999).trim(), "99k");
  assert.equal(cell(100000).trim(), "big");
  assert.equal(cell(1_200_000).trim(), "big", "not `120`, which is what a clipped `1200k` read as");
  assert.equal(cell(1_200_000, "empty").trim(), "big");
  for (const st of ["ok", "empty", "auth", "pay", "rate", "gone", "timeout", "error", "skip"]) {
    for (const n of [0, 5, 999, 1000, 99999, 100000, 5e6]) assert.equal(cps(cell(n, st)), cps(cell(1, st)), `${st} ${n}: never widens`);
  }
});

// --------------------------------------------------- 13. column-rule switch

test("UW_PICKER_COLSEP picks the column rule; the default and ASCII terminals are unchanged", () => {
  const rows = [prow("personal.p.free", [M("only")], { provider: "p", bench: COUNTS, benchFlags: { dead: false, needsMoney: false } })];
  const shot = (env, cols = 100) => {
    const caps = detectCaps(env, cols);
    return { caps, lines: frame(view({ ...initState(rows), level: 1, provider: rows[0] }), { providers: 1, models: 1 }, { caps }).map(strip) };
  };
  assert.equal(detectCaps(UNI, 80).colSep, null, "default: no override");
  assert.equal(glyphsFor(detectCaps(UNI, 80)).colSep, "┆");
  assert.equal(glyphsFor(detectCaps({ ...UNI, UW_PICKER_COLSEP: "ascii" }, 80)).colSep, ":");
  assert.equal(glyphsFor(detectCaps({ ...UNI, UW_PICKER_COLSEP: "LATIN" }, 80)).colSep, "¦");
  assert.equal(glyphsFor(detectCaps({ ...UNI, UW_PICKER_COLSEP: "bogus" }, 80)).colSep, "┆");
  assert.equal(glyphsFor(detectCaps({ ...ASCII, UW_PICKER_COLSEP: "latin" }, 80)).colSep, ":", "an ASCII terminal stays ASCII");
  assert.equal(glyphsFor(detectCaps({ ...UNI, UW_PICKER_COLSEP: "ascii" }, 80)).marker, "▶", "everything else keeps its unicode glyphs");
  for (const [value, sep] of [[undefined, "┆"], ["ascii", ":"], ["latin", "¦"]]) {
    const { caps, lines } = shot({ ...UNI, ...(value ? { UW_PICKER_COLSEP: value } : {}) });
    const head = lines.find((l) => l.includes("ttft"));
    assert.ok(head.includes(sep), `${value}: ${head}`);
    if (sep !== "┆") assert.equal(head.includes("┆"), false);
    for (const l of lines) assert.equal(cps(l), frameWidth(caps));
    const at = (l) => [...l].map((c, i) => (c === sep ? i : -1)).filter((i) => i >= 0);
    const row = lines.find((l) => l.includes("only") && l.includes(sep) && !l.includes("id:"));
    assert.deepEqual(at(row).slice(0, at(head).length - 1), at(head).slice(0, -1));
  }
});

test("a record written after the picker started is usable; a genuinely future or corrupt one is still refused", () => {
  const real = Date.now();
  const pickerStart = real - 2 * 60 * 60 * 1000;           // the picker has been open for two hours: state.now is frozen there
  const at = (ms) => ({ s: "ok", a: Math.floor(ms / 1000) });
  assert.equal(isUsable(at(real - 30 * 1000), pickerStart), true, "a sweep in another window wrote it 30 s ago: newer than state.now, still fresh");
  assert.equal(isUsable(at(pickerStart + 60 * 1000), pickerStart), true);
  assert.equal(isUsable(at(real + FUTURE_SKEW_MS + 60 * 1000), pickerStart), false, "beyond the real clock plus the skew: refused");
  assert.equal(isUsable(at(real + DAY), pickerStart), false, "a day ahead: a hand edit or a clock that ran ahead");
  assert.equal(isUsable(at(real + DAY), real), false);
  assert.equal(isUsable(at(pickerStart - BENCH_FRESH_MS - 5000), pickerStart), true, "there is no age window any more");
  assert.equal(isOk({ s: "ok", a: Math.floor((real - 1000) / 1000) }, pickerStart), true, "so the ok-only list and the header count it");
});

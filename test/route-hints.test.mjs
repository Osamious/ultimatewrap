// Part A: misleading FREE? badges (bench-study 3.1) and alias labels (bench-study 4b).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSnapshot, loadSnapshot, writeSnapshotFile } from "../menu/snapshot.mjs";
import { payFreeNote, aliasMap, liveAlias, PAY_NOTE } from "../menu/route-hints.mjs";
import { detectCaps, frame, frameWidth } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { legendLines } from "../menu/legend.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const rec = (s, agoMs = 1000, o = {}) => ({ s, t: 500, d: 900, r: 20, o: 10, a: Math.floor((NOW - agoMs) / 1000), p: "", k: 0, w: "", ...o });
const M = (id, badge = "PAID", o = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge, tools: true, vision: false, reason: false,
                                             outputKind: "text", routable: true, provenance: "listing-verified", ...o });
const built = (rows) => ({ generatedAt: "x", rows: rows.map((r) => ({ free: 0, planCount: 0, health: "ok", ...r })) });
const benchOf = (map) => ({ generatedAt: "2026-09-29T12:00:00.000Z", size: Object.keys(map).length,
  get: (t) => map[String(t).replace(/\[1m\]$/i, "")] ?? null });
const badgesOf = (snap) => Object.fromEntries(snap.rows.flatMap((r) => r.models.map((m) => [`${r.provider}/${m.id}`, m.badge])));

// ------------------------------------------------------------ 1. FREE? + pay

// The 12 real shapes (plans/bench-study/models.csv: badge FREE?, fresh status pay).
const TWELVE = ["kilo/free", "kilo/longcat-2.0-free[1m]", "tokenrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "xkiro/deepseek/deepseek-v4.1-flash:free", "xkiro/stealth/space-bunny-alpha:free", "xkiro/stealth/pixel-canary:free",
  "xkiro/meta/muse-spark-1.3-contributor:free", "commandcode/poolside/laguna-s-2.1-free",
  "commandcode/inclusionai/ling-3.0-flash-sante:free", "teamorouter/deepseek-flash-free", "teamorouter/deepseek-v4-flash-free",
  "teamorouter/glm-5.3-flash-free"];
const fixtureFor = (targets, badge = "FREE?") => {
  const byProv = new Map();
  for (const t of targets) { const [p, ...rest] = t.split("/"); (byProv.get(p) ?? byProv.set(p, []).get(p)).push(M(rest.join("/"), badge)); }
  return built([...byProv].map(([provider, models]) => ({ keyId: `personal.${provider}.free`, provider, models })));
};
const payAll = (targets, agoMs = 1000, s = "pay") => benchOf(Object.fromEntries(targets.map((t) => [t.replace(/\[1m\]$/i, ""), rec(s, agoMs)])));

test("all 12 real FREE?-but-pay shapes lose the misleading badge and say why", () => {
  const snap = buildSnapshot(fixtureFor(TWELVE), { bench: payAll(TWELVE), nowMs: NOW });
  const models = snap.rows.flatMap((r) => r.models.map((m) => ({ ...m, target: `${r.provider}/${m.id}` })));
  assert.equal(models.length, 12);
  for (const m of models) {
    assert.equal(m.badge, "", `${m.target} must not claim (possibly) free`);
    assert.equal(m.badgeNote, PAY_NOTE);
  }
  const by = {};
  for (const m of models) by[m.target.split("/")[0]] = (by[m.target.split("/")[0]] ?? 0) + 1;
  assert.deepEqual(by, { kilo: 2, tokenrouter: 1, xkiro: 4, commandcode: 2, teamorouter: 3 });
});

test("only a FRESH pay on a FREE? badge changes anything", () => {
  const cases = [
    ["stale pay (30 days)", "FREE?", "pay", 30 * DAY, "FREE?", false],
    ["future-dated pay", "FREE?", "pay", -3 * DAY, "FREE?", false],
    ["the 14-day edge is still fresh", "FREE?", "pay", 14 * DAY, "", true],
    ["gone", "FREE?", "gone", 1000, "FREE?", false],
    ["error", "FREE?", "error", 1000, "FREE?", false],
    ["rate", "FREE?", "rate", 1000, "FREE?", false],
    ["auth", "FREE?", "auth", 1000, "FREE?", false],
    ["ok", "FREE?", "ok", 1000, "FREE?", false],
    ["empty", "FREE?", "empty", 1000, "FREE?", false],
    ["FREE (real zero price and a grant) is never touched", "FREE", "pay", 1000, "FREE", false],
    ["PLAN is never touched", "PLAN", "pay", 1000, "PLAN", false],
    ["PAID is never touched", "PAID", "pay", 1000, "PAID", false],
    ["a blank badge stays blank, with no note", "", "pay", 1000, "", false],
  ];
  for (const [name, badge, status, ago, want, noted] of cases) {
    const snap = buildSnapshot(built([{ keyId: "personal.p.free", provider: "p", models: [M("m", badge)] }]),
      { bench: benchOf({ "p/m": rec(status, ago) }), nowMs: NOW });
    const m = snap.rows[0].models[0];
    assert.equal(m.badge, want, name);
    assert.equal(Object.hasOwn(m, "badgeNote"), noted, name);
  }
});

test("the badge vocabulary stays closed, the change is idempotent, and no bench data changes nothing", () => {
  const rows = [{ keyId: "personal.p.free", provider: "p", models: [M("a", "FREE?"), M("b", "FREE"), M("c", "PLAN"), M("d", "PAID"), M("e", "")] }];
  const bench = benchOf({ "p/a": rec("pay"), "p/b": rec("pay"), "p/c": rec("pay"), "p/d": rec("pay"), "p/e": rec("pay") });
  const one = buildSnapshot(built(rows), { bench, nowMs: NOW });
  for (const m of one.rows[0].models) assert.ok(["FREE", "FREE?", "PLAN", "PAID", ""].includes(m.badge), m.badge);
  const strippedTime = (s) => JSON.stringify({ ...s, builtAt: null });
  assert.equal(strippedTime(buildSnapshot(built(rows), { bench, nowMs: NOW })), strippedTime(one), "the same inputs, the same snapshot");
  // rebuilding from an ALREADY-adjusted catalogue row is a no-op
  const twice = buildSnapshot(built(one.rows.map((r) => ({ ...r }))), { bench, nowMs: NOW });
  assert.deepEqual(twice.rows[0].models.map((m) => m.badge), one.rows[0].models.map((m) => m.badge));
  // no bench data: the badge stands
  assert.equal(buildSnapshot(built(rows), { bench: null }).rows[0].models[0].badge, "FREE?");
  assert.equal(payFreeNote(rows[0].models[0], "p", null, NOW), null);
  assert.equal(payFreeNote(rows[0].models[1], "p", bench.get, NOW), null, "FREE is not FREE?");
});

test("additive fields: absent on ordinary rows, and an old snapshot without them loads and renders", () => {
  const snap = buildSnapshot(built([{ keyId: "personal.p.free", provider: "p", models: [M("plain", "PAID")] }]),
    { bench: benchOf({ "p/plain": rec("ok") }), nowMs: NOW });
  const m = JSON.parse(JSON.stringify(snap)).rows[0].models[0];
  assert.equal(Object.hasOwn(m, "badgeNote"), false);
  assert.equal(Object.hasOwn(m, "aliasOf"), false);
  assert.equal(snap.schemaVersion, 7, "the current schema");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-rh-"));
  const file = path.join(dir, "s.json");
  writeSnapshotFile(snap, file);
  assert.equal(loadSnapshot(file).ok, true);
  const rows = loadSnapshot(file).snap.rows;
  const lines = frame(view({ ...initState(rows), level: 1, provider: rows[0] }), { providers: 1, models: 1 }, { caps: detectCaps({ TERM: "dumb" }, 100) });
  assert.ok(lines.length > 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ----------------------------------------------------------- 2. alias labels

const withStatus = (ids, statusOf) => ({ models: ids.map((id) => M(id)), map: Object.fromEntries(ids.map((id) => [`p/${id.replace(/\[1m\]$/i, "")}`, rec(statusOf(id))])) });

test("alias rules: org prefix, bare id, punctuation/case, and the :free :thinking @eu @us suffixes", () => {
  const cases = [
    ["qwen3-5-27b", "qwen3.5-27b"],                         // punctuation
    ["Qwen3-5-27B", "qwen3.5-27b"],                         // case + punctuation
    ["nemotron-3-nano-30b-a3b:free", "nemotron-3-nano-30b-a3b"],
    ["qwen-plus-2025-07-28:thinking[1m]", "qwen-plus-2025-07-28[1m]"],
    ["gemini-3.7-flash@eu", "gemini-3.7-flash"],
    ["gemini-3.7-flash@us", "gemini-3.7-flash"],
    ["gpt-5", "openai/gpt-5"],                              // org-prefixed sibling
    ["openai/gpt-5-mini", "gpt-5-mini"],                    // bare sibling
    ["model-x-free", "model-x"],
  ];
  for (const [gone, ok] of cases) {
    const { models, map } = withStatus([gone, ok], (id) => (id === gone ? "gone" : "ok"));
    assert.equal(aliasMap("p", models, benchOf(map).get, NOW).get(gone), ok, `${gone} -> ${ok}`);
  }
});

test("what is NOT an alias: :batch rows, non-gone rows, stale or non-ok siblings, [1m] twins, unrelated ids", () => {
  const at = (statuses, agoOf = () => 1000) => {
    const ids = Object.keys(statuses);
    const map = Object.fromEntries(ids.map((id) => [`p/${id.replace(/\[1m\]$/i, "")}`, rec(statuses[id], agoOf(id))]));
    return aliasMap("p", ids.map((id) => M(id)), benchOf(map).get, NOW);
  };
  assert.equal(at({ "x:batch": "gone", x: "ok" }).size, 0, "a :batch id is a different route");
  assert.equal(at({ "x:free": "error", x: "ok" }).size, 0, "the row itself must be gone");
  assert.equal(at({ "x:free": "gone", x: "gone" }).size, 0, "the sibling must be ok");
  assert.equal(at({ "x:free": "gone", x: "empty" }).size, 0);
  assert.equal(at({ "x:free": "gone", x: "ok" }, (id) => (id === "x" ? 30 * DAY : 1000)).size, 0, "a stale sibling");
  assert.equal(at({ "x:free": "gone", x: "ok" }, (id) => (id === "x:free" ? 30 * DAY : 1000)).size, 0, "a stale own record");
  assert.equal(at({ "x:free": "gone", x: "ok" }, (id) => (id === "x" ? -DAY : 1000)).size, 0, "a future-dated sibling");
  assert.equal(at({ "x[1m]": "gone", x: "ok" }).size, 0, "x and x[1m] are one model, not an alias");
  assert.equal(at({ alpha: "gone", beta: "ok" }).size, 0);
  assert.equal(aliasMap("p", [M("x:free"), M("x")], null, NOW).size, 0);
  assert.equal(at({ "x:free": "gone", x: "ok" }).get("x:free"), "x", "and the plain case still works");
});

test("liveAlias honours the baked pointer only while both records are still fresh", () => {
  const model = M("x:free", "PAID", { aliasOf: "x" });
  const get = (own, sib, ownAgo = 1000, sibAgo = 1000) => (t) => (t === "p/x:free" ? rec(own, ownAgo) : t === "p/x" ? rec(sib, sibAgo) : null);
  assert.equal(liveAlias("p", model, get("gone", "ok"), NOW), "x");
  assert.equal(liveAlias("p", model, get("ok", "ok"), NOW), null, "it has come back to life");
  assert.equal(liveAlias("p", model, get("gone", "gone"), NOW), null, "the sibling died");
  assert.equal(liveAlias("p", model, get("gone", "ok", 1000, 30 * DAY), NOW), null);
  assert.equal(liveAlias("p", { ...model, aliasOf: undefined }, get("gone", "ok"), NOW), null);
  assert.equal(liveAlias("p", model, null, NOW), null);
});

// ---- the oracle: real-shaped rows from the study's own frozen table (6,032 routes), committed as a fixture
// (`test/fixtures/bench-study-routes.csv`, provider,id,badge,status,ok_sibling): all 59 gone-with-ok-sibling routes
// with their siblings, six `:batch` twins, the twelve FREE?-but-pay routes, and free-badged and gone controls. The
// file is required: a missing fixture fails these tests loudly (readFileSync throws), it never skips them.

const CSV = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "bench-study-routes.csv");
function parseCsv(text) {
  const L = text.split(/\r?\n/).filter(Boolean);
  const cells = (l) => { const o = []; let c = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i];
    if (q) { if (ch === '"' && l[i + 1] === '"') { c += '"'; i++; } else if (ch === '"') q = false; else c += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { o.push(c); c = ""; } else c += ch; } o.push(c); return o; };
  const head = cells(L[0]);
  return L.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])));
}

test("ORACLE: on the study's frozen table the picker's rule finds exactly the study's 59 gone-with-ok-sibling routes", () => {
  const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
  assert.equal(rows.length, 138, "the committed fixture");
  const byProv = new Map();
  for (const r of rows) (byProv.get(r.provider) ?? byProv.set(r.provider, []).get(r.provider)).push(r);
  const expected = rows.filter((r) => r.status === "gone" && r.ok_sibling && !/:batch/i.test(r.id));
  assert.equal(expected.length, 59, "the study's own count");
  const got = [];
  for (const [provider, list] of byProv) {
    const map = Object.fromEntries(list.map((r) => [`${provider}/${r.id.replace(/\[1m\]$/i, "")}`, rec(r.status)]));
    for (const [id, sib] of aliasMap(provider, list.map((r) => M(r.id)), benchOf(map).get, NOW)) got.push({ provider, id, sib });
  }
  assert.equal(got.length, 59);
  const key = (p, id) => `${p}/${id}`;
  assert.deepEqual(new Set(got.map((g) => key(g.provider, g.id))), new Set(expected.map((r) => key(r.provider, r.id))));
  const lower = (s) => String(s).replace(/\[1m\]$/i, "").toLowerCase();
  const csvSib = new Map(expected.map((r) => [key(r.provider, r.id), lower(r.ok_sibling)]));
  for (const g of got) assert.equal(lower(g.sib), csvSib.get(key(g.provider, g.id)), `${g.provider}/${g.id}`);
  const by = {};
  for (const g of got) by[g.provider] = (by[g.provider] ?? 0) + 1;
  assert.deepEqual(by, { alibaba: 26, openai: 22, google: 7, nousresearch: 2, openrouter: 1, cohere: 1 });
});

test("ORACLE: the twelve FREE?-but-pay routes in the study's table are exactly the ones the badge fix changes", () => {
  const rows = parseCsv(fs.readFileSync(CSV, "utf8"));
  const byProv = new Map();
  for (const r of rows) (byProv.get(r.provider) ?? byProv.set(r.provider, []).get(r.provider)).push(r);
  const changed = [];
  for (const [provider, list] of byProv) {
    const map = Object.fromEntries(list.map((r) => [`${provider}/${r.id.replace(/\[1m\]$/i, "")}`, rec(r.status)]));
    for (const r of list) if (payFreeNote(M(r.id, r.badge), provider, benchOf(map).get, NOW)) changed.push(`${provider}/${r.id}`);
  }
  assert.deepEqual(changed.sort(), [...TWELVE].sort());
});

// ------------------------------------------------------------ rendering

const ALIAS_ROW = () => {
  const models = [M("qwen3-5-27b", "PAID", { aliasOf: "qwen3.5-27b" }), M("qwen3.5-27b"), M("other")];
  const row = { keyId: "personal.alibaba.paid", provider: "alibaba", free: 0, planCount: 0, health: "ok", models };
  const map = { "alibaba/qwen3-5-27b": rec("gone", 1000, { p: "alibaba: Model not exist." }), "alibaba/qwen3.5-27b": rec("ok"),
                "alibaba/other": rec("gone", 1000, { p: "alibaba: Model not exist." }) };
  return { row, get: (t) => map[String(t).replace(/\[1m\]$/i, "")] ?? null };
};

test("the output cell of a dead alias says where the working route is; other rows keep their message", () => {
  const { row, get } = ALIAS_ROW();
  for (const env of [{ TERM: "dumb" }, { WT_SESSION: "1", COLORTERM: "truecolor" }]) {
    for (const cols of [40, 80, 100, 134, 400]) {
      const caps = detectCaps(env, cols);
      const st = { ...reduce(initState([row], { nowMs: NOW }), { benchOf: get }).state, level: 1, provider: row, cur: [0, 1, 0] };
      const lines = frame(view(st), { providers: 1, models: 3, benchOf: get, benchAsOf: "2026-09-29T12:00:00Z" }, { caps });
      for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
      const text = lines.map(strip);
      const aliasLine = text.find((l) => l.includes("qwen3-5-27b") && !l.includes("id:"));
      const otherLine = text.find((l) => /\bother\b/.test(l) && !l.includes("id:"));
      if (cols >= 134) {
        assert.ok(aliasLine.includes("= qwen3.5-27b (works)"), aliasLine);
        if (cols >= 134) assert.ok(otherLine.includes("Model not exist"), "a gone row with no sibling keeps its own message");
        else assert.ok(otherLine.includes("Model not"), "a gone row with no sibling keeps its own message (clipped by a narrow preview)");
      } else {
        assert.equal(aliasLine.includes("(works)"), false, `no preview column at ${cols}`);
      }
    }
  }
});

test("the alias cell is dim, sanitised, and adds no column or width", () => {
  const { row, get } = ALIAS_ROW();
  row.models[0].aliasOf = "qwen3.5-27b";
  const evilRow = { ...row, models: [M("evil-id", "PAID", { aliasOf: "sib\x1b]0;PWN\x07\x1b[2J你" }), M("sib\x1b]0;PWN\x07\x1b[2J你")] };
  const g2 = (t) => (t === "alibaba/evil-id" ? rec("gone") : t.startsWith("alibaba/sib") ? rec("ok") : null);
  const caps = detectCaps({ WT_SESSION: "1", COLORTERM: "truecolor" }, 134);
  const st = { ...reduce(initState([evilRow], { nowMs: NOW }), { benchOf: g2 }).state, level: 1, provider: evilRow, cur: [0, 1, 0] };
  const lines = frame(view(st), { providers: 1, models: 2, benchOf: g2, benchAsOf: "2026-09-29T12:00:00Z" }, { caps });
  const all = lines.join("\n");
  assert.equal(/\x07|\x1b\]/.test(all), false);
  for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps));
  const raw = lines.find((l) => strip(l).includes("evil-id") && !strip(l).includes("id:"));
  assert.ok(/\x1b\[2m[^\x1b]*= sib/.test(raw), "drawn dim");
  const st2 = { ...reduce(initState([row], { nowMs: NOW }), { benchOf: get }).state, level: 1, provider: row, cur: [0, 1, 0] };
  const head = frame(view(st2), { providers: 1, models: 3, benchOf: get }, { caps }).map(strip).find((l) => l.includes("ttft"));
  assert.equal(/alias|works/.test(head), false, "no new column header");
});

test("the id: line shows `= sibling` when it fits, at every width, and never when it does not", () => {
  const { row, get } = ALIAS_ROW();
  for (const cols of [80, 100, 134]) {
    const caps = detectCaps({ TERM: "dumb" }, cols);
    const st = { ...reduce(initState([row], { nowMs: NOW }), { benchOf: get }).state, level: 1, provider: row };
    const v = view(st);
    assert.equal(v.fullId, "qwen3-5-27b");
    assert.equal(v.fullAlias, "qwen3.5-27b");
    const idLine = frame(v, { providers: 1, models: 3, benchOf: get }, { caps }).map(strip).find((l) => l.includes("id:"));
    assert.ok(idLine.includes("id: qwen3-5-27b  = qwen3.5-27b"), idLine);
    assert.equal(cps(idLine), frameWidth(caps));
  }
  // an id so long that the suffix does not fit: the id wins, no clipped alias
  const longId = "a".repeat(60);
  const r2 = { ...row, models: [M(longId, "PAID", { aliasOf: "b".repeat(20) }), M("b".repeat(20))] };
  const g3 = (t) => (t === `alibaba/${longId}` ? rec("gone") : t === `alibaba/${"b".repeat(20)}` ? rec("ok") : null);
  const st = { ...reduce(initState([r2], { nowMs: NOW }), { benchOf: g3 }).state, level: 1, provider: r2 };
  const line = frame(view(st), { providers: 1, models: 2, benchOf: g3 }, { caps: detectCaps({ TERM: "dumb" }, 80) }).map(strip).find((l) => l.includes("id:"));
  assert.ok(line.includes(longId) && !line.includes("= b"), line);
  // a row whose sibling stopped answering (or that is fresh again) shows nothing
  const dead = (t) => (t.endsWith("qwen3.5-27b") ? rec("gone") : t.endsWith("qwen3-5-27b") ? rec("gone") : null);
  const st3 = { ...reduce(initState([row], { nowMs: NOW }), { benchOf: dead }).state, level: 1, provider: row };
  assert.equal(view(st3).fullAlias, null);
});

test("enter on an alias row selects THAT row, never the sibling (surface, do not substitute)", () => {
  const { row, get } = ALIAS_ROW();
  const st = { ...reduce(initState([row], { nowMs: NOW }), { benchOf: get }).state, level: 1, provider: row };
  assert.equal(reduce(st, "\r").exit.target, "alibaba/qwen3-5-27b");
  const flat = reduce(reduce(initState([row], { nowMs: NOW }), { benchOf: get }).state, "\t").state;
  assert.equal(reduce(flat, "\r").exit.target, "alibaba/qwen3-5-27b");
  assert.equal(view(flat).fullAlias, "qwen3.5-27b");
});

test("the legend explains the blank FREE? badge and the `= id (works)` label", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n");
  assert.match(text, /FREE\? route whose last probe/);
  assert.match(text, /payment\s+required/);
  assert.match(text, /= id \(works\)/);
  assert.match(text, /enter still selects the row you are on/);
});

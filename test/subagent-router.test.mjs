// The policy router (router/uw-router.next.cjs) against its own contract (plan 6, 9.1). Every test copies the file into a
// scratch tree laid out as tmp/spike/uw-router.cjs so the real file and its __dirname-derived state path are exercised and
// NEVER the live state/subagent; the repo location is never required (a contract test enforces that).
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as LIB from "../keysync/subagent-policy.mjs";

// UW_HELPERS_ONLY=1 (set by test/perf/subagent-router-perf.mjs) imports this file for its harness helpers WITHOUT registering a test.
const test = process.env.UW_HELPERS_ONLY ? () => {} : nodeTest;
guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = process.env.UW_TEST_ROUTER || path.join(ROOT, "router", "uw-router.next.cjs");   // the override lets a mutation run point the whole file at a mutated copy
const req$ = createRequire(import.meta.url);
const SONNET = "anthropic/claude-sonnet-5-5", HAIKU = "anthropic/claude-haiku-4-5", OPUS = "anthropic/claude-opus-5";
const IDENT = { model: OPUS }, GROQ = "groq/g1";

const row = (s, o = {}) => ({ s, c: 200000, f: 0, t: "u", h: 0, m: 0, n: 0, i: "$1/$2", p: 0, pb: 0, al: 0, fp: 0, ft: 0, ...o });
/**
 * A compiled policy in the 5.2 shape. `rows` are the allowed rows in rank order; lists are derived unless given. The router v2 VERIFIES contentHash, so the hash is
 * the real one (the library's hashOf); `hash` is only a label that makes two fixtures differ (it is carried in thinProviders, which is inside the hash).
 */
function mkPolicy({ owner = {}, rows = [], all, byProvider, exempt = [], ctxHints = {}, tiers = {}, inject, hash = "h0000000001", empty = false, withProv = false, rollout, minRouter } = {}) {
  const models = rows.map((r, i) => ({ g: i, ...r }));
  const bp = byProvider ?? models.reduce((a, r, i) => { (a[r.s.split("/")[0]] ??= []).push(i); return a; }, {});
  return rehash({
    ...(minRouter !== undefined ? { minRouter } : {}), ...(rollout ? { rollout } : {}),
    schema: 1, contentHash: "", compiledAt: "2026-10-03T00:00:00.000Z",
    owner: { source: "same-provider", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", classLog: "on", ...owner },
    builtFrom: {}, empty, emptyReasons: [], emptyProviders: [], thinProviders: [hash], tiers, substitutable: {}, exempt, ctxHints,
    counts: { universe: rows.length, allowed: rows.length, unverified: rows.length, premium: 0, payloadRisk: 0 },
    models, lists: { all: all === undefined ? models.map((_, i) => i) : all, byProvider: bp,
      ...(withProv ? { prov: models.reduce((a, r, i) => { (a[r.s.split("/")[0]] ??= []).push(i); return a; }, {}) } : {}) }, main: { ttlSec: 21600 }, sticky: { ttlSec: 21600, maxEntries: 256 },
    inject: inject ?? { all: "", byProvider: {}, empty: "EMPTYTEXT", promptNote: "" },
  });
}
/** Re-stamp the hash of an object after a test changed hashed content; strings (a deliberately tampered file) are written as they are. */
function rehash(p) { p.contentHash = LIB.hashOf(p); return p; }
const cfg = (...ps) => ({ Providers: ps.map(([name, models, enabled]) => ({ name, models, ...(enabled === undefined ? {} : { enabled }) })) });
const CFG = cfg(["anthropic", ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-5"]], ["groq", ["g1", "g2", "g3", "g4"]], ["cohere", ["c1"]]);

function env(policy, { slot = IDENT, file = NEXT } = {}) {
  const dir = mkTmp("uw-rt-");
  const spike = path.join(dir, "spike"), state = path.join(dir, "state", "subagent");
  fs.mkdirSync(spike, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  const live = path.join(spike, "uw-router.cjs");
  fs.copyFileSync(file, live);
  if (slot !== null) fs.writeFileSync(path.join(spike, "slot.json"), typeof slot === "string" ? slot : JSON.stringify(slot));
  const policyFile = path.join(state, "policy.json");
  const setPolicy = (p) => { fs.writeFileSync(policyFile, typeof p === "string" ? p : JSON.stringify(rehash(p))); const t = new Date(Date.now() + env.bump++ * 1000); fs.utimesSync(policyFile, t, t); };
  if (policy) setPolicy(policy);
  const route = req$(live);
  route.__test.reset();
  let clock = Date.parse("2026-10-03T12:00:00.000Z");
  route.__test.now = () => clock;
  const lines = (f) => { try { return fs.readFileSync(path.join(state, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { dir, state, spike, route, setPolicy, policyFile, lines, tick: (ms) => { clock += ms; }, setClock: (t) => { clock = t; },
    status: () => { route.__test.flush(); return JSON.parse(fs.readFileSync(path.join(state, "status.json"), "utf8")); },
    drain: drainWrites,
    counters: () => globalThis.__uwSub?.counters ?? {}, files: () => fs.readdirSync(state) };
}
env.bump = 1;
/** Resolves when no async write is in flight or waiting (polls the router's own state object; gives up after 3 s). The router has no test-only drain: a test must not need one in production bytes. */
async function drainWrites() {
  const t0 = Date.now();
  while (globalThis.__uwSub && globalThis.__uwSub.wr.size > 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 2));
}
/** A patched COPY of the router (a text transformation written to a scratch file) for the few tests that need a seam production bytes do not have. */
function patchedRouter(pairs) {
  let src = fs.readFileSync(NEXT, "utf8");
  for (const [a, b] of pairs) { assert.equal(src.split(a).length, 2, `patch anchor must be unique: ${a.slice(0, 60)}`); src = src.replace(a, () => b); }
  const f = path.join(mkTmp("uw-patch-"), "uw-router.patched.cjs");
  fs.writeFileSync(f, src);
  return f;
}
const TAMPER = [["const finish = (cls, ret, pass) => {", "const finish = (cls, ret, pass) => { if (globalThis.__uwTamper) ret = globalThis.__uwTamper(cls, ret);"]];

const main = (model, { sid = "s1", tools = [{ name: "Agent", description: "spawn", input_schema: { properties: { prompt: { description: "p" } } } }, { name: "Read" }], headers = {}, ...rest } = {}) =>
  ({ body: { model, tools, ...(rest.body ?? {}) }, headers: { "x-claude-code-session-id": sid, ...headers }, sessionId: sid, ...rest.extra });
const sub = (model, { sid = "s1", agent = "ag1", tools = [{ name: "Read" }, { name: "Bash" }], tag, tokenCount, bytes, beta, bl = true, headers = {}, noAgent = false } = {}) => ({
  body: { model, tools }, sessionId: sid, builtInClaudeCodeSubagent: bl, ...(tag ? { builtInSubagentModel: tag } : {}), ...(tokenCount !== undefined ? { tokenCount } : {}),
  headers: { "x-claude-code-session-id": sid, ...(noAgent ? {} : { "x-claude-code-agent-id": agent }), ...(bytes ? { "content-length": String(bytes) } : {}), ...(beta ? { "anthropic-beta": beta } : {}), ...headers } });
const aux = (model, o = {}) => sub(model, { ...o, tools: [] });
const learn = async (e, model = SONNET, sid = "s1") => e.route(main(model, { sid }), CFG, {});

// A policy used by most tests: anthropic and groq rows, ranked.
const ROWS = [
  row(SONNET, { c: 1000000, t: "v", i: "$3/$15" }), row(HAIKU, { c: 200000, t: "v" }), row(OPUS, { c: 1000000, p: 1, t: "v", i: "$15/$75" }),
  row("groq/g1", { c: 131072 }), row("groq/g2", { c: 131072 }), row("groq/g3", { c: 131072 }), row("groq/g4", { c: 64000 }), row("cohere/c1", { c: 128000 }),
];
const POL = (owner = {}, extra = {}) => mkPolicy({ owner, rows: ROWS, ...extra });

// ---------------------------------------------------------------------------------------------- legacy behaviour
test("policy absent: asked is returned, an empty model returns undefined, the exact slot rewrites", async () => {
  const e = env(null, { slot: { model: "groq/g1" } });
  assert.equal(await e.route({ body: { model: "anthropic/claude-sonnet-5" } }, { Providers: [] }, {}), "anthropic/claude-sonnet-5");
  assert.equal(await e.route({ body: { model: "" } }, CFG, {}), undefined);
  assert.equal(await e.route({ body: {} }, CFG, {}), undefined);
  assert.equal(await e.route({ body: { model: OPUS } }, CFG, {}), "groq/g1");
  assert.equal(await e.route({ body: { model: "claude-opus-5" } }, CFG, {}), "groq/g1");
});

test("exact slot, never a substring: longer ids and [1m] spellings are served as asked; a corrupt slot returns asked", async () => {
  const e = env(null, { slot: { model: "groq/g1" } });
  for (const id of ["anthropic/claude-opus-5-5", "claude-opus-5[1m]", "x-claude-opus-5-y", "openrouter/anthropic/claude-opus-5.5"]) {
    assert.equal(await e.route({ body: { model: id } }, CFG, {}), id, id);
  }
  for (const bad of ["{not json", "", JSON.stringify({ model: "" }), JSON.stringify({ nope: 1 })]) {
    const e2 = env(null, { slot: bad });
    assert.equal(await e2.route({ body: { model: OPUS } }, CFG, {}), OPUS, `slot ${JSON.stringify(bad)}`);
    assert.ok(e2.counters().slotError >= 1);
    assert.ok(e2.status().warnings.some((w) => w.code === "SLOT_ERROR"));
  }
  const e3 = env(null, { slot: null });                              // slot.json missing entirely
  assert.equal(await e3.route({ body: { model: OPUS } }, CFG, {}), OPUS);
});

test("differential against git 6edfdee: policy absent, 500 generated ids, only the asserted intended differences", async () => {
  const g = spawnSync("git", ["show", "6edfdee:spike/uw-router.cjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(g.status, 0, g.stderr);
  const oldDir = mkTmp("uw-old-");
  fs.mkdirSync(path.join(oldDir, "spike"));
  fs.writeFileSync(path.join(oldDir, "spike", "uw-router.cjs"), g.stdout);
  fs.writeFileSync(path.join(oldDir, "spike", "slot.json"), JSON.stringify(IDENT));
  const oldRoute = req$(path.join(oldDir, "spike", "uw-router.cjs"));
  const e = env(null);
  let seed = 12345;
  const rnd = (n) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const bits = ["anthropic/", "openrouter/", "claude-", "opus", "-5", "-5-5", "[1m]", "sonnet", "haiku", "x", "/", ":free", "é", "日本", "auto", "claude-opus-5", ""];
  const ids = ["", "claude-opus-5", OPUS, `${"y".repeat(10240)}`, "claude-opus-5[1m]", "anthropic/claude-opus-5-5", "Claude-Opus-5", "\u0000"];
  while (ids.length < 500) ids.push(Array.from({ length: 1 + rnd(5) }, () => bits[rnd(bits.length)]).join(""));
  const differences = [];
  for (const id of ids) {
    const o = await oldRoute({ body: { model: id } }), n = await e.route({ body: { model: id } }, CFG, {});
    if (o === n) continue;
    const exact = id === OPUS || id === "claude-opus-5";
    assert.ok(id.includes("claude-opus-5") && !exact, `unexplained difference for ${JSON.stringify(id.slice(0, 40))}: ${o} vs ${n}`);
    assert.equal(n, id, "intended difference (D-e): a longer id that merely contains the substring is served as asked");
    assert.equal(o, OPUS, "the old router rewrote it to the slot model");
    differences.push(id);
  }
  assert.ok(differences.length >= 1, "the generated set must exercise the substring case at least once");
  // intended difference 1: a corrupt slot used to return undefined
  fs.writeFileSync(path.join(oldDir, "spike", "slot.json"), "{bad");
  assert.equal(await oldRoute({ body: { model: OPUS } }), undefined);
  const e2 = env(null, { slot: "{bad" });
  assert.equal(await e2.route({ body: { model: OPUS } }, CFG, {}), OPUS);
});

// ---------------------------------------------------------------------------------------------- policy file states
test("missing, corrupt, oversize, wrong-schema, BOM-prefixed and directory policy files all return asked, no throw", async () => {
  const valid = JSON.stringify(POL());
  const cases = {
    corrupt: "{nope", schema: JSON.stringify({ ...POL(), schema: 2 }), bom: `﻿${valid}`,
    oversize: JSON.stringify({ ...POL(), pad: "x".repeat(1024 * 1024 + 10) }),
  };
  for (const [name, text] of Object.entries(cases)) {
    const e = env(text);
    for (let i = 0; i < 3; i++) assert.equal(await e.route(sub(HAIKU), CFG, {}), HAIKU, name);
    assert.ok(e.counters().policyBad >= 3, `${name}: policyBad counted`);
    assert.ok(e.status().warnings.some((w) => /^POLICY_/.test(w.code)), `${name}: state recorded`);
  }
  const e = env(null);
  fs.mkdirSync(e.policyFile);                                         // a directory where the file should be
  assert.equal(await e.route(sub(HAIKU), CFG, {}), HAIKU);
  const absent = env(null);
  assert.equal(await absent.route(sub(HAIKU), CFG, {}), HAIKU);
  assert.equal(absent.counters().policyBad, 0, "absent is silent, not a warning");
});

// ---------------------------------------------------------------------------------------------- classification
test("classification matrix: main, subagent, aux by each signal alone and together; detectorDisagree counted", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  await learn(e);
  const cases = [
    ["agent-id only, tools", sub(OPUS, { bl: false }), "sub"],
    ["billing only, tools", sub(OPUS, { noAgent: true }), "sub"],
    ["both, tools", sub(OPUS), "sub"],
    ["agent-id only, no tools", aux(HAIKU, { bl: false }), "aux"],
    ["billing only, no tools", aux(HAIKU, { noAgent: true }), "aux"],
    ["both, no tools", aux(HAIKU), "aux"],
    ["neither, tools without an Agent tool", { body: { model: OPUS, tools: [{ name: "Read" }] }, headers: { "x-claude-code-session-id": "s1" }, sessionId: "s1" }, "main"],
    ["neither, no tools", { body: { model: OPUS }, headers: {}, sessionId: "s1" }, "main"],
  ];
  for (const [name, r, cls] of cases) {
    const before = e.lines("classify.jsonl").length;
    await e.route(r, CFG, {});
    const l = e.lines("classify.jsonl");
    assert.equal(l.length, before + 1, `${name}: exactly one classification line`);
    assert.equal(l.at(-1).cls, cls, name);
  }
  assert.ok(e.counters().detectorDisagree >= 4, "agent-id without billing and billing without agent-id both disagree");
  assert.ok(e.status().matrix["a1.b1.t1.g0"] >= 1 && e.status().matrix["a1.b1.t0.g0"] >= 1);
});

test("aux (helper) calls are returned as asked in every mode, never substituted, never inherit, never create a sticky entry", async () => {
  for (const mode of ["dynamic", "inherit", "free"]) {
    const e = env(POL({ mode, enforcement: "enforce", source: "all-providers" }), { slot: null });
    await learn(e, OPUS);
    assert.equal(await e.route(aux(HAIKU, { agent: "t1" }), CFG, {}), HAIKU, mode);
    assert.equal(await e.route(aux("groq/zz-not-in-set", { agent: "t2" }), CFG, {}), "groq/zz-not-in-set", mode);
    assert.equal(e.counters().aux, 2);
    assert.equal(globalThis.__uwSub.agent.size, 0, "an aux request never creates a sticky entry");
    assert.equal(e.lines("decisions.jsonl").filter((l) => l.act === "substitute" || l.act === "inherit").length, 0);
  }
});

test("helper-call accounting: auxOnRelay and aux volume by model and bytes, bounded at 16 models; classLog has the closed field set and no body", async () => {
  const e = env(POL({ enforcement: "enforce" }, {}), { slot: null });
  const p = JSON.parse(fs.readFileSync(e.policyFile, "utf8")); p.tiers = { anthropic: "subscription" };
  e.setPolicy(p);
  const secret = "HOSTILE-SYSTEM-PROMPT-TEXT";
  const r = aux(HAIKU, { bytes: 49 * 1024 }); r.body.system = secret; r.body.messages = [{ role: "user", content: secret }];
  await e.route(r, CFG, {});
  await e.route(aux(HAIKU, { bytes: 300 * 1024, agent: "t9" }), CFG, {});
  for (let i = 0; i < 40; i++) await e.route(aux(`vendor${i}/m`, { agent: `u${i}` }), CFG, {});
  const st = e.status();
  assert.equal(st.counters.auxOnRelay, 2);
  assert.deepEqual([st.aux.byModel[HAIKU].n, st.aux.byModel[HAIKU].bytesMax], [2, 300 * 1024]);
  assert.ok(Object.keys(st.aux.byModel).length <= 16);
  const all = [...e.files()].map((f) => fs.readFileSync(path.join(e.state, f), "utf8")).join("\n");
  assert.ok(!all.includes(secret), "no body text in any file written");
  const first = e.lines("classify.jsonl")[0];
  assert.deepEqual(Object.keys(first).sort(), ["ag", "aid", "at", "bb", "bl", "cls", "ga", "hasSid", "m", "nt", "pid8", "rc", "sid", "sysb", "t", "tc", "ua"]);   // R-v3: hasSid and ua are the two added fields
  assert.equal(first.bb, "b0"); assert.equal(first.sysb, "s1");
});

test("size buckets fall in their buckets at the boundaries (sysb, bb)", async () => {
  const e = env(POL(), { slot: null });
  const mk = (sysLen, bytes) => { const r = aux(HAIKU, { bytes }); r.body.system = "x".repeat(sysLen); return r; };
  const cases = [[0, 0, "s0", null], [1, 1, "s1", "b0"], [2047, 50 * 1024 - 1, "s1", "b0"], [2048, 50 * 1024, "s2", "b1"], [16384, 200 * 1024 - 1, "s2", "b1"],
    [16385, 200 * 1024, "s3", "b2"], [20000, 1024 * 1024 - 1, "s3", "b2"], [20000, 1024 * 1024, "s3", "b3"]];
  for (const [sl, by, sysb, bb] of cases) {
    await e.route(mk(sl, by), CFG, {});
    const l = e.lines("classify.jsonl").at(-1);
    assert.deepEqual([l.sysb, l.bb], [sysb, bb], `system ${sl} bytes ${by}`);
  }
});

test("background-call hazard both ways: only an Agent-tool request with a session id teaches main; aux never changes main", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  const bg = { body: { model: HAIKU }, headers: { "x-claude-code-session-id": "s1" }, sessionId: "s1" };
  await e.route(bg, CFG, {});                                                               // no agent id, no tools
  await e.route({ body: { model: HAIKU, tools: [{ name: "Read" }] }, headers: {}, sessionId: "s1" }, CFG, {});   // tools but no Agent tool
  await e.route(main(HAIKU, { sid: "nosuch/../x" }), CFG, {});                              // unusable session id never teaches
  await e.route(aux(HAIKU), CFG, {});                                                       // agent-id, no tools
  assert.equal(globalThis.__uwSub.main.size, 0);
  assert.equal(await e.route(sub(OPUS, { agent: "a9" }), CFG, {}), OPUS, "unknown main under inherit returns asked");
  await learn(e, SONNET, "s1");
  await learn(e, GROQ, "s2");
  assert.equal(globalThis.__uwSub.main.get("s1").model, SONNET, "two sessions interleaved keep separate mains");
  assert.equal(globalThis.__uwSub.main.get("s2").model, GROQ);
});

test("main older than the TTL is ignored (injected clock)", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  await learn(e, SONNET);
  assert.equal(await e.route(sub(HAIKU, { agent: "a1" }), CFG, {}), SONNET);
  e.tick(6 * 3600 * 1000 + 1000);
  assert.equal(await e.route(sub(HAIKU, { agent: "a2" }), CFG, {}), HAIKU, "stale main is unknown, so asked is served");
});

// ---------------------------------------------------------------------------------------------- toggle grid
// F7(ii): the grid asserts act, would AND ret in every cell against an oracle kept in this file. HONEST LIMITS of that oracle:
//  - it is a TRANSLITERATION of decide() (plan 6.2 read once and written out again here), not an independent specification; a misreading
//    of 6.2 that was made in both places would pass. Its value is that every branch outcome is pinned cell by cell, not that it is a second opinion.
//  - every ranked row in this grid has its own rank group, so the "lead group first, then the next ranked rows" branch of the top-3 pick is NOT
//    exercised here: the test "substitutes spread over the top 3..." (and the funnel's rank tests) cover it separately.
//  - the 240 cells are not 240 different behaviours. Under inherit the source toggle is ignored (half its cells repeat), and mode free differs
//    from dynamic ONLY in the freeBreak flag and counter under enforcement (shadow free repeats shadow dynamic): about 160 of the 240 cells are
//    behaviourally distinct. The count is asserted below so this comment cannot drift from the grid.
test("toggle grid: 2 sources x 3 modes x 2 ctx x main known/unknown x 5 ask cases, shadow and enforce: act, would and ret equal the plan 6.2 oracle in every cell", async () => {
  const { fnv1a32 } = await import("../menu/subagent-funnel.mjs");
  const providerOf = (s) => s.split("/")[0];
  const resolvableSel = (sel) => CFG.Providers.some((p) => sel.startsWith(`${p.name}/`) && p.models.includes(sel.slice(p.name.length + 1)));
  const EXEMPT = [HAIKU], HINTS = { [HAIKU]: 200000 };
  // the expected {act, would} for one cell; ret follows from it (shadow: asked; enforce: would ?? asked)
  const oracle = ({ source, mode, ctx, known, agent, asked, tag }) => {
    const rows = ctx === "1m" ? ROWS.filter((r) => r.c >= 1000000) : ROWS;
    const main = known ? SONNET : null;
    if (mode === "inherit") {
      if (EXEMPT.includes(asked)) return { act: "keep", would: asked };
      if (!main) return { act: "unknown-main", would: null };
      if (!resolvableSel(main)) return { act: "unresolvable", would: null };
      return { act: main === asked ? "keep" : "inherit", would: main };
    }
    const same = source !== "all-providers";
    if (same && !main) return { act: "unknown-main", would: null };
    const S0 = same ? rows.filter((r) => providerOf(r.s) === providerOf(main)) : rows;
    if (!S0.length) return { act: "empty-set", would: null };
    const want = tag ?? asked;
    if (S0.some((r) => r.s === want) && resolvableSel(want)) return { act: want === asked ? "keep" : "honour-tag", would: want };
    const floor = Math.max(HINTS[asked] ?? 0, 128000);
    const pool = S0.filter((r) => resolvableSel(r.s) && r.c >= floor);
    let cand = null;
    if (main && pool.some((r) => r.s === main)) cand = main;
    else if (pool.length) {
      const mp = main ? pool.filter((r) => providerOf(r.s) === providerOf(main)) : [];
      const pool2 = mp.length ? mp : pool;
      const top = pool2.slice(0, 3);                                             // every row here has its own rank group, so the lead group is one row and the rest fill in rank order
      cand = top[fnv1a32(agent) % top.length].s;
    }
    if (cand) return { act: resolvableSel(asked) ? "substitute" : "reject-unresolvable", would: cand };
    return { act: "unresolvable", would: null };
  };
  let n = 0, nonTrivial = new Set();
  const distinct = new Set();
  for (const source of ["same-provider", "all-providers"]) for (const mode of ["dynamic", "inherit", "free"]) for (const ctx of ["any", "1m"]) {
    for (const known of [true, false]) for (const enforcement of ["shadow", "enforce"]) {
      const rows = ctx === "1m" ? ROWS.filter((r) => r.c >= 1000000) : ROWS;
      const e = env(mkPolicy({ owner: { source, mode, ctx, enforcement }, rows, exempt: EXEMPT, ctxHints: HINTS }), { slot: null });
      const inSetSel = rows[0].s;
      const asks = [["asked in set", inSetSel, undefined], ["tag in set", HAIKU, inSetSel], ["tag out of set", HAIKU, "groq/g4"], ["asked out of set", "groq/g4", undefined], ["asked unresolvable", "nowhere/x", undefined]];
      let breaks = 0;                                                                       // free-mode promise breaks this cell group should have counted
      for (const [name, asked, tag] of asks) {
        const sid = `g${n}`, agent = `agent-${n}`;
        n += 1;
        if (known) await learn(e, SONNET, sid);
        const r = sub(asked, { sid, agent, tag });
        const ret = await e.route(r, CFG, {});
        const want = oracle({ source, mode, ctx, known, agent, asked, tag });
        const line = e.lines("decisions.jsonl").filter((l) => l.sid === sid.slice(0, 8) && l.role === "sub").at(-1);
        const label = `${source}/${mode}/${ctx}/known=${known}/${enforcement}/${name}`;
        assert.ok(line, `${label}: a decision line was written`);
        assert.deepEqual([line.act, line.would ?? null], [want.act, want.would], `${label}: act and would`);
        const expectRet = enforcement === "shadow" ? asked : (want.would ?? asked);
        assert.equal(ret, expectRet, `${label}: the returned model`);
        assert.equal(line.ret, expectRet, `${label}: the logged ret is what was returned`);
        nonTrivial.add(want.act);
        // free mode (G16): a fall-through that serves nothing of its own is a PROMISE BREAK, flagged and counted, in enforce only (shadow returns before it)
        const broke = mode === "free" && enforcement === "enforce" && want.would === null;
        if (broke) breaks += 1;
        assert.equal((line.flags ?? []).includes("FREE_PROMISE_BREAK"), broke, `${label}: the FREE_PROMISE_BREAK flag`);
        distinct.add([mode === "inherit" ? "-" : source, mode === "inherit" ? "inherit" : mode === "free" && enforcement === "enforce" ? "free" : "dynamic", ctx, known, enforcement, name].join("/"));
      }
      assert.equal(e.counters().freeBreak, breaks, `${source}/${mode}/${ctx}/known=${known}/${enforcement}: the freeBreak counter`);
      if (mode === "free" && enforcement === "enforce" && !known && source === "same-provider") assert.ok(breaks > 0, "the grid does exercise a free promise break");
    }
  }
  assert.equal(n, 240, "of 2 sources x 3 modes x 2 ctx x 2 main states x 5 asks, each run in shadow and enforce");
  assert.equal(distinct.size, 160, "inherit ignores source (40 cells), dynamic and free-in-shadow coincide (80), free-in-enforce differs by the break flag (40)");
  for (const act of ["keep", "honour-tag", "substitute", "reject-unresolvable", "inherit", "unknown-main", "unresolvable", "empty-set"]) {
    if (act === "unresolvable" || act === "empty-set") continue;                      // those two need a degenerate policy: pinned by their own tests below
    assert.ok(nonTrivial.has(act), `the grid exercised act ${act}`);
  }
});


test("inherit ignores source; exempt haiku/small-fast is left alone under inherit only; INHERIT flags (D-d, D-b)", async () => {
  for (const source of ["same-provider", "all-providers"]) {
    const e = env(mkPolicy({ owner: { mode: "inherit", source, enforcement: "enforce", ctx: "1m" }, rows: ROWS, exempt: [HAIKU] }), { slot: null });
    await learn(e, OPUS);                                                                   // premium main
    assert.equal(await e.route(sub(SONNET, { agent: "a1" }), CFG, {}), OPUS, "gets main's exact model whatever the source");
    assert.equal(await e.route(sub(HAIKU, { agent: "a2" }), CFG, {}), HAIKU, "exempt under inherit");
    const l = e.lines("decisions.jsonl");
    assert.ok(l.find((x) => x.act === "inherit").flags.includes("INHERIT_PREMIUM_MAIN"));
  }
  const e = env(mkPolicy({ owner: { mode: "inherit", enforcement: "enforce", ctx: "1m" }, rows: ROWS }), { slot: null });
  await learn(e, "groq/g1");                                                                // sub-1M main: inherited anyway, with a flag
  assert.equal(await e.route(sub(SONNET), CFG, {}), "groq/g1");
  assert.ok(e.lines("decisions.jsonl").at(-1).flags.includes("INHERIT_BELOW_CTX"));
  const d = env(mkPolicy({ owner: { mode: "dynamic", enforcement: "enforce", source: "all-providers" }, rows: ROWS, exempt: [HAIKU] }), { slot: null });
  await learn(d, SONNET);
  const hk = await d.route(sub(HAIKU, { agent: "z" , tag: "groq/g4"}), CFG, {});
  assert.notEqual(d.lines("decisions.jsonl").at(-1).act, "keep", "dynamic never exempts a tool-carrying haiku subagent (I8b)");
  void hk;
});

test("substitute: floor max(asked ctx,128k) even under ctx any, token and payload fit, counted skips", async () => {
  const rows = [row("groq/g4", { c: 64000 }), row("groq/g1", { c: 131072 }), row("groq/g2", { c: 131072, pb: 100000 }), row("groq/g3", { c: 0 })];
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  assert.ok(["groq/g1", "groq/g2"].includes(await e.route(sub("anthropic/claude-haiku-4-5", { agent: "a1" }), CFG, {})), "64k and unknown ctx are never substitutes");
  // a request too large for g1's window: skipped, counted; nothing left, so asked is served
  assert.equal(await e.route(sub("anthropic/claude-haiku-4-5", { agent: "a2", tokenCount: 200000 }), CFG, {}), "anthropic/claude-haiku-4-5");
  assert.ok(e.counters().ctxSkip >= 1);
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [rows[2], rows[1]] }), { slot: null });
  assert.equal(await e2.route(sub(HAIKU, { agent: "a1", bytes: 500000 }), CFG, {}), "groq/g1", "g2's payload cap 100000 is below the request, so g1 serves");
  assert.ok(e2.counters().payloadSkip >= 1);
  // the asked model's own context sets the floor: asked 1M-ctx hint, candidates below it are skipped
  const e3 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1", { c: 131072 }), row("groq/g2", { c: 1000000 })], ctxHints: { [SONNET]: 1000000 } }), { slot: null });
  assert.equal(await e3.route(sub(SONNET, { agent: "a1" }), CFG, {}), "groq/g2");
});

test("substitutes spread over the top 3 for 12 agent ids and each agent id always gets the same one; fragile when fewer than 3", async () => {
  const rows = ["g1", "g2", "g3", "g4"].map((m) => row(`groq/${m}`, { c: 131072, g: 0 }));
  rows[3].g = 1;                                                    // g4 ranks below the three tied rows
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  const got = new Map();
  for (let i = 0; i < 12; i++) {
    const a = await e.route(sub(HAIKU, { agent: `agent-${i}` }), CFG, {});
    got.set(`agent-${i}`, a);
    assert.ok(["groq/g1", "groq/g2", "groq/g3"].includes(a), `top-3 only, got ${a}`);
  }
  assert.ok(new Set(got.values()).size >= 2, "a fan-out spreads");
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  for (const [k, v] of got) assert.equal(await e2.route(sub(HAIKU, { agent: k }), CFG, {}), v, "deterministic across a fresh router");
  const e3 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: rows.slice(0, 2) }), { slot: null });
  await e3.route(sub(HAIKU, { agent: "x" }), CFG, {});
  assert.ok(e3.lines("decisions.jsonl").at(-1).flags.includes("FRAGILE_SET"));
});

test("tag handling: an in-set tag is honoured; an out-of-set tag is never honoured and dropTag clears it", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  assert.equal(await e.route(sub(HAIKU, { agent: "a1", tag: "groq/g2" }), CFG, {}), "groq/g2");
  const r = sub(HAIKU, { agent: "a2", tag: "evil/model" });
  const ret = await e.route(r, CFG, {});
  assert.notEqual(ret, "evil/model");
  assert.equal(r.builtInSubagentModel, undefined, "E13: the out-of-set tag is cleared so CCR's chain cannot honour it");
  assert.equal(e.lines("decisions.jsonl").at(-1).act, "substitute");
});

test("unresolvable: a candidate not in config.Providers is skipped; none resolvable returns asked and counts unresolvable", async () => {
  const rows = [row("ghost/m1", { c: 200000 }), row("groq/g1", { c: 200000 })];
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  assert.equal(await e.route(sub(HAIKU, { agent: "a1" }), CFG, {}), "groq/g1");
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [rows[0]] }), { slot: null });
  assert.equal(await e2.route(sub(HAIKU, { agent: "a1" }), CFG, {}), HAIKU);
  assert.ok(e2.counters().unresolvable >= 1);
});

test("reject-unresolvable: an unresolvable asked with a resolvable in-set candidate returns the candidate; none sets UNRESOLVABLE_ASKED", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  assert.equal(typeof await e.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), "string");
  assert.equal(e.lines("decisions.jsonl").at(-1).act, "reject-unresolvable");
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("ghost/m", { c: 200000 })] }), { slot: null });
  assert.equal(await e2.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), "nowhere/x");
  assert.ok(e2.status().warnings.some((w) => w.code === "UNRESOLVABLE_ASKED"));
});

test("one resolvability rule: a fixture grid gives the same verdict in the router and in the funnel library", async () => {
  const { resolvable } = await import("../menu/subagent-funnel.mjs");
  const cases = [
    [[{ name: "p", models: ["m"] }], "p/m", true], [[{ name: "p", models: ["m"], enabled: false }], "p/m", false], [[{ name: "p", models: ["m"], enabled: true }], "p/m", true],
    [[{ name: "p", models: "m" }], "p/m", false], [[{ name: "p" }], "p/m", false], [[{ name: "p", models: ["m[1m]"] }], "p/m[1m]", true],
    [[{ name: "p", models: ["m"] }], "p/other", false], [[{ name: "q", models: ["m"] }], "p/m", false], [null, "p/m", false],
  ];
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  for (const [providers, sel, want] of cases) {
    assert.equal(resolvable(sel, providers), want, `library ${sel}`);
    // the router's verdict, observed through an in-set tag that is only honoured when resolvable
    const p = mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row(sel, { c: 200000 })] });
    e.setPolicy(p); e.route.__test.reset();
    const r = sub("zzz/ask", { agent: `x${Math.random()}`, tag: sel });
    const ret = await e.route(r, { Providers: providers }, {});
    assert.equal(ret === sel, want, `router ${sel}`);
  }
});

// ---------------------------------------------------------------------------------------------- empty set, free promise
test("empty set (D-c): enforce serves asked (never main's model), status warns every time, exactly ONE empty-set line per session", async () => {
  const p = mkPolicy({ owner: { mode: "dynamic", source: "same-provider", enforcement: "enforce" }, rows: ROWS, byProvider: {} });
  p.emptyProviders = ["groq"];
  const e = env(p, { slot: null });
  await learn(e, SONNET);
  for (let i = 0; i < 5; i++) assert.equal(await e.route(sub(HAIKU, { agent: `a${i}` }), CFG, {}), HAIKU);
  assert.equal(e.lines("decisions.jsonl").filter((l) => l.act === "empty-set").length, 1);
  assert.equal(e.counters().emptySet, 5);
  assert.ok(e.status().warnings.some((w) => w.code === "EMPTY_SET"));
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [], all: [], empty: true }), { slot: null });
  assert.equal(await e2.route(sub(HAIKU), CFG, {}), HAIKU);
});

test("free promise break (M3): a free-mode fall-through serves asked, flags FREE_PROMISE_BREAK, counts freeBreak, logs once per session", async () => {
  const e = env(mkPolicy({ owner: { mode: "free", source: "all-providers", enforcement: "enforce" }, rows: [], all: [], empty: true }), { slot: null });
  for (let i = 0; i < 3; i++) assert.equal(await e.route(sub(HAIKU, { agent: `a${i}` }), CFG, {}), HAIKU);
  assert.equal(e.counters().freeBreak, 3);
  assert.ok(e.status().warnings.some((w) => w.code === "FREE_PROMISE_BREAK"));
  const l = e.lines("decisions.jsonl");
  assert.equal(l.length, 1);
  assert.ok(l[0].flags.includes("FREE_PROMISE_BREAK"));
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [], all: [], empty: true }), { slot: null });
  await e2.route(sub(HAIKU), CFG, {});
  assert.equal(e2.counters().freeBreak, 0, "only free mode breaks a promise");
});

test("unknown values: unknown ctx fails a substitute but passes the honour path with CTX_UNKNOWN; unknown payload cap passes and is counted", async () => {
  const rows = [row("groq/g1", { c: 0 }), row("groq/g2", { c: 200000, pb: 0 })];
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  assert.equal(await e.route(sub(HAIKU, { agent: "a1", tag: "groq/g1", tokenCount: 1000 }), CFG, {}), "groq/g1");
  assert.ok(e.lines("decisions.jsonl").at(-1).flags.includes("CTX_UNKNOWN"));
  assert.equal(await e.route(sub(HAIKU, { agent: "a2", bytes: 400000 }), CFG, {}), "groq/g2");
  assert.ok(e.counters().payloadUnknown >= 1);
});

test("CTX_UNDELIVERED: an n:1 relay row without the context-1m beta header is flagged and counted", async () => {
  const rows = [row(SONNET, { c: 1000000, n: 1 })];
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  await e.route(sub(SONNET, { agent: "a1" }), CFG, {});
  assert.ok(e.lines("decisions.jsonl").at(-1).flags.includes("CTX_UNDELIVERED"));
  await e.route(sub(SONNET, { agent: "a2", beta: "context-1m-2025-08-07" }), CFG, {});
  assert.ok(!e.lines("decisions.jsonl").at(-1).flags.includes("CTX_UNDELIVERED"));
  assert.equal(e.counters().ctxUndelivered, 1);
});

// ---------------------------------------------------------------------------------------------- shadow, stickiness, rollback
test("shadow invariant: every decision line has ret === asked and the return equals the no-policy return", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  const none = env(null, { slot: null });
  await learn(e, SONNET);
  const asks = [HAIKU, OPUS, "groq/g2", "nowhere/x", SONNET, "weird model with spaces"];
  for (let i = 0; i < asks.length; i++) {
    for (const r of [sub(asks[i], { agent: `a${i}`, tag: "groq/g3" }), sub(asks[i], { agent: `b${i}`, tag: "evil/x" })]) {
      assert.equal(await e.route(r, CFG, {}), await none.route(structuredClone(r), CFG, {}));
    }
  }
  const l = e.lines("decisions.jsonl");
  assert.ok(l.length > 5);
  for (const x of l) assert.equal(x.ret, x.asked === "weird model with spaces" ? "?" : x.asked);
  assert.ok(l.some((x) => x.would && x.would !== x.ret), "shadow logs what it WOULD do");
});

test("stickiness (cr-B2, S-F9): the same agent keeps its model when main changes and when the policy is replaced by one that still contains the model; an entry that LEFT the set is decided again; ttl; evict; shadow.flag bypass", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  await learn(e, SONNET);
  const first = await e.route(sub("nowhere/x", { agent: "agent-7" }), CFG, {});
  assert.ok(first !== "nowhere/x");
  await learn(e, "groq/g1");                                                   // main switches model
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-7" }), CFG, {}), first, "identical across the main switch");
  assert.equal(e.lines("decisions.jsonl").at(-1).stk, 1);
  assert.equal(e.counters().stickyHit, 1);
  // the policy is replaced by one that still contains the model (different hash): still sticky
  const pol2 = (rows, hash) => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows, hash });
  e.setPolicy(pol2([row(first, { c: 1000000 }), row("groq/g3", { c: 200000 })], "h0000000002"));
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-7" }), CFG, {}), first, "the replacement keeps the model in the set: sticky");
  assert.equal(e.counters().stickyHit, 2);
  // the policy is TIGHTENED so the model left the set (announced deferral of S-F9): the agent is decided again
  e.setPolicy(pol2([row("groq/g3", { c: 200000 })], "h0000000003"));
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-7" }), CFG, {}), "groq/g3", "left the set: decided again, never pinned by an old entry");
  assert.equal(e.counters().stickyOut, 1); assert.equal(e.counters().stickyHit, 2);
  // a new agent decides against the NEW policy
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-8" }), CFG, {}), "groq/g3");
  // entries older than 6 h are ignored (injected clock)
  e.tick(6 * 3600 * 1000 + 1);
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-7" }), CFG, {}), "groq/g3", "TTL expired: decided fresh");
  // an unresolvable sticky model is evicted and decided fresh
  const ev = await e.route(sub("nowhere/x", { agent: "agent-9" }), CFG, {});
  assert.equal(ev, "groq/g3");
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-9" }), cfg(["groq", ["g1", "g2", "g3"]]), {}), "groq/g3");
  const gone = await e.route(sub("nowhere/x", { agent: "agent-9" }), cfg(["groq", ["g9"]]), {});
  assert.equal(e.counters().stickyEvict, 1);
  assert.equal(gone, "nowhere/x", "no resolvable candidate: asked is served");
  // rollback is not sticky
  fs.writeFileSync(path.join(e.state, "shadow.flag"), "x");
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-8" }), CFG, {}), "nowhere/x", "shadow.flag: the very next request returns asked");
  fs.rmSync(path.join(e.state, "shadow.flag"));
  assert.equal(await e.route(sub("nowhere/x", { agent: "agent-8" }), CFG, {}), "groq/g3");
});

test("S-F9 REGRESSION: a FORGED journal line cannot pin an out-of-policy model (not in the compiled set, or outside main's provider list under same-provider); the case it must not break: an honest line for an in-set model still replays", async () => {
  const forge = (e, model, agent = "f1") => fs.writeFileSync(path.join(e.state, "agents-s1.jsonl"), JSON.stringify({ k: agent, m: model, t: Date.parse("2026-10-03T12:00:00.000Z") - 1000, h: "x" }) + "\n");
  const e2 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1"), row("groq/g2")] }), { slot: null });
  forge(e2, "cohere/c1");                                                                      // resolvable in CFG, but NOT in this policy's set
  const got = await e2.route(sub("nowhere/x", { agent: "f1" }), CFG, {});
  assert.match(got, /^groq\/g[12]$/, "the forged model is not served");
  assert.equal(e2.counters().stickyHit, 0); assert.equal(e2.counters().stickyOut, 1);
  const e3 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1"), row("groq/g2")] }), { slot: null });
  forge(e3, "groq/g2");
  assert.equal(await e3.route(sub("nowhere/x", { agent: "f1" }), CFG, {}), "groq/g2", "an honest in-set line replays");
  assert.equal(e3.counters().stickyHit, 1);
  // O2 (CHANGED from the earlier text: a line for another provider's model was NOT pinned under same-provider; now it is, because STARTED AGENTS STAY): an honest line for a model
  // of ANOTHER provider than main's, inside the WHOLE compiled set, replays; a forged one for a model outside the whole set still does not.
  const e4 = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce" }), { slot: null });
  await learn(e4, SONNET); forge(e4, "groq/g1");
  assert.equal(await e4.route(sub("nowhere/x", { agent: "f1" }), CFG, {}), "groq/g1", "main is on anthropic, the line names a groq model that is in the compiled set: the started agent stays");
  assert.equal(e4.counters().stickyHit, 1); assert.equal(e4.counters().stickyOut, 0);
  const CFGX = cfg(["anthropic", ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-5"]], ["groq", ["g1", "g2", "g3", "g4"]], ["cohere", ["c1"]], ["extra", ["x1"]]);
  const e5 = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce" }), { slot: null });
  await learn(e5, SONNET); forge(e5, "extra/x1");
  assert.match(await e5.route(sub("nowhere/x", { agent: "f1" }), CFGX, {}), /^anthropic\//, "resolvable but outside the whole compiled set: not pinned, decided again from main's provider");
  assert.equal(e5.counters().stickyHit, 0); assert.equal(e5.counters().stickyOut, 1);
});

test("O2 REGRESSION (owner: started agents stay): under same-provider a `/model` switch to another provider no longer re-decides RUNNING agents; NEW agents follow the new main; an agent whose model LEFT the whole compiled set (or is unresolvable) is decided again; after main's entry expired the started agent still stays", async () => {
  const e = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce" }), { slot: null });
  await learn(e, SONNET);
  const first = await e.route(sub("nowhere/x", { agent: "run1" }), CFG, {});
  assert.match(first, /^anthropic\//);
  await learn(e, "groq/g1");                                                    // /model switch to ANOTHER provider
  assert.equal(await e.route(sub("nowhere/x", { agent: "run1" }), CFG, {}), first, "the running agent stays on its anthropic model (the old code re-decided it on groq)");
  assert.equal(e.counters().stickyHit, 1); assert.equal(e.counters().stickyOut, 0);
  assert.match(await e.route(sub("nowhere/x", { agent: "new1" }), CFG, {}), /^groq\//, "a NEW agent follows the new main");
  // main's entry expires (6 h after it was learned) while the agent keeps being used (its own sliding clock moves): the started agent still stays, a NEW agent is unknown-main (served asked)
  e.tick(3 * 3600 * 1000);
  assert.equal(await e.route(sub("nowhere/x", { agent: "run1" }), CFG, {}), first);
  e.tick(3.5 * 3600 * 1000);
  assert.equal(await e.route(sub("nowhere/x", { agent: "run1" }), CFG, {}), first, "no main needed to serve a started agent");
  assert.equal(await e.route(sub("nowhere/x", { agent: "new2" }), CFG, {}), "nowhere/x", "a new agent with no main (same-provider) is served asked");
  // the case it must not break: the model LEFT the compiled set (policy tightened to groq only): decided again; an unresolvable model is evicted
  e.setPolicy(mkPolicy({ owner: { mode: "dynamic", source: "same-provider", enforcement: "enforce" }, rows: [row("groq/g2"), row("groq/g3")], hash: "h0000000009" }));
  await learn(e, "groq/g2");
  assert.match(await e.route(sub("nowhere/x", { agent: "run1" }), CFG, {}), /^groq\/g[23]$/, "left the whole set: decided again");
  assert.equal(e.counters().stickyOut, 1);
  const g = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce" }), { slot: null });
  await learn(g, SONNET);
  const was = await g.route(sub("nowhere/x", { agent: "u1" }), CFG, {});
  assert.notEqual(await g.route(sub("nowhere/x", { agent: "u1" }), cfg(["groq", ["g1"]]), {}), was, "unresolvable now: evicted and decided again");
  assert.equal(g.counters().stickyEvict, 1);
});

test("ar-3a (was: every enforced outcome is recorded): an outcome with NO model of its own is not stored and is decided again next turn; a stored decision survives a router restart through agents-<sid>.jsonl; shadow bypasses it", async () => {
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [], all: [], empty: true }), { slot: null });
  assert.equal(await e.route(sub(HAIKU, { agent: "z1" }), CFG, {}), HAIKU);
  assert.equal(globalThis.__uwSub.agent.has("s1:z1"), false, "serve-asked is NOT stored (ar-3a): the next turn decides again");
  assert.equal(e.counters().stickyNone, 1); assert.equal(e.counters().stickyNew, 0);
  assert.ok(!fs.existsSync(path.join(e.state, "agents-s1.jsonl")), "and nothing is journalled for it");
  const e2 = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  await learn(e2, SONNET);                                                     // S-F6: only a session that sent a main request with an Agent tool owns files
  const first = await e2.route(sub("nowhere/x", { agent: "z1" }), CFG, {});
  assert.ok(first !== "nowhere/x");
  assert.ok(globalThis.__uwSub.agent.has("s1:z1"));
  const journal = path.join(e2.state, "agents-s1.jsonl");
  assert.ok(fs.existsSync(journal));
  const lines = fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(Object.keys(lines[0]).sort(), ["h", "k", "m", "t"], "one line per decision {k, m, t, h}");
  assert.equal(lines[0].k, "z1", "the key without the sid"); assert.equal(lines[0].m, first);
  // a fresh router (a restarted worker) whose policy would now decide differently (it still contains the model, S-F9) answers with the journalled model
  const e3 = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g3", { c: 200000 }), row(first, { c: 1000000 })], hash: "other" }), { slot: null });
  fs.copyFileSync(journal, path.join(e3.state, "agents-s1.jsonl"));
  assert.equal(await e3.route(sub("nowhere/x", { agent: "z1" }), CFG, {}), first, "the journal is replayed on the first memory miss");
  assert.equal(e3.counters().stickyHit, 1);
  const e4 = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  fs.copyFileSync(journal, path.join(e4.state, "agents-s1.jsonl"));
  await e4.route(sub(HAIKU, { agent: "z1" }), CFG, {});
  assert.equal(e4.counters().stickyHit, 0, "shadow bypasses stickiness");
});

test("sticky and main maps stay under their caps after 10,000 distinct ids and expire on the clock seam", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  for (let i = 0; i < 600; i++) { e.tick(1000); await e.route(sub("nowhere/x", { agent: `ag${i}`, sid: `s${i % 100}` }), CFG, {}); await learn(e, SONNET, `m${i}`); }
  assert.ok(globalThis.__uwSub.agent.size <= 512, `sticky ${globalThis.__uwSub.agent.size}`);     // ar-3d: 512 globally (it was 256), 128 per session
  assert.ok(globalThis.__uwSub.main.size <= 64, `main ${globalThis.__uwSub.main.size}`);
  assert.ok(globalThis.__uwSub.mainBySession.size <= 8);
  e.tick(7 * 3600 * 1000);
  for (let i = 0; i < 50; i++) await e.route(sub("nowhere/x", { agent: `late${i}` }), CFG, {});
  assert.ok(globalThis.__uwSub.agent.size <= 60, "expired entries are pruned on the 50th call");
});

// ---------------------------------------------------------------------------------------------- injection
const INJ = "[uw-subagent-policy v1 h0000000001]\nUW subagent routing policy is active.\n- groq/g1  128k  $1/$2  tools:UNVERIFIED  fast  cap:unknown";
const NOTE = "[uw-subagent-policy v1 h0000000001] note";
const injBody = (extra = "") => ({ body: { model: SONNET, tools: [
  { name: "Agent", description: `Launch an agent.${extra}`, input_schema: { properties: { prompt: { description: "The task" } } } },
  { name: "Read", description: "Read a file" }, { type: "function", function: { name: "task", description: "oa", parameters: { properties: { prompt: { description: "po" } } } } }] },
  headers: { "x-claude-code-session-id": "s1" }, sessionId: "s1" });

test("injection: appended once, replaced (not stacked) on a second call and on a retry of an owned body; only Agent/Task tools touched", async () => {
  const pol = POL({ mode: "dynamic", source: "all-providers", inject: "on" }, { inject: { all: INJ, byProvider: {}, empty: "E", promptNote: NOTE } });
  const e = env(pol, { slot: null });
  const r = injBody();
  await e.route(r, CFG, {});
  const d1 = r.body.tools[0].description;
  assert.equal(d1.split("[uw-subagent-policy").length - 1, 1);
  assert.ok(d1.startsWith("Launch an agent."));
  assert.equal(r.body.tools[1].description, "Read a file", "no other tool is touched");
  assert.ok(r.body.tools[0].input_schema.properties.prompt.description.includes(NOTE));
  assert.ok(r.body.tools[2].function.description.includes("[uw-subagent-policy"), "OpenAI-shaped function.description");
  await e.route(r, CFG, {});                                                    // retry on the same (owned) object
  assert.equal(r.body.tools[0].description, d1, "byte-identical after a second call");
  const fresh = injBody();
  await e.route(fresh, CFG, {});
  assert.equal(fresh.body.tools[0].description, d1, "same bytes for the same input");
  assert.ok(e.counters().injected >= 2);
});

test("injection is off for inject:off, inherit, a rollback flag and non-main requests: the body is deep-equal before and after", async () => {
  const mk = (owner) => env(POL(owner, { inject: { all: INJ, byProvider: { anthropic: INJ }, empty: "E", promptNote: NOTE } }), { slot: null });
  for (const [owner, label] of [[{ inject: "off", mode: "dynamic" }, "off"], [{ inject: "on", mode: "inherit" }, "inherit"]]) {
    const e = mk(owner);
    const r = injBody(), before = structuredClone(r);
    await e.route(r, CFG, {});
    assert.deepEqual(r, before, label);
  }
  const e = mk({ inject: "on", mode: "dynamic", source: "all-providers" });
  fs.writeFileSync(path.join(e.state, "shadow.flag"), "x");
  const r = injBody(), before = structuredClone(r);
  await e.route(r, CFG, {});
  assert.deepEqual(r, before, "rollback flag");
  fs.rmSync(path.join(e.state, "shadow.flag"));
  const s = sub(SONNET), sb = structuredClone(s);
  await e.route(s, CFG, {});
  assert.deepEqual(s, sb, "a subagent request is never injected");
});

test("injection with a native menu present appends the replace sentence and raises NATIVE_MENU_PRESENT; same-provider picks the main provider's text; empty text when empty", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", inject: "on" }, { inject: { all: INJ, byProvider: {}, empty: "E", promptNote: NOTE } }), { slot: null });
  const r = injBody("\n<CCR-SUBAGENT-MODEL>Provider/model</CCR-SUBAGENT-MODEL> native list");
  await e.route(r, CFG, {});
  assert.ok(r.body.tools[0].description.includes("This UW list replaces any list above."));
  assert.ok(e.status().warnings.some((w) => w.code === "NATIVE_MENU_PRESENT"));
  const sp = env(POL({ mode: "dynamic", source: "same-provider", inject: "on" }, { inject: { all: "", byProvider: { anthropic: "ANTHROPIC-TEXT", groq: "GROQ-TEXT" }, empty: "EMPTYTEXT", promptNote: "" } }), { slot: null });
  const a = injBody(); a.body.model = "groq/g1";
  await sp.route(a, CFG, {});
  assert.ok(a.body.tools[0].description.includes("GROQ-TEXT"));
  const b = injBody(); b.body.model = "cohere/c1";
  await sp.route(b, CFG, {});
  assert.ok(b.body.tools[0].description.includes("EMPTYTEXT"));
});

// ---------------------------------------------------------------------------------------------- logs, redaction, caps
test("log redaction: hostile tag and ids are logged as ?; no body, header value or config appears in any file; sid truncated; traversal sids stay inside the state dir", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  const hostile = "evil\n\"quote\u0000" + "x".repeat(10000);
  const r = sub(HAIKU, { agent: "a1", tag: hostile, headers: { authorization: "Bearer TOPSECRETVALUE", "x-extra": "HEADERVALUE" } });
  r.body.system = "SYSTEMTEXT"; r.body.messages = [{ role: "user", content: "MESSAGETEXT" }];
  await e.route(r, { Providers: [{ name: "anthropic", models: ["claude-haiku-4-5"], api_key: "KEYMATERIAL" }] }, {});
  for (const sid of ["../../evil", "..\\..\\x", "a/b", "x".repeat(200)]) await e.route(sub(HAIKU, { sid, agent: "q" }), CFG, {});
  await e.route(main(HAIKU, { sid: "..\\..\\evil" }), CFG, {});
  const text = e.files().map((f) => fs.readFileSync(path.join(e.state, f), "utf8")).join("\n");
  for (const needle of ["TOPSECRETVALUE", "HEADERVALUE", "SYSTEMTEXT", "MESSAGETEXT", "KEYMATERIAL", "evil\\n"]) assert.ok(!text.includes(needle), needle);
  const l = e.lines("decisions.jsonl")[0];
  assert.equal(l.tag, "?");
  assert.ok(l.sid.length <= 8);
  assert.ok(fs.readdirSync(path.join(e.dir, "state")).every((x) => x === "subagent"), "nothing escaped the state directory");
  assert.ok(!fs.existsSync(path.join(e.dir, "evil")) && !fs.existsSync(path.join(path.dirname(e.dir), "evil")));
  for (const x of e.lines("decisions.jsonl")) assert.deepEqual(Object.keys(x).filter((k) => !["t", "v", "w", "sid", "aid", "role", "ag", "bl", "tools", "agentTool", "asked", "tag", "main", "mp", "pol", "act", "would", "ret", "why", "ph", "stk", "price", "ms", "flags"].includes(k)), []);
});

test("rotation at the size cap leaves at most two files per log", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  fs.writeFileSync(path.join(e.state, "decisions.jsonl"), "x".repeat(1024 * 1024 + 1) + "\n");
  for (let i = 0; i < 60; i++) await e.route(sub(HAIKU, { agent: `a${i}` }), CFG, {});
  assert.ok(fs.existsSync(path.join(e.state, "decisions.1.jsonl")));
  assert.ok(fs.statSync(path.join(e.state, "decisions.jsonl")).size < 1024 * 1024);
  assert.equal(e.files().filter((f) => /^decisions/.test(f)).length, 2);
});

test("status.json: written with the closed counters and the matrix; throttled by timestamp; flushed at once when a new warning appears", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  await e.route(sub(OPUS, { agent: "a1" }), CFG, {});                              // UNKNOWN_MAIN warning
  await e.drain();
  const s1 = JSON.parse(fs.readFileSync(path.join(e.state, "status.json"), "utf8"));
  for (const k of ["req", "main", "sub", "aux", "keep", "substitute", "inherit", "emptySet", "unknownMain", "unresolvable", "error", "stickyHit", "stickyNew", "freeBreak", "blNoAgentId"]) assert.equal(typeof s1.counters[k], "number", k);
  assert.ok(s1.warnings.some((w) => w.code === "UNKNOWN_MAIN"));
  const m0 = fs.statSync(path.join(e.state, "status.json")).mtimeMs;
  await e.route(sub(OPUS, { agent: "a2" }), CFG, {});
  assert.equal(fs.statSync(path.join(e.state, "status.json")).mtimeMs, m0, "no rewrite inside 5 s with no new warning");
  e.tick(6000);
  await e.route(sub(OPUS, { agent: "a3" }), CFG, {});
  await e.drain();
  assert.ok(fs.statSync(path.join(e.state, "status.json")).mtimeMs >= m0);
  assert.equal(s1.counters.error, 0);
});

// ---------------------------------------------------------------------------------------------- robustness
test("concurrency: 1,000 interleaved calls leave no torn main/agents file and counters sum to the call count", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  const jobs = [];
  for (let i = 0; i < 1000; i++) jobs.push(i % 3 === 0 ? e.route(main(SONNET, { sid: `c${i % 7}` }), CFG, {}) : e.route(sub(HAIKU, { agent: `a${i % 40}`, sid: `c${i % 7}` }), CFG, {}));
  const out = await Promise.all(jobs);
  assert.ok(out.every((x) => typeof x === "string"));
  const c = e.counters();
  assert.equal(c.req, 1000);
  assert.equal(c.main + c.sub + c.aux, 1000);
  await e.drain();
  for (const f of e.files()) {
    if (/^main-/.test(f)) JSON.parse(fs.readFileSync(path.join(e.state, f), "utf8"));
    if (/^agents-.*\.jsonl$/.test(f)) for (const l of fs.readFileSync(path.join(e.state, f), "utf8").split("\n").filter(Boolean)) JSON.parse(l);
  }
});

test("fuzz (R5, QB-2): 12,000 random inputs through the whole route in enforce and shadow, retry and handoff requests included: no throw, no hang (per-call watchdog), a string model is answered with a string, a non-string or empty model with undefined, and EVERY error path returns exactly the asked model", async () => {
  const stats = {};
  let seed = 99;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const DEEP = (() => { let a = []; for (let i = 0; i < 150000; i++) a = [a]; return a; })();
  const junk = [null, undefined, 5, "str", [], {}, [1, 2], [{ name: 5 }, null, "x"], { name: "Agent" }, true, () => 1, [{ function: null }], { toString: 1 }, DEEP, "", NaN, -1];
  const pick = () => junk[rnd(junk.length)];
  const models = [HAIKU, "groq/g1", "nowhere/x", "", " ", "x".repeat(5000), 5, { toString: 1 }, DEEP, null, undefined];
  const boom = () => { throw new RangeError("fuzz"); };
  const watchdog = (p) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hang: no answer within 5 s")), 5000);
    p.then((v) => { clearTimeout(t); resolve(v); }, (x) => { clearTimeout(t); reject(x); });
  });
  const msgs = (n) => Array.from({ length: n }, () => ({ role: "user", content: "x" }));
  let inputs = 0, errorsSeen = 0, rejections = 0, hostileReads = 0, firstRejection = null;
  const askedOf = (r) => { try { return r && r.body && r.body.model; } catch { return undefined; } };
  for (const enforcement of ["enforce", "shadow"]) {
    const e = env(HPOL([gr(1), gr(2), gr(3), gr(4)], { enforcement }), { slot: null });          // one router copy at a time: every copy shares globalThis.__uwSub
    for (let i = 0; i < 6000; i++) {
      e.tick(15000);                                                                              // errors are never 5 inside 60 s, so the tripwire never changes the run
      if (i % 20 === 0) await e.drain();                                                          // the seam clock jumps 15 s a call: let the async writes finish so none is cut loose as stuck
      const model = models[rnd(models.length)];
      const agent = [`fz${rnd(6)}`, "", "~odd", "a".repeat(200), "x@y-1", pick()][rnd(6)];
      const headers = { "x-claude-code-session-id": ["s1", "S1", "s2", pick()][rnd(4)] };
      if (agent !== "" || rnd(2)) headers["x-claude-code-agent-id"] = agent;
      if (rnd(3) === 0) headers["x-stainless-retry-count"] = pick();
      if (rnd(4) === 0) { headers["content-length"] = pick(); headers["anthropic-beta"] = pick(); }
      const body = { model, tools: rnd(8) === 0 ? pick() : [{ name: "Read" }, ...(rnd(5) === 0 ? [{ name: "Agent" }] : [])], system: pick(), messages: rnd(5) ? msgs(1 + rnd(2) * 2) : pick() };
      const r = { body: rnd(25) === 0 ? pick() : body, headers: rnd(30) === 0 ? pick() : headers, sessionId: rnd(2) ? "s1" : pick(), builtInClaudeCodeSubagent: rnd(2) ? true : pick(),
        builtInSubagentModel: rnd(4) === 0 ? pick() : undefined, tokenCount: pick() };
      if (rnd(60) === 0) Object.defineProperty(r, "builtInSubagentModel", { get: boom });          // an error raised AFTER the request-parse prefix
      if (rnd(80) === 0) Object.defineProperty(r, "headers", { get: boom });                      // and one inside the prefix
      // SEC-6: the READ of the model itself can throw (a getter on the request, on its body, or on the model): the promise must still resolve with the legacy answer, never reject
      const hostile = rnd(60);
      if (hostile === 0) { Object.defineProperty(r, "body", { get: boom }); hostileReads += 1; }
      else if (hostile === 1) { const b2 = { ...(r.body && typeof r.body === "object" ? r.body : body) }; Object.defineProperty(b2, "model", { get: boom }); r.body = b2; hostileReads += 1; }
      else if (hostile === 2) { r.body = new Proxy({}, { get: boom, has: boom, ownKeys: boom }); hostileReads += 1; }
      const cf = rnd(50) === 0 ? { get Providers() { return boom(); } } : [CFG5, CFG, pick() ?? CFG5][rnd(3)];
      const before = e.counters().error ?? 0;
      let out;
      try { out = await watchdog(e.route(r, cf, pick())); } catch (x) { rejections += 1; firstRejection ??= `input ${i} (${enforcement}): ${x && x.message}`; continue; }
      inputs += 1;
      const asked = askedOf(r);
      if (typeof asked !== "string" || !asked) assert.equal(out, undefined, `input ${i}: no usable model answers undefined`);
      else {
        assert.equal(typeof out, "string", `input ${i}`);
        if ((e.counters().error ?? 0) > before) { errorsSeen += 1; assert.equal(out, asked, `input ${i}: an error path returns EXACTLY the asked model`); }
      }
    }
    stats[enforcement] = { ...e.counters() };
  }
  assert.equal(rejections, 0, `ZERO promise rejections (SEC-6: the model read is guarded); first: ${firstRejection}`);
  assert.ok(hostileReads >= 100, `${hostileReads} inputs had a throwing getter on the request, its body or its model`);
  assert.equal(inputs, 12000);
  assert.ok(errorsSeen >= 50, `${errorsSeen} error paths were exercised`);
  assert.ok(stats.enforce.retry >= 20 && stats.enforce.handoff + stats.enforce.handoffNone + stats.enforce.handoffCap >= 10, `the retry and handoff path ran in enforce: ${JSON.stringify(stats.enforce)}`);
  assert.ok(stats.shadow.handoffWould >= 5, "and the would-handoff path ran in shadow");
  console.log(`  fuzz: ${inputs} inputs, ${errorsSeen} error paths; enforce retry ${stats.enforce.retry}, handoff ${stats.enforce.handoff}, none ${stats.enforce.handoffNone}, cap ${stats.enforce.handoffCap}; shadow would-handoff ${stats.shadow.handoffWould}`);
});

const EPERM = () => Object.assign(new Error("EPERM"), { code: "EPERM" });
test("Windows rename (ar-5): main-<sid>.json is written ASYNC; an EPERM rename is retried from the failure path (20, 60, 180 ms); the request returns at once and the file appears; a final failure is non-fatal", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  let fails = 2, renames = 0;
  e.route.__test.fs = { ...fs, rename: (a, b, cb) => { if (!/main-s\d/.test(String(b))) return fs.rename(a, b, cb); renames += 1; return fails-- > 0 ? cb(EPERM()) : fs.rename(a, b, cb); } };
  const t0 = process.hrtime.bigint();
  await learn(e, SONNET);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `the request returned in ${ms} ms: it does not wait for the write or its retries`);
  assert.equal(fs.existsSync(path.join(e.state, "main-s1.json")), false, "not yet: the write is asynchronous");
  await e.drain();
  assert.ok(fs.existsSync(path.join(e.state, "main-s1.json")), "the file eventually appears");
  assert.equal(renames, 3, "two EPERM failures, then the retry that worked");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(e.state, "main-s1.json"), "utf8")).model, SONNET);
  fails = 1000; renames = 0;
  e.route.__test.reset();
  assert.equal(await learn(e, HAIKU, "s2"), HAIKU, "a final failure is non-fatal");
  assert.equal(globalThis.__uwSub.main.get("s2").model, HAIKU, "memory still holds the value");
  await e.drain();
  assert.equal(renames, 4, "the first try and three retries, no more");
  assert.equal(fs.existsSync(path.join(e.state, "main-s2.json")), false);
  assert.equal(e.counters().asyncWriteFail, 1);
  assert.equal(fs.readdirSync(e.state).filter((f) => /\.tmp-/.test(f)).length, 0, "no temp file is left behind");
});

test("ar-5: a write callback that never fires cannot block the request path or freeze the file; the readers never sleep: a busy read is a miss, the next request reads it", async () => {
  const e = env(POL({ mode: "inherit", enforcement: "enforce" }), { slot: null });
  e.route.__test.fs = { ...fs, writeFile: () => { /* the callback never fires */ } };
  const t = [];
  for (const [m, sid] of [[SONNET, "s1"], [HAIKU, "s2"], [OPUS, "s1"]]) { const t0 = process.hrtime.bigint(); await learn(e, m, sid); t.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  assert.ok(t.every((x) => x < 50), `learn calls took ${t.map((x) => x.toFixed(1)).join(", ")} ms: none waits on the write`);
  assert.equal(globalThis.__uwSub.main.get("s1").model, OPUS, "memory is the authority");
  e.tick(11000);                                                                          // the stuck write is cut loose after 10 s
  e.route.__test.fs = fs;
  await learn(e, GROQ, "s1");
  await e.drain();
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.state, "main-s1.json"), "utf8")).model, GROQ, "a later change is written although an earlier callback never came back");
  // readers: an EBUSY on the first read is a miss (asked is served), the very next request reads the file
  fs.writeFileSync(path.join(e.state, "main-s3.json"), JSON.stringify({ model: SONNET, beta1m: false, t: new Date(Date.parse("2026-10-03T12:00:00.000Z")).toISOString() }));
  let busy = 1;
  e.route.__test.fs = { ...fs, readFileSync: (f, ...a) => { if (String(f).includes("main-s3") && busy-- > 0) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" }); return fs.readFileSync(f, ...a); } };
  const t1 = process.hrtime.bigint();
  assert.equal(await e.route(sub(HAIKU, { sid: "s3", agent: "r1" }), CFG, {}), HAIKU, "a busy main file is a miss: asked is served (fail-open), never a sleep and retry");
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 50);
  assert.equal(await e.route(sub(HAIKU, { sid: "s3", agent: "r2" }), CFG, {}), SONNET, "the next request reads it");
});

// Loose ceilings only (O4a): a loaded machine or a parallel test run must not fail the suite. The plan's STRICT numbers (warm < 1 ms, shadow < 1 ms, new agent < 3 ms, handoff < 3 ms,
// best of 3 batches at 1,800 rows over 60 providers) are asserted by the standalone script `node test/perf/subagent-router-perf.mjs`, which the verifier runs on a quiet machine.
const LOOSE_P99_MS = 10, LOOSE_HANDOFF_P50_MS = 3;

test("budget (loose ceiling): 10,000 warm synthetic calls through the clock seam; p99 is printed and asserted under 10 ms (the strict plan numbers are in test/perf/subagent-router-perf.mjs)", async () => {
  const times = (await measureWarmSmall()).sort((a, b) => a - b);
  const p = (q) => times[Math.floor(q * (times.length - 1))];
  console.log(`budget: warm p50 ${p(0.5).toFixed(3)} ms, p99 ${p(0.99).toFixed(3)} ms, max ${times.at(-1).toFixed(3)} ms over ${times.length} calls`);
  assert.ok(p(0.99) < LOOSE_P99_MS, `p99 ${p(0.99)} ms`);
});

test("integration: the router serves a policy compiled by the library from the fixtures (substitute from the real compiled lists)", async () => {
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const lib = await import("../keysync/subagent-policy.mjs");
  const dir = mkTmp("uw-int-");
  const p = lib.resolvePaths(fixtureFlagMap(dir));
  const g = await lib.gatherInputs(p);
  const { compiled } = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free", freeScope: "providers", enforcement: "enforce" });
  const e = env(compiled, { slot: null });
  const live = (await lib.readProviders(p)).map(({ name, models, enabled }) => ({ name, models, enabled }));
  const ret = await e.route(sub(HAIKU, { agent: "int1" }), { Providers: live }, {});
  assert.match(ret, /^fx-free-a\//, `a free-provider substitute, got ${ret}`);
  assert.ok(compiled.models.some((m) => m.s === ret));
  assert.equal(await e.route(sub("fx-free-a/fxa-alpha", { agent: "int2" }), { Providers: live }, {}), "fx-free-a/fxa-alpha", "asked in the free set is kept");
});

test("Q6 + banded spread (ar-4): the top-3 spread follows rank key 2b; BANDED (the default) keeps it inside the lead price class, banded:false is the old spread over three classes", async () => {
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const lib = await import("../keysync/subagent-policy.mjs");
  const dir = mkTmp("uw-q6-");
  const flags = fixtureFlagMap(dir);
  const rdj = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), wrj = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o));
  const snap = rdj("snapshot.json");
  const set = (provider, id, ctx) => { snap.rows.find((r) => r.provider === provider).models.find((m) => m.id === id).ctx = ctx; };
  set("fx-free-a", "fxa-alpha", 200000); set("fx-dep", "fxd-model:free", 400000); set("fx-paid", "fxp/free/x", 300000);   // the ft rows have the MORE context
  wrj("snapshot.json", snap);
  const bench = rdj("bench.json");
  bench.models["fx-free-a/fxa-alpha"].t = 5000; bench.models["fx-dep/fxd-model:free"].t = 100; bench.models["fx-paid/fxp/free/x"].t = 100;   // and the faster TTFT
  wrj("bench.json", bench);
  const p = lib.resolvePaths(flags);
  const g = await lib.gatherInputs(p);
  const live = (await lib.readProviders(p)).map(({ name, models, enabled }) => ({ name, models, enabled }));
  const spread = async (banded) => {
    const { compiled } = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free", freeScope: "providers+deposit", enforcement: "enforce", banded });
    assert.deepEqual(compiled.models.slice(0, 4).map((m) => m.s), ["fx-free-a/fxa-big:free", "fx-free-a/fxa-alpha", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x"]);
    assert.deepEqual(compiled.models.slice(0, 4).map((m) => m.b), [0, 0, 1, 1], "the two class 0 rows are band 0, the two class 0t rows band 1");
    const e = env(compiled, { slot: null });
    const rets = new Set();
    for (let i = 0; i < 90; i++) rets.add(await e.route(sub("nowhere/x", { agent: `q6-${i}` }), { Providers: live }, {}));
    assert.equal(e.counters().error, 0);
    return { rets: [...rets].sort(), flags: e.lines("agents.jsonl").flatMap((l) => l.flags) };
  };
  const old = await spread(false);
  assert.deepEqual(old.rets, ["fx-dep/fxd-model:free", "fx-free-a/fxa-alpha", "fx-free-a/fxa-big:free"],
    "banded:false: the 90 agents spread over exactly the top 3: the lone best tie group (big:free), the next class 0 row (alpha), then the first class 0t row; fxp is outside it");
  assert.ok(!old.flags.includes("FRAGILE_SET"));
  const banded = await spread(true);
  assert.deepEqual(banded.rets, ["fx-free-a/fxa-alpha", "fx-free-a/fxa-big:free"], "banded (default): only the two rows of the lead band, never the class 0t rows");
  assert.ok(banded.flags.includes("FRAGILE_SET"), "K' = 2 < K = 3 is flagged FRAGILE_SET");
});

test("M1 fail-open: a throw AFTER the asked model was read returns the asked model byte for byte (not the slot rewrite, not undefined), counts error once and warns ROUTER_ERROR with the name only", async () => {
  const boom = () => { throw new RangeError("secret-message-must-not-be-logged"); };
  const bad = [
    ["tools getter", () => ({ body: { model: OPUS, get tools() { return boom(); } }, headers: {} })],
    ["headers getter", () => ({ body: { model: OPUS, tools: [] }, get headers() { return boom(); } })],
  ];
  for (const [label, mk] of bad) {
    const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: { model: "groq/g1" } });
    assert.equal(await e.route({ body: { model: OPUS }, headers: {} }, CFG, {}), "groq/g1", `${label}: control, the same model is rewritten by the slot when the request is well formed`);
    assert.equal(e.counters().error ?? 0, 0, `${label}: control raised no error`);
    const ret = await e.route(mk(), CFG, {});
    assert.equal(ret, OPUS, `${label}: the asked model, exactly, is returned (the slot rewrite is not applied on the error path)`);
    assert.equal(e.counters().error, 1, `${label}: error counted once`);
    const st = e.status();
    assert.ok(st.warnings.some((w) => w.code === "ROUTER_ERROR" && w.detail === "RangeError"), `${label}: ROUTER_ERROR with the error NAME`);
    assert.ok(!JSON.stringify(st).includes("secret-message-must-not-be-logged"), `${label}: the message never reaches status`);
    assert.equal(await e.route({ body: { model: OPUS }, headers: {} }, CFG, {}), "groq/g1", `${label}: the router keeps working after the error`);
  }
});

test("M2 own(): a main provider named like an Object.prototype member (or a prototype-pollution key) with a policy that has no such provider is an EMPTY set under same-provider enforce, never a prototype value", async () => {
  const PROBE = "uwProtoProbe";
  const pollute = (k, v) => Object.defineProperty(Object.prototype, k, { value: v, configurable: true, writable: true, enumerable: false });
  for (const name of ["constructor", "__proto__", PROBE]) {
    const e = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce", inject: "on" }, { tiers: { anthropic: "subscription" }, inject: { all: "", byProvider: { anthropic: "ANTH" }, empty: "EMPTYTEXT", promptNote: "" } }), { slot: null });
    await e.route(main(`${name}/m1`, { sid: "s1" }), CFG, {});
    // the route function has no await: pollution set around the call is visible to every property read inside it and to nothing else
    if (name === PROBE) { pollute(PROBE, [0]); pollute(`${PROBE}/m1`, 1); }          // a raw read of byProvider[name] would find the array [0] (the Sonnet row)
    let ret;
    try { ret = e.route(sub("nowhere/x", { sid: "s1", agent: "ag1" }), CFG, {}); } finally { if (name === PROBE) { delete Object.prototype[PROBE]; delete Object.prototype[`${PROBE}/m1`]; } }
    assert.equal(await ret, "nowhere/x", `${name}: no list of its own, so the empty set and the asked model (the FREE PROMISE-style fallback of enforce), never a candidate from a prototype member`);
    assert.equal(e.counters().emptySet, 1, `${name}: counted as an empty set`);
    assert.equal(e.counters().error ?? 0, 0, `${name}: no router error`);
    const r = injBody(); r.body.model = `${name}/m1`;
    if (name === PROBE) pollute(PROBE, "POLLUTED-TEXT");                             // inject.byProvider[name] raw would find this string
    try { await e.route(r, CFG, {}); } finally { if (name === PROBE) delete Object.prototype[PROBE]; }
    assert.ok(r.body.tools[0].description.includes("EMPTYTEXT") && !r.body.tools[0].description.includes("POLLUTED-TEXT"), `${name}: the injected text is the compiled empty text`);
  }
  assert.equal(({})[PROBE], undefined, "the pollution is removed");
});

// ---------------------------------------------------------------------------------------------- source scans
const SRC = fs.readFileSync(NEXT, "utf8");
test("router source: no env read, a timer only inside a failure path or a test helper (unref'd), no top-level async, no require of JSON, only node:fs and node:path, no banned literals", () => {
  assert.ok(!/process\.env/.test(SRC));
  assert.ok(!/\b(setInterval|setImmediate)\b/.test(SRC));
  const timers = SRC.split("\n").filter((l) => /\bsetTimeout\b/.test(l) && !/^\s*\/\//.test(l));
  assert.equal(timers.length, 1, "exactly one setTimeout site: the write retry on the failure path (R18: no test drain poll in production bytes)");
  for (const l of timers) assert.match(l, /^\s{4,}/, `a timer is created inside a function body, never at module scope: ${l.trim().slice(0, 60)}`);
  assert.ok(/const tm = setTimeout\([\s\S]{0,200}\.unref/.test(SRC), "the retry timer's handle is unref'd (it must never keep a CCR worker alive); no other timer exists");
  assert.ok(!/tamper|drain/i.test(SRC.replace(/\/\/.*$/gm, "")), "R18: no tamper hook and no drain helper in production bytes");
  assert.ok(!/^await\b/m.test(SRC));
  assert.deepEqual([...SRC.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]).sort(), ["node:fs", "node:fs", "node:path"], "fs and path in the body, fs once more in the loader's one statSync of the file itself (S-F2)");
  assert.ok(!/require\([^)]*\.json/.test(SRC));
  for (const n of [/x-ccr-client/, /uw-probe/, /UW_CCR_DATA_DIR/, /usage\.sqlite/, /request-logs\.sqlite/]) assert.ok(!n.test(SRC), String(n));
  assert.ok(!/\bbest\b/i.test(SRC.replace(/\/\/.*$/gm, "")), "no string calls the order best");
});

test("loading the file with every fs function stubbed to throw: the loader makes exactly ONE fs call (a statSync of the file itself, S-F2), the body makes none, no timer starts, and the router still loads and serves", () => {
  // evaluate the source as CCR's loader does, but hand it an fs whose every function throws and records the call
  const calls = [];
  const trap = new Proxy({}, { get: (_, k) => (...a) => { calls.push([String(k), a[0]]); throw new Error(`module-scope fs access: ${String(k)}`); } });
  const fakeRequire = (id) => (id === "node:fs" ? trap : req$(id));
  const mod = { exports: {} };
  new Function("require", "module", "exports", "__dirname", "__filename", SRC)(fakeRequire, mod, mod.exports, path.dirname(NEXT), NEXT);
  assert.equal(typeof mod.exports, "function");
  assert.equal(typeof mod.exports.__test.reset, "function");
  assert.deepEqual(calls, [["statSync", NEXT]], "exactly one fs call at load: the stat of the file's own identity (it threw, so the body was evaluated fresh and not stored)");
  // and no timer is created at load time either
  const real = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval, setImmediate: globalThis.setImmediate }, hits = [];
  for (const k of Object.keys(real)) globalThis[k] = (...a) => { hits.push(k); return real[k](...a); };
  try { new Function("require", "module", "exports", "__dirname", "__filename", SRC)(fakeRequire, { exports: {} }, {}, path.dirname(NEXT), NEXT); } finally { Object.assign(globalThis, real); }
  assert.deepEqual(hits, [], "loading the file starts no timer");
});

// ---------------------------------------------------------------------------------------------- S-F2: evaluated once per process
const LEAK_SCRIPT = `
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createRequire } = require("node:module");
const [, , src, nStr] = process.argv, N = Number(nStr);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-leak-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));      // issue #157: this child left its folder behind
fs.mkdirSync(path.join(dir, "spike")); fs.mkdirSync(path.join(dir, "state", "subagent"), { recursive: true });
const file = path.join(dir, "spike", "uw-router.cjs");
fs.copyFileSync(src, file); fs.writeFileSync(path.join(dir, "spike", "slot.json"), JSON.stringify({ model: "x/y" }));
const parent = createRequire(path.join(dir, "ccr-parent.cjs"));
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const REQ = { body: { model: "claude-opus-5" }, headers: {} };
(async () => {
  const cycle = async (n) => { for (let i = 0; i < n; i++) { delete parent.cache[file]; const r = parent(file); await r(REQ, { Providers: [] }, {}); } };
  await cycle(100);
  const h0 = heap(); await cycle(N); const h1 = heap();
  process.stdout.write(String((h1 - h0) / 1024 / N));
})();`;
function kbPerRequire(routerFile, n = 2500) {
  const script = path.join(mkTmp("uw-leakrun-"), "leak.cjs");
  fs.writeFileSync(script, LEAK_SCRIPT);
  const r = spawnSync(process.execPath, ["--expose-gc", script, routerFile, String(n)], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return Number(r.stdout);
}
test("S-F2 REGRESSION: re-requiring the router the way CCR does (delete the cache entry, require again, on every request) leaks under 4 KB a require; the same body WITHOUT the once-per-process loader leaks over 8 KB (negative control: the test can fail)", () => {
  const withLoader = kbPerRequire(NEXT);
  const bare = SRC.replace(/\nmodule\.exports = \(function load\(\) \{[\s\S]*$/, "\nmodule.exports = __uwImpl('');\n");           // the same bytes, evaluated on EVERY load
  assert.notEqual(bare, SRC, "the control really removed the loader");
  const control = path.join(mkTmp("uw-leakctl-"), "uw-router.control.cjs");
  fs.writeFileSync(control, bare);
  const without = kbPerRequire(control);
  console.log(`  S-F2 leak: ${withLoader.toFixed(2)} KB a require with the loader, ${without.toFixed(2)} KB without (2,500 requires each)`);
  assert.ok(withLoader < 4, `${withLoader.toFixed(2)} KB a require`);
  assert.ok(withLoader < 0.5, `${withLoader.toFixed(3)} KB a require: with the parent-children splice (O4b) the Module records no longer pile up (measured 0.95 before it, about 0.08 after)`);
  assert.ok(without > 8, `the control leaks ${without.toFixed(2)} KB a require: the body is evaluated per request`);
});

test("S-F2: the loader evaluates the body once per process and re-exports it (same function, same state, same seam) while the file is unchanged; a CHANGED file (new mtime and size) loads the NEW code without a restart and replaces the old entry; two different files never share an implementation", () => {
  const dir = mkTmp("uw-once-");
  fs.mkdirSync(path.join(dir, "spike")); fs.mkdirSync(path.join(dir, "state", "subagent"), { recursive: true });
  const live = path.join(dir, "spike", "uw-router.cjs");
  fs.copyFileSync(NEXT, live); fs.writeFileSync(path.join(dir, "spike", "slot.json"), JSON.stringify(IDENT));
  const load = () => { delete req$.cache[live]; return req$(live); };
  const a = load(), b = load(), c = load();
  assert.equal(typeof a, "function");
  assert.ok(a === b && b === c, "one implementation per process: every load re-exports the same function");
  assert.ok(a.__test === c.__test, "and the same seam");
  assert.equal(Object.keys(globalThis.__uwRouterImpl).filter((k) => k === live).length, 1, "one registry entry for the file");
  // a different file path has its own implementation
  const other = path.join(dir, "spike", "uw-router-other.cjs"); fs.copyFileSync(NEXT, other);
  delete req$.cache[other]; assert.ok(req$(other) !== a, "two files never share one");
  // a changed file: a new router version that a policy (minRouter 7) can tell apart from the old one
  const newer = SRC.replace("const ROUTER_VERSION = 2;", "const ROUTER_VERSION = 9;");
  assert.notEqual(newer, SRC);
  const pol = mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: ROWS, minRouter: 7 });
  fs.writeFileSync(path.join(dir, "state", "subagent", "policy.json"), JSON.stringify(pol));
  a.__test.reset();
  const before = a({ body: { model: HAIKU, tools: [{ name: "Read" }] }, headers: { "x-claude-code-agent-id": "g1" } }, CFG, {});
  return before.then((r) => {
    assert.equal(r, HAIKU); assert.ok(globalThis.__uwSub.counters.policyBad >= 1, "version 2 refuses a policy that needs version 7");
    fs.writeFileSync(live, newer);
    const t = new Date(Date.now() + 5000); fs.utimesSync(live, t, t);                          // new size AND new mtime: a new identity
    const d = load();
    assert.ok(d !== a, "the changed file evaluated NEW code (a new function)");
    const reg = globalThis.__uwRouterImpl[live];
    assert.ok(reg.impl === d, "and replaced the older entry in the registry");
    const before2 = globalThis.__uwSub.counters.policyBad;
    return d({ body: { model: HAIKU, tools: [{ name: "Read" }] }, headers: { "x-claude-code-agent-id": "g2" } }, CFG, {}).then(() => {
      assert.equal(globalThis.__uwSub.counters.policyBad, before2, "version 9 accepts the minRouter 7 policy: the new code is the one running, no restart");
      assert.ok(load() === d, "and it is stable again until the file changes");
    });
  });
});

// ---------------------------------------------------------------------------------------------- second fix round: the loader (SEC-1, M3, O4b splice)
const loaderTree = () => {
  const dir = mkTmp("uw-ldr-");
  fs.mkdirSync(path.join(dir, "spike")); fs.mkdirSync(path.join(dir, "state", "subagent"), { recursive: true });
  const live = path.join(dir, "spike", "uw-router.cjs");
  fs.writeFileSync(path.join(dir, "spike", "slot.json"), JSON.stringify(IDENT));
  return { dir, live, status: (fn) => { fn.__test.reset(); fn.__test.flush(); return JSON.parse(fs.readFileSync(path.join(dir, "state", "subagent", "status.json"), "utf8")); } };
};
test("SEC-1 REGRESSION: a file REPLACED between require's read and the loader's stat (the old bytes were compiled, the new file's identity is stat'ed) is not pinned: the next load evaluates the new bytes (a same-size, same-inode swap included)", () => {
  const t = loaderTree(), live = t.live;
  const v1 = SRC, v2 = SRC.replace("const ROUTER_VERSION = 2;", "const ROUTER_VERSION = 9;");
  assert.equal(v1.length, v2.length, "the swap keeps the SIZE: only the compiled source's own identity can tell the two apart");
  fs.writeFileSync(live, v1);
  const when = new Date(Date.now() + 7000);
  // the race, simulated with a wrapper: on the loader's first stat of the file, the file is swapped for v2 (mtime set) and the REAL stat then reports v2's identity
  const real = fs.statSync; let swapped = 0;
  fs.statSync = function (p, ...a) { if (p === live && !swapped++) { fs.writeFileSync(live, v2); fs.utimesSync(live, when, when); } return real.call(this, p, ...a); };
  let a;
  try { delete req$.cache[live]; a = req$(live); } finally { fs.statSync = real; }
  assert.equal(swapped, 1, "the swap happened inside the load");
  assert.equal(t.status(a).routerVersion, 2, "this load compiled the OLD bytes (the race itself)");
  delete req$.cache[live];
  const b = req$(live);
  assert.ok(b !== a, "the next load did not return the pinned old code");
  assert.equal(t.status(b).routerVersion, 9, "it evaluated the NEW bytes");
  delete req$.cache[live];
  assert.ok(req$(live) === b, "and is stable again afterwards");
});

test("SEC-1 (the case it must not break): an UNCHANGED file keeps one implementation across loads and a swap that changes only the middle of a long source is still told apart by its length or ends", () => {
  const t = loaderTree(), live = t.live;
  fs.writeFileSync(live, SRC);
  delete req$.cache[live]; const a = req$(live);
  for (let i = 0; i < 5; i++) { delete req$.cache[live]; assert.ok(req$(live) === a, "unchanged bytes: the same implementation"); }
  fs.writeFileSync(live, SRC + "\n// trailing comment that changes the length\n");
  const when = new Date(Date.now() + 9000); fs.utimesSync(live, when, when);
  delete req$.cache[live]; assert.ok(req$(live) !== a, "a changed file loads new code");
});

test("M3 (surviving mutant): a stat that FAILS evaluates the body fresh on every load and stores NOTHING in the registry (globalThis.__uwRouterImpl has no entry for the file)", () => {
  const t = loaderTree(), live = t.live;
  fs.writeFileSync(live, SRC);
  const real = fs.statSync;
  fs.statSync = function (p, ...a) { if (p === live) throw Object.assign(new Error("EIO"), { code: "EIO" }); return real.call(this, p, ...a); };
  let a, b;
  try { delete req$.cache[live]; a = req$(live); delete req$.cache[live]; b = req$(live); } finally { fs.statSync = real; }
  assert.equal(typeof a, "function"); assert.equal(typeof b, "function");
  assert.ok(a !== b, "identity unknown: each load is evaluated fresh");
  assert.ok(!globalThis.__uwRouterImpl || !(live in globalThis.__uwRouterImpl), "and nothing is stored under the unknown identity");
  delete req$.cache[live]; const c = req$(live);
  assert.ok(globalThis.__uwRouterImpl[live], "with a working stat the same file IS stored again");
  assert.ok(c !== a);
});

test("O4b: the loader removes its own Module from the parent's `children` on every load (the list does not grow with re-requires, the Module is no longer listed), and a missing, null, throwing or non-array parent is harmless", () => {
  const t = loaderTree(), live = t.live;
  fs.copyFileSync(NEXT, live);
  delete req$.cache[live]; const fn = req$(live);
  const mod = req$.cache[live], parent = mod.parent;
  assert.ok(parent && Array.isArray(parent.children), "the test parent is a real Module with a children list");
  const n0 = parent.children.length;
  for (let i = 0; i < 50; i++) { delete req$.cache[live]; req$(live); }
  assert.equal(parent.children.length, n0, "50 re-requires leave the children list the same length");
  assert.ok(!parent.children.includes(req$.cache[live]), "the Module of the latest load is not listed either");
  assert.ok(req$.cache[live].exports === fn, "the module itself still works and is still in require.cache (CCR deletes that entry itself)");
  // the case it must not break: an unrelated entry in the same list stays
  const other = { id: "other" }; parent.children.push(other);
  delete req$.cache[live]; req$(live);
  assert.ok(parent.children.includes(other), "a neighbour in the children list is untouched");
  parent.children.splice(parent.children.indexOf(other), 1);
  // harmless parents, evaluated as CCR's loader would with a module object of each shape
  const run = (module) => { const m = Object.defineProperties({ exports: {} }, Object.getOwnPropertyDescriptors(module)); new Function("require", "module", "exports", "__dirname", "__filename", SRC)(req$, m, m.exports, path.dirname(NEXT), NEXT); assert.equal(typeof m.exports, "function"); };
  run({});                                                                                    // no parent property at all
  run({ parent: null }); run({ parent: undefined }); run({ parent: {} });                     // no children list
  run({ parent: { children: "not an array" } }); run({ parent: { children: null } });
  run({ parent: { get children() { throw new Error("hostile getter"); } } });                 // a throwing getter
  run({ get parent() { throw new Error("hostile parent"); } });
  run({ parent: { children: Object.freeze([]) } });                                           // a frozen list: the splice finds nothing, nothing throws
  run({ parent: { children: new Proxy([], { get() { throw new Error("proxy"); } }) } });
});

// ---------------------------------------------------------------------------------------------- second fix round: state version and shape (SEC-2, M5)
test("SEC-2 REGRESSION (the PoC): a hot redeploy whose state object has a DIFFERENT SHAPE but the same STATE_VERSION resets the state instead of running on the old object (the old behaviour: 6 errors, an auto-rollback, shadow.flag auto:ERRORS)", async () => {
  const e = env(ENFORCE(), { slot: null });
  const olderCode = patchedRouter([["cool: new Map(), coolSid: new Map(), learned: new Map(),", "cool: new Map(),"]]);   // an older build: its state has no `coolSid` and no `learned`
  const o = env(null, { slot: null, file: olderCode });
  await o.route({ body: { model: HAIKU } }, CFG, {});                                           // the older code creates ITS state object
  assert.equal(globalThis.__uwSub.v, 3); assert.equal(globalThis.__uwSub.learned, undefined, "the live state has the OLD shape and the SAME version");
  await learn(e, SONNET);                                                                       // the NEW code runs on it: a main request teaches main through `learned`
  for (let i = 0; i < 6; i++) { e.tick(1000); const r = await e.route(sub("nowhere/x", { agent: `sh${i}` }), CFG, {}); assert.notEqual(r, "nowhere/x", "enforced"); }
  assert.equal(e.counters().error ?? 0, 0, "no router error on the skewed state");
  assert.equal(flagOf(e), null, "no auto-rollback flag");
  assert.ok(!e.status().warnings.some((w) => w.code === "ROUTER_ERROR" || w.code === "AUTO_ROLLBACK"));
  assert.ok(globalThis.__uwSub.learned instanceof Map && globalThis.__uwSub.coolSid instanceof Map, "the state was rebuilt with the new shape");
  assert.match(globalThis.__uwSub.shape, /,learned,/);
  // the case it must not break: the SAME shape and version is NOT reset: counters and sticky entries survive further requests
  const before = globalThis.__uwSub, n = before.counters.req, key = [...before.agent.keys()][0];
  await e.route(sub("nowhere/x", { agent: "sh0" }), CFG, {});
  assert.ok(globalThis.__uwSub === before, "the same object");
  assert.equal(globalThis.__uwSub.counters.req, n + 1); assert.ok(globalThis.__uwSub.agent.has(key));
});

test("M5 (surviving mutant): a state object of another STATE_VERSION is replaced by a clean one and every descriptor the old one held open is CLOSED", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  await e.route(sub("nowhere/x", { agent: "v1" }), CFG, {});
  const old = globalThis.__uwSub, fd = old.fds.d && old.fds.d.fd;
  assert.ok(typeof fd === "number", "a log descriptor is open");
  const closed = [];
  e.route.__test.fs = { ...fs, closeSync: (x) => { closed.push(x); return fs.closeSync(x); } };
  old.v = 1;                                                                                    // a state written by an older router
  await e.route(sub("nowhere/x", { agent: "v2" }), CFG, {});
  assert.ok(closed.includes(fd), "the old state's open log descriptor was closed");
  assert.ok(globalThis.__uwSub !== old, "a new state object");
  assert.equal(globalThis.__uwSub.v, 3); assert.equal(globalThis.__uwSub.counters.req, 1, "clean counters: only the request that triggered the reset");
  assert.equal(globalThis.__uwSub.counters.stickyNew, 1, "and clean sticky counters (the journal, not the memory, brings the earlier agent back)");
  assert.equal(globalThis.__uwSub.counters.stickyHit, 0);
});

// ---------------------------------------------------------------------------------------------- second fix round: journal descriptors, gc, session index, slot (SEC-4, SEC-5, RV-1, RV-3, R-5, M15, M18, M26)
const jrnl = (e, sid = "s1") => path.join(e.state, `agents-${sid}.jsonl`);
const jlines = (e, sid = "s1") => fs.readFileSync(jrnl(e, sid), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
/** Records every open and close of a session journal and lets a test fail chosen journal writes (the logs write through the same function: only a line that starts with {"k": is a journal line). */
function spyFs(e, { failWrite } = {}) {
  const log = { opens: [], closes: [], writes: 0, unlinks: [] };
  e.route.__test.fs = { ...fs,
    openSync: (f, ...a) => { const fd = fs.openSync(f, ...a); if (/agents-[^\\/]+\.jsonl$/.test(String(f))) log.opens.push(fd); return fd; },
    closeSync: (fd) => { log.closes.push(fd); return fs.closeSync(fd); },
    unlinkSync: (f) => { log.unlinks.push(String(f)); return fs.unlinkSync(f); },
    writeSync: (fd, ...a) => { const j = typeof a[0] === "string" && /^\n?\{"k":/.test(a[0]); if (j) { log.writes += 1; const err = failWrite && failWrite(log.writes); if (err) throw Object.assign(new Error(err), { code: err }); } return fs.writeSync(fd, ...a); } };
  return log;
}

test("SEC-5 REGRESSION: the JOURNAL descriptor is opened ONCE per session and reused for every append (the old code opened, wrote and closed the file for each one: appendFileSync stalled a request up to 162 ms); the lines are all there; reset() closes it", async () => {
  const e = env(ENFORCE(), { slot: null });
  const log = spyFs(e);
  await learn(e, SONNET);
  for (let i = 0; i < 6; i++) await e.route(subReq(`fd${i}`), CFG, {});
  assert.equal(log.opens.length, 1, "one open for six appends");
  assert.equal(jlines(e).length, 6); assert.equal(log.writes, 6);
  const j = globalThis.__uwSub.jrn.get("s1");
  assert.equal(typeof j.fd, "number"); assert.equal(j.fd, log.opens[0]);
  assert.deepEqual(log.closes, [], "and it stays open between requests");
  e.route.__test.reset();
  assert.ok(log.closes.includes(log.opens[0]), "reset closes the journal descriptor (and the log descriptors)");
});

test("SEC-5: a journal write that fails with EBADF or EPERM reopens the file ONCE and writes again (no journalFail, one line, no duplicate); any other failure, or a second one, is journalFail, closes the descriptor, and the next append starts with a newline on a fresh descriptor; the request never throws", async () => {
  for (const code of ["EBADF", "EPERM"]) {
    const e = env(ENFORCE(), { slot: null });
    const log = spyFs(e, { failWrite: (n) => (n === 2 ? code : null) });                      // the second journal write fails once
    await learn(e, SONNET);
    await e.route(subReq("r1"), CFG, {}); const r2 = await e.route(subReq("r2"), CFG, {}); await e.route(subReq("r3"), CFG, {});
    assert.equal(e.counters().journalFail ?? 0, 0, `${code}: recovered, not a failure`);
    assert.equal(log.opens.length, 2, `${code}: reopened exactly once`);
    assert.deepEqual(jlines(e).map((l) => l.k), ["r1", "r2", "r3"], `${code}: every entry is in the journal once`);
    assert.equal(jlines(e)[1].m, r2);
  }
  // a persistent failure: both attempts fail
  const p = env(ENFORCE(), { slot: null });
  const log = spyFs(p, { failWrite: (n) => (n === 2 || n === 3 ? "EPERM" : null) });
  await learn(p, SONNET);
  await p.route(subReq("p1"), CFG, {});
  assert.notEqual(await p.route(subReq("p2"), CFG, {}), "nowhere/x", "still routed");
  assert.equal(p.counters().journalFail, 1); assert.equal(globalThis.__uwSub.jrn.get("s1").fd, null, "the descriptor was closed");
  assert.ok(globalThis.__uwSub.agent.has("s1:p2"), "memory keeps the entry");
  await p.route(subReq("p3"), CFG, {});
  assert.deepEqual(jlines(p).map((l) => l.k), ["p1", "p3"], "p2's append failed, p3 is on a fresh descriptor");
  assert.equal(fs.readFileSync(jrnl(p), "utf8").split("\n").filter((l) => l === "").length >= 2, true, "and starts with a newline again (a torn tail cannot swallow it)");
  // EIO (neither EBADF nor EPERM) is not retried at all
  const q = env(ENFORCE(), { slot: null });
  spyFs(q, { failWrite: (n) => (n === 1 ? "EIO" : null) });
  await learn(q, SONNET); await q.route(subReq("q1"), CFG, {});
  assert.equal(q.counters().journalFail, 1);
});

test("SEC-5: at most 32 journal descriptors stay open (the least recently used is closed to make room) and every session's lines are still written", async () => {
  const e = env(ENFORCE(), { slot: null });
  const log = spyFs(e);
  for (let i = 0; i < 40; i++) { await learn(e, SONNET, `lr${i}`); await e.route(sub("nowhere/x", { agent: "a", sid: `lr${i}` }), CFG, {}); }
  const open = [...globalThis.__uwSub.jrn.values()].filter((j) => j.fd !== null).length;
  assert.ok(open <= 32 && open >= 30, `${open} journal descriptors open`);
  for (let i = 0; i < 40; i++) assert.equal(jlines(e, `lr${i}`).length, 1, `session lr${i}`);
  assert.ok(log.closes.length >= 8, "the oldest were closed");
  await e.route(sub("nowhere/x", { agent: "b", sid: "lr0" }), CFG, {});                         // a closed one reopens by itself
  assert.equal(jlines(e, "lr0").length, 2);
});

test("SEC-5: a journal COMPACTION (hourly gc) closes the session's descriptor before it replaces the file and the next append lands in the NEW file on a fresh descriptor; a gc unlink closes it first too", async () => {
  const e = env(ENFORCE(), { slot: null });
  let big = ""; for (let i = 0; i < 1500; i++) big += JSON.stringify({ k: `k${i % 3}`, m: "groq/g1", t: T0 - 1000 + i, h: "x" }) + "\n";
  fs.writeFileSync(jrnl(e, "ja"), big);
  const log = spyFs(e);
  await learn(e, SONNET, "ja");
  await e.route(sub("nowhere/x", { agent: "first", sid: "ja" }), CFG, {});
  const fd0 = globalThis.__uwSub.jrn.get("ja").fd;
  assert.equal(typeof fd0, "number");
  for (let i = 0; i < 70; i++) { e.tick(10); await e.route(subReq(`gc${i}`), CFG, {}); }          // the 50th call starts the pass; it spans a few requests
  assert.ok(Buffer.byteLength(fs.readFileSync(jrnl(e, "ja"), "utf8")) < 64 * 1024, "compacted");
  assert.ok(log.closes.includes(fd0), "the descriptor on the old file was closed before the rename");
  assert.equal(globalThis.__uwSub.jrn.get("ja").fd, null);
  await e.route(sub("nowhere/x", { agent: "after", sid: "ja" }), CFG, {});
  assert.equal(jlines(e, "ja").at(-1).k, "after", "the next append is in the compacted file");
  // a gc unlink of a stale journal closes its descriptor
  const u = env(ENFORCE(), { slot: null });
  const ulog = spyFs(u);
  await learn(u, SONNET, "old1"); await u.route(sub("nowhere/x", { agent: "x", sid: "old1" }), CFG, {});
  const fdu = globalThis.__uwSub.jrn.get("old1").fd;
  const stale = new Date(T0 - 3 * 24 * 3600000); fs.utimesSync(jrnl(u, "old1"), stale, stale);
  for (let i = 0; i < 70; i++) { u.tick(10); await u.route(subReq(`g${i}`), CFG, {}); }
  assert.ok(!fs.existsSync(jrnl(u, "old1")), "the stale journal was removed");
  const at = ulog.unlinks.findIndex((f) => f.endsWith("agents-old1.jsonl"));
  assert.ok(at >= 0 && ulog.closes.includes(fdu), "its descriptor was closed");
});

test("SEC-5: a journal descriptor idle for 60 s is released on the next prune (every 50th request), so another worker's compaction (a rename over the file fails with EPERM on Windows while ANY process holds it open) is not blocked for ever; an active session keeps its descriptor", async () => {
  const e = env(ENFORCE(), { slot: null });
  const log = spyFs(e);
  await learn(e, SONNET, "idle"); await learn(e, SONNET, "busy");
  await e.route(sub("nowhere/x", { agent: "a", sid: "idle" }), CFG, {}); await e.route(sub("nowhere/x", { agent: "a", sid: "busy" }), CFG, {});
  const fdIdle = globalThis.__uwSub.jrn.get("idle").fd, fdBusy = globalThis.__uwSub.jrn.get("busy").fd;
  assert.ok(typeof fdIdle === "number" && typeof fdBusy === "number");
  for (let i = 0; i < 60; i++) { e.tick(2000); await e.route(sub("nowhere/x", { agent: `b${i}`, sid: "busy" }), CFG, {}); }          // 2 minutes of traffic on "busy" only, past a prune
  assert.equal(globalThis.__uwSub.jrn.get("idle").fd, null, "the idle session's descriptor was released");
  assert.ok(log.closes.includes(fdIdle));
  assert.equal(typeof globalThis.__uwSub.jrn.get("busy").fd, "number", "the active session keeps its descriptor");
  await e.route(sub("nowhere/x", { agent: "again", sid: "idle" }), CFG, {});
  assert.equal(jlines(e, "idle").at(-1).k, "again", "and the idle one reopens by itself on its next append");
});

test("SEC-5 REGRESSION: the hourly gc pass is SPREAD over requests: at most 8 directory entries (so at most 8 unlinks) per request, it resumes on the next request and still removes every stale file", async () => {
  const e = env(ENFORCE(), { slot: null });
  const stale = new Date(T0 - 3 * 24 * 3600000);
  for (let i = 0; i < 100; i++) { const f = path.join(e.state, `main-old${i}.json`); fs.writeFileSync(f, "{}"); fs.utimesSync(f, stale, stale); }
  const log = spyFs(e), per = [];
  for (let i = 0; i < 150; i++) { e.tick(10); const before = log.unlinks.length; await e.route(subReq(`sp${i}`), CFG, {}); per.push(log.unlinks.length - before); }
  assert.ok(Math.max(...per) <= 8, `at most ${Math.max(...per)} unlinks in one request`);
  assert.ok(per.filter((n) => n > 0).length >= 12, `spread over ${per.filter((n) => n > 0).length} requests`);
  assert.equal(fs.readdirSync(e.state).filter((f) => /^main-old/.test(f)).length, 0, "every stale file is gone");
  assert.equal(globalThis.__uwSub.gcJob, null, "the pass finished");
  // the case it must not break: a fresh file is kept
  const e2 = env(ENFORCE(), { slot: null });
  fs.writeFileSync(path.join(e2.state, "main-new1.json"), "{}"); fs.utimesSync(path.join(e2.state, "main-new1.json"), new Date(T0 - 1000), new Date(T0 - 1000));
  for (let i = 0; i < 80; i++) await e2.route(subReq(`k${i}`), CFG, {});
  assert.ok(fs.existsSync(path.join(e2.state, "main-new1.json")));
});

test("SEC-4 REGRESSION: a gc pass that rebuilds the session-file index while a main-<sid>.json write is IN FLIGHT keeps that file in the index (the old pass dropped it, and the write's own check then DELETED the file it had just written); a stale file is still removed in the same pass", async () => {
  const e = env(ENFORCE(), { slot: null });
  const old = path.join(e.state, "main-stale.json"); fs.writeFileSync(old, "{}");
  const t = new Date(T0 - 3 * 24 * 3600000); fs.utimesSync(old, t, t);
  await learn(e, SONNET, "inflight");                                                           // the write is started but cannot finish: no event-loop turn yet
  assert.ok([...globalThis.__uwSub.wr.keys()].some((f) => f.endsWith("main-inflight.json")), "the write is in flight");
  for (let i = 0; i < 70; i++) { e.tick(10); await e.route(subReq(`g${i}`, { sid: "other" }), CFG, {}); }
  assert.equal(globalThis.__uwSub.gcJob, null, "the pass finished before the write did");
  assert.ok(globalThis.__uwSub.files.has("main-inflight.json"), "the in-flight file is in the rebuilt index");
  assert.ok(!globalThis.__uwSub.files.has("main-stale.json") && !fs.existsSync(old), "a stale file is still removed");
  await e.drain();
  assert.ok(fs.existsSync(path.join(e.state, "main-inflight.json")), "and the write landed: it was not deleted by its own keep() check");
  // a LISTED file (so the "created after the listing" merge cannot save it) that the pass unlinks as stale while a new write for the same name is in flight: the in-flight merge keeps its index entry
  const r = env(ENFORCE(), { slot: null });
  const revive = path.join(r.state, "main-revive.json"); fs.writeFileSync(revive, JSON.stringify({ model: HAIKU, beta1m: false, t: new Date(T0 - 3 * 24 * 3600000).toISOString() }));
  fs.utimesSync(revive, t, t);
  await learn(r, SONNET, "revive");                                                             // the index is built here, with the stale file in it; the new write is in flight
  for (let i = 0; i < 70; i++) { r.tick(10); await r.route(subReq(`g${i}`, { sid: "other" }), CFG, {}); }
  assert.equal(globalThis.__uwSub.gcJob, null);
  assert.ok(globalThis.__uwSub.files.has("main-revive.json"), "the pass unlinked the stale file but the in-flight write keeps its name in the index");
  await r.drain();
  assert.equal(JSON.parse(fs.readFileSync(revive, "utf8")).model, SONNET, "the in-flight write landed and was not deleted by its own keep() check");
});

test("SEC-4 REGRESSION: a main-<sid>.json write DROPPED at the 64-file in-flight cap is retried on the next main request (the old code recorded it as written and waited 60 s); a write that started is still not repeated inside 60 s", async () => {
  const e = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 64; i++) await learn(e, SONNET, `fill${i}`);                              // 64 writes in flight
  await learn(e, SONNET, "late1");                                                              // the 65th: dropped
  assert.ok(e.counters().asyncWriteFail >= 1);
  assert.equal(globalThis.__uwSub.mainWrite.has("late1"), false, "a dropped write is not recorded as written");
  await e.drain();
  e.tick(1000); await learn(e, SONNET, "late1");                                                // the next main request of that session (same model)
  await e.drain();
  assert.ok(fs.existsSync(path.join(e.state, "main-late1.json")), "retried at once and written");
  const mt = fs.statSync(path.join(e.state, "main-late1.json")).mtimeMs;
  e.tick(1000); await learn(e, SONNET, "late1"); await e.drain();
  assert.equal(fs.statSync(path.join(e.state, "main-late1.json")).mtimeMs, mt, "a write that started is NOT repeated inside 60 s (the case it must not break)");
});

test("RV-1 REGRESSION (in-process): a session whose main-<sid>.json another worker created AFTER this worker built its file index is KNOWN here: the decision and the handoff are journalled (the old code kept them in memory only); a session with no file at all still owns none (S-F6), and a miss is not re-stat'ed inside 5 s", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET, "s1");                                                                 // builds the index
  fs.writeFileSync(path.join(e.state, "main-s2.json"), JSON.stringify({ model: SONNET, beta1m: false, t: new Date(T0).toISOString() }));   // another worker: a main request of s2
  await e.route(sub("nowhere/x", { agent: "g1", sid: "s2" }), CFG, {});
  assert.deepEqual(jlines(e, "s2").map((l) => l.k), ["g1"], "journalled although this worker never saw s2's main request");
  // S-F6: a session with no file anywhere
  await e.route(sub("nowhere/x", { agent: "g1", sid: "s9" }), CFG, {});
  assert.ok(!fs.existsSync(jrnl(e, "s9")));
  // the miss is remembered for 5 s: a main file appearing 1 s later is seen after the 5 s
  const stats = []; const real = fs.statSync;
  e.route.__test.fs = { ...fs, statSync: (f, ...a) => { if (/main-s7\.json$/.test(String(f))) stats.push(String(f)); return real(f, ...a); } };
  e.tick(1000); await e.route(sub("nowhere/x", { agent: "q1", sid: "s7" }), CFG, {}); await e.route(sub("nowhere/x", { agent: "q2", sid: "s7" }), CFG, {});
  const n1 = stats.length;
  fs.writeFileSync(path.join(e.state, "main-s7.json"), JSON.stringify({ model: SONNET, beta1m: false, t: new Date(T0).toISOString() }));
  e.tick(1000); await e.route(sub("nowhere/x", { agent: "q3", sid: "s7" }), CFG, {});
  assert.ok(!fs.existsSync(jrnl(e, "s7")), "inside 5 s the earlier miss still holds");
  e.tick(5000); await e.route(sub("nowhere/x", { agent: "q4", sid: "s7" }), CFG, {});
  assert.deepEqual(jlines(e, "s7").map((l) => l.k), ["q4"], "after 5 s the file is found and journalled");
  assert.ok(n1 <= 6, `${n1} stats of s7's main file for the first two requests (bounded)`);
});

test("RV-3 REGRESSION: when a journal is rewritten or truncated (smaller than the offset read so far) the per-process LINE counter starts again: the old counter stayed at its cap and the router stopped refreshing that session for good", async () => {
  const e = env(ENFORCE(), { slot: null });
  const line = (i) => JSON.stringify({ k: `ag${String(i).padStart(5, "0")}`, m: "groq/g1", t: T0 - 100000 + i, h: "x" }) + "\n";
  let big = ""; for (let i = 0; i < 8400; i++) big += line(i);
  fs.writeFileSync(jrnl(e), big);
  for (let i = 0; i < 5; i++) await e.route(subReq(`miss${i}`), CFG, {});                         // misses read the file chunk by chunk until the 8,192-line cap
  const j = () => globalThis.__uwSub.jrn.get("s1");
  assert.ok(j().lines > 8192, `${j().lines} lines counted`);
  // another worker compacts the journal: a small file with ONE new entry for a model no fresh decision can choose (groq/g4 is below the 128k floor)
  fs.writeFileSync(jrnl(e), JSON.stringify({ k: "after", m: "groq/g4", t: T0 - 500, h: "x" }) + "\n");
  assert.ok(fs.statSync(jrnl(e)).size < j().off);
  assert.equal(await e.route(subReq("after"), CFG, {}), "groq/g4", "the rewritten journal is read again");
  assert.ok(j().lines <= 2, `the counter restarted: ${j().lines}`);
  assert.equal(e.counters().stickyHit, 1);
});

test("M18 (surviving mutant): a process loads at most 8,192 lines of one session's journal (memory stays the authority beyond that): the line 8,192 is loaded, the line 8,193 and later are not", async () => {
  const e = env(ENFORCE(), { slot: null });
  let big = ""; for (let i = 0; i < 9000; i++) big += JSON.stringify({ k: `ag${String(i).padStart(5, "0")}`, m: "groq/g1", t: T0 - 100000 + i, h: "x" }) + "\n";
  assert.ok(Buffer.byteLength(big) > 400 * 1024, "more than one 256 KiB read");
  fs.writeFileSync(jrnl(e), big);
  for (let i = 0; i < 6; i++) await e.route(subReq(`miss${i}`), CFG, {});
  const has = (i) => globalThis.__uwSub.agent.has(`s1:ag${String(i).padStart(5, "0")}`);
  assert.ok(has(8191), "line 8,192 (index 8191) is loaded (the last 128 of the loaded lines survive the per-session cap)");
  assert.ok(!has(8192) && !has(8500) && !has(8999), "nothing after the cap is loaded");
  assert.ok(globalThis.__uwSub.jrn.get("s1").lines <= 8193);
});

test("M26 (surviving mutant): a journal line longer than a whole 256 KiB read is SKIPPED, not waited for (the offset moves past the chunk and stickyJournalTorn counts it), and the entries after it still load", async () => {
  const e = env(ENFORCE(), { slot: null });
  const huge = JSON.stringify({ k: "huge", m: "groq/g1", t: T0 - 5000, h: "x", pad: "y".repeat(300 * 1024) }) + "\n";
  fs.writeFileSync(jrnl(e), huge + JSON.stringify({ k: "good", m: "groq/g4", t: T0 - 4000, h: "x" }) + "\n");
  await e.route(subReq("probe1"), CFG, {});
  const j = globalThis.__uwSub.jrn.get("s1");
  assert.equal(j.off, 256 * 1024, "the first read consumed exactly one chunk, with no newline in it");
  assert.equal(e.counters().stickyJournalTorn, 1, "counted once");
  assert.equal(globalThis.__uwSub.agent.has("s1:good"), false, "not read yet");
  assert.equal(await e.route(subReq("good"), CFG, {}), "groq/g4", "the next miss reads the rest: the entry after the oversized line loads");
  assert.ok(!globalThis.__uwSub.agent.has("s1:huge"));
});

test("M15 (surviving mutant): under inherit a sticky entry is served WITHOUT a set check (inherit has no set): the entry's model need not be in any compiled list", async () => {
  const e = env(mkPolicy({ owner: { mode: "inherit", source: "all-providers", enforcement: "enforce" }, rows: ROWS, all: [], byProvider: {} }), { slot: null });
  await learn(e, SONNET);
  assert.equal(await e.route(sub(HAIKU, { agent: "i1" }), CFG, {}), SONNET, "inherit: main's model");
  assert.equal(e.counters().stickyNew, 1);
  assert.equal(await e.route(sub(HAIKU, { agent: "i1" }), CFG, {}), SONNET);
  assert.equal(e.counters().stickyHit, 1, "the second request is a sticky hit although `lists` is empty");
  assert.equal(e.counters().stickyOut, 0);
  // the case it must not break: under dynamic a model that is not in the compiled set falls out
  const d = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: ROWS }), { slot: null });
  await learn(d, SONNET); fs.writeFileSync(jrnl(d), JSON.stringify({ k: "i1", m: "cohere/c1", t: T0 - 1000, h: "x" }) + "\n");
  d.setPolicy(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1", { c: 200000 })], hash: "h0000000007" }));
  assert.equal(await d.route(sub(HAIKU, { agent: "i1" }), CFG, {}), "groq/g1");
  assert.equal(d.counters().stickyOut, 1);
});

test("R-5 REGRESSION: with a slot.json present in enforce, a decision that KEEPS an asked anthropic/claude-opus-5 stores the PRE-rewrite model (the one in the set) and applies the slot rewrite on the way out: 20 requests of one agent are 1 new decision, 19 sticky hits and 1 journal line (the old code stored the rewritten model, which is outside the set: stickyHit 0, stickyOut 19, 20 journal lines)", async () => {
  const e = env(ENFORCE(), { slot: { model: "slot/elsewhere" } });
  await learn(e, SONNET);
  const outs = new Set();
  for (let i = 0; i < 20; i++) { e.tick(1000); outs.add(await e.route(sub(OPUS, { agent: "ro" }), CFG, {})); }
  assert.deepEqual([...outs], ["slot/elsewhere"], "the wire answer is the slot's model every time (the legacy rewrite)");
  assert.deepEqual([e.counters().stickyNew, e.counters().stickyHit, e.counters().stickyOut], [1, 19, 0]);
  assert.equal(jlines(e).length, 1, "one journal line");
  assert.equal(globalThis.__uwSub.agent.get("s1:ro").model, OPUS, "the entry holds the model of the DECISION");
  // the case it must not break: without a slot the same flow is unchanged, and another model is never rewritten
  const n = env(ENFORCE(), { slot: null });
  await learn(n, SONNET);
  for (let i = 0; i < 3; i++) assert.equal(await n.route(sub(OPUS, { agent: "ro" }), CFG, {}), OPUS);
  assert.equal(n.counters().stickyHit, 2);
  const o = env(ENFORCE(), { slot: { model: "slot/elsewhere" } });
  await learn(o, SONNET);
  for (let i = 0; i < 3; i++) assert.equal(await o.route(sub(HAIKU, { agent: "ro2" }), CFG, {}), HAIKU, "a model that is not the slot's is not rewritten");
});

// =====================================================================================================================
// Fix round S1/S1c (F2 F4 F7 F10 F13 F14 F15 F16 F17 F18 F20 F25). Each test says which fix it pins.
// =====================================================================================================================
const POISON = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "__defineGetter__", "isPrototypeOf"];
const protoState = () => ({ names: Object.getOwnPropertyNames(Object.prototype).sort().join(","), proto: Object.getPrototypeOf({}) === Object.prototype });
function assertUnpolluted(base, label) {
  assert.deepEqual(protoState(), base, `${label}: Object.prototype is unchanged`);
  for (const k of ["n", "bytesSum", "bytesMax", "model", "t", "polluted"]) assert.equal(({})[k], undefined, `${label}: ({}).${k}`);
  for (const holder of [Object, Object.prototype.toString, Object.prototype.hasOwnProperty, Object.prototype.valueOf]) {
    for (const k of ["n", "bytesSum", "bytesMax"]) assert.equal(holder[k], undefined, `${label}: ${holder.name || "fn"}.${k}`);
  }
}

test("F2: __proto__, constructor, toString and friends as model, provider, session, agent id or tag never reach Object.prototype or a method, through every router map", async () => {
  const base = protoState();
  const tiers = { anthropic: "subscription" };
  for (const bad of POISON) {
    const e = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce", inject: "on" }, { tiers, inject: { all: "", byProvider: { anthropic: "ANTH" }, empty: "EMPTYTEXT", promptNote: "" } }), { slot: null });
    const valid = [`${bad}/x`, bad];                                                          // as a provider prefix and as the whole model
    for (const model of valid) {
      await e.route(aux(model, { agent: `x${bad}`.slice(0, 20), bytes: 1234 }), CFG, {});                  // aux: auxStats
      await e.route(aux(model, { agent: bad, sid: bad, bytes: 99 }), CFG, {});                              // session and agent id spelled as the poison
      await e.route(main(model, { sid: bad }), CFG, {});                                                    // main: learnMain, mainBySession, injection lookup
      await e.route(main(model, { sid: "s1" }), CFG, {});
      await e.route(sub(model, { agent: bad, sid: bad }), CFG, {});                                         // sub with a poison agent id: sticky map and file
      await e.route(sub(HAIKU, { agent: "t1", tag: model }), CFG, {});                                      // as a tag
      await e.route(sub(model, { noAgent: true }), CFG, {});                                                // billing-only: the bl sticky key
    }
    assertUnpolluted(base, `model ${bad}`);
    // the aux table holds the poison as an OWN key (a Map internally), and the status file round-trips it
    const st = e.status();
    assert.equal(Object.hasOwn(st.aux.byModel, "__proto__"), bad === "__proto__", `${bad}: the key __proto__ exists only as an OWN property, and only when it was a model`);
    assert.ok(st.aux.byModel[bad] === undefined || typeof st.aux.byModel[bad].n === "number", `${bad}: a real entry or nothing, never a function or a prototype`);
    assert.ok(Object.keys(st.aux.byModel).length <= 16);
    assertUnpolluted(base, `status of ${bad}`);
    // a main model that is a poison provider must not inject "[object Object]" (own-property read of byProvider)
    const r = injBody(); r.body.model = `${bad}/x`;
    await e.route(r, CFG, {});
    const d = r.body.tools[0].description;
    assert.ok(!/\[object /.test(d) && !/function /.test(d), `${bad}: injected text is a string from the compiled file, never a prototype member (${d.slice(0, 80)})`);
    assert.ok(d.includes("EMPTYTEXT"), `${bad}: an unknown provider falls back to the empty text`);
  }
});

test("F2: aux stats key is the log-safe selector: a non-conforming model is counted under ? and the 16-model cap still holds", async () => {
  const e = env(POL({ enforcement: "enforce" }), { slot: null });
  for (const m of ["a b", "x\ny", "é", "m".repeat(500), "ok/model"]) await e.route(aux(m, { agent: "q" }), CFG, {});
  const by = e.status().aux.byModel;
  assert.deepEqual(Object.keys(by).sort(), ["?", "ok/model"], "four hostile spellings share ONE key");
  assert.equal(by["?"].n, 4);
  for (let i = 0; i < 40; i++) await e.route(aux(`v${i}/m`, { agent: `u${i}` }), CFG, {});
  assert.ok(Object.keys(e.status().aux.byModel).length <= 16);
});

test("F4: a 2 MB model, tag or agent type produces bounded files and logs, and the model is still returned exactly as asked", async () => {
  const big = "m".repeat(2 * 1024 * 1024);
  const e = env(POL({ mode: "dynamic", source: "same-provider", enforcement: "enforce" }), { slot: null });
  await learn(e, SONNET);
  assert.equal(await e.route(aux(big, { agent: "t1" }), CFG, {}), big, "aux");
  assert.equal(await e.route(main(big, { sid: "s9" }), CFG, {}), big, "main (learns the long model)");
  const s1 = await e.route(sub(big, { noAgent: true }), CFG, {});                                       // billing-only: the sticky key used to carry the whole model
  assert.ok(typeof s1 === "string" && s1.length < 200, "a substitute is chosen for an unresolvable model");
  const s2 = await e.route(sub(big, { agent: "a2", tag: big }), CFG, {});
  assert.ok(typeof s2 === "string");
  const s3 = await e.route(sub(big, { agent: "a3", sid: "s9" }), CFG, {});                              // main of s9 is the long model: same-provider has nothing to key on
  assert.equal(s3, big, "unknown/unusable main: asked is served, byte for byte");
  assert.equal(typeof await e.route(sub(big, { agent: "a4", headers: { "x-claude-code-agent-type": "T".repeat(5000) } }), CFG, {}), "string");
  assert.equal(e.lines("classify.jsonl").at(-1).at, "T".repeat(32), "an oversized agent-type header is clipped to 32");
  e.route.__test.flush();
  for (const f of e.files()) {
    const size = fs.statSync(path.join(e.state, f)).size;
    assert.ok(size < 64 * 1024, `${f} is ${size} bytes (limit 64 KiB)`);
  }
  for (const name of ["decisions.jsonl", "classify.jsonl"]) for (const l of fs.readFileSync(path.join(e.state, name), "utf8").split("\n").filter(Boolean)) assert.ok(l.length <= 4096, `${name}: a line of ${l.length} characters`);
  assert.ok(globalThis.__uwSub.agent.size >= 1);
  for (const [k, v] of globalThis.__uwSub.agent) assert.ok(k.length < 300 && v.model.length <= 160, "sticky keys and models are bounded");
  for (const [, m] of globalThis.__uwSub.main) assert.ok(m.model.length <= 200);
  for (const [, m] of globalThis.__uwSub.mainBySession) assert.ok(m.model.length <= 160);
});

test("F7(i): a billing-only subagent (no agent id) shares ONE sticky key and ONE hash per session and asked model, and counts blNoAgentId by the number", async () => {
  // shadow: every request reaches the decision (no stickiness), so the counter is exactly the number of requests
  const sh = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  for (let i = 0; i < 3; i++) await sh.route(sub("nowhere/x", { noAgent: true }), CFG, {});
  assert.equal(sh.counters().blNoAgentId, 3);
  const lines = sh.lines("decisions.jsonl");
  assert.equal(lines.length, 3);
  const PH = POL({ mode: "dynamic", source: "all-providers" }).contentHash;
  assert.deepEqual([...new Set(lines.map((l) => l.ph))], [PH], "one policy hash");
  assert.equal(new Set(lines.map((l) => l.would)).size, 1, "no agent id: every request of the session and asked model hashes to the SAME substitute (one key, not one per request)");
  // enforce: the first decision is recorded under ONE key sid:bl:asked; the repeats are sticky hits (they return before the counter)
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  const first = await e.route(sub("nowhere/x", { noAgent: true }), CFG, {});
  assert.equal(e.counters().blNoAgentId, 1); assert.equal(e.counters().stickyNew, 1);
  assert.deepEqual([...globalThis.__uwSub.agent.keys()], ["s1:bl:nowhere/x"], "exactly one sticky key, the plan's sid:bl:asked");
  for (let i = 0; i < 4; i++) assert.equal(await e.route(sub("nowhere/x", { noAgent: true }), CFG, {}), first);
  assert.equal(e.counters().stickyHit, 4); assert.equal(e.counters().stickyNew, 1); assert.equal(e.counters().blNoAgentId, 1, "sticky hits return before the counter");
  assert.equal(globalThis.__uwSub.agent.size, 1);
  await e.route(sub("nowhere/y", { noAgent: true }), CFG, {});                                          // another asked model: its own key
  await e.route(sub("nowhere/x", { noAgent: true, sid: "s2" }), CFG, {});                               // another session: its own key
  assert.deepEqual([...globalThis.__uwSub.agent.keys()].sort(), ["s1:bl:nowhere/x", "s1:bl:nowhere/y", "s2:bl:nowhere/x"]);
  assert.equal(e.counters().blNoAgentId, 3);
  assert.deepEqual([...new Set(e.lines("decisions.jsonl").map((l) => l.ph))], [PH]);
});

test("F7(iii): a tool-carrying haiku subagent is exempt under inherit ONLY (class exempt); under dynamic and free it is judged by the set (class sub)", async () => {
  const rows = [ROWS[0], ROWS[3], ROWS[4], ROWS[5]];                                                    // sonnet, g1, g2, g3: haiku is NOT in the set
  for (const mode of ["dynamic", "free", "inherit"]) {
    const e = env(mkPolicy({ owner: { mode, source: "all-providers", enforcement: "enforce" }, rows, exempt: [HAIKU], ctxHints: { [HAIKU]: 200000 } }), { slot: null });
    await learn(e, OPUS);
    const ret = await e.route(sub(HAIKU, { agent: "h1" }), CFG, {});
    const cls = e.lines("classify.jsonl").filter((l) => l.cls !== "main").at(-1).cls;
    if (mode === "inherit") { assert.equal(ret, HAIKU, "I8b: left alone"); assert.equal(cls, "exempt"); assert.equal(e.lines("decisions.jsonl").at(-1).act, "keep"); }
    else { assert.notEqual(ret, HAIKU, `${mode}: not exempt, replaced by the set`); assert.equal(cls, "sub"); assert.ok(rows.some((r) => r.s === ret)); }
  }
});

test("F7(iii): free-mode promise breaks: unknown main, an unresolvable asked with nothing usable, and the empty set each serve asked, flag FREE_PROMISE_BREAK, count freeBreak and log once per session and reason", async () => {
  const mk = (owner, rows, extra = {}) => env(mkPolicy({ owner: { mode: "free", enforcement: "enforce", ...owner }, rows, ...extra }), { slot: null });
  // 1. unknown main (same-provider, nothing learned)
  const a = mk({ source: "same-provider" }, ROWS);
  for (let i = 0; i < 3; i++) assert.equal(await a.route(sub(HAIKU, { agent: `u${i}` }), CFG, {}), HAIKU);
  assert.equal(a.counters().freeBreak, 3); assert.equal(a.counters().unknownMain, 3);
  let l = a.lines("decisions.jsonl"); assert.equal(l.length, 1, "logged once per session and reason");
  assert.deepEqual([l[0].act, l[0].flags.includes("FREE_PROMISE_BREAK"), l[0].would], ["unknown-main", true, null]);
  assert.ok(a.status().warnings.some((w) => w.code === "FREE_PROMISE_BREAK"));
  // 2. an unresolvable asked and a set whose only row is unresolvable: nothing usable
  const b = mk({ source: "all-providers" }, [row("ghost/m", { c: 200000 })]);
  for (let i = 0; i < 2; i++) assert.equal(await b.route(sub("nowhere/x", { agent: `v${i}` }), CFG, {}), "nowhere/x");
  assert.equal(b.counters().freeBreak, 2); assert.equal(b.counters().unresolvable, 2);
  l = b.lines("decisions.jsonl"); assert.equal(l.length, 1);
  assert.deepEqual([l[0].act, l[0].flags.includes("FREE_PROMISE_BREAK"), l[0].flags.includes("UNRESOLVABLE_ASKED")], ["unresolvable", true, true]);
  assert.ok(b.status().warnings.some((w) => w.code === "UNRESOLVABLE_ASKED"));
  // 3. the case it must not break: a free-mode request served FROM the set is no break
  const c = mk({ source: "all-providers" }, ROWS);
  await learn(c, SONNET);
  assert.equal(await c.route(sub("nowhere/x", { agent: "w1" }), CFG, {}), SONNET);
  assert.equal(c.counters().freeBreak, 0);
});

test("F10: an out-of-set tag is cleared whenever the router returns no model of its own (unknown main, empty set, inherit with an unusable main, nothing usable); never in shadow; an honoured tag is left", async () => {
  const run1 = async (policy, learnModel, model = HAIKU, tag = "evil/model") => {
    const e = env(policy, { slot: null });
    if (learnModel) await learn(e, learnModel);
    const r = sub(model, { agent: "d1", tag });
    const ret = await e.route(r, CFG, {});
    return { ret, tag: r.builtInSubagentModel, e };
  };
  const enforce = (o, extra = {}) => mkPolicy({ owner: { enforcement: "enforce", ...o }, rows: ROWS, ...extra });
  const cases = [
    ["unknown main (dynamic, same-provider)", enforce({ source: "same-provider" }), null],
    ["empty set (same-provider, no list for main's provider)", enforce({ source: "same-provider" }, { byProvider: {} }), SONNET],
    ["inherit, main not learned", enforce({ mode: "inherit" }), null],
    ["inherit, main unresolvable", enforce({ mode: "inherit" }), "ghost/none"],
    ["nothing usable (every row unresolvable)", mkPolicy({ owner: { enforcement: "enforce", source: "all-providers" }, rows: [row("ghost/m", { c: 200000 })] }), SONNET],
  ];
  for (const [name, policy, learned] of cases) {
    const { tag, ret } = await run1(policy, learned);
    assert.equal(tag, undefined, `${name}: the tag is cleared so CCR's chain cannot honour it`);
    assert.equal(typeof ret, "string");
  }
  const shadow = await run1(mkPolicy({ owner: { enforcement: "shadow", source: "same-provider" }, rows: ROWS }), null);
  assert.equal(shadow.tag, "evil/model", "shadow never touches the request");
  const honoured = await run1(enforce({ source: "all-providers" }), SONNET, HAIKU, "groq/g2");
  assert.equal(honoured.ret, "groq/g2"); assert.equal(honoured.tag, "groq/g2", "an in-set tag that is honoured is left alone");
});

test("F13: a compiled file carrying a gate (a rebuild kept enforcement off for an unmet precondition) raises CLASSIFIER_UNMEASURED in status and the router serves asked", async () => {
  const p = POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" });
  p.gate = { code: "CLASSIFIER_UNMEASURED", text: "CLASSIFIER_UNMEASURED: x" };
  const e = env(p, { slot: null });
  assert.equal(await e.route(sub("nowhere/x", { agent: "g1" }), CFG, {}), "nowhere/x");
  assert.ok(e.status().warnings.some((w) => w.code === "CLASSIFIER_UNMEASURED"));
  const plain = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  await plain.route(sub("nowhere/x", { agent: "g1" }), CFG, {});
  assert.ok(!plain.status().warnings.some((w) => w.code === "CLASSIFIER_UNMEASURED"), "no gate, no warning");
});

test("F14: every decision line records the elapsed ms (plan 5.5), sticky lines included", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  await learn(e, SONNET);
  await e.route(sub("nowhere/x", { agent: "m1" }), CFG, {});
  await e.route(sub("nowhere/x", { agent: "m1" }), CFG, {});                                          // sticky
  await e.route(sub(SONNET, { agent: "m2" }), CFG, {});
  const l = e.lines("decisions.jsonl");
  assert.ok(l.length >= 4);
  for (const x of l) assert.ok(typeof x.ms === "number" && x.ms >= 0 && x.ms < 1000, `${x.act}: ms ${x.ms}`);
  assert.ok(l.some((x) => x.act === "sticky"));
});

test("F15: with the policy absent the router is SILENT: no status file, no state directory is created; a corrupt policy is still loud", async () => {
  const e = env(null, { slot: null });
  fs.rmSync(path.join(e.dir, "state"), { recursive: true });                                          // no state directory at all
  for (let i = 0; i < 5; i++) { await e.route(sub(HAIKU, { agent: `a${i}` }), CFG, {}); await e.route(main(SONNET), CFG, {}); await e.route(aux(HAIKU), CFG, {}); }
  assert.equal(fs.existsSync(e.state), false, "no state directory was created");
  assert.equal(fs.existsSync(path.join(e.dir, "state")), false);
  const bad = env("{nope", { slot: null });
  await bad.route(sub(HAIKU), CFG, {});
  assert.ok(bad.status().warnings.some((w) => w.code === "POLICY_CORRUPT"), "corrupt stays loud");
});

test("F16: the shadow decision line logs the value actually returned (the exact-match slot rewrite included), once", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: { model: "groq/g1" } });
  const ret = await e.route(sub(OPUS, { agent: "s1" }), CFG, {});
  assert.equal(ret, "groq/g1", "the exact slot id is rewritten");
  const l = e.lines("decisions.jsonl").at(-1);
  assert.equal(l.ret, ret, "ret on the line equals the returned value");
  assert.equal(l.asked, OPUS);
  assert.equal(e.counters().slotError, 0);
  const bad = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: "{bad" });
  assert.equal(await bad.route(sub(OPUS, { agent: "s1" }), CFG, {}), OPUS);
  assert.equal(bad.counters().slotError, 1, "the slot is read ONCE per request, however many times the value is logged");
  assert.equal(bad.lines("decisions.jsonl").at(-1).ret, OPUS);
});

test("F17: an agent-type header longer than 32 characters is clipped to 32, not logged as null; an invalid character still logs null", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  const at = (v) => sub(HAIKU, { agent: "t1", headers: { "x-claude-code-agent-type": v } });
  await e.route(at("A".repeat(40)), CFG, {});
  await e.route(at("code-reviewer"), CFG, {});
  await e.route(at("bad type!"), CFG, {});
  await e.route(at(`${"B".repeat(31)}!tail`), CFG, {});
  const l = e.lines("classify.jsonl").map((x) => x.at);
  assert.deepEqual(l, ["A".repeat(32), "code-reviewer", null, null].map((x) => x), "clipped to 32, kept as is, rejected, and the bad character at position 32 is inside the clip");
});

test("F18: payloadUnknown counts ONCE per request, however many candidate rows have an unknown payload cap", async () => {
  const rows = ["g1", "g2", "g3", "g4"].map((m) => row(`groq/${m}`, { c: 200000, pb: 0 }));
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows }), { slot: null });
  await e.route(sub("nowhere/x", { agent: "p1", bytes: 400000 }), CFG, {});
  assert.equal(e.counters().payloadUnknown, 1, "four rows tried, one request");
  await e.route(sub("nowhere/x", { agent: "p2", bytes: 400000 }), CFG, {});
  assert.equal(e.counters().payloadUnknown, 2);
  await e.route(sub("nowhere/x", { agent: "p3" }), CFG, {});                                          // no content-length: nothing unknown to count
  assert.equal(e.counters().payloadUnknown, 2);
});

test("F25 (loose ceilings, O4a): budget at a realistic size (1,800 rows over 60 providers): first decisions of NEW agents, warm sticky hits and shadow decisions; p50 and p99 printed; asserted only against loose ceilings (the strict numbers: test/perf/subagent-router-perf.mjs)", async () => {
  const stats = {};
  for (const [enforcement, source] of [["enforce", "same-provider"], ["enforce", "all-providers"], ["shadow", "all-providers"]]) {
    const m = await measurePool(enforcement, source, { rounds: 4, fresh: 400 });
    const f = latencyStats(m.fresh), w = latencyStats(m.warm);
    stats[`${enforcement}/${source}`] = { f, w };
    console.log(`budget(F25) ${enforcement}/${source}: new agents (${f.n}) p50 ${f.p50.toFixed(2)} p99 ${f.p99.toFixed(2)} max ${f.max.toFixed(2)} ms; warm hits (${w.n}) p50 ${w.p50.toFixed(3)} p99 ${w.p99.toFixed(3)} ms, ${m.rows} rows, ${m.providers} providers`);
  }
  for (const [k, v] of Object.entries(stats)) {
    assert.ok(v.f.p99 < LOOSE_P99_MS, `${k}: new-agent p99 ${v.f.p99} ms under the loose ceiling of ${LOOSE_P99_MS} ms`);
    assert.ok(v.w.p99 < LOOSE_P99_MS, `${k}: warm p99 ${v.w.p99} ms under the loose ceiling of ${LOOSE_P99_MS} ms`);
  }
});

test("F20: the require scan catches a computed require (const N = ...; require(N)) and any other use of the name, not only literal ones", () => {
  const count = (src) => (src.replace(/\/\/.*$/gm, "").match(/\brequire\b/g) || []).length;
  assert.equal(count('const fs = require("node:fs"); const path = require("node:path");'), 2);
  assert.equal(count('const N = "node:child_process"; const cp = require(N);'), 1, "the evasion IS counted");
  assert.equal(count('const r = require; r("node:net");'), 1, "so is a bare reference");
  assert.equal(count('const fs = require("node:fs"); // require(x) in a comment'), 1, "comments are not");
  assert.equal(count(SRC), 3, "the router source has exactly its three literal requires (fs and path in the body, fs in the loader's one stat of its own file) and no other use of the name");
});

// =====================================================================================================================
// Second fix round (G2 G9 G10). Failing-first: each fails on the code it replaced.
// =====================================================================================================================
test("G2: the funnel and the compiler survive provider names __proto__, constructor, toString, hasOwnProperty...: no throw, no Object.prototype pollution, right counts, and the compiled file serves requests in the router", async () => {
  const lib = await import("../keysync/subagent-policy.mjs");
  const { funnel } = await import("../menu/subagent-funnel.mjs");
  const base = protoState();
  const nowMs = Date.parse("2026-10-03T12:00:00.000Z");
  const names = [...POISON, "okprov"], MODELS = ["m1", "m2", "m3"];
  const rows = names.map((p) => ({ provider: p, keyId: `b.${p}.free`, models: MODELS.map((id) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 1, pout: 2 })) }));
  const providers = names.map((name) => ({ name, models: MODELS, enabled: true, described: false }));
  const bench = { get: () => ({ s: "ok", a: nowMs / 1000 - 3600, t: 500 }), isLive: () => false };
  const tiersOwn = Object.create(null); for (const p of names) tiersOwn[p] = "free";          // what readTiers builds: every poison name an OWN key
  const tiersMissing = { okprov: "free" };                                                      // a plain object that has no key for the poison names
  const dirty = () => { for (const k of ["benchOk", "tools", "scope", "ctx", "sub", "polluted"]) if (({})[k] !== undefined) return k; return null; };
  const run = (tiers, toggles) => funnel({ rows, bench, nowMs, providers, tiers, toolFidelity: null, aliasValues: {}, defaultModel: null }, { source: "same-provider", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [], ...toggles });
  for (const tiers of [tiersOwn, tiersMissing]) for (const source of ["same-provider", "all-providers"]) for (const mode of ["dynamic", "free", "inherit"]) {
    const label = `${tiers === tiersOwn ? "own" : "missing"}/${source}/${mode}`;
    let res;
    assert.doesNotThrow(() => { res = run(tiers, { source, mode }); }, label);
    assertUnpolluted(base, label); assert.equal(dirty(), null, `${label}: no counter leaked onto Object.prototype`);
    assert.ok(!res.warnings.some((w) => w.code === "TIER_MISMATCH"), `${label}: a missing tier is undefined, never a prototype member (${res.warnings.map((w) => w.text).filter((t) => /MISMATCH/.test(t)).join("|")})`);
    const covered = tiers === tiersOwn || mode !== "free" ? names : ["okprov"];                 // free providers scope: only a provider with a key tier is in scope
    assert.equal(res.counts.allowed, covered.length * 3, label);
    if (mode === "inherit") continue;
    assert.equal(res.substitutable["*"], covered.length * 3, label);
    for (const p of covered) {
      assert.ok(Object.hasOwn(res.substitutable, p), `${label}: ${p} is an own key of substitutable`);
      assert.equal(res.substitutable[p], 3, `${label}: ${p}`);
      assert.ok(Object.hasOwn(res.perProvider, p) && res.perProvider[p].sub === 3, `${label}: perProvider ${p}`);
      if (source === "same-provider") assert.deepEqual(res.lists.byProvider[p].length, 3, `${label}: lists.byProvider ${p}`);
    }
    if (source === "same-provider") assert.equal(Object.keys(res.lists.byProvider).length, covered.length, label);
    if (tiers === tiersMissing && mode === "free") assert.ok(res.warnings.some((w) => w.code === "NO_TIER" && w.text.includes("__proto__")), `${label}: the providers with no tier are named`);
    if (tiers === tiersOwn && mode === "free") assert.ok(res.models.every((m) => m.fp === 1), `${label}: the free-tier rows are flagged (the tier was read as an own value)`);
  }
  // compile with the same inputs, serialise the way `set` writes the file, read it back the way the router does
  const g = { funnelInputs: { rows, bench, nowMs, providers, tiers: tiersOwn, toolFidelity: null, aliasValues: {}, defaultModel: null }, warnings: [],
    stamps: { snapshotBuiltAt: null, snapshotSchema: 9, benchGeneratedAt: null, observedWrittenAt: null, tfAsOf: null }, providersLive: true, providersHash: "h" };
  let compiled;
  assert.doesNotThrow(() => { compiled = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "same-provider", mode: "dynamic", enforcement: "enforce", inject: "on" }).compiled; });
  const parsed = JSON.parse(JSON.stringify(compiled) + "\n");
  for (const [what, obj] of [["tiers", parsed.tiers], ["substitutable", parsed.substitutable], ["lists.byProvider", parsed.lists.byProvider], ["inject.byProvider", parsed.inject.byProvider]]) {
    assert.ok(Object.hasOwn(obj, "__proto__"), `${what}: __proto__ survives serialisation as an OWN key`);
    assert.equal(Object.getPrototypeOf(obj), Object.prototype, `${what}: and the object is still an ordinary one`);
    assert.equal(Object.keys(obj).length, names.length + (what === "substitutable" ? 1 : 0), `${what}: one key per provider (substitutable adds the "*" total)`);
  }
  assert.equal(parsed.contentHash, lib.hashOf(parsed), "the hash survives the round trip");
  assertUnpolluted(base, "after compile and round trip");
  // the router fixture harness loads that file and serves a substitute from the poison-named provider's own list
  const e = env(parsed, { slot: null });
  const CFGP = cfg(...names.map((n) => [n, MODELS]));
  for (const name of names) {
    const sid = `sid-${name}`;
    await e.route(main(`${name}/m1`, { sid }), CFGP, {});
    const ret = await e.route(sub("nowhere/x", { sid, agent: "ag" }), CFGP, {});
    assert.match(ret, new RegExp(`^${name}/m[123]$`), `${name}: a substitute from main's own provider list, got ${ret}`);
    const r = injBody(); r.body.model = `${name}/m1`; r.headers["x-claude-code-session-id"] = sid; r.sessionId = sid;
    await e.route(r, CFGP, {});
    const d = r.body.tools[0].description;
    assert.ok(d.includes("[uw-subagent-policy") && d.includes(` ${name}`) && !/\[object |function /.test(d), `${name}: the injected text is the compiled string for that provider (${d.slice(0, 90)})`);
  }
  assert.equal(e.counters().error, 0, "no router error");
  assertUnpolluted(base, "after the router");
});

test("G9 (revised by S-F6): a flood of 3,000 session ids that each sent a main request leaves at most 256 session files; at the cap a new session is MEMORY-ONLY until the oldest file has been idle for an hour (then it is evicted); every decision is the same as the first; status says the cap was hit; a gc pass removes every stale file, not 50", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce" }), { slot: null });
  const SESSION = /^(main|agents)-[A-Za-z0-9_-]{1,64}\.(json|jsonl)$/, session = () => e.files().filter((f) => SESSION.test(f));
  const rets = new Set();
  for (let i = 0; i < 3000; i++) {
    e.tick(10);
    await learn(e, SONNET, `sid${i}`);
    rets.add(await e.route(sub("nowhere/x", { agent: "same-agent", sid: `sid${i}` }), CFG, {}));
    if (i % 25 === 24) await e.drain();                                                   // the event loop turns between real requests: the async writes complete (fewer than 64 files in flight)
  }
  await e.drain();
  assert.ok(session().length <= 256, `${session().length} session files after 3,000 sessions`);
  assert.ok(session().length >= 250, `the cap is a ceiling, not a switch-off: ${session().length} files`);
  assert.equal(rets.size, 1, "every one of the 3,000 sessions got the same decision (the cap changes durability, never the answer)");
  assert.notEqual([...rets][0], "nowhere/x", "and it was a substitute, not the asked model");
  assert.equal(e.counters().rejectUnresolvable, 3000, "each of the 3,000 was decided (an unresolvable ask is rejected for a candidate), none skipped");
  assert.ok(session().includes("main-sid0.json") && session().includes("agents-sid0.jsonl"), "the OLDEST sessions keep their files: none of them was idle for an hour, so none is evicted for a flood");
  assert.ok(!session().includes("main-sid2999.json") && !session().includes("agents-sid2999.jsonl"), "the flood's newest session is memory-only");
  assert.ok(e.counters().sessionFileSkip > 2000, `${e.counters().sessionFileSkip} files skipped at the cap`);
  assert.ok(e.status().warnings.some((w) => w.code === "SESSION_FILE_CAP"), "status says the session files are at the cap");
  // an EXISTING session's file is still rewritten under the cap (the case it must not break)
  const before = fs.readFileSync(path.join(e.state, "main-sid0.json"), "utf8");
  e.tick(2 * 60 * 1000); await learn(e, HAIKU, "sid0"); await e.drain();
  assert.notEqual(fs.readFileSync(path.join(e.state, "main-sid0.json"), "utf8"), before, "a known session file is still updated");
  // an hour later the oldest FILE is idle: a new session may take its place (the hourly gc re-read the file times from disk, which are REAL times: move the seam clock past them)
  e.setClock(Date.now() + 61 * 60 * 1000);
  const had = session().length;
  await learn(e, SONNET, "fresh1"); await e.drain();
  assert.ok(session().includes("main-fresh1.json"), "a new session is admitted once the oldest file has been idle for an hour");
  assert.ok(session().length <= had, "by evicting, not by growing");
  // gc: every file older than 24 h goes in one pass (the old pass stopped at 50). The files carry the real mtime, so move the seam clock far ahead.
  e.tick(10 * 24 * 3600 * 1000);
  for (let i = 0; i < 60; i++) await e.route(sub("nowhere/x", { agent: `late${i}`, sid: "late" }), CFG, {});
  assert.ok(globalThis.__uwSub.gcJob, "SEC-5: the pass is SPREAD over requests: 10 requests after it started it is still going");
  let more = 0; while (globalThis.__uwSub.gcJob && more < 200) { await e.route(sub("nowhere/x", { agent: `late${60 + more}`, sid: "late" }), CFG, {}); more += 1; }   // it continues on every request until its listing is done
  await e.drain();
  assert.ok(session().length <= 4, `${session().length} session files left after the gc pass`);
  assert.ok(!session().includes("main-sid0.json"));
});

test("S-F6 REGRESSION: a session id that only ever sent subagent-shaped requests (no main request with an Agent tool) owns NO session file, however many ids arrive; its decisions are still right and memory-only", async () => {
  const e = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 400; i++) await e.route(sub("nowhere/x", { agent: "a", sid: `fl${i}` }), CFG, {});
  await e.drain();
  assert.deepEqual(e.files().filter((f) => /^(main|agents)-/.test(f)), [], "no session file at all");
  assert.equal(e.counters().sessionFileSkip, 400);
  assert.equal(e.counters().rejectUnresolvable, 400, "every request was decided");
  assert.equal(globalThis.__uwSub.agent.size, 400, "and kept in memory");
  await learn(e, SONNET, "real");                                                          // the case it must not break: a real session
  await e.route(sub("nowhere/x", { agent: "a", sid: "real" }), CFG, {});
  await e.drain();
  assert.ok(fs.existsSync(path.join(e.state, "agents-real.jsonl")) && fs.existsSync(path.join(e.state, "main-real.json")));
  const e2 = env(ENFORCE(), { slot: null });                                                // a restarted worker: the main file on disk still names the session
  fs.writeFileSync(path.join(e2.state, "main-back.json"), JSON.stringify({ model: SONNET, t: "2026-10-03T11:59:00.000Z" }));
  await e2.route(sub("nowhere/x", { agent: "a", sid: "back" }), CFG, {});
  assert.ok(fs.existsSync(path.join(e2.state, "agents-back.jsonl")), "a session whose main file exists is known after a restart");
});

test("S-F5 REGRESSION: session ids are lower-cased for the map key AND the file name (NTFS is case-insensitive): S1 and s1 are one session, one main, one journal", async () => {
  const e = env(ENFORCE({ source: "same-provider" }), { slot: null });
  await learn(e, SONNET, "AbC1");
  assert.ok(globalThis.__uwSub.main.has("abc1") && !globalThis.__uwSub.main.has("AbC1"));
  const a = await e.route(sub("nowhere/x", { agent: "x", sid: "ABC1" }), CFG, {});
  assert.match(a, /^anthropic\//, "main learned under AbC1 is found under ABC1");
  assert.equal(await e.route(sub("nowhere/x", { agent: "x", sid: "abc1" }), CFG, {}), a);
  assert.equal(e.counters().stickyHit, 1, "one agent, one entry");
  await e.drain();
  assert.deepEqual(e.files().filter((f) => /^(main|agents)-/.test(f)).sort(), ["agents-abc1.jsonl", "main-abc1.json"], "one pair of files, lower-case names");
});

test("G10: CLASSIFIER_UNMEASURED leaves status when a later compiled file carries no gate and returns, with a fresh `since`, when a gate comes back; unrelated warnings stay", async () => {
  const mk = (hash, gate) => { const p = POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }, { hash }); if (gate) p.gate = { code: "CLASSIFIER_UNMEASURED", text: "CLASSIFIER_UNMEASURED: x" }; return p; };
  const e = env(mk("h0000000001", true), { slot: "{not json" });
  const has = () => e.status().warnings.filter((w) => w.code === "CLASSIFIER_UNMEASURED");
  await e.route(sub("nowhere/x", { agent: "g1" }), CFG, {});
  await e.route({ body: { model: OPUS } }, CFG, {});                                            // a corrupt slot raises an unrelated warning
  assert.equal(has().length, 1);
  assert.ok(e.status().warnings.some((w) => w.code === "SLOT_ERROR"));
  e.setPolicy(mk("h0000000002", false));                                                        // a rebuild after the precondition holds again
  await e.route(sub("nowhere/x", { agent: "g2" }), CFG, {});
  assert.equal(has().length, 0, "the warning is gone from status");
  assert.ok(e.status().warnings.some((w) => w.code === "SLOT_ERROR"), "an unrelated warning is not cleared with it");
  e.tick(60 * 1000);
  e.setPolicy(mk("h0000000003", true));
  await e.route(sub("nowhere/x", { agent: "g3" }), CFG, {});
  assert.equal(has().length, 1, "a returning gate raises it again");
  assert.equal(has()[0].since, new Date(Date.parse("2026-10-03T12:01:00.000Z")).toISOString(), "with the time it came back, not the first time");
});

// =====================================================================================================================
// ROUTER V2 (ar-1 .. ar-17). Each test names the review item it pins; the ones marked REGRESSION fail on the version 1 router.
// =====================================================================================================================
const ENFORCE = (o = {}, extra = {}) => POL({ mode: "dynamic", source: "all-providers", enforcement: "enforce", ...o }, extra);
const withMsgs = (r, n) => { r.body.messages = Array.from({ length: n }, () => ({ role: "user", content: "x" })); return r; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("ar-1 REGRESSION: team agent ids (name@session-xxxx), a 128-character id, __proto__ and 200-character ids are AGENTS with their own sticky keys; the id never reaches a file name; a parent id is logged as pid8 and never used", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  const long200 = `${"a".repeat(199)}b`, long200b = `${"a".repeat(199)}c`;
  const ids = ["a@b-1234abcd", "ccr-logs@session-f49cde2f", "x".repeat(128), "__proto__", long200, long200b];
  for (const id of ids) {
    const ret = await e.route(sub("nowhere/x", { agent: id, bl: false }), CFG, {});              // the agent-id header alone: no billing marker
    assert.notEqual(ret, "nowhere/x", `${id.slice(0, 20)}: a subagent (it got a substitute), not a main request`);
  }
  const cl = e.lines("classify.jsonl").filter((l) => l.cls !== "main");
  assert.equal(cl.length, ids.length);
  assert.ok(cl.every((l) => l.cls === "sub" && l.ag === 1), "every one is classed as an agent");
  const keys = [...globalThis.__uwSub.agent.keys()];
  assert.equal(new Set(keys).size, ids.length, "distinct sticky keys: nobody shares one");
  assert.ok(keys.includes("s1:a@b-1234abcd") && keys.includes("s1:__proto__") && keys.includes(`s1:${"x".repeat(128)}`));
  assert.equal(keys.filter((k) => k.startsWith("s1:~")).length, 2, "the two 200-character ids are hashed keys");
  assert.equal(e.counters().agentIdOdd, 2, "an id that fails the charset is counted");
  assert.equal(globalThis.__uwSub.main.get("s1").model, SONNET, "no agent request taught main");
  assert.ok(!e.lines("decisions.jsonl").some((l) => l.act === "main-learn" && l.ret !== SONNET));
  await e.drain();
  for (const f of e.files()) for (const bad of ["@", "__proto__", "xxxx", "aaaa", "~"]) assert.ok(!f.includes(bad), `the agent id never appears in a file name: ${f}`);
  assert.equal(e.lines("agents.jsonl").find((l) => l.aid === "ccr-logs@ses")?.sid, "s1", "aid is the first 12 characters of the sanitised id");
  // an odd agent request that carries an Agent tool must still not teach main
  await e.route(sub(HAIKU, { agent: "w@s-1", bl: false, tools: [{ name: "Agent" }, { name: "Read" }] }), CFG, {});
  assert.equal(globalThis.__uwSub.main.get("s1").model, SONNET);
  // the parent header is logged (first 8 characters) and changes no decision
  const a = await e.route(sub("nowhere/x", { agent: "p1@s-aaaa", bl: false, headers: { "x-claude-code-parent-agent-id": "parent-0123456789" } }), CFG, {});
  const b = await e.route(sub("nowhere/x", { agent: "p2@s-aaaa", bl: false }), CFG, {});
  assert.equal(typeof a, "string"); assert.equal(typeof b, "string");
  const withP = e.lines("agents.jsonl").find((l) => l.aid === "p1@s-aaaa");
  assert.equal(withP.pid8, "parent-0"); assert.equal(e.lines("agents.jsonl").find((l) => l.aid === "p2@s-aaaa").pid8, null);
  assert.equal(e.lines("classify.jsonl").at(-2).pid8, "parent-0");
  const e2 = env(ENFORCE(), { slot: null });
  await learn(e2, SONNET);
  assert.equal(await e2.route(sub("nowhere/x", { agent: "p1@s-aaaa", bl: false }), CFG, {}), a, "the parent id is never used in a decision");
  // a hostile parent id is "?", never the text
  await e.route(sub("nowhere/x", { agent: "p3@s-aaaa", bl: false, headers: { "x-claude-code-parent-agent-id": "bad id\nwith lines" } }), CFG, {});
  assert.equal(e.lines("agents.jsonl").find((l) => l.aid === "p3@s-aaaa").pid8, "?");
});

test("ar-3a REGRESSION: an outcome with no model of its own (unknown main) is not stored: the next turn decides again, so a main learned in between is used", async () => {
  const e = env(ENFORCE({ source: "same-provider" }), { slot: null });
  assert.equal(await e.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), "nowhere/x", "unknown main: asked is served");
  assert.equal(await e.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), "nowhere/x");
  assert.equal(globalThis.__uwSub.agent.size, 0, "nothing stored");
  assert.equal(e.lines("decisions.jsonl").filter((l) => l.act === "unknown-main").length, 1, "logged once through logOnce, not on every turn");
  await learn(e, "groq/g1");
  assert.match(await e.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), /^groq\//, "the next turn substitutes from main's provider");
  assert.equal(globalThis.__uwSub.agent.size, 1, "a decision with a model IS stored (the case it must not break)");
  assert.equal(await e.route(sub("nowhere/x", { agent: "a1" }), CFG, {}), [...globalThis.__uwSub.agent.values()][0].model, "and is then sticky");
});

test("ar-3b REGRESSION: a sliding TTL: a hit 10 minutes after the last touch extends the entry and appends one touch line, hits inside 10 minutes append nothing, expiry is 6 h after the last touch with an absolute 24 h cap", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  const journal = path.join(e.state, "agents-s1.jsonl"), count = () => fs.readFileSync(journal, "utf8").split("\n").filter(Boolean).length;
  const first = await e.route(sub("nowhere/x", { agent: "t1" }), CFG, {});
  assert.equal(count(), 1);
  e.tick(5 * 60 * 1000);
  assert.equal(await e.route(sub("nowhere/x", { agent: "t1" }), CFG, {}), first); assert.equal(count(), 1, "a hit inside 10 minutes: zero IO");
  e.tick(6 * 60 * 1000);
  assert.equal(await e.route(sub("nowhere/x", { agent: "t1" }), CFG, {}), first);
  assert.equal(count(), 2, "a hit more than 10 minutes after the last touch appends ONE touch line");
  const touch = JSON.parse(fs.readFileSync(journal, "utf8").split("\n").filter(Boolean)[1]);
  assert.deepEqual(Object.keys(touch).sort(), ["k", "n", "tm", "ts", "u"]); assert.equal(touch.k, "t1"); assert.equal(touch.n, 2, "the hit count rides along");
  for (let i = 0; i < 4; i++) { e.tick(5 * 3600 * 1000); assert.equal(await e.route(sub("nowhere/x", { agent: "t1" }), CFG, {}), first, `hit ${i + 1}: alive 5 h after the last touch, 6 h after the decision is long past`); }
  const hits = e.counters().stickyHit;
  e.tick(5 * 3600 * 1000);                                                                // about 25 h after the first decision: the absolute cap
  await e.route(sub("nowhere/x", { agent: "t1" }), CFG, {});
  assert.equal(e.counters().stickyHit, hits, "past 24 h from the first decision the entry is gone, however recently it was touched");
  assert.equal(e.counters().stickyNew, 2, "and a fresh decision was made");
  // expiry 6 h after the last touch
  const e2 = env(ENFORCE(), { slot: null });
  await e2.route(sub("nowhere/x", { agent: "t2" }), CFG, {});
  e2.tick(5 * 3600 * 1000); await e2.route(sub("nowhere/x", { agent: "t2" }), CFG, {});
  e2.tick(6 * 3600 * 1000 + 1); await e2.route(sub("nowhere/x", { agent: "t2" }), CFG, {});
  assert.equal(e2.counters().stickyHit, 1, "6 h and a millisecond after the last touch: expired");
});

test("ar-3d REGRESSION: a 200-agent fan-out in session A is capped at 128 within A and evicts none of session B's entries; the global cap is 512", async () => {
  const e = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 10; i++) { e.tick(10); await e.route(sub("nowhere/x", { agent: `b${i}`, sid: "sb" }), CFG, {}); }
  for (let i = 0; i < 200; i++) { e.tick(10); await e.route(sub("nowhere/x", { agent: `a${i}`, sid: "sa" }), CFG, {}); }
  const keys = [...globalThis.__uwSub.agent.keys()];
  assert.equal(keys.filter((k) => k.startsWith("sa:")).length, 128, "session A is capped at 128");
  assert.equal(keys.filter((k) => k.startsWith("sb:")).length, 10, "session B lost nothing to A's fan-out");
  assert.ok(!keys.includes("sa:a0") && keys.includes("sa:a199"), "the OLDEST of A went first");
  assert.equal(e.counters().stickyCapEvict, 72);
  const f = env(ENFORCE(), { slot: null });
  for (let s = 0; s < 6; s++) for (let i = 0; i < 128; i++) { f.tick(5); await f.route(sub("nowhere/x", { agent: `g${i}`, sid: `s${s}` }), CFG, {}); }
  assert.ok(globalThis.__uwSub.agent.size <= 512, `${globalThis.__uwSub.agent.size} entries after 768 decisions in 6 sessions`);
});

// ---------------------------------------------------------------------------------------------- ar-4: the pool scan, the lazy index, banded spread
const legacyProviderOf = (s) => { const i = s.indexOf("/"); return i < 0 ? s : s.slice(0, i); };
const legacyResolvable = (sel, config) => {
  const i = sel.indexOf("/"), list = config && config.Providers;
  if (i < 1 || !Array.isArray(list)) return false;
  const name = sel.slice(0, i), rest = sel.slice(i + 1);
  for (const p of list) if (p && p.name === name) return p.enabled !== false && Array.isArray(p.models) && p.models.indexOf(rest) >= 0;
  return false;
};
/** The version 1 `decide` for the dynamic and free modes, kept verbatim in this test as the ORACLE for the new lazy picker (banding off): the whole-list pool, then pool2.slice by the tie-group code. */
async function legacyDecide(pol, main, want, asked, X, config) {
  const { fnv1a32 } = await import("../menu/subagent-funnel.mjs");
  const models = pol.models, idx = new Map(models.map((m, i) => [m.s, i]));
  const ok = (sel) => legacyResolvable(sel, config), hint = pol.ctxHints[asked], floor = Math.max(typeof hint === "number" ? hint : 0, 128000);
  const same = pol.owner.source !== "all-providers";
  if (same && !main) return { act: "unknown-main", model: null };
  const S0 = same ? pol.lists.byProvider[legacyProviderOf(main)] : (pol.lists.all ?? models.map((_, i) => i));
  if (!Array.isArray(S0) || S0.length === 0) return { act: "empty-set", model: null };
  const inSet = (sel) => { const i = idx.get(sel); return i !== undefined && S0.indexOf(i) >= 0; };
  const fitsTok = (row, sub) => (!row ? !sub : !(row.c > 0) ? !sub : typeof X.tokenCount !== "number" ? true : X.tokenCount * 1.1 <= row.c);
  const fitsBy = (row) => (!row || !(row.pb > 0) ? true : !(X.bytes > 0) || X.bytes <= row.pb);
  const rowOf = (s) => (idx.has(s) ? models[idx.get(s)] : null);
  if (inSet(want) && ok(want) && fitsTok(rowOf(want), false) && fitsBy(rowOf(want))) return { act: want === asked ? "keep" : "honour-tag", model: want };
  const pool = [];
  for (const i of S0) { const row = models[i]; if (!row || !ok(row.s) || !(row.c >= floor) || !fitsTok(row, true) || !fitsBy(row)) continue; pool.push(row); }
  let cand = null, fragile = false;
  // R-v3, the one intended difference (banding off too): above 200 KB a row with an unknown payload cap (pb 0) ranks LAST: known-cap rows are used when any exists; when none does, the
  // unknown rows are the pool but main's own model is not taken first on its unknown cap. Up to 200 KB the oracle is the version 1 pool unchanged.
  const big = X.bytes > 200 * 1024, known = pool.filter((r) => r.pb > 0), allUnknownBig = big && known.length === 0;
  const pl = big && known.length ? known : pool;
  if (main && !allUnknownBig && pl.some((r) => r.s === main)) cand = main;
  else if (pl.length) {
    const mp = main ? pl.filter((r) => legacyProviderOf(r.s) === legacyProviderOf(main)) : [];
    const pool2 = mp.length ? mp : pl, lead = pool2[0], top = [];
    for (let i = 0; i < pool2.length && top.length < 3; i++) if (pool2[i].g === lead.g) top.push(pool2[i]);
    for (let i = 0; i < pool2.length && top.length < 3; i++) if (top.indexOf(pool2[i]) < 0) top.push(pool2[i]);
    fragile = top.length < 3;
    cand = top[fnv1a32(X.agentKey) % top.length].s;
  }
  if (cand) return { act: ok(asked) ? "substitute" : "reject-unresolvable", model: cand, fragile };
  return { act: "unresolvable", model: null };
}

test("ar-4: DIFFERENTIAL PROPERTY TEST: 5,000 random (policy, main, request, config) cases: the lazy picker (banding off) returns exactly what the version 1 whole-list pool returned, with and without lists.prov, with lists.all null or listed", async () => {
  let seed = 424242;
  const rnd = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const e = env(null, { slot: null });
  e.route.__test.now = (() => { let t = Date.parse("2026-10-03T12:00:00.000Z"); return () => (t += 100); })();   // time moves: the logs and the 10-minute touches behave as in service
  let cases = 0, subs = 0, fragiles = 0;
  const outcomes = new Set();
  for (let pi = 0; pi < 100; pi++) {
    const nProv = 1 + rnd(5), provNames = Array.from({ length: nProv }, (_, i) => `pv${i}`);
    const rows = [], providers = [];
    for (const name of provNames) {
      const n = 1 + rnd(7), have = [];
      for (let i = 0; i < n; i++) {
        const m = `m${i}`;
        if (rnd(5) > 0) have.push(m);                                                 // one in five is NOT in the live Providers: unresolvable
        rows.push(row(`${name}/${m}`, { c: [0, 64000, 131072, 200000, 1000000][rnd(5)], pb: [0, 0, 100000, 300000][rnd(4)] }));
      }
      providers.push({ name, models: have, ...(rnd(8) === 0 ? { enabled: false } : {}) });
    }
    for (let i = rows.length - 1; i > 0; i--) { const j = rnd(i + 1); [rows[i], rows[j]] = [rows[j], rows[i]]; }    // an arbitrary rank order
    let g = 0, b = 0;
    rows.forEach((r) => { if (rnd(2)) { g += 1; if (rnd(2)) b += 1; } r.g = g; r.b = b; });
    const source = rnd(2) ? "same-provider" : "all-providers", mode = rnd(2) ? "dynamic" : "free";
    const policy = mkPolicy({ owner: { mode, source, enforcement: "enforce", banded: false }, rows, withProv: rnd(2) === 0, hash: `d${pi}`,
      all: source === "all-providers" && rnd(2) ? null : undefined, ctxHints: { "pv0/ask": [0, 200000, 1000000][rnd(3)] } });
    e.setPolicy(policy);
    e.route.__test.reset(); e.route.__test.now = e.route.__test.now;
    const config = { Providers: providers };
    for (let ci = 0; ci < 50; ci++) {
      const pickSel = () => rows[rnd(rows.length)].s;
      const mainModel = rnd(7) === 0 ? null : rnd(5) === 0 ? "outside/m0" : pickSel();
      const asked = rnd(2) ? "pv0/ask" : pickSel(), tag = rnd(3) === 0 ? pickSel() : rnd(6) === 0 ? "nowhere/x" : null;
      const tokenCount = rnd(3) === 0 ? undefined : 20000 + rnd(210000), bytes = rnd(3) === 0 ? 0 : 1 + rnd(400000);
      const sid = mainModel ? `c${ci % 10}` : `n${pi}_${ci}`, agent = `case-${pi}-${ci}`;      // an unknown main needs a session nobody taught
      if (mainModel) await e.route(main(mainModel, { sid }), config, {});
      const r = sub(asked, { sid, agent, tag, tokenCount, bytes: bytes || undefined });
      const got = await e.route(r, config, {});
      const exp = await legacyDecide(policy, mainModel, tag || asked, asked, { tokenCount, bytes, agentKey: agent }, config);
      const want = exp.model ?? asked;
      assert.equal(got, want, `case ${pi}/${ci}: ${source}/${mode} main=${mainModel} asked=${asked} tag=${tag} tc=${tokenCount} bytes=${bytes} legacy=${exp.act}`);
      cases += 1; outcomes.add(exp.act);
      if (exp.act === "substitute" || exp.act === "reject-unresolvable") { subs += 1; if (exp.fragile) fragiles += 1; }
    }
  }
  assert.equal(cases, 5000);
  assert.ok(subs > 1000 && fragiles > 100, `the generator exercised the substitute path (${subs} of ${cases} cases, ${fragiles} fragile)`);
  for (const act of ["keep", "honour-tag", "substitute", "unknown-main", "empty-set", "unresolvable"]) assert.ok(outcomes.has(act), `the generator reached ${act}`);
  assert.equal(e.counters().error ?? 0, 0);
});

test("ar-4: banded spread (default on) chooses inside the lead row's band only, K' = min(K, band size), FRAGILE_SET when K' < K; banded:false is the old spread; an unusable lead moves the band", async () => {
  const providers = cfg(["groq", ["g1", "g2", "g3", "g4", "g5"]]);
  const rowsB = [row("groq/g1", { b: 0, g: 0 }), row("groq/g2", { b: 0, g: 1 }), row("groq/g3", { b: 1, g: 2 }), row("groq/g4", { b: 1, g: 3 }), row("groq/g5", { b: 2, g: 4 })];
  const spread = async (banded, config = providers, rows = rowsB) => {
    const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce", banded }, rows, withProv: true }), { slot: null });
    const got = new Set();
    for (let i = 0; i < 60; i++) { e.tick(100); got.add(await e.route(sub(HAIKU, { agent: `bg-${i}` }), config, {})); }
    return { got: [...got].sort(), fragile: e.lines("agents.jsonl").some((l) => l.flags.includes("FRAGILE_SET")) };
  };
  const on = await spread(true), off = await spread(false);
  assert.deepEqual(on.got, ["groq/g1", "groq/g2"], "banded: the two band-0 rows only");
  assert.equal(on.fragile, true, "K' = 2 < 3");
  assert.deepEqual(off.got, ["groq/g1", "groq/g2", "groq/g3"], "banded:false: the old top three");
  assert.equal(off.fragile, false);
  const wide = await spread(true, providers, [row("groq/g1", { b: 0 }), row("groq/g2", { b: 0 }), row("groq/g3", { b: 0 }), row("groq/g4", { b: 0 }), row("groq/g5", { b: 1 })]);
  assert.deepEqual(wide.got, ["groq/g1", "groq/g2", "groq/g3"], "a band with four rows still gives three");
  assert.equal(wide.fragile, false);
  const lost = await spread(true, cfg(["groq", ["g2", "g3", "g4", "g5"]]));
  assert.deepEqual(lost, { got: ["groq/g2"], fragile: true }, "g1 is not resolvable: the lead is g2, its band is g2 alone");
});

test("ar-4: the lazy resolvability index examines only the providers it needs (about K rows), not the providers of all 1,800 rows", async () => {
  const rows = [], providers = [], touched = new Map();
  for (let p = 0; p < 60; p++) {
    const models = [];
    for (let i = 0; i < 30; i++) { models.push(`m${i}`); rows.push(row(`prov${p}/m${i}`, { c: 131072 + i })); }
    const prov = { name: `prov${p}` };
    Object.defineProperty(prov, "models", { enumerable: true, get() { touched.set(prov.name, (touched.get(prov.name) || 0) + 1); return models; } });
    providers.push(prov);
  }
  for (const source of ["all-providers", "same-provider"]) {
    touched.clear();
    const e = env(mkPolicy({ owner: { mode: "dynamic", source, enforcement: "enforce" }, rows, withProv: true, all: source === "all-providers" ? null : undefined }), { slot: null });
    await e.route(main("prov7/zz", { sid: "b1" }), { Providers: providers }, {});
    const r = await e.route(sub("nowhere/x", { sid: "b1", agent: "lazy1" }), { Providers: providers }, {});
    assert.match(r, /^prov7\//, `${source}: a substitute from main's provider`);
    const reads = [...touched.values()].reduce((a, b) => a + b, 0);
    assert.ok(touched.size <= 2, `${source}: providers examined ${touched.size} of 60`);
    assert.ok(reads < 60, `${source}: ${reads} reads of Providers[].models for one decision (the whole-list scan made thousands)`);
  }
});

// ---------------------------------------------------------------------------------------------- ar-7: decision log v2, rate limits, retention
test("ar-7: agents.jsonl is a closed schema (v:2, 20 fields) and no body, header value, key or prompt reaches any log", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  const r = sub(HAIKU, { agent: "sch@session-1", tag: "evil\n\"quote" + "x".repeat(300), headers: { authorization: "Bearer TOPSECRETVALUE", "x-extra": "HEADERVALUE", "x-claude-code-parent-agent-id": "par-1" } });
  r.body.system = "SYSTEMTEXT"; r.body.messages = [{ role: "user", content: "MESSAGETEXT" }];
  await e.route(r, { Providers: [...CFG.Providers, { name: "k", models: ["m"], api_key: "KEYMATERIAL" }] }, {});
  await e.route(sub("nowhere/x", { agent: "sch2" }), CFG, {});
  const a = e.lines("agents.jsonl");
  const CLOSED = ["act", "aid", "asked", "canary", "flags", "main", "ms", "path", "ph", "pid8", "pol", "ret", "sid", "t", "tag", "tc", "v", "w", "why", "would"];
  assert.equal(a.length, 2);
  for (const l of a) {
    assert.deepEqual(Object.keys(l).sort(), CLOSED, "exactly the closed field set");
    assert.equal(l.v, 2); assert.equal(l.path, "new"); assert.equal(l.w, process.pid.toString(36)); assert.equal(l.pol, "enforce"); assert.ok(Number.isFinite(Date.parse(l.t)));
    assert.ok(l.sid.length <= 8 && (l.aid === null || l.aid.length <= 12) && (l.pid8 === null || l.pid8.length <= 8));
  }
  assert.equal(a[0].tag, "?", "a hostile tag is ?");
  const text = e.files().map((f) => fs.readFileSync(path.join(e.state, f), "utf8")).join("\n");
  for (const needle of ["TOPSECRETVALUE", "HEADERVALUE", "SYSTEMTEXT", "MESSAGETEXT", "KEYMATERIAL", "evil\\n"]) assert.ok(!text.includes(needle), needle);
  const d = e.lines("decisions.jsonl"), c = e.lines("classify.jsonl");
  assert.ok(d.every((l) => typeof l.w === "string" && "aid" in l), "decisions carry w and aid");
  assert.ok(c.every((l) => "aid" in l && "pid8" in l), "classify carries aid and pid8");
});

test("ar-7 REGRESSION: a flood (10,000 requests inside one second of seam time) writes about 250 lines per log (burst 200, then 50 a second; agents.jsonl 20 a second), counts logDropped, and every answer is still right", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  await learn(e, SONNET);
  for (let i = 0; i < 10000; i++) { e.tick(0.1); assert.equal(await e.route(sub("nowhere/x", { agent: `f${i}` }), CFG, {}), "nowhere/x"); }
  const d = e.lines("decisions.jsonl").length, c = e.lines("classify.jsonl").length, a = e.lines("agents.jsonl").length;
  assert.ok(d >= 240 && d <= 262, `decisions.jsonl ${d} lines`);
  assert.ok(c >= 240 && c <= 262, `classify.jsonl ${c} lines`);
  assert.ok(a >= 212 && a <= 226, `agents.jsonl ${a} lines`);
  assert.ok(e.counters().logDropped > 9000, `logDropped ${e.counters().logDropped}`);
  e.tick(1000);                                                                         // a quiet second refills the bucket: logging resumes
  await e.route(sub("nowhere/x", { agent: "after-flood" }), CFG, {});
  assert.equal(e.lines("agents.jsonl").at(-1).aid, "after-flood");
});

test("ar-7: RETENTION: a 100-turn agent's first decision stays in agents.jsonl however decisions.jsonl rotates; decisions.jsonl keeps the first sticky hit and one in 50; agents.jsonl rotates at 1 MiB with 3 generations", async () => {
  const e = env(ENFORCE(), { slot: null });
  for (let turn = 0; turn < 100; turn++) { e.tick(1000); await e.route(sub("nowhere/x", { agent: "long1" }), CFG, {}); }
  assert.equal(e.lines("decisions.jsonl").filter((l) => l.act === "sticky").length, 2, "99 hits: logged at hit 1 and hit 50");
  assert.equal(e.lines("agents.jsonl").filter((l) => l.aid === "long1").length, 1, "one line for the agent, however many turns");
  fs.writeFileSync(path.join(e.state, "decisions.jsonl"), "x".repeat(1024 * 1024 + 1) + "\n");
  for (let i = 0; i < 60; i++) { e.tick(100); await e.route(sub("nowhere/x", { agent: `other${i}` }), CFG, {}); }
  assert.ok(fs.existsSync(path.join(e.state, "decisions.1.jsonl")), "decisions rotated");
  assert.equal(e.lines("agents.jsonl").find((l) => l.aid === "long1")?.path, "new", "and the first decision of the 100-turn agent is still there");
  const agentsFile = path.join(e.state, "agents.jsonl");
  for (let round = 1; round <= 4; round++) {
    fs.writeFileSync(agentsFile, "x".repeat(1024 * 1024 + 1) + "\n");
    for (let i = 0; i < 60; i++) { e.tick(100); await e.route(sub("nowhere/x", { agent: `rot${round}-${i}` }), CFG, {}); }
  }
  const gens = e.files().filter((f) => /^agents(\.\d)?\.jsonl$/.test(f)).sort();
  assert.deepEqual(gens, ["agents.1.jsonl", "agents.2.jsonl", "agents.3.jsonl", "agents.jsonl"], "the current file and three generations, never a fourth");
  assert.ok(fs.statSync(agentsFile).size < 1024 * 1024);
});

test("ar-7: a short write is terminated with a newline (the next line starts clean) and counted; an open failure silences the logs for 30 s and then logging resumes; a torn line never stops a reader that skips unparsable lines", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  let short = 1, opens = 0, failOpen = false;
  e.route.__test.fs = { ...fs,
    writeSync: (fd, line, ...rest) => { if (typeof line === "string" && line.includes('"v":2') && short-- > 0) { fs.writeSync(fd, line.slice(0, 12)); return 12; } return fs.writeSync(fd, line, ...rest); },
    openSync: (f, ...a) => { opens += 1; if (failOpen) throw Object.assign(new Error("EPERM"), { code: "EPERM" }); return fs.openSync(f, ...a); } };
  await e.route(sub("nowhere/x", { agent: "s1a" }), CFG, {});
  await e.route(sub("nowhere/x", { agent: "s1b" }), CFG, {});
  const raw = fs.readFileSync(path.join(e.state, "agents.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(raw.length, 2); assert.throws(() => JSON.parse(raw[0])); assert.equal(JSON.parse(raw[1]).aid, "s1b", "the line after the torn one parses");
  assert.equal(e.counters().logDropped, 1);
  const lines = (f) => fs.readFileSync(path.join(e.state, f), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  assert.equal(lines("agents.jsonl").length, 1, "a skipping reader loses only the torn line");
  // open failure: 30 s of silence, then it tries again
  e.route.__test.reset(); failOpen = true; opens = 0;
  await e.route(sub("nowhere/x", { agent: "o1" }), CFG, {});
  const afterFirst = opens;
  assert.ok(afterFirst >= 1);
  for (let i = 0; i < 5; i++) { e.tick(1000); await e.route(sub("nowhere/x", { agent: `o${i + 2}` }), CFG, {}); }
  assert.equal(opens, afterFirst, "no open attempt inside the 30 s of silence");
  assert.ok(e.counters().logDropped >= 5);
  failOpen = false; e.tick(30000);
  await e.route(sub("nowhere/x", { agent: "o-back" }), CFG, {});
  assert.equal(lines("agents.jsonl").at(-1).aid, "o-back", "logging resumed");
});

// ---------------------------------------------------------------------------------------------- ar-8: version negotiation and integrity
test("ar-8 REGRESSION: minRouter above the router's version returns state newer: asked is served, POLICY_NEWER is raised, policyBad counts it, the headline says so; minRouter at or below it is routed normally", async () => {
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: ROWS, minRouter: 99 }), { slot: null });
  await learn(e, SONNET);
  assert.equal(await e.route(sub("nowhere/x", { agent: "n1" }), CFG, {}), "nowhere/x", "asked");
  assert.equal(e.counters().policyBad, 2);
  const st = e.status();
  assert.ok(st.warnings.some((w) => w.code === "POLICY_NEWER"));
  assert.equal(st.policy.state, "newer"); assert.match(st.policy.headline, /^POLICY NEWER: .*router v99/);
  assert.equal(st.routerVersion, 2);
  for (const v of [1, 2]) {
    const ok = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: ROWS, minRouter: v }), { slot: null });
    assert.notEqual(await ok.route(sub("nowhere/x", { agent: "n1" }), CFG, {}), "nowhere/x", `minRouter ${v} routes`);
  }
});

test("ar-8 REGRESSION: the router recomputes the content hash on a cache miss: a hand-edited hashed field is state hash (asked, POLICY_HASH); what is outside the hash may change freely; the hash round-trips the compiler for 24 owner variants", async () => {
  const sub1 = () => sub("nowhere/x", { agent: "h1" });
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  assert.notEqual(await e.route(sub1(), CFG, {}), "nowhere/x");
  const good = JSON.parse(fs.readFileSync(e.policyFile, "utf8"));
  const state = async (obj) => { e.setPolicy(typeof obj === "string" ? obj : JSON.stringify(obj)); e.route.__test.reset(); await learn(e, SONNET, "s1"); await e.route(sub("nowhere/x", { agent: `h${Math.random()}` }), CFG, {}); return e.status().policy.state; };
  assert.equal(await state(good), "ok");
  const edit = (f) => { const c = structuredClone(good); f(c); return c; };
  for (const [name, f] of [["a row's ctx", (c) => { c.models[0].c += 1; }], ["owner.mode", (c) => { c.owner.mode = "free"; }], ["a list", (c) => { c.lists.all = [0]; }], ["ctxHints", (c) => { c.ctxHints.x = 1; }],
    ["exempt", (c) => { c.exempt = [HAIKU]; }], ["tiers", (c) => { c.tiers.zz = "free"; }], ["owner.banded", (c) => { c.owner.banded = false; }]]) {
    assert.equal(await state(edit(f)), "hash", `${name}: a hashed field edited by hand`);
  }
  assert.ok(e.status().warnings.some((w) => w.code === "POLICY_HASH"));
  assert.equal(await e.route(sub("nowhere/x", { agent: "h-after" }), CFG, {}), "nowhere/x", "state hash serves asked");
  for (const [name, f] of [["compiledAt", (c) => { c.compiledAt = "2030-01-01T00:00:00.000Z"; }], ["owner.enforcement", (c) => { c.owner.enforcement = "shadow"; }], ["owner.classLog", (c) => { c.owner.classLog = "off"; }],
    ["owner.handoffNotice", (c) => { c.owner.handoffNotice = false; }], ["rollout", (c) => { c.rollout = { canaryPct: 10, salt: "q" }; }], ["builtFrom", (c) => { c.builtFrom.x = 1; }], ["counts", (c) => { c.counts.allowed = 7; }],
    ["inject text", (c) => { c.inject.all = "other text"; }], ["gate", (c) => { c.gate = { code: "X" }; }], ["an unknown top-level field", (c) => { c.zzz = { deep: [1, 2, 3] }; }]]) {
    assert.equal(await state(edit(f)), "ok", `${name}: outside the hash, ignored`);
  }
  // the round trip: compile -> serialise -> parse -> the router accepts it, for owner variants of the fixture trio
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const dir = mkTmp("uw-hash-");
  const p = LIB.resolvePaths(fixtureFlagMap(dir)), g = await LIB.gatherInputs(p);
  let n = 0;
  for (const source of ["same-provider", "all-providers"]) for (const mode of ["dynamic", "free", "inherit"]) for (const banded of [true, false]) for (const enforcement of ["shadow", "enforce"]) {
    const { compiled } = LIB.compile(g, { ...LIB.OWNER_DEFAULTS, source, mode, banded, enforcement, ...(mode === "free" ? { freeScope: "providers" } : {}) });
    const parsed = JSON.parse(JSON.stringify(compiled) + "\n");
    assert.equal(LIB.hashOf(parsed), compiled.contentHash, `${source}/${mode}/${banded}/${enforcement}: the hash survives serialisation`);
    assert.equal(await state(parsed), "ok", `${source}/${mode}/${banded}/${enforcement}: the router verifies the compiler's hash`);
    n += 1;
  }
  assert.equal(n, 24);
});

test("ar-8 REGRESSION: a same-size swap whose mtime is restored is still detected, through the inode in the cache key", async () => {
  const mk = (label) => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "shadow" }, rows: ROWS, hash: label });
  const A = mk("hhhhhhhhhh1"), B = mk("hhhhhhhhhh2");
  assert.equal(JSON.stringify(A).length, JSON.stringify(B).length, "the same size");
  const e = env(A, { slot: null });
  await e.route(sub("nowhere/x", { agent: "i1" }), CFG, {});
  assert.equal(e.status().policy.contentHash, A.contentHash);
  const st = fs.statSync(e.policyFile);
  const tmp = `${e.policyFile}.swap`;
  fs.writeFileSync(tmp, JSON.stringify(B));
  fs.utimesSync(tmp, st.atime, st.mtime);                                              // the old mtime, restored
  fs.renameSync(tmp, e.policyFile);
  assert.equal(fs.statSync(e.policyFile).mtimeMs, st.mtimeMs); assert.equal(fs.statSync(e.policyFile).size, st.size);
  assert.notEqual(fs.statSync(e.policyFile).ino, st.ino, "a different inode");
  await e.route(sub("nowhere/x", { agent: "i2" }), CFG, {});
  assert.equal(e.status().policy.contentHash, B.contentHash, "the swapped file was read");
});

// ---------------------------------------------------------------------------------------------- ar-9: main staleness across workers
test("ar-9 REGRESSION: another worker learns a newer main: within 5 s this worker keeps its own, after 5 s one stat finds the newer file and the decision follows it; an OLDER file never replaces a newer memory entry", async () => {
  const e = env(ENFORCE({ source: "same-provider" }), { slot: null });
  await learn(e, SONNET);
  const first = await e.route(sub("nowhere/x", { agent: "m1" }), CFG, {});
  assert.match(first, /^anthropic\//);
  await e.drain();
  const T = Date.parse("2026-10-03T12:00:00.000Z"), file = path.join(e.state, "main-s1.json");
  const other = (model, t) => { fs.writeFileSync(file, JSON.stringify({ model, beta1m: false, t: new Date(t).toISOString() })); const m = new Date(Date.now() + env.bump++ * 1000); fs.utimesSync(file, m, m); };
  other("groq/g1", T + 1000);                                                          // worker B learned groq at T + 1 s
  e.tick(3000);
  assert.match(await e.route(sub("nowhere/x", { agent: "m2" }), CFG, {}), /^anthropic\//, "inside 5 s of the last check: memory only, no IO");
  e.tick(2100);
  assert.match(await e.route(sub("nowhere/x", { agent: "m3" }), CFG, {}), /^groq\//, "after 5 s the newer file wins");
  other("cohere/c1", T - 60000);                                                       // an OLDER entry written later
  e.tick(6000);
  assert.match(await e.route(sub("nowhere/x", { agent: "m4" }), CFG, {}), /^groq\//, "an older t never replaces a newer memory entry");
});

// ---------------------------------------------------------------------------------------------- ar-10: rollout field (inert) and hash hygiene
test("ar-10: rollout.canaryPct 30 enforces 28-32% of 10,000 synthetic agents, stable per agent id; a canary-out agent is handled as shadow (asked, canary 0, would logged, never stored); at 100, absent, or above 100 every agent is enforced", async () => {
  const mk = (rollout) => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: ROWS, rollout });
  const enforcedSet = async (rollout, n = 10000) => {
    const e = env(mk(rollout), { slot: null });
    const set = new Set();
    for (let i = 0; i < n; i++) { e.tick(10); if ((await e.route(sub("nowhere/x", { agent: `ag${i}`, sid: `k${i % 100}` }), CFG, {})) !== "nowhere/x") set.add(i); }
    return { set, e };
  };
  const a = await enforcedSet({ canaryPct: 30, salt: "s1" });
  const frac = a.set.size / 10000;
  assert.ok(frac >= 0.28 && frac <= 0.32, `${(frac * 100).toFixed(2)}% enforced of 10,000 agents at a target of 30%`);
  const b = await enforcedSet({ canaryPct: 30, salt: "s1" }, 3000);
  for (let i = 0; i < 3000; i++) assert.equal(b.set.has(i), a.set.has(i), `agent ${i}: the same decision in a fresh router`);
  const c = await enforcedSet({ canaryPct: 30, salt: "other" }, 3000);
  assert.ok([...c.set].some((i) => !a.set.has(i)), "a different salt re-draws the split");
  // a canary-out agent: shadow handling, nothing stored
  const e = env(mk({ canaryPct: 30, salt: "s1" }), { slot: null });
  for (let i = 0; i < 100; i++) { e.tick(100); await e.route(sub("nowhere/x", { agent: `ag${i}`, sid: `k${i}` }), CFG, {}); }
  const outAgents = [...Array(100).keys()].filter((i) => !a.set.has(i)), inAgents = [...Array(100).keys()].filter((i) => a.set.has(i));
  assert.ok(outAgents.length > 0 && inAgents.length > 0);
  for (const i of outAgents) assert.equal(globalThis.__uwSub.agent.has(`k${i}:ag${i}`), false, `agent ${i} (canary-out) is never stored sticky`);
  for (const i of inAgents) assert.equal(globalThis.__uwSub.agent.has(`k${i}:ag${i}`), true);
  const lines = e.lines("agents.jsonl");
  const outLine = lines.find((l) => l.aid === `ag${outAgents[0]}`), inLine = lines.find((l) => l.aid === `ag${inAgents[0]}`);
  assert.deepEqual([outLine.canary, outLine.pol, outLine.ret, typeof outLine.would], [0, "shadow", "nowhere/x", "string"], "canary 0, returned asked, and what it WOULD do is logged");
  assert.deepEqual([inLine.canary, inLine.pol], [1, "enforce"]);
  // inert
  for (const ro of [undefined, { canaryPct: 100, salt: "x" }, { canaryPct: 250, salt: "x" }]) assert.equal((await enforcedSet(ro, 300)).set.size, 300, `rollout ${JSON.stringify(ro)}: everyone enforced`);
  assert.equal((await enforcedSet({ canaryPct: -5, salt: "x" }, 300)).set.size, 0, "clamped to 0: nobody");
});

test("ar-10: enforcement, classLog and handoffNotice are OUTSIDE the hash, so flipping them leaves the contentHash and the injected marker text byte-identical; canaryPct (rollout) and minRouter never enter it; banded and mode do", async () => {
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const dir = mkTmp("uw-ro-");
  const p = LIB.resolvePaths(fixtureFlagMap(dir)), g = await LIB.gatherInputs(p);
  const base = { ...LIB.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", inject: "on" };
  const ref = LIB.compile(g, base).compiled;
  for (const flip of [{ enforcement: "enforce" }, { classLog: "off" }, { handoffNotice: false }, { enforcement: "enforce", classLog: "off", handoffNotice: false }]) {
    const c = LIB.compile(g, { ...base, ...flip }).compiled;
    assert.equal(c.contentHash, ref.contentHash, `${JSON.stringify(flip)}: the hash does not move`);
    assert.equal(JSON.stringify(c.inject), JSON.stringify(ref.inject), `${JSON.stringify(flip)}: the injected text is byte-identical`);
    assert.ok(c.inject.all.includes(`[uw-subagent-policy v1 ${ref.contentHash}]`), "the marker line carries the unchanged hash");
    assert.notEqual(JSON.stringify(c.owner), JSON.stringify(ref.owner), "yet the owner block the router reads did change");
  }
  assert.equal(LIB.hashOf({ ...ref, rollout: { canaryPct: 10, salt: "z" }, minRouter: 9 }), ref.contentHash, "rollout and minRouter are outside the hash");
  assert.notEqual(LIB.compile(g, { ...base, banded: false }).compiled.contentHash, ref.contentHash, "banded is routing content");
  assert.notEqual(LIB.compile(g, { ...base, mode: "free" }).compiled.contentHash, ref.contentHash);
  assert.deepEqual(ref.rollout, { canaryPct: 100, salt: "uw-r1" }); assert.equal(ref.minRouter, LIB.MIN_ROUTER);
  // the router's own copy of the two lists equals the compiler's
  assert.ok(SRC.includes(`const HASH_KEYS = ${JSON.stringify(LIB.HASH_KEYS).replace(/","/g, '", "')};`), "HASH_KEYS");
  assert.ok(SRC.includes(`const HASH_OWNER_EXCLUDE = ${JSON.stringify(LIB.HASH_OWNER_EXCLUDE).replace(/","/g, '", "')};`), "HASH_OWNER_EXCLUDE");
});

// ---------------------------------------------------------------------------------------------- ar-15 and ar-16
test("ar-15: the tools scan is capped at 1,024 entries with an exact-spelling fast path: a 100,000-entry tools array is routed in milliseconds; an Agent tool beyond the cap is not seen (the documented ceiling)", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers" }), { slot: null });
  const big = (at) => { const t = Array.from({ length: 100000 }, (_, i) => ({ name: `tool${i}` })); t[at] = { name: "Agent", description: "spawn" }; return t; };
  const run = async (tools, sid) => { const t0 = process.hrtime.bigint(); await e.route({ body: { model: SONNET, tools }, headers: { "x-claude-code-session-id": sid }, sessionId: sid }, CFG, {}); return Number(process.hrtime.bigint() - t0) / 1e6; };
  const ms = await run(big(3), "big1");
  assert.ok(ms < 100, `a 100,000-entry tools array took ${ms.toFixed(1)} ms`);
  assert.ok(globalThis.__uwSub.main.has("big1"), "an Agent tool inside the scan cap is found");
  await run(big(99999), "big2");
  assert.ok(!globalThis.__uwSub.main.has("big2"), "beyond the cap it is not seen: a main request that only looks like a plain one");
  for (const [name, found] of [["Agent", 1], ["Task", 1], ["agent", 1], ["task", 1], ["AGENT", 1], ["TaSk", 1], ["aGeNt", 1], ["Agents", 0], ["Tasks", 0], ["agentx", 0], ["ta", 0], ["", 0]]) {
    const sid = `sp${name}${found}`.replace(/[^A-Za-z0-9]/g, "_").toLowerCase();
    await e.route({ body: { model: SONNET, tools: [{ name }] }, headers: { "x-claude-code-session-id": sid }, sessionId: sid }, CFG, {});
    assert.equal(globalThis.__uwSub.main.has(sid), found === 1, `tool name ${JSON.stringify(name)}`);
  }
  await e.route({ body: { model: SONNET, tools: [{ type: "function", function: { name: "task" } }] }, headers: { "x-claude-code-session-id": "oa1" }, sessionId: "oa1" }, CFG, {});
  assert.ok(globalThis.__uwSub.main.has("oa1"), "an OpenAI-shaped function.name");
});

test("ar-15: lists.all is stored as null when it is the identity and the router reads it by index; a null list over zero rows is the empty set", async () => {
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const dir = mkTmp("uw-all-");
  const p = LIB.resolvePaths(fixtureFlagMap(dir)), g = await LIB.gatherInputs(p);
  const all = LIB.compile(g, { ...LIB.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" }).compiled;
  assert.equal(all.lists.all, null, "all-providers: the identity list is not stored");
  assert.ok(all.models.length > 3);
  const same = LIB.compile(g, { ...LIB.OWNER_DEFAULTS, source: "same-provider", mode: "dynamic" }).compiled;
  assert.deepEqual(same.lists.all, [], "same-provider keeps its empty array");
  assert.ok(Object.keys(same.lists.prov).length > 0 && Object.keys(all.lists.prov).length > 0, "prov for every source");
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [], all: null, empty: true }), { slot: null });
  assert.equal(await e.route(sub(HAIKU, { agent: "z1" }), CFG, {}), HAIKU);
  assert.equal(e.counters().emptySet, 1, "null over zero rows is the empty set, not an error");
  assert.equal(e.counters().error ?? 0, 0);
});

test("ar-16: TIME: the default clock is monotonic (a faked Date.now does not move it); +7 h expires sticky and main, -2 h neither expires nor revives anything; a persisted time more than 5 minutes ahead counts as now", async () => {
  const dir = mkTmp("uw-clock-");
  fs.mkdirSync(path.join(dir, "spike"));
  fs.copyFileSync(NEXT, path.join(dir, "spike", "uw-router.cjs"));
  const fresh = req$(path.join(dir, "spike", "uw-router.cjs"));
  fresh.__test.reset();
  const before = fresh.__test.now(), real = Date.now;
  Date.now = () => real() + 86400000;
  try { assert.ok(Math.abs(fresh.__test.now() - real()) < 2000, "the router's clock ignores a wall-clock jump of a day"); } finally { Date.now = real; }
  assert.ok(fresh.__test.now() >= before);
  fresh.__test.reset();
  // +7 h
  const e = env(ENFORCE({ source: "same-provider" }), { slot: null });
  await learn(e, SONNET);
  const first = await e.route(sub("nowhere/x", { agent: "k1" }), CFG, {});
  e.tick(7 * 3600 * 1000);
  await e.route(sub("nowhere/x", { agent: "k1" }), CFG, {});
  assert.equal(e.counters().stickyHit, 0, "+7 h: the entry expired");
  assert.equal(e.counters().unknownMain, 1, "and so did main: unknown main, asked served");
  // -2 h after a fresh learn: nothing expires, nothing breaks
  await learn(e, SONNET);
  const second = await e.route(sub("nowhere/x", { agent: "k2" }), CFG, {});
  assert.match(second, /^anthropic\//);
  e.tick(-2 * 3600 * 1000);
  assert.equal(await e.route(sub("nowhere/x", { agent: "k2" }), CFG, {}), second, "-2 h: the entry is still there (no negative age)");
  assert.match(await e.route(sub("nowhere/x", { agent: "k3" }), CFG, {}), /^anthropic\//, "and main is still known");
  void first;
  // a main file stamped three days ahead is clamped to now: it expires 6 h later, not in three days
  const f = env(ENFORCE({ source: "same-provider" }), { slot: null });
  fs.writeFileSync(path.join(f.state, "main-s1.json"), JSON.stringify({ model: SONNET, beta1m: false, t: new Date(Date.parse("2026-10-03T12:00:00.000Z") + 3 * 86400000).toISOString() }));
  assert.match(await f.route(sub("nowhere/x", { agent: "c1" }), CFG, {}), /^anthropic\//, "a future-stamped main is read");
  f.tick(6 * 3600 * 1000 + 1000);
  assert.equal(await f.route(sub("nowhere/x", { agent: "c2" }), CFG, {}), "nowhere/x", "but counts from now, so it is stale 6 h later");
  // the same for a journal entry
  const g = env(ENFORCE(), { slot: null });
  fs.writeFileSync(path.join(g.state, "agents-s1.jsonl"), JSON.stringify({ k: "j1", m: "groq/g1", t: Date.parse("2026-10-03T12:00:00.000Z") + 3 * 86400000, h: "x" }) + "\n");
  assert.equal(await g.route(sub("nowhere/x", { agent: "j1" }), CFG, {}), "groq/g1", "a future-stamped journal entry replays");
  g.tick(6 * 3600 * 1000 + 1000);
  await g.route(sub("nowhere/x", { agent: "j1" }), CFG, {});
  assert.equal(g.counters().stickyHit, 1, "and expires on schedule instead of living for three days");
});

// ---------------------------------------------------------------------------------------------- tripwire and headline
// an error raised AFTER the request-parse prefix (the tag read in the subagent path): only such errors count toward the tripwire (S-F1)
const errReq = () => ({ body: { model: OPUS, tools: [{ name: "Read" }] }, headers: { "x-claude-code-agent-id": "err" }, get builtInSubagentModel() { throw new RangeError("boom"); } });
const flagOf = (e) => { try { return fs.readFileSync(path.join(e.state, "shadow.flag"), "utf8"); } catch { return null; } };
test("tripwire: five router errors inside 60 s during the first 200 enforced requests write shadow.flag `auto:ERRORS:<iso>`, asked is returned from then on, AUTO_ROLLBACK and the headline say so, `show` renders it, only removing the flag re-arms", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  for (let i = 0; i < 3; i++) assert.notEqual(await e.route(sub("nowhere/x", { agent: `w${i}` }), CFG, {}), "nowhere/x");
  for (let i = 0; i < 4; i++) { e.tick(1000); assert.equal(await e.route(errReq(), CFG, {}), OPUS); }
  assert.equal(flagOf(e), null, "four errors do not trip");
  e.tick(1000);
  assert.equal(await e.route(errReq(), CFG, {}), OPUS, "the fifth still returns asked");
  const flag = flagOf(e);
  assert.match(flag, /^auto:ERRORS:\d{4}-\d\d-\d\dT[\d:.]+Z\n$/, "the flag content is auto:<code>:<iso>");
  assert.equal(e.counters().autoRollback, 1);
  assert.equal(await e.route(sub("nowhere/x", { agent: "after" }), CFG, {}), "nowhere/x", "asked, from the next request on");
  const st = e.status();
  const w = st.warnings.find((x) => x.code === "AUTO_ROLLBACK");
  assert.ok(w && /^ERRORS /.test(w.detail));
  assert.match(st.policy.headline, /^AUTO-ROLLBACK \(ERRORS at \S+\): the router paused itself/);
  const out = [], err = [];
  const code = await LIB.runSubagentPolicy(["show", "--policy-file", path.join(e.dir, "owner.json"), "--state-dir", path.dirname(e.state)], { out: (l) => out.push(l), err: (l) => err.push(l) });
  assert.equal(code, 0, err.join("\n"));
  assert.ok(out.some((l) => /^AUTO-ROLLBACK \(ERRORS at \S+\): the router paused itself/.test(l)), out.join("\n"));
  assert.ok(out.some((l) => /AUTO-ROLLBACK \(ERRORS at/.test(l) && /^  /.test(l)), "and the status headline is shown");
  // only an explicit set (removing the flag) re-arms, with a fresh window
  fs.rmSync(path.join(e.state, "shadow.flag"));
  assert.notEqual(await e.route(sub("nowhere/x", { agent: "again" }), CFG, {}), "nowhere/x", "enforcing again");
  for (let i = 0; i < 5; i++) { e.tick(1000); await e.route(errReq(), CFG, {}); }
  assert.equal(e.counters().autoRollback, 2, "a new window can trip again");
});

test("tripwire, the case it must not break: errors spread over more than 60 s, errors after the 200-request window, and errors in shadow do not trip", async () => {
  const spread = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 8; i++) { spread.tick(20000); await spread.route(errReq(), CFG, {}); }
  assert.equal(flagOf(spread), null, "8 errors, but never 5 inside 60 s");
  const late = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 200; i++) { late.tick(10); await late.route(sub("nowhere/x", { agent: `l${i}`, sid: `q${i % 10}` }), CFG, {}); }
  for (let i = 0; i < 6; i++) { late.tick(100); await late.route(errReq(), CFG, {}); }
  assert.equal(flagOf(late), null, "past the first 200 enforced requests the watch is over");
  const sh = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  await sh.route(sub("nowhere/x", { agent: "s" }), CFG, {});
  for (let i = 0; i < 6; i++) { sh.tick(100); await sh.route(errReq(), CFG, {}); }
  assert.equal(flagOf(sh), null, "shadow changes nothing, so there is nothing to roll back");
  assert.equal(sh.counters().error, 6);
});

test("tripwire: an aux or exempt request about to leave with a model other than its own trips INVARIANT (fault-injected through a patched COPY of the router: production bytes carry no tamper hook, R18), returns asked, and the flag is the one rollback writes", async () => {
  for (const [mode, mkReq] of [["dynamic", () => aux(HAIKU, { agent: "x1" })], ["inherit", () => sub(HAIKU, { agent: "x2" })]]) {
    const e = env(mkPolicy({ owner: { mode, source: "all-providers", enforcement: "enforce" }, rows: ROWS, exempt: [HAIKU] }), { slot: null, file: patchedRouter(TAMPER) });
    await learn(e, SONNET);
    globalThis.__uwTamper = (cls, ret) => (cls === "aux" || cls === "exempt" ? "evil/model" : ret);
    try { assert.equal(await e.route(mkReq(), CFG, {}), HAIKU, `${mode}: asked, never the tampered answer`); } finally { delete globalThis.__uwTamper; }
    assert.match(flagOf(e), /^auto:INVARIANT:/, mode);
    assert.ok(e.status().warnings.some((w) => w.code === "AUTO_ROLLBACK"));
  }
  const clean = env(ENFORCE(), { slot: null });
  assert.equal(await clean.route(aux(HAIKU, { agent: "x" }), CFG, {}), HAIKU);
  assert.equal(flagOf(clean), null, "no tamper, no trip");
});

test("headline: one plain sentence for every state, computed by the router on its flush", async () => {
  const none = env(null, { slot: null });
  none.route.__test.flush();
  assert.match(JSON.parse(fs.readFileSync(path.join(none.state, "status.json"), "utf8")).policy.headline, /^policy absent: /);
  const sh = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  await sh.route(sub("nowhere/x", { agent: "a" }), CFG, {});
  assert.equal(sh.status().policy.headline, "SHADOW: logging only, no subagent is changed");
  const en = env(ENFORCE(), { slot: null });
  await en.route(sub("nowhere/x", { agent: "a" }), CFG, {});
  assert.equal(en.status().policy.headline, "ENFORCING: subagents may run on policy models");
  fs.writeFileSync(path.join(en.state, "shadow.flag"), `${new Date().toISOString()}\n`);
  await en.route(sub("nowhere/x", { agent: "b" }), CFG, {});
  assert.match(en.status().policy.headline, /^PAUSED \(shadow\.flag\): /);
  const bad = env("{nope", { slot: null });
  await bad.route(sub(HAIKU), CFG, {});
  assert.match(bad.status().policy.headline, /^POLICY CORRUPT: /);
});

// ---------------------------------------------------------------------------------------------- ar-17: handoff on retry, cooling, overlay hint
const CFG5 = cfg(["groq", ["g1", "g2", "g3", "g4", "g5"]], ["cohere", ["c1"]], ["anthropic", ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-5"]]);
const gr = (n, o = {}) => row(`groq/g${n}`, { c: 200000, ...o });
// One row per PROVIDER (O3 / 6.1b E.3): two different models of one provider key failing within 5 minutes cool the provider key, and a handoff never lands on a COOLING row, so a
// test that hands one agent over several times needs candidates behind different keys.
const CFGP = cfg(["p1", ["m"]], ["p2", ["m"]], ["p3", ["m"]], ["p4", ["m"]], ["p5", ["m"]], ["groq", ["g1", "g2", "g3", "g4", "g5"]], ["anthropic", ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-5"]]);
const pr = (n, o = {}) => row(`p${n}/m`, { c: 200000, ...o });
const HPOL = (rows, o = {}, extra = {}) => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce", ...o }, rows, withProv: true, ...extra });
/** An agent id whose first decision lands on `want` under this policy (found in a scratch router, deterministic by hash). */
async function landing(policy, want, prefix = "ld", config = CFG5) {
  const t = env(policy, { slot: null });
  for (let i = 0; i < 800; i++) { if ((await t.route(sub("nowhere/x", { agent: `${prefix}${i}` }), config, {})) === want) return `${prefix}${i}`; }
  throw new Error(`no agent lands on ${want}`);
}
const retried = (agent, len, o = {}) => withMsgs(sub("nowhere/x", { agent, ...o }), len);
const agentLine = (e, act) => e.lines("agents.jsonl").filter((l) => l.act === act);

test("ar-17: retry by LENGTH (the primary live signal): the same agent and an unchanged messages length within 120 s hands the agent to a different eligible model; agents.jsonl, the journal, the counters, the sticky entry and the headline all show it", async () => {
  const e = env(HPOL([gr(1), gr(2), gr(3), gr(4)]), { slot: null });
  await learn(e, SONNET);
  const M = await e.route(retried("h1", 5), CFG5, {});
  e.tick(1000);
  const r2 = retried("h1", 5); r2.body.system = "SYS";
  const M2 = await e.route(r2, CFG5, {});
  assert.notEqual(M2, M); assert.match(M2, /^groq\/g[1-4]$/);
  const c = e.counters();
  assert.deepEqual([c.retry, c.handoff, c.handoffNone, c.handoffCap], [1, 1, 0, 0]);
  const h = agentLine(e, "handoff");
  assert.equal(h.length, 1);
  assert.deepEqual([h[0].from, h[0].to, h[0].reason, h[0].why, h[0].hop, h[0].rsrc, h[0].path, h[0].aid, h[0].aid_full], [M, M2, "retry:len:1", "retry:len:1", 1, "len", "handoff", "h1", "h1"]);
  assert.ok(Number.isFinite(Date.parse(h[0].t)));
  assert.equal(globalThis.__uwSub.agent.get("s1:h1").model, M2, "the sticky entry moved");
  const j = fs.readFileSync(path.join(e.state, "agents-s1.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([j.at(-1).m, j.at(-1).hp, j.at(-1).r, j.at(-1).x.length], [M2, 1, "handoff", 1], "a journal line with the new model, the hop and the reason");
  assert.equal(e.status().warnings.find((w) => w.code === "HANDOFF").detail.startsWith(`${M} -> ${M2} at `), true);
  assert.match(e.status().policy.headline, new RegExp(`^ENFORCING: .*; HANDOFF: 1 in the last hour \\(latest ${M.replace("/", "\\/")} -> ${M2.replace("/", "\\/")}\\)$`));
  e.tick(1000);
  assert.equal(await e.route(retried("h1", 7), CFG5, {}), M2, "the next turn (the transcript grew) stays on the new model");
  assert.equal(e.counters().handoff, 1);
  e.tick(61 * 60 * 1000);
  e.status();
  assert.ok(!e.status().warnings.some((w) => w.code === "HANDOFF"), "the HANDOFF warning clears after an hour");
});

test("ar-17 + S-F3/D6: the retry HEADER acts only for a billing-only subagent (no agent id): reason retry:hdr:<n> (clamped to 20); for an agent WITH an id the header alone is ignored and only the unchanged messages length counts", async () => {
  const e = env(HPOL([gr(1), gr(2), gr(3), gr(4)]), { slot: null });
  // an agent with an id: a forged header on a growing transcript is NOT a retry, however large
  await e.route(retried("x1", 5), CFG5, {});
  for (const [len, v] of [[7, "0"], [9, "3"], [11, "99"], [13, "1"]]) { e.tick(1000); await e.route(retried("x1", len, { headers: { "x-stainless-retry-count": v } }), CFG5, {}); }
  e.tick(1000); await e.route(retried("x1", 3), CFG5, {});                                      // a compaction shrinks the transcript
  e.tick(121 * 1000); await e.route(retried("x1", 3), CFG5, {});                                // the same length, but 121 s later
  assert.equal(e.counters().retry, 0); assert.equal(e.counters().handoff, 0); assert.equal(e.counters().retryHdr, 0, "the header was never acted on for an agent with an id");
  // both at once for an agent with an id: the length fires, and is the source
  e.tick(1000); await e.route(retried("x2", 4), CFG5, {});
  e.tick(1000); await e.route(retried("x2", 4, { headers: { "x-stainless-retry-count": "3" } }), CFG5, {});
  assert.equal(agentLine(e, "handoff").at(-1).rsrc, "len"); assert.equal(e.counters().retryLen, 1); assert.equal(e.counters().retryHdr, 0);
  // a billing-only subagent: the header is the only signal, and an unchanged length is NOT one
  const b = env(HPOL([pr(1), pr(2), pr(3), pr(4)]), { slot: null });
  const bl = (len, v) => retried("nobody", len, { noAgent: true, ...(v === undefined ? {} : { headers: { "x-stainless-retry-count": v } }) });
  await b.route(bl(5), CFGP, {});
  b.tick(1000); await b.route(bl(5), CFGP, {});                                                 // the same length: not a retry without an id
  b.tick(1000); await b.route(bl(7, "0"), CFGP, {});
  assert.equal(b.counters().retry, 0); assert.equal(b.counters().handoff, 0);
  b.tick(1000); await b.route(bl(9, "2"), CFGP, {});
  assert.equal(b.counters().handoff, 1); assert.equal(b.counters().retryHdr, 1); assert.equal(b.counters().retryLen, 0);
  const h = agentLine(b, "handoff")[0];
  assert.deepEqual([h.reason, h.rsrc], ["retry:hdr:2", "hdr"]);
  b.tick(1000); await b.route(bl(11, "99"), CFGP, {});
  assert.equal(agentLine(b, "handoff")[1].reason, "retry:hdr:20", "clamped to 20");
});

test("ar-17: the cooling ladder (2 min, 10 min, 60 min, 6 h) with the seam clock: a failure after a cooldown escalates one rung, the 6 h rung comes on the 4th consecutive failure, failures inside a cooldown do not escalate, and the ladder starts over after the cooldown plus an hour of quiet; the state is shared through cooling.json", async () => {
  const e = env(HPOL([gr(1)]), { slot: null });
  const T = Date.parse("2026-10-03T12:00:00.000Z"), cool = () => globalThis.__uwSub.cool.get("groq/g1");
  let n = 0;
  // each failure is reported by a different session (the per-session limit of S-F3 is tested on its own): a fresh agent decides on g1, a second request with the same length is the retry
  const retry = async (atSec) => { const sid = `r${n++}`; e.setClock(T + atSec * 1000 - 500); await e.route(retried("l1", 5, { sid }), CFG5, {}); e.setClock(T + atSec * 1000); await e.route(retried("l1", 5, { sid }), CFG5, {}); };
  await retry(1);
  assert.deepEqual([cool().l, cool().n, cool().u - (T + 1000)], [0, 1, 120000], "rung 0: 2 minutes");
  assert.equal(e.counters().handoffNone, 1, "one row only: no alternative, the agent keeps its model");
  const u0 = cool().u;
  await retry(60); assert.equal(cool().u, u0, "a failure inside the cooldown changes nothing");
  const seen = [];
  for (let at = 160; at < 20000; at += 100) { const before = cool().t; await retry(at); if (cool().t !== before) seen.push([cool().l, cool().n, cool().u - cool().t]); if (seen.length === 3) break; }
  assert.deepEqual(seen, [[1, 2, 600000], [2, 3, 3600000], [3, 4, 6 * 3600000]], "10 min, 60 min, then 6 h on the 4th consecutive failure");
  await e.drain();
  const file = JSON.parse(fs.readFileSync(path.join(e.state, "cooling.json"), "utf8"));
  assert.deepEqual([file.v, file.models["groq/g1"].l, file.models["groq/g1"].n], [1, 3, 4], "shared through cooling.json");
  // quiet: past the cooldown plus an hour the ladder starts over
  const t = cool().u + 61 * 60 * 1000;
  e.setClock(t);
  await e.route(retried("l2", 5, { sid: "q1" }), CFG5, {}); e.tick(1000); await e.route(retried("l2", 5, { sid: "q1" }), CFG5, {});
  assert.deepEqual([cool().l, cool().n], [0, 1], "reset");
});

test("ar-17: a cooling model is DEMOTED, never removed: new agents avoid it while another usable row exists, a SECOND worker and NEW agents see it through cooling.json, and when every row is cooling the router still serves (flag ALL_DEMOTED)", async () => {
  const rows = [gr(1), gr(2), gr(3)], pol = () => HPOL(rows);
  const control = env(pol(), { slot: null }), landed = new Map();
  for (let i = 0; i < 60; i++) { const r = await control.route(sub("nowhere/x", { agent: `c${i}` }), CFG5, {}); landed.set(r, (landed.get(r) || 0) + 1); }
  assert.ok(landed.get("groq/g1") > 0, "without cooling, g1 gets agents");
  const victim = await landing(pol(), "groq/g1", "v");
  const e = env(pol(), { slot: null });
  await e.route(retried(victim, 5), CFG5, {}); e.tick(1000);
  assert.notEqual(await e.route(retried(victim, 5), CFG5, {}), "groq/g1");
  await e.drain();
  for (let i = 0; i < 60; i++) { e.tick(10); assert.notEqual(await e.route(sub("nowhere/x", { agent: `n${i}` }), CFG5, {}), "groq/g1", "a NEW agent avoids the cooling model"); }
  e.route.__test.reset();                                                                  // a second worker: fresh memory, the same state folder
  for (let i = 0; i < 60; i++) { e.tick(10); assert.notEqual(await e.route(sub("nowhere/x", { agent: `w${i}` }), CFG5, {}), "groq/g1", "a second worker sees cooling.json"); }
  e.tick(3 * 60 * 1000);
  const back = new Set();
  for (let i = 0; i < 60; i++) back.add(await e.route(sub("nowhere/x", { agent: `b${i}` }), CFG5, {}));
  assert.ok(back.has("groq/g1"), "after the 2-minute cooldown it is a candidate again");
  // everything cooling: still served
  const one = env(HPOL([gr(1)]), { slot: null });
  await one.route(retried("a1", 5), CFG5, {}); one.tick(1000); await one.route(retried("a1", 5), CFG5, {});
  assert.equal(await one.route(sub("nowhere/x", { agent: "fresh" }), CFG5, {}), "groq/g1", "never removed: the only row serves");
  assert.ok(one.lines("agents.jsonl").some((l) => l.flags.includes("ALL_DEMOTED")), "and says it is demoted");
});

test("ar-17: PROVIDER-KEY cooling: two different models of one provider failing within 5 minutes cool the whole provider (demotion only), the entry lives in cooling.json with the models (cap 64 keys); one model alone does not", async () => {
  const rows = [gr(1), gr(2), row("cohere/c1", { c: 200000 })], pol = () => HPOL(rows);
  const a1 = await landing(pol(), "groq/g1", "pa"), a2 = await landing(pol(), "groq/g2", "pb");
  const e = env(pol(), { slot: null });
  const fail = async (a) => { await e.route(retried(a, 5), CFG5, {}); e.tick(1000); await e.route(retried(a, 5), CFG5, {}); };
  await fail(a1);
  assert.ok(globalThis.__uwSub.cool.has("groq/g1") && !globalThis.__uwSub.cool.has("prov:groq"), "one model alone: no provider entry");
  e.tick(60 * 1000);
  await fail(a2);
  const pv = globalThis.__uwSub.cool.get("prov:groq");
  assert.ok(pv && pv.u > Date.parse("2026-10-03T12:00:00.000Z") + 60000, "two models inside 5 minutes cool the provider key");
  for (let i = 0; i < 40; i++) { e.tick(10); assert.equal(await e.route(sub("nowhere/x", { agent: `p${i}` }), CFG5, {}), "cohere/c1", "every groq model is demoted"); }
  await e.drain();
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(path.join(e.state, "cooling.json"), "utf8")).models).includes("prov:groq"));
  const only = env(HPOL([gr(1), gr(2)]), { slot: null });                                // no alternative provider: demoted rows still serve
  for (const a of [a1, a2]) { await only.route(retried(a, 5), CFG5, {}); only.tick(1000); await only.route(retried(a, 5), CFG5, {}); }
  assert.match(await only.route(sub("nowhere/x", { agent: "z" }), CFG5, {}), /^groq\//);
  // the cap: 64 keys at most
  const cap = env(HPOL([gr(1)]), { slot: null });
  await cap.route(sub("nowhere/x", { agent: "warm" }), CFG5, {});
  for (let i = 0; i < 100; i++) { cap.tick(1000); globalThis.__uwSub.cool.set(`m${i}/x`, { u: 0, l: 0, t: i, n: 1, t0: i }); }
  await cap.route(retried("c1", 5), CFG5, {}); cap.tick(1000); await cap.route(retried("c1", 5), CFG5, {});
  assert.ok(globalThis.__uwSub.cool.size <= 64, `${globalThis.__uwSub.cool.size} cooling keys`);
});

test("ar-17: the handoff respects the band and the fit on the CURRENT request: a candidate too small for the token count is skipped, the same band is used before the next one, and the next band only when the band is exhausted", async () => {
  const e = env(HPOL([gr(1, { c: 131072 }), gr(2, { c: 1000000 }), gr(3, { c: 131072 })]), { slot: null });
  const a = await landing(HPOL([gr(1, { c: 131072 }), gr(2, { c: 1000000 }), gr(3, { c: 131072 })]), "groq/g1", "fit");
  await e.route(retried(a, 5), CFG5, {}); e.tick(1000);
  const big = retried(a, 5); big.tokenCount = 200000;
  assert.equal(await e.route(big, CFG5, {}), "groq/g2", "g3's 131k window cannot hold 200k tokens: only g2 fits");
  assert.ok(e.counters().ctxSkip >= 1);
  const bands = [pr(1, { b: 0 }), pr(2, { b: 0 }), pr(3, { b: 1 })], b = await landing(HPOL(bands), "p1/m", "bd", CFGP);
  const f = env(HPOL(bands), { slot: null });
  await f.route(retried(b, 5), CFGP, {});
  f.tick(1000); assert.equal(await f.route(retried(b, 5), CFGP, {}), "p2/m", "the lead band first");
  f.tick(1000); assert.equal(await f.route(retried(b, 5), CFGP, {}), "p3/m", "g1 was left a moment ago and g2 is the one failing: the next band");
});

test("ar-17: at most 3 handoffs per agent per hour (handoffCap, the agent stays), never back to a model left in the last 30 minutes unless it is the only usable one, and handoffNone when there is no alternative", async () => {
  const rows = [1, 2, 3, 4, 5].map((n) => pr(n)), e = env(HPOL(rows), { slot: null });
  const path_ = [await e.route(retried("hc", 5), CFGP, {})];
  for (let i = 0; i < 3; i++) { e.tick(1000); path_.push(await e.route(retried("hc", 5), CFGP, {})); }
  assert.equal(new Set(path_).size, 4, "three handoffs, never back to a model it just left");
  assert.equal(e.counters().handoff, 3);
  e.tick(1000);
  assert.equal(await e.route(retried("hc", 5), CFGP, {}), path_[3], "the fourth inside the hour: capped, the agent stays");
  assert.equal(e.counters().handoffCap, 1); assert.equal(e.counters().handoff, 3);
  e.tick(61 * 60 * 1000);
  await e.route(retried("hc", 5), CFGP, {}); e.tick(1000);
  assert.notEqual(await e.route(retried("hc", 5), CFGP, {}), path_[3], "an hour later it may move again");
  assert.equal(e.counters().handoff, 4);
  // only two rows: it may go back, because it is the only usable one. The first model's 2-minute cooldown has ended by the retry window's end (120 s), so it is usable again
  const t = env(HPOL([pr(1), pr(2)]), { slot: null });
  const first = await t.route(retried("tt", 5), CFGP, {}); t.tick(1000);
  const second = await t.route(retried("tt", 5), CFGP, {}); t.tick(120000);
  const third = await t.route(retried("tt", 5), CFGP, {});
  assert.deepEqual([second !== first, third === first], [true, true], "p1 -> p2 -> p1: the only other usable row, no longer cooling");
  const lone = env(HPOL([gr(1)]), { slot: null });
  await lone.route(retried("n1", 5), CFGP, {}); lone.tick(1000);
  assert.equal(await lone.route(retried("n1", 5), CFGP, {}), "groq/g1");
  assert.equal(lone.counters().handoffNone, 1);
});

test("O3: FREE mode: a handoff never leaves the free set (no price cap, the set IS the promise): every hop stays on a free model, and when every free model is cooling the agent keeps its model (handoffNone), never a paid asked model", async () => {
  const free = [pr(1), pr(2), pr(3)];
  const e = env(mkPolicy({ owner: { mode: "free", source: "all-providers", enforcement: "enforce" }, rows: free, withProv: true }), { slot: null });
  const inSet = (m) => ["p1/m", "p2/m", "p3/m"].includes(m);
  const asked = (agent, len) => withMsgs(sub(OPUS, { agent }), len);                   // the agent ASKED for a paid model
  const seen = [await e.route(asked("fr", 5), CFGP, {})];
  for (let i = 0; i < 2; i++) { e.tick(1000); seen.push(await e.route(asked("fr", 5), CFGP, {})); }
  assert.ok(seen.every(inSet), `every model served is free: ${seen}`);
  assert.equal(new Set(seen).size, 3, "two handoffs across the three free models");
  assert.equal(e.counters().handoff, 2);
  // every free model is cooling now (the third fails too): nothing to hand off to, the agent KEEPS its current model, counted handoffNone
  e.tick(1000);
  const stay = await e.route(asked("fr", 5), CFGP, {});
  assert.equal(stay, seen[2], "kept");
  assert.equal(e.counters().handoffNone, 1); assert.equal(e.counters().handoff, 2);
  assert.ok(e.lines("agents.jsonl").every((l) => l.ret === null || inSet(l.ret) || l.act === "new" && inSet(l.ret)), "no paid model is ever returned");
  assert.ok(![...seen, stay].some((m) => /^anthropic\//.test(m)));
  // the case it must not break: a free model whose cooldown has ended is a candidate again
  e.tick(10 * 60 * 1000);
  e.tick(0);
  const back = await e.route(asked("fr", 5), CFGP, {}); e.tick(1000);
  const again = await e.route(asked("fr", 5), CFGP, {});
  assert.ok(inSet(back) && inSet(again));
});

test("O3: DYNAMIC mode with paid models: a handoff may go Haiku -> Sonnet -> Opus (no price cap, the toggles decide) and on within the set; the cap of 3 hops an hour holds", async () => {
  const rows = [row(HAIKU, { t: "v", b: 0 }), row(SONNET, { c: 1000000, t: "v", i: "$3/$15", b: 1 }), row(OPUS, { c: 1000000, p: 1, t: "v", i: "$15/$75", b: 2 }), row("groq/g1", { t: "v", b: 3 })];
  const e = env(HPOL(rows), { slot: null });
  const ag = (len) => withMsgs(sub(HAIKU, { agent: "hp" }), len);
  let len = 5;
  const turns = async (minutes) => { for (let i = 0; i < minutes; i++) { e.tick(60000); len += 2; await e.route(ag(len), CFG, {}); } };    // the agent works on: the transcript grows each minute, no retry
  const path_ = [await e.route(ag(len), CFG, {})];
  assert.equal(path_[0], HAIKU, "a new agent keeps the model it asked for (Haiku is in the set)");
  e.tick(1000); path_.push(await e.route(ag(len), CFG, {}));
  assert.equal(path_[1], SONNET, "Haiku -> Sonnet");
  await turns(6); e.tick(1000); path_.push(await e.route(ag(len), CFG, {}));                          // 6 minutes later (outside the 5-minute provider-key window): Sonnet fails
  assert.equal(path_[2], OPUS, "Sonnet -> Opus: a premium model, no price cap");
  await turns(6); e.tick(1000); path_.push(await e.route(ag(len), CFG, {}));
  assert.equal(path_[3], "groq/g1", "Opus -> the next model of the set");
  assert.equal(e.counters().handoff, 3);
  await turns(6); e.tick(1000);
  assert.equal(await e.route(ag(len), CFG, {}), "groq/g1", "the 4th hop inside the hour: capped, the agent stays");
  assert.equal(e.counters().handoffCap, 1); assert.equal(e.counters().handoff, 3);
  assert.ok(path_.every((m) => rows.some((r) => r.s === m)), "every hop stays inside the set");
});

test("O3: a COOLING main model is not a handoff target either (the shortcut to main's own model skips cooling): the agent keeps its model and handoffNone counts it; the case it must not break: a non-cooling main model IS the first choice", async () => {
  const rows = [pr(1), pr(2), pr(3)];
  const e = env(HPOL(rows), { slot: null });
  await learn(e, "p1/m");                                                                       // main is on p1/m
  seedCooling(e, { "p1/m": cool1(T0 + 3600000) });                                             // and p1/m is cooling for another hour
  e.tick(1000);
  const ask = () => withMsgs(sub("p2/m", { agent: "cm" }), 5);                                  // the agent asked for, and keeps, p2/m
  assert.equal(await e.route(ask(), CFGP, {}), "p2/m"); e.tick(1000);
  const stay = await e.route(ask(), CFGP, {});                                                  // a retry: p2/m fails; p3/m is the only non-cooling row besides it
  assert.notEqual(stay, "p1/m", "the cooling main model is not handed to");
  assert.equal(stay, "p3/m", "the next non-cooling row");
  // with p3/m cooling too, nothing is left: the agent keeps p3/m
  const f = env(HPOL([pr(1), pr(2)]), { slot: null });
  await learn(f, "p1/m"); seedCooling(f, { "p1/m": cool1(T0 + 3600000) });
  f.tick(1000);
  const ask2 = () => withMsgs(sub("p2/m", { agent: "cm" }), 5);
  assert.equal(await f.route(ask2(), CFGP, {}), "p2/m"); f.tick(1000);
  assert.equal(await f.route(ask2(), CFGP, {}), "p2/m", "main's own model is cooling: no handoff");
  assert.equal(f.counters().handoffNone, 1); assert.equal(f.counters().handoff, 0);
  // a non-cooling main model is the first choice
  const g = env(HPOL(rows), { slot: null });
  await learn(g, "p3/m"); g.tick(1000);
  const ask3 = () => withMsgs(sub("p1/m", { agent: "cm" }), 5);
  assert.equal(await g.route(ask3(), CFGP, {}), "p1/m"); g.tick(1000);
  assert.equal(await g.route(ask3(), CFGP, {}), "p3/m", "main's own model, not cooling");
});

test("O3 + D2: a handoff from a TESTED tool tier never lands on an UNTESTED one, WHATEVER the banding says (the old scan guarded it only with banding on, and never for main's own model); a plain new-agent pick with banding off is unchanged and may still land on an untested row", async () => {
  const rows = [pr(1, { t: "t" }), pr(2, { t: "t" }), pr(3, { t: "u" })];
  for (const banded of [false, true]) {
    for (const mainModel of [null, "p3/m"]) {                                                  // main's own model (untested) must not become the handoff target either
      let handoffs = 0;
      for (let i = 0; i < 30; i++) {
        const e = env(HPOL(rows, { banded }), { slot: null });
        if (mainModel) await learn(e, mainModel);
        const a = `d${i}`, ask = () => withMsgs(sub("p1/m", { agent: a }), 5), first = await e.route(ask(), CFGP, {});   // the agent asks for the tested row p1/m and keeps it
        assert.equal(first, "p1/m");
        e.tick(1000);
        const to = await e.route(ask(), CFGP, {});
        if (to !== first) { handoffs += 1; assert.notEqual(to, "p3/m", `banded ${banded}, main ${mainModel}: agent ${a} went from tested ${first} to the untested row`); }
      }
      assert.ok(handoffs >= 5, `banded ${banded}, main ${mainModel}: ${handoffs} tested-tier handoffs were exercised`);
    }
  }
  // the case it must not break: with banding off a plain new-agent pick still reaches the untested row, and a handoff FROM an untested row may go anywhere
  const landed = new Set();
  const one = env(HPOL(rows, { banded: false }), { slot: null });
  for (let i = 0; i < 60; i++) landed.add(await one.route(sub("nowhere/x", { agent: `n${i}` }), CFGP, {}));
  assert.ok(landed.has("p3/m"), "banding off: the plain pool is unchanged");
  const from = await landing(HPOL(rows, { banded: false }), "p3/m", "ut", CFGP), u = env(HPOL(rows, { banded: false }), { slot: null });
  await u.route(retried(from, 5), CFGP, {}); u.tick(1000);
  assert.match(await u.route(retried(from, 5), CFGP, {}), /^p[12]\/m$/, "from an untested row a handoff goes to a tested one");
});

test("ar-17: no handoff outside enforce on dynamic or free: shadow only LOGS would-handoff (no state, no cooling), inherit, aux and main requests ignore a retry signal", async () => {
  const sh = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }, { }), { slot: null });
  const r1 = await sh.route(retried("s1", 5), CFG, {}); sh.tick(1000); const r2 = await sh.route(retried("s1", 5), CFG, {});
  assert.deepEqual([r1, r2], ["nowhere/x", "nowhere/x"], "shadow returns asked");
  assert.equal(sh.counters().handoff, 0); assert.equal(sh.counters().handoffWould, 1);
  const w = sh.lines("decisions.jsonl").find((l) => l.act === "would-handoff");
  assert.ok(w && typeof w.would === "string" && w.why === "retry:len:1");
  assert.equal(globalThis.__uwSub.agent.size, 0); assert.equal(globalThis.__uwSub.cool.size, 0); assert.ok(!fs.existsSync(path.join(sh.state, "cooling.json")));
  const inh = env(mkPolicy({ owner: { mode: "inherit", source: "all-providers", enforcement: "enforce" }, rows: ROWS }), { slot: null });
  await learn(inh, SONNET);
  await inh.route(retried("i1", 5), CFG, {}); inh.tick(1000);
  assert.equal(await inh.route(retried("i1", 5, { headers: { "x-stainless-retry-count": "3" } }), CFG, {}), SONNET);
  assert.deepEqual([inh.counters().retry, inh.counters().handoff], [0, 0]);
  const e = env(HPOL([gr(1), gr(2)]), { slot: null });
  const hdrs = { "x-stainless-retry-count": "2" };
  assert.equal(await e.route(aux(HAIKU, { agent: "ax", headers: hdrs }), CFG5, {}), HAIKU);
  const mn = main(SONNET, { headers: hdrs }); withMsgs(mn, 5);
  await e.route(mn, CFG5, {}); e.tick(1000); await e.route(withMsgs(main(SONNET, { headers: hdrs }), 5), CFG5, {});
  assert.deepEqual([e.counters().retry, e.counters().handoff], [0, 0], "aux and main never hand off");
  const canary = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [gr(1), gr(2)], withProv: true, rollout: { canaryPct: 0, salt: "s" } }), { slot: null });
  await canary.route(retried("cn", 5), CFG5, {}); canary.tick(1000); await canary.route(retried("cn", 5), CFG5, {});
  assert.deepEqual([canary.counters().handoff, canary.counters().handoffWould], [0, 1], "a canary-out agent is a shadow agent: it only logs");
});

test("ar-17: FAIL-OPEN: any throw on the retry path returns the asked model and leaves the router working; a failing notice changes nothing and the handoff still stands", async () => {
  const e = env(HPOL([pr(1), pr(2), pr(3), pr(4), pr(5)]), { slot: null });
  await e.route(retried("f1", 5), CFGP, {}); e.tick(1000);
  const bad = sub("nowhere/x", { agent: "f1" });
  Object.defineProperty(bad.body, "messages", { get() { throw new RangeError("boom"); } });
  assert.equal(await e.route(bad, CFGP, {}), "nowhere/x", "asked on any throw");
  assert.equal(e.counters().error, 1);
  e.tick(1000); const ok = await e.route(retried("f1", 5), CFGP, {});
  assert.match(ok, /^p\d\/m$/, "the router keeps working");
  // a frozen system array cannot be appended to: no mutation, noticeFail, the handoff stands
  const g = env(HPOL([pr(1), pr(2), pr(3), pr(4), pr(5)]), { slot: null });
  const first = await g.route(retried("f2", 5), CFGP, {}); g.tick(1000);
  const frozen = retried("f2", 5); frozen.body.system = Object.freeze([{ type: "text", text: "S" }]);
  const before = JSON.stringify(frozen.body);
  const moved = await g.route(frozen, CFGP, {});
  assert.notEqual(moved, first); assert.equal(g.counters().noticeFail, 1); assert.equal(g.counters().noticeApplied, 0);
  assert.equal(JSON.stringify(frozen.body), before, "the body is byte-identical");
  // no system prompt at all: nothing is invented
  g.tick(1000); const nos = retried("f2", 5); delete nos.body.system;
  await g.route(nos, CFGP, {});
  assert.ok(!("system" in nos.body)); assert.equal(g.counters().noticeFail, 2);
});

test("ar-17: the NOTICE: one text block of at most 400 characters on the FIRST request after a handoff, string and array system prompts, never twice, messages and tools byte-identical, off with handoffNotice:false", async () => {
  const run = async (system, owner = {}, rows = [pr(1), pr(2), pr(3), pr(4), pr(5)]) => {
    const e = env(HPOL(rows, owner), { slot: null });
    const first = await e.route(retried("nt", 5), CFGP, {}); e.tick(1000);
    const r = retried("nt", 5); r.body.system = system; if (Array.isArray(system)) r.body.system = structuredClone(system);
    const msgs = JSON.stringify(r.body.messages), tools = JSON.stringify(r.body.tools);
    const to = await e.route(r, CFGP, {});
    assert.equal(JSON.stringify(r.body.messages), msgs, "messages untouched"); assert.equal(JSON.stringify(r.body.tools), tools, "tools untouched");
    return { e, r, first, to };
  };
  const s = await run("You are a helper.");
  const added = s.r.body.system.slice("You are a helper.".length);
  assert.ok(added.startsWith("\n\n[UW handoff] Your previous model "));
  const text = added.slice(2);
  assert.ok(text.length <= 400, `${text.length} characters`);
  assert.equal(text, `[UW handoff] Your previous model ${s.first} hit a limit. You are now ${s.to}. Continue the same task from the conversation above without restarting or re-planning. Begin your next reply with this exact line: ↪ handoff: continued on ${s.to} after ${s.first} limit`);
  assert.equal(s.e.counters().noticeApplied, 1);
  // never stacked: the SAME body (it already carries the notice) is retried again with the same length: a second handoff really runs (counters prove it) and the marker is still there once
  const markers = (sys) => (typeof sys === "string" ? sys : JSON.stringify(sys)).split("[UW handoff]").length - 1;
  assert.equal(markers(s.r.body.system), 1);
  s.e.tick(1000); await s.e.route(s.r, CFGP, {});
  assert.equal(s.e.counters().handoff, 2, "a second handoff ran against the owned body (so the assertion below is not vacuous)");
  assert.equal(markers(s.r.body.system), 1, "never stacked (string system)");
  s.e.tick(1000); await s.e.route(s.r, CFGP, {});
  assert.equal(s.e.counters().handoff, 3);
  assert.equal(markers(s.r.body.system), 1, "never stacked after a third handoff");
  // once: the next turn (the transcript grew) carries none
  const next = retried("nt", 7); next.body.system = "S2";
  s.e.tick(1000); await s.e.route(next, CFGP, {});
  assert.equal(next.body.system, "S2", "the next request is not touched");
  // an array system prompt: a block is appended once; a second handoff of the same body does not append another
  const a = await run([{ type: "text", text: "A" }, { type: "text", text: "B" }]);
  assert.equal(a.r.body.system.length, 3); assert.equal(a.r.body.system[2].type, "text"); assert.ok(a.r.body.system[2].text.startsWith("[UW handoff] "));
  assert.deepEqual(a.r.body.system.slice(0, 2), [{ type: "text", text: "A" }, { type: "text", text: "B" }]);
  a.e.tick(1000); await a.e.route(a.r, CFGP, {});
  assert.equal(a.e.counters().handoff, 2, "the array-shaped body was handed off again too");
  assert.equal(markers(a.r.body.system), 1, "never stacked (array system)"); assert.equal(a.r.body.system.length, 3);
  // off
  const off = await run("You are a helper.", { handoffNotice: false });
  assert.equal(off.r.body.system, "You are a helper."); assert.equal(off.e.counters().noticeApplied, 0); assert.equal(off.e.counters().handoff, 1);
  // long selectors still fit in 400 characters
  const longRows = [row(`p${"x".repeat(30)}/${"m".repeat(30)}1`, { c: 200000 }), row(`p${"x".repeat(30)}/${"m".repeat(30)}2`, { c: 200000 })];
  const lc = cfg([`p${"x".repeat(30)}`, [`${"m".repeat(30)}1`, `${"m".repeat(30)}2`]]);
  const e = env(HPOL(longRows), { slot: null });
  await e.route(retried("lg", 5), lc, {}); e.tick(1000);
  const r = retried("lg", 5); r.body.system = "";
  await e.route(r, lc, {});
  assert.ok(r.body.system.length > 0 && r.body.system.length <= 402, `${r.body.system.length} characters`);
});

test("ar-17: the journal replays a handoff after a worker restart: the new model is sticky, the trail and the hop count survive, so the hourly cap still holds", async () => {
  const e = env(HPOL([1, 2, 3, 4, 5].map((n) => pr(n))), { slot: null });
  await learn(e, SONNET);
  await e.route(retried("jr", 5), CFGP, {});
  for (let i = 0; i < 3; i++) { e.tick(1000); await e.route(retried("jr", 5), CFGP, {}); }
  const model = globalThis.__uwSub.agent.get("s1:jr").model;
  assert.equal(e.counters().handoff, 3);
  e.route.__test.reset();                                                                  // the worker restarts: memory is gone
  e.tick(1000);
  assert.equal(await e.route(retried("jr", 9), CFGP, {}), model, "the handed-off model comes back from the journal");
  assert.equal(globalThis.__uwSub.agent.get("s1:jr").hops, 3); assert.equal(globalThis.__uwSub.agent.get("s1:jr").hist.length, 3);
  e.tick(1000);
  assert.equal(await e.route(retried("jr", 9), CFGP, {}), model, "a retry now hits the cap that the journal carried over");
  assert.equal(e.counters().handoffCap, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(e.state, "agents-s1.jsonl"), "utf8").split("\n").filter(Boolean).at(-1)).r, "handoff");
});

test("ar-17: formatHandoff renders one handoff line for people; hostile text is made printable", () => {
  assert.equal(LIB.formatHandoff({ act: "handoff", from: "groq/x", to: "sambanova/y", reason: "retry:len:1", hop: 1 }), "HANDOFF groq/x -> sambanova/y (retry 1, hop 1)");
  assert.equal(LIB.formatHandoff({ from: "a/b", ret: "c/d", why: "retry:hdr:3", hop: 2 }), "HANDOFF a/b -> c/d (retry 3, hop 2)");
  assert.ok(!/[\u0000-\u001f\u009b]/.test(LIB.formatHandoff({ from: "a\u001b[31m/b", to: "c\u009b/d", reason: "x", hop: "y" })));
  assert.equal(LIB.formatHandoff(null), "HANDOFF ? -> ? (retry ?, hop ?)");
});

// ---------------------------------------------------------------------------------------------- the overlay hint (state/observed.json)
const OVERLAY_T = Date.parse("2026-10-03T12:00:00.000Z");
const writeOverlay = (e, models, o = {}) => {
  const f = path.join(path.dirname(e.state), "observed.json");
  fs.writeFileSync(f, typeof models === "string" ? models : JSON.stringify({ schema: 1, writtenAt: "2026-10-03T11:59:00.000Z", feed: "ok", models, ...o }));
  const t = new Date(Date.now() + env.bump++ * 1000); fs.utimesSync(f, t, t);
  return f;
};
const landings = async (e, n, prefix, config = CFG5) => { const got = new Map(); for (let i = 0; i < n; i++) { e.tick(5); const r = await e.route(sub("nowhere/x", { agent: `${prefix}${i}` }), config, {}); got.set(r, (got.get(r) || 0) + 1); } return got; };

test("ar-17 overlay hint: a model marked rate within 2 h, or pay or auth within 24 h, is DEMOTED for new agents; the age is read from the entry's own `a` (epoch seconds) and expires with the seam clock; all demoted still serves", async () => {
  const rows = [gr(1), gr(2), gr(3)], pol = () => HPOL(rows);
  assert.ok((await landings(env(pol(), { slot: null }), 60, "ctl")).get("groq/g1") > 0, "control: g1 is used without an overlay");
  for (const [status, ageMs, expected] of [["rate", 10 * 60000, true], ["rate", 2 * 3600000 - 60000, true], ["rate", 2 * 3600000 + 60000, false], ["pay", 23 * 3600000, true], ["pay", 25 * 3600000, false], ["auth", 23 * 3600000, true], ["auth", 25 * 3600000, false], ["ok", 1000, false], ["gone", 1000, false]]) {
    const e = env(pol(), { slot: null });
    writeOverlay(e, { "groq/g1": { s: status, a: (OVERLAY_T - ageMs) / 1000 } });
    const got = await landings(e, 60, "o");
    assert.equal((got.get("groq/g1") || 0) === 0, expected, `${status} ${ageMs / 60000} min old: demoted ${expected}`);
  }
  const e = env(pol(), { slot: null });
  writeOverlay(e, { "groq/g1": { s: "rate", a: (OVERLAY_T - 1000) / 1000 } });
  assert.equal((await landings(e, 30, "x1")).get("groq/g1") || 0, 0);
  e.tick(2 * 3600 * 1000 + 1000);                                                          // the mark ages out on the seam clock, with no file change
  assert.ok((await landings(e, 60, "x2")).get("groq/g1") > 0, "expired by age");
  const all = env(pol(), { slot: null });
  writeOverlay(all, Object.fromEntries(["groq/g1", "groq/g2", "groq/g3"].map((m) => [m, { s: "rate", a: (OVERLAY_T - 1000) / 1000 }])));
  const got = await landings(all, 20, "al");
  assert.ok([...got.keys()].every((m) => /^groq\/g[123]$/.test(m)), "every row demoted: the router still serves");
  assert.ok(all.lines("agents.jsonl").some((l) => l.flags.includes("ALL_DEMOTED")));
});

test("ar-17 overlay hint: absent, corrupt, oversized, wrong-schema and kill-switched overlays are ignored (overlayBad counts the unusable ones); in shadow it only changes the logged would; a handoff pick respects it", async () => {
  const rows = [gr(1), gr(2), gr(3)], pol = (o) => HPOL(rows, o);
  const mark = { "groq/g1": { s: "rate", a: (OVERLAY_T - 1000) / 1000 } };
  for (const [name, content, bad] of [["corrupt", "{not json", 1], ["wrong schema", JSON.stringify({ schema: 2, models: mark }), 1], ["models not an object", JSON.stringify({ schema: 1, models: [] }), 1],
    ["oversized", JSON.stringify({ schema: 1, models: mark, pad: "x".repeat(1024 * 1024 + 10) }), 1], ["bad entries", JSON.stringify({ schema: 1, models: { "groq/g1": { s: "rate", a: "yesterday" }, "groq/g2": 5, "groq/g3": { s: "__proto__", a: 5 } } }), 0]]) {
    const e = env(pol(), { slot: null });
    writeOverlay(e, content);
    assert.ok((await landings(e, 60, "bad")).get("groq/g1") > 0, `${name}: ignored`);
    assert.equal(e.counters().overlayBad, bad, name);
    assert.equal(e.counters().error ?? 0, 0);
  }
  const off = env(pol(), { slot: null });
  writeOverlay(off, mark);
  fs.writeFileSync(path.join(path.dirname(off.state), "observe.off"), "");
  assert.ok((await landings(off, 60, "off")).get("groq/g1") > 0, "the kill switch observe.off turns the hint off");
  // shadow: asked is returned, the logged would avoids the marked model
  const sh = env(pol({ enforcement: "shadow" }), { slot: null });
  writeOverlay(sh, mark);
  for (let i = 0; i < 40; i++) { sh.tick(100); assert.equal(await sh.route(sub("nowhere/x", { agent: `sh${i}` }), CFG5, {}), "nowhere/x"); }
  const wouldBy = new Set(sh.lines("agents.jsonl").map((l) => l.would));
  assert.ok(!wouldBy.has("groq/g1") && wouldBy.size >= 1, "shadow's would follows the demotion");
  // a handoff pick avoids a demoted model
  const a = await landing(pol(), "groq/g2", "ov");
  const h = env(pol(), { slot: null });
  await h.route(retried(a, 5), CFG5, {}); h.tick(1100);
  writeOverlay(h, { "groq/g3": { s: "pay", a: (OVERLAY_T - 1000) / 1000 } });
  assert.equal(await h.route(retried(a, 5), CFG5, {}), "groq/g1", "g3 is demoted, so the handoff goes to g1");
  // a changed file is re-read (cache key mtime, size, inode)
  const c = env(pol(), { slot: null });
  const f = writeOverlay(c, mark);
  assert.equal((await landings(c, 30, "c1")).get("groq/g1") || 0, 0);
  c.tick(2000); writeOverlay(c, { "groq/g2": { s: "rate", a: (OVERLAY_T + 1000) / 1000 } });
  const after = await landings(c, 60, "c2");
  assert.ok(after.get("groq/g1") > 0 && !after.get("groq/g2"), "the new overlay replaced the old");
  void f;
});

test("ar-17 budget (loose ceilings, O4a): the handoff path at 1,800 rows over 60 providers, with cooling and overlay reads active; p50 under 3 ms and p99 under 10 ms (the strict number, handoff p99 under 3 ms best of 3: test/perf/subagent-router-perf.mjs)", async () => {
  const m = await measureHandoff("a");
  assert.equal(m.accounted, 300);
  const q = latencyStats(m.times);
  console.log(`budget(ar-17) handoff path over ${m.rows} rows, ${m.providers} providers, ${m.handoffs} handoffs of ${q.n} retries: p50 ${q.p50.toFixed(2)} ms, p99 ${q.p99.toFixed(2)} ms, max ${q.max.toFixed(2)} ms`);
  assert.ok(q.p50 < LOOSE_HANDOFF_P50_MS, `p50 ${q.p50} ms`);
  assert.ok(q.p99 < LOOSE_P99_MS, `p99 ${q.p99} ms`);
});


// =====================================================================================================================
// Fix round for router v2 (security S-F1 .. S-F13, review R1 .. R18, owner decisions D1 .. D7). Each test names its item.
// =====================================================================================================================
const T0 = Date.parse("2026-10-03T12:00:00.000Z");
const subReq = (agent, o = {}) => sub("nowhere/x", { agent, ...o });
const seedCooling = (e, models) => {
  const f = path.join(e.state, "cooling.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, models }));
  const t = new Date(Date.now() + env.bump++ * 1000); fs.utimesSync(f, t, t);
  return f;
};
const cool1 = (until, extra = {}) => ({ u: until, l: 0, t: until - 120000, n: 1, t0: until - 120000, ...extra });
const deepArray = (d = 150000) => { let a = []; for (let i = 0; i < d; i++) a = [a]; return a; };
/** One model failure as the router sees it: a normal turn (the transcript grew, so NOT a retry), then the same request again a second later (a retry). */
const mkFail = (e, config = CFG5) => {
  const lens = new Map();
  return async (sid, agent) => {
    const k = `${sid}:${agent}`, L = (lens.get(k) ?? 5) + 2; lens.set(k, L);
    e.tick(1000); await e.route(retried(agent, L, { sid }), config, {});
    e.tick(1000); await e.route(retried(agent, L, { sid }), config, {});
  };
};

test("S-F1 REGRESSION (the PoC): a request whose model is {toString:1} or a 150,000-deep array is the legacy answer (undefined) and is NOT a router error: five of them in a minute leave shadow.flag absent, the policy enforcing, and the next request still enforced", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  const first = await e.route(subReq("poc"), CFG, {});
  assert.notEqual(first, "nowhere/x", "one valid enforced subagent request");
  const deep = deepArray();
  for (const m of [{ toString: 1 }, deep, { toString: 1 }, { toString: 1 }, deep, { toString: 1 }, deep]) {
    e.tick(1000);
    const r = await e.route({ body: { model: m, tools: [{ name: "Read" }] }, headers: { "x-claude-code-agent-id": "poc" }, builtInClaudeCodeSubagent: true }, CFG, {});
    assert.equal(r, undefined, "the legacy answer for a model that is not a string");
  }
  assert.equal(e.counters().error ?? 0, 0, "not router errors");
  assert.equal(flagOf(e), null, "no shadow.flag");
  assert.equal(e.counters().autoRollback, 0);
  assert.ok(!e.status().warnings.some((w) => w.code === "AUTO_ROLLBACK"));
  e.tick(1000);
  assert.notEqual(await e.route(subReq("poc2"), CFG, {}), "nowhere/x", "the next request is still enforced");
  assert.equal(await e.route(subReq("poc"), CFG, {}), first, "and the sticky agent is unchanged");
});

test("S-F1 (the case it must not break): REAL router errors raised after the request-parse prefix still trip the tripwire; an error inside the prefix (a headers getter) is counted and answered with asked but does not count toward it", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET); await e.route(subReq("t1"), CFG, {});
  for (let i = 0; i < 6; i++) { e.tick(1000); await e.route({ body: { model: OPUS, tools: [] }, get headers() { throw new RangeError("prefix"); } }, CFG, {}); }
  assert.equal(e.counters().error, 6); assert.equal(flagOf(e), null, "six prefix errors in six seconds: no trip");
  for (let i = 0; i < 5; i++) { e.tick(1000); assert.equal(await e.route(errReq(), CFG, {}), OPUS); }
  assert.match(flagOf(e), /^auto:ERRORS:/, "five after-prefix errors trip");
});

test("S-F3 + O1 + D6 REGRESSION: one session puts at most 4 DISTINCT models on the ladder per hour; a FIFTH is still marked at rung 0 (never left undemoted) but never escalates (counter coolLimited); another session may still escalate it; the quota is back after the hour; the retry header alone never cools anything for an agent with an id", async () => {
  const rows5 = [1, 2, 3, 4, 5].map((n) => pr(n));
  const e = env(HPOL(rows5), { slot: null });
  // one agent per model, per session, placed through the journal (the banded spread only ever lands on the top 3 rows, and this test needs all five)
  const T = Date.parse("2026-10-03T12:00:00.000Z");
  for (const sid of ["ss", "ss2"]) {
    await learn(e, SONNET, sid);
    fs.writeFileSync(path.join(e.state, `agents-${sid}.jsonl`), [...[1, 2, 3, 4, 5].map((n) => [`a${n}`, `p${n}/m`]), ["x1", "p1/m"]].map(([k, m]) => JSON.stringify({ k, m, t: T - 1000, h: "x" }) + "\n").join(""));
  }
  const on = (sid, m) => [1, 2, 3, 4, 5].map((n) => `a${n}`).filter((a) => `p${a.slice(1)}/m` === m);
  const fail = mkFail(e, CFGP), cool = (m) => globalThis.__uwSub.cool.get(m);
  const A = [1, 2, 3, 4, 5].map((n) => on("ss", `p${n}/m`)[0]);
  for (let i = 0; i < 4; i++) await fail("ss", A[i]);
  assert.deepEqual([1, 2, 3, 4].map((n) => cool(`p${n}/m`)?.l), [0, 0, 0, 0], "four distinct models are on the ladder");
  assert.equal(e.counters().coolLimited, 0);
  await fail("ss", A[4]);
  assert.equal(e.counters().coolLimited, 1, "the FIFTH distinct model is limited ...");
  const five = cool("p5/m");
  assert.ok(five && five.l === 0 && five.u > globalThis.__uwSub.cool.get("p5/m").t, "... but it is still marked at rung 0: a dead model is never left undemoted");
  assert.equal(five.u - five.t, 120000, "2 minutes");
  // a repeat failure of the fifth model after its cooldown does not escalate for this session (it is not on the ladder) ...
  e.tick(3 * 60 * 1000);
  const f5 = on("ss", "p5/m")[0] || A[4];
  await fail("ss", f5);
  assert.equal(cool("p5/m").l, 0, "no rung above 0 for the fifth model of this session");
  assert.equal(e.counters().coolLimited, 2);
  // ... another session may still escalate it ...
  const b5 = on("ss2", "p5/m")[0];
  e.tick(3 * 60 * 1000);
  await fail("ss2", b5);
  assert.deepEqual([cool("p5/m").l, cool("p5/m").n], [2, 3], "another session escalates the same model, and the streak counted the limited failure too (no multi-session evidence rule: a single-user setup has one session)");
  // ... and the cap is per model: the four models of the session itself still escalate freely (O1: no escalation limit, only the cooldown lengths pace it)
  const before = cool("p1/m").l;
  e.tick(11 * 60 * 1000); await fail("ss", "x1");
  assert.ok(cool("p1/m").l > before, "a model on the ladder escalates again in the same hour");
  // a new hour: the quota is back, the fifth model can be put on the ladder by this session
  e.tick(61 * 60 * 1000);
  await learn(e, SONNET, "ss");
  // header only, for an agent with an id: nothing cools
  const h = env(HPOL([gr(1), gr(2)]), { slot: null });
  await h.route(retried("hh", 5), CFG5, {});
  for (let i = 0; i < 6; i++) { h.tick(1000); await h.route(retried("hh", 5 + 2 * (i + 1), { headers: { "x-stainless-retry-count": String(i + 1) } }), CFG5, {}); }
  assert.equal(globalThis.__uwSub.cool.size, 0); assert.equal(h.counters().coolMark, 0);
});

test("O1 SINGLE-SESSION LADDER: one session, one model, repeated failures: rung 0 at 0 min, rung 1 at 3, rung 2 at 14, rung 3 (6 h) on the 4th consecutive failure (75 min); failures inside a cooldown (20 and 40 min) do not escalate; the model is demoted throughout (the per-session escalation limit is gone)", async () => {
  const e = env(HPOL([pr(1), pr(2), pr(3)]), { slot: null });
  const T = Date.parse("2026-10-03T12:00:00.000Z"), MIN = 60000, cool = () => globalThis.__uwSub.cool.get("p1/m");
  await e.route(sub("nowhere/x", { agent: "warm" }), CFGP, {});
  // the failures are reported by agents of ONE session (sid s1); each is a fresh agent that landed on p1/m, retried once with an unchanged transcript
  const ids = []; for (let i = 0; i < 400 && ids.length < 6; i++) { const a = `ld${i}`; await e.route(sub("nowhere/x", { agent: a }), CFGP, {}); if (globalThis.__uwSub.agent.get(`s1:${a}`)?.model === "p1/m") ids.push(a); }
  assert.equal(ids.length, 6, "six agents of this session sit on p1/m");
  const lens = new Map();
  const fail = async (min, agent) => { const L = (lens.get(agent) ?? 5) + 2; lens.set(agent, L); e.setClock(T + min * MIN - 500); await e.route(retried(agent, L), CFGP, {}); e.setClock(T + min * MIN); await e.route(retried(agent, L), CFGP, {}); };
  const demoted = (min) => { const c = cool(); return !!c && c.u > T + min * MIN; };
  await fail(0, ids[0]);   assert.deepEqual([cool().l, cool().u - cool().t], [0, 2 * MIN], "t=0: rung 0, 2 minutes");
  assert.ok(demoted(0));
  await fail(3, ids[1]);   assert.deepEqual([cool().l, cool().u - cool().t], [1, 10 * MIN], "t=3 min (after the 2-minute cooldown): rung 1, 10 minutes");
  assert.ok(demoted(3));
  await fail(14, ids[2]);  assert.deepEqual([cool().l, cool().u - cool().t], [2, 60 * MIN], "t=14 min: rung 2, 60 minutes");
  const u14 = cool().u;
  await fail(20, ids[3]);  assert.equal(cool().u, u14, "t=20 min: inside the 60-minute cooldown: nothing changes"); assert.ok(demoted(20));
  await fail(40, ids[4]);  assert.equal(cool().u, u14, "t=40 min: still inside it"); assert.ok(demoted(40));
  assert.equal(cool().l, 2); assert.equal(e.counters().coolLimited, 0, "no per-session limit stopped any step");
  await fail(75, ids[5]);  assert.deepEqual([cool().l, cool().n, cool().u - cool().t], [3, 4, 6 * 60 * MIN], "t=75 min (the 60-minute cooldown ended at 74): the 4th consecutive failure: rung 3, 6 hours");
  assert.ok(demoted(75 + 359));
  assert.equal(e.counters().coolLimited, 0);
  // demoted throughout: a NEW agent avoids p1/m while a usable row exists
  e.setClock(T + 80 * MIN);
  for (let i = 0; i < 40; i++) assert.notEqual(await e.route(sub("nowhere/x", { agent: `new${i}` }), CFGP, {}), "p1/m");
});

test("S-F1/S-F3 residual, documented: the per-session limit bounds one session; a same-user attacker with MANY session ids can still demote models (demotion only: a demoted model stays in the set and serves when nothing else is usable)", async () => {
  const e = env(HPOL([gr(1), gr(2)]), { slot: null });
  const sids = Array.from({ length: 6 }, (_, i) => `at${i}`);
  for (const sid of sids) { await e.route(retried("v", 5, { sid }), CFG5, {}); }
  const which = (sid) => globalThis.__uwSub.agent.get(`${sid}:v`).model;
  for (const sid of sids) { e.tick(1000); await e.route(retried("v", 5, { sid }), CFG5, {}); e.tick(1000); await e.route(retried("v", 5, { sid }), CFG5, {}); }
  assert.ok(globalThis.__uwSub.cool.size >= 1, "many sessions can demote");
  assert.match(await e.route(subReq("fresh"), CFG5, {}), /^groq\/g[12]$/, "but every request is still served, from the demoted rows if need be");
  assert.ok(which(sids[0]));
});

test("D1: before any row is verified, a dynamic policy with ctx any chooses EXACTLY as the unbanded spread when the rows share tool tier, health and price class but DIFFER in recency (the old test was circular: every row had the same recency); a verified row makes banded and unbanded differ (control: the switch does something)", async () => {
  const nowMs = Date.parse("2026-10-03T12:00:00.000Z"), day = 86400;
  const names = ["pa", "pb", "pc"], MODELS = ["m1", "m2", "m3", "m4", "m5", "m6"];
  const rows = names.map((p) => ({ provider: p, keyId: `b.${p}.paid`, models: MODELS.map((id) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 1, pout: 2 })) }));
  const providers = names.map((name) => ({ name, models: MODELS, enabled: true, described: false }));
  const ageDays = { pa: 1, pb: 10, pc: 30 };                                            // live-or-fresh, fresh, old: three recency classes
  const bench = { get: (k) => ({ s: "ok", a: nowMs / 1000 - ageDays[k.split("/")[0]] * day - (MODELS.indexOf(k.split("/")[1]) * 60), t: 500 }), isLive: (k) => k === "pa/m1" };
  const mkG = (toolFidelity) => ({ funnelInputs: { rows, bench, nowMs, providers, tiers: { pa: "paid", pb: "paid", pc: "paid" }, toolFidelity, aliasValues: {}, defaultModel: null }, warnings: [],
    stamps: { snapshotBuiltAt: null, snapshotSchema: 9, benchGeneratedAt: null, observedWrittenAt: null, tfAsOf: null }, providersLive: true, providersHash: "h" });
  const run = async (g, banded) => {
    const { compiled } = LIB.compile(g, { ...LIB.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", ctx: "any", enforcement: "enforce", banded });
    const e = env(compiled, { slot: null });
    const out = [];
    for (let i = 0; i < 150; i++) { e.tick(100); out.push(await e.route(sub("nowhere/x", { agent: `pre-${i}` }), cfg(...names.map((n) => [n, MODELS])), {})); }
    assert.equal(e.counters().error ?? 0, 0);
    return { compiled, out };
  };
  const on = await run(mkG(null), true), off = await run(mkG(null), false);
  assert.equal(new Set(on.compiled.models.map((m) => m.b)).size, 1, "one band: the recency classes are NOT band keys");
  assert.equal(new Set(on.compiled.models.map((m) => m.s.split("/")[0])).size, 3);
  assert.deepEqual(on.out, off.out, "identical decisions with banding on and off");
  assert.ok(new Set(on.out).size >= 2, "a real spread");
  const tf = { models: { "pa/m1": { t: "v" }, "pa/m2": { t: "v" } } };                     // a verified band of TWO rows
  const vOn = await run(mkG(tf), true), vOff = await run(mkG(tf), false);
  assert.notDeepEqual(vOn.out, vOff.out, "control: with a verified band the banded spread differs from the unbanded one");
  assert.deepEqual([...new Set(vOn.out)].sort(), ["pa/m1", "pa/m2"], "banded: only the verified band (K' = 2)");
  assert.ok(new Set(vOff.out).size >= 3, "unbanded: the old top three, a row of the next tier included");
});

test("D1: ctx prefer-1m makes rows of at least 1M a higher band: the spread stays on them while any is usable and moves to the smaller rows only when they are cooling or unusable; ctx any ignores the size", async () => {
  const big = (n) => row(`groq/g${n}`, { c: 1000000, b: 0 }), small = (n) => row(`groq/g${n}`, { c: 200000, b: 1 });
  const rows = [big(1), big(2), small(3), small(4)];
  const e = env(HPOL(rows), { slot: null });
  const seen = new Set();
  for (let i = 0; i < 40; i++) { e.tick(10); seen.add(await e.route(subReq(`c${i}`), CFG5, {})); }
  assert.deepEqual([...seen].sort(), ["groq/g1", "groq/g2"], "the 1M band first");
  seedCooling(e, { "groq/g1": cool1(T0 + 3600000), "groq/g2": cool1(T0 + 3600000) });
  e.tick(2000);
  const after = new Set();
  for (let i = 0; i < 40; i++) { e.tick(10); after.add(await e.route(subReq(`d${i}`), CFG5, {})); }
  assert.deepEqual([...after].sort(), ["groq/g3", "groq/g4"], "limited (cooling) 1M rows: the smaller band serves");
  // the funnel puts the 1M rows in band 0 only under prefer-1m (pinned in the policy suite); the router needs nothing more than `b`
});

test("D2: when the whole lead band is cooling the router may fall to a LOWER tool tier ONLY if it is tested (v then t); never to an untested u; crossing bands inside a tool tier is allowed; nothing tested usable: the cooling lead serves (ALL_DEMOTED); a handoff from a tested model never lands on an untested one", async () => {
  const vt = (n, t, b) => gr(n, { t, b });
  const rows = [vt(1, "v", 0), vt(2, "v", 0), vt(3, "t", 1), vt(4, "t", 1), vt(5, "u", 2), vt(6, "u", 2)];
  const CFG6 = cfg(["groq", ["g1", "g2", "g3", "g4", "g5", "g6"]]);
  const land = async (e, n, p) => { const s = new Set(); for (let i = 0; i < n; i++) { e.tick(10); s.add(await e.route(subReq(`${p}${i}`), CFG6, {})); } return [...s].sort(); };
  const e = env(HPOL(rows), { slot: null });
  assert.deepEqual(await land(e, 40, "n"), ["groq/g1", "groq/g2"], "control: nothing cooling, the verified band");
  seedCooling(e, { "groq/g1": cool1(T0 + 3600000), "groq/g2": cool1(T0 + 3600000) });
  e.tick(2000);
  assert.deepEqual(await land(e, 60, "v"), ["groq/g3", "groq/g4"], "the verified band is all cooling: the TESTED tier t serves, never the untested u");
  seedCooling(e, { "groq/g1": cool1(T0 + 3600000), "groq/g2": cool1(T0 + 3600000), "groq/g3": cool1(T0 + 3600000), "groq/g4": cool1(T0 + 3600000) });
  e.tick(2000);
  const last = await land(e, 60, "w");
  assert.ok(last.every((m) => /^groq\/g[12]$/.test(m)), `nothing tested is usable: the cooling lead (v), never u: ${last}`);
  assert.ok(e.lines("agents.jsonl").some((l) => l.flags.includes("ALL_DEMOTED")), "and it says so");
  // crossing bands INSIDE a tool tier stays allowed: v band 0 cooling, v band 1 serves (before any t or u row)
  const rows2 = [vt(1, "v", 0), vt(2, "v", 0), vt(3, "v", 1), vt(4, "t", 2), vt(5, "u", 3)];
  const f = env(HPOL(rows2), { slot: null });
  seedCooling(f, { "groq/g1": cool1(T0 + 3600000), "groq/g2": cool1(T0 + 3600000) });
  assert.deepEqual(await land(f, 40, "x"), ["groq/g3"], "the next band of the SAME tool tier");
  // a handoff from a tested model: the only alternatives are untested: no handoff, the agent keeps its model
  const h = env(HPOL([vt(1, "v", 0), vt(5, "u", 1), vt(6, "u", 1)]), { slot: null });
  await h.route(retried("hv", 5), CFG6, {}); h.tick(1000);
  assert.equal(await h.route(retried("hv", 5), CFG6, {}), "groq/g1");
  assert.equal(h.counters().handoffNone, 1); assert.equal(h.counters().handoff, 0, "never from v to u");
  // contrast: from u to u is fine
  const u = env(HPOL([vt(1, "u", 0), vt(5, "u", 0)]), { slot: null });
  await u.route(retried("hu", 5), CFG6, {}); u.tick(1000);
  const before = globalThis.__uwSub.agent.get("s1:hu").model;
  assert.notEqual(await u.route(retried("hu", 5), CFG6, {}), before); assert.equal(u.counters().handoff, 1);
  // and from v to a TESTED t is fine
  const t = env(HPOL([vt(1, "v", 0), vt(3, "t", 1), vt(5, "u", 2)]), { slot: null });
  await t.route(retried("ht", 5), CFG6, {}); t.tick(1000);
  assert.equal(await t.route(retried("ht", 5), CFG6, {}), "groq/g3");
});

test("R1: the sticky hit path re-reads the journal at most every 1.5 s per session (one statSync when nothing grew): a handoff or touch another worker appended is seen on a HIT; inside the throttle the old model is still served", async () => {
  const e = env(HPOL([gr(1), gr(2), gr(3)]), { slot: null });
  await learn(e, SONNET);
  const M = await e.route(retried("rh", 5), CFG5, {});
  const j = path.join(e.state, "agents-s1.jsonl");
  // another worker hands the agent off: its journal line
  fs.appendFileSync(j, JSON.stringify({ k: "rh", m: M === "groq/g3" ? "groq/g1" : "groq/g3", t: T0 + 500, h: "x", c: T0, hp: 1, x: [[M, T0 + 500]], r: "handoff" }) + "\n");
  e.tick(400);
  assert.equal(await e.route(retried("rh", 7), CFG5, {}), M, "inside the 1.5 s throttle the memory entry answers");
  e.tick(2000);
  const now = await e.route(retried("rh", 9), CFG5, {});
  assert.notEqual(now, M, "after the throttle the other worker's handoff is seen on a hit");
  assert.equal(globalThis.__uwSub.agent.get("s1:rh").hops, 1);
});

test("N06 (surviving mutant): a TOUCH line another worker appended for an agent this worker already knows refreshes its sliding clock (lt) and its counters (n, ts, tm: the larger wins); without it the entry expires six hours after this worker's own last touch; a touch for an unknown agent creates nothing and an OLDER touch never moves the clock back", async () => {
  const e = env(HPOL([gr(1), gr(2)]), { slot: null });
  await learn(e, SONNET);
  const M = await e.route(retried("tt", 5), CFG5, {});
  const j = path.join(e.state, "agents-s1.jsonl");
  assert.equal(globalThis.__uwSub.agent.get("s1:tt").lt, T0);
  fs.appendFileSync(j, JSON.stringify({ k: "tt", u: T0 + 150000, n: 9, ts: 1234, tm: 777 }) + "\n");
  e.tick(200000);
  assert.equal(await e.route(retried("tt", 7), CFG5, {}), M);
  const en = globalThis.__uwSub.agent.get("s1:tt");
  assert.equal(en.lt, T0 + 150000, "the touch moved the sliding clock forward");
  assert.ok(en.n >= 9 && en.ts >= 1234 && en.tm === 777, `n ${en.n}, ts ${en.ts}, tm ${en.tm}`);
  // six hours after this worker's own last touch the entry would be gone; the other worker touched it at 5 h, so it lives
  e.setClock(T0 + 6 * 3600000 + 300000);
  fs.appendFileSync(j, JSON.stringify({ k: "tt", u: T0 + 5 * 3600000, n: 10, ts: 1, tm: 1 }) + "\n");
  assert.equal(await e.route(retried("tt", 9), CFG5, {}), M, "still sticky");
  assert.equal(e.counters().stickyHit, 2);
  assert.equal(globalThis.__uwSub.agent.get("s1:tt").lt >= T0 + 5 * 3600000, true);
  // control: with no such touch the same entry has expired
  const f = env(HPOL([gr(1), gr(2)]), { slot: null });
  await learn(f, SONNET); await f.route(retried("tt", 5), CFG5, {});
  f.setClock(T0 + 6 * 3600000 + 300000); await f.route(retried("tt", 9), CFG5, {});
  assert.equal(f.counters().stickyHit, 0, "expired without the other worker's touch");
  // a touch line NEVER creates an entry and an OLDER touch never moves the clock back
  fs.appendFileSync(j, JSON.stringify({ k: "ghost", u: T0 + 6 * 3600000, n: 1, ts: 1, tm: 1 }) + "\n" + JSON.stringify({ k: "tt", u: T0 + 100, n: 1, ts: 1, tm: 1 }) + "\n");
  e.tick(2000); await e.route(retried("tt", 11), CFG5, {});
  assert.ok(!globalThis.__uwSub.agent.has("s1:ghost")); assert.ok(globalThis.__uwSub.agent.get("s1:tt").lt >= T0 + 5 * 3600000);
});

test("M11 (surviving mutant): provider-key cooling uses a 5-minute window: two models of one provider failing 4 minutes apart cool the provider key; 6 minutes apart they do not", async () => {
  const run = async (gapMs) => {
    const e = env(HPOL([gr(1), gr(2), row("cohere/c1", { c: 200000 })]), { slot: null });
    const ids = Array.from({ length: 60 }, (_, i) => `m${i}`);
    for (const sid of ["a1", "a2"]) for (const a of ids) await e.route(retried(a, 5, { sid }), CFG5, {});
    const on = (sid, m) => ids.find((a) => globalThis.__uwSub.agent.get(`${sid}:${a}`)?.model === m);
    const fail = mkFail(e);
    await fail("a1", on("a1", "groq/g1"));
    e.tick(gapMs);
    await fail("a2", on("a2", "groq/g2"));
    return { prov: globalThis.__uwSub.cool.has("prov:groq"), models: globalThis.__uwSub.cool.has("groq/g1") && globalThis.__uwSub.cool.has("groq/g2"), c: e.counters() };
  };
  const four = await run(4 * 60 * 1000 - 2000), six = await run(6 * 60 * 1000 - 2000), five = await run(5 * 60 * 1000 - 3000);
  assert.deepEqual([four.prov, four.models, four.c.coolProvider], [true, true, 1], "4 minutes apart: the provider key is cooled");
  assert.deepEqual([five.prov, five.models], [true, true], "just inside 5 minutes: cooled");
  assert.deepEqual([six.prov, six.models, six.c.coolProvider], [false, true, 0], "6 minutes apart: each model is cooling, the provider key is not");
});

test("N01 (surviving mutant): the 24-hour streak window: a repeat failure counts toward the 6 h rung only while the streak began inside 24 hours; one begun 24 h + 1 s earlier starts over at rung 0", async () => {
  for (const [age, wantN, wantL] of [[24 * 3600000 - 10000, 4, 3], [24 * 3600000 + 10000, 1, 0]]) {
    const e = env(HPOL([gr(1), gr(2)]), { slot: null });
    const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
    for (const a of ids) await e.route(retried(a, 5), CFG5, {});
    const a1 = ids.find((a) => globalThis.__uwSub.agent.get(`s1:${a}`)?.model === "groq/g1");
    // an earlier streak of three failures whose cooldown just ended (inside the quiet hour); it began `age` ago
    seedCooling(e, { "groq/g1": { u: T0 - 1000, l: 2, t: T0 - 61000, n: 3, t0: T0 - age } });
    e.tick(2000);
    await mkFail(e)("s1", a1);
    const c = globalThis.__uwSub.cool.get("groq/g1");
    assert.deepEqual([c.n, c.l], [wantN, wantL], `streak began ${age} ms ago`);
  }
});

test("N09 (surviving mutant): a cooling.json entry whose `u` lies far in the future is clamped to now + 6 h when read: it demotes for six hours and no longer", async () => {
  const e = env(HPOL([gr(1), gr(2)]), { slot: null });
  seedCooling(e, { "groq/g1": { u: T0 + 100 * 3600000, l: 3, t: T0 - 1000, n: 5, t0: T0 - 5000 } });
  const land = async (p) => { const s = new Set(); for (let i = 0; i < 30; i++) { e.tick(10); s.add(await e.route(subReq(`${p}${i}`), CFG5, {})); } return [...s]; };
  assert.deepEqual(await land("in"), ["groq/g2"], "demoted while the entry is in force");
  e.setClock(T0 + 6 * 3600000 + 5000);
  const later = await land("late");
  assert.ok(later.includes("groq/g1"), "6 h and a bit later the clamped entry is over and g1 serves again (without the clamp it would be demoted for 100 h)");
});

test("N15 (surviving mutant): the hourly gc prunes an EXPIRED cooling entry only when its streak is over too (cooldown plus an hour of quiet AND older than 24 h): an expired entry whose streak is still alive, and an active one, stay", async () => {
  const e = env(HPOL([gr(1), gr(2), gr(3), gr(4)]), { slot: null });
  seedCooling(e, {
    "groq/g1": { u: T0 - 3 * 3600000, l: 0, t: T0 - 3 * 3600000 - 120000, n: 1, t0: T0 - 30 * 3600000 },      // over, quiet for hours, streak older than 24 h: pruned
    "groq/g2": { u: T0 - 3 * 3600000, l: 1, t: T0 - 4 * 3600000, n: 2, t0: T0 - 5 * 3600000 },                 // over and quiet, but the streak is inside 24 h: kept (it can still escalate)
    "groq/g3": { u: T0 + 3600000, l: 1, t: T0 - 1000, n: 2, t0: T0 - 40 * 3600000 },                           // still cooling: kept
    "groq/g4": { u: T0 - 20 * 60000, l: 0, t: T0 - 40 * 60000, n: 1, t0: T0 - 40 * 3600000 },                  // over for 20 minutes only (inside the quiet hour): kept
  });
  await e.route(subReq("first"), CFG5, {});
  assert.deepEqual([...globalThis.__uwSub.cool.keys()].sort(), ["groq/g1", "groq/g2", "groq/g3", "groq/g4"], "loaded");
  for (let i = 0; i < 60; i++) { e.tick(10); await e.route(subReq(`gc${i}`), CFG5, {}); }          // the 50th call runs the first gc pass
  assert.deepEqual([...globalThis.__uwSub.cool.keys()].sort(), ["groq/g2", "groq/g3", "groq/g4"], "only the over-and-forgotten entry was pruned");
});

test("R4/QB-1 (loose ceilings, O4a): the pool paths at 1,800 rows over 60 providers: warm hits, shadow decisions and NEW agents, numbers printed with their denominators and asserted only against the loose ceiling; the plan's strict numbers (warm < 1 ms, shadow < 1 ms, a new agent < 3 ms, best of 3 batches) are in test/perf/subagent-router-perf.mjs", async () => {
  const en = await measurePool("enforce", "all-providers", { rounds: 4 }), sh = await measurePool("shadow", "all-providers", { rounds: 4 });
  const r = { enforceWarm: latencyStats(en.warm), enforceNew: latencyStats(en.fresh), shadowWarm: latencyStats(sh.warm), shadowNew: latencyStats(sh.fresh) };
  console.log(`budget(R4) one batch, ${en.rows} rows, ${en.providers} providers, p99 ms: enforce warm hit ${r.enforceWarm.p99.toFixed(3)} (${r.enforceWarm.n} calls), enforce NEW agent ${r.enforceNew.p99.toFixed(3)} (${r.enforceNew.n}), shadow warm ${r.shadowWarm.p99.toFixed(3)} (${r.shadowWarm.n}), shadow decision of a new agent ${r.shadowNew.p99.toFixed(3)} (${r.shadowNew.n})`);
  for (const [k, v] of Object.entries(r)) assert.ok(v.p99 < LOOSE_P99_MS, `${k} p99 ${v.p99} ms under the loose ceiling of ${LOOSE_P99_MS} ms`);
});

test("R4/QB-1 (loose ceilings, O4a): the HANDOFF path at 1,800 rows over 60 providers (cooling and overlay reads active), a batch of 300 handoffs: p50 under 3 ms and p99 under 10 ms", async () => {
  const m = await measureHandoff("b"), q = latencyStats(m.times);
  assert.equal(m.accounted, 300);
  console.log(`budget(R4) handoff path, ${m.rows} rows, ${m.providers} providers, ${q.n} retried requests (${m.handoffs} handoffs): p50 ${q.p50.toFixed(2)} ms, p99 ${q.p99.toFixed(2)} ms, max ${q.max.toFixed(2)} ms`);
  assert.ok(q.p50 < LOOSE_HANDOFF_P50_MS, `p50 ${q.p50} ms`);
  assert.ok(q.p99 < LOOSE_P99_MS, `p99 ${q.p99} ms`);
});

test("R6: a torn journal tail followed by a NEW append: the router's append starts with a newline, so the new entry replays; a handoff line lost to a crash cannot swallow the NEXT handoff, so the three-an-hour cap still holds after two restarts", async () => {
  const e = env(HPOL([1, 2, 3, 4, 5].map((n) => pr(n))), { slot: null });
  await learn(e, SONNET);
  await e.route(retried("jr", 5), CFGP, {});
  for (let i = 0; i < 2; i++) { e.tick(1000); await e.route(retried("jr", 5), CFGP, {}); }
  assert.equal(e.counters().handoff, 2);
  const j = path.join(e.state, "agents-s1.jsonl");
  fs.appendFileSync(j, '{"k":"jr","m":"p5/m","t":' + (T0 + 9000) + ',"h":"x","c":' + T0 + ',"hp":3,"x":[["p1/m",' + (T0 + 8000) + '],');   // a crash in the middle of the third handoff line
  e.route.__test.reset(); e.tick(1000);                                                       // restart 1
  await e.route(retried("jr", 9), CFGP, {});                                                    // a normal turn: the entry (2 hops) replays; the torn tail is counted
  assert.equal(globalThis.__uwSub.agent.get("s1:jr").hops, 2, "the torn line is not an entry");
  assert.equal(e.counters().stickyJournalTorn >= 1, true, "RV-2: the torn tail was counted when the journal was read (the old assertion was `>= 0`, true whatever happened)");
  e.tick(1000); await e.route(retried("jr", 9), CFGP, {});                                       // a retry: the THIRD handoff, appended AFTER the torn tail
  assert.equal(globalThis.__uwSub.agent.get("s1:jr").hops, 3);
  const raw = fs.readFileSync(j, "utf8");
  assert.match(raw, /,\n\{"k":"jr","m":"p\d\/m","t":\d+,"h":"[^"]*","c":\d+,"hp":3,[^\n]*"r":"handoff"\}\n$/, "the new line starts on its own line, after the torn fragment");
  e.route.__test.reset(); e.tick(1000);                                                       // restart 2
  await e.route(retried("jr", 11), CFGP, {});
  assert.equal(globalThis.__uwSub.agent.get("s1:jr").hops, 3, "the new handoff line survived: it was not swallowed by the torn tail");
  assert.equal(e.counters().stickyJournalTorn >= 1, true, "and the torn fragment was counted");
  e.tick(1000); await e.route(retried("jr", 11), CFGP, {});
  assert.equal(e.counters().handoffCap, 1, "a fourth handoff inside the hour is refused: the cap survived both restarts");
  // the same through a second journal: a plain decision appended after a torn tail replays
  const f = env(ENFORCE(), { slot: null });
  await learn(f, SONNET);
  const jf = path.join(f.state, "agents-s1.jsonl");
  fs.writeFileSync(jf, JSON.stringify({ k: "a1", m: "groq/g1", t: T0 - 1000, h: "x" }) + '\n{"k":"a3","m":"groq/g4","t":' + (T0 - 300));
  await f.route(subReq("a4"), CFG, {});
  f.route.__test.reset(); f.tick(100);
  assert.equal(await f.route(subReq("a1"), CFG, {}), "groq/g1");
  const a4 = JSON.parse(fs.readFileSync(jf, "utf8").split("\n").filter(Boolean).at(-1));
  assert.equal(a4.k, "a4"); assert.equal(await f.route(subReq("a4"), CFG, {}), a4.m, "a4, appended after the torn tail, replays");
  assert.notEqual(await f.route(subReq("a3"), CFG, {}), "groq/g4", "while the torn a3 is still not an entry");
});

test("S-F10: a journal replay reads at most 256 KiB per request and resumes on the next miss; the first append of a session per process, and the first after a failed append, starts with a newline", async () => {
  const e = env(ENFORCE(), { slot: null });
  const jf = path.join(e.state, "agents-s1.jsonl");
  const line = (i) => JSON.stringify({ k: `ag${String(i).padStart(5, "0")}`, m: "groq/g1", t: T0 - 1000, h: "x" }) + "\n";
  let big = ""; for (let i = 0; i < 6000; i++) big += line(i);
  assert.ok(Buffer.byteLength(big) > 300 * 1024);
  fs.writeFileSync(jf, big);
  const reads = [];
  e.route.__test.fs = { ...fs, readSync: (fd, buf, off, len, pos) => { reads.push(len); return fs.readSync(fd, buf, off, len, pos); } };
  await e.route(subReq("ag00000"), CFG, {});
  assert.ok(reads.length >= 1 && Math.max(...reads) <= 256 * 1024, `one request read ${Math.max(...reads)} bytes at most`);
  const j = () => globalThis.__uwSub.jrn.get("s1");
  assert.ok(j().off <= 256 * 1024 && j().off > 200 * 1024, `the first request consumed ${j().off} bytes`);
  const last = "ag05999";
  assert.equal(globalThis.__uwSub.agent.has(`s1:${last}`), false, "an entry beyond the cap is not loaded yet");
  await e.route(subReq(last), CFG, {});                                                        // a miss: the journal is read again from the offset
  assert.ok(j().off > 256 * 1024, "the next miss resumed where the first stopped");
  await e.route(subReq("ag05998"), CFG, {}); await e.route(subReq("ag05997"), CFG, {});
  assert.equal(j().off, fs.statSync(jf).size, "the whole file (with what this worker appended) is consumed after a few misses");
  // the leading newline
  const g = env(ENFORCE(), { slot: null });
  await learn(g, SONNET);
  await g.route(subReq("n1"), CFG, {}); await g.route(subReq("n2"), CFG, {});
  const raw = fs.readFileSync(path.join(g.state, "agents-s1.jsonl"), "utf8");
  assert.ok(raw.startsWith("\n{"), "the first append of the session starts with a newline");
  const interiorBlank = (t) => t.split("\n").slice(1, -1).filter((l) => l === "").length;
  assert.equal(interiorBlank(raw), 0, "and only the first one does: no blank line between the entries");
  let fail = 1; const realWrite = fs.writeSync;
  g.route.__test.fs = { ...fs, writeSync: (...a) => { if (typeof a[1] === "string" && /^\n?\{"k":/.test(a[1]) && fail-- > 0) throw Object.assign(new Error("EIO"), { code: "EIO" }); return realWrite(...a); } };   // only the JOURNAL line fails (the logs write through the same function)   // SEC-5: the journal descriptor stays open and is WRITTEN (not appendFileSync); EIO is not reopened, it is journalFail
  await g.route(subReq("n3"), CFG, {}); await g.route(subReq("n4"), CFG, {});                      // n3's append fails; n4's is the first after a failure
  const raw2 = fs.readFileSync(path.join(g.state, "agents-s1.jsonl"), "utf8");
  assert.equal(g.counters().journalFail, 1);
  assert.equal(interiorBlank(raw2), 1, "the first append after the failure starts with a newline again (one blank line, where the failed append left nothing)");
  assert.equal(raw2.split("\n").filter(Boolean).length, 3, "n1, n2 and n4 are in the journal; n3's append failed");
});

test("S-F13: at most 64 files have an async write in flight (a write for a NEW file is dropped and counted past that); a write cut loose as stuck uses a DIFFERENT temp file name than its successor", async () => {
  const e = env(ENFORCE(), { slot: null });
  for (let i = 0; i < 150; i++) await learn(e, SONNET, `wr${i}`);                                // no event-loop turn between them: every write stays in flight
  assert.ok(globalThis.__uwSub.wr.size <= 64, `${globalThis.__uwSub.wr.size} files with a write in flight`);
  assert.ok(e.counters().asyncWriteFail >= 150 - 64, `${e.counters().asyncWriteFail} writes dropped at the cap`);
  await e.drain();
  const f = env(ENFORCE(), { slot: null });
  const names = [];
  f.route.__test.fs = { ...fs, writeFile: (tmp, text, cb) => { names.push(path.basename(tmp)); if (names.length === 1) return; return fs.writeFile(tmp, text, cb); } };   // the first write's callback never fires
  await learn(f, SONNET, "stuck");
  f.tick(11000);
  await learn(f, HAIKU, "stuck");                                                              // 11 s later: the stuck write is cut loose and a new one starts
  await f.drain();
  const main = names.filter((n) => /^main-stuck\.json\.tmp-/.test(n));
  assert.equal(main.length, 2); assert.notEqual(main[0], main[1], "two writes of one file never share a temp name");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, "main-stuck.json"), "utf8")).model, HAIKU);
});

test("R8: the hourly gc compacts at most TWO journals per pass (the rest on the next hourly pass)", async () => {
  const e = env(ENFORCE(), { slot: null });
  const sids = ["ja", "jb", "jc", "jd", "je"];
  for (const sid of sids) {
    let big = ""; for (let i = 0; i < 1500; i++) big += JSON.stringify({ k: `k${i % 3}`, m: "groq/g1", t: T0 - 1000 + i, h: "x" }) + "\n";
    fs.writeFileSync(path.join(e.state, `agents-${sid}.jsonl`), big);
    assert.ok(Buffer.byteLength(big) > 64 * 1024);
  }
  const small = () => sids.filter((s) => fs.statSync(path.join(e.state, `agents-${s}.jsonl`)).size < 64 * 1024).length;
  for (let i = 0; i < 60; i++) { e.tick(10); await e.route(subReq(`gc${i}`), CFG, {}); }
  assert.equal(small(), 2, "the first pass compacted two");
  e.tick(3600 * 1000 + 1);
  for (let i = 0; i < 60; i++) { e.tick(10); await e.route(subReq(`gd${i}`), CFG, {}); }
  assert.equal(small(), 4, "the next hourly pass, two more");
});

test("R11: a frozen body: a notice that cannot be written is NOT counted applied (string system silently ignores the assignment): noticeFail counts it, the handoff still stands, the body is untouched", async () => {
  const e = env(HPOL([pr(1), pr(2), pr(3), pr(4)]), { slot: null });
  await e.route(retried("fz", 5), CFGP, {}); e.tick(1000);
  const r = retried("fz", 5); r.body.system = "You are a helper."; Object.freeze(r.body);
  const to = await e.route(r, CFGP, {});
  assert.equal(r.body.system, "You are a helper.", "nothing was written");
  assert.deepEqual([e.counters().noticeApplied, e.counters().noticeFail, e.counters().handoff], [0, 1, 1]);
  assert.ok(/^p\d\/m$/.test(to));
  // an array on a frozen array: push throws, caught: the same outcome
  e.tick(1000);
  const r2 = retried("fz", 5); r2.body.system = Object.freeze([{ type: "text", text: "A" }]);
  await e.route(r2, CFGP, {});
  assert.deepEqual([e.counters().noticeApplied, e.counters().noticeFail], [0, 2]);
});

test("R15: cooling.json is re-read just before the router computes and writes a new entry: two workers failing DIFFERENT models within a second do not overwrite each other", async () => {
  const e = env(HPOL([gr(1), gr(2), gr(3)]), { slot: null });
  const ids = Array.from({ length: 60 }, (_, i) => `r${i}`);
  for (const a of ids) await e.route(retried(a, 5), CFG5, {});                                  // this worker's view of cooling.json was read (absent) at this instant
  const on = (m) => ids.find((a) => globalThis.__uwSub.agent.get(`s1:${a}`)?.model === m);
  const [a2, a3] = [on("groq/g2"), on("groq/g3")];
  e.tick(200);
  seedCooling(e, { "groq/g1": { u: T0 + 120200, l: 0, t: T0 + 200, n: 1, t0: T0 + 200 } });    // ANOTHER worker failed g1 a moment ago and wrote the shared file
  e.tick(100); await e.route(retried(a2, 7), CFG5, {});                                         // a normal turn (the transcript grew)
  e.tick(100); await e.route(retried(a2, 7), CFG5, {});                                         // this worker's retry: g2 fails, 400 ms after its last read
  await e.drain();
  const file = JSON.parse(fs.readFileSync(path.join(e.state, "cooling.json"), "utf8"));
  assert.deepEqual(Object.keys(file.models).filter((k) => !k.startsWith("prov:")).sort(), ["groq/g1", "groq/g2"], "the other worker's entry survived this worker's write");
  assert.ok(file.models["prov:groq"], "and the two models of one provider cooled the provider key");
  assert.ok(a3);
});

test("R17: the plan-conformance counters, warnings and status fields: retryHdr/retryLen, stickyJournalTorn, coolMark, coolProvider, coolDemote, overlayDemote; warnings COOLING, OVERLAY_UNREADABLE, LOG_DROPPED; status carries the active cooling entries", async () => {
  const e = env(HPOL([gr(1), gr(2), row("cohere/c1", { c: 200000 })]), { slot: null });
  await learn(e, SONNET);
  const ids = Array.from({ length: 60 }, (_, i) => `x${i}`);
  for (const sid of ["s1", "s2"]) for (const a of ids) await e.route(retried(a, 5, { sid }), CFG5, {});
  const on = (sid, m) => ids.find((a) => globalThis.__uwSub.agent.get(`${sid}:${a}`)?.model === m);
  const fail = mkFail(e);
  await fail("s1", on("s1", "groq/g1")); await fail("s2", on("s2", "groq/g2"));
  let c = e.counters();
  assert.deepEqual([c.coolMark, c.coolProvider, c.retryLen, c.retryHdr], [2, 1, 2, 0]);
  for (let i = 0; i < 20; i++) { e.tick(10); await e.route(subReq(`dm${i}`), CFG5, {}); }
  assert.ok(e.counters().coolDemote >= 1, "new agents skipped a cooling row for a usable one");
  const st = e.status();
  assert.ok(st.warnings.some((w) => w.code === "COOLING" && /cooling/.test(w.detail)), "COOLING warning");
  const keys = st.cooling.map((x) => x.key).sort();
  assert.deepEqual(keys, ["groq/g1", "groq/g2", "prov:groq"], "status carries the active cooling entries");
  assert.ok(st.cooling.every((x) => Number.isInteger(x.rung) && x.leftSec > 0 && x.leftSec <= 6 * 3600), "with rung and seconds left");
  e.tick(3 * 3600 * 1000);
  assert.ok(!e.status().warnings.some((w) => w.code === "COOLING"), "the warning clears when nothing cools");
  // overlay
  writeOverlay(e, { "groq/g1": { s: "rate", a: (T0 + 3 * 3600000) / 1000 - 10 } });
  e.tick(2000);
  for (let i = 0; i < 20; i++) { e.tick(10); await e.route(subReq(`od${i}`), CFG5, {}); }
  assert.ok(e.counters().overlayDemote >= 1, "an overlay mark demotes");
  writeOverlay(e, "{ not json"); e.tick(2000);
  await e.route(subReq("ov-bad"), CFG5, {});
  assert.ok(e.status().warnings.some((w) => w.code === "OVERLAY_UNREADABLE"), "an unreadable overlay raises OVERLAY_UNREADABLE");
  writeOverlay(e, {}); e.tick(2000); await e.route(subReq("ov-ok"), CFG5, {});
  assert.ok(!e.status().warnings.some((w) => w.code === "OVERLAY_UNREADABLE"), "and it clears when the overlay reads again");
  // torn journal line counted
  fs.appendFileSync(path.join(e.state, "agents-s1.jsonl"), '{"k":"zz","m":\n{"k":"zy","m":"groq/g1","t":' + T0 + ',"h":"x"}\n');
  e.tick(2000); await e.route(subReq("never-seen"), CFG5, {});
  assert.ok(e.counters().stickyJournalTorn >= 1);
  // LOG_DROPPED: a flood inside one second
  for (let i = 0; i < 400; i++) await e.route(subReq(`fl${i}`, { sid: "flood" }), CFG5, {});
  assert.ok(e.counters().logDropped > 0);
  assert.ok(e.status().warnings.some((w) => w.code === "LOG_DROPPED"), "dropped log lines raise LOG_DROPPED");
});

test("R7: the first status write is asynchronous like every other (no synchronous flush on the request path); the test seam's flush() writes status.json and status-<w>.json at once", async () => {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  await e.route(main(SONNET), CFG, {});
  assert.equal(fs.existsSync(path.join(e.state, "status.json")), false, "not yet: the first flush is asynchronous");
  assert.equal(fs.existsSync(path.join(e.state, `status-${process.pid.toString(36)}.json`)), false);
  await e.drain();
  assert.ok(fs.existsSync(path.join(e.state, "status.json")) && fs.existsSync(path.join(e.state, `status-${process.pid.toString(36)}.json`)), "both appear once the event loop has turned");
  const s = e.status();
  assert.equal(s.routerVersion, 2);
});

test("S-F12: the real-state guard also wraps appendFileSync, rmSync, copyFileSync, lstat/truncate/utimes, the async callback forms (writeFile, rename, rm, appendFile, ...) and fs.promises", async () => {
  const root = mkTmp("uw-guard-");
  const { guardRealState } = await import("./fixtures/no-real-state.mjs");
  let hook; const touched = guardRealState((fn) => { hook = fn; }, assert, { root });
  const f = path.join(root, "a.txt"), g = path.join(root, "b.txt");
  fs.writeFileSync(f, "x"); fs.appendFileSync(f, "y"); fs.copyFileSync(f, g); fs.rmSync(g); fs.lstatSync(f); fs.utimesSync(f, new Date(), new Date()); fs.truncateSync(f, 1);
  await new Promise((r) => fs.writeFile(g, "z", r)); await new Promise((r) => fs.rename(g, g + "2", r)); await new Promise((r) => fs.rm(g + "2", { force: true }, r)); await new Promise((r) => fs.appendFile(f, "q", r));
  await new Promise((r) => fs.copyFile(f, g, r)); await new Promise((r) => fs.unlink(g, r)); await new Promise((r) => fs.readFile(f, r)); await new Promise((r) => fs.stat(f, r)); await new Promise((r) => fs.mkdir(path.join(root, "d"), r));
  await fs.promises.writeFile(g, "p"); await fs.promises.appendFile(g, "p"); await fs.promises.rename(g, g + "3"); await fs.promises.rm(g + "3", { force: true }); await fs.promises.readFile(f); await fs.promises.copyFile(f, g); await fs.promises.unlink(g);
  const names = new Set(touched.map((t) => t.split(":")[0]));
  for (const n of ["writeFileSync", "appendFileSync", "copyFileSync", "rmSync", "lstatSync", "utimesSync", "truncateSync", "writeFile", "rename", "rm", "appendFile", "copyFile", "unlink", "readFile", "stat", "mkdir", "promises.writeFile", "promises.appendFile", "promises.rename", "promises.rm", "promises.readFile", "promises.copyFile", "promises.unlink"]) {
    assert.ok(names.has(n), `${n} is recorded`);
  }
  // SEC-7: the rest of the surface. Every call is made inside the guard's temp root; a call that fails (a symlink without the privilege, a missing link) is still RECORDED, because the
  // guard notes the path before it delegates. The fs.promises forms of watch and glob return iterators: the call itself is what is recorded.
  touched.length = 0;
  const h = f + ".h", l = f + ".l", c = f + ".c", sameUser = os.userInfo();
  const tries = (fns) => { for (const fn of fns) { try { const r = fn(); if (r && typeof r.close === "function") r.close(); } catch { /* the call may fail: only the record matters */ } } };
  tries([() => fs.cpSync(f, c), () => fs.symlinkSync(f, l), () => fs.linkSync(f, h), () => fs.chmodSync(f, 0o666), () => fs.chownSync(f, sameUser.uid, sameUser.gid), () => fs.lutimesSync(f, new Date(), new Date()),
    () => fs.opendirSync(root), () => fs.globSync(path.join(root, "*")), () => fs.readlinkSync(l), () => fs.realpathSync(f), () => fs.realpathSync.native(f), () => fs.watchFile(f, () => {}), () => fs.unwatchFile(f), () => fs.watch(root)]);
  const cb = (fn) => new Promise((r) => { try { fn(() => r()); } catch { r(); } setTimeout(r, 50).unref(); });
  await cb((d) => fs.cp(f, c + "2", d)); await cb((d) => fs.symlink(f, l + "2", d)); await cb((d) => fs.link(f, h + "2", d)); await cb((d) => fs.chmod(f, 0o666, d)); await cb((d) => fs.chown(f, sameUser.uid, sameUser.gid, d));
  await cb((d) => fs.lutimes(f, new Date(), new Date(), d)); await cb((d) => fs.mkdtemp(path.join(root, "t-"), d)); await cb((d) => fs.opendir(root, (e, dir) => { try { dir && dir.closeSync(); } catch { /* ignore */ } d(); }));
  await cb((d) => fs.glob(path.join(root, "*"), d)); await cb((d) => fs.readlink(l, d)); await cb((d) => fs.realpath(f, d)); await cb((d) => fs.realpath.native(f, d)); await cb((d) => { const w = fs.watch(root); w.close(); d(); });
  for (const fn of [() => fs.promises.symlink(f, l + "3"), () => fs.promises.link(f, h + "3"), () => fs.promises.chmod(f, 0o666), () => fs.promises.chown(f, sameUser.uid, sameUser.gid), () => fs.promises.lutimes(f, new Date(), new Date()),
    () => fs.promises.mkdtemp(path.join(root, "p-")), () => fs.promises.opendir(root).then((d) => d.close()), () => fs.promises.readlink(l), () => fs.promises.realpath(f), () => fs.promises.cp(f, c + "3")]) { try { await fn(); } catch { /* recorded anyway */ } }
  try { fs.promises.glob(path.join(root, "*")); } catch { /* ignore */ } try { fs.promises.watch(root, { signal: AbortSignal.abort() }); } catch { /* ignore */ }
  const more = new Set(touched.map((t) => t.split(":")[0]));
  for (const n of ["cpSync", "symlinkSync", "linkSync", "chmodSync", "chownSync", "lutimesSync", "opendirSync", "globSync", "readlinkSync", "realpathSync", "realpathSync.native", "watchFile", "watch",
    "cp", "symlink", "link", "chmod", "chown", "lutimes", "mkdtemp", "opendir", "glob", "readlink", "realpath", "realpath.native",
    "promises.symlink", "promises.link", "promises.chmod", "promises.chown", "promises.lutimes", "promises.mkdtemp", "promises.opendir", "promises.glob", "promises.readlink", "promises.realpath", "promises.watch", "promises.cp"]) {
    assert.ok(more.has(n), `${n} is recorded`);
  }
  // the case it must not break: a canonical-path lookup of the guarded folder ITSELF (the protective comparison keysync makes on purpose) is not a touch; one of anything inside it is
  touched.length = 0;
  fs.realpathSync.native(root); fs.realpathSync(root); await new Promise((r) => fs.realpath.native(root, r));
  assert.deepEqual(touched, [], "resolving the guarded folder's own canonical path is allowed");
  fs.realpathSync(f);
  assert.equal(touched.length, 1, "but resolving a path inside it is recorded");
  touched.length = 0; assert.equal(typeof hook, "function");
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(touched.filter((t) => !t.startsWith("rmSync:")), [], "nothing else");
  touched.length = 0;
});

test("D7: every NEW agent decision is written to agents.jsonl AND to decisions.jsonl (old readers keep working until they migrate); agents.jsonl keeps the current file plus three rotated generations of 1 MiB (4 MiB)", async () => {
  const e = env(ENFORCE(), { slot: null });
  await learn(e, SONNET);
  const r = await e.route(subReq("d7"), CFG, {});
  const a = e.lines("agents.jsonl").filter((l) => l.aid === "d7"), d = e.lines("decisions.jsonl").filter((l) => l.aid === "d7" && l.act !== "sticky");
  assert.equal(a.length, 1); assert.equal(d.length, 1, "the decision log still gets the new-agent line");
  assert.equal(a[0].ret, r); assert.equal(d[0].ret, r);
  assert.ok(SRC.includes('a: { name: "agents.jsonl", max: LOG_MAX, rate: 20, gens: 3 }') && /const LOG_MAX = 1024 \* 1024/.test(SRC), "1 MiB a file, three rotated generations kept");
});

// =====================================================================================================================
// R-v3 (owner batch 2026-10-06): (1) the main-first shortcut only for main's row in the LEAD band, (2) an unknown payload cap ranks last above 200 KB, (3) classify.jsonl retention and the
// hasSid / ua fields. Each has a positive and a negative case; the mutants that must fail them are listed in the commit message.
// =====================================================================================================================
const V3_ROWS = [row("groq/g1", { b: 0, g: 0 }), row("groq/g2", { b: 0, g: 1 }), row("groq/g3", { b: 1, g: 2 }), row("groq/g4", { b: 1, g: 3 })];
const v3Policy = (owner = {}, rows = V3_ROWS) => mkPolicy({ owner: { mode: "dynamic", source: "same-provider", enforcement: "enforce", ...owner }, rows, withProv: true });
async function v3Fan(e, n = 20, o = {}) {                         // n subagents of one session, each asking for a model that is not in the set: every one is a substitute pick
  const got = [];
  for (let i = 0; i < n; i++) { e.tick(100); got.push(await e.route(sub(HAIKU, { agent: `fan-${i}`, ...o }), CFG, {})); }
  return got;
}

test("R-v3 (1): main's own model is taken first ONLY when its row is in the lead band (dynamic and free): main in band 0 -> every agent on main; main in band 1 -> a 20-agent fan-out spreads over band 0", async () => {
  for (const mode of ["dynamic", "free"]) {
    for (const [mainModel, want] of [["groq/g1", ["groq/g1"]], ["groq/g2", ["groq/g2"]]]) {
      const e = env(v3Policy({ mode }), { slot: null });
      await learn(e, mainModel);
      assert.deepEqual([...new Set(await v3Fan(e))], want, `${mode}: main ${mainModel} is in the lead band: the shortcut holds`);
    }
    for (const mainModel of ["groq/g3", "groq/g4"]) {                                           // main is in the pool (same provider list) but in band 1
      const e = env(v3Policy({ mode }), { slot: null });
      await learn(e, mainModel);
      const got = await v3Fan(e);
      assert.deepEqual([...new Set(got)].sort(), ["groq/g1", "groq/g2"], `${mode}: main ${mainModel} is in band 1: the fan-out spreads over band 0, main is not used`);
      assert.ok(got.filter((m) => m === "groq/g1").length >= 3 && got.filter((m) => m === "groq/g2").length >= 3, `${mode}: both band-0 rows carry real shares of 20 agents`);
    }
  }
});

test("R-v3 (1): the cases the restriction must not break: banding off, inherit mode, a one-band policy, a policy without band numbers and an unusable lead row keep their answers", async () => {
  const e1 = env(v3Policy({ banded: false }), { slot: null });                                    // banding off: no bands, the old main-first shortcut
  await learn(e1, "groq/g3");
  assert.deepEqual([...new Set(await v3Fan(e1))], ["groq/g3"], "banded:false is the old behaviour");
  const e2 = env(v3Policy({ mode: "inherit" }), { slot: null });                                  // inherit: main's model, whatever the bands say
  await learn(e2, "groq/g3");
  assert.deepEqual([...new Set(await v3Fan(e2))], ["groq/g3"], "inherit mode is unchanged");
  const flat = [row("groq/g1", { b: 0 }), row("groq/g2", { b: 0 }), row("groq/g3", { b: 0 })];
  const e3 = env(v3Policy({}, flat), { slot: null });                                             // one band: every row is in the lead band
  await learn(e3, "groq/g3");
  assert.deepEqual([...new Set(await v3Fan(e3))], ["groq/g3"], "a main in a one-band set keeps the shortcut");
  const e4 = env(v3Policy({}, V3_ROWS.map((r) => ({ ...r, b: undefined }))), { slot: null });     // rows without a band number (an older compile): all equal, the shortcut holds
  await learn(e4, "groq/g3");
  assert.deepEqual([...new Set(await v3Fan(e4))], ["groq/g3"], "no band numbers: no restriction");
  const CFG2 = cfg(["groq", ["g2", "g3", "g4"]]);                                                 // g1 is not resolvable: the lead band is {g2}: main g3 (band 1) spreads to g2 alone
  const e5 = env(v3Policy(), { slot: null });
  await e5.route(main("groq/g3", { sid: "s1" }), CFG2, {});
  const got = []; for (let i = 0; i < 10; i++) { e5.tick(100); got.push(await e5.route(sub(HAIKU, { agent: `u-${i}` }), CFG2, {})); }
  assert.deepEqual([...new Set(got)], ["groq/g2"], "the lead band is the first USABLE row's band");
});

test("R-v3 (1): the look-ahead that finds the lead band counts nothing: ctxSkip and payloadSkip of a shortcut decision equal those of the old shortcut (none for the rows it never reached)", async () => {
  const rows = [row("groq/g1", { b: 0, g: 0, c: 64000 }), row("groq/g2", { b: 0, g: 1, c: 64000 }), row("groq/g3", { b: 0, g: 2 })];   // two rows below the 128k floor
  const e = env(v3Policy({}, rows), { slot: null });
  await learn(e, "groq/g3");
  const before = { ...e.counters() };
  await e.route(sub(HAIKU, { agent: "cnt-1" }), CFG, {});
  assert.equal(e.counters().ctxSkip, before.ctxSkip, "the probe skipped g1 and g2 silently");
  assert.equal(e.counters().payloadSkip, before.payloadSkip);
});

test("R-v3 (2): above 200 KB a row with an unknown payload cap ranks LAST, never excluded; up to 200 KB nothing is reordered", async () => {
  const rows = [row("groq/g1", { b: 0, g: 0, pb: 0 }), row("groq/g2", { b: 0, g: 1, pb: 900000 }), row("groq/g3", { b: 0, g: 2, pb: 900000 })];
  const pol = () => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows });
  const run = async (bytes) => { const e = env(pol(), { slot: null }); await learn(e, OPUS); return [...new Set(await v3Fan(e, 30, { bytes }))].sort(); };
  assert.deepEqual(await run(300 * 1024), ["groq/g2", "groq/g3"], "300 KB: the unknown-cap g1 is never picked while known-cap rows fit");
  assert.deepEqual(await run(100 * 1024), ["groq/g1", "groq/g2", "groq/g3"], "100 KB: the old pool, g1 included");
  assert.deepEqual(await run(200 * 1024), ["groq/g1", "groq/g2", "groq/g3"], "exactly 200 KB is not over 200 KB");
  assert.deepEqual(await run(undefined), ["groq/g1", "groq/g2", "groq/g3"], "no content-length: the old pool");
  // a better band with an unknown cap still ranks below a known-cap row of a worse band
  const two = () => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1", { b: 0, g: 0, pb: 0 }), row("groq/g2", { b: 1, g: 1, pb: 900000 })] });
  const e = env(two(), { slot: null });
  await learn(e, OPUS);
  assert.deepEqual([...new Set(await v3Fan(e, 10, { bytes: 300 * 1024 }))], ["groq/g2"], "big: the known row of band 1 beats the unknown row of band 0");
  const e2 = env(two(), { slot: null });
  await learn(e2, OPUS);
  assert.deepEqual([...new Set(await v3Fan(e2, 10, { bytes: 100 * 1024 }))], ["groq/g1"], "small: the rank decides, g1 leads");
});

test("R-v3 (2): an unknown-cap row is never EXCLUDED: when no known-cap row fits (or none exists) it still serves a big request; a known row whose cap is below the request is skipped as before", async () => {
  const onlyUnknown = mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1", { b: 0, g: 0 }), row("groq/g2", { b: 0, g: 1 })] });
  const e = env(onlyUnknown, { slot: null });
  await learn(e, OPUS);
  assert.deepEqual([...new Set(await v3Fan(e, 20, { bytes: 900 * 1024 }))].sort(), ["groq/g1", "groq/g2"], "every row unknown: the same spread as before");
  const mixed = mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [row("groq/g1", { b: 0, g: 0, pb: 100000 }), row("groq/g2", { b: 0, g: 1 })] });
  const e2 = env(mixed, { slot: null });
  await learn(e2, OPUS);
  assert.deepEqual([...new Set(await v3Fan(e2, 10, { bytes: 300 * 1024 }))], ["groq/g2"], "g1's known cap (100 KB) is below the request: skipped; the unknown g2 is the last resort and serves");
  assert.ok(e2.counters().payloadSkip >= 1);
});

test("R-v3 (2): main's own model with an unknown cap does not take a big request first when a known-cap row fits; a known-cap main still does", async () => {
  const rows = [row("groq/g1", { b: 0, g: 0, pb: 0 }), row("groq/g2", { b: 0, g: 1, pb: 900000 })];
  const mk = () => mkPolicy({ owner: { mode: "dynamic", source: "same-provider", enforcement: "enforce" }, rows, withProv: true });
  const e = env(mk(), { slot: null });
  await learn(e, "groq/g1");
  assert.deepEqual([...new Set(await v3Fan(e, 10, { bytes: 300 * 1024 }))], ["groq/g2"], "big request: main g1 has an unknown cap and goes last");
  const e2 = env(mk(), { slot: null });
  await learn(e2, "groq/g1");
  assert.deepEqual([...new Set(await v3Fan(e2, 10, { bytes: 100 * 1024 }))], ["groq/g1"], "small request: main g1 keeps the shortcut");
  const e3 = env(mk(), { slot: null });
  await learn(e3, "groq/g2");
  assert.deepEqual([...new Set(await v3Fan(e3, 10, { bytes: 300 * 1024 }))], ["groq/g2"], "big request, known-cap main: the shortcut holds");
});

test("R-v3 (3): each classify line carries hasSid (a parseable session id was present) and ua (a closed class: claude-cli, sdk, other, none), never the raw user-agent", async () => {
  const e = env(POL(), { slot: null });
  const UAS = [["claude-cli/2.1.150 (external, cli)", "claude-cli"], ["claude-cli/2.1.150 (external, sdk-ts)", "sdk"], ["Anthropic/JS 0.60.0", "sdk"], ["anthropic/python 0.5", "sdk"], ["curl/8.4 TOPSECRET-UA-TOKEN", "other"], [undefined, "none"], ["", "none"], ["x".repeat(5000), "other"]];
  for (const [ua, want] of UAS) {
    await e.route(aux(HAIKU, { headers: ua === undefined ? {} : { "user-agent": ua } }), CFG, {});
    const l = e.lines("classify.jsonl").at(-1);
    assert.equal(l.ua, want, `user-agent ${JSON.stringify(String(ua).slice(0, 30))}`);
    assert.ok(l.ua.length <= 16);
    assert.equal(l.hasSid, true);
  }
  const noSid = { body: { model: HAIKU, tools: [] }, headers: { "x-claude-code-agent-id": "nosid-1" } };
  await e.route(noSid, CFG, {});
  assert.equal(e.lines("classify.jsonl").at(-1).hasSid, false, "no session id: false");
  await e.route({ body: { model: HAIKU, tools: [] }, headers: { "x-claude-code-agent-id": "bad-1", "x-claude-code-session-id": "not a valid id!" }, sessionId: "not a valid id!" }, CFG, {});
  assert.equal(e.lines("classify.jsonl").at(-1).hasSid, false, "an unparseable session id counts as none");
  await e.route(main(SONNET, { sid: "s9", headers: { "user-agent": "claude-cli/2.1.150 (external, cli)" } }), CFG, {});
  const m = e.lines("classify.jsonl").at(-1);
  assert.deepEqual([m.cls, m.hasSid, m.ua], ["main", true, "claude-cli"], "a main request carries both too");
  const all = [...e.files()].map((f) => fs.readFileSync(path.join(e.state, f), "utf8")).join("\n");
  assert.ok(!all.includes("TOPSECRET-UA-TOKEN") && !all.includes("x".repeat(40)), "the raw user-agent reaches no file");
  const off = env(POL({ classLog: "off" }), { slot: null });
  await off.route(aux(HAIKU, { headers: { "user-agent": "curl/8" } }), CFG, {});
  assert.equal(off.lines("classify.jsonl").length, 0, "classLog off still writes nothing");
});

test("R-v3 (3): classify.jsonl rotates at 8 MiB (not at the old 2 MiB) and keeps 2 generations: at most 3 files, 24 MiB (+ the size-check overshoot)", async () => {
  const e = env(POL(), { slot: null });
  const f = (n) => path.join(e.state, n), has = (n) => fs.existsSync(f(n)), size = (n) => (has(n) ? fs.statSync(f(n)).size : 0);
  const line = JSON.stringify({ pad: "x".repeat(1000) }) + "\n";
  const grow = (n) => fs.appendFileSync(f("classify.jsonl"), line.repeat(Math.ceil(n / line.length)));
  const fire = async (tag) => { for (let i = 0; i < 50; i++) { e.tick(100); await e.route(aux(HAIKU, { agent: `${tag}${i}` }), CFG, {}); } };   // the size check runs on every 50th append
  const MiB = 1024 * 1024;
  grow(3 * MiB); await fire("a");
  assert.ok(!has("classify.1.jsonl"), "3 MiB is above the OLD cap and below the new one: no rotation");
  grow(5.5 * MiB); await fire("b");
  assert.ok(has("classify.1.jsonl") && size("classify.1.jsonl") >= 8 * MiB, "past 8 MiB: the file became generation 1");
  assert.ok(size("classify.jsonl") < 100 * 1024, "a fresh current file");
  grow(8 * MiB); await fire("c");
  assert.ok(has("classify.2.jsonl") && size("classify.2.jsonl") >= 8 * MiB, "the second rotation moved generation 1 to generation 2");
  grow(8 * MiB); await fire("d");
  assert.ok(!has("classify.3.jsonl"), "no third generation");
  const total = ["classify.jsonl", "classify.1.jsonl", "classify.2.jsonl"].reduce((a, n) => a + size(n), 0);
  assert.ok(total <= 3 * (8 * MiB + 50 * 4096), `the three files stay under 3 x (8 MiB + 200 KiB), now ${total}`);
  assert.ok(/CLASS_MAX = 8 \* 1024 \* 1024/.test(SRC) && SRC.includes('name: "classify.jsonl", max: CLASS_MAX, rate: 50, gens: 2'), "the source pins 8 MiB and 2 generations");
});

// ---- R-v3 review round (cr-router-v3 F1, F2, F4, F5, and the bk field). The unknown-cap rows of a big request follow the SAME tier, cooling and handoff rules as every row.
const bigReq = (agent, bytes, o = {}) => sub("nowhere/x", { agent, bytes, ...o });
const BIGB = 300 * 1024;
const seedCool = (e, m) => { seedCooling(e, m); e.tick(6000); };   // the router re-reads cooling.json at most every few seconds of its clock
async function bigFan(e, n, bytes, config = CFGP) { const got = []; for (let i = 0; i < n; i++) { e.tick(100); got.push(await e.route(bigReq(`bf-${i}`, bytes), config, {})); } return got; }
const P3 = (specs, o = {}) => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce", ...o }, rows: specs.map(([n, extra]) => pr(n, { b: 0, ...extra })), withProv: true });

test("R-v3 F1: a COOLING unknown-cap row is not picked for a big request while a non-cooling one exists; with only cooling unknown rows left one still serves, demoted, never blocked", async () => {
  const mk = () => P3([[1, { pb: 100000 }], [2, { pb: 0 }], [3, { pb: 0 }]]);
  const e = env(mk(), { slot: null });
  await learn(e, OPUS);
  seedCool(e, { "p2/m": cool1(T0 + 3600000) });
  assert.deepEqual([...new Set(await bigFan(e, 30, BIGB))], ["p3/m"], "p1's known cap (100 KB) is below the request, p2 is cooling: p3 serves every agent");
  const e2 = env(mk(), { slot: null });
  await learn(e2, OPUS);
  assert.deepEqual([...new Set(await bigFan(e2, 30, BIGB))].sort(), ["p2/m", "p3/m"], "nothing cooling: both unknown rows spread (the case it must not break)");
  const e3 = env(mk(), { slot: null });
  await learn(e3, OPUS);
  seedCool(e3, { "p2/m": cool1(T0 + 3600000), "p3/m": cool1(T0 + 3600000) });
  const got = new Set(await bigFan(e3, 20, BIGB));
  assert.ok([...got].every((m) => m === "p2/m" || m === "p3/m"), `only cooling unknown rows exist: one of them serves, demoted (${[...got]})`);
});

test("R-v3 F1: the D2 rule holds for the unknown-cap rows: from a cooling TESTED lead a big request never falls to an UNTESTED row, and a known row still beats every unknown one", async () => {
  const mk = () => mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: [pr(1, { b: 0, t: "v" }), pr(2, { b: 1, t: "u" })], withProv: true });
  const e = env(mk(), { slot: null });
  await learn(e, OPUS);
  seedCool(e, { "p1/m": cool1(T0 + 3600000) });
  assert.deepEqual([...new Set(await bigFan(e, 20, BIGB))], ["p1/m"], "p1 (tested, unknown cap, cooling) is used demoted; the untested p2 is never reached from it");
  const e2 = env(mk(), { slot: null });
  await learn(e2, OPUS);
  assert.deepEqual([...new Set(await bigFan(e2, 20, 100 * 1024))], ["p1/m"], "a small request: the old pool, p1 leads");
});

test("R-v3 F2: a handoff of a big request never lands on an UNTESTED row or on a COOLING unknown-cap row; a known-cap row and a non-cooling tested unknown one are still valid targets", async () => {
  const retry = async (e, agent) => { const first = await e.route(retried(agent, 5, { bytes: BIGB }), CFGP, {}); e.tick(1000); return [first, await e.route(retried(agent, 5, { bytes: BIGB }), CFGP, {})]; };
  const rows1 = [pr(1, { t: "v", pb: 900000 }), pr(2, { t: "u", pb: 0 })];                      // from the tested p1 the only other row is untested and unknown-cap
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows: rows1.map((r) => ({ ...r, b: 0 })), withProv: true }), { slot: null });
  await learn(e, OPUS);
  const [first, second] = await retry(e, "h-u");
  assert.equal(first, "p1/m");
  assert.equal(second, "p1/m", "no handoff to the untested p2");
  assert.deepEqual([e.counters().handoff, e.counters().handoffNone], [0, 1]);
  const eb = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce", banded: false }, rows: rows1.map((r) => ({ ...r, b: 0 })), withProv: true }), { slot: null });
  await learn(eb, OPUS);
  const [fb, sb] = await retry(eb, "h-ub");
  assert.deepEqual([fb, sb, eb.counters().handoff], ["p1/m", "p1/m", 0], "banding off: the untested unknown-cap p2 is still no handoff target (O3 holds whatever the banding says)");
  const ec = env(P3([[1, { t: "v", pb: 900000 }], [2, { t: "v", pb: 0 }]]), { slot: null });   // the only other row is unknown-cap and COOLING: no handoff, never a cooling target
  await learn(ec, OPUS);
  seedCool(ec, { "p2/m": cool1(T0 + 3600000) });
  const [fc, sc] = await retry(ec, "h-uc");
  assert.deepEqual([fc, sc, ec.counters().handoff, ec.counters().handoffNone], ["p1/m", "p1/m", 0, 1], "a cooling unknown-cap row is not a handoff target");
  let handoffs = 0;                                                                            // p2 is a tested unknown-cap row but COOLING, p3 is not: only p3 is a target
  for (let i = 0; i < 10; i++) {
    const e2 = env(P3([[1, { t: "v", pb: 900000 }], [2, { t: "v", pb: 0 }], [3, { t: "v", pb: 0 }]]), { slot: null });
    await learn(e2, OPUS);
    seedCool(e2, { "p2/m": cool1(T0 + 3600000) });
    const [f, s] = await retry(e2, `h-c${i}`);
    assert.equal(f, "p1/m");
    assert.equal(s, "p3/m", "never the cooling p2");
    handoffs += e2.counters().handoff;
  }
  assert.equal(handoffs, 10);
  const e3 = env(P3([[1, { t: "v", pb: 900000 }], [2, { t: "v", pb: 900000 }]]), { slot: null });   // the case it must not break: a known-cap tested row is a target
  await learn(e3, OPUS);
  const [f3, s3] = await retry(e3, "h-k");
  assert.deepEqual([f3, s3].sort(), ["p1/m", "p2/m"], "the agent moved to the other known-cap row");
});

test("R-v3 bk: a pb-0 row whose bk (bytes the sweep proved) covers the request is a KNOWN fit; unknown otherwise; pb > 0 keeps its own rule; a request of 200 KB or less is unchanged", async () => {
  const rows = () => [[1, { pb: 900000 }], [2, { pb: 0, bk: 400000 }], [3, { pb: 0 }], [4, { pb: 0, bk: 400000 }]];
  const run = async (bytes, specs = rows()) => { const e = env(P3(specs), { slot: null }); await learn(e, OPUS); return [...new Set(await bigFan(e, 60, bytes))].sort(); };
  assert.deepEqual(await run(BIGB), ["p1/m", "p2/m", "p4/m"], "300 KB: the known row and the two proven rows spread; the unknown p3 is last");
  assert.deepEqual(await run(500 * 1000), ["p1/m"], "500,000 bytes: bk 400,000 no longer covers the request, so p2 and p4 are unknown too: only the known-cap p1 serves");
  assert.deepEqual(await run(400000), ["p1/m", "p2/m", "p4/m"], "exactly bk bytes is covered");
  assert.deepEqual(await run(100 * 1024), ["p1/m", "p2/m", "p3/m"], "100 KB: bk changes nothing, the old pool (the first three rows)");
  assert.deepEqual(await run(200 * 1024), ["p1/m", "p2/m", "p3/m"], "exactly 204,800 bytes is not above 200 KB");
  assert.deepEqual(await run(BIGB, [[1, { pb: 100000, bk: 900000 }], [2, { pb: 0 }]]), ["p2/m"], "a row with pb > 0 keeps the pb rule: bk never lifts a measured refusal limit");
  assert.deepEqual(await run(BIGB, [[1, { pb: 0 }], [2, { pb: 0, bk: 400000 }]]), ["p2/m"], "the proven row beats the unknown row that leads the rank");
  assert.deepEqual(await run(BIGB, [[1, { pb: 0, bk: 400000 }], [2, { pb: 0 }]]), ["p1/m"], "and the rank order decides between proven rows and the rest of a band as for any known row");
});

test("R-v3 bk: a garbage bk (string, negative, zero, null, NaN, boolean, object, array, huge) is treated as absent; bk is advisory and never refuses anything", async () => {
  for (const bad of ["400000", -5, 0, null, NaN, true, {}, [400000], 1e30, 64 * 1024 * 1024 + 1]) {
    const e = env(P3([[1, { pb: 900000 }], [2, { pb: 0, bk: bad }]]), { slot: null });
    await learn(e, OPUS);
    assert.deepEqual([...new Set(await bigFan(e, 20, BIGB))], ["p1/m"], `bk ${JSON.stringify(bad)} is absent: p2 stays unknown and ranks after p1`);
  }
  const onlyBk = env(P3([[1, { pb: 0, bk: 1000 }], [2, { pb: 0 }]]), { slot: null });          // a bk below the request is not a refusal: with no known row the unknown rows still serve
  await learn(onlyBk, OPUS);
  assert.deepEqual([...new Set(await bigFan(onlyBk, 30, BIGB))].sort(), ["p1/m", "p2/m"], "never excluded");
});

test("R-v3 bk: the cooling, tier and handoff rules apply to a proven row like any known row", async () => {
  const e = env(P3([[1, { pb: 0, bk: 400000 }], [2, { pb: 0 }]]), { slot: null });
  await learn(e, OPUS);
  seedCool(e, { "p1/m": cool1(T0 + 3600000) });
  assert.deepEqual([...new Set(await bigFan(e, 20, BIGB))], ["p1/m"], "the proven row is cooling (demoted) but still outranks the unknown row: chill comes before unknown");
  const e2 = env(P3([[1, { pb: 0, bk: 400000 }], [2, { pb: 0, bk: 400000 }], [3, { pb: 0 }]]), { slot: null });
  await learn(e2, OPUS);
  seedCool(e2, { "p1/m": cool1(T0 + 3600000) });
  assert.deepEqual([...new Set(await bigFan(e2, 20, BIGB))], ["p2/m"], "a non-cooling proven row beats a cooling proven row and an unknown row");
  const e3 = env(P3([[1, { t: "v", pb: 900000 }], [2, { t: "u", b: 1, pb: 0, bk: 400000 }]]), { slot: null });   // a handoff from a tested tier never lands on an untested proven row
  await learn(e3, OPUS);
  const first = await e3.route(retried("bk-h", 5, { bytes: BIGB }), CFGP, {}); e3.tick(1000);
  assert.equal(first, "p1/m");
  assert.equal(await e3.route(retried("bk-h", 5, { bytes: BIGB }), CFGP, {}), "p1/m", "O3: no handoff to the untested row");
});

test("R-v3 F4: a list that is mostly unknown-cap rows is walked cheaply for a big request and the one known row at its end is still found", async () => {
  const rows = []; for (let i = 0; i < 600; i++) rows.push(row(`prov${i % 30}/u${i}`, { c: 200000, b: 0, g: 0, pb: 0 }));
  rows.push(row("prov1/known", { c: 200000, b: 0, g: 0, pb: 900000 }));
  const providers = []; for (let p = 0; p < 30; p++) providers.push({ name: `prov${p}`, models: [...rows.filter((r) => r.s.startsWith(`prov${p}/`)).map((r) => r.s.split("/")[1])] });
  const e = env(mkPolicy({ owner: { mode: "dynamic", source: "all-providers", enforcement: "enforce" }, rows, withProv: true }), { slot: null });
  await learn(e, OPUS);
  const got = new Set();
  for (let i = 0; i < 20; i++) { e.tick(100); got.add(await e.route(bigReq(`mw-${i}`, BIGB), { Providers: providers }, {})); }
  assert.deepEqual([...got], ["prov1/known"], "600 unknown rows precede the only known row: it still wins");
});

test("R-v3 F5: a worker whose descriptor points at a file ANOTHER worker rotated reopens the path at its next size check", async () => {
  const e = env(POL(), { slot: null });
  const f = (n) => path.join(e.state, n);
  const fire = async (tag, n = 50) => { for (let i = 0; i < n; i++) { e.tick(100); await e.route(aux(HAIKU, { agent: `${tag}${i}` }), CFG, {}); } };
  await fire("a");                                                                             // 50 lines in classify.jsonl, descriptor open
  fs.renameSync(f("classify.jsonl"), f("classify.1.jsonl")); fs.writeFileSync(f("classify.jsonl"), "");   // another worker rotated: a new file stands at the path
  await fire("b");                                                                             // lines 51 to 100 still reach the renamed file; the check at the 100th append notices
  await fire("c", 10);
  const lines = (n) => fs.readFileSync(f(n), "utf8").split("\n").filter(Boolean).length;
  assert.equal(lines("classify.jsonl"), 10, "the next lines land in the file at the path");
  assert.equal(lines("classify.1.jsonl"), 100);
});

test("R-v3 F5: a rotation another worker already did shifts NO generation: the claim rename fails with ENOENT and the older files are untouched", async () => {
  const e = env(POL(), { slot: null });
  const f = (n) => path.join(e.state, n), MiB = 1024 * 1024;
  fs.writeFileSync(f("classify.1.jsonl"), "G1\n"); fs.writeFileSync(f("classify.2.jsonl"), "G2\n");
  const real = e.route.__test.fs;
  e.route.__test.fs = { ...real, statSync: (p, ...a) => { const s = real.statSync(p, ...a); return String(p).endsWith("classify.jsonl") ? { size: 9 * MiB, ino: 0 } : s; },
    renameSync: (a, b) => { if (/\.rot-/.test(String(b))) throw Object.assign(new Error("ENOENT: taken by another worker"), { code: "ENOENT" }); return real.renameSync(a, b); } };
  for (let i = 0; i < 50; i++) { e.tick(100); await e.route(aux(HAIKU, { agent: `r${i}` }), CFG, {}); }   // the 50th append sees "9 MiB" and tries to rotate
  assert.equal(fs.readFileSync(f("classify.1.jsonl"), "utf8"), "G1\n", "generation 1 was not shifted");
  assert.equal(fs.readFileSync(f("classify.2.jsonl"), "utf8"), "G2\n", "generation 2 was not overwritten");
  assert.equal(e.counters().logDropped ?? 0, 0, "and the log stayed up");
});

test("R-v3 F7: a rotation removes a STRAY claim file older than 10 minutes, keeps a fresh one (another worker mid-rotation) and touches no other name", async () => {
  const e = env(POL(), { slot: null });
  const f = (n) => path.join(e.state, n), MiB = 1024 * 1024;
  const plant = (n, ageMs) => { fs.writeFileSync(f(n), "stray\n"); const t = new Date(Date.now() - ageMs); fs.utimesSync(f(n), t, t); };
  plant("classify.rot-zz.jsonl", 3600000);                                                     // a crashed rotation, an hour old: removed
  plant("classify.rot-yy.jsonl", 60000);                                                       // another worker mid-rotation, a minute old: kept
  plant("decisions.rot-zz.jsonl", 3600000);                                                    // another log's stray: not this rotation's business
  plant("classify.rotx.jsonl", 3600000); plant("classify.rot-zz.txt", 3600000); plant("classify.2x.jsonl", 3600000); plant("notes.jsonl", 3600000);
  fs.writeFileSync(f("classify.jsonl"), (JSON.stringify({ pad: "x".repeat(1000) }) + "\n").repeat(Math.ceil(8.1 * MiB / 1010)));
  for (let i = 0; i < 50; i++) { e.tick(100); await e.route(aux(HAIKU, { agent: `s${i}` }), CFG, {}); }
  assert.ok(fs.existsSync(f("classify.1.jsonl")), "the rotation happened");
  assert.ok(!fs.existsSync(f("classify.rot-zz.jsonl")), "the old stray claim file is gone");
  for (const n of ["classify.rot-yy.jsonl", "decisions.rot-zz.jsonl", "classify.rotx.jsonl", "classify.rot-zz.txt", "classify.2x.jsonl", "notes.jsonl"]) assert.ok(fs.existsSync(f(n)), `${n} is untouched`);
  assert.ok(![...fs.readdirSync(e.state)].some((n) => /^classify\.rot-/.test(n) && n !== "classify.rot-yy.jsonl" && n !== "classify.rot-zz.txt"), "no claim file of this rotation is left");
});

// =====================================================================================================================
// Latency harness (O4a). The measurements live HERE, once, and are used twice: by the loose-ceiling tests of this suite (a machine under load must not fail a build) and by the strict
// standalone script test/perf/subagent-router-perf.mjs (the plan's numbers, best of 3 batches, run on a quiet machine). Importing this file with UW_HELPERS_ONLY=1 registers no test.
// =====================================================================================================================
/** 1,800 rows over 60 providers. kind "pool": tiered and priced rows with a payload cap on every fifth (the F25 / R4 world); kind "plain": the handoff world. */
export function bigWorld(kind = "pool") {
  const rows = [], providers = [];
  for (let p = 0; p < 60; p++) {
    const models = [];
    for (let i = 0; i < 30; i++) {
      models.push(`m${i}`);
      rows.push(kind === "pool" ? row(`prov${p}/m${i}`, { c: 131072 + i * 1000, t: i % 3 === 0 ? "t" : "u", i: `$${i}/$${i * 2}`, pb: i % 5 === 0 ? 245760 : 0 })
        : row(`prov${p}/m${i}`, { c: 131072 + i * 1000, pb: i % 5 === 0 ? 245760 : 0 }));
    }
    providers.push([`prov${p}`, models]);
  }
  return { rows, providers, config: cfg(...providers) };
}
const quantile = (times, x) => { const t = [...times].sort((a, b) => a - b); return t[Math.floor(x * (t.length - 1))]; };
export const latencyStats = (times) => ({ n: times.length, p50: quantile(times, 0.5), p99: quantile(times, 0.99), max: Math.max(...times) });
/** Warm sticky hits (rounds x 50 calls) and first decisions of NEW agents (fresh calls), in one router copy, in milliseconds. */
export async function measurePool(enforcement, source, { rounds = 20, fresh = 400 } = {}) {
  const { rows, config } = bigWorld("pool");
  const e = env(mkPolicy({ owner: { mode: "dynamic", source, enforcement }, rows, withProv: true, all: source === "all-providers" ? null : undefined }), { slot: null });
  try {
    await e.route(main("prov7/zz", { sid: "b1" }), config, {});
    for (let i = 0; i < 50; i++) { e.tick(60); await e.route(sub("nowhere/x", { sid: "b1", agent: `warm${i}`, bytes: 100000 }), config, {}); }
    const warm = [], fr = [];
    for (let r = 0; r < rounds; r++) for (let i = 0; i < 50; i++) { e.tick(60); const t0 = process.hrtime.bigint(); await e.route(sub("nowhere/x", { sid: "b1", agent: `warm${i}`, bytes: 100000 }), config, {}); warm.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    for (let i = 0; i < fresh; i++) { e.tick(60); const t0 = process.hrtime.bigint(); await e.route(sub("nowhere/x", { sid: "b1", agent: `new${i}`, bytes: 100000 }), config, {}); fr.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    return { warm, fresh: fr, rows: rows.length, providers: 60 };
  } finally { await e.drain(); fs.rmSync(e.dir, { recursive: true, force: true }); }
}
/** The handoff path (cooling and overlay reads active): n agents, each decided, then retried once; the retried request is timed. */
export async function measureHandoff(tag, { n = 300 } = {}) {
  const { rows, config } = bigWorld("plain");
  const e = env(HPOL(rows), { slot: null });
  try {
    writeOverlay(e, { "prov3/m0": { s: "rate", a: (OVERLAY_T - 1000) / 1000 } });
    await learn(e, SONNET);
    const times = [];
    for (let i = 0; i < n; i++) {
      e.tick(60); await e.route(retried(`hb${tag}${i}`, 5, { bytes: 100000 }), config, {});
      e.tick(60);
      const r = retried(`hb${tag}${i}`, 5, { bytes: 100000 }); r.body.system = "S";
      const t0 = process.hrtime.bigint();
      await e.route(r, config, {});
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const c = e.counters();
    return { times, handoffs: c.handoff, accounted: c.handoff + c.handoffNone + c.handoffCap, rows: rows.length, providers: 60 };
  } finally { await e.drain(); fs.rmSync(e.dir, { recursive: true, force: true }); }
}
/** The unit-size warm budget (10,000 calls over four request shapes, shadow, 7 rows): returns the sorted times. */
export async function measureWarmSmall(calls = 10000) {
  const e = env(POL({ mode: "dynamic", source: "all-providers", enforcement: "shadow" }), { slot: null });
  try {
    await learn(e, SONNET);
    const reqs = [main(SONNET), sub(HAIKU, { agent: "a1" }), sub("groq/g2", { agent: "a2" }), aux(HAIKU, { agent: "a3" })];
    for (let i = 0; i < 200; i++) await e.route(reqs[i % 4], CFG, {});
    const times = [];
    for (let i = 0; i < calls; i++) { const t0 = process.hrtime.bigint(); await e.route(reqs[i % 4], CFG, {}); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
    return times;
  } finally { await e.drain(); fs.rmSync(e.dir, { recursive: true, force: true }); }
}
/** What the standalone perf script reuses (the harness helpers above, not copies of them). */
export { env, mkPolicy, row, cfg, main, sub, learn, retried, HPOL, POL };

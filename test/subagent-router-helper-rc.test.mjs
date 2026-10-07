// Router v4: a request that Claude Code itself labels a helper call (x-claude-code-request-class: auxiliary or compaction) is the AUX class even when it carries an agent id, the billing
// flag or the full tool list: passthrough, never rewritten, no sticky entry, no retry signal, no handoff, no learnMain. Self-contained: every test copies the router into a scratch tree
// (tmp/spike/uw-router.cjs, state in tmp/state/subagent) and NEVER touches live state.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as LIB from "../keysync/subagent-policy.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = process.env.UW_TEST_ROUTER || path.join(ROOT, "router", "uw-router.next.cjs");   // the override lets a mutation run point the whole file at a mutated copy
const req$ = createRequire(import.meta.url);
const OPUS = "anthropic/claude-opus-5", ASKED = "nowhere/x";
const CFG = { Providers: [{ name: "anthropic", models: ["claude-opus-5"] }, { name: "groq", models: ["g1", "g2", "g3", "g4"] }] };
const TOOLS = [{ name: "Read" }, { name: "Bash" }, { name: "Edit" }];
const AGENT_TOOL = { name: "Agent", description: "spawn", input_schema: { properties: { prompt: { description: "p" } } } };
const tmps = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

function policy(owner = {}) {
  const models = ["groq/g1", "groq/g2", "groq/g3", "groq/g4"].map((s, i) => ({ g: i, b: 0, s, c: 200000, f: 0, t: "u", h: 0, m: 0, n: 0, i: "$1/$2", p: 0, pb: 0, al: 0, fp: 0, ft: 0 }));
  const idx = models.map((_, i) => i);
  const p = { schema: 1, contentHash: "", compiledAt: "2026-10-03T00:00:00.000Z",
    owner: { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "enforce", inject: "off", unverified: "allow-warn", classLog: "on", ...owner },
    builtFrom: {}, empty: false, emptyReasons: [], emptyProviders: [], thinProviders: ["h-rc"], tiers: {}, substitutable: {}, exempt: [], ctxHints: {},
    counts: { universe: 4, allowed: 4, unverified: 4, premium: 0, payloadRisk: 0 }, models, lists: { all: null, byProvider: { groq: idx }, prov: { groq: idx } },
    main: { ttlSec: 21600 }, sticky: { ttlSec: 21600, maxEntries: 256 }, inject: { all: "INJECTED-TEXT", byProvider: {}, empty: "", promptNote: "" } };
  p.contentHash = LIB.hashOf(p);
  return p;
}
function env(owner = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-hrc-")); tmps.push(dir);
  const spike = path.join(dir, "spike"), state = path.join(dir, "state", "subagent");
  fs.mkdirSync(spike, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  const live = path.join(spike, "uw-router.cjs");
  fs.copyFileSync(NEXT, live);
  fs.writeFileSync(path.join(state, "policy.json"), JSON.stringify(policy(owner)));
  const route = req$(live);
  route.__test.reset();
  let clock = Date.parse("2026-10-03T12:00:00.000Z");
  route.__test.now = () => clock;
  const lines = (f) => { try { return fs.readFileSync(path.join(state, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { route, lines, tick: (ms) => { clock += ms; }, counters: () => ({ ...(globalThis.__uwSub?.counters ?? {}) }), sticky: () => globalThis.__uwSub.agent.size, mains: () => globalThis.__uwSub.main.size };
}
const mainReq = (sid = "s1") => ({ body: { model: OPUS, tools: [AGENT_TOOL, ...TOOLS] }, headers: { "x-claude-code-session-id": sid }, sessionId: sid });
/** A subagent-shaped request (agent id, billing flag, tools); `rc` is the request-class header value, `len` the messages length (an unchanged length is the retry signal). */
const subReq = (agent, { rc, len = 3, sid = "s1", bl = true, noAgent = false, tools = TOOLS, model = ASKED } = {}) => ({
  body: { model, tools, messages: Array.from({ length: len }, () => ({ role: "user", content: "x" })) }, sessionId: sid, builtInClaudeCodeSubagent: bl,
  headers: { "x-claude-code-session-id": sid, ...(noAgent ? {} : { "x-claude-code-agent-id": agent }), ...(rc === undefined ? {} : { "x-claude-code-request-class": rc }) } });
const learned = async (owner) => { const e = env(owner); await e.route(mainReq(), CFG, {}); return e; };

test("rc auxiliary or compaction WITH an agent id, the billing flag and a full tool list is the aux class: returned as asked under enforce, no sticky entry, no decision line, no handoff", async () => {
  for (const rc of ["auxiliary", "compaction"]) {
    const e = await learned();
    const c0 = e.counters();
    assert.equal(await e.route(subReq("h1", { rc }), CFG, {}), ASKED, `${rc}: not rewritten`);
    const c = e.counters();
    assert.equal(c.aux - c0.aux, 1, `${rc}: counted aux`);
    assert.equal(c.sub - c0.sub, 0, `${rc}: not a subagent decision`);
    assert.equal(e.sticky(), 0, `${rc}: no sticky entry`);
    assert.equal(e.lines("decisions.jsonl").filter((l) => l.aid === "h1").length, 0);
    assert.equal(e.lines("agents.jsonl").filter((l) => l.aid === "h1").length, 0);
    const l = e.lines("classify.jsonl").at(-1);
    assert.deepEqual([l.cls, l.rc, l.ag, l.bl, l.nt], ["aux", rc, 1, 1, 3], `${rc}: the classify line records class aux and the rc`);
  }
});

test("a helper call is never retried or handed off: the same helper request twice (the length retry signal) and with the SDK retry header changes nothing", async () => {
  const e = await learned();
  const c0 = e.counters();
  for (let i = 0; i < 4; i++) {
    e.tick(1000);
    const r = subReq("h2", { rc: "auxiliary" }); if (i % 2) r.headers["x-stainless-retry-count"] = String(i);
    assert.equal(await e.route(r, CFG, {}), ASKED);
  }
  const c = e.counters();
  assert.deepEqual([c.retry - c0.retry, c.handoff - c0.handoff, c.handoffNone - c0.handoffNone, c.coolMark - c0.coolMark, c.noticeApplied - c0.noticeApplied], [0, 0, 0, 0, 0]);
  assert.equal(e.lines("agents.jsonl").filter((l) => l.act === "handoff").length, 0);
});

test("the control: the same request WITHOUT the helper label, or with rc subagent, is decided as before (substituted under enforce, sticky entry, retry and handoff on the length signal)", async () => {
  for (const rc of [undefined, "subagent", "workflow", "main", "bogus"]) {
    const e = await learned();
    const first = await e.route(subReq("c1", { rc }), CFG, {});
    assert.match(first, /^groq\/g[1-4]$/, `rc ${JSON.stringify(rc)}: substituted`);
    assert.equal(e.sticky(), 1);
    e.tick(1000);
    await e.route(subReq("c1", { rc }), CFG, {});
    assert.equal(e.counters().retry, 1, `rc ${JSON.stringify(rc)}: the length retry signal still fires for a real subagent`);
  }
});

test("a FORGED helper label on a real subagent request only makes it pass through unrewritten (the safe direction): the asked model, no sticky, no policy decision", async () => {
  const e = await learned();
  const real = await e.route(subReq("f0"), CFG, {});
  assert.notEqual(real, ASKED, "unlabelled, the request is rewritten");
  const forged = await e.route(subReq("f1", { rc: "auxiliary" }), CFG, {});
  assert.equal(forged, ASKED, "labelled, it is not");
  assert.equal(e.sticky(), 1, "only the unlabelled agent has a sticky entry");
  assert.equal(e.counters().sub, 1);
});

test("main-thread helpers (rc auxiliary or compaction, NO agent id, the Agent tool in the list) take the aux path: they teach no main model and get no injection", async () => {
  for (const rc of ["auxiliary", "compaction"]) {
    const e = env({ inject: "on" });
    const r = { body: { model: OPUS, tools: [structuredClone(AGENT_TOOL), ...TOOLS] }, headers: { "x-claude-code-session-id": "s9", "x-claude-code-request-class": rc }, sessionId: "s9" };
    assert.equal(await e.route(r, CFG, {}), OPUS);
    assert.equal(e.mains(), 0, `${rc}: learnMain was not called`);
    assert.equal(r.body.tools[0].description, "spawn", `${rc}: the Agent tool description was not rewritten`);
    assert.equal(e.counters().aux, 1); assert.equal(e.counters().main ?? 0, 0);
    assert.equal(e.lines("classify.jsonl").at(-1).cls, "aux");
    const m = { body: { model: OPUS, tools: [structuredClone(AGENT_TOOL), ...TOOLS] }, headers: { "x-claude-code-session-id": "s9", "x-claude-code-request-class": "main" }, sessionId: "s9" };
    await e.route(m, CFG, {});                                                                   // the control: a real main request still teaches main and is injected
    assert.equal(e.mains(), 1);
    assert.match(m.body.tools[0].description, /INJECTED-TEXT/);
  }
});

test("header value variants: case and surrounding whitespace do not matter; anything else is not a helper label", async () => {
  for (const v of ["AUXILIARY", " Auxiliary ", "\tcompaction\n", "Compaction", "auxiliary "]) {
    const e = await learned();
    assert.equal(await e.route(subReq("v1", { rc: v }), CFG, {}), ASKED, JSON.stringify(v));
    assert.equal(e.sticky(), 0, JSON.stringify(v));
    assert.equal(e.lines("classify.jsonl").at(-1).cls, "aux");
  }
  for (const v of ["auxiliaryx", "aux", "compact", "auxiliary,subagent", "", "x".repeat(200), "auxiliary" + " ".repeat(30) + "x", "subagent"]) {
    const e = await learned();
    assert.match(await e.route(subReq("v2", { rc: v }), CFG, {}), /^groq\//, `${JSON.stringify(v.slice(0, 20))} is not a helper label`);
    assert.equal(e.sticky(), 1);
  }
  const arr = subReq("v3"); arr.headers["x-claude-code-request-class"] = ["auxiliary", "subagent"];   // an array header (the first value counts, as everywhere in the router)
  const e = await learned();
  assert.equal(await e.route(arr, CFG, {}), ASKED);
});

test("the classify log derives rc from the NORMALISED value: ' Auxiliary ' and 'COMPACTION' log rc auxiliary and compaction; an unknown value still logs null", async () => {
  const e = await learned();
  for (const [v, want] of [[" Auxiliary ", "auxiliary"], ["COMPACTION", "compaction"], ["\tSubagent\n", "subagent"], ["auxiliary", "auxiliary"], ["bogus", null], ["", null]]) {
    await e.route(subReq("lg", { rc: v }), CFG, {});
    assert.equal(e.lines("classify.jsonl").at(-1).rc, want, JSON.stringify(v));
  }
});

test("shadow mode: a main-thread helper (no agent id, no billing flag, rc compaction, the Agent tool, inject on) is aux: no learnMain, no injection, class aux", async () => {
  for (const rc of ["compaction", " AUXILIARY "]) {
    const e = env({ enforcement: "shadow", inject: "on" });
    const r = { body: { model: OPUS, tools: [structuredClone(AGENT_TOOL), ...TOOLS] }, headers: { "x-claude-code-session-id": "s7", "x-claude-code-request-class": rc }, sessionId: "s7" };
    assert.equal(await e.route(r, CFG, {}), OPUS);
    assert.equal(e.mains(), 0, "no learnMain in shadow either");
    assert.equal(r.body.tools[0].description, "spawn", "no injection in shadow either");
    assert.equal(e.lines("classify.jsonl").at(-1).cls, "aux");
    assert.equal(e.counters().aux, 1);
    const m = { body: { model: OPUS, tools: [structuredClone(AGENT_TOOL), ...TOOLS] }, headers: { "x-claude-code-session-id": "s7", "x-claude-code-request-class": "main" }, sessionId: "s7" };
    await e.route(m, CFG, {});                                                                   // the control: a real main request still teaches main and is injected in shadow
    assert.equal(e.mains(), 1);
    assert.match(m.body.tools[0].description, /INJECTED-TEXT/);
  }
});

test("shadow mode: a labelled helper is aux too (no would-substitute line, no retry count); and the class and rc are what the classify log records", async () => {
  const e = await learned({ enforcement: "shadow" });
  for (let i = 0; i < 3; i++) { e.tick(500); assert.equal(await e.route(subReq("s1x", { rc: "compaction" }), CFG, {}), ASKED); }
  assert.equal(e.counters().retry, 0);
  assert.equal(e.lines("decisions.jsonl").filter((l) => l.aid === "s1x").length, 0);
  const cl = e.lines("classify.jsonl").filter((l) => l.aid === "s1x");
  assert.equal(cl.length, 3);
  assert.ok(cl.every((l) => l.cls === "aux" && l.rc === "compaction"));
  const un = env({ enforcement: "shadow" }); await un.route(mainReq(), CFG, {});
  await un.route(subReq("s1y"), CFG, {});
  assert.equal(un.lines("classify.jsonl").at(-1).cls, "sub", "the unlabelled control is still a subagent");
});

// The sticky journal, per-worker status and cross-worker main (router v2: ar-2, ar-6, ar-9) with REAL child processes: each child loads a COPY of the
// router from a scratch tree (laid out as tmp/spike/uw-router.cjs, so its state path is tmp/state/subagent) and shares that state folder with the others.
// Nothing here touches the live state, the vault or the gateway; every tree is a fresh mkdtemp under os.tmpdir().
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as LIB from "../keysync/subagent-policy.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = process.env.UW_TEST_ROUTER || path.join(ROOT, "router", "uw-router.next.cjs");   // the override lets a mutation run point the whole file at a mutated copy
const req$ = createRequire(import.meta.url);
const T0 = Date.parse("2026-10-03T12:00:00.000Z");
const SONNET = "anthropic/claude-sonnet-5-5", HAIKU = "anthropic/claude-haiku-4-5", OPUS = "anthropic/claude-opus-5";

const row = (s, o = {}) => ({ s, c: 200000, f: 0, t: "u", h: 0, m: 0, n: 0, i: "$1/$2", p: 0, pb: 0, al: 0, fp: 0, ft: 0, ...o });
const ROWS = [row(SONNET, { c: 1000000 }), row(HAIKU), row(OPUS, { c: 1000000 }), row("groq/g1"), row("groq/g2"), row("groq/g3"), row("groq/g4")];
function policy(owner = {}) {
  const models = ROWS.map((r, i) => ({ g: i, ...r }));
  const bp = {}; models.forEach((r, i) => { (bp[r.s.split("/")[0]] ??= []).push(i); });
  const p = { schema: 1, contentHash: "", compiledAt: "2026-10-03T00:00:00.000Z",
    owner: { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "enforce", inject: "off", unverified: "allow-warn", classLog: "on", ...owner },
    builtFrom: {}, empty: false, emptyReasons: [], emptyProviders: [], thinProviders: [], tiers: {}, substitutable: {}, exempt: [], ctxHints: {},
    counts: { universe: 7, allowed: 7, unverified: 7, premium: 0, payloadRisk: 0 }, models, lists: { all: null, byProvider: bp, prov: bp }, main: { ttlSec: 21600 }, inject: { all: "", byProvider: {}, empty: "E", promptNote: "" } };
  p.contentHash = LIB.hashOf(p);
  return p;
}
const CONFIG = { Providers: [{ name: "anthropic", models: ["claude-sonnet-5-5", "claude-haiku-4-5", "claude-opus-5"] }, { name: "groq", models: ["g1", "g2", "g3", "g4"] }] };
const sub = (agent, { sid = "s1", model = "nowhere/x", len } = {}) => ({ body: { model, tools: [{ name: "Read" }], ...(len ? { messages: Array.from({ length: len }, () => ({})) } : {}) }, sessionId: sid,
  builtInClaudeCodeSubagent: true, headers: { "x-claude-code-session-id": sid, "x-claude-code-agent-id": agent } });
const mainReq = (model, sid = "s1") => ({ body: { model, tools: [{ name: "Agent" }, { name: "Read" }] }, headers: { "x-claude-code-session-id": sid }, sessionId: sid });

function tree(pol) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-jr-"));
  const spike = path.join(dir, "spike"), state = path.join(dir, "state", "subagent");
  fs.mkdirSync(spike, { recursive: true }); fs.mkdirSync(state, { recursive: true });
  fs.copyFileSync(NEXT, path.join(spike, "uw-router.cjs"));
  fs.writeFileSync(path.join(spike, "slot.json"), JSON.stringify({ model: OPUS }));
  if (pol) fs.writeFileSync(path.join(state, "policy.json"), JSON.stringify(pol));
  fs.writeFileSync(path.join(dir, "child.cjs"), `
    const fs = require("node:fs");
    const route = require(process.argv[2]);
    const job = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
    route.__test.reset();
    let clock = job.clock; route.__test.now = () => clock;
    (async () => {
      const out = [];
      for (const s of job.steps) { if (s.tick) clock += s.tick; else out.push(await route(s.req, job.config, {})); }
      if (job.drain) { const t0 = Date.now(); while (globalThis.__uwSub && globalThis.__uwSub.wr.size > 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 2)); }
      if (job.flush) route.__test.flush();
      process.stdout.write(JSON.stringify(out));
      if (job.hardExit) process.exit(0);
    })();`);
  const live = path.join(spike, "uw-router.cjs");
  let n = 0;
  const run = (steps, o = {}) => {
    const job = path.join(dir, `job${n++}.json`);
    fs.writeFileSync(job, JSON.stringify({ clock: T0, config: CONFIG, steps, ...o }));
    return { job, args: [path.join(dir, "child.cjs"), live, job] };
  };
  const runSync = (steps, o) => { const { args } = run(steps, o); const r = spawnSync(process.execPath, args, { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  const runAsync = (steps, o) => new Promise((resolve, reject) => {
    const { args } = run(steps, o); let out = "", err = "";
    const c = spawn(process.execPath, args);
    c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });
  const inproc = () => {
    const route = req$(live); route.__test.reset();
    let clock = T0; route.__test.now = () => clock;
    return { route, tick: (ms) => { clock += ms; }, setClock: (t) => { clock = t; }, counters: () => globalThis.__uwSub?.counters ?? {} };
  };
  const lines = (f) => fs.readFileSync(path.join(state, f), "utf8").split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  return { dir, state, live, runSync, runAsync, inproc, lines };
}

test("ar-2: KILL RECOVERY: a worker decides 20 agents and is killed without a flush; a fresh worker whose main CHANGED answers every one of them with the original model (stk 1), from the journal alone", () => {
  const t = tree(policy({ source: "same-provider" }));
  const agents = Array.from({ length: 20 }, (_, i) => `k${i}`);
  const first = t.runSync([{ req: mainReq(SONNET) }, ...agents.map((a) => ({ req: sub(a) }))], { hardExit: true });
  const models = first.slice(1);
  assert.ok(models.every((m) => /^anthropic\//.test(m)), "main on anthropic: substitutes come from anthropic");
  const journal = t.lines("agents-s1.jsonl");
  assert.equal(journal.length, 20, "one journal line per decision, written synchronously before the kill");
  fs.rmSync(path.join(t.state, "main-s1.json"), { force: true });
  // O2 (CHANGED from mainReq(HAIKU), another model of the SAME provider): main is now on ANOTHER PROVIDER; under same-provider the old router re-decided every journalled agent on groq,
  // the new one lets STARTED agents stay (the entry is valid while its model is in the whole compiled set), so the answer is still the original anthropic model
  const second = t.runSync([{ req: mainReq("groq/g1") }, ...agents.map((a) => ({ req: sub(a) }))], { drain: true });
  assert.deepEqual(second.slice(1), models, "the original models, although main is now on another PROVIDER (O2: started agents stay; a fresh decision would start from main's own provider)");
  const stk = t.lines("decisions.jsonl").filter((l) => l.stk === 1 && l.act === "sticky");
  assert.equal(stk.length, 20, "every agent's first hit is logged with stk 1");
  const fresh = t.runSync([{ req: mainReq("groq/g1", "s2") }, ...agents.map((a) => ({ req: sub(a, { sid: "s2" }) }))]);
  assert.ok(fresh.slice(1).every((m) => /^groq\//.test(m)), "control: without the journal the same agents decide fresh on groq");
});

test("ar-2 + R6: a torn tail and unparsable lines: complete lines replay, the last line per key wins, a partial last line is ignored; a NEW agent the router appends AFTER the torn tail (its append starts with a newline, S-F10) replays in another process", async () => {
  const t = tree(policy());
  const line = (o) => JSON.stringify(o) + "\n";
  const file = path.join(t.state, "agents-s1.jsonl");
  fs.writeFileSync(file, line({ k: "a1", m: "groq/g1", t: T0 - 1000, h: "x" }) + "this is not json\n" + line({ k: "a1", m: "groq/g2", t: T0 - 500, h: "x" }) + line({ k: "a2", m: "groq/g3", t: T0 - 400, h: "x" })
    + '{"k":"a3","m":"groq/g4","t":' + (T0 - 300));                                       // a crash in the middle of the last line: NO newline at the end
  const w = t.inproc();
  const ask = (a) => w.route(sub(a), CONFIG, {});
  await w.route(mainReq(SONNET), CONFIG, {});
  assert.equal(await ask("a1"), "groq/g2", "the last line per key wins");
  assert.equal(await ask("a2"), "groq/g3");
  const a3 = await ask("a3");
  assert.notEqual(a3, "groq/g4", "the partial line is not an entry (a3 is decided fresh)");
  const a4 = await ask("a4");                                                              // decided fresh: the router appends AFTER the torn tail, with nothing deleted first
  assert.equal(w.counters().error ?? 0, 0);
  assert.ok(w.counters().stickyJournalTorn >= 1, "the torn and the unparsable lines were counted");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.includes('"t":' + (T0 - 300) + "\n"), "the torn fragment is still there, and ends its own line");
  const second = t.runSync([{ req: mainReq(SONNET) }, { req: sub("a4") }, { req: sub("a3") }, { req: sub("a1") }], {});
  assert.deepEqual(second.slice(1), [a4, a3, "groq/g2"], "another process replays the entries appended after the torn tail, and still not the torn one");
});

test("ar-2: TWO WORKERS interleaving appends for one session: every journal line parses, the union is visible to a third worker, and each agent has the model its own worker chose", async () => {
  const t = tree(policy());
  const ids = (p) => Array.from({ length: 60 }, (_, i) => `${p}${i}`);
  const [ra0, rb0] = await Promise.all([t.runAsync([{ req: mainReq(SONNET) }, ...ids("A").map((a) => ({ req: sub(a) }))]), t.runAsync([{ req: mainReq(SONNET) }, ...ids("B").map((a) => ({ req: sub(a) }))])]);
  const ra = ra0.slice(1), rb = rb0.slice(1);                                                  // S-F6: each worker's first request is a main request with an Agent tool
  const raw = fs.readFileSync(path.join(t.state, "agents-s1.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.equal(raw.length, 120);
  for (const l of raw) JSON.parse(l);
  const w = t.inproc();
  const got = [];
  for (const a of [...ids("A"), ...ids("B")]) got.push(await w.route(sub(a), CONFIG, {}));
  assert.deepEqual(got, [...ra, ...rb], "the third worker answers every agent with what its first worker chose");
  assert.equal(w.counters().stickyHit, 120);
});

test("ar-2: a failing journal write (EIO) never throws or sleeps: the request returns at once, journalFail counts it and the entry stays in memory", async () => {
  const t = tree(policy());
  const w = t.inproc();
  await w.route(mainReq(SONNET), CONFIG, {});
  w.route.__test.fs = { ...fs, writeSync: () => { throw Object.assign(new Error("EIO"), { code: "EIO" }); } };   // SEC-5: the journal is written through a held descriptor, not appendFileSync
  const t0 = process.hrtime.bigint();
  const r = await w.route(sub("e1"), CONFIG, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(typeof r === "string" && r !== "nowhere/x");
  assert.ok(ms < 25, `${ms.toFixed(2)} ms: no sleep, no retry`);
  assert.equal(w.counters().journalFail, 1);
  assert.ok(globalThis.__uwSub.agent.has("s1:e1"), "the entry is in memory");
  assert.equal(await w.route(sub("e1"), CONFIG, {}), r, "and is sticky");
  assert.equal(w.counters().error ?? 0, 0);
});

test("ar-6: per-worker status: two worker processes write status-<w>.json; the merged read sums the counters, unions the warnings with the oldest since and keeps the newest main; show prints the totals; a stale file of a dead process is pruned", async () => {
  const t = tree(policy({ enforcement: "shadow" }));
  const A = await t.runAsync([{ req: mainReq(SONNET, "ma") }, ...Array.from({ length: 7 }, (_, i) => ({ req: sub(`a${i}`, { sid: "ma" }) }))], { flush: true, drain: true, clock: Date.now() });                  // the status files carry real times: "live" means seen within 30 minutes
  const B = await t.runAsync([{ req: mainReq(HAIKU, "mb") }, ...Array.from({ length: 5 }, (_, i) => ({ req: sub(`b${i}`, { sid: "mb" }) }))], { flush: true, drain: true, clock: Date.now() + 1000 });
  assert.equal(A.length + B.length, 14);
  const files = fs.readdirSync(t.state).filter((f) => /^status-[0-9a-z]+\.json$/.test(f));
  assert.equal(files.length, 2, "one status file per worker");
  const parts = files.map((f) => JSON.parse(fs.readFileSync(path.join(t.state, f), "utf8")));
  for (const p of parts) assert.ok(p.counters.sub === 7 || p.counters.sub === 5);
  const merged = LIB.readStatus(path.join(t.state, "status.json"));
  assert.ok(merged.ok);
  assert.equal(merged.status.counters.sub, 12); assert.equal(merged.status.counters.req, parts[0].counters.req + parts[1].counters.req); assert.equal(merged.status.workers, 2);
  assert.deepEqual(Object.keys(merged.status.mainBySession).sort(), ["ma", "mb"]);
  assert.equal(merged.status.routerVersion, 2);
  const out = [];
  const code = await LIB.runSubagentPolicy(["show", "--policy-file", path.join(t.dir, "owner.json"), "--state-dir", path.dirname(t.state)], { out: (l) => out.push(l), err: () => {} });
  assert.equal(code, 0);
  const line = out.find((l) => l.startsWith("status: router last seen"));
  assert.match(line, /sub 12,/, line);
  assert.ok(out.some((l) => /merged over 2 router worker status files/.test(l)));
  // a stale file of a dead process is pruned by the next gc pass; a live worker's file is not
  const dead = path.join(t.state, "status-zzzzzz.json");
  fs.writeFileSync(dead, JSON.stringify({ schema: 1, pid: 2147483000, updatedAt: new Date(T0 - 30 * 3600000).toISOString(), counters: { req: 999 } }));
  fs.utimesSync(dead, new Date(T0 - 30 * 3600000), new Date(T0 - 30 * 3600000));
  const w = t.inproc();
  for (let i = 0; i < 60; i++) await w.route(sub(`g${i}`, { sid: "gc" }), CONFIG, {});
  assert.ok(!fs.existsSync(dead), "the stale status file of a dead process is removed");
  assert.equal(fs.readdirSync(t.state).filter((f) => /^status-/.test(f) && f !== "status.json").length >= 2, true, "the live workers' files stay");
});

test("ar-9 (two real processes): a second worker learns a newer main and writes it; this worker follows it after 5 s", async () => {
  const t = tree(policy({ source: "same-provider" }));
  const w = t.inproc();
  await w.route(mainReq(SONNET), CONFIG, {});
  assert.match(await w.route(sub("m1"), CONFIG, {}), /^anthropic\//);
  await t.runAsync([{ req: mainReq("groq/g1") }], { clock: T0 + 1000, drain: true });
  w.tick(3000);
  assert.match(await w.route(sub("m2"), CONFIG, {}), /^anthropic\//, "inside 5 s: memory only");
  w.tick(2100);
  assert.match(await w.route(sub("m3"), CONFIG, {}), /^groq\//, "after 5 s the other worker's newer main wins");
});

// ---------------------------------------------------------------------------------------------- fix round (R1, N06 across real processes)
test("R1 (two real processes): a handoff made by worker A is seen by worker B, which already holds the agent's sticky entry, on its next HIT after the 1.5 s throttle (not before); B does not mistake it for a retry of its own", async () => {
  const t = tree(policy());
  const w = t.inproc();                                                                         // worker B
  await w.route(mainReq(SONNET), CONFIG, {});
  const first = await w.route(sub("h1", { len: 5 }), CONFIG, {});                               // B decides the agent and holds the entry
  assert.match(first, /^(anthropic|groq)\//);
  // worker A (another process, 1 s later): the agent's request arrives there twice with the same transcript: a retry, so A hands the agent off and journals it
  const out = await t.runAsync([{ req: mainReq(SONNET) }, { req: sub("h1", { len: 5 }) }, { tick: 500 }, { req: sub("h1", { len: 5 }) }], { clock: T0 + 1000, drain: true });
  const handedTo = out[2];
  assert.notEqual(handedTo, first, "worker A handed the agent to another model");
  assert.ok(t.lines("agents-s1.jsonl").some((l) => l.r === "handoff" && l.m === handedTo), "its handoff line is in the shared journal");
  w.tick(1200);                                                                                  // 1.2 s after B's last look at the journal: inside the 1.5 s throttle
  assert.equal(await w.route(sub("h1", { len: 7 }), CONFIG, {}), first, "inside the throttle B's memory entry still answers");
  w.tick(1000);
  assert.equal(await w.route(sub("h1", { len: 9 }), CONFIG, {}), handedTo, "after the throttle B reads A's handoff on a hit and serves the new model");
  assert.equal(w.counters().handoff ?? 0, 0, "B made no handoff of its own");
  assert.equal(globalThis.__uwSub.agent.get("s1:h1").hops, 1);
});

test("N06 (two real processes): a touch line appended by worker A refreshes the sliding clock of the entry worker B already holds", async () => {
  const t = tree(policy());
  const w = t.inproc();
  await w.route(mainReq(SONNET), CONFIG, {});
  await w.route(sub("tt1"), CONFIG, {});
  assert.equal(globalThis.__uwSub.agent.get("s1:tt1").lt, T0);
  await t.runAsync([{ req: mainReq(SONNET) }, { req: sub("tt1") }], { clock: T0 + 11 * 60000, drain: true });        // 11 minutes later: more than 10 since the last touch, so A appends a touch line
  assert.ok(t.lines("agents-s1.jsonl").some((l) => l.k === "tt1" && Number.isFinite(l.u)), "A appended a touch line");
  w.setClock(T0 + 11 * 60000 + 2000);
  await w.route(sub("tt1"), CONFIG, {});
  assert.equal(globalThis.__uwSub.agent.get("s1:tt1").lt, T0 + 11 * 60000, "B's entry carries EXACTLY A's touch time (B's own request, 2 s later, made no touch of its own)");
});

// ---------------------------------------------------------------------------------------------- second fix round (RV-1 across real processes)
test("RV-1 REGRESSION (two real processes): a session first seen by worker A AFTER worker B built its file index is known to B: B's decision and its handoff for that session are JOURNALLED (the old B kept them in memory only, so A served the failed model again), and a fresh worker answers the handed-off model", async () => {
  const t = tree(policy());
  const w = t.inproc();                                                                          // worker B
  await w.route(mainReq(SONNET, "s0"), CONFIG, {});                                              // B builds its session-file index here
  await t.runAsync([{ req: mainReq(SONNET, "s1") }], { clock: T0 + 500, drain: true });          // worker A: session s1 starts in ANOTHER process
  assert.ok(fs.existsSync(path.join(t.state, "main-s1.json")), "A created main-s1.json after B built its index");
  const first = await w.route(sub("h1", { sid: "s1", len: 5 }), CONFIG, {});
  w.tick(1000);
  const to = await w.route(sub("h1", { sid: "s1", len: 5 }), CONFIG, {});                        // the same transcript again: a retry, so B hands the agent off
  assert.notEqual(to, first, "B handed the agent over");
  assert.equal(w.counters().handoff, 1);
  const j = t.lines("agents-s1.jsonl");
  assert.ok(j.some((l) => l.k === "h1" && l.m === first), "B's first decision is in the shared journal");
  assert.ok(j.some((l) => l.r === "handoff" && l.m === to), "and so is its handoff");
  const out = await t.runAsync([{ req: mainReq(SONNET, "s1") }, { req: sub("h1", { sid: "s1", len: 7 }) }], { clock: T0 + 3000, drain: true });
  assert.equal(out[1], to, "worker A (a fresh process) serves the handed-off model, not the one that failed");
  // the case it must not break: a session with no file anywhere still owns none (S-F6)
  await w.route(sub("z1", { sid: "nobody" }), CONFIG, {});
  assert.ok(!fs.existsSync(path.join(t.state, "agents-nobody.jsonl")));
});

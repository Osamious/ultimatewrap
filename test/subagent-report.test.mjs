// `subagent-policy report` (plan 7.2 item 13, stage S2a): the figures, their denominators, the frozen `--json` shape, the savings estimate and the read-only outcome join. Every run
// names fixture files: the in-process runner REFUSES an argv without `--state-dir`, so no test here can reach the real ~/.llmkeys, state/ or request log. The outcome tests build a
// FIXTURE SQLite database in a temp folder and open it through the production read-only opener; the real request log is never named.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixtureFlagMap } from "./fixtures/subagent-flags.mjs";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as lib from "../keysync/subagent-policy.mjs";
import * as rep from "../keysync/subagent-report.mjs";
import { loadSqlite } from "../refresh/observe.mjs";
import { dataDir } from "../menu/ccr-client.mjs";

guardRealState(after, assert);
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-rep-")); made.push(d); return d; };
after(() => { for (const d of made) if (path.dirname(d) === os.tmpdir() && path.basename(d).startsWith("uw-rep-")) fs.rmSync(d, { recursive: true, force: true }); });
const wr = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); };
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const INTERNAL_ID = /\b(?:D-[a-z]{1,2}|cr-[A-Za-z0-9]+|R-v2-\d+|ar-\d+|n:1|I\d{2}|QB-\d+|S\d+)\b/;
const dirHash = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } };
  walk(dir);
  return out;
};
const pad2 = (v) => String(v).padStart(2, "0");
const agoOf = (ms) => { const sec = Math.round(ms / 1000); return sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : sec < 172800 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`; };
const when = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} (${agoOf(NOW - d.getTime())} ago)`; };

function setup() {
  const dir = tmp();
  const m = fixtureFlagMap(dir);
  return { dir, root: m["state-dir"], state: path.join(m["state-dir"], "subagent"), snap: m["snapshot-file"], db: path.join(dir, "request-logs.sqlite") };
}
/** In-process run: refuses an argv that does not name a fixture state folder. */
async function run(argv, opts = {}) {
  assert.ok(argv.includes("--state-dir") || (argv[0] === "selftest" && argv.includes("--plan")), "every in-process run names a fixture --state-dir (a selftest plan reads no file at all)");
  const out = [], err = [];
  const status = await lib.runSubagentPolicy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, { now: NOW, ...opts });
  return { status, out: out.join("\n"), err: err.join("\n"), first: err[0] ?? out[0] ?? "", lines: out };
}
const REPORT = (s, ...a) => run(["report", ...a, "--state-dir", s.root, "--snapshot-file", s.snap]);

const L = (o) => JSON.stringify(o);
const MAIN = "anthropic/claude-sonnet-5-5";                       // listed at $3 per million input tokens in the fixture snapshot; haiku $1, opus $15, fxa-alpha $0, fxa-beta $0.1, fxa-gamma unlisted
const base = { v: 2, w: "a", sid: "s1aaaaaa", pid8: null, tag: null, main: MAIN, ph: "abc", ms: 0.3 };
const dec = (t, aid, asked, would, over = {}) => L({ ...base, t, aid, asked, act: would === null ? "keep" : "substitute", would, ret: asked, why: would === null ? null : "not-in-set", pol: "shadow", flags: [], path: "shadow", ...over });
const HAIKU = "anthropic/claude-haiku-4-5", OPUS = "anthropic/claude-opus-5", ALPHA = "fx-free-a/fxa-alpha", BETA = "fx-free-a/fxa-beta", GAMMA = "fx-free-a/fxa-gamma";
/** The three shapes the router's logAgent writes: 8 agent decisions in 3 sessions (one in a rotated file; path shadow or new), 1 hand-over line (path handoff), 2 unreadable lines. */
function writeLog(s) {
  const cur = [
    dec("2026-10-05T11:00:00.000Z", "agent-1", OPUS, ALPHA, { tc: 1000000 }),
    dec("2026-10-05T11:10:00.000Z", "agent-2", HAIKU, BETA, { tc: 500000 }),
    dec("2026-10-05T11:20:00.000Z", "agent-3", HAIKU, ALPHA, { tc: 2000000, ret: ALPHA, pol: "enforce", path: "new" }),
    dec("2026-10-05T11:25:00.000Z", "agent-4", HAIKU, ALPHA, { tc: null }),
    dec("2026-10-05T11:30:00.000Z", "agent-5", HAIKU, GAMMA, { tc: 100 }),
    dec("2026-10-05T11:35:00.000Z", "agent-6", HAIKU, null, { tc: null }),
    L({ ...base, t: "2026-10-05T11:40:00.000Z", aid: "agent-3", asked: HAIKU, act: "handoff", from: ALPHA, to: BETA, hop: 1, rsrc: "len", reason: "retry:len:2", would: BETA, ret: BETA, why: "retry:len:2", pol: "enforce", flags: [], path: "handoff" }),
    dec("2026-10-05T11:55:00.000Z", "agent-9", "evil\u001b[31m/x\u202e", ALPHA, { sid: "s2bbbbbb", tc: 10 }),
    "{\"t\":\"nope\"}",
    "{\"v\":2,\"t\":\"2026-10-05T11:56",
  ];
  wr(path.join(s.state, "agents.jsonl"), cur.join("\n"));
  wr(path.join(s.state, "agents.1.jsonl"), dec("2026-10-04T10:00:00.000Z", "agent-0", ALPHA, ALPHA, { sid: "s0old", tc: 1000000, act: "keep", why: null }) + "\n");
}
const writeStatus = (s) => {
  const mk = (counters) => ({ schema: 1, updatedAt: new Date().toISOString(), since: "2026-10-04T08:00:00.000Z", pid: process.pid, routerVersion: 2, counters });
  wr(path.join(s.state, "status-a.json"), mk({ req: 60, sub: 20, substitute: 8, keep: 12, stickyHit: 30, handoff: 1 }));
  wr(path.join(s.state, "status-b.json"), mk({ req: 40, sub: 10, substitute: 4, keep: 6, stickyHit: 20 }));
};
const jsonOf = async (s, ...a) => { const r = await REPORT(s, ...a, "--json", "yes"); assert.equal(r.status, 0, r.err); assert.equal(r.lines.length, 1); return JSON.parse(r.out); };

// =====================================================================================================================
// the figures and their denominators
// =====================================================================================================================
test("report: every figure names its population; a hand-over line is not an agent decision; torn and unreadable lines are counted", async () => {
  const s = setup(); writeLog(s); writeStatus(s);
  const r = await REPORT(s);
  assert.equal(r.status, 0, r.err);
  assert.match(r.lines[0], /^report: 8 agent decisions \(one logged per new subagent\) in 3 sessions; shadow and enforcing lines are both in this window$/);
  assert.doesNotMatch(r.out, /sampled/, "the router writes no sampled lines to agents.jsonl, so none is reported");
  assert.match(r.out, /^asked -> ran, and what the policy would use \(newest 8 of 8 agent decisions\):$/m);
  assert.ok(r.lines.includes(`  ${when("2026-10-05T11:00:00.000Z")}  asked ${OPUS}  ran ${OPUS}  policy would use ${ALPHA}  because not-in-set  est $0.0000 vs $3.0000 on main`), "shadow: ran is asked; the estimate is the policy's price against main's");
  assert.ok(r.lines.includes(`  ${when("2026-10-05T11:20:00.000Z")}  asked ${HAIKU}  ran ${ALPHA}  policy chose ${ALPHA}  because not-in-set  est $0.0000 vs $6.0000 on main`), "enforce: ran is what the router returned");
  assert.ok(r.lines.includes(`  ${when("2026-10-05T11:35:00.000Z")}  asked ${HAIKU}  ran ${HAIKU}  no policy choice`));
  assert.ok(r.lines.includes(`  ${when("2026-10-04T10:00:00.000Z")}  asked ${ALPHA}  ran ${ALPHA}  policy agrees  est $0.0000 vs $3.0000 on main`));
  assert.match(r.out, /^summary \(of 8 agent decisions\):$/m);
  assert.match(r.out, /^  ran on: anthropic 5, fx-free-a 2, evil\?\[31m 1 \(of 8\)$/m);
  assert.match(r.out, /^  policy would use: fx-free-a 7 \(of 7 with a policy choice\)$/m);
  assert.match(r.out, /^  would move to another model: 6 of 8; unchanged: 1 of 8; no policy choice: 1 of 8$/m, "the three parts add up to the population");
  assert.match(r.out, /^  hand-overs after a limit: 1 hand-over line in this window, each moved a running agent to another model$/m);
  assert.match(r.out, /^router counters since 2026-10-04T08:00:00\.000Z \(the router's lifetime, NOT limited to this window\): 30 subagent requests of 100 requests; 12 of 30 subagent requests moved to another model, 18 of 30 left as asked; 50 repeat requests kept on their model; 1 hand-over done, 0 limits with nothing to hand over to; 0 of 100 requests hit an internal error$/m, "two worker files are summed");
  assert.match(r.out, /savings \(estimate, input tokens only, snapshot prices, snapshot of 2026-10-01\): of 4 of 8 agent decisions that can be priced \(2 without a token count, 0 without a known main model, 2 with an unlisted price\), their 4,500,000 input tokens would cost about \$13\.5000 on main's own model, \$15\.5000 on what ran, and \$0\.0500 on what the policy would use: about \$13\.4500 less than main's model\. Only the first request of each agent is counted/);
  assert.match(r.out, /Claude Code's transcript shows the model that was REQUESTED/);
  assert.ok(!r.out.includes("\u001b") && !r.out.includes("\u202e"), "control and bidi characters never reach the terminal");
  assert.doesNotMatch(r.out, INTERNAL_ID);
  assert.doesNotMatch(r.out, /outcomes/, "no join unless it was asked for");
});

test("report: the estimate arithmetic and each exclusion (no token count, no main, an unlisted price) are exact on round numbers; enforce prices what RAN, shadow what the policy WOULD use", () => {
  const ix = rep.priceIndex({ rows: [{ provider: "p", models: [{ id: "main", pin: 10 }, { id: "ask", pin: 4 }, { id: "pol", pin: 1 }, { id: "free", pin: 0 }, { id: "nop", pin: null }] }] });
  const R = (o) => ({ kind: "decision", mode: "shadow", tc: 1000000, main: "p/main", asked: "p/ask", ran: "p/ask", would: "p/pol", ...o });
  const shadow = rep.estimate([R({}), R({ tc: null }), R({ tc: 0 }), R({ main: null }), R({ would: "p/nop" }), R({ main: "p/unlisted" })], ix);
  assert.deepEqual(shadow.pop, { decisions: 6, noTokenCount: 2, noMain: 1, priceUnknown: 2, eligible: 1 });
  assert.deepEqual([shadow.tokens, shadow.inherit, shadow.asRan, shadow.policy], [1000000, 10, 4, 1]);
  const enforce = rep.estimate([R({ mode: "enforce", ran: "p/free", would: "p/pol" })], ix);
  assert.deepEqual([enforce.inherit, enforce.asRan, enforce.policy], [10, 0, 0], "enforcing: the policy's cost is what RAN, free is a listed zero, not unknown");
  assert.equal(rep.estimate([R({ mode: "shadow", would: null })], ix).policy, 4, "a shadow line with no policy choice prices what ran");
  assert.equal(rep.priceIndex(null).size, 0);
  assert.equal(rep.estimate([R({ ran: "p/ask[1m]", would: "p/ask[1m]" })], rep.priceIndex({ rows: [{ provider: "p", models: [{ id: "main", pin: 10 }, { id: "ask", pin: 4 }] }] })).policy, 4, "a [1m] spelling prices as its base model");
});

test("report --since and --session narrow EVERY denominator, not just the list", async () => {
  const s = setup(); writeLog(s); writeStatus(s);
  const day = await REPORT(s, "--since", "24h");
  assert.match(day.lines[0], /^report: 7 agent decisions \(one logged per new subagent\) in 2 sessions, since 2026-10-04 12:00 UTC; /);
  assert.match(day.out, /of 3 of 7 agent decisions that can be priced \(2 without a token count, 0 without a known main model, 2 with an unlisted price\)/);
  const one = await REPORT(s, "--session", "s2bbbbbb");
  assert.match(one.lines[0], /^report: 1 agent decision \(one logged per new subagent\) in 1 session, session s2bbbbbb; /);
  const long = await jsonOf(s, "--session", "S1AAAAAA-9999-aaaa");
  assert.equal(long.denominators.decisions, 6, "a LONGER id whose first characters are exactly the logged id matches, in any case");
  assert.equal(long.denominators.handoffs, 1);
  const exact = await jsonOf(s, "--session", "s1aaaaaa");
  assert.equal(exact.denominators.decisions, 6, "the logged id itself matches");
  for (const frag of ["s1aaa", "s1", "s", "S1AAAAA", "zzzzzzzz"]) assert.equal((await jsonOf(s, "--session", frag)).denominators.agentLines, 0, `a typed fragment (${frag}) is not a prefix search`);
  assert.equal(rep.sessionMatches("s1aaaaaa", "s1aaaaaa"), true); assert.equal(rep.sessionMatches("s1aaaaaax", "s1aaaaaa"), true);
  assert.equal(rep.sessionMatches("s1aaaaa", "s1aaaaaa"), false); assert.equal(rep.sessionMatches("anything", ""), false);
  const none = await REPORT(s, "--since", "1m");
  assert.match(none.out, /^no agent decisions to report in that window \(read 2 log files; 2 unreadable lines skipped\)/);
  const empty = setup();
  assert.match((await REPORT(empty)).out, /^no agent decisions to report \(read 0 log files; 0 unreadable lines skipped\)/);
  assert.equal((await REPORT(empty, "--json", "yes")).status, 0);
});

test("report: a missing snapshot and a missing status are SAID, never silently left out", async () => {
  const s = setup(); writeLog(s);
  const r = await run(["report", "--state-dir", s.root, "--snapshot-file", path.join(s.dir, "nope.json")]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^savings \(estimate, input tokens only, snapshot prices\): unavailable, the model snapshot could not be read, so no price is known$/m);
  assert.match(r.out, /^router counters: unavailable \(status missing\)$/m);
  const j = JSON.parse((await run(["report", "--state-dir", s.root, "--json", "yes"])).out);
  assert.equal(j.estimate.snapshotAvailable, false); assert.equal(j.counters.available, false); assert.equal(j.counters.req, null);
});

// =====================================================================================================================
// the frozen --json shape
// =====================================================================================================================
test("report --json yes: the schema is FROZEN (schema 2, a fixed key order at every level, ISO UTC times), pinned byte for byte on a small fixture", async () => {
  const s = setup();
  wr(path.join(s.state, "agents.jsonl"), [
    dec("2026-10-05T11:00:00.000Z", "agent-1", OPUS, ALPHA, { tc: 1000000 }),
    dec("2026-10-05T11:10:00.000Z", "agent-2", HAIKU, null, { tc: 500000 }),
    L({ ...base, t: "2026-10-05T11:40:00.000Z", aid: "agent-2", asked: HAIKU, act: "handoff", from: ALPHA, to: BETA, hop: 1, reason: "retry:len:2", would: BETA, ret: BETA, why: "retry:len:2", pol: "enforce", flags: [] }),
  ].join("\n"));
  const r = await REPORT(s, "--json", "yes");
  assert.equal(r.status, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ["schema", "kind", "estimateLabel", "window", "denominators", "totals", "counters", "estimate", "outcomes", "agents", "handoffs", "contextGrowth", "payload"]);
  assert.deepEqual(Object.keys(j.window), ["since", "until", "session"]);
  assert.deepEqual(Object.keys(j.denominators), ["agentLines", "decisions", "handoffs", "sessions", "unreadableLines", "filesRead", "agentsListed", "handoffsListed"]);
  assert.deepEqual(Object.keys(j.totals), ["mode", "moved", "unchanged", "noPolicyChoice", "keptButRewritten", "ranOn", "wouldUse"]);
  assert.deepEqual(Object.keys(j.counters), ["available", "reason", "since", "req", "main", "sub", "substitute", "keep", "stickyHit", "handoff", "handoffNone", "error"]);
  assert.deepEqual(Object.keys(j.estimate), ["snapshotAvailable", "snapshotBuiltAt", "population", "tokens", "currency", "inheritUsd", "asRanUsd", "policyUsd", "policyMinusInheritUsd"]);
  assert.deepEqual(Object.keys(j.estimate.population), ["decisions", "noTokenCount", "noMain", "priceUnknown", "eligible"]);
  assert.deepEqual(Object.keys(j.outcomes), ["requested", "available", "reason", "rowsRead", "truncated", "considered", "matched", "resolvedEqualsRan", "resolvedDiffers", "errorStatus", "unmatched", "joinWindowMs"]);
  for (const a of j.agents) { assert.deepEqual(Object.keys(a), ["t", "sid", "aid", "asked", "ran", "would", "why", "mode", "main", "tokens", "moved", "flags", "costUsd", "outcome"]); assert.match(a.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); }
  for (const h of j.handoffs) assert.deepEqual(Object.keys(h), ["t", "sid", "aid", "text"]);
  const golden = { schema: 2, kind: "report", estimateLabel: "estimate, input tokens only, snapshot prices",
    window: { since: null, until: "2026-10-05T12:00:00.000Z", session: null },
    denominators: { agentLines: 3, decisions: 2, handoffs: 1, sessions: 1, unreadableLines: 0, filesRead: 1, agentsListed: 2, handoffsListed: 1 },
    totals: { mode: "shadow", moved: 1, unchanged: 0, noPolicyChoice: 1, keptButRewritten: 0, ranOn: [{ provider: "anthropic", n: 2 }], wouldUse: [{ provider: "fx-free-a", n: 1 }] },
    counters: { available: false, reason: "missing", since: null, req: null, main: null, sub: null, substitute: null, keep: null, stickyHit: null, handoff: null, handoffNone: null, error: null },
    estimate: { snapshotAvailable: true, snapshotBuiltAt: "2026-10-01T00:00:00.000Z", population: { decisions: 2, noTokenCount: 0, noMain: 0, priceUnknown: 0, eligible: 2 }, tokens: 1500000, currency: "USD", inheritUsd: 4.5, asRanUsd: 15.5, policyUsd: 0.5, policyMinusInheritUsd: -4 },
    outcomes: { requested: false, available: false, reason: null, rowsRead: 0, truncated: false, considered: 0, matched: 0, resolvedEqualsRan: 0, resolvedDiffers: 0, errorStatus: 0, unmatched: 0, joinWindowMs: 2000 },
    agents: [
      { t: "2026-10-05T11:00:00.000Z", sid: "s1aaaaaa", aid: "agent-1", asked: OPUS, ran: OPUS, would: ALPHA, why: "not-in-set", mode: "shadow", main: MAIN, tokens: 1000000, moved: true, flags: [], costUsd: { inherit: 3, asRan: 15, policy: 0 }, outcome: null },
      { t: "2026-10-05T11:10:00.000Z", sid: "s1aaaaaa", aid: "agent-2", asked: HAIKU, ran: HAIKU, would: null, why: null, mode: "shadow", main: MAIN, tokens: 500000, moved: false, flags: [], costUsd: { inherit: 1.5, asRan: 0.5, policy: 0.5 }, outcome: null },
    ],
    handoffs: [{ t: "2026-10-05T11:40:00.000Z", sid: "s1aaaaaa", aid: "agent-2", text: `HANDOFF ${ALPHA} -> ${BETA} (retry 2, hop 1)` }],
    contextGrowth: { label: "estimate", agents: 0, measurable: 0, singleRequest: 0, requests: 0, ratio: null, sizeSample: { requests: 0, over200k: 0, over1m: 0 } },
    payload: { compiledAvailable: false, allowed: null, unknownLimit: null, gateLine: null } };
  assert.equal(r.out, JSON.stringify(golden), "byte-for-byte golden");
  assert.equal(JSON.parse(r.out).estimateLabel, rep.ESTIMATE_LABEL);
  assert.equal(rep.REPORT_SCHEMA, 2);
  assert.deepEqual(Object.keys(j.contextGrowth), ["label", "agents", "measurable", "singleRequest", "requests", "ratio", "sizeSample"]);
  assert.deepEqual(Object.keys(j.payload), ["compiledAvailable", "allowed", "unknownLimit", "gateLine"]);
});

test("report --json: a hostile model name and reason are made printable; the estimate label is in the text AND the JSON; `last --json` keeps its own S1d shape", async () => {
  const s = setup(); writeLog(s);
  const j = await jsonOf(s);
  assert.ok(!/\u001b|\u202e/.test(JSON.stringify(j)));
  assert.ok(j.agents.some((a) => a.asked === "evil?[31m/x?"));
  assert.match((await REPORT(s)).out, /savings \(estimate, input tokens only, snapshot prices/);
  const last = JSON.parse((await run(["last", "--json", "yes", "--state-dir", s.root])).out);
  assert.deepEqual(Object.keys(last), ["schema", "kind", "window", "denominators", "lines"], "S1d shape untouched");
  assert.equal(last.kind, "last");
});

// =====================================================================================================================
// --outcomes yes: the read-only join to the request log (a FIXTURE database)
// =====================================================================================================================
const SECRET = "AUTHZ-MUST-NOT-APPEAR";
function makeLogs(file) {
  const sqlite = loadSqlite();
  const db = new sqlite.DatabaseSync(file);
  db.exec(`create table request_logs (id integer primary key autoincrement, created_at text not null, request_id text not null default '', requested_model text not null default '', resolved_model text not null default '',
    status_code integer not null default 0, request_headers text not null default '{}', request_body_text text not null default '', response_body_text text not null default '')`);
  const ins = db.prepare("insert into request_logs (created_at, requested_model, resolved_model, status_code, request_headers, request_body_text, response_body_text) values (?, ?, ?, ?, ?, ?, ?)");
  const H = (sid, aid) => JSON.stringify({ "x-claude-code-session-id": sid, ...(aid ? { "x-claude-code-agent-id": aid } : {}), authorization: SECRET });
  const row = (t, req, res, st, h) => ins.run(t, req, res, st, h, SECRET, SECRET);
  row("2026-10-05T11:00:01.000Z", OPUS, "claude-opus-5", 200, H("s1aaaaaa-1111-2222", "agent-1-xyz"));        // agent-1: matched, resolved the bare spelling of what ran
  row("2026-10-05T11:10:03.000Z", HAIKU, "claude-haiku-4-5", 200, H("s1aaaaaa-1111-2222", "agent-2-xyz"));    // agent-2: 3 s away, outside the window
  row("2026-10-05T11:10:00.500Z", HAIKU, "claude-haiku-4-5", 200, H("zzzzzzzz-other", "agent-2-xyz"));        // agent-2: right time, another session
  row("2026-10-05T11:20:00.500Z", ALPHA, "fx-free-a,fxa-alpha", 429, H("s1aaaaaa-1111-2222", "agent-3-xyz")); // agent-3: matched, "provider,model" spelling, but an error status
  row("2026-10-05T11:25:00.000Z", ALPHA, "something-else", 200, H("s1aaaaaa-1111-2222", "agent-4-xyz"));      // agent-4: matched, resolved a different model
  row("2026-10-05T11:30:01.000Z", HAIKU, "claude-haiku-4-5", 200, H("s1aaaaaa-1111-2222", "other-agent"));    // agent-5: same session and time, another AGENT
  row("2026-10-05T11:35:00.000Z", HAIKU, "claude-haiku-4-5", 200, H("s1aaaaaa-1111-2222", null));            // agent-6: the row has NO agent id: never a fallback for a decision that has one, so agent-6 stays unmatched
  row("2026-10-05T11:55:00.000Z", HAIKU, "claude-haiku-4-5", 200, "this is not json");                       // agent-9: unusable headers
  row("2026-09-01T00:00:00.000Z", HAIKU, "claude-haiku-4-5", 200, H("s1aaaaaa-old", "agent-1-old"));         // far outside the log window: never read
  db.close();
}
const OUT = (s, ...a) => REPORT(s, "--outcomes", "yes", "--logs-file", s.db, ...a);

test("report --outcomes yes: joins by session prefix, agent and a +/- 2 s window; counts matches, resolved-equals-ran, a different model, error statuses and unmatched, each over its denominator; the database is not changed", async () => {
  const s = setup(); writeLog(s); makeLogs(s.db);
  const before = dirHash(s.dir);
  const r = await OUT(s);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^outcomes \(the gateway request log, read only, joined by session, agent and a 2 second window\): matched 3 of 8 agent decisions \(8 log rows read\); the gateway resolved the logged model on 2 of 3 matched, another model on 1 of 3; 1 of 3 matched returned an error status \(400 or above\); 5 of 8 had no matching request \(the gateway keeps only recent request rows, for a time this report does not know, so older agents can be missing\)$/m);
  assert.ok(r.lines.includes(`  ${when("2026-10-05T11:20:00.000Z")}  asked ${HAIKU}  ran ${ALPHA}  policy chose ${ALPHA}  because not-in-set  est $0.0000 vs $6.0000 on main  gateway served it (HTTP 429)`));
  assert.ok(r.lines.includes(`  ${when("2026-10-05T11:25:00.000Z")}  asked ${HAIKU}  ran ${HAIKU}  policy would use ${ALPHA}  because not-in-set  gateway resolved something-else`));
  const j = await jsonOf(s, "--outcomes", "yes", "--logs-file", s.db);
  assert.deepEqual(j.outcomes, { requested: true, available: true, reason: null, rowsRead: 8, truncated: false, considered: 8, matched: 3, resolvedEqualsRan: 2, resolvedDiffers: 1, errorStatus: 1, unmatched: 5, joinWindowMs: 2000 });
  assert.deepEqual(j.agents.filter((a) => a.outcome).map((a) => [a.aid, a.outcome.sameAsRan, a.outcome.status]), [["agent-1", true, 200], ["agent-3", true, 429], ["agent-4", false, 200]]);
  assert.equal(r.out.includes(SECRET) || JSON.stringify(j).includes(SECRET), false, "nothing but the named scalars leaves the database: no header, no body");
  assert.deepEqual(dirHash(s.dir), before, "the request log and every other file are byte-identical afterwards");
});

test("report --outcomes: the SQL is one SELECT of named scalars (no header or body column, no write keyword), a row is never matched twice, and every unavailable state is said", async () => {
  assert.match(rep.LOG_QUERY, /^select created_at, requested_model, resolved_model, status_code,/);
  assert.doesNotMatch(rep.LOG_QUERY, /\b(insert|update|delete|drop|create|alter|attach|pragma|replace)\b/i);
  assert.doesNotMatch(rep.LOG_QUERY.replace(/json_extract\(request_headers, '\$\."x-claude-code-(session|agent)-id"'\)|request_headers <= |json_valid\(request_headers\)|length\(request_headers\)/g, ""), /request_headers|request_body|response_body|api_key/);
  const src = fs.readFileSync(new URL("../keysync/subagent-report.mjs", import.meta.url), "utf8");
  assert.match(src, /readOnly: true/); assert.match(src, /PRAGMA query_only = 1/);
  // one row is never claimed by two decisions
  const d = (t, aid) => ({ t, sid: "s1", aid, ran: "p/m" });
  const j = rep.joinOutcomes([d("2026-10-05T11:00:00.000Z", "a1"), d("2026-10-05T11:00:00.500Z", "a1")], [{ created_at: "2026-10-05T11:00:00.200Z", resolved_model: "m", status_code: 200, sid: "s1xxx", aid: "a1" }]);
  assert.equal(j.matched, 1); assert.equal(j.unmatched, 1);
  // a created_at with no zone is read as UTC, a SQLite-style `YYYY-MM-DD HH:MM:SS` included
  assert.equal(rep.joinOutcomes([d("2026-10-05T11:00:00.000Z", null)], [{ created_at: "2026-10-05 11:00:01", resolved_model: "m", status_code: 200, sid: "s1", aid: "" }]).matched, 1);
  const s = setup(); writeLog(s);
  const none = await REPORT(s, "--outcomes", "yes");
  assert.match(none.out, /^outcomes: unavailable \(no request log was named\)$/m, "a fixture run that names no database reads none (never the real one)");
  const missing = await REPORT(s, "--outcomes", "yes", "--logs-file", path.join(s.dir, "nope.sqlite"));
  assert.match(missing.out, /^outcomes: unavailable \(the request log file was not found\)$/m);
  const junk = path.join(s.dir, "junk.sqlite"); fs.writeFileSync(junk, "not a database at all");
  assert.match((await REPORT(s, "--outcomes", "yes", "--logs-file", junk)).out, /^outcomes: unavailable \(/m);
  const nocols = path.join(s.dir, "nocols.sqlite"); { const db = new (loadSqlite().DatabaseSync)(nocols); db.exec("create table request_logs (created_at text)"); db.close(); }
  assert.match((await REPORT(s, "--outcomes", "yes", "--logs-file", nocols)).out, /^outcomes: unavailable \(request_logs has no requested_model, resolved_model, status_code, request_headers column\)$/m);
  const seam = []; const fake = (f) => { seam.push(f); return { ok: false, reason: "a fake said no" }; };
  assert.match((await run(["report", "--outcomes", "yes", "--logs-file", s.db, "--state-dir", s.root], { openLogs: fake })).out, /outcomes: unavailable \(a fake said no\)/);
  assert.deepEqual(seam, [s.db], "the injected seam receives exactly the fixture path");
  const quiet = await REPORT(s);
  assert.equal(quiet.out.includes("outcomes"), false);
  assert.equal(seam.length, 1, "no --outcomes yes, no read");
});

// =====================================================================================================================
// flags: a fixture run can never reach a real file
// =====================================================================================================================
test("report flag rules: it takes no positional, --since and --session are validated, --logs-file needs --state-dir and may not name a real folder, and a bare --json is refused", async () => {
  const bad = (argv, re) => assert.throws(() => lib.parseArgs(argv), (e) => e.code === "E_USAGE" && e.exit === 1 && re.test(e.message), argv.join(" "));
  bad(["report", "extra"], /unexpected argument "extra" for report/);
  bad(["report", "--since", "1w"], /--since takes a number and a unit/);
  bad(["report", "--session", "a b"], /--session takes a session id/);
  bad(["report", "--session", "x".repeat(65)], /--session takes a session id/);
  bad(["report", "--logs-file", "x.sqlite"], /--logs-file requires --state-dir too/);
  bad(["report", "--json"], /needs an explicit value/);
  bad(["report", "--outcomes", "true"], /takes exactly yes or no/);
  bad(["report", "--snapshot-file", "x"], /incomplete test-flag set: --snapshot-file requires --state-dir/);
  bad(["report", "--policy-file", "x"], /unknown or not applicable flag --policy-file for report/);
  assert.doesNotThrow(() => lib.parseArgs(["report"]), "with no test flag it reads the real files, read only");
  assert.equal(lib.parseArgs(["report", "--json", "yes", "--outcomes", "yes", "--session", "s1_a-B", "--since", "7d", "--state-dir", "x", "--logs-file", "y"]).flags.session, "s1_a-B");
  assert.throws(() => lib.resolvePaths({ "state-dir": os.tmpdir(), "logs-file": path.join(os.homedir(), ".llmkeys", "request-logs.sqlite") }), (e) => e.code === "E_USAGE" && /--logs-file/.test(e.message) && /real vault/.test(e.message));
  assert.equal(lib.resolvePaths({ "state-dir": os.tmpdir() }).logsFile, null, "a fixture run with no --logs-file has no request log at all");
  // sec-7: CCR's own data folder (where the real request log lives) is protected too, the real one and one an injected environment names
  const real = dataDir();
  if (real) assert.throws(() => lib.resolvePaths({ "state-dir": os.tmpdir(), "logs-file": path.join(real, "request-logs.sqlite") }), (e) => e.code === "E_USAGE" && /--logs-file/.test(e.message) && /real vault/.test(e.message), "the real CCR data folder");
  assert.ok(lib.protectedDirs(os.homedir(), { UW_CCR_DATA_DIR: "C:\\somewhere\\ccr-data" }).some((d) => /ccr-data$/.test(d)));
  const data = tmp();
  assert.throws(() => lib.resolvePaths({ "state-dir": os.tmpdir(), "logs-file": path.join(data, "request-logs.sqlite") }, { env: { UW_CCR_DATA_DIR: data } }), (e) => e.code === "E_USAGE" && /--logs-file/.test(e.message), "a data folder named by the injected environment");
  assert.equal(lib.resolvePaths({}, { env: { UW_CCR_DATA_DIR: data } }).logsFile, path.join(path.resolve(data), "request-logs.sqlite"), "a real-mode run reads the data folder of the INJECTED environment, not process.env");
  assert.equal(lib.resolvePaths({}, { env: { UW_CCR_DATA_DIR: data } }).fixture, false);
  // end to end: the environment handed to the command (not process.env) decides which data folder is protected
  const s = setup();
  const out = [], err = [];
  const status = await lib.runSubagentPolicy(["report", "--state-dir", s.root, "--logs-file", path.join(data, "request-logs.sqlite"), "--outcomes", "yes"], { out: (l) => out.push(l), err: (l) => err.push(l) }, { UW_CCR_DATA_DIR: data }, { now: NOW });
  assert.equal(status, 1); assert.match(err.join("\n"), /^E_USAGE: refusing --logs-file .* a real vault, Claude, state or catalog folder/);
});

test("report: no real file is touched and nothing is written for any option (the fixture folder is byte-identical before and after)", async () => {
  const s = setup(); writeLog(s); writeStatus(s); makeLogs(s.db);
  const before = dirHash(s.dir);
  for (const a of [[], ["--json", "yes"], ["--since", "24h"], ["--session", "s1aaaaaa"], ["--outcomes", "yes", "--logs-file", s.db], ["--outcomes", "yes", "--logs-file", s.db, "--json", "yes"]]) assert.equal((await REPORT(s, ...a)).status, 0, a.join(" "));
  assert.deepEqual(dirHash(s.dir), before);
});

test("report: no internal id appears in the default text, and the help names the command", async () => {
  const s = setup(); writeLog(s); writeStatus(s); makeLogs(s.db);
  const r = await OUT(s);
  assert.doesNotMatch(r.out, INTERNAL_ID); assert.doesNotMatch(r.out, /\((?:D|cr)-[A-Za-z0-9]+\)/);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.out));
  assert.match(lib.usageText, /^  report \[--since 1h\|24h\|7d\] \[--session ID\] \[--json yes\] \[--outcomes yes\]/m);
  assert.ok(lib.COMMANDS.includes("report"));
});

test("runbook 5b: every report and selftest example runs in a fixture with the flags its command takes, none is refused as a flag error, and the section says which flags those are", async () => {
  const md = fs.readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const sec = md.slice(md.indexOf("### 5b."), md.indexOf("## 6. Phase B"));
  const cmds = [...sec.matchAll(/^\s+node keysync\/key\.mjs subagent-policy ((?:report|selftest)[^#\n]*?)\s*(?:#.*)?$/gm)].map((m) => m[1].trim());
  assert.ok(cmds.length >= 3, `found ${cmds.length} documented report and selftest commands`);
  const s = setup(); writeLog(s); writeStatus(s); makeLogs(s.db);
  for (const c of cmds) {
    const argv = c.split(/\s+/).filter(Boolean);
    const flags = argv[0] === "report" ? ["--state-dir", s.root, "--snapshot-file", s.snap, ...(argv.includes("--outcomes") ? ["--logs-file", s.db] : [])] : [];     // selftest takes no file flag at all
    const r = await run([...argv, ...flags]);
    assert.ok(!/incomplete test-flag set|unknown or not applicable flag|needs an explicit value|takes exactly yes or no/.test(r.err), `${c}: refused as a flag error: ${r.err}`);
    assert.equal(r.status, 0, `${c}: ${r.err}`);
  }
  const flat = sec.replace(/\s+/g, " ");
  assert.match(flat, /`report` takes `--state-dir "\$T\/state"` and optionally `--snapshot-file "\$T\/snapshot\.json"`/);
  assert.match(flat, /`--logs-file <a fixture request log>`/);
  assert.match(flat, /"estimate, input tokens only, snapshot prices"/);
});

// =====================================================================================================================
// the fix round: join confidence, sessions, hostile values, truncation, read-only handle, honest counts
// =====================================================================================================================
const LOG_COLUMNS = ["created_at", "requested_model", "resolved_model", "status_code", "request_headers"];

test("report join: a decision WITH an agent id matches only a row of that agent (a row without one is never a fallback); a decision without one matches on session and time", () => {
  const d = (aid) => ({ t: "2026-10-05T11:00:00.000Z", sid: "s1", aid, ran: "p/m" });
  const row = (aid) => ({ created_at: "2026-10-05T11:00:00.300Z", resolved_model: "m", status_code: 200, sid: "s1xxxx", aid });
  assert.equal(rep.joinOutcomes([d("a1")], [row(undefined)]).matched, 0, "no agent id on the row: left unmatched, not guessed");
  assert.equal(rep.joinOutcomes([d("a1")], [row(null)]).matched, 0);
  assert.equal(rep.joinOutcomes([d("a1")], [row("")]).matched, 0);
  assert.equal(rep.joinOutcomes([d("a1")], [row("b2")]).matched, 0, "another agent");
  assert.equal(rep.joinOutcomes([d("a1")], [row("a1-long")]).matched, 1, "the logged id is clipped, so the row's longer id matches by prefix");
  const both = rep.joinOutcomes([d("a1")], [row(undefined), row("a1")]);
  assert.equal(both.matched, 1); assert.equal([...both.per.values()][0].sameAsRan, true);
  assert.equal(rep.joinOutcomes([d(null)], [row(undefined)]).matched, 1, "a decision with no agent id can only go by session and time");
  assert.equal(rep.joinOutcomes([d(null)], [row("b2")]).matched, 1);
});

test("report: sessions are counted over DECISIONS only (an old decision, an in-window hand-over of its session and an in-window decision of another session count 1 session, not 2)", async () => {
  const s = setup();
  wr(path.join(s.state, "agents.jsonl"), [
    dec("2026-10-03T10:00:00.000Z", "agent-o", HAIKU, ALPHA, { sid: "sOLDold1", tc: 10 }),
    L({ ...base, sid: "sOLDold1", t: "2026-10-05T11:00:00.000Z", aid: "agent-o", asked: HAIKU, act: "handoff", from: ALPHA, to: BETA, hop: 1, reason: "retry:len:2", would: BETA, ret: BETA, why: "retry:len:2", pol: "enforce", flags: [], path: "handoff" }),
    dec("2026-10-05T11:30:00.000Z", "agent-n", HAIKU, ALPHA, { sid: "sNEWnew1", tc: 10 }),
  ].join("\n"));
  const j = await jsonOf(s, "--since", "24h");
  assert.deepEqual([j.denominators.agentLines, j.denominators.decisions, j.denominators.handoffs, j.denominators.sessions], [2, 1, 1, 1]);
  assert.match((await REPORT(s, "--since", "24h")).lines[0], /^report: 1 agent decision \(one logged per new subagent\) in 1 session, since /);
  assert.equal((await jsonOf(s)).denominators.sessions, 2, "with no window both decisions' sessions count");
});

test("report and last: a log value that is not a string (an object whose toString is a number, an array, a boolean) prints as ?, a number as itself, and nothing throws, in text and --json", async () => {
  const s = setup();
  const O = "{\"toString\":1}";
  wr(path.join(s.state, "agents.jsonl"), [
    `{"v":2,"t":"2026-10-05T11:00:00.000Z","sid":${O},"aid":${O},"asked":${O},"ret":${O},"would":["x"],"main":${O},"why":${O},"act":${O},"pol":${O},"flags":[${O},"ok"],"tc":${O},"path":${O}}`,
    `{"v":2,"t":${O},"asked":"a/b"}`,
    `{"v":2,"t":"2026-10-05T11:10:00.000Z","aid":"agent-2","asked":"a/b","act":"handoff","from":${O},"to":true,"reason":${O},"hop":${O},"ret":"x/y"}`,
    `{"v":2,"t":"2026-10-05T11:20:00.000Z","aid":"agent-3","asked":5,"ret":true,"would":false,"main":7,"why":9,"act":"substitute"}`,
  ].join("\n"));
  for (const argv of [["report"], ["report", "--json", "yes"], ["last"], ["last", "--json", "yes"]]) {
    const r = await run([...argv, "--state-dir", s.root, ...(argv[0] === "report" ? ["--snapshot-file", s.snap] : [])]);
    assert.equal(r.status, 0, `${argv.join(" ")}: ${r.err}`);
    assert.equal(r.err, "");
    assert.ok(!/toString|object Object/.test(r.out), argv.join(" "));
  }
  const j = await jsonOf(s);
  assert.equal(j.denominators.unreadableLines, 1, "a time that is not a string is an unreadable line");
  assert.deepEqual([j.denominators.decisions, j.denominators.handoffs], [2, 1]);
  assert.deepEqual(j.agents.map((a) => [a.asked, a.ran, a.would, a.main, a.why, a.tokens]), [["?", "?", "?", "?", "?", null], ["5", "?", "?", "7", "9", null]]);
  assert.equal(j.handoffs[0].text, "HANDOFF ? -> ? (retry ?, hop ?)");
  assert.match((await REPORT(s)).out, /asked 5  ran \?  policy would use \?/);
  assert.equal(lib.printable({ toString: 1 }), "?"); assert.equal(lib.printable(5), "5"); assert.equal(lib.printable(null), ""); assert.equal(lib.printable(["a"]), "?"); assert.equal(lib.printable(true), "?"); assert.equal(lib.printable("ok\u001b"), "ok?");
  assert.equal(lib.formatHandoff({ reason: { toString: 1 } }), "HANDOFF ? -> ? (retry ?, hop ?)");
  assert.equal(JSON.parse((await run(["last", "--json", "yes", "--state-dir", s.root])).out).denominators.unreadableLines, 1);
});

test("report: a truncated request-log read (the row limit) and a capped hand-over list are SAID in text and in --json", async () => {
  const s = setup();
  const lines = [dec("2026-10-05T11:00:00.000Z", "agent-1", HAIKU, ALPHA, { tc: 10 })];
  for (let i = 0; i < 60; i++) lines.push(L({ ...base, t: new Date(Date.parse("2026-10-05T11:01:00.000Z") + i * 1000).toISOString(), aid: "agent-1", asked: HAIKU, act: "handoff", from: ALPHA, to: BETA, hop: 1, reason: "retry:len:2", would: BETA, ret: BETA, why: "retry:len:2", pol: "enforce", flags: [], path: "handoff" }));
  wr(path.join(s.state, "agents.jsonl"), lines.join("\n"));
  const j = await jsonOf(s);
  assert.deepEqual([j.denominators.handoffs, j.denominators.handoffsListed, j.handoffs.length], [60, 50, 50]);
  assert.match((await REPORT(s)).out, /^  hand-overs after a limit: 60 hand-over lines in this window, each moved a running agent to another model \(--json yes lists only the newest 50 of 60\)$/m);
  const few = setup(); wr(path.join(few.state, "agents.jsonl"), lines.slice(0, 11).join("\n"));
  assert.doesNotMatch((await REPORT(few)).out, /lists only/);
  const rows = (n) => () => ({ ok: true, columns: new Set(LOG_COLUMNS), query: () => Array.from({ length: n }, () => ({ created_at: "2026-10-05T11:00:00.000Z", resolved_model: "x", status_code: 200, sid: "zz", aid: "zz" })), close() {} });
  const full = await run(["report", "--outcomes", "yes", "--logs-file", s.db, "--state-dir", s.root, "--snapshot-file", s.snap], { openLogs: rows(rep.LOG_ROW_LIMIT) });
  assert.match(full.out, /\(5000 log rows read, STOPPED AT THE 5000-ROW LIMIT: later rows were not read, so some unmatched agents may only be beyond it\)/);
  assert.equal(JSON.parse((await run(["report", "--outcomes", "yes", "--logs-file", s.db, "--state-dir", s.root, "--json", "yes"], { openLogs: rows(rep.LOG_ROW_LIMIT) })).out).outcomes.truncated, true);
  const under = await run(["report", "--outcomes", "yes", "--logs-file", s.db, "--state-dir", s.root, "--json", "yes"], { openLogs: rows(rep.LOG_ROW_LIMIT - 1) });
  assert.equal(JSON.parse(under.out).outcomes.truncated, false);
  assert.equal(rep.LOG_ROW_LIMIT, 5000); assert.match(rep.LOG_QUERY, /limit 5000$/);
});

test("report --outcomes: the handle the report reads through REFUSES every write (an INSERT, DELETE, UPDATE, DROP, CREATE and ATTACH are tried on the very handle it opened), and the file is unchanged", () => {
  const s = setup(); makeLogs(s.db);
  const bytes = () => crypto.createHash("sha256").update(fs.readFileSync(s.db)).digest("hex"), before = bytes();
  const tried = [];
  const other = path.join(s.dir, "other.sqlite").replace(/\\/g, "/");
  const h = rep.openRequestLogs(s.db, { onOpen: (db) => {
    for (const sql of ["insert into request_logs (created_at) values ('x')", "delete from request_logs", "update request_logs set status_code = 1", "drop table request_logs", "create table t (a)", `attach database '${other}' as o`]) {
      try { db.exec(sql); tried.push([sql, "SUCCEEDED"]); } catch { tried.push([sql, "refused"]); }
    }
  } });
  assert.equal(h.ok, true);
  assert.deepEqual(tried.filter(([, r]) => r !== "refused"), [], "no write statement was accepted");
  assert.equal(tried.length, 6);
  assert.equal(h.query("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z").length, 9, "reading still works");
  h.close();
  assert.equal(bytes(), before);
  assert.equal(fs.existsSync(path.join(s.dir, "other.sqlite")), false);
  assert.deepEqual(rep.openRequestLogs(path.join(s.dir, "absent.sqlite")), { ok: false, reason: "the request log file was not found" });
});

test("report: counts and the list agree for enforcing lines with no policy choice, and a policy 'keep' that ran on another model (the old slot rewrite) is not counted as the policy moving it", async () => {
  const s = setup();
  wr(path.join(s.state, "agents.jsonl"), [
    dec("2026-10-05T11:00:00.000Z", "agent-1", HAIKU, null, { pol: "enforce", path: "new", tc: 10 }),                                           // enforce, a keep with no choice
    dec("2026-10-05T11:01:00.000Z", "agent-2", HAIKU, null, { pol: "enforce", path: "new", act: "empty-set", why: "empty-set", tc: 10 }),        // enforce, no choice at all
    dec("2026-10-05T11:02:00.000Z", "agent-3", HAIKU, HAIKU, { pol: "enforce", path: "new", act: "keep", ret: OPUS, why: null, tc: 10 }),         // the slot rewrote the model; the policy kept it
    dec("2026-10-05T11:03:00.000Z", "agent-4", HAIKU, ALPHA, { pol: "enforce", path: "new", ret: ALPHA, tc: 10 }),                                // the policy moved it
    dec("2026-10-05T11:04:00.000Z", "agent-5", HAIKU, HAIKU, { act: "keep", why: null, tc: 10 }),                                                // shadow, agrees
  ].join("\n"));
  const j = await jsonOf(s), r = await REPORT(s);
  assert.deepEqual([j.totals.moved, j.totals.unchanged, j.totals.noPolicyChoice, j.totals.keptButRewritten], [1, 2, 2, 1]);
  assert.equal(j.agents.filter((a) => a.moved === true).length, j.totals.moved, "the list and the count agree on moved");
  assert.equal(j.agents.filter((a) => a.would === null).length, j.totals.noPolicyChoice, "the list and the count agree on no policy choice");
  assert.equal(r.lines.filter((l) => /  no policy choice/.test(l)).length, 2, "the printed list shows the same two");
  assert.match(r.out, /^  moved to another model: 1 of 5; unchanged: 2 of 5; no policy choice: 2 of 5$|^  would move to another model: 1 of 5; unchanged: 2 of 5; no policy choice: 2 of 5$/m);
  assert.match(r.out, /^  1 of 5 ran on a different model than asked although the policy kept it \(the old model-slot rewrite did that, not the policy; they count as unchanged\)$/m);
  const a3 = j.agents.find((a) => a.aid === "agent-3");
  assert.deepEqual([a3.asked, a3.ran, a3.moved], [HAIKU, OPUS, false]);
});

// ---- D-bl: context growth (an ESTIMATE) from the classifier log, and the honest payload-gate wording (sa-A1). Fixture files only; the real classify.jsonl is never read.
const cls = (t, aid, tc, over = {}) => L({ t, sid: "s1aaaaaa", aid, pid8: null, cls: "sub", ag: 1, bl: 0, nt: 10, ga: 1, sysb: "s2", m: MAIN, rc: null, at: null, bb: "b1", tc, ...over });

test("D-bl context growth: per subagent the largest later token count over its FIRST, as median, 90th percentile and max, with n; one-request agents have no ratio; main and aux lines never count", async () => {
  const s = setup(); writeLog(s);
  wr(path.join(s.state, "classify.jsonl"), [
    cls("2026-10-05T10:00:00.000Z", "a1", 1000), cls("2026-10-05T10:01:00.000Z", "a1", 2000), cls("2026-10-05T10:02:00.000Z", "a1", 3000),          // peak 3x
    cls("2026-10-05T10:00:10.000Z", "a2", 1000), cls("2026-10-05T10:05:00.000Z", "a2", 1500),                                                           // 1.5x
    cls("2026-10-05T10:00:20.000Z", "a3", 2000), cls("2026-10-05T10:06:00.000Z", "a3", 10000), cls("2026-10-05T10:07:00.000Z", "a3", 4000),            // 5x (the peak, not the last)
    cls("2026-10-05T10:00:30.000Z", "a4", 4000),                                                                                                          // one request: no ratio
    cls("2026-10-05T10:00:40.000Z", "a5", 1000, { cls: "main" }), cls("2026-10-05T10:09:00.000Z", "a5", 90000, { cls: "main" }),                        // not a subagent
    cls("2026-10-05T10:00:50.000Z", null, 1000), cls("2026-10-05T10:09:50.000Z", null, 9000),                                                            // no agent id: not an agent
    cls("2026-10-05T10:00:55.000Z", "a6", null), cls("2026-10-05T10:09:55.000Z", "a6", 9000),                                                            // no token count on the first: one counted request
  ].join("\n"));
  const j = JSON.parse((await REPORT(s, "--json", "yes")).out);
  assert.equal(j.schema, 2);
  assert.deepEqual(j.contextGrowth, { label: "estimate", agents: 5, measurable: 3, singleRequest: 2, requests: 10, ratio: { median: 3, p90: 5, max: 5 }, sizeSample: { requests: 13, over200k: 0, over1m: 0 } },
    "5 subagents with an id and a token count, 3 with 2+ counted requests: peaks 1.5, 3, 5 (nearest-rank median 3, p90 5)");
  const t = (await REPORT(s)).out;
  assert.match(t, /context growth \(estimate, the router's token counts from its classifier log\): of 5 subagents with a token count \(10 requests\), 3 made two or more requests; the largest later request of each was a median 3x, 90th percentile 5x, at most 5x its FIRST request \(n = 3 subagents; 2 with one counted request have no ratio\)/);
  assert.match(t, /Nothing is changed by this/);
});

test("D-bl context growth: the window and the session filter the classifier lines; an absent log says not measurable instead of inventing a ratio", async () => {
  const s = setup(); writeLog(s);
  const none = JSON.parse((await REPORT(s, "--json", "yes")).out);
  assert.deepEqual([none.contextGrowth.agents, none.contextGrowth.measurable, none.contextGrowth.ratio], [0, 0, null]);
  assert.match((await REPORT(s)).out, /context growth \(estimate\): not measurable: of 0 subagents with a token count/);
  wr(path.join(s.state, "classify.jsonl"), [cls("2026-10-05T09:00:00.000Z", "old", 1000), cls("2026-10-05T09:30:00.000Z", "old", 8000), cls("2026-10-05T11:00:00.000Z", "new", 1000), cls("2026-10-05T11:30:00.000Z", "new", 2000), cls("2026-10-05T11:31:00.000Z", "oth", 1000, { sid: "zzzzzzzz" }), cls("2026-10-05T11:32:00.000Z", "oth", 5000, { sid: "zzzzzzzz" })].join("\n"));
  const all = JSON.parse((await REPORT(s, "--json", "yes")).out).contextGrowth;
  assert.deepEqual([all.agents, all.measurable, all.ratio.max], [3, 3, 8]);
  const w = JSON.parse((await REPORT(s, "--json", "yes", "--since", "2h")).out).contextGrowth;
  assert.deepEqual([w.agents, w.measurable, w.ratio.max], [2, 2, 5], "--since 2h drops the 09:00 agent (its first request is outside the window)");
  const se = JSON.parse((await REPORT(s, "--json", "yes", "--session", "s1aaaaaa")).out).contextGrowth;
  assert.deepEqual([se.agents, se.ratio.max], [2, 8], "--session keeps only that session's lines");
});

test("sa-A1 report: the request-size buckets of the classifier log are counted over their own denominator, and the payload gate is called inert for models with no known cap", async () => {
  const s = setup(); writeLog(s);
  wr(path.join(s.state, "classify.jsonl"), ["b0", "b1", "b2", "b2", "b3"].map((bb, i) => cls(`2026-10-05T10:0${i}:00.000Z`, `z${i}`, 1000, { bb })).join("\n"));
  assert.deepEqual(JSON.parse((await REPORT(s, "--json", "yes")).out).contextGrowth.sizeSample, { requests: 5, over200k: 3, over1m: 1 });
  assert.match((await REPORT(s)).out, /request size \(the classifier log's size buckets\): 3 of 5 classified subagent requests \(60%\) were over 200 KB and 1 \(20%\) over 1 MB/);
  // a compiled policy beside the log: the gate wording appears, with its own denominator
  const compiled = { schema: 1, minRouter: 2, contentHash: "x", owner: { source: "all-providers", mode: "dynamic", ctx: "any" }, models: [], lists: {}, counts: { allowed: 4, payloadUnknown: 3, universe: 9 } };
  wr(path.join(s.state, "policy.json"), compiled);
  const j = JSON.parse((await REPORT(s, "--json", "yes")).out);
  assert.deepEqual([j.payload.compiledAvailable, j.payload.allowed, j.payload.unknownLimit], [true, 4, 3]);
  assert.match((await REPORT(s)).out, /payload limits: 3 of 4 eligible models have no known request-size limit, so the size check does nothing for them until a limit is measured/);
});

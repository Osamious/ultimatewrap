// keysync/subagent-accuracy.mjs (issue #154): the classifier accuracy evaluator and the three-mode shadow tally. Every run reads and writes TEMP folders only: guardRealState fails the file if the real
// ~/.uw/state is touched, and the in-process CLI runs name a fixture --state-dir (or call the engine on a temp folder). Logs are synthetic; no ids of real sessions appear anywhere.
//
// Round 2: a PASS needs rc (the client's own request class). The detector-only fixtures of round 1 reached PASS through a tautology (the router's class is a function of the two detectors the log records);
// the PASS fixture below carries rc on every gated row, and the same fixture with rc removed must be INSUFFICIENT.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { fixtureFlagMap } from "./fixtures/subagent-flags.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// UW_TEST_ACCURACY lets test/mutants/subagent-accuracy.mjs point this whole file at a mutated copy of the module.
const A = await import(process.env.UW_TEST_ACCURACY ? pathToFileURL(process.env.UW_TEST_ACCURACY).href : "../keysync/subagent-accuracy.mjs");
const LIB = await import("../keysync/subagent-policy.mjs");

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-acc-")); made.push(d); return d; };
after(() => { for (const d of made) if (path.dirname(d) === os.tmpdir() && path.basename(d).startsWith("uw-acc-")) fs.rmSync(d, { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const D1 = Date.parse("2026-10-05T10:00:00.000Z"), D2 = Date.parse("2026-10-06T09:00:00.000Z");
const SONNET = "anthropic/claude-sonnet-5-5", OPUS = "anthropic/claude-opus-5", HAIKU = "anthropic/claude-haiku-4-5-20251001";
const J = (o) => JSON.stringify(o);

/** A classifier line in the router's v3 shape; `o` overrides. */
const row = (o = {}) => ({ t: iso(D2), sid: "s1aaaaaa", aid: null, pid8: null, cls: "main", ag: 0, bl: 0, nt: 5, ga: 1, sysb: "s2", m: SONNET, rc: null, at: null, bb: "b1", tc: 1000, hasSid: true, ua: "claude-cli", ...o });
const writeLog = (dir, name, rows) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), rows.map((r) => (typeof r === "string" ? r : J(r))).join("\n") + "\n"); };
const evalDir = (dir, o = {}) => A.runEvaluation({ stateDir: dir }, { nowMs: NOW, tally: false, ...o });
const VERS = { cc: "9.9.9", ccr: "3.0.22" };
const noRc = (rows) => rows.map((x) => ({ ...x, rc: null }));

/**
 * A log that satisfies EVERY minimum with ground truth: 220 rc-labelled main requests in 3 sessions on 2 days (one session switches model on tool-carrying requests), 200 rc-labelled built-in subagent
 * requests of 5 `at` types from 200 distinct agents, 200 rc-labelled helper requests (100 compaction, 100 auxiliary), all classified as the router would. `perType` and `helpers` scale the counts.
 */
function passRows({ main = 220, perType = 40, helpers = 100 } = {}) {
  const r = [];
  const sids = ["s1aaaaaa", "s2bbbbbb", "s3cccccc"];
  for (let i = 0; i < main; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + i * 1000), sid: sids[i % 3], m: i < main / 2 && i % 3 === 0 ? OPUS : SONNET, rc: "main" }));
  ["Explore", "general-purpose", "code-reviewer", "Plan", "statusline"].forEach((at, ti) => {
    for (let i = 0; i < perType; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + 500000 + i * 1000), sid: sids[i % 3], cls: "sub", ag: 1, bl: 1, aid: `a${ti}-${i}`, at, nt: 20, ga: 0, rc: "subagent" }));
  });
  for (const rc of ["compaction", "auxiliary"]) for (let i = 0; i < helpers; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + 900000 + i * 1000), sid: sids[i % 3], cls: "aux", ag: 1, bl: 0, aid: `h${i}`, nt: 0, ga: 0, rc }));
  return r;
}
const decision = (o = {}) => ({ t: iso(D2), v: 1, w: "w", sid: "s1aaaaaa", aid: "ag", role: "sub", ag: 1, bl: 1, tools: 20, agentTool: 0, asked: SONNET, tag: null, main: SONNET, pol: "shadow", ph: "h1", act: "substitute", would: "groq/g1", ret: SONNET, ...o });

// ------------------------------------------------------------------ math
test("wilsonLower: the one-sided 95% bound reproduces the figures of plan 12.5, and 88 agents with no miss are needed for 97%", () => {
  assert.ok(Math.abs(100 * A.wilsonLower(200, 200) - 98.67) < 0.01);       // "with 200 requests and no miss the bound is about 98.7%"
  assert.ok(Math.abs(100 * A.wilsonLower(199, 200) - 97.79) < 0.01);       // "one miss in 200 about 97.8%"
  assert.ok(Math.abs(100 * A.wilsonLower(30, 30) - 91.7) < 0.1);
  assert.equal(A.wilsonLower(0, 0), 0);
  assert.ok(A.wilsonLower(10, 10) < A.wilsonLower(100, 100) && A.wilsonLower(100, 100) < A.wilsonLower(1000, 1000));
  assert.ok(A.wilsonLower(0, 50) >= 0 && A.wilsonLower(50, 50) <= 1);
  assert.equal(A.samplesForBound(97), 88);
});

// ------------------------------------------------------------------ ground truth: the PASS fixture and its absence
test("a log meeting every minimum with rc-labelled rows and no miss: every gated metric PASS and the verdict PASS, versions recorded", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", passRows());
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.missing));
  for (const id of ["T1", "T2", "T4", "T5", "T6"]) assert.equal(r.metrics[id].status, "PASS", `${id}: ${r.metrics[id].reason}`);
  assert.equal(r.metrics.T1.n, 200); assert.equal(r.metrics.T1.agents, 200); assert.equal(r.metrics.T2.n, 200); assert.equal(r.metrics.T4.n, 220);
  assert.ok(r.metrics.T1.wilsonLower >= 98.6);
  assert.equal(r.ccVersion, "9.9.9"); assert.equal(r.ccrVersion, "3.0.22"); assert.equal(r.groundTruthMissing, false);
  assert.match(text.join("\n"), /T1 subagent requests classified sub: PASS: 100\.00% classified sub of 200 rc-labelled tool-carrying subagent requests from 200 distinct built-in agents/);
  assert.equal(r.missing.length, 0);
});

test("the SAME log with rc removed is INSUFFICIENT: T1, T2 and T4 have no ground truth, the consensus is REPORTED not gated, and the missing line names the hint headers", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", noRc(passRows()));
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "INSUFFICIENT"); assert.equal(r.groundTruthMissing, true);
  assert.match(r.missing[0], /^ground truth missing: rc is logged on 0 of 620 rows; enable the gateway hint headers \(CLAUDE_CODE_GATEWAY_HINT_HEADERS=1; the router reads the x-claude-code-request-class header\) so the router sees the client's own request class$/);
  for (const id of ["T1", "T2", "T4"]) { assert.equal(r.metrics[id].status, "INSUFFICIENT"); assert.equal(r.metrics[id].n, 0); }
  assert.equal(r.metrics.T5.status, "PASS");                                       // two independent header signals: a real cross-check without rc
  assert.equal(r.metrics.CONS.status, "REPORTED"); assert.equal(r.metrics.CONS.subOk, 200); assert.equal(r.metrics.CONS.mainOk, 220);
  assert.match(text.join("\n"), /GROUND TRUTH MISSING: rc is logged on 0 of 620 rows/);
  assert.match(text.join("\n"), /CONSENSUS \(REPORTED, not gated\): 200 of 200 requests with both detectors set and tools were classified sub, 220 of 220/);
  // a router that called every one of them wrong is still INSUFFICIENT, not FAIL, because there is nothing to judge it against
  const wrong = noRc(passRows()).map((x) => (x.cls === "sub" ? { ...x, cls: "main" } : x));
  const d2 = tmp(); writeLog(d2, "classify.jsonl", wrong);
  const w = (await evalDir(d2, { versions: VERS })).record;
  assert.equal(w.metrics.T1.status, "INSUFFICIENT"); assert.equal(w.metrics.CONS.subOk, 0);
});

test("without versions the verdict is INSUFFICIENT (T6), never PASS", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", passRows());
  const { record: r } = await evalDir(d);
  assert.equal(r.verdict, "INSUFFICIENT"); assert.equal(r.metrics.T6.status, "INSUFFICIENT");
  assert.ok(r.missing.some((m) => /--cc-version/.test(m)));
  const half = await evalDir(d, { versions: { cc: "1.0.0" } });
  assert.equal(half.record.metrics.T6.status, "INSUFFICIENT");
});

test("T1 thresholds: 2 misses in 200 pass (99.0%, Wilson 97.7%), 3 fail (98.5%), and a miss is classified aux, main or other", async () => {
  const miss = async (k, cls = "aux") => {
    const rows = passRows(); let n = 0;
    for (const x of rows) if (x.at && n < k) { x.cls = cls; n++; }
    const d = tmp(); writeLog(d, "classify.jsonl", rows);
    return (await evalDir(d, { versions: VERS })).record;
  };
  assert.equal((await miss(0)).metrics.T1.status, "PASS");
  const r1 = await miss(1); assert.equal(r1.metrics.T1.status, "PASS"); assert.equal(r1.metrics.T1.misses, 1);
  const r2 = await miss(2); assert.equal(r2.metrics.T1.status, "PASS");
  const r3 = await miss(3); assert.equal(r3.metrics.T1.status, "FAIL"); assert.equal(r3.verdict, "FAIL");
  assert.match(r3.metrics.T1.reason, /need at least 99% and 97%/);
  assert.equal((await miss(3, "main")).metrics.T1.status, "FAIL");
  assert.equal((await miss(3, "other")).metrics.T1.status, "FAIL");
  assert.equal((await miss(3, "exempt")).metrics.T1.status, "PASS");          // an exempt class is a deliberate keep, not a bypass
});

test("T1 below its minimum is INSUFFICIENT with the count, and says how many requests are missing", async () => {
  const d = tmp();
  const short = passRows(); short.splice(short.findIndex((x) => x.at), 1);
  writeLog(d, "classify.jsonl", short);     // 199 rc-labelled requests
  const { record: r } = await evalDir(d, { versions: VERS });
  assert.equal(r.metrics.T1.status, "INSUFFICIENT");
  assert.match(r.metrics.T1.reason, /^199 of 200 rc-labelled tool-carrying subagent requests/);
  assert.ok(r.missing.some((m) => /T1 needs 1 more/.test(m)));
  assert.equal(r.verdict, "INSUFFICIENT");
});

test("a per-type shortfall reads 'N of 5'-style and names the types", async () => {
  const rows = passRows(); let n = 0;
  for (const x of rows) if (x.at === "Plan" && n++ >= 12) x.at = "Explore";       // Plan keeps 12, Explore takes the rest
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const { record: r } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "INSUFFICIENT");
  const m = r.minimums.find((x) => x.id === "subagent-types");
  assert.equal(m.ok, false); assert.equal(m.have, 4);
  assert.match(m.text, /^4 of 5 subagent types with 40 requests each \(.*at:Plan 12/);
});

// ------------------------------------------------------------------ T2 (population and rule per plan 12.5)
test("T2 is zero-tolerance: an rc helper classified sub fails at any sample size, a decision-log helper returned on another model fails too", async () => {
  const rows = passRows(); rows.find((x) => x.rc === "auxiliary").cls = "sub";
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const r = (await evalDir(d, { versions: VERS })).record;
  assert.equal(r.metrics.T2.status, "FAIL"); assert.equal(r.verdict, "FAIL"); assert.equal(r.metrics.T2.classifiedSub, 1);
  const d2 = tmp(); writeLog(d2, "classify.jsonl", [row({ cls: "aux", ag: 1, nt: 0, aid: "x" })]);
  writeLog(d2, "decisions.jsonl", [decision({ tools: 0, ag: 1, bl: 0, ret: "groq/g1" })]);
  const r2 = (await evalDir(d2)).record;
  assert.equal(r2.metrics.T2.status, "FAIL"); assert.equal(r2.metrics.T2.decisionRowsRewritten, 1); assert.equal(r2.metrics.T2.decisionRowsHelperShaped, 1);
  const d3 = tmp(); writeLog(d3, "classify.jsonl", [row({ cls: "aux", ag: 1, nt: 0, aid: "x" })]);
  writeLog(d3, "decisions.jsonl", [decision({ tools: 0, ag: 1, bl: 0, ret: SONNET })]);
  assert.equal((await evalDir(d3)).record.metrics.T2.status, "INSUFFICIENT");     // the same asked model returned: no rewrite
});

test("T2 rule: a helper (rc) the router called MAIN with no detector set is a sample and never a violation; main with a detector set, exempt, sub and other are violations", async () => {
  const verdictOfHelpers = async (...rows) => (await verdictOf(rows)).metrics.T2;
  const okMain = await verdictOfHelpers(row({ rc: "auxiliary", cls: "main", ag: 0, bl: 0, nt: 0 }), row({ rc: "compaction", cls: "main", ag: 0, bl: 0, nt: 3 }));
  assert.equal(okMain.status, "INSUFFICIENT"); assert.equal(okMain.rewritten, 0); assert.equal(okMain.passthroughMain, 2); assert.equal(okMain.n, 2);
  assert.equal((await verdictOfHelpers(row({ rc: "auxiliary", cls: "main", ag: 1, bl: 0, aid: "a", nt: 0 }))).status, "FAIL");     // an agent id and still main: a bypass of the classifier
  assert.equal((await verdictOfHelpers(row({ rc: "auxiliary", cls: "main", ag: 0, bl: 1, nt: 0 }))).status, "FAIL");
  assert.equal((await verdictOfHelpers(row({ rc: "auxiliary", cls: "exempt", ag: 0, bl: 0, nt: 0 }))).status, "FAIL");
  assert.equal((await verdictOfHelpers(row({ rc: "compaction", cls: "sub", ag: 0, bl: 0, nt: 2 }))).status, "FAIL");
  assert.equal((await verdictOfHelpers(row({ rc: "compaction", cls: "other", ag: 0, bl: 0, nt: 0 }))).status, "FAIL");
  // detector-shaped helper rows without rc: a violation still fails, and the arms are the same
  assert.equal((await verdictOfHelpers(row({ cls: "exempt", ag: 1, bl: 0, aid: "z", nt: 0 }))).status, "FAIL");
  assert.equal((await verdictOfHelpers(row({ cls: "main", ag: 1, bl: 0, aid: "z", nt: 0 }))).status, "FAIL");
  assert.equal((await verdictOfHelpers(row({ cls: "aux", ag: 1, bl: 0, aid: "z", nt: 0 }))).status, "INSUFFICIENT");
  // a real helper (haiku, no tools, no flags) classified main without rc is reported, and is not a T2 sample
  const un = await verdictOfHelpers(row({ cls: "main", ag: 0, bl: 0, nt: 0, m: HAIKU }), row({ cls: "main", ag: 0, bl: 0, nt: 0, m: HAIKU }));
  assert.equal(un.n, 0); assert.equal(un.unlabelledHelperShapedMain, 2); assert.equal(un.status, "INSUFFICIENT");
});

test("T2 boundary: 200 clean rc-labelled helper requests PASS, 199 are INSUFFICIENT with the count", async () => {
  const mk = async (drop) => { const rows = passRows(); for (let k = 0; k < drop; k++) rows.splice(rows.findIndex((x) => x.cls === "aux"), 1); const d = tmp(); writeLog(d, "classify.jsonl", rows); return (await evalDir(d, { versions: VERS })).record; };
  assert.equal((await mk(0)).metrics.T2.status, "PASS");
  const r = await mk(1);                                                          // 199 helpers
  assert.equal(r.metrics.T2.status, "INSUFFICIENT"); assert.match(r.metrics.T2.reason, /^199 of 200 rc-labelled helper requests/);
});

// ------------------------------------------------------------------ T4
test("T4 boundary and zero tolerance: 200 clean rc main requests PASS, 199 INSUFFICIENT, a main (rc) classified sub FAILS, a main-learn caused by a subagent FAILS; detector-only main rows are not samples", async () => {
  const mk = async (main, extra = [], dec = []) => { const d = tmp(); writeLog(d, "classify.jsonl", [...passRows({ main }), ...extra]); if (dec.length) writeLog(d, "decisions.jsonl", dec); return (await evalDir(d, { versions: VERS })).record; };
  assert.equal((await mk(200)).metrics.T4.status, "PASS");
  const r199 = await mk(199); assert.equal(r199.metrics.T4.status, "INSUFFICIENT"); assert.match(r199.metrics.T4.reason, /^199 of 200 rc-labelled main requests/);
  const bad = await mk(220, [row({ cls: "sub", rc: "main", ag: 0, bl: 0 })]);
  assert.equal(bad.metrics.T4.status, "FAIL"); assert.equal(bad.metrics.T4.misclassified, 1); assert.equal(bad.verdict, "FAIL");
  const learn = await mk(220, [], [decision({ act: "main-learn", role: "main", ag: 1, bl: 0, tools: 5 })]);
  assert.equal(learn.metrics.T4.status, "FAIL"); assert.equal(learn.metrics.T4.mainLearnNonMain, 1);
  const okLearn = await mk(220, [], [decision({ act: "main-learn", role: "main", ag: 0, bl: 0, tools: 5 })]);
  assert.equal(okLearn.metrics.T4.status, "PASS");
  const det = await mk(199, Array.from({ length: 500 }, (_, i) => row({ t: iso(D2 + i), rc: null })));
  assert.equal(det.metrics.T4.n, 199); assert.equal(det.metrics.T4.status, "INSUFFICIENT"); assert.equal(det.metrics.CONS.mainN, 199 + 500);
});

test("rc is the ground truth when logged: a request rc calls subagent that the router called main is a T1 miss; helper-by-rc classified sub is a T2 miss", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ rc: "subagent", cls: "main" }), row({ rc: "subagent", cls: "sub", ag: 1, bl: 1, aid: "a" }), row({ rc: "compaction", cls: "sub", ag: 1, bl: 0, aid: "b", nt: 3 })]);
  const r = (await evalDir(d)).record;
  assert.equal(r.metrics.T1.n, 2); assert.equal(r.metrics.T1.misses, 1);
  assert.equal(r.metrics.T2.classifiedSub, 1); assert.equal(r.metrics.T2.status, "FAIL");
  assert.equal(r.populations.rcLogged, 3);
});

// ------------------------------------------------------------------ T5, independence
test("T5 counts the built-in shape only: 40 built-in from 40 agents pass; one without an agent id in 40 is 2.5% and fails; teammates never count", async () => {
  const mk = async (bad) => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(row({ cls: "sub", ag: i < bad ? 0 : 1, bl: 1, aid: i < bad ? null : `a${i}`, nt: 9 }));
    for (let i = 0; i < 500; i++) rows.push(row({ cls: "sub", ag: 1, bl: 0, aid: `t${i}`, nt: 9 }));
    const d = tmp(); writeLog(d, "classify.jsonl", rows);
    return (await evalDir(d)).record.metrics.T5;
  };
  const ok = await mk(0); assert.equal(ok.status, "PASS"); assert.equal(ok.agents, 40);
  const f = await mk(1); assert.equal(f.status, "FAIL"); assert.match(f.reason, /2\.50% of 40 built-in/);
});

test("teammates (an agent id and no billing flag) are reported apart, never counted in T1 and never as built-in agents", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ cls: "sub", ag: 1, bl: 0, aid: "t1", nt: 9 }), row({ cls: "sub", ag: 1, bl: 0, aid: "t2", nt: 9 })]);
  const { record: r, text } = await evalDir(d);
  assert.equal(r.metrics.T1.n, 0); assert.equal(r.single.n, 2); assert.equal(r.typeCounts.teammate, 2);
  assert.equal(r.minimums.find((m) => m.id === "distinct-agents").have, 0);
  assert.match(text.join("\n"), /UNCORROBORATED .*2 tool-carrying requests, classified sub 2 \(100\.0%\)/);
});

test("distinct days, sessions and built-in agents are gated: one day short, one session, and too few agents make it INSUFFICIENT and name the shortfall", async () => {
  const oneDay = passRows().map((x) => ({ ...x, t: iso(Date.parse(x.t) % DAY + D2 - (D2 % DAY)) }));
  const d = tmp(); writeLog(d, "classify.jsonl", oneDay);
  const { record: r } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "INSUFFICIENT");
  assert.ok(r.missing.some((m) => /^1 of 2 UTC days with client traffic/.test(m)));
  const one = passRows().map((x) => ({ ...x, sid: "s1aaaaaa" }));
  const d2 = tmp(); writeLog(d2, "classify.jsonl", one);
  assert.ok((await evalDir(d2, { versions: VERS })).record.missing.some((m) => /^1 of 3 client sessions with at least 20 requests/.test(m)));
  const few = passRows().filter((x) => !x.at || Number(String(x.aid).split("-")[1]) < 5);
  const d3 = tmp(); writeLog(d3, "classify.jsonl", few);
  const m3 = (await evalDir(d3, { versions: VERS })).record.minimums.find((m) => m.id === "distinct-agents");
  assert.equal(m3.ok, false); assert.equal(m3.have, 25);
});

test("a /model switch is counted on tool-carrying main requests only: a switch visible only on tool-less rows does not count", async () => {
  const rows = passRows().map((x) => (x.rc === "main" && x.m === OPUS ? { ...x, nt: 0 } : x));
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const r = (await evalDir(d, { versions: VERS })).record;
  assert.equal(r.verdict, "INSUFFICIENT"); assert.ok(r.missing.some((m) => /^0 of 1 sessions whose main model changed/.test(m)));
  const none = passRows().map((x) => (x.cls === "main" ? { ...x, m: SONNET } : x));
  const d2 = tmp(); writeLog(d2, "classify.jsonl", none);
  assert.ok((await evalDir(d2, { versions: VERS })).record.missing.some((m) => /^0 of 1 sessions whose main model changed/.test(m)));
  const d3 = tmp(); writeLog(d3, "classify.jsonl", passRows());
  assert.equal((await evalDir(d3, { versions: VERS })).record.minimums.find((m) => m.id === "main-model-switch").have, 1);
});

// ------------------------------------------------------------------ probe traffic
test("sessionless probe traffic is excluded from EVERY denominator and the output says so (hasSid false, the 'nosessio' spelling, an empty sid)", async () => {
  const base = passRows();
  const probe = [];
  for (let i = 0; i < 300; i++) probe.push(row({ hasSid: false, sid: "s9zzzzzz", cls: i % 3 ? "main" : "aux", ag: i % 3 ? 0 : 1, nt: i % 3 ? 3 : 0, aid: i % 3 ? null : "p", rc: i % 2 ? "main" : "auxiliary" }));
  for (let i = 0; i < 50; i++) probe.push(row({ sid: "nosessio", hasSid: undefined, cls: "sub", ag: 1, bl: 1, aid: "q", nt: 9, rc: "subagent" }));      // an older line: only the spelling tells
  for (let i = 0; i < 20; i++) probe.push(row({ sid: "", hasSid: undefined, cls: "main", rc: "main" }));
  const d1 = tmp(); writeLog(d1, "classify.jsonl", base);
  const d2 = tmp(); writeLog(d2, "classify.jsonl", [...probe.slice(0, 150), ...base, ...probe.slice(150)]);
  const a = await evalDir(d1, { versions: VERS }), b = await evalDir(d2, { versions: VERS });
  for (const id of ["T1", "T2", "T4", "T5"]) assert.deepEqual({ ...b.record.metrics[id], reason: 0 }, { ...a.record.metrics[id], reason: 0 }, `${id} unchanged by probe traffic`);
  assert.deepEqual(b.record.populations.classes, a.record.populations.classes);
  assert.equal(b.record.populations.probeExcluded, 370); assert.equal(b.record.populations.probeAgentShaped, 100 + 50);
  assert.equal(b.record.populations.clientCounted, a.record.populations.clientCounted);
  assert.equal(b.record.populations.rcLogged, a.record.populations.rcLogged);
  assert.equal(b.record.evidence.sha256, a.record.evidence.sha256);
  assert.match(b.text.join("\n"), /EXCLUDED from every denominator below: 370 of \d+ classifier lines in the window are sessionless probe traffic/);
  assert.equal(b.record.verdict, "PASS");
});

test("probe rows in the decision and agent logs are excluded from the observed tally and from T2", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row()]);
  writeLog(d, "decisions.jsonl", [decision({ sid: "nosessio", tools: 0, ag: 1, ret: "groq/g1" }), decision({ sid: "s1aaaaaa" })]);
  writeLog(d, "agents.jsonl", [{ v: 2, t: iso(D2), sid: "nosessio", asked: SONNET, would: "groq/g1", act: "substitute" }, { v: 2, t: iso(D2), sid: "s1aaaaaa", asked: SONNET, would: "groq/g2", act: "substitute" }]);
  const r = (await evalDir(d)).record;
  assert.equal(r.metrics.T2.decisionRowsRewritten, 0);
  assert.equal(r.populations.decisionProbeExcluded, 1); assert.equal(r.populations.agentProbeExcluded, 1);
  assert.equal(r.shadow.observed.requests.n, 1); assert.equal(r.shadow.observed.agents.n, 1);
  assert.deepEqual(r.shadow.observed.agents.byProvider, [["groq", 1]]);
});

// ------------------------------------------------------------------ robustness
test("old-format lines (no hasSid, no ua, no ga) are counted by their session spelling", async () => {
  const old = (o) => { const x = row(o); delete x.hasSid; delete x.ua; delete x.ga; return x; };
  const d = tmp(); writeLog(d, "classify.jsonl", [old({ cls: "sub", ag: 1, bl: 1, aid: "a", nt: 9 }), old({ sid: "nosessio", cls: "main" }), old({})]);
  const r = (await evalDir(d)).record;
  assert.equal(r.populations.clientCounted, 2); assert.equal(r.populations.probeExcluded, 1); assert.equal(r.populations.classes.sub, 1);
});

test("a truncated last line, torn lines and non-object lines are skipped and counted; a file without a final newline still counts its last whole line", async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "classify.jsonl"), [J(row()), "{not json", "[1,2]", "null", J(row()), J(row()).slice(0, 40)].join("\n"));
  const { record: r, text } = await evalDir(d);
  assert.equal(r.populations.clientCounted, 2); assert.equal(r.logs.classify.unreadableLines, 4);
  assert.match(text.join("\n"), /4 unreadable lines skipped/);
  const d2 = tmp(); fs.writeFileSync(path.join(d2, "classify.jsonl"), J(row()) + "\n" + J(row()));
  assert.equal((await evalDir(d2)).record.populations.clientCounted, 2);
});

test("only some generations present: absent ones are listed, present ones are read oldest first, nothing throws; an empty folder is INSUFFICIENT with no traffic", async () => {
  const d = tmp();
  writeLog(d, "classify.1.jsonl", [row({ t: iso(D1) })]); writeLog(d, "classify.jsonl", [row({ t: iso(D2) })]);
  const { record: r, text } = await evalDir(d);
  assert.equal(r.populations.clientCounted, 2);
  assert.deepEqual(r.logs.classify.files.map((f) => `${f.name}:${f.state}`), ["classify.2.jsonl:absent", "classify.1.jsonl:read", "classify.jsonl:read"]);
  assert.match(text.join("\n"), /absent: classify\.2\.jsonl/);
  const empty = tmp();
  const e = (await evalDir(empty, { versions: VERS })).record;
  assert.equal(e.verdict, "INSUFFICIENT"); assert.equal(e.populations.clientCounted, 0); assert.equal(e.age.status, "INSUFFICIENT");
  assert.equal((await evalDir(path.join(empty, "nope"))).record.verdict, "INSUFFICIENT");
});

test("hostile fields never throw and never reach the output: odd types, a megabyte model, prototype names, control characters", async () => {
  const secret = "SECRET-AGENT-ID-7f3a", sidSecret = "SECRETSID";
  const rows = [
    row({ ag: "1", bl: "yes", nt: "5", cls: "__proto__", m: "x".repeat(1 << 20) }),
    row({ cls: "sub", ag: 1, bl: 1, aid: { evil: 1 }, m: 12345, nt: 3, tc: "big", rc: "evil", at: "has space" }),
    row({ cls: "sub", ag: 1, bl: 1, aid: secret, nt: 3, at: "‮bad", sid: sidSecret + "\u0000\u001b[31m", rc: "subagent" }),
    row({ t: "garbage" }), row({ t: null }), row({ cls: 5 }), row({ nt: -4 }), row({ nt: null }), row({ ag: 1, bl: 0, nt: Infinity }), row({ bb: "__proto__" }), row({ bb: { a: 1 } }),
    { t: iso(D2), cls: "main", ag: 0, bl: 0, nt: 1, constructor: { prototype: 1 }, __proto__x: 1 },
  ];
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  writeLog(d, "decisions.jsonl", [{ t: iso(D2), sid: 5, ag: [], tools: "0", asked: { a: 1 }, would: "x".repeat(10000), act: "keep", role: "sub" }, decision({ asked: "x".repeat(5000), would: "p/".repeat(3000) })]);
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.ok(["PASS", "FAIL", "INSUFFICIENT"].includes(r.verdict));
  const out = text.join("\n") + J(r);
  assert.ok(!out.includes(secret) && !out.includes(sidSecret), "no raw agent or session id is printed");
  assert.ok(!/[\u0000-\u0008\u000b\u001b‮]/.test(text.join("\n")), "no control or bidi characters in the text");
  assert.ok(out.length < 200000, `output stays bounded (${out.length})`);
  assert.equal(Object.hasOwn(r.matrix, "__proto__"), false);
});

test("an 8.5 MiB classifier file is processed in bounded memory (peak heap growth under 40 MiB) and its first partial line is dropped", async () => {
  const d = tmp(), f = path.join(d, "classify.jsonl");
  const fd = fs.openSync(f, "w");
  let bytes = 0, i = 0;
  while (bytes < 8.5 * 1024 * 1024) {
    const sub = i % 3 === 0;
    const line = J(row({ t: iso(D2 + (i % 100000) * 100), sid: `s${i % 7}aaaaaaa`, cls: sub ? "sub" : "main", ag: sub ? 1 : 0, bl: sub ? 1 : 0, aid: sub ? `a${i % 500}` : null, m: i % 11 ? SONNET : OPUS, tc: 1000 + (i % 977) * 3, rc: i % 2 ? (sub ? "subagent" : "main") : null })) + "\n";
    fs.writeSync(fd, line); bytes += line.length; i++;
  }
  fs.closeSync(fd);
  global.gc?.();
  const start = process.memoryUsage().heapUsed; let peak = 0;
  const { record: r } = await evalDir(d, { sample: () => { peak = Math.max(peak, process.memoryUsage().heapUsed - start); } });
  assert.ok(i > 36000 && r.populations.clientCounted >= i - 2, `${i} rows written, ${r.populations.clientCounted} counted`);
  assert.ok(peak < 40 * 1024 * 1024, `peak heap growth ${(peak / 1048576).toFixed(1)} MiB`);
  // a file above the cap gives only its newest part
  const big = tmp(); const bf = path.join(big, "classify.jsonl");
  const lines = Array.from({ length: 2000 }, (_, k) => J(row({ t: iso(D2 + k) }))).join("\n") + "\n";
  fs.writeFileSync(bf, lines);
  const seen = []; const log = A.streamJsonl(big, ["classify.jsonl"], (o) => seen.push(o), { maxBytes: 100000 });
  assert.equal(log.files[0].truncated, true); assert.ok(seen.length < 2000 && seen.length > 100); assert.equal(log.unreadableLines, 0);
  assert.ok(Math.abs(seen.length * (lines.length / 2000) - 100000) < 2 * (lines.length / 2000));
  await new Promise((r2) => setImmediate(r2));
});

test("the window: lines older than --since are not counted, the evidence must be under 7 days old, and a line more than 5 minutes in the future is a clock fault", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ t: iso(NOW - 10 * DAY) }), row({ t: iso(NOW - 2 * DAY) }), row({ t: iso(NOW + 5 * DAY) }), row({ t: iso(NOW - 40 * DAY) })]);
  const week = (await evalDir(d, { sinceMsV: 7 * DAY })).record, month = (await evalDir(d, { sinceMsV: 30 * DAY })).record;
  assert.equal(week.populations.clientCounted, 1); assert.equal(month.populations.clientCounted, 2);
  assert.equal(week.age.status, "PASS"); assert.ok(Math.abs(week.window.newestAgeDays - 2) < 0.01);
  assert.equal(month.populations.futureExcluded, 1);
  const stale = tmp(); writeLog(stale, "classify.jsonl", [row({ t: iso(NOW - 30.5 * DAY) })]);
  const s = (await evalDir(stale, { sinceMsV: 90 * DAY })).record;      // the engine clamps the window to 30 days
  assert.equal(s.populations.clientCounted, 0); assert.equal(s.age.status, "INSUFFICIENT");
  const ageOf = async (days) => { const x = tmp(); writeLog(x, "classify.jsonl", [row({ t: iso(NOW - days * DAY) })]); const r = (await evalDir(x)).record; return [r.populations.clientCounted, r.age.status]; };
  assert.deepEqual(await ageOf(29.5), [1, "INSUFFICIENT"]);             // counted, but too old to be evidence
  assert.deepEqual(await ageOf(6.5), [1, "PASS"]);
  assert.deepEqual(await ageOf(7.5), [1, "INSUFFICIENT"]);
  const fut = async (ms) => { const x = tmp(); writeLog(x, "classify.jsonl", [row({ t: iso(NOW + ms) })]); return (await evalDir(x)).record.populations.clientCounted; };
  assert.equal(await fut(4 * 60000), 1); assert.equal(await fut(6 * 60000), 0);
  // a future-dated row cannot mint a second UTC day
  const day = tmp(); writeLog(day, "classify.jsonl", [row({ t: iso(NOW - 60000) }), row({ t: iso(NOW + DAY) })]);
  assert.equal((await evalDir(day)).record.window.days.length, 1);
});

test("a PASS fixture whose newest request is 10 days old is INSUFFICIENT on age alone (AGE is gated); at 6 days it passes", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", passRows());
  const newest = Math.max(...passRows().map((x) => Date.parse(x.t)));
  const old = (await A.runEvaluation({ stateDir: d }, { nowMs: newest + 10 * DAY, tally: false, versions: VERS })).record;
  assert.equal(old.verdict, "INSUFFICIENT"); assert.equal(old.age.status, "INSUFFICIENT");
  assert.deepEqual(old.missing.filter((m) => !/^AGE/.test(m)), []);
  const fresh = (await A.runEvaluation({ stateDir: d }, { nowMs: newest + 6 * DAY, tally: false, versions: VERS })).record;
  assert.equal(fresh.verdict, "PASS");
});

// ------------------------------------------------------------------ the shadow tally
const mkRow = (s, o = {}) => ({ s, c: 200000, f: 1, t: "v", h: 0, m: 0, n: 0, i: "free", p: 0, pb: 0, al: 0, fp: 1, ft: 0, g: 0, b: 0, bk: 0, ...o });
function view(owner, rows, { exempt = [HAIKU], ctxHints = {}, byProvider, prov } = {}) {
  const models = rows.map((r) => (typeof r === "string" ? mkRow(r) : r));
  const bp = byProvider ?? models.reduce((a, r, i) => { (a[r.s.split("/")[0]] ??= []).push(i); return a; }, {});
  return A.policyView({ owner: { source: "all-providers", mode: "dynamic", banded: true, ...owner }, models, lists: { all: null, byProvider: bp, ...(prov ? { prov } : {}) }, exempt, ctxHints });
}
const ROWS = ["groq/g1", "groq/g2", "groq/g3", "cohere/c1", "groq/g4"];
const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);

test("shadowTally: free and dynamic spread a moved request over the lead pool of 3, inherit follows main, exempt and keep are not moved, no main and no pool are counted apart", () => {
  const dyn = view({ mode: "dynamic" }, ROWS), free = view({ mode: "free" }, ROWS), inh = view({ mode: "inherit" }, ROWS);
  const aggs = [
    { asked: SONNET, main: "groq/g1", tc: 1000, n: 30 },        // asked not in set: moves
    { asked: HAIKU, main: "groq/g1", tc: 1000, n: 5 },          // exempt under inherit
    { asked: "groq/g2", main: "groq/g1", tc: 1000, n: 7 },      // asked in the set: dynamic and free keep it
    { asked: SONNET, main: null, tc: 1000, n: 4 },              // no learned main
    { asked: SONNET, main: "groq/g1", tc: 9000000, n: 2 },      // nothing fits that many tokens
  ];
  const [d, i, f] = A.shadowTally(aggs, { dynamic: dyn, inherit: inh, free });
  assert.equal(d.requests, 48);
  assert.equal(d.keep, 7); assert.equal(d.none, 2); assert.equal(d.noMain, 0); assert.equal(d.moved, 30 + 5 + 4);   // all-providers: no main needed; haiku moves under dynamic
  near(d.byProvider.get("groq") + (d.byProvider.get("cohere") ?? 0), 39);
  // main groq/g1 is usable and in the lead band (all rows are band 0), so main-first picks it for the 35 moved requests that have a main; the 4 without one spread over the first 3 rows
  near(d.byModel.get("groq/g1"), 35 + 4 / 3); near(d.byModel.get("groq/g2"), 4 / 3); near(d.byModel.get("groq/g3"), 4 / 3); assert.equal(d.byModel.has("groq/g4"), false);
  assert.equal(i.moved, 30 + 7 + 2 + 0); assert.equal(i.keep, 5); assert.equal(i.noMain, 4); near(i.byModel.get("groq/g1"), 39);
  assert.equal(f.moved, d.moved); assert.equal(f.mode, "free");
});

test("shadowTally: with no usable main the pool is the first 3 rows of the lead band, shared equally (expected value), a higher band is never mixed in, and a context hint raises the floor", () => {
  const rows = [mkRow("a/m1"), mkRow("a/m2"), mkRow("b/m3"), mkRow("b/m4", { b: 1 }), mkRow("c/m5", { b: 1 })];
  const v = view({ mode: "dynamic" }, rows);
  const t = A.shadowTally([{ asked: SONNET, main: null, tc: 100, n: 30 }], { dynamic: v })[0];
  assert.equal(t.moved, 30); assert.equal(t.byModel.get("a/m1"), 10); assert.equal(t.byModel.get("a/m2"), 10); assert.equal(t.byModel.get("b/m3"), 10);
  assert.equal(t.byModel.has("b/m4"), false);
  const thin = A.shadowTally([{ asked: SONNET, main: null, tc: 100, n: 4 }], { dynamic: view({ mode: "dynamic" }, [mkRow("a/m1"), mkRow("b/m2", { b: 1 }), mkRow("c/m3", { b: 1 })]) })[0];
  assert.deepEqual([...thin.byModel.entries()], [["a/m1", 4]]);                                                      // one row in the lead band: the next band is not mixed in to fill K
  const unbanded = A.shadowTally([{ asked: SONNET, main: null, tc: 100, n: 3 }], { dynamic: view({ mode: "dynamic", banded: false }, [mkRow("a/m1"), mkRow("b/m2", { b: 1 }), mkRow("c/m3", { b: 1 })]) })[0];
  assert.equal(unbanded.byModel.size, 3);                                                                             // banding off: the first K rows whatever their band
  const hinted = view({ mode: "dynamic" }, rows, { ctxHints: { [SONNET]: 1000000 } });
  assert.equal(A.shadowTally([{ asked: SONNET, main: null, tc: 100, n: 5 }], { dynamic: hinted })[0].none, 5);       // every row is 200k, the floor is 1M
  const same = view({ mode: "dynamic", source: "same-provider" }, rows);
  const s = A.shadowTally([{ asked: SONNET, main: null, tc: 100, n: 3 }, { asked: SONNET, main: "zzz/none", tc: 100, n: 4 }, { asked: SONNET, main: "b/m3", tc: 100, n: 6 }], { dynamic: same })[0];
  assert.equal(s.noMain, 3); assert.equal(s.none, 4); assert.equal(s.moved, 6);                                      // same-provider: no main, and a main whose provider has no rows
});

test("shadowTally payload rule: a known cap below the request is unusable, an unknown cap on a request over 200 KB ranks LAST (used only when no known row fits), a proven bk covers it", () => {
  const BIG = 450 * 1024, SMALL = 25 * 1024;
  const rows = [mkRow("u/x1"), mkRow("k/y1", { pb: 1000000 }), mkRow("k/y2", { pb: 1000000 })];
  const v = view({ mode: "dynamic" }, rows);
  const big = A.shadowTally([{ asked: SONNET, main: null, tc: 100, bytes: BIG, n: 10 }], { dynamic: v })[0];
  assert.equal(big.byModel.has("u/x1"), false); near(big.byModel.get("k/y1"), 5); near(big.byModel.get("k/y2"), 5);
  const small = A.shadowTally([{ asked: SONNET, main: null, tc: 100, bytes: SMALL, n: 9 }], { dynamic: v })[0];
  near(small.byModel.get("u/x1"), 3); near(small.byModel.get("k/y1"), 3);                                            // below 200 KB nothing ranks last
  const onlyUnknown = A.shadowTally([{ asked: SONNET, main: null, tc: 100, bytes: BIG, n: 4 }], { dynamic: view({ mode: "dynamic" }, [mkRow("u/x1"), mkRow("u/x2")]) })[0];
  assert.equal(onlyUnknown.moved, 4); near(onlyUnknown.byModel.get("u/x1"), 2);                                       // unknown-cap rows are never excluded, only ranked last
  const tooSmallCap = A.shadowTally([{ asked: SONNET, main: null, tc: 100, bytes: BIG, n: 3 }], { dynamic: view({ mode: "dynamic" }, [mkRow("k/y1", { pb: 100000 })]) })[0];
  assert.equal(tooSmallCap.none, 3);
  const proven = A.shadowTally([{ asked: SONNET, main: null, tc: 100, bytes: BIG, n: 6 }], { dynamic: view({ mode: "dynamic" }, [mkRow("u/x1", { bk: 600000 }), mkRow("k/y1", { pb: 1000000 })]) })[0];
  near(proven.byModel.get("u/x1"), 3);                                                                                // bk 600 KB covers 450 KB: a known fit
  const mainBig = A.shadowTally([{ asked: SONNET, main: "u/x1", tc: 100, bytes: BIG, n: 2 }], { dynamic: v })[0];
  assert.equal(mainBig.byModel.has("u/x1"), false);                                                                   // main-first does not take an unknown-cap main on a big request
  const keepBig = A.shadowTally([{ asked: "k/y1", main: null, tc: 100, bytes: 2 * 1024 * 1024, n: 1 }], { dynamic: v })[0];
  assert.equal(keepBig.keep, 0);                                                                                      // the asked model is in the set but its cap is under the request
});

test("compareShares puts modelled and observed shares side by side with the difference, largest first", () => {
  const c = A.compareShares({ map: new Map([["x", 70], ["y", 30]]), total: 100 }, { map: new Map([["x", 80], ["z", 20]]), total: 100 });
  assert.deepEqual(c.map((r) => [r.k, r.modelled, r.observed, r.diff]), [["x", 70, 80, -10], ["y", 30, 0, 30], ["z", 0, 20, -20]]);
  assert.deepEqual(A.compareShares({ map: new Map(), total: 0 }, { map: new Map(), total: 0 }), []);
});

test("evaluating a fixture state dir compiles the three modes from the fixture inputs, cross-checks the live policy rows, and says which modes are observed", async () => {
  const dir = tmp(), m = fixtureFlagMap(dir), sub = path.join(m["state-dir"], "subagent");
  const rows = [row({ cls: "main", m: SONNET, ga: 1 }), row({ cls: "sub", ag: 1, bl: 1, aid: "a1", nt: 9, m: OPUS }), row({ cls: "sub", ag: 1, bl: 1, aid: "a2", nt: 9, m: SONNET })];
  writeLog(sub, "classify.jsonl", rows);
  const argv = ["--json", "yes", ...Object.entries(m).flatMap(([k, v]) => [`--${k}`, v])];
  const out = [], err = []; const code = await A.runSubagentAccuracy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, { now: NOW });
  assert.equal(code, 0, err.join("\n"));
  const r = JSON.parse(out.join("\n"));
  assert.equal(r.shadow.note, null, String(r.shadow.note));
  assert.deepEqual(r.shadow.modes.map((x) => x.mode), ["dynamic", "inherit", "free"]);
  assert.equal(r.shadow.subagentRequests, 2); assert.deepEqual(r.shadow.askedMain, { known: 2, same: 1 });
  for (const t of r.shadow.modes) assert.equal(t.keep + t.moved + t.none + t.noMain, 2, `${t.mode} partitions the 2 requests`);
  assert.equal(r.shadow.policies.providersLive, false);
  const lines = A.renderText(r).join("\n");
  assert.match(lines, /mode inherit: of 2 subagent requests/);
  assert.match(lines, /SHADOW TALLY .*2 client subagent requests/);
  assert.match(lines, /Observed modes: \? only .*dynamic and inherit are MODELLED ONLY, unvalidated: 1 of 2 subagent requests with a learned main ask the main model itself/);
});

test("--tally no skips the tally; an unreadable input degrades to a note, never an error", async () => {
  const dir = tmp(), m = fixtureFlagMap(dir), sub = path.join(m["state-dir"], "subagent");
  writeLog(sub, "classify.jsonl", [row()]);
  const flags = Object.entries({ ...m, "snapshot-file": path.join(dir, "missing.json") }).flatMap(([k, v]) => [`--${k}`, v]);
  const out = [], err = []; const code = await A.runSubagentAccuracy(["--json", "yes", ...flags], { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, { now: NOW });
  assert.equal(code, 0);
  const r = JSON.parse(out.join("\n"));
  assert.equal(r.shadow.modes, null); assert.match(r.shadow.note, /shadow tally per mode unavailable: E_SNAPSHOT/);
  const out2 = []; await A.runSubagentAccuracy(["--tally", "no", "--json", "yes", ...flags], { out: (l) => out2.push(l), err: () => {} }, {}, { now: NOW });
  assert.equal(JSON.parse(out2.join("\n")).shadow.note, null);
});

test("the observed tally counts the router's own shadow decisions: moved, kept and no-choice, by provider, and under the live policy hash", async () => {
  const dir = tmp(), sub = dir;
  writeLog(sub, "classify.jsonl", [row()]);
  fs.writeFileSync(path.join(sub, "policy.json"), J({ contentHash: "livehash0001", owner: { mode: "free" }, models: [] }));
  writeLog(sub, "decisions.jsonl", [
    decision({ would: "groq/g1", ph: "livehash0001" }), decision({ would: "groq/g2", ph: "old" }), decision({ would: "cohere/c1", ph: "old" }),
    decision({ act: "keep", would: SONNET, ph: "livehash0001" }), decision({ act: "unknown-main", would: null, ph: "old" }),
    decision({ act: "sticky", would: "zzz/x" }), decision({ act: "would-handoff", would: "zzz/y" }), decision({ role: "main", act: "main-learn" }),
  ]);
  const o = (await evalDir(dir)).record.shadow.observed;
  assert.equal(o.requests.n, 5); assert.equal(o.requests.moved, 3); assert.equal(o.requests.keep, 1); assert.equal(o.requests.none, 1);
  assert.deepEqual(o.requests.byProvider, [["groq", 2], ["cohere", 1]]);
  assert.equal(o.requestsUnderLivePolicy.n, 2); assert.equal(o.requestsUnderLivePolicy.moved, 1); assert.equal(o.policyHashesSeen, 2); assert.equal(o.liveHash, "livehash0001");
});

// ------------------------------------------------------------------ CLI
async function cli(argv, opts = {}) {
  const out = [], err = [];
  const code = await A.runSubagentAccuracy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, { now: NOW, ...opts });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const fixture = (rows) => { const dir = tmp(), root = path.join(dir, "state"), sub = path.join(root, "subagent"); writeLog(sub, "classify.jsonl", rows); return { dir, root, sub }; };

test("CLI usage errors exit 2 with the usage text: unknown flag, a flag without a value, --write without --live, --live alone, --since beyond 30 days, a bad unit, stray argument", async () => {
  const f = fixture([row()]);
  for (const argv of [["--bogus", "1"], ["--json"], ["--json", "maybe"], ["--write", "yes", "--state-dir", f.root], ["--live", "yes", "--state-dir", f.root], ["--since", "31d"], ["--since", "90d"], ["--since", "5x"], ["--since", "0d"], ["stray"], ["--cc-version", "a b"], ["--state-dir", ""]]) {
    const r = await cli(argv);
    assert.equal(r.code, 2, `${argv.join(" ")} -> ${r.code} ${r.err}`);
    assert.match(r.err, /usage|flag|argument|--/i);
  }
  assert.match((await cli(["--bogus", "1"])).err, /usage: node keysync\/subagent-accuracy\.mjs/);
  assert.equal((await cli(["--since", "30d", "--state-dir", f.root, "--tally", "no"])).code, 0);
  assert.equal((await cli(["--since", "720h", "--state-dir", f.root, "--tally", "no"])).code, 0);
  assert.equal((await cli(["--since", "721h", "--state-dir", f.root, "--tally", "no"])).code, 2);
});

test("INSUFFICIENT logs are not an error: exit 0, INSUFFICIENT lines with the reason and a dry note; nothing is written without --write yes --live yes", async () => {
  const f = fixture([row()]);
  const before = fs.readdirSync(f.sub).sort();
  const r = await cli(["--state-dir", f.root, "--tally", "no"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /CLASSIFIER ACCURACY: INSUFFICIENT/); assert.match(r.out, /T1 .*: INSUFFICIENT: 0 of 200 rc-labelled tool-carrying subagent requests/); assert.match(r.out, /dry: nothing written/);
  assert.match(r.out, /GROUND TRUTH MISSING: rc is logged on 0 of 1 rows/);
  assert.deepEqual(fs.readdirSync(f.sub).sort(), before);
});

test("--json yes prints valid JSON and nothing else on stdout: the dry and WROTE notes and the replaced-PASS warning go to stderr", async () => {
  const f = fixture(passRows());
  const j = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes"]);
  assert.equal(JSON.parse(j.out).verdict, "INSUFFICIENT"); assert.match(j.err, /^dry: nothing written/);
  const w = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--write", "yes", "--live", "yes", "--cc-version", "9.9.9", "--ccr-version", "3.0.22"]);
  assert.equal(JSON.parse(w.out).verdict, "PASS"); assert.match(w.err, /^WROTE .*accuracy\.json: verdict PASS/);
  const again = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--write", "yes", "--live", "yes"]);
  assert.equal(JSON.parse(again.out).verdict, "INSUFFICIENT");
  assert.match(again.err, /WARNING: replaced an unexpired PASS \(written 2026-10-06T12:00:00\.000Z, valid until 2026-11-05T12:00:00\.000Z\) with INSUFFICIENT/);
});

test("--write yes --live yes writes state/subagent/accuracy.json atomically in the shape the enforce precondition reads: PASS enforces, INSUFFICIENT and a stale PASS are refused", async () => {
  const f = fixture(passRows());
  const HASH = "0123456789abcdef0123456789abcdef";
  fs.writeFileSync(path.join(f.sub, "policy.json"), J({ contentHash: HASH, owner: { mode: "free" }, models: [] }));
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes", "--cc-version", "9.9.9", "--ccr-version", "3.0.22"]);
  assert.equal(r.code, 0, r.err);
  const file = path.join(f.sub, "accuracy.json");
  assert.match(r.out, /WROTE .*accuracy\.json: verdict PASS/);
  assert.deepEqual(fs.readdirSync(f.sub).filter((n) => /tmp/.test(n)), []);
  const acc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(acc.verdict, "PASS"); assert.equal(acc.at, iso(NOW)); assert.equal(acc.ccVersion, "9.9.9"); assert.equal(acc.ccrVersion, "3.0.22");
  assert.ok(acc.minSamples && acc.thresholds && acc.matrix && acc.evidence.sha256);
  assert.equal(acc.evidence.policyContentHash, HASH);                     // the record is bound to the policy it was measured against
  const owner = { enforcement: "enforce" };
  const opts = { contentHash: HASH, ccrVersion: () => "3.0.22", ccVersion: () => "9.9.9" };
  assert.doesNotThrow(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW + DAY, opts));
  assert.throws(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW + 31 * DAY, opts), /E_PRECONDITION|PASS younger than 30 days/);
  const again = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes"]);          // no versions: INSUFFICIENT replaces the PASS and says so
  assert.match(again.out, /verdict INSUFFICIENT \(replaced a previous PASS/);
  assert.match(again.err, /WARNING: replaced an unexpired PASS/);
  assert.throws(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW, opts), /PASS younger than 30 days/);
  // an expired PASS replaced by INSUFFICIENT is not a warning
  const old = fixture(passRows()); fs.writeFileSync(path.join(old.sub, "accuracy.json"), J({ verdict: "PASS", at: iso(NOW - 40 * DAY) }));
  assert.equal((await cli(["--state-dir", old.root, "--tally", "no", "--write", "yes", "--live", "yes"])).err, "");
});

test("a FAIL verdict is written too (it replaces an old PASS), and an unwritable target is exit 1 with no debris", async () => {
  const f = fixture(passRows().map((x, i) => (x.at && i % 40 === 0 ? { ...x, cls: "main" } : x)));
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes", "--cc-version", "1.0.0", "--ccr-version", "1.0.0"]);
  assert.equal(r.code, 0); assert.equal(JSON.parse(fs.readFileSync(path.join(f.sub, "accuracy.json"), "utf8")).verdict, "FAIL");
  const g = fixture(passRows());
  fs.mkdirSync(path.join(g.sub, "accuracy.json"));                                // a directory where the file belongs
  const w = await cli(["--state-dir", g.root, "--tally", "no", "--write", "yes", "--live", "yes"]);
  assert.equal(w.code, 1); assert.match(w.err, /cannot write/);
  assert.deepEqual(fs.readdirSync(g.sub).filter((n) => /tmp-/.test(n)), []);
});

test("a fixture run refuses a path under a real folder (exit 2) and never reads the real state: the real ~/.uw/state is not touched", async () => {
  const real = path.join(os.homedir(), ".uw", "state");
  const r = await cli(["--state-dir", real, "--tally", "no"]);
  assert.equal(r.code, 2); assert.match(r.err, /refusing --state-dir/);
});

test("the text names a denominator on every figure line and prints no id beyond provider/model", async () => {
  const f = fixture(passRows());
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--cc-version", "9.9.9", "--ccr-version", "3.0.22"]);
  for (const l of r.out.split("\n").filter((x) => /^T[1-6] /.test(x))) assert.match(l, /\bof [\d,]+ |no request|not observable|not recorded|recorded|Claude Code|[\d,]+ of [\d,]+/, l);
  assert.ok(!/\ba\d-\d+\b|\bh\d+\b|s[123][a-c]{6}/.test(r.out), "no agent or session id appears");
});

test("the source holds no spawn, no network call and no write other than accuracy.json (a scan)", () => {
  const src = fs.readFileSync(path.join(ROOT, "keysync", "subagent-accuracy.mjs"), "utf8");
  for (const bad of [/child_process/, /\bspawn\w*\(/, /\bexec\w*\(/, /fetch\(/, /https?\.request/, /node:net/, /\brpc\(/, /rmSync|unlinkSync|renameSync|appendFile/]) assert.ok(!bad.test(src), String(bad));
  assert.equal((src.match(/writeFileRetry\(/g) ?? []).length, 1);
  assert.equal((src.match(/writeFileSync\(|writeAtomic\(/g) ?? []).length, 0);
  assert.match(src, /const file = path\.join\(p\.stateDir, "accuracy\.json"\);\s+const prev = readJsonFile\(file\);\s+try \{ writeFileRetry\(file,/);
});

// ------------------------------------------------------------------ boundaries that pin each threshold (test/mutants/subagent-accuracy.mjs breaks each constant and needs one of these to fail)
/** `n` rc-labelled tool-carrying built-in requests cycling over `types` `at` values, `agents` distinct agents (default one per request) and `sessions` sessions; the first `miss` are classified `aux`. */
const subRows = ({ n, types = 5, agents = n, sessions = 3, miss = 0, rc = "subagent" }) => {
  const r = [];
  for (let i = 0; i < n; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + i * 1000), sid: `s${i % sessions}aaaaaaa`, cls: i < miss ? "aux" : "sub", ag: 1, bl: 1, aid: `a${i % agents}`, at: `T${i % types}`, nt: 9, rc }));
  return r;
};
async function verdictOf(rows, o = {}) { const d = tmp(); writeLog(d, "classify.jsonl", rows); return (await evalDir(d, { versions: VERS, ...o })).record; }
const minOf = (r, id) => r.minimums.find((m) => m.id === id);

test("T1 percentage binds on its own: 11 misses in 1000 (98.9%, Wilson about 98.2%) FAILS on the 99% line alone; 10 in 1000 (99.0%) passes", async () => {
  const bad = (await verdictOf(subRows({ n: 1000, miss: 11 }))).metrics.T1, ok = (await verdictOf(subRows({ n: 1000, miss: 10 }))).metrics.T1;
  assert.ok(bad.wilsonLower >= 97 && bad.pct < 99, `${bad.pct} ${bad.wilsonLower}`);
  assert.equal(bad.status, "FAIL"); assert.equal(ok.status, "PASS");
});

test("T1 minimum is exactly 200: 199 rc-labelled requests are INSUFFICIENT, 200 are judged", async () => {
  assert.equal((await verdictOf(subRows({ n: 199 }))).metrics.T1.status, "INSUFFICIENT");
  assert.equal((await verdictOf(subRows({ n: 200 }))).metrics.T1.status, "PASS");
  assert.equal((await verdictOf(subRows({ n: 200, rc: null }))).metrics.T1.status, "INSUFFICIENT");              // the same shape without rc is not ground truth
});

test("T1 independence: 29 agents are INSUFFICIENT, 30 agents have no miss but too weak a per-agent bound, 87 agents are short of 97%, 88 pass; a miss clustered on one agent binds on the per-agent bound", async () => {
  const a29 = (await verdictOf(subRows({ n: 200, agents: 29, sessions: 1 }))).metrics.T1;
  assert.equal(a29.status, "INSUFFICIENT"); assert.match(a29.reason, /^29 of 30 distinct built-in agents/);
  const a30 = (await verdictOf(subRows({ n: 200, agents: 30, sessions: 1 }))).metrics.T1;
  assert.equal(a30.status, "INSUFFICIENT"); assert.match(a30.reason, /per-agent Wilson lower bound is 91\.7%: 88 distinct built-in agents with no miss are needed for 97%/);
  assert.equal((await verdictOf(subRows({ n: 200, agents: 87, sessions: 1 }))).metrics.T1.status, "INSUFFICIENT");
  const a88 = (await verdictOf(subRows({ n: 200, agents: 88, sessions: 1 }))).metrics.T1;
  assert.equal(a88.status, "PASS"); assert.ok(a88.wilsonLowerAgents >= 97 && a88.wilsonLowerAgents < a88.wilsonLowerRequests);
  // two misses of 200 requests (99.0%, Wilson per request 97.7%) from ONE agent among 100: per request it passes, per agent (99 of 100) it does not
  const rows = subRows({ n: 200, agents: 100, sessions: 1 }); rows[0].cls = "aux"; rows[100].cls = "aux";             // both rows belong to agent a0
  const c = (await verdictOf(rows)).metrics.T1;
  assert.ok(c.wilsonLowerRequests >= 97 && c.pct >= 99); assert.ok(c.wilsonLowerAgents < 97);
  assert.equal(c.status, "FAIL"); assert.equal(c.wilsonLower, c.wilsonLowerAgents);
});

test("T5 minimum is 40 built-in requests from 30 agents and its limit is 1% inclusive: 39 requests and 29 agents are INSUFFICIENT; 1 in 100 passes, 2 in 100 fail", async () => {
  assert.equal((await verdictOf(subRows({ n: 39 }))).metrics.T5.status, "INSUFFICIENT");
  assert.equal((await verdictOf(subRows({ n: 40 }))).metrics.T5.status, "PASS");
  const a29 = (await verdictOf(subRows({ n: 40, agents: 29, sessions: 1 }))).metrics.T5; assert.equal(a29.status, "INSUFFICIENT"); assert.match(a29.reason, /^29 of 30 distinct built-in agents/);
  assert.equal((await verdictOf(subRows({ n: 40, agents: 30, sessions: 1 }))).metrics.T5.status, "PASS");
  const one = subRows({ n: 100 }); one[0].ag = 0;
  const two = subRows({ n: 100 }); two[0].ag = 0; two[1].ag = 0;
  assert.equal((await verdictOf(one)).metrics.T5.status, "PASS");                  // exactly 1.00%: at most 1%
  assert.equal((await verdictOf(two)).metrics.T5.status, "FAIL");
  const mix = subRows({ n: 40 }); mix[0].ag = 0;
  assert.equal((await verdictOf(mix)).metrics.T5.status, "FAIL");
});

test("a type needs 40 requests and five types are needed: 39 in the fifth type leaves four types", async () => {
  const mk = (last) => { const r = subRows({ n: 160, types: 4 }); for (let i = 0; i < last; i++) r.push(row({ cls: "sub", ag: 1, bl: 1, aid: `x${i}`, at: "T4", nt: 9, t: iso(D1 + i) })); return r; };
  const t40 = minOf(await verdictOf(mk(40)), "subagent-types"), t39 = minOf(await verdictOf(mk(39)), "subagent-types");
  assert.equal(t40.ok, true); assert.equal(t39.ok, false); assert.equal(t39.have, 4);
});

test("distinct built-in agents: 30 pass, 29 are missing; sessions need 20 requests each: 3 pass, 2 or a session of 19 are missing; main sessions: 2 pass, 1 is missing", async () => {
  assert.equal(minOf(await verdictOf(subRows({ n: 200, agents: 30, sessions: 1 })), "distinct-agents").ok, true);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, agents: 29, sessions: 1 })), "distinct-agents").ok, false);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, sessions: 3 })), "sessions").ok, true);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, sessions: 2 })), "sessions").ok, false);
  const per = (last) => [...Array.from({ length: 100 }, (_, i) => row({ sid: "p1aaaaaa", t: iso(D1 + i) })), ...Array.from({ length: 81 }, (_, i) => row({ sid: "p2bbbbbb", t: iso(D1 + i) })), ...Array.from({ length: last }, (_, i) => row({ sid: "p3cccccc", t: iso(D1 + i) }))];
  const s20 = minOf(await verdictOf(per(20)), "sessions"), s19 = minOf(await verdictOf(per(19)), "sessions");
  assert.equal(s20.ok, true); assert.equal(s20.have, 3); assert.equal(s19.ok, false); assert.equal(s19.have, 2);
  const mains = (sids) => Array.from({ length: 200 }, (_, i) => row({ sid: sids[i % sids.length], m: i % 2 ? OPUS : SONNET, t: iso(D1 + i * 1000), rc: "main" }));
  assert.equal(minOf(await verdictOf(mains(["a1aaaaaa", "a2aaaaaa"])), "main-sessions").ok, true);
  assert.equal(minOf(await verdictOf(mains(["a1aaaaaa"])), "main-sessions").ok, false);
});

test("labelled helper types need 40 each: compaction 39 is short even when the total is 200; rc workflow counts as a subagent", async () => {
  const hs = (c, a) => [...Array.from({ length: c }, (_, i) => row({ cls: "aux", ag: 1, nt: 0, aid: `c${i}`, rc: "compaction", t: iso(D1 + i) })), ...Array.from({ length: a }, (_, i) => row({ cls: "aux", ag: 1, nt: 0, aid: `x${i}`, rc: "auxiliary", t: iso(D1 + i) }))];
  const ok = await verdictOf(hs(40, 160)), bad = await verdictOf(hs(39, 161));
  assert.equal(minOf(ok, "helper-types").ok, true); assert.equal(minOf(bad, "helper-types").ok, false);
  assert.match(minOf(bad, "helper-types").text, /short: compaction 39/);
  const wf = (await verdictOf([row({ rc: "workflow", cls: "main", ag: 0, bl: 0 })])).metrics.T1;
  assert.equal(wf.n, 1); assert.equal(wf.misses, 1);
});

test("a PASS written with no compiled policy on disk carries a NOTE that it records no policy hash (the enforce check would refuse it)", async () => {
  const f = fixture(passRows());
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes", "--cc-version", "9.9.9", "--ccr-version", "3.0.22"]);
  assert.match(r.err, /NOTE: there is no compiled policy .*records no policy content hash/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.sub, "accuracy.json"), "utf8")).evidence.policyContentHash, null);
});

// ------------------------------------------------------------------ round 3: helper rows out of the consensus, whole versions, a start date
test("the detector-consensus counters leave rc-labelled helper rows out (router v4 routes them to the aux path whatever their detectors say), and say how many", async () => {
  const rows = [row({ cls: "sub", ag: 1, bl: 1, aid: "a", nt: 9 }), row({ cls: "main" }),
    row({ cls: "aux", rc: "auxiliary", ag: 1, bl: 1, aid: "h1", nt: 4 }), row({ cls: "aux", rc: "compaction", ag: 0, bl: 0, nt: 0 }), row({ cls: "aux", rc: "compaction", ag: 1, bl: 0, aid: "h2", nt: 7 })];
  const r = (await verdictOf(rows)).metrics;
  assert.equal(r.CONS.subN, 1); assert.equal(r.CONS.subOk, 1); assert.equal(r.CONS.mainN, 1); assert.equal(r.CONS.mainOk, 1); assert.equal(r.CONS.helperExcluded, 3);
  assert.match(r.CONS.reason, /3 rc-labelled helper rows are left out of both counts/);
  assert.notEqual(r.T2.status, "FAIL");                                           // an rc helper the router routed to aux is the correct outcome, tool-carrying or not
  assert.equal(r.T2.n, 3);
  const before = (await verdictOf(rows.slice(0, 2))).metrics.CONS;                // the same two consensus rows alone: the counters do not move
  assert.deepEqual([before.subN, before.subOk, before.mainN, before.mainOk], [1, 1, 1, 1]);
});

test("--cc-version and --ccr-version take exactly what the enforce gate takes: x.y.z with an optional -pre or +build tag; Claude Code may carry its own suffix, which is normalised away", async () => {
  const f = fixture([row()]);
  const rec = async (argv) => { const r = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", ...argv]); return { code: r.code, err: r.err, json: r.code === 0 ? JSON.parse(r.out) : null }; };
  for (const [v, want] of [["3.0.22", "3.0.22"], ["3.0.22-beta.1", "3.0.22-beta.1"], ["3.0.22+build5", "3.0.22+build5"], ["  3.0.22 ", "3.0.22"]]) {
    const r = await rec(["--ccr-version", v]); assert.equal(r.code, 0, v); assert.equal(r.json.ccrVersion, want); assert.equal(r.json.metrics.T6.ccr, want);
  }
  const cc = await rec(["--cc-version", "2.1.289 (Claude Code)", "--ccr-version", "3.0.22"]);
  assert.equal(cc.code, 0); assert.equal(cc.json.ccVersion, "2.1.289"); assert.equal(cc.json.ccrVersion, "3.0.22"); assert.equal(cc.json.metrics.T6.status, "PASS");
  assert.equal((await rec(["--cc-version", "2.1.289", "--ccr-version", "3.0.22"])).json.ccVersion, "2.1.289");
  for (const bad of ["v3.0.22", "1", "1.0", "3.0.22.1", "3.0.22 beta", "3.0.22-", "latest", "3.0.22 (Claude Code)"]) {
    const r = await rec(["--ccr-version", bad]); assert.equal(r.code, 2, `ccr ${bad}`); assert.match(r.err, /whole version/);
  }
  for (const bad of ["v2.1.289", "(Claude Code)", "2.1.289 (claude code)", "2.1.289 (Claude Code) x", "2.1", "2.1.289 Claude Code"]) assert.equal((await rec(["--cc-version", bad])).code, 2, `cc ${bad}`);
  // the engine applies the same rule: a free-text version never counts as recorded
  assert.equal((await verdictOf(passRows(), { versions: { cc: "2.1.289 (Claude Code)", ccr: "3.0.22" } })).verdict, "PASS");
  assert.equal((await verdictOf(passRows(), { versions: { cc: "v2.1.289", ccr: "3.0.22" } })).metrics.T6.status, "INSUFFICIENT");
  assert.equal((await verdictOf(passRows(), { versions: { cc: "2.1.289", ccr: "3.0" } })).metrics.T6.status, "INSUFFICIENT");
});

test("a version the evaluator accepts is one the enforce gate accepts, and one it refuses is refused by the gate too", () => {
  const sub = tmp();
  const HASH = "0123456789abcdef";
  const gate = (ccV, ccrV, installedCc = ccV) => {
    fs.writeFileSync(path.join(sub, "accuracy.json"), J({ verdict: "PASS", at: iso(NOW), ccVersion: ccV, ccrVersion: ccrV, evidence: { policyContentHash: HASH, sha256: "x", classRowsCounted: 1 }, window: {} }));
    return () => LIB.checkEnforcePreconditions({ stateDir: sub }, { providersLive: true }, { enforcement: "enforce" }, NOW, { contentHash: HASH, ccrVersion: () => ccrV, ccVersion: () => installedCc });
  };
  for (const v of ["3.0.22", "3.0.22-beta.1", "3.0.22+build5"]) { assert.ok(A.wholeVersion(v)); assert.doesNotThrow(gate(v, v), v); }
  assert.equal(A.wholeVersion("2.1.289 (Claude Code)", { suffix: "(Claude Code)" }), "2.1.289");
  assert.doesNotThrow(gate("2.1.289 (Claude Code)", "3.0.22", "2.1.289"), "the gate takes the text claude --version prints and compares it whole once the suffix is stripped");
  assert.doesNotThrow(gate(A.wholeVersion("2.1.289 (Claude Code)", { suffix: "(Claude Code)" }), "3.0.22", "2.1.289"));
  for (const bad of ["v3.0.22", "1.0", "3.0.22.1", "latest"]) { assert.equal(A.wholeVersion(bad), null, bad); assert.throws(gate("2.1.289", bad, "2.1.289"), /CCR/, bad); }
});

test("--since DATE bounds the START of the window: earlier rows are not counted, the header and the record say so, a bad or future date is a usage error, a duration still means the window length", async () => {
  const rows = [row({ t: iso(Date.parse("2026-10-05T08:00:00Z")) }), row({ t: iso(Date.parse("2026-10-05T20:00:00Z")) }), row({ t: iso(Date.parse("2026-10-06T08:00:00Z")) })];
  const f = fixture(rows);
  const run = async (since) => cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--since", since]);
  const none = JSON.parse((await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes"])).out);
  assert.equal(none.populations.clientCounted, 3); assert.equal(none.window.from, null);
  const d = JSON.parse((await run("2026-10-05T12:00:00Z")).out);
  assert.equal(d.populations.clientCounted, 2); assert.equal(d.window.from, "2026-10-05T12:00:00.000Z"); assert.equal(d.window.since, "2026-10-05T12:00:00.000Z");
  const day = JSON.parse((await run("2026-10-06")).out);
  assert.equal(day.populations.clientCounted, 1); assert.equal(day.window.from, "2026-10-06T00:00:00.000Z");
  const text = await cli(["--state-dir", f.root, "--tally", "no", "--since", "2026-10-06"]);
  assert.match(text.out, /\(window 2026-10-06 to 2026-10-06, bounded from 2026-10-06T00:00:00\.000Z by --since: discarded 2 client rows incl. 0 violations \(T1 misses 0, T2 0, T4 0, T5 0\); the bound applies to every metric, newest counted request/);
  assert.equal((await run("2026-10-06T23:00:00Z")).code, 2);                        // after now (2026-10-06T12:00Z): an empty window
  assert.match((await run("2026-10-06T23:00:00Z")).err, /in the future/);
  assert.equal((await run("2026-13-45")).code, 2);
  assert.equal((await run("2026-02-30T99:00")).code, 2);
  assert.equal(JSON.parse((await run("7d")).out).window.from, null);               // a duration is the window length, as before
  assert.equal(JSON.parse((await run("2d")).out).populations.clientCounted, 3);
  assert.equal((await run("31d")).code, 2);
  // it is recorded in accuracy.json
  const w = await cli(["--state-dir", f.root, "--tally", "no", "--since", "2026-10-05", "--write", "yes", "--live", "yes"]);
  assert.equal(w.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.sub, "accuracy.json"), "utf8")).window.from, "2026-10-05T00:00:00.000Z");
});

test("the T2 FAIL text says when a --since date would exclude the old rows, names the newest violating day, and the date really excludes them", async () => {
  const old = row({ t: iso(Date.parse("2026-10-05T10:00:00Z")), rc: "auxiliary", cls: "sub", ag: 1, bl: 1, aid: "h", nt: 3 });
  const clean = Array.from({ length: 5 }, (_, i) => row({ t: iso(Date.parse("2026-10-06T08:00:00Z") + i), rc: "auxiliary", cls: "aux", ag: 1, aid: `c${i}`, nt: 3 }));
  const a = (await verdictOf([old, ...clean])).metrics.T2;
  assert.equal(a.status, "FAIL");
  assert.match(a.reason, /; the newest is dated 2026-10-05T10:00:00\.000Z: if the router was fixed after that, --since 2026-10-05T10:00:01\.000Z starts the window just after it \(the bound applies to EVERY metric, T1 and T4 as well as T2, and what it discards is recorded as window\.excludedByFrom;/);
  const b = (await verdictOf([old, ...clean], { sinceDate: "2026-10-05T10:00:01.000Z" })).metrics.T2;           // the instant excludes the old row: nothing left to fail
  assert.equal(b.status, "INSUFFICIENT"); assert.equal(b.n, 5); assert.ok(!/--since/.test(b.reason));
  const c = (await verdictOf([old, ...clean], { sinceDate: "2026-10-05T10:00:00.000Z" })).metrics.T2;           // an instant that does not exclude it: still FAIL, and the hint still names the instant that would
  assert.equal(c.status, "FAIL"); assert.match(c.reason, /--since 2026-10-05T10:00:01\.000Z/);
  // a violation seen only in the decision log carries the hint too; no violation, no hint
  const dd = tmp(); writeLog(dd, "classify.jsonl", [row({ cls: "aux", ag: 1, nt: 0, aid: "x" })]);
  writeLog(dd, "decisions.jsonl", [decision({ t: iso(Date.parse("2026-10-05T23:59:00Z")), tools: 0, ag: 1, bl: 0, ret: "groq/g1" })]);
  const e = (await evalDir(dd)).record.metrics.T2;
  assert.equal(e.status, "FAIL"); assert.match(e.reason, /the newest is dated 2026-10-05T23:59:00\.000Z.*--since 2026-10-05T23:59:01\.000Z/);
  assert.ok(!/--since/.test((await verdictOf(clean)).metrics.T2.reason));
  const f2 = (await verdictOf([old, ...clean], { sinceDate: "2026-10-05T10:00:01Z" })).metrics.T2;     // the old row is one second before the bound: excluded
  assert.equal(f2.status, "INSUFFICIENT");
});

test("the T2 since hint also covers a violation seen only on a detector-shaped helper (no rc)", async () => {
  const shaped = row({ t: iso(Date.parse("2026-10-04T10:00:00Z")), cls: "sub", ag: 1, bl: 0, aid: "z", nt: 0 });
  const r = (await verdictOf([shaped])).metrics.T2;
  assert.equal(r.status, "FAIL"); assert.match(r.reason, /the newest is dated 2026-10-04T10:00:00\.000Z.*--since 2026-10-04T10:00:01\.000Z/);
});

// ------------------------------------------------------------------ round 4: the bound's own effect is visible, the hint is an instant, a datetime states its zone, a day must exist
test("the T2 hint is an INSTANT just after the newest violating row: on the same UTC day as clean rows it keeps them, where the next-day date would be in the future or discard them", async () => {
  const day = Date.parse("2026-10-06T00:00:00Z");
  const bad = row({ t: iso(day + 7 * 3600000), rc: "auxiliary", cls: "sub", ag: 1, bl: 1, aid: "h", nt: 3 });
  const clean = Array.from({ length: 5 }, (_, i) => row({ t: iso(day + 8 * 3600000 + i), rc: "auxiliary", cls: "aux", ag: 1, aid: `c${i}`, nt: 3 }));
  const a = (await verdictOf([bad, ...clean])).metrics.T2;
  const hint = /--since (\d{4}-\d{2}-\d{2}T[0-9:.]+Z) starts the window just after it/.exec(a.reason);
  assert.ok(hint, a.reason);
  assert.equal(hint[1], iso(day + 7 * 3600000 + 1000));
  assert.ok(Date.parse(hint[1]) < NOW, "the suggested instant is not in the future");
  const f = fixture([bad, ...clean]);
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--since", hint[1]]);
  assert.equal(r.code, 0, r.err);                                                   // the hint is accepted as it stands (Z, milliseconds)
  const j = JSON.parse(r.out);
  assert.equal(j.metrics.T2.n, 5); assert.notEqual(j.metrics.T2.status, "FAIL");   // the clean rows of the same day are kept
  assert.equal(j.window.excludedByFrom.t2Viol, 1);
  const nextDay = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--since", "2026-10-07"]);
  assert.equal(nextDay.code, 2); assert.match(nextDay.err, /in the future/);        // what the old hint said: refused, and it would have discarded every clean row
});

test("window.excludedByFrom records what the --since bound discarded (client rows, T1 misses, T2 violations, T4 misses, decision-log legs too), the header prints it, and nothing without a bound", async () => {
  const before = Date.parse("2026-10-05T10:00:00Z"), after = Date.parse("2026-10-06T08:00:00Z");
  const rows = [
    row({ t: iso(before), rc: "subagent", cls: "main", ag: 1, bl: 1, aid: "a1", nt: 9 }),           // T1 miss
    row({ t: iso(before + 1), rc: "auxiliary", cls: "sub", ag: 1, bl: 1, aid: "h1", nt: 3 }),      // T2 violation
    row({ t: iso(before + 2), rc: "main", cls: "sub" }),                                           // T4 miss
    row({ t: iso(before + 3), rc: "main", cls: "main" }),                                          // a clean row: discarded, not a violation
    row({ t: iso(before + 5), cls: "sub", ag: 0, bl: 1, nt: 9 }),                                 // T5: the billing flag without an agent id
    row({ t: iso(before + 4), hasSid: false, sid: "s9zzzzzz", rc: "main", cls: "sub" }),           // probe traffic: not a client row
    row({ t: iso(NOW - 40 * DAY), rc: "main", cls: "sub" }),                                       // older than the window anyway: not discarded BY the bound
    row({ t: iso(after), rc: "main", cls: "main" }),
  ];
  const f = fixture(rows);
  writeLog(f.sub, "decisions.jsonl", [decision({ t: iso(before + 10), tools: 0, ag: 1, bl: 0, ret: "groq/g1" }), decision({ t: iso(before + 11), act: "main-learn", role: "main", ag: 1, bl: 0, tools: 5 }),
    decision({ t: iso(after), tools: 0, ag: 1, bl: 0, ret: "groq/g1" })]);
  const none = JSON.parse((await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes"])).out);
  assert.equal(none.window.excludedByFrom, null); assert.equal(none.window.from, null);
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--since", "2026-10-06"]);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.window.excludedByFrom, { rows: 5, t1Miss: 1, t2Viol: 2, t4Miss: 2, t5Disagree: 1, violations: 6 });
  assert.equal(j.populations.clientCounted, 1);                                      // only the row after the bound is in the verdict
  assert.equal(j.metrics.T2.rewritten, 1);                                           // the decision row AFTER the bound still counts
  const t = await cli(["--state-dir", f.root, "--tally", "no", "--since", "2026-10-06"]);
  assert.match(t.out, /bounded from 2026-10-06T00:00:00\.000Z by --since: discarded 5 client rows incl. 6 violations \(T1 misses 1, T2 2, T4 2, T5 1\); the bound applies to every metric/);
  assert.match(t.out, /^CLASSIFIER ACCURACY: \w+ /);
  const w = await cli(["--state-dir", f.root, "--tally", "no", "--since", "2026-10-06", "--write", "yes", "--live", "yes"]);
  assert.equal(w.code, 0);
  const rec = JSON.parse(fs.readFileSync(path.join(f.sub, "accuracy.json"), "utf8"));
  assert.equal(rec.window.from, "2026-10-06T00:00:00.000Z"); assert.equal(rec.window.excludedByFrom.violations, 6); assert.equal(rec.window.excludedByFrom.t5Disagree, 1);
  assert.match(A.USAGE, /in EVERY metric \(T1, T2, T4 and T5 alike, not T2 only\)/);
});

test("--since DATETIME must state its zone (Z or an offset) and the day must exist", async () => {
  const f = fixture([row({ t: iso(Date.parse("2026-10-06T08:30:00Z")) })]);
  const run = (since) => cli(["--state-dir", f.root, "--tally", "no", "--json", "yes", "--since", since]);
  for (const bare of ["2026-10-05T10:00", "2026-10-05T10:00:00", "2026-10-05T10:00:00.250"]) { const r = await run(bare); assert.equal(r.code, 2, bare); assert.match(r.err.split(String.fromCharCode(10))[0], /needs Z or an offset/); }
  assert.equal((await run("2026-10-06T10:00:00+02:00")).code, 0);
  assert.equal(JSON.parse((await run("2026-10-06T10:00:00+02:00")).out).window.from, "2026-10-06T08:00:00.000Z");   // the offset is converted, not dropped
  assert.equal(JSON.parse((await run("2026-10-06T08:30:00.000Z")).out).populations.clientCounted, 1);               // the bound is inclusive
  assert.equal(JSON.parse((await run("2026-10-06T08:30:00.001Z")).out).populations.clientCounted, 0);
  for (const bad of ["2026-02-30", "2026-04-31", "2026-02-29", "2026-02-30T10:00:00Z", "2026-13-01", "2026-00-10", "2026-06-00", "0050-01-01", "2026-10-06T25:00:00Z"]) assert.equal((await run(bad)).code, 2, bad);
  assert.equal((await run("2024-02-29")).code, 0);                                    // a real leap day
  assert.equal((await run("2026-01-31")).code, 0);
});

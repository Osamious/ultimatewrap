// keysync/subagent-accuracy.mjs (issue #154): the classifier accuracy evaluator and the three-mode shadow tally. Every run reads and writes TEMP folders only: guardRealState fails the file if the real
// ~/.uw/state is touched, and the in-process CLI runs name a fixture --state-dir (or call the engine on a temp folder). Logs are synthetic; no ids of real sessions appear anywhere.
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

/**
 * A log that satisfies EVERY minimum: 220 main requests in 3 sessions on 2 days (one session switches model), 200 built-in subagent requests of 5 `at` types from 100 agents, 200 helper
 * requests labelled by rc (100 compaction, 100 auxiliary), all classified as the router would. `n` scales the counts (a boundary test takes one request away).
 */
function passRows({ main = 220, perType = 40, helpers = 100 } = {}) {
  const r = [];
  const sids = ["s1aaaaaa", "s2bbbbbb", "s3cccccc"];
  for (let i = 0; i < main; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + i * 1000), sid: sids[i % 3], m: i < main / 2 && i % 3 === 0 ? OPUS : SONNET, ga: 1 }));
  ["Explore", "general-purpose", "code-reviewer", "Plan", "statusline"].forEach((at, ti) => {
    for (let i = 0; i < perType; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + 500000 + i * 1000), sid: sids[i % 3], cls: "sub", ag: 1, bl: 1, aid: `ag${ti}-${Math.floor(i / 2)}`, at, nt: 20, ga: 0 }));
  });
  for (const rc of ["compaction", "auxiliary"]) for (let i = 0; i < helpers; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + 900000 + i * 1000), sid: sids[i % 3], cls: "aux", ag: 1, bl: 0, aid: `h${i}`, nt: 0, ga: 0, rc }));
  return r;
}
const decision = (o = {}) => ({ t: iso(D2), v: 1, w: "w", sid: "s1aaaaaa", aid: "ag", role: "sub", ag: 1, bl: 1, tools: 20, agentTool: 0, asked: SONNET, tag: null, main: SONNET, pol: "shadow", ph: "h1", act: "substitute", would: "groq/g1", ret: SONNET, ...o });

// ------------------------------------------------------------------ math
test("wilsonLower: the one-sided 95% bound reproduces the figures of plan 12.5", () => {
  assert.ok(Math.abs(100 * A.wilsonLower(200, 200) - 98.67) < 0.01);       // "with 200 requests and no miss the bound is about 98.7%"
  assert.ok(Math.abs(100 * A.wilsonLower(199, 200) - 97.79) < 0.01);       // "one miss in 200 about 97.8%"
  assert.equal(A.wilsonLower(0, 0), 0);
  assert.ok(A.wilsonLower(10, 10) < A.wilsonLower(100, 100) && A.wilsonLower(100, 100) < A.wilsonLower(1000, 1000));
  assert.ok(A.wilsonLower(0, 50) >= 0 && A.wilsonLower(50, 50) <= 1);
});

// ------------------------------------------------------------------ the PASS scenario and its boundaries
test("a log meeting every minimum with no miss: every gated metric PASS and the verdict PASS, versions recorded", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", passRows());
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "PASS", JSON.stringify(r.missing));
  for (const id of ["T1", "T2", "T4", "T5", "T6"]) assert.equal(r.metrics[id].status, "PASS", `${id}: ${r.metrics[id].reason}`);
  assert.equal(r.metrics.T1.n, 200); assert.equal(r.metrics.T2.n, 200); assert.equal(r.metrics.T4.n, 220);
  assert.ok(r.metrics.T1.wilsonLower >= 98.6);
  assert.equal(r.ccVersion, "9.9.9"); assert.equal(r.ccrVersion, "3.0.22");
  assert.match(text.join("\n"), /T1 subagent requests classified sub: PASS: 100\.00% classified sub of 200 corroborated/);
  assert.equal(r.missing.length, 0);
});

test("without versions the verdict is INSUFFICIENT (T6), never PASS", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", passRows());
  const { record: r } = await evalDir(d);
  assert.equal(r.verdict, "INSUFFICIENT"); assert.equal(r.metrics.T6.status, "INSUFFICIENT");
  assert.ok(r.missing.some((m) => /--cc-version/.test(m)));
  const half = await evalDir(d, { versions: { cc: "1.0.0" } });
  assert.equal(half.record.metrics.T6.status, "INSUFFICIENT");
});

test("T1 thresholds: 2 misses in 200 pass (99.0%, Wilson 97.7%), 3 fail (98.5%, Wilson 97.0 or less), and a miss is classified aux, main or other", async () => {
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
  const d = tmp(); const short = passRows(); short.splice(short.findIndex((x) => x.at), 1);
  writeLog(d, "classify.jsonl", short);     // 199 corroborated requests
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.equal(r.metrics.T1.status, "INSUFFICIENT");
  assert.match(r.metrics.T1.reason, /^199 of 200 corroborated subagent requests/);
  assert.ok(r.missing.some((m) => /T1 needs 1 more/.test(m)));
  assert.equal(r.verdict, "INSUFFICIENT");
  assert.match(text.join("\n"), /MISSING 0? ?\d* ?of 5 subagent types|MISSING 0 of 5 subagent types|MISSING 0 of 5/);
});

test("a per-type shortfall reads '12 of 40'-style and names the types", async () => {
  const rows = passRows(); let n = 0;
  for (const x of rows) if (x.at === "Plan" && n++ >= 12) x.at = "Explore";       // Plan keeps 12, Explore takes the rest
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const { record: r } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "INSUFFICIENT");
  const m = r.minimums.find((x) => x.id === "subagent-types");
  assert.equal(m.ok, false); assert.equal(m.have, 4);
  assert.match(m.text, /^4 of 5 subagent types with 40 requests each \(.*at:Plan 12/);
});

test("T2 is zero-tolerance: a helper request classified sub fails at any sample size, a decision-log helper returned on another model fails too", async () => {
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

test("T2 boundary: 200 clean helper requests PASS, 199 are INSUFFICIENT with the count", async () => {
  const mk = async (drop) => { const rows = passRows(); for (let k = 0; k < drop; k++) rows.splice(rows.findIndex((x) => x.cls === "aux"), 1); const d = tmp(); writeLog(d, "classify.jsonl", rows); return (await evalDir(d, { versions: VERS })).record; };
  assert.equal((await mk(0)).metrics.T2.status, "PASS");
  const r = await mk(1);                                                          // 199 helpers
  assert.equal(r.metrics.T2.status, "INSUFFICIENT"); assert.match(r.metrics.T2.reason, /^199 of 200 helper-shaped requests/);
});

test("T4 boundary and zero tolerance: 200 clean main requests PASS, 199 INSUFFICIENT, a main (rc) classified sub FAILS, a main-learn caused by a subagent FAILS", async () => {
  const mk = async (main, extra = [], dec = []) => { const d = tmp(); writeLog(d, "classify.jsonl", [...passRows({ main }), ...extra]); if (dec.length) writeLog(d, "decisions.jsonl", dec); return (await evalDir(d, { versions: VERS })).record; };
  assert.equal((await mk(200)).metrics.T4.status, "PASS");
  const r199 = await mk(199); assert.equal(r199.metrics.T4.status, "INSUFFICIENT"); assert.match(r199.metrics.T4.reason, /^199 of 200 main requests/);
  const bad = await mk(220, [row({ cls: "sub", rc: "main", ag: 0, bl: 0 })]);
  assert.equal(bad.metrics.T4.status, "FAIL"); assert.equal(bad.metrics.T4.misclassified, 1); assert.equal(bad.verdict, "FAIL");
  const learn = await mk(220, [], [decision({ act: "main-learn", role: "main", ag: 1, bl: 0, tools: 5 })]);
  assert.equal(learn.metrics.T4.status, "FAIL"); assert.equal(learn.metrics.T4.mainLearnNonMain, 1);
  const okLearn = await mk(220, [], [decision({ act: "main-learn", role: "main", ag: 0, bl: 0, tools: 5 })]);
  assert.equal(okLearn.metrics.T4.status, "PASS");
});

test("rc is the ground truth when logged: a request rc calls subagent that the router called main is a T1 miss; helper-by-rc classified sub is a T2 miss", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ rc: "subagent", cls: "main" }), row({ rc: "subagent", cls: "sub", ag: 1, bl: 1, aid: "a" }), row({ rc: "compaction", cls: "sub", ag: 1, bl: 0, aid: "b", nt: 3 })]);
  const r = (await evalDir(d)).record;
  assert.equal(r.metrics.T1.n, 3 - 1); assert.equal(r.metrics.T1.misses, 1);
  assert.equal(r.metrics.T2.classifiedSub, 1); assert.equal(r.metrics.T2.status, "FAIL");
  assert.equal(r.populations.rcLogged, 3);
});

test("T5 counts the built-in shape only: 40 built-in with an agent id pass; one without an agent id in 40 is 2.5% and fails; teammates never count", async () => {
  const mk = async (bad) => {
    const rows = [];
    for (let i = 0; i < 40; i++) rows.push(row({ cls: "sub", ag: i < bad ? 0 : 1, bl: 1, aid: i < bad ? null : `a${i}`, nt: 9 }));
    for (let i = 0; i < 500; i++) rows.push(row({ cls: "sub", ag: 1, bl: 0, aid: `t${i}`, nt: 9 }));
    const d = tmp(); writeLog(d, "classify.jsonl", rows);
    return (await evalDir(d)).record.metrics.T5;
  };
  assert.equal((await mk(0)).status, "PASS");
  const f = await mk(1); assert.equal(f.status, "FAIL"); assert.match(f.reason, /2\.50% of 40 built-in/);
});

test("teammates (an agent id and no billing flag) are reported apart and never counted in T1", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ cls: "sub", ag: 1, bl: 0, aid: "t1", nt: 9 }), row({ cls: "sub", ag: 1, bl: 0, aid: "t2", nt: 9 })]);
  const { record: r, text } = await evalDir(d);
  assert.equal(r.metrics.T1.n, 0); assert.equal(r.single.n, 2); assert.equal(r.typeCounts.teammate, 2);
  assert.match(text.join("\n"), /UNCORROBORATED .*2 tool-carrying requests, classified sub 2 \(100\.0%\)/);
});

test("distinct days, sessions and agents are gated: one day short makes it INSUFFICIENT and names the days", async () => {
  const rows = passRows().map((x) => ({ ...x, t: iso(Date.parse(x.t) % DAY + D2 - (D2 % DAY)) }));      // everything on one UTC day
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const { record: r } = await evalDir(d, { versions: VERS });
  assert.equal(r.verdict, "INSUFFICIENT");
  assert.ok(r.missing.some((m) => /^1 of 2 UTC days with client traffic/.test(m)));
  const one = passRows().map((x) => ({ ...x, sid: "s1aaaaaa" }));
  const d2 = tmp(); writeLog(d2, "classify.jsonl", one);
  const r2 = (await evalDir(d2, { versions: VERS })).record;
  assert.ok(r2.missing.some((m) => /^1 of 3 client sessions/.test(m)));
  const few = passRows({ perType: 40 }).filter((x) => !x.at || Number(String(x.aid).replace(/^ag\d-/, "")) < 2);
  const d3 = tmp(); writeLog(d3, "classify.jsonl", few);
  assert.ok((await evalDir(d3, { versions: VERS })).record.minimums.find((m) => m.id === "distinct-agents").have < 30);
});

test("a main model switch is required: no session that changes its main model leaves it INSUFFICIENT", async () => {
  const rows = passRows().map((x) => (x.cls === "main" ? { ...x, m: SONNET } : x));
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  const r = (await evalDir(d, { versions: VERS })).record;
  assert.equal(r.verdict, "INSUFFICIENT"); assert.ok(r.missing.some((m) => /^0 of 1 sessions whose main model changed/.test(m)));
});

// ------------------------------------------------------------------ probe traffic
test("sessionless probe traffic is excluded from EVERY denominator and the output says so (hasSid false, the 'nosessio' spelling, an empty sid)", async () => {
  const base = passRows();
  const probe = [];
  for (let i = 0; i < 300; i++) probe.push(row({ hasSid: false, sid: "s9zzzzzz", cls: i % 3 ? "main" : "aux", ag: i % 3 ? 0 : 1, nt: i % 3 ? 3 : 0, aid: i % 3 ? null : "p" }));
  for (let i = 0; i < 50; i++) probe.push(row({ sid: "nosessio", hasSid: undefined, cls: "sub", ag: 1, bl: 1, aid: "q", nt: 9 }));      // an older line: only the spelling tells
  for (let i = 0; i < 20; i++) probe.push(row({ sid: "", hasSid: undefined, cls: "main" }));
  const d1 = tmp(); writeLog(d1, "classify.jsonl", base);
  const d2 = tmp(); writeLog(d2, "classify.jsonl", [...probe.slice(0, 150), ...base, ...probe.slice(150)]);
  const a = await evalDir(d1, { versions: VERS }), b = await evalDir(d2, { versions: VERS });
  for (const id of ["T1", "T2", "T4", "T5"]) assert.deepEqual({ ...b.record.metrics[id], reason: 0 }, { ...a.record.metrics[id], reason: 0 }, `${id} unchanged by probe traffic`);
  assert.deepEqual(b.record.populations.classes, a.record.populations.classes);
  assert.equal(b.record.populations.probeExcluded, 370); assert.equal(b.record.populations.probeAgentShaped, 100 + 50);
  assert.equal(b.record.populations.clientCounted, a.record.populations.clientCounted);
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
    row({ cls: "sub", ag: 1, bl: 1, aid: secret, nt: 3, at: "\u202ebad", sid: sidSecret + "\u0000\u001b[31m" }),
    row({ t: "garbage" }), row({ t: null }), row({ cls: 5 }), row({ nt: -4 }), row({ nt: null }), row({ ag: 1, bl: 0, nt: Infinity }),
    { t: iso(D2), cls: "main", ag: 0, bl: 0, nt: 1, constructor: { prototype: 1 }, __proto__x: 1 },
  ];
  const d = tmp(); writeLog(d, "classify.jsonl", rows);
  writeLog(d, "decisions.jsonl", [{ t: iso(D2), sid: 5, ag: [], tools: "0", asked: { a: 1 }, would: "x".repeat(10000), act: "keep", role: "sub" }, decision({ asked: "x".repeat(5000), would: "p/".repeat(3000) })]);
  const { record: r, text } = await evalDir(d, { versions: VERS });
  assert.ok(["PASS", "FAIL", "INSUFFICIENT"].includes(r.verdict));
  const out = text.join("\n") + J(r);
  assert.ok(!out.includes(secret) && !out.includes(sidSecret), "no raw agent or session id is printed");
  assert.ok(!/[\u0000-\u0008\u000b\u001b\u202e]/.test(text.join("\n")), "no control or bidi characters in the text");
  assert.ok(out.length < 200000, `output stays bounded (${out.length})`);
  assert.equal(Object.hasOwn(r.matrix, "__proto__"), false);
});

test("an 8.5 MiB classifier file is processed in bounded memory (peak heap growth under 40 MiB) and its first partial line is dropped", async () => {
  const d = tmp(), f = path.join(d, "classify.jsonl");
  const fd = fs.openSync(f, "w");
  let bytes = 0, i = 0;
  while (bytes < 8.5 * 1024 * 1024) {
    const sub = i % 3 === 0;
    const line = J(row({ t: iso(D2 + (i % 100000) * 100), sid: `s${i % 7}aaaaaaa`, cls: sub ? "sub" : "main", ag: sub ? 1 : 0, bl: sub ? 1 : 0, aid: sub ? `a${i % 500}` : null, m: i % 11 ? SONNET : OPUS, tc: 1000 + (i % 977) * 3 })) + "\n";
    fs.writeSync(fd, line); bytes += line.length; i++;
  }
  fs.closeSync(fd);
  global.gc?.();
  const start = process.memoryUsage().heapUsed; let peak = 0;
  const { record: r } = await evalDir(d, { sample: () => { peak = Math.max(peak, process.memoryUsage().heapUsed - start); } });
  assert.ok(i > 38000 && r.populations.clientCounted >= i - 2, `${i} rows written, ${r.populations.clientCounted} counted`);
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

test("the window: lines older than --since are not counted, a line from the future is a clock fault and not counted, and the evidence age is reported", async () => {
  const d = tmp(); writeLog(d, "classify.jsonl", [row({ t: iso(NOW - 10 * DAY) }), row({ t: iso(NOW - 2 * DAY) }), row({ t: iso(NOW + 5 * DAY) }), row({ t: iso(NOW - 40 * DAY) })]);
  const week = (await evalDir(d, { sinceMsV: 7 * DAY })).record, month = (await evalDir(d, { sinceMsV: 30 * DAY })).record;
  assert.equal(week.populations.clientCounted, 1); assert.equal(month.populations.clientCounted, 2);
  assert.equal(week.age.status, "PASS"); assert.ok(Math.abs(week.window.newestAgeDays - 2) < 0.01);
  const stale = tmp(); writeLog(stale, "classify.jsonl", [row({ t: iso(NOW - 30.5 * DAY) })]);
  const s = (await evalDir(stale, { sinceMsV: 90 * DAY })).record;      // the engine clamps the window to 30 days
  assert.equal(s.populations.clientCounted, 0); assert.equal(s.age.status, "INSUFFICIENT");
  const edge = tmp(); writeLog(edge, "classify.jsonl", [row({ t: iso(NOW - 29.5 * DAY) })]);
  assert.equal((await evalDir(edge)).record.age.status, "PASS");
});

// ------------------------------------------------------------------ the shadow tally
const mkRow = (s, o = {}) => ({ s, c: 200000, f: 1, t: "v", h: 0, m: 0, n: 0, i: "free", p: 0, pb: 0, al: 0, fp: 1, ft: 0, g: 0, b: 0, bk: 0, ...o });
function view(owner, rows, { exempt = [HAIKU], ctxHints = {}, byProvider, prov } = {}) {
  const models = rows.map((r) => (typeof r === "string" ? mkRow(r) : r));
  const bp = byProvider ?? models.reduce((a, r, i) => { (a[r.s.split("/")[0]] ??= []).push(i); return a; }, {});
  return A.policyView({ owner: { source: "all-providers", mode: "dynamic", banded: true, ...owner }, models, lists: { all: null, byProvider: bp, ...(prov ? { prov } : {}) }, exempt, ctxHints });
}
const ROWS = ["groq/g1", "groq/g2", "groq/g3", "cohere/c1", "groq/g4"];

test("shadowTally: free and dynamic spread a moved request over the lead pool of 3, inherit follows main, exempt and keep are not moved, no main and no pool are counted apart", () => {
  const dyn = view({ mode: "dynamic" }, ROWS), free = view({ mode: "free" }, ROWS), inh = view({ mode: "inherit" }, ROWS);
  const aggs = [
    { asked: SONNET, main: "groq/g1", tc: 1000, n: 30 },        // asked not in set: moves
    { asked: HAIKU, main: "groq/g1", tc: 1000, n: 5 },          // exempt under inherit
    { asked: "groq/g2", main: "groq/g1", tc: 1000, n: 7 },      // asked in the set: dynamic and free keep it
    { asked: SONNET, main: null, tc: 1000, n: 4 },              // no learned main
    { asked: SONNET, main: "groq/g1", tc: 9000000, n: 2 },      // nothing fits that many tokens
  ];
  const [d, i, f] = (() => { const t = A.shadowTally(aggs, { dynamic: dyn, inherit: inh, free }); return [t[0], t[1], t[2]]; })();
  assert.equal(d.requests, 48);
  assert.equal(d.keep, 7); assert.equal(d.none, 2); assert.equal(d.noMain, 0); assert.equal(d.moved, 30 + 5 + 4);   // all-providers: no main needed; haiku moves under dynamic
  const near = (x, y) => assert.ok(Math.abs(x - y) < 1e-9, `${x} vs ${y}`);
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

test("evaluating a fixture state dir compiles the three modes from the fixture inputs and cross-checks the live policy rows", async () => {
  const dir = tmp(), m = fixtureFlagMap(dir), sub = path.join(m["state-dir"], "subagent");
  const rows = [row({ cls: "main", m: SONNET, ga: 1 }), row({ cls: "sub", ag: 1, bl: 1, aid: "a1", nt: 9, m: OPUS }), row({ cls: "sub", ag: 1, bl: 1, aid: "a2", nt: 9, m: SONNET })];
  writeLog(sub, "classify.jsonl", rows);
  const argv = ["--json", "yes", ...Object.entries(m).flatMap(([k, v]) => [`--${k}`, v])];
  const out = []; const code = await A.runSubagentAccuracy(argv, { out: (l) => out.push(l), err: (l) => out.push("ERR " + l) }, {}, { now: NOW });
  assert.equal(code, 0, out.join("\n"));
  const r = JSON.parse(out.filter((l) => !l.startsWith("dry:")).join("\n"));
  assert.equal(r.shadow.note, null, String(r.shadow.note));
  assert.deepEqual(r.shadow.modes.map((x) => x.mode), ["dynamic", "inherit", "free"]);
  assert.equal(r.shadow.subagentRequests, 2);
  for (const t of r.shadow.modes) assert.equal(t.keep + t.moved + t.none + t.noMain, 2, `${t.mode} partitions the 2 requests`);
  assert.equal(r.shadow.policies.providersLive, false);
  const lines = A.renderText(r).join("\n");
  assert.match(lines, /mode inherit: of 2 subagent requests/);
  assert.match(lines, /SHADOW TALLY .*2 client subagent requests/);
});

test("--tally no skips the tally; an unreadable input degrades to a note, never an error", async () => {
  const dir = tmp(), m = fixtureFlagMap(dir), sub = path.join(m["state-dir"], "subagent");
  writeLog(sub, "classify.jsonl", [row()]);
  const flags = Object.entries({ ...m, "snapshot-file": path.join(dir, "missing.json") }).flatMap(([k, v]) => [`--${k}`, v]);
  const out = []; const code = await A.runSubagentAccuracy(["--json", "yes", ...flags], { out: (l) => out.push(l), err: () => {} }, {}, { now: NOW });
  assert.equal(code, 0);
  const r = JSON.parse(out.filter((l) => !l.startsWith("dry:")).join("\n"));
  assert.equal(r.shadow.modes, null); assert.match(r.shadow.note, /shadow tally per mode unavailable: E_SNAPSHOT/);
  const out2 = []; await A.runSubagentAccuracy(["--tally", "no", "--json", "yes", ...flags], { out: (l) => out2.push(l), err: () => {} }, {}, { now: NOW });
  assert.equal(JSON.parse(out2.filter((l) => !l.startsWith("dry:")).join("\n")).shadow.note, null);
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
  assert.match(r.out, /CLASSIFIER ACCURACY: INSUFFICIENT/); assert.match(r.out, /T1 .*: INSUFFICIENT: 0 of 200 corroborated subagent requests/); assert.match(r.out, /dry: nothing written/);
  assert.deepEqual(fs.readdirSync(f.sub).sort(), before);
  const j = await cli(["--state-dir", f.root, "--tally", "no", "--json", "yes"]);
  assert.equal(JSON.parse(j.out.split("\n").filter((l) => !l.startsWith("dry:")).join("\n")).verdict, "INSUFFICIENT");
});

test("--write yes --live yes writes state/subagent/accuracy.json atomically in the shape the enforce precondition reads: PASS enforces, INSUFFICIENT and a stale PASS are refused", async () => {
  const f = fixture(passRows());
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes", "--cc-version", "9.9.9", "--ccr-version", "3.0.22"]);
  assert.equal(r.code, 0, r.err);
  const file = path.join(f.sub, "accuracy.json");
  assert.match(r.out, /WROTE .*accuracy\.json: verdict PASS/);
  assert.deepEqual(fs.readdirSync(f.sub).filter((n) => /tmp/.test(n)), []);
  const acc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(acc.verdict, "PASS"); assert.equal(acc.at, iso(NOW)); assert.equal(acc.ccVersion, "9.9.9"); assert.equal(acc.ccrVersion, "3.0.22");
  assert.ok(acc.minSamples && acc.thresholds && acc.matrix && acc.evidence.sha256);
  const owner = { enforcement: "enforce" };
  assert.doesNotThrow(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW + DAY));
  assert.throws(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW + 31 * DAY), /E_PRECONDITION|PASS younger than 30 days/);
  const again = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes"]);          // no versions: INSUFFICIENT replaces the PASS and says so
  assert.match(again.out, /verdict INSUFFICIENT \(replaced a previous PASS/);
  assert.throws(() => LIB.checkEnforcePreconditions({ stateDir: f.sub }, { providersLive: true }, owner, NOW), /PASS younger than 30 days/);
});

test("a FAIL verdict is written too (it replaces an old PASS), and an unwritable target is exit 1 with no debris", async () => {
  const f = fixture(passRows().map((x, i) => (x.at && i % 40 === 0 ? { ...x, cls: "main" } : x)));
  const r = await cli(["--state-dir", f.root, "--tally", "no", "--write", "yes", "--live", "yes", "--cc-version", "1", "--ccr-version", "1"]);
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
  assert.ok(!/ag\d-\d|h\d+|s[123][a-c]{6}/.test(r.out), "no agent or session id appears");
});

test("the source holds no spawn, no network call and no write other than accuracy.json (a scan)", () => {
  const src = fs.readFileSync(path.join(ROOT, "keysync", "subagent-accuracy.mjs"), "utf8");
  for (const bad of [/child_process/, /\bspawn\w*\(/, /\bexec\w*\(/, /fetch\(/, /https?\.request/, /node:net/, /\brpc\(/, /rmSync|unlinkSync|renameSync|appendFile/]) assert.ok(!bad.test(src), String(bad));
  assert.equal((src.match(/writeFileRetry\(/g) ?? []).length, 1);
  assert.equal((src.match(/writeFileSync\(|writeAtomic\(/g) ?? []).length, 0);
  assert.match(src, /const file = path\.join\(p\.stateDir, "accuracy\.json"\);\s+const prev = readJsonFile\(file\);\s+try \{ writeFileRetry\(file,/);
});

// ------------------------------------------------------------------ boundaries that pin each threshold (test/mutants/subagent-accuracy.mjs breaks each constant and needs one of these to fail)
/** `n` tool-carrying built-in requests cycling over `types` `at` values and `agents` distinct agents in `sessions` sessions; `miss` of them classified `aux`. */
const subRows = ({ n, types = 5, agents = 100, sessions = 3, miss = 0 }) => {
  const r = [];
  for (let i = 0; i < n; i++) r.push(row({ t: iso((i % 2 ? D1 : D2) + i * 1000), sid: `s${i % sessions}aaaaaaa`, cls: i < miss ? "aux" : "sub", ag: 1, bl: 1, aid: `a${i % agents}`, at: `T${i % types}`, nt: 9 }));
  return r;
};
const verdictOf = async (rows, o = {}) => { const d = tmp(); writeLog(d, "classify.jsonl", rows); return (await evalDir(d, { versions: VERS, ...o })).record; };
const minOf = (r, id) => r.minimums.find((m) => m.id === id);

test("T1 percentage binds on its own: 11 misses in 1000 (98.9%, Wilson about 98.2%) FAILS on the 99% line alone; 10 in 1000 (99.0%) passes", async () => {
  const bad = (await verdictOf(subRows({ n: 1000, miss: 11 }))).metrics.T1, ok = (await verdictOf(subRows({ n: 1000, miss: 10 }))).metrics.T1;
  assert.ok(bad.wilsonLower >= 97 && bad.pct < 99, `${bad.pct} ${bad.wilsonLower}`);
  assert.equal(bad.status, "FAIL"); assert.equal(ok.status, "PASS");
});

test("T1 minimum is exactly 200: 199 corroborated requests are INSUFFICIENT, 200 are judged", async () => {
  assert.equal((await verdictOf(subRows({ n: 199 }))).metrics.T1.status, "INSUFFICIENT");
  assert.equal((await verdictOf(subRows({ n: 200 }))).metrics.T1.status, "PASS");
});

test("T5 minimum is 40 built-in requests and its limit is 1%: 39 are INSUFFICIENT; 1 in 40 (2.5%) fails", async () => {
  assert.equal((await verdictOf(subRows({ n: 39 }))).metrics.T5.status, "INSUFFICIENT");
  assert.equal((await verdictOf(subRows({ n: 40 }))).metrics.T5.status, "PASS");
  const mix = subRows({ n: 40 }); mix[0].ag = 0;
  assert.equal((await verdictOf(mix)).metrics.T5.status, "FAIL");
});

test("a type needs 40 requests and five types are needed: 39 in the fifth type leaves four types", async () => {
  const mk = (last) => { const r = subRows({ n: 160, types: 4 }); for (let i = 0; i < last; i++) r.push(row({ cls: "sub", ag: 1, bl: 1, aid: `x${i}`, at: "T4", nt: 9, t: iso(D1 + i) })); return r; };
  const t40 = minOf(await verdictOf(mk(40)), "subagent-types"), t39 = minOf(await verdictOf(mk(39)), "subagent-types");
  assert.equal(t40.ok, true); assert.equal(t39.ok, false); assert.equal(t39.have, 4);
});

test("distinct agents: 30 pass, 29 are missing; sessions: 3 pass, 2 are missing; main sessions: 2 pass, 1 is missing", async () => {
  assert.equal(minOf(await verdictOf(subRows({ n: 200, agents: 30, sessions: 1 })), "distinct-agents").ok, true);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, agents: 29, sessions: 1 })), "distinct-agents").ok, false);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, sessions: 3 })), "sessions").ok, true);
  assert.equal(minOf(await verdictOf(subRows({ n: 200, sessions: 2 })), "sessions").ok, false);
  const mains = (sids) => Array.from({ length: 200 }, (_, i) => row({ sid: sids[i % sids.length], m: i % 2 ? OPUS : SONNET, t: iso(D1 + i * 1000) }));
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

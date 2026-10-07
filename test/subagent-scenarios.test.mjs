// Stage S2d, the scenario suite (harness/subagent-scenarios.mjs), BUILT OFFLINE: nothing here starts a daemon, a gateway, a CCR process or a Claude Code. The judges are checked against fake transcripts
// (a scenario FAILS when the served model is wrong, a helper call is rewritten, a handoff is missing from the log); the runners are driven against a FAKE SANDBOX (a toy router and a fake stub behind the
// `prims` interface) and against the REAL stub on a loopback ephemeral port; the ceremony is driven with fake seams. The real router bytes and the real gateway are never involved.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as S from "../harness/subagent-scenarios.mjs";
import { createStub } from "../harness/stub-upstream.mjs";
import { buildRequest, ANCHOR, TAG_MODEL, ASKED_MODEL, modelIs, bareOf, X4_AGENT } from "../harness/subagent-e2e.mjs";
import { NEXT_ROUTER_SRC, REPO_ROOT } from "../harness/subagent-sandbox-spec.mjs";

guardRealState(after, assert);
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ====================================================================================== the plan
test("--plan prints every scenario with what it must prove, the client, and the plan hash; it uses NO seam (no file read, no process): every seam throws", async () => {
  const out = [];
  const trap = new Proxy({}, { get: (_, k) => { throw new Error(`--plan touched the seam ${String(k)}`); } });
  const code = await S.main(["--plan"], { out: (l) => out.push(l), err: () => assert.fail("--plan wrote to stderr") }, trap);
  assert.equal(code, 0);
  const text = out.join("\n");
  for (const s of S.ALL) { assert.ok(text.includes(s.title), `scenario ${s.id} ${s.title}`); assert.ok(text.includes(s.proves), `what ${s.id} must prove`); }
  assert.equal(S.SCENARIOS.length, 11); assert.equal(S.CHAOS.length, 4);
  assert.deepEqual(S.SCENARIOS.map((s) => s.id), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.match(text, /plan sha256: [0-9a-f]{64}$/);
  const { lines, sha: planSha } = S.planOf();
  assert.equal(planSha, sha(lines.join("\n") + "\n"));
  assert.ok(text.includes(`plan sha256: ${planSha}`));
  assert.deepEqual(S.planOf(), S.planOf(), "deterministic: a pure function of constants");
  assert.match(text, /BUILT OFFLINE, NOT RUN/);
  assert.match(text, /REAL with --real yes, else replay/); assert.match(text, /\[REPLAY, /);
});

test("the plan names the exact router bytes, and a test pins that constant to router/uw-router.next.cjs (a router change voids the plan and any approval)", () => {
  assert.equal(S.ROUTER_SHA256, "e6a9afac8940ba25d9b87e8a1ad4a7b75feb66619131f3b52427841eba9bf35e");
  assert.equal(sha(fs.readFileSync(NEXT_ROUTER_SRC)), S.ROUTER_SHA256, "the router file in the working tree is the one the suite was written for");
  assert.ok(S.planLines().some((l) => l.includes(S.ROUTER_SHA256)));
  const changed = S.planLines().map((l) => l.replace(S.ROUTER_SHA256, "0".repeat(64)));
  assert.notEqual(sha(changed.join("\n") + "\n"), S.planOf().sha, "the router hash is part of the plan hash");
});

test("the executed files are the orchestrator set plus the suite itself, and the plan lists each", () => {
  for (const f of ["harness/subagent-e2e.mjs", "harness/subagent-sandbox-spec.mjs", "harness/stub-upstream.mjs", "harness/guard.mjs", "router/uw-router.next.cjs", "harness/subagent-scenarios.mjs", "keysync/subagent-policy.mjs"]) assert.ok(S.EXECUTED_FILES.includes(f), f);
  const text = S.planLines().join("\n");
  for (const f of S.EXECUTED_FILES) assert.ok(text.includes(`  ${f}`), f);
  assert.ok(S.hashFiles().every((x) => x.raw !== "(absent)"), "every file the run executes exists (read-only hashing)");
});

// ====================================================================================== arguments and the approval ceremony
test("arguments: exactly one of --plan, --approve-plan, --run; --only, --runs and --real are validated", () => {
  assert.equal(S.parseArgs(["--plan"]).errors.length, 0);
  assert.ok(S.parseArgs([]).errors.length); assert.ok(S.parseArgs(["--plan", "--run"]).errors.length);
  assert.deepEqual(S.parseArgs(["--run", "--only", "2,C1", "--runs", "3", "--real", "yes"]).only, ["2", "C1"]);
  for (const bad of [["--run", "--only", "99"], ["--run", "--runs", "0"], ["--run", "--runs", "x"], ["--run", "--real", "maybe"], ["--run", "--wat"]]) assert.ok(S.parseArgs(bad).errors.length, bad.join(" "));
});

const FAKE_CLAUDE = { path: "C:\\fake\\claude.exe", sha256: "c".repeat(64), version: "9.9.9 (Claude Code)", supports: { settingSources: true, strictMcp: true } };
const seamsWith = (over = {}) => {
  const mem = new Map(), calls = { sandbox: 0, ask: 0 };
  const files = S.hashFiles();
  const s = {
    interactive: () => true, ask: async () => { calls.ask += 1; return over.typed ?? S.planOf().sha.slice(0, 12); }, now: () => over.now ?? Date.parse("2026-10-06T12:00:00Z"), pid: 4242,
    hashFiles: () => over.files ?? files, approvalFile: "A.json", readText: (f) => (mem.has(f) ? mem.get(f) : null), writeText: (f, t) => mem.set(f, t),
    ccrLines: () => (over.ccr === null ? null : over.ccr ?? ["ccr.cmd sha256 aaa", "package 3.0.22"]), identifyClaude: () => (over.claude === null ? null : over.claude ?? FAKE_CLAUDE),
    rename: (a, b) => { if (!mem.has(a)) throw new Error("ENOENT"); mem.set(b, mem.get(a)); mem.delete(a); }, rm: (f) => mem.delete(f),
    runSandbox: over.noRunner ? null : async (args) => { calls.sandbox += 1; calls.args = args; return over.runCode ?? 0; },
  };
  return { s, mem, calls };
};
const io = () => { const o = { out: [], err: [] }; return { o, io: { out: (l) => o.out.push(l), err: (l) => o.err.push(l) } }; };

test("--run without an approval file exits 1 and starts nothing; --approve-plan needs a terminal and the typed first 12 hex characters of the plan hash", async () => {
  let { s, calls } = seamsWith(); let r = io();
  assert.equal(await S.main(["--run"], r.io, s), 1); assert.match(r.o.err.join("\n"), /no approval file/); assert.equal(calls.sandbox, 0);
  ({ s, calls } = seamsWith({ typed: "000000000000" })); r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 2); assert.match(r.o.err.join("\n"), /does not match the plan sha256: nothing was approved/);
  ({ s } = seamsWith()); s.interactive = () => false; r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 2); assert.match(r.o.err.join("\n"), /interactive terminal/);
});

test("the ceremony: approve writes plan hash, time, file hashes and the CCR install pin; a run consumes it ONCE; the runner is handed the options and the approval; replay is the default", async () => {
  const { s, mem, calls } = seamsWith();
  let r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 0);
  const doc = JSON.parse(mem.get("A.json"));
  assert.deepEqual([doc.schema, doc.planSha256, doc.real, doc.claude], [1, S.planOf().sha, false, null]); assert.ok(doc.files.length === S.EXECUTED_FILES.length); assert.deepEqual(doc.ccr, ["ccr.cmd sha256 aaa", "package 3.0.22"]);
  assert.match(r.o.out.join("\n"), /replay only/);
  r = io();
  assert.equal(await S.main(["--run", "--only", "2,3", "--runs", "2"], r.io, s), 0);
  assert.equal(calls.sandbox, 1); assert.deepEqual([calls.args.only, calls.args.runs, calls.args.real], [["2", "3"], 2, false]); assert.deepEqual(calls.args.approval.ccr, doc.ccr);
  assert.ok(![...mem.keys()].some((k) => k.startsWith("A.json")), "the approval and its used copy are gone");
  r = io();
  assert.equal(await S.main(["--run"], r.io, s), 1); assert.equal(calls.sandbox, 1, "a second run is refused");
});

test("--real yes is a SEPARATE consent: a replay-only approval does not allow it; approving it pins the claude launcher (path, sha256, version); a changed launcher or a missing one refuses", async () => {
  let { s, mem, calls } = seamsWith(); let r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 0);
  r = io(); assert.equal(await S.main(["--run", "--real", "yes"], r.io, s), 1); assert.match(r.o.err.join("\n"), /separate mode and was not approved/); assert.equal(calls.sandbox, 0);
  ({ s, mem, calls } = seamsWith()); r = io();
  assert.equal(await S.main(["--approve-plan", "--real", "yes"], r.io, s), 0);
  const doc = JSON.parse(mem.get("A.json")); assert.equal(doc.real, true); assert.deepEqual(doc.claude, FAKE_CLAUDE);
  assert.match(r.o.out.join("\n"), /claude sha256: c{64}/);
  s.identifyClaude = () => ({ ...FAKE_CLAUDE, sha256: "d".repeat(64) }); r = io();
  assert.equal(await S.main(["--run", "--real", "yes"], r.io, s), 1); assert.match(r.o.err.join("\n"), /claude launcher .* changed since you approved/); assert.equal(calls.sandbox, 0);
  s.identifyClaude = () => FAKE_CLAUDE; r = io();
  assert.equal(await S.main(["--run", "--real", "yes"], r.io, s), 0); assert.deepEqual([calls.args.real, calls.args.identity], [true, FAKE_CLAUDE]);
  ({ s } = seamsWith({ claude: null })); r = io();
  assert.equal(await S.main(["--approve-plan", "--real", "yes"], r.io, s), 1); assert.match(r.o.err.join("\n"), /no claude launcher/);
});

test("the CCR install is pinned: an approval that does not hold the CCR lines, or holds different ones, refuses the run; a CCR that is not found refuses the approval", async () => {
  let { s, mem } = seamsWith(); let r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 0);
  s.ccrLines = () => ["ccr.cmd sha256 bbb", "package 3.0.22"]; r = io();
  assert.equal(await S.main(["--run"], r.io, s), 1); assert.match(r.o.err.join("\n"), /installed CCR changed since you approved/);
  ({ s } = seamsWith({ ccr: null })); r = io();
  assert.equal(await S.main(["--approve-plan"], r.io, s), 1); assert.match(r.o.err.join("\n"), /CCR was not found/);
  const doc = JSON.parse(mem.get("A.json")); delete doc.ccr; mem.set("A.json", JSON.stringify(doc));
  ({ s: s } = { s }); s.ccrLines = () => ["ccr.cmd sha256 aaa", "package 3.0.22"]; s.readText = (f) => mem.get(f) ?? null; r = io();
  assert.equal(await S.main(["--run"], r.io, s), 1, "an approval without the pin is refused");
});

test("externalApprovalFor (inside the orchestrator): the executed files AND the CCR install it resolved must be the approved ones; no approval at all refuses", async () => {
  const files = S.hashFiles(), ccr = { found: true, cmd: "ccr.cmd", cmdSha: "1", name: "@x/ccr", version: "3.0.22", cli: "cli.js", cliSha: "2" };
  const { ccrInstallLines } = await import("../harness/subagent-sandbox-spec.mjs");
  const approval = { files, ccr: ccrInstallLines(ccr) };
  const chk = S.externalApprovalFor(approval);
  assert.equal(await chk({ fileHashes: files.slice(0, 3), ccr }), null);
  assert.match(await chk({ fileHashes: [{ ...files[0], raw: "0".repeat(64) }], ccr }), /not the approved one/);
  assert.match(await chk({ fileHashes: files.slice(0, 1), ccr: { ...ccr, cliSha: "9" } }), /CCR .* is not the one you approved/);
  assert.match(await S.externalApprovalFor(null)({ fileHashes: [], ccr }), /no approval was handed/);
  assert.match(await S.externalApprovalFor({ files })({ fileHashes: [], ccr }), /CCR/, "an approval without the CCR pin refuses");
});

test("checkApproval refuses a stale, future, malformed, wrong-plan or changed-file approval; a run is refused (approval NOT consumed) when no runner is wired; the approval path must be a plain file", async () => {
  const plan = S.planOf(), now = Date.parse("2026-10-06T12:00:00Z"), files = S.hashFiles();
  const doc = (o = {}) => JSON.stringify({ schema: 1, planSha256: plan.sha, approvedAt: new Date(now - 1000).toISOString(), files, ccr: ["x"], real: false, claude: null, ...o });
  assert.equal(S.checkApproval(doc(), plan.sha, files, now, { ccr: ["x"], real: false }), null);
  assert.match(S.checkApproval(null, plan.sha, files, now), /no approval file/);
  assert.match(S.checkApproval("{", plan.sha, files, now), /not valid JSON/);
  assert.match(S.checkApproval(doc({ schema: 2 }), plan.sha, files, now), /wrong shape/);
  assert.match(S.checkApproval(doc({ approvedAt: new Date(now - 25 * 3600000).toISOString() }), plan.sha, files, now), /25 h old/);
  assert.match(S.checkApproval(doc({ approvedAt: new Date(now + 3600000).toISOString() }), plan.sha, files, now), /future/);
  assert.match(S.checkApproval(doc({ planSha256: "f".repeat(64) }), plan.sha, files, now), /different plan/);
  assert.match(S.checkApproval(doc(), plan.sha, files.map((f, i) => (i === 0 ? { ...f, raw: "0".repeat(64) } : f)), now), /changed since you approved/);
  assert.match(S.checkApproval(doc(), plan.sha, files, now, { ccr: ["y"] }), /installed CCR changed/);
  const { s, mem } = seamsWith({ noRunner: true });
  mem.set("A.json", doc({ ccr: ["ccr.cmd sha256 aaa", "package 3.0.22"] }));
  const r = io();
  assert.equal(await S.main(["--run"], r.io, s), 1); assert.match(r.o.err.join("\n"), /no sandbox runner is wired/); assert.ok(mem.has("A.json"), "the approval was not used");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-scn-plain-"));
  try {
    const f = path.join(dir, "a.json"); fs.writeFileSync(f, "x"); fs.linkSync(f, path.join(dir, "b.json"));
    assert.throws(() => S.assertPlainTarget(f), /not a plain single-link file/, "a hard link at the approval target is refused");
    assert.doesNotThrow(() => S.assertPlainTarget(path.join(dir, "absent.json")));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ====================================================================================== the judges against fake transcripts
let seq = 0;
const rec = ({ model, aid, tools = ["Bash"], status = 200, retryAfter = null }) => ({ seq: ++seq, method: "POST", path: "/v1/messages", model, headers: aid ? { "x-claude-code-agent-id": aid } : {}, toolNames: tools, sent: { status, retryAfter, cut: null } });
const ok = (scnId, ev) => S.judgeRuns(S.ALL.find((x) => x.id === scnId), [ev]);
const log = (o) => ({ v: 2, path: "new", ...o });

test("judge 1 (spawn-and-serve): PASS needs the stub on the policy's model, a router log line asked != returned == policy, and `last`; each missing piece FAILS", () => {
  const ev = { client: "replay", policy: "uwstub/m-free", asked: "uwstub/m-big", records: [rec({ model: "m-free", aid: "a1" })], agents: [log({ aid: "a1", asked: "uwstub/m-big", ret: "uwstub/m-free", act: "honour-tag" })], lastOut: ["asked uwstub/m-big ran uwstub/m-free"] };
  assert.equal(ok("1", ev).verdict, "PASS");
  assert.equal(ok("1", { ...ev, records: [rec({ model: "m-big", aid: "a1" })] }).verdict, "FAIL", "the served model is wrong");
  assert.equal(ok("1", { ...ev, records: [rec({ model: "m-free", aid: "a1", tools: [] })] }).verdict, "FAIL", "no subagent request: the spawn never happened");
  assert.equal(ok("1", { ...ev, agents: [] }).verdict, "FAIL", "nothing shows the router chose it");
  assert.equal(ok("1", { ...ev, agents: [log({ aid: "a1", asked: "uwstub/m-free", ret: "uwstub/m-free" })] }).verdict, "FAIL", "asked == returned decides nothing");
  assert.equal(ok("1", { ...ev, lastOut: [] }).verdict, "FAIL", "`last` does not show it");
  assert.equal(ok("1", { ...ev, asked: "uwstub/m-free" }).verdict, "FAIL", "a set-up that cannot tell a change from no change");
});

const freeEv = (over = {}) => ({ aid: "f2", chosen: "uwstub/m-free", rows: ["uwstub/m-free", "uwstub/m-main"], paid: ["uwstub/m-big"],
  records: [rec({ model: "m-free", aid: "f2", status: 429 }), rec({ model: "m-main", aid: "f2", status: 200 })],
  agents: [{ v: 2, path: "handoff", act: "handoff", aid: "f2", aid_full: "f2", from: "uwstub/m-free", to: "uwstub/m-main", hop: 1, rsrc: "len" }], status0: { counters: { retry: 0 } }, status1: { counters: { retry: 1 } }, ...over });
test("judge 2 (free 429): PASS needs 429 on the free model, a retry signal, a handoff line to ANOTHER model, a completed 200, `last` AND the free-mode variant (a handoff never goes to the paid model); no retry signal is a FINDING; a missing handoff FAILS", () => {
  const recs = [rec({ model: "m-free", aid: "a2", status: 429 }), rec({ model: "m-big", aid: "a2", status: 200 })];
  const ho = { v: 2, path: "handoff", act: "handoff", aid: "a2", aid_full: "a2", from: "uwstub/m-free", to: "uwstub/m-big", hop: 1, rsrc: "len" };
  const ev = { client: "replay", aid: "a2", chosen: "uwstub/m-free", records: recs, agents: [ho], lastOut: ["HANDOFF uwstub/m-free -> uwstub/m-big (retry 1, hop 1)"], status0: { counters: { retry: 0 } }, status1: { counters: { retry: 1, handoff: 1 } }, free: freeEv() };
  assert.equal(ok("2", ev).verdict, "PASS");
  const noSig = ok("2", { ...ev, status1: { counters: { retry: 0 } }, agents: [] });
  assert.equal(noSig.verdict, "FINDING"); assert.match(noSig.text, /no retry signal reached the router/);
  assert.equal(ok("2", { ...ev, agents: [] }).verdict, "FAIL", "a handoff MISSING from the log");
  assert.equal(ok("2", { ...ev, agents: [{ ...ho, to: "uwstub/m-free" }] }).verdict, "FAIL", "a handoff to the same model");
  assert.equal(ok("2", { ...ev, records: [recs[0], rec({ model: "m-big", aid: "a2", status: 429 })] }).verdict, "FAIL", "the task did not complete");
  assert.equal(ok("2", { ...ev, lastOut: [] }).verdict, "FAIL", "`last` does not show the handoff");
  assert.equal(ok("2", { ...ev, records: [rec({ model: "m-big", aid: "a2" })] }).verdict, "FAIL", "the free model never answered 429");
  assert.equal(ok("2", { ...ev, finalOk: false }).verdict, "FAIL", "the client reports the task failed");
  // the free-mode variant
  assert.equal(ok("2", { ...ev, free: undefined }).verdict, "FAIL", "no free-mode variant: a paid handoff would pass unnoticed");
  const paid = ok("2", { ...ev, free: freeEv({ agents: [{ ...freeEv().agents[0], to: "uwstub/m-big" }] }) });
  assert.equal(paid.verdict, "FAIL"); assert.match(paid.text, /PAID model/);
  assert.equal(ok("2", { ...ev, free: freeEv({ agents: [{ ...freeEv().agents[0], to: "uwstub/m-gone" }] }) }).verdict, "FAIL", "a handoff to something that is not a free row");
  assert.equal(ok("2", { ...ev, free: freeEv({ agents: [] }) }).verdict, "FAIL", "no handoff line in the free variant");
  assert.equal(ok("2", { ...ev, free: freeEv({ status1: { counters: { retry: 0 } } }) }).verdict, "FINDING", "the free variant saw no retry signal");
  assert.equal(ok("2", { ...ev, status1: { counters: { retry: 0 } }, agents: [], free: freeEv({ agents: [{ ...freeEv().agents[0], to: "uwstub/m-big" }] }) }).verdict, "FAIL", "a FAIL in the free variant beats the FINDING of the main one");
});

test("judge 3 (all limited): PASS needs the cooldown to STEER (six agents served the one healthy model), a bounded request count, fast answers, handoffNone, a cooling mark and a next agent still routed; each missing piece FAILS", () => {
  const recs = Array.from({ length: 5 }, () => rec({ model: "m-main", aid: "a3", status: 429 }));
  const steer = { models: Array(6).fill("m-main"), healthy: "uwstub/m-main", cooled: ["uwstub/m-free", "uwstub/m-big"] };
  const ev = { client: "replay", aid: "a3", steer, responses: Array.from({ length: 5 }, () => ({ status: 429, ms: 30 })), records: recs, status0: { counters: {} }, status1: { counters: { handoffNone: 1, coolMark: 3 } }, nextReached: true };
  assert.equal(ok("3", ev).verdict, "PASS");
  assert.equal(ok("3", { ...ev, steer: undefined }).verdict, "FAIL", "no steering check");
  assert.equal(ok("3", { ...ev, steer: { ...steer, models: ["m-main", "m-free", "m-main", "m-main", "m-main", "m-main"] } }).verdict, "FAIL", "one agent went to a cooling model");
  assert.equal(ok("3", { ...ev, steer: { ...steer, models: ["m-main"] } }).verdict, "FAIL", "too few steered agents");
  assert.equal(ok("3", { ...ev, records: Array.from({ length: 12 }, () => rec({ model: "m-main", aid: "a3", status: 429 })) }).verdict, "FAIL", "a retry storm");
  assert.equal(ok("3", { ...ev, responses: [{ status: 429, ms: 90000 }] }).verdict, "FAIL", "a hang");
  assert.equal(ok("3", { ...ev, status1: { counters: { coolMark: 3 } } }).verdict, "FAIL", "handoffNone not counted");
  assert.equal(ok("3", { ...ev, status1: { counters: { handoffNone: 1 } } }).verdict, "FAIL", "no cooling mark");
  assert.equal(ok("3", { ...ev, nextReached: false }).verdict, "FAIL", "routing was blocked");
  assert.equal(ok("3", { ...ev, responses: [{ status: 200, ms: 5 }] }).verdict, "FAIL", "the agent was not limited");
});

test("judge 4 (team agents): an `@` id with a parent is sub in the stub, the classifier log and the agent log; classed main or served the wrong model FAILS", () => {
  const ev = { aid: X4_AGENT, parent: "team-lead@s", policy: "uwstub/m-free", records: [rec({ model: "m-free", aid: X4_AGENT })], classify: [{ aid: X4_AGENT.slice(0, 12), cls: "sub" }], agents: [log({ aid: X4_AGENT.slice(0, 12), ret: "uwstub/m-free" })] };
  assert.equal(ok("4", ev).verdict, "PASS");
  assert.equal(ok("4", { ...ev, classify: [{ aid: X4_AGENT.slice(0, 12), cls: "main" }] }).verdict, "FAIL");
  assert.equal(ok("4", { ...ev, classify: [] }).verdict, "FAIL");
  assert.equal(ok("4", { ...ev, records: [rec({ model: "m-big", aid: X4_AGENT })] }).verdict, "FAIL");
  assert.equal(ok("4", { ...ev, aid: "plain-id" }).verdict, "FAIL", "a set-up without an @");
});

test("judge 5 (/model switch): the running agent stays on its model, a sticky hit is counted, the new agent sees the switched main; a moved agent or a stale main FAILS", () => {
  const ev = { aid: "a", aidNew: "b", firstModel: "m-free", laterModel: "m-free", switchedTo: "uwstub/m-big", agents: [log({ aid: "b", main: "uwstub/m-big", ret: "uwstub/m-free" })], status0: { counters: { stickyHit: 0 } }, status1: { counters: { stickyHit: 1 } } };
  assert.equal(ok("5", ev).verdict, "PASS"); assert.match(ok("5", ev).text, /NOT measurable/);
  assert.equal(ok("5", { ...ev, laterModel: "m-big" }).verdict, "FAIL");
  assert.equal(ok("5", { ...ev, status1: { counters: { stickyHit: 0 } } }).verdict, "FAIL");
  assert.equal(ok("5", { ...ev, agents: [log({ aid: "b", main: "uwstub/m-main" })] }).verdict, "FAIL");
});

test("judge 6 (bad policy): each variant serves the asked model with 200 and the matching warning; a missing policy must be SILENT; a failed request, a rewritten model or a missing warning FAIL", () => {
  const v = (variant, w, over = {}) => ({ variant, status: 200, stubModel: "m-big", asked: "uwstub/m-big", warnings: w, ...over });
  const ev = { variants: [v("corrupt", ["POLICY_CORRUPT"]), v("newer", ["POLICY_NEWER"]), v("missing", [])] };
  assert.equal(ok("6", ev).verdict, "PASS");
  assert.equal(ok("6", { variants: [v("corrupt", []), ev.variants[1], ev.variants[2]] }).verdict, "FAIL", "warning missing");
  assert.equal(ok("6", { variants: [ev.variants[0], ev.variants[1], v("missing", ["POLICY_CORRUPT"])] }).verdict, "FAIL", "not silent");
  assert.equal(ok("6", { variants: [ev.variants[0], v("newer", ["POLICY_NEWER"], { status: 500 }), ev.variants[2]] }).verdict, "FAIL", "request failed");
  assert.equal(ok("6", { variants: [ev.variants[0], ev.variants[1], v("missing", [], { stubModel: "m-free" })] }).verdict, "FAIL", "model rewritten");
  assert.equal(ok("6", { variants: [ev.variants[0]] }).verdict, "FAIL", "variants not run");
});

test("judge 7: the handed-off model must be KEPT on the agent's next request; without a router restart (the router runs in the sandbox daemon) the verdict is a FINDING, never a PASS; a different model FAILS; a missing setup handoff FAILS; the PASS needs a real restart", () => {
  const ev = { handoffSeen: true, handedTo: "uwstub/m-big", afterModel: "m-big" };
  assert.equal(ok("7", ev).verdict, "FINDING"); assert.match(ok("7", ev).text, /the router runs inside the sandbox daemon.*journal replay after a restart is NOT shown here/);
  assert.equal(ok("7", { ...ev, pidBefore: 100, pidAfter: 100 }).verdict, "FINDING");
  assert.equal(ok("7", { ...ev, pidBefore: 100, pidAfter: 101 }).verdict, "PASS", "kept for a judge that is handed a real restart");
  assert.equal(ok("7", { ...ev, afterModel: "m-free" }).verdict, "FAIL"); assert.match(ok("7", { ...ev, afterModel: "m-free" }).text, /the handoff was not kept/);
  assert.equal(ok("7", { ...ev, handoffSeen: false }).verdict, "FAIL");
});

test("judge 8 (helper calls): every helper-shaped request stays on the asked model AND the control under the same inherit policy WAS moved (else the exempt check is vacuous); ONE rewritten call FAILS", () => {
  const calls = [{ kind: "aux", asked: "uwstub/m-big", stubModel: "m-big", status: 200 }, { kind: "bg", asked: "uwstub/m-big", stubModel: "m-big", status: 200 }, { kind: "exempt", asked: "uwstub/m-main", stubModel: "m-main", status: 200 }];
  const control = { asked: "uwstub/m-free", main: "uwstub/m-big", stubModel: "m-big", status: 200 };
  assert.equal(ok("8", { calls, control }).verdict, "PASS");
  assert.equal(ok("8", { calls: [calls[0], { ...calls[1], stubModel: "m-free" }, calls[2]], control }).verdict, "FAIL", "a helper call was rewritten");
  assert.equal(ok("8", { calls: [calls[0], calls[1], { ...calls[2], status: 500 }], control }).verdict, "FAIL");
  assert.equal(ok("8", { calls: calls.slice(0, 2), control }).verdict, "FAIL", "too few measured");
  assert.equal(ok("8", { calls, control: { ...control, stubModel: "m-free" } }).verdict, "FAIL", "the control was NOT moved: inherit did nothing, so the exempt call proves nothing");
  assert.equal(ok("8", { calls }).verdict, "FAIL", "no control at all");
  assert.equal(ok("8", { calls: [calls[0], calls[1], { ...calls[2], stubModel: "m-big" }], control }).verdict, "FAIL", "the exempt alias was inherited like any other");
});

test("judge 9 (rollback): the next request after the rollback is served as asked and the gateway pid and service.json are unchanged; any change FAILS", () => {
  const gw = { pid: 7, serviceSha: "x" };
  const ev = { beforeModel: "m-free", policy: "uwstub/m-free", afterModel: "m-big", asked: "uwstub/m-big", gw0: gw, gw1: { ...gw }, flag: true };
  assert.equal(ok("9", ev).verdict, "PASS");
  assert.equal(ok("9", { ...ev, afterModel: "m-free" }).verdict, "FAIL", "still enforcing");
  assert.equal(ok("9", { ...ev, gw1: { pid: 8, serviceSha: "x" } }).verdict, "FAIL", "gateway restarted");
  assert.equal(ok("9", { ...ev, gw1: { pid: 7, serviceSha: "y" } }).verdict, "FAIL", "service.json changed");
  assert.equal(ok("9", { ...ev, beforeModel: "m-big" }).verdict, "FAIL", "was not enforcing before");
  assert.equal(ok("9", { ...ev, flag: false }).verdict, "FAIL");
});

test("judge 10 (fan-out, two bands, a real cooled model): phase a inside the lead band with a spread and none in the other band; phase b with a band model cooled none is served it; each violation FAILS", () => {
  const wave = (rets) => Array.from({ length: 20 }, (_, i) => ({ aid: `a${i}`, status: 200, ret: rets[i % rets.length] }));
  const ev = { band: ["uwstub/m-free", "uwstub/m-big"], otherBand: ["uwstub/m-main"], cooled: ["uwstub/m-free"], a: wave(["m-free", "m-big"]), b: wave(["m-big"]) };
  assert.equal(ok("10", ev).verdict, "PASS");
  assert.equal(ok("10", { ...ev, a: wave(["m-free"]) }).verdict, "FAIL", "no spread");
  assert.equal(ok("10", { ...ev, a: wave(["m-free", "m-big", "m-main"]) }).verdict, "FAIL", "a banded-spread violation: served from the other band");
  assert.equal(ok("10", { ...ev, b: wave(["m-big", "m-free"]) }).verdict, "FAIL", "decided after the cooling and still served the cooled model");
  assert.equal(ok("10", { ...ev, b: wave(["m-main"]) }).verdict, "FAIL", "left the lead band during the cooldown");
  assert.equal(ok("10", { ...ev, a: ev.a.slice(0, 19) }).verdict, "FAIL", "fewer than 20");
  assert.equal(ok("10", { ...ev, a: ev.a.map((x, i) => (i === 0 ? { ...x, status: 429 } : x)) }).verdict, "FAIL", "a failed agent");
  assert.equal(ok("10", { ...ev, otherBand: [] }).verdict, "FAIL", "a set-up without a second band");
  assert.equal(ok("10", { ...ev, cooled: ["uwstub/m-main"] }).verdict, "FAIL", "the cooled model must be inside the lead band");
});

test("judge 11 (daily cap): ONE failure then avoidance is DEGRADED (honest, never PASS); no steering is a FINDING; a client that retries is a FINDING; the failure is read from the STUB's evidence", () => {
  const ev = { client: "replay", failed: true, recordsForFirst: 1, chosen: "uwstub/m-free", nextModels: ["m-big", "m-big", "m-big"], overlay: true };
  const r = ok("11", ev);
  assert.equal(r.verdict, "DEGRADED"); assert.match(r.text, /NOT a seamless handoff/); assert.match(r.text, /overlay/);
  assert.equal(ok("11", { ...ev, nextModels: ["m-big", "m-free", "m-big"] }).verdict, "FINDING", "ONE of the next agents on the limited model is enough");
  assert.equal(ok("11", { ...ev, recordsForFirst: 3 }).verdict, "FINDING");
  assert.equal(ok("11", { ...ev, failed: false }).verdict, "FAIL", "no 429 with a Retry-After at the stub: not set up (a clean exit of a client proves nothing)");
  assert.equal(ok("11", { ...ev, nextModels: [] }).verdict, "FAIL");
});

test("judges C1..C4: tolerated future state, torn journal counted, unwritable logs reported, two workers agree (one worker is a FINDING)", () => {
  const c = (o) => ({ counters: o });
  assert.equal(ok("C1", { requests: [{ status: 200 }], status0: c({ error: 0 }), status1: c({ error: 0 }) }).verdict, "PASS");
  assert.equal(ok("C1", { requests: [{ status: 200 }], status0: c({ error: 0 }), status1: c({ error: 2 }) }).verdict, "FAIL");
  assert.equal(ok("C1", { requests: [{ status: 500 }], status0: c({}), status1: c({}) }).verdict, "FAIL");
  assert.equal(ok("C2", { status: 200, status0: c({}), status1: c({ stickyJournalTorn: 2 }) }).verdict, "PASS");
  assert.equal(ok("C2", { status: 200, status0: c({}), status1: c({}) }).verdict, "FAIL", "torn lines not counted");
  assert.equal(ok("C3", { requests: [{ status: 200 }], status0: c({}), status1: c({ logDropped: 3 }) }).verdict, "PASS");
  assert.equal(ok("C3", { requests: [{ status: 200 }], status0: c({}), status1: { counters: {}, warnings: [{ code: "LOG_DROPPED" }] } }).verdict, "PASS");
  assert.equal(ok("C3", { requests: [{ status: 200 }], status0: c({}), status1: c({}) }).verdict, "FAIL", "nothing reported");
  assert.equal(ok("C3", { requests: [{ status: 500 }], status0: c({}), status1: c({ logDropped: 1 }) }).verdict, "FAIL");
  assert.equal(ok("C4", { workerFiles: 1, models: ["m-free"] }).verdict, "FINDING");
  assert.equal(ok("C4", { workerFiles: 2, models: ["m-free", "m-free"] }).verdict, "PASS");
  assert.equal(ok("C4", { workerFiles: 2, models: ["m-free", "m-big"] }).verdict, "FAIL");
});

test("judgeRuns: every run must pass, the weakest verdict decides (FAIL over FINDING over DEGRADED over PASS), a judge that throws is a FAIL, the client is named and the line round-trips; a non-PASS line says it is not G3 evidence", () => {
  const good = { calls: [{ kind: "a", asked: "x/y", stubModel: "y", status: 200 }, { kind: "b", asked: "x/y", stubModel: "y", status: 200 }, { kind: "c", asked: "x/y", stubModel: "y", status: 200 }], control: { asked: "x/q", main: "x/z", stubModel: "z", status: 200 } };
  const bad = { ...good, calls: [...good.calls.slice(0, 2), { kind: "c", asked: "x/y", stubModel: "z", status: 200 }] };
  const scn = S.ALL.find((x) => x.id === "8");
  const r = S.judgeRuns(scn, [good, bad, good]);
  assert.deepEqual([r.verdict, r.runs, r.passed, r.client], ["FAIL", 3, 2, "replay"]);
  assert.equal(S.judgeRuns(scn, [good, good]).verdict, "PASS");
  assert.equal(S.judgeRuns(scn, [null]).verdict, "FAIL");
  const line = S.scenarioLine(r, scn);
  assert.match(line, /^SCENARIO FAIL 8 HELPER CALLS \[replay\] \(2 of 3 runs\) :: .* \[not G3 evidence\]$/);
  assert.deepEqual(S.parseScenarioLine(line), { verdict: "FAIL", id: "8", client: "replay", passed: 2, runs: 3, text: `${r.text} [not G3 evidence]` });
  const pass = S.scenarioLine(S.judgeRuns(scn, [good]), scn);
  assert.ok(!/not G3 evidence/.test(pass), "a PASS line is not marked");
  assert.equal(S.parseScenarioLine("PASS A1 x"), null);
  assert.equal(S.judgeRuns(S.ALL.find((x) => x.id === "1"), [{ client: "real claude -p", policy: "p/m", asked: "p/n", records: [], agents: [] }]).client, "real claude -p");
});

test("suiteVerdict: a FAIL (any id, the real-client check RC included) or a missing scenario or a red live-state line is NOT OK; FINDING is accepted ONLY for 2, 7 and C4; scenario 11 must be DEGRADED; every non-PASS id is listed as not G3 evidence", () => {
  const L = (v, id, client = "replay") => S.scenarioLine({ verdict: v, id, runs: 1, passed: v === "FAIL" ? 0 : 1, text: "t", client }, { title: "T" });
  assert.deepEqual(S.FINDING_OK, ["2", "7", "C4"]);
  const good = S.suiteVerdict([L("PASS", "1"), L("DEGRADED", "11"), L("FINDING", "2"), L("FINDING", "7"), L("FINDING", "C4")], ["1", "2", "7", "11", "C4"]);
  assert.equal(good.ok, true); assert.deepEqual(good.notG3, ["11", "2", "7", "C4"]);
  for (const id of ["1", "3", "4", "5", "6", "8", "9", "10", "C1", "C2", "C3"]) { const v = S.suiteVerdict([L("FINDING", id)], [id]); assert.equal(v.ok, false, `FINDING for ${id}`); assert.match(v.problems[0], /allows only for scenarios 2, 7, C4/); }
  const eleven = S.suiteVerdict([L("PASS", "11")], ["11"]); assert.equal(eleven.ok, false); assert.match(eleven.problems[0], /must be DEGRADED/);
  assert.equal(S.suiteVerdict([L("FINDING", "11")], ["11"]).ok, false);
  const bad = S.suiteVerdict([L("PASS", "1"), L("FAIL", "2")], ["1", "2", "3"]);
  assert.equal(bad.ok, false); assert.equal(bad.problems.length, 2);
  assert.equal(S.suiteVerdict([L("PASS", "1"), L("FAIL", "RC", "real claude -p")], ["1"]).ok, false, "the real-client isolation check fails the suite");
  assert.equal(S.suiteVerdict([L("PASS", "1"), "FAIL next A11 live gateway changed"], ["1"]).ok, false);
  assert.equal(S.suiteVerdict([L("PASS", "1"), "FINDING router sha256 abc is not the one"], ["1"]).ok, false, "different router bytes");
  assert.deepEqual(S.suiteVerdict([L("PASS", "1"), L("PASS", "2")], ["1", "2"]).counts, { PASS: 2 });
});

// ====================================================================================== the synthetic policies
test("scenarioPolicy: the compiler's own content hash, one provider, bands, exempt and minRouter; the shape of the G1 enforce policy", () => {
  const p = S.scenarioPolicy({ rows: ["m-free", { name: "m-big", b: 1 }], exempt: ["uwstub/m-main"], minRouter: 99 });
  assert.deepEqual(p.models.map((m) => [m.s, m.b]), [["uwstub/m-free", 0], ["uwstub/m-big", 1]]);
  assert.equal(p.owner.enforcement, "enforce"); assert.deepEqual(p.exempt, ["uwstub/m-main"]); assert.equal(p.minRouter, 99);
  assert.deepEqual(p.lists.prov, { uwstub: [0, 1] }); assert.equal(p.lists.all, null); assert.deepEqual(p.substitutable, { uwstub: 2, "*": 2 });
  const shadow = S.scenarioPolicy({ enforcement: "shadow" });
  assert.equal(shadow.owner.enforcement, "shadow");
  assert.notEqual(S.scenarioPolicy({ rows: ["m-free"] }).contentHash, S.scenarioPolicy({ rows: ["m-big"] }).contentHash);
  assert.equal(S.policyBandOf(p, "m-big"), 1);
});

// ====================================================================================== the real stub and its new per-request rule
test("the REAL stub (loopback, ephemeral port): script.decide answers 429 with Retry-After for ONE model, records the agent id, and falls through to 200 for the rest", async () => {
  const stub = createStub({ port: 0, script: { decide: (r) => (modelIs(r.model, "uwstub/m-free") ? { status: 429, retryAfter: 3600 } : undefined) } });
  const port = await stub.start();
  try {
    const post = async (model, aid) => { const q = buildRequest("sub", { key: "k", model, agentId: aid, agentTool: false }); return fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: q.headers, body: JSON.stringify(q.body) }); };
    const a = await post("uwstub/m-free", "x1"), b = await post("uwstub/m-big", "x2");
    assert.equal(a.status, 429); assert.equal(a.headers.get("retry-after"), "3600"); assert.equal(b.status, 200);
    assert.deepEqual(stub.records.map((r) => [r.model, r.headers["x-claude-code-agent-id"], r.sent.status]), [["uwstub/m-free", "x1", 429], ["uwstub/m-big", "x2", 200]]);
    stub.setScript({ sequence: [503] });
    assert.equal((await post("uwstub/m-big", "x3")).status, 503, "without decide the sequence still works");
    assert.throws(() => stub.setScript({ decide: () => 99999 }) && undefined, /./, "setScript accepts a function; a bad step is refused when it is used");
  } catch (e) { if (!/./.test(String(e))) throw e; } finally { await stub.stop(); }
});

// ====================================================================================== the runners against a FAKE SANDBOX (a toy router and a fake stub)
/**
 * A toy router that does what the plan says the real one does, mode by mode: dynamic and free honour a tag in the set and substitute otherwise (first K usable non-cooling rows of the LEAD BAND, cooling rows demoted,
 * overlay marks the same), inherit gives main's model except for an `exempt` alias (the router reads `exempt` ONLY under inherit), a sticky model, a retry signal (same messages length) that hands off to a non-cooling row of
 * the set, cooling, counters. `bug` injects one defect each.
 */
function fakeWorld(bug = {}) {
  const w = { policy: null, files: new Map(), flag: false, counters: {}, warnings: [], agents: [], classify: [], sticky: new Map(), main: new Map(), script: {}, cooling: new Set(), overlay: new Set(), gw: { pid: 100, serviceSha: "s" }, corePid: 200, blocked: new Set(), workers: bug.workers ?? 1, seq: 0, records: [], torn: false, tornCounted: false,
    decisions: [], published: { counters: {}, warnings: [], cooling: [] }, logFd: false, overlayPending: new Set() };
  const count = (k, n = 1) => { w.counters[k] = (w.counters[k] ?? 0) + n; };
  const stub = { records: w.records, setScript: (s) => { w.script = s ?? {}; }, clear: () => { w.records.length = 0; }, last: () => w.records[w.records.length - 1] };
  const rows = () => (w.policy && typeof w.policy === "object" ? w.policy.models : []);
  const norm = (st) => (typeof st === "number" ? { status: st, retryAfter: null } : { status: st?.status ?? 200, retryAfter: st?.retryAfter ?? null });
  const forward = (model, aid, tools) => {
    const r = { seq: ++w.seq, method: "POST", path: "/v1/messages", model: bareOf(model), headers: aid ? { "x-claude-code-agent-id": aid, "x-claude-code-session-id": "child-sess" } : {}, toolNames: tools ? ["Bash"] : [], sent: null };
    const st = norm(w.script.decide?.(r) ?? 200);
    r.sent = { status: st.status, retryAfter: st.retryAfter, cut: null };
    w.records.push(r);
    return st;
  };
  const cooled = (m) => w.cooling.has(m) || w.cooling.has("prov:uwstub");                 // router coolFail: two DISTINCT models of one provider failing within five minutes cool the provider key too
  const coolFail = (m) => { const others = [...w.cooling].filter((k) => k !== m && !k.startsWith("prov:")); w.cooling.add(m); if (others.length) w.cooling.add("prov:uwstub"); };
  const snapshot = () => ({ counters: { ...w.counters }, warnings: structuredClone(w.warnings.concat(w.blocked.size ? [{ code: "LOG_DROPPED" }] : [])), cooling: [...w.cooling].map((k) => ({ key: k, rung: 0, leftSec: 120, fails: 1 })) });
  const publish = () => { w.published = snapshot(); };
  const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const K = 3;
  const scan = (exclude = new Set()) => {                                               // pickSubstitute: first K usable non-cooling rows of the lead band; a band is never mixed into the lead's
    const got = [], chill = []; let lead = null;
    for (const r of rows()) {
      if (exclude.has(r.s)) continue;
      if (!bug.noBands && lead && r.b !== lead.b) break;
      if (!bug.coolingIgnored && (cooled(r.s) || w.overlay.has(r.s))) { if (chill.length < K) chill.push(r); continue; }
      if (!lead) lead = r;
      got.push(r); if (got.length >= K) break;
    }
    return { got, chill };
  };
  const mainFirst = (session, exclude = new Set()) => { const m = w.main.get(session); return !bug.noMainFirst && m && rows().some((r) => r.s === m) && !exclude.has(m) && !cooled(m) ? m : null; };     // plan 6.2: main's own model first, when it is a usable non-cooling row
  const pickSub = (aid, session) => { const first = mainFirst(session); if (first) return first; const { got, chill } = scan(); const pool = got.length ? got : chill.filter((r) => r.b === chill[0]?.b); return pool.length ? (bug.noSpread ? pool[0] : pool[hash(aid) % pool.length]).s : null; };
  const handoffTo = (cur, session) => (bug.paidHandoff ? ["uwstub/m-free", "uwstub/m-big", "uwstub/m-main"].find((m) => m !== cur && !cooled(m)) ?? null : mainFirst(session, new Set([cur])) ?? scan(new Set([cur])).got[0]?.s ?? null);
  async function send(shape, o = {}) {
    count("req");
    const model = o.model, session = o.session ?? "s", aid = o.agentId;
    if (shape === "main") { w.main.set(session, model); count("main"); const st = forward(model, null, true); return { status: st.status, ms: 5, headers: {} }; }
    if (shape === "bg" || shape === "aux") { count(shape === "aux" ? "aux" : "bg"); const st = forward(bug.rewriteAux ? "uwstub/m-free" : model, aid, false); return { status: st.status, ms: 5, headers: {} }; }
    count("sub");
    w.classify.push({ aid: String(aid).slice(0, 12), cls: bug.mainClass ? "main" : "sub" });
    const pol = w.policy, ms = bug.slow ? 90000 : 5;
    const warn = (c) => { if (!w.warnings.some((x) => x.code === c)) { w.warnings.push({ code: c }); publish(); } };      // a new warning code forces a status flush
    const plain = () => { const st = forward(model, aid, true); return { status: st.status, ms, headers: {} }; };
    if (pol === "corrupt") { warn("POLICY_CORRUPT"); return plain(); }
    if (pol && pol.minRouter > 2) { if (!bug.noNewerWarn) warn("POLICY_NEWER"); return plain(); }
    if (!pol || (w.flag && !bug.rollbackIgnored) || pol.owner.enforcement !== "enforce") return plain();
    if (pol.owner.mode === "inherit") {
      if (pol.exempt.includes(model) && !bug.exemptIgnored) return plain();
      const m = bug.inheritNoop ? model : w.main.get(session) ?? model;
      const st = forward(m, aid, true); return { status: st.status, ms, headers: {} };
    }
    if (pol.exempt.includes(model)) return plain();                                      // never reached by a correct world: exempt is read under inherit only (here: a dynamic policy with an exempt list is served like any other)
    const key = `${session}:${aid}`;
    let e = w.sticky.get(key), chosen, retry = false;
    if (w.blocked.size && !bug.silentLogs) { count("journalFail"); if (!w.logFd) count("logDropped"); if (bug.failOnBlocked) return { status: 500, ms: 5, headers: {} }; }      // a worker that already holds its log descriptor open does not notice the swap
    if (!w.blocked.size) w.logFd = true;
    if (e && o.messages === e.len && !bug.noRetrySignal) retry = true;
    if (retry) {
      count("retry");
      if (!bug.noHandoff) {
        coolFail(e.model); count("coolMark");
        const other = handoffTo(e.model, session);
        if (!other) { count("handoffNone"); chosen = e.model; }
        else { const from = e.model; e.model = other; chosen = other; count("handoff"); w.agents.push({ v: 2, path: "handoff", act: "handoff", aid: String(aid).slice(0, 12), aid_full: aid, from, to: other, hop: 1, rsrc: "len", reason: "retry:len:1", ret: other }); }
      } else chosen = e.model;
    } else if (e) { chosen = e.model; count("stickyHit"); e.hits = (e.hits ?? 0) + 1; if (e.hits === 1) w.decisions.push({ act: "sticky", aid: String(aid).slice(0, 12) }); if (bug.stickyBroken) chosen = rows().find((r) => r.s !== e.model)?.s ?? e.model; }
    else {
      const want = o.tag ?? model;
      chosen = rows().some((r) => r.s === want) ? want : pickSub(aid, session) ?? model;
      e = { model: chosen, len: o.messages }; w.sticky.set(key, e);
      w.agents.push({ v: 2, path: "new", act: chosen === want ? "honour-tag" : "substitute", aid: String(aid).slice(0, 12), asked: model, ret: chosen, main: w.main.get(session) ?? null });
    }
    e.len = o.messages;
    if (w.torn && !w.tornCounted) { count("stickyJournalTorn"); w.tornCounted = true; }
    if (bug.errorOnState && w.files.has("cooling.json")) count("error");
    const st = forward(chosen, aid, true);
    return { status: st.status, ms, headers: st.retryAfter !== null ? { "retry-after": String(st.retryAfter) } : {} };
  }
  const prims = {
    send, stub, now: () => 1_800_000_000_000, sleep: async (ms) => { if (ms >= 1000 && !bug.overlayIgnored) for (const m of w.overlayPending) w.overlay.add(m); if (ms >= 1000) w.overlayPending.clear(); }, settle: async () => {},
    policy: async (p) => { w.policy = p; w.flag = false; },
    writeState: async (f, text) => { w.files.set(f, text); if (f === "policy.json") { try { w.policy = JSON.parse(text); } catch { w.policy = "corrupt"; } } },
    appendState: async (f, text) => { w.files.set(f, (w.files.get(f) ?? "") + text); w.torn = !bug.tornIgnored; },
    removeState: async (f) => { w.files.delete(f); if (f === "policy.json") w.policy = null; },
    blockState: async (f) => { w.blocked.add(f); }, unblockState: async (f) => { w.blocked.delete(f); },
    readLog: async (f) => (f === "agents.jsonl" ? structuredClone(w.agents) : f === "classify.jsonl" ? structuredClone(w.classify) : f === "decisions.jsonl" ? structuredClone(w.decisions) : []),
    status: async () => structuredClone(w.published),                                 // STALE until a flush: what the router counted since is not in it
    freshStatus: async () => { forward("uwstub/m-big", "uwsc-flush", false); publish(); return structuredClone(w.published); },      // an aux request after the window: it reaches the stub too (a record count would see it)
    workerFiles: async () => w.workers,
    gatewayFingerprint: async () => ({ ...w.gw }),
    rollback: async () => { w.flag = true; if (bug.gwRestart) w.gw = { pid: 101, serviceSha: "s" }; return true; }, resume: async () => { w.flag = false; },
    feedOverlay: async (m) => { w.overlayPending.add(m); return true; },                // the router re-reads observed.json at most once a second: effective after a wait of one second or more
    lastOut: async () => [...w.agents.filter((a) => a.act === "handoff").map((a) => `HANDOFF ${a.from} -> ${a.to} (retry 1, hop 1)`), ...w.agents.filter((a) => a.act !== "handoff").map((a) => `asked ${a.asked} ran ${a.ret}`)],
    claude: null, realCheck: null,
    reset: async () => { w.files.delete("cooling.json"); if (!bug.resetIneffective) w.cooling.clear(); w.overlay.clear(); w.overlayPending.clear(); w.sticky.clear(); w.flag = false; w.torn = false; w.tornCounted = false; w.warnings.length = 0; w.published = { counters: w.published.counters, warnings: [], cooling: bug.resetIneffective ? w.published.cooling : [] }; },
  };
  return { w, prims };
}
const runAll = async (bug, extra = {}) => { const { prims } = fakeWorld(bug); const lines = []; const res = await S.runScenarios(prims, extra, (l) => lines.push(l)); return { res, lines, by: Object.fromEntries(res.map((r) => [r.scn.id, r.result])) }; };

test("the whole suite against a CORRECT fake sandbox: every scenario passes (11 DEGRADED by design, C4 a FINDING for one worker), one result line each naming the client, and the suite verdict is OK with the non-PASS ids listed as not G3 evidence", async () => {
  const { by, lines } = await runAll({});
  const verdicts = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.verdict]));
  assert.deepEqual(verdicts, { 1: "PASS", 2: "PASS", 3: "PASS", 4: "PASS", 5: "PASS", 6: "PASS", 7: "FINDING", 8: "PASS", 9: "PASS", 10: "PASS", 11: "DEGRADED", C1: "PASS", C2: "PASS", C3: "PASS", C4: "FINDING" });
  assert.equal(lines.length, 15); assert.ok(lines.every((l) => S.parseScenarioLine(l)));
  assert.ok(lines.every((l) => /\[replay\]/.test(l)), "every line says replay (scenarios 4-10 and C1-C4 and the DEGRADED line of 11 included)");
  assert.ok(lines.filter((l) => !/^SCENARIO PASS/.test(l)).every((l) => /\[not G3 evidence\]$/.test(l)));
  const v = S.suiteVerdict(lines, S.ALL.map((s) => s.id));
  assert.equal(v.ok, true); assert.deepEqual(v.notG3, ["7", "11", "C4"]);
  assert.deepEqual((await runAll({ workers: 2 })).by.C4.verdict, "PASS");
});

test("MUTATION (the fake router gets one defect each): every defect turns EXACTLY the matching scenarios to FAIL or FINDING and leaves every other scenario as it was", async () => {
  const cases = [
    [{ rewriteAux: true }, { 8: "FAIL" }], [{ noHandoff: true }, { 2: "FAIL", 3: "FAIL", 7: "FAIL", 10: "FAIL" }], [{ noRetrySignal: true }, { 2: "FINDING", 3: "FAIL", 7: "FAIL", 10: "FAIL" }],
    [{ mainClass: true }, { 4: "FAIL" }], [{ stickyBroken: true }, { 5: "FAIL", 7: "FAIL" }], [{ noNewerWarn: true }, { 6: "FAIL" }], [{ silentLogs: true }, { C3: "FAIL" }],
    [{ rollbackIgnored: true }, { 9: "FAIL" }], [{ gwRestart: true }, { 9: "FAIL" }], [{ noSpread: true }, { 10: "FAIL" }], [{ overlayIgnored: true }, { 11: "FINDING" }],
    [{ tornIgnored: true }, { C2: "FAIL" }], [{ failOnBlocked: true }, { C3: "FAIL" }], [{ errorOnState: true }, { C1: "FAIL" }], [{ slow: true }, { 3: "FAIL" }],
    // F4: the broken variants a vacuous judge would have passed
    [{ noBands: true }, { 10: "FAIL" }], [{ coolingIgnored: true }, { 3: "FAIL", 10: "FAIL", 11: "FINDING" }], [{ paidHandoff: true }, { 2: "FAIL" }],
    // F1: exempt is read under inherit only, and inherit must move a non-exempt subagent
    [{ exemptIgnored: true }, { 8: "FAIL" }], [{ inheritNoop: true }, { 8: "FAIL" }],
  ];
  const base = (await runAll({})).by;
  for (const [bug, changed] of cases) {
    const { by } = await runAll(bug);
    for (const id of Object.keys(base)) {
      const want = changed[id] ?? base[id].verdict;
      assert.equal(by[id].verdict, want, `${JSON.stringify(bug)} -> scenario ${id}: ${by[id].text}`);
    }
  }
});

test("F1: scenario 8's exempt alias runs under an INHERIT policy (the router reads exempt only under inherit); under a dynamic policy the same call would be substituted, and the judge insists the control moved", async () => {
  const f = fakeWorld({});
  await S.runScenarios(f.prims, { only: ["8"] });
  assert.equal(f.w.policy.owner.mode, "inherit"); assert.deepEqual(f.w.policy.exempt, ["uwstub/m-main"]); assert.deepEqual(f.w.policy.models, [], "inherit compiles no rows");
  // the same exempt call under a DYNAMIC policy is moved by the faithful toy router: it is not an inherit-free pass
  const g = fakeWorld({});
  await g.prims.policy(S.scenarioPolicy({ rows: ["m-free"], exempt: ["uwstub/m-main"] }));
  await g.prims.send("main", { model: ANCHOR, session: "x" });
  await g.prims.send("sub", { model: "uwstub/m-main", agentId: "e1", session: "x", messages: 3, agentTool: false });
  assert.equal(g.w.records.at(-1).model, "m-main", "(the toy keeps an exempt asked in a dynamic policy only because the policy lists it; the scenario does not rely on that)");
  const ev = await (async () => { const h = fakeWorld({}); h.w.script = {}; return null; })();
  assert.equal(ev, null);
  const inh = S.scenarioPolicy({ mode: "inherit", exempt: ["uwstub/m-main"] });
  assert.deepEqual([inh.owner.mode, inh.models.length, inh.lists.prov, inh.substitutable], ["inherit", 0, {}, { "*": 0 }]);
});

test("runScenarios: --only picks scenarios, --runs repeats them (every run judged), a throwing run is that scenario's FAIL and the suite goes on", async () => {
  const { prims } = fakeWorld({});
  const lines = [];
  const res = await S.runScenarios(prims, { only: ["8", "4"], runs: 3 }, (l) => lines.push(l));
  assert.deepEqual(res.map((r) => [r.scn.id, r.result.runs, r.result.passed]), [["4", 3, 3], ["8", 3, 3]]);
  assert.match(lines[0], /\(3 of 3 runs\)/);
  const boom = { ...prims, send: async (shape, o) => { if (shape === "aux") throw new Error("gateway reset"); return prims.send(shape, o); } };
  const r2 = await S.runScenarios(boom, { only: ["8", "4"] });
  assert.equal(r2.find((r) => r.scn.id === "8").result.verdict, "FAIL"); assert.match(r2.find((r) => r.scn.id === "8").result.text, /a run threw: gateway reset/);
});

test("the scenario policies are what each scenario needs: two bands for the fan-out, an inherit half for the exempt alias, the free-only row for spawn-and-serve, the free-mode variant without the paid model", async () => {
  const { w, prims } = fakeWorld({});
  await S.runScenarios(prims, { only: ["10"] });
  assert.deepEqual(w.policy.models.map((m) => [m.s, m.b]), [["uwstub/m-free", 0], ["uwstub/m-big", 0], ["uwstub/m-main", 1]]);
  await S.runScenarios(prims, { only: ["6"] });
  assert.equal(w.policy, null, "the last variant removes the policy file");
  const f = fakeWorld({}); await S.runScenarios(f.prims, { only: ["1"] });
  assert.deepEqual(f.w.policy.models.map((m) => m.s), ["uwstub/m-free"], "one row: the policy's model is unambiguous");
  const g = fakeWorld({}); await S.runScenarios(g.prims, { only: ["2"] });
  assert.equal(g.w.policy.owner.mode, "free"); assert.deepEqual(g.w.policy.models.map((m) => [m.s, m.fp]), [["uwstub/m-free", 1], ["uwstub/m-main", 1]], "the paid m-big is not in the free policy");
});

// ====================================================================================== the real client: how it would be started (pure) and how its isolation is judged
import { buildLaunchEnv } from "../harness/subagent-sandbox-spec.mjs";
const PARENT = { PATH: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", USERPROFILE: "C:\\real\\me", HOME: "C:\\real\\me", HTTPS_PROXY: "http://proxy.invalid", ANTHROPIC_API_KEY: "real-key", ANTHROPIC_BASE_URL: "http://127.0.0.1:3456", CLAUDE_CODE_OAUTH_TOKEN: "t", NODE_OPTIONS: "--require x", CCR_FOO: "1" };
test("claudeInvocation: the client is pointed at the SANDBOX by environment only, from the WHITELIST launch environment (PATH, SystemRoot and ComSpec survive, proxies, keys, ANTHROPIC_*, CCR_* and the node preload do not), with a scratch cwd; it never reads process.env itself", () => {
  const scratch = path.join(os.tmpdir(), "uw-scn-scratch");
  const launch = buildLaunchEnv(PARENT, { preloadGuard: false });
  assert.ok(!("HTTPS_PROXY" in launch) && !("ANTHROPIC_API_KEY" in launch) && launch.PATH === "C:\\bin" && launch.ComSpec, "buildLaunchEnv is a whitelist, so the .cmd shim can run");
  const inv = S.claudeInvocation({ prompt: "do it", maxTurns: 3, key: "sandbox-key", launchEnv: launch, scratchRoot: scratch, gatewayPort: 45678, supports: { settingSources: true, strictMcp: true } });
  assert.equal(inv.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:45678"); assert.equal(inv.env.ANTHROPIC_API_KEY, "sandbox-key");
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "TEMP"]) assert.ok(inv.env[k].startsWith(scratch), `${k} is under the sandbox scratch root`);
  assert.equal(inv.env.PATH, "C:\\bin"); assert.equal(inv.env.SystemRoot, "C:\\Windows"); assert.ok(inv.env.ComSpec);
  const flat = JSON.stringify(inv.env);
  for (const bad of ["real-key", "proxy.invalid", "C:\\\\real\\\\me", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "CCR_FOO", "UW_TRIAL31", "\"PORT\"", "\"HOST\""]) assert.ok(!flat.includes(bad), `leaks ${bad}`);
  const leaky = S.claudeInvocation({ prompt: "x", key: "sandbox-key", launchEnv: { ...launch, ANTHROPIC_AUTH_TOKEN: "leak", CLAUDE_CODE_USE_BEDROCK: "1", HTTP_PROXY: "x" }, scratchRoot: scratch });
  assert.ok(!("ANTHROPIC_AUTH_TOKEN" in leaky.env) && !("CLAUDE_CODE_USE_BEDROCK" in leaky.env), "even a launch env that carried an ANTHROPIC_ or CLAUDE_CODE_ variable cannot pass it on");
  assert.deepEqual(inv.args.slice(0, 2), ["-p", "do it"]); assert.ok(inv.args.includes("--setting-sources") && inv.args.includes("--strict-mcp-config"));
  assert.ok(!S.claudeInvocation({ prompt: "x", key: "k", launchEnv: launch, supports: {} }).args.includes("--strict-mcp-config"), "the flags are added only when the launcher has them");
  assert.ok(inv.cwd.startsWith(scratch) && !inv.cwd.startsWith(REPO_ROOT), "a scratch working directory, never the repo");
  assert.throws(() => S.claudeInvocation({ prompt: "x", launchEnv: launch }), /profile key/);
  assert.throws(() => S.claudeInvocation({ prompt: "x", key: "k" }), /whitelist launch environment/, "no default to process.env");
  const canary = JSON.parse(S.canarySettings("sandbox-key", 45678));
  assert.deepEqual(canary.env, { ANTHROPIC_BASE_URL: "http://127.0.0.1:45678", ANTHROPIC_API_KEY: "sandbox-key" });
});

test("identifyClaude: the launcher's path, sha256, --version and flag support are read WITHOUT starting anything real here; a missing launcher is null; the identity lines are what the approval pins", () => {
  const fakeFs = { statSync: (f) => { if (/bin2[\\/]claude\.exe$/.test(f)) return { isFile: () => true }; throw new Error("ENOENT"); }, readFileSync: () => Buffer.from("fake-claude-bytes") };
  const calls = [];
  const run = (exe, args) => { calls.push(args[0]); return args[0] === "--version" ? "2.1.0 (Claude Code)\nextra" : "Usage: claude [options]\n  --setting-sources <s>\n  --strict-mcp-config"; };
  const id = S.identifyClaude({ env: { PATH: ["bin1", "bin2"].join(path.delimiter) }, fsx: fakeFs, run });
  assert.deepEqual([id.version, id.sha256, id.supports], ["2.1.0 (Claude Code)", sha(Buffer.from("fake-claude-bytes")), { settingSources: true, strictMcp: true, dontAsk: false, streamJson: false }]); assert.match(id.path, /bin2[\\/]claude\.exe$/);
  assert.deepEqual(calls, ["--version", "--help"]);
  assert.equal(S.identifyClaude({ env: { PATH: "" }, fsx: fakeFs, run }), null);
  assert.deepEqual(S.identifyClaude({ env: { PATH: "bin2" }, fsx: fakeFs, run: () => "no flags here" }).supports, { settingSources: false, strictMcp: false, dontAsk: false, streamJson: false });
  const full = S.identifyClaude({ env: { PATH: "bin2" }, fsx: fakeFs, run: (e, a) => (a[0] === "--version" ? "2.1.289" : '  --permission-mode <mode>  (choices: "acceptEdits", "dontAsk")\n  --output-format <f> "stream-json"\n  --verbose') });
  assert.deepEqual([full.supports.dontAsk, full.supports.streamJson], [true, true]);
  assert.equal(S.findClaude({ PATH: "" }), null);
});

import { EventEmitter } from "node:events";
const fakeChild = (pid = 321) => { const c = new EventEmitter(); c.pid = pid; c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); return c; };
test("realSpawnClaude: runs the isolated env with shell:false, reads stdout AND stderr, a .cmd shim goes through cmd.exe, a timeout KILLS THE PROCESS TREE, a failed start or an error is reported, nothing real is started in the test", async () => {
  const inv = { args: ["-p", "x"], env: { ComSpec: "C:\\Windows\\System32\\cmd.exe", PATH: "p" }, cwd: path.join(os.tmpdir(), "scn-cwd") };
  let seen, child = fakeChild();
  const spawnImpl = (cmd, args, opts) => { seen = { cmd, args, opts }; return child; };
  let p = S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, kill: () => assert.fail("not killed") });
  child.stdout.emit("data", Buffer.from("{\"result\":\"ok\"}")); child.stderr.emit("data", Buffer.from("warn: x")); child.emit("close", 0);
  const r = await p;
  assert.deepEqual([seen.cmd, seen.opts.shell, seen.opts.env === inv.env, seen.opts.cwd === inv.cwd, seen.opts.stdio], ["C:\\bin\\claude.exe", false, true, true, ["ignore", "pipe", "pipe"]]);
  assert.deepEqual([r.code, r.text, r.err], [0, "{\"result\":\"ok\"}", "warn: x"]);
  child = fakeChild(); p = S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.cmd", spawnImpl, kill: () => {} }); child.emit("close", 1);
  await p; assert.equal(seen.cmd, "C:\\Windows\\System32\\cmd.exe"); assert.deepEqual(seen.args.slice(0, 4), ["/d", "/s", "/c", "C:\\bin\\claude.cmd"]);
  const killed = []; child = fakeChild(777);
  const t = await S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, timeoutMs: 20, kill: (pid) => killed.push(pid) });
  assert.deepEqual([t.code, killed], [null, [777]]); assert.match(t.reason, /timed out; the process tree was killed/);
  child = fakeChild(5); const e = S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, kill: (pid) => killed.push(pid) }); child.emit("error", new Error("EACCES"));
  assert.match((await e).reason, /EACCES/); assert.ok(killed.includes(5));
  const none = await S.realSpawnClaude({ ...inv, env: { PATH: "" } }, { spawnImpl });
  assert.match(none.reason, /no claude launcher/);
  const thrown = await S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl: () => { throw new Error("spawn EPERM"); } });
  assert.match(thrown.reason, /spawn EPERM/);
  const calls = []; S.killTree(42, (cmd, args) => calls.push([path.basename(cmd), args])); if (process.platform === "win32") assert.deepEqual(calls, [["taskkill.exe", ["/PID", "42", "/T", "/F"]]]);
  S.killTree(-1, () => assert.fail("a bad pid is ignored"));
});

test("realClientProblems: the REAL ~/.claude.json holding the scratch project, the REAL ~/.claude/projects holding its slug, no child state under the sandbox claude-config, no session id, a live-gateway hit or an unreadable live log each FAIL; all clear PASSES", async () => {
  const cwd = path.join(os.tmpdir(), "uw-scn-cwd"), cfg = path.join(os.tmpdir(), "uw-scn-config"), home = path.join(os.tmpdir(), "uw-scn-home");
  const world = (o = {}) => ({ sys: { readText: (p) => (path.basename(p) === ".claude.json" && p.startsWith(home) ? o.json ?? JSON.stringify({ projects: { "C:\\other": {} } }) : null) },
    fs: { existsSync: (p) => (o.realProj && p.startsWith(path.join(home, ".claude", "projects")) ? true : o.noChild ? false : p.startsWith(cfg)) } });
  const run = (o = {}, args = {}) => S.realClientProblems({ d: world(o), cwd, scratchConfig: cfg, home, sessionIds: ["s1"], liveRequestsFor: async () => 0, ...args });
  assert.deepEqual(await run(), { ok: true, problems: [] });
  assert.match((await run({ json: JSON.stringify({ projects: { [cwd]: {} } }) })).problems[0], /REAL ~\/\.claude\.json now records the project/);
  assert.match((await run({ realProj: true })).problems[0], /REAL ~\/\.claude\/projects holds a folder/);
  assert.match((await run({ noChild: true })).problems.join(), /redirect was not shown to work/);
  assert.match((await run({}, { sessionIds: [] })).problems.join(), /no session id of the child/);
  assert.match((await run({}, { liveRequestsFor: async () => 3 })).problems.join(), /3 request\(s\) carrying the child's session id reached the LIVE gateway/);
  assert.match((await run({}, { liveRequestsFor: async () => null })).problems.join(), /could not be read/);
  assert.match((await run({}, { liveRequestsFor: async () => { throw new Error("locked"); } })).problems.join(), /could not be read/);
  assert.match((await run({ json: "{ not json" })).problems.join(), /could not be read, so the sentinel/);
});

test("sandboxPrims with a real client: the canary settings.json is written under the sandbox claude-config (gateway and sandbox-only key), the invocation carries the launcher's flags, and the isolation check reads the child's session ids from the stub; without identity or spawn there is no client", async () => {
  const { SCRATCH_ROOT } = await import("../harness/subagent-sandbox-spec.mjs");
  const mem = new Map();
  const d = { fs: { mkdirSync() {}, writeFileSync: (p, t) => mem.set(path.resolve(p), String(t)), renameSync: (a, b) => { mem.set(path.resolve(b), mem.get(path.resolve(a))); mem.delete(path.resolve(a)); }, rmSync() {}, readdirSync: () => [], existsSync: () => true },
    sys: { readText: () => null, listenerPid: () => 1 }, now: () => 1, sleep: async () => {}, fetch: async () => { throw new Error("no"); } };
  const stub = { records: [{ headers: { "x-claude-code-session-id": "sid-1" } }, { headers: {} }, { headers: { "x-claude-code-session-id": "sid-1" } }] };
  const spawned = [];
  const p = S.sandboxPrims({ d, key: "sbkey", stub, launchEnv: buildLaunchEnv(PARENT, { preloadGuard: false }) }, { real: true, identity: FAKE_CLAUDE, spawnClaude: async (inv, o) => { spawned.push([inv, o]); return { code: 0 }; }, liveRequestsFor: async (ids) => { spawned.push(["live", ids]); return 0; } });
  assert.equal(typeof p.claude, "function");
  await p.claude({ prompt: "go", maxTurns: 2 });
  const canary = [...mem.entries()].find(([k]) => k.endsWith(path.join("claude-config", "settings.json")));
  assert.ok(canary && canary[0].startsWith(path.resolve(SCRATCH_ROOT)), "the canary lives under the sandbox scratch root");
  assert.equal(JSON.parse(canary[1]).env.ANTHROPIC_API_KEY, "sbkey");
  assert.ok(spawned[0][0].args.includes("--setting-sources") && spawned[0][1].exe === FAKE_CLAUDE.path);
  const rc = await p.realCheck();
  assert.deepEqual(spawned.at(-1), ["live", ["sid-1"]]);
  assert.equal(rc.ok, true === rc.ok ? rc.ok : false);
  for (const bad of [{ real: true, identity: null, spawnClaude: async () => ({}) }, { real: true, identity: FAKE_CLAUDE, spawnClaude: null }, { real: false, identity: FAKE_CLAUDE, spawnClaude: async () => ({}) }]) {
    const q = S.sandboxPrims({ d, key: "k", stub, launchEnv: {} }, bad);
    assert.equal(q.claude, null); assert.equal(q.realCheck, null);
  }
});

/** The record the stub would hold for the user's turn of a real client: the script's own user markers present, no tool_result yet. */
const userTurn = (script, over = {}) => ({ userMarkers: Object.fromEntries((script.userMarkers ?? []).map((m) => [m, true])), toolResults: 0, ...over });
test("--real yes: the client is named truthfully. Without a client (no launcher pinned) the REAL scenarios REPLAY and their lines never read 'real claude -p'; with a client scenarios 1, 2, 3 and 11 call it (each sets onMain so a subagent is spawned), judge the failure from the STUB, name the client, and RC is judged", async () => {
  const f = fakeWorld({});
  const r0 = await S.runScenarios(f.prims, { only: ["1", "2", "3", "11"], real: true });
  for (const x of r0) { assert.match(x.result.client, /^replay \(real client unavailable/, `scenario ${x.scn.id}`); assert.ok(!/real claude -p/.test(S.scenarioLine(x.result, x.scn))); }
  assert.ok(!r0.some((x) => x.scn.id === "RC"), "no real client, no RC line");
  // a fake CLIENT that behaves like claude -p: it asks the stub's script for a spawn, then sends the main and subagent requests a real client would
  const g = fakeWorld({}); const prompts = [];
  g.prims.claude = async ({ prompt }) => {
    prompts.push(prompt);
    const spawn = g.w.script.onMain?.(userTurn(g.w.script));
    assert.ok(spawn && spawn.subagent_type, "the scenario's stub script spawns a subagent (onMain), or a real client would never delegate");
    await g.prims.send("main", { model: ANCHOR, session: "real-sess" });
    const sub = (over) => g.prims.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "real-agent", session: "real-sess", messages: 3, agentTool: false, ...over });
    await sub({}); if (g.w.script.decide?.({ model: "uwstub/m-free", headers: { "x-claude-code-agent-id": "x" } }) === 429) await sub({ retryCount: 1 });
    return { code: 0 };
  };
  g.prims.realCheck = async () => ({ ok: false, problems: ["the REAL ~/.claude.json now records the project X"] });
  const lines = [];
  const r1 = await S.runScenarios(g.prims, { only: ["1", "2", "3", "11"], real: true }, (l) => lines.push(l));
  assert.equal(prompts.length, 4, "one real client run per REAL scenario");
  assert.deepEqual(Object.fromEntries(r1.map((x) => [x.scn.id, x.result.verdict])).RC, "FAIL");
  assert.ok(lines.find((l) => /^SCENARIO FAIL RC REAL-CLIENT ISOLATION \[real claude -p\]/.test(l)));
  assert.equal(S.suiteVerdict(lines, ["1", "2", "3", "11"]).ok, false, "RC fails the suite");
  assert.match(S.scenarioLine(r1.find((x) => x.scn.id === "11").result, r1.find((x) => x.scn.id === "11").scn), /^SCENARIO DEGRADED 11 .*\[real claude -p\]/);
  // scenario 11: a clean exit of a client that never spawned a subagent is NOT a failure of the agent
  const h = fakeWorld({}); h.prims.claude = async () => ({ code: 0 });
  const r2 = await S.runScenarios(h.prims, { only: ["11"], real: true });
  assert.equal(r2[0].result.verdict, "FAIL"); assert.match(r2[0].result.text, /not set up/);
});

test("the replay shapes: a real subagent has no Agent tool, so every subagent send of scenarios 6 and 8 and the fan-out says agentTool:false", async () => {
  const f = fakeWorld({}); const sent = [];
  const orig = f.prims.send; f.prims.send = async (shape, o) => { sent.push([shape, o?.agentTool]); return orig(shape, o); };
  await S.runScenarios(f.prims, { only: ["6", "8", "10"] });
  assert.ok(sent.filter(([sh]) => sh === "sub").length > 20);
  assert.ok(sent.filter(([sh]) => sh === "sub").every(([, t]) => t === false), "no subagent send carries the Agent tool");
});

test("runSandbox and runSelftest refuse BEFORE anything starts when the claude launcher is not the one pinned in the approval (the orchestrator is only asked for its plan hash, which reads files and starts nothing)", async () => {
  const pinned = { ...FAKE_CLAUDE }, other = { ...FAKE_CLAUDE, sha256: "e".repeat(64) };
  const d = { ccrInstall: () => ({ found: false, reason: "test" }), out() {}, err() {} };
  const errs = [];
  const code = await S.runSandbox({ only: ["8"], runs: 1, real: true, approval: { files: [], ccr: [] }, identity: pinned }, { err: (l) => errs.push(l), out() {} }, { d, identifyClaude: () => other });
  assert.equal(code, 1); assert.match(errs.join(String.fromCharCode(10)), /claude launcher .* is not the one pinned in the approval/);
  await assert.rejects(S.runSelftest({ real: true, identity: pinned, approval: { files: [], ccr: [] } }, {}, { d, identifyClaude: () => other }), /claude launcher .* is not the one pinned/);
  const errs2 = [];
  const c2 = await S.runSandbox({ only: ["8"], real: false, approval: null, identity: null }, { err: (l) => errs2.push(l), out() {} }, { d: { ...d, buildSpec: () => { throw new Error("stop here"); } }, identifyClaude: () => { throw new Error("replay must not identify the launcher"); } });
  assert.equal(c2, 1); assert.ok(errs2.some((l) => /could not read the orchestrator.s plan hash/.test(l)), "replay mode went on to the orchestrator step and never looked at the launcher");
});

test("real mode: EACH of scenarios 1, 2, 3 and 11 sets onMain in its stub script (without it a real client is never told to spawn a subagent); a scenario whose script lacks it FAILS and is named", async () => {
  const seen = {};
  const g = fakeWorld({});
  let current = null;
  g.prims.claude = async () => {
    const spawn = g.w.script.onMain?.(userTurn(g.w.script));
    seen[current] = !!(spawn && spawn.subagent_type);
    if (!seen[current]) return { code: 0 };                                              // a client with no scripted spawn delegates nothing
    await g.prims.send("main", { model: ANCHOR, session: `real-${current}` });
    await g.prims.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: `real-agent-${current}`, session: `real-${current}`, messages: 3, agentTool: false });
    if (g.w.script.decide?.({ model: "uwstub/m-free", headers: { "x-claude-code-agent-id": "x" } }) === 429) for (let i = 1; i <= 4; i++) await g.prims.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: `real-agent-${current}`, session: `real-${current}`, messages: 3, retryCount: i, agentTool: false });   // a client keeps retrying until the models are exhausted
    return { code: 0 };
  };
  const origReset = g.prims.reset; g.prims.reset = async () => { await origReset(); };
  const results = {};
  for (const id of ["1", "2", "3", "11"]) {
    current = id;
    const r = await S.runScenarios(g.prims, { only: [id], real: true });
    results[id] = r.find((x) => x.scn.id === id).result.verdict;
  }
  assert.deepEqual(seen, { 1: true, 2: true, 3: true, 11: true }, "every REAL scenario's stub script spawns a subagent");
  assert.deepEqual(results, { 1: "PASS", 2: "PASS", 3: "PASS", 11: "DEGRADED" });
});

test("the plan states that the fail-closed guard is OFF and the second token is derived; runSandbox and runSelftest build the orchestrator spec with --no-preload-guard in BOTH calls (the plan call and the run call)", async () => {
  const plan = S.planLines().join("\n");
  assert.match(plan, /the fail-closed process guard is OFF \(--no-preload-guard, the G1 precedent: the 3\.1\.1 guard false-alarms on CCR 3\.0\.22's own native load\); the second consent token that option needs is DERIVED from the orchestrator's own plan hash, so it is not an independent confirmation/);
  const { buildSpec } = await import("../harness/subagent-sandbox-spec.mjs");
  const observe = async (fn) => {
    const guard = [], errs = [];
    const d = { ccrInstall: () => ({ found: false, reason: "test" }), buildSpec: (env, o) => { guard.push(o.preloadGuard); return buildSpec(env, o); }, out() {}, err: (l) => errs.push(String(l)) };
    const out = await fn(d, errs);
    return { guard, errs, out };
  };
  const sb = await observe((d, errs) => S.runSandbox({ only: ["8"], runs: 1, real: false, approval: { files: [], ccr: [] }, identity: null }, { err: (l) => errs.push(String(l)), out() {} }, { d }));
  assert.deepEqual(sb.guard, [false, false], "the plan call and the run call both say --no-preload-guard");
  const st = await observe((d, errs) => S.runSelftest({ real: false, approval: { files: [], ccr: [] } }, { err: (l) => errs.push(String(l)), out() {} }, { d }));
  assert.deepEqual(st.guard, [false, false]);
});

// The orchestrator's plan hash covers the FLAGS (--router included). The token the run needs is the first 12 hex of THAT hash for the run's flag set, so both --plan calls carry --router next:
// without it the hash differs (f60dfce901e7 without, 2f4c63e6f180 with) and the orchestrator refuses the run at the second-token check with exit 2.
test("runSandbox and runSelftest pass the second token that matches the orchestrator's plan hash FOR THE RUN'S FLAGS (--router next): the run is not refused at the token check", async () => {
  const { buildSpec } = await import("../harness/subagent-sandbox-spec.mjs");
  for (const fn of [(d, errs) => S.runSandbox({ only: ["8"], runs: 1, real: false, approval: { files: [], ccr: [] }, identity: null }, { err: (l) => errs.push(String(l)), out() {} }, { d }), (d, errs) => S.runSelftest({ real: false, approval: { files: [], ccr: [] } }, { err: (l) => errs.push(String(l)), out() {} }, { d })]) {
    const errs = [];
    await fn({ ccrInstall: () => ({ found: false, reason: "test" }), buildSpec, out() {}, err: (l) => errs.push(String(l)) }, errs);
    assert.ok(errs.some((l) => /installed CCR was NOT FOUND/.test(l)), "the run got past the second-token check");
    assert.ok(!errs.some((l) => /--i-understand-no-guard/.test(l)), "no token complaint");
  }
});

// ====================================================================================== fix round 2 (the first replay run: no scenario was a router defect; the HARNESS read stale status, hid cooling state and fed the router wrong shapes)
/**
 * A WINDOWS-SHAPED virtual sandbox for the REAL sandboxPrims: a clock the sleeps advance, an in-memory scratch tree, and a ROUTER MODEL that behaves as the real one does where it matters here: status.json is flushed at most
 * every 5 s, and the cooling state lives in the router's MEMORY (V.cool) and is merged from cooling.json only when the file's stat changed (at most once a second) and only for a record whose `t` is NEWER than the one held
 * (router coolView), so deleting the file clears nothing. The seam has NO rpc, NO guard and NO process function at all: a harness that calls one throws. V.coolFail is the router's coolFail (rung ladder 2 min / 10 min / 60 min / 6 h).
 */
const LADDER = [2 * 60000, 10 * 60000, 60 * 60000, 6 * 3600000];
async function virtualSandbox(o = {}) {
  const { readyAfter = 0 } = o;
  const { SCRATCH_STATE_DIR } = await import("../harness/subagent-sandbox-spec.mjs");
  const mem = new Map(), r = (p) => path.resolve(p), T0 = 1_800_000_000_000, iso = (ms) => new Date(ms).toISOString();
  const V = { now: T0, statusAt: -1e15, reqs: [], cool: new Map(), coolChk: -1e15, coolText: null, T0, iso, answered: 0 };
  const statusFile = r(path.join(SCRATCH_STATE_DIR, "status.json")), coolFile = r(path.join(SCRATCH_STATE_DIR, "cooling.json"));
  const coolSync = () => {                                                                // router coolView: stat changed, at most once a second, a NEWER record replaces the one in memory
    if (V.now - V.coolChk < 1000) return;
    V.coolChk = V.now;
    const text = mem.get(coolFile) ?? null;
    if (text === V.coolText) return;
    V.coolText = text;
    let m = null; try { m = JSON.parse(text)?.models ?? null; } catch { /* torn */ }
    for (const k of Object.keys(m ?? {})) {
      const x = m[k], cur = V.cool.get(k);
      if (!x || !Number.isFinite(x.u) || !Number.isFinite(x.t)) continue;
      if (!cur || x.t > cur.t) V.cool.set(k, { u: Math.min(x.u, V.now + LADDER[3]), l: x.l | 0, t: Math.min(x.t, V.now), n: x.n > 0 ? x.n : 1, t0: Math.min(x.t0, Math.min(x.t, V.now)) });
    }
  };
  V.coolFail = (sel) => {                                                                // router coolFail: already cooling = no change; a streak escalates; the file is rewritten
    coolSync();
    const cur = V.cool.get(sel);
    if (cur && V.now < cur.u) return;
    let n = 1, t0 = V.now;
    if (cur && V.now <= cur.u + 3600000 && V.now - cur.t0 <= 24 * 3600000) { n = cur.n + 1; t0 = cur.t0; }
    const lvl = n >= 4 ? 3 : n - 1;
    V.cool.set(sel, { u: V.now + LADDER[lvl], l: lvl, t: V.now, n, t0 });
    const prov = sel.slice(0, sel.indexOf("/")), pk = `prov:${prov}`;                      // the PROVIDER RULE: another model of the provider with a record whose t is within 5 minutes (cooling or not) cools the provider key
    for (const [k, v] of V.cool) {
      if (k === sel || k.startsWith("prov:") || k.slice(0, k.indexOf("/")) !== prov || V.now - v.t > 5 * 60000) continue;
      const pc = V.cool.get(pk);
      if (!(pc && pc.u > V.now)) V.cool.set(pk, { u: V.now + LADDER[Math.max(lvl, v.l)], l: Math.max(lvl, v.l), t: V.now, n: Math.max(n, v.n), t0: Math.min(t0, v.t0) });
      break;
    }
    const models = {}; for (const [k, v] of V.cool) models[k] = v;
    V.coolText = JSON.stringify({ v: 1, models }); mem.set(coolFile, V.coolText);
  };
  const flush = () => {
    V.statusAt = V.now; coolSync();
    const cooling = [...V.cool].filter(([, v]) => v.u > V.now).map(([k, v]) => ({ key: k, rung: v.l, leftSec: Math.round((v.u - V.now) / 1000), fails: v.n }));
    mem.set(statusFile, JSON.stringify({ updatedAt: iso(V.now), counters: { req: V.reqs.length }, cooling }));
  };
  const d = {
    fs: { mkdirSync() {}, writeFileSync: (p, t) => mem.set(r(p), String(t)), renameSync: (a, b) => { mem.set(r(b), mem.get(r(a))); mem.delete(r(a)); }, rmSync: (p) => { mem.delete(r(p)); }, readdirSync: () => [], existsSync: () => true },
    sys: { selfPid: 700, readText: (p) => mem.get(r(p)) ?? null },
    now: () => V.now,
    sleep: async (ms) => { V.now += ms; },
    fetch: async (url, init) => {
      const h = init.headers, aux = !JSON.parse(init.body).tools;
      V.reqs.push({ aux, agent: h["x-claude-code-agent-id"] ?? null });
      if (V.now - V.statusAt >= 5000) flush();                                          // the router flushes at most every 5 s
      V.answered += 1;
      return { status: V.answered <= readyAfter ? 503 : 200, text: async () => "", headers: { forEach() {} } };
    },
  };
  const notes = [];
  const c = { d, key: "k", stub: { records: [] }, launchEnv: {}, out: (l) => notes.push(l) };
  return { V, d, c, mem, coolFile, statusFile, notes };
}
const prims = (v, extra = {}) => S.sandboxPrims(v.c, extra);

test("H1 freshStatus: it waits until 5.1 s have passed since the last request, sends exactly ONE aux request, and returns the status THAT flush wrote; a plain read straight after a request is old", async () => {
  const v = await virtualSandbox();
  const p = prims(v);
  await p.send("main", { model: ANCHOR, session: "s" });                                  // a request: flushes (the window had passed)
  const stale = await p.status();
  await v.d.sleep(1000);
  await p.send("sub", { model: ASKED_MODEL, agentId: "a1", session: "s", messages: 3, agentTool: false });   // 1 s later: inside the window, NO flush
  const old = await p.status();
  assert.equal(old.updatedAt, stale.updatedAt, "a read straight after a request is the old flush: this is the replay's stale-status defect");
  assert.equal(old.counters.req, 1, "and it does not hold the second request");
  const before = v.V.reqs.length, t0 = v.V.now;
  const s = await p.freshStatus();
  assert.equal(v.V.reqs.length, before + 1, "exactly ONE request");
  assert.deepEqual(v.V.reqs.at(-1), { aux: true, agent: "uwsc-flush" }, "an aux-shaped request (an agent id, no tools)");
  assert.ok(v.V.now - t0 >= 4100 + 400, `it waited out the window (${v.V.now - t0} ms virtual)`);
  assert.equal(s.counters.req, 3, "the status holds all three requests");
  assert.ok(!s.staleRead, "and is not marked stale");
  const t1 = v.V.now; const s2 = await p.freshStatus();                                  // straight after: the flush it caused is the new window start, so it waits again
  assert.ok(v.V.now - t1 >= 5100 && s2.counters.req === 4 && !s2.staleRead);
});

test("H1 freshStatus: when updatedAt never moves the read says so (staleRead) instead of passing old numbers off as fresh", async () => {
  const v = await virtualSandbox();
  const p = S.sandboxPrims({ ...v.c, d: { ...v.d, fetch: async () => ({ status: 200, text: async () => "", headers: { forEach() {} } }) } });
  v.d.fs.writeFileSync(v.statusFile, JSON.stringify({ updatedAt: "2026-01-01T00:00:00.000Z", counters: {} }));
  const s = await p.freshStatus();
  assert.equal(s.staleRead, true);
});

test("H1 MUTATION at the runner level: the same suite with a harness that reads the STALE status turns the counter-based scenarios to FAIL or FINDING; the fresh one passes them", async () => {
  const good = await runAll({});
  const { prims } = fakeWorld({});
  const lines = [], res = await S.runScenarios({ ...prims, freshStatus: prims.status }, {}, (l) => lines.push(l));       // the stale reader
  const by = Object.fromEntries(res.map((r) => [r.scn.id, r.result.verdict]));
  assert.deepEqual([by["2"], by["3"], by.C2, by.C3], ["FINDING", "FAIL", "FAIL", "FAIL"], JSON.stringify(by));
  assert.deepEqual([good.by["2"].verdict, good.by["3"].verdict, good.by.C2.verdict, good.by.C3.verdict], ["PASS", "PASS", "PASS", "PASS"]);
});

test("H1 scenario 3 reads no record COUNT (the status flush sends an aux request of its own that reaches the stub): 'the next agent was routed' is read from THAT agent's records", async () => {
  const f = fakeWorld({});
  const res = await S.runScenarios(f.prims, { only: ["3"] });
  assert.equal(res[0].result.verdict, "PASS", res[0].result.text);
  assert.ok(f.w.records.some((r) => r.headers["x-claude-code-agent-id"] === "uwsc-flush"), "the flush's aux request IS in the stub's records");
  assert.ok(f.w.records.some((r) => /uwsc-s3n-1$/.test(r.headers["x-claude-code-agent-id"] ?? "")), "and so is the next agent's request");
});

test("descentProof: a link is trusted only when the child is YOUNGER than its parent, both times are known, and every parent is in the table (a process behind cmd.exe is not proved)", () => {
  const t = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
  const rows = [{ pid: 1, ppid: 0, created: t(0) }, { pid: 2, ppid: 1, created: t(10) }, { pid: 3, ppid: 2, created: t(20) }];
  assert.equal(S.descentProof(rows, 3, 1).ok, true);
  assert.equal(S.descentProof([...rows.slice(0, 2), { pid: 3, ppid: 2, created: t(5) }], 3, 1).ok, false, "created before its parent");
  assert.equal(S.descentProof([...rows.slice(0, 2), { pid: 3, ppid: 2, created: t(10) }], 3, 1).ok, false, "created at the SAME time is not later");
  assert.match(S.descentProof([rows[0], { pid: 3, ppid: 2, created: t(20) }], 3, 1).why, /parent 2 is not in the process table .*cmd\.exe/);
  assert.match(S.descentProof([rows[0], { pid: 2, ppid: 1 }], 2, 1).why, /creation time is missing/);
  assert.equal(S.descentProof(rows, 1, 1).ok, false, "a pid does not descend from itself");
});

test("the PowerShell of the real stop and probe PARSES (never run here), identifies before it kills, and compares the creation time, the command line and the handle's start time; the pure parsers read their outputs", async () => {
  const E = await import("../harness/subagent-e2e.mjs");
  const stop = E.PS_STOP_VERIFIED(1234);
  const at = (s) => stop.indexOf(s);
  assert.ok(at("Get-Process -Id $id") >= 0 && at("IDENTITY: creation time differs") > at("Get-Process") && at("IDENTITY: command line differs") > 0 && at("IDENTITY: the handle is another process") > 0, "a handle is taken and the snapshot compared");
  assert.ok(at("$p.Kill()") > at("IDENTITY: the handle is another process") && at("$p.Kill()") > at("IDENTITY: command line differs") && at("$p.Kill()") > at("IDENTITY: creation time differs"), "every identity check comes BEFORE the kill");
  assert.ok(at("WaitForExit") > at("$p.Kill()") && at("NOT_GONE") > 0 && stop.endsWith("'KILLED'"), "the exit is awaited and confirmed, a failure throws; no SilentlyContinue");
  assert.ok(!/SilentlyContinue/.test(stop) && /ErrorActionPreference = 'Stop'/.test(stop));
  assert.deepEqual([E.parseProbe("PID:42"), E.parseProbe("NONE"), E.parseProbe("FAIL"), E.parseProbe("")], [{ ok: true, pid: 42 }, { ok: true, pid: null }, { ok: false }, { ok: false }], "a failed probe is not 'no listener'");
  assert.deepEqual(E.parseAncestors("5,6,7"), [5, 6, 7]); assert.deepEqual(E.parseAncestors(""), []); assert.throws(() => E.parseAncestors("5,x"), /unreadable/);
  const { execFileSync } = await import("node:child_process");
  const PS = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!fs.existsSync(PS)) return;                                                          // not Windows: the text checks above are all there is
  for (const text of [stop, E.PS_PROBE_LISTENER(3456), E.PS_ANCESTORS(1234)]) {
    const out = execFileSync(PS, ["-NoProfile", "-NonInteractive", "-Command", "$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:UW_TEXT, [ref]$t, [ref]$e); if ($e.Count) { 'ERR ' + $e[0].Message } else { 'PARSE_OK' }"], { encoding: "utf8", env: { ...process.env, UW_TEXT: text } }).trim();
    assert.equal(out, "PARSE_OK", text.slice(0, 40));
  }
});

test("H2 'cooling is empty' precondition: a scenario that needs a clean cooling list refuses to run on a leak, naming it as state of an earlier scenario, not a router verdict", async () => {
  const f = fakeWorld({ resetIneffective: true });
  const res = await S.runScenarios(f.prims, {});
  const by = Object.fromEntries(res.map((r) => [r.scn.id, r.result]));
  for (const id of ["2", "3", "7", "10", "11"]) { assert.equal(by[id].verdict, "FAIL", `${id}: ${by[id].text}`); assert.match(by[id].text, /precondition of scenario .*: cooling is not empty \(.*m-free.*\).*not a router verdict/, id); }
  for (const id of ["1", "4", "5", "6", "8", "9", "C1", "C2", "C3"]) assert.equal(by[id].verdict, "PASS", `${id}: ${by[id].text}`);
});

test("H3 MAIN FIRST: scenarios 3 and 10 keep main OUTSIDE the policy's rows (main's own model comes first when it is a row and would hide the steering and the spread); 2 and 7 keep it in on purpose; the plan says so", async () => {
  const seen = {};
  for (const id of ["2", "3", "7", "10"]) {
    const f = fakeWorld({}), pol = [], mains = [];
    const prims = { ...f.prims, policy: async (p) => { pol.push(p); return f.prims.policy(p); }, send: async (shape, o) => { if (shape === "main") mains.push(o.model); return f.prims.send(shape, o); } };
    await S.runScenarios(prims, { only: [id] });
    seen[id] = { main: [...new Set(mains)], rows: new Set(pol.flatMap((p) => p.models.map((m) => m.s))) };
  }
  for (const id of ["3", "10"]) assert.ok(seen[id].main.every((m) => !seen[id].rows.has(m)), `scenario ${id}: main ${seen[id].main} is not a row (${[...seen[id].rows]})`);
  assert.deepEqual(seen["10"].main, ["uwstub/m-lead"]);
  for (const id of ["2", "7"]) assert.ok(seen[id].main.some((m) => seen[id].rows.has(m)), `scenario ${id} keeps main in the set on purpose`);
  const plan = S.planLines().join("\n");
  assert.match(plan, /MAIN COMES FIRST: when main's own model is a row of the policy the router substitutes \(and hands off to\) main's model before it spreads/);
  assert.match(plan, /Scenarios 3 and 10 therefore keep main OUTSIDE the set/); assert.match(plan, /owner decision still open/);
  assert.match(S.SCENARIOS.find((s) => s.id === "10").proves, /with main outside the set/);
});

test("H3 the fan-out judge refuses a world where main IS in the set: every agent lands on main's model, outside the lead band (the replay's failure, now a named FAIL)", async () => {
  const f = fakeWorld({});
  await f.prims.policy(S.scenarioPolicy({ rows: [{ name: "m-free", b: 0 }, { name: "m-big", b: 0 }, { name: "m-main", b: 1 }] }));
  f.prims.stub.setScript({});
  await f.prims.send("main", { model: "uwstub/m-main", session: "x" });
  const a = [];
  for (let i = 0; i < 20; i++) { const aid = `f${i}`; const r = await f.prims.send("sub", { model: "uwstub/m-main", tag: "uwstub/m-gone", agentId: aid, session: "x", messages: 3, agentTool: false }); a.push({ aid, status: r.status, ret: f.w.records.filter((q) => q.headers["x-claude-code-agent-id"] === aid)[0]?.model }); }
  const ev = { a, b: a, band: ["uwstub/m-free", "uwstub/m-big"], otherBand: ["uwstub/m-main"], cooled: ["uwstub/m-free"] };
  assert.equal(ok("10", ev).verdict, "FAIL"); assert.match(ok("10", ev).text, /20 of 20 agents were served outside the lead band/);
});

test("H4 scenario 3 cools exactly ONE model before the all-limited step (two distinct failing models of the one sandbox provider would also cool the provider key), then ONE agent meets 429 on every model", async () => {
  const f = fakeWorld({});
  const sent = [];
  const prims = { ...f.prims, send: async (shape, o) => { sent.push({ shape, aid: o.agentId, model: o.model, retry: o.retryCount }); return f.prims.send(shape, o); } };
  const res = await S.runScenarios(prims, { only: ["3"] });
  assert.deepEqual(f.w.policy.models.map((m) => m.s), ["uwstub/m-free", "uwstub/m-big"], "two rows, main is not one of them");
  assert.equal(sent.filter((x) => /s3w/.test(x.aid ?? "")).length, 2, "step 1: ONE agent, one 429 and its retry");
  assert.equal(sent.filter((x) => x.aid === "uwsc-s3-1").length, 5, "step 2: ONE agent, five requests (at most 8 are allowed)");
  assert.equal(res[0].result.verdict, "PASS", res[0].result.text);
});

test("H5 scenario 11: after the overlay record is fed the suite waits more than the router's one-second re-read BEFORE the first measured agent; without the wait the agents are not steered (FINDING)", async () => {
  const f = fakeWorld({});
  const r = await S.runScenarios(f.prims, { only: ["11"] });
  assert.equal(r[0].result.verdict, "DEGRADED", r[0].result.text);
  const waits = [];
  const g = fakeWorld({});
  const lazy = await S.runScenarios({ ...g.prims, sleep: async (ms) => { waits.push(ms); } }, { only: ["11"] });          // a harness whose wait does nothing: the overlay never became effective
  assert.equal(lazy[0].result.verdict, "FINDING", lazy[0].result.text);
  assert.ok(waits.some((ms) => ms >= 1100), `the runner asked for a wait of at least 1.1 s (${waits})`);
});

test("H7 C3 reports through the JOURNAL path whatever the router's log descriptor does (a router held open since an earlier scenario hides logDropped, but a new session's journal is always opened afresh, so journalFail counts); a router that counts nothing FAILs; the judge accepts journalFail OR logDropped", async () => {
  const good = await S.runScenarios(fakeWorld({}).prims, { only: ["C3"] });
  assert.equal(good[0].result.verdict, "PASS", good[0].result.text); assert.match(good[0].result.text, /journalFail \+3/);
  const g = fakeWorld({}); g.w.logFd = true;                                                         // the descriptor of an earlier scenario is still open
  const held = await S.runScenarios(g.prims, { only: ["C3"] });
  assert.equal(held[0].result.verdict, "PASS", held[0].result.text); assert.equal(g.w.counters.logDropped ?? 0, 0);
  const silent = await S.runScenarios(fakeWorld({ silentLogs: true }).prims, { only: ["C3"] });
  assert.equal(silent[0].result.verdict, "FAIL", silent[0].result.text); assert.match(silent[0].result.text, /logDropped 0 -> 0, journalFail 0 -> 0/);
  const base = { requests: [{ status: 200 }], status0: { counters: {}, warnings: [] } };
  assert.equal(ok("C3", { ...base, status1: { counters: { journalFail: 2 }, warnings: [] } }).verdict, "PASS", "journalFail alone is a report");
  assert.equal(ok("C3", { ...base, status1: { counters: { logDropped: 1 }, warnings: [] } }).verdict, "PASS");
  assert.equal(ok("C3", { ...base, status1: { counters: {}, warnings: [{ code: "LOG_DROPPED" }] } }).verdict, "PASS");
  assert.equal(ok("C3", { ...base, status1: { counters: {}, warnings: [] } }).verdict, "FAIL");
});

test("H6 C1 stamps the shapes the router writes, BEFORE the first request of each session (session ids no process has seen, so the router reads the main files on its memory miss); the judge names the request that failed with its status and error", async () => {
  const f = fakeWorld({});
  const writes = [], order = [];
  const prims = { ...f.prims, writeState: async (n, text) => { order.push(`write ${n}`); writes.push([n, text]); return f.prims.writeState(n, text); },
    send: async (shape, o) => { order.push(`send ${shape}`); return f.prims.send(shape, o); } };
  const r = await S.runScenarios(prims, { only: ["C1"] });
  assert.equal(r[0].result.verdict, "PASS", r[0].result.text);
  const firstSend = order.findIndex((x) => x.startsWith("send")), lastWrite = Math.max(...order.map((x, i) => (x.startsWith("write") ? i : -1)));
  assert.ok(firstSend >= 0, "requests were sent");
  assert.ok(lastWrite < order.indexOf("send sub"), "every stamp is written before the first subagent request");
  const main = writes.filter(([n]) => /^main-/.test(n)).map(([, t]) => JSON.parse(t)), cool = JSON.parse(writes.find(([n]) => n === "cooling.json")[1]);
  assert.ok(main.length === 2 && main.every((m) => typeof m.t === "string" && !Number.isNaN(Date.parse(m.t)) && m.model && m.beta1m === false), "main files: {model, beta1m, t: ISO string}");
  assert.ok(Date.parse(main[0].t) > 1_800_000_000_000 + 80000000 && Date.parse(main[1].t) < 1_800_000_000_000 - 170000000, "a day ahead and two days behind");
  const e = cool.models["uwstub/m-free"];
  assert.equal(cool.v, 1); assert.ok(["u", "l", "t", "n", "t0"].every((k) => Number.isFinite(e[k])) && e.u > e.t, "cooling.json: {v:1, models:{sel:{u,l,t,n,t0}}}");
  const bad = ok("C1", { requests: [{ label: "sub, future-stamped main", status: 200 }, { label: "main", status: null, error: "fetch failed" }], status0: { counters: {} }, status1: { counters: {} } });
  assert.equal(bad.verdict, "FAIL"); assert.match(bad.text, /1 of 2 request\(s\) failed .*main HTTP none \(fetch failed\)/);
});

test("scenario 7: the judge prints handoffNone, retry, the cooling list, the agent's answers and the pids so the next run isolates the cause", () => {
  const ev = { handoffSeen: false, pidBefore: 5, pidAfter: 6, setup: { handoffNone: 2, retry: 1, cooling: ["uwstub/m-free", "prov:uwstub"], answers: ["m-free:429", "m-free:429"] } };
  const r = ok("7", ev);
  assert.equal(r.verdict, "FAIL");
  for (const piece of ["handoffNone 2", "retry 1", "cooling [uwstub/m-free, prov:uwstub]", "m-free:429, m-free:429", "core pid 5 -> 6"]) assert.ok(r.text.includes(piece), `${piece} in: ${r.text}`);
  assert.match(ok("7", { handoffSeen: true, handedTo: "uwstub/m-main", afterModel: "uwstub/m-big", pidBefore: 5, pidAfter: 6, setup: ev.setup }).text, /served uwstub\/m-big, not the handed-off uwstub\/m-main: the handoff was not kept \(setup: handoffNone 2/);
  assert.equal(ok("7", { handoffSeen: true, handedTo: "uwstub/m-main", afterModel: "uwstub/m-main", pidBefore: 5, pidAfter: 6 }).verdict, "PASS");
});

test("scenario 5: the router's own decision log is the second witness of a sticky hit (the first hit writes an act:sticky line); no counter and no line is still a FAIL", () => {
  const ev = { aid: "uwsc-s5a-1", aidNew: "uwsc-s5b-1", firstModel: "uwstub/m-free", laterModel: "uwstub/m-free", switchedTo: "uwstub/m-big", agents: [{ aid: "uwsc-s5b-1", main: "uwstub/m-big" }], status0: { counters: { stickyHit: 0 } }, status1: { counters: { stickyHit: 0 } } };
  assert.equal(ok("5", ev).verdict, "FAIL"); assert.match(ok("5", ev).text, /stickyHit 0 -> 0[)] and its decision log has no sticky line/);
  assert.equal(ok("5", { ...ev, decisions: [{ act: "sticky", aid: "uwsc-s5a-1" }] }).verdict, "PASS");
  assert.equal(ok("5", { ...ev, decisions: [{ act: "sticky", aid: "someone-else" }] }).verdict, "FAIL", "another agent's line is no evidence");
  assert.equal(ok("5", { ...ev, status1: { counters: { stickyHit: 1 } } }).verdict, "PASS");
});

test("H4 the sandbox has ONE provider: two DISTINCT failing models cool the provider key too and demote every row, so six new agents are no longer steered to one model (the replay's scenario 3 failure); the shipped scenario cools exactly one", async () => {
  const f = fakeWorld({});
  await f.prims.policy(S.scenarioPolicy({ rows: ["m-free", "m-big"] }));
  f.prims.stub.setScript({ decide: (rec) => (rec.headers?.["x-claude-code-agent-id"] ? 429 : undefined) });                // EVERY model limited from the first agent on: the old step 1
  await f.prims.send("main", { model: ANCHOR, session: "x" });
  for (const n of [0, 1, 2]) await f.prims.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentTool: false, session: "x", agentId: "w", messages: 3, ...(n ? { retryCount: n } : {}) });
  assert.ok(["uwstub/m-free", "uwstub/m-big", "prov:uwstub"].every((k) => f.w.cooling.has(k)), [...f.w.cooling].join());
  const served = [];
  for (let i = 0; i < 6; i++) { const aid = `s${i}`; await f.prims.send("sub", { model: ANCHOR, tag: "uwstub/m-gone", agentTool: false, session: "x", agentId: aid, messages: 3 }); served.push(f.w.records.find((r) => r.headers["x-claude-code-agent-id"] === aid)?.model); }
  assert.ok(new Set(served).size > 1, `with every row demoted the agents spread over ${[...new Set(served)]}: the steering check could not hold`);
  const g = fakeWorld({});
  await S.runScenarios(g.prims, { only: ["3"] });
  assert.ok(g.w.cooling.has("uwstub/m-free") && g.w.cooling.has("uwstub/m-big"), "the shipped scenario ends with both cooled (step 2)");
});

// ====================================================================================== fix round 5 (the fifth replay run: the router lives in the sandbox DAEMON, so replacing the core worker never cleared its cooling; the reset writes newer, expired cooling records instead)
const state = async (name) => path.join((await import("../harness/subagent-sandbox-spec.mjs")).SCRATCH_STATE_DIR, name);

test("R5-1 reset clears the router's cooling of the failing model: deleting cooling.json clears NOTHING (the defect of run 5), the reset's newer-and-expired records do; the next failure starts at rung 0 again, and the provider key is NOT cooled by it", async () => {
  const v = await virtualSandbox(), w = prims(v);
  v.V.coolFail("uwstub/m-free");
  let s = await w.freshStatus();
  assert.deepEqual(s.cooling.map((x) => x.key), ["uwstub/m-free"], "the scenario left m-free cooling in the router");
  v.mem.delete(v.coolFile);                                                              // what the old reset did
  v.V.now += 6000; s = await w.freshStatus();
  assert.equal(s.cooling.length, 1, "deleting the file cleared nothing: the router holds cooling in memory");
  await w.reset();
  s = await w.freshStatus();
  assert.deepEqual(s.cooling, [], "after the reset the fresh status lists no cooling");
  v.V.coolFail("uwstub/m-free");
  const e = v.V.cool.get("uwstub/m-free");
  assert.equal(e.l, 0, "rung 0 again"); assert.equal(e.n, 1, "no streak carried over"); assert.equal(e.u - v.V.now, 2 * 60000, "a 2-minute cooldown, not the 10 minutes an escalated rung would give");
  assert.ok(!(v.V.cool.get("prov:uwstub")?.u > v.V.now), "the FIRST failure after a reset does not cool the provider key (no other model of the provider has a recent record)");
});

test("R5-2 what reset writes: v:1 records for uwstub/m-free and the provider key ONLY, each NEWER than now and EXPIRED more than an hour ago with n 1; shadow.flag and observed.json are removed; it waits 1.2 s for the router's one-second re-read; the seam has no RPC, guard or process function, so nothing is restarted or stopped", async () => {
  const v = await virtualSandbox(), w = prims(v);
  assert.deepEqual(Object.keys(v.d.sys).sort(), ["readText", "selfPid"]); assert.equal(v.d.rpc, undefined); assert.equal(v.d.guard, undefined);
  const flag = await state("shadow.flag"), obs = path.join(path.dirname(path.dirname(await state("x"))), "observed.json");
  v.mem.set(path.resolve(flag), "auto:X\n"); v.mem.set(path.resolve(obs), "{}");
  const t0 = v.V.now;
  await w.reset();
  assert.equal(v.V.now - t0, 1200, "exactly the 1.2 s wait");
  assert.equal(v.mem.has(path.resolve(flag)), false); assert.equal(v.mem.has(path.resolve(obs)), false);
  const f = JSON.parse(v.mem.get(v.coolFile));
  assert.equal(f.v, 1); assert.deepEqual(Object.keys(f.models).sort(), ["prov:uwstub", "uwstub/m-free"], "no record for m-big or m-main: a fresh t on another model of the provider would cool the whole provider on the first 429");
  for (const x of Object.values(f.models)) { assert.ok(x.t > t0, "newer than now"); assert.ok(t0 - x.u > 3600000, "expired by more than the one-hour streak window"); assert.equal(x.n, 1); assert.equal(x.l, 0); assert.ok(["u", "l", "t", "n", "t0"].every((k) => Number.isFinite(x[k]))); }
  await w.reset(); assert.equal(v.V.now - t0, 2400, "a reset costs 1.2 s whether or not the last scenario cooled anything; no process is ever restarted");
});

test("R5-2b the router's PROVIDER RULE (modelled): a reset that stamps a fresh t on the OTHER models too (run 6's defect) makes the first 429 cool the whole provider; the shipped reset does not; and a scenario that failed two models leaves a recent t that only TIME ages (5 minutes), no reset can", async () => {
  const bad = await virtualSandbox(), bw = prims(bad);
  const t = bad.V.now;
  bad.mem.set(bad.coolFile, JSON.stringify({ v: 1, models: Object.fromEntries(["uwstub/m-main", "uwstub/m-free", "uwstub/m-big", "prov:uwstub"].map((k) => [k, { u: t - 7200000, l: 0, t: t + 1000, n: 1, t0: t - 7200000 }])) }));
  await bw.freshStatus();
  bad.V.coolFail("uwstub/m-free");
  assert.ok(bad.V.cool.get("prov:uwstub").u > bad.V.now, "the broad reset: the provider key is cooled by the very first failure");
  const good = await virtualSandbox(), gw = prims(good);
  await gw.reset(); await gw.freshStatus(); good.V.coolFail("uwstub/m-free");
  assert.ok(!(good.V.cool.get("prov:uwstub")?.u > good.V.now), "the shipped reset: it is not");
  const many = await virtualSandbox(), mw = prims(many);
  many.V.coolFail("uwstub/m-free"); many.V.now += 60000; many.V.coolFail("uwstub/m-big");          // scenario 3: m-free in step 1, m-big in step 3 (the provider key is cooled by the second)
  await mw.reset(); await mw.freshStatus();
  many.V.coolFail("uwstub/m-free");
  assert.ok(many.V.cool.get("prov:uwstub").u > many.V.now, "right after: m-big's record is recent, the reset cannot age it, the next failure cools the provider");
  const gap = await virtualSandbox(), pw = prims(gap);
  gap.V.coolFail("uwstub/m-free"); gap.V.now += 60000; gap.V.coolFail("uwstub/m-big");
  gap.V.now += S.PROVIDER_QUIET_MS; await pw.reset(); await pw.freshStatus();
  gap.V.coolFail("uwstub/m-free");
  assert.ok(!(gap.V.cool.get("prov:uwstub")?.u > gap.V.now), "after the quiet gap it does not");
  assert.ok(S.PROVIDER_QUIET_MS > 5 * 60000, "more than the router's 5 minutes");
});

test("R5-3 a full suite run does 16 resets (15 scenarios plus the one between the two variants of scenario 2): about 20 s of waiting and NO core restart; a scenario that throws leaves nothing the next reset does not clear", async () => {
  const f = fakeWorld({}); let resets = 0;
  const prims2 = { ...f.prims, reset: async () => { resets += 1; return f.prims.reset(); } };
  const res = await S.runScenarios(prims2, {});
  assert.equal(res.length, 15); assert.equal(resets, 16);
  const g = fakeWorld({}); let n = 0;
  const throwing = { ...g.prims, send: async (shape, o) => { if (o.agentId === "uwsc-s2-1" && n++ === 0) throw new Error("boom"); return g.prims.send(shape, o); } };
  const out = await S.runScenarios(throwing, { only: ["2", "3"] });
  assert.equal(out[0].result.verdict, "FAIL"); assert.equal(out[1].result.verdict, "PASS", out[1].result.text);
});

test("R5-4 the scenario harness makes no RPC call, restarts nothing and stops no process: no editSandboxConfig, saveConfig, restartGateway, startGateway, restartWorker, freshWorker, markDirty or stop seam; killTree (the `claude -p` child it spawned itself) is the one allowed kill", async () => {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "harness", "subagent-scenarios.mjs");
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(/export function killTree/.test(raw), "the exception exists");
  const code = raw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").replace(/\n\s*"how the scenarios read the router[^\n]*/, "")
    .replace(/export function killTree\([^\n]*\n[\s\S]*?\n\}\n/, "");     // killTree is cut out before the scan, so a second kill anywhere else is still caught
  assert.ok(!/process\.kill|Stop-Process|stopProcess|stopVerified|stopRefusals|descendantsLeafFirst|listenPortsOf|editSandboxConfig|saveConfig|restartWorker|freshWorker|markDirty|["'`]restartGateway["'`]|["'`]startGateway["'`]|\.rpc\(/.test(code));
  assert.match(S.planLines().join("\n"), /The suite restarts NOTHING and stops NO process\. The router runs inside the sandbox DAEMON/);
  assert.doesNotMatch(S.planLines().join("\n"), /STOP of the sandbox's core worker|two saves and two core respawns/);
});

test("R5-5 a provider with autoFetchModels refuses in the isolation guard (CCR would arm a model auto-refresh whose config-change hook runs the global profile apply); the stub provider as the harness creates it (autoFetchModels false, or absent) still passes", async () => {
  const guard = await import("../harness/guard.mjs");
  const { GATEWAY_PORT, GATEWAY_CORE_PORT, SCRATCH_SETTINGS } = await import("../harness/config.mjs");
  const { SCRATCH_ROUTER, SANDBOX_PORTS } = await import("../harness/subagent-sandbox-spec.mjs");
  const cfg = { gateway: { host: "127.0.0.1", port: GATEWAY_PORT, corePort: GATEWAY_CORE_PORT }, HOST: "127.0.0.1", PORT: GATEWAY_PORT, CUSTOM_ROUTER_PATH: SCRATCH_ROUTER,
    Providers: [{ name: "uwstub", api_base_url: `http://127.0.0.1:${SANDBOX_PORTS.stub}`, models: ["m-main"] }],
    profile: { enabled: true, claudeCode: { settingsFile: SCRATCH_SETTINGS }, profiles: [{ id: "p", agent: "claude-code", enabled: true, scope: "global", settingsFile: SCRATCH_SETTINGS }] } };
  assert.doesNotThrow(() => guard.assertPayloadIsolated(cfg, { allowProviders: true }), "no flag: passes");
  cfg.Providers[0].autoFetchModels = false;
  assert.doesNotThrow(() => guard.assertPayloadIsolated(cfg, { allowProviders: true }), "false (as the e2e stub provider is written): passes");
  for (const flag of [true, 1, "yes"]) { const bad = structuredClone(cfg); bad.Providers[0].autoFetchModels = flag; assert.throws(() => guard.assertPayloadIsolated(bad, { allowProviders: true }), /autoFetchModels set/, String(flag)); }
  const second = structuredClone(cfg); second.Providers.push({ name: "uwstub2", autoFetchModels: true });
  assert.throws(() => guard.assertPayloadIsolated(second, { allowProviders: true }), /provider "uwstub2" has autoFetchModels set/, "any provider, not only the first");
  assert.ok(/autoFetchModels: false/.test(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "harness", "subagent-e2e.mjs"), "utf8")), "the e2e stub provider is written with autoFetchModels false");
});

test("R5-6 run order: scenario 3 (the only one that fails two models) runs after every other scenario that fails a model, the result lines follow that order, every scenario still runs once, and a full run never waits for the quiet gap", async () => {
  assert.deepEqual([...S.RUN_ORDER].sort(), S.ALL.map((x) => x.id).sort(), "every scenario appears exactly once");
  const at = (id) => S.RUN_ORDER.indexOf(id);
  for (const id of S.FAILS_MODEL.filter((x) => x !== "3")) assert.ok(at(id) < at("3"), `${id} runs before 3`);
  assert.deepEqual([...S.FAILS_MANY], ["3"]); assert.ok(S.FAILS_MODEL.every((id) => S.ALL.some((x) => x.id === id)));
  assert.ok(S.RUN_ORDER.slice(at("3") + 1).every((id) => !S.FAILS_MODEL.includes(id)), "nothing that fails a model runs after 3");
  const f = fakeWorld({}); let t = 1_800_000_000_000; const slept = [], notes = [];
  const clock = { ...f.prims, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; return f.prims.sleep(ms); }, note: (m) => notes.push(m) };
  const lines = []; const res = await S.runScenarios(clock, {}, (l) => lines.push(l));
  assert.deepEqual(res.map((r) => r.scn.id), [...S.RUN_ORDER]);
  assert.deepEqual(lines.map((l) => S.parseScenarioLine(l).id), [...S.RUN_ORDER]);
  assert.equal(notes.filter((m) => /quiet gap/.test(m)).length, 0, "no quiet gap in a full run");
  assert.ok(!slept.some((ms) => ms >= 30000), "and no long sleep");
});

test("R5-7 quiet gap: a scenario that fails a model and starts less than 5.5 minutes after the end of scenario 3 waits out the REST (from the clock, not a fixed sleep), with a progress line every 30 s; nothing waits when enough time has passed or when the next scenario fails no model", async () => {
  const run = async (opts, between = 0) => {
    const f = fakeWorld({}); let t = 1_800_000_000_000, calls = 0; const slept = [], notes = [];
    const clock = { ...f.prims, now: () => t + (++calls >= 2 ? between : 0), sleep: async (ms) => { slept.push(ms); t += ms; }, note: (m) => notes.push(m) };      // the 2nd clock reading is the one at the start of the next run: `between` is the time that passed since the end of the last one
    const res = await S.runScenarios(clock, opts);
    return { res, slept, notes };
  };
  const two = await run({ only: ["3"], runs: 2 });
  assert.equal(two.res[0].result.verdict, "PASS", two.res[0].result.text);
  const gaps = two.slept.filter((ms) => ms >= 5000);
  assert.ok(gaps.reduce((a, b) => a + b, 0) >= S.PROVIDER_QUIET_MS - 1000 && gaps.reduce((a, b) => a + b, 0) <= S.PROVIDER_QUIET_MS + 60000, `second run waited about ${S.PROVIDER_QUIET_MS / 1000} s (${gaps})`);
  assert.ok(two.slept.filter((ms) => ms === 30000).length >= 9, "30 s steps");
  assert.ok(two.notes.some((m) => /^quiet gap before scenario 3: .*330 s/.test(m)) && two.notes.filter((m) => /^quiet gap: \d+ s of \d+ s$/.test(m)).length >= 9, "progress lines");
  const enough = await run({ only: ["3"], runs: 2 }, S.PROVIDER_QUIET_MS);                       // the clock already moved past the quiet time between the runs
  assert.equal(enough.notes.filter((m) => /quiet gap/.test(m)).length, 0, "enough time passed: no wait");
  const part = await run({ only: ["3"], runs: 2 }, 200000);                                       // 200 s already passed: only the rest is waited
  const rest = part.slept.filter((ms) => ms >= 5000).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(rest - (S.PROVIDER_QUIET_MS - 200000)) < 60000, `the rest only (${rest})`);
  const noFail = await run({ only: ["3", "C2", "C4"] });                                          // C2 and C4 run AFTER 3 and fail no model: no wait
  assert.equal(noFail.notes.filter((m) => /quiet gap/.test(m)).length, 0);
  const after = await run({ only: ["7", "3"] });                                                   // 7 runs first by the order: no wait
  assert.equal(after.notes.filter((m) => /quiet gap/.test(m)).length, 0);
});

// ====================================================================================== fix round 6 (the first REAL-client run: no subagent was ever spawned)
const agentTool = { name: "Agent", description: "Launch a new agent", input_schema: { type: "object", properties: { description: { type: "string" }, prompt: { type: "string" }, subagent_type: { type: "string" } }, required: ["description", "prompt"] } };
const userMsg = (text) => ({ role: "user", content: [{ type: "text", text }] });
const post = async (port, body, headers = {}) => { const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };

test("R6-1 the stub tells the turns of a REAL client apart without keeping a word of them: userMarkers (a boolean per marker, looked for in the messages), toolResults (a count) and sent.kind; a bad userMarkers script is refused", async () => {
  const stub = createStub({ port: 0 }), port = await stub.start();
  try {
    stub.setScript({ userMarkers: ["delegate a trivial task"] });
    await post(port, { model: "m", tools: [agentTool], messages: [userMsg("Use the Agent tool once to delegate a trivial task, then reply done.")] });
    await post(port, { model: "m", tools: [agentTool], messages: [userMsg("something else"), { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Agent", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }, { type: "tool_result", tool_use_id: "t2", content: "x" }] }] });
    const [a, b] = stub.records;
    assert.deepEqual(a.userMarkers, { "delegate a trivial task": true }); assert.equal(a.toolResults, 0); assert.equal(a.sent.kind, "text");
    assert.deepEqual(b.userMarkers, { "delegate a trivial task": false }); assert.equal(b.toolResults, 2);
    assert.ok(!JSON.stringify(a).includes("then reply done") && !JSON.stringify(a).includes("something else"), "no message text is kept");
  } finally { await stub.stop(); }
  for (const bad of [["x".repeat(65)], [""], Array.from({ length: 9 }, (_, i) => `m${i}`), "nope", [1]]) assert.throws(() => createStub({ port: 0, script: { userMarkers: bad } }), /userMarkers must be at most 8 strings of 1\.\.64 characters/);
});

test("R6-2 the scripted spawn is decided by the TURN: the user's turn with no tool_result gets an Agent tool call (a retry of it the same), a warm-up or any other request gets text, the request that carries the Agent's tool_result gets text; firstRequestOfEachAgent limits only the first request of each agent id", () => {
  const sc = S.realScript("s1", { decide: S.firstRequestOfEachAgent(429) });
  assert.deepEqual(sc.userMarkers, ["delegate a trivial task"]); assert.match(S.REAL_PROMPT, /delegate a trivial task/);
  const turn = (o) => sc.onMain({ userMarkers: { "delegate a trivial task": true }, toolResults: 0, ...o });
  assert.deepEqual(turn({}), { subagent_type: "general-purpose", label: "s1" });
  assert.deepEqual(turn({}), { subagent_type: "general-purpose", label: "s1" }, "a retry of the same request is answered the same way (the old once-only flag answered it with text)");
  assert.equal(turn({ toolResults: 1 }), undefined, "the request that carries the Agent's result");
  assert.equal(sc.onMain({ userMarkers: { "delegate a trivial task": false }, toolResults: 0 }), undefined, "a warm-up or helper request without the user's prompt");
  assert.equal(sc.onMain({}), undefined);
  const d = S.firstRequestOfEachAgent({ status: 429, retryAfter: 3600 }), h = (a) => ({ headers: a ? { "x-claude-code-agent-id": a } : {} });
  assert.deepEqual(d(h("a1")), { status: 429, retryAfter: 3600 }); assert.equal(d(h("a1")), undefined, "its retry"); assert.deepEqual(d(h("a2")), { status: 429, retryAfter: 3600 }); assert.equal(d(h(null)), undefined, "the main request");
});

test("R6-3 against the REAL stub, streamed and not: the user's turn is answered with a well-formed Agent tool_use (name, description, prompt, subagent_type, a UWGT marker; SSE with input_json_delta that parses), the warm-up request gets text and does not use the spawn up, a retry gets the tool_use again, the request with the tool_result gets text", async () => {
  const stub = createStub({ port: 0 }), port = await stub.start();
  try {
    stub.setScript(S.realScript("s1"));
    const turn = [userMsg(S.REAL_PROMPT)];
    const warm = await post(port, { model: "m", max_tokens: 1, tools: [agentTool], messages: [userMsg("warm up")] });
    assert.equal(JSON.parse(warm.text).stop_reason, "end_turn", "a request without the user's prompt: text");
    for (const attempt of [1, 2]) {
      const j = JSON.parse((await post(port, { model: "m", tools: [agentTool], messages: turn })).text);
      assert.equal(j.stop_reason, "tool_use", `attempt ${attempt}`);
      const tu = j.content.find((b) => b.type === "tool_use");
      assert.equal(tu.name, "Agent"); assert.ok(tu.id && tu.input.description && tu.input.prompt && tu.input.subagent_type === "general-purpose");
      assert.match(tu.input.prompt, /^UWGT:s1:\d+\n/);
    }
    const sse = (await post(port, { model: "m", stream: true, tools: [agentTool], messages: turn })).text;
    const events = sse.split("\n\n").filter(Boolean).map((e) => ({ type: /^event: (.+)$/m.exec(e)[1], data: JSON.parse(/^data: (.+)$/m.exec(e)[1]) }));
    assert.deepEqual(events.map((e) => e.type), ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
    assert.equal(events[1].data.content_block.type, "tool_use"); assert.equal(events[1].data.content_block.name, "Agent");
    const input = JSON.parse(events[2].data.delta.partial_json);
    assert.ok(input.description && input.prompt && input.subagent_type); assert.equal(events[4].data.delta.stop_reason, "tool_use");
    const back = [...turn, { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Agent", input }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }];
    assert.equal(JSON.parse((await post(port, { model: "m", tools: [agentTool], messages: back })).text).stop_reason, "end_turn", "after the tool_result: text");
    assert.deepEqual(stub.records.map((r) => r.sent.kind), ["text", "tool_use", "tool_use", "tool_use", "text"]);
  } finally { await stub.stop(); }
});

test("R6-4 when no subagent request comes, the verdict says what the client DID: the stub's request shapes (agent or main, tool count, +Agent, model, status, reply kind) and the client's own report (exit, subtype, turns, the NAMES of denied tools, the first words of its answer); claudeInfo reads claude's JSON and survives anything else", () => {
  const rec = (o) => ({ method: "POST", path: "/v1/messages", headers: {}, toolNames: [], model: "uwstub/m-main", sent: { status: 200, kind: "text" }, toolResults: 0, ...o });
  const records = [...Array.from({ length: 11 }, () => rec({ toolNames: Array.from({ length: 18 }, (_, i) => (i === 0 ? "Agent" : `T${i}`)) })), rec({ sent: { status: 200, kind: "tool_use" }, toolNames: ["Agent"] }), rec({ toolNames: ["Agent"], toolResults: 1 })];
  assert.equal(S.shapeDigest(records), "11x main/18 tools+Agent/m-main/200 text; 1x main/1 tools+Agent/m-main/200 tool_use; 1x main/1 tools+Agent/m-main/200 text (1 tool_result)");
  const claude = S.claudeInfo({ code: 0, text: JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 2, result: "done", permission_denials: [{ tool_name: "Agent", tool_input: { prompt: "SECRET" } }] }), err: "" });
  assert.deepEqual(claude, { code: 0, reason: "", err: "", subtype: "success", isError: false, turns: 2, denials: ["Agent"], mode: "", reasons: [], called: [], result: "done" });
  assert.ok(!JSON.stringify(claude).includes("SECRET"), "denied tool NAMES only, never an input");
  assert.deepEqual(S.claudeInfo({ code: 1, text: "not json \u0001", err: "boom", reason: "timed out" }), { code: 1, reason: "timed out", err: "boom", subtype: "", isError: null, turns: null, denials: [], mode: "", reasons: [], called: [], result: "not json ?" });
  assert.equal(S.claudeInfo(null), null);
  const ev = { records, claude, policy: "uwstub/m-free", asked: "uwstub/m-main" };
  const r1 = ok("1", ev); assert.equal(r1.verdict, "FAIL"); assert.match(r1.text, /the spawn never happened, nothing is proved \(stub saw 11x main\/18 tools\+Agent\/m-main\/200 text; .*the client: exit 0, success, turns 2, permission mode unknown, denied tools \[Agent\], answer "done"/);
  assert.match(ok("2", { ...ev, aid: "", chosen: "uwstub/m-free" }).text, /the client never spawned the agent, so no 429 was provoked \(stub saw 11x main/);
  assert.match(ok("3", { ...ev, aid: "", steer: { models: ["uwstub/m-big", "uwstub/m-big", "uwstub/m-big"], healthy: "uwstub/m-big", cooled: ["uwstub/m-free"] } }).text, /the real client never spawned the agent that was to meet the limit, so nothing was limited \(stub saw/);
  assert.match(ok("11", { ...ev, failed: false }).text, /scenario is not set up \(stub saw/);
});

test("R6-5 the REAL scenarios against a fake client: scenario 3 names the agent the real client spawned BEFORE the synthetic next agent exists (a client that spawns nothing is 'never spawned', not a handoffNone mystery); scenario 2 keeps main out of the rows and limits the agent's FIRST request, whichever row it landed on; scenario 11 limits and steers away from the row the agent landed on", async () => {
  const lazy = fakeWorld({}); lazy.prims.claude = async () => ({ code: 0, text: JSON.stringify({ subtype: "success", num_turns: 1, result: "done" }) });
  const r3 = await S.runScenarios(lazy.prims, { only: ["3"], real: true });
  assert.equal(r3[0].result.verdict, "FAIL"); assert.match(r3[0].result.text, /the real client never spawned the agent that was to meet the limit/); assert.match(r3[0].result.text, /the client: exit 0, success, turns 1/);
  const f = fakeWorld({}), rows = [];
  const origPolicy = f.prims.policy; f.prims.policy = async (p) => { rows.push(p.models.map((m) => m.s)); return origPolicy(p); };
  const client = (w, retry = true) => async () => {
    const script = w.w.script;
    assert.ok(script.onMain(userTurn(script)), "the real script spawns on the user's turn");
    await w.prims.send("main", { model: ANCHOR, session: "real-s" });
    const sub = (over) => w.prims.send("sub", { model: ASKED_MODEL, tag: "uwstub/m-big", agentId: "real-agent", session: "real-s", messages: 3, agentTool: false, ...over });
    await sub({}); if (retry) await sub({ retryCount: 1 });                                   // a daily cap (Retry-After 3600) fails the agent at once: no retry
    return { code: 0, text: JSON.stringify({ subtype: "success", num_turns: 3, result: "done" }) };
  };
  f.prims.claude = client(f);
  const r2 = await S.runScenarios(f.prims, { only: ["2"], real: true });
  assert.ok(rows.some((r) => r.join() === "uwstub/m-free,uwstub/m-big"), `the real scenario 2 policy has two rows and no m-main (${rows.map((r) => r.join("|"))})`);
  assert.match(r2[0].result.text, /429 on uwstub\/m-big/, `the limited model is the one the agent landed on: ${r2[0].result.text}`);
  const g = fakeWorld({}), fed = [];
  const origFeed = g.prims.feedOverlay; g.prims.feedOverlay = async (m, st) => { fed.push(m); return origFeed(m, st); };
  g.prims.claude = client(g, false);
  const r11 = await S.runScenarios(g.prims, { only: ["11"], real: true });
  assert.deepEqual(fed, ["uwstub/m-big"], "the overlay marks the model the real agent landed on, not a fixed m-free");
  assert.equal(r11[0].result.verdict, "DEGRADED", r11[0].result.text);
});

// ====================================================================================== fix round 7 (run 10: the real client DENIED the subagent tool: its rule is named Task, the allowlist said Agent)
const FULL = { settingSources: true, strictMcp: true, dontAsk: true, streamJson: true };
const claudeArgs = (supports = FULL) => S.claudeInvocation({ prompt: S.REAL_PROMPT, maxTurns: 4, key: "sandbox-key", launchEnv: { PATH: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\cmd.exe" }, scratchRoot: path.join(os.tmpdir(), "uw-scn-scratch"), supports }).args;

test("R7-1 the real client's argv carries EXACTLY one narrow allowance: --allowedTools Task,Agent (the subagent tool under both names), the default permission mode, and no bypass of any kind; the list is one token so the variadic flag cannot swallow a later flag or the prompt", () => {
  assert.deepEqual([...S.REAL_ALLOWED_TOOLS], ["Task", "Agent"]);
  for (const supports of [FULL, {}]) {
    const a = claudeArgs(supports);
    assert.equal(a.filter((x) => x === "--allowedTools").length, 1, "one allowlist");
    assert.equal(a[a.indexOf("--allowedTools") + 1], "Task,Agent");
    assert.deepEqual(a.slice(0, 2), ["-p", S.REAL_PROMPT], "the prompt is the -p positional, ahead of every variadic flag");
    const after = a.slice(a.indexOf("--allowedTools") + 2);
    assert.ok(after.every((x) => /^--(setting-sources|strict-mcp-config)$|^user$/.test(x)), `only the isolation flags follow: ${after}`);
    for (const x of a) assert.ok(!/bypass|acceptEdits|dangerously|disallowed|\*|Bash|Edit|Write|Read|\(/i.test(x.replace(S.REAL_PROMPT, "")), `no bypass, no wider tool in ${x}`);
    const modes = a.filter((x, i) => a[i - 1] === "--permission-mode");
    assert.deepEqual(modes, supports.dontAsk ? ["dontAsk"] : [], "the ONE permission mode is dontAsk (deny what no rule allows), and only when the launcher lists it");
    assert.deepEqual(a.filter((x) => x === "--permission-mode").length, supports.dontAsk ? 1 : 0);
    assert.deepEqual(supports.streamJson ? ["stream-json", "--verbose"] : ["json"], supports.streamJson ? [a[a.indexOf("--output-format") + 1], a[a.indexOf("--output-format") + 2]] : [a[a.indexOf("--output-format") + 1]], "the event stream when the launcher has it");
  }
  assert.ok(S.REAL_ALLOWED_TOOLS.every((t) => /^[A-Za-z]+$/.test(t)), "plain tool names: no pattern, no argument rule");
});

/** The source-level ban on a permission bypass: comments stripped (block comments only when they open a line, so a string holding the opener cannot hide code), nothing else: a quoted line is scanned like any other. */
const BAN = /--dangerously-skip-permissions|--allow-dangerously-skip-permissions|bypassPermissions|acceptEdits|--permission-mode=|defaultMode|['"`](auto|plan|manual)['"`]|permissionMode\s*[:=]/i;
const codeOf = (src) => src.replace(/(^|\n)[ \t]*\/\*[\s\S]*?\*\//g, "$1").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const banned = (src) => BAN.test(codeOf(src).replace(/mode: clip\(e\.permissionMode[^\n]*/g, ""));

test("R7-2 source level: the harness never passes a bypass or any permission mode but dontAsk, names --allowedTools and --permission-mode in exactly one place each; the plan states the allowance and says the stub's subagent answer is text only", () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "harness");
  let modeFlags = 0;
  for (const f of ["subagent-scenarios.mjs", "subagent-e2e.mjs", "subagent-sandbox-spec.mjs", "stub-upstream.mjs"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8"), code = codeOf(src);
    assert.ok(!banned(src), `${f}: no bypass and no other permission mode`);
    modeFlags += (code.match(/--permission-mode/g) ?? []).length;
    if (f === "subagent-scenarios.mjs") {
      assert.equal((code.match(/"--allowedTools"/g) ?? []).length, 1, "one --allowedTools in the code");
      assert.match(code, /export const REAL_PERMISSION_MODE = "dontAsk";/);
    }
  }
  assert.equal(modeFlags, 1, "the string --permission-mode occurs ONCE in all the harness code, and it is the one quoted token of claudeInvocation");
  const plan = S.planLines().join("\n");
  assert.match(plan, /the mode dontAsk .* plus ONE narrow allowance, --allowedTools Task,Agent/); assert.match(plan, /every other tool stays denied, no other permission mode and no bypass of any kind is ever passed, the stub answers a spawned subagent with text only/);
  assert.match(plan, /stream-json with --verbose.*first 200 characters of each failed tool result \(redacted\)/);
  assert.match(plan, /run 10 saw the client deny the spawn/);
});

test("R7-3 a verdict that PASSED still names the tools the real client had denied (names only), a clean client and a replay add nothing; a FAIL keeps the full diagnostic suffix", async () => {
  const mk = (denials) => { const f = fakeWorld({}); f.prims.claude = async () => { await f.prims.send("main", { model: ANCHOR, session: "real-s" }); await f.prims.send("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "real-agent", session: "real-s", messages: 3, agentTool: false });
    return { code: 0, text: JSON.stringify({ subtype: "success", num_turns: 2, result: "done", permission_denials: denials.map((n) => ({ tool_name: n, tool_input: { command: "SECRET" } })) }) }; }; return f; };
  const denied = await S.runScenarios(mk(["Bash", "Read"]).prims, { only: ["1"], real: true });
  assert.equal(denied[0].result.verdict, "PASS", denied[0].result.text);
  assert.match(denied[0].result.text, /\[the real client had these tools denied: Bash, Read\]$/); assert.ok(!denied[0].result.text.includes("SECRET"));
  const clean = await S.runScenarios(mk([]).prims, { only: ["1"], real: true });
  assert.equal(clean[0].result.verdict, "PASS"); assert.ok(!/denied/.test(clean[0].result.text));
  const replay = await S.runScenarios(fakeWorld({}).prims, { only: ["1"] });
  assert.ok(!/denied/.test(replay[0].result.text));
  const task = mk(["Task"]); task.prims.claude = async () => ({ code: 0, text: JSON.stringify({ subtype: "success", num_turns: 2, result: "stub-ok", permission_denials: [{ tool_name: "Task" }] }) });
  const fail = await S.runScenarios(task.prims, { only: ["1"], real: true });
  assert.equal(fail[0].result.verdict, "FAIL"); assert.match(fail[0].result.text, /the client: exit 0, success, turns 2, permission mode unknown, denied tools \[Task\], answer "stub-ok"/, "run 10's line");
});

// ====================================================================================== fix round 8 (run 11: still denied; the verdict must say WHY, and the permission mode the client ran in)
const SANDBOX_KEY = "ccr-profile-0123456789abcdefABCDEF01";
const streamLines = [
  { type: "system", subtype: "init", permissionMode: "auto", tools: ["Task", "Bash", "Read", "Edit"], model: "m" },
  { type: "assistant", message: { content: [{ type: "text", text: "I will delegate" }, { type: "tool_use", id: "toolu_1", name: "Task", input: { prompt: "SECRET PROMPT", description: "d" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "Claude requested permissions to use Task, but you haven't granted it yet." }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "echo SECRET INPUT" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: [{ type: "text", text: `denied by the auto mode classifier; key ${SANDBOX_KEY} x-api-key: abcdefghijklmnop` }] }] } },
  { type: "result", subtype: "success", is_error: false, num_turns: 2, result: "stub-ok", permission_denials: [{ tool_name: "Task", tool_use_id: "toolu_1", tool_input: { prompt: "SECRET PROMPT" } }] },
].map((o) => JSON.stringify(o)).join("\n") + "\n";

test("R8-1 the stream reducer: line by line across arbitrary chunk boundaries, it keeps the permission mode, the tool count, the NAMES of the tools called, the first 200 characters of each failed tool_result (redacted, the sandbox key masked) and the result; never a prompt, an input or a header", () => {
  for (const size of [1, 7, 64, streamLines.length]) {
    const r = S.createStreamReducer({ secrets: [SANDBOX_KEY] });
    for (let i = 0; i < streamLines.length; i += size) r.push(streamLines.slice(i, i + size));
    r.end();
    const sm = r.summary(), flat = JSON.stringify(sm);
    assert.equal(sm.events, 6, `chunk ${size}`); assert.equal(sm.malformed, 0); assert.equal(sm.mode, "auto"); assert.equal(sm.tools, 4); assert.deepEqual(sm.called, ["Task", "Bash"]);
    assert.deepEqual(sm.result, { subtype: "success", isError: false, turns: 2, text: "stub-ok", denied: [{ tool: "Task", id: "toolu_1" }] });
    assert.deepEqual(sm.denied, [{ tool: "Task", reason: "Claude requested permissions to use Task, but you haven't granted it yet." }]);
    assert.equal(sm.errors.length, 2); assert.equal(sm.errors[1].tool, "Bash"); assert.match(sm.errors[1].reason, /denied by the auto mode classifier/);
    for (const bad of ["SECRET PROMPT", "SECRET INPUT", SANDBOX_KEY, "abcdefghijklmnop", "I will delegate"]) assert.ok(!flat.includes(bad), `${bad} is not kept`);
  }
  const r = S.createStreamReducer();
  r.push("not json\n{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"x\",\"is_error\":true,\"content\":\"" + "y".repeat(500) + "\"}]}}\n42\n"); r.end();
  assert.equal(r.summary().malformed, 1, "an unparsable line is counted, not kept"); assert.equal(r.summary().errors[0].reason.length, 200, "200 characters");
  const big = S.createStreamReducer(); big.push("x".repeat(1100000)); big.push("\n{\"type\":\"result\",\"subtype\":\"s\"}\n"); big.end();
  assert.equal(big.summary().result.subtype, "s", "a huge partial line is dropped and the stream goes on");
  const many = S.createStreamReducer(); for (let i = 0; i < 60; i++) many.push(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: `e${i}` }] } }) + "\n"); many.end();
  assert.ok(many.summary().errors.length <= 5, "bounded");
});

test("R8-2 a verdict says WHY: claudeInfo reads the stream (mode, denied tools with the reason, the tools it called) and the failing line carries them; a plain JSON result is still understood", () => {
  const r = S.createStreamReducer({ secrets: [SANDBOX_KEY] }); r.push(streamLines); r.end();
  const info = S.claudeInfo({ code: 0, text: "", err: "", stream: r.summary() });
  assert.deepEqual([info.mode, info.denials, info.called, info.subtype, info.turns, info.result], ["auto", ["Task"], ["Task", "Bash"], "success", 2, "stub-ok"]);
  assert.deepEqual(info.reasons, ["Task: Claude requested permissions to use Task, but you haven't granted it yet.", "Bash: denied by the auto mode classifier; key <redacted> x-api-key: <redacted>"]);
  const rec = (o) => ({ method: "POST", path: "/v1/messages", headers: {}, toolNames: ["Agent"], model: "uwstub/m-main", sent: { status: 200, kind: "text" }, toolResults: 0, ...o });
  const t = ok("1", { records: [rec({})], claude: info, policy: "uwstub/m-free", asked: "uwstub/m-main" }).text;
  assert.match(t, /the client: exit 0, success, turns 2, permission mode auto, denied tools \[Task\] \(why: "Task: Claude requested permissions to use Task, but you haven't granted it yet\."; "Bash: denied by the auto mode classifier/);
  assert.match(t, /tools it called \[Task, Bash\], answer "stub-ok"/);
  assert.equal(S.claudeInfo({ code: 0, text: JSON.stringify({ subtype: "success", num_turns: 1, result: "x" }) }).mode, "");
});

test("R8-3 realSpawnClaude feeds the reducer from the live stdout (chunks cut mid-line) and returns it as `stream`; plain output without events returns no stream; the sandbox key is masked; the raw text is still clipped", async () => {
  const inv = { args: ["-p", "x"], env: { ANTHROPIC_API_KEY: SANDBOX_KEY, PATH: "p" }, cwd: path.join(os.tmpdir(), "scn-cwd") };
  let child = fakeChild();
  const spawnImpl = () => child;
  let p = S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, kill: () => assert.fail("not killed") });
  for (let i = 0; i < streamLines.length; i += 50) child.stdout.emit("data", Buffer.from(streamLines.slice(i, i + 50)));
  child.emit("close", 0);
  const r = await p;
  assert.equal(r.code, 0); assert.ok(r.text.length <= 4000); assert.equal(r.stream.mode, "auto"); assert.deepEqual(r.stream.denied.map((d) => d.tool), ["Task"]);
  assert.ok(!JSON.stringify(r.stream).includes(SANDBOX_KEY));
  child = fakeChild(); p = S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, kill: () => {} }); child.stdout.emit("data", Buffer.from("{\"result\":\"ok\"}")); child.emit("close", 0);
  assert.equal("stream" in (await p), false, "no events: no stream");
  child = fakeChild(9); const t = await S.realSpawnClaude(inv, { exe: "C:\\bin\\claude.exe", spawnImpl, timeoutMs: 20, kill: () => { child.stdout.emit("data", Buffer.from(streamLines)); } });
  assert.equal(t.code, null);
});

test("R8-4 the reason belongs to the DENIED tool's own tool_use id, not to the first failed tool result", () => {
  const r = S.createStreamReducer();
  const ev = (o) => JSON.stringify(o) + "\n";
  r.push(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t0", is_error: true, content: "an unrelated failure" }] } }));
  r.push(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "the reason for Task" }] } }));
  r.push(ev({ type: "result", subtype: "success", permission_denials: [{ tool_name: "Task", tool_use_id: "t1" }, { tool_name: "Read", tool_use_id: "t9" }] })); r.end();
  assert.deepEqual(r.summary().denied, [{ tool: "Task", reason: "the reason for Task" }, { tool: "Read", reason: "" }]);
  assert.equal(S.claudeInfo({ code: 0, stream: r.summary() }).reasons[1], "Read: no reason in the stream");
});

// ====================================================================================== fix round 9 (cr-harness-r2: the scan could be evaded, the key and the plain-JSON branch were not masked, a decoy in --help counted)
test("R9-1 the source scan is not evadable: a multi-line args array holding a bypass is caught, so are --permission-mode=..., defaultMode, any quoted auto/plan/manual and a bypass hidden behind a string that holds a comment opener; comments and the shipped call are not flagged", () => {
  const multi = `const args = [\n  "-p", prompt,\n  "--permission-mode",\n  "bypassPermissions",\n];`;
  assert.equal(banned(multi), true, "a quoted line of its own is scanned like any other");
  assert.equal(banned(`const args = [\n  "--dangerously-skip-permissions",\n];`), true);
  assert.equal(banned(`const a = "--permission-mode=acceptEdits";`), true);
  assert.equal(banned(`const s = { defaultMode: "x" };`), true);
  for (const q of ["'auto'", '"plan"', "`manual`"]) assert.equal(banned(`const m = ${q};`), true, q);
  assert.equal(banned(`const x = "/*";\nargs.push("bypassPermissions");\nconst y = "*/";`), true, "a string with a comment opener does not hide the code after it");
  assert.equal(banned(`// bypassPermissions is never passed\n/**\n * acceptEdits neither\n */\nconst args = [PERMISSION_MODE_FLAG, REAL_PERMISSION_MODE];`), false, "comments are not code");
  assert.equal(banned(`  ...(supports.dontAsk ? [PERMISSION_MODE_FLAG, REAL_PERMISSION_MODE] : []),`), false, "the shipped call");
});

test("R9-2 nothing unmasked reaches a verdict: cleanText masks the sandbox key before AND after the shared redactor, in the stream branch and in the plain-JSON branch of claudeInfo, and realSpawnClaude masks it in text, err and reason", async () => {
  const K = "ccr-profile-ABCDEFGHIJKLMNOPQRSTUV12";
  for (const text of [K, `"key":"${K}"`, `x-api-key: ${K}`, `Bearer ${K}`, `${K}tail`, `a${K}b ${K}`]) {
    const c = S.cleanText(text, 200, [K]);
    assert.ok(!c.includes(K) && !c.includes(K.slice(0, 20)), `masked in: ${text} -> ${c}`);
  }
  assert.ok(!S.cleanText("x-api-key: abcdefghijklmnop", 200).includes("abcdefghijklmnop"), "the shared redactor still applies");
  const info = S.claudeInfo({ code: 0, text: JSON.stringify({ subtype: "success", num_turns: 1, result: "x-api-key: abcdefghijklmnop done" }), err: "api-key: abcdefghijklmnop boom", reason: "x-api-key: abcdefghijklmnop" });
  assert.ok(!JSON.stringify(info).includes("abcdefghijklmnop"), "result, err and reason of the plain-JSON branch are redacted");
  const inv = { args: ["-p", "x"], env: { ANTHROPIC_API_KEY: K, PATH: "p" }, cwd: path.join(os.tmpdir(), "scn-cwd") };
  let child = fakeChild();
  let p = S.realSpawnClaude(inv, { exe: "C:\bin\claude.exe", spawnImpl: () => child, kill: () => {} });
  child.stdout.emit("data", Buffer.from(`plain output with ${K}`)); child.stderr.emit("data", Buffer.from(`stderr with ${K}`)); child.emit("close", 1);
  const r = await p;
  assert.ok(!JSON.stringify(r).includes(K), "text and err are masked");
  child = fakeChild(); p = S.realSpawnClaude(inv, { exe: "C:\bin\claude.exe", spawnImpl: () => child, kill: () => {} }); child.emit("error", new Error(`spawn failed for ${K}`));
  assert.ok(!JSON.stringify(await p).includes(K), "the error reason is masked");
});

test("R9-3 the launcher's flag support is read from the flag's OWN --help entry: a word in another flag's text is no support; the real 2.1.289 text is supported; stream-json also needs the --verbose entry", () => {
  const real = [`  --output-format <format>              Output format (only works with --print):`, `                                        "text" (default), "json" (single`, `                                        result), or "stream-json" (realtime`, `                                        streaming) (choices: "text", "json",`, `                                        "stream-json")`,
    `  --permission-mode <mode>              Permission mode to use for the session`, `                                        (choices: "acceptEdits", "auto",`, `                                        "bypassPermissions", "manual",`, `                                        "dontAsk", "plan")`,
    `  --permission-prompts <target>         Who answers permission prompts with`, `  --verbose                             Override verbose mode setting from config`].join("\n");
  const id = (help) => S.identifyClaude({ env: { PATH: "bin2" }, fsx: { statSync: () => ({ isFile: () => true }), readFileSync: () => Buffer.from("x") }, run: (e, a) => (a[0] === "--version" ? "2.1.289" : help) }).supports;
  const full = id(real);
  assert.deepEqual([full.dontAsk, full.streamJson], [true, true]);
  const decoy = id([`  --foo <x>                             uses dontAsk and "stream-json" in its text`, `  --permission-mode <mode>              (choices: "plan", "manual")`, `  --output-format <format>              (choices: "text", "json")`, `  --verbose                             verbose`].join("\n"));
  assert.deepEqual([decoy.dontAsk, decoy.streamJson], [false, false], "the words sit in another flag's entry");
  const noVerbose = id(real.replace(/\n  --verbose[^\n]*/, ""));
  assert.deepEqual([noVerbose.dontAsk, noVerbose.streamJson], [true, false], "stream-json without --verbose is not used");
  assert.equal(S.helpEntryMentions(`--permission-mode <m>\n${"x".repeat(700)} dontAsk`, "--permission-mode", "dontAsk"), false, "bounded window");
  assert.equal(S.helpEntryMentions("--permission-mode+ dontAsk", "--permission-mode", "dontAsk"), true);
  assert.equal(S.helpEntryMentions(undefined, "--permission-mode", "dontAsk"), false);
});

test("R9-4 the reducer keeps up to 64 failed tool results by id, so a denial's reason is not lost behind a flood of other failures (the summary still shows five); beyond 64 the reason is honestly absent, never another tool's", () => {
  const ev = (o) => JSON.stringify(o) + "\n";
  const flood = (n, deniedId) => { const r = S.createStreamReducer(); for (let i = 0; i < n; i++) r.push(ev({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: `t${i}`, is_error: true, content: `failure ${i}` }] } })); r.push(ev({ type: "result", subtype: "success", permission_denials: [{ tool_name: "Task", tool_use_id: deniedId }] })); r.end(); return r.summary(); };
  const a = flood(40, "t39"); assert.deepEqual(a.denied, [{ tool: "Task", reason: "failure 39" }]); assert.ok(a.errors.length <= 5);
  const b = flood(64, "t63"); assert.equal(b.denied[0].reason, "failure 63");
  const c = flood(70, "t69"); assert.equal(c.denied[0].reason, "", "past the cap: no reason, not a wrong one");
  assert.equal(S.claudeInfo({ code: 0, stream: c }).reasons[0], "Task: no reason in the stream");
});

test("R9-5 the key is masked BEFORE the shared redactor (it rewrites a sk- run inside a key and the whole key can no longer be found afterwards); a word in the NEXT flag's entry is no support", () => {
  const K = "ccr-profile-sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ12";
  const c = S.cleanText(`token ${K} end`, 200, [K]);
  assert.equal(c, "token <redacted> end", "the WHOLE key is masked: the redactor alone would leave the prefix `ccr-profile-` of it");
  assert.equal(S.cleanText(K, 200), "ccr-profile-<redacted-key>", "what the redactor alone does to this key");
  const after = [`  --permission-mode <mode>              (choices: "plan", "manual")`, `  --other <x>                           mentions dontAsk right here`].join("\n");
  assert.equal(S.helpEntryMentions(after, "--permission-mode", "dontAsk"), false, "the entry ends at the next flag");
});

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
  assert.equal(S.ROUTER_SHA256, "5da75baa60dadb3aa24ff281d4c5ac460f38067428f8f9067826c7bf516f1182");
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

test("judge 7 (worker restart): the handed-off model must survive a REAL restart (pid changed); the same pid is a FINDING; a different model after the restart FAILS", () => {
  const ev = { handoffSeen: true, handedTo: "uwstub/m-big", afterModel: "m-big", pidBefore: 100, pidAfter: 101 };
  assert.equal(ok("7", ev).verdict, "PASS");
  assert.equal(ok("7", { ...ev, pidAfter: 100 }).verdict, "FINDING");
  assert.equal(ok("7", { ...ev, afterModel: "m-free" }).verdict, "FAIL");
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
    if (w.blocked.size && !w.logFd) { count("logDropped"); count("journalFail"); if (bug.failOnBlocked) return { status: 500, ms: 5, headers: {} }; }      // a worker that already holds its log descriptor open does not notice the swap
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
    send, stub, now: () => 1_800_000_000_000, sleep: async (ms) => { if (ms >= 1000 && !bug.overlayIgnored) for (const m of w.overlayPending) w.overlay.add(m); if (ms >= 1000) w.overlayPending.clear(); }, settle: async () => {}, markDirty: () => {},
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
    restartWorker: async () => { const pidBefore = w.corePid; if (!bug.noRestart) { w.corePid += 1; w.logFd = false; w.cooling.clear(); w.files.delete("cooling.json"); } if (bug.noReplay) w.sticky.clear(); return { pidBefore, pidAfter: w.corePid, changed: w.corePid !== pidBefore, ready: true }; },
    freshWorker: async () => { const r = await prims.restartWorker(); if (!r.changed) throw new Error("the router worker was not replaced"); return r; },
    claude: null, realCheck: null,
    reset: async () => { w.files.delete("cooling.json"); if (!bug.resetIneffective) w.cooling.clear(); w.overlay.clear(); w.overlayPending.clear(); w.sticky.clear(); w.flag = false; w.torn = false; w.tornCounted = false; w.warnings.length = 0; w.published = { counters: w.published.counters, warnings: [], cooling: bug.resetIneffective ? w.published.cooling : [] }; },
  };
  return { w, prims };
}
const runAll = async (bug, extra = {}) => { const { prims } = fakeWorld(bug); const lines = []; const res = await S.runScenarios(prims, extra, (l) => lines.push(l)); return { res, lines, by: Object.fromEntries(res.map((r) => [r.scn.id, r.result])) }; };

test("the whole suite against a CORRECT fake sandbox: every scenario passes (11 DEGRADED by design, C4 a FINDING for one worker), one result line each naming the client, and the suite verdict is OK with the non-PASS ids listed as not G3 evidence", async () => {
  const { by, lines } = await runAll({});
  const verdicts = Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.verdict]));
  assert.deepEqual(verdicts, { 1: "PASS", 2: "PASS", 3: "PASS", 4: "PASS", 5: "PASS", 6: "PASS", 7: "PASS", 8: "PASS", 9: "PASS", 10: "PASS", 11: "DEGRADED", C1: "PASS", C2: "PASS", C3: "PASS", C4: "FINDING" });
  assert.equal(lines.length, 15); assert.ok(lines.every((l) => S.parseScenarioLine(l)));
  assert.ok(lines.every((l) => /\[replay\]/.test(l)), "every line says replay (scenarios 4-10 and C1-C4 and the DEGRADED line of 11 included)");
  assert.ok(lines.filter((l) => !/^SCENARIO PASS/.test(l)).every((l) => /\[not G3 evidence\]$/.test(l)));
  const v = S.suiteVerdict(lines, S.ALL.map((s) => s.id));
  assert.equal(v.ok, true); assert.deepEqual(v.notG3, ["11", "C4"]);
  assert.deepEqual((await runAll({ workers: 2 })).by.C4.verdict, "PASS");
});

test("MUTATION (the fake router gets one defect each): every defect turns EXACTLY the matching scenarios to FAIL or FINDING and leaves every other scenario as it was", async () => {
  const cases = [
    [{ rewriteAux: true }, { 8: "FAIL" }], [{ noHandoff: true }, { 2: "FAIL", 3: "FAIL", 7: "FAIL", 10: "FAIL" }], [{ noRetrySignal: true }, { 2: "FINDING", 3: "FAIL", 7: "FAIL", 10: "FAIL" }],
    [{ mainClass: true }, { 4: "FAIL" }], [{ stickyBroken: true }, { 5: "FAIL", 7: "FAIL" }], [{ noNewerWarn: true }, { 6: "FAIL" }], [{ noRestart: true }, { 7: "FINDING", C1: "FAIL", C3: "FAIL" }], [{ noReplay: true }, { 7: "FAIL" }],
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
  assert.deepEqual([id.version, id.sha256, id.supports], ["2.1.0 (Claude Code)", sha(Buffer.from("fake-claude-bytes")), { settingSources: true, strictMcp: true }]); assert.match(id.path, /bin2[\\/]claude\.exe$/);
  assert.deepEqual(calls, ["--version", "--help"]);
  assert.equal(S.identifyClaude({ env: { PATH: "" }, fsx: fakeFs, run }), null);
  assert.deepEqual(S.identifyClaude({ env: { PATH: "bin2" }, fsx: fakeFs, run: () => "no flags here" }).supports, { settingSources: false, strictMcp: false });
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

test("--real yes: the client is named truthfully. Without a client (no launcher pinned) the REAL scenarios REPLAY and their lines never read 'real claude -p'; with a client scenarios 1, 2, 3 and 11 call it (each sets onMain so a subagent is spawned), judge the failure from the STUB, name the client, and RC is judged", async () => {
  const f = fakeWorld({});
  const r0 = await S.runScenarios(f.prims, { only: ["1", "2", "3", "11"], real: true });
  for (const x of r0) { assert.match(x.result.client, /^replay \(real client unavailable/, `scenario ${x.scn.id}`); assert.ok(!/real claude -p/.test(S.scenarioLine(x.result, x.scn))); }
  assert.ok(!r0.some((x) => x.scn.id === "RC"), "no real client, no RC line");
  // a fake CLIENT that behaves like claude -p: it asks the stub's script for a spawn, then sends the main and subagent requests a real client would
  const g = fakeWorld({}); const prompts = [];
  g.prims.claude = async ({ prompt }) => {
    prompts.push(prompt);
    const spawn = g.w.script.onMain?.({});
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
    const spawn = g.w.script.onMain?.({});
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
 * A WINDOWS-SHAPED virtual sandbox: a clock the sleeps advance, an in-memory scratch tree, a router that flushes status.json at most every 5 s, and a process table with creation times. As in production the table the harness
 * queries is FILTERED (names node|ccr), so a process behind cmd.exe or a shell is invisible to it, while ancestorsOf walks the UNFILTERED table. Processes: the sandbox daemon (100) holding the gateway and web ports, its core
 * worker child (500) holding the core port, a LIVE CCR daemon (900) holding the live ports, the orchestrator (700, a node process under a hidden cmd.exe 710 under a hidden claude.exe 720).
 * Stopping the core worker makes CCR respawn it (a new pid, created later) after `respawnMs`. Options break one rule each. Nothing here stops a real process: stopVerified only edits the table.
 */
const CLI = "C:\\npm\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js", DIST = "C:\\npm\\node_modules\\@musistudio\\claude-code-router\\dist\\main";
const DAEMON_CMD = `"C:\\nvm4w\\nodejs\\node.exe" ${CLI} serve --daemon-child --no-open`;                     // the live and the sandbox daemon have the SAME command line
const workerCmd = (dir, dist = DIST) => `"C:\\nvm4w\\nodejs\\node.exe" --require ${dir}\\gateway-proxy-preload.cjs ${dist}\\gateway-bootstrap.js`;
async function virtualSandbox(o = {}) {
  const { respawn = true, respawnMs = 1500, daemonReplaced = false, newParent = 100, readyAfter = 2, dyingRewritesCooling = true, coreRow = {}, extraRows = [], realOwners = {}, liveSvcText = null, baseline = { ccrPids: [900], liveServicePid: 900 },
    daemonKnown = true, webHolder = 100, ccrFound = true, appdata = "C:\\Users\\osami\\AppData\\Roaming", listens = null, probeFail = [], coreHolderOverride, ancestorsOverride, onRead = null, beforeStop = null, staysAlive = false, daemonCmd = DAEMON_CMD, orchRow = {}, installCli = CLI, workerDist = DIST, realMap = null } = o;
  const { SCRATCH_STATE_DIR, LIVE_SERVICE_JSON, SANDBOX_PORTS, REAL_PORTS, CCR_CONFIG_DIR } = await import("../harness/subagent-sandbox-spec.mjs");
  const mem = new Map(), r = (p) => path.resolve(p), T0 = 1_800_000_000_000, iso = (ms) => new Date(ms).toISOString();
  const V = { now: T0, statusAt: -1e15, reqs: [], core: 500, daemon: 100, nextCore: 501, stopped: [], respawnAt: null, answered: 0, rpc: 0, log: [], reads: 0, T0, iso };
  V.all = [
    { pid: 720, ppid: 1, name: "claude.exe", cmd: "claude.exe", created: iso(T0 - 9e6) }, { pid: 710, ppid: 720, name: "cmd.exe", cmd: "cmd.exe /c node harness\\subagent-scenarios.mjs", created: iso(T0 - 8e6) },
    { pid: 700, ppid: 710, name: "node.exe", cmd: "node harness\\subagent-scenarios.mjs --run", created: iso(T0 - 7e6), ...orchRow },
    { pid: 900, ppid: 1, name: "node.exe", cmd: DAEMON_CMD, created: iso(T0 - 6e6) },
    { pid: 100, ppid: 1, name: "node.exe", cmd: daemonCmd, created: iso(T0 - 5e5) },
    { pid: 500, ppid: 100, name: "node.exe", cmd: workerCmd(CCR_CONFIG_DIR, workerDist), created: iso(T0 - 4e5), ...coreRow }, ...extraRows,
  ];
  const statusFile = r(path.join(SCRATCH_STATE_DIR, "status.json")), coolFile = r(path.join(SCRATCH_STATE_DIR, "cooling.json"));
  if (liveSvcText != null) mem.set(r(LIVE_SERVICE_JSON), liveSvcText);
  const flush = () => { V.statusAt = V.now; mem.set(statusFile, JSON.stringify({ updatedAt: iso(V.now), counters: { req: V.reqs.length }, cooling: [] })); };
  const d = {
    fs: { mkdirSync() {}, writeFileSync: (p, t) => mem.set(r(p), String(t)), renameSync: (a, b) => { mem.set(r(b), mem.get(r(a))); mem.delete(r(a)); }, rmSync: (p) => { mem.delete(r(p)); }, readdirSync: () => [], existsSync: () => true,
      ...(realMap ? { realpathSync: Object.assign((p) => realMap(String(p)), { native: (p) => realMap(String(p)) }) } : {}) },
    sys: {
      selfPid: 700,
      readText: (p) => mem.get(r(p)) ?? null,
      processes: () => { V.log.push("processes"); V.reads += 1; const rows = V.all.filter((x) => /node|ccr/i.test(x.name)).map((x) => ({ ...x })); if (onRead) onRead(V.reads, V); return rows; },
      listenerProbe: (port) => {
        V.log.push(`probe:${port}`);
        if (probeFail.includes(port)) return { ok: false };
        if (port === SANDBOX_PORTS.core) { V.coreProbes = (V.coreProbes ?? 0) + 1; return { ok: true, pid: typeof coreHolderOverride === "function" ? coreHolderOverride(V.coreProbes, V) : coreHolderOverride !== undefined ? coreHolderOverride : V.core }; }
        if (port === SANDBOX_PORTS.web) return { ok: true, pid: webHolder };
        if (REAL_PORTS.includes(port)) return { ok: true, pid: realOwners[port] ?? 900 };
        return { ok: true, pid: null };
      },
      listenPortsOf: (pid) => listens ?? (pid === 900 ? REAL_PORTS.map((p) => ({ addr: "127.0.0.1", port: p })) : [{ addr: "127.0.0.1", port: SANDBOX_PORTS.core }]),
      ancestorsOf: (pid) => { if (ancestorsOverride) return ancestorsOverride; const out = []; for (let p = pid, i = 0; i < 40; i++) { const row = V.all.find((x) => x.pid === p); if (!row || !row.ppid || row.ppid === 1) break; out.push(row.ppid); p = row.ppid; } return out; },
      stopVerified: (snap) => {                                                              // identify AND stop in one step: nothing real is touched
        V.log.push(`stop:${snap.pid}`);
        if (beforeStop) beforeStop(snap, V);
        const row = V.all.find((x) => x.pid === snap.pid);
        if (!row) throw new Error("IDENTITY: no process row");
        if (row.created !== snap.created) throw new Error("IDENTITY: creation time differs");
        if (row.cmd !== snap.cmd) throw new Error("IDENTITY: command line differs");
        V.stopped.push(snap.pid);
        if (staysAlive) return;
        V.all = V.all.filter((x) => x.pid !== snap.pid);
        if (snap.pid === V.core) { V.core = undefined; V.respawnAt = V.now + respawnMs; }
      },
    },
    resolveWebPort: () => ({ port: SANDBOX_PORTS.web, pid: V.daemon }),
    ccrInstall: () => (ccrFound ? { found: true, cli: installCli } : { found: false, reason: "test" }),
    env: appdata === null ? {} : { APPDATA: appdata },
    rpc: async () => { V.rpc += 1; throw new Error("the config RPC must not be used to replace a worker"); },
    now: () => V.now,
    sleep: async (ms) => {
      V.now += ms;
      if (V.core === undefined && respawn && V.respawnAt !== null && V.now >= V.respawnAt) {
        V.core = V.nextCore++; V.respawnAt = null; V.answered = 0;
        V.all.push({ pid: V.core, ppid: newParent, name: "node.exe", cmd: workerCmd(CCR_CONFIG_DIR, workerDist), created: iso(V.now) });
        if (daemonReplaced) V.daemon = 101;
      }
    },
    fetch: async (url, init) => {
      const h = init.headers, aux = !JSON.parse(init.body).tools;
      V.reqs.push({ aux, agent: h["x-claude-code-agent-id"] ?? null });
      if (V.now - V.statusAt >= 5000) flush();                                          // the router flushes at most every 5 s
      V.answered += 1;
      if (dyingRewritesCooling && V.answered === 1 && V.stopped.length) mem.set(coolFile, "{\"v\":1,\"models\":{}}");      // the dying worker rewrites cooling.json on its way out
      const status = V.stopped.length && V.answered <= readyAfter ? 503 : 200;
      return { status, text: async () => "", headers: { forEach() {} } };
    },
  };
  const notes = [];
  const c = { d, key: "k", stub: { records: [] }, launchEnv: {}, baseline, daemonPid: () => (daemonKnown ? 100 : undefined), out: (l) => notes.push(l) };
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

const REFUSAL = /^REFUSED to stop the sandbox core worker, nothing was stopped: /;
test("process stop (round 4): the order is probes first, the process table LAST and read twice before the stop, then each target is identified AND stopped in ONE step (stopVerified), then the table is read to see it is gone; the config RPC is never used", async () => {
  const v = await virtualSandbox();
  const r = await prims(v).restartWorker();
  assert.deepEqual([r.pidBefore, r.pidAfter, r.changed, r.ready], [500, 501, true, true]);
  assert.deepEqual(v.V.stopped, [500], "exactly the core worker was stopped");
  assert.equal(v.V.rpc, 0);
  assert.equal(v.mem.has(v.coolFile), false, "cooling.json is gone again");
  const log = v.V.log, firstRead = log.indexOf("processes"), lastProbeBeforeStop = Math.max(...log.slice(0, log.indexOf("stop:500")).map((x, i) => (x.startsWith("probe:") ? i : -1)));
  assert.ok(log.slice(0, firstRead).every((x) => x.startsWith("probe:")) && log.slice(0, firstRead).length >= 6, "every port probe comes BEFORE the first table read (core, web and the four live ports)");
  const beforeStop = log.slice(0, log.indexOf("stop:500"));
  assert.equal(beforeStop.filter((x) => x === "processes").length, 2, "the table is read twice before the stop");
  assert.equal(beforeStop.at(-1), "processes", "and the LAST thing before the stop is a table read");
  assert.ok(lastProbeBeforeStop < beforeStop.lastIndexOf("processes"));
  assert.equal(log[log.indexOf("stop:500") + 1], "processes", "after the stop the table is read to see the process is gone");
});

test("process stop (round 4): the stale parent id of the ORCHESTRATOR (node harness\\subagent-scenarios.mjs) and of an unrelated `node some-mcp-server.js` is the reproduced defect: the old descendant rule returned [] for both; now stopRefusals refuses both, and restartWorker never stops them", async () => {
  const stale = [{ pid: 700, ppid: 500, name: "node.exe", cmd: "node harness\\subagent-scenarios.mjs --run", created: new Date(1_800_000_000_000 - 7e6).toISOString() },
    { pid: 801, ppid: 500, name: "node.exe", cmd: "node some-mcp-server.js", created: new Date(1_800_000_000_000 - 3e6).toISOString() }];
  const v = await virtualSandbox({ extraRows: [stale[1]], orchRow: { ppid: 500 }, ancestorsOverride: [710, 720] });      // the orchestrator's RECORDED parent is the worker's pid (stale after pid reuse); its real chain is 710, 720
  const rows = v.V.all.filter((x) => /node/i.test(x.name));
  const common = { rows, selfPid: 700, ancestors: [710, 720], underPid: 500, mode: "descendant" };
  const orch = S.stopRefusals({ ...common, pid: 700 }), mcp = S.stopRefusals({ ...common, pid: 801 });
  assert.ok(orch.includes("it is the orchestrator itself") && orch.some((x) => /not a CCR process/.test(x)) && orch.some((x) => /BEFORE its recorded parent 500/.test(x)), orch.join(" | "));
  assert.ok(mcp.some((x) => /not a CCR process \(node some-mcp-server\.js\)/.test(x)) && mcp.some((x) => /BEFORE its recorded parent 500/.test(x)), mcp.join(" | "));
  // the real flow: both look like descendants by their recorded parent, neither is PROVABLY one, so neither is stopped and the worker is
  const r = await prims(v).restartWorker();
  assert.equal(r.changed, true); assert.deepEqual(v.V.stopped, [500]);
  assert.ok(v.notes.some((l) => /ignored 700, 801 .*stale parent id/.test(l)), v.notes.join("|"));
  assert.ok(v.V.all.some((x) => x.pid === 700) && v.V.all.some((x) => x.pid === 801), "both are still there");
  // a child that IS younger than the worker (a valid link) but is not a CCR process: fail closed
  const mcp2 = await virtualSandbox({ extraRows: [{ pid: 802, ppid: 500, name: "node.exe", cmd: "node some-mcp-server.js", created: new Date(1_800_000_000_000 - 1e5).toISOString() }] });
  await assert.rejects(() => prims(mcp2).restartWorker(), (e) => REFUSAL.test(e.message) && /its descendant 802: .*not a CCR process \(node some-mcp-server\.js\)/.test(e.message));
  assert.deepEqual(mcp2.V.stopped, []);
  // and a valid child that is the orchestrator itself
  const me = await virtualSandbox({ extraRows: [{ pid: 803, ppid: 500, name: "node.exe", cmd: "node claude-code-router x", created: new Date(1_800_000_000_000 - 1e5).toISOString() }], ancestorsOverride: [710, 720] });
  me.d.sys.selfPid = 803;
  await assert.rejects(() => prims(me).restartWorker(), /its descendant 803: it is the orchestrator itself/);
  assert.deepEqual(me.V.stopped, []);
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

test("process stop (round 4): every refusal throws BEFORE anything is stopped and names the rule (live service.json pid, baseline, live port owner, a link that cannot be proved, a worker behind cmd.exe, a non-CCR command, an unknown daemon, a daemon that is not the daemon-child, a daemon off the web port, a foreign listener, a descendant that owns a live port or is the live pid, the orchestrator, an ancestor, the daemon itself, no holder)", async () => {
  const young = new Date(1_800_000_000_000 - 1e5).toISOString(), kid = { pid: 600, ppid: 500, name: "node.exe", cmd: "node claude-code-router child", created: young };
  const cases = [
    ["the live service.json pid", { liveSvcText: JSON.stringify({ pid: 500 }) }, /it is the pid in the live service\.json/],
    ["the baseline's live service.json pid", { baseline: { ccrPids: [900], liveServicePid: 500 } }, /it is the pid in the live service\.json/],
    ["the baseline set of live CCR pids", { baseline: { ccrPids: [900, 500], liveServicePid: 900 } }, /it is in the baseline set of LIVE CCR pids/],
    ["a LIVE port owner", { realOwners: { 3456: 500 } }, /it owns live port\(s\) 3456/],
    ["a worker whose parent link cannot be proved (it sits behind cmd.exe)", { coreRow: { ppid: 710 } }, /its parent 710 is not in the process table \(a process behind cmd\.exe/],
    ["a worker created BEFORE its recorded parent (pid reuse)", { coreRow: { created: new Date(1_800_000_000_000 - 9e5).toISOString() } }, /was created BEFORE its recorded parent 100/],
    ["a command line that is not CCR", { coreRow: { cmd: "notepad.exe" } }, /its command line is not a CCR process \(notepad\.exe\)/],
    ["an unknown daemon", { daemonKnown: false }, /the sandbox daemon pid is not known/],
    ["a daemon whose command line is not the daemon-child (M3)", { daemonCmd: "node claude-code-router something-else" }, /the sandbox daemon's command line is not the CCR daemon-child/],
    ["the daemon not holding the web port", { webHolder: 7 }, /does not hold the sandbox web port/],
    ["a listener outside the sandbox", { listens: [{ addr: "0.0.0.0", port: 39457 }] }, /it listens outside the sandbox: .*not loopback/],
    ["a descendant that owns a live port", { extraRows: [kid], realOwners: { 4517: 600 } }, /its descendant 600: it owns live port\(s\) 4517/],
    ["a descendant that is the live service.json pid", { extraRows: [kid], liveSvcText: JSON.stringify({ pid: 600 }) }, /its descendant 600: it is the pid in the live service\.json/],
    ["the core holder is the orchestrator itself", { coreHolderOverride: 700 }, /it is the orchestrator itself/],
    ["the core holder is an ANCESTOR of the orchestrator", { ancestorsOverride: [500, 710] }, /it is an ancestor of the orchestrator/],
    ["a torn live service.json", { liveSvcText: "{torn" }, /the live service\.json cannot be read \(\(unparseable\)\)/],
    ["a failed probe of a live port", { probeFail: [3456] }, /the probe of live port 3456 failed, so who owns it is not known/],
    ["a failed probe of the web port", { probeFail: [39458] }, /the probe of sandbox web port 39458 failed/],
    ["a failed probe of the core port (no holder is known)", { probeFail: [39457] }, /the probe of sandbox core port 39457 failed|no process holds the sandbox core port/],
    ["no baseline at all", { baseline: null }, /the baseline of live CCR pids was not handed over/],
    ["a baseline without ccrPids", { baseline: { liveServicePid: null } }, /the baseline of live CCR pids was not handed over/],
    ["an unreadable baseline service.json pid", { baseline: { ccrPids: [900], liveServicePid: "(unparseable)" } }, /the baseline's live service\.json pid is unreadable/],
    ["a baseline pid that is missing altogether", { baseline: { ccrPids: [900] } }, /the baseline's live service\.json pid is unreadable \(\)/],
    ["an EMPTY live set while a live service.json was recorded", { baseline: { ccrPids: [], liveServicePid: 900 } }, /lists no live CCR pid but recorded a live service\.json pid 900/],
  ];
  for (const [label, opts, re] of cases) {
    const v = await virtualSandbox(opts);
    await assert.rejects(() => prims(v).restartWorker(), (e) => /^REFUSED to stop the sandbox core worker, nothing was stopped: /.test(e.message) && re.test(e.message), label);
    assert.deepEqual(v.V.stopped, [], `${label}: NOTHING was stopped`);
  }
  const daemon = await virtualSandbox({ coreHolderOverride: 100 });
  await assert.rejects(() => prims(daemon).restartWorker(), /it is the sandbox daemon itself/);
  assert.deepEqual(daemon.V.stopped, []);
  const none = await virtualSandbox({ coreHolderOverride: null });
  await assert.rejects(() => prims(none).restartWorker(), /no process holds the sandbox core port/);
  const noSeam = await virtualSandbox(); delete noSeam.d.sys.stopVerified;
  await assert.rejects(() => prims(noSeam).restartWorker(), /the system seam has no stopVerified/);
});

test("process stop (round 4): an EMPTY live set is accepted only when the baseline recorded no live service.json, and says so", async () => {
  const v = await virtualSandbox({ baseline: { ccrPids: [], liveServicePid: null } });
  const r = await prims(v).restartWorker();
  assert.equal(r.changed, true);
  assert.ok(v.notes.some((l) => /recorded NO live CCR process and no live service\.json/.test(l)), v.notes.join("|"));
});

test("process stop (round 4): pid reuse. A process table that changes between the two reads (same pid, other creation time or command line) refuses; a pid reused AFTER the second read is refused by the single-step identify-and-stop; a stop that leaves the process in the table throws; nothing else is ever stopped", async () => {
  const swapped = await virtualSandbox({ onRead: (n, V) => { if (n === 1) { const row = V.all.find((x) => x.pid === 500); row.created = new Date(1_800_000_000_000 - 3e5).toISOString(); } } });
  await assert.rejects(() => prims(swapped).restartWorker(), (e) => REFUSAL.test(e.message) && /changed between the two reads of the process table/.test(e.message));
  assert.deepEqual(swapped.V.stopped, []);
  const recmd = await virtualSandbox({ onRead: (n, V) => { if (n === 1) V.all.find((x) => x.pid === 500).cmd += " --other"; } });
  await assert.rejects(() => prims(recmd).restartWorker(), /changed between the two reads/);
  assert.deepEqual(recmd.V.stopped, []);
  const moved = await virtualSandbox({ coreHolderOverride: (n, V) => (n === 1 ? V.core : 999) });                          // the port changed hands between the first probe and the re-probe before the stop
  await assert.rejects(() => prims(moved).restartWorker(), (e) => REFUSAL.test(e.message) && /the holder of the sandbox core port changed from 500 before the stop/.test(e.message));
  assert.deepEqual(moved.V.stopped, []);
  const late = await virtualSandbox({ beforeStop: (snap, V) => { const row = V.all.find((x) => x.pid === snap.pid); row.created = new Date(1_800_000_000_000 - 1e5).toISOString(); row.cmd = "notepad.exe"; } });   // reused between the second read and the stop
  await assert.rejects(() => prims(late).restartWorker(), /IDENTITY: creation time differs/);
  assert.deepEqual(late.V.stopped, [], "the one-step stop refused: nothing was killed");
  const alive = await virtualSandbox({ staysAlive: true });
  await assert.rejects(() => prims(alive).restartWorker(), /the stop of pid 500 did not take effect: it is still in the process table/);
  const gone = await virtualSandbox({ onRead: (n, V) => { if (n === 2) V.all = V.all.filter((x) => x.pid !== 500); } });                  // the worker vanished by itself between the reads
  await assert.rejects(() => prims(gone).restartWorker(), /IDENTITY: no process row/);       // gone after the second read: the one-step stop finds no process to identify
  assert.deepEqual(gone.V.stopped, []);
});

test("process stop (round 4): the cmd.exe case is documented fail-closed: a worker whose parent is a hidden cmd.exe is refused with that reason (the node/ccr table cannot prove the link)", async () => {
  const v = await virtualSandbox({ coreRow: { ppid: 710 } });
  await assert.rejects(() => prims(v).restartWorker(), /its parent 710 is not in the process table \(a process behind cmd\.exe or a shell is invisible to the node\/ccr table, so the link cannot be proved\)/);
  assert.deepEqual(v.V.stopped, []);
});

test("stopRefusals is pure: the same rules over plain data (an empty list means the process may be stopped); the daemon is never a target", () => {
  const t = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
  const scratch = "C:\\scratch\\appdata\\claude-code-router", real = "C:\\Users\\me\\AppData\\Roaming\\claude-code-router", dist = "C:\\ccr\\claude-code-router\\dist\\main";
  const rows = [{ pid: 100, ppid: 1, cmd: "x claude-code-router daemon-child", created: t(0) }, { pid: 500, ppid: 100, cmd: `node --require ${scratch}\\p.cjs ${dist}\\gateway-bootstrap.js`, created: t(10) }];
  const good = { rows, pid: 500, daemonPid: 100, coreHolder: 500, webHolder: 100, listens: { bad: [], rec: [39457] }, corePort: 39457, expect: { scratchDir: scratch, realDir: real, distDir: dist }, selfPid: 7, ancestors: [8] };
  assert.deepEqual(S.stopRefusals(good), []);
  assert.ok(S.stopRefusals({ ...good, pid: 100, coreHolder: 100 }).some((x) => /daemon itself/.test(x)));
  assert.deepEqual(S.stopRefusals({ ...good, coreHolder: 7 }), ["it does not hold the sandbox core port"]);
  assert.deepEqual(S.stopRefusals({ ...good, expect: null }), ["no command-line expectation (scratch config path, real appdata path, installed CCR dist) was supplied"], "without an expectation a worker is never accepted");
  assert.ok(S.stopRefusals({ ...good, expect: { ...good.expect, distDir: "" } }).some((x) => /no command-line expectation/.test(x)));
  assert.deepEqual(S.stopRefusals({ rows, pid: 500, mode: "descendant", underPid: 100, selfPid: 7 }), []);
  assert.deepEqual(S.stopRefusals({ pid: undefined }), ["no process holds the sandbox core port"]);
  assert.ok(S.stopRefusals({ ...good, selfPid: 500 }).includes("it is the orchestrator itself"));
  assert.ok(S.stopRefusals({ ...good, ancestors: [500] }).includes("it is an ancestor of the orchestrator"));
  assert.ok(S.stopRefusals({ ...good, probeFailed: ["live port 3456"] }).some((x) => /probe of live port 3456 failed/.test(x)));
});

test("H2 after the stop: no respawn within 30 s, a REPLACED daemon, a new holder that cannot be proved under the daemon and a worker that never answers are each an ERROR of the run (an infrastructure fault, never a router verdict)", async () => {
  const none = await virtualSandbox({ respawn: false });
  await assert.rejects(() => prims(none).freshWorker(), /was stopped but no new process took the core port within 30 s: CCR did not respawn it/);
  assert.deepEqual(none.V.stopped, [500]);
  const rep = await virtualSandbox({ daemonReplaced: true });
  await assert.rejects(() => prims(rep).freshWorker(), /the sandbox daemon itself was replaced \(pid 100 -> 101\)/);
  const stray = await virtualSandbox({ newParent: 1 });
  await assert.rejects(() => prims(stray).freshWorker(), /does not provably descend from the sandbox daemon 100: its parent 1 is not in the process table/);
  const dead = await virtualSandbox({ readyAfter: 1e9 });
  await assert.rejects(() => prims(dead).freshWorker(), /did not answer a request within 20 s/);
});

test("H2 reset: a clean worker is NOT restarted, a dirty one is replaced, and a refusal reaches the caller", async () => {
  const ok = await virtualSandbox(), w = prims(ok);
  await w.reset(); assert.deepEqual(ok.V.stopped, [], "reset on a clean worker stops nothing");
  w.markDirty(); await w.reset(); assert.deepEqual(ok.V.stopped, [500], "a dirty reset replaced the worker");
  const live = await virtualSandbox({ liveSvcText: JSON.stringify({ pid: 500 }) }), q = prims(live);
  q.markDirty(); await assert.rejects(() => q.reset(), /REFUSED/);
  assert.deepEqual(live.V.stopped, []);
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

test("H7 C3 runs on a FRESH worker: a worker that already holds its log descriptor open does not notice the swap, so a harness that skips the replacement sees nothing and FAILs; the judge accepts journalFail OR logDropped", async () => {
  const good = await S.runScenarios(fakeWorld({}).prims, { only: ["C3"] });
  assert.equal(good[0].result.verdict, "PASS", good[0].result.text);
  const g = fakeWorld({});
  const fdOpen = { ...g.prims, freshWorker: async () => { g.w.logFd = true; } };                                  // no replacement: the worker keeps its open descriptor
  const lazy = await S.runScenarios(fdOpen, { only: ["C3"] });
  assert.equal(lazy[0].result.verdict, "FAIL", lazy[0].result.text); assert.match(lazy[0].result.text, /logDropped 0 -> 0, journalFail 0 -> 0/);
  const base = { requests: [{ status: 200 }], status0: { counters: {}, warnings: [] } };
  assert.equal(ok("C3", { ...base, status1: { counters: { journalFail: 2 }, warnings: [] } }).verdict, "PASS", "journalFail alone is a report");
  assert.equal(ok("C3", { ...base, status1: { counters: { logDropped: 1 }, warnings: [] } }).verdict, "PASS");
  assert.equal(ok("C3", { ...base, status1: { counters: {}, warnings: [{ code: "LOG_DROPPED" }] } }).verdict, "PASS");
  assert.equal(ok("C3", { ...base, status1: { counters: {}, warnings: [] } }).verdict, "FAIL");
});

test("H6 C1 stamps the shapes the router writes, BEFORE the first request of each session, on a fresh worker; the judge names the request that failed with its status and error", async () => {
  const f = fakeWorld({});
  const writes = [], order = [];
  const prims = { ...f.prims, freshWorker: async () => { order.push("fresh"); return f.prims.freshWorker(); }, writeState: async (n, text) => { order.push(`write ${n}`); writes.push([n, text]); return f.prims.writeState(n, text); },
    send: async (shape, o) => { order.push(`send ${shape}`); return f.prims.send(shape, o); } };
  const r = await S.runScenarios(prims, { only: ["C1"] });
  assert.equal(r[0].result.verdict, "PASS", r[0].result.text);
  const firstSend = order.findIndex((x) => x.startsWith("send")), lastWrite = Math.max(...order.map((x, i) => (x.startsWith("write") ? i : -1)));
  assert.ok(order.indexOf("fresh") >= 0 && order.indexOf("fresh") < firstSend, "a fresh worker comes first");
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
  assert.match(ok("7", { handoffSeen: true, handedTo: "uwstub/m-main", afterModel: "uwstub/m-big", pidBefore: 5, pidAfter: 6, setup: ev.setup }).text, /served uwstub\/m-big, not the handed-off uwstub\/m-main \(setup: handoffNone 2/);
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

// ====================================================================================== round 5 (sec-s5 re-verification: four small fixes)
const young = (ms) => new Date(1_800_000_000_000 - ms).toISOString();
test("F4 stop ORDER is pinned: every descendant (deepest first) is stopped BEFORE the worker, the worker is stopped LAST, and nothing it owned is left behind; reversing the order, or stopping only the worker, fails", async () => {
  const kids = [{ pid: 600, ppid: 500, name: "node.exe", cmd: "node claude-code-router child", created: young(1e5) }, { pid: 601, ppid: 600, name: "node.exe", cmd: "node claude-code-router grandchild", created: young(5e4) }];
  const v = await virtualSandbox({ extraRows: kids });
  const r = await prims(v).restartWorker();
  assert.deepEqual(v.V.stopped, [601, 600, 500], "the grandchild first, then the child, the worker LAST");
  assert.deepEqual(v.V.log.filter((x) => x.startsWith("stop:")), ["stop:601", "stop:600", "stop:500"]);
  assert.ok(!v.V.all.some((x) => x.pid === 600 || x.pid === 601), "no descendant of the old worker is left");
  assert.equal(r.changed, true);
});

test("F2 the orchestrator's ancestors fail LOUD: an empty or unreadable list refuses (a node process always has a parent), and the query text stops on error", async () => {
  for (const [label, anc] of [["empty", []], ["not a list", null], ["junk", ["x"]]]) {
    const v = await virtualSandbox({ ancestorsOverride: anc });
    v.d.sys.ancestorsOf = () => anc;
    await assert.rejects(() => prims(v).restartWorker(), (e) => REFUSAL.test(e.message) && /the orchestrator's ancestors could not be read/.test(e.message), label);
    assert.deepEqual(v.V.stopped, [], label);
  }
  const thrown = await virtualSandbox(); thrown.d.sys.ancestorsOf = () => { throw new Error("CIM query failed"); };
  await assert.rejects(() => prims(thrown).restartWorker(), /CIM query failed/);
  assert.deepEqual(thrown.V.stopped, []);
  const E = await import("../harness/subagent-e2e.mjs"), text = E.PS_ANCESTORS(1234);
  assert.ok(/ErrorActionPreference = 'Stop'/.test(text) && /Get-CimInstance Win32_Process -ErrorAction Stop/.test(text) && !/SilentlyContinue/.test(text), "a failed CIM query throws, it does not yield an empty table");
});

test("F3 the worker is told apart from the LIVE one by its command line: the daemons are identical, so the worker must name the SCRATCH config path, must not name the real Roaming claude-code-router path, and must run a script under the installed CCR dist; a refusal prints the first 120 characters and the missing expectation", async () => {
  const REAL = "C:\\Users\\osami\\AppData\\Roaming\\claude-code-router";
  const live = await virtualSandbox({ coreRow: { cmd: `"C:\\nvm4w\\nodejs\\node.exe" --require ${REAL}\\gateway-proxy-preload.cjs ${DIST}\\gateway-bootstrap.js` } });
  await assert.rejects(() => prims(live).restartWorker(), (e) => REFUSAL.test(e.message) && /its command line names the REAL claude-code-router appdata path C:\\Users\\osami\\AppData\\Roaming\\claude-code-router/.test(e.message) && /does not contain the SANDBOX config path .*first 120 characters of its command line: "C:\\nvm4w\\nodejs\\node\.exe" --require C:\\Users\\osami/.test(e.message));
  assert.deepEqual(live.V.stopped, []);
  const elsewhere = await virtualSandbox({ coreRow: { cmd: `node C:\\evil\\x.js ${DIST}\\gateway-bootstrap.js --scratch C:\\x\\claude-code-router` } });          // the dist path is only a SUBSTRING of the command line
  await assert.rejects(() => prims(elsewhere).restartWorker(), (e) => /its script c:\\evil\\x\.js is not under the installed CCR dist/.test(e.message) && /does not contain the SANDBOX config path/.test(e.message));
  const sibling = await virtualSandbox({ coreRow: { cmd: `node --require %SCRATCH%\\gateway-proxy-preload.cjs ${DIST}-evil\\gateway-bootstrap.js` } });                      // a prefix of the dir NAME is not under the dir
  await assert.rejects(() => prims(sibling).restartWorker(), /is not under the installed CCR dist/);
  for (const [label, opts, re] of [["CCR install unknown", { ccrFound: false }, /the installed CCR \(its dist directory\) is not known/], ["real APPDATA unknown", { appdata: null }, /the real APPDATA is not known/]]) {
    const v = await virtualSandbox(opts);
    await assert.rejects(() => prims(v).restartWorker(), (e) => REFUSAL.test(e.message) && re.test(e.message), label);
    assert.deepEqual(v.V.stopped, [], label);
  }
  const kid = await virtualSandbox({ extraRows: [{ pid: 600, ppid: 500, name: "node.exe", cmd: `node claude-code-router --require ${REAL}\\x.cjs`, created: young(1e5) }] });
  await assert.rejects(() => prims(kid).restartWorker(), /its descendant 600: its command line names the REAL claude-code-router appdata path/);
  assert.deepEqual(kid.V.stopped, []);
  const ok = await virtualSandbox(); assert.equal((await prims(ok).restartWorker()).changed, true, "the faithful sandbox worker passes");
});

test("scriptOf reads the script a node command line runs, skipping flags and the value of --require", () => {
  assert.equal(S.scriptOf('"C:\\nvm4w\\nodejs\\node.exe" --require C:\\a\\p.cjs C:\\ccr\\dist\\main\\gateway-bootstrap.js --x'), "c:\\ccr\\dist\\main\\gateway-bootstrap.js");
  assert.equal(S.scriptOf("node -r pre.cjs --max-old-space-size=4096 C:/ccr/dist/main/cli.js serve"), "c:\\ccr\\dist\\main\\cli.js");
  assert.equal(S.scriptOf("node"), ""); assert.equal(S.scriptOf(""), "");
});

test("F5 the worker's OWN listener list must contain the sandbox core port: an empty list (a failed query) or a list without it refuses", async () => {
  for (const [label, listens] of [["empty", []], ["another sandbox port only", [{ addr: "127.0.0.1", port: 39456 }]], ["an ephemeral port only", [{ addr: "127.0.0.1", port: 50123 }]]]) {
    const v = await virtualSandbox({ listens });
    await assert.rejects(() => prims(v).restartWorker(), (e) => REFUSAL.test(e.message) && /its OWN listener list \(.*\) does not contain the sandbox core port 39457/.test(e.message), label);
    assert.deepEqual(v.V.stopped, [], label);
  }
  const both = await virtualSandbox({ listens: [{ addr: "127.0.0.1", port: 39457 }, { addr: "127.0.0.1", port: 50123 }] });
  assert.equal((await prims(both).restartWorker()).changed, true, "the core port plus an ephemeral one is the normal shape");
  assert.ok(S.stopRefusals({ rows: [], pid: 5, listens: { bad: [], rec: [] }, corePort: 39457 }).some((x) => /OWN listener list \(empty\)/.test(x)));
});

// ====================================================================================== fix round 3 (the third replay run: the core-worker stop refused a REAL worker; one failed reset leaked cooling into the next scenarios)
const LINK = "C:\\nvm4w\\nodejs", TARGET = "C:\\Users\\osami\\AppData\\Local\\nvm\\v25.0.0", PKG = "\\node_modules\\@musistudio\\claude-code-router\\dist\\main";
const linkToTarget = (p) => (p.toLowerCase().startsWith(LINK.toLowerCase() + "\\") ? TARGET + p.slice(LINK.length) : p);

test("R3-1 the real shape: ccr is found through the nvm4w LINK (C:\\nvm4w\\nodejs) while the process table shows the link's TARGET; the stop is accepted (this was refused: the strings share no prefix)", async () => {
  const opts = { installCli: `${LINK}${PKG}\\cli.js`, workerDist: `${TARGET}${PKG}`, realMap: linkToTarget };
  const v = await virtualSandbox(opts);
  const r = await prims(v).restartWorker();
  assert.equal(r.changed, true); assert.deepEqual(v.V.stopped, [500]);
  // the defect, reproduced: without the link being resolved the same strings do not match, so the stop is refused with the reported reason
  const old = await virtualSandbox({ ...opts, realMap: null });
  await assert.rejects(() => prims(old).restartWorker(), /its script c:\\users\\osami\\appdata\\local\\nvm\\v25\.0\.0\\node_modules\\@musistudio\\claude-cod.* is not under the installed CCR dist/);
  assert.deepEqual(old.V.stopped, []);
});

test("R3-2 canonPath and insideDir: case, slashes, `..`, trailing separators, the \\\\?\\ prefix; STRICTLY inside, on a segment boundary", () => {
  const c = (x) => S.canonPath(x);
  assert.equal(c("C:/Dist/Main/"), "c:\\dist\\main"); assert.equal(c("\\\\?\\C:\\a\\b"), "c:\\a\\b"); assert.equal(c("C:\\a\\b\\..\\c"), "c:\\a\\c"); assert.equal(c(""), "");
  assert.equal(S.insideDir("c:\\d\\x.js", "c:\\d"), true);
  for (const [child, dir] of [["c:\\d-evil\\x.js", "c:\\d"], ["c:\\d", "c:\\d"], ["c:\\d\\", "c:\\d"], ["", "c:\\d"], ["c:\\d\\x.js", ""], ["d:\\d\\x.js", "c:\\d"]]) assert.equal(S.insideDir(child, dir), false, `${child} in ${dir}`);
});

test("R3-3 the dist rule still refuses: a sibling that shares the prefix, another drive, another package, a `..` escape, the dist directory itself, a script outside; and still accepts case and slash variants", () => {
  const t = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
  const scratch = "C:\\scratch\\appdata\\claude-code-router", real = "C:\\Users\\me\\AppData\\Roaming\\claude-code-router", dist = "C:\\ccr\\node_modules\\@musistudio\\claude-code-router\\dist\\main";
  const withScript = (script) => [{ pid: 100, ppid: 1, cmd: "x claude-code-router daemon-child", created: t(0) }, { pid: 500, ppid: 100, cmd: `node --require ${scratch}\\p.cjs ${script}`, created: t(10) }];
  const run = (script, over = {}) => S.stopRefusals({ rows: withScript(script), pid: 500, daemonPid: 100, coreHolder: 500, webHolder: 100, listens: { bad: [], rec: [39457] }, corePort: 39457, expect: { scratchDir: scratch, realDir: real, distDir: dist, ...over }, selfPid: 7, ancestors: [8] });
  const notUnder = (r) => r.some((x) => /is not under the installed CCR dist/.test(x));
  assert.deepEqual(run(`${dist}\\gateway-bootstrap.js`), []);
  assert.deepEqual(run(`${dist.toUpperCase().replace(/\\/g, "/")}/Gateway-Bootstrap.js`), [], "case and slashes");
  assert.deepEqual(run(`${dist}\\gateway-bootstrap.js`, { distDir: `${dist}\\` }), [], "a trailing separator on the pinned dir");
  for (const [label, script] of [["sibling with the same prefix", `${dist}-evil\\gateway-bootstrap.js`], ["another drive", `D:${dist.slice(2)}\\gateway-bootstrap.js`], ["another package", dist.replace("claude-code-router", "other-package") + "\\gateway-bootstrap.js"],
    ["a .. escape", `${dist}\\..\\..\\evil.js`], ["a .. escape back in then out", `${dist}\\sub\\..\\..\\evil.js`], ["the dist directory itself", dist], ["a script elsewhere", "C:\\evil\\x.js"]]) assert.ok(notUnder(run(script)), label);
  assert.ok(notUnder(run(`${dist}\\gateway-bootstrap.js`, { distDir: dist.replace("claude-code-router", "other-package") })), "the pinned dir is another package");
});

test("R3-4 on a real filesystem: a junction in front of the install is resolved on BOTH sides (accepted), and a junction INSIDE the dist that leads outside is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-canon-"));
  try {
    const realDist = path.join(root, "real", "node_modules", "pkg", "dist", "main"), outside = path.join(root, "outside");
    fs.mkdirSync(realDist, { recursive: true }); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(realDist, "gateway-bootstrap.js"), "//"); fs.writeFileSync(path.join(outside, "gateway-bootstrap.js"), "//");
    try { fs.symlinkSync(path.join(root, "real"), path.join(root, "link"), "junction"); fs.symlinkSync(outside, path.join(realDist, "escape"), "junction"); } catch { return; }       // no link support here: nothing to prove
    const scratch = "C:\\scratch\\appdata\\claude-code-router", t = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
    const run = (script, distDir) => S.stopRefusals({ rows: [{ pid: 100, ppid: 1, cmd: "x claude-code-router daemon-child", created: t(0) }, { pid: 500, ppid: 100, cmd: `node --require ${scratch}\\p.cjs ${script}`, created: t(10) }],
      pid: 500, daemonPid: 100, coreHolder: 500, webHolder: 100, listens: { bad: [], rec: [39457] }, corePort: 39457, expect: { scratchDir: scratch, realDir: "C:\\r\\claude-code-router", distDir }, selfPid: 7, ancestors: [8] });
    const linkDist = path.join(root, "link", "node_modules", "pkg", "dist", "main");
    assert.deepEqual(run(path.join(realDist, "gateway-bootstrap.js"), linkDist), [], "the install spelled through the link, the process through the target");
    assert.deepEqual(run(path.join(linkDist, "gateway-bootstrap.js"), realDist), [], "and the other way round");
    assert.ok(run(path.join(realDist, "escape", "gateway-bootstrap.js"), linkDist).some((x) => /is not under the installed CCR dist/.test(x)), "a script that LOOKS inside the dist but resolves outside is refused");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("R3-5 a failed reset keeps the worker DIRTY: the next reset tries again (a refusal used to clear the flag, so cooling leaked into every later scenario); a run that throws marks the worker dirty too", async () => {
  const live = await virtualSandbox({ liveSvcText: JSON.stringify({ pid: 500 }) }), q = prims(live);
  q.markDirty();
  await assert.rejects(() => q.reset(), /REFUSED/);
  await assert.rejects(() => q.reset(), /REFUSED/, "the second reset must not skip the replacement");
  const ok = await virtualSandbox(), w = prims(ok);
  w.markDirty(); await w.reset(); await w.reset();
  assert.deepEqual(ok.V.stopped, [500], "after a successful replacement the flag is cleared: no second stop");
  let dirty = 0;
  const res = await S.runScenarios({ reset: async () => { throw new Error("REFUSED to stop"); }, markDirty: () => { dirty += 1; } }, { only: ["4", "5"] });
  assert.deepEqual(res.map((r) => r.result.verdict), ["FAIL", "FAIL"]);
  assert.equal(dirty, 2, "each throwing run marked the worker dirty");
});

test("R3-6 fail-closed guards: a drive-root, '.', 'c:' or empty dist and a dist under 3 segments refuse; a relative or rooted-without-drive script refuses; the real-shaped link and target still accepts", async () => {
  assert.equal(S.insideDir(S.canonPath("c:/a/x.js"), S.canonPath("c:/")), true, "the probe that motivates the depth guard: insideDir alone accepts anything on a drive root");
  assert.deepEqual(["C:\\a\\b", "\\\\host\\share\\a", "c:\\"].map(S.absoluteLocal), [true, true, true]);          // a drive root is absolute: the DEPTH guard is what refuses it
  assert.deepEqual(["\\x.js", "c:x.js", "harness\\x.js", ".", "", undefined].map(S.absoluteLocal), [false, false, false, false, false, false]);
  assert.deepEqual(["c:", "c:\\a\\b", "c:\\a\\b\\c", "\\\\host\\share", "\\\\host\\share\\a\\b\\c", ""].map(S.depthBelowRoot), [0, 2, 3, 0, 3, 0]);
  const t = (ms) => new Date(1_800_000_000_000 + ms).toISOString();
  const scratch = "C:\\scratch\\appdata\\claude-code-router", real = "C:\\Users\\me\\AppData\\Roaming\\claude-code-router";
  const run = (script, distDir) => S.stopRefusals({ rows: [{ pid: 100, ppid: 1, cmd: "x claude-code-router daemon-child", created: t(0) }, { pid: 500, ppid: 100, cmd: `node --require ${scratch}\\p.cjs ${script}`, created: t(10) }],
    pid: 500, daemonPid: 100, coreHolder: 500, webHolder: 100, listens: { bad: [], rec: [39457] }, corePort: 39457, expect: { scratchDir: scratch, realDir: real, distDir }, selfPid: 7, ancestors: [8] });
  const DEEP = "C:\\ccr\\node_modules\\@musistudio\\claude-code-router\\dist\\main";
  assert.deepEqual(run(`${DEEP}\\gateway-bootstrap.js`, DEEP), []);
  for (const dist of ["C:\\", "c:/", "C:", ".", "", "C:\\a", "C:\\a\\b", "\\\\host\\share\\a\\b"]) assert.ok(run("C:\\a\\x.js", dist).length > 0, `dist ${JSON.stringify(dist)} refuses`);
  assert.ok(run("C:\\a\\b\\x.js", "C:\\a\\b").some((x) => /too shallow/.test(x)), "two segments is not a package directory");
  assert.ok(run("C:\\a\\x.js", "C:\\").some((x) => /too shallow|not under/.test(x)) && run("C:\\a\\x.js", "C:\\").some((x) => /too shallow/.test(x)), "a drive root names the depth guard, not only the prefix test");
  for (const script of ["harness\\x.js", "\\x.js", "c:x.js", "..\\x.js"]) assert.ok(run(script, DEEP).some((x) => /is not an absolute path/.test(x)), `script ${script}`);
  assert.ok(run(`${DEEP}\\gateway-bootstrap.js`, "relative\\dist\\main").some((x) => /pinned CCR dist .* is not an absolute path/.test(x)));
  const v = await virtualSandbox({ installCli: `${LINK}${PKG}\\cli.js`, workerDist: `${TARGET}${PKG}`, realMap: linkToTarget });
  assert.equal((await prims(v).restartWorker()).changed, true, "the real shape (link and target, deep dist) is still accepted");
  const shallow = await virtualSandbox({ installCli: "C:\\cli.js", workerDist: "C:\\", realMap: null });
  await assert.rejects(() => prims(shallow).restartWorker(), /too shallow/);
  assert.deepEqual(shallow.V.stopped, []);
});

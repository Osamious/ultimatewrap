// `subagent-policy selftest` (plan 7.2 item 12, stage S2c): the plan print, the approval ceremony and the assertion code. NOTHING here starts a sandbox, a daemon or Claude Code: the
// run is driven through the injected runner seam with a fake stub transcript and a fake agent log. The approval file is ONE fixed real path that no flag can move, so every test that
// writes or consumes an approval injects `opts.selftest.approvalFile` (a fixture folder); the real file is asserted absent before and after the whole file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cp from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as lib from "../keysync/subagent-policy.mjs";
import * as st from "../keysync/subagent-selftest.mjs";
import { EXECUTED_FILES as G1_FILES, REPO_ROOT } from "../harness/subagent-sandbox-spec.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_APPROVAL = lib.SELFTEST_APPROVAL_FILE;
const realBefore = fs.existsSync(REAL_APPROVAL);
after(() => { assert.equal(realBefore, false, "no real approval existed when this file started"); assert.equal(fs.existsSync(REAL_APPROVAL), false, "no test left a real approval file behind"); });
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-st-")); made.push(d); return d; };
after(() => { for (const d of made) if (path.dirname(d) === os.tmpdir() && path.basename(d).startsWith("uw-st-")) fs.rmSync(d, { recursive: true, force: true }); });
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
// the plan ids of the plan document, and the check labels of an earlier draft (S1, S2): none may reach a user
const INTERNAL_ID = /\b(?:D-[a-z]{1,2}|cr-[A-Za-z0-9]+|R-v2-\d+|ar-\d+|n:1|I\d{2}|QB-\d+|S\d+)\b/;
const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
const dirHash = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = sha(fs.readFileSync(f)); } };
  walk(dir);
  return out;
};
function setup() { const dir = tmp(); return { dir, approval: path.join(dir, "approval", "selftest-approval.json") }; }
async function run(argv, opts = {}) {
  const out = [], err = [];
  const status = await lib.runSubagentPolicy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, opts);
  return { status, out: out.join("\n"), err: err.join("\n"), first: err[0] ?? out[0] ?? "", lines: out };
}
const FILES = st.EXECUTED_FILES.map((file) => ({ file, raw: sha(`raw:${file}`), lf: sha(`lf:${file}`) }));
const PLAN = st.planOf();
const typed12 = PLAN.sha.slice(0, 12);

// ---- a fake stub transcript in the shape harness/stub-upstream.mjs keeps, and a fake sandbox agents.jsonl (only what the assertions read)
const rec = (shape, model, over = {}) => ({ seq: 1, method: "POST", path: "/v1/messages", model,
  headers: shape === "sub" || shape === "aux" ? { "x-claude-code-agent-id": "uws0-agent-1", "x-claude-code-session-id": "uws0-main" } : { "x-claude-code-session-id": "uws0-main" },
  toolNames: shape === "sub" || shape === "main" ? ["Agent", "Bash"] : [], ...over });
const GOOD = [rec("main", "uwstub/m-main"), rec("sub", st.EXPECT.policy), rec("aux", st.EXPECT.helperAsked)];
const LOG = [{ v: 2, aid: "uws0-agent-1", asked: st.EXPECT.asked, ret: st.EXPECT.policy, pol: "enforce", act: "substitute", path: "new" }];
const seams = (s, over = {}) => ({ approvalFile: s.approval, interactive: () => true, ask: async () => typed12, now: () => NOW, pid: 4242, hashFiles: () => FILES, runnerPresent: () => true, run: async () => ({ records: GOOD, agentLog: LOG }), ...over });
/** The flags of a real approve or run: --live yes always (no fixture flag exists for this command); the approval file is the injected fixture one. */
const ST = (s, args, over) => run(["selftest", ...args, "--live", "yes"], { selftest: seams(s, over) });

// =====================================================================================================================
// --plan yes: no data file, no process
// =====================================================================================================================
const COLD = `
import fs from "node:fs"; import fsp from "node:fs/promises"; import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";
const [mode, libUrl, stUrl] = process.argv.slice(1);
const lib = await import(libUrl); await import(stUrl);                 // loading the program is allowed and happens BEFORE the hook is armed
const { readFileSync: namedRead } = await import("node:fs");            // a named import taken before the hook: its binding must be patched too
const calls = [];
const FS = /^(read|write|append|exists|stat|lstat|readdir|open|mkdir|rename|rm|unlink|access|copy|realpath|mkdtemp|opendir|cp|symlink|link|chmod|truncate|create|watch)/;
const saved = [];
const patch = (holder, label, names) => { for (const n of names) { const o = holder[n]; if (typeof o !== "function") continue; saved.push([holder, n, o]); holder[n] = function () { calls.push(label + "." + n); throw new Error(label + "." + n + " was called"); }; } };
patch(fs, "fs", Object.keys(fs).filter((n) => FS.test(n))); patch(fsp, "fs.promises", Object.keys(fsp).filter((n) => FS.test(n)));
patch(cp, "child_process", ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
syncBuiltinESMExports();
let status = null, out = [];
try {
  if (mode === "plan") status = await lib.runSubagentPolicy(["selftest", "--plan", "yes"], { out: (l) => out.push(l), err: (l) => out.push(l) }, {});
  else {                                                                // the hook must see every route: prove it is not vacuous
    for (const f of [() => fs.readFileSync("x"), () => namedRead("x"), () => fs.existsSync("x"), () => fsp.stat("x"), () => cp.spawnSync("x"), () => cp.execFileSync("x")]) { try { await f(); } catch { /* expected */ } }
  }
} finally { for (const [h, n, o] of saved) h[n] = o; syncBuiltinESMExports(); }
process.stdout.write(JSON.stringify({ status, out, calls }));
`;
const cold = (mode) => {
  const r = cp.spawnSync(process.execPath, ["--input-type=module", "-e", COLD, mode, pathToFileURL(path.join(ROOT, "keysync", "subagent-policy.mjs")).href, pathToFileURL(path.join(ROOT, "keysync", "subagent-selftest.mjs")).href], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("selftest --plan yes: prints what a run would do and its plan hash; in a COLD process every fs route (sync, promises, a named import) and every child_process route throws if used, and none is", async () => {
  const probe = cold("probe");
  assert.deepEqual(probe.calls.sort(), ["child_process.execFileSync", "child_process.spawnSync", "fs.existsSync", "fs.openSync", "fs.promises.stat", "fs.readFileSync"].sort(), "the hook sees sync, promises and process routes, and a named import captured BEFORE it (it still reaches the patched openSync): it is not vacuous");
  const r = cold("plan");
  assert.deepEqual(r.calls, [], "the plan reads no data file and starts no process");
  assert.equal(r.status, 0, r.out.join("\n"));
  const lines = r.out, blank = lines.indexOf("");
  assert.ok(blank > 0);
  assert.equal(lines[blank + 1], `plan sha256: ${PLAN.sha}`);
  assert.equal(sha(lines.slice(0, blank).join("\n") + "\n"), PLAN.sha, "the printed hash is the sha256 of exactly the printed plan text");
  const text = lines.join("\n");
  assert.match(lines[0], /^NOT YET RUNNABLE: the sandbox runner harness\/subagent-scenarios\.mjs is not delivered, so a run is refused and an approval cannot be written yet\.$/);
  assert.match(text, /`selftest --plan yes` prints this text and its hash; it reads no data file and starts no process \(loading the program itself is not counted\)/);
  assert.match(text, /spawn +the subagent's request reached the stub on the model the policy chose \(uwstub\/m-free\), not on the one the subagent asked for \(uwstub\/m-big\), AND the sandbox router's agent log shows/);
  assert.match(text, /helper +a helper call .* was left on the model it asked for \(uwstub\/m-big\)/);
  assert.match(text, /a check that sees no matching request FAILS/);
  assert.match(text, /that proves the plan and the files are unchanged since, not that a human typed it/);
  assert.match(text, /never touched: the live gateway and its ports, your key vault, the real policy files, the real Claude settings, the live router file/);
  for (const f of st.EXECUTED_FILES) assert.ok(lines.includes(`  ${f}`), f);
  assert.doesNotMatch(text, INTERNAL_ID);
  assert.equal(cold("plan").out.join("\n"), text, "deterministic: the same text and hash on any day");
  assert.equal((await run(["selftest", "--plan", "yes"])).out, text, "in process, the same text");
});

test("selftest: the plan pins the whole set the harness's own plan pins, plus the runner and both modules of this command; the plan hash changes with the text", () => {
  const rel = (f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/");
  for (const f of G1_FILES.map(rel)) assert.ok(st.EXECUTED_FILES.includes(f), `the harness pins ${f}`);
  for (const f of ["router/uw-router.next.cjs", "harness/subagent-scenarios.mjs", "keysync/subagent-policy.mjs", "keysync/subagent-selftest.mjs"]) assert.ok(st.EXECUTED_FILES.includes(f), f);
  assert.equal(new Set(st.EXECUTED_FILES).size, st.EXECUTED_FILES.length);
  assert.ok(Object.isFrozen(st.EXECUTED_FILES));
  const a = st.planOf(), b = { sha: sha([...a.lines, "one more line"].join("\n") + "\n") };
  assert.notEqual(a.sha, b.sha);
  assert.match(a.sha, /^[0-9a-f]{64}$/);
  assert.equal(st.RUNNER_DELIVERED, false);
  assert.ok(a.lines[0].startsWith("NOT YET RUNNABLE"));
});

// =====================================================================================================================
// the flag rules
// =====================================================================================================================
test("selftest flag rules: no file flag exists (an approval cannot be steered), a bare selftest is a usage error, the three steps are exclusive, a real approve or run needs --live yes", () => {
  const bad = (argv, re) => assert.throws(() => lib.parseArgs(argv), (e) => e.code === "E_USAGE" && e.exit === 1 && re.test(e.message), argv.join(" "));
  bad(["selftest", "--state-dir", "x", "--run", "yes", "--live", "yes"], /unknown or not applicable flag --state-dir for selftest/);
  bad(["selftest", "--policy-file", "x"], /unknown or not applicable flag --policy-file for selftest/);
  bad(["selftest", "--plan"], /needs an explicit value/);
  bad(["selftest", "--plan", "yes", "--run", "yes"], /separate steps: give one/);
  bad(["selftest", "--approve-plan", "yes", "--run", "yes"], /separate steps/);
  bad(["selftest", "--run", "yes"], /selftest with no file flags writes the REAL files .*g1-selftest-approval\.json; pass --live yes/);
  bad(["selftest", "--approve-plan", "yes"], /pass --live yes/);
  bad(["selftest", "--run", "maybe"], /takes exactly yes or no/);
  bad(["selftest", "extra"], /unexpected argument "extra" for selftest/);
  assert.doesNotThrow(() => lib.parseArgs(["selftest", "--plan", "yes"]));
  assert.doesNotThrow(() => lib.parseArgs(["selftest", "--run", "yes", "--live", "yes"]));
  assert.equal(lib.parseArgs(["selftest", "--approve-plan", "yes", "--live", "yes"]).flags["approve-plan"], true);
  assert.equal(path.basename(REAL_APPROVAL), "g1-selftest-approval.json");
  assert.equal(path.dirname(REAL_APPROVAL), path.join(ROOT, "harness"));
  assert.equal(st.realSeams().approvalFile, REAL_APPROVAL, "the approval is at ONE fixed real path");
});

test("selftest with no step: usage, exit 1, nothing read or written", async () => {
  const s = setup(); fs.mkdirSync(path.dirname(s.approval));
  const before = dirHash(s.dir);
  const r = await ST(s, []);
  assert.equal(r.status, 1);
  assert.match(r.first, /^E_USAGE: usage: subagent-policy selftest --plan yes \| --approve-plan yes --live yes/);
  assert.deepEqual(dirHash(s.dir), before);
});

// =====================================================================================================================
// a run without an approval, and a forged approval
// =====================================================================================================================
test("selftest --run yes with no approval file exits 1 E_PRECONDITION, tells how to approve, writes nothing and never calls the runner", async () => {
  const s = setup(); fs.mkdirSync(path.dirname(s.approval));
  const before = dirHash(s.dir);
  let ran = 0;
  const r = await ST(s, ["--run", "yes"], { run: async () => { ran += 1; return { records: GOOD, agentLog: LOG }; } });
  assert.equal(r.status, 1);
  assert.match(r.first, /^E_PRECONDITION: refusing to run: no approval file: run `node keysync\/key\.mjs subagent-policy selftest --plan yes`, read it, then `selftest --approve-plan yes --live yes` in a terminal \(an owner act\)$/);
  assert.equal(ran, 0);
  assert.deepEqual(dirHash(s.dir), before);
});

test("selftest: a forged approval placed where a fixture --state-dir used to choose it is IGNORED (no flag can name the approval file), and the run still finds none", async () => {
  const s = setup();
  const forged = path.join(s.dir, "state", "subagent", "selftest-approval.json");
  fs.mkdirSync(path.dirname(forged), { recursive: true });
  fs.writeFileSync(forged, JSON.stringify({ schema: 1, planSha256: PLAN.sha, approvedAt: new Date(NOW).toISOString(), files: FILES }));
  fs.mkdirSync(path.dirname(s.approval));
  let ran = 0;
  const r = await ST(s, ["--run", "yes"], { run: async () => { ran += 1; return { records: GOOD, agentLog: LOG }; } });
  assert.equal(r.status, 1); assert.match(r.first, /refusing to run: no approval file/); assert.equal(ran, 0);
  const viaFlag = await run(["selftest", "--run", "yes", "--live", "yes", "--state-dir", path.join(s.dir, "state")], { selftest: seams(s) });
  assert.equal(viaFlag.status, 1); assert.match(viaFlag.first, /^E_USAGE: unknown or not applicable flag --state-dir for selftest$/);
  assert.equal(fs.existsSync(forged), true, "the forged file was neither read nor consumed");
});

// =====================================================================================================================
// the approval (an owner act)
// =====================================================================================================================
test("selftest --approve-plan yes: needs a terminal, a delivered runner, and the typed first 12 hex characters of THIS plan hash; anything else writes nothing", async () => {
  const s = setup();
  const before = dirHash(s.dir);
  const noTty = await ST(s, ["--approve-plan", "yes"], { interactive: () => false });
  assert.equal(noTty.status, 1); assert.match(noTty.first, /^E_PRECONDITION: --approve-plan is an owner act and needs an interactive terminal/);
  const noRunner = await ST(s, ["--approve-plan", "yes"], { runnerPresent: () => false });
  assert.equal(noRunner.status, 1); assert.match(noRunner.first, /^E_PRECONDITION: refusing to approve: the sandbox runner harness\/subagent-scenarios\.mjs is not delivered yet, so there is nothing an approval could start; nothing was written$/);
  for (const typed of ["", "yes", PLAN.sha.slice(0, 11), PLAN.sha.slice(1, 13), PLAN.sha, typed12.toUpperCase()]) {
    const r = await ST(s, ["--approve-plan", "yes"], { ask: async () => typed });
    assert.equal(r.status, 1, JSON.stringify(typed)); assert.match(r.first, /the typed confirmation does not match the plan sha256: nothing was approved/);
  }
  const absent = await ST(s, ["--approve-plan", "yes"], { hashFiles: () => FILES.map((f, i) => (i === 0 ? { ...f, raw: "(absent)", lf: "(absent)" } : f)) });
  assert.equal(absent.status, 1); assert.match(absent.first, /refusing to approve: .* cannot be read/);
  assert.deepEqual(dirHash(s.dir), before, "no refusal wrote an approval");
  const ok = await ST(s, ["--approve-plan", "yes"], { ask: async () => `${typed12}\r\n` });
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.out, new RegExp(`^approving the plan whose sha256 begins ${typed12}; read it first with `, "m"));
  assert.match(ok.out, new RegExp(`approval written: .*selftest-approval\\.json \\(plan sha256 ${PLAN.sha}; ONE-USE, valid 24 h; run it with `));
  const doc = JSON.parse(fs.readFileSync(s.approval, "utf8"));
  assert.deepEqual(Object.keys(doc), ["schema", "planSha256", "approvedAt", "files"]);
  assert.equal(doc.planSha256, PLAN.sha); assert.equal(doc.approvedAt, new Date(NOW).toISOString()); assert.deepEqual(doc.files, FILES);
  assert.deepEqual(fs.readdirSync(path.dirname(s.approval)), ["selftest-approval.json"], "written atomically: no temp file is left");
});

test("selftest approval cannot be scripted: a piped, non-terminal run (what a program with plain pipes has) is refused and writes no approval; typing the hash is documented as not proving a human", () => {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, "keysync", "key.mjs"), "subagent-policy", "selftest", "--approve-plan", "yes", "--live", "yes"], { input: `${typed12}\n`, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^E_PRECONDITION: --approve-plan is an owner act and needs an interactive terminal/);
  assert.equal(fs.existsSync(REAL_APPROVAL), false);
  assert.match(st.planLines().join("\n"), /not that a human typed it/);
  assert.match(fs.readFileSync(path.join(ROOT, "keysync", "subagent-selftest.mjs"), "utf8"), /does NOT prove a human acted/);
});

// =====================================================================================================================
// the REAL seams (hashing the real executed list, writing and consuming an approval) in a fixture folder
// =====================================================================================================================
test("selftest real seams: hashFiles pins every executed file by raw AND line-ending-folded bytes; writeText and rename work atomically in a fixture; a symlink, junction or hard link at the target is refused", () => {
  const d = st.realSeams();
  const hashed = d.hashFiles();
  assert.deepEqual(hashed.map((h) => h.file), st.EXECUTED_FILES, "the same order as the plan lists");
  const router = hashed.find((h) => h.file === "router/uw-router.next.cjs");
  const bytes = fs.readFileSync(path.join(ROOT, "router", "uw-router.next.cjs"));
  assert.equal(router.raw, sha(bytes), "the router is pinned by its raw bytes (what is installed verbatim)");
  assert.equal(router.lf, sha(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1")));
  assert.deepEqual(hashed.find((h) => h.file === "harness/subagent-scenarios.mjs"), { file: "harness/subagent-scenarios.mjs", raw: "(absent)", lf: "(absent)" }, "the missing runner is pinned as absent, never skipped");
  for (const h of hashed.filter((x) => x.raw !== "(absent)")) { assert.match(h.raw, /^[0-9a-f]{64}$/); assert.match(h.lf, /^[0-9a-f]{64}$/); }
  const dir = tmp(), f = path.join(dir, "sub", "a.json");
  d.writeText(f, "one"); assert.equal(d.readText(f), "one");
  const inoOne = fs.statSync(f).ino;
  d.writeText(f, "two"); assert.equal(d.readText(f), "two", "an existing plain file is replaced");
  if (inoOne) assert.notEqual(fs.statSync(f).ino, inoOne, "replaced by a rename (a new file), never written in place through whatever the old name pointed at");
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ["a.json"], "no temp file left");
  const used = `${f}.used-1-2`; d.rename(f, used); assert.equal(d.readText(used), "two"); assert.equal(d.readText(f), null); d.rm(used); assert.equal(fs.existsSync(used), false);
  // a hard link at the target: refused for the write and for the consume
  const h1 = path.join(dir, "h1.json"), h2 = path.join(dir, "h2.json"); fs.writeFileSync(h1, "x"); fs.linkSync(h1, h2);
  assert.throws(() => d.writeText(h1, "forged"), (e) => e.code === "E_PRECONDITION" && /not a plain single-link file/.test(e.message));
  assert.throws(() => d.rename(h1, `${h1}.used`), (e) => e.code === "E_PRECONDITION");
  assert.equal(fs.readFileSync(h2, "utf8"), "x", "the other name of the linked file was not written through");
  // a directory junction as the parent: refused
  const real = path.join(dir, "real"), junction = path.join(dir, "junction"); fs.mkdirSync(real);
  fs.symlinkSync(real, junction, "junction");
  assert.throws(() => d.writeText(path.join(junction, "a.json"), "forged"), (e) => e.code === "E_PRECONDITION" && /symbolic link or junction/.test(e.message));
  assert.deepEqual(fs.readdirSync(real), [], "nothing was written through the junction");
  // a file symlink as the target (needs a privilege on some Windows setups: the check is made when the link could be made)
  const target = path.join(dir, "target.json"), link = path.join(dir, "link.json"); fs.writeFileSync(target, "t");
  let linked = false; try { fs.symlinkSync(target, link, "file"); linked = true; } catch { /* no privilege to create a file symlink */ }
  if (linked) { assert.throws(() => d.writeText(link, "forged"), (e) => e.code === "E_PRECONDITION"); assert.equal(fs.readFileSync(target, "utf8"), "t"); }
  assert.throws(() => st.assertPlainTarget(path.join(dir, "real")), (e) => e.code === "E_PRECONDITION" && /not a plain single-link file/.test(e.message), "a directory is not an approval file");
  assert.doesNotThrow(() => st.assertPlainTarget(path.join(dir, "does-not-exist.json")));
});

// =====================================================================================================================
// a run with an approval
// =====================================================================================================================
const approve = async (s, over = {}) => { fs.mkdirSync(path.dirname(s.approval), { recursive: true }); const r = await ST(s, ["--approve-plan", "yes"], over); assert.equal(r.status, 0, r.err); };

test("selftest --run yes with a valid approval: consumes it (ONE use), calls the runner once with the plan and the expected models, prints PASS lines and exits 0; a second run is refused", async () => {
  const s = setup(); await approve(s);
  const calls = [];
  const r = await ST(s, ["--run", "yes"], { run: async (a) => { calls.push(a); return { records: GOOD, agentLog: LOG }; } });
  assert.equal(r.status, 0, r.err);
  assert.equal(calls.length, 1); assert.equal(calls[0].plan.sha, PLAN.sha); assert.deepEqual(calls[0].expect, st.EXPECT);
  assert.match(r.out, new RegExp(`^approval consumed \\(plan sha256 ${PLAN.sha}\\); starting the sandbox self-test$`, "m"));
  assert.match(r.out, /^PASS spawn all 1 subagent request reached the stub on the policy's model uwstub\/m-free, and the router's agent log shows 1 of 1 line for it asking uwstub\/m-big and returned uwstub\/m-free$/m);
  assert.match(r.out, /^PASS helper all 1 helper request stayed on the model asked for, uwstub\/m-big$/m);
  assert.match(r.out, /^self-test: 2 of 2 checks passed; OK$/m);
  assert.doesNotMatch(r.out, INTERNAL_ID);
  assert.deepEqual(fs.readdirSync(path.dirname(s.approval)), [], "the approval and its used copy are gone");
  const again = await ST(s, ["--run", "yes"], { run: async () => { throw new Error("must not run twice"); } });
  assert.equal(again.status, 1); assert.match(again.first, /refusing to run: no approval file/);
});

test("selftest --run yes: a runner whose transcript or agent log fails an assertion exits 1 NOT OK with the FAIL line", async () => {
  const s = setup(); await approve(s);
  const r = await ST(s, ["--run", "yes"], { run: async () => ({ records: [rec("sub", st.EXPECT.asked), rec("aux", st.EXPECT.helperAsked)], agentLog: LOG }) });
  assert.equal(r.status, 1);
  assert.match(r.out, /^FAIL spawn 1 of 1 subagent requests did not reach the policy's model uwstub\/m-free \(the stub received: uwstub\/m-big\)$/m);
  assert.match(r.out, /^PASS helper /m);
  assert.match(r.out, /^self-test: 1 of 2 checks passed; NOT OK$/m);
  const s2 = setup(); await approve(s2);
  const noLog = await ST(s2, ["--run", "yes"], { run: async () => ({ records: GOOD }) });
  assert.equal(noLog.status, 1); assert.match(noLog.out, /^FAIL spawn the stub received the policy's model uwstub\/m-free, but the router's agent log has 0 lines/m);
});

test("selftest --run yes: every way an approval can be wrong refuses BEFORE it is consumed (the file is still there, byte for byte) and the runner is never called", async () => {
  const s = setup(); await approve(s);
  const good = fs.readFileSync(s.approval, "utf8");
  let ran = 0;
  const run_ = async () => { ran += 1; return { records: GOOD, agentLog: LOG }; };
  const doc = JSON.parse(good);
  const cases = [
    ["a different plan", () => fs.writeFileSync(s.approval, JSON.stringify({ ...doc, planSha256: "0".repeat(64) })), {}, /the approval is for a different plan \(approved 000000000000, current /],
    ["older than 24 h", () => {}, { now: () => NOW + 25 * 3600000 }, /the approval is 25 h old \(valid 24 h\)/],
    ["dated in the future", () => {}, { now: () => NOW - 10 * 60000 }, /dated in the future/],
    ["a file changed (raw bytes)", () => {}, { hashFiles: () => FILES.map((f, i) => (i === 0 ? { ...f, raw: "f".repeat(64) } : f)) }, new RegExp(`a file the run executes changed since you approved \\(${FILES[0].file.replace(/[.\\/]/g, "\\$&")}\\)`)],
    ["a file changed (line-ending-folded bytes only)", () => {}, { hashFiles: () => FILES.map((f, i) => (i === 1 ? { ...f, lf: "e".repeat(64) } : f)) }, new RegExp(`changed since you approved \\(${FILES[1].file.replace(/[.\\/]/g, "\\$&")}\\)`)],
    ["a file is missing now", () => {}, { hashFiles: () => FILES.map((f, i) => (i === 2 ? { ...f, raw: "(absent)", lf: "(absent)" } : f)) }, /changed since you approved/],
    ["the wrong shape", () => fs.writeFileSync(s.approval, JSON.stringify({ schema: 2 })), {}, /the approval file has the wrong shape/],
    ["not JSON", () => fs.writeFileSync(s.approval, "not json"), {}, /the approval file is not valid JSON/],
    ["an unreadable time", () => fs.writeFileSync(s.approval, JSON.stringify({ ...doc, approvedAt: "yesterday" })), {}, /the approval timestamp is unreadable/],
    ["no runner yet", () => {}, { run: null }, /the sandbox runner harness\/subagent-scenarios\.mjs is not delivered yet, so there is nothing to start; your approval was not used/],
    ["the runner file is absent", () => {}, { runnerPresent: () => false }, /not delivered yet/],
  ];
  for (const [name, arrange, over, re] of cases) {
    fs.writeFileSync(s.approval, good); arrange();
    const kept = fs.readFileSync(s.approval, "utf8");
    const r = await ST(s, ["--run", "yes"], { run: run_, ...over });
    assert.equal(r.status, 1, name); assert.match(r.first, /^E_PRECONDITION: refusing to run: /, name); assert.match(r.first, re, name);
    assert.equal(fs.readFileSync(s.approval, "utf8"), kept, `${name}: the approval is not consumed`);
  }
  assert.equal(ran, 0);
});

test("selftest --run yes: if the approval cannot be consumed (a racing run took it, or it is a link) or the consumed bytes are not the ones checked, nothing runs", async () => {
  const s = setup(); await approve(s);
  let ran = 0;
  const go = async () => { ran += 1; return { records: GOOD, agentLog: LOG }; };
  const raced = await ST(s, ["--run", "yes"], { run: go, rename: () => { throw new Error("gone"); } });
  assert.equal(raced.status, 1); assert.match(raced.first, /the approval could not be consumed \(another run may have used it first/);
  const swapped = await ST(s, ["--run", "yes"], { run: go, readText: (f) => (f.includes(".used-") ? "{}" : fs.readFileSync(f, "utf8")) });
  assert.equal(swapped.status, 1); assert.match(swapped.first, /the consumed approval is not the file that was checked/);
  assert.equal(ran, 0);
});

// =====================================================================================================================
// the assertion code against a fake stub transcript and a fake agent log
// =====================================================================================================================
test("assertSelftest: PASS only when a subagent request carried the policy's model, the router's own log shows it chose it (asked != returned == policy), AND a helper call stayed on asked; each fails on its own wrong evidence", () => {
  const ok = st.assertSelftest(GOOD, st.EXPECT, LOG);
  assert.equal(ok.ok, true); assert.deepEqual(ok.checks.map((c) => [c.id, c.ok]), [["spawn", true], ["helper", true]]);
  // spawn fails: the subagent ran on what it ASKED for (the policy did nothing)
  const s1 = st.assertSelftest([rec("sub", st.EXPECT.asked), rec("aux", st.EXPECT.helperAsked)], st.EXPECT, LOG);
  assert.deepEqual(s1.checks.map((c) => c.ok), [false, true]); assert.match(s1.lines[0], /^FAIL spawn 1 of 1 subagent requests did not reach the policy's model uwstub\/m-free \(the stub received: uwstub\/m-big\)$/);
  const mixed = st.assertSelftest([rec("sub", st.EXPECT.policy), rec("sub", st.EXPECT.asked), rec("aux", st.EXPECT.helperAsked)], st.EXPECT, LOG);
  assert.match(mixed.lines[0], /^FAIL spawn 1 of 2 subagent requests did not reach/);
  // VACUOUS: the stub received the policy's model, but the router never decided it: the subagent ASKED for it, so the log shows asked == returned
  const vacuous = [{ ...LOG[0], asked: st.EXPECT.policy }];
  for (const log of [vacuous, [], undefined, null, "x", [null, 3, {}], [{ ...LOG[0], aid: "someone-else" }], [{ ...LOG[0], aid: "" }], [{ ...LOG[0], aid: 12 }], [{ ...LOG[0], path: "handoff" }], [{ ...LOG[0], ret: st.EXPECT.asked }]]) {
    const v = st.assertSelftest(GOOD, st.EXPECT, log);
    assert.equal(v.checks[0].ok, false, JSON.stringify(log));
    assert.match(v.lines[0], /^FAIL spawn the stub received the policy's model uwstub\/m-free, but the router's agent log has \d+ lines? for the spawned agent and none shows asked != returned == that model: nothing shows the router chose it$/);
    assert.equal(v.checks[1].ok, true, "the helper check is judged on its own evidence");
  }
  // an empty logged agent id is a prefix of every id: it must never stand in for the spawned agent, while the real 12-character id (and a clipped prefix of it) does
  assert.equal(st.assertSelftest(GOOD, st.EXPECT, [{ ...LOG[0], aid: "" }]).checks[0].ok, false);
  assert.equal("uws0-agent-1".length, 12);
  assert.equal(st.assertSelftest(GOOD, st.EXPECT, [{ ...LOG[0], aid: "uws0-agent-1" }]).checks[0].ok, true);
  assert.equal(st.assertSelftest(GOOD, st.EXPECT, [{ ...LOG[0], aid: "uws0-agent" }]).checks[0].ok, true);
  assert.equal(st.assertSelftest(GOOD, st.EXPECT, [{ ...LOG[0], aid: "" }, { ...LOG[0], aid: "uws0-agent-1" }]).checks[0].ok, true, "the real line still counts next to an empty one");
  // the bare spelling of the model in the log counts too; a longer logged id is matched by prefix the way the router clips it
  assert.equal(st.assertSelftest([rec("sub", "m-free", { headers: { "x-claude-code-agent-id": "uws0-agent-1-long-id" } }), rec("aux", "m-big")], st.EXPECT, [{ ...LOG[0], aid: "uws0-agent-1", asked: "m-big", ret: "m-free" }]).checks[0].ok, true);
  // helper fails: a helper call was MOVED
  const s2 = st.assertSelftest([rec("sub", st.EXPECT.policy), rec("aux", st.EXPECT.policy)], st.EXPECT, LOG);
  assert.deepEqual(s2.checks.map((c) => c.ok), [true, false]); assert.match(s2.lines[1], /^FAIL helper 1 of 1 helper requests were moved off uwstub\/m-big \(the stub received: uwstub\/m-free\)$/);
  // no subagent at all: nothing is proved, never a pass by omission
  const nosub = st.assertSelftest([rec("main", "uwstub/m-main"), rec("aux", st.EXPECT.helperAsked)], st.EXPECT, LOG);
  assert.match(nosub.lines[0], /^FAIL spawn no subagent request \(an agent id and tools\) reached the stub among 2 requests: the spawn never happened, so nothing is proved$/);
  const noaux = st.assertSelftest([rec("sub", st.EXPECT.policy)], st.EXPECT, LOG);
  assert.match(noaux.lines[1], /^FAIL helper no helper request \(an agent id and no tools\) reached the stub among 1 request: nothing proves helper calls stay on the model they ask for$/);
  for (const empty of [[], undefined, null, "x", [{}]]) { const e = st.assertSelftest(empty, st.EXPECT, LOG); assert.equal(e.ok, false); assert.equal(e.checks.length, 2); }
  assert.equal(st.assertSelftest([rec("sub", "m-free"), rec("aux", "m-big")], st.EXPECT, [{ ...LOG[0], ret: "m-free" }]).ok, true, "the bare spelling of a model counts as the model");
  assert.equal(st.assertSelftest([rec("sub", st.EXPECT.policy, { path: "/v1/models" }), rec("aux", st.EXPECT.helperAsked)], st.EXPECT, LOG).checks[0].ok, false, "only /v1/messages requests count");
  const same = st.assertSelftest(GOOD, { asked: "uwstub/m-big", policy: "uwstub/m-big", helperAsked: "uwstub/m-big" }, LOG);
  assert.match(same.lines[0], /^FAIL spawn the self-test is set up wrongly: /);
  const hostile = st.assertSelftest([rec("sub", "evil\u001b[31m\u202e"), rec("aux", st.EXPECT.helperAsked)], st.EXPECT, LOG);
  assert.ok(!/[\u0000-\u001f\u007f-\uffff]/.test(hostile.lines[0]));
  assert.deepEqual(["sub", "aux", "main", "other"], [st.shapeOf(rec("sub", "m")), st.shapeOf(rec("aux", "m")), st.shapeOf(rec("main", "m")), st.shapeOf({ headers: {}, toolNames: [] })]);
});

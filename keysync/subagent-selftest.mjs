// `subagent-policy selftest` (plan 7.2 item 12, D-v, stage S2c): a headless Claude Code runs inside the isolated SANDBOX (never the live gateway), spawns one subagent, and two
// checks are made on what the stub upstream received and on the sandbox router's own agent log: (spawn) the subagent's request carried the model the policy chose, and the router's log
// shows it chose it; (helper) a helper call stayed on the model it asked for.
// The ceremony is the one of harness/subagent-e2e.mjs: `--plan yes` prints what a run would do and a plan hash and reads no data file and starts no process; `--approve-plan yes` is
// the owner's act (a terminal, the first 12 hex characters of the plan hash typed); `--run yes` needs that approval, consumes it atomically (ONE use, 24 h) and only then runs. The
// approval lives at ONE fixed real path (a test injects `opts.selftest.approvalFile`); no flag of a command line chooses it. This module never starts the sandbox itself: the runner is a
// seam (`opts.selftest.run`), which the scenario suite of the sandbox harness supplies. Without a runner an approval is refused and a run is refused BEFORE the approval is consumed.
// The assertion code is pure and is unit-tested against a fake stub transcript (records in the shape harness/stub-upstream.mjs keeps) and a fake agent log.
// Documented limit (the same as the harness approval): typing the hash proves the plan text and the executed files are unchanged since, and blocks a pipe; it does NOT prove a human acted,
// because a program that allocates a pseudo-terminal passes the terminal check.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeAtomic } from "../menu/atomic.mjs";
import { modelIs, ASKED_MODEL, TAG_MODEL } from "../harness/subagent-e2e.mjs";
import { EXECUTED_FILES as G1_FILES, REPO_ROOT, hashExecutedFiles } from "../harness/subagent-sandbox-spec.mjs";
import { PolicyError, SELFTEST_APPROVAL_FILE } from "./subagent-policy.mjs";

export const APPROVAL_MAX_AGE_MS = 24 * 3600 * 1000;
export const RUNNER_FILE = "harness/subagent-scenarios.mjs";
/** True since the runner is delivered and wired in: `realSeams().run` imports `runSelftest` of harness/subagent-scenarios.mjs on demand (nothing is imported or run until `--run` consumes an approval). ceiling: a constant, not a probe, because the plan text takes no I/O. */
export const RUNNER_DELIVERED = true;
const rel = (f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/");
const OWN_FILES = [RUNNER_FILE, "keysync/subagent-policy.mjs", "keysync/subagent-selftest.mjs"];
/** The files a run executes or loads: the whole set the harness's own plan pins (the orchestrator and what it imports, the probe router, the bootstrap, the guard and the exact router bytes), the runner, and the two modules of this command. */
export const EXECUTED_FILES = Object.freeze([...G1_FILES.map(rel), ...OWN_FILES]);
export const EXPECT = Object.freeze({ asked: ASKED_MODEL, policy: TAG_MODEL, helperAsked: ASKED_MODEL });

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const clip = (v, n = 60) => String(v ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, n);

/** What a run would do, as constants: this text is the thing the owner approves, and its sha256 is the plan hash. */
export function planLines() {
  return [
    ...(RUNNER_DELIVERED ? [] : [`NOT YET RUNNABLE: the sandbox runner ${RUNNER_FILE} is not delivered, so a run is refused and an approval cannot be written yet.`]),
    "== subagent-policy selftest PLAN (`selftest --plan yes` prints this text and its hash; it reads no data file and starts no process (loading the program itself is not counted) and contacts no service; nothing below has been run) ==",
    "what it proves: a real headless Claude Code, run against a stub model server inside the isolated sandbox, spawns a subagent; the stub records what reached it, the sandbox router writes its own agent log, and two checks are made:",
    `  spawn   the subagent's request reached the stub on the model the policy chose (${EXPECT.policy}), not on the one the subagent asked for (${EXPECT.asked}), AND the sandbox router's agent log shows that agent asked a different model and was returned the policy's`,
    `  helper  a helper call (an agent id with no tools: a title or summary call) was left on the model it asked for (${EXPECT.helperAsked})`,
    "a check that sees no matching request FAILS: with no spawn, no log line for the spawn, or no helper call, nothing is proved.",
    "what a run would do, in order:",
    "  1. refuse unless the approval file holds THIS plan's hash, is under 24 hours old and every file listed at the end is byte-identical to when you approved",
    "  2. consume the approval (it is one-use; a second run needs a fresh approval)",
    "  3. start the sandbox gateway beside the live one on its own ports and its own data folders; the live gateway is not touched or restarted",
    "  4. run the isolation checks and refuse to send a request if any is red; the sandbox runs under a tripwire that watches the real Claude settings. The fail-closed process guard is OFF (--no-preload-guard, the G1 precedent; its second consent token is derived from the orchestrator's own plan hash, so it is not an independent confirmation). The installed CCR (ccr.cmd, package version, dist/main/cli.js) is pinned in the approval and compared at the start of the run",
    "  5. start the stub model server, point the sandbox at it, install the exact router bytes below and a synthetic enforcing policy that maps the subagent's model to the stub's free model",
    "  6. DEFAULT = REPLAY: send the request shapes a real Claude Code sends (a main request, a subagent request that carries the policy's tag, one helper-shaped request); no client is started. With `selftest --run yes --live yes --real yes` (a SEPARATE, riskier mode with its own consent at --approve-plan, which also pins the claude launcher's path, sha256 and version) a real headless Claude Code (claude -p) is started instead for the spawn, pointed at the sandbox by environment only, and its isolation is checked afterwards",
    "  7. check spawn and helper on the stub's records and the router's agent log, print PASS or FAIL for each, tear the sandbox down and print whether the live gateway and files are identical before and after; the self-test is OK only when BOTH checks pass AND the sandbox run itself exited 0 (a red live-state comparison, an incomplete teardown or a refused run is NOT OK whatever the checks said)",
    "  8. keep redacted evidence outside the sandbox only when the run is refused, throws or the tripwire fires",
    `the sandbox runner is ${RUNNER_FILE}; an approval is refused, and a run is refused (before the approval is used), while that file is absent.`,
    "never touched: the live gateway and its ports, your key vault, the real policy files, the real Claude settings, the live router file, your catalogue and bench data.",
    "the approval: `selftest --approve-plan yes --live yes` (an owner act: it refuses without a terminal and needs the first 12 hex characters of the plan hash typed; that proves the plan and the files are unchanged since, not that a human typed it); a run is `selftest --run yes --live yes`.",
    "files hashed at approval (raw bytes and line-ending-folded bytes, both pinned) and again at the start of the run:",
    ...EXECUTED_FILES.map((f) => `  ${f}`),
  ];
}
export const planOf = () => { const lines = planLines(); return { lines, sha: sha256(lines.join("\n") + "\n") }; };

// ---------------------------------------------------------------- the assertions (pure)
/** sub: an agent id and tools; aux: an agent id and no tools; main: tools and no agent id; other: neither. Reads one stub record (harness/stub-upstream.mjs). */
export function shapeOf(rec) {
  const agent = !!(rec?.headers && rec.headers["x-claude-code-agent-id"]);
  const tools = Array.isArray(rec?.toolNames) && rec.toolNames.length > 0;
  return agent && tools ? "sub" : agent ? "aux" : tools ? "main" : "other";
}
const isMessages = (r) => r && (r.method === undefined || r.method === "POST") && /^\/v1\/messages(\?|$)/.test(String(r.path ?? "/v1/messages"));
const seen = (rs) => [...new Set(rs.map((r) => clip(r.model)))].join(", ") || "none";
const sameModel = (a, b) => modelIs(a, b) || modelIs(b, a);

/**
 * Judges a stub transcript and the sandbox router's agent log. `records` are the stub's records; `agentLog` the parsed lines of the sandbox's agents.jsonl; `expect` names the model the
 * subagent asked for, the one the policy chose and the one a helper call asked for. The spawn check needs BOTH: the stub received the policy's model, AND a router log line for that agent
 * shows asked != ret == the policy's model (without the log the stub could have received the policy's model because the subagent asked for it, and the router never decided anything).
 */
export function assertSelftest(records, expect = EXPECT, agentLog = undefined) {
  const rs = (Array.isArray(records) ? records : []).filter(isMessages);
  const out = [];
  const subs = rs.filter((r) => shapeOf(r) === "sub"), auxs = rs.filter((r) => shapeOf(r) === "aux");
  if (sameModel(expect.policy, expect.asked)) out.push({ ok: false, id: "spawn", text: `the self-test is set up wrongly: the policy's model (${clip(expect.policy)}) equals the model the subagent asks for (${clip(expect.asked)}), so it could never tell a changed model from an unchanged one` });
  else if (!subs.length) out.push({ ok: false, id: "spawn", text: `no subagent request (an agent id and tools) reached the stub among ${rs.length} request${rs.length === 1 ? "" : "s"}: the spawn never happened, so nothing is proved` });
  else {
    const wrong = subs.filter((r) => !modelIs(r.model, expect.policy));
    if (wrong.length) out.push({ ok: false, id: "spawn", text: `${wrong.length} of ${subs.length} subagent requests did not reach the policy's model ${clip(expect.policy)} (the stub received: ${seen(wrong)})` });
    else {
      const aids = subs.map((r) => String(r.headers["x-claude-code-agent-id"]).toLowerCase());
      const mine = (Array.isArray(agentLog) ? agentLog : []).filter((l) => l && typeof l === "object" && typeof l.aid === "string" && l.aid.length > 0 && l.path !== "handoff" && aids.some((a) => a === l.aid.toLowerCase() || a.startsWith(l.aid.toLowerCase())));
      const decided = mine.filter((l) => typeof l.ret === "string" && typeof l.asked === "string" && modelIs(l.ret, expect.policy) && !sameModel(l.asked, l.ret));
      out.push(decided.length
        ? { ok: true, id: "spawn", text: `all ${subs.length} subagent request${subs.length === 1 ? "" : "s"} reached the stub on the policy's model ${clip(expect.policy)}, and the router's agent log shows ${decided.length} of ${mine.length} line${mine.length === 1 ? "" : "s"} for it asking ${clip(decided[0].asked)} and returned ${clip(decided[0].ret)}` }
        : { ok: false, id: "spawn", text: `the stub received the policy's model ${clip(expect.policy)}, but the router's agent log has ${mine.length} line${mine.length === 1 ? "" : "s"} for the spawned agent and none shows asked != returned == that model: nothing shows the router chose it` });
    }
  }
  if (!auxs.length) out.push({ ok: false, id: "helper", text: `no helper request (an agent id and no tools) reached the stub among ${rs.length} request${rs.length === 1 ? "" : "s"}: nothing proves helper calls stay on the model they ask for` });
  else {
    const moved = auxs.filter((r) => !modelIs(r.model, expect.helperAsked));
    out.push(moved.length ? { ok: false, id: "helper", text: `${moved.length} of ${auxs.length} helper requests were moved off ${clip(expect.helperAsked)} (the stub received: ${seen(moved)})` }
      : { ok: true, id: "helper", text: `all ${auxs.length} helper request${auxs.length === 1 ? "" : "s"} stayed on the model asked for, ${clip(expect.helperAsked)}` });
  }
  return { ok: out.every((l) => l.ok), lines: out.map((l) => `${l.ok ? "PASS" : "FAIL"} ${l.id} ${l.text}`), checks: out };
}

// ---------------------------------------------------------------- the approval ceremony
const how = "run `node keysync/key.mjs subagent-policy selftest --plan yes`, read it, then `selftest --approve-plan yes --live yes` in a terminal (an owner act)";
const refuse = (m, exit = 1) => new PolicyError("E_PRECONDITION", m, exit);

/** A path the approval is written to or consumed from must be a plain file in a plain folder: a symlink or a hard link there could point the write at, or the consume away from, another file. */
export function assertPlainTarget(f, fsx = fs) {
  const link = (p) => { try { return fsx.lstatSync(p); } catch (e) { if (e?.code === "ENOENT") return null; throw refuse(`cannot inspect ${p} (${e?.code ?? "error"}): refusing`); } };
  const dir = link(path.dirname(f));
  if (dir && dir.isSymbolicLink()) throw refuse(`${path.dirname(f)} is a symbolic link or junction: refusing to use it for the approval`);
  const st = link(f);
  if (st && (st.isSymbolicLink() || !st.isFile() || st.nlink > 1)) throw refuse(`${f} is not a plain single-link file (a symbolic link or hard link could redirect the approval): refusing`);
}
const hashOne = (file) => {
  let buf = null;
  try { buf = fs.readFileSync(path.join(REPO_ROOT, file)); } catch { /* absent */ }
  if (buf === null) return { file, raw: "(absent)", lf: "(absent)" };
  return { file, raw: sha256(buf), lf: sha256(Buffer.from(Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n"), "latin1")) };
};

/** The real seams: every effect of the approval and the run goes through this object, so the unit tests drive it with fakes (and, for the file effects, with a fixture folder); `--plan yes` never builds it. */
export function realSeams() {
  return {
    approvalFile: SELFTEST_APPROVAL_FILE,
    interactive: () => !!process.stdin.isTTY && !!process.stdout.isTTY,
    ask: async (q) => { const rl = (await import("node:readline")).createInterface({ input: process.stdin, output: process.stdout }); try { return await new Promise((res) => rl.question(q, res)); } finally { rl.close(); } },
    now: () => Date.now(), pid: process.pid,
    hashFiles: () => [...hashExecutedFiles(), ...OWN_FILES.map(hashOne)],
    runnerPresent: () => fs.existsSync(path.join(REPO_ROOT, RUNNER_FILE)),
    readText: (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } },
    writeText: (f, text) => { assertPlainTarget(f); fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, text); },
    rename: (a, b) => { assertPlainTarget(a); fs.renameSync(a, b); }, rm: (f) => fs.rmSync(f, { force: true }),
    ccrLines: async () => { const m = await import("../harness/subagent-scenarios.mjs"); return m.defaultSeams().ccrLines(); },
    identifyClaude: async () => { const m = await import("../harness/subagent-scenarios.mjs"); return m.identifyClaude(); },
    run: (args, io) => import("../harness/subagent-scenarios.mjs").then((m) => m.runSelftest(args, io)),     // lazy: loading this module imports nothing of the sandbox harness's runner until a run is approved and consumed
  };
}

/** Why an approval does not hold, or null when it does. Pure. Each file is pinned by its raw bytes AND its line-ending-folded bytes, as the harness's own approval does. */
export function checkApproval(text, planSha, files, nowMs, pin = {}) {
  if (text == null) return `no approval file: ${how}`;
  let a;
  try { a = JSON.parse(text); } catch { return `the approval file is not valid JSON: ${how}`; }
  if (!a || a.schema !== 1 || typeof a.planSha256 !== "string" || typeof a.approvedAt !== "string") return `the approval file has the wrong shape: ${how}`;
  const at = Date.parse(a.approvedAt);
  if (!Number.isFinite(at)) return `the approval timestamp is unreadable: ${how}`;
  const age = nowMs - at;
  if (age > APPROVAL_MAX_AGE_MS) return `the approval is ${Math.round(age / 3600000)} h old (valid 24 h): ${how}`;
  if (age < -5 * 60 * 1000) return `the approval is dated in the future: ${how}`;
  if (a.planSha256 !== planSha) return `the approval is for a different plan (approved ${a.planSha256.slice(0, 12)}, current ${planSha.slice(0, 12)}): ${how}`;
  const changed = files.filter((f) => { const o = Array.isArray(a.files) ? a.files.find((x) => x && x.file === f.file) : null; return !o || o.raw !== f.raw || o.lf !== f.lf || f.raw === "(absent)"; }).map((f) => f.file);
  if (changed.length) return `a file the run executes changed since you approved (${changed.join(", ")}): ${how}`;
  if (pin.ccr !== undefined && (!Array.isArray(a.ccr) || a.ccr.join("\n") !== pin.ccr.join("\n"))) return `the installed CCR changed since you approved (or the approval does not pin it): ${how}`;
  if (pin.real && a.real !== true) return `--real yes is a separate mode and was not approved: run --approve-plan yes --live yes --real yes first`;
  if (pin.real && JSON.stringify(a.claude ?? null) !== JSON.stringify(pin.claude ?? null)) return `the claude launcher (path, sha256 or version) changed since you approved: ${how}`;
  return null;
}

export async function cmdSelftest(p, flags, io, opts = {}) {
  if (flags.plan) {                                                // nothing but constants: no seam is built, no path is computed
    const plan = planOf();
    for (const l of plan.lines) io.out(l);
    io.out(""); io.out(`plan sha256: ${plan.sha}`);
    return 0;
  }
  if (!flags["approve-plan"] && !flags.run) throw new PolicyError("E_USAGE", "usage: subagent-policy selftest --plan yes | --approve-plan yes --live yes | --run yes --live yes: --plan prints what a run would do and the plan hash; the run needs your typed approval first", 1);
  const d = { ...realSeams(), ...(opts.selftest ?? {}) };
  const plan = planOf(), file = d.approvalFile, files = d.hashFiles();
  if (flags["approve-plan"]) {
    if (!d.interactive()) throw refuse("--approve-plan is an owner act and needs an interactive terminal (stdin and stdout both a terminal): refusing. Run it yourself in a console after reading --plan yes.");
    if (!d.runnerPresent?.()) throw refuse(`refusing to approve: the sandbox runner ${RUNNER_FILE} is not delivered yet, so there is nothing an approval could start; nothing was written`);
    const missing = files.filter((f) => f.raw === "(absent)").map((f) => f.file);
    if (missing.length) throw refuse(`refusing to approve: ${missing.join(", ")} cannot be read, so the run's files cannot be pinned`);
    const want = plan.sha.slice(0, 12);
    io.out(`approving the plan whose sha256 begins ${want}; read it first with \`selftest --plan yes\``);
    const typed = String(await d.ask(`type the first 12 hex characters of the plan sha256 (${want}) to approve, anything else cancels: `)).replace(/[\r\n]+$/, "");
    if (typed !== want) throw refuse("the typed confirmation does not match the plan sha256: nothing was approved", 1);
    const ccr = d.ccrLines ? await d.ccrLines() : null;
    if (d.ccrLines && !ccr) throw refuse("refusing to approve: the installed CCR was not found, so it cannot be pinned");
    const claude = flags.real && d.identifyClaude ? await d.identifyClaude() : null;
    if (flags.real && !claude) throw refuse("refusing to approve --real yes: no claude launcher was found on PATH, so none can be pinned");
    d.writeText(file, JSON.stringify({ schema: 1, planSha256: plan.sha, approvedAt: new Date(d.now()).toISOString(), files, ...(ccr ? { ccr } : {}), real: !!flags.real, claude }, null, 2) + "\n");
    io.out(`approval written: ${file} (plan sha256 ${plan.sha}; ONE-USE, valid 24 h; run it with \`selftest --run yes --live yes\`)`);
    return 0;
  }
  const text = d.readText(file);
  const pin = { ...(d.ccrLines ? { ccr: (await d.ccrLines()) ?? ["(CCR not found)"] } : {}), real: !!flags.real, claude: flags.real && d.identifyClaude ? await d.identifyClaude() : null };
  const bad = checkApproval(text, plan.sha, files, d.now(), pin);
  if (bad) throw refuse(`refusing to run: ${bad}`);
  if (typeof d.run !== "function" || !d.runnerPresent?.()) throw refuse(`refusing to run: the sandbox runner ${RUNNER_FILE} is not delivered yet, so there is nothing to start; your approval was not used`);
  const used = `${file}.used-${d.pid}-${d.now()}`;
  try { d.rename(file, used); } catch { throw refuse("the approval could not be consumed (another run may have used it first, or it is not a plain file): a run needs a fresh --approve-plan"); }
  if (d.readText(used) !== text) throw refuse("the consumed approval is not the file that was checked: a run needs a fresh --approve-plan");
  try { d.rm(used); } catch { /* the used copy is inert */ }
  io.out(`approval consumed (plan sha256 ${plan.sha}); starting the sandbox self-test`);
  const res = await d.run({ plan, expect: EXPECT, approval: JSON.parse(text), real: !!flags.real, identity: pin.claude }, io);
  const verdict = assertSelftest(res?.records, EXPECT, res?.agentLog);
  for (const l of verdict.lines) io.out(l);
  const sandboxOk = res?.code === 0;                              // the orchestrator's own exit: a live-state change after the run, an incomplete teardown or a refusal must never read OK
  if (!sandboxOk) io.out(`FAIL sandbox the sandbox run exited ${res?.code === undefined ? "with no exit code" : res.code}: a live-state change, an incomplete teardown or a refusal is not OK whatever the checks said`);
  const ok = verdict.ok && sandboxOk;
  io.out(`self-test: ${verdict.checks.filter((c) => c.ok).length} of ${verdict.checks.length} checks passed, sandbox run ${sandboxOk ? "clean" : "NOT clean"}; ${ok ? "OK" : "NOT OK"}`);
  return ok ? 0 : 1;
}

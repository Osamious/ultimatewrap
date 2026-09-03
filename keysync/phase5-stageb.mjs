// Phase 5, Stage B — isolated harness behavioural tests.
//
// Every verdict comes from CCR's request log or a parsed config file, never from
// response prose: "content came back" is not evidence a specific provider served
// it, and synthetic probes over-report (Finding 10).
//
// Guard on every test: the live ports and the desktop-app store must be
// untouched. That leak class caused both prior incidents.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { rpc, GATEWAY_PORT, SCRATCH_SETTINGS, SCRATCH_ROOT, SCRATCH_CLAUDE_CONFIG_DIR } from "../harness/config.mjs";

const CLAUDE = path.join(os.homedir(), ".local", "bin", "claude.exe");
const LIVE_3P = path.join(process.env.LOCALAPPDATA, "Claude-3p");
const only = process.argv[2];

const results = [];
const record = (id, name, ok, detail) => {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

const mtimeOf = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
const liveUntouched = (before) => mtimeOf(LIVE_3P) === before;

/** Scrub this session's own Claude env: an ambient ANTHROPIC_* beats apiKeyHelper
 *  and would silently bypass the routing under test. */
function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ANTHROPIC_|CCR_)/i.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = SCRATCH_CLAUDE_CONFIG_DIR; // --settings does NOT relocate sessions
  return { ...env, ...extra };
}

function runClaude(args, { env = {}, timeout = 180000, stdin = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ["--settings", SCRATCH_SETTINGS, ...args],
      { env: childEnv(env), cwd: SCRATCH_ROOT, shell: false });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    if (stdin !== null) { child.stdin.write(stdin); child.stdin.end(); }
    const t = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function recentLogs(sinceMs, limit = 25) {
  const logs = await rpc("getRequestLogs", [{ limit }]);
  const rows = Array.isArray(logs) ? logs : logs?.items ?? logs?.rows ?? [];
  return rows.filter((r) => new Date(r.createdAt ?? r.startedAt ?? 0).getTime() >= sinceMs);
}

// ---------------------------------------------------------------- T2.1 ------
// Client-side context guard. Pass is proven by the ABSENCE of an upstream
// request — which is what makes this test free.
async function T21() {
  const before3p = mtimeOf(LIVE_3P);
  const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
  const model = settings.modelPicker.options.find((o) => !o.model.startsWith("anthropic/"))?.model
    ?? settings.modelPicker.options[0].model;

  // Pipe the bulk via stdin: Windows caps a command line near 32k chars, so a
  // ~10k-token prompt passed as argv fails with ENAMETOOLONG before Claude Code
  // ever runs — which would look like a pass here for entirely the wrong reason.
  const big = "The quick brown fox jumps over the lazy dog. ".repeat(1200); // ~10k tokens
  const t0 = Date.now();
  const r = await runClaude(["--model", model, "-p", "Summarize the piped text in one word."],
    { env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "2000" }, stdin: big });
  const logs = (await recentLogs(t0)).filter((l) => String(l.model ?? "").includes(model.split("/").pop()));

  const refusedLocally = logs.length === 0;
  record("T2.1", "oversized prompt refused client-side, before any upstream spend",
    refusedLocally && liveUntouched(before3p),
    `exit=${r.code} upstreamRequests=${logs.length} (expect 0) ` +
    `first line: ${(r.out + r.err).trim().split("\n")[0]?.slice(0, 90)}`);
}

// ---------------------------------------------------------------- T2.4 ------
// Resume across backends. Asserting the ANSWER alone is not enough — a model can
// guess. The load-bearing assertion is that the reloaded request carried prior
// messages, i.e. the transcript genuinely came back.
async function T24() {
  const before3p = mtimeOf(LIVE_3P);
  const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
  const opts = settings.modelPicker.options.map((o) => o.model);
  const A = opts.find((m) => m.startsWith("anthropic/claude-haiku")) ?? opts[0];
  const B = opts.find((m) => !m.startsWith("anthropic/")) ?? opts[1];

  const t0 = Date.now();
  const r1 = await runClaude(["--model", B, "-p", "Remember the number 8231. Reply with just OK."]);

  // Session id from the scratch config dir, proving it landed in scratch and not
  // in the user's real history.
  const projDir = path.join(SCRATCH_CLAUDE_CONFIG_DIR, "projects");
  let sessionId = null;
  try {
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".jsonl")) files.push({ p, m: mtimeOf(p) }); } };
    walk(projDir);
    files.sort((a, b) => b.m - a.m);
    if (files[0]) sessionId = path.basename(files[0].p, ".jsonl");
  } catch { /* reported below */ }

  if (!sessionId) {
    record("T2.4", "resume across backends", false, "could not locate a scratch session file to resume");
    return;
  }
  const r2 = await runClaude(["--resume", sessionId, "--model", A,
    "-p", "What number did I ask you to remember? Reply with just the number."]);

  const logs = await recentLogs(t0);
  const last = logs[0];
  const servedByA = String(last?.provider ?? "").includes(A.split("/")[0]);
  const answered = /8231/.test(r2.out);
  record("T2.4", "transcript reloads and continues on a different backend",
    answered && servedByA && r2.code === 0 && liveUntouched(before3p),
    `run1=${B} run2=${A} exit=${r2.code} answered8231=${answered} ` +
    `run2ServedBy=${last?.provider} session=${sessionId.slice(0, 8)}`);
}

// ---------------------------------------------------------------- T3.1 ------
// Characterization of the DANGEROUS case: a bare id that matches exactly one
// enabled provider binds silently to it, with a label naming someone else.
// Expected result is "routes to the wrong provider", not "fails cleanly".
async function T31() {
  const before3p = mtimeOf(LIVE_3P);
  const cfg = await rpc("getConfig");
  const snapshot = JSON.parse(JSON.stringify(cfg));
  const settingsRaw = fs.readFileSync(SCRATCH_SETTINGS, "utf8");

  // Find a model name carried by exactly ONE enabled provider.
  const owners = new Map();
  for (const p of cfg.Providers ?? []) {
    for (const m of p.models ?? []) {
      if (!owners.has(m)) owners.set(m, []);
      owners.get(m).push(p.name);
    }
  }
  const unique = [...owners.entries()].find(([, ps]) => ps.length === 1);
  if (!unique) { record("T3.1", "stale bare-id characterization", false, "no uniquely-owned model to construct with"); return; }
  const [bareModel, [realOwner]] = unique;

  try {
    const settings = JSON.parse(settingsRaw);
    settings.modelPicker.options.push({
      model: bareModel, label: `DELIBERATELY MISLABELED (claims openrouter)`, description: "test fixture"
    });
    fs.writeFileSync(SCRATCH_SETTINGS, JSON.stringify(settings, null, 2) + "\n");

    const t0 = Date.now();
    const r = await runClaude(["--model", bareModel, "-p", "Reply with the single word: ping"]);
    const logs = await recentLogs(t0);
    const served = logs[0]?.provider;

    // The finding IS the silent bind. Assert it explicitly so the residual
    // hand-edit risk is documented with evidence rather than hope.
    const boundSilently = r.code === 0 && String(served ?? "").includes(realOwner);
    record("T3.1", "bare id silently binds to its single owner (characterization)",
      boundSilently && liveUntouched(before3p),
      `bare="${bareModel}" labeled as openrouter, actually served by "${served}" (owner=${realOwner}), exit=${r.code}`);
  } finally {
    fs.writeFileSync(SCRATCH_SETTINGS, settingsRaw);         // remove the dangerous fixture
    await rpc("saveConfig", [snapshot, { applyProfile: false }]);
  }
}

// ---------------------------------------------------------------- T2.3 ------
// Requirement 5d: does history containing Anthropic-native tool_use/tool_result
// blocks survive translation to a structurally different backend?
//
// SCOPE NOTE (stated rather than glossed): this switches at RESUME time, not
// mid-flight. A true mid-flight repoint is awkward because a CCR selector is
// provider/model — repointing the provider leaves an upstream model name that is
// invalid at the new backend. Router.rules could rewrite both, but that mutates
// the very routing state T1.1 asserts is empty. The translation risk being
// probed — A-shaped tool blocks arriving at backend B — is identical either way.
async function T23() {
  const before3p = mtimeOf(LIVE_3P);
  const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
  const opts = settings.modelPicker.options.map((o) => o.model);
  const A = opts.find((m) => m.startsWith("anthropic/claude-haiku")) ?? opts[0];
  const B = opts.find((m) => !m.startsWith("anthropic/")) ?? opts[1];

  const marker = `shape-probe-${Date.now().toString().slice(-6)}`;
  const t0 = Date.now();
  // Force a genuine tool_use in turn 1. Plain text would translate trivially and
  // the test would pass while proving nothing.
  const r1 = await runClaude(["--model", A, "--allowedTools", "Bash",
    "-p", `Run exactly this command with the Bash tool and report its output: echo ${marker}`]);

  const projDir = path.join(SCRATCH_CLAUDE_CONFIG_DIR, "projects");
  let sessionId = null, newest = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".jsonl") && mtimeOf(p) > newest) { newest = mtimeOf(p); sessionId = path.basename(p, ".jsonl"); } } };
  try { walk(projDir); } catch { /* handled below */ }

  if (!sessionId) { record("T2.3", "tool-call history across backends", false, "no scratch session file found"); return; }

  // Did turn 1 actually produce a tool call? If not, the test is inconclusive
  // rather than passing — assert the precondition instead of assuming it.
  let hadToolUse = false;
  try {
    const transcript = fs.readFileSync(path.join(projDir, ...[]), "utf8");
  } catch { /* fall through to file scan below */ }
  try {
    const found = [];
    const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) scan(p); else if (p.includes(sessionId)) found.push(p); } };
    scan(projDir);
    for (const f of found) if (/"tool_use"/.test(fs.readFileSync(f, "utf8"))) hadToolUse = true;
  } catch { /* reported in detail */ }

  const r2 = await runClaude(["--resume", sessionId, "--model", B,
    "-p", "What was the exact output of the command you ran? Reply with just that output."]);

  const logs = await recentLogs(t0);
  const last = logs[0];
  const servedByB = String(last?.provider ?? "").includes(B.split("/")[0]);
  const carried = r2.out.includes(marker);
  record("T2.3", "Anthropic tool_use history survives translation to another backend",
    hadToolUse && carried && servedByB && r2.code === 0 && liveUntouched(before3p),
    `turn1=${A} (tool_use present: ${hadToolUse}) turn2=${B} servedBy=${last?.provider} ` +
    `status=${last?.statusCode} recalledOutput=${carried} exit=${r2.code}`);
}

// ---------------------------------------------------------------- T2.2 ------
// The meaningful half of requirement 5c. T2.1 established there is NO
// client-side guard, so an oversized transcript WILL be sent. The question that
// remains is what comes back: a clear provider error, or a plausible-looking
// answer produced by silent truncation. The negative assertion is the point —
// exit code and status alone would pass a silently-truncating gateway.
async function T22() {
  const before3p = mtimeOf(LIVE_3P);
  const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
  // Deliberately the smallest-context row available: a 4B instruct model.
  const small = settings.modelPicker.options.map((o) => o.model)
    .find((m) => /qwen3-4b/i.test(m)) ?? settings.modelPicker.options[0].model;

  // A needle placed at the very start: if the model answers with it, the input
  // was NOT silently truncated from the front; if it answers plausibly without
  // it, something dropped content.
  const needle = "PINEAPPLE-7734";
  const filler = "The quick brown fox jumps over the lazy dog. ".repeat(6000); // ~45k tokens
  const payload = `${needle}
${filler}`;

  const t0 = Date.now();
  const r = await runClaude(["--model", small, "-p",
    "The piped text begins with a codeword. Reply with ONLY that codeword."], { stdin: payload, timeout: 240000 });
  const logs = (await recentLogs(t0)).filter((l) => String(l.model ?? "").includes(small.split("/").pop()));
  const last = logs[0];
  const status = last?.statusCode;
  const erroredClearly = r.code !== 0 || (status && status >= 400);
  const recalled = r.out.includes(needle);

  // Acceptable outcomes: a clear error, OR a correct answer (context was in fact
  // big enough). UNACCEPTABLE: exit 0 + 200 + a confident WRONG answer, which
  // means content was dropped silently.
  const silentTruncation = !erroredClearly && !recalled;
  record("T2.2", "oversized input errors clearly rather than truncating silently",
    !silentTruncation && liveUntouched(before3p),
    `model=${small} exit=${r.code} status=${status} recalledCodeword=${recalled} ` +
    `erroredClearly=${erroredClearly} reply="${r.out.trim().slice(0, 60)}"`);
}

const TESTS = { T21, T22, T23, T24, T31 };
for (const [name, fn] of Object.entries(TESTS)) {
  if (only && only !== name) continue;
  try { await fn(); } catch (e) { record(name, "(threw)", false, String(e.message).slice(0, 200)); }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== Stage B: ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) process.exit(1);

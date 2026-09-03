// FINAL GATE: verifies each picker row by actually running Claude Code against
// it, rather than by synthesizing a request.
//
// Why this exists: synthetic gateway probes over-report. A row can return 200 to
// a hand-built request and still fail with "400 All target providers failed"
// under Claude Code's real payload (~15 tool schemas + a long system prompt).
// Observed on groq/openai/gpt-oss-20b and groq/allam-2-7b. Neither a bare probe,
// nor adding one tool, nor `?beta=true`, nor streaming reproduced it — only the
// real client does. So the real client is the gate.
//
//   node verify-cli.mjs                     # verify rows in the LIVE settings
//   node verify-cli.mjs --settings <path>   # verify a specific settings file

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const at = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const SETTINGS = at("--settings") ?? path.join(os.homedir(), ".claude", "settings.json");
const CONFIG_DIR = at("--config-dir"); // omit to use the real one
const OUT = "C:\\Users\\osami\\.uw\\keysync\\verified-rows.json";
const TOKEN = "UW-CLI-OK";

// Spawn the real executable directly. `shell: true` concatenates argv without
// escaping, which mangled the prompt and made every model answer an empty
// request ("Ready. What task?") — 22 false failures on the first run.
const CLAUDE_EXE = path.join(os.homedir(), ".local", "bin", "claude.exe");

const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^\uFEFF/, ""));
if (!settings.modelPicker?.options) {
  console.error(`${SETTINGS} has no modelPicker.options — run keysync first`);
  process.exit(2);
}

// (4) Probe the BUILT set when keysync has written one. Reading the SHIPPED
// picker made pruning a one-way ratchet: a row dropped for a transient failure
// was never probed again, which is how mistral was lost to a single 503.
const BUILT_ROWS = "C:\\Users\\osami\\.uw\\keysync\\built-rows.json";
let rows = settings.modelPicker.options.map((o) => o.model);
if (fs.existsSync(BUILT_ROWS)) {
  try {
    const built = JSON.parse(fs.readFileSync(BUILT_ROWS, "utf8"));
    if (Array.isArray(built.rows) && built.rows.length) {
      rows = [...new Set([...built.rows, ...rows])];
      console.log(`probing the BUILT set (${built.rows.length} rows) rather than only the shipped picker`);
    }
  } catch { /* fall back to the shipped picker */ }
}
if (!fs.existsSync(CLAUDE_EXE)) {
  console.error(`claude.exe not found at ${CLAUDE_EXE}`);
  process.exit(2);
}
console.log(`verifying ${rows.length} rows by running Claude Code itself\n`);

// Strip this session's own Claude env so the child cannot attach to it, and drop
// any ambient ANTHROPIC_* which would beat apiKeyHelper and bypass the routing.
// MEASURED LEAK: the previous pattern missed CLAUDE_CONFIG_DIR,
// CLAUDE_AGENT_API_BASE_URL, CLAUDE_PLUGIN_ROOT and CLAUDE_EFFORT — all set in
// the parent shell. CLAUDE_CONFIG_DIR made the child inherit the parent's whole
// config root (sessions, credentials); CLAUDE_AGENT_API_BASE_URL can repoint the
// child's API base entirely, which would silently invalidate this gate rather
// than merely leak state. Since every --verified-only prune rests on this
// result, the scrub must be broad.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLAUDE|ANTHROPIC_|CCR_)/i.test(k)) continue;
  env[k] = v;
}
if (CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CONFIG_DIR;


function runClaude(model) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(CLAUDE_EXE, [
      "--settings", SETTINGS, "--model", model,
      "-p", `Reply with exactly this and nothing else: ${TOKEN}`
    ], { env, cwd: os.homedir(), shell: false });

    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    // Without an 'error' listener a failed spawn throws an unhandled event,
    // kills the process, AND leaves this promise unsettled.
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ model, ok: false, ms: Date.now() - started, why: `spawn failed: ${e.code ?? e.message}` });
    });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const ok = out.includes(TOKEN);
      // Prefer a line that actually looks like a failure. Taking index 0 blindly
      // recorded aionlabs' cause as "Warning: no stdin data received in 3s" —
      // a startup warning — while the real cause (this timer's SIGKILL) was
      // never recorded at all, because only 'close' was observed.
      const lines = (out + err).split("\n").map((l) => l.trim())
        .filter((l) => l && !/connectors are disabled/.test(l));
      const signal = lines.find((l) => /^(API Error|Request too large|Failed to authenticate|Error:)/.test(l));
      const why = ok ? ""
        : timedOut ? `timed out after 120s (killed)`
        : (signal ?? lines[0] ?? `exit ${code}`).slice(0, 120);
      const status = Number((out + err).match(/API Error:\s*(\d{3})/)?.[1]) || (timedOut ? 0 : null);
      resolve({ model, ok, ms, why, status });
    });
  });
}

const results = [];
// Sequential on purpose: parallel Claude Code processes contend and produce
// spurious rate-limit failures, which is exactly the noise this gate removes.
for (const model of rows) {
  const r = await runClaude(model);
  results.push(r);
  // Write after every row: the previous version only persisted at the end, so a
  // crash or Ctrl+C at row 50 of 87 discarded every paid result before it.
  try {
    fs.writeFileSync(OUT + ".partial", JSON.stringify({ inProgress: true, results }, null, 2));
  } catch { /* partial persistence is best effort */ }
  console.log(`${r.ok ? "PASS" : "fail"}  ${model.padEnd(46)} ${String(r.ms + "ms").padStart(7)}  ${r.why}`);
}

// A 400 (payload rejected) or 401/403 (dead key) is a durable property of the
// row. A 402/429/5xx/timeout is weather. Pruning them identically is what made
// the ratchet permanent — and, per the groq finding, discarded a capable model
// over a per-minute quota limit.
const DURABLE = new Set([400, 401, 403, 404]);
const classify = (r) => r.ok ? "working"
  : (r.status && DURABLE.has(r.status)) ? "durable-failure" : "transient-failure";
for (const r of results) r.klass = classify(r);

const working = results.filter((r) => r.ok).map((r) => r.model);
const transient = results.filter((r) => r.klass === "transient-failure").map((r) => r.model);
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(),
  probe: "real Claude Code CLI (ground truth)",
  working, transient, results
}, null, 2));
if (transient.length) {
  console.log(`\n${transient.length} row(s) failed for TRANSIENT reasons and will be re-probed next run ` +
    `(not permanently pruned): ${transient.join(", ")}`);
}

const providers = new Set(working.map((m) => m.split("/")[0]));
console.log(`\n=== ${working.length}/${results.length} rows work through Claude Code, across ${providers.size} providers ===`);
console.log(`providers: ${[...providers].sort().join(", ")}`);
if (working.length < results.length) {
  console.log(`\nre-run keysync to prune the failures:`);
  console.log(`  node run.mjs --target live --verified-only --i-know`);
}

// Phase 2.5, CLI half. Runs Claude Code against the isolated CCR instance.
//
// Isolation for the CLI (distinct from CCR's own):
//   CLAUDE_CONFIG_DIR -> scratch. `--settings` only LAYERS a settings file; it
//     does NOT relocate ~/.claude.json, sessions, history or credentials.
//   scrubbed env      -> this process inherits CLAUDECODE, CLAUDE_CODE_MESSAGING_*
//     and session ids from the agent session running it. Inheriting those risks
//     the child attaching to this session's bridge. ANTHROPIC_* is scrubbed too
//     because an ambient key BEATS apiKeyHelper and would silently bypass the
//     very routing under test.
//
// Scope: this proves the settings/apiKeyHelper path end-to-end. It does NOT
// exercise the interactive /model picker (see the note printed at the end).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { SCRATCH_SETTINGS, SCRATCH_CLAUDE_CONFIG_DIR, SCRATCH_ROOT } from "./config.mjs";
import { makeTripwire } from "./guard.mjs";

const tripwire = makeTripwire();
tripwire.assert("cli:start");

fs.mkdirSync(SCRATCH_CLAUDE_CONFIG_DIR, { recursive: true });

const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
if (!settings.apiKeyHelper) throw new Error("scratch settings lack apiKeyHelper — run spike.mjs first");
if (!settings.modelPicker) throw new Error("scratch settings lack modelPicker — run spike.mjs first");
console.log(`settings: apiKeyHelper set, base=${settings.env?.ANTHROPIC_BASE_URL}`);
console.log(`modelPicker rows: ${settings.modelPicker.options.map((o) => o.model).join(", ")}`);
console.log(`replaceBuiltInOptions: ${settings.modelPicker.replaceBuiltInOptions}`);

// Build a scrubbed environment.
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (/^(CLAUDE|CLAUDECODE|ANTHROPIC|CCR)/i.test(k)) continue;
  env[k] = v;
}
env.CLAUDE_CONFIG_DIR = SCRATCH_CLAUDE_CONFIG_DIR;

const PROMPT = "Reply with exactly this and nothing else: CLI-ROUTED-OK";
const args = ["--bare", "--settings", SCRATCH_SETTINGS, "-p", PROMPT];
console.log(`\n$ claude ${args.join(" ")}`);
console.log(`  CLAUDE_CONFIG_DIR=${SCRATCH_CLAUDE_CONFIG_DIR}\n`);

const r = spawnSync("claude", args, {
  env, cwd: SCRATCH_ROOT, encoding: "utf8", timeout: 120000, shell: true
});

console.log(`exit code: ${r.status}`);
if (r.stdout?.trim()) console.log(`stdout: ${r.stdout.trim().slice(0, 600)}`);
if (r.stderr?.trim()) console.log(`stderr: ${r.stderr.trim().slice(0, 600)}`);

tripwire.assert("cli:end");

const ok = r.status === 0 && (r.stdout || "").includes("CLI-ROUTED-OK");
console.log(`\n=== CLI RESULT ===`);
console.log(ok
  ? "Claude Code -> CCR -> real provider WORKS via apiKeyHelper + settings."
  : "CLI path did NOT return the expected content — see output above.");
console.log("NOT exercised by this run: the interactive /model picker (render, " +
  "selection, live same-session switching, replaceBuiltInOptions behavior). " +
  "Those need a TTY and must be recorded separately.");

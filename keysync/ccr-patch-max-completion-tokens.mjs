// #108: OpenAI reasoning models reject `max_tokens` and require
// `max_completion_tokens`.
//
//   node keysync/ccr-patch-max-completion-tokens.mjs --check | --apply | --revert
//
// THE DEFECT. `@the-next-ai/ai-gateway` -- a dependency of CCR, not CCR's own
// code -- builds every OpenAI chat-completions request with a fixed
// `max_tokens`. OpenAI's GPT-5 and o-series refuse that parameter outright:
//
//   FAIL openai/gpt-5.6     Unsupported parameter: 'max_tokens' is not supported
//                           with this model. Use 'max_completion_tokens' instead.
//   FAIL openai/gpt-5-nano  (same)
//   OK   openai/gpt-4o-mini
//   OK   openai/gpt-4.1
//
// MEASURED 2026-09-09: 153 of 340 `openai/` picker rows match the affected
// family, and every one of them is unroutable. Only the DIRECT OpenAI key is
// hit -- routers reselling the same models accept `max_tokens` at their own edge
// and translate it themselves.
//
// KNOWN UPSTREAM AND UNFIXED. Five open issues on musistudio/claude-code-router,
// the oldest (#545, "OpenAI GPT5 400 Error for 'max_tokens' key") from
// 2025-08-12, plus #830, #588, #644, #652. v3.0.22 is the latest release and is
// what runs here.
//
// GATED ON THE MODEL, NOT APPLIED BLANKET. `max_tokens` remains correct for the
// GPT-4 era, so swapping it unconditionally would break the 187 rows that work
// today to fix the 153 that do not. The pattern matches at a segment boundary so
// a namespaced id (`openai/gpt-5.6`) and a bare one (`gpt-5.6`) both hit, and a
// model merely CONTAINING the text does not.
//
// THE SITE IS THE CHAT-COMPLETIONS BUILDER AND ONLY THAT ONE. The bundle has a
// second, nearly identical literal -- `...max_output_tokens??Qq}` -- which
// builds an ANTHROPIC-shaped request (it sets `system`), where `max_tokens` is
// correct and required. The anchor below includes the trailing `stop:` clause
// precisely so it cannot match that one; verified unique before writing.

import fs from "node:fs";
import path from "node:path";

const TARGET = path.join(
  "C:", "nvm4w", "nodejs", "node_modules", "@musistudio", "claude-code-router",
  "node_modules", "@the-next-ai", "ai-gateway", "dist", "index.js");
const BACKUP = `${TARGET}.bak-max-completion-tokens`;

const FROM = "max_tokens:e.standardRequest.max_output_tokens,stop:e.standardRequest.stop";
const TO =
  '...(/(^|[\\/:])(gpt-5|o1|o3|o4)/i.test(String(e.standardRequest.model||""))' +
  '?{max_completion_tokens:e.standardRequest.max_output_tokens}' +
  ':{max_tokens:e.standardRequest.max_output_tokens}),stop:e.standardRequest.stop';

const mode = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--revert") ? "revert" : "check";

if (!fs.existsSync(TARGET)) { console.error(`target not found: ${TARGET}`); process.exit(2); }

const body = fs.readFileSync(TARGET, "utf8");
const plain = body.split(FROM).length - 1;
const patched = body.split(TO).length - 1;

console.log(`target : ${TARGET}`);
console.log(`backup : ${fs.existsSync(BACKUP) ? "present" : "absent"}`);
console.log(`state  : ${patched} patched, ${plain} unpatched`);

if (mode === "check") {
  console.log(patched === 1 && plain === 0 ? "\nAPPLIED"
    : plain === 1 && patched === 0 ? "\nNOT APPLIED" : "\nUNEXPECTED -- inspect before writing");
  process.exit(0);
}

if (mode === "revert") {
  if (!fs.existsSync(BACKUP)) { console.error("\nno backup to restore from"); process.exit(1); }
  fs.copyFileSync(BACKUP, TARGET);
  console.log("\nreverted from backup");
  process.exit(0);
}

if (patched > 0 && plain === 0) { console.log("\nalready applied -- nothing to do"); process.exit(0); }
// Exactly one site, or refuse. Two would mean the anchor also caught the
// Anthropic builder, which must keep `max_tokens`.
if (plain !== 1) {
  console.error(`\nexpected exactly 1 unpatched site, found ${plain}. ` +
    `The bundle changed; re-derive the anchor before patching.`);
  process.exit(1);
}
if (!fs.existsSync(BACKUP)) fs.copyFileSync(TARGET, BACKUP);
fs.writeFileSync(TARGET, body.split(FROM).join(TO));
console.log(`\napplied; backup at ${path.basename(BACKUP)}`);
console.log("restart the gateway: ccr stop && ccr start --no-open");

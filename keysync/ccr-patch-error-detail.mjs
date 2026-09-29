// #109: surface the upstream reason instead of "All target providers failed."
//
//   node keysync/ccr-patch-error-detail.mjs --check | --apply | --revert
//
// THE DEFECT. `@the-next-ai/ai-gateway` -- a dependency of CCR, not CCR's own
// code -- builds every multi-provider failure envelope in two identical
// functions (`Ly` and `Jk`, one per response path). Both already collect the
// real reason into `attempts[]` and then throw it away from `message`:
//
//   let t = n[n.length-1];
//   return { status: ..., payload: { error: {
//     message: "All target providers failed.",
//     ..., attempts: n.map(o => ({ ..., message: o.message, details: o.details }))
//   } } }
//
// Claude Code renders `error.message` and nothing else, so the operator sees
// `API Error: 400 All target providers failed.` for causes that are already
// known, specific and actionable one field away. MEASURED 2026-09-09, three
// unrelated failures in one session all presented identically:
//
//   orcarouter  "This prompt is longer than the free tier allows..."
//   openai      "Unsupported parameter: 'max_tokens' ... use 'max_completion_tokens'"
//   google      "* GenerateContentRequest.model: unexpected model name format"
//
// Each cost a separate investigation. The last one cost two, because the
// generic text also hid that a later failure had a DIFFERENT cause than the
// earlier one.
//
// WHY A PATCH AND NOT A FIX ON OUR SIDE. The envelope is built inside the
// gateway process and returned straight to Claude Code; nothing we own sits in
// that path. `gateway-proxy-preload.cjs` runs in the same process but can only
// reach `globalThis.fetch` -- `Ly`/`Jk` are local minified functions in a
// bundle, not exported and not reachable from a preload.
//
// REVERSIBLE AND IDEMPOTENT, because this is a third-party install: `--revert`
// restores the byte-identical backup, `--check` reports state without writing,
// and re-applying is a no-op rather than a double edit. `npm update` will
// discard it, which is the standing cost of every patch in this family (#98).

import fs from "node:fs";
import path from "node:path";

const TARGET = path.join(
  "C:", "nvm4w", "nodejs", "node_modules", "@musistudio", "claude-code-router",
  "node_modules", "@the-next-ai", "ai-gateway", "dist", "index.js");
const BACKUP = `${TARGET}.bak-error-detail`;

// The exact literal both builders use. `t` is already bound to the last attempt
// at this point in both functions, which is what makes one replacement work for
// both without knowing their names.
const FROM = 'message:"All target providers failed.",';

// Prefer the upstream's own words; fall back to the original sentence so a
// shape this does not recognise degrades to today's behaviour rather than to
// `undefined`.
//
// THE PREFIX COMES FROM `providerName`, NOT `provider`. Found by shipping it
// wrong first: `t.provider` is the ADAPTER TYPE, so the first version printed
// `openai:` in front of failures from opencode, zenmux and orcarouter alike --
// a name that is not merely useless but points at the wrong provider.
// `providerName` is the configured name (`provider-opencode-023ae49d88::...`),
// so the hash and the `::method` tail are trimmed back to the provider a user
// would recognise. No match means no prefix, because a wrong name is worse than
// none.
const TO =
  'message:(()=>{try{const _d=t&&(t.details?.error?.message||t.details?.message||t.message);' +
  'if(!_d)return "All target providers failed.";' +
  'const _n=String(t.providerName||"").match(/^provider-(.+?)-[0-9a-f]{6,}/);' +
  'return (_n?_n[1]+": ":"")+String(_d).slice(0,400);}' +
  'catch{return "All target providers failed.";}})(),';

const mode = process.argv.includes("--apply") ? "apply"
  : process.argv.includes("--revert") ? "revert" : "check";

if (!fs.existsSync(TARGET)) {
  console.error(`target not found: ${TARGET}`);
  process.exit(2);
}

const body = fs.readFileSync(TARGET, "utf8");
const plain = body.split(FROM).length - 1;
const patched = body.split(TO).length - 1;

console.log(`target : ${TARGET}`);
console.log(`backup : ${fs.existsSync(BACKUP) ? "present" : "absent"}`);
console.log(`state  : ${patched} patched site(s), ${plain} unpatched site(s)`);

if (mode === "check") {
  console.log(patched === 2 && plain === 0 ? "\nAPPLIED" : plain === 2 && patched === 0 ? "\nNOT APPLIED" : "\nUNEXPECTED -- inspect before writing");
  process.exit(0);
}

if (mode === "revert") {
  if (!fs.existsSync(BACKUP)) { console.error("\nno backup to restore from"); process.exit(1); }
  fs.copyFileSync(BACKUP, TARGET);
  console.log("\nreverted from backup");
  process.exit(0);
}

// apply
if (patched > 0 && plain === 0) { console.log("\nalready applied -- nothing to do"); process.exit(0); }
// BOTH SITES OR NEITHER. One patched path and one not is worse than neither:
// the same failure would read differently depending on whether it streamed.
if (plain !== 2) {
  console.error(`\nexpected exactly 2 unpatched sites, found ${plain}. ` +
    `The bundle changed; re-derive the literal before patching.`);
  process.exit(1);
}
if (!fs.existsSync(BACKUP)) fs.copyFileSync(TARGET, BACKUP);
const out = body.split(FROM).join(TO);
fs.writeFileSync(TARGET, out);
const after = fs.readFileSync(TARGET, "utf8");
console.log(`\napplied to ${after.split(TO).length - 1} site(s); backup at ${path.basename(BACKUP)}`);
console.log("restart the gateway for it to take effect: ccr stop && ccr start --no-open");

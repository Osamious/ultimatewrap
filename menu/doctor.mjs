#!/usr/bin/env node
// uw doctor -- does the environment still hold up the two things this design
// depends on?
//
// Report 10's root cause, restated: UW's fragility is not that it depends on
// undocumented internals. It is that it encodes third-party behaviour as
// constants in its own source rather than as facts it re-derives from the
// environment it is running in. Each mirror was correct when written and has no
// mechanism to notice when it stops being correct.
//
// So this file re-derives rather than asserts, and every failure NAMES its
// evidence. "P1 failed: argv[2] did not exist" is actionable; "unrecognised
// version" is not.
//
// Policy, deliberately asymmetric: reads and dry runs always proceed, even on
// Red -- refusing to diagnose when the environment just changed is exactly
// backwards. Amber is the COMMON path, because Claude Code auto-updates.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import * as CC from "./cc-contract.mjs";
import * as CCR from "./ccr-client.mjs";
import { transform } from "./hud-shim.mjs";
import { writeAtomic } from "./atomic.mjs";

const DISPATCHER = path.join(os.homedir(), ".uw", "menu", "uwpick.cmd");
export const CAPABILITIES = path.join(os.homedir(), ".uw", "state", "capabilities.json");
const HANDOFF = path.join(os.homedir(), ".uw", "state", "handoff.json");
const HUD_INSTALL = path.join(os.homedir(), ".uw", "state", "hud-install.json");

const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();

export function checkEnv(env) {
  const editor = env.EDITOR ?? "";
  const real = env.UW_REAL_EDITOR ?? "";
  if (norm(editor) !== norm(DISPATCHER)) {
    return { name: "editor-wiring", ok: false, verdict: "red",
      evidence: `EDITOR is "${editor || "(unset)"}" but must be "${DISPATCHER}" ` +
                `(uwpick.cmd) for ctrl+g to reach the picker` };
  }
  if (!real || !fs.existsSync(real)) {
    return { name: "editor-wiring", ok: false, verdict: "red",
      evidence: `UW_REAL_EDITOR is "${real || "(unset)"}" — without it the passthrough ` +
                `branch opens notepad instead of your editor` };
  }
  return { name: "editor-wiring", ok: true, verdict: "green",
    evidence: `EDITOR -> uwpick.cmd, UW_REAL_EDITOR -> ${real}` };
}

// How long a successful handoff stays evidence. Claude Code auto-updates on the
// `latest` channel, so "it worked once" decays.
export const MAX_HANDOFF_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function checkHandoff(lines, { now = Date.now(), claudeRunSince = null } = {}) {
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
                    .filter(Boolean);
  if (!rows.length) {
    return { name: "handoff-contract", ok: false, verdict: "amber",
      evidence: "the picker has never recorded an invocation — press ctrl+g and type " +
                "`m` once, then re-run" };
  }
  const last = rows[rows.length - 1];

  // THE FAILURE THIS CHECK EXISTS FOR, and the one the previous version could not
  // see. When Claude Code changes its editor protocol, ctrl+g stops reaching the
  // picker at all. No new row is appended. `rows[rows.length - 1]` is then the
  // last row from BEFORE the break -- a successful one -- and the check reports
  // green forever, in exactly the circumstance it was written to catch.
  //
  // A successful row is therefore evidence with an expiry date. Stale AND Claude
  // Code has run since is red: something invoked Claude Code and the picker was
  // never reached. Stale with no evidence of use is amber: possibly nobody has
  // pressed ctrl+g, which is not a fault.
  const age = now - Date.parse(last.at);
  if (Number.isFinite(age) && age > MAX_HANDOFF_AGE_MS) {
    const days = Math.round(age / 86400000);
    const usedSince = claudeRunSince != null && claudeRunSince > Date.parse(last.at);
    return { name: "handoff-contract", ok: false,
      verdict: usedSince ? "red" : "amber",
      evidence: usedSince
        ? `the last recorded handoff is ${days} days old and Claude Code has been used ` +
          `since, so ctrl+g is no longer reaching the picker — this is what a changed ` +
          `editor protocol looks like. Press ctrl+g and type \`m\`; if nothing happens, ` +
          `re-verify CONTRACT.handoff against the running version`
        : `the last recorded handoff is ${days} days old — too old to be evidence. ` +
          `Press ctrl+g and type \`m\` once, then re-run` };
  }

  if (!last.argv2 || !last.existed) {
    return { name: "handoff-contract", ok: false, verdict: "red",
      evidence: `last invocation at ${last.at}: argv[2] was ${JSON.stringify(last.argv2)} ` +
                `and existed=${last.existed}. Claude Code no longer passes a readable temp ` +
                `file as argv[2]; the selection cannot be written` };
  }
  if (!last.wrote) {
    return { name: "handoff-contract", ok: true, verdict: "amber",
      evidence: `last invocation at ${last.at} exited without a selection (esc or ctrl+c) ` +
                `— the file contract held` };
  }
  return { name: "handoff-contract", ok: true, verdict: "green",
    evidence: `last invocation at ${last.at} wrote a selection into ${last.argv2}` };
}

export function checkFingerprint(current, pinned) {
  // A PARSE FAILURE IS RED, not amber. `readClaudeFingerprint` mirrors the output
  // format of an undocumented `claude doctor`, so the day that format changes is
  // a day this project's central assumption -- that it can detect Claude Code
  // moving under it -- has stopped holding. Reporting amber there, and then
  // pinning, converts "we can no longer tell" into "recorded, carry on".
  if (current.parseFailed) {
    return { name: "cc-fingerprint", ok: false, verdict: "red",
      evidence: "`claude doctor` ran but its output no longer matches the expected " +
                "`Running: ... (version)` / `Commit: ...` shape. The version probe " +
                "itself is broken, so no drift check below it means anything. " +
                "Re-derive the pattern in readClaudeFingerprint from the current output" };
  }
  if (!current.ccVersion) {
    return { name: "cc-fingerprint", ok: false, verdict: "red",
      evidence: "`claude doctor` produced no version line — Claude Code is missing, " +
                "not on PATH, or its output format changed" };
  }
  if (!pinned.ccVersion) {
    return { name: "cc-fingerprint", ok: true, verdict: "amber",
      evidence: `no pinned fingerprint yet; run \`uw doctor --accept-fingerprint\` to ` +
                `record ${current.ccVersion} (${current.ccCommit ?? "no commit"})` };
  }
  if (current.ccVersion !== pinned.ccVersion || current.ccCommit !== pinned.ccCommit) {
    // NOT auto-accepted. Auto-update is expected, but "the version moved" and "the
    // contract still holds" are different claims, and silently re-pinning asserts
    // the second from evidence for only the first. The drift stays visible until a
    // human has re-run the handoff and said so.
    return { name: "cc-fingerprint", ok: false, verdict: "amber",
      evidence: `Claude Code moved from ${pinned.ccVersion} (${pinned.ccCommit}) to ` +
                `${current.ccVersion} (${current.ccCommit}). Auto-update is enabled, so ` +
                `the move is expected — the contract is not. Press ctrl+g, type \`m\`, ` +
                `confirm the picker opens and the selection lands in the chat input, ` +
                `then run \`uw doctor --accept-fingerprint\` to pin the new version` };
  }
  return { name: "cc-fingerprint", ok: true, verdict: "green",
    evidence: `${current.ccVersion} (${current.ccCommit})` };
}

const RANK = { green: 0, amber: 1, red: 2 };

// Q4.4: the contract modules claim a version; the machine has one. When those
// disagree, say so here rather than letting a renderer discover it.
export function checkContracts({ ccObserved, ccPinned, service }) {
  const bits = [];
  let verdict = "green";
  if (!ccObserved) {
    verdict = "amber";
    bits.push(`could not read the running Claude Code version (cc-contract pins ${ccPinned})`);
  } else if (ccObserved !== ccPinned) {
    verdict = "amber";
    bits.push(`cc-contract.mjs pins ${ccPinned}, Claude Code reports ${ccObserved} — re-verify the handoff and the statusline shape, then update CONTRACT.fingerprint`);
  } else {
    bits.push(`cc-contract ${ccPinned} matches`);
  }
  if (!service) {
    verdict = verdict === "green" ? "amber" : verdict;
    bits.push("CCR service.json not readable — routability will fall back to the cached set");
  } else {
    bits.push("ccr-client reached service.json");
  }
  return { name: "contracts", ok: verdict === "green", verdict, evidence: bits.join("; ") };
}

// Q6.3: the shim is optional, so "not installed" is a pass. When it IS installed,
// two things must hold: the command it wraps still exists, and a sample payload
// survives the transform with its fields intact.
export function checkHud({ install, wrappedExists, roundTrip }) {
  if (!install) {
    return { name: "hud-shim", ok: true, verdict: "green", evidence: "not installed (optional)" };
  }
  if (!wrappedExists) {
    // -HudUninstall, which is the switch install.ps1 implements. The remedy named
    // "-Uninstall", which does not exist, so the one actionable line the doctor
    // prints for this failure sent the operator to a flag PowerShell would reject.
    return { name: "hud-shim", ok: false, verdict: "red",
             evidence: `wrapped statusline command is missing: ${install.previousCommand} — run install.ps1 -Hud -HudUninstall to restore` };
  }
  if (!roundTrip.ok) {
    return { name: "hud-shim", ok: false, verdict: "amber",
             evidence: `sample payload did not round-trip: ${roundTrip.why} — the footer still works, the context number does not` };
  }
  return { name: "hud-shim", ok: true, verdict: "green",
           evidence: `installed, wrapping ${install.previousCommand}` };
}

/**
 * The local patch to CCR's `dist/main/cli.js`, and whether it is still there.
 *
 * Report 10, P1 #10, and it is the highest-severity CCR coupling this project
 * has. CCR's gateway handshake timeout is a minified constant compiled into the
 * bundle and governed by NO environment variable -- all 28 `CCR_*` vars were
 * searched. It was patched locally from 5000 ms to 20000 ms:
 *
 *   OLD: var PN="gateway",K7=5e3,z7=15e3,...
 *   NEW: var PN="gateway",K7=2e4,z7=15e3,...
 *
 * CCR is a global npm package with no self-update, so it changes on exactly one
 * event -- `npm i -g` -- and that event silently reverts the patch. The failure
 * mode is the worst class available: the 5-second handshake reappears and fails
 * INTERMITTENTLY, only under load, which reads as flakiness rather than as a
 * broken invariant. It has already happened once.
 *
 * Two traps, both from the measurement:
 *
 *   - Normalize newlines before ANY size or digest check. The raw file is
 *     2,308,421 bytes with CRLF against a 2,299,525-byte LF backup; a naive
 *     comparison reports a difference that is not one.
 *   - Anchor on the STABLE LITERAL `var PN="gateway",`, never on `K7`. `K7` is a
 *     minified identifier and a rebuild may call it `Q3` or `zP`, so a check that
 *     greps for `K7=2e4` would report the patch missing on every future CCR
 *     release whether or not it actually is.
 *
 * This check is read-only and never rewrites CCR. Re-applying the patch is a
 * deliberate act with its own recipe (see the evidence line), because writing
 * into another tool's installed bundle is not something a doctor should do on its
 * own initiative.
 */
export const GATEWAY_ANCHOR = 'var PN="gateway",';
export const GATEWAY_TIMEOUT_MIN_MS = 20000;

export function checkCcrPatch({ file, read = null }) {
  let raw;
  try { raw = read ? read(file) : fs.readFileSync(file, "utf8"); }
  catch {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `cannot read ${file} — CCR's bundle is not where ccr-client.mjs resolves it. ` +
                `The gateway handshake patch cannot be verified` };
  }
  const norm = raw.replace(/\r\n/g, "\n");            // CRLF vs LF: 2,308,421 vs 2,299,525
  const at = norm.indexOf(GATEWAY_ANCHOR);
  if (at < 0) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `the anchor ${GATEWAY_ANCHOR} is gone from cli.js — CCR was rebuilt and this ` +
                `check needs re-deriving against the new bundle. Do NOT assume the patch is ` +
                `absent; assume the check is stale` };
  }
  // The first numeric assignment after the anchor is the handshake timeout,
  // whatever the minifier called it this build.
  const m = /^var PN="gateway",[A-Za-z_$][\w$]*=(\d+(?:e\d+)?)/.exec(norm.slice(at));
  const ms = m ? Number(m[1].replace(/e(\d+)/, (_, e) => "0".repeat(Number(e)))) : NaN;
  if (!Number.isFinite(ms)) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `found the anchor but could not read the timeout after it — re-derive the check` };
  }
  if (ms < GATEWAY_TIMEOUT_MIN_MS) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "red",
      evidence: `CCR's gateway handshake timeout is ${ms} ms, below the patched ` +
                `${GATEWAY_TIMEOUT_MIN_MS} ms. An \`npm i -g @musistudio/claude-code-router\` has ` +
                `reverted the local patch. Symptom: "Core gateway did not accept runtime config ` +
                `within ${ms}ms" — INTERMITTENT and only under load, so it will read as ` +
                `flakiness. Re-apply: in ${file}, replace the first assignment after ` +
                `${GATEWAY_ANCHOR} with 2e4, keeping the file's existing line endings` };
  }
  return { name: "ccr-gateway-patch", ok: true, verdict: "green",
    evidence: `gateway handshake timeout ${ms} ms (patched; stock is 5000)` };
}

/**
 * The CCR RPC surface, probed rather than assumed.
 *
 * Report 10, P1 #14: RPC method names are WIRE STRINGS, not minified identifiers
 * -- verified as `getAppInfo:()=>cct(),getConfig:()=>bt(),...` -- which makes them
 * the most solid CCR dependency this project has. That is a reason to depend on
 * them, and also a reason to check them: "most solid" is not "guaranteed", and an
 * unknown-method failure is loud at the call site but anonymous, arriving as a
 * refresh that returns nothing rather than as a named problem.
 *
 * `getAppInfo` also answers the version question better than the filesystem does.
 * package.json is the INSTALLED version; getAppInfo is the RUNNING one. When they
 * disagree, CCR has been updated on disk but the gateway has not been restarted --
 * which is precisely the window in which the patch above has been reverted on disk
 * while the running process still holds it, so everything works until the next
 * restart and then stops. That is worth naming before it happens.
 */
export function checkRpcSurface({ methods, installedVersion, runningVersion }) {
  const names = Object.keys(methods ?? {});
  const missing = Object.entries(methods ?? {}).filter(([, ok]) => !ok).map(([m]) => m);
  // ALL of them failing is a gateway that is not answering, not a renamed API.
  //
  // Found by running this against the live machine: service.json existed and was
  // readable while nothing was listening on its port, so every probe returned "no
  // answer" and this check reported RED "the method names moved in an upgrade" --
  // confidently, and about the wrong thing. probeRpcSurface only returns null when
  // service.json itself is unreadable, and a stale descriptor from a stopped
  // gateway is the common case rather than the rare one.
  //
  // A method genuinely disappearing in an upgrade takes the others with it only if
  // the whole surface was renamed at once; a partial failure is the shape drift
  // actually has, and that stays red.
  if (names.length && missing.length === names.length) {
    return { name: "ccr-rpc", ok: false, verdict: "amber",
      evidence: `CCR answered none of ${names.join(", ")} — the gateway is not running, or ` +
                `service.json is stale and points at a port nothing is listening on. Start ` +
                `CCR and re-run; if it IS running, then the method names have moved and this ` +
                `is red rather than amber` };
  }
  if (missing.length) {
    return { name: "ccr-rpc", ok: false, verdict: "red",
      evidence: `CCR does not answer ${missing.join(", ")} — the method names moved in an ` +
                `upgrade. Everything ccr-client.mjs does goes through these; re-derive them ` +
                `from the running build and update CONTRACT` };
  }
  if (installedVersion && runningVersion && installedVersion !== runningVersion) {
    return { name: "ccr-rpc", ok: false, verdict: "amber",
      evidence: `CCR ${installedVersion} is installed but the running gateway reports ` +
                `${runningVersion} — it was updated without a restart. The gateway-patch check ` +
                `above reads the NEW file while this process still runs the OLD one, so both ` +
                `can be green today and fail on the next restart. Restart the gateway` };
  }
  return { name: "ccr-rpc", ok: true, verdict: "green",
    evidence: `${Object.keys(methods ?? {}).length} methods answered; CCR ${runningVersion ?? installedVersion ?? "?"}` };
}

/**
 * The CCR install, and specifically its bundled catalogue.
 *
 * `ccr-client.mjs` resolves the install through `require.resolve` and falls back
 * to a literal `C:/nvm4w/nodejs/node_modules/...`. That junction follows the
 * ACTIVE Node version, so it survives an nvm switch — but an `npm i -g`
 * relocation, a different Node manager, or a CCR uninstall breaks it silently,
 * and the only symptom is that Task B4's copy-out has nothing to copy. Task B4
 * bounds the blast radius to refresh time; this bounds it to one named check.
 */
export function checkBundled({ dir, catalogue, version, verified }) {
  if (!dir || !fs.existsSync(catalogue)) {
    return { name: "bundled-catalogue", ok: false, verdict: "amber",
      evidence: `CCR's bundled catalogue is not at ${catalogue}. The refresher's ` +
                `copy-out has nothing to copy; UW's own ~/.uw/catalog/ still works ` +
                `until it needs replacing. Fix: reinstall CCR, or set the path in ` +
                `ccr-client.mjs's resolveInstall() fallback` };
  }
  if (version && verified && version !== verified) {
    return { name: "bundled-catalogue", ok: false, verdict: "amber",
      evidence: `CCR is ${version}; ccr-client.mjs was verified against ${verified}. ` +
                `Re-check getConfig, probeProvider and the catalogue shape, then update ` +
                `CONTRACT.verifiedVersion` };
  }
  return { name: "bundled-catalogue", ok: true, verdict: "green",
    evidence: `CCR ${version ?? "(version unknown)"} at ${dir}` };
}

export function diagnose({ env, handoff, current, pinned, contracts, hud, handoffOpts,
                           bundled, ccrPatch, rpcSurface }) {
  const checks = [checkEnv(env), checkHandoff(handoff, handoffOpts),
                  checkFingerprint(current, pinned)];
  if (contracts) checks.push(checkContracts(contracts));
  if (bundled) checks.push(checkBundled(bundled));
  if (ccrPatch) checks.push(checkCcrPatch(ccrPatch));
  if (rpcSurface) checks.push(checkRpcSurface(rpcSurface));
  if (hud) checks.push(checkHud(hud));
  const verdict = checks.reduce((w, c) => (RANK[c.verdict] > RANK[w] ? c.verdict : w), "green");
  return { verdict, checks };
}

export function readClaudeFingerprint() {
  let out;
  try {
    out = execFileSync("claude", ["doctor"], { encoding: "utf8", timeout: 30000 });
  } catch {
    return { ran: false };                      // not on PATH, or it failed to run
  }
  const ccVersion = (out.match(/Running:\s*\S+\s*\(([^)]+)\)/) ?? [])[1];
  const ccCommit = (out.match(/Commit:\s*(\S+)/) ?? [])[1];
  // The distinction that makes checkFingerprint able to be honest: the command
  // RAN and produced output, but the output did not match. That is a broken probe,
  // not a missing Claude Code, and it is red rather than amber -- see
  // checkFingerprint. Conflating the two was what let a format change degrade into
  // "recorded, carry on".
  return { ran: true, ccVersion, ccCommit, parseFailed: !ccVersion,
           raw: out.slice(0, 400),
           invalidSettings: /Invalid settings/i.test(out) };
}

const readLines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean); }
                           catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };

// The one sample the HUD check round-trips. Deliberately a literal rather than a
// captured payload: a fixture that came from a live session would carry a session
// id and a transcript path into a file we print.
const HUD_SAMPLE = JSON.stringify({
  version: CC.CONTRACT.fingerprint,
  model: { id: "uw/probe", display_name: "probe" },
  context_window: { context_window_size: 1, current_usage: { input_tokens: 1 },
                    used_percentage: 50, remaining_percentage: 50 },
});

function hudRoundTrip() {
  try {
    const out = transform(HUD_SAMPLE, new Map([["uw/probe", 1000]]));
    if (!out) return { ok: false, why: "transform declined a payload it should have corrected" };
    const p = JSON.parse(out);
    if (p.context_window.context_window_size !== 1000) return { ok: false, why: "context size not applied" };
    if (p.model.display_name !== "probe") return { ok: false, why: "unrelated fields were lost" };
    return { ok: true, why: "" };
  } catch (e) { return { ok: false, why: String(e.message).slice(0, 80) }; }
}

export async function main() {
  const current = readClaudeFingerprint();
  const pinned = readJson(CAPABILITIES).fingerprint ?? {};
  const install = readJson(HUD_INSTALL).previousCommand ? readJson(HUD_INSTALL) : null;
  // Evidence that Claude Code has been used since the last recorded handoff:
  // the mtime of its own settings file, which it rewrites on ordinary use. Cheap,
  // approximate, and only ever used to decide amber-versus-red on a stale row.
  let claudeRunSince = null;
  try { claudeRunSince = fs.statSync(CC.CONTRACT.paths.settings).mtimeMs; } catch { }

  const r = diagnose({
    env: process.env, handoff: readLines(HANDOFF), current, pinned,
    handoffOpts: { now: Date.now(), claudeRunSince },
    contracts: { ccObserved: current.ccVersion, ccPinned: CC.CONTRACT.verifiedVersion ?? CC.CONTRACT.fingerprint,
                 service: CCR.readService() },
    bundled: { dir: CCR.CONTRACT.installDir, catalogue: CCR.CONTRACT.bundledCatalogue,
               version: CCR.ccrVersion(), verified: CCR.CONTRACT.verifiedVersion },
    ccrPatch: { file: CCR.CONTRACT.gatewayBundle },
    rpcSurface: await CCR.probeRpcSurface(),
    hud: install && {
      install,
      wrappedExists: fs.existsSync(String(install.previousCommand).match(/"([^"]+)"|(\S+)/)?.slice(1).find(Boolean) ?? ""),
      roundTrip: hudRoundTrip(),
    },
  });

  for (const c of r.checks) {
    console.log(`${c.verdict.toUpperCase().padEnd(6)} ${c.name.padEnd(20)} ${c.evidence}`);
  }
  console.log(`\nverdict: ${r.verdict}`);

  // PINNING IS AN EXPLICIT ACT, never a side effect of running the doctor.
  //
  // The previous version pinned on every non-red run. That makes the tool report
  // drift exactly once and then agree with whatever it found -- so a Claude Code
  // upgrade that silently broke the handoff would be flagged on the first run and
  // green on the second, with nothing having been verified in between. Recording a
  // fingerprint is a claim that the contract still holds against that version, and
  // only a human who has pressed ctrl+g can make that claim.
  if (process.argv.includes("--accept-fingerprint")) {
    if (!current.ccVersion) {
      console.log("\nnothing to pin: the version could not be read.");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(CAPABILITIES), { recursive: true });
    writeAtomic(CAPABILITIES,
      JSON.stringify({ fingerprint: current, at: new Date().toISOString(),
                       acceptedBy: "uw doctor --accept-fingerprint" }, null, 2));
    console.log(`\npinned ${current.ccVersion} (${current.ccCommit ?? "no commit"}).`);
  } else if (r.checks.some((c) => c.name === "cc-fingerprint" && c.verdict === "amber")) {
    console.log("\nrun `uw doctor --accept-fingerprint` once you have confirmed ctrl+g " +
                "still reaches the picker.");
  }
  process.exit(r.verdict === "red" ? 1 : 0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/doctor.mjs")) main();

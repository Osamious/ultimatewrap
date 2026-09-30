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
import { PATCHES, MARKERS, classify, describe } from "./ccr-patches.mjs";
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
      evidence: "the picker has never recorded an invocation — type `m` in the chat " +
                "input, THEN press ctrl+g, once; then re-run" };
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
          `editor protocol looks like. Type \`m\` in the chat input, THEN press ctrl+g; ` +
          `if nothing happens, re-verify CONTRACT.handoff against the running version`
        : `the last recorded handoff is ${days} days old — too old to be evidence. ` +
          `Type \`m\` in the chat input, THEN press ctrl+g, once; then re-run` };
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
                `the move is expected — the contract is not. Type \`m\` in the chat input, ` +
                `THEN press ctrl+g; confirm the picker opens and the selection lands ` +
                `in the chat input, then run \`uw doctor --accept-fingerprint\` to ` +
                `pin the new version` };
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

// version/verified are deliberately NOT defaulted: a standalone call that passes neither
// (the pre-existing contract, no version context at all) keeps the plain RED verdict, while
// any caller that supplies context, even null, is judged against it (null = unknown = AMBER).
export function checkCcrPatch({ file, read = null, version, verified }) {
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
  if (ms < GATEWAY_TIMEOUT_MIN_MS && (version !== undefined || verified !== undefined) && (!verified || version !== verified)) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `gateway handshake timeout is ${ms} ms (below ${GATEWAY_TIMEOUT_MIN_MS}) but ${unverifiedNote(version, verified)}. ${FIX_CMD}` };
  }
  if (ms < GATEWAY_TIMEOUT_MIN_MS) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "red",
      evidence: `CCR's gateway handshake timeout is ${ms} ms, below the patched ` +
                `${GATEWAY_TIMEOUT_MIN_MS} ms. An \`npm i -g @musistudio/claude-code-router\` has ` +
                `reverted the local patch. Symptom: "Core gateway did not accept runtime config ` +
                `within ${ms}ms" — INTERMITTENT and only under load, so it will read as ` +
                `flakiness. Re-apply: in ${file}, replace the first assignment after ` +
                `${GATEWAY_ANCHOR} with 2e4, keeping the file's existing line endings. ${FIX_CMD}` };
  }
  return { name: "ccr-gateway-patch", ok: true, verdict: "green",
    evidence: `gateway handshake timeout ${ms} ms (patched; stock is 5000)` };
}

// Patches B-E. `menu/ccr-patches.mjs` is the single source of what "patched"
// looks like (steps, markers, severity); nothing about the recipes is spelled
// here. The file bytes are trusted, never any manifest's patchIds (review note L3).
const FIX_CMD = "Check: `node keysync/ccr-patch.mjs --check`; fix: `node keysync/ccr-patch.mjs --apply`, " +
                "then restart the gateway (the running process keeps the old code until then; announce " +
                "the restart first, this doctor never restarts anything).";
// A missing patch is only RED when this exact CCR version is the one the recipes were verified
// for. An unknown version (package.json unreadable) or an unrecorded verified version cannot
// support that claim, so both demote to AMBER with their own wording.
const unverifiedNote = (version, verified) =>
  !verified ? `the version the recipes were verified for is not recorded, so this doctor cannot claim they apply`
  : !version ? `CCR version unknown (its package.json is unreadable), so the recipes verified for ${verified} cannot be confirmed to apply`
  : `CCR ${version} is not the ${verified} the recipes were verified for (Pd/QQe were fixed upstream in 3.1.0; the other patches are unverified on this version)`;

const patch = (id) => PATCHES.find((p) => p.id === id);
const CHECK_NAME = { B: "ccr-savecfg-patch", C: "ccr-pd-cache-patch", D: "ccr-findprovider-patch", E: "ccr-error-detail-patch" };

// Accepted by design (review F4): B counts as applied for ANY value >= 12e4, not only the
// exact recipe value. That is the tolerant numeric detector's contract (menu/ccr-patches.mjs);
// a larger hand-set timeout is still a working patch, so it is not reported as modified.
function judgePatch(p, text, ctx) {
  const name = CHECK_NAME[p.id];
  const stale = `the anchor for patch ${p.id} (${p.title}) is gone from ${ctx.file} — anchor gone: CCR was ` +
                `rebuilt and this check needs re-deriving. Do NOT assume the patch is absent; assume the check is stale`;
  const modified = (c) => ({ name, ok: false, verdict: "amber",
    evidence: `patch ${p.id} (${p.title}) is modified/unexpected, neither stock nor exactly the recipe: ` +
              `${describe(c)}. Do not re-apply blindly; inspect with \`node keysync/ccr-patch.mjs --check\`` });
  let state, detail = "";
  if (p.detect) {                                       // B: tolerant numeric detector
    const d = p.detect(text);
    if (d.state === "anchor-gone") return { name, ok: false, verdict: "amber", evidence: stale };
    state = d.state === "applied" ? "applied" : "stock";
    detail = `${d.value} ms`;
    // Below threshold is "missing" only when it is exactly the stock recipe;
    // any other value is a modified file, not an unpatched one.
    if (state === "stock") { const c = classify(text, p); if (c.state !== "stock") return modified(c); }
  } else {
    const c = classify(text, p);
    state = c.state;
    if (state === "unexpected") {
      const gone = c.steps.every((s) => s.find === 0 && s.replace === 0);
      const hasMarker = MARKERS[p.id].some((m) => text.includes(m));
      if (gone && !hasMarker) return { name, ok: false, verdict: "amber", evidence: stale };
      return modified(c);
    }
    detail = MARKERS[p.id][0];
  }
  if (state === "applied") {
    return { name, ok: true, verdict: "green", evidence: `${p.title}: patched (${detail})` };
  }
  const demote = !ctx.verified || ctx.version !== ctx.verified;
  const libOff = p.id === "E" && ctx.libVersion && p.verifiedFor?.gatewayLib && ctx.libVersion !== p.verifiedFor.gatewayLib;
  const verdict = p.severity === "red" && !demote && !libOff ? "red" : "amber";
  const why = demote ? unverifiedNote(ctx.version, ctx.verified)
    : libOff ? `ai-gateway ${ctx.libVersion} is not the ${p.verifiedFor.gatewayLib} recipe E was verified for`
    : `patch ${p.id} is missing`;
  return { name, ok: false, verdict,
    evidence: `${p.title} is NOT applied${detail ? ` (${detail})` : ""}: ${why}. ${FIX_CMD}` };
}

/**
 * Doctor coverage for patches B (saveConfig timeout), C (Pd cache), D (QQe cache)
 * and E (error detail). A is `checkCcrPatch`. `cliText` / `libText` are the file
 * contents already read (one read of the 2.3 MB cli.js is shared with A), or null
 * when unreadable; an unreadable file or a vanished anchor is AMBER, never "absent".
 */
export function checkCcrPatches({ cliText = null, libText = null, cliFile = "cli.js", libFile = "the ai-gateway bundle",
                                  version = null, verified = null, libVersion = null } = {}) {
  const out = [];
  for (const id of ["B", "C", "D", "E"]) {
    const p = patch(id);
    const [text, file] = p.file === "cli" ? [cliText, cliFile] : [libText, libFile];
    if (text == null) {
      out.push({ name: CHECK_NAME[id], ok: false, verdict: "amber",
        evidence: id === "E"
          ? `cannot read ${file} — anchor gone or moved: not at CCR.CONTRACT.gatewayLibBundle; if CCR now bundles ` +
            `ai-gateway inside cli.js, re-derive this check. Do NOT assume the patch is absent`
          : `cannot read ${file} — patch ${id} (${p.title}) cannot be verified` });
      continue;
    }
    out.push(judgePatch(p, text, { file, version, verified, libVersion }));
  }
  return out;
}

/**
 * The slow-startup regression, checked rather than remembered. With
 * CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY set, Claude Code fetches the whole
 * gateway model list at every launch and processes the cache it writes; at UW's
 * ~6,000 models that was ~100 s of CPU against ~16 s (MEASURED 2026-09-09,
 * re-confirmed 2026-09-29: 10.4 s once removed).
 *
 * CCR writes the variable back on every profile apply, so this fails again
 * whenever something OTHER than `keysync/run.mjs` (which strips it) re-applied
 * CCR's profile -- the CCR web UI, a restart -- and that is exactly the case
 * this exists to catch. `envValue` is the raw value or undefined; `cacheBytes` is
 * the cache file's size or null when absent.
 */
export const GATEWAY_DISCOVERY_CACHE_WARN_BYTES = 200_000;
export function checkGatewayDiscovery({ envValue, cacheBytes }) {
  const name = "startup-discovery";
  if (envValue !== undefined) {
    return { name, ok: false, verdict: "red",
      evidence: `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY is set (${JSON.stringify(envValue)}) in ` +
                `Claude Code's settings env. CCR re-adds it on every profile apply and it makes ` +
                `launch ~10x slower at this model count. Re-run \`node keysync/run.mjs --target ` +
                `live --i-know\` (it strips the variable), or delete the env entry by hand` };
  }
  if (cacheBytes != null && cacheBytes > GATEWAY_DISCOVERY_CACHE_WARN_BYTES) {
    return { name, ok: false, verdict: "amber",
      evidence: `the variable is unset but a ${Math.round(cacheBytes / 1024)} KB gateway-models.json ` +
                `cache remains from an earlier session. A launch that inherits the variable from a ` +
                `parent shell regenerates it; rename the file to set it aside` };
  }
  return { name, ok: true, verdict: "green",
    evidence: "gateway model discovery is off; no oversized gateway-models cache" };
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
export function checkRpcSurface({ methods, states, installedVersion, runningVersion }) {
  const names = Object.keys(methods ?? {});
  const missing = Object.entries(methods ?? {}).filter(([, ok]) => !ok).map(([m]) => m);

  // "The method did not answer" has four causes with three different owners, and
  // collapsing them was this check's original defect: it reported RED "the method
  // names moved in an upgrade" for every one of them. All four were measured
  // against the live gateway before this was written.
  const kinds = Object.entries(states ?? {});
  const withState = (s) => kinds.filter(([, v]) => v === s).map(([m]) => m);
  const authFailed = withState("auth");
  const timedOut = withState("timeout");
  const refused = [...withState("refused"), ...withState("no-service")];

  // UW's own bug, and the only one of the four that is. The RPC returns 401
  // without `x-ccr-web-auth` and 200 with it, so if this fires the client is not
  // sending service.json's ccr_web_token. Red, and the remedy points at us.
  if (authFailed.length) {
    return { name: "ccr-rpc", ok: false, verdict: "red",
      evidence: `CCR rejected the credential on ${authFailed.join(", ")} (HTTP 401/403). The ` +
                `gateway is alive and UW is not authenticating: rpc() must send the ` +
                `${CCR.CONTRACT.authHeader} header carrying the ${CCR.CONTRACT.tokenParam} from ` +
                `service.json's url. This is a UW defect, not a CCR one` };
  }
  // Nothing listening. This is the stale-descriptor case: service.json survives a
  // stopped gateway, so it is readable while the port is dead.
  if (names.length && refused.length === names.length) {
    return { name: "ccr-rpc", ok: false, verdict: "amber",
      evidence: `nothing is listening on CCR's RPC port — the gateway is not running, or ` +
                `service.json is stale. Start CCR and re-run` };
  }
  // Alive but slower than the budget. MEASURED on this machine: getAppInfo takes
  // ~7.2 s repeatably while getConfig answers in 6 ms, and an aborted request
  // keeps the gateway busy, so the calls queued behind it time out too and the
  // whole surface reads as missing. The probe budget is now 15 s for exactly this.
  if (timedOut.length) {
    return { name: "ccr-rpc", ok: false, verdict: "amber",
      evidence: `CCR did not answer ${timedOut.join(", ")} inside the probe budget. The gateway ` +
                `is reachable — it is slow, not absent. getAppInfo has been measured at ~7.2 s ` +
                `on this machine while getConfig answers in 6 ms; an aborted call keeps the ` +
                `gateway busy, so anything queued behind it times out as well` };
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
                           bundled, ccrPatch, ccrPatches, rpcSurface, gatewayDiscovery }) {
  const checks = [checkEnv(env), checkHandoff(handoff, handoffOpts),
                  checkFingerprint(current, pinned)];
  if (contracts) checks.push(checkContracts(contracts));
  if (bundled) checks.push(checkBundled(bundled));
  if (ccrPatch) checks.push(checkCcrPatch(ccrPatch));
  if (ccrPatches) checks.push(...checkCcrPatches(ccrPatches));
  if (gatewayDiscovery) checks.push(checkGatewayDiscovery(gatewayDiscovery));
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

// Paths come from the Claude Code contract module, never spelled here: the
// cache lives beside settings under the same config directory.
function gatewayDiscoveryInputs() {
  const settingsFile = CC.CONTRACT.paths.settings;
  let envValue;
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^﻿/, ""));
    envValue = s?.env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
  } catch { /* unreadable settings: report the variable as absent, not as a crash */ }
  let cacheBytes = null;
  try {
    cacheBytes = fs.statSync(path.join(path.dirname(settingsFile), "cache", "gateway-models.json")).size;
  } catch { /* no cache file */ }
  return { envValue, cacheBytes };
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

  // cli.js is 2.3 MB: read it ONCE and share it between patch A and B-D.
  const readOrNull = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };
  const cliText = readOrNull(CCR.CONTRACT.gatewayBundle);
  const libText = readOrNull(CCR.CONTRACT.gatewayLibBundle);
  const ccrVersion = CCR.ccrVersion();

  const r = diagnose({
    env: process.env, handoff: readLines(HANDOFF), current, pinned,
    handoffOpts: { now: Date.now(), claudeRunSince },
    contracts: { ccObserved: current.ccVersion, ccPinned: CC.CONTRACT.verifiedVersion ?? CC.CONTRACT.fingerprint,
                 service: CCR.readService() },
    bundled: { dir: CCR.CONTRACT.installDir, catalogue: CCR.CONTRACT.bundledCatalogue,
               version: ccrVersion, verified: CCR.CONTRACT.verifiedVersion },
    ccrPatch: { file: CCR.CONTRACT.gatewayBundle, read: () => { if (cliText == null) throw new Error("unreadable"); return cliText; },
                version: ccrVersion, verified: CCR.CONTRACT.verifiedVersion },
    ccrPatches: { cliText, libText, cliFile: CCR.CONTRACT.gatewayBundle, libFile: CCR.CONTRACT.gatewayLibBundle,
                  version: ccrVersion, verified: CCR.CONTRACT.verifiedVersion, libVersion: CCR.gatewayLibVersion() },
    gatewayDiscovery: gatewayDiscoveryInputs(),
    rpcSurface: await CCR.probeRpcSurface(),
    hud: install && {
      install,
      wrappedExists: fs.existsSync(String(install.previousCommand).match(/"([^"]+)"|(\S+)/)?.slice(1).find(Boolean) ?? ""),
      roundTrip: hudRoundTrip(),
    },
  });

  for (const c of r.checks) {
    console.log(`${c.verdict.toUpperCase().padEnd(6)} ${c.name.padEnd(22)} ${c.evidence}`);
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
      // `return`, not a bare exitCode assignment: the write below must not run.
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.dirname(CAPABILITIES), { recursive: true });
    writeAtomic(CAPABILITIES,
      JSON.stringify({ fingerprint: current, at: new Date().toISOString(),
                       acceptedBy: "uw doctor --accept-fingerprint" }, null, 2));
    console.log(`\npinned ${current.ccVersion} (${current.ccCommit ?? "no commit"}).`);
  } else if (r.checks.some((c) => c.name === "cc-fingerprint" && c.verdict === "amber")) {
    console.log("\nrun `uw doctor --accept-fingerprint` once you have confirmed that " +
                "typing `m` and THEN pressing ctrl+g still reaches the picker.");
  }
  // `process.exitCode`, never `process.exit()`. MEASURED on Node v25.0.0/win32:
  // calling process.exit() here aborted the process with
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
  // and a status of 127 on EVERY run -- amber and red alike -- because
  // probeRpcSurface()'s AbortSignal.timeout handles and undici's sockets are
  // still closing when exit() forces libuv to tear them down. The report printed
  // correctly throughout; only the status was wrong, which is the half a script
  // reads, and 127 is the shell's "command not found" -- indistinguishable from
  // this file being absent. Bisected: execFileSync alone, one rpc() alone, both
  // in either order, and fetch-then-exit are all clean.
  //
  // Assigning the code and letting the loop drain is the idiomatic form and fixes
  // it. It is also correct independently of that assertion, since process.exit()
  // discarding pending work is a hazard on any platform.
  process.exitCode = r.verdict === "red" ? 1 : 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/doctor.mjs")) main();

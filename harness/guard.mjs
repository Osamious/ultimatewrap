// Isolation and correctness guards. Everything here fails loudly and stops the
// run. Two rules, learned the hard way:
//   1. Assert, never print-and-eyeball. A printed safety value is not a check.
//   2. Validate the payload you are ABOUT to send, not just the echo you get back.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  CCR_CONFIG_DIR, WEB_PORT, GATEWAY_PORT, GATEWAY_CORE_PORT, LIVE_PORTS,
  LIVE_SETTINGS, LIVE_CLAUDE_3P_DIR, LIVE_DOWNLOADS, SCRATCH_CLAUDE_3P,
  SCRATCH_SETTINGS, TRIPWIRE_FILES, DAEMON_STAMP, resolveWebPort, rpc
} from "./config.mjs";

class IsolationError extends Error {}

export function fail(msg) {
  throw new IsolationError(`ISOLATION VIOLATION: ${msg}`);
}

function ps(cmd) {
  return execFileSync("powershell", ["-NoProfile", "-Command", cmd], { encoding: "utf8" }).trim();
}

export function listenerPid(port) {
  const out = ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const pid = Number(out);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function hashFile(file) {
  // A locked or permission-denied file must not throw out of the tripwire (the safety check would abort the run it protects, and in teardown before any
  // cleanup): it becomes its own fingerprint, so a file that turns unreadable still counts as a change.
  try { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch (e) { return e && e.code === "ENOENT" ? "(absent)" : `(unreadable:${e && e.code})`; }
}

/**
 * Fingerprint of the NAMES in a directory (never contents, sizes or mtimes): `recursive` walks subdirectories (relative paths). A name that appears,
 * disappears or changes is a change; a file being written to, a download in progress or an app's own churn is not.
 */
function hashNames(dir, recursive = false) {
  if (!fs.existsSync(dir)) return "(absent)";
  const names = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } // unreadable subdir: ignore rather than abort the run
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && recursive) { walk(p); continue; }
      names.push(`${e.isDirectory() ? "d" : "f"}:${path.relative(dir, p)}`);
    }
  };
  walk(dir);
  return crypto.createHash("sha256").update(names.sort().join("\n")).digest("hex");
}

/**
 * Tripwire over live state. Deliberately covers only files that are NOT
 * otherwise isolated — anything redirected via CLAUDE_CONFIG_DIR is excluded,
 * because a tripwire that fires on normal operation gets switched off.
 */
export function userPathFingerprint() {
  return ps(`[Environment]::GetEnvironmentVariable('Path','User')`);
}

/**
 * Claude-3p is the LIVE Claude desktop app's userData (hundreds of files; sentry/scope_v3.json, session.json and logs/ change every ~30 s while the app is
 * open, and config.json / claude_desktop_config.json carry the app's own state: bootFrameLayout, quickWindowPosition, updaterBannerStagedAt, `preferences`...),
 * so it is NOT content-hashed as a tree and its top-level names are NOT listed (per-launch host-creds-<guid>.json files appear there). What CCR's desktop sync
 * rewrites on EVERY sync is the configLibrary folder (verified in CCR 3.0.22 dist/main/cli.js `Pl()`: hb(configLibraryFile, {..., inferenceModelsUpdatedAt: new Date()})
 * changes <id>.json's bytes every time, vNe(metaFile) merges _meta.json), so the tripwire fingerprints that folder: the NAME of every entry, and the sha256 of the
 * CONTENT of every *.json in it (<id>.json and _meta.json included). A sync that reached the real Claude-3p changes <id>.json, so it trips.
 * claude_desktop_config.json is NOT hashed: CCR's write there (`SNe`) is an idempotent merge of deploymentMode:"3p" (already "3p" on this machine, so the bytes
 * would not change and a hash could not detect a sync), while the desktop app rewrites `preferences` in the same file.
 * NO LONGER COVERED by the tripwire (covered by the preload guard in the daemon tree, the LOCALAPPDATA redirect and assertDesktopSyncLandedInScratch): other
 * Claude-3p files edited in place, new top-level or nested names, and model-catalog/.
 */
export const CLAUDE_3P_LIBRARY = "configLibrary";

/** Names (f:/d: prefixed) of every entry in a directory plus the content sha256 of each *.json: a rename, a new or removed entry or an in-place edit of a .json changes it. */
function hashLibrary(dir) {
  if (!fs.existsSync(dir)) return "(absent)";
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return `(unreadable:${e && e.code})`; }
  const rows = entries.map((e) => (e.isDirectory() ? `d:${e.name}` : `f:${e.name}:${/\.json$/i.test(e.name) ? hashFile(path.join(dir, e.name)) : "-"}`));
  return crypto.createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

/** The named fingerprints the tripwire compares. Every directory is a parameter so tests run on a temp tree; the defaults are the live paths. */
export function tripwireCollectors(files = TRIPWIRE_FILES, { claude3pDir = LIVE_CLAUDE_3P_DIR, downloadsDir = LIVE_DOWNLOADS, userPath = userPathFingerprint } = {}) {
  const c = new Map(files.map((f) => [f, () => hashFile(f)]));
  const lib = path.join(claude3pDir, CLAUDE_3P_LIBRARY);
  c.set(`library:${lib}`, () => hashLibrary(lib));
  // exportData writes every provider key to ~/Downloads in one RPC call; a new file appearing there during a run would be a key breach.
  // NAMES only (recursive): a download in progress, or another process writing into an existing file, does not trip it.
  c.set(`names:${downloadsDir}`, () => hashNames(downloadsDir, true));
  // CCR can splice a bin dir into the persistent user PATH (HKCU\Environment), which no file hash would ever see.
  c.set("env:userPath", userPath);
  return c;
}

export function makeTripwire(files = TRIPWIRE_FILES, opts = {}) {
  const collectors = tripwireCollectors(files, opts);
  const baseline = new Map([...collectors].map(([k, fn]) => [k, fn()]));
  return {
    assert(stage) {
      for (const [key, want] of baseline) {
        const got = collectors.get(key)();
        if (got !== want) {
          fail(`${key} CHANGED during "${stage}" — a write reached live state. Stop and restore. ` +
            `(was ${want.slice(0, 12)}, now ${got.slice(0, 12)})`);
        }
      }
    }
  };
}

/**
 * Identity: the daemon answering our port is the isolated one. Uses CCR's own
 * getAppInfo, which reports the paths the daemon actually resolved — stronger
 * than inferring them from where a file happens to exist.
 */
export async function assertIsolatedInstance() {
  // Authoritative port comes from the daemon's own service.json: CCR scans up to
  // 20 ports forward from CCR_WEB_PORT on EADDRINUSE, so the constant can be
  // wrong. resolveWebPort() also proves our CCR_WEB_AUTH_TOKEN reached it.
  const { port, pid: svcPid } = resolveWebPort();
  if (port !== WEB_PORT) {
    fail(`daemon bound web port ${port}, not ${WEB_PORT} — something already held ${WEB_PORT}.`);
  }
  const pid = listenerPid(port);
  if (!pid) fail(`nothing listening on isolated web port ${port}`);
  if (pid !== svcPid) fail(`port ${port} served by pid ${pid}, but service.json claims ${svcPid}`);

  // A stale daemon started before the current start.ps1 would inherit the old
  // env and still satisfy every other check. The stamp ties this daemon to this
  // harness version's environment.
  if (!fs.existsSync(DAEMON_STAMP)) {
    fail(`no daemon env stamp at ${DAEMON_STAMP} — the running daemon was not started by this harness.`);
  }
  const stamp = JSON.parse(fs.readFileSync(DAEMON_STAMP, "utf8"));
  if (stamp.pid !== svcPid) {
    fail(`daemon env stamp pid ${stamp.pid} != running daemon pid ${svcPid} — a STALE daemon is ` +
      `answering, and it may not have the LOCALAPPDATA/CCR_CONFIG_DIR redirects. Restart it.`);
  }

  const info = await rpc("getAppInfo");
  for (const [field, value] of Object.entries({
    configDir: info.configDir, dataDir: info.dataDir, configDbFile: info.configDbFile
  })) {
    if (!value || !value.toLowerCase().startsWith(CCR_CONFIG_DIR.toLowerCase())) {
      fail(`daemon reports ${field}="${value}", which is not under the scratch CONFIGDIR ` +
        `(${CCR_CONFIG_DIR}). CCR_INTERNAL_APP_DATA_DIR did not take effect — this may be a live instance.`);
    }
  }
  return { pid, info };
}

/** Confirms no live CCR instance is running that we could hit by mistake. */
export function assertLivePortsClosed() {
  const open = LIVE_PORTS.filter((p) => listenerPid(p) !== undefined);
  if (open.length) {
    fail(`live CCR port(s) ${open.join(", ")} are listening. Stop the live instance first.`);
  }
}

const SIX_ISOLATION_FIELDS = (cfg) => ({
  "gateway.host": cfg.gateway?.host,
  "gateway.port": cfg.gateway?.port,
  "gateway.corePort": cfg.gateway?.corePort,
  "HOST": cfg.HOST,
  "PORT": cfg.PORT,
  "profile.claudeCode.settingsFile": cfg.profile?.claudeCode?.settingsFile
});

/**
 * Validates a config object BEFORE it is sent. Everything else in this module
 * is post-hoc; this is the only check that can prevent rather than detect.
 */
export function assertPayloadIsolated(cfg, { allowProviders = false } = {}) {
  assertLiveSettingsUnreachable(cfg);
  const f = SIX_ISOLATION_FIELDS(cfg);
  if (f["gateway.port"] !== GATEWAY_PORT) fail(`payload gateway.port=${f["gateway.port"]}, expected ${GATEWAY_PORT}`);
  if (f["gateway.corePort"] !== GATEWAY_CORE_PORT) fail(`payload gateway.corePort=${f["gateway.corePort"]}, expected ${GATEWAY_CORE_PORT}`);
  if (f["PORT"] !== GATEWAY_PORT) fail(`payload PORT=${f["PORT"]}, expected ${GATEWAY_PORT}`);
  for (const [k, v] of Object.entries(f)) {
    if (LIVE_PORTS.includes(v)) fail(`payload ${k}=${v} is a LIVE CCR port`);
  }
  if ((f["profile.claudeCode.settingsFile"] || "").toLowerCase() !== SCRATCH_SETTINGS.toLowerCase()) {
    fail(`payload profile.claudeCode.settingsFile="${f["profile.claudeCode.settingsFile"]}", expected scratch ${SCRATCH_SETTINGS}`);
  }
  for (const p of cfg.profile?.profiles ?? []) {
    if (p.agent !== "claude-code") continue;
    const target = (p.settingsFile || "").replace(/^~/, process.env.USERPROFILE || "~");
    if (!p.settingsFile) fail(`profile "${p.id}" has a BLANK settingsFile — CCR defaults that to the LIVE ~/.claude/settings.json`);
    if (target.toLowerCase() === LIVE_SETTINGS.toLowerCase()) fail(`profile "${p.id}" targets LIVE settings`);
    if (target.toLowerCase() !== SCRATCH_SETTINGS.toLowerCase()) fail(`profile "${p.id}" settingsFile "${p.settingsFile}" is not the scratch file`);
  }
  // CCR's saveConfig arms a model auto-refresh loop for a provider with autoFetchModels, and its onConfigChanged runs the global profile apply with no applyProfile opt-out: refused for EVERY provider, whatever allowProviders says.
  for (const p of cfg.Providers ?? []) if (p && p.autoFetchModels) fail(`provider "${p.name}" has autoFetchModels set: CCR's model auto-refresh would run the global profile apply (no applyProfile opt-out) on a config change`);
  if (!allowProviders && (cfg.Providers?.length ?? 0) > 0) {
    fail(`payload carries ${cfg.Providers.length} provider(s). A model-carrying save triggers CCR's ` +
      `Claude-desktop-app sync (dist gate is model-availability only). Pass {allowProviders:true} once ` +
      `the LOCALAPPDATA redirect is proven.`);
  }
  return cfg;
}

/**
 * COUNTERINTUITIVE AND LOAD-BEARING: `profile.enabled = false` force-disables
 * every profile, and CCR's restore path then fires targeting the LITERAL
 * `~/.claude/settings.json` — so "disable profiles to be safe" is precisely the
 * configuration that reaches for the live file. The same applies to removing the
 * last enabled global claude-code profile. Teardown is therefore MORE dangerous
 * than setup: scrub Providers[], never disable the subsystem.
 */
export function assertLiveSettingsUnreachable(cfg) {
  if (cfg.profile?.enabled === false) {
    fail(`profile.enabled=false force-disables every profile, which makes CCR's restore path ` +
      `target the literal ~/.claude/settings.json. Keep it true; disable individual profiles instead.`);
  }
  const anchors = (cfg.profile?.profiles ?? []).filter(
    (p) => p.agent === "claude-code" && p.enabled === true && p.scope === "global"
  );
  if (anchors.length === 0) {
    fail(`no enabled global claude-code anchor profile remains — CCR's restore path would fire ` +
      `at the live ~/.claude/settings.json.`);
  }
  // Non-claude-code agents reach code paths that read %APPDATA% directly
  // (the embedded codex middleware), bypassing CCR_INTERNAL_APP_DATA_DIR.
  const foreign = (cfg.profile?.profiles ?? []).filter((p) => p.agent !== "claude-code" && p.enabled !== false);
  if (foreign.length) {
    fail(`enabled non-claude-code profile(s) ${JSON.stringify(foreign.map((p) => p.id))} — these can ` +
      `resolve their config dir from the real %APPDATA%, escaping isolation. Disable them.`);
  }
}

/** Post-hoc: the persisted config still satisfies isolation (CCR normalizes on save). */
export async function assertIsolatedConfig(cfg) {
  const c = cfg ?? await rpc("getConfig");
  assertLiveSettingsUnreachable(c);
  const f = SIX_ISOLATION_FIELDS(c);
  if (f["gateway.port"] !== GATEWAY_PORT) fail(`persisted gateway.port=${f["gateway.port"]}`);
  if (f["gateway.corePort"] !== GATEWAY_CORE_PORT) fail(`persisted gateway.corePort=${f["gateway.corePort"]}`);
  if (f["PORT"] !== GATEWAY_PORT) fail(`persisted PORT=${f["PORT"]} (normalization may have reset it)`);
  if ((f["profile.claudeCode.settingsFile"] || "").toLowerCase() !== SCRATCH_SETTINGS.toLowerCase()) {
    fail(`persisted profile.claudeCode.settingsFile="${f["profile.claudeCode.settingsFile"]}"`);
  }
  for (const p of c.profile?.profiles ?? []) {
    if (p.agent !== "claude-code") continue;
    const target = (p.settingsFile || "").replace(/^~/, process.env.USERPROFILE || "~");
    if (!p.settingsFile || target.toLowerCase() !== SCRATCH_SETTINGS.toLowerCase()) {
      fail(`persisted profile "${p.id}" settingsFile="${p.settingsFile}" is not the scratch file`);
    }
  }
  return c;
}

/**
 * Phase 2.5's first acceptance criterion, as an assertion rather than a print.
 * MUST run before Providers[] is written: a response served by a fallback or a
 * rewrite rule would satisfy "content came back" while proving nothing.
 */
export function assertRouterClean(cfg) {
  const fb = cfg.Router?.fallback ?? {};
  const mode = fb.mode;
  // Three-way branch: the plan is explicit that "off" vs "not off" is not enough.
  if (mode === "off") {
    if ((fb.models ?? []).length) fail(`Router.fallback.mode="off" but models[] is non-empty: ${JSON.stringify(fb.models)}`);
  } else if (mode === "retry") {
    fail(`Router.fallback.mode="retry" — retries bypass models[] but can still mask a failing route. ` +
      `Set it to "off" for the spike.`);
  } else if (mode === "model-chain") {
    fail(`Router.fallback.mode="model-chain" with chain ${JSON.stringify(fb.models ?? [])} — ` +
      `a chained model could serve the response and false-green the test.`);
  } else {
    fail(`Router.fallback.mode="${mode}" is unrecognized; refusing to guess its semantics.`);
  }

  const enabledRules = (cfg.Router?.rules ?? []).filter((r) => r.enabled !== false);
  if (enabledRules.length) {
    fail(`${enabledRules.length} ENABLED Router.rules entr(ies) can rewrite model/provider: ` +
      `${JSON.stringify(enabledRules.map((r) => r.id ?? r.name ?? r))}`);
  }

  for (const p of cfg.profile?.profiles ?? []) {
    const am = p.availableModels ?? [];
    if (am.length) {
      fail(`profile "${p.id}" has a non-empty availableModels allowlist ${JSON.stringify(am)} — ` +
        `picker rows outside it silently show nothing. Assert it is a superset before proceeding.`);
    }
  }
}

/**
 * Proves the LOCALAPPDATA redirect actually took effect, by requiring CCR's
 * desktop-app sync to have landed in scratch. Only meaningful AFTER a
 * model-carrying save, because the sync is gated on model availability.
 */
export function assertDesktopSyncLandedInScratch() {
  const scratchRoot = path.join(SCRATCH_CLAUDE_3P, "claude_desktop_config.json");
  if (!fs.existsSync(scratchRoot)) {
    fail(`CCR's desktop-app sync did NOT write to the scratch LOCALAPPDATA (${scratchRoot}). ` +
      `It went somewhere else — most likely the real %LOCALAPPDATA%\\Claude-3p. Abort and check start.ps1.`);
  }
}

/** The gateway is not merely configured on the isolated port — it bound it. */
export function assertGatewayBound() {
  const pid = listenerPid(GATEWAY_PORT);
  if (!pid) fail(`gateway is not listening on isolated port ${GATEWAY_PORT}`);
  return pid;
}

export { IsolationError };

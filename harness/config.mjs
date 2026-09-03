// UltimateWrap isolated-test harness — shared constants.
// Every value here exists to keep tests off live state.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const SCRATCH_ROOT = "C:\\Users\\osami\\.uw\\harness\\scratch";

// CCR resolves CONFIGDIR as <appData>/claude-code-router, reading appData from
// CCR_INTERNAL_APP_DATA_DIR when set.
export const CCR_APP_DATA_DIR = path.join(SCRATCH_ROOT, "appdata");
export const CCR_CONFIG_DIR = path.join(CCR_APP_DATA_DIR, "claude-code-router");
export const CCR_SERVICE_JSON = path.join(CCR_CONFIG_DIR, "service.json");
export const DAEMON_STAMP = path.join(SCRATCH_ROOT, "daemon-env.json");

// CCR's Claude-desktop-app sync targets `process.env.LOCALAPPDATA\Claude-3p`
// (dist `wNe()`), which CCR_INTERNAL_APP_DATA_DIR does NOT cover. Verified in
// the installed 3.0.22 dist: that sync's ONLY gate is `ic(e)` = "at least one
// enabled provider with a model". There is no `surface !== "cli"` gate in the
// shipped build despite the TS source reference showing one, so `surface` is a
// decoy and must never be relied on. Redirecting LOCALAPPDATA is the real fix.
export const CCR_LOCAL_APP_DATA_DIR = path.join(SCRATCH_ROOT, "localappdata");
export const SCRATCH_CLAUDE_3P = path.join(CCR_LOCAL_APP_DATA_DIR, "Claude-3p");

// Ports. CCR_WEB_PORT is a STARTING port — CCR scans up to 20 ports forward on
// EADDRINUSE and records the bound one in service.json. Never assume this
// constant is the live port; resolveWebPort() below is authoritative.
export const WEB_PORT = 39458;
export const GATEWAY_PORT = 39456;
export const GATEWAY_CORE_PORT = 39457;
export const LIVE_PORTS = [3456, 3457, 3458];
export const WEB_AUTH_TOKEN = "uw-harness-local-only-token";

// The scratch settings file CCR's applyProfile may write, and the test CLI's own
// config root. `--settings` only LAYERS a settings file; it does not relocate
// ~/.claude.json, sessions, history or credentials. CLAUDE_CONFIG_DIR does.
export const SCRATCH_SETTINGS = path.join(SCRATCH_ROOT, "claude-settings.json");
export const SCRATCH_CLAUDE_CONFIG_DIR = path.join(SCRATCH_ROOT, "claude-config");

// Live state that must never change. Resolved from os.homedir() so a scratch-env
// shell cannot poison these into pointing at the scratch tree.
export const LIVE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
export const LIVE_CLAUDE_3P_DIR = path.join("C:\\Users\\osami\\AppData\\Local", "Claude-3p");
export const LIVE_DOWNLOADS = path.join(os.homedir(), "Downloads");
export const TRIPWIRE_FILES = [LIVE_SETTINGS];

export const ENV = {
  CCR_INTERNAL_APP_DATA_DIR: CCR_APP_DATA_DIR,
  CCR_CONFIG_DIR, // the embedded codex middleware reads APPDATA directly; this pins it
  LOCALAPPDATA: CCR_LOCAL_APP_DATA_DIR,
  CCR_WEB_HOST: "127.0.0.1",
  CCR_WEB_PORT: String(WEB_PORT),
  CCR_WEB_AUTH_TOKEN: WEB_AUTH_TOKEN
};

/**
 * The port the daemon ACTUALLY bound, from its own service.json. Using the
 * constant instead would silently address a different process when CCR's
 * port-scan fallback shifts the bind.
 */
export function resolveWebPort() {
  if (!fs.existsSync(CCR_SERVICE_JSON)) {
    throw new Error(`no service.json at ${CCR_SERVICE_JSON} — isolated daemon not running`);
  }
  const svc = JSON.parse(fs.readFileSync(CCR_SERVICE_JSON, "utf8"));
  const url = new URL(svc.url);
  const token = url.searchParams.get("ccr_web_token");
  if (token !== WEB_AUTH_TOKEN) {
    throw new Error(`service.json token does not match CCR_WEB_AUTH_TOKEN — the env did not ` +
      `reach the daemon, so this may not be our instance`);
  }
  return { port: Number(url.port), pid: svc.pid };
}

export async function rpc(method, args = []) {
  const { port } = resolveWebPort();
  const res = await fetch(`http://127.0.0.1:${port}/api/ccr/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ccr-web-auth": WEB_AUTH_TOKEN },
    body: JSON.stringify({ method, args })
  });
  const json = await res.json();
  // Never interpolate the config/provider objects: getConfig returns api_key
  // values unredacted, and an error string is the easiest place for one to leak.
  if (!json.ok) throw new Error(`${method} failed: ${String(json.error?.message).slice(0, 300)}`);
  return json.value;
}

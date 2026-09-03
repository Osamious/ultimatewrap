// Makes a freshly-created isolated CCR config safe BEFORE anything sensitive
// is written to it. Ordering is deliberate: ports, settingsFile and surface are
// all corrected while Providers[] is still empty and applyProfile is false, so
// no gateway binds and no settings file is written until isolation is proven.

import fs from "node:fs";
import {
  GATEWAY_PORT, GATEWAY_CORE_PORT, SCRATCH_SETTINGS, LIVE_SETTINGS, rpc
} from "./config.mjs";
import {
  assertIsolatedInstance, assertIsolatedConfig, assertPayloadIsolated,
  assertLivePortsClosed, makeTripwire
} from "./guard.mjs";

const tripwire = makeTripwire();
tripwire.assert("bootstrap:start");

assertLivePortsClosed();
const { pid, info } = await assertIsolatedInstance();
console.log(`isolated daemon confirmed: pid ${pid}`);
console.log(`  configDir (from daemon): ${info.configDir}`);

const cfg = await rpc("getConfig");
if (cfg.Providers?.length) {
  throw new Error(`refusing to bootstrap: isolated config already has ${cfg.Providers.length} provider(s); ` +
    `expected a clean instance`);
}

// Ports: move the gateway off CCR's defaults so it can never bind a live port.
cfg.gateway = { ...cfg.gateway, host: "127.0.0.1", port: GATEWAY_PORT, corePort: GATEWAY_CORE_PORT };
cfg.HOST = "127.0.0.1";
cfg.PORT = GATEWAY_PORT;

// Settings target: the single lever whose absence caused the 2026-09-01 outage.
if (!fs.existsSync(SCRATCH_SETTINGS)) {
  fs.writeFileSync(SCRATCH_SETTINGS, JSON.stringify({}, null, 2) + "\n");
}
cfg.profile.enabled = true; // NEVER false: that arms CCR's restore path at the LIVE settings file
for (const p of cfg.profile.profiles) {
  if (p.agent !== "claude-code") {
    // Non-claude-code agents (codex/bot-gateway) reach code that reads %APPDATA%
    // directly, escaping CCR_INTERNAL_APP_DATA_DIR.
    p.enabled = false;
    continue;
  }
  p.enabled = true;
  p.scope = "global";        // required for the anchor that keeps the restore path from firing
  p.settingsFile = SCRATCH_SETTINGS;
  // NOTE: surface is set for tidiness only. It is NOT a safety control — the
  // shipped build has no surface gate on the desktop-app sync.
  p.surface = "cli";
}
cfg.profile.claudeCode = { ...cfg.profile.claudeCode, settingsFile: SCRATCH_SETTINGS };

// applyProfile:false keeps CCR from writing any settings file. Note it does NOT
// block the Claude-desktop-app sync, which runs earlier inside saveConfig and is
// gated only on model availability — what actually makes this save safe is the
// empty Providers[] asserted above and re-checked by assertPayloadIsolated.
assertPayloadIsolated(cfg);
await rpc("saveConfig", [cfg, { applyProfile: false }]);

await assertIsolatedConfig();
tripwire.assert("bootstrap:end");

console.log("bootstrap OK");
console.log(`  gateway      -> 127.0.0.1:${GATEWAY_PORT} (core ${GATEWAY_CORE_PORT})`);
console.log(`  settingsFile -> ${SCRATCH_SETTINGS}`);
console.log(`  live settings untouched -> ${LIVE_SETTINGS}`);

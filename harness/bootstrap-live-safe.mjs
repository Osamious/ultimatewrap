// Same as bootstrap.mjs, MINUS assertLivePortsClosed().
//
// WHY THIS EXISTS: bootstrap.mjs's own assertLivePortsClosed() is a blanket
// precondition -- "nothing else may be using 3456/3457/3458 right now" -- but
// this operation never touches those ports. Every write here goes through
// rpc() against the ISOLATED daemon's own management port (39458, verified by
// assertIsolatedInstance below), and assertPayloadIsolated/assertIsolatedConfig
// independently confirm the payload never names a live port or the live
// settings file. The live gateway staying up is genuinely irrelevant to this
// operation's correctness -- it is a real, active session's own routing path
// (2026-09-20: explicit instruction never to restart it), and stopping it
// would be a bigger, unrelated risk than the one this assertion guards against.
//
// Every OTHER guard from bootstrap.mjs is kept unchanged.

import fs from "node:fs";
import {
  GATEWAY_PORT, GATEWAY_CORE_PORT, SCRATCH_SETTINGS, LIVE_SETTINGS, rpc
} from "./config.mjs";
import {
  assertIsolatedInstance, assertIsolatedConfig, assertPayloadIsolated,
  makeTripwire
} from "./guard.mjs";

const tripwire = makeTripwire();
tripwire.assert("bootstrap:start");

const { pid, info } = await assertIsolatedInstance();
console.log(`isolated daemon confirmed: pid ${pid}`);
console.log(`  configDir (from daemon): ${info.configDir}`);

const cfg = await rpc("getConfig");
if (cfg.Providers?.length) {
  throw new Error(`refusing to bootstrap: isolated config already has ${cfg.Providers.length} provider(s); ` +
    `expected a clean instance`);
}

cfg.gateway = { ...cfg.gateway, host: "127.0.0.1", port: GATEWAY_PORT, corePort: GATEWAY_CORE_PORT };
cfg.HOST = "127.0.0.1";
cfg.PORT = GATEWAY_PORT;

if (!fs.existsSync(SCRATCH_SETTINGS)) {
  fs.writeFileSync(SCRATCH_SETTINGS, JSON.stringify({}, null, 2) + "\n");
}
cfg.profile.enabled = true;
for (const p of cfg.profile.profiles) {
  if (p.agent !== "claude-code") { p.enabled = false; continue; }
  p.enabled = true;
  p.scope = "global";
  p.settingsFile = SCRATCH_SETTINGS;
  p.surface = "cli";
}
cfg.profile.claudeCode = { ...cfg.profile.claudeCode, settingsFile: SCRATCH_SETTINGS };

assertPayloadIsolated(cfg);
await rpc("saveConfig", [cfg, { applyProfile: false }]);

await assertIsolatedConfig();
tripwire.assert("bootstrap:end");

console.log("bootstrap OK (live-ports check skipped by design -- see file header)");
console.log(`  gateway      -> 127.0.0.1:${GATEWAY_PORT} (core ${GATEWAY_CORE_PORT})`);
console.log(`  settingsFile -> ${SCRATCH_SETTINGS}`);
console.log(`  live settings untouched -> ${LIVE_SETTINGS}`);

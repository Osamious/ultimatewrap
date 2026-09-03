// Teardown. Deliberately does NOT disable the profile subsystem: in the shipped
// CCR build, `profile.enabled = false` (or removing the last enabled global
// claude-code profile) fires a restore path aimed at the LITERAL
// ~/.claude/settings.json. Scrub credentials, then stop and delete the tree.

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { SCRATCH_ROOT, CCR_CONFIG_DIR, resolveWebPort, rpc } from "./config.mjs";
import { makeTripwire, assertPayloadIsolated } from "./guard.mjs";

const tripwire = makeTripwire();
tripwire.assert("teardown:start");

let pid;
try {
  ({ pid } = resolveWebPort());
} catch {
  console.log("no running isolated daemon; proceeding to file cleanup");
}

if (pid) {
  try {
    // Scrub the real key from the live config BEFORE stopping, so it is not left
    // in the DB if deletion is interrupted. Providers[] emptied, profiles kept.
    const cfg = await rpc("getConfig");
    cfg.Providers = [];
    assertPayloadIsolated(cfg); // still isolated, still has its global anchor
    await rpc("saveConfig", [cfg, { applyProfile: false }]);
    console.log("scrubbed Providers[] from isolated config");
  } catch (e) {
    console.log(`scrub skipped: ${String(e.message).slice(0, 200)}`);
  }
  try {
    execFileSync("powershell", ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`]);
    console.log(`stopped isolated daemon pid ${pid}`);
  } catch { /* best effort */ }
}

// Delete the whole tree: SQLite WAL retains prior row contents, so clearing rows
// is not enough to remove a credential — the files must go.
for (const attempt of [1, 2, 3]) {
  try {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    break;
  } catch (e) {
    if (attempt === 3) console.log(`could not fully delete ${SCRATCH_ROOT}: ${e.message}`);
    else await new Promise((r) => setTimeout(r, 700));
  }
}

const gone = !fs.existsSync(CCR_CONFIG_DIR);
console.log(`scratch config dir removed: ${gone}`);
tripwire.assert("teardown:end");
console.log("teardown complete; live state unchanged");

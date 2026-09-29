// Reverses wire-plugin.mjs: removes the plugin entry from config.sqlite
// and deletes the copied files from CCR's config directory.
//
//   node keysync/ccr-plugins/unwire-plugin.mjs --dry
//   node keysync/ccr-plugins/unwire-plugin.mjs --live

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";

const CCR_CONFIG_DIR = path.join(os.homedir(), "AppData", "Roaming", "claude-code-router");
const CCR_DB = path.join(CCR_CONFIG_DIR, "config.sqlite");
const PLUGIN_ID = "uw-schema-sanitizer";
const PLUGIN_FILENAME = "uw-schema-sanitizer.cjs";
const RULES_FILENAME = "uw-schema-rules.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry") || !args.includes("--live");

const destPlugin = path.join(CCR_CONFIG_DIR, PLUGIN_FILENAME);
const destRules = path.join(CCR_CONFIG_DIR, RULES_FILENAME);

if (dry) {
  console.log(`[dry] would remove ${destPlugin} (exists: ${fs.existsSync(destPlugin)})`);
  console.log(`[dry] would remove ${destRules} (exists: ${fs.existsSync(destRules)})`);
  console.log("[dry] would remove plugin entry from config.sqlite");
  process.exit(0);
}

if (fs.existsSync(destPlugin)) fs.rmSync(destPlugin);
if (fs.existsSync(destRules)) fs.rmSync(destRules);
console.log("Removed plugin files from CCR config dir");

if (!fs.existsSync(CCR_DB)) {
  console.error(`CCR config DB not found: ${CCR_DB}`);
  process.exit(1);
}

const db = new DatabaseSync(CCR_DB);
const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get();
if (!row) {
  console.error("no 'default' key in app_config");
  process.exit(1);
}
const cfg = JSON.parse(row.value_json);
if (Array.isArray(cfg.plugins)) {
  const before = cfg.plugins.length;
  cfg.plugins = cfg.plugins.filter((p) => p.id !== PLUGIN_ID);
  if (cfg.plugins.length < before) {
    db.prepare("UPDATE app_config SET value_json = ?, updated_at = ? WHERE key = 'default'")
      .run(JSON.stringify(cfg), new Date().toISOString());
    console.log("Removed plugin entry from config.sqlite");
  } else {
    console.log("Plugin entry not found in config.sqlite (already clean)");
  }
}
db.close();
console.log("Done. Restart CCR gateway for the change to take effect.");
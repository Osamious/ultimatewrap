// Wires the schema-sanitizer CCR gateway plugin into config.sqlite.
//
// CCR's plugin loader (cli.js x$e) requires module paths to be either
// absolute or relative-to-config-dir AND inside it (T$e guard). So this
// script copies the .cjs adapter into CCR's config directory and writes
// the plugin entry into config.sqlite's plugins[] array.
//
//   node keysync/ccr-plugins/wire-plugin.mjs --dry
//   node keysync/ccr-plugins/wire-plugin.mjs --live
//
// Idempotent: running twice with the same config produces no changes.
// Reversible: node keysync/ccr-plugins/unwire-plugin.mjs

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = path.join(__dirname, "schema-sanitizer.cjs");
const RULES_SRC = path.join(__dirname, "schema-rules.mjs");
const CCR_CONFIG_DIR = path.join(os.homedir(), "AppData", "Roaming", "claude-code-router");
const CCR_DB = path.join(CCR_CONFIG_DIR, "config.sqlite");
const PLUGIN_ID = "uw-schema-sanitizer";
const PLUGIN_FILENAME = "uw-schema-sanitizer.cjs";
const RULES_FILENAME = "uw-schema-rules.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry") || !args.includes("--live");

if (!fs.existsSync(PLUGIN_SRC)) {
  console.error(`plugin source not found: ${PLUGIN_SRC}`);
  process.exit(1);
}
if (!fs.existsSync(RULES_SRC)) {
  console.error(`rules source not found: ${RULES_SRC}`);
  process.exit(1);
}
if (!fs.existsSync(CCR_DB)) {
  console.error(`CCR config DB not found: ${CCR_DB}`);
  process.exit(1);
}

const destPlugin = path.join(CCR_CONFIG_DIR, PLUGIN_FILENAME);
const destRules = path.join(CCR_CONFIG_DIR, RULES_FILENAME);

if (dry) {
  console.log(`[dry] would copy ${PLUGIN_SRC} -> ${destPlugin}`);
  console.log(`[dry] would copy ${RULES_SRC} -> ${destRules}`);
  console.log("[dry] would patch config.sqlite plugins[]");
  // Rewrite the require path in the copied .cjs to point at the co-located rules
  const srcContent = fs.readFileSync(PLUGIN_SRC, "utf8");
  const patched = srcContent.replace('./schema-rules.mjs', `./${RULES_FILENAME}`);
  if (srcContent !== patched) console.log("[dry] would rewrite import path in .cjs copy");
  process.exit(0);
}

// Copy files into CCR config dir
let pluginContent = fs.readFileSync(PLUGIN_SRC, "utf8");
pluginContent = pluginContent.replace('./schema-rules.mjs', `./${RULES_FILENAME}`);
fs.writeFileSync(destPlugin, pluginContent, "utf8");
fs.copyFileSync(RULES_SRC, destRules);
console.log(`Copied plugin -> ${destPlugin}`);
console.log(`Copied rules   -> ${destRules}`);

// Patch config.sqlite
const db = new DatabaseSync(CCR_DB);
const row = db.prepare("SELECT value_json FROM app_config WHERE key = 'default'").get();
if (!row) {
  console.error("no 'default' key in app_config");
  process.exit(1);
}
const cfg = JSON.parse(row.value_json);
const plugins = Array.isArray(cfg.plugins) ? cfg.plugins : [];

const existing = plugins.findIndex((p) => p.id === PLUGIN_ID);
const entry = {
  id: PLUGIN_ID,
  module: `./${PLUGIN_FILENAME}`,
  enabled: true,
  permissions: ["trusted-code", "gateway-request-transforms"],
  surfaces: ["gateway"],
};

if (existing >= 0) {
  plugins[existing] = entry;
  console.log("Updated existing plugin entry in config.sqlite");
} else {
  plugins.push(entry);
  console.log("Added plugin entry to config.sqlite");
}

cfg.plugins = plugins;
db.prepare("UPDATE app_config SET value_json = ?, updated_at = ? WHERE key = 'default'")
  .run(JSON.stringify(cfg), new Date().toISOString());
db.close();
console.log("Done. Restart CCR gateway for the plugin to load.");
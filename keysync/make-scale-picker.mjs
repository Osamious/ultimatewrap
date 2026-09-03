// Builds a SCRATCH settings file carrying keysync's FULL built set (87 rows /
// 45 providers) purely so the picker can be looked atic at real scale.
// Writes no live state and touches CCR not at all — the test never sends a
// prompt, so routing does not need to work. The live picker is 18 rows, which
// cannot answer Phase 6 item 1's gate (it asks about 44-provider scale).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadVault, filterRegistry, chooseKeys, loadCatalog, buildProviders, ANTHROPIC_RELAY } from "./keysync.mjs";

const { registry, providers } = loadVault();
const built = buildProviders(chooseKeys(filterRegistry(registry, providers)), providers, loadCatalog(),
  () => "not-used-no-requests-are-sent");

const rows = [
  ...ANTHROPIC_RELAY.models.map((m) => ({ model: `anthropic/${m}`, label: `Anthropic > ${m}`, description: "subscription" })),
  ...built.picker.map(({ contextTokens, ...r }) => r)
];

const live = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8").replace(/^\uFEFF/, ""));
const out = { ...live, modelPicker: { options: rows, replaceBuiltInOptions: true } };
// Strip anything that would make this scratch file try to route.
delete out.apiKeyHelper;
out.env = { ...(out.env || {}) };
for (const k of Object.keys(out.env)) if (/^(ANTHROPIC_|CCR_|CODEXL_|CLAUDE_AGENT_)/.test(k)) delete out.env[k];

const dest = "C:/Users/osami/.uw/harness/scratch/scale-picker-settings.json";
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${dest}`);
console.log(`rows: ${rows.length} across ${new Set(rows.map((r) => r.model.split("/")[0])).size} providers`);

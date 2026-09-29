// Read-only credential consistency check for ONE provider.
//
//   node keysync/credential-check.mjs sambanova
//
// Question it answers: when a provider says "Incorrect API key" for chat while its
// model listing worked, is the key CCR holds the same key the vault holds, and is it
// well formed? It prints BOOLEANS, COUNTS and NON-SECRET IDS ONLY.
//
// SECRET HANDLING (the reason this file is written the way it is):
//   - key values live in local variables of `check()` and are never printed, logged,
//     written, thrown or returned; every output line is built from booleans/numbers;
//   - no hash, prefix or suffix of a key is printed (only `equal: true/false`);
//   - errors are reduced to a status number, never the child's stdout, because the
//     PowerShell child's stdout IS the id-to-key map (same rule as refresh/cli.mjs).
// It writes nothing, changes nothing, and does not restart or reload CCR: it reads the
// vault through the same PowerShell call keysync uses and reads CCR's config through
// the loopback `getConfig` RPC.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rpc } from "../menu/ccr-client.mjs";

const VAULT = path.join(os.homedir(), ".llmkeys");
const STATE = path.join(os.homedir(), ".uw", "state");
const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/** Credential ids for a provider: `bucket.provider.tier`. The registry holds no secrets. */
function credentialIds(provider) {
  let text = "";
  try { text = fs.readFileSync(path.join(VAULT, "registry.json"), "utf8"); } catch { return []; }
  const ids = new Set();
  const re = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  for (const m of text.matchAll(re)) if (m[0].split(".")[1] === provider) ids.add(m[0]);
  return [...ids];
}

/** Masked fragments the PROVIDER echoed back, e.g. `abc123*****xyz9`: head and tail only. */
function fragmentsFor(provider) {
  const out = [];
  const files = ["bench.before-probe-all.json", "bench.first-sweep.json", "bench.before-redact.json"];
  for (const f of files) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(STATE, f), "utf8")); } catch { continue; }
    for (const [k, r] of Object.entries(raw.models ?? {})) {
      if (!k.startsWith(`${provider}/`) || r.s !== "auth") continue;
      for (const text of [r.m, r.p]) {
        const m = /([A-Za-z0-9_-]{3,10})\*{3,}([A-Za-z0-9_-]{2,8})/.exec(String(text ?? ""));
        if (m) out.push([m[1], m[2]]);
      }
    }
  }
  return out;
}

function readVault(ids) {
  const list = ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",");
  const script = `. '${path.join(VAULT, "ApiKeyVault.ps1").replace(/'/g, "''")}'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;
  try {
    const raw = execFileSync("powershell", ["-NoProfile", "-Command", script],
      { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90_000 });
    return JSON.parse(raw.trim() || "{}");
  } catch (e) {
    throw new Error(`the vault read failed (${e?.status ?? e?.code ?? "no status"}); no key was read`);
  }
}

const shape = (k) => ({
  length: k.length,
  leadingOrTrailingSpace: k !== k.trim(),
  hasQuote: /["']/.test(k),
  hasBearerPrefix: /^bearer\s/i.test(k.trim()),
  hasNewline: /[\r\n]/.test(k),
  hasZeroWidthOrBom: /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/.test(k),
});

async function check(provider) {
  const ids = credentialIds(provider);
  console.log(`provider: ${provider}`);
  console.log(`vault credential ids found: ${ids.length}${ids.length ? "  " + ids.join(", ") : ""}`);

  const cfg = await rpc("getConfig", [], { timeoutMs: 20000 });
  const entry = (Array.isArray(cfg?.Providers) ? cfg.Providers : []).find((p) => p?.name === provider);
  if (!entry) { console.log("CCR config: no provider entry with this name"); return; }
  const ccrKey = entry.api_key ?? entry.apiKey ?? "";
  console.log(`CCR entry: api_base_url ${entry.api_base_url ?? "(none)"}  type ${entry.type ?? entry.transformer?.use ?? "(none)"}`);
  console.log(`CCR entry: has a key ${ccrKey ? "yes" : "NO"}  models ${Array.isArray(entry.models) ? entry.models.length : "?"}`);
  if (ccrKey) {
    const s = shape(ccrKey);
    console.log(`CCR key shape: length ${s.length}  leading/trailing space ${s.leadingOrTrailingSpace}  quote char ${s.hasQuote}  Bearer prefix ${s.hasBearerPrefix}  newline ${s.hasNewline}  zero-width/BOM ${s.hasZeroWidthOrBom}`);
  }

  const vault = ids.length ? readVault(ids) : {};
  console.log(`vault keys readable: ${Object.keys(vault).length} of ${ids.length}`);
  for (const id of ids) {
    const v = vault[id];
    if (!v) { console.log(`  ${id}: not readable / empty`); continue; }
    const s = shape(v);
    console.log(`  ${id}: length ${s.length}  space ${s.leadingOrTrailingSpace}  quote ${s.hasQuote}  Bearer ${s.hasBearerPrefix}  newline ${s.hasNewline}  zero-width ${s.hasZeroWidthOrBom}` +
      `  EQUALS CCR KEY: ${ccrKey ? sha(v) === sha(ccrKey) : "n/a"}` +
      `  EQUALS CCR KEY (trimmed): ${ccrKey ? sha(v.trim()) === sha(String(ccrKey).trim()) : "n/a"}`);
  }

  const frags = fragmentsFor(provider);
  console.log(`masked fragments echoed by the provider: ${frags.length}`);
  if (frags.length) {
    const fits = (key) => frags.some(([h, t]) => key.startsWith(h) && key.endsWith(t));
    const all = frags.every(([h, t]) => ccrKey.startsWith(h) && ccrKey.endsWith(t));
    console.log(`  fragments match the CCR key: some ${ccrKey ? fits(ccrKey) : "n/a"}  all ${ccrKey ? all : "n/a"}`);
    for (const id of ids) if (vault[id]) console.log(`  fragments match vault key ${id}: some ${fits(vault[id])}`);
  }
  console.log("(no key, prefix, suffix or hash was printed)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const provider = process.argv[2];
  if (!provider) { console.error("usage: node keysync/credential-check.mjs <provider>"); process.exit(2); }
  check(provider).catch((e) => { console.error(`credential-check: ${String(e?.message ?? e).slice(0, 160)}`); process.exit(1); });
}

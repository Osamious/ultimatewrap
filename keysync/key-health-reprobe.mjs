// Second pass for credentials that failed key-health.mjs: retry each with up to
// three models taken from Maestro's discovery cache (~/.maestro/model_cache.json),
// i.e. models the provider itself listed on 2026-08-30, instead of the recorded
// testModel. Also mirrors Maestro's wire shape (stream:true) on a final attempt,
// in case a gateway only serves streaming. Key values are never printed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const K = await import("file://" + path.join(os.homedir(), ".uw", "keysync", "keysync.mjs").replace(/\\/g, "/"));
const { registry, providers } = K.loadVault();
const creds = K.filterRegistry(registry, providers);

const prev = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".uw", "keysync", "key-health-latest.json"), "utf8"));
const failedIds = new Set(prev.results.filter((r) => r.state !== "ok").map((r) => r.id));
const targets = creds.filter((c) => failedIds.has(c.id));

const cache = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".maestro", "model_cache.json"), "utf8").replace(/^\uFEFF/, ""));
// Maestro cache keys look like "nararouter-free", "alibaba-mxene-paid", "nvidia-tamu-free".
function cachedModels(cred) {
  const want = cred.provider.toLowerCase();
  const hits = Object.entries(cache).filter(([k]) => k.toLowerCase().startsWith(want + "-"));
  const ids = hits.flatMap(([, v]) => (v.models ?? []).map((m) => m.id));
  // Prefer explicitly free-looking ids, then short/cheap-sounding ones, then the rest.
  const score = (id) => (/free/i.test(id) ? 0 : /flash|mini|nano|small|lite|8b|9b|4b|7b/i.test(id) ? 1 : 2);
  return [...new Set(ids)].sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, 3);
}

function loadAllKeys(ids) {
  const list = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
  const script =
    `. 'C:\\Users\\osami\\.llmkeys\\ApiKeyVault.ps1'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;
  return JSON.parse(execFileSync("powershell", ["-NoProfile", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90000 }).trim());
}
const keys = loadAllKeys(targets.map((c) => c.id));

function headersFor(prof, key) {
  const h = { "Content-Type": "application/json" };
  for (const line of String(prof.headersTemplate || "Authorization: Bearer {key}").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace("{key}", key);
  }
  return h;
}

async function attempt(prof, key, model, stream) {
  let base = String(prof.baseUrl || "").replace(/\/+$/, "");
  if (base.includes("generativelanguage.googleapis.com")) base = "https://generativelanguage.googleapis.com/v1beta/openai";
  const tokParam = prof.maxTokensParam || "max_tokens";
  const body = { model, [tokParam]: 8, messages: [{ role: "user", content: "Say OK" }] };
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: headersFor(prof, key),
      body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.status === 200 && (text.trimStart().startsWith("{") || text.includes("data:"))) return { ok: true, ms };
    let why = "";
    try { const j = JSON.parse(text); why = j?.error?.message ?? j?.message ?? j?.error ?? ""; } catch { why = text.slice(0, 80); }
    return { ok: false, status: res.status, why: String(typeof why === "object" ? JSON.stringify(why) : why).replace(/\s+/g, " ").slice(0, 90) };
  } catch (e) {
    return { ok: false, status: 0, why: e.name === "AbortError" ? "timeout 45s" : String(e.cause?.code ?? e.message).slice(0, 60) };
  } finally { clearTimeout(t); }
}

async function reprobe(cred) {
  const prof = providers.get(cred.provider) ?? {};
  const key = keys[cred.id];
  const models = cachedModels(cred);
  const tried = [];
  if (!key) return { id: cred.id, verdict: "skipped", tried, note: "no key value" };
  if (!models.length) return { id: cred.id, verdict: "no-cache", tried, note: "not in Maestro cache" };
  for (const m of models) {
    const r = await attempt(prof, key, m, false);
    tried.push({ model: m, ...r });
    if (r.ok) return { id: cred.id, verdict: "ok", model: m, tried };
  }
  // Last try: Maestro's exact streaming shape on the first candidate.
  const r = await attempt(prof, key, models[0], true);
  tried.push({ model: models[0] + " (stream)", ...r });
  if (r.ok) return { id: cred.id, verdict: "ok-stream-only", model: models[0], tried };
  return { id: cred.id, verdict: "still-failing", tried };
}

const queue = [...targets];
const results = [];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) { const r = await reprobe(queue.shift()); results.push(r); process.stderr.write(`${r.verdict.padEnd(14)} ${r.id}\n`); }
}));
results.sort((a, b) => a.id.localeCompare(b.id));
fs.writeFileSync(path.join(os.homedir(), ".uw", "keysync", "key-health-reprobe.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));

for (const r of results) {
  console.log(`\n${r.verdict.padEnd(14)} ${r.id}${r.model ? "  -> " + r.model : ""}${r.note ? "  (" + r.note + ")" : ""}`);
  for (const t of r.tried) console.log(`    ${t.ok ? "OK  " : String(t.status).padEnd(4)} ${t.model.padEnd(44)} ${t.ok ? t.ms + " ms" : t.why}`);
}

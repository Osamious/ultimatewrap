// Probes EVERY vault credential directly against its provider with one tiny
// chat request (max_tokens 8). Bypasses CCR and the live Claude Code session
// entirely, so it cannot disturb either. Key values are read once from the
// vault and never printed; only ids appear in output.
//
//   node key-health.mjs            # probe all
//   node key-health.mjs --json     # also print the JSON report path only
//
// Result semantics:
//   ok       HTTP 200 and a completion body came back
//   auth     401/403 -> the key itself is rejected
//   broken   any other non-200 (model gone, backend down, 402 no balance...)
//   skipped  no usable endpoint or test model recorded in providers.json

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const K = await import("file://" + path.join(os.homedir(), ".uw", "keysync", "keysync.mjs").replace(/\\/g, "/"));

const { registry, providers } = K.loadVault();
const creds = K.filterRegistry(registry, providers);   // credentials whose provider has a profile

// ---- keys: one PowerShell session for all ids (a shell per key cost ~45 s) ----
function loadAllKeys(ids) {
  const list = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
  const script =
    `. 'C:\\Users\\osami\\.llmkeys\\ApiKeyVault.ps1'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90000 });
  return JSON.parse(raw.trim());
}
const keys = loadAllKeys(creds.map((c) => c.id));

// ---- one request shape per protocol cluster (report 01: 41/47 share one) ----
function headersFor(prof, key) {
  const h = { "Content-Type": "application/json" };
  for (const line of String(prof.headersTemplate || "Authorization: Bearer {key}").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace("{key}", key);
  }
  return h;
}

function requestFor(prof, key) {
  let base = String(prof.baseUrl || "").replace(/\/+$/, "");
  const model = prof.testModel;
  if (!base || !model) return null;
  if (base.includes("generativelanguage.googleapis.com")) {
    // Gemini's OpenAI-compatible surface takes a Bearer key like everyone else.
    base = "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  if (prof.protocol === "anthropic") {
    return {
      url: `${base}/messages`, headers: headersFor(prof, key),
      body: { model, max_tokens: 8, messages: [{ role: "user", content: "Say OK" }] },
    };
  }
  const tokParam = prof.maxTokensParam || "max_tokens";
  return {
    url: `${base}/chat/completions`, headers: headersFor(prof, key),
    body: { model, [tokParam]: 8, messages: [{ role: "user", content: "Say OK" }] },
  };
}

async function probe(cred) {
  const prof = providers.get(cred.provider) ?? {};
  const key = keys[cred.id];
  if (!key) return { id: cred.id, state: "skipped", why: "no value in vault" };
  const req = requestFor(prof, key);
  if (!req) return { id: cred.id, state: "skipped", why: "no baseUrl/testModel in providers.json" };

  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers,
      body: JSON.stringify(req.body), signal: ctrl.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.status === 200) {
      // Guard against a 200 that is really an HTML error page.
      const looksJson = text.trimStart().startsWith("{");
      return { id: cred.id, state: looksJson ? "ok" : "broken", ms,
               why: looksJson ? "" : "200 but non-JSON body", model: prof.testModel };
    }
    let why = "";
    try { const j = JSON.parse(text); why = j?.error?.message ?? j?.message ?? j?.error ?? ""; } catch {}
    why = String(typeof why === "object" ? JSON.stringify(why) : why).replace(/\s+/g, " ").slice(0, 90);
    const state = res.status === 401 || res.status === 403 ? "auth" : "broken";
    return { id: cred.id, state, ms, status: res.status, why, model: prof.testModel };
  } catch (e) {
    return { id: cred.id, state: "broken", ms: Date.now() - started,
             why: e.name === "AbortError" ? "timeout 45s" : String(e.cause?.code ?? e.message).slice(0, 60),
             model: prof.testModel };
  } finally { clearTimeout(t); }
}

const queue = [...creds];
const results = [];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const r = await probe(queue.shift());
    results.push(r);
    process.stderr.write(`${r.state.padEnd(8)} ${r.id}\n`);
  }
}));
results.sort((a, b) => a.id.localeCompare(b.id));

const out = path.join(os.homedir(), ".uw", "keysync", "key-health-latest.json");
fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));

const by = (s) => results.filter((r) => r.state === s);
console.log(`\n${results.length} credentials probed  ok ${by("ok").length}  auth ${by("auth").length}  broken ${by("broken").length}  skipped ${by("skipped").length}`);
for (const s of ["ok", "auth", "broken", "skipped"]) {
  if (!by(s).length) continue;
  console.log(`\n== ${s} ==`);
  for (const r of by(s)) {
    const tail = r.state === "ok" ? `${r.ms} ms` : `${r.status ?? ""} ${r.why}`.trim();
    console.log(`  ${r.id.padEnd(32)} ${String(r.model ?? "").padEnd(34)} ${tail}`);
  }
}
console.log(`\nreport: ${out}`);

// Third pass for the credentials still unexplained: pull the provider's LIVE
// /models listing with the key (a listing call, no tokens), then try up to six
// listed models. Key values never printed.
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const IDS = ["tamu.nvidia.free", "personal.nousresearch.free", "personal_mxene.alibaba.paid", "personal.xai.paid", "personal.seekai.free"];
const K = await import("file://" + path.join(os.homedir(), ".uw", "keysync", "keysync.mjs").replace(/\\/g, "/"));
const { registry, providers } = K.loadVault();
const creds = K.filterRegistry(registry, providers).filter((c) => IDS.includes(c.id));

const list = IDS.map((i) => `'${i}'`).join(",");
const keys = JSON.parse(execFileSync("powershell", ["-NoProfile", "-Command",
  `. 'C:\\Users\\osami\\.llmkeys\\ApiKeyVault.ps1'; $out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; $out | ConvertTo-Json -Compress -Depth 3`],
  { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90000 }).trim());

const hdr = (prof, key) => {
  const h = { "Content-Type": "application/json" };
  for (const line of String(prof.headersTemplate || "Authorization: Bearer {key}").split("\n")) {
    const i = line.indexOf(":"); if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace("{key}", key);
  }
  return h;
};
const fetchT = (url, init, ms = 30000) => {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { ...init, signal: c.signal }).finally(() => clearTimeout(t));
};

for (const cred of creds) {
  const prof = providers.get(cred.provider), key = keys[cred.id];
  const base = String(prof.baseUrl).replace(/\/+$/, "");
  console.log(`\n== ${cred.id}  ${base}`);
  let ids = [];
  try {
    const r = await fetchT(`${base}/models`, { headers: hdr(prof, key) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    const arr = j?.data ?? j?.models ?? (Array.isArray(j) ? j : []);
    ids = arr.map((m) => m.id ?? m.name ?? m.model).filter(Boolean);
    console.log(`  GET /models -> ${r.status}, ${ids.length} models${ids.length ? "" : ": " + t.slice(0, 120).replace(/\s+/g, " ")}`);
  } catch (e) { console.log(`  GET /models -> ${e.name === "AbortError" ? "timeout" : e.message}`); }
  const score = (id) => (/free/i.test(id) ? 0 : /flash|mini|nano|small|lite|-8b|-9b|-4b|-7b|instruct/i.test(id) ? 1 : 2);
  const cands = [...new Set(ids)].sort((a, b) => score(a) - score(b) || a.length - b.length).slice(0, 6);
  if (!cands.length && prof.testModel) cands.push(prof.testModel);
  const tokParam = prof.maxTokensParam || "max_tokens";
  for (const m of cands) {
    try {
      const r = await fetchT(`${base}/chat/completions`, { method: "POST", headers: hdr(prof, key),
        body: JSON.stringify({ model: m, [tokParam]: 8, messages: [{ role: "user", content: "Say OK" }] }) }, 45000);
      const t = await r.text();
      let why = ""; try { const j = JSON.parse(t); why = j?.error?.message ?? j?.message ?? ""; } catch { why = t.slice(0, 80); }
      console.log(`  ${r.status === 200 ? "OK  " : String(r.status).padEnd(4)} ${m.padEnd(46)} ${r.status === 200 ? "" : String(why).replace(/\s+/g, " ").slice(0, 100)}`);
      if (r.status === 200) break;
    } catch (e) { console.log(`  ERR  ${m.padEnd(46)} ${e.name === "AbortError" ? "timeout" : e.message.slice(0, 60)}`); }
  }
}

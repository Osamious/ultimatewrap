// Sends one real request per provider through CCR's gateway and reports which
// actually serve traffic. "Content came back" is checked against a distinctive
// token so a generic error page cannot pass.

import fs from "node:fs";
import { GATEWAY_PORT, SCRATCH_SETTINGS, rpc } from "../harness/config.mjs";

const cfg = await rpc("getConfig");
const key = cfg.APIKEY || cfg.APIKEYS?.[0]?.key;
const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));

// One model per provider: the first picker row for each.
const seen = new Set();
const targets = [];
for (const row of settings.modelPicker.options) {
  const provider = row.model.split("/")[0];
  if (seen.has(provider)) continue;
  seen.add(provider);
  targets.push({ provider, model: row.model });
}
console.log(`testing ${targets.length} providers (one model each) via 127.0.0.1:${GATEWAY_PORT}\n`);

const TOKEN = "UW-OK";
const PROMPT = `Reply with exactly this and nothing else: ${TOKEN}`;

async function probe({ provider, model }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: "user", content: PROMPT }] })
    });
    const body = await res.text();
    const ms = Date.now() - started;
    if (res.status !== 200) {
      let why = "";
      try {
        const j = JSON.parse(body);
        const a = j.error?.attempts?.[0];
        why = a ? `${a.stage}:${a.status ?? ""}` : String(j.error?.message ?? "").slice(0, 60);
      } catch { why = body.slice(0, 60); }
      return { provider, model, ok: false, status: res.status, ms, why };
    }
    const j = JSON.parse(body);
    // Providers differ in response shape; a 200 with no extractable text is a
    // finding, not a pass, so record what actually came back.
    const text = (j.content ?? [])
      .map((c) => (typeof c === "string" ? c : c.text ?? c.thinking ?? ""))
      .join("").trim();
    if (!text) {
      return { provider, model, ok: false, status: 200, ms,
        why: `200 but no text; keys=${Object.keys(j).join(",").slice(0, 60)}` };
    }
    return { provider, model, ok: text.includes(TOKEN), status: 200, ms, text: text.slice(0, 40) };
  } catch (e) {
    return { provider, model, ok: false, status: 0, ms: Date.now() - started, why: e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 50) };
  } finally { clearTimeout(t); }
}

// Bounded concurrency: enough to finish quickly, low enough to avoid
// rate-limiting the shared free tiers into false failures.
const results = [];
const QUEUE = [...targets];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (QUEUE.length) {
    const item = QUEUE.shift();
    const r = await probe(item);
    results.push(r);
    console.log(`${r.ok ? "PASS" : "fail"}  ${r.provider.padEnd(16)} ${String(r.ms + "ms").padStart(7)}  ` +
      `${r.ok ? r.text : `[${r.status}] ${r.why}`}`);
  }
}));

const pass = results.filter((r) => r.ok);
console.log(`\n=== ${pass.length}/${results.length} providers returned a correct live completion ===`);
console.log(`working: ${pass.map((r) => r.provider).sort().join(", ")}`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\nnot serving (key/tier/model issues, not routing bugs unless stage=model_resolution):`);
  for (const f of failed.sort((a, b) => a.provider.localeCompare(b.provider))) {
    console.log(`  ${f.provider.padEnd(16)} [${f.status}] ${f.why}`);
  }
}
fs.writeFileSync("C:\\Users\\osami\\.uw\\keysync\\last-test-results.json", JSON.stringify(results, null, 2));

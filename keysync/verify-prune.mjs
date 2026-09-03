// Probes EVERY picker row and keeps only rows that serve REAL Claude Code
// traffic, then writes verified-rows.json for `run.mjs --verified-only`.
//
// The probe deliberately mirrors what Claude Code actually sends — a system
// prompt AND a tool definition — not a bare one-liner. MEASURED: a bare prompt
// over-reports. `groq/openai/gpt-oss-20b` and `groq/allam-2-7b` both pass a bare
// probe and then fail with "400 All target providers failed" under Claude Code,
// because small/reasoning models choke on tool schemas. A picker row that fails
// when selected is worse than an absent one.
//
//   node verify-prune.mjs                 # isolated harness instance
//   node verify-prune.mjs --target live   # the live CCR install

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const live = process.argv.includes("--target") &&
  process.argv[process.argv.indexOf("--target") + 1] === "live";

let GATEWAY_PORT, SETTINGS, rpc;
if (live) {
  const svc = JSON.parse(fs.readFileSync(
    path.join(process.env.APPDATA, "claude-code-router", "service.json"), "utf8"));
  const url = new URL(svc.url);
  const token = url.searchParams.get("ccr_web_token");
  rpc = async (method, args = []) => {
    const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
      body: JSON.stringify({ method, args })
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method} failed`);
    return j.value;
  };
  const cfg0 = await rpc("getConfig");
  GATEWAY_PORT = cfg0.gateway?.port ?? 3456;
  SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
} else {
  ({ GATEWAY_PORT, SCRATCH_SETTINGS: SETTINGS, rpc } = await import("../harness/config.mjs"));
}

const TOKEN = "UW-OK";
const OUT = "C:\\Users\\osami\\.uw\\keysync\\verified-rows.json";

const cfg = await rpc("getConfig");
const key = cfg.APIKEY || cfg.APIKEYS?.[0]?.key;
const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^\uFEFF/, ""));
const rows = settings.modelPicker.options;
console.log(`probing all ${rows.length} picker rows against ${live ? "LIVE" : "isolated"} gateway ` +
  `127.0.0.1:${GATEWAY_PORT}, with a Claude-Code-shaped payload\n`);

// Approximates Claude Code's own request shape closely enough to expose models
// that cannot handle a system prompt plus tools.
const body = (model) => JSON.stringify({
  model,
  max_tokens: 128,
  system: [{ type: "text", text: "You are a helpful assistant operating inside a CLI coding tool." }],
  tools: [{
    name: "read_file",
    description: "Read a file from disk.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  }],
  messages: [{ role: "user", content: `Reply with exactly this and nothing else: ${TOKEN}` }]
});

async function probe(model, attempt = 1) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: body(model)
    });
    const text = await res.text();
    const ms = Date.now() - started;
    if (res.status === 429 && attempt === 1) {
      await new Promise((r) => setTimeout(r, 8000));
      return probe(model, 2);
    }
    if (res.status !== 200) {
      let why = `${res.status}`;
      try { const j = JSON.parse(text); const a = j.error?.attempts?.[0]; if (a) why = `${a.stage}:${a.status ?? ""}`; } catch {}
      return { model, ok: false, status: res.status, ms, why };
    }
    const j = JSON.parse(text);
    const out = (j.content ?? [])
      .map((c) => (typeof c === "string" ? c : c.text ?? "")).join("").trim();
    if (!out) {
      // Reasoning-only output (thinking blocks, no text) is not usable output.
      return { model, ok: false, status: 200, ms, why: "200 but no text block" };
    }
    return { model, ok: out.includes(TOKEN), status: 200, ms, why: out.includes(TOKEN) ? "" : "wrong content" };
  } catch (e) {
    return { model, ok: false, status: 0, ms: Date.now() - started, why: e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 40) };
  } finally { clearTimeout(t); }
}

const results = [];
const queue = [...rows];
await Promise.all(Array.from({ length: 5 }, async () => {
  while (queue.length) {
    const row = queue.shift();
    const r = await probe(row.model);
    results.push(r);
    console.log(`${r.ok ? "PASS" : "fail"}  ${row.model.padEnd(46)} ${String(r.ms + "ms").padStart(7)} ${r.ok ? "" : r.why}`);
  }
}));

const working = results.filter((r) => r.ok).map((r) => r.model);
fs.writeFileSync(OUT, JSON.stringify({
  generatedAt: new Date().toISOString(), probe: "claude-code-shaped (system + tools)",
  target: live ? "live" : "isolated", working, results
}, null, 2));

const providers = new Set(working.map((m) => m.split("/")[0]));
console.log(`\n=== ${working.length}/${results.length} rows serve Claude-Code-shaped traffic, across ${providers.size} providers ===`);
console.log(`providers: ${[...providers].sort().join(", ")}`);
console.log(`wrote ${OUT}`);

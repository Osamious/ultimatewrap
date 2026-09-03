// Controlled proof: does a Router rule actually reroute a real request?
// Sends ONE minimal request to the gateway (max_tokens 1, free target) and reads
// CCR's own routing headers plus the persisted resolved_model. Does not involve
// the Claude Code session, so nothing here can destabilise the conversation.
import fs from "node:fs"; import path from "node:path";

const svcF = path.join(process.env.APPDATA, "claude-code-router", "service.json");
const u = new URL(JSON.parse(fs.readFileSync(svcF, "utf8")).url);
const rpc = async (m, a = []) => {
  const r = await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`, { method: "POST",
    headers: { "Content-Type": "application/json", "x-ccr-web-auth": u.searchParams.get("ccr_web_token") },
    body: JSON.stringify({ method: m, args: a }) });
  const j = await r.json(); if (!j.ok) throw new Error(JSON.stringify(j.error).slice(0, 200));
  return j.value;
};

const TARGET = "tokenharbor/deepseek-v4-flash:free";
const cfg0 = await rpc("getConfig");
const KEY = cfg0.APIKEY;                       // gateway key, never printed
const base = `http://127.0.0.1:${cfg0.gateway?.port ?? 3456}`;

async function withRule(rule, label) {
  const cfg = await rpc("getConfig");
  cfg.Router = cfg.Router || {};
  cfg.Router.rules = (cfg.Router.rules || []).filter(r => r.id !== "uw-probe");
  if (rule) cfg.Router.rules.push({ id: "uw-probe", enabled: true, ...rule });
  await rpc("saveConfig", [cfg, { applyProfile: false }]);

  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY,
               "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-opus-5", max_tokens: 1,
                           messages: [{ role: "user", content: "hi" }] }),
    signal: AbortSignal.timeout(60000),
  });
  const h = (n) => res.headers.get(n) || "-";
  let served = "-";
  try { served = (await res.json())?.model ?? "-"; } catch {}
  console.log(`\n${label}`);
  console.log(`  http                ${res.status}`);
  console.log(`  x-ccr-routed-model  ${h("x-ccr-routed-model")}`);
  console.log(`  x-ccr-route-reason  ${h("x-ccr-route-reason")}`);
  console.log(`  x-ccr-route-source  ${h("x-ccr-route-source")}`);
  console.log(`  body.model          ${served}`);
}

await withRule(null, "BASELINE — no rule (expect opus)");

await withRule({ type: "condition", name: "probe-cond",
  condition: { left: "request.body.model", operator: "contains", right: "claude-opus-5" },
  target: TARGET }, `A: type=condition, contains claude-opus-5 -> ${TARGET}`);

await withRule({ type: "model-prefix", name: "probe-prefix",
  pattern: "claude-opus-5", target: TARGET }, `B: type=model-prefix -> ${TARGET}`);

// leave clean
await withRule(null, "CLEANUP — rule removed");

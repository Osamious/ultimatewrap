// Adds the Anthropic OAuth relay as a CCR provider in the ISOLATED instance and
// proves real Claude models serve through the gateway. One small request per
// model: this spends real subscription quota.

import { GATEWAY_PORT, rpc } from "./config.mjs";
import { assertIsolatedInstance, assertPayloadIsolated, assertRouterClean, makeTripwire } from "./guard.mjs";

const RELAY = "http://127.0.0.1:4517";
const MODELS = ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"];

const tw = makeTripwire();
tw.assert("anthropic:start");
await assertIsolatedInstance();

const cfg = await rpc("getConfig");
assertRouterClean(cfg);

// Keep whatever keysync already wired; add Anthropic alongside it. The relay
// resolves the subscription token itself, so no real credential is stored here.
const others = (cfg.Providers ?? []).filter((p) => p.name !== "anthropic");
cfg.Providers = [...others, {
  name: "anthropic",
  provider: "anthropic",
  type: "anthropic_messages",
  api_base_url: RELAY,
  api_key: "relay-ignores-this",
  models: MODELS,
  autoFetchModels: false,
  enabled: true
}];
cfg.observability = { ...cfg.observability, requestLogs: true };

assertPayloadIsolated(cfg, { allowProviders: true });
const saved = await rpc("saveConfig", [cfg, { applyProfile: false }]);
tw.assert("anthropic:after-save");
console.log(`providers now: ${saved.Providers.length} (added anthropic with ${MODELS.length} models)`);

const key = saved.APIKEY || saved.APIKEYS?.[0]?.key;
const TOKEN = "CLAUDE-VIA-CCR-OK";

for (const m of MODELS) {
  const started = Date.now();
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: `anthropic/${m}`, max_tokens: 24,
        messages: [{ role: "user", content: `Reply with exactly this and nothing else: ${TOKEN}` }] })
    });
    const body = await res.text();
    const ms = Date.now() - started;
    if (res.status !== 200) {
      let why = body.slice(0, 120);
      try { const j = JSON.parse(body); why = j.error?.attempts?.[0]?.status ?? j.error?.message ?? why; } catch {}
      console.log(`fail  anthropic/${m.padEnd(28)} [${res.status}] ${String(why).slice(0, 90)}`);
      continue;
    }
    const j = JSON.parse(body);
    const text = (j.content ?? []).map((c) => c.text ?? "").join("").trim();
    console.log(`${text.includes(TOKEN) ? "PASS" : "??? "}  anthropic/${m.padEnd(28)} ${String(ms + "ms").padStart(7)}  ${text.slice(0, 40)}`);
  } catch (e) {
    console.log(`fail  anthropic/${m} — ${String(e.message).slice(0, 80)}`);
  }
}

tw.assert("anthropic:end");
console.log("\nlive state unchanged throughout");

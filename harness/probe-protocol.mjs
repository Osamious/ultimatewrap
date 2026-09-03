// Does a non-colliding provider name let the explicit `type` win?
import { GATEWAY_PORT, rpc } from "./config.mjs";
import { assertIsolatedInstance, assertPayloadIsolated, assertRouterClean, makeTripwire } from "./guard.mjs";
const KEY = process.env.SPIKE_KEY; if (!KEY) throw new Error("SPIKE_KEY not set");
const tw = makeTripwire(); tw.assert("probe:start");
await assertIsolatedInstance();
const cfg = await rpc("getConfig");
assertRouterClean(cfg);
const NAME = "uw-google"; // deliberately NOT "google"/"gemini" (CCR built-in aliases)
cfg.Providers = [{
  name: NAME, provider: NAME, type: "openai_chat_completions",
  api_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
  api_key: KEY, models: ["gemini-3.5-flash-lite"], autoFetchModels: false, enabled: true
}];
cfg.observability = { ...cfg.observability, requestLogs: true };
assertPayloadIsolated(cfg, { allowProviders: true });
const saved = await rpc("saveConfig", [cfg, { applyProfile: false }]);
const key = saved.APIKEY || saved.APIKEYS?.[0]?.key;
const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
  method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
  body: JSON.stringify({ model: `${NAME}/gemini-3.5-flash-lite`, max_tokens: 32,
    messages: [{ role: "user", content: "Reply with exactly: PROTOCOL-OK" }] })
});
const body = await res.text();
console.log(`HTTP ${res.status}`);
console.log(body.slice(0, 500));
const m = body.match(/provider_name":"([^"]+)"/);
console.log(`\nprotocol actually used: ${m ? m[1] : "(n/a - success path)"}`);
tw.assert("probe:end");

// Phase 2.5 real-key spike, run entirely inside the isolated instance.
//
// Scope, stated precisely so the result cannot be overclaimed:
//   This exercises  modelPicker-format selector -> CCR gateway -> real provider.
//   It does NOT exercise Claude Code's interactive /model picker. See spike-cli.mjs
//   for the CLI half, and neither script may be reported as "Phase 2.5 passed"
//   on its own.
//
// The API key arrives via env (SPIKE_KEY) and is never logged.

import fs from "node:fs";
import { SCRATCH_SETTINGS, GATEWAY_PORT, rpc } from "./config.mjs";
import {
  assertIsolatedInstance, assertIsolatedConfig, assertPayloadIsolated,
  assertLivePortsClosed, assertRouterClean, assertDesktopSyncLandedInScratch,
  assertGatewayBound, makeTripwire, fail
} from "./guard.mjs";

const KEY = process.env.SPIKE_KEY;
if (!KEY) throw new Error("SPIKE_KEY not set");

const SELECTOR = "google/gemini-3.5-flash-lite";
const tripwire = makeTripwire();

// A thrown assertion after the key is written would otherwise strand it in the
// scratch config with the gateway live. Scrub on every exit path.
let keyWritten = false;
process.on("exit", () => {
  if (keyWritten) {
    console.log("\n[!] Run ended with a provider key in the isolated config. " +
      "Run `node teardown.mjs` now to scrub and delete it.");
  }
});

// ---------------------------------------------------------------- pre-flight
tripwire.assert("spike:start");
assertLivePortsClosed();
await assertIsolatedInstance();
await assertIsolatedConfig();

const before = await rpc("getConfig");
// Phase 2.5's first criterion, asserted BEFORE Providers[] is touched: a
// response served by a fallback or a rewrite rule would otherwise satisfy
// "content came back" while proving nothing about the entry under test.
assertRouterClean(before);
console.log("pre-flight OK: isolated, Router clean (fallback=off, no enabled rules, no availableModels)");

// ------------------------------------------------------------------- mutate
const cfg = structuredClone(before);
// PROTOCOL NOTE (learned by running this): CCR overrode an explicit
// `type: "openai_chat_completions"` and routed via `gemini_generate_content`,
// inferred from the hostname — producing a 404 against the OpenAI-compat base
// URL. `protocolDetectionMode: "manual"` is the documented lever to stop that
// inference. PROTOCOL_MODE selects which shape this run tests.
const PROTOCOL_MODE = process.env.SPIKE_PROTOCOL ?? "manual-openai";
const providerEntry = PROTOCOL_MODE === "native-gemini"
  ? {
      name: "google", provider: "google",
      type: "gemini_generate_content",
      api_base_url: "https://generativelanguage.googleapis.com/v1beta"
    }
  : {
      name: "google", provider: "google",
      type: "openai_chat_completions",
      protocolDetectionMode: "manual",
      api_base_url: "https://generativelanguage.googleapis.com/v1beta/openai"
    };
cfg.Providers = [{
  ...providerEntry,
  api_key: KEY,
  models: ["gemini-3.5-flash-lite"],
  autoFetchModels: false,
  enabled: true
}];
console.log(`protocol mode under test: ${PROTOCOL_MODE} (type=${providerEntry.type})`);
cfg.observability = { ...cfg.observability, requestLogs: true, requestLogBodyCapture: "all" };

const p = cfg.profile.profiles.find((x) => x.id === "default-claude-code");
if (!p) throw new Error("default-claude-code profile missing");
p.enabled = true;
p.env = { ...(p.env || {}), CCR_CLAUDE_CODE_AUTH_MODE: "api-key-helper" };
p.model = SELECTOR;
p.smallFastModel = SELECTOR;
cfg.profile.enabled = true;
cfg.profile.claudeCode = { ...cfg.profile.claudeCode, enabled: true, model: SELECTOR, smallFastModel: SELECTOR };
if (cfg.Router?.builtInRules?.["claude-code"]) cfg.Router.builtInRules["claude-code"].enabled = true;

// Validate what we are about to SEND, not just what comes back.
assertPayloadIsolated(cfg, { allowProviders: true });

keyWritten = true;
const saved = await rpc("saveConfig", [cfg, { applyProfile: true }]);
tripwire.assert("spike:after-saveConfig");

// Re-assert after the mutation: CCR normalizes on save and may rewrite fields.
await assertIsolatedConfig(saved);
assertRouterClean(saved);
// Proves the LOCALAPPDATA redirect held: the desktop sync fires on any
// model-carrying save, so it must have landed in scratch.
assertDesktopSyncLandedInScratch();
console.log("post-save OK: isolation intact, desktop sync landed in scratch");

const gwPid = assertGatewayBound();
console.log(`gateway bound on ${GATEWAY_PORT} (pid ${gwPid})`);

// ------------------------------------------------- settings + modelPicker row
const settings = JSON.parse(fs.readFileSync(SCRATCH_SETTINGS, "utf8"));
if (!settings.apiKeyHelper) fail(`applyProfile did not write apiKeyHelper into ${SCRATCH_SETTINGS}`);
if (!settings.env?.ANTHROPIC_BASE_URL) fail(`applyProfile did not write env.ANTHROPIC_BASE_URL`);
console.log(`applyProfile wrote apiKeyHelper + ANTHROPIC_BASE_URL=${settings.env.ANTHROPIC_BASE_URL}`);

settings.modelPicker = {
  options: [{ model: SELECTOR, label: "Google > Gemini 3.5 Flash Lite", description: "free" }],
  replaceBuiltInOptions: true
};
fs.writeFileSync(SCRATCH_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
tripwire.assert("spike:after-modelPicker");

const configured = new Set(saved.Providers.flatMap((pr) => pr.models.map((m) => `${pr.name}/${m}`)));
for (const opt of settings.modelPicker.options) {
  if (!configured.has(opt.model)) fail(`picker row ${opt.model} not in Providers[].models`);
}
console.log("modelPicker rows validated against Providers[].models");

// --------------------------------------------------- the actual routing test
const gatewayKey = saved.APIKEY || saved.APIKEYS?.[0]?.key;
if (!gatewayKey) fail("no gateway APIKEY to authenticate the test request with");

async function askGateway(model, prompt) {
  const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": gatewayKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: prompt }] })
  });
  return { status: res.status, body: await res.text() };
}

// Positive: the selector under test must return real content.
const PROMPT = "Reply with exactly this and nothing else: SPIKE-ROUTED-OK";
const pos = await askGateway(SELECTOR, PROMPT);
console.log(`\npositive  [${SELECTOR}] -> HTTP ${pos.status}`);
console.log(`  body: ${pos.body.slice(0, 400)}`);

// Negative control: an unroutable selector MUST fail. Without this, a response
// served by a fallback is indistinguishable from a genuinely routed one.
const NEG = "google/definitely-not-a-real-model-uw-spike";
const neg = await askGateway(NEG, PROMPT);
console.log(`\nnegative  [${NEG}] -> HTTP ${neg.status}`);
console.log(`  body: ${neg.body.slice(0, 240)}`);

// ------------------------------------------------------------- attribution
// "Content came back" is not evidence. Attribute via CCR's own request log,
// which records the upstream actually contacted.
let attribution = "(request log unavailable)";
try {
  const logs = await rpc("getRequestLogs", [{ limit: 5 }]);
  const rows = Array.isArray(logs) ? logs : logs?.items ?? logs?.rows ?? [];
  attribution = JSON.stringify(rows.map((r) => ({
    model: r.model ?? r.requestModel, provider: r.providerName ?? r.provider,
    url: r.upstreamUrl ?? r.url, status: r.status ?? r.statusCode
  })), null, 2);
} catch (e) {
  attribution = `(listRequestLogs failed: ${e.message})`;
}
console.log(`\nCCR request log (upstream actually contacted):\n${attribution}`);

// Google's OpenAI-compat layer emits a provider-unique field. Whether it
// survives CCR's openai->anthropic response translation is itself a finding.
const sig = pos.body.includes("thought_signature");
console.log(`\nGoogle-unique thought_signature survived translation: ${sig}`);

tripwire.assert("spike:end");

const routed = pos.status === 200 && pos.body.includes("SPIKE-ROUTED-OK");
const negFailed = neg.status !== 200;
console.log(`\n=== RESULT ===`);
console.log(`positive routed+content : ${routed}`);
console.log(`negative control failed  : ${negFailed}`);
console.log(routed && negFailed
  ? "GATEWAY ROUTING PROVEN (selector -> CCR -> real provider). Interactive /model picker NOT yet exercised."
  : "INCONCLUSIVE — see output above. Do NOT record Phase 2.5 as passed.");

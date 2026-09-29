// Cause clustering for non-ok bench records. Text = `m` (provider's own sentence, <=160 chars) when present,
// else `p` (<=40 chars, legacy records). Rules are ordered, first match wins; pure function of (status, text).
// Many rules match TRUNCATED prefixes on purpose: legacy `p` is cut at 40 characters.
// Rule changes after the independent review are marked REV2 (see REPORT.md sec 6 "Rules changed").
import { redact } from "./lib.mjs";
const R = (re, cause) => ({ re, cause });
const RULES = {
  pay: [
    R(/check-in|airdrop/i, "pay:daily-check-in-required"),
    R(/gift balance|cannot use part|promo|trial (has )?(ended|expired)|expired/i, "pay:gift-or-promo-balance-cannot-cover-model"),
    R(/accounts with a balance|access denied: this model is onl|balance greater/i, "pay:model-needs-minimum-balance"),
    R(/model_requires_purchas|locked on your account|make a purchase/i, "pay:model-locked-until-purchase"),
    R(/no suitable clusters/i, "pay:MISCLASSIFIED-realtime-model(not-a-balance-issue)"),
    R(/not included in yo|is not included|this is a paid model|free plan only|exclusively reserv|anthropic models \(claude\) are on|plan (doesn|does not|doesn't)|include api access|upgrade|premium|paying customers|paid plan|subscribe|subscription|real deposited|access to model denied|available to paying|^routllm: model /i, "pay:plan-or-premium-gated"),
    R(/insufficient|out of credits|add credits|credits|balance|top ?up|recharge|deposit|funds|wallet|billing|payment|quota|credit limit|requires more c/i, "pay:insufficient-balance"),
    R(/upstream request failed/i, "pay:402-opaque-upstream-message"),
    R(/access restricted/i, "pay:deposit-required"),
  ],
  auth: [
    R(/free tier can only|unauthorized client|unsupported client/i, "auth:client-restricted"),
    R(/labs model|admin must enable|is a l\b/i, "auth:model-opt-in-required(Labs)"),
    R(/incorrect api key|invalid or inactive api key|invalid api key|api key/i, "auth:bad-or-inactive-key"),
    R(/does not exist or yo|model access denied|model is offline|model disabled/i, "auth:aggregator-model-access-denied-or-offline"),
    R(/requires you to c|thinkingmachines|age confirm|is cur|currently available on the|not available in your subscription|does not include/i, "auth:plan-or-consent-restricted-model"),
    R(/access denied/i, "auth:access-denied(alibaba-region-or-model)"),
    R(/upstream request failed|upstrea/i, "auth:opaque-upstream-message"),
  ],
  gone: [
    R(/:ba/i, "gone:batch-variant-not-chat"),
    // REV2: explicit non-chat sentences (openai Responses-API, zenmux /v1/chat/completions) were filed as "listed but 404"
    R(/not supported with the responses api|not supported by \/v1\/chat\/completions|is an? (audio|video|image|realtime|transcri)\w* model/i, "gone:non-chat-by-message"),
    // REV2: aihubmix "This is not a chat model and t(his endpoint ...)": gpt-5.5-pro / o3-pro are Responses-API chat models
    R(/not a chat model/i, "gone:not-a-chat-model(may-be-Responses-API-only)"),
    // REV2: google "This model models/x is no longer available to new users" = account state, not gone
    R(/no longer available to new users|this model models\//i, "gone:no-longer-available-to-new-users(account-state)"),
    // REV2: group entitlement (tokenrouter "No available channel ... under group default")
    R(/no available channel/i, "gone:no-channel-for-account-group(entitlement)"),
    // REV2: google's full sentence is "models/x is not found for API version ..., or is not supported for generateContent"
    R(/^google: models\//i, "gone:google-models-prefix(not-found-OR-not-supported-for-generateContent)"),
    R(/end of life|was removed|removed on|was remov|was r$|decommission|deprecated|retired|archived|discontinu|sunset|no longer/i, "gone:decommissioned-or-deprecated"),
    R(/^[a-z0-9_-]+: upstream request failed|^upstream request failed/i, "gone:404-opaque-upstream-message"),
    R(/bad response status|not found the model/i, "gone:404-provider-not-found(no-detail)"),
    R(/couldn't find that|could not find|cannot find|can't find/i, "gone:not-found(generic)"),
    R(/model not exist|does not exist|do not exist|not exist|requested model '|the model `|api deployment for this|requested model does|model '[a-z0-9:.-]+' not$/i, "gone:model-does-not-exist"),
    R(/no endpoints|endpoints out of|no available|selected model is unavail|unavailable/i, "gone:no-endpoints-or-unavailable"),
    R(/publisher model|not found|is not f\b/i, "gone:model-not-found"),
    R(/invalid model|not a valid|unsupported model|requested model is not valid|unknown model|not supported/i, "gone:invalid-or-unsupported-model-name"),
    R(/provider returned error|unknown errors/i, "gone:unspecific-message"),
  ],
  error: [
    R(/^fetch failed$/i, "error:fetch-failed(gateway/local-network)"),
    // REV2: chat models reachable another way / needing an entitlement were filed under "non-chat"
    R(/must be called via|interactions api/i, "error:chat-needs-other-route"),
    R(/does not support streaming/i, "error:chat-no-streaming"),
    R(/not activated/i, "error:chat-entitlement(product-not-activated)"),
    // REV2: moved BEFORE the overload rule: aihubmix "cannot be served at the moment ... try again later" is model-not-served, not overload
    R(/cannot be served|currently closed|model is unavailable|no available providers|no available channel|is not supported b|bad response status/i, "error:model-unavailable-or-not-served"),
    R(/audio model|realtime model|video model|image model|does not support (this endpoint|chat)|requires \/v|native decisions|not chat|not support text input|only allows access to the llm model|only supports real-time|input\.text|`asr`|voice property|input format|url error|content parameter|classification models|text classification/i, "error:non-chat-by-message"),
    R(/does not contain text output/i, "error:no-text-output(non-chat-or-budget)"),
    R(/overload|high demand|at capacity|temporarily|server error|internal ?error|try again|engine abort|disk/i, "error:upstream-overloaded-or-transient-5xx"),
    R(/not valid\.? check the model name|input should be a valid list|unrecognized request argument|bad request for dependent|invalid ?parameter|parameter|invalid/i, "error:model-rejects-request-shape"),
    R(/upstream request failed/i, "error:opaque-upstream-failure"),
  ],
  rate: [
    R(/insufficient credits|top up your balance/i, "rate:MISCLASSIFIED-really-pay(insufficient-credits)"),
    R(/free models are not available to this account|workspace/i, "rate:MISCLASSIFIED-free-access-not-enabled(account-gate)"),
    R(/exceeded your current quota|quota|limit of the free model|reached the limit/i, "rate:quota-exhausted(free-tier-or-daily)"),
    R(/rate limit|too many|concurren|at capacity/i, "rate:rate-limited(momentary)"),
    R(/provider returned error|unknown errors/i, "rate:provider-error(unspecific)"),
  ],
  timeout: [R(/./, "timeout:no-complete-answer-in-35s")],
  empty: [
    R(/hidden reasoning|max_tokens/i, "empty:budget-spent-on-hidden-reasoning"),
    R(/no content/i, "empty:stream-ended-no-content"),
  ],
};
export function cluster(status, text) {
  if (status === "ok") return "ok";
  const t = String(text ?? "");
  for (const { re, cause } of RULES[status] ?? []) if (re.test(t)) return cause;
  if (!t) return `${status}:legacy-no-message`;
  return `${status}:other`;
}
// redacted: masked key fragments and URLs never leave the scripts (see redact() in lib.mjs)
export const textOf = (rec) => redact(rec.m ?? rec.p ?? "");

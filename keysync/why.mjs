// `uw why` — explain the most recent routing failure(s) in plain terms.
//
// WHY THIS EXISTS: when a model cannot serve a request, Claude Code shows only
// `API Error: 400 All target providers failed.` That is a DISPLAY truncation,
// not lost information — Claude Code renders the top-level `error.message` and
// drops the nested `attempts[]`, where the provider's actual words live. CCR
// records the whole exchange, so the cause is always recoverable after the fact.
// This reads it back and says what actually went wrong.
//
//   node why.mjs                    most recent failure, live gateway
//   node why.mjs -n 5               the last 5 failures
//   node why.mjs --all              every failure still retained in the log
//   node why.mjs --target isolated  the test harness instead of live

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const isolated = val("--target", "live") === "isolated";
const limit = has("--all") ? 200 : Number(val("-n", "1"));

const serviceJson = isolated
  ? "C:/Users/osami/.uw/harness/scratch/appdata/claude-code-router/service.json"
  : path.join(process.env.APPDATA, "claude-code-router", "service.json");

if (!fs.existsSync(serviceJson)) {
  console.error(`no CCR service.json at ${serviceJson} — is the gateway running?`);
  process.exit(2);
}
const svc = JSON.parse(fs.readFileSync(serviceJson, "utf8"));
const url = new URL(svc.url);
const token = url.searchParams.get("ccr_web_token");

const rpc = async (method, args = []) => {
  const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
    body: JSON.stringify({ method, args })
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${String(j.error?.message).slice(0, 200)}`);
  return j.value;
};

/**
 * Map (stage, status, provider message) to a cause and an action.
 *
 * `stage` does most of the work and comes free from CCR:
 *   model_resolution  -> the selector never bound to a provider
 *   upstream_response -> the provider was reached and rejected it
 * Statuses are the ones actually observed across 44 providers on this machine.
 * Where a cause cannot be known for certain it is marked "likely" rather than
 * asserted — a confident wrong diagnosis is worse than an honest hedge.
 */
function classify({ stage, status, providerMessage, hadTools }) {
  const msg = String(providerMessage ?? "").toLowerCase();

  if (stage === "model_resolution") {
    return {
      cause: "The model selector did not match any configured provider.",
      action: "The picker row is stale — re-run keysync so Providers[] and modelPicker agree:\n" +
              "  node ~/.uw/keysync/run.mjs --target live --verified-only --i-know"
    };
  }
  if (status === 0 || /timeout|aborted/.test(msg)) {
    return { cause: "The provider did not respond in time.",
             action: "Usually transient. Retry, or pick another provider if it persists." };
  }
  switch (status) {
    case 401: case 403:
      return { cause: "The provider rejected the API key (invalid, expired, or revoked).",
               action: "Check that key in the vault, then re-run keysync. This row will be pruned automatically\n" +
                       "  by the next `verify-cli.mjs` run if the key stays dead." };
    case 402:
      return { cause: "The account has no credit or balance left with this provider.",
               action: "Top up, or use a different provider. Nothing is wrong with the config." };
    case 429:
      return { cause: "Rate limited by the provider.",
               action: "Transient — wait and retry. Free tiers hit this often." };
    case 404:
      return { cause: "The provider does not offer this model to this key/tier.",
               action: "The model id is valid in the catalog but not callable with your key.\n" +
                       "  Re-run verify-cli.mjs to prune it." };
    case 413: {
      // MEASURED and counter-intuitive: groq's free tier returns 413 for a
      // per-minute TOKEN RATE limit, not for an oversized context. Claude Code
      // then renders it as "Request too large (max 32MB) ... images and
      // attachments", which is wrong on every count — there are no images and
      // 32MB is unrelated. Distinguish the two, because the remedies are
      // opposite: wait/upgrade vs. switch model.
      const isRateLimit = /tokens per minute|tpm|rate limit|per minute/i.test(msg);
      if (isRateLimit) {
        return {
          cause: "Not a size problem — the provider's per-minute TOKEN RATE limit was exceeded.\n" +
                 "  Claude Code sends a large system prompt plus ~15 tool schemas (~60k tokens), which\n" +
                 "  blows through small free-tier TPM allowances on the very first request.",
          action: "Wait a minute and retry, or upgrade that provider's tier. The MODEL is likely fine —\n" +
                  "  this row fails on quota, not capability, so do not conclude the model is too small."
        };
      }
      return { cause: "The request genuinely exceeded the provider's size limit.",
               action: "Start a new session or switch to a larger-context model." };
    }
    case 400:
      // The most common and least self-explanatory case. Measured on this
      // machine: small models reject Claude Code's ~15 tool schemas.
      return {
        cause: hadTools
          ? "The provider rejected the request — most likely the model is too small for Claude Code's\n" +
            "  payload (roughly 15 tool schemas plus a long system prompt). Small/reasoning models\n" +
            "  commonly 400 here even though they answer simple prompts fine."
          : "The provider rejected the request as malformed or unsupported.",
        action: "If this row is one you added by hand, it is probably not usable with Claude Code.\n" +
                "  Verified rows are pruned automatically; see the provider message above for specifics."
      };
    default:
      if (status >= 500) {
        return { cause: "The provider is down or erroring on their side.",
                 action: "Transient — retry later. Nothing is wrong with your config." };
      }
      return { cause: "Unrecognized failure — see the provider message above.",
               action: "If this recurs, capture it and treat the provider message as the source of truth." };
  }
}

const logs = await rpc("getRequestLogs", [{ limit: 200 }]);
const rows = Array.isArray(logs) ? logs : logs?.items ?? logs?.rows ?? [];
const failures = rows.filter((r) => r.statusCode && r.statusCode !== 200);

console.log(`gateway: ${isolated ? "ISOLATED harness" : "LIVE"} (${rows.length} requests retained, ` +
  `${failures.length} failed)\n`);

if (!failures.length) {
  console.log("No failures in the retained log — every recent request succeeded.");
  const last = rows[0];
  if (last) {
    console.log(`\nMost recent request: ${last.requestedModel ?? last.model} -> ` +
      `${last.provider} (${last.statusCode}) at ${new Date(last.createdAt).toLocaleString()}`);
  }
  process.exit(0);
}

for (const row of failures.slice(0, limit)) {
  let detail = row;
  try { detail = await rpc("getRequestLogDetail", [{ id: row.id }]); } catch { /* list view is enough */ }

  // The provider's own words live in attempts[].details, inside the response
  // body Claude Code truncates away.
  let attempt = null, providerMessage = null;
  try {
    const body = JSON.parse(detail.responseBody?.text ?? "{}");
    attempt = body?.error?.attempts?.[0] ?? null;
    providerMessage = attempt?.details?.error?.message ?? attempt?.message ?? body?.error?.message ?? null;
  } catch { /* fall through to the row's own fields */ }

  let hadTools = false;
  try { hadTools = /"tools"\s*:\s*\[/.test(detail.requestBody?.text ?? ""); } catch { /* unknown */ }

  const stage = attempt?.stage ?? "(unknown)";
  const status = detail.statusCode ?? row.statusCode;
  const { cause, action } = classify({ stage, status, providerMessage, hadTools });

  console.log("─".repeat(72));
  console.log(`when      ${new Date(detail.createdAt ?? row.createdAt).toLocaleString()}`);
  console.log(`model     ${detail.requestedModel ?? detail.model}`);
  if (detail.resolvedModel && detail.resolvedModel !== detail.requestedModel) {
    console.log(`resolved  ${detail.resolvedModel}`);
  }
  console.log(`provider  ${detail.provider}`);
  console.log(`status    ${status}   stage: ${stage}${hadTools ? "   (request carried tool definitions)" : ""}`);
  console.log(`provider says:\n  ${providerMessage ?? "(no message recorded)"}`);
  console.log(`\nlikely cause:\n  ${cause}`);
  console.log(`\nwhat to do:\n  ${action}`);
}
console.log("─".repeat(72));
if (failures.length > limit) console.log(`(${failures.length - limit} older failure(s) not shown — use -n N or --all)`);

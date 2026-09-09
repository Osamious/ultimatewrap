// One live request per provider through the CCR gateway, to separate three
// things that all look like "it did not work" from the picker:
//   - routing defects   (gateway could not reach a provider at all)
//   - provider state    (402 no balance, 401 bad key, 429 rate limited)
//   - genuine successes
//
// Reads the picker from settings.json and takes the FIRST row of each provider,
// so this measures reachability, not the quality of any particular model.
// Never prints the API key.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CONCURRENCY = 6;
const TIMEOUT_MS = 30000;

const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, ""));
const gateway = settings.env?.ANTHROPIC_BASE_URL;
if (!gateway) throw new Error("no ANTHROPIC_BASE_URL in settings.json");

const helper = settings.apiKeyHelper?.replace(/^"|"$/g, "");
if (!helper) throw new Error("no apiKeyHelper in settings.json");
const key = execFileSync(helper, { encoding: "utf8", shell: true }).trim();
if (!key) throw new Error("apiKeyHelper returned empty");

// First row per provider. Insertion order of the picker is preserved, so this
// is the same row a user scrolling to that provider would hit first.
const firstRow = new Map();
for (const row of settings.modelPicker?.options ?? []) {
  const provider = row.model.split("/")[0];
  if (!firstRow.has(provider)) firstRow.set(provider, row.model);
}

const targets = [...firstRow.entries()];
console.log(`sweeping ${targets.length} providers via ${gateway}, concurrency ${CONCURRENCY}\n`);

async function probe(provider, model) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${gateway}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with exactly: ROUTED" }]
      })
    });
    const ms = Date.now() - started;
    const body = await res.text();
    if (res.ok) return { provider, model, ms, verdict: "OK", detail: "" };

    // Dig the upstream status out of CCR's envelope. The gateway wraps every
    // upstream failure in its own 4xx/5xx, so res.status alone would report
    // the wrapper, not the provider -- and the provider's status is the whole
    // point of this sweep.
    let upstream = res.status;
    let message = body.slice(0, 120);
    let stage = null;
    try {
      const parsed = JSON.parse(body);
      const attempt = parsed?.error?.attempts?.[0];
      if (attempt) {
        upstream = attempt.status ?? upstream;
        stage = attempt.stage ?? null;
        message =
          attempt.details?.error?.message ??
          attempt.details?.message ??
          attempt.message ??
          message;
      } else if (parsed?.error?.message) {
        message = parsed.error.message;
      }
    } catch {
      // Non-JSON body: keep the raw slice already in `message`.
    }

    // The question this sweep answers is "did the gateway reach the provider",
    // so ANY status the provider itself returned counts as reached -- 503 "no
    // available channel", 404 "model does not exist" and 410 "end of life" are
    // upstream answers exactly as much as 402 is. An earlier version of this
    // classifier only enumerated 401/402/403/429 and dumped every other status
    // into ERROR, which understated reachability as 31/45 when it was 43/45.
    //
    // `reached` is therefore keyed off the ATTEMPT existing, not off the status
    // being one this code happens to recognise.
    const reached = stage === "upstream_response";
    const verdict =
      !reached ? "ERROR"
      : upstream === 402 ? "BILLING"
      : upstream === 401 || upstream === 403 ? "AUTH"
      : upstream === 429 ? "RATELIMIT"
      : upstream === 404 || upstream === 410 || upstream === 503 ? "NOMODEL"
      : "UPSTREAM4XX";
    return { provider, model, ms, verdict, detail: `${upstream} ${String(message).slice(0, 90)}` };
  } catch (e) {
    const ms = Date.now() - started;
    const timedOut = e.name === "AbortError";
    return {
      provider,
      model,
      ms,
      verdict: timedOut ? "TIMEOUT" : "UNREACHABLE",
      detail: timedOut ? `no response in ${TIMEOUT_MS}ms` : String(e.message).slice(0, 90)
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < targets.length) {
    const [provider, model] = targets[cursor++];
    const r = await probe(provider, model);
    results.push(r);
    console.log(
      `${r.verdict.padEnd(11)} ${provider.padEnd(16)} ${String(r.ms).padStart(6)}ms  ${r.model}${r.detail ? "  -- " + r.detail : ""}`
    );
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const by = {};
for (const r of results) by[r.verdict] = (by[r.verdict] || 0) + 1;
console.log(`\n=== ${results.length} providers probed ===`);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`${k.padEnd(11)} ${v}`);

const notReached = ["UNREACHABLE", "TIMEOUT", "ERROR"];
const routed = results.filter((r) => !notReached.includes(r.verdict)).length;
console.log(`\nreached their upstream: ${routed}/${results.length}`);
console.log("  counted as reached: OK, AUTH, BILLING, RATELIMIT, NOMODEL, UPSTREAM4XX");
console.log("  counted as NOT reached: ERROR, TIMEOUT, UNREACHABLE");
console.log("Everything except OK is provider/account state, not a gateway routing defect.");

// One caveat the numbers cannot carry on their own: this probe always sends
// `max_tokens`, which some newer OpenAI-family models reject in favour of
// `max_completion_tokens`. Such a row reports UPSTREAM4XX for the probe's
// request shape, not for anything wrong with the route.
const shapeBugs = results.filter((r) => /max_tokens/.test(r.detail));
if (shapeBugs.length) {
  console.log(`\nNOTE: ${shapeBugs.length} row(s) rejected this probe's own request shape ` +
    `(max_tokens vs max_completion_tokens), which is a probe limitation, not a routing failure: ` +
    shapeBugs.map((s) => s.provider).join(", "));
}

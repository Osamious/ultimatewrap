// The benchmark engine (#114): one streaming probe per model, and a scheduler that
// runs ~6,000 of them without hammering the providers, the shared gateway, or the
// account balances.
//
// EVERY DEPENDENCY IS INJECTED (fetch, clock, probe function, result sink) so the
// whole engine is exercised in tests with a fake stream and no network. Nothing
// here reads a key, the vault, or a settings file: the CLI hands in a gateway URL
// and a gateway key, and the engine only ever talks to that one endpoint.
//
// WHAT A PROBE MEANS. One `stream:true` request through the gateway with no tools,
// so a result says "this model answers a bare chat request, this fast". It says
// nothing about tool-schema compatibility (#118 / #119) -- that needs a request
// carrying tools and is deliberately out of scope.

import {
  BENCH_PROMPT, BENCH_MAX_TOKENS, PREVIEW_CHARS, MESSAGE_CHARS, benchKey,
} from "../menu/bench-data.mjs";
import { sanitizeDisplay } from "../menu/sanitize.mjs";
import { redactClip } from "../menu/redact.mjs";
import { CONTRACT as CCR } from "../menu/ccr-client.mjs";

// ------------------------------------------------------------------ SSE

/**
 * Incremental Server-Sent-Events parser. Network chunks split events anywhere --
 * mid-line, mid-`\r\n`, mid-JSON -- so it buffers and only emits complete events.
 * A lone trailing `\r` is held back until the next chunk shows whether it starts
 * a `\r\n`.
 */
export function createSseParser() {
  let buf = "", carry = "";
  const block = (text) => {
    let event = null;
    const data = [];
    for (const line of text.split("\n")) {
      if (!line || line[0] === ":") continue;
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
      if (field === "event") event = value.trim();
      else if (field === "data") data.push(value);
    }
    if (!data.length) return null;
    const raw = data.join("\n");
    if (raw === "[DONE]") return null;
    let json = null;
    try { json = JSON.parse(raw); } catch { /* keep as unparsed */ }
    return { type: event ?? json?.type ?? null, data: json };
  };
  return {
    push(chunk) {
      let s = carry + chunk;
      carry = s.endsWith("\r") ? "\r" : "";
      if (carry) s = s.slice(0, -1);
      buf += s.replace(/\r\n/g, "\n");
      const out = [];
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = block(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (ev) out.push(ev);
      }
      // A malicious or broken upstream that never sends a blank line must not be
      // able to grow this without bound.
      if (buf.length > 1_000_000) buf = "";
      return out;
    },
  };
}

// ------------------------------------------------------- classification

// Whole-string tests, not substring guesses about the provider: these are the
// phrasings measured in this project's own probes (2026-09).
// ("insufficient permissions" is an authorisation failure, not an empty account.)
const PAY = /insufficient[_ ](?:(?:account|user|available|wallet) )?(?:credits?|balance|funds|quota)|(?:credit )?limit is insufficient|quota|balance|credits?\b.*\b(used up|exhaust)|requires? (an? )?(active )?(paid|lite|premium)|purchase|top[ -]?up|recharge|deposit|billing|payment|tier[_ ]required/i;
// aihubmix: "accounts that have not been recharged can only try 10 times" is a
// rate limit that mentions recharging, so the more specific reading wins.
const QUOTA = /only try \d+ times|rate.?limit|too many requests/i;

// The account's PLAN, not its balance, is what stands between us and the model.
// "Model xyz not found in your plan, upgrade" is a `pay` row: the model exists and
// funding or upgrading is the fix, so calling it `gone` would bury a usable model.
const PAY_5XX = /insufficient[_ ](?:(?:account|user|available|wallet) )?(?:credits?|balance|funds|quota)|(?:credit )?limit is insufficient|balance|credits?\b.*\b(used up|exhaust)|requires? (an? )?(active )?(paid|lite|premium)|top[ -]?up|tier[_ ]required/i;
const PLAN_STRICT =/\b(in|on|under|with|for) your (current |free )?(plan|subscription|tier)\b/i;
const PLAN = /\b(in|on|under|with|for) your (current |free )?(plan|subscription|tier)\b|\bupgrade (your|to|plan)|subscription (is )?(required|needed)/i;

// A provider that is asked for a model it does not have often answers 400, 422 or
// even 500 with a sentence, not a 404. These say the MODEL is missing or retired.
// Each one is anchored on the model itself; "model" appearing anywhere in a message
// is not evidence (a rate limit, an overload and a bad parameter all mention it).
// "Near" = the same sentence: up to 120 characters with no ". " between (a period
// INSIDE a model name such as gpt-5.5-pro does not end the sentence).
const NEAR = String.raw`(?:(?!\.\s)[\s\S]){0,120}?`;
// "model parameter", "model field" ...: a sentence about a REQUEST parameter, not about the model being absent.
const NOT_PARAM = String.raw`(?!\s+(?:param|parameter|argument|option|field|setting|value|config|configuration|type|format|version|size|architecture|output|input|response|request|content|schema|mode|behaviou?r|capabilit(?:y|ies))s?\b)`;

// A 5xx whose sentence carries one of these is describing a fault of the provider's own machinery, however
// much it also says about a model or a balance: "model 'x' was removed from the pool, retrying", "Model x not found
// in KV cache; reloading", "balance check service unavailable", "insufficient GPU capacity". At a 5xx such a
// sentence is never `gone` and never `pay`; it stays a transient `error`.
const TRANSIENT_MARK = /\b(?:retry|retrying|retries|try again|temporar\w*|worker|pool|cache|shard|replica|queue|reload\w*|capacity|rotation|node|region|unavailable)\b/i;

// TWO TIERS, because the same words mean different things at different statuses. A 5xx is usually
// a transient fault of the provider's own infrastructure ("model not found in KV cache", "model was
// retired from pool, retrying", "Failed to load model: file not found on worker"), so there only an
// anchor that names THE MODEL as missing counts. A 4xx that says the model is absent, retired or
// not valid is a fact about the row, so the looser wordings count there too. Either way the
// sentence must be about the model, never about a parameter ("invalid model parameter 'x'").
//
// STRONG: any status.
const GONE_STRONG = new RegExp([
  String.raw`\bno such model\b`,
  // The provider's own grammar for "absent": "Model not exist." (alibaba), "X is not a valid model ID"
  // (openrouter), "models/x is not found" (google's resource path).
  String.raw`\bmodel not exist\b`,
  String.raw`\bis not a valid model (?:id|name)\b`,
  String.raw`\bmodels/[\w.:@-]+ is not found\b`,
  // The model NAMED (an id-like token: it has a digit, dot or hyphen), so "unsupported model type" and
  // "invalid model parameter" are not this: "Unsupported model `qwen-vl-max`", "Invalid model: mistral-x".
  String.raw`\b(?:unsupported|invalid) model[:\s]+[\x60'"]?(?=[\w./:@\[\]-]*[\d.\-])[\w./:@\[\]-]{3,}`,
  // A QUOTED name, then a past-tense fact: "model 'command-r' was removed on September 15", "The model
  // `gpt-4o-search-preview` has been deprecated". (Unquoted "Model temporarily unavailable, was removed
  // from rotation" is not this.)
  String.raw`\bmodels?\s+[\x60'"][\w./:@\[\]-]+[\x60'"]\s+(?:has been|was|is)\s+(?:deprecated|removed|retired|discontinued|decommissioned)\b`,
  // Past tense, no retry: an explicit fact, unlike "was retired from pool, retrying".
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\bhas been (?:decommissioned|discontinued)\b`,
  String.raw`\bunknown model\b${NOT_PARAM}`,
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\b(does not|doesn't|doesnt|do not|don't) exist\b`,
  // "Model glm-4.6 not found" / "The model `x` was not found": the model NAMED, then not found.
  // ("model not found in KV cache" has no name between the two and is not this.)
  String.raw`\bmodel\s+[\x60'"]?[\w./:@\[\]-]+[\x60'"]?\s+(?:was |is )?not found\b`,
].join("|"), "i");
// The provider's own machine codes: exact, never a phrase.
const GONE_CODE = /\bmodel_(?:not_found|not_exist|decommissioned)\b/;
// LOOSE: only where the status is not a 5xx.
const GONE_LOOSE = new RegExp([
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\bnot found\b`,
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\bno longer (available|supported|exists?|served|offered)\b`,
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\b(is|are|was|has been|have been) (now )?(deprecated|retired|discontinued|removed|sunset|decommissioned)\b`,
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\bdecommission`,
  String.raw`\b(deprecated|retired|discontinued) models?\b`,
  String.raw`\b(not a valid|invalid) model\b${NOT_PARAM}`, String.raw`\bmodel( id| name)? (is )?(not valid|invalid)\b`,
  String.raw`\bmodels?\b${NOT_PARAM}${NEAR}\bis not supported\b(?!\s+(for|with|in|on|when|by)\b)`,
  String.raw`\b(could not|couldn't|cannot|can't|unable to) find (the |that |a )?(requested )?models?\b${NOT_PARAM}`,
].join("|"), "i");

/** Does this message/body say the MODEL is gone, at this HTTP status? (5xx: strong anchors only.) */
export function saysGone(status, message, raw = "") {
  if (GONE_CODE.test(String(raw).toLowerCase())) return true;               // the provider's own machine code: exact, never vetoed
  if (status >= 500 && TRANSIENT_MARK.test(message)) return false;
  if (GONE_STRONG.test(message)) return true;
  return !(status >= 500) && GONE_LOOSE.test(message);
}

/** The provider's own sentence: `error.message`, `message`, or a bare `error` string, else the text as-is. */
export function extractMessage(body) {
  let m = String(body ?? "");
  try {
    const j = JSON.parse(m);
    const cand = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : null);
    if (cand !== null && cand !== undefined) m = typeof cand === "string" ? cand : JSON.stringify(cand);
  } catch { /* not JSON: use as-is */ }
  return String(m).replace(/\s+/g, " ").trim();
}

// The ACCOUNT, not the model, is what is refused: the model exists and works for others.
// The vocabulary is closed, so this reads as `auth` ("the key or account, not the model":
// the same reading the study gives mistral's Labs opt-in and alibaba's per-model access
// denials). `gone` would say the model no longer exists, which is false, and `pay` would
// say money fixes it, which it does not.
const ACCOUNT_STATE = /insufficient (permissions?|privileges?|scopes?|access)|no longer available to new (users|customers)|not available (to|for) new (users|customers)|only available to existing (users|customers)|(free )?models are not available to this account/i;

// An empty balance said in words. Checked BEFORE the rate/quota test because a 429 body can
// carry both ("type":"rate_limit_error" around "Insufficient credits. Please top up your
// balance and try again in a few minutes"), and the money reading is the true one. Narrow on
// purpose: "insufficient permissions" and aihubmix's "not been recharged can only try 10
// times" (a rate limit) do not match.
const EMPTY_BALANCE = /insufficient (?:(?:account|user|available|wallet) )?(credits?|balance|funds)|no credits|out of credits|top[ -]?up your (balance|account)/i;

/**
 * HTTP status + body text -> one of the closed statuses.
 *
 * Precedence, most specific first:
 *   1. an empty balance said in words is `pay` (unless the status is 401)
 *   2. a rate/quota phrase is `rate` whatever else it says
 *   3. 402 pay
 *   4. an account-state sentence ("no longer available to new users", "free models are not
 *      available to this account yet") is `auth`, at any status that is not already a class
 *   5. 429 rate-or-pay, 401 auth, 403 pay-or-auth, 404 gone
 *   6. a payment or plan phrase is `pay`
 *   7. a clear "this model does not exist / was removed" phrase is `gone` WHATEVER the
 *      status (providers answer 400, 422 and 500 for it)
 *   8. anything else is a transient `error`
 * "temporarily unavailable", "overloaded", "cannot be served at the moment", "upstream
 * request failed" and "the model rejected this request" say nothing about the model being
 * absent and stay `error` (at a status that names no class: the gateway's opaque
 * "Upstream request failed." is mapped by the HTTP status alone, 402 pay / 404 gone /
 * 401 auth, and the sentence itself is kept in `m`).
 */
export function classifyHttp(status, body = "") {
  const text = String(body);
  const msg = extractMessage(text);
  if (status !== 401 && EMPTY_BALANCE.test(msg)) return "pay";
  if (QUOTA.test(text)) return "rate";
  if (status === 402) return "pay";
  if (status !== 401 && status !== 403 && ACCOUNT_STATE.test(msg)) return "auth";
  // A 429 is a rate limit unless the body says the ACCOUNT is empty: "quota" on a
  // 429 usually means a per-minute or per-day cap, which is the `rate` reading.
  if (status === 429) return /insufficient|no credits|out of credits|balance/i.test(text) ? "pay" : "rate";
  if (status === 401) return "auth";
  if (status === 403) return PAY.test(text) ? "pay" : "auth";
  // The plan named outright beats the 404 (or the 5xx) it came with ("Model x not found in your plan,
  // upgrade"). Only the explicit "in your plan" form: a 404 that says "deprecated, upgrade to gpt-5" is still gone.
  if (PLAN_STRICT.test(text)) return "pay";
  if (status === 404) return "gone";
  // A 5xx that merely mentions billing, quota, payment, purchase, deposit or recharge is the provider's own
  // fault, not the account's ("billing service unavailable"): there only the words about an EMPTY account count.
  if (status >= 500 ? (PAY_5XX.test(text) && !TRANSIENT_MARK.test(msg)) : (PAY.test(text) || PLAN.test(text))) return "pay";
  if (saysGone(status, msg, text)) return "gone";
  return "error";
}

// Both are provider text, so both are REDACTED before they can be stored (see menu/redact.mjs);
// classification always reads the raw body, never these.
const snippet = (text) => redactClip(extractMessage(text), PREVIEW_CHARS);
// The whole sentence for the post-sweep study (`m`): sanitized here on write, and again on load.
const message = (text) => redactClip(String(text ?? "").replace(/\s+/g, " ").trim(), MESSAGE_CHARS);

// The MODEL's text (an ok preview): credentials and ids are masked, but links stay (a URL in an answer is content).
const clean = (s) => redactClip(String(s).replace(/\s+/g, " ").trim(), PREVIEW_CHARS, { links: false });

// ---------------------------------------------------------------- probe

const RETRY_AFTER_MAX_MS = 3_600_000;

/**
 * A `Retry-After` header as milliseconds, or null when it says nothing usable. Two forms are
 * legal: delta-seconds ("7", "1.5") and an HTTP date. A MISSING header is null: `Number(null)`
 * is 0, which used to read as "retry in 0 ms" and made a provider that answered 429 with no
 * header be hit again at once (18 dispatches in 3 ms). "0", an empty value, a negative one, garbage
 * and a date already past are null too, so the engine's exponential backoff applies; an absurd
 * value is clamped to an hour (the engine's own backoffMaxMs then bounds the actual wait).
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (!v) return null;
  let ms = null;
  if (/^\d+(\.\d+)?$/.test(v)) ms = Number(v) * 1000;
  else {
    const at = Date.parse(v);
    if (Number.isFinite(at)) ms = at - nowMs;
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(RETRY_AFTER_MAX_MS, Math.round(ms));
}

const TEXT_KEEP = 600;          // how much of the streamed text is kept, for the notice check (the preview clips to PREVIEW_CHARS)
const CHARS_PER_TOKEN = 4;      // the cut's token estimate for ordinary text when the provider's own count has not arrived
const WIDE = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/g;   // kana, CJK ideographs, Hangul: ~1 token each
const countWide = (s) => (s.match(WIDE) ?? []).length;

// A greeting is what the prompt asks for. Anything that starts like one is an answer, whatever it goes on to say.
const GREETING = /^\W*(?:hello|hi|hey|hiya|greetings|good (?:morning|day|afternoon|evening)|howdy|yo|salut|hola|bonjour|ciao|namaste|welcome|salaam|hallo|ola|sup)\b/i;
// ...and so is anything that says "hello" anywhere: a notice does not greet.
const HELLO_ANYWHERE = /\bhello\b/i;
// The shapes of "this is an error notice, not an answer": all ANCHORED at the start of the text, and none of them can
// open a reply to "Say hello in 5 words." (measured: 106 pollinations rows whose whole answer was "The account behind
// this API key doesn't ...", with 0 output tokens). English only: a wording is added when a real provider notice
// plausibly starts that way, never speculatively.
const NOTICE_AUTH = new RegExp([
  String.raw`^(?:the |your |this )?(?:account|api[ _-]?key|key|token|subscription|credentials?)\b[^.\n]{0,80}?\b(?:doesn't|does not|isn't|is not|has no|have no|don't have|do not have|not (?:valid|authori[sz]ed|allowed|active|enabled|activated|found)|invalid|expired|revoked|suspended|disabled|blocked|lacks?)\b`,
  String.raw`^(?:invalid|incorrect|missing|expired|revoked|bad) (?:api[ _-]?)?(?:key|token|credentials?)\b`,
  String.raw`^(?:an? )?api[ _-]?key (?:is )?(?:required|missing|needed)\b`,
  String.raw`^(?:unauthori[sz]ed|forbidden|authentication (?:failed|required|error)|access (?:denied|forbidden|is forbidden)|permission denied)\b`,
  String.raw`^(?:you (?:are|'re) )?not authori[sz]ed\b`,
  String.raw`^(?:login|log[ -]?in|sign[ -]?in) (?:is )?required\b`,
  String.raw`^sign[ -]?in to continue\b`,
  String.raw`^(?:please |you (?:must|need to) )(?:log ?in|sign ?in|sign ?up|register|authenticate)\b`,
].join("|"), "i");
const NOTICE_PAY = new RegExp([
  String.raw`^(?:error:?\s*)?(?:you (?:have|'ve) (?:run out of|exceeded|no)|insufficient|out of|no (?:more )?)[^.\n]{0,40}\b(?:credits?|balance|funds|quota)\b`,
  String.raw`^(?:please |you (?:must|need to) )?(?:top ?up|subscribe|upgrade|purchase|add (?:credits|funds))\b`,
  String.raw`^(?:quota|usage limit|(?:daily|weekly|monthly) (?:quota|limit|usage))\b[^.\n]{0,30}\b(?:exceeded|reached|hit)\b`,
  String.raw`^(?:your )?free (?:tier|trial|plan|quota)\b[^.\n]{0,30}\b(?:limit|has ended|has expired|ended|expired|exhausted|used up|reached|exceeded)\b`,
  String.raw`^(?:credits?|balance|quota) (?:(?:are|is|has been|have been) )?(?:exhausted|depleted|used up)\b`,
  String.raw`^not enough (?:credits?|balance|funds)\b`,
  String.raw`^payment required\b`,
].join("|"), "i");
const NOTICE_RATE = /^(?:rate[ -]?limit(?:ed)?|too many requests)\b/i;
const NOTICE_GONE = /^(?:the )?model\b[^.\n]{0,60}?\b(?:not found|does not exist|doesn't exist|is not available)\b/i;
const NOTICE_ERROR = new RegExp(
  String.raw`^(?:error\b|an error (?:has )?occurred|something went wrong|internal server error|service (?:is )?(?:temporarily )?unavailable|bad gateway|gateway time-?out|sorry,? (?:an )?error (?:has )?occurred|the (?:server|service|model) (?:is|was) (?:unavailable|overloaded|down)|request failed|failed to\b)`, "i");

/**
 * Does the WHOLE streamed text read as an error or account notice rather than an answer? Returns the status it
 * should get, or null: `auth` for account and key wording, `pay` for credit, balance, quota and free-tier wording,
 * `rate` for a rate limit, `gone` for "Model not found", `error` for a plain error notice. Deliberately
 * conservative: anchored at the start, short text only, a greeting-led text is never a notice, and neither is
 * any text that says "hello".
 */
export function looksLikeNotice(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > TEXT_KEEP || GREETING.test(t) || HELLO_ANYWHERE.test(t)) return null;
  if (NOTICE_AUTH.test(t)) return "auth";
  if (NOTICE_PAY.test(t)) return "pay";
  if (NOTICE_RATE.test(t)) return "rate";
  if (NOTICE_GONE.test(t)) return "gone";
  if (NOTICE_ERROR.test(t)) return "error";
  return null;
}

/**

 * One streaming request; resolves to a result object and NEVER rejects.
 *
 * Timing definitions (documented in the picker's legend):
 *   ttft   ms from just before `fetch` to the arrival of the first
 *          `content_block_delta` (text OR thinking). Measured through the gateway,
 *          where response headers already wait for the upstream's first token.
 *   total  ms from `fetch` to `message_stop`, or to the stream's end.
 *   tps    provider-reported `output_tokens` / seconds between first and last
 *          delta. Null unless `output_tokens >= 8` and the window is >= 50 ms:
 *          a two-token answer over a 5 ms window is noise, and a token count is
 *          NEVER estimated.
 */
export async function probeOne({
  fetchImpl = fetch, url, key, model, prompt = BENCH_PROMPT, maxTokens = BENCH_MAX_TOKENS,
  timeoutMs = 240000, signal = null, now = () => performance.now(), cancelMs = 1000,
  cutAt = STREAM_CUT_FACTOR * maxTokens,
}) {
  const t0 = now();
  const ms = (t) => Math.max(0, Math.round(t - t0));
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }

  let reader = null;
  let tFirst = null, tLast = null, out = null, text = "", think = "", stopReason = null;
  let chars = 0, wide = 0, cut = false;
  // Tokens seen so far, ESTIMATED: a CJK, kana or Hangul character is about one token, everything else about a quarter
  // of one (chars / 4 alone under-counts a 1,600-character CJK stream as ~400 tokens and understates `r` about 4x).
  const estTokens = () => wide + Math.ceil((chars - wide) / CHARS_PER_TOKEN);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      // The client tag lets the gateway's usage log tell UW's own probes from real use.
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
                 [CCR.clientHeader]: CCR.probeClient },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true,
                             messages: [{ role: "user", content: prompt }] }),
      signal: ac.signal,
    });

    if (!res.ok) {
      let body = "";
      try { body = (await res.text()).slice(0, 2048); } catch { /* unreadable body */ }
      const ra = parseRetryAfter(res.headers?.get?.("retry-after"));
      return { s: classifyHttp(res.status, body), http: res.status, d: ms(now()),
               p: snippet(body), m: message(extractMessage(body) || `HTTP ${res.status}`), ...(ra !== null ? { ra } : {}) };
    }

    reader = res.body?.getReader?.() ?? null;
    if (!reader) return { s: "error", d: ms(now()), p: "no response body", m: "HTTP 200 with no response body" };

    const dec = new TextDecoder();
    const parser = createSseParser();
    let tEnd = null, streamError = null, stopped = false;
    scan: for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const tNow = now();
      const chunk = typeof value === "string" ? value : dec.decode(value, { stream: true });
      for (const ev of parser.push(chunk)) {
        if (ev.type === "content_block_delta") {
          const d = ev.data?.delta;
          if (tFirst === null) tFirst = tNow;
          tLast = tNow;
          if (d?.type === "text_delta") { const piece = d.text ?? ""; chars += piece.length; wide += countWide(piece); if (text.length < TEXT_KEEP) text += piece; }
          else if (d?.type === "thinking_delta") { const piece = d.thinking ?? ""; chars += piece.length; wide += countWide(piece); if (think.length < PREVIEW_CHARS * 3) think += piece; }
          // A model that ignores max_tokens can stream thousands of tokens over minutes. The probe needs only the
          // first token, a preview and a rate, so once the stream is past the allowance it is CUT: the request is
          // aborted and the row recorded as the ok it is, marked `x`. Never before the first content delta.
          if (cutAt > 0 && Math.max(out ?? 0, estTokens()) > cutAt) { cut = true; tEnd = tNow; break scan; }
        } else if (ev.type === "message_delta") {
          const n = ev.data?.usage?.output_tokens;
          if (Number.isFinite(n)) out = n;
          const sr = ev.data?.delta?.stop_reason;
          if (typeof sr === "string") stopReason = sr;
        } else if (ev.type === "error") {
          streamError = ev.data?.error?.message ?? "stream error";
        } else if (ev.type === "message_stop") {
          tEnd = tNow; stopped = true;
        }
      }
      if (stopped) break;
    }
    tEnd ??= now();

    if (tFirst === null) {
      if (streamError) return { s: "error", d: ms(tEnd), p: snippet(streamError), m: message(streamError), ...(out !== null ? { o: out } : {}) };
      // MEASURED (inceptionlabs mercury-2.5, 2026-09-29): the model spent its whole
      // 64-token budget on reasoning it does not stream. The gateway sends
      // message_start, one message_delta reporting output_tokens with
      // stop_reason=max_tokens, and message_stop -- no content event at all. That is
      // a true "nothing to show" for this budget, but the reason is worth recording:
      // it tells the reader to raise --max-tokens rather than distrust the provider.
      const hidden = stopReason === "max_tokens" && (out ?? 0) > 0;
      return { s: "empty", d: ms(tEnd), ...(out !== null ? { o: out } : {}),
               ...(hidden ? { p: "budget spent on hidden reasoning" } : {}),
               m: hidden ? `budget spent on hidden reasoning (stop_reason max_tokens, ${out} tokens)`
                         : `stream ended with no content${stopReason ? ` (stop_reason ${stopReason})` : ""}` };
    }
    const window = tLast - tFirst;
    const tps = out !== null && out >= 8 && window >= 50
      ? Math.round((out / (window / 1000)) * 10) / 10 : null;
    const answer = clean(text);
    if (cut) {
      // `o` here is the larger of the provider's own count (if it arrived) and chars / 4, never below the allowance:
      // an ESTIMATE, which is why `x` marks the record. `r` is that count over the window seen before the cut.
      const oCut = Math.max(out ?? 0, estTokens(), cutAt);
      const rCut = tLast - tFirst >= 50 ? Math.round((oCut / ((tLast - tFirst) / 1000)) * 10) / 10 : null;
      return { s: "ok", t: ms(tFirst), d: ms(tEnd), r: rCut, o: oCut, p: answer || clean(think), k: answer ? 0 : 1, x: 1 };
    }
    // A 200 whose whole (short) text is an error or account notice is not an answer to "say hello": it is the
    // provider's refusal delivered as content. Anything greeting-led is left alone.
    const notice = chars <= TEXT_KEEP ? looksLikeNotice(text) : null;
    if (notice) {
      const sentence = text.replace(/\s+/g, " ").trim();
      return { s: notice, http: 200, d: ms(tEnd), p: snippet(sentence), m: message(`HTTP 200 stream carried a notice, not an answer: ${sentence}`) };
    }
    // An `error` event AFTER content arrived: the answer began (its TTFT and preview are real), so the row stays `ok`, but the
    // failure is not swallowed: it is recorded in `m` ("stream error after first token: ...").
    return { s: "ok", t: ms(tFirst), d: ms(tEnd), r: tps, o: out,
             p: answer || clean(think), k: answer ? 0 : 1,
             ...(streamError ? { m: message(`stream error after first token: ${streamError}`) } : {}) };
  } catch (e) {
    if (timedOut) {
      // A timeout after the first token still tells us the first-token time.
      return { s: "timeout", d: ms(now()), ...(tFirst !== null ? { t: ms(tFirst) } : {}),
               m: `no complete answer within ${timeoutMs} ms${tFirst !== null ? `; first token at ${ms(tFirst)} ms` : ""}` };
    }
    if (signal?.aborted) return { aborted: true };
    return { s: "error", d: ms(now()), p: snippet(e?.message ?? e), m: message(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
    if (cut) ac.abort();            // stop the network side of a cut stream too
    // A stalled stream can leave `cancel()` pending forever, which would hold this
    // provider's slot for the rest of the run. Give it a moment, then let go.
    if (reader) {
      let t;
      try {
        await Promise.race([Promise.resolve(reader.cancel()), new Promise((r) => { t = setTimeout(r, cancelMs); })]);
      } catch { /* already closed */ }
      clearTimeout(t);
    }
  }
}

// -------------------------------------------------------------- targets

const IN_TOKENS = 15;   // "Say hello in 5 words." plus the request envelope
// What a probe actually produces: a non-reasoning model answers in 10-20 tokens,
// a reasoning model runs to the max_tokens ceiling (measured: 64 of 64). Spend is
// accounted at a typical length; the per-row CEILING uses the full max_tokens.
const EXPECT_OUT_TOKENS = 48;
// UNPRICED rows (the catalogue has no price for them) are charged a documented conservative price, the
// same for every unpriced row, applied to the tokens the probe SAW: $0.60 per million input tokens and $3.00
// per million output tokens, roughly a mid-priced current model. The stream cut bounds those tokens, so an
// unpriced 7,559-token answer costs about $0.02 instead of a linear multiple of a flat guess. (The plan prints
// these two figures.)
export const UNPRICED_PER_M = Object.freeze({ in: 0.6, out: 3 });
/** A hard cap on the tokens one probe may stream is `STREAM_CUT_FACTOR x max_tokens` (see `probeOne`). */
export const STREAM_CUT_FACTOR = 4;

/** Priced at zero, or badged free. `FREE?` (zero price, unconfirmed grant) counts: probing it costs nothing either way. */
export const isFree = (m) => m.badge === "FREE" || m.badge === "FREE?" || (m.pin === 0 && m.pout === 0);

const priced = (m) => Number.isFinite(m.pin) && Number.isFinite(m.pout);
const unpricedCost = (outTokens) => (IN_TOKENS * UNPRICED_PER_M.in + outTokens * UNPRICED_PER_M.out) / 1e6;

/**
 * Expected USD for one probe, for the running spend total. Prices are per million
 * tokens (the picker's own `$in` / `$out` columns).
 */
export function estimateCost(m) {
  if (isFree(m)) return 0;
  return priced(m) ? (IN_TOKENS * m.pin + EXPECT_OUT_TOKENS * m.pout) / 1e6 : unpricedCost(EXPECT_OUT_TOKENS);
}

/**
 * Worst-case USD for one probe: `tokens` billed (the ceiling on what one probe can stream: `max_tokens`, or the
 * stream-cut allowance when providers ignore it). This is what `--max-row-cost` is checked against.
 */
export function worstCost(m, tokens = BENCH_MAX_TOKENS) {
  if (isFree(m)) return 0;
  return priced(m) ? (IN_TOKENS * m.pin + tokens * m.pout) / 1e6 : unpricedCost(tokens);
}

/**
 * What one finished probe is charged against the spend cap (USD). This is an
 * ESTIMATE of the bill, built from what the provider reported, not a receipt:
 *
 *   free row                        0
 *   priced, output tokens reported  (input estimate + o x price) -- the real figure
 *   unpriced, tokens reported       the documented unpriced price x o (`UNPRICED_PER_M`)
 *   a cut stream (`x`)              `o` is the allowance the stream reached, never below it
 *   `timeout`                       the row's worst case: the output is unknown and a
 *                                   provider may bill a cut-off stream in full
 *   `error`                         0 unless tokens were reported (a stream can fail
 *                                   AFTER tokens flowed and still bill; a refused or
 *                                   5xx request does not)
 *   no usage reported               the typical-answer estimate
 *   auth / pay / gone / rate        0
 *
 * A target without price fields (a hand-built one) is charged its `cost`.
 */
export function billedCost(t, res) {
  if (t.free) return 0;
  const o = Number.isFinite(res?.o) && res.o >= 0 ? res.o : null;
  const s = res?.s;
  const billed = s === "ok" || s === "empty" || s === "timeout" || (s === "error" && o !== null && o > 0);
  if (!billed) return 0;
  const worst = t.worst ?? t.cost;
  if (s === "timeout") return worst;
  if (o === null) return t.cost;
  if (Number.isFinite(t.pin) && Number.isFinite(t.pout)) return (IN_TOKENS * t.pin + o * t.pout) / 1e6;
  if (t.unpriced) return unpricedCost(o);
  return t.cost;
}

/**
 * Snapshot -> per-provider work lists. One target per `provider/bare-id`;
 * non-text and known-unroutable rows are not probed (a `null` routability is
 * unknown, not dead, and is probed). Each provider's list is ordered
 * canary-first: free rows in catalogue order, then paid rows cheapest-first.
 *
 * `only` narrows to providers (`openrouter`) and/or exact rows (`openrouter/free`).
 */
export function buildTargets(snap, { only = null, maxTokens = BENCH_MAX_TOKENS } = {}) {
  const wantProv = new Set(), wantKey = new Set();
  for (const o of only ?? []) (String(o).includes("/") ? wantKey : wantProv).add(String(o));
  // An `only` list that was GIVEN is a filter even when it is empty: an empty filter must select NOTHING,
  // never everything (`--only ,` once planned all 732 rows).
  const filtering = only !== null && only !== undefined;

  const groups = new Map();
  const seen = new Set();
  for (const row of snap?.rows ?? []) {
    for (const m of row.models ?? []) {
      if (m.outputKind === "nontext" || m.routable === false) continue;
      const key = benchKey(row.provider, m.id);
      if (seen.has(key)) continue;
      if (filtering && !wantProv.has(row.provider) && !wantKey.has(key)) continue;
      seen.add(key);
      const bare = key.slice(row.provider.length + 1);
      // pin/pout ride along so the sweep can bill a probe from the tokens the provider
      // REPORTED rather than from the typical-answer estimate (see `billedCost`).
      const t = { key, provider: row.provider, id: bare, free: isFree(m),
                  cost: estimateCost(m), worst: worstCost(m, maxTokens), maxTokens,
                  ...(priced(m) ? { pin: m.pin, pout: m.pout } : { unpriced: true }) };
      if (!groups.has(row.provider)) groups.set(row.provider, []);
      groups.get(row.provider).push(t);
    }
  }
  // Rows that are usually NOT plain chat go to the back of their tier. The canary
  // is the first row probed and it can decide a provider's fate, so it must not be
  // a moderation, embedding or opt-in "labs" model (measured: openai's cheapest row
  // was text-moderation-007, mistral's was a Labs model that needs a separate opt-in).
  const odd = (t) => (NONCHAT_HINT.test(t.id) ? 1 : 0);
  for (const [p, list] of groups) {
    const free = list.filter((t) => t.free).sort((a, b) => odd(a) - odd(b));
    // Within the paid tier: chat-looking before odd ids, then PRICED before UNPRICED (an unknown cost goes last: its
    // cost is an assumption, and it would otherwise sort first as the cheapest), then cheapest first.
    const paid = list.filter((t) => !t.free).sort((a, b) => odd(a) - odd(b) || (a.unpriced ? 1 : 0) - (b.unpriced ? 1 : 0) || a.cost - b.cost);
    groups.set(p, [...free, ...paid]);
  }
  return groups;
}

const NONCHAT_HINT = /moderation|embed|rerank|whisper|tts|transcri|speech|audio|guard|safety|classif|\bocr\b|labs|\bbge\b|\bclip\b|image|imagen|veo|lyria|dall-?e/i;

// ------------------------------------------------------------ scheduler

const HARD = new Set(["auth", "pay", "error", "timeout"]);
const DELAY = Symbol("delay");

/**
 * Run every target, bounded on every axis that can hurt:
 *
 *   concurrency   at most `concurrency` requests in flight overall (the gateway
 *                 is shared with live Claude Code sessions)
 *   perProvider   at most `perProvider` per provider, and exactly ONE until that
 *                 provider has answered once (the canary)
 *   round-robin   providers are served in rotation, so a 470-row provider cannot
 *                 starve the rest of the slots, and wall time is bounded by the
 *                 largest providers rather than by the row count
 *   maxMs         a wall-clock limit: dispatching stops, the probes still in flight are
 *                 dropped (aborted, NOT recorded, re-probed on resume: a probe may be
 *                 allowed minutes, so waiting for it would overrun the limit) and
 *                 everything not yet dispatched is left for a resume
 *
 * and stops spending where it is pointless:
 *
 *   dead provider    `deadAfter` consecutive auth refusals (or free-row pay), or
 *                    `deadAfter` consecutive errors, with no success: the rest of
 *                    its rows are recorded `skip:provider-dead` with ZERO requests
 *   unfunded         `unfundedAfter` consecutive pay results among PAID rows:
 *                    remaining paid rows are `skip:unfunded`. Free rows never
 *                    count, so a provider whose free models work on an unfunded
 *                    account (aihubmix) keeps getting probed. The breaker is
 *                    checked at dispatch, so it can overshoot by the probes
 *                    already in flight: at most `perProvider - 1` extra
 *   429              provider-level pause with exponential backoff (honouring
 *                    Retry-After), the row retried up to `maxRetries.rate` times
 *   spend            `spent` is the running ESTIMATE of the bill, charged from the
 *                    tokens each provider REPORTED (`billedCost`). A paid row is
 *                    admitted only if `spent + reserved + worst` fits under
 *                    `maxSpend`: an in-flight probe holds its WORST case (full
 *                    max_tokens) until it finishes, so concurrency cannot push the
 *                    billed total past the cap. A row that cannot fit even on
 *                    `spent` alone is recorded `skip:spend-cap`; one that fits only
 *                    until the reservations of probes still in flight are released
 *                    WAITS instead (those probes may fail unbilled). A row whose
 *                    worst case exceeds `maxRowCost` is `skip:row-cost`. A row being
 *                    RETRIED faces the same gate (measured: retries that bypassed it
 *                    let a $2.00 cap reach an estimated $2.12). This is not a hard
 *                    bound on the real invoice: it rests on the providers' own token
 *                    counts and on our price table.
 *
 * `probeAll` (the CLI's --probe-all) turns the two circuit breakers OFF: nothing is
 * ever recorded `skip:provider-dead` or `skip:unfunded`, so every model gets its own
 * answer. Only `row-cost` and `spend-cap` can still skip a row. To stay polite to
 * a provider that keeps refusing (key suspension, abuse detection) it COOLS that
 * provider instead: after `coolAfter` consecutive auth / pay / error / timeout
 * results with no ok in between, the provider drops to one request in flight with
 * at least `coolGapMs` between dispatches, no second attempt at its failing rows,
 * and returns to normal on its next ok. gone / rate / empty neither count toward
 * that run nor reset it. Cooling exists ONLY in probe-all: outside it `coolAfter`
 * is forced off.
 *
 * `gatewayCheck` (an async () => boolean, "is the gateway answering?") arms a
 * run-wide outage breaker. Failures that all come from one dead gateway would
 * otherwise be recorded as if each model had failed. After `outageAfter`
 * consecutive final hard results (auth/pay/error/timeout, or the skips they
 * cause) across ALL providers with no ok anywhere, the check is called. While it
 * is unarmed nothing changes. Such results are HELD, not emitted, until an ok (or
 * a passing check) proves them real. If the gateway is down: dispatch pauses, the
 * held rows are put back in their queues (not recorded), probes that were in
 * flight are put back as they finish (unless they answer ok), every provider's
 * streaks are cleared, and the check is polled every `outagePollMs`. It resumes
 * when the gateway answers; after `outageWaitMs` down it stops like an abort and
 * everything unrecorded is left for a resume.
 *
 * Every probe gets its OWN abort signal (`probe(t, { signal })`), fired when the run stops
 * (a time limit, an outage give-up) or when a confirmed outage makes the probe worthless
 * (it is then put back, not dropped). That is what keeps a long per-probe timeout (the CLI's
 * default is 240 s) from delaying any of them: nothing waits for a hung request.
 *
 * `outageIdleMs` is the second outage trigger. With slow failures the consecutive-results
 * rule can take a quarter of an hour to fill (30 results at 240 s each, 8 at a time), so when
 * `gatewayCheck` is armed and NOT ONE probe has answered ok for `outageIdleMs` while probes
 * are in flight, the check is called as well.
 *
 * Aborting through `signal` stops dispatching and drops the probes in flight
 * (they are NOT recorded, and are re-probed on resume); what was already recorded
 * stays. Rows never dispatched are simply not recorded, so a resume picks them up.
 */
export async function runSweep({
  groups, probe, onResult = () => {}, signal = null,
  concurrency = 8, perProvider = 2, maxSpend = 2, maxRowCost = 0.01,
  maxRetries = { rate: 2, other: 1 }, backoffBaseMs = 1000, backoffMaxMs = 60000,
  deadAfter = 3, unfundedAfter = 5, now = Date.now,
  probeAll = false, coolAfter = probeAll ? 10 : Infinity, coolGapMs = 400,
  maxMs = Infinity,
  gatewayCheck = null, outageAfter = 30, outagePollMs = 10000, outageWaitMs = 10 * 60000, outageIdleMs = Infinity,
  timers = { set: setTimeout, clear: clearTimeout },
}) {
  if (probeAll) { deadAfter = Infinity; unfundedAfter = Infinity; } else coolAfter = Infinity;
  const providers = [...groups].map(([name, list]) => ({
    name, queue: [...list], inflight: 0, completed: 0, ok: 0,
    failStreak: 0, hardStreak: 0, payStreak: 0, level: 0, pausedUntil: 0, dead: false, unfunded: false,
    coolStreak: 0, lastAt: -Infinity, coolSeen: false,
  }));
  const byName = new Map(providers.map((p) => [p.name, p]));
  const counts = {}, skips = {};
  // `spent` is what has been (estimated as) BILLED; `reserved` is what in-flight
  // paid probes could still add (each holds its worst case). The gate checks both.
  let inflightTotal = 0, spent = 0, reserved = 0, probes = 0;
  let stop = null, down = false, outages = 0, requeued = 0, hardRun = 0, epoch = 0;
  const live = new Map();          // per-probe abort controller -> its target
  const abortLive = (requeueThem) => { for (const [c, t] of live) { if (requeueThem) t.outageDropped = true; c.abort(); } };
  const held = [];
  let wake = null;
  const wakeUp = () => { const r = wake; wake = null; r?.(); };
  // Without this, an abort while the loop is parked on `wakeP` (every slot busy,
  // or every provider paused for backoff) would not be noticed until something else
  // happened to complete -- up to a full backoff period later.
  signal?.addEventListener?.("abort", wakeUp, { once: true });

  const out = (t, res) => {
    counts[res.s] = (counts[res.s] ?? 0) + 1;
    onResult({ key: t.key, provider: t.provider, id: t.id, a: Math.floor(now() / 1000), ...res });
  };
  const flushHeld = () => { for (const h of held.splice(0)) out(h.t, h.res); };
  const suspect = (res) => HARD.has(res.s) || (res.s === "skip" && (res.w === "provider-dead" || res.w === "unfunded"));
  // Every final result goes through here. With the outage breaker armed, results that
  // could be the gateway's fault are held until something proves them real.
  const emit = (t, res) => {
    if (!gatewayCheck) return out(t, res);
    if (suspect(res)) { held.push({ t, res }); if (HARD.has(res.s)) hardRun += 1; return; }
    if (res.s === "ok") { flushHeld(); hardRun = 0; }
    out(t, res);
  };
  const skip = (t, why, note) => {
    skips[why] = (skips[why] ?? 0) + 1;
    emit(t, { s: "skip", w: why, ...(note ? { p: note } : {}) });
  };
  const requeue = (t) => {
    t.retried = false; t.attempt = 0;
    byName.get(t.provider).queue.unshift(t);
    requeued += 1;
  };
  const discardHeld = () => {
    for (const { t, res } of held.splice(0).reverse()) {
      if (res.s === "skip") skips[res.w] = Math.max(0, (skips[res.w] ?? 1) - 1);
      spent -= t.billedTotal ?? 0; t.billedTotal = 0;
      requeue(t);
    }
    for (const p of providers) {
      p.coolStreak = 0; p.failStreak = 0; p.hardStreak = 0; p.payStreak = 0; p.level = 0;
      p.dead = false; p.unfunded = false; p.pausedUntil = 0;
    }
    hardRun = 0;
  };

  const cooling = (ps) => ps.coolStreak >= coolAfter;
  // The earliest moment this provider may dispatch again: its 429 pause, and in
  // cool mode the gap since its last dispatch.
  const readyAt = (ps) => Math.max(ps.pausedUntil, cooling(ps) ? ps.lastAt + coolGapMs : 0);
  const backoff = (ps, ra) => Math.min(backoffMaxMs,
    Number.isFinite(ra) && ra > 0 ? ra : backoffBaseMs * 2 ** Math.min(ps.level, 10));   // a 0 (or absent) hint is no hint

  // Pop targets until one needs a request, recording every skip decided on the way.
  // Returns DELAY when the head row fits only if in-flight reservations are released.
  const takeNext = (ps) => {
    while (ps.queue.length) {
      const t = ps.queue[0];
      if (ps.dead) { ps.queue.shift(); skip(t, "provider-dead"); continue; }
      if (!t.free) {
        if (!t.retried) {
          if (ps.payStreak >= unfundedAfter) { ps.queue.shift(); ps.unfunded = true; skip(t, "unfunded"); continue; }
          if ((t.worst ?? t.cost) > maxRowCost) { ps.queue.shift(); skip(t, "row-cost"); continue; }
        }
        // A retry is one more request that can bill, so it faces the cap too. (`spent`
        // already holds any earlier billed attempt of this row; the row is emitted once.)
        const need = t.worst ?? t.cost;
        if (spent + need > maxSpend) {
          ps.queue.shift();
          skip(t, "spend-cap", t.retried ? `retry not sent: spend cap reached (first try ${t.lastS ?? "failed"})` : null);
          continue;
        }
        // Over the cap only because of probes still in flight, which may yet fail
        // unbilled: wait for them instead of recording a skip that never had to be.
        if (spent + reserved + need > maxSpend) return DELAY;
      }
      return ps.queue.shift();
    }
    return null;
  };

  const settle = (ps, t, res) => {
    ps.completed += 1;
    const s = res.s;
    if (s === "ok") ps.coolStreak = 0;
    else if (HARD.has(s)) {
      ps.coolStreak += 1;
      if (cooling(ps)) ps.coolSeen = true;
    }
    if (s === "ok" || s === "empty") {
      if (s === "ok") ps.ok += 1;
      ps.failStreak = 0; ps.level = 0; if (s === "ok") ps.hardStreak = 0;
      if (!t.free && s === "ok") ps.payStreak = 0;
      return emit(t, res);
    }
    if (s === "rate") {
      ps.pausedUntil = now() + backoff(ps, res.ra); ps.level += 1;
      if ((t.attempt ?? 0) < maxRetries.rate) {
        t.attempt = (t.attempt ?? 0) + 1; t.retried = true; t.lastS = s; ps.queue.unshift(t); return;
      }
      return emit(t, res);
    }
    if (s === "timeout" || s === "error") {
      ps.failStreak += 1;
      // A timeout is never retried: it already waited the whole deadline (240 s by default), and a second
      // wait at the same row doubles the cost of a slow provider for no new information.
      // Decided on EVERY failure, before the retry: a provider that has never
      // answered and has now failed `deadAfter` times in a row is not worth a
      // second attempt at each of its rows. The same goes for a cooled provider:
      // a second request at a row that just failed is exactly the pressure cooling is for.
      if (ps.ok === 0 && ps.failStreak >= deadAfter) ps.dead = true;
      if (s === "error" && !ps.dead && !cooling(ps) && (t.attempt ?? 0) < maxRetries.other) {
        t.attempt = (t.attempt ?? 0) + 1; t.retried = true; t.lastS = s; ps.queue.push(t); return;
      }
      return emit(t, res);
    }
    // A provider is dead only after `deadAfter` CONSECUTIVE hard refusals with no
    // success -- not after one. A single `auth` can be about that ROW (mistral's
    // "is a Labs model" opt-in) rather than the key, and one bad canary used to
    // condemn 198 rows. gone/rate/empty between them neither add to nor reset the run.
    if (s === "auth") {
      emit(t, res); ps.hardStreak += 1;
      if (ps.ok === 0 && ps.hardStreak >= deadAfter) ps.dead = true;
      return;
    }
    if (s === "pay") {
      emit(t, res);
      if (t.free) { ps.hardStreak += 1; if (ps.ok === 0 && ps.hardStreak >= deadAfter) ps.dead = true; }
      else ps.payStreak += 1;
      return;
    }
    emit(t, res);   // gone, or anything else: a fact about this one model
  };

  const launch = (ps, t) => {
    ps.inflight += 1; inflightTotal += 1; probes += 1; ps.lastAt = now();
    const hold = t.free ? 0 : (t.worst ?? t.cost);
    reserved += hold;
    const ctl = new AbortController(), born = epoch;
    live.set(ctl, t);
    (async () => {
      let res;
      try { res = await probe(t, { signal: ctl.signal }); } catch (e) { res = { s: "error", p: snippet(e?.message ?? e), m: message(e?.message ?? e) }; }
      live.delete(ctl);
      reserved -= hold;
      if (res?.aborted) {
        // Dropped by a confirmed outage: the row goes back. Dropped by a stop or by Ctrl-C: it is left for a resume.
        if (t.outageDropped) { t.outageDropped = false; requeue(t); }
        return;
      }
      // Anything but an answer that comes back during a confirmed outage, or that was sent
      // before one and only now failed, says nothing about the model: put the row back,
      // record nothing, bill nothing.
      if ((down || born !== epoch) && res.s !== "ok") { requeue(t); return; }
      if (res.s === "ok") lastOkAt = now();
      const bill = billedCost(t, res);
      spent += bill; t.billedTotal = (t.billedTotal ?? 0) + bill;
      settle(ps, t, res);
    })().finally(() => { ps.inflight -= 1; inflightTotal -= 1; wakeUp(); });
  };

  const pause = (ms) => new Promise((resolve) => {
    let h;
    const done = () => { timers.clear(h); signal?.removeEventListener?.("abort", done); resolve(); };
    h = timers.set(done, ms);
    signal?.addEventListener?.("abort", done, { once: true });
  });
  const check = async () => { try { return !!(await gatewayCheck()); } catch { return false; } };
  const handleOutage = async () => {
    if (await check()) { flushHeld(); hardRun = 0; lastOkAt = now(); return; }
    outages += 1; down = true; epoch += 1; discardHeld();
    abortLive(true);                 // nothing in flight can tell us anything now; free its slot at once
    const since = now();
    for (;;) {
      if (signal?.aborted) break;
      if (now() - since >= outageWaitMs) { stop = "outage"; abortLive(false); break; }
      await pause(outagePollMs);
      if (signal?.aborted) break;
      if (await check()) break;
    }
    down = false;
  };

  const startedAt = now();
  let lastOkAt = startedAt, cursor = 0;
  for (;;) {
    const idle = gatewayCheck && Number.isFinite(outageIdleMs) && inflightTotal > 0 && now() - lastOkAt >= outageIdleMs;
    if (gatewayCheck && (hardRun >= outageAfter || idle) && !signal?.aborted) await handleOutage();
    if (signal?.aborted || stop) break;
    if (now() - startedAt >= maxMs) { stop = "time"; abortLive(false); break; }
    const wakeP = new Promise((r) => { wake = r; });

    // Round-robin passes until a full pass launches nothing or the slots are full.
    let progressed = true;
    while (progressed && inflightTotal < concurrency) {
      progressed = false;
      for (let n = 0; n < providers.length && inflightTotal < concurrency; n++) {
        const ps = providers[(cursor + n) % providers.length];
        if (!ps.queue.length) continue;
        if (ps.inflight >= (ps.completed === 0 || cooling(ps) ? 1 : perProvider)) continue;
        if (now() < readyAt(ps)) continue;
        const t = takeNext(ps);
        if (!t || t === DELAY) continue;
        launch(ps, t);
        progressed = true;
      }
      cursor = (cursor + 1) % Math.max(1, providers.length);
    }

    const queued = providers.some((p) => p.queue.length > 0);
    if (!queued && inflightTotal === 0) break;

    let wakeAt = Number.isFinite(maxMs) ? startedAt + maxMs : Infinity;
    for (const p of providers) if (p.queue.length && readyAt(p) > now()) wakeAt = Math.min(wakeAt, readyAt(p));
    if (gatewayCheck && Number.isFinite(outageIdleMs) && inflightTotal > 0) wakeAt = Math.min(wakeAt, lastOkAt + outageIdleMs);
    let timer = null;
    // (setTimeout cannot take more than 2^31-1 ms; a longer wait is just re-armed on wake)
    if (wakeAt !== Infinity) timer = timers.set(wakeUp, Math.min(2 ** 31 - 1, Math.max(1, wakeAt - now() + 1)));
    await wakeP;
    if (timer !== null) timers.clear(timer);
  }

  // Let anything already in flight finish (it is either recorded, put back, or aborted).
  while (inflightTotal > 0) await new Promise((r) => { wake = r; if (inflightTotal === 0) r(); });
  if (stop === "outage") discardHeld(); else flushHeld();

  return {
    counts, skips, probes, spent: Math.round(spent * 10000) / 10000,
    aborted: !!signal?.aborted || !!stop,
    stopped: signal?.aborted ? "signal" : stop,
    cooled: providers.filter((p) => p.coolSeen).map((p) => p.name),
    dead: providers.filter((p) => p.dead).map((p) => p.name),
    unfunded: providers.filter((p) => p.unfunded).map((p) => p.name),
    outage: { events: outages, requeued, gaveUp: stop === "outage" },
  };
}

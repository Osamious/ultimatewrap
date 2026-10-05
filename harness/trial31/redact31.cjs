'use strict';
// Secret redaction for text the trial harness ECHOES (violation messages, daemon logs). CommonJS so the
// guard preload (guard-core.cjs) and the ESM harness share one implementation. Lossy on purpose: it masks
// anything token-shaped rather than trying to understand it. NOT a general-purpose redactor.
//
// daemon.out.log carries the management-server URL with the per-run web token (`?ccr_web_token=<hex>`). The
// token is dead once the daemon stops, but it is still a credential while it runs: never print that file raw.

const RULES = [
  // URL userinfo (`scheme://user:pass@host`, `scheme://token@host`): the credential sits before the @ in a shape no key name gives away
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi, '$1<redacted>@'],
  // whole-line values: Cookie / Set-Cookie carry session tokens in shapes no key name gives away
  [/\b(set-cookie|cookie)(\s*:\s*)[^\r\n]*/gi, '$1$2<redacted>'],
  // an ARRAY-valued key (`"api_key":["a","b"]`, `APIKEYS: [..]`): the generic rule below stops at the first quote and would leak the rest
  [/\b(api[-_]?keys?["']?\s*[=:]\s*)\[[^\]]*\]/gi, '$1[<redacted>]'],
  // named credentials; for `Authorization: Basic <b64>` / `Bearer <token>` the scheme word is consumed so the credential after it goes too
  [/(ccr_web_token|ccr_service_token|serviceToken|x-ccr-web-auth|authorization|api[-_]?keys?|token|secret|password)(["']?\s*[=:]\s*["']?)(?:(?:Bearer|Basic)\s+)?[^\s"'&,;)}\]]+/gi, '$1$2<redacted>'],
  // a bare `key=...` / `"key":"..."` (a query string or a JSON field named just `key`)
  [/(\bkey["']?\s*[=:]\s*["']?)[^\s"'&,;)}\]]+/gi, '$1<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{2,}){0,2}/g, '<redacted-jwt>'],
  [/\bAIza[A-Za-z0-9_-]{16,}/g, '<redacted-key>'],
  [/\b(?:sk|pk|rk|gsk|csk|nvapi|hf|ghp|gho)[-_][A-Za-z0-9_-]{16,}/g, '<redacted-key>'],
  [/\b[0-9a-fA-F]{32,}\b/g, '<redacted-hex>'],
];

/** Masks token-shaped substrings. Idempotent; never throws; non-strings are stringified. */
function redactSecrets(text) {
  let s = String(text ?? '');
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}

/** Redacts every line of a log's text (daemon.out.log / daemon.err.log). */
function redactDaemonLog(text) {
  return String(text ?? '').split(/\r?\n/).map(redactSecrets).join('\n');
}

module.exports = { redactSecrets, redactDaemonLog };

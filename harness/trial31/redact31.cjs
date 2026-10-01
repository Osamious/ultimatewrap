'use strict';
// Secret redaction for text the trial harness ECHOES (violation messages, daemon logs). CommonJS so the
// guard preload (guard-core.cjs) and the ESM harness share one implementation. Lossy on purpose: it masks
// anything token-shaped rather than trying to understand it. NOT a general-purpose redactor.
//
// daemon.out.log carries the management-server URL with the per-run web token (`?ccr_web_token=<hex>`). The
// token is dead once the daemon stops, but it is still a credential while it runs: never print that file raw.

const RULES = [
  [/(ccr_web_token|ccr_service_token|serviceToken|x-ccr-web-auth|authorization|api[-_]?key|token|secret|password)(["']?\s*[=:]\s*["']?)(?:Bearer\s+)?[^\s"'&,;)}\]]+/gi, '$1$2<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer <redacted>'],
  [/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{2,}){0,2}/g, '<redacted-jwt>'],
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

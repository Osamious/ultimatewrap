// Redaction for the provider's own sentences before they are PERSISTED (bench `m` / the
// error text in `p`) and again when they are loaded.
//
// A provider's error text is third-party input that we then keep in a file: it may quote
// a masked credential ("Incorrect API key provided: 7f3a9c*****e21d" -- enough of a key to
// identify which one is in use), link out to a billing page, name an account by email, or
// carry an opaque request id. The sentence is what a later reader needs ("Insufficient
// Balance", "model does not exist"); the identifiers are not. So the readable words stay
// and the identifying fragments become a fixed label.
//
// Order matters and is part of the contract:
//   1. whitespace controls become spaces, then control and invisible characters are stripped
//      and the text is NFKC-normalised, so `sk-\x00abcdef...`, a tab inside `Bearer\tabc...`
//      or a fullwidth `sk-ａｂｃ...` cannot hide a key from the patterns below
//   2. then the patterns, most specific first
//   3. the caller clips to its own width AFTER, so a key is never cut in half and left as
//      an unmatchable fragment
//
// Idempotent: the labels contain nothing any pattern matches, so redacting twice is the
// same as once (the load-side pass runs over text the write-side pass already cleaned, and
// `bench-cli --redact` may be run again after this list grows: it only changes what the new
// patterns newly match).
//
// TWO KINDS OF KEY SHAPE, because a bare word is not a key: a PREFIXED shape (`sk-`, `hf_`,
// `gsk_` ...) is masked whether or not it contains a digit when it is long enough or its
// separator is an underscore; a BARE token (`token: abcd`) needs a digit, so that "Invalid
// token: expired" and "hf-internal-testing is not a valid model" survive.
//
// KNOWN LIMITS, stated so nobody trusts this more than it deserves: a homoglyph (a Cyrillic
// `а` inside `sk-аbc...`) is not folded by NFKC and gets through; the host rule knows a fixed list of
// top-level domains and deliberately leaves out the short ones that are also English words
// ("failed.to retry"); a credential in a shape nobody has listed is not caught.
//
// `redactMessage(text, { links: false })` keeps links, hostnames, e-mail addresses and IPs and masks
// only credentials and identifiers: that is the mode for an `ok` answer's preview, which is the
// MODEL's text (a URL in an answer is content), yet can still quote a key.

import { sanitizeDisplay } from "./sanitize.mjs";

const MAX_INPUT = 2048;
const TLD = "com|ai|io|net|org|dev|app|bond|cn|ru|xyz|cloud|info|biz|co|tech|site|online|store|pro|top|vip|club|link|live|page";
const TOK = String.raw`[A-Za-z0-9_-]`;
const PREFIXES = "sk|pk|rk|gsk|csk|nvapi|hf|ghp|gho|xox[abps]";
// a link's characters: anything but a delimiter, or an [email] label an earlier rule already left in it
// (a bare "[" is not a link character, so the only way to consume one is as part of an [email] label)
const URLCH = String.raw`(?:\[email\]|[^\s"'<>)\]\[])`;
const URLEND = String.raw`(?:\[email\]|[^\s"'<>)\]\[.,;:!?])`;

// Rules about WHERE the text points or WHO it names.
const LINK_RULES = [
  // e-mail addresses first (quoted account names), so the host part is not taken for a link
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[email]"],
  // URLs, then domain/path links and bare hostnames ("commandcode.ai/billing", "example.com"). A link
  // may not END in sentence punctuation ("at https://x.ai/keys, then" keeps its comma). Written with
  // no ambiguous repetition, so each is linear per start position.
  [new RegExp(String.raw`https?:\/\/${URLCH}*${URLEND}`, "gi"), "[url]"],
  [new RegExp(String.raw`\b(?:[a-z0-9-]+\.)+(?:${TLD})\b(?:/${URLCH}*${URLEND})?`, "gi"), "[url]"],
  // any host followed by a PATH or a PORT, whatever its top-level domain ("dash.example.us/keys", "gw.corp.me:8443"):
  // a link with a path is a link. (A bare "failed.to retry" has neither, and is left alone.)
  [new RegExp(String.raw`\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{2,5})?/${URLCH}*${URLEND}`, "gi"), "[url]"],
  [new RegExp(String.raw`\b(?:[a-z0-9-]+\.)+[a-z]{2,}:\d{2,5}\b`, "gi"), "[url]"],
  // IPv4 addresses, with an optional port
  [/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?![\d.])/g, "[ip]"],
  // bracketed IPv6 (with the port that follows it), then the bare loopback
  [/\[(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\](?::\d{2,5})?|\[[0-9a-f:]*::[0-9a-f:]*\](?::\d{2,5})?/gi, "[ip]"],
  // IPv6: the full eight-group form, and the "::" compressed forms (times like 12:30:45 have neither)
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi, "[ip]"],
  [/(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, "[ip]"],
  [/(?<![\w:])::1(?![\w:])/g, "[ip]"],
];

// Rules about credentials and opaque identifiers.
const SECRET_RULES = [
  // JSON web tokens: the WHOLE triple (header.payload.signature), not just the eyJ header
  [new RegExp(String.raw`\beyJ${TOK}{5,}(?:\.${TOK}{2,}){0,2}`, "g"), "[key]"],
  // masked credentials: three or more asterisks, two or more bullets, or six or more x's, inside a token;
  // and a token cut off in mid-mask by an earlier 40-character clip (`abcdef*` at the very end)
  [/[A-Za-z0-9_-]*(?:\*{3,}|[•●·▪]{2,})[A-Za-z0-9_-]*/g, "[masked-key]"],
  // (an x-mask needs a real character on both sides: a bare run of x's is just text)
  [/[A-Za-z0-9_-]*[a-wyzA-WYZ0-9_-](?:x{6,}|X{6,})[a-wyzA-WYZ0-9_-][A-Za-z0-9_-]*/g, "[masked-key]"],
  [/\b[A-Za-z0-9_-]{4,}\*{1,2}$/g, "[masked-key]"],
  // ellipsis-elided credentials: `sk-abcd...wxyz`, `7f3a9c...e21d` (a prefixed shape, or a token with a digit)
  [new RegExp(String.raw`\b(?:${PREFIXES})[-_]${TOK}{2,}(?:\.{3}|…)${TOK}{2,}`, "gi"), "[masked-key]"],
  [new RegExp(String.raw`\b(?=[A-Za-z0-9_.…-]*\d)${TOK}{3,}(?:\.{3}|…)${TOK}{3,}`, "g"), "[masked-key]"],
  // named secrets, quoted or not, JSON or key=value: the name says it is a secret, so no digit is needed
  [new RegExp(String.raw`["']?\b(?:api[_-]?key|apikey|secret(?:[_-]?key)?|password|passwd|access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?`, "gi"), "[key]"],
  // tokens and authorization headers: a digit is required for an UNQUOTED value ("token: expired" is prose)
  [new RegExp(String.raw`["']?\b(?:token|auth[_-]?token|access[_-]?token|authorization)["']?\s*[=:]\s*["']?(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}["']?`, "gi"), "[key]"],
  [new RegExp(String.raw`["'](?:token|auth[_-]?token|access[_-]?token|authorization)["']\s*:\s*["'][A-Za-z0-9._~+/=-]{16,}["']`, "gi"), "[key]"],
  // a bare word after `token:` that is 20+ letters long is a token, not prose
  [new RegExp(String.raw`["']?\b(?:token|auth[_-]?token|access[_-]?token|authorization)["']?\s*[=:]\s*["']?[A-Za-z]{20,}["']?`, "gi"), "[key]"],
  [/\b(?:Bearer|Basic)\s+(?:(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}|[A-Za-z0-9._~+/=-]{20,})/gi, "[key]"],
  // well-known credential shapes (case-insensitive: `SK-ABC...` is the same key). Underscore prefixes are
  // key-like on their own; hyphen prefixes need a digit or real length ("hf-internal-testing" is an
  // organisation, not a key).
  [/\b(?:sk|pk|rk|gsk|csk|ghp|gho|hf)_[A-Za-z0-9_]{8,}/gi, "[key]"],
  [new RegExp(String.raw`\b(?:sk|pk|rk|gsk|csk|ghp|gho|hf|nvapi|xox[abps])-(?:(?=${TOK}*\d)${TOK}{8,}|${TOK}{20,})`, "gi"), "[key]"],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, "[key]"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[key]"],
  // identifiers: provider request and account ids (Anthropic `req_...`, `msg_...`, OpenAI `chatcmpl-...`,
  // `org-...`, `acct_...`, `fw_...`), UUIDs, digit-only runs of 16 or more (request and trace ids such as
  // `(tid: 20260929...)`), and long unbroken letter+digit runs. Hyphenated model ids
  // ("gpt-4o-mini-audio-preview-2024-12-17") are deliberately NOT matched.
  [/\b(?:req|msg|resp|toolu|chatcmpl|gen)[_-][A-Za-z0-9]{12,}/g, "[id]"],
  [/\b(?:org|acct|fw|cus)[_-][A-Za-z0-9]{14,}/g, "[id]"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[id]"],
  [/\b\d{16,}\b/g, "[id]"],
  [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{28,}\b/g, "[id]"],
];

/** The sentence with credentials, links, e-mail addresses, IPs and opaque ids replaced by labels. */
export function redactMessage(text, { links = true } = {}) {
  // Bounded first: every caller keeps at most a few hundred characters, the probe already reads
  // only the first 2 KB of a body, and a provider must not be able to hand us a pathological megabyte.
  // NFKC can EXPAND text (a compatibility character such as U+33C2 becomes four), so the bound is applied again after it.
  let s = sanitizeDisplay(sanitizeDisplay(String(text ?? "").replace(/[\t\r\n\v\f]+/g, " "), MAX_INPUT).normalize("NFKC"), MAX_INPUT);
  if (links) for (const [re, label] of LINK_RULES) s = s.replace(re, label);
  for (const [re, label] of SECRET_RULES) s = s.replace(re, label);
  return s;
}

/**
 * Redact, then clip to `max` characters, then drop a label the clip cut in half: a 40-character cut can
 * leave `... at [ur` or `[masked-k` at the end, which reads as debris.
 */
export function redactClip(text, max, opts) {
  return sanitizeDisplay(redactMessage(text, opts), max).replace(/\s*\[[a-z-]*$/, "");
}

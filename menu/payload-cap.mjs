// Can a FREE row actually serve a Claude Code request, and if not, why?
//
// Imports nothing, so both the renderer and the reducer can read it without a
// cycle -- the same arrangement `legend.mjs` uses.
//
// WHY THIS EXISTS. `keysync/provider-sweep.mjs` sends a 1KB probe, so it measures
// REACHABILITY: every capped free tier passes it and then fails in real use. The
// gap is not hypothetical -- MEASURED 2026-09-09, `orcarouter/deepseek/
// deepseek-v4-flash-free` answered a 1KB probe in 2.1s and refused a real
// 408KB Claude Code request, and the picker offered it as though it worked.

// Claude Code's smallest possible request: its own 39 built-in tools (144.1KB),
// its system preamble (9.0KB) and one short user turn. MEASURED 2026-09-09 from
// a real logged request body. Nothing the user can switch off reduces it --
// disabling every MCP server still leaves this -- so a free tier capped below it
// cannot serve Claude Code at any configuration, which is what makes this the
// threshold worth colouring red rather than an arbitrary "large".
export const CC_MIN_BYTES = 156981;

// What a WORKING session actually sends, which is a different number and the one
// worth probing at. MEASURED 2026-09-09 from real logged requests: 408KB with
// MCP servers loaded (278 tools), and 219KB with Claude Code's built-in tools
// only and five turns of conversation.
//
// PROBING AT `CC_MIN_BYTES` WAS WRONG AND THE FIRST DRY RUN CAUGHT IT.
// `orcarouter/deepseek/deepseek-v4-flash-free` ACCEPTED 153KB and refuses 408KB,
// so a probe at the floor reported `ok` for a tier that breaks as soon as the
// conversation grows past the first message. The floor is the right threshold
// for COLOURING a measured cap -- below it nothing can ever work -- and the
// wrong size for asking whether a tier is usable.
export const CC_TYPICAL_BYTES = 400 * 1024;

// The vocabulary, in one place because three consumers render it: the model row,
// the provider row, and the legend. `rank` orders severity for the provider-level
// aggregate; `durable` says whether the answer can change without the user doing
// anything, which is what separates red from yellow.
export const VERDICTS = Object.freeze({
  ok:       { rank: 0, durable: true,  colour: "grn", cell: "ok" },
  capped:   { rank: 1, durable: true,  colour: "grn", cell: null },   // cell is the size
  unpaid:   { rank: 2, durable: false, colour: "yel", cell: "unpaid" },
  rate:     { rank: 3, durable: false, colour: "yel", cell: "rate" },
  upstream: { rank: 4, durable: false, colour: "yel", cell: "5xx" },
  unusable: { rank: 5, durable: true,  colour: "red", cell: null },   // cell is the size
  locked:   { rank: 6, durable: true,  colour: "red", cell: "locked" },
  unknown:  { rank: 7, durable: true,  colour: "",    cell: "?" },
  none:     { rank: 8, durable: true,  colour: "",    cell: "" },
});

// A provider's free tier refuses on size only if it SAYS so. A status code cannot
// carry this: orcarouter says it with a 400, and 400 is also what opencode
// returns for "free tier can only be used in OpenCode". Text matching is fragile
// and is the only signal there is, so a miss degrades to a non-size verdict,
// which is honest ("it refuses") rather than wrong ("it has no cap").
const SIZE_REFUSAL =
  /(longer than|too long|exceeds?|prompt (is |too )|payload|request size|max(imum)? (context|input|prompt|tokens))/i;
// "no credits", "allowance used up", "insufficient balance", "top up".
const BILLING = /(credit|balance|allowance|top ?up|payment|billing|quota|insufficient funds)/i;

/**
 * Classify ONE probe of one free row.
 *
 * @param {object} r `{ok, status, message}` from a real Claude-Code-sized request
 * @returns {string} a key of VERDICTS
 */
export function verdictOf(r) {
  if (!r || typeof r !== "object") return "unknown";
  if (r.ok) return "ok";
  const msg = String(r.message ?? "");
  const status = Number(r.status);
  // 429 IS CHECKED BEFORE THE SIZE REGEX, and that order is a bug fix rather
  // than a preference. Rate-limit messages routinely quote a token allowance --
  // "maximum tokens per minute" -- which matches SIZE_REFUSAL, so testing the
  // text first read a rate limit as a permanent cap. MEASURED 2026-09-09:
  // `mistral/labs-devstral-small-2512` returned 429 and was classified
  // `unusable`, and the bisect then contradicted it by finding no cap at all.
  if (status === 429) return "rate";
  // Order matters below too. A 402 whose text also mentions "prompt" is still a
  // billing refusal, and a size refusal arriving as 400 must not be read as
  // `locked` just because 400 is the status `locked` usually carries.
  if (SIZE_REFUSAL.test(msg)) return "unusable";
  if (status === 402 || BILLING.test(msg)) return "unpaid";
  if (status >= 500) return "upstream";
  if (status === 401 || status === 403 || status === 404 || status === 400) return "locked";
  return "locked";
}

/**
 * Fold a provider's free rows into ONE cell.
 *
 * `var` IS THE POINT OF THIS FUNCTION. A provider whose free rows disagree has no
 * single honest value -- MEASURED 2026-09-09, opencode's 22 free rows split four
 * ways (13 unsupported, 4 client-locked, 2 server errors, 1 unavailable), and any
 * one of those printed at provider level would misdescribe the other 21. `var`
 * says "open it", which is the only true thing a single cell can say.
 *
 * @param {string[]} verdicts one per probed free row
 * @returns {string} a key of VERDICTS, or "var"
 */
export function aggregate(verdicts) {
  const seen = (verdicts ?? []).filter((v) => v && v !== "none");
  if (seen.length === 0) return "none";
  const known = seen.filter((v) => v !== "unknown");
  if (known.length === 0) return "unknown";
  return new Set(known).size === 1 ? known[0] : "var";
}

/** Bytes as a cell: `100KB`, `1.2MB`. Never wider than 6. */
export function sizeCell(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const kb = bytes / 1024;
  if (kb < 1000) return `${Math.round(kb)}KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)}MB`;
}

/**
 * The cell text and colour for a row or a provider.
 *
 * A measured size wins over the verdict's own word, because `100KB` tells the
 * user both that it refuses AND how far from usable it is, where `unusable`
 * tells them only the first. Colour still comes from the verdict.
 */
/**
 * Which band a measured cap falls in. THREE, not two, and the middle one is the
 * reason this function exists.
 *
 * MEASURED 2026-09-09: orcarouter's free tier caps at 245KB. That is ABOVE
 * `CC_MIN_BYTES`, so a two-band rule painted it green -- while being the exact
 * row that failed in real use, because a real session sends 400KB. A cap between
 * the floor and a working session's size means the first message or two succeed
 * and the conversation then dies, which is neither "fine" nor "never works".
 */
export function capBand(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "unknown";
  if (bytes < CC_MIN_BYTES) return "never";     // below Claude Code's floor
  if (bytes < CC_TYPICAL_BYTES) return "short"; // works briefly, dies as it grows
  return "fits";
}
const BAND_COLOUR = { never: "red", short: "yel", fits: "grn", unknown: "" };

export function limitCell(entry) {
  if (!entry) return { text: VERDICTS.unknown.cell, colour: "" };
  if (entry.verdict === "var") return { text: "var", colour: "yel" };
  const v = VERDICTS[entry.verdict];
  if (!v) return { text: VERDICTS.unknown.cell, colour: "" };
  const size = sizeCell(entry.bytes);
  // A measured size wins over the verdict's own word -- `245KB` says both that
  // it refuses AND how far from usable it is -- and it carries the BAND's
  // colour rather than the verdict's, since the number is what the colour is
  // now about.
  if (size) return { text: size, colour: BAND_COLOUR[capBand(entry.bytes)] };
  return { text: v.cell || "", colour: v.colour };
}

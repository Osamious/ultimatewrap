// The `?` screen's content, separate from `style.mjs` so that the REDUCER can
// know how many lines it holds without importing the renderer.
//
// `pick-state.mjs` needs the line count to clamp the scroll offset; `style.mjs`
// needs the lines themselves. If this content lived in `style.mjs`, the reducer
// would have to import the renderer to scroll it -- so the glyph renderers are
// passed IN as arguments and this module imports nothing at all. No cycle can
// form, in either direction.
//
// THE GLYPH ROWS RENDER THROUGH THE SAME FUNCTIONS THE ROWS DO. `provenanceDot`
// and `healthDot` are handed in rather than reimplemented here, so a legend
// entry cannot drift from what the picker actually paints. A legend that
// transcribed `◆` as a literal would be wrong on every ASCII terminal (where the
// rung is `#`) and would go stale the day a glyph changes -- which is exactly
// the failure a reference screen exists to prevent.

// The key binds. Unchanged in content from the pre-glossary legend: this is the
// ONLY complete list of keys, which is why the footer reads "all keys" and
// points here rather than trying to carry them itself.
const KEYS = [
  "up / down      move the cursor (wraps at either end)",
  "a-z 0-9 etc    type to filter; the filter is per level",
  "backspace      delete one character from the filter",
  "enter          open a provider, or select a model",
  "tab            toggle flat provider/model search",
  "ctrl+f         add or remove a favourite",
  "ctrl+r         show withheld models for this provider",
  "esc            clear the filter, then go back, then quit",
  "ctrl+c         quit without changing the chat input",
  "?              this screen; up/down scrolls it",
];

/**
 * Every line of the `?` screen, in order, already coloured.
 *
 * @param {object} g     the active glyph set, from `glyphsFor(caps)`
 * @param {object} p     the active painter, from `painter(caps)`
 * @param {object} r     renderers borrowed from style.mjs
 * @param {Function} r.provenanceDot  (rung, g, p) -> one column
 * @param {Function} r.healthDot      (health, g, p) -> one column
 * @returns {string[]}
 */
export function legendLines(g, p, { provenanceDot, healthDot }) {
  const rung = (name) => provenanceDot(name, g, p);
  const health = (name) => healthDot(name, g, p);
  const L = [];

  L.push(p.bold("KEYS"));
  for (const k of KEYS) L.push("  " + k);

  L.push("");
  L.push(p.bold("READING A MODEL ROW"));

  L.push(p.dim("  gutter -- where this row's facts came from"));
  // Ordered top rung first, exactly as PROVENANCE_RUNGS names them, so the
  // column reads as the confidence ladder it is rather than four unrelated marks.
  L.push(`    ${rung("call-verified")}  call-verified     the model answered a real request`);
  L.push(`    ${rung("config-asserted")}  config-asserted   named in your own config, never probed`);
  L.push(`    ${rung("listing-verified")}  listing-verified  the provider's own listing named it`);
  L.push(`    ${rung("catalogue-only")}  catalogue-only    only the offline catalogue names it`);
  // `null` renders a blank column by design, so the entry has to say so in
  // words: an empty gutter with an empty explanation beside it teaches nothing.
  L.push(`    ${rung(null)}  (blank)           nobody looked; no provenance recorded`);

  L.push("");
  L.push(p.dim("  badge -- what the model costs"));
  L.push("    FREE     zero token price and a recurring grant");
  L.push("    FREE?    zero price, or a provider-published ':free' name");
  L.push("    PLAN     covered by a subscription you already pay for");
  L.push("    PAID     a non-zero token price");
  L.push("    (blank)  no price evidence we are willing to stand behind");

  L.push("");
  L.push(p.dim("  other cells"));
  L.push("    TVR      tools / vision / reasoning");
  L.push("             a letter means yes, '-' means no, '?' means unknown");
  L.push("    ctx      context window; 'nochat' means it emits no text");
  L.push(`    ${g.dashMatch}        your filter matched inside the elided middle of an id`);

  L.push("");
  L.push(p.dim("  a dimmed row means one of two different things"));
  // The user's own question, and the distinction is worth the two lines: one
  // dim is a hard block, the other is a soft staleness warning, and the row
  // gives no other clue which it is.
  L.push("    not a chat model  it emits image/audio/video; cannot be selected");
  L.push("    not listed now    the gateway did not list it when this snapshot");
  L.push("                      was built; it may still work -- try it");

  L.push("");
  L.push(p.bold("FREE-TIER LIMIT  (the 'limit' column)"));
  L.push(p.dim("  shown only when the terminal is wide enough to reserve it"));
  L.push("    ok       accepts a real Claude Code request");
  // A SIZE, not one of a fixed pair. `64KB`, `250KB` and `1.0MB` are all cells
  // this column renders; the number is whatever that provider was measured to
  // allow. Only the 153KB comparison point is fixed.
  L.push("    <size>   the free tier caps a single request at that size,");
  L.push("             and the colour says what that means for a session:");
  L.push("               RED    under 153KB -- below the smallest request");
  L.push("                      Claude Code can send, so it can never work,");
  L.push("                      whichever MCP servers you turn off");
  L.push("               YELLOW 153KB to 400KB -- the first message or two");
  L.push("                      succeed, then the conversation outgrows the");
  L.push("                      cap and every later turn fails");
  L.push("               GREEN  over 400KB -- a real session fits");
  L.push("    locked   refuses for a reason that is not size: the model is");
  L.push("             unsupported, or the free tier is vendor-client only");
  L.push("    unpaid   free allowance or credits are spent -- top up and retry");
  L.push("    rate     rate limited right now; try again shortly");
  L.push("    5xx      the provider errored; not your account");
  L.push("    var      this provider's free rows DISAGREE -- open it and read");
  L.push("             the per-model column, which is the source of truth");
  L.push("    (blank)  no free rows here; the free-tier rule does not apply");
  L.push("    ?        not probed yet");
  // The colour rule is worth stating outright, because it is what makes the
  // column scannable: red is "do not bother", yellow is "try later".
  L.push(p.dim("  red = it will not work; yellow = it may work later; green = it works"));

  L.push("");
  L.push(p.bold("PROVIDER HEALTH"));
  L.push(`  ${health("ok")}  ok        no breakage recorded`);
  L.push(`  ${health("needs $")}  needs $   the account needs a balance before it answers`);
  L.push(`  ${health("broken")}  broken    breakage recorded in the provider's notes`);
  L.push(`  ${health(null)}  (unknown) no health recorded for this provider`);

  return L;
}

// The line count, for the reducer's scroll clamp.
//
// DERIVED, never transcribed. A hand-written constant is one edit away from
// disagreeing with the content, and the symptom -- a legend that scrolls one
// line too far, or stops one line short -- is subtle enough to ship. The stubs
// only have to return ONE COLUMN each; the count does not depend on which glyph
// or colour the real renderers would produce.
const ID = (s) => s;
const STUB_P = new Proxy({}, { get: () => ID });
export const LEGEND_LENGTH = legendLines(
  { dashMatch: "!" },
  STUB_P,
  { provenanceDot: () => "#", healthDot: () => "*" },
).length;

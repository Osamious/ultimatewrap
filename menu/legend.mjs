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
// is handed in rather than reimplemented here, so a legend
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
  "ctrl+o         ok-only filter on model lists (last benchmark ok)",
  "ctrl+l         1M+ filter on model lists (ctx >= 1M or a [1m] tag)",
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
 * @returns {string[]}
 */
export function legendLines(g, p, { provenanceDot }) {
  const rung = (name) => provenanceDot(name, g, p);
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
  L.push("    (blank)  no price evidence we are willing to stand behind; also a");
  L.push("             FREE? route whose last probe (under 14 days old) said");
  L.push("             payment is required (the snapshot notes 'probe: payment");
  L.push("             required'); refreshed when the snapshot is rebuilt");

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
  L.push(p.bold("MODALITY  (what the model outputs)"));
  L.push(p.dim("  the primary OUTPUT of the route, decided when the snapshot was built"));
  L.push(p.dim("  from the best evidence; unknown stays '?', it is never guessed"));
  L.push("    chat     text out: a language model (dim)");
  L.push("    chat?    answered a chat test with text, nothing else known;");
  L.push("             could also do more (dim)");
  L.push("    image    makes images         audio    speech or music out");
  L.push("    video    makes video          embed    vectors, not text");
  L.push("    rank     scores documents     mod      moderation verdicts");
  L.push("    stt      speech to text       ocr      reads documents");
  L.push("    live     realtime voice model (a streaming API)");
  L.push("    other    known NOT to be a chat model, kind not known");
  L.push("    ?        no evidence: nothing says what it outputs");
  L.push(p.dim("  every word but chat, chat? and ? is drawn in colour, so the rows"));
  L.push(p.dim("  that are not chat models stand out. A failed test (\"not a chat"));
  L.push(p.dim("  model\") is never used to name a modality; nothing comes from the id"));
  L.push("");
  L.push(p.bold("PROVIDER LIST  (the sweep columns)"));
  L.push(p.dim("  read from the last benchmark sweep, when the snapshot was built"));
  L.push("    models   how many models the provider lists");
  L.push("    status   alive: at least one model answered at all (an ok, an");
  L.push("             empty reply, a refusal for payment, key or model, or a");
  L.push("             provider error all count: something answered). dead: every");
  L.push("             probe in the last 14 days got NO response at all: a");
  L.push("             timeout with nothing back, or a connection failure.");
  L.push("             (blank): nothing benched recently, so no verdict");
  L.push("    ok       COUNT (PCT%): models that answered ok, and their share");
  L.push("             of the provider's models (<1% for a small non-zero");
  L.push("             count; '-' for none; blank when there is no bench data)");
  L.push("    free     COUNT (PCT%): models with a zero price and a recurring");
  L.push("             grant; shown only from a 91-column terminal");
  L.push(p.dim("  then one count per benchmark status: how many of a provider's"));
  L.push(p.dim("  models had that result on their latest probe, within 14 days"));
  L.push("    empt     no text came back   auth   key refused");
  L.push("    pay      needs balance       rate   rate limited");
  L.push("    gone     not found upstream  t/o    too slow");
  L.push("    err      provider or network error");
  L.push("    -        none of this provider's models had that status");
  L.push("    (blank)  this provider has no benchmark data at all");
  L.push("    2k       thousands, so a cell never widens");
  L.push("    a model that was never benched, or not within 14 days, is in NO");
  L.push("    column, so the counts can add up to less than 'models'");
  L.push(p.bold("  PINNED ROWS"));
  L.push("    favourites (*) and recent picks sit ABOVE the column header,");
  L.push("    closed by a thin rule; the cursor starts on the first of them");
  L.push(p.dim("  columns (here and on model lists) are separated by dim vertical"));
  L.push(p.dim("  rules; they are ':' on ASCII terminals"));
  L.push(p.dim("  key ids are drawn without the bucket segment nearly every row"));
  L.push(p.dim("  shares (the title names it, e.g. personal.); a row in another"));
  L.push(p.dim("  bucket keeps its full id, and filtering still matches all of it"));
  L.push(p.dim("  the key id column is as wide as the longest id as drawn (up to"));
  L.push(p.dim("  30), and clipped on narrow terminals (16 characters at 80"));
  L.push(p.dim("  columns); the frame follows the terminal up to 260 columns"));
  L.push(p.dim("  every figure and row on this LIST is BAKED into the snapshot (the"));
  L.push(p.dim("  'bench MM-DD' on the id: line is its date); model lists read"));
  L.push(p.dim("  bench.json LIVE, so the two can differ after a new sweep. To"));
  L.push(p.dim("  refresh this list: node menu/snapshot.mjs --build"));

  L.push("");
  L.push(p.bold("HEADER, ID LINE AND REPLY LINE"));
  L.push("    header   counts only, right-aligned: 'N of M | K ok (P%)' on a");
  L.push("             model list, 'N of M models | K ok (P%)' in flat scope,");
  L.push("             'P providers | M models | K ok (P%)' on the provider list");
  L.push("    N of M   models matching the filters, of the provider's models");
  L.push("    K ok     models whose last benchmark (within 14 days) was ok:");
  L.push("             all of them, whatever the filters say; '- ok' when");
  L.push("             nothing was benched (no bench file, or none fresh for");
  L.push("             this provider), never '0 ok'. Model lists count it LIVE;");
  L.push("             on the provider list it is BAKED at snapshot build");
  L.push("    [ok]     ctrl+o is on: only models whose last benchmark was ok");
  L.push("    [1M+]    ctrl+l is on: only models with ctx >= 1M or a [1m] tag");
  L.push("    id:      the FULL id of the selected row (what enter or ctrl+f");
  L.push("             acts on), never elided; on the provider list it includes");
  L.push("             the omitted bucket, then 'N plan' when the provider has");
  L.push("             plan-covered models. Blank when the row cannot be");
  L.push("             selected. The data dates sit at its right end: 'routable'");
  L.push("             / 'benched' / 'discovered', whole or dropped, never cut");
  L.push("    reply:   model lists: the FULL stored reply of the selected row");
  L.push("             (or why it was skipped), clipped only at the frame edge;");
  L.push("             '~' marks reasoning text. Blank for an unbenched row");
  L.push("    = id (works)  in the output cell of a 'gone' route: a sibling of");
  L.push("             the same provider (another spelling, ':free', ':thinking',");
  L.push("             '@eu'/'@us', an org prefix) that answered ok. It only says");
  L.push("             where; enter still selects the row you are on. The id:");
  L.push("             line shows '  = id' too when it fits");
  L.push(p.dim("  a long id is elided keeping the part that differs between rows"));
  L.push(p.dim("  (versions, suffixes); wide, emoji and combining characters draw"));
  L.push(p.dim("  as '?', in every column"));
  L.push(p.dim("  header times are UTC (a trailing Z); a row's measured cells draw"));
  L.push(p.dim("  only if its record is under 14 days old"));
  L.push(p.dim("  the two filters combine with each other and with typed text,"));
  L.push(p.dim("  apply to model lists only, and stay on when you go back or"));
  L.push(p.dim("  open another provider"));

  L.push(p.bold("BENCH COLUMNS  (model lists, next to the catalogue columns)"));
  L.push(p.dim("  one real request per model, sent through the gateway"));
  L.push("    stat     what the probe got back (below)");
  L.push("    ttft     request sent -> first streamed token");
  L.push("    total    request sent -> stream closed");
  L.push("    tok/s    output tokens per second of generation, as reported");
  L.push("             by the provider; '-' when too short to measure");
  L.push("             '~56' is an estimate: the probe CUT the stream of a model");
  L.push("             that ignored its token limit, so total is left blank and");
  L.push("             the reply: line starts '[cut]'. '[stream error]' there");
  L.push("             means the stream failed after the first token");
  L.push("    output   first words of the reply; '~' marks reasoning text");
  L.push("             shown because no answer text arrived");
  L.push("    (blank)  this model has not been benched -- blank, not zero");
  L.push(p.dim("  every column shows when the terminal is wide enough; on a narrower"));
  L.push(p.dim("  one they drop in this order: output, tok/s, total"));
  L.push(p.dim("  status"));
  L.push("    ok       answered     empt   no text came back (often: the");
  L.push("                                 96-token budget went on thinking)");
  L.push("    auth     key refused  pay    needs balance or credits");
  L.push("    rate     rate limited gone   model not found upstream");
  L.push("    t/o      too slow     err    provider or network error");
  L.push("    skip     not probed; the output column says why");
  L.push(p.dim("  the probe is a bare chat message with NO tools and 96 output"));
  L.push(p.dim("  tokens. A model can pass it and still fail a real Claude Code"));
  L.push(p.dim("  session (tool schemas, large prompts). One sample, taken under"));
  L.push(p.dim("  sweep load: read it as a ranking, not a benchmark."));
  L.push(p.dim("  refresh with: node refresh/bench-cli.mjs --live"));

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
  { provenanceDot: () => "#" },
).length;

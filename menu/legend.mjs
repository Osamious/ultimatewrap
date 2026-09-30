// The `?` screen's content, separate from `style.mjs` so that the REDUCER can
// know how many lines it holds without importing the renderer.
//
// `pick-state.mjs` needs the line count to clamp the scroll offset; `style.mjs`
// needs the lines themselves. If this content lived in `style.mjs`, the reducer
// would have to import the renderer to scroll it -- so the glyph renderers are
// passed IN as arguments and this module imports nothing at all. No cycle can
// form, in either direction.
//
// THE GLYPH ROWS RENDER THROUGH THE SAME FUNCTIONS THE ROWS DO. `provenanceDot`,
// `modality` and `stat` are handed in rather than reimplemented here, so a legend
// entry cannot drift from what the picker actually paints (a `◆` transcribed as a
// literal would be wrong on every ASCII terminal, and a colour copied here would go
// stale the day the table changes).
//
// LAYOUT. Five sections, one blank line between them, each opened by a heading rule
// drawn from the glyph table: KEYS, PROVIDER LIST, MODEL LIST, STAMPS, PROBES. Inside a
// section every entry is `term  meaning` in two aligned columns; the term is drawn in
// the colour it has in the picker, and a meaning that needs more than one line wraps
// under itself (a hanging indent). Every line is at most LINE_MAX columns, which fits
// the narrowest frame (78, minus the frame's own two-column indent).

/** The widest a legend line may be: 78 columns of frame, minus the 3 the frame draws and the 2 of indent. */
export const LINE_MAX = 72;
const TERM_W = 11;                      // the term column: `discovered` is the longest term, plus a gap
const TEXT_W = LINE_MAX - 2 - TERM_W;   // the meaning column, after the 2-space indent

// The key binds. This is the ONLY complete list of keys, which is why the footer
// reads "all keys" and points here rather than trying to carry them itself.
const KEYS = [
  ["up/down", "move the cursor (wraps at either end)"],
  ["a-z 0-9", "type to filter; the filter is per level"],
  ["backspace", "delete one character from the filter"],
  ["enter", "open a provider, or select a model"],
  ["tab", "toggle flat provider/model search"],
  ["ctrl+f", "add or remove a favourite"],
  ["ctrl+o", "ok-only filter on model lists (last benchmark ok)"],
  ["ctrl+l", "1M+ filter on model lists (ctx >= 1M or a [1m] tag)"],
  ["ctrl+x", "toggle [no gone]: on model lists it hides routes marked gone; on either level it makes the % = ok / (models - gone) instead of ok / models (off by default)"],
  ["ctrl+e", "toggle [free]: on model lists show only models badged FREE or FREE?"],
  ["ctrl+r", "show withheld models for this provider"],
  ["esc", "clear the filter, then go back, then quit"],
  ["ctrl+c", "quit without changing the chat input"],
  ["?", "this screen; up/down scrolls it"],
];

// Greedy word wrap at `width` code points (the text here is plain ASCII).
function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(" ")) {
    if (line && line.length + 1 + word.length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/**
 * Every line of the `?` screen, in order, already coloured.
 *
 * @param {object} g     the active glyph set, from `glyphsFor(caps)`
 * @param {object} p     the active painter, from `painter(caps)`
 * @param {object} r     renderers borrowed from style.mjs
 * @param {Function} r.provenanceDot  (rung, g, p) -> one column
 * @param {Function} [r.modality]     (word) -> the modality word in its colour (unpadded)
 * @param {Function} [r.stat]         (code) -> a probe-status code in its tone colour (unpadded)
 * @param {Function} [r.age]          (tone, text) -> an `oldest probe` age band in its colour; tone is grn, yel, ora or red
 * @returns {string[]}
 */
export function legendLines(g, p, { provenanceDot, modality = (w) => w, stat = (c) => c, age = (tone, text) => text }) {
  const rung = (name) => provenanceDot(name, g, p);
  const h = g.frame?.h ?? "-";
  const L = [];

  const heading = (name) => {
    L.push(p.bold(`${h}${h} ${name} `) + p.dim(h.repeat(Math.max(2, LINE_MAX - 2 - 4 - name.length))));
  };
  // One entry: the term (already coloured, `plain` is its visible text for padding), then the meaning wrapped
  // in the second column with a hanging indent.
  const entry = (plain, shown, text, tw = TERM_W) => {
    const lines = wrap(text, LINE_MAX - 2 - tw);
    // A term wider than the term column stands on its own line, and its meaning hangs beneath it.
    if (plain.length >= tw) { L.push("  " + shown); lines.forEach((ln) => L.push("  " + " ".repeat(tw) + ln)); return; }
    const lead = shown + " ".repeat(tw - plain.length);
    lines.forEach((ln, i) => L.push("  " + (i === 0 ? lead : " ".repeat(tw)) + ln));
  };
  const plainEntry = (term, text) => entry(term, term, text);
  const note = (text) => wrap(text, LINE_MAX - 2).forEach((ln) => L.push("  " + p.dim(ln)));
  const gap = () => L.push("");

  // ------------------------------------------------------------------ 1. KEYS
  heading("KEYS");
  for (const [k, text] of KEYS) plainEntry(k, text);

  // ------------------------------------------------------------ 2. PROVIDER LIST
  gap();
  heading("PROVIDER LIST");
  note("Read from the last benchmark sweep, baked into the snapshot (the date is on the id: line). A --live sweep rebuilds it itself. After --reclassify-notices, --redact, --compact or a skipped rebuild, run: node menu/snapshot.mjs --build");
  entry("key id", "key id", "the key's FULL id, bucket included (e.g. personal.openrouter.free), sized to the longest id. Only on a narrow terminal is it elided, with a marker (" + (g.elide ?? "~") + "), keeping the part that differs.");
  entry("status", "status", "over each model's latest probe (however old):");
  // The three states get their own aligned sub-list.
  const state = (word, painted, text) => {
    const lines = wrap(text, LINE_MAX - 2 - TERM_W - 7);
    lines.forEach((ln, i) => L.push("  " + " ".repeat(TERM_W) + (i === 0 ? painted + " ".repeat(7 - word.length) : " ".repeat(7)) + ln));
  };
  state("alive", p.grn("alive"), "at least one model answered ok");
  state("down", p.yel("down"), "answered, but nothing works: only refusals (key, payment, model, rate), empty replies, provider errors, or a timeout that got a first token");
  state("dead", p.red("dead"), "NO response at all: timeouts with nothing back, or connection failures");
  state("blank", "blank", "no probe record for this provider, so no verdict");
  entry("oldest probe", "oldest probe", "age of the provider's oldest probe result; green under 2d, yellow under 4d, orange under 7d, red 7d or older");
  L.push("  " + " ".repeat(TERM_W) + age("grn", "45m 5h") + "  " + age("yel", "2d 3d") + "  " + age("ora", "4d 6d") + "  " + age("red", "7d 12d 40d"));
  note("It is the OLDEST probe, not the latest: one stale model makes the provider read old, and a fresh one hides nothing. '-' the provider has no probe result, blank no bench data. Shown only on a wide terminal, after the whole key id.");
  entry("models", "models", "how many models the provider lists; N/M means N listed and M withheld (ctrl+r shows them)");
  entry("header", "header", "'P providers, M models, K ok (P%)': while [no gone] is on the header M excludes gone routes and the % is ok / M; the models column always counts all, so M can be less than the sum of the visible cells");
  entry("ok", p.grn("ok"), "models that answered ok on their latest probe. '(n live)' in the header: n = oks that came from real use (the live feed) and are not yet confirmed by a probe; shown only when n is above 0");
  entry("free", p.blu("free"), "models badged FREE or FREE? when the catalogue was read, and their share of ALL models (never changed by [no gone]); blank when the provider has no price data. Shown only when the terminal is wide enough (after oldest probe). The [free] filter uses the badge as drawn, so a FREE? row whose fresh probe said payment is required does not match");
  entry("%", "%", "the share beside ok and free. Beside ok: % = ok / models normally; % = ok / (models - gone) while [no gone] is on (ctrl+x, works here too; it hides no provider). Beside free: always of all models. '<1%' for a small non-zero count; '100%' only when every one. Coloured by band, as a hint:");
  L.push("  " + " ".repeat(TERM_W) + p.grn("70% and up") + "   " + p.yel("30% to 69%") + "   " + p.red("under 30%") + "   " + p.dim("- none"));
  L.push("  " + "counts".padEnd(TERM_W) + stat("empt") + " " + stat("auth") + " " + stat("pay") + " " + stat("rate") + " " + stat("gone") + " " + stat("t/o") + " " + stat("err"));
  L.push("  " + " ".repeat(TERM_W) + "one per probe result (defined under PROBES)");
  note("Each raw count is how many models had that result on their latest probe. '-' none, '2k' thousands, blank no bench data. Models never benched are in no count, so counts can add up to less than 'models'.");
  note("The id: line under the list names the selected provider's full id and, when some of its models are covered by a subscription plan, ends with '  N plan' (how many).");
  note("Favourites (*) and recents sit above the column header, closed by a thin rule.");

  // -------------------------------------------------------------- 3. MODEL LIST
  gap();
  heading("MODEL LIST");
  note("Read live from bench.json, so it can differ from the provider list after a new sweep.");
  plainEntry("gutter", "where the row's facts came from (first column):");
  const gut = (name, label, text) => L.push("  " + " ".repeat(TERM_W) + rung(name) + " " + label + " ".repeat(Math.max(1, 17 - label.length)) + text);
  gut("call-verified", "call-verified", "answered a real request");
  gut("config-asserted", "config-asserted", "named in your own config");
  gut("listing-verified", "listing-verified", "the provider's listing named it");
  gut("catalogue-only", "catalogue-only", "only the offline catalogue");
  gut(null, "(blank)", "nobody looked");
  entry("model", "model", "the model id, sized to the longest id; a longer one is elided in the middle, keeping the part that differs");
  entry("provider/model", "provider/model", "in flat search (tab) the first column reads provider/model: the full target, what enter selects");
  entry("stat", "stat", "what the last probe got back (see PROBES); blank = not benched. UPPERCASE (OK, RATE, PAY, AUTH, GONE, ERR, T/O, EMPT) = seen in REAL use after the last probe (live); lowercase = measured by a probe, or a live result a confirmation probe then verified");
  entry("probed", "probed", "age of this model's own probe record, from its timestamp: how long ago stat, ttft and the rest of the row were measured. Same colour bands as oldest probe: green under 2d, yellow under 4d, orange under 7d, red 7d or older. Blank = never probed, or the record has no usable stamp (a skipped row has none). A live (UPPERCASE) row shows the age of its live observation. Sits right after stat on a wide terminal (from 97-99 columns depending on id length); output shrinks first to make room, and while it is under 8 columns wide it leaves the = alias hint and skipped text blank.");
  L.push("  " + " ".repeat(TERM_W) + age("grn", "<1m 5h") + "  " + age("yel", "2d 3d") + "  " + age("ora", "4d 6d") + "  " + age("red", "7d 40d"));
  entry("ttft", "ttft", "request sent to first streamed token");
  entry("total", "total", "request sent to stream closed; blank for a cut stream");
  entry("tok/s", "tok/s", "output tokens per second as the provider reports; '-' when too short to measure; '~56' is an estimate for a cut stream");
  entry("ctx", "ctx", "context window; 'nochat' means the route emits no text");
  entry("$in $out", "$in $out", "price per million tokens, in and out");
  entry("badge", "badge", "FREE zero price and a recurring grant; FREE? zero price or a ':free' name; PLAN covered by a subscription; PAID a non-zero price; blank no price evidence (also a FREE? whose fresh probe said payment is required)");
  entry("modality", "modality", "what the route outputs, decided when the snapshot was built from the best evidence. Unknown stays '?', never guessed:");
  const mod = (w, text) => L.push("  " + " ".repeat(TERM_W) + modality(w) + " ".repeat(Math.max(1, 6 - w.length)) + text);
  mod("chat", "text out: a language model");
  mod("chat?", "answered a chat test with text; nothing else known");
  mod("image", "makes images");
  mod("audio", "speech or music out");
  mod("video", "makes video");
  mod("embed", "vectors, not text");
  mod("rank", "scores documents");
  mod("mod", "moderation verdicts");
  mod("stt", "speech to text");
  mod("ocr", "reads documents");
  mod("live", "realtime voice model (a streaming API)");
  mod("other", "known NOT to be a chat model, kind not known");
  L.push("  " + " ".repeat(TERM_W) + "?     no evidence: nothing says what it outputs");
  note("Each word is drawn in its own colour; a failed test ('not a chat model') and the id are never used to name a modality.");
  entry("TVR", "TVR", "tools, vision, reasoning: a letter is yes, '-' no, '?' unknown");
  entry("output", "output", "first words of the reply; '~' marks reasoning shown because no answer text arrived; '= id (works)' on a 'gone' route names a sibling that answered ok (enter still selects THIS row)");
  entry("N of M", "N of M", "models matching the filters, of the provider's models (M stays the full count, so rows hidden by [no gone] show as N < M); then 'K ok (P%)': how many answered ok, with P = ok / models normally and ok / (models - gone) while [no gone] is on ('- ok' when nothing was benched, never '0 ok'). The provider list header uses the same rule");
  entry("[ok]", "[ok]", "the ctrl+o filter is on: only models whose last probe was ok");
  entry("[1M+]", "[1M+]", "the ctrl+l filter is on: only ctx >= 1M or a [1m] tag");
  entry("[no gone]", "[no gone]", "ctrl+x is on (off by default): gone routes are hidden on model lists and the % figures leave them out; the chip shows on both levels");
  entry("[free]", "[free]", "the ctrl+e filter is on: only models badged FREE or FREE? as drawn");
  entry("id:", "id:", "the FULL id of the selected row (what enter or ctrl+f acts on), then the data dates: routable, benched, discovered");
  entry("reply:", "reply:", "the whole stored reply of the selected row; '[cut]' the probe stopped a stream that ignored its token limit; '[stream error]' it failed after the first token");
  entry("[live]", "[live]", "reply: lead for a live record: '[live 14:32Z] answered HTTP 200 in 1.2 s; no reply text is kept for real requests' (UTC), '... worked live; confirming...' for up to 2 minutes while the confirmation probe runs, or the provider's own sentence for a failure");
  entry("[live+probe]", "[live+probe]", "reply: lead once a confirmation probe has verified the live result: the reply is the probe's own, stat is lowercase again");
  note("A dimmed row is one of two things: 'not a chat model' (cannot be selected) or 'not listed now' (the gateway did not list it at snapshot time; it may still work).");
  note("Columns drop as the terminal narrows: output first, then probed, then tok/s, then total. All show from 103 columns. The frame is never narrower than 78 (an 80-column terminal is the minimum).");
  note("A long id is elided keeping the part that differs; wide and emoji characters draw as '?'. A filter that matched inside the elided middle shows " + g.dashMatch + ".");

  // ----------------------------------------------------------------- 4. STAMPS
  const dash = g.dash ?? "-";
  gap();
  heading("STAMPS");
  note("Dates at the right end of the selected row's id: line, dim, UTC (MM-DD HH:MMZ), each whole or dropped when there is no room. A dash after the word means never.");
  entry("routable", "routable", "provider list: when the snapshot last asked the gateway which routes it can serve. Rows it says it cannot serve are dimmed; 'routable " + dash + "' means never resolved, so nothing is dimmed (undimmed = routable OR nobody checked).");
  entry("bench", "bench", "provider list: when the probes behind the status, ok, % and empt..err counts were taken (baked in at snapshot build).");
  entry("benched", "benched", "model list: when the probe records behind the row cells (stat, ttft, total, tok/s, reply:) were written, read live from bench.json. 'benched " + dash + " run bench-cli --live' means no probe data yet; an old record is still drawn (see outdated below).");
  entry("discovered", "discovered", "model list: when the providers' own model listings were last fetched; 'discovered " + dash + "' (never) explains a blank provenance gutter.");

  entry("live", "live", "'live 14:32Z' (UTC) on the id: line: the newest live record merged into what is drawn. Absent when the live feed has nothing to add or is switched off. Live results never refresh oldest probe, probed ages or the outdated line.");
  entry("feed note", "feed note", "a dim yellow line above the footer (the outdated line takes its place when both apply): 'live feed unavailable (schema changed)', '(no router data)', 'key mapping changed', or 'locked, showing the last update HH:MMZ'. It only says the live feed is not trustworthy; probes are unaffected.");
  entry("outdated", p.yel("outdated"), "a yellow line just above the footer, on both lists: 'Model Status might be outdated! Last time the list was fully updated was DATE, run node refresh/bench-cli.mjs --live to update your list fully' (a --live sweep also rebuilds the snapshot, so both lists update). It shows when MORE than half of the probe records are more than 7 days old (the sweep's own re-probe age); DATE is the OLDEST record, i.e. when the list was last fully updated. Old records stay visible and are never hidden or dimmed: this line and the oldest probe column show how old the data is. On a narrow terminal the words shorten but the command stays whole. With no probe data at all there is no such line (see benched).");

  // ------------------------------------------------------------------ 5. PROBES
  gap();
  heading("PROBES");
  note("One real request per model through the gateway; refresh with: node refresh/bench-cli.mjs --live. Results are never hidden for being old; the oldest probe column and the yellow outdated line show how old they are.");
  entry("ok", stat("ok"), "answered");
  entry("empt", stat("empt"), "no text came back (often the 96-token budget went on thinking)");
  entry("auth", stat("auth"), "key refused");
  entry("pay", stat("pay"), "needs balance or credits");
  entry("rate", stat("rate"), "rate limited");
  entry("gone", stat("gone"), "model not found upstream");
  entry("t/o", stat("t/o"), "too slow (timed out)");
  entry("err", stat("err"), "provider or network error");
  note("LIVE FEED: on open a one-shot background job reads the router's own usage log and records real successes (200) and failures (429 rate, 402 pay, 401/403 auth, 404 gone; a 5xx only after two 2+ minutes apart with no 200 between). When a failing model answers again, ONE tiny confirmation probe (5 words) may run, never for the Anthropic subscription route. No reply text of real use is ever stored.");
  note("Switch it off and on: create or delete the file state/observe.off. Or: node refresh/observe-cli.mjs --status, --off, --on, --reset (deletes every live record, the feed position AND the confirmation spend caps: observed.json and observed.run).");
  note("The probe is a bare chat message with NO tools and 96 output tokens. A model can pass it and still fail a real Claude Code session (tool schemas, large prompts). It is one sample, taken under sweep load: read it as a ranking, not a benchmark.");

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

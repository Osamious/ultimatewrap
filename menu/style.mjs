// Everything the picker looks like.
//
// One module owns colour, glyph and motion so the whole surface can be retuned in
// one place, and so that every other file can be checked for escape sequences by
// grep. sanitizeDisplay runs on provider strings BEFORE anything here adds our own
// escapes (Q7.6) -- the order matters, because sanitising afterwards would strip
// our styling as eagerly as it strips theirs.
//
// On motion: the input loop is a blocking readSync with no event loop behind it,
// so a timer-driven animation is not merely discouraged, it cannot run. Every
// transition here is a short synchronous burst drawn immediately after the key
// that caused it, three frames at 30 ms, and the pause is Atomics.wait rather
// than a spin on Date.now() (Q7.2, Q7.3).

import { sanitizeDisplay } from "./sanitize.mjs";
// Content only. `legend.mjs` imports nothing and takes the glyph renderers as
// arguments, so this does not become a cycle even though the legend renders
// through `provenanceDot` and `healthDot` defined in this file.
import { legendLines } from "./legend.mjs";
// The free-tier limit vocabulary. Also import-free, for the same no-cycle reason.
import { limitCell } from "./payload-cap.mjs";

// The floor, and what `FRAME_W` used to be unconditionally. Kept as the minimum
// so no terminal renders narrower than it did before this became elastic: a
// terminal below 78 columns already wrapped every line and corrupted the frame,
// and clamping here leaves that exactly as bad as it was rather than quietly
// changing a second thing in the same commit. Dropping columns by priority is
// what would actually fix it, and it is deliberately NOT in this change.
export const FRAME_MIN = 78;
// The ceiling. Past roughly this width a row becomes physically hard to track
// from the id on the left to the badge on the right -- the eye loses the line --
// so surplus beyond it is left as margin rather than spent on a wider table.
export const FRAME_MAX = 132;

// The old constant, still exported and still 78. It is the BASE geometry every
// fixed cell is measured against, and `test/style.test.mjs` uses it as the
// reference width; `frameWidth(caps)` is what the renderer actually draws to.
export const FRAME_W = FRAME_MIN;
export const FRAME_MS = 30;

// Two columns of the terminal are never drawn into. This is where the original
// 78 came from -- an 80-column terminal minus this margin -- and keeping it is
// what makes `cols: 80` still render exactly 78, so nothing about today's
// default rendering changes. Drawing flush to the last column risks a wrap on
// terminals that treat writing the final cell as advancing the line, and a
// wrapped frame corrupts every row below it.
export const FRAME_MARGIN = 2;

/** The frame width for a terminal, clamped to [FRAME_MIN, FRAME_MAX]. */
export function frameWidth(caps) {
  const cols = Number(caps?.cols);
  if (!Number.isFinite(cols)) return FRAME_MIN;
  return Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.floor(cols) - FRAME_MARGIN));
}

/**
 * The column table for a given frame width.
 *
 * SURPLUS GOES TO THE NAME COLUMNS, not spread across every cell. `id` and
 * `keyId` are the two that elide today -- R16 widened `id` 34 -> 37 for exactly
 * that reason and ran out of room -- while `ctx`, the prices and `badge` hold
 * values of known maximum width that gain nothing from being wider, and would
 * make a row harder to scan by floating its columns around as the terminal
 * changes size.
 *
 * Returned fresh each call rather than memoised: it is a handful of integer
 * additions on a path that already rebuilds every row, and a cache keyed on
 * width is a second source of truth for the geometry.
 */
export const LIMIT_W = 7;

export function layoutFor(frameW) {
  const w = Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.floor(frameW) || FRAME_MIN));
  let surplus = w - FRAME_MIN;

  // THE LIMIT COLUMN IS RESERVED BEFORE `id` TAKES THE REST, and it is the one
  // cell whose PRESENCE depends on width -- at BOTH levels, not just level 1.
  //
  // An earlier draft gave level 0 the column unconditionally, on a reading of
  // "12 spare columns" taken from a rendered ROW. The level-0 HEADER spends more
  // than its rows do, so the column overflowed at the 78-column floor and
  // `clipVisible` truncated the line and appended a reset -- which surfaced as
  // an escape sequence in a `colours: 0` render, not as a width failure. Both
  // levels now share one rule, so the floor renders exactly what it rendered
  // before this column existed.
  //
  // Dropping a column rather than shrinking every other one is deliberate: a
  // `$out` cell that loses a digit is wrong, where an absent column is merely
  // absent -- and the legend says where it went.
  const showLimit = surplus >= LIMIT_W + 1;
  if (showLimit) surplus -= LIMIT_W + 1;

  // Whatever is left goes to the two name cells. Level 0's `keyId` and level 1's
  // `id` are independent cells on different screens, so each takes the whole
  // remainder rather than half of it.
  return { frameW: w, inner: w - 3, showLimit,
           W: { ...W, keyId: W.keyId + surplus, id: W.id + surplus, limit: LIMIT_W } };
}

// INNER is FRAME_W - 3, and the arithmetic is worth writing down because the
// previous draft had it as FRAME_W - 4 and every single line came out at 77
// against a test asserting 78 -- header, rows, empty state and legend alike.
//
//   bar() emits:  V  body-padded-to-INNER  " "  V
//   total      =  1  +      INNER        + 1 + 1  =  INNER + 3
//
// so INNER = FRAME_W - 3 = 75. The `- 4` came from the comment "| " + content +
// " |", which describes a leading "V " that bar() does not actually emit: every
// body supplies its own two-column indent (`"  " + ...` for headers, `${mark} `
// for rows), so the frame character is followed directly by body[0].
const INNER = FRAME_W - 3;

// Constraint 6 and 7 pin these. `bar` is the one addition, six cells at level 0.
// `health` is the width of the health LABEL; the coloured dot and its space sit
// in a two-column gutter to its left and are not part of the 8 (Constraint 6).
// That gutter is why the label gets the full 8 rather than W.health - 2: the
// longest label, "needs $", is 7 characters and was being clipped to "needs ".
export const W = { keyId: 30, count: 7, bar: 6, free: 12, health: 8,
                   id: 37, ctx: 6, price: 7, badge: 6, caps: 3, prov: 1 };

const ESC = "\x1b";
const SAB = new Int32Array(new SharedArrayBuffer(4));

/** A synchronous pause that does not burn a core and does not need an event loop. */
export function sleepSync(ms) { Atomics.wait(SAB, 0, 0, Math.max(0, ms)); }

export function detectCaps(env = process.env, cols = process.stdout?.columns ?? 80) {
  const dumb = String(env.TERM ?? "") === "dumb";
  const known = !!(env.WT_SESSION || env.ConEmuANSI === "ON" || env.TERM_PROGRAM || env.TERM);
  const vt = known && !dumb;
  const rich = !!(env.WT_SESSION || env.COLORTERM || env.TERM_PROGRAM);
  return { vt, unicode: vt, colours: !vt ? 0 : rich ? 256 : 16, cols };
}

export function motionEnabled({ env = process.env, flags = [], caps }) {
  if (String(env.UW_PICKER_MOTION ?? "") === "0") return false;
  if (flags.includes("--no-motion")) return false;
  if (!caps.vt) return false;
  return caps.cols >= 60;
}

// Four health glyphs, not two. Colour is an enhancement, never the only carrier
// of a state -- `painter` returns `String(s)` unchanged whenever caps.colours is
// 0, and every one of these must still be distinguishable then. Each is exactly
// one column wide in both sets, which the frame-width invariant depends on.
const UNI = {
  marker: "▶", fav: "★", recent: "↺",
  dotOk: "●", dotWarn: "◐", dotBad: "✖", dotStale: "○",
  on: "▰", off: "▱", check: "✔", arrow: "→", sep: "▸", caret: "▏", ell: "…", dash: "—",
  // The provenance ladder's five rungs, one glyph each, ordered exactly as
  // PROVENANCE_RUNGS (snapshot.mjs) names them: call-verified, config-asserted,
  // listing-verified, catalogue-only, null (blank). Each is exactly one column
  // in both sets -- `healthDot`'s own established constraint, restated here
  // because a five-way glyph set is exactly where a repeat of ITS bug (two
  // states sharing one glyph under `caps.colours === 0`) would hide.
  provCV: "◆", provCA: "◈", provLV: "◇", provCO: "·",
  // `padId`'s middle-match marker, distinct from the plain elision dash. The
  // first draft carried this state in colour alone (`p.bold(g.dash)`), which
  // renders as a bare `—` -- indistinguishable from an unfiltered row -- the
  // moment `caps.colours === 0` (every ASCII terminal, `painter` returning
  // identity). Same doctrine as `healthDot`/`provenanceDot`: the glyph
  // carries the state, colour is the enhancement.
  dashMatch: "‡",
  frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII = {
  marker: ">", fav: "*", recent: "~",
  dotOk: "*", dotWarn: "$", dotBad: "x", dotStale: "o",
  on: "#", off: ".", check: "OK", arrow: "->", sep: ">", caret: "_", ell: "...", dash: "-",
  provCV: "#", provCA: "=", provLV: "+", provCO: ".",
  dashMatch: "!",
  frame: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};
export function glyphsFor(caps) { return caps.unicode ? UNI : ASCII; }

const SGR = { dim: 2, bold: 1, inv: 7, red: 31, grn: 32, yel: 33, cya: 36, mag: 35 };
export function painter(caps) {
  const wrap = (code) => (s) => (caps.colours ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
  const p = {};
  for (const [name, code] of Object.entries(SGR)) p[name] = wrap(code);
  // A 256-colour ramp for the title only. On a 16-colour host it degrades to cyan,
  // which is the same information with less of it.
  p.ramp = (s, from = 45, to = 39) => {
    if (caps.colours < 256) return p.cya(s);
    const cs = [...String(s)];
    return cs.map((ch, i) => {
      const n = Math.round(from + ((to - from) * i) / Math.max(1, cs.length - 1));
      return `${ESC}[38;5;${n}m${ch}`;
    }).join("") + `${ESC}[0m`;
  };
  return p;
}

export function badgeColour(badge) {
  return badge === "FREE" ? "grn" : badge === "FREE?" ? "yel"
       : badge === "PLAN" ? "cya" : badge === "PAID" ? "dim" : "";
}

// Deliberately not proportional below one cell: a provider with 1 free model out
// of 324 must not render as an empty bar, because "some" and "none" is the
// distinction the column exists to make.
export function proportionBar(free, total, g, width = W.bar) {
  if (free == null || !Number.isFinite(total) || total <= 0) return " ".repeat(width);
  const filled = free <= 0 ? 0 : Math.max(1, Math.round((free / total) * width));
  return g.on.repeat(Math.min(width, filled)) + g.off.repeat(Math.max(0, width - filled));
}

// The glyph carries the state, not only the colour. The previous draft returned
// g.dotOk for ok, needs-$ AND broken, so in the no-colour path -- which is what
// `painter` returns whenever `caps.colours === 0`, and what every ASCII terminal
// gets -- a healthy provider and a dead one both rendered "*". Its own test was
// titled "the health dot carries the state in the glyph as well as the colour"
// and then asserted that ok and broken produce the same glyph.
export function healthDot(health, g, p) {
  if (health === "broken") return p.red(g.dotBad);
  if (health === "needs $") return p.yel(g.dotWarn);
  if (health === "ok") return p.grn(g.dotOk);
  return p.dim(g.dotStale);
}

// The provenance ladder's own dot, same doctrine as `healthDot`: the glyph
// carries the state, colour is the enhancement. `call-verified` renders here
// even though nothing in this branch produces it (§2.3) -- the rung is
// defined and unfed, and the glyph test is what keeps it correct for the day
// it is wired; dropping the branch because "no row can reach it" would delete
// the only check on the top of the ladder. `null` -- unknown, nobody looked --
// renders a single blank column, not one of the four glyphs: the disclosure
// this needs is the header's `discovered` stamp (Q1.3's pattern, restated for
// this field), not a fifth mark competing with the other four for meaning.
/**
 * The free-tier limit cell, padded and coloured, for a model row or a provider.
 *
 * COLOURED AFTER PADDING, for the reason the badge cell records at its own call
 * site: `pad` runs `sanitizeDisplay`, which strips CSI by design, so colouring
 * first deletes the colour and then pads the bare text to the wrong width.
 *
 * Red is not the only carrier of "this will not work". `100KB`, `locked` and
 * `unpaid` are three different words, distinguishable with `colours: 0`, which is
 * the same doctrine `healthDot` and `provenanceDot` follow -- and the reason this
 * renders a word rather than the glyph an earlier draft proposed.
 */
export function limitOut(entry, p, width = W.limit) {
  const { text, colour } = limitCell(entry);
  const cell = pad(text, width);
  return colour ? p[colour](cell) : cell;
}

export function provenanceDot(provenance, g, p) {
  if (provenance === "call-verified") return p.grn(g.provCV);
  if (provenance === "config-asserted") return p.cya(g.provCA);
  if (provenance === "listing-verified") return p.grn(g.provLV);
  if (provenance === "catalogue-only") return p.dim(g.provCO);
  return " ";
}

export function highlight(text, query, p) {
  const q = String(query ?? "");
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return text.slice(0, i) + p.bold(text.slice(i, i + q.length)) + text.slice(i + q.length);
}

// ONE measure of visible width, used by every function in this file that pads,
// truncates or measures. It counts CODE POINTS, which is what sanitizeDisplay's
// cap now counts.
//
// The three measures used to disagree. `pad` ended in `.padEnd(n)` and `bar`
// computed `strip(body).length`, both counting UTF-16 code units, while
// `sanitizeDisplay` capped by code point and `clipVisible` counted by code point.
// Thirty astral code points are sixty code units, so `pad(id, 30)` added no
// padding at all and `bar` then computed its fill against a length twice the real
// one. Two outcomes, and the quieter one is worse: sometimes the frame-width test
// fails, and sometimes the units happen to reach FRAME_W while the terminal
// renders a line thirty columns short — the test passes and the frame is wrong.
//
// This does NOT make the renderer display-width correct: an East Asian glyph is
// one code point in two terminal columns, and that remains deferred with its
// consequence stated in A3 and in the Deferred section. What it makes the
// renderer is SELF-CONSISTENT, which is the property the invariant test can
// actually check.
const vis  = (s) => [...strip(String(s ?? ""))].length;
const fill = (n) => " ".repeat(Math.max(0, n));
const pad  = (s, n) => { const t = sanitizeDisplay(String(s ?? ""), n); return t + fill(n - vis(t)); };
const rpad = (s, n) => { const t = sanitizeDisplay(String(s ?? ""), n); return fill(n - vis(t)) + t; };

// PAD, never truncate. `rpad` caps its content to `n` via `sanitizeDisplay`,
// which is right for text but wrong for `countCell`: that function already
// chooses between an exact pair and an honest abbreviation, and the one
// value it can still return wider than `width` is deliberately the exact,
// correct pair (see its own comment) rather than a truncated lie. Running
// THAT through `rpad` would silently cut it right back to the lie it was
// built to avoid. A result already <= n pads as normal; one that overflows
// passes through untouched, so any resulting frame overflow is `bar()`'s own
// visible, already-tested row clip -- never a specific wrong digit.
const rpadCount = (s, n) => (vis(s) <= n ? rpad(s, n) : String(s));

// MIDDLE elision, not `pad`'s right-truncation, for the one cell whose whole
// job is telling two rows apart. Right-truncation collides whenever two ids
// share a long common prefix -- MEASURED against the real 4,732-model
// catalogue, grouped per provider: right-truncating at the old W.id (34)
// collides 33 rows into 16 groups; at the new W.id (37) alone, still 21 into
// 10. Middle elision at 37 collides ZERO -- the distinguishing suffix (a
// date, a version, a size) that right-truncation always drops is usually
// exactly what a shared prefix hides.
//
// THE MARKER IS ONE CODE POINT IN BOTH GLYPH SETS (`g.dash`: "—" / "-"),
// not `g.ell` ("…" is one code point in UNI but ASCII's "..." is three) --
// using `g.ell` here would silently eat two extra columns from the tail in
// the ASCII path only, an invariant break that only one glyph set's tests
// would catch.
//
// HIGHLIGHT-AFTER-ELISION (#49). The previous draft (implicit in `pad` +
// `highlight`) ran the filter match against the ALREADY-TRUNCATED text, so a
// match living in the dropped tail simply vanished with no visible trace --
// the row still passed the filter (pick-state.mjs matches against the FULL
// id, never the rendered cell) but nothing on screen explained why it was
// there. This runs `highlight` against the head and tail SEPARATELY, against
// their own real substrings, and -- when the match falls entirely inside the
// ELIDED middle -- bolds the marker itself, so a filtered row is never blind:
// every row that matched shows SOMETHING highlighted.
export function padId(id, n, query, g, p) {
  const clean = sanitizeDisplay(String(id ?? ""), 10_000);
  const cps = [...clean];
  if (cps.length <= n) return highlight(clean, query, p) + fill(n - cps.length);

  const keep = n - 1; // one column reserved for the marker
  const headLen = Math.ceil(keep / 2), tailLen = keep - headLen;
  const head = cps.slice(0, headLen).join("");
  const tail = cps.slice(cps.length - tailLen).join("");

  // Containment, not index arithmetic. The previous form derived inHead/inTail
  // from where the match STARTS and ENDS in the full string, so a match that
  // starts in the head but runs into the elided middle set inHead = true (no
  // bold) while `highlight(head, ...)` -- which looks for the query as a whole
  // SUBSTRING of head -- finds nothing there. Both straddling directions hit
  // this: the marker stayed plain and the highlight vanished, leaving a
  // filtered row with no visible match indication at all. Checking containment
  // the same way `highlight` does (a substring search on head/tail themselves)
  // keeps the two in agreement by construction.
  const q = String(query ?? "");
  // The query must actually be IN the id somewhere before "it must be hiding
  // in the middle" is a claim this can make. Without this, a query absent
  // from the id entirely (unreachable from `frame()` today -- rows are
  // pre-filtered on this same string -- but this function is exported and
  // called directly by tests and, eventually, other callers) falls through
  // to "not in head, not in tail" and signals a match that does not exist.
  const hasMatch = q !== "" && clean.toLowerCase().includes(q.toLowerCase());
  const inHead = hasMatch && head.toLowerCase().includes(q.toLowerCase());
  const inTail = hasMatch && tail.toLowerCase().includes(q.toLowerCase());
  // A distinct GLYPH (`dashMatch`), not a bolded ordinary dash: `p.bold` is a
  // no-op under `caps.colours === 0`, which would leave the marker a plain
  // `—` -- blind again, for the whole no-colour population.
  const marker = hasMatch && !inHead && !inTail ? p.bold(g.dashMatch) : g.dash;
  return highlight(head, query, p) + marker + highlight(tail, query, p);
}
// Context window, formatted to FIT ITS COLUMN. The previous form was
//   c >= 1e6 ? `${c / 1e6}M` : `${Math.round(c / 1000)}k`
// which emits the raw quotient: 1048576 becomes "1.048576M", nine characters in a
// six-wide column. `bar` then clips from the right and the M is what falls off,
// so a 1,048,576-token window rendered as `1.0485` -- indistinguishable from a
// number in the thousands, and wrong in the direction that matters, since the
// whole point of the column is telling a big window from a small one. Every
// power-of-two window was affected: 2^20 and 2^21 are the common ones, and the
// operator hit it reading a real model's window off the screen.
//
// Trailing zeros go, so 1000000 stays "1M" rather than becoming "1.00M", and the
// precision steps down until the result fits rather than being clipped.
const trimZeros = (s) => (s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s);
const ctxS = (c) => {
  if (c == null) return "";
  if (c < 1e6) return `${Math.round(c / 1000)}k`;
  const v = c / 1e6;
  for (const places of [2, 1, 0]) {
    const s = `${trimZeros(v.toFixed(places))}M`;
    if (s.length <= W.ctx) return s;
  }
  return `${Math.round(v)}M`;
};
const money = (v) => (v == null ? "" : Number(v).toFixed(2));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Router-pool aliases: names that select a load-balanced GROUP of backend
// models rather than one specific model, so their real availability can
// legitimately drop to zero with no config error on either side -- MEASURED
// 2026-09-19: openrouter/free returned a real upstream 404 "No endpoints
// available" while every other openrouter row answered normally. Label only,
// never excluded: this is a picker-display decision and does not touch
// routing or selection. `keysync/keysync.mjs`'s own `POOL_IDS` governs a
// DIFFERENT decision (withholding the [1m] context-suffix tag from a pool,
// since a pool's context window is evidence about no model at all) and is
// left untouched by this constant on purpose -- the two lists are allowed to
// diverge; `free` earns a label here without earning a change to that tag
// rule, since a pool's ctx is already null (see the real snapshot row) and
// never reaches tagOneM's ctx>=1M gate regardless.
const POOL_ALIAS_LABEL_IDS = /(^|\/)(auto|router|default|free)$/i;
const withPoolLabel = (id) => (POOL_ALIAS_LABEL_IDS.test(String(id ?? "")) ? `${id} [pool]` : id);

// #51 (§2.5(a)), revision 11: the model-count cell carries BOTH numbers
// instead of a new column. A provider withholding nothing renders the BARE
// count -- never `343/0` -- because the count itself is never suppressed,
// only the second half; one that withholds renders both with the separator.
//
// NEVER BLINDLY TRUNCATED. `sanitizeDisplay("1501/1501", 7)` returns
// `"1501/15"` -- a PLAUSIBLE WRONG PAIR, not a visibly clipped one, which is
// worse than truncation because nothing about it looks wrong. If the exact
// pair does not fit, fall back to a k-abbreviated pair before ever reaching
// for a raw truncation; MEASURED against the real vault (max 434 models on
// one provider) this branch is not live today, but the cell must still
// answer honestly if routing ever grows past it.
// Two abbreviation precisions, tried in order, because one is not always
// enough to reach `width`: at 1501/1501, `1.5k/1.5k` is STILL nine columns,
// wider than the exact pair it was meant to shrink. Dropping the decimal only
// when the first attempt does not fit reaches `2k/2k` (five columns) without
// giving up a digit of precision for the common, already-narrow case.
const abbrevCount1 = (n) => (n < 1000 ? String(n) : `${trimZeros((n / 1000).toFixed(1))}k`);
const abbrevCount0 = (n) => (n < 1000 ? String(n) : `${Math.round(n / 1000)}k`);
export function countCell(total, refused, width = W.count) {
  if (!refused) return String(total);
  const exact = `${total}/${refused}`;
  if (exact.length <= width) return exact;
  const abbrev1 = `${abbrevCount1(total)}/${abbrevCount1(refused)}`;
  if (abbrev1.length <= width) return abbrev1;
  const abbrev0 = `${abbrevCount0(total)}/${abbrevCount0(refused)}`;
  if (abbrev0.length <= width) return abbrev0;
  // Neither abbreviation reaches `width` (six-digit-plus counts on both
  // sides -- unreached today, MEASURED max 434 on one real provider). CORRECT
  // beats TRUNCATED even over width: `rpad` must not silently cut this to a
  // plausible wrong pair, so the caller passes it through uncapped and any
  // resulting overflow is the frame's own visible, already-tested row clip,
  // not a lie inside the cell.
  return exact;
}

// Pad OR TRUNCATE to the frame's inner width using the VISIBLE length, so a
// coloured cell does not shorten its row. This is the one place colour and layout
// interact.
//
// Truncation is not defensive padding; it is the difference between a degraded
// row and a broken frame. The previous draft only padded, so any body wider than
// INNER pushed the right-hand frame character past FRAME_W and every subsequent
// line looked ragged -- and because `bar` is what the width-invariant test
// measures, one over-wide cell failed the test for the whole frame with no
// indication of which cell caused it. An over-long row now clips, which is
// visible, local, and still a valid frame.
const clipVisible = (body, n) => {
  if (vis(body) <= n) return body;
  // Walk the string keeping SGR sequences (zero width) and counting the rest.
  let out = "", seen = 0, i = 0;
  while (i < body.length && seen < n) {
    const m = /^\x1b\[[0-9;]*m/.exec(body.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const cp = String.fromCodePoint(body.codePointAt(i));
    out += cp; seen += 1; i += cp.length;
  }
  // Never leave a colour open mid-frame. `strip` removes this again, so it costs
  // nothing in the width accounting.
  return out + `${ESC}[0m`;
};

// `inner` is threaded rather than read from a module constant: the frame is now
// elastic, and a helper that closes over one fixed width is how half the lines
// would come out at 78 while the rest followed the terminal.
const barAt = (g, body, inner) => {
  const clipped = clipVisible(body, inner);
  return `${g.frame.v}${clipped}${fill(inner - vis(clipped))} ${g.frame.v}`;
};

const titleAt = (g, p, text, frameW) => {
  const head = `${g.frame.tl}${g.frame.h} ${text} `;
  return p.ramp(head) + g.frame.h.repeat(Math.max(0, frameW - vis(head) - 1)) + g.frame.tr;
};

export const HELP0 = "[↑↓] move  [↵] open  [⇥] scope  [^f] fav  [?] all keys  [esc] back";
export const HELP1 = "[↑↓] move  [↵] select  [^f] fav  [?] all keys  [esc] back";
const HELP0_A = "[up/dn] move [enter] open [tab] scope [^f] fav [?] all keys [esc] back";
const HELP1_A = "[up/dn] move  [enter] select  [^f] fav  [?] all keys  [esc] back";

const footerAt = (g, p, text, frameW) => {
  const head = `${g.frame.bl} ${text} `;
  return p.dim(head) + g.frame.h.repeat(Math.max(0, frameW - vis(head) - 1)) + g.frame.br;
};

// The legend's CONTENT now lives in `legend.mjs` -- both the key binds (still
// the only complete list, which is why the footer reads "all keys" and points
// here) and the glossary that explains the gutter, the badges, the dimming and
// the health labels. It moved so the reducer can know its length without
// importing this renderer; see that file's own header.

export function frame(v, meta, { caps }) {
  const g = glyphsFor(caps), p = painter(caps);

  // THE GEOMETRY FOR THIS TERMINAL, resolved once and shadowed over the module
  // constants. Every `W.` and `INNER` below this line reads the elastic values
  // rather than the fixed 78-column table, so the ~30 call sites did not each
  // have to learn about width -- and, more importantly, none of them can be
  // MISSED. A helper left closed over the module constant is how half a frame
  // comes out at 78 while the rest follows the terminal, which the width
  // invariant would report as a corrupt frame with no clue where it came from.
  const layout = layoutFor(frameWidth(caps));
  const W = layout.W;
  const INNER = layout.inner;
  const bar = (gg, body) => barAt(gg, body, INNER);
  const title = (gg, pp, text) => titleAt(gg, pp, text, layout.frameW);
  const footer = (gg, pp, text) => footerAt(gg, pp, text, layout.frameW);

  const L = [];

  // `flat` is a THIRD chrome, not a variant of level 0. Every branch below used
  // to key on v.level alone, and tab leaves level at 0 -- so pressing it swapped
  // the rows to models while the title still said "providers", the header still
  // read `key id / models / free / health` over model data, and the stamp still
  // counted providers. view() has always passed scope; frame() simply never read
  // it.
  const flat = v.scope === "flat";

  // #51 (§2.5(b)/(c)), R18: the refusal drill-in, an early return exactly like
  // `v.legend` below -- a full modal, not a variant of the tree/flat chrome.
  // Wording is WITHHELD, never BLOCKED (§2.5(c)): the population is dominated
  // by withheld-with-a-reason rows, not hostile ids. `id` and `reason` are
  // ALREADY sanitised once, at the only constructor of a rejection
  // (`denylist.mjs`'s `refusal()`) -- `pad()` runs `sanitizeDisplay` again
  // here as DEFENCE IN DEPTH, not as the guarantee: the snapshot this data
  // arrives on is a file on disk something else could edit, and a renderer
  // must be safe against any input regardless of provenance. If this pass is
  // ever the ONLY thing standing between a hostile id and the terminal, R17
  // has regressed and #52 is open again.
  if (v.refusals) {
    L.push(title(g, p, `UW ${g.sep} ${sanitizeDisplay(v.refusals.provider, 30)} ${g.sep} WITHHELD`));
    const shown = v.refusals.items.length;
    const from = shown ? v.refusals.top + 1 : 0;
    const to = v.refusals.top + shown;
    const left = `  ${v.refusals.total} withheld`;
    const right = `${from}-${to} of ${v.refusals.total}`;
    const gap = Math.max(1, INNER - vis(left) - vis(right));
    L.push(bar(g, left + " ".repeat(gap) + p.dim(right)));
    L.push(bar(g, ""));
    L.push(bar(g, p.dim("  " + pad("id", W.id) + "  " + pad("reason", 24) + rpad("removed", 7))));
    // MIDDLE elision (`padId`, R16) for the ID column only, not `pad`'s
    // right-truncation: MEASURED against the real snapshot, 117 of 4,732
    // model ids exceed 37 code points (max 52), and this overlay's whole job
    // is naming WHICH ids were withheld -- right-truncating two long ids
    // sharing a prefix (a common shape:
    // `accounts/fireworks/models/llama-v3p1-...`) renders them as one
    // indistinguishable string, on the one screen this is supposed to be
    // legible on. No filter applies here (the overlay is not searchable), so
    // the query is always empty and `padId` degrades to plain elision with
    // no highlight -- exactly what a non-searchable column needs.
    //
    // `reason` stays on plain `pad`, deliberately not `padId`. The reason
    // vocabulary is CLOSED (`sanitize.mjs`'s `REFUSAL_RULES`, 11 codes, plus
    // `uw-namespace`) and its longest member is 17 code points against this
    // 24-wide cell -- it never elides today, so `padId` here would be inert.
    // It is also the wrong SHAPE if a longer free-form reason ever arrives:
    // ids are SUFFIX-distinctive (a shared prefix hides a distinguishing
    // date, version or size at the end, which `padId` exists to preserve),
    // while these classifier labels are PREFIX-distinctive
    // (`leading-separator` vs `leading-something-else`) -- middle elision
    // would hide the very part that tells two reasons apart.
    for (const entry of v.refusals.items) {
      const id = padId(String(entry?.id ?? ""), W.id, "", g, p);
      const reason = pad(String(entry?.reason ?? ""), 24);
      const removed = rpad(String(entry?.removed ?? 0), 7);
      L.push(bar(g, "  " + id + "  " + reason + removed));
    }
    L.push(bar(g, ""));
    L.push(bar(g, p.dim("  any key closes")));
    L.push(footer(g, p, caps.unicode ? "[↑↓] scroll  [any key] close" : "[up/dn] scroll  [any key] close"));
    return L;
  }

  // `flat` is a THIRD chrome, not a variant of level 0 -- see the comment
  // above. Computed AFTER the overlay's own early return (L5): the overlay
  // builds its own title from `v.refusals.provider` directly and never reads
  // `crumb`, so evaluating `v.provider.keyId` here unconditionally derefs a
  // field that can be null at level 0 the moment the overlay ever opens
  // there too (today it does, via ctrl+r) for a value nothing uses.
  const crumb = flat
    ? "UW " + g.sep + " all models"
    : v.level === 0
      ? "UW " + g.sep + " providers"
      : `UW ${g.sep} ${sanitizeDisplay(v.provider.keyId, 30)} ${g.sep} models`;
  L.push(title(g, p, crumb));

  // Q1.3: the routability stamp is printed, not implied. An undimmed row means
  // either "routable" or "nobody checked", and those are different claims; the
  // stamp is what lets the user tell which one they are looking at. `—` means the
  // refresher has never resolved routability, so nothing on screen is dimmed.
  const routableStamp = meta.routableAsOf
    ? `routable ${String(meta.routableAsOf).slice(5, 16).replace("T", " ")}`
    : `routable ${g.dash}`;
  // Same pattern as `routableStamp`, restated for a second field the renderer
  // reads and, until this task, nobody wrote (R15/B3-OQ-4's exact failure
  // shape, one field over): `null` provenance renders blank at the row level,
  // and this stamp is what discloses THAT rather than leaving a silent dash
  // indistinguishable from "every row happens to be catalogue-only".
  //
  // ON THE MODEL-LEVEL HEADER, beside `N of M` -- NOT level 0's. The plan is
  // explicit that level 0 is unchanged: it already carries four segments at
  // 78 columns, and `routableStamp` alone already uses most of the spare
  // width there. MEASURED: appending `discoveredStamp` to level 0's `right`
  // instead produced a header that clips the stamp to a bare word or a
  // mangled date the moment `routableAsOf` is populated (i.e. always, once
  // the refresher has run once) -- the exact silent-disclosure failure this
  // stamp exists to prevent, one level up.
  const discoveredStamp = meta.discoveredAsOf
    ? `discovered ${String(meta.discoveredAsOf).slice(5, 16).replace("T", " ")}`
    : `discovered ${g.dash}`;
  // Flat is a MODEL-level view too -- its rows run `provenanceDot` exactly
  // like level 1's, so the same disclosure applies: blank must be disclosed,
  // not implied (§2.3). Missing this left flat scope showing blank gutters
  // with nothing on screen saying why, in the one branch that renders the
  // thing being disclosed and skips the stamp that discloses it.
  const right = flat
    ? `${v.items.length + v.more} of ${meta.models} models ${g.sep} ${discoveredStamp}`
    : v.level === 0
      ? `${meta.providers} providers ${g.sep} ${meta.models} models ${g.sep} ${routableStamp}`
      // Counts MODEL rows only, not the WITHHELD LIST door that can sit at
      // `v.items[0]` -- that row is not a model, and folding it into "N of M"
      // would count it against a population (`v.provider.models.length`) it
      // is not a member of (the exact miscount class
      // [[counts-carry-their-denominator]] exists to catch).
      : `${v.items.filter((it) => it.kind === "model").length} of ${v.provider.models.length} ` +
        `${g.sep} ${discoveredStamp}`;
  const left = `  filter: ${sanitizeDisplay(v.filter, 40)}${p.inv(g.caret)}`;
  const gap = Math.max(1, INNER - vis(left) - vis(right));
  L.push(bar(g, left + " ".repeat(gap) + p.dim(right)));
  L.push(bar(g, ""));

  if (v.legend) {
    // PAGINATED, which this block previously was not. It used to emit every
    // legend line unconditionally -- a fixed 16-line block that overflowed any
    // terminal shorter than 16, disclosed at the time as an accepted tradeoff
    // and left as future work. The glossary is what made that future arrive:
    // the content is now ~40 lines, so an unpaginated legend would overflow a
    // standard 24-row terminal rather than only a very short one.
    //
    // The offset comes from the reducer (`v.legendTop`), clamped there against
    // this same `avail` arithmetic, so the two can never disagree about how many
    // lines a page holds -- the discipline the refusals overlay already follows.
    const all = legendLines(g, p, { provenanceDot, healthDot });
    const avail = Math.max(1, v.legendAvail ?? all.length);
    const top = Math.min(Math.max(0, v.legendTop ?? 0), Math.max(0, all.length - avail));
    for (const line of all.slice(top, top + avail)) L.push(bar(g, "  " + line));
    L.push(bar(g, ""));
    // The hint has to say scrolling exists, and say so only when it does: on a
    // terminal tall enough to show every line, "up/down scrolls" is an
    // instruction to press keys that do nothing visible.
    const more = Math.max(0, all.length - (top + avail));
    L.push(bar(g, p.dim(more > 0 || top > 0
      ? `  ${top + 1}-${top + Math.min(avail, all.length - top)} of ${all.length}   ` +
        (caps.unicode ? "[↑↓] scroll  [any key] returns" : "[up/dn] scroll  [any key] returns")
      : "  any key returns")));
    L.push(footer(g, p, caps.unicode ? HELP0 : HELP0_A));
    return L;
  }

  // Header columns must line up with the row columns beneath them, which the
  // previous draft's did not: it reserved W.bar + W.free = 18 for "free" while
  // the row emitted a 5-wide bar + " " + an 11-wide value = 17, so everything
  // from "free" rightward was off by one; and it emitted a bare "caps" (4) over a
  // 3-wide T/V/R cell. Both are now derived from the same W constants as the row,
  // and the derived-offset test below asserts they agree rather than trusting it.
  // The two-space gap before "health" is the dot gutter (see W).
  // The provenance gutter is a two-column blank in the header, matching the
  // health dot's own gutter convention (see W): the glyph needs no text
  // label of its own, since "distinct glyph per state" is the whole
  // observable, and a label would compete with the `discovered` stamp
  // already carrying that disclosure at the header line above.
  L.push(bar(g, p.dim(!flat && v.level === 0
    ? "  " + pad("key id", W.keyId) + rpad("models", W.count) + "   " +
      pad("free", W.bar + W.free) + "  " + pad("health", W.health) + (layout.showLimit ? pad("limit", W.limit) : "")
    : "  " + "  " + pad(flat ? "provider/model" : "model", W.id) + rpad("ctx", W.ctx) + " " +
      rpad("$in", W.price) + rpad("$out", W.price) + "  " +
      pad("badge", W.badge) + pad("TVR", W.caps) +
      (layout.showLimit ? " " + pad("limit", W.limit) : ""))));

  if (v.empty) {
    // The instruction comes FIRST, and the query is clipped to 20.
    //
    // This line is `2 + 14 + filter + 1 + 1 + 1 + 33` columns, so at a filter of 24
    // it exceeds INNER = 75 while sanitizeDisplay permitted 30. `bar` then clips
    // from the right -- and what is on the right is "backspace to widen, esc to
    // clear". The user loses the stated way out at the exact moment they are most
    // stuck, and the frozen mock uses a three-character filter so it never showed.
    // Ordering the instruction ahead of the echoed query makes the clip fall on
    // the query, which is the part the user already knows.
    L.push(bar(g, `  backspace to widen, esc to clear ${g.dash} no match for ` +
                  `"${sanitizeDisplay(v.filter, 20)}"`));
  }

  // #60: the display cap on pinned recents (`pick-state.mjs`'s
  // `MAX_RECENTS_SHOWN`) is a hiding action and must disclose itself, the same
  // way a withheld model does. Reuses the picker's existing "... N more"
  // affordance (the plan's own suggestion) rather than a new one, worded
  // distinctly from the bottom overflow line below so two differently-caused
  // truncations are never visually the same sentence. Pinned rows are always
  // a CONTIGUOUS PREFIX of `v.items` (`pick-state.mjs`'s `[...pins, ...provs]`),
  // so the boundary is just "the index where they end" -- computed once
  // rather than re-scanned per row.
  const pinnedCount = v.items.filter((it) => it.kind === "pinned").length;
  let recentsDisclosed = false;
  const maybeDiscloseRecents = () => {
    // `recentsHidden` (`pick-state.mjs`) is computed ONCE in `initState`, over
    // the unfiltered recents list -- it does not shrink when a query narrows
    // `v.items`. Rendering it under an active filter claims "N more recents"
    // exist below when the true count of recents matching THIS filter could
    // be anything from 0 to N: a stale, unfiltered number attached to a
    // filtered view is exactly [[counts-carry-their-denominator]]'s failure
    // shape. Suppressed while filtering, the same as the WITHHELD LIST row's
    // own rule (§2.5(b)) -- hidden under a filter is fine, a wrong claim is not.
    if (recentsDisclosed || flat || v.level !== 0 || v.filter || pinnedCount === 0 || !v.recentsHidden) return;
    recentsDisclosed = true;
    L.push(bar(g, p.dim(`  ${g.ell} ${v.recentsHidden} more recents`)));
  };

  v.items.forEach((it, i) => {
    if (i === pinnedCount) maybeDiscloseRecents();
    const selected = v.top + i === v.cursor;
    const mark = selected ? g.marker : " ";
    let body;
    if (it.kind === "withheld-list") {
      // #51 (§2.5(b), revision 11): a real, cursor-reachable v.items member
      // now -- `pick-state.mjs` places it first and sizes `rowsAvail` for it
      // like any other row, so it needs no separate line-budget accounting
      // (R16's own item-trim mitigation, needed only because this row was
      // then a static addition outside `v.items`, is retired along with it).
      // Wording is WITHHELD, never BLOCKED (§2.5(c)): the population is
      // dominated by withheld-with-a-reason rows, not hostile ids.
      body = `${mark} ` + p.dim(`${g.arrow} WITHHELD LIST (${it.count})`);
    } else if (it.kind === "provider") {
      const r = it.row;
      const total = r.models.length;
      const freeTxt = r.free == null ? g.dash
        : r.planCount ? `${r.free} +${r.planCount} plan` : String(r.free);
      body = `${mark} ` + highlight(pad(r.keyId, W.keyId), v.filter, p) +
             // #51 (§2.5(a)): bare count when nothing is withheld, `#/#`
             // when something is -- never a new column, the same W.count
             // cell renamed to a wider role (revision 11).
             rpadCount(countCell(total, r.refused?.length ?? 0), W.count) + "   " +
             proportionBar(r.free, total, g) + " " + pad(freeTxt, W.free - 1) +
             healthDot(r.health, g, p) + " " + pad(r.health, W.health) +
             // The free-tier limit, aggregated over this provider's free rows.
             // `r.limit` is absent on a snapshot written before schema 4, and
             // `limitCell(undefined)` renders `?` -- "not probed", which is
             // exactly what an older snapshot means, and distinct from the `n/a`
             // a provider with no free rows earns.
             (layout.showLimit ? limitOut(r.limit, p, W.limit) : "");
    } else if (it.kind === "pinned") {
      body = `${mark} ` + (it.mark === "*" ? p.yel(g.fav) : p.dim(g.recent)) + " " +
             highlight(pad(withPoolLabel(it.target), W.keyId + W.count), v.filter, p);
    } else {
      const m = it.model;
      // Three states, three glyphs. capsOf now distinguishes "the catalogue says
      // no" from "the catalogue does not say", and rendering both as `-` would
      // move the lie one layer out rather than remove it -- the correctness fix
      // upstream creates a NEW ambiguity here if this cell stays binary. ASCII and
      // one column each, so W.caps is unchanged and the frame-width invariant
      // holds in both glyph sets.
      const cap = (on, ch, colour) =>
        on === true ? p[colour](ch) : on === false ? p.dim("-") : p.dim("?");
      // COLOUR AFTER PADDING, never before. `pad` runs sanitizeDisplay, which
      // strips CSI sequences by design (A3) -- so passing an already-coloured
      // string into it silently deleted the colour and then padded the bare text
      // to W.badge + 9, leaving nine stray spaces. The +9 was wrong on its own
      // terms too: it assumed a 9-character SGR wrapper, but p.dim (used for
      // PAID) is 8 and p.ramp's 256-colour form is 11 or more per character.
      const badgeCell = pad(m.badge, W.badge);
      const badgeOut = badgeColour(m.badge) ? p[badgeColour(m.badge)](badgeCell) : badgeCell;
      // In flat scope the id must be the TARGET. A bare `qwen3-max` in a list
      // drawn from every provider at once names no row the user can act on --
      // and the filter they typed was matched against the target, so the
      // highlight would land on text that is not shown.
      // The ctx cell is polymorphic for one row class, and it is a correction
      // rather than a decoration: `contextTokens` is not a context window for a
      // model that does not emit text. google/veo-2 carries 480, which is a video
      // duration in SECONDS, and google/lyria carries 0. Both are numbers, so the
      // column renders them as very small chat models -- an active lie in the one
      // cell whose job is telling a big window from a small one.
      //
      // The branch is here at the call site, not inside ctxS(), which stays a
      // number formatter. `nochat` is six columns exactly, so W.ctx is untouched.
      //
      // NOT the modality name. The design intent was AUDIO / VIDEO / IMAGE, and
      // the cell is wide enough -- but `outputKind` is a three-valued label and
      // the specific modality is not carried on the row or in the snapshot.
      // Naming it would need a fourth per-model field and a second schema bump,
      // so the cell says the consequence it can prove instead of the cause it
      // cannot. Recorded rather than quietly narrowed.
      const ctxCell = m.outputKind === "nontext" ? "nochat" : ctxS(m.ctx);
      // The provenance gutter, same 2-column convention as health's dot: one
      // glyph, one space, no text label. `m.provenance` arrives straight off
      // the snapshot row (schema 3, R15) -- `null` for a synthetic/unknown
      // row (relay is `config-asserted`, never null; see catalog.mjs).
      body = `${mark} ` + provenanceDot(m.provenance, g, p) + " " +
             padId(withPoolLabel(flat ? it.target : m.id), W.id, v.filter, g, p) +
             rpad(ctxCell, W.ctx) + " " +
             rpad(money(m.pin), W.price) + rpad(money(m.pout), W.price) + "  " +
             badgeOut +
             cap(m.tools, "T", "cya") + cap(m.vision, "V", "mag") + cap(m.reason, "R", "yel") +
             // Only when the frame is wide enough to have reserved it. At the
             // 78-column floor level 1 has three spare columns and the column is
             // not drawn at all -- see `layoutFor`.
             (layout.showLimit ? " " + limitOut(m.limit, p, W.limit) : "");
      // Q1.3: `routable` is a value on the row, baked in by the refresher. `false`
      // dims; `null` -- nobody checked -- does not, because dimming everything the
      // one time the gateway was unreachable says "nothing works" when the truth
      // is "nothing was asked".
      //
      // DIM ONLY, never skip, and the asymmetry with the non-chat dim is
      // deliberate rather than an oversight. Block a row only when selecting it
      // cannot possibly succeed; dim it when it might. An image model cannot
      // answer a chat request under any configuration, so it is unselectable. A
      // row CCR did not list when the snapshot was built may be routable right
      // now -- MEASURED 2026-09-06: about 205 of 1,588 models are reachable at
      // current balances and about 260 if the unfunded accounts were paid, while
      // Providers[].models names 91, so this dim covers roughly 114 models that
      // genuinely work. Blocking on it would convert snapshot staleness into a
      // functional outage. The failure is loud anyway: ModelRegistry.resolve()
      // returns undefined and the request errors rather than silently rerouting.
      //
      // ONE dim for two reasons, and they stay distinguishable without new width:
      // a non-chat row carries `nochat` in the cell above, a non-routable one
      // keeps its real context window, and the header's `routable <date>` stamp
      // says whether routability was resolved at all.
      if (m.routable === false || m.outputKind === "nontext") body = p.dim(strip(body));
    }
    L.push(bar(g, selected ? p.inv(strip(body)) : body));
  });
  maybeDiscloseRecents();               // all-pinned, no-providers edge: the loop above never hit i === pinnedCount

  if (v.more > 0) L.push(bar(g, p.dim(`  ${g.ell} ${v.more} more`)));
  const atProviders = !flat && v.level === 0;
  L.push(footer(g, p, caps.unicode ? (atProviders ? HELP0 : HELP1)
                                   : (atProviders ? HELP0_A : HELP1_A)));
  return L;
}

export function confirmLine(target, g, p) {
  return `${p.grn(g.check)} switched ${g.arrow} ${p.bold(sanitizeDisplay(target, 60))}`;
}

// --- transitions -----------------------------------------------------------
// Each returns an array of complete frames. The caller writes them one at a time
// with sleepSync(FRAME_MS) between, so the whole burst is 90 ms and the next key
// is read immediately afterwards (Q7.3).

export function slideFrames(lines, step = 6, frames = 3) {
  const out = [];
  // Widest rendered line, which for a well-formed frame is every line. `max`
  // rather than `lines[0]` so a caller passing a partial or ragged set still
  // clips to the frame rather than to whatever happened to be first.
  const width = lines.reduce((m, l) => Math.max(m, vis(l)), FRAME_MIN);
  for (let f = frames; f >= 1; f--) {
    const shift = " ".repeat(step * (f - 1));
    // clipVisible, not String.slice. `.slice(0, FRAME_W + shift.length)` counted
    // RAW characters, so every SGR escape in a line ate a column of the budget
    // and the line was cut before its visible end -- losing the right-hand frame
    // character and whatever trailed it.
    //
    // MEASURED: a row of 68 visible columns carrying two colour spans came out
    // at 60 and lost its border. The title was worse by an order of magnitude,
    // because `title` paints it through `p.ramp`, which emits one escape PER
    // CHARACTER: 453 raw characters for 69 visible, clipped to 8. The user saw
    // exactly that -- a title bar reading `╭─ UW ▸` and nothing else, on every
    // descend and every esc back, corrected by the next keypress because a
    // normal redraw does not go through here.
    //
    // The frame's own width, not FRAME_W + shift.length: the shifted line is
    // that much wider than the frame, and letting it through wraps in a terminal
    // sized to the frame. Clipping to the frame's own width is what makes this a
    // slide rather than an overflow, and at the last frame (shift 0) it is a
    // no-op, so the settled frame is bit-for-bit the normal render.
    //
    // MEASURED FROM THE LINES, not from the constant. These are already-rendered
    // frame lines, so their own visible width IS the frame width -- and since the
    // frame became elastic, clipping to a fixed 78 cut a 118-column render down
    // by 40 and the "settled frame is bit-for-bit the normal render" property
    // above silently stopped holding.
    out.push(lines.map((l) => clipVisible(shift + l, width)));
  }
  return out;
}

export function revealFrames(lines, frames = 3) {
  const out = [];
  for (let f = 1; f <= frames; f++) {
    const n = Math.ceil((lines.length * f) / frames);
    out.push(lines.slice(0, n));
  }
  return out;
}

export function flashFrames(lines, index, p, times = 2) {
  const out = [];
  for (let i = 0; i < times; i++) {
    out.push(lines.map((l, n) => (n === index ? p.inv(strip(l)) : l)));
    out.push(lines);
  }
  return out;
}

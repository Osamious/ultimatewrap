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

// `sanitizeCells`, not `sanitizeDisplay`: everything drawn here is measured in code points, so
// wide, astral and combining characters are replaced by `?` at draw time (see sanitize.mjs).
import { sanitizeCells as sanitizeDisplay } from "./sanitize.mjs";
import { liveAlias } from "./route-hints.mjs";
import { PREVIEW_CHARS, STATUSES, statusCode, statusTone, fmtMs, fmtTps, previewText, isUsable, probeAgeTone, recordAge } from "./bench-data.mjs";
// Content only. `legend.mjs` imports nothing and takes the glyph renderers as
// arguments, so this does not become a cycle even though the legend renders
// through `provenanceDot` defined in this file.
import { legendLines } from "./legend.mjs";
// The output-modality vocabulary (the `modality` column). Also import-free.
import { modalityWord, MODALITY_COLOURS } from "./modality.mjs";

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
export const FRAME_MAX = 260;

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
 * The column table for a given frame width. One call resolves BOTH chromes, and the
 * header and the rows read the same numbers, so they cannot disagree.
 *
 * LEVEL 0 (providers): see the block comment above `LEVEL0_FIXED`. The key id column takes its FULL
 * content first (`keyW`, capped at KEYID_MAX); surplus width is never poured into it beyond that, so the
 * other columns sit beside it. What the key id leaves buys, in this order, the optional `oldest probe` column (13) and then
 * the `free` block (10): a narrower terminal loses `free` first, then `oldest probe`, and the full key id before neither.
 *
 * MODEL LEVEL (level 1 and flat scope), ONE view showing every column when it fits:
 *   gutter, id, stat, [probed], ttft, [total], [tok/s], ctx, $in, $out, badge, modality, TVR, [output]
 * Bracketed cells are optional. Priority, highest first: the always-drawn cells (stat,
 * ttft, ctx, $in, $out, badge, modality, TVR); the id up to MODEL_ID_MIN (elided in the middle
 * beyond that); then, in order, `total`, `tok/s`, `probed` and the `output` preview at its minimum;
 * and only THEN does the id grow toward its content (capped at MODEL_ID_MAX), with the
 * preview taking ALL that is left. `probed` was added LAST and makes no older column appear later or disappear: every older
 * column appears at exactly the width it did before (`total` and `tok/s` first, `output` from the same all-columns width), the
 * id is the same from that width up, and from 97 to 102 columns (where `probed` shows without `output`) the id gives up up
 * to 7 columns of GROWTH beyond its floor for it, never the floor itself. And
 * `output` pays for it by shrinking to a 3-character minimum (it was 10) and appearing only together with `probed`. So
 * on a narrowing terminal the preview goes first, then `probed`, then `tok/s`, then `total`; `modality` outlasts all of
 * them (it is one of the always-drawn cells).
 *
 * Returned fresh each call rather than memoised: it is a handful of integer
 * additions on a path that already rebuilds every row, and a cache keyed on
 * width is a second source of truth for the geometry.
 */
// LEVEL 0 (#114 redesign): key id | status | [oldest probe] | models | ok | % | [free | %] | empt | auth | pay | rate | gone | t/o | err.
// Every cell is a dim rule plus right-aligned text. The raw status cells (all but `ok`, which is
// folded into the `ok` element, and `skip`, which no longer occurs) are as wide as their label plus
// the rule (`CELL_MIN` = a three-digit count). `ok` and `free` are each TWO sub-columns: the count
// (4 wide, so the `free` header fits; `2k` from a thousand) and the percent of the provider's models (4 wide),
// with no parentheses: rule + 4, rule + 4 = 10 columns apiece.
const CELL_MIN = 3;
export const statusCellW = (status) => Math.max(statusCode(status).length, CELL_MIN) + 1;
export const L0_STATUSES = Object.freeze(["empty", "auth", "pay", "rate", "gone", "timeout", "error"]);
const L0_RAW_W = L0_STATUSES.reduce((n, st) => n + statusCellW(st), 0);          // 32
const STATUS_TXT_W = 6, CNT_W = 4, PCT_W = 4, KEYID_MIN = 6;
// The longest key id the column will ever be sized to (a hostile 200-character id must not starve every other column).
export const KEYID_MAX = 64;
const PCT_BLOCK_W = (1 + CNT_W) + (1 + PCT_W);              // 10: count sub-column + percent sub-column
// The `models` cell is `N` or `N/M` (M withheld): 7 wide holds the worst real pair (`469/100`), and a wider pair
// falls back to the abbreviated form, then to `big` -- it never overflows, so it can never move a column.
const MODELS_TXT_W = 7, MODELS_W = 1 + MODELS_TXT_W;
// mark 2, status 7 (rule + 6), models 8 (rule + 7), ok 10, then the raw cells; `free` (10) is optional.
const LEVEL0_FIXED = 2 + (1 + STATUS_TXT_W) + MODELS_W + PCT_BLOCK_W + L0_RAW_W;          // 59
const FREE_W = PCT_BLOCK_W;
// `oldest probe`: the age of the provider's OLDEST probe record, sized to its own header (12) plus the rule. Optional: it
// needs the FULL key id first, and `free` needs it in turn (a terminal too narrow for it loses `free` first, then it).
const PROBE_TXT_W = 12, PROBE_W = 1 + PROBE_TXT_W;

// Model level. Every cell carries its own leading gap, so no two cells can touch.
// Text widths: stat 4 (`empt`), ttft/total/tok-s 5, ctx 6 (`nochat`), $in/$out 5 (`180.0`),
// badge 5 (`FREE?`), modality 8 (its header; the words are at most 5), TVR 3.
const M_GUTTER = 4;                       // mark + space, provenance glyph + space
const M_STATUS = 5, M_TTFT = 6, M_CTX = 7, M_PRICE = 6, M_BADGE = 6, M_MODALITY = 9, M_CAPS = 4;
const M_TOTAL = 6, M_TPS = 6;
// `probed`: the age of the model's own probe record, 6 wide (its header) plus the rule.
const PROBED_TXT_W = 6, M_PROBED = 1 + PROBED_TXT_W;
const M_FIXED = M_STATUS + M_TTFT + M_CTX + 2 * M_PRICE + M_BADGE + M_MODALITY + M_CAPS;   // 49
// The id column never WANTS more than this, however long the longest id is (73 in the real
// snapshot; 86 as a flat target; the median is 20, the 95th percentile 36): a few outliers
// would otherwise take every column's room and the `output` preview would never appear. Longer ids elide in the middle (padId).
export const MODEL_ID_MAX = 40;
// The id is guaranteed this much before any optional column is dropped (the median real id is 20).
export const MODEL_ID_MIN = 22;
// The `output` preview's minimum text width (it was 10 before `probed` existed). It is drawn only together with `probed`,
// and the two together need exactly the room the preview alone did (7 + 1 + 3 = 11 = 1 + 10), so no older column moves.
const PREVIEW_MIN = 3;

export function layoutFor(frameW, { keyW = W.keyId, idW = W.id } = {}) {
  const w = Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.floor(frameW) || FRAME_MIN));
  const inner = w - 3;

  // LEVEL 0. The key id is sized to the LONGEST FULL key id (`keyW`, from `keyIdWidth` over every provider row)
  // FIRST, before the optional `free` block: it is only elided (distinctness-aware, with a visible marker) when
  // even the mandatory columns plus the full id do not fit. What is left over buys `free`; the rest stays empty
  // space at the right.
  const avail0 = inner - LEVEL0_FIXED;
  const want0 = Math.max(KEYID_MIN, Math.min(Math.floor(keyW) || W.keyId, KEYID_MAX));
  const keyId = Math.max(1, Math.min(want0, avail0));
  const spare0 = avail0 - keyId;
  const showProbe = spare0 >= PROBE_W;
  const showFree = showProbe && spare0 - PROBE_W >= FREE_W;

  // MODEL LEVEL. See the doc above.
  const want = Math.min(MODEL_ID_MAX, Math.max(1, Math.floor(idW) || W.id));
  const idMin = Math.min(want, MODEL_ID_MIN);
  let free = inner - M_GUTTER - M_FIXED - idMin;
  const take = (cost) => (free >= cost ? ((free -= cost), true) : false);
  const showTotal = take(M_TOTAL);
  const showTps = take(M_TPS);
  const showProbed = take(M_PROBED);
  const showPreview = showProbed && take(1 + PREVIEW_MIN);          // the preview at its minimum, gap included
  const grow = Math.min(want - idMin, free);          // then the id grows toward its content
  free -= grow;
  const id = idMin + grow;
  // The output column takes ALL that is left (no cap): the stored reply is what limits it.
  const preview = showPreview ? PREVIEW_MIN + free : 0;

  return { frameW: w, inner, showProbe, showFree, showTotal, showTps, showProbed, showPreview,
           W: { ...W, keyId, id, preview } };
}

/**
 * The key id column's content width: the longest FULL key id over ALL provider rows (not the visible
 * page, so the columns do not move while filtering or scrolling), at least the header text, at most
 * KEYID_MAX. Code points, the measure `pad` uses.
 */
export function keyIdWidth(rows) {
  let n = KEYID_MIN;
  for (const r of rows ?? []) {
    n = Math.max(n, [...sanitizeDisplay(String(r?.keyId ?? ""), KEYID_MAX + 1)].length);
  }
  return Math.min(n, KEYID_MAX);
}

const keyPlanCache = new WeakMap();
/** Head lengths for the level-0 key id column: the same distinctness-aware elision as model ids. */
export function keyIdPlan(rows, n) {
  if (!Array.isArray(rows)) return null;
  let byKey = keyPlanCache.get(rows);
  if (!byKey) keyPlanCache.set(rows, byKey = new Map());
  let plan = byKey.get(n);
  if (!plan) byKey.set(n, plan = elisionHeads(rows.map((r) => String(r?.keyId ?? "")), n).heads);
  return plan;
}

/**
 * Flat scope's id column content width: the longest `provider/model` target over the
 * whole snapshot (with the `[pool]` label some ids carry), measured once by the caller so
 * the column does not move while filtering. At least the header text.
 */
export function flatIdWidth(rows) {
  let n = 14;
  for (const r of rows ?? []) {
    for (const m of r.models ?? []) {
      n = Math.max(n, [...withPoolLabel(`${r.provider}/${m.id}`)].length);
    }
  }
  return n;
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

// The base column widths (`layoutFor` resolves the real ones for a terminal). The provider
// list's `health` column was replaced by the sweep columns (#114) and is gone.
export const W = { keyId: 30, count: MODELS_W,
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
  // UW_PICKER_COLSEP picks the column rule for fonts that lack `┆` (Consolas is one): `ascii` draws
  // `:`, `latin` draws `¦` (U+00A6, present in every font). Anything else, and every ASCII
  // terminal, keeps the default. Read here, once, so the renderer stays a pure function of caps.
  const want = String(env.UW_PICKER_COLSEP ?? "").toLowerCase();
  const colSep = vt && want === "ascii" ? ":" : vt && want === "latin" ? "¦" : null;
  return { vt, unicode: vt, colours: !vt ? 0 : rich ? 256 : 16, cols, colSep };
}

export function motionEnabled({ env = process.env, flags = [], caps }) {
  if (String(env.UW_PICKER_MOTION ?? "") === "0") return false;
  if (flags.includes("--no-motion")) return false;
  if (!caps.vt) return false;
  return caps.cols >= 60;
}

// Colour is an enhancement, never the only carrier of a state -- `painter` returns `String(s)` unchanged whenever caps.colours is
// 0, and every one of these must still be distinguishable then. Each is exactly
// one column wide in both sets, which the frame-width invariant depends on.
// NOTE: `fav` (★) and the confirm `check` (✔) are OUTSIDE the `sanitizeCells` one-column
// allowlist (sanitize.mjs): they are emitted by the renderer itself and must NEVER be passed through
// `pad`, `rpad` or `padId` (which sanitise). test/round2.test.mjs fails if any OTHER glyph in this
// table would be altered by `sanitizeCells`, and pins these two as the only deliberate exceptions.
const UNI = {
  marker: "▶", fav: "★", recent: "↺",
  check: "✔", arrow: "→", sep: "▸", caret: "▏", ell: "…", dash: "—",
  // The id ELISION marker (one code point): an em dash in Unicode, and `~` in ASCII, where a plain `-` would read as
  // a real hyphen in the id.
  elide: "—",
  // The provenance ladder's five rungs, one glyph each, ordered exactly as
  // PROVENANCE_RUNGS (snapshot.mjs) names them: call-verified, config-asserted,
  // listing-verified, catalogue-only, null (blank). Each is exactly one column
  // in both sets, and a five-way glyph set is exactly where two states
  // sharing one glyph under `caps.colours === 0` would hide.
  provCV: "◆", provCA: "◈", provLV: "◇", provCO: "·",
  // `padId`'s middle-match marker, distinct from the plain elision dash. The
  // first draft carried this state in colour alone (`p.bold(g.dash)`), which
  // renders as a bare `—` -- indistinguishable from an unfiltered row -- the
  // moment `caps.colours === 0` (every ASCII terminal, `painter` returning
  // identity). Same doctrine as `provenanceDot`: the glyph
  // carries the state, colour is the enhancement.
  dashMatch: "‡",
  // The dim vertical rule between table columns: a different glyph from the frame's own `v`.
  colSep: "┆",
  dot: "·",
  frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII = {
  marker: ">", fav: "*", recent: "~",
  check: "OK", arrow: "->", sep: ">", caret: "_", ell: "...", dash: "-",
  elide: "~",
  provCV: "#", provCA: "=", provLV: "+", provCO: ".",
  dashMatch: "!",
  colSep: ":",
  dot: "|",
  frame: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};
const UNI_COLSEP = { ":": { ...UNI, colSep: ":" }, "¦": { ...UNI, colSep: "¦" } };
export function glyphsFor(caps) {
  if (!caps.unicode) return ASCII;
  return (caps.colSep && UNI_COLSEP[caps.colSep]) || UNI;
}

const SGR = { dim: 2, bold: 1, inv: 7, red: 31, grn: 32, yel: 33, cya: 36, mag: 35, blu: 94 };
export function painter(caps) {
  const wrap = (code) => (s) => (caps.colours ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
  const p = {};
  for (const [name, code] of Object.entries(SGR)) p[name] = wrap(code);
  // A raw SGR parameter string (`38;5;n`, `32`, ...) and the colour depth, for the modality table (`modalityCell`).
  p.raw = (code, str) => wrap(code)(str);
  p.depth = caps.colours;
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

/**
 * One provider-level status cell: a count right-aligned in the status' own width
 * (`statusCellW`: its label plus one gap), coloured by the status' tone, `-` for zero,
 * blank when there is no bench data at all, and `Nk` from a thousand so a big provider
 * cannot widen it.
 */
export function statusCount(n, unbenched, status, p, lead = " ") {
  const room = statusCellW(status) - 1;              // the cell is `lead` (one column) + text
  if (unbenched || !Number.isFinite(n)) return lead + " ".repeat(room);
  if (n <= 0) return lead + p.dim(rpad("-", room));
  // `Nk` from a thousand; past 99,999 a count no longer fits, and `big` is the truth (a
  // truncated `1200k` read as `120`).
  const text = rpad(n > 99999 ? "big" : n > 999 ? `${Math.floor(n / 1000)}k` : String(n), room);
  const tone = statusTone(status);
  return lead + (tone === "ok" ? p.grn(text) : tone === "warn" ? p.yel(text) : tone === "bad" ? p.red(text) : p.dim(text));
}

/** `n` as a count that can never widen a cell: `Nk` from a thousand. */
const cnt = (n) => (n > 99999 ? "big" : n > 999 ? `${Math.floor(n / 1000)}k` : String(n));
/**
 * THE one place a share is rounded and clamped, so the label and the colour band can never drift apart. The nearest
 * whole percent, but a non-zero count is never 0% (`low`: it reads `<1%`) and a PARTIAL count is never 100% (995 of
 * 1000 reads 99%), so `100%` always means every one. `null` for an unknown count or a non-positive total.
 */
function share(n, total) {
  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(total) || total <= 0) return null;
  const pct = Math.round((100 * n) / total);
  if (n > 0 && pct < 1) return { value: 0, label: "<1%" };
  const v = n < total && pct >= 100 ? 99 : Math.min(100, pct);
  return { value: v, label: `${v}%` };
}
/** The percent label of `n` in `total`: `12%`, `<1%`, `99%`, `100%`. */
export const pctLabel = (n, total) => share(n, total)?.label ?? "-";
/** The colour band of a share: 70% and up green, 30-69 yellow, under 30 red. `null` for zero or unknown. */
export function pctTone(n, total) {
  const sh = n > 0 ? share(n, total) : null;
  return sh ? (sh.value >= 70 ? "grn" : sh.value >= 30 ? "yel" : "red") : null;
}
/**
 * The two sub-columns of an `ok` or `free` element: a rule and the COUNT right-aligned in 4 (`-` for zero, blank
 * when unknown, `2k` from a thousand; `countTone`: green for `ok`, blue for `free`, dim for a dash), then a rule
 * and the PERCENT of `total` right-aligned in 4 (`<1%`, `50%`, `100%`), with no parentheses. `total` is the
 * DENOMINATOR the caller chose (`ok`: models minus gone; `free`: all models); a zero denominator reads `-`. The
 * percent carries the indicative colour band; the numbers carry the whole meaning without any colour.
 */
export function pctBlock(n, total, p, lead = " ", countTone = "grn") {
  if (!Number.isFinite(n)) return lead + " ".repeat(CNT_W) + lead + " ".repeat(PCT_W);
  if (n <= 0) return lead + p.dim(rpad("-", CNT_W)) + lead + p.dim(rpad("-", PCT_W));
  const count = lead + p[countTone](rpad(cnt(n), CNT_W));
  const tone = pctTone(n, total);
  if (!tone) return count + lead + p.dim(rpad("-", PCT_W));
  return count + lead + p[tone](rpad(pctLabel(n, total), PCT_W));
}
/**
 * The `oldest probe` age text: whole minutes under an hour (`45m`, `<1m` under a minute), whole hours under a day
 * (`5h`), whole days from a day (`3d`, `12d`, `100d`). Every unit rounds DOWN, so `59m` becomes `1h` at 60 minutes,
 * `23h` becomes `1d` at 24 hours, and `47h` reads `1d`.
 */
export function ageLabel(ageS) {
  if (!Number.isFinite(ageS) || ageS < 0) return "-";
  if (ageS < 60) return "<1m";
  if (ageS < 3600) return `${Math.floor(ageS / 60)}m`;
  if (ageS < 86400) return `${Math.floor(ageS / 3600)}h`;
  return `${Math.floor(ageS / 86400)}d`;
}
/** An age band's ink: green, yellow, red as everywhere, and orange as 256-colour 208 (bright red, 91, on a 16-colour terminal). */
const ageInk = (tone, text, p) => (tone === "ora" ? p.raw(p.depth >= 256 ? "38;5;208" : "91", text) : p[tone](text));
/**
 * The provider-list `oldest probe` cell: the age of the provider's OLDEST probe record right-aligned in 12, coloured
 * green, yellow, orange (256-colour 208; bright red 91 on a 16-colour terminal) or red as it nears and passes the
 * outdated threshold (`probeAgeTone`); `-` (dim) for a provider with no records, blank when there is no bench data
 * (`undefined`). The colour is decoration: the text carries the meaning.
 */
export function probeCell(ageS, p, lead = " ") {
  if (ageS === undefined) return lead + " ".repeat(PROBE_TXT_W);
  if (ageS === null || !Number.isFinite(ageS)) return lead + p.dim(rpad("-", PROBE_TXT_W));
  return lead + ageInk(probeAgeTone(ageS), rpad(ageLabel(ageS), PROBE_TXT_W), p);
}
/**
 * The model-list `probed` cell: the age of THIS model's probe record (`recordAge`, exact seconds against the picker's
 * clock), right-aligned in 6 and in the same colour bands as `oldest probe`. Blank when the model has no record (`null`).
 */
export function probedCell(ageS, p, lead = " ") {
  if (!Number.isFinite(ageS)) return lead + " ".repeat(PROBED_TXT_W);
  return lead + ageInk(probeAgeTone(ageS), rpad(ageLabel(ageS), PROBED_TXT_W), p);
}
/** The provider-list `status` cell: `alive` green, `down` yellow, `dead` red, blank when there is no verdict. */
export function statusCell(status, p, lead = " ") {
  const tone = status === "alive" ? "grn" : status === "down" ? "yel" : status === "dead" ? "red" : null;
  return lead + (tone ? p[tone](rpad(status, STATUS_TXT_W)) : " ".repeat(STATUS_TXT_W));
}

// The provenance ladder's own dot: the glyph carries the state, colour is the enhancement. `call-verified` renders here
// even though nothing in this branch produces it (§2.3) -- the rung is
// defined and unfed, and the glyph test is what keeps it correct for the day
// it is wired; dropping the branch because "no row can reach it" would delete
// the only check on the top of the ladder. `null` -- unknown, nobody looked --
// renders a single blank column, not one of the four glyphs: the disclosure
// this needs is the header's `discovered` stamp (Q1.3's pattern, restated for
// this field), not a fifth mark competing with the other four for meaning.
/**
 * The `modality` cell: the route's primary OUTPUT modality (`menu/modality.mjs`), left-aligned like the badge, in
 * its OWN colour from `MODALITY_COLOURS` (256-colour code, or an ANSI 8+8 code on a 16-colour terminal; the word
 * alone with no colour). `?` (unknown, or anything that is not a word from the closed list -- an absent field or a
 * tampered snapshot) is dim: unknown reads as unknown and a stored string can never reach the terminal. COLOURED AFTER
 * PADDING (see the badge cell's note). The colour is decoration; the word carries the meaning.
 */
export const MODALITY_TXT_W = 8;
export function modalityHue(w, p) {
  const c = Object.hasOwn(MODALITY_COLOURS, w) ? MODALITY_COLOURS[w] : null;
  if (!c) return "2";                                   // not a known word: dim, never a colour
  return p.depth >= 256 ? `38;5;${c.c256}` : String(c.c16);
}
export function modalityCell(v, p) {
  const w = modalityWord(v);
  const cell = pad(w ?? "?", MODALITY_TXT_W);
  return w == null ? p.dim(cell) : p.raw(modalityHue(w, p), cell);
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

/**
 * DISTINCTNESS-AWARE ELISION for one column. A blind middle cut to ~22 columns makes rows
 * that differ only in a version, a date or a suffix (`gemini-3.6-flash:batch` vs `...3.8...`)
 * draw identical cells. Given the FULL strings of the column and its width `n`, this picks,
 * for the strings that do not fit, how many code points to keep at the head (the rest of the
 * budget is the tail):
 *   1. ONE split for the whole column (so the column stays visually regular): the one leaving the
 *      fewest strings sharing a cell, ties broken toward a tail-heavy 40% head;
 *   2. then, for each group of strings that still share a cell, the split that separates that
 *      group best (ties toward the column's split). Cheap: only collided groups are re-tried.
 * Returns `{ heads, dup }`: a Map string -> head length for the strings that need eliding, and how
 * many strings still share a cell (0 whenever the width physically allows).
 */
export function elisionHeads(strings, n, minHead = 0) {
  const keep = Math.max(0, n - 1);
  const lo = Math.max(0, Math.min(minHead, keep));      // never keep fewer head characters than this
  const items = [];                                   // [original, code points] for those that need it
  for (const raw of strings) {
    const cps = [...sanitizeDisplay(String(raw ?? ""), 10_000)];
    if (cps.length > n) items.push([raw, cps]);
  }
  const heads = new Map();
  if (!items.length) return { heads, dup: 0 };
  const cellOf = (cps, h) => cps.slice(0, h).join("") + "\u0001" + cps.slice(cps.length - (keep - h)).join("");
  const dupOf = (list, h) => {
    const seen = new Map();
    for (const [, cps] of list) { const k = cellOf(cps, h); seen.set(k, (seen.get(k) ?? 0) + 1); }
    let d = 0;
    for (const c of seen.values()) if (c > 1) d += c;
    return d;
  };
  const pref = Math.max(lo, Math.ceil(keep * 0.4));
  const pick = (list, near) => {
    let best = null;
    for (let h = lo; h <= keep; h++) {
      const d = dupOf(list, h);
      if (best === null || d < best.d || (d === best.d && Math.abs(h - near) < Math.abs(best.h - near))) best = { h, d };
      if (d === 0 && h >= near) break;
    }
    return best;
  };
  const h0 = pick(items, pref).h;
  const groups = new Map();
  for (const it of items) {
    const k = cellOf(it[1], h0);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(it);
  }
  for (const list of groups.values()) {
    const h = list.length > 1 ? pick(list, h0).h : h0;
    for (const [raw] of list) heads.set(raw, h);
  }
  const finalCells = new Map();
  let dup = 0;
  for (const [raw, cps] of items) {
    const k = cellOf(cps, heads.get(raw));
    finalCells.set(k, (finalCells.get(k) ?? 0) + 1);
  }
  for (const c of finalCells.values()) if (c > 1) dup += c;
  return { heads, dup };
}

// One plan per (provider row, scope, width), computed on first use and kept: the visible page
// asks for it on every frame. Flat scope keeps the `provider/` prefix readable whenever the model
// part alone can be made distinct in what is left of the column, and only otherwise elides the
// whole target.
const planCache = new WeakMap();
export function elisionPlan(row, flat, n) {
  if (!row || typeof row !== "object" || !Array.isArray(row.models)) return null;
  let byKey = planCache.get(row);
  if (!byKey) planCache.set(row, byKey = new Map());
  const key = `${flat ? "f" : "l"}:${n}`;
  let plan = byKey.get(key);
  if (plan) return plan;
  const modelOf = (m) => withPoolLabel(String(m?.id ?? ""));
  if (!flat) {
    plan = elisionHeads(row.models.map(modelOf), n).heads;
  } else {
    const prov = String(row.provider ?? "");
    const pl = [...sanitizeDisplay(prov, 200)].length + 1;
    const targetOf = (m) => withPoolLabel(`${prov}/${m?.id ?? ""}`);
    if (n - pl >= 8) {
      const parts = row.models.map(modelOf);
      const r = elisionHeads(parts, n - pl);
      if (r.dup === 0) {
        plan = new Map();
        row.models.forEach((m, i) => { const h = r.heads.get(parts[i]); if (h !== undefined) plan.set(targetOf(m), pl + h); });
      }
    }
    // The model part cannot be made distinct beside the whole provider name: elide the whole
    // target, but keep a stable head of the provider (up to 4 characters) so rows from different
    // providers do not collapse into one look-alike cell.
    plan ??= elisionHeads(row.models.map(targetOf), n, Math.min(4, pl - 1)).heads;
  }
  byKey.set(key, plan);
  return plan;
}

// MIDDLE elision, not `pad`'s right-truncation, for the one cell whose whole
// job is telling two rows apart. Right-truncation collides whenever two ids
// share a long common prefix -- MEASURED against the real 4,732-model
// catalogue, grouped per provider: right-truncating at the old W.id (34)
// collides 33 rows into 16 groups; at the new W.id (37) alone, still 21 into
// 10. Middle elision at 37 collides ZERO -- the distinguishing suffix (a
// date, a version, a size) that right-truncation always drops is usually
// exactly what a shared prefix hides.
//
// THE MARKER IS ONE CODE POINT IN BOTH GLYPH SETS (`g.elide`: "—" / "~", never a plain hyphen),
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
export function padId(id, n, query, g, p, headHint = null) {
  const clean = sanitizeDisplay(String(id ?? ""), 10_000);
  const cps = [...clean];
  if (cps.length <= n) return highlight(clean, query, p) + fill(n - cps.length);

  const keep = n - 1; // one column reserved for the marker
  // `head` is the column's DISTINCTNESS-AWARE split (`elisionHeads`); without one, the blind middle.
  const headLen = Number.isInteger(headHint) ? Math.max(0, Math.min(keep, headHint)) : Math.ceil(keep / 2);
  const tailLen = keep - headLen;
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
  const marker = hasMatch && !inHead && !inTail ? p.bold(g.dashMatch) : g.elide;
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
// Five columns at most: two decimals up to 99.99, one up to 999.9, none beyond (the real catalogue peaks at 180).
const money = (v) => {
  if (v == null) return "";
  const n = Number(v);
  return Math.abs(n) >= 1000 ? String(Math.round(n)) : Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2);
};
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
  // Neither abbreviation reaches `width` (six-digit counts on both sides). `big/big` is honest and always fits
  // 7 columns: a cell must never be wider than its column (it would shift every column to its right).
  const big = `${cnt(total)}/${cnt(refused)}`;
  return big.length <= width ? big : exact;
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

export const HELP0 = "[↑↓] move [↵] open [⇥] scope [^f] fav [^x] gone [?] all keys [esc] back";
export const HELP1 = "[↑↓] move [↵] pick [^f]fav [^o]ok [^l]1M+ [^x]gone [^e]free [?] keys [esc]";
const HELP0_A = "[up/dn][enter] open [tab] scope [^f] fav [^x] gone [?] all keys [esc]";
const HELP1_A = "[up/dn][ent] pick [^f]fav [^o]ok [^l]1M+ [^x]gone [^e]free [?] keys [esc]";

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
  // The id column is sized to its CONTENT at the model level (#114): the longest id
  // of the open provider (over ALL its models, not the visible page, so the columns
  // do not move while filtering or scrolling), or in flat scope the longest target
  // (`meta.flatIdW`, measured once from the whole snapshot; the visible page is the
  // fallback for callers that did not supply it). Level 0 and the modals have no id
  // content of their own and get the default.
  const flatScope = v.scope === "flat";
  const idW = flatScope
    ? Math.max(14, meta.flatIdW ?? 0, ...(meta.flatIdW ? [] : v.items.map((it) => vis(withPoolLabel(it.target ?? "")))))
    : v.level > 0 && v.provider?.models
      ? v.provider.models.reduce((n, m) => Math.max(n, vis(withPoolLabel(m.id))), 5)
      : undefined;
  const layout = layoutFor(frameWidth(caps), { keyW: meta.keyIdW, idW });
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
    // The overlay has its OWN id width: the room the row leaves after `reason` and `removed`
    // (2 + id + 2 + 24 + 7), capped at the longest withheld id; the model list's shrunken id
    // column is the wrong number here.
    const wId = Math.max(6, Math.min(v.refusals.idMax ?? W.id, INNER - 35));
    L.push(bar(g, p.dim("  " + pad("id", wId) + "  " + pad("reason", 24) + rpad("removed", 7))));
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
      const id = padId(String(entry?.id ?? ""), wId, "", g, p);
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
  // Every stamp is drawn text that came from a file, so it is sanitised before it is sliced.
  // Stamps are UTC (the files write `toISOString()`), and say so with a trailing `Z`.
  const stampOf = (iso) => {
    const t = sanitizeDisplay(String(iso ?? ""), 40);
    const body = t.slice(5, 16).replace("T", " ");
    return body && t.endsWith("Z") ? body + "Z" : body;
  };
  const routableStamp = meta.routableAsOf ? `routable ${stampOf(meta.routableAsOf)}` : `routable ${g.dash}`;
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
  // The model-level stamp is how old the MEASUREMENTS are (#114); an unmeasured install is
  // told how to get some. `discovered` (where the provenance gutter's blanks are
  // disclosed) follows only when it also fits: the bench stamp wins a shortage.
  // A sweep date needs records behind it: a reader with zero records (an empty file) is "no data",
  // whatever its `generatedAt` says.
  const hasBench = !!meta.benchAsOf && meta.benchOf?.records !== 0;
  const benchedStamp = hasBench ? `benched ${stampOf(meta.benchAsOf)}`
                                      : `benched ${g.dash} run bench-cli --live`;
  const discoveredStamp = meta.discoveredAsOf ? `discovered ${stampOf(meta.discoveredAsOf)}`
                                              : `discovered ${g.dash}`;
  // Chips, next to the typed filter: the toggles are otherwise invisible. The provider list draws only `[no gone]` (the one
  // toggle that works there: it changes the % figures, hides no row); model lists and flat scope draw all four.
  const atProviderLevel = !flat && v.level === 0;
  const chipNames = atProviderLevel ? [v.hideGone ? "no gone" : ""] : [v.okOnly ? "ok" : "", v.oneM ? "1M+" : "", v.hideGone ? "no gone" : "", v.freeOnly ? "free" : ""];
  const chips = chipNames.filter(Boolean).map((c) => `[${c}]`);
  // What FILTERS the list (the empty-state explanation): nothing at the provider level, where the toggle hides no row.
  const filterChips = atProviderLevel ? [] : chips;
  // What the left side occupies with NO typed text. The stamps are chosen against this,
  // not against the live filter, so they do not appear and vanish keystroke by keystroke:
  // a stamp that would clip is worse than none.
  // The stamps are chosen against the TYPED text too (a candidate that would be cut mid-token by
  // the bar is never chosen); if even the shortest does not fit, the typed text is what gives way.
  const typed = sanitizeDisplay(v.filter, 40);
  // The right side is COUNTS ONLY (the data stamps moved to the id line): thousands separators and a
  // middle dot between the parts. `ok` carries its share of the same population's models.
  const okShown = v.okLive !== undefined ? v.okLive : (flat ? meta.okTotal : v.provider?.bench?.ok);
  const N = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // `P` is ok / models normally, and ok / (models minus gone) while [no gone] is on. The provider list uses the snapshot's
  // baked gone total, the model levels the live one from the same reader as `K ok`.
  const okFig = (k, total, gone = 0) => {
    // `gone` is subtracted ONLY while [no gone] is on: off, the percent is over all routes.
    const den = total - (v.hideGone && Number.isFinite(gone) ? gone : 0);
    return Number.isFinite(k) ? `${N(k)} ok${den > 0 ? ` (${pctLabel(k, den)})` : ""}` : "- ok";
  };
  const rightFor = (n) => (atProviderLevel
    // The total follows [no gone]: all models normally, models minus gone while it is on, and the % over that same total.
    ? `${N(meta.providers)} providers ${g.dot} ${N(meta.models - (v.hideGone && Number.isFinite(meta.goneTotal) ? meta.goneTotal : 0))} models ${g.dot} ${okFig(meta.okTotal, meta.models, meta.goneTotal)}`
    : flat ? `${N(n)} of ${N(meta.models)} models ${g.dot} ${okFig(okShown, meta.models, v.goneLive)}`
           : `${N(n)} of ${N(v.provider.models.length)} ${g.dot} ${okFig(okShown, v.provider.models.length, v.goneLive)}`);
  const matches = v.modelCount ?? (v.items.filter((it) => it.kind === "model").length + v.more);
  const right = rightFor(matches);
  // The chip row degrades in three tiers so that, with every chip on, the counts on the right are never clipped: normal
  // (`[ok] [1M+] [no gone] [free]`), then packed (no space between chips), then short (`[-gone]`, `[1M]`).
  const worstRight = vis(rightFor(flat ? meta.models : v.provider?.models?.length ?? 0));
  const tiers = [
    chips.map((c) => " " + c).join(""),
    " " + chips.join(""),
    " " + chips.map((c) => (c === "[no gone]" ? "[-gone]" : c === "[1M+]" ? "[1M]" : c)).join(""),
  ].map((t) => (chips.length ? t : ""));
  const chipText = tiers.find((t) => vis(`  filter: ${g.caret}`) + vis(t) + 1 + worstRight <= INNER) ?? tiers[tiers.length - 1];
  const leftBare = vis(`  filter: ${g.caret}`) + vis(chipText);
  // If even the counts do not fit beside the typed text, the typed text gives way (never the counts).
  const fit = leftBare + vis(typed) + 1 + vis(rightFor(flat ? meta.models : v.provider?.models?.length ?? 0)) <= INNER ? 0 : -1;
  let typedShown = typed;
  if (fit === -1) {
    const room = Math.max(0, INNER - leftBare - 1 - vis(rightFor(flat ? meta.models : v.provider?.models?.length ?? 0)));
    const t = [...typed];
    typedShown = t.length <= room ? typed : room > vis(g.ell) ? g.ell + t.slice(t.length - (room - vis(g.ell))).join("") : "";
  }
  const left = `  filter: ${typedShown}${p.inv(g.caret)}` + p.yel(chipText);
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
    // The legend draws its terms through the SAME colour tables the rows use (modality words, probe-status codes).
    const codeToStatus = Object.fromEntries(STATUSES.map((st) => [statusCode(st), st]));
    const stat = (code) => {
      const tone = statusTone(codeToStatus[code]);
      return (tone === "ok" ? p.grn : tone === "warn" ? p.yel : tone === "bad" ? p.red : p.dim)(code);
    };
    const modality = (w) => (modalityWord(w) ? p.raw(modalityHue(w, p), w) : w);
    const age = (tone, text) => ageInk(tone, text, p);
    const all = legendLines(g, p, { provenanceDot, modality, stat, age });
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

  // Header columns must line up with the row columns beneath them: both are derived from the same
  // widths, and the derived-offset test asserts they agree rather than trusting it.
  // The provenance gutter is a two-column blank in the header (a glyph and a space): the
  // glyph needs no text label of its own, since "distinct glyph per state" is the whole
  // observable, and a label would compete with the `discovered` stamp
  // already carrying that disclosure at the header line above.
  const S = g.colSep;
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


  // One table row (or pinned row, or the withheld door) as a finished line.
  const rowLine = (it, i) => {
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
      const sepd = p.dim(S);
      const keyText = String(r.keyId ?? "");
      const keyHead = keyIdPlan(meta.rows, W.keyId)?.get(keyText) ?? null;
      // key id | status | [oldest probe] | models | ok | % | [free | %] | the raw status cells, every one a rule plus
      // right-aligned text. `ok` and `free` are a count and a percent of the provider's models (ok count green, free count
      // blue, the percent banded); the plan count is reachable on the `id:` line of the selected provider.
      body = `${mark} ` + padId(keyText, W.keyId, v.filter, g, p, keyHead) +
             statusCell(r.benchFlags?.status, p, sepd) +
             (layout.showProbe ? probeCell(v.probeAges?.has(r.keyId) ? v.probeAges.get(r.keyId) : undefined, p, sepd) : "") +
             sepd + rpadCount(countCell(total, r.refused?.length ?? 0, W.count - 1), W.count - 1) +
             pctBlock(r.bench == null ? NaN : r.bench.ok, total - (v.hideGone && Number.isFinite(r.bench?.gone) ? r.bench.gone : 0), p, sepd, "grn") +
             (layout.showFree ? pctBlock(r.free == null ? NaN : r.free, total, p, sepd, "blu") : "") +
             L0_STATUSES.map((st) => statusCount(r.bench?.[st], r.bench == null, st, p, sepd)).join("");
    } else if (it.kind === "pinned") {
      body = `${mark} ` + (it.mark === "*" ? p.yel(g.fav) : p.dim(g.recent)) + " " +
             highlight(pad(withPoolLabel(it.target), INNER - 4), v.filter, p);
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
      const badgeCell = pad(m.badge, 5);
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
      // This cell says the consequence (`nochat`); the CAUSE -- what the route does output -- is the
      // separate `modality` column beside the badge (`m.outModality`, schema 7).
      const ctxCell = m.outputKind === "nontext" ? "nochat" : ctxS(m.ctx);
      // The provenance gutter, a 2-column convention: one
      // glyph, one space, no text label. `m.provenance` arrives straight off
      // the snapshot row (schema 3, R15) -- `null` for a synthetic/unknown
      // row (relay is `config-asserted`, never null; see catalog.mjs).
      const idText = withPoolLabel(flat ? it.target : m.id);
      const plan = flat ? elisionPlan(it.row, true, W.id) : elisionPlan(v.provider, false, W.id);
      const idCell = padId(idText, W.id, v.filter, g, p, plan?.get(idText) ?? null);
      // A row nobody measured draws BLANKS, not zeros: 0 ms would be a claim. `meta.benchOf`
      // is loaded lazily by uwpick the first time a model screen is drawn.
      // Every USABLE record is drawn (the same rule the counts and the filter use: it has a timestamp and is not dated in
      // the future; there is no age limit). An old measurement is drawn as measured: the `probed` cell says how old it is.
      const got = meta.benchOf ? meta.benchOf(it.target) : null;
      const rec = isUsable(got, v.now ?? Date.now()) ? got : null;
      const tone = rec ? statusTone(rec.s) : "dim";
      const stat = pad(rec ? statusCode(rec.s) : "", 4);
      const statOut = tone === "ok" ? p.grn(stat) : tone === "warn" ? p.yel(stat)
        : tone === "bad" ? p.red(stat) : p.dim(stat);
      const timed = rec?.s === "ok";
      // A record whose stream was CUT (`x`: the probe stopped a model that ignored max_tokens) has no honest
      // `total` -- it is the time to the cut, not the model's own -- so that cell is blank, and its tok/s is an
      // estimate over the part seen, drawn with a leading `~`. `reply:` says why (see below).
      const cut = timed && rec.x === 1;
      const sepd = p.dim(S);
      // `output` can be a 3-character sliver beside a long id: a fragment of the alias hint (`= g`) or of `skipped: why` says
      // nothing, so below 8 columns those two draw blank (the reply: line still carries the whole text).
      const tiny = W.preview < 8;
      // A `gone` route with an `ok` sibling says WHERE the working route is, in the preview cell
      // (no new column); the baked `aliasOf` is honoured only while both records are still fresh.
      // Surface, never substitute: enter still selects THIS row.
      const alias = liveAlias(flat ? it.row?.provider : v.provider?.provider, m, meta.benchOf, v.now ?? Date.now());
      body = `${mark} ` + provenanceDot(m.provenance, g, p) + " " + idCell + sepd + statOut +
             (layout.showProbed ? probedCell(rec ? recordAge(rec, v.now ?? Date.now()) : null, p, sepd) : "") +
             sepd + rpad(timed || (rec?.s === "timeout" && Number.isFinite(rec.t)) ? fmtMs(rec.t) : "", 5) +
             (layout.showTotal ? sepd + rpad(!cut && (timed || rec?.s === "timeout") ? fmtMs(rec.d) : "", 5) : "") +
             (layout.showTps ? sepd + rpad(timed ? (cut ? (Number.isFinite(rec.r) ? "~" + fmtTps(rec.r) : "-") : fmtTps(rec.r)) : "", 5) : "") +
             sepd + rpad(ctxCell, 6) + sepd + rpad(money(m.pin), 5) + sepd + rpad(money(m.pout), 5) +
             sepd + badgeOut + sepd + modalityCell(m.outModality, p) +
             sepd + cap(m.tools, "T", "cya") + cap(m.vision, "V", "mag") + cap(m.reason, "R", "yel") +
             // The optional cells exist only when `layoutFor` reserved them (see its priority list).
             (layout.showPreview
               ? sepd + (tiny && (alias || rec?.s === "skip") ? " ".repeat(W.preview)
                 : alias ? p.dim(pad(`= ${alias} (works)`, W.preview)) : pad(previewText(rec, W.preview), W.preview))
               : "");
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
    return bar(g, selected ? p.inv(strip(body)) : body);
  };

  // PINNED STRIP (favourites `★`, recents `↺`): drawn ABOVE the column header, separated from the
  // table by a dim rule, so the header sits directly on top of the provider rows and the columns
  // stay aligned. Same items, same order, same cursor as when they were table rows. No pins on
  // this page: no strip and no rule.
  const pinStrip = !flat && v.level === 0 && pinnedCount > 0;
  if (pinStrip) {
    for (let i = 0; i < pinnedCount; i++) L.push(rowLine(v.items[i], i));
    maybeDiscloseRecents();
    L.push(bar(g, p.dim("  " + g.frame.h.repeat(Math.max(0, INNER - 4)))));
  }

  // MODEL LEVEL, one view (#114): gutter, id, then stat / [probed] / ttft / [total] / [tok/s], then
  // ctx / $in / $out / badge / modality / TVR, then the [output] preview LAST, since it is
  // the flexible column. Every cell carries its own leading space, so none can touch
  // another; `layoutFor` decides which optional cells exist, and the rows read the same
  // flags, so header and rows cannot disagree.
  // COLUMNS ARE SEPARATED BY A DIM VERTICAL RULE (`g.colSep`, a different glyph from the
  // frame's own `v`). Each separator REPLACES the one-column gap the cell already had
  // in front of it, so it costs no width, and the header and the rows put it in the
  // same columns because both are built from the same widths below: a cell is
  // `sep + text`, where text is `width - 1` wide.
  L.push(bar(g, p.dim(!flat && v.level === 0
    ? "  " + pad("key id", W.keyId) + S + rpad("status", STATUS_TXT_W) +
      (layout.showProbe ? S + rpad("oldest probe", PROBE_TXT_W) : "") + S + rpad("models", W.count - 1) +
      S + rpad("ok", CNT_W) + S + rpad("%", PCT_W) +
      (layout.showFree ? S + rpad("free", CNT_W) + S + rpad("%", PCT_W) : "") +
      L0_STATUSES.map((st) => S + rpad(statusCode(st), statusCellW(st) - 1)).join("")
    : "  " + "  " + pad(flat ? "provider/model" : "model", W.id) + S + pad("stat", 4) +
      (layout.showProbed ? S + rpad("probed", PROBED_TXT_W) : "") +
      S + rpad("ttft", 5) + (layout.showTotal ? S + rpad("total", 5) : "") +
      (layout.showTps ? S + rpad("tok/s", 5) : "") +
      S + rpad("ctx", 6) + S + rpad("$in", 5) + S + rpad("$out", 5) +
      S + pad("badge", 5) + S + pad("modality", MODALITY_TXT_W) + S + pad("TVR", 3) +
      (layout.showPreview ? S + pad("output", W.preview) : ""))));

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
    // With nothing typed there is no query to echo: only the toggles (below) explain the list.
    if (v.filter) {
      L.push(bar(g, `  backspace to widen, esc to clear ${g.dash} no match for ` +
                    `"${sanitizeDisplay(v.filter, 20)}"`));
    } else if (!filterChips.length) {
      L.push(bar(g, "  nothing to list here"));
    }
    // Which toggles are on is the reason a list can be empty with nothing typed, so it gets a
    // line of its own (the line above is already at the frame's width).
    if (filterChips.length) {
      // The long names when they fit the frame; with all four on they do not, so the chips' short names (never clipped mid-word).
      const on = [[v.okOnly, "ok-only", "ok"], [v.oneM, "1M+ context only", "1M+"], [v.hideGone, "gone routes hidden", "no gone"], [v.freeOnly, "FREE / FREE? only", "free"]].filter((t) => t[0]);
      const noBench = v.okOnly && !(meta.benchAsOf && meta.benchOf?.records !== 0);
      const say = (i, tail) => `  filtered by ${on.map((t) => t[i]).join(" + ")}${noBench ? ` ${g.dash} ${tail}` : ""}`;
      const text = [say(1, "no benchmark data yet"), say(2, "no benchmark data yet"), say(2, "no data")].find((t) => vis(t) <= INNER) ?? say(2, "no data");
      L.push(bar(g, text));
      L.push(bar(g, p.dim("  toggles: ctrl+o ok, ctrl+l 1M+, ctrl+x gone, ctrl+e free")));
    }
  }

  // The rows of the table. At level 0 the PINNED rows were already drawn above the column header.
  v.items.forEach((it, i) => {
    if (pinStrip && i < pinnedCount) return;
    L.push(rowLine(it, i));
  });
  maybeDiscloseRecents();               // all-pinned, no-providers edge: the loop above never hit i === pinnedCount

  if (v.more > 0) L.push(bar(g, p.dim(`  ${g.ell} ${v.more} more`)));
  // THE FULL ID of the selected row, one line above the footer: exactly what enter or ctrl+f
  // will act on, however the id column elided it (level 1: the model id; flat: provider/model;
  // level 0: the whole key id, bucket included). Blank when nothing is selectable, so the frame
  // keeps its height. Clipped from the LEFT with a visible ellipsis when longer than the frame.
  // The data stamps live at the RIGHT END of this line (they used to crowd the header): what the
  // selected id leaves free, fullest candidate that fits first, dropped whole (never clipped) otherwise.
  {
    const label = "  id: ";
    let fid = "";
    if (v.fullId) {
      const room = INNER - vis(label);
      const cps = [...sanitizeDisplay(v.fullId, 10_000)];
      fid = p.dim(label) + (cps.length <= room ? cps.join("")
        : g.ell + cps.slice(cps.length - (room - vis(g.ell))).join(""));
      // `  = <sibling>` when the row is a dead alias of a working route, or `  N plan` for a
      // provider with plan-covered models (the count the provider list no longer draws), when the
      // whole line still fits.
      const tail = v.fullAlias ? `  = ${sanitizeDisplay(v.fullAlias, 200)}`
        : Number.isFinite(v.fullPlan) && v.fullPlan > 0 ? `  ${Math.trunc(v.fullPlan)} plan` : "";   // a number only: a tampered planCount draws nothing
      if (tail && cps.length + [...tail].length <= room) fid += p.dim(tail);
    }
    const both = (a, b) => [a, b].filter(Boolean).join(` ${g.dot} `);
    const benchDate = meta.benchCountsAsOf ? `bench ${stampOf(meta.benchCountsAsOf)}` : "";
    const cands = atProviderLevel
      ? [both(routableStamp, benchDate), benchDate, routableStamp]
      : [both(benchedStamp, discoveredStamp), benchedStamp];
    const spare = INNER - vis(fid) - 2;
    const stamp = cands.find((c) => c && vis(c) <= spare) ?? "";
    L.push(bar(g, fid + (stamp ? " ".repeat(INNER - vis(fid) - vis(stamp)) + p.dim(stamp) : "")));
  }
  // MODEL LEVEL: `reply:` -- the selected row's FULL stored reply (or skip reason), sanitised, with the
  // `~` thinking marker kept; clipped with an ellipsis only when longer than the frame. Blank
  // when there is none. One row, accounted for in pick-state's `rowsAvail`.
  if (flat || v.level > 0) {
    const sel = v.items[v.cursor - v.top];
    let reply = "";
    if (sel?.kind === "model") {
      const got = meta.benchOf ? meta.benchOf(sel.target) : null;
      const rec = isUsable(got, v.now ?? Date.now()) ? got : null;
      // A cut stream and an ok record that hit a stream error after its first token say so up front.
      const note = rec?.s === "ok" && rec.x === 1 ? "[cut] " : rec?.s === "ok" && typeof rec.m === "string" && rec.m ? "[stream error] " : "";
      // The note already says "stream error", so the stored message loses its own `stream error after first token:` lead.
      const tail = note === "[stream error] " ? sanitizeDisplay("  (" + rec.m.replace(/^stream error( after first token)?:?\s*/i, "") + ")", 400) : "";
      const text = rec ? [...(note + previewText(rec, 10_000) + tail)] : [];
      const room = INNER - vis("  reply: ");
      if (text.length) reply = p.dim("  reply: ") + (text.length <= room ? text.join("")
        : text.slice(0, Math.max(0, room - vis(g.ell))).join("") + g.ell);
    }
    L.push(bar(g, reply));
  }
  // THE OUTDATED NOTICE: a dedicated line just above the footer (after the `id:` / `reply:` lines, so it never disturbs them),
  // right-aligned, in the warn colour, while MORE than half of the bench records are over 7 days old (its date is the oldest record's). Old results stay visible; this only
  // says so. It costs one line on every list screen, which pick-state's `extraLines` counts (`v.notice` is its own source, so
  // the two cannot disagree). The date is `YYYY-MM-DD` from a validated ISO stamp. Narrow frames drop words from the FRONT in
  // steps and keep the command whole; the last variant fits the 78-column floor.
  if (v.notice) {
    const cmd = "node refresh/bench-cli.mjs --live";
    const variants = [
      `Model Status might be outdated! Last time the list was fully updated was ${v.notice}, run ${cmd} to update your list fully`,
      `Status may be outdated (full update ${v.notice}): ${cmd}`,
      `Outdated since ${v.notice}: ${cmd}`,
    ];
    const text = variants.find((t) => vis(t) <= INNER - 1) ?? variants[variants.length - 1];
    L.push(bar(g, " ".repeat(Math.max(0, INNER - 1 - vis(text))) + p.yel(text)));
  }
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

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

export const FRAME_W = 78;
export const FRAME_MS = 30;

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
                   id: 34, ctx: 6, price: 7, badge: 6, caps: 3 };

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
  frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII = {
  marker: ">", fav: "*", recent: "~",
  dotOk: "*", dotWarn: "$", dotBad: "x", dotStale: "o",
  on: "#", off: ".", check: "OK", arrow: "->", sep: ">", caret: "_", ell: "...", dash: "-",
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
const ctxS = (c) => (c == null ? "" : c >= 1e6 ? `${c / 1e6}M` : `${Math.round(c / 1000)}k`);
const money = (v) => (v == null ? "" : Number(v).toFixed(2));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

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

const bar = (g, body) => {
  const clipped = clipVisible(body, INNER);
  return `${g.frame.v}${clipped}${fill(INNER - vis(clipped))} ${g.frame.v}`;
};

const title = (g, p, text) => {
  const head = `${g.frame.tl}${g.frame.h} ${text} `;
  return p.ramp(head) + g.frame.h.repeat(Math.max(0, FRAME_W - vis(head) - 1)) + g.frame.tr;
};

export const HELP0 = "[↑↓] move  [⇥] scope  [^f] fav  [?] keys  [esc] back";
export const HELP1 = "[↑↓] move  [↵] select  [^f] fav  [?] keys  [esc] back";
const HELP0_A = "[up/dn] move  [tab] scope  [^f] fav  [?] keys  [esc] back";
const HELP1_A = "[up/dn] move  [enter] select  [^f] fav  [?] keys  [esc] back";

const footer = (g, p, text) => {
  const head = `${g.frame.bl} ${text} `;
  return p.dim(head) + g.frame.h.repeat(Math.max(0, FRAME_W - vis(head) - 1)) + g.frame.br;
};

const LEGEND = [
  "up / down      move the cursor",
  "enter          open a provider, or select a model",
  "tab            toggle flat provider/model search",
  "ctrl+f         add or remove a favourite",
  "esc            clear the filter, then go back, then quit",
  "ctrl+c         quit without changing the chat input",
  "?              this legend",
];

export function frame(v, meta, { caps }) {
  const g = glyphsFor(caps), p = painter(caps);
  const L = [];

  const crumb = v.level === 0
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
  const right = v.level === 0
    ? `${meta.providers} providers ${g.sep} ${meta.models} models ${g.sep} ${routableStamp}`
    : `${v.items.length} of ${v.provider.models.length}`;
  const left = `  filter: ${sanitizeDisplay(v.filter, 40)}${p.inv(g.caret)}`;
  const gap = Math.max(1, INNER - vis(left) - vis(right));
  L.push(bar(g, left + " ".repeat(gap) + p.dim(right)));
  L.push(bar(g, ""));

  if (v.legend) {
    for (const line of LEGEND) L.push(bar(g, "  " + line));
    L.push(bar(g, ""));
    L.push(bar(g, p.dim("  any key returns")));
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
  L.push(bar(g, p.dim(v.level === 0
    ? "  " + pad("key id", W.keyId) + rpad("models", W.count) + "   " +
      pad("free", W.bar + W.free) + "  " + pad("health", W.health)
    : "  " + pad("model", W.id) + rpad("ctx", W.ctx) + " " +
      rpad("$in", W.price) + rpad("$out", W.price) + "  " +
      pad("badge", W.badge) + pad("TVR", W.caps))));

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

  v.items.forEach((it, i) => {
    const selected = v.top + i === v.cursor;
    const mark = selected ? g.marker : " ";
    let body;
    if (it.kind === "provider") {
      const r = it.row;
      const total = r.models.length;
      const freeTxt = r.free == null ? g.dash
        : r.planCount ? `${r.free} +${r.planCount} plan` : String(r.free);
      body = `${mark} ` + highlight(pad(r.keyId, W.keyId), v.filter, p) +
             rpad(total, W.count) + "   " +
             proportionBar(r.free, total, g) + " " + pad(freeTxt, W.free - 1) +
             healthDot(r.health, g, p) + " " + pad(r.health, W.health);
    } else if (it.kind === "pinned") {
      body = `${mark} ` + (it.mark === "*" ? p.yel(g.fav) : p.dim(g.recent)) + " " +
             highlight(pad(it.target, W.keyId + W.count), v.filter, p);
    } else {
      const m = it.model;
      const cap = (on, ch, colour) => (on ? p[colour](ch) : p.dim("-"));
      // COLOUR AFTER PADDING, never before. `pad` runs sanitizeDisplay, which
      // strips CSI sequences by design (A3) -- so passing an already-coloured
      // string into it silently deleted the colour and then padded the bare text
      // to W.badge + 9, leaving nine stray spaces. The +9 was wrong on its own
      // terms too: it assumed a 9-character SGR wrapper, but p.dim (used for
      // PAID) is 8 and p.ramp's 256-colour form is 11 or more per character.
      const badgeCell = pad(m.badge, W.badge);
      const badgeOut = badgeColour(m.badge) ? p[badgeColour(m.badge)](badgeCell) : badgeCell;
      body = `${mark} ` + highlight(pad(m.id, W.id), v.filter, p) +
             rpad(ctxS(m.ctx), W.ctx) + " " +
             rpad(money(m.pin), W.price) + rpad(money(m.pout), W.price) + "  " +
             badgeOut +
             cap(m.tools, "T", "cya") + cap(m.vision, "V", "mag") + cap(m.reason, "R", "yel");
      // Q1.3: `routable` is a value on the row, baked in by the refresher. `false`
      // dims; `null` -- nobody checked -- does not, because dimming everything the
      // one time the gateway was unreachable says "nothing works" when the truth
      // is "nothing was asked".
      if (m.routable === false) body = p.dim(strip(body));
    }
    L.push(bar(g, selected ? p.inv(strip(body)) : body));
  });

  if (v.more > 0) L.push(bar(g, p.dim(`  ${g.ell} ${v.more} more`)));
  L.push(footer(g, p, caps.unicode ? (v.level === 0 ? HELP0 : HELP1)
                                   : (v.level === 0 ? HELP0_A : HELP1_A)));
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
  for (let f = frames; f >= 1; f--) {
    const shift = " ".repeat(step * (f - 1));
    out.push(lines.map((l) => (shift + l).slice(0, FRAME_W + shift.length)));
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

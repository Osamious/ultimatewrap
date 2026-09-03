// Every string a provider controls passes through here before it reaches the
// terminal or the routing table.
//
// Report 08 F3: a model id is provider-controlled and lands in a TUI writer with
// zero validation today. \x1b[2J clears the screen, \x1b[1A moves the cursor over
// a row that was already drawn, and \x1b]52;c;<b64>\x07 writes the clipboard on
// terminals with OSC-52 enabled. The bundled catalogue happens to be clean --
// all 4,298 ids are within [A-Za-z0-9._:@/-] and the longest is 50 chars -- but
// that is a property of today's data, not an enforced invariant.
//
// Two different jobs, deliberately separated:
//   sanitizeDisplay  -- for text we are about to draw. Strips, because refusing
//                       to render a row is worse than rendering it plainly.
//   admitId          -- for anything that becomes a routing selector. REJECTS,
//                       because sanitizing would keep an attacker-shaped id in
//                       the routing table with a cosmetic repair.

// CSI (\x1b[ ... final), OSC (\x1b] ... BEL or ST), and the two-character Fe
// escapes. Matched first so the whole sequence goes, not just its introducer.
const ESC_SEQ = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

// Whatever is left: C0 including CR, LF and NUL, DEL, and the C1 range that some
// terminals still interpret as single-byte control introducers.
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;

// Neither C0 nor C1, so both regexes above miss them, and every one of them is a
// display attack that survives an escape stripper:
//   U+200B-U+200D  zero-width space/non-joiner/joiner  -- length without a column
//   U+200E U+200F  LTR/RTL marks
//   U+2028 U+2029  line/paragraph separators           -- a newline by another name
//   U+202A-U+202E  embedding/override, incl. RLO       -- renders a cell reversed
//   U+2066-U+2069  isolates
//   U+FEFF         BOM / zero-width no-break space
// U+202E is the one that matters most: it turns an arbitrary id into a visual
// Anthropic lookalike, which is precisely the attack the denylist exists to stop
// and precisely the one a name-prefix test cannot see.
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeDisplay(s, max = 80) {
  const clean = String(s ?? "")
    .replace(ESC_SEQ, "")
    .replace(CTRL, "")
    .replace(INVISIBLE, "")
    .normalize("NFC");
  // Slice by CODE POINT, not by code unit: `.slice(0, n)` on a string containing
  // an astral character can cut a surrogate pair in half, and a lone surrogate
  // renders as U+FFFD -- one glyph where the caller counted one code unit, which
  // silently breaks the frame-width invariant in style.mjs.
  const cps = [...clean];
  return cps.length <= max ? clean : cps.slice(0, max).join("");
}

// KNOWN LIMIT, deliberately not closed here, and stated precisely because an
// earlier version of this comment claimed more than the code delivers.
//
// What the code-point cap DOES guarantee: a slice never splits a surrogate pair,
// so a lone surrogate can never reach the renderer. What it does NOT guarantee is
// display width. An East Asian wide glyph is one code point occupying two
// terminal columns, so a CJK model id still under-fills its cell and shifts the
// columns to its right.
//
// This cap is therefore only half of a width guarantee, and it is worth nothing
// unless style.mjs measures the same way. It does: `vis()` there counts code
// points and every pad, truncate and frame-fill goes through it. When the two
// disagreed -- this capping by code point while `pad` and `bar` counted UTF-16
// code units -- an astral id produced a frame about thirty columns short that
// sometimes still satisfied the width test. Closing the display-width half needs
// a width table; see the Deferred section.

// `/` is legitimate and common -- `groq/openai/gpt-oss-20b` is a real two-slash
// id -- so it cannot be banned. `\` and `..` can and must be: an id must never
// be able to reach a filesystem path.
//
// The leading `@` is a SCOPE, and it is admitted only when an alphanumeric
// follows it. Cloudflare Workers AI ids are scoped -- `@cf/openai/gpt-oss-120b`
// is the vault's cloudflare.testModel, and that key probes healthy on it -- but
// the original anchor demanded an alphanumeric first character while allowing
// `@` in every later position, so it refused a working provider on punctuation
// rather than on any property worth defending. The alternation widens the
// accepted set by exactly one shape: a bare `@`, `@/foo` and `@-x` stay
// rejected, so no leading separator slips in behind the scope, and the `..`
// check below still applies to scoped ids.
export const MODEL_ID_OK = /^(?:@[A-Za-z0-9]|[A-Za-z0-9])[A-Za-z0-9._:@\/-]{0,127}$/;

export function admitId(id) {
  const s = String(id ?? "");
  if (!MODEL_ID_OK.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}

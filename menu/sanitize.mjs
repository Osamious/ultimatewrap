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

// admitId is a DENYLIST, not an allowlist (D2). Each rule below names something
// provably dangerous; everything it does not name is admitted, including `~`,
// `[`, `]` and any naming convention a provider invents next -- with no source
// edit. That is the inversion: refusing an id is a capability restriction, so
// the burden of proof sits on the refusal, not on the admission.
//
// What the allowlist cost: `/^(?:@[A-Za-z0-9]|[A-Za-z0-9])[A-Za-z0-9._:@\/-]{0,127}$/`
// refused real, safe ids and caught ZERO dangerous ones the rules below would
// not have caught anyway. D2 records 14 distinct ids over bundle + live
// listings. RE-MEASURED HERE over the bundle alone (7,837 distinct bare id
// strings, the only corpus reachable without credentials): 16 refused, in TWO
// shapes rather than one -- 12 leading-`~` floating aliases
// (`~anthropic/claude-opus-latest`, served by kilo and openrouter) and 4 Bedrock
// commitment-tier ids carrying a literal `*`
// (`bedrock/*/1-month-commitment/cohere.command-text-v14`). The `*` class is not
// in D2's table, which is the argument for inverting restated: the allowlist was
// refusing more than anyone had enumerated.
//
// The same shape had already failed once for Cloudflare, and that is the lesson
// the scope rule below preserves rather than repeats: the old anchor demanded an
// alphanumeric first character while allowing `@` in every later position, so it
// refused a working, probe-verified provider on punctuation rather than on any
// property worth defending.
//
// Three of the rules below are the halves of that anchor kept deliberately --
// each costs zero real ids, measured -- and the fourth is D2's size bound:

// Space is 0x20 -- OUTSIDE `CTRL`, which stops at 0x1f -- so no regex above sees
// it, and inverting to a denylist would silently drop the protection the old
// anchor gave for free. That matters beyond tidiness: CCR trims a selector
// before matching, so a reseller advertising `" opus"` would bind `opus` while
// displaying as something else. Zero real ids carry whitespace anywhere.
//
// THIS RULE IS WHY THAT HAZARD DOES NOT GO LIVE WITH THE INVERSION. Ship 0's
// observable (3) -- `#53/A1` in test/denylist.test.mjs -- was written against
// the day this allowlist inverted, on the reading that `" opus"` would become
// admissible. Denying whitespace by name keeps it inadmissible, so that test
// stays a guard against a future relaxation rather than becoming live. Delete
// this rule and it becomes live immediately.
const WHITESPACE = /\s/;

// An id must never be able to look like a flag or a switch on a command line.
// `/` stays legal everywhere else -- `groq/openai/gpt-oss-20b` is a real
// two-slash id -- it is only the LEADING position that is denied. Keeping this
// closes the argv question without having to characterise Claude Code's
// argument parser, at a measured cost of zero ids.
const LEADING_SEP = /^[-\/]/;

// A leading `@` is a SCOPE and is admitted only when an alphanumeric follows it:
// `@cf/openai/gpt-oss-120b` is the vault's cloudflare.testModel and probes
// healthy. A bare `@`, `@/foo`, `@-x` and `@.` stay denied, so no leading
// separator slips in behind the scope. Non-leading `@` is untouched -- it was
// always legal mid-id and 0 corpus ids depend on restricting it.
const BAD_SCOPE = /^@(?![A-Za-z0-9])/;

// `settings.json` is parsed at every Claude Code launch. Counted in CODE POINTS
// for the same reason sanitizeDisplay slices in them: a code-unit count is a
// different number for an astral id, and astral ids are admissible now.
const MAX_CODE_POINTS = 128;

// ESC_SEQ, CTRL and INVISIBLE carry `g` because sanitizeDisplay replaces with
// them, and `.test()` on a `/g` regex ADVANCES `lastIndex` -- so calling it
// twice on the same hostile string returns true, then false. `.search()` is
// specified to ignore `lastIndex` entirely, which keeps admitId a pure function
// of its argument no matter who called it first.
const carries = (re, s) => s.search(re) !== -1;

// KNOWN LIMIT of the inversion, measured and stated rather than implied.
//
// `INVISIBLE` is not the complete set of invisible or bidi-affecting code
// points -- it is the set this file enumerated for the DISPLAY job. The
// allowlist was incidentally denying the rest, because they were simply not in
// `[A-Za-z0-9._:@\/-]`; inverting removes that incidental cover. Measured this
// session, 17 of 17 probed code points outside the class are now admitted AND
// survive `sanitizeDisplay` to the terminal, including U+061C ARABIC LETTER
// MARK (a bidi control of the same family as the U+202E the class calls out),
// the U+E0000-U+E007F TAG block, U+2060 WORD JOINER and U+00AD SOFT HYPHEN.
//
// Deliberately NOT closed here. Widening `INVISIBLE` would change what
// `sanitizeDisplay` strips, and style.mjs's frame-width invariants are measured
// against today's class -- so it is a change with a blast radius beyond this
// module, and D2 scopes this task to reusing the existing regexes rather than
// redefining them.
//
// The ESC_SEQ line below cannot be the SOLE cause of a rejection: every
// alternative of that pattern begins with \x1b, which is 0x1B and therefore
// inside `CTRL`. It is kept because it names the class distinctly, which is
// what lets the refusal reasons (#51) tell an escape sequence from a stray
// control character. No test can kill it while the verdict stays boolean.
export function admitId(id) {
  const s = String(id ?? "");
  if (s === "") return null;
  if (carries(ESC_SEQ, s)) return null;      // terminal escapes
  if (carries(CTRL, s)) return null;         // C0 incl. CR/LF/NUL, DEL, C1
  if (carries(INVISIBLE, s)) return null;    // zero-width, bidi, U+202E RLO
  if (WHITESPACE.test(s)) return null;
  if (s.includes("\\")) return null;         // must never reach a filesystem path
  if (s.includes("..")) return null;         // traversal
  if (LEADING_SEP.test(s)) return null;
  if (BAD_SCOPE.test(s)) return null;
  if ([...s].length > MAX_CODE_POINTS) return null;
  return s;
}

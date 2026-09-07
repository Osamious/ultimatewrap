import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplay, admitId } from "../menu/sanitize.mjs";

test("strips CSI sequences", () => {
  assert.equal(sanitizeDisplay("a\x1b[2Jb"), "ab");
  assert.equal(sanitizeDisplay("\x1b[1A\x1b[31mred\x1b[0m"), "red");
});

test("strips OSC sequences including the clipboard write", () => {
  assert.equal(sanitizeDisplay("x\x1b]52;c;aGk=\x07y"), "xy");
  assert.equal(sanitizeDisplay("x\x1b]0;title\x1b\\y"), "xy");
});

test("strips bare C0 and C1 controls", () => {
  assert.equal(sanitizeDisplay("a\rb\nc\x00d"), "abcd");
  assert.equal(sanitizeDisplay("a\x9bb"), "ab");
});

test("caps length", () => {
  assert.equal(sanitizeDisplay("x".repeat(200)).length, 80);
  assert.equal(sanitizeDisplay("x".repeat(200), 12).length, 12);
});

// Every code point the INVISIBLE class covers, named and tested one by one.
//
// These characters cannot be reviewed by eye in a source literal -- that is the
// whole reason they are a spoofing primitive -- so the fixture names each by code
// point instead. That matters beyond readability: the class itself was once
// written with literal characters, which made sanitize.mjs fail to parse, and the
// obvious repair (retype the class) would have silently dropped whichever ones
// the author could not see while leaving every test green.
const INVISIBLE_CASES = [
  [0x200B, "ZERO WIDTH SPACE"],
  [0x200C, "ZERO WIDTH NON-JOINER"],
  [0x200D, "ZERO WIDTH JOINER"],
  [0x200E, "LEFT-TO-RIGHT MARK"],
  [0x200F, "RIGHT-TO-LEFT MARK"],
  [0x2028, "LINE SEPARATOR"],
  [0x2029, "PARAGRAPH SEPARATOR"],
  [0x202A, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202B, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202C, "POP DIRECTIONAL FORMATTING"],
  [0x202D, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202E, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0xFEFF, "ZERO WIDTH NO-BREAK SPACE (BOM)"],
];

test("every invisible character in the class is stripped, named one by one", () => {
  for (const [cp, name] of INVISIBLE_CASES) {
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    assert.equal(sanitizeDisplay("a" + String.fromCodePoint(cp) + "b"), "ab",
      `U+${hex} ${name} survived sanitizeDisplay`);
  }
});

test("U+2028 and U+2029 are stripped, and are why the class needs escapes", () => {
  // Called out separately from the table because they are the two that break
  // more than alignment. Both are ECMAScript LineTerminators: a regex literal may
  // not contain one, so writing the class with these as literal characters makes
  // sanitize.mjs unparseable -- and style.mjs, catalog.mjs and denylist.mjs all
  // import it. In rendered output they are a newline by another name, which in a
  // full-screen frame writer is a frame-integrity break rather than a cosmetic one.
  for (const cp of [0x2028, 0x2029]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(sanitizeDisplay("row" + ch + "injected"), "rowinjected");
    assert.equal(sanitizeDisplay(ch).length, 0);
  }
});

test("the bidi override that makes an Anthropic lookalike is stripped", () => {
  // U+202E renders the rest of the cell reversed in Windows Terminal, so a model
  // id can display as "claude-3-opus" while being something else entirely -- the
  // one spoof the reserved-name denylist cannot see, because it matches on the
  // stored bytes and this attack is purely a rendering effect.
  const RLO = String.fromCodePoint(0x202E);
  assert.equal(sanitizeDisplay("a" + RLO + "b"), "ab");
  assert.equal(sanitizeDisplay(RLO + "supo-3-edualc"), "supo-3-edualc");
});

test("zero-width characters consume length without occupying a column", () => {
  const ZWSP = String.fromCodePoint(0x200B), BOM = String.fromCodePoint(0xFEFF);
  assert.equal(sanitizeDisplay("a" + ZWSP + "b" + BOM + "c"), "abc");
  assert.equal(sanitizeDisplay("a" + ZWSP + "b", 2), "ab");   // the cap sees 2 real columns, not 3
});

test("the length cap counts code points, never UTF-16 code units", () => {
  // Two astral characters are 4 code units. A code-unit slice at 3 would emit a
  // lone surrogate, which renders as a replacement character and corrupts the
  // frame width. A code-point slice at 1 emits one whole character.
  const astral = "\u{1F600}\u{1F601}";
  assert.equal([...sanitizeDisplay(astral, 1)].length, 1);
  assert.equal(sanitizeDisplay(astral, 1), "\u{1F600}");
  assert.equal([...sanitizeDisplay(astral, 2)].length, 2);
});

test("normalises to NFC so a combining mark cannot pad a cell invisibly", () => {
  assert.equal(sanitizeDisplay("é"), "é");
  assert.equal([...sanitizeDisplay("é")].length, 1);
});

test("passes ordinary model ids through unchanged", () => {
  assert.equal(sanitizeDisplay("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b");
});

test("handles null and undefined without throwing", () => {
  assert.equal(sanitizeDisplay(null), "");
  assert.equal(sanitizeDisplay(undefined), "");
});

test("admitId accepts real ids, including two-slash ones", () => {
  assert.equal(admitId("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b");
  assert.equal(admitId("deepseek-v3.2"), "deepseek-v3.2");
  assert.equal(admitId("google/gemma-4-26b-a4b-it:free"), "google/gemma-4-26b-a4b-it:free");
});

test("admitId rejects rather than sanitizes", () => {
  assert.equal(admitId("a\x1b[2Jb"), null);
  assert.equal(admitId("../../etc/passwd"), null);
  assert.equal(admitId("a..b"), null);
  assert.equal(admitId("back\\slash"), null);
  assert.equal(admitId("-leading-dash"), null);
  assert.equal(admitId("x".repeat(129)), null);
  assert.equal(admitId(""), null);
  assert.equal(admitId(null), null);
});

test("admitId accepts a scoped id whose leading @ is followed by an alphanumeric", () => {
  // Measured, not hypothetical: `@cf/openai/gpt-oss-120b` is the vault's
  // cloudflare.testModel, and the recorded health for personal.cloudflare.free
  // is `ok` on that exact id. The original anchor required the first character
  // to be alphanumeric while allowing `@` everywhere after it, so a working,
  // probe-verified provider was being refused by punctuation rather than by any
  // security property.
  assert.equal(admitId("@cf/openai/gpt-oss-120b"), "@cf/openai/gpt-oss-120b");
  assert.equal(admitId("@a"), "@a");
});

test("admitId rejects an @ that does not begin a scope", () => {
  // Exactly one shape is added: @ followed by an alphanumeric. A bare @, or an @
  // followed by punctuation, stays rejected -- otherwise the widening would admit
  // a leading-separator id through the back door.
  assert.equal(admitId("@"), null);
  assert.equal(admitId("@/foo"), null);
  assert.equal(admitId("@-x"), null);
  assert.equal(admitId("@."), null);
  assert.equal(admitId("@@a"), null);
});

test("widening the anchor for @ refuses everything it refused before", () => {
  // The regression half of the widening. Each of these was rejected by the
  // original anchor and must still be rejected by the new one.
  assert.equal(admitId("a\x1b[2Jb"), null);          // escape sequence
  assert.equal(admitId("-leading-dash"), null);      // leading separator
  assert.equal(admitId("/leading-slash"), null);     // leading separator
  assert.equal(admitId("../../etc/passwd"), null);   // traversal
  assert.equal(admitId("@cf/../../etc/passwd"), null); // traversal behind a scope
  assert.equal(admitId("back\\slash"), null);        // path separator
  assert.equal(admitId("x".repeat(129)), null);      // over length
  assert.equal(admitId(""), null);
  assert.equal(admitId(null), null);
});

// ---------------------------------------------------------------------------
// R2 / D2: admitId is a DENYLIST. One test per denied class, each carrying a
// positive control that the class must NOT catch -- because the whole point of
// the inversion is that the denials stay narrow.
// ---------------------------------------------------------------------------

test("D2: the real ids the allowlist refused are now admitted, unchanged", () => {
  // Measured over the bundled catalogue this session: 16 distinct bare id
  // strings were refused, in exactly two shapes, and neither is dangerous.
  // 12 leading-`~` floating aliases, served by kilo and openrouter:
  assert.equal(admitId("~anthropic/claude-opus-latest"), "~anthropic/claude-opus-latest");
  assert.equal(admitId("~z-ai/glm-latest"), "~z-ai/glm-latest");
  assert.equal(admitId("~deepseek/deepseek-v4-flash-latest"), "~deepseek/deepseek-v4-flash-latest");
  // and 4 Bedrock commitment-tier ids carrying a literal `*`, which the
  // decision's own table does not enumerate -- the allowlist was refusing more
  // than anyone had counted, which is the argument for inverting it.
  assert.equal(
    admitId("bedrock/*/1-month-commitment/cohere.command-text-v14"),
    "bedrock/*/1-month-commitment/cohere.command-text-v14");
  // The bracketed id, from the live listing rather than the bundle.
  assert.equal(admitId("teamorouter/kimi-k3[1M]"), "teamorouter/kimi-k3[1M]");
});

test("D2 denial: escape sequences -- control admits brackets", () => {
  assert.equal(admitId("a\x1b[2Jb"), null);
  assert.equal(admitId("x\x1b]52;c;aGk=\x07y"), null);
  assert.equal(admitId("\x1b[1Aoverwrite"), null);
  // `[` and `]` alone are not an escape and must survive the class.
  assert.equal(admitId("kimi-k3[1M]"), "kimi-k3[1M]");
});

test("D2 denial: C0/C1 control characters -- control admits U+00FF", () => {
  assert.equal(admitId("a\x00b"), null);
  assert.equal(admitId("a\rb"), null);
  assert.equal(admitId("a\nb"), null);
  assert.equal(admitId("a\x7fb"), null);
  assert.equal(admitId("a\x9bb"), null);
  // U+00FF sits directly above the C1 range the class ends at, so a denial that
  // over-reached past \x9f would catch it.
  assert.equal(admitId("cafÿ-v1"), "cafÿ-v1");
});

test("D2 denial: every invisible in the class is refused, named one by one", () => {
  // Reuses the same table sanitizeDisplay is checked against, so the two jobs
  // cannot drift: a code point that stops being stripped must also stop being
  // admitted, and vice versa.
  for (const [cp, name] of INVISIBLE_CASES) {
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    assert.equal(admitId("a" + String.fromCodePoint(cp) + "b"), null,
      `U+${hex} ${name} was admitted as a routing selector`);
  }
  // The RLO specifically -- the Anthropic-lookalike primitive.
  assert.equal(admitId("a" + String.fromCodePoint(0x202E) + "b"), null);
});

test("D2 denial: whitespace anywhere -- control admits - _ and . separators", () => {
  // A1, and the one row whose omission would be a security regression rather
  // than a reach cost. Space is 0x20, OUTSIDE the C0 range CTRL covers, so no
  // other rule sees it. CCR trims a selector before matching, so `" opus"`
  // would bind `opus` while displaying as something else.
  assert.equal(admitId(" opus"), null);
  assert.equal(admitId("opus "), null);
  assert.equal(admitId("claude opus"), null);
  assert.equal(admitId("a\tb"), null);
  assert.equal(admitId("a b"), null);   // NO-BREAK SPACE
  assert.equal(admitId("a　b"), null);   // IDEOGRAPHIC SPACE
  // The separators real ids actually use are untouched.
  assert.equal(admitId("gpt-oss-20b"), "gpt-oss-20b");
  assert.equal(admitId("deepseek_v3"), "deepseek_v3");
  assert.equal(admitId("deepseek-v3.2"), "deepseek-v3.2");
});

test("D2 denial: backslash -- control admits forward slashes", () => {
  assert.equal(admitId("back\\slash"), null);
  assert.equal(admitId("..\\..\\etc"), null);
  assert.equal(admitId("a\\"), null);
  // `/` is legal everywhere but the first position: this is a real two-slash id.
  assert.equal(admitId("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b");
});

test("D2 denial: traversal -- control admits a single dot", () => {
  assert.equal(admitId("a..b"), null);
  assert.equal(admitId("../../etc/passwd"), null);
  assert.equal(admitId("@cf/../../etc/passwd"), null);
  assert.equal(admitId("model.."), null);
  // One dot is ordinary and extremely common.
  assert.equal(admitId("deepseek-v3.2"), "deepseek-v3.2");
  assert.equal(admitId("cohere.command-text-v14"), "cohere.command-text-v14");
});

test("D2 denial: leading separator -- control admits ~ and mid-id separators", () => {
  // Denied so an id can never look like a flag or a switch on a command line,
  // at a measured cost of zero real ids. This is the half of the old anchor
  // that is CARRIED FORWARD rather than dropped.
  assert.equal(admitId("-lead"), null);
  assert.equal(admitId("/lead"), null);
  assert.equal(admitId("--help"), null);
  // A leading `~` is NOT a separator, and admitting it is the whole point.
  assert.equal(admitId("~openai/gpt-latest"), "~openai/gpt-latest");
  assert.equal(admitId("_lead"), "_lead");
  assert.equal(admitId("a-b/c-d"), "a-b/c-d");
});

test("D2 denial: a leading @ that does not open a scope", () => {
  assert.equal(admitId("@"), null);
  assert.equal(admitId("@/foo"), null);
  assert.equal(admitId("@-x"), null);
  assert.equal(admitId("@."), null);
  assert.equal(admitId("@@a"), null);
  // Only the LEADING position is constrained -- `@` mid-id was always legal and
  // 0 corpus ids depend on restricting it.
  assert.equal(admitId("@cf/openai/gpt-oss-120b"), "@cf/openai/gpt-oss-120b");
  assert.equal(admitId("model@v2"), "model@v2");
  // The anchor itself, pinned. Dropping the `^` turns a carried-forward rule
  // into a NEW restriction D2 never authorised: every `@` in the string would
  // then need an alphanumeric after it, which no measurement supports and which
  // could refuse a future real id. A trailing `@` is not dangerous, so it is
  // admitted -- and this is the only assertion that can tell the two apart.
  assert.equal(admitId("model@"), "model@");
  assert.equal(admitId("a@-b"), "a@-b");
});

test("D2 denial: over 128 CODE POINTS, not code units", () => {
  // The mutation boundary. 128 admits, 129 denies.
  assert.equal(admitId("x".repeat(128)), "x".repeat(128));
  assert.equal(admitId("x".repeat(129)), null);
  // An astral character is one code point and TWO code units. A cap counting
  // code units would refuse this at 128 code points / 256 units; the spec says
  // code points, so it admits.
  const astral128 = "\u{1F600}".repeat(128);
  assert.equal(astral128.length, 256);
  assert.equal([...astral128].length, 128);
  assert.equal(admitId(astral128), astral128);
  assert.equal(admitId("\u{1F600}".repeat(129)), null);
});

test("D2 denial: the empty id, and the nullish inputs that produce it", () => {
  // A denylist admits whatever it does not name, so emptiness has to be named.
  assert.equal(admitId(""), null);
  assert.equal(admitId(null), null);
  assert.equal(admitId(undefined), null);
});

test("admitId is a pure function of its argument across repeated calls", () => {
  // ESC_SEQ, CTRL and INVISIBLE carry `g` because sanitizeDisplay replaces with
  // them. `.test()` on a /g regex advances lastIndex, so a test-based
  // implementation returns true then false for the SAME hostile string -- the
  // second call admitting it. Interleave with sanitizeDisplay, which also
  // drives those regexes, so a shared-state bug cannot hide.
  const hostile = "a\x1b[2Jb";
  for (let i = 0; i < 4; i++) {
    assert.equal(admitId(hostile), null, `call ${i + 1} admitted a hostile id`);
    sanitizeDisplay(hostile);
    assert.equal(admitId("a" + String.fromCodePoint(0x202E) + "b"), null, `call ${i + 1}`);
    assert.equal(admitId("a\x00b"), null, `call ${i + 1}`);
    assert.equal(admitId("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b", `call ${i + 1}`);
  }
});

test("widening admission did not widen rendering", () => {
  // sanitizeDisplay decides what may be PRINTED; admitId decides what may be
  // HELD. They are different jobs, and inverting the second must not relax the
  // first. Every newly-admitted shape renders as itself...
  for (const id of [
    "~anthropic/claude-opus-latest",
    "teamorouter/kimi-k3[1M]",
    "bedrock/*/1-month-commitment/cohere.command-text-v14",
  ]) {
    assert.equal(sanitizeDisplay(id, 120), id);
  }
  // ...and the strings admitId still refuses are still stripped on the display
  // path, which is the path that runs whether or not admitId was consulted.
  assert.equal(sanitizeDisplay("a\x1b[2Jb"), "ab");
  assert.equal(sanitizeDisplay("a" + String.fromCodePoint(0x202E) + "b"), "ab");
  assert.equal(sanitizeDisplay("a\x00b"), "ab");
});

test("no id admitId admits can carry an escape, a control, or a listed invisible", () => {
  // The invariant that keeps the two jobs consistent, asserted as a property
  // rather than a case list: anything that survives admission is already a
  // fixpoint of the stripping half of sanitizeDisplay.
  const cases = [
    "~anthropic/claude-opus-latest", "teamorouter/kimi-k3[1M]", "@cf/openai/gpt-oss-120b",
    "groq/openai/gpt-oss-20b", "bedrock/*/6-month-commitment/cohere.command-text-v14",
    "a\x1b[2Jb", "a\x00b", "a" + String.fromCodePoint(0x202E) + "b", " opus", "-lead",
    "deepseek-v3.2", "cafÿ-v1",
  ];
  for (const c of cases) {
    const admitted = admitId(c);
    if (admitted === null) continue;
    for (const [cp, name] of INVISIBLE_CASES) {
      assert.equal(admitted.includes(String.fromCodePoint(cp)), false,
        `admitted ${JSON.stringify(c)} carries U+${cp.toString(16).toUpperCase()} ${name}`);
    }
    assert.equal(/[\x00-\x1f\x7f-\x9f]/.test(admitted), false,
      `admitted ${JSON.stringify(c)} carries a control character`);
  }
});

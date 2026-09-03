import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplay, admitId, MODEL_ID_OK } from "../menu/sanitize.mjs";

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

test("MODEL_ID_OK is anchored at both ends", () => {
  assert.equal(MODEL_ID_OK.source.startsWith("^"), true);
  assert.equal(MODEL_ID_OK.source.endsWith("$"), true);
});

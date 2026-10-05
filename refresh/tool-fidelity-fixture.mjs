// The tool-fidelity fixture (issue #121): a SYNTHETIC set of tool schemas shaped like a real coding agent's, plus a system prompt,
// built by rule so it is the same bytes on every run. It is never a replayed real request (privacy); nothing in it comes from a log.
//
// WHY IT IS BIG. The failures this probe exists to find (a provider that 400s on one construct, a free tier that refuses a request
// over ~100 KB) only show on a request that looks like a real session's: about 157 KB of tool schemas and a ~9 KB system prompt,
// including the constructs that broke real providers (a maximum of 9007199254740991, anyOf, const, a lookahead regex).
//
// WHEN IT CHANGES. Any edit to the bytes below must bump FIXTURE_ID, because every stored result names the fixture it was measured
// against and an outdated one is shown with a `*` (re-sweep recommended). test/tool-fidelity-fixture.test.mjs pins the digest, so
// a silent edit fails a test instead of quietly leaving old results labelled as current.

import crypto from "node:crypto";

export const FIXTURE_ID = "cc-tools-1";
export const TARGET_BYTES = 157000;          // the request body the L3 and L4 levels send, about 40,000 input tokens
export const SYSTEM_BYTES = 9000;

// The BIG step (about 400 KB, about 100,000 input tokens): run only for models that passed the 157 KB level. Same construction, more tools.
export const BIG_FIXTURE_ID = "cc-tools-big-1";
export const BIG_TARGET_BYTES = 400000;
/** The tool every level asks the model to call. It is in the small L1/L2 request and inside the big fixture set. */
export const ECHO_TOOL = "fx_echo";

const WORDS = ("the tool reads a file from the local workspace and returns its contents with line numbers; paths must be absolute; "
  + "large files are truncated and the caller may pass an offset and a limit; binary files are refused; the result is plain text; "
  + "when a path does not exist the tool reports an error instead of creating it; never guess a path, ask for the listing first; ").split(";");

/** A paragraph of deterministic filler, at least `n` characters long. */
function filler(seed, n) {
  let out = "", i = seed;
  while (out.length < n) { out += `${WORDS[i % WORDS.length].trim()}. `; i += 1; }
  return out.slice(0, n);
}

const echoTool = () => ({
  name: ECHO_TOOL,
  description: "Echo a short message back. Used to check that the model can form a well-formed tool call.",
  input_schema: { type: "object", properties: { message: { type: "string", description: "the text to echo" } }, required: ["message"] },
});

/** The small tool of the L1 and L2 requests: one required string, nothing awkward. */
export const smallTools = () => [echoTool()];

const KINDS = ["read", "write", "edit", "search", "list", "run", "fetch", "plan", "notify", "diff", "move", "stat", "grep", "glob", "task", "note"];

/** One synthetic tool: a long description and a schema that carries the awkward constructs in rotation. */
function bigTool(i, descLen) {
  const kind = KINDS[i % KINDS.length];
  const props = {
    path: { type: "string", description: filler(i, 160), pattern: "^(?=.{1,512}$)(?!.*\\.\\.)[^\\0]+$" },
    mode: { const: kind, description: "fixed mode of this tool" },
    limit: { type: "integer", minimum: 0, maximum: 9007199254740991, description: filler(i + 1, 140) },
    offset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }], description: filler(i + 2, 120) },
    flags: { type: "array", items: { type: "string", enum: ["a", "b", "c", "d"] }, minItems: 0, maxItems: 16, uniqueItems: true },
    options: {
      type: "object", additionalProperties: false,
      properties: { recursive: { type: "boolean" }, depth: { type: "integer", minimum: 1, maximum: 64 }, name: { type: "string", pattern: "^(?=.*[a-z])[a-z0-9_.-]{1,64}$" } },
    },
  };
  for (let k = 0; k < 8; k++) props[`extra_${k}`] = { type: k % 2 ? "string" : "number", description: filler(i * 8 + k, 200) };
  return {
    name: `fx_${kind}_${i}`,
    description: filler(i * 3, descLen),
    input_schema: { type: "object", properties: props, required: ["path", "mode"], additionalProperties: false },
  };
}

const sysPrompt = () => {
  let s = "You are a coding assistant working inside a local workspace. This text is a synthetic stand-in for a long system prompt.\n";
  for (let i = 0; s.length < SYSTEM_BYTES; i++) s += `Rule ${i + 1}: ${filler(i * 5, 180)}\n`;
  return s.slice(0, SYSTEM_BYTES);
};

function build(count, target) {
  const system = sysPrompt();
  const make = (descLen) => [echoTool(), ...Array.from({ length: count }, (_, i) => bigTool(i, descLen))];
  const bytes = (descLen) => Buffer.byteLength(JSON.stringify({ system, tools: make(descLen) }));
  // grow the description until the whole set reaches the target, then stop on the last length that fits
  let lo = 100, hi = 8000;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytes(mid) <= target - 250) lo = mid; else hi = mid - 1; }
  return { system, tools: make(lo) };
}

const built = build(40, TARGET_BYTES);
const builtBig = build(100, BIG_TARGET_BYTES);
/** The fixture: `{id, system, tools}`. Frozen copies are not needed; callers receive a fresh deep copy. */
export const fixture = () => ({ id: FIXTURE_ID, system: built.system, tools: structuredClone(built.tools) });

/** sha256 of the fixture bytes (the digest the test pins). */
export const fixtureDigest = () => crypto.createHash("sha256").update(JSON.stringify({ id: FIXTURE_ID, system: built.system, tools: built.tools })).digest("hex");

/** The big fixture: `{id, system, tools}`, a fresh deep copy. */
export const bigFixture = () => ({ id: BIG_FIXTURE_ID, system: builtBig.system, tools: structuredClone(builtBig.tools) });
export const bigDigest = () => crypto.createHash("sha256").update(JSON.stringify({ id: BIG_FIXTURE_ID, system: builtBig.system, tools: builtBig.tools })).digest("hex");

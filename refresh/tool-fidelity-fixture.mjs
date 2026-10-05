// The tool-fidelity fixtures (issue #121): SYNTHETIC tool schemas shaped like a real coding agent's, plus the small request material of the other probes, built by
// rule so it is the same bytes on every run. Never a replayed real request (privacy); nothing in it comes from a log.
//
// WHY THE BIG ONES ARE BIG. The failures this probe exists to find (a provider that 400s on one construct, a free tier that refuses a request over ~100 KB) only show on a
// request that looks like a real session's: about 157 KB of tool schemas and a ~9 KB system prompt, including the constructs that broke real providers (a maximum of
// 9007199254740991, anyOf, const, a lookahead regex, MCP-style long tool names). The ~6 KB `constructsTools` carry the same constructs alone, so a construct rejection is found
// before a model is sent 40,000 tokens.
//
// WHEN IT CHANGES. Any edit to the bytes below must bump FIXTURE_ID (and BIG_FIXTURE_ID for the 400 KB set), because every stored result names the fixture it was measured
// against and an outdated one is shown with a `*` (re-sweep recommended). test/tool-fidelity-fixture.test.mjs pins the digests, so a silent edit fails a test instead of quietly
// leaving old results labelled as current.

import crypto from "node:crypto";

export const FIXTURE_ID = "cc-tools-2";
export const TARGET_BYTES = 157000;          // the request body the L3 step sends, about 40,000 input tokens
export const SYSTEM_BYTES = 9000;

// The BIG step (about 400 KB, about 100,000 input tokens): run only for models that passed the 157 KB level. Same construction, more tools.
export const BIG_FIXTURE_ID = "cc-tools-big-2";
export const BIG_TARGET_BYTES = 400000;

/** The tool the L2, L3 and big requests ask the model to call. */
export const ECHO_TOOL = "fx_echo";
/** The Edit-style tool of L1 (argument fidelity), the Read-style tool of L2 and the Agent tool of the spawn probe. */
export const EDIT_TOOL = "fx_edit", READ_TOOL = "fx_read", AGENT_TOOL = "Agent";
/** An MCP-style long tool name (about 60 characters, underscores), in the 157 KB set and in the constructs request. */
export const LONG_TOOL = "mcp__plugin_demo__a_long_tool_name_for_testing_construct_x";
export const AGENT_TYPES = Object.freeze(["general-purpose", "Explore", "Plan", "code-reviewer"]);
export const CACHE_CONTROL = Object.freeze({ type: "ephemeral" });

const WORDS = ("the tool reads a file from the local workspace and returns its contents with line numbers; paths must be absolute; "
  + "large files are truncated and the caller may pass an offset and a limit; binary files are refused; the result is plain text; "
  + "when a path does not exist the tool reports an error instead of creating it; never guess a path, ask for the listing first; ").split(";");

/** A paragraph of deterministic filler, at least `n` characters long. */
function filler(seed, n) {
  let out = "", i = seed;
  while (out.length < n) { out += `${WORDS[i % WORDS.length].trim()}. `; i += 1; }
  return out.slice(0, n);
}

// ------------------------------------------------------------------ the small tools of the cheap levels

export const echoTool = () => ({
  name: ECHO_TOOL,
  description: "Echo a short message back. Used to check that the model can form a well-formed tool call.",
  input_schema: { type: "object", properties: { message: { type: "string", description: "the text to echo" } }, required: ["message"] },
});
/** Edit-style: strings (one of them multi-line), a boolean and an integer. */
export const editTool = () => ({
  name: EDIT_TOOL,
  description: "Replace text in a file. old_string must match exactly, new_string replaces it.",
  input_schema: { type: "object", properties: {
    file_path: { type: "string", description: "absolute path of the file" }, old_string: { type: "string", description: "the exact text to replace" },
    new_string: { type: "string", description: "the replacement text" }, replace_all: { type: "boolean", description: "replace every occurrence" },
    start_line: { type: "integer", description: "1-based line to start from" } }, required: ["file_path", "old_string", "new_string"] },
});
/** Read-style: a path and two integers. */
export const readTool = () => ({
  name: READ_TOOL,
  description: "Read a file from the workspace.",
  input_schema: { type: "object", properties: { file_path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } }, required: ["file_path"] },
});
/** The Task/Agent tool as Claude Code presents it: description, prompt and a subagent type from a small enum. */
export const agentTool = () => ({
  name: AGENT_TOOL,
  description: "Launch a sub-agent to handle a complex, multi-step task autonomously. Use it to investigate independent parts of a problem in parallel. Provide a short description and a complete, self-contained prompt.",
  input_schema: { type: "object", properties: {
    description: { type: "string", description: "a short (3-5 word) description of the task" }, prompt: { type: "string", description: "the task for the agent to perform" },
    subagent_type: { type: "string", enum: [...AGENT_TYPES], description: "the type of specialized agent to use" } }, required: ["description", "prompt", "subagent_type"], additionalProperties: false },
});

/** The Edit-style argument-fidelity case: every field must come back byte for byte, the boolean a boolean, the integer an integer. */
export const AWKWARD = Object.freeze({
  file_path: "C:\\Users\\demo\\notes\\todo.md",
  old_string: "line one\n\tindented \"quoted\" it's here\nbackslashes \\ and a literal \\n and C:\\temp\\new\n{\"key\": \"va\\\"lue\", \"n\": [1, 2.5, null]}\nunicode: caf\u00e9 \u00f1 \u65e5\u672c\u8a9e \ud83d\ude80 end",
  new_string: "{\"done\": true, \"items\": [\"a\\tb\", \"c\\\\d\"], \"note\": \"say \\\"hi\\\"\"}\nsecond line \u2713 \ud83d\ude80",
  replace_all: true,
  start_line: 12,
});

/** About 20 KB of deterministic report text whose LAST line carries the fact the model must use (the question is answerable only by reading to the end). */
export const BIG_RESULT_FACT = "ZK-7731-QX";
export const bigResult = () => {
  let s = "";
  for (let i = 0; s.length < 19800; i++) s += `${String(i + 1).padStart(4, "0")}  ${filler(i * 7, 90)}\n`;
  return `${s}END OF REPORT. The deployment code of this release is ${BIG_RESULT_FACT}.\n`;
};
export const ERROR_RESULT = "Error: ENOENT: no such file or directory, open '/ws/missing.txt'";

/** The small tools of L1: the Edit-style tool. (L2 sends the Read-style tool, the error case too.) */
export const smallTools = () => [echoTool()];      // L1: a plain echo call
/** The tools of the argument-fidelity request (1a): an Edit-style call with awkward content. */
export const awkwardTools = () => [editTool()];

// ------------------------------------------------------------------ the constructs request (L3a, about 6 KB)

/** Three tools carrying the awkward constructs, one with an MCP-style long name; the last one carries the cache_control marker the real client sends. */
export function constructsTools() {
  const long = {
    name: LONG_TOOL, description: "A tool with a long MCP-style name and a schema that uses the constructs some providers reject.",
    input_schema: { type: "object", properties: {
      mode: { const: "demo", description: "fixed mode" }, limit: { type: "integer", minimum: 0, maximum: 9007199254740991 },
      offset: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] }, path: { type: "string", pattern: "^(?=.{1,512}$)(?!.*\\.\\.)[^\\0]+$" },
      flags: { type: "array", items: { type: "string", enum: ["a", "b", "c", "d"] }, minItems: 0, maxItems: 16, uniqueItems: true },
      options: { type: "object", additionalProperties: false, properties: { recursive: { type: "boolean" }, depth: { type: "integer", minimum: 1, maximum: 64 } } } },
      required: ["mode"], additionalProperties: false },
  };
  return [long, bigTool(0, 300), { ...echoTool(), cache_control: { ...CACHE_CONTROL } }];
}

// ------------------------------------------------------------------ the big fixtures

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

/** MCP-style tools of assorted long names, as a real session with MCP servers carries them. */
const mcpTools = () => ["mcp__plugin_demo__list_things_in_the_workspace_with_filters", "mcp__plugin_other__fetch_remote_resource_by_identifier_x", LONG_TOOL]
  .map((name, i) => ({ name, description: filler(i * 11, 400), input_schema: { type: "object", properties: { query: { type: "string", description: filler(i, 120) }, limit: { type: "integer", maximum: 9007199254740991 } }, required: ["query"] } }));

const sysPrompt = () => {
  let s = "You are a coding assistant working inside a local workspace. This text is a synthetic stand-in for a long system prompt.\n";
  for (let i = 0; s.length < SYSTEM_BYTES; i++) s += `Rule ${i + 1}: ${filler(i * 5, 180)}\n`;
  return s.slice(0, SYSTEM_BYTES);
};

function build(count, target) {
  const system = sysPrompt();
  const make = (descLen) => [echoTool(), ...mcpTools(), ...Array.from({ length: count }, (_, i) => bigTool(i, descLen))];
  const bytes = (descLen) => Buffer.byteLength(JSON.stringify({ system, tools: make(descLen) }));
  // grow the description until the whole set reaches the target, then stop on the last length that fits
  let lo = 100, hi = 8000;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytes(mid) <= target - 450) lo = mid; else hi = mid - 1; }
  return { system, tools: make(lo) };
}

const built = build(40, TARGET_BYTES);
const builtBig = build(100, BIG_TARGET_BYTES);
/** The fixture: `{id, system, tools}`. Callers receive a fresh deep copy. */
export const fixture = () => ({ id: FIXTURE_ID, system: built.system, tools: structuredClone(built.tools) });
/** The big fixture: `{id, system, tools}`, a fresh deep copy. */
export const bigFixture = () => ({ id: BIG_FIXTURE_ID, system: builtBig.system, tools: structuredClone(builtBig.tools) });

const sha = (x) => crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex");
/** sha256 of the fixture bytes (the digests the test pins). */
export const fixtureDigest = () => sha({ id: FIXTURE_ID, system: built.system, tools: built.tools });
export const bigDigest = () => sha({ id: BIG_FIXTURE_ID, system: builtBig.system, tools: builtBig.tools });
/** sha256 of the small request material: the edit/read/agent tools, the awkward strings, the 20 KB result, the constructs tools. */
export const smallDigest = () => sha({ id: FIXTURE_ID, edit: editTool(), read: readTool(), agent: agentTool(), echo: echoTool(), awkward: AWKWARD, result: bigResult(), error: ERROR_RESULT, constructs: constructsTools() });

// The synthetic tool-fidelity fixtures: sizes, awkward constructs, MCP-style names, and identity (a changed byte must bump the fixture id).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import {
  fixture, fixtureDigest, bigFixture, bigDigest, smallDigest, constructsTools, bigResult, AWKWARD, agentTool, editTool, readTool, echoTool, smallTools,
  FIXTURE_ID, BIG_FIXTURE_ID, BIG_TARGET_BYTES, TARGET_BYTES, SYSTEM_BYTES, ECHO_TOOL, LONG_TOOL, BIG_RESULT_FACT, AGENT_TYPES, CACHE_CONTROL,
} from "../refresh/tool-fidelity-fixture.mjs";
import { buildBody, kindSize } from "../refresh/tool-fidelity-probe.mjs";

guardRealState(after, assert);

// Changing a fixture changes its digest. Bump FIXTURE_ID (BIG_FIXTURE_ID for the 400 KB set) in refresh/tool-fidelity-fixture.mjs, THEN update the pins below:
// stored results name the fixture they were measured against, and an old id is what earns a record its `*`.
const PINNED = { id: "cc-tools-2", digest: "22ec737ad613", small: "278d714ab88b" };
const PINNED_BIG = { id: "cc-tools-big-2", digest: "bde1981556e4" };

test("the fixtures are pinned: each digest matches the id it carries (an edit without an id bump fails here)", () => {
  assert.equal(FIXTURE_ID, PINNED.id);
  assert.equal(fixtureDigest().slice(0, PINNED.digest.length), PINNED.digest, "the 157 KB fixture bytes changed: bump FIXTURE_ID, then update PINNED");
  assert.equal(smallDigest().slice(0, PINNED.small.length), PINNED.small, "the small request material changed (edit/read/agent tools, awkward strings, the 20 KB result, the constructs tools): bump FIXTURE_ID, then update PINNED.small");
  assert.equal(BIG_FIXTURE_ID, PINNED_BIG.id);
  assert.equal(bigDigest().slice(0, PINNED_BIG.digest.length), PINNED_BIG.digest, "the big fixture bytes changed: bump BIG_FIXTURE_ID, then update PINNED_BIG");
});

test("the 3b request is about 157 KB with a ~9 KB system prompt; the big one about 400 KB; the constructs request a few KB", () => {
  const f = fixture();
  assert.equal(f.system.length, SYSTEM_BYTES);
  assert.ok(Math.abs(kindSize("3b").bytes - TARGET_BYTES) < 0.02 * TARGET_BYTES, `${kindSize("3b").bytes} bytes against a target of ${TARGET_BYTES}`);
  assert.ok(Math.abs(kindSize("5").bytes - BIG_TARGET_BYTES) < 0.02 * BIG_TARGET_BYTES, `${kindSize("5").bytes} bytes against a target of ${BIG_TARGET_BYTES}`);
  assert.ok(kindSize("3a").bytes < 12000 && JSON.stringify(constructsTools()).length < 6000, "3a is the constructs alone");
  assert.ok(bigFixture().tools.length > f.tools.length * 2);
});

test("the constructs that broke real providers are in the 157 KB set AND alone in the constructs request: maximum 9007199254740991, anyOf, const, a lookahead regex, additionalProperties false, uniqueItems, enum, an MCP-style long name", () => {
  for (const [name, tools] of [["157 KB set", fixture().tools], ["constructs", constructsTools()], ["big set", bigFixture().tools]]) {
    const text = JSON.stringify(tools);
    for (const needle of ['"maximum":9007199254740991', '"anyOf"', '"const"', "(?=", '"additionalProperties":false', '"uniqueItems":true', '"enum"']) assert.ok(text.includes(needle), `${name}: ${needle}`);
    assert.ok(tools.some((t) => t.name === LONG_TOOL), `${name}: the long name`);
  }
  assert.ok(LONG_TOOL.length >= 55 && LONG_TOOL.length <= 64 && /^mcp__[a-z_]+$/.test(LONG_TOOL), `about 60 characters, underscores: ${LONG_TOOL.length}`);
  assert.ok(fixture().tools.filter((t) => t.name.startsWith("mcp__")).length >= 3, "several MCP-style names, as a real session carries");
  assert.ok(fixture().tools.every((t) => /^[A-Za-z0-9_-]{1,64}$/.test(t.name)), "every name is a legal tool name");
});

test("the argument-fidelity case is awkward on purpose: multi-line text, quotes, backslashes, unicode (also astral), JSON inside a string, a boolean and an integer", () => {
  const o = AWKWARD.old_string;
  assert.ok(o.includes("\n") && o.includes("\t") && o.includes('"') && o.includes(String.fromCharCode(92)) && /[^\x00-\x7f]/.test(o) && /\p{Extended_Pictographic}/u.test(o) && o.includes('{"key"'));
  assert.equal(typeof AWKWARD.replace_all, "boolean");
  assert.ok(Number.isInteger(AWKWARD.start_line));
  assert.doesNotThrow(() => JSON.parse(AWKWARD.new_string.split("\n")[0]), "the JSON inside the string really is JSON");
  assert.deepEqual(JSON.parse(JSON.stringify(AWKWARD)), JSON.parse(JSON.stringify(AWKWARD)));
  assert.equal(editTool().input_schema.properties.start_line.type, "integer");
  assert.equal(readTool().input_schema.properties.offset.type, "integer");
});

test("the 20 KB result puts the fact on its LAST line, and the Agent tool has the real shape (description, prompt, an enum of types)", () => {
  const r = bigResult();
  assert.ok(r.length > 19500 && r.length < 21500);
  assert.equal(r.indexOf(BIG_RESULT_FACT), r.lastIndexOf(BIG_RESULT_FACT), "once");
  assert.ok(r.trimEnd().split("\n").pop().includes(BIG_RESULT_FACT));
  const a = agentTool();
  assert.equal(a.name, "Agent");
  assert.deepEqual(Object.keys(a.input_schema.properties).sort(), ["description", "prompt", "subagent_type"]);
  assert.deepEqual(a.input_schema.properties.subagent_type.enum, [...AGENT_TYPES]);
  assert.deepEqual(a.input_schema.required.sort(), ["description", "prompt", "subagent_type"]);
  assert.deepEqual({ ...CACHE_CONTROL }, { type: "ephemeral" });
});

test("it is deterministic, and every callable tool is where its request needs it", () => {
  assert.equal(JSON.stringify(fixture()), JSON.stringify(fixture()));
  assert.equal(smallTools()[0].name, "fx_echo");
  assert.ok(fixture().tools.some((t) => t.name === ECHO_TOOL) && bigFixture().tools.some((t) => t.name === ECHO_TOOL), "the echo tool is inside both big sets");
  assert.equal(echoTool().name, ECHO_TOOL);
  assert.equal(new Set(fixture().tools.map((t) => t.name)).size, fixture().tools.length, "tool names are unique");
  assert.equal(new Set(bigFixture().tools.map((t) => t.name)).size, bigFixture().tools.length);
  const copy = fixture(); copy.tools.pop(); copy.system = "x";
  assert.equal(fixture().tools.length, 44, "a caller's edit of its copy does not change the fixture");
  const big = bigFixture(); big.tools.pop();
  assert.equal(bigFixture().tools.length, 104);
  assert.ok(fixtureDigest() !== bigDigest());
});

test("it is synthetic: no path of this machine, no key shape, no real tool name from a log", () => {
  for (const k of ["1", "2", "3a", "3b", "5", "6"]) {
    const text = JSON.stringify(buildBody(k, "p/m"));
    assert.ok(!/[A-Z]:\\\\Users\\\\(?!demo)|\/Users\/|\/home\/|sk-[A-Za-z0-9]{10}|api[_-]?key/i.test(text), k);
  }
  assert.ok(fixture().tools.every((t) => t.name.startsWith("fx_") || t.name.startsWith("mcp__plugin_")));
});

// The synthetic tool-fidelity fixture: its size, its awkward constructs, and its identity (a changed byte must bump the fixture id).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { fixture, fixtureDigest, bigFixture, bigDigest, FIXTURE_ID, BIG_FIXTURE_ID, BIG_TARGET_BYTES, TARGET_BYTES, SYSTEM_BYTES, ECHO_TOOL, smallTools } from "../refresh/tool-fidelity-fixture.mjs";
import { buildBody, levelSize } from "../refresh/tool-fidelity-probe.mjs";

guardRealState(after, assert);

// Changing the fixture changes this digest. Bump FIXTURE_ID in refresh/tool-fidelity-fixture.mjs, THEN update the pair below:
// stored results name the fixture they were measured against, and an old id is what earns a record its `*`.
const PINNED = { id: "cc-tools-1", digest: "618b0ceddbe5" };
const PINNED_BIG = { id: "cc-tools-big-1", digest: "0a7f418dc623" };

test("the fixture is pinned: its digest matches the id it carries (an edit without an id bump fails here)", () => {
  assert.equal(FIXTURE_ID, PINNED.id);
  assert.equal(fixtureDigest().slice(0, PINNED.digest.length), PINNED.digest, "the fixture bytes changed: bump FIXTURE_ID, then update PINNED");
});

test("the L3 and L4 request is about 157 KB with a ~9 KB system prompt and 41 tools", () => {
  const f = fixture();
  assert.equal(f.tools.length, 41);
  assert.equal(f.system.length, SYSTEM_BYTES);
  const { bytes } = levelSize(3);
  assert.ok(Math.abs(bytes - TARGET_BYTES) < 0.02 * TARGET_BYTES, `${bytes} bytes against a target of ${TARGET_BYTES}`);
  assert.ok(Math.abs(levelSize(4).bytes - bytes) < 200, "L4 differs from L3 only by its prompt");
});

test("it carries the constructs that broke real providers: maximum 9007199254740991, anyOf, const, a lookahead regex", () => {
  const text = JSON.stringify(fixture().tools);
  assert.ok(text.includes('"maximum":9007199254740991'));
  assert.ok(text.includes('"anyOf"'));
  assert.ok(text.includes('"const"'));
  assert.ok(text.includes("(?="), "a lookahead in a pattern");
  assert.ok(text.includes('"additionalProperties":false'));
});

test("it is deterministic, and the echo tool every level asks for is in the small request and inside the big one", () => {
  assert.equal(JSON.stringify(fixture()), JSON.stringify(fixture()));
  assert.equal(smallTools()[0].name, ECHO_TOOL);
  assert.ok(fixture().tools.some((t) => t.name === ECHO_TOOL));
  assert.equal(new Set(fixture().tools.map((t) => t.name)).size, fixture().tools.length, "tool names are unique");
  const copy = fixture(); copy.tools.pop(); copy.system = "x";
  assert.equal(fixture().tools.length, 41, "a caller's edit of its copy does not change the fixture");
});

test("it is synthetic: no path of this machine, no key shape, no real tool name from a log", () => {
  const text = JSON.stringify(buildBody(3, "p/m"));
  assert.ok(!/[A-Za-z]:\\\\|\/Users\/|\/home\/|sk-[A-Za-z0-9]{10}|api[_-]?key/i.test(text));
  assert.ok(fixture().tools.every((t) => t.name.startsWith("fx_")));
});

test("the BIG fixture (the ~400 KB step) is pinned by id and digest like the main one, and is a larger set of the same kind", () => {
  assert.equal(BIG_FIXTURE_ID, PINNED_BIG.id);
  assert.equal(bigDigest().slice(0, PINNED_BIG.digest.length), PINNED_BIG.digest, "the big fixture bytes changed: bump BIG_FIXTURE_ID, then update PINNED_BIG");
  const b = bigFixture();
  assert.ok(b.tools.length > fixture().tools.length * 2);
  const bytes = levelSize(5).bytes;
  assert.ok(Math.abs(bytes - BIG_TARGET_BYTES) < 0.02 * BIG_TARGET_BYTES, `${bytes} bytes against a target of ${BIG_TARGET_BYTES}`);
  assert.equal(new Set(b.tools.map((t) => t.name)).size, b.tools.length, "tool names are unique");
  assert.ok(b.tools.some((t) => t.name === ECHO_TOOL));
  assert.equal(JSON.stringify(bigFixture()), JSON.stringify(bigFixture()), "deterministic");
  const copy = bigFixture(); copy.tools.pop();
  assert.equal(bigFixture().tools.length, b.tools.length, "a caller's edit of its copy does not change the fixture");
  assert.ok(fixtureDigest() !== bigDigest());
});

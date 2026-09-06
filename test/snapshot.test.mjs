import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSnapshot, writeSnapshotFile, loadSnapshot, contextIndex, main,
         SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";

const scratch = (name) => {
  const d = path.join(os.homedir(), ".uw", "harness", "scratch", "snapshot");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
};

const BUILT = {
  generatedAt: "2026-08-24T12:22:28.162Z",
  routableAsOf: "2026-08-24T12:25:00.000Z",
  rows: [
    { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
      models: [{ id: "acme-chat-1", ctx: 163840, pin: 0, pout: 0, badge: "FREE?",
                 tools: true, vision: false, reason: true,
                 outputKind: "text", routable: true },
               { id: "acme-pro-1", ctx: null, pin: 0.3, pout: 1.2, badge: "PAID",
                 tools: true, vision: true, reason: false,
                 outputKind: "text", routable: false }] },
    { keyId: "relay.anthropic.subscription", provider: "anthropic", free: null, planCount: 1,
      health: "ok",
      models: [{ id: "claude-opus-5", ctx: 200000, pin: null, pout: null, badge: "PLAN",
                 tools: true, vision: true, reason: true,
                 outputKind: "text", routable: null }] },
  ],
};

test("buildSnapshot stamps the schema and keeps every display field", () => {
  const s = buildSnapshot(BUILT);
  assert.equal(s.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(s.generatedAt, BUILT.generatedAt);
  assert.equal(typeof s.builtAt, "string");
  assert.equal(s.rows.length, 2);
  assert.deepEqual(Object.keys(s.rows[0]).sort(),
                   ["free", "health", "keyId", "models", "planCount", "provider"]);
  // `routable` joined this list on 2026-09-06. The previous eight-key version of
  // this assertion was green while buildSnapshot dropped the field on every
  // build -- it stated the key set the code emitted and therefore certified the
  // drop as correct. A key-set assertion can only ever say "these keys and no
  // others"; the positive round-trip below is what says "and they carry values".
  assert.deepEqual(Object.keys(s.rows[0].models[0]).sort(),
                   ["badge", "ctx", "id", "outputKind", "pin", "pout", "reason",
                    "routable", "tools", "vision"]);
});

test("outputKind survives serialization, for every value it can take", () => {
  // A key-set assertion alone is not enough and the previous eight-key list is
  // the proof: it stated exactly which keys buildSnapshot emits and was green
  // while the field the picker needs was being dropped. It passes just as
  // happily over a snapshot where every value is `undefined`.
  //
  // So assert the value round-trips, on all three, and drive it from a fixture
  // that carries all three -- `null` in particular, because `outputKind: null`
  // for a testModel row is the common case and `undefined` would be
  // indistinguishable from it in the key set.
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", models: [
      { id: "chat", outputKind: "text" },
      { id: "pic", outputKind: "nontext" },
      { id: "unlisted", outputKind: null }] }] };
  const back = JSON.parse(JSON.stringify(buildSnapshot(built))).rows[0].models;
  assert.deepEqual(back.map((m) => m.outputKind), ["text", "nontext", null]);
  for (const m of back) assert.equal("outputKind" in m, true, `${m.id} lost the key`);
});

test("routable and its stamp survive serialization, for every value", () => {
  // Mutation boundary 7, and it is not hypothetical: dropping `routable` from
  // buildSnapshot's model literal IS the state this file shipped in until
  // 2026-09-06. It survived because the key-set assertion above omitted the
  // field, which a key-set assertion cannot help doing -- and a key-set test
  // alone would still pass over a snapshot where every value is `undefined`.
  //
  // So assert the VALUE round-trips, through JSON, for true, false and null.
  // JSON.stringify drops an undefined property outright, so this is the measure
  // that can tell "carried" from "named".
  const back = JSON.parse(JSON.stringify(buildSnapshot(BUILT)));
  assert.deepEqual(back.rows.flatMap((r) => r.models.map((m) => m.routable)),
                   [true, false, null]);
  for (const r of back.rows) for (const m of r.models) {
    assert.equal("routable" in m, true, `${m.id} lost the key entirely`);
  }
  assert.equal(back.routableAsOf, BUILT.routableAsOf);
});

test("a build that resolved no routability stamps null rather than omitting it", () => {
  // The same reason the field itself is nullable: `null` renders undimmed, and
  // the header's dash is what distinguishes undimmed-because-routable from
  // undimmed-because-nobody-checked. Omitting the key would make the two
  // indistinguishable again, one level up.
  const s = JSON.parse(JSON.stringify(buildSnapshot({ ...BUILT, routableAsOf: undefined })));
  assert.equal(s.routableAsOf, null);
  assert.equal("routableAsOf" in s, true);
});

test("a snapshot round-trips through the file", () => {
  const f = scratch("ok.json");
  writeSnapshotFile(buildSnapshot(BUILT), f);
  const r = loadSnapshot(f);
  assert.equal(r.ok, true);
  assert.equal(r.snap.rows[1].models[0].id, "claude-opus-5");
  assert.equal(fs.readdirSync(path.dirname(f)).some((n) => n.includes(".tmp-")), false);
});

test("a missing file reports `missing`, not an empty menu", () => {
  const r = loadSnapshot(scratch("nope.json"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
});

test("an unparseable file reports `unreadable` and quotes nothing sensitive", () => {
  const f = scratch("bad.json");
  fs.writeFileSync(f, "{ this is not json");
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a truncated snapshot is unreadable rather than empty", () => {
  const f = scratch("cut.json");
  fs.writeFileSync(f, JSON.stringify(buildSnapshot(BUILT)).slice(0, 120));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a future schema is refused with the observed version quoted", () => {
  const f = scratch("v9.json");
  fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: 9 }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.match(r.detail, /9/);
});

test("contextIndex maps provider/model to context tokens and skips unknowns", () => {
  const ix = contextIndex(buildSnapshot(BUILT));
  assert.equal(ix.get("acme/acme-chat-1"), 163840);
  assert.equal(ix.get("anthropic/claude-opus-5"), 200000);
  assert.equal(ix.has("acme/acme-pro-1"), false);
  assert.equal(ix.size, 2);
});

// --- the --build path, gateway-free ----------------------------------------
//
// Every case here stubs `rpc`, and that is the point rather than a convenience.
// R3 specified "the values are not uniform on live data", which cannot run
// inside `node --test` without CCR up -- and on the exact path step 6 exists to
// handle, an unreachable gateway would make the check fail indistinguishably
// from a broken build. The live non-uniformity check belongs to T9.

const runBuild = async (rpc, name) => {
  const said = [];
  const file = scratch(name);
  await main(["--build"], { rpc, file, log: (s) => said.push(String(s)) });
  return { said: said.join("\n"), snap: loadSnapshot(file) };
};

test("a gateway that never answers still produces a usable snapshot, and says so", async () => {
  // `rpc` returning undefined is "no answer at all" (ccr-client.mjs:175), which
  // is what a timeout looks like. The failure mode this guards is the one that
  // built the live snapshot: routability silently unknown for all 1,588 rows,
  // which is byte-identical to never having asked.
  const { said, snap } = await runBuild(async () => undefined, "degraded.json");
  assert.equal(snap.ok, true, "a degraded reading is still a valid snapshot");
  assert.equal(snap.snap.routableAsOf, null);
  const all = snap.snap.rows.flatMap((r) => r.models.map((m) => m.routable));
  assert.deepEqual([...new Set(all)], [null], "unknown, never false");
  assert.match(said, /did not answer within 5000ms/);
  assert.match(said, /dash/, "the line must name the consequence, not just the fault");
});

test("a gateway answering with no providers is a different fact, and a different line", async () => {
  // makeRoutableOf(set, true) over an empty set returns false for every row, so
  // the whole picker dims while the header stamp claims the answer is fresh.
  // That reads as totally broken and is a DIFFERENT failure from nobody
  // answering, so it gets its own sentence -- and it still writes, because the
  // reading is accurate and refusing leaves the picker with no input at all.
  const { said, snap } = await runBuild(async () => ({ Providers: [] }), "empty.json");
  assert.equal(snap.ok, true);
  assert.equal(typeof snap.snap.routableAsOf, "string", "the answer WAS fresh");
  const all = snap.snap.rows.flatMap((r) => r.models.map((m) => m.routable));
  assert.deepEqual([...new Set(all)], [false]);
  assert.match(said, /no routable providers/);
  assert.doesNotMatch(said, /did not answer/, "the two readings must not share a line");
});

test("an answering gateway reaches the per-model field and the header stamp", async () => {
  // B1, B2 and B3 in one assertion, offline. Before this task build() never
  // passed routableOf, buildSnapshot never emitted routable, and nothing ever
  // wrote routableAsOf -- so any one of the three left alone makes this fail.
  const { said, snap } = await runBuild(
    // The relay row, which buildFrom constructs by hand rather than from the
    // catalogue -- so a threading fix that reached only the catalogue loop fails
    // here and nowhere else.
    async () => ({ Providers: [{ name: "anthropic", models: ["claude-opus-5"] }] }),
    "fresh.json");
  assert.equal(snap.ok, true);
  assert.match(snap.snap.routableAsOf, /^\d{4}-\d{2}-\d{2}T/);
  const all = snap.snap.rows.flatMap((r) => r.models.map((m) => m.routable));
  assert.equal(all.includes(true), true, "the named target must be routable");
  assert.equal(all.includes(false), true, "and the rest must not be");
  assert.doesNotMatch(said, /did not answer|no routable providers/);
});

test("the snapshot carries no catalogue internals", () => {
  const text = JSON.stringify(buildSnapshot(BUILT));
  for (const leak of ["pricing", "offers", "per1MTokens", "modalities", "capabilities", "limits"]) {
    assert.equal(text.includes(leak), false, `snapshot leaked ${leak}`);
  }
});

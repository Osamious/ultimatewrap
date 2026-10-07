import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import os from "node:os";
import { buildSnapshot, writeSnapshotFile, loadSnapshot, contextIndex, main,
         SNAPSHOT_SCHEMA, PROVENANCE_RUNGS, buildProvenanceIndex } from "../menu/snapshot.mjs";
import { buildJoinIndex, joinCatalogEntry } from "../keysync/catalog-join.mjs";
import * as K from "../keysync/keysync.mjs";

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
                   ["bench", "benchAgeHist", "benchFlags", "free", "health", "keyId", "limit", "models", "planCount", "provider", "refused"]);
  // `routable` joined this list on 2026-09-06. The previous eight-key version of
  // this assertion was green while buildSnapshot dropped the field on every
  // build -- it stated the key set the code emitted and therefore certified the
  // drop as correct. A key-set assertion can only ever say "these keys and no
  // others"; the positive round-trip below is what says "and they carry values".
  assert.deepEqual(Object.keys(s.rows[0].models[0]).sort(),
                   ["badge", "ctx", "id", "limit", "modality", "mode", "outModality", "outputKind", "pin",
                    "pout", "provenance", "reason", "routable", "tools", "vision"]);
});

test("schema 3: mode survives serialization -- the same drop this file already made twice", () => {
  // Found in review: `mode` is ALWAYS present on a real `buildFrom` row
  // (menu/catalog.mjs:536-539, "ALWAYS PRESENT, never a missing key") and this
  // file's per-model literal dropped it anyway on every build, the third
  // instance of the exact defect the key-set-assertion comment above already
  // names twice (`routable`, then almost `provenance`). R16 reads this field
  // from the snapshot and cannot add it itself (`snapshot.mjs` is outside
  // R16's WRITES), so a silent drop here would not surface until R16 ships
  // against a field that was never actually persisted.
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", refused: [], models: [
      { id: "a", mode: true }, { id: "b", mode: false }] }] };
  const back = JSON.parse(JSON.stringify(buildSnapshot(built))).rows[0].models;
  assert.deepEqual(back.map((m) => m.mode), [true, false]);
  for (const m of back) assert.equal(Object.hasOwn(m, "mode"), true, `${m.id} lost mode`);
});

test("schema 3: provenance and refused are own properties on every row, even unknown/empty", () => {
  // Object.hasOwn, not `=== null` or `.length === 0` -- the two differ exactly
  // on the bug this task exists to avoid repeating: `JSON.stringify` drops an
  // `undefined` property outright, so a key-set test alone (above) proves the
  // FIELD exists on a fixture that happens to carry a value, not that every
  // row survives serialization with the key present.
  const s = JSON.parse(JSON.stringify(buildSnapshot(BUILT)));
  for (const r of s.rows) {
    assert.equal(Object.hasOwn(r, "refused"), true, `${r.provider} lost refused[]`);
    for (const m of r.models) {
      assert.equal(Object.hasOwn(m, "provenance"), true, `${m.id} lost provenance`);
      assert.equal(Object.hasOwn(m, "modality"), true, `${m.id} lost modality`);
    }
  }
});

test("schema 3: provenance is one of the pinned rungs, and the accepted set includes config-asserted", () => {
  // Asserted AS A SET (revision 6, #59), not by spot-checking one value: this
  // fails if a later edit drops a rung, renames one, or collapses two back
  // into `call-verified` -- the vocabulary becoming persisted data is the
  // reason schema 3 exists at all.
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", refused: [], models: [
      { id: "a", provenance: "call-verified" },
      { id: "b", provenance: "config-asserted" },
      { id: "c", provenance: "listing-verified" },
      { id: "d", provenance: "catalogue-only" },
      { id: "e", provenance: null },
    ] }] };
  const s = JSON.parse(JSON.stringify(buildSnapshot(built)));
  const seen = new Set(s.rows[0].models.map((m) => m.provenance));
  for (const p of seen) assert.equal(PROVENANCE_RUNGS.has(p), true, `"${p}" is not a pinned rung`);
  assert.equal(PROVENANCE_RUNGS.has("config-asserted"), true,
    "config-asserted must remain in the accepted set");

  // BOTH DIRECTIONS (found in review): the loop above only fails if a rung
  // this fixture uses is missing from the set -- a SIXTH rung silently added
  // to `PROVENANCE_RUNGS` would pass it. `Object.freeze` on a `Set` does not
  // stop `.add()` either, so the runtime object enforces nothing; this
  // full-set comparison is the actual enforcement.
  assert.deepEqual(
    [...PROVENANCE_RUNGS].map(String).sort(),
    ["call-verified", "catalogue-only", "config-asserted", "listing-verified", "null"].sort(),
    "the accepted set must be exactly these five rungs, no more and no fewer");
});

test("schema 3: a model in discovery but not the bundle appears with listing-verified", () => {
  // The observable that fails on a silently-ignored cache: `buildSnapshot`
  // itself does not resolve provenance (that is `main()`'s job, injected as
  // `provenanceOf` into `build()` -- outside this pure function), so this
  // drives the injected-predicate shape directly, the same way the routable
  // tests above drive `routableOf`.
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", refused: [],
    models: [{ id: "listing-only", provenance: "listing-verified" },
             { id: "bundle-only", provenance: "catalogue-only" }] }] };
  const s = buildSnapshot(built);
  assert.equal(s.rows[0].models.find((m) => m.id === "listing-only").provenance,
    "listing-verified");
  assert.equal(s.rows[0].models.find((m) => m.id === "bundle-only").provenance,
    "catalogue-only");
});

test("schema 3: modality is sourced per-model from the injected modalityOf, and defaults to null", () => {
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "acme", free: null,
    planCount: 0, health: "ok", refused: [],
    models: [{ id: "m1" }, { id: "m2" }] }] };
  const modalityOf = (provider, id) => (provider === "acme" && id === "m1") ? "embedding" : null;
  const s = JSON.parse(JSON.stringify(buildSnapshot(built, { modalityOf })));
  assert.equal(s.rows[0].models.find((m) => m.id === "m1").modality, "embedding");
  assert.equal(s.rows[0].models.find((m) => m.id === "m2").modality, null);
  // The default is inert -- no `modalityOf` supplied at all must not throw and
  // must serialize every row's modality as null, not drop the key.
  const inert = JSON.parse(JSON.stringify(buildSnapshot(built)));
  for (const m of inert.rows[0].models) assert.equal(m.modality, null);
});

test("schema 3: refused[] carries the shape and floor, not a closed reason vocabulary", () => {
  // `reason` is explicitly NOT asserted as a closed set (revision 11): R11
  // retires the cap reason and later work may add others, so this asserts the
  // SHAPE (id/reason/removed always present, reason non-empty, removed a
  // number) and the FLOOR (at least two distinct reasons survive one
  // round-trip). SCOPE, NAMED IN REVIEW: `buildSnapshot` passes `refused[]`
  // through by reference with no transformation beyond `?? []`, so this test
  // exercises its own fixture, not a real producer -- it cannot fail for an
  // R14-side regression that flattens the widened population (that coverage
  // lives with R14's own tests, plan :3281-3282, which the schema vocabulary
  // check above is explicitly paired with). What this DOES guard is
  // `buildSnapshot` itself ever rewriting or collapsing the array at the
  // serialization boundary, which is the boundary this task owns.
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", models: [],
    refused: [
      { id: "acme-cap-1", reason: "not in the routing table: provider capped at 3 models", removed: 0 },
      { id: "evil", reason: "control-char", removed: 3 },
    ] }] };
  const s = JSON.parse(JSON.stringify(buildSnapshot(built)));
  const refused = s.rows[0].refused;
  for (const r of refused) {
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.reason, "string");
    assert.notEqual(r.reason, "");
    assert.equal(typeof r.removed, "number");
  }
  assert.equal(new Set(refused.map((r) => r.reason)).size, 2, "two rules, two distinct reasons");
  assert.equal(refused.some((r) => r.removed === 0), true,
    "a withheld-but-unsanitised row still carries removed: 0, not an absent count");
});

test("schema 3: refused[] round-trips [] as [], never absent and never null", () => {
  const built = { generatedAt: null, rows: [{ keyId: "k", provider: "p", free: null,
    planCount: 0, health: "ok", models: [], refused: [] }] };
  const s = JSON.parse(JSON.stringify(buildSnapshot(built)));
  assert.deepEqual(s.rows[0].refused, []);
  assert.equal(Object.hasOwn(s.rows[0], "refused"), true);
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
  const f = scratch("v10.json");
  fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: 10 }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.match(r.detail, /10/);
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

// `loadRelayCatalog` defaults to "no live catalog", never to the real fetcher:
// that one reads a live cache file and falls back to an HTTP call against the
// relay, so leaving it unstubbed would take each assertion's input from whatever
// the developer's machine was serving that minute. Null is also the honest
// default here -- these fixtures describe an offline build -- and it keeps the
// relay on its curated `config-asserted` rows, which is what every assertion
// written before #111 was written against.
const runBuild = async (rpc, name, loadDiscovery, loadRelayCatalog = async () => null) => {
  const said = [];
  const file = scratch(name);
  await main(["--build"], { rpc, file, loadDiscovery, loadRelayCatalog,
                            log: (s) => said.push(String(s)) });
  return { said: said.join("\n"), snap: loadSnapshot(file) };
};

// A canned `fetchAnthropicCatalog`-shaped result. `at: Date.now()` so
// `routableCatalogIds`' seven-day ceiling admits it; a test that wants the
// stale branch passes its own older stamp.
const relayCatalogOf = (contextById, at = Date.now()) => async () => ({
  ids: new Set(Object.keys(contextById)),
  contextById: new Map(Object.entries(contextById).filter(([, v]) => Number.isFinite(v))),
  at,
});

// A canned `loadDiscoveryCache`-shaped function, so these tests never touch
// the real, ACL-protected cache directory the live function reads from.
const discoveryOf = (byProvider, note = "discovery: canned for test") =>
  () => ({ discovery: new Map(Object.entries(byProvider)), note });

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

test("buildProvenanceIndex: a listing-only id is listing-verified; a bundle-only id is catalogue-only", () => {
  const catalog = { byProvider: new Map([["acme",
    [{ provider: "acme", id: "acme/bundle-model", model: "bundle-model" }]]]) };
  const discovery = new Map([["acme", { outcome: "ok", at: "2026-09-08T00:00:00Z",
    models: [{ id: "listing-only-model", capabilityRaw: null }] }]]);
  const { provenanceOf } = buildProvenanceIndex(discovery, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(provenanceOf("acme", "listing-only-model"), "listing-verified");
  assert.equal(provenanceOf("acme", "bundle-model"), "catalogue-only");
});

test("buildProvenanceIndex: a SITE-1 bundle row named by the listing under a cosmetically different spelling is listing-verified, not catalogue-only (the 238-row gap found in review)", () => {
  // Without the join, this index would be keyed by the raw live spelling
  // ("acme.newmodel") alone, and the bundle's OWN spelling ("acme-newmodel")
  // -- what a SITE-1 row is actually displayed under -- would never match it,
  // reading catalogue-only even though the provider's listing really did name
  // this model. Measured on the real vault: 238 of 4,732 rows, 18.7% of the
  // catalogue-only population, fixed by this same join.
  const catalog = { byProvider: new Map([["acme",
    [{ provider: "acme", id: "acme/acme-newmodel", model: "acme-newmodel" }]]]) };
  const discovery = new Map([["acme", { outcome: "ok", at: "2026-09-08T00:00:00Z",
    models: [{ id: "acme.newmodel", capabilityRaw: "embedding" }] }]]);
  const { provenanceOf, modalityOf } =
    buildProvenanceIndex(discovery, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(provenanceOf("acme", "acme-newmodel"), "listing-verified");
  // The SAME fix closes `modality`'s half of the contradiction: a row whose
  // `outputKind` catalog.mjs already demoted via this joined capability must
  // not also report `modality: null`.
  assert.equal(modalityOf("acme", "acme-newmodel"), "embedding");
});

test("buildProvenanceIndex: when a listing names both spellings of one model, first-wins on the canonical key -- matching catalog.mjs's own listingOf tie-break", () => {
  // Found in review: an unconditional `canon.set(rawId, entry)` disagreed
  // with `menu/catalog.mjs`'s `listingOf` (also first-wins on canonical
  // identity) whenever the cosmetic spelling was listed BEFORE the exact one
  // -- the exact-spelling write would unconditionally clobber whatever the
  // join branch had already set for that canonical key. Reachable, latent on
  // the real vault (3 canonical ids affected, 0 with a differing
  // `capabilityRaw` today).
  const catalog = { byProvider: new Map([["acme",
    [{ provider: "acme", id: "acme/chat-model", model: "chat-model" }]]]) };
  const discovery = new Map([["acme", { outcome: "ok", at: "2026-09-08T00:00:00Z", models: [
    { id: "chat.model", capabilityRaw: "embedding" }, // cosmetic, listed FIRST
    { id: "chat-model", capabilityRaw: "chat" },       // exact, listed SECOND
  ] }]]);
  const { modalityOf } = buildProvenanceIndex(discovery, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(modalityOf("acme", "chat-model"), "embedding",
    "the FIRST entry to claim this canonical id must win, matching catalog.mjs's listingOf");
});

test("buildProvenanceIndex: discovery === null (nobody looked) answers null for every row, never catalogue-only", () => {
  // The absent-vs-empty distinction found in review: `null` means the read
  // never happened (failed, or was never attempted); an empty Map means it
  // happened and found nothing. Only the latter may honestly answer
  // `catalogue-only` -- a positive claim that the listing was read and did
  // not name this model.
  const catalog = { byProvider: new Map([["acme",
    [{ provider: "acme", id: "acme/m1", model: "m1" }]]]) };
  const withNull = buildProvenanceIndex(null, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(withNull.provenanceOf("acme", "m1"), null);
  assert.equal(withNull.modalityOf("acme", "m1"), null);
  assert.equal(withNull.discoveredAsOf, null);

  const withEmpty = buildProvenanceIndex(new Map(), catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(withEmpty.provenanceOf("acme", "m1"), "catalogue-only",
    "an empty Map means the cache WAS read -- this is the honest answer, unlike null");
});

test("buildProvenanceIndex: discoveredAsOf is the latest `.at` across all providers, or null with no discovery", () => {
  const catalog = { byProvider: new Map() };
  const discovery = new Map([
    ["a", { outcome: "ok", at: "2026-09-01T00:00:00Z", models: [] }],
    ["b", { outcome: "ok", at: "2026-09-08T00:00:00Z", models: [] }],
  ]);
  const withData = buildProvenanceIndex(discovery, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(withData.discoveredAsOf, "2026-09-08T00:00:00Z");
  const withNone = buildProvenanceIndex(null, catalog, { buildJoinIndex, joinCatalogEntry });
  assert.equal(withNone.discoveredAsOf, null);
});

test("R15: a populated discovery cache produces a non-null discoveredAsOf", async () => {
  // Targets the relay ("anthropic"), the one provider `build()` injects
  // regardless of the real vault's own contents (`ANTHROPIC_RELAY`), so this
  // test does not depend on which real providers the test machine's vault
  // happens to choose. Provenance is NOT asserted here on purpose: the relay's
  // models are exempt from `provenanceOf` by construction (R14's
  // `CONFIG_ASSERTED` is hardcoded for the relay block, not routed through the
  // injected predicate) -- that unit-level behavior is covered directly by
  // "a model in discovery but not the bundle appears with listing-verified"
  // above, which drives `buildSnapshot`'s own pass-through without depending
  // on which real provider the test machine's vault happens to route through
  // `provenanceOf` at all.
  const load = discoveryOf({
    anthropic: { outcome: "ok", at: "2026-09-08T00:00:00.000Z",
      models: [{ id: "claude-opus-5", capabilityRaw: null }] },
  });
  const { snap } = await runBuild(async () => ({ Providers: [] }), "disc-populated.json", load);
  assert.equal(snap.ok, true);
  assert.equal(snap.snap.discoveredAsOf, "2026-09-08T00:00:00.000Z");
});

test("R15: no discovery cache writes a null discoveredAsOf, two cases so neither a hardcoded null nor a hardcoded timestamp passes", async () => {
  const empty = () => ({ discovery: new Map(), note: "discovery: 0 of 0 providers contribute ids" });
  const { snap: withNoCache } = await runBuild(async () => ({ Providers: [] }), "disc-empty.json", empty);
  assert.equal(withNoCache.snap.discoveredAsOf, null);

  const populated = discoveryOf({
    anthropic: { outcome: "ok", at: "2026-09-08T01:00:00.000Z", models: [{ id: "claude-opus-5" }] },
  });
  const { snap: withCache } = await runBuild(async () => ({ Providers: [] }), "disc-populated2.json", populated);
  assert.equal(withCache.snap.discoveredAsOf, "2026-09-08T01:00:00.000Z");
});

test("R15: a discovery-cache read failure degrades to no discovery, never an unwritten snapshot (B4/#27)", async () => {
  // The unguarded-await defect this task exists to avoid: a rejection here
  // must not propagate out of main() and skip the write entirely.
  const throwing = () => { throw new Error("simulated ACL failure"); };
  const { said, snap } = await runBuild(async () => ({ Providers: [] }), "disc-throws.json", throwing);
  assert.equal(snap.ok, true, "a degraded discovery reading is still a valid snapshot");
  assert.equal(snap.snap.discoveredAsOf, null);
  assert.match(said, /discovery: could not be read/);
  // FOUND IN REVIEW: `discovery === null` (nobody looked) and an empty Map
  // (looked, nothing there) must render differently. A failed read must not
  // serialize the positive claim `"catalogue-only"` -- "the listing was read
  // and did not name this" -- when no listing was read at all; every row's
  // provenance and modality must be the honest `null` (unknown), matching the
  // stamp and the printed line, which already say the same thing.
  // `config-asserted` rows (testModel/relay) are exempt: they never go
  // through `provenanceOf` at all (R14's `CONFIG_ASSERTED` is hardcoded), so
  // their provenance is legitimately non-null regardless of discovery state.
  const checked = snap.snap.rows.flatMap((r) => r.models)
    .filter((m) => m.provenance !== "config-asserted");
  assert.equal(checked.length > 0, true, "non-vacuous: the build produced rows to check");
  for (const m of checked) {
    assert.equal(m.provenance, null, `${m.id} claimed provenance from a discovery read that never happened`);
    assert.equal(m.modality, null, `${m.id} claimed modality from a discovery read that never happened`);
  }
});

// --------------------------------------------------------------- #111
// uwpick reads ONLY this snapshot, and emits its selection as the id it finds
// here, verbatim. So these assertions are about a routing outcome, not a label:
// a bare `claude-opus-5` row lands the session on 200k while the same model
// picked from `/model` gets 1M.

const relayModelsOf = (snap) =>
  snap.rows.find((r) => r.provider === "anthropic").models;

test("#111: the relay row carries every live id, tagged from its real context window", async () => {
  const { snap } = await runBuild(async () => ({ Providers: [] }), "relay-live.json", undefined,
    relayCatalogOf({
      "claude-opus-5": 1000000,
      "claude-opus-4-6": 1000000,
      "claude-haiku-4-5-20251001": 200000,
    }));
  const models = relayModelsOf(snap.snap);
  assert.deepEqual(models.map((m) => m.id).sort(),
    ["claude-haiku-4-5-20251001", "claude-opus-4-6[1m]", "claude-opus-5[1m]"],
    "a 1M window tags, a 200k window does not, and an id outside the curated four still appears");
  // The whole point of the ctx column, and of hud-shim's ability to correct an
  // Anthropic session's context window at all: `contextIndex` skips a model
  // whose ctx is not finite, and every relay row used to be null.
  assert.equal(models.find((m) => m.id === "claude-opus-5[1m]").ctx, 1000000);
  assert.equal(models.find((m) => m.id === "claude-haiku-4-5-20251001").ctx, 200000);
});

test("#111: routability is asked about the BARE id, never the tagged one", async () => {
  // CCR routes on `Providers[].models`, which is bare. Asking the routable set
  // about `anthropic/claude-opus-5[1m]` answers false for every relay row and
  // dims the entire provider -- the failure this keys the lookup to avoid.
  const rpc = async () => ({
    Providers: [{ name: "anthropic", models: ["claude-opus-5"] }],
  });
  const { snap } = await runBuild(rpc, "relay-routable.json", undefined,
    relayCatalogOf({ "claude-opus-5": 1000000 }));
  const m = relayModelsOf(snap.snap)[0];
  assert.equal(m.id, "claude-opus-5[1m]", "the emitted id keeps its tag");
  assert.equal(m.routable, true, "and is still recognised as routable");
});

test("#111: a live id claims listing-verified, the curated fallback stays config-asserted", async () => {
  const { snap: live } = await runBuild(async () => ({ Providers: [] }), "relay-prov-live.json",
    undefined, relayCatalogOf({ "claude-opus-5": 1000000 }));
  assert.equal(relayModelsOf(live.snap)[0].provenance, "listing-verified",
    "the relay's own /v1/models IS a listing, and saying config-asserted would be the false claim #59 is about");

  const { snap: none } = await runBuild(async () => ({ Providers: [] }), "relay-prov-none.json");
  assert.equal(relayModelsOf(none.snap).every((m) => m.provenance === "config-asserted"), true,
    "with no live catalog the rows are a config literal again, and must say so");
});

test("#111: a catalog too stale to route on falls back to the curated set, and says which", async () => {
  const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;
  const { said, snap } = await runBuild(async () => ({ Providers: [] }), "relay-stale.json", undefined,
    relayCatalogOf({ "claude-opus-4-6": 1000000 }, Date.now() - EIGHT_DAYS));
  const ids = relayModelsOf(snap.snap).map((m) => m.id);
  assert.equal(ids.includes("claude-opus-4-6[1m]"), false,
    "past the ceiling an id may name a retired model, and here that is a dead selection");
  assert.deepEqual(ids, [...K.ANTHROPIC_RELAY.models]);
  assert.match(said, /too stale to route on/);
});

test("#111: a failed relay read degrades to the curated set, never an unwritten snapshot", async () => {
  const { said, snap } = await runBuild(async () => ({ Providers: [] }), "relay-throws.json", undefined,
    async () => { throw new Error("simulated relay failure"); });
  assert.equal(snap.ok, true, "a degraded relay reading is still a valid snapshot");
  assert.deepEqual(relayModelsOf(snap.snap).map((m) => m.id), [...K.ANTHROPIC_RELAY.models]);
  assert.match(said, /live catalog could not be read \(simulated relay failure\)/);
});

test("the snapshot carries no catalogue internals", () => {
  const text = JSON.stringify(buildSnapshot(BUILT));
  for (const leak of ["pricing", "offers", "per1MTokens", "modalities", "capabilities", "limits"]) {
    assert.equal(text.includes(leak), false, `snapshot leaked ${leak}`);
  }
});

// --- the free-tier limit survives a rebuild (2026-09-09) --------------------
//
// `limit` is a MEASUREMENT and `buildSnapshot` only ever sees DERIVATIONS, so
// without a carry-forward the first `--build` after a probe sweep threw the
// whole sweep away. MEASURED: after an unrelated rebuild, all 45 providers read
// `null`. Routability is the instructive contrast -- `main()` re-probes it every
// build, so it needs no carry; a limit sweep costs minutes and hits third-party
// free tiers, so it must be carried.

test("buildSnapshot carries a previous limit forward when the build cannot derive one", () => {
  const previous = { rows: [
    { provider: "acme", limit: { verdict: "unusable", bytes: 102400, at: "2026-09-09T00:00:00Z" },
      models: [{ id: "m1", limit: { verdict: "unusable", bytes: 102400 } }] },
  ] };
  const s = buildSnapshot(BUILT, { previous });
  const row = s.rows.find((r) => r.provider === "acme");
  assert.ok(row, "fixture must contain the acme provider for this test to mean anything");
  assert.equal(row.limit?.verdict, "unusable");
  assert.equal(row.limit?.bytes, 102400);
});

test("buildSnapshot keys the carry by provider and model id, never by position", () => {
  // A rebuild adds and removes rows -- #107 alone moved google 240 -> 194 -- so
  // an index-based carry would attach one provider's measurement to another's.
  const previous = { rows: [
    { provider: "zzz-not-in-build", limit: { verdict: "ok" }, models: [] },
    { provider: "acme", limit: { verdict: "locked" },
      models: [{ id: "m-gone", limit: { verdict: "ok" } }] },
  ] };
  const s = buildSnapshot(BUILT, { previous });
  assert.equal(s.rows.find((r) => r.provider === "acme")?.limit?.verdict, "locked",
    "matched by name despite sitting at a different index");
  for (const r of s.rows) {
    if (r.provider !== "acme") {
      assert.notEqual(r.limit?.verdict, "locked", `${r.provider} inherited a foreign measurement`);
    }
  }
});

test("buildSnapshot with no previous snapshot leaves every limit null", () => {
  const s = buildSnapshot(BUILT);
  for (const r of s.rows) {
    assert.equal(r.limit, null, `${r.provider} invented a limit from nothing`);
    for (const m of r.models) assert.equal(m.limit, null);
  }
});

test("a fresh measurement in `built` outranks the carried one", () => {
  // The carry is a FALLBACK. If a producer ever does put a limit on `built`,
  // the older stored value must not shadow it.
  const built = { ...BUILT, rows: BUILT.rows.map((r) => ({ ...r, limit: { verdict: "ok" } })) };
  const previous = { rows: BUILT.rows.map((r) => ({ provider: r.provider, limit: { verdict: "locked" }, models: [] })) };
  const s = buildSnapshot(built, { previous });
  for (const r of s.rows) assert.equal(r.limit?.verdict, "ok");
});

// --------------------------------------------------------------- #113
// `[1m]` on RESELLER rows. The relay strips the suffix at its own last hop;
// CCR does NOT (measured: an upstream 404 echoes it back verbatim), so on a
// reseller the suffix reaches the provider's own id parser and tagging a
// provider that rejects it turns a working row into a dead one.

test("#113: tagOneM tags a 1M Claude row, and leaves everything else alone", () => {
  const v = new Map([["openrouter", "accepts"]]);
  assert.equal(K.tagOneM("openrouter", "anthropic/claude-opus-5", 1000000, v),
    "anthropic/claude-opus-5[1m]");
  assert.equal(K.tagOneM("openrouter", "anthropic/claude-haiku-4.5", 200000, v),
    "anthropic/claude-haiku-4.5", "a 200k row is not a 1M row");
  // NOT scoped to Claude names: the suffix acts through `behavesAs`, which
  // every third-party row carries and which always names a Claude model whose
  // profile declares `supports_1m_suffix`. Neither half of the lever consults
  // the model's own name, so a 1M qwen row takes the same window.
  assert.equal(K.tagOneM("openrouter", "qwen/qwen3.8-max", 1000000, v),
    "qwen/qwen3.8-max[1m]");
  assert.equal(K.tagOneM("openrouter", "anthropic/claude-opus-5", null, v),
    "anthropic/claude-opus-5", "an unstated window has confirmed nothing");
});

test("#113: a measured rejection is absolute, an unmeasured provider is tagged", () => {
  const v = new Map([["good", "accepts"], ["bad", "rejects"], ["blocked", "unknown"]]);
  assert.equal(K.tagOneM("bad", "claude-opus-5", 1000000, v), "claude-opus-5",
    "a measured no is never overridden");
  assert.equal(K.tagOneM("blocked", "claude-opus-5", 1000000, v), "claude-opus-5[1m]",
    "unknown is tagged: a deliberate, probe-reversible risk posture");
  assert.equal(K.tagOneM("never-probed", "claude-opus-5", 1000000, new Map()),
    "claude-opus-5[1m]", "an absent provider reads exactly like unknown");
});

test("#113: tagOneM is idempotent", () => {
  // Both writers call it, and `claude-opus-5[1m][1m]` resolves to nothing in
  // the one place a wrong model string is silent.
  const v = new Map([["p", "accepts"]]);
  const once = K.tagOneM("p", "claude-opus-5", 1000000, v);
  assert.equal(K.tagOneM("p", once, 1000000, v), once);
});

test("#113: loadOneMVerdicts reads no file as every-provider-unknown, never as a crash", () => {
  const missing = K.loadOneMVerdicts(scratch("no-such-probe.json"));
  assert.equal(missing instanceof Map, true);
  assert.equal(missing.size, 0);
  // "never probed" and "probed but blocked on billing" must take ONE path.
  assert.equal(K.tagOneM("anything", "claude-opus-5", 1000000, missing),
    "claude-opus-5[1m]");
});

test("#113: a tagged row keeps its modality, which is keyed on the bare id", () => {
  // The regression this guards: `modalityOf` reads the discovery cache, which
  // only ever recorded the provider's own bare spelling. Without the strip in
  // buildSnapshot every tagged row reports modality unknown -- a claim about
  // evidence that does exist.
  const built = {
    generatedAt: null, routableAsOf: null, rows: [{
      keyId: "k", provider: "openrouter", free: null, planCount: 0, health: "ok", refused: [],
      models: [{ id: "anthropic/claude-opus-5[1m]", ctx: 1000000, pin: null, pout: null,
                 badge: "", tools: true, vision: true, reason: true, outputKind: "text",
                 routable: true, provenance: "listing-verified", mode: false }],
    }],
  };
  const snap = buildSnapshot(built, {
    modalityOf: (p, id) => (id === "anthropic/claude-opus-5" ? "text->text" : null),
  });
  assert.equal(snap.rows[0].models[0].modality, "text->text");
  assert.equal(snap.rows[0].models[0].id, "anthropic/claude-opus-5[1m]",
    "the selected spelling is what uwpick emits, and keeps its tag");
});

test("#113: the tag follows the window, not the model's name", () => {
  // The suffix acts through `behavesAs`, which every third-party row carries and
  // which always names a Claude model whose profile declares
  // `supports_1m_suffix`. Neither half of the lever reads the model's own name.
  const v = new Map([["p", "accepts"]]);
  assert.equal(K.tagOneM("p", "qwen/qwen3.8-max", 1000000, v), "qwen/qwen3.8-max[1m]");
  assert.equal(K.tagOneM("p", "google/gemini-3-pro", 2000000, v), "google/gemini-3-pro[1m]");
  assert.equal(K.tagOneM("p", "mistral-small", 32000, v), "mistral-small");
});

test("#113: a router pool never buys a 1M claim from its pool's window", () => {
  // #75's own sentence, applied to this lever: `kilo/auto` carries 2,000,000
  // because that is the widest model in its POOL, which is evidence about no
  // model at all. The four ids here are the ones #75's corpus test pins.
  const v = new Map([["kilo", "accepts"], ["openrouter", "accepts"]]);
  assert.equal(K.tagOneM("kilo", "auto", 2000000, v), "auto");
  assert.equal(K.tagOneM("openrouter", "auto", 2000000, v), "auto");
  assert.equal(K.tagOneM("openrouter", "router", 2000000, v), "router");
  assert.equal(K.tagOneM("p", "vendor/auto", 2000000, v), "vendor/auto",
    "the pool name is matched on the id's last segment, not just the whole string");
  assert.equal(K.tagOneM("p", "autobot-9", 2000000, v), "autobot-9[1m]",
    "and it is anchored, so a real model whose name merely starts with 'auto' still tags");
});

test("schema 9: a schema-6, 7 or 8 snapshot is rejected (no three-state status, no oldest-record stamp), and a current one loads", async () => {
  const fs2 = await import("node:fs"), os2 = await import("node:os"), path2 = await import("node:path");
  const dir = mkTmp("uw-schema8-");
  const file = path2.join(dir, "snapshot.json");
  try {
    for (const old of [6, 7, 8]) {
      fs2.writeFileSync(file, JSON.stringify({ schemaVersion: old, generatedAt: "x", builtAt: "x", rows: [] }));
      const r = loadSnapshot(file);
      assert.equal(r.ok, false);
      assert.equal(r.reason, "schema");
      assert.match(r.detail, new RegExp(`expected schemaVersion 9, found ${old}`));
    }
    fs2.writeFileSync(file, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA, generatedAt: "x", builtAt: "x", rows: [] }));
    assert.equal(loadSnapshot(file).ok, true);
    assert.equal(SNAPSHOT_SCHEMA, 9);
  } finally { fs2.rmSync(dir, { recursive: true, force: true }); }
});

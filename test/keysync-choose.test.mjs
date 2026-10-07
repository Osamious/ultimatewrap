// #21: KEY_CHOICES was a hardcoded object in keysync.mjs -- a source edit and
// redeploy every time a second key was added for a provider not already named
// in it. Fixed by moving the choice into ~/.llmkeys/key-choices.json, a plain
// data file with the identical shape, read at runtime instead of imported from
// source.
//
// STEP 1: characterize CURRENT behavior first. chooseKeys/KEY_CHOICES have zero
// existing test coverage (grep across test/ returns nothing) -- this is the
// only gate standing between a bad multi-key vault config and silent
// misrouting, and it is being deleted and replaced in this same change. A
// characterization test written and green BEFORE the rewrite is what makes
// "the replacement behaves the same, plus reads its choice from data" a
// checked claim rather than an assumption.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { chooseKeys, filterRegistry, loadVault, loadKeyChoices } from "../keysync/keysync.mjs";

const row = (id, provider, overrides = {}) =>
  ({ id, provider, bucket: "personal", tier: "free", ...overrides });

test("chooseKeys: a single-key provider passes through untouched", () => {
  const filtered = [row("personal.acme.free", "acme")];
  assert.deepEqual(chooseKeys(filtered), filtered);
});

test("chooseKeys: a multi-key provider with a recorded choice picks that entry", () => {
  const filtered = [
    row("personal.groq.free", "groq"),
    row("tamu.groq.free", "groq"),
    row("uni.groq.free", "groq"),
  ];
  const chosen = chooseKeys(filtered);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].id, "personal.groq.free");
});

test("chooseKeys: deepseek's recorded choice, the other named provider", () => {
  const filtered = [
    row("personal_maestro.deepseek.paid", "deepseek", { tier: "paid" }),
    row("personal.deepseek.paid", "deepseek", { tier: "paid" }),
  ];
  const chosen = chooseKeys(filtered);
  assert.equal(chosen.length, 1);
  assert.equal(chosen[0].id, "personal_maestro.deepseek.paid");
});

test("chooseKeys: a multi-key provider with NO recorded choice throws, naming the provider and every id", () => {
  const filtered = [
    row("personal.mystery.free", "mystery"),
    row("work.mystery.free", "mystery"),
  ];
  assert.throws(() => chooseKeys(filtered), (err) => {
    assert.match(err.message, /mystery/);
    assert.match(err.message, /personal\.mystery\.free/);
    assert.match(err.message, /work\.mystery\.free/);
    assert.match(err.message, /decide by name, do not let a timestamp decide/);
    return true;
  });
});

test("chooseKeys: multiple ambiguous providers are all named in one throw, not just the first", () => {
  const filtered = [
    row("a1.x.free", "x"), row("a2.x.free", "x"),
    row("b1.y.free", "y"), row("b2.y.free", "y"),
  ];
  assert.throws(() => chooseKeys(filtered), (err) => {
    assert.match(err.message, /"provider":"x"/);
    assert.match(err.message, /"provider":"y"/);
    return true;
  });
});

test("chooseKeys: independent providers each resolve on their own, no cross-provider leakage", () => {
  const filtered = [
    row("personal.groq.free", "groq"),
    row("tamu.groq.free", "groq"),
    row("personal.acme.free", "acme"),
  ];
  const chosen = chooseKeys(filtered);
  assert.equal(chosen.length, 2);
  assert.deepEqual(new Set(chosen.map((c) => c.id)),
    new Set(["personal.groq.free", "personal.acme.free"]));
});

// -------------------------------------------------------- filterRegistry
// The population chooseKeys actually sees. Any redesign of the ambiguity check
// (#21) that reads raw registry.json instead of this filtered set is checking
// the wrong population -- these four exclusions are load-bearing, and a
// choice-map entry naming an id on one of these rows must never resolve,
// because chooseKeys never receives that row at all.

test("filterRegistry: excludes sportsvector* buckets, management tier, generic protocol, and profile-less providers", () => {
  const registry = [
    row("sportsvector.acme.free", "acme", { bucket: "sportsvector" }),
    row("sportsvector1.acme.free", "acme", { bucket: "sportsvector1" }),
    row("personal.acme.management", "acme", { tier: "management" }),
    row("personal.ghost.free", "ghost"),          // no matching provider profile
    row("personal.generic.free", "genericco"),
    row("personal.acme.free", "acme"),            // the one survivor
  ];
  const providers = new Map([
    ["acme", { provider: "acme", protocol: "openai" }],
    ["genericco", { provider: "genericco", protocol: "generic" }],
  ]);
  const filtered = filterRegistry(registry, providers);
  assert.deepEqual(filtered.map((r) => r.id), ["personal.acme.free"]);
});

test("filterRegistry then chooseKeys: a choice naming a FILTERED-OUT id still throws", () => {
  // The exact shape #21's redesign must get right: a choice map is keyed by
  // provider and names an id, but if every entry for that provider is
  // excluded by filterRegistry, chooseKeys never sees a single-entry case to
  // resolve trivially -- and if two OTHER entries for that provider survive
  // unfiltered, the choice naming the filtered-out id does not satisfy them.
  const registry = [
    row("personal.acme.management", "acme", { tier: "management" }), // filtered out
    row("a.acme.free", "acme"),
    row("b.acme.free", "acme"),
  ];
  const providers = new Map([["acme", { provider: "acme", protocol: "openai" }]]);
  const filtered = filterRegistry(registry, providers);
  assert.deepEqual(filtered.map((r) => r.id).sort(), ["a.acme.free", "b.acme.free"]);
  assert.throws(() => chooseKeys(filtered), /acme/);
});

// ------------------------------------------------------- #21: data, not source
// The whole point of the fix: the choice comes from a file `keysync/key.mjs`
// can write, not an object literal in this source file.

test("chooseKeys: the choice is genuinely read from data, not still hardcoded", () => {
  const filtered = [row("a.newprov.free", "newprov"), row("b.newprov.free", "newprov")];
  // A provider `KEY_CHOICES` never named. If this were still a source literal,
  // no argument could make it resolve; passing a choices map here must.
  assert.throws(() => chooseKeys(filtered), /newprov/);
  assert.deepEqual(chooseKeys(filtered, { newprov: "b.newprov.free" }),
    [{ ...filtered[1] }]);
});

test("loadKeyChoices: a missing file is {} (no choices recorded), never a throw", () => {
  const missing = path.join(mkTmp("uw-kc-"), "key-choices.json");
  assert.deepEqual(loadKeyChoices(missing), {});
});

test("loadKeyChoices: reads the real ~/.llmkeys/key-choices.json this milestone creates", () => {
  const choices = loadKeyChoices();
  assert.equal(choices.groq, "personal.groq.free");
  assert.equal(choices.deepseek, "personal_maestro.deepseek.paid");
});

// ------------------------------------------------------- against the real vault
// Measured live before this change: 56 raw entries, 5 multi-key providers
// (groq x3, google x4, zenmux x2, deepseek x2, openrouter x2); after
// filterRegistry, 46 entries and exactly 2 multi-key providers (groq,
// deepseek) -- the two the choices file now names. This is the corpus test:
// it fails the moment a new multi-key provider appears with no recorded
// choice, which is #21's whole failure mode, caught here instead of on a live
// keysync run.

test("corpus: the real vault resolves cleanly end to end, one row per provider", () => {
  const { registry, providers } = loadVault();
  const filtered = filterRegistry(registry, providers);
  const chosen = chooseKeys(filtered);
  const distinctProviders = new Set(chosen.map((c) => c.provider)).size;
  assert.equal(chosen.length, distinctProviders,
    "chooseKeys must never return two rows for one provider");
  // Not pinned to an exact count -- the vault grows as keys are added and
  // removed, and pinning a live external file's size is how a test starts
  // failing for a reason that has nothing to do with the code under test.
  // What must hold regardless of size: chooseKeys never throws against
  // whatever the real vault currently contains, and every multi-key provider
  // it contains has a recorded choice.
  assert.ok(chosen.length > 0, "the real vault must resolve to at least one provider");
});

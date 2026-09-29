import { test } from "node:test";
import assert from "node:assert/strict";
import { applyVerifiedOnly } from "../keysync/run.mjs";

// Fabricated, not sampled from real data. The property under test is about the
// SHAPE of the filter, and a real snapshot would couple these assertions to
// whichever providers happened to be reachable the day verify-prune.mjs ran.
//
// The fixture is built so the verified set is a STRICT SUBSET of routing: `a`
// has three models and only one is verified, `b` has two and none are. That is
// the arrangement the old code collapsed -- it deleted `a/a2`, `a/a3` and the
// whole of `b` on no evidence beyond "the probe did not happen to cover them".
const fixture = () => ({
  providers: [
    { name: "a", api_base_url: "https://a.test", models: ["a1", "a2", "a3"] },
    { name: "b", api_base_url: "https://b.test", models: ["b1", "b2"] },
  ],
  picker: [
    { model: "a/a1", label: "A1" },
    { model: "a/a2", label: "A2" },
    { model: "a/a3", label: "A3" },
    { model: "b/b1", label: "B1" },
    { model: "b/b2", label: "B2" },
  ],
});

const verified = {
  working: ["a/a1"],
  results: [
    { model: "a/a1", ok: true, ms: 900, why: "" },
    { model: "a/a2", ok: false, ms: 30000, why: "404" },
    { model: "b/b1", ok: false, ms: 12, why: "503" },
  ],
};

test("--verified-only leaves routing whole and filters only the picker", () => {
  const built = fixture();
  const before = structuredClone(built.providers);

  const out = applyVerifiedOnly(built, verified);

  // Routing: every provider, every model, untouched -- even though four of the
  // five routing ids were never confirmed working.
  assert.deepEqual(out.providers, before);
  assert.deepEqual(out.providers.map((p) => p.models), [["a1", "a2", "a3"], ["b1", "b2"]]);
  // And untouched in place, not merely reconstructed to look the same.
  assert.deepEqual(built.providers, before);

  // Picker: down to exactly the verified subset.
  assert.deepEqual(out.picker.map((r) => r.model), ["a/a1"]);
});

test("--verified-only does not rebuild the provider array", () => {
  // Identity, not just deep equality. A `.map()` that happens to copy every
  // field faithfully today is one edit away from dropping one, and this is the
  // assertion that fails loudly when the symmetric filter is restored.
  const built = fixture();
  const out = applyVerifiedOnly(built, verified);
  assert.equal(out.providers, built.providers);
  assert.equal(out.providers[0], built.providers[0]);
});

test("an empty verified set empties the picker and still leaves routing whole", () => {
  // The premise the floor guard at the call site rests on: routing cannot reach
  // zero from this flag, so the guard checks the picker.
  const built = fixture();
  const out = applyVerifiedOnly(built, { working: [], results: [] });
  assert.equal(out.picker.length, 0);
  assert.equal(out.providers.length, 2);
  assert.deepEqual(out.providers.map((p) => p.models), [["a1", "a2", "a3"], ["b1", "b2"]]);
});

test("verifiedOrder is fastest-first and carries only rows that answered", () => {
  const built = fixture();
  const out = applyVerifiedOnly(built, {
    working: ["a/a1", "a/a3"],
    results: [
      { model: "a/a3", ok: true, ms: 2500 },
      { model: "b/b1", ok: false, ms: 5 },   // fastest, but a failure
      { model: "a/a1", ok: true, ms: 900 },
    ],
  });
  assert.deepEqual(out.verifiedOrder, ["a/a1", "a/a3"]);
});

test("a missing working or results key is treated as no evidence, not a crash", () => {
  const built = fixture();
  const out = applyVerifiedOnly(built, {});
  assert.deepEqual(out.picker, []);
  assert.deepEqual(out.verifiedOrder, []);
  assert.equal(out.providers, built.providers);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { priceOf, isTextOut, badgeOf, capsOf, buildFrom, routableSet, makeRoutableOf,
         writeSlot, readSlot } from "../menu/catalog.mjs";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";
// The corpus test asserts G2's own predicate against the live catalogue, so it
// reads it from the module that owns it rather than through a menu re-export --
// `menu/catalog.mjs` re-exports `priceOf` because its importers already used it,
// and there is no reason to widen that surface for a test.
import { hasPricedOffer } from "../keysync/catalog-join.mjs";
// outputKind is exported from keysync because both lanes need it and
// menu/catalog.mjs imports keysync, never the reverse. Its cases are asserted
// here, next to the pipeline that consumes them, rather than in the keysync
// suite: this file owns the menu pipeline, and the same fixture drives both the
// unit cases and the buildFrom carry-through below.
import { outputKind, loadCatalog, bucketFor } from "../keysync/keysync.mjs";
import { isModeCapability, isServiceEntry, modeOf } from "../menu/catalog.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(doc.models.map((m) => [m.model, m]));

const catalog = () => {
  const byProvider = new Map();
  for (const m of doc.models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { byProvider, generatedAt: doc.generatedAt };
};

test("priceOf reads pricing.offers[].per1MTokens", () => {
  assert.deepEqual(priceOf(byId["acme-chat-1"]), { in: 0, out: 0 });
  assert.deepEqual(priceOf(byId["acme-pro-1"]), { in: 0.3, out: 1.2 });
});

test("priceOf answers about MY key, not about the first offer in the array", () => {
  // The case provider-matching exists for, and it was previously untested: the
  // fixture had no entry with more than one offer and none whose offers[].provider
  // differed from the row's. The live catalogue has 973 entries with two or more
  // offers and 792 where offers[0] belongs to another host, so reverting to
  // offers[0] -- the exact defect the comment at priceOf records -- passed the
  // whole suite while badging rows with a different vendor's price.
  //
  // Foreign offers only: the honest answer is null, never the first offer's zero.
  assert.equal(priceOf(byId["multi-foreign-only"], "multi"), null);
  assert.equal(priceOf(byId["multi-foreign-only"]), null, "two usable offers, none identifiable");
  assert.equal(badgeOf(byId["multi-foreign-only"], { providerName: "multi" }), "",
    "a free-looking foreign offer must not badge the row FREE");

  // Mine present but not first: the matching offer wins, so a reversion to
  // offers[0] returns 9.00/9.00 here and this fails.
  assert.deepEqual(priceOf(byId["multi-mine-second"], "multi"), { in: 1, out: 2 });
});

test("priceOf returns null for the legacy shape keysync's inferTier reads", () => {
  assert.equal(priceOf(byId["acme-legacy-1"]), null);
  assert.equal(priceOf(byId["blank-a"]), null);
});

test("isTextOut is true when output modality is absent or includes text", () => {
  assert.equal(isTextOut(byId["acme-chat-1"]), true);
  assert.equal(isTextOut(byId["blank-a"]), true);
  assert.equal(isTextOut(byId["acme-image-1"]), false);
});

test("badgeOf: no price evidence renders blank, never PAID", () => {
  assert.equal(badgeOf(byId["blank-a"]), "");
  assert.equal(badgeOf(byId["acme-legacy-1"]), "");
});

test("badgeOf: a non-zero token price is PAID", () => {
  assert.equal(badgeOf(byId["acme-pro-1"]), "PAID");
});

// THE THREE CADENCE TESTS BELOW MOVED FROM `acme-chat-1` TO `acme-free-1` WHEN
// G2 LANDED, and the move is what preserves them rather than what weakens them.
// `acme-chat-1` is the #55 price-absence shape -- its every offer is zero -- so
// G2 now returns "" before any cadence branch runs. Left where they were, all
// three would have been asserting G2's blank while claiming to be about cadence;
// two would have failed outright and the third would have stayed green for a
// reason that had nothing to do with the branch it names.
//
// `acme-free-1` replicates `mistral/labs-devstral-small-2512`, the one genuinely
// free row in the live corpus: the offer `priceOf` matches is 0/0, and a non-zero
// sibling in the same array proves the bundle really did price this model. That
// is the only shape that still reaches the cadence branches, so it is the only
// shape these tests can be written on.
//
// `providerName` is now required. Two usable offers cannot be told apart without
// it -- that is priceOf's own rule, not a new one -- and every production call
// site passes it.
test("badgeOf: zero price with unknown cadence is FREE?", () => {
  assert.equal(badgeOf(byId["acme-free-1"], { providerName: "acme" }), "FREE?");
  assert.equal(badgeOf(byId["acme-free-1"], { providerName: "acme", cadence: "" }), "FREE?");
});

test("badgeOf: zero price with a recurring grant is FREE", () => {
  assert.equal(badgeOf(byId["acme-free-1"], { providerName: "acme", cadence: "recurring" }), "FREE");
});

test("badgeOf: zero price with a one-time grant is blank, not FREE and not PAID", () => {
  // This one still PASSED on `acme-chat-1` after G2 -- both paths return "" --
  // which is exactly why it had to move. Deleting the one-time branch entirely
  // left it green there, so it had stopped covering anything. On `acme-free-1`
  // the blank can only come from the cadence branch it names.
  assert.equal(badgeOf(byId["acme-free-1"], { providerName: "acme", cadence: "one-time" }), "");
  assert.equal(badgeOf(byId["acme-free-1"], { providerName: "acme", cadence: "none" }), "");
});

test("badgeOf: guard G1 blanks a zero token price on a non-text-output model", () => {
  assert.equal(badgeOf(byId["acme-image-1"]), "");
  assert.equal(badgeOf(byId["acme-image-1"], { cadence: "recurring" }), "");
});

// ------------------------------------------------------- guard G2 (R5b, #67)
//
// Both fixtures are live shapes, MEASURED 2026-09-07, and BOTH halves are
// required: a suite carrying only the all-zero case is satisfied by returning ""
// unconditionally from the zero branch, which would delete the genuine free tier
// along with the lie. These are inline rather than added to fixtures/catalog.json
// because that file is shared with the pre-G2 badge tests above and R5b's write
// scope does not include it.
const ALL_ZERO = { modalities: { output: ["text"] }, pricing: { offers: [
  // `openai/omni-moderation-latest`: priced per request, recorded as a token
  // price of zero. 123 of the picker's 124 FREE? rows are this shape.
  { provider: "openai", per1MTokens: { input: 0, output: 0 },
    sourceUnit: "usd_per_1m_tokens" },
] } };
const GENUINE_FREE = { modalities: { output: ["text"] }, pricing: { offers: [
  // `mistral/labs-devstral-small-2512`, the 1. `priceOf` matches the FIRST
  // mistral offer, so the matched price is 0/0 on an entry that is really priced.
  { provider: "mistral", per1MTokens: { input: 0, output: 0 },
    sourceUnit: "usd_per_1m_tokens" },
  { provider: "mistral", per1MTokens: { input: 0.1, output: 0.3 },
    sourceUnit: "usd_per_token_for_token_fields" },
] } };

test("badgeOf: guard G2 blanks a zero price the bundle never recorded", () => {
  // #55: "not priced per token" is stored as {input: 0, output: 0}, shape-
  // identical to a free tier. FREE? here asserted a price the catalogue does not
  // contain, on the axis a user makes cost decisions with.
  assert.equal(badgeOf(ALL_ZERO, { providerName: "openai" }), "");
  assert.equal(priceOf(ALL_ZERO, "openai").in, 0,
    "the row really does reach the zero branch -- otherwise this proves nothing");
});

test("badgeOf: guard G2 does NOT blank a real free tier, and that is the discriminator", () => {
  // The single row in the live corpus that must keep its badge. Inverting G2 --
  // blanking when a price IS present -- fails here and nowhere else.
  assert.equal(badgeOf(GENUINE_FREE, { providerName: "mistral" }), "FREE?");
});

test("badgeOf: G2 runs before the cadence branches, not after", () => {
  // A provider-level grant cadence says nothing about a model the bundle never
  // priced, so `recurring` must not promote an absent price to the hard FREE
  // claim. No live row reaches this path today (the corpus tally has zero FREE),
  // which is why the ordering is asserted here rather than observed in the
  // corpus: this is the branch that would make the defect worse the first time a
  // provider profile gains a recurring cadence.
  assert.equal(badgeOf(ALL_ZERO, { providerName: "openai", cadence: "recurring" }), "");
  // And the FREE path itself is unchanged where a price really exists -- moving
  // G2 after the cadence check leaves this green, so the pair is what pins the order.
  assert.equal(badgeOf(GENUINE_FREE, { providerName: "mistral", cadence: "recurring" }), "FREE");
});

test("badgeOf: G2 changes only the zero branch -- PAID, PLAN and G1 are untouched", () => {
  // The diff is provably one branch wide. Each of the other paths is asserted on
  // a shape that carries the G2 subject (an all-zero offer array) wherever it
  // can, so a G2 that leaked out of its branch would be caught here.
  assert.equal(badgeOf({ modalities: { output: ["text"] }, pricing: { offers: [
    { provider: "p", per1MTokens: { input: 0.3, output: 1.2 } } ] } },
    { providerName: "p" }), "PAID", "a real price is still PAID");
  assert.equal(badgeOf(ALL_ZERO, { providerName: "openai", planCovered: true }), "PLAN",
    "planCovered still wins over every price rule, G2 included");
  assert.equal(badgeOf({ ...ALL_ZERO, modalities: { output: ["image"] } },
    { providerName: "openai" }), "", "G1 still owns the non-text case");
  assert.equal(badgeOf({ pricing: { offers: [] } }, { providerName: "openai" }), "",
    "no usable offer is still the no-evidence blank, decided before the zero branch");
});

test("capsOf keeps a measured `false` distinct from an absent key", () => {
  // The whole bug in two assertions. `!!undefined === false` made an entry with no
  // `reasoning` key indistinguishable from one the catalogue measured as lacking
  // reasoning, and 9 of the 45 matched picker rows are in exactly that state.
  //
  // The `false` half is the one that matters, and it is the half a test written
  // only around the unknown case cannot see: mutating `?? null` to `|| null` fixes
  // nothing and breaks this line, because `false || null === null` sends a known
  // capability straight back to unknown (mutation boundary 2).
  assert.equal(capsOf({ capabilities: { reasoning: false } }).reason, false);
  assert.equal(capsOf({ capabilities: {} }).reason, null);

  assert.deepEqual(capsOf({ capabilities: {} }), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf({}), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf(undefined), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf({ capabilities: { toolCalling: true, imageInput: false } }),
                   { tools: true, vision: false, reason: null });
});

test("outputKind blocks only on a positive non-text signal", () => {
  // The four §1.2 rows, by shape rather than by name -- these are the exact
  // modality blocks google/lyria, google/veo-2, nscale/flux.1-schnell and
  // nscale/stable-diffusion-xl-base-1.0 carry.
  assert.equal(outputKind({ modalities: { output: ["audio"] } }), "nontext");
  assert.equal(outputKind({ modalities: { output: ["video"] } }), "nontext");
  assert.equal(outputKind({ modalities: { output: ["image"] } }), "nontext");

  // The embedding/score clause runs FIRST, and this is the only case that shows
  // it: 18 catalogue entries declare embedding alongside text, and an embedding
  // model that also emits text is still not a chat model. Move the text clause
  // above it and this reads "text".
  assert.equal(outputKind({ modalities: { output: ["embedding", "text"] } }), "nontext");
  assert.equal(outputKind({ modalities: { output: ["score", "text"] } }), "nontext");

  // orcarouter/auto's shape: multimodal INPUT with text output stays selectable.
  assert.equal(outputKind({ modalities: { input: ["image", "text"], output: ["text"] } }), "text");
  assert.equal(outputKind({ modalities: { output: ["image", "text"] } }), "text");

  // No signal is null -- unknown, which renders selectable -- never "nontext".
  assert.equal(outputKind({ capabilities: {} }), null);
  assert.equal(outputKind({ modalities: {} }), null);
  assert.equal(outputKind(undefined), null);
  // An EMPTY array is the same absence of signal as a missing field, and it is
  // the one shape where "not text" and "no evidence" are easy to conflate. The
  // cost of getting it wrong is not just a dim row: an unselectable model has
  // its pin dropped from recents and favourites at initState, so a single empty
  // upstream field would delete a user's saved selection. isTextOut in
  // menu/catalog.mjs already reads this shape as text; the two must agree.
  assert.equal(outputKind({ modalities: { output: [] } }), null);
  assert.equal(isTextOut({ modalities: { output: [] } }), true,
    "the two lanes must not disagree about the empty array");

  // The measured miss, asserted so it is a recorded decision rather than a gap:
  // nvidia/bge-m3 is an embedding model the catalogue declares output ["text"].
  // It reads as text and stays selectable, because a positive text signal is all
  // this function has and hiding a real chat model is the worse error (OQ-3).
  assert.equal(outputKind({ modalities: { output: ["text"] } }), "text");
});

test("buildFrom carries the tri-state through, and synthetic rows do not invent one", () => {
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5"] },
  }));
  const acme = rows.find((r) => r.provider === "acme");
  const row = Object.fromEntries(acme.models.map((m) => [m.id, m]));

  // capabilities: {toolCalling: true, imageInput: false, reasoning: true}
  assert.equal(row["acme-chat-1"].tools, true);
  assert.equal(row["acme-chat-1"].vision, false, "a measured false stays false");
  // capabilities: {} -- no key at all
  assert.deepEqual([row["acme-image-1"].tools, row["acme-image-1"].vision,
                    row["acme-image-1"].reason], [null, null, null]);
  // capabilities: {..., reasoning: false}
  assert.equal(row["acme-pro-1"].reason, false);

  // A testModel with no catalogue entry: the row exists BECAUSE nothing was
  // measured, so all-false would be a claim the code cannot support.
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const solo = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }], providers: p,
  })).rows[0].models[0];
  assert.equal(solo.id, "acme-unlisted");
  assert.deepEqual([solo.tools, solo.vision, solo.reason], [null, null, null]);

  // The relay is the one all-true set that survives: the Anthropic subscription
  // models are known first-hand, not looked up.
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.deepEqual([relay.models[0].tools, relay.models[0].vision, relay.models[0].reason],
                   [true, true, true]);
});

test("buildFrom labels each model's output modality on the row itself", () => {
  // On the row, not looked up later. The row-building loop already holds the
  // catalogue entry, so there is no second match to loosen into a cross-provider
  // one -- which is how orcarouter/auto once matched morph/auto.
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5"] },
  }));
  const acme = rows.find((r) => r.provider === "acme");
  const row = Object.fromEntries(acme.models.map((m) => [m.id, m]));
  assert.equal(row["acme-chat-1"].outputKind, "text");
  assert.equal(row["acme-image-1"].outputKind, "nontext", "output: [image]");
  assert.equal(row["acme-legacy-1"].outputKind, null, "no modalities block at all");

  // Synthetic rows, consistent with their capability values: a testModel with no
  // catalogue entry has no measured modality either, and the relay's four models
  // are chat models known first-hand.
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const solo = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }], providers: p,
  })).rows[0].models[0];
  assert.equal(solo.outputKind, null);
  assert.equal(rows.find((r) => r.provider === "anthropic").models[0].outputKind, "text");
});

test("badgeOf: planCovered wins over price", () => {
  assert.equal(badgeOf(byId["acme-pro-1"], { planCovered: true }), "PLAN");
  assert.equal(badgeOf(byId["blank-a"], { planCovered: true }), "PLAN");
});

const input = (overrides = {}) => ({
  chosen: [
    { id: "personal.acme.free", provider: "acme" },
    { id: "personal.blank.paid", provider: "blank" },
  ],
  providers: new Map([
    ["acme", { testModel: "acme-chat-1", notes: "", requiresBalance: false }],
    ["blank", { testModel: "blank-a", notes: "", requiresBalance: false }],
  ]),
  catalog: catalog(),
  ...overrides,
});

test("buildFrom: free is a count when price data exists", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  // Still exactly one FREEISH model, and it is now `acme-free-1` rather than
  // `acme-chat-1`: G2 blanks the price-absence row, and the genuinely free row
  // the fixture gained takes its place. The count is what this test is about, and
  // the count is unchanged. 5, not 4, because the fixture gained that row.
  assert.equal(acme.free, 1);
  assert.equal(acme.models.length, 5);
});

test("buildFrom: free is null when no model has any price data", () => {
  const { rows } = buildFrom(input());
  const blank = rows.find((r) => r.provider === "blank");
  assert.equal(blank.free, null);
  assert.notEqual(blank.free, 0);
});

test("buildFrom: planCount is separate from free", () => {
  const { rows } = buildFrom(input({
    cadenceOf: () => ({ cadence: "", planCovered: true }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.planCount, 5);   // 5, not 4: the fixture gained `acme-free-1`
  assert.equal(acme.free, 0);
});

test("buildFrom: a recurring cadence promotes FREE? to FREE", () => {
  const { rows } = buildFrom(input({
    cadenceOf: (name) => ({ cadence: name === "acme" ? "recurring" : "" }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  // On `acme-free-1` -- the only row that still reaches the cadence branch. The
  // promotion is the assertion; the anchor moved for the reason given above the
  // badgeOf cadence tests.
  assert.equal(acme.models.find((m) => m.id === "acme-free-1").badge, "FREE");
  assert.equal(acme.models.find((m) => m.id === "acme-chat-1").badge, "",
    "and a recurring cadence does NOT promote a price the bundle never recorded");
  assert.equal(acme.free, 1);
});

test("buildFrom: the testModel leads and is not duplicated", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.filter((m) => m.id === "acme-chat-1").length, 1);
});

test("buildFrom: a testModel absent from the catalogue is prepended with a blank badge", () => {
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const { rows } = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p,
  }));
  assert.equal(rows[0].models[0].id, "acme-unlisted");
  assert.equal(rows[0].models[0].badge, "");
});

// ------------------------------------- G2's second-order effect on the row cell
//
// `buildFrom` derives the provider row's `free` cell from the badges, under the
// comment "0 free is a measurement, no price data is the absence of one". G2
// blanks 123 model badges, so it necessarily moves that cell -- bundle-wide it
// flips 25 providers from a number to null and lowers 23 more. That is the fix
// working, and it is asserted here so the effect is pinned rather than discovered
// later at the picker.
const priceCatalog = (models) => {
  const byProvider = new Map();
  for (const m of models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { byProvider, generatedAt: doc.generatedAt };
};
const zeroModel = (provider, model) => ({ provider, model,
  modalities: { output: ["text"] }, capabilities: {},
  pricing: { offers: [{ provider, per1MTokens: { input: 0, output: 0 } }] } });
const paidModel = (provider, model) => ({ provider, model,
  modalities: { output: ["text"] }, capabilities: {},
  pricing: { offers: [{ provider, per1MTokens: { input: 0.3, output: 1.2 } }] } });

test("buildFrom: an all-unpriced catalogue flips `free` from a count to null", () => {
  // The 25-provider case, in miniature -- `gitlab` (23 of 23), `ollama` (14 of
  // 14) and `kenari` (8 of 8) are all-FREE? catalogues that become all-blank.
  // Before G2 both rows badged FREE? and this cell read 2; `priced` is now false,
  // so the honest cell is null. null and 0 are different claims, which is the
  // whole point of the nullable: `notEqual` guards the coercion.
  const { rows } = buildFrom({
    chosen: [{ id: "personal.allzero.free", provider: "allzero" }],
    providers: new Map([["allzero", { notes: "", requiresBalance: false }]]),
    catalog: priceCatalog([zeroModel("allzero", "z-1"), zeroModel("allzero", "z-2")]),
  });
  assert.deepEqual(rows[0].models.map((m) => m.badge), ["", ""]);
  assert.equal(rows[0].free, null);
  assert.notEqual(rows[0].free, 0, "no price data is not a measurement of zero free models");
});

test("buildFrom: a partly-priced catalogue merely lowers `free`, it does not null it", () => {
  // The other 23 -- `nvidia` -34, `opencode` -20, `kilo` -19. One real price in
  // the catalogue keeps `priced` true, so the cell stays a number and drops to 0.
  // Without this half, a G2 that nulled every provider would still look correct.
  const { rows } = buildFrom({
    chosen: [{ id: "personal.mixed.paid", provider: "mixed" }],
    providers: new Map([["mixed", { notes: "", requiresBalance: false }]]),
    catalog: priceCatalog([zeroModel("mixed", "z-1"), paidModel("mixed", "p-1")]),
  });
  assert.deepEqual(rows[0].models.map((m) => m.badge), ["", "PAID"]);
  assert.equal(rows[0].free, 0, "a measured zero, not an absence");
  assert.notEqual(rows[0].free, null);
});

// ------------------------------------------------------ the corpus (R5b, #67)

test("corpus: over the real catalogue, a FREE? badge always has a price behind it", () => {
  // `catalog/snapshot.json`'s rows re-badged against the live bundle through
  // `loadCatalog()` -- the same join the picker performs.
  //
  // WHY THIS ASSERTS INVARIANTS AND NOT COUNTS. `loadCatalog` reads a hardcoded
  // absolute path into the machine's global `claude-code-router` install, and
  // that bundle is replaced wholesale by an `npm i -g` -- report 08 F9's recorded
  // hazard. Pinning `124 -> 1` here would make a true statement about one bundle
  // version and then rot into a false failure on the next one. The two
  // implications below hold at ANY bundle version, and they are what G2 actually
  // claims. The counts belong in this comment, where going stale is harmless:
  //
  //   MEASURED at catalog.generatedAt 2026-08-24T12:22:28.162Z, 1,588 rows:
  //   badges {"": 925, PAID: 535, FREE?: 124, PLAN: 4} become
  //          {"": 1048, PAID: 535, FREE?: 1, PLAN: 4}; the 123 blanked rows all
  //   have every offer zero, and the single survivor is
  //   `mistral/labs-devstral-small-2512`, whose matched offer is itself 0/0.
  const snap = JSON.parse(fs.readFileSync(
    new URL("../catalog/snapshot.json", import.meta.url), "utf8"));
  const { byProvider } = loadCatalog();

  const survivors = [], blanked = [], paid = [];
  for (const row of snap.rows) {
    const entries = new Map((byProvider.get(row.provider) ?? []).map((e) => [e.model, e]));
    for (const m of row.models) {
      // The relay's rows are synthetic -- no catalogue entry, PLAN by
      // construction -- and never reached badgeOf's price rules at all.
      const entry = m.badge === "PLAN" ? null : entries.get(m.id);
      if (!entry) continue;
      const price = priceOf(entry, row.provider);
      const badge = badgeOf(entry, { providerName: row.provider });
      const target = `${row.provider}/${m.id}`;
      if (badge === "FREE?") survivors.push(target);
      // The rows G2 is the only possible cause of: they reach the zero branch,
      // they clear G1, and they still come out blank. Derived from the conditions
      // that route a row INTO G2 rather than by re-implementing the pre-G2 rule,
      // so this test holds no second copy of production logic.
      if (price && price.in === 0 && price.out === 0 && isTextOut(entry) && badge === "") {
        blanked.push(target);
      }
      if (price && (price.in !== 0 || price.out !== 0)) paid.push([target, badge]);
    }
  }

  for (const t of survivors) {
    const [provider, ...rest] = t.split("/");
    const entry = byProvider.get(provider).find((e) => e.model === rest.join("/"));
    assert.equal(hasPricedOffer(entry), true,
      `${t} badges FREE? but no offer on it names a price`);
  }
  for (const t of blanked) {
    const [provider, ...rest] = t.split("/");
    const entry = byProvider.get(provider).find((e) => e.model === rest.join("/"));
    assert.equal(hasPricedOffer(entry), false,
      `${t} was blanked by G2 but the bundle does hold a price for it`);
  }
  // G2 lives inside the zero branch, so it can never reach a row with a real
  // price. Asserted over the corpus rather than the fixture: this is the
  // "one branch wide" claim, against 535 live rows.
  for (const [t, badge] of paid) assert.equal(badge, "PAID", `${t} has a price and must be PAID`);

  // Non-vacuity. Without this the two loops above pass on an empty corpus, on a
  // missing bundle, or on a G2 that never fires. The blanked class is the robust
  // one to guard -- 123 rows at the measured version -- and it is the class that
  // catches a stub blanking the whole zero branch, because such a stub sweeps the
  // genuinely-priced row into `blanked` and the second loop rejects it.
  assert.equal(blanked.length > 0, true, "no row reached G2 -- the corpus proves nothing");
  assert.equal(paid.length > 0, true, "no priced row in the corpus -- the join is broken");
});

test("buildFrom: ids that fail admitId are dropped, not rendered", () => {
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "evil\x1b[2J", capabilities: {} });
  const { rows } = buildFrom(input({ catalog: c }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.some((m) => m.id.includes("\x1b")), false);
  assert.equal(acme.models.length, 5);   // 5, not 4: the fixture gained `acme-free-1`
});

test("buildFrom: the relay is injected with PLAN badges", () => {
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5", "claude-sonnet-5"] },
  }));
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.equal(relay.keyId, "relay.anthropic.subscription");
  assert.equal(relay.models.every((m) => m.badge === "PLAN"), true);
  assert.equal(relay.free, null);
  assert.equal(relay.planCount, 2);
});

test("the routable predicate reaches every row, synthetic sites included", () => {
  // B1's shape, asserted where it is pure. `buildFrom` defaulted `routableOf` to
  // `() => null` and `build()` never overrode it, so the parameter was reachable
  // only from this file's own tests and every real row carried no routability at
  // all. The two synthetic sites are named explicitly because they construct
  // their rows by hand and are exactly where a threading fix gets forgotten.
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  for (const answer of [true, false]) {
    const { rows } = buildFrom(input({
      chosen: [{ id: "personal.acme.free", provider: "acme" }],
      providers: p,
      relay: { provider: "anthropic", models: ["claude-opus-5"] },
      routableOf: () => answer,
    }));
    const every = rows.flatMap((r) => r.models);
    assert.equal(every.length > 2, true, "fixture must cover catalogue and synthetic rows");
    assert.deepEqual([...new Set(every.map((m) => m.routable))], [answer],
      `every row must carry ${answer}`);
    assert.equal(rows[0].models.find((m) => m.id === "acme-unlisted").routable, answer,
      "the testModel row builds its object by hand");
    assert.equal(rows.find((r) => r.provider === "anthropic").models[0].routable, answer,
      "so does the relay row");
  }

  // The predicate is asked about the TARGET, not the bare id -- a bare id would
  // be the cross-provider match that once made orcarouter/auto look like
  // morph/auto.
  const asked = [];
  buildFrom(input({ routableOf: (t) => { asked.push(t); return null; } }));
  assert.equal(asked.every((t) => t.includes("/")), true);
  assert.equal(asked.includes("acme/acme-chat-1"), true);
});

test("no comment under menu/ names a module that was never built", () => {
  // B5, and it is the causal root rather than a tidiness point: routableSet's
  // doc comment claimed "exactly one caller, refresh/cli.mjs" for the whole life
  // of the file. There is no refresh/ directory -- the module was planned and
  // never written -- so an auditor looking for the caller met a confident
  // sentence instead of an absence, and the missing wire survived design review
  // twice.
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw", "menu");
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".mjs"))) {
    const body = fs.readFileSync(path.join(dir, name), "utf8");
    for (const [, ref] of body.matchAll(/`?\b([a-z][a-z0-9-]*)\/([a-z][a-z0-9.-]*\.mjs)\b/g)) {
      if (ref === "menu") continue;
      assert.equal(fs.existsSync(path.join(dir, "..", ref)), true,
        `${name} names ${ref}/, which does not exist`);
    }
  }
});

test("writeAtomic leaves no partial file and replaces the previous contents", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.json");
  writeAtomic(f, '{"v":1}');
  writeAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":2}');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});

test("a failed writeAtomic leaves the target intact and no debris behind", () => {
  // The target was already safe -- it keeps its previous contents, which is the
  // guarantee. What was not safe is the leftover `<file>.tmp-<pid>`: a full disk
  // or a revoked permission left one on every attempt, and the picker's own state
  // tests assert no such file survives a write.
  //
  // Forced by renaming onto a non-empty directory, which fails after the temp file
  // has been created and written.
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic-fail");
  const target = path.join(dir, "occupied");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "child"), "keep me");

  assert.throws(() => writeAtomic(target, '{"v":1}'), "a real failure must still fail");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), [],
    "the temp file must not survive the failure");
  assert.equal(fs.readFileSync(path.join(target, "child"), "utf8"), "keep me");
});

test("buildFrom stays silent: the display path must not write to the console", () => {
  // buildFrom runs inside the picker, which owns a full-screen frame in the
  // alternate screen. admitRemoteModels' SECURITY line landed in the middle of
  // one. Zero rejections across the 4,298 bundled ids today, so it was latent --
  // and it goes live with Task B6, where discovery returns raw provider strings
  // instead of a curated bundle. The routing path still reports the same
  // rejections, with an ordinary stdout.
  const c = catalog();
  c.byProvider.set("evil", [{ provider: "evil", model: "uw/fast", capabilities: {} },
                            { provider: "evil", model: "ok-1", capabilities: {} }]);
  const said = [];
  const realWarn = console.warn;
  console.warn = (m) => said.push(String(m));
  try {
    buildFrom({ chosen: [{ id: "personal.evil.free", provider: "evil" }],
                providers: new Map([["evil", { testModel: "uw/slot-1", notes: "" }]]),
                catalog: c });
  } finally { console.warn = realWarn; }
  assert.deepEqual(said, [], "the picker's build path must print nothing");
});

test("the slot round-trips atomically and survives a missing or corrupt file", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "slot");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "slot.json");
  fs.rmSync(f, { force: true });

  assert.equal(readSlot(f), "", "a missing slot reads as no pin, not a throw");

  writeSlot("acme/acme-chat-1", f);
  assert.equal(readSlot(f), "acme/acme-chat-1");
  // Through writeAtomic: a plain write truncates in place, so an interrupt leaves
  // a prefix that readSlot's catch turns into "" -- a pin silently forgotten
  // rather than an error. No temp file may survive either.
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);

  writeSlot("zeta/zeta-two", f);
  assert.equal(readSlot(f), "zeta/zeta-two", "a rewrite replaces rather than appends");

  fs.writeFileSync(f, '{"model": "acme/hal');   // the truncation shape itself
  assert.equal(readSlot(f), "", "a half-written slot reads as no pin");
});

test("readJsonOr never throws", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ truncated");
  assert.deepEqual(readJsonOr(bad, { fallback: true }), { fallback: true });
  assert.deepEqual(readJsonOr(path.join(dir, "nope.json"), null), null);
});

test("routableSet reports whether its answer is fresh, and never throws", async () => {
  const live = await routableSet({
    rpc: async () => ({ Providers: [{ name: "acme", models: ["acme-chat-1"] }] }),
  });
  assert.equal(live.fresh, true);
  assert.equal(live.set.has("acme/acme-chat-1"), true);

  const dead = await routableSet({ rpc: async () => null });
  assert.equal(dead.fresh, false);
  assert.equal(dead.set instanceof Set, true);
  assert.equal(dead.set.size, 0);
});

test("routableOf turns a set into the per-row field, and absence means unknown", () => {
  // fresh=false must not become "everything is unroutable": that would dim all
  // 1,584 rows the one time the gateway is down, which is the most alarming
  // possible rendering of "nobody asked". Unknown is null, and null does not dim.
  const known = makeRoutableOf(new Set(["acme/acme-chat-1"]), true);
  assert.equal(known("acme/acme-chat-1"), true);
  assert.equal(known("acme/acme-pro-1"), false);
  const unknown = makeRoutableOf(new Set(), false);
  assert.equal(unknown("acme/acme-chat-1"), null);
});

// ------------------------------------------- provenance and refused[] (R14)
//
// `discovery` is shaped like `catalog` -- `{byProvider: Map}` -- so the fixtures
// below build it the same way `catalog()` does. Entries carry `capabilityRaw`,
// which is the field `refresh/discover.mjs:494` actually writes; the plan calls
// it "the provider's own capability field" and this is that field's name.
const discoveryOf = (byProvider) => ({ byProvider: new Map(Object.entries(byProvider)) });

test("buildFrom: provenance tells the listing-only and bundle-only populations apart", () => {
  // The union is what makes the label meaningful: without it a model named ONLY
  // by the provider's listing never becomes a row, so `listing-verified` would
  // label an empty set and the observable would pass vacuously.
  const discovery = discoveryOf({ acme: [{ id: "acme-listed-only" }] });
  const { rows } = buildFrom(input({
    discovery,
    provenanceOf: (_p, id) => id === "acme-listed-only" ? "listing-verified" : "catalogue-only",
  }));
  const acme = rows.find((r) => r.provider === "acme");
  const row = Object.fromEntries(acme.models.map((m) => [m.id, m]));

  assert.equal(row["acme-listed-only"].provenance, "listing-verified");
  assert.equal(row["acme-chat-1"].provenance, "catalogue-only");
  assert.equal(acme.models.length, 6, "5 bundle rows plus the listing-only one");
  // A listing-only row has no bundle entry, so every bundle-derived field is the
  // honest null rather than a coerced zero -- the same rule the synthetic
  // testModel row already follows.
  assert.deepEqual([row["acme-listed-only"].ctx, row["acme-listed-only"].pin,
                    row["acme-listed-only"].tools], [null, null, null]);
});

test("buildFrom: the vault testModel is config-asserted and survives the listing", () => {
  // BOTH halves matter. The label is the #59 correction; the survival is the half
  // that was already true and must stay asserted, so that correcting the label
  // cannot quietly become a prune (D3 §4.1). The listing here deliberately does
  // NOT name the testModel.
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const { rows } = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p,
    discovery: discoveryOf({ acme: [{ id: "acme-listed-only" }] }),
    provenanceOf: () => "listing-verified",
  }));
  const tm = rows[0].models.find((m) => m.id === "acme-unlisted");
  assert.notEqual(tm, undefined, "the testModel row survives a listing that omits it");
  assert.equal(tm.provenance, "config-asserted");
  // The literal wins over the injected predicate: a config row is not evidence
  // about a listing, so a caller cannot promote it by answering for every id.
  assert.notEqual(tm.provenance, "listing-verified");
});

test("buildFrom: no row carries call-verified, over a fixture holding both literals", () => {
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const { rows } = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p,
    relay: { provider: "anthropic", models: ["claude-opus-5", "claude-sonnet-5"] },
    discovery: discoveryOf({ acme: [{ id: "acme-listed-only" }] }),
    provenanceOf: () => "listing-verified",
  }));
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.equal(relay.models.every((m) => m.provenance === "config-asserted"), true);
  assert.equal(relay.models.every((m) => m.provenance !== null), true);

  // Non-vacuity: the sweep below proves nothing unless the fixture actually
  // reaches both config literals, so their presence is asserted first.
  const every = rows.flatMap((r) => r.models);
  assert.equal(every.some((m) => m.id === "acme-unlisted"), true, "the testModel literal");
  assert.equal(every.some((m) => m.id === "claude-opus-5"), true, "the relay literal");
  assert.equal(every.some((m) => m.provenance === "call-verified"), false);
});

test("menu/catalog.mjs never assigns the call-verified rung", () => {
  // The row-level sweep above passes on any fixture that happens not to reach the
  // literal. This is the assertion that fails when someone re-adds it: every prior
  // revision of this task assigned `call-verified` to exactly these two config
  // literals, on a ladder whose top rung means "a real completion returned 200"
  // and which has no producer on this branch (#59).
  //
  // QUOTED FORMS ONLY. The rung is discussed in prose in that file, in backticks,
  // and a match on the bare word would forbid explaining why it is absent.
  const src = fs.readFileSync(new URL("../menu/catalog.mjs", import.meta.url), "utf8");
  assert.equal(/['"]call-verified['"]/.test(src), false);
});

test("buildFrom: the discovery and provenance defaults are inert", () => {
  // Called exactly as every pre-R14 caller calls it. Both fixture testModels are
  // catalogue ids, so no synthetic row is built and no config literal is reached
  // -- which is why `null` is the whole answer here, and why the two literals are
  // asserted in their own tests above rather than excepted from this one.
  const { rows } = buildFrom(input());
  const every = rows.flatMap((r) => r.models);
  assert.deepEqual([...new Set(every.map((m) => m.provenance))], [null]);

  // And no row disappeared: the pre-change counts, unchanged.
  assert.equal(rows.find((r) => r.provider === "acme").models.length, 5);
  assert.equal(rows.find((r) => r.provider === "blank").models.length, 2);
  assert.equal(rows.every((r) => Array.isArray(r.refused) && r.refused.length === 0), true,
    "a provider withholding nothing emits [], not a missing key");
});

test("buildFrom: a live capability outranks the bundle's declared output modality", () => {
  // `nvidia/bge-m3`'s shape (OQ-3): the bundle declares output ["text"], so the
  // bundle ALONE reads "text" and the row stays selectable -- the recorded miss.
  // The provider's own listing is the only evidence that it is not a chat model.
  const discovery = discoveryOf({ acme: [{ id: "acme-chat-1", capabilityRaw: "embedding" }] });
  const withListing = buildFrom(input({ discovery })).rows.find((r) => r.provider === "acme");
  assert.equal(withListing.models.find((m) => m.id === "acme-chat-1").outputKind, "nontext");

  // The discriminator. Without it, an implementation that hardcoded "nontext"
  // would pass the line above.
  const without = buildFrom(input()).rows.find((r) => r.provider === "acme");
  assert.equal(without.models.find((m) => m.id === "acme-chat-1").outputKind, "text");
});

test("buildFrom: a bare listing name joins to nothing", () => {
  // D3 §4.3's bare-name guard: a listing naming `chat-1` with no vendor prefix
  // is only ever looked up as `${provider}/chat-1`, never as itself and never by
  // tail -- so it cannot reach another provider's row, and it cannot reach
  // `acme-chat-1` either without a vendor-qualified shape. Loosening this is the
  // cross-provider match that once made orcarouter/auto look like morph/auto.
  const discovery = discoveryOf({ acme: [{ id: "chat-1", capabilityRaw: "embedding" }] });
  const acme = buildFrom(input({ discovery })).rows.find((r) => r.provider === "acme");
  const row = Object.fromEntries(acme.models.map((m) => [m.id, m]));
  assert.equal(row["acme-chat-1"].outputKind, "text", "the bundle row is untouched by it");
  assert.equal(row["chat-1"].outputKind, "nontext", "the bare name becomes its own row");
  assert.equal(row["chat-1"].tools, null, "and joins to no bundle facts");
});

test("buildFrom: a live id joins real capsOf/ctx from a DIFFERENT provider's bundle row (D3 §1 rung 4, vendor-qualified tail)", () => {
  // R14's own title: "wire the join". Without it, a listing-only row would carry
  // three nulls for tools/vision/reason and a null ctx -- an honest-looking
  // "unknown" that is actually a join this codebase already knows how to make,
  // via the SAME `joinCatalogEntry` call keysync.mjs's own routing lane uses for
  // this exact population (keysync.mjs:1073). Rung 4 (not rung 2) is the
  // discriminating case to test: a same-provider cosmetic spelling joins to a
  // bundle row `acme`'s OWN site 1 already emitted under its real spelling, so
  // the two correctly collapse to one row (see the "never promotes a duplicate"
  // test below) and cannot demonstrate enrichment on its own. A cross-provider
  // tail match resolves to a row `acme`'s site 1 never touches, so the joined
  // row here is genuinely new, not a collapsed duplicate.
  const c = catalog();
  c.byProvider.set("sharedvendor", [{ provider: "sharedvendor", id: "sharedvendor/shared-model",
    model: "shared-model", modalities: { output: ["text"] }, limits: { contextTokens: 99999 },
    capabilities: { toolCalling: true, imageInput: false, reasoning: true } }]);
  // A vendor prefix that names neither "acme" nor "sharedvendor" -- the tail
  // match falls through to the tail bucket's only entry, which is exactly rung
  // 4's "no vendor match, bundle order" tie-break, not a coincidence of naming.
  const discovery = discoveryOf({ acme: [{ id: "someother/shared-model" }] });
  const acme = buildFrom(input({ catalog: c, discovery })).rows.find((r) => r.provider === "acme");
  const row = acme.models.find((m) => m.id === "someother/shared-model");
  assert.notEqual(row, undefined, "the live spelling still becomes its own row");
  assert.equal(row.ctx, 99999, "the join must supply the bundle's real window, not null");
  assert.deepEqual([row.tools, row.vision, row.reason], [true, false, true],
    "real tri-state values from the join, not three nulls");
});

test("buildFrom: a live id never promotes into a duplicate row when the join resolves to a bundle entry already emitted (F8)", () => {
  // Without this dedup, a live id that cosmetically differs from a bundle id
  // for the SAME provider would ship as an indistinguishable second row --
  // same ctx, same capabilities, same everything -- inflating `models.length`
  // and the §2.5(a) count while `admit`'s complementarity property stayed green
  // (both spellings really are distinct members of `seen`), the exact
  // [[counts-carry-their-denominator]] failure of a number describing the wrong
  // population.
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", id: "acme/acme-newmodel", model: "acme-newmodel",
    modalities: { output: ["text"] }, limits: { contextTokens: 99999 },
    capabilities: { toolCalling: true, imageInput: false, reasoning: true } });
  const before = buildFrom(input({ catalog: c })).rows.find((r) => r.provider === "acme").models.length;
  const discovery = discoveryOf({ acme: [{ id: "acme.newmodel" }] });
  const acme = buildFrom(input({ catalog: c, discovery })).rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.length, before,
    "the live spelling must not add a second row for the same bundle entry");
  assert.equal(acme.models.some((m) => m.id === "acme.newmodel"), false,
    "the live spelling is not the row that survives -- the bundle's own row is");
  assert.equal(acme.models.find((m) => m.id === "acme-newmodel").ctx, 99999,
    "the bundle's own row keeps its real facts, untouched by the collapsed duplicate");
});

test("buildFrom: discovery's real cache-record shape ({outcome, models, at}) works, not just a bare array (F3)", () => {
  // R10's real cache record for a provider that answered is
  // `{outcome: "ok", models: [...], at}` (refresh/discover.mjs), never a bare
  // array -- `discoveryOf`'s own helper above passes a bare array because that
  // is what a hand-built fixture reaches for, and every other test in this file
  // uses it. Reading `discovery.byProvider.get(provider)` directly (a bare
  // `.get() ?? []`) would silently treat the real record as an empty array of
  // "own properties to iterate", producing zero candidates against production
  // data -- untested here until now because no fixture exercised the real
  // shape. `K.discoveryIndex` (shared with keysync.mjs's own routing lane,
  // keysync.mjs:931-944) is what makes this shape and the bare-array shape
  // equivalent inputs.
  const discovery = { byProvider: new Map([
    ["acme", { outcome: "ok", at: "2026-09-08T00:00:00Z",
      models: [{ id: "acme-listed-only", capabilityRaw: null }] }],
  ]) };
  const acme = buildFrom(input({ discovery })).rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.some((m) => m.id === "acme-listed-only"), true,
    "a listing-only id from the real cache-record shape must still become a row");

  // A provider that didn't answer carries no `models` key at all -- must
  // degrade to zero candidates, never throw.
  const noAnswer = { byProvider: new Map([
    ["acme", { outcome: "auth", at: "2026-09-08T00:00:00Z" }],
  ]) };
  assert.doesNotThrow(() => buildFrom(input({ discovery: noAnswer })));
});

test("buildFrom: a cosmetic collision holds complementarity AND carries the live capability onto the surviving row (F9/F10)", () => {
  // The compound case F8's first fix missed: a cosmetic collision must not just
  // avoid a duplicate row (F8) -- the collapsed candidate must still be
  // COUNTED (F9: it cannot vanish from both models[] and refused[]) and its
  // live capability must still reach the row that survives (F10: R14's own
  // third title clause, "live capability overrides outputKind", failing
  // silently is not an acceptable way to fix F8).
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", id: "acme/acme-newmodel", model: "acme-newmodel",
    modalities: { output: ["text"] }, limits: { contextTokens: 99999 }, capabilities: {} });
  const discovery = discoveryOf({ acme: [
    { id: "acme-listed-only" },
    { id: "acme.newmodel", capabilityRaw: "embedding" }, // cosmetic collision with acme-newmodel
  ] });
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const acme = buildFrom(input({ chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p, catalog: c, discovery })).rows[0];

  // F8, still holding: no duplicate row under the live spelling.
  assert.equal(acme.models.some((m) => m.id === "acme.newmodel"), false);

  // F9: every real candidate is counted exactly once. The cosmetic pair is ONE
  // candidate, not two -- 5 bundle rows (from `catalog()`'s base fixture) +
  // `acme-listed-only` + the collapsed `acme-newmodel`/`acme.newmodel` pair +
  // `acme-unlisted` = 8 real candidates, not 9.
  const candidateCount = c.byProvider.get("acme").length - 1 // -1: acme-newmodel and
    + 1                                                       //     acme.newmodel are ONE
    + 1  // acme-listed-only
    + 1; // acme-unlisted
  assert.equal(acme.models.length + acme.refused.length, candidateCount);

  // F10: the live capability reaches the row that survives, even though it was
  // declared under a different spelling than the row's own.
  assert.equal(acme.models.find((m) => m.id === "acme-newmodel").outputKind, "nontext",
    "the live capabilityRaw must demote the surviving row's outputKind");
});

test("buildFrom: a hostile live id that joins to a clean bundle entry is still gated on its OWN raw text, never displayed (F11, #52 class)", () => {
  // The security regression the F9/F10 fix (canonical-keyed admission) opened:
  // gating on the CANONICAL id and displaying the RAW one lets a hostile raw id
  // launder past `admitRemoteModels` whenever it happens to join to a clean
  // bundle entry -- rung 5's shape-stripping (D3 §1) strips exactly the kind of
  // trailing `[…]` suffix an escape-sequence injection hides behind, so
  // `other/shared-model[\x1b2J]` joins to the clean `shared-model` bundle row.
  // Admissibility must be judged on the string that will actually be shown and
  // used as a routing selector -- the raw one -- never on the canonical
  // substitute identity alone would reach for.
  const c = catalog();
  c.byProvider.set("other", [{ provider: "other", id: "other/shared-model", model: "shared-model",
    modalities: { output: ["text"] }, limits: { contextTokens: 4242 }, capabilities: {} }]);
  const discovery = discoveryOf({ acme: [{ id: "other/shared-model[\x1b2J]" }] });
  const acme = buildFrom(input({ catalog: c, discovery })).rows.find((r) => r.provider === "acme");

  assert.equal(acme.models.some((m) => m.id.includes("other/shared-model")), false,
    "the hostile id must never reach models[], joined or not");
  assert.equal(acme.models.every((m) => !m.id.includes("\x1b")), true,
    "no emitted row's id may contain the escape byte");
  const refusal = acme.refused.find((r) => r.id.includes("shared-model"));
  assert.notEqual(refusal, undefined, "the attempt must be disclosed, not silently dropped");
  assert.equal(refusal.id.includes("\x1b"), false, "the disclosed id is display-safe");
  assert.equal(refusal.removed > 0, true, "the escape byte really was stripped");
});

test("buildFrom: a refused id carries its OWN reason and never appears in models[]", () => {
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "evil\x1b[2J", capabilities: {} });
  // A second refusal under a DIFFERENT rule. This is the discriminator that fails
  // if the widening flattens every refusal to one generic string.
  c.byProvider.get("acme").push({ provider: "acme", model: "uw/squat", capabilities: {} });
  const acme = buildFrom(input({ catalog: c })).rows.find((r) => r.provider === "acme");

  assert.equal(acme.models.some((m) => m.id.includes("\x1b")), false);
  assert.equal(acme.models.some((m) => m.id === "uw/squat"), false);
  assert.equal(acme.refused.length, 2);
  assert.equal(new Set(acme.refused.map((r) => r.reason)).size, 2, "two rules, two reasons");
  assert.equal(acme.refused.some((r) => r.reason === "uw-namespace"), true);

  // R17's shape, consumed unchanged rather than rebuilt: the id is the
  // DISPLAY-SAFE form and `removed` is the code-point delta. Reconstructing the
  // shape here is how the two copies drift, so this asserts the carried one.
  const esc = acme.refused.find((r) => r.reason !== "uw-namespace");
  assert.equal(esc.id.includes("\x1b"), false, "never the raw name");
  assert.equal(typeof esc.reason, "string");
  assert.equal(esc.removed > 0, true, "the escape really was stripped");

  // Carried as DATA, not matched against a closed set. buildFrom produces none of
  // these strings -- denylist.mjs does -- and they arrive unchanged. R11 retires
  // the cap reason, so a `refused[]` that recognised a fixed vocabulary would
  // outlive its own vocabulary.
  assert.equal(acme.refused.every((r) => typeof r.reason === "string" && r.reason), true);
});

test("buildFrom: every candidate is in exactly one of models[] or refused[]", () => {
  // THE COMPLEMENTARITY PROPERTY. It is what makes a withheld count meaningful:
  // a candidate counted on both sides, or on neither, makes `#MODELS/#WITHHELD`
  // a pair of numbers that do not describe one population.
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "evil\x1b[2J", capabilities: {} });
  c.byProvider.get("acme").push({ provider: "acme", model: "uw/squat", capabilities: {} });
  const discovery = discoveryOf({ acme: [
    { id: "acme-listed-only" },
    { id: "acme-chat-1" },      // ALSO a bundle id -- one candidate, not two
    { id: "uw/also-squat" },
  ] });
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const acme = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p, catalog: c, discovery,
  })).rows[0];

  const candidates = new Set([
    ...c.byProvider.get("acme").map((e) => e.model),
    "acme-listed-only", "acme-chat-1", "uw/also-squat", "acme-unlisted",
  ]);
  assert.equal(acme.models.length + acme.refused.length, candidates.size);

  // Never both...
  const inModels = new Set(acme.models.map((m) => m.id));
  for (const r of acme.refused) {
    assert.equal(inModels.has(r.id), false, `${r.id} is on both sides`);
  }
  // ...and never twice on one side, which is the case the union introduces: an id
  // in the bundle AND the listing is one candidate and must be admitted once.
  assert.equal(acme.models.filter((m) => m.id === "acme-chat-1").length, 1);
  assert.equal(acme.refused.filter((r) => r.reason === "uw-namespace").length, 2,
    "the two distinct uw/ ids are two distinct candidates");
});

// The companion assertion — that uwpick.mjs never calls routableSet — lives in
// Task A10's test file, where uwpick.mjs exists. Putting it here would need a
// gate on a file a later task creates, which Constraint 15a forbids.

// ------------------------------------------------------------- #75: modes
//
// The revision-11 "provider capped at 3, surplus withheld with the cap reason"
// observable is not tested here on purpose, not by omission. R11 (already
// shipped, before this branch) retired the per-provider routing cap entirely --
// `buildFrom` has no candidate-limiting mechanism left to exercise, and a fixture
// manufacturing one would test code this file does not contain. What "R11
// retires the cap reason and the feature must outlive it" actually requires --
// that `refused[]` carries an ARBITRARY reason string, unchanged, and that two
// distinct reasons never collapse to one -- is exactly what "buildFrom: a
// refused id carries its OWN reason" above already asserts, using R17's real
// (non-cap) reason vocabulary. Restated here so a future reader does not go
// looking for a cap-reason test that would be testing a mechanism nobody kept.

test("isServiceEntry: the search shape (ctx: null, text output, all-false capabilities, unpriced) is a service", () => {
  // The exact shape #75 measured at 65 of 4,298 live entries: DuckDuckGo,
  // Firecrawl, Exa and friends. No `contextTokens` key at all -- absence, not a
  // measured zero -- which is what a non-LLM service actually reports.
  const search = { provider: "acme", model: "acme-search-svc",
    modalities: { output: ["text"] },
    capabilities: { webSearch: false, citations: false, streaming: false } };
  assert.equal(isServiceEntry(search), true);
  assert.equal(modeOf(search), true);
});

test("isServiceEntry: a chat-capable LiteLLM mode overrides the all-false-capability shape", () => {
  // openai/gpt-41-copilot's real shape: the bundle's 13-key modality schema
  // (audio/image/video/embedding/rerank) never asks about text-completion, so a
  // genuine chat model reports all thirteen false for the same reason a real
  // service does -- the schema is silent on the one axis this classifier needs.
  // LiteLLM's own `mode` field is the authoritative, orthogonal signal that
  // breaks the tie.
  const chatShapedLikeAService = { provider: "acme", model: "acme-completion-1",
    mode: "completion",
    modalities: { output: ["text"] },
    capabilities: { audioInput: false, imageInput: false, embedding: false } };
  assert.equal(isServiceEntry(chatShapedLikeAService), false,
    "mode: \"completion\" must never classify as a service, regardless of shape");

  const realService = { provider: "acme", model: "acme-search",
    mode: "search",
    modalities: { output: ["text"] },
    capabilities: { audioInput: false, imageInput: false, embedding: false } };
  assert.equal(isServiceEntry(realService), true,
    "a genuine non-chat mode is unaffected by this guard");

  // No `mode` field at all, with the REAL 13-key modality schema (not a
  // shortened stand-in) all false: the guard must not fire on absence, only on
  // a POSITIVE chat-capable declaration -- the shape heuristic is still the
  // fallback signal for this population, unchanged. This is the one path this
  // review found still resting on the bare heuristic alone -- `fireworks-ai/
  // fireworks-ai-default` and `unknown/fallback-generalizations` in the live
  // bundle carry exactly this shape and neither is a chosen provider, so it is
  // a real but currently inert gap, not a live false positive.
  const noModeField = { provider: "acme", model: "acme-svc-nomode",
    modalities: { output: ["text"] },
    capabilities: { audioInput: false, audioOutput: false, embedding: false,
      imageGeneration: false, imageInput: false, imageOutput: false, moderation: false,
      pdfInput: false, rerank: false, speech: false, transcription: false,
      videoInput: false, supports1MContext: false } };
  assert.equal(isServiceEntry(noModeField), true,
    "an absent mode field falls through to the shape heuristic unchanged");
});

test("isServiceEntry stays false on ambiguous rows -- absence of facts is not evidence of being a service", () => {
  // `blank-a`'s shape: nothing recorded at all. MEASURED: the loose form this
  // function was NOT built as would sweep this row in, along with 160 other real
  // ones. A model the bundle simply never described must stay unknown.
  assert.equal(isServiceEntry(byId["blank-a"]), false);
  // An ordinary priced chat model with real capabilities is never a service.
  assert.equal(isServiceEntry(byId["acme-chat-1"]), false);
});

test("buildFrom: a ctx-null, text-declaring, all-false-capability row renders as a mode -- pool properties blanked, never pruned", () => {
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "acme-search-svc",
    modalities: { output: ["text"] },
    capabilities: { webSearch: false, citations: false } });
  const acme = buildFrom(input({ catalog: c })).rows.find((r) => r.provider === "acme");
  const row = acme.models.find((m) => m.id === "acme-search-svc");
  assert.notEqual(row, undefined, "a mode row must still be selectable, never pruned");
  assert.equal(row.mode, true);
  assert.equal(row.ctx, null, "a service has no model window to report");
  assert.deepEqual([row.tools, row.vision, row.reason], [null, null, null],
    "pool capability flags are not model facts");
  assert.equal(row.outputKind, null, "null keeps the row selectable, never renders nontext");
});

test("buildFrom: a pool row classifies as a mode from its OWN capability signal, not from the string \"auto\"", () => {
  // kilo/auto's real shape: ctx 2,000,000, no service signal (it does not
  // declare all-false capabilities), classified only by the provider's own
  // listed capability. The fixture id deliberately contains neither "auto" nor
  // any other mode word, so a hand-maintained name list could not pass this.
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "acme-pool-x",
    modalities: { output: ["text"] }, limits: { contextTokens: 2000000 },
    capabilities: { toolCalling: true, imageInput: false, reasoning: true } });
  const discovery = discoveryOf({ acme: [{ id: "acme-pool-x", capabilityRaw: "auto" }] });
  const acme = buildFrom(input({ catalog: c, discovery })).rows.find((r) => r.provider === "acme");
  const row = acme.models.find((m) => m.id === "acme-pool-x");
  assert.equal(row.mode, true);
  assert.equal(row.ctx, null, "the 2,000,000 pool window must not read as a model window");
});

test("buildFrom: a mode's real price stays visible, including a genuinely free one", () => {
  // morph/auto's measured shape: a real, non-zero, non-free offer alongside a
  // mode classification. Price is the one pool property that survives, because
  // it is what the user is actually billed for selecting the row.
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "acme-pool-priced",
    modalities: { output: ["text"] }, limits: { contextTokens: 32000 },
    capabilities: { toolCalling: true, reasoning: false },
    pricing: { offers: [{ provider: "acme", per1MTokens: { input: 0.85, output: 1.55 } }] } });
  // A second mode row, genuinely free with a curated recurring grant -- the
  // discriminator that fails if visibility were accidentally tied to "paid".
  // G2's real-price evidence (a second, non-zero offer from the same provider)
  // is what distinguishes "genuinely priced at zero" from "never priced at all"
  // -- the same shape `acme-free-1` already uses in this fixture set.
  c.byProvider.get("acme").push({ provider: "acme", model: "acme-pool-free",
    modalities: { output: ["text"] }, limits: { contextTokens: 2000000 },
    capabilities: { toolCalling: true, reasoning: false },
    pricing: { offers: [
      { provider: "acme", per1MTokens: { input: 0, output: 0 } },
      { provider: "acme", per1MTokens: { input: 0.05, output: 0.1 } },
    ] } });
  const discovery = discoveryOf({ acme: [
    { id: "acme-pool-priced", capabilityRaw: "auto" },
    { id: "acme-pool-free", capabilityRaw: "auto" },
  ] });
  const acme = buildFrom(input({
    catalog: c, discovery,
    cadenceOf: (name) => ({ cadence: name === "acme" ? "recurring" : "" }),
  })).rows.find((r) => r.provider === "acme");

  const priced = acme.models.find((m) => m.id === "acme-pool-priced");
  assert.equal(priced.mode, true);
  assert.equal(priced.ctx, null);
  assert.deepEqual([priced.pin, priced.pout], [0.85, 1.55],
    "morph/auto's real price must survive the mode classification");
  assert.equal(priced.badge, "PAID");

  const free = acme.models.find((m) => m.id === "acme-pool-free");
  assert.equal(free.mode, true);
  assert.equal(free.ctx, null);
  assert.equal(free.badge, "FREE", "a genuinely free mode keeps its free badge");
});

test("buildFrom: a mode row can never promote through bucketFor's context proxy branch", () => {
  // kilo/auto's exact hazard: bucketFor's ctx-proxy branch would read a 2,000,000
  // window and return "capable" on no evidence about any model that answers.
  // `catalog.mjs`'s row uses different field names on purpose (`outputKind`/`ctx`
  // vs bucketFor's `kind`/`contextTokens` -- see the comment above `outputKind:`
  // in buildFrom), so this maps the row's own nulled fields onto the shape
  // bucketFor reads and proves the hazard cannot reach it even under that mapping.
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "acme-pool-huge",
    modalities: { output: ["text"] }, limits: { contextTokens: 2000000 },
    capabilities: { toolCalling: true, reasoning: true } });
  const discovery = discoveryOf({ acme: [{ id: "acme-pool-huge", capabilityRaw: "router" }] });
  const acme = buildFrom(input({ catalog: c, discovery })).rows.find((r) => r.provider === "acme");
  const row = acme.models.find((m) => m.id === "acme-pool-huge");

  assert.equal(row.mode, true);
  assert.equal(row.ctx, null);
  assert.equal(row.reason, null);
  // Un-nulled control: the same real context, fed through bucketFor directly,
  // DOES promote to capable -- proving this is a real hazard the row's own
  // nulled fields close, not an assertion that would pass regardless of mode.
  assert.equal(bucketFor({ kind: "text", contextTokens: 2000000, reason: null }), "capable");
  // The mode row's own (nulled) fields, mapped onto bucketFor's shape, can never
  // reach that branch. `equal("unknown")`, not `notEqual("capable")` -- the
  // looser assertion would also pass on "nonchat", which the implementation
  // forbids here: a "nontext" verdict makes a row unselectable and silently
  // deletes its pin from recents/favourites at initState, and a mode row must
  // stay selectable ([[responding-provider-never-pruned]]).
  assert.equal(
    bucketFor({ kind: row.outputKind, contextTokens: row.ctx, reason: row.reason }),
    "unknown");
});

test("corpus: no live entry with a chat-capable LiteLLM mode is ever classified as a service", () => {
  // The regression this review round found: `openai/gpt-41-copilot`
  // (mode: "completion"), `azure/container` and `openai/container`
  // (mode: "chat") were misclassified as services by the shape heuristic alone,
  // because the bundle's capability schema never measures text-completion at
  // all and a real chat model can report the same all-false shape a genuine
  // service does. This asserts the fix holds over the whole live bundle, not
  // just the three named cases.
  const { byProvider } = loadCatalog();
  const violations = [];
  for (const [provider, entries] of byProvider) {
    for (const e of entries) {
      if (["chat", "completion", "responses"].includes(e.mode) && isServiceEntry(e)) {
        violations.push(`${provider}/${e.model} (mode: ${e.mode})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("corpus: the four live #75 rows (openrouter/auto, kilo/auto, orcarouter/auto, openrouter/router) survive over the real catalogue", () => {
  // MEASURED 2026-09-08: these four reach the live picker today. Presence, not
  // classification, is the claim -- #75 explicitly accepts that kilo/auto and
  // openrouter/auto keep reading as models until discovery is wired for those
  // two providers (no hand-maintained id list may be added to force it early).
  // What this guards is [[responding-provider-never-pruned]]: a classification
  // change must never be the reason one of these four disappears. If a future
  // bundle drops one of these ids, this test fails loud rather than silently
  // passing on an empty set -- that is the intended non-vacuity behaviour, and
  // the fix in that case is to update the named targets, not to delete the test.
  const { byProvider } = loadCatalog();
  const targets = [["openrouter", "auto"], ["kilo", "auto"], ["orcarouter", "auto"],
    ["openrouter", "router"]];
  const providers = [...new Set(targets.map(([p]) => p))];
  const chosen = providers.map((p) => ({ id: `test.${p}`, provider: p }));
  const profiles = new Map(providers.map((p) => [p, {}]));
  const { rows } = buildFrom({ chosen, providers: profiles,
    catalog: { byProvider, generatedAt: "" } });

  for (const [provider, id] of targets) {
    const row = rows.find((r) => r.provider === provider);
    assert.notEqual(row, undefined, `${provider} has no row in the corpus`);
    const model = row.models.find((m) => m.id === id);
    assert.notEqual(model, undefined,
      `${provider}/${id} is missing -- a live picker row was pruned or renamed`);
  }
});

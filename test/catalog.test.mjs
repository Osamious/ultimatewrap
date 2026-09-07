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
import { outputKind, loadCatalog } from "../keysync/keysync.mjs";

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

// The companion assertion — that uwpick.mjs never calls routableSet — lives in
// Task A10's test file, where uwpick.mjs exists. Putting it here would need a
// gate on a file a later task creates, which Constraint 15a forbids.

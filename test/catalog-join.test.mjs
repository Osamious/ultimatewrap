import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJoinIndex, joinCatalogEntry, priceOf,
         hasPricedOffer } from "../keysync/catalog-join.mjs";
import { priceOf as priceOfViaMenu } from "../menu/catalog.mjs";
// The REAL bundle reader. Every other test in this file feeds `buildJoinIndex` a
// hand-built fixture, which is why nothing here could see whether production
// builds the index those fixtures assume -- see the byAlias test at the bottom.
import { loadCatalog } from "../keysync/keysync.mjs";

// A hand-written bundle in the real schema's shape. Every `id` is
// `${provider}/${model}` because that holds for 4,298 of 4,298 live entries, and
// every `aliases[]` string is vendor-qualified because 0 of 10,184 live aliases
// are bare. A fixture that broke either invariant would be testing a bundle that
// does not exist.
//
// One entry per rung, each chosen so that NO EARLIER RUNG CAN REACH IT -- that
// is what makes "one test per rung" (plan §6.2) mean anything. The comment on
// each row names the rung it is the only reachable target of.
const ENTRIES = [
  // rung 1, provider-scoped bare: deepseek lists it as `deepseek-chat`.
  { id: "deepseek/deepseek-chat", provider: "deepseek", model: "deepseek-chat",
    aliases: ["deepseek/deepseek-chat", "nano-gpt/deepseek-chat"] },
  // rung 1, the live id carrying its own vendor prefix.
  { id: "openai/gpt-4o", provider: "openai", model: "gpt-4o",
    aliases: ["openai/gpt-4o", "orcarouter/openai/gpt-4o"] },
  // rung 2, `.`->`-`: no bundle id spells the dot.
  { id: "openai/gpt-3-5-turbo", provider: "openai", model: "gpt-3-5-turbo", aliases: [] },
  // rung 2, `models/` prefix and `:free` suffix.
  { id: "google/gemini-3-flash", provider: "google", model: "gemini-3-flash", aliases: [] },
  // rung 3, case: the bundle is lower-case, the listing is not.
  { id: "alibaba/qwen3-max", provider: "alibaba", model: "qwen3-max", aliases: [] },
  // rung 4's tie-break partner: same tail, different provider.
  { id: "openrouter/qwen3-max", provider: "openrouter", model: "qwen3-max", aliases: [] },
  // rung 5, Fireworks' resource path.
  { id: "fireworks_ai/llama-v3", provider: "fireworks_ai", model: "llama-v3", aliases: [] },
  // rung 5, the leading `~` menu/sanitize.mjs admits.
  { id: "z-ai/glm-latest", provider: "z-ai", model: "glm-latest", aliases: [] },
  // rung 5, the `[…]` context-window suffix.
  { id: "moonshot/kimi-k3", provider: "moonshot", model: "kimi-k3", aliases: [] },
  // the guard's subject: a bare name owned by exactly one provider.
  { id: "morph/auto", provider: "morph", model: "auto", aliases: ["morph/auto"] },
];

function catalogOf(entries) {
  const byProvider = new Map();
  const byAlias = new Map();
  for (const e of entries) {
    if (!byProvider.has(e.provider)) byProvider.set(e.provider, []);
    byProvider.get(e.provider).push(e);
    for (const a of e.aliases ?? []) if (!byAlias.has(a)) byAlias.set(a, e);
  }
  return { generatedAt: "2026-08-24T12:22:28.162Z", byProvider, byAlias };
}

const index = buildJoinIndex(catalogOf(ENTRIES));
const join = (provider, id) => joinCatalogEntry(index, provider, id);
const idOf = (e) => e?.id ?? null;

// ------------------------------------------------------------ one test per rung

test("rung 1 exact: a bare listing id joins its own provider's row", () => {
  assert.equal(idOf(join("deepseek", "deepseek-chat")), "deepseek/deepseek-chat");
});

test("rung 1 exact: a listing id carrying its own vendor prefix joins across providers", () => {
  // openrouter does not own gpt-4o. The id names openai, so it may say so.
  assert.equal(idOf(join("openrouter", "openai/gpt-4o")), "openai/gpt-4o");
});

test("rung 1 exact: aliases[] is the only path to this row, and it is used", () => {
  // `nano-gpt/deepseek-chat` is an alias of the deepseek row and is NOT an id.
  // Bare `deepseek-chat` under nano-gpt cannot reach it by any other rung: the
  // scoped id does not exist, and the guard forbids the tail. Deleting the
  // aliases[] half of `exact` fails exactly this assertion.
  assert.equal(idOf(join("nano-gpt", "deepseek-chat")), "deepseek/deepseek-chat");
});

test("rung 2 normalisation: models/ prefix and :free suffix are stripped", () => {
  assert.equal(idOf(join("google", "models/gemini-3-flash")), "google/gemini-3-flash");
  assert.equal(idOf(join("google", "gemini-3-flash:free")), "google/gemini-3-flash");
  assert.equal(idOf(join("google", "models/gemini-3-flash:free")), "google/gemini-3-flash");
});

test("rung 2 normalisation: a dotted version joins the dashed bundle spelling", () => {
  assert.equal(idOf(join("openai", "gpt-3.5-turbo")), "openai/gpt-3-5-turbo");
});

test("rung 2 normalisation stops where D3 stops: no date or -instruct stripping", () => {
  // Rejected in D3 §1 by name. A wrong join is worse than no join, because it
  // yields a confident capability label instead of an honest unknown.
  assert.equal(join("openai", "gpt-4o-2024-08-06"), null);
  assert.equal(join("openai", "gpt-4o-instruct"), null);
});

test("rung 3 case-insensitive: a listing that capitalises still joins", () => {
  assert.equal(idOf(join("alibaba", "Qwen3-Max")), "alibaba/qwen3-max");
  assert.equal(idOf(join("ALIBABA", "qwen3-max")), "alibaba/qwen3-max");
});

test("rung 4 vendor-qualified tail: a foreign vendor prefix licenses a tail match", () => {
  // `qwen/qwen3-max` is neither an id nor an alias. Only the tail matches, and
  // the id's own vendor prefix is what permits it.
  assert.equal(idOf(join("kilo", "qwen/qwen3-max")), "alibaba/qwen3-max");
});

test("rung 4 tie-break is ordered, not incidental: own provider, then named vendor", () => {
  // Two rows share the tail `qwen3-max`.
  assert.equal(idOf(join("openrouter", "qwen/qwen3-max")), "openrouter/qwen3-max",
    "the caller's own provider outranks bundle order");
  assert.equal(idOf(join("kilo", "openrouter/qwen/qwen3-max")), "openrouter/qwen3-max",
    "the vendor the id names outranks bundle order");
});

test("rung 5 shapes: accounts/…/models/, leading ~, and a […] suffix", () => {
  assert.equal(idOf(join("fireworks_ai", "accounts/fireworks/models/llama-v3")),
    "fireworks_ai/llama-v3");
  assert.equal(idOf(join("z-ai", "~glm-latest")), "z-ai/glm-latest");
  assert.equal(idOf(join("kilo", "~z-ai/glm-latest")), "z-ai/glm-latest");
  assert.equal(idOf(join("moonshot", "kimi-k3[1M]")), "moonshot/kimi-k3");
});

test("rung 5 re-enters the ladder rather than retrying exact only", () => {
  // Stripped to `Kimi-K3`, this needs rung 3 AFTER rung 5. A rung 5 that only
  // repeated the exact lookup would miss it.
  assert.equal(idOf(join("moonshot", "Kimi-K3[1M]")), "moonshot/kimi-k3");
});

// ------------------------------------------------------------- the bare guard

test("the bare-name guard: orcarouter/auto does not join morph/auto", () => {
  // The measured false positive that loose matching produced (D3 §4.3).
  // orcarouter lists a bare `auto`; the bundle's only `auto` belongs to morph.
  // Removing the prefix check makes the tail rung return the morph row here.
  assert.equal(join("orcarouter", "auto"), null);
});

test("the bare-name guard denies cross-provider only, never the owner", () => {
  // The positive control. A guard that also blocked morph's own row would be
  // hiding a real join, which is the failure mode #22 is about.
  assert.equal(idOf(join("morph", "auto")), "morph/auto");
});

test("with its own row present, a bare id joins that row and not the foreign one", () => {
  // The plan's observable in its literal form, against a bundle that holds both.
  const both = buildJoinIndex(catalogOf([...ENTRIES,
    { id: "orcarouter/auto", provider: "orcarouter", model: "auto", aliases: ["orcarouter/auto"] }]));
  const hit = joinCatalogEntry(both, "orcarouter", "auto");
  assert.equal(idOf(hit), "orcarouter/auto");
  assert.notEqual(idOf(hit), "morph/auto");
});

test("the guard follows the key, not the caller's input", () => {
  // `accounts/fireworks/models/auto` is qualified going in and BARE after rung 5.
  // If the guard were evaluated once on the input, this would reach morph/auto.
  assert.equal(join("orcarouter", "accounts/fireworks/models/auto"), null);
  assert.equal(join("orcarouter", "models/auto"), null);
});

// ------------------------------------------------------------------- the miss

test("a miss is null, and null is a real answer", () => {
  // D3 §4.2: no join -> null -> bucketFor "unknown" -> the weak target. The row
  // still ships. Nothing here may invent an entry.
  assert.equal(join("deepseek", "deepseek-v9-unreleased"), null);
  assert.equal(join("nosuchprovider", "deepseek-chat"), null);
});

test("junk input yields null rather than throwing", () => {
  for (const [p, m] of [[null, "x"], ["x", null], ["", "x"], ["x", ""], ["x", "   "]]) {
    assert.equal(joinCatalogEntry(index, p, m), null, `${p} / ${m}`);
  }
  assert.equal(joinCatalogEntry(null, "deepseek", "deepseek-chat"), null);
});

// --------------------------------------------------------------- the index

test("loadCatalog really BUILDS the byAlias index, over the live bundle", () => {
  // THE GAP THIS CLOSES, MEASURED. Deleting the alias-indexing line in
  // `loadCatalog` -- the `for (const a of m.aliases ?? [])` loop that fills
  // `byAlias` -- left all 491 tests green while `byAlias` went from 10,184
  // entries to 0 and the guarded join dropped from 2,460 to 2,346 of 3,784
  // pairs, 65.0% to 62.0%, silently.
  //
  // The cause is structural and would recur: `catalogOf` above RE-IMPLEMENTS the
  // grouping in its own fixture builder, so the rung-1 alias test proves the
  // LADDER consumes aliases and nothing proves PRODUCTION builds the index. The
  // only fix is to call the real reader, which is what this does.
  const catalog = loadCatalog();
  assert.ok(catalog.byAlias instanceof Map, "loadCatalog must return a byAlias Map");
  assert.ok(catalog.byAlias.size > 0,
    "the bundle declares aliases[] and loadCatalog dropped every one of them");

  // Each key must really be a declared alias of the entry it maps to -- a Map
  // that is merely non-empty could be indexed on the wrong field.
  let checked = 0;
  for (const [alias, e] of catalog.byAlias) {
    assert.ok(e?.aliases?.includes(alias), `${alias} maps to an entry that does not declare it`);
    if (++checked >= 200) break;
  }

  // ...and it is LOAD-BEARING, not merely present: at least one live alias must
  // resolve to a row that an otherwise-identical index without the alias map
  // cannot reach. 59 such aliases exist in today's bundle; asserting the
  // property rather than the count keeps this from breaking on a bundle refresh.
  const withAlias = buildJoinIndex(catalog);
  const withoutAlias = buildJoinIndex({ byProvider: catalog.byProvider,
                                        generatedAt: catalog.generatedAt });
  let decided = null;
  for (const [alias, e] of catalog.byAlias) {
    if (withAlias.byId.has(alias)) continue;           // an id, so not alias-decided
    const hit = joinCatalogEntry(withAlias, e.provider, alias);
    const miss = joinCatalogEntry(withoutAlias, e.provider, alias);
    if (hit && (!miss || miss.id !== hit.id)) { decided = { alias, provider: e.provider }; break; }
  }
  assert.ok(decided, "no live alias changes the join's answer, so the index is doing nothing");
});

test("buildJoinIndex tolerates a catalog with no alias index", () => {
  // menu/catalog.mjs's tests construct `{byProvider, generatedAt}` by hand. The
  // join must degrade to id-and-tail matching rather than throwing on them.
  const { byProvider, generatedAt } = catalogOf(ENTRIES);
  const bare = buildJoinIndex({ byProvider, generatedAt });
  assert.equal(idOf(joinCatalogEntry(bare, "deepseek", "deepseek-chat")), "deepseek/deepseek-chat");
  assert.equal(joinCatalogEntry(bare, "nano-gpt", "deepseek-chat"), null,
    "the alias-only row is unreachable without the alias index");
});

test("the ladder returns at the first hit, so an exact match outranks a tail match", () => {
  // The two rungs must DISAGREE here or the assertion proves nothing. They do:
  // `alibaba/qwen3-max` is an exact id, and the tail `qwen3-max` tie-breaks to
  // the caller's own provider, which is a different row. Exact wins because it
  // runs first; running the tail rung first answers `openrouter/qwen3-max`.
  //
  // The first draft of this test used a BARE key, where the guard stops the tail
  // rung before it can answer at all -- so reordering the ladder left it green.
  // Found by running the reorder mutation; kept as written to record why the
  // input has to be qualified.
  assert.equal(idOf(join("openrouter", "alibaba/qwen3-max")), "alibaba/qwen3-max");
  assert.equal(idOf(join("openrouter", "qwen3-max")), "openrouter/qwen3-max");
});

// ------------------------------------------------- priceOf, after the R5 move
//
// `priceOf` moved here from `menu/catalog.mjs` unchanged. Its own cases stay
// asserted in `test/catalog.test.mjs`, driven through the re-export -- that
// suite passing untouched is the proof the move is transparent to callers, and
// repointing its import would have destroyed exactly that evidence. What is
// added here is the one row those tests do not cover.

test("the re-export is the same function, not a copy", () => {
  assert.equal(priceOf, priceOfViaMenu);
});

test("a same-provider offer pair resolves by array order, and must keep doing so", () => {
  // MEASURED against the live bundle: `mistral/labs-devstral-small-2512` carries
  // offers [mistral 0/0, mistral 0.1/0.3], and `.find()` returns the FIRST, so
  // the matched offer is 0/0 on an entry that is genuinely priced.
  //
  // Two reasons this row is pinned. It is the single discriminator in the whole
  // FREE? corpus that R5b's `hasPricedOffer` depends on -- a predicate reading
  // the matched offer instead of the whole array would blank the one badge that
  // must survive. And the order-dependence itself is #69 (230 entries have 2+
  // usable offers for one provider, 50 disagree on price), which R5 relocates
  // rather than repairs. This test asserts today's behaviour so that whoever
  // fixes #69 sees this row change and has to mean it.
  const row = { pricing: { offers: [
    { provider: "mistral", per1MTokens: { input: 0, output: 0 } },
    { provider: "mistral", per1MTokens: { input: 0.1, output: 0.3 } },
  ] } };
  assert.deepEqual(priceOf(row, "mistral"), { in: 0, out: 0 });
  // No provider named: two usable offers cannot be told apart, so null.
  assert.equal(priceOf(row), null);
});

// ------------------------------------------------ hasPricedOffer (R5b, #55/#67)
//
// The predicate both #55 callers share. Every fixture below is a real live shape
// rather than an invented one, and each names the row it was copied from --
// MEASURED against the bundle (`generatedAt` 2026-08-24T12:22:28.162Z) on
// 2026-09-07, the same read the module comment cites.

test("hasPricedOffer: every offer zero is the #55 price-absence shape, so false", () => {
  // The 123-row majority. `openai/omni-moderation-latest` is priced per request,
  // not per token, and the bundle records that as a token price of zero -- the
  // exact shape a genuine free tier has.
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "openai", per1MTokens: { input: 0, output: 0 },
      sourceUnit: "usd_per_1m_tokens" },
  ] } }), false);
});

test("hasPricedOffer reads the WHOLE array, not the offer priceOf matched", () => {
  // THE DISCRIMINATOR, and the task fails without it. `mistral/labs-devstral-
  // small-2512` carries [mistral 0/0, mistral 0.1/0.3]; `priceOf` returns the
  // FIRST by `.find()`, so the matched offer is 0/0 while the entry is genuinely
  // priced. A predicate reading only the matched offer answers `false` here and
  // blanks the one row in the live corpus that must keep its badge.
  const genuine = { pricing: { offers: [
    { provider: "mistral", per1MTokens: { input: 0, output: 0 },
      sourceUnit: "usd_per_1m_tokens" },
    { provider: "mistral", per1MTokens: { input: 0.1, output: 0.3 },
      sourceUnit: "usd_per_token_for_token_fields" },
  ] } };
  assert.equal(hasPricedOffer(genuine), true);
  assert.deepEqual(priceOf(genuine, "mistral"), { in: 0, out: 0 },
    "the matched offer really is the zero one -- that is what makes this a discriminator");
});

test("hasPricedOffer is array-wide, not provider-scoped: a foreign price still counts", () => {
  // A non-zero offer ANYWHERE proves the bundle holds pricing for this model, so
  // my provider's zero is a fact about the model rather than a hole in the data.
  // Whether that zero is MINE to pay is priceOf's question, and it stays there.
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "mine", per1MTokens: { input: 0, output: 0 } },
    { provider: "someone-else", per1MTokens: { input: 5, output: 5 } },
  ] } }), true);
});

test("hasPricedOffer: a free routing mode is INDISTINGUISHABLE here, and that is the known limit", () => {
  // The exception the predicate cannot see, pinned in the source so it is visible
  // rather than folded away. Providers may offer an `auto` routing mode free of
  // charge; then `0/0` is a true statement about the product, not missing data.
  // But a free mode has no non-zero offer to contrast against, so #55's
  // discriminator reads it exactly like an unpriced row.
  //
  // MEASURED 2026-09-07: `kilo/auto`, `llmgateway/auto` and `orcarouter/auto`
  // each carry one 0/0 offer; `morph/auto` carries 0.85/1.55. The record does not
  // say which of the first three are free of charge and which are simply
  // unpriced -- this asserts what the predicate ANSWERS, and deliberately does
  // not assert that the answer is the truth about the product. Deciding that
  // needs row-type information the entry does not carry (#75).
  const kiloAuto = { id: "kilo/auto", pricing: { offers: [
    { provider: "kilo", per1MTokens: { input: 0, output: 0 },
      sourceUnit: "usd_per_1m_tokens" } ] } };
  const morphAuto = { id: "morph/auto", pricing: { offers: [
    { provider: "morph", per1MTokens: { input: 0.85, output: 1.55 },
      sourceUnit: "usd_per_1m_tokens" } ] } };
  assert.equal(hasPricedOffer(kiloAuto), false,
    "a genuinely free mode and an unpriced row are the same shape to this predicate");
  assert.equal(hasPricedOffer(morphAuto), true,
    "the same `auto` shape carrying a real price answers true, so the false above is about the DATA");
});

test("hasPricedOffer: no offers at all is false, and never throws", () => {
  // `model-oracle-ai/auto`, `pioneer/auto` and `trustedrouter/auto` carry an
  // empty offers array (measured). Absent, empty and malformed all mean the same
  // thing -- no evidence of a price -- and none of them may throw on the picker's
  // build path.
  assert.equal(hasPricedOffer({ pricing: { offers: [] } }), false);
  assert.equal(hasPricedOffer({ pricing: {} }), false);
  assert.equal(hasPricedOffer({}), false);
  assert.equal(hasPricedOffer(undefined), false);
  assert.equal(hasPricedOffer(null), false);
  assert.equal(hasPricedOffer({ pricing: { offers: "nope" } }), false);
});

// THE AGREEMENT GUARD (rewritten 2026-09-07). The module comment says the two
// copies of the `usable` rule "must be changed together" and nothing enforced
// it: the test below this one is titled as an agreement test but never calls
// `priceOf` -- every expectation in it is hardcoded against `hasPricedOffer`
// alone. The rules DO agree today, coercion edges included, so this is a missing
// guard rather than a live defect; it exists so a change to one copy fails.
//
// `priceOf`'s `usable` is not exported, and it does not need to be: it is
// observable. An offer is usable exactly when `priceOf`, given an entry holding
// only that offer, returns a price rather than null. Each offer is evaluated in
// ISOLATION on purpose -- `usable` is a per-offer predicate, and putting two
// usable offers in one entry would make `priceOf` answer null for a reason
// (`.find()` ambiguity, #69) that has nothing to do with the rule under test.
const OFFER_SHAPES = [
  { why: "a real price", offer: { provider: "p", per1MTokens: { input: 0.1, output: 0.3 } } },
  { why: "a genuine zero", offer: { provider: "p", per1MTokens: { input: 0, output: 0 } } },
  { why: "numeric strings, non-zero", offer: { provider: "p", per1MTokens: { input: "0", output: "0.3" } } },
  { why: "numeric strings, both zero", offer: { provider: "p", per1MTokens: { input: "0", output: "0" } } },
  { why: "unparseable", offer: { provider: "p", per1MTokens: { input: "n/a", output: "n/a" } } },
  { why: "output missing", offer: { provider: "p", per1MTokens: { input: 3 } } },
  { why: "input missing", offer: { provider: "p", per1MTokens: { output: 3 } } },
  { why: "no per1MTokens at all", offer: { provider: "p" } },
  { why: "a null offer", offer: null },
  { why: "a foreign host's price", offer: { provider: "other", per1MTokens: { input: 5, output: 5 } } },
  { why: "no provider named", offer: { per1MTokens: { input: 1, output: 2 } } },
];

// priceOf's own verdict on one offer: usable AND carrying a non-zero value.
const pricedByPriceOf = (offer) => {
  const p = priceOf({ pricing: { offers: [offer] } }, offer?.provider ?? null);
  return !!p && (p.in !== 0 || p.out !== 0);
};

test("hasPricedOffer agrees with priceOf's `usable` rule, shape by shape and pairwise", () => {
  // Singly: the two copies must classify every offer shape identically.
  for (const { why, offer } of OFFER_SHAPES) {
    assert.equal(hasPricedOffer({ pricing: { offers: [offer] } }), pricedByPriceOf(offer), why);
  }
  // Pairwise: `hasPricedOffer` is array-wide, so it must be true exactly when AT
  // LEAST ONE offer satisfies priceOf's rule with a non-zero value. This is the
  // half that catches an `every`-for-`some` slip as well as a rule divergence.
  for (const a of OFFER_SHAPES) {
    for (const b of OFFER_SHAPES) {
      assert.equal(
        hasPricedOffer({ pricing: { offers: [a.offer, b.offer] } }),
        pricedByPriceOf(a.offer) || pricedByPriceOf(b.offer),
        `${a.why} + ${b.why}`);
    }
  }
  // The table must actually contain both verdicts, or the loops above are
  // asserting a constant.
  const verdicts = new Set(OFFER_SHAPES.map((s) => pricedByPriceOf(s.offer)));
  assert.deepEqual([...verdicts].sort(), [false, true]);
});

test("hasPricedOffer's absolute verdicts, pinned: an unparseable offer is not a price", () => {
  // The agreement test above cannot catch an IDENTICAL change to both copies,
  // so these stay as hardcoded expectations. A non-numeric or half-present
  // `per1MTokens` is not evidence of pricing, so a row carrying only such
  // offers stays false -- otherwise junk in the bundle would resurrect the
  // FREE? badge this guard exists to withhold.
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "x", per1MTokens: { input: "n/a", output: "n/a" } } ] } }), false);
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "x", per1MTokens: { input: 3 } } ] } }), false, "output missing");
  assert.equal(hasPricedOffer({ pricing: { offers: [{ provider: "x" }] } }), false);
  // Numeric strings ARE usable -- priceOf coerces with Number() and so does this.
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "x", per1MTokens: { input: "0", output: "0" } } ] } }), false);
  assert.equal(hasPricedOffer({ pricing: { offers: [
    { provider: "x", per1MTokens: { input: "0", output: "0.3" } } ] } }), true,
    "a non-zero OUTPUT alone is still a price");
});

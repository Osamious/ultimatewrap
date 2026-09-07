// R3 / #10 / #55 — `inferTier` reads the live pricing path, provider-matched.
//
// WHAT THIS FILE IS FOR. Before R3, `inferTier` read
// `pricing.{inputPerMillion,outputPerMillion,input,output}`. This schema stores
// prices at `pricing.offers[].per1MTokens`, so none of those four fields exists:
// the function answered "unknown" for 4,298 of 4,298 catalogue entries, the
// free-first term in `buildProviders`'s sort evaluated `1 - 1 = 0` on every
// pair, and selection collapsed to shortest-id-first.
//
// THE ASSERTIONS THAT MUST BE ABLE TO FAIL (plan §6.2): **the rows
// `buildProviders` EMITS** move off `unknown` -- not the bundle-wide histogram,
// which is satisfied by relabelling alone while the top-3 silently moves under
// it -- and **a non-matching offer yields `unknown`, not `offers[0]`**.
//
// EVERY PRICING FIXTURE BELOW IS A REAL BUNDLE SHAPE, transcribed from
// `models.json` on 2026-09-07 and named where it came from. Invented shapes are
// what let this defect live: the old function was tested against object literals
// carrying the fields it read, so it was green for as long as nobody compared
// its input to the file.
//
// BUNDLE-INDEPENDENT ON PURPOSE. Nothing here asserts a literal corpus count.
// The corpus figures live in the R3 report; a test pinning them fails on the
// next CCR bundle instead of on a regression.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inferTier, normalizeModel, outputKind, buildProviders } from "../keysync/keysync.mjs";

// ---------------------------------------------------------------- fixtures
//
// `offer` mirrors the bundle's element shape; `sourceUnit` is carried because it
// is the field that makes #55 hard: a `{0, 0}` under a TOKEN unit is
// shape-identical to a genuine free tier, and nothing else in the record
// separates them.
const offer = (provider, input, output, sourceUnit = "usd_per_1m_tokens") =>
  ({ provider, per1MTokens: { input, output }, sourceUnit });
const entry = (provider, model, o = {}) =>
  ({ provider, model, id: `${provider}/${model}`, ...o });
const text = { modalities: { output: ["text"] } };

// google/lyria-3-pro-preview, verbatim: five offers across four hosts, every one
// of them `0/0`. This is #55's subject -- "not priced per token", wearing the
// exact shape of a free tier.
const LYRIA_PRO = entry("google", "lyria-3-pro-preview", {
  modalities: { output: ["audio", "text"] },
  pricing: { offers: [
    offer("google", 0, 0), offer("kilo", 0, 0), offer("openrouter", 0, 0),
    offer("gemini", 0, 0, "usd_per_token_for_token_fields"),
    offer("openrouter", 0, 0, "usd_per_token_for_token_fields"),
  ] },
});

// openai/gpt-5-5, verbatim. The discriminator: `kenari` really does serve it for
// nothing while `frogbot` and `neon` bill for it, and NEITHER offer belongs to
// `openai`. One entry, three different true answers.
const GPT_5_5 = entry("openai", "gpt-5-5", {
  modalities: { output: ["image", "text"] },
  pricing: { offers: [
    { provider: "frogbot", per1MTokens: { cacheRead: 0.25, input: 2.5, output: 15 } },
    offer("kenari", 0, 0),
    { provider: "neon", per1MTokens: { cacheRead: 0.5, input: 5, output: 30 } },
  ] },
});

// mistral/labs-devstral-small-2512, verbatim: TWO mistral offers, the first
// `0/0` and the second real.
const DEVSTRAL = entry("mistral", "labs-devstral-small-2512", {
  ...text,
  pricing: { offers: [
    offer("mistral", 0, 0),
    offer("mistral", 0.1, 0.3, "usd_per_token_for_token_fields"),
  ] },
});

// ------------------------------------------------- 1. the path itself (#10)

test("inferTier reads pricing.offers[].per1MTokens, and the legacy path is gone", () => {
  // The POSITIVE CONTROL first, so a stub returning "unknown" cannot pass this
  // file: a real offer at the caller's provider is `paid`.
  assert.equal(inferTier(entry("acme", "m", {
    pricing: { offers: [offer("acme", 1, 2)] } }), "acme"), "paid");

  // And the four fields the function USED to read are now inert. An entry
  // carrying only those -- which is what every pre-R3 unit fixture looked like
  // -- yields no tier, because this schema never emits them.
  for (const legacy of [{ inputPerMillion: 1, outputPerMillion: 2 },
                        { input: 1, output: 2 },
                        { inputPerMillion: 0, outputPerMillion: 0 }]) {
    assert.equal(inferTier(entry("acme", "m", { pricing: legacy }), "acme"), "unknown",
      `pricing ${JSON.stringify(legacy)} is not a path this schema has`);
  }

  // No pricing at all, and a pricing object with no offers array, are both the
  // honest unknown rather than a crash or a guess.
  assert.equal(inferTier(entry("acme", "m"), "acme"), "unknown");
  assert.equal(inferTier(entry("acme", "m", { pricing: {} }), "acme"), "unknown");
});

// ---------------------------------------- 2. provider matching (§6.2's second)

test("a non-matching offer yields unknown, NOT offers[0]", () => {
  // `offers[]` is a merged array holding up to 16 elements, most of them pricing
  // the model at a DIFFERENT host. Falling back to `offers[0]` answers "is the
  // first element of an arbitrarily ordered array free"; folding them answers
  // "is this free anywhere". A routing decision needs "is it free on MY key".
  const e = entry("acme", "m", {
    pricing: { offers: [offer("cheapo", 0, 0), offer("spendy", 9, 9)] } });
  assert.equal(inferTier(e, "acme"), "unknown",
    "acme sells no offer here; offers[0] being free says nothing about acme's bill");
  // ...and an `offers[0]` fallback really would have answered differently, or
  // the assertion above is vacuous. Both other names resolve, to two different
  // values, from the same entry.
  assert.equal(inferTier(e, "cheapo"), "free",
    "cheapo's 0/0 has spendy to contrast against, so its zero is a real free tier");
  assert.equal(inferTier(e, "spendy"), "paid");
});

test("one entry, three true answers, decided by whose key pays", () => {
  // openai/gpt-5-5. This is the whole rule in one fixture, and it is why
  // `inferTier` needs a provider argument at all.
  assert.equal(inferTier(GPT_5_5, "kenari"), "free",
    "kenari really serves it for nothing, and the other offers prove the bundle priced it");
  assert.equal(inferTier(GPT_5_5, "frogbot"), "paid");
  assert.equal(inferTier(GPT_5_5, "neon"), "paid");
  assert.equal(inferTier(GPT_5_5, "openai"), "unknown",
    "no offer belongs to openai, so openai's price is not recorded -- not free");
});

test("with no provider in hand, only an unambiguous single offer answers", () => {
  // `priceOf`'s own rule, reached rather than restated: "the first" and "mine"
  // cannot disagree when there is exactly one usable offer.
  assert.equal(inferTier(entry("acme", "m", {
    pricing: { offers: [offer("whoever", 3, 4)] } })), "paid");
  assert.equal(inferTier(GPT_5_5), "unknown",
    "three usable offers and no name to match: refuse rather than pick one");
});

// ------------------------------------------------------- 3. #55, all-zero

test("#55: an entry whose offers are ALL zero is unknown, not free", () => {
  // The bundle encodes "not priced per token" as `{0, 0}` under a token
  // `sourceUnit`. Reading that as a free tier is what sorts a model with no
  // price recorded to rank 0 on the routing path.
  assert.equal(inferTier(LYRIA_PRO, "google"), "unknown");
  assert.equal(inferTier(LYRIA_PRO, "kilo"), "unknown");
  assert.equal(inferTier(LYRIA_PRO, "openrouter"), "unknown");
});

test("#55: contrast is what makes a zero a fact rather than a hole", () => {
  // The same `0/0` offer, twice, differing only in whether ANOTHER offer on the
  // entry names a real price. That difference is the entire discriminator the
  // record carries, so it is asserted as a pair rather than as two tests.
  const alone = entry("acme", "m", { pricing: { offers: [offer("acme", 0, 0)] } });
  const contrasted = entry("acme", "m", {
    pricing: { offers: [offer("acme", 0, 0), offer("elsewhere", 2.5, 15)] } });
  assert.equal(inferTier(alone, "acme"), "unknown",
    "nothing proves the bundle holds pricing for this model at all");
  assert.equal(inferTier(contrasted, "acme"), "free",
    "another offer names a price, so acme's zero is a fact about the model");
});

test("#55 reads the WHOLE offers array, not the matched offer", () => {
  // mistral/labs-devstral-small-2512: the MATCHED offer is `0/0` while a second
  // mistral offer prices it at 0.1/0.3. A predicate reading only the matched
  // offer would call this unknown and blank a genuinely-priced row.
  assert.equal(inferTier(DEVSTRAL, "mistral"), "free");

  // THE KNOWN DEFECT THIS SITS ON, RECORDED SO A LATER FIX HAS A MARKER (#69).
  // `priceOf` resolves multi-offer entries with `.find()`, so ARRAY ORDER picks
  // which mistral offer wins -- and the two disagree. Reversing the array flips
  // this row to `paid`. That is #69's territory, not R3's; the assertion exists
  // to make the dependency visible rather than to bless it.
  const reversed = { ...DEVSTRAL,
    pricing: { offers: [...DEVSTRAL.pricing.offers].reverse() } };
  assert.equal(inferTier(reversed, "mistral"), "paid",
    "#69: offer order decides the price when one provider contributes several");
});

// ------------------------------- 4. the rows buildProviders EMITS (§6.2, M8)
//
// The requirement the plan states in these words: a bundle-wide histogram can
// improve exactly as promised while `tier` stays "unknown" for most rows the
// builder emits, because the bundle-wide read is unmatched and the call site is
// matched. So the subject is the emitted row.

// `tier` is not a picker-row field: keysync folds it into `description` behind
// `m.tier !== "unknown"` (a guess is worse than no label), so the row CARRIES a
// tier exactly when its description leads with one. Read off the row the user
// sees, not off an intermediate the pipeline could stop using.
const tierOf = (row) => (/^(free|paid)\b/.exec(row.description ?? "") ?? [, ""])[1];

const build = (provider, entries, testModel) => buildProviders(
  [{ id: `personal.${provider}.free`, provider }],
  new Map([[provider, { protocol: "openai", baseUrl: `https://${provider}.invalid/v1`,
                        ...(testModel ? { testModel } : {}) }]]),
  { generatedAt: "fixture", byProvider: new Map([[provider, entries]]) },
  () => "sk-test-not-a-real-key");

test("the rows buildProviders EMITS carry a tier, and it is the caller's tier", () => {
  const built = build("acme", [
    entry("acme", "billed", { ...text, pricing: { offers: [offer("acme", 1, 2)] } }),
    entry("acme", "gratis", { ...text,
      pricing: { offers: [offer("acme", 0, 0), offer("elsewhere", 4, 8)] } }),
    entry("acme", "silent", { ...text, pricing: { offers: [offer("elsewhere", 4, 8)] } }),
  ]);
  const got = Object.fromEntries(built.picker.map((r) =>
    [r.model.replace("acme/", ""), tierOf(r)]));
  assert.deepEqual(got, { gratis: "free", billed: "paid", silent: "" },
    "free and paid reach the row; the entry priced only at another host stays blank");

  // THE REGRESSION THIS EXISTS TO CATCH. Every entry above is priced under
  // `acme`'s own name, so a build that dropped the provider argument would read
  // `silent` as unambiguous-single-offer `paid` and `gratis` as... whatever
  // `offers[0]` said. Asserting the emitted row is what makes that visible.
  assert.equal(built.picker.every((r) => r.description.includes("acme.invalid")), true,
    "and the description really is the row the user sees");
});

test("the provider name reaches inferTier through normalizeModel, not around it", () => {
  // M8's signature change, asserted directly: same entry, two names, two tiers.
  // A `normalizeModel` that ignored its third argument would return one value
  // for both and this fails.
  assert.equal(normalizeModel("gpt-5-5", GPT_5_5, "kenari").tier, "free");
  assert.equal(normalizeModel("gpt-5-5", GPT_5_5, "frogbot").tier, "paid");
  assert.equal(normalizeModel("gpt-5-5", GPT_5_5, "openai").tier, "unknown");
  // The 38 no-entry rows keep their honest unknown: no signal is not a free tier.
  assert.equal(normalizeModel("vault-probe-1", undefined, "acme").tier, "unknown");
});

// ------------------------------------- 5. the sort, and the two named fixtures

test("outputKind ranks ahead of free-first: a free non-chat cannot outrank paid chat", () => {
  // The failure mode repairing free-first introduces: rerankers, embedders and
  // media generators are disproportionately free, so free-first ALONE promotes
  // them over paid chat models. `kind` is the first term precisely to stop that.
  const built = build("acme", [
    entry("acme", "rerank-1", { modalities: { output: ["score", "text"] },
      pricing: { offers: [offer("acme", 0, 0), offer("elsewhere", 1, 1)] } }),
    entry("acme", "embed-1", { modalities: { output: ["embedding", "text"] },
      pricing: { offers: [offer("acme", 0, 0), offer("elsewhere", 1, 1)] } }),
    entry("acme", "a-very-long-chat-model-name", { ...text,
      pricing: { offers: [offer("acme", 3, 6)] } }),
  ]);
  assert.equal(built.picker[0].model, "acme/a-very-long-chat-model-name",
    "paid chat outranks two FREE non-chat rows, despite losing on both other terms");
  assert.deepEqual(built.picker.map((r) => tierOf(r)), ["paid", "free", "free"]);
});

test("a row with no modality signal ranks WITH the text rows, not with the generators", () => {
  // `=== "nontext"`, not `!== "text"`. `outputKind` answers `null` for absence,
  // and demoting on absent evidence is the confident-wrong this codebase refuses
  // everywhere else.
  assert.equal(outputKind({ modalities: { output: [] } }), null, "the premise");
  assert.equal(outputKind({}), null);

  // The fixture has to make the two rules DISAGREE ON MEMBERSHIP, or it passes
  // under either. Three declared-text rows plus two no-signal rows, with the
  // no-signal ids short: under `=== "nontext"` the no-signal rows rank on length
  // and take two of the three slots; under `!== "text"` they are demoted below
  // every text row and the top-3 becomes all-text.
  const built = build("acme", [
    entry("acme", "chat-model-one", text),
    entry("acme", "chat-model-two", text),
    entry("acme", "chat-model-three", text),
    entry("acme", "q1"),
    entry("acme", "q2", { modalities: { output: [] } }),
  ]);
  assert.deepEqual(built.picker.map((r) => r.model),
    ["acme/q1", "acme/q2", "acme/chat-model-one"],
    "absence of a modality claim is not a claim of non-text");

  // And a row that DOES declare non-text still sorts last, or the term is inert.
  const withGen = build("acme", [
    entry("acme", "s", { modalities: { output: ["score"] } }),
    entry("acme", "q1"),
    entry("acme", "chat-model-one", text),
  ]);
  assert.equal(withGen.picker.at(-1).model, "acme/s");
});

test("a price is zero only when BOTH sides are zero", () => {
  // `price.in !== 0 || price.out !== 0`, not `&&`. MEASURED over the live bundle
  // 2026-09-07: 181 offers have exactly one side zero -- the shape is
  // `alibaba/qwen3-embedding-0.6b [digitalocean] in=0.04 out=0`, a model that
  // charges for input and nothing for output. Under `&&` every one of those
  // falls through to the contrast test and reads FREE, which is a bill the user
  // was told they would not get.
  const halfPriced = entry("alibaba", "qwen3-embedding-0.6b", {
    modalities: { output: ["embedding"] },
    pricing: { offers: [offer("digitalocean", 0.04, 0)] } });
  assert.equal(inferTier(halfPriced, "digitalocean"), "paid");

  // Both orientations, since `||` is symmetric and a one-sided fixture would let
  // a `price.in !== 0` -only mutation live.
  assert.equal(inferTier(entry("acme", "m", {
    pricing: { offers: [offer("acme", 0, 15)] } }), "acme"), "paid");
  assert.equal(inferTier(entry("acme", "m", {
    pricing: { offers: [offer("acme", 15, 0)] } }), "acme"), "paid");
  // The control: only an all-zero offer reaches the #55 contrast test at all.
  assert.equal(inferTier(entry("acme", "m", {
    pricing: { offers: [offer("acme", 0, 0), offer("x", 1, 1)] } }), "acme"), "free");
});

test("cohere: the repair must not trade three chat models for rerankers", () => {
  // THE FIRST NAMED FIXTURE. Real shapes: `rerank-v3.5` declares
  // `["score","text"]` and carries a single `0/0` offer; `command` declares
  // `["text"]` and is priced 1/2. Under the free-first term ALONE the rerankers
  // win -- which is the measured regression this fixture exists to hold.
  //
  // TWO INDEPENDENT DEFENCES STOP IT, and the assertions below separate them,
  // because a fixture that only checked the outcome would stay green if either
  // one were removed.
  const rerank = (model) => entry("cohere", model, {
    modalities: { output: ["score", "text"] },
    pricing: { offers: [offer("cohere", 0, 0, "usd_per_token_for_token_fields")] } });
  const chat = (model, input, output) => entry("cohere", model, { ...text,
    pricing: { offers: [offer("cohere", input, output, "usd_per_token_for_token_fields")] } });
  const built = build("cohere", [
    rerank("rerank-v3.5"), rerank("rerank-english-v2.0"),
    chat("command", 1, 2), chat("command-a", 2.5, 10), chat("command-r", 0.5, 1.5),
  ]);
  assert.deepEqual(built.picker.map((r) => r.model),
    ["cohere/command", "cohere/command-a", "cohere/command-r"]);

  // Defence 1 -- #55: a lone `0/0` offer is unknown, so free-first never fires.
  assert.equal(inferTier(rerank("rerank-v3.5"), "cohere"), "unknown");
  // Defence 2 -- the kind term: `["score","text"]` is nontext, so it sorts last
  // even if a reranker were genuinely free.
  assert.equal(outputKind(rerank("rerank-v3.5")), "nontext");
});

test("google: the kind guard does NOT catch the Lyria previews -- #55 is what does", () => {
  // THE SECOND NAMED FIXTURE, AND IT CARRIES THE OPPOSITE EXPECTATION. A gate
  // built only from cohere passes green while shipping two music generators,
  // because the two defences do not overlap here.
  //
  // The Lyria previews declare `"text"` ALONGSIDE `"audio"`, so `outputKind`
  // reads them as text and the kind term is blind to them. State that as an
  // assertion rather than a comment, so a future edit that "fixes" outputKind
  // has to come here and say so.
  assert.equal(outputKind(LYRIA_PRO), "text",
    "audio+text reads as text -- the kind guard is INSUFFICIENT on this shape");

  // What holds the line is #55 alone: every offer is 0/0, so the previews never
  // reach the free bucket that would promote them.
  assert.equal(inferTier(LYRIA_PRO, "google"), "unknown");

  const clip = { ...LYRIA_PRO, model: "lyria-3-clip-preview",
    id: "google/lyria-3-clip-preview" };
  const gemma = entry("google", "gemma-3", { ...text,
    pricing: { offers: [offer("inference", 0.15, 0.3)] } });
  const veo = entry("google", "veo-2", { modalities: { output: ["video"] },
    limits: { contextTokens: 480 } });
  const built = build("google", [LYRIA_PRO, clip, gemma, veo,
    entry("google", "gemma-2-9b", text), entry("google", "gemma-4-31b", text)]);

  assert.deepEqual(built.picker.map((r) => r.model),
    ["google/gemma-3", "google/gemma-2-9b", "google/gemma-4-31b"],
    "three real chat models; veo is demoted by kind, the previews by absent price");

  // PROVISIONAL, AND THIS IS THE ASSERTION THAT SAYS SO. Give either preview a
  // genuine free tier -- one contrasting non-zero offer, which is a shape the
  // bundle already produces elsewhere -- and it walks straight back into the
  // top-3, because nothing in R3 can tell a music generator from a chat model.
  // R11 retires this with the live `capability` field. Until then the guard is
  // known-insufficient BY TEST, not merely by comment.
  const pricedPreview = { ...LYRIA_PRO, pricing: { offers: [
    ...LYRIA_PRO.pricing.offers, offer("elsewhere", 5, 10)] } };
  const regressed = build("google", [pricedPreview, gemma,
    entry("google", "gemma-2-9b", text), entry("google", "gemma-4-31b", text)]);
  assert.equal(regressed.picker[0].model, "google/lyria-3-pro-preview",
    "a music generator with a real free tier still outranks paid chat: R11's job");
});

// ------------------------------------------- 6. the primary boolean gate (A3)
//
// > No provider's top-3 ACQUIRES a row whose `modalities.output` contains any
// > modality other than "text".
//
// ACQUIRES, not contains: providers whose entire catalogue is generators have a
// top-3 that cannot avoid them, and that is not R3's doing. Monotone criteria
// were rejected upstream -- this one can fail, and the second half of the test
// proves it can by constructing the acquisition it forbids.

// The selection R3 replaced, as the baseline the gate diffs against: free-first
// was a no-op on every entry, so `.sort()` fell through to shortest-id-first.
// Written out because the codebase no longer contains it.
const shortestIdFirst = (entries) =>
  [...entries].sort((a, b) => a.model.length - b.model.length)
    .slice(0, 3).map((e) => e.model);

const nonTextModalities = (e) =>
  (Array.isArray(e?.modalities?.output) ? e.modalities.output : []).filter((m) => m !== "text");

const gateViolations = (corpus) => {
  const out = [];
  for (const [provider, entries] of corpus) {
    if (entries.length <= 3) continue;
    const before = shortestIdFirst(entries);
    const after = build(provider, entries).picker.map((r) => r.model.slice(provider.length + 1));
    const byId = new Map(entries.map((e) => [e.model, e]));
    for (const id of after) {
      if (before.includes(id)) continue;              // not acquired
      const mods = nonTextModalities(byId.get(id));
      if (mods.length) out.push(`${provider}/${id} ${JSON.stringify(mods)}`);
    }
  }
  return out;
};

test("PRIMARY GATE: no top-3 acquires a row declaring a non-text output modality", () => {
  // A corpus wide enough that the gate has somewhere to fail: a mixed provider
  // (the ordinary case), an all-generator provider (the exempt case the
  // `acquires` wording exists for), and a provider whose chat models are long
  // and whose generators are short (the case shortest-id-first got wrong).
  const corpus = new Map([
    ["mixed", [
      entry("mixed", "img", { modalities: { output: ["image"] } }),
      entry("mixed", "tts", { modalities: { output: ["audio"] } }),
      entry("mixed", "chat-model-one", text),
      entry("mixed", "chat-model-two", text),
      entry("mixed", "chat-model-three", text),
    ]],
    ["allgen", [
      entry("allgen", "gen-a", { modalities: { output: ["image"] } }),
      entry("allgen", "gen-b", { modalities: { output: ["image"] } }),
      entry("allgen", "gen-c", { modalities: { output: ["video"] } }),
      entry("allgen", "gen-d", { modalities: { output: ["video"] } }),
    ]],
    ["cheapgen", [
      entry("cheapgen", "v", { modalities: { output: ["video"] },
        pricing: { offers: [offer("cheapgen", 0, 0), offer("x", 1, 1)] } }),
      entry("cheapgen", "e", { modalities: { output: ["embedding"] },
        pricing: { offers: [offer("cheapgen", 0, 0), offer("x", 1, 1)] } }),
      entry("cheapgen", "a-long-paid-chat-model", { ...text,
        pricing: { offers: [offer("cheapgen", 9, 9)] } }),
      entry("cheapgen", "another-paid-chat-model", { ...text,
        pricing: { offers: [offer("cheapgen", 9, 9)] } }),
    ]],
  ]);
  assert.deepEqual(gateViolations(corpus), [],
    "R3 may shed non-text rows from a top-3; it may never add one");

  // ...and `allgen` really was exercised, or the exemption is untested.
  assert.equal(build("allgen", corpus.get("allgen")).picker.length, 3);
});

test("PRIMARY GATE: it can fail, and this is the shape that fails it", () => {
  // The gate is worthless if it cannot fire. Feed it a provider whose generator
  // declares `["audio","text"]` -- outputKind's blind spot -- with a genuine
  // free tier, against chat models that are longer and paid. Under the old
  // shortest-id-first baseline the chat rows won on length; under R3 the
  // generator is acquired on free-first, and the gate must say so.
  const corpus = new Map([["sneaky", [
    entry("sneaky", "a-music-generator-preview", {
      modalities: { output: ["audio", "text"] },
      pricing: { offers: [offer("sneaky", 0, 0), offer("x", 5, 10)] } }),
    entry("sneaky", "chat1", { ...text, pricing: { offers: [offer("sneaky", 9, 9)] } }),
    entry("sneaky", "chat2", { ...text, pricing: { offers: [offer("sneaky", 9, 9)] } }),
    entry("sneaky", "chat3", { ...text, pricing: { offers: [offer("sneaky", 9, 9)] } }),
  ]]]);
  assert.deepEqual(gateViolations(corpus),
    ['sneaky/a-music-generator-preview ["audio"]'],
    "the criterion fires on exactly the failure R11 exists to retire");
});

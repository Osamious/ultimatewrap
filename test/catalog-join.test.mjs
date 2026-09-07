import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJoinIndex, joinCatalogEntry, priceOf } from "../keysync/catalog-join.mjs";
import { priceOf as priceOfViaMenu } from "../menu/catalog.mjs";

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

// UltimateWrap keysync — regenerates CCR's Providers[] and Claude Code's
// modelPicker from the ~/.llmkeys vault.
//
// DEVIATION FROM THE PLAN, STATED UP FRONT: the plan specifies repurposing the
// existing Rust crate. This is implemented in Node instead, to get a working,
// testable regenerator without a compile loop. All of Phase 3's acceptance
// criteria are behavioural and are enforced below; a Rust port can follow.
//
// Safety: this writes CCR config and a settings.json. WHICH settings.json is
// decided entirely by --target. Never point it at a settings file a running
// Claude Code session depends on (see the 2026-09-01 outage).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { admitRemoteModels } from "../menu/denylist.mjs";
// The offer-matching rule and the has-a-price-at-all predicate, from the module
// that owns them. NOT from `menu/catalog.mjs`: that file statically imports THIS
// one (`menu/catalog.mjs:25`, deliberately, with a comment saying why it is not
// dynamic), so importing back from it closes a circular import and drags
// `ccr-client.mjs`/`atomic.mjs` into keysync's transitive graph. Both lanes
// import from `keysync/catalog-join.mjs`, which imports neither.
import { priceOf, hasPricedOffer, buildJoinIndex, joinCatalogEntry } from "./catalog-join.mjs";

// ---------------------------------------------------------------- vault load
const LLMKEYS = path.join(os.homedir(), ".llmkeys");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

/**
 * The vault, verbatim. Profiles are passed through WHOLE rather than projected
 * onto a known field list, which is what lets optional per-provider settings be
 * added in `providers.json` alone. Two are read outside this file today:
 *
 *   `listing`             (R9, `refresh/discover.mjs:listingProfileFor`) -- how
 *                         to ask this host what models a key can call.
 *   `vouchedBareClaude`   (R13c, `run.mjs:vouchedBareClaudeProviders`) -- the
 *                         operator accepts this provider sole-owning a bare
 *                         Claude-shaped id, so `checkBareCollisions` reports the
 *                         finding instead of stopping the run. Absent or false
 *                         on every entry as shipped; setting it is a deliberate
 *                         config decision about a specific reseller's business,
 *                         never a source-level default, and its reader requires
 *                         `=== true` so a stray string cannot disarm the guard.
 *
 * Listed here because a field that exists only at its distant reader is a field
 * the next person edits `providers.json` without knowing about.
 */
export function loadVault() {
  const registry = readJson(path.join(LLMKEYS, "registry.json"));
  const providers = readJson(path.join(LLMKEYS, "providers.json"));
  return { registry, providers: new Map(providers.map((p) => [p.provider, p])) };
}

// ------------------------------------------------------------------- filter
// Plan's rules: exclude the sportsvector* buckets, the `management` tier, the
// `generic` protocol, and orphans with no provider profile.
export function filterRegistry(registry, providers) {
  return registry.filter((r) =>
    !/^sportsvector/i.test(r.bucket) &&
    r.tier !== "management" &&
    providers.has(r.provider) &&
    providers.get(r.provider).protocol !== "generic");
}

// --------------------------------------------------------------- tie-breaks
// The plan requires multi-key providers resolve to a DELIBERATELY CHOSEN key by
// name, never by an unexamined timestamp. Only two providers survive the filter
// with multiple keys. Both choices are recorded here with their reason.
export const KEY_CHOICES = {
  // 19-second timestamp gap would otherwise silently route the user's personal
  // traffic through an institutional (university) key. Prefer the personal one.
  groq: "personal.groq.free",
  // Both are personal buckets; pick the primary one explicitly.
  deepseek: "personal_maestro.deepseek.paid"
};

export function chooseKeys(filtered) {
  const byProvider = new Map();
  for (const r of filtered) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider).push(r);
  }
  const chosen = [];
  const ambiguous = [];
  for (const [provider, entries] of byProvider) {
    if (entries.length === 1) { chosen.push(entries[0]); continue; }
    const want = KEY_CHOICES[provider];
    const pick = entries.find((e) => e.id === want);
    if (!pick) { ambiguous.push({ provider, ids: entries.map((e) => e.id) }); continue; }
    chosen.push(pick);
  }
  if (ambiguous.length) {
    throw new Error(`multi-key provider(s) with no deliberate choice in KEY_CHOICES: ` +
      `${JSON.stringify(ambiguous)} — decide by name, do not let a timestamp decide.`);
  }
  return chosen;
}

// ------------------------------------------------------------------ catalog
const CATALOG_FILE = "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\models.json";

// Returns the two groupings the FILE declares about itself. `byProvider` is the
// grouping every caller already had; `byAlias` is the bundle's own `aliases[]`
// field, which this function used to discard (report 12 §1) -- 10,184 strings
// naming the same 4,298 models as other hosts spell them, and the single
// largest contributor to the D3 join. The ladder's DERIVED structures (global
// ids, tails, case-folded variants) are not built here: they are policy, and
// they belong to `keysync/catalog-join.mjs`.
//
// MEASURED 2026-09-06: no alias is claimed by two entries, so a flat Map loses
// nothing. A collision would still be first-wins, which is the same rule
// `byProvider` push order already follows.
export function loadCatalog() {
  const doc = readJson(CATALOG_FILE);
  const byProvider = new Map();
  const byAlias = new Map();
  for (const m of doc.models ?? []) {
    if (!m.provider || !m.model) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
    for (const a of m.aliases ?? []) {
      if (typeof a === "string" && a && !byAlias.has(a)) byAlias.set(a, m);
    }
  }
  return { generatedAt: doc.generatedAt, byProvider, byAlias };
}

/**
 * free / paid / unknown — a guess is worse than no label, so default to unknown.
 *
 * READS THE LIVE PRICING PATH (#10). This used to read
 * `pricing.{inputPerMillion,outputPerMillion,input,output}`. None of those four
 * fields exists in this schema, which stores prices at
 * `pricing.offers[].per1MTokens` — so the function returned `"unknown"` for
 * 4,298 of 4,298 catalogue entries, the free-first term in `buildProviders`'s
 * sort evaluated `1 - 1 = 0` for every pair, and selection collapsed to
 * shortest-id-first.
 *
 * PROVIDER-MATCHED, WHICH IS WHY THIS TAKES A SECOND ARGUMENT. `offers[]` is a
 * merged array holding up to 16 elements, most of them pricing the model at a
 * DIFFERENT host. Folding them answers "is this free anywhere"; taking
 * `offers[0]` answers "is the first element of an arbitrarily ordered array
 * free". The question a routing decision needs is "is it free on MY key", so the
 * offer is matched to the provider the key belongs to and a non-matching offer
 * yields `null` — blank — rather than falling back to offer 0. That whole rule
 * lives in `priceOf` and is called here rather than restated: one owner.
 *
 * ALL-ZERO OFFERS ARE `"unknown"`, NOT `"free"` (#55). The bundle encodes "not
 * priced per token" as `{input: 0, output: 0}` under a token `sourceUnit` —
 * shape-identical to a genuine free tier. The only discriminator the record
 * carries is CONTRAST: another offer on the same entry naming a real price
 * proves the bundle does hold pricing for this model, which makes the zero a
 * fact about the model rather than a hole in the data.
 * `openai/gpt-5-5` (kenari 0/0 alongside frogbot 2.5/15) is a real free tier;
 * `google/lyria-3-pro-preview`, every offer 0/0, is a missing price.
 * `hasPricedOffer` is that contrast test, shared with `menu/catalog.mjs`'s
 * `badgeOf` so #55 is implemented once — and it reads the WHOLE offers array,
 * not the matched offer, which is load-bearing: on
 * `mistral/labs-devstral-small-2512` the matched offer IS 0/0 while a second
 * mistral offer prices it at 0.1/0.3.
 *
 * Under-classifying is the safe direction, and it is the only direction
 * available: a `false` from `hasPricedOffer` is evidence of absence and not
 * proof of it (a provider's `auto` mode may be genuinely free of charge), so it
 * may withhold the `"free"` claim and must never make the opposite one. An
 * unknown-tier row sorts after genuine free rows and ahead of nothing.
 *
 * @param {object} entry                     a bundled-catalogue entry
 * @param {string|null} providerName         the provider whose key will pay
 */
export function inferTier(entry, providerName = null) {
  const price = priceOf(entry, providerName);
  if (!price) return "unknown";
  if (price.in !== 0 || price.out !== 0) return "paid";
  return hasPricedOffer(entry) ? "free" : "unknown";
}

/**
 * text / nontext / null, from the catalogue's own `modalities.output`.
 *
 * Sits beside `inferTier` for locality -- the other entry-to-label function over
 * the catalogue -- but the rule it follows is `makeRoutableOf`'s
 * (`menu/catalog.mjs:143`), not `inferTier`'s. It is also, now, a SORT TERM
 * AHEAD OF `inferTier`'s on the routing path (see `buildProviders`).
 *
 * WHAT THAT ORDER IS AND IS NOT DEFENDING AGAINST. This paragraph used to say
 * that repairing #10 turned free-first on and that "rerankers and music
 * generators are disproportionately free, so free-first alone promotes non-chat
 * rows over paid chat models". #55 shipped alongside #10, so that is false as
 * shipped: an all-zero-offer row is `"unknown"`, not `"free"`, and MEASURED
 * over the live bundle exactly ONE of 4,298 entries is free. `hasPricedOffer`
 * is what holds the media generators back; this term demotes only rows that
 * DECLARE themselves non-text. The full correction, with the google
 * measurement, is at the sort in `buildProviders`.
 *
 * *(Until 2026-09-07 this paragraph also recorded the opposite of #10:
 * `inferTier` read `pricing.inputPerMillion` while this schema stores
 * `pricing.offers[].per1MTokens`, so it yielded a usable value for 0 of 4,298
 * entries and the free-first sort was a no-op. That is #10, fixed above.)*
 *
 * POSITIVE SIGNALS ONLY. Absence of `modalities.output` is `null` -- unknown,
 * which renders selectable -- never `"nontext"`. Wrongly hiding a real chat
 * model is worse than letting an ambiguous one through, and the catalogue is
 * measurably wrong in that direction: `nvidia/bge-m3` is an embedding model
 * declaring `output: ["text"]`, so it reads as `"text"` here and stays
 * selectable. That miss is accepted, not worked around.
 *
 * The embedding/score clause runs BEFORE the text clause because 18 catalogue
 * entries declare both -- an embedding model that also emits text is still not a
 * chat model. The other 117 non-text entries never reach it.
 *
 * Same value as the keysync picker row's `kind` (T7), under different local
 * pressure: `pick-state.mjs` already spends `item.kind` on
 * "model" | "provider" | "pinned", so the menu pipeline cannot reuse the bare
 * name without putting two vocabularies in one expression.
 */
/**
 * The capability vocabulary, GROUNDED IN R10's SWEEP rather than invented.
 *
 * MEASURED over the 44 cached records (3,745 projected models, 349 carrying a
 * capability at all), the whole observed vocabulary is:
 *   tool_calling 132, text 115, base 46, chat 38, reasoning 7, video 6,
 *   image 3, web_search 2.
 *
 * Only two of those eight are modality claims. `tool_calling`, `reasoning` and
 * `web_search` are capability FLAGS -- a model that reasons still answers in
 * text -- and `base` is a vendor tier word, not a modality: mistral labels its
 * OCR, moderation, embedding and TTS models `base` alongside its chat models,
 * so reading `base` as text would promote a TTS row. Those four are NO SIGNAL
 * and fall through to the bundle, which is the same positive-signals-only
 * doctrine the modality branch below already follows.
 *
 * The lists carry a few spellings beyond the eight (`audio`, `embedding`,
 * `image_gen`, `speech`, `rerank`, `moderation`, `completion`) because
 * `capabilityField` reads four different provider field names and the observed
 * set is one sweep's worth, not the vocabulary's bound. Each added token is an
 * unambiguous modality word in the same sense as the two measured ones; nothing
 * ambiguous is added, and an unrecognised token stays no-signal.
 */
const CAPABILITY_NONTEXT = new Set([
  "audio", "audio_gen", "embed", "embedding", "embeddings", "image", "image_gen",
  "moderation", "rerank", "reranker", "speech", "stt", "transcription", "tts",
  "video", "video_gen", "vision_gen",
]);
const CAPABILITY_TEXT = new Set(["chat", "completion", "completions", "text"]);

/**
 * A provider's own capability token -> "text" | "nontext" | null.
 *
 * `null` for anything outside both lists, which is most of what providers send.
 * Separated from `outputKind` so the vocabulary is assertable on its own and so
 * the precedence in `outputKind` reads as one line rather than as a branch.
 */
export function capabilityKind(capability) {
  if (typeof capability !== "string" || !capability) return null;
  const t = capability.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (CAPABILITY_NONTEXT.has(t)) return "nontext";
  if (CAPABILITY_TEXT.has(t)) return "text";
  return null;
}

/**
 * `capability` OUTRANKS `modalities.output` (R11), and only where it speaks.
 *
 * The bundle is a periodic snapshot merged across hosts; a provider's own
 * listing is what that provider says about the row it is serving today. Where
 * the two disagree the listing wins -- which is what lets a live `image` or
 * `video` demote a row whose bundle entry claims `["audio", "text"]` and
 * therefore reads as text here.
 *
 * SAME PRECEDENCE ON BOTH PATHS. This value reaches the selection sort (which
 * orders routing AND the picker) and `normalizeModel`'s `kind`, so the two
 * cannot disagree about whether a row is a chat model.
 *
 * `bucketFor` DOES NOT READ `capability`, and that boundary is unchanged: it
 * reads `kind`, which is this function's answer, and `reason`, which is the
 * bundle's `capabilities.reasoning` and nothing else. A provider's `reasoning`
 * capability token is deliberately NOT mapped onto `reason` -- it is
 * no-signal above -- because `bucketFor`'s capable bucket is a claim about a
 * client-side prompt profile, not about a marketing flag.
 */
export function outputKind(entry, capability = null) {
  const declared = capabilityKind(capability);
  if (declared) return declared;
  const out = entry?.modalities?.output;
  // An EMPTY array is absence of signal, exactly like a missing field, and the
  // doc above binds this function to answer `null` for absence. Falling through
  // returned "nontext" -- a positive claim built from no evidence -- which made
  // the row unselectable AND silently deleted its pin from recents and
  // favourites at initState (menu/pick-state.mjs's `known` set). A user-visible
  // deletion triggered by an empty upstream field. menu/catalog.mjs's isTextOut
  // already treats the same shape as text; this is the two agreeing.
  // MEASURED 2026-09-06: 0 of 4,298 catalogue entries, so latent, not live.
  if (!Array.isArray(out) || out.length === 0) return null;
  if (out.includes("embedding") || out.includes("score")) return "nontext";
  return out.includes("text") ? "text" : "nontext";
}

// ------------------------------------------------------------ protocol rule
// VERIFIED 2026-09-01: CCR resolves a provider's protocol from its base-URL HOST
// via a built-in registry, and that wins over an explicit `type` AND over
// `protocolDetectionMode: "manual"`. Writing a protocol CCR disagrees with
// produces a 404 (right provider, wrong wire format). So the base URL and the
// protocol must be chosen together, to match what CCR will pick anyway.
export function resolveProtocol(vaultProvider) {
  const base = (vaultProvider.baseUrl || "").toLowerCase();
  if (base.includes("generativelanguage.googleapis.com")) {
    return { type: "gemini_generate_content", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
  }
  if (base.includes("anthropic")) {
    return { type: "anthropic_messages", baseUrl: vaultProvider.baseUrl };
  }
  return { type: "openai_chat_completions", baseUrl: vaultProvider.baseUrl };
}

// --------------------------------------------------------------- build plan
//
// THE CAP IS THE PICKER'S ALONE (R11). It used to size BOTH `providers[].models`
// -- what CCR routes on -- and `picker` -- the flat `/model` menu -- from one
// array, so bounding a menu that is unusable at 44 providers x full catalogues
// also bounded REACH: ~1,501 catalogue rows resolved to `undefined` and did not
// route. The two have different constraints and now have different sizes. The
// name says which one it governs; the old `MAX_MODELS_PER_PROVIDER` did not, and
// that ambiguity is what let one number stand in for two decisions.
//
// This is the DEFAULT. `pickerCapFrom` resolves `UW_MAX_MODELS` against it.
//
// SIZED FROM MEASUREMENT, 2026-09-08 (R13b). Two budgets, both stated here so a
// later edit argues against numbers rather than against taste:
//
//   PARSE CEILING  <= 2x today's median `JSON.parse` of the WHOLE settings.json.
//                  Claude Code parses that file at every launch, so this is a
//                  growth discipline on the startup path, not a stall guard.
//   BYTE BUDGET    `modelPicker.options` <= 100 KB serialized. The resolver plan
//                  already names "past 200 KB" as the failure retiring this cap
//                  outright would cause; 100 KB keeps a full doubling in hand.
//
// MEASURED against the real vault (44 providers, 1,584 routing ids), median of 7
// trials x 1,500 parses each, trial spread under 1%:
//
//   cap   picker rows   options bytes   settings.json   parse ms   x today   undeclared
//     3            94          12,965          23,447     0.0539     1.00x        1,501
//    10           200          27,126          43,332     0.1005     1.86x        1,395
//    25           379          52,424          78,296     0.1803     3.35x        1,216
//    50           586          82,490         119,540     0.2709     5.03x        1,009
//   inf         1,595         245,679         337,215     0.7202    13.36x            0
//
// 10 is the largest cap inside BOTH budgets: parse binds first (25 is 3.35x), and
// the byte budget would have allowed 50. So the parse ceiling is the operative
// one and the byte budget is slack -- stated anyway, because it is the budget the
// plan's "past 200 KB" was about and the one that stops `inf`.
//
// WHAT THIS DOES NOT CLAIM. The absolute cost is sub-millisecond at EVERY
// candidate -- 0.72 ms uncapped -- so no candidate here is perceptible at launch
// and this cap is not rescuing anyone from a stall. It bounds unbounded growth of
// a startup-path file, which is a different and smaller claim.
//
// WHAT WOULD BIND FIRST IF IT WERE MEASURED. Not bytes and not parse: the native
// `/model` menu renders 10 rows with 1-row scrolling and NO FILTER (resolver plan
// D4 step 2), and this raises it from 94 rows to 200. `orderNativePickerOptions`
// keeps the relay's rows at the head, which is what keeps the top of a 200-row
// menu useful; uwpick is the surface meant to go wide. A future task that wants a
// larger cap should measure the menu, not re-argue the parse ceiling.
//
// THE UNDECLARED POPULATION IS NOT WHAT SIZED THIS. It falls 1,501 -> 1,395 of
// 1,584 (7.1%), which is a by-product and NOT a fix. The residual population is
// filed as its own [LIMIT] issue; no number is cited here because it did not
// exist when this shipped, and a guessed one is worse than none.
export const MAX_PICKER_MODELS_PER_PROVIDER = 10;

/**
 * `UW_MAX_MODELS` -> a usable positive integer, or the default.
 *
 * A VALIDATED PARSE, NEVER A BARE `Number()`, AND THAT IS THE WHOLE FUNCTION.
 * The previous form was `Number(process.env.UW_MAX_MODELS ?? 3)` compared with
 * `models.length >= MAX_MODELS_PER_PROVIDER`. `Number("x")` is `NaN`, and every
 * comparison against `NaN` is false -- so `UW_MAX_MODELS=x` did not fall back to
 * 3, it removed the cap entirely and silently. Renaming the constant while
 * keeping the coercion reproduces that exactly: the rename passes every other
 * check in this file and the picker goes unbounded on one typo'd env value,
 * which is why this has its own test rather than riding on the rename's.
 *
 * `/^\d+$/` on the TRIMMED string, not `Number.isInteger(Number(s))`: the latter
 * accepts `"3.0"`, `"0x3"`, `" 3 "`, `"3e0"` and `""` (which is 0). A cap is an
 * operator-typed count, so the only spelling that means one is a run of digits.
 * Zero falls back too -- a cap of zero is an empty menu, which is never what a
 * count was typed to express, and rule 1 forbids reaching it by accident.
 */
export function pickerCapFrom(raw, fallback = MAX_PICKER_MODELS_PER_PROVIDER) {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

// ------------------------------------------------------- provenance (R13b)
//
// HOW STRONG THE EVIDENCE IS THAT AN ID IS REAL, as the FIRST term of the
// selection sort. Before this, the sort carried no provenance term at all, so a
// row the provider's own listing named and a row only the bundled snapshot
// mentions were separated by nothing but insertion order (see `extras` below).
//
// THE RUNG ORDER, AND WHY `config-asserted` SITS SECOND RATHER THAN THIRD OR
// FIRST. Two real populations are asserted by local config with nothing ever
// probing them: the vault's `testModel` (one per provider) and the relay's
// literal model list. Ranking them BELOW `listing-verified` sorts the relay's
// models and every `testModel` under third-party listing rows, which is exactly
// the regression #59 fixed once already. Ranking them at the TOP conflates "a
// human wrote this id in a config file" with "a completion came back 200 on a
// dated run", which is the only rung carrying real evidence. So: second.
//
// A DATED REAL CALL OUTRANKS A LIVE LISTING OUTRANKS A SNAPSHOT. `call-verified`
// is verify-prune.mjs's probe -- an actual completion, the strongest signal any
// of these carry. `listing-verified` is what the provider says it serves TODAY,
// which is real-time evidence that a config literal is not. `catalogue-only` is
// the bundled `models.json`: a periodic snapshot merged across hosts, and the
// weakest positive claim. Absence of all four is `null`, which sorts LAST and
// leaves such rows exactly where they are relative to each other.
export const PROVENANCE_ORDER = Object.freeze([
  "call-verified", "config-asserted", "listing-verified", "catalogue-only",
]);

// Unranked sorts after every named rung. Derived from the array rather than
// written as a literal so adding a rung cannot leave this stale.
export const PROVENANCE_UNRANKED = PROVENANCE_ORDER.length;

/**
 * A provenance label -> its sort position. `null`/unknown -> last.
 *
 * Separated from `provenanceOf` for the same reason `capabilityKind` is
 * separated from `outputKind`: the vocabulary is assertable on its own, and the
 * sort reads one number rather than a chain of string comparisons.
 */
export function provenanceRank(label) {
  const i = PROVENANCE_ORDER.indexOf(label);
  return i === -1 ? PROVENANCE_UNRANKED : i;
}

/**
 * The STRONGEST rung an id qualifies for, or `null` for none.
 *
 * Membership sets, not booleans, because every caller already holds sets and
 * because "strongest wins" has to be decided in one place -- an id is routinely
 * in several at once (a `testModel` that also appears in the catalogue and was
 * also probed). Checking them in rung order and returning the first hit is what
 * makes that precedence a property of this function rather than of each call
 * site's `if` order.
 *
 * Every set is optional and a missing one contributes nothing rather than
 * throwing: this is enrichment over inputs that may legitimately be absent, and
 * an absent input must degrade to a lower rung, never stop a build.
 *
 * CORRECTED AT R13c. This used to read "run.mjs passes neither a discovery cache
 * nor probe results today" and treat the whole function as latent. HALF OF THAT
 * IS NOW FALSE: run.mjs calls `loadDiscoveryCache` and passes the result to
 * `buildProviders`, so `listed` is populated on the production build and
 * discovered ids resolve to `listing-verified` rather than falling through to
 * `catalogue-only`. `verified` is still unpassed -- probe results reach
 * `applyVerifiedOnly`, not this -- so `call-verified` remains the one rung
 * nothing in the pipeline reaches.
 *
 * @param {string} id                     the model id as the provider spells it
 * @param {object} [sets]
 * @param {Set<string>} [sets.verified]   ids a real completion returned 200 for
 * @param {Set<string>} [sets.asserted]   ids local config names (testModel, relay)
 * @param {Set<string>} [sets.listed]     ids the provider's live listing named
 * @param {Set<string>} [sets.catalogued] ids the bundled catalogue names
 * @returns {"call-verified"|"config-asserted"|"listing-verified"|"catalogue-only"|null}
 */
export function provenanceOf(id, { verified, asserted, listed, catalogued } = {}) {
  if (verified?.has(id)) return "call-verified";
  if (asserted?.has(id)) return "config-asserted";
  if (listed?.has(id)) return "listing-verified";
  if (catalogued?.has(id)) return "catalogue-only";
  return null;
}

/**
 * verify-prune.mjs's output -> `provider -> Set<id>` of call-verified ids.
 *
 * Accepts the file as it is on disk (`{working: [...], results: [...]}`), the
 * `working` array on its own, or an already-grouped Map/object -- the same
 * shape-tolerance `discoveryIndex` has, for the same reason: a malformed or
 * absent input must cost a rung, never a build.
 *
 * READS `working`, OR `results` FILTERED BY `ok`, AND NEVER `results` WHOLE.
 * `results` records failures too (4 of 22 on the live file), and a row that
 * returned 401 or timed out is the opposite of call-verified. verify-prune.mjs
 * derives `working` as exactly `results.filter(r => r.ok)`, so the two paths
 * agree by construction; the filter exists for a caller holding only `results`.
 *
 * SPLIT ON THE FIRST SLASH ONLY. Ids contain slashes -- `cloudflare/@cf/openai/
 * gpt-oss-120b` and `nscale/Qwen/Qwen3-4B-Instruct-2507` are both real rows --
 * so splitting on every slash would key them under a provider that does not
 * exist and silently drop the strongest rung for the rows most likely to have
 * earned it. verify-prune.mjs's own `m.split("/")[0]` reads the provider the
 * same way.
 */
export function verifiedIndex(verified) {
  const out = new Map();
  if (!verified) return out;
  let flat = null;
  if (Array.isArray(verified)) flat = verified;
  else if (Array.isArray(verified?.working)) flat = verified.working;
  else if (Array.isArray(verified?.results)) {
    flat = verified.results.filter((r) => r?.ok === true).map((r) => r?.model);
  }
  if (flat) {
    for (const full of flat) {
      if (typeof full !== "string") continue;
      const cut = full.indexOf("/");
      if (cut <= 0 || cut === full.length - 1) continue;
      const provider = full.slice(0, cut);
      if (!out.has(provider)) out.set(provider, new Set());
      out.get(provider).add(full.slice(cut + 1));
    }
    return out;
  }
  const pairs = verified instanceof Map ? verified.entries()
    : (typeof verified === "object" ? Object.entries(verified) : []);
  for (const [provider, ids] of pairs) {
    if (!Array.isArray(ids)) continue;
    out.set(provider, new Set(ids.filter((i) => typeof i === "string" && i !== "")));
  }
  return out;
}

// --------------------------------------------------- capability buckets (D4)
//
// `behavesAs` names a model Claude Code already knows, whose client-side
// handling (prompt profile, effort tiers, thinking policy, believed context
// window) every third-party row borrows. One constant for all 83 rows was an
// OVER-declaration: it told Claude Code that a 4,096-token non-reasoning model
// handles what a frontier reasoning model handles. Under-declare instead --
// report 18 §10.6 measured that of the eight gated predicates, five are free to
// under-declare and four are dangerous to over-declare.
//
// A TABLE, VALIDATED BY AN ALLOWLIST, NOT A DENYLIST. A denylist passes a typo
// (`claude-sonnet-4-51`) silently, and silently is the failure mode this exists
// to prevent. V1/V2/V6 in validate() check the table itself, so a wrong entry
// stops the run rather than shipping 83 wrong declarations.
//
// FOUR CLASSIFICATIONS, TWO TARGETS. The extras are not decoration: keeping
// "we measured it small" and "we know nothing" separately countable is what
// makes the no-signal population (38 of 83) auditable, and it is the only
// reason bucketFor's `> 0` guard is observable at all -- with `unknown` folded
// into `weak`, both branches return the same string and the guard is untestable.
export const BUCKET_TARGETS = Object.freeze({
  // Unchanged from the single constant this replaces, deliberately: 27 of 83
  // rows stay byte-identical, which is the control group proving the classifier
  // RAN rather than replaced everything it touched.
  capable: "claude-sonnet-4-6",
  weak:    "claude-sonnet-4-5",
  unknown: "claude-sonnet-4-5",   // D3 — same target, distinct classification
  nonchat: "claude-sonnet-4-5"    // D6 — inert, but never absent
});

// The weak target is `claude-sonnet-4-5`, NOT the capability-identical
// `claude-haiku-4-5`. Report 18 §10.2 fn 1: haiku's `interleaved_thinking` flips
// false on bedrock / vertex / gateway / any custom base URL -- which is exactly
// every provider shape UW routes through. `haiku-4-5` is absent from the
// allowlist below for the same reason, so a later edit cannot reach for it.
export const ALLOWED_BEHAVES_AS = Object.freeze([
  "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-opus-4-6", "claude-opus-4-1"
]);

// Models whose client-side handling carries a MODEL-SPECIFIC prompt bundle,
// which a third-party model must never inherit: `opus_5_prompt_bundle`,
// `fable_5_mitigations`, `refusal_fallback`, `thinking_disabled_effort_cap` and
// `rejects_disabled_thinking` (report 18 §10.3) -- plus these models omit
// `temperature` entirely (§10.2), so a borrowed profile silently drops a
// parameter the third-party provider expects.
export const PROMPT_BUNDLE_MODELS = /^claude-(opus-5|fable-5|mythos-5)/;

// INCLUSIVE, and the catalogue has a natural gap that makes `>=` vs `>` a
// visible one-character mutation rather than a taste call. Measured over the 83
// rows: mistral/mistral 8192, ollama/llama2 4096, ollama/llama3 8192,
// cohere/command 4096 | cerebras/llama3.1-8b EXACTLY 128000,
// cloudflare/granite-4.0-h-micro 131000, sambanova/gemma-4-31b-it 131072.
// Nothing sits between 8,192 and 128,000, and a real row sits on the boundary.
export const CTX_CAPABLE_MIN = 128000;

/**
 * The normalized keysync model -> its capability classification.
 *
 * ORDER IS LOAD-BEARING AND `kind` GOES FIRST. `contextTokens` is not
 * trustworthy for a non-text row: google/veo-2 carries 480 (video SECONDS) and
 * google/lyria carries 0. Both are numbers, so a proxy that ran first would read
 * them as tiny models. Both also carry `reasoning: false`, so moving `reason`
 * above `kind` sends them to weak instead of nonchat -- and every count in the
 * audit still sums to 83, which is why the test for this asserts on a row that
 * is `kind: "nontext"` and `reason: true` at once.
 *
 * `contextTokens > 0`, not `!= null`: google/lyria really reports 0, and a zero
 * is the absence of a window rather than a very small one.
 *
 * Reads `contextTokens`. See normalizeModel for why that name is asserted.
 *
 * @param {{kind: ?string, reason: ?boolean, contextTokens: ?number}} model
 * @returns {"nonchat"|"capable"|"weak"|"unknown"}
 */
export function bucketFor(model) {
  if (model?.kind === "nontext") return "nonchat";
  if (model?.reason === true) return "capable";
  if (model?.reason === false) return "weak";
  const ctx = model?.contextTokens;
  if (typeof ctx !== "number" || !(ctx > 0)) return "unknown";
  return ctx >= CTX_CAPABLE_MIN ? "capable" : "weak";
}

/**
 * The declaration a row carries. NEVER null, "" or undefined.
 *
 * Omitting `behavesAs` is not the honest option, it is the MAXIMAL one: an id
 * with no declaration resolves through the binary's `lH()` to every effort tier,
 * adaptive thinking on and thinking un-disableable, plus an unknown-model launch
 * warning. Report 18 §3 measures that as strictly worse than any bucket target,
 * which is why even the four non-chat rows declare the weak target (D6) -- the
 * declaration is inert on a model that cannot answer a chat request, and inert
 * beats maximal.
 *
 * The lookup goes through BUCKET_TARGETS so the table cannot be bypassed by a
 * caller that "knows" the answer.
 */
export function behavesAsFor(model) {
  return BUCKET_TARGETS[bucketFor(model)];
}

/**
 * Anthropic via the local OAuth relay, added as a first-class provider.
 *
 * WHY THIS EXISTS: without it, keysync removes Claude from Claude Code entirely.
 * The vault has no `anthropic` key (the filter drops it as an orphan), so CCR
 * ends up with zero Anthropic providers; `applyProfile` then repoints every
 * model-alias env var at a third-party model and `replaceBuiltInOptions: true`
 * strips the built-in rows. The 2026-09-01 live cutover did exactly that and had
 * to be rolled back. The relay resolves the subscription token itself, so no
 * Anthropic credential is ever written into CCR's config.
 */
// The four ids the relay serves, and the four bare aliases Claude Code accepts.
// These are two different lists with two different consumers, and collapsing
// them ships a visibly broken menu -- run.mjs maps the relay's ids straight into
// picker rows, so a single 8-element array renders four duplicates.
//
//   models / picker -> the four full ids. `models` is what CCR is given today and
//                      what every existing consumer reads; `picker` is the same
//                      list under the name the renderer asks for.
//   routing         -> full ids PLUS the bare aliases. Written into
//                      Providers[].models ONLY when run.mjs's `aliasesOk` probe
//                      says the relay can actually serve them (Step 3c).
//
// The aliases exist so the relay CO-OWNS them: a third-party provider publishing
// bare `opus` then lands in `shadowed` instead of becoming its sole owner, which
// is the one case checkBareCollisions cannot catch on its own -- S1 keys on the
// relay being ABSENT, and this is the case where it is present.
//
// THE SPLIT IS ADDITIVE AND THE ID SET IS UNCHANGED. An earlier draft replaced
// this constant with {provider, picker, routing}. That drops api_base_url, so
// run.mjs:102 probes `undefined/health`, `anthropicOn` is permanently false and
// the relay never loads -- which removes Claude from Claude Code entirely. It
// also rewrote the four ids, dropping claude-fable-5-1 and the dated
// claude-haiku-4-5-20251001 for an undated form plus claude-opus-5-thinking,
// none of it verified. Changing what the relay advertises needs its own
// verification against a live CCR and is not part of splitting a list in two.
// Parse defensively: `api_base_url` is vault data and a malformed value must
// degrade to a blank suffix, never throw during config generation.
const hostOf = (u) => { try { return new URL(u).host; } catch { return ""; } };

// CURATED, REVIEWED, STATIC. This is NOT "the rows the picker shows" -- the
// picker shows every id the live catalog returns. It has two narrower jobs, and
// both are about what happens when live data is absent or untrustworthy:
//
//   1. FALLBACK. When the live fetch fails entirely (relay down, no cache) or
//      the cache is past the routing staleness ceiling, these four ids are the
//      routing set AND the picker set, because they are known-good by review.
//   2. VOUCHING, for the collision guard. `checkBareCollisions` treats the
//      relay's ownership of an id as evidence of SAFETY only for ids in here.
//      Routing auto-adds every live id, and without this distinction that
//      auto-add would make the guard's FATAL path structurally unreachable --
//      a reseller sole-listing a live-but-unreviewed id would be laundered into
//      an accepted ambiguity by our own routing config. See run.mjs.
//
// Adding an id here therefore stays a deliberate one-line human edit: it is an
// assertion that a human looked at that id, not merely that Anthropic serves it.
export const ANTHROPIC_FULL = Object.freeze([
  "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"
]);
// EXPORTED because checkBareCollisions must exempt these four from its realIds
// narrowing, and a second copy of the list there would be free to drift from this
// one -- which is the drift that produced the hole eeea057 opened.
export const ANTHROPIC_ALIASES = Object.freeze(["opus", "sonnet", "haiku", "fable"]);

// `[1m]`, on the PICKER list only -- never on `models`/`routing`.
//
// Claude Code resolves its believed context window from the literal model
// string, and without this marker a picker row for a real 1M-context model
// reads as 200k once selected: MEASURED live 2026-09-05, selecting the
// UW-injected row for `anthropic/claude-opus-5` (bare) left the session on
// 200k, while typing `/model anthropic/claude-opus-5[1m]` directly resolved
// to "Claude Opus 5 (1M context)" correctly. `ANTHROPIC_DEFAULT_OPUS_MODEL`
// and `ANTHROPIC_DEFAULT_SONNET_MODEL` already carry the suffix for exactly
// this reason -- the picker rows were simply never given the same treatment.
//
// `claude-haiku-4-5-20251001` is deliberately bare: Haiku 4.5's real ceiling
// is 200,000 tokens (no 1M variant exists), so tagging it would be a false
// claim, not a bigger window.
//
// `models`/`routing` stay on the bare ids. Those feed `Providers[].models`,
// which CCR routes on and the relay forwards toward Anthropic -- and
// Anthropic's real API rejects a suffixed model id outright: MEASURED,
// `POST /v1/messages {"model":"claude-opus-5[1m]"}` -> `404 not_found_error`.
// The relay now strips `[1m]` at its own last hop before forwarding (see
// anthropic-oauth-relay.mjs's `resolveModelId`), which is what makes it safe
// for `validate()` to require the picker's suffixed id to also appear
// verbatim in `models[]` -- see the picker-row construction below.
//
// THIS ARRAY IS NOW THE FALLBACK, NOT THE LIVE TRUTH. The tags below are what
// ships when the live catalog cannot be reached at all (relay down AND no
// cache): a hand-checked snapshot of the same facts, never deleted, so a
// network failure degrades to today's exact behaviour rather than to untagged
// rows. When live data IS available, `buildAnthropicPickerRows` recomputes each
// tag from the model's real `max_input_tokens` and this array is not consulted
// for that id -- so Anthropic changing a context window, or shipping a 1M
// variant of Haiku, no longer needs a code edit.
const ANTHROPIC_PICKER_FALLBACK = Object.freeze([
  "claude-opus-5[1m]", "claude-sonnet-5[1m]", "claude-haiku-4-5-20251001", "claude-fable-5-1[1m]"
]);

// DERIVED from the array above, never re-typed. Two hand-maintained lists of one
// fact are how they drift; this one cannot, because the map is generated from
// the array at load time and a change to either is a change to both.
export const ANTHROPIC_FALLBACK_TAGS = Object.freeze(Object.fromEntries(
  ANTHROPIC_PICKER_FALLBACK.map((tagged) => [tagged.replace(/\[1m\]$/i, ""), tagged])
));

// Claude Code's client-side context-window lever, in full: `Gc(e) =
// /\[1m\]/i.test(e) -> 1e6`. A string suffix and nothing else -- the
// `modelPicker.options[]` schema has exactly four fields (model, label,
// description, behavesAs) and no numeric context field -- so this constant is
// the whole of the threshold, and `>=` is the whole of the comparison.
export const ONE_M_TOKENS = 1_000_000;

/**
 * Tag each id with `[1m]` iff its LIVE context window says so.
 *
 * Pure: no fetch, no cache, no clock. `contextById` is whatever
 * `fetchAnthropicCatalog` resolved (possibly from a stale cache, possibly
 * empty); the fallback map covers ids it has no entry for.
 *
 * THREE INPUTS, IN PRECEDENCE ORDER, and the third is the one that matters:
 *   1. live window stated  -> tag iff >= 1M. Authoritative.
 *   2. no live window, but a hand-tagged default exists (the curated four)
 *                          -> use that default. "Not stated" is NOT "small":
 *      treating it as small would silently drop a real 1M row back to a
 *      believed 200k window, the exact defect the `[1m]` work was done to fix.
 *   3. no live window AND no default (any id beyond the curated four)
 *                          -> BARE. Nothing has confirmed a 1M window for this
 *      id, and the two errors are not symmetric: under-claiming costs display
 *      accuracy, while over-claiming lets a session send a prompt larger than
 *      the model can actually hold. Guess downward or not at all.
 *
 * @param {readonly string[]} ids              bare ids to build rows for
 * @param {Map<string, number>|object} contextById  live max_input_tokens by id
 * @param {object} [fallbackTags]              bare id -> hand-tagged default
 * @returns {string[]} one entry per input id, in the same order
 */
export function buildAnthropicPickerRows(ids, contextById, fallbackTags = ANTHROPIC_FALLBACK_TAGS) {
  const ctx = contextById instanceof Map ? contextById : new Map(Object.entries(contextById ?? {}));
  return (ids ?? []).map((raw) => {
    // Strip first, always. The curated list is bare today, but an id that ever
    // arrived already tagged would otherwise be looked up under a key that is
    // not in `contextById` and then emitted as `claude-opus-5[1m][1m]` -- a
    // model string nothing resolves, in the one place a wrong string is silent.
    const id = String(raw).replace(/\[1m\]$/i, "");
    const live = ctx.get(id);
    if (Number.isFinite(live)) return live >= ONE_M_TOKENS ? `${id}[1m]` : id;
    return fallbackTags?.[id] ?? id;
  });
}

export const ANTHROPIC_RELAY = {
  name: "anthropic",
  provider: "anthropic",
  type: "anthropic_messages",
  api_base_url: process.env.UW_ANTHROPIC_RELAY ?? "http://127.0.0.1:4517",
  api_key: "relay-ignores-this",
  autoFetchModels: false,
  enabled: true,
  // Verified live through CCR 2026-09-02. `models` and `routing` stay the
  // curated set: they are the STATIC SAFETY NET for the same total-failure case
  // `picker` covers, and run.mjs unions the live ids on top of them rather than
  // replacing them, so a live response that anomalously omits one of the four
  // cannot remove it from routing.
  models: ANTHROPIC_FULL,
  picker: ANTHROPIC_PICKER_FALLBACK,
  routing: Object.freeze([...ANTHROPIC_FULL, ...ANTHROPIC_ALIASES])
};

// Per-tier anchors, so Claude Code keeps its normal tiering (cheap models for
// background work) instead of pointing every tier at one model.
export const ANTHROPIC_TIERS = {
  model: "anthropic/claude-opus-5",
  opusModel: "anthropic/claude-opus-5",
  sonnetModel: "anthropic/claude-sonnet-5",
  haikuModel: "anthropic/claude-haiku-4-5-20251001",
  smallFastModel: "anthropic/claude-haiku-4-5-20251001",
  fableModel: "anthropic/claude-fable-5-1"
};

// The profile anchor serves Claude Code's own traffic — a full system prompt
// plus tool definitions — which small models reject outright. Fastest-is-best
// is the wrong rule here; prefer models observed to handle that payload.
export const ANCHOR_PREFERENCE = [
  "google/gemini-3.5-flash-lite",
  "mistral/mistral-small-latest",
  "openrouter/",
  "groq/openai/gpt-oss-20b",
  "cerebras/",
  "bigmodel/"
];

/**
 * One catalogue entry -> the normalized model object the row builder consumes.
 *
 * ONE FUNCTION, TWO CALL SITES, AND THAT IS THE POINT. The two push sites below
 * (the vault's testModel, and the catalogue-ranked extras) built this literal
 * separately, which is the single recorded downside of reading capability
 * signals from the entry already in hand: two places to keep in sync. Widening
 * both by hand is how they drift. It is exported for the same reason
 * `checkBareCollisions` and `deriveAnthropicSets` are: the pipeline cannot be
 * driven from a test without a vault, so a shape left inline is a shape nothing
 * can assert on -- and the ONE thing worth asserting here is the field NAME.
 *
 * `contextTokens`, NOT `ctx`. `ctx` is the menu pipeline's name for the same
 * number (`menu/catalog.mjs:176`); this side has always called it
 * `contextTokens`. A classifier reading `ctx` here gets `undefined` for every
 * row, silently sends all 7 context-proxy rows to the weak bucket (27/56 becomes
 * 24/59) and stays green under any test that feeds it an object literal. Hence
 * the paired test that drives the classifier with an object THIS function built.
 *
 * `?? null`, NEVER `||`. `false || null === null`, so `||` would turn a
 * MEASURED-false capability back into "unknown" -- the same conflation as
 * `!!undefined === false`, wearing a different operator. `reasoning` is `false`
 * on 12 of the 45 matched rows, and each of those is a real signal.
 *
 * `entry` is undefined for 38 of the 83 rows (a vault testModel with no
 * catalogue entry at all). Every derived field is then `null` or `"unknown"`:
 * no signal is not a small model.
 *
 * `providerName` IS PASSED THROUGH, NOT DERIVED. `inferTier` matches the price
 * offer to the provider whose key will pay, and this function is its only call
 * site -- so a provider-matched `inferTier` cannot be fed unless the name
 * arrives here. Deriving it from `entry.provider` instead would be wrong at the
 * one call site that matters: `buildProviders` normalizes the vault's
 * `testModel` against a catalogue entry looked up under the LIVE provider, and
 * the price that governs is the live provider's, not the entry's bundle
 * grouping. Absent (the 38 no-entry rows, and any caller with no key in hand) it
 * falls through to `priceOf`'s no-provider rule, which answers only when exactly
 * one usable offer exists.
 *
 * @param {string} id                     the model id as the provider spells it
 * @param {object|null|undefined} entry   its bundled-catalogue entry, if any
 * @param {string|null} providerName      the provider whose key will pay
 */
export function normalizeModel(id, entry, providerName = null, capability = null) {
  return {
    id,
    tier: entry ? inferTier(entry, providerName) : "unknown",
    contextTokens: entry?.limits?.contextTokens,
    reason: entry?.capabilities?.reasoning ?? null,
    kind: outputKind(entry, capability)
  };
}

/**
 * A discovery input -> `provider -> [{id, capabilityRaw, ...}]`.
 *
 * Accepts what R10's cache actually holds and what a caller is likely to have in
 * hand: a Map or plain object of provider -> record, where a record is either
 * the cache record (`{outcome, models: [...]}`) or the bare projected array.
 * Anything else contributes nothing rather than throwing -- this is optional
 * enrichment, and a malformed cache must degrade to the pre-R11 candidate set,
 * never stop a build.
 *
 * `lastGood` IS NOT CONSULTED. A record carrying it says the provider failed
 * TODAY, and the same failure that produced it is the reason its listing may be
 * retired. Routing on it would advertise ids nothing has confirmed this run; the
 * `testModel` half of the union is what keeps such a provider present.
 */
function discoveryIndex(discovery) {
  const out = new Map();
  if (!discovery) return out;
  const pairs = discovery instanceof Map
    ? discovery.entries()
    : (typeof discovery === "object" ? Object.entries(discovery) : []);
  for (const [provider, record] of pairs) {
    const models = Array.isArray(record) ? record
      : (Array.isArray(record?.models) ? record.models : null);
    if (!models) continue;
    out.set(provider, models.filter((m) => typeof m?.id === "string" && m.id !== ""));
  }
  return out;
}

/**
 * @param {object[]} chosen        the vault registry entries, one per provider
 * @param {Map} providers          provider name -> vault profile
 * @param {object} catalog         from `loadCatalog`
 * @param {(id: string) => string} keyReader
 * @param {Map|object|null} [discovery]  R10's cache, provider -> record. Absent
 *   or malformed leaves the candidate set at `testModel u catalogue`, which is
 *   the pre-R11 set MINUS nothing -- discovery only ever ADDS ids, so a caller
 *   with no cache loses no reach it had before.
 * @param {object|string[]|Map|null} [verified]  verify-prune.mjs's probe output.
 *   RANKING ONLY -- unlike `discovery` it contributes no candidates, so it can
 *   reorder the picker's prefix but can never change which ids route. Absent
 *   drops every row to a lower provenance rung together, which is a no-op on the
 *   sort rather than a reordering.
 */
export function buildProviders(chosen, providers, catalog, keyReader, discovery = null,
                               verified = null) {
  const out = [];
  const picker = [];
  const notes = [];
  const discoveredBy = discoveryIndex(discovery);
  const verifiedBy = verifiedIndex(verified);
  // READ PER CALL, NOT AT MODULE LOAD, so a test can set the variable and
  // observe the bound it produces. Reading it once at import made the only
  // assertable thing about the parse its return value, which is exactly the
  // check the `NaN` bug slipped past.
  const pickerCap = pickerCapFrom(process.env.UW_MAX_MODELS);
  // LAZY, and built at most once per call. It is a full pass over the bundle
  // (4,298 entries), which a run with no discovery has no use for -- and every
  // such run is the one that must stay exactly as cheap as it was.
  let joinIdx = null;
  const joinIndex = () => (joinIdx ??= buildJoinIndex(catalog));

  for (const reg of chosen) {
    const vp = providers.get(reg.provider);
    const { type, baseUrl } = resolveProtocol(vp);
    const catalogEntries = catalog.byProvider.get(reg.provider) ?? [];

    // SECURITY, report 08 F1. This runs BEFORE `ranked` is computed and before
    // `vp.testModel` is prepended, because both of those write into
    // Providers[].models, which is what CCR routes. The trusted relay is exempt:
    // `anthropic` is our own loopback on 4517 and is the only provider that may
    // legitimately serve a Claude-shaped name.
    const admitted = admitRemoteModels(reg.provider, catalogEntries.map((m) => m.model));
    const keptIds = new Set(admitted.kept);
    const safeEntries = catalogEntries.filter((m) => keptIds.has(m.model));
    // GUARD THE CALL, do not filter the message. `testModel` is optional -- the
    // original code wraps its use in `if (vp.testModel)` -- and `admitId(undefined)`
    // coerces to "" and returns null, so an unguarded call pushes the literal
    // string "undefined" into `rejected` and prints
    //   SECURITY: provider "X" advertised 1 rejected model name(s): undefined
    // once per provider without a curated testModel, on every keysync run and
    // every dry run. Step 4 below asks the implementer to READ that dry-run output
    // and treat a provider losing all its models as a finding worth stopping for.
    // Burying that signal in false positives is how a security channel stops being
    // read, which costs more than the line it saves.
    const safeTestModel = vp.testModel
      ? (admitRemoteModels(reg.provider, [vp.testModel]).kept[0] ?? null)
      : null;

    // DISCOVERY (R10's cache), the third source and the newest one. It is the
    // provider's OWN listing -- what this key can call today -- where the bundle
    // is a periodic snapshot merged across hosts. Admitted through the same gate
    // as the other two, in ONE call, because a second per-provider
    // `admitRemoteModels` would print a second SECURITY line for the same
    // provider and split one finding across two messages.
    const discovered = discoveredBy.get(reg.provider) ?? [];
    const discoveredKept = discovered.length
      ? new Set(admitRemoteModels(reg.provider, discovered.map((m) => m.id)).kept)
      : new Set();
    // Keyed by id so a CATALOGUE-sourced candidate picks up the live capability
    // for the same id. Without this the precedence would apply only to rows
    // discovery contributed on its own, which is the half where the bundle has
    // nothing to be outranked.
    const capabilityById = new Map();
    for (const m of discovered) {
      if (discoveredKept.has(m.id) && m.capabilityRaw) capabilityById.set(m.id, m.capabilityRaw);
    }

    // MEASURED 2026-09-01: preferring catalog ids over the vault's testModel
    // dropped the live pass rate to 4/44 — the bundled catalog lists models a
    // given key/tier often cannot actually call (mostly upstream 404s). The
    // vault's testModel is the probe-verified known-good id for this key, so it
    // leads; catalog entries are appended as extras.
    //
    // `models` IS NOW THE UNION AND IS UNCAPPED (R11): testModel u discovery u
    // catalogue, deduplicated, in that order of precedence. The picker takes a
    // prefix of it; routing takes all of it.
    //
    // THE UNION IS WHAT KEEPS A RESPONDING PROVIDER IN THE CONFIG, and that is
    // not a refinement of "the discovered set" -- it is the difference between
    // this being safe and it deleting providers. The `!models.length` skip below
    // PRECEDES the `out.push`, so a provider whose candidate set is empty is
    // dropped from `Providers[]` entirely. MEASURED in R10's sweep: `tabiai` and
    // `gorouter` both answered HTTP 200 with `data: []` (outcome `empty`) and
    // both carry a real `testModel` -- so a discovered-set-only rule deletes two
    // providers that ANSWERED, which rule 1 forbids. `testModel` leading the
    // union is what makes that structurally impossible rather than merely
    // unlikely.
    const models = [];
    const seen = new Set();
    if (safeTestModel) {
      // `cat` is undefined for 38 of the 83 rows — this is the no-signal case.
      const cat = safeEntries.find((m) => m.model === safeTestModel);
      models.push(normalizeModel(safeTestModel, cat, reg.provider,
        capabilityById.get(safeTestModel) ?? null));
      seen.add(safeTestModel);
    }
    // The two extra sources, gathered before the sort so ONE ordering governs
    // both outputs. Catalogue first, then discovery-only ids: the sort is stable
    // and carries NO provenance term, so insertion order is the only thing
    // separating two otherwise-equal rows. Adding a provenance term is R13b's,
    // deliberately not this task's -- ranking a live listing above the bundle is
    // a decision with its own evidence, not a side effect of unioning them.
    const extras = [];
    const queued = new Set(seen);
    for (const m of safeEntries) {
      if (queued.has(m.model)) continue;
      queued.add(m.model);
      extras.push({ id: m.model, entry: m, capability: capabilityById.get(m.model) ?? null });
    }
    for (const d of discovered) {
      if (!discoveredKept.has(d.id) || queued.has(d.id)) continue;
      queued.add(d.id);
      // The join is what turns a live id into capability signals: `reasoning`
      // and `contextTokens` exist ONLY in the bundle, so an unjoined live id is
      // an honest `unknown` rather than a guess. `null` is a real answer here.
      extras.push({ id: d.id, entry: joinCatalogEntry(joinIndex(), reg.provider, d.id),
                    capability: d.capabilityRaw ?? null });
    }
    if (extras.length) {
      // ONE ORDERING, TWO CONSUMERS (R11). This sort used to decide membership:
      // the loop below stopped at the cap, so a row past position 3 was not
      // merely lower in the menu, it did not ROUTE. It now decides ORDER only --
      // every extra joins `models`, and the picker takes a prefix. "Curate
      // rather than dump" stays exactly true of the flat 44-provider menu and
      // stops being true of the routing table, which has no display cost and
      // whose bound was costing ~1,501 catalogue rows their ability to resolve.
      //
      // Prefer chat, then free-tier, then shortest id.
      //
      // `kind` IS THE FIRST TERM, AHEAD OF FREE-FIRST. The ORDER is free; what
      // this comment used to claim about the free-first term was not.
      //
      // CORRECTED 2026-09-07. It read: "repairing #10 turns the term on for the
      // first time... measured on cohere, where the repair alone replaces
      // `command | command-a | command-r` with two rerankers", and, below, that
      // free-first promotes Lyria back into google's top-3. BOTH ARE FALSE AS
      // SHIPPED, and the reason is mechanical: #55 landed with #10. `inferTier`
      // classifies an all-zero-offer row as `"unknown"`, not `"free"`, so
      // MEASURED over the live bundle there is EXACTLY ONE free row in all
      // 4,298 entries (`mistral/labs-devstral-small-2512`). A free-first term
      // with one free row catalogue-wide evaluates `1 - 1 = 0` for essentially
      // every pair and cannot promote a CLASS of anything.
      //
      // SO NAME THE GUARD THAT IS ACTUALLY DOING THE WORK: `hasPricedOffer`
      // (#55), inside `inferTier`, not the `kind` term here. MEASURED on
      // google's 185 entries: with #55, the top-3 is
      // `gemma-3 | gemma-2-9b | gemma-4-31b`; with #55 removed and the `kind`
      // term left exactly as it is, it becomes
      // `lyria-3-pro-preview | lyria-3-clip-preview | gemma-3` -- two music
      // generators. The `kind` term does not stop them, because they declare
      // `["audio", "text"]` and `outputKind` therefore reads them as text.
      //
      // That matters to whoever edits this next: removing #55 as "R5b's
      // labelling fix" while keeping the `kind` term reinstates two music
      // generators into a provider's routing set. The previous wording told
      // them the opposite.
      //
      // The `kind` term stays, on its own merit: it is the only term that
      // demotes a DECLARED non-chat row, and the data costs nothing to obtain
      // -- `outputKind(entry, capability)` is called a few lines below in
      // `normalizeModel`, on the same entry and the same capability.
      //
      // `=== "nontext"`, NOT `!== "text"`. `outputKind` answers `null` for
      // absence of signal (`menu/catalog.mjs`'s `isTextOut` agrees), and a
      // no-signal row must rank WITH the text rows, not with the generators:
      // demoting on absent evidence is the confident-wrong this codebase
      // refuses everywhere else.
      //
      // THE GUARD IS NO LONGER BUNDLE-ONLY (R11), AND IT IS ALSO NOT RETIRED.
      // `kind` is now `outputKind(entry, capability)`, so a provider's own
      // capability token OUTRANKS the bundle's `modalities.output` -- which is
      // what lets a live `image`/`video` demote a row the bundle calls text.
      //
      // WHAT THAT DOES NOT FIX, MEASURED AGAINST R10's ACTUAL CACHE. R11's brief
      // said this retires the provisional guard for google's Lyria previews,
      // "where those rows are `image_gen`/`audio`". They are not, in the cache
      // that exists: all 55 of google's projected models carry
      // `capabilityRaw: null`, Lyria included, because Google's listing states
      // `supportedGenerationMethods` and none of `discover.mjs`'s four
      // `capabilityField` candidates matches it. So Lyria is still read as text
      // here and is still held out by `hasPricedOffer` alone. The precedence is
      // real and fires -- MEASURED, llm7 supplies 9 `image`/`video` tokens via
      // `model_type` -- but the named example is not one of them, and widening
      // `capabilityField` to reach Google is a discovery-side change, not this
      // one.
      //
      // THE STATED GATE DOES NOT PASS, and saying it does was the second false
      // claim in this block. The boolean "no provider's top-3 acquires a row
      // whose `modalities.output` contains a modality other than text" is
      // FALSE against the real `buildProviders`: MEASURED, 4 of 44 built
      // providers and 5 of 83 picker rows carry such a row --
      // `openrouter/auto` and `kilo/auto` (`["image","text"]`),
      // `openai/gpt-5-nano` (`["image","text"]`), and `nscale/flux.1-schnell`
      // and `nscale/stable-diffusion-xl-base-1.0` (`["image"]`).
      //
      // It is the OBSERVABLE that is mis-specified, not the code, and it must
      // not be "fixed" by making the gate pass: nscale's entire catalogue is
      // image models, so its top-3 is non-text by construction, and rule 1
      // (never prune a responding provider) keeps those rows. Correcting the
      // observable belongs to the plan, not here; what this comment owes the
      // next reader is the number with its denominator rather than a pass.
      // NO `localeCompare`. The third term is a length comparison and stays one:
      // `localeCompare` is locale-dependent and ICU-build-dependent, so it would
      // make the SAME vault and the SAME bundle produce a different top-3 on a
      // different machine -- an ordering that cannot be reproduced from the
      // inputs is not an ordering this config may be built on.
      //
      // PROVENANCE IS THE SECOND TERM (R13b), BELOW `kind` AND ABOVE FREE-FIRST.
      // See PROVENANCE_ORDER for the rung order and why `config-asserted` is
      // second within it. The four sets are all already in hand: nothing here is
      // fetched or re-derived, so the term costs one Map lookup per row.
      //
      // R13b's brief specified this term ABOVE `kind`. THAT ORDER IS WRONG, and
      // it is wrong in a way this fixture proves rather than argues: the live
      // `capability` token is BOTH the thing that demotes a row through `kind`
      // and the thing that promotes it to `listing-verified`, because a row
      // carries a capability only when a listing named it. Ranked above `kind`,
      // the promotion wins and supplying discovery data makes a declared
      // `image_gen` row sort HIGHER than it did with no discovery at all -- the
      // exact inverse of what the precedence exists to do. MEASURED: it inverts
      // "a capability demotes a row in the SELECTION SORT, not only in `kind`"
      // (test/routing-split.test.mjs), which is a shipped R11 invariant.
      //
      // The general form, which is why this is a correction and not a local
      // patch: `kind === "nontext"` is a DISQUALIFIER -- "is this a chat model
      // at all" -- and provenance is a QUALITY ranking over rows that already
      // passed it. Strong evidence that an image generator exists is still
      // strong evidence about an image generator. Every other term here
      // (free-first, id length) is a preference among comparable rows, so
      // provenance sits directly beneath the one disqualifier and above them.
      //
      // `asserted` IS THE testModel AND THE testModel IS NOT IN `extras`. It is
      // pushed into `models` above, ahead of this sort, so today the set is
      // always disjoint from what is being sorted and the rung is unreachable
      // from here. It is passed anyway, because `provenanceOf`'s precedence is
      // only correct if every caller hands it every set it has -- and the day
      // `testModel` stops being special-cased upstream, this sort must already
      // rank it second rather than dropping it to `catalogue-only`.
      //
      // THIS TERM IS LIVE ON THE PRODUCTION BUILD AS OF R13c, and the note it
      // replaces said the opposite. That note read "run.mjs passes NEITHER
      // `discovery` NOR `verified`, so every extra resolves to `catalogue-only`,
      // the term evaluates 3 - 3 = 0 for every pair, and the ordering is exactly
      // what it was" -- true when written, false the moment run.mjs began
      // calling `loadDiscoveryCache`. `discoveredKept` now feeds `listed` above,
      // so a discovered extra ranks 2 against an undiscovered one's 3 and SORTS
      // AHEAD OF IT. R13b's provenance term is doing real work here, and a reader
      // reasoning about ordering from the old note would have reasoned about a
      // build that no longer exists.
      //
      // `verified` IS still unpassed -- probe results reach `applyVerifiedOnly`,
      // not this sort -- so `call-verified` stays the one rung the pipeline
      // cannot reach. It is passed anyway, for the same reason `asserted` is.
      const provSets = {
        verified: verifiedBy.get(reg.provider),
        asserted: safeTestModel ? new Set([safeTestModel]) : undefined,
        listed: discoveredKept,
        catalogued: keptIds,
      };
      const ranked = extras
        .map((e) => ({ e, kind: outputKind(e.entry, e.capability),
                       tier: e.entry ? inferTier(e.entry, reg.provider) : "unknown",
                       prov: provenanceRank(provenanceOf(e.id, provSets)) }))
        .sort((a, b) => (a.kind === "nontext" ? 1 : 0) - (b.kind === "nontext" ? 1 : 0) ||
          a.prov - b.prov ||
          (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
          a.e.id.length - b.e.id.length);
      // The entry is in hand by construction, so the capability signals need no
      // lookup — which is what makes cross-provider name matching structurally
      // impossible here rather than merely discouraged. `ranked`'s `tier` is
      // dropped in favour of normalizeModel recomputing it: same value from the
      // same entry AND the same provider name, and one owner of the shape beats
      // a second literal. That second clause is now load-bearing rather than
      // incidental -- `inferTier` is provider-matched, so recomputing it from a
      // different name would silently disagree with the sort that just ran.
      //
      // NO CAP HERE ANY MORE. The `models.length >= MAX_MODELS_PER_PROVIDER`
      // that stood in this condition is the whole of what R11 moved: it now
      // bounds the picker slice below and nothing else. `seen` still guards the
      // testModel, which `extras` already excludes -- kept because it is the
      // dedup invariant this loop has always maintained, not because a duplicate
      // can currently reach it.
      for (const { e } of ranked) {
        if (seen.has(e.id)) continue;
        models.push(normalizeModel(e.id, e.entry, reg.provider, e.capability));
        seen.add(e.id);
      }
    }
    if (!models.length) {
      notes.push(`${reg.provider}: no testModel and no catalog entry — skipped`);
      continue;
    }
    // THE SPLIT. `models` routes in full; `pickerModels` is the prefix the flat
    // `/model` menu can carry. Taking a PREFIX of one ordered list rather than
    // re-ranking is what keeps the two from disagreeing about which rows a
    // provider's best three are.
    const pickerModels = models.slice(0, pickerCap);

    const name = reg.provider;
    out.push({
      name,
      provider: name,
      type,
      api_base_url: baseUrl,
      api_key: keyReader(reg.id),
      models: models.map((m) => m.id),
      autoFetchModels: false,
      enabled: true
    });

    for (const m of pickerModels) {
      const row = {
        model: `${name}/${m.id}`,
        label: `${name} > ${m.id}`
      };
      // The answering HOSTNAME, appended to the description.
      //
      // This is the control that replaces name refusal on the display side.
      // Under rule 2 a user is EXPECTED to see Claude names from several
      // providers, so the question the UI must answer stops being "is this name
      // allowed" and becomes "who serves it". A vault nickname is user-chosen
      // and can be made to read as official; a hostname cannot be. So a reseller
      // row reads `tabiai > claude-opus-5 · tabitoken.com` against the relay's
      // `anthropic > claude-opus-5 · 127.0.0.1:4517`.
      //
      // Never surface `behavesAs` here: it is a client-side prompt profile, not
      // a selector, and rendering it would read as a claim about which model is
      // actually answering -- the precise confusion this exists to remove.
      //
      // "unknown" gets no tier: a guess is worse than no label. The host is still
      // shown, because who answers is a fact rather than an inference.
      const host = hostOf(baseUrl);
      const tier = m.tier !== "unknown" ? m.tier : "";
      const desc = [tier, host].filter(Boolean).join(" · ");
      if (desc) row.description = desc;
      // VERIFIED: without behavesAs, Claude Code does not recognize a
      // provider-format id, warns on every launch, and assumes a 200k context
      // window regardless of the model's real one. behavesAs names a model it
      // DOES know whose client-side handling (prompt profile) to reuse.
      //
      // Per row now, not one constant for all 83: see BUCKET_TARGETS. Never
      // absent -- behavesAsFor always returns a table value, because an absent
      // declaration resolves to the MAXIMAL assumption set, not to none.
      row.behavesAs = behavesAsFor(m);
      // UW-SIDE FIELDS, BOTH STRIPPED BEFORE THE WRITE (run.mjs). Claude Code's
      // own zod schema for a row is exactly {model, label?, description?,
      // behavesAs?}, so either of these reaching settings.json is a fifth key in
      // a four-key schema. `kind` is carried unconditionally, including its null,
      // so validate() sees the same field on every row -- V5 asks whether a row
      // is non-chat, and a key that exists only on some rows makes "absent" and
      // "text" indistinguishable there.
      row.kind = m.kind;
      if (m.contextTokens) row.contextTokens = m.contextTokens;
      picker.push(row);
    }
  }
  return { providers: out, picker, notes };
}

// ------------------------------------------------------------- validations

/**
 * V1, V2 and V6: the rules whose subject is the BUCKET TABLE itself.
 *
 * Split out of `validate()` for one reason, and it is a testing reason rather
 * than a structural one. The table is a frozen module constant, so a test could
 * not make it wrong -- which left these three rules with no test that could
 * FAIL. What stood in for one re-implemented all three in the test body against
 * the same constants and never called `validate()` at all, so deleting the rules
 * outright left the suite green. Parameterising the table is what makes the
 * failure branch reachable, and T8's acceptance criterion (one test per rule,
 * asserting the message names its reason) satisfiable.
 *
 * Defaults are the live constants, so the production call site is unchanged and
 * the real table is still validated on every run.
 *
 * @param {Record<string,string>} [targets]  the bucket -> behavesAs table
 * @param {readonly string[]} [allowed]      the vetted behavesAs allowlist
 * @param {RegExp} [bundle]                  ids carrying a model-specific prompt bundle
 * @returns {string[]} problems, empty when the table is sound
 */
export function validateBucketTable(targets = BUCKET_TARGETS,
                                    allowed = ALLOWED_BEHAVES_AS,
                                    bundle = PROMPT_BUNDLE_MODELS) {
  const problems = [];

  // V1 -- the table holds vetted targets, not typos. An allowlist rather than a
  // denylist because a denylist passes `claude-sonnet-4-51` in silence, and
  // silence is the failure mode this exists to prevent.
  // V2 -- and no target may carry a model-specific prompt bundle.
  for (const [bucket, target] of Object.entries(targets)) {
    if (!allowed.includes(target)) {
      problems.push(`bucket "${bucket}" target "${target}" is not in ALLOWED_BEHAVES_AS ` +
        `— a vetted target, not a typo`);
    }
    if (bundle.test(target)) {
      problems.push(`bucket target "${target}" carries a model-specific prompt bundle ` +
        `(report 18 §10.3) and must never be inherited by a third-party model`);
    }
  }

  // V6 -- THE WHOLE TABLE SHAPE, over all four keys, not one inequality.
  // This is the canary for the failure that looks like success. `capable !== weak`
  // guards one of the three ways the table can break: pointing `unknown` or
  // `nonchat` at the capable target flips 38 or 4 rows back into over-declaration
  // with that inequality still true and every other rule green.
  if (targets.capable === targets.weak) {
    problems.push(`BUCKET_TARGETS.capable and .weak name the same target ` +
      `("${targets.weak}"); the table would classify without declaring anything`);
  }
  for (const bucket of ["unknown", "nonchat"]) {
    if (targets[bucket] !== targets.weak) {
      problems.push(`BUCKET_TARGETS.${bucket} points at the capable target; only "capable" may`);
    }
  }

  return problems;
}

// `table` exists so the tier-1 rules can be OBSERVED firing, not merely asserted
// to be present. It defaults to the live constants, so every production call is
// unchanged. Without it the only available check was a source-string match on
// validate.toString(), which passes when the call appears in a COMMENT and never
// shows the returned problems reaching `problems` -- a test for a vacuity that
// was shaped like one.
export function validate({ providers, picker }, expectedCount, table = {}) {
  const problems = [];

  if (providers.length !== expectedCount) {
    problems.push(`expected exactly ${expectedCount} providers, got ${providers.length}`);
  }

  // Alias uniqueness: CCR matches a selector's provider half against several
  // fields; a collision makes array order silently decide routing.
  const aliases = new Map();
  for (const p of providers) {
    // A provider's own name/provider fields are deliberately equal; only a
    // collision BETWEEN different providers makes array order decide routing.
    const own = new Set([p.name, p.provider].filter(Boolean).map((a) => a.toLowerCase()));
    for (const k of own) {
      if (aliases.has(k) && aliases.get(k) !== p.name) {
        problems.push(`alias collision "${k}": ${aliases.get(k)} vs ${p.name}`);
      }
      aliases.set(k, p.name);
    }
  }

  // Every picker row must exist in that provider's models[], modulo a trailing
  // `[1m]`. That suffix is Claude Code's own local context-window marker, never
  // sent to a real API (the relay strips it at its last hop, see
  // anthropic-oauth-relay.mjs), and CCR's own resolve() already tolerates it
  // when matching a request against Providers[].models -- MEASURED: this
  // session ran for hours on `anthropic/claude-sonnet-5[1m]` via
  // ANTHROPIC_DEFAULT_SONNET_MODEL despite `models[]` never containing a
  // suffixed entry. This check enforces the same tolerance CCR already has,
  // rather than forcing `models[]` to carry redundant suffixed duplicates that
  // the collision guard's real-id predicate (checkBareCollisions' `realIds`)
  // would then have to know about too.
  const stripOneMHere = (s) => s.replace(/\[1m\]$/i, "");
  const configured = new Set(providers.flatMap((p) => p.models.map((m) => `${p.name}/${m}`)));
  for (const row of picker) {
    if (!configured.has(row.model) && !configured.has(stripOneMHere(row.model))) {
      problems.push(`picker row "${row.model}" not in Providers[].models`);
    }
  }

  // No credential may be empty.
  for (const p of providers) {
    if (!p.api_key || typeof p.api_key !== "string") problems.push(`provider "${p.name}" has no api_key`);
  }

  // ---- tier 1: the capability declarations ---------------------------------
  // Subject = the BUILT set. Everything asserted here has its subject in scope
  // at this point in the run; the two rules whose subject is the WRITTEN artifact
  // live in run.mjs's assertOptionsComplete instead, because `options[]` does not
  // exist until 350 lines below this function is called. Asserting an invariant
  // where its subject does not yet exist is how a rule passes vacuously.
  const targets = new Set(Object.values(BUCKET_TARGETS));

  // V1, V2 and V6, whose subject is the TABLE rather than this build.
  problems.push(...validateBucketTable(table.targets, table.allowed, table.bundle));

  // V3 -- every non-relay row declares, and declares a table value.
  // The relay rows are exempt BY CONSTRUCTION, not by oversight: they carry no
  // `behavesAs` because Claude Code already knows those ids, so a declaration
  // there would be borrowed from the model itself.
  // V5 -- a non-chat row declares the WEAK target specifically. Inverted from an
  // earlier draft that had it declare nothing: absence resolves through lH() to
  // the maximal assumption set, which is the state this branch exists to remove.
  const relayPrefix = `${ANTHROPIC_RELAY.name}/`;
  for (const row of picker) {
    if (row.model.startsWith(relayPrefix)) continue;
    if (!row.behavesAs || !targets.has(row.behavesAs)) {
      problems.push(`picker row "${row.model}" has behavesAs ` +
        `${row.behavesAs ? `"${row.behavesAs}"` : "(none)"}, which is not a bucket target`);
    } else if (row.kind === "nontext" && row.behavesAs !== BUCKET_TARGETS.weak) {
      problems.push(`non-chat row "${row.model}" declares "${row.behavesAs}"; a non-chat row ` +
        `must declare the weak target — omitting it resolves to the maximal assumption ` +
        `set (report 18 §3)`);
    }
  }

  // V4 -- `options[]` is a registry keyed by `model`, so a duplicate makes array
  // order decide which declaration wins for that id. Report 19 §6.3.
  const seenRows = new Set();
  for (const row of picker) {
    if (seenRows.has(row.model)) problems.push(`duplicate picker row "${row.model}"`);
    seenRows.add(row.model);
  }

  // V9 -- `autoFetchModels` must be exactly `false` on every entry, the relay
  // included. Report 12 §10, #44.
  //
  // THIS IS NOT A REACH LIMITATION, and reading it as one is how it gets
  // flipped. It is the ENFORCEMENT POINT FOR BOTH MODEL GATES. `admitRemoteModels`
  // and `checkBareCollisions` run here, at keysync time, over keysync's inputs.
  // CCR's own discovery runs at gateway start and every 600s after, hits each
  // provider's /v1/models itself, and APPENDS what it finds to
  // `Providers[].models` -- after both gates have already run, and without
  // re-entering either. So a hostile aggregator publishing a bare Claude-shaped
  // id has it fetched and made routable while the guard never sees it, because
  // the guard only ever inspects what keysync wrote. The picker sanitiser is
  // bypassed on the same path unconditionally, so ids carrying ANSI escapes or
  // U+202E reach the menu and are rendered. The rule is not "fewer models"; it
  // is "every model passes our gate first".
  //
  // STRICT `!== false`, NOT `=== true`, and that distinction is the finding
  // itself. The value is a literal at two construction sites -- ANTHROPIC_RELAY
  // and buildProviders -- and #44 is precisely that nothing stops either from
  // dropping it. A rule that only rejected an explicit `true` would still be
  // relying on the construction sites to always set the field, which is the
  // reliance this rule exists to replace.
  //
  // AND ABSENCE IS NOT NEUTRAL -- IT OPENS AN ALIAS CHAIN. Do not "simplify"
  // this to `=== true`. CCR parses the field from FOUR spellings, coalescing on
  // nullish (VERIFIED byte-exact in the shipped bundle,
  // @musistudio/claude-code-router/dist/main/cli.js):
  //
  //   autoFetchModels:oM(r.autoFetchModels ?? r.auto_fetch_models
  //                      ?? r.autoRefreshModels ?? r.auto_refresh_models)
  //   function oM(e){return typeof e=="boolean"?e:void 0}
  //
  // `??` falls through only on null/undefined, so a PRESENT `autoFetchModels`
  // short-circuits the whole chain and the three aliases become unreachable.
  // An ABSENT one falls through to all three, and any of them set `true` is
  // honoured. So `=== true` would permit the key to be absent -- which is
  // exactly the state in which a snake_case alias silently wins. Requiring the
  // field present AND false is what makes the alias chain unreachable by
  // construction, which is the real reason this rule is strict.
  for (const p of providers) {
    if (p.autoFetchModels !== false) {
      problems.push(`provider "${p.name}" has autoFetchModels ` +
        `${JSON.stringify(p.autoFetchModels)}, which must be exactly false: CCR's own ` +
        `discovery appends provider-declared ids to Providers[].models at gateway start, ` +
        `after admitRemoteModels and checkBareCollisions have already run over keysync's ` +
        `inputs — so every id it adds becomes a routing target that passed neither gate ` +
        `nor the picker sanitiser`);
    }
  }

  // V10 -- the relay's provider name is reserved, asserted HERE and not only
  // inside run.mjs's relay branch. #23 + #25.
  //
  // `assertRelayNameUnclaimed` is the primary guard and still runs, but it runs
  // AT THE INJECTION, inside `if (anthropicOn)`. So in the one configuration
  // where an impostor is most useful -- the relay down, or `--no-anthropic` --
  // nothing checks the name at all. `checkBareCollisions` keys owners by
  // provider NAME, so an entry called `anthropic` collapses into the relay's
  // identity and the guard reports no collision while the impostor sole-owns a
  // Claude id. Nothing else here catches it either: the alias-collision rule
  // above compares `aliases.get(k) !== p.name`, and two entries SHARING a name
  // make that comparison equal, so duplicate names are exactly the case it
  // cannot see (#25).
  //
  // IDENTITY IS PROVEN BY THE BASE URL MATCHING THE RELAY'S, NOT BY ONE BEING
  // DECLARED. That is the same distinction buildProviders already draws when it
  // puts the answering hostname in a picker row's description: a vault nickname
  // is user-chosen and can be made to read as official, a hostname cannot.
  //
  // SO THE TEST IS `!==`, NOT `declared && !==`, AND AN ABSENT URL FAILS IT.
  // Until 2026-09-07 the guard read `claimants[0].api_base_url && ... !== ...`,
  // defended by a comment claiming "buildProviders sets one on every vault entry
  // it emits, so a built impostor always takes the declared branch". That is
  // FALSE: `resolveProtocol` returns `baseUrl: vaultProvider.baseUrl` unguarded,
  // so a vault entry with `protocol: "openai"` and no `baseUrl` reaches
  // `api_base_url: undefined` and the `&&` short-circuited the whole rule away.
  // MEASURED: an impostor named `anthropic` with no base url produced 0 problems
  // from V10 and 0 findings from checkBareCollisions — in exactly the relay-down
  // configuration V10 exists for.
  //
  // "An entry with no base url answers nothing" was the other half of the same
  // mistake. It does not need to answer: the harm is the NAME, and the four
  // privileges below are granted on the name alone, before any request is made.
  const relayName = ANTHROPIC_RELAY.name.toLowerCase();
  const claimants = providers.filter((p) =>
    String(p?.name ?? "").toLowerCase() === relayName);
  // Named in full because "reserved name" alone tells an operator nothing about
  // why renaming their provider is not optional -- the three dependents
  // assertRelayNameUnclaimed names, plus the admission exemption it omits.
  const reservedWhy = `checkBareCollisions keys owners by provider name and would collapse ` +
    `it into the relay's identity (reporting no collisions while it sole-owns a Claude id), ` +
    `orderNativePickerOptions would hoist its rows to the head of the /model menu, ` +
    `validate()'s V3 exemption would excuse those rows from declaring behavesAs — which ` +
    `lH() resolves to the maximal assumption set — and admitRemoteModels treats the name ` +
    `as its \`trusted\` relay, exempting every id it advertises from the UW_ALIAS check, ` +
    `so it alone could squat uw/ routing slots. Rename it in providers.json.`;
  if (claimants.length > 1) {
    problems.push(`${claimants.length} providers are named "${ANTHROPIC_RELAY.name}", ` +
      `a name reserved for the relay: ${reservedWhy}`);
  } else if (claimants.length === 1 &&
             claimants[0].api_base_url !== ANTHROPIC_RELAY.api_base_url) {
    const answersAt = claimants[0].api_base_url
      ? `"${claimants[0].api_base_url}"` : `no declared base url`;
    problems.push(`the provider named "${ANTHROPIC_RELAY.name}" answers at ` +
      `${answersAt}, not at the relay's ` +
      `"${ANTHROPIC_RELAY.api_base_url}", and that name is reserved for the relay: ` +
      `${reservedWhy}`);
  }

  return problems;
}

/**
 * CCR appends "[1m]" to model env vars for >=1M-context models.
 *
 * MEASURED, and narrower than it first appeared: Claude Code rejects the
 * suffixed id (`unrecognized_model`) only for models it does not know — i.e.
 * THIRD-PARTY ids. On a real Claude model `[1m]` is legitimate and even
 * correct, so blanket-stripping it discarded a valid 1M-context selection.
 * Strip third-party suffixes; leave anthropic/* alone.
 *
 * NOTE ON DURABILITY: this runs after CCR's applyProfile, but ANY later
 * CCR-initiated apply (gateway restart, supervisor restart, UI action) re-adds
 * the suffix. That is inherent and cannot be fixed from here. It only matters
 * when an anchor is third-party — which is why an Anthropic anchor is preferred
 * whenever the relay is up.
 */
export function stripOneMSuffix(settings) {
  let stripped = 0;
  for (const k of Object.keys(settings.env ?? {})) {
    const v = settings.env[k];
    if (typeof v !== "string" || !/\[1m\]$/i.test(v)) continue;
    if (/^anthropic\//i.test(v)) continue; // legitimate on a model Claude Code knows
    settings.env[k] = v.replace(/\[1m\]$/i, "");
    stripped += 1;
  }
  return stripped;
}

/**
 * `/model` writes the user's pick into settings.json ("saved as your default for
 * new sessions") — the same file keysync owns. Treat `model` as USER-owned:
 * preserve it while it still names a live picker row, and clear it once it has
 * gone stale, so a pruned row cannot leave the user pinned to a dead model.
 */
export function reconcileUserModelPin(settings, pickerRows) {
  const pinned = settings.model;
  if (typeof pinned !== "string" || !pinned) return { action: "none" };
  const valid = pickerRows.some((r) => r.model.toLowerCase() === pinned.toLowerCase());
  if (valid) return { action: "kept", pinned };
  delete settings.model;
  return { action: "cleared", pinned };
}

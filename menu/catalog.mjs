// Shared catalogue builder for the UW model picker.
//
// Reads only metadata: vault registry/profiles and the model catalogue.
// NEVER reads or returns API key values.
//
// Split deliberately in two:
//   buildFrom(input)  -- pure. Every test drives this with a fixture.
//   build()           -- loads the live vault and catalogue, then delegates.
// Without the split, testing the badge rules would mean reading ~/.llmkeys.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sanitizeDisplay, admitId } from "./sanitize.mjs";
import { admitRemoteModels } from "./denylist.mjs";
import { writeAtomic } from "./atomic.mjs";
import * as CCR from "./ccr-client.mjs";

// A static import, not `await import()`. There is no dynamic reason for a dynamic
// import here -- the path is a constant -- and the top-level await it forces makes
// every importer of catalog.mjs, including snapshot.mjs and the bench child,
// async-load keysync.mjs. keysync.mjs has no top-level side effects, so this is
// cheap in practice; it is still a cost paid for nothing on the picker's startup
// path, which has a 300 ms budget.
import * as K from "../keysync/keysync.mjs";

// `priceOf` moved OUT of this file (R5) and is re-exported unchanged, so every
// existing importer of `menu/catalog.mjs` keeps working. It had to move because
// `keysync.mjs` needs the same offer-matching rule and cannot import it from
// here: the static import above means the reverse direction closes a cycle and
// drags `ccr-client.mjs`, `atomic.mjs` and their graph into keysync's. One owner
// of the rule, reachable from both sides; the import path is incidental. The
// reasoning about WHICH offer to trust moved with the function.
import { priceOf, hasPricedOffer, buildJoinIndex, joinCatalogEntry } from "../keysync/catalog-join.mjs";
export { priceOf };

export const SLOT = path.join(os.homedir(), ".uw", "state", "slot.json");

// `priceOf` used to be defined here. It now lives in
// `keysync/catalog-join.mjs`, imported above and re-exported there, so that both
// this file's call sites (`badgeOf`, `buildProviders`) and its importers read
// exactly as before.

// GUARD G1: a zero *token* price on a model whose output is not text means it is
// billed per image/second in another unit. Blank, never "free".
export function isTextOut(entry) {
  const out = entry?.modalities?.output;
  return !Array.isArray(out) || out.length === 0 || out.includes("text");
}

// The whole badge set. Nothing else may ever be rendered.
//   FREE   price 0 AND a curated recurring grant cadence  (the governing rule)
//   FREE?  EITHER price 0 with the cadence unknown, OR the provider published
//          the id with a `:free`/`-free`/`/free` tail and holds no price that
//          contradicts it -- see `isFreeSuffixed`. Both are "zero, on evidence
//          we cannot fully confirm", which is what the `?` has always carried;
//          the second is a claim about the NAME rather than about a recorded
//          price, and it is gated so that only the provider's own listing or
//          our own config can make it. MEASURED 2026-09-09: of 183 FREE? rows,
//          17 come from a recorded price and 156 from a vouched tail.
//   PLAN   subscription-covered: marginal price 0 because a plan was paid for
//   PAID   any non-zero token price
//   ""     no evidence, guard G1, guard G2, an unvouched free tail, or price 0
//          with a ONE-TIME grant
//
// The last case deserves its own sentence: a one-time signup wallet is not free
// under the governing definition, and it is not paid either, because the
// marginal price really is zero. Blank is the only honest rendering.
// A `:free`, `-free` or `/free` TAIL on the id the provider itself published.
// END-ANCHORED: `qwen3.6-plus-free` and `dots-3-note-preview:free` are variant
// markers, and an id merely CONTAINING the word (`freeway-7b`, `free-voice`,
// `ineed/freetier`) is not making a claim about price.
//
// `^` IS ONE OF THE ACCEPTED LEFT BOUNDARIES, so a bare id of exactly `free`
// matches. Two live rows need it -- `openrouter` and `kilo` each publish an id
// that is just `free` -- and their full selectors, `openrouter/free` and
// `kilo/free`, are the same `/free` form as every other row here; the separator
// simply falls on the provider side of the id this function is given. Requiring
// a separator INSIDE the id would badge `orcarouter/free` and refuse `free`,
// which is the same string being read two ways.
//
// This is provider convention, not a verified fact. `badgeOf` consumes it on two
// different paths under DIFFERENT gates, and the difference is load-bearing: on
// the G2 path `priceOf` already matched an offer belonging to this host, so the
// tail only has to resolve what that host's own `0/0` means; on the no-price path
// nothing is known about this host at all, so the tail is additionally gated on
// provenance. Neither path lets the tail outrank a positive price.
const FREE_SUFFIX = /(?:^|[:\-/])free$/i;
// `typeof`, not `String(id ?? "")`. That coercion accepted a one-element array --
// `String(["m:free"])` is `"m:free"` -- so a non-string leaking in from a future
// caller could badge a row. An id is a string or it is not an id.
export const isFreeSuffixed = (id) => typeof id === "string" && FREE_SUFFIX.test(id);

// THE ID ALONE IS NOT ENOUGH ON THE `!p` PATH, and the reason is `priceOf`'s
// own contract. `priceOf(entry, providerName)` matches offers belonging to MY
// provider, so `null` does not mean "the catalogue holds no price" -- it most
// often means "the catalogue holds no offer from THIS host for this model".
// The catalogue files a model under its VENDOR namespace, so `openai/gpt-5.5:free`
// is some router's free tier sitting in the `openai` group, and a user holding a
// direct OpenAI key would be told OpenAI has a free model. MEASURED 2026-09-09:
// 10 such rows (openai 2, google 2, deepseek 3, alibaba 2, cohere 1), every one
// `catalogue-only`, every one `routable: true` so nothing dims it. That is the
// exact lie `priceOf`'s comment names as the one to prevent.
//
// So the tail counts on that path only when the PROVIDER vouched for the id:
// `listing-verified` (its own listing named it) or `config-asserted` (our own
// vault config names it). `catalogue-only` means only the offline bundle knows
// the id, which is precisely the vendor-namespace case above.
//
// A FUNCTION, not a module-level Set: this file declares `CONFIG_ASSERTED`
// further down, so a top-level `const` reading it here would evaluate inside its
// temporal dead zone and throw on import.
const vouchedForFreeTail = (rung) => rung === "listing-verified" || rung === CONFIG_ASSERTED;

export function badgeOf(entry, { cadence = "", planCovered = false, providerName = null,
                                 id = "", provenance = null } = {}) {
  if (planCovered) return "PLAN";
  const p = priceOf(entry, providerName);
  // NO PRICE FOR THIS PROVIDER. Blank stays the answer for an ordinary row, and
  // for a free-tailed one the tail is honoured only under the two gates above
  // it: `isTextOut` because FREE? is a claim about a TOKEN price and an audio
  // model billed per second is not made token-free by its name (this is G1,
  // which lives inside the zero branch below and so is unreachable from here --
  // `vercel/s1-free` and two siblings declare `output: ["audio"]` and would
  // badge FREE? without it), and the vouching rung because of the vendor-
  // namespace defect described above.
  if (!p) {
    return isFreeSuffixed(id) && isTextOut(entry) && vouchedForFreeTail(provenance)
      ? "FREE?" : "";
  }
  if (p.in === 0 && p.out === 0) {
    if (!isTextOut(entry)) return "";        // G1
    // GUARD G2 (#67): a zero the bundle never actually recorded. #55 found that
    // "not priced per token" is stored as {input: 0, output: 0}, so on 123 of
    // the picker's 124 FREE? rows this badge asserted a price the catalogue does
    // not contain -- and "FREE?" reads as "probably free", the reassuring half
    // of a cost decision. Blank is what "we hold no price for this" looks like.
    // G1 already accepts that a zero price can be meaningless and must be gated;
    // it gates on modality, and this is the missing half.
    //
    // BEFORE the cadence branches, deliberately. `recurring` returns the hard
    // FREE claim, and a provider-level grant cadence says nothing about a model
    // the bundle never priced. No measured row reaches that path today (zero
    // FREE in the tally), so the ordering is reasoned rather than observed -- it
    // is the branch that would make the defect worse the first time a profile
    // gains a recurring cadence.
    //
    // WHAT THIS BLANK DOES NOT CLAIM. `hasPricedOffer` false is EVIDENCE the
    // price is absent, not proof of it: a genuinely free routing mode carries no
    // non-zero offer to contrast against, so it looks identical to missing data.
    // MEASURED 2026-09-07: `kilo/auto`, `llmgateway/auto` and `orcarouter/auto`
    // each carry one 0/0 offer and are blanked here, and the record does not say
    // which of them are free of charge and which are simply unpriced
    // (`morph/auto` shows the same shape can be genuinely priced, 0.85/1.55).
    // Blank means "we are not telling you this is free", which is honest in both
    // cases; it does not mean "this is not free". Telling them apart needs
    // row-type information the entry does not carry -- #75, not this guard.
    //
    // THE FREE-TAILED EXCEPTION. G2 blanks a `0/0` because the catalogue holds
    // no non-zero offer to prove that zero is a fact rather than a hole. A
    // free-tailed id is exactly the contrast G2 is missing, sourced from the
    // provider's own listing instead of from the bundle -- so it resolves the
    // ambiguity G2 exists to refuse to guess at, and it does so without
    // weakening G2 for any row that lacks the tail. MEASURED 2026-09-09: 61 of
    // the 169 free-tailed rows reach this line (opencode 20, openrouter 18,
    // kilo 16, aihubmix 4, zenmux 3).
    //
    // "FREE?" and never "FREE": the tail is a naming convention, and the `?`
    // is what this badge set already uses for a zero price whose grant terms
    // are unconfirmed. A hard FREE still requires a curated recurring cadence.
    if (!hasPricedOffer(entry)) return isFreeSuffixed(id) ? "FREE?" : "";   // G2
    if (cadence === "recurring") return "FREE";
    if (cadence === "one-time" || cadence === "none") return "";
    return "FREE?";
  }
  return "PAID";
}

// 8 of 47 provider profiles record breakage in their hand-written notes.
const BROKEN = /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;
export const healthOf = (p) =>
  BROKEN.test(String(p?.notes ?? "")) ? "broken" : p?.requiresBalance ? "needs $" : "ok";

/**
 * Which `provider/model` strings CCR can resolve right now.
 *
 * Changes from the spike version, all of them Q1.3, Q7.2 and Q4.1:
 *   - the RPC itself now lives in ccr-client.mjs, so this file names no CCR path;
 *   - the timeout drops from 8000 ms to 400 ms;
 *   - THE PICKER NEVER CALLS THIS. Its one caller is `menu/snapshot.mjs:main()`,
 *     the `--build` path, which has an event loop, no latency budget, and a
 *     reason to be talking to CCR anyway. The result is baked into snapshot.json
 *     as a per-model `routable` field with a `routableAsOf` stamp.
 *
 *     Until 2026-09-06 that sentence named a caller in a planned `refresh/`
 *     module which was never built -- see plans/phase6-menu-and-catalogue.md:289,
 *     which lists it as "the one place routability is resolved and stamped onto
 *     the snapshot". THAT IS WHY THE WIRE STAYED MISSING FOR SO LONG. For the
 *     whole life of this file the only caller of routableSet was its own test,
 *     and every model in the built snapshot carried no `routable` property at
 *     all -- but a reader auditing the function met a confident claim about a
 *     caller instead of an absence, twice through design review. A comment that
 *     names a module nobody wrote is not a documentation defect; it is the
 *     defect, and it is why this file's comments may no longer name a module
 *     path that does not exist.
 *
 * The previous draft had the picker call this and redraw in a `.then()`. That
 * cannot work and the reason is structural rather than a bug: uwpick's input loop
 * is `for (;;) { readSync(CONIN, ...) }`, a blocking libuv call on the main
 * thread with no `await` in the loop body. The JS stack never unwinds, so the
 * event loop is never re-entered and the microtask queue never drains. The
 * `.then()` callback was unreachable for the entire life of the process, which
 * exits from inside `finish()`. The column would have rendered empty in every
 * session, and no unit test would have caught it, because a unit test has an
 * event loop. Q7.2 states this constraint; the old Q1.3 assumed its opposite.
 *
 * There is deliberately no cache file. A cache existed to answer "what if the
 * gateway is slow"; the refresher can simply wait, and a row it could not resolve
 * carries `routable: null`, which renders undimmed. Undimmed-because-unknown and
 * undimmed-because-routable look the same, which is why `routableAsOf` is printed
 * in the header rather than left implicit.
 */
export async function routableSet({ timeoutMs = 400, rpc = CCR.rpc } = {}) {
  const cfg = await rpc("getConfig", [], { timeoutMs });
  if (!cfg) return { set: new Set(), fresh: false };
  return { set: CCR.routableFromConfig(cfg), fresh: true };
}

/**
 * Turn one routable set into the per-row predicate buildFrom injects.
 *
 * The `fresh` flag is the whole point. `false` means the gateway did not answer,
 * and the honest per-row value is then `null` -- unknown -- for every row, not
 * `false`. Reporting `false` would dim all 1,584 rows on the one occasion the
 * gateway is down, telling the user that nothing works when in fact nothing was
 * checked. Constraint: `null` renders undimmed (Q1.3, Principle 1).
 */
export const makeRoutableOf = (set, fresh) => (target) =>
  fresh ? set.has(target) : null;

/**
 * The three capability flags, as `true | false | null`.
 *
 * The previous form was `!!caps.toolCalling`, and `!!undefined === false`: a model
 * whose catalogue entry simply does not carry the key rendered identically to one
 * the catalogue measured as lacking it. That is the same coercion Principle 1
 * already forbids for `routable` (makeRoutableOf) and for `free` -- unknown is a
 * third value, never a coerced false -- applied to the one place it had been
 * missed. MEASURED: of the 45 picker rows with a catalogue entry, `reasoning` is
 * true on 24, false on 12 and ABSENT on 9 (report 18 §9.2); all 9 claimed a
 * measured "no".
 *
 * `?? null`, never `|| null`: `false || null === null` would send a known-false
 * capability back to unknown, which is the original bug wearing a different
 * operator.
 */
export function capsOf(entry) {
  const c = entry?.capabilities ?? {};
  return { tools: c.toolCalling ?? null, vision: c.imageInput ?? null,
           reason: c.reasoning ?? null };
}

// ------------------------------------------------------------- modes (#75)
//
// The catalogue carries rows that are NOT models, and every consumer reads them
// as models. `auto` exists under 8 providers with a 62x context spread -- morph
// at 32,000, kilo at 2,000,000 -- and that spread is not a disagreement about
// one model: each row describes THAT PROVIDER'S OWN POOL, so `ctx` is a property
// of a routing policy rather than of anything that answers. `search` appears
// under 16 providers with `ctx: null` -- DuckDuckGo, Exa, Firecrawl -- which are
// services, not chat models.
//
// NO HAND-MAINTAINED NAME LIST. A literal ["auto", "search", ...] goes stale the
// first time a provider invents a name, and a label that cannot be kept fresh is
// exactly what [[uwpick-shows-latest-functional-state]] forbids.
//
// THE DOCTRINE IS keysync's OWN: POSITIVE SIGNALS ONLY. Wrongly calling a real
// model a mode blanks its window and its three capability flags -- the same
// confident-wrong defect this fixes, aimed the other way -- so neither rule below
// may fire on a row that is merely ambiguous. Both were measured against the live
// catalogue (4,298 entries) before being written, and the measurement is what
// chose their exact form; see the counts on each.

// SIGNAL 1 of 2 -- the provider's own capability token, and the DURABLE one.
//
// ROUTING WORDS ONLY. A token naming routing says "this row selects among
// models", which is definitionally not a model, and no provider uses those words
// for a chat model.
//
// `web_search` IS DELIBERATELY ABSENT, and leaving it out is the point rather
// than an omission. keysync's capability vocabulary already reasons that
// `web_search` is a capability FLAG -- perplexity's chat models declare it and
// they really are models -- so admitting it here would demote a whole vendor's
// catalogue to modes. A mode token is by construction outside BOTH of keysync's
// lists (`auto` and `router` are no-signal there), so the two vocabularies are
// disjoint and cannot reach opposite verdicts about one row.
const CAPABILITY_MODE = new Set(["auto", "auto_router", "model_router", "router", "routing"]);

// Normalised exactly as `keysync.capabilityKind` normalises, deliberately: the
// same raw field feeds both, so a spelling one folds and the other does not is a
// row the two classify differently. keysync exports the classifier, not the
// normaliser, which is why the rule is restated rather than imported.
export function isModeCapability(capability) {
  if (typeof capability !== "string" || !capability) return false;
  return CAPABILITY_MODE.has(capability.trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

/**
 * SIGNAL 2 of 2 -- the non-LLM service shape, available today from the bundle.
 *
 * Every clause is a POSITIVE DECLARATION, and that is what separates this from
 * the version measurement rejected. An entry that declares text output, declares
 * a populated capability record in which it can do NONE of them, holds no context
 * window and carries no per-token price is stating that it is not a language
 * model. `search` is exactly that shape: 13 capability keys, all false.
 *
 * WHY `Array.isArray(out) && out.includes("text")` RATHER THAN `isTextOut`.
 * `isTextOut` answers true for an ABSENT modality list, which is the right
 * reading for a price guard and the wrong one here: absence of facts is not
 * evidence of being a service. MEASURED -- the loose form matched 161 live rows
 * against 16 real `search` rows, sweeping in `qwen2.5-72b-instruct-turbo` and the
 * whole `nova-*` transcription family; this file's own fixture carries the same
 * collision, where `blank-a` and `acme-legacy-1` record nothing at all and must
 * stay UNKNOWN rather than be called services.
 *
 * A NON-EMPTY capability record, for the same reason: `{}` declares nothing,
 * while thirteen explicit falses declare something.
 *
 * THE FALSE-POSITIVE THE FIRST MEASUREMENT MISSED, found in review. The
 * "thirteen explicit falses declare something" argument is only as good as what
 * the thirteen keys actually cover, and they are a MODALITY schema
 * (audio/image/video/embedding/rerank/etc.) that never asks about
 * text-completion at all. `openai/gpt-41-copilot` -- a real, live, routable chat
 * model -- reports all thirteen false for the same reason `duckduckgo/search`
 * does: neither one does audio, image, video, embedding or rerank. That is not
 * evidence either way about whether the row itself is a chat model; the
 * modality schema is silent on the one axis this classifier needs.
 *
 * THE FIX: the bundle separately carries LiteLLM's own `mode` field --
 * `"chat"`/`"completion"`/`"responses"` for a real text-generation model,
 * `"search"`/`"ocr"`/`"image_edit"`/`"embedding"`/etc. for everything this
 * signal is meant to catch. MEASURED 2026-09-08 (this correction): of the 65
 * entries the shape alone flags, exactly 3 carry a chat-capable `mode`
 * (`gpt-41-copilot`: `"completion"`; `azure/container` and `openai/container`:
 * `"chat"`) -- confirmed false positives, since a source that itself
 * distinguishes "search" from "chat" is authoritative on which this is. Trust
 * it when present: it is provider/source-supplied and orthogonal to the
 * modality-shape guess, which is exactly what a positive signal must be. The
 * other 62 carry no chat-capable `mode` (`search`, `ocr`, `image_edit`,
 * `video_generation`, `guardrail`, `vector_store`, or no `mode` at all), so this
 * guard changes nothing about them. Of those 62, **60 are mode-confirmed**
 * non-chat services; the remaining 2 (`fireworks-ai/fireworks-ai-default`,
 * `unknown/fallback-generalizations`) carry no `mode` field at all and rest on
 * the shape heuristic alone -- neither is a chosen provider, so this is a real
 * but currently inert gap, named rather than silently rounded into "62 confirmed".
 *
 * MEASURED 2026-09-08: 65 of 4,298 live entries match the shape below; with the
 * `mode` guard, 62 remain classified as services -- 16 `search`, the mistral OCR
 * family, the stability image operations, sora/runway video, `amazon/guardrails`
 * -- and the 3 confirmed false positives above are excluded.
 */
const CHAT_CAPABLE_MODE = new Set(["chat", "completion", "responses"]);
export function isServiceEntry(entry) {
  if (!entry) return false;
  if (CHAT_CAPABLE_MODE.has(entry.mode)) return false;
  const out = entry.modalities?.output;
  if (!Array.isArray(out) || !out.includes("text")) return false;
  if ((entry.limits?.contextTokens ?? null) !== null) return false;
  if (hasPricedOffer(entry)) return false;
  const caps = Object.values(entry.capabilities ?? {});
  return caps.length > 0 && caps.every((v) => v === false);
}

/**
 * Is this row a routing mode or a non-LLM service rather than a model?
 *
 * THE THIRD SIGNAL THE PLAN PROPOSED IS NOT HERE, AND ITS ABSENCE IS A
 * MEASUREMENT RESULT, not an oversight. "A modality union across a pool -- an
 * entry declaring more output modalities than any single model serves" was
 * implemented literally (an entry whose input+output modality set is a strict
 * superset of every other entry at the same provider) and swept across all 44
 * providers: 46 hits, of which 2 are modes. The other 44 are ordinary flagship
 * models that happen to be the most multimodal thing their provider sells --
 * `deepseek/deepseek-v3.2`, `cerebras/gemma-4-31b`, `google/gemini-2.5-pro`,
 * `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`. Being the broadest model at a
 * provider is what a flagship looks like, not what a router looks like. Shipping
 * it would have blanked the window and capability flags of 44 real models, so it
 * is refuted rather than deferred.
 *
 * THE COST OF LEAVING IT OUT, stated plainly: `kilo/auto` and `openrouter/auto`
 * carry no capability token until discovery is wired against those two providers,
 * so until then they classify only through signal 1 and their 2,000,000 pool
 * window still reads as a model window. That is a known, bounded gap on two rows
 * -- strictly smaller than mislabelling 44 models to close it.
 */
export function modeOf(entry, capability = null) {
  return isModeCapability(capability) || isServiceEntry(entry);
}

// What a mode row carries in place of the three capability flags. NOT
// `capsOf(entry)`: a pool's flags describe whatever the router picks, and `kilo`
// declaring `reasoning: true` about its pool would reach `bucketFor` as
// `reason: true` and promote the row to the capable target on no evidence about
// any model that answers.
const MODE_CAPS = { tools: null, vision: null, reason: null };

const FREEISH = new Set(["FREE", "FREE?"]);

/**
 * The provenance ladder, and the one rung this file may not write.
 *
 * `config-asserted` is what a value in OUR OWN configuration is worth. The vault
 * profile's `testModel` and the relay's four Anthropic ids are rows because a
 * config literal says they are, and nothing ever re-probes them.
 *
 * THEY ARE NOT `call-verified`, and that is a correction rather than a preference
 * (#59, decisions §4.1). That rung is defined as "a real completion returned 200",
 * and no producer for it exists on this branch. Assigning it from a literal would
 * put the TOP of the ladder on a string somebody typed months ago, dated by
 * nothing -- and §2.4 is explicit that disclosure can carry a stale-but-dated
 * label and cannot carry an undated one claiming to be dated. So this file emits
 * `config-asserted` and never the string `call-verified`.
 *
 * The other two rungs -- `listing-verified` and `catalogue-only` -- are the
 * CALLER'S to assign, which is why they arrive through `provenanceOf` rather than
 * being decided here. Only the caller knows which listing was read, and when.
 */
const CONFIG_ASSERTED = "config-asserted";

/**
 * @param {object}   i
 * @param {Array}    i.chosen      one credential per provider
 * @param {Map}      i.providers   provider name -> profile
 * @param {object}   i.catalog     {byProvider: Map, generatedAt: string}
 * @param {object}  [i.relay]      {provider, models[]} injected, not a vault credential
 * @param {Function}[i.cadenceOf]  provider name -> {cadence?, planCovered?}
 * @param {object}  [i.discovery]  {byProvider: Map|object} of the provider's OWN
 *                  listing, keyed by provider name. Defaulted empty, and the
 *                  default is inert: with no listing every candidate still
 *                  comes from the bundle and no row moves.
 *
 *                  EACH VALUE IS NORMALISED THROUGH `K.discoveryIndex`, NOT READ
 *                  DIRECTLY, because R10's real cache record is
 *                  `{outcome, models: [...], at}` for a provider that answered
 *                  and something else entirely for one that didn't -- a bare
 *                  array is only what a caller assembling a fixture by hand is
 *                  likely to reach for. `discoveryIndex` already accepts both
 *                  shapes (keysync.mjs's own `buildProviders` reads the same
 *                  cache through it), so this file shares that one owner rather
 *                  than re-deciding what "a listing" looks like a second time.
 *
 *                  Each projected model is `{id, capabilityRaw, ...}`
 *                  (`refresh/discover.mjs:492-497`'s `projectModel` output) --
 *                  `id`, never `model`; the field name matters here because
 *                  `catalog` entries use `model` and it is easy to reach for the
 *                  wrong one when both shapes are in scope at once.
 * @param {Function}[i.provenanceOf] (provider, id) -> rung | null. Defaulted
 *                  `() => null`, mirroring `routableOf`/`makeRoutableOf` because
 *                  that is the pattern this file already uses for a
 *                  refresher-resolved value injected into a pure builder. A pure
 *                  predicate the caller owns -- buildFrom does not load discovery
 *                  data itself and must not learn how.
 */
export function buildFrom({ chosen, providers, catalog, relay,
                            cadenceOf = () => ({}),
                            routableOf = () => null,
                            discovery = { byProvider: new Map() },
                            provenanceOf = () => null }) {
  const rows = [];
  // LAZY, and built at most once per call -- keysync.mjs's own `buildProviders`
  // uses the identical pattern (`joinIndex`, keysync.mjs:976-977) for the exact
  // same reason: it is a full pass over the bundle, which a run with no
  // discovery has no use for, and every such run must stay exactly as cheap as
  // it was before this join existed.
  let joinIdx = null;
  const joinIndex = () => (joinIdx ??= buildJoinIndex(catalog));
  // ONE NORMALISATION, SHARED WITH keysync.mjs's ROUTING LANE. `discoveryIndex`
  // accepts a bare array OR the real `{outcome, models, at}` cache record per
  // provider and returns `provider -> [{id, capabilityRaw, ...}]` either way,
  // filtered to entries with a real string `id`. Reading `discovery.byProvider`
  // directly (a bare `.get(provider) ?? []`) is what the pre-review draft did,
  // and it silently produced zero candidates against R10's real cache shape --
  // untested because every fixture in this file happened to already be a bare
  // array.
  const discoveredByProvider = K.discoveryIndex(discovery?.byProvider ?? discovery);

  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const opts = { ...(cadenceOf(cred.provider) ?? {}), providerName: cred.provider };
    const entries = catalog.byProvider.get(cred.provider) ?? [];
    const listed = discoveredByProvider.get(cred.provider) ?? [];
    // RESOLVED BEFORE ADMISSION, not inside SITE 2's loop (F9/F10). A live id
    // that spells the same model cosmetically differently from the bundle joins
    // to a real bundle entry via `joinCatalogEntry` -- its CANONICAL identity is
    // that bundle entry's own spelling, not the spelling the listing happened to
    // use. Resolving this up front, before SITE 1 and SITE 2 run, is what lets
    // both sites agree on "how many real candidates are there" and "which row
    // does this listing's capability belong to" without a special case in
    // either loop.
    const canonicalOf = new Map();   // live id -> canonical id (bundle spelling, else itself)
    const joinedEntryOf = new Map(); // live id -> joined bundle entry, or null
    for (const e of listed) {
      const joined = joinCatalogEntry(joinIndex(), cred.provider, e.id);
      joinedEntryOf.set(e.id, joined);
      canonicalOf.set(e.id, joined ? joined.model : e.id);
    }
    // The listing entry for an id, so a bundle row can be overridden by what the
    // provider says about it TODAY without a second cross-provider match. Keyed
    // by the CANONICAL id, so a bundle-spelled SITE 1 row can see a live
    // capability override spelled differently from its own bundle entry (F10) --
    // without this, `nvidia/bge-m3`'s OQ-3 demotion silently stops firing for
    // exactly the population this join exists to serve.
    const listingOf = new Map();
    for (const e of listed) {
      const canon = canonicalOf.get(e.id);
      if (!listingOf.has(canon)) listingOf.set(canon, e);
    }

    // WITHHELD WITH A REASON (#51, §2.5(c)), collected from every admission site
    // rather than thrown away at each. `admitRemoteModels` returns `{kept,
    // rejected}` and this function used to destructure `kept` alone at two sites;
    // nothing in the product read a rejection, so a refused model was
    // indistinguishable from one the provider never offered.
    //
    // THE SHAPE IS R17'S, CONSUMED UNCHANGED -- `{id, reason, removed}`, with `id`
    // already display-safe because `refusal()` is the only constructor of a
    // rejection. Re-sanitising here would be a second copy of a rule that has one
    // owner, and reconstructing the shape is how the two drift (§2.5, G1/#52).
    const refused = [];
    // Every candidate is admitted EXACTLY ONCE, which is what makes the
    // complementarity property below exact rather than approximate: a raw id
    // reaching two sites (in the bundle and in the listing, or a testModel that is
    // also a catalogue row) is ONE candidate, so it must not be judged twice and
    // must not be counted twice on either side of the split.
    const seen = new Set();
    const admit = (ids) => {
      const fresh = [];
      for (const id of ids) { if (seen.has(id)) continue; seen.add(id); fresh.push(id); }
      // warn:false -- this is the DISPLAY path. buildFrom runs inside the picker,
      // which owns a full-screen frame in the alternate screen, and a console write
      // lands in the middle of one. The routing path reports the same rejections
      // with an ordinary stdout, and that is the copy that matters.
      const { kept, rejected } = admitRemoteModels(cred.provider, fresh, { warn: false });
      refused.push(...rejected);
      return new Set(kept);
    };

    const models = [];
    const added = new Set();
    // One row builder for both populations. A listing-only row has no bundle
    // entry at all, so every bundle-derived field is the honest `null` -- the same
    // reasoning the synthetic testModel row below already carries, applied to the
    // rows discovery introduces.
    // `capabilityOverride`, when passed (even `null`), is used AS GIVEN instead
    // of the internal `listingOf.get(id)` lookup. SITE 1 omits it, because its
    // `id` argument is always the bundle spelling `listingOf` is keyed by
    // (canonical identity, see above). SITE 2 always passes it explicitly,
    // because its `id` argument is the RAW live spelling for display -- the
    // string THIS provider's own listing actually calls it, not the canonical
    // bundle spelling a cross-provider join may have resolved to (F9/F10's
    // fix would otherwise display a cross-provider match under a name that
    // belongs to a DIFFERENT provider's catalogue entry).
    const rowFor = (id, entry, capabilityOverride) => {
      const p = entry ? priceOf(entry, cred.provider) : null;
      // Read ONCE, for the same reason `capability` below is: the badge and the
      // row's own `provenance` field must answer about the same rung. Two calls
      // is how they start disagreeing about one row after an edit to either.
      const provenance = provenanceOf(cred.provider, id);
      // Read ONCE and passed to both classifiers. `outputKind` and `modeOf` must
      // answer about the same evidence: a second lookup is how the pair starts
      // disagreeing about one row after an edit to either.
      const capability = capabilityOverride !== undefined
        ? capabilityOverride
        : (listingOf.get(id)?.capabilityRaw ?? null);
      const mode = modeOf(entry, capability);
      return {
        id,
        // POOL PROPERTIES ARE NOT MODEL FACTS (#75). A router's window belongs to
        // its pool, so on a mode row `ctx` is nulled rather than carried -- and
        // `null` is load-bearing at the far end: `bucketFor` reads
        // `contextTokens` and promotes anything >= CTX_CAPABLE_MIN to the capable
        // target, so `kilo/auto`'s 2,000,000 would otherwise buy a capable
        // classification with evidence about no model at all.
        //
        // WHY NULL AND NOT A SENTINEL. "Unknown" and "not a model value" really
        // are different claims, and the difference is carried by the `mode` flag
        // below rather than by inventing a third kind of value in a field every
        // existing consumer already reads as `number | null`. A consumer that has
        // not learned about modes reads `null` and renders unknown -- honest, and
        // the safe direction to be wrong in.
        ctx: mode ? null : (entry?.limits?.contextTokens ?? null),
        // PRICE SURVIVES, and it is the one property that does. It is what the
        // user is actually billed for selecting this row, not a property of the
        // pool -- `morph/auto` really costs 0.85/1.55, and a free auto mode keeps
        // whatever badge `badgeOf` already gives it.
        pin: p ? p.in : null, pout: p ? p.out : null,
        // ALWAYS `badgeOf`, including when there is no catalogue entry. The
        // caller used to short-circuit a null entry to PLAN-or-blank, which was
        // the same answer `badgeOf(null, ...)` already gives -- but it also meant
        // a rule keyed on the ID rather than the entry could never see the rows
        // that have no entry, and those are the majority of the free-tailed ones.
        // `provenance` is hoisted above this object (not read twice) because the
        // badge now depends on it: a free-tailed id is only honoured on the
        // no-price path when the provider itself vouched for the id.
        badge: badgeOf(entry, { ...opts, id, provenance }),
        ...(mode ? MODE_CAPS : capsOf(entry)),
        // `outputKind`, not `kind`. pick-state.mjs already spends `item.kind` on
        // "model" | "provider" | "pinned", so `item.model.kind` would put two
        // unrelated vocabularies into one expression -- and `routable` sits right
        // beside this as a second per-model status field. keysync's own picker row
        // carries the same value under the bare name `kind`, where nothing competes
        // for it.
        //
        // The second argument is the live override (R11's precedence, applied on
        // the menu path too so the two lanes cannot disagree about whether a row is
        // a chat model): a listing that says `embedding` demotes a row the bundle
        // declares `output: ["text"]`, which is the `nvidia/bge-m3` shape OQ-3
        // records as the measured miss.
        //
        // NULL ON A MODE, never "nontext". `null` is the value that keeps the row
        // SELECTABLE: keysync records that a "nontext" verdict makes a row
        // unselectable and silently deletes its pin from recents and favourites
        // at initState. A mode is a legitimate thing to select and must never be
        // pruned or made unpickable ([[responding-provider-never-pruned]]) --
        // this changes how the row is DESCRIBED, never whether it exists.
        outputKind: mode ? null : K.outputKind(entry, capability),
        // The explicit marker. ALWAYS PRESENT, never a missing key, for the same
        // reason `refused` is: `false` is a definite "this is a model" and
        // `undefined` is a build that did not compute it.
        mode,
        // Q1.3: a value, not a promise. null means nobody checked and does not dim.
        routable: routableOf(`${cred.provider}/${id}`),
        provenance,
      };
    };

    // SITE 1 -- the bundle.
    const keptCatalog = admit(entries.map((e) => e.model));
    for (const e of entries) {
      if (!keptCatalog.has(e.model) || added.has(e.model)) continue;
      added.add(e.model);
      models.push(rowFor(e.model, e));
    }

    // SITE 2 -- the provider's own listing. A model named ONLY here still becomes a
    // row today, and without this union it never would: that population is exactly
    // what `listing-verified` labels, so a task that added the label without
    // widening the candidate set would have labelled an empty set.
    //
    // JOINED, not `null` by construction. A live id that spells the same model
    // cosmetically differently from the bundle (`.` vs `-`, a `models/` prefix, a
    // `[…]` context suffix — D3 §1's five rungs) must still pick up `contextTokens`
    // and `capabilities` from the bundle row it really is, exactly as
    // `keysync.mjs:buildProviders`'s own discovery-extras loop already does via
    // the SAME `joinCatalogEntry(joinIndex(), provider, id)` call
    // (keysync.mjs:1073) — the two lanes read one join, so they cannot reach
    // different verdicts about one row. A genuine miss still yields `null`, never
    // a guess (D3 §4.2): `rowFor` already treats a `null` entry as the honest
    // "no bundle facts" case.
    //
    // IDENTITY AND ADMISSIBILITY ANSWER DIFFERENT QUESTIONS, AND MUST READ
    // DIFFERENT STRINGS (F9/F10/F11). Identity ("is this the same real
    // candidate as one already accounted for") is the CANONICAL id, per SITE
    // 1's fix above. Admissibility ("is this specific string safe to display
    // and use as a routing selector") MUST be judged on the RAW live id, never
    // the canonical one -- `e.id` is what actually reaches `models[]` and
    // becomes `routableOf(\`${provider}/${id}\`)`, the string uwpick emits as
    // `/model provider/id`. Gating on canonical instead (an earlier version of
    // this fix) let a hostile raw id launder past the check whenever it
    // happened to join to a clean bundle entry -- rung 5's shape-stripping
    // (`keysync/catalog-join.mjs:82-86`) strips exactly the kind of trailing
    // `[…]` suffix an escape-sequence injection hides in, so `other/shared-
    // model[\x1b2J]` joins to the clean `shared-model`, would be ADMITTED under
    // that clean canonical string, and then DISPLAYED under its own raw,
    // unchecked one -- reopening #52 on the one path R17 closed it for
    // (`menu/denylist.mjs:158-165`'s guarantee holds only while the displayed
    // value comes from `kept`, which this reintroduced.
    //
    // `added.has(canon)` is checked FRESH per entry, before any admission
    // attempt, and updated immediately after a successful one -- so a second
    // live spelling of a candidate this SAME loop just added is skipped before
    // it is ever gated, and a same-provider cosmetic match against a SITE-1 row
    // is skipped the same way (F8, still holding). Only a genuinely new
    // candidate reaches `admit`, and it is gated on exactly the text that will
    // be shown.
    for (const e of listed) {
      const canon = canonicalOf.get(e.id);
      // NOTED, NOT FIXED (F12, low): a hostile raw id whose canonical already
      // has a row is dropped here silently -- no row, no `refused[]` entry.
      // Safe (it never reaches a display or a selector, and `seen` never
      // learns of it, so complementarity is untouched), but it is a disclosure
      // asymmetry against the cross-provider case just below, which DOES land
      // in `refused[]` with its reason. Left as a known, accepted gap rather
      // than a silent one.
      if (added.has(canon)) continue;
      const kept = admit([e.id]);
      if (!kept.has(e.id)) continue;
      added.add(canon);
      // DISPLAYED UNDER THE RAW LIVE SPELLING, not the canonical one -- `e.id`
      // is the selector THIS provider's own listing actually accepts. A
      // cross-provider join's bundle spelling belongs to a DIFFERENT
      // provider's row and must not be borrowed as this one's own display id.
      models.push(rowFor(e.id, joinedEntryOf.get(e.id), e.capabilityRaw ?? null));
    }

    // SITE 3 -- the vault's configured testModel. It leads: measured,
    // catalogue-first dropped the live pass rate to 4/44. Guarded for the same
    // reason as the routing path: an absent testModel is ordinary configuration,
    // not a rejected advertisement. `admit` returns empty when the id was already
    // judged at site 1 or 2, which is the same "already a row, do not duplicate"
    // outcome the old `!models.some(...)` guard produced.
    const keptTm = prof.testModel ? admit([prof.testModel]) : new Set();
    const tm = keptTm.has(prof.testModel) ? prof.testModel : null;
    if (tm && !added.has(tm)) {
      added.add(tm);
      // null, not false. This row exists BECAUSE the catalogue has no entry for the
      // model -- site 1 never produced it -- so `false` is a claim about a
      // measurement that was never taken. 38 of the 83 routable rows reach the
      // picker this way, which made it the largest single source of the coercion
      // capsOf removes.
      models.unshift({ id: tm, ctx: null, pin: null, pout: null,
                       // Same call as site 2's, for the same reason: this row has
                       // no catalogue entry, so an id-keyed rule is the only one
                       // that can reach it. `badgeOf(null, ...)` returns exactly
                       // the PLAN-or-blank this line used to compute itself.
                       // `provenance` matches the field this same object sets
                       // below: a testModel is a config literal, so a free tail
                       // on one is vouched for by our own vault config.
                       badge: badgeOf(null, { ...opts, id: tm, provenance: CONFIG_ASSERTED }),
                       tools: null, vision: null, reason: null, outputKind: null,
                       // A configured testModel is the model this vault probes
                       // with, so it is a model by construction. It also cannot
                       // reach either signal: with no catalogue entry there is no
                       // service shape to read, and an id the listing named would
                       // have become a row at site 2 rather than here.
                       mode: false,
                       routable: routableOf(`${cred.provider}/${tm}`),
                       // A config literal, not a probe. See CONFIG_ASSERTED.
                       provenance: CONFIG_ASSERTED });
    }
    const priced = models.some((m) => m.badge !== "");
    rows.push({
      keyId: sanitizeDisplay(cred.id, 30), provider: cred.provider, models,
      // NULLABLE: "0 free" is a measurement, "no price data" is the absence of one.
      free: priced ? models.filter((m) => FREEISH.has(m.badge)).length : null,
      planCount: models.filter((m) => m.badge === "PLAN").length,
      health: healthOf(prof),
      // ALWAYS AN ARRAY, never a missing key: absent and empty are different
      // claims, and a consumer that has to tell "withheld nothing" from "this
      // build did not compute it" cannot do so from `undefined`. The count cell
      // in §2.5(a) renders blank on `[]` -- that is the consumer's rule, not a
      // reason to omit the field.
      //
      // COMPLEMENTARITY: `models.length + refused.length === seen.size`. Every
      // candidate ends up in exactly one of the two, never both and never
      // neither, which is the property that makes the withheld count meaningful.
      refused,
    });
  }

  // The relay is NOT a vault credential -- registry.json has no `anthropic` row.
  // keysync injects it separately, so building from the vault alone silently drops
  // the four Claude models, which are the ones most likely to be routable.
  if (relay && !rows.some((r) => r.provider === relay.provider)) {
    // The only all-true capability set left in this file, and it survives the audit
    // capsOf triggered for a reason the catalogue cannot supply: these are the four
    // Anthropic subscription models, whose tool use, vision and reasoning are known
    // first-hand from ANTHROPIC_FULL rather than looked up. Every other all-true or
    // all-false literal here was a coercion; this one is a measurement.
    const models = (relay.models ?? []).map((id) => ({
      id, ctx: null, pin: null, pout: null, badge: "PLAN",
      tools: true, vision: true, reason: true, outputKind: "text",
      // The four Claude models are models, known first-hand from ANTHROPIC_RELAY
      // in the same way the capability set beside this is known. The relay reads
      // no catalogue entry and no listing, so neither signal can speak here.
      mode: false,
      routable: routableOf(`${relay.provider}/${id}`),
      // The capability set beside this is a MEASUREMENT and the provenance is
      // not: these four ids are in the list because ANTHROPIC_RELAY names them,
      // and nothing re-probes that. `config-asserted`, never `call-verified`
      // (#59) -- the distinction is exactly that one of these is first-hand
      // knowledge about the models and the other is a config literal about the
      // list.
      provenance: CONFIG_ASSERTED }));
    rows.push({
      keyId: "relay.anthropic.subscription", provider: relay.provider, models,
      free: null, planCount: models.length, health: "ok",
      // The relay withholds nothing: its ids never pass through an admission
      // site. Empty, not absent, for the reason given on the vault rows above.
      refused: [],
    });
  }

  rows.sort((a, b) => b.models.length - a.models.length);
  return { rows, generatedAt: catalog.generatedAt };
}

/**
 * SYNCHRONOUS, and that is a constraint rather than an accident.
 *
 * Resolving routability means awaiting an RPC, and uwpick's input loop is a
 * blocking `readSync` with no `await` in its body -- the microtask queue never
 * drains there, so a promise on that path is unreachable by construction (see
 * routableSet's comment above, and `test/uwpick.test.mjs:119`). Keeping `build()`
 * synchronous is what keeps the fetch in the refresher, which has an event loop
 * and no latency budget. The caller resolves the set and hands in a plain
 * predicate; `routableAsOf` rides alongside `generatedAt` for the same reason it
 * is its sibling -- one stamps the catalogue, the other stamps the routing check,
 * and both belong to whoever did the work rather than to whoever reads it.
 */
export function build({ routableOf, routableAsOf = null,
                        discovery, provenanceOf } = {}) {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  return {
    // `discovery` and `provenanceOf` are FORWARDED, not resolved here, for the
    // same reason `routableOf` is: reading a listing means awaiting a refresher,
    // and this function is synchronous because uwpick's input loop is a blocking
    // `readSync` whose microtask queue never drains. Whoever already has an event
    // loop -- the refresher, or `menu/snapshot.mjs` -- resolves both and hands in
    // plain values. Passing `undefined` restores buildFrom's inert defaults, so
    // an un-updated caller keeps today's behaviour exactly.
    ...buildFrom({
      chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY, routableOf,
      discovery, provenanceOf,
    }),
    routableAsOf,
  };
}

// Both take an optional path for the same reason every function in state.mjs
// does: without one, the only way to exercise them is to write the live
// ~/.uw/state/slot.json, so they were untestable by the isolation rule and
// therefore untested. That is the defect, not a consequence of it.
export function writeSlot(target, file = SLOT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Through writeAtomic like every other state file. writeAtomic was imported here
  // and never called: a plain write truncates slot.json in place, so ctrl+c during
  // it leaves a prefix, and readSlot's catch turns that into "" -- a silently
  // forgotten model pin rather than a visible error.
  writeAtomic(file, JSON.stringify({ model: target }, null, 2));
}

export function readSlot(file = SLOT) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")).model ?? ""; } catch { return ""; }
}

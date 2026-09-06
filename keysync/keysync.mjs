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

// ---------------------------------------------------------------- vault load
const LLMKEYS = path.join(os.homedir(), ".llmkeys");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

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

export function loadCatalog() {
  const doc = readJson(CATALOG_FILE);
  const byProvider = new Map();
  for (const m of doc.models ?? []) {
    if (!m.provider || !m.model) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { generatedAt: doc.generatedAt, byProvider };
}

/** free / paid / unknown — a guess is worse than no label, so default to unknown. */
export function inferTier(entry) {
  const p = entry.pricing ?? {};
  const nums = [p.inputPerMillion, p.outputPerMillion, p.input, p.output]
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return "unknown";
  return nums.every((v) => v === 0) ? "free" : "paid";
}

/**
 * text / nontext / null, from the catalogue's own `modalities.output`.
 *
 * Sits beside `inferTier` for locality -- the other entry-to-label function over
 * the catalogue -- but the rule it follows is `makeRoutableOf`'s
 * (`menu/catalog.mjs:143`), not `inferTier`'s. MEASURED 2026-09-06: `inferTier`
 * reads `pricing.inputPerMillion` while this schema stores
 * `pricing.offers[].per1MTokens`, so it yields a usable value for 0 of 4,298
 * entries and the free-first sort at :365 is a no-op (`menu/catalog.mjs:29-31`
 * documents the same, and it is OQ-5, not fixed here). A dead function is the
 * wrong exemplar for honest-unknown labelling.
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
export function outputKind(entry) {
  const out = entry?.modalities?.output;
  if (!Array.isArray(out)) return null;
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
const MAX_MODELS_PER_PROVIDER = Number(process.env.UW_MAX_MODELS ?? 3);

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
const ANTHROPIC_ALIASES = Object.freeze(["opus", "sonnet", "haiku", "fable"]);

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
 * @param {string} id                     the model id as the provider spells it
 * @param {object|null|undefined} entry   its bundled-catalogue entry, if any
 */
export function normalizeModel(id, entry) {
  return {
    id,
    tier: entry ? inferTier(entry) : "unknown",
    contextTokens: entry?.limits?.contextTokens,
    reason: entry?.capabilities?.reasoning ?? null,
    kind: outputKind(entry)
  };
}

export function buildProviders(chosen, providers, catalog, keyReader) {
  const out = [];
  const picker = [];
  const notes = [];

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

    // MEASURED 2026-09-01: preferring catalog ids over the vault's testModel
    // dropped the live pass rate to 4/44 — the bundled catalog lists models a
    // given key/tier often cannot actually call (mostly upstream 404s). The
    // vault's testModel is the probe-verified known-good id for this key, so it
    // leads; catalog entries are appended as extras.
    const models = [];
    const seen = new Set();
    if (safeTestModel) {
      // `cat` is undefined for 38 of the 83 rows — this is the no-signal case.
      const cat = safeEntries.find((m) => m.model === safeTestModel);
      models.push(normalizeModel(safeTestModel, cat));
      seen.add(safeTestModel);
    }
    if (safeEntries.length) {
      // Curate rather than dump: the picker is a flat list and 44 providers x
      // full catalogs is unusable. Prefer free-tier, then shortest id.
      const ranked = safeEntries
        .map((m) => ({ m, tier: inferTier(m) }))
        .sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
          a.m.model.length - b.m.model.length);
      // The entry is in hand by construction, so the capability signals need no
      // lookup — which is what makes cross-provider name matching structurally
      // impossible here rather than merely discouraged. `ranked`'s `tier` is
      // dropped in favour of normalizeModel recomputing it: same value from the
      // same entry, and one owner of the shape beats a second literal.
      for (const { m } of ranked) {
        if (models.length >= MAX_MODELS_PER_PROVIDER || seen.has(m.model)) continue;
        models.push(normalizeModel(m.model, m));
        seen.add(m.model);
      }
    }
    if (!models.length) {
      notes.push(`${reg.provider}: no testModel and no catalog entry — skipped`);
      continue;
    }

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

    for (const m of models) {
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
export function validate({ providers, picker }, expectedCount) {
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

  // V1 -- the table holds vetted targets, not typos. An allowlist rather than a
  // denylist because a denylist passes `claude-sonnet-4-51` in silence, and
  // silence is the failure mode this exists to prevent.
  // V2 -- and no target may carry a model-specific prompt bundle.
  for (const [bucket, target] of Object.entries(BUCKET_TARGETS)) {
    if (!ALLOWED_BEHAVES_AS.includes(target)) {
      problems.push(`bucket "${bucket}" target "${target}" is not in ALLOWED_BEHAVES_AS ` +
        `— a vetted target, not a typo`);
    }
    if (PROMPT_BUNDLE_MODELS.test(target)) {
      problems.push(`bucket target "${target}" carries a model-specific prompt bundle ` +
        `(report 18 §10.3) and must never be inherited by a third-party model`);
    }
  }

  // V6 -- THE WHOLE TABLE SHAPE, over all four keys, not one inequality.
  // This is the canary for the failure that looks like success. `capable !== weak`
  // guards one of the three ways the table can break: pointing `unknown` or
  // `nonchat` at the capable target flips 38 or 4 rows back into over-declaration
  // with that inequality still true and every other rule green.
  if (BUCKET_TARGETS.capable === BUCKET_TARGETS.weak) {
    problems.push(`BUCKET_TARGETS.capable and .weak name the same target ` +
      `("${BUCKET_TARGETS.weak}"); the table would classify without declaring anything`);
  }
  for (const bucket of ["unknown", "nonchat"]) {
    if (BUCKET_TARGETS[bucket] !== BUCKET_TARGETS.weak) {
      problems.push(`BUCKET_TARGETS.${bucket} points at the capable target; only "capable" may`);
    }
  }

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

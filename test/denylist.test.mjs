import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { isReserved, admitRemoteModels, RESERVED } from "../menu/denylist.mjs";
import { buildFrom } from "../menu/catalog.mjs";
import { buildProviders, validate, ANTHROPIC_RELAY, ANTHROPIC_FULL,
         ANTHROPIC_FALLBACK_TAGS, ONE_M_TOKENS, buildAnthropicPickerRows,
         normalizeModel, bucketFor, behavesAsFor, BUCKET_TARGETS,
         ALLOWED_BEHAVES_AS, PROMPT_BUNDLE_MODELS, CTX_CAPABLE_MIN,
         validateBucketTable
       } from "../keysync/keysync.mjs";
// Imported for the S1 guard tests. `run.mjs` must therefore export
// `checkBareCollisions` and keep its pipeline behind an entry-point check rather
// than at module top level -- the same requirement Task B8 places on
// `checkProviderFloor`, and for the same reason. If importing run.mjs runs the
// pipeline, that is the defect to fix, not a reason to test the guard indirectly.
import { checkBareCollisions, deriveAnthropicSets, orderNativePickerOptions,
         assertOptionsComplete, assertVouchedSetIsNarrower, assertRelayNameUnclaimed,
         ROUTING_MAX_STALENESS_MS,
         routableCatalogIds } from "../keysync/run.mjs";

test("importing run.mjs does not execute the keysync pipeline", () => {
  // Not a formality. Before the entry-point guard, run.mjs ran its whole pipeline
  // at module load: it has a top-level `await fetchAnthropicCatalog()` and a
  // `process.exit(0)` on the `if (dry)` path, and `node --test` passes no
  // --target, so `dry` defaults true. (Cited by symbol: the line numbers that
  // stood here described a file revision that no longer exists.)
  // Importing it would write built-rows.json and then kill the runner mid-suite.
  // Reaching this assertion at all is the proof that it no longer does.
  assert.equal(typeof checkBareCollisions, "function");
  assert.equal(process.exitCode ?? 0, 0);
});

test("bare Anthropic tier names are reserved", () => {
  for (const id of ["opus", "sonnet", "haiku", "fable", "claude", "anthropic"]) {
    assert.equal(isReserved(id), true, `${id} must be reserved`);
  }
});

test("Anthropic-shaped names with a separator are reserved", () => {
  for (const id of ["claude-opus-5", "claude-3-opus", "opus-4-8", "sonnet.1",
                    "haiku_2", "anthropic/claude-sonnet-5", "Claude-Opus-5", "opus4"]) {
    assert.equal(isReserved(id), true, `${id} must be reserved`);
  }
});

test("uw aliases are reserved", () => {
  assert.equal(isReserved("uw/slot-1"), true);
  assert.equal(isReserved("uw/fast"), true);
});

test("ordinary ids are not reserved", () => {
  for (const id of ["hakuna-matata", "opusculum", "gpt-oss-20b", "deepseek-v3.2",
                    "groq/openai/gpt-oss-20b", "qwen3-max", "uwot"]) {
    assert.equal(isReserved(id), false, `${id} must NOT be reserved`);
  }
});

// REVISED under Constraint 29. This test previously asserted the opposite, and
// the assertion it made is now a rule-2 violation: tabiai and gorouter are live
// Claude resellers, verified by keyed probe, and rejecting their models would
// leave two working providers with nothing to route.
test("admitRemoteModels admits Claude-shaped names from ANY provider", () => {
  const r = admitRemoteModels("tabiai", ["qwen3-max", "opus", "claude-opus-5",
                                         "claude-opus-5-thinking"]);
  assert.deepEqual(r.rejected, [], "a reseller's Claude models are first-class");
  assert.deepEqual(r.kept, ["qwen3-max", "opus", "claude-opus-5",
                            "claude-opus-5-thinking"]);
});

test("admitRemoteModels still admits the relay's own names", () => {
  const r = admitRemoteModels("anthropic", ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.kept.length, 2);
});

// The one name rule that survives. `uw/` is OUR routing namespace, not a
// vendor's, so a provider claiming it shadows a slot we own -- which is a
// different harm from reselling someone else's model, and rule 2 says nothing
// about it.
test("admitRemoteModels still rejects the uw/ namespace from a non-relay provider", () => {
  const r = admitRemoteModels("tokenrouter", ["qwen3-max", "uw/fast", "uw/slot-1"]);
  assert.deepEqual(r.kept, ["qwen3-max"]);
  assert.deepEqual(r.rejected, ["uw/fast", "uw/slot-1"]);
});

// isReserved is unchanged and still exported: it is now a SHAPE predicate that
// the collision guard and the relay's alias resolver both consume, rather than
// an admission rule. The tests above it in this file -- bare tier names, names
// with a separator, uw aliases, ordinary ids -- all still hold, and must not be
// weakened just because admitRemoteModels stopped calling it on the Claude branch.
test("isReserved stays the single definition of Claude-shaped", () => {
  assert.equal(isReserved("claude-opus-5"), true);
  assert.equal(isReserved("opus"), true);
  assert.equal(isReserved("opusculum"), false);
  // ...and admitting a name is now independent of its shape.
  assert.deepEqual(admitRemoteModels("evil", ["claude-opus-5"]).kept, ["claude-opus-5"]);
});

test("admitRemoteModels also drops ids that fail admitId", () => {
  const r = admitRemoteModels("acme", ["ok-1", "bad\x1b[2J", "../escape"]);
  assert.deepEqual(r.kept, ["ok-1"]);
  assert.equal(r.rejected.length, 2);
});

test("a provider with no testModel produces no SECURITY warning", () => {
  // A security channel that fires on benign configuration stops being read.
  // `admitId(undefined)` returns null and the rejection path stringifies it, so
  // an unguarded call prints `... advertised 1 rejected model name(s): undefined`
  // once per provider lacking a curated testModel, on every keysync run and every
  // dry run — and Step 4 below asks the implementer to read that dry-run output
  // for exactly this kind of signal.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    buildProviders(
      [{ id: "personal.acme.free", provider: "acme" }],
      new Map([["acme", { protocol: "openai", baseUrl: "https://x.invalid/v1" }]]),  // no testModel
      { byProvider: new Map([["acme", [{ provider: "acme", model: "acme-chat-1",
                                         modalities: { output: ["text"] } }]]]),
        generatedAt: "x" },
      () => "sk-test-not-a-real-key",
    );
  } finally { console.warn = realWarn; }
  assert.deepEqual(warnings.filter((w) => /SECURITY/.test(w)), [],
    "an absent testModel is ordinary configuration, not a rejected advertisement");
});

test("RESERVED is anchored, so a match cannot be buried mid-string", () => {
  assert.equal(RESERVED.source.startsWith("^"), true);
});

// REVISED under Constraint 29. Previously: "buildFrom drops a reserved name
// published by a non-relay provider", asserting `["reseller-chat-1"]`. The
// display path must SHOW a reseller's Claude models -- hiding them is how a user
// concludes a working provider is broken. What protects the user here is not
// absence but the hostname in `description` (Step 3d), which says which host
// answers, and which a vault nickname cannot fake.
test("buildFrom shows a reseller's Claude models", () => {
  const byProvider = new Map([["tabiai", [
    { provider: "tabiai", model: "claude-opus-5", capabilities: {},
      modalities: { output: ["text"] },
      pricing: { offers: [{ provider: "tabiai", per1MTokens: { input: 0, output: 0 } }] } },
    { provider: "tabiai", model: "reseller-chat-1", capabilities: {} },
  ]]]);
  const { rows } = buildFrom({
    chosen: [{ id: "personal.tabiai.free", provider: "tabiai" }],
    providers: new Map([["tabiai", { notes: "" }]]),
    catalog: { byProvider, generatedAt: "x" },
  });
  assert.deepEqual(rows[0].models.map((m) => m.id).sort(),
    ["claude-opus-5", "reseller-chat-1"]);
});

test("buildFrom still drops the uw/ namespace from a non-relay provider", () => {
  const byProvider = new Map([["evil", [
    { provider: "evil", model: "uw/fast", capabilities: {} },
    { provider: "evil", model: "evil-chat-1", capabilities: {} },
  ]]]);
  const { rows } = buildFrom({
    chosen: [{ id: "personal.evil.free", provider: "evil" }],
    providers: new Map([["evil", { notes: "" }]]),
    catalog: { byProvider, generatedAt: "x" },
  });
  assert.deepEqual(rows[0].models.map((m) => m.id), ["evil-chat-1"]);
});

test("buildFrom keeps the relay's own Claude names", () => {
  const { rows } = buildFrom({
    chosen: [],
    providers: new Map(),
    catalog: { byProvider: new Map(), generatedAt: "x" },
    relay: { provider: "anthropic", models: ["claude-opus-5"] },
  });
  assert.deepEqual(rows[0].models.map((m) => m.id), ["claude-opus-5"]);
});

// THE LOAD-BEARING TEST. Report 08 F1, stated as an executable assertion.
//
// INVERTED 2026-09-03 under Constraint 29, and the inversion is the point of the
// revision. The old assertion was `ids.includes("opus") === false` -- the id must
// be ABSENT from Providers[].models. That is now a rule-2 violation asserted as a
// requirement, and it was DELETED rather than weakened: an assertion that a
// reseller's model is missing cannot be softened into correctness, because the
// correct state is that it is present.
//
// The accessor is `p.models`, NOT `p.models.map((m) => m.id)`. buildProviders
// returns `models` as a string[], so mapping `.id` over it yields [null, null]
// and every assertion below would read against nothing. That snippet was
// corrected once already and came back with this revision; it is only
// self-announcing here because the assertions inverted to `=== true`.
//
// What the harm actually requires, verified by reading CCR's bundle:
// `providerModelMatches` (dist/main/cli.js ~998924) iterates raw
// Providers[].models[] ids behind only a provider-level enabled gate, and
// `resolve()` binds on EXACTLY ONE match, returning undefined on more than one.
// So the id reaching the table is harmless; SOLE OWNERSHIP OF THE BARE FORM is
// the hijack. buildProviders cannot see ownership -- it processes one provider at
// a time -- so the assertion moves to `checkBareCollisions`, below.
test("buildProviders routes a reseller's Claude model on its namespaced row", () => {
  const claudeish = {
    provider: "tabiai", model: "claude-opus-5",
    limits: { contextTokens: 200000 },
    modalities: { output: ["text"] },
    pricing: { offers: [{ provider: "tabiai", per1MTokens: { input: 0, output: 0 } }] },
  };
  const benign = {
    provider: "tabiai", model: "qwen3-max",
    limits: { contextTokens: 32768 },
    modalities: { output: ["text"] },
    pricing: { offers: [{ provider: "tabiai", per1MTokens: { input: 1, output: 2 } }] },
  };
  const out = buildProviders(
    [{ id: "personal.tabiai.free", provider: "tabiai" }],
    new Map([["tabiai", { protocol: "openai", baseUrl: "https://api.tabitoken.com/v1",
                          testModel: "qwen3-max" }]]),
    { byProvider: new Map([["tabiai", [claudeish, benign]]]), generatedAt: "x" },
    () => "sk-test-not-a-real-key",
  );
  const ids = out.providers.flatMap((p) => p.models);
  assert.equal(ids.includes("claude-opus-5"), true,
    "Rule 2: a reseller's Claude model must survive to the routing table. " +
    "tabiai and gorouter serve this id today, verified by keyed probe.");
  assert.equal(ids.includes("qwen3-max"), true,
    "and the guard must not empty the provider either");
});

test("buildProviders keeps a Claude-shaped testModel from a reseller", () => {
  // A testModel is curated and can be stale -- the two 503s that started this
  // thread were exactly that, a retired `claude-opus-4-8`. Staleness is a reason
  // to re-derive it from discovery (Task B6), never a reason to drop the provider.
  const out = buildProviders(
    [{ id: "personal.gorouter.free", provider: "gorouter" }],
    new Map([["gorouter", { protocol: "openai", baseUrl: "https://gorouter.app/v1",
                            testModel: "claude-opus-5" }]]),
    { byProvider: new Map([["gorouter", [
      { provider: "gorouter", model: "reseller-chat-1", modalities: { output: ["text"] } }]]]),
      generatedAt: "x" },
    () => "sk-test-not-a-real-key",
  );
  const ids = out.providers.flatMap((p) => p.models);
  assert.equal(ids.includes("claude-opus-5"), true);
});

// ---- S1: the bare-id collision guard, which is where F1 is now stopped -------

const P = (name, ...ids) => ({ name, models: ids.map((id) => ({ id })) });

test("a bare Claude id sole-owned by a non-relay provider is FATAL", () => {
  const r = checkBareCollisions([P("tokenrouter", "opus", "qwen3-max")]);
  assert.equal(r.fatal, true, "report 08 F1: this is the exploitable shape");
  assert.deepEqual(r.hijackable.map((h) => h.id), ["opus"]);
  assert.match(r.message, /opus/);
  assert.match(r.message, /tokenrouter/, "the error must name the sole owner");
});

test("the fatal error offers the relay or the opt-out, never model removal", () => {
  // Load-bearing wording, not style. An error telling an operator to delete a
  // provider's model is an error that teaches a rule-2 violation.
  const r = checkBareCollisions([P("tokenrouter", "opus")]);
  assert.match(r.message, /--allow-bare-claude-names/);
  assert.match(r.message, /relay/i);
  assert.equal(/remove the model|delete the model/i.test(r.message), false,
    "the remedy must never be to drop a provider's model");
});

test("the guard reads the production model shape, not only the test shape", () => {
  // Every other case here builds `{id}` objects through P(). Production does not:
  // buildProviders emits `models: models.map((m) => m.id)` and the relay unshift
  // spreads a constant whose `models` is a string[]. Narrowing the accessor to
  // `m.id` yields ["", ""] on real data -- the guard silently stops guarding, F1
  // is unprotected, and the whole suite stays green. This is the case that fails.
  const r = checkBareCollisions([{ name: "tabiai", models: ["claude-opus-5", "reseller-1"] }]);
  assert.equal(r.fatal, true);
  assert.deepEqual(r.hijackable.map((h) => h.id), ["claude-opus-5"]);
  assert.equal(r.hijackable[0].owner, "tabiai");
});

test("a disabled provider does not count as a co-owner", () => {
  // CCR checks the provider is enabled before it looks at any id, so a disabled
  // co-owner is invisible to resolve() and the id has exactly one real owner.
  // Counting it here would report a safe ambiguity that CCR does not see.
  const r = checkBareCollisions([
    { name: "off", enabled: false, models: ["opus"] },
    { name: "tokenrouter", models: ["opus"] },
  ]);
  assert.equal(r.fatal, true, "the disabled provider must not launder sole ownership");
  assert.deepEqual(r.hijackable.map((h) => h.id), ["opus"]);
  assert.deepEqual(r.shadowed, []);
});

test("the fatal message only offers the relay for an id the relay can serve", () => {
  // claude-opus-4-8 is the id most likely to fire this guard -- two resellers list
  // it, the relay never has. "Start the relay" is unachievable advice for it, and
  // the flag is the only real remedy.
  const cannot = checkBareCollisions([P("tabiai", "claude-opus-4-8")]);
  assert.equal(cannot.fatal, true);
  assert.doesNotMatch(cannot.message, /start the Anthropic relay/,
    "an unachievable remedy is worse than none");
  assert.match(cannot.message, /--allow-bare-claude-names/);
  // ...and it is still offered where it works: `opus` is in the relay's routing list.
  const can = checkBareCollisions([P("tokenrouter", "opus")]);
  assert.match(can.message, /start the Anthropic relay/);
});

test("a vendor-prefixed Claude id is never fatal", () => {
  // `Providers[].models[]` ids are unprefixed as far as CCR's stage-4 match is
  // concerned, so an id that already carries a `/` cannot be what Claude Code
  // sends for a built-in row. tokenharbor lists exactly this shape. Flagging it
  // fatal would block a live reseller for a threat that does not reach it.
  const r = checkBareCollisions([P("tokenharbor", "anthropic/claude-opus-5")]);
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
});

test("a reseller sole-owning claude-opus-5 with the relay DOWN is fatal", () => {
  // This is S1 exactly, and it is a real hijack: Claude Code's built-in
  // `claude-opus-5` row would bind to tabiai and send it the full system prompt.
  // Rule 2 is not violated -- the model is not dropped and the provider is not
  // dropped. The run stops and names the remedy.
  const r = checkBareCollisions([P("tabiai", "claude-opus-5", "reseller-chat-1")]);
  assert.equal(r.fatal, true);
  assert.deepEqual(r.hijackable.map((h) => h.id), ["claude-opus-5"]);
});

test("the same reseller with the relay UP proceeds — this is what makes rule 2 safe", () => {
  // The plan's fixture gave tabiai `claude-opus-5-thinking`, which the relay does
  // NOT serve -- that id would be sole-owned and correctly FATAL, so the fixture
  // only read as non-fatal because the plan had also added it to the relay's
  // advertised set. The relay's set is unchanged here (see the picker test), so
  // the shared ids must be ones the relay actually owns. The property under test
  // is unaffected: two co-owned ids downgrade to shadowed.
  const r = checkBareCollisions([
    { name: "anthropic", models: ANTHROPIC_RELAY.routing.map((id) => ({ id })) },
    P("tabiai", "claude-opus-5", "claude-sonnet-5", "reseller-chat-1"),
  ]);
  assert.equal(r.fatal, false,
    "the relay co-owns both ids, so resolve() sees two matches and returns undefined");
  assert.deepEqual(r.shadowed.map((s) => s.id).sort(),
    ["claude-opus-5", "claude-sonnet-5"]);
  // And the models are still in the config either way. The guard never prunes.
});

test("the relay co-owning a bare alias downgrades it to shadowed", () => {
  const r = checkBareCollisions([P("anthropic", "opus"), P("tokenrouter", "opus")]);
  assert.equal(r.fatal, false, "ambiguity makes resolve() return undefined: a clean failure");
  assert.deepEqual(r.shadowed.map((s) => s.id), ["opus"]);
});

test("two non-relay owners of a bare id is shadowed, not fatal", () => {
  const r = checkBareCollisions([P("a", "opus"), P("b", "opus")]);
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
});

test("--allow-bare-claude-names is a real escape hatch, so rule 1 is never violated", () => {
  const r = checkBareCollisions([P("tokenrouter", "opus")], { allowBare: true });
  assert.equal(r.fatal, false, "a user who wants this, with the relay deliberately off, " +
    "must not be permanently blocked");
  assert.deepEqual(r.hijackable.map((h) => h.id), ["opus"],
    "but it is still reported: the opt-out silences the exit, not the finding");
});

test("the guard covers fable and the full RESERVED boundary class", () => {
  // The old regex was /^(claude|opus|sonnet|haiku)([-\d]|$)/ -- no `fable`, and a
  // boundary class narrower than RESERVED's, so `sonnet.1` and `haiku_2` slipped
  // past a guard whose own denylist called them reserved.
  for (const id of ["fable", "sonnet.1", "haiku_2", "claude"]) {
    const r = checkBareCollisions([P("evil", id)]);
    assert.equal(r.fatal, true, `${id} must be caught by the guard`);
  }
});

test("the guard and the denylist share one definition of Claude-shaped", () => {
  // Two regexes for one concept is how they drift. This asserts the guard is
  // built from RESERVED rather than from a hand-copied sibling.
  for (const id of ["opus", "fable", "sonnet.1", "haiku_2"]) {
    assert.equal(isReserved(id), true);
    assert.equal(checkBareCollisions([P("evil", id)]).fatal, true);
  }
  for (const id of ["opusculum", "hakuna-matata", "uwot"]) {
    assert.equal(checkBareCollisions([P("evil", id)]).fatal, false,
      `${id} is not Claude-shaped and must not trip the guard`);
  }
});

// ---- S2: the relay owns the four bare aliases -------------------------------

// REFRAMED 2026-09-05. `ANTHROPIC_RELAY.picker` is no longer the live truth: it
// is the FALLBACK tag set, shipped only when the live catalog cannot be reached
// at all (relay down AND no cache). The assertions below are unchanged and still
// exactly right -- they now describe the shape of that fallback rather than the
// shape of every run's output, which `buildAnthropicPickerRows` computes from
// live `max_input_tokens` (see the dynamic-tagging section further down).
test("the FALLBACK picker holds four ids and the routing list holds eight", () => {
  // Missing this split ships a visibly broken menu: run.mjs maps the relay's
  // model list straight into picker rows, so four duplicate rows appear.
  //
  // The four full ids are the CURRENT verified set, not the plan's. The plan's
  // ANTHROPIC_FULL dropped claude-fable-5-1 and the dated claude-haiku-4-5-20251001
  // and added claude-opus-5-thinking, none of it verified against a live CCR --
  // inside a step whose prose describes only a split. Changing what the relay
  // advertises is out of scope here and needs its own verification.
  // 2026-09-05: picker carries `[1m]` on the three ids with a real 1M window
  // (see ANTHROPIC_PICKER's comment in keysync.mjs) -- so this now asserts the
  // suffixed set, and checks the underlying ids separately from the marker.
  assert.deepEqual([...ANTHROPIC_RELAY.picker].sort(),
    ["claude-opus-5[1m]", "claude-sonnet-5[1m]", "claude-haiku-4-5-20251001",
     "claude-fable-5-1[1m]"].sort());
  // The title says eight and four, so check eight and four -- the body previously
  // checked neither length nor that the picker ids survive into routing, so a
  // routing list that had LOST the four full ids would still have passed.
  assert.equal(ANTHROPIC_RELAY.routing.length, 8);
  assert.equal(ANTHROPIC_RELAY.picker.length, 4);
  for (const id of ANTHROPIC_RELAY.picker) {
    // Stripped, not verbatim: `[1m]` is Claude Code's own local marker, never
    // sent upstream (the relay strips it at its last hop) and already
    // tolerated by CCR's own resolve() when matching a request against
    // Providers[].models -- MEASURED, this session ran for hours on
    // `claude-sonnet-5[1m]` via an env default with no suffixed entry ever in
    // routing. Requiring routing to carry suffixed duplicates would be asking
    // for a property CCR does not need and does not have today.
    const bare = id.replace(/\[1m\]$/i, "");
    assert.ok(ANTHROPIC_RELAY.routing.includes(bare),
      `routing must be a superset of picker's underlying ids; ${bare} is missing`);
  }
  for (const alias of ["opus", "sonnet", "haiku", "fable"]) {
    assert.equal(ANTHROPIC_RELAY.routing.includes(alias), true,
      `the relay must own the bare alias ${alias} so a third party cannot sole-own it`);
    assert.equal(ANTHROPIC_RELAY.picker.includes(alias), false,
      `${alias} is a routing target, not a menu row`);
  }
});

test("the relay constant keeps every field CCR needs, so it can still be spread", () => {
  // The split is ADDITIVE. An earlier draft replaced the constant with
  // {provider, picker, routing}, which drops api_base_url -- the health probe
  // then hits `undefined/health`, anthropicOn is permanently false, and the
  // relay never loads, taking Claude out of Claude Code entirely.
  for (const k of ["name", "provider", "type", "api_base_url", "api_key",
                   "autoFetchModels", "enabled", "models"]) {
    assert.ok(k in ANTHROPIC_RELAY, `ANTHROPIC_RELAY must keep ${k}`);
  }
  assert.match(ANTHROPIC_RELAY.api_base_url, /^http/);
  // 2026-09-05: models and picker deliberately DIVERGE now -- models stays
  // bare for CCR routing / the real API, picker carries [1m] so Claude Code
  // believes the right context window once a row is selected (see
  // ANTHROPIC_PICKER_FALLBACK's comment in keysync.mjs). What must still hold is
  // that stripping the marker recovers the same four ids in the same order.
  assert.deepEqual([...ANTHROPIC_RELAY.models],
    [...ANTHROPIC_RELAY.picker].map((id) => id.replace(/\[1m\]$/i, "")),
    "the fallback picker's underlying ids, marker stripped, must match models exactly");
  // ...and `models` IS the curated set, which is what run.mjs unions the live
  // ids on top of rather than replacing.
  assert.deepEqual([...ANTHROPIC_RELAY.models], [...ANTHROPIC_FULL]);
});

test("the fallback tag map is derived from the fallback array, so they cannot drift", () => {
  // Two hand-maintained lists of one fact is how they drift. The map must be
  // generated, and a keysync.mjs that re-typed it would fail here.
  assert.deepEqual(Object.keys(ANTHROPIC_FALLBACK_TAGS).sort(), [...ANTHROPIC_FULL].sort());
  for (const [bare, tagged] of Object.entries(ANTHROPIC_FALLBACK_TAGS)) {
    assert.equal(tagged.replace(/\[1m\]$/i, ""), bare);
    assert.ok(ANTHROPIC_RELAY.picker.includes(tagged));
  }
  // The one deliberately-bare id: Haiku 4.5's real ceiling is 200,000 and no 1M
  // variant exists, so tagging it would be a false claim, not a bigger window.
  assert.equal(ANTHROPIC_FALLBACK_TAGS["claude-haiku-4-5-20251001"], "claude-haiku-4-5-20251001");
});

test("with the relay owning the aliases, a reseller publishing opus is only shadowed", () => {
  const r = checkBareCollisions([
    { name: "anthropic", models: ANTHROPIC_RELAY.routing.map((id) => ({ id })) },
    P("tokenrouter", "opus"),
  ]);
  assert.equal(r.fatal, false,
    "this is the case S1 alone cannot catch, because S1 keys on the relay being absent");
  assert.deepEqual(r.shadowed.map((s) => s.id), ["opus"]);
});

test("the relay keeps its own Anthropic names on the routing path too", () => {
  const out = buildProviders(
    [{ id: "relay.anthropic.subscription", provider: "anthropic" }],
    new Map([["anthropic", { protocol: "anthropic", baseUrl: "http://127.0.0.1:4517",
                             testModel: "claude-opus-5" }]]),
    { byProvider: new Map(), generatedAt: "x" },
    () => "relay",
  );
  const ids = out.providers.flatMap((p) => p.models);
  assert.equal(ids.includes("claude-opus-5"), true,
    "the exemption for the trusted relay must survive the guard");
});

// ---- narrowing the predicate (BACKLOG item 2) ------------------------------
// checkBareCollisions used to flag any RESERVED-shaped id regardless of whether
// Anthropic has ever published it. `realIds` narrows that: a Claude-shaped id
// is only a hijack candidate if it is a REAL Anthropic id, because Claude Code
// can never emit a bare name Anthropic has not published.

test("realIds omitted (default null) keeps the old broad RESERVED-only behaviour", () => {
  // Backward compatible on purpose: every test above this section calls
  // checkBareCollisions without realIds and must keep passing unmodified.
  const r = checkBareCollisions([P("tabiai", "claude-opus-5-thinking")]);
  assert.equal(r.fatal, true, "with no realIds, a RESERVED match alone is still fatal");
});

test("a reseller-invented id is not hijackable once realIds says it is not real", () => {
  // claude-opus-5-thinking: RESERVED-shaped, sole-owned by a non-relay provider,
  // and Anthropic has never published it -- extended thinking is a request
  // parameter, not a separate model. This is the exact false positive item 2
  // exists to remove.
  const realIds = new Set(["claude-opus-5", "claude-sonnet-5"]);
  const r = checkBareCollisions([P("tabiai", "claude-opus-5-thinking")], { realIds });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
});

test("a real Anthropic id is still hijackable when realIds confirms it", () => {
  // Narrowing must not become a blanket exemption. The genuinely dangerous
  // shape -- a real id, sole-owned by a non-relay provider -- must still fire.
  const realIds = new Set(["claude-opus-5", "claude-sonnet-5"]);
  const r = checkBareCollisions([P("tokenrouter", "claude-opus-5")], { realIds });
  assert.equal(r.fatal, true);
  assert.deepEqual(r.hijackable.map((h) => h.id), ["claude-opus-5"]);
});

test("realIds narrows both hijackable AND shadowed classification", () => {
  // A fake id shared by two resellers should not even reach `shadowed` -- it
  // was never a candidate, not a candidate that resolved safely.
  const realIds = new Set(["claude-opus-5"]);
  const r = checkBareCollisions([P("a", "claude-opus-9-ultra"), P("b", "claude-opus-9-ultra")],
    { realIds });
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed, []);
});

// ---- relayOwned: routing auto-add must not disarm the FATAL path -----------
// A HIGH regression shipped on this branch and none of the ~20 guard tests above
// caught it, because the guard's own code did not change -- what changed was the
// set feeding it. `routingIds` and `realIds` both became `live u curated`, so
// the relay owned every id the guard considered and `owners.size === 1 &&
// !owners.has(relay)` could never be true. Measured live: `claude-opus-4-8` is
// served by the relay and also listed by tabiai and gorouter, and it went from
// FATAL on master to a silent informational note.

const CURATED = new Set(ANTHROPIC_FULL);

test("a reseller sole-claiming a live-but-UNCURATED id is still FATAL", () => {
  // THE LOAD-BEARING TEST FOR THE REGRESSION. The relay is present in
  // Providers[].models for this id -- exactly what routing auto-add produces --
  // and that must NOT be what makes tabiai's sole claim acceptable. Delete the
  // relayOwned check and this is the test that fails.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-5", "claude-opus-4-8"] },   // auto-added
    P("tabiai", "claude-opus-4-8", "reseller-chat-1"),
  ], { realIds: new Set(["claude-opus-5", "claude-opus-4-8"]), relayOwned: CURATED });
  assert.equal(r.fatal, true,
    "our own config auto-adding an unreviewed id must never launder a reseller's sole claim");
  assert.deepEqual(r.hijackable.map((h) => h.id), ["claude-opus-4-8"]);
  assert.equal(r.hijackable[0].owner, "tabiai", "the reseller is named, not the relay");
});

test("a CURATED id co-owned by the relay stays a safe ambiguity, exactly as before", () => {
  // The other half: curated ids keep the original protection unchanged. If the
  // fix over-applied and stripped the relay everywhere, this would turn a
  // deliberate, reviewed co-ownership into a spurious FATAL on every run.
  const r = checkBareCollisions([
    { name: "anthropic", models: [...ANTHROPIC_FULL] },
    P("tabiai", "claude-opus-5", "reseller-chat-1"),
  ], { realIds: new Set(ANTHROPIC_FULL), relayOwned: CURATED });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.shadowed.map((s) => s.id), ["claude-opus-5"]);
  assert.deepEqual(r.shadowed[0].owners, ["anthropic", "tabiai"],
    "and the reported owner list stays truthful, relay included");
});

test("an uncurated id the relay ALONE serves is not a finding", () => {
  // Stripping the relay must not manufacture findings either. Nobody else
  // claims this id, so there is no one to be hijacked by.
  const r = checkBareCollisions([{ name: "anthropic", models: ["claude-opus-4-8"] }],
    { realIds: new Set(["claude-opus-4-8"]), relayOwned: CURATED });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed, []);
});

test("an uncurated id claimed by TWO resellers is shadowed, not fatal", () => {
  // Two non-relay claimants make resolve() ambiguous on their own, which is a
  // clean failure rather than a misroute -- the relay's presence is irrelevant.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-4-8"] },
    P("tabiai", "claude-opus-4-8"), P("gorouter", "claude-opus-4-8"),
  ], { realIds: new Set(["claude-opus-4-8"]), relayOwned: CURATED });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.shadowed.map((s) => s.id), ["claude-opus-4-8"]);
  assert.deepEqual(r.shadowed[0].owners, ["anthropic", "gorouter", "tabiai"]);
});

test("END TO END: the sets the pipeline derives really do keep the FATAL path armed", () => {
  // MUTATION-FOUND GAP. The guard tests above pass `relayOwned: CURATED` by
  // hand, and the derivation tests assert set shapes -- so a mutation at the
  // ROOT CAUSE (`relayOwned: new Set(routingIds)`, which is literally what
  // shipped) was caught only by an abstract invariant, never by anything showing
  // the security consequence. Nothing exercised the WIRING, which is precisely
  // where the regression lived. This test builds the sets the way run.mjs does
  // and feeds them straight into the guard.
  const live = new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]);
  const { routingIds, relayOwned } = deriveAnthropicSets(live, ANTHROPIC_FULL);
  // The relay's Providers[] entry, exactly as the pipeline unshifts it.
  const providers = [
    { name: "anthropic", models: [...routingIds] },
    P("tabiai", "claude-opus-4-8", "reseller-chat-1"),
  ];
  const realIds = new Set([...live, ...ANTHROPIC_RELAY.models]);
  const r = checkBareCollisions(providers, { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(r.fatal, true,
    "auto-add put claude-opus-4-8 in the relay's models[]; that must not disarm the guard");
  assert.deepEqual(r.hijackable.map((h) => h.id), ["claude-opus-4-8"]);
  // ...while a curated id in the same config is still the safe ambiguity.
  const curatedToo = checkBareCollisions([
    { name: "anthropic", models: [...routingIds] },
    P("tabiai", "claude-opus-5"),
  ], { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(curatedToo.fatal, false);
  assert.deepEqual(curatedToo.shadowed.map((s) => s.id), ["claude-opus-5"]);
});

test("omitting relayOwned keeps the pre-auto-add behaviour intact", () => {
  // Backward compatible on purpose: every guard test above this section calls
  // checkBareCollisions without relayOwned and must keep passing unmodified.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-4-8"] },
    P("tabiai", "claude-opus-4-8"),
  ], { realIds: new Set(["claude-opus-4-8"]) });
  assert.equal(r.fatal, false, "with no vouching distinction the relay shields everything");
});

test("the remedy for an uncurated hijack is review, not an unachievable restart", () => {
  // "Start the relay" is false advice here -- the relay is already running and
  // already routes the id; starting it again changes nothing. The honest remedy
  // is to review the id into ANTHROPIC_FULL, or take the opt-out.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-4-8"] },
    P("tabiai", "claude-opus-4-8"),
  ], { realIds: new Set(["claude-opus-4-8"]), relayOwned: CURATED,
       relayRouting: new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]) });
  assert.equal(r.fatal, true);
  assert.doesNotMatch(r.message, /start the Anthropic relay/);
  assert.match(r.message, /ANTHROPIC_FULL/, "it must name where the review lands");
  assert.match(r.message, /--allow-bare-claude-names/);
  assert.match(r.message, /routes this id but does not curate it/,
    "and the finding line must say why the relay's ownership did not count");
});

test("the remedy consults the EFFECTIVE routing set, not the static constant", () => {
  // A remedy computed from a hardcoded list goes stale the moment routing
  // becomes dynamic: here the relay would serve `claude-opus-9` if started, and
  // it is curated, so "start the relay" is the correct advice -- but nothing in
  // ANTHROPIC_RELAY.routing mentions that id.
  const r = checkBareCollisions([P("tokenrouter", "claude-opus-9")], {
    realIds: new Set(["claude-opus-9"]),
    relayOwned: new Set(["claude-opus-9"]),
    relayRouting: new Set(["claude-opus-9"]),
  });
  assert.equal(r.fatal, true);
  assert.match(r.message, /start the Anthropic relay/);
});

test("an empty realIds set narrows everything away, rather than matching everything", () => {
  // Distinguishes null ("unknown, use the old behaviour") from an empty Set
  // ("checked, and nothing is real") -- a relay that answered with zero models
  // must not be treated the same as a relay that never answered.
  const r = checkBareCollisions([P("tabiai", "claude-opus-5")], { realIds: new Set() });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
});

// ---- validate() must tolerate [1m] on a picker row, end to end ------------
// The mutation this guards against left every other test in this file green:
// they check ANTHROPIC_RELAY's own shape, never validate() actually consuming
// it. Without this, removing the [1m]-stripping tolerance in validate() (the
// fix that makes ANTHROPIC_PICKER's suffix safe to ship) breaks nothing here.

test("validate() accepts a [1m]-suffixed picker row against a bare models[] entry", () => {
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-opus-5[1m]", label: "x" }];
  assert.deepEqual(validate({ providers, picker }, 1), []);
});

test("validate() still rejects a picker row with no corresponding models[] entry", () => {
  // The tolerance must be narrow: stripping [1m] must not become "any string
  // is close enough". A genuinely absent id is still a real problem.
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-sonnet-5[1m]", label: "x" }];
  const problems = validate({ providers, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /claude-sonnet-5\[1m\]/);
});

test("validate() accepts the real ANTHROPIC_RELAY picker against its own models", () => {
  // The actual shapes this fix exists for, exercised together rather than each
  // asserted on in isolation.
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       models: [...ANTHROPIC_RELAY.models] }];
  const picker = ANTHROPIC_RELAY.picker.map((m) => ({ model: `anthropic/${m}`, label: m }));
  assert.deepEqual(validate({ providers, picker }, 1), []);
});

// ---- dynamic [1m] tagging from live max_input_tokens -----------------------
// The static hand-tagged array goes stale the moment Anthropic changes a context
// window or ships a 1M variant of a model currently tagged bare. These assert
// that the tag is now COMPUTED, and -- the part that matters -- that the
// computation degrades to the hand-tagged default rather than to a bare row
// whenever live data says nothing about a given id.

const CTX = (o) => new Map(Object.entries(o));

test("live data confirming a 1M window produces a [1m] row", () => {
  const rows = buildAnthropicPickerRows(["claude-opus-5"], CTX({ "claude-opus-5": 1000000 }));
  assert.deepEqual(rows, ["claude-opus-5[1m]"]);
});

test("live data confirming a sub-1M window produces a BARE row", () => {
  const rows = buildAnthropicPickerRows(["claude-haiku-4-5-20251001"],
    CTX({ "claude-haiku-4-5-20251001": 200000 }));
  assert.deepEqual(rows, ["claude-haiku-4-5-20251001"],
    "tagging a 200k model would be a false claim, not a bigger window");
});

test("live data OVERRIDES a stale hand-tagged default in both directions", () => {
  // The whole point of the change. If Anthropic ships a 1M Haiku, or retires
  // Opus's 1M window, the row follows the API without a code edit -- and the
  // curated fallback, which now disagrees, must lose.
  assert.deepEqual(
    buildAnthropicPickerRows(["claude-haiku-4-5-20251001"],
      CTX({ "claude-haiku-4-5-20251001": 1000000 }), ANTHROPIC_FALLBACK_TAGS),
    ["claude-haiku-4-5-20251001[1m]"],
    "a curated BARE default must not survive live data saying 1M");
  assert.deepEqual(
    buildAnthropicPickerRows(["claude-opus-5"], CTX({ "claude-opus-5": 200000 }),
      ANTHROPIC_FALLBACK_TAGS),
    ["claude-opus-5"],
    "a curated [1m] default must not survive live data saying 200k");
});

test("an id with no live entry falls back to ITS OWN hand-tagged default", () => {
  // Per-id, not all-or-nothing: a response that stated a window for one of the
  // four must not drag the other three to a default they never had.
  //
  // THE LIVE ID HERE IS THE BARE ONE, DELIBERATELY, and that arrangement is the
  // whole value of this test. Written the other way round -- live data for the
  // three tagged ids, nothing for haiku -- it passes even if the function treats
  // a missing entry as a ZERO window, because haiku's expected output is bare
  // either way. MUTATION-CHECKED: `ctx.get(id) ?? 0` left that arrangement
  // green. This arrangement fails it, because coercing a missing entry to 0
  // strips [1m] from the three ids whose curated default carries it -- which is
  // the dangerous direction, a real 1M row silently dropping to a believed 200k
  // window on the exact path (no live data) that the fallback exists to cover.
  const rows = buildAnthropicPickerRows(ANTHROPIC_FULL,
    CTX({ "claude-haiku-4-5-20251001": 200000 }), ANTHROPIC_FALLBACK_TAGS);
  assert.deepEqual(rows, ["claude-opus-5[1m]", "claude-sonnet-5[1m]",
                          "claude-haiku-4-5-20251001", "claude-fable-5-1[1m]"]);
});

test("an EMPTY contextById reproduces the curated fallback array exactly", () => {
  // The total-failure path: relay down, no cache, contextById empty. This must
  // ship today's exact rows -- degrading to untagged rows would silently put
  // every session back on a believed 200k window, the defect the [1m] work fixed.
  assert.deepEqual(buildAnthropicPickerRows(ANTHROPIC_FULL, new Map(), ANTHROPIC_FALLBACK_TAGS),
    [...ANTHROPIC_RELAY.picker]);
});

test("an id with NEITHER live data NOR a fallback default renders BARE", () => {
  // The case decision 3's reversal created: the picker now shows every live id,
  // and the hand-tagged defaults only ever covered the curated four. For
  // anything else with no stated window there is no evidence of a 1M context,
  // and the two errors are not symmetric -- under-claiming is a display
  // inaccuracy, over-claiming lets a session send a prompt larger than the model
  // can hold. Guess downward, or not at all.
  assert.deepEqual(buildAnthropicPickerRows(["claude-opus-4-8"], new Map(), ANTHROPIC_FALLBACK_TAGS),
    ["claude-opus-4-8"]);
  // ...and it still tags when the live data DOES confirm one.
  assert.deepEqual(buildAnthropicPickerRows(["claude-opus-4-8"],
    CTX({ "claude-opus-4-8": 1000000 }), ANTHROPIC_FALLBACK_TAGS), ["claude-opus-4-8[1m]"]);
});

test("a full live id list tags per-id, mixing live, fallback and bare in one pass", () => {
  // The realistic shape after the reversal: 11 live ids, some with a stated
  // window, some without, only four of them covered by a hand-tagged default.
  const rows = buildAnthropicPickerRows(
    ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6"],
    CTX({ "claude-opus-5": 1000000, "claude-sonnet-4-6": 200000 }),
    ANTHROPIC_FALLBACK_TAGS);
  assert.deepEqual(rows, [
    "claude-opus-5[1m]",      // live says 1M
    "claude-sonnet-5[1m]",    // no live window, curated default says 1M
    "claude-opus-4-8",        // no live window, no default -> bare
    "claude-sonnet-4-6",      // live says 200k
  ]);
});

test("the 1M threshold is inclusive at EXACTLY 1,000,000", () => {
  // THE BOUNDARY. Claude Code's own lever is `/\[1m\]/i.test(e) -> 1e6`, so a
  // model whose stated window is exactly 1e6 is a 1M model and must be tagged.
  // A `>` here instead of `>=` is a one-character mutation that leaves every
  // other assertion in this file green while shipping an untagged row for the
  // most likely value the API will ever report.
  assert.equal(ONE_M_TOKENS, 1000000);
  assert.deepEqual(buildAnthropicPickerRows(["m"], CTX({ m: ONE_M_TOKENS })), ["m[1m]"],
    "exactly 1,000,000 is a 1M window: >= not >");
  assert.deepEqual(buildAnthropicPickerRows(["m"], CTX({ m: ONE_M_TOKENS - 1 })), ["m"],
    "one token under is not");
  assert.deepEqual(buildAnthropicPickerRows(["m"], CTX({ m: ONE_M_TOKENS + 1 })), ["m[1m]"]);
  // ...and a 2M model still tags [1m], which is the accepted ceiling: Gc()
  // recognizes no other marker, so this is not a regression versus native mode.
  assert.deepEqual(buildAnthropicPickerRows(["m"], CTX({ m: 2000000 })), ["m[1m]"]);
});

test("the function is pure and order-preserving, and accepts a plain object", () => {
  const ctx = CTX({ "claude-opus-5": 1000000 });
  const before = [...ANTHROPIC_FULL];
  buildAnthropicPickerRows(ANTHROPIC_FULL, ctx);
  assert.deepEqual([...ANTHROPIC_FULL], before, "the curated list must not be mutated");
  assert.equal(ctx.size, 1, "nor the context map");
  // run.mjs passes a Map; the state file and any JSON round-trip give an object.
  assert.deepEqual(buildAnthropicPickerRows(["a", "b"], { a: 1000000 }, { b: "b[1m]" }),
    ["a[1m]", "b[1m]"]);
});

test("an already-tagged curated id cannot become claude-opus-5[1m][1m]", () => {
  // Defensive, and cheap: the curated list is bare today, but a future one-line
  // human edit adding a tagged id would otherwise miss its contextById lookup
  // AND emit a doubled marker -- a model string nothing resolves, in the one
  // place where a wrong string fails silently.
  assert.deepEqual(buildAnthropicPickerRows(["claude-opus-5[1m]"],
    CTX({ "claude-opus-5": 1000000 })), ["claude-opus-5[1m]"]);
  assert.deepEqual(buildAnthropicPickerRows(["claude-opus-5[1m]"],
    CTX({ "claude-opus-5": 200000 })), ["claude-opus-5"]);
});

test("dynamically tagged rows still pass validate() against bare routing ids", () => {
  // End to end, the property the whole feature rests on: whatever the tagger
  // emits must survive validate()'s picker<=models check against the BARE ids
  // that CCR routes on. Asserting the tagger's output in isolation would not
  // catch a tag shape validate() rejects.
  const rows = buildAnthropicPickerRows(ANTHROPIC_FULL,
    CTX({ "claude-opus-5": 1000000, "claude-haiku-4-5-20251001": 200000 }));
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       models: [...ANTHROPIC_FULL] }];
  const picker = rows.map((m) => ({ model: `anthropic/${m}`, label: m }));
  assert.deepEqual(validate({ providers, picker }, 1), []);
});

// ---- deriveAnthropicSets: routing auto-add vs the guard's vouched set -------
// These four sets were inline in the pipeline, where nothing could assert on
// them, and that is exactly how the vouching regression shipped. The invariant
// they must hold is the one the security guard depends on.

const LIVE = new Set([...ANTHROPIC_FULL, "claude-opus-4-8", "claude-sonnet-4-6"]);

test("routing auto-adds every live id, unioned with the curated set", () => {
  const { routingIds } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);
  assert.deepEqual([...routingIds].sort(), [...LIVE].sort());
  // The curated four survive even a live response that omits one of them.
  const partial = deriveAnthropicSets(new Set(["claude-opus-4-8"]), ANTHROPIC_FULL);
  for (const id of ANTHROPIC_FULL) assert.equal(partial.routingIds.has(id), true);
});

test("relayOwned NEVER grows with live data -- the invariant the guard rests on", () => {
  // THE REGRESSION TEST FOR THE REGRESSION'S CAUSE. `routingIds` and the guard's
  // `realIds` both reduce to `live u curated`; if the VOUCHED set were computed
  // the same way, the relay would own every id the guard considers and its FATAL
  // path could never fire. relayOwned must stay curated-only, and must therefore
  // be a strict subset whenever live data adds anything.
  const { routingIds, relayOwned } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);
  assert.deepEqual([...relayOwned].sort(), [...ANTHROPIC_FULL].sort());
  assert.ok(relayOwned.size < routingIds.size,
    "live data added ids, so the vouched set MUST be strictly smaller than the routed set");
  for (const id of relayOwned) assert.equal(routingIds.has(id), true, "and a subset of it");
});

test("the relay's provider name is reserved, and the message says what breaks", () => {
  // Three consumers key off "the provider called `anthropic` is ours" and none
  // of them enforced it -- checkBareCollisions keys owners by provider NAME, so
  // an impostor sharing it collapses both into one owner and the guard reports
  // "no collisions" while a sole-owning reseller sits there. Demonstrated first,
  // because a guard whose absence is harmless does not need to exist.
  const impostor = [
    { name: "anthropic", api_key: "k", models: ["claude-opus-5"] },
    { name: "anthropic", api_key: "k", models: ["claude-opus-5"] },
  ];
  const collapsed = checkBareCollisions(impostor, { relay: "anthropic" });
  assert.equal(collapsed.fatal, false, "two providers, one owner -- the guard goes quiet");

  assert.doesNotThrow(() => assertRelayNameUnclaimed(
    [{ name: "tabiai" }, { name: "gorouter" }], "anthropic"));
  assert.throws(() => assertRelayNameUnclaimed(
    [{ name: "tabiai" }, { name: "anthropic" }], "anthropic"),
    /checkBareCollisions[\s\S]*orderNativePickerOptions[\s\S]*behavesAs/,
    "the message must name all three dependents, not just say 'reserved'");
});

test("the pipeline's guard fires on the reunification it names, not just on shrinkage", () => {
  // The shape this replaces was `relayOwned.size > routingIds.size`, whose stated
  // purpose was to catch "a future edit that reunifies them" -- but reunification
  // makes the two sets EQUAL, and `>` cannot see equality. The security review
  // confirmed it: relayOwned = routingIds passed, and passing silently disarms
  // checkBareCollisions' FATAL path. This test is the one that fails if the
  // assertion is deleted or weakened back.
  const { routingIds, relayOwned } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);

  // The good state must stay quiet, on BOTH branches -- with live data present,
  // and with none, where both sets legitimately reduce to the curated constant.
  // That second case is why `!==` could not be the fix.
  assertVouchedSetIsNarrower(relayOwned, routingIds, LIVE);
  const off = deriveAnthropicSets(null, ANTHROPIC_FULL);
  assertVouchedSetIsNarrower(off.relayOwned, off.routingIds, null);

  // THE REUNIFICATION. This is precisely what the old check waved through.
  assert.throws(() => assertVouchedSetIsNarrower(new Set(LIVE), new Set(LIVE), LIVE),
    /FATAL sole-owner path becomes structurally unreachable/,
    "vouching for a live id disarms the guard, and the message must say so");

  // The inverse: routing stopped auto-adding, so the picker advertises rows CCR
  // will not route. Guard stays armed; the config is still wrong.
  assert.throws(() => assertVouchedSetIsNarrower(relayOwned, new Set(ANTHROPIC_FULL), LIVE),
    /routing did not grow/);
});

test("the picker shows every live id, not just the curated four (decision 3 reversed)", () => {
  const { pickerIds } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);
  assert.deepEqual([...pickerIds].sort(), [...LIVE].sort());
  assert.ok(pickerIds.includes("claude-opus-4-8"));
});

test("every picker id is routable, so validate() can never reject a shown row", () => {
  // A row the menu offers but Providers[].models does not carry fails
  // validate() and aborts the run. Asserted as a property of the derivation
  // rather than left to the two happening to be built from the same input.
  for (const live of [LIVE, new Set(["claude-opus-9"]), null]) {
    const { pickerIds, routingIds } = deriveAnthropicSets(live, ANTHROPIC_FULL);
    for (const id of pickerIds) {
      assert.equal(routingIds.has(id), true, `${id} is shown but not routed`);
    }
  }
});

test("a null catalog falls back to the curated set for routing AND the picker", () => {
  // An unreachable relay is not evidence about anything. Four reviewed rows is
  // the right degradation; zero rows would fail the post-write verification and
  // an empty routing set would remove Claude from Claude Code entirely.
  const { routingIds, relayOwned, pickerIds } = deriveAnthropicSets(null, ANTHROPIC_FULL);
  assert.deepEqual([...routingIds].sort(), [...ANTHROPIC_FULL].sort());
  assert.deepEqual([...pickerIds], [...ANTHROPIC_FULL]);
  assert.deepEqual([...relayOwned].sort(), [...ANTHROPIC_FULL].sort());
});

test("relayAliases stays exactly the bare aliases, however routingIds grows", () => {
  // Computed as "in the static routing list but not a model id" rather than
  // hardcoded, so a live id that happened to collide with the list cannot be
  // double-advertised, and a growing routing set cannot drop an alias.
  const { relayAliases } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);
  assert.deepEqual([...relayAliases].sort(), ["fable", "haiku", "opus", "sonnet"]);
  const none = deriveAnthropicSets(null, ANTHROPIC_FULL);
  assert.deepEqual([...none.relayAliases].sort(), ["fable", "haiku", "opus", "sonnet"]);
});

test("the routing staleness ceiling is a real bound, not an unbounded default", () => {
  // The fetch's own TTL is one hour; this bounds how old a CACHE may be and
  // still decide what we advertise. An arbitrarily old snapshot would write
  // retired ids into live Providers[].models as rows that 404 on selection.
  assert.equal(typeof ROUTING_MAX_STALENESS_MS, "number");
  assert.ok(ROUTING_MAX_STALENESS_MS > 60 * 60 * 1000, "must exceed the 1h fetch TTL");
  assert.ok(ROUTING_MAX_STALENESS_MS <= 30 * 24 * 60 * 60 * 1000, "but must actually bound it");
});

test("a snapshot inside the ceiling routes; one past it falls back to curated", () => {
  const now = 1_000_000_000_000;
  const ids = new Set(["claude-opus-4-8"]);
  const fresh = { ids, at: now - ROUTING_MAX_STALENESS_MS + 1000 };
  const ancient = { ids, at: now - ROUTING_MAX_STALENESS_MS - 1000 };
  assert.equal(routableCatalogIds(fresh, now), ids);
  assert.equal(routableCatalogIds(ancient, now), null, "too old to decide what we advertise");
  // Exactly at the ceiling is still routable: `<=`, not `<`.
  assert.equal(routableCatalogIds({ ids, at: now - ROUTING_MAX_STALENESS_MS }, now), ids);
  assert.equal(routableCatalogIds(null, now), null);
});

test("an unstamped (legacy) snapshot is treated as maximally stale, not as fresh", () => {
  // `at: 0` must fail the ceiling rather than pass it. The inverted reading --
  // "no timestamp, assume current" -- would let an arbitrarily old legacy cache
  // write retired ids into live routing, which is the exact thing the ceiling
  // exists to stop, on the one record shape that carries no age at all.
  const now = 1_000_000_000_000;
  assert.equal(routableCatalogIds({ ids: new Set(["x"]), at: 0 }, now), null);
  assert.equal(routableCatalogIds({ ids: new Set(["x"]) }, now), null, "and a missing field too");
});

test("a too-stale snapshot still feeds the GUARD, only routing is bounded", () => {
  // The ceiling must not become a security regression of its own. Routing falls
  // back to curated, but `realIds` is built from the raw catalog, so the guard
  // keeps its narrowing rather than reverting to null (= match every
  // Claude-SHAPED name). Two different questions, two different tolerances.
  const now = 1_000_000_000_000;
  const catalog = { ids: new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]), at: 0 };
  const { routingIds } = deriveAnthropicSets(routableCatalogIds(catalog, now), ANTHROPIC_FULL);
  assert.equal(routingIds.has("claude-opus-4-8"), false, "not routed: the snapshot is ancient");
  const realIds = new Set([...catalog.ids, ...ANTHROPIC_RELAY.models]);
  const r = checkBareCollisions([P("tabiai", "claude-opus-4-8")],
    { realIds, relayOwned: new Set(ANTHROPIC_FULL), relayRouting: routingIds });
  assert.equal(r.fatal, true, "the guard still considers the id and still fires");
});

// ---- decision 4 REVERSED: every built row is written, Anthropic first -------

const ROW = (model, description) => (description ? { model, description } : { model });
const FULL_BUILT = [
  ROW("anthropic/claude-opus-5[1m]", "subscription"),
  ROW("anthropic/claude-sonnet-5[1m]", "subscription"),
  ROW("anthropic/claude-haiku-4-5-20251001", "subscription"),
  ROW("anthropic/claude-fable-5-1[1m]", "subscription"),
  ROW("groq/openai/gpt-oss-20b", "free · api.groq.com"),
  ROW("mistral/mistral-small-latest", "paid · api.mistral.ai"),
  ROW("tabiai/claude-opus-5", "free · tabitoken.com"),
];

test("every built row is written to modelPicker.options, Anthropic first", () => {
  // THE REVERSAL. The predecessor asserted 4 rows out of 7; a mutation that
  // reinstates the filter fails here. The third-party half must also keep its
  // INPUT relative order -- `Ato()` renders options[] in array order, and the
  // build already sorts those rows (free-first, then catalogue rank).
  const out = orderNativePickerOptions(FULL_BUILT);
  assert.equal(out.length, FULL_BUILT.length);
  assert.deepEqual(out.map((r) => r.model), [
    "anthropic/claude-opus-5[1m]", "anthropic/claude-sonnet-5[1m]",
    "anthropic/claude-haiku-4-5-20251001", "anthropic/claude-fable-5-1[1m]",
    "groq/openai/gpt-oss-20b", "mistral/mistral-small-latest", "tabiai/claude-opus-5"]);
  assert.equal(out.slice(0, 4).every((r) => r.model.startsWith("anthropic/")), true);
  assert.equal(out.slice(4).some((r) => r.model.startsWith("anthropic/")), false,
    "a reseller's Claude-shaped row must not ride into the head on a loose prefix match");
});

test("an INTERLEAVED build is partitioned, and the third-party half keeps its order", () => {
  // THE FIXTURE THE OTHER FOUR TESTS LACK. FULL_BUILT is already Anthropic-first
  // and the relay-down case has no Anthropic rows at all, so `(rows) => [...rows]`
  // -- a function that partitions nothing -- satisfies every one of them. Nothing
  // observed the partition actually moving a row.
  //
  // It is not a hypothetical input either: the pipeline unshifts the relay rows
  // onto an already-built vault set, so any future edit that appends them, or
  // adds a second Anthropic source, produces exactly this shape.
  const interleaved = [
    ROW("groq/openai/gpt-oss-20b", "free · api.groq.com"),
    ROW("anthropic/claude-opus-5[1m]", "subscription"),
    ROW("tabiai/claude-opus-5", "free · tabitoken.com"),
    ROW("mistral/mistral-small-latest", "paid · api.mistral.ai"),
    ROW("anthropic/claude-sonnet-5[1m]", "subscription"),
    ROW("cerebras/llama3.1-8b", "free · cerebras.ai"),
  ];
  const out = orderNativePickerOptions(interleaved);

  assert.deepEqual(out.map((r) => r.model).slice(0, 2),
    ["anthropic/claude-opus-5[1m]", "anthropic/claude-sonnet-5[1m]"],
    "the Anthropic rows lead, in their own input order");

  // The third-party order is DISTINGUISHABLE -- groq, tabiai, mistral, cerebras
  // is not sorted by any key -- so a re-sort rather than a stable partition shows
  // up here. `Ato()` renders options[] in array order and the build already
  // sorted these (free-first, then catalogue rank), so that order is a result.
  assert.deepEqual(out.map((r) => r.model).slice(2), [
    "groq/openai/gpt-oss-20b", "tabiai/claude-opus-5",
    "mistral/mistral-small-latest", "cerebras/llama3.1-8b"]);

  // And the identity check: the partition moves rows, it does not rebuild them.
  assert.equal(out.length, interleaved.length);
  assert.equal(out[0], interleaved[1], "the same row objects, relocated");
  assert.deepEqual(interleaved.map((r) => r.model), [
    "groq/openai/gpt-oss-20b", "anthropic/claude-opus-5[1m]", "tabiai/claude-opus-5",
    "mistral/mistral-small-latest", "anthropic/claude-sonnet-5[1m]",
    "cerebras/llama3.1-8b"], "and the caller's array is still in build order");
});

test("ordering returns a NEW array and leaves the caller's rows exactly as built", () => {
  // `built.picker` is read AFTER this by `reconcileUserModelPin` and as
  // `built.picker[0].model`, the last fallback of the `anchorModel` chain, so
  // neither the input array nor any row in it may be touched. An in-place sort
  // would reorder the caller's array and silently repoint the profile anchor at
  // whichever row landed at index 0.
  //
  // WHICH ASSERTION DOES THE WORK, corrected: it is `notEqual(out, FULL_BUILT)`,
  // not the deepEqual. FULL_BUILT is already Anthropic-first, so an in-place
  // STABLE sort leaves it unreordered and the deepEqual passes -- only the
  // aliasing check sees it. The deepEqual earns its place against an in-place
  // sort on a fixture that is NOT already ordered, which the interleaved test
  // above now supplies.
  const before = JSON.parse(JSON.stringify(FULL_BUILT));
  const out = orderNativePickerOptions(FULL_BUILT);
  assert.deepEqual(FULL_BUILT, before, "the input array and its rows must be untouched");
  assert.notEqual(out, FULL_BUILT, "the result must not alias the input array");
});

test("with no Anthropic rows the input is returned unchanged and in order", () => {
  // The relay-down case. It used to need a fallback because scoping to zero
  // Anthropic rows wrote an empty options[], failing the post-write check
  // (`assertOptionsComplete`) and rolling settings.json back through
  // `restoreSettings`. A partition has nothing to fall back from: one half is
  // simply empty.
  const noRelay = FULL_BUILT.filter((r) => !r.model.startsWith("anthropic/"));
  const out = orderNativePickerOptions(noRelay);
  assert.deepEqual(out.map((r) => r.model), noRelay.map((r) => r.model));
});

test("every built row reaches options[], because options[] is the only channel that can carry behavesAs", () => {
  // The V7 property, asserted from this commit rather than deferred to T8's
  // assertOptionsComplete. `options[]` is simultaneously the rendered /model list
  // (`Ato()`) and the registry `_re()` reads `behavesAs` from, so a dropped row
  // loses its capability declaration and `lH()` resolves the id to the MAXIMAL
  // assumption set plus an unknown-model launch warning (report 18 §3). The test
  // this replaces stopped a future un-scoping; this one stops a future
  // re-scoping.
  const out = orderNativePickerOptions(FULL_BUILT);
  const dropped = FULL_BUILT.filter((r) => !out.some((o) => o.model === r.model));
  assert.deepEqual(dropped, []);
});

// ---- T6: the capability signals reach the write site --------------------------
//
// Every assertion here is on the object the PIPELINE produced, never on a hand
// written literal. The field is `contextTokens`; `ctx` is the menu pipeline's
// name for the same number, and a classifier reading `ctx` on this side would
// see `undefined` for every row while staying green under any literal-driven
// test. Naming the field once, in normalizeModel, is what makes that checkable.

test("normalizeModel names the context field contextTokens, not ctx", () => {
  // §1.4. The whole reason this function is exported. Reading `ctx` here would
  // silently move all 7 context-proxy rows from capable to weak (27/56 -> 24/59)
  // with no test failing anywhere.
  const m = normalizeModel("big-1", {
    provider: "acme", model: "big-1",
    limits: { contextTokens: 131072 },
    modalities: { output: ["text"] },
    capabilities: { reasoning: true }
  });
  assert.equal(m.contextTokens, 131072);
  assert.equal("ctx" in m, false, "`ctx` belongs to the menu pipeline, not to this one");
});

test("a MEASURED reasoning:false survives as false, and never becomes null", () => {
  // Mutation boundary 2. `?? null` vs `|| null`: `false || null === null`, so the
  // wrong operator turns a measured capability back into "unknown" -- the same
  // conflation as `!!undefined === false` wearing a different operator. Invisible
  // to any test that only checks the absent case, so this asserts on `false`.
  const measured = normalizeModel("small-1", {
    limits: { contextTokens: 8192 },
    modalities: { output: ["text"] },
    capabilities: { reasoning: false }
  });
  assert.equal(measured.reason, false);
  const absent = normalizeModel("quiet-1", {
    limits: { contextTokens: 8192 }, modalities: { output: ["text"] }, capabilities: {}
  });
  assert.equal(absent.reason, null, "an absent key is unknown, not a measured false");
});

test("a testModel with no catalogue entry carries null, never false", () => {
  // 38 of the 83 rows. This is D3's population: no reasoning flag, no context, no
  // modality. Every field must say "we do not know" rather than "we measured it
  // small" -- the two are counted separately by the classifier, and only the
  // distinct `unknown` classification makes the no-signal case observable.
  const m = normalizeModel("vault-probe-1", undefined);
  assert.deepEqual(m, {
    id: "vault-probe-1", tier: "unknown", contextTokens: undefined,
    reason: null, kind: null
  });
});

test("normalizeModel carries the modality label, so a non-chat row is knowable", () => {
  // google/lyria and google/veo-2 as the catalogue really spells them: both
  // carry a NUMBER in contextTokens (0 seconds and 480 seconds of media), so a
  // proxy that ran before the modality check would read them as tiny models.
  const lyria = normalizeModel("lyria", {
    limits: { contextTokens: 0 },
    modalities: { input: ["text"], output: ["audio"] },
    capabilities: { reasoning: false }
  });
  assert.equal(lyria.kind, "nontext");
  assert.equal(lyria.contextTokens, 0, "kept as-is; the classifier owns the > 0 guard");
  const chat = normalizeModel("orca-auto", {
    modalities: { input: ["image", "text"], output: ["text"] },
    capabilities: { reasoning: false }
  });
  assert.equal(chat.kind, "text", "multimodal INPUT is still a chat model");
});

test("buildProviders plumbs reason and kind onto every model it builds", () => {
  // End to end through the real row builder, both push sites in one call: the
  // vault testModel path (`probe-1`, which HAS a catalogue entry here) and the
  // catalogue-ranked path (`acme-vision`, `acme-embed`).
  const built = buildProviders(
    [{ id: "personal.acme.free", provider: "acme" }],
    new Map([["acme", { protocol: "openai", baseUrl: "https://x.invalid/v1",
                        testModel: "probe-1" }]]),
    { generatedAt: "x", byProvider: new Map([["acme", [
      { provider: "acme", model: "probe-1", limits: { contextTokens: 200000 },
        modalities: { output: ["text"] }, capabilities: { reasoning: true } },
      { provider: "acme", model: "acme-vision", limits: { contextTokens: 4096 },
        modalities: { output: ["image", "text"] }, capabilities: { reasoning: false } },
      { provider: "acme", model: "acme-embed", limits: { contextTokens: 8192 },
        modalities: { output: ["embedding", "text"] }, capabilities: {} },
    ]]]) },
    () => "sk-test-not-a-real-key",
  );
  // testModel first, then catalogue rank -- which today is shortest-id, since
  // inferTier's free-first key is dead (0 of 4,298 entries yield a price).
  assert.deepEqual(built.picker.map((r) => r.model),
    ["acme/probe-1", "acme/acme-embed", "acme/acme-vision"]);
  // The picker rows carry no capability fields yet -- T7 adds `kind` and the
  // bucketed `behavesAs`. What T6 owns is that the SIGNALS exist by the time the
  // row builder runs, which the shared normalizer is the single owner of.
  const norm = [
    normalizeModel("probe-1", { limits: { contextTokens: 200000 },
      modalities: { output: ["text"] }, capabilities: { reasoning: true } }),
    normalizeModel("acme-embed", { limits: { contextTokens: 8192 },
      modalities: { output: ["embedding", "text"] }, capabilities: {} }),
    normalizeModel("acme-vision", { limits: { contextTokens: 4096 },
      modalities: { output: ["image", "text"] }, capabilities: { reasoning: false } }),
  ];
  assert.deepEqual(norm.map((m) => [m.reason, m.kind]),
    [[true, "text"], [null, "nontext"], [false, "text"]],
    "embedding+text is still not a chat model; image+text is");
  // contextTokens is the one signal already visible on the row, so it is the one
  // that proves the normalizer's output really is what the builder consumed.
  assert.deepEqual(built.picker.map((r) => r.contextTokens), [200000, 8192, 4096]);
});

// ---- T7: the bucket table and the classifier ---------------------------------

const M = (o) => ({ kind: null, reason: null, contextTokens: undefined, ...o });

test("bucketFor matches the decision table, in the order the table states", () => {
  // The whole rule, one row per branch. Written as a table so a reordering shows
  // up as a changed cell rather than as a rewritten test.
  const cases = [
    [M({ kind: "nontext" }),                            "nonchat"],
    [M({ kind: "text", reason: true }),                 "capable"],
    [M({ kind: "text", reason: false }),                "weak"],
    [M({ kind: "text", contextTokens: 131072 }),        "capable"],
    [M({ kind: "text", contextTokens: 8192 }),          "weak"],
    [M({ kind: "text" }),                               "unknown"],
    [M({}),                                             "unknown"],
  ];
  for (const [model, want] of cases) {
    assert.equal(bucketFor(model), want, JSON.stringify(model));
  }
});

test("the context cutoff is INCLUSIVE at exactly 128,000", () => {
  // Mutation boundary 1, the same shape as the ONE_M_TOKENS boundary above.
  // cerebras/llama3.1-8b sits on 128000 exactly and the catalogue has nothing
  // between 8,192 and 128,000, so `>=` -> `>` moves a real row and only that row.
  assert.equal(CTX_CAPABLE_MIN, 128000);
  assert.equal(bucketFor(M({ kind: "text", contextTokens: 127999 })), "weak");
  assert.equal(bucketFor(M({ kind: "text", contextTokens: 128000 })), "capable");
  assert.equal(bucketFor(M({ kind: "text", contextTokens: 128001 })), "capable");
});

test("a context of 0 is no signal, not a very small window", () => {
  // Mutation boundary 3. google/lyria really reports contextTokens 0. `> 0` ->
  // `!= null` reads that as a valid tiny context and returns "weak". Both answers
  // resolve to the SAME target, so the only thing that can tell them apart is the
  // distinct `unknown` classification -- which is why D3 keeps it distinct. The
  // `kind` shadow is bypassed here on purpose: lyria is also nontext, and testing
  // this through a nontext row would assert nothing about the guard.
  assert.equal(bucketFor(M({ kind: "text", contextTokens: 0 })), "unknown");
  assert.equal(bucketFor(M({ kind: "text", contextTokens: undefined })), "unknown");
  assert.equal(bucketFor(M({ kind: "text", contextTokens: null })), "unknown");
  // ...and a non-number never reaches the comparison, where "200k" >= 128000 is
  // false but "999999" >= 128000 is true. Strings are not windows.
  assert.equal(bucketFor(M({ kind: "text", contextTokens: "999999" })), "unknown");
});

test("a measured reasoning flag outranks the context proxy, in both directions", () => {
  // The proxy is a fallback for rows with no reasoning flag at all, never a
  // second opinion about a row that has one.
  assert.equal(bucketFor(M({ kind: "text", reason: false, contextTokens: 1000000 })), "weak");
  assert.equal(bucketFor(M({ kind: "text", reason: true, contextTokens: 4096 })), "capable");
});

test("non-chat outranks a true reasoning flag, so the order cannot be swapped", () => {
  // Mutation boundary 4. Reordering `reason` above `kind` sends google/lyria and
  // google/veo-2 to weak instead of nonchat -- and BOTH carry reasoning:false, so
  // every count in the audit still sums to 83 and nothing else fails. Only a row
  // that is nontext and reasoning:true at once can see the difference.
  assert.equal(bucketFor(M({ kind: "nontext", reason: true, contextTokens: 2000000 })), "nonchat");
  assert.equal(bucketFor(M({ kind: "nontext", reason: false, contextTokens: 480 })), "nonchat");
});

test("bucketFor reads an object the PIPELINE built, not a hand-written literal", () => {
  // §1.4, and the reason this test exists at all. Every assertion above feeds
  // bucketFor an object literal, so all of them stay green if the classifier
  // reads `ctx` -- the menu pipeline's name for the same number. Driving it with
  // normalizeModel's output is what checks the field NAME rather than assuming
  // it. Under `ctx`, the two proxy rows below would both return "unknown".
  const bigProxy = normalizeModel("cerebras-8b", {
    limits: { contextTokens: 128000 }, modalities: { output: ["text"] }, capabilities: {} });
  const smallProxy = normalizeModel("mistral-tiny", {
    limits: { contextTokens: 8192 }, modalities: { output: ["text"] }, capabilities: {} });
  assert.equal(bucketFor(bigProxy), "capable");
  assert.equal(bucketFor(smallProxy), "weak");
  // The real non-chat rows, spelled as the catalogue spells them.
  const lyria = normalizeModel("lyria", {
    limits: { contextTokens: 0 },
    modalities: { input: ["text"], output: ["audio"] }, capabilities: { reasoning: false } });
  const veo = normalizeModel("veo-2", {
    limits: { contextTokens: 480 },
    modalities: { input: ["text"], output: ["video"] }, capabilities: { reasoning: false } });
  const flux = normalizeModel("flux.1-schnell", {
    modalities: { input: ["text"], output: ["image"] } });
  assert.deepEqual([lyria, veo, flux].map((m) => bucketFor(m)),
    ["nonchat", "nonchat", "nonchat"]);
  // ...and a testModel with no entry at all is unknown, not weak.
  assert.equal(bucketFor(normalizeModel("vault-probe-1", undefined)), "unknown");
});

test("the bucket table is a vetted set, and every classification lands inside it", () => {
  assert.deepEqual(Object.keys(BUCKET_TARGETS).sort(),
    ["capable", "nonchat", "unknown", "weak"]);
  for (const [bucket, target] of Object.entries(BUCKET_TARGETS)) {
    assert.ok(ALLOWED_BEHAVES_AS.includes(target),
      `${bucket} -> ${target} must be an allowlisted target, not a typo`);
    assert.equal(PROMPT_BUNDLE_MODELS.test(target), false,
      `${bucket} -> ${target} carries a model-specific prompt bundle`);
  }
  // Only `capable` may point at the capable target. Setting `unknown` or
  // `nonchat` to it flips 38 or 4 rows into over-declaration while a
  // capable-vs-weak inequality stays true.
  assert.equal(BUCKET_TARGETS.weak, BUCKET_TARGETS.unknown);
  assert.equal(BUCKET_TARGETS.weak, BUCKET_TARGETS.nonchat);
  assert.notEqual(BUCKET_TARGETS.capable, BUCKET_TARGETS.weak);
  // haiku-4-5 is capability-identical to the weak target and deliberately absent:
  // its interleaved_thinking flips false on gateway / custom base URLs, i.e. on
  // every provider shape UW routes through (report 18 §10.2 fn 1).
  assert.equal(ALLOWED_BEHAVES_AS.includes("claude-haiku-4-5"), false);
});

test("behavesAsFor always returns a target, never null or empty", () => {
  // D6. An absent declaration is the MAXIMAL one, not the honest one: lH()
  // resolves it to every effort tier with thinking forced on, plus a launch
  // warning (report 18 §3). Even a row that cannot answer a chat request at all
  // declares the weak target, because inert beats maximal.
  for (const model of [M({}), M({ kind: "nontext" }), M({ reason: true }),
                       M({ reason: false }), M({ contextTokens: 0 })]) {
    const t = behavesAsFor(model);
    assert.equal(typeof t, "string");
    assert.ok(t.length > 0);
    assert.ok(ALLOWED_BEHAVES_AS.includes(t));
  }
  assert.equal(behavesAsFor(M({ kind: "nontext", reason: true })), BUCKET_TARGETS.weak);
  assert.equal(behavesAsFor(M({ reason: true })), BUCKET_TARGETS.capable);
});

test("UW_BEHAVES_AS is retired: no env var can flatten the table", () => {
  // D7-A. A whole-table override and the table-shape rule are mutually exclusive
  // -- one env value sets every bucket equal, so the rule would fail the build
  // the first time anyone used the hatch. The table IS the hatch now: two
  // allowlist-validated lines beat an env var that fails silently on a typo.
  const src = fs.readFileSync(new URL("../keysync/keysync.mjs", import.meta.url), "utf8");
  assert.equal(/UW_BEHAVES_AS/.test(src), false,
    "the override must be gone from the source, not merely unread");
  const saved = process.env.UW_BEHAVES_AS;
  process.env.UW_BEHAVES_AS = "claude-opus-5";
  try {
    assert.equal(behavesAsFor(M({ reason: true })), BUCKET_TARGETS.capable);
  } finally {
    if (saved === undefined) delete process.env.UW_BEHAVES_AS;
    else process.env.UW_BEHAVES_AS = saved;
  }
});

// A fixture catalogue reproducing the MEASURED §1.2 shape of the 83 live rows:
// 4 nonchat, 24 reasoning:true, 3 context-proxy>=128k, 10 reasoning:false,
// 4 context-proxy<128k, 38 with no catalogue entry at all. Entry SHAPES are
// copied from the real catalogue (google/lyria's contextTokens 0, google/veo-2's
// 480 video seconds, cerebras/llama3.1-8b's exact 128000); the counts are scaled
// up by repetition, since three providers of three rows classify identically to
// one provider of nine and MAX_MODELS_PER_PROVIDER caps each at three.
const E = (model, o) => ({ provider: o.provider, model, ...o.entry });
function capabilityFixture() {
  const chosen = [];
  const vault = new Map();
  const byProvider = new Map();
  let n = 0;
  const provider = (entries, testModel) => {
    const name = `fx${n++}`;
    chosen.push({ id: `personal.${name}.free`, provider: name });
    vault.set(name, { protocol: "openai", baseUrl: `https://${name}.invalid/v1`,
                      ...(testModel ? { testModel } : {}) });
    if (entries.length) {
      byProvider.set(name, entries.map((e, i) =>
        E(`${name}-m${i}`, { provider: name, entry: e })));
    }
    return name;
  };
  const text = (extra) => ({ modalities: { output: ["text"] }, ...extra });
  // 38 rows with no signal at all: a vault testModel this provider's catalogue
  // does not list. This is D3's population and the largest single group.
  for (let i = 0; i < 38; i++) provider([], `probe-${i}`);
  // 4 non-chat rows, two providers, as the real four are shaped.
  provider([
    { limits: { contextTokens: 0 }, modalities: { input: ["text"], output: ["audio"] },
      capabilities: { reasoning: false } },
    { limits: { contextTokens: 480 }, modalities: { input: ["text"], output: ["video"] },
      capabilities: { reasoning: false } },
  ]);
  provider([
    { modalities: { input: ["text"], output: ["image"] } },
    { modalities: { input: ["text"], output: ["image"] } },
  ]);
  // 24 reasoning:true rows, 8 providers of 3.
  for (let i = 0; i < 8; i++) {
    provider([0, 1, 2].map(() => text({ limits: { contextTokens: 4096 },
      capabilities: { reasoning: true } })));
  }
  // 3 context-proxy rows at or above the cutoff, no reasoning flag.
  provider([128000, 131000, 131072].map((c) =>
    text({ limits: { contextTokens: c }, capabilities: {} })));
  // 10 reasoning:false rows, three providers of 3 plus one of 1.
  for (let i = 0; i < 3; i++) {
    provider([0, 1, 2].map(() => text({ limits: { contextTokens: 1000000 },
      capabilities: { reasoning: false } })));
  }
  provider([text({ limits: { contextTokens: 1000000 }, capabilities: { reasoning: false } })]);
  // 4 context-proxy rows below the cutoff, no reasoning flag.
  provider([4096, 8192].map((c) => text({ limits: { contextTokens: c }, capabilities: {} })));
  provider([4096, 8192].map((c) => text({ limits: { contextTokens: c }, capabilities: {} })));
  return { chosen, vault, catalog: { generatedAt: "fixture", byProvider } };
}

test("END TO END: 83 rows classify 4/27/14/38 and declare 27 capable, 56 weak", () => {
  const { chosen, vault, catalog } = capabilityFixture();
  const built = buildProviders(chosen, vault, catalog, () => "sk-test-not-a-real-key");
  assert.equal(built.picker.length, 83, "the fixture must reproduce the measured row count");

  // TWO SEPARATE JOBS, AND THEY MUST NOT BE CONFLATED.
  //
  // (1) ORDERING INTERLOCK. Routing through orderNativePickerOptions is what
  //     orders T1 before T7: with the old scoping in place this function keeps
  //     only the Anthropic rows, so the distribution below cannot be satisfied
  //     and T7 cannot land on an unreversed Decision 4. It is NOT the classifier
  //     check -- post-T1 the function is a pass-through, so "count the rows that
  //     survive" is input.length by construction and proves nothing.
  //
  // (2) THE DISTRIBUTION, asserted over the returned array on its own terms.
  //     The relay rows are unshifted first exactly as the pipeline's
  //     `built.picker.unshift` in the relay block does, so the
  //     third-party half has to be picked back out by name rather than by
  //     assuming the whole array is third-party.
  const relayRows = ANTHROPIC_FULL.map((m) => ({
    model: `${ANTHROPIC_RELAY.name}/${m}`, label: `Anthropic > ${m}`,
    description: "subscription"   // no behavesAs: Claude Code knows these ids
  }));
  const out = orderNativePickerOptions([...relayRows, ...built.picker]);
  assert.equal(out.length, 83 + relayRows.length, "nothing may be filtered out");
  assert.equal(out.slice(0, relayRows.length).every((r) =>
    r.model.startsWith(`${ANTHROPIC_RELAY.name}/`)), true);

  const third = out.filter((r) => !r.model.startsWith(`${ANTHROPIC_RELAY.name}/`));
  assert.equal(third.length, 83);
  const targets = {};
  for (const r of third) targets[r.behavesAs] = (targets[r.behavesAs] ?? 0) + 1;
  assert.deepEqual(targets, { "claude-sonnet-4-6": 27, "claude-sonnet-4-5": 56 },
    "27 rows byte-identical to the constant this replaces; 56 stepped down");
  assert.equal(third.some((r) => !r.behavesAs), false, "no row may lose its declaration");

  // The four-way classification behind that 27/56, which the two targets alone
  // cannot show: `weak`, `unknown` and `nonchat` all resolve to one string, so a
  // table that pointed `unknown` at the capable target would move 38 rows while
  // every count above still summed to 83.
  const buckets = {};
  for (const [name, entries] of catalog.byProvider) {
    for (const e of entries) {
      const b = bucketFor(normalizeModel(e.model, e));
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    void name;
  }
  buckets.unknown = (buckets.unknown ?? 0) + 38;   // the no-entry testModel rows
  assert.deepEqual(buckets, { nonchat: 4, capable: 27, weak: 14, unknown: 38 });

  // Every non-chat row still carries a declaration, and it is the weak one (V5's
  // subject, asserted here from the commit that creates the field).
  const nonchat = third.filter((r) => r.kind === "nontext");
  assert.equal(nonchat.length, 4);
  assert.equal(nonchat.every((r) => r.behavesAs === BUCKET_TARGETS.weak), true);
});

test("run.mjs strips both UW-side fields, so a written row keeps four keys", () => {
  // T7 step 5. `kind` is added to the picker row in this same commit, so the
  // strip is extended in it too: a commit that added the field without extending
  // the strip is a legitimate stopping point that writes a fifth key into a
  // schema the binary defines as exactly {model, label?, description?,
  // behavesAs?}. Asserted against the source, because the write site itself runs
  // only under --target and cannot be driven from a test.
  const src = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8");
  assert.match(src, /options: optionRows\.map\(\(\{ contextTokens, kind, \.\.\.row \}\) => row\)/);
  // ...and the fields really are on the built row, or the strip would be a no-op
  // that passes this test while the schema violation lives somewhere else.
  const { chosen, vault, catalog } = capabilityFixture();
  const rows = buildProviders(chosen, vault, catalog, () => "k").picker;
  assert.equal(rows.every((r) => "kind" in r), true);
  const written = rows.map(({ contextTokens, kind, ...row }) => row);
  const allowed = new Set(["model", "label", "description", "behavesAs"]);
  for (const row of written) {
    for (const k of Object.keys(row)) assert.ok(allowed.has(k), `unexpected key "${k}"`);
  }
});

// ---- T8: two-tier validation --------------------------------------------------
//
// Every rule asserts the MESSAGE names its reason, not merely that the problem
// count rose. A validation channel whose output is "1 problem" is a channel the
// next reader has to re-derive, which is how one stops being read.

// A minimal, otherwise-valid built set, so each rule below fails alone.
const OK_PROVIDERS = [{ name: "acme", provider: "acme", api_key: "x", models: ["m1"] }];
const OK_ROW = (o) => ({ model: "acme/m1", label: "acme > m1",
                         behavesAs: BUCKET_TARGETS.capable, kind: "text", ...o });

test("a clean build produces NO problems, so every rule below fails alone", () => {
  // The criterion an earlier revision made unsatisfiable by pointing tier 2 at
  // the pre-strip array. If this test cannot pass, none of the others mean
  // anything: they would only be measuring which failure fires first.
  assert.deepEqual(validate({ providers: OK_PROVIDERS, picker: [OK_ROW()] }, 1), []);
});

// The live table, and the fact that it is frozen -- which is what makes the rest
// of this block a property of the build rather than of the moment it ran.
test("the shipped bucket table passes its own rules, and cannot drift at runtime", () => {
  assert.deepEqual(validateBucketTable(), []);
  assert.deepEqual(validate({ providers: OK_PROVIDERS, picker: [OK_ROW()] }, 1), []);
  assert.equal(Object.isFrozen(BUCKET_TARGETS), true);
  assert.equal(Object.isFrozen(ALLOWED_BEHAVES_AS), true);
});

// WHY THESE DRIVE A TABLE ARGUMENT RATHER THAN THE CONSTANT. What stood here
// before re-implemented all three rules in its own body against the frozen
// constants and never called validate(): deleting the rules from keysync.mjs
// entirely left the suite green, so half the tier-1 rules had no test that could
// fail. Parameterising the table is what makes the failure branch reachable.
test("V1: a bucket target outside the allowlist is a problem naming the bucket", () => {
  // An allowlist rather than a denylist precisely because a denylist passes a
  // typo in silence, so the message has to carry the value it rejected.
  const problems = validateBucketTable(
    { ...BUCKET_TARGETS, capable: "claude-sonnet-4-51" });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /bucket "capable"/);
  assert.match(problems[0], /claude-sonnet-4-51/);
  assert.match(problems[0], /not in ALLOWED_BEHAVES_AS/);
});

test("V2: a target carrying a model-specific prompt bundle is refused, with the reason", () => {
  // A bundle is inherited by every third-party model pointed at that target, so
  // this is the rule that keeps one model's prompt profile from leaking onto 83
  // rows.
  //
  // THE ALLOWLIST IS INJECTED, and that is a finding rather than test
  // convenience: no entry in the live ALLOWED_BEHAVES_AS matches
  // PROMPT_BUNDLE_MODELS, so against today's constants V2 can only ever fire
  // together with V1 and is not independently observable. Widening the allowlist
  // to admit `claude-opus-5` is what isolates V2 -- and it models the exact edit
  // V2 exists to catch, someone adding a bundle-carrying id to the allowlist.
  const bundled = "claude-opus-5";
  assert.equal(PROMPT_BUNDLE_MODELS.test(bundled), true);
  assert.equal(ALLOWED_BEHAVES_AS.includes(bundled), false,
    "V1 would otherwise mask V2 -- see above");
  const problems = validateBucketTable({ ...BUCKET_TARGETS, capable: bundled },
                                       [bundled, ...ALLOWED_BEHAVES_AS]);
  assert.equal(problems.length, 1, "V1 admits it, so only V2 may fire");
  assert.match(problems[0], /claude-opus-5/);
  assert.match(problems[0], /model-specific prompt bundle/);
  assert.match(problems[0], /never be inherited by a third-party model/);
});

test("V6: unknown or nonchat pointed at the capable target is caught, not just capable === weak", () => {
  // THE CANARY FOR THE FAILURE THAT LOOKS LIKE SUCCESS. `capable !== weak` alone
  // guards one of three ways the table breaks: repointing `unknown` flips 38 rows
  // and `nonchat` 4 rows back into over-declaration with that inequality still
  // true and every other rule green.
  const unknownBroken = validateBucketTable(
    { ...BUCKET_TARGETS, unknown: BUCKET_TARGETS.capable });
  assert.equal(unknownBroken.length, 1);
  assert.match(unknownBroken[0], /BUCKET_TARGETS\.unknown points at the capable target/);

  const nonchatBroken = validateBucketTable(
    { ...BUCKET_TARGETS, nonchat: BUCKET_TARGETS.capable });
  assert.equal(nonchatBroken.length, 1);
  assert.match(nonchatBroken[0], /BUCKET_TARGETS\.nonchat points at the capable target/);

  // And the collapse the inequality DOES cover, with the message saying what a
  // collapsed table would do rather than merely that two names matched.
  const collapsed = validateBucketTable(
    { ...BUCKET_TARGETS, weak: BUCKET_TARGETS.capable });
  assert.ok(collapsed.some((p) => /classify without declaring anything/.test(p)));
});

test("the table rules are WIRED INTO validate(), not merely exported beside it", () => {
  // The three tests above have teeth only if the pipeline still runs the rules.
  // Extracting them created a second way for the acceptance criterion to go
  // unmet: keep validateBucketTable, tested and green, and drop its call site --
  // and every assertion above still passes while the pipeline validates nothing.
  //
  // Asserted against the function's own source rather than a file line, because
  // a line citation goes stale on the next insertion above it and this must not.
  assert.match(validate.toString(), /validateBucketTable\(/,
    "validate() must call validateBucketTable, or a broken table reaches the writer");
});

test("V3: a non-relay row with no behavesAs is a problem that names the row", () => {
  const picker = [OK_ROW({ behavesAs: undefined })];
  const problems = validate({ providers: OK_PROVIDERS, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /acme\/m1/);
  assert.match(problems[0], /not a bucket target/);
  // A target outside the table is the same failure with a different cause, and
  // the message must say WHICH value it saw -- a typo is the case V1's allowlist
  // exists for, and this is where a typo would actually surface.
  const typo = validate({ providers: OK_PROVIDERS,
    picker: [OK_ROW({ behavesAs: "claude-sonnet-4-51" })] }, 1);
  assert.equal(typo.length, 1);
  assert.match(typo[0], /claude-sonnet-4-51/);
});

test("V3: relay rows are exempt BY CONSTRUCTION, not by oversight", () => {
  // The relay rows carry no behavesAs because Claude Code already knows those
  // ids; a declaration there would be borrowed from the model itself. If this
  // exemption were dropped, every healthy live run would fail validation.
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       models: [...ANTHROPIC_RELAY.models] }];
  const picker = ANTHROPIC_RELAY.picker.map((m) => ({ model: `anthropic/${m}`, label: m }));
  assert.deepEqual(validate({ providers, picker }, 1), []);
});

test("V4: a duplicate picker row is named, because options[] is keyed by model", () => {
  const picker = [OK_ROW(), OK_ROW()];
  const problems = validate({ providers: OK_PROVIDERS, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /duplicate picker row "acme\/m1"/);
});

test("V5: a non-chat row declaring the capable target names the maximal-set reason", () => {
  // Inverted from the draft that had non-chat rows declare nothing. The message
  // has to carry WHY the weak target is required, or the next reader reads the
  // rule as arbitrary and "fixes" it by omitting the declaration -- which is the
  // maximal over-declaration, not the honest minimum.
  const picker = [OK_ROW({ kind: "nontext", behavesAs: BUCKET_TARGETS.capable })];
  const problems = validate({ providers: OK_PROVIDERS, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /non-chat row "acme\/m1"/);
  assert.match(problems[0], /maximal assumption set/);
  // ...and the same row declaring the weak target is fine.
  assert.deepEqual(validate({ providers: OK_PROVIDERS,
    picker: [OK_ROW({ kind: "nontext", behavesAs: BUCKET_TARGETS.weak })] }, 1), []);
});

test("V7: a filtered options[] throws, naming the count and the first lost row", () => {
  const built = [{ model: "anthropic/claude-opus-5" }, { model: "acme/m1" },
                 { model: "acme/m2" }];
  const scoped = built.filter((r) => r.model.startsWith("anthropic/"));
  assert.throws(() => assertOptionsComplete(built, scoped), (e) => {
    assert.match(e.message, /2 built row\(s\) did not reach modelPicker\.options/);
    assert.match(e.message, /first: "acme\/m1"/);
    assert.match(e.message, /only channel that can carry behavesAs/);
    return true;
  });
});

test("V8: a UW-side field surviving the strip throws, naming the key", () => {
  const built = [{ model: "acme/m1" }];
  assert.throws(() => assertOptionsComplete(built,
    [{ model: "acme/m1", label: "x", behavesAs: "claude-sonnet-4-5", kind: "text" }]),
    (e) => {
      assert.match(e.message, /would write key "kind"/);
      assert.match(e.message, /model, label\?, description\?, behavesAs\?/);
      return true;
    });
  assert.throws(() => assertOptionsComplete(built,
    [{ model: "acme/m1", contextTokens: 8192 }]), /would write key "contextTokens"/);
});

test("tier 2 returns normally on the array the write site really passes it", () => {
  // The regression an earlier revision shipped: handing V8 `optionRows` instead
  // of `settings.modelPicker.options` fires on EVERY row of EVERY clean build,
  // throws into the catch that restores settings.json from backup, and rolls back
  // a run that did nothing wrong. This drives both arrays through the real
  // strip expression and asserts the correct one passes while the other does not.
  const { chosen, vault, catalog } = capabilityFixture();
  const built = buildProviders(chosen, vault, catalog, () => "k");
  const optionRows = orderNativePickerOptions(built.picker);
  const written = optionRows.map(({ contextTokens, kind, ...row }) => row);
  assert.doesNotThrow(() => assertOptionsComplete(built.picker, written));
  assert.throws(() => assertOptionsComplete(built.picker, optionRows),
    /would write key "kind"/,
    "the pre-strip array is the wrong argument, and this is what proves it");
});

test("the write site calls tier 2 on the post-strip array, after the assignment", () => {
  // Asserted against the source: the call runs only under --target, which no test
  // may drive. Order matters as much as the argument -- called before the
  // assignment there would be nothing to pass.
  const src = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8");
  const assign = src.indexOf("settings.modelPicker = {");
  const call = src.indexOf("assertOptionsComplete(built.picker, settings.modelPicker.options)");
  const write = src.indexOf("atomicWriteJson(SETTINGS, settings)");
  assert.ok(assign > 0 && call > assign, "tier 2 runs after modelPicker is assigned");
  assert.ok(write > call, "and before the file is written");
  assert.equal(src.includes("assertOptionsComplete(built.picker, optionRows)"), false,
    "optionRows is pre-strip; passing it fails V8 on every clean build");
});

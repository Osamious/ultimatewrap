import { test } from "node:test";
import assert from "node:assert/strict";
import { isReserved, admitRemoteModels, RESERVED } from "../menu/denylist.mjs";
import { buildFrom } from "../menu/catalog.mjs";
import { buildProviders, ANTHROPIC_RELAY } from "../keysync/keysync.mjs";
// Imported for the S1 guard tests. `run.mjs` must therefore export
// `checkBareCollisions` and keep its pipeline behind an entry-point check rather
// than at module top level -- the same requirement Task B8 places on
// `checkProviderFloor`, and for the same reason. If importing run.mjs runs the
// pipeline, that is the defect to fix, not a reason to test the guard indirectly.
import { checkBareCollisions } from "../keysync/run.mjs";

test("importing run.mjs does not execute the keysync pipeline", () => {
  // Not a formality. Before the entry-point guard, run.mjs ran all 470 lines at
  // module load: it has top-level await at :101 and `process.exit(0)` on the dry
  // path at :192, and `node --test` passes no --target, so `dry` defaults true.
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

test("the relay's routing list holds eight ids and its picker list holds four", () => {
  // Missing this split ships a visibly broken menu: run.mjs maps the relay's
  // model list straight into picker rows, so four duplicate rows appear.
  //
  // The four full ids are the CURRENT verified set, not the plan's. The plan's
  // ANTHROPIC_FULL dropped claude-fable-5-1 and the dated claude-haiku-4-5-20251001
  // and added claude-opus-5-thinking, none of it verified against a live CCR --
  // inside a step whose prose describes only a split. Changing what the relay
  // advertises is out of scope here and needs its own verification.
  assert.deepEqual([...ANTHROPIC_RELAY.picker].sort(),
    ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001",
     "claude-fable-5-1"].sort());
  // The title says eight and four, so check eight and four -- the body previously
  // checked neither length nor that the picker ids survive into routing, so a
  // routing list that had LOST the four full ids would still have passed.
  assert.equal(ANTHROPIC_RELAY.routing.length, 8);
  assert.equal(ANTHROPIC_RELAY.picker.length, 4);
  for (const id of ANTHROPIC_RELAY.picker) {
    assert.ok(ANTHROPIC_RELAY.routing.includes(id),
      `routing must be a superset of picker; ${id} is missing`);
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
  assert.deepEqual([...ANTHROPIC_RELAY.models], [...ANTHROPIC_RELAY.picker],
    "models stays the four full ids so existing consumers are unaffected");
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

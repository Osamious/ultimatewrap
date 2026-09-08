import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReserved, admitRemoteModels, RESERVED } from "../menu/denylist.mjs";
import { buildFrom } from "../menu/catalog.mjs";
import { buildProviders, validate, ANTHROPIC_RELAY, ANTHROPIC_FULL,
         ANTHROPIC_ALIASES,
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
         ROUTING_MAX_STALENESS_MS, shouldReportCollisions,
         routableCatalogIds, vouchedBareClaudeProviders,
         loadDiscoveryCache } from "../keysync/run.mjs";

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
  // `uw-namespace` is the one reason `classifyRefusal` cannot produce: these ids
  // PASS `admitId`, and whether they are refused depends on the provider, which
  // sanitize.mjs never sees. `removed` is 0 because nothing was stripped -- the
  // name is reported in full, which is what makes the warning actionable.
  assert.deepEqual(r.rejected, [
    { id: "uw/fast",   reason: "uw-namespace", removed: 0 },
    { id: "uw/slot-1", reason: "uw-namespace", removed: 0 },
  ]);
});

test("the relay itself is exempt: uw/ from `anthropic` is no refusal at all", () => {
  // The other half of the same rule, and it must be "no entry", not "an entry
  // with a benign reason" -- the withheld count in the picker is derived from
  // `rejected.length`, so an exempt id appearing there at all would report our
  // own relay as withholding models from us.
  const r = admitRemoteModels("anthropic", ["uw/fast", "uw/slot-1", "claude-opus-5"]);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(r.kept, ["uw/fast", "uw/slot-1", "claude-opus-5"]);
});

test("every admitId rule reaches `rejected` under its own reason code", () => {
  // One fixture per code, asserting the CODE rather than the refusal. The pair
  // (id, reason) is what the withheld overlay renders, so a collapsed pair of
  // codes shows a user the wrong explanation for a missing model -- which is
  // worse than #51's silence, because it is silence that looks like an answer.
  //
  // `uw-namespace` is included here and nowhere in sanitize.test.mjs, because
  // this is the only layer that can produce it.
  const cases = [
    ["bad\x1b[2J",   "escape-sequence"],
    ["bell\x07",     "control-char"],
    ["a\u202Eb",    "invisible"],
    ["a b",          "whitespace"],
    ["a..b",         "traversal"],
    ["-lead",        "leading-separator"],
    ["@/f",          "bad-scope"],
    ["x".repeat(129), "too-long"],
    ["uw/fast",      "uw-namespace"],
  ];
  const r = admitRemoteModels("acme", cases.map(([id]) => id), { warn: false });
  assert.deepEqual(r.kept, [], "every fixture must actually be refused, or this proves nothing");
  assert.deepEqual(r.rejected.map((x) => x.reason), cases.map(([, code]) => code));
});

test("a rejection carries exactly {id, reason, removed} and no fourth field", () => {
  // THE #52 MUTATION GUARD. Reintroducing the raw string under any name -- `raw`,
  // `original`, `advertised` -- moves the egress rather than removing it, and the
  // stderr observable alone would not catch it, because the warn line reads `.id`.
  // So the shape itself is asserted, and then every string anywhere in the object
  // is scanned, which catches a raw field whatever it is called.
  const r = admitRemoteModels("acme", ["evil\x1b[2J", "\u202Eexe.gnp"], { warn: false });
  for (const entry of r.rejected) {
    assert.deepEqual(Object.keys(entry).sort(), ["id", "reason", "removed"],
      `a rejection grew a field: ${JSON.stringify(entry)}`);
    for (const v of Object.values(entry)) {
      if (typeof v !== "string") continue;
      assert.equal(TERMINAL_HOSTILE.test(v), false,
        `a rejection holds a terminal-hostile code point: ${JSON.stringify(entry)}`);
    }
  }
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

// Every code point that is an attack on a terminal rather than a character in a
// name: C0 (incl. ESC 0x1b and BEL 0x07), DEL, C1, and the zero-width/bidi class
// menu/sanitize.mjs enumerates. Written out here rather than imported so this
// test states its own subject and cannot be weakened by an edit to that module.
const TERMINAL_HOSTILE =
  /[\x00-\x1f\x7f-\x9f\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/;

test("#52: a refused id reaches neither `rejected` nor the SECURITY line raw", () => {
  // MEASURED BEFORE THE FIX: admitRemoteModels("tabiai", [the first fixture])
  // put 2 ESC and 1 BEL into the warn line, on ordinary stderr, during a normal
  // keysync run. `\x1b]52;c;<base64>\x07` is OSC 52 -- a CLIPBOARD WRITE. A
  // provider listing could put content into the operator's clipboard through
  // the security warning that refused it.
  //
  // WHY THIS CHANNEL IS NOW HOSTILE-ONLY, which is what makes it this ship's
  // problem rather than a latent one. Before the denylist inversion a rejection
  // was dominated by benign real ids the allowlist happened to refuse. After
  // it, an id can only be refused by one of admitId's named rules, and three of
  // them -- ESC_SEQ, CTRL, INVISIBLE -- ARE these attack classes.
  //
  // The assertion is on `rejected` AND on the warn line, deliberately.
  // Sanitising only at the console.warn would leave the raw string in the array
  // for the next reader to print; the producer must never hold the raw form.
  const hostile = [
    "evil\x1b[2J\x1b]52;c;aGk=\x07",  // CSI erase-display + OSC 52 clipboard write
    "bell\x07",                        // BEL alone
    "null\x00byte",                    // C0
    "del\x7fchar",                     // DEL, and the C1 range beyond it
    "\u202Eexe.gnp",                   // U+202E RLO: renders as a different name
    "\u200Bzero-width",
    "uw/fast",                         // the OTHER push, via the UW_ALIAS branch
  ];
  const warnings = [];
  const realWarn = console.warn;
  let r;
  console.warn = (m) => warnings.push(String(m));
  try { r = admitRemoteModels("tabiai", hostile); } finally { console.warn = realWarn; }

  assert.deepEqual(r.kept, [], "every fixture must actually be refused, or this proves nothing");
  assert.equal(r.rejected.length, hostile.length);
  for (const { id } of r.rejected) {
    assert.equal(TERMINAL_HOSTILE.test(id), false,
      `rejected[] holds a terminal-hostile code point: ${JSON.stringify(id)}`);
  }
  // `uw/fast` is the one fixture admitId ADMITS, so it exercises the second
  // push. Its input carries no attack class by construction -- admitId already
  // denies all three -- so sanitising there is structural rather than
  // load-bearing, and this asserts the name survives intact rather than that
  // anything was stripped from it.
  assert.ok(r.rejected.some((x) => x.id === "uw/fast" && x.removed === 0),
    "the UW_ALIAS branch still reports its id in full");

  assert.equal(warnings.length, 1, "one SECURITY line for the batch");
  assert.equal(TERMINAL_HOSTILE.test(warnings[0]), false,
    `the SECURITY line itself is an attack surface: ${JSON.stringify(warnings[0])}`);
  assert.equal(warnings[0].includes("\x1b"), false, "no ESC");
  assert.equal(warnings[0].includes("\x07"), false, "no BEL");
  assert.match(warnings[0], /SECURITY: provider "tabiai" advertised 7 rejected model name/);
});

test("#52 closing observable: the two attack fixtures, asserted on the RETURNED value", () => {
  // Asserted on what `admitRemoteModels` RETURNS, not on what this test then
  // does with it. That is the difference between "the one consumer under test is
  // safe" and "every future consumer is", and #52 is a finding about a consumer
  // nobody had written yet -- the warn line was the first, not the last.
  const ESC_ID = "evil\x1b[2J";                 // CSI erase-display
  const RLO_ID = "‮exe.gnp";               // renders as a different name entirely
  const r = admitRemoteModels("tabiai", [ESC_ID, RLO_ID], { warn: false });

  assert.deepEqual(r.kept, []);
  assert.equal(r.rejected.length, 2);

  const [esc, rlo] = r.rejected;
  assert.equal(esc.id.includes("\x1b"), false, "the ESC survived into `rejected`");
  assert.equal(esc.reason, "escape-sequence");
  assert.ok(esc.removed > 0, `nothing was reported stripped from ${JSON.stringify(ESC_ID)}`);

  assert.equal(rlo.id.includes("‮"), false, "U+202E survived into `rejected`");
  assert.equal(rlo.reason, "invisible");
  assert.ok(rlo.removed > 0, `nothing was reported stripped from ${JSON.stringify(RLO_ID)}`);

  // `removed` is a count of code points, and it must be the real one -- a
  // hardcoded 1 would satisfy `> 0` while telling a reader nothing.
  assert.equal(esc.removed, [...ESC_ID].length - [...esc.id].length);
  assert.equal(rlo.removed, 1, "exactly the one RLO was removed");
});

test("#52: real stderr from a warn:true call carries no ESC and no U+202E", () => {
  // The observable that fails on `main`, asserted against ACTUAL PROCESS STDERR
  // rather than a `console.warn` override. The override above proves the string
  // handed to console.warn is clean; only this proves the bytes that reach the
  // terminal are, which is what #52 is about. A child process is the only way to
  // read them.
  const src = `
    import { admitRemoteModels } from ${JSON.stringify(pathToFileURL(
      path.join(HERE, "..", "menu", "denylist.mjs")).href)};
    admitRemoteModels("tabiai", [
      "evil\\u001b[2J\\u001b]52;c;aGk=\\u0007",
      "\\u202Eexe.gnp",
      "bell\\u0007",
      "uw/fast",
    ], { warn: true });
  `;
  const out = spawnSync(process.execPath, ["--input-type=module"],
    { input: src, encoding: "utf8" });

  assert.equal(out.status, 0, `child failed: ${out.stderr}`);
  assert.match(out.stderr, /SECURITY: provider "tabiai" advertised 4 rejected model name/,
    "the warning must actually have been emitted, or this asserts nothing");
  assert.equal(out.stderr.includes("\x1b"), false, "an ESC reached the terminal");
  assert.equal(out.stderr.includes("\x07"), false, "a BEL reached the terminal");
  assert.equal(out.stderr.includes("‮"), false, "U+202E reached the terminal");
  assert.equal(TERMINAL_HOSTILE.test(out.stderr.replace(/\r?\n/g, "")), false,
    `stderr carries a terminal-hostile code point: ${JSON.stringify(out.stderr)}`);
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
  // INVERTED BY D1, and the subject is preserved rather than the fixture.
  // The `cannot` half used to be `claude-opus-4-8` with realIds omitted: a
  // retired name two resellers still list. D1 makes the null fallback
  // ANTHROPIC_FULL, so that id no longer classifies at all and the test would
  // have been asserting the remedy wording of a message that is never built.
  //
  // The PROPERTY under test is unchanged -- "start the relay" must not be
  // printed for an id the relay does not serve -- so the fixture moves to an id
  // that still classifies and that the relay still cannot serve:
  // claude-opus-4-1-20250805 is a real published Anthropic id (so realIds
  // carries it) and is absent from ANTHROPIC_RELAY.routing (asserted below, so
  // this fixture cannot rot silently if the routing list grows).
  assert.equal(ANTHROPIC_RELAY.routing.includes("claude-opus-4-1-20250805"), false,
    "the fixture's premise: the relay does not serve this id");
  const realIds = new Set([...ANTHROPIC_FULL, "claude-opus-4-1-20250805"]);
  const cannot = checkBareCollisions([P("tabiai", "claude-opus-4-1-20250805")], { realIds });
  assert.equal(cannot.fatal, true);
  assert.doesNotMatch(cannot.message, /start the Anthropic relay/,
    "an unachievable remedy is worse than none");
  assert.match(cannot.message, /--allow-bare-claude-names/);
  // ...and it is still offered where it works: `opus` is in the relay's routing list.
  const can = checkBareCollisions([P("tokenrouter", "opus")], { realIds });
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

test("the guard covers fable, and the RESERVED boundary bites on ONE branch only", () => {
  // REWRITTEN 2026-09-07, AND THE CATEGORY MATTERS. This is not a fixture that
  // encoded a defect. It faithfully asserted D1 -- "only ids Anthropic actually
  // publishes, plus the four aliases, can reach a verdict" -- and D1 was
  // REVERSED on the null branch after measurement (see the null-branch note in
  // run.mjs). The test was right; the decision under it moved.
  //
  // ITS SUBJECT IS NOW BRANCH-DEPENDENT, so both branches are asserted in one
  // test. Pinning either alone would pin one side of a boundary whose LOCATION
  // is the whole point: D1's narrowing survives where `realIds` exists, and
  // stops where it does not.

  // `fable` IS FATAL ON BOTH, and it is the half that was always worth having.
  // The old inline regex was /^(claude|opus|sonnet|haiku)([-\d]|$)/ and omitted
  // `fable` entirely; it is an alias Claude Code really does send, and the
  // aliases are unioned into the selector set on both branches, so a reseller
  // sole-owning it is a real hijack however the catalogue resolved.
  assert.equal(checkBareCollisions([P("evil", "fable")]).fatal, true,
    "fable is an alias Claude Code emits: a live hijack shape on the null branch");
  assert.equal(checkBareCollisions([P("evil", "fable")], { realIds: PROD_REAL_IDS }).fatal,
    true, "...and on the verified branch, where the aliases are unioned in too");

  // The other three are RESERVED-shaped strings Anthropic has never published.
  // `claude` is included deliberately: the bare vendor word is not a model id.
  for (const id of ["sonnet.1", "haiku_2", "claude"]) {
    assert.equal(isReserved(id), true, `${id} is still RESERVED-shaped`);

    // VERIFIED BRANCH -- D1's narrowing, intact. `realIds` says what Anthropic
    // publishes, nothing sends these bare, and a fatal on them would be a false
    // positive the guard has the evidence to avoid.
    assert.equal(checkBareCollisions([P("evil", id)], { realIds: PROD_REAL_IDS }).fatal,
      false, `${id} is not a published Anthropic id, and with realIds the guard KNOWS that`);

    // NULL BRANCH -- the boundary is where the narrowing stops. The selector set
    // is built from the advertised RESERVED-shaped ids, so these classify and go
    // fatal. That IS a false positive, and it is the accepted cost of the
    // breadth: the guard has no catalogue to rule them out with, and the
    // alternative measured 7 of 15 published Anthropic ids going silent. The
    // operator can see it and override it with --allow-bare-claude-names; the
    // alternative is a silent misroute. See the cost note in run.mjs, which
    // carries both denominators.
    assert.equal(checkBareCollisions([P("evil", id)]).fatal, true,
      `${id} is RESERVED-shaped and advertised, so the null branch classifies it`);
  }
});

test("DRIFT DETECTOR, and the pre-filter: INERT where selectors are constants, DECISIVE where they are advertised", () => {
  // RETITLED 2026-09-07, AND THE OLD TITLE IS WHY. It read "...so the pre-filter
  // is a no-op", which was true at R6 on both branches and is now true on one.
  // Every assertion below held throughout the reversal, which is exactly how the
  // false title survived a green suite: the test proved the PREMISE (all eight
  // classifiable ids match RESERVED) and never touched the CLAIM (that the filter
  // is therefore inert). Those were the same statement at R6; they are not any
  // more, and a maintainer reading the old title would conclude that widening or
  // narrowing RESERVED is free.
  //
  // MEASURED: disabling `if (!RESERVED.test(id)) continue;` killed 0 of 494 tests
  // at R6 and kills 8 of 502 now. The line went from provably dead to
  // load-bearing without its own diff.
  //
  //   realIds !== null  -- INERT. Ownership iterates `ANTHROPIC_ALIASES u
  //     realIds`, both constants, so the pre-filter cannot reject anything the
  //     selector set would have accepted.
  //   realIds === null  -- DECISIVE. The selector set is built FROM the ids this
  //     filter admits, so what it rejects is not merely unclassified: it is never
  //     a selector at all.

  // ---- the drift detector, unchanged in force ------------------------------
  // A no-op gate on the verified branch is only safe while this premise holds,
  // so it is asserted rather than assumed. The failure it catches is unchanged
  // by the reversal: someone adds an id to ANTHROPIC_FULL that RESERVED does not
  // match, the pre-filter drops it before classification, and the guard goes
  // SILENT on a real published Anthropic id.
  const classifiable = [...ANTHROPIC_ALIASES, ...ANTHROPIC_FULL];
  assert.equal(classifiable.length, 8,
    "4 aliases + 4 curated ids; if this changes, re-read the premise above");
  for (const id of classifiable) {
    assert.equal(RESERVED.test(id), true,
      `${id} is classifiable but does NOT match RESERVED -- the pre-filter would ` +
      `drop it and the guard would go silent on it`);
    // The same claim, driven through the guard rather than through the regex:
    // sole-owned by a non-relay provider, each of the eight must still be fatal.
    assert.equal(checkBareCollisions([P("evil", id)]).fatal, true,
      `${id} must survive the pre-filter and reach a verdict`);
  }
  // ...and the two definitions are still one definition, which is what the
  // original test was protecting. `isReserved` composes RESERVED with UW_ALIAS,
  // so this keeps the guard's notion of Claude-shaped tied to the denylist's.
  for (const id of classifiable) assert.equal(isReserved(id), true);

  // ---- what the old title stood in for, now asserted ------------------------
  // THE ASSERTION THE TITLE REPLACED. Proving the premise is not proving the
  // claim, and only one of the two was ever executed here. A non-Claude-shaped
  // id, ADVERTISED and SOLE-OWNED, is the case where the branches part: on the
  // null path it is non-fatal BECAUSE THE PRE-FILTER DROPPED IT before it could
  // become a selector, and deleting that line makes it a selector and this
  // assertion fail. On the verified path the same id is non-fatal for an
  // unrelated reason -- it is simply not in `ANTHROPIC_ALIASES u realIds` -- and
  // deleting the line changes nothing. That asymmetry IS the retitle.
  for (const id of ["opusculum", "hakuna-matata", "uwot", "qwen3-max"]) {
    assert.equal(isReserved(id), false,
      `${id} is not Claude-shaped by either definition`);

    // NULL BRANCH -- the pre-filter is the only thing standing between this id
    // and a fatal verdict. This is the assertion that dies if it is removed.
    assert.equal(checkBareCollisions([P("evil", id)]).fatal, false,
      `${id} must be dropped by the pre-filter before the null branch can make ` +
      `it a selector -- without that line, an advertised sole-owned non-Claude ` +
      `id goes FATAL`);
    assert.deepEqual(checkBareCollisions([P("evil", id)]).hijackable, [],
      `${id} must not even be a candidate on the null branch`);

    // VERIFIED BRANCH -- non-fatal for a different reason, and inert either way.
    assert.equal(checkBareCollisions([P("evil", id)], { realIds: PROD_REAL_IDS }).fatal,
      false, `${id} is not in ANTHROPIC_ALIASES u realIds, so the pre-filter ` +
      `decides nothing here`);
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

test("realIds omitted (default null) falls back to the ADVERTISED RESERVED-shaped set", () => {
  // RETITLED TWICE, AND THE TITLE IS THE ASSERTION HERE. It first read "keeps the
  // old broad RESERVED-only behaviour"; D1 made it "falls back to the CURATED
  // set, not to RESERVED"; D1 was then REVERSED on this branch, which made that
  // second title literally false. What the null default means now is
  // `ANTHROPIC_ALIASES u (the RESERVED-shaped ids the config advertises)`.
  //
  // WHY THE NULL PATH MATTERS. realIds is null only when the relay is
  // unreachable AND there is no cache -- the run prints
  // `UNAVAILABLE (relay down and no cache)` on exactly that path. It is the path
  // with the LEAST evidence, so it is the path that must not go quiet: the
  // curated fallback measured 7 of 15 published Anthropic ids silently
  // unclassified there (see the THREAT SET tests below).
  //
  // THE FALLBACK IS THE ADVERTISED SET, DEMONSTRATED BY AN ID NO CONSTANT IN THIS
  // REPO CARRIES. `claude-opus-5-thinking` is in neither ANTHROPIC_FULL nor
  // ANTHROPIC_ALIASES, so a curated fallback cannot classify it and an advertised
  // one must.
  assert.equal(new Set([...ANTHROPIC_FULL, ...ANTHROPIC_ALIASES]).has("claude-opus-5-thinking"),
    false, "the fixture's premise: no constant here carries this id");
  const invented = checkBareCollisions([P("tabiai", "claude-opus-5-thinking")]);
  assert.equal(invented.fatal, true,
    "advertised and RESERVED-shaped, so the null branch classifies it -- and with " +
    "no catalogue the guard cannot know that nothing sends it bare");
  assert.deepEqual(invented.hijackable.map((h) => h.id), ["claude-opus-5-thinking"]);

  // THE ACCEPTED COST, STATED AS A CONTRAST RATHER THAN LEFT IMPLICIT. The same
  // id is NOT a finding the moment there is evidence to rule it out, so the
  // false positive is confined to the no-evidence path and is not a permanent
  // property of the guard.
  assert.equal(checkBareCollisions([P("tabiai", "claude-opus-5-thinking")],
    { realIds: PROD_REAL_IDS }).fatal, false,
    "with realIds the guard knows Anthropic never published it: D1's narrowing, intact");

  // BROAD, NOT INDISCRIMINATE -- the two retained protections, on the same null
  // default. These held under D1 too and must keep holding: the reversal widened
  // the fallback, it did not change what the aliases or the curated ids mean.
  const alias = checkBareCollisions([P("tabiai", "opus")]);
  assert.equal(alias.fatal, true, "a bare alias is what Claude Code actually sends");
  const curated = checkBareCollisions([P("tabiai", "claude-opus-5")]);
  assert.equal(curated.fatal, true, "a curated id is still a real hijack shape");

  // ...and the pre-filter still gates: not Claude-shaped, never a selector.
  assert.equal(checkBareCollisions([P("tabiai", "qwen3-max")]).fatal, false);
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

// ---- the null path: breadth, and what it may not claim ---------------------
// The `realIds === null` branch is the relay-down, no-cache path. Two properties
// are asserted here and neither is asserted anywhere above: that the branch is
// BROAD enough to catch a real Anthropic id no constant in this repo carries, and
// that it does not report an all-clear it did not earn.

// AN INDEPENDENT THREAT SET, AND THE INDEPENDENCE IS THE POINT. Every set above
// is built from ANTHROPIC_FULL / ANTHROPIC_ALIASES -- the guard's own selector
// source on the narrow branch -- so a test written from them validates the guard
// against the set it defines, and passes however narrow that set becomes. That is
// exactly how a regression reached 496 green tests.
//
// PROVENANCE: `ANTHROPIC_ALIASES` unioned with Anthropic's live /v1/models as
// captured in `state/anthropic-ids-cache.json`. The dated ids are LITERAL rather
// than read from that file on purpose -- the file is untracked runtime state, and
// a test that reads it would silently weaken to whatever the cache last held.
// The four aliases are re-typed for the same reason.
const LIVE_ANTHROPIC_IDS = [
  "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-fable-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6",
  "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001",
  "claude-sonnet-4-5-20250929",
];
const THREAT_IDS = [...LIVE_ANTHROPIC_IDS, "opus", "sonnet", "haiku", "fable"];

test("THREAT SET: with the relay DOWN, every id Anthropic publishes is still caught", () => {
  // What D1 gave up, driven through the guard. A reseller sole-owning any name
  // Anthropic publishes is report 08 F1: Claude Code can send that name bare,
  // CCR's resolve() binds the single owner, and the full system prompt, tool
  // definitions and file contents go to that host. Nothing about the relay being
  // unreachable makes that less true, so nothing about it may make the guard
  // quieter.
  //
  // MEASURED at the time of writing: 15 of 15 caught under the broad null branch,
  // 8 of 15 under D1's ANTHROPIC_FULL fallback -- ANTHROPIC_FULL carries 4 of the
  // 11 live ids, and the 7 that went silent were claude-fable-5, claude-opus-4-8,
  // claude-opus-4-7, claude-sonnet-4-6, claude-opus-4-6, claude-opus-4-5-20251101
  // and claude-sonnet-4-5-20250929.
  assert.equal(THREAT_IDS.length, 15, "11 live ids + 4 aliases");

  // ANTI-TAUTOLOGY. If every threat id were inside the repo's own constants this
  // test could not tell the broad rule from the narrow one, and it would keep
  // passing through the exact reversion it exists to catch. Asserted, not assumed
  // -- and asserted as non-empty rather than as a fixed count, so a legitimate
  // curation edit that adds an id to ANTHROPIC_FULL narrows the gap without
  // failing the suite.
  const narrow = new Set([...ANTHROPIC_ALIASES, ...ANTHROPIC_FULL]);
  const outsideNarrow = THREAT_IDS.filter((id) => !narrow.has(id));
  assert.ok(outsideNarrow.length > 0,
    `${outsideNarrow.length} of ${THREAT_IDS.length} threat ids lie outside ` +
    `ANTHROPIC_ALIASES u ANTHROPIC_FULL; at zero this test can no longer ` +
    `distinguish the broad null branch from D1's narrow one`);

  for (const id of THREAT_IDS) {
    // realIds OMITTED: this is the null branch and nothing else.
    const r = checkBareCollisions([P("tokenrouter", id, "qwen3-max")]);
    assert.equal(r.fatal, true,
      `${id} is published by Anthropic, so Claude Code can send it bare and ` +
      `resolve() would bind tokenrouter -- the relay being down does not change that`);
    assert.deepEqual(r.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
      [{ id, owner: "tokenrouter" }],
      `${id} must be reported against the selector CCR would send, and its owner named`);
  }
});

test("THREAT SET: the shipped two-owner row goes FATAL the moment one owner drops it", () => {
  // REACHABLE ON REAL DATA, which is what makes the breadth load-bearing rather
  // than theoretical. The built config carries exactly two RESERVED-shaped bare
  // ids, both `claude-opus-4-8` (tabiai and gorouter). Two owners is `shadowed`
  // -- resolve() returns undefined, a clean failure. One owner is the hijack.
  const both = checkBareCollisions([
    P("tabiai", "claude-opus-4-8"), P("gorouter", "claude-opus-4-8"),
  ]);
  assert.equal(both.fatal, false, "two matching entries: resolve() binds nothing");
  assert.deepEqual(both.shadowed.map((s) => s.id), ["claude-opus-4-8"]);

  const one = checkBareCollisions([P("tabiai", "claude-opus-4-8")]);
  assert.equal(one.fatal, true,
    "one owner left, and it is not ours: this is the bind D1 reported as safe");
  assert.deepEqual(one.hijackable.map((h) => h.owner), ["tabiai"]);
});

test("the null path does not report a verified all-clear", () => {
  // THE DISCLOSURE, and the claim it replaces. "no bare Claude-shaped collisions"
  // is a statement about Anthropic's published ids; on the null path the guard
  // never saw them. Plan §2.6's principle for a refusal path, applied to a
  // silent-PROCEED path: an outcome that rests on something the run could not do
  // must say so.
  const clean = checkBareCollisions([P("tokenrouter", "qwen3-max")]);
  assert.deepEqual(clean.hijackable, []);
  assert.deepEqual(clean.shadowed, []);
  assert.equal(clean.catalogVerified, false, "realIds was null: nothing was verified");
  assert.notEqual(clean.message, "no bare Claude-shaped collisions",
    "the unqualified all-clear is a claim this run cannot make");
  assert.match(clean.message, /UNVERIFIED/);
  assert.match(clean.message, /relay down and no cache/,
    "and it names the condition, so the operator knows what to fix");
});

test("a VERIFIED run with nothing to report still says exactly that", () => {
  // The other half of the distinction: "checked, nothing found" must remain
  // available and must remain unqualified, or the disclosure degrades into noise
  // printed on every run.
  const r = checkBareCollisions([P("tokenrouter", "qwen3-max")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.catalogVerified, true);
  assert.equal(r.message, "no bare Claude-shaped collisions");
  assert.doesNotMatch(r.message, /UNVERIFIED/);
});

test("the disclosure rides on findings too, and gates nothing", () => {
  // NOT ONLY THE EMPTY BRANCH. A `shadowed` note classified by shape alone is as
  // much a claim about Anthropic's catalogue as an all-clear is -- and it is the
  // branch today's real config actually reaches.
  const sh = checkBareCollisions([P("a", "opus"), P("b", "opus")]);
  assert.equal(sh.fatal, false);
  assert.match(sh.message, /more than one match/);
  assert.match(sh.message, /UNVERIFIED/, "the shape-only basis is disclosed here too");

  // AND IT CHANGES NO VERDICT. `fatal` is still exactly "a hijackable finding,
  // not opted out of": the disclosure neither adds a fatal nor removes one, and
  // --allow-bare-claude-names silences the exit without silencing the disclosure.
  const fatal = checkBareCollisions([P("tokenrouter", "opus")]);
  assert.equal(fatal.fatal, true);
  assert.match(fatal.message, /UNVERIFIED/);
  const opted = checkBareCollisions([P("tokenrouter", "opus")], { allowBare: true });
  assert.equal(opted.fatal, false, "the opt-out still works, unchanged");
  assert.deepEqual(opted.hijackable.map((h) => h.id), ["opus"]);
  assert.match(opted.message, /UNVERIFIED/,
    "the opt-out silences the exit, never the disclosure");
});

test("a message nobody prints is not disclosure: the report condition covers it", () => {
  // THE OTHER HALF OF THE CONTROL. `checkBareCollisions` composing an honest
  // message is worthless if the call site never prints it -- and that is exactly
  // what happened: the inline condition was `hijackable.length || shadowed.length`,
  // so a findings-free unverified run reached the operator as NOTHING. The
  // condition is exported precisely because the entry-point block cannot be run
  // from a test.
  const cleanUnverified = checkBareCollisions([P("tokenrouter", "qwen3-max")]);
  assert.equal(shouldReportCollisions(cleanUnverified), true,
    "no findings, but the guard could not check: the operator must be told");

  const cleanVerified = checkBareCollisions([P("tokenrouter", "qwen3-max")],
    { realIds: PROD_REAL_IDS });
  assert.equal(shouldReportCollisions(cleanVerified), false,
    "a verified run with nothing to say stays quiet");

  // Findings still print on either path, which is the behaviour that predates
  // this change and must survive it.
  assert.equal(shouldReportCollisions(
    checkBareCollisions([P("tokenrouter", "claude-opus-5")], { realIds: PROD_REAL_IDS })), true);
  assert.equal(shouldReportCollisions(
    checkBareCollisions([P("a", "opus"), P("b", "opus")], { realIds: PROD_REAL_IDS })), true);
});

// ---- #53: the guard must model resolve()'s TWO-STAGE match -----------------
// The narrowing above filtered the ADVERTISED string with strict equality
// (`ANTHROPIC_ALIASES.includes(id)`, `realIds.has(id)`). Anthropic publishes
// lowercase, so a reseller advertising `Opus` was dropped before classification
// while CCR bound to it: `providerModelMatches` compares case-INSENSITIVELY
// once its exact stage finds nothing, and both sides are `.trim()`ed.
//
// The fix keys ownership on the SELECTOR (what Claude Code can send), not on
// the advertised spelling, and computes owners the way resolve() does: exact
// first, case-fold only if exact is empty.

// Production shape, modelling the `realIds` the run builds at its
// `checkBareCollisions` call site -- `liveCatalog.ids u ANTHROPIC_RELAY.models`.
// (Cited by symbol on purpose: a line number here goes stale in the same commit
// that adds it.) The load-bearing property is that it contains NO bare alias:
// Anthropic's /v1/models lists dated ids only, so `opus` reaches the guard
// solely through ANTHROPIC_ALIASES.
const PROD_REAL_IDS = new Set([...ANTHROPIC_FULL, "claude-opus-4-1-20250805"]);

test("#53: a case-variant bare alias sole-owned by a reseller is FATAL", () => {
  // OBSERVABLE (1) -- the failing-today case. Each of these is a distinct
  // spelling CCR's fold stage binds and the strict-equality narrowing dropped.
  //
  // The ENTRY is asserted, not just the verdict: `hijackable[].id` is the
  // SELECTOR, and a `fatal`-only assertion would pass on the right verdict with
  // the wrong id -- which is exactly the residual F2 records.
  for (const [advertised, selector] of [
    ["Opus", "opus"], ["OPUS", "opus"], ["Claude-Opus-5", "claude-opus-5"],
  ]) {
    const r = checkBareCollisions([P("tokenrouter", advertised)],
      { realIds: PROD_REAL_IDS });
    assert.equal(r.fatal, true,
      `${advertised} folds onto a real Anthropic selector and must not be dropped`);
    assert.deepEqual(r.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
      [{ id: selector, owner: "tokenrouter" }],
      `${advertised} must be reported against the selector CCR would send`);
  }
});

test("#53: the EXACT owner wins when exact and fold disagree", () => {
  // OBSERVABLE (2) -- what stops the fix being half-made. CCR's stage B4 finds
  // exactly one EXACT match for `opus` and binds gorouter; tabiai's `Opus` is
  // never consulted, because the fold stage runs only when exact is empty.
  //
  // Exact is always a SUBSET of the fold, so the stages cannot name disjoint
  // owners; what differs is the COUNT, and through it the verdict. A fold-first
  // implementation sees two entries here and reports a safe ambiguity -- and
  // still passes observable (1). Dropping the exact stage entirely is the SAME
  // program as running the fold first, not a second mutation.
  const r = checkBareCollisions([P("tabiai", "Opus"), P("gorouter", "opus")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.fatal, true,
    "exact-before-fold: one exact owner binds, so this is a sole claim, not an ambiguity");
  assert.deepEqual(r.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
    [{ id: "opus", owner: "gorouter" }]);
});

test("#53/A1: leading whitespace does not hide a sole claim", () => {
  // OBSERVABLE (3), and what it guards has CHANGED SHAPE since it was written.
  // `providerModelMatches` does `let a = s.trim()`, so CCR binds ` opus` to the
  // selector `opus`, and the guard must trim before it compares.
  //
  // CORRECTED 2026-09-07. This said the id "cannot reach the guard on main --
  // `admitId` still rejects it, because the ALLOWLIST anchors on an
  // alphanumeric -- and it goes live the moment R2 inverts that allowlist".
  // R2 landed and there is no allowlist. `admitId` still rejects ` opus`, but
  // now by the `WHITESPACE` rule in `menu/sanitize.mjs`, added by name for
  // exactly this reason -- so the hazard is PERMANENTLY not live rather than
  // pending a ship. CTRL is [\x00-\x1f\x7f-\x9f] and space is 0x20, outside
  // it, so `WHITESPACE` is the only thing denying it.
  //
  // That is a different and still-good reason to keep this test: it is the
  // assertion that fails if the guard stops trimming, and the thing standing
  // between it and reality is one named rule that someone could relax as
  // over-strict. Delete `WHITESPACE` and this becomes live immediately.
  const r = checkBareCollisions([P("tokenrouter", " opus")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.fatal, true,
    "CCR trims both sides before comparing, so the guard must too");
  assert.deepEqual(r.hijackable.map((h) => h.owner), ["tokenrouter"]);
});

// ---- B1: ownership counts MATCHING ENTRIES, not providers ------------------
// `providerModelMatches` pushes once per matching entry of `i.models`:
//
//   for (let s of i.models) { let a = s.trim(), c = r ? a.toLowerCase() : a;
//                             a && c === n && o.push({model: a, provider: i}) }
//
// and `resolve()` returns undefined when that list has length > 1. So a
// name-keyed accumulator over-reports: it collapses two matching ENTRIES into
// one owner and calls FATAL on a config CCR refuses to route. That matters more
// than a normal false positive because `fatal` is gated by one run-wide
// `allowBare` boolean -- the only escape from a false FATAL also silences every
// true positive in the same run.

test("B1: two case-spellings at ONE provider are two matches, so nothing binds", () => {
  // The fold stage finds `Opus` AND `OPUS`, both folding to `opus`. CCR pushes
  // two entries and resolve() returns undefined. Reporting a sole owner here
  // would be a FATAL against a config that cannot be hijacked.
  const r = checkBareCollisions([P("tokenrouter", "Opus", "OPUS")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.fatal, false, "two matching entries bind nothing");
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed.map((s) => s.id), ["opus"]);
  assert.deepEqual(r.shadowed[0].owners, ["tokenrouter"],
    "one provider is named once: the COUNT decided the verdict, the NAMES are shown");
});

test("B1/F3: a byte-identical duplicate id at one provider is two matches", () => {
  // The exact stage, same rule. `models: ["opus", "opus"]` is two entries in
  // the array CCR iterates, so it pushes twice and binds nothing.
  const r = checkBareCollisions([P("tokenrouter", "opus", "opus")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.fatal, false, "a duplicate entry is a second match, not a no-op");
  assert.deepEqual(r.shadowed.map((s) => s.id), ["opus"]);
  assert.deepEqual(r.shadowed[0].owners, ["tokenrouter"],
    "two entries, one provider: named once at render");
});

test("B1/L16: two providers SHARING a name are two matches, not one owner", () => {
  // The residual the plan previously documented and accepted. CCR matches per
  // provider entry and finds two; a Set keyed on the provider NAME collapsed
  // them into one and read a sole owner. Entry-counting resolves it.
  const r = checkBareCollisions([P("tabiai", "opus"), P("tabiai", "opus")],
    { realIds: PROD_REAL_IDS });
  assert.equal(r.fatal, false, "two provider entries sharing a name still bind nothing");
  assert.deepEqual(r.shadowed.map((s) => s.id), ["opus"]);
  assert.deepEqual(r.shadowed[0].owners, ["tabiai"]);
});

test("B1: the relay's TWO entries for one selector are two matches, counted then deduplicated", () => {
  // ITS SUBJECT WAS REMOVED BY A2, AND ITS OLD EXPECTATION WAS AN OVER-REPORT.
  // This asserted `fatal: true` under the title "the relay strip removes EVERY
  // relay entry, not one per name", guarding `effective = owners.filter(o => o
  // !== relay)` against a strip that dropped only the first relay entry. There is
  // no strip: A2 computes the verdict from the unstripped `owners`, so the
  // mechanism this named no longer exists and the mutant it was built to kill has
  // no line to be applied to.
  //
  // THE OLD VERDICT WAS WRONG, NOT MERELY OBSOLETE, AND THAT IS WHY THIS IS NOT A
  // LOST PROTECTION. Stripping both relay entries left `["tokenrouter"]` and
  // claimed a bind CCR would never make: `providerModelMatches` finds THREE
  // matching entries here, `resolve()` sees `s.length > 1` and returns undefined,
  // so nothing is routed anywhere. `shadowed` is the faithful verdict. Under #9
  // the old FATAL was not a free over-caution either -- every false FATAL pushes
  // the operator toward `--allow-bare-claude-names`, which disarms the guard for
  // every id in the run.
  //
  // WHAT IS STILL LIVE, AND WHY THE FIXTURE IS KEPT RATHER THAN DELETED. A relay
  // holding TWO matching entries for ONE selector is a shape no other test in this
  // file produces, and entry counting is entirely alive. Routing auto-add can only
  // add the id once, but ownership must not depend on that.
  const liveId = "claude-opus-4-1-20250805";   // in PROD_REAL_IDS, not curated
  const r = checkBareCollisions(
    [P("anthropic", liveId, liveId), P("tokenrouter", liveId)],
    { realIds: PROD_REAL_IDS, relayOwned: new Set(ANTHROPIC_FULL) });
  assert.equal(r.fatal, false,
    "three matching entries: resolve() returns undefined, so there is no bind to report");
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed.map((s) => s.id), [liveId]);
  // THE COUNT AND THE RENDER, IN ONE ASSERTION. Three entries decided the verdict;
  // two NAMES are shown, because the operator has two providers to look at, not
  // three. Both halves of R0's work are pinned here -- ownership counts entries,
  // deduplication happens only at render.
  assert.deepEqual(r.shadowed[0].owners, ["anthropic", "tokenrouter"]);
  assert.equal(r.shadowed[0].relayRoutes, true);
  assert.equal(r.shadowed[0].vouched, false,
    "the relay routes it and does not curate it, which the message must say");

  // THE DISCRIMINATING CASE, and the reason the pair above is not enough: with
  // tokenrouter removed the relay's two entries stand alone. Entry counting sees
  // 2 and reports a shadowed finding whose owner list renders as ONE name. A
  // name-keyed accumulator would see a single owner, that owner IS the relay, and
  // the id would fall through both branches to no finding at all. This is the
  // assertion a name-collapsing mutation cannot survive, and it is the relay-side
  // half of entry counting that the deleted strip assertion used to cover.
  const relayOnly = checkBareCollisions([P("anthropic", liveId, liveId)],
    { realIds: PROD_REAL_IDS, relayOwned: new Set(ANTHROPIC_FULL) });
  assert.equal(relayOnly.fatal, false);
  assert.deepEqual(relayOnly.shadowed.map((s) => s.id), [liveId],
    "two entries from one provider are still an ambiguity, even when that provider is us");
  assert.deepEqual(relayOnly.shadowed[0].owners, ["anthropic"],
    "counted as two, named once");

  // ...and the control that proves the finding above came from the SECOND entry
  // rather than from the relay's mere presence: one entry is one match, the sole
  // owner is the relay, and there is nobody to be hijacked by.
  const relayOnce = checkBareCollisions([P("anthropic", liveId)],
    { realIds: PROD_REAL_IDS, relayOwned: new Set(ANTHROPIC_FULL) });
  assert.deepEqual(relayOnce.shadowed, []);
  assert.deepEqual(relayOnce.hijackable, []);
});

test("B1 control: entry-counting must not disarm the sole-owner FATAL", () => {
  // THE PAIR THAT KEEPS THE FIX FROM BECOMING A BLANKET EXEMPTION. If counting
  // entries ever made every id ambiguous, these two would flip and #53 would be
  // back. Pinned with their owners, not just their verdicts.
  const sole = checkBareCollisions([P("tokenrouter", "opus")], { realIds: PROD_REAL_IDS });
  assert.equal(sole.fatal, true);
  assert.deepEqual(sole.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
    [{ id: "opus", owner: "tokenrouter" }]);

  const exactWins = checkBareCollisions([P("tabiai", "Opus"), P("gorouter", "opus")],
    { realIds: PROD_REAL_IDS });
  assert.equal(exactWins.fatal, true);
  assert.deepEqual(exactWins.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
    [{ id: "opus", owner: "gorouter" }]);
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

test("R7 observable (b): a reseller co-claiming an UNCURATED id the relay routes is REPORTED, not fatal", () => {
  // INVERTED BY A2 (plan §1.1, §6.0 row 5). This asserted `fatal: true` under the
  // title "a reseller sole-claiming a live-but-UNCURATED id is still FATAL", and
  // its stated rationale -- "the relay is present in Providers[].models for this
  // id, and that must NOT be what makes tabiai's sole claim acceptable" --
  // REVERSES. tabiai's claim is not sole: `providerModelMatches` finds the relay's
  // entry AND tabiai's, `resolve()` sees `s.length > 1` and returns undefined, so
  // CCR binds NOTHING and there is no hijack to report. The old verdict was a
  // false positive on the one row where CCR already refuses to route.
  //
  // WHAT REPLACES THE PROTECTION IS THE MESSAGE, and that is what this now pins.
  // The distinction the stripping used to enforce by classifying is still
  // computed and now RENDERED: this ambiguity came from our own auto-add, not
  // from a human review, and the operator is told so.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-5", "claude-opus-4-8"] },   // auto-added
    P("tabiai", "claude-opus-4-8", "reseller-chat-1"),
  ], { realIds: new Set(["claude-opus-5", "claude-opus-4-8"]), relayOwned: CURATED });
  assert.equal(r.fatal, false,
    "two matching entries, so resolve() returns undefined -- a clean failure, not a misroute");
  assert.deepEqual(r.hijackable, [], "the sole-owner branch requires the relay to be ABSENT");
  assert.deepEqual(r.shadowed.map((s) => s.id), ["claude-opus-4-8"]);
  assert.deepEqual(r.shadowed[0].owners, ["anthropic", "tabiai"],
    "and the relay is named as the co-owner it really is");
  assert.equal(r.shadowed[0].relayRoutes, true);
  assert.equal(r.shadowed[0].vouched, false);
  assert.match(r.message, /claude-opus-4-8 \(anthropic, tabiai; the relay routes this id but does not curate it\)/,
    "H5: the note moved to the branch that can carry it, and it renders here");
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

test("R7 observable (d): an uncurated id the relay ALONE serves is not a finding", () => {
  // ASSERTIONS UNCHANGED, RATIONALE CORRECTED BY A2. This read "stripping the
  // relay must not manufacture findings either", and there is no stripping any
  // more, so that sentence described a mechanism the code no longer has. The
  // verdict is identical and arrives by a different route: `owners` is length 1
  // and its one member IS the relay, so it fails `owners[0] !== relay` and falls
  // through the `> 1` branch too. Nobody else claims the id, so there is no one
  // to be hijacked by -- which was always the real reason.
  const r = checkBareCollisions([{ name: "anthropic", models: ["claude-opus-4-8"] }],
    { realIds: new Set(["claude-opus-4-8"]), relayOwned: CURATED });
  assert.equal(r.fatal, false);
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed, []);
  assert.equal(r.message, "no bare Claude-shaped collisions");
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

test("END TO END: the sets the pipeline derives report an auto-add ambiguity, and still arm FATAL when the relay is absent", () => {
  // INVERTED BY A2 (plan §1.1, §6.0 row 7). This is the most dangerous edit in
  // the plan and the plan says so: this test was written specifically to catch
  // the regression 3fa8025 fixed -- the regression A2 deliberately reverses --
  // and its own comment read "Nothing exercised the WIRING, which is precisely
  // where the regression lived." So the DERIVATION and the CONSTRUCTION are kept
  // exactly as they were and only the verdict moves, and a relay-ABSENT fatal
  // case is added below so the wired path still has a case that goes fatal.
  // Flipping the boolean without that addition would leave the wiring untested,
  // which is the failure this test exists to prevent.
  //
  // MUTATION-FOUND GAP, still the reason it is built this way. The guard tests
  // above pass `relayOwned: CURATED` by hand and the derivation tests assert set
  // shapes, so a mutation at the ROOT CAUSE (`relayOwned: new Set(routingIds)`,
  // which is literally what shipped) was caught only by an abstract invariant.
  const live = new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]);
  const { routingIds, relayOwned } = deriveAnthropicSets(live, ANTHROPIC_FULL);
  // The relay's Providers[] entry, exactly as the pipeline unshifts it.
  const providers = [
    { name: "anthropic", models: [...routingIds] },
    P("tabiai", "claude-opus-4-8", "reseller-chat-1"),
  ];
  const realIds = new Set([...live, ...ANTHROPIC_RELAY.models]);
  const r = checkBareCollisions(providers, { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(r.fatal, false,
    "auto-add made the relay a co-owner, so resolve() finds two entries and binds nothing");
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed.map((s) => s.id), ["claude-opus-4-8"]);
  assert.deepEqual(r.shadowed[0].owners, ["anthropic", "tabiai"],
    "the relay is NAMED as co-owner, which is what makes the non-fatal verdict readable");
  assert.match(r.message, /the relay routes this id but does not curate it/,
    "and the auto-add origin of the ambiguity is still reported, per A2's reporting half");

  // R7 OBSERVABLE (c) -- THE REPLACEMENT FATAL, BUILT THROUGH THE SAME WIRING.
  // The relay is DOWN or --no-anthropic, so the pipeline never unshifts its
  // entry: `owners = {tabiai}`, which IS resolve()'s bind condition. This is the
  // genuine report-08-F1 hijack and it must stay fatal under A2. Without this
  // case the end-to-end path would have no fatal left at all.
  const relayDown = checkBareCollisions([P("tabiai", "claude-opus-4-8", "reseller-chat-1")],
    { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(relayDown.fatal, true,
    "one matching entry and it is not ours -- resolve() binds tabiai");
  assert.deepEqual(relayDown.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
    [{ id: "claude-opus-4-8", owner: "tabiai" }]);

  // ...while a curated id in the same config is still the safe ambiguity.
  const curatedToo = checkBareCollisions([
    { name: "anthropic", models: [...routingIds] },
    P("tabiai", "claude-opus-5"),
  ], { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(curatedToo.fatal, false);
  assert.deepEqual(curatedToo.shadowed.map((s) => s.id), ["claude-opus-5"]);
  assert.doesNotMatch(curatedToo.message, /does not curate it/,
    "a REVIEWED co-ownership must not be reported as an unreviewed one");
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

test("an uncurated id the relay already routes is REPORTED as such, and needs no remedy at all", () => {
  // INVERTED BY A2 (plan §1.1a, §6.0 row 6): "becomes a reporting test or goes".
  // It asserted `fatal: true` plus a remedy reading "the relay already routes
  // these ids but they are not in the reviewed set (ANTHROPIC_FULL); review and
  // add them". That remedy branch is DELETED, and its deletion is what this test
  // now documents: the branch was gated on `h.relayRoutes`, and a hijackable
  // finding requires the relay to be absent from `owners`, so the two conditions
  // are contradictory and the branch could never be entered once `fatal` reads
  // the unstripped set. There is no remedy to print because there is nothing to
  // remedy -- CCR binds nothing on two matching entries.
  //
  // WHAT SURVIVES IS THE HONEST HALF. The old assertion `doesNotMatch(/start the
  // Anthropic relay/)` is kept and still means what it meant: the relay is
  // already running and already routes the id, so telling the operator to start
  // it is advice that changes nothing.
  const r = checkBareCollisions([
    { name: "anthropic", models: ["claude-opus-4-8"] },
    P("tabiai", "claude-opus-4-8"),
  ], { realIds: new Set(["claude-opus-4-8"]), relayOwned: CURATED,
       relayRouting: new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]) });
  assert.equal(r.fatal, false);
  assert.doesNotMatch(r.message, /start the Anthropic relay/);
  assert.doesNotMatch(r.message, /review and add/,
    "the deleted branch's wording must not survive anywhere else in the message");
  assert.doesNotMatch(r.message, /--allow-bare-claude-names/,
    "an escape hatch is offered only where something is actually being blocked");
  assert.match(r.message, /routes this id but does not curate it/,
    "and the note still says why the relay's ownership is not a human review");
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

test("R7 observable (a): a reseller sole-owning bare `opus` is FATAL, production-shaped", () => {
  // THE REAL report-08-F1 SHAPE, AND IT IS UNCHANGED BY A2 -- `owners` and
  // `owners \ {relay}` are the same list when the relay is not an owner, so the
  // one row A2 moves is not this one. Constructed the way run.mjs:762,771-772
  // does (#22): `realIds` = live u ANTHROPIC_RELAY.models, `relayOwned` and
  // `relayRouting` from deriveAnthropicSets. A test that defaulted any of the
  // three would exercise a path production never uses.
  const { routingIds, relayOwned } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);
  const realIds = new Set([...LIVE, ...ANTHROPIC_RELAY.models]);
  const r = checkBareCollisions([P("tabiai", "opus", "reseller-chat-1")],
    { realIds, relayOwned, relayRouting: routingIds });
  assert.equal(r.fatal, true, "one entry, not ours: resolve() binds it");
  assert.deepEqual(r.hijackable.map((h) => ({ id: h.id, owner: h.owner })),
    [{ id: "opus", owner: "tabiai" }]);
  assert.deepEqual(r.shadowed, []);
  assert.match(r.message, /--allow-bare-claude-names/);
});

test("R7/H5 COVERAGE: no reachable config produces a hijackable finding the relay routes", () => {
  // A COVERAGE ASSERTION, NOT A BEHAVIOURAL ONE, AND THE DIFFERENCE IS STATED
  // RATHER THAN PAPERED OVER. A2 deleted `routedNotVouched` and its remedy branch
  // because both were gated on `h.relayRoutes`, which the hijackable branch makes
  // structurally false. Re-introducing that branch would leave it UNREACHABLE, so
  // no behavioural test can fail on it -- there is no input that enters it. What
  // is falsifiable is the premise the deletion rests on, and that is what this
  // exhausts: over every owner multiset drawable from {relay, tabiai, gorouter}
  // up to size 3, on both the vouched and unvouched branch, no hijackable finding
  // ever carries `relayRoutes: true`. If that ever becomes possible, the deleted
  // branch was load-bearing and this test is the one that says so.
  const NAMES = ["anthropic", "tabiai", "gorouter"];
  const ID = "claude-opus-4-8";                       // real, live, not curated
  const realIds = new Set([...ANTHROPIC_FULL, ID]);
  let sawHijackable = 0, sawShadowedRelay = 0, cases = 0;
  const multisets = [];
  for (const a of NAMES) {
    multisets.push([a]);
    for (const b of NAMES) {
      multisets.push([a, b]);
      for (const c of NAMES) multisets.push([a, b, c]);
    }
  }
  for (const owners of multisets) {
    for (const relayOwned of [CURATED, new Set([...ANTHROPIC_FULL, ID])]) {
      // One provider entry per owner slot -- entry-counting means duplicate names
      // are two matches, which is exactly the shape that must not slip through.
      const r = checkBareCollisions(owners.map((n) => P(n, ID)), { realIds, relayOwned });
      cases++;
      for (const h of r.hijackable) {
        sawHijackable++;
        assert.equal(h.relayRoutes, false,
          `hijackable ${h.id} claimed the relay routes it, owners=[${owners}] -- the ` +
          `deleted routedNotVouched branch would have been reachable after all`);
        assert.doesNotMatch(r.message, /routes this id but does not curate it/);
      }
      for (const s of r.shadowed) if (s.relayRoutes && !s.vouched) sawShadowedRelay++;
    }
  }
  // The exhaustion must have actually exercised both branches, or it proves
  // nothing: an empty domain trivially satisfies a universal claim.
  assert.equal(cases, 78, "39 owner multisets x 2 vouching states");
  assert.ok(sawHijackable > 0, `${sawHijackable} hijackable findings were examined`);
  assert.ok(sawShadowedRelay > 0,
    `${sawShadowedRelay} shadowed findings DID carry the relay-routes-unvouched note, ` +
    `so the note is reachable on the branch it moved to`);
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

// FIXTURE NOTE, 2026-09-07. The four fixtures below and the V3 one further down
// name themselves `anthropic` and previously omitted `api_base_url`. That was
// never a production shape -- run.mjs spreads ANTHROPIC_RELAY, which carries the
// field, and buildProviders sets `api_base_url: baseUrl` on every entry it emits
// -- and V10 only tolerated it because its guard short-circuited on an absent
// url, which is #79. With that inverted, an absent url is the impostor shape, so
// these fixtures declare the relay's own url. Not one assertion below changed:
// each still asserts exactly what its title says, about [1m] and V3.
test("validate() accepts a [1m]-suffixed picker row against a bare models[] entry", () => {
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       api_base_url: ANTHROPIC_RELAY.api_base_url,
                       autoFetchModels: false, models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-opus-5[1m]", label: "x" }];
  assert.deepEqual(validate({ providers, picker }, 1), []);
});

test("validate() still rejects a picker row with no corresponding models[] entry", () => {
  // The tolerance must be narrow: stripping [1m] must not become "any string
  // is close enough". A genuinely absent id is still a real problem.
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       api_base_url: ANTHROPIC_RELAY.api_base_url,
                       autoFetchModels: false, models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-sonnet-5[1m]", label: "x" }];
  const problems = validate({ providers, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /claude-sonnet-5\[1m\]/);
});

test("validate() accepts the real ANTHROPIC_RELAY picker against its own models", () => {
  // The actual shapes this fix exists for, exercised together rather than each
  // asserted on in isolation.
  const providers = [{ name: "anthropic", provider: "anthropic", api_key: "x",
                       api_base_url: ANTHROPIC_RELAY.api_base_url,
                       autoFetchModels: false, models: [...ANTHROPIC_RELAY.models] }];
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
                       api_base_url: ANTHROPIC_RELAY.api_base_url,
                       autoFetchModels: false, models: [...ANTHROPIC_FULL] }];
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

test("relayOwned NEVER grows with live data -- the invariant the guard's REPORTING rests on", () => {
  // RATIONALE-ONLY CORRECTION UNDER A2 (plan §1.1a, §6.0's trailing paragraph).
  // Every assertion below is unchanged and still holds; what was false was the
  // reason given for them. This read: "if the VOUCHED set were computed the same
  // way, the relay would own every id the guard considers and its FATAL path
  // could never fire." Under A2 the guard classifies from the unstripped
  // `owners`, so the FATAL path is reachable by construction and no value of
  // relayOwned can close it.
  //
  // WHAT REUNIFICATION WOULD ACTUALLY COST, WHICH IS WHY THE RULE STAYS.
  // `vouched()` would become universally true, and the two things vouching still
  // decides would both fail silently: the shadowed finding would stop saying "the
  // relay routes this id but does not curate it", so an ambiguity our own
  // auto-add manufactured would read identically to one a human reviewed; and
  // `relayHelps` would start offering "start the Anthropic relay" for ids the
  // relay merely routes -- the unachievable-remedy class claude-opus-4-8 taught
  // this file not to print. relayOwned must stay curated-only, and must therefore
  // be a strict subset whenever live data adds anything.
  //
  // `routingIds` and the guard's `realIds` both reduce to `live u curated`, which
  // is why computing the vouched set the same way is the tempting edit.
  const { routingIds, relayOwned, relayAliases } = deriveAnthropicSets(LIVE, ANTHROPIC_FULL);

  // Asserted as the INVARIANT, not as a literal set. The literal was
  // ANTHROPIC_FULL until 2026-09-06, when the four static bare aliases had to
  // join relayOwned -- without them the relay could not vouch for the ids it
  // most certainly serves, and co-owning bare `opus` read as an unvouched sole
  // owner and went FATAL on a merely-ambiguous config. The rule was never
  // "curated only"; it is "nothing that came from LIVE data".
  const vouchable = new Set([...ANTHROPIC_FULL, ...relayAliases]);
  for (const id of relayOwned) {
    assert.equal(vouchable.has(id), true,
      `relayOwned gained "${id}", which is neither curated nor a static alias`);
  }
  for (const id of LIVE) {
    if (ANTHROPIC_FULL.includes(id)) continue;
    assert.equal(relayOwned.has(id), false,
      `relayOwned absorbed the live id "${id}" -- the FATAL path is now unreachable`);
  }
  assert.ok(relayOwned.size < routingIds.size + relayAliases.length,
    "live data added ids the relay does not vouch for");
});

test("the four bare aliases survive the realIds narrowing -- they are what CC actually sends", () => {
  // THE REGRESSION TEST FOR A LIVE HIJACK HOLE, open from eeea057 to 2026-09-06.
  // The narrowing's premise was "Claude Code never emits a name Anthropic has not
  // published". False for precisely the four names it emits most: Anthropic's
  // /v1/models lists dated ids and never bare aliases, and ANTHROPIC_RELAY.models
  // is ANTHROPIC_FULL (dated), so realIds contains none of `opus`/`sonnet`/
  // `haiku`/`fable`. All four were skipped before classification on every run
  // where the catalogue resolved -- including from a stale cache, the normal path.
  //
  // INVISIBLE TO 412 TESTS because every existing alias test omitted `realIds`
  // and so exercised the null path run.mjs never uses. This one passes the
  // production shape, which is the only reason it can fail.
  const liveIds = new Set([...ANTHROPIC_FULL, "claude-opus-4-8"]);
  const realIds = new Set([...liveIds, ...ANTHROPIC_RELAY.models]);
  const { relayOwned, routingIds, relayAliases } = deriveAnthropicSets(liveIds, ANTHROPIC_FULL);

  assert.equal(realIds.has("opus"), false,
    "the premise: realIds genuinely does not contain the bare aliases");

  const hostile = checkBareCollisions([{ name: "tokenrouter", models: ["opus"] }],
    { realIds, relayOwned });
  assert.equal(hostile.fatal, true,
    "a reseller sole-owning bare opus with the relay down is report 08 F1 itself");
  assert.match(hostile.message, /opus/);

  // ...and the relay co-owning it is still merely ambiguous, not a hijack:
  // CCR's resolve() returns undefined on a two-owner bare name rather than
  // binding either host.
  const shared = checkBareCollisions(
    [{ name: "tokenrouter", models: ["opus"] },
     { name: "anthropic", models: [...routingIds, ...relayAliases] }],
    { realIds, relayOwned });
  assert.equal(shared.fatal, false, "co-owned is shadowed, not fatal");

  // The narrowing still does its own job: a reseller invention is not a threat.
  const invented = checkBareCollisions([{ name: "tabiai", models: ["claude-opus-5-thinking"] }],
    { realIds, relayOwned });
  assert.equal(invented.fatal, false, "the narrowing must survive the alias exemption");
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
  const { routingIds, relayOwned, pickerIds, relayAliases } =
    deriveAnthropicSets(null, ANTHROPIC_FULL);
  assert.deepEqual([...routingIds].sort(), [...ANTHROPIC_FULL].sort());
  assert.deepEqual([...pickerIds], [...ANTHROPIC_FULL]);
  // Vouched = curated PLUS the static aliases. The aliases are hardcoded, so
  // they are available to vouch even with the relay unreachable -- which is the
  // case that matters, since a reseller sole-owning bare `opus` while the relay
  // is down is the hijack this guard exists for.
  assert.deepEqual([...relayOwned].sort(),
    [...ANTHROPIC_FULL, ...relayAliases].sort());
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
  // testModel first, then catalogue rank: `outputKind` (non-text last), then the
  // repaired tier (free first), then shortest id. `acme-embed` declares
  // `["embedding", "text"]`, so it is `nontext` and sorts last despite having the
  // shorter id; nothing here is priced, so the tier term is a tie for all three
  // and length decides between `probe-1` and `acme-vision`.
  //
  // AMENDED BY R3 (#10), AND RECORDED RATHER THAN CORRECTED SILENTLY. This
  // assertion used to expect `[probe-1, acme-embed, acme-vision]` under the
  // comment:
  //
  //   > testModel first, then catalogue rank -- which today is shortest-id, since
  //   > inferTier's free-first key is dead (0 of 4,298 entries yield a price).
  //
  // That is not coverage of intended behaviour, it is a record of the defect R3
  // exists to fix, and it says so in its own prose: `inferTier` read
  // `pricing.inputPerMillion`, a path this schema does not have, so both ranking
  // terms were dead and shortest-id-first was all that remained. Repairing the
  // tier and adding the `outputKind` term ahead of it is what moves `acme-embed`
  // to last. The row SET is unchanged -- three entries, cap of three -- so this
  // is a reordering, not a prune.
  assert.deepEqual(built.picker.map((r) => r.model),
    ["acme/probe-1", "acme/acme-vision", "acme/acme-embed"]);
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
  //
  // AMENDED BY R3 alongside the order above, and it must be READ as the same
  // reordering seen through a second field: `[200000, 8192, 4096]` before,
  // `[200000, 4096, 8192]` now, because `acme-vision` (4096) and `acme-embed`
  // (8192) swapped. It never ran under the old expectation once the order
  // assertion started failing -- an assertion that would flip but never executes
  // is green while testing nothing, so it is corrected here explicitly rather
  // than left to be discovered when the first one is fixed.
  assert.deepEqual(built.picker.map((r) => r.contextTokens), [200000, 4096, 8192]);
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
// one provider of nine.
//
// CORRECTED BY R11, AND IT NAMED THE WRONG MECHANISM EVEN BEFORE R11. That last
// clause used to end "...and MAX_MODELS_PER_PROVIDER caps each at three". No
// provider in this fixture holds more than three catalogue entries, so the 83
// below is a property of the FIXTURE and the cap was never reached by any row in
// it. R11 split that constant in two -- routing is uncapped, and
// `MAX_PICKER_MODELS_PER_PROVIDER` bounds the picker alone -- and this fixture's
// counts are unchanged precisely because nothing here was being truncated. A
// reader who believed the old sentence would expect these numbers to move under
// R11, and would look for the bug in the wrong place when they did not.
//
// THE SAME TRAP, A SECOND TIME. R13b reopened (#91) removed the picker cap
// entirely -- `MAX_PICKER_MODELS_PER_PROVIDER` is now `Infinity` -- and the 83
// below still does not move, for the same reason: no provider here holds more
// than three catalogue entries, so no cap between three and unbounded was ever
// binding on this fixture.
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
// `autoFetchModels: false` is part of "otherwise-valid" since V9: buildProviders
// emits it on every entry, so a fixture without it models no build that exists.
const OK_PROVIDERS = [{ name: "acme", provider: "acme", api_key: "x",
                       autoFetchModels: false, models: ["m1"] }];
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
  // Asserted BEHAVIOURALLY: hand validate() a table whose capable target is not
  // in the allowlist and require the V1 message to come back in `problems`. A
  // source-string match on validate.toString() was the first version of this and
  // is strictly weaker -- it passes when the call sits in a comment, and it never
  // shows the returned problems reaching the array. A test for a vacuity should
  // not itself be one.
  const problems = validate({ providers: OK_PROVIDERS, picker: [OK_ROW()] }, 1,
    { targets: { ...BUCKET_TARGETS, capable: "claude-sonnet-4-51" } });
  assert.ok(problems.some((p) => /claude-sonnet-4-51/.test(p)),
    "a broken table must surface through validate(), not just through validateBucketTable");
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
                       api_base_url: ANTHROPIC_RELAY.api_base_url,
                       autoFetchModels: false, models: [...ANTHROPIC_RELAY.models] }];
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

// ---- V9 / V10: the two rules whose subject is the PROVIDER ENTRY -----------

test("V9: one entry flipped to autoFetchModels:true is a problem naming it and the bypass", () => {
  // The plan's stated observable. The message has to carry WHY, because
  // `autoFetchModels: false` reads like a reach limitation and gets flipped on
  // that reading -- it is actually the enforcement point for both model gates.
  const flipped = [{ ...OK_PROVIDERS[0], autoFetchModels: true }];
  const problems = validate({ providers: flipped, picker: [OK_ROW()] }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /provider "acme"/);
  assert.match(problems[0], /autoFetchModels true/);
  assert.match(problems[0], /admitRemoteModels and checkBareCollisions/);
  assert.match(problems[0], /gateway start/);
  assert.match(problems[0], /picker sanitiser/);
});

test("V9: an entry that OMITS the key fails too — the rule cannot lean on the builders", () => {
  // THE DISTINCTION THAT IS THE FINDING. #44 is not "someone might write true",
  // it is "the value is a literal at two construction sites and nothing checks
  // it". A rule shaped `=== true` would pass this input and would still be
  // relying on ANTHROPIC_RELAY and buildProviders to always set the field --
  // exactly the reliance V9 replaces. Deleting `!== false` in favour of
  // `=== true` fails here and nowhere else.
  //
  // AND THIS IS THE TEST THAT CLOSES A LIVE BYPASS, not only an invariant. CCR
  // reads the field as `oM(r.autoFetchModels ?? r.auto_fetch_models ??
  // r.autoRefreshModels ?? r.auto_refresh_models)` -- four spellings, nullish
  // coalescing (verified byte-exact in the shipped bundle; see V9's comment).
  // A PRESENT value short-circuits the chain; an ABSENT one falls through to
  // three aliases, any of which set `true` is honoured. So the input below is
  // not a pedantic omission -- it is the exact state in which a snake_case
  // alias silently wins, and requiring the field present and `false` is what
  // makes those three names unreachable.
  const { autoFetchModels: _dropped, ...noKey } = OK_PROVIDERS[0];
  const problems = validate({ providers: [noKey], picker: [OK_ROW()] }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /autoFetchModels undefined/);
  // ...and a truthy-but-not-true value is not a loophole either: CCR's own gate
  // is `Providers.some(t => t.autoFetchModels && ...)`, a truthiness test.
  assert.equal(validate({ providers: [{ ...OK_PROVIDERS[0], autoFetchModels: 1 }],
    picker: [OK_ROW()] }, 1).length, 1);
  assert.deepEqual(validate({ providers: OK_PROVIDERS, picker: [OK_ROW()] }, 1), []);
});

test("V9 covers the RELAY entry too, driven through the real constant", () => {
  // The relay is a provider entry like any other and CCR would auto-fetch it on
  // the same timer. This is also the strongest available statement about
  // ANTHROPIC_RELAY.autoFetchModels: not merely that the key is present (which
  // is all the spread-completeness test above asserts), and not merely that its
  // value is false, but that validate() CONSUMES the constant and accepts it.
  const { picker: _p, routing: _r, ...relay } = ANTHROPIC_RELAY;
  const providers = [{ ...relay, models: [...ANTHROPIC_RELAY.models] }];
  const picker = ANTHROPIC_RELAY.picker.map((m) => ({ model: `anthropic/${m}`, label: m }));
  assert.deepEqual(validate({ providers, picker }, 1), []);
  // ...and the same constant with the field flipped is caught, so the pass above
  // is the rule agreeing rather than the rule being absent.
  assert.equal(validate({ providers: [{ ...providers[0], autoFetchModels: true }],
    picker }, 1).length, 1);
});

test("V9 holds over a real buildProviders output, so both construction sites are covered", () => {
  // The literal lives at two sites. This drives the second one -- the per-entry
  // literal in buildProviders -- rather than asserting on a hand-written fixture
  // that could agree with the rule while production disagreed.
  const { chosen, vault, catalog } = capabilityFixture();
  const built = buildProviders(chosen, vault, catalog, () => "k");
  assert.ok(built.providers.length > 0, "the fixture must actually build entries");
  for (const p of built.providers) {
    assert.equal(p.autoFetchModels, false, `buildProviders left ${p.name} auto-fetching`);
  }
  assert.equal(validate(built, built.providers.length)
    .filter((x) => /autoFetchModels/.test(x)).length, 0);
});

test("V10: an impostor named anthropic is caught with the relay DOWN, where run.mjs cannot", () => {
  // THE GAP. assertRelayNameUnclaimed runs at the injection, inside
  // `if (anthropicOn)`, so the one configuration where an impostor is most
  // useful -- relay down or --no-anthropic -- is the one nothing checked. The
  // collapse it enables is demonstrated on checkBareCollisions above ("the
  // relay's provider name is reserved"): two owners, one name, guard silent.
  // Note the row needs no behavesAs to pass V3 -- that exemption is the second
  // of the three things the impostor inherits, not an oversight in this fixture.
  const impostor = [{ name: "anthropic", provider: "anthropic", api_key: "k",
                      api_base_url: "https://tabitoken.com/v1",
                      autoFetchModels: false, models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-opus-5", label: "x" }];
  const problems = validate({ providers: impostor, picker }, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /tabitoken\.com/, "the message must name who actually answers");
  assert.match(problems[0], /checkBareCollisions[\s\S]*orderNativePickerOptions[\s\S]*behavesAs/,
    "all three dependents, not just 'reserved' — same contract as assertRelayNameUnclaimed");
  assert.match(problems[0], /Rename it in providers\.json/);
});

test("V10: the genuine relay entry passes, so the rule is not just refusing the name", () => {
  // Identity is the BASE URL, not the name -- the same distinction buildProviders
  // draws when it puts the answering hostname in a row's description. A rule that
  // rejected the name outright would fail every healthy live run.
  const relay = [{ name: "anthropic", provider: "anthropic", api_key: "k",
                   api_base_url: ANTHROPIC_RELAY.api_base_url,
                   autoFetchModels: false, models: ["claude-opus-5"] }];
  const picker = [{ model: "anthropic/claude-opus-5", label: "x" }];
  assert.deepEqual(validate({ providers: relay, picker }, 1), []);
});

test("V10: two entries claiming the reserved name is a problem the alias rule cannot see", () => {
  // #25: the alias-collision rule above compares `aliases.get(k) !== p.name`,
  // and two entries SHARING a name make that equal -- duplicate names are
  // precisely its blind spot. Without this branch a duplicate pair whose second
  // entry also points at the relay's own url would pass both rules.
  const pair = [
    { name: "anthropic", provider: "anthropic", api_key: "k",
      api_base_url: ANTHROPIC_RELAY.api_base_url, autoFetchModels: false, models: ["m"] },
    { name: "anthropic", provider: "anthropic", api_key: "k",
      api_base_url: ANTHROPIC_RELAY.api_base_url, autoFetchModels: false, models: ["m"] },
  ];
  const problems = validate({ providers: pair, picker: [] }, 2);
  assert.equal(problems.length, 1, "the alias rule stays silent; only V10 fires");
  assert.match(problems[0], /2 providers are named "anthropic"/);
  assert.match(problems[0], /checkBareCollisions[\s\S]*orderNativePickerOptions[\s\S]*behavesAs/);
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

// ---------------------------------------------------- R13c: the reseller vouch
//
// THE FIXTURE IS THE REAL VAULT'S SHAPE, MEASURED, NOT INVENTED. Running
// `buildProviders` with R10's discovery cache wired in on 2026-09-08 produced
// 5,026 routing entries across 44 providers and, on the `realIds === null`
// branch, exactly these 22 sole-owned Claude-shaped ids and 15 multi-owned ones
// -- `fatal: true`. The 22 pairs below are that measurement VERBATIM, owners
// included, because the whole question this mechanism answers is WHICH HOSTS
// sole-own them. The shadowed ids carry their measured multiplicity but
// synthetic co-owner names: their names decide nothing, only that there are two
// or more of them.
//
// A FIXTURE RATHER THAN THE LIVE VAULT ON PURPOSE. The live numbers move the
// moment a reseller edits its listing or the discovery cache is refreshed, and a
// regression test that changes its own subject cannot fail honestly.
const R13C_SOLE_OWNED = [
  ["anthropic-opus-4-6", "aihubmix"], ["claude-3-7-sonnet", "aihubmix"],
  ["claude-3-haiku-20240229", "aihubmix"], ["claude-3-haiku-20240307", "aihubmix"],
  ["claude-3-haiku@20240307", "aihubmix"], ["claude-3-sonnet-20240229", "aihubmix"],
  ["claude-haiku-4.5", "bai"], ["claude-opus-4-1", "aihubmix"],
  ["claude-opus-4-5-think", "aihubmix"], ["claude-opus-4-6-think", "aihubmix"],
  ["claude-opus-4-7-think", "aihubmix"], ["claude-opus-4-8-fast", "veniceai"],
  ["claude-opus-4-8-m-aws", "tokenrouter"], ["claude-opus-4-8-think", "aihubmix"],
  ["claude-opus-4.5", "bai"], ["claude-opus-4.6", "bai"],
  ["claude-opus-5-fast", "veniceai"], ["claude-sonnet-4", "opencode"],
  ["claude-sonnet-4-5-think", "aihubmix"], ["claude-sonnet-4-6-think", "aihubmix"],
  ["claude-sonnet-4.5", "bai"], ["claude-sonnet-4.6", "bai"],
];
const R13C_MULTI_OWNED = [
  ["claude-fable-5", 9], ["claude-fable-5-1", 6], ["claude-fable-5.1", 3],
  ["claude-haiku-4-5", 5], ["claude-haiku-4-5-20251001", 2], ["claude-opus-4-5", 3],
  ["claude-opus-4-6", 4], ["claude-opus-4-7", 5], ["claude-opus-4-8", 9],
  ["claude-opus-4.7", 2], ["claude-opus-4.8", 2], ["claude-opus-5", 10],
  ["claude-sonnet-4-5", 3], ["claude-sonnet-4-6", 6], ["claude-sonnet-5", 9],
];

/** The five ids `bai` sole-owns in the measurement above, in R13C_SOLE_OWNED order. */
const BAI_SOLE_OWNED = R13C_SOLE_OWNED.filter(([, o]) => o === "bai").map(([id]) => id);

/** The vouch input's shape: provider name -> the SPECIFIC ids vouched for it. */
const vouch = (entries) => new Map(entries.map(([name, ids]) => [name, new Set(ids)]));

/** The measured shape as a `Providers[]` array, one entry per owning provider. */
function r13cFixture() {
  const byProvider = new Map();
  const add = (name, id) => {
    if (!byProvider.has(name)) byProvider.set(name, []);
    byProvider.get(name).push({ id });
  };
  for (const [id, owner] of R13C_SOLE_OWNED) add(owner, id);
  for (const [id, owners] of R13C_MULTI_OWNED) {
    for (let i = 0; i < owners; i++) add(`co-owner-${i}`, id);
  }
  return [...byProvider].map(([name, models]) => ({ name, models }));
}

test("the measured real-vault shape is reproduced, and an empty vouch set leaves it fatal", () => {
  // THE SAFETY PROPERTY, ASSERTED DIRECTLY: R13c is additive. Not passing the
  // parameter, passing an empty Map, and passing null must all be the same
  // program on the same input, and all must still stop the run. If any loosens,
  // a mechanism meant to give the operator ONE reviewed exemption has quietly
  // given them a blanket one.
  const providers = r13cFixture();
  const absent = checkBareCollisions(providers, { realIds: null });
  const empty = checkBareCollisions(providers, { realIds: null, vouchedProviders: new Map() });
  // Null-tolerant like `realIds` and `relayOwned`, which both take null for
  // "not supplied" -- a caller that threads an absent vault through must not
  // get a TypeError where its siblings give it the safe default.
  const nulled = checkBareCollisions(providers, { realIds: null, vouchedProviders: null });
  assert.equal(nulled.message, absent.message, "null vouches for nobody rather than throwing");
  assert.equal(nulled.fatal, true);
  // A provider PRESENT in the map with an empty id list vouches for nothing,
  // which is the shape `vouchedBareClaude: []` produces.
  const blank = checkBareCollisions(providers,
    { realIds: null, vouchedProviders: vouch([["bai", []]]) });
  assert.equal(blank.message, absent.message, "an empty id list is not a vouch");
  assert.deepEqual(blank.vouchedHijacks, []);

  assert.equal(absent.hijackable.length, 22, "the measured sole-owned count");
  assert.equal(absent.shadowed.length, 15, "the measured multi-owned count");
  assert.equal(absent.fatal, true, "and it is still fatal with nothing vouched");

  assert.equal(empty.fatal, absent.fatal);
  assert.deepEqual(empty.hijackable, absent.hijackable);
  assert.deepEqual(empty.shadowed, absent.shadowed);
  assert.equal(empty.message, absent.message,
    "byte for byte -- an empty vouch set must not even change the wording");
  assert.deepEqual(empty.vouchedHijacks, [],
    "and the new list is present-and-empty, never absent");
});

test("vouchedHijacks is present on every return, findings or none", () => {
  // A CONSUMER MUST NEVER HAVE TO GUESS. A key that appears only when non-empty
  // makes `c.vouchedHijacks.length` throw on the clean path, which is exactly
  // the path a disclosure line has to survive.
  for (const r of [
    checkBareCollisions([P("tokenrouter", "qwen3-max")]),
    checkBareCollisions([P("tokenrouter", "opus")]),
    checkBareCollisions([P("a", "opus"), P("b", "opus")]),
    checkBareCollisions(r13cFixture(), { realIds: null }),
  ]) {
    assert.ok(Array.isArray(r.vouchedHijacks), "always an array");
  }
});

test("vouching every id of one provider moves only its findings, and fatal recomputes", () => {
  const providers = r13cFixture();
  const vouched = checkBareCollisions(providers,
    { realIds: null, vouchedProviders: vouch([["bai", BAI_SOLE_OWNED]]) });

  // bai sole-owns 5 of the 22 in the measurement. Listing all five moves all
  // five; nothing else does.
  assert.equal(BAI_SOLE_OWNED.length, 5, "the fixture still has the measured five");
  assert.equal(vouched.vouchedHijacks.length, 5);
  assert.deepEqual([...new Set(vouched.vouchedHijacks.map((v) => v.owner))], ["bai"]);
  assert.equal(vouched.hijackable.length, 17);
  assert.equal(vouched.hijackable.some((h) => h.owner === "bai"), false,
    "every listed id moved, so bai is absent from the fatal list entirely");
  assert.equal(vouched.fatal, true,
    "17 unvouched findings remain, so vouching one reseller does not clear the run");
  assert.equal(vouched.shadowed.length, 15,
    "the vouch touches sole ownership only -- ambiguity is a different classification");
});

test("a vouch covers the ids it lists and NOT the others that provider sole-owns", () => {
  // THE ATTACK THE BOOLEAN SHAPE ALLOWED, RUN AS A TEST. Under a per-provider
  // flag, accepting one retired 2024 name granted that host every bare
  // Claude-shaped id it would ever sole-own -- including ones it had not
  // published yet, added later by its own listing edit, with no second review.
  // Here the operator reviews exactly one id, and the other four stay fatal.
  const providers = r13cFixture();
  const [reviewed, ...unreviewed] = BAI_SOLE_OWNED;
  const r = checkBareCollisions(providers,
    { realIds: null, vouchedProviders: vouch([["bai", [reviewed]]]) });

  assert.deepEqual(r.vouchedHijacks.map((v) => v.id), [reviewed],
    "exactly the reviewed id moved");
  for (const id of unreviewed) {
    assert.equal(r.hijackable.some((h) => h.id === id && h.owner === "bai"), true,
      `${id} was never reviewed, so it is still a fatal finding at the same owner`);
  }
  assert.equal(r.hijackable.length, 21, "22 findings minus the one reviewed");
  assert.equal(r.fatal, true);
});

test("a vouch is keyed on the OWNER too -- listing an id does not free it at another host", () => {
  // The mirror of the test above. `(owner, id)` is the unit; dropping either
  // half widens the grant, so both are pinned. Here `bai` is vouched for an id
  // that `veniceai` sole-owns, and the finding against veniceai must survive.
  const r = checkBareCollisions(
    [P("veniceai", "claude-opus-5-fast"), P("bai", "claude-opus-4.5")],
    { realIds: null, vouchedProviders: vouch([["bai", ["claude-opus-5-fast"]]]) });
  assert.deepEqual(r.vouchedHijacks, [],
    "bai does not own the id it was vouched for, so nothing was accepted");
  assert.equal(r.hijackable.length, 2, "both findings stand");
  assert.equal(r.fatal, true);
});

test("an id vouched at one provider is still fatal when a second provider sole-owns it", () => {
  // A reseller's listing is not a stable input. Vouching `bai:claude-opus-4.5`
  // must not pre-accept the day some OTHER host starts sole-owning that name --
  // that is a new claim by a party nobody reviewed.
  const r = checkBareCollisions([P("aihubmix", "claude-opus-4.5")],
    { realIds: null, vouchedProviders: vouch([["bai", ["claude-opus-4.5"]]]) });
  assert.equal(r.hijackable.length, 1);
  assert.equal(r.hijackable[0].owner, "aihubmix");
  assert.equal(r.fatal, true);
});

test("vouching every owner clears fatal, and the message stops claiming there was nothing", () => {
  // THE ONLY BRANCH A VOUCH CAN REACH ALONE: reclassify the last sole-owned
  // finding and both classified lists empty out. "no bare Claude-shaped
  // collisions" would then be false -- there WERE collisions and a human
  // accepted them -- so the wording has to change with the fact.
  const solo = [P("bai", "claude-opus-4.5")];
  const unvouched = checkBareCollisions(solo, { realIds: null });
  assert.equal(unvouched.fatal, true);

  const r = checkBareCollisions(solo,
    { realIds: null, vouchedProviders: vouch([["bai", ["claude-opus-4.5"]]]) });
  assert.equal(r.fatal, false, "the last unvouched finding is gone, so nothing stops the run");
  assert.deepEqual(r.hijackable, []);
  assert.equal(r.vouchedHijacks.length, 1);
  assert.match(r.message, /no unvouched bare Claude-shaped collisions/);
  assert.doesNotMatch(r.message, /^no bare Claude-shaped collisions/,
    "the unqualified all-clear is a claim this run cannot make");
  assert.match(r.message, /vouched \(reported, not blocking\)/);
});

test("a vouched finding names its id, owner, reason and relay fact -- never just a count", () => {
  const r = checkBareCollisions([P("bai", "claude-opus-4.5")],
    { realIds: null, vouchedProviders: vouch([["bai", ["claude-opus-4.5"]]]) });
  const [v] = r.vouchedHijacks;
  assert.equal(v.id, "claude-opus-4.5");
  assert.equal(v.owner, "bai");
  // FIELD PARITY WITH `hijackable`. These two lists hold the same finding under
  // two verdicts; a consumer rendering per-finding provenance (§6.6) reads the
  // same key off both, and a missing key here would make the vouched branch the
  // one that throws.
  assert.equal(v.relayRoutes, false,
    "a sole non-relay owner means the relay does not route it, computed not assumed");
  const unvouched = checkBareCollisions([P("bai", "claude-opus-4.5")], { realIds: null });
  assert.deepEqual(Object.keys(v).filter((k) => k !== "reason").sort(),
    Object.keys(unvouched.hijackable[0]).sort(),
    "the same fields the fatal list carries, plus the reason it was spared");
  assert.equal(typeof v.reason, "string");
  assert.match(v.reason, /vouchedBareClaude/,
    "the reason names the field an operator would have to edit to undo it");
  assert.match(v.reason, /bai/, "and the provider it was set on");
  assert.match(v.reason, /claude-opus-4\.5/,
    "and the specific id, since the field is a per-id list an operator must check against");
  // The message carries the same three facts, because a caller that prints only
  // the message must still be able to audit the decision.
  assert.match(r.message, /claude-opus-4\.5/);
  assert.match(r.message, /sole owner: bai/);
  assert.match(r.message, /still uniquely owned/,
    "and states plainly that the routing did not change, only the verdict");
});

test("the vouch is reported alongside a fatal, not instead of it", () => {
  // A run can carry both. The operator reviewing the fatal needs the accepted
  // risk in the same output, or the two get reviewed in different sittings.
  const r = checkBareCollisions([P("bai", "claude-opus-4.5"), P("veniceai", "claude-opus-5-fast")],
    { realIds: null, vouchedProviders: vouch([["bai", ["claude-opus-4.5"]]]) });
  assert.equal(r.fatal, true);
  assert.equal(r.hijackable.length, 1);
  assert.equal(r.vouchedHijacks.length, 1);
  assert.match(r.message, /SECURITY: 1 bare Claude-shaped model id/);
  assert.match(r.message, /vouched \(reported, not blocking\)/);
});

test("vouching a provider that owns nothing changes nothing at all", () => {
  const providers = r13cFixture();
  const base = checkBareCollisions(providers, { realIds: null });
  const noop = checkBareCollisions(providers, { realIds: null,
    vouchedProviders: vouch([["a-provider-not-in-this-config", ["claude-opus-4.5"]]]) });
  assert.deepEqual(noop.hijackable, base.hijackable);
  assert.deepEqual(noop.vouchedHijacks, []);
  assert.equal(noop.message, base.message);
});

test("a vouch cannot silence a shadowed finding or an ambiguous one", () => {
  // SOLE OWNERSHIP IS THE ONLY THING IT SPEAKS TO. `shadowed` is CCR binding
  // nothing, which is already a clean failure; moving it would be a change to
  // reporting the operator never asked for.
  const r = checkBareCollisions([P("bai", "opus"), P("nararouter", "opus")],
    { realIds: null, vouchedProviders: vouch([["bai", ["opus"]], ["nararouter", ["opus"]]]) });
  assert.equal(r.shadowed.length, 1);
  assert.deepEqual(r.vouchedHijacks, []);
  assert.equal(r.fatal, false);
});

test("--allow-bare-claude-names and the vouch are independent controls", () => {
  // The flag accepts EVERY sole owner for one run; the vouch accepts ONE named
  // id at ONE named provider until the config is edited back. Neither implies the other, and the
  // flag must not start populating `vouchedHijacks` -- a blanket override is not
  // a reviewed exemption and must not be recorded as one.
  const r = checkBareCollisions([P("bai", "claude-opus-4.5")],
    { realIds: null, allowBare: true });
  assert.equal(r.fatal, false, "the flag silences the exit");
  assert.equal(r.hijackable.length, 1, "without moving the finding");
  assert.deepEqual(r.vouchedHijacks, [], "and without claiming anyone vouched for it");
});

test("shouldReportCollisions fires when the only finding was vouched away", () => {
  // Otherwise the accepted risk is named in a message nothing prints. The id is
  // one Anthropic really publishes, so this runs on the VERIFIED branch and
  // `catalogVerified` cannot be the disjunct doing the work.
  const r = checkBareCollisions([P("bai", "claude-opus-5")],
    { realIds: PROD_REAL_IDS, vouchedProviders: vouch([["bai", ["claude-opus-5"]]]) });
  assert.deepEqual(r.hijackable, []);
  assert.deepEqual(r.shadowed, []);
  assert.equal(r.catalogVerified, true, "so no other disjunct can be doing the work");
  assert.equal(r.vouchedHijacks.length, 1);
  assert.equal(shouldReportCollisions(r), true);
});

test("vouchedBareClaudeProviders reads a LIST of ids, and `true` is not a vouch", () => {
  // `true` WAS THE ORIGINAL SHAPE AND IS NOW REJECTED OUTRIGHT. It granted its
  // holder every bare Claude-shaped id it would ever sole-own, extendable by the
  // reseller's own listing edits with no second review. Reading it as "vouch
  // everything" is the one interpretation that must never return: an operator
  // who wrote it gets the same verdict as one who wrote nothing, which is fatal,
  // which is the safe direction to be wrong in.
  const vault = new Map([
    ["listed", { provider: "listed", vouchedBareClaude: ["claude-3-haiku-20240229", " opus "] }],
    ["blanket", { provider: "blanket", vouchedBareClaude: true }],
    ["str-true", { provider: "str-true", vouchedBareClaude: "true" }],
    ["one", { provider: "one", vouchedBareClaude: 1 }],
    ["no", { provider: "no", vouchedBareClaude: false }],
    // A bare string is the near-miss a hand edit produces; iterating its
    // characters would vouch for "c", "l", "a"... so it must not be Array-like.
    ["bare-string", { provider: "bare-string", vouchedBareClaude: "claude-opus-5" }],
    ["obj", { provider: "obj", vouchedBareClaude: { "claude-opus-5": true } }],
    ["empty", { provider: "empty", vouchedBareClaude: [] }],
    ["junk-entries", { provider: "junk-entries", vouchedBareClaude: [null, 7, "", "  ", {}] }],
    ["absent", { provider: "absent" }],
  ]);
  const got = vouchedBareClaudeProviders(vault);
  assert.deepEqual([...got.keys()], ["listed"],
    "only the array shape vouches; every other shape is absence, `true` included");
  // Trimmed, because `checkBareCollisions` keys ownership on trimmed selectors
  // and an untrimmed entry would silently never match.
  assert.deepEqual([...got.get("listed")].sort(), ["claude-3-haiku-20240229", "opus"]);
  assert.equal(got.get("blanket"), undefined, "`true` vouches for nothing at all");
  assert.equal(got.get("empty"), undefined, "an empty list is omitted, not an empty set");
  assert.equal(got.get("junk-entries"), undefined,
    "a list whose entries are all unusable vouches for nothing");
  assert.equal(vouchedBareClaudeProviders(new Map()).size, 0);
  assert.equal(vouchedBareClaudeProviders(null).size, 0,
    "a missing vault vouches for nobody rather than throwing");
});

test("the real vault ships with nobody vouched", (t) => {
  // R13c lands the MECHANISM. Whether aihubmix or bai is trusted for a given id
  // is a config decision about a specific reseller's listing, made by the
  // operator in providers.json -- never by this branch. This asserts the shipped
  // state, and it is expected to fail the day someone deliberately vouches an
  // id, at which point the failure is the record that the decision was made.
  //
  // THE ONE TEST IN THIS FILE THAT READS THE REAL VAULT, AND ONLY BECAUSE ITS
  // SUBJECT IS THE REAL VAULT -- a fixture cannot carry the tripwire property.
  // Guarded rather than left bare: on a fresh clone or CI the file is absent, an
  // unguarded read throws ENOENT at module scope of the test body, and every
  // other test in this 300+ test file fails alongside it. Absence SKIPS.
  const vaultFile = path.join(os.homedir(), ".llmkeys", "providers.json");
  if (!fs.existsSync(vaultFile)) {
    t.skip(`no vault at ${vaultFile}; the shipped-state tripwire needs the real file`);
    return;
  }
  const raw = fs.readFileSync(vaultFile, "utf8").replace(/^\uFEFF/, "");
  const vault = new Map(JSON.parse(raw).map((p) => [p.provider, p]));
  assert.deepEqual([...vouchedBareClaudeProviders(vault).keys()], [],
    "no provider in the real vault lists a vouchedBareClaude id");
});

test("loadDiscoveryCache degrades to null with a note when no cache root resolves", () => {
  // `cacheRoot` throws when the local app-data root is unset -- a real condition
  // on a machine that has never run `refresh`. Discovery only ever ADDS candidate
  // ids, so losing it must return keysync to its pre-R13c build, not stop it.
  const r = loadDiscoveryCache(["a", "b"], {
    root: () => { throw new Error("the per-user local application-data root is unset"); },
  });
  assert.equal(r.discovery, null);
  assert.match(r.note, /no cache directory/);
  assert.match(r.note, /application-data root is unset/,
    "the note names the condition, so a silent degrade is not possible");
});

/** A cache record stamped `ms` milliseconds before `NOW`. `at` is an ISO STRING. */
const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const aged = (ms, models) =>
  ({ outcome: "ok", at: new Date(NOW - ms).toISOString(), models });
const FRESH = 60 * 60 * 1000;

test("loadDiscoveryCache skips an unreadable record and says which", () => {
  // `readCacheRecord` throws when a record is not owner-only. One bad file must
  // not cost the other 43 providers their listings, and must not pass unnamed.
  const r = loadDiscoveryCache(["ok", "locked", "missing"], {
    now: NOW,
    root: () => "C:\\nowhere",
    read: (name) => {
      if (name === "locked") throw new Error("refusing to read: it is not owner-only");
      return name === "ok" ? aged(FRESH, [{ id: "m-1" }]) : null;
    },
  });
  assert.equal(r.discovery.size, 1);
  assert.deepEqual(r.discovery.get("ok").models, [{ id: "m-1" }]);
  assert.match(r.note, /1 of 3 provider\(s\) contribute ids/);
  assert.match(r.note, /locked/, "the unreadable one is named");
  assert.match(r.note, /not owner-only/, "with the reason it was skipped");
});

test("a discovery record past the routing ceiling contributes no ids, and says so", () => {
  // THE BOUND `routableCatalogIds` ENFORCES ON THE CATALOGUE, ON THE LARGER
  // SOURCE. Discovery is ~3,400 of the 5,026 routing entries on the real vault,
  // so an unbounded cache reopens through the bigger door exactly what the
  // ceiling closes: a reseller retires a model, nobody re-runs refresh, and
  // keysync advertises the dead id forever as a picker row that 404s.
  const r = loadDiscoveryCache(["fresh", "stale"], {
    now: NOW,
    root: () => "C:\\d",
    read: (name) => name === "fresh"
      ? aged(ROUTING_MAX_STALENESS_MS - 1000, [{ id: "live-1" }])
      : aged(ROUTING_MAX_STALENESS_MS + 1000, [{ id: "retired-1" }]),
  });
  assert.deepEqual([...r.discovery.keys()], ["fresh"]);
  assert.deepEqual(r.discovery.get("fresh").models, [{ id: "live-1" }],
    "the fresh record's ids still reach routing");
  assert.equal(r.discovery.has("stale"), false, "the stale record's ids do not");
  assert.match(r.note, /1 of 2 provider\(s\) contribute ids/);
  assert.match(r.note, /1 past the 7d routing ceiling and not routed \(stale\)/,
    "and the drop is named rather than read as an absent cache");
});

test("exactly at the ceiling still routes, and an unstamped record never does", () => {
  // `<=`, not `<` -- the same boundary `routableCatalogIds` holds. And a record
  // with no parseable `at` is MAXIMALLY stale, not fresh: unknown age must fail
  // the ceiling, or the legacy shape becomes the way around it.
  const read = (rec) => loadDiscoveryCache(["p"], { now: NOW, root: () => "C:\\d", read: () => rec });
  assert.equal(read(aged(ROUTING_MAX_STALENESS_MS, [{ id: "a" }])).discovery.size, 1,
    "exactly at the ceiling is still routable");
  for (const at of [undefined, null, "", "not-a-date", 0]) {
    const r = read({ outcome: "ok", at, models: [{ id: "a" }] });
    assert.equal(r.discovery.size, 0, `at: ${JSON.stringify(at)} must not route`);
    assert.match(r.note, /past the 7d routing ceiling/);
  }
});

test("a fresh record contributing no usable id is counted as such, not as coverage", () => {
  // `discoveryIndex` drops a record whose `models` is not an array of `{id}`, so
  // counting file presence reports coverage the build does not have -- and reads
  // as success on exactly the runs that lost the most.
  const r = loadDiscoveryCache(["good", "wrong-type", "wrapper", "empty", "blank-ids"], {
    now: NOW,
    root: () => "C:\\d",
    read: (name) => ({
      good: aged(FRESH, [{ id: "g-1" }]),
      "wrong-type": { outcome: "ok", at: aged(FRESH, []).at, models: "a string" },
      wrapper: { outcome: "ok", at: aged(FRESH, []).at, byProvider: { p: [{ id: "x" }] } },
      empty: aged(FRESH, []),
      "blank-ids": aged(FRESH, [{ id: "" }, { nope: 1 }]),
    })[name],
  });
  assert.deepEqual([...r.discovery.keys()], ["good"]);
  assert.match(r.note, /1 of 5 provider\(s\) contribute ids/);
  assert.match(r.note, /4 fresh but contributed no usable id/);
});

test("loadDiscoveryCache returns records in the shape buildProviders consumes", () => {
  // NOT `{byProvider: Map}` -- that is `catalog`'s shape, and the two are joined
  // downstream, which is what makes the confusion easy. `discoveryIndex` wants
  // provider -> record directly, so a wrapper here would silently contribute no
  // candidates and the only symptom would be a smaller routing table.
  const record = aged(FRESH, [{ id: "x-1" }, { id: "x-2" }]);
  const { discovery } = loadDiscoveryCache(["p"],
    { now: NOW, root: () => "C:\\d", read: () => record });
  const built = buildProviders(
    [{ provider: "p", id: "p.key" }],
    new Map([["p", { protocol: "openai", baseUrl: "https://p.example/v1", testModel: "x-1" }]]),
    { byProvider: new Map(), generatedAt: "t" },
    () => "k",
    discovery);
  assert.deepEqual(built.providers[0].models.sort(), ["x-1", "x-2"],
    "both discovered ids became routable, which only happens on the accepted shape");
});

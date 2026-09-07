// R11: routing and the picker are sized separately.
//
// `buildProviders` used to draw BOTH `providers[].models` (what CCR routes on)
// and `picker` (the flat `/model` menu) from one capped array, so bounding an
// unusable 44-provider menu also bounded REACH. This file pins the split, the
// union that feeds routing, and the two ways the split can be made silently
// wrong: a cap parse that yields `NaN` (uncapping the picker) and a candidate
// set narrowed to discovery (deleting providers that answered).
//
// EVERY PRESENCE ASSERTION HERE NAMES ITS PROVIDER. A total count is satisfied
// by gaining one provider while losing another, which is exactly the shape the
// union exists to prevent.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildProviders, validate, bucketFor, normalizeModel, outputKind, capabilityKind,
  pickerCapFrom, MAX_PICKER_MODELS_PER_PROVIDER, BUCKET_TARGETS, CTX_CAPABLE_MIN,
} from "../keysync/keysync.mjs";

// ---------------------------------------------------------------- fixtures

const text = (extra) => ({ modalities: { output: ["text"] }, ...extra });

/**
 * A vault + catalogue + discovery triple shaped like the real one at the two
 * points that matter:
 *
 *   `wide`     a catalogue-covered provider with more entries than any cap, so
 *              the routing/picker gap is observable at all.
 *   `tabiai`   / `gorouter` -- the two providers R10's sweep recorded as
 *              `empty` (HTTP 200, `data: []`) while carrying a real testModel.
 *              These are the union's subject.
 *   `listed`   a provider whose ids come ONLY from discovery, so the discovery
 *              half of the union is observable independently of the catalogue.
 */
function fixture({ discovery = {} } = {}) {
  const chosen = [
    { id: "personal.wide.free", provider: "wide" },
    { id: "personal.tabiai.free", provider: "tabiai" },
    { id: "personal.gorouter.free", provider: "gorouter" },
    { id: "personal.listed.free", provider: "listed" },
  ];
  const vault = new Map([
    ["wide", { protocol: "openai", baseUrl: "https://wide.invalid/v1", testModel: "wide-probe" }],
    ["tabiai", { protocol: "openai", baseUrl: "https://api.tabitoken.com/v1",
                 testModel: "claude-opus-4-8" }],
    ["gorouter", { protocol: "openai", baseUrl: "https://gorouter.app/v1",
                   testModel: "claude-opus-4-8" }],
    ["listed", { protocol: "openai", baseUrl: "https://listed.invalid/v1",
                 testModel: "listed-probe" }],
  ]);
  const byProvider = new Map([
    ["wide", Array.from({ length: 9 }, (_, i) =>
      ({ provider: "wide", model: `wide-m${i}`, id: `wide/wide-m${i}`,
         ...text({ limits: { contextTokens: 32768 }, capabilities: { reasoning: true } }) }))],
  ]);
  return {
    chosen, vault,
    catalog: { generatedAt: "fixture", byProvider, byAlias: new Map() },
    discovery,
  };
}

const build = (f) =>
  buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test-not-a-real-key", f.discovery);

const byName = (built, name) => built.providers.find((p) => p.name === name) ?? null;
const pickerFor = (built, name) =>
  built.picker.filter((r) => r.model.startsWith(`${name}/`)).map((r) => r.model);

// ---- observable 1: the union keeps a provider that ANSWERED but listed nothing

test("a provider whose discovery came back EMPTY keeps its testModel row", () => {
  // R10's measured shape for tabiai and gorouter: HTTP 200 with `data: []`.
  // `empty` is a true statement about the provider, not a failure -- and the
  // `!models.length` skip in buildProviders PRECEDES the `out.push`, so a
  // candidate set narrowed to the discovered ids would delete both from
  // Providers[] entirely. Named, never counted.
  const built = build(fixture({ discovery: {
    tabiai: { outcome: "empty", responded: true, models: [] },
    gorouter: { outcome: "empty", responded: true, models: [] },
  } }));

  for (const name of ["tabiai", "gorouter"]) {
    const p = byName(built, name);
    assert.ok(p, `${name} answered HTTP 200 and must not be deleted from Providers[]`);
    assert.deepEqual(p.models, ["claude-opus-4-8"],
      `${name}'s testModel is the whole of its candidate set here, and it must survive`);
    assert.deepEqual(pickerFor(built, name), [`${name}/claude-opus-4-8`]);
  }
  assert.deepEqual(built.notes, [], "neither provider may be reported as skipped");
});

test("...and a provider with NO testModel and nothing to list really is skipped", () => {
  // The control that keeps the assertion above from being vacuous: the skip
  // branch is reachable, so the previous test is observing the union rather
  // than a branch that never fires.
  const f = fixture();
  f.chosen = [{ id: "personal.bare.free", provider: "bare" }];
  f.vault = new Map([["bare", { protocol: "openai", baseUrl: "https://bare.invalid/v1" }]]);
  const built = build(f);
  assert.equal(byName(built, "bare"), null);
  assert.match(built.notes.join("\n"), /^bare: no testModel and no catalog entry/);
});

// ---- observable 1, the mutation --------------------------------------------

test("MUTATION: reverting the candidate set to discovery-only DELETES tabiai and gorouter", async (t) => {
  // The presence assertions above claim to be testing the UNION. This proves it
  // by building the narrowed rule and watching them fail: keysync.mjs is read,
  // the testModel and catalogue contributions are struck out textually, and the
  // mutant is imported from a temp directory with its two relative imports
  // rewritten to absolute file URLs so nothing is written into the repo.
  //
  // BOTH EDITS ARE ASSERTED TO HAVE APPLIED. Without that, an edit to
  // keysync.mjs that moves either anchor turns this into a test that imports an
  // unmutated copy and passes for the wrong reason.
  const src = fs.readFileSync(new URL("../keysync/keysync.mjs", import.meta.url), "utf8");

  // Anchored on the statement rather than on the line, so the mutation is not
  // hostage to the checkout's line endings.
  const TESTMODEL_ANCHOR = /^([ \t]*)if \(safeTestModel\) \{$/m;
  const CATALOGUE_ANCHOR = /^([ \t]*)for \(const m of safeEntries\) \{$/m;
  assert.match(src, TESTMODEL_ANCHOR, "the testModel contribution moved; re-anchor this mutation");
  assert.match(src, CATALOGUE_ANCHOR, "the catalogue contribution moved; re-anchor this mutation");

  const mutated = src
    .replace(TESTMODEL_ANCHOR, "$1if (false && safeTestModel) {")
    .replace(CATALOGUE_ANCHOR, "$1for (const m of []) {")
    .replace('from "../menu/denylist.mjs"',
      `from ${JSON.stringify(new URL("../menu/denylist.mjs", import.meta.url).href)}`)
    .replace('from "./catalog-join.mjs"',
      `from ${JSON.stringify(new URL("../keysync/catalog-join.mjs", import.meta.url).href)}`);
  assert.notEqual(mutated, src, "the mutation must actually change the source");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r11-mutant-"));
  const file = path.join(dir, "keysync-discovery-only.mjs");
  fs.writeFileSync(file, mutated);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const mutant = await import(pathToFileURL(file).href);
  const f = fixture({ discovery: {
    tabiai: { outcome: "empty", responded: true, models: [] },
    gorouter: { outcome: "empty", responded: true, models: [] },
    // `listed` DOES list something, so the mutant still builds a config: what
    // follows is a narrowed candidate set, not a broken function.
    listed: { outcome: "ok", models: [{ id: "listed-live-1" }] },
  } });
  const built = mutant.buildProviders(f.chosen, f.vault, f.catalog,
    () => "sk-test-not-a-real-key", f.discovery);

  // THE ASSERTION THAT MUST FAIL UNDER THE MUTANT, stated as its own inversion.
  for (const name of ["tabiai", "gorouter"]) {
    assert.equal(built.providers.find((p) => p.name === name), undefined,
      `${name} survived a discovery-only candidate set, so the presence assertions ` +
      `above are not testing the union and would pass under this regression`);
  }
  assert.match(built.notes.join("\n"), /tabiai: no testModel/);
  // And `listed`, whose ids come from discovery, is unaffected -- so the mutant
  // narrowed the set rather than breaking the build outright.
  assert.ok(built.providers.some((p) => p.name === "listed"));
});

// ---- observable 2: the gap --------------------------------------------------

test("routing carries every candidate; the picker carries a bounded prefix", () => {
  const built = build(fixture());
  const wide = byName(built, "wide");

  // A GAP, not a number. `wide` has one testModel plus nine catalogue entries.
  assert.equal(wide.models.length, 10, "testModel + 9 catalogue entries, uncapped");
  assert.equal(pickerFor(built, "wide").length, MAX_PICKER_MODELS_PER_PROVIDER);
  assert.ok(wide.models.length > pickerFor(built, "wide").length * 3,
    "routing must be much larger than the picker once the two are decoupled");

  const routingTotal = built.providers.reduce((n, p) => n + p.models.length, 0);
  assert.ok(routingTotal > built.picker.length,
    `routing (${routingTotal}) must exceed picker rows (${built.picker.length})`);
});

test("the picker is a PREFIX of models, which is what keeps the two agreeing", () => {
  // Re-ranking the picker separately would let the menu and the routing table
  // disagree about which rows a provider's best three are. A prefix cannot.
  const built = build(fixture({ discovery: {
    wide: { outcome: "ok", models: [{ id: "wide-live-a", capabilityRaw: "chat" }] },
  } }));
  for (const p of built.providers) {
    const rows = pickerFor(built, p.name).map((m) => m.slice(p.name.length + 1));
    assert.deepEqual(rows, p.models.slice(0, MAX_PICKER_MODELS_PER_PROVIDER),
      `${p.name}'s picker rows must be the head of its models[]`);
  }
});

// ---- observable 3: validate() ----------------------------------------------

test("validate() passes on the widened build, subset rule untouched", () => {
  // The picker-row-in-models[] subset assertion is RELAXED by widening, not
  // broken: every picker row is a prefix element of the same array. Driven
  // through validate() rather than restated, so a change to that rule is felt
  // here.
  const built = build(fixture({ discovery: {
    listed: { outcome: "ok", models: [{ id: "listed-live-1" }, { id: "listed-live-2" }] },
  } }));
  assert.deepEqual(validate(built, built.providers.length), []);
});

// ---- the cap parse: the NaN bug, which the rename alone does not fix --------

test("UW_MAX_MODELS=x yields the default and a BOUNDED picker, never an uncapped one", (t) => {
  // THE REGRESSION THIS EXISTS FOR. The old form was
  // `Number(process.env.UW_MAX_MODELS ?? 3)` compared with
  // `models.length >= MAX_MODELS_PER_PROVIDER`. `Number("x")` is `NaN` and every
  // comparison against `NaN` is false, so a typo'd value did not fall back to 3
  // -- it removed the cap. Renaming the constant and keeping the coercion
  // reproduces that exactly, passes every other assertion in this file, and
  // silently uncaps the menu.
  const saved = process.env.UW_MAX_MODELS;
  t.after(() => {
    if (saved === undefined) delete process.env.UW_MAX_MODELS;
    else process.env.UW_MAX_MODELS = saved;
  });

  for (const bad of ["x", "", "  ", "3.0", "0x3", "3e0", "-1", "0", "abc3"]) {
    process.env.UW_MAX_MODELS = bad;
    assert.equal(pickerCapFrom(process.env.UW_MAX_MODELS), MAX_PICKER_MODELS_PER_PROVIDER,
      `UW_MAX_MODELS=${JSON.stringify(bad)} must resolve to the default`);
    // ...and the BOUND, not merely the parsed number. `wide` has 10 candidates,
    // so an uncapped picker shows 10 rows for it and a defaulted one shows 3.
    const built = build(fixture());
    assert.equal(pickerFor(built, "wide").length, MAX_PICKER_MODELS_PER_PROVIDER,
      `UW_MAX_MODELS=${JSON.stringify(bad)} left the picker unbounded`);
  }

  // A real value still works, or the fallback would be indistinguishable from
  // ignoring the variable.
  process.env.UW_MAX_MODELS = "5";
  assert.equal(pickerFor(build(fixture()), "wide").length, 5);
});

// ---- capability precedence -------------------------------------------------

test("a discovered capability OUTRANKS the bundle's modalities.output", () => {
  // The bundle says this row emits text; the provider's own listing says it
  // emits video. The listing is what that host is serving today, so it wins --
  // and the row is demoted out of the picker's top slots as a result.
  const entry = { provider: "p", model: "m",
                  modalities: { output: ["audio", "text"] } };
  assert.equal(outputKind(entry), "text", "the bundle alone reads as text");
  assert.equal(outputKind(entry, "video"), "nontext", "the live listing outranks it");
  assert.equal(outputKind(entry, "image"), "nontext");
  // ...and it works in the other direction too.
  assert.equal(outputKind({ modalities: { output: ["image"] } }, "chat"), "text");
});

test("an unrecognised capability token is NO SIGNAL, never a non-text claim", () => {
  // Positive signals only, the same doctrine the modality branch follows.
  // MEASURED over R10's 44 records, four of the eight observed tokens are not
  // modality claims at all -- `base` in particular labels mistral's OCR, TTS,
  // embedding and chat models alike.
  for (const t of ["tool_calling", "reasoning", "web_search", "base", "wat", "", null]) {
    assert.equal(capabilityKind(t), null, `${JSON.stringify(t)} must claim nothing`);
  }
  const entry = { modalities: { output: ["text"] } };
  assert.equal(outputKind(entry, "base"), "text", "a no-signal token defers to the bundle");
  assert.equal(outputKind({}, "tool_calling"), null, "and cannot invent one");
});

test("a capability demotes a row in the SELECTION SORT, not only in `kind`", () => {
  // The precedence has to reach the ordering or it is a label with no effect.
  // Two rows, identical but for the live capability; the demoted one must leave
  // the picker's head while remaining routable.
  const f = fixture();
  f.chosen = [{ id: "personal.gen.free", provider: "gen" }];
  f.vault = new Map([["gen", { protocol: "openai", baseUrl: "https://gen.invalid/v1" }]]);
  f.catalog.byProvider = new Map([["gen", [
    { provider: "gen", model: "aa", id: "gen/aa", modalities: { output: ["audio", "text"] } },
    { provider: "gen", model: "bbbbbbbb", id: "gen/bbbbbbbb", modalities: { output: ["text"] } },
  ]]]);

  const plain = build(f);
  assert.deepEqual(byName(plain, "gen").models, ["aa", "bbbbbbbb"],
    "without a live capability the shorter id leads");

  f.discovery = { gen: { outcome: "ok", models: [{ id: "aa", capabilityRaw: "image_gen" }] } };
  const demoted = build(f);
  assert.deepEqual(byName(demoted, "gen").models, ["bbbbbbbb", "aa"],
    "the live image_gen claim demotes `aa` below a longer text id");
  assert.equal(demoted.picker[0].model, "gen/bbbbbbbb");
  // NEVER PRUNED, only reordered. Rule 1 is not a ranking rule.
  assert.ok(byName(demoted, "gen").models.includes("aa"));
});

test("a capability reaches `kind` and therefore the nonchat bucket, but NEVER `reason`", () => {
  // `outputKind` may consume `capability`; `bucketFor` reads `kind` and `reason`
  // and must not read the token itself. A provider's `reasoning` marketing flag
  // is not the bundle's measured `capabilities.reasoning`, and the capable
  // bucket is a claim about a client-side prompt profile.
  const noSignal = { provider: "p", model: "m" };
  assert.equal(bucketFor(normalizeModel("m", noSignal, "p", "reasoning")), "unknown",
    "a `reasoning` capability token must not manufacture the capable bucket");
  assert.equal(normalizeModel("m", noSignal, "p", "reasoning").reason, null,
    "`reason` stays the bundle's field and nothing else");

  const declared = normalizeModel("m", { modalities: { output: ["text"] } }, "p", "video");
  assert.equal(declared.kind, "nontext");
  assert.equal(bucketFor(declared), "nonchat", "kind is the route a capability may take");
  assert.equal(BUCKET_TARGETS.nonchat, BUCKET_TARGETS.weak);
});

// ---- bucketFor: SIX branches, reproduced exactly ---------------------------

test("bucketFor still has all six branches, including the absent-reasoning proxy", () => {
  // R11 must reproduce these unchanged, and the one easy to miss is the fifth:
  // a row that JOINS, carries `limits.contextTokens`, and has
  // `capabilities.reasoning` ABSENT (not false) uses context size as a proxy.
  // A live listing reporting a context window with no reasoning flag is a
  // common shape, not a 3-row edge case, so this branch matters more after the
  // union than before it.
  const M = (o) => ({ id: "m", tier: "unknown", ...o });
  assert.equal(bucketFor(M({ kind: "nontext", reason: true, contextTokens: 1e6 })), "nonchat",
    "1. kind goes first: google/veo-2 is reason:false and 480 video SECONDS");
  assert.equal(bucketFor(M({ kind: "text", reason: true })), "capable", "2. measured reasoning");
  assert.equal(bucketFor(M({ kind: "text", reason: false, contextTokens: 1e6 })), "weak",
    "3. measured NOT reasoning, and the big window does not override it");
  assert.equal(bucketFor(M({ kind: "text", reason: null })), "unknown",
    "4. a true miss: no join at all, so no proxy either");
  assert.equal(bucketFor(M({ kind: "text", reason: null, contextTokens: CTX_CAPABLE_MIN })), "capable",
    "5. absent reasoning + a window at the INCLUSIVE cutoff promotes");
  assert.equal(bucketFor(M({ kind: "text", reason: null, contextTokens: CTX_CAPABLE_MIN - 1 })), "weak",
    "6. absent reasoning + a smaller window");
  // `contextTokens > 0`, not `!= null`: google/lyria really reports 0, and a
  // zero is the absence of a window rather than a very small one.
  assert.equal(bucketFor(M({ kind: "text", reason: null, contextTokens: 0 })), "unknown");
});

// ---- discovery is gated, joined, and does not read `lastGood` --------------

test("a discovered id passes the same admission gate as a catalogue id", () => {
  // `uw/` is OUR routing namespace. A provider claiming it shadows a slot we
  // own, and discovery must not be the way in.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let built;
  try {
    built = build(fixture({ discovery: {
      listed: { outcome: "ok", models: [
        { id: "listed-ok-1" }, { id: "uw/fast" }, { id: "bad[2J" },
      ] },
    } }));
  } finally { console.warn = realWarn; }

  const p = byName(built, "listed");
  assert.ok(p.models.includes("listed-ok-1"), "a clean discovered id routes");
  assert.equal(p.models.includes("uw/fast"), false, "the uw/ namespace is refused");
  assert.equal(p.models.some((m) => m.includes("")), false, "and so is an escape sequence");
  assert.equal(warnings.filter((w) => /SECURITY: provider "listed"/.test(w)).length, 1,
    "ONE security line for the provider: a split finding is a finding half-read");
});

test("a discovered id JOINS the bundle for its capability signals", () => {
  // `capabilities.reasoning` and `limits.contextTokens` exist only in the
  // bundle, so a live id is worth joining -- and a miss is an honest `unknown`
  // rather than a guess.
  const f = fixture();
  f.catalog.byProvider.set("joinable", [
    { provider: "joinable", model: "joined-1", id: "joinable/joined-1",
      ...text({ limits: { contextTokens: 200000 }, capabilities: { reasoning: true } }) },
  ]);
  f.discovery = { listed: { outcome: "ok", models: [{ id: "joinable/joined-1" }, { id: "no-such-model" }] } };
  const built = build(f);
  const rows = Object.fromEntries(built.picker.map((r) => [r.model, r]));

  assert.equal(rows["listed/joinable/joined-1"].behavesAs, BUCKET_TARGETS.capable,
    "the vendor-qualified tail rung joins it, so its reasoning flag is available");
  assert.equal(rows["listed/no-such-model"].behavesAs, BUCKET_TARGETS.unknown,
    "a miss declares the unknown target -- absent is the maximal assumption set, not none");
});

test("`lastGood` is not routed: it is what the provider served on some EARLIER run", () => {
  // A record carrying `lastGood` says the provider failed TODAY, and the same
  // failure may be why its listing was retired. The `testModel` half of the
  // union is what keeps such a provider present, not a stale listing.
  const built = build(fixture({ discovery: {
    tabiai: { outcome: "auth", responded: true, models: [],
              lastGood: { at: "2026-01-01", count: 1, models: [{ id: "stale-id" }] } },
  } }));
  const p = byName(built, "tabiai");
  assert.deepEqual(p.models, ["claude-opus-4-8"]);
  assert.equal(p.models.includes("stale-id"), false);
});

test("a malformed or absent discovery input degrades to the pre-R11 candidate set", () => {
  // Optional enrichment. It may add ids; it may never cost a build.
  const base = build(fixture()).providers.map((p) => [p.name, p.models]);
  for (const bad of [null, undefined, 42, "nope", { wide: null }, { wide: { models: "x" } }]) {
    const got = build(fixture({ discovery: bad })).providers.map((p) => [p.name, p.models]);
    assert.deepEqual(got, base, `discovery=${JSON.stringify(bad)} must change nothing`);
  }
});

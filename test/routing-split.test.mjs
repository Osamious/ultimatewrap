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
  ANCHOR_PREFERENCE, ANTHROPIC_TIERS, ANTHROPIC_RELAY, ANTHROPIC_FULL,
  PROVENANCE_ORDER, PROVENANCE_UNRANKED, provenanceOf, provenanceRank, verifiedIndex,
  reconcileUserModelPin,
} from "../keysync/keysync.mjs";
import {
  resolveAnchor, resolveBare, bareIdCensus, checkBareCollisions,
  orderNativePickerOptions, assertOptionsComplete,
} from "../keysync/run.mjs";

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
    // FORTY, AND ZERO-PADDED, both for reasons R13b made load-bearing. The cap
    // went 3 -> 10, so nine entries no longer produce a routing/picker GAP at
    // all -- the picker would take every row and the tests below would prove
    // nothing about the split they exist to pin. The padding keeps every id the
    // same LENGTH, so the id-length sort term still ties and insertion order is
    // still the whole of the ranking, which is what the ordering tests assert.
    ["wide", Array.from({ length: 40 }, (_, i) =>
      ({ provider: "wide", model: `wide-m${String(i).padStart(2, "0")}`,
         id: `wide/wide-m${String(i).padStart(2, "0")}`,
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

  // A GAP, not a number. `wide` has one testModel plus forty catalogue entries.
  assert.equal(wide.models.length, 41, "testModel + 40 catalogue entries, uncapped");
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

test("the cap parse is STRICT: a bad value that is not 3 still resolves to 3", () => {
  // THE LIST ABOVE CANNOT FAIL AGAINST A LOOSE PARSE, which is the hole this
  // closes. Every bad value there ("3.0", "0x3", "3e0", "-1", "0", "abc3")
  // happens to resolve to 3 under a loose parse TOO -- `Number("3.0")` is 3, and
  // the negatives and zero are rejected by the `n > 0` clause that survives any
  // mutation of the regex. So the assertion "must resolve to the default" was
  // satisfied by the mutant for the wrong reason: the bad values collided with
  // the default.
  //
  // MEASURED, two mutants of `keysync.mjs`'s `/^\d+$/` survived the whole file:
  //   `Number.isInteger(Number(s))`      accepts "5.0" -> 5
  //   `/^[-+]?\d+(\.\d+)?$/`             accepts "5.0" -> parseInt -> 5
  // Both are stopped here and nowhere else, because 5 !== 3 is the only way to
  // tell a fallback apart from a successful loose parse.
  for (const bad of ["5.0", "5e0", "0x5", "+5", "5px", "-5", "5,0"]) {
    assert.equal(pickerCapFrom(bad), MAX_PICKER_MODELS_PER_PROVIDER,
      `UW_MAX_MODELS=${JSON.stringify(bad)} must fall back to 3, never parse loosely to 5`);
  }
  // ...and the strict spelling of the same number is still honoured, so the
  // assertions above are rejecting the SPELLING and not the value. Surrounding
  // whitespace is part of that spelling: the regex runs on the TRIMMED string,
  // so `" 5 "` is a valid 5 and is deliberately not in the list above.
  assert.equal(pickerCapFrom("5"), 5);
  assert.equal(pickerCapFrom(" 5 "), 5);
});

test("a cap too large to be an integer falls back rather than unbounding the picker", (t) => {
  // `Number.isSafeInteger` at keysync.mjs:333. Removing it survives every other
  // assertion in this file: `/^\d+$/` admits a 20-digit run of digits,
  // `Number.parseInt` yields 1e20, `n > 0` is true, and `models.slice(0, 1e20)`
  // is the whole array -- an unbounded picker, which is the exact failure
  // `pickerCapFrom` exists to prevent, reached through the one input the regex
  // was never going to catch.
  const saved = process.env.UW_MAX_MODELS;
  t.after(() => {
    if (saved === undefined) delete process.env.UW_MAX_MODELS;
    else process.env.UW_MAX_MODELS = saved;
  });

  const huge = "99999999999999999999";
  assert.ok(!Number.isSafeInteger(Number.parseInt(huge, 10)),
    "the fixture must actually exceed the safe-integer range, or this proves nothing");
  assert.equal(pickerCapFrom(huge), MAX_PICKER_MODELS_PER_PROVIDER,
    "an unrepresentable count is not a count");

  // THE BOUND, not merely the parsed number. `wide` has 10 candidates, so a
  // guard-free build shows all 10 and a defaulted one shows 3.
  process.env.UW_MAX_MODELS = huge;
  assert.equal(pickerFor(build(fixture()), "wide").length, MAX_PICKER_MODELS_PER_PROVIDER,
    `UW_MAX_MODELS=${huge} left the picker unbounded`);
});

// ---- the capability VOCABULARY, not just its precedence --------------------

test("a capability token is normalised, so case/hyphen/space variants still classify", () => {
  // `capabilityKind`'s `.trim().toLowerCase().replace(/[\s-]+/g, "_")` was
  // entirely unpinned: removing it survived the file, because every token the
  // other tests pass is already lower-case and underscored. The tokens providers
  // actually send are not.
  //
  // WHAT REMOVING IT COSTS, and it is a modality-guard bypass rather than a
  // cosmetic miss. An unnormalised `"Image"` matches neither set, so
  // `capabilityKind` answers `null` -- no signal -- and `outputKind` falls
  // through to the bundle, which reads such a row as ordinary text. The row then
  // sorts with the chat models and can re-enter a provider's picker top-3: a
  // media generator advertised as a chat model, which is precisely what the
  // precedence rule was added to stop.
  for (const token of ["Image", "image-gen", "IMAGE GEN", " image ", "Video",
                       "TTS", "Image-Gen", "video gen", "EMBEDDINGS"]) {
    assert.equal(capabilityKind(token), "nontext",
      `${JSON.stringify(token)} is a non-text claim in any casing or separator`);
  }
  for (const token of ["Chat", "CHAT", " completion ", "Completions", "TEXT"]) {
    assert.equal(capabilityKind(token), "text", `${JSON.stringify(token)} is a text claim`);
  }

  // ...and it reaches `outputKind`, so the normalisation is load-bearing on the
  // path that actually decides the row rather than only in the classifier.
  assert.equal(outputKind({ modalities: { output: ["text"] } }, "Image"), "nontext",
    "an unnormalised token would defer to the bundle and read as text");

  // ...and through to the SELECTION SORT, which is where the bypass would be
  // user-visible: `aa` is the shorter id and leads without a live capability.
  const f = fixture();
  f.chosen = [{ id: "personal.gen.free", provider: "gen" }];
  f.vault = new Map([["gen", { protocol: "openai", baseUrl: "https://gen.invalid/v1" }]]);
  f.catalog.byProvider = new Map([["gen", [
    { provider: "gen", model: "aa", id: "gen/aa", modalities: { output: ["text"] } },
    { provider: "gen", model: "bbbbbbbb", id: "gen/bbbbbbbb", modalities: { output: ["text"] } },
  ]]]);
  f.discovery = { gen: { outcome: "ok", models: [{ id: "aa", capabilityRaw: "Image-Gen" }] } };
  const built = build(f);
  assert.deepEqual(byName(built, "gen").models, ["bbbbbbbb", "aa"],
    "a mixed-case hyphenated media claim must demote the row exactly as `image_gen` does");
});

// ---- the discovery entry SHAPE filter --------------------------------------

test("malformed discovery ENTRIES are dropped before the admission gate", () => {
  // `discoveryIndex`'s `typeof m?.id === "string" && m.id !== ""` at
  // keysync.mjs:708. Removing it survived the file because every existing test
  // passes malformed RECORDS (`42`, `"nope"`, `{models: "x"}`) and never a
  // malformed ENTRY inside an otherwise-valid `models` array -- a different
  // shape, reached through a different branch.
  //
  // TWO FAILURES IF IT GOES. `discovered.map((m) => m.id)` throws outright on an
  // `undefined` entry; and the shapes that do NOT throw (a number, a bare
  // string, `{id: ""}`) reach `admitRemoteModels` as `undefined`/`""`, which
  // `admitId` coerces to "" and rejects -- printing
  // `SECURITY: provider "listed" advertised N rejected model name(s)` for rows
  // no provider ever advertised. run.mjs:754-761 records why that matters: step 4
  // asks an operator to READ that line and stop on it, and burying it in false
  // positives is how a security channel stops being read.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  let built;
  try {
    built = build(fixture({ discovery: {
      listed: { outcome: "ok", models: [
        { id: "listed-ok-1" }, undefined, null, 42, "listed-raw-string",
        { id: "" }, { notAnId: "x" }, { id: 7 }, { id: "listed-ok-2" },
      ] },
    } }));
  } finally { console.warn = realWarn; }

  const p = byName(built, "listed");
  assert.deepEqual(p.models, ["listed-probe", "listed-ok-1", "listed-ok-2"],
    "exactly the two well-formed entries join the testModel; nothing else survives");
  assert.equal(warnings.filter((w) => /SECURITY: provider "listed"/.test(w)).length, 0,
    "a malformed entry is not an advertised name, and must not raise a SECURITY finding");
});

// ---- provenance ORDER, pinned so R13b's decision stays deliberate ----------

test("R13b: a live listing now OUTRANKS the bundle, and insertion order is the tiebreak", () => {
  // THE DEFERRED DECISION, NOW MADE. Until R13b this asserted the opposite --
  // "catalogue ids precede discovery-only ids, and that order decides the top-3"
  // -- and said so explicitly: *"Ranking a live listing above the bundle is
  // R13b's call, with its own evidence."* This is that call, and the evidence is
  // in PROVENANCE_ORDER: a listing is what the provider serves TODAY, the bundle
  // is a periodic snapshot merged across hosts.
  //
  // WHAT THE OLD ASSERTION PROTECTED IS STILL PROTECTED. Its real subject was
  // that ordering must not change as an invisible side effect of swapping the
  // two gather loops. That is now pinned one layer down: the loops still gather
  // catalogue-then-discovery, and for rows on the SAME rung insertion order is
  // still the whole of the ranking -- asserted below on the two catalogue rows
  // the listing does not name.
  const f = fixture();
  f.chosen = [{ id: "personal.ord.free", provider: "ord" }];
  f.vault = new Map([["ord", { protocol: "openai", baseUrl: "https://ord.invalid/v1" }]]);
  // Five ids, all length 2, all text-or-no-signal, all tier `unknown`: every
  // OTHER sort term ties by construction, so the only two things that can order
  // these rows are the provenance rung and, within a rung, insertion order.
  f.catalog.byProvider = new Map([["ord", ["c1", "c2", "c3"].map((m) =>
    ({ provider: "ord", model: m, id: `ord/${m}`, modalities: { output: ["text"] } }))]]);
  // The listing names `c3` -- a CATALOGUE row -- as well as the two it
  // contributes on its own. Promoting c3 is what proves the rung is keyed by id
  // rather than by which loop gathered the row.
  f.discovery = { ord: { outcome: "ok", models: [{ id: "c3" }, { id: "d1" }, { id: "d2" }] } };

  const built = build(f);
  assert.deepEqual(byName(built, "ord").models, ["c3", "d1", "d2", "c1", "c2"],
    "listing-verified rows first, catalogue-only after");
  // WITHIN A RUNG, INSERTION ORDER IS UNCHANGED: the gather loops still run
  // catalogue-then-discovery, so `c3` leads `d1`/`d2` on the same rung and `c1`
  // leads `c2` on theirs. Swapping the two loops still changes this, and still
  // must not happen silently.
  assert.deepEqual(byName(built, "ord").models.slice(0, 3), ["c3", "d1", "d2"]);
  assert.deepEqual(byName(built, "ord").models.slice(3), ["c1", "c2"]);
  // The picker is still a prefix of that one ordering, so the menu agrees.
  assert.deepEqual(pickerFor(built, "ord"),
    ["ord/c3", "ord/d1", "ord/d2", "ord/c1", "ord/c2"]);

  // CONTROL: strike the discovery input and every row drops to `catalogue-only`
  // together, the term evaluates 3 - 3 = 0 for every pair, and the pre-R13b
  // order returns. This is what proves the reordering above is the rung and not
  // the gather order.
  f.discovery = {};
  assert.deepEqual(byName(build(f), "ord").models, ["c1", "c2", "c3"]);
});

// ---- the declaration channel, asserted as a SET ----------------------------

test("widening routing leaves the {model, behavesAs} declaration channel intact", () => {
  // R11's commit message claims the declaration channel is byte-identical --
  // routing widened, declarations did not. That claim shipped unverified: no
  // assertion anywhere compared the PAIRS, only counts and prefixes.
  //
  // A SET, NOT A COUNT. A count is satisfied by one row gaining a declaration
  // while another loses one, which is the exact shape a `behavesAs` regression
  // takes -- `lH()` resolves a missing or wrong declaration to the maximal
  // assumption set, silently.
  //
  // OVER THE FIXTURE, NOT THE REAL VAULT, and that is deliberate. `loadVault`
  // reads `~/.llmkeys` and `loadCatalog` reads a hardcoded absolute path into
  // the machine's global claude-code-router install, which `npm i -g` replaces
  // wholesale -- report 08 F9's recorded hazard, and the reason
  // `catalog.test.mjs`'s corpus test asserts invariants and keeps its counts in
  // a comment. Pinning the shipped rows here would make a true statement about
  // one bundle version and then rot into a false failure on the next.
  //
  //   MEASURED 2026-09-07 on the real vault, `node keysync/run.mjs --dry`:
  //   routing 83 -> 1,584 third-party entries across 44 providers while the
  //   third-party picker stays at 83 rows (1,501 undeclared, which the dry run
  //   now prints). With the relay: 45 providers, 94 picker rows.
  //   R13b, 2026-09-08: the cap moved 3 -> 10, so the picker now declares TEN
  //   rows per provider instead of three and this pin grew with it. That is
  //   R13b's deliberate change and the reason it is the task that owns the
  //   sizing -- R11's claim was that widening ROUTING changed no declaration,
  //   and it still holds: what changed the declarations here is the cap, not the
  //   union. On the real vault the third-party picker goes 83 -> 189 rows
  //   (94 -> 200 with the relay) and undeclared falls 1,501 -> 1,395 of 1,584.
  const built = build(fixture());
  const pairs = built.picker.map((r) => [r.model, r.behavesAs ?? null]).sort();

  assert.deepEqual(pairs, [
    ["gorouter/claude-opus-4-8", "claude-sonnet-4-5"],
    ["listed/listed-probe", "claude-sonnet-4-5"],
    ["tabiai/claude-opus-4-8", "claude-sonnet-4-5"],
    ...Array.from({ length: 9 }, (_, i) =>
      [`wide/wide-m0${i}`, "claude-sonnet-4-6"]),
    ["wide/wide-probe", "claude-sonnet-4-5"],
  ], "the declaration channel, pair for pair");

  // EVERY ROW STILL CARRIES ONE. The count grew; the invariant that no picker
  // row is left undeclared did not, and that is the half `lH()` punishes.
  assert.ok(built.picker.every((r) => typeof r.behavesAs === "string" && r.behavesAs),
    "an absent declaration resolves to the MAXIMAL assumption set, never to none");

  // The gap the pin is a statement ABOUT: routing carries more than three times
  // what the picker declares, so "the declarations did not change" is a claim
  // with content rather than a restatement of an unchanged build.
  const routing = built.providers.reduce((n, p) => n + p.models.length, 0);
  assert.equal(routing, 44);
  assert.equal(built.picker.length, 13);
  assert.ok(routing > built.picker.length,
    "if routing did not widen, this test proves nothing about widening");
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

// ---- R13: the profile anchor did not move ----------------------------------
//
// R11 widened `providers[].models` and left the picker capped, and its commit
// message reports "picker stays 83". That is a COUNT, and this file's own rule is
// that a count is satisfied by one row arriving as another leaves. R11 also
// shipped capability precedence, which REORDERS the picker -- and the anchor's
// last fallback is `picker[0]`, so ordering alone can repoint all six CCR profile
// tiers with no error and no diff nearby.
//
//   MEASURED 2026-09-08, pre-R11 (a68caab) vs HEAD, one vault, one catalogue, one
//   day. `menu/denylist.mjs` and `keysync/catalog-join.mjs` are byte-identical
//   across that range (`git diff a68caab HEAD --` on both is empty), so the old
//   builder ran against today's real inputs and R11 is the only variable:
//
//     pre-R11    83 picker rows, routing    83, anchor google/gemini-3.5-flash-lite
//     post-R11   83 picker rows, routing 1,584, anchor google/gemini-3.5-flash-lite
//
//   The picker was ORDER-identical, row for row -- not merely equal as a set.
//   Both anchors resolve at ANCHOR_PREFERENCE[0] by exact match. The picker head
//   was `orcarouter/orcarouter/free` on both, so the fallback that would have made
//   the anchor a free-tier router row never got a vote.
//
// That comparison is a measurement and cannot live in an assertion: it needs the
// real `~/.llmkeys` and the hardcoded global claude-code-router bundle path
// (report 08 F9). What IS asserted here is the property the measurement rests on
// -- that the anchor is decided by the preference list rather than by picker
// order -- plus the control proving the fallback is reachable at all.

const pickerOf = (...models) => models.map((model) => ({ model }));

test("the anchor is decided by ANCHOR_PREFERENCE, and picker ORDER cannot move it", () => {
  // The shipped preference list, not a fixture one: the claim is about the real
  // rule. Its first entry is an exact id, so a picker carrying it must anchor
  // there no matter what else is present or where.
  const head = ANCHOR_PREFERENCE[0];
  assert.ok(!head.endsWith("/"), "this test reads ANCHOR_PREFERENCE[0] as an exact id");

  const rows = ["orcarouter/orcarouter/free", head, "zzz/last"];
  const forward = resolveAnchor(pickerOf(...rows), { anthropicOn: false });
  assert.deepEqual(forward, { model: head, via: `preference:${head}` },
    "the preference entry wins over the row that happens to sort first");

  // THE R11-SHAPED REGRESSION, REPRODUCED: a capability signal demotes a row and
  // the whole picker reorders. The anchor must not notice.
  for (const order of [[...rows].reverse(), [rows[1], rows[0], rows[2]], [rows[2], rows[0], rows[1]]]) {
    assert.deepEqual(resolveAnchor(pickerOf(...order), { anthropicOn: false }), forward,
      `reordering the picker to ${JSON.stringify(order)} must not move the anchor`);
  }
});

test("CONTROL: with no preference row present the anchor IS the picker head", () => {
  // Without this the test above proves nothing -- it would pass identically if
  // `picker-head` were unreachable dead code. It is reachable, and reaching it is
  // the silent failure: six tiers pointed at whatever sorted first.
  const got = resolveAnchor(pickerOf("orcarouter/orcarouter/free", "zzz/last"), { anthropicOn: false });
  assert.deepEqual(got, { model: "orcarouter/orcarouter/free", via: "picker-head" });
  assert.notEqual(got.model, ANCHOR_PREFERENCE[0]);
});

test("a prefix preference matches by prefix, and earlier entries still outrank it", () => {
  // Four of the six shipped entries end in `/`. Both branches of the one
  // conditional in the resolver need a case, or half the rule is unasserted.
  const prefix = ANCHOR_PREFERENCE.find((p) => p.endsWith("/"));
  assert.ok(prefix, "the prefix branch is unreachable if no shipped entry ends in `/`");
  assert.deepEqual(resolveAnchor(pickerOf(`${prefix}some-model`), { anthropicOn: false }),
    { model: `${prefix}some-model`, via: `preference:${prefix}` });
  // ...and the exact entry ahead of it in the list still wins when both are present.
  assert.deepEqual(
    resolveAnchor(pickerOf(`${prefix}some-model`, ANCHOR_PREFERENCE[0]), { anthropicOn: false }).model,
    ANCHOR_PREFERENCE[0], "preference order, not picker order, breaks the tie");
});

test("with the relay live the anchor is a CONSTANT, immune to the picker entirely", () => {
  // The branch that actually ships today (`anthropicOn: true`). It reads no row,
  // so no picker change of any kind can reach it -- which is why the measured
  // pre/post-R11 comparison above had to be run on the relay-off branch to say
  // anything at all.
  const got = resolveAnchor(pickerOf("anything/at-all"), { anthropicOn: true });
  assert.deepEqual(got, { model: ANTHROPIC_TIERS.model, via: "anthropic-tiers" });
  assert.deepEqual(resolveAnchor([], { anthropicOn: true }), got,
    "it does not even read picker[0], so an empty picker cannot throw on this branch");
});

test("`verifiedOrder` is consulted BELOW the preference list and only for rows that exist", () => {
  const fast = "fast/verified-model";
  assert.deepEqual(resolveAnchor(pickerOf(fast), { anthropicOn: false, verifiedOrder: [fast] }),
    { model: fast, via: "verified" });
  // A verified id whose row was pruned must not be anchored on.
  assert.deepEqual(
    resolveAnchor(pickerOf("other/row"), { anthropicOn: false, verifiedOrder: ["gone/row"] }),
    { model: "other/row", via: "picker-head" });
  // ...and it never outranks a preference hit.
  assert.equal(
    resolveAnchor(pickerOf(fast, ANCHOR_PREFERENCE[0]), { anthropicOn: false, verifiedOrder: [fast] }).via,
    `preference:${ANCHOR_PREFERENCE[0]}`);
});

// ---- R13: the bare-id census, and that ambiguity FAILS CLOSED ---------------
//
//   MEASURED 2026-09-08 against the REAL built config, relay live, no discovery
//   cache wired (R11 shipped without one), `--verified-only` off:
//
//     45 providers (44 vault + relay), 1,599 routing ENTRIES
//     1,465 distinct bare ids
//       1,359 sole-owned                    <- CCR binds these
//         106 ambiguous (2+ providers)      <- CCR binds NONE of these
//          11 Claude-shaped distinct, of which 1 is ambiguous
//     checkBareCollisions: hijackable 0, shadowed 1, fatal false, catalogVerified true
//       shadowed: claude-opus-4-8 <- anthropic + gorouter + tabiai
//
// THE CENSUS IS 106, NOT THE PLAN'S 667, AND THE DIFFERENCE IS THE DENOMINATOR.
// `plans/model-resolver-decisions.md:544` states 667 for a ~3,784-routing-id
// scenario. The shipped width is 1,599 entries / 1,465 distinct ids, because R11
// wired no discovery cache -- routing is testModel u catalogue only. 667 was never
// a measurement of what shipped, and is not restated here as one.
//
// The COUNT is not what these tests pin. Counts over the real vault rot on the
// next `npm i -g` (see the note at the declaration-channel test above). The
// PROPERTIES below hold at any width, and are asserted over the fixture.

const relayWith = (...ids) => ({ ...ANTHROPIC_RELAY, models: ids });

test("no Claude-shaped bare id is sole-owned by a reseller: hijackable is 0", () => {
  // The fixture reproduces the real config's ONE Claude-shaped ambiguity exactly:
  // tabiai and gorouter both carry `claude-opus-4-8` as their testModel, which is
  // the shape R10 measured live. Two owners, so CCR binds nothing.
  const providers = build(fixture()).providers;
  const census = bareIdCensus(providers);
  assert.deepEqual(census.owners.get("claude-opus-4-8"), ["gorouter", "tabiai"]);

  // Both guard branches: `realIds: null` is the BROAD one (relay down, no cache --
  // every RESERVED-shaped id the config advertises becomes a selector), and a
  // populated set is the narrowed one the live catalogue produces.
  for (const realIds of [null, new Set([...ANTHROPIC_FULL, "claude-opus-4-8"])]) {
    const c = checkBareCollisions(providers, { realIds });
    assert.equal(c.hijackable.length, 0,
      `hijackable must be 0 with realIds=${realIds === null ? "null" : "populated"}`);
    assert.equal(c.fatal, false);
    assert.deepEqual(c.shadowed.map((s) => s.id), ["claude-opus-4-8"],
      "the id is reported as a shared claim, which is what CCR refuses to bind");
  }
});

test("CONTROL: strike the co-owner and the same id becomes hijackable", () => {
  // The assertion above is a claim about ownership, not about the guard being
  // asleep. Removing gorouter leaves tabiai as the sole owner of a Claude-shaped
  // name -- the exploitable shape -- and the guard must go fatal on it.
  const providers = build(fixture()).providers.filter((p) => p.name !== "gorouter");
  const c = checkBareCollisions(providers, { realIds: null });
  assert.deepEqual(c.hijackable.map((h) => `${h.id}<-${h.owner}`), ["claude-opus-4-8<-tabiai"]);
  assert.equal(c.fatal, true);
  // ...and the census agrees the ambiguity is what was protecting it.
  assert.equal(bareIdCensus(providers).ambiguous.includes("claude-opus-4-8"), false);
});

test("EVERY ambiguous bare id resolves to nothing -- ambiguity fails closed", () => {
  // The property that must hold at any width. `bareIdCensus` counts providers;
  // `resolveBare` models CCR's own rule (count matching ENTRIES, bind on exactly
  // one). They are separate computations over the same input on purpose -- if one
  // were defined in terms of the other this assertion would be a restatement of
  // its own definition rather than a check.
  const providers = build(fixture()).providers;
  const census = bareIdCensus(providers);
  assert.ok(census.ambiguous.length > 0, "a fixture with no ambiguity proves nothing here");

  for (const id of census.ambiguous) {
    assert.equal(resolveBare(providers, id), undefined,
      `"${id}" has ${census.owners.get(id).length} owners and must bind to nothing`);
  }
  // The other half, or "binds nothing" would be satisfied by binding nothing ever.
  for (const id of census.soleOwned) {
    const hit = resolveBare(providers, id);
    assert.ok(hit, `"${id}" has exactly one owner and must resolve`);
    assert.deepEqual([hit.provider], census.owners.get(id));
  }
  assert.equal(census.ambiguous.length + census.soleOwned.length, census.owners.size,
    "every id is counted exactly once, so neither list can hide a row");
});

test("the relay CO-OWNING an id is what keeps it unbindable, not the guard's opinion", () => {
  // The real config's shadowed row is `anthropic + gorouter + tabiai`. Adding the
  // relay must not make the id bindable -- three owners is still not one.
  const providers = [relayWith(...ANTHROPIC_FULL, "claude-opus-4-8"), ...build(fixture()).providers];
  const census = bareIdCensus(providers);
  assert.deepEqual(census.owners.get("claude-opus-4-8"),
    ["anthropic", "gorouter", "tabiai"], "the real config's shadowed row, reproduced");
  assert.equal(resolveBare(providers, "claude-opus-4-8"), undefined);
  // The relay's OWN curated ids are sole-owned, so they DO bind -- which is the
  // whole point of running it.
  for (const id of ANTHROPIC_FULL) {
    assert.deepEqual(census.owners.get(id), ["anthropic"]);
    assert.equal(resolveBare(providers, id)?.provider, "anthropic");
  }
  assert.equal(checkBareCollisions(providers, { realIds: null }).hijackable.length, 0);
});

test("ENTRIES, not providers: one provider listing an id twice binds nothing", () => {
  // The census counts providers and `resolveBare` counts entries, and this is the
  // one input where the two must disagree. CCR's `resolve()` sees two matches and
  // returns undefined, so a census-shaped model of binding would be wrong here.
  const providers = [{ name: "dup", models: ["m", "m"] }, { name: "solo", models: ["n"] }];
  assert.deepEqual(bareIdCensus(providers).owners.get("m"), ["dup"], "one OWNER");
  assert.deepEqual(bareIdCensus(providers).soleOwned, ["m", "n"]);
  assert.equal(resolveBare(providers, "m"), undefined, "...but two ENTRIES, so nothing binds");
  assert.equal(resolveBare(providers, "n")?.provider, "solo");
  assert.equal(resolveBare(providers, "absent"), undefined, "and an unadvertised name binds nothing");
});

// ==========================================================================
// R13b: the picker cap is sized from measurement, and selection carries a
// provenance term.
//
// The measurement itself is a report, not a test (it needs the real vault) --
// see the table beside MAX_PICKER_MODELS_PER_PROVIDER. What is testable, and
// what these cover, is the BEHAVIOUR the chosen cap and the new sort term
// produce, plus the four invariants that adding rows to `options[]` can break.
// ==========================================================================

/**
 * A single provider whose extras are separated by provenance and NOTHING else.
 *
 * Every catalogue id is the SAME LENGTH, the same `kind` and the same tier, so
 * the three pre-existing sort terms all evaluate to 0 for every pair and the
 * only thing that can reorder these rows is the term under test. Without that,
 * a passing assertion could be id-length doing the work.
 */
function provFixture() {
  const chosen = [{ id: "personal.prov.free", provider: "prov" }];
  const vault = new Map([["prov",
    { protocol: "openai", baseUrl: "https://prov.invalid/v1", testModel: "prov-probe" }]]);
  const byProvider = new Map([["prov", ["aaa1", "aaa2", "aaa3", "aaa4"].map((m) =>
    ({ provider: "prov", model: m, id: `prov/${m}`, ...text({}) }))]]);
  return { chosen, vault, catalog: { generatedAt: "fixture", byProvider, byAlias: new Map() } };
}
const provIds = (built) =>
  built.picker.filter((r) => r.model.startsWith("prov/")).map((r) => r.model.slice("prov/".length));

test("R13b: the four provenance rungs rank in the stated order, unranked last", () => {
  // The vocabulary on its own, which is the only place all five levels are
  // reachable at once -- see the buildProviders test below for why
  // `config-asserted` cannot appear in that sort today.
  assert.deepEqual([...PROVENANCE_ORDER],
    ["call-verified", "config-asserted", "listing-verified", "catalogue-only"]);
  const ranks = PROVENANCE_ORDER.map(provenanceRank);
  assert.deepEqual(ranks, [0, 1, 2, 3], "strictly increasing, best first");
  assert.equal(provenanceRank(null), PROVENANCE_UNRANKED);
  assert.equal(provenanceRank("something-else"), PROVENANCE_UNRANKED);
  assert.ok(PROVENANCE_UNRANKED > Math.max(...ranks), "unranked sorts after every named rung");
});

test("R13b: an id in several sets takes the STRONGEST rung, not the first checked", () => {
  const all = {
    verified: new Set(["m"]), asserted: new Set(["m"]),
    listed: new Set(["m"]), catalogued: new Set(["m"]),
  };
  assert.equal(provenanceOf("m", all), "call-verified");
  assert.equal(provenanceOf("m", { ...all, verified: undefined }), "config-asserted");
  assert.equal(provenanceOf("m", { ...all, verified: undefined, asserted: undefined }),
    "listing-verified");
  assert.equal(provenanceOf("m", { catalogued: all.catalogued }), "catalogue-only");
  assert.equal(provenanceOf("m", {}), null, "no set names it -> unranked");
  assert.equal(provenanceOf("m"), null, "and no sets at all must not throw");
});

test("R13b (#59): config-asserted outranks listing-verified, not the reverse", () => {
  // THE REGRESSION THIS PINS. The vault's `testModel` and the relay's four model
  // ids are asserted by local config with nothing probing them. Ranked below
  // `listing-verified` they sort under every third-party listing row, which is
  // what #59 fixed once already.
  assert.ok(provenanceRank("config-asserted") < provenanceRank("listing-verified"),
    "a config literal must not sort below a third-party listing row");
  // ...and it is still BELOW a real dated completion, which is the other half:
  // "a human wrote this id in a file" is not "a 200 came back".
  assert.ok(provenanceRank("call-verified") < provenanceRank("config-asserted"));
  const sets = { asserted: new Set(["x"]), listed: new Set(["x"]) };
  assert.equal(provenanceOf("x", sets), "config-asserted");
});

test("R13b: verifiedIndex reads verify-prune's shape and splits on the FIRST slash", () => {
  // Ids contain slashes. Splitting on every slash keys these under a provider
  // that does not exist and silently drops the strongest rung.
  const doc = { working: ["cloudflare/@cf/openai/gpt-oss-120b",
                          "nscale/Qwen/Qwen3-4B-Instruct-2507", "google/gemini-3.5-flash-lite"] };
  const idx = verifiedIndex(doc);
  assert.ok(idx.get("cloudflare").has("@cf/openai/gpt-oss-120b"));
  assert.ok(idx.get("nscale").has("Qwen/Qwen3-4B-Instruct-2507"));
  assert.ok(idx.get("google").has("gemini-3.5-flash-lite"));
  // `results` is filtered by `ok` -- a 401 or a timeout is the OPPOSITE of
  // call-verified, and verify-prune records those in the same array.
  const fromResults = verifiedIndex({ results: [
    { model: "p/good", ok: true }, { model: "p/bad", ok: false },
  ] });
  assert.deepEqual([...fromResults.get("p")], ["good"], "only ok:true rows are call-verified");
  // Absent / malformed costs a rung, never a build.
  assert.equal(verifiedIndex(null).size, 0);
  assert.equal(verifiedIndex({ nonsense: 1 }).size, 0);
  assert.equal(verifiedIndex(["nostash", "/leading", "trailing/"]).size, 0,
    "an entry with no usable provider/id split contributes nothing");
});

test("R13b: provenance reorders buildProviders' extras, and is a no-op without inputs", () => {
  const f = provFixture();
  // CONTROL FIRST. With neither input the term evaluates 3 - 3 = 0 for every
  // pair -- every extra is catalogue-only -- so the order is insertion order.
  // This is also today's production state: run.mjs passes neither.
  const plain = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  assert.deepEqual(provIds(plain), ["prov-probe", "aaa1", "aaa2", "aaa3", "aaa4"]);

  // Now supply both. `aaa3` was probed; `aaa2` and the discovery-only `bbb1`
  // are listed; `aaa1`/`aaa4` are catalogue-only.
  const ranked = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test",
    { prov: { outcome: "ok", models: [{ id: "aaa2" }, { id: "bbb1" }] } },
    { working: ["prov/aaa3"] });
  assert.deepEqual(provIds(ranked),
    ["prov-probe", "aaa3", "aaa2", "bbb1", "aaa1", "aaa4"],
    "call-verified, then the two listed rows, then catalogue-only");

  // The testModel still LEADS, and that is not the sort's doing: it is pushed
  // ahead of `extras` and so is never ranked at all. If that ever changes, the
  // `asserted` set passed to provenanceOf is what keeps it second rather than
  // dropping it to catalogue-only.
  assert.equal(provIds(ranked)[0], "prov-probe");
  assert.ok(!provIds(ranked).slice(1).includes("prov-probe"));
});

test("R13b: provenance outranks tier and id length, but NOT `kind`", () => {
  // A catalogue-only row that wins every term below provenance (shortest id,
  // text) must still sort BELOW a longer call-verified row.
  const f = provFixture();
  f.catalog.byProvider.set("prov", [
    { provider: "prov", model: "z", id: "prov/z", ...text({}) },
    { provider: "prov", model: "much-longer-id", id: "prov/much-longer-id", ...text({}) },
  ]);
  const plain = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  assert.deepEqual(provIds(plain).slice(1), ["z", "much-longer-id"], "length decides, unranked");
  const ranked = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test", null,
    { working: ["prov/much-longer-id"] });
  assert.deepEqual(provIds(ranked).slice(1), ["much-longer-id", "z"],
    "a probed row beats a shorter unprobed one");
});

test("R13b: `kind` outranks provenance -- evidence never promotes a non-chat row", () => {
  // R13b's brief put provenance ABOVE `kind`. That order is self-defeating and
  // this is the fixture that shows it: the live `capability` token is the SAME
  // signal on both sides -- it demotes the row through `outputKind` and, because
  // only a listing can carry it, promotes the row to `listing-verified`. Ranked
  // above `kind` the promotion wins, so supplying discovery makes a declared
  // image generator sort HIGHER than it did with no discovery at all.
  //
  // `kind === "nontext"` is a DISQUALIFIER; provenance is a quality ranking over
  // rows that already passed it. Strong evidence about an image generator is
  // still evidence about an image generator.
  const f = provFixture();
  f.catalog.byProvider.set("prov", [
    { provider: "prov", model: "gen", id: "prov/gen", modalities: { output: ["audio", "text"] } },
    { provider: "prov", model: "chatchat", id: "prov/chatchat", ...text({}) },
  ]);
  // `gen` is BOTH listing-verified and call-verified -- the strongest rung there
  // is -- while `chatchat` is catalogue-only and has the longer id, so every
  // other term favours `gen`. Only `kind` can hold it back.
  const built = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test",
    { prov: { outcome: "ok", models: [{ id: "gen", capabilityRaw: "image_gen" }] } },
    { working: ["prov/gen"] });
  assert.deepEqual(provIds(built).slice(1), ["chatchat", "gen"],
    "the declared non-text row stays demoted despite outranking on every other term");
  // NEVER PRUNED, only reordered -- rule 1 is not a ranking rule.
  assert.ok(byName(built, "prov").models.includes("gen"));
  // CONTROL: strike only the capability token and `gen` returns to the head,
  // which proves `kind` is what demoted it rather than anything else here.
  const noCap = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test",
    { prov: { outcome: "ok", models: [{ id: "gen" }] } }, { working: ["prov/gen"] });
  assert.deepEqual(provIds(noCap).slice(1), ["gen", "chatchat"]);
});

test("R13b: the cap is 10, and it bounds the PICKER without touching routing", () => {
  assert.equal(MAX_PICKER_MODELS_PER_PROVIDER, 10,
    "sized 2026-09-08 from the five-candidate parse/byte measurement; see the table at the constant");
  // 1 testModel + 14 catalogue ids: past the cap, so the bound is observable.
  const f = provFixture();
  f.catalog.byProvider.set("prov", Array.from({ length: 14 }, (_, i) =>
    ({ provider: "prov", model: `m${String(i).padStart(2, "0")}`,
       id: `prov/m${i}`, ...text({}) })));
  const built = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  assert.equal(provIds(built).length, MAX_PICKER_MODELS_PER_PROVIDER);
  assert.equal(byName(built, "prov").models.length, 15, "routing keeps every id, uncapped");
  // The picker is a PREFIX of routing, not a re-ranking -- the two must not
  // disagree about which rows a provider's best ten are.
  assert.deepEqual(provIds(built), byName(built, "prov").models.slice(0, 10));
});

// ---- the four invariants a larger picker can break -------------------------

test("R13b re-check: V7 (assertOptionsComplete) still passes at the larger cap", () => {
  // Adding rows to `options[]` is safe for a SUBSET assertion, but V7 is what
  // guarantees `behavesAs` reaches every built row, so it is confirmed rather
  // than assumed.
  const f = provFixture();
  f.catalog.byProvider.set("prov", Array.from({ length: 14 }, (_, i) =>
    ({ provider: "prov", model: `m${i}`, id: `prov/m${i}`, ...text({}) })));
  const built = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  const written = orderNativePickerOptions(built.picker)
    .map(({ contextTokens, kind, ...row }) => row);
  assert.doesNotThrow(() => assertOptionsComplete(built.picker, written));
  // The control: V7 is reachable, so the pass above is not vacuous.
  assert.throws(() => assertOptionsComplete(built.picker, written.slice(1)),
    /did not reach modelPicker\.options/);
});

test("R13b re-check: relay rows stay at the head of a longer menu", () => {
  // `Ato()` iterates options[] in array order and the native menu shows 10 rows
  // with 1-row scrolling and no filter, so relay-first is what keeps a 200-row
  // menu usable at all.
  const f = provFixture();
  f.catalog.byProvider.set("prov", Array.from({ length: 14 }, (_, i) =>
    ({ provider: "prov", model: `m${i}`, id: `prov/m${i}`, ...text({}) })));
  const built = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  const relay = ANTHROPIC_RELAY.models.map((m) => ({ model: `${ANTHROPIC_RELAY.name}/${m}` }));
  // Deliberately appended LAST, so the partition has something to do.
  const ordered = orderNativePickerOptions([...built.picker, ...relay]);
  assert.deepEqual(ordered.slice(0, relay.length).map((r) => r.model), relay.map((r) => r.model));
  assert.equal(ordered.length, built.picker.length + relay.length, "nothing is dropped");
});

test("R13b re-check: the anchor cannot be moved by picker WIDTH alone", () => {
  // R13b is the task that can actually change picker ordering, so this is
  // re-asserted rather than inherited. A wider picker adds rows AFTER the
  // preference hit, so ANCHOR_PREFERENCE resolves to the same row and `via` is
  // unchanged -- both fields, because a matching id via a different rule is a
  // different decision.
  const narrow = [{ model: ANCHOR_PREFERENCE[0] }, { model: "prov/aaa1" }];
  const wide = [...narrow, ...Array.from({ length: 40 }, (_, i) => ({ model: `prov/x${i}` }))];
  const a = resolveAnchor(narrow, { anthropicOn: false });
  const b = resolveAnchor(wide, { anthropicOn: false });
  assert.deepEqual(a, b);
  assert.equal(b.via, `preference:${ANCHOR_PREFERENCE[0]}`);
  // And with the relay live the picker does not get a vote at all.
  assert.equal(resolveAnchor(wide, { anthropicOn: true }).model, ANTHROPIC_TIERS.model);
  // The fallback the width COULD move, pinned so a future reordering is visible:
  // with no preference hit and no verified row, the head of the picker wins.
  const noPref = [{ model: "prov/first" }, { model: "prov/second" }];
  assert.deepEqual(resolveAnchor(noPref, { anthropicOn: false }),
    { model: "prov/first", via: "picker-head" });
});

test("R13b re-check: a larger picker can only PRESERVE more pins, never fewer", () => {
  const f = provFixture();
  f.catalog.byProvider.set("prov", Array.from({ length: 14 }, (_, i) =>
    ({ provider: "prov", model: `m${String(i).padStart(2, "0")}`,
       id: `prov/m${i}`, ...text({}) })));
  const large = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  const smallRows = large.picker.slice(0, 3);
  assert.ok(large.picker.length > smallRows.length, "the fixture must actually widen");
  // MONOTONE: every pin the narrow picker kept is still kept by the wide one.
  for (const r of smallRows) {
    assert.equal(reconcileUserModelPin({ model: r.model }, smallRows).action, "kept");
    assert.equal(reconcileUserModelPin({ model: r.model }, large.picker).action, "kept",
      `${r.model} was pinnable at the smaller cap and must stay pinnable`);
  }
  // ...and a pin only the WIDER picker carries goes cleared -> kept, which is
  // the direction that proves the widening is what did it.
  const onlyWide = large.picker.find((r) => !smallRows.some((s) => s.model === r.model)).model;
  assert.equal(reconcileUserModelPin({ model: onlyWide }, smallRows).action, "cleared");
  assert.equal(reconcileUserModelPin({ model: onlyWide }, large.picker).action, "kept");
  // A pin naming no row at all is still cleared at either width.
  assert.equal(reconcileUserModelPin({ model: "prov/gone" }, large.picker).action, "cleared");
});

test("R13b: provenance cannot change WHICH ids route, only their order", () => {
  // The census (bareIdCensus / resolveBare) counts ownership, which is
  // set-valued and order-independent -- so re-ranking cannot move it. This pins
  // the SET equality that makes that argument true rather than asserted.
  const f = provFixture();
  const plain = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test");
  const ranked = buildProviders(f.chosen, f.vault, f.catalog, () => "sk-test",
    { prov: { models: [{ id: "aaa4" }] } }, { working: ["prov/aaa3"] });
  assert.deepEqual([...byName(ranked, "prov").models].sort(),
    [...byName(plain, "prov").models].sort(), "same SET of routing ids");
  assert.notDeepEqual(byName(ranked, "prov").models, byName(plain, "prov").models,
    "...in a different order, so the fixture is actually exercising the term");
  assert.deepEqual(bareIdCensus(ranked.providers).ambiguous,
    bareIdCensus(plain.providers).ambiguous, "census is unaffected by ordering");
});

// ------------------------------------------- R13c: discovery reaches ROUTING
//
// R14 wires R10's cache into the DISPLAY snapshot; without this task nothing
// wired it into the routing build, and uwpick would have offered rows that
// `Providers[].models` could not route. These assert the wiring itself, because
// the entry-point block that performs it is behind a guard no test may run --
// the same standard `assertOptionsComplete`'s call site is held to below.

const RUN_SRC = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8");

test("run.mjs passes a discovery cache to buildProviders, not nothing", () => {
  // The forward-warning above `checkBareCollisions` named this exact line as the
  // thing that did not exist yet ("run.mjs passes no `discovery` argument to
  // `buildProviders` today"). A regression here is silent: routing simply gets
  // smaller, every test still passes, and the picker starts offering ids that
  // route nowhere.
  const load = RUN_SRC.indexOf("loadDiscoveryCache(chosen.map((c) => c.provider))");
  const call = RUN_SRC.indexOf("const built = buildProviders(chosen, providers, catalog,");
  assert.ok(load > 0, "the cache is loaded at the entry point");
  assert.ok(call > load, "and loaded before the build that consumes it");
  assert.match(RUN_SRC.slice(call, call + 200), /readKey, discovery\)/,
    "and it is actually passed as the discovery argument");
  assert.equal(RUN_SRC.includes("buildProviders(chosen, providers, catalog, dry ?"), false,
    "the old no-discovery call must not survive alongside the new one");
});

test("run.mjs passes the vault's vouch set to the collision guard", () => {
  const derive = RUN_SRC.indexOf("const vouchedProviders = vouchedBareClaudeProviders(providers)");
  const call = RUN_SRC.indexOf("const collisions = checkBareCollisions(built.providers,");
  assert.ok(derive > 0 && call > derive, "derived from the vault, then passed");
  assert.match(RUN_SRC.slice(call, call + 300), /vouchedProviders/);
});

test("the bare-Claude disclosure line is unconditional at the call site", () => {
  // A DISCLOSURE INSIDE AN `if` IS NOT A DISCLOSURE. The run with nothing vouched
  // is exactly the run whose silence would later read as "there was nothing to
  // accept", so the line must print `0 vouched` rather than not print.
  const line = RUN_SRC.indexOf("console.log(`bare-Claude collisions:");
  assert.ok(line > 0, "the line exists");
  // Nothing between the guard call and this line may open a conditional block.
  const call = RUN_SRC.indexOf("const collisions = checkBareCollisions(built.providers,");
  const between = RUN_SRC.slice(call, line);
  assert.doesNotMatch(between, /\n\s*if\s*\(/,
    "no branch stands between computing the verdict and stating it");
  assert.match(RUN_SRC.slice(line, line + 300), /unvouched \(fatal if >0\)/);
  assert.match(RUN_SRC.slice(line, line + 300), /vouched \(reported, not blocking\)/);
});

test("discovery widens routing, and the fail-closed property survives the widening", () => {
  // THE CENSUS PROPERTY IS NOT A PROPERTY OF THE OLD WIDTH. Discovery roughly
  // triples the routing table on the real vault, which triples the number of
  // bare ids `resolveBare` has to get right -- so the ambiguity-fails-closed
  // pairing is re-asserted over a discovery-widened build rather than assumed to
  // carry over.
  const withoutDiscovery = build(fixture()).providers;
  // One shared id across two providers (must stay unbindable) and one unique to
  // each (must bind), all reachable ONLY through discovery.
  const providers = build(fixture({ discovery: {
    tabiai: { outcome: "ok", models: [{ id: "shared-disc-1" }, { id: "tabiai-disc-1" }] },
    gorouter: { outcome: "ok", models: [{ id: "shared-disc-1" }, { id: "gorouter-disc-1" }] },
  } })).providers;

  const before = withoutDiscovery.reduce((n, p) => n + p.models.length, 0);
  const after = providers.reduce((n, p) => n + p.models.length, 0);
  assert.ok(after > before, `discovery must ADD routing entries (${before} -> ${after})`);

  const census = bareIdCensus(providers);
  assert.deepEqual(census.owners.get("shared-disc-1"), ["gorouter", "tabiai"]);
  assert.equal(resolveBare(providers, "shared-disc-1"), undefined,
    "a discovered id claimed by two hosts still binds nothing");
  assert.equal(resolveBare(providers, "tabiai-disc-1")?.provider, "tabiai",
    "and a uniquely discovered one still routes");

  // The complementarity the pair is asserted on, re-checked at the new width.
  for (const id of census.ambiguous) {
    assert.equal(resolveBare(providers, id), undefined, `"${id}" must bind nothing`);
  }
  assert.equal(census.ambiguous.length + census.soleOwned.length, census.owners.size);
});

test("a discovered Claude-shaped id from a reseller is caught, and a vouch reclassifies it", () => {
  // THE WHOLE REASON R13c NEEDED A VOUCH AT ALL. Discovery is a provider's own
  // listing of what a key can call, and a reseller's listing is precisely where a
  // bare `claude-*` name appears -- so wiring discovery is what arms this guard.
  const providers = build(fixture({ discovery: {
    tabiai: { outcome: "ok", models: [{ id: "claude-opus-4-1" }] },
  } })).providers;
  assert.ok(providers.find((p) => p.name === "tabiai").models.includes("claude-opus-4-1"),
    "the discovered id really reached routing, or the rest of this proves nothing");

  const caught = checkBareCollisions(providers, { realIds: null });
  assert.equal(caught.hijackable.some((h) => h.id === "claude-opus-4-1" && h.owner === "tabiai"),
    true);
  assert.equal(caught.fatal, true);

  const accepted = checkBareCollisions(providers,
    { realIds: null, vouchedProviders: new Set(["tabiai"]) });
  assert.equal(accepted.hijackable.some((h) => h.id === "claude-opus-4-1"), false);
  assert.equal(accepted.vouchedHijacks.some((v) => v.id === "claude-opus-4-1"), true,
    "moved, not dropped -- the accepted risk stays on the record");
  assert.equal(accepted.shadowed.map((s) => s.id).includes("claude-opus-4-8"), true,
    "and the pre-existing shared claim is untouched by the vouch");
});

// keysync runner. Applies the generated config to a CCR instance.
//
//   node run.mjs --dry                 build + validate, write nothing
//   node run.mjs --target isolated     apply to the isolated harness instance
//   node run.mjs --target live         apply to the live CCR install
//
// --target live writes the REAL ~/.claude/settings.json and will change how any
// running Claude Code session routes. It refuses unless --i-know is also passed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { RESERVED } from "../menu/denylist.mjs";
import { fetchAnthropicCatalog } from "./anthropic-catalog.mjs";
import {
  loadVault, filterRegistry, chooseKeys, loadCatalog, buildProviders,
  validate, stripOneMSuffix, reconcileUserModelPin, KEY_CHOICES, ANCHOR_PREFERENCE,
  ANTHROPIC_RELAY, ANTHROPIC_TIERS, ANTHROPIC_FULL, ANTHROPIC_FALLBACK_TAGS,
  ANTHROPIC_ALIASES, buildAnthropicPickerRows
} from "./keysync.mjs";
import { cacheRoot, readCacheRecord } from "../refresh/discover.mjs";
import {
  snapshotConfigDb, deleteStaleWifToken, retainOnSuccess, capFailedSnapshots,
  restoreSettings, restoreConfigDbHint, assertSettingsInvariants, listSettingsBackups,
  liveConfigDir, liveConfigDb,
  acquireLock, restartRelevantFingerprint, waitForGateway, otherClaudeSessions,
  atomicWriteJson
} from "./safety.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const target = val("--target", "dry");
const dry = has("--dry") || target === "dry";

const EXPECTED_PROVIDERS = 44;
const BUILT_ROWS = "C:\\Users\\osami\\.uw\\keysync\\built-rows.json";

/**
 * S1: the bare-id collision guard. Report 08 F1 is stopped here and nowhere else.
 *
 * WHY HERE AND NOT IN buildProviders. The exploitable condition is SOLE
 * OWNERSHIP of a Claude-shaped id across the whole built config -- CCR's
 * `providerModelMatches` iterates raw Providers[].models[] behind only a
 * provider-level enabled gate, and `resolve()` binds on exactly one match,
 * returning undefined on more than one. `buildProviders` processes one provider
 * at a time and cannot evaluate ownership. That is why the old name-rejection
 * control sat in the wrong function AND enforced the wrong rule.
 *
 * WHAT IT DOES NOT DO: prune. No model is removed, no provider is dropped. It
 * reports, and on the one dangerous shape it stops the run.
 *
 * @param {object[]} providers  the built `Providers[]`, each `{name, models: [{id}]}`
 * @param {object}  [opts]
 * @param {string}  [opts.relay="anthropic"]   the provider name of our own relay
 * @param {boolean} [opts.allowBare=false]     --allow-bare-claude-names
 * @param {Set<string>|null} [opts.realIds=null]  ids Anthropic actually publishes
 *   (from anthropic-catalog.mjs's live /v1/models, unioned with ANTHROPIC_FULL by
 *   the caller). null means "could not be determined" (relay down AND no cache)
 *   and the guard falls back to the BROAD set -- every RESERVED-shaped id the
 *   config advertises, plus the aliases -- see the null-branch note below for
 *   the measurement that reverted D1's narrowing.
 * @param {Set<string>|null} [opts.relayOwned=null]  the CURATED ids the relay
 *   vouches for. See the vouching block in the classification loop -- this is
 *   the parameter that keeps routing auto-add from disarming the guard. null
 *   means "no distinction", i.e. the pre-auto-add behaviour, which is what every
 *   caller that predates auto-add still wants.
 * @param {Set<string>|null} [opts.relayRouting=null]  what the relay serves or
 *   WOULD serve if started; used only to keep the remedy wording honest.
 *   Defaults to the static ANTHROPIC_RELAY.routing.
 * @param {Map<string, Set<string>>|null} [opts.vouchedProviders=new Map()]  the
 *   SPECIFIC ids, per provider name, whose sole ownership by that provider the
 *   operator has reviewed and accepted, from the `vouchedBareClaude` field in
 *   providers.json. A DIFFERENT QUESTION FROM `relayOwned`, and the two must not
 *   be merged: `relayOwned` is "does OUR relay curate this id"; this is "do we
 *   accept THIS RESELLER sole-owning THIS Claude-shaped name". Empty by default,
 *   and that default reproduces the pre-vouch `fatal` computation exactly -- the
 *   mechanism ADDS a way to reclassify a finding, it never widens what is
 *   classified.
 *
 *   PER-ID, NOT PER-PROVIDER, AND THAT IS THE WHOLE POINT. A provider-level
 *   boolean would grant its holder blanket authority over every bare
 *   Claude-shaped id it EVER sole-owns -- authority the reseller then extends
 *   unilaterally by editing its own listing. Vouching two retired 2024 names
 *   would silently pre-accept the day that host starts advertising bare `opus`,
 *   the highest-traffic alias Claude Code emits. An id absent from the list
 *   stays `hijackable` and stays fatal, which is the correct verdict for
 *   anything nobody reviewed.
 * @returns {{hijackable: object[], shadowed: object[], vouchedHijacks: object[],
 *            fatal: boolean, message: string, catalogVerified: boolean}}
 *   `catalogVerified` is false on exactly the `realIds === null` path and is
 *   DISCLOSURE, never a verdict: `fatal` does not read it, and `message` carries
 *   the same fact in prose so a caller that prints only the message still tells
 *   the operator. See the disclosure block above the return.
 *
 *   `vouchedHijacks` is ALWAYS PRESENT, empty array included. It carries the
 *   findings that WOULD have been fatal but for the operator's vouch, each with
 *   its id, owner and the reason it was spared -- never a bare count, because a
 *   count cannot be reviewed. It is what makes vouching an accepted risk on the
 *   record rather than a silent exemption.
 */
export function checkBareCollisions(providers, {
  relay = ANTHROPIC_RELAY.name, allowBare = false, realIds = null,
  relayOwned = null, relayRouting = null, vouchedProviders = new Map(),
} = {}) {
  // WHAT EACH PROVIDER ADVERTISES, TRIMMED. Ownership is NOT keyed on these --
  // see the selector set below. This is only the raw material both match stages
  // read, and it is trimmed because `providerModelMatches` does `let a = s.trim()`
  // before it compares: the trimmed form is the one CCR actually matches on, so
  // it is the only form a faithful guard may hold.
  //
  // THE TRIM HAS A SECOND EFFECT, AND IT IS A GATING ONE. RESERVED is anchored
  // (`/^(claude|opus|...)([-._\d\/]|$)/i`), and the trim runs BEFORE it, so it
  // changes WHICH IDS ARE ADMITTED to the guard at all -- not merely how an
  // admitted id matches. `" opus"` was invisible here and is now classified, and
  // `"claude-opus-5 "` now folds onto the same selector as `"claude-opus-5"`
  // (two matching ENTRIES against one selector -- see the entry-counting note at
  // `matchingEntries`). Both are the FAITHFUL readings, since CCR compares the
  // trimmed forms, and stating only the matching fidelity while leaving the
  // gating effect unsaid is this file's named failure mode.
  //
  // THE EFFECT IS NOT UNIFORM ACROSS THE TWO BRANCHES, and R6 briefly said it
  // was. On the non-null branch the selectors are constants, so this trim only
  // decides ADMISSION. On the null branch these same trimmed ids ARE the
  // selectors, so the trim decides admission and the selector set together --
  // `" opus"` is admitted here and then folds onto the alias `opus` that the
  // union below contributes anyway.
  //
  // NOT LIVE, AND PERMANENTLY SO RATHER THAN PENDING. `admitId(" opus")`
  // returns null, so no such id reaches the built config.
  //
  // CORRECTED 2026-09-07. This said the rejection came from "the allowlist
  // anchor[ing] on an alphanumeric" and that it "goes live the moment R2
  // inverts that allowlist to a denylist". R2 landed: there is no allowlist any
  // more. The rejection now comes from the `WHITESPACE` rule in
  // `menu/sanitize.mjs`, which denies whitespace BY NAME precisely so the
  // inversion did not open this hole -- that module's own comment states the
  // correct reading and cites `#53/A1`, and this line was simply never brought
  // into agreement with it. The trim below therefore stays a guard against a
  // future relaxation of that rule, not a wire waiting to be energised.
  const advertised = [];
  for (const p of providers ?? []) {
    // CCR's own gate. `providerModelMatches` checks the provider is enabled before
    // it looks at any id, so a disabled co-owner does not count towards ownership
    // there -- and counting it here would read two owners as ambiguous while CCR
    // sees exactly one match and binds. Always true in today's generated config,
    // so this is a latent divergence rather than a live one.
    if (p.enabled === false) continue;
    // AN ARRAY, NOT A SET, AND THAT IS LOAD-BEARING. `providerModelMatches`
    // pushes once per matching entry of `i.models`, so a provider listing the
    // same id twice -- byte-identically, or as `Opus` and `OPUS` -- produces two
    // matches and `resolve()` returns undefined. De-duplicating here would hide
    // the second entry and report a sole owner CCR never binds.
    const ids = [];
    for (const m of p.models ?? []) {
      // Accepts both shapes deliberately: the built config carries `models` as a
      // string[], while the guard's own tests inject `{id}` objects.
      const id = String(m?.id ?? m ?? "").trim();
      // An id that already carries a `/` is vendor-prefixed and is not what
      // Claude Code sends for a built-in row, so it cannot be the stage-4 match.
      // tokenharbor lists exactly this shape; treating it as hijackable would
      // block a live reseller for a threat that cannot reach it.
      if (id.includes("/")) continue;
      // RESERVED is imported, not re-typed. The previous inline regex was
      // /^(claude|opus|sonnet|haiku)([-\d]|$)/ -- it omitted `fable` entirely and
      // its boundary class was narrower than the denylist's, so `sonnet.1` and
      // `haiku_2` were reserved by one definition and invisible to the other.
      //
      // THIS LINE IS DEAD ON ONE BRANCH AND LIVE ON THE OTHER, AND R6 DOCUMENTED
      // IT AS DEAD ON BOTH. That was true only while D1 held.
      //
      //   realIds !== null  -- DEAD. Ownership iterates
      //     `ANTHROPIC_ALIASES u realIds`, so every candidate is already in the
      //     classification set, and every id in
      //     `ANTHROPIC_ALIASES u ANTHROPIC_FULL` matches RESERVED. Nothing this
      //     rejects could have reached a verdict. Kept as the one place the
      //     guard's definition of Claude-shaped is compared against the
      //     denylist's (removing it leaves `isReserved` with a single consumer),
      //     and as a cheap pre-filter. The drift it still catches is an id added
      //     to ANTHROPIC_FULL that RESERVED does NOT match: this line would drop
      //     it before classification and the guard would go silent on a real id.
      //     The drift detector in denylist.test.mjs asserts that premise rather
      //     than trusting it, which is what makes a no-op safe to keep.
      //
      //   realIds === null  -- LIVE, and decisive. The selector set below is
      //     built FROM `ids`, so this test IS the definition of Claude-shaped on
      //     that branch: an id it rejects is not merely unclassified, it is never
      //     a selector at all. Widening or narrowing RESERVED changes the null
      //     path's verdicts directly.
      if (!RESERVED.test(id)) continue;
      ids.push(id);
    }
    if (ids.length) advertised.push({ name: p.name, ids });
  }

  // THE SELECTOR SET -- the strings Claude Code can actually SEND. Ownership is
  // keyed on these, never on the advertised spelling, and that inversion IS the
  // #53 fix.
  //
  // NARROWING (BACKLOG item 2). RESERVED asks "is this Claude-SHAPED"; the
  // guard's actual concern is "could Claude Code send this bare and bind it
  // to the wrong host", which only a REAL Anthropic id can ever trigger --
  // Claude Code never emits a name Anthropic has not published. Without
  // this, `claude-opus-5-thinking` (a reseller invention; extended thinking
  // is a request parameter, not a model) reads as hijackable at tabiai and
  // gorouter for a threat that cannot reach it.
  //
  // realIds === null means "could not be determined": the relay was unreachable
  // AND there was no cache. That is the one path the call site below reports as
  // `UNAVAILABLE (relay down and no cache)`. On it the guard falls back to the
  // BROAD set -- the aliases unioned with every RESERVED-shaped id the config
  // advertises -- because the narrowing premise is unavailable exactly there.
  //
  // D1 NARROWED THIS TO ANTHROPIC_FULL AND IS REVERTED, ON MEASUREMENT. The
  // narrowing's justification was that widening on a network failure produced
  // "23 reseller inventions, all false positives". THOSE 23 ARE STILL ABSENT
  // FROM THIS GUARD'S INPUT -- but the reason this comment used to give for
  // that is now false, and the correction matters more than the conclusion.
  //
  // RE-MEASURED 2026-09-07, POST-R11, through `buildProviders` on the real
  // vault with no discovery cache. `built.providers` is 1,584 model entries
  // across 44 providers, NOT 83: R11 uncapped `models[]`, so each provider now
  // carries very nearly its whole bundled catalogue rather than the picker's
  // top three. Of those 1,584, exactly 2 are RESERVED-shaped bare ids, and they
  // are the same two as before: `tabiai -> claude-opus-4-8` and
  // `gorouter -> claude-opus-4-8`. Still not 23, and still co-owned rather than
  // sole-owned.
  //
  // SO THE OLD SENTENCE -- "the 23 were counted over the full bundled
  // catalogue, which the guard never sees" -- IS DEAD, and must not be restored.
  // The guard now sees close to that catalogue. What survived the widening is
  // the measurement, not the mechanism: those 23 inventions live at catalogue
  // providers this vault holds no key for, so widening the ROWS did not widen
  // the bare-id set. That is a property of THESE 44 providers on THIS bundle,
  // contingent on both, and no longer a structural guarantee about the input.
  //
  // THAT WARNING WAS DISCHARGED BY R13c, AND ITS PREDICTION HELD. It read "the
  // next task to wire R10's discovery cache into this path must re-measure
  // before it ships", because run.mjs passed no `discovery` argument and 1,584
  // was therefore the only set this verdict had been checked against. run.mjs
  // now passes one (`loadDiscoveryCache`), so the numbers above are no longer
  // this pipeline's, and the re-measurement is recorded here rather than left to
  // be re-derived.
  //
  // RE-MEASURED 2026-09-08 ON THE REAL VAULT, both branches, through the same
  // `buildProviders` the pipeline calls. Routing entries 1,584 -> 5,026 across
  // the same 44 providers; distinct bare ids 1,451 -> 3,159; ambiguous 106 ->
  // 857; sole-owned 1,345 -> 2,302.
  //
  //   realIds NON-NULL (the live path, Anthropic reachable): hijackable 0 -> 0,
  //     shadowed 1 -> 9, fatal FALSE either way. The narrow selector set is what
  //     holds it: ownership iterates `ANTHROPIC_ALIASES u realIds`, and the ids
  //     the resellers invent are not in it.
  //   realIds NULL (relay down AND no cache): hijackable 0 -> 22, shadowed
  //     1 -> 15, and fatal flips FALSE -> TRUE. The 22 are sole-owned by five
  //     providers, not two: aihubmix 13, bai 5, veniceai 2, tokenrouter 1,
  //     opencode 1.
  //
  // So the widening did NOT make the guard fire on the path this pipeline
  // normally takes; it armed the fallback path, which is the path a network
  // failure selects. That is the pipeline-exits-1-when-Anthropic-is-unreachable
  // shape this comment warned against, and it is REAL TODAY -- not fixed by
  // R13c, which ships the per-id vouch that lets an operator accept a named
  // reseller's claim on a NAMED id instead of reaching for
  // `--allow-bare-claude-names`, which accepts all of them and is still not an
  // escape hatch to discover in production. The remedy for these 22 is
  // therefore "review the 22 ids and list the ones you accept", never "trust
  // these five hosts" -- the distinction matters most under exactly the outage
  // pressure that produced the finding, which is when nobody wants to read a
  // list. For scale, the old comparison stands: the same count over the
  // bundled catalogue's 217 providers is 240 bare ids / 185 sole-owned.
  //
  // WHAT THE NARROWING COST, MEASURED AGAINST AN INDEPENDENT THREAT SET.
  // `ANTHROPIC_ALIASES u Anthropic's live /v1/models` is 15 ids. With the relay
  // down, a reseller sole-owning one of them was caught for 15 of 15 before D1
  // and for 8 of 15 after it: `claude-fable-5`, `claude-opus-4-8`,
  // `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-opus-4-6`,
  // `claude-opus-4-5-20251101` and `claude-sonnet-4-5-20250929` went SILENT.
  // Every one is published by Anthropic and so is a name Claude Code can send;
  // ANTHROPIC_FULL carries 4 of the 11 live ids, which is the whole of the gap.
  // Reachable on shipped data: if either owner drops `claude-opus-4-8`, the
  // broad rule returns `fatal: true, owner: tabiai` and the narrow one returns
  // `fatal: false, "no bare Claude-shaped collisions"`.
  //
  // THE COST OF THE BREADTH IS REAL, ACCEPTED KNOWINGLY, AND NAMED HERE SO THE
  // NEXT PERSON TO CONSIDER RE-NARROWING HAS THE NUMBER THAT MATTERS. On the
  // null path a reseller invention -- `claude-opus-5-thinking`, `claude-opus-4.6`
  // and their kind, where extended thinking is a request PARAMETER rather than a
  // model -- is fatal when sole-owned, and nothing sends those bare. Those are
  // false positives and this branch will produce them.
  //
  // THE TWO DENOMINATORS ARE WHAT DECIDE IT, and they are not the same
  // denominator D1 used. Over the full bundled catalogue (217 providers) there
  // are 23 such inventions; over `built.providers`, which is the ONLY thing this
  // guard ever reads, there are 2 RESERVED-shaped bare ids in 1,584 model
  // entries across 44 providers (re-measured post-R11; it was 2 in 83 while the
  // picker cap still sized routing), and both are `claude-opus-4-8`. Note that
  // the two denominators are now much closer than they were, which is why the
  // re-measurement note above insists the next widening of this input be
  // measured rather than assumed. So the breadth's realised cost on shipped data is at
  // most those 2 rows, on a path the operator can see and override with
  // `--allow-bare-claude-names`; the narrowing's cost is 7 of 15 published
  // Anthropic ids silently misrouting the full system prompt. Those are not
  // symmetric, and a re-narrowing argued from the 23 would be argued from a set
  // this function is never handed.
  //
  // THE TWO BRANCHES NOW DIFFER IN WHERE THEIR SELECTORS COME FROM, and the
  // advertised-side trim is what the null branch reads (see the gating note
  // there). `" opus"` is admitted, trimmed, and folds onto the alias `opus`.
  //
  // THE ALIASES ARE EXEMPT, and leaving them out was a live hijack hole from
  // eeea057 until 2026-09-06. The premise above -- "Claude Code never emits a
  // name Anthropic has not published" -- is false for exactly the four names
  // Claude Code emits MOST: `opus`, `sonnet`, `haiku`, `fable`. Anthropic's
  // /v1/models lists dated ids and never bare aliases, and ANTHROPIC_RELAY
  // .models is ANTHROPIC_FULL (dated), so realIds contains none of the four.
  // Every one was `continue`d before classification whenever the catalogue
  // resolved at all -- including from a stale cache, which is the normal path.
  //
  // MEASURED with production-shaped arguments: a reseller sole-owning bare
  // `opus` with the relay down returned {fatal: false, hijackable: 0,
  // "no bare Claude-shaped collisions"}. That is report 08 F1 in its purest
  // form, reported as safe. Invisible to all 412 tests because none of them
  // passed `realIds` -- they exercised the null path that run.mjs never uses.
  //
  // #53: THE NARROWING USED TO FILTER THE ADVERTISED STRING, and did it with
  // strict equality -- `ANTHROPIC_ALIASES.includes(id)` and `realIds.has(id)`.
  // Anthropic publishes lowercase, so a reseller advertising `Opus` was dropped
  // before classification while CCR bound to it. The set below is instead the
  // set of selectors, which is where case-insensitivity belongs: `Opus` is not
  // a selector, it is one provider's spelling OF the selector `opus`.
  //
  // The `.trim()` here is the SELECTOR side of the pair, and unlike the
  // advertised side it is DEFENSIVE, NOT MUTATION-CHECKED -- stated rather than
  // implied, because a comment that lets an unverified line read as a verified
  // one is the failure this file has a standing rule against. The selector
  // normalizer trims too (`Qe` in @musistudio/claude-code-router@3.0.22,
  // dist/main/cli.js, `let t=e?.trim()` -- cited by minified name AND version
  // because that name is an allocation-order artifact one `npm i` can rename),
  // so this is faithful. But no PRODUCTION-SHAPED fixture can kill it: neither
  // ANTHROPIC_ALIASES, nor a `realIds` built at the call site below (live
  // /v1/models u ANTHROPIC_FULL), nor the null branch's `a.ids` (already trimmed
  // above) can carry whitespace. A hand-built
  // `realIds: new Set([" claude-opus-5 "])` does kill it. It guards only the
  // case where Anthropic's own API returns a padded id.
  const selectors = new Set(
    [...ANTHROPIC_ALIASES, ...(realIds ?? advertised.flatMap((a) => a.ids))]
      .map((s) => String(s).trim())
  );

  // OWNERSHIP THE WAY `resolve()` COMPUTES IT: the exact match list, and the
  // case-folded list IF AND ONLY IF exact is empty. Both stages, in that order.
  //
  // WHAT IS COUNTED IS MATCHING ENTRIES, NOT PROVIDERS. `providerModelMatches`
  // (`Qe`'s callee in @musistudio/claude-code-router@3.0.22, dist/main/cli.js;
  // readable source VENDORED, not a repo-root path:
  // spike/research/ccr-scratch/claude-code-router-main/packages/core/src/routing/
  // model-registry.ts:103-118, same 3.0.22 -- source-vs-built, not version skew)
  // pushes
  // inside its `for (let s of i.models)` loop, and `resolve()` returns undefined
  // when that list has length > 1. So ONE provider advertising `Opus` and `OPUS`
  // is two matches and binds NOTHING, and a name-keyed accumulator that collapsed
  // them into one owner would report a FATAL sole claim against a config CCR
  // refuses to route. Hence a list of names, one per matching entry, deduplicated
  // only when a message is rendered.
  //
  // ORDERING. `exact` is always a SUBSET of the fold -- `id === sel` implies
  // `id.toLowerCase() === sel.toLowerCase()` -- so the two stages can never name
  // disjoint owners, and fold-empty implies exact-empty. What the ordering buys
  // is therefore a COUNT, and through it a verdict: with `tabiai:Opus` and
  // `gorouter:opus` the exact stage finds one entry and CCR binds gorouter
  // (FATAL), while the fold finds two and would report a safe ambiguity. Because
  // the fold contains the exact set, `fold.length ? fold : exact` reduces to
  // plain `fold`: running the fold first and dropping the exact stage entirely
  // are THE SAME PROGRAM, not two mutations.
  const matchingEntries = (match) =>
    advertised.flatMap((a) => a.ids.filter(match).map(() => a.name));
  const byBare = new Map();
  for (const sel of selectors) {
    const folded = sel.toLowerCase();
    const exact = matchingEntries((id) => id === sel);
    byBare.set(sel, exact.length ? exact : matchingEntries((id) => id.toLowerCase() === folded));
  }

  // VOUCHING vs MERELY ROUTING -- A REPORTING DISTINCTION, NOT A CLASSIFYING ONE.
  // A2 (plan §1.1) moved the verdict off the stripped list and onto `owners`.
  // What vouching still decides is the WORDING: whether the relay's co-ownership
  // is something a human reviewed, or something routing auto-add produced on its
  // own. It no longer decides who is hijackable.
  //
  // WHY THE STRIPPING LEFT THE VERDICT. It classified from `owners` minus the
  // relay wherever the id was unvouched, so `{relay, tabiai}` read as a sole
  // claim by tabiai and went FATAL. But `providerModelMatches` counts BOTH
  // entries, `resolve()` sees `s.length > 1` and returns undefined -- it binds
  // NOTHING, so there is no hijack to report. Every fatal the stripping added on
  // that row was a false positive, and it could never remove a true one: where
  // `|owners| === 1` and the relay is not among them, stripping removes nothing
  // and the id stays hijackable. So the unstripped set is exactly CCR's bind
  // condition -- under the two-stage, trimmed, ENTRY-counting ownership above,
  // and ONLY under it. Name-keyed or single-stage ownership breaks the identity,
  // which is what #53 and B1 were.
  //
  // WHAT THIS GIVES UP, STATED RATHER THAN IMPLIED. The HIGH regression
  // `relayOwned` was added to fix -- routing auto-add making the relay a co-owner
  // of every id, so `owners.size === 1 && !owners.has(relay)` could never be true
  // -- is no longer prevented by stripping it back out. It does not need to be:
  // the row auto-add silenced is a row CCR refuses to route. What replaces the
  // stripping is the MESSAGE -- an unvouched co-ownership is named as such on the
  // `shadowed` finding below instead of being classified into a fatal. The
  // per-id escape hatch went with it; only the global --allow-bare-claude-names
  // remains, and that is acceptable precisely because what fires is now CCR's own
  // bind condition rather than a proxy for it.
  //
  // THE FIDELITY HAS A DEPENDENCY, and it is not decorative: it holds only while
  // nothing but keysync mutates `Providers[].models`. `autoFetchModels: true`
  // would let CCR discover models past `admitRemoteModels` and invisibly to this
  // guard, so validate()'s V9 rule is load-bearing under A2 (#44).
  const vouched = (id) => relayOwned === null || relayOwned.has(id);
  // TWO VOUCHES, TWO QUESTIONS, DELIBERATELY NOT UNIFIED. `vouched(id)` above is
  // relay-only ("does our relay curate this id"); `isVouchedOwner` is
  // reseller-facing ("do we accept THIS host sole-owning THIS Claude-shaped
  // name"). They read different inputs, answer to different operators, and
  // collapsing them would let a relay-curation fact silence a reseller finding,
  // or the reverse.
  //
  // BOTH ARGUMENTS ARE LOAD-BEARING, and dropping either widens the grant. On
  // `(owner)` alone a vouch spreads to every id that owner ever sole-owns; on
  // `(id)` alone it spreads to every host that later claims the id. The pair is
  // the only form that means what the operator reviewed.
  //
  // NULL-TOLERANT LIKE ITS SIBLINGS. `realIds` and `relayOwned` both accept
  // null for "not supplied"; a caller passing `vouchedProviders: null` gets the
  // same no-vouch behaviour rather than a throw, and a provider present in the
  // map with an empty set vouches for nothing.
  const isVouchedOwner = (owner, id) => vouchedProviders?.get(owner)?.has(id) === true;
  const hijackable = [], shadowed = [], vouchedHijacks = [];
  for (const [id, owners] of byBare) {
    const relayRoutes = owners.includes(relay);
    // NOTHING TO PROTECT AGAINST. Under #53's selector-keyed ownership this is
    // THE COMMON CASE rather than a redundant one: every selector in the
    // classification set that no enabled provider advertises -- most of
    // `ANTHROPIC_ALIASES u realIds` in a typical config -- reaches this line with
    // no matching entries. The second way in is GONE: it used to be "the relay
    // was the sole owner and stripping emptied the list", and with no stripping
    // that row now falls through both branches below instead (length 1, and the
    // one owner IS the relay). The pair still both fail on length 0, so this
    // `continue` stays behaviourally redundant AS THEY ARE WRITTEN; it is kept
    // because it states the rule, and because an edit that turns the pair into an
    // if/else chain would otherwise silently start classifying an empty list.
    if (owners.length === 0) continue;
    if (owners.length === 1 && owners[0] !== relay) {
      // `relayRoutes` IS PROVABLY FALSE ON THIS BRANCH. Reaching it requires the
      // relay to be absent from `owners`, and that absence is the whole of
      // `relayRoutes`. The field is kept -- rather than written as a literal
      // `false` -- so `relayHelps` below reads a computed fact, and it is passed
      // through because a caller printing per-finding provenance (§6.6) should
      // read the same fact the guard read.
      //
      // THIS IS WHY THE ROUTES-BUT-DOES-NOT-CURATE NOTE MOVED. Under the stripped
      // verdict a hijackable finding could carry the relay as a co-owner, so the
      // note rendered here; under A2 that shape is `shadowed`, and this branch can
      // never carry it. `denylist.test.mjs` pins the emptiness with a COVERAGE
      // assertion over the reachable owner domain, not a behavioural one -- a
      // branch that cannot be entered cannot be observed failing.
      //
      // THE VOUCH REROUTES THE FINDING, IT DOES NOT SUPPRESS IT. A vouched sole
      // owner is still exactly as bindable by CCR as an unvouched one -- nothing
      // about the routing changes. What changes is whether the run STOPS, and
      // that is the operator's call to have already made in providers.json. The
      // finding keeps its id, its owner and gains the reason it was spared, so a
      // reader of the output can audit the decision rather than infer it.
      if (isVouchedOwner(owners[0], id)) {
        vouchedHijacks.push({
          id, owner: owners[0], relayRoutes,
          // NAMES THE ID, NOT JUST THE FIELD. The list in providers.json is
          // per-id, so a reader can check this exact string against that file
          // and see the entry the operator actually reviewed.
          reason: `vouchedBareClaude for ${owners[0]} lists ${id} in providers.json`,
        });
      } else {
        hijackable.push({ id, owner: owners[0], relayRoutes });
      }
    } else if (owners.length > 1) {
      // The TRUE owner list is reported, relay included -- a message that hid a
      // real co-owner would describe a config the operator does not have.
      //
      // DEDUPLICATED ONLY HERE, at render. Ownership above counts entries, so a
      // single provider advertising `Opus` and `OPUS` arrives as two entries and
      // must be reported once -- the operator has one provider to look at, not
      // two. The COUNT is what decided the verdict; the NAMES are what is shown.
      //
      // BOTH FACTS ARE CARRIED, NOT THEIR CONJUNCTION: whether the relay routes
      // the id, and whether it curates it. They answer different operator
      // questions, and §6.6 requires both per finding.
      shadowed.push({
        id, owners: [...new Set(owners)].sort(), relayRoutes, vouched: vouched(id),
      });
    }
  }
  hijackable.sort((a, b) => a.id.localeCompare(b.id));
  shadowed.sort((a, b) => a.id.localeCompare(b.id));
  vouchedHijacks.sort((a, b) => a.id.localeCompare(b.id));

  // Whether the classification above could consult Anthropic's published ids at
  // all. Derived from the one input that decides it, and read ONLY by the
  // reporting below -- see the disclosure block after the message branches.
  const catalogVerified = realIds !== null;

  // THE REMEDY WORDING IS LOAD-BEARING, and a test asserts it. An error that
  // tells the operator to remove a provider's model is an error that teaches a
  // rule-2 violation, and it would send them to delete the very models tabiai
  // and gorouter are being paid for. The two honest remedies are: give the id a
  // second owner by starting the relay, or accept the routing deliberately.
  let message;
  if (hijackable.length) {
    // OFFER THE RELAY ONLY WHERE IT CAN ACTUALLY HELP. Co-ownership works only for
    // ids the relay itself serves, and the id most likely to fire this guard is
    // `claude-opus-4-8` -- a retired name two resellers still list and the relay
    // has never served. Telling the operator to start the relay for that id sends
    // them to do something that cannot work, and the only real remedy is the flag.
    // THE EFFECTIVE routing set, not the stale static constant: with auto-add,
    // what the relay serves is decided at run time, and a remedy computed from
    // a hardcoded list can tell the operator to start a relay that would not
    // help, or fail to offer one that would.
    const wouldServe = relayRouting ?? new Set(ANTHROPIC_RELAY.routing);
    // Starting the relay only helps for an id it both serves AND vouches for.
    // For an id it merely routes, its ownership is deliberately not counted (see
    // the vouching block above), so "start the relay" would be advice that
    // changes nothing -- the precise class of unachievable remedy the
    // claude-opus-4-8 case already taught us not to print.
    const relayHelps = hijackable.filter((h) => !h.relayRoutes && wouldServe.has(h.id) && vouched(h.id));
    // A2 DELETED THE THIRD BRANCH. It read `routedNotVouched = hijackable.filter(
    // (h) => h.relayRoutes && !vouched(h.id))` and printed "the relay already
    // routes these ids but they are not in the reviewed set". Its guard required
    // `h.relayRoutes`, which the hijackable branch above makes structurally
    // false, so the filter is always empty and the branch is unreachable. It is
    // DELETED rather than left: dead code that looks like a control reads as one,
    // and the next reader would have to re-derive its emptiness to find out
    // otherwise. Re-introducing it would not fail a behavioural test -- nothing
    // can reach it -- so the coverage assertion in denylist.test.mjs is what
    // stands in for one.
    const remedy = relayHelps.length === hijackable.length
      ? `start the Anthropic relay so it co-owns these ids and they become ambiguous, or `
      : relayHelps.length
        ? `start the Anthropic relay, which co-owns ${relayHelps.map((h) => h.id).join(", ")} ` +
          `but not the rest, and/or `
        : `the relay does not serve ${hijackable.length === 1 ? "this id" : "these ids"}, ` +
          `so co-ownership cannot resolve ${hijackable.length === 1 ? "it" : "them"}; `;
    message =
      `SECURITY: ${hijackable.length} bare Claude-shaped model id(s) have a single ` +
      `owner this config does not vouch for:\n` +
      // NO PER-FINDING RELAY SUFFIX HERE. It used to read `(the relay routes this
      // id but does not curate it)`; a sole owner that is not the relay means the
      // relay does not route the id at all, so the suffix could only ever render
      // as the empty string. It now renders on the `shadowed` branch below, which
      // is the branch that CAN carry a relay co-owner.
      hijackable.map((h) => `  ${h.id}  <-  sole owner: ${h.owner}`).join("\n") +
      `\nCCR's resolve() binds Claude Code's built-in rows to a uniquely-owned bare ` +
      `id, so the full system prompt, tool definitions and file contents would go ` +
      `to that host.\n` +
      `Remedy: ${remedy}re-run with --allow-bare-claude-names to accept this routing ` +
      `deliberately.`;
  } else if (shadowed.length) {
    message =
      // "MATCH", not "owner": under entry-counting ownership a single provider
      // listing `Opus` and `OPUS` lands here with one name in the list, and
      // "more than one owner" in front of one name is the confident-wrong
      // message this file has a standing rule against.
      //
      // THE ROUTES-BUT-DOES-NOT-CURATE NOTE LIVES HERE NOW (A2/H5). It is the
      // one place the relay can be a co-owner, so it is the one place the
      // distinction is true. BOTH conjuncts are required: the relay being an
      // owner is "routes", and only the absence of vouching makes it "does not
      // curate" -- printing it on a curated co-ownership would tell the operator
      // a reviewed id was unreviewed. It is what remains of the protection the
      // stripping used to provide: this ambiguity is one our own auto-add
      // produced, not one a human signed off.
      `note: bare Claude-shaped id(s) with more than one match -- ` +
      `${shadowed.map((s) => `${s.id} (${s.owners.join(", ")}` +
        (s.relayRoutes && !s.vouched
          ? `; the relay routes this id but does not curate it`
          : "") + `)`).join("; ")}. ` +
      `resolve() returns undefined on an ambiguous match, so this is a clean ` +
      `failure, not a misroute.`;
  } else {
    // TWO DIFFERENT CLAIMS, AND ONLY ONE OF THEM WAS BEING MADE. "Checked,
    // nothing found" is a statement about Anthropic's published ids; on the null
    // path the guard never saw them, so the honest all-clear is scoped to what
    // it did read -- the ids this config advertises.
    //
    // "NO COLLISIONS" WOULD BE FALSE WITH A VOUCH IN HAND, and this is the one
    // branch a vouch can reach on its own: reclassify the only finding and both
    // lists empty out. Saying "none" there is the confident-wrong message this
    // file has a standing rule against -- there WERE collisions, and a human
    // decided to accept them. The qualifier is the whole difference, so the
    // unvouched wording below is preserved byte for byte.
    const scope = catalogVerified ? "" : " among the ids this config advertises";
    message = `no ${vouchedHijacks.length ? "unvouched " : ""}bare Claude-shaped collisions${scope}`;
  }
  // APPENDED TO EVERY BRANCH, not only the empty one. A run can carry a vouched
  // finding alongside a fatal one or a shadowed one, and the operator reviewing
  // either needs the accepted risk in front of them at the same time. Named in
  // full -- id, owner, reason -- because a count is not something anyone can
  // check against providers.json.
  if (vouchedHijacks.length) {
    message += `\nvouched (reported, not blocking): ` +
      vouchedHijacks.map((v) => `${v.id}  <-  sole owner: ${v.owner} (${v.reason})`).join("\n") +
      `\nThese ids are still uniquely owned and CCR would still bind them there; ` +
      `the vouch records that this was accepted, it does not change the routing.`;
  }
  // DISCLOSURE ON THE UNVERIFIED PATH. Plan §2.6 establishes the principle for a
  // keysync run that REFUSED to write: a run whose outcome rests on something it
  // could not do must say so rather than let silence read as success. The same
  // principle applies to a silent PROCEED, and this is the path that had it
  // backwards -- with both lists empty the caller's `console.warn` never fired
  // at all, so an unverified all-clear reached the operator as nothing at all.
  //
  // IT CHANGES NO VERDICT. `fatal` below does not read `catalogVerified`, no new
  // severity is introduced and no exit path is added; `shouldReportCollisions`
  // only decides whether the message is PRINTED. Appended to every branch, not
  // only the empty one: a `shadowed` finding classified by shape alone is as
  // much a claim about Anthropic's catalogue as an all-clear is, and today's
  // real config reaches exactly that branch (`claude-opus-4-8`, two owners).
  if (!catalogVerified) {
    message += `\nUNVERIFIED: Anthropic's live model ids could not be fetched ` +
      `(relay down and no cache), so this run classified by SHAPE against what ` +
      `the config advertises rather than against Anthropic's published catalogue.`;
  }

  // `fatal` IS COMPUTED FROM THE UNSTRIPPED OWNER SET (A2). The expression here
  // did not change; what changed is that `hijackable` above is now derived from
  // `owners` rather than from `owners` minus the relay. Stated at the return
  // because this is the line a reader checks when asking what makes keysync exit,
  // and the answer -- "exactly when CCR's resolve() would bind a bare Claude
  // selector to a single non-relay host" -- is decided fifty lines up.
  //
  // `vouchedHijacks` IS NOT IN THE EXPRESSION, and that is the point. `fatal`
  // reads `hijackable` alone, exactly as it did before the vouch existed -- with
  // an empty `vouchedProviders` nothing is ever moved out of `hijackable`, so
  // the computation is the same program on the same input. The vouch changes
  // which list a finding lands in, never how the list is scored.
  return {
    hijackable, shadowed, vouchedHijacks,
    fatal: hijackable.length > 0 && !allowBare, message,
    catalogVerified,
  };
}

/**
 * Whether `checkBareCollisions`' message must reach the operator.
 *
 * EXTRACTED SO IT CAN BE ASSERTED. The condition used to be an inline
 * `if (c.hijackable.length || c.shadowed.length)` inside the entry-point block,
 * which no test can run -- and that is precisely where the disclosure would fail
 * silently. A guard that composes an honest message nobody prints has not
 * disclosed anything, so the printing condition is part of the control and is
 * held to the same standard as the rest of it (same reason `deriveAnthropicSets`
 * is exported: logic left inline down there is logic nothing can assert on).
 *
 * NOT A VERDICT. This decides visibility only; `fatal` is computed in the guard
 * and neither reads this nor is read by it.
 *
 * @param {{hijackable: object[], shadowed: object[], vouchedHijacks?: object[],
 *          catalogVerified?: boolean}} collisions
 * @returns {boolean}
 */
export function shouldReportCollisions(collisions) {
  return Boolean(
    collisions?.hijackable?.length ||
    collisions?.shadowed?.length ||
    // A run whose ONLY finding was vouched away. Without this disjunct the
    // accepted risk is named in a message nothing prints, which is the same
    // silence the unverified all-clear disjunct below was added to fix.
    collisions?.vouchedHijacks?.length ||
    // The findings-free unverified run. Without this disjunct the operator sees
    // NOTHING on exactly the path where the guard verified least.
    collisions?.catalogVerified === false
  );
}

// How stale the catalog may be and still decide what we ROUTE. The fetch's own
// TTL is one hour; past this ceiling the relay has been unreachable for a week
// and the cached id list is no longer good enough to write into live
// Providers[].models, where a retired id becomes a picker row that 404s.
//
// Deliberately NOT applied to the collision guard's use of the same snapshot:
// there, any real evidence beats none (the alternative is `null`, which widens
// the guard back to matching every Claude-SHAPED name), and a retired id being
// considered costs a false positive rather than a misroute.
export const ROUTING_MAX_STALENESS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The catalog's ids IF the snapshot is recent enough to decide what we route.
 *
 * Returns null past the ceiling, which `deriveAnthropicSets` reads as "no live
 * data" and answers with the curated set -- four reviewed rows rather than a
 * week-old list that may advertise a model Anthropic has since retired.
 *
 * A record with no timestamp (the legacy cache shape) reports `at: 0` and so
 * fails every ceiling. That is the right default: unknown age is not fresh.
 *
 * @param {{ids: Set<string>, at: number}|null} catalog
 * @returns {Set<string>|null}
 */
export function routableCatalogIds(catalog, now = Date.now(), maxAgeMs = ROUTING_MAX_STALENESS_MS) {
  if (!catalog) return null;
  return now - (catalog.at || 0) <= maxAgeMs ? catalog.ids : null;
}

/**
 * Every id set the Anthropic relay needs, derived from one live catalog.
 *
 * Exported and pure for the same reason `checkBareCollisions` above it is: the
 * pipeline below cannot be run from a test (it reads the vault, spawns
 * PowerShell for 44 credentials and parses a 19.7 MB catalogue), so any logic
 * left inline down there is logic nothing can assert on. That is not a
 * hypothetical here -- the vouching regression this function's `relayOwned`
 * exists to fix shipped precisely because these sets were inline and untested.
 *
 * THE INVARIANT THE CALLER DEPENDS ON: `relayOwned` is the CURATED set and
 * never grows with live data, while `routingIds` and `pickerIds` do. When live
 * data adds an id, the two must diverge -- if they were ever made equal again,
 * the guard's FATAL path silently disappears.
 *
 * @param {Set<string>|string[]|null} liveIds  live ids, or null if unavailable
 *   / too stale to route on. null falls back to the curated set for everything.
 * @param {readonly string[]} [curatedIds]
 * @param {readonly string[]} [aliasList]  the relay's static routing list, whose
 *   bare aliases (`opus`, `sonnet`, ...) are not model ids and never appear live
 * @returns {{routingIds: Set<string>, relayOwned: Set<string>,
 *            pickerIds: string[], relayAliases: string[]}}
 */
export function deriveAnthropicSets(liveIds, curatedIds = ANTHROPIC_FULL,
                                    aliasList = ANTHROPIC_RELAY.routing) {
  const curated = [...(curatedIds ?? [])];
  // Auto-add. A live id joins routing on its own: this is our own authenticated
  // relay, and a picker row that is shown must actually route.
  const routingIds = liveIds ? new Set([...liveIds, ...curated]) : new Set(curated);
  // The bare aliases (`opus`, ...) the relay co-owns so a third party cannot
  // sole-own them. Computed as "in the static routing list but not a model id",
  // so it stays correct however routingIds grows.
  const relayAliases = (aliasList ?? []).filter((id) => !routingIds.has(id));
  return {
    routingIds,
    // NEVER unioned with LIVE data -- that is what would let auto-add launder a
    // real hijack into an accepted ambiguity.
    //
    // The aliases ARE included, and must be. They are static and hardcoded, so
    // they are exactly as curated as ANTHROPIC_FULL and carry none of the live-
    // data risk the rule above exists for. Omitting them made the relay unable
    // to vouch for the four ids it most certainly serves: with the relay UP and
    // co-owning bare `opus`, the guard read the reseller as an unvouched sole
    // owner and went FATAL on a configuration that is merely ambiguous --
    // CCR's resolve() returns undefined on a two-owner bare name rather than
    // binding either, which is the `shadowed` case, not the hijack case.
    relayOwned: new Set([...curated, ...relayAliases]),
    // Decision 3, reversed: the native menu shows every live id, not the
    // curated four. Falls back to curated only when there is no usable live
    // data at all -- showing four reviewed rows beats showing none.
    pickerIds: liveIds ? [...liveIds] : [...curated],
    relayAliases,
  };
}

/**
 * The relay's provider name is RESERVED, and until now that was asserted in
 * prose in three places and enforced in none.
 *
 * Three separate consumers key off "the provider called `anthropic` is ours",
 * and this branch added two of them:
 *   checkBareCollisions       owners are keyed by provider NAME, so two providers
 *                             sharing it collapse into ONE owner -- the guard then
 *                             reports "no collisions" while an impostor SOLE-OWNS
 *                             a Claude-shaped id. Measured; it goes quiet.
 *   orderNativePickerOptions  partitions rows by the `anthropic/` prefix, so a
 *                             vault row would be hoisted to the head of the
 *                             /model menu as if Anthropic served it.
 *   validate()'s V3 exemption rows under this prefix are excused from declaring
 *                             `behavesAs`, and an undeclared id resolves through
 *                             lH() to the maximal assumption set (report 18 §3).
 *
 * NOT CURRENTLY EXPOSED, which is why this is a guard and not a bug fix:
 * providers.json carries an `anthropic` profile but registry.json has no matching
 * key, so it is dropped as an orphan upstream. That is one edit away from being
 * untrue, and the failure it would cause is silent in all three places.
 *
 * The message names all three dependents deliberately. "Reserved name" alone
 * tells an operator nothing about why renaming their provider is not optional.
 *
 * @param {{name: string}[]} providers  the built vault set, pre-unshift
 * @param {string} relayName
 */
export function assertRelayNameUnclaimed(providers, relayName = ANTHROPIC_RELAY.name) {
  if (!(providers ?? []).some((p) => p?.name === relayName)) return;
  throw new Error(`a vault provider is named "${relayName}", which is reserved for the ` +
    `relay: checkBareCollisions keys owners by provider name and would collapse the two ` +
    `into one owner (reporting no collisions while an impostor sole-owns a Claude id), ` +
    `orderNativePickerOptions would hoist its rows to the head of the /model menu, and ` +
    `validate()'s V3 exemption would excuse them from declaring behavesAs — which lH() ` +
    `resolves to the maximal assumption set. Rename it in providers.json.`);
}

/**
 * The one invariant that keeps `checkBareCollisions`' REPORTING honest.
 *
 * CORRECTED UNDER A2 (plan §1.1a). This opened "the one invariant that keeps
 * `checkBareCollisions`' FATAL path reachable", and that is now FALSE. The guard
 * classifies from the unstripped `owners`, so the sole-owner branch is reachable
 * BY CONSTRUCTION -- it is CCR's own bind condition, and no value of `relayOwned`
 * can close it. Leaving the old sentence would have handed the next reader a
 * confident, wrong account of what this invariant protects, which is the failure
 * mode `menu/catalog.mjs:112-122` carries a standing rule against.
 *
 * WHAT IT PROTECTS INSTEAD, AND IT IS STILL WORTH ASSERTING. `relayOwned` is what
 * the relay's ownership VOUCHES for and `routingIds` is what it merely ROUTES.
 * Auto-add grows routing with every live id; nothing may ever grow the vouched
 * set. If the two are reunified, `vouched()` becomes universally true and the
 * guard loses the two things vouching still decides: the `shadowed` finding stops
 * saying "the relay routes this id but does not curate it" -- so an ambiguity our
 * own auto-add manufactured becomes indistinguishable from one a human reviewed
 * -- and `relayHelps` starts offering "start the Anthropic relay" for ids the
 * relay merely routes, which is the unachievable-remedy class the
 * `claude-opus-4-8` case taught this file not to print.
 *
 * THE ERROR MESSAGE BELOW STILL SAYS "FATAL sole-owner path", AND IS LEFT ALONE
 * DELIBERATELY. It is asserted verbatim by the reunification test, and R7's
 * mandate is that this function's assertions are unchanged; correcting the string
 * would invert an assertion outside R7's enumerated three. Recorded as a
 * follow-up rather than silently repaired.
 *
 * That reunification is not a hypothetical -- it is the HIGH regression this
 * branch shipped and fixed, and it was invisible in the diff of the guard itself,
 * which did not change.
 *
 * THE OLD SHAPE OF THIS CHECK COULD NOT FIRE ON THE FAILURE IT NAMED. It was
 * `relayOwned.size > routingIds.size`, and reunification makes the two sets
 * EQUAL, which `>` cannot see. `!==` is not the fix either: when there is no
 * usable live data both sets legitimately reduce to the curated constant, so
 * inequality is the normal state exactly half the time.
 *
 * So the property is asserted against the CURATED CONSTANT rather than against
 * the other derived set -- comparing two derivations of the same edit is how the
 * first version talked itself into passing:
 *   1. the vouched set is the curated list and never grows with live data, and
 *   2. where live data supplied an id outside that list, routing DID grow.
 * Rule 1 catches the reunifying edit directly. Rule 2 catches the inverse -- a
 * routing set that stopped auto-adding -- which leaves the guard armed but the
 * picker advertising rows CCR will not route.
 *
 * @param {Set<string>} relayOwned   the vouched set as derived
 * @param {Set<string>} routingIds   the routed set as derived
 * @param {Set<string>|null} liveIds the routable live ids, or null when there
 *   are none usable; the raw input both sets are derived FROM
 * @param {readonly string[]} [curated]
 */
export function assertVouchedSetIsNarrower(relayOwned, routingIds, liveIds,
                                           curated = ANTHROPIC_FULL,
                                           aliases = ANTHROPIC_ALIASES) {
  // The vouchable set is curated ids PLUS the static bare aliases. Both are
  // hardcoded; neither can come from a provider. The rule this enforces is not
  // "curated only" -- it is "nothing that arrived as LIVE data" -- and the
  // aliases had to join it on 2026-09-06, because without them the relay could
  // not vouch for `opus`/`sonnet`/`haiku`/`fable`, the four ids it most
  // certainly serves and the four Claude Code actually sends.
  const curatedSet = new Set([...curated, ...aliases]);
  const grew = [...relayOwned].filter((id) => !curatedSet.has(id));
  if (grew.length) {
    throw new Error(`internal: relayOwned grew beyond the curated set ` +
      `(${grew.slice(0, 3).join(", ")}) — the relay would then vouch for every id ` +
      `checkBareCollisions considers, and its FATAL sole-owner path becomes ` +
      `structurally unreachable, exactly as it did before this guard existed`);
  }
  const liveOnly = liveIds ? [...liveIds].filter((id) => !curatedSet.has(id)) : [];
  // Compared against the vouched set MINUS the aliases: the aliases are never in
  // routingIds by construction (relayAliases is "in the routing list but not a
  // model id"), so counting them here would make routing look smaller than it is.
  const vouchedModelIds = [...relayOwned].filter((id) => !aliases.includes(id)).length;
  if (liveOnly.length && routingIds.size <= vouchedModelIds) {
    throw new Error(`internal: live data supplied ${liveOnly.length} id(s) outside the ` +
      `curated set but routing did not grow (routing ${routingIds.size} <= vouched ` +
      `${vouchedModelIds}) — the picker would advertise rows CCR will not route`);
  }
}

/**
 * What actually gets written to `settings.json`'s `modelPicker.options`: every
 * built row, Anthropic first.
 *
 * DECISION 4 REVERSED, 2026-09-06. The scoping this replaces kept only the
 * Anthropic rows, on the belief that `options[]` was nothing but the rendered
 * `/model` menu. Read from the binary (build 2.1.261) it does two jobs at once:
 * `Ato()` renders the rows from it and `_re()` reads `behavesAs` from the same
 * array, so it is also the only registry that can declare a capability profile
 * for an arbitrary number of models. Dropping a row drops that model's
 * declaration, and an id with no `behavesAs` resolves through `lH()` to the
 * MAXIMAL assumption set -- every effort tier, adaptive thinking on, thinking
 * un-disableable -- plus an unknown-model launch warning. Report 18 §3 measures
 * that as strictly worse than any declared bucket, so the scoping was a silent
 * capability regression on all 83 third-party rows.
 *
 * The partition is a DEFENSIVE INVARIANT, not a transformation: the relay block's
 * `built.providers.unshift` already puts the relay rows first and
 * `assertRelayNameUnclaimed` keeps any vault provider from taking the name, so
 * this is a no-op on today's data. It exists so "Anthropic first" is true where
 * `options[]` is built rather than by an accident 400 lines upstream -- and
 * `Ato()` iterates in array order, so that ordering is what keeps an 87-row menu
 * usable.
 *
 * No relay-down fallback: nothing is filtered, so there is nothing to fall back
 * from. The empty-`options[]` case that fallback guarded is still caught, by the
 * post-write verification (`assertOptionsComplete`) throwing into the catch that
 * calls `restoreSettings`.
 *
 * CITED BY SYMBOL, NOT BY LINE, and that is a correction rather than a style
 * preference: the five line numbers this replaces were written in the same commit
 * that added ~76 lines above them, so every one shipped already stale. A symbol
 * survives insertion; `menu/`'s comments already do it this way.
 *
 * @param {{model: string, description?: string}[]} pickerRows  the full built set
 * @param {{relay?: string}} [opts]
 * @returns {object[]} a NEW array holding the same row objects. Never sorts in
 *   place: `built.picker` is read afterwards by `reconcileUserModelPin` and as
 *   `built.picker[0].model` (the last fallback of the `anchorModel` chain), so a
 *   mutation here would silently repoint the profile anchor.
 */
export function orderNativePickerOptions(pickerRows, { relay = ANTHROPIC_RELAY.name } = {}) {
  const rows = pickerRows ?? [];
  const isRelay = (r) => String(r?.model ?? "").startsWith(`${relay}/`);
  return [...rows.filter(isRelay), ...rows.filter((r) => !isRelay(r))];
}

/**
 * Tier 2 of validation: the rules whose subject is the WRITTEN artifact.
 *
 * `validate()` receives the built set and nothing else, 350 lines before
 * `options[]` exists, so these two rules cannot live there -- an invariant
 * asserted where its subject does not yet exist passes vacuously, which is the
 * failure mode the whole two-tier split is against.
 *
 * ARGUMENT POSITION IS LOAD-BEARING AND EASY TO GET WRONG. `writtenOptions` must
 * be the POST-strip array, i.e. `settings.modelPicker.options`, never the
 * `optionRows` it was mapped from. `optionRows` still carries `contextTokens`
 * and `kind`, so pointing V8 at it would report a schema violation on every row
 * of every clean build, throw into the catch below and roll settings.json back
 * from backup on a run that did nothing wrong. `model` survives the strip, so
 * one array serves both rules.
 *
 * Throws rather than returning problems: `validate()`'s problems are collected
 * before anything is written, while this runs with a half-merged settings.json
 * on disk, and the existing catch restores it from backup. That restore IS the
 * failure machinery; none is added here.
 *
 * WHAT THIS DOES AND DOES NOT BUY. It does not order T1 before T7 -- it is
 * introduced after both, so at the moment a T7-without-T1 commit could exist
 * this guard does not. What it does is make the reversal PERMANENT at the write
 * site: a unit test on the ordering function cannot see a `.filter()` reintroduced
 * here, 350 lines away, and that is the mutation this catches.
 *
 * @param {{model: string}[]} builtPicker      every row the build produced
 * @param {object[]} writtenOptions            settings.modelPicker.options
 */
export function assertOptionsComplete(builtPicker, writtenOptions) {
  const written = new Set((writtenOptions ?? []).map((r) => r.model));
  // V7. `options[]` is simultaneously the rendered /model list and the only
  // registry that can carry `behavesAs`, so a dropped row loses its capability
  // declaration -- and an undeclared id resolves through lH() to the maximal
  // assumption set plus an unknown-model launch warning, which report 18 §3
  // measures as strictly worse than any declared bucket.
  const missing = (builtPicker ?? []).filter((r) => !written.has(r.model));
  if (missing.length) {
    throw new Error(`${missing.length} built row(s) did not reach modelPicker.options ` +
      `(first: "${missing[0].model}") — options[] is the only channel that can carry ` +
      `behavesAs; lH() resolves a missing declaration to the maximal assumption set ` +
      `(report 18 §3, OQ-1)`);
  }
  // V8. Claude Code's own zod definition of a row is exactly these four keys.
  // A fifth is not merely ignored, and this is the rule that pins the strip.
  const allowed = new Set(["model", "label", "description", "behavesAs"]);
  for (const row of writtenOptions ?? []) {
    for (const k of Object.keys(row)) {
      if (!allowed.has(k)) {
        throw new Error(`row "${row.model}" would write key "${k}", which is not in ` +
          `Claude Code's row schema {model, label?, description?, behavesAs?}`);
      }
    }
  }
}

/**
 * `--verified-only` filters the PICKER, and deliberately not ROUTING.
 *
 * THE ASYMMETRY IS THE WHOLE POINT, so read it before restoring the symmetry.
 * The two sets are not two views of one thing:
 *   - the picker is what we ADVERTISE. A row that 404s on selection is worse
 *     than an absent one -- the user picks it, it fails, and nothing explains
 *     why. Pruning it to what a live probe actually served is a real guarantee.
 *   - `providers[].models` is what CCR can ROUTE. Post-R11 it is an uncapped
 *     union (1,584 third-party ids over 45 providers) and it costs nothing to
 *     carry: an id nobody names is never dialled.
 *
 * So the probe is EVIDENCE OF PRESENCE, NEVER OF ABSENCE. On the current
 * snapshot it attempted 22 ids and 18 answered, of which 14 match a third-party
 * picker row -- against 1,584 routing ids. Every id outside that sample is
 * unprobed, not known-dead. Filtering routing by it would delete 1,570 of the
 * 1,584 on no evidence at all, and one 503 mid-probe is enough to lose a whole
 * provider (mistral, once).
 *
 * That is what this function was fixed from. It used to filter both, so the flag
 * silently cut reach 1,584 -> 14 while printing "13 providers / 14 rows survive"
 * -- which reads as verification and was truncation. Opt-in, so not a pillar-4
 * violation, but the console line was the only thing standing where the loss was.
 *
 * `providers` is returned BY IDENTITY, not rebuilt, so "untouched" is assertable
 * rather than merely intended.
 *
 * @param {{picker: {model: string}[], providers: object[]}} built
 * @param {{working: string[], results: {model: string, ok: boolean, ms: number}[]}} verified
 *   parsed verify-prune.mjs output; `working` is namespaced `provider/model` ids
 * @returns {{providers: object[], picker: object[], verifiedOrder: string[]}}
 *   `verifiedOrder` is fastest-first, so the profile anchor is a responsive model
 */
export function applyVerifiedOnly(built, verified) {
  const ok = new Set(verified.working ?? []);
  return {
    providers: built.providers,
    picker: built.picker.filter((r) => ok.has(r.model)),
    verifiedOrder: (verified.results ?? [])
      .filter((r) => r.ok)
      .sort((a, b) => a.ms - b.ms)
      .map((r) => r.model),
  };
}

/**
 * The profile anchor, and WHICH RULE PRODUCED IT.
 *
 * EXTRACTED FOR ONE REASON: the last fallback. `?? picker[0].model` silently
 * repoints all six CCR profile tiers on any change to picker ORDERING -- a
 * capability signal appearing in a provider's listing is enough, and R11 added
 * exactly that precedence. Inline in the entry block, that fallback was
 * unobservable: nothing could assert the anchor had not moved, and a move
 * produces no error, no log line and no failing test. It produces a working
 * config pointed at a different model.
 *
 * `via` IS THE POINT, NOT `model`. Two builds can agree on the anchor id by
 * coincidence -- the preference list resolving, and the picker head happening to
 * be the same row -- so a test that compares only the id passes through the exact
 * regression this function exists to catch. `via` says which of the four rules
 * fired, and "the anchor is stable" means BOTH fields are unchanged.
 *
 * MEASURED 2026-09-08, pre-R11 (a68caab) vs HEAD, same vault, same catalogue,
 * same day, `menu/denylist.mjs` and `keysync/catalog-join.mjs` byte-identical
 * across that range so R11's change is isolated:
 *
 *   pre-R11   83 picker rows, routing 83,    anchor google/gemini-3.5-flash-lite
 *   post-R11  83 picker rows, routing 1,584, anchor google/gemini-3.5-flash-lite
 *
 * The picker was ORDER-identical, row for row, not merely equal in count or as a
 * set. So R11 widened routing 19x and moved the anchor not at all. Both resolve
 * at ANCHOR_PREFERENCE[0] by exact match, four rules short of the fallback --
 * which is why the picker head (`orcarouter/orcarouter/free`, a free-tier router
 * row, and a poor anchor for Claude Code's real payload) never gets a vote.
 *
 * @param {{model: string}[]} picker
 * @param {object}   opts
 * @param {boolean}  opts.anthropicOn        relay live -> the constant tiers win
 * @param {string[]} [opts.verifiedOrder]    --verified-only's fastest-first list
 * @param {string[]} [opts.preference]       defaults to ANCHOR_PREFERENCE
 * @param {object}   [opts.tiers]            defaults to ANTHROPIC_TIERS
 * @returns {{model: string, via: string}} `via` is one of `anthropic-tiers`,
 *   `preference:<entry>`, `verified`, `picker-head`
 */
export function resolveAnchor(picker, {
  anthropicOn, verifiedOrder = null, preference = ANCHOR_PREFERENCE, tiers = ANTHROPIC_TIERS,
} = {}) {
  if (anthropicOn) return { model: tiers.model, via: "anthropic-tiers" };
  for (const pref of preference) {
    const hit = picker.find((r) =>
      (pref.endsWith("/") ? r.model.startsWith(pref) : r.model === pref))?.model;
    if (hit) return { model: hit, via: `preference:${pref}` };
  }
  const rowExists = (m) => picker.some((r) => r.model === m);
  const verified = verifiedOrder?.find(rowExists);
  if (verified) return { model: verified, via: "verified" };
  // Unguarded on purpose: an empty picker here is already refused upstream
  // (--verified-only exits at zero rows, validate() fails the count otherwise),
  // and inventing a second error for it would only hide which check lapsed.
  return { model: picker[0].model, via: "picker-head" };
}

/**
 * What CCR would bind a BARE model name to, modelled from its own rule.
 *
 * `providerModelMatches` iterates raw `Providers[].models[]` behind only a
 * provider-level enabled gate, and `resolve()` binds on exactly one match --
 * returning undefined on more than one. So ambiguity FAILS CLOSED: a name two
 * providers advertise routes nowhere rather than to whichever was cheapest to
 * find. That is the property worth pinning, because it is what keeps a reseller
 * from receiving traffic addressed to a name it merely happens to list.
 *
 * ENTRIES, NOT PROVIDERS, and the difference is not pedantry: one provider
 * listing an id twice is two matches, so CCR binds nothing even though there is
 * a single owner. Counting providers here would call that id bindable and the
 * model would stop matching CCR.
 *
 * @param {object[]} providers  built `Providers[]`, each `{name, models: string[]}`
 * @param {string} id           the bare name a client asked for
 * @returns {{provider: string, model: string}|undefined} undefined when 0 or 2+
 */
export function resolveBare(providers, id) {
  const matches = [];
  for (const p of providers) for (const m of p.models) {
    if (m === id) matches.push({ provider: p.name, model: m });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Ownership of every bare id in the built config, counted by PROVIDER.
 *
 * The companion to `resolveBare`, and deliberately a SEPARATE computation rather
 * than a view over it: the census answers "how many providers claim this name",
 * `resolveBare` answers "what would CCR do". They are asserted against each other
 * (test/routing-split.test.mjs), so a future edit that collapses one into the
 * other -- making the fail-closed property a tautology of its own definition --
 * stops being able to prove anything and the paired test says so.
 *
 * NOT A SUBSTITUTE FOR `checkBareCollisions`. This counts every id; the guard
 * classifies the Claude-SHAPED ones against Anthropic's published set, under
 * two-stage exact-then-case-folded matching, and is the only thing that can go
 * fatal. The census exists to measure the population the guard's subject sits in.
 *
 * @param {object[]} providers
 * @returns {{owners: Map<string, string[]>, ambiguous: string[], soleOwned: string[]}}
 *   `owners` values are deduplicated and sorted; `ambiguous` is 2+ providers.
 */
export function bareIdCensus(providers) {
  const owners = new Map();
  for (const p of providers) for (const m of p.models) {
    if (!owners.has(m)) owners.set(m, new Set());
    owners.get(m).add(p.name);
  }
  const flat = new Map([...owners].map(([id, set]) => [id, [...set].sort()]));
  return {
    owners: flat,
    ambiguous: [...flat].filter(([, o]) => o.length > 1).map(([id]) => id).sort(),
    soleOwned: [...flat].filter(([, o]) => o.length === 1).map(([id]) => id).sort(),
  };
}

/**
 * R10's per-provider discovery cache, in the shape `buildProviders` wants.
 *
 * `discoveryIndex` accepts `provider -> record` where the record is either the
 * raw cache record (`{outcome, models}`) or a bare array -- NOT a `{byProvider}`
 * wrapper, which is `catalog`'s shape and a mistake easy to make here because
 * the two are joined together downstream.
 *
 * EVERY FAILURE DEGRADES, NONE THROWS, AND NONE IS SILENT. `cacheRoot` throws
 * when the local app-data root is unset and `readCacheRecord` throws when a
 * record is not owner-only -- both are real conditions on a machine that has
 * never run `refresh`, and neither is a reason to stop a keysync that worked
 * fine without discovery for its whole life. Discovery only ever ADDS candidate
 * ids, so the degraded path is exactly the pre-R13c build rather than a
 * truncated one. The returned `note` is what keeps the degradation visible: a
 * silently empty cache would shrink routing by ~3,400 entries and read as
 * success.
 *
 * BOUNDED BY `ROUTING_MAX_STALENESS_MS`, THE SAME CEILING `routableCatalogIds`
 * ENFORCES ON THE CATALOGUE. This is the LARGER of the two routing-candidate
 * sources (~3,400 of 5,026 entries on the real vault), so leaving it unbounded
 * would reopen through the bigger door exactly what that ceiling was written to
 * close: a reseller retires a model, nobody re-runs `refresh/cli.mjs`, and
 * keysync keeps advertising the dead id forever as a picker row that 404s.
 * A record with no parseable `at` fails the ceiling -- unknown age is not fresh,
 * the same default the catalogue's unstamped legacy shape gets.
 *
 * FILTERED HERE RATHER THAN AT THE ROUTING SPLIT, so the collision guard and
 * `Providers[].models` see the SAME id set. The ceiling's own comment carves the
 * guard out of the catalogue's bound -- there, the alternative to a stale id is
 * `null`, which widens the guard back to every Claude-SHAPED name. That reasoning
 * does not transfer: a discovery id dropped here is never WRITTEN either, and an
 * id CCR cannot route is an id no reseller can hijack. Analysing rows the build
 * does not emit would only manufacture findings about a config nobody has.
 *
 * @param {string[]} names  provider names to look for, normally `chosen`'s
 * @param {object} [opts]
 * @param {() => string} [opts.root=cacheRoot]
 * @param {(p: string, o: object) => object|null} [opts.read=readCacheRecord]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.maxAgeMs=ROUTING_MAX_STALENESS_MS]
 * @returns {{discovery: Map<string, object>|null, note: string}}
 *   `discovery` is null ONLY when no cache directory could be resolved at all;
 *   an empty Map means the directory exists and held nothing USABLE for these
 *   providers, which is a different fact and reads differently downstream.
 */
export function loadDiscoveryCache(names, {
  root = cacheRoot, read = readCacheRecord,
  now = Date.now(), maxAgeMs = ROUTING_MAX_STALENESS_MS,
} = {}) {
  let dir;
  try { dir = root(); } catch (e) {
    return { discovery: null, note: `discovery: no cache directory (${e.message}); ` +
      `routing falls back to catalogue u testModel` };
  }
  const discovery = new Map();
  const unreadable = [], stale = [];
  let barren = 0;
  for (const name of names) {
    let record = null;
    try { record = read(name, { dir }); } catch (e) { unreadable.push(`${name}: ${e.message}`); continue; }
    if (!record) continue;
    // `at` is an ISO STRING in the record (`discoverProvider`'s `now()`), not a
    // millisecond number like the catalogue's. `Date.parse` of a missing or
    // malformed stamp is NaN, and `!(NaN <= n)` is true, so the unstamped record
    // takes the stale branch rather than sliding through a comparison that
    // silently answers false.
    if (!(now - Date.parse(record.at ?? "") <= maxAgeMs)) { stale.push(name); continue; }
    if (!contributesIds(record)) { barren++; continue; }
    discovery.set(name, record);
  }
  // COUNTS WHAT CONTRIBUTES, NOT WHAT EXISTS ON DISK. A record that survives the
  // ceiling but carries `models: "a string"`, a `{byProvider}` wrapper, or an
  // empty listing is dropped to nothing by `discoveryIndex` downstream; counting
  // it as a provider that "has a cache record" reports coverage the build does
  // not have, and reads as success on exactly the runs that lost the most.
  const segments = [];
  if (stale.length) {
    segments.push(`${stale.length} past the ${Math.round(maxAgeMs / 86_400_000)}d routing ` +
      `ceiling and not routed (${stale.join(", ")})`);
  }
  if (unreadable.length) segments.push(`${unreadable.length} unreadable (${unreadable.join("; ")})`);
  if (barren) segments.push(`${barren} fresh but contributed no usable id`);
  const note = `discovery: ${discovery.size} of ${names.length} provider(s) contribute ids ` +
    `from a fresh cache record` + (segments.length ? `; ${segments.join("; ")}` : "");
  return { discovery, note };
}

/**
 * Whether a cache record would yield at least one id downstream.
 *
 * DELIBERATELY MIRRORS `discoveryIndex` (keysync.mjs), which is the function that
 * actually projects these records and is not exported. The two must agree or the
 * note above lies in one direction or the other; the shapes are pinned by test so
 * a change to either side that is not made to both fails rather than drifts.
 */
function contributesIds(record) {
  const models = Array.isArray(record) ? record
    : (Array.isArray(record?.models) ? record.models : null);
  return models?.some((m) => typeof m?.id === "string" && m.id !== "") === true;
}

/**
 * The specific Claude-shaped ids the operator has vouched, per provider name.
 *
 * STRICT `Array.isArray`, AND `true` IS NOT A VOUCH. The field was once a
 * boolean, and that shape granted its holder authority over every bare
 * Claude-shaped id it would EVER sole-own -- a scope the reseller then widened
 * unilaterally by editing its own listing. A boolean here is therefore REJECTED
 * rather than read as "vouch everything": an operator who wrote `true` gets the
 * same verdict as one who wrote nothing, which is fatal, which is the safe
 * direction to be wrong in. So must `"true"`, `1`, `{}` and every other shape a
 * hand-edited JSON file puts in a slot that downgrades a security finding.
 *
 * IDS ARE TRIMMED, NOT FOLDED. `checkBareCollisions` keys ownership on trimmed
 * selectors, so trimming here makes the two comparable; case is left alone
 * because the vouch is a review of the exact id the guard reported, and
 * widening the match is how a review of one name comes to cover another.
 *
 * A provider whose list survives to nothing (absent, empty, or all entries
 * unusable) is omitted entirely, so `map.get(name)` is either a non-empty set
 * or undefined.
 *
 * @param {Map<string, object>} providers  the vault profiles from `loadVault`
 * @returns {Map<string, Set<string>>}  provider name -> the ids vouched for it
 */
export function vouchedBareClaudeProviders(providers) {
  const out = new Map();
  for (const [name, profile] of providers ?? []) {
    const listed = profile?.vouchedBareClaude;
    if (!Array.isArray(listed)) continue;
    const ids = new Set(listed
      .filter((id) => typeof id === "string" && id.trim() !== "")
      .map((id) => id.trim()));
    if (ids.size) out.set(name, ids);
  }
  return out;
}

// ENTRY-POINT GUARD. Everything below runs the pipeline: it reads the vault,
// writes built-rows.json, and on the dry path calls process.exit(0). Without
// this check, `import { checkBareCollisions } from "./run.mjs"` would run all of
// it and kill the importing process -- which is exactly what happens under
// `node --test`, where no --target is passed so `dry` defaults to true.
//
// Deliberately a wrapping block rather than a main() extraction: this file
// writes CCR config and settings.json, and a reindent would put a large
// unreviewed diff around live behaviour. Nothing outside the block references
// anything declared inside it.
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isEntry) {

// ------------------------------------------------------------------- inputs
const { registry, providers } = loadVault();
const filtered = filterRegistry(registry, providers);
const chosen = chooseKeys(filtered);
const catalog = loadCatalog();
console.log(`vault: ${registry.length} keys -> ${filtered.length} after filter -> ${chosen.length} distinct providers`);
console.log(`catalog: ${catalog.byProvider.size} providers, generated ${catalog.generatedAt}`);
console.log(`deliberate multi-key choices: ${JSON.stringify(KEY_CHOICES)}`);

// Credentials are read one at a time from Windows Credential Manager and are
// never logged. Only ids and counts appear in output.
// Read every credential in ONE PowerShell session. Spawning a shell per key
// cost ~45s for 44 keys and dominated the run.
let keyCache = null;
const loadAllKeys = (ids) => {
  const list = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
  const script =
    `. 'C:\\Users\\osami\\.llmkeys\\ApiKeyVault.ps1'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60000 });
  return JSON.parse(raw.trim());
};
const readKey = (id) => {
  if (!keyCache) keyCache = loadAllKeys(chosen.map((c) => c.id));
  const key = keyCache[id];
  if (!key) throw new Error(`no credential in vault for id ${id}`);
  return key;
};

// R13c: R10's cache reaches routing here, and this is the line the comment above
// `checkBareCollisions` warned about ("the next task to wire R10's discovery
// cache into this path must re-measure before it ships"). Re-measured
// 2026-09-08 on the real vault: routing entries 1,584 -> 5,026 and, on the
// `realIds === null` branch, hijackable 0 -> 22 with fatal flipping to true.
// That verdict is REAL and is not softened here -- see the vouch mechanism in
// `checkBareCollisions`, which gives the operator a way to accept a NAMED id at
// a NAMED reseller rather than a flag that accepts all of them.
const { discovery, note: discoveryNote } = loadDiscoveryCache(chosen.map((c) => c.provider));
console.log(discoveryNote);
const built = buildProviders(chosen, providers, catalog,
  dry ? () => "dry-run-placeholder" : readKey, discovery);
for (const n of built.notes) console.log(`  note: ${n}`);

// --verified-only: keep only PICKER rows a live probe confirmed serve
// completions. Routing is left whole -- see `applyVerifiedOnly` for why the
// asymmetry is deliberate.
// Snapshot before --verified-only replaces `built.picker`.
const builtAll = { picker: [...built.picker] };

let verifiedOrder = null;
if (has("--verified-only")) {
  const vf = "C:\\Users\\osami\\.uw\\keysync\\verified-rows.json";
  if (!fs.existsSync(vf)) { console.error(`--verified-only needs ${vf}; run verify-prune.mjs first`); process.exit(2); }
  const verified = JSON.parse(fs.readFileSync(vf, "utf8"));
  const applied = applyVerifiedOnly(built, verified);
  verifiedOrder = applied.verifiedOrder;
  built.picker = applied.picker;
  // Says what was pruned AND what was not. The old line reported a surviving
  // provider count, which read as verification while the flag was truncating
  // routing behind it.
  console.log(`--verified-only: ${built.picker.length} of ${builtAll.picker.length} pre-relay picker ` +
    `rows survive; routing untouched (${built.providers.length} providers, pre-relay)`);
  // Routing can no longer reach zero from this flag, but the picker can. With
  // the relay on, a zero-row picker still leaves ANTHROPIC_TIERS.model as the
  // anchor and would not crash -- but shipping zero third-party rows on an
  // explicit verification flag is a silent no-op worth refusing outright
  // regardless of anchor safety. The count check below cannot catch it: it
  // counts providers.
  if (!built.picker.length) {
    console.error("--verified-only pruned every row — nothing to apply. Re-run verify-cli.mjs.");
    process.exit(2);
  }
}

// ---- Anthropic's live catalog: ONE fetch, three consumers -------------------
// Hoisted above both the relay block and the collision guard because all three
// need it and it must not be fetched twice. Unconditional, exactly as the
// guard's own call site was: --no-anthropic suppresses the relay PROVIDER, not
// the question "what does Anthropic actually publish", which the security guard
// asks regardless. null still means "could not be determined" everywhere.
const liveCatalog = await fetchAnthropicCatalog();
const contextById = liveCatalog?.contextById ?? new Map();

// STALENESS CEILING, applied to ROUTING ONLY. Past it the snapshot is too old
// to decide what we advertise -- a retired id written into Providers[].models
// becomes a picker row that 404s on selection. The collision guard below keeps
// using the raw snapshot regardless of age, deliberately: there the alternative
// to old evidence is `null`, which widens it back to matching every
// Claude-SHAPED name, and an over-considered id costs a false positive rather
// than a misroute.
const catalogAgeMs = liveCatalog ? Date.now() - (liveCatalog.at || 0) : Infinity;
const routableIds = routableCatalogIds(liveCatalog);
const { routingIds, relayOwned, pickerIds, relayAliases } =
  deriveAnthropicSets(routableIds, ANTHROPIC_FULL);

// Every routable id, tagged from its REAL context window. An id with no stated
// window and no hand-tagged default renders bare -- never guess a larger
// context than has been confirmed (see buildAnthropicPickerRows).
const pickerRows = buildAnthropicPickerRows(pickerIds, contextById, ANTHROPIC_FALLBACK_TAGS);
const taggedLive = pickerRows.filter((id) => /\[1m\]$/i.test(id) && contextById.has(id.replace(/\[1m\]$/i, ""))).length;
console.log(`anthropic catalog: ${liveCatalog
  ? `${liveCatalog.ids.size} live id(s), ${contextById.size} with a stated context window` +
    (routableIds ? "" : `, but ${Math.floor(catalogAgeMs / 86400000)}d stale — too old to route on, using the curated set`)
  : "UNAVAILABLE (relay down and no cache) — using the curated set"}` +
  ` -> ${pickerRows.length} picker row(s), ${taggedLive} tagged [1m] from live data`);
// The guard's vouched set must never be the routed set -- that equality is what
// disarmed checkBareCollisions once already. Checked here, at the one place all
// three of the derived sets and their raw input are in scope, because a future
// edit that reunifies them would otherwise produce a config that looks correct
// and silently protects nothing. The rules themselves live in the exported
// function so a test can drive them; see its doc for why they compare against
// the curated constant rather than against each other.
assertVouchedSetIsNarrower(relayOwned, routingIds, routableIds);

// Anthropic via the local OAuth relay, unless --no-anthropic. Checked for
// liveness first: a dead relay would produce picker rows that cannot serve.
let anthropicOn = false;
let aliasesOk = false;
if (!has("--no-anthropic")) {
  let health = null;
  try {
    const h = await fetch(`${ANTHROPIC_RELAY.api_base_url}/health`, { signal: AbortSignal.timeout(4000) });
    anthropicOn = h.ok;
    if (h.ok) { try { health = await h.json(); } catch { health = null; } }
  } catch { anthropicOn = false; }
  // Ask, do not assume. `anthropicOn` says the relay answers; `aliasesOk` says it
  // answers for `opus`. A relay binary predating Task A5.2 returns neither the
  // field nor the endpoint, so `aliasesOk` is false and we write exactly today's
  // list -- no dead rows, and the two halves may land in either order.
  aliasesOk = anthropicOn && Boolean(health?.aliases?.length);
  if (anthropicOn) {
    // `picker` and `routing` are UW-side fields and must not reach CCR's config,
    // which is why they are destructured out rather than spread through.
    const { picker: _picker, routing: _routing, ...relayProvider } = ANTHROPIC_RELAY;
    // Enforced HERE, at the injection, because this is the line that would create
    // the duplicate -- and a throw before the write leaves settings.json untouched.
    assertRelayNameUnclaimed(built.providers, relayProvider.name);
    // `routingIds` is BARE by construction (live /v1/models ids unioned with the
    // curated four), and that is load-bearing in two ways. It is what CCR routes
    // and what the relay forwards toward Anthropic, whose real API 404s on a
    // suffixed id -- and it is what checkBareCollisions reads to decide whether
    // the relay CO-OWNS a Claude-shaped name. The previous expression fed
    // `ANTHROPIC_RELAY.picker` here on the !aliasesOk branch, which became the
    // `[1m]`-suffixed array when the picker rows were tagged: those ids match no
    // real id, so on that branch the relay silently stopped co-owning
    // `claude-opus-5` and a reseller listing it read as a sole owner (FATAL)
    // instead of a shadowed ambiguity. Deriving both branches from `routingIds`
    // removes the suffix from this path entirely.
    built.providers.unshift({
      ...relayProvider,
      models: aliasesOk ? [...routingIds, ...relayAliases] : [...routingIds],
    });
    built.picker.unshift(...pickerRows.map((m) => ({
      model: `${ANTHROPIC_RELAY.name}/${m}`,
      label: `Anthropic > ${m}`,
      description: "subscription"
      // no behavesAs: Claude Code already knows these ids.
    })));
    console.log(`anthropic relay live -> +1 provider / +${pickerRows.length} Claude rows` +
      ` / routing owns ${routingIds.size} id(s)` +
      (aliasesOk
        ? ` plus the ${relayAliases.length} bare aliases`
        : ` / bare aliases NOT advertised (relay does not report them; see Task A5.2)`));
  } else {
    console.log(`WARNING: anthropic relay not responding at ${ANTHROPIC_RELAY.api_base_url} — ` +
      `Claude models will NOT be available, and this config would remove Claude from ` +
      `Claude Code entirely. Start the relay first:\n` +
      `  node ${path.join(os.homedir(), ".local", "bin", "anthropic-oauth-relay.mjs")}`);
  }
}

// The Anthropic relay is added on top of the vault set, so the expected count
// must account for it. Without this every path fails validation outright:
// 45 !== 44. `--verified-only` used to be exempted here, passing the built
// provider count back as its own expectation -- a tautology, because that flag
// pruned providers and there was no independent number left to check against.
// It no longer prunes them, so it takes the same real count as everything else.
// (4) Write the full built set BEFORE pruning. verify-cli previously probed the
// shipped picker, which made pruning a one-way ratchet: a row dropped for a
// transient failure was never probed again (mistral was lost to a single 503).
fs.writeFileSync(BUILT_ROWS, JSON.stringify({
  generatedAt: new Date().toISOString(),
  rows: builtAll.picker.map((r) => r.model)
}, null, 2));

// NO detect-and-warn block here any more, and its absence is deliberate.
// It reported "the relay serves ids the picker does not carry", which stopped
// being true the moment the picker started showing every live id: there is
// nothing left to be "not added". The uncurated/curated split it half-described
// survives only as a SECURITY concern (ANTHROPIC_FULL as the guard's vouched
// set), and the guard already speaks for itself -- loudly and fatally -- at
// exactly the moment it matters. A passive banner restating it would be a
// warning with no action attached, which is how warnings stop being read.

const problems = validate(built, EXPECTED_PROVIDERS + (anthropicOn ? 1 : 0));
const covered = built.providers.filter((p) => catalog.byProvider.has(p.name)).length;
console.log(`built: ${built.providers.length} providers, ${built.picker.length} picker rows ` +
  `(${covered} catalog-covered, ${built.providers.length - covered} on vault testModel)`);
if (problems.length) {
  console.error(`\nVALIDATION FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("validation OK: count, alias uniqueness, picker<=models, credentials present");

// ---- built-in-row bare-id guard -------------------------------------------
// Claude Code's own built-in picker rows survive `replaceBuiltInOptions: true`
// (Finding 11) and send BARE, unnamespaced ids like `claude-opus-5`. CCR then
// resolves those through its cross-provider fallback stages, which bind when
// EXACTLY ONE provider lists that name (case-insensitive). So the safety of a
// built-in row is a property of Providers[], not of anything keysync controls —
// and it changes silently whenever provider coverage changes.
//
// MEASURED 2026-09-02: safe in every current configuration. At 14 live providers
// the four Claude names bind only to the relay (correct); across the full 44 they
// are absent from third-party providers except `claude-opus-4-8`, which two
// routers list and which therefore resolves to *unresolved* rather than binding.
// This guard exists because that result is contingent, not structural: several
// vault routers proxy Claude models, and one of them adding `claude-opus-5` flips
// it. WARNS rather than fails — ambiguity is a clean failure, not a misroute, and
// the dangerous single-match case is rare enough that a hard failure here would
// block runs for a condition the operator may have chosen deliberately.
{
  // Extracted to `checkBareCollisions` (top of this file) so it is testable
  // without running the pipeline, widened to RESERVED's full class -- the inline
  // regex omitted `fable` and used a narrower boundary than the denylist -- and
  // escalated from a warning to a hard stop.
  //
  // WHY IT IS NOW FATAL. Under Rule 2 the denylist no longer refuses
  // Claude-shaped names from resellers, so this is the only control left that
  // stops report 08 F1. A warning that a run proceeds past is not a control when
  // it is the last one. `--allow-bare-claude-names` keeps the deliberate case
  // reachable, so no working configuration is permanently blocked.
  // Anthropic's real ids, unioned with our own verified four regardless of
  // what the live fetch returns -- ANTHROPIC_RELAY.models is already the
  // known-real backstop A5.2 uses for the same reason, so this costs nothing
  // and guards against a live response that anomalously omits one of them.
  // Reuses the single hoisted fetch above rather than calling again. Same
  // semantics as before, id for id: `liveCatalog?.ids` IS what fetchAnthropicIds
  // returned, and null still means "could not be determined".
  const realIds = liveCatalog ? new Set([...liveCatalog.ids, ...ANTHROPIC_RELAY.models]) : null;
  // TWO SETS, TWO JOBS, AND THEY MUST NOT BE THE SAME SET.
  //   realIds    -- which ids the analysis CONSIDERS at all (broad; every id
  //                 Anthropic publishes, however stale the snapshot).
  //   relayOwned -- which ids the relay's ownership VOUCHES for (narrow;
  //                 curated only, never grown by live data).
  // Collapsing them is the regression this branch shipped and had to fix: with
  // routing auto-add, the relay owns everything `realIds` considers, so the
  // FATAL path could never fire. See the vouching block in checkBareCollisions.
  // A THIRD SET, AND IT ANSWERS A THIRD QUESTION. `realIds` is what the analysis
  // considers, `relayOwned` is which ids OUR relay curates, and this is which
  // (RESELLER, ID) PAIRS the operator has accepted as sole ownership. It comes
  // from the vault rather than from source: vouching is a configuration decision
  // about a specific host's specific listing, the same shape as the `listing`
  // block, and a source allowlist would put it beyond the reach of the person
  // who has to make it.
  const vouchedProviders = vouchedBareClaudeProviders(providers);
  const collisions = checkBareCollisions(built.providers,
    { allowBare: has("--allow-bare-claude-names"), realIds, relayOwned, relayRouting: routingIds,
      vouchedProviders });
  // UNCONDITIONAL, and it prints `0 vouched` rather than nothing. A vouch is an
  // accepted risk, and the run where none is in force is exactly the run whose
  // silence would later be read as "there was nothing to accept". The count of
  // unvouched findings is carried alongside it so the line states the verdict's
  // input, not just its aftermath; `collisions.message` names each finding.
  console.log(`bare-Claude collisions: ${collisions.hijackable.length} unvouched (fatal if >0), ` +
    `${collisions.vouchedHijacks.length} vouched (reported, not blocking)`);
  // Printed on findings AND on a findings-free run that could not reach
  // Anthropic's catalogue -- that second case used to print nothing at all,
  // which made an unverified all-clear indistinguishable from a verified one.
  // The condition lives in an exported predicate because nothing can run this
  // block; see `shouldReportCollisions`.
  if (shouldReportCollisions(collisions)) {
    console.warn(collisions.message);
  }
  // Fatal BEFORE any write, and before --dry returns, so a dry run reports the
  // same verdict a live run would enforce. `allowBare` silences the exit, never
  // the finding: the warning above still prints.
  if (collisions.fatal) process.exit(1);
}

if (dry) {
  console.log("\n--dry: nothing written.");
  // THE MEASUREMENT R13b's GATE IS ARGUED FROM, printed rather than asserted.
  // R11 uncapped routing and left the picker capped, so `models[]` now carries
  // ids that reach no `options[]` row -- and `options[]` is the ONLY channel
  // that can carry `behavesAs` (see assertOptionsComplete). An undeclared id
  // still routes; Claude Code resolves it through `lH()` to the MAXIMAL
  // assumption set, which is exactly the priced, accepted tradeoff R11 took and
  // Ship E/R13b owns. R11 shipped it without ever printing the number, so the
  // decision had no denominator attached to it. It does now.
  //
  // THIRD-PARTY ONLY, AND THE EXCLUSION IS THE POINT. The relay's rows are
  // V3-exempt -- Claude Code already knows those ids, so they carry no
  // `behavesAs` by design and counting them would inflate the exposure with
  // rows that are not exposed. Its picker rows are `[1m]`-suffixed while its
  // routing ids are bare, so an exact-string match would have swept all of them
  // in silently.
  const declared = new Set(built.picker.map((r) => r.model));
  let routable = 0, undeclared = 0;
  for (const p of built.providers) {
    if (p.name === ANTHROPIC_RELAY.name) continue;
    for (const id of p.models ?? []) {
      routable++;
      if (!declared.has(`${p.name}/${id}`)) undeclared++;
    }
  }
  console.log(`undeclared routable: ${undeclared} of ${routable} third-party routing ids ` +
    `have no options[] row, so no behavesAs (lH() resolves them to the maximal assumption set)`);
  console.log(built.picker.slice(0, 8).map((r) => `  ${r.model}  [${r.description ?? "unlabelled"}]`).join("\n"));
  process.exit(0);
}

// ------------------------------------------------------------------ targets
let rpc, SETTINGS, guards = null;
if (target === "isolated") {
  ({ rpc } = await import("../harness/config.mjs"));
  SETTINGS = (await import("../harness/config.mjs")).SCRATCH_SETTINGS;
  guards = await import("../harness/guard.mjs");
} else if (target === "live") {
  if (!has("--i-know")) {
    // State the consequence that actually applies to THIS invocation. The old
    // wording claimed --target live "rewrites the REAL ~/.claude/settings.json"
    // unconditionally, which is false with --no-profile (gateway config only) —
    // and a safety prompt that overstates is one users learn to wave through.
    console.error(has("--no-profile")
      ? "refusing: --target live --no-profile writes the REAL CCR gateway config (Providers[] and " +
        "observability) and restarts the gateway, which can interrupt in-flight requests from running " +
        "Claude Code sessions. It does NOT write ~/.claude/settings.json. Re-run with --i-know if that is intended."
      : "refusing: --target live rewrites the REAL ~/.claude/settings.json and will change " +
        "how running Claude Code sessions route. Re-run with --i-know if that is intended.");
    process.exit(2);
  }
  const svcFile = path.join(process.env.APPDATA, "claude-code-router", "service.json");
  const svc = JSON.parse(fs.readFileSync(svcFile, "utf8"));
  const url = new URL(svc.url);
  const token = url.searchParams.get("ccr_web_token");
  rpc = async (method, a = []) => {
    const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
      body: JSON.stringify({ method, args: a }),
      // A wedged CCR would otherwise hang this fetch forever while the exclusive
      // lock is held, after which every future run refuses to start. WAS 30000:
      // measured 2026-09-08, saveConfig on the post-R13b-reopen uncapped picker
      // (5,037 rows, ~1.07 MB) took 69.3s real -- the picker-uncap decision grew
      // this payload ~54x (94 -> 5,037 rows) and nobody re-measured this specific
      // server-side RPC against the new size. 120000 gives ~1.7x headroom over the
      // measured cost, not a guess; a wedged gateway still aborts, just later.
      signal: AbortSignal.timeout(120000)
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method} failed: ${String(j.error?.message).slice(0, 300)}`);
    return j.value;
  };
  SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
} else {
  console.error(`unknown --target "${target}" (dry|isolated|live)`);
  process.exit(2);
}

// ------------------------------------------------------------------- apply
// Single-writer lock: two concurrent runs are a lost-update race on CCR's
// config plus a double gateway restart.
let releaseLock;
try {
  releaseLock = acquireLock();
} catch (e) {
  // A concurrency guard that prints a stack trace is a worse guard.
  console.error(`refusing: ${e.message}`);
  process.exit(2);
}
process.on("exit", () => { try { releaseLock(); } catch {} });
// process.on("exit") does NOT run on default-handled signals, so Ctrl+C and
// taskkill would otherwise leak the lock.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => process.exit(130));
}

const cfg = await rpc("getConfig");
const beforeFingerprint = restartRelevantFingerprint(cfg);

// Assert routing state BEFORE writing: a fallback- or rule-served response would
// otherwise mask a broken entry.
if (guards) guards.assertRouterClean(cfg);
else {
  const fb = cfg.Router?.fallback ?? {};
  if (fb.mode !== "off" || (fb.models ?? []).length) {
    throw new Error(`Router.fallback is ${fb.mode} with ${(fb.models ?? []).length} model(s) — refusing`);
  }
  const enabled = (cfg.Router?.rules ?? []).filter((r) => r.enabled !== false);
  if (enabled.length) throw new Error(`${enabled.length} enabled Router.rules would rewrite routing — refusing`);
}

cfg.Providers = built.providers;
// Own the whole logging policy, not just the on/off switch. Inherited default
// was requestLogBodyCapture:"all" at 100% sampling, which produced ~708MB of
// prompt/response bodies in a single day with no retention — and made
// "disk-full during a config write" self-inflicted rather than hypothetical.
// "errors" keeps exactly what `uw why` needs (it only ever reads failures)
// while dropping the bulk capture of successful conversations.
cfg.observability = {
  ...cfg.observability,
  requestLogs: true,
  requestLogBodyCapture: "errors",
  requestLogSuccessSampleRate: 0.05
};
// (7) CCR couples headersTimeout and bodyTimeout to this one knob. 600s is far
// past any user's patience; measured p99 is 81s and the longest legitimate
// stream 255s, and bodyTimeout bounds INTER-CHUNK idle rather than total
// duration, so 120s is comfortably safe for real traffic.
cfg.API_TIMEOUT_MS = 120000;

// Anchor: prefer a model observed to handle Claude Code's real payload (system
// prompt + tools). Small/fast models pass a bare probe but 400 on real traffic.
const anchor = resolveAnchor(built.picker, { anthropicOn, verifiedOrder });
const anchorModel = anchor.model;
// Printed because `via` is the half that goes wrong silently. `picker-head` means
// the preference list matched nothing and all six tiers are now pointed at
// whatever sorted first -- a config that works, serves badly, and looks normal.
console.log(`profile anchor: ${anchorModel} (via ${anchor.via})`);
// With Claude available, keep Claude Code's normal tiering rather than pointing
// every tier at one model.
const tiers = anthropicOn ? ANTHROPIC_TIERS : {
  model: anchorModel, opusModel: anchorModel, sonnetModel: anchorModel,
  haikuModel: anchorModel, smallFastModel: anchorModel, fableModel: anchorModel
};
const p = cfg.profile?.profiles?.find((x) => x.agent === "claude-code" && x.enabled !== false)
  ?? cfg.profile?.profiles?.find((x) => x.agent === "claude-code");
if (!p) throw new Error("no claude-code profile to configure (cfg.profile.profiles is empty or missing)");

// PROFILE MUTATION IS GATED ON applyProfile. Previously it ran unconditionally,
// so even --no-profile persisted `settingsFile: <real ~/.claude/settings.json>`
// plus enabled flags and all six model tiers into CCR's DB. CCR honours
// applyProfile:false for the immediate write, but any LATER CCR-initiated apply
// (UI action, restart, another tool) would then rewrite the real settings file
// from that persisted profile — a deferred replay of the original outage.
if (!has("--no-profile")) {
  p.enabled = true;
  p.scope = "global";
  p.surface = "cli";
  p.settingsFile = SETTINGS;
  p.env = { ...(p.env || {}), CCR_CLAUDE_CODE_AUTH_MODE: "api-key-helper" };
  // Never leave these empty: an empty profile.model leaves the profile-scoped key
  // with nothing to authorize, which fails as a bare "Invalid API key."
  // CCR clears every model-alias env var on each apply and only repopulates the
  // ones the profile sets. Setting only `model` leaves background/small-fast
  // traffic (title generation, quick classification) pointed at whatever CCR
  // derives on its own — observed as an unrecognized orcarouter/auto. Set them all.
  p.model = tiers.model;
  p.smallFastModel = tiers.smallFastModel;
  p.haikuModel = tiers.haikuModel;
  p.sonnetModel = tiers.sonnetModel;
  p.opusModel = tiers.opusModel;
  p.fableModel = tiers.fableModel;
  cfg.profile.enabled = true;
  cfg.profile.claudeCode = {
    ...cfg.profile.claudeCode, enabled: true, settingsFile: SETTINGS,
    model: tiers.model, smallFastModel: tiers.smallFastModel, haikuModel: tiers.haikuModel,
    sonnetModel: tiers.sonnetModel, opusModel: tiers.opusModel, fableModel: tiers.fableModel
  };
}

if (cfg.Router?.builtInRules?.["claude-code"]) cfg.Router.builtInRules["claude-code"].enabled = true;

if (guards) guards.assertPayloadIsolated(cfg, { allowProviders: true });

// ---- step 0: restore points, BEFORE anything is written -------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${SETTINGS}.uw-backup-${stamp}`;
// Unconditional, including --no-profile: that mode still persists profile state
// to CCR's DB, which a later CCR-initiated applyProfile can act on.
if (fs.existsSync(SETTINGS)) {
  fs.copyFileSync(SETTINGS, backup);
  console.log(`settings backup -> ${backup}`);
}

// WAL-safe snapshot of CCR's config DB. Only for the live install: the isolated
// harness is disposable, and its DB is deleted at teardown anyway.
let dbSnapshot = null;
if (target === "live") {
  dbSnapshot = snapshotConfigDb(liveConfigDb(), stamp);
  console.log(`config.sqlite snapshot -> ${dbSnapshot}`);
}

// --no-profile wires the gateway only: Providers[] are applied, but no profile
// is applied and NO settings.json is written. Used to bring the live gateway up
// without changing how any running Claude Code session routes.
const applyProfile = !has("--no-profile");

// Content-diff-and-skip. CCR restarts the gateway on a CONTENT diff of
// Providers/agent/virtualModelProfiles, not on "a write happened" — so an
// unchanged config can be re-applied for free, and a changed one restarts.
// Skipping when nothing changed is what makes frequent refresh cheap.
const afterFingerprint = restartRelevantFingerprint(cfg);
const willRestart = beforeFingerprint !== afterFingerprint;
console.log(willRestart
  ? "config changed -> CCR will restart the gateway"
  : "config identical -> no gateway restart expected");

// A restart interrupts in-flight requests in OTHER Claude Code sessions. This
// is the failure class behind the 2026-09-01 outage, so it is surfaced rather
// than assumed harmless.
if (willRestart && target === "live") {
  const others = otherClaudeSessions();
  if (others.length) {
    console.log(`WARNING: ${others.length} other Claude Code session(s) running (pid ${others.join(", ")}). ` +
      `The gateway restart may interrupt an in-flight request; a session already running keeps its ` +
      `loaded settings until it is restarted.`);
  }
}

const saved = await rpc("saveConfig", [cfg, { applyProfile }]);

// Health poll runs UNCONDITIONALLY, not only when a restart was predicted.
// The fingerprint predicts CCR's diff; it cannot be perfect (CCR also restarts
// on its own `configChanged`, e.g. when it regenerates a gateway key during
// applyProfile). When nothing restarted the first poll returns immediately, so
// this costs ~1ms — and it converts every possible mispredict from "hand back
// control mid-restart" (the original outage) into one extra HTTP request.
// EVERYTHING below runs inside the recovery try. saveConfig has already let CCR
// rewrite settings.json from the new profile, so from this point on any throw
// MUST restore it. A previous version put these throws above the try, where
// nothing caught them — the comment claimed they reached the catch and they did
// not, leaving settings half-applied against a gateway that never returned.
let writeVerified = false;
let noProfileDone = false;
try {
const gwPort = saved.gateway?.port;
if (!gwPort) throw new Error("saved config has no gateway.port — refusing to guess which port to health-check");
const up = await waitForGateway(gwPort);
if (!up) {
  // Not a warning: a gateway that never came back IS the outage.
  throw new Error(`gateway did not come back on ${gwPort} within 30s after saveConfig`);
}
console.log(`gateway healthy on ${gwPort}`);
// ---- step 1.5: drop CCR's duplicate plaintext gateway key ------------------
// Runs in BOTH modes, exactly once. --no-profile still touches the live gateway,
// so the duplicate key copy is just as real there. This block previously existed
// twice — once inside the --no-profile branch and once here — so that mode
// deleted the file and then reported "no stale WIF token file present" about the
// file it had just deleted.
if (target === "live") {
  const wif = deleteStaleWifToken(liveConfigDir(), p.id ?? "default-claude-code");
  console.log(wif
    ? `deleted stale WIF token copy -> ${path.basename(wif)}`
    : "no stale WIF token file present");
}

if (!applyProfile) {
  console.log(`saved: ${saved.Providers?.length ?? "?"} providers (gateway only; no profile applied, no settings written)`);
  console.log("keysync complete (--no-profile)");
  noProfileDone = true;
} else {
  // Only claim a profile.model when a profile was actually applied. Printing it
  // unconditionally put this line AFTER "keysync complete (--no-profile)",
  // naming an anchor that run had deliberately not written.
  console.log(`saved: ${saved.Providers?.length ?? "?"} providers, profile.model=${anchorModel}`);
}

if (!noProfileDone) {
  // ---- steps 2-4: re-read, merge, write ------------------------------------
  // MERGE into the file CCR just wrote — never construct it from scratch, or
  // every unrelated top-level key would be lost.
  const settingsRaw = fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, "");
  const settings = JSON.parse(settingsRaw);
  // An INDEPENDENT copy, parsed from the same text: `settings` is mutated in
  // place below, so holding a reference would compare the object against itself
  // and assert nothing. Taken here rather than from the step-0 backup because
  // CCR has legitimately rewritten apiKeyHelper and env by this point; this
  // scopes the check to keysync's own merge, which is what it can be strict about.
  const settingsBefore = JSON.parse(settingsRaw);
  const stripped = stripOneMSuffix(settings);
  if (stripped) console.log(`stripped [1m] suffix from ${stripped} third-party model env var(s)`);

  // `/model` persists the user's pick into this same file. Respect it while it
  // still points at a live row; clear it once stale so a pruned row cannot
  // leave them pinned to a model that no longer exists.
  // THE FULL BUILT SET, NOT THE WRITTEN OPTIONS -- verified, not assumed.
  // `settings.model` is where Claude Code persists a /model pick, and uwpick
  // (ctrl+g) drives exactly that: cc-contract.mjs's modelCommand emits
  // `/model <provider>/<id>` for ANY of the 44 providers.
  // The original reason is now FALSE and is recorded so it is not re-derived:
  // the write below used to narrow `modelPicker.options` to the Anthropic rows,
  // so checking the pin against that narrowed list would have cleared every
  // uwpick-made pin on the next run. Decision 4 was reversed, the two lists now
  // hold the same models in a different order, and the argument that outlives
  // the reversal is the one that was always the real one: the pin's question is
  // EXISTENCE, and `built.picker` is that definition regardless of what the
  // write below chooses to render.
  const pin = reconcileUserModelPin(settings, built.picker);
  if (pin.action === "kept") {
    console.log(`kept user's /model pin: ${pin.pinned}`);
    // The pin is user-owned so it is NOT overwritten — but a pin that is merely
    // valid can still disagree with the profile anchor indefinitely (a leftover
    // from a one-off /model switch becomes the permanent default for new
    // sessions). Surface the disagreement rather than silently honouring it.
    if (pin.pinned.toLowerCase() !== tiers.model.toLowerCase()) {
      // MEASURED (#74, #47), and the opposite of what this line said until
      // now: a NEW session defaults to `env.ANTHROPIC_MODEL` (the anchor),
      // not `settings.model` (the pin), while the anchor is set -- which
      // keysync always sets. The old text's remedy ("remove model to follow
      // the anchor") was doubly wrong: removing the pin does not change
      // which one new sessions follow, since the anchor already wins
      // regardless of whether a pin is present. Claude Code now says this
      // itself on every `/model`: "new sessions use that while it is set."
      // The pin is NOT inert, though -- switching `/model` inside an
      // ALREADY-RUNNING session does reach the wire immediately (confirmed
      // by upstream error identity a reseller-specific 403 could not have
      // come from the anchor).
      console.log(`  NOTE: that pin differs from the profile anchor (${tiers.model}).\n` +
        `  New sessions use the ANCHOR, not the pin, while ANTHROPIC_MODEL is set -- this is normal.\n` +
        `  The pin still applies immediately if you /model-switch within an already-running session.`);
    }
  }
  if (pin.action === "cleared") console.log(`cleared stale /model pin "${pin.pinned}" (no longer a picker row)`);

  // ---- the native picker carries every built row, Anthropic first ----------
  // Decision 4 reversed; see orderNativePickerOptions for the binary read behind
  // it. `options[]` is the only channel that can carry `behavesAs` for an
  // arbitrary number of models, so the rows the old scoping dropped were losing a
  // capability declaration rather than a menu slot.
  const anthropicRows = built.picker.filter((r) => r.model.startsWith(`${ANTHROPIC_RELAY.name}/`));
  const optionRows = orderNativePickerOptions(built.picker);
  // STRIPPED IN THE SAME COMMIT THAT ADDS THEM. `contextTokens` and `kind` are
  // UW-side fields -- one feeds the [1m] decision, the other the bucket
  // classifier and validate()'s V5 -- and Claude Code's row schema is exactly
  // {model, label?, description?, behavesAs?}. A commit that added `kind` to the
  // row without extending this strip would be a legitimate stopping point that
  // writes a fifth key into a four-key schema.
  settings.modelPicker = {
    options: optionRows.map(({ contextTokens, kind, ...row }) => row),
    replaceBuiltInOptions: true
  };
  // Tier 2, on the array that is actually about to be written -- not on
  // `optionRows`, which is pre-strip and would fail V8 on every clean build.
  assertOptionsComplete(built.picker, settings.modelPicker.options);
  console.log(`modelPicker: ${optionRows.length} row(s) written` +
    ` (${anthropicRows.length} Anthropic subscription row(s) first, then ` +
    `${optionRows.length - anthropicRows.length} third-party row(s) carrying behavesAs)`);
  // Temp + rename: a crash mid-write must not truncate the real settings file.
  atomicWriteJson(SETTINGS, settings);

  // ---- step 5: verify all three landed together ----------------------------
  const final = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, ""));
  // #7 / report 08 F4. The presence check below covers three fields; settings.json
  // carries twenty, and the ones whose loss has no visible symptom (permissions,
  // hooks, autoMode) are not among the three. REJECT rather than warn: this throw
  // lands in the catch above, which restores from the backup.
  assertSettingsInvariants(settingsBefore, final);
  const ok = final.apiKeyHelper && final.env?.ANTHROPIC_BASE_URL && final.modelPicker?.options?.length;
  if (!ok) throw new Error("post-write verification failed: apiKeyHelper / ANTHROPIC_BASE_URL / modelPicker not all present");
  console.log(`verified: apiKeyHelper + ANTHROPIC_BASE_URL=${final.env.ANTHROPIC_BASE_URL} + ` +
    `${final.modelPicker.options.length} picker rows`);

  console.log("keysync complete");
  writeVerified = true;
}
} catch (err) {
  // A working Providers[] with no picker is a safe partial state; a half-merged
  // settings.json is not. Restore it and leave both restore points in place.
  const restored = restoreSettings(backup, SETTINGS);
  console.error(`\nWRITE FAILED: ${err.message}`);
  // The two failure modes call for opposite responses, and the backup path is
  // named ONLY in the mode where it exists. The previous single message reported
  // "no backup at <path>" for both, sending an operator whose backup was intact
  // to a file it claimed was missing — and, when settings.json had not existed
  // at step 0, naming a backup path that was never written at all.
  if (restored.ok) {
    console.error(`settings.json RESTORED from ${backup}`);
  } else if (restored.reason === "restore-failed") {
    console.error(`settings.json NOT restored — the backup EXISTS and is your rollback point:\n` +
      `  ${backup}\n  ${restored.detail}\n` +
      `  Restore by hand: copy "${backup}" over "${SETTINGS}"`);
  } else {
    console.error(`settings.json NOT restored — no rollback point exists ` +
      `(${restored.detail}). Nothing was written by the restore attempt; ` +
      `inspect ${SETTINGS} manually`);
  }
  if (dbSnapshot) console.error(`CCR config restore point kept: ${dbSnapshot}\n  ${restoreConfigDbHint(dbSnapshot)}`);
  const capped = capFailedSnapshots(2);
  if (capped.length) console.error(`pruned ${capped.length} older failed-run snapshot(s)`);
  process.exit(1);
}

// Retention runs only after a verified-good write, and outside the try: a
// cleanup failure must never trigger the rollback of a write that succeeded.
if (writeVerified) {
  try {
    const removed = retainOnSuccess({ snapshot: dbSnapshot, settingsFile: SETTINGS });
    const { dated } = listSettingsBackups(SETTINGS);
    if (removed.length) {
      console.log(`cleaned ${removed.length} stale backup(s); kept the newest ${dated.length} settings backup(s)`);
    }
  } catch (e) {
    console.log(`WARNING: backup cleanup failed (${String(e.message).slice(0, 120)}); ` +
      `the write itself succeeded. Stale backups may remain in ${path.dirname(SETTINGS)}`);
  }
}

// ---- end entry-point guard (see isEntry above) ----
}

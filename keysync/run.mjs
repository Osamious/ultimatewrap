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
import {
  snapshotConfigDb, deleteStaleWifToken, retainOnSuccess, capFailedSnapshots,
  restoreSettings, restoreConfigDbHint, liveConfigDir, liveConfigDb,
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
 *   the caller). null means "could not be determined" and the guard falls back
 *   to the old, broader RESERVED-only match -- see the narrowing comment below.
 * @param {Set<string>|null} [opts.relayOwned=null]  the CURATED ids the relay
 *   vouches for. See the vouching block in the classification loop -- this is
 *   the parameter that keeps routing auto-add from disarming the guard. null
 *   means "no distinction", i.e. the pre-auto-add behaviour, which is what every
 *   caller that predates auto-add still wants.
 * @param {Set<string>|null} [opts.relayRouting=null]  what the relay serves or
 *   WOULD serve if started; used only to keep the remedy wording honest.
 *   Defaults to the static ANTHROPIC_RELAY.routing.
 * @returns {{hijackable: object[], shadowed: object[], fatal: boolean, message: string}}
 */
export function checkBareCollisions(providers, {
  relay = ANTHROPIC_RELAY.name, allowBare = false, realIds = null,
  relayOwned = null, relayRouting = null,
} = {}) {
  const byBare = new Map();
  for (const p of providers ?? []) {
    // CCR's own gate. `providerModelMatches` checks the provider is enabled before
    // it looks at any id, so a disabled co-owner does not count towards ownership
    // there -- and counting it here would read two owners as ambiguous while CCR
    // sees exactly one match and binds. Always true in today's generated config,
    // so this is a latent divergence rather than a live one.
    if (p.enabled === false) continue;
    for (const m of p.models ?? []) {
      // Accepts both shapes deliberately: the built config carries `models` as a
      // string[], while the guard's own tests inject `{id}` objects.
      const id = String(m?.id ?? m ?? "");
      // An id that already carries a `/` is vendor-prefixed and is not what
      // Claude Code sends for a built-in row, so it cannot be the stage-4 match.
      // tokenharbor lists exactly this shape; treating it as hijackable would
      // block a live reseller for a threat that cannot reach it.
      if (id.includes("/")) continue;
      // RESERVED is imported, not re-typed. The previous inline regex was
      // /^(claude|opus|sonnet|haiku)([-\d]|$)/ -- it omitted `fable` entirely and
      // its boundary class was narrower than the denylist's, so `sonnet.1` and
      // `haiku_2` were reserved by one definition and invisible to the other.
      if (!RESERVED.test(id)) continue;
      // NARROWING (BACKLOG item 2). RESERVED asks "is this Claude-SHAPED"; the
      // guard's actual concern is "could Claude Code send this bare and bind it
      // to the wrong host", which only a REAL Anthropic id can ever trigger --
      // Claude Code never emits a name Anthropic has not published. Without
      // this, `claude-opus-5-thinking` (a reseller invention; extended thinking
      // is a request parameter, not a model) reads as hijackable at tabiai and
      // gorouter for a threat that cannot reach it.
      //
      // realIds === null means "could not be determined" (relay unreachable,
      // no cache) -- fall back to the OLD broad behaviour rather than either
      // extreme. Silently trusting every RESERVED id when uncertain would
      // under-flag; silently rejecting all of them would refuse the escape
      // hatch this guard exists to preserve. RESERVED alone, unchanged, is what
      // shipped before this task and is the safe default when unverifiable.
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
      if (realIds !== null && !ANTHROPIC_ALIASES.includes(id) && !realIds.has(id)) continue;
      if (!byBare.has(id)) byBare.set(id, new Set());
      byBare.get(id).add(p.name);
    }
  }

  // VOUCHING vs MERELY ROUTING. This distinction is the whole of the fix for a
  // HIGH regression this guard shipped with, and it is worth stating plainly
  // because the bug was invisible in the diff of this function -- which did not
  // change at all.
  //
  // Routing auto-add (a live /v1/models id joins Providers[].models on its own)
  // meant the relay came to own every id `realIds` even considers, since both
  // reduce to `liveCatalog.ids u ANTHROPIC_FULL`. The test below is
  // `owners.size === 1 && !owners.has(relay)`, so with the relay owning
  // everything the FATAL path became STRUCTURALLY UNREACHABLE. Measured against
  // live data: `claude-opus-4-8` is served by the relay and also listed by
  // tabiai and gorouter, and it went from FATAL to a silent informational note.
  //
  // So the relay's ownership counts as SAFETY only where a human curated the id.
  // Everywhere else the relay is stripped from the owner set before classifying:
  // our own config auto-adding a name must never be what makes a reseller's
  // sole claim on it look acceptable. Stripping cannot manufacture a finding
  // either -- if the relay was the ONLY claimant, nothing remains to protect
  // against and the id is simply dropped.
  const vouched = (id) => relayOwned === null || relayOwned.has(id);
  const hijackable = [], shadowed = [];
  for (const [id, owners] of byBare) {
    const relayRoutes = owners.has(relay);
    const effective = vouched(id) ? owners : new Set([...owners].filter((o) => o !== relay));
    // Only the relay serves this id -- nothing to protect against. Redundant
    // against the two branches below as they are written today (size 0 matches
    // neither), and MUTATION-CHECKED as such: removing it changes no test.
    // Kept because it states the rule, and because an edit that turns the pair
    // below into an if/else chain would otherwise silently start classifying
    // an empty owner set.
    if (effective.size === 0) continue;
    if (effective.size === 1 && !effective.has(relay)) {
      hijackable.push({ id, owner: [...effective][0], relayRoutes });
    } else if (effective.size > 1) {
      // The TRUE owner list is reported, relay included. Classification must not
      // count the relay here, but a message that hides a real co-owner would be
      // describing a config the operator does not have.
      shadowed.push({ id, owners: [...owners].sort() });
    }
  }
  hijackable.sort((a, b) => a.id.localeCompare(b.id));
  shadowed.sort((a, b) => a.id.localeCompare(b.id));

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
    const routedNotVouched = hijackable.filter((h) => h.relayRoutes && !vouched(h.id));
    const remedy = relayHelps.length === hijackable.length
      ? `start the Anthropic relay so it co-owns these ids and they become ambiguous, or `
      : relayHelps.length
        ? `start the Anthropic relay, which co-owns ${relayHelps.map((h) => h.id).join(", ")} ` +
          `but not the rest, and/or `
        : routedNotVouched.length === hijackable.length
          ? `the relay already routes ${routedNotVouched.length === 1 ? "this id" : "these ids"} but ` +
            `${routedNotVouched.length === 1 ? "it is" : "they are"} not in the reviewed set ` +
            `(ANTHROPIC_FULL), so that ownership is not treated as vouching for ` +
            `${routedNotVouched.length === 1 ? "it" : "them"}; review and add ` +
            `${routedNotVouched.map((h) => h.id).join(", ")} to ANTHROPIC_FULL in keysync.mjs, or `
          : `the relay does not serve ${hijackable.length === 1 ? "this id" : "these ids"}, ` +
            `so co-ownership cannot resolve ${hijackable.length === 1 ? "it" : "them"}; `;
    message =
      `SECURITY: ${hijackable.length} bare Claude-shaped model id(s) have a single ` +
      `owner this config does not vouch for:\n` +
      hijackable.map((h) => `  ${h.id}  <-  sole owner: ${h.owner}` +
        (h.relayRoutes ? `  (the relay routes this id but does not curate it)` : "")).join("\n") +
      `\nCCR's resolve() binds Claude Code's built-in rows to a uniquely-owned bare ` +
      `id, so the full system prompt, tool definitions and file contents would go ` +
      `to that host.\n` +
      `Remedy: ${remedy}re-run with --allow-bare-claude-names to accept this routing ` +
      `deliberately.`;
  } else if (shadowed.length) {
    message =
      `note: bare Claude-shaped id(s) with more than one owner -- ` +
      `${shadowed.map((s) => `${s.id} (${s.owners.join(", ")})`).join("; ")}. ` +
      `resolve() returns undefined on an ambiguous match, so this is a clean ` +
      `failure, not a misroute.`;
  } else {
    message = "no bare Claude-shaped collisions";
  }

  return { hijackable, shadowed, fatal: hijackable.length > 0 && !allowBare, message };
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
 * The one invariant that keeps `checkBareCollisions`' FATAL path reachable.
 *
 * `relayOwned` is what the relay's ownership VOUCHES for and `routingIds` is
 * what it merely ROUTES. Auto-add grows routing with every live id; nothing may
 * ever grow the vouched set. If the two are reunified, every id the guard
 * considers becomes vouched, `effective` keeps the relay in every owner set, and
 * the sole-owner branch that reports a hijack can no longer be entered. That is
 * not a hypothetical -- it is the HIGH regression this branch shipped and fixed,
 * and it was invisible in the diff of the guard itself, which did not change.
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

const built = buildProviders(chosen, providers, catalog, dry ? () => "dry-run-placeholder" : readKey);
for (const n of built.notes) console.log(`  note: ${n}`);

// --verified-only: keep only rows a live probe confirmed serve completions. A
// picker row that 404s is worse than an absent one — the user selects it, it
// fails, and nothing explains why.
// Snapshot before --verified-only mutates `built` in place.
const builtAll = { picker: [...built.picker] };

let verifiedOrder = null;
if (has("--verified-only")) {
  const vf = "C:\\Users\\osami\\.uw\\keysync\\verified-rows.json";
  if (!fs.existsSync(vf)) { console.error(`--verified-only needs ${vf}; run verify-prune.mjs first`); process.exit(2); }
  const verified = JSON.parse(fs.readFileSync(vf, "utf8"));
  const ok = new Set(verified.working);
  // Fastest-first, so the profile anchor is a responsive model.
  verifiedOrder = verified.results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms).map((r) => r.model);
  built.picker = built.picker.filter((r) => ok.has(r.model));
  built.providers = built.providers
    .map((p) => ({ ...p, models: p.models.filter((m) => ok.has(`${p.name}/${m}`)) }))
    .filter((p) => p.models.length);
  console.log(`--verified-only: ${built.providers.length} providers / ${built.picker.length} rows survive`);
  // The count check below is a tautology under --verified-only, so it cannot
  // catch an empty result. Without this floor, zero rows would pass validation
  // and then crash when anchoring the profile.
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
// must account for it. Without this the primary path (live, Claude available)
// fails validation outright: 45 !== 44. Only --verified-only got through, and
// only because its own count check is a tautology (see the floor guard above).
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

const problems = validate(built, has("--verified-only")
  ? built.providers.length
  : EXPECTED_PROVIDERS + (anthropicOn ? 1 : 0));
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
  const collisions = checkBareCollisions(built.providers,
    { allowBare: has("--allow-bare-claude-names"), realIds, relayOwned, relayRouting: routingIds });
  if (collisions.hijackable.length || collisions.shadowed.length) {
    console.warn(collisions.message);
  }
  // Fatal BEFORE any write, and before --dry returns, so a dry run reports the
  // same verdict a live run would enforce. `allowBare` silences the exit, never
  // the finding: the warning above still prints.
  if (collisions.fatal) process.exit(1);
}

if (dry) {
  console.log("\n--dry: nothing written.");
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
      // lock is held, after which every future run refuses to start.
      signal: AbortSignal.timeout(30000)
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
const rowExists = (m) => built.picker.some((r) => r.model === m);
const anchorModel = anthropicOn
  ? ANTHROPIC_TIERS.model
  : (ANCHOR_PREFERENCE.map((pref) => built.picker.find((r) =>
      (pref.endsWith("/") ? r.model.startsWith(pref) : r.model === pref))?.model).find(Boolean)
     ?? verifiedOrder?.find(rowExists)
     ?? built.picker[0].model);
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
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, ""));
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
      console.log(`  NOTE: that pin differs from the profile anchor (${tiers.model}).\n` +
        `  New sessions will default to the pin. Remove "model" from settings.json to follow the anchor.`);
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
  console.error(restored
    ? `settings.json RESTORED from ${backup}`
    : `settings.json NOT restored (no backup at ${backup}) — inspect it manually`);
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
    if (removed.length) console.log(`cleaned ${removed.length} stale backup(s); kept the newest settings backup`);
  } catch (e) {
    console.log(`WARNING: backup cleanup failed (${String(e.message).slice(0, 120)}); ` +
      `the write itself succeeded. Stale backups may remain in ${path.dirname(SETTINGS)}`);
  }
}

// ---- end entry-point guard (see isEntry above) ----
}

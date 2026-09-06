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

export const SLOT = path.join(os.homedir(), ".uw", "state", "slot.json");

// The catalogue's real pricing path. keysync's own inferTier reads
// `pricing.inputPerMillion`, which does not exist in this schema -- it returns
// "unknown" for all 4,298 models, which is why its free-tier sort is a no-op.
//
// WHICH OFFER. `offers[]` is a merged array and each element carries its own
// `provider` field; a merged record can hold up to 16 offers, most of them
// pricing the model at a DIFFERENT host. Folding all of them answers "is this
// free anywhere", which is the wrong question. Taking offers[0] answers "is the
// first element of an arbitrarily ordered array free", which is also the wrong
// question and is the one the previous draft implemented. The right question is
// "is it free on MY key", so match the offer to the provider the key belongs to.
// Every call site has that name already: buildFrom has `cred.provider` and
// buildProviders has `reg.provider`.
//
// When no offer matches, return null -- blank -- rather than falling back to
// offer 0. A FREE badge on a model that bills the user's key is precisely the
// lie Principle 1 exists to prevent, and it is also what sorts a mispriced entry
// to rank 0 on the routing path in buildProviders.
export function priceOf(entry, providerName = null) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return null;
  const usable = (o) => {
    const p = o?.per1MTokens;
    return p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output));
  };
  const take = (o) => ({ in: Number(o.per1MTokens.input), out: Number(o.per1MTokens.output) });

  if (providerName) {
    const mine = offers.find((o) => o?.provider === providerName && usable(o));
    return mine ? take(mine) : null;
  }
  // No provider given: only safe when there is exactly one usable offer, because
  // then "the first" and "mine" cannot disagree.
  const usables = offers.filter(usable);
  return usables.length === 1 ? take(usables[0]) : null;
}

// GUARD G1: a zero *token* price on a model whose output is not text means it is
// billed per image/second in another unit. Blank, never "free".
export function isTextOut(entry) {
  const out = entry?.modalities?.output;
  return !Array.isArray(out) || out.length === 0 || out.includes("text");
}

// The whole badge set. Nothing else may ever be rendered.
//   FREE   price 0 AND a curated recurring grant cadence  (the governing rule)
//   FREE?  price 0, cadence unknown -- honest, and this will be the common case
//   PLAN   subscription-covered: marginal price 0 because a plan was paid for
//   PAID   any non-zero token price
//   ""     no evidence, guard G1, or price 0 with a ONE-TIME grant
//
// The last case deserves its own sentence: a one-time signup wallet is not free
// under the governing definition, and it is not paid either, because the
// marginal price really is zero. Blank is the only honest rendering.
export function badgeOf(entry, { cadence = "", planCovered = false, providerName = null } = {}) {
  if (planCovered) return "PLAN";
  const p = priceOf(entry, providerName);
  if (!p) return "";
  if (p.in === 0 && p.out === 0) {
    if (!isTextOut(entry)) return "";        // G1
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

const FREEISH = new Set(["FREE", "FREE?"]);

/**
 * @param {object}   i
 * @param {Array}    i.chosen      one credential per provider
 * @param {Map}      i.providers   provider name -> profile
 * @param {object}   i.catalog     {byProvider: Map, generatedAt: string}
 * @param {object}  [i.relay]      {provider, models[]} injected, not a vault credential
 * @param {Function}[i.cadenceOf]  provider name -> {cadence?, planCovered?}
 */
export function buildFrom({ chosen, providers, catalog, relay,
                            cadenceOf = () => ({}),
                            routableOf = () => null }) {
  const rows = [];
  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const opts = { ...(cadenceOf(cred.provider) ?? {}), providerName: cred.provider };
    const entries = catalog.byProvider.get(cred.provider) ?? [];
    // warn:false -- this is the DISPLAY path. buildFrom runs inside the picker,
    // which owns a full-screen frame in the alternate screen, and a console write
    // lands in the middle of one. The routing path reports the same rejections
    // with an ordinary stdout, and that is the copy that matters.
    const { kept } = admitRemoteModels(cred.provider, entries.map((e) => e.model),
                                       { warn: false });
    const keptSet = new Set(kept);
    const models = [];
    for (const e of entries) {
      if (!keptSet.has(e.model)) continue;
      const p = priceOf(e, cred.provider);
      models.push({
        id: e.model, ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e, opts),
        ...capsOf(e),
        // `outputKind`, not `kind`. pick-state.mjs already spends `item.kind` on
        // "model" | "provider" | "pinned", so `item.model.kind` would put two
        // unrelated vocabularies into one expression -- and `routable` sits right
        // beside this as a second per-model status field. keysync's own picker row
        // carries the same value under the bare name `kind`, where nothing competes
        // for it.
        outputKind: K.outputKind(e),
        // Q1.3: a value, not a promise. null means nobody checked and does not dim.
        routable: routableOf(`${cred.provider}/${e.model}`),
      });
    }
    // testModel leads: measured, catalogue-first dropped the live pass rate to 4/44.
    // Guarded for the same reason as the routing path: an absent testModel is
    // ordinary configuration, not a rejected advertisement.
    const tm = prof.testModel
      ? (admitRemoteModels(cred.provider, [prof.testModel], { warn: false }).kept[0] ?? null)
      : null;
    if (tm && !models.some((m) => m.id === tm)) {
      // null, not false. This row exists BECAUSE the catalogue has no entry for the
      // model -- the `!models.some(...)` guard above is the proof -- so `false` is a
      // claim about a measurement that was never taken. 38 of the 83 routable rows
      // reach the picker this way, which made it the largest single source of the
      // coercion capsOf removes.
      models.unshift({ id: tm, ctx: null, pin: null, pout: null,
                       badge: opts.planCovered ? "PLAN" : "",
                       tools: null, vision: null, reason: null, outputKind: null,
                       routable: routableOf(`${cred.provider}/${tm}`) });
    }
    const priced = models.some((m) => m.badge !== "");
    rows.push({
      keyId: sanitizeDisplay(cred.id, 30), provider: cred.provider, models,
      // NULLABLE: "0 free" is a measurement, "no price data" is the absence of one.
      free: priced ? models.filter((m) => FREEISH.has(m.badge)).length : null,
      planCount: models.filter((m) => m.badge === "PLAN").length,
      health: healthOf(prof),
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
      routable: routableOf(`${relay.provider}/${id}`) }));
    rows.push({
      keyId: "relay.anthropic.subscription", provider: relay.provider, models,
      free: null, planCount: models.length, health: "ok",
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
export function build({ routableOf, routableAsOf = null } = {}) {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  return {
    ...buildFrom({
      chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY, routableOf,
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

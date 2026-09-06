// Model-id admission, and the shape predicate the collision guard is built from.
//
// REVISED 2026-09-03 under Rule 2 (plan Constraint 29). This module used to
// reject Claude-shaped names from every provider but our own relay. It no longer
// does, and the reason is a fact about CCR rather than a change of appetite:
//
//   `providerModelMatches` (dist/main/cli.js ~998924) iterates raw
//   Providers[].models[] ids behind only a PROVIDER-level enabled gate -- there
//   is no per-model opt-out -- and `resolve()` binds on EXACTLY ONE match,
//   returning undefined when more than one provider offers the id.
//
// So the hijack needs SOLE OWNERSHIP OF A BARE id. `tabiai/claude-opus-5` is
// never reachable by that path, because stage-4 matching is on the bare form.
// Rejecting it therefore bought no safety and cost two live providers -- tabiai
// and gorouter, both verified by keyed probe to serve claude-opus-5 and
// claude-opus-5-thinking -- every model they sell.
//
// Ownership is a whole-config property. This function sees one provider's list,
// so it structurally cannot evaluate it. The F1 control moved to
// `keysync/run.mjs:checkBareCollisions`, which can, and which is fatal.
//
// WHAT THIS MODULE STILL ENFORCES, on every path that calls it:
//   * `admitId` -- escape sequences, C0/C1 controls, invisibles, `..`,
//     backslashes, over-length ids, `@cf/` scoping. Unchanged, and it never
//     tested Claude names, so nothing here weakens it.
//   * `UW_ALIAS` -- `uw/` is OUR namespace. A provider claiming `uw/fast` is
//     squatting it. That is not reselling someone else's model and rule 2 does
//     not cover it. Unchanged. See the note at the definition: CCR reaches our
//     exact aliases as `Fusion/uw/...`, so this guard currently covers a shape
//     nothing routes on -- recorded, not resolved by guessing.
//
// WHAT IT EXPORTS FOR OTHERS:
//   * `RESERVED` / `isReserved` -- the single definition of "Claude-shaped",
//     consumed by `checkBareCollisions` and by the relay's alias resolver. Two
//     regexes for one concept is how they drift; there is one.
//
// WHERE IT IS CALLED:
//   1. keysync.mjs:buildProviders  -- routing. Sanitisation and `uw/`.
//   2. menu/catalog.mjs:buildFrom  -- display. Same two rules.
// A third entry named a module in a planned `refresh/` tree that was never
// built (Task B6, plans/phase6-menu-and-catalogue.md:289), stated in the present
// tense as if it already called this. Removed 2026-09-06 for the same reason the
// sibling claim in catalog.mjs was: a list of callers that names one nobody wrote
// is read as evidence a wire exists, and that is precisely how the routability
// wire stayed missing through two design reviews. When the ingest path is built
// it can add its own line.
//
// A large share of the 44 providers are small aggregator hosts with no
// meaningful security assurance -- routllm.pro, seekai.cc, tabitoken.com,
// ineed.web.id, gorouter.app, teamorouter.com, tokenharbor.ai, router.bynara.id,
// apihub.agnes-ai.com, commandcode.ai, zenmux.ai, kilo.ai. That is a reason to
// sanitise every id and to show the answering hostname on every row -- not a
// reason to refuse the models they sell.

import { admitId } from "./sanitize.mjs";

// Anchored. The trailing group means "opus" and "opus-4-8" match while
// "opusculum" and "hakuna" do not -- the boundary must be a separator, a digit,
// a slash, or end-of-string.
export const RESERVED = /^(claude|opus|sonnet|haiku|fable|anthropic)([-._\d\/]|$)/i;

// UW's own alias namespace.
//
// VERIFIED MECHANISM, 2026-09-03, team lead, read from the CCR bundle. This is
// no longer an open question, and the answer is worse than one:
//
//   Sd() force-prefixes exact aliases --
//     for (let o of n.match?.exactAliases ?? []) {
//       let i = o.trim();
//       i && t.length > 0 && r.push(
//         i.toLowerCase().startsWith("fusion/") ? i : `Fusion/${i}`);
//     }
//   and the registry is keyed from that output --
//     this.gatewayModels = new Map(Sd(t).map(r => [r.toLowerCase(), r]));
//   with stage 3 doing --
//     this.gatewayModels.get(n.toLowerCase());
//
// So an exact alias `uw/fast` is reachable ONLY as `Fusion/uw/fast`. A selector
// `uw/fast` misses stage 2 (there is no provider named `uw`), misses stage 3
// (the key is `fusion/uw/fast`), and falls through to bare matching, where no
// model carries that literal id.
//
// TWO CONSEQUENCES, both to be resolved by whoever owns this constant (Task
// A5.1), and NEITHER to be resolved by guessing:
//
//   1. If UW's aliases are declared as `exactAliases`, THEY DO NOT ROUTE under
//      `uw/...` at all. Any plan text asserting otherwise is wrong.
//   2. `/^uw\//i` therefore guards a namespace nothing routes on -- real
//      defence-in-depth against a shadowing that cannot presently occur, while
//      the shape that CAN be shadowed is `Fusion/uw/...`.
//
// The two options: declare the aliases so they surface as `Fusion/uw/...` and
// guard that shape instead; or use `virtualModelProfiles` and confirm which
// stage those match at. The security reviewer's claim that virtualModelProfiles
// match at stage 3 ahead of any provider is CONSISTENT with what was read, but
// how they are keyed has NOT been separately verified -- do not build on it
// until it is.
//
// Keeping the guard as-is meanwhile costs nothing and is still correct as a
// namespace-squatting refusal, which is why this is a recorded decision rather
// than a blocker.
export const UW_ALIAS = /^uw\//i;

// "Claude-shaped or ours". A SHAPE PREDICATE, not an admission rule -- nothing
// is rejected for satisfying it. `checkBareCollisions` and the relay's alias
// resolver both read it, which is why it is exported.
export const isReserved = (id) => RESERVED.test(String(id ?? "")) || UW_ALIAS.test(String(id ?? ""));

/**
 * @param {string}   providerName
 * @param {string[]} ids
 * @param {object}  [opts]
 * @param {string}  [opts.trusted="anthropic"] our own local relay, exempt from
 *                  the `uw/` check. It is no longer an exemption from anything
 *                  Anthropic-shaped, because nothing Anthropic-shaped is refused.
 * @param {boolean} [opts.warn=true] emit the SECURITY line. The DISPLAY path
 *                  passes false: buildFrom runs inside the picker, which draws a
 *                  full-screen frame into the alternate screen, and a console
 *                  write mid-frame corrupts the frame it lands in. The same
 *                  rejections are reported by the routing path, which is the one
 *                  that matters and which runs with an ordinary stdout. Zero
 *                  rejections across all 4,298 bundled ids today, so this is
 *                  latent -- but it goes live with Task B6, where discovery
 *                  returns raw provider strings instead of a curated bundle.
 * @returns {{kept: string[], rejected: string[]}}
 */
export function admitRemoteModels(providerName, ids, { trusted = "anthropic", warn = true } = {}) {
  const kept = [], rejected = [];
  const exempt = providerName === trusted;
  for (const raw of ids ?? []) {
    const id = admitId(raw);
    if (!id) { rejected.push(String(raw)); continue; }
    // RULE 2. This line was `if (!exempt && isReserved(id))`. `isReserved` is
    // still exported and still true for Claude names -- it is now consumed by
    // the collision guard, which can see the ownership this loop cannot. Do not
    // reinstate it here: doing so drops every model tabiai and gorouter sell.
    if (!exempt && UW_ALIAS.test(id)) { rejected.push(id); continue; }
    kept.push(id);
  }
  if (warn && rejected.length) {
    console.warn(`SECURITY: provider "${providerName}" advertised ${rejected.length} ` +
      `rejected model name(s): ${rejected.slice(0, 10).join(", ")}`);
  }
  return { kept, rejected };
}

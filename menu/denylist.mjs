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

import { admitId, classifyRefusal, sanitizeDisplay } from "./sanitize.mjs";

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

// THE ONLY CONSTRUCTOR OF A REJECTION, so the sanitised form is the only form
// that exists past this point (#52). There is deliberately no second field
// holding the raw string "for debugging": that is not a smaller version of the
// egress, it IS the egress, relocated.
//
// `Math.max(0, ...)` is not defensive padding. NFC can LENGTHEN a string in the
// composition-exclusion cases (U+0958 and its family decompose to two code
// points and do not recompose), so the delta is genuinely signed, and a negative
// "removed" count in a security list would read as nonsense.
const refusal = (raw, reason) => {
  const id = sanitizeDisplay(raw);
  return { id, reason, removed: Math.max(0, [...String(raw ?? "")].length - [...id].length) };
};

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
 * @returns {{kept: string[], rejected: {id: string, reason: string, removed: number}[]}}
 *                  `rejected` holds the DISPLAY-SAFE form of each refused name,
 *                  never the raw one, plus the reason code (#51) and `removed`,
 *                  the number of code points the raw string had that the display
 *                  form does not. `removed` counts stripping, NFC composition and
 *                  the 80-code-point cap together -- all three are ways what was
 *                  advertised differs from what is shown, which is the one thing
 *                  a reader of the withheld list needs told.
 *
 * THE BOUNDARY OF THIS GUARANTEE, stated because the claim is what makes it
 * dangerous (#24). One safe representation means this path cannot acquire a new
 * hole when someone adds the next consumer -- and that is true of THIS path
 * only. `keysync/anthropic-catalog.mjs` feeds relay ids into `deriveAnthropicSets`
 * -> `Providers[].models` without calling `admitId` or `admitRemoteModels` at
 * all. That is #24, it is not covered here, and the risk this note exists to
 * defuse is that a completeness framing makes the second path harder to notice
 * afterwards than it is today.
 */
export function admitRemoteModels(providerName, ids, { trusted = "anthropic", warn = true } = {}) {
  const kept = [], rejected = [];
  const exempt = providerName === trusted;
  for (const raw of ids ?? []) {
    const id = admitId(raw);
    // SANITISED AT THE PRODUCER, NOT AT THE CONSUMER (#52). The obvious place
    // for this is the console.warn below, and it is the wrong place: it leaves
    // the raw string sitting in `rejected` for any future reader to print, and
    // the whole finding is that a refused name reaches a terminal.
    //
    // WHY THIS CHANNEL IS NOW HOSTILE-ONLY. Before the denylist inversion, a
    // rejection was dominated by benign real ids the allowlist happened to
    // refuse -- 16 of them, measured, mostly leading-`~` aliases. After the
    // inversion an id can only be refused by one of the named rules in
    // `admitId`, and three of those -- ESC_SEQ, CTRL, INVISIBLE -- ARE the
    // terminal-attack classes. So "this string was rejected" went from weak
    // evidence of hostility to strong evidence of it, and it is printed
    // verbatim on ordinary stderr by the routing path in `keysync.mjs`.
    //
    // MEASURED: `admitRemoteModels("tabiai", ["evil\x1b[2J\x1b]52;c;aGk=\x07"])`
    // put 2 ESC and 1 BEL into the warn line, and `\x1b]52;c;<base64>\x07` is
    // OSC 52 -- a clipboard write. A provider listing could put content into
    // the operator's clipboard THROUGH the warning that refused it.
    //
    // Both branches go through `refusal`, so the invariant is a property of the
    // array rather than of the caller's discipline. `sanitizeDisplay`'s
    // 80-code-point cap is accepted here: a rejected name is by definition not a
    // routing selector, so its exact length is not load-bearing, and an
    // unbounded provider string in a security line is itself a way to flood a
    // terminal. What the cap costs is now stated rather than swallowed -- it is
    // part of `removed`.
    if (!id) { rejected.push(refusal(raw, classifyRefusal(raw))); continue; }
    // RULE 2. This line was `if (!exempt && isReserved(id))`. `isReserved` is
    // still exported and still true for Claude names -- it is now consumed by
    // the collision guard, which can see the ownership this loop cannot. Do not
    // reinstate it here: doing so drops every model tabiai and gorouter sell.
    // `uw-namespace` is the one reason `classifyRefusal` cannot produce: this id
    // PASSED `admitId`, and whether it is refused depends on `providerName`,
    // which sanitize.mjs never sees. Named here, at the branch that owns it.
    if (!exempt && UW_ALIAS.test(id)) { rejected.push(refusal(id, "uw-namespace")); continue; }
    kept.push(id);
  }
  if (warn && rejected.length) {
    console.warn(`SECURITY: provider "${providerName}" advertised ${rejected.length} ` +
      `rejected model name(s): ${rejected.slice(0, 10).map((r) => r.id).join(", ")}`);
  }
  return { kept, rejected };
}

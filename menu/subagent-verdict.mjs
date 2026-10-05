// ONE pure verdict for the subagent policy (plan 7.2 item 1): `show`, `status`, `set`, `undo`, the doctor and the picker read the same function, so
// they can never disagree (the same discipline as the shared funnel). No I/O and no clock (`now` is an input). It reads the code table
// (`menu/subagent-codes.mjs`, pure data) for the plain wording and the fix command of a degraded state.
//
//   verdict(owner, compiled, status, flag, now) -> { state, code, label, sentence, fix, headline, savedSentence }
//   states: OFF, SAVED-NOT-COMPILED, NOT-WIRED, WAITING, IDLE, SHADOW, ENFORCING, PAUSED, DEGRADED (with `code`)
// `owner` is the loaded owner file or null; `compiled` the compiled file or null; `status` the merged router status or null; `flag` the content of
// shadow.flag (a string), `true` when it exists with unknown content, or falsy when absent; `now` is epoch milliseconds.
//
// A router only writes its status while Claude Code runs, so a quiet router is not a broken one:
//   NOT-WIRED  no router has ever reported, and the compiled copy is older than NOT_WIRED_MS (a router that was going to pick it up would have by now)
//   WAITING    saved and compiled; the router has not reported THIS compiled copy yet (a fresh save, or a worker still on the older copy)
//   IDLE       the router reported this exact compiled copy earlier and has been silent for over SILENT_MS: nothing is wrong unless Claude Code ran since
import { CLI, codeRow } from "./subagent-codes.mjs";

export const STATES = Object.freeze(["OFF", "SAVED-NOT-COMPILED", "NOT-WIRED", "WAITING", "IDLE", "SHADOW", "ENFORCING", "PAUSED", "DEGRADED"]);
/** A router that has reported this compiled copy and then been silent for this long is IDLE. */
export const SILENT_MS = 24 * 3600 * 1000;
/** With no status at all, a compiled copy younger than this is WAITING (the router has had no request yet); older is NOT-WIRED. */
export const NOT_WIRED_MS = 10 * 60 * 1000;

const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
// router-written text is untrusted: control and bidi-control characters become "?" before it can reach a terminal
const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, max);
const ms = (v) => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : 0; };
const agoText = (d) => { const s = Math.max(0, Math.round(d / 1000)); return s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`; };

/** True when the saved owner choices differ from the compiled copy (the router would still serve the old compiled behaviour). */
export function ownerDiffers(owner, compiled) {
  const co = compiled?.owner;
  if (!isObj(co)) return true;
  // a rebuild that kept the router in shadow because an enforce precondition is unmet says so itself (`gate`): not "stale"
  const gated = compiled.gate?.code === "CLASSIFIER_UNMEASURED" && owner.enforcement === "enforce" && co.enforcement === "shadow";
  return owner.mode !== co.mode || owner.source !== co.source || owner.ctx !== co.ctx || owner.freeScope !== co.freeScope
    || (owner.banded !== false) !== (co.banded !== false) || (!gated && owner.enforcement !== co.enforcement);
}

const out = (state, code, sentence, fix, headline = null, extra = {}) => ({ state, code, label: code ? `${state}(${code})` : state, sentence, fix, headline, ...extra });

const SHADOW_SENTENCE = "logs what it would do and changes nothing; subagents still run exactly as they ask.";
const ENFORCING_SENTENCE = "subagents run on the models the policy picks; helper calls are left alone.";
const SAVED_SENTENCE = "saved and compiled; the router uses it from its next request.";

export function verdict(owner, compiled, status, flag, now) {
  const st = isObj(status) ? status : null;
  if (flag) {
    const auto = typeof flag === "string" ? /^auto:([A-Z_]{1,40}):(\S{1,40})/.exec(flag.trim()) : null;
    if (auto) {
      const row = codeRow("AUTO_ROLLBACK");
      return out("DEGRADED", "AUTO_ROLLBACK", `The router paused the policy by itself (${clean(auto[1], 40)} at ${clean(auto[2], 40)}), so every subagent runs exactly as it asked. Your toggles are kept.`, row.fix);
    }
    return out("PAUSED", null, "Subagents run exactly as they asked, from the next request. Your toggles are kept.", `${CLI} resume --live yes`);
  }
  if (!isObj(owner)) return out("OFF", null, "No subagent policy is saved, so every subagent runs exactly the model it asks for.", `${CLI} preset`);
  if (!isObj(compiled) || ownerDiffers(owner, compiled)) {
    return out("SAVED-NOT-COMPILED", null, "Your choices are saved but not applied: the router reads only the compiled copy, which is missing or out of date.", `${CLI} rebuild --live yes`);
  }
  if (compiled.empty === true) {
    const row = codeRow("EMPTY_SET");
    return out("DEGRADED", "EMPTY_SET", "No model is allowed under the saved toggles, so every subagent runs exactly as it asked.", row.fix);
  }
  if (compiled.gate?.code === "CLASSIFIER_UNMEASURED" && owner.enforcement === "enforce") {
    const row = codeRow("CLASSIFIER_UNMEASURED");
    return out("DEGRADED", "CLASSIFIER_UNMEASURED", row.plain, row.fix);
  }
  const compiledAt = ms(compiled.compiledAt), seen = st ? ms(st.updatedAt) : 0;
  const pol = st && isObj(st.policy) ? st.policy : null;
  const reported = pol && typeof pol.contentHash === "string" ? pol.contentHash : null;
  const workerHashes = st && Array.isArray(st.policyHashes) ? st.policyHashes.filter((h) => typeof h === "string") : [];
  const oldWorkers = workerHashes.filter((h) => h !== compiled.contentHash).length;
  const hashOther = (reported !== null && reported !== compiled.contentHash) || oldWorkers > 0;
  // a status that predates this compile (or reports another copy) describes the OLD file: its warnings must not outlive the fix
  const predates = seen > 0 && compiledAt > 0 && seen < compiledAt;
  if (st && !predates && !hashOther) {
    const headline = pol && pol.enforcement === compiled.owner.enforcement && typeof pol.headline === "string" && pol.headline ? clean(pol.headline) : null;
    for (const w of Array.isArray(st.warnings) ? st.warnings : []) {
      const row = isObj(w) && typeof w.code === "string" ? codeRow(w.code) : null;
      if (row && row.degrades) return out("DEGRADED", row.code, row.plain, row.fix, headline);
    }
  }
  if (!seen) {
    if (compiledAt > 0 && Number.isFinite(now) && now - compiledAt < NOT_WIRED_MS) {
      return out("WAITING", null, "saved and compiled; no router has reported yet, and it uses the policy from its next request.", `${CLI} status`, null, { savedSentence: SAVED_SENTENCE });
    }
    return out("NOT-WIRED", null, "The policy is compiled, but no router has ever reported in with it (the router is not wired in, or Claude Code has not run since the save).", "node harness/deploy-router.mjs");
  }
  if (predates || hashOther) {
    // the router ran for a long time after the compile and still reports another copy: it is not reading the new file
    if (!predates && oldWorkers === 0 && compiledAt > 0 && seen - compiledAt > NOT_WIRED_MS) {
      return out("NOT-WIRED", null, "The policy is compiled, but the router keeps reporting an older copy of it (it is not reading the new file, or it is not wired in).", "node harness/deploy-router.mjs");
    }
    const note = oldWorkers > 0 ? ` ${oldWorkers} of ${workerHashes.length} router workers still report an older copy.` : "";
    return out("WAITING", null, `saved and compiled; the router has not reported this version yet and uses it from its next request.${note}`, `${CLI} status`, null, { savedSentence: SAVED_SENTENCE });
  }
  if (Number.isFinite(now) && now - seen > SILENT_MS) {
    return out("IDLE", null, `last request seen ${agoText(now - seen)} ago; the router reports only while Claude Code runs; nothing is wrong unless you used Claude Code since.`, `${CLI} status`);
  }
  const headline = pol && pol.enforcement === compiled.owner.enforcement && typeof pol.headline === "string" && pol.headline ? clean(pol.headline) : null;
  if (compiled.owner.enforcement === "enforce") return out("ENFORCING", null, headline ?? ENFORCING_SENTENCE, `${CLI} pause`, headline);
  return out("SHADOW", null, headline ?? SHADOW_SENTENCE, `${CLI} last`, headline);
}

/** The first line of `status`, `show`: `STATE: sentence`. */
export const verdictLine = (v) => `${v.state === "DEGRADED" ? v.label : v.state}: ${v.sentence}`;
/** The first line of a successful `set`: a state that waits for the router reads `SAVED:`, anything else is the verdict itself. */
export const savedLine = (v) => (v.savedSentence ? `SAVED: ${v.savedSentence}` : verdictLine(v));
export const fixLine = (v) => `next: ${v.fix}`;

const TOGGLES = [["source", "source"], ["mode", "mode"], ["freeScope", "free-scope"], ["ctx", "ctx"], ["enforcement", "enforcement"], ["inject", "inject"], ["unverified", "unverified"]];
const num = (v) => Number(v).toLocaleString("en-US");
const pl = (n, w) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
/**
 * The delta line (plan 7.2 item 6): what a `set` changes against the previous saved policy. `before` is null (no previous policy) or
 * {toggles, eligible, providers}; `after` is {toggles, eligible, providers}; `providerTotal` is the denominator of the provider counts (providers with a model in the
 * snapshot). `eligible` is a number, null when the policy has no candidate list (mode inherit: subagents follow main) or undefined when it is not known (the counts are then left out).
 * The model count carries no denominator here on purpose: the line under it (`ALLOWED: N models (of M in the chosen scope ...)`) is the one place that says what N is a share of.
 */
export function deltaText(before, after, providerTotal) {
  const den = Number.isFinite(providerTotal) ? ` (of ${pl(providerTotal, "provider")} in the gateway's provider list)` : "";
  const side = (s) => (s.eligible === null ? "every subagent follows main" : `${pl(s.eligible, "model")} on ${pl(s.providers, "provider")}`);
  if (!before) return after.eligible === undefined ? "new policy" : after.eligible === null ? "new policy: every subagent follows main (no model list)" : `new policy: eligible ${side(after)}${den}`;
  const parts = [];
  for (const [k, label] of TOGGLES) {
    // the free scope is only part of the policy under mode free
    if (k === "freeScope" && before.toggles.mode !== "free" && after.toggles.mode !== "free") continue;
    if (before.toggles[k] !== after.toggles[k]) parts.push(`${label} ${before.toggles[k] ?? "-"} -> ${after.toggles[k] ?? "-"}`);
  }
  if ((before.toggles.banded !== false) !== (after.toggles.banded !== false)) parts.push(`banded ${before.toggles.banded !== false ? "yes" : "no"} -> ${after.toggles.banded !== false ? "yes" : "no"}`);
  if ((before.toggles.handoffNotice !== false) !== (after.toggles.handoffNotice !== false)) parts.push(`handoff-notice ${before.toggles.handoffNotice !== false ? "yes" : "no"} -> ${after.toggles.handoffNotice !== false ? "yes" : "no"}`);
  const pa = [...(before.toggles.allow ?? [])].sort().join(), pb = [...(after.toggles.allow ?? [])].sort().join();
  if (pa !== pb) parts.push(`pinned models ${(before.toggles.allow ?? []).length} -> ${(after.toggles.allow ?? []).length}`);
  let counts = "";
  if (before.eligible !== undefined && after.eligible !== undefined) {
    if (typeof before.eligible === "number" && typeof after.eligible === "number") {
      counts = before.eligible === after.eligible && before.providers === after.providers
        ? `eligible ${side(after)}, unchanged${den}`
        : `eligible ${num(before.eligible)} -> ${num(after.eligible)} models, ${num(before.providers)} -> ${num(after.providers)} providers${den}`;
    } else counts = `eligible: ${side(before)} -> ${side(after)}`;
  } else if (after.eligible !== undefined) counts = `eligible ${side(after)}${den}`;
  const head = parts.length ? parts.join(", ") : "no toggle changed";
  return counts ? `${head}; ${counts}` : head;
}

/** The verdict of a saved policy file that cannot be read or is invalid: `status` says so (and exits 4) instead of dying with a bare error. */
export function corruptVerdict() {
  const row = codeRow("E_OWNER_CORRUPT");
  return out("DEGRADED", "E_OWNER_CORRUPT", `${row.plain} The router keeps using the last compiled copy, but no command can read your choices.`, row.fix);
}

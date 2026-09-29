// Two hints the snapshot bakes from bench data, both about routes that LOOK usable and are not
// (plans/bench-study/REPORT.md sections 3.1 and 4b). Pure functions over a bench reader
// (`loadBench().get`); nothing here does I/O or imports anything heavy, because the picker
// imports it too (the live check below).
//
//   payFreeNote   a `FREE?` badge whose fresh probe says PAYMENT IS REQUIRED. A badge must not
//                 claim "(possibly) free" when the last probe says the provider wants money.
//   aliasMap      a `gone` route with a sibling route, in the same provider, that ANSWERED: the
//                 picker can say where the working route is. It never changes what enter selects.
//
// Both use the ONE freshness rule (`isUsable`): a stale or future-dated record changes nothing.

import { isUsable, benchKey } from "./bench-data.mjs";

export const PAY_NOTE = "probe: payment required";

/** The note explaining why a `FREE?` badge was blanked, or `null` when the badge stands. */
export function payFreeNote(model, provider, get, nowMs = Date.now()) {
  if (typeof get !== "function" || model?.badge !== "FREE?") return null;
  const rec = get(benchKey(provider, model.id ?? ""));
  return rec && rec.s === "pay" && isUsable(rec, nowMs) ? PAY_NOTE : null;
}

const strip = (id) => String(id ?? "").replace(/\[1m\]$/i, "");
const norm = (s) => s.toLowerCase().replace(/[._]/g, "-");
// The study's rules, verbatim: `:batch` is listed so that a `:batch` id never counts as its own
// alias base, but a `:batch` ROW never gets an alias at all (a batch id is a different route).
const SUFFIX = /(:free|:batch\w*|-free|@eu|@us|-latest|:nitro|:floor|:thinking)$/i;

/**
 * For each `gone` route of a provider whose own FRESH status is `gone`: the id of a sibling
 * route (same provider, in `models`) whose fresh status is `ok`, found by the study's rules:
 * org-prefixed (`org/x` for `x`), bare (`x` for `org/x`), punctuation/case (`qwen3-5-27b` ~
 * `qwen3.5-27b`) or suffix-stripped (`x:free`, `x:thinking`, `x@eu`, `x@us`, ... -> `x`).
 * Returns a Map from the route's own id to the sibling's id as the snapshot spells it.
 */
export function aliasMap(provider, models, get, nowMs = Date.now()) {
  const out = new Map();
  if (typeof get !== "function") return out;
  const status = (id) => {
    const rec = get(benchKey(provider, id));
    return rec && isUsable(rec, nowMs) ? rec.s : null;
  };
  const okIds = new Map();                                // lowercase stripped id -> id as spelled
  const gone = [];
  for (const m of models ?? []) {
    const id = String(m?.id ?? "");
    const s = status(id);
    if (s === "ok" && !okIds.has(strip(id).toLowerCase())) okIds.set(strip(id).toLowerCase(), id);
    if (s === "gone" && !/:batch/i.test(strip(id))) gone.push(id);
  }
  if (!okIds.size) return out;
  for (const id of gone) {
    const x = strip(id), xl = x.toLowerCase(), nx = norm(x), xs = x.replace(SUFFIX, "").toLowerCase();
    let hit = null;
    for (const [yl, y] of okIds) {
      if (yl === xl) continue;                            // the same route spelled with and without [1m]
      if (yl.endsWith("/" + xl)) hit = y;
      else if (xl.includes("/") && yl === xl.split("/").pop()) hit = y;
      else if (norm(strip(y)) === nx) hit = y;
      else if (xs !== xl && yl === xs) hit = y;
      if (hit) break;
    }
    if (hit) out.set(id, hit);
  }
  return out;
}

/**
 * The alias to SHOW for a row, checked against the records as they are NOW: the baked
 * `aliasOf` is only a pointer, and it is honoured only while this route is still freshly `gone`
 * and the sibling is still freshly `ok`. `null` otherwise.
 */
export function liveAlias(provider, model, get, nowMs = Date.now()) {
  if (typeof get !== "function" || !model?.aliasOf) return null;
  const own = get(benchKey(provider, model.id ?? ""));
  if (!own || own.s !== "gone" || !isUsable(own, nowMs)) return null;
  const sib = get(benchKey(provider, model.aliasOf));
  return sib && sib.s === "ok" && isUsable(sib, nowMs) ? String(model.aliasOf) : null;
}

// ------------------------------------------------------------------ alive / dead

/**
 * What a "no response" probe result looks like, in ONE named place. A probe that got NO response at all is the only
 * kind that can make a provider read `dead` in the picker (see `providerStatus`: `alive` = a fresh `ok`, `down` =
 * answered but nothing ok, `dead` = every fresh probe was one of these). `providerAlive` below is the LEGACY two-state
 * flag (`benchFlags.alive`: "answered in any shape"), kept in the snapshot for other readers.
 * The wording below was built from the real records in state/bench.json (2026-09-29):
 *   `fetch failed`                      269  no HTTP response reached the probe
 *   `Failed to reach upstream provider`   7  the gateway could not reach the provider
 *   `terminated`                          1  the connection was cut
 * plus a `timeout` status with no first token ("no complete answer within N ms"), and the usual network-error
 * words for anything that appears later. A provider-side error ("Upstream request failed",
 * "overloaded", a 5xx body, "Model is unavailable") is a RESPONSE, so it does NOT match.
 */
// String.raw: these are regex sources, and an ordinary string would swallow the backslashes (`\w` -> `w`).
export const NO_RESPONSE = new RegExp([
  String.raw`fetch failed`, String.raw`failed to reach upstream`, String.raw`no complete answer`,
  String.raw`ECONN(?:REFUSED|RESET|ABORTED)`, String.raw`ENOTFOUND`, String.raw`EAI_AGAIN`, String.raw`ETIMEDOUT`,
  String.raw`EHOSTUNREACH`, String.raw`ENETUNREACH`, String.raw`socket hang ?up`, String.raw`getaddrinfo`,
  String.raw`other side closed`, String.raw`UND_ERR_\w+`,
  String.raw`connect(?:ion)? (?:timed out|refused|reset|closed)`, String.raw`network (?:error|request failed)`,
  String.raw`(?:^|: )terminated\.?$`,
].join("|"), "i");

/**
 * A record that is a CONNECTION-level failure: no response at all. A `timeout` counts ONLY when nothing came
 * back before the deadline (no first-token time `t`); a timeout that got its first token is a response.
 */
export function isNoResponse(rec) {
  if (!rec) return false;
  if (rec.s === "timeout") return !Number.isFinite(rec.t);
  // Each text field on its own: a joined string would put a space after a bare `terminated` and defeat its `$`.
  return rec.s === "error" && [rec.m, rec.p].some((x) => typeof x === "string" && NO_RESPONSE.test(x));
}

/**
 * LEGACY two-state flag, NOT what the picker draws (that is `providerStatus`): `true` (something answered, errors
 * included), `false` (nothing did: there is at least one fresh
 * probe result and EVERY one is a no-response failure) or `null` (nothing fresh to judge from: a
 * provider nobody probed has no verdict). `skip` records are not probe results and are ignored.
 */
export function providerAlive(provider, models, get, nowMs = Date.now()) {
  if (typeof get !== "function") return null;
  let seen = 0, answered = 0;
  for (const m of models ?? []) {
    const rec = get(benchKey(provider, m?.id ?? ""));
    if (!rec || rec.s === "skip" || !isUsable(rec, nowMs)) continue;
    seen += 1;
    if (!isNoResponse(rec)) answered += 1;
  }
  return seen === 0 ? null : answered > 0;
}

/**
 * The provider list's `status`, over the provider's FRESH probe results (`skip` records are not probe
 * results and are ignored; every reader uses a record whatever its age):
 *   `alive`  at least one fresh `ok`: something on it works
 *   `down`   at least one fresh record, none `ok`, and at least one is NOT a no-response (it answered: auth,
 *            pay, gone, empty, rate, a provider-side error body, or a timeout that returned a first token)
 *   `dead`   at least one fresh record and EVERY one is a no-response (`isNoResponse`: a connection-level
 *            failure, or a timeout that got nothing back)
 *   `null`   nothing fresh to judge from: a provider nobody probed has no verdict
 * A label only: routing is untouched (a provider that answered is never pruned for reading `down`).
 */
export function providerStatus(provider, models, get, nowMs = Date.now()) {
  if (typeof get !== "function") return null;
  let seen = 0, ok = 0, answered = 0;
  for (const m of models ?? []) {
    const rec = get(benchKey(provider, m?.id ?? ""));
    if (!rec || rec.s === "skip" || !isUsable(rec, nowMs)) continue;
    seen += 1;
    if (rec.s === "ok") ok += 1;
    if (!isNoResponse(rec)) answered += 1;
  }
  return seen === 0 ? null : ok > 0 ? "alive" : answered > 0 ? "down" : "dead";
}

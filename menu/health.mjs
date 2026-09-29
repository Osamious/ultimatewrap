// Provider health, from probe history -- fold-only half of the design
// (`plans/phase6-menu-and-catalogue.md`, Task B7). `writeHealthFromOutcomes`,
// the per-refresh projection, is deliberately NOT ported here: it takes a
// `tier` argument whose meaning depends on the live tier-1 refresh design
// this branch defers (Milestone 2's own note), and its `broken` branch keys
// on `consecutiveFails` accumulating past {0,1}, which only a merge ledger
// this branch does not build (B5) can do correctly. Shipping the fold alone
// still turns a constant column into a real one, from data already on disk.
//
// Browsing into a provider that 502s is worse than not seeing it listed at
// all. The age refusal is the important part: a green "callable" from three
// weeks ago is worse than blank, because it is a claim nobody re-checked.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HEALTH_FILE = path.join(os.homedir(), ".uw", "state", "health.json");
export const MAX_HEALTH_AGE_MS = 14 * 24 * 3600 * 1000;
const BROKEN_NOTES =
  /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;

export function readHealth(file = HEALTH_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { generatedAt: raw.generatedAt ?? null, providers: raw.providers ?? {} };
  } catch {
    return { generatedAt: null, providers: {} };
  }
}

export function resolveHealth(profile, entry, health, now = Date.now()) {
  // Hand-written notes are a human's verdict and never expire.
  if (BROKEN_NOTES.test(String(profile?.notes ?? ""))) return "broken";

  // Age is measured per ENTRY where the entry knows its own age, not from the
  // document stamp. A refresh rewrites `generatedAt` for the whole file, so a
  // document-level age would make a two-week-old probe verdict look fresh the
  // moment any listing ran.
  const at = entry?.at ?? health?.generatedAt;
  const age = at ? now - Date.parse(at) : Infinity;
  if (age > MAX_HEALTH_AGE_MS) return profile?.requiresBalance ? "needs $" : "stale";

  // THREE SOURCES, ORDERED BY STRENGTH -- only two of which this branch's
  // fold can ever produce ("probe" from key-health-latest.json; "listing" and
  // "keyed-listing" are the deferred per-refresh projection's to write).
  //
  //   probe          a completion answered on this credential      — strongest
  //   keyed-listing  tier 2: the credential authenticated against
  //                  the provider's own /models endpoint
  //   listing        tier 1 models.dev: no key involved            — weakest
  //
  // `ok` requires evidence that a KEY worked, so it needs `probe` or
  // `keyed-listing` with a `lastOk` inside the freshness window. Tier 1 alone,
  // or no entry at all, renders `stale` -- "nobody has checked this key" is
  // not a health verdict.
  const KEYED = new Set(["probe", "keyed-listing"]);
  if ((entry?.consecutiveFails ?? 0) >= 3) return "broken";
  if (profile?.requiresBalance) return "needs $";
  if (!entry || !KEYED.has(entry.source) || !entry.lastOk) return "stale";
  return "ok";
}

// Which source may overwrite which. A stronger source is never downgraded by a
// weaker one, so a probe verdict survives every later listing-only refresh.
// Unused by the fold-only writer shipped in this branch, but exported now
// because it is part of resolveHealth's own precedence contract and the
// deferred per-refresh projection depends on it existing here, not being
// re-derived.
export const SOURCE_RANK = { probe: 3, "keyed-listing": 2, listing: 1 };
export const outranks = (a, b) => (SOURCE_RANK[a] ?? 0) >= (SOURCE_RANK[b] ?? 0);

export const makeHealthOf = (providers, health, now = Date.now()) => (name) =>
  resolveHealth(providers.get(name) ?? {}, health.providers?.[name], health, now);

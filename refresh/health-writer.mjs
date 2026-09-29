// The producer half of Task B7, fold-only. `writeHealthFromOutcomes` -- the
// per-refresh projection that would run at the end of every `refresh/cli.mjs`
// call -- is deliberately NOT shipped here; see `menu/health.mjs`'s header
// for why. This file folds `keysync/key-health-latest.json` (or any probe
// results file of the same shape) into `~/.uw/state/health.json`, which is
// enough to make the picker's health column real today, from data already on
// disk, with no new probing required.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";

export const HEALTH = path.join(os.homedir(), ".uw", "state", "health.json");

// A credential id is `bucket.provider.tier`, so the provider is the middle
// segment. Several credentials can map to one provider (different buckets or
// tiers); the provider is healthy if ANY of its credentials answered, because
// the column answers "can I use this provider", not "is every key for it good".
const providerOf = (credId) => String(credId).split(".")[1] ?? null;

export function foldProbeResults(doc, prev = { providers: {} }) {
  const providers = {};
  for (const r of doc?.results ?? []) {
    const name = providerOf(r.id);
    if (!name) continue;
    const base = providers[name] ?? { lastOk: null, lastFail: null,
                                      consecutiveFails: prev.providers?.[name]?.consecutiveFails ?? 0 };
    if (r.state === "ok") {
      providers[name] = { ...base, lastOk: doc.at, consecutiveFails: 0,
                          source: "probe", at: doc.at };
    } else if (r.state === "skipped") {
      providers[name] = base;                       // no information either way
    } else if (!base.lastOk) {                      // auth or broken, and nothing good yet
      providers[name] = { ...base, lastFail: doc.at,
                          consecutiveFails: (base.consecutiveFails ?? 0) + 1,
                          source: "probe", at: doc.at };
    }
  }
  return { generatedAt: doc?.at ?? null, providers };
}

export function writeHealthFromProbeFile(file, out = HEALTH) {
  const doc = readJsonOr(file, null);
  if (!doc?.results) return null;
  const next = foldProbeResults(doc, readJsonOr(out, { providers: {} }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeAtomic(out, JSON.stringify(next, null, 2));
  return next;
}

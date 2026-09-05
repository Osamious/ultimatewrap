// The set of model ids Anthropic actually publishes, for narrowing the bare-id
// collision guard (BACKLOG item 2 / Task A5.2's sibling).
//
// checkBareCollisions used to flag any id matching RESERVED -- a broad
// Claude-SHAPED test, not a real-id test. `claude-opus-5-thinking`, served by
// tabiai and gorouter, is Claude-shaped and sole-owned, so it read as
// hijackable even though Anthropic has never published that id: extended
// thinking is a request parameter, not a separate model. Firing on a name
// nothing could ever request unnamespaced is a false positive by construction.
//
// The authoritative, self-updating source is the same one Task A5.2 already
// uses: the relay's own GET /v1/models, which forwards to Anthropic with the
// subscription OAuth bearer already resolved. This module does not duplicate
// that resolution logic -- it fetches the same endpoint independently, because
// this runs in keysync/run.mjs's process, not the relay's.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";

export const CACHE_FILE = path.join(os.homedir(), ".uw", "state", "anthropic-ids-cache.json");
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour, matching A5.2's alias cache

/**
 * Shape one `/v1/models` entry list into the catalog this module returns.
 *
 * `max_input_tokens` is an official, documented field of Anthropic's models
 * list, and the relay is a pure passthrough of it (verified by curl + relay
 * source read, 2026-09-05). It is the ONLY live evidence of a model's real
 * context window; a missing or non-numeric value means "not stated", which is
 * different from "small" and must not be coerced into one -- so such an id
 * simply gets no `contextById` entry and the caller falls back to its own
 * curated default rather than silently reading as sub-1M.
 */
function toCatalog(models, at) {
  const ids = new Set();
  const contextById = new Map();
  for (const m of models ?? []) {
    const id = String(m?.id ?? "");
    if (!id) continue;
    ids.add(id);
    const ctx = Number(m?.max_input_tokens);
    if (Number.isFinite(ctx) && ctx > 0) contextById.set(id, ctx);
  }
  // `at` travels WITH the data because the caller's two consumers weigh age
  // differently. The security guard wants any real snapshot, however old --
  // stale evidence still beats none there. Routing does not: writing a
  // week-old id list into Providers[].models can advertise a model Anthropic
  // has since retired, and a picker row that 404s is worse than an absent one.
  // Without an age the caller cannot tell those two uses apart.
  return ids.size ? { ids, contextById, at: Number(at) || 0 } : null;
}

/**
 * Read a cache record, accepting BOTH the current `{at, models:[{id,
 * max_input_tokens}]}` shape and the legacy `{at, ids:[...]}` one.
 *
 * The legacy shape is honoured rather than discarded because it is still
 * authoritative for the thing the security guard consumes -- the id set -- and
 * treating a format bump as a cache miss would drop a real snapshot back to
 * `null` (= "unknown, do not narrow") on the first run after an upgrade. It
 * simply carries no context windows, so `contextById` comes back empty and the
 * picker falls back to its hand-tagged defaults, which is exactly the
 * "live data unavailable for this id" path those defaults exist for.
 */
function readCacheRecord(cached) {
  if (!cached || typeof cached !== "object") return null;
  const at = Number(cached.at) || 0;
  if (Array.isArray(cached.models)) return toCatalog(cached.models, at);
  if (Array.isArray(cached.ids)) return toCatalog(cached.ids.map((id) => ({ id })), at);
  return null;
}

/**
 * Fetch the live Anthropic model catalog through the relay -- ids AND each
 * model's `max_input_tokens` -- with a file-backed cache (run.mjs is a
 * short-lived process per invocation, so an in-memory cache would never
 * survive between runs).
 *
 * FAILS TOWARD CAUTION, not toward permissiveness. This feeds a security
 * predicate: returning null means "unknown, do not narrow" and the caller
 * must fall back to today's broad RESERVED-only match, never to "assume every
 * RESERVED id is real" or "assume none are". A stale-but-present cache is
 * preferred over null on a fetch failure, since a recent-enough real snapshot
 * is still better evidence than no evidence.
 *
 * @param {object} [opts]
 * @param {string} [opts.relayBase]  overridable for tests
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ids: Set<string>, contextById: Map<string, number>, at: number}|null>}
 *   `at` is when this snapshot was taken (epoch ms; 0 if a cache record never
 *   carried one). Callers that write live routing config must impose their own
 *   staleness ceiling on it -- this function deliberately does not, because its
 *   other consumer (the collision guard) is correct to prefer any real snapshot
 *   over none no matter how old.
 */
export async function fetchAnthropicCatalog({
  relayBase = "http://127.0.0.1:4517",
  fetchImpl = fetch,
  timeoutMs = 4000,
  cacheFile = CACHE_FILE,
  ttlMs = CACHE_TTL_MS,
} = {}) {
  const raw = readJsonOr(cacheFile, null);
  const cached = readCacheRecord(raw);
  const now = Date.now();
  if (cached && now - (raw?.at ?? 0) < ttlMs) return cached;

  try {
    const res = await fetchImpl(`${relayBase}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
    const body = await res.json();
    const models = Array.isArray(body.data)
      ? body.data
        .map((m) => ({ id: String(m?.id ?? ""), max_input_tokens: Number(m?.max_input_tokens) }))
        .filter((m) => m.id)
      : [];
    if (!models.length) throw new Error("/v1/models returned no ids");
    const live = toCatalog(models, now);
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      // `ids` is written ALONGSIDE `models`, not replaced by it. The cache file
      // is shared state on disk, and an older checkout of this module (or a
      // rollback) reads only `ids` -- dropping the field would make its guard
      // read `null` (unknown) until the TTL expired, silently widening the
      // predicate. Two representations of one snapshot, written together, cost
      // a few hundred bytes and cannot disagree.
      writeAtomic(cacheFile, JSON.stringify({
        at: now,
        models: models.map((m) => (Number.isFinite(m.max_input_tokens) && m.max_input_tokens > 0
          ? { id: m.id, max_input_tokens: m.max_input_tokens }
          : { id: m.id })),
        ids: models.map((m) => m.id),
      }, null, 2));
    } catch { /* a failed cache write must not fail the fetch that succeeded */ }
    return live;
  } catch {
    // Live fetch failed. A STALE cache is still evidence; only fall through to
    // null (unknown) if there has never been a successful fetch at all.
    if (cached) return cached;
    return null;
  }
}

/**
 * The id-only view of the catalog, which is all the bare-id collision guard
 * (BACKLOG item 2) ever needed. A thin wrapper on purpose: one fetch path, one
 * cache, one set of failure semantics -- so `null` here still means exactly
 * what it meant before the catalog grew a second field.
 *
 * @returns {Promise<Set<string>|null>}
 */
export async function fetchAnthropicIds(opts = {}) {
  return (await fetchAnthropicCatalog(opts))?.ids ?? null;
}

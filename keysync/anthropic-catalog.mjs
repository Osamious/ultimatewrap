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
 * Fetch the live set of Anthropic model ids through the relay, with a
 * file-backed cache (run.mjs is a short-lived process per invocation, so an
 * in-memory cache would never survive between runs).
 *
 * FAILS TOWARD CAUTION, not toward permissiveness. This is a security
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
 * @returns {Promise<Set<string>|null>}
 */
export async function fetchAnthropicIds({
  relayBase = "http://127.0.0.1:4517",
  fetchImpl = fetch,
  timeoutMs = 4000,
  cacheFile = CACHE_FILE,
  ttlMs = CACHE_TTL_MS,
} = {}) {
  const cached = readJsonOr(cacheFile, null);
  const now = Date.now();
  if (cached && Array.isArray(cached.ids) && now - (cached.at ?? 0) < ttlMs) {
    return new Set(cached.ids);
  }

  try {
    const res = await fetchImpl(`${relayBase}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
    const body = await res.json();
    const ids = Array.isArray(body.data) ? body.data.map((m) => String(m?.id ?? "")).filter(Boolean) : [];
    if (!ids.length) throw new Error("/v1/models returned no ids");
    try {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      writeAtomic(cacheFile, JSON.stringify({ at: now, ids }, null, 2));
    } catch { /* a failed cache write must not fail the fetch that succeeded */ }
    return new Set(ids);
  } catch {
    // Live fetch failed. A STALE cache is still evidence; only fall through to
    // null (unknown) if there has never been a successful fetch at all.
    if (cached && Array.isArray(cached.ids)) return new Set(cached.ids);
    return null;
  }
}

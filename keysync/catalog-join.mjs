// The catalogue join (decisions D3 §4.2/§4.3), as pure functions over an index.
//
// WHY A SEPARATE MODULE. `menu/catalog.mjs:25` statically imports
// `keysync/keysync.mjs`, so keysync importing back from the menu closes a
// circular import and drags `ccr-client.mjs`/`atomic.mjs` into keysync's
// transitive graph. Both lanes need the offer-matching and entry-matching rules,
// so they land here once and both sides import from here. No import in this file
// points at `menu/`, and nothing here reads the filesystem: the ladder is
// testable without the 19.7 MB bundle, which is the whole reason it is extracted
// (plan §6.1).
//
// WHAT A JOIN IS FOR. `capabilities.reasoning` and `limits.contextTokens` exist
// only in the bundle -- no provider's `/v1/models` carries them -- so
// `bucketFor()` can only be fed by matching a live (provider, id) pair to a
// bundle entry. A miss is `null`, never a guess (D3 §4.2).

// ------------------------------------------------------------------- the index
//
// `loadCatalog` owns the two groupings the FILE itself declares -- `byProvider`
// and `byAlias`. This function owns the structures the LADDER needs and the file
// does not declare: a global id map, a tail map, and the case-folded variants of
// all three. The line is deliberate: reading the bundle is keysync's job, ladder
// policy is this module's.
//
// MEASURED 2026-09-06 over the live bundle (4,298 entries, 217 providers):
// `id === `${provider}/${model}`` holds for 4,298 of 4,298, no alias is bare
// (0 of 10,184), and no alias is claimed by two entries (0 collisions). So
// `byId` and `byAlias` are both unambiguous. `model` is NOT: 3,432 distinct
// tails over 4,298 entries, 866 entries landing on a tail another entry already
// holds -- which is why `byTail` holds an array and the tail rung has an
// explicit tie-break rather than a `Map#get`.
export function buildJoinIndex(catalog) {
  const byId = new Map();
  const byTail = new Map();
  const byIdLower = new Map();
  const byTailLower = new Map();
  const byAlias = catalog?.byAlias instanceof Map ? catalog.byAlias : new Map();
  const byAliasLower = new Map();

  for (const entries of catalog?.byProvider?.values() ?? []) {
    for (const e of entries) {
      if (typeof e?.id === "string" && !byId.has(e.id)) byId.set(e.id, e);
      if (typeof e?.model === "string") {
        if (!byTail.has(e.model)) byTail.set(e.model, []);
        byTail.get(e.model).push(e);
        const lt = e.model.toLowerCase();
        if (!byTailLower.has(lt)) byTailLower.set(lt, []);
        byTailLower.get(lt).push(e);
      }
      if (typeof e?.id === "string") {
        const li = e.id.toLowerCase();
        if (!byIdLower.has(li)) byIdLower.set(li, e);
      }
    }
  }
  for (const [alias, e] of byAlias) {
    const la = String(alias).toLowerCase();
    if (!byAliasLower.has(la)) byAliasLower.set(la, e);
  }
  return { byId, byAlias, byTail, byIdLower, byAliasLower, byTailLower };
}

// ------------------------------------------------------------------ the rungs

// Rung 2. The three normalisations D3 §1 measured as worth 51 hits (+2%), and
// NOTHING else. Greedier rules are rejected there with a reason: stripping date
// suffixes merges `claude-3-haiku-20240307` with `-20241022`, and stripping
// `-instruct` merges a base model with its instruct variant. Different weights,
// different capabilities -- a wrong join is worse than no join, because a wrong
// join yields a confident capability label instead of an honest `unknown`.
function normalise(id) {
  let s = id;
  if (s.startsWith("models/")) s = s.slice("models/".length);
  s = s.replace(/:(free|batch)$/i, "");
  return s.replace(/\./g, "-");
}

// Rung 5. Three id SHAPES rather than three spellings: Fireworks' full resource
// path, the leading `~` that `menu/sanitize.mjs` already admits as a real id
// character (13 live ids), and the `[…]` context-window suffix (`kimi-k3[1M]`).
// Each strip shortens the string, so the retry in `joinCatalogEntry` terminates.
function stripShapes(id) {
  let s = id.replace(/^~+/, "");
  s = s.replace(/^accounts\/[^/]+\/models\//, "");
  return s.replace(/\[[^\]]*\]$/, "");
}

// THE BARE-NAME GUARD (D3 §4.3), as ONE predicate that both global rungs call.
//
// A key with no vendor prefix is only ever looked up as `${provider}/${key}`,
// never as itself and never by tail, so a bare id cannot reach another
// provider's row. `auto`, `hy3`, `inkling` and `mistral` stay `null` rather than
// becoming somebody else's model.
//
// "Bare" is a property of the KEY, not of the caller's input:
// `models/gemini-3-flash` and `accounts/fireworks/models/llama-v3` are both
// qualified on the way in and bare after rungs 2 and 5, and the guard follows
// them there.
//
// One predicate rather than a check per rung, so that the plan's mutation
// (§6.4, "remove the prefix check") is a single edit with a single expected
// failure. Two copies would let a mutation kill one and survive on the other.
//
// A SLASH IS NOT AUTOMATICALLY A VENDOR. Two id shapes carry a leading segment
// that names a resource path rather than a publisher: Google's `models/…` and
// Fireworks' `accounts/…/models/…`. Neither `models` nor `accounts` is a vendor,
// so neither may license a cross-provider match -- `accounts/fireworks/models/
// auto` and `models/auto` are `auto` wearing a path, and both reached
// `morph/auto` before this clause existed. They are the same two shapes rungs 2
// and 5 already strip, named once more here because the guard runs BEFORE those
// strips do. No other head is special-cased: this is the narrow rule for two
// measured shapes, not an open list.
const NON_VENDOR_HEAD = /^(?:models\/|accounts\/[^/]+\/models\/)/;

function isQualified(key) {
  if (NON_VENDOR_HEAD.test(key)) return false;
  return key.includes("/");
}

// Rungs 1-3. Exact match on the three key forms D3 §1 names -- bare, full
// `provider/model`, and `aliases[]` -- with `ci` selecting the case-folded maps.
//
// Provider-scoped before global, always: `${provider}/${key}` is the more
// specific claim, so when both resolve the caller's own provider wins.
function exact(index, provider, key, ci) {
  const byId = ci ? index.byIdLower : index.byId;
  const byAlias = ci ? index.byAliasLower : index.byAlias;
  const k = ci ? key.toLowerCase() : key;
  const p = ci ? provider.toLowerCase() : provider;
  const scoped = `${p}/${k}`;
  const hit = byId.get(scoped) ?? byAlias.get(scoped);
  if (hit) return hit;
  if (!isQualified(key)) return null;
  return byId.get(k) ?? byAlias.get(k) ?? null;
}

// Rung 4, the ladder's largest single contribution (+376 hits, 47% -> 65%).
// A live id that carries its OWN vendor prefix -- `qwen/qwen3-max` listed by
// openrouter -- may match a bundle row grouped under a different provider
// (`alibaba/qwen3-max`), because the id itself names the vendor. That licence is
// exactly what a bare id lacks, so the same guard gates this rung: no slash, no
// tail match. This is the measured false positive the guard exists for --
// `orcarouter`'s bare `auto` matching `morph/auto`.
//
// 866 entries share a tail, so the tie-break is explicit and ordered: the
// caller's own provider, then the vendor the id names, then bundle order.
// Bundle order is stable (a fixed file) but arbitrary, so it is the last resort
// and never the first.
function tail(index, provider, key, ci) {
  if (!isQualified(key)) return null;
  const t = key.slice(key.lastIndexOf("/") + 1);
  if (!t) return null;
  const vendor = key.slice(0, key.indexOf("/"));
  const bucket = (ci ? index.byTailLower : index.byTail).get(ci ? t.toLowerCase() : t);
  if (!bucket?.length) return null;
  const eq = ci
    ? (a, b) => a?.toLowerCase() === b.toLowerCase()
    : (a, b) => a === b;
  return bucket.find((e) => eq(e.provider, provider))
      ?? bucket.find((e) => eq(e.provider, vendor))
      ?? bucket[0];
}

/**
 * A live (provider, id) pair -> its bundle entry, or `null`.
 *
 * The ladder runs in D3 §1's measured order and returns at the first hit:
 *
 *   1. exact          bare ∪ `provider/model` ∪ `aliases[]`      43%
 *   2. normalisation  `models/`, `:free`/`:batch`, `.`->`-`      45%
 *   3. case-insensitive                                          47%
 *   4. vendor-qualified tail                                     65%
 *   5. `accounts/…/models/`, leading `~`, `[…]` suffix           70.9%
 *
 * Those cumulative figures are per distinct live ID STRING (2,136 of them).
 * The per-(provider, model) PAIR figure is higher -- 80% of 3,784 -- because the
 * unjoinable residual concentrates in a few providers listing many ids each.
 *
 * `null` is a real answer and the honest one. D3 §4.2: a miss yields
 * `reason: null` and no `contextTokens`, `bucketFor` returns `"unknown"`, and
 * `BUCKET_TARGETS.unknown === BUCKET_TARGETS.weak`. The row still ships --
 * catalogue absence dims a row, it never prunes one.
 *
 * @param {object} index  from `buildJoinIndex`
 * @param {string} provider  the live provider root
 * @param {string} id  the id as the provider listed it
 * @returns {object|null} the bundle entry
 */
export function joinCatalogEntry(index, provider, id) {
  if (!index?.byId || typeof provider !== "string" || typeof id !== "string") return null;
  const p = provider.trim();
  const raw = id.trim();
  if (!p || !raw) return null;

  const norm = normalise(raw);
  const hit =
       exact(index, p, raw, false)                                    // rung 1
    ?? exact(index, p, norm, false)                                   // rung 2
    ?? exact(index, p, raw, true) ?? exact(index, p, norm, true)      // rung 3
    ?? tail(index, p, raw, false) ?? tail(index, p, norm, false)      // rung 4
    ?? tail(index, p, raw, true) ?? tail(index, p, norm, true);
  if (hit) return hit;

  // Rung 5 re-enters the ladder on the shape-stripped key rather than repeating
  // it, so a stripped id gets all four rungs above and not merely an exact
  // retry. `stripShapes` strictly shortens, so this terminates.
  const stripped = stripShapes(raw);
  return stripped === raw ? null : joinCatalogEntry(index, p, stripped);
}

// --------------------------------------------------------------- offer prices
//
// MOVED HERE FROM `menu/catalog.mjs` BY R5, UNCHANGED. Not a rewrite and not a
// rule change: the body below is byte-for-byte what the menu shipped, and its
// comment is the original. It moved because two lanes need it and only one of
// them can own it -- `keysync.mjs` cannot import it from `menu/catalog.mjs`
// without closing the import cycle described at the top of this file, so the
// rule lives here and `menu/catalog.mjs` re-exports it. One owner of the
// offer-matching rule; the import path is incidental.
//
// KNOWN DEFECT, NOT FIXED HERE (#69): `.find()` means offer ARRAY ORDER decides
// the price when one provider contributes several offers to the same entry --
// 230 entries have 2+ usable offers for one provider, and 50 of those disagree
// on price. Relocating unchanged is the point of this task, so it is recorded
// rather than repaired. Nothing above this line treats offer order as
// meaningful, and nothing new should.

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

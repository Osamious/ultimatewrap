import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchAnthropicIds, fetchAnthropicCatalog } from "../keysync/anthropic-catalog.mjs";
import { atomicWriteJson } from "../keysync/safety.mjs";

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

const okModels = (ids) => ({
  ok: true,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
});
// The richer shape: `[id, max_input_tokens]` pairs, matching what Anthropic's
// documented /v1/models actually returns and the relay passes through unaltered.
const okCatalog = (pairs) => ({
  ok: true,
  json: async () => ({ data: pairs.map(([id, ctx]) => (ctx === undefined ? { id } : { id, max_input_tokens: ctx })) }),
});
const failing = () => { throw new Error("network unreachable"); };

test("a successful fetch returns the ids and writes the cache", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const ids = await fetchAnthropicIds({
    fetchImpl: async () => okModels(["claude-opus-5", "claude-sonnet-5"]),
    cacheFile,
  });
  assert.deepEqual([...ids].sort(), ["claude-opus-5", "claude-sonnet-5"]);
  const written = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.deepEqual(written.ids.sort(), ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(typeof written.at, "number");
});

test("a fresh cache is used without calling fetch again", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), ids: ["claude-haiku-4-5-20251001"] }));
  let called = false;
  const ids = await fetchAnthropicIds({ fetchImpl: async () => { called = true; return failing(); }, cacheFile });
  assert.equal(called, false, "a fresh cache must short-circuit the network call");
  assert.deepEqual([...ids], ["claude-haiku-4-5-20251001"]);
});

test("an expired cache is refreshed from a successful fetch", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: 0, ids: ["stale-id"] }));
  const ids = await fetchAnthropicIds({
    fetchImpl: async () => okModels(["claude-fable-5-1"]),
    cacheFile, ttlMs: 1000,
  });
  assert.deepEqual([...ids], ["claude-fable-5-1"]);
});

test("a fetch failure with no prior cache returns null -- unknown, not empty", () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  return fetchAnthropicIds({ fetchImpl: async () => failing(), cacheFile }).then((ids) => {
    assert.equal(ids, null, "null must mean 'could not be determined', never an empty Set");
  });
});

test("a fetch failure falls back to a STALE cache rather than null", async () => {
  // A recent-enough real snapshot is still better evidence than no evidence at
  // all -- the security predicate this feeds only narrows away a flag when it
  // has positive confirmation, so a stale-but-real answer is the conservative
  // middle ground between null (assume the old broad behaviour) and a live hit.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: 0, ids: ["claude-opus-5"] }));
  const ids = await fetchAnthropicIds({ fetchImpl: async () => failing(), cacheFile, ttlMs: 1000 });
  assert.deepEqual([...ids], ["claude-opus-5"]);
});

test("a malformed cache file is treated as no cache, not a crash", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, "{ not json");
  const ids = await fetchAnthropicIds({ fetchImpl: async () => okModels(["claude-opus-5"]), cacheFile });
  assert.deepEqual([...ids], ["claude-opus-5"]);
});

test("an empty /v1/models response is treated as a failure, not as zero real ids", async () => {
  // Distinguishes "the relay answered and there is nothing" (which would never
  // legitimately happen against the real API) from a malformed/empty response --
  // both should fall back rather than caching an empty set that would then
  // narrow every future run's guard to nothing being real.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const ids = await fetchAnthropicIds({ fetchImpl: async () => okModels([]), cacheFile });
  assert.equal(ids, null);
  assert.equal(fs.existsSync(cacheFile), false, "an empty response must not be cached as real");
});

test("a non-ok HTTP status is treated as a failure", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const ids = await fetchAnthropicIds({
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    cacheFile,
  });
  assert.equal(ids, null);
});

// ---- fetchAnthropicCatalog: the same matrix, plus max_input_tokens ----------
// fetchAnthropicIds is now a thin wrapper over this, so every test above is
// also a test of this function's id half. What follows covers the half those
// cannot see: the context windows the dynamic [1m] tagging is computed from.

test("a successful fetch returns each model's max_input_tokens", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const cat = await fetchAnthropicCatalog({
    fetchImpl: async () => okCatalog([["claude-opus-5", 1000000], ["claude-haiku-4-5-20251001", 200000]]),
    cacheFile,
  });
  assert.deepEqual([...cat.ids].sort(), ["claude-haiku-4-5-20251001", "claude-opus-5"]);
  assert.equal(cat.contextById.get("claude-opus-5"), 1000000);
  assert.equal(cat.contextById.get("claude-haiku-4-5-20251001"), 200000);
});

test("a model with no stated window gets NO contextById entry, not a zero", async () => {
  // "Not stated" and "small" are different claims, and collapsing them is the
  // defect the whole [1m] fix exists to prevent: a 1M model whose window the
  // response omitted would read as sub-1M and ship an untagged row, silently
  // putting the session back on a believed 200k window. Absent means absent, and
  // the caller then falls back to its curated tag.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const cat = await fetchAnthropicCatalog({
    fetchImpl: async () => okCatalog([["claude-opus-5", undefined], ["claude-sonnet-5", 1000000]]),
    cacheFile,
  });
  assert.equal(cat.ids.has("claude-opus-5"), true, "the id is still real and still routable");
  assert.equal(cat.contextById.has("claude-opus-5"), false);
  assert.equal(cat.contextById.get("claude-sonnet-5"), 1000000);
});

test("a non-numeric or non-positive window is discarded rather than trusted", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const cat = await fetchAnthropicCatalog({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [
      { id: "a-1", max_input_tokens: "lots" },
      { id: "a-2", max_input_tokens: 0 },
      { id: "a-3", max_input_tokens: -1 },
      { id: "a-4", max_input_tokens: 1000000 },
    ] }) }),
    cacheFile,
  });
  assert.deepEqual([...cat.contextById.keys()], ["a-4"]);
  assert.equal(cat.ids.size, 4, "a junk window must not remove the id itself");
});

test("the cache round-trips the windows, and a fresh one short-circuits the network", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  await fetchAnthropicCatalog({
    fetchImpl: async () => okCatalog([["claude-opus-5", 1000000], ["claude-fable-5-1", 1000000]]),
    cacheFile,
  });
  const written = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  assert.deepEqual(written.models.find((m) => m.id === "claude-opus-5"),
    { id: "claude-opus-5", max_input_tokens: 1000000 });
  // `ids` is written ALONGSIDE `models` so an older checkout (or a rollback)
  // reading only `ids` still sees a real snapshot instead of `null` = unknown,
  // which would silently widen the collision guard until the TTL expired.
  assert.deepEqual(written.ids.sort(), ["claude-fable-5-1", "claude-opus-5"]);

  let called = false;
  const again = await fetchAnthropicCatalog({
    fetchImpl: async () => { called = true; return failing(); }, cacheFile,
  });
  assert.equal(called, false);
  assert.equal(again.contextById.get("claude-fable-5-1"), 1000000);
});

test("a STALE cache still yields its windows rather than null", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: 0,
    models: [{ id: "claude-opus-5", max_input_tokens: 1000000 }] }));
  const cat = await fetchAnthropicCatalog({ fetchImpl: async () => failing(), cacheFile, ttlMs: 1000 });
  assert.equal(cat.contextById.get("claude-opus-5"), 1000000);
});

test("a LEGACY {at, ids} cache is honoured for ids and yields no windows", async () => {
  // The format bump must not be a cache miss. Discarding a legacy record would
  // drop a real snapshot back to null (= "unknown, do not narrow") on the first
  // run after an upgrade, widening the security predicate for an hour for no
  // reason. The ids are still authoritative; only the windows are absent, which
  // is exactly the case the curated fallback tags cover.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), ids: ["claude-opus-5", "claude-sonnet-5"] }));
  let called = false;
  const cat = await fetchAnthropicCatalog({
    fetchImpl: async () => { called = true; return failing(); }, cacheFile,
  });
  assert.equal(called, false, "a fresh legacy cache must still short-circuit the network");
  assert.deepEqual([...cat.ids].sort(), ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(cat.contextById.size, 0);
});

test("an empty models[] in the cache is treated as no cache, not as zero real ids", async () => {
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(cacheFile, JSON.stringify({ at: Date.now(), models: [] }));
  const cat = await fetchAnthropicCatalog({
    fetchImpl: async () => okCatalog([["claude-opus-5", 1000000]]), cacheFile,
  });
  assert.deepEqual([...cat.ids], ["claude-opus-5"], "the fetch must run rather than trust an empty record");
});

test("the catalog carries the snapshot's age, so routing can bound its staleness", async () => {
  // The guard and the routing config weigh age differently -- any real snapshot
  // beats none for the guard, while a week-old id list must not decide what we
  // advertise. Without `at` travelling with the data the caller cannot tell
  // those two uses apart, so this is not decoration.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const before = Date.now();
  const live = await fetchAnthropicCatalog({
    fetchImpl: async () => okCatalog([["claude-opus-5", 1000000]]), cacheFile,
  });
  assert.ok(live.at >= before && live.at <= Date.now(), "a live fetch is stamped now");

  // A cache record reports ITS OWN age, not the read time -- otherwise every
  // read would look fresh and the ceiling could never fire.
  const old = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(old, JSON.stringify({ at: 1000, models: [{ id: "claude-opus-5" }] }));
  const stale = await fetchAnthropicCatalog({ fetchImpl: async () => failing(), cacheFile: old, ttlMs: 1 });
  assert.equal(stale.at, 1000);

  // A legacy record with no `at` reports 0 -- maximally stale, which fails any
  // ceiling rather than passing it by default.
  const noAt = path.join(tmpdir("uw-cat-"), "cache.json");
  fs.writeFileSync(noAt, JSON.stringify({ ids: ["claude-opus-5"] }));
  const unstamped = await fetchAnthropicCatalog({ fetchImpl: async () => failing(), cacheFile: noAt });
  assert.equal(unstamped.at, 0);
});

test("fetchAnthropicIds is exactly fetchAnthropicCatalog's id half", async () => {
  // The wrapper claim, asserted rather than assumed. If these ever diverge, the
  // eight tests above this section stop describing the function they name.
  const cacheFile = path.join(tmpdir("uw-cat-"), "cache.json");
  const impl = async () => okCatalog([["claude-opus-5", 1000000], ["claude-sonnet-5", 200000]]);
  const cat = await fetchAnthropicCatalog({ fetchImpl: impl, cacheFile });
  const ids = await fetchAnthropicIds({ fetchImpl: impl, cacheFile });
  assert.deepEqual([...ids].sort(), [...cat.ids].sort());
  // ...and the null case maps to null, not to an empty Set.
  const empty = path.join(tmpdir("uw-cat-"), "cache.json");
  assert.equal(await fetchAnthropicCatalog({ fetchImpl: async () => failing(), cacheFile: empty }), null);
  assert.equal(await fetchAnthropicIds({ fetchImpl: async () => failing(), cacheFile: empty }), null);
});

// ---- atomicWriteJson must not assume its directory exists ------------------

test("atomicWriteJson creates a missing parent directory instead of failing", () => {
  // The temp file is written NEXT TO the target, so a missing parent fails the
  // WRITE, not the rename -- surfacing ENOENT for a path the caller just built.
  // ~/.uw/state/ exists on this machine and would not on a fresh one, which is
  // the shape of bug that only ever breaks for a first-time user.
  const dir = path.join(tmpdir("uw-aw-"), "deep", "nested");
  const file = path.join(dir, "state.json");
  atomicWriteJson(file, { hello: "world" });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { hello: "world" });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"], "and it leaves no temp-file debris");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchAnthropicIds } from "../keysync/anthropic-catalog.mjs";

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

const okModels = (ids) => ({
  ok: true,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
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

// R8. The discovery transport, offline.
//
// NOT ONE OF THESE TESTS OPENS A SOCKET. Every request is served by a stub, and
// the stubs are written so that a request nobody expected is a thrown error
// rather than a silent pass -- a live endpoint is R10's business and needs the
// user's authorization, which a test suite cannot give.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  LISTING_DEFAULTS, MODALITY_VOCAB, PINNED_HOSTS, PROXY_ENV, REASONS,
  aclPrincipals, cacheFileFor, classifyOutcome, coverageOf, discoverAll,
  discoverProvider, headersFor, isOwnerOnly, listingProfileFor, projectModel,
  proxyRefusal, readCacheRecord, resolveCacheDir, resolveListingUrl,
  scrubProxyEnv, writeCacheRecord, EXEC_ARGV_AT_LOAD, PROXY_ENV_AT_LOAD,
  MAX_ENTRIES, LAST_GOOD_KEYS, LAST_GOOD_MAX_BYTES, lastGoodOf, currentUserSid,
} from "../refresh/discover.mjs";
// cli.mjs runs its fan-out only when it is the process entry point, so importing
// it here reads no vault and issues no request.
import { main, withKeys } from "../refresh/cli.mjs";

const SCRATCH = path.join(process.env.HOME ?? process.env.USERPROFILE,
                          ".uw", "harness", "scratch", "discovery");

// groq is a pinned cluster-A provider, so a fixture built on it exercises the
// host pin on the happy path rather than only on the refusal path.
const PROF = { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai" };

/**
 * @param {(url:string, init:object) => {status:number, body?:*}} plan
 * A `body` is only ever stringified on demand, so a test can assert that a body
 * was NOT read by having `text()` throw.
 */
function stubFetch(plan) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = plan(url, init);
    return {
      // `headers` and `stream` are only present when a plan supplies them, so
      // every fixture written before the body ceiling existed still reads
      // through `text()` exactly as it did.
      status: r.status,
      headers: r.headers,
      body: r.stream,
      text: async () => {
        if (r.throwOnRead) throw new Error("the body of a non-2xx must never be read");
        return typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
      },
    };
  };
  impl.calls = calls;
  return impl;
}

/** An async-iterable body, and a record of how much of it was actually pulled. */
function streamOf(chunks) {
  const pulled = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) { pulled.push(c.length); yield Buffer.from(c); }
    },
  };
  return { stream, pulled };
}

const never = () => { throw new Error("a request was issued where none was permitted"); };

const one = (status, body, extra = {}) => stubFetch(() => ({ status, body, ...extra }));

const run = (profile, fetchImpl, opts = {}) =>
  discoverProvider({ provider: profile.provider ?? "groq", profile, key: "K" },
                   { fetchImpl, now: () => "2026-01-01T00:00:00.000Z", ...opts });

// =========================================================== the six outcomes

test("a cluster-A `data` envelope yields ok with the entry count", async () => {
  const r = await run(PROF, one(200, { data: [{ id: "m1" }] }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.count, 1);
  assert.equal(r.models.length, 1);
  assert.equal(r.models[0].id, "m1");
  assert.equal(r.envelopeKey, "data");
});

test("a cluster-C `models` envelope yields ok", async () => {
  const r = await run(PROF, one(200, { models: [{ id: "a" }, { id: "b" }] }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.count, 2);
  assert.equal(r.envelopeKey, "models");
  assert.deepEqual(r.models.map((m) => m.id), ["a", "b"]);
});

test("a cluster-F `result` envelope with a `name` id yields ok", async () => {
  // Cloudflare's models/search shape. `idField` is a LIST precisely so the
  // per-entry key is settled by the first live probe rather than guessed.
  const r = await run(PROF, one(200, { result: [{ name: "@cf/openai/gpt-oss-120b" }] }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.envelopeKey, "result");
  assert.equal(r.models[0].id, "@cf/openai/gpt-oss-120b");
});

test("a 2xx with zero entries is `empty`, a true statement about the provider", async () => {
  const r = await run(PROF, one(200, { data: [] }));
  assert.equal(r.outcome, "empty");
  assert.equal(r.status, 200);
  assert.equal(r.envelopeKey, "data");
  assert.deepEqual(r.models, []);
});

test("a 2xx whose envelope is unrecognised is `unsupported-shape` and records the keys it saw", async () => {
  const r = await run(PROF, one(200, { foo: [] }));
  assert.equal(r.outcome, "unsupported-shape");
  assert.deepEqual(r.keys, ["foo"]);
  assert.deepEqual(r.models, []);
});

test("`empty` and `unsupported-shape` never share a bucket", async () => {
  // The plan's mutation: fold `unsupported-shape` into `empty`. This assertion
  // is the one that must die, and it dies on the {"foo":[]} fixture -- the two
  // bodies below are both 200 with an array holding nothing, and they are two
  // different events: one is data, the other is a defect in this parser.
  const a = await run(PROF, one(200, { data: [] }));
  const b = await run(PROF, one(200, { foo: [] }));
  assert.notEqual(a.outcome, b.outcome);
  assert.equal(a.outcome, "empty");
  assert.equal(b.outcome, "unsupported-shape");
  assert.equal(a.keys, undefined, "an empty listing has no shape complaint to record");
  assert.ok(Array.isArray(b.keys), "an unsupported shape must carry what it saw");
});

test("a bare top-level array names what it needs, not its own indices", async () => {
  // `Object.keys` on an array yields ["0","1","2"...], which is not merely
  // useless but actively misleading: it invites the next reader to add an
  // envelope candidate named `0`. The whole stated point of recording these keys
  // is that the next candidate is data rather than a guess, and indices are
  // neither. This is the diagnostic a reader acts on.
  const r = await run(PROF, one(200, [{ id: "m1" }, { id: "m2" }, { id: "m3" }]));
  assert.equal(r.outcome, "unsupported-shape");
  assert.equal(r.keys.length, 1, "one descriptor, not one entry per index");
  assert.match(r.keys[0], /bare top-level array of 3/);
  assert.match(r.keys[0], /root-array branch/);
  assert.equal(r.keys.some((k) => /^\d+$/.test(k)), false, "no index leaked into the diagnostic");
  // An empty array is still a shape this parser does not read, and says so.
  const empty = await run(PROF, one(200, []));
  assert.equal(empty.outcome, "unsupported-shape");
  assert.match(empty.keys[0], /array of 0/);
  // The descriptor is entirely ours: no provider-controlled text rides in.
  const hostile = await run(PROF, one(200, [{ id: "[2J" }]));
  assert.equal(hostile.keys.join("").includes(""), false);
});

test("`listing: null` is `no-endpoint` and opens no socket", async () => {
  const r = await run({ ...PROF, listing: null }, never);
  assert.equal(r.outcome, "no-endpoint");
  assert.equal(r.status, 0);
});

test("an absent `listing` key is not the same as `listing: null`", () => {
  // The positive assertion versus the forgotten entry. Collapsing these is how a
  // provider nobody curated gets silently reported as covered.
  assert.equal(listingProfileFor({ ...PROF, listing: null }), null);
  assert.deepEqual(listingProfileFor(PROF), { ...LISTING_DEFAULTS });
  assert.deepEqual(listingProfileFor({ ...PROF, listing: undefined }), { ...LISTING_DEFAULTS });
});

test("401 and 403 are `auth`", async () => {
  for (const status of [401, 403]) {
    const r = await run(PROF, one(status, null, { throwOnRead: true }));
    assert.equal(r.outcome, "auth", `status ${status}`);
    assert.equal(r.status, status);
  }
});

test("any other status is `error` carrying that status", async () => {
  for (const status of [400, 402, 429, 500, 502]) {
    const r = await run(PROF, one(status, null, { throwOnRead: true }));
    assert.equal(r.outcome, "error", `status ${status}`);
    assert.equal(r.status, status);
  }
});

test("a 200 with a non-JSON body is `error`, not `unsupported-shape`", async () => {
  // An HTML error page served with a 200 is a transport failure, not a novel
  // envelope, and filing it as a parser defect would send the next reader
  // hunting for an envelope key that does not exist.
  const r = await run(PROF, one(200, "<html>captive portal</html>"));
  assert.equal(r.outcome, "error");
  assert.equal(r.reason, REASONS.NON_JSON);
});

// ============================================================ transport rules

test("every 3xx is refused rather than followed, across the whole range", async () => {
  // The lower bound is load-bearing and was untested: `>= 300` relaxed to `> 300`
  // survives a 302-only fixture, and a 301 would then fall through to the generic
  // `error{status}` branch carrying no REDIRECT reason -- the exact reading that
  // makes a re-issued credential look like an ordinary upstream failure.
  for (const status of [300, 301, 302, 307, 308, 399]) {
    const f = one(status, null, { throwOnRead: true });
    const r = await run(PROF, f);
    assert.equal(r.outcome, "error", `status ${status}`);
    assert.equal(r.status, status);
    assert.equal(r.reason, REASONS.REDIRECT, `status ${status} must carry the redirect reason`);
    assert.equal(f.calls.length, 1, "a refused redirect costs exactly one request, never two");
  }
});

test("every request is issued with redirect manual", async () => {
  const f = one(200, { data: [] });
  await run(PROF, f);
  assert.equal(f.calls[0].init.redirect, "manual");
});

test("an http:// listing url is refused before any socket is opened", async () => {
  const r = await run({ ...PROF, baseUrl: "http://api.groq.com/openai/v1" }, never);
  assert.equal(r.outcome, "error");
  assert.equal(r.reason, REASONS.NOT_HTTPS);
  assert.equal(r.status, 0);
});

test("a listing url carrying a query string is refused before any socket is opened", async () => {
  const withQuery = { ...PROF, listing: { url: "https://api.groq.com/openai/v1/models?key=SECRET" } };
  const r = await run(withQuery, never);
  assert.equal(r.outcome, "error");
  assert.equal(r.reason, REASONS.QUERY_STRING);
  // A bare `?` leaves `URL.search` empty, so the raw string is checked too.
  const bare = await run({ ...PROF, listing: { url: "https://api.groq.com/openai/v1/models?" } }, never);
  assert.equal(bare.reason, REASONS.QUERY_STRING);
});

test("a url carrying embedded userinfo is refused", async () => {
  const r = await run({ ...PROF, listing: { url: "https://user:secret@api.groq.com/models" } }, never);
  assert.equal(r.reason, REASONS.USERINFO);
});

test("a pinned provider whose host was edited is refused", async () => {
  // F6: providers.json is unsigned and user-writable. One edited baseUrl would
  // otherwise post a live credential wherever the edit points.
  assert.equal(PINNED_HOSTS.get("groq"), "api.groq.com");
  const r = await run({ ...PROF, baseUrl: "https://evil.example/openai/v1" }, never);
  assert.equal(r.outcome, "error");
  assert.equal(r.reason, REASONS.HOST_MISMATCH);
});

test("the host pin compares the HOSTNAME, so a port survives it -- stated, not implied", () => {
  // Untested, and worth pinning as a limit rather than leaving as an assumption:
  // the comparison is `u.hostname`, which excludes the port, so
  // `https://api.groq.com:8443/...` passes the pin and is reported hostPinned.
  // That is defensible -- it is the same host, and the credential goes to the
  // same party -- but it is a property nobody had written down, and the next
  // reader tightening the pin should find this fixture rather than guess.
  const r = resolveListingUrl("groq", { baseUrl: "https://api.groq.com:8443/openai/v1" });
  assert.equal(r.refusal, undefined);
  assert.equal(r.hostPinned, true);
  assert.equal(r.url, "https://api.groq.com:8443/openai/v1/models");
  // A different host on the standard port is still refused, so the pin has not
  // simply stopped comparing.
  assert.equal(resolveListingUrl("groq", { baseUrl: "https://api.groq.com.evil.test/v1" }).refusal,
               REASONS.HOST_MISMATCH);
  // And the comparison is case-insensitive on the host, as a URL host must be.
  assert.equal(resolveListingUrl("groq", { baseUrl: "https://API.GROQ.COM/openai/v1" }).refusal, undefined);
});

test("an unpinned provider is discovered and marked, not refused", async () => {
  // Adding a provider must never require a source edit. The pin defends the
  // entries that exist against tamper; it is not an admission gate for new ones.
  assert.equal(PINNED_HOSTS.has("brandnew"), false);
  const r = await run({ provider: "brandnew", baseUrl: "https://api.brandnew.test/v1" },
                      one(200, { data: [{ id: "x" }] }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.hostPinned, false);
});

test("the path appended is exactly /models, never a version segment", async () => {
  const cases = [
    ["https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1/models"],
    ["https://api.groq.com/openai/v1/", "https://api.groq.com/openai/v1/models"],
  ];
  for (const [baseUrl, expected] of cases) {
    const f = one(200, { data: [] });
    await run({ ...PROF, baseUrl }, f);
    assert.equal(f.calls[0].url, expected);
    assert.ok(!/\/v1\/v1\//.test(f.calls[0].url), "a second version segment is the cluster-B failure");
  }
});

test("an absolute listing url overrides the baseUrl entirely", () => {
  const r = resolveListingUrl("cloudflare", {
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/abc/ai/v1",
    listing: { url: "https://api.cloudflare.com/client/v4/accounts/abc/ai/models/search" },
  });
  assert.equal(r.url, "https://api.cloudflare.com/client/v4/accounts/abc/ai/models/search");
});

test("a two-line headersTemplate produces both headers", () => {
  // Cluster E. A first-line-only parser silently 401s on the cluster-D provider
  // with three mandatory WAF headers, and that failure is indistinguishable from
  // a revoked key -- which is why this function is lifted, not rewritten.
  const h = headersFor({ headersTemplate: "x-api-key: {key}\nanthropic-version: 2023-06-01" }, "SEKRIT");
  assert.equal(h["x-api-key"], "SEKRIT");
  assert.equal(h["anthropic-version"], "2023-06-01");
  assert.equal(h["Content-Type"], "application/json");

  const three = headersFor(
    { headersTemplate: "Authorization: Bearer {key}\nX-Waf-A: {key}\nX-Waf-B: static" }, "SEKRIT");
  assert.equal(Object.keys(three).length, 4);
  assert.equal(three.Authorization, "Bearer SEKRIT");
  assert.equal(three["X-Waf-A"], "SEKRIT");
});

test("an absent headersTemplate falls back to a bearer token", () => {
  assert.equal(headersFor({}, "SEKRIT").Authorization, "Bearer SEKRIT");
});

test("a proxy variable present at load REFUSES the fan-out rather than being deleted", async () => {
  // REPLACES a test that asserted the variables were deleted. Deletion was the
  // wrong observable: it passed while the interception it named was still live.
  // NODE_OPTIONS is consumed by the runtime before any user code runs, so by the
  // time this module could delete it the preload has already replaced
  // globalThis.fetch -- demonstrated end to end, the variable was deleted and the
  // next request still came back from the preload. The property that is worth
  // asserting is PROTECTION, and deletion is structurally blind to it.
  assert.equal(proxyRefusal({ atLoad: [], execArgv: [] }), null, "a clean load permits the fan-out");
  for (const n of PROXY_ENV) {
    const refusal = proxyRefusal({ atLoad: [n], execArgv: [] });
    assert.match(refusal, /refusing to fan out/);
    assert.ok(refusal.includes(n), `the refusal must name ${n}`);
  }
});

test("a runtime flag on the command line refuses the fan-out, as NODE_OPTIONS does", async () => {
  // NODE_OPTIONS is only ONE of the two routes to a preload, and the environment
  // snapshot does not cover the other. `node --require ./patch.cjs cli.mjs` runs
  // the preload BEFORE this module is parsed, so FETCH_AT_LOAD captures the
  // already-patched function and then compares it with itself: measured, the
  // refusal was null, the fetch was patched, and the fan-out proceeded.
  for (const flag of ["--require", "--import", "--experimental-loader", "--max-old-space-size=4096"]) {
    const refusal = proxyRefusal({ atLoad: [], execArgv: [flag] });
    assert.match(refusal, /refusing to fan out/, `${flag} must refuse`);
    assert.match(refusal, /runtime/);
  }
  // The over-refusal is deliberate and is asserted as such: enumerating the
  // three flags that load code today is a denylist the fourth one defeats.
  assert.notEqual(proxyRefusal({ atLoad: [], execArgv: ["--max-old-space-size=4096"] }), null);
  // The environment snapshot is checked FIRST, so its message is the one a user
  // acting on it sees when both are true.
  assert.match(proxyRefusal({ atLoad: ["NODE_OPTIONS"], execArgv: ["--require"] }), /NODE_OPTIONS/);
});

test("the real process snapshots are frozen arrays, not a live view", () => {
  // Both must be captured at load: by the time discoverAll runs, whatever they
  // set up is in place and the variables themselves may already have been
  // scrubbed -- by this module's own scrubProxyEnv, among others.
  assert.ok(Object.isFrozen(PROXY_ENV_AT_LOAD));
  assert.ok(Object.isFrozen(EXEC_ARGV_AT_LOAD));
  assert.ok(Array.isArray(EXEC_ARGV_AT_LOAD));
});

test("a patched globalThis.fetch refuses the fan-out and issues no request", async () => {
  // The preload attaches by means other than NODE_OPTIONS too, so the env
  // snapshot alone is not the whole guard.
  const original = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { status: 200, text: async () => JSON.stringify({ data: [{ id: "PWNED" }] }) };
    };
    await assert.rejects(
      () => discoverAll([{ provider: "groq", profile: PROF, key: "K" }], { scrub: false }),
      /refusing to fan out/);
    assert.deepEqual(calls, [], "0 requests of 1: the credential never left this process");

    // The branch in isolation. The other two snapshots are neutralised here
    // deliberately: `node --test` populates execArgv with its own defaulted
    // flags, so without pinning them this assertion would pass on the wrong
    // reason and say nothing about the replaced fetch at all.
    assert.match(proxyRefusal({ atLoad: [], execArgv: [] }), /globalThis\.fetch was replaced/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(proxyRefusal({ atLoad: [], execArgv: [] }), null,
    "and the guard passes again once the patch is gone");
});

test("scrubProxyEnv names every variable it removed, in either case", () => {
  const env = { HTTPS_PROXY: "x", NODE_OPTIONS: "y" };
  assert.deepEqual(scrubProxyEnv(env).sort(), ["HTTPS_PROXY", "NODE_OPTIONS"]);
  assert.deepEqual(Object.keys(env), []);
  assert.deepEqual(scrubProxyEnv({}), []);

  // The lowercase pass is not Windows-redundant off Windows, where `https_proxy`
  // and `HTTPS_PROXY` are genuinely distinct slots -- and it is the lowercase
  // spelling that curl-shaped tooling actually sets. Dropping the pass left
  // every uppercase-only fixture green.
  const lower = {};
  for (const n of PROXY_ENV) lower[n.toLowerCase()] = "http://proxy.invalid:8080";
  lower.keep_me = "untouched";
  assert.deepEqual(scrubProxyEnv(lower).sort(), PROXY_ENV.map((n) => n.toLowerCase()).sort());
  assert.deepEqual(Object.keys(lower), ["keep_me"]);

  // And the deletion is still claimed for what it can do: a child spawned with
  // this object inherits the scrubbed copy.
  const mixed = { HTTP_PROXY: "a", http_proxy: "b", KEEP_ME: "untouched" };
  scrubProxyEnv(mixed);
  assert.deepEqual(Object.keys(mixed), ["KEEP_ME"]);
});

test("concurrency never exceeds six in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return { status: 200, text: async () => JSON.stringify({ data: [] }) };
  };
  const targets = Array.from({ length: 30 }, (_, i) => ({ provider: `p${i}`, profile: { baseUrl: "https://h.test/v1" }, key: "K" }));
  const results = await discoverAll(targets, { fetchImpl, scrub: false });
  assert.equal(results.length, 30);
  assert.ok(peak <= 6, `peak in flight was ${peak} of a permitted 6`);
  assert.ok(peak > 1, `the fan-out did not run in parallel at all (peak ${peak} of 6)`);
});

test("the auth failure budget is per provider and never global", async () => {
  // Three unrelated expired keys must not curtail the fan-out for everybody
  // else: an auth failure is account state to surface, not a reason to stop.
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { status: 401, text: async () => "" }; };
  const targets = [
    ...Array.from({ length: 5 }, () => ({ provider: "dead", profile: { baseUrl: "https://dead.test/v1" }, key: "K" })),
    { provider: "alive", profile: { baseUrl: "https://alive.test/v1" }, key: "K" },
  ];
  // concurrency 1 so the order in which the budget is spent is deterministic.
  const results = await discoverAll(targets, { fetchImpl, scrub: false, concurrency: 1 });

  const dead = results.filter((r) => r.provider === "dead");
  assert.equal(dead.filter((r) => r.outcome === "auth").length, 3, "3 of 5 requests before the budget stops");
  assert.equal(dead.filter((r) => r.reason === REASONS.AUTH_BUDGET).length, 2, "2 of 5 stopped unsent");

  const alive = results.find((r) => r.provider === "alive");
  assert.equal(alive.outcome, "auth", "a global budget would have stopped this provider unsent");
  assert.equal(seen.filter((u) => u.startsWith("https://alive.test")).length, 1,
    "the second provider was still reached, 1 request of 1");
});

test("the budget counts auth failures, never requests in flight", async () => {
  // The counter must not be a semaphore. Reserving a slot before the await made
  // it exactly that: with six workers and six all-200 targets, three workers
  // reserved, the fourth read the three reservations and refused WITHOUT EVER
  // ISSUING A REQUEST -- three spurious auth-budget refusals on a provider that
  // answered every time. Ten 500s behaved identically. A healthy fan-out must
  // refuse nothing, whatever the concurrency.
  for (const status of [200, 500, 404]) {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(url);
      return { status, text: async () => JSON.stringify({ data: [] }) };
    };
    const targets = Array.from({ length: 12 }, () =>
      ({ provider: "healthy", profile: { baseUrl: "https://healthy.test/v1" }, key: "K" }));
    const results = await discoverAll(targets, { fetchImpl, scrub: false });
    assert.equal(seen.length, 12, `12 requests of 12 were issued at status ${status}`);
    assert.equal(results.filter((r) => r.reason === REASONS.AUTH_BUDGET).length, 0,
      `status ${status} produced a spurious auth-budget refusal`);
  }
});

test("dispatch stops once three consecutive auth failures have been OBSERVED", async () => {
  // The achievable promise, stated as the code now implements it: stop
  // DISPATCHING at three observations. Up to `concurrency` requests may already
  // be in flight when the third lands, so the number sent is bounded by
  // `authBudget - 1 + concurrency`, not by `authBudget`.
  const sentAt = (concurrency, targetCount) => {
    const seen = [];
    const fetchImpl = async (url) => { seen.push(url); return { status: 401, text: async () => "" }; };
    const targets = Array.from({ length: targetCount }, () =>
      ({ provider: "dead", profile: { baseUrl: "https://dead.test/v1" }, key: "K" }));
    return discoverAll(targets, { fetchImpl, scrub: false, concurrency })
      .then((results) => ({ seen, results }));
  };

  // Serial: exactly the budget, and every one of them a real request.
  const serial = await sentAt(1, 20);
  assert.equal(serial.seen.length, 3, "3 requests of 20 at concurrency 1");
  assert.equal(serial.results.filter((r) => r.outcome === "auth").length, 3);
  assert.equal(serial.results.filter((r) => r.reason === REASONS.AUTH_BUDGET).length, 17);

  // Concurrent: still bounded, and still stops well short of the 20 targets.
  const parallel = await sentAt(6, 20);
  assert.ok(parallel.seen.length >= 3, `${parallel.seen.length} sent, at least the budget`);
  assert.ok(parallel.seen.length <= 3 - 1 + 6,
    `${parallel.seen.length} sent, over the authBudget - 1 + concurrency bound of 8`);
  assert.ok(parallel.results.some((r) => r.reason === REASONS.AUTH_BUDGET),
    "the budget stopped the remainder rather than letting all 20 through");
  assert.equal(parallel.results.length, 20, "and every target still produced a record");
});

test("concurrency 0 still resolves every target rather than silently returning none", async () => {
  // `Math.max(1, concurrency)` is the only thing between a caller's 0 and a
  // fan-out with no workers, which returns an empty array and no error at all --
  // a run that reports zero providers attempted and looks like a clean result.
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ data: [] }) });
  const targets = Array.from({ length: 4 }, (_, i) =>
    ({ provider: `p${i}`, profile: { baseUrl: `https://p${i}.test/v1` }, key: "K" }));
  for (const concurrency of [0, -1]) {
    const results = await discoverAll(targets, { fetchImpl, scrub: false, concurrency });
    assert.equal(results.length, 4, `concurrency ${concurrency} resolved 4 targets of 4`);
  }
});

test("a non-auth outcome resets that provider's consecutive counter", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    return n === 3
      ? { status: 200, text: async () => JSON.stringify({ data: [] }) }
      : { status: 401, text: async () => "" };
  };
  const targets = Array.from({ length: 6 }, () => ({ provider: "flappy", profile: { baseUrl: "https://f.test/v1" }, key: "K" }));
  const results = await discoverAll(targets, { fetchImpl, scrub: false, concurrency: 1 });
  // 2 auth, 1 empty (counter reset), 3 more auth -- 6 of 6 requests actually sent.
  assert.equal(n, 6);
  assert.equal(results.filter((r) => r.reason === REASONS.AUTH_BUDGET).length, 0);
});

// =============================================================== the KEEP list

test("the projection keeps exactly the four allowlisted fields", () => {
  // An ALLOWLIST, never "everything except a deny list". The inverted form
  // re-admits exactly the org identifiers, account ids and balances below.
  const m = projectModel({
    id: "m1",
    capability: "chat",
    context_length: 128000,
    modalities: ["text", "image"],
    // everything past here is what the cache must never hold:
    owned_by: "org-4f2a-account-91",
    organization: "acme-inc",
    credits_remaining: 4.21,
    rate_limit: { rpm: 60 },
    pricing: { prompt: "0.0000005" },
    description: "raw provider prose",
  });
  assert.deepEqual(Object.keys(m).sort(), ["capabilityRaw", "contextLength", "id", "modalityHints"]);
  assert.equal(m.id, "m1");
  assert.equal(m.capabilityRaw, "chat");
  assert.equal(m.contextLength, 128000);
  assert.deepEqual(m.modalityHints, ["image", "text"]);
  assert.equal(JSON.stringify(m).includes("acme-inc"), false);
  assert.equal(JSON.stringify(m).includes("4.21"), false);
});

test("the four keys are always present, so absence is stated rather than implied", () => {
  const m = projectModel({ id: "bare" });
  assert.deepEqual(Object.keys(m).sort(), ["capabilityRaw", "contextLength", "id", "modalityHints"]);
  assert.equal(m.capabilityRaw, null);
  assert.equal(m.contextLength, null);
  assert.deepEqual(m.modalityHints, []);
});

test("capabilityRaw survives from whichever field the provider used", () => {
  // Eleven providers return a capability-shaped field and they do not agree on
  // the name. The names are data, the same treatment idField gets.
  assert.equal(projectModel({ id: "a", capability: "image_gen" }).capabilityRaw, "image_gen");
  assert.equal(projectModel({ id: "a", model_type: "chat" }).capabilityRaw, "chat");
  assert.equal(projectModel({ id: "a", type: "embedding" }).capabilityRaw, "embedding");
  // A per-provider override replaces the candidate list wholesale.
  assert.equal(
    projectModel({ id: "a", kind: "rerank" }, { ...LISTING_DEFAULTS, capabilityField: ["kind"] }).capabilityRaw,
    "rerank");
});

test("a capability field carrying a control sequence is dropped, not stored", () => {
  const m = projectModel({ id: "a", capability: "chat\u001b[2J" });
  assert.equal(m.capabilityRaw, null);
  assert.equal(m.id, "a", "the model itself still survives; only the unsafe field is refused");
});

test("the projections take the first USABLE candidate, not the first present one", () => {
  // Measured, and every line below returned null before this: an unusable
  // earlier candidate destroyed a perfectly good later one. The refusal of the
  // unusable VALUE is unchanged -- "128k" is still never coerced into a number,
  // an escape-carrying token is still never stored. Skipping the valid sibling
  // was the bug; the refusal was not.
  const both = projectModel({ id: "a", context_length: "128k", max_input_tokens: 131072 });
  assert.equal(both.contextLength, 131072, "the string sibling must not cost the integer one");

  const hostileFirst = projectModel({ id: "a", capability: "chat[2J", model_type: "chat" });
  assert.equal(hostileFirst.capabilityRaw, "chat");

  // Out of range is skipped on the same rule, not taken as a final answer.
  assert.equal(projectModel({ id: "a", context_length: 0, max_input_tokens: 8192 }).contextLength, 8192);
  assert.equal(projectModel({ id: "a", context_length: 99_000_000, context_window: 4096 }).contextLength, 4096);
  // With no usable candidate anywhere, unknown still reads as unknown.
  assert.equal(projectModel({ id: "a", context_length: "128k" }).contextLength, null);
  assert.equal(projectModel({ id: "a", capability: "chat[2J" }).capabilityRaw, null);
});

test("a capability arriving as an array is read rather than dropped", () => {
  // `capabilities: ["chat","vision"]` is a real shape, and arrays were taken in
  // modalityHintsOf while being dropped here -- so one provider answer read as
  // present in one projection and absent in the other.
  assert.equal(projectModel({ id: "a", capabilities: ["chat", "vision"] }).capabilityRaw, "chat");
  assert.equal(projectModel({ id: "a", capabilities: ["chat[2J", "vision"] }).capabilityRaw, "vision",
    "a hostile element does not cost the clean one beside it");
  assert.equal(projectModel({ id: "a", capabilities: [] }).capabilityRaw, null);
  assert.equal(projectModel({ id: "a", capabilities: [42, null] }).capabilityRaw, null);

  // A context length arriving as an array is deliberately NOT unwrapped: nobody
  // has observed that shape, and picking an element would be a guess about which
  // token count it names. Unknown reads as unknown, which is the whole rule.
  assert.equal(projectModel({ id: "a", context_length: [128000] }).contextLength, null);
});

test("a capability token is capped at 64 code points", () => {
  // admitId admits up to 128, so without the cap a 128-character provider token
  // reaches the cache and from there a display cell sized for a word.
  assert.equal([...projectModel({ id: "a", capability: "c".repeat(100) }).capabilityRaw].length, 64);
  assert.equal(projectModel({ id: "a", capability: "c".repeat(64) }).capabilityRaw.length, 64);
  assert.equal(projectModel({ id: "a", capability: "chat" }).capabilityRaw, "chat");
  // Capped by CODE POINT, so an astral token is never cut through a surrogate
  // pair -- the same rule sanitizeDisplay slices by, and for the same reason.
  const astral = projectModel({ id: "a", capability: "\u{1F600}".repeat(80) }).capabilityRaw;
  assert.equal([...astral].length, 64);
  assert.equal(astral.includes("�"), false, "no lone surrogate reached the record");
});

test("an empty first idField falls through to the next candidate", () => {
  // Cloudflare's shape, and cloudflare is in the acceptance set: `result` entries
  // carry both `id` and `name`. Dropping the `!== ""` test makes `raw` the empty
  // string, admitId refuses it, and the whole model is discarded -- for a
  // provider that named itself perfectly well in the very next field.
  assert.equal(projectModel({ id: "", name: "@cf/openai/gpt-oss-120b" }).id, "@cf/openai/gpt-oss-120b");
  assert.equal(projectModel({ id: "real", name: "ignored" }).id, "real");
  assert.equal(projectModel({ id: "", name: "" }), null, "no admissible id anywhere is still null");
  // A non-string first candidate falls through on the same rule.
  assert.equal(projectModel({ id: 42, name: "fallback" }).id, "fallback");
});

test("contextLength is range-checked exactly as the catalogue admission does", () => {
  const ctx = (v) => projectModel({ id: "a", context_length: v }).contextLength;
  assert.equal(ctx(128000), 128000);
  assert.equal(ctx(1), 1);
  assert.equal(ctx(20_000_000), 20_000_000);
  assert.equal(ctx(20_000_001), null);
  assert.equal(ctx(0), null);
  assert.equal(ctx(-5), null);
  assert.equal(ctx(1.5), null);
  // Not coerced from a string: a provider sending "128k" must read as unknown
  // rather than as a number this parser invented.
  assert.equal(ctx("128000"), null);
  assert.equal(ctx("128k"), null);
});

test("modalityHints are filtered to the known vocabulary and never passed through raw", () => {
  const hints = (e) => projectModel({ id: "a", ...e }).modalityHints;
  assert.deepEqual(hints({ modalities: ["text", "image", "telepathy"] }), ["image", "text"]);
  assert.deepEqual(hints({ modality: "text->image" }), ["image", "text"]);
  // An escape glued to a known word does NOT yield that word: the split runs on
  // letters, so ESC [ 2 J text lowercases and tokenises as jtext, which is not
  // in the vocabulary. Nothing is kept, and nothing hostile survives.
  assert.deepEqual(hints({ modalities: ["\u001b[2Jtext"] }), []);
  // A hostile sibling does not cost a clean element.
  assert.deepEqual(hints({ modalities: ["\u001b[2J", "text"] }), ["text"]);
  assert.deepEqual(hints({ modalities: [] }), []);
  assert.deepEqual(hints({ modalities: "not-a-known-word" }), []);
  // Both directions are true and both are wanted; the hint set is a union.
  assert.deepEqual(hints({ input_modalities: ["text"], output_modalities: ["audio"] }), ["audio", "text"]);
  for (const h of hints({ modalities: ["text", "image", "audio", "video"] })) {
    assert.ok(MODALITY_VOCAB.includes(h));
  }
});

test("a hostile model id is refused rather than sanitised", () => {
  // It becomes a routing selector, so a cosmetic repair would keep an
  // attacker-shaped id in the routing table.
  for (const bad of ["a\u001b[2Jb", "../../etc/passwd", "a\\b", "-flag", " opus", "x\u202Ey", ""]) {
    assert.equal(projectModel({ id: bad }), null, JSON.stringify(bad));
  }
  assert.equal(projectModel({ id: "groq/openai/gpt-oss-20b" }).id, "groq/openai/gpt-oss-20b");
  assert.equal(projectModel({ id: "@cf/openai/gpt-oss-120b" }).id, "@cf/openai/gpt-oss-120b");
});

test("a listing is bounded by ENTRY COUNT, not only by byte ceiling", async () => {
  // Measured: a 6.38 MB body of `{"id":"mN"}` -- well under the 8 MB ceiling --
  // yielded ok with 400,000 models and a 45.7 MB record, which lastGood then
  // carried into every later failure and re-serialised on each write. A short
  // entry is cheap in the body and expensive in the record.
  const entries = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` }));
  const r = await run(PROF, one(200, { data: entries }), { maxEntries: 100 });
  assert.equal(r.outcome, "ok");
  assert.equal(r.count, 500, "count keeps the RAW entry count, so the denominator stays true");
  assert.equal(r.models.length, 100, "100 kept of 500");
  assert.equal(r.truncated, 400, "and the 400 dropped are named rather than left to be inferred");
  assert.equal(r.rejected, 0, "dropped past the cap is not the same event as an id refused");
  assert.deepEqual(r.models.at(-1).id, "m99", "the cap takes a prefix, not a sample");

  // Under the cap, nothing is truncated and the field is still present.
  const small = await run(PROF, one(200, { data: entries.slice(0, 3) }), { maxEntries: 100 });
  assert.equal(small.truncated, 0);
  assert.equal(small.models.length, 3);

  // The real default is a ceiling no legitimate listing approaches.
  assert.ok(MAX_ENTRIES >= 5000, `${MAX_ENTRIES} must clear the largest real listing`);
  const real = await run(PROF, one(200, { data: entries }));
  assert.equal(real.truncated, 0, "500 entries is an ordinary listing, not a truncation");
});

test("`rejected` and `truncated` are 0 on every non-ok record, never absent", async () => {
  // Both are persisted on every outcome and both were asserted only inside the
  // `ok` branch. A record carrying `rejected: undefined` reads as "unknown" to a
  // consumer that has been told the field is always present -- the same failure
  // as the four projected model fields, which is why those are always present.
  const cases = [
    [one(200, { data: [] }), "empty"],
    [one(200, { foo: 1 }), "unsupported-shape"],
    [one(401, null, { throwOnRead: true }), "auth"],
    [one(500, null, { throwOnRead: true }), "error"],
  ];
  for (const [f, outcome] of cases) {
    const r = await run(PROF, f);
    assert.equal(r.outcome, outcome);
    assert.equal(r.rejected, 0, `${outcome} must state 0 refused, not omit the field`);
    assert.equal(r.truncated, 0, `${outcome} must state 0 truncated, not omit the field`);
    assert.equal(r.count, 0);
  }
  // And on the paths that never reached a host at all.
  for (const r of [await run({ ...PROF, listing: null }, never),
                   await run({ ...PROF, baseUrl: "http://api.groq.com/v1" }, never)]) {
    assert.equal(r.rejected, 0);
    assert.equal(r.truncated, 0);
  }
});

test("a status that arrives as a string is still classified, not silently reclassified", async () => {
  // `Number(res.status)` is the only thing standing between `"401"` and the
  // generic error branch: `"401" === 401` is false, so a stringly-typed status
  // from any non-conforming Response shim turns an expired key into an
  // indistinguishable upstream failure, and R11 prunes the provider.
  const asString = await run(PROF, stubFetch(() => ({ status: "401", throwOnRead: true })));
  assert.equal(asString.outcome, "auth", "a string 401 is still auth");
  assert.equal(asString.status, 401);
  assert.equal(typeof asString.status, "number", "the persisted status is always a number");

  const okString = await run(PROF, stubFetch(() => ({ status: "200", body: { data: [{ id: "m1" }] } })));
  assert.equal(okString.outcome, "ok");
  assert.equal(okString.status, 200);
  assert.equal(typeof okString.status, "number");
});

test("a refused id is counted, not folded into the total silently", async () => {
  const r = await run(PROF, one(200, { data: [{ id: "good" }, { id: "b\u001b[2Jd" }, { id: "also-good" }] }));
  assert.equal(r.outcome, "ok");
  assert.equal(r.count, 3, "the raw entry count is what ok{n} reports");
  assert.equal(r.models.length, 2);
  assert.equal(r.rejected, 1);
});

test("a listing whose every id is refused is ok with zero models, never `empty`", () => {
  // `empty` is a true statement about the PROVIDER. A listing of 3 hostile ids
  // is a finding about our own corpus and must not wear the provider's label.
  const c = classifyOutcome({ status: 200, json: { data: [{ id: "a\u001b[2J" }] }, listing: LISTING_DEFAULTS });
  assert.equal(c.outcome, "ok");
});

test("an entry that is not an object is dropped", () => {
  for (const e of [null, "m1", 42, ["m1"], undefined]) assert.equal(projectModel(e), null);
});

// ======================================================= what never persists

test("no key value appears anywhere in a result record", async () => {
  const KEY = "sk-do-not-leak-0123456789";
  const r = await run({ ...PROF, headersTemplate: "Authorization: Bearer {key}\nx-api-key: {key}" },
                      one(200, { data: [{ id: "m1" }] }), {});
  const withKey = await discoverProvider(
    { provider: "groq", profile: { ...PROF, headersTemplate: "Authorization: Bearer {key}" }, key: KEY },
    { fetchImpl: one(200, { data: [{ id: "m1" }] }), now: () => "t" });
  assert.equal(JSON.stringify(withKey).includes(KEY), false);
  assert.equal(JSON.stringify(withKey).includes("Authorization"), false);
  assert.equal(JSON.stringify(r).includes("Bearer"), false);
});

test("the body of a non-2xx is never read, so provider error text cannot enter the process", async () => {
  // The stub throws if text() is called. Dropping the text later would still
  // have put it in a heap and in every crash artifact.
  for (const status of [401, 429, 500]) {
    const r = await run(PROF, one(status, "insufficient credits for account 4f2a", { throwOnRead: true }));
    assert.ok(["auth", "error"].includes(r.outcome));
    assert.equal(JSON.stringify(r).includes("4f2a"), false);
  }
});

test("a record holds only the outcome enum, a status, a fixed reason and projected models", async () => {
  const r = await run(PROF, one(200, { data: [{ id: "m1", owned_by: "org-secret" }] }));
  const allowed = new Set(["provider", "at", "outcome", "status", "envelopeKey", "count",
                           "rejected", "truncated", "models", "keys", "reason", "hostPinned",
                           "responded", "lastGood"]);
  for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected persisted field: ${k}`);
  assert.equal(JSON.stringify(r).includes("org-secret"), false);

  // AND ON DISK. This control guards the cache's disclosure surface, and until
  // now it ran on discoverProvider's return value only -- one function short of
  // the file, with writeCacheRecord merging `lastGood` in afterwards. The bytes
  // that actually land are what the allowlist has to bound.
  const dir = path.join(SCRATCH, "persisted-shape");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = { run: (args) => (args.length > 1 ? "" : `${args[0]} HOST\\osami:(F)\r\n`) };
  const opts = { dir, user: "osami", acl };
  writeCacheRecord(await run(PROF, one(200, { data: [{ id: "m1", owned_by: "org-secret" }] })), opts);
  writeCacheRecord(await run(PROF, one(403, null, { throwOnRead: true })), opts);

  const onDisk = JSON.parse(fs.readFileSync(cacheFileFor("groq", dir), "utf8"));
  for (const k of Object.keys(onDisk)) assert.ok(allowed.has(k), `unexpected field ON DISK: ${k}`);
  assert.deepEqual(Object.keys(onDisk.lastGood), [...LAST_GOOD_KEYS]);
  const modelKeys = new Set(["id", "capabilityRaw", "contextLength", "modalityHints"]);
  for (const m of onDisk.lastGood.models) {
    for (const k of Object.keys(m)) assert.ok(modelKeys.has(k), `unexpected model field ON DISK: ${k}`);
  }
  assert.equal(fs.readFileSync(cacheFileFor("groq", dir), "utf8").includes("org-secret"), false);
});

test("a carried listing is bounded in BYTES, which no key allowlist can do", () => {
  // The allowlist above pins field NAMES, and a 45.7 MB `lastGood` satisfies it
  // perfectly -- so the size bound is a separate control and needs its own
  // assertion. Measured before it existed: a 6.38 MB body under the byte ceiling
  // produced a 45.7 MB record, which `lastGood` then carried into every later
  // failure and re-serialised on each write.
  const huge = Array.from({ length: 20_000 }, (_, i) => ({
    id: `provider/family/model-variant-${i}`, capabilityRaw: "chat",
    contextLength: 131072, modalityHints: ["image", "text"],
  }));
  const prior = { provider: "groq", at: "day-1", outcome: "ok", status: 200, count: 20_000, models: huge };
  const today = { provider: "groq", at: "day-2", outcome: "auth", status: 403, models: [] };

  // The byte budget binds at the shipped values: a projected model does not fit
  // in the 52 bytes that 5,000 of them would need to stay under 256 KB.
  const real = lastGoodOf(today, prior);
  assert.ok(real.models.length > 0, "the bound must carry something, not everything or nothing");
  assert.ok(real.models.length < 20_000, "20,000 models were carried through unbounded");
  assert.ok(Buffer.byteLength(JSON.stringify(real.models), "utf8") <= LAST_GOOD_MAX_BYTES,
    `carried ${Buffer.byteLength(JSON.stringify(real.models), "utf8")} bytes over a ${LAST_GOOD_MAX_BYTES} budget`);
  assert.equal(real.count, 20_000, "the prior listing's true denominator survives the truncation");

  // The two bounds bind on different things, so each is asserted where it bites.
  // Entry cap, with a byte budget too large to be the constraint:
  const byEntries = lastGoodOf(today, prior, { maxEntries: 7, maxBytes: 1 << 30 });
  assert.equal(byEntries.models.length, 7);
  // Byte budget, with an entry cap too large to be the constraint:
  const byBytes = lastGoodOf(today, prior, { maxEntries: 20_000, maxBytes: 400 });
  assert.ok(byBytes.models.length >= 1 && byBytes.models.length <= 4,
    `${byBytes.models.length} models in a 400-byte budget`);
  assert.ok(Buffer.byteLength(JSON.stringify(byBytes.models), "utf8") <= 400 + 200,
    "the budget is checked before the model is kept, not after the whole array is built");

  // And end to end, through the file that actually lands on disk.
  const dir = path.join(SCRATCH, "lastgood-bytes");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = { run: (args) => (args.length > 1 ? "" : `${args[0]} HOST\\osami:(F)\r\n`) };
  const opts = { dir, user: "osami", acl };
  writeCacheRecord(prior, opts);
  writeCacheRecord(today, opts);
  const file = cacheFileFor("groq", dir);
  assert.ok(fs.statSync(file).size < 4 << 20, `the record on disk is ${fs.statSync(file).size} bytes`);
  assert.equal(readCacheRecord("groq", opts).lastGood.models.length, real.models.length);
});

test("a planted prior record cannot widen the shape of what gets written back", () => {
  // `lastGood` is built field by field for this reason: a prior record is a file
  // on disk, and spreading it would let whatever is in that file decide what
  // this code persists -- which is the allowlist above ceasing to be a bound.
  const dir = path.join(SCRATCH, "shape-widening");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = { run: (args) => (args.length > 1 ? "" : `${args[0]} HOST\\osami:(F)\r\n`) };
  const opts = { dir, user: "osami", acl };

  writeCacheRecord({
    provider: "groq", at: "day-1", outcome: "ok", status: 200, count: 1,
    models: [{ id: "m1", owned_by: "org-4f2a", credits_remaining: 4.21 }],
    smuggled: "should never survive", lastGood: { injected: true },
  }, opts);
  writeCacheRecord({ provider: "groq", at: "day-2", outcome: "auth", status: 403, models: [] }, opts);

  const after = readCacheRecord("groq", opts);
  assert.deepEqual(Object.keys(after.lastGood), [...LAST_GOOD_KEYS]);
  assert.equal(JSON.stringify(after.lastGood).includes("smuggled"), false);
  assert.equal(JSON.stringify(after.lastGood).includes("injected"), false);
  // The models carried forward are re-projected, so the prior file's extra
  // per-model fields do not ride along either.
  assert.deepEqual(Object.keys(after.lastGood.models[0]).sort(),
                   ["capabilityRaw", "contextLength", "id", "modalityHints"]);
  assert.equal(JSON.stringify(after.lastGood).includes("org-4f2a"), false);
  assert.equal(JSON.stringify(after.lastGood).includes("4.21"), false);
});

test("observed keys on an unsupported shape are bounded and display-sanitised", async () => {
  const wide = {};
  for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i;
  wide["ho\u001b[2Jstile"] = 1;
  const r = await run(PROF, one(200, wide));
  assert.equal(r.outcome, "unsupported-shape");
  assert.equal(r.keys.length, 20, "20 of 41 keys recorded");
  // NOTE: this fixture's hostile key is 41st of 41, so the bound discards it
  // before the sanitiser is consulted. The test below covers the kept ones.
  const all = r.keys.join("|");
  assert.equal(all.includes("\u001b"), false);
});

test("the sanitiser reaches the observed keys that are actually KEPT", async () => {
  // The fixture above puts its hostile key 41st of 41, so the 20-key bound
  // discards it before the sanitiser is ever consulted -- which left deleting
  // sanitizeDisplay entirely green. These keys all land inside the kept 20, where
  // the sanitiser is the only thing between a provider-controlled string and a
  // terminal: cli.mjs prints this record as `top-level keys: ...`.
  const hostile = {
    "ho[2Jstile": 1,               // CSI, clears the screen
    "cur[1Asor": 2,                // moves the cursor over a row already drawn
    "rtl‮gnp.exe": 3,               // renders the rest of the cell reversed
    "zero​width": 4,                // length without a column
    "nl\nand\rcr": 5,                    // a newline breaks the frame outright
  };
  const r = await run(PROF, one(200, hostile));
  assert.equal(r.outcome, "unsupported-shape");
  assert.equal(r.keys.length, 5, "5 of 5 keys are inside the bound, so all 5 are kept");
  const all = r.keys.join("|");
  for (const bad of ["", "‮", "​", "\n", "\r"]) {
    assert.equal(all.includes(bad), false, `${JSON.stringify(bad)} reached the record`);
  }
  assert.deepEqual(r.keys, ["hostile", "cursor", "rtlgnp.exe", "zerowidth", "nlandcr"]);

  // And the per-key length bound, which no fixture reached either.
  const long = await run(PROF, one(200, { [`k${"y".repeat(200)}`]: 1 }));
  assert.equal([...long.keys[0]].length, 40, "40 code points of 201");
});

// ================================================================== the cache

test("the cache path is a hash, never the provider name", () => {
  const f = cacheFileFor("groq", "C:/tmp");
  assert.equal(path.basename(f).includes("groq"), false);
  assert.match(path.basename(f), /^[0-9a-f]{32}\.json$/);
  // Stable, and distinct per provider.
  assert.equal(cacheFileFor("groq", "C:/tmp"), f);
  assert.notEqual(cacheFileFor("deepseek", "C:/tmp"), f);
  // A name that would otherwise reach a filesystem path cannot.
  const evil = cacheFileFor("../../Windows/System32/x", "C:/tmp");
  assert.equal(path.dirname(evil), path.normalize("C:/tmp"));
});

test("aclPrincipals reads a multi-principal icacls listing", () => {
  const out = [
    "C:\\tmp\\x.json BUILTIN\\Administrators:(F)",
    "               NT AUTHORITY\\SYSTEM:(F)",
    "               DESKTOP-1\\osami:(OI)(CI)(F)",
    "",
    "Successfully processed 1 files; Failed processing 0 files",
  ].join("\r\n");
  assert.deepEqual(aclPrincipals(out, "C:\\tmp\\x.json"),
                   ["BUILTIN\\Administrators", "NT AUTHORITY\\SYSTEM", "DESKTOP-1\\osami"]);
  assert.equal(isOwnerOnly(out, "osami", "C:\\tmp\\x.json"), false);

  const solo = "C:\\tmp\\x.json DESKTOP-1\\osami:(F)\r\n\r\nSuccessfully processed 1 files";
  assert.equal(isOwnerOnly(solo, "osami", "C:\\tmp\\x.json"), true);
  assert.equal(isOwnerOnly(solo, "someoneelse", "C:\\tmp\\x.json"), false);
});

test("a cache write applies and verifies an owner-only ACL", () => {
  const dir = path.join(SCRATCH, "acl-stub");
  fs.rmSync(dir, { recursive: true, force: true });
  const grants = [];
  const acl = {
    run: (args) => {
      if (args.length > 1) { grants.push(args); return ""; }
      return `${args[0]} HOST\\osami:(F)\r\n`;
    },
  };
  const file = writeCacheRecord({ provider: "groq", outcome: "empty", status: 200, models: [] },
                                { dir, user: "osami", acl });
  assert.equal(fs.existsSync(file), true);
  // Applied to the directory AND to the file, and the file's grant lands on the
  // temp name -- so the record never exists at its final path in a readable
  // state. This is the property `ensureBackupDir`'s create-once form lacks.
  assert.equal(grants.length, 2, "2 grants of 2: the directory and the record");
  assert.ok(grants[0][0].endsWith("acl-stub"));
  assert.ok(grants[1][0].includes(".tmp-"));
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0, "no temp file survives");
});

test("a cache write refuses to keep a record it could not lock down", () => {
  const dir = path.join(SCRATCH, "acl-fail");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = { run: (args) => (args.length > 1 ? "" : `${args[0]} NT AUTHORITY\\SYSTEM:(F)\r\n${args[0]} HOST\\osami:(F)\r\n`) };
  assert.throws(() => writeCacheRecord({ provider: "groq", outcome: "empty", models: [] },
                                       { dir, user: "osami", acl }), /owner/);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing is left behind on a refused write");
});

test("a cache write verifies the record at its FINAL name, not only at its temp name", () => {
  // Found by mutation: deleting the post-rename verification killed no test,
  // because every stub above answers owner-only for whatever path it is handed.
  // This stub distinguishes them, so the second verification is the only thing
  // standing between a loose DACL and a kept inventory file.
  const dir = path.join(SCRATCH, "acl-rename");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = {
    run: (args) => {
      if (args.length > 1) return "";                       // the grant
      // The directory and the temp file report locked; only the record at its
      // final `.json` name reports loose.
      return args[0].endsWith(".json")
        ? `${args[0]} Everyone:(F)\r\n`
        : `${args[0]} HOST\\osami:(F)\r\n`;
    },
  };
  assert.throws(() => writeCacheRecord({ provider: "groq", outcome: "empty", models: [] },
                                       { dir, user: "osami", acl }), /owner-only after the write/);
  assert.deepEqual(fs.readdirSync(dir), [], "a record that could not be verified is not kept");
});

test("a cache read refuses a file that is not owner-only", () => {
  const dir = path.join(SCRATCH, "acl-read");
  fs.rmSync(dir, { recursive: true, force: true });
  const ok = { run: (args) => (args.length > 1 ? "" : `${args[0]} HOST\\osami:(F)\r\n`) };
  writeCacheRecord({ provider: "groq", outcome: "ok", status: 200, models: [{ id: "m1" }] },
                   { dir, user: "osami", acl: ok });
  assert.equal(readCacheRecord("groq", { dir, user: "osami", acl: ok }).models[0].id, "m1");

  const loose = { run: (args) => `${args[0]} Everyone:(F)\r\n` };
  assert.throws(() => readCacheRecord("groq", { dir, user: "osami", acl: loose }), /owner-only/);
  assert.equal(readCacheRecord("absent-provider", { dir, user: "osami", acl: ok }), null);
});

test("the owner appearing FIRST among several principals is still not owner-only", () => {
  // `names.length !== 1` relaxed to `names.length < 1` survives every fixture
  // that lists the owner last, because those return false on the name compare
  // anyway. Owner-first is the arrangement that tells the count rule apart from
  // the name rule -- and it is the arrangement icacls actually prints when the
  // owner holds an explicit ACE ahead of the inherited ones.
  const ownerFirst = [
    "C:\\tmp\\x.json DESKTOP-1\\osami:(F)",
    "               BUILTIN\\Administrators:(F)",
    "               NT AUTHORITY\\SYSTEM:(F)",
  ].join("\r\n");
  assert.deepEqual(aclPrincipals(ownerFirst, "C:\\tmp\\x.json").length, 3);
  assert.equal(isOwnerOnly(ownerFirst, "osami", "C:\\tmp\\x.json"), false,
    "the owner being present is not the same as the owner being alone");

  // Two principals, both spelling the owner: still not one ACE.
  const twice = "C:\\tmp\\x.json DESKTOP-1\\osami:(F)\r\n               DESKTOP-1\\osami:(R)";
  assert.equal(isOwnerOnly(twice, "osami", "C:\\tmp\\x.json"), false);
  // And zero principals is not owner-only either.
  assert.equal(isOwnerOnly("Successfully processed 1 files", "osami", "C:\\tmp\\x.json"), false);
});

test("the SID lookup uses an absolute path, and a failed lookup is not cached", () => {
  // The three assertions below are ORDERED on purpose and share the module's
  // cache, so they live in one test rather than three.
  const boom = () => { throw new Error("PATH resolved the wrong binary"); };
  assert.equal(currentUserSid({ execFile: boom }), "", "a failed lookup must fail closed");

  // The real lookup, AFTER that failure. Caching the empty answer -- which
  // `!== undefined` did -- would return "" here for the life of the process, and
  // every later cache write would then fail its own verification: no leak, but
  // zero records after 44 spent authenticated requests. The absolute path is the
  // other half: measured on this host, a bare `whoami` resolves to Git's POSIX
  // build ahead of System32, which rejects `/user` and throws.
  const sid = currentUserSid();
  assert.match(sid, /^S-1-(?:\d+-)+\d+$/, "the absolute System32 lookup yielded no SID");

  // A SUCCESSFUL lookup is cached, so the throwing stub is never consulted.
  assert.equal(currentUserSid({ execFile: boom }), sid);
});

test("a principal icacls renders as a bare SID is matched by SID, not by name", () => {
  // icacls prints an unresolvable principal as a bare SID -- an account whose
  // reverse lookup is unavailable, or a machine off its domain. `.split("\\")`
  // returns the whole SID, which matches no username, so every cache write then
  // failed its own verification: no leak, it fails closed, but 44 authenticated
  // requests spent for zero records.
  const sid = "S-1-5-21-1111111111-2222222222-3333333333-1001";
  const out = `C:\\tmp\\x.json ${sid}:(F)\r\n\r\nSuccessfully processed 1 files`;
  assert.equal(isOwnerOnly(out, "osami", "C:\\tmp\\x.json", { sid: () => sid }), true);
  assert.equal(isOwnerOnly(out, "osami", "C:\\tmp\\x.json", { sid: () => "S-1-5-21-9-9-9-500" }), false,
    "somebody else's SID is somebody else");
  assert.equal(isOwnerOnly(out, "osami", "C:\\tmp\\x.json", { sid: () => "" }), false,
    "an unknown SID still fails closed rather than matching anything");
  // A named principal is unaffected by the SID branch.
  assert.equal(isOwnerOnly("C:\\tmp\\x.json HOST\\osami:(F)", "osami", "C:\\tmp\\x.json",
                           { sid: () => sid }), true);
  // And a name that merely looks SID-ish is compared as a name.
  assert.equal(isOwnerOnly("C:\\tmp\\x.json HOST\\S-1-5", "osami", "C:\\tmp\\x.json"), false);
});

test("a whole cache write succeeds when icacls reports the owner as a bare SID", () => {
  const dir = path.join(SCRATCH, "acl-sid");
  fs.rmSync(dir, { recursive: true, force: true });
  const sid = "S-1-5-21-4444444444-5555555555-6666666666-1002";
  const acl = {
    run: (args) => (args.length > 1 ? "" : `${args[0]} ${sid}:(F)\r\n`),
    sid: () => sid,
  };
  const file = writeCacheRecord({ provider: "groq", outcome: "empty", status: 200, models: [] },
                                { dir, user: "osami", acl });
  assert.equal(fs.existsSync(file), true, "the write completed rather than failing closed for nothing");
  assert.equal(readCacheRecord("groq", { dir, user: "osami", acl }).outcome, "empty");
});

test("a loose DACL on the DIRECTORY stops the write before a record is created", () => {
  // enforceOwnerOnly's own verification: every stub above answers owner-only for
  // whatever path it is handed, so deleting that verification killed no test.
  // This stub is loose for the directory alone.
  const dir = path.join(SCRATCH, "acl-dir-loose");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = {
    run: (args) => {
      if (args.length > 1) return "";
      return args[0].endsWith(".json") || args[0].includes(".tmp-")
        ? `${args[0]} HOST\\osami:(F)\r\n`
        : `${args[0]} Everyone:(F)\r\n${args[0]} HOST\\osami:(F)\r\n`;
    },
  };
  assert.throws(() => writeCacheRecord({ provider: "groq", outcome: "empty", models: [] },
                                       { dir, user: "osami", acl }), /readable beyond its owner/);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing was written into a directory we could not lock");
});

test("an icacls failure AFTER the rename removes the record instead of leaving it", () => {
  // The final verification sat outside the try that cleans up. A genuine
  // non-zero icacls exit -- a locked file, the 30 s timeout -- threw past the
  // cleanup, so the record stayed on disk while the caller printed "cache write
  // failed" and moved on. Not the same branch as a loose DACL, which throws a
  // message the old code did handle.
  const dir = path.join(SCRATCH, "acl-throw-after");
  fs.rmSync(dir, { recursive: true, force: true });
  let listings = 0;
  const acl = {
    run: (args) => {
      if (args.length > 1) return "";
      listings += 1;
      if (args[0].endsWith(".json")) throw new Error("icacls exited 1: the process cannot access the file");
      return `${args[0]} HOST\\osami:(F)\r\n`;
    },
  };
  assert.throws(() => writeCacheRecord({ provider: "groq", outcome: "empty", models: [] },
                                       { dir, user: "osami", acl }), /cannot access the file/);
  assert.ok(listings >= 2, "the failure was on the final verification, after the rename");
  assert.deepEqual(fs.readdirSync(dir), [],
    "a record whose DACL could not be verified is removed, not kept");
});

test("a prior record that is NOT owner-only is never carried into lastGood", () => {
  // The security case for that gate, which deleting it survives every other
  // fixture: a file this user does not exclusively own is a file somebody else
  // could have written, and carrying its contents forward re-publishes them
  // under our own owner-only DACL. The post-write verification cannot catch it,
  // because by then the planted content IS our record.
  const dir = path.join(SCRATCH, "acl-planted");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cacheFileFor("groq", dir), JSON.stringify({
    provider: "groq", at: "planted", outcome: "ok", status: 200, count: 1,
    models: [{ id: "planted-by-a-third-party", capabilityRaw: null, contextLength: null, modalityHints: [] }],
  }));

  let jsonListings = 0;
  const acl = {
    run: (args) => {
      if (args.length > 1) return "";
      if (!args[0].endsWith(".json")) return `${args[0]} HOST\\osami:(F)\r\n`;
      jsonListings += 1;
      // The FIRST listing of the record path is the planted file, which grants a
      // third party. Every later one is the record we just wrote ourselves.
      return jsonListings === 1
        ? `${args[0]} HOST\\osami:(F)\r\n${args[0]} DESKTOP-1\\somebodyelse:(F)\r\n`
        : `${args[0]} HOST\\osami:(F)\r\n`;
    },
  };
  const opts = { dir, user: "osami", acl };
  writeCacheRecord({ provider: "groq", at: "today", outcome: "auth", status: 403, models: [] }, opts);

  const after = readCacheRecord("groq", opts);
  assert.equal(after.lastGood, undefined, "a record we could not attribute was carried forward");
  assert.equal(JSON.stringify(after).includes("planted-by-a-third-party"), false);
  assert.equal(after.outcome, "auth");
});

test("a failed listing does not destroy the last good one", () => {
  // One 403 renamed over a cached 120-model listing and it was gone. The new
  // record still states today's truth; the last listing that worked rides
  // alongside it, already projected, so nothing new is disclosed.
  const dir = path.join(SCRATCH, "acl-lastgood");
  fs.rmSync(dir, { recursive: true, force: true });
  const acl = { run: (args) => (args.length > 1 ? "" : `${args[0]} HOST\\osami:(F)\r\n`) };
  const opts = { dir, user: "osami", acl };

  writeCacheRecord({ provider: "groq", at: "day-1", outcome: "ok", status: 200, count: 2,
                     models: [{ id: "m1" }, { id: "m2" }] }, opts);
  writeCacheRecord({ provider: "groq", at: "day-2", outcome: "auth", status: 403, models: [] }, opts);

  const after = readCacheRecord("groq", opts);
  assert.equal(after.outcome, "auth", "today's truth is what the record states");
  assert.equal(after.status, 403);
  assert.deepEqual(after.models, [], "and it does not pretend today's listing succeeded");
  assert.equal(after.lastGood.at, "day-1");
  assert.deepEqual(after.lastGood.models.map((m) => m.id), ["m1", "m2"]);
  // Exactly three keys, always. `lastGood` is rebuilt field by field rather than
  // spread from the prior file, so a hand-edited or planted record on disk
  // cannot define the shape of what this code writes back.
  assert.deepEqual(Object.keys(after.lastGood), [...LAST_GOOD_KEYS]);

  // Carried forward across a second consecutive failure, not lost on the way,
  // and still exactly three keys after the carry rather than only on the first.
  writeCacheRecord({ provider: "groq", at: "day-3", outcome: "error", status: 500, models: [] }, opts);
  const carried = readCacheRecord("groq", opts);
  assert.equal(carried.lastGood.at, "day-1");
  assert.deepEqual(Object.keys(carried.lastGood), [...LAST_GOOD_KEYS]);
  assert.deepEqual(carried.lastGood.models.map((m) => m.id), ["m1", "m2"]);

  // A fresh success replaces it: the record IS the good listing again.
  writeCacheRecord({ provider: "groq", at: "day-4", outcome: "ok", status: 200, count: 1,
                     models: [{ id: "m9" }] }, opts);
  const good = readCacheRecord("groq", opts);
  assert.equal(good.lastGood, undefined);
  assert.deepEqual(good.models.map((m) => m.id), ["m9"]);
});

test("the real icacls path leaves an owner-only record on disk", () => {
  // The stubbed tests above prove the decision; this one proves the command line
  // and the parser agree with what Windows actually prints.
  const dir = path.join(SCRATCH, "acl-real");
  fs.rmSync(dir, { recursive: true, force: true });
  const user = os.userInfo().username;
  const file = writeCacheRecord({ provider: "groq", outcome: "empty", status: 200, models: [] },
                                { dir, user });
  // Absolute, for the same reason discover.mjs is: PATH is not a trusted lookup
  // on a developer machine, and a shadowed `icacls` would make this test assert
  // whatever the shadowing binary happened to print.
  const listed = execFileSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe"),
    [file], { encoding: "utf8", windowsHide: true });
  assert.equal(isOwnerOnly(listed, user, file), true, listed);
  assert.equal(readCacheRecord("groq", { dir, user }).outcome, "empty");
});

// ============================================================== the reporting

// ================================================= what the six reasons pin

test("a profile with no baseUrl is NO_BASE, distinct from an unparseable url", () => {
  // Dropping the guard falls through to `new URL("/models")`, which throws, and
  // the record then blames the SHAPE of a url that was never built. Two
  // different repairs: add a baseUrl, versus fix the one that is there.
  const r = resolveListingUrl("brandnew", { baseUrl: "" });
  assert.equal(r.refusal, REASONS.NO_BASE);
  assert.equal(resolveListingUrl("brandnew", {}).refusal, REASONS.NO_BASE);
  assert.equal(resolveListingUrl("brandnew", { baseUrl: "https://ok.test/v1" }).refusal, undefined);

  // And the other half of the pair, which no fixture reached either.
  assert.equal(resolveListingUrl("brandnew", { listing: { url: "https://[not-a-host/models" } }).refusal,
               REASONS.UNPARSEABLE);
});

test("a timeout and a network failure are told apart, and neither is the other", async () => {
  // The catch block executed in no test at all, and it is the branch a 44-host
  // sweep will exercise most. Folding TIMEOUT into NETWORK reads as "the host is
  // unreachable" for a host that answered too slowly -- a different remedy.
  const aborted = async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
  const t = await run(PROF, aborted);
  assert.equal(t.outcome, "error");
  assert.equal(t.reason, REASONS.TIMEOUT);
  assert.equal(t.status, 0);
  assert.equal(t.responded, false, "nothing came back, so nothing responded");

  const refused = async () => { throw new Error("ECONNREFUSED"); };
  const n = await run(PROF, refused);
  assert.equal(n.reason, REASONS.NETWORK);
  assert.equal(n.responded, false);

  // The real abort path, not just a hand-shaped error name: a fetch that never
  // settles must reach TIMEOUT through the AbortController.
  const hangs = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const real = await run(PROF, hangs, { timeoutMs: 5 });
  assert.equal(real.reason, REASONS.TIMEOUT);
});

test("402 and 429 are alive-but-unavailable, not indistinguishable from broken", async () => {
  const paid = await run(PROF, one(402, null, { throwOnRead: true }));
  assert.equal(paid.outcome, "error");
  assert.equal(paid.reason, REASONS.PAYMENT);
  assert.equal(paid.responded, true, "an unpaid account is a host that answered");

  const limited = await run(PROF, one(429, null, { throwOnRead: true }));
  assert.equal(limited.reason, REASONS.RATE_LIMIT);
  assert.equal(limited.responded, true);

  // A 500 stays generic: it is not a state anyone can act on differently.
  assert.equal((await run(PROF, one(500, null, { throwOnRead: true }))).reason, undefined);
  // Six outcomes, still. The distinction rides on `reason`, never on a new enum.
  for (const s of [402, 429]) {
    assert.equal((await run(PROF, one(s, null, { throwOnRead: true }))).outcome, "error");
  }
});

test("`responded` separates a host that answered from one that never did", async () => {
  // keysync's consumer reduces a record to `models.length`, so `auth`, `empty`,
  // `unsupported-shape` and an all-refused `ok` are all indistinguishable from a
  // dead host by that predicate -- and every one of them is alive. The field is
  // recorded here; the consumer that reads it is R11's.
  const answered = [
    [one(200, { data: [{ id: "m" }] }), "ok"],
    [one(200, { data: [] }), "empty"],
    [one(200, { foo: 1 }), "unsupported-shape"],
    [one(401, null, { throwOnRead: true }), "auth"],
    [one(500, null, { throwOnRead: true }), "error"],
    [one(200, { data: [{ id: "a[2J" }] }), "ok"],
  ];
  for (const [f, outcome] of answered) {
    const r = await run(PROF, f);
    assert.equal(r.outcome, outcome);
    assert.equal(r.responded, true, `${outcome} is a host that answered`);
  }

  // False only where nothing was sent, or nothing came back.
  assert.equal((await run({ ...PROF, listing: null }, never)).responded, false);
  assert.equal((await run({ ...PROF, baseUrl: "http://api.groq.com/v1" }, never)).responded, false);
  assert.equal((await run(PROF, async () => { throw new Error("ECONNREFUSED"); })).responded, false);
});

// ============================================================== the body cap

test("a declared content-length over the ceiling costs zero bytes read", async () => {
  // Declared at exactly `maxBodyBytes + 1`, not at some comfortable multiple: a
  // 64 MB fixture against an 8 MB ceiling passes just as well with the
  // comparison loosened to `> maxBodyBytes * 2`, which is not the bound anyone
  // wrote down. One byte over is the only fixture that pins the boundary.
  const ceiling = 4096;
  const at = (declared) => stubFetch(() => ({
    status: 200,
    headers: { get: (h) => (h === "content-length" ? String(declared) : null) },
    throwOnRead: true,             // the stub throws if the body is read at all
  }));

  const over = await run(PROF, at(ceiling + 1), { maxBodyBytes: ceiling });
  assert.equal(over.outcome, "error");
  assert.equal(over.reason, REASONS.OVERSIZE);
  assert.equal(over.responded, true, "the host answered; its answer was too large");
  assert.equal(over.status, 200);

  // And exactly at the ceiling is admitted, so the bound is `>` and not `>=`.
  const exact = stubFetch(() => ({
    status: 200,
    headers: { get: () => String(ceiling) },
    body: JSON.stringify({ data: [{ id: "m1" }] }),
  }));
  const ok = await run(PROF, exact, { maxBodyBytes: ceiling });
  assert.equal(ok.outcome, "ok", "a body declaring exactly the ceiling is read, not refused");
});

test("a body that lies about its length is stopped mid-stream", async () => {
  // The declared length is provider-controlled, so it is a shortcut and never
  // the enforcement. `res.text()` is unbounded: one host streaming without end
  // holds the fan-out open for the full 45 s while its buffer grows inside a
  // process that is holding 44 live credentials.
  const { stream, pulled } = streamOf(["x".repeat(400), "y".repeat(400), "z".repeat(400)]);
  const f = stubFetch(() => ({ status: 200, stream }));
  const r = await run(PROF, f, { maxBodyBytes: 500 });
  assert.equal(r.outcome, "error");
  assert.equal(r.reason, REASONS.OVERSIZE);
  assert.deepEqual(pulled, [400, 400], "2 chunks of 3 pulled: the stream is abandoned, not drained");

  // The `text()` fallback, for a response carrying no body stream. It can only
  // refuse the record after the read, never prevent the allocation -- which is
  // the stated limit of that path, and is still better than admitting it.
  const noStream = await run(PROF, one(200, "q".repeat(4000)), { maxBodyBytes: 500 });
  assert.equal(noStream.outcome, "error");
  assert.equal(noStream.reason, REASONS.OVERSIZE);
  // Counted in BYTES, not UTF-16 code units: a 300-code-unit body of astral
  // characters is 1,200 bytes, and a code-unit count would have admitted it.
  const astral = await run(PROF, one(200, "\u{1F600}".repeat(300)), { maxBodyBytes: 1000 });
  assert.equal(astral.reason, REASONS.OVERSIZE);
});

test("a streamed body is decoded as UTF-8, which is the only branch a live run uses", async () => {
  // A real Response always carries a body stream, so `res.text()` is the branch
  // NO live request ever takes -- and every non-ASCII fixture in this file went
  // through it. Decoding the streamed path as latin1 leaves all of them green
  // while mangling every id a provider actually returns.
  const payload = JSON.stringify({
    data: [
      { id: "qwen/qwen2.5-72b", capability: "chat" },
      { id: "mistral/ministral-8b-café" },
      { id: "中文/model-éè" },
    ],
  });
  // Split mid-codepoint so a chunk boundary cannot be reassembled by luck: the
  // concat has to happen in bytes before the decode, not per chunk.
  const bytes = Buffer.from(payload, "utf8");
  const cut = bytes.indexOf(Buffer.from("café", "utf8")) + 4;
  const { stream } = streamOf([bytes.subarray(0, cut), bytes.subarray(cut)]);

  const r = await run(PROF, stubFetch(() => ({ status: 200, stream })));
  assert.equal(r.outcome, "ok");
  assert.deepEqual(r.models.map((m) => m.id),
                   ["qwen/qwen2.5-72b", "mistral/ministral-8b-café", "中文/model-éè"]);
  assert.equal(r.models[0].capabilityRaw, "chat");
  assert.equal(r.rejected, 0, "a mangled decode refuses ids and would show up here");
});

test("a body under the ceiling still parses, and one hostile body costs one provider", async () => {
  const { stream } = streamOf(['{"data":[{"id":"m1"}', "]}"]);
  const r = await run(PROF, stubFetch(() => ({ status: 200, stream })), { maxBodyBytes: 500 });
  assert.equal(r.outcome, "ok");
  assert.equal(r.models[0].id, "m1");

  // And in a fan-out, the oversized provider is the only casualty.
  const fetchImpl = async (url) => (url.startsWith("https://huge.test")
    ? { status: 200, body: streamOf(["q".repeat(4000)]).stream }
    : { status: 200, text: async () => JSON.stringify({ data: [{ id: "fine" }] }) });
  const results = await discoverAll([
    { provider: "huge", profile: { baseUrl: "https://huge.test/v1" }, key: "K" },
    { provider: "small", profile: { baseUrl: "https://small.test/v1" }, key: "K" },
  ], { fetchImpl, scrub: false, maxBodyBytes: 500 });
  const by = Object.fromEntries(results.map((r) => [r.provider, r]));
  assert.equal(by.huge.reason, REASONS.OVERSIZE);
  assert.equal(by.small.outcome, "ok", "1 of 2 survives the other's hostile body");
});

test("each record is handed over as its provider resolves, not after the fan-out", async () => {
  // Nothing was persisted until every provider had resolved, so one failure
  // anywhere discarded 43 completed records and forced a re-authorized re-run of
  // all 44 authenticated calls.
  const delivered = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url) => {
    if (url.startsWith("https://slow.test")) await gate;
    return { status: 200, text: async () => JSON.stringify({ data: [] }) };
  };
  const targets = [
    { provider: "slow", profile: { baseUrl: "https://slow.test/v1" }, key: "K" },
    { provider: "fast", profile: { baseUrl: "https://fast.test/v1" }, key: "K" },
  ];
  const pending = discoverAll(targets, { fetchImpl, scrub: false, onResult: (r) => delivered.push(r.provider) });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(delivered, ["fast"], "fast's record was already out while slow was still in flight");
  release();
  await pending;
  assert.deepEqual(delivered.sort(), ["fast", "slow"]);
});

test("a per-record write that throws costs that record and nothing else", async () => {
  const fetchImpl = async () => ({ status: 200, text: async () => JSON.stringify({ data: [] }) });
  const targets = Array.from({ length: 4 }, (_, i) =>
    ({ provider: `p${i}`, profile: { baseUrl: `https://p${i}.test/v1` }, key: "K" }));
  const results = await discoverAll(targets, {
    fetchImpl, scrub: false, concurrency: 1,
    onResult: (r) => { if (r.provider === "p1") throw new Error("disk full"); },
  });
  assert.equal(results.length, 4, "4 of 4 providers still resolved");
});

// ========================================================== the --out target

test("--out refuses any directory this tool did not write", () => {
  // It reaches `icacls /inheritance:r /grant:r`, which REWRITES a DACL and
  // strips inheritance. `--out .` would relock the repository root on a typo,
  // and the discovery would then be the least of it.
  const base = path.join(SCRATCH, "outdir");
  fs.rmSync(base, { recursive: true, force: true });

  const absent = path.join(base, "not-yet");
  assert.equal(resolveCacheDir(absent), path.resolve(absent), "an absent path is ours to create");

  const ours = path.join(base, "ours");
  fs.mkdirSync(ours, { recursive: true });
  assert.equal(resolveCacheDir(ours), path.resolve(ours), "an empty directory is accepted");
  fs.writeFileSync(path.join(ours, `${"a".repeat(32)}.json`), "{}");
  fs.writeFileSync(path.join(ours, `${"b".repeat(32)}.json.tmp-991`), "{}");
  assert.equal(resolveCacheDir(ours), path.resolve(ours), "and so are records this tool wrote");

  const theirs = path.join(base, "theirs");
  fs.mkdirSync(theirs, { recursive: true });
  fs.writeFileSync(path.join(theirs, "README.md"), "somebody's directory");
  assert.throws(() => resolveCacheDir(theirs), /refusing to rewrite the permissions/);

  // The repository root is the case that motivated this, and it must refuse.
  assert.throws(() => resolveCacheDir(path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw")),
                /refusing to rewrite the permissions/);

  const file = path.join(base, "a-file");
  fs.writeFileSync(file, "x");
  // Matched on OUR refusal, not on "not a directory": Node's own readdirSync
  // raises `ENOTDIR: not a directory, scandir '...'`, so the loose regex passed
  // with the guard deleted and asserted nothing about this code at all.
  assert.throws(() => resolveCacheDir(file), /refusing to use .* as a cache directory/);
});

test("an absent --out falls back to the cache root rather than to the working directory", () => {
  const env = { ...process.env };
  for (const given of [null, undefined, ""]) {
    assert.equal(resolveCacheDir(given, { env }), resolveCacheDir(null, { env }));
  }
  assert.notEqual(resolveCacheDir(null, { env }), process.cwd());
});

// ============================================================== the vault read

test("a failed vault read never carries the child's stdout into the thrown error", async () => {
  // execFileSync attaches the child's stdout to the Error it throws, on BOTH
  // `.stdout` and `.output[1]`, and that stdout is the id-to-key map for every
  // selected provider. Node prints an uncaught error's own enumerable
  // properties, so rethrowing it publishes the whole map to stderr.
  const SENTINEL = "sk-fake-sentinel-never-a-real-key-0000";
  const rendered = (e) => {
    const own = {};
    for (const k of Object.getOwnPropertyNames(e)) own[k] = e[k];
    return `${String(e)}\n${e.stack ?? ""}\n${JSON.stringify(own)}`;
  };

  const failing = () => {
    const e = new Error(`Command failed: powershell -NoProfile\n${SENTINEL}`);
    e.status = 1;
    e.stdout = `{"cred-1":"${SENTINEL}"}`;
    e.stderr = "";
    e.output = [null, e.stdout, ""];
    throw e;
  };
  await assert.rejects(
    () => withKeys(["cred-1"], async () => "unreachable", { execFile: failing }),
    (thrown) => {
      const full = rendered(thrown);
      assert.equal(full.includes(SENTINEL), false, "the key map reached the error's string form");
      assert.equal(thrown.stdout, undefined, "a fresh Error, not the original with more fields");
      assert.equal(thrown.output, undefined);
      assert.match(thrown.message, /the vault read failed \(1\)/);
      return true;
    });

  // A body that parses as nothing must take the same path: JSON.parse throws
  // with the whole map quoted inside its own message.
  await assert.rejects(
    () => withKeys(["cred-1"], async () => "unreachable",
                   { execFile: () => `not json ${SENTINEL}` }),
    (thrown) => {
      assert.equal(rendered(thrown).includes(SENTINEL), false);
      return /the vault read failed/.test(thrown.message);
    });
});

test("a successful vault read hands keys to the callback and drops them after", async () => {
  const SENTINEL = "sk-fake-sentinel-never-a-real-key-0001";
  let seen;
  let escaped;                             // the accessor, captured past its scope
  const out = await withKeys(
    ["cred-1", "cred-2"],
    async (keyOf) => { seen = keyOf("cred-1"); escaped = keyOf; return "done"; },
    { execFile: () => `{"cred-1":"${SENTINEL}","cred-2":"${SENTINEL}2"}\n` });
  assert.equal(out, "done");
  assert.equal(seen, SENTINEL, "the callback is the only place a key value is reachable");

  // The `finally` is the whole reason the accessor is scoped: without it, the
  // closure keeps the map alive and every key stays readable for as long as
  // anything holds a reference -- through the report, the cache writes and the
  // rest of the process. Deleting it leaves every other assertion here green.
  assert.equal(escaped("cred-1"), undefined, "a key was still reachable after the callback returned");
  assert.equal(escaped("cred-2"), undefined);

  // Dropped even when the callback throws, which is the path a failed fan-out
  // takes and the one where keys linger longest if the teardown is conditional.
  let afterThrow;
  await assert.rejects(() => withKeys(["cred-1"], async (keyOf) => {
    afterThrow = keyOf;
    throw new Error("the fan-out failed");
  }, { execFile: () => `{"cred-1":"${SENTINEL}"}` }), /the fan-out failed/);
  assert.equal(afterThrow("cred-1"), undefined);
});

test("main plans without sending, and validates --out before spending a request", async () => {
  // main() is what R10 runs, and it was the untested part of this file. The
  // ORDER is the safety property: nothing is sent without --live, and --out is
  // resolved before the fan-out rather than after 44 authenticated calls.
  const vaultFiles = {
    "providers.json": [
      { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai" },
      { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
      { provider: "skipme", baseUrl: "https://skip.test/v1", protocol: "generic" },
    ],
    "registry.json": [
      { id: "c-groq", provider: "groq", tier: "free" },
      { id: "c-deep", provider: "deepseek", tier: "free" },
      { id: "c-skip", provider: "skipme", tier: "free" },
      { id: "c-mgmt", provider: "groq", tier: "management" },
      { id: "c-sv", provider: "groq", tier: "free", bucket: "sportsvector-1" },
    ],
  };
  const readJsonImpl = (f) => vaultFiles[path.basename(f)];
  const out = [];
  const errs = [];
  const base = { readJsonImpl, log: (s) => out.push(String(s)), logError: (s) => errs.push(String(s)) };

  // --- dry: the plan prints, and nothing else is even constructed ------------
  const boom = () => { throw new Error("a dry run must not reach this"); };
  const dry = await main({
    ...base, args: [],
    withKeysImpl: boom, discoverAllImpl: boom, writeCacheRecordImpl: boom, resolveCacheDirImpl: boom,
  });
  assert.equal(dry, 0);
  const dryText = out.join("\n");
  assert.match(dryText, /2 providers selected/, "the generic-protocol provider is excluded");
  assert.match(dryText, /groq\s+https:\/\/api\.groq\.com\/openai\/v1\/models/);
  assert.match(dryText, /no request was made/);
  assert.equal(dryText.includes("skipme"), false);

  // --- --only filters, and an --only that matches nothing exits 2 ------------
  out.length = 0;
  await main({ ...base, args: ["--only", "groq"], withKeysImpl: boom, discoverAllImpl: boom });
  assert.match(out.join("\n"), /1 provider selected/);
  out.length = 0;
  const none = await main({ ...base, args: ["--only", "c-groq"], withKeysImpl: boom });
  assert.equal(none, 2, "--only takes provider names, not credential ids");
  assert.match(errs.join("\n"), /no eligible provider matched/);

  // --- live: --out is resolved BEFORE any key is read or request issued ------
  out.length = 0;
  const order = [];
  await assert.rejects(() => main({
    ...base, args: ["--live", "--out", "whatever"],
    resolveCacheDirImpl: () => { order.push("out"); throw new Error("refusing to rewrite the permissions"); },
    withKeysImpl: () => { order.push("keys"); throw new Error("the vault was read anyway"); },
    discoverAllImpl: boom,
  }), /refusing to rewrite the permissions/);
  assert.deepEqual(order, ["out"], "the vault was read before --out was validated");
});

test("main writes each record as it resolves and reports without a key or a body", async () => {
  const SENTINEL = "sk-fake-sentinel-never-a-real-key-0002";
  const vaultFiles = {
    "providers.json": [
      { provider: "groq", baseUrl: "https://api.groq.com/openai/v1", protocol: "openai" },
      { provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", protocol: "openai" },
    ],
    "registry.json": [
      { id: "c-groq", provider: "groq", tier: "free" },
      { id: "c-deep", provider: "deepseek", tier: "free" },
    ],
  };
  const out = [];
  const errs = [];
  const written = [];

  // A stub fan-out that answers one provider and fails the other, so both the
  // success and the failure lines are exercised in one run.
  const discoverAllImpl = async (targets, opts) => {
    const results = targets.map((t) => (t.provider === "groq"
      ? { provider: "groq", at: "t", responded: true, outcome: "ok", status: 200,
          envelopeKey: "data", count: 9, rejected: 1, truncated: 6, models: [{ id: "m1" }, { id: "m2" }] }
      : { provider: "deepseek", at: "t", responded: true, outcome: "error", status: 429,
          count: 0, rejected: 0, truncated: 0, models: [], reason: REASONS.RATE_LIMIT }));
    // The key reaches the fan-out and nothing further.
    assert.equal(targets.every((t) => t.key === SENTINEL), true);
    for (const r of results) opts.onResult(r);
    return results;
  };

  const code = await main({
    args: ["--live"],
    readJsonImpl: (f) => vaultFiles[path.basename(f)],
    withKeysImpl: (ids, fn) => fn(() => SENTINEL),
    discoverAllImpl,
    resolveCacheDirImpl: () => path.join(SCRATCH, "main-out"),
    writeCacheRecordImpl: (r) => {
      written.push(r.provider);
      if (r.provider === "deepseek") throw new Error("icacls exited 1");
    },
    log: (s) => out.push(String(s)),
    logError: (s) => errs.push(String(s)),
  });

  assert.deepEqual(written.sort(), ["deepseek", "groq"], "each record was handed to the writer");
  const text = out.join("\n");
  // Every count in the line carries its denominator, and the entries dropped at
  // the cap are reported separately from the ids that were refused: they are two
  // different findings and folding them would hide both.
  assert.match(text, /ok\s+groq\s+2 kept of 9 listed, 1 refused, 6 past the cap/);
  assert.match(text, /error\s+deepseek\s+429 rate-limited/);
  assert.match(text, /coverage 1 of 2 eligible \(50%\), 2 attempted, 1 of 2 records cached/);
  assert.match(errs.join("\n"), /cache write failed for deepseek: icacls exited 1/);
  assert.equal(code, 1, "a run that could not cache every record does not exit 0");
  assert.equal(`${text}\n${errs.join("\n")}`.includes(SENTINEL), false, "a key reached the report");
});

test("coverage carries its denominator and excludes no-endpoint", () => {
  const c = coverageOf([
    { outcome: "ok" }, { outcome: "ok" }, { outcome: "empty" },
    { outcome: "unsupported-shape" }, { outcome: "auth" },
    { outcome: "no-endpoint" }, { outcome: "no-endpoint" },
  ]);
  assert.equal(c.ok, 2);
  assert.equal(c.eligible, 5, "2 no-endpoint entries are out of the denominator");
  assert.equal(c.total, 7);
  assert.equal(c.by["unsupported-shape"], 1);
});

test("one provider's unsupported shape does not discard the others", () => {
  // #61. A run-wide gate cost 43 successful listings and forced a re-authorized
  // re-run of all 44 authenticated calls on one novel envelope.
  const results = [
    { provider: "a", outcome: "ok", models: [{ id: "x" }] },
    { provider: "b", outcome: "unsupported-shape", keys: ["foo"], models: [] },
    { provider: "c", outcome: "ok", models: [{ id: "y" }] },
  ];
  const c = coverageOf(results);
  assert.equal(c.ok, 2, "2 of 3 survive the third's shape failure");
  assert.equal(results.filter((r) => r.models.length).length, 2);
});

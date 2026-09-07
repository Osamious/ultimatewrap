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
  readCacheRecord, resolveListingUrl, scrubProxyEnv, writeCacheRecord,
} from "../refresh/discover.mjs";

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
      status: r.status,
      text: async () => {
        if (r.throwOnRead) throw new Error("the body of a non-2xx must never be read");
        return typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? {});
      },
    };
  };
  impl.calls = calls;
  return impl;
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

test("a 302 is refused rather than followed", async () => {
  const f = one(302, null, { throwOnRead: true });
  const r = await run(PROF, f);
  assert.equal(r.outcome, "error");
  assert.equal(r.status, 302);
  assert.equal(r.reason, REASONS.REDIRECT);
  assert.equal(f.calls.length, 1, "a refused redirect costs exactly one request, never two");
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

test("the proxy environment is scrubbed before the fan-out", async () => {
  // If this process were started as a child of the gateway, all 44 authenticated
  // requests would silently traverse whatever CCR_UPSTREAM_PROXY_URL names.
  const env = {};
  for (const n of PROXY_ENV) env[n] = "http://proxy.invalid:8080";
  env.KEEP_ME = "untouched";
  await discoverAll([{ provider: "groq", profile: PROF, key: "K" }],
                    { fetchImpl: one(200, { data: [] }), env });
  for (const n of PROXY_ENV) assert.equal(n in env, false, `${n} survived the scrub`);
  assert.equal(env.KEEP_ME, "untouched");
});

test("scrubProxyEnv names every variable it removed", () => {
  const env = { HTTPS_PROXY: "x", NODE_OPTIONS: "y" };
  assert.deepEqual(scrubProxyEnv(env).sort(), ["HTTPS_PROXY", "NODE_OPTIONS"]);
  assert.deepEqual(Object.keys(env), []);
  assert.deepEqual(scrubProxyEnv({}), []);
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
                           "rejected", "models", "keys", "reason", "hostPinned"]);
  for (const k of Object.keys(r)) assert.ok(allowed.has(k), `unexpected persisted field: ${k}`);
  assert.equal(JSON.stringify(r).includes("org-secret"), false);
});

test("observed keys on an unsupported shape are bounded and display-sanitised", async () => {
  const wide = {};
  for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i;
  wide["ho\u001b[2Jstile"] = 1;
  const r = await run(PROF, one(200, wide));
  assert.equal(r.outcome, "unsupported-shape");
  assert.equal(r.keys.length, 20, "20 of 41 keys recorded");
  const all = r.keys.join("|");
  assert.equal(all.includes("\u001b"), false);
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

test("the real icacls path leaves an owner-only record on disk", () => {
  // The stubbed tests above prove the decision; this one proves the command line
  // and the parser agree with what Windows actually prints.
  const dir = path.join(SCRATCH, "acl-real");
  fs.rmSync(dir, { recursive: true, force: true });
  const user = os.userInfo().username;
  const file = writeCacheRecord({ provider: "groq", outcome: "empty", status: 200, models: [] },
                                { dir, user });
  const listed = execFileSync("icacls", [file], { encoding: "utf8", windowsHide: true });
  assert.equal(isOwnerOnly(listed, user, file), true, listed);
  assert.equal(readCacheRecord("groq", { dir, user }).outcome, "empty");
});

// ============================================================== the reporting

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

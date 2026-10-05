// Security fixes of the tool-fidelity probe: the bounded cache_control retry and the per-model request ceiling (B1), a free-tier KEY with a LISTED price is costed (H1), the provider
// tier of a multi-key provider is the compiler's (H2), the tier source and age (M1), the printed lift preview (M2), partial-level and escalation accounting (M3), a bounded error body
// (L1), the capRecords report (L3) and --merge-unsaved (L2). Offline: fixtures only, fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { freshDir, fakeFetch, goodModel, http, ok, ev, stream, streamWith, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { probeModel, runKind, MAX_MODEL_REQUESTS } from "../refresh/tool-fidelity-probe.mjs";
import { main, plan, parseArgs, LIFT_PREVIEW, pendingReasonOf } from "../refresh/tool-fidelity-cli.mjs";
import { resolveTierRows, loadTiers, loadTiersInfo, describeTiers, TIERS_STALE_DAYS, loadFidelity, saveFidelity, capRecords, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { filterRegistry, chooseKeys } from "../keysync/keysync.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";

guardRealState(after, assert);
after(() => { assert.equal(rawExists(REAL_FILE), false, "state/tool-fidelity.json must not exist after the tests"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const kinds = (f) => f.calls.map(kindOf);
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const thinking = (index, text) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } })
  + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } }) + sse("content_block_stop", { type: "content_block_stop", index });
const CC_400 = http(400, "tools.0.cache_control: Extra inputs are not permitted");

// ---------------------------------------------------------------- B1: the cache_control retry is bounded, and the request ceiling is hard

test("B1: a 400 that mentions cache_control on EVERY request sends a bounded number of requests: the marker is dropped once, never retried again", async () => {
  const f = fakeFetch(() => CC_400);
  const r = await probeModel({ levels: [3], prior: "ppnn", ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3a"], "3a with the marker, then once without; the second 400 is a verdict, not another retry");
  assert.equal(r.done[3].v, "f");
  assert.ok(f.calls.length < MAX_MODEL_REQUESTS);
  assert.ok(JSON.stringify(f.calls[0].body).includes("cache_control") && !JSON.stringify(f.calls[1].body).includes("cache_control"), "the second request carries no marker");
});

test("B1: a model recorded `cc f` starts with the markers already off: no request of the run carries cache_control", async () => {
  const f = fakeFetch(goodModel);
  const r = await probeModel({ levels: [3, 5], prior: "ppnn", flags: { cc: "f" }, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["3a", "3b", "5"]);
  assert.ok(f.calls.every((c) => !JSON.stringify(c.body).includes("cache_control")), "no marker anywhere");
  assert.equal(r.done[3].v, "p", "the level is still learned without the markers");
});

test("B1: the request ceiling is HARD: at the ceiling nothing more is sent and the result is inconclusive request-cap, never a verdict", async () => {
  const f = fakeFetch(goodModel);
  const d0 = {}, d1 = {};
  const none = await probeModel({ levels: [1, 2], done: d0, state: { requests: MAX_MODEL_REQUESTS }, ...FREE, ...conn(f) });
  assert.equal(f.calls.length, 0, "already at the ceiling: no request");
  assert.deepEqual([none.inconclusive.s, none.inconclusive.reason, Object.keys(d0).length], ["error", "request-cap", 0]);
  const one = await probeModel({ levels: [1, 2], done: d1, state: { requests: MAX_MODEL_REQUESTS - 1 }, ...FREE, ...conn(f) });
  assert.deepEqual(kinds(f), ["1"], "one request left: L1 goes, L2 is stopped by the ceiling");
  assert.equal(one.inconclusive.reason, "request-cap");
  assert.equal(d1[1].v, "p", "what was learned before the ceiling is kept");
});

test("B1: the ceiling counts every kind of request together: retries, the forced fallback, the escalation and the marker re-ask all draw on the same budget", async () => {
  const f = fakeFetch((c) => {
    const k = kindOf(c);
    if (k === "1") return ok(stream(ev.text(0, "no call"), ev.stop("end_turn")));              // auto: no call -> the forced fallback is asked too
    return goodModel(c);
  });
  const state = {};
  await probeModel({ levels: [1, 2], state, ...FREE, ...conn(f) });
  assert.equal(state.requests, f.calls.length, "the counter in `state` is the number of requests actually sent (it survives the engine's retries)");
  assert.ok(state.requests >= 3);
});

// ---------------------------------------------------------------- L1: a refusal body is read bounded

test("L1: an error body is read in chunks and cancelled after 2 KB: a refusal of unbounded size costs nothing, and its first words still decide the verdict", async () => {
  let reads = 0, cancelled = false;
  const body = { getReader: () => ({ read: async () => { reads += 1; return { done: false, value: new TextEncoder().encode(reads === 1 ? "tool_choice is not supported; " + "x".repeat(1000) : "y".repeat(1024)) }; }, cancel: async () => { cancelled = true; } }) };
  const fetchImpl = async () => ({ ok: false, status: 400, headers: { get: () => null }, body, text: async () => { throw new Error("must not be read whole"); } });
  const r = await runKind("1", { fetchImpl, url: "http://gw.test/v1/messages", key: "k", model: "p/m", maxTokens: 256, timeouts: { small: 1000, "157": 1000, big: 1000 } });
  assert.ok(reads <= 4, `read ${reads} chunks`);
  assert.equal(cancelled, true);
  assert.ok(r.body.length <= 2048, `kept ${r.body.length} characters`);
  assert.match(r.body, /tool_choice is not supported/);
});

// ---------------------------------------------------------------- H2: the tier of a provider with several keys

const ROWS = [
  { provider: "groq", tier: "free" }, { provider: "groq", tier: "free" }, { provider: "groq", tier: "paid" },
  { provider: "google", tier: "free" }, { provider: "google", tier: "paid" }, { provider: "google", tier: "paid" }, { provider: "google", tier: "paid" },
  { provider: "openrouter", tier: "paid" }, { provider: "openrouter", tier: "free" },
  { provider: "zenmux", tier: "free" }, { provider: "zenmux", tier: "management" },
  { provider: "solo", tier: "free" }, { provider: "twin", tier: "free-deposit" }, { provider: "twin", tier: "free-deposit" },
  { provider: "onlymgmt", tier: "management" }, { provider: "weird", tier: "free" }, { provider: "weird", tier: "platinum" },
];
const permutations = (a, n = 8) => { const out = [a]; let s = 7; for (let i = 0; i < n; i++) { const b = [...out.at(-1)]; for (let j = b.length - 1; j > 0; j--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const k = s % (j + 1); [b[j], b[k]] = [b[k], b[j]]; } out.push(b); } return out; };

test("H2: a provider with keys of different tiers gets the MOST RESTRICTIVE tier, a management key is ignored when another exists, and the order of the rows never changes the answer", () => {
  const want = { groq: "paid", google: "paid", openrouter: "paid", zenmux: "free", solo: "free", twin: "free-deposit", onlymgmt: "management" };
  for (const rows of permutations(ROWS)) {
    const r = resolveTierRows(rows);
    assert.deepEqual(r.tiers, want, "the same in every row order; `weird` (a tier outside the vocabulary) is unlabelled");
    assert.deepEqual(r.conflicts.sort(), ["google", "groq", "openrouter"], "the providers whose keys disagree");
  }
  assert.equal(resolveTierRows([{ provider: "p", tier: "free" }, { provider: "p", tier: "subscription" }]).tiers.p, "subscription");
});

test("H2: parity with the policy compiler: where the compiler resolves a provider, so do we; where it cannot (several keys, no deliberate choice) we are never less restrictive than ANY key", () => {
  const reg = ROWS.filter((r) => isTierName(r.tier)).map((r, i) => ({ ...r, id: `${r.provider}.k${i}`, bucket: "b" }));
  const prov = new Map([...new Set(reg.map((r) => r.provider))].map((p) => [p, { provider: p, protocol: "anthropic" }]));
  const filtered = filterRegistry(reg, prov);
  const by = new Map();
  for (const r of filtered) (by.get(r.provider) ?? by.set(r.provider, []).get(r.provider)).push(r);
  const ours = resolveTierRows(reg).tiers;
  const ORDER = ["management", "subscription", "paid", "free-deposit", "free"];
  for (const [p, rows] of by) {
    if (rows.length === 1) assert.equal(ours[p], rows[0].tier, `${p}: one key, the compiler's tier`);
    else {
      const choice = chooseKeys(filtered.filter((r) => r.provider === p), { [p]: rows.at(-1).id })[0].tier;
      assert.ok(ORDER.indexOf(ours[p]) <= ORDER.indexOf(choice), `${p}: ${ours[p]} is at least as restrictive as the compiler's chosen ${choice}`);
    }
  }
});
const isTierName = (t) => ["free", "free-deposit", "paid", "subscription", "management"].includes(t);

test("H2: a vault registry array is read through the same rule, from a file, with its source kind", () => {
  const d = freshDir(), file = path.join(d, "registry.json");
  fs.writeFileSync(file, JSON.stringify([...ROWS].reverse()));
  const info = loadTiersInfo(file);
  assert.equal(info.kind, "registry");
  assert.equal(info.tiers.groq, "paid");
  assert.equal(loadTiers(file).openrouter, "paid", "paid,free in either order");
  fs.writeFileSync(file, JSON.stringify({ compiledAt: "2026-10-04T00:00:00.000Z", tiers: { a: "free" }, models: [] }));
  assert.deepEqual([loadTiersInfo(file).kind, loadTiersInfo(file).compiledAt], ["policy", "2026-10-04T00:00:00.000Z"]);
});

// ---------------------------------------------------------------- M1: where the tiers come from and how old they are

test("M1: describeTiers names the source, the age and the providers the map does not cover; older than two days is stale", () => {
  const now = Date.parse("2026-10-05T10:00:00.000Z");
  const info = { kind: "policy", compiledAt: "2026-10-01T10:00:00.000Z", mtime: null, conflicts: ["groq"] };
  const d = describeTiers({ info, source: "compiled policy x", tiers: { a: "free", c: "paid" }, providers: ["a", "b", "b", "c", "d"], nowMs: now });
  assert.deepEqual([d.source, d.stampIs, d.stale, d.absent, d.conflicts], ["compiled policy x", "compiled", true, ["b", "d"], ["groq"]]);
  assert.ok(Math.abs(d.ageDays - 4) < 1e-9);
  const fresh = describeTiers({ info: { ...info, compiledAt: "2026-10-05T00:00:00.000Z" }, source: "s", tiers: {}, providers: [], nowMs: now });
  assert.equal(fresh.stale, false);
  assert.equal(describeTiers({ info: null, source: "s", tiers: {}, providers: [], nowMs: now }).ageDays, null, "no stamp: the age is unknown, not zero");
  assert.equal(TIERS_STALE_DAYS, 2);
});

// ---------------------------------------------------------------- the CLI

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
function env(rows, { policy, answer, tiers, now = NOW } = {}) {
  const dir = freshDir();
  const t = tiers ?? Object.fromEntries(rows.map((r) => [r.provider, "free"]));
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const pol = { schema: 1, models: [], ...(policy ?? {}), tiers: t };
  const deps = { snapshot: { ok: true, snap: { rows: [{ provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN" })] }, ...rows] } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, policy: pol, presetKeys: null,
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => now,
    isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
  return { dir, deps, f, out: deps.outFile };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const CAP = ["--tf-max-tokens-per-provider", "1000000"];
const pricedWorld = () => [{ provider: "fa", keyId: "k.fa.free", models: [m("plain1"), m("plain2"), m("opus", { badge: "PAID", pin: 5, pout: 25 }), m("cheap", { badge: "PAID", pin: 0.01, pout: 0.02 })] }];

test("H1: on a free-tier KEY a model with a LISTED price is costed at it: the dry run counts those models and their dollars, and one over the row ceiling stays pending priced-over-row-cap", async () => {
  const e = env(pricedWorld());
  const dry = await run(["--candidates", "policy", ...CAP], e.deps);
  assert.match(dry.out, /free-tier keys with a LISTED price: 2 of 4 queued model\(s\) are costed at the listed price, not as free: \$\d+\.\d+ at full depth/);
  assert.match(dry.out, /1 of them are over the \$0\.10 row ceiling at the levels asked \(1 of those within this run's cap\) and stay pending: priced-over-row-cap/, "the $5 / $25 model is over; the one-cent model is not");
  assert.match(dry.out, /coverage L1\+L2 .*priced-over-row-cap 1/, "and the ledger counts it with its reason");
  const live = await run(["--candidates", "policy", "--live", "--l3", "yes", ...CAP, "--max-spend", "5"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  const asked = new Set(calls(e.f).map((c) => c.body.model));
  assert.deepEqual([...asked].sort(), ["fa/cheap", "fa/plain1", "fa/plain2"], "the expensive listed price is never probed under the default row ceiling");
  const st = loadFidelity(e.out);
  assert.equal(st.pending["fa/opus"].r, "priced-over-row-cap");
  assert.ok(!st.models["fa/opus"]);
  const raised = await run(["--candidates", "policy", "--live", "--l3", "yes", ...CAP, "--max-spend", "5", "--max-row-cost", "5"], e.deps);
  assert.equal(raised.code, 0, raised.err + raised.out);
  assert.ok(loadFidelity(e.out).models["fa/opus"], "raising --max-row-cost probes it");
});

test("M1: the dry run and the report print the tier SOURCE and its age; stale tiers and providers missing from the map are warned about", async () => {
  const old = env(pricedWorld(), { policy: { compiledAt: "2026-10-01T10:00:00.000Z" }, tiers: { zz: "free" } });
  const r = await run(["--candidates", "policy", ...CAP], old.deps);
  assert.match(r.out, /provider tiers: policy given by the caller \(compiled 2026-10-01 10:00, 4 days old\); 1 of 1 provider\(s\) with probe-ok models have no tier in it/);
  assert.match(r.out, /WARNING: the provider tiers are older than 2 days/);
  assert.match(r.out, /WARNING: 1 provider\(s\) with probe-ok models are missing from the tier map: they count as NOT free/);
  const fresh = env(pricedWorld(), { policy: { compiledAt: "2026-10-05T09:00:00.000Z" } });
  const ok1 = await run(["--candidates", "policy", ...CAP], fresh.deps);
  assert.match(ok1.out, /provider tiers: policy given by the caller \(compiled 2026-10-05 09:00, under a day old\); 0 of 1 provider\(s\) with probe-ok models have no tier in it/);
  assert.doesNotMatch(ok1.out, /WARNING: the provider tiers are older|missing from the tier map/);
  const live = await run(["--candidates", "policy", "--live", "--l3", "yes", ...CAP, "--max-row-cost", "5"], fresh.deps);
  assert.match(live.out, /provider tiers: policy given by the caller[\s\S]*verified \(v\)/, "the report carries it too");
});

test("M2: the cost of lifting is printed as if --live were given, per tier, and the lift counts only when that line was actually shown", async () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }, { provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 1, pout: 2 }), m("b2", { badge: "PAID", pin: 1, pout: 2 })] }];
  const e = env(rows, { tiers: { fa: "free", pb: "paid" } });
  const dry = await run(["--candidates", "policy", "--include-tier", "paid", "--levels", "1234567", "--max-spend", "5", "--max-row-cost", "5", ...CAP], e.deps);
  assert.ok(dry.out.split("\n").some((l) => l.startsWith(LIFT_PREVIEW) && /paid 2 model\(s\), 14 requests, ~\d+k input tokens, \$\d+\.\d+/.test(l)), dry.out);
  assert.match(dry.out, /stay skipped until all of these hold: --live/, "in a dry run the lift still lacks --live; the preview is not what is missing");
  assert.equal(calls(e.f).length, 0);
  const live = await run(["--candidates", "policy", "--include-tier", "paid", "--levels", "1234567", "--max-spend", "5", "--max-row-cost", "5", "--l3", "yes", "--live", ...CAP], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /deep probes UNLOCKED for paid/);
  assert.ok(calls(e.f).some((c) => c.body.model === "pb/b1" && kindOf(c) === "3b"), "paid models were probed deep once all five conditions held");
});

test("M3: spend is charged per REQUEST that was billed: an answer that was all thinking and the larger-budget request asked after it are both counted, though no level finished", async () => {
  const rows = [{ provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 100, pout: 100 })] }];
  const e = env(rows, { tiers: { pb: "free" }, answer: (c) => ok(c.body.max_tokens < 2048 ? streamWith(1000, thinking(0, "hmm"), ev.stop("max_tokens", 256)) : streamWith(1000, thinking(0, "hmm"), ev.stop("max_tokens", 2048))) });
  const r = await run(["--live", "--max-spend", "5", "--max-row-cost", "5"], e.deps);
  const sp = r.out.match(/est\. spend \$([\d.]+) of the \$5\.00 cap/);
  assert.ok(sp, r.out + r.err);
  // two requests: (1000 in + 256 out) and (1000 in + 2048 out) at $100 per million tokens
  assert.ok(Math.abs(Number(sp[1]) - 0.43) < 0.011, `charged ${sp[1]}, expected about 0.43 (the escalation counts)`);
  assert.deepEqual(Object.keys(loadFidelity(e.out).models), [], "and no record: the answer was inconclusive");
});

test("L3: when the file's size cap pushes records out, the report says how many and why", async () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }];
  const e = env(rows);
  e.deps.saveImpl = (file, models, opts) => ({ ...saveFidelity(file, models, opts), dropped: ["gone/old1", "gone/old2", "fa/a1x"] });
  const r = await run(["--candidates", "policy", "--live", "--l3", "yes", ...CAP], e.deps);
  assert.match(r.out, /WARNING: the file's size cap pushed 3 record\(s\) out of tool-fidelity\.json: 3 of models that have left the catalogue, 0 the oldest ones/);
  const none = await run(["--candidates", "policy", "--live", "--l3", "yes", ...CAP], env(rows).deps);
  assert.doesNotMatch(none.out, /size cap pushed/);
});

// ---------------------------------------------------------------- L2: --merge-unsaved

function sideWorld() {
  const e = env([{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }]);
  const side = path.join(e.dir, "tool-fidelity.unsaved.json");
  const older = record("pppp", { at: "2026-10-01T00:00:00.000Z" }), newer = record("ppnn", { at: "2026-10-05T09:00:00.000Z" });
  saveFidelity(e.out, { "fa/keep": record("pppp", { at: "2026-10-04T00:00:00.000Z" }), "fa/redo": older }, { live: true, now: NOW });
  fs.writeFileSync(side, JSON.stringify({ schema: 1, kind: JSON.parse(fs.readFileSync(e.out, "utf8")).kind, generatedAt: NOW.toISOString(), models: { "fa/redo": newer, "fa/new": record("pppp"), "fa/keep": record("ppnn", { at: "2026-10-01T00:00:00.000Z" }) }, pending: {} }));
  return { e, side };
}

test("L2: --merge-unsaved is a dry count by default and changes nothing", async () => {
  const { e, side } = sideWorld();
  const before = fs.readFileSync(e.out, "utf8");
  const r = await run(["--merge-unsaved"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /tool-fidelity\.unsaved\.json holds 3 record\(s\): 2 would be taken \(new, or newer than the state file's\), 1 left alone/);
  assert.match(r.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  assert.ok(rawExists(side));
});

test("L2: --merge-unsaved --live takes the new and the newer records, never an older one, saves first and only then deletes the side file", async () => {
  const { e, side } = sideWorld();
  const r = await run(["--merge-unsaved", "--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/redo"].lvr, s["fa/new"].lvr, s["fa/keep"].lvr], ["ppnn", "pppp", "pppp"], "newer taken, new added, the older side record left out");
  assert.equal(rawExists(side), false);
  const failing = sideWorld();
  failing.e.deps.saveImpl = () => { throw new Error("disk full"); };
  const bad = await run(["--merge-unsaved", "--live"], failing.e.deps);
  assert.equal(bad.code, 1);
  assert.equal(rawExists(failing.side), true, "a failed save never deletes the side file");
  assert.match((await run(["--merge-unsaved"], env([{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }]).deps)).out, /nothing to merge/);
});

test("the new options parse: --merge-unsaved is its own mode and refuses nothing else", () => {
  assert.equal(parseArgs(["--merge-unsaved"]).mergeUnsaved, true);
  assert.equal(parseArgs([]).mergeUnsaved, undefined);
});

test("the pending reason of a model that ended without a result: the request ceiling and the priced-over-row-cap are their own codes, never an error", () => {
  assert.equal(pendingReasonOf({ s: "error", reason: "request-cap" }, null), "request-cap");
  assert.equal(pendingReasonOf({ s: "empty", reason: "reasoning-budget" }, null), "reasoning-budget");
  assert.equal(pendingReasonOf({ s: "skip", w: "row-cost" }, { pricedOnFree: true }), "priced-over-row-cap");
  assert.equal(pendingReasonOf({ s: "skip", w: "row-cost" }, { pricedOnFree: false }), "row-cost", "a paid-key row over the ceiling keeps the bench's own code");
  assert.equal(pendingReasonOf({ s: "skip", w: "spend-cap" }, null), "spend");
  assert.equal(pendingReasonOf({ s: "rate" }, null), "rate");
  for (const code of ["request-cap", "priced-over-row-cap"]) assert.match(code, /^[a-z0-9-]{1,24}$/, "fits the pending map's code format");
});

test("M2: plan() lifts only when the preview was PRINTED: the same five conditions with printed false keep the paid tier clamped and name the missing line", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }, { provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 1, pout: 2 })] }];
  const e = env(rows, { tiers: { fa: "free", pb: "paid" } });
  const o = parseArgs(["--candidates", "policy", "--include-tier", "paid", "--levels", "1234567", "--max-spend", "5", "--max-row-cost", "5", "--live", "--l3", "yes", ...CAP]);
  const args = { snap: e.deps.snapshot.snap, bench: e.deps.bench, store: {}, o, policy: e.deps.policy, tiers: e.deps.policy.tiers };
  const unprinted = plan({ ...args, printed: false });
  assert.equal(unprinted.lift.ok, false);
  assert.deepEqual(unprinted.lift.missing, ["the printed per-tier cost estimate"]);
  assert.ok(!unprinted.queued.some((x) => x.key === "pb/b1" && x.todo.some((l) => l > 2)), "no deep level for the paid model");
  const printed = plan({ ...args, printed: true });
  assert.equal(printed.lift.ok, true);
  assert.ok(printed.queued.some((x) => x.key === "pb/b1" && x.todo.some((l) => l > 2)), "and with the line printed, it has them");
});

test("B1: the ceiling also stops the thinking-only escalation: at the last request of the budget the larger-budget request is NOT sent", async () => {
  const f = fakeFetch(() => ok(streamWith(500, thinking(0, "hmm"), ev.stop("max_tokens", 256))));
  const state = { requests: MAX_MODEL_REQUESTS - 1 };
  const r = await probeModel({ levels: [1], done: {}, state, ...FREE, ...conn(f) });
  assert.equal(f.calls.length, 1, "one request was left; the escalation would have been the thirteenth");
  assert.equal(r.inconclusive.reason, "request-cap");
  assert.notEqual(state.escalated, true);
});

// ---------------------------------------------------------------- the owner's KEY CHOICE decides; most-restrictive applies only when it is unresolved

const IDROWS = [
  { provider: "groq", tier: "free", id: "groq.a" }, { provider: "groq", tier: "free", id: "groq.b" }, { provider: "groq", tier: "paid", id: "groq.c" },
  { provider: "openrouter", tier: "paid", id: "or.paid" }, { provider: "openrouter", tier: "free", id: "or.free" },
  { provider: "google", tier: "free", id: "g.1" }, { provider: "google", tier: "paid", id: "g.2" },
  { provider: "zenmux", tier: "free", id: "z.1" }, { provider: "zenmux", tier: "management", id: "z.m" },
  { provider: "solo", tier: "paid", id: "s.1" },
];

test("the owner's key CHOICE decides the tier of a multi-key provider (the compiler's rule); most-restrictive only where no choice resolves it; the detail says which and why", () => {
  const choices = { groq: "groq.a", openrouter: "or.free" };
  for (const rows of permutations(IDROWS)) {
    const r = resolveTierRows(rows, { choices });
    assert.deepEqual(r.tiers, { groq: "free", openrouter: "free", google: "paid", zenmux: "free", solo: "paid" }, "the chosen keys give free; google has no choice and is paid; zenmux ignores its management key");
    assert.deepEqual(r.conflicts, ["google"], "only the unresolved provider fell back to the most restrictive tier");
    const how = Object.fromEntries(r.detail.map((d) => [d.provider, d.how]));
    assert.deepEqual(how, { google: "most-restrictive", groq: "choice", openrouter: "choice", zenmux: "management-ignored" });
    assert.equal(r.detail.find((d) => d.provider === "groq").id, "groq.a");
  }
  assert.equal(resolveTierRows(IDROWS, { choices: { groq: "groq.c" } }).tiers.groq, "paid", "a choice of the paid key is respected");
  assert.equal(resolveTierRows(IDROWS, { choices: { google: "g.9" } }).tiers.google, "paid", "a choice naming no key of the provider resolves nothing: most restrictive");
  assert.equal(resolveTierRows(IDROWS, { choices: { zenmux: "z.m" } }).tiers.zenmux, "free", "a choice naming a management key is not a choice: the management key is never used");
  assert.equal(resolveTierRows(IDROWS).tiers.groq, "paid", "no choices at all: most restrictive");
  const withMgmt = [...IDROWS, { provider: "google", tier: "management", id: "g.m" }];
  assert.equal(resolveTierRows(withMgmt, { choices: { google: "g.m" } }).tiers.google, "paid", "two usable keys and a choice that names the MANAGEMENT key: not a choice, most restrictive of the usable ones");
});

test("parity with the compiler on the same registry and the same key choices: wherever chooseKeys resolves a provider the tier is the same; wherever it cannot, we are most restrictive and name the provider", () => {
  const reg = IDROWS.map((r) => ({ ...r, bucket: "b" }));
  const prov = new Map([...new Set(reg.map((r) => r.provider))].map((p) => [p, { provider: p, protocol: "anthropic" }]));
  for (const choices of [{}, { groq: "groq.a" }, { groq: "groq.c", openrouter: "or.free", google: "g.1" }]) {
    const filtered = filterRegistry(reg, prov);
    const resolved = {}, unresolved = [];
    const by = new Map();
    for (const r of filtered) (by.get(r.provider) ?? by.set(r.provider, []).get(r.provider)).push(r);
    for (const [p, rows] of by) {
      try { resolved[p] = chooseKeys(rows, choices)[0].tier; } catch { unresolved.push(p); }
    }
    const ours = resolveTierRows(reg, { choices });
    for (const [p, tier] of Object.entries(resolved)) assert.equal(ours.tiers[p], tier, `${p} with choices ${JSON.stringify(choices)}`);
    assert.deepEqual([...unresolved].sort(), [...ours.conflicts].sort(), `the providers the compiler cannot resolve are the ones we name (${JSON.stringify(choices)})`);
  }
});

test("a registry tiers file with a key-choices file: the dry run shows, per multi-key provider, which key and tier was chosen and why, and lists the ones that fell back to most-restrictive", async () => {
  const d = freshDir(), reg = path.join(d, "registry.json"), ch = path.join(d, "key-choices.json");
  fs.writeFileSync(reg, JSON.stringify(IDROWS));
  fs.writeFileSync(ch, JSON.stringify({ groq: "groq.a", openrouter: "or.free" }));
  const rows = IDROWS.map((r) => r.provider).filter((p, i, a) => a.indexOf(p) === i).map((p) => ({ provider: p, keyId: `k.${p}`, models: [m(`${p}-1`)] }));
  const e = env(rows, { tiers: {} });
  e.deps.tiers = undefined;
  const r = await run(["--tiers-file", reg, "--key-choices-file", ch], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /keys of groq: 3 \(free, free, paid\) -> free, the owner's key choice \(groq\.a\)/);
  assert.match(r.out, /keys of openrouter: 2 \(free, paid\) -> free, the owner's key choice \(or\.free\)/);
  assert.match(r.out, /keys of google: 2 \(free, paid\) -> paid, NO key choice, so the most restrictive tier/);
  assert.match(r.out, /keys of zenmux: 2 \(free, management\) -> free, the management key is ignored/);
  assert.match(r.out, /providers that fell back to the most restrictive tier \(no key choice recorded\): google/);
  assert.match(r.out, /skipped for now because the provider's key tier is not free \(paid 2\); 3 in the probe set/, "google and solo (paid) are out; groq, openrouter and zenmux (free by choice) are in");
  assert.ok(parseArgs(["--tiers-file", reg, "--key-choices-file", ch]).keyChoicesFile);
  const none = await run(["--tiers-file", reg], e.deps);
  assert.match(none.out, /providers that fell back to the most restrictive tier \(no key choice recorded\): google, groq, openrouter/);
});

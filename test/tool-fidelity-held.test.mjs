// Held providers (an account state or two models gone: out of the queue before the per-provider cap, zero requests, a visible block, `--retry-accounts` forces them in), the two-model gone
// canary, the retried rate pause, the `held` ledger bucket, the canary migration and the quiet heartbeat. Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan } from "../refresh/tool-fidelity-cli.mjs";
import { cleanHeld, activeHolds, HELD_MAX, MAX_FILE_BYTES, migrateCanary, coverage, saveFidelity, loadFidelity, FILE_NAME, REAL_FILE, HELD_PLAN, capRecords, renderFile } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T20:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

// ---------------------------------------------------------------- the held section of the file

test("cleanHeld keeps only well-formed holds (a safe provider name, pay/auth/gone, a real timestamp), at most HELD_MAX; activeHolds applies the window", () => {
  const raw = { a: { r: "pay", at: hoursAgo(1) }, b: { r: "auth", at: hoursAgo(10) }, c: { r: "gone", at: hoursAgo(2) }, d: { r: "rate", at: hoursAgo(1) }, "bad name!": { r: "pay", at: hoursAgo(1) }, e: { r: "pay", at: "nope" }, f: null, g: "x" };
  assert.deepEqual(Object.keys(cleanHeld(raw)), ["a", "b", "c"]);
  assert.deepEqual(cleanHeld(null), {});
  assert.deepEqual(cleanHeld([1]), {});
  const many = Object.fromEntries(Array.from({ length: HELD_MAX + 50 }, (_, i) => [`p${i}`, { r: "pay", at: hoursAgo(1) }]));
  assert.equal(Object.keys(cleanHeld(many)).length, HELD_MAX);
  const act = activeHolds(cleanHeld(raw), NOW.getTime(), 6);
  assert.deepEqual(Object.keys(act).sort(), ["a", "c"], "b is 10 hours old: past a 6-hour hold");
  assert.equal(act.a.until, Date.parse(hoursAgo(1)) + 6 * 3600000);
  assert.deepEqual(Object.keys(activeHolds(cleanHeld(raw), NOW.getTime(), 12)).sort(), ["a", "b", "c"], "a longer window keeps b");
  assert.deepEqual(Object.keys(activeHolds(cleanHeld(raw), NOW.getTime(), 0.5)), [], "a short one drops all");
});

test("the held section is stored in the same file (additive): it survives a save and a load, a writer that does not mention it keeps the one in the file, and it counts in the size cap", () => {
  const d = freshDir(), file = path.join(d, FILE_NAME);
  saveFidelity(file, { "fa/a": record("ppnn") }, { now: NOW, held: { fa: { r: "pay", at: hoursAgo(1) } } });
  assert.deepEqual(loadFidelity(file).held, { fa: { r: "pay", at: hoursAgo(1) } });
  assert.match(fs.readFileSync(file, "utf8"), /"held":\{"fa":\{"r":"pay"/);
  saveFidelity(file, { "fa/a": record("ppnn"), "fa/b": record("ppnn") }, { now: NOW });
  assert.deepEqual(Object.keys(loadFidelity(file).held), ["fa"], "a save that does not mention the holds keeps them");
  saveFidelity(file, { "fa/a": record("ppnn") }, { now: NOW, held: {} });
  assert.deepEqual(loadFidelity(file).held, {}, "an explicit empty object clears them");
  fs.writeFileSync(file, JSON.stringify({ schema: 1, kind: JSON.parse(renderFile([], NOW)).kind, generatedAt: NOW.toISOString(), models: {}, held: { ok1: { r: "gone", at: hoursAgo(1) }, no: { r: "x", at: "z" } } }));
  assert.deepEqual(Object.keys(loadFidelity(file).held), ["ok1"], "a file with junk in held loads the valid part");
  const models = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`fa/m${i}`, record("ppnn", { at: new Date(NOW.getTime() + i).toISOString() })]));
  const small = capRecords(models, { now: NOW, maxBytes: Buffer.byteLength(renderFile(Object.entries(models), NOW, null, null)) - 1 });
  const withHeld = capRecords(models, { now: NOW, maxBytes: Buffer.byteLength(renderFile(Object.entries(models), NOW, null, null)), held: { fa: { r: "pay", at: hoursAgo(1) } } });
  assert.ok(small.dropped.length >= 1 && withHeld.dropped.length >= 1, "the held text is part of the size the cap measures");
});

// ---------------------------------------------------------------- the queue: held before the cap, the cap re-split

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
const many = (p, n) => ({ provider: p, keyId: `k.${p}.free`, models: Array.from({ length: n }, (_, i) => m(`m${i}`)) });
function cliEnv(rows, { answer, held, pending } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], rateBackoffMs: 1, sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
  if (held || pending) saveFidelity(deps.outFile, {}, { now: NOW, held: held ?? {}, pending: pending ?? {} });
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
const byProv = (f) => { const o = {}; for (const c of calls(f)) { const p = c.body.model.split("/")[0]; o[p] = (o[p] ?? 0) + 1; } return o; };
const CAP = ["--tf-max-tokens-per-provider", "17100"];            // three models of about 5,670 tokens per provider

test("held providers leave the queue BEFORE the per-provider cap: zero requests (not even a canary), and their cap share is re-split among the providers that can run (at most twice the cap)", async () => {
  const rows = [many("pa", 12), many("pb", 12), many("pc", 12), many("pd", 12)];
  const held = { pb: { r: "pay", at: hoursAgo(1) }, pc: { r: "gone", at: hoursAgo(2) } };
  const e = cliEnv(rows, { held });
  const base = await run([...CAP], cliEnv(rows).deps);
  assert.match(base.out, /this run: 48 model\(s\) queued of 48; 12 fit the per-provider cap of 17,100/, "no holds: three models per provider fit");
  const dry = await run([...CAP], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /this run: 24 model\(s\) queued of 48; \d+ fit the per-provider cap of 17,100/, "the held providers' models are not in the queue at all");
  assert.match(dry.out, /held providers \(an account state or two models gone, within the 6-hour hold; zero requests, not even a canary; --retry-accounts forces them in\): 2 provider\(s\), 24 queued model\(s\) left out of the queue, ~\d+k input tokens of cap freed/);
  assert.match(dry.out, /pb: pay since 2026-10-05 19:00, retry after 01:00 UTC: 12 model\(s\) freed/);
  assert.match(dry.out, /pc: gone since 2026-10-05 18:00, retry after 00:00 UTC: 12 model\(s\) freed/);
  assert.match(dry.out, /per-provider cap re-split: 17,100 -> 34,200 input tokens for the providers that can run/, "4 providers, 2 can run: twice the cap, which is the bound");
  assert.match(dry.out, /this run: 24 model\(s\) queued of 48; 12 fit/, "twice the cap: six models per runnable provider");
  assert.equal(calls(e.f).length, 0);
  const live = await run(["--live", ...CAP], e.deps);
  assert.equal(live.code === 0 || live.code === 3, true, live.err + live.out);
  const by = byProv(e.f);
  assert.equal(by.pb, undefined, "zero requests to a provider that is held");
  assert.equal(by.pc, undefined);
  assert.ok(by.pa > 0 && by.pd > 0);
  const p = plan({ snap: e.deps.snapshot.snap, bench: e.deps.bench, store: {}, o: parseArgs(CAP), tiers: e.deps.tiers, held, nowMs: NOW.getTime() });
  assert.deepEqual(p.heldInfo.map((x) => [x.provider, x.models]), [["pb", 12], ["pc", 12]]);
  assert.equal(p.capEff, 34200);
  const three = plan({ snap: { rows: [many("pa", 12), many("pb", 12), many("pc", 12)] }, bench: e.deps.bench, store: {}, o: parseArgs(CAP), tiers: { pa: "free", pb: "free", pc: "free" }, held: { pc: held.pc }, nowMs: NOW.getTime() });
  assert.equal(three.capEff, 25650, "3 providers, 2 can run: 1.5 x the cap");
});

test("--retry-accounts forces held providers back into the queue; --hold-hours changes the window; an expired hold is gone", async () => {
  const rows = [many("pa", 4), many("pb", 4)];
  const held = { pb: { r: "pay", at: hoursAgo(3) } };
  const e = cliEnv(rows, { held });
  assert.match((await run([], e.deps)).out, /this run: 4 model\(s\) queued of 8/);
  assert.match((await run(["--retry-accounts"], e.deps)).out, /this run: 8 model\(s\) queued of 8/);
  assert.doesNotMatch((await run(["--retry-accounts"], e.deps)).out, /held providers/);
  assert.match((await run(["--hold-hours", "2"], e.deps)).out, /this run: 8 model\(s\) queued of 8/, "a 2-hour hold from 3 hours ago has ended");
  assert.match((await run(["--hold-hours", "12"], e.deps)).out, /this run: 4 model\(s\) queued of 8/);
  assert.equal(parseArgs(["--hold-hours", "3"]).holdHours, 3);
  assert.equal(parseArgs([]).holdHours, 6);
  assert.ok(parseArgs(["--hold-hours", "0"]).error);
  assert.equal(parseArgs(["--retry-accounts"]).retryAccounts, true);
});

// ---------------------------------------------------------------- live: a canary writes the hold; the next run honours it

test("a pay or auth canary is written to the file as a HOLD with its time; the next run asks that provider NOTHING; --retry-accounts asks it again and a provider that answers is released", async () => {
  for (const [status, why] of [[402, "pay"], [401, "auth"]]) {
    let open = false;
    const e = cliEnv([many("pa", 3), many("pb", 3)], { answer: (c) => (!open && c.body.model.startsWith("pb/") ? http(status, "nope") : goodModel(c)) });
    const r1 = await run(["--live", "--per-provider", "1"], e.deps);
    assert.deepEqual(loadFidelity(e.out).held, { pb: { r: why, at: NOW.toISOString() } });
    assert.match(r1.out, new RegExp(`pb: ${why} \\(.*\\) -- 3 model\\(s\\) skipped -- held until 02:00 UTC \\(--retry-accounts forces it\\)`));
    e.f.calls.length = 0;
    const r2 = await run(["--live", "--per-provider", "1"], e.deps);
    assert.equal(byProv(e.f).pb, undefined, "the next run: not one request, not even a canary");
    assert.match(r2.out, /held providers .*: 1 provider\(s\)/);
    open = true;
    const r3 = await run(["--live", "--per-provider", "1", "--retry-accounts"], e.deps);
    assert.ok(byProv(e.f).pb > 0);
    const st = loadFidelity(e.out);
    assert.ok(st.models["pb/m0"], "the account works now: probed");
    assert.deepEqual(st.held, {}, "a provider that answered is released");
    void r3;
  }
});

// ---------------------------------------------------------------- gone is about ONE model

test("a GONE answer for one model does not pause the provider: the gone model is pending gone, the other models are probed; only TWO distinct gone models (and no answer) pause it, and hold it", async () => {
  const one = cliEnv([many("pa", 4)], { answer: (c) => (c.body.model === "pa/m0" ? http(404, "model not found") : goodModel(c)) });
  const r1 = await run(["--live", "--per-provider", "1"], one.deps);
  const s1 = loadFidelity(one.out);
  assert.equal(s1.pending["pa/m0"].r, "gone");
  assert.deepEqual(Object.keys(s1.models).sort(), ["pa/m1", "pa/m2", "pa/m3"], "the rest of the provider was probed");
  assert.deepEqual(s1.held, {});
  assert.doesNotMatch(r1.out, /providers needing attention/);
  const two = cliEnv([many("pa", 6)], { answer: (c) => http(404, "model not found") });
  const r2 = await run(["--live", "--per-provider", "1"], two.deps);
  const s2 = loadFidelity(two.out);
  assert.equal(calls(two.f).length, 4, "FOUR distinct models asked, then the provider is paused: zero further requests");
  assert.deepEqual(s2.held, { pa: { r: "gone", at: NOW.toISOString() } });
  assert.deepEqual(["pa/m0", "pa/m1", "pa/m3", "pa/m4"].map((k) => s2.pending[k].r), ["gone", "gone", "gone", "gone"], "the sample was spread over the queue: first, middle, quarters");
  assert.equal(s2.pending["pa/m2"].r, "canary-gone");
  assert.match(r2.out, /pa: gone \(the route or model no longer exists\) -- 6 model\(s\) skipped -- held until/);
  const answered = cliEnv([many("pa", 5)], { answer: (c) => (["pa/m2", "pa/m3"].includes(c.body.model) ? http(404, "model not found") : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], answered.deps);
  const s3 = loadFidelity(answered.out);
  assert.deepEqual(Object.keys(s3.models).sort(), ["pa/m0", "pa/m1", "pa/m4"], "two gone models do not pause a provider that has answered: the model after them was still probed");
  assert.deepEqual([s3.pending["pa/m2"].r, s3.pending["pa/m3"].r], ["gone", "gone"]);
  assert.deepEqual(s3.held, {});
});

// ---------------------------------------------------------------- the ledger: held is its own bucket

test("the ledger has a `held` bucket: models of a held provider are not pending, never 'pending too long' (even with old pending entries), and the states still add up", async () => {
  const rows = [many("pa", 3), many("pb", 3)];
  const pending = Object.fromEntries(["pb/m0", "pb/m1", "pb/m2", "pa/m0"].map((k) => [k, { r: k.startsWith("pb") ? "canary-pay" : "cap", n: 9, at: hoursAgo(30) }]));
  const e = cliEnv(rows, { held: { pb: { r: "pay", at: hoursAgo(1) } }, pending });
  const dry = await run([], e.deps);
  assert.match(dry.out, /coverage L1\+L2 \(every listed model\): 6 model\(s\) = tested 0 \(none\) \+ pending 3 \(.*\) \+ excluded 0 \(none\) \+ held 3 \(pay 3: a provider with an account state, not asked for a while\)/);
  assert.doesNotMatch(dry.out, /pending too long \d+ of \d+: [^\n]*pb\//, "held models are not stuck");
  assert.match(dry.out, /pending too long 1 of 6: pa\/m0 cap x9/, "a genuinely stuck model still is");
  const p = plan({ snap: e.deps.snapshot.snap, bench: e.deps.bench, store: {}, o: parseArgs([]), tiers: e.deps.tiers, pending, held: { pb: { r: "pay", at: hoursAgo(1) } }, nowMs: NOW.getTime() });
  assert.deepEqual([p.ledger.l12.counts.held, p.ledger.l12.counts.byHeld], [3, { pay: 3 }]);
  assert.equal(p.ledger.l12.counts.total, p.ledger.l12.counts.tested + p.ledger.l12.counts.pending + p.ledger.l12.counts.excluded + p.ledger.l12.counts.held);
  const tested = coverage([{ key: "pb/m0" }, { key: "pb/m1" }], { "pb/m0": record("ppnn") }, { plan: { "pb/m0": HELD_PLAN, "pb/m1": HELD_PLAN }, heldWhy: { pb: "pay" } });
  assert.deepEqual([tested.counts.tested, tested.counts.held], [1, 1], "a model that already has a result stays tested; only the untested one is held");
});

// ---------------------------------------------------------------- the quiet heartbeat and the held block at the start

test("the heartbeat prints COUNTS of paused providers, not names, and the held providers are shown once at the start", async () => {
  const e = cliEnv([many("pa", 3), many("pb", 3), many("pz", 2)], { held: { pz: { r: "pay", at: hoursAgo(1) } }, answer: (c) => (c.body.model.startsWith("pb/") ? http(402, "no credit") : goodModel(c)) });
  e.deps.heartbeatMs = 10;
  const slowFetch = async (url, init) => { await new Promise((r) => setTimeout(r, 25)); return e.f(url, init); };
  e.deps.fetch = slowFetch;
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const beats = r.out.split("\n").filter((l) => l.includes("[heartbeat"));
  assert.ok(beats.length >= 2);
  assert.ok(beats.some((l) => /paused: pay 1/.test(l)), beats.join("\n"));
  assert.ok(beats.every((l) => !/paused: [^;]*(pb|pz)/.test(l)), "the paused part is counts, not names");
  const idx = r.out.indexOf("held providers"), first = r.out.indexOf("[heartbeat");
  assert.ok(idx >= 0 && idx < first, "the held block comes once, before the run starts");
  assert.equal(r.out.split("held providers (").length - 1, 1);
});

// ---------------------------------------------------------------- the canary migration

test("migrateCanary (pure): clears the canary-gone entries, turns pay/auth entries into holds at their own time (not where a newer record exists, not when already held longer), touches nothing else, is idempotent", () => {
  const store = { "pc/old": record("ppnn", { at: hoursAgo(50) }), "pe/new": record("ppnn", { at: hoursAgo(1) }) };
  const pending = {
    "pa/m0": { r: "canary-gone", n: 3, at: hoursAgo(5) }, "pa/m1": { r: "canary-gone", n: 3, at: hoursAgo(5) }, "pb/m0": { r: "gone", n: 1, at: hoursAgo(5) },
    "pc/m0": { r: "canary-pay", n: 2, at: hoursAgo(9) }, "pc/m1": { r: "pay", n: 4, at: hoursAgo(8) }, "pd/m0": { r: "canary-auth", n: 1, at: hoursAgo(3) },
    "pe/m0": { r: "canary-pay", n: 1, at: hoursAgo(10) }, "pf/m0": { r: "rate", n: 1, at: hoursAgo(1) }, "pg/m0": { r: "canary-pay", n: 1, at: hoursAgo(20) },
  };
  const held = { pg: { r: "pay", at: hoursAgo(2) } };
  const before = JSON.stringify([store, pending, held]);
  const r = migrateCanary(store, pending, held);
  assert.equal(JSON.stringify([store, pending, held]), before, "pure");
  assert.deepEqual(r.goneCleared.sort(), ["pa/m0", "pa/m1"]);
  assert.deepEqual(r.goneProviders, ["pa"]);
  assert.deepEqual(r.seeded.map((x) => [x.provider, x.r, x.at]).sort(), [["pc", "pay", hoursAgo(8)], ["pd", "auth", hoursAgo(3)]], "the newest entry of each provider decides");
  assert.deepEqual(Object.keys(r.pending).sort(), ["pb/m0", "pc/m0", "pc/m1", "pd/m0", "pe/m0", "pf/m0", "pg/m0"], "only canary-gone entries are removed");
  assert.deepEqual(Object.keys(r.held).sort(), ["pc", "pd", "pg"], "pe has a newer record, pg is already held more recently");
  assert.equal(r.held.pg.at, hoursAgo(2));
  const again = migrateCanary(store, r.pending, r.held);
  assert.deepEqual([again.goneCleared, again.seeded], [[], []]);
  assert.deepEqual(migrateCanary(null, null, null).goneCleared, []);
});

test("--reset-canary is dry by default (counts of canary-gone entries, providers, holds to seed) and writes nothing; --live applies it under the lock, atomically; a failing save changes nothing", async () => {
  const pending = { "pa/m0": { r: "canary-gone", n: 3, at: hoursAgo(5) }, "pa/m1": { r: "canary-gone", n: 3, at: hoursAgo(5) }, "pb/m0": { r: "canary-gone", n: 1, at: hoursAgo(5) }, "pc/m0": { r: "canary-pay", n: 2, at: hoursAgo(2) } };
  const e = cliEnv([many("pa", 2), many("pb", 1), many("pc", 1)], { pending });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--reset-canary"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /3 canary-gone entries of 2 provider\(s\) would be cleared \(the two-model logic judges them again\); 1 provider\(s\) would become holds \(pay 1\), 0 already held/);
  assert.match(dry.out, /gone providers: pa, pb/);
  assert.match(dry.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  const live = await run(["--reset-canary", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.pending), ["pc/m0"]);
  assert.deepEqual(st.held, { pc: { r: "pay", at: hoursAgo(2) } });
  assert.ok(!fs.existsSync(e.deps.lockFile));
  assert.match((await run(["--reset-canary", "--live"], e.deps)).out, /nothing to change/);
  const f = cliEnv([many("pa", 1)], { pending: { "pa/m0": { r: "canary-gone", n: 1, at: hoursAgo(1) } } });
  f.deps.saveImpl = () => { throw new Error("disk full"); };
  const bad = await run(["--reset-canary", "--live"], f.deps);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /could not save \(disk full\); nothing was changed/);
  assert.equal(parseArgs(["--reset-canary"]).resetCanary, true);
});

test("a burst of rate limits makes the provider wait and be tried again in the SAME run: once it answers, nothing is left pending rate; a provider that keeps limiting is left alone only after a second episode", async () => {
  let n = 0;
  const e = cliEnv([many("pa", 4)], { answer: (c) => (n++ < 3 ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.models).sort(), ["pa/m1", "pa/m2", "pa/m3"], "after the wait the provider was tried again in the same run: the models behind the first one were probed");
  assert.equal(st.pending["pa/m0"].r, "rate", "the model that met the burst waits for a later run");
  assert.doesNotMatch(r.out, /left alone for the rest of this run/);
  const always = cliEnv([many("pa", 6)], { answer: () => http(429, "slow down", { "retry-after": "0" }) });
  const r2 = await run(["--live", "--per-provider", "1"], always.deps);
  assert.match(r2.out, /left alone for the rest of this run, their models stay pending: pa \(rate-limited\)/);
  assert.ok(calls(always.f).length >= 6 && calls(always.f).length <= 12, `${calls(always.f).length} requests: three, a wait, three more, then nothing`);
});

test("saveFidelity measures the size cap on the file AS WRITTEN, holds included: a file that is full of records and holds stays under the cap by dropping the oldest records", () => {
  const d = freshDir(), file = path.join(d, FILE_NAME);
  const mk = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`pv${String(i % 90).padStart(2, "0")}/model-${String(i).padStart(6, "0")}`, record("ppnn", { at: new Date(NOW.getTime() + i * 1000).toISOString() })]));
  const holds = Object.fromEntries(Array.from({ length: HELD_MAX }, (_, i) => [`hold${i}`, { r: "pay", at: NOW.toISOString() }]));
  let n = 4000;
  while (Buffer.byteLength(renderFile(Object.entries(mk(n)), NOW)) < MAX_FILE_BYTES - 30000) n += 100;
  const models = mk(n);
  assert.ok(Buffer.byteLength(renderFile(Object.entries(models), NOW)) <= MAX_FILE_BYTES, "without the holds it would fit");
  assert.ok(Buffer.byteLength(renderFile(Object.entries(models), NOW, null, holds)) > MAX_FILE_BYTES, "with the holds it does not");
  const r = saveFidelity(file, models, { now: NOW, held: holds });
  assert.ok(r.bytes <= MAX_FILE_BYTES && fs.statSync(file).size <= MAX_FILE_BYTES, `written ${r.bytes}`);
  assert.ok(r.dropped.length >= 1);
  assert.equal(Object.keys(loadFidelity(file).held).length, HELD_MAX);
});

test("the cap re-split has a bound: with most providers held the runnable ones get at most TWICE the cap", () => {
  const rows = ["pa", "pb", "pc", "pd"].map((p) => many(p, 12));
  const held = { pb: { r: "pay", at: hoursAgo(1) }, pc: { r: "pay", at: hoursAgo(1) }, pd: { r: "auth", at: hoursAgo(1) } };
  const e = cliEnv(rows);
  const p = plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs(CAP), tiers: e.deps.tiers, held, nowMs: NOW.getTime() });
  assert.equal(p.capEff, 34200, "four providers, one can run: 4 x would be 68,400 unbounded; the bound is twice the cap");
});

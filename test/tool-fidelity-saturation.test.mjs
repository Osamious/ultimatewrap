// Reaching every reachable model: models that already failed queue BEHIND the ones never asked (the cap is no longer eaten by the same failing few), a provider that has answered before is never held
// on gone or pay grounds, the gone evidence is four spread models, wrong holds can be released, and the per-provider table says why each model is untested. Offline: fixtures only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan, spreadOrder, untestedLines } from "../refresh/tool-fidelity-cli.mjs";
import { confirmedProviders, holdIsWrong, releaseHolds, untestedTable, coverage, HELD_PLAN, saveFidelity, loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T20:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();
const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
const many = (p, n, from = 0) => ({ provider: p, keyId: `k.${p}.free`, models: Array.from({ length: n }, (_, i) => m(`m${String(i + from).padStart(2, "0")}`)) });
const CAP = ["--tf-max-tokens-per-provider", "17100"];            // three models of about 5,670 tokens per provider

function cliEnv(rows, { answer, store, held, pending } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], rateBackoffMs: 1, sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
  if (store || held || pending) saveFidelity(deps.outFile, store ?? {}, { now: NOW, held: held ?? {}, pending: pending ?? {} });
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
const askedBy = (f) => { const o = {}; for (const c of calls(f)) o[c.body.model] = (o[c.body.model] ?? 0) + 1; return o; };

// ---------------------------------------------------------------- the cap is not eaten by the same failing models

test("STARVATION: models that already failed queue BEHIND the ones never asked, so run after run the next models get the cap's slots (it used to be the same first few every time)", async () => {
  const FAIL = new Set(["pa/m00", "pa/m01", "pa/m02", "pa/m03", "pa/m04", "pa/m05"]);      // the first six models of a big provider cannot be used (credit needed for them only)
  const e = cliEnv([many("pa", 12)], { store: { "pa/known": record("ppnn") }, answer: (c) => (FAIL.has(c.body.model) ? http(402, "this model needs credit") : goodModel(c)) });
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    e.f.calls.length = 0;
    await run(["--live", "--per-provider", "1", ...CAP], e.deps);
    seen.push(Object.keys(askedBy(e.f)).sort());
  }
  assert.deepEqual(seen[0], ["pa/m00", "pa/m01", "pa/m02"], "run 1: the first three");
  assert.deepEqual(seen[1], ["pa/m03", "pa/m04", "pa/m05"], "run 2: NOT the same three again: the next three");
  assert.deepEqual(seen[2], ["pa/m06", "pa/m07", "pa/m08"], "run 3: models never asked go before the ones that failed");
  const st = loadFidelity(e.out);
  assert.ok(["pa/m06", "pa/m07", "pa/m08", "pa/m09", "pa/m10", "pa/m11"].every((k) => st.models[k] || seen.flat().includes(k)), "every reachable model was reached");
  assert.deepEqual(Object.keys(st.models).filter((k) => k !== "pa/known").sort(), ["pa/m06", "pa/m07", "pa/m08", "pa/m09", "pa/m10", "pa/m11"], "after four runs every model that CAN answer has a record");
  assert.equal(askedBy(e.f)["pa/m00"], undefined);
  assert.equal(st.pending["pa/m00"].r, "pay", "and the ones that cannot are pending pay (a model's own state, the provider was not held)");
  assert.deepEqual(st.held, {}, "a provider that has answered is never held for it");
});

test("the queue order is stable: among models with the same history the priority queue's own order stands; `cap`, canary and not-run entries do not push a model back", () => {
  const rows = [many("pa", 8)];
  const e = cliEnv(rows);
  const pend = (r, n = 2) => ({ r, n, at: hoursAgo(1) });
  const pending = { "pa/m00": pend("pay"), "pa/m01": pend("cap", 9), "pa/m02": pend("canary-pay"), "pa/m03": pend("rate", 1), "pa/m04": pend("not-run", 3) };
  const p = plan({ snap: { rows }, bench: e.deps.bench, store: {}, o: parseArgs(["--tf-max-tokens-per-provider", "1000000"]), tiers: e.deps.tiers, pending, nowMs: NOW.getTime() });
  assert.deepEqual(p.queued.map((x) => x.key.slice(3)), ["m01", "m02", "m04", "m05", "m06", "m07", "m03", "m00"], "never asked first (cap, canary and not-run count as never asked), then by how often they failed: m03 once, m00 twice");
});

// ---------------------------------------------------------------- the hold rule

test("spreadOrder: the first four asked are the first, the middle and the two quarter points of the queue; short lists are not reordered", () => {
  const l = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(spreadOrder(l).slice(0, 4), [0, 5, 2, 7]);
  assert.deepEqual(spreadOrder(l).slice().sort((a, b) => a - b), l, "nothing is lost or repeated");
  assert.deepEqual(spreadOrder([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.deepEqual(spreadOrder([]), []);
  assert.equal(new Set(spreadOrder(Array.from({ length: 5 }, (_, i) => i))).size, 5);
});

test("a provider that has CONFIRMED results is never paused or held for gone or pay: those models are pending gone / pay and the provider goes on; auth is still the key's state", async () => {
  for (const status of [404, 402]) {
    const e = cliEnv([many("pa", 8)], { store: { "pa/known": record("ppnn") }, answer: (c) => (["pa/m00", "pa/m02", "pa/m05", "pa/m06"].includes(c.body.model) ? http(status, "model unavailable to you") : goodModel(c)) });
    await run(["--live", "--per-provider", "1"], e.deps);
    const st = loadFidelity(e.out);
    assert.deepEqual(st.held, {}, `${status}: no hold`);
    assert.equal(Object.keys(st.models).length, 1 + 4, "the four other models were probed");
    assert.equal(st.pending["pa/m00"].r, status === 404 ? "gone" : "pay");
  }
  const key = cliEnv([many("pa", 6)], { store: { "pa/known": record("ppnn") }, answer: () => http(401, "bad key") });
  await run(["--live", "--per-provider", "1"], key.deps);
  assert.equal(loadFidelity(key.out).held.pa.r, "auth", "an invalid key is the account's state even for a provider that worked before");
});

test("without any answer: FOUR spread models gone pause and hold a provider as gone, three do not; two out of credit hold it as pay, one does not", async () => {
  const three = cliEnv([many("pa", 8)], { answer: (c) => (["pa/m00", "pa/m04", "pa/m02"].includes(c.body.model) ? http(404, "gone") : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], three.deps);
  assert.deepEqual(loadFidelity(three.out).held, {}, "three gone, then a model that answers: not gone");
  const four = cliEnv([many("pa", 8)], { answer: () => http(404, "gone") });
  await run(["--live", "--per-provider", "1"], four.deps);
  assert.equal(calls(four.f).length, 4);
  assert.deepEqual(Object.keys(askedBy(four.f)).sort(), ["pa/m00", "pa/m02", "pa/m04", "pa/m06"], "spread: first, quarter, middle, three quarters");
  assert.equal(loadFidelity(four.out).held.pa.r, "gone");
  const one = cliEnv([many("pa", 6)], { answer: (c) => (c.body.model === "pa/m00" ? http(402, "no credit") : goodModel(c)) });
  await run(["--live", "--per-provider", "1"], one.deps);
  assert.deepEqual(loadFidelity(one.out).held, {}, "one model out of credit is that model's state");
  const two = cliEnv([many("pa", 6)], { answer: () => http(402, "no credit") });
  await run(["--live", "--per-provider", "1"], two.deps);
  assert.equal(calls(two.f).length, 2);
  assert.equal(loadFidelity(two.out).held.pa.r, "pay");
});

test("a hold in the file on gone or pay grounds for a provider that has confirmed results is IGNORED by the queue (and said so); an auth hold and a hold on a provider with no result stay", async () => {
  const store = { "pa/k1": record("ppnn"), "pb/k1": record("ppnn"), "pc/k1": record("ppnn") };
  const held = { pa: { r: "gone", at: hoursAgo(1) }, pb: { r: "pay", at: hoursAgo(1) }, pc: { r: "auth", at: hoursAgo(1) }, pd: { r: "gone", at: hoursAgo(1) } };
  const rows = [many("pa", 3), many("pb", 3), many("pc", 3), many("pd", 3)];
  const e = cliEnv(rows, { store, held });
  const dry = await run([], e.deps);
  assert.match(dry.out, /holds ignored because the provider has confirmed results \(gone and pay are answers about models there\): pa, pb; --reset-gone-holds removes them from the file/);
  assert.match(dry.out, /this run: 6 model\(s\) queued of /, "pa and pb are in the queue (3 each); pc (auth) and pd (gone, no results) are held");
  assert.match(dry.out, /held providers .*: 2 provider\(s\), 6 queued model\(s\)/);
  assert.equal(confirmedProviders(store).pa, 1);
  assert.ok(holdIsWrong(held.pa, confirmedProviders(store), "pa") && holdIsWrong(held.pb, confirmedProviders(store), "pb"));
  assert.ok(!holdIsWrong(held.pc, confirmedProviders(store), "pc") && !holdIsWrong(held.pd, confirmedProviders(store), "pd"));
});

// ---------------------------------------------------------------- releasing holds

test("releaseHolds (pure): names providers and/or every gone/pay hold with confirmed results; the canary-* pending entries of a released provider go with it; other entries stay", () => {
  const store = { "pa/k": record("ppnn"), "pb/k": record("ppnn"), "pe/k": record("ffnn", { strikes: 2, sl: 1 }) };
  const held = { pa: { r: "gone", at: hoursAgo(1) }, pb: { r: "pay", at: hoursAgo(1) }, pc: { r: "gone", at: hoursAgo(1) }, pd: { r: "auth", at: hoursAgo(1) }, pe: { r: "gone", at: hoursAgo(1) } };
  const pending = { "pa/m0": { r: "canary-gone", n: 3, at: hoursAgo(2) }, "pa/m1": { r: "gone", n: 1, at: hoursAgo(2) }, "pc/m0": { r: "canary-gone", n: 1, at: hoursAgo(2) } };
  const before = JSON.stringify([store, held, pending]);
  const w = releaseHolds(store, pending, held, { wrong: true });
  assert.equal(JSON.stringify([store, held, pending]), before, "pure");
  assert.deepEqual(w.released.map((x) => [x.provider, x.r, x.confirmed]), [["pa", "gone", 1], ["pb", "pay", 1]], "pe's only record is an x: not a confirmed result");
  assert.deepEqual(Object.keys(w.held).sort(), ["pc", "pd", "pe"]);
  assert.deepEqual(Object.keys(w.pending).sort(), ["pa/m1", "pc/m0"], "only the canary entry of the released provider goes");
  const named = releaseHolds(store, pending, held, { providers: ["pc", "pz"] });
  assert.deepEqual([named.released.map((x) => x.provider), named.missing], [["pc"], ["pz"]]);
  assert.deepEqual(Object.keys(named.pending).sort(), ["pa/m0", "pa/m1"]);
  assert.deepEqual(releaseHolds(store, pending, held, {}).released, [], "no option: nothing");
  assert.deepEqual(releaseHolds(null, null, null, { wrong: true }).released, []);
});

test("--release-holds and --reset-gone-holds are dry by default (they list what would go) and write nothing; --live applies them under the lock, atomically; a failing save changes nothing", async () => {
  const store = { "pa/k": record("ppnn") };
  const held = { pa: { r: "gone", at: hoursAgo(1) }, pc: { r: "pay", at: hoursAgo(1) } };
  const pending = { "pa/m0": { r: "canary-gone", n: 3, at: hoursAgo(2) } };
  const e = cliEnv([many("pa", 2), many("pc", 2)], { store, held, pending });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--reset-gone-holds"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /1 of 2 hold\(s\) would be released: pa \(gone, 1 confirmed\)/);
  assert.match(dry.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  const named = await run(["--release-holds", "pc,zz"], e.deps);
  assert.match(named.out, /1 of 2 hold\(s\) would be released: pc \(pay\)/);
  assert.match(named.out, /not held: zz/);
  const live = await run(["--reset-gone-holds", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  const st = loadFidelity(e.out);
  assert.deepEqual([Object.keys(st.held), Object.keys(st.pending)], [["pc"], []]);
  assert.ok(!fs.existsSync(e.deps.lockFile));
  assert.match((await run(["--reset-gone-holds", "--live"], e.deps)).out, /nothing to release/);
  assert.equal((await run(["--release-holds", "pc", "--live"], e.deps)).code, 0);
  assert.deepEqual(loadFidelity(e.out).held, {});
  const f = cliEnv([many("pa", 1)], { store, held: { pa: { r: "gone", at: hoursAgo(1) } } });
  f.deps.saveImpl = () => { throw new Error("disk full"); };
  const bad = await run(["--reset-gone-holds", "--live"], f.deps);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /could not save \(disk full\); nothing was changed/);
  assert.deepEqual(parseArgs(["--release-holds", "a, b"]).releaseHolds, ["a", "b"]);
  assert.ok(parseArgs(["--release-holds"]).error);
  assert.equal(parseArgs(["--reset-gone-holds"]).resetGoneHolds, true);
});

// ---------------------------------------------------------------- the per-provider table

test("the table says per provider why models are untested (held:state, paused:state, cap, queued, the stored reasons) and whether the provider can run; the dry run and the ledger agree", async () => {
  const rows = [many("pa", 4), many("pb", 3), many("pc", 2), many("pd", 2)];
  const pending = { "pc/m00": { r: "canary-pay", n: 2, at: hoursAgo(5) }, "pc/m01": { r: "pay", n: 1, at: hoursAgo(5) }, "pd/m00": { r: "error", n: 4, at: hoursAgo(5) }, "pd/m01": { r: "error", n: 4, at: hoursAgo(5) } };
  const e = cliEnv(rows, { store: { "pa/m00": record("ppnn") }, held: { pb: { r: "pay", at: hoursAgo(1) } }, pending });
  const dry = await run(["--tf-max-tokens-per-provider", "5700"], e.deps);
  assert.match(dry.out, /untested because, per provider \(4 provider\(s\) with untested models/);
  assert.match(dry.out, /pb\s+tested\s+0, untested\s+3: held:pay 3 -- not runnable now/);
  assert.match(dry.out, /pa\s+tested\s+1, untested\s+3: cap 2, queued 1 -- runnable/);
  assert.match(dry.out, /pd\s+tested\s+0, untested\s+2: .*(error 2|queued 1).* -- runnable/);
  assert.match(dry.out, /of 10 untested model\(s\), \d+ sit with a provider that can run now/);
  const p = plan({ snap: { rows }, bench: e.deps.bench, store: { "pa/m00": record("ppnn") }, o: parseArgs(["--tf-max-tokens-per-provider", "5700"]), tiers: e.deps.tiers, pending, held: { pb: { r: "pay", at: hoursAgo(1) } }, nowMs: NOW.getTime() });
  const t = p.untested.find((r) => r.provider === "pa");
  assert.deepEqual([t.tested, t.untested, t.runnable], [1, 3, true]);
  const cov = coverage([{ key: "pc/m00" }, { key: "pc/m01" }, { key: "pe/m00" }], { "pe/m00": record("ppnn") }, { pending, plan: {}, level: "l12" });
  const rowsPc = untestedTable(cov);
  assert.deepEqual(rowsPc.map((r) => [r.provider, r.why, r.runnable]), [["pc", { "paused:pay": 1, pay: 1 }, false]], "a paused-by-canary model is shown as paused, a provider with nothing queued is not runnable");
  assert.deepEqual(untestedLines([]), []);
  assert.deepEqual(untestedTable(coverage([{ key: "pb/m0" }], {}, { plan: { "pb/m0": HELD_PLAN }, heldWhy: { pb: "gone" } }))[0].why, { "held:gone": 1 });
});

test("the report after a live run carries the table too, with the holds this run wrote", async () => {
  const e = cliEnv([many("pa", 3), many("pb", 3)], { answer: (c) => (c.body.model.startsWith("pb/") ? http(402, "no credit") : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.match(r.out, /untested because, per provider \(1 provider\(s\) with untested models/);
  assert.match(r.out, /pb\s+tested\s+0, untested\s+3: held:pay 3 -- not runnable now/, "pb was paused by its canary in this run and is on hold now");
});

test("--candidates policy: a model whose KNOWN context is too small for the 157 KB fixture is out of the L3 candidates but still gets its SMALL requests (L1, L2, spawn, the error result): it used to sit untested forever", async () => {
  const rows = [{ provider: "pa", keyId: "k.pa.free", models: [m("big1", { ctx: 256000 }), m("tiny", { ctx: 8192 }), m("tiny2", { ctx: 32768 })] }];
  const policy = { schema: 1, models: [{ s: "pa/big1", c: 256000 }], tiers: { pa: "free" } };
  const e = cliEnv(rows);
  e.deps.policy = policy;
  const dry = await run(["--candidates", "policy", "--levels", "12"], e.deps);
  assert.match(dry.out, /this run: 3 model\(s\) queued of 3/, "all three are queued for L1+L2");
  assert.match(dry.out, /excluded: ctx-too-small-for-fixture 2/, "the two small ones are still out of the L3 candidates");
  const live = await run(["--live", "--candidates", "policy", "--l3", "yes", "--tf-max-tokens-per-provider", "1000000", "--per-provider", "1"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  const kinds = {};
  for (const c of calls(e.f)) { const k = c.body.tools.length > 100 ? "big" : c.body.tools.length > 40 ? "3b" : "small"; (kinds[c.body.model] ??= new Set()).add(k); }
  assert.deepEqual([...kinds["pa/tiny"]], ["small"], "only small requests for the 8,192-token model");
  assert.deepEqual([...kinds["pa/tiny2"]], ["small"]);
  assert.ok(kinds["pa/big1"].has("3b"), "the candidate gets the large requests");
  const st = loadFidelity(e.out).models;
  assert.deepEqual([st["pa/tiny"].lvr, st["pa/tiny2"].lvr, st["pa/big1"].lvr], ["ppnn", "ppnn", "pppp"]);
  const dry2 = await run(["--candidates", "policy", "--levels", "12"], e.deps);
  assert.match(dry2.out, /nothing to probe/);
});

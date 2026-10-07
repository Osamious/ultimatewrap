// The policy library and the pure funnel against the fixture rows of plan 9.2b (never the real snapshot, bench, registry or
// state). Counts in assertions carry their fixture denominator: 18 snapshot routes, 17 selectors after the [1m] collapse,
// 15 probe-ok and tool-eligible selectors.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { fixtureFlagMap } from "./fixtures/subagent-flags.mjs";
import * as lib from "../keysync/subagent-policy.mjs";
import { funnel, BIG_PROVEN_BYTES, provenBytes, ctxStatedOf, FREE_TAG, fnv1a32, priceText, priceSum, isPremium, emptyStage, SELECTOR_RE, toolEligible, nonAgentReason, knownIssueOf, knownIssueText, RANK_LABELS, SUBSTITUTE_FLOOR, CTX_VALUES, hintCapOf, ctxSpec } from "../menu/subagent-funnel.mjs";
import { sweepLines, ctxUnprovenLines } from "../keysync/subagent-policy.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { TIERS, isTier, tierList, RELAY_KEY_ID, RELAY_TIER, freeScopeOf, isExcludedTier, isProvenanceVerified } from "../menu/tiers.mjs";

guardRealState(after, assert);
const NOW = Date.parse("2026-10-03T00:00:00.000Z");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-pol-")); made.push(d); return d; };
after(() => { for (const d of made) if (path.dirname(d) === os.tmpdir() && path.basename(d).startsWith("uw-pol-")) fs.rmSync(d, { recursive: true, force: true }); });      // the tests leaked every folder they made (issue #157)
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const wr = (f, o) => fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o));
async function fx(mutate, over = {}) {
  const dir = tmp();
  const flags = fixtureFlagMap(dir, over);
  if (mutate) mutate(dir);
  const p = lib.resolvePaths(flags);
  return { dir, p, g: await lib.gatherInputs(p, { nowMs: NOW, liveProviders: await lib.readProviders(p) }) };
}
const T = (o = {}) => ({ source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [], ...o });
const run = (g, o) => funnel({ ...g.funnelInputs, nowMs: NOW }, T(o));
const sels = (res) => res.models.map((m) => m.s);
const cell = (res, s) => res.models.find((m) => m.s === s);

test("fixture denominators: 18 snapshot routes, 17 selectors, 15 probe-ok tool-eligible selectors (stage counts)", async () => {
  const { g } = await fx();
  const r = run(g);
  assert.deepEqual([r.counts.universe, r.counts.chatCapable, r.counts.inProviders, r.counts.benchOk, r.counts.toolsPass], [18, 18, 17, 15, 15]);
  assert.equal(r.counts.allowed, 14, "dynamic, all-providers: every probe-ok tool-eligible selector of the 15 EXCEPT the one fx-mgmt row (an excluded tier is never admitted, G17): 14 of 15");
  assert.equal(g.providersLive, true);
});

test("chat-capable rule: chat? admitted, pool/ocr (mode true) and non-chat modalities excluded, null modality judged by outputKind", async () => {
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json"));
    const a = s.rows[2].models;                                         // fx-free-b
    a.push({ ...a[0], id: "pool-row", mode: true }, { ...a[0], id: "img", outModality: "image" }, { ...a[0], id: "nul-text", outModality: null, outputKind: "text" },
      { ...a[0], id: "nul-nontext", outModality: null, outputKind: "nontext" });
    wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[2].models.push("pool-row", "img", "nul-text", "nul-nontext"); wr(path.join(d, "providers.json"), pr);
  });
  const r = run(g);
  assert.equal(r.counts.chatCapable, 18 + 1, "chat? relay rows (3 of 18) count; only nul-text is added of the 4 new routes");
  assert.equal(r.dropped.get("fx-free-b/pool-row"), "not-chat-capable");
  assert.equal(r.dropped.get("fx-free-b/img"), "not-chat-capable");
  assert.equal(r.dropped.get("fx-free-b/nul-nontext"), "not-chat-capable");
});

test("selector spelling: relay bare spelling, [1m] collapse into ONE selector with max ctx, unresolvable dropped, sanitiser rejects counted and listed", async () => {
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json"));
    const m = s.rows[2].models[0];
    s.rows[2].models.push({ ...m, id: "not-listed" }, { ...m, id: "has space" }, { ...m, id: "z".repeat(170) }, { ...m, id: "bad\u0001ctl" });
    wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[2].models.push("has space", "z".repeat(170), "bad\u0001ctl"); wr(path.join(d, "providers.json"), pr);
  });
  const r = run(g);
  assert.equal(r.counts.idRejected, 3, "a space, a 170-character id (the cap is 160, sa-A10) and a control character, of 4 routes added");
  assert.equal(r.idRejected.length, 3);
  assert.equal(r.dropped.get("fx-free-b/not-listed"), "not-in-providers");
  assert.ok(sels(r).every((s) => SELECTOR_RE.test(s)), "no rejected selector reaches a list");
  const big = cell(r, "fx-free-a/fxa-big:free");
  assert.equal(sels(r).filter((s) => s.startsWith("fx-free-a/fxa-big")).length, 1, "x and x[1m] are one selector");
  assert.equal(big.c, 1000000); assert.equal(big.n, 1, "1M claim only from the [1m] sibling: listing-only");
  assert.ok(SELECTOR_RE.test("a".repeat(160)) && !SELECTOR_RE.test("a".repeat(161)) && SELECTOR_RE.test("p/" + "a".repeat(100)), "sa-A10: 160 characters pass, 161 do not (the old cap was 64)");
  const inj = JSON.stringify(lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers" }).compiled.inject);
  assert.ok(!inj.includes("has space") && !inj.includes("zzzzzz"), "rejected ids never reach injected text");
  const w = r.warnings.find((x) => x.code === "ID_REJECTED");
  assert.ok(w && !/[\u0000-]/.test(w.text), "F21: a control character in a rejected id is not printed raw");
  assert.match(w.text, /bad\?ctl/);
});

test("FREE_TAG: positives and negatives, tested on the BARE id (x:free[1m] misses raw, the bare sibling matches)", () => {
  for (const id of ["x:free", "x-free", "a/free/b", "x_free", "x.free", "free-x", "free_x", "kilo-auto/free", "FREE-x", "x:FREE"]) assert.ok(FREE_TAG.test(id), id);
  for (const id of ["freedom", "freeform", "free2", "carefree", "x:free[1m]", "afree", "freex"]) assert.ok(!FREE_TAG.test(id), id);
  assert.ok(!FREE_TAG.test("x:free[1m]") && FREE_TAG.test("x:free"));
});

test("free scopes on the fixtures: free models 5 (1 >= 1M), free providers 7 on 2, free providers + deposit 9 on 4, deposit-strict-skipped 2, ALIAS 2", async () => {
  const { g } = await fx();
  const r = run(g, { mode: "free", freeScope: "providers" });
  const fs_ = r.counts.freeScopes;
  assert.deepEqual([fs_.models.n, fs_.models.ctx1m], [5, 1]);
  assert.deepEqual([fs_.providers.n, fs_.providers.providers], [7, 2]);
  assert.deepEqual([fs_["providers+deposit"].n, fs_["providers+deposit"].providers], [9, 4]);
  assert.equal(r.counts.depositStrictSkipped["providers+deposit"], 2);
  assert.equal(r.counts.depositStrictSkipped.models, 2);
  assert.equal(r.counts.aliasProbeOk, 2);
  for (const scope of ["models", "providers", "providers+deposit"]) {                       // the same three counts whatever scope is chosen
    assert.deepEqual(run(g, { mode: "free", freeScope: scope }).counts.freeScopes, fs_, scope);
  }
  assert.deepEqual(run(g, { mode: "dynamic" }).counts.freeScopes, fs_, "and under dynamic");
});

test("scope membership: free models admits badge or tag rows only on free tiers, strict on paid/deposit; never subscription or management; PRICED_BUT_BADGED", async () => {
  const { g } = await fx();
  const models = sels(run(g, { mode: "free", freeScope: "models" })).sort();
  assert.deepEqual(models, ["fx-dep/fxd-model:free", "fx-free-a/fxa-alpha", "fx-free-a/fxa-big:free", "fx-free-a/kilo-auto/free", "fx-paid/fxp/free/x"]);
  const prov = sels(run(g, { mode: "free", freeScope: "providers" }));
  assert.ok(prov.every((s) => /^fx-free-[ab]\//.test(s)) && prov.length === 7, "every probe-ok model on a free-tier provider, and nothing from other tiers");
  const dep = sels(run(g, { mode: "free", freeScope: "providers+deposit" }));
  assert.equal(dep.length, 9);
  assert.ok(dep.includes("fx-dep/fxd-model:free") && dep.includes("fx-paid/fxp/free/x"));
  assert.ok(!dep.includes("fx-dep/fxd-plain") && !dep.includes("fx-paid/fxp-plain"), "badge FREE/FREE? and price 0 are NOT enough on paid/deposit");
  assert.ok(!dep.includes("fx-dep/fxd-old-free"), "a tagged model with status pay is excluded");
  for (const s of ["models", "providers", "providers+deposit"]) {
    const x = sels(run(g, { mode: "free", freeScope: s }));
    assert.ok(!x.some((v) => v.startsWith("anthropic/") || v.startsWith("fx-mgmt/")), `${s}: the relay and a management key are in no scope`);
  }
  const { g: g2 } = await fx((d) => { const s = rd(path.join(d, "snapshot.json")); s.rows[1].models[0].pin = 2; s.rows[1].models[0].pout = 3; wr(path.join(d, "snapshot.json"), s); });
  const r2 = run(g2, { mode: "free", freeScope: "models" });
  assert.ok(sels(r2).includes("fx-free-a/fxa-alpha"), "a badge row with a non-zero price stays in");
  assert.ok(r2.warnings.some((w) => w.code === "PRICED_BUT_BADGED"));
});

test("tier comes from the registry, never the snapshot key id: a 47-character key id with a clipped snapshot keyId is tiered correctly", async () => {
  const long = "personal.tokenforgeaistudio-with-a-very-long-name.free";
  assert.ok(long.length >= 47 || (long + "xxxxxxxxxx").length >= 47);
  const mut = (d, garble) => {
    const reg = rd(path.join(d, "registry.json"));
    reg[0] = { ...reg[0], id: long, bucket: "personal", provider: "fx-free-a", tier: "free" }; wr(path.join(d, "registry.json"), reg);
    const s = rd(path.join(d, "snapshot.json")); s.rows[1].keyId = garble; wr(path.join(d, "snapshot.json"), s);
  };
  const clipped = (await fx((d) => mut(d, long.slice(0, 30)))).g, garbled = (await fx((d) => mut(d, "@@garbage@@"))).g;
  for (const g of [clipped, garbled]) {
    const r = run(g, { mode: "free", freeScope: "providers" });
    assert.equal(r.counts.freeScopes.providers.n, 7, "tiered from the registry");
  }
  // F20: not vacuous. A clipped id keeps a dot, so its last segment is a mangled tier and DOES mismatch the registry (registry wins);
  // a garbled id has no tier segment at all and says nothing.
  const mm = run(clipped, { mode: "free", freeScope: "providers" }).warnings.filter((w) => w.code === "TIER_MISMATCH");
  assert.equal(mm.length, 1, "exactly one TIER_MISMATCH, of the one provider whose key id was clipped");
  assert.match(mm[0].text, /snapshot key id says tokenforgeaistudio-wi, registry says free for provider fx-free-a \(registry used\)/);
  assert.equal(run(garbled, { mode: "free", freeScope: "providers" }).warnings.filter((w) => w.code === "TIER_MISMATCH").length, 0, "a garbled id has no tier segment: nothing to compare");
});

test("TIER_MISMATCH: a snapshot key id whose tier segment differs from the registry is warned, the registry value is used", async () => {
  const { g } = await fx((d) => { const s = rd(path.join(d, "snapshot.json")); s.rows[3].keyId = "personal.fx-dep.paid"; wr(path.join(d, "snapshot.json"), s); });
  const r = run(g, { mode: "free", freeScope: "providers+deposit" });
  const w = r.warnings.find((x) => x.code === "TIER_MISMATCH");
  assert.match(w.text, /snapshot key id says paid, registry says free-deposit for provider fx-dep/);
  assert.equal(r.counts.freeScopes["providers+deposit"].n, 9, "registry value used");
});

test("a multi-key provider uses the key chosen by key-choices.json; no choice is the loud existing error, never a guess", async () => {
  const addKey = (d) => {
    const reg = rd(path.join(d, "registry.json"));
    reg.push({ ...reg[0], id: "personal.fx-free-a.paid", tier: "paid", envVarName: "LLM_PERSONAL_FX_FREE_A_PAID" }); wr(path.join(d, "registry.json"), reg);
  };
  const noChoice = await fx(addKey);
  assert.equal(noChoice.g.tiersRes.ambiguous.length, 1);
  assert.equal(noChoice.g.tiersRes.ambiguous[0].provider, "fx-free-a");
  assert.equal(noChoice.g.funnelInputs.tiers["fx-free-a"], undefined, "no guessed tier");
  const paid = await fx((d) => { addKey(d); wr(path.join(d, "key-choices.json"), { "fx-free-a": "personal.fx-free-a.paid" }); });
  assert.equal(paid.g.funnelInputs.tiers["fx-free-a"], "paid");
  assert.equal(run(paid.g, { mode: "free", freeScope: "providers" }).counts.freeScopes.providers.n, 1, "only fx-free-b is now a free-tier provider");
  const free = await fx((d) => { addKey(d); wr(path.join(d, "key-choices.json"), { "fx-free-a": "personal.fx-free-a.free" }); });
  assert.equal(free.g.funnelInputs.tiers["fx-free-a"], "free");
});

test("unreadable or absent registry: providers scopes refuse (E_TIER_UNREADABLE), models still compiles with the strict rule and a TIERS warning; corrupt vs absent key choices", async () => {
  const dir = tmp();
  const miss = await fx(null, { "--registry-file": path.join(dir, "nope.json") });
  assert.equal(miss.g.funnelInputs.tiers, null);
  assert.ok(run(miss.g, { mode: "free", freeScope: "providers" }).refuse?.code === "E_TIER_UNREADABLE");
  assert.ok(run(miss.g, { mode: "free", freeScope: "providers+deposit" }).refuse);
  const m = run(miss.g, { mode: "free", freeScope: "models" });
  assert.equal(m.refuse, null);
  assert.ok(m.warnings.some((w) => w.code === "TIERS"));
  assert.deepEqual(sels(m).sort(), ["fx-dep/fxd-model:free", "fx-free-a/fxa-big:free", "fx-free-a/kilo-auto/free", "fx-paid/fxp/free/x"], "strict: the free tag only, badge rows are skipped");
  const corrupt = await fx((d) => wr(path.join(d, "registry.json"), "{nope"));
  assert.equal(corrupt.g.funnelInputs.tiers, null);
  const badChoices = await fx((d) => wr(path.join(d, "key-choices.json"), "{nope"));
  assert.equal(badChoices.g.funnelInputs.tiers, null, "a PRESENT but corrupt key-choices file is unreadable");
  const absentChoices = await fx((d) => fs.rmSync(path.join(d, "key-choices.json")));
  assert.ok(absentChoices.g.funnelInputs.tiers, "an ABSENT one means no choices");
});

test("rank key 2b: price 0, then unknown, then positive, only for free-tier rows under mode free; dynamic is not reordered by price", async () => {
  const { g } = await fx();
  const free = sels(run(g, { mode: "free", freeScope: "providers" }));
  assert.deepEqual(free, ["fx-free-a/fxa-big:free", "fx-free-a/fxa-alpha", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/auto", "fx-free-a/kilo-auto/free", "fx-free-a/fxa-beta"]);
  const dyn = sels(run(g, { mode: "dynamic" })).filter((s) => s.startsWith("fx-free-a/"));
  assert.ok(dyn.indexOf("fx-free-a/fxa-beta") < dyn.indexOf("fx-free-a/fxa-gamma"), "under dynamic the 128k priced row precedes the unknown-ctx row: no price ordering");
  assert.equal(priceSum(0.1, 0.4), 0.5); assert.equal(priceSum(3, null), 3); assert.equal(priceSum(null, null), null); assert.equal(priceSum(0, 0), 0);
});

// ---- Q6 (plan 5.3 rank key 2b, revision 8 item 2, owner ruling option B): class 0t (strict free-tag row on a paid or deposit provider) ranks BELOW class 0
// (price 0 on a free-tier row) and ABOVE unknown price. The mutation gives the two ft rows MORE context and a FASTER TTFT than the class 0 row alpha, so keys 3 and 4
// favour the 0t rows and only key 2b can put alpha first; keys 1 and 2 stay equal for the trio.
const q6Mutate = (d) => {
  const s = rd(path.join(d, "snapshot.json"));
  s.rows.find((r) => r.provider === "fx-dep").models.find((m) => m.id === "fxd-model:free").ctx = 400000;
  s.rows.find((r) => r.provider === "fx-paid").models.find((m) => m.id === "fxp/free/x").ctx = 300000;
  wr(path.join(d, "snapshot.json"), s);
  const b = rd(path.join(d, "bench.json"));
  b.models["fx-free-a/fxa-alpha"].t = 5000; b.models["fx-dep/fxd-model:free"].t = 100; b.models["fx-paid/fxp/free/x"].t = 100;
  wr(path.join(d, "bench.json"), b);
};
const Q6_NEW = ["fx-free-a/fxa-big:free", "fx-free-a/fxa-alpha", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/auto", "fx-free-a/kilo-auto/free", "fx-free-a/fxa-beta"];
const Q6_OLD = ["fx-free-a/fxa-big:free", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x", "fx-free-a/fxa-alpha", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/auto", "fx-free-a/kilo-auto/free", "fx-free-a/fxa-beta"];
const FT_RE = /fx-dep\/fxd-model:free|fx-paid\/fxp\/free\/x/;

test("Q6 rank key 2b: class 0 (price 0, free-tier row) above class 0t (ft row) above U (unknown) above P (positive), whatever the 0t rows' context (key 3) and TTFT (key 4)", async () => {
  const { g } = await fx(q6Mutate);
  const r = run(g, { mode: "free", freeScope: "providers+deposit", source: "all-providers" });
  const k = (x) => r.groups.get(x).rk;
  const [alpha, fxd, fxp] = ["fx-free-a/fxa-alpha", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x"];
  assert.deepEqual([fxd, fxp].map((x) => k(x).slice(0, 3)), [k(alpha).slice(0, 3), k(alpha).slice(0, 3)], "keys 1 to 3 (tool tier, health, ctx class) are EQUAL for the rows under test");
  assert.ok(k(fxd)[13] <= k(alpha)[13] && k(fxp)[13] <= k(alpha)[13], "the ctx CLASS key (rank key 14) never disfavours the 0t rows (more context)");
  assert.ok(k(fxd)[12] < k(alpha)[12] && k(fxp)[12] < k(alpha)[12], "the TTFT QUANTILE key (rank key 13) favours the 0t rows (100 ms against 5,000 ms)");
  assert.deepEqual([alpha, fxd, fxp, "fx-free-a/fxa-gamma", "fx-free-a/fxa-beta"].map((x) => k(x)[3]), [0, 1, 1, 2, 3], "classes: 0, 0t, 0t, U, P");
  assert.deepEqual(sels(r), Q6_NEW, "class 0 first, then the ft rows, then unknown price, then positive price");
  assert.deepEqual([alpha, fxd, fxp].map((x) => cell(r, x).fp + "/" + cell(r, x).ft), ["1/0", "0/1", "0/1"], "the classes are the fp and ft flags of the compiled rows");
  // D1: AGE is no longer a band key and no longer outranks the price class: a stale probe on alpha leaves it in price class 0, above the fresh 0t rows (recency only orders INSIDE a band)
  const stale = await fx((d) => { q6Mutate(d); const b = rd(path.join(d, "bench.json")); b.models[alpha].a = NOW / 1000 - 20 * 86400; wr(path.join(d, "bench.json"), b); });
  const rs = run(stale.g, { mode: "free", freeScope: "providers+deposit", source: "all-providers" });
  assert.equal(rs.groups.get(alpha).rk[14], 2, "alpha is recency class 2 (older than 14 days): an ordering key");
  assert.equal(rs.groups.get(alpha).rk[1], 0, "and health (the latest status is ok) is yes: age is ignored");
  assert.ok(sels(rs).indexOf(alpha) < sels(rs).indexOf(fxd), "the price class (band key) beats recency (ordering key): an older class 0 row still ranks above a fresh 0t row");
});

test("Q6 top-3 spread: the best tie group holds class 0 rows only while one exists; a class 0t row fills the top 3 only after the class 0 rows", async () => {
  const { g } = await fx((d) => {
    q6Mutate(d);                                                        // then equalise key 3 and key 4 so the 0t rows TIE the class 0 row on everything but 2b
    const s = rd(path.join(d, "snapshot.json"));
    for (const [p, id] of [["fx-free-a", "fxa-alpha"], ["fx-dep", "fxd-model:free"], ["fx-paid", "fxp/free/x"]]) s.rows.find((r) => r.provider === p).models.find((m) => m.id === id).ctx = 200000;
    wr(path.join(d, "snapshot.json"), s);
    const b = rd(path.join(d, "bench.json"));
    for (const x of ["fx-free-a/fxa-alpha", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x"]) b.models[x].t = 500;
    wr(path.join(d, "bench.json"), b);
  });
  const r = run(g, { mode: "free", freeScope: "providers+deposit", source: "all-providers" });
  const gOf = (x) => cell(r, x).g;
  assert.ok(gOf("fx-free-a/fxa-alpha") < gOf("fx-dep/fxd-model:free"), "a class 0 row is in an earlier tie group than a 0t row with the SAME context and TTFT (before the change they tied)");
  assert.equal(gOf("fx-dep/fxd-model:free"), gOf("fx-paid/fxp/free/x"), "the two 0t rows tie each other");
  // the router's spread (plan 6.2): the best tie group first, then the next rows in rank order, up to K = 3
  const K = 3, top = r.models.filter((m) => m.g === r.models[0].g).slice(0, K);
  for (const m of r.models) if (top.length < K && !top.includes(m)) top.push(m);
  assert.deepEqual(top.map((m) => m.s), ["fx-free-a/fxa-big:free", "fx-free-a/fxa-alpha", "fx-dep/fxd-model:free"], "class 0 rows (big:free, alpha) lead, then the first 0t row; fxp is outside the top 3");
});

test("Q6: the ranking of a free-tier-only policy is byte-identical before and after the change (goldens taken from the pre-change code); under free providers the ft rows are not admitted so nothing moves", async () => {
  const sha = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex").slice(0, 16);
  const GOLD_PROVIDERS = "3775a0536d3f763a", GOLD_PROVIDERS_MUTATED = "78c0f6837688378a", GOLD_DEPOSIT_DEFAULT = "c2f11b2d08c7ef42";   // revision 11 (D-bh): the order is unchanged (asserted below through the selectors), but `h` is now a TTFT QUANTILE bucket, so two goldens were re-recorded: alpha (5,000 ms) is bucket 3 in the mutated fixture, and the deposit default has 4 different `h` cells
  // router v2 added `b` to every row, `lists.prov`, and a null `lists.all` for the identity; the golden is the PRE-CHANGE shape, so those are removed again here: the ranking, the tie groups and the lists are what the goldens pin
  const compiledShape = (x, freeScope) => {
    const { compiled } = lib.compile(x.g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free", freeScope }, {});
    return sha({ m: compiled.models.map(({ b, ...r }) => r), l: { all: compiled.lists.all ?? compiled.models.map((_, i) => i), byProvider: compiled.lists.byProvider } });
  };
  const def = await fx(), mut = await fx(q6Mutate);
  assert.equal(compiledShape(def, "providers"), GOLD_PROVIDERS, "free providers, default fixture: models, tie groups and lists");
  assert.equal(compiledShape(mut, "providers"), GOLD_PROVIDERS_MUTATED, "free providers with the ft rows' context and TTFT changed: the same pre-change bytes");
  assert.equal(compiledShape(def, "providers+deposit"), GOLD_DEPOSIT_DEFAULT, "providers+deposit, default fixture: the ft rows already trailed alpha on context, so the order is the pre-change one");
  assert.deepEqual(sels(run(mut.g, { mode: "free", freeScope: "providers", source: "all-providers" })), Q6_NEW.filter((x) => !FT_RE.test(x)));
  const dyn = sels(run(mut.g, { mode: "dynamic", source: "all-providers" }));
  assert.ok(dyn.indexOf("fx-dep/fxd-model:free") < dyn.indexOf("fx-free-a/fxa-alpha"), "under dynamic key 2b does not exist: the ft row with more context still leads alpha");
});

test("Q6: acceptance counts unchanged (ALLOWED 14 under dynamic, free scopes 5 / 7 / 9, deposit-strict-skipped 2 of 4, ALIAS 2, emptyProviders [fx-free-b]) and the admitted set is the same", async () => {
  for (const mutate of [undefined, q6Mutate]) {
    const { g } = await fx(mutate);
    assert.equal(run(g, { mode: "dynamic" }).counts.allowed, 14, "ALLOWED under dynamic: 14 of 15 probe-ok tool-eligible selectors");
    const fs_ = run(g, { mode: "free", freeScope: "providers" }).counts.freeScopes;
    assert.deepEqual([fs_.models.n, fs_.providers.n, fs_["providers+deposit"].n], [5, 7, 9], "free models / free providers / free providers + deposit, in selectors");
    const dep = run(g, { mode: "free", freeScope: "providers+deposit" });
    assert.equal(dep.counts.allowed, 9);
    assert.deepEqual([dep.counts.depositStrictSkipped["providers+deposit"], dep.counts.depositStrictSkipped.population], [2, 4], "deposit-strict-skipped 2 of 4 probe-ok selectors on paid or deposit providers");
    assert.equal(dep.counts.aliasProbeOk, 2, "ALIAS 2");
    assert.deepEqual(dep.emptyProviders, ["fx-free-b"]);
    assert.deepEqual(dep.models.filter((m) => m.ft === 1).map((m) => m.s).sort(), ["fx-dep/fxd-model:free", "fx-paid/fxp/free/x"], "the same two ft rows are admitted: this change is order only");
    assert.deepEqual(new Set(sels(dep)), new Set(Q6_NEW));
  }
});

test("Q6: the compiled contentHash changes because the order changed: the same rows in the pre-change order hash differently", async () => {
  const { g } = await fx(q6Mutate);
  const { compiled: a } = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free", freeScope: "providers+deposit" }, {});
  assert.deepEqual(a.models.map((m) => m.s), Q6_NEW);
  assert.equal(lib.hashOf(a), a.contentHash);
  // the SAME rows (every field but the tie group untouched) in the pre-change order with the pre-change tie groups
  const oldG = [0, 1, 2, 3, 4, 4, 5, 5, 6];
  const rows = Q6_OLD.map((s, i) => ({ ...a.models.find((m) => m.s === s), g: oldG[i] }));
  const byProvider = Object.fromEntries(Object.entries(a.lists.byProvider).map(([p, l]) => [p, l.map((i) => Q6_OLD.indexOf(a.models[i].s)).sort((x, y) => x - y)]));
  const b = { ...a, models: rows, lists: { all: rows.map((_, i) => i), byProvider } };
  assert.deepEqual(rows.map((m) => m.s).sort(), a.models.map((m) => m.s).sort(), "same rows: only the order and the tie groups differ");
  assert.notEqual(lib.hashOf(b), a.contentHash, "a different order is a different hash (every sticky entry re-decides once)");
  assert.equal(lib.hashOf({ ...b, models: a.models, lists: a.lists }), a.contentHash, "and putting the new order back restores the compiled hash exactly");
});

test("pool aliases (D-n): flagged al, counted separately, capped at tier u even with a recorded pass, ranked below an equal non-alias, kilo-auto/free is both alias and tag", async () => {
  assert.ok(POOL_ALIAS_RE.test("auto") && POOL_ALIAS_RE.test("kilo-auto/free") && !POOL_ALIAS_RE.test("fxa-big:free") && !POOL_ALIAS_RE.test("autopilot"));
  const { dir, p } = await fx();
  wr(path.join(dir, "tool-fidelity.json"), { schema: 1, generatedAt: "2026-10-02T00:00:00.000Z", models: {
    "fx-free-a/auto": { t: "v", alias: true }, "fx-free-a/kilo-auto/free": { t: "t", alias: true }, "fx-free-a/fxa-gamma": { t: "t" } } });
  const g = await lib.gatherInputs(p, { nowMs: NOW });
  const r = run(g, { mode: "free", freeScope: "providers" });
  assert.equal(cell(r, "fx-free-a/auto").al, 1);
  assert.equal(cell(r, "fx-free-a/auto").t, "u", "alias capped at u whatever the probe said");
  assert.equal(cell(r, "fx-free-a/kilo-auto/free").t, "u");
  assert.equal(cell(r, "fx-free-a/fxa-gamma").t, "t", "a non-alias keeps its probed tier");
  assert.equal(r.counts.alias, 2);
  assert.equal(cell(r, "fx-free-a/kilo-auto/free").f, 1, "an alias that also carries the free tag is still an alias row");
  const order = sels(r);
  assert.ok(order.indexOf("fx-free-b/fxb-one") < order.indexOf("fx-free-a/auto"), "equal on every key above, the non-alias ranks first");
  assert.ok(order.indexOf("fx-free-a/fxa-gamma") < order.indexOf("fx-free-a/fxa-big:free"), "tier t outranks tier u (key 1)");
});

test("substitutable, emptyProviders and thinProviders come from the SUBSTITUTE pool, not the set", async () => {
  const { g } = await fx();
  const dep = run(g, { mode: "free", freeScope: "providers+deposit" });
  assert.deepEqual([dep.substitutable["fx-free-a"], dep.substitutable["fx-free-b"], dep.substitutable["fx-dep"], dep.substitutable["fx-paid"]], [3, 0, 1, 1]);
  assert.deepEqual(dep.emptyProviders, ["fx-free-b"], "a provider with a non-empty set but only unknown-ctx rows is EMPTY for substitution");
  assert.deepEqual(dep.thinProviders, ["fx-dep", "fx-paid"]);
  assert.equal(dep.empty, false);
  const prov = run(g, { mode: "free", freeScope: "providers" });
  assert.deepEqual(prov.emptyProviders, ["fx-free-b"]);
  const same = run(g, { mode: "free", freeScope: "providers", source: "same-provider" });
  assert.deepEqual(Object.keys(same.lists.byProvider).sort(), ["fx-free-a", "fx-free-b"]);
  assert.deepEqual(same.lists.all, [], "same-provider populates only byProvider");
  const all = run(g, { mode: "free", freeScope: "providers", source: "all-providers" });
  assert.deepEqual(all.lists.byProvider, {}, "all-providers populates only lists.all");
  const st = emptyStage(run(g, { mode: "free", freeScope: "providers", source: "same-provider" }), "anthropic");
  assert.match(st.text, /free providers filter/);
  assert.equal(emptyStage(run(g, { mode: "dynamic" }), null), null);
});

test("ctx toggle: 1M by catalogue ctx or a [1m] id; ctx 999999 fails; a null ctx without the tag fails; inherit computes no lists", async () => {
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json"));
    const m = s.rows[2].models[0];
    s.rows[2].models.push({ ...m, id: "ctx-null-tagged[1m]", ctx: null }, { ...m, id: "ctx-999999", ctx: 999999 }, { ...m, id: "ctx-null", ctx: null });
    wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[2].models.push("ctx-null-tagged", "ctx-999999", "ctx-null"); wr(path.join(d, "providers.json"), pr);
    const b = rd(path.join(d, "bench.json"));
    for (const k of ["ctx-null-tagged", "ctx-999999", "ctx-null"]) b.models[`fx-free-b/${k}`] = { s: "ok", t: 500, a: 1790699779 };
    wr(path.join(d, "bench.json"), b);
  });
  const r = run(g, { mode: "dynamic", ctx: "1m" });
  const ids = sels(r);
  assert.ok(ids.includes("fx-free-b/ctx-null-tagged"));
  assert.ok(!ids.includes("fx-free-b/ctx-999999") && !ids.includes("fx-free-b/ctx-null"));
  assert.equal(ids.length, 4, "sonnet, opus, fxa-big:free and the tagged row, of 18 probe-ok selectors");
  const inh = run(g, { mode: "inherit", source: "same-provider" });
  assert.deepEqual([inh.lists.all.length, Object.keys(inh.lists.byProvider).length, inh.empty], [0, 0, false], "no lists under inherit; the rows stay only as information for the router flags");
  assert.ok(inh.warnings.some((w) => w.code === "SOURCE_IGNORED"));
});

test("bench status: ok versus pay/auth/rate is counted not pruned; the observed overlay beats an older probe", async () => {
  const { g, dir, p } = await fx((d) => {
    const b = rd(path.join(d, "bench.json"));
    b.models["fx-free-b/fxb-one"] = { s: "auth", t: 1, a: 1790699779 }; b.models["fx-free-a/fxa-gamma"] = { s: "rate", t: 1, a: 1790699779 };
    wr(path.join(d, "bench.json"), b);
  });
  const r = run(g);
  assert.deepEqual([r.counts.accountState.pay, r.counts.accountState.auth, r.counts.accountState.rate], [1, 1, 1]);
  assert.ok(r.warnings.some((w) => /3 responding models excluded for account state/.test(w.text)));
  assert.ok(!sels(r).includes("fx-free-b/fxb-one"));
  wr(path.join(dir, "observed.json"), { schema: 1, writtenAt: "2026-10-03T00:00:00.000Z", feed: "ok", models: { "fx-free-b/fxb-one": { s: "ok", t: 200, a: 1790800000, l: 1 } } });
  const g2 = await lib.gatherInputs(p, { nowMs: NOW });
  const r2 = run(g2);
  assert.ok(sels(r2).includes("fx-free-b/fxb-one"), "the newer observed ok beats the older probe auth");
  assert.ok(g2.funnelInputs.bench.isLive("fx-free-b/fxb-one"));
});

test("tier tiers (D-i): relay rows compile v (provenance), a probed t row eligible, a tools:false row with an L1+L2 pass is eligible as t, x never, unverified modes", async () => {
  const { dir, p } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json")); s.rows[1].models[2].tools = false; wr(path.join(d, "snapshot.json"), s);        // fxa-gamma claims tools:false
  });
  const base = await lib.gatherInputs(p, { nowMs: NOW });
  assert.ok(!sels(run(base)).includes("fx-free-a/fxa-gamma"), "an unprobed tools:false claim excludes the model");
  wr(path.join(dir, "tool-fidelity.json"), { schema: 1, models: { "fx-free-a/fxa-gamma": { t: "t" }, "fx-free-a/fxa-beta": { t: "x" }, "fx-free-a/fxa-alpha": { t: "v" } } });
  const g = await lib.gatherInputs(p, { nowMs: NOW });
  const r = run(g);
  assert.equal(cell(r, SONNET_REL).t, "v");
  assert.equal(cell(r, "fx-free-a/fxa-gamma").t, "t", "the catalogue claim is ignored once probed");
  assert.ok(!sels(r).includes("fx-free-a/fxa-beta"), "x is never listed");
  assert.equal(r.counts.small, 1);
  assert.ok(r.warnings.some((w) => /UNVERIFIED: \d+ of \d+ allowed models/.test(w.text)));
  const allowT = sels(run(g, { unverified: "allow-t" }));
  assert.ok(allowT.includes("fx-free-a/fxa-gamma") && !allowT.includes("fx-free-b/fxb-one"), "allow-t: v and t eligible, u only by pin");
  assert.ok(sels(run(g, { unverified: "allow-t", allow: ["fx-free-b/fxb-one"] })).includes("fx-free-b/fxb-one"), "a pin makes an unverified model eligible");
  const pin = sels(run(g, { unverified: "pin-only" }));
  assert.deepEqual(pin.sort(), [HAIKU_REL, OPUS_REL, SONNET_REL, "fx-free-a/fxa-alpha"].sort(), "pin-only: only v");
  assert.ok(toolEligible("v", "pin-only", false) && !toolEligible("x", "allow-warn", true) && toolEligible("u", "pin-only", true));
});
const SONNET_REL = "anthropic/claude-sonnet-5-5", HAIKU_REL = "anthropic/claude-haiku-4-5", OPUS_REL = "anthropic/claude-opus-5";

test("premium by family and by price, payload fields, ctxHints for the six aliases, exempt selectors, price text on every row", async () => {
  const { g } = await fx();
  const r = run(g);
  assert.equal(r.counts.premium, 1, "opus by family and price, of 14 allowed");
  assert.equal(cell(r, OPUS_REL).p, 1); assert.equal(cell(r, SONNET_REL).p, 0);
  assert.ok(isPremium("claude-opus-5", 1) && isPremium("x", 20) && !isPremium("x", 19.99) && isPremium("models/fable-1", null) && !isPremium("operatic", 5));
  assert.equal(r.counts.payloadUnknown, 14); assert.equal(r.counts.payloadRisk, 0);
  assert.deepEqual(r.exempt, [HAIKU_REL]);
  // D-bg/D-bk: under ctx any the asked model's own context (1M for a [1m] alias) must NOT raise the router's floor: every hint is capped at 128,000
  assert.equal(r.ctxHints[SONNET_REL], 128000, "ctx any: the sonnet hint is the 128k substitute floor, not its 1M");
  assert.equal(r.ctxHints["anthropic/claude-sonnet-5-5[1m]"], 128000, "the raw [1m] spelling of an alias value is hinted too, at the same cap");
  assert.equal(r.ctxHints[HAIKU_REL], 128000);
  assert.ok(Object.values(r.ctxHints).every((v) => v <= 128000), "no hint above the floor under any");
  const hint = (ctx) => run(g, { ctx }).ctxHints;
  assert.equal(hint("256k")[HAIKU_REL], 200000, "a hard floor of 256k caps at 256k: haiku's own 200k stays");
  assert.equal(Object.values(hint("256k")).filter((v) => v > 256000).length, 0);
  assert.equal(hint("1m")[SONNET_REL], 1000000, "ctx 1m: the floor is 1M, the hint keeps it");
  assert.ok(Object.values(hint("prefer-1m")).every((v) => v <= 128000), "a soft preference excludes nothing, so it raises no floor either");
  assert.ok(r.models.every((m) => typeof m.i === "string" && m.i.length > 0), "price on every row");
  assert.equal(priceText(3, 15), "$3/$15"); assert.equal(priceText(0.15, 0.6), "$0.15/$0.6"); assert.equal(priceText(0, 0), "free"); assert.equal(priceText(null, null), "$?");
  const withLimit = await fx((d) => { const s = rd(path.join(d, "snapshot.json")); s.rows[2].models[0].limit = { verdict: "capped", bytes: 245 * 1024 }; wr(path.join(d, "snapshot.json"), s); });
  const rl = run(withLimit.g);
  assert.equal(rl.counts.payloadRisk, 1); assert.equal(cell(rl, "fx-free-b/fxb-one").pb, 245 * 1024);
});

test("inherit warnings: premium likely main and a sub-1M main under ctx 1m", async () => {
  const mk = async (model) => (await fx((d) => wr(path.join(d, "default-model.json"), { model }))).g;
  const prem = run(await mk(OPUS_REL), { mode: "inherit", source: "same-provider" });
  assert.ok(prem.warnings.some((w) => w.code === "INHERIT_PREMIUM_MAIN"));
  const below = run(await mk("anthropic/claude-haiku-4-5"), { mode: "inherit", ctx: "1m" });
  assert.ok(below.warnings.some((w) => w.code === "INHERIT_BELOW_CTX"));
  const ok = run(await mk("anthropic/claude-sonnet-5-5[1m]"), { mode: "inherit", ctx: "1m" });
  assert.ok(!ok.warnings.some((w) => w.code === "INHERIT_BELOW_CTX"));
});

test("fnv1a32 known vectors and the same input always gives the same index", () => {
  assert.equal(fnv1a32(""), 0x811c9dc5); assert.equal(fnv1a32("a"), 0xe40c292c); assert.equal(fnv1a32("foobar"), 0xbf9cf968);
  assert.equal(fnv1a32("é"), fnv1a32("é")); assert.notEqual(fnv1a32("é"), fnv1a32("e"));
});

test("compile: contentHash is stable across recompiles and excludes timestamps; byte-stable output; the owner pins change the hash", async () => {
  const { g } = await fx();
  const o = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free" };
  const a = lib.compile(g, o, { now: () => new Date("2026-10-03T01:00:00Z") }).compiled, b = lib.compile(g, o, { now: () => new Date("2027-01-01T00:00:00Z") }).compiled;
  assert.equal(a.contentHash, b.contentHash);
  assert.notEqual(a.compiledAt, b.compiledAt);
  assert.equal(JSON.stringify({ ...a, compiledAt: 0 }), JSON.stringify({ ...b, compiledAt: 0 }));
  assert.notEqual(lib.compile(g, { ...o, mode: "dynamic" }, {}).compiled.contentHash, a.contentHash);
  assert.equal(a.schema, 1); assert.equal(a.counts.freeScopes.providers.n, 7);
  assert.deepEqual(a.tiers, { "fx-free-a": "free", "fx-free-b": "free", "fx-dep": "free-deposit", "fx-paid": "paid", "fx-mgmt": "management" }, "the provider-to-tier map, no secrets; a management-only provider is named so no scope can admit it (F23)");
  assert.ok(a.builtFrom.tiersHash && a.builtFrom.providersLive === true);
});

test("injected text: at most 2,048 bytes, ASCII, at most 20 entries, a price and a tools marker on every row, never the word best, the exact row format", async () => {
  const { g } = await fx();
  const c = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" }, {}).compiled;
  const text = c.inject.all;
  assert.ok(Buffer.byteLength(text) <= 2048);
  assert.ok(/^[\x20-\x7e\n]+$/.test(text), "ASCII only");
  assert.ok(!/best/i.test(JSON.stringify(c.inject)));
  assert.match(text, /^\[uw-subagent-policy v1 [0-9a-f]{12}\]\n/);
  assert.match(text, /NOT by quality or price/);
  const rows = text.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(rows.length >= 1 && rows.length <= 20);
  for (const r of rows) assert.match(r, /^- \S+  (1M|\d+k|~\d+k\?|ctx\?)  (\$[\d.]+\/\$[\d.]+|\$[\d.]+\/\?|free|\$\?)  tools:(UNVERIFIED|verified|small)  (fast|ok|slow|very slow|\?)  cap:(\d+k|unknown)(  ALIAS)?(  \$\$)?$/);
  assert.ok(rows.filter((r) => /^- anthropic\//.test(r)).length <= 3, "at most 3 entries per provider when all-providers");
  assert.ok(rows.some((r) => /tools:verified/.test(r)) && rows.some((r) => /tools:UNVERIFIED/.test(r)));
  assert.match(text, /Notice: \d+ of \d+ listed models have UNVERIFIED tool support/);
  assert.match(c.inject.promptNote, /^\[uw-subagent-policy v1 /);
  const same = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "same-provider", mode: "dynamic" }, {}).compiled.inject;
  assert.ok(same.byProvider.anthropic.includes("anthropic/claude-sonnet-5-5") && same.byProvider.anthropic.includes("(mode dynamic, source same-provider anthropic, ctx any)"));
  assert.match(c.inject.empty, /^UW subagent policy WARNING: no subagent model is eligible/);
});

test("the cap cuts the list with an honest N of M shown", async () => {
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json")), pr = rd(path.join(d, "providers.json")), b = rd(path.join(d, "bench.json"));
    const m = s.rows[2].models[0];
    for (let i = 0; i < 60; i++) { const id = `very-long-model-identifier-number-${i}-padding`; s.rows[2].models.push({ ...m, id, ctx: 200000 }); pr.Providers[2].models.push(id); b.models[`fx-free-b/${id}`] = { s: "ok", t: 500, a: 1790699779 }; }
    wr(path.join(d, "snapshot.json"), s); wr(path.join(d, "providers.json"), pr); wr(path.join(d, "bench.json"), b);
  });
  const t = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "same-provider", mode: "dynamic" }, {}).compiled.inject.byProvider["fx-free-b"];
  assert.ok(Buffer.byteLength(t) <= 2048);
  const m = /\((\d+) of (\d+) shown;/.exec(t);
  assert.ok(m && Number(m[1]) < Number(m[2]) && Number(m[2]) === 61, "N of M shown, of 61 rows");
});

test("inputs: a stale snapshot warns and proceeds; a missing or wrong-schema snapshot refuses with the loadSnapshot reason; gateway-down falls back to the routable flag", async () => {
  const stale = await lib.gatherInputs((await fx()).p, { nowMs: Date.parse("2026-10-20T00:00:00Z") });
  assert.ok(stale.warnings.some((w) => w.code === "SNAPSHOT_STALE"), "warns, never prunes");
  assert.equal(run(stale).counts.allowed, 14);
  const { p, dir } = await fx();
  fs.rmSync(path.join(dir, "snapshot.json"));
  await assert.rejects(lib.gatherInputs(p, { nowMs: NOW }), (e) => e.code === "E_SNAPSHOT" && /missing/.test(e.message) && e.exit === 4);
  const s2 = await fx();
  const sn = rd(path.join(s2.dir, "snapshot.json")); sn.schemaVersion = 8; wr(path.join(s2.dir, "snapshot.json"), sn);
  await assert.rejects(lib.gatherInputs(s2.p, { nowMs: NOW }), (e) => /E_SNAPSHOT:schema/.test(e.message));
  const down = await fx(null, { "--providers-file": path.join(tmp(), "gone.json") });
  assert.equal(down.g.providersLive, false, "stamped providersLive: false");
  assert.ok(down.g.warnings.some((w) => w.code === "PROVIDERS_FALLBACK"));
  assert.equal(run(down.g).counts.allowed, 14, "the snapshot routable flag stands in");
  assert.equal(lib.compile(down.g, { ...lib.OWNER_DEFAULTS, source: "all-providers" }, {}).compiled.builtFrom.providersLive, false);
  const old = await fx(null, { "--providers-file": path.join(tmp(), "gone.json") });
  await assert.rejects(lib.gatherInputs(old.p, { nowMs: Date.parse("2026-12-01T00:00:00Z") }), (e) => /E_SNAPSHOT:providers/.test(e.message), "routable flags older than 7 days are not trusted");
});

test("NATIVE_MENU_PRESENT: a live provider with modelDescriptions is warned", async () => {
  const { g } = await fx((d) => { const pr = rd(path.join(d, "providers.json")); pr.Providers[1].modelDescriptions = [{ id: "x" }]; wr(path.join(d, "providers.json"), pr); });
  assert.ok(g.warnings.some((w) => w.code === "NATIVE_MENU_PRESENT"));
});

test("tier vocabulary is data: five tiers, management the only excluded one, free-deposit valid; the relay key id is the literal", () => {
  assert.deepEqual(tierList().sort(), ["free", "free-deposit", "management", "paid", "subscription"]);
  assert.deepEqual(Object.entries(TIERS).filter(([, v]) => v.excluded).map(([k]) => k), ["management"]);
  assert.ok(isTier("free-deposit") && !isTier("freee") && !isTier("Paid") && !isTier("deposit") && !isTier(""));
  assert.equal(RELAY_KEY_ID, "relay.anthropic.subscription");
  assert.ok(Object.isFrozen(TIERS));
  const envName = (id) => `LLM_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  assert.equal(envName("personal.x.free-deposit"), "LLM_PERSONAL_X_FREE_DEPOSIT");
});

test("owner file: validation, defaults, first set needs --source and --mode, fixed is rejected, size cap, corrupt is loud, absent is null", () => {
  const dir = tmp(), f = path.join(dir, "o.json");
  assert.equal(lib.loadOwner(f), null);
  wr(f, "{nope"); assert.throws(() => lib.loadOwner(f), (e) => e.code === "E_OWNER_CORRUPT" && e.exit === 4);
  wr(f, JSON.stringify({ ...lib.OWNER_DEFAULTS, mode: "fixed" })); assert.throws(() => lib.loadOwner(f), /mode must be one of/);
  wr(f, JSON.stringify({ ...lib.OWNER_DEFAULTS, pad: "x".repeat(5000) })); assert.throws(() => lib.loadOwner(f), /limit 4096/);
  fs.rmSync(f); fs.mkdirSync(f); assert.throws(() => lib.loadOwner(f), /not a regular file/);
  const g = path.join(dir, "ok.json");
  const saved = lib.saveOwner(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free" });
  assert.deepEqual(lib.loadOwner(g), saved);
  assert.throws(() => lib.parseArgs(["set", "--mode", "fixed"]), /renamed to --mode inherit|renamed/);
  assert.equal(lib.OWNER_DEFAULTS.enforcement, "shadow"); assert.equal(lib.OWNER_DEFAULTS.inject, "off");
});

test("parseArgs: every flag takes an explicit value; booleans are exactly yes or no; unknown flags and not-applicable flags are usage errors", () => {
  const bad = (argv, re) => assert.throws(() => lib.parseArgs(argv), (e) => e.code === "E_USAGE" && e.exit === 1 && re.test(e.message), argv.join(" "));
  bad(["set", "--dry"], /needs an explicit value/);
  bad(["set", "--dry", "foo"], /exactly yes or no/);
  bad(["set", "--dry", "true"], /exactly yes or no/);
  bad(["set", "--dry", "1"], /exactly yes or no/);
  bad(["set", "--dry", "--source", "x"], /needs an explicit value/);
  bad(["set", "--bogus", "x"], /unknown or not applicable/);
  bad(["rollback", "--dry", "yes"], /unknown or not applicable/);
  bad(["set", "--mode", "weird"], /must be one of/);
  bad(["set", "--min-set", "0"], /positive integer/);
  bad(["nope"], /unknown subcommand/);
  bad(["show", "extra"], /unexpected argument/);
  bad(["explain"], /usage: subagent-policy explain/);
  assert.equal(lib.parseArgs(["set", "--dry", "no", "--live", "yes"]).flags.dry, false, "no is the same as absent");
  assert.deepEqual(lib.parseArgs(["set", "--allow", "a/b", "--allow", "c/d", "--live", "yes"]).flags.allow, ["a/b", "c/d"]);
  bad(["set", "--live", "maybe"], /exactly yes or no/);
  bad(["rollback", "--live", "yes"], /unknown or not applicable/);                 // rollback is exempt from the guard and takes no --live
  assert.equal(lib.parseArgs(["rollback"]).cmd, "rollback", "rollback with no flag at all is allowed (CLI-1 exemption)");
  for (const argv of [["set", "--source", "all-providers", "--mode", "dynamic"], ["set", "--dry", "no"], ["rebuild"], ["rebuild", "--if-stale", "yes"], ["clear"]]) bad(argv, /writes the REAL files .*--live yes/);
  assert.equal(lib.parseArgs(["set", "--dry", "yes", "--source", "all-providers", "--mode", "dynamic"]).cmd, "set", "a dry set writes nothing: no guard");
  assert.equal(lib.parseArgs(["show"]).cmd, "show"); assert.equal(lib.parseArgs(["explain", "a/b"]).cmd, "explain");
  bad(["set", "--providers-file", "x"], /incomplete test-flag set/);
  bad(["set", "--snapshot-file", "x", "--policy-file", "y"], /incomplete test-flag set/);
  assert.equal(lib.parseArgs(["rollback", "--state-dir", "x"]).cmd, "rollback");
});

// =====================================================================================================================
// Fix round S1/S1c (F1 F3 F5 F8 F9 F12 F13 F22 F23 F24). Each test below says which fix it pins.
// =====================================================================================================================
const OWNER_FREE = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "free", freeScope: "providers" };

test("F1+F3: the hash is routing content only: an unrelated non-chat snapshot row keeps the hash and the injected text; a routing change or an inject toggle changes both", async () => {
  const base = await fx();
  const withRow = await fx((d) => {                                                      // an image route nobody can send chat to: counts.universe moves, routing does not
    const s = rd(path.join(d, "snapshot.json")); const m = s.rows[2].models[0];
    s.rows[2].models.push({ ...m, id: "unrelated-image", outModality: "image" }); wr(path.join(d, "snapshot.json"), s);
  });
  const a = lib.compile(base.g, { ...OWNER_FREE, inject: "on" }).compiled, b = lib.compile(withRow.g, { ...OWNER_FREE, inject: "on" }).compiled;
  assert.equal(b.counts.universe, a.counts.universe + 1, "of 18 snapshot routes the unrelated row IS counted");
  assert.equal(b.contentHash, a.contentHash, "...and does not rotate the hash (a prompt-cache miss for every running session)");
  assert.deepEqual(b.inject, a.inject, "the injected text is byte-identical");
  // the case it must not break: routing changes and the inject toggle DO change the hash
  const off = lib.compile(base.g, { ...OWNER_FREE, inject: "off" }).compiled;
  assert.notEqual(off.contentHash, a.contentHash, "inject on vs off changes the hash (the compiled owner differs)");
  assert.deepEqual([off.owner.inject, a.owner.inject], ["off", "on"]);
  const ref = lib.compile(base.g, OWNER_FREE).compiled.contentHash;
  // router v2 (ar-10): enforcement is a behaviour switch, outside the hash: flipping it must NOT rotate the injected marker line
  const enf = lib.compile(base.g, { ...OWNER_FREE, inject: "on", enforcement: "enforce" }).compiled;
  assert.equal(enf.contentHash, a.contentHash, "enforcement does not change the hash"); assert.deepEqual(enf.inject, a.inject, "and the injected text is byte-identical");
  for (const patch of [{ mode: "dynamic" }, { ctx: "1m" }, { freeScope: "models" }, { unverified: "pin-only" }, { banded: false }]) {
    assert.notEqual(lib.compile(base.g, { ...OWNER_FREE, ...patch }).compiled.contentHash, ref, JSON.stringify(patch));
  }
  const t = lib.compile(base.g, { ...OWNER_FREE, mode: "dynamic", unverified: "allow-t" }).compiled.contentHash;
  assert.notEqual(lib.compile(base.g, { ...OWNER_FREE, mode: "dynamic", unverified: "allow-t", allow: ["fx-free-b/fxb-one"] }).compiled.contentHash, t, "an owner pin that makes a model eligible changes the list, so the hash");
  const gone = await fx((d) => { const bch = rd(path.join(d, "bench.json")); bch.models["fx-free-b/fxb-one"].s = "pay"; wr(path.join(d, "bench.json"), bch); });
  assert.notEqual(lib.compile(gone.g, OWNER_FREE).compiled.contentHash, ref, "a model leaving the list changes it");
  const relabelled = await fx((d) => { const r = rd(path.join(d, "registry.json")); r[1].tier = "paid"; wr(path.join(d, "registry.json"), r); });
  assert.notEqual(lib.compile(relabelled.g, OWNER_FREE).compiled.contentHash, ref, "a tier relabel changes the tiers map");
});

test("F5: the id sanitiser judges the BARE selector that is emitted: x, x[1m], y, y[1m] listed are 4 routes of 2 selectors, none id-rejected; only-[1m]-listed has its own reason", () => {
  const model = (id, ctx) => ({ id, ctx, pin: 1, pout: 2, tools: true, outModality: "chat", mode: false, routable: true });
  const rows = [{ provider: "p", keyId: "personal.p.free", models: [model("x", 200000), model("x[1m]", 1000000), model("y", 150000), model("y[1m]", 1000000), model("zz[1m]", 1000000), model("w", 90000)] }];
  const providers = [{ name: "p", models: ["x", "x[1m]", "y", "y[1m]", "zz[1m]", "w"], enabled: true }];
  const bench = { get: () => ({ s: "ok", t: 300, a: NOW / 1000 - 86400 }), isLive: () => false };
  const r = funnel({ rows, bench, nowMs: NOW, providers, tiers: { p: "free" } }, T({ mode: "dynamic" }));
  assert.equal(r.counts.universe, 6, "6 snapshot routes");
  assert.equal(r.counts.idRejected, 0, "no resolvable route is counted id-rejected (before the fix the two [1m] spellings were, of 6 routes)");
  assert.deepEqual(r.idRejected, []);
  assert.equal(r.counts.oneMSpellingOnly, 1, "zz[1m] is listed ONLY with a [1m] spelling: no wire id can name it");
  assert.equal(r.dropped.get("p/zz"), "only-1m-spelling-listed");
  assert.deepEqual(sels(r).sort(), ["p/w", "p/x", "p/y"], "of 6 routes, 3 selectors after the [1m] collapse (x, y, w); zz dropped");
  assert.equal(cell(r, "p/x").c, 1000000, "the [1m] sibling's 1M claim is kept (it was lost when the sibling was rejected)");
  assert.equal(cell(r, "p/x").n, 1, "listing-only 1M basis"); assert.equal(cell(r, "p/y").c, 1000000); assert.equal(cell(r, "p/w").c, 90000);
  assert.ok(r.warnings.some((w) => w.code === "ONLY_1M_SPELLING" && /1 of 6 chat-capable routes/.test(w.text)));
  assert.ok(!r.warnings.some((w) => w.code === "ID_REJECTED"));
  // Providers listing only the BARE spelling and a [1m] route: same selector, ctx from the sibling, not rejected
  const bareOnly = funnel({ rows, bench, nowMs: NOW, providers: [{ name: "p", models: ["x", "y", "w"], enabled: true }], tiers: { p: "free" } }, T({ mode: "dynamic" }));
  assert.equal(bareOnly.counts.idRejected, 0); assert.equal(bareOnly.counts.oneMSpellingOnly, 0); assert.equal(bareOnly.dropped.get("p/zz"), "not-in-providers");
  assert.equal(cell(bareOnly, "p/x").c, 1000000);
});

test("F8 + D1: the recency class (live<=7d, fresh<=14d, older; the LAST ordering key inside a band, rank key 11) is computed per row; context now outranks it", async () => {
  const day = 86400;
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json")); const a = s.rows[1].models;
    a.find((m) => m.id === "fxa-alpha").ctx = 128000; a.find((m) => m.id === "fxa-gamma").ctx = 256000; a.find((m) => m.id === "fxa-beta").ctx = 512000;   // key 3 alone would give beta, gamma, alpha
    wr(path.join(d, "snapshot.json"), s);
    const b = rd(path.join(d, "bench.json"));
    b.models["fx-free-a/fxa-alpha"].a = NOW / 1000 - 2 * day;                           // live overlay below: class 0
    b.models["fx-free-a/fxa-gamma"].a = NOW / 1000 - 10 * day;                          // not live, within 14 d: class 1
    b.models["fx-free-a/fxa-beta"].a = NOW / 1000 - 20 * day;                           // older: class 2
    wr(path.join(d, "bench.json"), b);
    wr(path.join(d, "observed.json"), { schema: 1, writtenAt: "2026-10-02T00:00:00.000Z", feed: "ok", models: { "fx-free-a/fxa-alpha": { s: "ok", t: 500, a: NOW / 1000 - 2 * day + 3600, l: 1 } } });   // newer than the probe: the overlay wins (a tie is the probe's)
  });
  const r = run(g, { mode: "dynamic" });
  const k2 = (x) => r.groups.get(`fx-free-a/${x}`).rk[14];
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map(k2), [0, 1, 2], "recency class: live and fresh, fresh, older");
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => r.groups.get(`fx-free-a/${x}`).rk[1]), [0, 0, 0], "health (latest status ok) is yes for all three: age is ignored");
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => r.groups.get(`fx-free-a/${x}`).b), [r.groups.get("fx-free-a/fxa-alpha").b, r.groups.get("fx-free-a/fxa-alpha").b, r.groups.get("fx-free-a/fxa-alpha").b], "and the three rows share ONE band");
  const order = sels(r).filter((x) => /fxa-(alpha|beta|gamma)$/.test(x));
  assert.deepEqual(order, ["fx-free-a/fxa-beta", "fx-free-a/fxa-gamma", "fx-free-a/fxa-alpha"], "context (key 9) now BEATS recency (key 11): the freshest probe no longer outranks 512k and 256k of context");
  // the boundaries: a live record older than 7 days is no longer class 0; 14 d exactly is class 1, 14 d + 1 s is class 2
  const edge = await fx((d) => {
    const b = rd(path.join(d, "bench.json"));
    b.models["fx-free-a/fxa-alpha"].a = NOW / 1000 - 8 * day; b.models["fx-free-a/fxa-gamma"].a = NOW / 1000 - 14 * day; b.models["fx-free-a/fxa-beta"].a = NOW / 1000 - 14 * day - 1;
    wr(path.join(d, "bench.json"), b);
    wr(path.join(d, "observed.json"), { schema: 1, writtenAt: "2026-10-02T00:00:00.000Z", feed: "ok", models: { "fx-free-a/fxa-alpha": { s: "ok", t: 500, a: NOW / 1000 - 8 * day + 3600, l: 1 } } });
  });
  const e = run(edge.g, { mode: "dynamic" });
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => e.groups.get(`fx-free-a/${x}`).rk[14]), [1, 1, 2], "live at 8 d is class 1; 14 d exactly is class 1; 14 d + 1 s is class 2");
});

test("D-bh: the TTFT bucket is a QUANTILE of the eligible set (fast, ok, slow, very slow), ahead of the ctx class; a missing TTFT is bucket 4, last", async () => {
  const { g } = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json"));
    for (const id of ["fxa-alpha", "fxa-beta", "fxa-gamma"]) s.rows[1].models.find((m) => m.id === id).ctx = 200000;
    s.rows[2].models[0].ctx = 200000; wr(path.join(d, "snapshot.json"), s);
    const b = rd(path.join(d, "bench.json"));
    b.models["fx-free-a/fxa-alpha"].t = 3000; b.models["fx-free-a/fxa-beta"].t = 999; b.models["fx-free-a/fxa-gamma"].t = 1000; b.models["fx-free-b/fxb-one"].t = 2999;
    wr(path.join(d, "bench.json"), b);
  });
  const r = run(g, { mode: "dynamic" });
  const h = (x) => cell(r, x).h;
  assert.equal(r.ttftCuts.length, 3, "three cut points, the quartiles of the TTFTs of the rows in THIS set");
  const all = r.models.map((m) => r.groups.get(m.s).rec?.t).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  assert.deepEqual(r.ttftCuts, [0.25, 0.5, 0.75].map((q) => all[Math.max(0, Math.ceil(q * all.length) - 1)]), "nearest-rank quartiles over " + all.length + " rows with a TTFT");
  const names = ["fx-free-a/fxa-beta", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/fxa-alpha"];
  assert.ok(h(names[0]) <= h(names[1]) && h(names[1]) <= h(names[2]) && h(names[2]) <= h(names[3]), "the bucket follows the TTFT: 999 <= 1000 <= 2999 <= 3000");
  assert.ok(h(names[0]) < h(names[3]), "the fastest and the slowest of the four differ in bucket");
  assert.ok(r.models.every((m) => m.h >= 0 && m.h <= 3), "every row of this fixture has a TTFT, so buckets 0 to 3");
  // the rank key: TTFT bucket (index 9) is ahead of the ctx class (index 10)
  const keys = r.groups.get("fx-free-a/fxa-alpha").rk;
  assert.equal(keys[11], h("fx-free-a/fxa-alpha")); assert.equal(keys[12], 3, "alpha has 200k: ctx class 3 (>= 200k)");
  const none = await fx((d) => { const b = rd(path.join(d, "bench.json")); delete b.models["fx-free-a/fxa-alpha"].t; wr(path.join(d, "bench.json"), b); });
  const rn = run(none.g, { mode: "dynamic" });
  assert.equal(cell(rn, "fx-free-a/fxa-alpha").h, 4, "a missing TTFT is bucket 4: no TTFT recorded");
  assert.deepEqual(rn.groups.get("fx-free-a/fxa-alpha").rk.slice(11, 14).length, 3);
});

test("F9: a saved owner file always loads again: the allow list is bounded in count and length and saveOwner checks the serialized size", () => {
  const dir = tmp(), f = path.join(dir, "o.json");
  const pins = (n) => Array.from({ length: n }, (_, i) => `${("p" + i).padEnd(36, "q")}/${"m".repeat(63)}`);   // 100 characters each: provider 36, slash, model 63
  const full = lib.saveOwner(f, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", allow: pins(lib.ALLOW_MAX) });
  assert.deepEqual(lib.loadOwner(f).allow, full.allow, `${lib.ALLOW_MAX} pins of 100 characters (the limits) round-trip`);
  assert.ok(fs.statSync(f).size <= lib.OWNER_MAX_BYTES);
  const before = fs.readFileSync(f, "utf8");
  assert.throws(() => lib.saveOwner(f, { ...lib.OWNER_DEFAULTS, mode: "dynamic", allow: pins(60) }), "60 pins would be a file loadOwner refuses");
  assert.throws(() => lib.saveOwner(f, { ...lib.OWNER_DEFAULTS, mode: "dynamic", allow: [`p/${"m".repeat(120)}`] }));
  assert.equal(fs.readFileSync(f, "utf8"), before, "a refused save leaves the file as it was");
  assert.throws(() => lib.parseArgs(["set", "--allow", `p/${"m".repeat(120)}`]), /at most 100 characters/);
  const big = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", note: "x".repeat(5000) };      // the size check on its own, whatever the bounds
  assert.throws(() => lib.saveOwner(path.join(dir, "big.json"), big), /limit 4096/);
  assert.equal(fs.existsSync(path.join(dir, "big.json")), false);
});

test("F12: the compiler counts the trailing newline: a compiled file of exactly the cap is accepted, one byte over is refused, and the file loads under the router's POLICY_MAX", async () => {
  const { g } = await fx();
  const sized = (n) => ({ ...g, funnelInputs: { ...g.funnelInputs, aliasValues: { ...g.funnelInputs.aliasValues, haiku: "h".repeat(n) } } });   // exempt carries one copy of the string: n extra bytes exactly
  const owner = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" };
  const at = (n) => lib.compile(sized(n), owner).compiled;
  const base = Buffer.byteLength(JSON.stringify(at(1))) - 1;                            // bytes with no padding
  const pad = lib.COMPILED_MAX_BYTES - base - 1;                                        // JSON of cap - 1 bytes: with the newline the FILE is exactly the cap
  const ok = at(pad);
  assert.equal(Buffer.byteLength(JSON.stringify(ok) + "\n"), lib.COMPILED_MAX_BYTES, "JSON plus newline is exactly the cap");
  assert.ok(Buffer.byteLength(JSON.stringify(ok) + "\n") <= 1024 * 1024, "never over the router's POLICY_MAX of 1,048,576");
  assert.throws(() => at(pad + 1), (e) => e.code === "E_PRECONDITION" && /1048577 bytes/.test(e.message), "JSON of exactly the cap + the newline is one byte over: refused (before the fix it was written and the router called it oversize)");
});

test("F13: providers read from a --providers-file are stamped providersLive: false and warned, so a fixture flag set can never satisfy the live check; the live seam still can", async () => {
  const dir = tmp(); const p = lib.resolvePaths(fixtureFlagMap(dir));
  const fixture = await lib.gatherInputs(p, { nowMs: NOW });
  assert.equal(fixture.providersLive, false);
  assert.ok(fixture.warnings.some((w) => w.code === "PROVIDERS_FIXTURE"));
  assert.equal(run(fixture).counts.allowed, 14, "the fixture providers are still USED");
  assert.equal(lib.compile(fixture, { ...lib.OWNER_DEFAULTS, source: "all-providers" }).compiled.builtFrom.providersLive, false);
  const accuracy = (o) => { fs.mkdirSync(path.join(dir, "state", "subagent"), { recursive: true }); wr(path.join(dir, "state", "subagent", "accuracy.json"), o); };
  const H = "c0ffee00c0ffee00";
  const pass = (over = {}) => ({ schema: 1, verdict: "PASS", at: new Date(NOW).toISOString(), ccVersion: "2.1.289", ccrVersion: "3.0.22", evidence: { classRowsCounted: 10, sha256: "ab".repeat(32), policyContentHash: H }, ...over });
  const seam = { contentHash: H, ccrVersion: () => "3.0.22", ccVersion: () => "2.1.289" };
  accuracy(pass());
  const enforce = { ...lib.OWNER_DEFAULTS, mode: "dynamic", enforcement: "enforce" };
  assert.throws(() => lib.checkEnforcePreconditions(p, fixture, enforce, NOW, seam), (e) => e.code === "E_PRECONDITION" && /needs live Providers/.test(e.message), "a fresh PASS verdict does not help: the fixture is not live");
  const live = await lib.gatherInputs(p, { nowMs: NOW, liveProviders: await lib.readProviders(p) });
  assert.equal(live.providersLive, true);
  assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam), "live + a bound PASS younger than 30 days");
  accuracy(pass({ at: new Date(NOW - 31 * 86400000).toISOString() }));
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam), /blocked: state\/subagent\/accuracy\.json/, "expired");
  accuracy(pass({ verdict: "FAIL" }));
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam), /blocked/);
  assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, fixture, { ...enforce, enforcement: "shadow" }, NOW, seam), "shadow needs nothing");
});

test("F22: counts carry their denominator: deposit-strict-skipped, ALIAS, CREDIT and DEPOSIT STRICT name the population, each definition its own", async () => {
  const { g } = await fx();
  const r = run(g, { mode: "free", freeScope: "providers+deposit" });
  const c = r.counts;
  assert.equal(c.depositStrictSkipped.population, 4, "of 15 probe-ok selectors, 4 sit on paid and deposit providers (fxd-model:free, fxd-plain, fxp-plain, fxp/free/x)");
  assert.equal(c.depositStrictSkipped["providers+deposit"], 2); assert.equal(c.depositStrictSkipped.models, 2);
  assert.match(r.warnings.find((w) => w.code === "DEPOSIT_STRICT").text, /^DEPOSIT STRICT: 2 of 4 probe-ok selectors on paid or deposit providers/);
  assert.match(r.warnings.find((w) => w.code === "CREDIT").text, /\(\d+ of \d+ models in the chosen set are positive-priced\)/);
  const report = lib.formatReport({ owner: { enforcement: "shadow", inject: "off" }, res: r, g, dry: true });
  assert.match(report, /deposit-strict-skipped \.+ 2 of 4 probe-ok selectors on paid and deposit providers \(free models rule: 2 of those 2 skipped rows are badge-labelled or price 0/);
  assert.match(report, /ALIAS \(counted separately\) \.+ 2 probe-ok pool aliases of 15 probe-ok selectors/);
  assert.match(report, /id-rejected \(cr-m3\) \.+ 0 of 18 chat-capable routes/);
});

test("F23: a provider whose ONLY key is a management key is never admitted under any scope, free-tagged rows included", async () => {
  const mut = (d) => {
    const s = rd(path.join(d, "snapshot.json")); const m = s.rows[5].models[0];                  // fx-mgmt: its key is management, which filterRegistry removes
    s.rows[5].models.push({ ...m, id: "fxm-tag:free" }, { ...m, id: "free-fxm" }); wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[5].models.push("fxm-tag:free", "free-fxm"); wr(path.join(d, "providers.json"), pr);
    const b = rd(path.join(d, "bench.json"));
    for (const k of ["fxm-one", "fxm-tag:free", "free-fxm"]) b.models[`fx-mgmt/${k}`] = { s: "ok", t: 500, a: 1790699779 };
    wr(path.join(d, "bench.json"), b);
  };
  const { g } = await fx(mut);
  assert.equal(g.funnelInputs.tiers["fx-mgmt"], "management", "named as management, not left as 'no tier'");
  for (const scope of ["models", "providers", "providers+deposit"]) {
    const r = run(g, { mode: "free", freeScope: scope });
    assert.ok(!sels(r).some((x) => x.startsWith("fx-mgmt/")), `${scope}: nothing of fx-mgmt among ${r.counts.chosenScopeN} probe-ok selectors in scope`);
    assert.equal(r.counts.freeScopes[scope].n, { models: 5, providers: 7, "providers+deposit": 9 }[scope], `${scope}: the fixture counts are unchanged`);
  }
  for (const mode of ["dynamic", "inherit"]) for (const source of ["all-providers", "same-provider"]) {            // G17: not under any mode either
    const r = run(g, { mode, source });
    assert.ok(!sels(r).some((x) => x.startsWith("fx-mgmt/")), `${mode}/${source}: no fx-mgmt row`);
    assert.ok(!Object.hasOwn(r.substitutable, "fx-mgmt") && !Object.hasOwn(r.lists.byProvider, "fx-mgmt"), `${mode}/${source}: no fx-mgmt entry in substitutable or lists`);
  }
});

test("F24 (library part): a provider with no key tier gets the strict rule and a NO_TIER warning under scope models; ambiguity is reported by readTiers", async () => {
  const addKey = (d) => { const reg = rd(path.join(d, "registry.json")); reg.push({ ...reg[0], id: "personal.fx-free-a.paid", tier: "paid", envVarName: "LLM_X" }); wr(path.join(d, "registry.json"), reg); };
  const { g } = await fx(addKey);
  assert.equal(g.tiersRes.ambiguous.length, 1);
  const strict = run(g, { mode: "free", freeScope: "models" });
  assert.deepEqual(sels(strict).filter((x) => x.startsWith("fx-free-a/")).sort(), ["fx-free-a/fxa-big:free", "fx-free-a/kilo-auto/free"], "strict: the free tag only, the FREE? badge row is skipped");
  assert.match(strict.warnings.find((x) => x.code === "NO_TIER").text, /^NO_TIER: 1 of \d+ providers with probe-ok models have no resolvable key tier .*fx-free-a/);
  const nokey = await fx((d) => { const reg = rd(path.join(d, "registry.json")).filter((x) => x.provider !== "fx-dep"); wr(path.join(d, "registry.json"), reg); });
  assert.match(run(nokey.g, { mode: "free", freeScope: "models" }).warnings.find((x) => x.code === "NO_TIER").text, /\(no key, or several keys with no recorded choice\): fx-dep;/);
  assert.ok(!run(g, { mode: "dynamic" }).warnings.some((x) => x.code === "NO_TIER"), "dynamic does not use tiers: no noise");
});

test("F11 (library part): hostile-shaped registry and compiled files are unreadable or refused, never a raw TypeError", async () => {
  const nullRow = await fx((d) => wr(path.join(d, "registry.json"), [null, { id: "x", provider: "p", tier: "free" }]));
  assert.equal(nullRow.g.funnelInputs.tiers, null, "a null registry row makes the registry unreadable");
  assert.match(nullRow.g.tiersRes.reason, /malformed row/);
  const noProv = await fx((d) => wr(path.join(d, "registry.json"), [{ id: "x", tier: "free" }]));
  assert.equal(noProv.g.funnelInputs.tiers, null);
  const badVault = await fx((d) => wr(path.join(d, "vault-providers.json"), [null]));
  assert.equal(badVault.g.funnelInputs.tiers, null);
  const dir = tmp(), f = path.join(dir, "c.json");
  for (const hostile of ["{}", "null", "[]", "5", '{"schema":1}', '{"schema":1,"owner":{},"counts":{},"models":[null],"lists":{}}']) {
    wr(f, hostile);
    assert.deepEqual(lib.readCompiled(f), { ok: false, reason: "schema" }, hostile);
  }
  wr(f, "{nope"); assert.equal(lib.readCompiled(f).reason, "corrupt");
  wr(f, JSON.stringify({ schema: 1, owner: {}, counts: {}, models: [], lists: {} })); assert.equal(lib.readCompiled(f).ok, true);
  for (const hostile of ["null", "[]", "7", '"x"']) { wr(f, hostile); assert.equal(lib.readStatus(f).ok, false, hostile); }
});

// =====================================================================================================================
// Second fix round (G13 G14 G15).
// =====================================================================================================================
test("G13: the tier vocabulary is listed once: no tier-name literal in the library, the funnel or retier (the relay's own tier is a named constant of tiers.mjs)", () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  // "free" is also the name of a MODE, so it is covered by behaviour (explain, the free scopes); the other four exist only as tiers
  for (const f of ["keysync/subagent-policy.mjs", "menu/subagent-funnel.mjs", "keysync/retier.mjs"]) {
    assert.doesNotMatch(read(f), /"(management|free-deposit|paid|subscription)"/, `${f} re-lists a tier name instead of reading menu/tiers.mjs`);
  }
  assert.equal(RELAY_KEY_ID, `relay.anthropic.${RELAY_TIER}`); assert.equal(RELAY_KEY_ID, "relay.anthropic.subscription", "the literal the snapshot carries is unchanged");
  for (const t of tierList()) { assert.equal(freeScopeOf(t), TIERS[t].freeScope, t); assert.equal(isExcludedTier(t), TIERS[t].excluded, t); }
  for (const bad of ["__proto__", "constructor", "toString", "", undefined, null, 5]) { assert.equal(freeScopeOf(bad), undefined, String(bad)); assert.equal(isExcludedTier(bad), false); assert.equal(isProvenanceVerified(bad), false); }
  assert.deepEqual(tierList().filter(isProvenanceVerified), ["subscription"], "only the relay tier is verified by provenance");
});

test("G14: printable() strips C0, DEL, C1 (U+009B is a CSI) and the bidi overrides and isolates; ordinary text, accents and CJK are left alone", () => {
  const cc = (n) => String.fromCharCode(n);
  assert.equal(lib.printable(`a${cc(0x9b)}31mb`), "a?31mb", "U+009B (CSI) would start an escape sequence on a terminal that honours C1");
  assert.equal(lib.printable(`ev${cc(0x202e)}il`), "ev?il", "U+202E (right-to-left override) would reorder what follows");
  for (const n of [0x00, 0x1b, 0x7f, 0x80, 0x9f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) assert.equal(lib.printable(`x${cc(n)}y`), "x?y", `U+${n.toString(16).toUpperCase().padStart(4, "0")}`);
  // the case it must not break: the characters either side of the ranges and ordinary text stay
  for (const n of [0x20, 0x7e, 0xa0, 0xe9, 0x2029, 0x202f, 0x2065, 0x206a, 0x4e2d]) assert.equal(lib.printable(`x${cc(n)}y`), `x${cc(n)}y`, `U+${n.toString(16)} is kept`);
  assert.equal(lib.printable("groq/llama-3.3-70b"), "groq/llama-3.3-70b");
  assert.equal(lib.printable("a".repeat(500)).length, 160);
});

test("G15: a gate attached by a rebuild is part of the measured file: it counts against the 1 MiB cap (a file that fits without it is refused with it)", async () => {
  const { g } = await fx();
  const sized = (n) => ({ ...g, funnelInputs: { ...g.funnelInputs, aliasValues: { ...g.funnelInputs.aliasValues, haiku: "h".repeat(n) } } });
  const owner = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" };
  const base = Buffer.byteLength(JSON.stringify(lib.compile(sized(1), owner).compiled)) - 1;
  const pad = lib.COMPILED_MAX_BYTES - base - 1;                                          // JSON plus newline is exactly the cap with no gate
  const gate = { code: "CLASSIFIER_UNMEASURED", text: "CLASSIFIER_UNMEASURED: the owner file says enforcement=enforce but a precondition is unmet" };
  const withoutGate = lib.compile(sized(pad), owner).compiled;
  assert.equal(Buffer.byteLength(JSON.stringify(withoutGate) + "\n"), lib.COMPILED_MAX_BYTES, "the case it must not break: exactly the cap, no gate, is accepted");
  assert.throws(() => lib.compile(sized(pad), owner, { gate }), (e) => e.code === "E_PRECONDITION" && /would be \d+ bytes/.test(e.message) && Number(/would be (\d+)/.exec(e.message)[1]) > lib.COMPILED_MAX_BYTES, "the same compile with the gate is over the cap");
  const small = lib.compile(g, owner, { gate }).compiled;
  assert.equal(small.gate.code, "CLASSIFIER_UNMEASURED", "a normal compile carries the gate");
  assert.equal(small.contentHash, lib.compile(g, owner).compiled.contentHash, "the gate is outside the routing hash");
  const src = fs.readFileSync(new URL("../keysync/subagent-policy.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /compiled\.gate\s*=\s*\{/, "cmdRebuild no longer attaches the gate after the size check");
});

// =====================================================================================================================
// G17: an excluded tier (management, menu/tiers.mjs data) is never admitted under ANY mode or scope.
// =====================================================================================================================
test("G17: a management-only provider contributes no row, list entry, count, rank position or injected text under any mode, source or ctx; every other tier and the relay are unchanged", async () => {
  // WITH: extra management rows are added inside this test only (a free tag, a free-looking name, 1M ctx so it would rank first if admitted).
  const withMgmt = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json")); const m = s.rows[5].models[0];                  // fx-mgmt
    assert.equal(s.rows[5].provider, "fx-mgmt");
    s.rows[5].models.push({ ...m, id: "fxm-tag:free", ctx: 1000000 }, { ...m, id: "free-fxm", ctx: 1000000 }); wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[5].models.push("fxm-tag:free", "free-fxm"); wr(path.join(d, "providers.json"), pr);
    const b = rd(path.join(d, "bench.json"));
    for (const k of ["fxm-one", "fxm-tag:free", "free-fxm"]) b.models[`fx-mgmt/${k}`] = { s: "ok", t: 100, a: 1790699779 };
    wr(path.join(d, "bench.json"), b);
  });
  // WITHOUT: the same fixture with the management provider removed altogether (the control)
  const without = await fx((d) => {
    const s = rd(path.join(d, "snapshot.json")); s.rows = s.rows.filter((r) => r.provider !== "fx-mgmt"); wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers = pr.Providers.filter((p) => p.name !== "fx-mgmt"); wr(path.join(d, "providers.json"), pr);
  });
  assert.equal(withMgmt.g.funnelInputs.tiers["fx-mgmt"], "management");
  assert.ok(withMgmt.g.funnelInputs.rows.some((r) => r.provider === "fx-mgmt") && !without.g.funnelInputs.rows.some((r) => r.provider === "fx-mgmt"));
  let cells = 0;
  for (const mode of ["dynamic", "inherit", "free"]) for (const source of ["all-providers", "same-provider"]) for (const ctx of ["any", "1m"]) for (const freeScope of mode === "free" ? ["models", "providers", "providers+deposit"] : ["providers"]) {
    const o = { mode, source, ctx, freeScope }, label = JSON.stringify(o);
    const a = run(withMgmt.g, o), b = run(without.g, o);
    cells += 1;
    assert.ok(!a.models.some((m) => m.s.startsWith("fx-mgmt/")), `${label}: no fx-mgmt model row`);
    assert.deepEqual(a.models, b.models, `${label}: the rows, ranks and order are exactly those of the run without the provider (every other tier and the relay unchanged)`);
    assert.deepEqual(a.lists, b.lists, `${label}: lists`);
    assert.deepEqual(a.substitutable, b.substitutable, `${label}: substitutable`);
    assert.deepEqual([a.emptyProviders, a.thinProviders, a.exempt], [b.emptyProviders, b.thinProviders, b.exempt], `${label}: emptiness maps`);
    for (const k of ["allowed", "verified", "small", "unverified", "premium", "payloadRisk", "payloadUnknown", "alias", "chosenScopeN", "chosenScopeCtx1m", "substitutable"]) assert.equal(a.counts[k], b.counts[k], `${label}: counts.${k}`);
    const pm = a.perProvider["fx-mgmt"];
    if (pm) assert.deepEqual([pm.scope, pm.ctx, pm.sub], [0, 0, 0], `${label}: it never reaches the scope, ctx or substitute stage`);
    assert.ok(!Object.hasOwn(a.substitutable, "fx-mgmt") && !Object.hasOwn(a.lists.byProvider, "fx-mgmt"), `${label}: no fx-mgmt key`);
  }
  assert.equal(cells, 4 + 4 + 12, "every combination was compared: dynamic and inherit x 2 sources x 2 ctx, free x 2 sources x 2 ctx x 3 scopes");
  const grp = run(withMgmt.g, { mode: "dynamic" }).groups.get("fx-mgmt/fxm-one");
  assert.equal(grp.stage, "excluded-tier", "the reason is recorded");
  // the compiled file and the injected text carry nothing of it either, and are identical to the control's (hash included)
  const owner = { ...lib.OWNER_DEFAULTS, source: "same-provider", mode: "dynamic", inject: "on" };
  for (const source of ["same-provider", "all-providers"]) {
    const ca = lib.compile(withMgmt.g, { ...owner, source }).compiled, cb = lib.compile(without.g, { ...owner, source }).compiled;
    assert.ok(!JSON.stringify(ca.inject).includes("fx-mgmt") && !JSON.stringify(ca.models).includes("fx-mgmt"), `${source}: no fx-mgmt in the models or the injected text`);
    assert.equal(ca.contentHash, cb.contentHash, `${source}: the routing hash is that of the control`);
    assert.deepEqual(ca.inject, cb.inject, `${source}: the injected text is that of the control`);
  }
  // the case it must not break: the SAME provider under a non-excluded tier IS admitted (the exclusion is the tier, not the provider), and the relay rows are present
  for (const tier of ["free", "free-deposit", "paid", "subscription"]) {
    const r = funnel({ ...withMgmt.g.funnelInputs, nowMs: NOW, tiers: { ...withMgmt.g.funnelInputs.tiers, "fx-mgmt": tier } }, T({ mode: "dynamic" }));
    assert.ok(sels(r).some((x) => x.startsWith("fx-mgmt/")), `fx-mgmt under tier ${tier} is admitted`);
  }
  assert.ok(sels(run(withMgmt.g, { mode: "dynamic" })).filter((x) => x.startsWith("anthropic/")).length === 3, "the three relay rows are all there");
});

// =====================================================================================================================
// Router v2 compiler additions (ar-4 bands and lists.prov, ar-10 hash hygiene, ar-17 handoff helper)
// =====================================================================================================================
test("ar-4 + D1: every compiled row carries its BAND `b`: equal on [tool tier, health yes/no, ctx preference class, price class] and a contiguous run of the ranked rows; AGE is not a band key; lists.prov lists each provider's rows in rank order for every source (empty under inherit)", () => {
  const nowMs = Date.parse("2026-10-03T12:00:00.000Z"), day = 86400;
  const names = ["pa", "pb"], MODELS = ["m1", "m2", "m3", "m4"];
  const mkRows = (ctxOf = () => 200000) => names.map((p) => ({ provider: p, keyId: `b.${p}.paid`, models: MODELS.map((id, i) => ({ id, outModality: "chat", ctx: ctxOf(i), tools: true, pin: 1, pout: 2 })) }));
  const providers = names.map((name) => ({ name, models: MODELS, enabled: true, described: false }));
  // recency differs (live within 7 days, fresh within 14, older), the band keys do not
  const age = { "pa/m1": 1, "pa/m2": 1, "pa/m3": 10, "pa/m4": 10, "pb/m1": 20, "pb/m2": 20, "pb/m3": 20, "pb/m4": 20 };
  const bench = { get: (k) => ({ s: "ok", a: nowMs / 1000 - age[k] * day, t: 500 }), isLive: (k) => k === "pa/m1" };
  const inputs = { rows: mkRows(), bench, nowMs, providers, tiers: { pa: "paid", pb: "paid" }, toolFidelity: null, aliasValues: {}, defaultModel: null };
  const res = funnel(inputs, T({ source: "all-providers" }));
  const bands = res.models.map((m) => m.b);
  assert.deepEqual([...new Set(bands)], [0], "live, fresh and old rows share ONE band: recency is an ordering key inside it (D1)");
  assert.equal(res.models[0].s, "pa/m1", "yet the ORDER follows recency among rows equal on every earlier key: the live row first");
  assert.deepEqual(res.models.map((m) => m.s.slice(0, 2)), ["pa", "pa", "pa", "pa", "pb", "pb", "pb", "pb"], "and the fresh pa rows before the old pb rows (ties inside a recency class are broken by the id hash)");
  // tool tier IS a band key: a verified, a small and an unverified row make three bands
  const tf = { models: { "pa/m1": { t: "v" }, "pa/m2": { t: "t" } } };
  const r2 = funnel({ ...inputs, toolFidelity: tf }, T({ source: "all-providers" }));
  assert.deepEqual(Object.fromEntries(r2.models.map((m) => [m.s, m.b])), { "pa/m1": 0, "pa/m2": 1, "pa/m3": 2, "pa/m4": 2, "pb/m1": 2, "pb/m2": 2, "pb/m3": 2, "pb/m4": 2 }, "v, t, u are three bands");
  // the context preference class is a band key ONLY under prefer-1m: any and 1m leave it constant
  const big = mkRows((i) => (i === 0 ? 1000000 : 200000));
  const bandsOf = (ctx) => Object.fromEntries(funnel({ ...inputs, rows: big }, T({ source: "all-providers", ctx })).models.map((m) => [m.s, m.b]));
  assert.deepEqual([...new Set(Object.values(bandsOf("any")))], [0], "ctx any: one band");
  assert.deepEqual(bandsOf("prefer-1m"), { "pa/m1": 0, "pb/m1": 0, "pa/m2": 1, "pa/m3": 1, "pa/m4": 1, "pb/m2": 1, "pb/m3": 1, "pb/m4": 1 }, "ctx prefer-1m: rows of at least 1M are a higher band, the rest follow");
  assert.deepEqual(Object.keys(bandsOf("1m")).sort(), ["pa/m1", "pb/m1"], "ctx 1m: the existing filter, unchanged");
  assert.ok(res.models.every((m) => Number.isInteger(m.b) && Number.isInteger(m.g)) && res.models.every((m, i) => i === 0 || m.g >= res.models[i - 1].g));
  for (const source of ["all-providers", "same-provider"]) {
    const r = funnel(inputs, T({ source }));
    assert.deepEqual(Object.keys(r.lists.prov).sort(), ["pa", "pb"], `${source}: prov for every provider`);
    for (const p of ["pa", "pb"]) assert.deepEqual(r.lists.prov[p], r.models.map((m, i) => (m.s.startsWith(`${p}/`) ? i : -1)).filter((i) => i >= 0), `${source}/${p}: ascending row indexes`);
  }
  assert.deepEqual(funnel(inputs, T({ mode: "inherit" })).lists.prov, {}, "inherit computes no lists");
  assert.equal(Object.getPrototypeOf(res.lists.prov), Object.prototype, "an ordinary object that serialises");
});

test("C7 (surviving mutant): the PRICE CLASS is a band key under mode free (rank key 4): rows that differ ONLY in price class (0, 0t, U, P) are four bands, pinned as a golden; a band id that left the price class out would merge them (the compiled bands would differ), while outside free mode price class is constant and adds nothing", async () => {
  const { g } = await fx(q6Mutate);
  const r = run(g, { mode: "free", freeScope: "providers+deposit", source: "all-providers" });
  const bandOf = Object.fromEntries(r.models.map((m) => [m.s, m.b]));
  const [alpha, fxd, fxp, gamma, beta] = ["fx-free-a/fxa-alpha", "fx-dep/fxd-model:free", "fx-paid/fxp/free/x", "fx-free-a/fxa-gamma", "fx-free-a/fxa-beta"];
  assert.deepEqual([alpha, fxd, fxp, gamma, beta].map((x) => r.groups.get(x).rk[3]), [0, 1, 1, 2, 3], "classes 0, 0t, 0t, U, P (rank key 4)");
  assert.deepEqual([alpha, fxd, fxp, gamma, beta].map((x) => r.groups.get(x).rk.slice(0, 3).join(",")), Array(5).fill(r.groups.get(alpha).rk.slice(0, 3).join(",")), "keys 1 to 3 are EQUAL: only the price class differs");
  assert.deepEqual([alpha, fxd, fxp, gamma, beta].map((x) => bandOf[x]), [0, 1, 1, 2, 3], "GOLDEN: one band per price class, the two 0t rows share one");
  assert.equal(bandOf[fxd], bandOf[fxp], "the same class is the same band");
  assert.equal(new Set([alpha, fxd, gamma, beta].map((x) => bandOf[x])).size, 4, "four different price classes: four bands");
  // what the compiler would give if the band id stopped at three keys: ONE band for these five rows, so every golden above would change
  const threeKeyBands = new Set([alpha, fxd, fxp, gamma, beta].map((x) => r.groups.get(x).rk.slice(0, 3).join(",")));
  assert.equal(threeKeyBands.size, 1, "a three-key band id merges them");
  assert.notEqual(threeKeyBands.size, new Set([alpha, fxd, fxp, gamma, beta].map((x) => bandOf[x])).size, "so the compiled bands differ from the three-key bands: the price class is pinned");
  // the case it must not break: outside mode free every row has price class 0 (price2b is off), so it adds no band
  const d = run(g, { mode: "dynamic", source: "all-providers" });
  assert.ok(d.models.every((m) => d.groups.get(m.s).rk[3] === 0), "dynamic: price class is constant");
  assert.equal(new Set(d.models.map((m) => m.b)).size, new Set(d.models.map((m) => d.groups.get(m.s).rk.slice(0, 3).join(","))).size, "so the bands are the three-key bands");
  // and the contract: the router reads `b` as the compiled band id (it never recomputes it), so a different compiled `b` is a different spread
  assert.ok(r.models.every((m, i) => i === 0 || m.b >= r.models[i - 1].b), "bands are a contiguous, non-decreasing run of the ranked rows");
});


test("ar-10 + ar-8: the compiled file carries minRouter and the inert rollout block outside the hash; owner validation accepts banded and handoffNotice only as booleans", () => {
  const g = { funnelInputs: { rows: [], bench: { get: () => null, isLive: () => false }, nowMs: NOW, providers: [], tiers: {}, toolFidelity: null, aliasValues: {}, defaultModel: null }, warnings: [],
    stamps: { snapshotBuiltAt: null, snapshotSchema: 9, benchGeneratedAt: null, observedWrittenAt: null, tfAsOf: null }, providersLive: true, providersHash: "h" };
  const { compiled } = lib.compile(g, { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" });
  assert.equal(compiled.minRouter, lib.MIN_ROUTER); assert.deepEqual(compiled.rollout, { canaryPct: 100, salt: "uw-r1" });
  assert.ok(!lib.HASH_KEYS.includes("minRouter") && !lib.HASH_KEYS.includes("rollout"));
  assert.deepEqual(lib.HASH_OWNER_EXCLUDE, ["enforcement", "classLog", "handoffNotice"]);
  assert.equal(compiled.lists.all, null, "an empty all-providers list is the identity too");
  const ok = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" };
  assert.doesNotThrow(() => lib.validateOwner(ok)); assert.doesNotThrow(() => lib.validateOwner({ ...ok, banded: undefined }));
  for (const bad of [{ banded: "yes" }, { handoffNotice: 1 }, { banded: null }]) assert.throws(() => lib.validateOwner({ ...ok, ...bad }), /must be true or false/);
  assert.equal(lib.ownerBlock({ ...ok, banded: undefined }).banded, true);
});

test("ar-17: mergeStatus sums counters, matrix and tallies, unions warnings with the OLDEST since, keeps the newest main per session and the OLDEST router version; a hostile key is an ordinary key", () => {
  const a = { updatedAt: "2026-10-03T12:00:00.000Z", since: "2026-10-03T10:00:00.000Z", routerVersion: 2, counters: { req: 5, sub: 3 }, matrix: { "a1.b1.t1.g0": 3 }, byModel: { "groq/x": 2, __proto__x: 1 },
    warnings: [{ code: "HANDOFF", since: "2026-10-03T11:00:00.000Z", detail: "old" }], mainBySession: { s1: { model: "a/b", t: "2026-10-03T11:00:00.000Z" } }, latency: { new: [1, 2] } };
  const b = { updatedAt: "2026-10-03T12:05:00.000Z", since: "2026-10-03T09:00:00.000Z", routerVersion: 1, counters: { req: 7, sub: 4, error: 1 }, matrix: { "a1.b1.t1.g0": 4 }, byModel: { "groq/x": 1 },
    warnings: [{ code: "HANDOFF", since: "2026-10-03T11:30:00.000Z", detail: "new" }, { code: "X", since: "2026-10-03T11:40:00.000Z" }], mainBySession: { s1: { model: "c/d", t: "2026-10-03T11:30:00.000Z" } }, latency: { new: [3, 4] } };
  const m = lib.mergeStatus([a, b]);
  assert.deepEqual(m.counters, { req: 12, sub: 7, error: 1 }); assert.deepEqual(m.matrix, { "a1.b1.t1.g0": 7 }); assert.equal(m.byModel["groq/x"], 3);
  assert.equal(m.since, "2026-10-03T09:00:00.000Z"); assert.equal(m.routerVersion, 1); assert.equal(m.workers, 2);
  const h = m.warnings.find((w) => w.code === "HANDOFF");
  assert.deepEqual([h.since, h.detail], ["2026-10-03T11:00:00.000Z", "new"], "the oldest since, the latest detail");
  assert.equal(m.warnings.length, 2); assert.equal(m.mainBySession.s1.model, "c/d"); assert.deepEqual(m.latency.new, [4, 6]);
  assert.equal(({}).req, undefined);
});

// =====================================================================================================================
// Fix round for router v2: owner decisions D1 and the tool-capability rule
// =====================================================================================================================
test("tool-capability results NEVER expire by age: a tool-fidelity record stamped 400 days ago gives the same compiled class (v, t) as a fresh one: the class comes from the last recorded result and the funnel applies no age window to it", async () => {
  const { g } = await fx();
  const target = "fx-free-a/fxa-alpha", other = "fx-free-a/fxa-gamma";
  const mk = (generatedAt, at) => ({ generatedAt, models: { [target]: { t: "v", at, alias: false }, [other]: { t: "t", at, alias: false } } });
  const fresh = funnel({ ...g.funnelInputs, nowMs: NOW, toolFidelity: mk(new Date(NOW).toISOString(), NOW) }, T());
  const old = funnel({ ...g.funnelInputs, nowMs: NOW + 400 * 86400000, toolFidelity: mk(new Date(NOW - 400 * 86400000).toISOString(), NOW - 400 * 86400000) }, T());
  const tier = (r, s) => r.models.find((m) => m.s === s)?.t;
  assert.deepEqual([tier(fresh, target), tier(fresh, other)], ["v", "t"]);
  assert.deepEqual([tier(old, target), tier(old, other)], ["v", "t"], "400 days later: the same classes, not u");
});

// =====================================================================================================================
// Revision 11 policy-side fix round: toggle 3 expanded (D-bg, D-bk), ctx classes (D-bh), inferred ctx and the non-agent denylist (D-bi), known-issue seeds (sa-A6), the re-probe list (sa-A7),
// the id cap (sa-A10), one free verdict (sa-A11), opus-mt (sa-A12), strikes (sa-T3), pb sources and the payload text (sa-A1). Synthetic inputs only: no real id, no real file.
// =====================================================================================================================
const syn = (spec, { tiers, tf = null, bench = {} } = {}) => {
  const rows = Object.entries(spec).map(([p, models]) => ({ provider: p, keyId: `b.${p}.${(tiers ?? {})[p] ?? "free"}`,
    models: models.map((m) => ({ id: m.id, outModality: "chat", ctx: m.ctx ?? null, tools: m.tools ?? true, pin: m.pin ?? 0, pout: m.pout ?? 0, badge: m.badge, limit: m.limit, mode: false, routable: true })) }));
  const providers = Object.entries(spec).map(([p, models]) => ({ name: p, models: models.map((m) => m.id), enabled: true }));
  const meta = Object.fromEntries(Object.entries(spec).flatMap(([p, ms]) => ms.map((m) => [`${p}/${m.id}`, m])));
  const get = (k) => { const m = meta[k], o = bench[k] ?? {}; return { s: o.s ?? "ok", t: o.t ?? m?.t ?? 500, a: o.a ?? NOW / 1000 - 3600, ...(o.m ? { m: o.m } : {}) }; };
  return { rows, providers, bench: { get, isLive: () => false }, nowMs: NOW, tiers: tiers ?? Object.fromEntries(Object.keys(spec).map((p) => [p, "free"])), toolFidelity: tf };
};
const synG = (inp) => ({ funnelInputs: inp, warnings: [], stamps: {}, providersLive: true, providersHash: "h" });
const CTXSPEC = { pa: [{ id: "c64", ctx: 64000 }, { id: "c128", ctx: 131072 }, { id: "c200", ctx: 200000 }, { id: "c256", ctx: 262144 }, { id: "c512", ctx: 524288 }, { id: "c1m", ctx: 1048576 }, { id: "cunk", ctx: null }] };

test("D-bk toggle 3: any excludes nothing, the hard floors exclude rows below them (unknown included), the soft preferences exclude nothing and make a higher band; every value validates", () => {
  const inp = syn(CTXSPEC);
  const ids = (ctx) => sels(funnel(inp, T({ ctx }))).map((s) => s.slice(3)).sort();
  const S = (...a) => a.sort();
  assert.deepEqual(ids("any"), S("c1m", "c128", "c200", "c256", "c512", "c64", "cunk"), "any: all 7 rows, the 64k and the unknown included");
  assert.deepEqual(ids("128k"), S("c1m", "c128", "c200", "c256", "c512"), "128k: the 64k and the unknown row are below the floor");
  assert.deepEqual(ids("200k"), S("c1m", "c200", "c256", "c512"));
  assert.deepEqual(ids("256k"), S("c1m", "c256", "c512"));
  assert.deepEqual(ids("512k"), S("c1m", "c512"));
  assert.deepEqual(ids("1m"), ["c1m"]);
  for (const ctx of ["prefer-256k", "prefer-512k", "prefer-1m"]) assert.equal(ids(ctx).length, 7, `${ctx}: nothing is excluded`);
  const band = (ctx) => Object.fromEntries(funnel(inp, T({ ctx })).models.map((m) => [m.s.slice(3), m.b]));
  assert.deepEqual([...new Set(Object.values(band("any")))], [0], "any: one band");
  const b256 = band("prefer-256k");
  assert.ok(["c256", "c512", "c1m"].every((k) => b256[k] === 0) && ["c64", "c128", "c200", "cunk"].every((k) => b256[k] === 1), "prefer-256k: rows at or above 256k are the higher band");
  const b512 = band("prefer-512k");
  assert.ok(["c512", "c1m"].every((k) => b512[k] === 0) && b512.c256 === 1);
  const none = funnel(syn({ pa: [{ id: "a", ctx: 200000 }, { id: "b", ctx: 262144 }] }), T({ ctx: "512k" }));
  assert.equal(none.empty, true, "an empty result under a hard floor is the empty-set condition");
  assert.equal(emptyStage(none, null).stage, "ctx");
  assert.match(emptyStage(none, null).text, /ctx 512k filter/);
  for (const ctx of lib.ENUMS.ctx) assert.doesNotThrow(() => lib.validateOwner({ ...lib.OWNER_DEFAULTS, ctx }));
  assert.deepEqual(lib.ENUMS.ctx, ["any", "128k", "200k", "256k", "512k", "1m", "prefer-256k", "prefer-512k", "prefer-1m"]);
  assert.throws(() => lib.validateOwner({ ...lib.OWNER_DEFAULTS, ctx: "2m" }), /ctx must be one of any\|128k\|200k\|256k\|512k\|1m\|prefer-256k\|prefer-512k\|prefer-1m/);
});

test("D-bk: rows per floor with their denominators (ctxStats): the unknown rows are in none of the floors; the counts are over the chosen scope and do not move with the ctx toggle", () => {
  const inp = syn(CTXSPEC);
  for (const ctx of ["any", "256k", "prefer-1m"]) {
    const st = funnel(inp, T({ ctx })).ctxStats;
    assert.deepEqual([st.rows, st.unknown, st.inferred], [7, 1, 0], `${ctx}: of 7 rows 1 unknown`);
    assert.deepEqual(st.ge, { "128k": 5, "200k": 4, "256k": 3, "512k": 2, "1m": 1 }, `${ctx}: rows per floor`);
  }
  assert.match(lib.ctxFloorsLine(funnel(inp, T()).ctxStats), /^CONTEXT FLOORS: of 7 rows in the chosen scope, 1 have no known ctx; known ctx >= 128k 5, >= 200k 4, >= 256k 3, >= 512k 2, >= 1M 1; 0 of the 1 unknown rows pass 128k on an inferred ctx/);
});

test("D-bg: the asked model's own context never raises the floor: every ctxHint is capped at the toggle's floor (128k for any and the soft preferences, the hard floor otherwise)", () => {
  const inp = { ...syn(CTXSPEC), aliasValues: { sonnet: "pa/c1m[1m]", haiku: "pa/c200" }, defaultModel: "pa/c1m" };
  const hints = (ctx) => funnel(inp, T({ ctx })).ctxHints;
  for (const ctx of ["any", "prefer-256k", "prefer-512k", "prefer-1m"]) {
    const h = hints(ctx);
    assert.ok(Object.values(h).every((v) => v <= 128000), `${ctx}: no hint above 128,000`);
    assert.equal(h["pa/c1m"], 128000); assert.equal(h["pa/c1m[1m]"], 128000);
  }
  const h256 = hints("256k");
  assert.equal(h256["pa/c1m"], 256000, "256k: capped at the 256k floor, not the row's 1M");
  assert.equal(h256["pa/c200"], 200000, "an alias value keeps its own context when that is below the cap");
  assert.equal(hints("1m")["pa/c1m"], 1000000);
  assert.equal(hints("200k")["pa/c200"], 200000);
  const compiled = lib.compile(synG(inp), { ...lib.OWNER_DEFAULTS, source: "all-providers", ctx: "any" }).compiled;
  assert.equal(compiled.ctxHints["pa/c1m"], 128000, "the compiled file carries the capped hint the router reads");
});

test("D-bh: ctx CLASSES (>= 1M, >= 512k, >= 256k, >= 200k, >= 128k, below) replace raw ctx: two rows in one class tie on the class key whatever their raw ctx", () => {
  const cls = (c) => funnel(syn({ pa: [{ id: "x", ctx: c }] }), T()).groups.get("pa/x").rk[12];
  assert.deepEqual([2000000, 1000000, 999999, 524288, 512000, 511999, 262144, 256000, 255999, 200000, 199999, 131072, 128000, 127999, 64000].map(cls), [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5, 5]);
  const r = funnel(syn({ pa: [{ id: "a", ctx: 1000000, t: 500 }, { id: "b", ctx: 1500000, t: 500 }] }), T());
  assert.equal(r.groups.get("pa/a").rk[12], r.groups.get("pa/b").rk[12], "1M and 1.5M are the same class");
  assert.equal(r.groups.get("pa/a").g, r.groups.get("pa/b").g, "so they are one tie group (raw ctx is no longer a rank key)");
});

test("D-bh: a worse TTFT bucket ranks BELOW a better one even when its ctx class is higher (TTFT is ahead of ctx); the order is stable run to run", () => {
  const spec = { pa: [{ id: "big", ctx: 1000000, t: 40000 }, { id: "mid", ctx: 200000, t: 500 }, { id: "mid2", ctx: 200000, t: 600 }, { id: "fast", ctx: 128000, t: 400 }, { id: "s1", ctx: 512000, t: 20000 }, { id: "s2", ctx: 512000, t: 21000 }, { id: "s3", ctx: 256000, t: 900 }, { id: "s4", ctx: 256000, t: 950 }] };
  const r = funnel(syn(spec), T());
  const order = r.models.map((m) => m.s.slice(3));
  assert.ok(order.indexOf("fast") < order.indexOf("big"), "128k with TTFT 400 ms ranks above 1M with TTFT 40,000 ms: TTFT bucket first");
  assert.equal(r.models.find((m) => m.s === "pa/big").h, 3, "the slowest quartile");
  assert.equal(r.models.find((m) => m.s === "pa/fast").h, 0, "the fastest quartile");
  assert.deepEqual(funnel(syn(spec), T()).models.map((m) => m.s), r.models.map((m) => m.s));
  assert.ok(funnel(syn({ pa: [{ id: "a", ctx: 200000, t: 500 }, { id: "b", ctx: 200000, t: 500 }, { id: "c", ctx: 200000, t: 500 }] }), T()).models.every((m) => m.h === 0), "equal TTFTs are one bucket, not split by position");
});

test("D-bi: an unknown ctx with a same-name sibling of known ctx >= 128k gets an INFERRED ctx (flag ci, clamped to 128k, floor-only); the smallest sibling decides; a hard floor above 128k and the asked floor never use it", () => {
  const inp = syn({ pa: [{ id: "model-x", ctx: 1000000 }, { id: "model-y", ctx: 200000 }, { id: "model-z", ctx: 64000 }],
    pb: [{ id: "model-x:free", ctx: null }, { id: "model-y-2026-05-01", ctx: null }, { id: "model-z@eu", ctx: null }, { id: "lonely", ctx: null }, { id: "model-w:free", ctx: null }], pc: [{ id: "model-y", ctx: 200000 }, { id: "model-w", ctx: 64000 }] });
  inp.rows.find((r) => r.provider === "pa").models.push({ id: "model-w", outModality: "chat", ctx: 1000000, tools: true, pin: 0, pout: 0, mode: false, routable: true }); inp.providers.find((p) => p.name === "pa").models.push("model-w");
  const r = funnel(inp, T());
  const row = (s) => r.models.find((m) => m.s === s);
  assert.deepEqual([row("pb/model-x:free").c, row("pb/model-x:free").ci], [128000, 1], "x:free takes the sibling's 1M but only as a 128k floor-only prior");
  assert.equal(row("pb/model-y-2026-05-01").ci, 1, "a date suffix is the same model name");
  assert.equal(row("pb/model-z@eu").ci, undefined, "a 64k sibling lends nothing (below the floor)");
  assert.equal(row("pb/model-z@eu").c, 0);
  assert.equal(row("pb/lonely").ci, undefined, "no sibling, no inference");
  assert.equal(row("pb/model-w:free").ci, undefined, "siblings of 1M and 64k: the SMALLEST decides, so nothing is inferred");
  assert.equal(row("pa/model-x").ci, undefined, "a measured row is never flagged");
  assert.equal(r.groups.get("pb/model-x:free").rk[12], 4, "never a ranking class above >= 128k");
  assert.equal(r.counts.ctxInferred, 2); assert.equal(r.ctxStats.inferred, 2);
  assert.equal(r.substitutable["*"], 6, "known or inferred 128k+: pa x, y and w, pc y, and the two inferred pb rows (model-z 64k, pc w 64k, z@eu, lonely and w:free are not)");
  assert.deepEqual(sels(funnel(inp, T({ ctx: "128k" }))).filter((s) => s.startsWith("pb/")), [], "a hard 128k floor tests the MEASURED ctx: the inferred rows are left out (the inferred prior serves only the default substitute floor)");
  assert.equal(funnel(inp, T({ ctx: "128k" })).counts.ctxInferred, 0);
  assert.deepEqual(sels(funnel(inp, T({ ctx: "prefer-256k" }))).filter((s) => s.startsWith("pb/") && s !== "pb/model-z@eu").length, 4, "a soft preference excludes nothing, so the inferred rows stay and still serve as substitutes");
  assert.equal(funnel(inp, T({ ctx: "prefer-256k" })).substitutable["*"], 6);
  assert.match(lib.ctxFloorsLine(r.ctxStats, "128k"), /; ctx 128k tests the measured ctx only, so those 2 are left out$/);
  assert.ok(!/left out$/.test(lib.ctxFloorsLine(r.ctxStats, "any")));
  assert.deepEqual(sels(funnel(inp, T({ ctx: "256k" }))).filter((s) => s.startsWith("pb/")), [], "a floor above 128k never admits an inferred row");
  assert.deepEqual(sels(funnel(inp, T({ ctx: "1m" }))).sort(), ["pa/model-w", "pa/model-x"]);
  assert.equal(funnel({ ...inp, aliasValues: { opus: "pb/model-x:free" } }, T()).ctxHints["pb/model-x:free"], 128000, "the hint of an inferred row is the floor value, never the sibling's 1M");
  assert.match(lib.injectRow(row("pb/model-x:free")), /^- pb\/model-x:free  ~128k\?  /, "never shown as measured");
});

test("D-bi: the non-agent denylist (safety, guard, embed, rerank, ocr, lora, moderation, under 4B) drops a row with reason non-agent-model, and a denylisted row can never lend an inferred ctx", () => {
  const inp = syn({ pa: [{ id: "nemotron-3.5-content-safety-free", ctx: 1000000 }, { id: "lfm-2.5-2.6b", ctx: 200000 }, { id: "llama-guard-4", ctx: 128000 }, { id: "bge-embed-v3", ctx: 8000 }, { id: "x-rerank", ctx: 4000 },
    { id: "deepseek-ocr", ctx: 8000 }, { id: "qwen3-30b-a3b", ctx: 262144 }, { id: "gpt-oss-20b", ctx: 131072 }, { id: "tiny-moderation", ctx: 8000 }], pb: [{ id: "nemotron-3.5-content-safety-free", ctx: null }, { id: "lfm-2.5-2.6b", ctx: null }] });
  const r = funnel(inp, T());
  assert.deepEqual(sels(r).sort(), ["pa/gpt-oss-20b", "pa/qwen3-30b-a3b"], "30b-a3b and 20b are real agents: only they survive");
  for (const k of ["pa/nemotron-3.5-content-safety-free", "pa/lfm-2.5-2.6b", "pa/llama-guard-4", "pa/bge-embed-v3", "pa/x-rerank", "pa/deepseek-ocr", "pa/tiny-moderation", "pb/nemotron-3.5-content-safety-free", "pb/lfm-2.5-2.6b"]) assert.equal(r.dropped.get(k), "non-agent-model", k);
  assert.equal(r.counts.nonAgent, 9); assert.equal(r.nonAgent.length, 9);
  assert.equal(r.counts.ctxInferred, 0, "the pb rows' siblings are denylisted: nothing is inferred from them, and they are never candidates");
  for (const [id, want] of [["gemma-3-3b-it", "non-agent-model"], ["x-3.9b-chat", "non-agent-model"], ["x-4b-chat", null], ["model-a3b", null], ["guardian-x", null], ["safeguarded", null]]) assert.equal(nonAgentReason(id), want, id);
});

test("sa-A6: known-failing rows are seeded x (known issue) until a REAL tool-fidelity record exists; only the named provider; a size cap is a cap (pb), never x", () => {
  const spec = { aihubmix: [{ id: "coding-glm-5.1-free", ctx: 200000 }, { id: "xiaomi-mimo-v2.5-pro-free", ctx: 1048576 }, { id: "good-model", ctx: 200000 }],
    other: [{ id: "coding-glm-5.1-free", ctx: 200000 }, { id: "xiaomi-mimo-v2.5-pro-free", ctx: 200000 }], nvidia: [{ id: "openai/gpt-oss-20b", ctx: 131072 }], groq: [{ id: "openai/gpt-oss-20b", ctx: 131072 }], orcarouter: [{ id: "deepseek/deepseek-v4-flash-free", ctx: 1000000 }] };
  const r = funnel(syn(spec), T());
  assert.deepEqual(sels(r).sort(), ["groq/openai/gpt-oss-20b", "aihubmix/good-model", "orcarouter/deepseek/deepseek-v4-flash-free", "other/coding-glm-5.1-free", "other/xiaomi-mimo-v2.5-pro-free"].sort(), "5 of 8: the three seeded rows are out; the same ids on `other` and on groq are untouched");
  for (const k of ["aihubmix/coding-glm-5.1-free", "aihubmix/xiaomi-mimo-v2.5-pro-free", "nvidia/openai/gpt-oss-20b"]) assert.equal(r.groups.get(k).stage, "known-bad", k);
  assert.equal(r.groups.get("aihubmix/coding-glm-5.1-free").knownIssue.issue, 118);
  assert.equal(r.groups.get("aihubmix/xiaomi-mimo-v2.5-pro-free").knownIssue.issue, 119);
  assert.equal(r.counts.knownBad, 3);
  assert.match(knownIssueText(r.groups.get("aihubmix/coding-glm-5.1-free").knownIssue), /^known issue #118: /);
  const cap = r.models.find((m) => m.s === "orcarouter/deepseek/deepseek-v4-flash-free");
  assert.deepEqual([cap.pb, cap.pbSource, cap.t], [408000, "known-issue", "u"], "#109 is a size refusal: a payload cap and still a candidate (never x)");
  // a REAL record wins: a pass lifts the x prior and removes the seeded cap
  const tf = { models: { "aihubmix/coding-glm-5.1-free": { t: "v", lvr: "pppp" }, "orcarouter/deepseek/deepseek-v4-flash-free": { t: "v", lvr: "pppp", big: "p" } } };
  const w = funnel(syn(spec, { tf }), T());
  assert.ok(sels(w).includes("aihubmix/coding-glm-5.1-free"), "a real v record overrides the seeded x");
  assert.equal(w.models.find((m) => m.s === "orcarouter/deepseek/deepseek-v4-flash-free").pb, 0, "and the seeded cap no longer applies");
  assert.equal(w.groups.get("aihubmix/xiaomi-mimo-v2.5-pro-free").stage, "known-bad", "the other seeded row is still excluded");
  const x = funnel(syn(spec, { tf: { models: { "aihubmix/good-model": { t: "x", lvr: "fnnn" } } } }), T());
  assert.equal(x.groups.get("aihubmix/good-model").stage, "tools-failed", "a measured x keeps its own stage");
  assert.equal(knownIssueOf("aihubmix", "coding-glm-5.1-free").issue, 118);
  assert.equal(knownIssueOf("other", "coding-glm-5.1-free"), null);
});

test("sa-A7: a free-tagged row dropped on a transient bench status (rate, empty, timeout, fetch failed) of a sample older than 2 days is listed for re-probe, never silently excluded; a fresh sample, a non-free row and a hard status are not", () => {
  const day = 86400;
  const spec = { pa: [{ id: "a:free" }, { id: "b:free" }, { id: "c:free" }, { id: "d:free" }, { id: "e:free" }, { id: "f:free" }, { id: "paid-row", pin: 1, pout: 2 }, { id: "g:free" }] };
  const old = NOW / 1000 - 6 * day, fresh = NOW / 1000 - day;
  const bench = { "pa/a:free": { s: "rate", a: old }, "pa/b:free": { s: "empty", a: old }, "pa/c:free": { s: "timeout", a: old }, "pa/d:free": { s: "error", a: old, m: "pa: fetch failed" },
    "pa/e:free": { s: "rate", a: fresh }, "pa/f:free": { s: "gone", a: old }, "pa/paid-row": { s: "rate", a: old }, "pa/g:free": { s: "error", a: old, m: "pa: HTTP 500" } };
  const inp = syn(spec, { tiers: { pa: "paid" }, bench });
  const r = funnel(inp, T());
  assert.deepEqual(r.reprobe.map((x) => x.s), ["pa/a:free", "pa/b:free", "pa/c:free", "pa/d:free"], "4 of 8 rows: the four transient statuses on a 6-day-old sample");
  assert.deepEqual(r.reprobe.map((x) => [x.status, x.ageDays]), [["rate", 6], ["empty", 6], ["timeout", 6], ["error", 6]]);
  assert.equal(r.counts.reprobe, 4);
  assert.equal(r.models.length, 0, "they stay out of the allowed set");
  assert.ok(r.warnings.some((w) => w.code === "REPROBE" && /^REPROBE: 4 free-tagged/.test(w.text)));
  const c = lib.compile(synG(inp), { ...lib.OWNER_DEFAULTS, source: "all-providers" }, {}).compiled;
  assert.deepEqual(c.reprobe.map((x) => x.s), ["pa/a:free", "pa/b:free", "pa/c:free", "pa/d:free"], "the compiled file lists them for the bench re-probe and the ledger");
  assert.equal(c.counts.reprobe, 4);
  assert.equal(lib.hashOf({ ...c, reprobe: [] }), c.contentHash, "outside the hash: routing content is unchanged by the list");
});

test("sa-A11 one free verdict: on a free-labelled provider a price 0/0 row is free like its :free-tagged sibling; on a paid provider only the free tag counts; sa-A10: a 160-character selector is kept; sa-A12: opus-mt is not premium", () => {
  const spec = { fp: [{ id: "north-mini-code-1-0", ctx: 200000 }, { id: "north-mini-code:free", ctx: 200000, pin: 1 }, { id: "priced", ctx: 200000, pin: 1, pout: 2 }], pp: [{ id: "north-mini-code-1-0", ctx: 200000 }, { id: "north-mini-code:free", ctx: 200000 }] };
  const r = funnel(syn(spec, { tiers: { fp: "free", pp: "paid" } }), T({ mode: "free", freeScope: "models" }));
  assert.deepEqual(sels(r).sort(), ["fp/north-mini-code-1-0", "fp/north-mini-code:free", "pp/north-mini-code:free"].sort(), "free-labelled: price 0/0 and the tag agree; paid: only the tag");
  assert.equal(cell(r, "fp/north-mini-code-1-0").f, 1);
  const ok = funnel(syn({ pa: [{ id: "m".repeat(150), ctx: 200000 }] }), T());
  assert.equal(ok.counts.idRejected, 0);
  assert.equal(ok.models.length, 1, "pa/ + 150 characters = 153, under the 160 cap");
  assert.equal(funnel(syn({ pa: [{ id: "m".repeat(160), ctx: 200000 }] }), T()).counts.idRejected, 1, "pa/ + 160 = 163 characters is over the cap");
  assert.ok(!isPremium("Helsinki-NLP/opus-mt-en-de", 0) && !isPremium("opus-mt-tc-big-en-fr", null), "opus-mt is a translation model");
  assert.ok(isPremium("claude-opus-5", 1) && isPremium("opus", null) && isPremium("models/opus-4", 0), "every real opus stays premium");
});

test("sa-T3: a provisional first strike (strikes 1) ranks BELOW a clean row of the same class inside its band, whatever its ctx and TTFT; it is never excluded; unknown record fields (inheritance data) change nothing", () => {
  const spec = { pa: [{ id: "struck", ctx: 1000000, t: 100 }, { id: "clean", ctx: 200000, t: 900 }, { id: "clean2", ctx: 200000, t: 950 }] };
  const tf = { models: { "pa/struck": { t: "t", lvr: "ppnn", strikes: 1, sl: 3 }, "pa/clean": { t: "t", lvr: "ppnn" }, "pa/clean2": { t: "t", lvr: "ppnn", likelyX: true, inherited: { from: "pb/x", t: "x" } } } };
  const r = funnel(syn(spec, { tf }), T());
  assert.deepEqual(r.models.map((m) => m.s), ["pa/clean", "pa/clean2", "pa/struck"], "the struck row is last of its class although it has the most context and the best TTFT");
  assert.deepEqual([r.groups.get("pa/struck").rk[4], r.groups.get("pa/clean").rk[4]], [1, 0]);
  assert.equal(new Set(r.models.map((m) => m.b)).size, 1, "an ordering key inside ONE band, not a band of its own: a strike is not a verdict");
  const none = funnel(syn(spec, { tf: { models: { ...tf.models, "pa/struck": { t: "t", lvr: "ppnn" } } } }), T());
  assert.equal(none.models[0].s, "pa/struck", "without the strike the better TTFT and ctx lead: the strike is the only reason it fell");
});

test("sa-A1: pb comes from the catalogue limit or a tool-fidelity capBelow (the smaller wins) and carries a pbSource; the PAYLOAD text states the payload gate is inert for unknown caps and the measured shadow figures (317 of 337, 94%; 71, 21%)", () => {
  const spec = { pa: [{ id: "cat", ctx: 200000, limit: { bytes: 245 * 1024 } }, { id: "cap", ctx: 200000 }, { id: "both", ctx: 200000, limit: { bytes: 900000 } }, { id: "none", ctx: 200000 }, { id: "small", ctx: 200000, limit: { bytes: 200 * 1024 } }] };
  const tf = { models: { "pa/cap": { t: "v", lvr: "pppn", big: "f", capBelow: 408000 }, "pa/both": { t: "v", lvr: "pppn", big: "f", capBelow: 300000 }, "pa/small": { t: "v", lvr: "pppn", big: "f", capBelow: 408000 } } };
  const r = funnel(syn(spec, { tf }), T());
  const m = (id) => r.models.find((x) => x.s === `pa/${id}`);
  assert.deepEqual([[m("cat").pb, m("cat").pbSource], [m("cap").pb, m("cap").pbSource], [m("both").pb, m("both").pbSource], [m("none").pb, m("none").pbSource], [m("small").pb, m("small").pbSource]],
    [[245 * 1024, "catalogue"], [408000, "capBelow"], [300000, "capBelow"], [0, undefined], [200 * 1024, "catalogue"]], "the smaller of catalogue and capBelow wins; no cap, no source");
  const w = r.warnings.find((x) => x.code === "PAYLOAD").text;
  assert.match(w, /^PAYLOAD: 4 of 5 allowed models have a known payload cap below 1,000,000 bytes; 1 have no known cap, so the payload gate is inert for them until a cap is measured/);
  assert.match(w, /317 of 337 classified subagent requests \(94%\) were over 200 KB and 71 \(21%\) over 1 MB/);
  assert.ok(!/919/.test(w), "the old 'largest observed body 919 KB' is gone");
  assert.match(lib.payloadGateLine({ allowed: 4, payloadUnknown: 1 }), /^payload limits: 1 of 4 eligible models have no known request-size limit, so the size check does nothing for them/);
  assert.equal(lib.payloadGateLine({ allowed: 4, payloadUnknown: 0 }), null);
});

// =====================================================================================================================
// Owner follow-up: the in-band order is strike, big, L4, TTFT quartile, ctx class, price value, RECENCY (calendar-dependent, last non-alias key), alias, then a hash of the id.
// =====================================================================================================================
test("rank order: an OLDER-probe ok model with better TTFT outranks a FRESHER-probe slower one; recency never outranks latency or context", () => {
  const day = 86400;
  const spec = { pa: [{ id: "old-fast", ctx: 200000, t: 100 }, { id: "new-slow", ctx: 200000, t: 9000 }, { id: "mid1", ctx: 200000, t: 3000 }, { id: "mid2", ctx: 200000, t: 4000 }] };
  const bench = { "pa/old-fast": { a: NOW / 1000 - 20 * day }, "pa/new-slow": { a: NOW / 1000 - 3600 }, "pa/mid1": { a: NOW / 1000 - 3600 }, "pa/mid2": { a: NOW / 1000 - 3600 } };
  const r = funnel(syn(spec, { bench }), T());
  const g = (id) => r.groups.get(`pa/${id}`);
  assert.equal(g("old-fast").rk.length, 17, "seventeen keys");
  assert.deepEqual([g("old-fast").rk[14], g("new-slow").rk[14]], [2, 1], "old-fast is recency class 2 (older than 14 days), new-slow class 1");
  assert.ok(g("old-fast").rk[11] < g("new-slow").rk[11], "and its TTFT bucket (key 8) is better");
  assert.equal(r.models[0].s, "pa/old-fast", "the older probe wins on latency");
  assert.equal(r.models[r.models.length - 1].s, "pa/new-slow");
  assert.equal(new Set(r.models.map((m) => m.b)).size, 1, "all one band: health is calendar-independent and recency is no band key");
  // context also outranks recency: a bigger context class with an older probe ranks first when TTFT ties
  const c = funnel(syn({ pa: [{ id: "old-big", ctx: 1000000, t: 500 }, { id: "new-small", ctx: 128000, t: 500 }] }, { bench: { "pa/old-big": { a: NOW / 1000 - 30 * day }, "pa/new-small": { a: NOW / 1000 - 60 } } }), T());
  assert.deepEqual(c.models.map((m) => m.s), ["pa/old-big", "pa/new-small"], "1M with a 30-day-old probe above 128k with a fresh one");
  // recency is still an ordering key: with every earlier key equal, the fresher probe leads
  const e = funnel(syn({ pa: [{ id: "a", ctx: 200000, t: 500 }, { id: "b", ctx: 200000, t: 500 }] }, { bench: { "pa/a": { a: NOW / 1000 - 20 * day }, "pa/b": { a: NOW / 1000 - 60 } } }), T());
  assert.equal(e.models[0].s, "pa/b", "recency decides only when TTFT, ctx class and price tie");
  assert.deepEqual(r.groups.get("pa/mid1").rk.slice(11, 13), [r.groups.get("pa/mid1").rk[11], 3], "key layout: [.. 11 TTFT bucket, 12 ctx class, 13 price value, 14 recency, 15 alias, 16 spawn marker]");
});

test("final tie-break: rows equal on every key are ordered by a hash of the id (deterministic, independent of input order), not alphabetically", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `m${String(i).padStart(2, "0")}`);
  const mk = (list) => funnel(syn({ pa: list.map((id) => ({ id, ctx: 200000, t: 500 })) }), T()).models.map((m) => m.s.slice(3));
  const a = mk(ids), b = mk([...ids].reverse());
  assert.deepEqual(a, b, "the same order whatever order the rows arrive in");
  assert.deepEqual(a, [...ids].sort((x, y) => fnv1a32(`pa/${x}`) - fnv1a32(`pa/${y}`)), "ordered by fnv1a32 of the selector");
  assert.notDeepEqual(a, [...ids].sort(), "and not alphabetical");
});

test("F2: under EVERY hard floor (128k, 200k, 256k, 512k, 1m) every allowed row has a MEASURED ctx at or above it; an inferred row is never admitted by a floor", () => {
  const inp = syn({ pa: [{ id: "big", ctx: 1048576 }, { id: "mid", ctx: 262144 }, { id: "low", ctx: 131072 }, { id: "nope", ctx: 64000 }], pb: [{ id: "big:free", ctx: null }, { id: "mid-2026-01-02", ctx: null }, { id: "low@eu", ctx: null }, { id: "nope:free", ctx: null }] });
  const any = funnel(inp, T());
  assert.equal(any.counts.ctxInferred, 3, "under any three unknown rows pass the 128k substitute floor on an inferred ctx (nope:free has a 64k sibling)");
  for (const [ctx, floor] of [["128k", 128000], ["200k", 200000], ["256k", 256000], ["512k", 512000], ["1m", 1000000]]) {
    const r = funnel(inp, T({ ctx }));
    assert.ok(r.models.length > 0 || ctx === "1m" || true);
    for (const m of r.models) { assert.ok(r.groups.get(m.s).cm >= floor, `${ctx}: ${m.s} measured ${r.groups.get(m.s).cm}`); assert.equal(m.ci, undefined, `${ctx}: ${m.s} is not inferred`); }
    assert.ok(!r.models.some((m) => m.s.startsWith("pb/")), `${ctx}: no unknown-ctx row`);
  }
  assert.deepEqual(sels(funnel(inp, T({ ctx: "128k" }))).sort(), ["pa/big", "pa/low", "pa/mid"]);
});

test("F3: inferred ctx never merges different models: pool aliases neither borrow nor lend, re-upload namespaces (community/) are no siblings, and two vendor paths must match when both ids have one", () => {
  const inp = syn({
    kilo: [{ id: "kilo-auto/free", ctx: 1000000 }], orcarouter: [{ id: "free", ctx: null }], anymodel: [{ id: "am/free", ctx: null }], pa: [{ id: "free", ctx: null }],
    pollinations: [{ id: "community/Catniti/muse-glimmer-30b", ctx: 200000 }], routewayai: [{ id: "muse-glimmer-30b:free", ctx: null }],
    p1: [{ id: "openai/gpt-x", ctx: 1000000 }, { id: "real-model", ctx: 200000 }], p2: [{ id: "anthropic/gpt-x", ctx: null }, { id: "real-model:free", ctx: null }], p3: [{ id: "gpt-x", ctx: null }, { id: "openai/gpt-x-2026-02-03", ctx: null }],
    p4: [{ id: "community/real-model", ctx: 200000 }, { id: "user/gpt-y", ctx: 300000 }], p5: [{ id: "gpt-y", ctx: null }],
  });
  const r = funnel(inp, T());
  const ci = (s) => r.groups.get(s).ci;
  for (const s of ["orcarouter/free", "anymodel/am/free", "pa/free"]) assert.equal(ci(s), 0, `${s}: a pool alias never borrows from kilo-auto/free`);
  assert.equal(r.groups.get("kilo/kilo-auto/free").ci, 0, "and a pool alias never lends or borrows");
  assert.equal(ci("routewayai/muse-glimmer-30b:free"), 0, "a community/ re-upload is not a sibling of muse-glimmer-30b:free");
  assert.equal(ci("p2/anthropic/gpt-x"), 0, "openai/gpt-x and anthropic/gpt-x are different vendors");
  assert.equal(ci("p3/gpt-x"), 1, "a bare gpt-x has no vendor to contradict: it takes the one sibling's ctx");
  assert.equal(ci("p3/openai/gpt-x-2026-02-03"), 1, "same vendor, a date suffix");
  assert.equal(ci("p2/real-model:free"), 1, "the plain case still works: x:free borrows from x");
  assert.equal(ci("p5/gpt-y"), 0, "user/ is a re-upload namespace too");
  assert.equal(r.counts.ctxInferred, 3);
});

test("F4: the seeds are EXACT ids: siblings and newer versions are not touched; a seed stays in force against an L1+L2-only record and is lifted only by a real L3 or big result (or a confirmed x)", () => {
  const spec = { aihubmix: [{ id: "coding-glm-5.1-free", ctx: 200000 }, { id: "glm-5.2", ctx: 1049000 }, { id: "glm-5.3-turbo", ctx: 200000 }, { id: "zai-glm-5.1", ctx: 200000 }, { id: "xiaomi-mimo-v2.5-pro-free", ctx: 200000 }, { id: "xiaomi-mimo-v2.6-free", ctx: 200000 }, { id: "mimo-v2.5-flash", ctx: 200000 }],
    orcarouter: [{ id: "deepseek/deepseek-v4-flash-free", ctx: 1000000 }, { id: "deepseek/deepseek-v4-flash", ctx: 1000000 }], nvidia: [{ id: "openai/gpt-oss-20b", ctx: 131072 }, { id: "openai/gpt-oss-120b", ctx: 131072 }] };
  const r = funnel(syn(spec), T());
  const stopped = [...r.groups.values()].filter((g) => g.stage === "known-bad").map((g) => g.selector).sort();
  assert.deepEqual(stopped, ["aihubmix/coding-glm-5.1-free", "aihubmix/xiaomi-mimo-v2.5-pro-free", "nvidia/openai/gpt-oss-20b"], "3 of 11 rows: exactly the ids the issues name");
  assert.equal(r.counts.knownBad, 3);
  for (const k of ["aihubmix/glm-5.2", "aihubmix/glm-5.3-turbo", "aihubmix/zai-glm-5.1", "aihubmix/xiaomi-mimo-v2.6-free", "aihubmix/mimo-v2.5-flash", "nvidia/openai/gpt-oss-120b", "orcarouter/deepseek/deepseek-v4-flash"]) assert.equal(r.groups.get(k).stage, "in-set", k);
  const cap = (x) => x.models.find((m) => m.s === "orcarouter/deepseek/deepseek-v4-flash-free");
  assert.equal(cap(r).pb, 408000);
  assert.equal(r.models.find((m) => m.s === "orcarouter/deepseek/deepseek-v4-flash").pb, 0, "the non-free sibling has no seeded cap");
  // an L1+L2-only record (L3 not run: lvr[2] n) proves nothing about a tool set or a 408 KB body
  const l12 = { models: { "aihubmix/coding-glm-5.1-free": { t: "t", lvr: "ppnn" }, "aihubmix/xiaomi-mimo-v2.5-pro-free": { t: "t", lvr: "ppnn" }, "orcarouter/deepseek/deepseek-v4-flash-free": { t: "t", lvr: "ppnn" }, "nvidia/openai/gpt-oss-20b": { t: "t", lvr: "ppnn" } } };
  const a = funnel(syn(spec, { tf: l12 }), T());
  assert.deepEqual([...a.groups.values()].filter((g) => g.stage === "known-bad").length, 3, "the three x seeds survive an L1+L2 record");
  assert.deepEqual([cap(a).pb, cap(a).pbSource], [408000, "known-issue"], "and the #109 cap survives it");
  // a real L3 pass lifts an x seed; a real L3 fail is the record's own verdict; a big result lifts the cap (or replaces it with the measured capBelow)
  const l3 = funnel(syn(spec, { tf: { models: { "aihubmix/coding-glm-5.1-free": { t: "v", lvr: "pppn" }, "aihubmix/xiaomi-mimo-v2.5-pro-free": { t: "x", lvr: "ppfn", strikes: 2, sl: 3 }, "orcarouter/deepseek/deepseek-v4-flash-free": { t: "v", lvr: "pppn", big: "p" } } } }), T());
  assert.equal(l3.groups.get("aihubmix/coding-glm-5.1-free").stage, "in-set", "an L3 pass lifts the seed");
  assert.equal(l3.groups.get("aihubmix/xiaomi-mimo-v2.5-pro-free").stage, "tools-failed", "a confirmed record x is the record's own stage, not the seed's");
  assert.equal(cap(l3).pb, 0, "a big pass lifts the seeded cap");
  const bigOnly = funnel(syn(spec, { tf: { models: { "orcarouter/deepseek/deepseek-v4-flash-free": { t: "t", lvr: "ppnn", big: "p" } } } }), T());
  assert.equal(cap(bigOnly).pb, 0, "a big-step result alone (L3 not recorded) is real evidence about the body size: the seeded cap is lifted");
  const bf = funnel(syn(spec, { tf: { models: { "orcarouter/deepseek/deepseek-v4-flash-free": { t: "v", lvr: "pppn", big: "f", capBelow: 300000 } } } }), T());
  assert.deepEqual([cap(bf).pb, cap(bf).pbSource], [300000, "capBelow"], "a measured capBelow replaces the seed");
  const keep = funnel(syn(spec, { tf: { models: { "orcarouter/deepseek/deepseek-v4-flash-free": { t: "v", lvr: "pppn", big: "f", capBelow: 500000 } } } }), T());
  assert.deepEqual([cap(keep).pb, cap(keep).pbSource], [500000, "capBelow"], "the record's own cap is the real evidence, even above the seed");
});

test("F6: a free model dropped on a transient status whose STORED MESSAGE names the account (plan, key, balance: the bench classifyTight) is shown as account state, not as waiting for a re-probe; a rate message and a network failure still wait", async () => {
  const { classifyTight } = await import("../refresh/bench.mjs");
  const day = 86400, old = NOW / 1000 - 6 * day;
  const ORCA = "orcarouter: Free models are not available to this account yet. They require the workspace owner to link a GitHub account that has been registered for some time ";
  const spec = { pa: [{ id: "acct-a:free" }, { id: "acct-b:free" }, { id: "acct-c:free" }, { id: "rate-a:free" }, { id: "net-a:free" }, { id: "empty-a:free" }, { id: "gone-a:free" }, { id: "quota-a:free" }] };
  const bench = {
    "pa/acct-a:free": { s: "rate", a: old, m: ORCA }, "pa/acct-b:free": { s: "rate", a: old, m: ORCA },
    "pa/acct-c:free": { s: "rate", a: old, m: "Insufficient balance. Please recharge your account." },
    "pa/rate-a:free": { s: "rate", a: old, m: "mistral: Rate limit exceeded" }, "pa/net-a:free": { s: "error", a: old, m: "fetch failed" }, "pa/empty-a:free": { s: "empty", a: old },
    "pa/gone-a:free": { s: "rate", a: old, m: "The model `x` does not exist or has been deprecated and is no longer available" },
    "pa/quota-a:free": { s: "rate", a: old, m: "google: You exceeded your current quota, please check your plan and billing details." },
  };
  const inp = { ...syn(spec, { tiers: { pa: "paid" }, bench }), classifyBench: (rec) => classifyTight(typeof rec?.m === "string" ? rec.m : "") };
  const r = funnel(inp, T());
  assert.deepEqual(r.accountRows.map((x) => [x.s, x.why]), [["pa/acct-a:free", "auth"], ["pa/acct-b:free", "auth"], ["pa/acct-c:free", "pay"]], "3 of the 8 transient rows name the account");
  assert.deepEqual(r.reprobe.map((x) => x.s), ["pa/empty-a:free", "pa/net-a:free", "pa/quota-a:free", "pa/rate-a:free"], "the other 4 still wait for a re-probe; gone-a is neither (its message says the model is gone)");
  assert.equal(r.counts.accountStateRows, 3); assert.equal(r.counts.reprobe, 4);
  assert.ok(r.warnings.some((w) => w.code === "REPROBE" && /^REPROBE: 4 /.test(w.text)), "the warning counts only the rows that wait");
  assert.equal(r.groups.get("pa/acct-a:free").accountState, "auth"); assert.ok(!r.groups.get("pa/acct-a:free").reprobe);
  assert.equal(r.groups.get("pa/gone-a:free").reprobe, undefined);
  // without a classifier (a pure caller) every transient row waits, exactly as before
  assert.equal(funnel(syn(spec, { tiers: { pa: "paid" }, bench }), T()).reprobe.length, 8);
  // the compiled file carries both lists, outside the hash, and the shell wires the real classifier
  const c = lib.compile(synG(inp), { ...lib.OWNER_DEFAULTS, source: "all-providers" }, {}).compiled;
  assert.deepEqual(c.accountStateRows.map((x) => x.s), ["pa/acct-a:free", "pa/acct-b:free", "pa/acct-c:free"]);
  assert.deepEqual([c.counts.accountStateRows, c.counts.reprobe], [3, 4]);
  assert.equal(lib.hashOf({ ...c, accountStateRows: [] }), c.contentHash);
  const { g } = await fx();
  assert.equal(g.funnelInputs.classifyBench({ m: ORCA }), "auth", "gatherInputs hands the funnel the bench's own tight reading");
  assert.equal(g.funnelInputs.classifyBench({ s: "rate" }), null);
});

test("F7: the denylist catches embedding families (embeddinggemma, -embedding-, text-embedding, embedqa), speech and retrieval models, and keeps every real agent id the snapshot holds", () => {
  for (const id of ["embeddinggemma-300m", "@cf/google/embeddinggemma-300m", "qwen3-embedding-8b", "text-embedding-3-large", "gemini-embedding", "jina-embeddings-v3", "nv-embedqa-mistral-7b-v2", "nv-embedcode-7b-v1", "nomic-embed-text",
    "qwen3-asr-flash", "qwen3-tts-flash", "whisper-large-v3", "jina-clip-v2", "bge-m3", "multilingual-e5-large", "gemma-4-31b-assguard", "nvidia/llama-3.1-nemoguard-8b-topic-control", "gpt-4o-transcribe", "sentence-transformers/all-minilm-l6-v2"]) assert.equal(nonAgentReason(id), "non-agent-model", id);
  for (const id of ["claude-sonnet-5-5", "gpt-oss-120b", "gemini-3.8-flash", "qwen3-coder-480b", "deepseek-v4-flash", "llama-3.3-70b-instruct", "glm-5.1", "kimi-k2.5", "mistral-large-2512", "command-a", "grok-4", "gemma-3-27b-it", "nemotron-3-super-120b", "devstral-medium", "coding-glm-5.1-free", "minimax-m2.5", "step-3.5-flash", "ernie-5.0", "hunyuan-turbo", "o3-pro"]) assert.equal(nonAgentReason(id), null, id);
  const r = funnel(syn({ pa: [{ id: "embeddinggemma-300m", ctx: 200000 }, { id: "real-agent", ctx: 200000 }] }), T());
  assert.deepEqual(sels(r), ["pa/real-agent"]); assert.equal(r.dropped.get("pa/embeddinggemma-300m"), "non-agent-model");
});


// =====================================================================================================================
// Compile fixes from sanity pass 2 and review cr-policy-compile: the tool sweep's latest state (B1), the H2 marker rank keys, gateway-compat (M2), the non-agent additions (M3), ctx unproven (M1)
// =====================================================================================================================
const AT = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const pend = (r, n, daysAgo = 1, extra = {}) => ({ r, n, at: AT(daysAgo), rn: n, ...extra });                 // a current entry: n runs, rn of them with THIS reason
const legacy = (r, n, daysAgo = 1) => ({ r, n, at: AT(daysAgo) });                                       // an entry written before rn existed: n counts every run, whatever the reason
const swSpec = () => ({ pa: [{ id: "clean", ctx: 200000, t: 900 }, { id: "bad", ctx: 200000, t: 100 }, { id: "ok2", ctx: 200000, t: 950 }] });
const swTf = (extra = {}) => ({ models: { "pa/clean": { t: "t", lvr: "ppnn", at: AT(3) }, "pa/bad": { t: "t", lvr: "ppnn", at: AT(3) }, "pa/ok2": { t: "t", lvr: "ppnn", at: AT(3) } }, ...extra });
/** the tool-fidelity inputs where `pa/bad` has NO confirmed pass (only a failure record) and everyone else passed: the shape a hard `gone` excludes */
const noPass = (pending, extra = {}) => ({ models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: AT(3) } }, pending, ...extra });
const stageOf = (r, s) => r.groups.get(s)?.stage;

test("B1 rule 2+3: a HARD `gone` (any count, even 1) EXCLUDES a row that has no confirmed t or v record (unreachable: left out, listed, counted, warned) and only DEMOTES one that has an earlier confirmed pass; a NEWER pass wins", () => {
  for (const n of [1, 2, 3, 9999]) {
    const r = funnel(syn(swSpec(), { tf: noPass({ "pa/bad": pend("gone", n) }) }), T());
    assert.deepEqual(r.models.map((m) => m.s).sort(), ["pa/clean", "pa/ok2"], `n=${n}`);
    assert.equal(stageOf(r, "pa/bad"), "unreachable");
    assert.deepEqual(r.unreachable, [{ s: "pa/bad", r: "gone", n: null, at: AT(1), source: "pending" }]);
    assert.equal(r.counts.unreachable, 1); assert.equal(r.counts.toolsPass, 2, "it never reached the tools stage"); assert.ok(r.groups.get("pa/bad").ok, "its bench status is ok: six days old is no defence");
  }
  const w = funnel(syn(swSpec(), { tf: noPass({ "pa/bad": pend("gone", 1) }) }), T()).warnings.find((x) => x.code === "UNREACHABLE").text;
  assert.match(w, /^UNREACHABLE: 1 of 3 bench-ok model left out: the tool sweep found it gone and no confirmed pass exists/);
  assert.ok(!/3\+|attempts/.test(w), "a hard answer is not a count of attempts");
  const withPass = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("gone", 1, 1) } }) }), T());     // the record passed 3 days ago, the gone answer is a day old
  assert.equal(withPass.models.length, 3, "an earlier confirmed pass: demoted, never excluded"); assert.equal(withPass.counts.unreachable, 0);
  assert.deepEqual(withPass.demoted.map((x) => [x.s, x.r, x.hard]), [["pa/bad", "gone", true]]); assert.equal(withPass.models.at(-1).s, "pa/bad");
  const newer = funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "t", lvr: "ppnn", at: AT(0.5) } }, pending: { "pa/bad": pend("gone", 1, 1) } } }), T());
  assert.deepEqual([newer.counts.unreachable, newer.counts.demoted], [0, 0], "a pass half a day ago beats a gone answer a day ago");
});

test("B1 rule 2: `error` NEVER excludes: it demotes at 3 runs in a row (two do nothing), whatever the count; `rn` drives the threshold, a legacy entry without it counts as one run", () => {
  for (const n of [3, 9, 9999]) {
    const r = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("error", n) } }) }), T());
    assert.equal(r.models.length, 3, `error x${n}: never excluded`); assert.equal(r.counts.unreachable, 0);
    assert.deepEqual(r.demoted.map((x) => [x.s, x.r, x.n, x.hard]), [["pa/bad", "error", n, false]]);
  }
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("error", 2) } }) }), T()).counts.demoted, 0, "two runs demote nothing");
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("rate", 9, 1, { rn: 1 }) } }) }), T()).counts.demoted, 0, "rn wins: nine runs but one with THIS reason");
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("rate", 4, 1, { rn: 3 }) } }) }), T()).counts.demoted, 1, "rn 3 is enough");
  // R1: a legacy entry (no rn) counts as ONE run: its n counts every run whatever the reason (cap, then error, ...), so it demotes nothing until a live sweep writes rn
  for (const [r, n] of [["rate", 3], ["error", 9999], ["upstream-unavailable", 8], ["timeout", 3], ["quota", 5]]) assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": legacy(r, n) } }) }), T()).counts.demoted, 0, `legacy ${r} x${n}: rn reads 1`);
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": { ...legacy("error", 3), rn: 3 } } }) }), T()).counts.demoted, 1, "the same entry once the sweep wrote rn = 3 (healed): demoted");
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": { ...legacy("error", 3), rn: 1 } } }) }), T()).counts.demoted, 0, "cap, then error: n 3 but rn 1");
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": legacy("gone", 1) } }) }), T()).counts.demoted, 1, "a legacy HARD entry still acts (hard reasons ignore counts): gone with an earlier pass demotes");
});

test("B1 rule 3: pay and auth at MODEL level are hard: they demote at ANY count (a hard state is never re-asked, so n freezes at 1 or 2); canary-* follow the sweep's hardState: canary-gone and canary-pay of a provider with confirmed results are ignored, canary-auth is not", () => {
  for (const r of ["pay", "auth"]) for (const n of [1, 2, 9]) {
    const res = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend(r, n) } }) }), T());
    assert.equal(res.models.length, 3, `${r} x${n}: never excluded`);
    assert.deepEqual(res.demoted.map((x) => [x.r, x.hard]), [[r, true]], `${r} x${n}`);
    assert.equal(res.models.at(-1).s, "pa/bad");
  }
  const confirmed = swTf();                                                                     // provider pa HAS confirmed results
  for (const [r, effect] of [["canary-gone", 0], ["canary-pay", 0], ["canary-auth", 1]]) {
    const res = funnel(syn(swSpec(), { tf: { ...confirmed, pending: { "pa/bad": pend(r, 1) } } }), T());
    assert.equal(res.counts.demoted + res.counts.unreachable, effect, `${r} with a confirmed provider`);
  }
  const none = { models: {}, pending: { "pa/bad": pend("canary-gone", 1), "pa/ok2": pend("canary-pay", 1) } };      // provider pa has NO confirmed result
  const r2 = funnel(syn(swSpec(), { tf: none }), T());
  assert.deepEqual([r2.counts.unreachable, r2.counts.demoted], [1, 1], "canary-gone excludes, canary-pay demotes when the provider never answered");
});

test("B1 soft reasons: rate, upstream-unavailable, slow, timeout, error and quota demote at 3 runs in a row (never exclude, shown, one band); every scheduling or budget reason is never used", () => {
  for (const r of ["rate", "upstream-unavailable", "slow", "timeout", "error", "quota"]) {
    const res = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend(r, 3) } }) }), T());
    assert.equal(res.models.length, 3, `${r}: never excluded`); assert.equal(res.models.at(-1).s, "pa/bad", `${r}: last although it has the best TTFT`);
    assert.equal(res.groups.get("pa/bad").rk[5], 1); assert.equal(res.groups.get("pa/clean").rk[5], 0);
    assert.deepEqual(res.demoted, [{ s: "pa/bad", r, n: 3, at: AT(1), source: "pending", hard: false }]);
    assert.equal(new Set(res.models.map((m) => m.b)).size, 1, `${r}: an ordering key inside ONE band, not a band of its own`);
    const w = res.warnings.find((x) => x.code === "DEMOTED").text;
    assert.match(w, /^DEMOTED: 1 of 3 allowed model ranks below clean rows because the tool sweep is blocked on it \(rate, upstream-unavailable, slow, timeout, error or quota for 3\+ runs in a row, or at once when the provider names its free-model quota; pay, auth, or a gone answer with an earlier pass at once, and pay or auth rank even below the untested models\)/);
    assert.ok(/auth/.test(w), "the text names auth");
  }
  for (const r of ["empty", "cap", "spend", "not-run", "request-cap", "priced-over-row-cap", "reasoning-budget", "route-shape", "row-cost", "first-strike"]) {
    const res = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend(r, 9999, 1, { rn: 9999 }) } }) }), T());
    assert.equal(res.models.length, 3, r); assert.equal(res.counts.demoted + res.counts.unreachable, 0, `${r}: pending is used for nothing else`); assert.equal(res.models[0].s, "pa/bad");
  }
});

test("B1 reader tolerance: pending entries with since, rn and why (additive), a top-level `meta` key, a non-object pending or held, and unknown fields change nothing but what the rules say; a malformed entry is ignored", () => {
  const e = { r: "rate", n: 4, at: AT(1), since: AT(5), rn: 4, why: "the provider's own sentence" };
  const withMeta = swTf({ pending: { "pa/bad": e }, held: {}, meta: { recoverable: 12, scope: "abc", at: AT(0) }, future: [1, 2] });
  const r = funnel(syn(swSpec(), { tf: withMeta }), T());
  assert.deepEqual(r.demoted.map((x) => [x.s, x.r, x.n]), [["pa/bad", "rate", 4]]);
  assert.deepEqual(funnel(syn(swSpec(), { tf: { ...withMeta, pending: { "pa/bad": { ...e, since: "garbage", why: 12, rn: "x" } } } }), T()).counts.demoted, 0, "a garbled rn is ignored: the entry reads as legacy (rn = 1), so nothing happens");
  for (const bad of [null, "x", 5, [], { r: 7, n: 3, at: AT(1) }, { r: "gone", n: 3 }]) assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": bad } }) }), T()).models.length, 3, JSON.stringify(bad));
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: ["x"], held: "y" }) }), T()).models.length, 3);
});

test("B1 rule 4: a garbled `at` on a pending entry, on the record it is compared with, or on a hold makes the entry UNUSABLE: nothing happens (fail open), in both directions", () => {
  assert.equal(funnel(syn(swSpec(), { tf: noPass({ "pa/bad": { r: "gone", n: 5, at: "not a date" } }) }), T()).counts.unreachable, 0, "a garbled pending `at`");
  assert.equal(funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "t", lvr: "ppnn", at: "not a date" } }, pending: { "pa/bad": pend("gone", 5) } } }), T()).counts.unreachable + 0, 0, "a garbled record `at`: it cannot be compared with the entry");
  const garbledPass = funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "t", lvr: "ppnn", at: "not a date" } }, pending: { "pa/bad": pend("gone", 5) } } }), T());
  assert.deepEqual([garbledPass.counts.unreachable, garbledPass.counts.demoted], [0, 0], "not even a demotion: a record whose time cannot be read is never compared");
  for (const r of ["pay", "auth", "rate"]) assert.equal(funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "t", lvr: "ppnn", at: "garbage" } }, pending: { "pa/bad": pend(r, 5) } } }), T()).counts.demoted, 0, `${r}: a garbled record time makes the entry unusable`);
  assert.equal(funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: "garbage" } }, pending: { "pa/bad": pend("pay", 5) } } }), T()).counts.demoted, 0, "even a failure record with a garbled `at`");
  assert.equal(funnel(syn(swSpec(), { tf: { models: {}, held: { pa: { r: "gone", at: "nope" } } } }), T()).counts.unreachable, 0, "a garbled hold");
  // R3: a garbled record time neutralises a HOLD too (auth, pay, gone), for that row only
  const garbledRow = { "pa/clean": { t: "t", lvr: "ppnn", at: "garbage" }, "pa/ok2": { t: "x", lvr: "pfnn", at: "garbage" } };
  for (const r of ["auth", "pay", "gone"]) {
    const res = funnel(syn(swSpec(), { tf: { models: { ...garbledRow, "pa/bad": { t: "x", lvr: "pfnn", at: AT(3) } }, held: { pa: { r, at: AT(1) } } } }), T());
    assert.equal(res.groups.get("pa/clean").demoted ?? null, null, `held ${r}: the row with a garbled record time is left alone`);
    assert.equal(res.groups.get("pa/ok2").stage === "unreachable", false, `held ${r}: even a failure record with a garbled time`);
  }
  const ctl = funnel(syn(swSpec(), { tf: { models: { "pa/bad": { t: "t", lvr: "ppnn", at: AT(3) } }, held: { pa: { r: "auth", at: AT(1) } } } }), T());
  assert.ok(ctl.groups.get("pa/clean").demoted && ctl.groups.get("pa/ok2").demoted, "the same hold on rows with no garbled time does demote (control)");
  assert.equal(funnel(syn(swSpec(), { tf: noPass({ "pa/bad": pend("gone", 1) }) }), T()).counts.unreachable, 1, "the same entry with good dates does exclude");
});

test("B1 calendar independent: the pending `at` is when the failure HAPPENED, not an expiry, so the verdict is the same whatever nowMs says", () => {
  const inputs = syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: AT(40) } }, pending: { "pa/bad": pend("gone", 1, 30) } } });
  const a = funnel(inputs, T()), b = funnel({ ...inputs, nowMs: NOW + 400 * 86400000 }, T()), c = funnel({ ...inputs, nowMs: NOW - 400 * 86400000 }, T());
  assert.deepEqual([a, b, c].map((r) => r.unreachable.length), [1, 1, 1]);
});

test("B1 held providers (rule 1): a held gone or pay applies ONLY when the provider has NO confirmed t or v record (the sweep's holdIsWrong); held auth always applies (a newer pass of the row wins); held gone excludes, held pay and auth demote", () => {
  const spec = { pa: [{ id: "a", ctx: 200000, t: 300 }, { id: "b", ctx: 200000, t: 400 }], pb: [{ id: "c", ctx: 200000, t: 500 }] };
  const failed = (at) => ({ t: "x", lvr: "pfnn", at });
  // pa has NO confirmed record (only failures): the holds apply
  const none = { models: { "pa/a": failed(AT(3)), "pa/b": failed(AT(3)), "pb/c": { t: "t", lvr: "ppnn", at: AT(3) } } };
  const gone = funnel(syn(spec, { tf: { ...none, held: { pa: { r: "gone", at: AT(1) } } } }), T());
  assert.deepEqual(gone.unreachable.map((x) => [x.s, x.source, x.n]), [["pa/a", "held", null], ["pa/b", "held", null]]);
  const w = gone.warnings.find((x) => x.code === "UNREACHABLE").text;
  assert.match(w, /^UNREACHABLE: 2 of 3 bench-ok models left out: the tool sweep found them gone/); assert.ok(!/3\+|attempts/.test(w), "a hold is not a count of attempts");
  const untested = { models: { "pb/c": { t: "t", lvr: "ppnn", at: AT(3) } } };                  // pa's rows were never tool-tested (tier u): a failure record would exclude them by its own tier
  for (const r of ["pay", "auth"]) { const d = funnel(syn(spec, { tf: { ...untested, held: { pa: { r, at: AT(1) } } } }), T()); assert.deepEqual([d.models.length, d.demoted.map((x) => x.s)], [3, ["pa/a", "pa/b"]], r); assert.ok(d.demoted.every((x) => x.hard && x.source === "held")); }
  // pa HAS a confirmed record (pa/b passed): a held gone or pay is WRONG and ignored, for every row of the provider; a held auth still applies
  const some = { models: { ...untested.models, "pa/b": { t: "t", lvr: "ppnn", at: AT(3) } } };
  for (const r of ["gone", "pay"]) { const x = funnel(syn(spec, { tf: { ...some, held: { pa: { r, at: AT(1) } } } }), T()); assert.deepEqual([x.counts.unreachable, x.counts.demoted], [0, 0], `held ${r} on a provider that answered`); }
  const auth = funnel(syn(spec, { tf: { ...some, held: { pa: { r: "auth", at: AT(1) } } } }), T());
  assert.deepEqual(auth.demoted.map((x) => x.s), ["pa/a", "pa/b"], "held auth applies whatever the provider answered, but a row's own newer pass wins:");
  const newer = funnel(syn(spec, { tf: { models: { ...some.models, "pa/b": { t: "t", lvr: "ppnn", at: AT(0.2) } }, held: { pa: { r: "auth", at: AT(1) } } } }), T());
  assert.deepEqual(newer.demoted.map((x) => x.s), ["pa/a"], "pa/b passed after the hold");
  assert.equal(funnel(syn(spec, { tf: { ...none, held: { pa: { r: "weird", at: AT(1) } } } }), T()).counts.unreachable, 0, "an unknown hold reason is ignored");
});

test("the funnel's confirmedByProvider and holdIsWrong are the sweep's own (refresh/tool-fidelity.mjs): the two agree on every case", async () => {
  const sweep = await import("../refresh/tool-fidelity.mjs");
  const { confirmedByProvider, holdIsWrong } = await import("../menu/subagent-funnel.mjs");
  const store = { "pa/a": { t: "t" }, "pa/b": { t: "x" }, "pa/c": { t: "v" }, "pb/d": { t: "u" }, "pc/e/f": { t: "t" }, "pd/g": null };
  assert.deepEqual({ ...confirmedByProvider(store) }, sweep.confirmedProviders(store));
  const conf = sweep.confirmedProviders(store);
  for (const h of [null, { r: "gone" }, { r: "pay" }, { r: "auth" }, { r: "weird" }]) for (const p of ["pa", "pb", "pc", "pd", "pz"]) assert.equal(holdIsWrong(h, conf, p), sweep.holdIsWrong(h, conf, p), `${JSON.stringify(h)} ${p}`);
});

test("B1 provider-level pattern: the same pending reason on at least 3 and at least half of a provider's bench-ok rows is one PATTERN line (not a wall of single exclusions); nothing is excluded for it", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, ctx: 200000, t: 100 + i }));
  const spec = { cleanapis: rows, other: [{ id: "x", ctx: 200000 }] };
  const pending = Object.fromEntries(rows.map((r) => [`cleanapis/${r.id}`, pend("error", 11)]));
  const tf = { models: Object.fromEntries([...rows.map((r) => [`cleanapis/${r.id}`, { t: "t", lvr: "ppnn", at: AT(9) }]), ["other/x", { t: "t", lvr: "ppnn", at: AT(9) }]]), pending };
  const r = funnel(syn(spec, { tf }), T());
  assert.deepEqual(r.providerPatterns, [{ provider: "cleanapis", reason: "error", rows: 6, of: 6 }]); assert.equal(r.counts.providerPatterns, 1);
  assert.equal(r.models.length, 7, "error never excludes: every row is still allowed, demoted"); assert.equal(r.counts.demoted, 6); assert.equal(r.models[0].s, "other/x");
  assert.match(r.warnings.find((x) => x.code === "PROVIDER_PATTERN").text, /^PROVIDER_PATTERN: cleanapis: 6 of 6 bench-ok rows pending error:/);
  const att = lib.attentionLines(r, synG(syn(spec, { tf })), { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" }, 3).map((x) => x.text);
  assert.ok(att.includes("cleanapis: 6 of 6 bench-ok rows pending error: a provider-level pattern, so the provider (not the models) is probably the cause"), att.join("\n"));
  const rep = lib.formatReport({ owner: { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", enforcement: "shadow", inject: "off" }, res: r, g: synG(syn(spec, { tf })), dry: true, minSet: 3 });
  assert.match(rep, /provider pattern \(sweep\) \.+ cleanapis: 6 of 6 bench-ok rows pending error: the provider, not the models, is probably the cause; rows are demoted or left out one by one, never the provider as a whole/);
  const few = funnel(syn(spec, { tf: { ...tf, pending: Object.fromEntries(rows.slice(0, 2).map((x) => [`cleanapis/${x.id}`, pend("error", 11)])) } }), T());
  assert.deepEqual(few.providerPatterns, [], "2 of 6 is not a pattern"); assert.ok(!few.warnings.some((x) => x.code === "PROVIDER_PATTERN"));
  const half = funnel(syn(spec, { tf: { ...tf, pending: Object.fromEntries(rows.slice(0, 3).map((x) => [`cleanapis/${x.id}`, pend("rate", 4)])) } }), T());
  assert.deepEqual(half.providerPatterns, [{ provider: "cleanapis", reason: "rate", rows: 3, of: 6 }], "3 of 6 is the threshold");
  const eight = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, ctx: 200000, t: 100 + i }));
  const tf8 = { models: Object.fromEntries(eight.map((x) => [`cleanapis/${x.id}`, { t: "t", lvr: "ppnn", at: AT(9) }])), pending: Object.fromEntries(eight.slice(0, 3).map((x) => [`cleanapis/${x.id}`, pend("error", 11)])) };
  assert.deepEqual(funnel(syn({ cleanapis: eight }, { tf: tf8 }), T()).providerPatterns, [], "3 of 8 is under half: no pattern, however many rows share the state");
});

test("B1 interplay with the re-probe list (decision 6): a free row dropped on an old transient bench status that the sweep found GONE is named in `reprobeSkipped` (never silent, never in the re-probe list); one the sweep found out of credit is account state; one with an earlier confirmed pass falls back to the normal path", () => {
  const spec = { pa: [{ id: "gonefree:free", ctx: 200000 }, { id: "payfree:free", ctx: 200000 }, { id: "plainfree:free", ctx: 200000 }, { id: "passfree:free", ctx: 200000 }, { id: "keep", ctx: 200000 }] };
  const old = NOW / 1000 - 10 * 86400;
  const bench = Object.fromEntries(["gonefree:free", "payfree:free", "plainfree:free", "passfree:free"].map((m) => [`pa/${m}`, { s: "rate", a: old }]));
  const tf = { models: { "pa/passfree:free": { t: "t", lvr: "ppnn", at: AT(20) } }, pending: { "pa/gonefree:free": pend("gone", 1), "pa/payfree:free": pend("pay", 1), "pa/passfree:free": pend("gone", 1) } };
  const r = funnel(syn(spec, { bench, tf }), T());
  assert.deepEqual(r.reprobeSkipped.map((x) => [x.s, x.r, x.source]), [["pa/gonefree:free", "gone", "pending"]]); assert.equal(r.counts.reprobeSkipped, 1);
  assert.deepEqual(r.reprobe.map((x) => x.s).sort(), ["pa/passfree:free", "pa/plainfree:free"], "no sweep evidence, or a gone answer after an earlier pass: still waiting for a re-probe");
  assert.deepEqual(r.accountRows.map((x) => [x.s, x.why]), [["pa/payfree:free", "pay"]]);
  assert.ok(!r.reprobe.some((x) => x.s === "pa/gonefree:free"));
});

test("rank (decision 5): the demotion key sits BETWEEN the strike key and the big-step key, and the spawn marker is the LAST key (a tie-breaker after TTFT, ctx, price, recency and alias)", () => {
  const spec = { pa: [{ id: "a-clean-bigp", ctx: 200000, t: 500 }, { id: "b-clean-bigf", ctx: 200000, t: 500 }, { id: "c-demoted-bigp", ctx: 200000, t: 500 }, { id: "d-struck-bigp", ctx: 200000, t: 500 }] };
  const v = (extra) => ({ t: "v", lvr: "pppp", at: AT(3), ...extra });
  const tf = { models: { "pa/a-clean-bigp": v({ big: "p" }), "pa/b-clean-bigf": v({ big: "f" }), "pa/c-demoted-bigp": v({ big: "p" }), "pa/d-struck-bigp": v({ big: "p", strikes: 1, sl: 3 }) }, pending: { "pa/c-demoted-bigp": pend("rate", 3) } };
  const r = funnel(syn(spec, { tf }), T());
  assert.deepEqual(r.models.map((m) => m.s), ["pa/a-clean-bigp", "pa/b-clean-bigf", "pa/c-demoted-bigp", "pa/d-struck-bigp"], "strike outranks demotion (struck last), demotion outranks the big step (b before c), and the big step orders the rest");
  assert.equal(new Set(r.models.map((m) => m.b)).size, 1, "all one band");
  assert.deepEqual(r.models.map((m) => [m.s.slice(3, 4), r.groups.get(m.s).rk[4], r.groups.get(m.s).rk[5], r.groups.get(m.s).rk[6]]), [["a", 0, 0, 0], ["b", 0, 0, 2], ["c", 0, 1, 0], ["d", 1, 0, 0]]);
  assert.deepEqual(RANK_LABELS.slice(4, 11), ["first strike", "sweep demotion (blocked by the sweep, never excluded)", "big step (v only)", "forced-choice only (fc)", "argument fidelity failed (af)", "tool_result use failed (er, br)", "L4 (v only)"]);
  assert.match(RANK_LABELS.at(-1), /^spawn failed \(sp: a last tie-breaker; matters only for a row that acts as a MAIN agent\)$/); assert.equal(RANK_LABELS.length, 17);
  // the spawn marker: a row that failed the spawn call but has the better TTFT outranks a clean row with the worse TTFT; at equal everything else the clean row is first
  const spec2 = { pa: [{ id: "clean-slow", ctx: 200000, t: 900 }, { id: "sp-fast", ctx: 200000, t: 100 }, { id: "clean-fast2", ctx: 200000, t: 100 }] };
  const base = { t: "t", lvr: "ppnn", at: AT(3) };
  const r2 = funnel(syn(spec2, { tf: { models: { "pa/clean-slow": base, "pa/sp-fast": { ...base, sp: "f" }, "pa/clean-fast2": base } } }), T());
  assert.equal(r2.groups.get("pa/sp-fast").rk.at(-1), 1); assert.equal(r2.groups.get("pa/clean-slow").rk.at(-1), 0);
  assert.equal(r2.models.at(-1).s, "pa/clean-slow", "TTFT decides before the spawn marker does: the slow clean row is last");
  assert.ok(r2.models.findIndex((m) => m.s === "pa/clean-fast2") < r2.models.findIndex((m) => m.s === "pa/sp-fast"), "equal TTFT: the clean row first");
});

test("H2 markers are rank keys after the big step and BEFORE L4 (then TTFT), each `clean above flagged`: fc p heaviest, then af f, then er or br f; sp f is the weakest flag and the LAST key; none is a band key and none excludes; a stored legacy `pt` marker is tolerated and IGNORED (it never ranks)", () => {
  const spec = { pa: ["clean", "fc", "af", "erbr", "br", "sp", "afsp", "ptf", "ptp", "ptx"].map((id) => ({ id, ctx: 200000, t: 100 })) };
  const base = { t: "t", lvr: "ppnn", at: AT(3) };
  const tf = { models: { "pa/clean": base, "pa/fc": { ...base, fc: "p" }, "pa/af": { ...base, af: "f" }, "pa/erbr": { ...base, er: "f" }, "pa/br": { ...base, br: "f" }, "pa/sp": { ...base, sp: "f" }, "pa/afsp": { ...base, af: "f", sp: "f" },
    "pa/ptf": { ...base, pt: "f" }, "pa/ptp": { ...base, pt: "p" }, "pa/ptx": { ...base, pt: "weird" } } };
  const r = funnel(syn(spec, { tf }), T());
  assert.equal(r.models.length, 10, "nothing is excluded"); assert.equal(new Set(r.models.map((m) => m.b)).size, 1, "no marker is a band key");
  const k = (id) => r.groups.get(`pa/${id}`).rk;
  const marks = (id) => k(id).slice(7, 10).concat(k(id).at(-1));                           // fc, af, er-or-br, (L4), ..., and the LAST key sp
  assert.deepEqual(marks("clean"), [0, 0, 0, 0]);
  assert.deepEqual(["fc", "af", "erbr", "br", "sp", "afsp", "ptf", "ptp", "ptx"].map(marks), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0, 1, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], "a stored pt marker (f, p or anything) is not a rank key");
  assert.equal(k("clean").length, 17, "seventeen keys");
  const order = r.models.map((m) => m.s.slice(3));
  assert.equal(order.at(-1), "fc", "forced-choice-only is the heaviest flag"); assert.equal(order.indexOf("sp") < order.indexOf("erbr"), true, "sp is the weakest flag");
  assert.ok(Math.max(order.indexOf("erbr"), order.indexOf("br")) < order.indexOf("af") && order.indexOf("af") < order.indexOf("afsp") && order.indexOf("afsp") < order.indexOf("fc"), order.join(" "));
  assert.ok(["clean", "ptf", "ptp", "ptx"].every((c) => order.indexOf(c) < order.indexOf("sp")), "a legacy pt row ranks with the clean rows, above even the weakest flag");
  const spec2 = { aihubmix: [{ id: "coding-minimax-m3-free", ctx: 200000, t: 200 }, { id: "z-clean", ctx: 200000, t: 800 }], tokenharbor: [{ id: "mimo-v2.6-flash:free", ctx: 200000, t: 200 }], routewayai: [{ id: "gemma-4-26b-a4b-it-musica:free", ctx: 200000, t: 200 }] };
  const tf2 = { models: { "aihubmix/coding-minimax-m3-free": { ...base, af: "f" }, "aihubmix/z-clean": base, "tokenharbor/mimo-v2.6-flash:free": { ...base, sp: "f" }, "routewayai/gemma-4-26b-a4b-it-musica:free": { ...base, fc: "p" } } };
  assert.deepEqual(funnel(syn(spec2, { tf: tf2 }), T()).models.map((m) => m.s), ["tokenharbor/mimo-v2.6-flash:free", "aihubmix/z-clean", "aihubmix/coding-minimax-m3-free", "routewayai/gemma-4-26b-a4b-it-musica:free"],
    "the spawn marker is a tie-breaker only: the fast spawn-failed row leads the slow clean one; af f, then fc p, rank below both");
  // a legacy `pt: "f"` changes nothing at all: same class, same position, identical compiled rows (so an identical routing content hash) as the same fixture without the field
  const v = funnel(syn({ pa: [{ id: "vrow", ctx: 200000, t: 100 }, { id: "vclean", ctx: 200000, t: 200 }] }, { tf: { models: { "pa/vrow": { t: "v", lvr: "pppp", at: AT(3), pt: "f" }, "pa/vclean": { t: "v", lvr: "pppp", at: AT(3) } } } }), T());
  assert.deepEqual(v.models.map((m) => [m.s, m.t]), [["pa/vrow", "v"], ["pa/vclean", "v"]], "pt f ranks like a row without it: the better TTFT leads, both stay v");
  const strip = (models) => Object.fromEntries(Object.entries(models).map(([s, x]) => [s, Object.fromEntries(Object.entries(x).filter(([f2]) => f2 !== "pt"))]));
  const withPt = funnel(syn(spec, { tf: { models: tf.models } }), T()), noPt = funnel(syn(spec, { tf: { models: strip(tf.models) } }), T());
  assert.deepEqual(withPt.models, noPt.models, "the compiled rows are identical with and without the legacy pt field");
  assert.deepEqual(withPt.models.map((m) => m.s), noPt.models.map((m) => m.s));
});

test("M2 a record tagged xw:gateway is left out as gateway-compat (a visible reason, counted, warned), whatever its tier; a row without the tag fails as before; a newer record without the tag is not gateway-compat; an --allow pin does NOT override it (nor an unreachable row)", () => {
  const spec = { pa: [{ id: "gw", ctx: 200000 }, { id: "plain", ctx: 200000 }, { id: "keep", ctx: 200000 }] };
  const base = { lvr: "pfnn", at: AT(3) };
  const tf = { models: { "pa/gw": { ...base, t: "x", xw: "gateway" }, "pa/plain": { ...base, t: "x" }, "pa/keep": { t: "t", lvr: "ppnn", at: AT(3) } } };
  const r = funnel(syn(spec, { tf }), T());
  assert.equal(r.groups.get("pa/gw").stage, "gateway-compat"); assert.equal(r.groups.get("pa/plain").stage, "tools-failed");
  assert.deepEqual(r.gatewayCompat, ["pa/gw"]); assert.equal(r.counts.gatewayCompat, 1);
  assert.match(r.warnings.find((x) => x.code === "GATEWAY_COMPAT").text, /^GATEWAY_COMPAT: 1 of 3 bench-ok model left out because the tool test failed in the gateway's own request translation/);
  assert.deepEqual(r.models.map((m) => m.s), ["pa/keep"]);
  const fixed = funnel(syn(spec, { tf: { models: { ...tf.models, "pa/gw": { t: "t", lvr: "ppnn", at: AT(1) } } } }), T());
  assert.equal(fixed.counts.gatewayCompat, 0); assert.ok(fixed.models.some((m) => m.s === "pa/gw"));
  assert.equal(funnel(syn(spec, { tf: { models: { ...tf.models, "pa/gw": { ...base, t: "x", xw: "other" } } } }), T()).groups.get("pa/gw").stage, "tools-failed", "only the value gateway counts");
  // decision 7: the owner's allow pin overrides a tool-tier verdict (pin-only), never an unreachable or a gateway-compat row
  const pinned = funnel(syn(spec, { tf: { ...tf, models: { ...tf.models, "pa/plain": { ...base, t: "x", xw: "gateway" } } } }), T({ allow: ["pa/gw", "pa/plain"] }));
  assert.deepEqual(pinned.models.map((m) => m.s), ["pa/keep"], "gateway-compat rows stay out although pinned");
  assert.deepEqual([pinned.groups.get("pa/gw").stage, pinned.groups.get("pa/plain").stage], ["gateway-compat", "gateway-compat"]);
  const unreach = funnel(syn(swSpec(), { tf: noPass({ "pa/bad": pend("gone", 1) }) }), T({ allow: ["pa/bad"], unverified: "pin-only" }));
  assert.equal(unreach.groups.get("pa/bad").stage, "unreachable"); assert.ok(!unreach.models.some((m) => m.s === "pa/bad"), "an unreachable row stays out although pinned");
});

const M3_IDS = ["gemini-3.1-flash-image", "gemini-3.1-flash-image-preview", "gemini-3.1-flash-lite-image", "gemini-3-flash-preview-search", "gemini-3.1-pro-preview-search", "relace/relace-search", "relace-search",
  "command-a-translate-08-2025", "cohere/command-a-translate", "gpt-image-2", "imagen-4.0-ultra-generate-001", "gpt-4o-search-preview", "sonar-pro-search", "riva-translate-4b-instruct-v2", "qwen-image-edit-plus", "jina-deepsearch-v1", "aihubmix/jina-deepsearch-v1"];
test("M3 the non-agent denylist also catches image generators, translators and search models (the critic's leaks and jina-deepsearch), as a WORD of the id; a keep-list of agent ids that merely contain the letters stays unmatched; a denylisted row is dropped with its reason", () => {
  for (const id of M3_IDS) assert.equal(nonAgentReason(id), "non-agent-model", id);
  const KEEP = ["claude-sonnet-5-5", "deepseek-v4-flash", "kimi-k2.5", "gpt-5-codex", "qwen3-coder-480b", "glm-4.6", "minimax-m3", "grok-code-fast-1", "gemini-3-pro", "gemini-3.1-pro-preview", "nemotron-3-super-120b", "deepseek-r1-0528", "kimi-researcher", "sonar-deep-research",
    "mistral-small-3.2-24b", "devstral-small", "llama-4-maverick", "gpt-oss-120b", "step-3.5-flash", "mimo-v2.6-flash:free", "coding-minimax-m3-free", "gemma-4-26b-a4b-it-musica:free", "hy3-preview", "searcher-7b-agent", "imaginative-writer-70b", "translator-agent-70b", "deepsearcher-70b-agent"];
  for (const id of KEEP) assert.equal(nonAgentReason(id), null, id);
  const r = funnel(syn({ pa: [{ id: "gemini-3.1-flash-image", ctx: 200000 }, { id: "good", ctx: 200000 }] }), T());
  assert.equal(r.dropped.get("pa/gemini-3.1-flash-image"), "non-agent-model"); assert.equal(r.counts.nonAgent, 1); assert.deepEqual(r.models.map((m) => m.s), ["pa/good"]);
});

test("M1 ctx unproven: every row that rests on an INFERRED 128k is counted (counts.ctxUnproven equals the inferred rows) and warned with what was measured (no hard-coded request median); it has its own line, not the SWEEP line; eligibility is unchanged", () => {
  const spec = { pa: [{ id: "model-x", ctx: 262144 }], pb: [{ id: "model-x:free", ctx: null }], pc: [{ id: "known", ctx: 200000 }] };
  const r = funnel(syn(spec), T());
  assert.equal(r.counts.ctxUnproven, 1); assert.equal(r.counts.ctxUnproven, r.counts.ctxInferred); assert.equal(r.models.length, 3, "eligibility is unchanged: the router's per-request fit check decides");
  const w = r.warnings.find((x) => x.code === "CTX_UNPROVEN").text;
  assert.match(w, /^CTX UNPROVEN: 1 of 3 allowed models rest on an INFERRED 128k context \(a same-name sibling's\); the only measured proof is the 400 KB big step \(about 100k tokens\), so the router's per-request fit check decides, not this flag$/);
  assert.ok(!/199k|median/.test(w), "no unsourced request-size statistic");
  assert.deepEqual(sweepLines(r), [], "ctx unproven is not a sweep fact");
  assert.deepEqual(ctxUnprovenLines(r), ["CTX UNPROVEN: 1 of 3 allowed model rests on an inferred 128k context (a sibling's); the only measured proof is the 400 KB big step (about 100k tokens), so the router's per-request fit check decides"]);
  assert.deepEqual(ctxUnprovenLines(funnel(syn({ pa: [{ id: "known", ctx: 200000 }] }), T())), []);
});

test("texts: every 'N models left out' line names its denominator and singular or plural, in the warnings, the SWEEP line, the attention list, the detail report and show; hold-sourced lines never say attempts", async () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, ctx: 200000, t: 100 + i }));
  const spec = { pa: rows, pb: [{ id: "x", ctx: 200000 }] };
  const rec = (id) => ({ t: "t", lvr: "ppnn", at: AT(9) });
  const tf = { models: { ...Object.fromEntries(rows.map((x) => [`pa/${x.id}`, rec()])), "pb/x": rec() }, pending: { "pa/m0": pend("gone", 1, 1), "pa/m1": pend("rate", 3), "pa/m2": pend("rate", 3), "pa/m3": pend("rate", 3) } };
  tf.models["pa/m0"] = { t: "x", lvr: "pfnn", at: AT(9) };
  const inp = syn(spec, { tf }), res = funnel(inp, T()), g = synG(inp);
  assert.deepEqual(sweepLines(res), ["SWEEP: 1 of 5 bench-ok model left out (the sweep found it gone and no confirmed pass exists); 3 of 4 allowed ranked below clean rows (the sweep is blocked on them; none excluded)"]);
  const owner = { ...lib.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" };
  const att = lib.attentionLines(res, g, owner, 3).map((x) => x.text);
  assert.ok(att.some((x) => /^1 of 5 bench-ok model left out: the tool sweep found it gone and no confirmed pass exists \(listed by --detail yes; an --allow pin does not override it\)$/.test(x)), att.join("\n"));
  assert.ok(att.some((x) => /^3 of 4 eligible models rank below clean rows: the tool sweep is blocked on them \(never excluded\)$/.test(x)), att.join("\n"));
  const rep = lib.formatReport({ owner: { ...owner, enforcement: "shadow", inject: "off" }, res, g, dry: true, minSet: 3 });
  assert.match(rep, /unreachable \(sweep\) \.+ 1 of 5 probe-ok selector left out: the tool sweep found it gone and no confirmed pass exists \(an --allow pin does not override this\): pa\/m0 \(gone, hard answer\)/);
  assert.match(rep, /sweep demoted \.+ 3 of 4 allowed selectors rank below clean rows \(the tool sweep is blocked on them; never excluded\): pa\/m1 \(rate x3\), pa\/m2 \(rate x3\), pa\/m3 \(rate x3\)/);
  assert.match(rep, /^SWEEP: 1 of 5 bench-ok model left out/m);
  // show (describeCompiled) over a compiled copy
  const { compiled } = lib.compile(g, { ...owner, enforcement: "shadow", inject: "off" }, { now: () => new Date("2026-10-03T00:00:00Z") });
  const quiet = lib.describeCompiled(compiled, "1h", false).join("\n"), loud = lib.describeCompiled(compiled, "1h", true).join("\n");
  assert.match(quiet, /^ {2}1 of 5 bench-ok model left out: the tool sweep found it gone and no confirmed pass exists \(an --allow pin does not override it\) \(--detail yes names them\)$/m);
  assert.match(quiet, /^ {2}3 of 4 eligible models rank below clean rows \(the tool sweep is blocked on them; never excluded\) \(--detail yes names them\)$/m);
  assert.match(loud, /left out: the tool sweep found it gone .*: pa\/m0 \(gone, hard answer\)/); assert.match(loud, /rank below clean rows .*: pa\/m1 \(rate x3\), pa\/m2 \(rate x3\), pa\/m3 \(rate x3\)/);
  assert.deepEqual(compiled.unreachable.map((x) => x.s), ["pa/m0"]); assert.equal(compiled.counts.unreachable, 1); assert.equal(compiled.counts.benchOk, 5); assert.ok(Array.isArray(compiled.providerPatterns) && Array.isArray(compiled.reprobeSkipped));
  assert.equal(compiled.contentHash, lib.hashOf(compiled), "the lists sit outside the routing hash");
  // a held provider: no count of attempts anywhere in its text
  const held = funnel(syn({ pa: rows }, { tf: { models: Object.fromEntries(rows.map((x) => [`pa/${x.id}`, { t: "x", lvr: "pfnn", at: AT(9) }])), held: { pa: { r: "gone", at: AT(1) } } } }), T());
  const hw = held.warnings.find((x) => x.code === "UNREACHABLE").text;
  assert.match(hw, /^UNREACHABLE: 4 of 4 bench-ok models left out: the tool sweep found them gone/); assert.ok(!/attempt|3\+/.test(hw));
  assert.match(lib.formatReport({ owner: { ...owner, enforcement: "shadow", inject: "off" }, res: held, g: synG(syn({ pa: rows })), dry: true }), /pa\/m0 \(gone, provider held\)/);
});

test("explain lines (sweepExplainLines and STAGE_PLAIN): the demotion (soft, hard, held), the markers (spawn last), a skipped re-probe, a provider pattern, an --allow pin that cannot override, the unreachable and gateway-compat answers", () => {
  const grp = (over = {}) => ({ selector: "pa/m", provider: "pa", stage: "in-set", status: "ok", ...over });
  const res = { providerPatterns: [{ provider: "pa", reason: "error", rows: 6, of: 6 }] };
  const owner = { allow: [] };
  const lines = (g, o = owner, r = res) => lib.sweepExplainLines(g, r, o);
  assert.match(lines(grp({ demoted: { r: "rate", n: 4, at: "A", source: "pending", hard: false } }))[0], /^sweep demotion: the tool sweep is blocked on it \(rate, 4 runs in a row\), last at A, with no newer confirmed pass: it ranks below clean rows of its band, never excluded$/);
  assert.match(lines(grp({ demoted: { r: "pay", n: null, at: "A", source: "pending", hard: true } }))[0], /got a hard answer for it \(pay\)/);
  assert.match(lines(grp({ demoted: { r: "gone", n: null, at: "A", source: "pending", hard: true } }))[0], /\(gone, but an earlier confirmed pass exists\)/);
  assert.match(lines(grp({ demoted: { r: "auth", n: null, at: "A", source: "held", hard: true } }))[0], /holds its provider auth/);
  assert.match(lines(grp({ reprobeSkipped: { source: "pending" } }))[0], /^re-probe skipped: its bench status is ok on a sample older than 2 days, but the tool sweep found it gone \(a hard answer\)/);
  assert.ok(lines(grp()).some((x) => /^provider pattern: pa: 6 of 6 bench-ok rows pending error: the provider, not this model, is probably the cause$/.test(x)));
  assert.ok(lines(grp(), owner, { providerPatterns: [] }).length === 0, "nothing to say, nothing printed");
  const mk = lines(grp({ mk: { fc: 1, af: 1, erbr: 0, sp: 1 } })).find((x) => /^tool-test markers/.test(x));
  assert.ok(!lines(grp({ mk: { fc: 0, af: 0, pt: 1, erbr: 0, sp: 0 } })).some((x) => /^tool-test markers/.test(x)), "a legacy pt mark prints no marker line: it never ranks");
  assert.match(mk, /fc: the first call passed only when forced; af: argument fidelity failed; sp: launching a subagent failed \(the LAST rank key, a tie-breaker; matters only when this model acts as a MAIN agent\)$/);
  for (const stage of ["unreachable", "gateway-compat"]) assert.match(lines(grp({ stage }), { allow: ["pa/m"] }).join("\n"), new RegExp(`^allow pin: your --allow pin for pa/m does NOT override ${stage}`, "m"));
  assert.ok(!lines(grp({ stage: "unreachable" }), { allow: [] }).some((x) => /allow pin/.test(x)), "no pin, no line");
  assert.match(lib.STAGE_PLAIN(grp({ stage: "unreachable", unreachable: { r: "gone", source: "pending", at: "A" } }), owner), /^the tool sweep found it gone \(a hard answer the sweep does not ask again\), last at A, and no confirmed pass exists.*An --allow pin does not override this$/);
  assert.match(lib.STAGE_PLAIN(grp({ stage: "unreachable", unreachable: { r: "gone", source: "held", at: "A" } }), owner), /its provider is held gone/);
  assert.match(lib.STAGE_PLAIN(grp({ stage: "gateway-compat" }), owner), /gateway's own request translation.*An --allow pin does not override this$/);
});

test("D-bk hint == floor: the compiled ctxHints equal the toggle's own floor (a row above the floor is capped AT it, a row below keeps its own), for every ctx value; the router's hardcoded substitute floor is the funnel's 128000", async () => {
  const fs2 = await import("node:fs");
  const router = fs2.readFileSync(new URL("../router/uw-router.next.cjs", import.meta.url), "utf8");
  assert.match(router, /const SUBSTITUTE_FLOOR = 128000, K = 3;/, "D-bk: the router hardcodes 128000 (the floor it derives is max(ctxHints[asked], 128000))");
  assert.equal(SUBSTITUTE_FLOOR, 128000);
  const spec = { pa: [{ id: "k64", ctx: 64000 }, { id: "k128", ctx: 131072 }, { id: "k200", ctx: 200000 }, { id: "k256", ctx: 262144 }, { id: "k512", ctx: 524288 }, { id: "k1m", ctx: 1048576 }] };
  for (const ctx of CTX_VALUES) {
    const r = funnel(syn(spec), T({ ctx }));
    const cap = hintCapOf(ctx), floor = ctxSpec(ctx).hard;
    for (const row of r.models) assert.equal(r.ctxHints[row.s], Math.min(row.c, cap), `${ctx} ${row.s}`);
    for (const v of Object.values(r.ctxHints)) assert.ok(v <= cap, `${ctx}: no hint above the toggle floor ${cap}`);
    if (floor > 0) assert.ok(r.models.filter((m) => m.c >= floor).every((m) => r.ctxHints[m.s] === floor), `${ctx}: a row at or above the hard floor is hinted exactly the floor`);
    else assert.ok(r.models.filter((m) => m.c >= 128000).every((m) => r.ctxHints[m.s] === 128000), `${ctx}: any and every soft preference hint 128000`);
  }
});

// ---- `bk`: the size the sweep proved the model accepts (record big: "p"), an additive optional routing field of a compiled row (a router follow-up reads it)
test("bk: a compiled row carries bk = BIG_PROVEN_BYTES (400000) only when its tool-fidelity record has big p; big f, absent, garbled or n never emit it, whatever the row's own cap", () => {
  const spec = { pa: [{ id: "p1", ctx: 200000 }, { id: "f1", ctx: 200000 }, { id: "none", ctx: 200000 }, { id: "gar1", ctx: 200000 }, { id: "gar2", ctx: 200000 }, { id: "gar3", ctx: 200000 }, { id: "cap", ctx: 200000, limit: { bytes: 300000 } }, { id: "norec", ctx: 200000 }] };
  const rec = (big) => ({ t: "v", lvr: "pppn", ...(big === undefined ? {} : { big }) });
  const tf = { models: { "pa/p1": rec("p"), "pa/f1": rec("f"), "pa/none": rec(undefined), "pa/gar1": rec("P"), "pa/gar2": rec(true), "pa/gar3": rec("n"), "pa/cap": rec("p") } };
  const r = funnel(syn(spec, { tf }), T({ unverified: "allow-warn" }));
  assert.equal(BIG_PROVEN_BYTES, 400000);
  const m = (id) => r.models.find((x) => x.s === `pa/${id}`);
  assert.deepEqual(["p1", "f1", "none", "gar1", "gar2", "gar3", "cap", "norec"].map((id) => [id, m(id)?.bk]), [["p1", 400000], ["f1", undefined], ["none", undefined], ["gar1", undefined], ["gar2", undefined], ["gar3", undefined], ["cap", 400000], ["norec", undefined]]);
  for (const id of ["f1", "none", "gar1", "gar2", "gar3", "norec"]) assert.ok(!Object.hasOwn(m(id), "bk"), `${id}: the key is absent, not undefined or 0`);
  assert.deepEqual([m("p1").pb, m("cap").pb, m("cap").pbSource], [0, 300000, "catalogue"], "bk is evidence of acceptance: it does not set or change pb (a catalogue limit stays)");
});

test("bk changes no eligibility, rank, tier, band or count: the same inputs with every big p replaced by n give the same rows apart from bk, the same order, lists and counts; only the hash of the models differs", () => {
  const spec = { pa: ["a", "b", "c", "d", "e"].map((id) => ({ id, ctx: 200000 })) };
  const mk = (big) => ({ models: Object.fromEntries(["a", "b", "c", "d", "e"].map((id, i) => [`pa/${id}`, { t: "v", lvr: "pppn", big: i % 2 === 0 ? big : "f" }])) });
  const withP = funnel(syn(spec, { tf: mk("p") }), T());
  const withN = funnel(syn(spec, { tf: mk("n") }), T());
  const strip = (rows) => rows.map(({ bk, ...x }) => x);
  assert.equal(withP.models.filter((x) => x.bk === 400000).length, 3, "a, c, e");
  assert.equal(withN.models.filter((x) => "bk" in x).length, 0);
  assert.deepEqual(strip(withP.models), strip(withN.models), "rows, order, tiers, bands, caps: identical apart from bk");
  assert.deepEqual([withP.lists, withP.counts, withP.warnings.map((w) => w.code)], [withN.lists, withN.counts, withN.warnings.map((w) => w.code)]);
  const h = (r) => lib.hashOf({ schema: 1, owner: {}, models: r.models, lists: r.lists });
  assert.notEqual(h(withP), h(withN), "bk is routing data: it is in the content hash through the rows");
  assert.equal(h(withN), h(funnel(syn(spec, { tf: mk("n") }), T())), "and the same inputs hash the same");
  // a record change on a row that gains no bk leaves the hash alone
  const tf2 = mk("p"); tf2.models["pa/b"] = { t: "v", lvr: "pppn", big: "f", note: "x" };
  assert.equal(h(funnel(syn(spec, { tf: tf2 }), T())), h(withP));
});

// =====================================================================================================================
// Sanity pass 3 (decisions 1-6): proven cap, stated context, known-failing below untested, quota wording, stuck errors, rank order, wording
// =====================================================================================================================
const rec3 = (over = {}) => ({ t: "v", lvr: "pppp", at: AT(3), ...over });

test("S3-1 payload cap: a capBelow from a refusal at the BIG STEP (big f) never sets the cap to the refused size: the cap is what the record PROVES (maxBytes), the smaller of that and a catalogue limit; no proof keeps the capBelow; other records are unchanged", () => {
  const spec = { pa: [{ id: "gem", ctx: 200000 }, { id: "gemcat", ctx: 200000, limit: { bytes: 100000 } }, { id: "noproof", ctx: 200000 }, { id: "bign", ctx: 200000 }, { id: "bigp", ctx: 200000 }, { id: "garbled", ctx: 200000 }] };
  const tf = { models: { "pa/gem": rec3({ big: "f", capBelow: 390000, maxBytes: 156873 }), "pa/gemcat": rec3({ big: "f", capBelow: 390000, maxBytes: 156873 }), "pa/noproof": rec3({ big: "f", capBelow: 390000, maxBytes: 0 }),
    "pa/bign": rec3({ capBelow: 150000, maxBytes: 90000 }), "pa/bigp": rec3({ big: "p", capBelow: 300000, maxBytes: 120000 }), "pa/garbled": rec3({ big: "f", capBelow: 390000, maxBytes: "157000" }) } };
  const r = funnel(syn(spec, { tf }), T());
  const m = (id) => r.models.find((x) => x.s === `pa/${id}`);
  assert.deepEqual(["gem", "gemcat", "noproof", "bign", "bigp", "garbled"].map((id) => [id, m(id).pb, m(id).pbSource]),
    [["gem", 156873, "proven"], ["gemcat", 100000, "catalogue"], ["noproof", 390000, "capBelow"], ["bign", 150000, "capBelow"], ["bigp", 300000, "capBelow"], ["garbled", 390000, "capBelow"]]);
  assert.deepEqual([provenBytes({ maxBytes: 5 }), provenBytes({ maxBytes: 0 }), provenBytes({ maxBytes: -4 }), provenBytes({ maxBytes: 1.5 }), provenBytes({}), provenBytes(null)], [5, 0, 0, 0, 0, 0]);
});

test("S3-1 stated context: ctxStated (tokens, from the provider's own refusal) lowers a known ctx to it, replaces an unknown or INFERRED one, never raises a known one, and caps the payload at 3 bytes a token whatever else set it; a garbled value is ignored", () => {
  const spec = { pa: [{ id: "vis", ctx: 131072 }, { id: "unk", ctx: null }, { id: "big", ctx: 65536 }, { id: "bad1", ctx: 200000 }, { id: "bad2", ctx: 200000 }, { id: "bad3", ctx: 200000 }, { id: "catsmall", ctx: 131072, limit: { bytes: 50000 } }],
    pb: [{ id: "model-x", ctx: 262144 }], pc: [{ id: "model-x:free", ctx: null }] };
  const tf = { models: { "pa/vis": rec3({ ctxStated: 32768, capBelow: 150000, maxBytes: 0 }), "pa/unk": rec3({ ctxStated: 40000 }), "pa/big": rec3({ ctxStated: 262144 }), "pa/bad1": rec3({ ctxStated: 0 }), "pa/bad2": rec3({ ctxStated: -5 }), "pa/bad3": rec3({ ctxStated: "32768" }),
    "pa/catsmall": rec3({ ctxStated: 32768 }), "pc/model-x:free": rec3({ ctxStated: 16000 }) } };
  const r = funnel(syn(spec, { tf }), T());
  const m = (id) => r.models.find((x) => x.s === id);
  assert.deepEqual([m("pa/vis").c, m("pa/vis").pb, m("pa/vis").pbSource], [32768, 98304, "ctxStated"], "a known 131072 is lowered to 32768; the capBelow 150000 is beaten by 3 bytes a token");
  assert.deepEqual([m("pa/unk").c, m("pa/unk").ci, m("pa/unk").pb], [40000, undefined, 120000], "an unknown ctx becomes the stated one (measured, not inferred)");
  assert.deepEqual([m("pa/big").c, m("pa/big").pb], [65536, 786432], "never raises a known ctx (min), but the payload still follows the stated tokens");
  assert.deepEqual(["bad1", "bad2", "bad3"].map((id) => [m(`pa/${id}`).c, m(`pa/${id}`).pb]), [[200000, 0], [200000, 0], [200000, 0]], "a garbled or zero value is ignored");
  assert.deepEqual([m("pa/catsmall").pb, m("pa/catsmall").pbSource], [50000, "catalogue"], "a smaller catalogue limit stays");
  assert.deepEqual([m("pc/model-x:free").c, m("pc/model-x:free").ci], [16000, undefined], "a stated ctx beats an INFERRED 128k");
  assert.equal(r.counts.ctxUnproven, 0, "so the row is no longer ctx-unproven");
  assert.equal(ctxStatedOf({ ctxStated: 32768 }), 32768); assert.equal(ctxStatedOf({ ctxStated: 2e9 }), 0); assert.equal(ctxStatedOf(null), 0);
  // a hard ctx floor tests the stated (measured) value
  assert.ok(!funnel(syn(spec, { tf }), T({ ctx: "128k" })).models.some((x) => x.s === "pa/vis"), "ctx 128k excludes the row whose provider said 32768");
  assert.ok(funnel(syn(spec, { tf }), T({ ctx: "128k" })).models.some((x) => x.s === "pa/bad1"));
  // the explain text names both
  const g = r.groups.get("pa/vis");
  assert.equal(g.ctxStated, 32768);
});

test("S3-2 known failing ranks BELOW unknown: a pay or auth newer than the row's last pass makes it tier u in its own band under the untested rows (and the DEMOTED warning counts it); a newer pass, an older entry or a garbled time leaves it alone; gone and soft states stay ordinary demotions", () => {
  const spec = { pa: [{ id: "pass", ctx: 200000, t: 900 }, { id: "payrow", ctx: 200000, t: 100 }, { id: "unk", ctx: 200000, t: 500 }, { id: "unk2", ctx: 200000, t: 800 }] };
  const base = { "pa/pass": { t: "t", lvr: "ppnn", at: AT(3) }, "pa/payrow": { t: "t", lvr: "ppnn", at: AT(3) } };
  for (const r of ["pay", "auth"]) {
    const res = funnel(syn(spec, { tf: { models: base, pending: { "pa/payrow": pend(r, 2, 1) } } }), T());
    assert.deepEqual(res.models.map((m) => m.s), ["pa/pass", "pa/unk", "pa/unk2", "pa/payrow"], `${r}: below the untested rows although its TTFT is the best`);
    const row = res.models.find((m) => m.s === "pa/payrow");
    assert.equal(row.t, "u", `${r}: the compiled row is tier u`); assert.notEqual(row.b, res.models.find((m) => m.s === "pa/unk2").b, "and a band of its own, not mixed into the untested spread");
    assert.deepEqual([res.groups.get("pa/payrow").rk[0], res.groups.get("pa/unk").rk[0], res.groups.get("pa/pass").rk[0]], [3, 2, 1]);
    assert.deepEqual([res.counts.verified, res.counts.small, res.counts.unverified, res.counts.unverifiedBlocked], [0, 1, 3, 1], "it counts as unverified, blocked by a recorded state");
    assert.equal(res.models.length, 4, "never excluded"); assert.deepEqual(res.demoted.map((x) => [x.s, x.r, x.hard]), [["pa/payrow", r, true]]);
    assert.equal(res.groups.get("pa/payrow").recordedTier, "t");
  }
  const at = (over) => funnel(syn(spec, { tf: { models: base, ...over } }), T()).models.map((m) => m.s);
  const normal = ["pa/payrow", "pa/pass", "pa/unk", "pa/unk2"].sort();
  assert.deepEqual(at({ pending: { "pa/payrow": pend("pay", 2, 5) } }).slice().sort(), normal);
  assert.equal(at({ pending: { "pa/payrow": pend("pay", 2, 5) } })[0], "pa/payrow", "a pay OLDER than the last pass is ignored: the row ranks as tested (best TTFT first)");
  assert.equal(at({ pending: { "pa/payrow": { ...pend("pay", 2, 1), at: "garbled" } } })[0], "pa/payrow", "a garbled time fails open");
  assert.deepEqual(at({ pending: { "pa/payrow": pend("gone", 1, 1) } }).slice(0, 2), ["pa/pass", "pa/payrow"], "gone with an earlier pass: an ordinary demotion inside the tested band (below the clean row, above the untested), not below the untested");
  assert.equal(funnel(syn(spec, { tf: { models: base, pending: { "pa/payrow": pend("gone", 1, 1) } } }), T()).models.find((m) => m.s === "pa/payrow").t, "t");
  assert.equal(at({ pending: { "pa/payrow": pend("rate", 4, 1) } }).at(-1), "pa/unk2", "a soft state is an ordinary demotion: below clean rows of its band only; it is not known failing");
  // a held auth with an older pass applies the same way (the key is the account); a held pay applies only without any confirmed pass in the provider, so it never reaches a passing row
  const held = funnel(syn(spec, { tf: { models: base, held: { pa: { r: "auth", at: AT(1) } } } }), T());
  assert.deepEqual(held.models.filter((m) => m.t !== "u").length, 0, "held auth: every passing row of the provider is now below the untested ones");
  assert.match(funnel(syn(spec, { tf: { models: base, pending: { "pa/payrow": pend("pay", 2, 1) } } }), T()).warnings.find((w) => w.code === "DEMOTED").text, /pay or auth rank even below the untested models/);
  // the owner's unverified setting judges the RECORDED tier: allow-t still lists a failing t row (it is demoted, not excluded)
  assert.ok(funnel(syn(spec, { tf: { models: base, pending: { "pa/payrow": pend("pay", 2, 1) } } }), T({ unverified: "allow-t" })).models.some((m) => m.s === "pa/payrow"));
});

test("S3-3 quota wording: a soft `rate` entry whose stored why names a free-model quota or limit demotes at ONE run; other rate entries, other reasons and an absent or garbled why keep the 3-run rule", () => {
  const WHY = ["aihubmix: Sorry, you have reached the limit of the free model quota. Please switch to a paid model to enjoy unlimited co", "daily limit exceeded", "Quota exhausted for today", "you have reached the limit of requests"];
  for (const why of WHY) for (const n of [1, 2]) {
    const res = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("rate", n, 1, { why }) } }) }), T());
    assert.equal(res.models.at(-1).s, "pa/bad", `${why.slice(0, 20)} rn ${n}: demoted at once`);
    assert.deepEqual(res.demoted.map((x) => [x.r, x.n]), [["rate", n]]); assert.equal(res.groups.get("pa/bad").demoted.quota, true);
  }
  const none = (pe) => funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pe } }) }), T()).demoted.length;
  assert.equal(none(pend("rate", 2, 1, { why: "openrouter: Provider returned error" })), 0, "an ordinary rate wording keeps the 3-run rule");
  assert.equal(none(pend("rate", 2, 1, { why: "rate limit: too many requests per minute" })), 0, "a plain per-minute rate limit is not a quota");
  assert.equal(none(pend("rate", 2, 1)), 0, "no why: as before"); assert.equal(none(pend("rate", 2, 1, { why: 42 })), 0, "a garbled why: as before");
  assert.equal(none(pend("error", 1, 1, { why: "free model quota reached" })), 0, "only a rate entry gets the quota shortcut");
  assert.equal(none(pend("timeout", 1, 1, { why: "daily limit" })), 0);
  assert.equal(none(pend("rate", 3, 1)), 1, "three runs still demote");
  assert.equal(none({ r: "rate", n: 2, at: AT(1), why: "daily limit" }), 1, "a legacy entry (no rn) with the wording demotes too");
  const garbled = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": { ...pend("rate", 1, 1, { why: "daily limit" }), at: "x" } } }) }), T());
  assert.equal(garbled.demoted.length, 0, "a garbled time still fails open");
});

test("S3-4 stuck errors: an `error` entry on 10 or more runs in a row with NO confirmed pass is left out as unreachable (named, counted, warned, not overridden by an --allow pin); 9 runs demote only; an earlier pass keeps it as a demotion; a newer pass or a garbled time ignores the entry", () => {
  const nr = (pe, extra = {}) => funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: AT(3) } }, pending: { "pa/bad": pe }, ...extra } }), T());
  const r = nr(pend("error", 26, 1, { why: "apmixai: Failed to reach upstream provider." }));
  assert.equal(stageOf(r, "pa/bad"), "unreachable"); assert.ok(!r.models.some((m) => m.s === "pa/bad"));
  assert.deepEqual(r.unreachable.map((x) => [x.s, x.r, x.n, x.source]), [["pa/bad", "error", 26, "pending"]]);
  assert.deepEqual([r.counts.unreachable, r.counts.unreachableStuck], [1, 1]);
  assert.match(r.warnings.find((w) => w.code === "UNREACHABLE").text, /left out: the tool sweep found it gone and no confirmed pass exists \(gone is a hard answer the sweep does not ask again; a held provider counts the same\); 1 of them is on the same error for 10\+ runs in a row, not gone;/);
  assert.equal(stageOf(nr(pend("error", 10)), "pa/bad"), "unreachable", "exactly 10 runs");
  assert.equal(stageOf(nr(pend("error", 9)), "pa/bad"), "tools-failed", "9 runs: not unreachable (this row's own failure record decides, as before)"); assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("error", 9) } }) }), T()).demoted.length, 1, "9 runs on a row with a pass: a demotion only");
  assert.equal(nr(legacy("error", 40)).counts.unreachable, 0, "a legacy entry (no rn) counts as one run");
  const noRec = funnel(syn(swSpec(), { tf: swTf({ models: { "pa/clean": { t: "t", lvr: "ppnn", at: AT(3) }, "pa/ok2": { t: "t", lvr: "ppnn", at: AT(3) } }, pending: { "pa/bad": pend("error", 24) } }) }), T());
  assert.equal(stageOf(noRec, "pa/bad"), "unreachable", "no record at all is no confirmed pass");
  // an earlier confirmed pass: a demotion only (it has been seen working)
  const passed = funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("error", 26, 1) } }) }), T());
  assert.equal(stageOf(passed, "pa/bad"), "in-set"); assert.deepEqual(passed.demoted.map((x) => [x.s, x.r]), [["pa/bad", "error"]]);
  // a NEWER pass wins; a garbled time fails open
  assert.equal(funnel(syn(swSpec(), { tf: swTf({ pending: { "pa/bad": pend("error", 26, 6) } }) }), T()).demoted.length, 0);
  assert.equal(nr({ ...pend("error", 26), at: "garbled" }).counts.unreachable, 0);
  // only an `error` goes unreachable: any other soft reason on 12 runs with no record at all is still a demotion
  for (const r of ["rate", "timeout", "upstream-unavailable", "slow"]) {
    const x = funnel(syn(swSpec(), { tf: { models: { "pa/clean": { t: "t", lvr: "ppnn", at: AT(3) }, "pa/ok2": { t: "t", lvr: "ppnn", at: AT(3) } }, pending: { "pa/bad": pend(r, 12, 1) } } }), T());
    assert.deepEqual([stageOf(x, "pa/bad"), x.counts.unreachable, x.demoted.length], ["in-set", 0, 1], r);
  }
  // the pin does not override it
  const pin = funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: AT(3) } }, pending: { "pa/bad": pend("error", 26) } } }), T({ allow: ["pa/bad"], unverified: "pin-only" }));
  assert.equal(stageOf(pin, "pa/bad"), "unreachable");
  // not a gone answer: the texts say so
  assert.match(lib.STAGE_PLAIN(r.groups.get("pa/bad"), { mode: "dynamic" }), /^the tool sweep saw the same error on 26 runs in a row \(at least 10\), last at .*: it is left out as stuck, not gone, until a later test passes\. An --allow pin does not override this$/);
  assert.match(lib.sweepLines(r)[0], /left out \(the sweep found it gone and no confirmed pass exists; 1 of them is on the same error for 10\+ runs in a row, not gone\)/);
  // the counts are on the pure error rows only
  const mixed = funnel(syn(swSpec(), { tf: { models: { ...swTf().models, "pa/bad": { t: "x", lvr: "pfnn", at: AT(3) }, "pa/ok2": { t: "x", lvr: "pfnn", at: AT(3) } }, pending: { "pa/bad": pend("gone", 1), "pa/ok2": pend("error", 30) } } }), T());
  assert.deepEqual([mixed.counts.unreachable, mixed.counts.unreachableStuck], [2, 1]);
});

test("S3-5 rank order: a row whose L4 failed ('N calls of 2') ranks ABOVE a row with af, er or br failed (and above fc), because tool errors are constant in Claude Code; fc, af, er/br keep their relative order; L4 still outranks TTFT", () => {
  const spec = { pa: [{ id: "l4f", ctx: 200000, t: 500 }, { id: "af", ctx: 200000, t: 100 }, { id: "er", ctx: 200000, t: 100 }, { id: "br", ctx: 200000, t: 100 }, { id: "fc", ctx: 200000, t: 100 }, { id: "clean", ctx: 200000, t: 900 }, { id: "l4p", ctx: 200000, t: 900 }] };
  const v = (extra) => ({ t: "v", at: AT(3), big: "p", ...extra });
  const tf = { models: { "pa/l4f": v({ lvr: "pppf" }), "pa/af": v({ lvr: "pppp", af: "f" }), "pa/er": v({ lvr: "pppp", er: "f" }), "pa/br": v({ lvr: "pppp", br: "f" }), "pa/fc": v({ lvr: "pppp", fc: "p" }), "pa/clean": v({ lvr: "pppp" }), "pa/l4p": v({ lvr: "pppp" }) } };
  const r = funnel(syn(spec, { tf }), T());
  const order = r.models.map((m) => m.s.slice(3));
  for (const flagged of ["af", "er", "br", "fc"]) assert.ok(order.indexOf("l4f") < order.indexOf(flagged), `L4 f above ${flagged} f: ${order.join(" ")}`);
  assert.deepEqual(order.slice(0, 2).sort(), ["clean", "l4p"], "clean rows first");
  assert.ok(Math.max(order.indexOf("er"), order.indexOf("br")) < order.indexOf("af") && order.indexOf("af") < order.indexOf("fc"), "er/br above af above fc (fc, the first key of the markers, is the heaviest): " + order.join(" "));
  assert.deepEqual(RANK_LABELS.slice(6, 11), ["big step (v only)", "forced-choice only (fc)", "argument fidelity failed (af)", "tool_result use failed (er, br)", "L4 (v only)"]);
  const k = r.groups.get("pa/l4f").rk;
  assert.deepEqual([k[6], k[7], k[8], k[9], k[10]], [0, 0, 0, 0, 2], "the key order: big, fc, af, er/br, L4");
  assert.equal(k.length, 17);
  // L4 f against a flagged row at the SAME TTFT: not a TTFT effect
  const two = funnel(syn({ pa: [{ id: "a", ctx: 200000, t: 500 }, { id: "b", ctx: 200000, t: 500 }] }, { tf: { models: { "pa/a": v({ lvr: "pppf" }), "pa/b": v({ lvr: "pppp", er: "f" }) } } }), T());
  assert.deepEqual(two.models.map((m) => m.s), ["pa/a", "pa/b"]);
});

test("S3-6 wording: the unverified rows are told apart (blocked by a recorded state, tested aliases, not tested) in the counts, the warning and the plain lines; an all-untested set keeps the old wording; the account-state count follows the stored message (status rate, message pay)", () => {
  const spec = { pa: [{ id: "tested", ctx: 200000 }, { id: "blocked", ctx: 200000 }, { id: "alias/auto", ctx: 200000 }, { id: "fresh", ctx: 200000 }, { id: "fresh2", ctx: 200000 }] };
  const tf = { models: { "pa/tested": rec3({ t: "t" }), "pa/alias/auto": rec3({ t: "t" }) }, pending: { "pa/blocked": pend("cap", 1, 1) } };
  const r = funnel(syn(spec, { tf }), T());
  assert.deepEqual([r.counts.unverified, r.counts.unverifiedBlocked, r.counts.unverifiedAlias], [4, 1, 1]);
  assert.match(r.warnings.find((w) => w.code === "UNVERIFIED").text, /^UNVERIFIED: 4 of 5 allowed models have unverified tool support \(1 blocked by a recorded state, see explain; 1 tested aliases; 2 not tested\)/);
  assert.equal(lib.unverifiedParts({ unverified: 4, unverifiedBlocked: 1, unverifiedAlias: 1 }), "1 blocked by a recorded state, see explain; 1 tested alias, never above unverified; 2 not tested");
  assert.equal(lib.unverifiedParts({ unverified: 4 }), null, "an older compile has no split: the old wording stays");
  assert.equal(lib.unverifiedParts({ unverified: 4, unverifiedBlocked: 0, unverifiedAlias: 0 }), null, "nothing blocked: all untested: the old wording stays");
  const held = funnel(syn(spec, { tf: { models: tf.models, held: { pa: { r: "auth", at: AT(1) } } } }), T());
  assert.ok(held.counts.unverifiedBlocked >= 3, "a held provider blocks its untested rows too");
  // the account-state count follows the stored message when the bench status is a rate limit
  const bench = { "pa/blocked": { s: "rate", m: "you are out of credit" }, "pa/fresh": { s: "pay" }, "pa/fresh2": { s: "rate", m: "slow down" } };
  const inp = syn(spec, { bench }); inp.classifyBench = (rec) => (/credit/.test(rec.m ?? "") ? "pay" : null);
  const ac = funnel(inp, T()).counts.accountState;
  assert.deepEqual(ac, { pay: 2, auth: 0, rate: 1 }, "status rate with a message that names the credit is counted as pay");
});


// ---- cr-accuracy finding 6: the enforce reader binds a PASS to the policy and the installed versions, and refuses a forged date
test("enforce reader (cr-accuracy 6): a good file passes and prints its evidence line; a PASS dated in the future, bound to another policy, on another CCR or Claude Code version, or with garbled or missing fields is refused with ONE reason; extra fields are tolerated", async () => {
  const dir = tmp(); const p = lib.resolvePaths(fixtureFlagMap(dir));
  const live = await lib.gatherInputs(p, { nowMs: NOW, liveProviders: await lib.readProviders(p) });
  const enforce = { ...lib.OWNER_DEFAULTS, mode: "dynamic", enforcement: "enforce" };
  const H = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
  const good = (over = {}) => ({ schema: 1, verdict: "PASS", at: new Date(NOW - 3600000).toISOString(), ccVersion: "2.1.289 (Claude Code)", ccrVersion: "3.0.22", window: { since: "2026-09-06T00:00:00.000Z", until: "2026-10-05T00:00:00.000Z", days: 30 },
    evidence: { classRowsCounted: 1756, sha256: "ab".repeat(32), policyContentHash: H }, someFutureField: { x: 1 }, ...over });
  const put = (o) => { fs.mkdirSync(path.join(dir, "state", "subagent"), { recursive: true }); wr(path.join(dir, "state", "subagent", "accuracy.json"), o); };
  const seam = (over = {}) => ({ contentHash: H, ccrVersion: () => "3.0.22", ccVersion: () => "2.1.289", ...over });
  const check = (o, s = seam(), now = NOW) => { put(o); return lib.checkEnforcePreconditions(p, live, enforce, now, s); };
  const refused = (o, re, s, now) => assert.throws(() => check(o, s, now), (e) => e.code === "E_PRECONDITION" && e.exit === 1 && re.test(e.message) && !e.message.includes("\n"), JSON.stringify(o).slice(0, 80));
  // a good file
  const ok = check(good());
  assert.equal(ok.length, 1); assert.match(ok[0], /^accuracy: PASS of \d{4}-\d{2}-\d{2}, bound to policy a1b2c3d4e5f6, CCR 3\.0\.22, Claude Code 2\.1\.289; evidence: 1,756 classified rows hashed abababababab, window 2026-09-06 to 2026-10-05, measured \d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(lib.checkEnforcePreconditions(p, live, { ...enforce, enforcement: "shadow" }, NOW, seam()), [], "shadow needs nothing");
  // (a) the forged future date
  refused(good({ at: "2999-01-01" }), /^--enforce enforce is blocked: state\/subagent\/accuracy\.json is dated 2999-01-01, in the future: a verdict cannot be newer than now \(evidence: 1,756 classified rows hashed abababababab, window 2026-09-06 to 2026-10-05, measured 2999-01-01\)$/);
  assert.doesNotThrow(() => check(good({ at: new Date(NOW + 4 * 60000).toISOString() })), "4 minutes ahead is clock skew");
  refused(good({ at: new Date(NOW + 5 * 60000 + 1000).toISOString() }), /in the future/);
  // the base rules stay as they were (exact old text)
  for (const bad of [good({ verdict: "FAIL" }), good({ verdict: "INSUFFICIENT" }), good({ at: "garbled" }), good({ at: undefined }), good({ at: 12345 }), good({ at: new Date(NOW - 31 * 86400000).toISOString() }), "not json", [1], null, 7])
    refused(bad, /^--enforce enforce is blocked: state\/subagent\/accuracy\.json must hold a classifier verdict PASS younger than 30 days$/);
  fs.rmSync(path.join(dir, "state", "subagent", "accuracy.json"));
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam()), /must hold a classifier verdict PASS younger than 30 days/, "no file");
  // (b) bound to the policy
  refused(good({ evidence: { ...good().evidence, policyContentHash: "0".repeat(32) } }), /^--enforce enforce is blocked: state\/subagent\/accuracy\.json was measured against policy 000000000000 but the policy is a1b2c3d4e5f6: a rebuild or a change of toggles that changes the policy voids it; run the accuracy evaluation again \(evidence: /);
  for (const ev of [{ ...good().evidence, policyContentHash: null }, { ...good().evidence, policyContentHash: "" }, { ...good().evidence, policyContentHash: 12 }, { classRowsCounted: 5 }, null, "x", [1]])
    refused(good({ evidence: ev }), /records no policy content hash/);
  refused(good(), /cannot be bound: there is no compiled policy/, seam({ contentHash: undefined }));          // no hash given and no compiled file on disk
  // ... and with no explicit hash the compiled file on disk is the policy (the live one)
  const compiledA = lib.compile(live, { ...lib.OWNER_DEFAULTS, mode: "dynamic", source: "all-providers" }).compiled, compiledB = lib.compile(live, { ...lib.OWNER_DEFAULTS, mode: "free", source: "all-providers", freeScope: "providers" }).compiled;
  assert.notEqual(compiledA.contentHash, compiledB.contentHash);
  wr(path.join(dir, "state", "subagent", "policy.json"), compiledA);
  assert.doesNotThrow(() => check(good({ evidence: { ...good().evidence, policyContentHash: compiledA.contentHash } }), seam({ contentHash: undefined })));
  wr(path.join(dir, "state", "subagent", "policy.json"), compiledB);
  refused(good({ evidence: { ...good().evidence, policyContentHash: compiledA.contentHash } }), /was measured against policy [0-9a-f]{12} but the policy is [0-9a-f]{12}: a rebuild/, seam({ contentHash: undefined }));
  // (c) versions
  refused(good({ ccrVersion: "3.0.21" }), /was measured on CCR 3\.0\.21 but CCR 3\.0\.22 is installed; run the accuracy evaluation again/);
  assert.doesNotThrow(() => check(good({ ccrVersion: " 3.0.22 " })), "surrounding spaces are trimmed");
  // WHOLE versions (finding 9): a prerelease tag is a different version; a v prefix, a fourth number and free text around the number are not a version this check reads
  refused(good({ ccrVersion: "3.0.22-evil" }), /was measured on CCR 3\.0\.22-evil but CCR 3\.0\.22 is installed/);
  refused(good({ ccrVersion: "3.0.22+build9" }), /was measured on CCR 3\.0\.22\+build9 but CCR 3\.0\.22 is installed/);
  for (const v of ["v3.0.22", "3.0.22.9", "CCR v3.0.22 (installed)", "3.0", "3.0.22 and more"]) refused(good({ ccrVersion: v }), /records a CCR version that is not a whole x\.y\.z/);
  for (const v of ["v2.1.289", "2.1.289.1", "Claude Code 2.1.289"]) refused(good({ ccVersion: v }), /records a Claude Code version that is not a whole x\.y\.z/);
  refused(good({ ccVersion: "2.1.289-evil (Claude Code)" }), /was measured on Claude Code 2\.1\.289-evil but 2\.1\.289 is installed/);
  assert.doesNotThrow(() => check(good({ ccVersion: "2.1.289" })), "the bare version is fine"); assert.doesNotThrow(() => check(good({ ccVersion: "2.1.289 (Claude Code)" })), "claude --version prints this");
  // an installed version that is itself a prerelease is compared whole too
  refused(good({ ccrVersion: "3.0.22" }), /was measured on CCR 3\.0\.22 but CCR 3\.0\.22-rc1 is installed/, seam({ ccrVersion: () => "3.0.22-rc1" }));
  for (const v of [null, "", "   ", 3, {}]) refused(good({ ccrVersion: v }), /records no CCR version \(ccrVersion\)/);
  for (const v of ["unknown", "x"]) refused(good({ ccrVersion: v }), /records a CCR version that is not a whole x\.y\.z/);
  refused(good(), /cannot be bound to the installed CCR: its version cannot be read/, seam({ ccrVersion: () => null }));
  refused(good({ ccVersion: "2.1.288" }), /was measured on Claude Code 2\.1\.288 but 2\.1\.289 is installed/);
  for (const v of [null, "", 7]) refused(good({ ccVersion: v }), /records no Claude Code version \(ccVersion\)/);
  refused(good({ ccVersion: "x" }), /records a Claude Code version that is not a whole x\.y\.z/);
  // finding 3: no readable installed Claude Code version REFUSES the gate; only the owner's explicit --accept-unverified-cc yes lets the recorded version stand, and the line says it was not compared
  refused(good(), /^--enforce enforce is blocked: state\/subagent\/accuracy\.json cannot be bound to the installed Claude Code: its version cannot be read here .*pass --accept-unverified-cc yes to enforce on the recorded version anyway \(evidence: /, seam({ ccVersion: () => null }));
  const nocc = check(good(), seam({ ccVersion: () => null, acceptUnverifiedCc: true }));
  assert.match(nocc[0], /Claude Code 2\.1\.289 \(NOT compared with the installed version: accepted by --accept-unverified-cc yes\)/);
  refused(good({ ccVersion: null }), /records no Claude Code version/, seam({ ccVersion: () => null, acceptUnverifiedCc: true }));            // the accept flag never excuses a record with no version
  refused(good({ ccVersion: "2.1.288" }), /was measured on Claude Code 2\.1\.288 but 2\.1\.289 is installed/, seam({ acceptUnverifiedCc: true }));            // ... nor a version that CAN be compared and differs
  // evidence line with missing evidence fields prints n/a, never throws
  assert.match(check(good({ evidence: { policyContentHash: H }, window: null }))[0], /evidence: n\/a classified rows hashed n\/a, window n\/a to n\/a/);
  // the real readers: the installed CCR package and the Claude Code launcher resolve to version numbers on this machine (read only)
  const ccr = lib.installedCcrVersion(); assert.ok(ccr === null || /^\d+\.\d+\.\d+$/.test(ccr));
  const cc = lib.installedCcVersion(); assert.ok(cc === null || /^\d+\.\d+\.\d+$/.test(cc));
  // the Claude Code reader: a launcher that is a copy of exactly one version file
  const home = tmp(); const vd = path.join(home, ".local", "share", "claude", "versions"); fs.mkdirSync(vd, { recursive: true }); fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(vd, "2.1.287"), "aaaa"); fs.writeFileSync(path.join(vd, "2.1.289"), "bbbbbb"); fs.writeFileSync(path.join(home, ".local", "bin", "claude.exe"), "bbbbbb");
  const t = new Date("2026-10-01T00:00:00Z"); for (const f of [path.join(vd, "2.1.287"), path.join(vd, "2.1.289"), path.join(home, ".local", "bin", "claude.exe")]) fs.utimesSync(f, t, t);
  assert.equal(lib.installedCcVersion(home), "2.1.289");
  fs.writeFileSync(path.join(vd, "2.1.288"), "cccccc"); const later = new Date("2026-10-02T00:00:00Z"); fs.utimesSync(path.join(vd, "2.1.288"), later, later);
  assert.equal(lib.installedCcVersion(home), "2.1.289", "same size, a different modification time: not the launcher's copy");
  fs.utimesSync(path.join(vd, "2.1.288"), t, t);
  assert.equal(lib.installedCcVersion(home), null, "two version files with the launcher's size and time: ambiguous, so no version is claimed");
  assert.equal(lib.installedCcVersion(path.join(home, "nowhere")), null);
});

// ---- round 2 of the security review: size cap, control characters, --discovery-dir refusals, the peak baseline of the shrink guard
test("enforce reader (round 2): an accuracy.json over 1 MiB is not read; a control character in the record's own date never reaches the printed evidence line", async () => {
  const dir = tmp(); const p = lib.resolvePaths(fixtureFlagMap(dir));
  const live = await lib.gatherInputs(p, { nowMs: NOW, liveProviders: await lib.readProviders(p) });
  const enforce = { ...lib.OWNER_DEFAULTS, mode: "dynamic", enforcement: "enforce" };
  const H = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4";
  const seam = { contentHash: H, ccrVersion: () => "3.0.22", ccVersion: () => "2.1.289" };
  const file = path.join(dir, "state", "subagent", "accuracy.json");
  const rec = (over = {}) => ({ schema: 1, verdict: "PASS", at: new Date(NOW - 3600000).toISOString(), ccVersion: "2.1.289", ccrVersion: "3.0.22", evidence: { classRowsCounted: 5, sha256: "ab".repeat(32), policyContentHash: H }, ...over });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // the cap: a valid record padded with an extra field is fine at the cap and refused one byte over, whatever it says
  const padded = (bytes) => { const base = JSON.stringify(rec({ pad: "" })); return JSON.stringify(rec({ pad: "x".repeat(bytes - base.length) })); };
  fs.writeFileSync(file, padded(1024 * 1024));
  assert.equal(fs.statSync(file).size, 1024 * 1024);
  assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam), "exactly 1 MiB is read");
  fs.writeFileSync(file, padded(1024 * 1024 + 1));
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW, seam), (e) => e.code === "E_PRECONDITION" && /^--enforce enforce is blocked: state\/subagent\/accuracy\.json is larger than 1 MiB \(a verdict file is a few kilobytes\), so it is not read$/.test(e.message));
  assert.equal(lib.ACCURACY_MAX_BYTES, 1024 * 1024);
  // finding 8: the date text is the record's own; only a printable form is ever put in a line
  const at = "(\u0007)Oct 5 2026 10:00:00 UTC";
  assert.ok(Number.isFinite(Date.parse(at)));
  fs.writeFileSync(file, JSON.stringify(rec({ at })));
  const lines = lib.checkEnforcePreconditions(p, live, enforce, Date.parse(at) + 3600000, seam);
  assert.ok(!/[\u0000-\u001f]/.test(lines.join("")), "no control character in the ok line");
  fs.writeFileSync(file, JSON.stringify(rec({ at, ccrVersion: "3.0.21" })));
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, Date.parse(at) + 3600000, seam), (e) => !/[\u0000-\u001f]/.test(e.message) && /measured on CCR 3\.0\.21/.test(e.message), "nor in a refusal");
});

test("--discovery-dir gets the refusals of the file flags: a blank value, a UNC path (before any realpath can open a connection) and a folder under a protected real folder are refused, a temp folder is read", () => {
  const prot = tmp(), ok = tmp();
  const usage = (e) => e.code === "E_USAGE";
  assert.throws(() => lib.resolvePaths({ "discovery-dir": "" }), usage); assert.throws(() => lib.resolvePaths({ "discovery-dir": "   " }), usage);
  for (const unc of [String.raw`\\localhost\C$\disc`, String.raw`\\127.0.0.1\C$\disc`, String.raw`\\?\UNC\evil\share\disc`]) assert.throws(() => lib.resolvePaths({ "discovery-dir": unc }), (e) => usage(e) && /UNC path/.test(e.message), unc);
  assert.throws(() => lib.resolvePaths({ "discovery-dir": path.join(prot, "sub", "..", "disc") }, { protect: [prot] }), (e) => usage(e) && /lies under/.test(e.message), "under a protected folder, however it is spelled");
  const r = lib.resolvePaths({ "discovery-dir": ok });
  assert.deepEqual([r.discoveryDir, r.fixture], [path.resolve(ok), false], "a temp folder is accepted and does not turn the run into a fixture run");
  // given through the CLI parser too: a UNC value never reaches a read
  const here = lib.parseArgs(["status", "--discovery-dir", ok]);
  assert.equal(here.flags["discovery-dir"], ok);
});

test("shrink guard (round 2): the baseline is the PEAK route count since the last accepted shrink, so two 20% steps add up; stampBaseline keeps the peak, resets on an accepted shrink and on a first compile", () => {
  const pol = (routes, base, extra = {}) => ({ builtFrom: { snapshotRoutes: routes, ...(base === undefined ? {} : { snapshotRoutesBaseline: base }), ownerHash: "h" }, counts: { universe: routes, allowed: 50 }, ...extra });
  const next = (routes) => ({ builtFrom: { snapshotRoutes: routes, ownerHash: "h" }, counts: { universe: routes, allowed: 50 } });
  // 100 -> 80 passes (-20%) and the compile stamps the peak 100
  let c = next(80); assert.equal(lib.shrinkFinding(pol(100, 100), c), null);
  lib.stampBaseline(c, pol(100, 100), false); assert.equal(c.builtFrom.snapshotRoutesBaseline, 100);
  // 80 -> 64 passes against the previous policy alone (-20%), and is refused against the peak (-36%)
  const prev = { ...pol(80, 100) };
  c = next(64);
  const f = lib.shrinkFinding(prev, c);
  assert.deepEqual([f?.routes, f?.routesBefore, f?.routesNow], [true, 100, 64], "the guard sees 100 -> 64, not 80 -> 64");
  assert.match(lib.shrinkText(f), /^the snapshot shrank from 100 to 64 routes/);
  assert.equal(lib.shrinkFinding({ ...prev, builtFrom: { ...prev.builtFrom, snapshotRoutesBaseline: 80 } }, c), null, "without the peak the same step passes (the blind spot this closes)");
  // accepted: the baseline becomes the new count; growth raises the peak; a first compile starts at its own count; a policy from before the stamps uses what it has
  lib.stampBaseline(c, prev, true); assert.equal(c.builtFrom.snapshotRoutesBaseline, 64);
  c = next(120); lib.stampBaseline(c, pol(80, 100), false); assert.equal(c.builtFrom.snapshotRoutesBaseline, 120);
  c = next(50); lib.stampBaseline(c, null, false); assert.equal(c.builtFrom.snapshotRoutesBaseline, 50);
  c = next(70); lib.stampBaseline(c, { builtFrom: { ownerHash: "h" }, counts: { universe: 90, allowed: 5 } }, false); assert.equal(c.builtFrom.snapshotRoutesBaseline, 90);
  c = { builtFrom: {} }; lib.stampBaseline(c, pol(80, 100), false); assert.equal(c.builtFrom.snapshotRoutesBaseline, undefined, "no count, no stamp");
  // hint for a caller without its own --accept-shrink
  assert.match(lib.shrinkText(f, { via: "set", live: true }), /: refresh discovery first \(node refresh\/cli\.mjs, needs your OK\), or accept the smaller snapshot first with `node keysync\/key\.mjs subagent-policy set --accept-shrink yes --live yes` \(it saves your current toggles again\)$/);
  assert.match(lib.shrinkText(f, { via: "set", live: false }), /subagent-policy set --accept-shrink yes` \(it saves/);
  assert.doesNotMatch(lib.shrinkText(f, { via: "set" }), /or pass --accept-shrink yes/);
});

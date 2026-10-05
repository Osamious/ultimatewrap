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
import { funnel, FREE_TAG, fnv1a32, priceText, priceSum, isPremium, emptyStage, SELECTOR_RE, toolEligible } from "../menu/subagent-funnel.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { TIERS, isTier, tierList, RELAY_KEY_ID, RELAY_TIER, freeScopeOf, isExcludedTier, isProvenanceVerified } from "../menu/tiers.mjs";

guardRealState(after, assert);
const NOW = Date.parse("2026-10-03T00:00:00.000Z");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-pol-"));
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
    s.rows[2].models.push({ ...m, id: "not-listed" }, { ...m, id: "has space" }, { ...m, id: "z".repeat(70) }, { ...m, id: "bad\u0001ctl" });
    wr(path.join(d, "snapshot.json"), s);
    const pr = rd(path.join(d, "providers.json")); pr.Providers[2].models.push("has space", "z".repeat(70), "bad\u0001ctl"); wr(path.join(d, "providers.json"), pr);
  });
  const r = run(g);
  assert.equal(r.counts.idRejected, 3, "a space, a 70-character id and a control character, of 4 routes added");
  assert.equal(r.idRejected.length, 3);
  assert.equal(r.dropped.get("fx-free-b/not-listed"), "not-in-providers");
  assert.ok(sels(r).every((s) => SELECTOR_RE.test(s)), "no rejected selector reaches a list");
  const big = cell(r, "fx-free-a/fxa-big:free");
  assert.equal(sels(r).filter((s) => s.startsWith("fx-free-a/fxa-big")).length, 1, "x and x[1m] are one selector");
  assert.equal(big.c, 1000000); assert.equal(big.n, 1, "1M claim only from the [1m] sibling: listing-only");
  assert.ok(SELECTOR_RE.test("a".repeat(64)) && !SELECTOR_RE.test("a".repeat(65)));
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
  assert.ok(k(fxd)[6] < k(alpha)[6] && k(fxp)[6] < k(alpha)[6], "the ctx key favours the 0t rows (more context)");
  assert.ok(k(fxd)[7] < k(alpha)[7] && k(fxp)[7] < k(alpha)[7], "the TTFT key favours the 0t rows (TTFT bucket 0 against 2)");
  assert.deepEqual([alpha, fxd, fxp, "fx-free-a/fxa-gamma", "fx-free-a/fxa-beta"].map((x) => k(x)[3]), [0, 1, 1, 2, 3], "classes: 0, 0t, 0t, U, P");
  assert.deepEqual(sels(r), Q6_NEW, "class 0 first, then the ft rows, then unknown price, then positive price");
  assert.deepEqual([alpha, fxd, fxp].map((x) => cell(r, x).fp + "/" + cell(r, x).ft), ["1/0", "0/1", "0/1"], "the classes are the fp and ft flags of the compiled rows");
  // D1: AGE is no longer a band key and no longer outranks the price class: a stale probe on alpha leaves it in price class 0, above the fresh 0t rows (recency only orders INSIDE a band)
  const stale = await fx((d) => { q6Mutate(d); const b = rd(path.join(d, "bench.json")); b.models[alpha].a = NOW / 1000 - 20 * 86400; wr(path.join(d, "bench.json"), b); });
  const rs = run(stale.g, { mode: "free", freeScope: "providers+deposit", source: "all-providers" });
  assert.equal(rs.groups.get(alpha).rk[4], 2, "alpha is recency class 2 (older than 14 days): an ordering key");
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
  const GOLD_PROVIDERS = "3775a0536d3f763a", GOLD_PROVIDERS_MUTATED = "5bd1894d80829f1b", GOLD_DEPOSIT_DEFAULT = "56f712c5810bec22";
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
  assert.equal(r.ctxHints[SONNET_REL], 1000000);
  assert.equal(r.ctxHints["anthropic/claude-sonnet-5-5[1m]"], 1000000, "the raw [1m] spelling of an alias value is hinted too");
  assert.equal(r.ctxHints[HAIKU_REL], 200000);
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
  for (const r of rows) assert.match(r, /^- \S+  (1M|\d+k|ctx\?)  (\$[\d.]+\/\$[\d.]+|\$[\d.]+\/\?|free|\$\?)  tools:(UNVERIFIED|verified|small)  (fast|ok|slow|\?)  cap:(\d+k|unknown)(  ALIAS)?(  \$\$)?$/);
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

test("F8 + D1: the recency class (live<=7d, fresh<=14d, older; an ORDERING key inside a band, rank key 5) orders rows that context alone would order the other way", async () => {
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
  const k2 = (x) => r.groups.get(`fx-free-a/${x}`).rk[4];
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map(k2), [0, 1, 2], "recency class: live and fresh, fresh, older");
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => r.groups.get(`fx-free-a/${x}`).rk[1]), [0, 0, 0], "health (latest status ok) is yes for all three: age is ignored");
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => r.groups.get(`fx-free-a/${x}`).b), [r.groups.get("fx-free-a/fxa-alpha").b, r.groups.get("fx-free-a/fxa-alpha").b, r.groups.get("fx-free-a/fxa-alpha").b], "and the three rows share ONE band");
  const order = sels(r).filter((x) => /fxa-(alpha|beta|gamma)$/.test(x));
  assert.deepEqual(order, ["fx-free-a/fxa-alpha", "fx-free-a/fxa-gamma", "fx-free-a/fxa-beta"], "recency (key 5) beats context (key 7) inside the band");
  // the boundaries: a live record older than 7 days is no longer class 0; 14 d exactly is class 1, 14 d + 1 s is class 2
  const edge = await fx((d) => {
    const b = rd(path.join(d, "bench.json"));
    b.models["fx-free-a/fxa-alpha"].a = NOW / 1000 - 8 * day; b.models["fx-free-a/fxa-gamma"].a = NOW / 1000 - 14 * day; b.models["fx-free-a/fxa-beta"].a = NOW / 1000 - 14 * day - 1;
    wr(path.join(d, "bench.json"), b);
    wr(path.join(d, "observed.json"), { schema: 1, writtenAt: "2026-10-02T00:00:00.000Z", feed: "ok", models: { "fx-free-a/fxa-alpha": { s: "ok", t: 500, a: NOW / 1000 - 8 * day + 3600, l: 1 } } });
  });
  const e = run(edge.g, { mode: "dynamic" });
  assert.deepEqual(["fxa-alpha", "fxa-gamma", "fxa-beta"].map((x) => e.groups.get(`fx-free-a/${x}`).rk[4]), [1, 1, 2], "live at 8 d is class 1; 14 d exactly is class 1; 14 d + 1 s is class 2");
});

test("F8: rank key 4 (TTFT bucket <1000 ms, <3000 ms, else or missing) orders rows that tie on every key above it; the buckets are right at the boundaries", async () => {
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
  assert.deepEqual(["fx-free-a/fxa-beta", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/fxa-alpha"].map(h), [0, 1, 1, 2], "999 -> 0, 1000 -> 1, 2999 -> 1, 3000 -> 2");
  const order = sels(r).filter((x) => /(fxa-(alpha|beta|gamma)|fxb-one)$/.test(x));
  assert.deepEqual(order, ["fx-free-a/fxa-beta", "fx-free-a/fxa-gamma", "fx-free-b/fxb-one", "fx-free-a/fxa-alpha"],
    "bucket first (0, 1, 1, 2), then the id breaks the tie inside bucket 1; alpha sorts first by id but is last by TTFT");
  const none = await fx((d) => { const b = rd(path.join(d, "bench.json")); delete b.models["fx-free-a/fxa-alpha"].t; wr(path.join(d, "bench.json"), b); });
  assert.equal(cell(run(none.g, { mode: "dynamic" }), "fx-free-a/fxa-alpha").h, 2, "a missing TTFT is the slowest bucket");
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
  accuracy({ at: new Date(NOW).toISOString(), verdict: "PASS" });
  const enforce = { ...lib.OWNER_DEFAULTS, mode: "dynamic", enforcement: "enforce" };
  assert.throws(() => lib.checkEnforcePreconditions(p, fixture, enforce, NOW), (e) => e.code === "E_PRECONDITION" && /needs live Providers/.test(e.message), "a fresh PASS verdict does not help: the fixture is not live");
  const live = await lib.gatherInputs(p, { nowMs: NOW, liveProviders: await lib.readProviders(p) });
  assert.equal(live.providersLive, true);
  assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, live, enforce, NOW), "live + a PASS younger than 30 days");
  accuracy({ at: new Date(NOW - 31 * 86400000).toISOString(), verdict: "PASS" });
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW), /blocked: state\/subagent\/accuracy\.json/, "expired");
  accuracy({ at: new Date(NOW).toISOString(), verdict: "FAIL" });
  assert.throws(() => lib.checkEnforcePreconditions(p, live, enforce, NOW), /blocked/);
  assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, fixture, { ...enforce, enforcement: "shadow" }, NOW), "shadow needs nothing");
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
  const mkRows = (ctxOf = (i) => 200000 - i * 1000) => names.map((p) => ({ provider: p, keyId: `b.${p}.paid`, models: MODELS.map((id, i) => ({ id, outModality: "chat", ctx: ctxOf(i), tools: true, pin: 1, pout: 2 })) }));
  const providers = names.map((name) => ({ name, models: MODELS, enabled: true, described: false }));
  // recency differs (live within 7 days, fresh within 14, older), the band keys do not
  const age = { "pa/m1": 1, "pa/m2": 1, "pa/m3": 10, "pa/m4": 10, "pb/m1": 20, "pb/m2": 20, "pb/m3": 20, "pb/m4": 20 };
  const bench = { get: (k) => ({ s: "ok", a: nowMs / 1000 - age[k] * day, t: 500 }), isLive: (k) => k === "pa/m1" };
  const inputs = { rows: mkRows(), bench, nowMs, providers, tiers: { pa: "paid", pb: "paid" }, toolFidelity: null, aliasValues: {}, defaultModel: null };
  const res = funnel(inputs, T({ source: "all-providers" }));
  const bands = res.models.map((m) => m.b);
  assert.deepEqual([...new Set(bands)], [0], "live, fresh and old rows share ONE band: recency is an ordering key inside it (D1)");
  assert.deepEqual(res.models.map((m) => m.s), ["pa/m1", "pa/m2", "pa/m3", "pa/m4", "pb/m1", "pb/m2", "pb/m3", "pb/m4"], "yet the ORDER still follows recency first (pa live and fresh before pb old)");
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

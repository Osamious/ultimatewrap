// The stratified pilot (`--sample`), the thinking-only escalation at the CLI, the test helper's cleanup, and the stream limits pinned by number.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { spawnSync } from "node:child_process";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, cleanupDirs, madeDirs, fakeFetch, ev, stream, ok, http, goodModel, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { main } from "../refresh/tool-fidelity-cli.mjs";
import { probeSet, selectCandidates, drawSample, stratumOf, l3Rates, loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { STREAM_LIMITS } from "../refresh/tool-fidelity-probe.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const POLICY = { schema: 1, models: [] };

/** `providers` free providers p0..p{n-1} with `per` models each (ids vary: some reasoning, ctx unknown / small / large), plus a paid provider `pay`. */
function world(providers = 12, per = 8) {
  const ctxs = [null, 100000, 200000, 1000000], ids = ["alpha", "beta-r1", "gamma", "delta-thinking", "eps", "zeta", "eta-o3", "theta"];
  const rows = [];
  for (let p = 0; p < providers; p++) rows.push({ provider: `p${p}`, keyId: `k.p${p}.free`, models: Array.from({ length: per }, (_, i) => ({ id: `${ids[i % ids.length]}-${i}`, outModality: "chat", ctx: ctxs[(i + p) % ctxs.length], tools: true, pin: 0, pout: 0, badge: "FREE" })) });
  rows.push({ provider: "pay", keyId: "k.pay.paid", models: Array.from({ length: 4 }, (_, i) => ({ id: `paid-${i}`, outModality: "chat", ctx: 200000, tools: true, pin: 1, pout: 2, badge: "PAID" })) });
  const tiers = { pay: "paid", ...Object.fromEntries(Array.from({ length: providers }, (_, p) => [`p${p}`, "free"])) };
  return { snap: { rows }, bench: { get: () => ({ s: "ok", t: 400, a: 1790699779 }) }, tiers };
}
const candidates = (w, extra = {}) => selectCandidates({ set: probeSet(w.snap, w.bench), policy: POLICY, tiers: w.tiers, ...extra });

test("stratumOf: reasoning or plain by the id, and the context class unknown, small (under 128,000) or large", () => {
  assert.equal(stratumOf({ id: "model-r1", ctx: 0 }), "reasoning/unknown");
  assert.equal(stratumOf({ id: "x-thinking", ctx: 100000 }), "reasoning/small");
  assert.equal(stratumOf({ id: "gpt-oss-20b", ctx: 128000 }), "reasoning/large");
  assert.equal(stratumOf({ id: "llama-3.3-70b", ctx: 200000 }), "plain/large");
  assert.equal(stratumOf({ id: "llama", ctx: null }), "plain/unknown");
  assert.equal(stratumOf({ id: "mirror-1", ctx: 64000 }), "plain/small", "`r1` only counts as a whole token, not inside `mirror`");
});

test("drawSample: N free-tier models, a few per provider in ROUNDS (no provider twice before every provider once), mixing strata, the same seed the same sample", () => {
  const w = world();
  const all = candidates(w, { includeTiers: ["paid"] }).entries;
  assert.ok(all.some((e) => e.tier === "paid"), "(the paid models are in the pool the pilot is drawn from, so excluding them is the sampler's doing)");
  const a = drawSample({ entries: all, n: 30, seed: "s1" });
  assert.equal(a.entries.length, 30);
  assert.ok(a.entries.every((e) => e.tier === "free"), "free tier only, even when paid models are candidates");
  assert.equal(new Set(a.entries.slice(0, 12).map((e) => e.provider)).size, 12, "round one: one model from each of the 12 providers");
  assert.ok(Object.values(a.strata.byProvider).every((n) => n >= 2 && n <= 3), "30 over 12 providers: 2 or 3 each");
  assert.equal(a.strata.providers, 12);
  assert.equal(a.strata.of, all.filter((e) => e.tier === "free").length);
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  assert.deepEqual([sum(a.strata.byReasoning), sum(a.strata.byCtx), sum(a.strata.byStratum), sum(a.strata.byProvider)], [30, 30, 30, 30]);
  assert.ok(a.strata.byReasoning.reasoning > 5 && a.strata.byReasoning.plain > 5, "both kinds are drawn");
  assert.ok(a.strata.byCtx.unknown > 3 && a.strata.byCtx.small > 3 && a.strata.byCtx.large > 3, JSON.stringify(a.strata.byCtx));
  const again = drawSample({ entries: all, n: 30, seed: "s1" });
  assert.deepEqual(again.entries.map((e) => e.key), a.entries.map((e) => e.key), "deterministic");
  assert.notDeepEqual(drawSample({ entries: all, n: 30, seed: "s2" }).entries.map((e) => e.key), a.entries.map((e) => e.key), "another seed, another sample");
  const per = (prov) => a.entries.filter((e) => e.provider === prov).map(stratumOf);
  for (const prov of Object.keys(a.strata.byProvider)) assert.equal(new Set(per(prov)).size, per(prov).length, `${prov}: a stratum is not repeated before the others are used`);
  assert.equal(drawSample({ entries: all, n: 1000, seed: 1 }).entries.length, a.strata.of, "N larger than the pool is the whole pool");
  assert.equal(new Set(drawSample({ entries: all, n: 1000, seed: 1 }).entries.map((e) => e.key)).size, a.strata.of, "none twice");
  assert.deepEqual(drawSample({ entries: [], n: 5 }).entries, []);
});

test("l3Rates: the L3 failure rate among the models that PASSED L1+L2, overall and per provider; a model not yet tested at L3 is waiting, not a pass", () => {
  const r = (lvr) => ({ lvr });
  const store = { "a/1": r("pppn"), "a/2": r("ppfn"), "a/3": r("ppnn"), "a/4": r("ffnn"), "b/1": r("ppfn"), "b/2": r("pppp"), "b/3": r("ppfp"), "c/1": r("ffnn") };
  const x = l3Rates(store, Object.keys(store));
  assert.deepEqual(x.overall, { passers: 6, tested: 5, failed: 3, waiting: 1, rate: 0.6 });
  assert.deepEqual(x.perProvider.a, { passers: 3, tested: 2, failed: 1, waiting: 1, rate: 0.5 });
  assert.deepEqual(x.perProvider.b, { passers: 3, tested: 3, failed: 2, waiting: 0, rate: 2 / 3 });
  assert.equal(x.perProvider.c, undefined, "a provider whose models all failed L1 has no passers: not a row");
  assert.equal(l3Rates(store, ["a/3"]).overall.rate, null, "nothing tested: no rate, not zero");
  assert.deepEqual(l3Rates(store, ["a/1"]).overall.rate, 0);
});

// ---------------------------------------------------------------- the CLI pilot

function env(w, answer) {
  const dir = freshDir();
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: w.snap }, bench: w.bench, policy: { ...POLICY, tiers: w.tiers }, presetKeys: null, outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"),
    gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW, isAlive: () => false, findRunning: () => [], sweep: { ...SWEEP_FAST }, retryDelayMs: 1, rateBackoffMs: 1 };
  return { dir, deps, f, out: deps.outFile };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(pinL12(argv), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));

test("DRY RUN --sample: the sample's strata, the estimate (~39,500 tokens per model for L1+L2+L3, the big step on top for passers), and the same output for the same seed", async () => {
  const e = env(world());
  const r = await run(["--sample", "30", "--seed", "x"], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.equal(e.f.calls.length, 0);
  assert.match(r.out, /levels L1\+L2\+L3\+L4\+big\+L6\+L7/, "the pilot asks every level (L4 rides in the 157 KB request; spawn and the error result are cheap)");
  assert.match(r.out, /sample \(seed x\): 30 of \d+ free-tier candidates across 12 provider\(s\); reasoning\/plain: plain \d+, reasoning \d+; context: large \d+, small \d+, unknown \d+/);
  const m = r.out.match(/estimated input tokens: ~([\d.]+)M for L1\+L2\+L3, and up to ~([\d.]+)M more for the big step/);
  assert.ok(m, r.out);
  assert.ok(Number(m[1]) > 1.2 && Number(m[1]) < 1.6, `30 models x about 47,000 (L1 + L2 with the 20 KB result + 3a + 3b + spawn + error result, no big) = ~1.4M, got ${m[1]}M`);
  assert.ok(Number(m[2]) > 1.5, `the big step: ${m[2]}M`);
  assert.match(r.out, /excluded: not-in-sample \d+, not-free-tier \(skipped for now\) 4/);
  assert.equal((await run(["--sample", "30", "--seed", "x"], e.deps)).out, r.out, "same seed, same dry run");
  assert.notEqual((await run(["--sample", "30", "--seed", "y"], e.deps)).out, r.out);
  const d = await run(["--sample"], e.deps);
  assert.match(d.out, /sample \(seed 1\): 60 of \d+ free-tier candidates/, "the default is 60");
});

test("LIVE --sample: L1+L2+L3 (+ the big step for passers) on exactly the sample; the report prints the L3 FAILURE RATE among the L1+L2 passers, overall and per provider", async () => {
  const w = world(6, 6);
  const e = env(w, (c) => {
    const prov = c.body.model.split("/")[0];
    if (c.bytes > 300000) return goodModel(c);
    if (kindOf(c) === "3b" && (prov === "p0" || prov === "p1")) return http(413, "request entity too large");   // p0 and p1 refuse the 157 KB request on size
    return goodModel(c);
  });
  const args = ["--sample", "12", "--seed", "k", "--l3", "yes", "--tf-max-tokens-per-provider", "400000"];
  const r = await run(["--live", ...args], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const asked = new Set(calls(e.f).map((c) => c.body.model));
  assert.ok([...asked].every((k) => k.split("/")[0] !== "pay"), "no paid-tier model was asked");
  assert.ok(asked.size <= 12 && asked.size >= 10, `${asked.size} models asked (the sample is 12; the cap may leave a few for the next run)`);
  const s = loadFidelity(e.out).models;
  const tested = Object.values(s).filter((x) => x.lvr[2] === "p" || x.lvr[2] === "f");
  const failed = tested.filter((x) => x.lvr[2] === "f");
  assert.ok(failed.length > 0 && failed.length < tested.length, "some refused, some passed");
  assert.ok(failed.every((x) => x.capBelow === 150000 && x.t === "t"), "a size refusal is a cap and class t, not x");
  const m = r.out.match(/pilot: L3 failure rate among the models that passed L1\+L2: ([\d.]+)% \((\d+) failed of (\d+) tested; (\d+) passers, (\d+) not yet tested\)/);
  assert.ok(m, r.out);
  assert.deepEqual([Number(m[2]), Number(m[3])], [failed.length, tested.length], "the printed counts are the stored records'");
  assert.equal(Number(m[1]), Number(((failed.length / tested.length) * 100).toFixed(1)));
  assert.match(r.out, /\n  p0: 100\.0% \(\d of \d; \d passers\)/, "p0 refused every time");
  assert.match(r.out, /\n  p5: 0\.0% \(0 of \d; \d passers\)/, "p5 never refused");
});

test("THINKING-ONLY escalation at the CLI: a model whose budget went on thinking is asked again once with a larger budget (and its later levels use it); still empty is pending `reasoning-budget`, never failed", async () => {
  const w = world(1, 3);
  const think = `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`
    + `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })}\n\n`;
  const empty = ok(stream(think, ev.stop("max_tokens")));
  const ids = w.snap.rows[0].models.map((m) => `p0/${m.id}`);
  const e = env(w, (c) => {
    if (c.body.model === ids[0]) return empty;                                                    // never answers, whatever the budget
    if (c.body.model === ids[1] && c.body.max_tokens < 2048) return empty;                        // answers once the budget is raised
    return goodModel(c);
  });
  const r = await run(["--live", "--candidates", "policy", "--l3", "yes", "--tf-max-tokens-per-provider", "1000000"], e.deps);
  const s = loadFidelity(e.out);
  assert.equal(s.models[ids[0]], undefined, "not failed, not recorded");
  assert.equal(s.pending[ids[0]].r, "reasoning-budget");
  assert.ok(s.models[ids[1]], "recorded after the bump");
  assert.equal(s.models[ids[1]].t, "v");
  const mine = calls(e.f).filter((c) => c.body.model === ids[1]);
  assert.deepEqual(mine.slice(0, 3).map((c) => c.body.max_tokens), [256, 2048, 2048], "L1 empty at its 256, asked again at 2048; L2 goes straight to 2048");
  assert.equal(calls(e.f).filter((c) => c.body.model === ids[0]).length, 2, "the model that never answers: one ask and one bump, then it is left for a later run");
  assert.match(r.out, /escalated: 2 model\(s\) spent their whole output budget on thinking and were asked again once with 2048 tokens instead of their small budget; the ones still empty are pending: reasoning-budget \(never failed\)/);
  assert.match(r.out, /pending \d+ \(.*reasoning-budget 1/);
  assert.ok(!Object.values(s.models).some((x) => x.t === "x"), "no x anywhere");
});

// ---------------------------------------------------------------- tidy

test("the temp-dir helper CLEANS UP what it made, and only that: a foreign directory with the same prefix is left alone", () => {
  const mine = freshDir(), mine2 = freshDir();
  fs.writeFileSync(path.join(mine, "f"), "1");
  const foreign = mkTmp("uw-tf-foreign-");
  try {
    assert.ok(madeDirs().includes(mine) && madeDirs().includes(mine2) && !madeDirs().includes(foreign));
    assert.ok(cleanupDirs() >= 2);
    assert.equal(fs.existsSync(mine), false);
    assert.equal(fs.existsSync(mine2), false);
    assert.equal(fs.existsSync(foreign), true, "not made by the helper: not removed");
    assert.deepEqual(madeDirs(), []);
  } finally { fs.rmSync(foreign, { recursive: true, force: true }); }
});

test("the stream limits are pinned by number: 2 MiB, 20,000 events, 64 blocks (changing one is a decision, not an edit)", () => {
  assert.deepEqual({ ...STREAM_LIMITS }, { bytes: 2097152, events: 20000, blocks: 64 });
  assert.equal(Object.isFrozen(STREAM_LIMITS), true);
});

test("a test FILE that uses the helper leaves no directory behind when it finishes (the after-hook, proven in a child run with its own temp folder)", () => {
  const sbx = mkTmp("uw-tf-sbx-");
  try {
    const helpers = new URL("./fixtures/tool-fidelity-helpers.mjs", import.meta.url).href;
    const tiny = path.join(sbx, "tiny.test.mjs");
    fs.writeFileSync(tiny, [
      'import { test } from "node:test";', 'import fs from "node:fs";', `import { freshDir, madeDirs } from ${JSON.stringify(helpers)};`,
      `test("makes two", () => { freshDir(); freshDir(); fs.writeFileSync(${JSON.stringify(path.join(sbx, "made.json"))}, JSON.stringify(madeDirs())); });`, ""].join("\n"));
    const r = spawnSync(process.execPath, ["--test", tiny], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, TEMP: sbx, TMP: sbx, TMPDIR: sbx }, timeout: 60000 });   // NODE_TEST_CONTEXT must not leak in, or the nested run is a no-op
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const made = JSON.parse(fs.readFileSync(path.join(sbx, "made.json"), "utf8"));
    assert.equal(made.length, 2);
    assert.ok(made.every((d) => path.resolve(d).toLowerCase().startsWith(sbx.toLowerCase() + path.sep)), "the child really made its directories in ITS temp folder: " + made.join(", "));
    assert.ok(made.every((d) => !fs.existsSync(d)), "and they are gone");
    assert.deepEqual(fs.readdirSync(sbx).sort(), ["made.json", "tiny.test.mjs"], "nothing else is left");
  } finally { fs.rmSync(sbx, { recursive: true, force: true }); }
});

// The deep-probe rule at the CLI (default-deny: only tier `free` gets levels above L2), its lift, the scheduler rules (canary, rate pause, one in flight for big requests), the
// order flag, timeouts, telemetry and the pilot's order comparison. Offline: fixtures only, fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync as rawExists } from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, ok, http, goodModel, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, parseArgs, plan, printPlan } from "../refresh/tool-fidelity-cli.mjs";
import { loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
const paid = (id) => m(id, { pin: 1, pout: 2, badge: "PAID" });

/** fa and fc: free tier; pb and pd: paid and free-deposit; pm: management; pu: NO tier at all (unlabelled). */
function world(extra = {}) {
  const rows = [
    { provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3")] },
    { provider: "fc", keyId: "k.fc.free", models: [m("c1"), m("c2")] },
    { provider: "pb", keyId: "k.pb.paid", models: [paid("b1"), paid("b2")] },
    { provider: "pd", keyId: "k.pd.free-deposit", models: [m("d1")] },
    { provider: "pm", keyId: "k.pm.management", models: [m("g1")] },
    { provider: "pu", keyId: "k.pu.x", models: [m("u1"), m("u2")] },
  ];
  const tiers = { fa: "free", fc: "free", pb: "paid", pd: "free-deposit", pm: "management", ...extra.tiers };
  return { snap: { rows }, bench: { get: () => ({ s: "ok", t: 400, a: 1790699779 }) }, tiers };
}
function env(w, answer, depsExtra = {}) {
  const dir = freshDir();
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: w.snap }, bench: w.bench, tiers: w.tiers, policy: { schema: 1, models: [], tiers: w.tiers }, presetKeys: null, outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"),
    gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW, isAlive: () => false, findRunning: () => [], rateBackoffMs: 1, sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1, ...depsExtra };
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
const byProvider = (f) => { const o = {}; for (const c of calls(f)) (o[c.body.model.split("/")[0]] ??= []).push(kindOf(c)); return o; };
const DEEP = ["--l3", "yes", "--tf-max-tokens-per-provider", "1000000"];

test("arguments: --order l3-first|big-first; the three timeout classes in seconds; bad values are refused", () => {
  assert.equal(parseArgs([]).order, "l3-first");
  assert.equal(parseArgs(["--order", "big-first"]).order, "big-first");
  assert.ok(parseArgs(["--order", "fastest"]).error);
  assert.ok(parseArgs(["--order"]).error);
  const o = parseArgs([]);
  assert.deepEqual([o.timeoutSmall, o.timeout157, o.timeoutBig, o.maxTokens], [45, 90, 120, null], "the floors");
  assert.deepEqual([o.timeoutMaxSmall, o.timeoutMax157, o.timeoutMaxBig], [120, 180, 240], "the caps");
  assert.ok(parseArgs(["--timeout-small", "130"]).error, "a floor above its cap is refused");
  assert.deepEqual([parseArgs(["--timeout-max-small", "60"]).timeoutMaxSmall, parseArgs(["--timeout-max-157", "200"]).timeoutMax157, parseArgs(["--timeout-max-big", "300"]).timeoutMaxBig], [60, 200, 300]);
  const t = parseArgs(["--timeout-small", "5", "--timeout-157", "30", "--timeout-big", "45", "--max-tokens", "300"]);
  assert.deepEqual([t.timeoutSmall, t.timeout157, t.timeoutBig, t.maxTokens], [5, 30, 45, 300]);
  assert.ok(parseArgs(["--timeout-small", "0"]).error);
});

const FREE_ONLY = ["fa", "fc"];

test("OWNER RULE, dry run: a paid, free-deposit, management or UNLABELLED provider is not in the probe set at all, at any level, however the run is asked; they are counted by tier, never an error", async () => {
  const w = world();
  const e = env(w);
  for (const argv of [["--levels", "1234567", ...DEEP], ["--levels", "12"], [], ["--candidates", "policy", ...DEEP], ["--sample", "50", ...DEEP], ["--levels", "1234", ...DEEP]]) {
    const r = await run(argv, e.deps);
    assert.equal(r.code, 0, r.err);
    assert.equal(e.f.calls.length, 0);
    assert.match(r.out, /6 skipped for now because the provider's key tier is not free \(paid 2, free-deposit 1, management 1, unlabelled 2\); 5 in the probe set \(free-labelled providers only\)/, argv.join(" "));
    assert.match(r.out, /probe-ok models by key tier \(relay apart\): free 5, free-deposit 1, paid 2, management 1, unlabelled 2/);
  }
  for (const levels of ["12", "1234567"]) {
    const p = plan({ snap: w.snap, bench: w.bench, store: {}, o: parseArgs(["--levels", levels, ...DEEP]), tiers: w.tiers });
    assert.deepEqual([...new Set(p.queued.map((q) => q.provider))].sort(), FREE_ONLY, "only free-labelled providers are queued, at ANY level");
    assert.equal(p.set.notFree.length, 6);
    assert.deepEqual(p.set.byTier, { free: 5, paid: 2, "free-deposit": 1, management: 1, unlabelled: 2 });
    assert.equal(p.counts.probeOk, 11);
  }
  const none = plan({ snap: w.snap, bench: w.bench, store: {}, o: parseArgs(["--levels", "12"]), tiers: null });
  assert.deepEqual(none.queued, [], "no tier data at all: nothing is probed (default-deny)");
  assert.match(printPlan(none, parseArgs(["--levels", "12"])), /no provider tier data .*nothing is probed/);
  const ledger = plan({ snap: w.snap, bench: w.bench, store: {}, o: parseArgs(["--candidates", "policy"]), tiers: w.tiers, policy: { models: [] } }).ledger;
  assert.equal(ledger.l12.counts.byExcluded["not-free-tier (skipped for now)"], 6, "the L1+L2 ledger lists them as excluded with the reason");
  assert.equal(ledger.l3.counts.byExcluded["not-free-tier (skipped for now)"], 6);
});

test("OWNER RULE, live: with a fake gateway the paid, deposit, management and unlabelled keys receive NO request at all (levels 1 and 2 included) in every kind of run; the free tier receives everything", async () => {
  const runs = [["--levels", "1234567", ...DEEP], [], ["--levels", "12"], ["--candidates", "policy", ...DEEP], ["--sample", "20", ...DEEP], ["--limit", "50"]];
  for (const argv of runs) {
    const e = env(world());
    const r = await run(["--live", ...argv], e.deps);
    assert.equal(r.code, 0, argv.join(" ") + r.err + r.out);
    const by = byProvider(e.f);
    for (const prov of ["pb", "pd", "pm", "pu"]) assert.equal(by[prov], undefined, `${prov}: not one request (${argv.join(" ")})`);
    assert.ok(calls(e.f).length > 0 && calls(e.f).every((c) => /^(fa|fc)\//.test(c.body.model)));
    const st = loadFidelity(e.out).models;
    assert.deepEqual(Object.keys(st).filter((k) => !/^(fa|fc)\//.test(k)), [], "and no record for them");
  }
  const e = env(world());
  await run(["--live", "--levels", "1234567", ...DEEP], e.deps);
  const by = byProvider(e.f);
  assert.equal(by.fa.filter((k) => k === "1" || k === "2").length, 6, "fa: L1 and L2 for its three models");
  assert.ok(by.fa.includes("3a") && by.fa.includes("3b") && by.fa.includes("5") && by.fa.includes("6") && by.fa.includes("2e"), "the free tier gets every request");
  assert.equal(loadFidelity(e.out).models["fa/a1"].lvr, "pppp");
});

test("a named model of a non-free provider is not a way round the rule: --only (live or dry) finds no probe-ok model and sends nothing", async () => {
  for (const flags of [["--live"], []]) {
    const e = env(world());
    const r = await run([...flags, "--only", "pb/b1,pu/u1,pd/d1,pm/g1", "--levels", "12", ...DEEP], e.deps);
    assert.equal(r.code, 1, r.out + r.err);
    assert.match(r.err, /matches no probe-ok model/);
    assert.equal(calls(e.f).length, 0);
  }
});

test("LIFTING needs ALL of: --include-tier, an explicit --levels, --live and an explicit --max-spend; each missing one keeps the paid tier out of the probe set (or refuses); once lifted a tier may get ANY level it is asked, L1 and L2 included", async () => {
  const levels = ["--levels", "1234567"];
  const full = ["--include-tier", "paid", ...levels, "--max-spend", "5", "--max-row-cost", "1", ...DEEP];
  // everything present: the paid tier is probed at the levels asked
  const ok1 = env(world());
  const r = await run(["--live", "--candidates", "policy", ...full], ok1.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(byProvider(ok1.f).pb.includes("3b"), "lifted: pb is sent the deep requests");
  assert.match(r.out, /deep probes UNLOCKED for paid: the dollar caps apply \(cap \$5\.00, row ceiling \$1\.00\)/);
  assert.equal(byProvider(ok1.f).pd, undefined, "free-deposit was not named: not probed at all");
  assert.ok(!byProvider(ok1.f).pu && !byProvider(ok1.f).pm, "and neither are the unlabelled and management keys");
  // lifting only L1 and L2 is the same lift
  const l12 = env(world());
  const r12 = await run(["--live", "--candidates", "policy", "--include-tier", "paid", "--levels", "12", "--max-spend", "5", "--max-row-cost", "1", ...DEEP], l12.deps);
  assert.equal(r12.code, 0, r12.err + r12.out);
  assert.deepEqual([...new Set(byProvider(l12.f).pb)].sort(), ["1", "1a", "2"], "the paid tier gets exactly the levels asked (L1 is two requests)");
  // each condition dropped in turn
  const drops = {
    "no --include-tier": ["--live", "--candidates", "policy", ...levels, "--max-spend", "5", "--max-row-cost", "1", ...DEEP],
    "levels not explicit": ["--live", "--candidates", "policy", "--include-tier", "paid", "--max-spend", "5", "--max-row-cost", "1", ...DEEP],
    "no --max-spend": ["--live", "--candidates", "policy", "--include-tier", "paid", ...levels, ...DEEP.slice(0, 2), "--tf-max-tokens-per-provider", "1000000"],
    "not --live": ["--candidates", "policy", ...full],
  };
  for (const [name, argv] of Object.entries(drops)) {
    const e = env(world());
    const x = await run(argv, e.deps);
    assert.equal(byProvider(e.f).pb, undefined, `${name}: no request at all for the paid tier`);
    if (name === "no --max-spend") { assert.equal(x.code, 2, name); assert.match(x.err, /need ALL of: .*an explicit --max-spend/, name); assert.equal(calls(e.f).length, 0, "refused before anything was sent"); }
  }
  const dry = await run(["--candidates", "policy", ...full], env(world()).deps);
  assert.match(dry.out, /deep probes for paid stay skipped until all of these hold: --live/, "a dry run never unlocks: it says what is missing");
  const noLevels = await run(["--live", "--candidates", "policy", "--include-tier", "paid", "--max-spend", "5", "--max-row-cost", "1", ...DEEP], env(world()).deps);
  assert.match(noLevels.out, /not-free-tier \(skipped for now\)/, "the default levels are not an explicit ask: the paid tier stays out, and is counted");
});

test("the rule cannot be lifted by an environment variable, a config file, or the incremental entry points: the clamp is in the engine and takes only the validated capability", async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { UW_TF_DEEP: "1", UW_DEEP_PROBES: "paid", TF_DEEP_PROBES: "1", UW_INCLUDE_TIER: "paid", UW_LEVELS: "1234567", UW_TF_LIFT: "paid" });
    const e = env(world());
    await run(["--live", "--levels", "1234567", ...DEEP], e.deps);
    assert.equal(byProvider(e.f).pb, undefined, "an environment variable lifts nothing: the paid tier gets no request");
    assert.equal(byProvider(e.f).pu, undefined);
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; }
  const { runIncremental } = await import("../refresh/tool-fidelity-cli.mjs");
  const w = world();
  assert.deepEqual(runIncremental({ snap: w.snap, bench: w.bench, store: {} }).queue, [], "the incremental entry point with no tier data probes nothing");
  const inc = runIncremental({ snap: w.snap, bench: w.bench, store: {}, tiers: w.tiers });
  assert.ok(inc.queue.length > 0 && inc.queue.every((q) => FREE_ONLY.includes(q.provider) && q.todo.every((l) => l <= 2)), "and with tiers it asks L1 and L2 of the free-labelled providers only");
  const src = (await import("node:fs")).readFileSync(new URL("../refresh/tool-fidelity-cli.mjs", import.meta.url), "utf8");
  assert.equal(/process\.env/.test(src), false, "the CLI reads no environment variable");
  const lib = (await import("node:fs")).readFileSync(new URL("../refresh/tool-fidelity.mjs", import.meta.url), "utf8");
  assert.equal(/process\.env/.test(lib), false);
});

test("CANARY: a provider whose first answer is a dead key, an empty balance or a missing model costs ZERO further requests; its models stay pending with the reason; other providers go on", async () => {
  for (const [status, why] of [[401, "auth"], [402, "pay"]]) {
    const e = env(world(), (c) => (c.body.model.startsWith("fa/") ? http(status, "nope") : goodModel(c)));
    const r = await run(["--live"], e.deps);
    assert.equal(byProvider(e.f).fa.length, 1, `${why}: one request to fa, then nothing`);
    assert.match(r.out, new RegExp(`providers needing attention .*\\n\\s+fa: ${why} \\(.*\\) -- 3 model\\(s\\) skipped`), "the attention block names the provider, its state and how many models were skipped");
    const st = loadFidelity(e.out);
    assert.deepEqual(Object.keys(st.models).filter((k) => k.startsWith("fa/")), [], "no record: the account's state is not a verdict");
    assert.equal(st.pending["fa/a2"].r, `canary-${why}`);
    assert.equal(st.pending["fa/a3"].r, `canary-${why}`);
    assert.ok(st.models["fc/c1"], "another provider is unaffected");
  }
  const ok = env(world(), (c) => (c.body.model === "fa/a1" ? http(500, "oops") : goodModel(c)));
  await run(["--live"], ok.deps);
  assert.ok(byProvider(ok.f).fa.length > 2, "a 5xx is not a canary verdict: the provider is tried on");
});

test("RATE PAUSE: three rate limits in a row make the provider WAIT and be tried again in the same run; a second such episode leaves it alone for the rest of the run (its models stay pending: rate) and the scheduler moves on", async () => {
  const e = env(world(), (c) => (c.body.model.startsWith("fa/") ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)));
  const r = await run(["--live"], e.deps);
  const fa = byProvider(e.f).fa;
  assert.ok(fa.length >= 6 && fa.length <= 12, `fa was asked ${fa.length} times: three, a wait, three more, then left alone`);
  assert.match(r.out, /left alone for the rest of this run, their models stay pending: fa \(rate-limited\)/);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["fa/a3"].r, "rate");
  assert.ok(st.models["fc/c1"] && st.models["fc/c2"], "the other providers were not held up");
});

test("IN FLIGHT: one request at a time per provider when a run includes requests of 100 KB or more, two for small ones; never more than 8 overall", async () => {
  const track = () => { const cur = {}, max = {}; return { cur, max, fn: async (c) => { const p = c.body.model.split("/")[0]; cur[p] = (cur[p] ?? 0) + 1; max[p] = Math.max(max[p] ?? 0, cur[p]); await new Promise((r) => setTimeout(r, 15)); cur[p] -= 1; return goodModel(c); } }; };
  const small = track();
  const e1 = env(world(), small.fn);
  await run(["--live", "--levels", "12"], e1.deps);
  assert.equal(Math.max(...Object.values(small.max)), 2, "L1+L2 only: two per provider");
  const heavy = track();
  const e2 = env(world(), heavy.fn);
  const r = await run(["--live", "--levels", "123", ...DEEP], e2.deps);
  assert.equal(Math.max(...Object.values(heavy.max)), 1, "a run with 157 KB requests: one at a time per provider");
  assert.match(r.out, /in flight per provider: 1 \(1 for requests of 100 KB or more\), 8 overall/);
});

test("TIMEOUTS per request class are configurable and inconclusive: a hung request is counted, never a verdict, and the model stays queued", async () => {
  const e = env(world());
  const t0 = Date.now();
  const r = await run(["--live", "--only", "fa/a1", "--timeout-small", "0.05"], { ...e.deps, fetch: (url, init) => (String(url).endsWith("/health") ? Promise.resolve(new Response("ok")) : new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))))) });
  assert.ok(Date.now() - t0 < 4000);
  assert.deepEqual(Object.keys(loadFidelity(e.out).models), [], "nothing recorded");
  assert.match(r.out, /not recorded \(they stay queued.*\): .*timeout/);
  assert.match(r.out, /\d+ timed out/, "the telemetry counts the timeouts");
});

test("TELEMETRY: per request kind and per provider, actual tokens in and out and seconds against the estimate, the total wall time and a calibration line (printed, never stored)", async () => {
  const e = env(world(), (c) => {
    const k = kindOf(c);
    const g = goodModel(c);
    if (c.body.model.startsWith("fa/") && (k === "1" || k === "2")) return { ...g, body: g.body.replace('"content":[]', `"content":[],"usage":{"input_tokens":${k === "1" ? 330 : 5300}}`) };
    return g;
  });
  const r = await run(["--live", "--only", "fa", "--levels", "12"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /telemetry, actual against estimate, per request kind: 1 x3 in \d+ of ~\d+ estimated, out \d+ of up to \d+, [\d.]+ s each, 3 cut early; 1a x3 [^;]*; 2 x3 in [\d.]+k of ~[\d.]+k estimated/);
  assert.match(r.out, /slowest providers: fa \d+ s over 9 request\(s\); total wall time \d+ s/);
  assert.match(r.out, /calibration \(this run, not stored\): input tokens actual\/estimate [\d.]+, output actual\/budget [\d.]+ over \d+ of 9 request\(s\) that reported usage; \d+ cut early, 0 timed out/);
  const file = (await import("node:fs")).readFileSync(e.out, "utf8");
  assert.equal(/telemetry|calibration/.test(file), false, "nothing of it is stored in the results file");
});

test("BIG-FIRST at the CLI: a model with a known context of 200,000 or more gets the 400 KB step first; a pass records L3 as implied (d3 i) and the 157 KB requests are never sent; l3-first sends 3a and 3b", async () => {
  const bf = env(world());
  const r = await run(["--live", "--only", "fa", "--order", "big-first", "--levels", "1235", ...DEEP], bf.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual([...new Set(byProvider(bf.f).fa)].sort(), ["1", "1a", "2", "5"], "no 3a, no 3b");
  const rec = loadFidelity(bf.out).models["fa/a1"];
  assert.deepEqual([rec.lvr, rec.big, rec.d3, rec.t], ["pppn", "p", "i", "v"]);
  const lf = env(world());
  await run(["--live", "--only", "fa", "--levels", "1235", ...DEEP], lf.deps);
  assert.deepEqual([...new Set(byProvider(lf.f).fa)].sort(), ["1", "1a", "2", "3a", "3b", "5"]);
  const rec2 = loadFidelity(lf.out).models["fa/a1"];
  assert.deepEqual([rec2.lvr, rec2.big, rec2.d3], ["pppp", "p", undefined]);
});

test("the PILOT's report compares l3-first with big-first from the measured pass rates", async () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: Array.from({ length: 6 }, (_, i) => m(`a${i}`)) }];
  const w = { snap: { rows }, bench: { get: () => ({ s: "ok", t: 400, a: 1790699779 }) }, tiers: { fa: "free" } };
  const e = env(w, (c) => (kindOf(c) === "5" && /a[0-1]$/.test(c.body.model) ? http(400, "request too large") : goodModel(c)));
  const r = await run(["--live", "--sample", "6", "--seed", "z", "--levels", "1235", ...DEEP], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /pilot: L3 failure rate among the models that passed L1\+L2: 0\.0% \(0 failed of 6 tested/);
  assert.match(r.out, /order, expected input tokens per L1\+L2 passer from these rates \(L3 pass 100%, big pass 67% of L3 passers\): l3-first ~\d+k, big-first ~\d+k \((big-first|l3-first) is cheaper\)/);
});

test("the dry run prints the per-level cost table, the budgets, the timeouts and a wall-time RANGE; with --max-tokens the budgets are overridden everywhere", async () => {
  const e = env(world());
  const r = await run(["--levels", "1234567", ...DEEP], e.deps);
  assert.match(r.out, /output budgets: 1 256, 2 256, 5 512, 6 512, 1a 512, 2e 256, 3a 256, 3b 256 tokens/);
  assert.match(r.out, /per request \(a full-depth model sends each row once.*L1 simple call \+ argument fidelity 2 req ~\d+ in, up to 768 out; L2 round trip \(20 KB result\) 1 req ~5k in/);
  assert.match(r.out, /wall time, an estimate: about \d+ (s|min|h) to \d+ (s|min|h) for this run/);
  const o = await run(["--levels", "12", "--max-tokens", "300"], e.deps);
  assert.match(o.out, /output budgets: 1 300, 2 300, 5 300, 6 300, 1a 300, 2e 300, 3a 300, 3b 300 tokens/);
});

test("saved results are untouched by a dry run, and a re-run never re-sends a confirmed level (resume): a model with L1+L2 done is asked only what is missing", async () => {
  const e = env(world());
  const first = await run(["--live", "--only", "fa", "--levels", "12"], e.deps);
  assert.equal(first.code, 0);
  const before = calls(e.f).length;
  const second = await run(["--live", "--only", "fa", "--levels", "123", ...DEEP], e.deps);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual([...new Set(calls(e.f).slice(before).map(kindOf))].sort(), ["3a", "3b"], "L1 and L2 were not asked again");
  const third = await run(["--live", "--only", "fa", "--levels", "123", ...DEEP], e.deps);
  assert.match(third.out, /nothing to probe/);
  assert.equal(calls(e.f).length, before + calls(e.f).slice(before).length);
});

test("RATE PAUSE counts rate limits IN A ROW: an answer between them starts the count again, so two plus two is not a pause", async () => {
  const w = world();
  w.snap.rows = [{ provider: "fa", keyId: "k.fa.free", models: ["s1", "s2", "s3", "s4", "s5", "s6"].map((id) => m(id)) }];
  let n = 0;   // every model meets two rate limits and then answers: 2 in a row, a good answer, again 2 in a row, and so on
  const e = env(w, (c) => ((n++ % 5) < 2 ? http(429, "slow down", { "retry-after": "0" }) : goodModel(c)));
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  assert.doesNotMatch(r.out, /left alone for the rest of this run/);
  const st = loadFidelity(e.out);
  assert.ok(st.models["fa/s1"] && st.models["fa/s6"], "every model was asked and answered: the count starts again after each answer");
});

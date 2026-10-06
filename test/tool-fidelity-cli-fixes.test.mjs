// The tool-fidelity CLI, fix round: retry-failed, the store reloaded after the lock, resilient saves, spend for completed levels, sanitised output,
// a cap below one model's cost, the big step, records this version cannot read, two strikes at L3. Offline, in temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, fakeFetch, ok, http, goodModel, record, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { main, plan, parseArgs } from "../refresh/tool-fidelity-cli.mjs";
import { loadFidelity, saveFidelity, cleanFidelity, FILE_NAME, REAL_FILE, KIND } from "../refresh/tool-fidelity.mjs";
import { funnel } from "../menu/subagent-funnel.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");

/** models: [provider, id, {pin, pout, ctx}]; a model with a price is paid. */
function env(models, extra = {}) {
  const dir = freshDir();
  const by = new Map();
  for (const [p, id, o = {}] of models) {
    if (!by.has(p)) by.set(p, []);
    const paid = o.pin !== undefined;
    by.get(p).push({ id, outModality: "chat", ctx: o.ctx === undefined ? 200000 : o.ctx, tools: true, pin: paid ? o.pin : 0, pout: paid ? o.pout : 0, badge: paid ? "PAID" : "FREE" });
  }
  const rows = [...by].map(([provider, ms]) => ({ provider, keyId: `k.${provider.length}.free`, models: ms }));
  const f = fakeFetch(extra.answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (models.some(([p, id]) => `${p}/${id}` === k) ? { s: "ok", t: 400, a: 1790699779 } : null) },
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW, isAlive: () => false, findRunning: () => [],
    sweep: { ...SWEEP_FAST }, retryDelayMs: 1, rateBackoffMs: 1,
    tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])), ...extra.deps };
  return { dir, deps, f, out: deps.outFile, rows };
}
// a live run with priced models needs an explicit --max-spend (liveRefusal): these tests add the default value so the rule is exercised on its own in one test, with `raw`
const spendFor = (argv) => (argv.includes("--live") && !argv.includes("--max-spend") ? [...argv, "--max-spend", "5"] : argv);
async function run(argv, deps, { raw = false } = {}) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(raw ? argv : pinL12(spendFor(argv)), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const saveAll = (e, models) => saveFidelity(e.out, models, { now: NOW });
const FREE4 = [["fa", "a1"], ["fa", "a2"], ["fa", "a3"], ["fa", "auto"]];

test("--retry-failed asks again ONLY models of class x, only at the levels that failed; a record that passed is never touched (byte for byte)", async () => {
  const e = env(FREE4);
  saveAll(e, { "fa/a1": record("ffnn", { strikes: 2, sl: 1 }), "fa/a2": record("ppfn", { strikes: 2, sl: 3 }), "fa/a3": record("ppnn"), "fa/auto": record("pfnn", { strikes: 2, sl: 2 }) });
  const before = loadFidelity(e.out).models["fa/a3"];
  const noConsent = await run(["--live", "--retry-failed"], e.deps);
  assert.equal(noConsent.code, 2);
  assert.match(noConsent.err, /add --l3 yes/, "a retry of an L3 failure sends the 157 KB fixture again: it needs the same consent");
  assert.equal(calls(e.f).length, 0);
  const r = await run(["--live", "--retry-failed", "--l3", "yes", "--only", "fa"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const by = {};
  for (const c of calls(e.f)) (by[c.body.model] ??= []).push(kindOf(c));
  assert.deepEqual(by, { "fa/a1": ["1", "1a", "2"], "fa/a2": ["3a", "3b"], "fa/auto": ["2"] }, "a3 passed and is not asked anything; L1 of `auto` passed and is not asked again");
  const s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a1"].lvr, s["fa/a1"].t, s["fa/a1"].strikes], ["ppnn", "t", undefined], "retried and passed: the strike is gone");
  assert.deepEqual([s["fa/a2"].lvr, s["fa/a2"].t], ["pppp", "v"], "the retried L3 request also answers L4");
  assert.deepEqual([s["fa/auto"].lvr, s["fa/auto"].t], ["ppnn", "t"]);
  assert.deepEqual(s["fa/a3"], before, "untouched");
  const dry = await run(["--retry-failed"], e.deps);
  assert.match(dry.out, /nothing to probe: no model has a confirmed failure/);
});

test("the store is RELOADED after the lock: results another run wrote while this one waited are not asked again and not erased", async () => {
  const e = env(FREE4);
  const other = record("pppp");
  e.deps.afterLock = () => saveFidelity(e.out, { "fa/a1": other }, { now: NOW });
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.ok(!calls(e.f).some((c) => c.body.model === "fa/a1"), "a1 was recorded by the other run and is not probed again");
  const s = loadFidelity(e.out).models;
  assert.deepEqual(s["fa/a1"], other, "and its record is still there after this run's saves");
  assert.deepEqual(Object.keys(s).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto"]);
  const e2 = env(FREE4);
  e2.deps.afterLock = () => saveFidelity(e2.out, Object.fromEntries(FREE4.map(([p, id]) => [`${p}/${id}`, record("ppnn")])), { now: NOW });
  const r2 = await run(["--live"], e2.deps);
  assert.match(r2.out, /another run finished the work while this one waited for the lock/);
  assert.equal(calls(e2.f).length, 0, "nothing sent");
});

test("a failed periodic save never stops the run and loses nothing: the records stay in memory and the next save carries them", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ["fa", `m${i}`]);
  const e = env(many);
  const CAPALL = ["--tf-max-tokens-per-provider", "1000000"];
  let n = 0;
  e.deps.saveImpl = (...a) => { n += 1; if (n === 1) throw new Error("disk hiccup"); return saveFidelity(...a); };
  const r = await run(["--live", ...CAPALL], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.err, /warning: could not save \(disk hiccup\)/);
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 30, "all 30 are in the file");
  assert.ok(n >= 2);
});

test("the FINAL save is retried; when it still fails the records go to a side file and the exit code says so, never a silent loss", async () => {
  const e = env(FREE4);
  let n = 0;
  e.deps.saveImpl = (...a) => { n += 1; if (n === 1) throw new Error("locked"); return saveFidelity(...a); };
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, "the second try of the final save worked");
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 4);
  const e2 = env(FREE4);
  e2.deps.saveImpl = () => { throw new Error("read-only volume"); };
  const r2 = await run(["--live"], e2.deps);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /ERROR: could not save tool-fidelity\.json \(read-only volume\); 4 new record\(s\) were written to .*tool-fidelity\.unsaved\.json instead/);
  assert.match(r2.out, /4 record\(s\) NOT saved/);
  const side = JSON.parse(fs.readFileSync(path.join(e2.dir, "tool-fidelity.unsaved.json"), "utf8"));
  assert.equal(side.kind, KIND);
  assert.deepEqual(Object.keys(side.models).sort(), ["fa/a1", "fa/a2", "fa/a3", "fa/auto"]);
  assert.ok(cleanFidelity(side.models["fa/a1"]), "and they are good records");
  assert.equal(rawExists(e2.out), false, "the real file was not half-written");
});

test("SPEND counts the levels a probe COMPLETED even when a later level errors: L1 done then L2 rate-limited is still charged", async () => {
  const e = env([["pb", "b1", { pin: 100, pout: 100 }], ["pb", "b2", { pin: 100, pout: 100 }], ["pb", "b3", { pin: 100, pout: 100 }]],
    { answer: (c) => (c.body.messages.length === 3 ? http(429, "slow down") : goodModel(c)) });
  const r = await run(["--live", "--max-spend", "5", "--max-row-cost", "5"], e.deps);
  assert.equal(r.code, 3, "no model answered ok in this run (every L2 was rate limited): the bench's own exit code for that");
  const m = r.out.match(/est\. spend \$([\d.]+) of the \$5\.00 cap/);
  assert.ok(m, r.out);
  // each model completed L1 and then hit the rate limit at L2, on every attempt; with pb's first answers rate limited the provider is paused after three
  assert.ok(Number(m[1]) > 0.05 && Number(m[1]) < 0.2, `completed L1 levels (about 318 in + 256 out tokens at $100 per million, about $0.057 each) are charged once each, though L2 never finished: ${m[1]}`);
  assert.match(r.out, /left alone for the rest of this run, their models stay pending: pb \(rate-limited\)/, "three rate limits in a row pause the provider");
  assert.deepEqual(Object.keys(loadFidelity(e.out).models), [], "and nothing was recorded for them");
});

test("a run narrowed with --only costs a model the same as a full run: an unlisted price on a free-labelled key is $0, a LISTED price keeps its listed cost", () => {
  const e = env([["pb", "priced", { pin: 50, pout: 100 }], ["pb", "unpriced", { pin: 1, pout: 1 }], ["fa", "free1"]]);
  e.deps.snapshot.snap.rows[0].models.find((m) => m.id === "unpriced").pin = null;
  e.deps.snapshot.snap.rows[0].models.find((m) => m.id === "unpriced").pout = null;
  const entry = (only, key) => plan({ snap: e.deps.snapshot.snap, bench: e.deps.bench, store: {}, tiers: e.deps.tiers, o: { ...parseArgs([]), only, maxRowCost: 100 } }).run.entries.find((x) => x.key === key);
  const narrow = entry(["pb/unpriced"], "pb/unpriced"), whole = entry(null, "pb/unpriced");
  assert.deepEqual([narrow.cost, whole.cost, narrow.free, narrow.unlistedOnFree], [0, 0, true, true], "no listed price on a key of tier free: costed at $0, narrowed or not");
  const listedNarrow = entry(["pb/priced"], "pb/priced"), listedWhole = entry(null, "pb/priced");
  assert.ok(listedNarrow.cost > 0 && Math.abs(listedNarrow.cost - listedWhole.cost) < 1e-12, "a listed price keeps its cost");
  assert.ok(Math.abs(listedNarrow.cost - ((listedNarrow.tin * 50 + listedNarrow.tout * 100) / 1e6)) < 1e-12, "at its own listed price (50 in, 100 out)");
  assert.equal(listedNarrow.pricedOnFree, true, "so the row ceiling applies to it");
});

test("provider names and ids are sanitised in everything printed: an escape sequence in a provider name never reaches the terminal", async () => {
  const evil = "ev\u001b[2J\u001b]52;c;aGk=\u0007il";
  const e = env([[evil, "m1"], ["fa", "a1"]]);
  const r = await run(["--only", `${evil},fa`], e.deps);
  assert.equal(r.code, 0, r.err);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(r.out + r.err), "no control character at all");
  assert.match(r.out, /evil|ev/, "the name is still shown, plainly");
  const none = await run(["--only", `${evil}/nosuch`], e.deps);
  assert.ok(!/\u001b/.test(none.err + none.out), "an --only that matches nothing is echoed sanitised");
});

test("a cap below ONE model's cost says what cap is needed: a warning in the dry run, a refusal live (nothing would run)", async () => {
  const e = env(FREE4);
  const dry = await run(["--tf-max-tokens-per-provider", "100"], e.deps);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /WARNING: 4 queued model\(s\) cost more than the cap on their own and will never run under it: raise --tf-max-tokens-per-provider to at least 5,6\d\d/);
  const live = await run(["--live", "--tf-max-tokens-per-provider", "100"], e.deps);
  assert.equal(live.code, 2);
  assert.match(live.err, /--tf-max-tokens-per-provider 100 is below the cost of one model for these levels: nothing would run\. Use at least 5,6\d\d/);
  assert.equal(e.f.calls.length, 0);
  const some = await run(["--live", "--tf-max-tokens-per-provider", "6000"], e.deps);
  assert.equal(some.code, 0, some.err);
  assert.equal(Object.keys(loadFidelity(e.out).models).length, 1, "6,000 tokens fits one model of about 5,670 per provider");
});

test("the BIG step: needs --l3 yes and a named provider; asked only of models that passed L3; a pass is `big: p`, a refusal is `big: f` with a size cap, a rate limit records nothing", async () => {
  const e = env([["fa", "a1"], ["fa", "a2"], ["fa", "a3"], ["fa", "a4"]], { answer: (c) => {
    if (c.bytes < 300000) return goodModel(c);
    if (c.body.model === "fa/a2") return http(400, "request too large");
    if (c.body.model === "fa/a3") return http(429, "slow down");
    return goodModel(c);
  } });
  saveAll(e, { "fa/a1": record("pppn"), "fa/a2": record("pppn"), "fa/a3": record("pppn"), "fa/a4": record("ppnn") });
  const dry = await run(["--levels", "5"], e.deps);
  assert.match(dry.out, /levels big/);
  assert.match(dry.out, /big 400 KB 1 req ~100k in, up to 512 out/);
  assert.match(dry.out, /3 model\(s\) queued of 4/, "a4 did not pass L3: not queued");
  assert.equal((await run(["--live", "--levels", "5"], e.deps)).code, 2);
  assert.equal((await run(["--live", "--levels", "5", "--l3", "yes"], e.deps, { raw: true })).code, 2, "and a named provider or a cap");
  const r = await run(["--live", "--levels", "5", "--l3", "yes", "--only", "fa", "--tf-max-tokens-per-provider", "400000"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a1"].big, s["fa/a1"].t, s["fa/a1"].capBelow, s["fa/a1"].maxBytes > 390000], ["p", "v", undefined, true]);
  assert.deepEqual([s["fa/a2"].big, s["fa/a2"].t, s["fa/a2"].capBelow], ["f", "v", 390000], "refused at 400 KB after 157 KB was fine: a cap, not a failure");
  assert.match(s["fa/a2"].why, /^L5: HTTP 400/);
  assert.equal(s["fa/a3"].big, undefined, "429: nothing recorded");
  assert.equal(s["fa/a4"].big, undefined);
  assert.ok(calls(e.f).every((c) => c.bytes > 390000), "only the big requests were sent");
  assert.ok(!calls(e.f).some((c) => c.body.model === "fa/a4"));
  const second = await run(["--live", "--levels", "5", "--l3", "yes", "--only", "fa", "--tf-max-tokens-per-provider", "400000"], { ...e.deps, fetch: fakeFetch(goodModel) });
  assert.equal(second.code, 0, second.err);
  assert.equal(loadFidelity(e.out).models["fa/a3"].big, "p", "the rate-limited one was picked up by the next run");
});

test("records this version cannot read are KEPT through a live run, not deleted", async () => {
  const e = env(FREE4);
  const odd = { lvr: "ppnn", future: "field", at: "2026-10-05T10:00:00.000Z" };
  fs.writeFileSync(e.out, JSON.stringify({ schema: 1, kind: KIND, generatedAt: "2026-10-05T10:00:00.000Z", models: { "zz/odd": odd, "fa/a1": record("ppnn") } }));
  const dry = await run([], e.deps);
  assert.match(dry.out, /note: 1 stored record\(s\) could not be read by this version; they stay in the file/);
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const raw = JSON.parse(fs.readFileSync(e.out, "utf8")).models;
  assert.deepEqual(raw["zz/odd"], odd, "byte for byte");
  assert.ok(raw["fa/a2"] && raw["fa/a1"]);
});

test("context length unknown is its own count in the report: 1 of the probe set, and the end-of-run line repeats it", async () => {
  const e = env([["fa", "a1"], ["fa", "a2", { ctx: null }], ["fa", "a3", { ctx: 0 }]]);
  const dry = await run([], e.deps);
  assert.match(dry.out, /context length unknown: 2 of 3 model\(s\) in the probe set/);
  const live = await run(["--live"], e.deps);
  assert.match(live.out, /context length unknown 2 of 3\b/);
});

test("TWO STRIKES at L3 end to end: a schema refusal of the 157 KB request is provisional the first time (class stays t), the second makes it x and it leaves every compiled list", async () => {
  const e = env([["fa", "a1"], ["fa", "a2"]], { answer: (c) => (kindOf(c) === "3b" ? http(400, "tools[3].input_schema: unsupported keyword anyOf") : goodModel(c)) });
  saveAll(e, { "fa/a1": record("ppnn"), "fa/a2": record("ppnn") });
  const args = ["--live", "--levels", "34", "--l3", "yes", "--only", "fa", "--tf-max-tokens-per-provider", "200000"];
  const first = await run(args, e.deps);
  assert.equal(first.code, 0, first.err + first.out);
  let s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a1"].lvr, s["fa/a1"].t, s["fa/a1"].strikes, s["fa/a1"].sl], ["ppnn", "t", 1, 3], "provisional: still t");
  const nCalls = calls(e.f).length;
  const second = await run(args, e.deps);
  assert.equal(second.code, 0, second.err + second.out);
  assert.equal(calls(e.f).length - nCalls, 4, "only the struck level (L3: 3a and 3b) is asked again, for each of the two models");
  s = loadFidelity(e.out).models;
  assert.deepEqual([s["fa/a1"].lvr, s["fa/a1"].t, s["fa/a1"].strikes, s["fa/a1"].ok, s["fa/a1"].d3], ["ppfn", "x", 2, false, "b"]);
  assert.ok(cleanFidelity(s["fa/a1"]));
  const third = await run(args, e.deps);
  assert.match(third.out, /nothing to probe/);
  // the compiler leaves it out
  const rows = e.rows;
  const providers = [{ name: "fa", enabled: true, models: ["a1", "a2"] }];
  const res = funnel({ rows, bench: { get: () => ({ s: "ok", a: 1790699779, t: 400 }), isLive: () => false }, nowMs: 1790700000000, providers, tiers: { fa: "free" }, toolFidelity: { models: s } },
    { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [] });
  assert.deepEqual(res.models.map((m) => m.s), [], "both confirmed x: in no list");
});

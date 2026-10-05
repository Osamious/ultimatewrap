// The pilot-run fixes of the tool-fidelity probe: adaptive timeouts (3 x the bench time between a floor and a cap), the doubled retry, `pending: slow`, the heartbeat, the per-provider timeout
// table, honest calibration, the providers-needing-attention block and the saves on SIGINT. Offline: fixtures only, a fake gateway that honours the abort signal, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http } from "./fixtures/tool-fidelity-helpers.mjs";
import { probeModel, MAX_MODEL_REQUESTS, TIMEOUTS_MS, TIMEOUT_CAPS_MS, TIMEOUT_FACTOR, timeoutsFor } from "../refresh/tool-fidelity-probe.mjs";
import { main } from "../refresh/tool-fidelity-cli.mjs";
import { loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const FREE = { tier: "free" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the numbers

test("the timeout numbers are pinned: floors 45 / 90 / 120 s, caps 120 / 180 / 240 s, 3 x the bench time; the request ceiling is 12 (a decision, not an edit)", () => {
  assert.deepEqual({ ...TIMEOUTS_MS }, { small: 45000, "157": 90000, big: 120000 });
  assert.deepEqual({ ...TIMEOUT_CAPS_MS }, { small: 120000, "157": 180000, big: 240000 });
  assert.equal(TIMEOUT_FACTOR, 3);
  assert.equal(MAX_MODEL_REQUESTS, 12);
});

test("timeoutsFor: 3 x the model's bench total time, clamped between the floor and the cap of each request class; the floors with no usable bench time", () => {
  assert.deepEqual(timeoutsFor(null), { small: 45000, "157": 90000, big: 120000 }, "no record: the floors");
  for (const bad of [{}, { d: 0 }, { d: -5 }, { d: NaN }, { d: "8" }, { d: null }]) assert.deepEqual(timeoutsFor(bad), { small: 45000, "157": 90000, big: 120000 }, JSON.stringify(bad));
  assert.deepEqual(timeoutsFor({ d: 8472 }), { small: 45000, "157": 90000, big: 120000 }, "3 x 8.5 s is below every floor");
  assert.deepEqual(timeoutsFor({ d: 20000 }), { small: 60000, "157": 90000, big: 120000 }, "3 x 20 s = 60 s is above the small floor only");
  assert.deepEqual(timeoutsFor({ d: 40000 }), { small: 120000, "157": 120000, big: 120000 }, "3 x 40 s = 120 s: the small cap, above the 157 KB floor, equal to the big floor");
  assert.deepEqual(timeoutsFor({ d: 100000 }), { small: 120000, "157": 180000, big: 240000 }, "a slow model is capped");
  assert.deepEqual(timeoutsFor({ d: 1 }, { small: 10, "157": 20, big: 30 }, { small: 100, "157": 200, big: 300 }), { small: 10, "157": 20, big: 30 }, "floors and caps are arguments");
  assert.deepEqual(timeoutsFor({ d: 1e9 }, { small: 10, "157": 20, big: 30 }, { small: 100, "157": 200, big: 300 }), { small: 100, "157": 200, big: 300 });
});

// ---------------------------------------------------------------- the engine: a timeout is asked once more at double, never a verdict

/** A fetch that answers like goodModel after `delay(call)` ms and honours the abort signal (a real fetch does). */
function slowFetch(delayOf) {
  const inner = fakeFetch(goodModel), attempts = [];
  const f = (url, init = {}) => new Promise((resolve, reject) => {
    const body = init.body ? JSON.parse(init.body) : null;
    attempts.push({ url: String(url), body });                               // every ATTEMPT, also the ones that are aborted before they are answered
    const wait = String(url).endsWith("/health") ? 0 : delayOf(body);
    const t = setTimeout(() => inner(url, init).then(resolve, reject), wait);
    init.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
  f.calls = attempts;
  return f;
}
const conn = (f, timeouts, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", timeouts, ...extra });
const T = { small: 50, "157": 50, big: 50 };

test("a timeout is asked ONCE more at double the time inside the same run: the second attempt passes and the model gets a verdict; the doubled time stays for its later requests", async () => {
  let n = 0;
  const f = slowFetch(() => (++n === 1 ? 500 : 80));                  // the first request is slower than 50 ms; every later one takes 80 ms: more than 50, less than the doubled 100
  const done = {}, state = {};
  const r = await probeModel({ levels: [1, 2], done, state, ...FREE, ...conn(f, T) });
  assert.equal(r.inconclusive, undefined, "a verdict, not a timeout");
  assert.deepEqual([done[1].v, done[2].v], ["p", "p"]);
  assert.equal(state.tmult, 2);
  assert.equal(f.calls.length, 4, "L1 twice (the first timed out), then 1a and L2 once each at the doubled time (80 ms would have timed out at 50)");
  assert.equal(r.requests, 4, "the timed-out request counts toward the model's request ceiling");
  assert.equal(state.requests, 4);
});

test("a second timeout at the doubled value on L1 makes the model `slow` (pending, never a verdict, the seconds it was given); on any other level it is a plain timeout; nothing is recorded", async () => {
  const f = slowFetch(() => 1000);
  const done = {}, state = {};
  const r = await probeModel({ levels: [1, 2], done, state, ...FREE, ...conn(f, T) });
  assert.deepEqual([r.inconclusive.s, r.inconclusive.reason, r.inconclusive.secs], ["timeout", "slow", 0.1], "doubled from 50 ms to 100 ms");
  assert.equal(f.calls.length, 2, "exactly two requests: the original and the doubled retry, then the scheduler moves on");
  assert.equal(done[1], undefined, "no verdict");
  const g = slowFetch((b) => (b.messages.length === 1 ? 0 : 1000));    // L1 is fast; L2 (a longer conversation) never answers
  const d2 = {}, s2 = {};
  const r2 = await probeModel({ levels: [1, 2], done: d2, state: s2, ...FREE, ...conn(g, T) });
  assert.deepEqual([r2.inconclusive.s, r2.inconclusive.reason], ["timeout", undefined], "L2 timing out twice is a plain timeout, not `slow`");
  assert.equal(d2[1].v, "p", "what was learned before is kept");
  const h = slowFetch(() => 1000), s3 = {};
  const r3 = await probeModel({ levels: [3], prior: "ppnn", done: {}, state: s3, ...FREE, ...conn(h, T) });
  assert.equal(r3.inconclusive.s, "timeout");
  assert.equal(r3.inconclusive.reason, undefined);
});

test("the timeout retry cannot loop: a model whose every request times out sends exactly two requests, and a retry still obeys the request ceiling", async () => {
  const f = slowFetch(() => 1000);
  await probeModel({ levels: [1, 2, 3, 4, 5, 6, 7], done: {}, state: {}, ...FREE, ...conn(f, T) });
  assert.equal(f.calls.length, 2);
  const g = slowFetch(() => 1000);
  const r = await probeModel({ levels: [1], done: {}, state: { requests: MAX_MODEL_REQUESTS - 1 }, ...FREE, ...conn(g, T) });
  assert.equal(g.calls.length, 1, "one request was left in the budget: the doubled retry is not sent");
  assert.equal(r.inconclusive.reason, "request-cap");
});

// ---------------------------------------------------------------- the CLI

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
function env(rows, { fetch, now = NOW, bench, tiers, deps: extra = {} } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fetch ?? fakeFetch(goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: bench ?? { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: tiers ?? Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => now,
    isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1, ...extra };
  return { dir, deps, f, out: deps.outFile };
}
const SMALL = ["--timeout-small", "0.05", "--timeout-max-small", "0.2"];
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
const WORLD = () => [{ provider: "fa", keyId: "k.fa.free", models: [m("slow1"), m("ok1"), m("late1")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1")] }];

test("a model whose L1 times out twice is `pending: slow` with the seconds it was given (never a verdict, charged nothing); one that is merely late passes after the doubled retry; the other models are not held up", async () => {
  const f = slowFetch((b) => (b.model === "fa/slow1" ? 1000 : b.model === "fa/late1" ? 80 : 0));
  const e = env(WORLD(), { fetch: f });
  const r = await run(["--live", "--per-provider", "1", ...SMALL], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["fa/slow1"].r, "slow");
  assert.equal(st.models["fa/slow1"], undefined, "no record: slowness is not a verdict");
  assert.ok(st.models["fa/ok1"] && st.models["fa/late1"] && st.models["fb/b1"], "late models pass after the doubled retry; other providers go on");
  assert.equal(calls(f).filter((c) => c.body.model === "fa/slow1").length, 2, "the original and the doubled retry, then it moves on");
  assert.equal(calls(f).filter((c) => c.body.model === "fa/late1").length, 4, "L1 twice (the first timed out), argument fidelity once, L2 once");
  assert.match(r.out, /pending: slow \(the L1 request timed out twice, at the doubled time; never a verdict, a later run asks again\): fa\/slow1 \(0\.1 s\)/);
  assert.match(r.out, /provider latency where requests timed out/);
  assert.match(r.out, /fa\s+3 timeout\(s\) of \d+ request\(s\), median [\d.]+ s, max [\d.]+ s, slow 1/, "a slow provider reads as slow in the per-provider table");
  assert.match(r.out, /est\. spend \$0\.000 of/, "time-outs are charged nothing");
  assert.match(r.out, /coverage L1\+L2 .*pending [\d,]+ \(.*slow 1/, "the ledger counts it as pending slow");
});

test("the dry run prints the adaptive timeouts: the factor, the floors and caps, and this run's range from the bench times; a bench time moves a model's timeout", async () => {
  const rows = WORLD();
  const bench = { get: (k) => (k === "fa/slow1" ? { s: "ok", t: 400, d: 30000, a: 1790699779 } : { s: "ok", t: 400, d: 9000, a: 1790699779 }) };
  const e = env(rows, { bench });
  const r = await run([], e.deps);
  assert.match(r.out, /timeouts: adaptive per model, 3 x its bench time, small 45-120 s, 157 KB 90-180 s, 400 KB 120-240 s \(this run's small requests: 45 s at the least, 45 s median, 90 s at the most; a timeout is asked once more at double, then pending timeout, or slow on L1: never a verdict\)/);
  assert.equal(calls(e.f).length, 0);
});

test("the calibration line says `no usage` when no request reported any (it used to print a 0.00 ratio)", async () => {
  const f = slowFetch(() => 1000);
  const e = env(WORLD(), { fetch: f });
  const r = await run(["--live", ...SMALL], e.deps);
  assert.match(r.out, /calibration \(this run, not stored\): input tokens actual\/estimate n\/a, output actual\/budget n\/a over 0 of \d+ request\(s\) that reported usage \(no usage was reported by any request: these ratios say nothing\)/);
  assert.doesNotMatch(r.out, /actual\/estimate 0\.00/);
});

test("the HEARTBEAT: a long live run prints one line per interval with the progress, requests, timeouts, tokens against the estimate, who is active and who is paused; it stops when the run ends", async () => {
  const f = slowFetch(() => 60);
  const e = env(WORLD(), { fetch: f, deps: { heartbeatMs: 25 } });
  const r = await run(["--live", "--per-provider", "1", ...SMALL, "--timeout-small", "1", "--timeout-max-small", "2"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const beats = r.out.split("\n").filter((l) => l.includes("[heartbeat"));
  assert.ok(beats.length >= 2, `${beats.length} heartbeat line(s)`);
  assert.match(beats[0], /\[heartbeat [^\]]+\] models: \d+ recorded, \d+ attempted of 4 queued; requests \d+ of ~\d+ \(\d+ timed out\); (no usage reported yet|[\d.k]+ in \/ [\d.k]+ out reported so far) \(estimate for the run ~[\d.k]+ in\); active: .*; paused: none/);
  assert.match(beats.at(-1), /models: [1-4] recorded/, "the progress moves");
  const before = beats.length;
  await sleep(120);
  assert.equal(before, r.out.split("\n").filter((l) => l.includes("[heartbeat")).length, "no heartbeat after the run ended (captured output is final)");
});

test("the heartbeat names a provider that is paused (rate or canary) so a long sweep is never silent about it", async () => {
  const f = slowFetch(() => 40);
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1"), m("b2"), m("b3")] }];
  const e = env(rows, { fetch: f });
  const wrapped = (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body?.model?.startsWith("fa/")) return Promise.resolve(new Response(JSON.stringify({ error: { message: "no credit" } }), { status: 402, headers: {} }));
    return f(url, init);
  };
  wrapped.calls = f.calls;
  e.deps.fetch = wrapped;
  e.deps.heartbeatMs = 15;
  const r = await run(["--live", "--per-provider", "1", ...SMALL, "--timeout-small", "1", "--timeout-max-small", "2"], e.deps);
  const beats = r.out.split("\n").filter((l) => l.includes("[heartbeat"));
  assert.ok(beats.some((l) => /paused: pay 1/.test(l)), beats.join("\n"));
});

test("SIGINT flushes the finished records to the file BEFORE anything else happens (not only at the end)", async () => {
  const f = slowFetch(() => 40);
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: Array.from({ length: 6 }, (_, i) => m(`s${i}`)) }];
  const e = env(rows, { fetch: f, deps: { heartbeatMs: 10 } });
  const out = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => out.push(a.join(" "));
  let flushed = null, code;
  try {
    const running = main(["--live", "--per-provider", "1", "--timeout-small", "1", "--timeout-max-small", "2"], e.deps);
    for (let i = 0; i < 400 && !out.some((l) => /\[heartbeat[^\]]*\] models: [1-9]\d* recorded/.test(l)); i++) await sleep(10);
    assert.deepEqual(Object.keys(loadFidelity(e.out).models), [], "nothing was written yet: the periodic save is far off");
    process.emit("SIGINT");
    flushed = Object.keys(loadFidelity(e.out).models).length;           // read synchronously, before the stopped run has done anything else
    code = await running;
  } finally { console.log = lg; console.error = er; }
  assert.ok(flushed >= 1, `${flushed} record(s) were already in the file when the signal handler returned`);
  assert.ok(out.some((l) => /stopping/.test(l)));
  assert.ok(code === 0 || code === 3 || code === 1, `exit ${code}`);
  assert.ok(Object.keys(loadFidelity(e.out).models).length >= flushed, "and the run's own final save keeps them");
});

test("providers needing attention: a free-labelled provider whose canary is auth, pay or gone is named with its state and how many models were skipped; nothing is retried in the run", async () => {
  for (const [status, why] of [[401, "auth"], [402, "pay"], [404, "gone"]]) {
    const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1")] }];
    const inner = fakeFetch(goodModel);
    const e = env(rows, { fetch: async (url, init) => { const b = init?.body ? JSON.parse(init.body) : null; return b?.model?.startsWith("fa/") ? new Response(JSON.stringify({ error: { message: "nope" } }), { status }) : inner(url, init); } });
    const r = await run(["--live", "--per-provider", "1"], e.deps);
    assert.match(r.out, /providers needing attention \(an account state, not a verdict on any model; fix the account, then run again; nothing was retried in this run\):/);
    assert.match(r.out, new RegExp(`fa: ${why} \\(.*\\) -- 3 model\\(s\\) skipped`));
    assert.doesNotMatch(r.out, /fb: (auth|pay|gone)/);
    assert.ok(loadFidelity(e.out).models["fb/b1"], "other providers go on");
  }
});

test("the stale comment is gone: describeTiers says a non-free tier is NOT probed at all", () => {
  const src = fs.readFileSync(new URL("../refresh/tool-fidelity.mjs", import.meta.url), "utf8");
  const at = src.indexOf("export function describeTiers");
  const doc = src.slice(src.lastIndexOf("/**", at), at);
  assert.match(doc, /NOT probed at all/);
  assert.doesNotMatch(doc, /get L1\+L2 only/);
});

test("a usage block that reports ZERO input tokens is not a measurement: the input ratio stays n/a (it used to print 0.00 and read as a 100% miss)", async () => {
  const f = fakeFetch((c) => { const a = goodModel(c); return { ...a, body: String(a.body).replace('"role":"assistant"', '"role":"assistant","usage":{"input_tokens":0}') }; });
  const e = env([{ provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2")] }], { fetch: f });
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /calibration \(this run, not stored\): input tokens actual\/estimate n\/a, output actual\/budget 0\.\d\d over \d+ of \d+ request\(s\) that reported usage; /);
  assert.doesNotMatch(r.out, /actual\/estimate 0\.00/);
});

test("the CLI applies the ADAPTIVE timeout per model from the bench: a model whose bench time is long is given long enough, an unknown one only the floor; and a timed-out request is charged nothing even for a priced model", async () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("known"), m("unknown"), m("pricey", { badge: "PAID", pin: 100, pout: 100 })] }];
  const bench = { get: (k) => (k === "fa/known" ? { s: "ok", t: 400, d: 100, a: 1790699779 } : /^fa\//.test(k) ? { s: "ok", t: 400, a: 1790699779 } : null) };
  const f = slowFetch((b) => (b.model === "fa/pricey" ? 1000 : 150));        // known: 3 x 100 ms = 300 ms, capped at 200 ms: enough for 150 ms. unknown: the 50 ms floor, doubled to 100 ms: not enough
  const e = env(rows, { fetch: f, bench });
  const r = await run(["--live", "--per-provider", "1", "--max-spend", "5", "--max-row-cost", "5", ...SMALL], e.deps);
  assert.equal(r.code, 3, "partial: two models stayed pending (the bench exit code for that)");
  const st = loadFidelity(e.out);
  assert.ok(st.models["fa/known"], "its own bench time gave it room");
  assert.equal(calls(f).filter((c) => c.body.model === "fa/known").length, 3, "L1, argument fidelity and L2, no timeout at all");
  assert.equal(st.pending["fa/unknown"].r, "slow", "no bench time: the floor only");
  assert.equal(st.pending["fa/pricey"].r, "slow");
  assert.match(r.out, /est\. spend \$0\.000 of the \$5\.00 cap/, "the priced model that only ever timed out (four requests at $100 per million) cost nothing");
});

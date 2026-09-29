// #114: a probe may now be given 240 s. Nothing that waits on a probe (Ctrl-C, the wall-clock
// stop, the outage hold, the other providers) may wait 240 s with it. A small DISCRETE-EVENT
// clock drives these: timers fire in time order and only when nothing else can run, so a run
// that "takes" hours finishes in milliseconds and the timing assertions are exact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeOne, runSweep } from "../refresh/bench.mjs";
import { fmtMs, TRANSIENT } from "../menu/bench-data.mjs";
import { isFresh, toStored } from "../refresh/bench-store.mjs";

function sim() {
  const q = []; let t = 1_000_000, pending = false, seq = 0;
  const schedule = () => { if (pending) return; pending = true; setImmediate(() => { pending = false; step(); }); };
  const step = () => {
    const live = q.filter((h) => h.live).sort((a, b) => a.at - b.at || a.seq - b.seq);
    q.length = 0; q.push(...live);
    const h = q.shift();
    if (!h) return;
    t = Math.max(t, h.at); h.live = false; h.fn(); schedule();
  };
  const timers = {
    set: (fn, ms) => { const h = { at: t + Math.max(0, ms), fn, live: true, seq: seq++ }; q.push(h); schedule(); return h; },
    clear: (h) => { if (h) h.live = false; },
  };
  return { now: () => t, timers, t0: t };
}

/** Resolves `value` after `ms` of simulated time, or `{ aborted: true }` the moment any of `signals` fires. */
const after = (sm, ms, value, ...signals) => new Promise((resolve) => {
  const h = sm.timers.set(() => resolve(value), ms);
  for (const sg of signals.filter(Boolean)) {
    const stop = () => { sm.timers.clear(h); resolve({ aborted: true }); };
    if (sg.aborted) return stop();
    sg.addEventListener("abort", stop, { once: true });
  }
});

const rows = (p, n, over = {}) => Array.from({ length: n }, (_, i) => ({ key: `${p}/m${i}`, provider: p, id: `m${i}`, free: true, cost: 0, worst: 0, ...over }));
const OK = { s: "ok", t: 1, d: 2, o: 5, p: "hi", k: 0 };
const TIMEOUT = { s: "timeout", d: 240000, m: "no complete answer within 240000 ms" };
const collect = () => { const out = []; return { out, onResult: (r) => out.push(r) }; };

// ------------------------------------------------------- probeOne, real deadline

test("probeOne: the default deadline is 240 s; the record keeps d = the deadline and the picker renders it `240s`", async (tc) => {
  tc.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const fetchImpl = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const p = probeOne({ fetchImpl, url: "u", key: "k", model: "p/m", now: () => now });
  let settled = false; p.then(() => { settled = true; });
  now = 239_999; tc.mock.timers.tick(239_999);
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, "still waiting one millisecond before 240 s");
  now = 240_000; tc.mock.timers.tick(1);
  const r = await p;
  assert.equal(r.s, "timeout");
  assert.equal(r.d, 240000);
  assert.match(r.m, /no complete answer within 240000 ms/);
  assert.equal(fmtMs(r.d), "240s", "a five-character cell, not clipped or wrapped");
  assert.equal(fmtMs(35000), "35.0s");
  assert.equal([...fmtMs(240000)].length <= 5, true);
  assert.equal(TRANSIENT.has("timeout"), true, "a timeout is still transient: it is re-probed, never trusted");
  assert.equal(isFresh({ s: "timeout", a: 1790000000 }, { ttlMs: 7 * 864e5, nowMs: 1790000100 * 1000 }), false);
  assert.equal(toStored({ s: "timeout", d: 240000, a: 5, m: r.m }).d, 240000);
});

test("probeOne: an abort answers at once, whatever is left of the 240 s, and the deadline timer is released", async (tc) => {
  tc.mock.timers.enable({ apis: ["setTimeout"] });
  const ac = new AbortController();
  const fetchImpl = (_u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const p = probeOne({ fetchImpl, url: "u", key: "k", model: "p/m", signal: ac.signal });
  tc.mock.timers.tick(1000);
  ac.abort();
  assert.deepEqual(await p, { aborted: true });
  tc.mock.timers.tick(240_000);           // the released deadline timer must not fire into a finished probe
  assert.deepEqual(await p, { aborted: true });
});

// ----------------------------------------------- nothing waits on a hung probe

test("the wall-clock stop drops probes still in flight: the run ends at the limit, not 240 s after it", async () => {
  const sm = sim();
  const { out, onResult } = collect();
  const sum = await runSweep({
    groups: new Map([["p", rows("p", 50)]]), onResult, probeAll: true, coolAfter: 1000, concurrency: 2, perProvider: 2,
    maxRetries: { rate: 0, other: 0 }, maxMs: 600_000, now: sm.now, timers: sm.timers,
    probe: (t, ctx) => after(sm, 240_000, TIMEOUT, ctx.signal),
  });
  assert.equal(sum.stopped, "time"); assert.equal(sum.aborted, true);
  assert.ok(sm.now() - sm.t0 <= 601_000, `ended ${(sm.now() - sm.t0) / 1000} s in, for a 600 s limit`);
  assert.equal(out.length, 3, "the canary at 240 s and the pair at 480 s; the pair in flight at 600 s was dropped, not waited for");
  assert.ok(out.every((r) => r.s === "timeout"));
});

test("Ctrl-C mid-hang ends the run at once, not after the 240 s deadline", async () => {
  const sm = sim();
  const ac = new AbortController();
  sm.timers.set(() => ac.abort(), 100_000);
  const { out, onResult } = collect();
  const sum = await runSweep({
    groups: new Map([["p", rows("p", 20)], ["q", rows("q", 20)]]), onResult, signal: ac.signal, probeAll: true, coolAfter: 1000,
    now: sm.now, timers: sm.timers, probe: (t, ctx) => after(sm, 240_000, TIMEOUT, ctx.signal, ac.signal),
  });
  assert.equal(sum.stopped, "signal");
  assert.ok(sm.now() - sm.t0 <= 100_500, `${(sm.now() - sm.t0) / 1000} s`);
  assert.equal(out.length, 0, "the hung probes were dropped, not recorded");
});

test("a confirmed outage frees the hung probes' slots at once and puts their rows back; recovery does not have to wait out 240 s", async () => {
  const sm = sim();
  const gw = { up: true, downPolls: 0 };
  sm.timers.set(() => { gw.up = false; }, 30_000);                       // the gateway dies 30 s in
  const { out, onResult } = collect();
  const sum = await runSweep({
    groups: new Map(["a", "b", "c"].map((p) => [p, rows(p, 12)])), onResult, probeAll: true, coolAfter: 1000,
    concurrency: 6, perProvider: 2, maxRetries: { rate: 0, other: 0 }, now: sm.now, timers: sm.timers,
    // launched while the gateway is up: answers in 10 s. Launched while it is down: hangs to the deadline.
    probe: (t, ctx) => (gw.up ? after(sm, 10_000, OK, ctx.signal) : after(sm, 240_000, TIMEOUT, ctx.signal)),
    gatewayCheck: async () => { if (!gw.up && ++gw.downPolls >= 3) gw.up = true; return gw.up; },
    outageAfter: 1000, outageIdleMs: 300_000, outagePollMs: 10_000,
  });
  assert.equal(sum.outage.events, 1, "detected by the idle rule: the consecutive-results rule (1000) could not");
  assert.equal(out.filter((r) => r.s !== "ok").length, 0, "no timeout was recorded for a failure the gateway caused");
  assert.equal(out.length, 36); assert.equal(new Set(out.map((r) => r.key)).size, 36);
  assert.ok(sum.outage.requeued >= 1);
  // 30 s + 300 s of silence, two 10 s polls, then ~60 s of real work: nowhere near a 240 s wait per row
  assert.ok(sm.now() - sm.t0 < 480_000, `${(sm.now() - sm.t0) / 1000} s`);
});

test("a probe sent before an outage that only fails AFTER recovery is put back, not recorded (the outage epoch)", async () => {
  const sm = sim();
  const gw = { up: true, polls: 0 };
  let hangB;
  const { out, onResult } = collect();
  sm.timers.set(() => { gw.up = false; }, 5_000);
  const sum = await runSweep({
    groups: new Map([["a", rows("a", 12)], ["b", rows("b", 2)]]), onResult, probeAll: true, coolAfter: 1000,
    concurrency: 4, perProvider: 2, maxRetries: { rate: 0, other: 0 }, now: sm.now, timers: sm.timers,
    // b's first probe ignores its abort and only "times out" at 400 s, long after recovery
    probe: (t, ctx) => {
      if (t.key === "b/m0" && !hangB) { hangB = true; return after(sm, 400_000, TIMEOUT); }
      return gw.up ? after(sm, 3000, OK, ctx.signal) : after(sm, 2000, { s: "error", p: "bad gateway" }, ctx.signal);
    },
    gatewayCheck: async () => { if (!gw.up && ++gw.polls >= 2) gw.up = true; return gw.up; },
    outageAfter: 6, outagePollMs: 10_000,
  });
  assert.ok(sum.outage.events >= 1);
  assert.equal(out.filter((r) => r.s !== "ok").length, 0, "neither the gateway's errors nor b's late timeout was recorded");
  assert.equal(out.length, 14);
});

// ------------------------------------------------ cooling and 240 s deadlines

test("a cooled provider whose probes all hang for 240 s starves nobody and does not deadlock the run", async () => {
  const sm = sim();
  const { out, onResult } = collect();
  let badInflight = 0, badMaxWhileCooled = 0, badResults = 0, badAtGoodDone = null, goodDone = 0;
  const sum = await runSweep({
    groups: new Map([["bad", rows("bad", 12)], ["good", rows("good", 40)]]), probeAll: true, coolAfter: 3, coolGapMs: 400,
    concurrency: 8, perProvider: 2, maxRetries: { rate: 0, other: 0 }, now: sm.now, timers: sm.timers,
    onResult: (r) => {
      out.push(r);
      if (r.provider === "bad") badResults += 1;
      else if (++goodDone === 40) badAtGoodDone = badResults;
    },
    probe: async (t, ctx) => {
      if (t.provider === "good") return after(sm, 5000, OK, ctx.signal);
      badInflight += 1;
      if (badResults >= 3) badMaxWhileCooled = Math.max(badMaxWhileCooled, badInflight);
      try { return await after(sm, 240_000, TIMEOUT, ctx.signal); } finally { badInflight -= 1; }
    },
  });
  assert.equal(out.filter((r) => r.provider === "good" && r.s === "ok").length, 40, "the healthy provider finished every row");
  assert.ok(badAtGoodDone < 12, `the healthy provider was done while the hung one still had rows left (${badAtGoodDone} of 12 recorded)`);
  assert.equal(out.filter((r) => r.provider === "bad").length, 12, "and the hung provider's rows were all probed, none skipped");
  assert.equal(out.filter((r) => r.s === "skip").length, 0);
  assert.ok(badMaxWhileCooled <= 1, `cooled: ${badMaxWhileCooled} in flight at once`);
  assert.deepEqual(sum.cooled, ["bad"]);
  assert.equal(sum.stopped, null);
});

test("a wait longer than setTimeout allows is clamped, so a huge --max-minutes cannot break the wake timer", async () => {
  const seen = [];
  const sm = sim();
  const timers = { set: (fn, ms) => { seen.push(ms); return sm.timers.set(fn, Math.min(ms, 1000)); }, clear: sm.timers.clear };
  await runSweep({
    groups: new Map([["p", rows("p", 2)]]), onResult: () => {}, maxMs: 5e12, now: sm.now, timers,
    probe: (t, ctx) => after(sm, 1000, OK, ctx.signal),
  });
  assert.ok(seen.length > 0 && seen.every((ms) => ms <= 2 ** 31 - 1), `largest wait ${Math.max(...seen)} ms`);
});

// The sweep engine's wake timer (refresh/bench.mjs runSweep). When every provider is paused the engine parks on a wake timer; it must arm one for the end of each pause. It used to read the
// clock twice per pass (once to decide a provider is not ready yet, once to work out when to wake), so a pause that ended between the two readings left NO timer for that provider, and the only wake
// left was the max-minutes backstop (150 minutes): the run hung. Deterministic here: a fake clock that advances by one millisecond on every reading, fake timers that are only recorded (nothing
// real is scheduled), and microtask flushes instead of waiting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSweep } from "../refresh/bench.mjs";

const flush = async () => { for (let i = 0; i < 50; i += 1) await Promise.resolve(); };
const BACKSTOP = 150 * 60000;
const target = { key: "pa/m", provider: "pa", id: "m", free: true, cost: 0, worst: 0 };

async function pausedOnce(backoffMs) {
  let t = 1000;
  const now = () => t++;                                             // every reading moves the clock by 1 ms
  const armed = [];
  const timers = { set: (fn, ms) => { armed.push({ fn, ms }); return armed.length; }, clear: () => {} };
  let calls = 0;
  const probe = async () => (++calls === 1 ? { s: "rate" } : { s: "ok" });      // the first request is rate limited, the retry answers
  const run = runSweep({ groups: new Map([["pa", [{ ...target }]]]), probe, now, backoffBaseMs: backoffMs, backoffMaxMs: backoffMs, coolGapMs: 1, maxMs: BACKSTOP, timers, concurrency: 1, perProvider: 1 });
  await flush();
  return { armed, run, calls: () => calls, advance: (ms) => { t += ms; } };
}

test("runSweep arms a wake timer for the end of a provider's pause even when the pause ends between the launch pass and the wake reading (a 3 ms backoff on a 1 ms clock)", async () => {
  const x = await pausedOnce(3);
  const wakes = x.armed.slice(1);                                    // the first timer is the loop's first pass; what follows is armed after the rate limit
  assert.ok(wakes.length >= 1 && wakes.every((w) => w.ms < 60000), `the only wake armed after the rate limit was ${wakes.map((w) => w.ms)} ms: the engine would sleep until the ${BACKSTOP} ms backstop`);
  assert.equal(x.calls(), 1, "the retry waits for the pause");
  x.advance(1000);
  x.armed.at(-1).fn();                                               // the wake fires
  const res = await x.run;
  assert.equal(x.calls(), 2, "the model was asked again");
  assert.equal(res.counts.ok, 1);
});

test("runSweep wake timers for a pause: the delay is the time left (a few ms for a few-ms backoff), whichever way the clock falls", async () => {
  for (const backoff of [1, 2, 3, 4, 5, 8]) {
    const x = await pausedOnce(backoff);
    if (x.calls() === 2) { assert.equal((await x.run).counts.ok, 1, `backoff ${backoff}: finished without a timer`); continue; }       // the pause had already ended at the next pass: no wait at all
    const last = x.armed.at(-1);
    assert.ok(last.ms <= backoff + 2, `backoff ${backoff} ms: wake armed for ${last.ms} ms`);
    x.advance(1000);
    last.fn();
    const res = await x.run;
    assert.deepEqual([x.calls(), res.counts.ok], [2, 1], `backoff ${backoff}`);
  }
});

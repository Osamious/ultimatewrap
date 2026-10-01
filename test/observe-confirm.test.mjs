// Live status C4 (plan D): the confirmation probe of a failing -> ok flip. Fake gateway, fake fetch, fake spawn, temp directories and a
// temp sqlite: nothing here sends a request, spawns a process, or touches the real router data or the real state/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runConfirm, requestConfirms, spawnConfirms, acquireLockRetry, readOverlay, isConfirmKey } from "../refresh/observe.mjs";
import { main } from "../refresh/observe-cli.mjs";
import { mkEnv, writeBench, fake, fakeCore, T0, NOW, iso, epoch } from "./fixtures/observe-fixture.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDERS = {
  prov: ["m1", "m2", "m3", "m4", "cheap", { id: "pricey", pin: 100, pout: 500 }, { id: "free1", badge: "FREE" }, { id: "cheap2", pin: 0.1, pout: 0.2 }],
  anthropic: ["claude-sonnet-5"], other: ["x"], third: ["y"],
};
const world = () => mkEnv({ providers: PROVIDERS });
const DAY = "2026-09-30";
const nowS = epoch(NOW);

/** Write an overlay by hand: `models` as given, reservations for `reserved` keys, plus any overrides. */
function seed(e, models, { reserved = [], confDay = { d: DAY, n: reserved.length }, conf = {} } = {}) {
  const c = { ...conf };
  for (const k of reserved) c[k] = nowS;
  fs.writeFileSync(e.P.overlay, JSON.stringify({ schema: 1, writtenAt: iso(NOW), feed: "ok", wm: null, tagId: null, models, pend: {}, conf: c, confDay }));
}
const flipRec = (o = {}) => ({ s: "ok", d: 400, a: nowS - 30, q: "flip-q", l: 1, o: 5, cf: 1, cfa: nowS, ...o });

const NOWC = NOW + 5000;
function harness(e, extra = {}) {
  const calls = { probe: [], health: [] };
  const opts = { stateDir: e.stateDir, snapshotFile: e.snapshotFile, benchFile: e.benchFile, nowMs: NOWC, bake: null,
    gateway: { base: "http://gw.test", key: "gw-key" }, health: async (b) => { calls.health.push(b); return true; }, sleep: () => {}, ...extra };
  return { calls, opts };
}
const reply = (over) => ({ s: "ok", t: 300, d: 900, r: 12.5, o: 6, p: "Hello there, how are you", k: 0, ...over });
const probeReturning = (res) => { const seen = []; const fn = async (a) => { seen.push(a); return res; }; fn.seen = seen; return fn; };
const never = async () => { throw new Error("must not probe"); };

function sse(text, { status = 200 } = {}) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
    const ev = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    return new Response(ev("message_start", { type: "message_start" }) + ev("content_block_delta", { type: "content_block_delta", delta: { type: "text_delta", text } })
      + ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6 } }) + ev("message_stop", { type: "message_stop" }), { status: 200 });
  };
  fn.seen = seen;
  return fn;
}

// ----------------------------------------------------------------- the catch-up decides and reserves

async function flipWorld(keys = ["m1"]) {
  const e = await world();
  writeBench(e.benchFile, Object.fromEntries(keys.map((k) => [`prov/${k}`, { s: "rate", a: epoch(T0) - 60 }])));
  await e.init();
  for (const k of keys) e.u.insert({ model: k, request_id: `flip-${k}` });
  return e;
}

test("a failing -> ok flip: the catch-up reserves conf/confDay in the SAME write and spawns exactly one detached child with fixed argv", async () => {
  const e = await flipWorld();
  const r = await e.run();
  assert.deepEqual(r.confirmSpawned, ["prov/m1"]);
  const o = readOverlay(e.P.overlay);
  assert.equal(o.conf["prov/m1"], nowS, "reserved at spawn time");
  assert.deepEqual(o.confDay, { d: DAY, n: 1 });
  assert.equal(o.models["prov/m1"].cf, 1);
  assert.equal(e.spawned.length, 1);
  const { cmd, args, opts } = e.spawned[0];
  assert.equal(cmd, process.execPath);
  assert.deepEqual(args.slice(0, 2), ["--no-warnings", path.join(ROOT, "refresh", "observe-cli.mjs")]);
  assert.deepEqual(args.slice(2), ["--confirm", "prov/m1"]);
  assert.deepEqual(opts, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
});

test("a second catch-up right after, with the child not finished, spawns nothing (the reservation holds)", async () => {
  const e = await flipWorld();
  await e.run();
  e.u.insert({ model: "m1", request_id: "again" });
  const r = await e.run({ nowMs: NOW + 60_000 });
  assert.equal(e.spawned.length, 1);
  assert.equal(r.confirmSkip.capKey, 1);
});

test("a second flip of the same key inside 6 h asks for nothing; after 6 h it may", async () => {
  const e = await world();
  const snapshot = JSON.parse(fs.readFileSync(e.snapshotFile, "utf8"));
  const models = { "prov/m1": flipRec() };
  const inside = await requestConfirms({ models, conf: { "prov/m1": nowS - 5 * 3600 }, confDay: { d: DAY, n: 1 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(inside.keys, []);
  assert.equal(inside.skip.capKey, 1);
  const after = await requestConfirms({ models, conf: { "prov/m1": nowS - 7 * 3600 }, confDay: { d: DAY, n: 1 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(after.keys, ["prov/m1"]);
});

test("the daily cap is 10 in total (confDay), and a new UTC day starts again at 0", async () => {
  const e = await world();
  const snapshot = JSON.parse(fs.readFileSync(e.snapshotFile, "utf8"));
  const models = { "prov/m1": flipRec() };
  const full = await requestConfirms({ models, conf: {}, confDay: { d: DAY, n: 10 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(full.keys, []);
  assert.equal(full.skip.capDay, 1);
  const nextDay = await requestConfirms({ models, conf: {}, confDay: { d: "2026-09-29", n: 10 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(nextDay.keys, ["prov/m1"]);
  assert.deepEqual(nextDay.confDay, { d: DAY, n: 1 });
  const nine = await requestConfirms({ models, conf: {}, confDay: { d: DAY, n: 9 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(nine.keys, ["prov/m1"], "the tenth is allowed");
});

test("at most 3 children per catch-up, the rest wait for the next open", async () => {
  const e = await flipWorld(["m1", "m2", "m3", "m4", "cheap"]);
  const r = await e.run();
  assert.equal(r.confirmSpawned.length, 3);
  assert.equal(e.spawned.length, 3);
  assert.equal(r.confirmSkip.capRun, 2);
  const o = readOverlay(e.P.overlay);
  assert.equal(Object.keys(o.conf).length, 3);
  assert.equal(o.confDay.n, 3);
  const again = await e.run({ nowMs: NOW + 60_000 });
  assert.equal(again.confirmSpawned.length, 2, "the two that waited");
});

test("the anthropic subscription route is never confirmed, even from a hand-made cf record", async () => {
  const e = await world();
  const snapshot = JSON.parse(fs.readFileSync(e.snapshotFile, "utf8"));
  const r = await requestConfirms({ models: { "anthropic/claude-sonnet-5": flipRec() }, conf: {}, confDay: { d: DAY, n: 0 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(r.keys, []);
  assert.equal(r.skip.anthropic, 1);
  seed(e, { "anthropic/claude-sonnet-5": flipRec() }, { reserved: ["anthropic/claude-sonnet-5"] });
  assert.equal((await runConfirm({ key: "anthropic/claude-sonnet-5", ...harness(e, { probe: never }).opts })).reason, "anthropic");
});

test("the cost ceiling is $0.01 (ECONOMY_DEFAULTS.maxRowCost): a $0.05 row is not confirmed, a free row and a cheap row are", async () => {
  const e = await world();
  const snapshot = JSON.parse(fs.readFileSync(e.snapshotFile, "utf8"));
  const models = { "prov/pricey": flipRec(), "prov/free1": flipRec(), "prov/cheap2": flipRec() };
  const r = await requestConfirms({ models, conf: {}, confDay: { d: DAY, n: 0 }, snapshot, nowS, stateDir: e.stateDir });   // ceiling from bench-cli
  assert.deepEqual(r.keys.sort(), ["prov/cheap2", "prov/free1"]);
  assert.equal(r.skip.cost, 1);
  const { ECONOMY_DEFAULTS } = await import("../refresh/bench-cli.mjs");
  assert.equal(ECONOMY_DEFAULTS.maxRowCost, 0.01);
});

test("a sweep holding its lock: no request, no reservation, no error", async () => {
  const e = await flipWorld();
  fs.writeFileSync(path.join(e.stateDir, "bench.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: "probe-all", maxMinutes: 30 }));
  const r = await e.run();
  assert.equal(r.ok, true);
  assert.equal(r.confirmSkip.sweep, 1);
  assert.equal(e.spawned.length, 0);
  assert.deepEqual(readOverlay(e.P.overlay).conf, {});
});

test("a key that is not a probeable row of the snapshot, or is shaped like a flag or shell text, is never requested or spawned", async () => {
  const e = await world();
  const snapshot = JSON.parse(fs.readFileSync(e.snapshotFile, "utf8"));
  const models = { "prov/ghost": flipRec(), "prov/m1; calc": flipRec(), "--confirm": flipRec(), "prov/$(x)": flipRec() };
  const r = await requestConfirms({ models, conf: {}, confDay: { d: DAY, n: 0 }, snapshot, nowS, stateDir: e.stateDir, ceiling: 0.01 });
  assert.deepEqual(r.keys, []);
  assert.equal(r.skip.notRoutable, 1);
  assert.equal(r.skip.badKey, 3);
});

test("--dry computes the request but reserves nothing and spawns nothing", async () => {
  const e = await flipWorld();
  const r = await e.run({ dry: true });
  assert.deepEqual(r.confirmWould, ["prov/m1"]);
  assert.deepEqual(r.confirmSpawned, []);
  assert.equal(e.spawned.length, 0);
  assert.equal(readOverlay(e.P.overlay)?.conf["prov/m1"], undefined);
});

test("the kill switch: with observe.off a catch-up spawns nothing", async () => {
  const e = await flipWorld();
  fs.writeFileSync(e.P.off, "x");
  const code = await main(["--catchup"], { out() {}, err() {}, stateDir: e.stateDir, snapshotFile: e.snapshotFile, usageDb: e.usageDb, logsDb: e.logsDb, nowMs: NOW, bake: null, spawn: e.spawn });
  assert.equal(code, 0);
  assert.equal(e.spawned.length, 0);
});

test("spawnConfirms: fixed argv, no shell, hard cap of 3, unsafe keys never spawn, and a failing spawn is reported not thrown", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.at(-1).unrefd = true; } }; };
  const r = spawnConfirms(["a/1", "a/2", "a/3", "a/4", "a/5"], { spawn });
  assert.deepEqual(r.spawned, ["a/1", "a/2", "a/3"]);
  assert.ok(calls.every((c) => c.opts.shell === false && c.opts.detached === true && c.opts.windowsHide === true && c.opts.stdio === "ignore" && c.unrefd));
  assert.ok(calls.every((c) => c.args[2] === "--confirm" && c.args.length === 4));
  const bad = spawnConfirms(["a/1;calc", "a b", "--x", "a/2&b", "`x`", "", null, "../x/y", "-r"], { spawn });
  assert.deepEqual(bad.spawned, []);
  assert.equal(bad.failed.length, 9);
  const boom = spawnConfirms(["a/1", "a/2"], { spawn: (_c, a) => { if (a[3] === "a/1") throw new Error("nope"); return { unref() {} }; } });
  assert.deepEqual(boom, { spawned: ["a/2"], failed: ["a/1"] });
  assert.equal(isConfirmKey("openrouter/x/y:free"), true);
  assert.equal(isConfirmKey("anthropic/claude-opus-5[1m]"), true);
});

// ----------------------------------------------------------------- the child

test("skip reasons before any request: bad key, unknown row, no flip, no reservation, an old flip", async () => {
  const e = await world();
  const { opts } = harness(e, { probe: never });
  assert.equal((await runConfirm({ key: "a b", ...opts })).reason, "bad-key");
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  assert.equal((await runConfirm({ key: "prov/ghost", ...opts })).reason, "not-in-snapshot");
  assert.equal((await runConfirm({ key: "prov/m2", ...opts })).reason, "no-flip");
  seed(e, { "prov/m1": flipRec() });                                                   // cf:1 but nobody reserved it
  assert.equal((await runConfirm({ key: "prov/m1", ...opts })).reason, "not-reserved");
  seed(e, { "prov/m1": flipRec({ cfa: nowS - 2 * 3600 }) }, { reserved: ["prov/m1"] });
  assert.equal((await runConfirm({ key: "prov/m1", ...opts })).reason, "no-flip");
  seed(e, { "prov/m1": { s: "ok", a: nowS, l: 1 } }, { reserved: ["prov/m1"] });       // an ok with no cf flag
  assert.equal((await runConfirm({ key: "prov/m1", ...opts })).reason, "no-flip");
  const noGw = await runConfirm({ key: "prov/m1", ...opts, gateway: null, health: undefined, probe: never });   // gateway: null, so the real vault helper can never be reached
  assert.deepEqual([noGw.outcome, noGw.reason], ["skipped", "no-flip"]);
});

test("cost above the ceiling: skipped before any request (the catch-up would not have asked)", async () => {
  const e = await world();
  seed(e, { "prov/pricey": flipRec() }, { reserved: ["prov/pricey"] });
  const r = await runConfirm({ key: "prov/pricey", ...harness(e, { probe: never }).opts });
  assert.equal(r.reason, "cost");
});

test("a sweep running, no gateway settings, or a gateway that does not answer /health: no probe, and the reservation is handed back for the next open", async () => {
  const cases = [
    ["sweep", (e) => fs.writeFileSync(path.join(e.stateDir, "bench.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: "x", maxMinutes: 30 })), {}],
    ["no-gateway", () => {}, { gateway: null }],
    ["gateway-down", () => {}, { health: async () => false }],
  ];
  for (const [reason, arrange, extra] of cases) {
    const e = await world();
    seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
    arrange(e);
    const r = await runConfirm({ key: "prov/m1", ...harness(e, { probe: never, ...extra }).opts, nowMs: NOWC });
    assert.equal(r.outcome, "skipped");
    assert.equal(r.reason, reason);
    const o = readOverlay(e.P.overlay);
    assert.equal(o.conf["prov/m1"], undefined, `${reason}: reservation released`);
    assert.equal(o.confDay.n, 0);
    assert.equal(o.models["prov/m1"].cf, 1, "the flip record is untouched");
  }
});

test("ok: ONE probe through probeOne (tagged uw-probe, our prompt, max_tokens 96); the record becomes the probe's, verified, live, cf cleared", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const fetchImpl = sse("Hello there, how are you");
  const r = await runConfirm({ key: "prov/m1", ...harness(e, { fetchImpl }).opts });
  assert.equal(r.outcome, "confirmed");
  assert.equal(fetchImpl.seen.length, 1, "exactly one request");
  const { url, init } = fetchImpl.seen[0];
  assert.equal(url, "http://gw.test/v1/messages");
  assert.equal(init.headers["x-ccr-client"], "uw-probe");
  assert.equal(init.headers["x-api-key"], "gw-key");
  const body = JSON.parse(init.body);
  assert.deepEqual([body.model, body.max_tokens, body.messages[0].content], ["prov/m1", 96, "Say hello in 5 words."]);
  const rec = readOverlay(e.P.overlay).models["prov/m1"];
  assert.equal(rec.s, "ok");
  assert.equal(rec.v, 1);
  assert.equal(rec.l, 1);
  assert.equal(rec.q, "flip-q");
  assert.equal(rec.a, epoch(NOWC));
  assert.equal(rec.p, "Hello there, how are you");
  assert.equal(rec.o, 6);
  assert.ok(Number.isFinite(rec.t) && Number.isFinite(rec.d));
  assert.equal("cf" in rec, false);
  assert.equal("cfa" in rec, false);
  assert.equal(readOverlay(e.P.overlay).conf["prov/m1"], epoch(NOWC), "the 6 h window now runs from the probe");
});

test("a preview that carries a key or a link is redacted before it is stored", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning(reply({ p: `key ${fake("sk")} ok` })) }).opts });
  assert.ok(!readOverlay(e.P.overlay).models["prov/m1"].p.includes(fakeCore("sk")));
});

test("a notice delivered as a 200 overrules the flip with the probe's own class", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const r = await runConfirm({ key: "prov/m1", ...harness(e, { fetchImpl: sse("Insufficient credits. Please add funds to continue.") }).opts });
  assert.equal(r.outcome, "overruled");
  const rec = readOverlay(e.P.overlay).models["prov/m1"];
  assert.equal(rec.s, "pay");
  assert.equal(rec.v, 1);
  assert.equal(rec.l, 1);
  assert.equal("cf" in rec, false);
  assert.match(rec.m, /notice/);
});

test("a hard failure class from the probe (auth, pay, gone) overrules the flip and is verified", async () => {
  for (const [status, s] of [[401, "auth"], [402, "pay"], [404, "gone"]]) {
    const e = await world();
    seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
    const r = await runConfirm({ key: "prov/m1", ...harness(e, { fetchImpl: sse("", { status }) }).opts });
    assert.equal(r.outcome, "overruled");
    const rec = readOverlay(e.P.overlay).models["prov/m1"];
    assert.equal(rec.s, s);
    assert.equal(rec.v, 1);
  }
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning({ s: "empty", d: 500, m: "stream ended with no content" }) }).opts });
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "empty");
});

test("a transient probe outcome (timeout, rate, error) does NOT overwrite the good live ok: the flag is cleared and nothing is verified", async () => {
  for (const res of [{ s: "timeout", d: 45000, m: "no complete answer" }, { s: "rate", http: 429, d: 100 }, { s: "error", d: 100, m: "boom" }]) {
    const e = await world();
    seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
    const r = await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning(res) }).opts });
    assert.equal(r.outcome, "kept");
    const rec = readOverlay(e.P.overlay).models["prov/m1"];
    assert.deepEqual(rec, { s: "ok", d: 400, a: nowS - 30, q: "flip-q", l: 1, o: 5 }, `${res.s}: exactly the live ok, without cf/cfa/v`);
    assert.equal(readOverlay(e.P.overlay).conf["prov/m1"], epoch(NOWC), "and it is not probed again inside 6 h");
  }
});

test("an aborted probe leaves the flip record as it was", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const before = fs.readFileSync(e.P.overlay, "utf8");
  const r = await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning({ aborted: true }) }).opts });
  assert.equal(r.reason, "aborted");
  assert.equal(fs.readFileSync(e.P.overlay, "utf8"), before);
});

test("if a newer event replaced the flip while the probe ran, the probe's result is dropped", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const probe = async () => { seed(e, { "prov/m1": { s: "rate", a: nowS + 1, l: 1, q: "newer" } }, { reserved: ["prov/m1"] }); return reply(); };
  const r = await runConfirm({ key: "prov/m1", ...harness(e, { probe }).opts });
  assert.equal(r.wrote, false);
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "rate");
});

test("per-provider recount: after a confirmation the prov block is recomputed when bakeBench is available", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const bake = (row, get) => ({ bench: { m1: get("prov/m1").s }, benchFlags: null, benchAgeHist: [] });
  await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning({ s: "pay", d: 10, m: "x" }), bake }).opts });
  assert.equal(readOverlay(e.P.overlay).prov["prov.key"].bench.m1, "pay");
});

// ----------------------------------------------------------------- the lock

test("the confirm child retries observed.lock for at least 3 s (polling every 100 ms) and then lands its write", async () => {
  const sleeps = [];
  const file = path.join((await world()).stateDir, "observed.lock");
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 }));
  let t = 1_000_000;
  const got = acquireLockRetry({ file, sleep: (ms) => { sleeps.push(ms); t += ms; }, now: () => t });
  assert.equal(got.ok, false);
  assert.ok(sleeps.length >= 30 && sleeps.every((ms) => ms === 100), `${sleeps.length} polls of 100 ms`);
  fs.rmSync(file);
  assert.equal(acquireLockRetry({ file, sleep: () => {} }).ok, true);
});

test("a write that meets a busy lock waits for it and lands; one that never gets it drops the result cleanly", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const lock = path.join(e.stateDir, "observed.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 }));
  let polls = 0;
  const sleep = () => { polls += 1; if (polls === 3) fs.rmSync(lock); };
  const r = await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning(reply()), sleep }).opts });
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.wrote, true);
  assert.ok(polls >= 3);

  const f = await world();
  seed(f, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  fs.writeFileSync(path.join(f.stateDir, "observed.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 }));
  const before = fs.readFileSync(f.P.overlay, "utf8");
  const dropped = await runConfirm({ key: "prov/m1", ...harness(f, { probe: probeReturning(reply()), lockWaitMs: 30 }).opts });
  assert.equal(dropped.wrote, false);
  assert.equal(dropped.reason, "lock-busy");
  assert.equal(fs.readFileSync(f.P.overlay, "utf8"), before, "the file is never torn or half written");
});

test("a finished confirmation leaves no lock and no temp debris", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning(reply()) }).opts });
  assert.deepEqual(fs.readdirSync(e.stateDir).sort(), ["observed.json"]);
});

test("stale observed.json.tmp-* debris is swept when a confirm child starts", async () => {
  const e = await world();
  seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
  const old = path.join(e.stateDir, "observed.json.tmp-999");
  fs.writeFileSync(old, "x");
  const past = new Date(NOWC - 10 * 60000);
  fs.utimesSync(old, past, past);
  await runConfirm({ key: "prov/m1", ...harness(e, { probe: probeReturning(reply()) }).opts });
  assert.equal(fs.existsSync(old), false);
});

test("the CLI installs the 90 s watchdog for --confirm and the 10 s one otherwise", () => {
  const src = fs.readFileSync(path.join(ROOT, "refresh", "observe-cli.mjs"), "utf8");
  assert.match(src, /process\.argv\.includes\("--confirm"\) \? 90_000 : 10_000/);
  assert.match(src, /\.unref\(\)/);
});

// ----------------------------------------------------------------- loop safety

test("a tagged confirmation probe's own usage row is never ingested as an observation", async () => {
  const e = await flipWorld();
  await e.run();
  seed(e, { ...readOverlay(e.P.overlay).models, "prov/m1": flipRec({ q: "flip-q" }) }, { reserved: ["prov/m1"], confDay: { d: DAY, n: 1 } });
  const before = readOverlay(e.P.overlay);
  e.u.insert({ client: "uw-probe", model: "m1", request_id: "confirm-row", status_code: 429 });
  e.u.insert({ client: "uw-probe", model: "m1", request_id: "confirm-row-2", status_code: 200 });
  const r = await e.run({ nowMs: NOW + 120_000 });
  assert.equal(r.skip.probe, 2);
  assert.deepEqual(readOverlay(e.P.overlay).models, before.models, "no observation came from it");
  assert.equal(e.spawned.length, 1, "and it started no further confirmation");
});

test("even if the tag were missing, the caps stop a loop: a second flip inside 6 h asks for nothing", async () => {
  const e = await flipWorld();
  await e.run();                                            // reserves and spawns once
  // the "confirmation" (untagged, so the feed sees it) fails, then the model answers again: a second flip of the same key
  e.u.insert({ model: "m1", status_code: 429, request_id: "untagged-fail" });
  await e.run({ nowMs: NOW + 60_000 });
  e.u.insert({ model: "m1", request_id: "untagged-ok" });
  const r = await e.run({ nowMs: NOW + 120_000 });
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].cf, 1, "it did flip again");
  assert.equal(e.spawned.length, 1, "but the 6 h cap held");
  assert.equal(r.confirmSkip.capKey, 1);
});

// ----------------------------------------------------------------- review round

test("an async spawn failure (an 'error' event on the child) is caught, not uncaught, and moves the key from spawned to failed", async () => {
  const { EventEmitter } = await import("node:events");
  let child;
  const spawn = () => { child = new EventEmitter(); child.unref = () => {}; return child; };
  const r = spawnConfirms(["a/1", "a/2"], { spawn });
  assert.deepEqual(r.spawned, ["a/1"].concat(["a/2"]).slice(0, 2));
  child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));        // would be an uncaught exception without a listener
  assert.deepEqual(r.failed, ["a/2"]);
  assert.deepEqual(r.spawned, ["a/1"]);
  assert.equal(child.listenerCount("error"), 1);
});

test("gateway down: the child releases AND asks for quiet, so the next opens neither reserve nor rewrite observed.json until it ends", async () => {
  const e = await flipWorld();
  await e.run();                                                                    // reserves and spawns
  const child = await runConfirm({ key: "prov/m1", ...harness(e, { probe: never, health: async () => false }).opts });
  assert.equal(child.reason, "gateway-down");
  const o = readOverlay(e.P.overlay);
  assert.equal(o.conf["prov/m1"], undefined);
  assert.equal(o.confHold, epoch(NOWC) + 600, "10 minutes of quiet");
  const before = fs.readFileSync(e.P.overlay, "utf8");
  const again = await e.run({ nowMs: NOWC + 60_000 });
  assert.equal(again.confirmSkip.hold, 1);
  assert.equal(e.spawned.length, 1, "no second child");
  assert.equal(fs.readFileSync(e.P.overlay, "utf8"), before, "and no rewrite: every open would otherwise write the file twice");
  const later = await e.run({ nowMs: NOWC + 11 * 60_000 });
  assert.equal(e.spawned.length, 2, "after the quiet period it may try again (the flip is still under an hour old)");
  assert.equal(later.confirmSkip.hold ?? 0, 0);
  assert.equal(readOverlay(e.P.overlay).confHold, undefined, "and the expired marker is dropped");
});

test("no gateway settings and a running sweep also ask for quiet", async () => {
  for (const [extra, arrange] of [[{ gateway: null }, () => {}], [{}, (e) => fs.writeFileSync(path.join(e.stateDir, "bench.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: "x", maxMinutes: 30 }))]]) {
    const e = await world();
    seed(e, { "prov/m1": flipRec() }, { reserved: ["prov/m1"] });
    arrange(e);
    await runConfirm({ key: "prov/m1", ...harness(e, { probe: never, ...extra }).opts });
    assert.equal(readOverlay(e.P.overlay).confHold, epoch(NOWC) + 600);
  }
});

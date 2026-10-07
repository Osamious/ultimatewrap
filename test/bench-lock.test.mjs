// #114: one live sweep at a time. Temp directories and injected process probes only:
// nothing here spawns a process, signals one, or touches the real state directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import {
  acquireLock, sweepStatus, readLock, findSweepProcesses, parseProcessList, pidAlive, hhmm,
} from "../refresh/bench-lock.mjs";
import { main, EXIT_BUSY, printPlan, summarize, parseArgs, recordedSpend } from "../refresh/bench-cli.mjs";

const lockPath = () => path.join(mkTmp("uw-lock-"), "state", "bench.lock");
const NOW = Date.parse("2026-09-29T14:36:00");
const alive = (...pids) => (p) => pids.includes(p);
const none = () => [];

// ----------------------------------------------------------------- the lock

test("a live run takes the lock, which records pid, start time and mode", () => {
  const file = lockPath();
  const r = acquireLock({ file, pid: 4001, mode: "probe-all", maxMinutes: 150, now: () => NOW, findRunning: none });
  assert.equal(r.ok, true);
  const held = readLock(file);
  assert.deepEqual(held.holder, { pid: 4001, startedAt: NOW, mode: "probe-all", maxMinutes: 150 });
  r.release();
  assert.equal(fs.existsSync(file), false, "released");
});

test("a second live run is refused with the pid and start time, and nothing of the first is disturbed", () => {
  const file = lockPath();
  const first = acquireLock({ file, pid: 4001, mode: "probe-all", now: () => NOW, findRunning: none });
  const second = acquireLock({ file, pid: 4002, mode: "economy", now: () => NOW + 60000, isAlive: alive(4001), findRunning: none });
  assert.equal(second.ok, false);
  assert.equal(second.message, `another sweep is running (pid 4001 since ${hhmm(NOW)}, probe-all); nothing was sent`);
  assert.equal(readLock(file).holder.pid, 4001, "the first run still holds it");
  second.release?.();
  assert.equal(readLock(file).holder.pid, 4001);
  first.release();
});

test("release is idempotent and only removes the lock it took (never a successor's)", () => {
  const file = lockPath();
  const a = acquireLock({ file, pid: 1, now: () => NOW, findRunning: none });
  a.release(); a.release();
  const b = acquireLock({ file, pid: 2, now: () => NOW + 1, findRunning: none });
  a.release();                                               // a stale handle must not delete b's lock
  assert.equal(readLock(file).holder.pid, 2);
  b.release();
  assert.equal(fs.existsSync(file), false);
});

test("a lock whose process is gone is taken over with a notice", () => {
  const file = lockPath();
  acquireLock({ file, pid: 4001, now: () => NOW, findRunning: none });          // never released: the process died
  const r = acquireLock({ file, pid: 4002, now: () => NOW + 1000, isAlive: alive(), findRunning: none });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tookOver, { pid: 4001, why: "process 4001 is not running" });
  assert.equal(readLock(file).holder.pid, 4002);
});

test("a lock that outlived its own --max-minutes plus the margin is taken over even if the pid is alive (a recycled pid)", () => {
  const file = lockPath();
  acquireLock({ file, pid: 4001, maxMinutes: 150, now: () => NOW, findRunning: none });
  const within = acquireLock({ file, pid: 4002, now: () => NOW + 155 * 60000, isAlive: alive(4001), findRunning: none });
  assert.equal(within.ok, false, "still inside 150 min + the 10 min margin: a slow run is not evicted");
  const past = acquireLock({ file, pid: 4002, now: () => NOW + 161 * 60000, isAlive: alive(4001), findRunning: none });
  assert.equal(past.ok, true);
  assert.match(past.tookOver.why, /older than its 160 min limit/);
});

test("a run with no --max-minutes still cannot hold the lock for ever", () => {
  const file = lockPath();
  acquireLock({ file, pid: 4001, maxMinutes: null, now: () => NOW, findRunning: none });
  assert.equal(acquireLock({ file, pid: 4002, now: () => NOW + 3 * 3600000, isAlive: alive(4001), findRunning: none }).ok, false);
  assert.equal(acquireLock({ file, pid: 4002, now: () => NOW + 25 * 3600000, isAlive: alive(4001), findRunning: none }).ok, true);
});

test("an unreadable lock: someone mid-write is respected, an old one is taken over", () => {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{not json");
  const fresh = acquireLock({ file, pid: 9, now: () => Date.now(), findRunning: none });
  assert.equal(fresh.ok, false);
  assert.match(fresh.message, /still being written/);
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file, old, old);
  const took = acquireLock({ file, pid: 9, now: () => Date.now(), findRunning: none });
  assert.equal(took.ok, true);
  assert.match(took.tookOver.why, /unreadable/);
});

test("the lock file is created exclusively: two simultaneous starters cannot both win", () => {
  const file = lockPath();
  const results = [1, 2, 3, 4, 5].map((pid) => acquireLock({ file, pid, now: () => NOW, isAlive: alive(1, 2, 3, 4, 5), findRunning: none }));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 4);
});

test("sweepStatus reads without creating or removing anything", () => {
  const file = lockPath();
  assert.equal(sweepStatus({ file, findRunning: none }).running, false);
  assert.equal(fs.existsSync(file), false, "a status check leaves no lock behind");
  acquireLock({ file, pid: 4001, mode: "economy", now: () => NOW, findRunning: none });
  const st = sweepStatus({ file, isAlive: alive(4001), now: () => NOW + 1000, findRunning: none });
  assert.equal(st.running, true);
  assert.match(st.message, /another sweep is running \(pid 4001 since \d\d:\d\d, economy\)/);
  const dead = sweepStatus({ file, isAlive: alive(), now: () => NOW + 1000, findRunning: none });
  assert.equal(dead.running, false); assert.match(dead.staleLock, /not running/);
  assert.equal(fs.existsSync(file), true, "and it does not clean a stale lock up either");
});

// ------------------------------------------ a sweep started by code with no lock

const CIM = JSON.stringify([
  { ProcessId: 24400, CommandLine: "\"C:\\Program Files\\nodejs\\node.exe\" refresh/bench-cli.mjs --live" },
  { ProcessId: 24500, CommandLine: "node refresh/bench-cli.mjs --compact" },
  { ProcessId: 24600, CommandLine: "node --test test/bench-cli.test.mjs" },
  { ProcessId: 24700, CommandLine: "node refresh/bench-cli.mjs" },
  { ProcessId: 24800, CommandLine: "node C:\\Users\\osami\\.uw\\refresh\\bench-cli.mjs --live --max-spend 3" },
  { ProcessId: 4001, CommandLine: "node refresh/bench-cli.mjs --live" },
]);

test("findSweepProcesses: only other `bench-cli.mjs --live` processes, not compacts, dry runs or test runs", () => {
  const found = findSweepProcesses({ list: () => CIM, platform: "win32", selfPid: 4001 });
  assert.deepEqual(found.map((p) => p.pid), [24400, 24800]);
  const single = findSweepProcesses({ list: () => JSON.stringify({ ProcessId: 7, CommandLine: "node bench-cli.mjs --live" }), platform: "win32", selfPid: 1 });
  assert.deepEqual(single.map((p) => p.pid), [7], "CIM returns a bare object when there is exactly one process");
  const ps = findSweepProcesses({ list: () => " 100 node refresh/bench-cli.mjs --live\n 200 vim x\n", platform: "linux", selfPid: 1 });
  assert.deepEqual(ps.map((p) => p.pid), [100]);
});

test("findSweepProcesses: a machine that cannot be asked gives null, never a throw; garbage gives none", () => {
  assert.equal(findSweepProcesses({ list: () => { throw new Error("no powershell"); }, platform: "win32" }), null);
  assert.deepEqual(findSweepProcesses({ list: () => "not json", platform: "win32" }), []);
  assert.deepEqual(parseProcessList("", "win32"), []);
});

test("a lockless sweep process blocks a new run, gives the lock back, and says why", () => {
  const file = lockPath();
  const r = acquireLock({ file, pid: 4001, now: () => NOW, findRunning: () => [{ pid: 24400, cmd: "node refresh/bench-cli.mjs --live" }] });
  assert.equal(r.ok, false);
  assert.match(r.message, /a sweep is running that holds no lock \(pid 24400; started by code from before the lock existed\); nothing was sent/);
  assert.equal(fs.existsSync(file), false, "the lock it briefly took is released");
});

test("an unanswerable OS scan does not block a run, but is reported", () => {
  const r = acquireLock({ file: lockPath(), pid: 4001, now: () => NOW, findRunning: () => null });
  assert.equal(r.ok, true); assert.equal(r.unchecked, true);
});

test("pidAlive: this process is alive, an impossible pid is not", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(0), false); assert.equal(pidAlive(-5), false); assert.equal(pidAlive(1.5), false);
  assert.equal(pidAlive(2 ** 31 - 2), false);
});

// ------------------------------------------------------------- the CLI gates

const capture = async (fn) => {
  const err = [], log = [];
  const e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { code: await fn(), err, log }; } finally { console.error = e; console.log = l; }
};

test("main --live is refused, exit 5, while another sweep holds the lock, before anything is read or sent", async () => {
  const file = lockPath();
  acquireLock({ file, pid: 4001, mode: "probe-all", now: () => Date.now(), findRunning: none });
  const out = await capture(() => main(["--live"], { lockFile: file, isAlive: alive(4001), findRunning: none }));
  assert.equal(out.code, EXIT_BUSY); assert.equal(EXIT_BUSY, 5);
  assert.match(out.err.join("\n"), /bench: another sweep is running \(pid 4001 since \d\d:\d\d, probe-all\); nothing was sent/);
  assert.equal(out.log.length, 0);
  assert.equal(readLock(file).holder.pid, 4001, "the running sweep's lock is untouched");
});

test("main --live is refused for a lockless running sweep too", async () => {
  const out = await capture(() => main(["--live"], { lockFile: lockPath(), findRunning: () => [{ pid: 24400, cmd: "node bench-cli.mjs --live" }] }));
  assert.equal(out.code, EXIT_BUSY);
  assert.match(out.err.join("\n"), /holds no lock \(pid 24400/);
});

test("main --compact is refused while a live sweep holds the lock, or a lockless one runs", async () => {
  const file = lockPath();
  acquireLock({ file, pid: 4001, now: () => Date.now(), findRunning: none });
  const a = await capture(() => main(["--compact"], { lockFile: file, isAlive: alive(4001), findRunning: none }));
  assert.equal(a.code, EXIT_BUSY);
  assert.match(a.err.join("\n"), /cannot compact -- another sweep is running \(pid 4001/);
  const b = await capture(() => main(["--compact"], { lockFile: lockPath(), findRunning: () => [{ pid: 24400, cmd: "x bench-cli.mjs --live" }] }));
  assert.equal(b.code, EXIT_BUSY);
  assert.match(b.err.join("\n"), /cannot compact -- a sweep is running that holds no lock/);
});

test("a bad argument still exits 2 before any lock is looked at", async () => {
  const file = lockPath();
  const out = await capture(() => main(["--live", "--nope"], { lockFile: file, findRunning: none }));
  assert.equal(out.code, 2);
  assert.equal(fs.existsSync(file), false);
});

test("the dry plan says a sweep is running", () => {
  const o = { ...parseArgs([]), avgSec: null };
  const sum = summarize(new Map(), o);
  const running = { message: "another sweep is running (pid 4001 since 14:36, probe-all); nothing was sent" };
  const text = printPlan(sum, o, 0, true, { running });
  assert.match(text, /^NOTE: another sweep is running \(pid 4001 since 14:36, probe-all\) -- a --live run would refuse to start/);
  assert.doesNotMatch(printPlan(sum, o, 0, true), /NOTE:/, "and says nothing when none is");
});

// ------------------------------------------------------- per invocation budget

test("the plan says the cap and the ceiling are per invocation, with the spend already on record", () => {
  const o = { ...parseArgs([]), avgSec: null };
  const sum = summarize(new Map(), o);
  const withRec = printPlan(sum, o, 0, true, { recorded: 1.234 });
  assert.match(withRec, /the \$5\.00 cap and the \$0\.10 ceiling apply PER INVOCATION: a resumed or repeated run starts with a fresh budget/);
  assert.match(withRec, /already on record would have cost ~\$1\.23 \(estimate, latest record per model\)/);
  assert.match(printPlan(sum, o, 0, true), /PER INVOCATION/);
  assert.doesNotMatch(printPlan(sum, o, 0, true), /already on record/);
  const eco = { ...parseArgs(["--economy"]), avgSec: null };
  assert.match(printPlan(summarize(new Map(), eco), eco, 0, true), /the \$2\.00 cap and the \$0\.010 ceiling apply PER INVOCATION/);
});

test("recordedSpend prices the latest record per model from its reported tokens; unmeasured, refused and free cost nothing", () => {
  const t = (key, o = {}) => ({ key, free: false, cost: 0.004, worst: 0.01, pin: 1, pout: 100, ...o });
  const targets = new Map([["p", [t("p/a"), t("p/b"), t("p/c"), t("p/d"), t("p/free", { free: true }), t("p/none")]]]);
  const existing = new Map([
    ["p/a", { s: "ok", o: 96 }], ["p/b", { s: "auth" }], ["p/c", { s: "skip", w: "spend-cap" }],
    ["p/d", { s: "timeout" }], ["p/free", { s: "ok", o: 50 }],
  ]);
  const got = recordedSpend(targets, existing);
  assert.ok(Math.abs(got - ((15 + 96 * 100) / 1e6 + 0.01)) < 1e-12, `${got}`);
});

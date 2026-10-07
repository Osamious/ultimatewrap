// D-x: the automatic subagent-policy rebuild after the tool sweep, the bench sweep, a keysync live write and a key change. Offline: fixtures, fakes and temp folders; nothing real is read or written (guardRealState).
// What is pinned: the hook runs AFTER the pass's own state is saved, only for a live pass that changed something, `--no-rebuild yes` skips it, it is strictly non-fatal (a throwing or failing rebuild leaves the exit
// code and the output of the pass as they were), and the incident shape of 2026-10-06 (a rebuild after a run that shrank the snapshot from stale discovery caches) is refused and leaves the policy untouched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, fakeFetch, goodModel } from "./fixtures/tool-fidelity-helpers.mjs";
import { fixtureFlagMap } from "./fixtures/subagent-flags.mjs";
import { main as tfMain, parseArgs as tfParse, policyAfterRun as tfAfter } from "../refresh/tool-fidelity-cli.mjs";
import { parseArgs as benchParse, policyAfterRun as benchAfter } from "../refresh/bench-cli.mjs";
import { FILE_NAME } from "../refresh/tool-fidelity.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";
import * as lib from "../keysync/subagent-policy.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(ROOT, "keysync", "key.mjs");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-arw-")); made.push(d); return d; };
const fresh = () => { const d = freshDir(); made.push(d); return d; };
after(() => { for (const d of made) if (d.startsWith(os.tmpdir())) fs.rmSync(d, { recursive: true, force: true }); });
const NOW = new Date("2026-10-05T10:00:00.000Z");

// ---- the flag
test("--no-rebuild: yes or no only, in the tool sweep and in the bench sweep; off by default", () => {
  assert.equal(tfParse([]).noRebuild, undefined); assert.equal(benchParse([]).noRebuild, undefined);
  assert.equal(tfParse(["--no-rebuild", "yes"]).noRebuild, true); assert.equal(tfParse(["--no-rebuild", "no"]).noRebuild, false);
  assert.equal(benchParse(["--live", "--no-rebuild", "yes"]).noRebuild, true); assert.equal(benchParse(["--no-rebuild", "no"]).noRebuild, false);
  for (const bad of [["--no-rebuild"], ["--no-rebuild", "maybe"], ["--no-rebuild", "--live"]]) { assert.match(tfParse(bad).error, /--no-rebuild takes yes or no/); assert.match(benchParse(bad).error, /--no-rebuild takes yes or no/); }
});

// ---- the tool sweep, end to end on the fixture world of its own tests
const world = () => {
  const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
  const rows = [{ provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN", pin: 3, pout: 15 })] }, { provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2")] }];
  const b = Object.fromEntries(["anthropic/claude-x", "fa/a1", "fa/a2"].map((k) => [k, { s: "ok", t: 400, a: 1790699779 }]));
  return { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => b[k] ?? null } };
};
const sweepEnv = (extraDeps = {}) => {
  const dir = fresh();
  const f = fakeFetch(goodModel);
  const deps = { ...world(), outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW, isAlive: () => false, findRunning: () => [],
    sweep: { ...SWEEP_FAST }, retryDelayMs: 1, rateBackoffMs: 1, tiers: { fa: "free" }, ...extraDeps };
  return { dir, deps };
};
async function sweep(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await tfMain(pinL12([...argv, ...(argv.includes("--live") ? ["--max-spend", "5"] : [])]), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const strip = (t) => t.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "T").replace(/\b\d+ ms\b/g, "N ms").replace(/in \d+(\.\d+)?s/g, "in Ns");

test("tool sweep: a live pass runs the automatic rebuild ONCE, after its store is saved; a dry pass, --no-rebuild yes and a test store without the seam do not", async () => {
  let calls = 0, sawStore = null;
  const seen = sweepEnv();
  seen.deps.autoRebuildAfter = async () => { calls += 1; sawStore = fs.existsSync(seen.deps.outFile) ? Object.keys(JSON.parse(fs.readFileSync(seen.deps.outFile, "utf8")).models ?? {}).length : -1; };
  const live = await sweep(["--live", "--only", "fa"], seen.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.equal(calls, 1); assert.ok(sawStore > 0, `the store was already saved with ${sawStore} records when the rebuild ran`);
  const skipped = sweepEnv(); let n2 = 0; skipped.deps.autoRebuildAfter = async () => { n2 += 1; };
  assert.equal((await sweep(["--live", "--only", "fa", "--no-rebuild", "yes"], skipped.deps)).code, 0); assert.equal(n2, 0, "--no-rebuild yes");
  const dry = sweepEnv(); let n3 = 0; dry.deps.autoRebuildAfter = async () => { n3 += 1; };
  assert.equal((await sweep(["--only", "fa"], dry.deps)).code, 0); assert.equal(n3, 0, "a dry plan writes nothing and rebuilds nothing");
  // no seam and a temp store: the real policy is never reached (the function returns before it loads the library)
  const plain = sweepEnv();
  assert.equal((await sweep(["--live", "--only", "fa"], plain.deps)).code, 0);
  await assert.doesNotReject(tfAfter({}, { outFile: path.join(tmp(), FILE_NAME) }));
});

test("tool sweep: a rebuild that THROWS or FAILS leaves the exit code and the output of the pass exactly as they were", async () => {
  const base = sweepEnv(); base.deps.autoRebuildAfter = async () => {};
  const clean = await sweep(["--live", "--only", "fa"], base.deps);
  for (const hook of [async () => { throw new Error("rebuild blew up"); }, async () => ({ code: 1, lines: ["E_SHRINK: x"] }), () => { throw new TypeError("sync throw"); }, async () => Promise.reject(new Error("rejected"))]) {
    const e = sweepEnv(); e.deps.autoRebuildAfter = hook;
    const r = await sweep(["--live", "--only", "fa"], e.deps);
    assert.equal(r.code, clean.code, "the exit code is the pass's own");
    assert.equal(strip(r.out), strip(clean.out), "and so is its output");
  }
});

// ---- the bench sweep: its main needs the real gateway settings, so the hook function and the order in main are pinned
test("bench sweep: policyAfterRun runs only for a run that changed bench.json, never with --no-rebuild yes, never for a test bench file without the seam, and swallows every failure", async () => {
  const calls = [];
  const seam = async (a) => { calls.push(a); };
  await benchAfter({}, { autoRebuildAfter: seam }, true); assert.equal(calls.length, 1);
  await benchAfter({}, { autoRebuildAfter: seam }, false); assert.equal(calls.length, 1, "nothing recorded: nothing to rebuild");
  await benchAfter({ noRebuild: true }, { autoRebuildAfter: seam }, true); assert.equal(calls.length, 1, "--no-rebuild yes");
  await benchAfter({}, { benchFile: path.join(tmp(), "bench.json") }, true); assert.equal(calls.length, 1, "a test bench file without the seam never reaches the real policy");
  for (const hook of [async () => { throw new Error("x"); }, () => { throw new Error("y"); }, async () => Promise.reject(new Error("z"))]) await assert.doesNotReject(benchAfter({}, { autoRebuildAfter: hook }, true));
  const src = read("refresh/bench-cli.mjs");
  const iRebuild = src.indexOf("await rebuildAfterRun(wrote ? done : 0"), iHook = src.indexOf("await policyAfterRun(o, deps, wrote && !result.outage?.gaveUp);"), iRet = src.indexOf("  return code;\n}", iHook);
  assert.ok(iRebuild > 0 && iHook > iRebuild && iRet > iHook, "the hook comes after the snapshot rebuild and before the exit code is returned");
  assert.ok(/\n  return code;\n\}\n\nif \(process\.argv\[1\]/.test(src.slice(iHook - 10, iHook + 400)), "the function returns the sweep's own code");
});

test("tool sweep source: the hook sits after the final output and before the failed-save exit, only for a saved live pass", () => {
  const src = read("refresh/tool-fidelity-cli.mjs");
  const iHook = src.indexOf("if (saved && o.live && !(signalStop || ac.signal.aborted || interrupts > 0 || code === 4)) await policyAfterRun(o, deps, outFile);"), iSat = src.lastIndexOf("SATURATION saturated=unknown", iHook), iFail = src.indexOf("if (!saved) return 1;", iHook);
  assert.ok(iSat > 0 && iHook > iSat && iFail > iHook && iFail - iHook < 400, "after the saturation line, directly before the exit code is decided");
  assert.match(src.slice(iHook, iHook + 200), /signalStop \|\| ac\.signal\.aborted \|\| interrupts > 0 \|\| code === 4/, "not after Ctrl-C, not after the gateway gave up (exit 4)");
});

// ---- keysync run and key.mjs
test("keysync run source: the rebuild follows a verified LIVE write, after the retention step, inside the entry guard, honours --no-rebuild yes and cannot fail the apply", () => {
  const src = read("keysync/run.mjs");
  const iRet = src.lastIndexOf("retainOnSuccess({ snapshot: dbSnapshot"), iHook = src.indexOf("if (writeVerified && target === \"live\" && !noRebuild) {"), iEnd = src.indexOf("// ---- end entry-point guard");
  assert.ok(iRet > 0 && iHook > iRet && iEnd > iHook, "after retention, before the end of the entry guard");
  const block = src.slice(iHook, iEnd);
  assert.match(block, /try \{ const \{ autoRebuildAfter \} = await import\("\.\/subagent-policy\.mjs"\); await autoRebuildAfter\(\{\}\); \} catch \{ \/\* never fatal: the apply already succeeded \*\/ \}/);
  assert.ok(!/process\.exit|exitCode/.test(block), "it never touches the exit code");
});

const keyRun = (home, ...args) => spawnSync(process.execPath, [KEY, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60000 });
test("key.mjs: --no-rebuild yes is accepted by every subcommand (retier's own parser never sees it); a successful state change with no saved policy rebuilds nothing and prints nothing; a failed command or a read skips the hook", () => {
  const home = tmp();
  const cleared = keyRun(home, "default-model", "clear");
  assert.deepEqual([cleared.status, cleared.stderr], [0, ""], "no policy was ever saved: the automatic rebuild is a silent no-op");
  const skipped = keyRun(home, "default-model", "clear", "--no-rebuild", "yes");
  assert.deepEqual([skipped.status, skipped.stderr], [0, ""]);
  const retier = keyRun(home, "retier", "--no-rebuild", "yes");
  assert.equal(retier.status, 1); assert.match(retier.stderr, /usage: key\.mjs retier <id> <new-tier>/); assert.ok(!/unknown flag/.test(retier.stderr), "the flag was taken out before retier's parser");
  const bad = keyRun(home, "remove");
  assert.equal(bad.status, 1); assert.match(bad.stderr, /usage: key\.mjs remove <id>/);
  const src = read("keysync/key.mjs");
  const iSwitch = src.indexOf("switch (sub) {"), iHook = src.indexOf("if (changedState && !noRebuild && !process.exitCode) {");
  assert.ok(iSwitch > 0 && iHook > iSwitch, "after the command ran");
  assert.match(src.slice(iHook, iHook + 260), /try \{ const \{ autoRebuildAfter \} = await import\("\.\/subagent-policy\.mjs"\); await autoRebuildAfter\(\{\}\); \} catch \{ \/\* never fatal \*\/ \}/);
  assert.match(src, /const changedState = \["add", "remove"\]\.includes\(sub\) \|\| \(sub === "retier" && args\.dry !== "yes"\) \|\| \(sub === "default-model" && \(args\._\[0\] === "set" \|\| args\._\[0\] === "clear"\)\);/);
});

// ---- the incident shape: a run ended by a snapshot rebuilt from stale discovery caches
const flagsOf = (dir) => Object.entries(fixtureFlagMap(dir)).flatMap(([k, v]) => [`--${k}`, v]);
async function sp(argv) { const out = [], err = []; const code = await lib.runSubagentPolicy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}); return { code, out: out.join("\n"), err: err.join("\n") }; }
test("incident shape (2026-10-06): after a run that shrank the snapshot from stale discovery caches, the automatic rebuild is REFUSED in one stderr line, the saved policy stays byte for byte, and the pass's exit code is its own", async () => {
  const dir = tmp(), fx = flagsOf(dir), m = fixtureFlagMap(dir);
  assert.equal((await sp(["set", "--source", "all-providers", "--mode", "dynamic", ...fx])).code, 0);
  const compiled = path.join(m["state-dir"], "subagent", "policy.json");
  const before = fs.readFileSync(compiled);
  // the snapshot the run rebuilt: most routes gone (stale caches), a new build time
  const snFile = m["snapshot-file"], sn = JSON.parse(fs.readFileSync(snFile, "utf8"));
  for (const r of sn.rows) r.models = r.models.slice(0, 1);
  sn.builtAt = new Date(Date.now() + 1000).toISOString(); fs.writeFileSync(snFile, JSON.stringify(sn));
  // the discovery folder: 1 fresh and 6 stale caches
  const disc = path.join(dir, "disc"); fs.mkdirSync(disc);
  [1, 9, 12, 20, 30, 40, 50].forEach((d, i) => fs.writeFileSync(path.join(disc, `${String(i).padStart(2, "0")}${"a".repeat(30)}.json`), JSON.stringify({ provider: `p${i}`, at: new Date(Date.now() - d * 86400000).toISOString() })));
  const lines = [];
  // what the sweep's hook does, with the real library and the fixture files
  const hook = (o) => lib.autoRebuildAfter({ extra: [...fx, "--discovery-dir", disc], write: (l) => lines.push(l) });
  let passCode = 0;                                              // the pass's own exit code, decided before and after the hook
  await benchAfter({}, { autoRebuildAfter: hook }, true);
  assert.equal(passCode, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^E_SHRINK: the snapshot shrank from 18 to 6 routes \(6 of 7 discovery caches are older than 7 days\).*the automatic rebuild never accepts a shrink/);
  assert.ok(Buffer.compare(fs.readFileSync(compiled), before) === 0, "the saved policy is untouched");
  // the same through the tool sweep's hook, and the owner's own explicit rebuild still works
  lines.length = 0; await tfAfter({}, { autoRebuildAfter: hook }); assert.equal(lines.length, 1);
  assert.equal((await sp(["rebuild", "--accept-shrink", "yes", ...fx])).code, 0);
});

test("autoRebuildAfter (library): prints each line through `write` (stderr by default), returns the result, and swallows a throwing rebuild or a throwing writer", async () => {
  const got = [];
  const r = await lib.autoRebuildAfter({ rebuild: async () => ({ code: 0, lines: ["one", "two"] }), write: (l) => got.push(l) });
  assert.deepEqual([r.code, got], [0, ["one", "two"]]);
  assert.equal(await lib.autoRebuildAfter({ rebuild: async () => { throw new Error("boom"); }, write: (l) => got.push(l) }), null);
  assert.equal(await lib.autoRebuildAfter({ rebuild: () => { throw new Error("sync"); } }), null);
  assert.equal(await lib.autoRebuildAfter({ rebuild: async () => ({ code: 1, lines: ["x"] }), write: () => { throw new Error("closed pipe"); } }), null, "a closed stderr cannot fail the caller");
  assert.equal(await lib.autoRebuildAfter({ rebuild: async () => undefined, write: (l) => got.push(l) }), null);
  assert.deepEqual(got, ["one", "two"]);
});


// ---- --no-rebuild is validated before any work (key.mjs, run.mjs)
test("--no-rebuild takes yes or no in key.mjs and run.mjs: any other value, or none, is a usage error BEFORE any work and before a subcommand parser can drop it", () => {
  const home = tmp();
  for (const bad of [["--no-rebuild", "maybe"], ["--no-rebuild"], ["--no-rebuild", ""]]) {
    for (const sub of [["default-model", "clear"], ["retier"], ["remove", "x"], ["list"]]) {
      const r = keyRun(home, ...sub, ...bad);
      assert.equal(r.status, 1, JSON.stringify([sub, bad])); assert.match(r.stderr, /^usage: --no-rebuild takes yes or no/); assert.equal(r.stdout, "", "nothing ran");
    }
  }
  assert.equal(keyRun(home, "default-model", "clear", "--no-rebuild", "no").status, 0);
  for (const bad of [["--no-rebuild", "maybe"], ["--no-rebuild"]]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "keysync", "run.mjs"), "--dry", ...bad], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60000 });
    assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /^--no-rebuild takes yes or no/); assert.equal(r.stdout, "", "before any work");
  }
});

// ---- the rebuild lock (issue #158)
const stateOf = (dir) => lib.resolvePaths(fixtureFlagMap(dir));
test("rebuild lock: exclusive create with {pid, at}; a held lock is reported; release removes only this taker's file", () => {
  const dir = tmp(), p = stateOf(dir), file = path.join(p.stateDir, "rebuild.lock");
  const a = lib.takeRebuildLock(p);
  assert.equal(a.ok, true); const rec = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(rec.pid, process.pid); assert.ok(Number.isFinite(Date.parse(rec.at)));
  const b = lib.takeRebuildLock(p);
  assert.deepEqual([b.ok, b.heldBy.pid], [false, process.pid]);
  a.release(); assert.ok(!fs.existsSync(file), "released");
  const c = lib.takeRebuildLock(p); assert.equal(c.ok, true);
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), n: "someone else" }));          // another taker took over after c went stale
  c.release(); assert.ok(fs.existsSync(file), "a release never deletes a lock it no longer owns");
  fs.rmSync(file);
  const d = lib.takeRebuildLock(p); d.release(); d.release(); assert.ok(!fs.existsSync(file), "release twice is harmless");
});

test("rebuild lock: a stale lock (older than 120 s), a lock of a dead process and a torn lock with an old time are taken over; a fresh lock of a live process and a torn fresh one are held; an uncreatable lock never blocks", () => {
  const dir = tmp(), p = stateOf(dir), file = path.join(p.stateDir, "rebuild.lock");
  fs.mkdirSync(p.stateDir, { recursive: true });
  const now = Date.now(), put = (o) => fs.writeFileSync(file, typeof o === "string" ? o : JSON.stringify(o));
  assert.equal(lib.REBUILD_LOCK_STALE_MS, 120000);
  put({ pid: 4242, at: new Date(now - 121000).toISOString() });
  assert.equal(lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true }).ok, true, "older than 120 s: taken over although the pid answers");
  fs.rmSync(file);
  put({ pid: 4242, at: new Date(now - 119000).toISOString() });
  assert.equal(lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true }).ok, false, "119 s and alive: held");
  assert.equal(lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => false }).ok, true, "the process is gone: taken over at once");
  fs.rmSync(file);
  put("{torn"); assert.equal(lib.takeRebuildLock(p, { nowMs: Date.now() }).ok, false, "torn but just written: held");
  const old = new Date(Date.now() - 300000); fs.utimesSync(file, old, old);
  assert.equal(lib.takeRebuildLock(p, { nowMs: Date.now() }).ok, true, "torn and old on disk: taken over");
  fs.rmSync(file, { force: true });
  // a lock of this very process that is still fresh is held (two writers in one process must not both run)
  put({ pid: process.pid, at: new Date(now).toISOString() }); assert.equal(lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => false }).ok, false);
  fs.rmSync(file);
  // the lock folder cannot be made (a file stands where it should be): the writer is not blocked
  const blocker = path.join(tmp(), "x"); fs.writeFileSync(blocker, "f");
  assert.equal(lib.takeRebuildLock({ stateDir: path.join(blocker, "subagent") }).ok, true);
  // race: two takers on a stale lock, exactly one wins
  put({ pid: 4242, at: new Date(now - 500000).toISOString() });
  const r1 = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true }), r2 = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true });
  assert.deepEqual([r1.ok, r2.ok], [true, false]);
});

test("rebuild lock: while it is held a real set, rebuild, rebuild --auto, resume and undo fail with ONE E_LOCKED line and write nothing; a preview and the read commands are not blocked; autoRebuildAfter reports the same line and goes on", async () => {
  const dir = tmp(), fx = flagsOf(dir), m = fixtureFlagMap(dir), p = stateOf(dir);
  assert.equal((await sp(["set", "--source", "all-providers", "--mode", "dynamic", ...fx])).code, 0);
  const compiled = path.join(m["state-dir"], "subagent", "policy.json"), ownerFile = m["policy-file"];
  const before = [fs.readFileSync(compiled), fs.readFileSync(ownerFile)];
  assert.equal((await sp(["pause", "--policy-file", ownerFile, "--state-dir", m["state-dir"]])).code, 0);                    // so that `resume` has something to do (it saves through the same writer)
  const before2 = [fs.readFileSync(compiled), fs.readFileSync(ownerFile)];
  const lock = lib.takeRebuildLock(p); assert.equal(lock.ok, true);
  const LINE = new RegExp("^E_LOCKED: another policy rebuild is running \\(pid " + process.pid + "\\); retry in a minute$"), AUTO = new RegExp("^E_LOCKED: another policy rebuild is running \\(pid " + process.pid + "\\); the policy stays as it is until the next trigger or a manual rebuild$");
  for (const argv of [["set", "--source", "all-providers", "--mode", "free", "--free-scope", "providers"], ["rebuild"], ["rebuild", "--if-stale", "yes"], ["undo"], ["resume"], ["set", "--source", "all-providers", "--mode", "dynamic"]]) {
    const r = await sp([...argv, ...fx]);
    assert.equal(r.code, 1, JSON.stringify(argv)); assert.match(r.err, LINE); assert.equal(r.err.split("\n").length, 1, "one line");
  }
  assert.ok(Buffer.compare(fs.readFileSync(compiled), before2[0]) === 0 && Buffer.compare(fs.readFileSync(ownerFile), before2[1]) === 0, "nothing written");
  const autoRun = await sp(["rebuild", "--auto", "yes", ...fx]);
  assert.equal(autoRun.code, 1); assert.match(autoRun.err, AUTO); assert.equal(autoRun.err.split("\n").length, 1, "the automatic rebuild promises no retry");
  // clear removes the compiled policy: it takes the lock too; pause and rollback (the emergency flip) never wait for it
  const two = ["--policy-file", ownerFile, "--state-dir", m["state-dir"]];
  const cl = await sp(["clear", ...two]); assert.equal(cl.code, 1); assert.match(cl.err, LINE);
  assert.ok(fs.existsSync(compiled) && fs.existsSync(ownerFile), "clear removed nothing");
  assert.equal((await sp(["pause", ...two])).code, 0, "pause is not locked"); assert.equal((await sp(["rollback", ...two])).code, 0, "rollback is not locked");
  assert.equal((await sp(["set", "--source", "all-providers", "--mode", "free", "--free-scope", "providers", "--dry", "yes", ...fx])).code, 0, "a preview writes nothing and takes no lock");
  assert.equal((await sp(["show", ...fx])).code, 0); assert.equal((await sp(["status", ...fx])).code, 0);
  const lines = [];
  const res = await lib.autoRebuildAfter({ extra: fx, write: (l) => lines.push(l) });
  assert.equal(res.code, 1); assert.equal(lines.length, 1); assert.match(lines[0], AUTO);
  lock.release();
  assert.equal((await sp(["rebuild", ...fx])).code, 0, "released: the owner's rebuild runs");
  assert.ok(!fs.existsSync(path.join(p.stateDir, "rebuild.lock")), "and leaves no lock behind");
});

test("rebuild lock: released when the command returns, when it fails with a refusal and when it throws; a stale lock is taken over by a command and nothing is left behind", async () => {
  const dir = tmp(), fx = flagsOf(dir), m = fixtureFlagMap(dir), p = stateOf(dir), lockFile = path.join(p.stateDir, "rebuild.lock");
  assert.equal((await sp(["set", "--source", "all-providers", "--mode", "dynamic", ...fx])).code, 0); assert.ok(!fs.existsSync(lockFile), "a set returned");
  // a refusal (the snapshot shrank): the lock is gone
  const sn = JSON.parse(fs.readFileSync(m["snapshot-file"], "utf8")); for (const r of sn.rows) r.models = r.models.slice(0, 1); sn.builtAt = new Date(Date.now() + 1000).toISOString(); fs.writeFileSync(m["snapshot-file"], JSON.stringify(sn));
  assert.equal((await sp(["rebuild", ...fx])).code, 1); assert.ok(!fs.existsSync(lockFile), "a refused rebuild");
  // a throw that is not a policy error
  await assert.rejects(lib.runSubagentPolicy(["rebuild", ...fx], { out() {}, err() {} }, {}, { get liveProviders() { throw new Error("boom"); } }), /boom/);
  assert.ok(!fs.existsSync(lockFile), "a rebuild that threw");
  await assert.rejects(lib.runSubagentPolicy(["set", "--source", "all-providers", "--mode", "dynamic", ...fx], { out() {}, err() {} }, {}, { get liveProviders() { throw new Error("boom2"); } }), /boom2/);
  assert.ok(!fs.existsSync(lockFile), "a set that threw");
  // a stale lock (a crashed writer) does not block
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, at: new Date(Date.now() - 300000).toISOString() }));
  assert.equal((await sp(["rebuild", "--accept-shrink", "yes", ...fx])).code, 0, "taken over");
  assert.ok(!fs.existsSync(lockFile));
});

test("rebuild lock: a state folder the lock had to create is removed again on release (a refused command leaves nothing behind); one that holds anything else, or that existed, stays", () => {
  const root = tmp(), p = { stateDir: path.join(root, "st", "subagent") };
  const a = lib.takeRebuildLock(p); assert.ok(fs.existsSync(p.stateDir)); a.release();
  assert.ok(!fs.existsSync(p.stateDir) && !fs.existsSync(path.join(root, "st")), "created by the lock, removed by the release");
  const b = lib.takeRebuildLock(p); fs.writeFileSync(path.join(p.stateDir, "policy.json"), "{}"); b.release();
  assert.ok(fs.existsSync(path.join(p.stateDir, "policy.json")), "something was written there: it stays");
  const c = lib.takeRebuildLock(p); c.release(); assert.ok(fs.existsSync(p.stateDir), "it existed before this lock: it stays");
});


// ---- the takeover race (reproduced by the review) and the retry rules
const lockEnv = () => { const dir = tmp(), p = stateOf(dir); fs.mkdirSync(p.stateDir, { recursive: true }); return { p, file: path.join(p.stateDir, "rebuild.lock"), take: path.join(p.stateDir, "rebuild.lock.takeover") }; };
test("rebuild lock takeover (race): A takes the stale lock over BETWEEN B's read and B's removal: exactly ONE ends up holding, and A's fresh lock is never removed; no takeover file is left", () => {
  const { p, file, take } = lockEnv(), now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: new Date(now - 500000).toISOString() }));
  let A = null;
  // B reads the stale lock and asks whether its pid is alive: that is the moment A takes it over
  const B = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => { A = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => false }); return false; } });
  assert.equal(A.ok, true, "A took the lock over"); assert.equal(B.ok, false, "B must not also hold");
  assert.ok(fs.existsSync(file), "A's fresh lock is still there"); assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).pid, process.pid);
  assert.ok(!fs.existsSync(take), "the takeover file is gone");
  A.release(); assert.ok(!fs.existsSync(file));
  // the other order too: B is first, A (a later reader of the same stale lock) finds it fresh
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: new Date(now - 500000).toISOString() }));
  const first = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true }), second = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true });
  assert.deepEqual([first.ok, second.ok], [true, false]);
});

test("rebuild lock takeover file: serialises takers, a leftover older than 10 s is removed, a fresh one makes the taker wait a bounded time and never block for good, and none is left after a takeover", () => {
  const { p, file, take } = lockEnv(), now = Date.now();
  assert.equal(lib.TAKEOVER_STALE_MS, 10000);
  const stale = () => fs.writeFileSync(file, JSON.stringify({ pid: 4242, at: new Date(now - 500000).toISOString() }));
  stale(); fs.writeFileSync(take, "crashed taker"); const old = new Date(now - 11000); fs.utimesSync(take, old, old);
  const a = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true });
  assert.equal(a.ok, true, "a takeover file left by a crashed taker (11 s old) is removed"); assert.ok(!fs.existsSync(take)); a.release();
  stale(); fs.writeFileSync(take, "a taker at work"); const recent = new Date(now - 1000); fs.utimesSync(take, recent, recent);
  const t0 = Date.now(), b = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true });
  assert.equal(b.ok, false); assert.ok(Date.now() - t0 < 5000, "the wait is bounded");
  assert.equal(fs.readFileSync(take, "utf8"), "a taker at work", "another taker's file is not touched");
  fs.rmSync(take, { force: true }); fs.rmSync(file, { force: true });
  // an uncreatable takeover file (a read-only folder) lets the writer run, with a note
  stale();
  const failing = lib.takeRebuildLock(p, { nowMs: now, pidAlive: () => true, open: (f, fl) => { if (String(f).endsWith(".takeover")) { const e = new Error("ro"); e.code = "EROFS"; throw e; } return fs.openSync(f, fl); } });
  assert.equal(failing.ok, true); assert.match(failing.note, /^NOTE: the rebuild lock could not be created \(EROFS\); this run is not serialised with another writer$/);
});

test("rebuild lock errors: EPERM, EACCES and EBUSY are retried (a busy file is not a held lock); ENOENT, EROFS and ENOSPC let the writer run with a one-line note; any other error is retried a few times and then reported as held, never as success", () => {
  const flaky = (code, times) => { let n = 0; return (f, fl) => { if (!String(f).endsWith(".lock") || n >= times) return fs.openSync(f, fl); n += 1; const e = new Error(code); e.code = code; throw e; }; };
  for (const [code, times] of [["EPERM", 2], ["EBUSY", 1], ["EACCES", 3]]) {
    const { p, file } = lockEnv(); const r = lib.takeRebuildLock(p, { open: flaky(code, times) });
    assert.equal(r.ok, true, code); assert.equal(r.note, undefined, code + ": no note, it was only busy"); assert.ok(fs.existsSync(file)); r.release();
  }
  for (const code of ["EPERM", "EACCES", "EBUSY", "EIO"]) {
    const { p, file } = lockEnv(); const t0 = Date.now(); const r = lib.takeRebuildLock(p, { open: flaky(code, 1000) });
    assert.deepEqual([r.ok, r.heldBy], [false, null], code + ": reported, not silently let through"); assert.ok(!fs.existsSync(file)); assert.ok(Date.now() - t0 < 5000, "bounded");
  }
  for (const code of ["ENOENT", "EROFS", "ENOSPC"]) {
    const { p, file } = lockEnv(); const r = lib.takeRebuildLock(p, { open: flaky(code, 1000) });
    assert.equal(r.ok, true, code); assert.match(r.note, new RegExp("^NOTE: the rebuild lock could not be created \\(" + code + "\\); this run is not serialised with another writer$")); assert.ok(!fs.existsSync(file));
  }
  const blocker = path.join(tmp(), "x"); fs.writeFileSync(blocker, "f");
  const noDir = lib.takeRebuildLock({ stateDir: path.join(blocker, "subagent") }); assert.equal(noDir.ok, true); assert.match(noDir.note, /^NOTE: the rebuild lock could not be created \(/);
});

test("--no-rebuild: EVERY occurrence is validated, not only the first (key.mjs and keysync/run.mjs)", () => {
  const home = tmp();
  for (const bad of [["--no-rebuild", "yes", "--no-rebuild", "maybe"], ["--no-rebuild", "maybe", "--no-rebuild", "yes"], ["--no-rebuild", "no", "--no-rebuild"], ["--no-rebuild", "--no-rebuild", "yes"]]) {
    for (const sub of [["default-model", "clear"], ["retier"]]) {
      const r = keyRun(home, ...sub, ...bad);
      assert.equal(r.status, 1, JSON.stringify([sub, bad])); assert.match(r.stderr, /^usage: --no-rebuild takes yes or no/); assert.equal(r.stdout, "");
    }
    const r2 = spawnSync(process.execPath, [path.join(ROOT, "keysync", "run.mjs"), "--dry", ...bad], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 60000 });
    assert.equal(r2.status, 2, JSON.stringify(bad)); assert.match(r2.stderr, /^--no-rebuild takes yes or no/); assert.equal(r2.stdout, "");
  }
  assert.equal(keyRun(home, "default-model", "clear", "--no-rebuild", "yes", "--no-rebuild", "no").status, 0, "two valid occurrences are fine: the last decides");
});

// CCR 3.1.1 trial flows with injected fakes: start31 (dry-run purity, refusals, failure cleanup, order),
// teardown31 (identity check against a fake process table, backup retention on failure vs deletion on
// success), and the verify-isolation31 checks (settings -1 sentinel, guard-loaded staleness, per-check
// containment). No real fs mutation outside temp dirs, no registry, no process table, no network, no CCR.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  TRIAL_ROOT, CLI_JS, INSTALL_ROUTER_PKG, INSTALL_GATEWAY_PKG, SQLITE_BINDING, CCR_CONFIG_DIR, SERVICE_JSON, REAL_GLOBAL_CCR, HKCU_PATH_BACKUP,
  VIOLATIONS_LOG, GUARD_LOADED_LOG, PORT_RANGE, REAL_PORTS, BACKUP, TRIPWIRE_BASELINE, HOME, ROAMING,
} from "../harness/trial31/config31.mjs";
import { runStart } from "../harness/trial31/start31.mjs";
import { runTeardown } from "../harness/trial31/teardown31.mjs";
import { stopVerified, stopOwnedChild, rotateLogs, PRESERVE, NO_SANDBOX_SEGMENT } from "../harness/trial31/tripwire31.mjs";
import {
  verifyIsolation, checkSettings, checkGuardLoaded, parseLoadedLog, settingsState, settingsMarkerCount, renderProof,
} from "../harness/trial31/verify-isolation31.mjs";

const norm = (p) => path.normalize(p).toLowerCase();
const SAVED = { type: "REG_EXPAND_SZ", value: "C:\\a;%USERPROFILE%\\b" };
const TOKENS = { web: "a".repeat(48), service: "b".repeat(48) };
const REAL_BINDING = path.join(REAL_GLOBAL_CCR, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
const REAL_SQLITE_PKG = path.join(REAL_GLOBAL_CCR, "node_modules", "better-sqlite3", "package.json");
const SANDBOX_SQLITE_PKG = path.join(path.dirname(SQLITE_BINDING), "..", "..", "package.json");
const OLD_SVC = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..", "harness", "scratch", "appdata", "claude-code-router", "service.json");

// ---------------------------------------------------------------- start31 fakes
function mkFs({ present = [], json = {}, mutations, serviceReads = [] }) {
  const has = new Set(present.map(norm));
  let svcIdx = 0;
  const f = {
    existsSync: (p) => has.has(norm(p)),
    readFileSync: (p) => {
      if (norm(p) === norm(SERVICE_JSON)) {
        const v = serviceReads[Math.min(svcIdx++, serviceReads.length - 1)];
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      }
      const v = json[norm(p)];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return v;
    },
  };
  for (const n of ["mkdirSync", "writeFileSync", "openSync", "closeSync", "copyFileSync", "renameSync", "unlinkSync", "rmSync"]) {
    f[n] = (...a) => { mutations.push([n, ...a.map((x) => (typeof x === "string" ? x : typeof x))]); return n === "openSync" ? 9 : undefined; };
  }
  return f;
}
const healthyJson = () => ({
  [norm(INSTALL_ROUTER_PKG)]: JSON.stringify({ version: "3.1.1" }),
  [norm(INSTALL_GATEWAY_PKG)]: JSON.stringify({ version: "1.0.21" }),
  [norm(REAL_SQLITE_PKG)]: JSON.stringify({ version: "12.11.1" }),
  [norm(SANDBOX_SQLITE_PKG)]: JSON.stringify({ version: "12.11.1" }),
});
function mkDeps({ over = {}, fsOver = {}, child } = {}) {
  const log = [], mutations = [], out = [], err = [];
  const ch = child ?? Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null, unref() { log.push("child.unref"); }, kill() { log.push("child.kill"); } });
  const fsx = mkFs({ present: [REAL_BINDING], json: healthyJson(), mutations, serviceReads: [JSON.stringify({ pid: 777, url: "http://127.0.0.1:39468/?ccr_web_token=x", startedAt: new Date().toISOString() })], ...fsOver });
  const deps = {
    fs: fsx, mutations, log, out, err,
    listenerPid: () => undefined, env: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" },
    readTable: () => [], readUserPath: () => SAVED,
    backupUserPath: () => { log.push("backupUserPath"); return SAVED; },
    applyAcl: () => { log.push("acl"); return { user: "H\\u", sid: "S-1-5-21-1" }; },
    copyVerified: (a, b) => { log.push(["copy", b]); return "copied"; },
    preLaunchCanary: () => { log.push("canary"); return { ok: true, detail: "canary ok" }; },
    rotateLogs: () => { log.push("rotate"); return []; },
    settingsState: () => ({ count: 2, hash: "h1" }),
    makeTripwire31: () => ({ save: () => log.push("tripwire.save"), assert() {} }),
    verifyIsolation: async () => { log.push("verify"); return { ok: true, checks: [{ n: 1, name: "x", ok: true, detail: "d" }], measurements: { homeWrites: [] } }; },
    autoClean: async (o) => { log.push(["autoClean", o]); return [["path-ok", true]]; },
    stopOwnedChild: (c) => { log.push(["stopOwnedChild", c && c.exitCode]); return { stopped: true }; },
    spawn: () => { log.push("spawn"); return ch; },
    now: () => Date.now(), sleep: async () => {}, proofFile: "C:\\t\\proof.md", tokens: TOKENS,
    ...over,
  };
  deps.out = over.out ?? ((m) => out.push(String(m)));
  deps.err = over.err ?? ((m) => err.push(String(m)));
  return { deps, log, mutations, out, err, child: ch };
}
const flat = (log) => log.map((x) => (Array.isArray(x) ? x[0] : x));

// ---------------------------------------------------------------- start31: dry run and refusals
test("start31 --dry (sec M9/code M2): read-only preflight and 'would ...' lines; NOTHING is created, copied, ACL'd, spawned or backed up", async () => {
  const { deps, log, mutations, out, err } = mkDeps();
  const trap = (n) => () => { throw new Error(`${n} must not run in --dry`); };
  Object.assign(deps, {
    applyAcl: trap("applyAcl"), copyVerified: trap("copyVerified"), preLaunchCanary: trap("canary"), rotateLogs: trap("rotateLogs"), backupUserPath: trap("backupUserPath"),
    makeTripwire31: trap("makeTripwire31"), verifyIsolation: trap("verifyIsolation"), autoClean: trap("autoClean"), spawn: trap("spawn"), stopOwnedChild: trap("stopOwnedChild"),
  });
  assert.equal(await runStart(["--g2-approved", "--dry"], deps), 0, err.join("\n"));
  assert.deepEqual(mutations, [], `no fs mutation: ${JSON.stringify(mutations)}`);
  assert.deepEqual(log, []);
  const text = out.join("\n");
  assert.match(text, /dry run \(nothing created, copied, applied or started\)/);
  for (const w of ["would create the sandbox dirs", "would apply an owner-only ACL", "would copy the better-sqlite3", "would run the pre-launch guard canary", "would rotate", "would write the restore kit", "would spawn the sandbox daemon"]) {
    assert.ok(text.includes(w), w);
  }
  assert.ok(text.includes("***"), "the env is printed with the tokens masked");
  assert.ok(!text.includes(TOKENS.web) && !text.includes(TOKENS.service), "no token in the output");
  assert.deepEqual(err, []);
});

test("start31 refuses without --g2-approved (exit 2) and touches nothing", async () => {
  const { deps, log, mutations } = mkDeps();
  assert.equal(await runStart([], deps), 2);
  assert.equal(await runStart(["--dry"], deps), 2);
  assert.deepEqual([log, mutations], [[], []]);
});

test("start31 preflight refusals (exit 1, nothing created): wrong version, gateway '1.0' (padding bug), existing config.sqlite, trial port in use, PATH already spliced, restore kit present", async () => {
  const cases = {
    "router version": { fsOver: { json: { ...healthyJson(), [norm(INSTALL_ROUTER_PKG)]: JSON.stringify({ version: "3.0.22" }) } }, re: /expected 3\.1\.1/ },
    "gateway 1.0 is not >= 1.0.21": { fsOver: { json: { ...healthyJson(), [norm(INSTALL_GATEWAY_PKG)]: JSON.stringify({ version: "1.0" }) } }, re: /< 1\.0\.21/ },
    "config.sqlite exists": { fsOver: { present: [REAL_BINDING, path.join(CCR_CONFIG_DIR, "config.sqlite")] }, re: /not a first start/ },
    "restore kit exists": { fsOver: { present: [REAL_BINDING, HKCU_PATH_BACKUP] }, re: /restore kit .* already exists.*node harness\/trial31\/teardown31\.mjs\s.*node harness\/trial31\/teardown31\.mjs --discard-kit.*provably gone/s },
    "settings unreadable (checked in preflight, before any kit is written)": { over: { settingsState: () => ({ count: -1, hash: "(unreadable)" }) }, re: /settings\.json is unreadable/ },
    "version file unreadable": { fsOver: { json: { ...healthyJson(), [norm(INSTALL_ROUTER_PKG)]: "{not json" } }, re: /cannot read a version from/ },
    "listener check throws": { over: { listenerPid: () => { throw new Error("Get-NetTCPConnection failed"); } }, re: /cannot check port .*Get-NetTCPConnection failed/ },
    "trial port in use": { over: { listenerPid: (p) => (p === 39460 ? 4321 : undefined) }, re: /listens on trial port 39460/ },
    "PATH already spliced": { over: { readUserPath: () => ({ type: "REG_SZ", value: `C:\\a;${TRIAL_ROOT}\\roaming\\claude-code-router\\bin` }) }, re: /already contains a sandbox segment/ },
    "better-sqlite3 version mismatch": { fsOver: { json: { ...healthyJson(), [norm(REAL_SQLITE_PKG)]: JSON.stringify({ version: "12.0.0" }) } }, re: /version mismatch/ },
  };
  for (const [name, c] of Object.entries(cases)) {
    for (const flags of [["--g2-approved", "--dry"], ["--g2-approved"]]) {
      const { deps, log, mutations, err } = mkDeps({ over: c.over, fsOver: c.fsOver });
      assert.equal(await runStart(flags, deps), 1, `${name} ${flags.join(" ")}`);
      assert.match(err.join("\n"), c.re, name);
      assert.deepEqual([log, mutations], [[], []], `${name}: nothing created or launched`);
    }
  }
});

test("start31 old-3.0.22-daemon preflight (code H3): an alive pid counts only if its command line is a ccr daemon; a recycled pid is ignored", async () => {
  const oldCli = path.join(REAL_GLOBAL_CCR, "dist", "main", "cli.js");
  const svcJson = { [norm(OLD_SVC)]: JSON.stringify({ pid: 4444 }) };
  const withOld = (rows) => mkDeps({ fsOver: { present: [REAL_BINDING, OLD_SVC], json: { ...healthyJson(), ...svcJson } }, over: { readTable: () => rows } });
  let t = withOld([{ ProcessId: 4444, CommandLine: `node.exe ${oldCli} serve --daemon-child`, StartMs: 1, Name: "node.exe" }]);
  assert.equal(await runStart(["--g2-approved", "--dry"], t.deps), 1);
  assert.match(t.err.join("\n"), /3\.0\.22 harness daemon \(pid 4444\) is alive/);
  t = withOld([{ ProcessId: 4444, CommandLine: "C:\\Windows\\System32\\svchost.exe -k x", StartMs: 1, Name: "svchost.exe" }]);
  assert.equal(await runStart(["--g2-approved", "--dry"], t.deps), 0, t.err.join("\n"));
  assert.match(t.out.join("\n"), /recycled pid/);
  t = withOld([]);
  assert.equal(await runStart(["--g2-approved", "--dry"], t.deps), 0, "dead pid");
});

// ---------------------------------------------------------------- start31: real path with fakes
test("start31 success: ACL, verified copy, canary, log rotation, restore kit, baseline, then spawn, in that order; the daemon is left running", async () => {
  const { deps, log, err, out } = mkDeps();
  assert.equal(await runStart(["--g2-approved"], deps), 0, err.join("\n"));
  const order = flat(log);
  const idx = (n) => order.indexOf(n);
  const seq = ["acl", "copy", "canary", "rotate", "backupUserPath", "tripwire.save", "spawn", "verify", "child.unref"].map(idx);
  assert.ok(seq.every((i, k) => i >= 0 && (k === 0 || i > seq[k - 1])), `order: ${order.join(",")}`);
  assert.ok(!order.includes("autoClean"));
  assert.ok(out.join("\n").includes("ALL GREEN"));
  assert.match(out.join("\n"), /restore kit stays in/);
  assert.ok(deps.mutations.some((m) => m[0] === "writeFileSync" && m[1] === "C:\\t\\proof.md"));
});

test("start31: a failing pre-launch canary refuses before any restore kit or spawn exists", async () => {
  const { deps, log, err } = mkDeps({ over: { preLaunchCanary: () => ({ ok: false, detail: "guard=false blocked=false" }) } });
  assert.equal(await runStart(["--g2-approved"], deps), 1);
  assert.match(err.join("\n"), /canary FAILED.*refusing to launch/);
  assert.ok(!flat(log).includes("spawn") && !flat(log).includes("backupUserPath") && !flat(log).includes("rotate"));
  assert.ok(!/PREFLIGHT/.test(err.join("\n")), "dirs and the ACL exist by now: this is not a preflight failure");
  assert.match(err.join("\n"), /SETUP FAILED.*nothing was launched.*sandbox dirs.*owner-only ACL/s);
});

test("start31 (code L3/sec L5): a failing setup step (ACL, verified copy, canary throwing, log rotation) is a one-line SETUP FAILED that says what was created; nothing launched or backed up", async () => {
  const steps = {
    "applyAcl": { over: { applyAcl: () => { throw new Error("icacls exit 5"); } }, re: /applying the owner-only ACL failed \(icacls exit 5\).*Created so far: sandbox dirs under [^;]*\(possibly partial\)\. Run teardown31/s },
    "copyVerified": { over: { copyVerified: () => { throw new Error("EBUSY"); } }, re: /copying the better-sqlite3 binding failed \(EBUSY\).*owner-only ACL/s },
    "canary throws": { over: { preLaunchCanary: () => { throw new Error("spawnSync ETIMEDOUT"); } }, re: /the pre-launch guard canary failed \(spawnSync ETIMEDOUT\)/ },
    "rotateLogs": { over: { rotateLogs: () => { throw new Error("EPERM rename"); } }, re: /rotating the evidence logs failed \(EPERM rename\)/ },
  };
  for (const [name, c] of Object.entries(steps)) {
    const { deps, log, err } = mkDeps({ over: c.over });
    let code, thrown;
    try { code = await runStart(["--g2-approved"], deps); } catch (e) { thrown = e; }
    assert.equal(thrown, undefined, `${name}: no unhandled rejection / stack`);
    assert.equal(code, 1, name);
    const text = err.join("\n");
    assert.match(text, c.re, name);
    assert.ok(text.startsWith("SETUP FAILED:") && !text.includes("PREFLIGHT") && text.split("\n").length === 1, `${name}: one clean line: ${text}`);
    assert.ok(!flat(log).includes("spawn") && !flat(log).includes("backupUserPath"), name);
  }
});

test("start31 (sec H3/code H1): ANY exception after the spawn triggers stop-then-autoClean and a non-zero exit, and the restore kit is kept", async () => {
  const failures = {
    "verifyIsolation throws": { over: { verifyIsolation: async () => { throw new SyntaxError("torn guard-loaded.log line"); } }, re: /torn guard-loaded/ },
    "proof RED": { over: { verifyIsolation: async () => ({ ok: false, checks: [{ n: 3, name: "settings", ok: false, detail: "CHANGED" }], measurements: { homeWrites: [] } }) }, re: /ISOLATION PROOF FAILED/ },
    "makeTripwire31 throws": { over: { makeTripwire31: () => { throw new Error("powershell failed"); } }, re: /powershell failed/ },
    "spawn throws": { over: { spawn: () => { throw new Error("EPERM spawn"); } }, re: /EPERM spawn/ },
  };
  for (const [name, c] of Object.entries(failures)) {
    const { deps, log, err } = mkDeps({ over: c.over });
    assert.equal(await runStart(["--g2-approved"], deps), 1, name);
    const order = flat(log);
    assert.ok(order.includes("autoClean"), `${name}: auto-clean ran`);
    if (order.includes("spawn")) assert.ok(order.indexOf("stopOwnedChild") < order.indexOf("autoClean"), `${name}: the daemon is stopped BEFORE the PATH restore / delete`);
    const ac = log.find((x) => Array.isArray(x) && x[0] === "autoClean")[1];
    assert.deepEqual(ac.pids, [], "the child is stopped through the handle we own, not by a bare pid");
    assert.deepEqual(ac.savedPath, order.includes("backupUserPath") ? SAVED : undefined);
    assert.match(err.join("\n"), c.re, name);
    assert.match(err.join("\n"), /RESTORE KIT KEPT/, name);
  }
});

test("start31: a daemon that dies early is never signalled by pid (exitCode !== null); torn service.json reads are retried", async () => {
  const dead = Object.assign(new EventEmitter(), { pid: 888, exitCode: 1, signalCode: null, unref() {}, kill() { throw new Error("must not kill"); } });
  const killed = [];
  const { deps, err } = mkDeps({
    child: dead, fsOver: { serviceReads: [undefined] },
    over: { stopOwnedChild: (c, o) => stopOwnedChild(c, { ...o, table: [{ ProcessId: 888, CommandLine: `node ${CLI_JS} serve --daemon-child`, StartMs: Date.now() }], kill: (p) => killed.push(p) }) },
  });
  assert.equal(await runStart(["--g2-approved"], deps), 1);
  assert.deepEqual(killed, [], "no taskkill for an already-exited child");
  assert.match(err.join("\n"), /daemon did not come up/);
  // torn read (half-written JSON) then a valid one: the wait loop retries instead of throwing
  const good = JSON.stringify({ pid: 777, url: "http://127.0.0.1:39468/", startedAt: new Date().toISOString() });
  const t = mkDeps({ fsOver: { serviceReads: ["{\"pid\":77", "", good] } });
  assert.equal(await runStart(["--g2-approved"], t.deps), 0, t.err.join("\n"));
});

test("start31 (code H1/sec M1): after a spawn failure the LIVE daemon handle is killed when the identity path throws, finds no row, or is skipped; an exited child is never killed", async () => {
  const live = () => Object.assign(new EventEmitter(), { pid: 777, exitCode: null, signalCode: null, unref() {}, kill() { this.log.push("child.kill"); }, log: [] });
  const boom = () => { throw new Error("powershell failed"); };
  const cases = {
    "stopOwnedChild itself throws": (c) => ({ stopOwnedChild: boom }),
    "table read throws": () => ({ stopOwnedChild: (c, o) => stopOwnedChild(c, { ...o, table: { find: boom }, kill: boom }) }),
    "empty table row (gone) while the handle is alive": () => ({ stopOwnedChild: (c, o) => stopOwnedChild(c, { ...o, table: [], kill: boom }) }),
    "row is not ours (skipped)": () => ({ stopOwnedChild: (c, o) => stopOwnedChild(c, { ...o, table: [{ ProcessId: 777, Name: "svchost.exe", CommandLine: "svchost.exe -k x", StartMs: Date.now() }], kill: boom }) }),
  };
  for (const [name, mk] of Object.entries(cases)) {
    const ch = live();
    const { deps, err } = mkDeps({ child: ch, over: { ...mk(), verifyIsolation: async () => { throw new Error("proof exploded"); } } });
    assert.equal(await runStart(["--g2-approved"], deps), 1, name);
    assert.deepEqual(ch.log, ["child.kill"], `${name}: exactly one handle kill`);
    assert.match(err.join("\n"), /killedHandleOnly/, name);
  }
  const dead = Object.assign(new EventEmitter(), { pid: 778, exitCode: 1, signalCode: null, unref() {}, kill() { throw new Error("must not kill"); } });
  const t = mkDeps({ child: dead, fsOver: { serviceReads: [undefined] }, over: { stopOwnedChild: boom } });
  assert.equal(await runStart(["--g2-approved"], t.deps), 1);
  assert.match(t.err.join("\n"), /auto-clean/, "an already-exited child is never killed, even when the identity path throws");
});

// ---------------------------------------------------------------- teardown31
const NOW = Date.now();
const daemonRow = (pid, startMs = NOW) => ({ ProcessId: pid, ParentProcessId: 1, Name: "node.exe", CommandLine: `"C:\\node.exe" ${CLI_JS} serve --daemon-child --no-open`, StartMs: startMs });
function mkTeardown({ svc = { pid: 601, startedAt: new Date(NOW).toISOString() }, table = [daemonRow(601)], tripwireFails = false, restoreResult = { restored: false, reason: NO_SANDBOX_SEGMENT }, deleteResults = [], over = {} } = {}) {
  const log = [], out = [], err = [], killed = [];
  const d = {
    fs: { readFileSync: (p) => { if (norm(p) === norm(SERVICE_JSON) && svc) return JSON.stringify(svc); throw new Error("ENOENT"); } },
    listenerPid: () => undefined, readTable: () => table,
    loadBaseline: (f) => { log.push(["loadBaseline", f]); return { "file:x": "a" }; },
    makeTripwire31: (o) => { log.push(["makeTripwire31", o]); return { assert: () => { if (tripwireFails) throw new Error("ISOLATION VIOLATION: file:x CHANGED"); } }; },
    stop: (pid, o) => { const r = stopVerified(pid, { ...o, table, kill: (p) => { log.push(["kill", p]); killed.push(p); } }); log.push(["stop", pid, r]); return r; },
    restore: () => { log.push("restore"); return restoreResult; },
    readUserPath: () => SAVED,
    deleteSandbox: async (root, o) => { log.push(["deleteSandbox", o.preserve]); return deleteResults.length ? deleteResults.shift() : true; },
    removeBackup: (dir) => { log.push(["removeBackup", dir]); return true; },
    out: (m) => out.push(String(m)), err: (m) => err.push(String(m)), ...over,
  };
  return { d, log, out, err, killed };
}

test("teardown31 (sec H2): kills only an identity-verified pid; a recycled pid is 'not-ours: skipped'; the sandbox files are still cleaned", async () => {
  const recycled = mkTeardown({ svc: { pid: 602, startedAt: new Date(NOW).toISOString() }, table: [{ ProcessId: 602, Name: "svchost.exe", CommandLine: "C:\\Windows\\System32\\svchost.exe -k netsvcs", StartMs: NOW }] });
  assert.equal(await runTeardown([], recycled.d), 0);
  assert.deepEqual(recycled.killed, [], "no kill");
  assert.match(recycled.out.join("\n"), /not-ours: skipped/);
  assert.ok(recycled.log.some((l) => Array.isArray(l) && l[0] === "deleteSandbox"), "files are still deleted");
  const older = mkTeardown({ table: [daemonRow(601, NOW - 86_400_000)] });
  assert.equal(await runTeardown([], older.d), 0);
  assert.deepEqual(older.killed, [], "a process older than service.json is not ours");
  const ours = mkTeardown();
  assert.equal(await runTeardown([], ours.d), 0);
  assert.deepEqual(ours.killed, [601]);
  // service.json missing/torn: the daemon is still found by its command line
  const torn = mkTeardown({ svc: null, table: [daemonRow(650), { ProcessId: 651, Name: "node.exe", CommandLine: "node C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js serve --daemon-child", StartMs: NOW }] });
  assert.equal(await runTeardown([], torn.d), 0);
  assert.deepEqual(torn.killed, [650], "only the SANDBOX daemon, never the live global one");
  const live = mkTeardown({ over: { listenerPid: (p) => (p === 3458 ? 601 : undefined) } });
  await assert.rejects(runTeardown([], live.d), /LIVE listener/);
  assert.deepEqual(live.killed, []);
});

test("teardown31 order and baseline: stop, then PATH restore, then delete; the persisted baseline (not a fresh one) is used", async () => {
  const t = mkTeardown();
  assert.equal(await runTeardown([], t.d), 0, t.err.join("\n"));
  const names = t.log.map((l) => (Array.isArray(l) ? l[0] : l));
  assert.ok(names.indexOf("kill") < names.indexOf("restore") && names.indexOf("restore") < names.indexOf("deleteSandbox"), names.join(","));
  assert.deepEqual(t.log.find((l) => l[0] === "loadBaseline")[1], TRIPWIRE_BASELINE);
  assert.deepEqual(t.log.find((l) => l[0] === "makeTripwire31")[1], { baseline: { "file:x": "a" } });
  const noBaseline = mkTeardown({ over: { loadBaseline: () => undefined } });
  await runTeardown([], noBaseline.d);
  assert.match(noBaseline.err.join("\n"), /no persisted tripwire baseline/);
});

test("start31/teardown31 (G2 run 1, item 5): both warn that daemon.out.log holds the web token URL; a failing start echoes only a REDACTED tail of the daemon logs", async () => {
  const web = crypto.randomBytes(24).toString("hex");
  const outLog = path.join(TRIAL_ROOT, "run", "daemon.out.log");
  const json = { ...healthyJson(), [norm(outLog)]: `booting\nCCR management server: http://127.0.0.1:39468/?ccr_web_token=${web}\nready\n` };
  const okRun = mkDeps({ fsOver: { json } });
  assert.equal(await runStart(["--g2-approved"], okRun.deps), 0, okRun.err.join("\n"));
  assert.match(okRun.out.join("\n"), /daemon\.out\.log contains the management-server URL with this run's web token[^]*Never print/);
  assert.ok(!okRun.out.join("\n").includes(web) && !okRun.err.join("\n").includes(web), "a successful start never echoes the log");

  const bad = mkDeps({ fsOver: { json }, over: { verifyIsolation: async () => { throw new Error("proof exploded"); } } });
  assert.equal(await runStart(["--g2-approved"], bad.deps), 1);
  const errText = bad.err.join("\n");
  assert.match(errText, /Never print/);
  assert.match(errText, /daemon\.out\.log \(last lines, secrets redacted\)/);
  assert.match(errText, /ccr_web_token=<redacted>/);
  assert.ok(!errText.includes(web) && !bad.out.join("\n").includes(web), "the token never reaches the console");

  const td = mkTeardown();
  await runTeardown([], td.d);
  assert.match(td.out.join("\n"), /daemon\.out\.log contains the management-server URL[^]*Never print/);
});

test("teardown31 (code H2/sec M3): the restore kit is deleted ONLY after a passing teardown with a clean PATH; kept on tripwire failure, unconfirmed PATH, or --keep", async () => {
  const pass = mkTeardown();
  assert.equal(await runTeardown([], pass.d), 0);
  const first = pass.log.find((l) => l[0] === "deleteSandbox");
  assert.ok(first[1].includes("backup"), "the kit survives the sandbox deletion pass");
  assert.deepEqual(pass.log.find((l) => l[0] === "removeBackup"), ["removeBackup", BACKUP], "then it is removed after the tripwire passed");
  assert.match(pass.out.join("\n"), /restore kit deleted after a passing teardown/);

  const tripped = mkTeardown({ tripwireFails: true });
  assert.equal(await runTeardown([], tripped.d), 1);
  assert.ok(!tripped.log.some((l) => l[0] === "removeBackup"), "kit kept after a tripwire failure");
  assert.match(tripped.err.join("\n"), /RESTORE KIT KEPT.*tripwire fired/s);
  assert.match(tripped.err.join("\n"), /settings\.json\.pre-trial31/);

  for (const restoreResult of [{ restored: false, reason: "unreadable" }, { restored: false, reason: "removing the sandbox segments would empty PATH; not written" }]) {
    const badPath = mkTeardown({ restoreResult });
    assert.equal(await runTeardown([], badPath.d), 1, "an unconfirmed PATH is a failed teardown (exit 1)");
    assert.ok(!badPath.log.some((l) => l[0] === "removeBackup"), `kit kept when PATH is unconfirmed (${restoreResult.reason})`);
    assert.match(badPath.err.join("\n"), /PATH could not be confirmed clean/);
  }
  const throwing = mkTeardown({ over: { restore: () => { throw new Error("reg denied"); } } });
  assert.equal(await runTeardown([], throwing.d), 1, "a throwing restore is a failed teardown (exit 1)");
  assert.ok(!throwing.log.some((l) => l[0] === "removeBackup"), "a throwing restore keeps the kit (hkcu-path.json is never deleted unless the restore succeeded)");

  const keep = mkTeardown();
  assert.equal(await runTeardown(["--keep"], keep.d), 0);
  assert.ok(!keep.log.some((l) => l[0] === "removeBackup" || (l[0] === "deleteSandbox")));
  assert.match(keep.out.join("\n"), /sandbox kept/);

  const purge = mkTeardown();
  assert.equal(await runTeardown(["--purge"], purge.d), 0);
  const dels = purge.log.filter((l) => l[0] === "deleteSandbox");
  assert.deepEqual(dels.map((l) => l[1]), [["backup"], []], "purge: first pass keeps only the kit, second (after the tripwire) removes everything");
  const purgeTripped = mkTeardown({ tripwireFails: true });
  await runTeardown(["--purge"], purgeTripped.d);
  assert.equal(purgeTripped.log.filter((l) => l[0] === "deleteSandbox").length, 1, "a tripped purge never deletes the kit");
  assert.ok(PRESERVE.includes("run"), "the persisted baseline directory is preserved by a normal teardown");
});

test("teardown31 (code H2): the kit is kept, the precise reason printed and the exit 1 unless PATH clean AND no found daemon unstopped AND every delete pass returned true AND the tripwire passed", async () => {
  const notDeleted = (t) => assert.ok(!t.out.join("\n").includes("sandbox deleted") && !t.log.some((l) => l[0] === "removeBackup"), "never claims a deletion it did not do");
  // a daemon FOUND by command line that stop reports as skipped / a stop error
  const skipped = mkTeardown({ over: { stop: () => ({ skipped: "not-ours: skipped", why: "moved" }) } });
  assert.equal(await runTeardown([], skipped.d), 1);
  assert.match(skipped.err.join("\n"), /RESTORE KIT KEPT.*sandbox daemon could not be stopped/s);
  notDeleted(skipped);
  const stopErr = mkTeardown({ over: { stop: () => { throw new Error("taskkill denied"); } } });
  assert.equal(await runTeardown([], stopErr.d), 1);
  assert.match(stopErr.err.join("\n"), /sandbox daemon could not be stopped/);
  notDeleted(stopErr);
  // first delete pass returns false
  const delFail = mkTeardown({ deleteResults: [false] });
  assert.equal(await runTeardown([], delFail.d), 1);
  assert.match(delFail.err.join("\n"), /sandbox files could not be fully deleted/);
  notDeleted(delFail);
  // --purge: the second pass (previously ignored) fails
  const purgeFail = mkTeardown({ deleteResults: [true, false] });
  assert.equal(await runTeardown(["--purge"], purgeFail.d), 1);
  assert.match(purgeFail.err.join("\n"), /RESTORE KIT KEPT.*purge pass could not delete everything/s);
  assert.ok(!purgeFail.out.join("\n").includes("sandbox deleted"));
  // removing the kit itself fails
  const kitFail = mkTeardown({ over: { removeBackup: () => { throw new Error("EPERM"); } } });
  assert.equal(await runTeardown([], kitFail.d), 1);
  assert.match(kitFail.err.join("\n"), /removing the restore kit failed: EPERM/);
  // every reason is named at once, and the way out is printed
  const many = mkTeardown({ tripwireFails: true, restoreResult: { restored: false, reason: "unreadable" }, deleteResults: [false] });
  assert.equal(await runTeardown([], many.d), 1);
  assert.match(many.err.join("\n"), /tripwire fired; the HKCU PATH could not be confirmed clean; the sandbox files could not be fully deleted/);
  assert.match(many.err.join("\n"), /teardown31\.mjs --discard-kit/);
  // a bare service.json pid that is not ours (recycled) is only a stale pointer: still a clean teardown
  const stale = mkTeardown({ svc: { pid: 602, startedAt: new Date(NOW).toISOString() }, table: [{ ProcessId: 602, Name: "svchost.exe", CommandLine: "svchost.exe -k x", StartMs: NOW }] });
  assert.equal(await runTeardown([], stale.d), 0);
  // the success message appears only when both the sandbox and the kit really went
  const ok = mkTeardown();
  assert.equal(await runTeardown([], ok.d), 0);
  assert.match(ok.out.join("\n"), /sandbox deleted; restore kit deleted/);
});

test("teardown31 (code L3): an unreadable process table degrades to the service.json pid and still restores PATH; with no pid at all the kit is kept", async () => {
  const boom = () => { throw new Error("Get-CimInstance failed"); };
  const withPid = mkTeardown({ over: { readTable: boom } });
  assert.equal(await runTeardown([], withPid.d), 0, withPid.err.join("\n"));
  assert.match(withPid.err.join("\n"), /could not read the process table \(Get-CimInstance failed\)/);
  assert.ok(withPid.log.includes("restore"), "PATH restore still ran");
  assert.deepEqual(withPid.killed, [601], "the recorded pid was still stopped after its identity check");
  const noPid = mkTeardown({ svc: null, over: { readTable: boom } });
  assert.equal(await runTeardown([], noPid.d), 1);
  assert.ok(noPid.log.includes("restore"), "PATH restore still ran before the kit decision");
  assert.match(noPid.err.join("\n"), /process table was unreadable and service\.json named no pid/);
  assert.ok(!noPid.log.some((l) => l[0] === "removeBackup"));
  // start time unknown is stated, not silent
  const noStart = mkTeardown({ svc: { pid: 601 } });
  await runTeardown([], noStart.d);
  assert.match(noStart.out.join("\n"), /startedAt missing or unparseable: the process start time is NOT checked/);
});

test("teardown31 --discard-kit (code M1): deletes ONLY the kit, and only with a PATH free of sandbox segments and no sandbox daemon alive", async () => {
  const ok = mkTeardown();
  ok.d.readTable = () => [{ ProcessId: 4, Name: "svchost.exe", CommandLine: "svchost.exe -k x", StartMs: NOW }];
  assert.equal(await runTeardown(["--discard-kit"], ok.d), 0, ok.err.join("\n"));
  assert.deepEqual(ok.log, [["removeBackup", BACKUP]], "only the kit removal: no stop, restore, sandbox delete or tripwire");
  assert.deepEqual(ok.killed, []);
  assert.match(ok.out.join("\n"), /restore kit deleted/);

  const refuse = async (over, re, name) => {
    const t = mkTeardown({ over });
    assert.equal(await runTeardown(["--discard-kit"], t.d), 1, name);
    assert.match(t.err.join("\n"), re, name);
    assert.ok(!t.log.some((l) => l[0] === "removeBackup"), `${name}: kit kept`);
    assert.deepEqual(t.killed, [], name);
  };
  await refuse({ readTable: () => [], readUserPath: () => ({ type: "REG_SZ", value: `C:\\a;${TRIAL_ROOT}\\roaming\\claude-code-router\\bin` }) }, /refusing --discard-kit.*sandbox segment/, "PATH still spliced");
  await refuse({ readTable: () => [], readUserPath: () => undefined }, /refusing --discard-kit.*could not read HKCU user PATH/, "PATH unreadable");
  await refuse({ readTable: () => [daemonRow(601, NOW - 86_400_000)] }, /sandbox daemon\(s\) still alive \(pid 601\)/, "daemon alive (identity only, no age gate)");
  await refuse({ readTable: () => { throw new Error("cim failed"); } }, /cannot read the process table.*cim failed/, "table unreadable");
  const rmFail = mkTeardown({ over: { readTable: () => [], removeBackup: () => { throw new Error("EPERM"); } } });
  assert.equal(await runTeardown(["--discard-kit"], rmFail.d), 1);
  assert.match(rmFail.err.join("\n"), /--discard-kit failed: EPERM/);
});

// ---------------------------------------------------------------- verify-isolation31
test("check 3 (code LOW): marker count AND sha256 must match; an unreadable file is RED, never 'equal by -1'", () => {
  const a = { count: 2, hash: "h1" };
  assert.equal(checkSettings(a, { count: 2, hash: "h1" }).ok, true);
  assert.equal(checkSettings(a, { count: 3, hash: "h1" }).ok, false);
  assert.equal(checkSettings(a, { count: 2, hash: "h2" }).ok, false, "same count, different content");
  const unreadable = { count: -1, hash: "(unreadable)" };
  assert.equal(checkSettings(unreadable, unreadable).ok, false, "the -1 sentinel on both sides is NOT equal");
  assert.equal(checkSettings(a, unreadable).ok, false);
  assert.equal(checkSettings(unreadable, a).ok, false);
  assert.match(checkSettings(unreadable, unreadable).detail, /UNREADABLE/);
  const fsx = { readFileSync: (f) => { if (f === "missing") throw new Error("ENOENT"); return Buffer.from("x\nANTHROPIC_BASE_URL=1\n{\"apiKeyHelper\":1}\n"); } };
  assert.deepEqual(settingsState("missing", fsx), unreadable);
  assert.equal(settingsMarkerCount("missing", fsx), -1);
  const ok = settingsState("real", fsx);
  assert.equal(ok.count, 2);
  assert.match(ok.hash, /^[0-9a-f]{64}$/);
});

test("check 8 (sec M1/code M1): only guard-loaded lines written at/after launch count, and EVERY node pid of the tree must appear; torn lines are tolerated", () => {
  const launch = Date.parse("2026-09-30T12:00:00.000Z");
  const line = (pid, off, thread = "main") => JSON.stringify({ ts: new Date(launch + off).toISOString(), pid, thread, kind: "loaded" });
  const base = { violationsText: "", launchMs: launch, nodePids: [10, 11], mainPid: 10 };
  const good = checkGuardLoaded({ ...base, loadedText: [line(10, 50), line(11, 90), line(10, 60, 1)].join("\n") });
  assert.equal(good.ok, true, good.detail);
  assert.match(good.detail, /workerThreadLines=1/);
  const stale = checkGuardLoaded({ ...base, loadedText: [line(10, -60_000), line(11, -60_000)].join("\n") });
  assert.equal(stale.ok, false, "stale lines from an earlier run cannot satisfy the check");
  assert.match(stale.detail, /staleLines=2/);
  const missingChild = checkGuardLoaded({ ...base, loadedText: line(10, 50) });
  assert.equal(missingChild.ok, false);
  assert.match(missingChild.detail, /missing=11/);
  assert.equal(checkGuardLoaded({ ...base, loadedText: [line(10, 50, 2), line(11, 60, 2)].join("\n") }).ok, false, "worker-thread lines alone do not prove the main threads loaded");
  assert.equal(checkGuardLoaded({ ...base, violationsText: "{\"kind\":\"violation\"}\n", loadedText: [line(10, 50), line(11, 60)].join("\n") }).ok, false);
  const torn = checkGuardLoaded({ ...base, loadedText: [line(10, 50), "{\"ts\":\"2026-09-3", line(11, 60), "garbage"].join("\n") });
  assert.equal(torn.ok, true, "a torn line neither aborts nor fails the check");
  assert.match(torn.detail, /tornLines=2/);
  assert.deepEqual(parseLoadedLog("").entries, []);
});

test("check 8 stale-log rotation: rotateLogs empties the live log names so a new run starts from nothing", () => {
  const files = new Map([[VIOLATIONS_LOG, "old violation"], [GUARD_LOADED_LOG, "old loaded"]]);
  const fsx = { existsSync: (f) => files.has(f), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); } };
  const moved = rotateLogs([VIOLATIONS_LOG, GUARD_LOADED_LOG], "T", fsx);
  assert.equal(moved.length, 2);
  assert.equal(files.has(VIOLATIONS_LOG) || files.has(GUARD_LOADED_LOG), false);
  assert.equal(files.get(`${GUARD_LOADED_LOG}.prev-T`), "old loaded", "evidence is kept, not lost");
});

function verifyCtx(ioOver = {}, ctxOver = {}) {
  const launchedAtMs = Date.parse("2026-09-30T12:00:00.000Z");
  const ok = (pid) => JSON.stringify({ ts: new Date(launchedAtMs + 100).toISOString(), pid, thread: "main", kind: "loaded" });
  const io = {
    readServiceJson: () => ({ pid: 500, url: `http://127.0.0.1:39468/?ccr_web_token=${TOKENS.web}`, serviceToken: TOKENS.service }),
    procRows: () => [{ ProcessId: 500, ParentProcessId: 1, Name: "node.exe" }, { ProcessId: 501, ParentProcessId: 500, Name: "node.exe" }, { ProcessId: 502, ParentProcessId: 500, Name: "conhost.exe" }],
    netRows: (pids, state) => (state === "Listen" ? [{ LocalAddress: "127.0.0.1", LocalPort: 39468, OwningProcess: 500 }] : []),
    rpc: async () => ({ configDir: path.join(ROAMING, "claude-code-router"), dataDir: path.join(ROAMING, "claude-code-router"), configDbFile: path.join(ROAMING, "x", "config.sqlite"), requestLogsDbFile: path.join(ROAMING, "r.sqlite"), usageDbFile: path.join(ROAMING, "u.sqlite"), version: "3.1.1", desktop: false }),
    readUserPath: () => SAVED, restore: () => ({ restored: false, reason: NO_SANDBOX_SEGMENT }),
    settingsState: () => ({ count: 2, hash: "h1" }),
    readText: (f) => (f === VIOLATIONS_LOG ? "" : [ok(500), ok(501)].join("\n")),
    walkNames: () => ["home\\x (1 B)"], sleep: async () => {},
    ...ioOver,
  };
  for (const k of Object.keys(io)) if (io[k] === undefined) delete io[k]; // `rpc: undefined` = use the real default
  const live = { 3456: 1, 3457: 2, 3458: 1, 4517: 3 };
  return { pid: 500, launchedAtMs, tokens: TOKENS, tripwire: { assert() {} }, savedPath: SAVED, settingsBefore: { count: 2, hash: "h1" }, livePortPidsBefore: live, listenerPid: (p) => live[p], io, ...ctxOver };
}
const byN = (r) => Object.fromEntries(r.checks.map((c) => [c.n, c]));

test("verifyIsolation: all-green baseline with fakes; check 6 is labelled a recorder, and check 5 requires desktop === false", async () => {
  const r = await verifyIsolation(verifyCtx());
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.deepEqual(r.checks.map((c) => c.n), [1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(byN(r)[6].recorder, true);
  assert.match(byN(r)[6].name, /recorder/i);
  assert.match(renderProof(r, { version: "3.1.1" }), /\| 6 \| .*recorder.* \| RECORD \|/);
  const desktop = await verifyIsolation(verifyCtx({ rpc: async () => ({ configDir: TRIAL_ROOT, dataDir: TRIAL_ROOT, configDbFile: TRIAL_ROOT, requestLogsDbFile: TRIAL_ROOT, usageDbFile: TRIAL_ROOT, desktop: true }) }));
  assert.equal(byN(desktop)[5].ok, false);
  assert.match(byN(desktop)[5].detail, /desktop=true/);
});

test("verifyIsolation (code LOW): check 1 asserts LocalAddress is loopback; a non-loopback bind or an out-of-range port is RED", async () => {
  const listen = (rows) => ({ netRows: (p, s) => (s === "Listen" ? rows : []) });
  const wild = await verifyIsolation(verifyCtx(listen([{ LocalAddress: "0.0.0.0", LocalPort: 39468 }])));
  assert.equal(byN(wild)[1].ok, false);
  assert.match(byN(wild)[1].detail, /nonLoopbackBind=0\.0\.0\.0/);
  const v6 = await verifyIsolation(verifyCtx(listen([{ LocalAddress: "::1", LocalPort: 39468 }])));
  assert.equal(byN(v6)[1].ok, true);
  assert.equal(byN(await verifyIsolation(verifyCtx(listen([{ LocalAddress: "127.0.0.1", LocalPort: 39468 }, { LocalAddress: "127.0.0.1", LocalPort: 3458 }]))))[1].ok, false);
  assert.equal(byN(await verifyIsolation(verifyCtx(listen([]))))[1].ok, false);
});

test("verifyIsolation (sec H3/code H1): a throwing check becomes a RED check and the other checks still run", async () => {
  const r = await verifyIsolation(verifyCtx({ netRows: () => { throw new Error("Get-NetTCPConnection failed"); }, readText: (f) => { if (f === GUARD_LOADED_LOG) throw new SyntaxError("torn"); return ""; } }));
  assert.equal(r.checks.length, 10, "all checks reported");
  assert.equal(byN(r)[1].ok, false);
  assert.match(byN(r)[1].detail, /check threw: Get-NetTCPConnection failed/);
  assert.equal(byN(r)[8].ok, false);
  assert.equal(byN(r)[4].ok, true, "an unrelated check is unaffected");
  const noSvc = await verifyIsolation(verifyCtx({ readServiceJson: () => { throw new SyntaxError("Unexpected end of JSON input"); } }));
  assert.equal(noSvc.checks.length, 10);
  assert.equal(byN(noSvc)[4].ok, false);
  assert.equal(byN(noSvc)[9].ok, true);
  const badUrl = await verifyIsolation(verifyCtx({ readServiceJson: () => ({ pid: 500, url: "not a url", serviceToken: TOKENS.service }) }));
  assert.equal(badUrl.checks.length, 10);
  assert.equal(byN(badUrl)[1].ok, false);
});

test("verifyIsolation: check 3 goes RED on a changed real settings.json (hash) and on unreadable; check 8 waits for a slow node child then fails if it never loads", async () => {
  assert.equal(byN(await verifyIsolation(verifyCtx({ settingsState: () => ({ count: 2, hash: "OTHER" }) })))[3].ok, false);
  assert.equal(byN(await verifyIsolation(verifyCtx({ settingsState: () => ({ count: -1, hash: "(unreadable)" }) }, { settingsBefore: { count: -1, hash: "(unreadable)" } })))[3].ok, false);
  let calls = 0;
  const launch = Date.parse("2026-09-30T12:00:00.000Z");
  const ok = (pid) => JSON.stringify({ ts: new Date(launch + 100).toISOString(), pid, thread: "main" });
  const slow = await verifyIsolation(verifyCtx({ readText: (f) => (f === VIOLATIONS_LOG ? "" : ++calls >= 3 ? [ok(500), ok(501)].join("\n") : ok(500)) }));
  assert.equal(byN(slow)[8].ok, true, "the child finished loading during the retry window");
  const never = await verifyIsolation(verifyCtx({ readText: (f) => (f === VIOLATIONS_LOG ? "" : ok(500)) }));
  assert.equal(byN(never)[8].ok, false);
  assert.match(byN(never)[8].detail, /missing=501/);
});

test("verifyIsolation (sec L8): the web auth header is never sent to a port outside the trial range or a live port", async () => {
  // default rpc, out-of-range but NON-live port: it must refuse before any fetch
  const r = await verifyIsolation(verifyCtx({ rpc: undefined, readServiceJson: () => ({ pid: 500, url: `http://127.0.0.1:39999/?ccr_web_token=${TOKENS.web}`, serviceToken: TOKENS.service }) }));
  assert.equal(byN(r)[5].ok, false);
  assert.match(byN(r)[5].detail, /refusing to send the web auth header to port 39999/);
  assert.ok(PORT_RANGE[1] < 39999 && !REAL_PORTS.includes(39999) && HOME);
});

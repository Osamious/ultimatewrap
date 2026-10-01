// FIRST START of the CCR 3.1.1 sandbox (gate G2). Requires the explicit flag
// --g2-approved so it cannot run by accident. Zero providers, `--no-gateway`
// (only the management web port binds), airgap preload on. Runs the isolation
// proof immediately and cleans up on ANY failure or exception.
//   node harness/trial31/start31.mjs --g2-approved [--dry]
//   --dry: read-only preflight + prints the spec and the "would ..." plan. It creates nothing,
//          copies nothing, spawns nothing, and applies no ACL (proved by test/trial31-flows.test.mjs).
//
// DEFERRED (announced, deliberately NOT implemented in this hardening round):
//   - a 30-second tripwire poller during the run, and extra real-dir hashes (profiles, certs,
//     other HKCU\Environment vars, the Run key): before G3
//   - one Get-NetTCPConnection call to replace the 34 sequential PowerShell spawns of the
//     trial-port preflight scan (slow, not unsafe)
//   - evaluating `node --permission` as an independent second mechanism ("mechanism B")
//   - ESM named-import coverage of the better-sqlite3 hook (only require()/default import is wrapped)
//   - the per-write realpath cost in the guard (correctness over speed for now)
//
// Everything is in runStart(argv, io) with injectable dependencies, and importing this
// module starts nothing: the tests drive it with fakes and temp dirs only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  TRIAL_ROOT, INSTALL_ROUTER_PKG, INSTALL_GATEWAY_PKG, SQLITE_BINDING, CCR_CONFIG_DIR, SERVICE_JSON, RUN_DIR, BACKUP, HKCU_PATH_BACKUP, SETTINGS_BACKUP,
  TRIPWIRE_BASELINE, VIOLATIONS_LOG, GUARD_LOADED_LOG, HOME, ROAMING, LOCAL, TMP, EXTENSIONS_DIR, BOT_STATE_DIR, REAL_GLOBAL_CCR, REAL_SETTINGS,
  PORT_RANGE, REAL_PORTS, CLI_JS, launchSpec, assertLaunchSpec, printableEnv, newRunTokens, versionGte,
} from "./config31.mjs";
import {
  makeTripwire31, backupUserPath, assertPathClean, autoClean, readProcessTable, readUserPathRaw, verifyRow, stopOwnedChild,
  applyOwnerOnlyAcl, copyVerified, rotateLogs, listenerPid, DAEMON_LOG_WARNING, tailRedacted,
} from "./tripwire31.mjs";
import { verifyIsolation, renderProof, settingsState, preLaunchCanary } from "./verify-isolation31.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class PreflightError extends Error {}
/** A failure AFTER setup began creating things (dirs, ACL, copies): the message says what exists. Nothing was launched. */
export class SetupError extends Error {}
const die = (m) => { throw new PreflightError(m); };

const defaults = () => ({
  fs, listenerPid, env: process.env, out: console.log, err: console.error,
  readTable: () => readProcessTable(), readUserPath: readUserPathRaw,
  assertPathClean, backupUserPath, applyAcl: applyOwnerOnlyAcl, copyVerified, rotateLogs, preLaunchCanary, settingsState,
  makeTripwire31, verifyIsolation, autoClean, stopOwnedChild, spawn,
  now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  proofFile: path.join(HERE, "isolation-proof-3.1.1.md"),
  tokens: undefined,
});

/** @returns {Promise<number>} the process exit code. */
export async function runStart(argv, io = {}) {
  const d = { ...defaults(), ...io };
  const args = new Set(argv);
  if (!args.has("--g2-approved")) {
    d.err("refusing: gate G2 (first start of the sandbox gateway) needs the user's explicit approval; pass --g2-approved");
    return 2;
  }
  try { return await startFlow(d, args.has("--dry")); } catch (e) {
    if (e instanceof PreflightError) { d.err(`PREFLIGHT FAILED: ${e.message}`); return 1; }
    if (e instanceof SetupError) { d.err(`SETUP FAILED: ${e.message}`); return 1; }
    throw e;
  }
}

async function startFlow(d, dry) {
  const F = d.fs;
  const ver = (f) => { try { return JSON.parse(F.readFileSync(f, "utf8")).version; } catch (e) { return die(`cannot read a version from ${f}: ${e.message}`); } };
  const lpid = (p) => { try { return d.listenerPid(p); } catch (e) { return die(`cannot check port ${p} (${e.message}); refusing to start blind`); } };

  // ---- preflight: READ-ONLY. Every assertion must pass before anything is created or launched ----
  const routerVersion = ver(INSTALL_ROUTER_PKG);
  if (routerVersion !== "3.1.1") die(`sandbox router is ${routerVersion}, expected 3.1.1`);
  const gwVersion = ver(INSTALL_GATEWAY_PKG);
  if (!versionGte(gwVersion, "1.0.21")) die(`ai-gateway ${gwVersion} < 1.0.21 (needed for the ccr-router plugin)`);
  if (F.existsSync(path.join(CCR_CONFIG_DIR, "config.sqlite"))) die("sandbox config.sqlite already exists: not a first start. Run teardown31.mjs first");
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) if (lpid(p)) die(`something already listens on trial port ${p}`);
  const livePortPidsBefore = Object.fromEntries(REAL_PORTS.map((p) => [p, lpid(p)]));
  d.out(`live ports before: ${JSON.stringify(livePortPidsBefore)} (recorded, never touched)`);
  // no daemon from the old 3.0.22 scratch tree: the recorded pid must be alive AND be that daemon (a recycled pid is ignored)
  const oldSvc = path.join(HERE, "..", "scratch", "appdata", "claude-code-router", "service.json");
  if (F.existsSync(oldSvc)) {
    let oldPid;
    try { oldPid = Number(JSON.parse(F.readFileSync(oldSvc, "utf8")).pid); } catch { d.out("old 3.0.22 service.json unreadable: skipping that check"); }
    if (Number.isInteger(oldPid) && oldPid > 0) {
      let table; try { table = d.readTable(); } catch (e) { die(`cannot read the process table to check for a 3.0.22 harness daemon (${e.message})`); }
      const row = table.find((r) => r.ProcessId === oldPid);
      if (row && verifyRow(row, { cliJs: path.join(REAL_GLOBAL_CCR, "dist", "main", "cli.js") }).ok) die(`a 3.0.22 harness daemon (pid ${oldPid}) is alive; stop it first`);
      if (row) d.out(`old 3.0.22 service.json pid ${oldPid} is alive but is not a ccr daemon (recycled pid): ignoring`);
    }
  }
  try { d.assertPathClean(d.readUserPath); } catch (e) { die(e.message); } // refuses if the CURRENT HKCU PATH already carries a sandbox segment
  if (F.existsSync(HKCU_PATH_BACKUP)) {
    die(`restore kit ${HKCU_PATH_BACKUP} already exists (an earlier run did not finish); it is never overwritten. Run ONE of:\n`
      + "  node harness/trial31/teardown31.mjs                  (default: stops any sandbox daemon, cleans PATH, deletes the sandbox state and, after a passing tripwire, the kit)\n"
      + "  node harness/trial31/teardown31.mjs --discard-kit    (ONLY when the daemon is provably gone and the HKCU PATH is clean: deletes just the kit)");
  }
  const realBinding = path.join(REAL_GLOBAL_CCR, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  const bindingMissing = !F.existsSync(SQLITE_BINDING);
  const sandboxSqlitePkg = path.join(path.dirname(SQLITE_BINDING), "..", "..", "package.json");
  if (bindingMissing || F.existsSync(realBinding)) {
    const rv = ver(path.join(REAL_GLOBAL_CCR, "node_modules", "better-sqlite3", "package.json"));
    const sv = ver(sandboxSqlitePkg);
    if (rv !== sv) die(`better-sqlite3 version mismatch: real ${rv} vs sandbox ${sv}; a rebuild (network) would be needed`);
  }
  const settingsBefore = d.settingsState();
  if (settingsBefore.count < 0) die("real settings.json is unreadable; refusing to start without a baseline (nothing was created)");
  const tokens = d.tokens ?? newRunTokens();
  const spec = assertLaunchSpec(launchSpec(d.env, tokens));
  d.out(`command: ${spec.command} ${spec.args.map((a) => (a === CLI_JS ? "<sandbox cli.js>" : a)).join(" ")}`);
  d.out(`env: ${JSON.stringify(printableEnv(spec.env), null, 1)}`);

  if (dry) {
    d.out("dry run (nothing created, copied, applied or started); a real run would:");
    d.out(`  would create the sandbox dirs under ${TRIAL_ROOT}`);
    d.out(`  would apply an owner-only ACL to ${TRIAL_ROOT} (grant the current SID, then remove inheritance, verify readback)`);
    d.out(`  would ${bindingMissing ? "copy" : "re-verify by sha256"} the better-sqlite3 binding (temp name, compare, rename)`);
    d.out("  would run the pre-launch guard canary with the exact launch env (refuse to launch if the preload is not honoured)");
    d.out("  would rotate violations.log and guard-loaded.log to *.prev-<ts>");
    d.out(`  would write the restore kit under ${BACKUP} (HKCU PATH, hash-verified settings.json copy) and the tripwire baseline to ${TRIPWIRE_BASELINE}`);
    d.out("  would spawn the sandbox daemon, run the isolation proof, and clean up on any failure");
    return 0;
  }

  // ---- create + verify the sandbox (nothing is launched yet) ----
  // A failure from here on is reported as SETUP FAILED and says what exists on disk; nothing has been launched yet.
  const created = [];
  const setupFail = (m) => { throw new SetupError(`${m}; nothing was launched. Created so far: ${created.length ? created.join("; ") : "nothing"}. Run teardown31.mjs to remove it.`); };
  const setup = (label, fn) => { try { return fn(); } catch (e) { return setupFail(`${label} failed (${e.message})`); } };
  created.push(`sandbox dirs under ${TRIAL_ROOT} (possibly partial)`);
  setup("creating the sandbox dirs", () => { for (const dir of [TRIAL_ROOT, HOME, ROAMING, LOCAL, TMP, RUN_DIR, EXTENSIONS_DIR, BOT_STATE_DIR, BACKUP]) F.mkdirSync(dir, { recursive: true }); });
  const acl = setup("applying the owner-only ACL", () => d.applyAcl(TRIAL_ROOT));
  created.push("owner-only ACL");
  d.out(`owner-only ACL applied and verified for ${acl.user}`);
  // The install ran with --ignore-scripts, so better-sqlite3 has no native binding. Reuse the real 3.0.22
  // install's prebuilt binding (same package version, same node ABI): a sha256-verified atomic copy, no script, no network.
  if (F.existsSync(realBinding)) d.out(`better-sqlite3 binding: ${setup("copying the better-sqlite3 binding", () => d.copyVerified(realBinding, SQLITE_BINDING))} (source read-only)`);
  else if (bindingMissing) setupFail("no better-sqlite3 binding in the sandbox and no prebuilt source to copy");
  created.push("better-sqlite3 binding");
  const canary = setup("the pre-launch guard canary", () => d.preLaunchCanary(spec));
  if (!canary.ok) setupFail(`pre-launch guard canary FAILED (${canary.detail}); refusing to launch`);
  d.out(`pre-launch guard canary: ${canary.detail}`);
  const rotated = setup("rotating the evidence logs", () => d.rotateLogs([VIOLATIONS_LOG, GUARD_LOADED_LOG]));
  if (rotated.length) d.out(`rotated stale evidence logs: ${rotated.length}`);

  // ---- from here on ANY exception triggers auto-clean ----
  let savedPath, launchedAtMs, child, outFd, errFd;
  let failure;
  try {
    savedPath = d.backupUserPath(d.readUserPath); // never overwrites; the kit lives in backup\ until a passing teardown
    d.copyVerified(REAL_SETTINGS, SETTINGS_BACKUP);
    const copied = d.settingsState(SETTINGS_BACKUP);
    if (copied.hash !== settingsBefore.hash) throw new Error("real settings.json changed while it was being backed up; try again");
    const tripwire = d.makeTripwire31();
    tripwire.save(TRIPWIRE_BASELINE);
    d.out("Announcement: starting the SANDBOX CCR 3.1.1 web server only. The live gateway is not touched or restarted.");
    d.out(DAEMON_LOG_WARNING);

    outFd = F.openSync(spec.stdoutFile, "a");
    errFd = F.openSync(spec.stderrFile, "a");
    launchedAtMs = d.now();
    let spawnError;
    child = d.spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", outFd, errFd], windowsHide: true });
    child.on("error", (e) => { spawnError = e; });
    child.on("exit", (code) => d.out(`sandbox daemon exited (${code})`));
    if (!child.pid) throw new Error("the daemon did not spawn");
    const readSvc = () => { try { return JSON.parse(F.readFileSync(SERVICE_JSON, "utf8")); } catch { return undefined; } }; // tolerant: a torn read retries
    const deadline = d.now() + 30_000;
    while (d.now() < deadline) {
      const s = readSvc();
      if (s && s.pid === child.pid) break;
      if (child.exitCode !== null || spawnError) break;
      await d.sleep(250);
    }
    const svcNow = readSvc();
    if (child.exitCode !== null || spawnError || !svcNow || svcNow.pid !== child.pid) throw new Error("daemon did not come up; see run\\daemon.err.log and violations.log");

    const result = await d.verifyIsolation({
      pid: child.pid, launchedAtMs, tokens: spec.tokens, tripwire, savedPath, settingsBefore, livePortPidsBefore, listenerPid: d.listenerPid,
    });
    F.writeFileSync(d.proofFile, renderProof(result, { version: routerVersion }));
    for (const c of result.checks) d.out(`${c.recorder ? "RECORD" : c.ok ? "GREEN " : "RED   "} ${c.n} ${c.name} :: ${c.detail}`);
    if (!result.ok) throw new Error("ISOLATION PROOF FAILED");
  } catch (e) {
    failure = e;
  } finally {
    for (const fd of [outFd, errFd]) if (fd !== undefined) { try { F.closeSync(fd); } catch { /* already closed */ } }
  }

  if (failure) {
    d.err(`${failure.message}: auto-cleaning (stop the daemon we own, remove sandbox PATH segments, delete sandbox state; the restore kit is kept)`);
    let daemon;
    try { daemon = d.stopOwnedChild(child, { launchedAtMs }); } catch (x) {
      daemon = { error: String(x.message) };
      // the identity path itself failed: the handle we own is the only PID-reuse-safe way left to stop the daemon
      try { if (child && child.exitCode === null && child.signalCode === null) { child.kill(); daemon.killedHandleOnly = true; } } catch (y) { daemon.killError = String(y.message); }
    }
    const actions = await d.autoClean({ savedPath, pids: [], startedAtMs: launchedAtMs });
    d.err(`auto-clean: ${JSON.stringify([["daemon", daemon], ...actions])}`);
    d.err(DAEMON_LOG_WARNING);
    for (const [label, file] of [["daemon.out.log", spec.stdoutFile], ["daemon.err.log", spec.stderrFile]]) {
      const tail = tailRedacted(file, 5, F);
      if (tail) d.err(`${label} (last lines, secrets redacted):\n${tail}`);
    }
    d.err(`RESTORE KIT KEPT in ${BACKUP}: hkcu-path.json and settings.json.pre-trial31 (a copy of your real settings.json, owner-only ACL). `
      + "Compare it with the live file before blaming CCR for a change. teardown31.mjs deletes the kit only after a passing teardown (or with --purge).");
    return 1;
  }
  child.unref();
  d.out(`ALL GREEN. proof written to ${d.proofFile}. Daemon pid ${child.pid} left running; stop with teardown31.mjs`);
  d.out(`The restore kit stays in ${BACKUP} until a passing teardown (it holds a copy of settings.json under the owner-only ACL).`);
  d.out(DAEMON_LOG_WARNING);
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) process.exit(await runStart(process.argv.slice(2)));

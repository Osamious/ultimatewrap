// Teardown of the CCR 3.1.1 sandbox. Stops the sandbox daemon tree ONLY after proving
// each pid is ours (process Name node.exe, argv[1] is the sandbox cli.js, a whole
// `--daemon-child` argument, created no earlier than service.json's startedAt minus a
// margin; otherwise "not-ours: skipped"), removes only sandbox segments from the current
// HKCU user PATH, deletes the sandbox tree, and asserts the live tripwire against the
// baseline persisted at start (not a fresh "now"). The restore kit (backup\) is deleted
// ONLY when ALL of these hold: the tripwire passed, the PATH is confirmed clean, no found
// daemon was left unstopped, and the sandbox files (also the --purge pass) were deleted.
// Otherwise it is kept, the precise reason is printed and the exit code is 1. Never touches
// the real global CCR or the live gateway.
//   node harness/trial31/teardown31.mjs [--keep|--purge|--discard-kit]
//   (--keep: leave everything; default: delete state, keep install + evidence logs; --purge: delete all;
//    --discard-kit: delete ONLY the restore kit, and only when the HKCU PATH is clean and no sandbox daemon is alive)
// Importing this module starts nothing; the tests drive runTeardown() with fakes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVICE_JSON, BACKUP, TRIAL_ROOT, REAL_PORTS, TRIPWIRE_BASELINE, CLI_JS } from "./config31.mjs";
import {
  makeTripwire31, loadBaseline, autoClean, deleteSandbox, removeBackup, readProcessTable, readUserPathRaw, assertPathClean, findSandboxDaemons, PRESERVE,
  listenerPid, DAEMON_LOG_WARNING,
} from "./tripwire31.mjs";

const defaults = () => ({
  fs, listenerPid, makeTripwire31, loadBaseline, autoClean, deleteSandbox, removeBackup, assertPathClean, readUserPath: readUserPathRaw,
  readTable: () => readProcessTable(), out: console.log, err: console.error,
});

const KIT_HINT = "if the HKCU PATH is clean and no sandbox daemon is alive, 'teardown31.mjs --discard-kit' deletes only the restore kit";

/** --discard-kit: deletes ONLY the restore kit (backup\), and only when nothing can still need it. */
async function discardKit(d) {
  try { d.assertPathClean(d.readUserPath); } catch (e) { d.err(`refusing --discard-kit: ${e.message}`); return 1; }
  let rows;
  try { rows = d.readTable(); } catch (e) { d.err(`refusing --discard-kit: cannot read the process table to prove no sandbox daemon is alive (${e.message})`); return 1; }
  const alive = findSandboxDaemons(rows); // no start-time gate: any process with the sandbox identity counts as alive
  if (alive.length) { d.err(`refusing --discard-kit: sandbox daemon(s) still alive (pid ${alive.join(", ")}); run teardown31.mjs first`); return 1; }
  try { d.removeBackup(BACKUP); } catch (e) { d.err(`--discard-kit failed: ${e.message}`); return 1; }
  d.out("restore kit deleted (HKCU PATH confirmed free of sandbox segments, no sandbox daemon alive); nothing else was touched");
  return 0;
}

/** @returns {Promise<number>} the process exit code. */
export async function runTeardown(argv, io = {}) {
  const d = { ...defaults(), ...io };
  if (argv.includes("--discard-kit")) return discardKit(d);
  const keep = argv.includes("--keep");
  const purge = argv.includes("--purge"); // also delete the install, cache and evidence logs

  d.out(DAEMON_LOG_WARNING); // run\ (with daemon.out.log) is preserved by default and by every failed run
  const baseline = d.loadBaseline(TRIPWIRE_BASELINE);
  if (!baseline) d.err("WARNING: no persisted tripwire baseline (run\\tripwire-baseline.json); using a fresh one taken now, which cannot see changes made during the trial");
  const tripwire = d.makeTripwire31({ baseline });

  let svcPid, startedAtMs;
  try {
    const svc = JSON.parse(d.fs.readFileSync(SERVICE_JSON, "utf8"));
    svcPid = Number(svc.pid);
    const t = Date.parse(svc.startedAt);
    if (Number.isFinite(t)) startedAtMs = t;
  } catch { d.out("no readable sandbox service.json; scanning the process table for sandbox daemons instead"); }
  if (startedAtMs === undefined) d.out("service.json startedAt missing or unparseable: the process start time is NOT checked; identity rests on the tokenised command line alone");
  // service.json can be stale (a taskkill /F never runs CCR's SIGTERM handler): identity is decided by the
  // process table inside stopVerified, and any sandbox daemon found by command line is included as well.
  let found = [], tableError;
  try { found = findSandboxDaemons(d.readTable(), CLI_JS, { startedAtMs }); } catch (e) {
    tableError = e.message;
    d.err(`could not read the process table (${e.message}): stopping only the pid recorded in service.json; a daemon not recorded there was NOT searched for. The PATH restore still runs.`);
  }
  const pids = [...new Set([Number.isInteger(svcPid) && svcPid > 0 ? svcPid : undefined, ...found].filter(Boolean))];
  const livePids = new Set(REAL_PORTS.map((p) => d.listenerPid(p)).filter(Boolean));
  for (const pid of pids) if (livePids.has(pid)) throw new Error(`refusing: sandbox pid ${pid} is a LIVE listener`);

  // the kit is preserved by this pass; it is removed below only after every condition holds
  const actions = await d.autoClean({
    pids, startedAtMs, stop: d.stop, restore: d.restore, // undefined = autoClean's identity-verified stop / current-PATH restore
    deletor: async () => (keep ? "kept" : d.deleteSandbox(TRIAL_ROOT, { preserve: [...(purge ? [] : PRESERVE), "backup"] })),
  });
  d.out(`teardown: ${JSON.stringify(actions)}`);
  const pathOk = actions.find((a) => a[0] === "path-ok")?.[1] === true;
  // a daemon we FOUND (by command line) that could not be stopped, or any stop error, keeps the kit;
  // a bare service.json pid that is "not-ours" is only a stale pointer
  const daemonStuck = actions.some((a) => a[0] === "stop-error" || (a[0] === "skipped" && found.includes(a[1])));

  const reasons = [];
  try { tripwire.assert("teardown:end"); } catch (e) { reasons.push("the tripwire fired"); d.err(String(e.message)); }
  if (!pathOk) reasons.push("the HKCU PATH could not be confirmed clean");
  if (daemonStuck) reasons.push("a sandbox daemon could not be stopped");
  if (tableError && !pids.length) reasons.push("the process table was unreadable and service.json named no pid, so a live sandbox daemon cannot be ruled out");
  if (!keep && actions.find((a) => a[0] === "sandbox-deleted")?.[1] !== true) reasons.push("the sandbox files could not be fully deleted");

  if (keep) d.out(`sandbox kept at ${TRIAL_ROOT}`);
  else if (!reasons.length) {
    let ok = true;
    try {
      if (purge) ok = (await d.deleteSandbox(TRIAL_ROOT, { preserve: [] })) === true;
      else ok = d.removeBackup(BACKUP) === true;
    } catch (e) { ok = false; d.err(`removing the restore kit failed: ${e.message}`); }
    if (ok) d.out("sandbox deleted; restore kit deleted after a passing teardown; live state unchanged");
    else reasons.push(purge ? "the purge pass could not delete everything (the kit may be partly deleted)" : "the restore kit could not be removed");
  }
  if (reasons.length) {
    d.err(`RESTORE KIT KEPT in ${BACKUP} (${reasons.join("; ")}): hkcu-path.json and settings.json.pre-trial31 `
      + `(a copy of your real settings.json, owner-only ACL). Compare against it before blaming CCR; fix the cause and re-run teardown31.mjs; ${KIT_HINT}.`);
    return 1;
  }
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) process.exit(await runTeardown(process.argv.slice(2)));

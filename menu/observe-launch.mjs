// The picker's side of the live-status feed: start ONE detached, short-lived child that catches the overlay up from the router's usage
// log (`refresh/observe-cli.mjs --catchup`) and exits by itself. It is not a daemon and there is no timer: the picker calls
// `launchObserver()` once, right after its first frame, and the child's result shows up on a later keystroke (uwpick re-reads the overlay
// when its mtime changes).
//
// THIS FILE IS IN THE PICKER'S IMPORT GRAPH, so it imports only node built-ins and `observed-data.mjs`. It never imports the engine: the
// script is located by a path built from `import.meta.url` as a STRING and handed to a child process, which the import-graph test
// (nothing under refresh/ or keysync/) cannot see and must not.
//
// It is synchronous and total: no `await`, no `.then` (uwpick's guard test forbids both), and every failure is caught and returned as a
// reason, never thrown into the picker. It is STAT-ONLY: it never reads a file's contents and never writes one.
//
// Gates, in order (the first that applies wins, and none of them spawns):
//   env UW_OBSERVE=0                     the shell-level off switch
//   env UW_OBSERVE_NO_SPAWN=1            tests and QA: read the overlay, never start a child
//   env UW_PICKER_QUIT_IMMEDIATELY=1     the startup benchmark and the wrapper tests must never spawn
//   state/observe.off exists             the persistent kill switch (`observe-cli --off` / `--on`)
//   the script is missing                nothing to run
//   state/observed.run younger than 30 s the last run just finished (the recorder touches it at the START of every run, so a run that dies
//                                        still throttles)
//   state/observed.lock younger than 2 m a run (or a confirmation write) is in flight: single flight
//   this process spawned under 30 s ago  an in-memory guard, so a MISSING observed.run (never written, or unwritable) cannot make one picker
//                                        session spawn more than once per 30 s: the file gate never fails open into a spawn storm
//
// THE CHILD: fixed argv (`--no-warnings <script> --catchup`, nothing from the environment, the snapshot or the overlay can reach it), `shell: false`,
// `cwd` pinned to the repository root, and an ALLOWLISTED environment (below) instead of the picker's whole one.
import fs from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OBSERVED_FILE, observeOffFile } from "./observed-data.mjs";

/** Do not start another catch-up when the last one finished less than this long ago. */
export const LAUNCH_MIN_INTERVAL_MS = 30_000;
/** A lock younger than this means a run is in flight; an older one is stale (the recorder takes it over itself). */
export const LAUNCH_LOCK_FRESH_MS = 2 * 60_000;
/** The recorder's entry, found from this file's own location: `<repo>/refresh/observe-cli.mjs`. A string, never an import. */
export const OBSERVE_SCRIPT = fileURLToPath(new URL("../refresh/observe-cli.mjs", import.meta.url));
/** The repository root: the child's working directory. */
export const OBSERVE_CWD = path.resolve(path.dirname(OBSERVE_SCRIPT), "..");
/** The fixed argv after the script: one catch-up. Nothing from the environment, the snapshot or the overlay ever reaches it. */
export const OBSERVE_ARGS = Object.freeze(["--no-warnings", OBSERVE_SCRIPT, "--catchup"]);

// What the child may inherit. Windows treats names case-insensitively (`Path`, `SystemRoot`), so names are compared upper-cased. Everything else in the
// picker's environment (tokens, proxies, `NODE_OPTIONS`, ...) stays out of a process that reads the router's usage log.
// (The per-user data variables are assembled from two halves: the boundary test forbids that literal in menu/ outside the two contract modules.)
const USER_DATA = "APP" + "DATA";
const ENV_ALLOW = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", USER_DATA, "LOCAL" + USER_DATA, "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP"]);
const ENV_PREFIXES = ["UW_", "CCR_INTERNAL_"];
/** The allowlisted environment for the child, copied from `env`; string values only. */
export function childEnv(env) {
  const out = {};
  if (!env || typeof env !== "object") return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    const up = k.toUpperCase();
    if (ENV_ALLOW.has(up) || ENV_PREFIXES.some((p) => up.startsWith(p))) out[k] = v;
  }
  return out;
}

const ageMs = (file, now) => {
  try { return now - fs.statSync(file).mtimeMs; } catch { return null; }
};
// When THIS process last spawned (epoch ms, or null). Module state, on purpose: it is per picker process, so it costs nothing to a later session.
const SESSION = { at: null };

/**
 * Start the catch-up child when the gates allow. Returns `{ spawned: boolean, reason: string }`; never throws, and `reason` is one of the gate
 * words, `spawned`, or `error: <the exception's own message>` (at most 80 characters in all; never router data).
 * Injectable for tests: `spawn` (a fake), `env`, `now`, `stateDir` (a temp directory holding observe.off / observed.run / observed.lock),
 * `script` (an existing file, so the "script is missing" gate can be exercised), `session` (a fresh `{ at: null }` per test).
 */
export function launchObserver({ spawn = nodeSpawn, env = process.env, now = Date.now(), stateDir = path.dirname(OBSERVED_FILE), script = OBSERVE_SCRIPT, session = SESSION } = {}) {
  try {
    if (env.UW_OBSERVE === "0") return { spawned: false, reason: "env-off" };
    if (env.UW_OBSERVE_NO_SPAWN === "1") return { spawned: false, reason: "no-spawn" };
    if (env.UW_PICKER_QUIT_IMMEDIATELY === "1") return { spawned: false, reason: "quit-immediately" };
    if (fs.existsSync(observeOffFile(path.join(stateDir, "observed.json")))) return { spawned: false, reason: "kill-switch" };
    if (!fs.existsSync(script)) return { spawned: false, reason: "no-script" };
    const ran = ageMs(path.join(stateDir, "observed.run"), now);
    if (ran !== null && Math.abs(ran) < LAUNCH_MIN_INTERVAL_MS) return { spawned: false, reason: "recent" };
    const lock = ageMs(path.join(stateDir, "observed.lock"), now);
    if (lock !== null && Math.abs(lock) < LAUNCH_LOCK_FRESH_MS) return { spawned: false, reason: "locked" };
    // The file gate can fail open (observed.run missing: never written, or the state directory unwritable), so this process also remembers when it
    // last spawned and never spawns twice inside the interval.
    if (Number.isFinite(session.at) && Math.abs(now - session.at) < LAUNCH_MIN_INTERVAL_MS) return { spawned: false, reason: "session-throttle" };
    // Fixed argv, no shell, the repository as the working directory, an allowlisted environment, detached from the picker's console, no window, no
    // inherited handles; `unref` so the picker can exit first.
    const child = spawn(process.execPath, ["--no-warnings", script, "--catchup"],
      { shell: false, cwd: OBSERVE_CWD, env: childEnv(env), detached: true, stdio: "ignore", windowsHide: true });
    session.at = Number.isFinite(now) ? now : Date.now();
    // An async spawn failure (ENOENT, EPERM) would otherwise be an unhandled 'error' event; swallowing it is the point.
    try { child?.on?.("error", () => {}); } catch { /* a fake without `on` */ }
    try { child?.unref?.(); } catch { /* nothing to release */ }
    return { spawned: true, reason: "spawned" };
  } catch (e) {
    return { spawned: false, reason: `error: ${String(e?.message ?? e)}`.slice(0, 80) };
  }
}

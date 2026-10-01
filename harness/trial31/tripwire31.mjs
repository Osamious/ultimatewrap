// CCR 3.1.1 trial tripwire + lifecycle helpers. Composes its OWN base (it no longer uses harness/guard.mjs's
// makeTripwire, whose whole-tree Claude-3p content hash fired on the running Claude desktop app's own churn):
// real settings files, the Downloads listing, user PATH, the top-level listing of ~\.codex, real service.json and
// global-profile-takeover.json hashes, the real bin\ listing, the HKCU Internet Settings proxy values
// (system-proxy mode), the user Root cert store, and a NARROW Claude-3p collector (claude3pSyncCollectors).
// Auto-clean (user-approved for later stages): when a tripwire fires, stop the
// sandbox process tree (only after proving the pid is OURS), then remove ONLY
// sandbox segments from the current HKCU user PATH, then delete the sandbox. It
// never writes any other real state; anything else that changed is reported for a
// human. The restore kit (backup\) survives every failed run.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { IsolationError } from "../guard.mjs";
import {
  TRIAL_ROOT, BACKUP, CLI_JS, REAL_HOME, REAL_CCR_DIR, REAL_SETTINGS, REAL_SETTINGS_LOCAL, REAL_CODEX_TOML, HKCU_PATH_BACKUP,
  REAL_CLAUDE_3P, REAL_DOWNLOADS, CLAUDE_3P_ROOT_CONFIG, CLAUDE_3P_LIBRARY_DIR, CLAUDE_3P_META, CLAUDE_3P_LIBRARY_ID, systemTool,
} from "./config31.mjs";

const { redactSecrets, redactDaemonLog } = createRequire(import.meta.url)("./redact31.cjs");
export { redactSecrets, redactDaemonLog };

const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export const NO_SANDBOX_SEGMENT = "no sandbox segment in PATH";

function hashFile(f) {
  try { return sha(fs.readFileSync(f)); } catch (e) { return e && e.code === "ENOENT" ? "(absent)" : `(unreadable:${e && e.code})`; }
}
/** Listing-only fingerprint (names + sizes, recursive; + mtimes with {mtime:true}). Content is never read. */
function hashTree(dir, { mtime = false } = {}) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { const st = fs.statSync(p); h.update(path.relative(dir, p)).update(String(st.size)); if (mtime) h.update(String(st.mtimeMs)); } catch { /* locked/unreadable: skip rather than abort the check that protects the run */ }
    }
  };
  if (!fs.existsSync(dir)) return "(absent)";
  walk(dir);
  return h.digest("hex");
}
/** Top-level entry names only (never descends, never reads): the real ~/.codex tree is hundreds of MB. */
function hashTopListing(dir) {
  try {
    const names = fs.readdirSync(dir, { withFileTypes: true }).map((e) => `${e.isDirectory() ? "d" : "f"}:${e.name}`).sort();
    return sha(names.join("\n"));
  } catch { return "(absent)"; }
}

/**
 * Runs a Windows tool by its ABSOLUTE %SystemRoot%\System32 path (config31.systemTool), never by PATH lookup: under Git
 * Bash a bare `whoami` is Git's usr\bin\whoami. Every process this harness spawns goes through here (a test scans the
 * sources for a bare tool name). `deps` is injectable: {execFile, env}.
 */
export function runTool(name, args, opts = {}, deps = {}) {
  const exe = systemTool(name, deps.env ?? process.env);
  return (deps.execFile ?? execFileSync)(exe, args, { encoding: "utf8", windowsHide: true, ...opts });
}
const reg = (args) => runTool("reg", args);
/** Runs a PowerShell script text (read-only probes only) via the absolute powershell.exe. */
export const runPs = (cmd, deps) => String(runTool("powershell", ["-NoProfile", "-Command", cmd], {}, deps)).trim();

/** PID listening on a local TCP port, or undefined. Own copy of harness/guard.mjs's listenerPid, but with the absolute powershell path. */
export function listenerPid(port, ps = runPs) {
  const p = Number(port);
  if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(`invalid port ${port}`);
  const pid = Number(ps(`(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Parses `reg query <key> /v <name>` output. Exported for the unit test. */
export function parseRegValue(out, name) {
  const re = new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s+(.*?)\\s*$`, "im");
  const m = re.exec(out);
  return m ? { type: m[1], value: m[2] } : undefined;
}

/** Raw (unexpanded) HKCU user PATH with its registry type. */
export function readUserPathRaw() {
  try { return parseRegValue(reg(["query", "HKCU\\Environment", "/v", "Path"]), "Path"); } catch { return undefined; }
}

function internetSettingsFingerprint() {
  try {
    const out = reg(["query", INTERNET_SETTINGS]);
    const keep = out.split(/\r?\n/).filter((l) => /^\s*(ProxyEnable|ProxyServer|AutoConfigURL|ProxyOverride|AutoDetect)\s/i.test(l));
    return sha(keep.join("\n"));
  } catch { return "(unreadable)"; }
}
function rootCertFingerprint() {
  try { return sha(runTool("certutil", ["-user", "-store", "Root"])); }
  catch { return "(unreadable)"; }
}
function userPathFingerprint() {
  const cur = readUserPathRaw();
  return cur ? sha(`${cur.type}\n${cur.value}`) : "(unreadable)";
}

/**
 * The ONLY parts of the real %LOCALAPPDATA%\Claude-3p that 3.1.1 can write when its Claude-desktop sync runs.
 * Source: dist/main/cli.js. `Ec` (gateway start / saveConfig / applyClaudeAppGateway) calls `jl`, which for the default
 * dataDir (`kOe` = LOCALAPPDATA\Claude-3p; LOCALAPPDATA is the sandbox's in this trial, so it reaches the REAL one only
 * if the env/guard were bypassed) does, via `Ly(dataDir)`: mkdir configLibrary; rewrite
 * configLibrary\<CLAUDE_3P_LIBRARY_ID>.json (`MOe`); rewrite configLibrary\_meta.json (`DOe`); rewrite
 * claude_desktop_config.json (`NOe`). The restore branch `RQ` (Ec with no claude-code profile) edits the same two
 * files. So four fingerprints cover every file write: three file hashes and the configLibrary top-level listing (a new
 * or removed entry). `vQ` may also DELETE Cache/Code Cache/GPUCache/... dirs under Claude-3p after a refresh; those
 * are deliberately NOT watched (indistinguishable from the running Claude desktop app's own cache churn), and the
 * guard's write policy (Claude-3p is a protected root) is what stops them.
 * At ZERO providers `Ec` returns before writing (census), so this collector is sufficient for G2 and G3.
 * Deliberately excluded: everything else the desktop app itself rewrites continuously (logs\main.log, sentry\,
 * Network\Network Persistent State, Cache\, GPUCache\, DIPS, Preferences, ...): watching it cried wolf at G2 run 1.
 * A real change to a watched file by the live CCR (its own sync) or the desktop app is still reported; the trip
 * message says "or another tool changed it legitimately".
 */
export function claude3pSyncCollectors(root = REAL_CLAUDE_3P) {
  const lib = path.join(root, CLAUDE_3P_LIBRARY_DIR);
  return {
    "file:real-claude-3p-claude_desktop_config.json": () => hashFile(path.join(root, CLAUDE_3P_ROOT_CONFIG)),
    "file:real-claude-3p-configLibrary-_meta.json": () => hashFile(path.join(lib, CLAUDE_3P_META)),
    [`file:real-claude-3p-configLibrary-${CLAUDE_3P_LIBRARY_ID}.json`]: () => hashFile(path.join(lib, `${CLAUDE_3P_LIBRARY_ID}.json`)),
    "list:real-claude-3p-configLibrary-top": () => hashTopListing(lib),
  };
}

export const realCollectors = () => ({
  ...claude3pSyncCollectors(),
  // a key export lands in ~\Downloads as a NEW file (names + sizes + mtimes, recursive; content never read)
  "list:real-downloads": () => hashTree(REAL_DOWNLOADS, { mtime: true }),
  "file:real-settings.json": () => hashFile(REAL_SETTINGS),
  "file:real-settings.local.json": () => hashFile(REAL_SETTINGS_LOCAL),
  "file:real-codex-config.toml": () => hashFile(REAL_CODEX_TOML),
  "list:real-.codex-top": () => hashTopListing(path.join(REAL_HOME, ".codex")),
  "file:real-service.json": () => hashFile(path.join(REAL_CCR_DIR, "service.json")),
  "file:real-global-profile-takeover.json": () => hashFile(path.join(REAL_CCR_DIR, "global-profile-takeover.json")),
  "list:real-ccr-bin": () => hashTree(path.join(REAL_CCR_DIR, "bin")),
  "reg:hkcu-path": userPathFingerprint,
  "reg:internet-settings": internetSettingsFingerprint,
  "certs:user-root": rootCertFingerprint,
});

/**
 * @param {object} [opts] `collectors`: injected {name: () => fingerprint} (tests); `base`: optional extra tripwire ({assert}) run first (tests; none by default);
 * `baseline`: a persisted {name: fingerprint} object (teardown reloads the pre-trial baseline instead of taking a fresh one).
 * Returns {assert(stage), baseline, save(file)}. assert throws IsolationError naming the changed keys.
 */
export function makeTripwire31(opts = {}) {
  const base = opts.base;
  const collectors = opts.collectors ?? realCollectors();
  const given = opts.baseline ?? {};
  const baseline = new Map(Object.entries(collectors).map(([k, fn]) => [k, Object.hasOwn(given, k) ? given[k] : fn()]));
  return {
    baseline,
    /** Persists the baseline (fingerprints only, never contents). */
    save(file, fsx = fs) {
      fsx.mkdirSync(path.dirname(file), { recursive: true });
      fsx.writeFileSync(file, JSON.stringify({ version: 1, at: new Date().toISOString(), baseline: Object.fromEntries(baseline) }, null, 2) + "\n");
    },
    assert(stage) {
      if (base) base.assert(stage);
      const changed = [];
      for (const [k, fn] of Object.entries(collectors)) {
        const got = fn();
        if (got !== baseline.get(k)) changed.push(k);
      }
      if (changed.length) {
        throw new IsolationError(`ISOLATION VIOLATION: ${changed.join(", ")} CHANGED during "${stage}" - a write reached live state, or another tool changed it legitimately. `
          + "Compare mtimes and the pre-trial settings copy (backup\\settings.json.pre-trial31) before blaming CCR.");
      }
    },
  };
}

/** Reads a persisted tripwire baseline; undefined when absent or unreadable. */
export function loadBaseline(file, fsx = fs) {
  try {
    const j = JSON.parse(fsx.readFileSync(file, "utf8"));
    return j && typeof j.baseline === "object" && j.baseline ? j.baseline : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------- HKCU PATH

const normSeg = (s) => String(s).trim().replace(/^"+|"+$/g, "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
/** The 8.3 stem Windows would give the sandbox root's directory name: ".uw-scratch31" -> "uw-scr" (+ "~N"). */
const shortStem = (name) => name.replace(/^\.+/, "").replace(/[^a-z0-9_\-$%'@!#&(){}^`]/gi, "").slice(0, 6).toLowerCase();

/** Spellings of the sandbox root: as configured, its realpath, and (optionally) an injected 8.3 short path. */
export function sandboxAliases(root = TRIAL_ROOT, { realpath = fs.realpathSync.native, shortPath } = {}) {
  const out = [root];
  try { out.push(realpath(root)); } catch { /* root may not exist any more */ }
  if (shortPath) { try { out.push(shortPath(root)); } catch { /* ignore */ } }
  return [...new Set(out)];
}

/** True when a PATH segment is the sandbox root or lies under it (case, slashes, quotes, trailing \, 8.3 names). */
export function isSandboxSegment(seg, root = TRIAL_ROOT, aliases = [root]) {
  const s = normSeg(seg);
  if (!s) return false;
  for (const a of [root, ...aliases]) {
    const r = normSeg(a);
    if (s === r || s.startsWith(r + "\\")) return true;
  }
  const parent = normSeg(path.dirname(root));
  if (s.startsWith(parent + "\\")) {
    const comp = s.slice(parent.length + 1).split("\\")[0];
    if (comp.startsWith(shortStem(path.basename(root))) && /~\d+$/.test(comp)) return true;
  }
  return false;
}

/** Refuses to start when the current HKCU PATH already carries a sandbox segment (a previous run's splice was never undone). */
export function assertPathClean(read = readUserPathRaw, root = TRIAL_ROOT) {
  const cur = read();
  if (!cur) throw new Error("could not read HKCU user PATH; refusing to start without a restore point");
  if (cur.value.split(";").some((seg) => isSandboxSegment(seg, root, sandboxAliases(root)))) {
    throw new Error("the current HKCU user PATH already contains a sandbox segment; run teardown31.mjs (it removes only those segments) first");
  }
  return cur;
}

/**
 * Saves the raw user PATH before anything starts. NEVER overwrites an existing
 * backup: that file is the restore kit of an earlier run that may not be undone.
 */
export function backupUserPath(read = readUserPathRaw, { file = HKCU_PATH_BACKUP, fsx = fs } = {}) {
  if (fsx.existsSync(file)) throw new Error(`restore kit ${file} already exists (an earlier run did not finish); run teardown31.mjs first, refusing to overwrite it`);
  const saved = read();
  if (!saved) throw new Error("could not read HKCU user PATH; refusing to start without a restore point");
  fsx.mkdirSync(path.dirname(file), { recursive: true });
  fsx.writeFileSync(file, JSON.stringify(saved, null, 2) + "\n", { flag: "wx" });
  return saved;
}

/**
 * Removes ONLY sandbox segments from the CURRENT HKCU PATH (never rewrites an old
 * value, so a legitimate edit made meanwhile survives). `saved` is accepted for
 * call-compatibility and unused. `write` is injectable (tests).
 */
export function restoreUserPathIfSpliced(saved, { read = readUserPathRaw, write, root = TRIAL_ROOT, aliases } = {}) {
  const cur = read();
  if (!cur) return { restored: false, reason: "unreadable" };
  const al = aliases ?? sandboxAliases(root);
  const segs = cur.value.split(";");
  const kept = segs.filter((seg) => !isSandboxSegment(seg, root, al));
  if (kept.length === segs.length) return { restored: false, reason: NO_SANDBOX_SEGMENT };
  const value = kept.join(";");
  if (value.replace(/;/g, "").trim() === "") return { restored: false, reason: "removing the sandbox segments would empty PATH; not written" };
  const doWrite = write ?? ((s) => reg(["add", "HKCU\\Environment", "/v", "Path", "/t", s.type, "/d", s.value, "/f"]));
  doWrite({ type: cur.type, value });
  return { restored: true, removed: segs.length - kept.length };
}

// ---------------------------------------------------------------- process identity

/** Win32_Process rows {ProcessId, ParentProcessId, Name, CommandLine, StartMs}; `pid` filters to one. `ps` is injectable. */
export function readProcessTable(pid, ps = runPs) {
  const filter = pid ? ` -Filter 'ProcessId=${Number(pid)}'` : "";
  const out = ps(`Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='StartMs';e={ if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }} | ConvertTo-Json -Compress`);
  return out ? [].concat(JSON.parse(out)) : [];
}

const normPath = (s) => String(s ?? "").replace(/^"+|"+$/g, "").replace(/\//g, "\\").replace(/\\+/g, "\\").replace(/\\+$/, "").toLowerCase();

/** Quotes-aware split of a Windows command line: whitespace separates, double quotes group (and are dropped). No backslash escapes. */
export function tokenizeCommandLine(line) {
  const out = [];
  let cur = "", inQ = false, has = false;
  for (const ch of String(line ?? "")) {
    if (ch === '"') { inQ = !inQ; has = true; continue; }
    if (!inQ && /\s/.test(ch)) { if (has) { out.push(cur); cur = ""; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Is this process row OUR sandbox daemon: process Name node.exe; argv[1] is exactly the sandbox cli.js
 * (normalised: case, slashes, quotes); a WHOLE argument is exactly `--daemon-child` (not a prefix, not a
 * substring of a wrapper's single quoted argument); and, when a start time is known, it was created no
 * earlier than `startedAtMs - marginMs`. A recycled pid fails the command-line test.
 */
export function verifyRow(row, { startedAtMs, cliJs = CLI_JS, marginMs = 120_000 } = {}) {
  if (String(row.Name ?? "").toLowerCase() !== "node.exe") return { ok: false, reason: "process name is not node.exe" };
  const argv = tokenizeCommandLine(row.CommandLine);
  if (argv.length < 2 || normPath(argv[1]) !== normPath(cliJs)) return { ok: false, reason: "argv[1] is not the sandbox cli.js" };
  if (!argv.slice(2).includes("--daemon-child")) return { ok: false, reason: "command line lacks a whole --daemon-child argument" };
  if (startedAtMs !== undefined && startedAtMs !== null) {
    if (!(Number(row.StartMs) >= startedAtMs - marginMs)) return { ok: false, reason: "process is older than the service start time" };
  }
  return { ok: true };
}

/**
 * Pids in `rows` that look like sandbox daemons (used by teardown when service.json is missing or torn).
 * `startedAtMs` (service.json's startedAt, when parseable) also gates the process creation time; when it is
 * absent the caller must say the start time was not checked.
 */
export function findSandboxDaemons(rows, cliJs = CLI_JS, { startedAtMs, marginMs } = {}) {
  return rows.filter((r) => verifyRow(r, { cliJs, startedAtMs, marginMs }).ok).map((r) => r.ProcessId);
}

const killTree = (pid) => { runTool("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); };

/**
 * Stops `pid` and its children ONLY after verifying the pid is our sandbox daemon.
 * Never trust a bare pid from a file: it may be dead and recycled. Returns
 * {stopped} | {gone} | {skipped: "not-ours: skipped", why}.
 */
export function stopVerified(pid, { startedAtMs, table, kill = killTree, cliJs = CLI_JS, marginMs } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`refusing to stop pid ${pid}`);
  const row = (table ?? readProcessTable(pid)).find((r) => r.ProcessId === pid);
  if (!row) return { gone: true };
  const v = verifyRow(row, { startedAtMs, cliJs, marginMs });
  if (!v.ok) return { skipped: "not-ours: skipped", why: v.reason };
  kill(pid);
  return { stopped: true };
}

/**
 * Stops a child WE spawned. Never signals a pid whose child handle already exited
 * (the pid may be recycled). A live child is tree-stopped after the identity check;
 * if that check disagrees (skipped / gone) or throws (unreadable table, taskkill failure) while the
 * handle is still live, only the handle we own is killed: a handle kill cannot hit a recycled pid.
 */
export function stopOwnedChild(child, { launchedAtMs, table, kill } = {}) {
  const alive = () => child.exitCode === null && child.signalCode === null;
  if (!child || !alive()) return { alreadyExited: true };
  let r;
  try { r = stopVerified(child.pid, { startedAtMs: launchedAtMs, table, kill }); } catch (x) {
    child.kill();
    return { error: String(x.message), killedHandleOnly: true };
  }
  if ((r.skipped || r.gone) && alive()) { child.kill(); return { ...r, killedHandleOnly: true }; }
  return r;
}

// ---------------------------------------------------------------- sandbox deletion, auto-clean

// Kept by default: the 3.1.1 install (network-fetched once, no secrets) and the evidence logs.
export const PRESERVE = ["npm", "npm-cache", "empty.npmrc", "violations.log", "guard-loaded.log", "run"];
const normFs = (p) => String(p).replace(/^\\\\\?\\/, "").replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/**
 * Deletes the sandbox state (home, roaming, local, tmp, backup, ...). SQLite WAL retains rows, so
 * files are removed, not cleared. Entries in `preserve` (and rotated `*.prev-*` evidence logs) survive;
 * pass [] to purge everything. Refuses when the root's realpath differs from the root (a junction
 * pointing elsewhere) and skips any reparse point instead of deleting through it. Retries x3.
 */
export async function deleteSandbox(root = TRIAL_ROOT, {
  rm = fs.rmSync, preserve = PRESERVE, list = fs.readdirSync, exists = fs.existsSync,
  realpath = fs.realpathSync.native, lstat = fs.lstatSync,
} = {}) {
  if (!exists(root)) return true;
  let real;
  try { real = realpath(root); } catch { return false; }
  if (normFs(real) !== normFs(path.resolve(root))) {
    console.error(`deleteSandbox: refusing, realpath(${root}) is ${real}`);
    return false;
  }
  const hasReparse = (dir, depth = 0) => {
    if (depth > 12) return true; // pathologically deep: do not risk it
    let names; try { names = list(dir); } catch { return false; }
    for (const n of names) {
      let st; try { st = lstat(path.join(dir, n)); } catch { continue; }
      if (st.isSymbolicLink()) return true;
      if (st.isDirectory() && hasReparse(path.join(dir, n), depth + 1)) return true;
    }
    return false;
  };
  for (let i = 1; i <= 3; i++) {
    try {
      const keep = new Set(preserve.map((p) => p.toLowerCase()));
      const skipped = [];
      for (const name of list(root)) {
        if (keep.has(name.toLowerCase()) || (preserve.length > 0 && /\.prev-/.test(name))) continue;
        const p = path.join(root, name);
        let st; try { st = lstat(p); } catch { st = undefined; }
        if (st && (st.isSymbolicLink() || (st.isDirectory() && hasReparse(p)))) { skipped.push(name); continue; }
        rm(p, { recursive: true, force: true });
      }
      if (skipped.length) { console.error(`deleteSandbox: skipped reparse point(s), remove by hand: ${skipped.join(", ")}`); return false; }
      if (preserve.length === 0) rm(root, { recursive: true, force: true });
      return true;
    } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  return false;
}

/** Removes the restore kit directory (only under the sandbox root, never through a reparse point). */
export function removeBackup(dir = BACKUP, { rm = fs.rmSync, lstat = fs.lstatSync, exists = fs.existsSync } = {}) {
  if (!exists(dir)) return true;
  if (!normFs(dir).startsWith(normFs(TRIAL_ROOT) + "\\")) throw new Error(`refusing to remove ${dir}: outside the sandbox root`);
  if (lstat(dir).isSymbolicLink()) throw new Error(`refusing to remove ${dir}: reparse point`);
  rm(dir, { recursive: true, force: true });
  return true;
}

/** Moves stale evidence logs aside so a new run starts with empty ones. Returns the renamed files. */
export function rotateLogs(files, ts = new Date().toISOString().replace(/[:.]/g, "-"), fsx = fs) {
  const moved = [];
  for (const f of files) {
    if (!fsx.existsSync(f)) continue;
    const to = `${f}.prev-${ts}`;
    fsx.renameSync(f, to);
    moved.push(to);
  }
  return moved;
}

/** Printed by start31 and teardown31: run\daemon.out.log holds the web token URL. */
export const DAEMON_LOG_WARNING = "WARNING: run\\daemon.out.log contains the management-server URL with this run's web token "
  + "(dead once the daemon stops, a live credential while it runs). Never print, paste, share or commit that file; "
  + "any code that echoes its lines must go through redactDaemonLog()/tailRedacted().";

/** Last `n` lines of a daemon log with secrets masked (the ONLY sanctioned way to echo daemon.out.log). "" when unreadable. */
export function tailRedacted(file, n = 5, fsx = fs) {
  try {
    const lines = String(fsx.readFileSync(file, "utf8")).split(/\r?\n/).filter(Boolean).slice(-n);
    return redactDaemonLog(lines.join("\n")).slice(0, 2000);
  } catch { return ""; }
}

/** sha256-verified atomic copy: temp name, compare with the source, rename; an existing copy is re-verified by hash. */
export function copyVerified(src, dst, fsx = fs) {
  const want = sha(fsx.readFileSync(src));
  if (fsx.existsSync(dst) && sha(fsx.readFileSync(dst)) === want) return "already-verified";
  const tmp = `${dst}.tmp-${process.pid}`;
  fsx.mkdirSync(path.dirname(dst), { recursive: true });
  fsx.copyFileSync(src, tmp);
  if (sha(fsx.readFileSync(tmp)) !== want) { try { fsx.unlinkSync(tmp); } catch { /* best effort */ } throw new Error(`copy of ${src} does not match its sha256`); }
  fsx.renameSync(tmp, dst);
  if (sha(fsx.readFileSync(dst)) !== want) throw new Error(`${dst} does not match the source sha256 after rename`);
  return "copied";
}

/**
 * Owner-only ACL: GRANT the current user first (by SID, verified by readback), THEN remove
 * inheritance, so a failed grant can never leave the tree unreachable to us. `exec` is injectable.
 */
export function applyOwnerOnlyAcl(root, exec = (f, a) => runTool(f, a)) {
  const who = String(exec("whoami", ["/user", "/fo", "csv", "/nh"])).trim();
  const m = /^"([^"]+)","(S-\d-[\d-]+)"/.exec(who);
  if (!m) throw new Error("could not determine the current user SID from whoami");
  const [, name, sid] = m;
  exec("icacls", [root, "/grant:r", `*${sid}:(OI)(CI)F`]);
  exec("icacls", [root, "/inheritance:r"]);
  const out = String(exec("icacls", [root]));
  const aces = out.split(/\r?\n/).filter((l) => /:\(/.test(l));
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(`${esc}:\\(OI\\)\\(CI\\)\\(F\\)`, "i").test(out)) throw new Error(`ACL readback: ${name} does not hold full control`);
  if (/\(I\)/.test(out)) throw new Error("ACL readback: inherited entries remain");
  if (aces.length !== 1) throw new Error(`ACL readback: expected exactly one entry (owner only), found ${aces.length}`);
  return { user: name, sid };
}

/**
 * Approved auto-clean. Order matters: (1) stop the daemon FIRST (identity-verified) so nothing can
 * re-splice PATH behind the restore, (2) remove sandbox segments from the current PATH, (3) delete
 * the sandbox (the restore kit `backup\` is never deleted here). The last action is ["path-ok", bool]:
 * whether the PATH is known clean. Returns the action list.
 */
export async function autoClean({
  savedPath, pids = [], startedAtMs, stop = stopVerified, deletor = () => deleteSandbox(TRIAL_ROOT, { preserve: [...PRESERVE, "backup"] }), restore = restoreUserPathIfSpliced,
} = {}) {
  const actions = [];
  for (const pid of pids) {
    try {
      const r = await stop(pid, { startedAtMs });
      if (r && r.skipped) actions.push(["skipped", pid, r.skipped, r.why]);
      else if (r && r.gone) actions.push(["gone", pid]);
      else actions.push(["stopped", pid]);
    } catch (x) { actions.push(["stop-error", String(x.message)]); }
  }
  let pathOk = true;
  try {
    const r = restore(savedPath);
    actions.push(["path", r]);
    pathOk = r.restored === true || r.reason === NO_SANDBOX_SEGMENT;
  } catch (x) { pathOk = false; actions.push(["path-error", String(x.message)]); }
  actions.push(["sandbox-deleted", await deletor({ pathOk })]);
  actions.push(["path-ok", pathOk]);
  return actions;
}

/** Runs the tripwire; on failure runs autoClean and rethrows with the actions appended. */
export async function assertOrClean(tripwire, stage, ctx = {}) {
  try { tripwire.assert(stage); } catch (e) {
    e.message += ` | auto-clean: ${JSON.stringify(await autoClean(ctx))}`;
    throw e;
  }
}

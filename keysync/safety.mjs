// Pre-write safety: WAL-safe config snapshots, stale-credential cleanup,
// rollback, and retention. Split out of run.mjs so the write path reads as a
// sequence rather than a pile of file operations.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// One fixed location, deliberately NOT the keysync directory and NOT %TEMP%
// (which can be swept unpredictably).
export const BACKUP_DIR = path.join(process.env.LOCALAPPDATA, "uw-keysync", "backups");

// timeout: a wedged WMI/CIM service would otherwise hang keysync indefinitely
// on what is often just a warning string.
const ps = (cmd) => execFileSync("powershell", ["-NoProfile", "-Command", cmd],
  { encoding: "utf8", maxBuffer: 8 << 20, timeout: 30000 });

// Escape for a single-quoted PowerShell/SQL literal. %LOCALAPPDATA% contains the
// username, and an apostrophe is legal in a Windows username (O'Brien), which
// would otherwise break out of every quoted string here — including a SQL string
// passed to sqlite3, on the "refusing to write without a restore point" path.
const psQuote = (s) => String(s).replace(/'/g, "''");

/** Owner-only ACL. Windows `mode` bits are a no-op on NTFS, so set a real DACL. */
export function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    try {
      // $env:USERNAME: parses ambiguously (PowerShell reads the trailing colon
      // as part of the variable path), so the subexpression form is required.
      ps(`icacls '${psQuote(BACKUP_DIR)}' /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null`);
    } catch { /* the snapshot is DPAPI-encrypted regardless */ }
  }
  return BACKUP_DIR;
}

/**
 * WAL-safe snapshot of CCR's config database.
 *
 * A plain file copy while the gateway holds the DB open omits `-wal`/`-shm` and
 * restores to a silently stale state — which would quietly break the exact
 * rollback this exists to provide. `VACUUM INTO` produces a genuine snapshot.
 * The result holds every provider API key in plaintext, so it is DPAPI-encrypted
 * at rest (the live DB cannot be, since CCR must read it directly).
 */
export function snapshotConfigDb(dbPath, stamp) {
  ensureBackupDir();
  const plain = path.join(BACKUP_DIR, `config-${stamp}.sqlite`);
  const enc = `${plain}.dpapi`;
  try {
    // psQuote here is escaping a SQL string literal, not a shell one: the path
    // carries the username, and an apostrophe would otherwise terminate it.
    execFileSync("sqlite3", [dbPath, `VACUUM INTO '${psQuote(plain.replace(/\\/g, "/"))}'`],
      { encoding: "utf8", timeout: 120000 });
  } catch (e) {
    throw new Error(`config.sqlite snapshot failed (${String(e.message).slice(0, 120)}) — ` +
      `refusing to write without a restore point`);
  }
  try {
    ps(`Add-Type -AssemblyName System.Security; ` +
      `$b=[IO.File]::ReadAllBytes('${psQuote(plain)}'); ` +
      `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
      `[IO.File]::WriteAllBytes('${psQuote(enc)}',$p)`);
    fs.rmSync(plain, { force: true }); // never leave the plaintext copy behind
    return enc;
  } catch (e) {
    // An unencrypted restore point still beats none, but say so plainly.
    console.log(`  WARNING: DPAPI encryption failed (${String(e.message).slice(0, 80)}); ` +
      `snapshot left UNENCRYPTED at ${plain}`);
    return plain;
  }
}

export function restoreConfigDbHint(snapshot) {
  return snapshot.endsWith(".dpapi")
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Security; ` +
      `$b=[IO.File]::ReadAllBytes('${snapshot}'); ` +
      `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); ` +
      `[IO.File]::WriteAllBytes('${snapshot.replace(/\.dpapi$/, "")}',$p)"`
    : `copy "${snapshot}" over %APPDATA%\\claude-code-router\\config.sqlite (gateway stopped)`;
}

/**
 * CCR writes `ccr-claude-code-wif-token-<profile>.txt` on EVERY applyProfile, in
 * both auth modes, containing the same gateway key the apiKeyHelper .cmd echoes.
 * Its own cleanup targets the .cmd, not this file, and only in wif mode — so
 * nothing removes it. Deleting it drops the plaintext copies from two to one.
 *
 * Pinned to the exact profile filename: a glob would destroy other profiles'
 * tokens. Recurring by design — any CCR interaction recreates it.
 */
export function deleteStaleWifToken(configDir, profileId) {
  const file = path.join(configDir, "bin", `ccr-claude-code-wif-token-${profileId}.txt`);
  if (!fs.existsSync(file)) return null;
  fs.rmSync(file, { force: true });
  return file;
}

/**
 * Retention. The config snapshot carries every provider key, so it goes as soon
 * as the write is verified. The settings backup carries no provider keys (only
 * an apiKeyHelper path and env vars), and it is the user's rollback path, so the
 * most recent one is kept and older ones pruned.
 */
export function retainOnSuccess({ snapshot, settingsFile, keepSettings = 1 }) {
  const removed = [];
  if (snapshot && fs.existsSync(snapshot)) { fs.rmSync(snapshot, { force: true }); removed.push(snapshot); }

  const dir = path.dirname(settingsFile);
  const base = `${path.basename(settingsFile)}.uw-backup-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().reverse();
  for (const stale of backups.slice(keepSettings)) {
    fs.rmSync(path.join(dir, stale), { force: true });
    removed.push(path.join(dir, stale));
  }
  return removed;
}

/** Cap what survives a FAILED run, so a rotated-out key cannot linger forever. */
export function capFailedSnapshots(max = 2) {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith("config-"))
    .sort().reverse();
  const removed = [];
  for (const stale of files.slice(max)) {
    fs.rmSync(path.join(BACKUP_DIR, stale), { force: true });
    removed.push(stale);
  }
  return removed;
}

export function restoreSettings(backup, settingsFile) {
  if (!backup || !fs.existsSync(backup)) return false;
  // Restore via temp + rename for the same reason the forward write does: this
  // path runs precisely when something has already failed, and a crash midway
  // through a truncate-and-overwrite leaves a file worse than either version.
  const tmp = `${settingsFile}.uw-restore-${process.pid}`;
  try {
    fs.copyFileSync(backup, tmp);
    fs.renameSync(tmp, settingsFile);
    return true;
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    try { fs.copyFileSync(backup, settingsFile); return true; } catch { return false; }
  }
}

export const liveConfigDir = () => path.join(process.env.APPDATA, "claude-code-router");
export const liveConfigDb = () => path.join(liveConfigDir(), "config.sqlite");

// ---------------------------------------------------------------- Phase 4 --

const LOCK_FILE = path.join(BACKUP_DIR, "keysync.lock");

/**
 * Single-writer lock. Two concurrent keysync runs would be a lost-update race
 * on CCR's config plus a double gateway restart. Stale locks (owner process
 * gone) are reclaimed rather than blocking forever.
 */
export function acquireLock() {
  ensureBackupDir();
  const payload = JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), exec: process.execPath
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" is create-exclusive and ATOMIC. An existsSync-then-write pair is
      // not a mutex: two runs starting together both see no lock, both write,
      // and both proceed — precisely the double-write this exists to stop.
      const fd = fs.openSync(LOCK_FILE, "wx");
      try { fs.writeSync(fd, payload); } finally { fs.closeSync(fd); }
      return releaseIfOurs;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      let owner = null;
      try { owner = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")); } catch { /* partial/corrupt */ }

      // A corrupt or unparseable lock is NOT evidence of a dead owner — a
      // concurrent writer can be mid-write. Only a parsed, provably-dead owner
      // justifies reclaiming, and a lock with no timestamp is treated as live.
      if (owner?.pid && isProcessAlive(owner.pid)) {
        throw new Error(`another keysync run is in progress (pid ${owner.pid}, started ${owner.startedAt}). ` +
          `If that is wrong, delete ${LOCK_FILE}`);
      }
      if (!owner?.pid) {
        throw new Error(`a lock file exists but could not be read (possibly being written right now). ` +
          `Re-run; if it persists, delete ${LOCK_FILE}`);
      }
      // Owner is provably gone: reclaim and retry the exclusive create. If a
      // second reclaimer beats us, its "wx" wins and ours throws EEXIST again,
      // at which point we refuse rather than steal.
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  throw new Error(`could not acquire the keysync lock (contended); re-run`);
}

/** Only ever remove OUR lock — deleting a lock we do not own cascades failures. */
function releaseIfOurs() {
  try {
    const owner = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    if (owner?.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
  } catch { /* already gone, or not ours */ }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  // EPERM means the process EXISTS but cannot be opened (e.g. an elevated run
  // seen from a non-elevated one). Treating that as dead would steal a live
  // lock — the one PID-liveness mistake that fails in the unsafe direction.
  catch (e) { return e.code === "EPERM"; }
}

const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
};

// Only the provider fields keysync sets. MEASURED: CCR normalizes and enriches
// persisted providers with additional fields, so comparing a freshly built
// payload against the persisted config always differs and the skip never fires.
// Projecting both sides onto the owned subset is what makes the diff meaningful.
const OWNED_PROVIDER_KEYS = [
  "name", "provider", "type", "api_base_url", "api_key", "models",
  "autoFetchModels", "enabled", "protocolDetectionMode"
];
const OWNED_PROFILE_KEYS = [
  "id", "agent", "enabled", "scope", "surface", "settingsFile", "env",
  "model", "smallFastModel", "haikuModel", "sonnetModel", "opusModel", "fableModel"
];

const project = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

/**
 * Fingerprint of just what keysync owns, on both sides of a comparison. CCR
 * restarts the gateway on a CONTENT diff of Providers/agent/virtualModelProfiles
 * rather than on "a write happened", so an unchanged config can be re-applied
 * with no restart at all — which is what makes frequent refresh cheap.
 */
export function restartRelevantFingerprint(cfg) {
  // Mirrors CCR's ACTUAL restart predicate, read from the shipped dist rather
  // than assumed. CCR restarts on `configChanged || _E(prev, next)`, where _E
  // compares these and nothing else:
  //   scalars:          gateway.{enabled,host,port,coreHost,corePort},
  //                     observability.{requestLogs,agentAnalysis,
  //                       requestLogBodyCapture,requestLogMaxBodyBytes},
  //                     proxy.{enabled,host,mode,port,systemProxy}
  //   JSON.stringify:   proxy.targets, proxy.upstream, agent, mediaTools,
  //                     Providers, plugins, providerPlugins, toolHub,
  //                     virtualModelProfiles
  // Notably ABSENT: profile.*, Router.*. An earlier version of this function
  // had it backwards — it compared `profile.profiles` (never a trigger) and
  // omitted `observability`, which run.mjs itself flips, producing a
  // deterministic false "identical" exactly when a restart was coming.
  //
  // NO SORTING. CCR's compare is JSON.stringify, which is order-sensitive at
  // every level including each provider's nested `models` array, and CCR
  // performs no normalizing sort of its own. Canonicalizing here would hide
  // reorderings that genuinely restart the gateway.
  //
  // `enabled: true` is still normalized, because CCR omits values equal to
  // their default when persisting, so key *presence* differs across a
  // round-trip while meaning does not.
  const normalizeProvider = (p) => ({
    ...project(p, OWNED_PROVIDER_KEYS.filter((k) => k !== "enabled")),
    enabled: p.enabled !== false,
    models: [...(p.models ?? [])]
  });

  return JSON.stringify(stable({
    Providers: (cfg.Providers ?? []).map(normalizeProvider),
    agent: cfg.agent ?? {},                                   // TOP-LEVEL agent
    virtualModelProfiles: cfg.virtualModelProfiles ?? [],
    mediaTools: cfg.mediaTools ?? {},
    plugins: cfg.plugins ?? [],
    providerPlugins: cfg.providerPlugins ?? [],
    toolHub: cfg.toolHub ?? {},
    gateway: project(cfg.gateway ?? {}, ["enabled", "host", "port", "coreHost", "corePort"]),
    observability: project(cfg.observability ?? {},
      ["requestLogs", "agentAnalysis", "requestLogBodyCapture", "requestLogMaxBodyBytes"]),
    proxy: project(cfg.proxy ?? {},
      ["enabled", "host", "mode", "port", "systemProxy", "targets", "upstream"])
  }));
}

/** Waits for the gateway to actually accept connections after a restart. */
export async function waitForGateway(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 401 || res.status === 404) return true; // listening is what matters
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Other Claude Code sessions currently running. A gateway restart interrupts
 * their in-flight requests, and this is the failure class that produced the
 * 2026-09-01 outage, so it is surfaced rather than assumed harmless.
 */
export function otherClaudeSessions() {
  try {
    const out = ps(`(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | ` +
      `Select-Object -ExpandProperty ProcessId) -join ','`).trim();
    const pids = out ? out.split(",").map(Number).filter(Boolean) : [];
    // Exclude our OWN ancestors. A node pid can never equal a claude.exe pid, so
    // filtering on process.pid removed nothing — meaning when keysync is run
    // from inside a Claude Code session, that session was reported as an "other
    // session about to be interrupted". A warning that always fires, and always
    // includes you, is one people learn to ignore — and this is the warning
    // guarding the outage.
    // One call for the whole pid->parent map, walked in JS. The previous
    // version spawned one PowerShell per ancestor hop (up to 9, ~651ms each)
    // purely to compute a warning string.
    const ancestors = new Set();
    try {
      const tableJson = ps(`Get-CimInstance Win32_Process | ` +
        `Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress`);
      const table = new Map((JSON.parse(tableJson) || []).map((r) => [r.ProcessId, r.ParentProcessId]));
      let cur = process.ppid;
      for (let hops = 0; cur && hops < 12 && !ancestors.has(cur); hops++) {
        ancestors.add(cur);
        cur = table.get(cur) || 0;
      }
    } catch { /* a warning is not worth failing the run over */ }
    return pids.filter((p) => !ancestors.has(p));
  } catch { return []; }
}

/**
 * Write via temp + rename so a crash mid-write cannot truncate the real file.
 *
 * Two Windows caveats, both measured rather than assumed:
 * - The rename IS atomic on NTFS, but the renamed temp carries its OWN
 *   inherited DACL, silently discarding explicit non-inherited ACEs on the
 *   destination and WIDENING access. The destination's ACL is captured and
 *   reapplied.
 * - The rename can fail EPERM/EBUSY if another process holds the destination
 *   open without FILE_SHARE_DELETE, which settings.json plausibly is — hence
 *   the short retry.
 */
export function atomicWriteJson(file, obj) {
  const tmp = `${file}.uw-tmp-${process.pid}`;
  // The temp file is written NEXT TO the target, so a missing parent directory
  // fails the write rather than the rename -- and the caller sees ENOENT for a
  // path it just constructed. settings.json's directory always exists; a state
  // file under ~/.uw/state/ on a fresh machine does not, and assuming otherwise
  // is the kind of thing that only breaks for a first-time user.
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the write below reports it */ }
  let acl = null;
  if (fs.existsSync(file)) {
    try { acl = ps(`(Get-Acl -LiteralPath '${psQuote(file)}').Sddl`).trim(); } catch { /* best effort */ }
  }
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8" });
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { fs.renameSync(tmp, file); lastErr = null; break; }
      catch (e) {
        lastErr = e;
        // Spawning PowerShell to sleep cost ~428ms to deliver 120ms, and ran
        // even after the last attempt. Sleep in-process instead.
        if (attempt < 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      }
    }
    if (lastErr) throw lastErr;
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // never leave a stray copy of settings behind
    throw e;
  }
  if (acl) {
    try {
      ps(`$a = Get-Acl -LiteralPath '${psQuote(file)}'; $a.SetSecurityDescriptorSddlForm('${acl}'); ` +
        `Set-Acl -LiteralPath '${psQuote(file)}' -AclObject $a`);
    } catch { /* the write succeeded; ACL restoration is best effort */ }
  }
}

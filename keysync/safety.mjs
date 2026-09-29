// Pre-write safety: WAL-safe config snapshots, stale-credential cleanup,
// rollback, and retention. Split out of run.mjs so the write path reads as a
// sequence rather than a pile of file operations.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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

// Date.UTC ROLLS OVER out-of-range components (month 13 becomes next January)
// instead of failing, so a garbage stamp would otherwise parse to a plausible
// wrong date — and a stamp misdated into the future is exactly the file that
// would then be protected as "newest" while the real backup was pruned.
// Round-trip every component and reject anything that did not survive intact.
const utcExact = (y, mo, d, h, mi, s, ms = 0) => {
  const t = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
    && dt.getUTCHours() === h && dt.getUTCMinutes() === mi && dt.getUTCSeconds() === s
    && dt.getUTCMilliseconds() === ms ? t : null;
};

// The two stamp formats that coexist on disk. BOTH must stay parseable: the only
// settings backup on a live machine can be the legacy compact one, and a fix that
// stopped recognising it would orphan the user's sole rollback point — worse than
// the bug. run.mjs writes only the hyphenated form, so there is nothing to unify
// at the write site; this is a read-side compatibility shim for what already exists.
const STAMP_FORMATS = [
  // `new Date().toISOString().replace(/[:.]/g, "-")` — run.mjs:1269.
  [/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    (m) => utcExact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], +m[7])],
  // ISO basic form, no separators, second precision (e.g. 20260905T090726).
  // Read as UTC: it carries no zone, and consistency matters more than the
  // absolute value since it is only ever compared against other stamps.
  [/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/,
    (m) => utcExact(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6])]
];

/** Epoch ms for a backup stamp, or null if it is not a stamp we recognise. */
export function parseBackupStamp(stamp) {
  for (const [re, toMs] of STAMP_FORMATS) {
    const m = re.exec(String(stamp));
    if (m) return toMs(m);
  }
  return null;
}

/**
 * Every settings backup, ordered by PARSED timestamp — the single ordering used
 * by both retention and the phase 5 "a restore point exists" check. A lexical
 * sort is NOT chronological across the two stamp formats: at offset 4 it compares
 * "-" (0x2D) against a digit (0x30+), so every hyphenated stamp sorts below every
 * compact one regardless of date. `.sort().reverse()` therefore kept a Sep 5
 * backup and deleted the one the current run had just written.
 *
 * Stamps we cannot date are returned SEPARATELY, and are deliberately treated as
 * neither newest nor oldest: they are never pruned (deleting a file we cannot
 * date is the destructive direction of the error) and never offered as the newest
 * restore point (presenting a file we cannot date as current is the misleading
 * one). They only arise from hand-made copies, so they do not accumulate on their
 * own; the caller may surface the count.
 *
 * `capFailedSnapshots` shares this PARSER and deliberately inverts this POLICY —
 * a config snapshot full of provider keys is a file you want gone, not kept. Read
 * the comment there before unifying the two.
 */
export function listSettingsBackups(settingsFile) {
  const dir = path.dirname(settingsFile);
  const base = `${path.basename(settingsFile)}.uw-backup-`;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { dated: [], undatable: [] }; }

  const dated = [], undatable = [];
  for (const name of names) {
    if (!name.startsWith(base)) continue;
    const entry = { name, path: path.join(dir, name) };
    const at = parseBackupStamp(name.slice(base.length));
    if (at === null) undatable.push(entry);
    else dated.push({ ...entry, at });
  }
  dated.sort((a, b) => b.at - a.at); // newest first
  return { dated, undatable };
}

/**
 * Retention. The config snapshot carries every provider key, so it goes as soon
 * as the write is verified. The settings backup carries no provider keys (only
 * an apiKeyHelper path and env vars), and it is the user's rollback path, so the
 * most recent few are kept and older ones pruned.
 *
 * keepSettings is 5, not 1 (report 08 F4). With one backup, two bad runs destroy
 * the last good copy: the second run's backup replaces the first, so if the first
 * apply broke something and the second ran before anyone noticed, there is
 * nothing left to roll back to. Keysync is a REPEATED writer now rather than an
 * operator-run command, which makes that sequence scheduled rather than
 * hypothetical. The cost is a handful of small JSON files carrying no provider
 * keys — asymmetric in the obvious direction.
 */
export function retainOnSuccess({ snapshot, settingsFile, keepSettings = 5 }) {
  const removed = [];
  if (snapshot && fs.existsSync(snapshot)) { fs.rmSync(snapshot, { force: true }); removed.push(snapshot); }

  // Ordered by parsed timestamp, never by string sort — see listSettingsBackups.
  // The newest backup is never the one deleted.
  const { dated } = listSettingsBackups(settingsFile);
  for (const stale of dated.slice(keepSettings)) {
    fs.rmSync(stale.path, { force: true });
    removed.push(stale.path);
  }
  return removed;
}

/**
 * Cap what survives a FAILED run, so a rotated-out key cannot linger forever.
 *
 * Orders by the SAME parser as the settings backups, and deliberately by the
 * OPPOSITE undatable policy. The asymmetry is the point, and it follows from
 * what each kind of file contains:
 *
 *   settings backup   a rollback point, no provider keys. Keeping one too long
 *                     is harmless; deleting one is the destructive error — so an
 *                     undatable stamp is NEVER pruned (see listSettingsBackups).
 *   config snapshot   every provider API key, in one file. Deleting one is
 *                     harmless (the run already failed and the live DB is
 *                     untouched); keeping one too long is the risk — so an
 *                     undatable stamp is pruned FIRST, being precisely the file
 *                     whose age cannot be established.
 *
 * Do NOT unify these two policies. Sharing the parsing is correct; sharing the
 * policy either strands key material on disk indefinitely or deletes the user's
 * only rollback point.
 *
 * `dir` is injectable so tests never touch the real backup directory.
 */
export function capFailedSnapshots(max = 2, dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return [];
  const dated = [], undatable = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("config-")) continue;
    // config-<stamp>.sqlite, or .sqlite.dpapi once DPAPI-encrypted.
    const at = parseBackupStamp(name.slice("config-".length).replace(/\.sqlite(\.dpapi)?$/, ""));
    if (at === null) undatable.push(name); else dated.push({ name, at });
  }
  dated.sort((a, b) => b.at - a.at); // newest first
  // Undatable rank LAST, so they are the first candidates for pruning. Total kept
  // is still `max` — ranking them low never keeps more files than before.
  const ranked = [...dated.map((d) => d.name), ...undatable];

  const removed = [];
  for (const stale of ranked.slice(max)) {
    fs.rmSync(path.join(dir, stale), { force: true });
    removed.push(stale);
  }
  return removed;
}

/**
 * Restore settings.json from a backup.
 *
 * TWO DISTINCT FAILURE MODES, reported separately, because they call for
 * opposite operator responses: "no-backup" means nothing was attempted and no
 * rollback point exists, while "restore-failed" means the backup is intact and
 * still worth copying by hand. The old bare `false` collapsed them, and the
 * caller's single message named the backup path in both — sending an operator to
 * a file that is not there.
 *
 * Returns { ok: true, path } | { ok: false, reason, detail }. A `path` is present
 * ONLY on success, so a caller cannot name a path that was never written.
 */
export function restoreSettings(backup, settingsFile) {
  if (!backup || !fs.existsSync(backup)) {
    return {
      ok: false, reason: "no-backup",
      detail: backup
        ? "the backup file does not exist (never written this run, or removed since)"
        : "no backup path was recorded for this run"
    };
  }
  // Restore via temp + rename for the same reason the forward write does: this
  // path runs precisely when something has already failed, and a crash midway
  // through a truncate-and-overwrite leaves a file worse than either version.
  const tmp = `${settingsFile}.uw-restore-${process.pid}`;
  const short = (m) => String(m).slice(0, 100);
  try {
    fs.copyFileSync(backup, tmp);
    fs.renameSync(tmp, settingsFile);
    return { ok: true, path: settingsFile };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    try {
      fs.copyFileSync(backup, settingsFile);
      return { ok: true, path: settingsFile };
    } catch (e2) {
      return {
        ok: false, reason: "restore-failed",
        detail: `atomic restore failed (${short(e.message)}); direct copy also failed (${short(e2.message)})`
      };
    }
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

// ---- settings.json integrity across the rewrite (#7 / report 08 F4) --------

/**
 * The keys whose silent loss has NO visible symptom. Losing `autoMode.environment`
 * while `permissions.defaultMode` stays "auto" removes the policy governing
 * auto-approval and nothing anywhere reports it. List is report 08 F4's, verbatim.
 */
export const SECURITY_CRITICAL_KEYS = [
  "permissions", "hooks", "enabledPlugins", "extraKnownMarketplaces",
  "statusLine", "apiKeyHelper", "autoMode", "skillOverrides",
  "skipDangerousModePermissionPrompt", "skipAutoPermissionPrompt"
];

/** The ONLY top-level keys keysync may add, change or remove. */
export const KEYSYNC_OWNED_KEYS = ["modelPicker", "model"];

// stable() sorts object keys but preserves array order, so a benign re-ordering
// of an object is not reported as a modification while a reordered `hooks` array
// — which changes execution order — still is.
const digest = (v) =>
  crypto.createHash("sha256").update(JSON.stringify(stable(v) ?? null)).digest("hex").slice(0, 16);

/**
 * Assert that a settings.json rewrite changed only what keysync owns.
 *
 * The pre-existing post-write check is presence-only on three fields while
 * settings.json carries twenty, so nineteen keys could vanish silently. This
 * REJECTS rather than warns: moving from an operator-run command to a schedule
 * removes the human who would have noticed the warning.
 *
 * Throws on any drift. The caller's catch restores settings.json from the backup.
 */
export function assertSettingsInvariants(before, after, { owned = KEYSYNC_OWNED_KEYS } = {}) {
  const ownedSet = new Set(owned);
  const problems = [];

  for (const k of Object.keys(before)) {
    if (!(k in after) && !ownedSet.has(k)) problems.push(`key "${k}" LOST`);
  }
  for (const k of SECURITY_CRITICAL_KEYS) {
    // A dropped key is already reported as LOST; this is the subtler case where
    // the key survives and its contents were rewritten.
    if (!(k in before) || !(k in after)) continue;
    if (digest(before[k]) !== digest(after[k])) problems.push(`security-critical key "${k}" MODIFIED`);
  }
  for (const k of Object.keys(after)) {
    if (!(k in before) && !ownedSet.has(k)) problems.push(`unexpected new key "${k}"`);
  }

  if (problems.length) {
    throw new Error(`post-write settings integrity check failed: ${problems.join("; ")}`);
  }
}

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

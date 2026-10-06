// Pure data and pure functions for the S0 subagent-policy sandbox run (plan 9.2, 12.0 Phase B, 12.1 S0). Importing this module reads,
// writes, starts and contacts nothing. It is the single home of: the sandbox ports and directories, the forced launch environment
// (every isolation-relevant field set explicitly, memories sandbox-port-isolation-gotcha and ccr-takeover-breaks-sandbox-isolation),
// the spec check that refuses a launch that could reach live state, the side-effect inventory, the PASS/FINDING/FAIL line format,
// the live-state fingerprint and the isolation proof. The orchestrator (subagent-e2e.mjs) wires these to real I/O; the unit tests
// drive them with fakes.
//
// Reused, not reinvented: harness/config.mjs (3.0.22 sandbox constants), harness/guard.mjs (tripwire, payload and config asserts),
// harness/start.ps1 + harness/bootstrap-live-safe.mjs (the start and bootstrap steps) and harness/trial31/preload-guard.cjs (the
// fail-closed process guard from the 3.1.1 trial, configured here for the 3.0.22 sandbox root).

import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  SCRATCH_ROOT, ENV, WEB_PORT, GATEWAY_PORT, GATEWAY_CORE_PORT, LIVE_PORTS, LIVE_SETTINGS, SCRATCH_SETTINGS, CCR_APP_DATA_DIR,
  CCR_CONFIG_DIR, CCR_LOCAL_APP_DATA_DIR, SCRATCH_CLAUDE_CONFIG_DIR, LIVE_CLAUDE_3P_DIR, LIVE_DOWNLOADS, DAEMON_STAMP, STUB_PORT, PORT_RANGE, RELAY_PORT,
} from "./config.mjs";
import { STUB_MODELS } from "./stub-upstream.mjs";

export { SCRATCH_ROOT, STUB_PORT, STUB_MODELS, LIVE_SETTINGS, CCR_CONFIG_DIR, SCRATCH_SETTINGS };

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.dirname(HARNESS_DIR);
const HOME = os.homedir();
const ROAMING = path.join(HOME, "AppData", "Roaming");
const LOCAL = path.join(HOME, "AppData", "Local");

export { RELAY_PORT, PORT_RANGE };                               // defined once, in harness/config.mjs
export const REAL_PORTS = [...LIVE_PORTS, RELAY_PORT];
export const SANDBOX_PORTS = { gateway: GATEWAY_PORT, core: GATEWAY_CORE_PORT, web: WEB_PORT, stub: STUB_PORT };
export const EPHEMERAL_MIN = 49152;                              // OS-assigned loopback listeners (a RECORD, never a violation)

// The probe router is TRACKED source OUTSIDE the scratch root (sec#15): the stock harness/teardown.mjs deletes the whole scratch root and must never be able to take it.
export const PROBE_ROUTER_SRC = path.join(HARNESS_DIR, "probe-router.cjs");
export const NEXT_ROUTER_SRC = path.join(REPO_ROOT, "router", "uw-router.next.cjs");
export const SCRATCH_SPIKE_DIR = path.join(SCRATCH_ROOT, "spike");
export const SCRATCH_ROUTER = path.join(SCRATCH_SPIKE_DIR, "uw-router.cjs");
export const SCRATCH_SLOT = path.join(SCRATCH_SPIKE_DIR, "slot.json");
export const SCRATCH_STATE_ROOT = path.join(SCRATCH_ROOT, "state");
export const SCRATCH_STATE_DIR = path.join(SCRATCH_STATE_ROOT, "subagent");
export const SCRATCH_HOME = path.join(SCRATCH_ROOT, "home");
export const SCRATCH_TMP = path.join(SCRATCH_ROOT, "tmp");
// Retained evidence of a refused or failed run (violations.log, CCR log tails, redacted) and the owner's plan approval live OUTSIDE SANDBOX_OWNED, so the automatic teardown cannot take them.
export const EVIDENCE_ROOT = path.join(HARNESS_DIR, "g1-evidence");
export const APPROVAL_FILE = path.join(HARNESS_DIR, "g1-approval.json");
export const APPROVAL_MAX_AGE_MS = 24 * 3600 * 1000;
/** A run consumes the approval by ATOMICALLY renaming it to this unique name (rename succeeds for exactly one of two racing runs); harness/g1-* is gitignored. */
export const approvalUsedFile = (pid, ts) => path.join(HARNESS_DIR, `g1-approval.used-${Number(pid)}-${Number(ts)}`);
export const isApprovalUsedFile = (abs) => norm(path.dirname(abs)) === norm(HARNESS_DIR) && /^g1-approval\.used-\d+-\d+$/.test(path.basename(abs));
export const VIOLATIONS_LOG = path.join(SCRATCH_ROOT, "violations.log");
export const GUARD_LOADED_LOG = path.join(SCRATCH_ROOT, "guard-loaded.log");
export const TAKEOVER_FILE = path.join(CCR_CONFIG_DIR, "global-profile-takeover.json");
export const PRELOAD_FILE = path.join(HARNESS_DIR, "trial31", "preload-guard.cjs");
export const PRELOAD_ARG = `--require "${PRELOAD_FILE.replace(/\\/g, "/")}"`;
export const START_PS1 = path.join(HARNESS_DIR, "start.ps1");
export const BOOTSTRAP_LIVE_SAFE = path.join(HARNESS_DIR, "bootstrap-live-safe.mjs");
export const GUARD_DIR = path.join(HARNESS_DIR, "trial31");
export const LIVE_SERVICE_JSON = path.join(ROAMING, "claude-code-router", "service.json");
export const LIVE_CLAUDE_DIR = path.join(HOME, ".claude");
export const LIVE_LLMKEYS = path.join(HOME, ".llmkeys");
export const LIVE_STATE_SUBAGENT = path.join(REPO_ROOT, "state", "subagent");
export const LIVE_CATALOG = path.join(REPO_ROOT, "catalog");

/** Children of the scratch root this orchestrator creates and may remove. NOTHING ELSE under it is ever deleted. */
export const SANDBOX_OWNED = ["appdata", "localappdata", "claude-config", "home", "tmp", "spike", "state", "daemon-env.json", "claude-settings.json",
  "violations.log", "guard-loaded.log"];

/**
 * Every file the run executes or loads (the orchestrator and what it imports, the probe router, the bootstrap step, start.ps1, the preload guard and what
 * IT loads, and the exact router bytes under test). The plan prints the sha256 of each, so the plan hash covers them: an edit to any of them after the owner
 * read the plan voids the approval.
 */
export const EXECUTED_FILES = [
  path.join(HARNESS_DIR, "subagent-e2e.mjs"), path.join(HARNESS_DIR, "subagent-sandbox-spec.mjs"), path.join(HARNESS_DIR, "guard.mjs"), path.join(HARNESS_DIR, "config.mjs"),
  path.join(HARNESS_DIR, "stub-upstream.mjs"), PROBE_ROUTER_SRC, BOOTSTRAP_LIVE_SAFE, START_PS1, path.join(GUARD_DIR, "preload-guard.cjs"),
  path.join(GUARD_DIR, "guard-core.cjs"), path.join(GUARD_DIR, "redact31.cjs"), NEXT_ROUTER_SRC,
];
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
/** A checkout with core.autocrlf=true turns LF into CRLF, so each file is hashed twice: its raw working-tree bytes (what runs) and with CRLF folded to LF (comparable with a git blob). */
const lfBytes = (buf) => Buffer.from(Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n"), "latin1");
const readOrNull = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
/** [{file (repo-relative, forward slashes), raw, lf}] for EXECUTED_FILES; an unreadable file is "(absent)". `read` is injectable (tests). */
export function hashExecutedFiles(read = readOrNull) {
  return EXECUTED_FILES.map((f) => {
    const buf = read(f), file = path.relative(REPO_ROOT, f).replace(/\\/g, "/");
    return buf == null ? { file, raw: "(absent)", lf: "(absent)" } : { file, raw: sha256(buf), lf: sha256(lfBytes(buf)) };
  });
}

/**
 * The installed CCR this run would execute, resolved READ-ONLY and WITHOUT running ccr, the way `ccr start` in start.ps1 resolves it: the FIRST directory on PATH that
 * holds any `ccr` launcher must hold ccr.cmd (an npm shim: `node "%dp0%\node_modules\...\dist\main\cli.js" %*`); that shim names cli.js, whose package.json gives the
 * version. found:false carries a `reason`; the plan prints NOT FOUND and a run refuses. env/fsx are injectable (tests use a temp tree).
 */
export function resolveCcrInstall({ env = process.env, fsx = fs } = {}) {
  const no = (reason) => ({ found: false, reason });
  const read = (f) => { try { return fsx.readFileSync(f); } catch { return null; } };
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const present = ["ccr.exe", "ccr.cmd", "ccr.bat", "ccr.com", "ccr.ps1", "ccr"].filter((n) => read(path.join(dir, n)) != null);
    if (!present.length) continue;
    const cmd = path.join(dir, "ccr.cmd"), shim = read(cmd);
    if (shim == null) return no(`the first directory on PATH holding a ccr launcher (${dir}) has ${present.join(", ")} but no ccr.cmd`);
    const m = /%dp0%\\+([^"%]*?cli\.js)/i.exec(shim.toString("latin1"));
    if (!m) return no(`${cmd} does not name a cli.js`);
    const cli = path.resolve(dir, m[1]), cliBytes = read(cli);
    if (cliBytes == null) return no(`${cmd} names ${cli}, which cannot be read`);
    const pkgFile = path.join(path.dirname(cli), "..", "..", "package.json"), pkgBytes = read(pkgFile);
    let pkg = null; try { pkg = JSON.parse(String(pkgBytes)); } catch { /* reported below */ }
    if (!pkg || typeof pkg.version !== "string") return no(`no readable package.json with a version at ${path.resolve(pkgFile)}`);
    return { found: true, cmd, cmdSha: sha256(shim), cli, cliSha: sha256(cliBytes), name: String(pkg.name ?? "?"), version: pkg.version, dist: distOf(path.dirname(cli), fsx) };
  }
  return no("no ccr launcher on PATH");
}
/**
 * The daemon loads more than cli.js from dist/main (gateway-bootstrap.js, route-script-worker.js, request-log-worker.js, ...). Every *.js file there is hashed (names and sha256,
 * sorted by name, so the listing is deterministic); `.bak-*` patch backups that sit beside them (cli.js.bak-findprovider-cache and so on) are listed by NAME and SIZE only, as present and
 * not loaded, and are never hashed or read. An unreadable directory is { error }, an unreadable file's sha256 is "(unreadable)".
 */
export function distOf(dir, fsx = fs) {
  let names;
  try { names = fsx.readdirSync(dir).map((e) => (typeof e === "string" ? e : e.name)).sort(); } catch (e) { return { error: oneLine(e?.code ?? e?.message, 60) }; }
  const isFile = (n) => { try { return fsx.statSync(path.join(dir, n)).isFile(); } catch { return false; } };
  const isBak = (n) => /\.bak(-|$)/i.test(n);
  const loaded = names.filter((n) => /\.js$/i.test(n) && !isBak(n) && isFile(n)).map((n) => { try { return { name: n, sha: sha256(fsx.readFileSync(path.join(dir, n))) }; } catch { return { name: n, sha: "(unreadable)" }; } });
  const baks = names.filter((n) => isBak(n) && isFile(n)).map((n) => { let size = -1; try { size = fsx.statSync(path.join(dir, n)).size; } catch { /* raced */ } return { name: n, size }; });
  return { dir, loaded, baks };
}
const distLines = (x) => {
  if (!x) return [];                                         // an install object without the listing (unit-test fakes): nothing to print
  if (x.error) return [`    dist/main/*.js  NOT LISTED (${x.error}): the files the daemon loads next to cli.js are unknown`];
  return [`    dist/main/*.js  ${x.loaded.length} file${x.loaded.length === 1 ? "" : "s"} the daemon can load, sha256 each (sorted by name):`, ...x.loaded.map((f) => `      ${f.name}  sha256 ${f.sha}`),
    ...(x.baks.length ? [`    present, NOT loaded, not hashed (names and sizes only): ${x.baks.map((b) => `${b.name} (${b.size} bytes)`).join(", ")}`] : [])];
};
/** The plan lines for a resolved install (deterministic; the plan hash covers them). */
export const ccrInstallLines = (c) => (c?.found
  ? [`  CCR install (resolved read-only as \`ccr start\` in start.ps1 resolves it, nothing is run): the first ccr launcher on PATH is ccr.cmd`, `    ccr.cmd  ${c.cmd}  sha256 ${c.cmdSha}`, `    package  ${c.name} version ${c.version}`, `    cli.js   ${c.cli}  sha256 ${c.cliSha}`, ...distLines(c.dist)]
  : [`  CCR install: NOT FOUND (${oneLine(c?.reason ?? "not resolved", 160)}): a run REFUSES, and so does --approve-plan`]);

/** Paths this run must never write, read-modify or delete (the plan lists them; the preload guard denies the write ones in the daemon tree). */
export const NEVER_TOUCH = [
  LIVE_CLAUDE_DIR, path.join(HOME, ".claude.json"), LIVE_LLMKEYS, path.join(REPO_ROOT, "state"), LIVE_CATALOG, path.join(REPO_ROOT, "spike"),
  path.join(REPO_ROOT, "router"), path.join(ROAMING, "claude-code-router"), LIVE_CLAUDE_3P_DIR, LIVE_DOWNLOADS, path.join(HOME, ".codex"),
  path.join(HOME, ".claude-code-router"),
];
export const NEVER_TOUCH_NON_FS = [
  "Windows Credential Manager (LLMKEY:* secrets)", "HKCU\\Environment (user PATH)", "live listeners 3456, 3457, 3458 and the relay 4517 (no connect, no bind)",
  "the live CCR service.json and the live gateway process (only its pid is ever read, to refuse stopping it)", "the live CUSTOM_ROUTER_PATH (never read or written)",
  "HKCU Internet Settings (system proxy; only read, by reg query, for ProxyEnable and ProxyServer)",
];

// The throwaway daemon may write ONLY inside the scratch root. Listed individually (not `.uw` as a whole) because the scratch root itself
// sits under `.uw` and the guard checks protected roots BEFORE the allowed root.
export const PROTECTED_ROOTS = [
  LIVE_CLAUDE_DIR, path.join(HOME, ".claude.json"), path.join(HOME, ".codex"), path.join(HOME, ".claude-code-router"), path.join(HOME, ".config"),
  LIVE_DOWNLOADS, path.join(HOME, "Documents"), path.join(HOME, "Desktop"), LIVE_LLMKEYS,
  path.join(REPO_ROOT, "state"), path.join(REPO_ROOT, "catalog"), path.join(REPO_ROOT, "spike"), path.join(REPO_ROOT, "router"),
  path.join(REPO_ROOT, "keysync"), path.join(REPO_ROOT, "menu"), path.join(REPO_ROOT, "refresh"), path.join(REPO_ROOT, "docs"),
  path.join(ROAMING, "claude-code-router"), path.join(ROAMING, "Claude Code Router"), path.join(ROAMING, "Claude"),
  LIVE_CLAUDE_3P_DIR, path.join(LOCAL, "Claude"), "C:\\nvm4w",
  path.join(HOME, ".bashrc"), path.join(HOME, ".bash_profile"), path.join(HOME, ".profile"), path.join(HOME, ".zshrc"),
];

const norm = (p) => String(p).replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
export const isUnder = (child, root) => { const c = norm(path.resolve(String(child))), r = norm(path.resolve(String(root))); return c === r || c.startsWith(r + "\\"); };
const underAny = (p, roots) => roots.find((r) => isUnder(p, r));

export class RefusalError extends Error { constructor(m) { super(m); this.name = "RefusalError"; } }
const bad = (m) => { throw new RefusalError(`REFUSED: ${m}`); };

const realNative = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
/** realpath of the deepest EXISTING ancestor plus the not-yet-existing tail: a target that does not exist yet, or sits behind a junction or symlink, still resolves to where it would really land. */
export function realish(p) {
  let head = path.resolve(String(p)), tail = "";
  for (;;) {
    try { return path.join(realNative(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(String(p));
    tail = path.join(path.basename(head), tail); head = up;
  }
}

/**
 * Every write the orchestrator makes goes through this: inside the scratch root (or an explicitly allowed extra root, tests only) and never under NEVER_TOUCH.
 * Both the lexical path AND its realpath are checked (a junction or symlink planted inside the scratch tree that leads to a protected or outside folder is refused:
 * the realpath of the deepest existing ancestor is re-checked against the roots, which are themselves resolved the same way). `never` is injectable for tests only.
 */
export function safeWritePath(p, extraRoots = [], never = NEVER_TOUCH) {
  const abs = path.resolve(String(p));
  if (abs.startsWith("\\\\")) bad(`write target ${abs} is a UNC or device path`);
  const real = realish(abs);
  const hit = underAny(abs, never) ?? never.find((r) => isUnder(real, realish(r)));
  if (hit) bad(`write target ${abs} is under protected ${hit}${real !== abs ? ` (resolves to ${real})` : ""}`);
  const allowed = [SCRATCH_ROOT, ...extraRoots];
  if (!allowed.some((r) => isUnder(abs, r)) || !allowed.some((r) => isUnder(real, realish(r)))) {
    bad(`write target ${abs} is outside the sandbox scratch root ${SCRATCH_ROOT}${real !== abs ? ` (resolves to ${real})` : ""}`);
  }
  return abs;
}

/** The places outside the scratch root the orchestrator may write: the evidence directory, the approval file and the consumed-approval name (exact paths; realpath re-checked). */
export function safeEvidencePath(p) {
  const abs = path.resolve(String(p));
  const real = realish(abs);
  const ok = (r) => isUnder(abs, r) && isUnder(real, realish(r));
  const exactFile = (f) => norm(abs) === norm(f) && norm(real) === norm(realish(f));
  if (!(ok(EVIDENCE_ROOT) || exactFile(APPROVAL_FILE) || (isApprovalUsedFile(abs) && exactFile(abs)))) bad(`evidence target ${abs} is not under ${EVIDENCE_ROOT} and is not the approval file or its consumed (g1-approval.used-<pid>-<ts>) name`);
  if (underAny(abs, NEVER_TOUCH) || NEVER_TOUCH.some((r) => isUnder(real, realish(r)))) bad(`evidence target ${abs} is under a protected path`);
  return abs;
}

// ---------------------------------------------------------------- the forced launch environment
const INHERIT = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PATH", "Path", "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "COMPUTERNAME", "USERNAME", "USERDOMAIN", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)",
  "CommonProgramW6432", "ProgramData", "ALLUSERSPROFILE", "PUBLIC"];
export const REDIRECTED_ENV = ["CCR_INTERNAL_APP_DATA_DIR", "CCR_CONFIG_DIR", "CCR_INTERNAL_HOME_DIR", "CCR_INTERNAL_USER_DATA_DIR", "LOCALAPPDATA", "APPDATA",
  "USERPROFILE", "HOME", "TEMP", "TMP", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"];

/** Everything not whitelisted (proxy variables, API keys, ANTHROPIC_*, CLAUDE_*, CCR_*) is dropped, never filtered by name. */
export function buildLaunchEnv(parent = process.env, { preloadGuard = true } = {}) {
  const env = {};
  for (const k of INHERIT) if (parent[k] !== undefined) env[k] = parent[k];
  Object.assign(env, ENV, {
    HOST: "127.0.0.1", PORT: String(GATEWAY_PORT),               // the gateway's generic fallbacks, forced (the DB-config ports are forced separately)
    USERPROFILE: SCRATCH_HOME, HOME: SCRATCH_HOME, HOMEDRIVE: SCRATCH_HOME.slice(0, 2), HOMEPATH: SCRATCH_HOME.slice(2),
    APPDATA: CCR_APP_DATA_DIR, LOCALAPPDATA: CCR_LOCAL_APP_DATA_DIR, TEMP: SCRATCH_TMP, TMP: SCRATCH_TMP,
    XDG_CONFIG_HOME: path.join(SCRATCH_HOME, ".config"), CODEX_HOME: path.join(SCRATCH_HOME, ".codex"), CLAUDE_CONFIG_DIR: SCRATCH_CLAUDE_CONFIG_DIR,
    CCR_INTERNAL_HOME_DIR: SCRATCH_HOME, CCR_INTERNAL_USER_DATA_DIR: CCR_CONFIG_DIR,
  });
  if (preloadGuard) {
    Object.assign(env, {
      NODE_OPTIONS: PRELOAD_ARG, UW_TRIAL31_PRELOAD_ARG: PRELOAD_ARG, UW_TRIAL31_ROOT: SCRATCH_ROOT, UW_TRIAL31_PORT_RANGE: PORT_RANGE.join("-"),
      UW_TRIAL31_REAL_PORTS: REAL_PORTS.join(","), UW_TRIAL31_PROTECTED: PROTECTED_ROOTS.join(";"),
    });
  }
  return env;
}

/**
 * Every directory the launch env points at must EXIST when the daemon tree starts (an unset or missing TEMP/HOME makes tools fall back or fail at
 * odd moments). PRECREATE_DIRS are created by the preflight (through safeWritePath); START_CREATES are created by harness/start.ps1 itself
 * (New-Item for the root, appdata, localappdata, claude-config) and by CCR (the CONFIGDIR) and MUST be ABSENT before the run, which is how the
 * preflight proves the tree is fresh. assertSandboxSpec requires the two lists to cover every directory variable.
 */
export const PRECREATE_DIRS = [SCRATCH_HOME, SCRATCH_TMP, path.join(SCRATCH_HOME, ".config"), path.join(SCRATCH_HOME, ".codex")];
export const START_CREATES = [CCR_APP_DATA_DIR, CCR_LOCAL_APP_DATA_DIR, SCRATCH_CLAUDE_CONFIG_DIR, CCR_CONFIG_DIR];
/** Entries of the scratch root that must be absent before a run (a leftover of any earlier sandbox: its config.sqlite is never read or printed). */
export const MUST_BE_ABSENT = [CCR_APP_DATA_DIR, CCR_LOCAL_APP_DATA_DIR, SCRATCH_CLAUDE_CONFIG_DIR, DAEMON_STAMP, SCRATCH_SETTINGS];
export const ENV_DIR_VARS = [...REDIRECTED_ENV, "XDG_CONFIG_HOME", "CODEX_HOME"];

export const printableEnv = (env) => Object.fromEntries(Object.entries(env).map(([k, v]) => [k, /TOKEN/i.test(k) ? "***" : v]));

export function buildSpec(parent = process.env, { preloadGuard = true } = {}) {
  return {
    root: SCRATCH_ROOT, ports: { ...SANDBOX_PORTS }, preloadGuard, env: buildLaunchEnv(parent, { preloadGuard }), settingsFile: SCRATCH_SETTINGS,
    routers: { probe: PROBE_ROUTER_SRC, next: NEXT_ROUTER_SRC, scratchCopy: SCRATCH_ROUTER },
    commands: [
      { id: "start", cmd: "powershell", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", START_PS1], note: "ccr start into the scratch CONFIGDIR (existing harness script; ACLs the scratch root, stamps daemon-env.json)" },
      { id: "bootstrap", cmd: process.execPath, args: [BOOTSTRAP_LIVE_SAFE], note: "forces gateway.host/port/corePort, HOST, PORT, settingsFile to scratch values; skips the live-ports precondition by design" },
    ],
  };
}

/** Throws RefusalError unless this launch cannot reach live state or live ports. Pure. */
export function assertSandboxSpec(spec) {
  if (!spec || !spec.env || !spec.ports) bad("spec is incomplete");
  if (path.resolve(spec.root) !== path.resolve(SCRATCH_ROOT)) bad(`root ${spec.root} is not the sandbox scratch root ${SCRATCH_ROOT}`);
  const hit = underAny(spec.root, NEVER_TOUCH);
  if (hit) bad(`the sandbox root is under protected ${hit}`);
  const env = spec.env;
  for (const k of REDIRECTED_ENV) {
    if (!env[k]) bad(`${k} is not set (an unset redirect falls back to the REAL location)`);
    if (!isUnder(env[k], spec.root)) bad(`${k}=${env[k]} is not under the sandbox root`);
  }
  for (const k of ENV_DIR_VARS) {
    const v = env[k];
    if (!PRECREATE_DIRS.some((x) => norm(x) === norm(v)) && !START_CREATES.some((x) => norm(x) === norm(v))) bad(`${k}=${v} is neither pre-created by the preflight nor created by start.ps1: it would not exist when the daemon starts`);
  }
  const { gateway, core, web, stub } = spec.ports;
  const ports = [gateway, core, web, stub];
  if (new Set(ports).size !== 4) bad("sandbox ports are not distinct");
  for (const p of ports) {
    if (!Number.isInteger(p) || p < PORT_RANGE[0] || p > PORT_RANGE[1]) bad(`sandbox port ${p} is outside ${PORT_RANGE.join("-")}`);
    if (REAL_PORTS.includes(p)) bad(`sandbox port ${p} is a LIVE port`);
  }
  if (env.CCR_WEB_PORT !== String(web)) bad(`CCR_WEB_PORT=${env.CCR_WEB_PORT} is not forced to the web port ${web} (the web port is env-controlled and must be set on every start)`);
  if (env.CCR_WEB_HOST !== "127.0.0.1" || env.HOST !== "127.0.0.1") bad("CCR_WEB_HOST and HOST must be forced to 127.0.0.1");
  if (env.PORT !== String(gateway)) bad(`PORT=${env.PORT} is not forced to the gateway port ${gateway}`);
  if (!env.CCR_WEB_AUTH_TOKEN) bad("CCR_WEB_AUTH_TOKEN is not set");
  for (const k of Object.keys(env)) {
    if (/proxy/i.test(k)) bad(`proxy variable ${k} must not be inherited`);
    if (/^(ANTHROPIC_|CLAUDE_CODE_|OPENAI_|CCR_GATEWAY_)/i.test(k) || /(API_?KEY|SECRET)/i.test(k)) bad(`credential or routing variable ${k} must not be inherited`);
  }
  if (path.resolve(spec.settingsFile) !== path.resolve(SCRATCH_SETTINGS) || isUnder(LIVE_SETTINGS, spec.settingsFile) || norm(spec.settingsFile) === norm(LIVE_SETTINGS)) {
    bad(`settingsFile ${spec.settingsFile} is not the scratch settings file`);
  }
  const copy = spec.routers?.scratchCopy;
  if (!copy || !isUnder(copy, spec.root)) bad("the router copy is not inside the sandbox root");
  if (/[\\/]\.uw[\\/]spike[\\/]/i.test(copy)) bad("the router copy path contains the live \\.uw\\spike\\ folder");
  if (spec.preloadGuard) {
    if (env.NODE_OPTIONS !== PRELOAD_ARG) bad("NODE_OPTIONS is not exactly the guard preload");
    if (env.UW_TRIAL31_ROOT !== spec.root) bad("the guard root is not the sandbox root");
    const prot = String(env.UW_TRIAL31_PROTECTED || "").split(";").filter(Boolean);
    for (const r of prot) if (isUnder(spec.root, r)) bad(`guard protected root ${r} contains the sandbox root (the guard would deny every sandbox write)`);
    for (const need of [LIVE_CLAUDE_DIR, LIVE_LLMKEYS, path.join(REPO_ROOT, "state"), path.join(REPO_ROOT, "catalog")]) {
      if (!prot.some((r) => norm(r) === norm(need))) bad(`guard protected roots do not include ${need}`);
    }
    for (const p of REAL_PORTS) if (!String(env.UW_TRIAL31_REAL_PORTS || "").split(",").includes(String(p))) bad(`guard real ports omit ${p}`);
  }
  return spec;
}

// ---------------------------------------------------------------- the side-effect inventory (printed by --plan, checked by the proof)
// mode: prevent = stopped before it happens; detect = compared before/after and the run is refused or failed; record = measured and reported.
export const SIDE_EFFECTS = [
  { id: "live-settings", what: "~/.claude/settings.json (sha256, env.ANTHROPIC_BASE_URL, marker count) and any settings* file name in ~/.claude", mode: "prevent+detect", how: "preload guard denies writes under ~/.claude in the daemon tree; settingsFile pinned to scratch and asserted before and after every saveConfig; sha256 and names compared at every proof" },
  { id: "global-profile-takeover", what: "CCR global-profile-takeover.json settingsFile fields in the sandbox tree", mode: "detect", how: "read after start and after each saveConfig; any settingsFile that is not the scratch file refuses the run" },
  { id: "credential-manager", what: "Windows Credential Manager target list (LLMKEY:* vault secrets)", mode: "detect", how: "hash of the LLMKEY:* target lines of `cmdkey /list` before and after (target names only, hash only is kept; other applications' credentials are not part of it)" },
  { id: "hkcu-path", what: "HKCU\\Environment user PATH", mode: "prevent+detect", how: "guard denies reg/setx/Set-ItemProperty spawns; tripwire compares the user PATH" },
  { id: "live-ports", what: "listeners 3456, 3457, 3458 and the relay 4517", mode: "prevent+detect", how: "owner pid recorded before; compared at every proof; the guard refuses any bind or connect to a live port; the stub and every request use sandbox ports only" },
  { id: "sandbox-ports", what: `gateway ${GATEWAY_PORT}, core ${GATEWAY_CORE_PORT}, web ${WEB_PORT}, stub ${STUB_PORT} (all DB-config or env controlled)`, mode: "detect", how: "gateway.host/port/corePort, HOST and PORT forced in the config AND CCR_WEB_PORT forced in the env on every start; verified by listener pid over the daemon PROCESS TREE (the daemon holds gateway and web, its child holds core): each sandbox port is held by a tree member (stub by the orchestrator) and no tree process holds any other non-ephemeral port or any non-loopback address" },
  { id: "web-port", what: "CCR_WEB_PORT (env-controlled; omitted once and bound the real 3458)", mode: "prevent+detect", how: "assertSandboxSpec requires it forced; assertIsolatedInstance requires the daemon web port = 39458 and service.json token match" },
  { id: "system-proxy", what: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings ProxyEnable and ProxyServer (a system proxy would carry loopback or other traffic)", mode: "detect", how: "reg query of both values before and after (hash only is kept, never the values); the guard additionally refuses any non-loopback connect in the daemon tree" },
  { id: "live-service-json", what: "live service.json (%APPDATA%\\claude-code-router): pid and file hash", mode: "detect", how: "hash and pid before and after (the url token inside is never printed)" },
  { id: "process-list", what: "CCR/node processes: the live daemon set must be unchanged, new ones must descend from the sandbox daemon", mode: "detect", how: "process table before and after (pid, parent, name; command lines are matched, never printed)" },
  { id: "claude-3p", what: "%LOCALAPPDATA%\\Claude-3p (desktop-app sync target)", mode: "prevent+detect", how: "LOCALAPPDATA redirected; the tripwire fingerprints ONLY the configLibrary folder: the NAME of every entry and the sha256 of the CONTENT of every *.json in it (<id>.json, which CCR's sync rewrites on every sync, and _meta.json). NO LONGER covered by the tripwire (the app rewrites them while it runs, so they would cry wolf): config.json, claude_desktop_config.json, other Claude-3p files edited in place, top-level or nested names, model-catalog/. Those are covered by the preload guard (writes under Claude-3p are denied in the daemon tree), the LOCALAPPDATA redirect, and assertDesktopSyncLandedInScratch (the desktop sync must land in scratch)" },
  { id: "downloads", what: "~/Downloads listing (exportData writes provider keys there)", mode: "detect", how: "tripwire compares the recursive NAME listing (a new file trips it; sizes and mtimes are ignored, so a download in progress does not)" },
  { id: "llmkeys", what: "~/.llmkeys (vault files, registry.json, subagent-policy.json)", mode: "prevent+detect", how: "never read or written by any step; listing (names, sizes) and sha256 of registry.json and subagent-policy.json compared" },
  { id: "uw-state", what: "C:\\Users\\osami\\.uw\\state (incl. state/subagent)", mode: "prevent+detect", how: "every orchestrator write goes through safeWritePath (scratch root only); the router copy derives its state dir from its own location (scratch); in state/subagent the compiled policy.json (sha256), shadow.flag (presence and content, sha256) and every file that is NOT router runtime (name and size; a new unknown file is a difference) are compared, while the LIVE v2 router's own runtime files (decisions*/classify*/agents* logs and journals, main-*.json, status*.json, cooling.json, .tmp-* and *.lock) are ignored by rule because live sessions write them all the time" },
  { id: "uw-catalog", what: "C:\\Users\\osami\\.uw\\catalog listing", mode: "detect", how: "listing (names, sizes) compared" },
  { id: "claude-config-dir", what: "~/.claude other files (history, projects, sessions)", mode: "prevent", how: "not watched (live sessions write there constantly); protected only by the guard write-deny in the daemon tree and by USERPROFILE/HOME/CLAUDE_CONFIG_DIR redirects" },
  { id: "network-egress-update-checks", what: "any non-loopback connect or DNS (update checks, telemetry)", mode: "prevent", how: `guard denies non-loopback connect, DNS and ports outside ${PORT_RANGE.join("-")} in every node process of the daemon tree; violations.log must be empty` },
  { id: "logs", what: "CCR logs and the guard logs", mode: "record", how: "CCR logs land under the scratch CONFIGDIR; violations.log and guard-loaded.log are in the scratch root and are read by the proof" },
  { id: "scheduled-supervisor", what: "the 'UW Process Supervision' scheduled task state (could restart or fight the sandbox)", mode: "record", how: "state read before and after" },
  { id: "live-custom-router-path", what: "the live CUSTOM_ROUTER_PATH and live router file", mode: "prevent", how: "never read or written; the sandbox config gets the scratch copy path, read back and asserted free of the \\.uw\\spike\\ folder" },
  { id: "sandbox-core-worker-respawn", what: "the sandbox daemon's core worker (its child holding the core port) replaced by CCR during the run (observed in G1 attempt 3, around the Router.fallback swaps)", mode: "record", how: "the pid holding the core port is remembered at each post-provider proof; a change is printed as a RECORD line with the gateway and daemon pids (which the checks still judge), never as a failure; a proof call to the sandbox web RPC that fails with a transient network error meanwhile is retried (at most 5 attempts, 1.5 s apart, 10 s in all, re-resolving service.json and re-verifying port and pid each time), a mismatch never" },
  { id: "sandbox-profile-key", what: "an API key entry for the enabled claude-code profile, ADDED to the SANDBOX config when missing (id profile:<profile id, mLe-normalised>, name Profile: <name>, key ccr-profile-<24 random characters> generated at run time)", mode: "record", how: "added only in the payload of the sandbox-only saveConfig with applyProfile:false over the sandbox web RPC (CCR creates it only in its applyProfile path, which the harness never uses); read back on the persisted config by exact id (a miss is FAIL A0 before any request); the key is never printed and never written to the plan or the retained evidence (masked verbatim); the live config, ~/.claude, ~/.llmkeys and the Credential Manager are never touched; it disappears with the scratch config at teardown" },
  { id: "sandbox-router-fallback", what: "the SANDBOX config's Router.fallback, hot-swapped through the sandbox web RPC for X9 (off -> model-chain with ONE stub model -> retry), and a Providers edit for X1", mode: "detect", how: "every swap passes assertPayloadIsolated and a local check (mode off|retry|model-chain, chain models only uwstub/*, no enabled Router.rules); the original value is restored at the end of the probe run and read back through assertRouterClean on a FRESH getConfig (saveConfig's return value is the daemon's normalised echo, not a read of what it persisted), and every later isolation proof reads Router.fallback fresh again and runs assertRouterClean on it (mode off, no chain models, no enabled rules); the teardown scrubs it again when the daemon was not stopped; the live config is never read or written (the rpc refuses every port but the sandbox web port)" },
];

export const CANNOT_VERIFY = [
  "The FIRST `ccr start` on a fresh config dir happens before any config assert is possible: a takeover write to the real settings.json in that instant is prevented only by the preload guard (UNTESTED against 3.0.22; written for 3.1.1) and detected afterwards by the tripwire; it cannot be pre-verified.",
  "That the trial31 preload guard is compatible with the 3.0.22 daemon (it fails closed: a daemon that dies at start with a violations.log entry is the symptom; --no-preload-guard drops it and is a reviewed owner choice).",
  "That USERPROFILE/HOME redirects change where the daemon resolves `~` (memory says the takeover path is hardcoded; the redirect is an extra layer, not proof).",
  "Writes by native code that bypasses node fs, and by `ccr.cmd` / cmd.exe / powershell children outside node (the guard loads only in node processes).",
  "How CCR derives the profile key id (the request must carry the key of the enabled claude-code profile): resolved at run time by A0; a mismatch aborts the run, it is not silently tolerated.",
  "What start.ps1 does to the scratch root ACL (icacls /inheritance:r) and that it stamps daemon-env.json: existing harness behaviour, unchanged.",
  "~/.claude churn files (history, projects) and live state/ churn files are not fingerprinted (they change legitimately during any live session).",
  "The real Claude-3p folder is watched only in configLibrary (names and *.json content); an escaping write to any other file there (config.json, claude_desktop_config.json, model-catalog/, new names) is NOT detected after the fact: only the preload guard (node processes of the daemon tree), the LOCALAPPDATA redirect and assertDesktopSyncLandedInScratch stand between a sync and that folder.",
  "The credential-manager hash covers the LLMKEY:* targets only (a Windows credential added or removed by another application is not seen); an in-place secret change under the same target name is invisible.",
];

// ---------------------------------------------------------------- PASS / FINDING / FAIL lines
// A: the exact-bytes assertions, E: the probe experiments, X: the revision 10 experiments (X1-X9; X9 carries a letter a-e), H: the handoff smoke on the exact bytes (T6)
const ID_RE = /^[AEXH]\d{1,2}[a-z]?$/;
export const oneLine = (s, max = 300) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
export function formatLine(kind, router, id, detail) {
  if (!["PASS", "FINDING", "FAIL"].includes(kind)) throw new Error(`bad line kind ${kind}`);
  if (!["probe", "next"].includes(router)) throw new Error(`bad router ${router}`);
  if (!ID_RE.test(id)) throw new Error(`bad experiment id ${id}`);
  return `${kind} [${router}] ${id} ${oneLine(detail, 480)}`;     // 480: the X-experiments report several observed values on one line
}
export function parseLine(line) {
  const m = /^(PASS|FINDING|FAIL) \[(probe|next)\] ([AEXH]\d{1,2}[a-z]?) (.*)$/.exec(String(line));
  return m ? { kind: m[1], router: m[2], id: m[3], detail: m[4] } : null;
}
// probe run: each id present; A0 must PASS (the enricher gate; nothing after it means anything otherwise). X7 is REQUIRED (plan 12.2, the failure-path retry timer of router v2):
// its line must be present, and a timer that never fires is a FAIL line, which fails the run (evaluateRun reports every FAIL); an undecidable X7 (the module was not re-evaluated) is a FINDING.
// The other X-experiments and H1 are informational: present, FINDING-level when they deviate, never a FAIL. next run: these must PASS.
export const REQUIRED = {
  probe: { present: ["A0", "E4", "E5", "E7", "E12", "E13", "X1", "X2", "X3", "X4", "X5", "X7", "X8", "X9a", "X9b", "X9c", "X9d", "X9e"], pass: ["A0"] },
  next: { present: ["A0", "A1", "A2", "A8", "A11", "H1"], pass: ["A0", "A1", "A2", "A8", "A11"] },
};
/** lines: array of strings; routers: which runs were requested. ok = no FAIL line, every required id present, every must-pass id PASSed. */
export function evaluateRun(lines, routers) {
  const parsed = lines.map(parseLine).filter(Boolean);
  const problems = [];
  for (const r of routers) {
    const mine = parsed.filter((p) => p.router === r);
    for (const p of mine) if (p.kind === "FAIL") problems.push(`${r} ${p.id} FAILED: ${p.detail}`);
    for (const id of REQUIRED[r].present) if (!mine.some((p) => p.id === id)) problems.push(`${r} ${id} has no line`);
    for (const id of REQUIRED[r].pass) {
      const p = mine.find((x) => x.id === id);
      if (p && p.kind !== "PASS") problems.push(`${r} ${id} must PASS, got ${p.kind}`);
    }
  }
  return { ok: problems.length === 0, problems, counts: parsed.reduce((a, p) => { a[p.kind] = (a[p.kind] || 0) + 1; return a; }, {}) };
}

// ---------------------------------------------------------------- live-state fingerprint (sys is injected; see realSys in subagent-e2e.mjs)
const short = (v) => (typeof v === "string" && /^[0-9a-f]{40,}$/.test(v) ? v.slice(0, 12) : v);
const markerCount = (text) => (text == null ? -1 : (text.match(/ANTHROPIC_BASE_URL|apiKeyHelper/g) || []).length);
const baseUrlOf = (text) => { if (text == null) return "(absent)"; try { return JSON.parse(text)?.env?.ANTHROPIC_BASE_URL ?? null; } catch { return "(unparseable)"; } };

/** The live daemon's pid from the live service.json and NOTHING else from that file (its url carries a token). null: absent; "(unparseable)": torn. */
export function liveServicePid(sys) {
  const text = sys.readText(LIVE_SERVICE_JSON);
  try { return text == null ? null : Number(JSON.parse(text).pid) || null; } catch { return "(unparseable)"; }
}

/** The names the LIVE v2 router (G2) writes into state/subagent by design, so a new session or subagent changes them at any moment: its logs (decisions, classify, agents and their rotated .N generations, and the transient claim file `<log>.rot-<pid36>.jsonl` of those three logs only, which v3 rotation renames a log to before it numbers it), per-session
 *  main-<sid>.json and agents-<sid>.jsonl, status.json and status-<worker>.json, cooling.json, its atomic-write temp files (.tmp-<pid>s|a) and any .lock. The sandbox run is never judged on these. */
export const ROUTER_RUNTIME_RE = /^(agents(-[A-Za-z0-9_-]{1,64})?|decisions|classify)(\.\d+)?\.jsonl$|^(agents|decisions|classify)\.rot-[0-9a-z]+\.jsonl$|^main-[A-Za-z0-9_-]{1,64}\.json$|^status(-[0-9a-z]{1,13})?\.json$|^cooling\.json$|\.tmp-\d+[as]\d*$|\.lock$/;
/** Everything in state/subagent that is NOT router runtime (name:size, sorted): policy.json, shadow.flag and any other or unknown file. A new unknown file, or any size change here, is a difference. */
const stateSubagentOther = (sys) => (sys.listDir(LIVE_STATE_SUBAGENT) ?? ["(absent)"]).filter((e) => !ROUTER_RUNTIME_RE.test(String(e).replace(/:\d+$/, ""))).join("|");

/** A flat object of named values; diffFingerprint compares two of them. Never holds a secret: hashes, pids, names and sizes only. */
export function fingerprintLive(sys) {
  const settings = sys.readText(LIVE_SETTINGS);
  const svcPid = liveServicePid(sys);
  const fp = {
    settingsSha: sys.sha256File(LIVE_SETTINGS), settingsBaseUrl: baseUrlOf(settings), settingsMarkers: markerCount(settings),
    claudeSettingsNames: (sys.listDir(LIVE_CLAUDE_DIR) ?? []).filter((n) => /settings/i.test(n)).join("|"),
    liveServicePid: svcPid, liveServiceSha: sys.sha256File(LIVE_SERVICE_JSON),
    credTargetsSha: sys.credSha(), proxySha: sys.proxySha(), supervisor: sys.supervisorState(),   // user PATH, Downloads and Claude-3p are compared by the tripwire
    llmkeysListing: (sys.listDir(LIVE_LLMKEYS) ?? ["(absent)"]).join("|"),
    registrySha: sys.sha256File(path.join(LIVE_LLMKEYS, "registry.json")), ownerPolicySha: sys.sha256File(path.join(LIVE_LLMKEYS, "subagent-policy.json")),
    stateSubagentOther: stateSubagentOther(sys), policySha: sys.sha256File(path.join(LIVE_STATE_SUBAGENT, "policy.json")), shadowFlagSha: sys.sha256File(path.join(LIVE_STATE_SUBAGENT, "shadow.flag")), catalogListing: (sys.listDir(LIVE_CATALOG) ?? ["(absent)"]).join("|"),
  };
  for (const p of REAL_PORTS) fp[`listener:${p}`] = sys.listenerPid(p) ?? null;
  return fp;
}
export function diffFingerprint(before, after) {
  const out = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(`${k}: ${oneLine(short(String(before[k])), 60)} -> ${oneLine(short(String(after[k])), 60)}`);
  }
  return out;
}
/** The "before/after" block the acceptance asks for: settings hash, live service.json pid, listeners. */
export function describeFingerprint(fp) {
  const l = REAL_PORTS.map((p) => `${p}=${fp[`listener:${p}`] ?? "-"}`).join(" ");
  return `settings sha256 ${short(fp.settingsSha)} (ANTHROPIC_BASE_URL ${fp.settingsBaseUrl}, ${fp.settingsMarkers} markers); service.json pid ${fp.liveServicePid}; listener pids ${l}`;
}

// ---------------------------------------------------------------- the isolation proof
const DAEMON_RE = /claude-code-router/i;
/** Process rows {pid, ppid, name, cmd}: ccr/node processes that belong to the LIVE install = those present in the baseline. */
export const ccrPids = (rows) => rows.filter((r) => DAEMON_RE.test(String(r.cmd))).map((r) => r.pid).sort((a, b) => a - b);
export function descends(rows, pid, ancestor) {
  const by = new Map(rows.map((r) => [r.pid, r]));
  for (let i = 0, p = pid; i < 32 && by.has(p); i++) { p = by.get(p).ppid; if (p === ancestor) return true; }
  return false;
}
/** The daemon pid followed by every descendant in `rows` (any depth). A descendant behind a process the row filter drops (cmd.exe) is NOT found: the stray-process check then goes RED, which fails closed. */
export const treeOf = (rows, daemonPid) => [daemonPid, ...rows.filter((r) => r.pid !== daemonPid && descends(rows, r.pid, daemonPid)).map((r) => r.pid)];

/** The descendants of the daemon (not the daemon), DEEPEST FIRST: children before their parents, so no stop ever orphans a live child onto a parent the identity checks never judged. */
export function descendantsLeafFirst(rows, daemonPid) {
  const by = new Map(rows.map((r) => [r.pid, r]));
  const depthOf = (pid) => { let n = 0; for (let p = pid; n < 32 && p !== daemonPid && by.has(p); n++) p = by.get(p).ppid; return n; };
  return treeOf(rows, daemonPid).filter((p) => p !== daemonPid).map((pid, i) => ({ pid, i, d: depthOf(pid) })).sort((a, b) => b.d - a.d || a.i - b.i).map((x) => x.pid);
}

export function parseListenPorts(rows) {                         // rows: [{addr, port}] from Get-NetTCPConnection for one pid
  const bad_ = [], rec = [];
  for (const r of rows) {
    const loop = r.addr === "127.0.0.1" || r.addr === "::1";
    if (!loop) bad_.push(`${r.addr}:${r.port} is not loopback`);
    else if (REAL_PORTS.includes(r.port)) bad_.push(`${r.addr}:${r.port} is a LIVE port`);
    else if (r.port >= PORT_RANGE[0] && r.port <= PORT_RANGE[1]) rec.push(r.port);
    else if (r.port >= EPHEMERAL_MIN) rec.push(`${r.port}(ephemeral)`);
    else bad_.push(`${r.addr}:${r.port} is outside ${PORT_RANGE.join("-")}`);
  }
  return { bad: bad_, rec };
}

const takeoverTargets = (text) => {
  const files = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "settingsFile" && typeof x === "string") files.push(x); else walk(x); } };
  try { walk(JSON.parse(text)); } catch { return null; }
  return files;
};

/**
 * G1 attempt 3: CCR respawned its core worker during the probe run and a fetch of the sandbox web RPC inside the proof failed ("fetch failed") for a moment, which turned a whole run RED. A call
 * the proof makes to the sandbox web RPC is therefore retried, but ONLY for a transient NETWORK error (fetch failed, ECONNRESET, ECONNREFUSED, a timeout): at most PROOF_RETRY.attempts attempts,
 * PROOF_RETRY.gapMs apart, never past PROOF_RETRY.ceilingMs in all, and every attempt re-resolves the web port from service.json and re-verifies port and pid against the daemon the run started.
 * An isolation MISMATCH (wrong port, wrong pid, a config that is not isolated, a non-loopback listener, a refusal) is never retried and never softened: it is RED on the first attempt.
 */
export const PROOF_RETRY = { attempts: 5, gapMs: 1500, ceilingMs: 10000 };
const TRANSIENT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
export function isTransientNetError(e) {
  if (!e || e.mismatch === true || e instanceof RefusalError) return false;
  const msg = String(e.message ?? "");
  if (/ISOLATION VIOLATION|rpc refused|service\.json|REFUSED/.test(msg)) return false;
  if (e.name === "RpcTimeoutError" || e.name === "TimeoutError" || e.name === "AbortError") return true;
  if (TRANSIENT_CODES.has(e.code) || TRANSIENT_CODES.has(e.cause?.code)) return true;
  return /^fetch failed$|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|timed out/i.test(msg);
}
/** One line naming what went wrong underneath a transport error (error.cause.code / message, else the error itself). */
const causeOf = (e) => oneLine([e?.cause?.code ?? e?.code, e?.cause?.message ?? e?.message].filter(Boolean).join(" "), 140);

/**
 * ctx: {spec, baseline, phase: "pre-provider" | "post-provider", daemonPid, selfPid, stage, swapRan (true once the X9 Router.fallback swap step has started), track (an object shared by every proof of a run: the core worker pid is remembered in it)}
 * deps: {sys, tripwire, assertIsolatedInstance, assertIsolatedConfig, resolveWebPort, getConfig, assertRouterClean (the last two: the fresh-read Router.fallback check of the post-provider proof), sleep, now, redact (optional: the transient retry's timers and the redaction of its cause line)}
 * Returns {ok, checks:[{n, name, ok, detail, recorder?}]}. A check that throws is a failed check (the proof never throws).
 */
export async function proveIsolation(ctx, deps) {
  const { sys } = deps, checks = [];
  const add = async (name, fn) => {
    const n = checks.length + 1;
    try { const r = await fn(); checks.push({ n, name, ok: r.ok !== false, detail: oneLine(r.detail ?? ""), recorder: !!r.recorder }); }
    catch (e) { checks.push({ n, name, ok: false, detail: oneLine(`threw: ${e.message}`) }); }
  };
  const sleepMs = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), nowMs = deps.now ?? (() => Date.now()), redact = deps.redact ?? ((t) => t), held = {};
  /** The service.json of the daemon this run started, re-read at EVERY attempt: its port and pid must still be ours (a mismatch is final, not transient). */
  const liveWeb = () => {
    const w = deps.resolveWebPort();
    if (w.port !== ctx.spec.ports.web || w.pid !== ctx.daemonPid) throw Object.assign(new Error(`service.json says port ${w.port} pid ${w.pid}`), { mismatch: true });
    return w;
  };
  /** Runs fn (which calls the sandbox web RPC) with the bounded transient-network retry described at PROOF_RETRY. Returns {value, attempts, note}; a non-transient error propagates at once, with the attempt count of 1. */
  const net = async (fn) => {
    const t0 = nowMs();
    for (let attempt = 1; ; attempt++) {
      try { const value = await fn(); return { value, attempts: attempt, note: attempt > 1 ? `; reached on attempt ${attempt} of ${PROOF_RETRY.attempts} after a transient network error` : "" }; }
      catch (e) {
        if (!isTransientNetError(e)) throw e;
        const waited = nowMs() - t0;
        if (attempt >= PROOF_RETRY.attempts || waited + PROOF_RETRY.gapMs > PROOF_RETRY.ceilingMs) {
          throw new Error(redact(`${causeOf(e)}: still failing after ${attempt} attempt${attempt === 1 ? "" : "s"} over ${waited} ms (transient network errors only; an isolation mismatch is never retried)`));
        }
        await sleepMs(PROOF_RETRY.gapMs);
      }
    }
  };
  const now = fingerprintLive(sys);
  const { ccrPids: _baseCcr, ...baseFp } = ctx.baseline;      // the process list is compared by its own check below
  const diff = diffFingerprint(baseFp, now);
  await add("live listeners 3456/3457/3458/4517 owned by the same pids as before", () => {
    const d = diff.filter((x) => x.startsWith("listener:"));
    return { ok: d.length === 0, detail: d.length ? d.join("; ") : REAL_PORTS.map((p) => `${p}=${now[`listener:${p}`] ?? "-"}`).join(" ") };
  });
  await add("live settings.json, service.json, credentials, PATH, ~/.llmkeys, state/subagent (policy.json, shadow.flag and non-runtime files; the live router's own runtime files are ignored), catalog, Downloads, Claude-3p unchanged", () => {
    const d = diff.filter((x) => !x.startsWith("listener:"));
    return { ok: d.length === 0, detail: d.length ? d.join("; ") : "no change" };
  });
  await add("process table: live CCR set unchanged, every new CCR process descends from the sandbox daemon", () => {
    const rows = sys.processes();
    const baseSet = new Set(ctx.baseline.ccrPids ?? []);
    const nowPids = ccrPids(rows);
    const gone = [...baseSet].filter((p) => !nowPids.includes(p));
    const stray = nowPids.filter((p) => !baseSet.has(p) && p !== ctx.daemonPid && !(ctx.daemonPid && descends(rows, p, ctx.daemonPid)));
    return { ok: gone.length === 0 && stray.length === 0, detail: `live ccr pids ${[...baseSet].join(",") || "-"}; gone=${gone.join(",") || "-"} stray=${stray.join(",") || "-"}` };
  });
  await add("tripwire over live state (settings, Claude-3p, Downloads, user PATH)", () => { deps.tripwire.assert(ctx.stage || ctx.phase); return { detail: "unchanged" }; });
  const tree = ctx.daemonPid ? treeOf(sys.processes(), ctx.daemonPid) : [];
  if (ctx.daemonPid) {
    // Live evidence (2026-10-03): the daemon holds the gateway and the web port, its CHILD (gateway-bootstrap.js) holds the core port. So the ports are
    // judged against the whole daemon process tree, and EVERY member's listeners are scanned, not just the daemon's.
    await add("sandbox ports held by the sandbox daemon's process tree (stub by the orchestrator); every listener of every tree process is loopback, in range and not live", () => {
      const inTree = (pid) => tree.includes(pid);
      const problems = [], pre = ctx.phase === "pre-provider";
      for (const name of pre ? ["web"] : ["gateway", "core", "web"]) {
        const got = sys.listenerPid(ctx.spec.ports[name]);
        held[name] = got;
        if (!inTree(got)) problems.push(`${name} ${ctx.spec.ports[name]} held by ${got ?? "nobody"}, expected one of the sandbox daemon tree ${tree.join(",")}`);
      }
      if (pre) for (const name of ["gateway", "core"]) { const got = sys.listenerPid(ctx.spec.ports[name]); if (got && !inTree(got)) problems.push(`${name} ${ctx.spec.ports[name]} is held by ${got}, not the sandbox daemon tree`); }
      else { const got = sys.listenerPid(ctx.spec.ports.stub); if (got !== ctx.selfPid) problems.push(`stub ${ctx.spec.ports.stub} held by ${got ?? "nobody"}, expected the orchestrator ${ctx.selfPid}`); }
      const seen = [];
      for (const pid of tree) {
        const lp = parseListenPorts(sys.listenPortsOf(pid));
        problems.push(...lp.bad.map((b) => `pid ${pid}: ${b}`));
        seen.push(`${pid}:${lp.rec.join("+") || "-"}`);
      }
      return { ok: problems.length === 0, detail: problems.length ? problems.join("; ") : `sandbox tree listens on ${seen.join(" ")}` };
    });
    await add("daemon web port and token (service.json) are ours, daemon paths are under the scratch CONFIGDIR", async () => {
      let w;
      const r = await net(async () => { w = liveWeb(); await deps.assertIsolatedInstance(); });
      return { detail: `web ${w.port} pid ${w.pid}${r.note}` };
    });
    await add("persisted config isolated (ports, HOST, PORT, settingsFile, profiles)", async () => { const r = await net(async () => { liveWeb(); await deps.assertIsolatedConfig(); }); return { detail: `ok${r.note}` }; });
    // F2: saveConfig's return value is the daemon's normalised ECHO, not a read of what it persisted, and assertIsolatedConfig does not look at Router.fallback: a leftover model-chain or retry
    // would pass every check above. So once providers are saved (post-provider, which needs a deps.getConfig seam) a FRESH getConfig must pass assertRouterClean (mode off, no chain models, no
    // enabled rules, no availableModels allowlist). A Router.fallback that is ABSENT is reported, not judged, until the swap step has run (assertRouterClean itself refuses a missing fallback as
    // mode "undefined", and the configure step already ran it on the first getConfig); after the swap step the restore wrote an explicit fallback, so an absent one is RED.
    if (deps.getConfig && ctx.phase === "post-provider") {
      await add("persisted Router.fallback read back on a FRESH getConfig (mode off, no chain models, no enabled rules)", async () => {
        const got = await net(async () => { liveWeb(); return deps.getConfig(); }), c = got.value, fb = c?.Router?.fallback;
        if (fb == null || typeof fb !== "object") {
          if (ctx.swapRan) return { ok: false, detail: "Router.fallback is ABSENT after the swap step: the restore wrote an explicit off, so it must read back" };
          return { detail: "Router.fallback is absent in the fresh config (recorded, not judged before the swap step: assertRouterClean refuses a missing fallback, and the configure step already ran it)", recorder: true };
        }
        deps.assertRouterClean(c);
        return { detail: `mode ${oneLine(fb.mode, 20)}, ${(fb.models ?? []).length} chain models, swap step ${ctx.swapRan ? "has run" : "not yet run"}${got.note}` };
      });
    }
  }
  await add("global-profile-takeover.json never points at a settings file other than the scratch one", () => {
    const text = sys.readText(TAKEOVER_FILE);
    if (text == null) return { detail: "file absent (recorded)", recorder: true };
    const files = takeoverTargets(text);
    if (files === null) return { ok: false, detail: "takeover file is unparseable" };
    const offenders = files.filter((f) => norm(f.replace(/^~/, HOME)) !== norm(SCRATCH_SETTINGS));
    return { ok: offenders.length === 0, detail: offenders.length ? `settingsFile ${offenders.map((o) => oneLine(o, 80)).join(" | ")}` : `${files.length} settingsFile entries, all scratch` };
  });
  if (ctx.spec.preloadGuard) {
    await add("guard loaded in the daemon pid and in every node process of its tree, and violations.log is empty", () => {
      const rows = sys.processes();
      const loaded = (sys.readText(GUARD_LOADED_LOG) ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l).pid; } catch { return null; } });
      const viol = (sys.readText(VIOLATIONS_LOG) ?? "").split("\n").filter(Boolean).length;
      const need = tree.filter((pid) => { const r = rows.find((x) => x.pid === pid); return !r || /^node(\.exe)?$/i.test(String(r.name)); });
      const missing = need.filter((pid) => !loaded.includes(pid));
      return { ok: missing.length === 0 && viol === 0, detail: `guard loaded in pids ${[...new Set(loaded)].join(",") || "none"}; missing from the tree ${missing.join(",") || "-"}; violations ${viol}` };
    });
  }
  // RECORD (never a failure): CCR may respawn its core worker (the daemon's child that holds the core port) during a run, for instance around the Router.fallback swaps. The pid it held at the
  // previous post-provider proof is remembered in ctx.track; a change is reported with the gateway and daemon pids, which the checks above still judge.
  if (ctx.track && ctx.daemonPid && ctx.phase === "post-provider" && held.core != null) {
    const t = ctx.track;
    if (t.core != null && t.core !== held.core) {
      await add("sandbox core worker pid changed since the previous proof (record)", () => ({ recorder: true, detail: `sandbox core worker pid changed ${t.core} -> ${held.core} during the run; gateway pid ${t.gateway === held.gateway ? `unchanged (${held.gateway})` : `CHANGED ${t.gateway ?? "?"} -> ${held.gateway ?? "?"}`}, daemon pid ${ctx.daemonPid} unchanged (service.json check)` }));
    }
    t.core = held.core; t.gateway = held.gateway;
  }
  return { ok: checks.every((c) => c.ok), checks };
}
export function assertIsolationProven(result) {
  if (!result.ok) bad(`isolation NOT proven: ${result.checks.filter((c) => !c.ok).map((c) => `#${c.n} ${c.name} :: ${c.detail}`).join(" || ")}`);
  return result;
}
export const baselineOf = (sys) => ({ ...fingerprintLive(sys), ccrPids: ccrPids(sys.processes()) });
export const isSettingsPathLive = (p) => norm(String(p).replace(/^~/, HOME)) === norm(LIVE_SETTINGS);

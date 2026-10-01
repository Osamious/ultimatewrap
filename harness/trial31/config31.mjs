// CCR 3.1.1 sandbox trial: constants, the forced environment, and the launch spec.
// Independent of harness/config.mjs (which encodes 3.0.22 assumptions: DB-config
// gateway ports). Every knob is force-set on the command line and in the env each
// launch, and asserted by assertLaunchSpec() before anything starts: "set" is
// verified, not remembered. NOTHING here starts a process.

import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// Sandbox root lives OUTSIDE the repo (plan 4.1 said harness\scratch31; that path
// is inside the repo and not gitignored, and the install must not land there).
export const TRIAL_ROOT = "C:\\Users\\osami\\.uw-scratch31";
export const INSTALL_DIR = path.join(TRIAL_ROOT, "npm");
export const NPM_CACHE = path.join(TRIAL_ROOT, "npm-cache");
export const HOME = path.join(TRIAL_ROOT, "home");
export const ROAMING = path.join(TRIAL_ROOT, "roaming");
export const LOCAL = path.join(TRIAL_ROOT, "local");
export const TMP = path.join(TRIAL_ROOT, "tmp");
export const BACKUP = path.join(TRIAL_ROOT, "backup");
export const RUN_DIR = path.join(TRIAL_ROOT, "run");
export const EXTENSIONS_DIR = path.join(TRIAL_ROOT, "extensions");
export const BOT_STATE_DIR = path.join(TRIAL_ROOT, "bot-state");
export const CCR_CONFIG_DIR = path.join(ROAMING, "claude-code-router");
export const SERVICE_JSON = path.join(CCR_CONFIG_DIR, "service.json");
export const VIOLATIONS_LOG = path.join(TRIAL_ROOT, "violations.log");
export const GUARD_LOADED_LOG = path.join(TRIAL_ROOT, "guard-loaded.log");
export const TRIPWIRE_BASELINE = path.join(RUN_DIR, "tripwire-baseline.json"); // hashes only, never contents
export const HKCU_PATH_BACKUP = path.join(BACKUP, "hkcu-path.json");
export const SETTINGS_BACKUP = path.join(BACKUP, "settings.json.pre-trial31");
export const CLI_JS = path.join(INSTALL_DIR, "node_modules", "@musistudio", "claude-code-router", "dist", "main", "cli.js");
export const INSTALL_ROUTER_PKG = path.join(INSTALL_DIR, "node_modules", "@musistudio", "claude-code-router", "package.json");
export const INSTALL_GATEWAY_PKG = path.join(INSTALL_DIR, "node_modules", "@the-next-ai", "ai-gateway", "package.json");
export const SQLITE_BINDING = path.join(INSTALL_DIR, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");

// The real (live) state that must never change. Literals, not os.homedir(): a
// shell whose USERPROFILE was redirected must not be able to poison these.
export const REAL_HOME = "C:\\Users\\osami";
export const REAL_APPDATA = path.join(REAL_HOME, "AppData", "Roaming");
export const REAL_LOCALAPPDATA = path.join(REAL_HOME, "AppData", "Local");
export const REAL_GLOBAL_CCR = "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router";
export const REAL_SETTINGS = path.join(REAL_HOME, ".claude", "settings.json");
export const REAL_SETTINGS_LOCAL = path.join(REAL_HOME, ".claude", "settings.local.json");
export const REAL_CODEX_TOML = path.join(REAL_HOME, ".codex", "config.toml");
export const REAL_CCR_DIR = path.join(REAL_APPDATA, "claude-code-router");
export const REAL_CLAUDE_3P = path.join(REAL_LOCALAPPDATA, "Claude-3p");
export const REAL_DOWNLOADS = path.join(REAL_HOME, "Downloads");

// What 3.1.1's Claude-desktop sync writes under Claude-3p (read from dist/main/cli.js: kOe/Ly/jl/Ec/RQ).
// Ly(dataDir) yields exactly these three files, plus the configLibrary directory that jl() mkdirs first.
// The tripwire watches ONLY these. The rest of Claude-3p (logs, Cache, sentry, Network, GPU caches, ...) is the
// running Claude desktop app's own churn and is deliberately not watched (see tripwire31.mjs and the census).
export const CLAUDE_3P_ROOT_CONFIG = "claude_desktop_config.json";   // mOe: rootConfigFile, gets deploymentMode:"3p"
export const CLAUDE_3P_LIBRARY_DIR = "configLibrary";                // hOe: libraryDir
export const CLAUDE_3P_META = "_meta.json";                           // yOe: metaFile, gets appliedId + entries
export const CLAUDE_3P_LIBRARY_ID = "8f69f2f1-3275-4ad8-9317-4aa7e972f311"; // Ny: configLibraryFile is <libraryDir>\<id>.json

// Everything the guard refuses to write under, by name (for a clear violation
// reason). The guard ALSO denies every write outside TRIAL_ROOT.
export const PROTECTED_ROOTS = [
  path.join(REAL_HOME, ".claude"), path.join(REAL_HOME, ".claude.json"), path.join(REAL_HOME, ".codex"),
  path.join(REAL_HOME, ".claude-code-router"), path.join(REAL_HOME, ".config"), path.join(REAL_HOME, "Downloads"),
  path.join(REAL_HOME, "Documents"), path.join(REAL_HOME, "Desktop"), path.join(REAL_HOME, ".uw"),
  path.join(REAL_HOME, ".bashrc"), path.join(REAL_HOME, ".bash_profile"), path.join(REAL_HOME, ".profile"),
  path.join(REAL_HOME, ".zshrc"),
  REAL_CCR_DIR, path.join(REAL_APPDATA, "Claude Code Router"), path.join(REAL_APPDATA, "Claude"),
  REAL_CLAUDE_3P, path.join(REAL_LOCALAPPDATA, "Claude"), "C:\\nvm4w",
];

// Ports. The real ones must never be touched; the trial range is loopback-only.
export const REAL_PORTS = [3456, 3457, 3458, 4517];
export const PORT_RANGE = [39456, 39489];
export const WEB_PORT = 39468;      // management server (CCR scans up to 20 ports forward on EADDRINUSE)
export const GATEWAY_PORT = 39466;  // used only in stage 2 (config PORT + gateway.port; see census: corePort derives from PORT)
export const GATEWAY_CORE_PORT = 39467;
export const STUB_PORT = 39470;
export const LOOPBACK = "127.0.0.1";

// Per-run random credentials (never repo constants). They live in memory and in the
// child's env only; the proof compares service.json against them, never prints them.
export function newRunTokens() {
  return { web: crypto.randomBytes(24).toString("hex"), service: crypto.randomBytes(24).toString("hex") };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRELOAD_FILE = path.join(HERE, "preload-guard.cjs");
// Quoted: NODE_OPTIONS is re-parsed by node, and a path with a space would otherwise split.
export const PRELOAD_ARG = `--require "${PRELOAD_FILE.replace(/\\/g, "/")}"`;

// ---- Windows system tools: ABSOLUTE paths only. A bare "whoami" under Git Bash resolves Git's usr\bin\whoami (which
// rejects Windows flags); PATH order must never decide what the harness runs. Pure: nothing here starts a process.
const SYSTEM_TOOL_PARTS = {
  whoami: ["System32", "whoami.exe"], icacls: ["System32", "icacls.exe"], reg: ["System32", "reg.exe"],
  taskkill: ["System32", "taskkill.exe"], netstat: ["System32", "NETSTAT.EXE"], where: ["System32", "where.exe"],
  certutil: ["System32", "certutil.exe"], powershell: ["System32", "WindowsPowerShell", "v1.0", "powershell.exe"],
};
export const SYSTEM_TOOL_NAMES = Object.keys(SYSTEM_TOOL_PARTS);

/** %SystemRoot% from SystemRoot/windir (any key case; a plain object in tests), only when drive-absolute; else C:\Windows. */
export function systemRoot(env = process.env) {
  for (const want of ["systemroot", "windir"]) {
    const k = Object.keys(env).find((x) => x.toLowerCase() === want);
    const v = k ? String(env[k]).trim().replace(/^"+|"+$/g, "") : "";
    if (/^[A-Za-z]:[\\/]/.test(v)) return path.win32.normalize(v).replace(/\\+$/, "");
  }
  return "C:\\Windows";
}

/** Absolute path of a Windows tool under %SystemRoot%\System32 (powershell under WindowsPowerShell\v1.0). Never PATH-resolved. */
export function systemTool(name, env = process.env) {
  const parts = SYSTEM_TOOL_PARTS[String(name).toLowerCase().replace(/\.exe$/, "")];
  if (!parts) throw new Error(`unknown system tool ${name}`);
  return path.win32.join(systemRoot(env), ...parts);
}

/** Dotted-version compare with zero padding: "1.0" is NOT >= "1.0.21"; "1.0.21" >= "1.0.21"; "1.1" >= "1.0.21". */
export function versionGte(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

// Parent-env keys the daemon may inherit. Everything else (proxy vars, API keys,
// CLAUDE_*, ANTHROPIC_*, CCR_*, npm_*) is dropped rather than filtered by name.
const INHERIT = [
  "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "PATH", "Path", "OS", "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS", "COMPUTERNAME", "USERNAME", "USERDOMAIN", "ProgramFiles", "ProgramFiles(x86)",
  "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "ProgramData",
  "ALLUSERSPROFILE", "PUBLIC",
];
const SECRET_KEYS = new Set(["CCR_WEB_AUTH_TOKEN", "CCR_SERVICE_INSTANCE_TOKEN"]);

/** The full, forced environment for the sandbox daemon. `CCR_GATEWAY_CONFIG_TIMEOUT_MS` is deliberately absent (default-behaviour run). */
export function buildEnv(parentEnv = process.env, tokens = newRunTokens()) {
  const env = {};
  for (const k of INHERIT) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
  const drive = TRIAL_ROOT.slice(0, 2);
  Object.assign(env, {
    USERPROFILE: HOME, HOME, HOMEDRIVE: drive, HOMEPATH: HOME.slice(2),
    APPDATA: ROAMING, LOCALAPPDATA: LOCAL, TEMP: TMP, TMP,
    XDG_CONFIG_HOME: path.join(HOME, ".config"),
    CODEX_HOME: path.join(HOME, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(HOME, ".claude"),
    CCR_INTERNAL_HOME_DIR: HOME,
    CCR_INTERNAL_APP_DATA_DIR: ROAMING,
    CCR_INTERNAL_USER_DATA_DIR: CCR_CONFIG_DIR,
    CCR_CONFIG_DIR,
    CCR_EXTENSIONS_DIR: EXTENSIONS_DIR,
    CCR_BOT_GATEWAY_STATE_DIR: BOT_STATE_DIR,
    CCR_WEB_HOST: LOOPBACK,
    CCR_WEB_PORT: String(WEB_PORT),
    HOST: LOOPBACK,               // the gateway's generic HOST/PORT fallbacks, forced to trial values
    PORT: String(GATEWAY_PORT),
    CCR_WEB_AUTH_TOKEN: tokens.web,
    CCR_SERVICE_INSTANCE_TOKEN: tokens.service,
    NODE_OPTIONS: PRELOAD_ARG,
    UW_TRIAL31_PRELOAD_ARG: PRELOAD_ARG,
    UW_TRIAL31_ROOT: TRIAL_ROOT,
    UW_TRIAL31_PORT_RANGE: PORT_RANGE.join("-"),
    UW_TRIAL31_REAL_PORTS: REAL_PORTS.join(","),
    UW_TRIAL31_PROTECTED: PROTECTED_ROOTS.join(";"),
  });
  return env;
}

/** Env with the token values masked, safe to print. */
export function printableEnv(env) {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_KEYS.has(k) ? "***" : v]));
}

/**
 * The command that starts the sandbox management server. `serve --daemon-child
 * --no-gateway`: foreground child we own (single pid), writes service.json into the
 * sandbox CONFIGDIR, binds ONLY the web port (`--no-gateway` skips the gateway, whose
 * default ports are the live 3456/3457). `ccr start` is never used.
 */
export function launchSpec(parentEnv = process.env, tokens = newRunTokens()) {
  return {
    command: process.execPath,
    args: [CLI_JS, "serve", "--daemon-child", "--no-open", "--no-gateway", "--host", LOOPBACK, "--port", String(WEB_PORT)],
    env: buildEnv(parentEnv, tokens),
    tokens,
    cwd: RUN_DIR,
    stdoutFile: path.join(RUN_DIR, "daemon.out.log"),
    stderrFile: path.join(RUN_DIR, "daemon.err.log"),
  };
}

const under = (p, root) => {
  const a = path.resolve(p).toLowerCase(), r = path.resolve(root).toLowerCase();
  return a === r || a.startsWith(r + "\\");
};

/** Throws unless the spec cannot reach live state or live ports. Run before every launch. */
export function assertLaunchSpec(spec) {
  const bad = (m) => { throw new Error(`trial31 launch spec rejected: ${m}`); };
  const { args, env } = spec;
  if (!under(args[0], INSTALL_DIR)) bad(`CLI ${args[0]} is not inside the sandbox install ${INSTALL_DIR} (never the global ccr)`);
  if (args[1] !== "serve") bad(`subcommand must be "serve", got ${args[1]}`);
  if (!args.includes("--no-gateway")) bad("--no-gateway missing (default gateway ports are the live 3456/3457)");
  if (!args.includes("--no-open")) bad("--no-open missing");
  const pi = args.indexOf("--port");
  const port = Number(args[pi + 1]);
  if (pi < 0 || !Number.isInteger(port)) bad("--port missing");
  const hi = args.indexOf("--host");
  if (hi < 0 || args[hi + 1] !== LOOPBACK) bad("--host must be 127.0.0.1");
  const inRange = (p) => p >= PORT_RANGE[0] && p <= PORT_RANGE[1];
  if (!inRange(port) || REAL_PORTS.includes(port)) bad(`web port ${port} outside trial range or live`);
  if (env.CCR_WEB_PORT !== String(port)) bad(`CCR_WEB_PORT ${env.CCR_WEB_PORT} != --port ${port} (both must be forced and equal)`);
  if (env.CCR_WEB_HOST !== LOOPBACK) bad("CCR_WEB_HOST must be 127.0.0.1");
  for (const k of ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR",
    "CCR_INTERNAL_HOME_DIR", "CCR_INTERNAL_APP_DATA_DIR", "CCR_INTERNAL_USER_DATA_DIR", "CCR_CONFIG_DIR", "CCR_EXTENSIONS_DIR", "CCR_BOT_GATEWAY_STATE_DIR"]) {
    if (!env[k] || !under(env[k], TRIAL_ROOT)) bad(`${k}=${env[k]} is not under ${TRIAL_ROOT}`);
  }
  if (env.NODE_OPTIONS !== PRELOAD_ARG) bad("NODE_OPTIONS is not exactly the guard preload");
  if (env.HOST !== LOOPBACK) bad("HOST must be forced to 127.0.0.1");
  const envPort = Number(env.PORT);
  if (!Number.isInteger(envPort) || !inRange(envPort) || REAL_PORTS.includes(envPort)) bad(`PORT ${env.PORT} must be forced to a trial-range, non-live port`);
  if (env.CCR_GATEWAY_CONFIG_TIMEOUT_MS !== undefined) bad("CCR_GATEWAY_CONFIG_TIMEOUT_MS must be unset for the default-behaviour run");
  for (const k of Object.keys(env)) {
    if (/proxy/i.test(k) && k !== "UW_TRIAL31_PRELOAD_ARG") bad(`proxy variable ${k} must not be inherited`);
  }
  const tokenOk = (t) => typeof t === "string" && /^[0-9a-f]{32,}$/.test(t);
  if (!tokenOk(env.CCR_WEB_AUTH_TOKEN) || !tokenOk(env.CCR_SERVICE_INSTANCE_TOKEN)) bad("web/service tokens must be per-run random hex");
  if (env.CCR_WEB_AUTH_TOKEN === env.CCR_SERVICE_INSTANCE_TOKEN) bad("web and service tokens must differ");
  if (spec.tokens && (spec.tokens.web !== env.CCR_WEB_AUTH_TOKEN || spec.tokens.service !== env.CCR_SERVICE_INSTANCE_TOKEN)) bad("spec.tokens disagree with the env");
  return spec;
}

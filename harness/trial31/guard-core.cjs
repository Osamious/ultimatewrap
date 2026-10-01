'use strict';
// CCR 3.1.1 trial: process-level guard policy + installer. CommonJS so the same
// file serves as the NODE_OPTIONS preload's engine (preload-guard.cjs) and as a
// unit-testable module (install() takes the modules to patch as arguments, so
// tests drive it with fakes and never touch the real fs/net/registry).
//
// Fail-closed by construction: a violation LOGS and THROWS. The daemon dying is
// an acceptable outcome; a write reaching live state is not. This whole file is
// DEFENCE IN DEPTH, not a sandbox: a native addon opening a path it was handed
// (better-sqlite3 is wrapped below; others are not), process.binding, and any
// code that reaches an un-hooked API can still act. The tripwire and the
// isolation proof are the backstop; residual gaps are listed in
// plans/ccr-3.1.1-census.md.

const nodePath = require('node:path');
const nodeUtil = require('node:util');
const { redactSecrets } = require('./redact31.cjs');

class TrialViolation extends Error {
  constructor(kind, detail) {
    super(`UW_TRIAL31 violation [${kind}]: ${detail}`);
    this.name = 'TrialViolation';
    this.code = 'UW_TRIAL31_VIOLATION';
    this.kind = kind;
  }
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
function isLoopbackHost(h) {
  if (h == null) return false;
  const s = String(h).trim().toLowerCase().replace(/^\[|\]$/g, '');
  return s === 'localhost' || s === '::1' || s === '0:0:0:0:0:0:0:1' ||
    LOOPBACK_V4.test(s) || /^::ffff:127\./.test(s);
}

function normalizeForCompare(p) {
  let s = String(p).replace(/\//g, '\\');
  if (s.startsWith('\\\\?\\') && !s.startsWith('\\\\?\\UNC\\')) s = s.slice(4);
  return s.replace(/\\+$/, '').toLowerCase();
}
function isUnder(child, root) {
  const c = normalizeForCompare(child), r = normalizeForCompare(root);
  return c === r || c.startsWith(r + '\\');
}

function normListen(args) {
  const a = args[0];
  if (a !== null && typeof a === 'object') return a;
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  if (typeof a === 'string') return { path: a };
  return { port: 0 };
}
function normConnect(args) {
  // net.connect()/tls.connect() hand Socket#connect an already-normalized [options, cb] array.
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (a !== null && typeof a === 'object') return a;
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  if (typeof a === 'string') return { path: a };
  return {};
}
function normBind(args) {
  // dgram bind(port[, address][, cb]) | bind(options[, cb]); no port = all interfaces, random port
  const a = args[0];
  if (a !== null && typeof a === 'object') return { port: a.port ?? 0, host: a.address, fd: a.fd };
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return { port: Number(a), host: typeof args[1] === 'string' ? args[1] : undefined };
  }
  return { port: 0, host: undefined };
}
/** dgram send(msg[, offset, length][, port][, address][, cb]) -> {host, port} or undefined for a connected-socket send. */
function dgramSendTarget(args) {
  const rest = args.slice(1).filter((a) => typeof a !== 'function');
  const nums = rest.filter((a) => typeof a === 'number');
  const addr = rest.find((a) => typeof a === 'string');
  let port;
  if (nums.length >= 3) port = nums[2];
  else if (nums.length === 1) port = nums[0];
  else if (addr !== undefined && nums.length) port = nums[nums.length - 1];
  if (port === undefined) return undefined;
  return { host: addr, port };
}
const PIPE_RE = /^\\\\[.?]\\pipe\\/i;

// cmd/explorer/rundll32 are denied by default (fail-closed): CCR only uses them for
// agent launch / reveal-in-explorer / open-URL, unreachable at gate G2.
const DENY_BASENAMES = new Set(['setx', 'regedit', 'schtasks', 'bcdedit', 'icacls', 'takeown', 'cacls', 'sc', 'cmd', 'explorer', 'rundll32']);
const DENY_CMDLINE = [
  /\bsetx(?:\.exe)?["']?\s/i,
  /\breg(?:\.exe)?["']?\s+(?:add|delete|import|copy|save|restore|load|unload)\b/i,
  /(?:Set|New|Remove|Rename|Copy|Move|Clear)-ItemProperty/i,
  /(?:New|Remove)-Item\b[^|;\n]*HK/i,
  /SetEnvironmentVariable/i,
  /\.SetValue\(|CreateSubKey|DeleteValue|DeleteSubKey/i,
  /SendMessageTimeout|InternetSetOption|Set-ExecutionPolicy/i,
  /\bschtasks\b|\bregedit\b/i,
  /\b(?:Invoke-Expression|iex)\b/i,
  /\bStop-Process\b/i,
  /(?:^|[\s&|;("'\\/])(?:cmd|explorer|rundll32)(?:\.exe)?(?=$|[\s"'&|;)])/i,
];

function baseName(file) {
  return String(file).split(/[\\/]/).pop().replace(/["']/g, '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();
}

// PowerShell switches that take a separate value token (full names and the usual abbreviations). Needed so that
// `-ExecutionPolicy Bypass` does not read `Bypass` as the start of an implicit script body.
const PS_VALUE_SWITCHES = ['executionpolicy', 'windowstyle', 'inputformat', 'outputformat', 'configurationname', 'version',
  'psconsolefile', 'workingdirectory', 'settingsfile', 'custompipename'];
const PS_VALUE_ALIASES = new Set(['ep', 'w', 'in', 'i', 'o', 'of', 'config', 'v', 'psc', 'wd', 'wo']);
const psTakesValue = (name) => PS_VALUE_ALIASES.has(name) || (name.length >= 2 && PS_VALUE_SWITCHES.some((f) => f.startsWith(name)));

/**
 * PowerShell switches that run code the deny patterns cannot see: -EncodedCommand/-e/-ec, -File/-f, `-Command -`
 * (stdin script) and a bare `-`. `args` are the arguments AFTER the powershell executable, already tokenised.
 * Parsed structurally, the way PowerShell parses them: switches come first; the first `-Command`/`-c` (or the first
 * positional token, an implicit -Command) starts the script BODY, and everything after it is opaque text, so a
 * `-File` inside a `Get-ChildItem ... -File -Recurse` body is not a switch. The body is still scanned by the
 * DENY_CMDLINE patterns in checkSpawn (SetEnvironmentVariable, Set-ItemProperty HK*, Stop-Process, iex, ...).
 */
function powershellEscapeHatch(args) {
  for (let i = 0; i < args.length; i++) {
    if (/^["']?-["']?$/.test(args[i])) return '- (stdin script)';
    const m = /^["']?[-/]([a-z]+)["']?(:[\s\S]*)?$/i.exec(args[i]);
    if (!m) return undefined; // positional token: an implicit -Command; the script body starts here and is opaque
    const name = m[1].toLowerCase();
    if (name === 'ec' || 'encodedcommand'.startsWith(name)) return `-${m[1]} (encoded command)`;
    if ('file'.startsWith(name)) return `-${m[1]} (script file)`;
    if ('command'.startsWith(name)) {
      const first = m[2] !== undefined ? m[2].slice(1) : args[i + 1];
      return /^["']?-["']?$/.test(first || '') ? '-Command - (stdin script)' : undefined; // rest of argv is the opaque body
    }
    // a value-taking switch consumes the next token, unless that token is itself switch-shaped (then it is judged as a switch: fail closed)
    if (m[2] === undefined && psTakesValue(name) && !/^["']?[-/][a-z]/i.test(args[i + 1] || '')) i++;
  }
  return undefined;
}

/** The old whole-line scan, kept ONLY as a fail-closed fallback when a command line mentions powershell but no token is the executable. */
function powershellEscapeHatchAnywhere(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const m = /^["']?[-/]([a-z]+)["']?$/i.exec(tokens[i]);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (name === 'ec' || 'encodedcommand'.startsWith(name)) return `-${m[1]} (encoded command)`;
    if ('file'.startsWith(name)) return `-${m[1]} (script file)`;
    if ('command'.startsWith(name) && /^["']?-["']?$/.test(tokens[i + 1] || '')) return '-Command - (stdin script)';
  }
  return undefined;
}

/** Quotes-aware split of a command line: whitespace separates, double quotes group (dropped), `\"` is a literal quote. */
function tokenizeCmdline(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  let has = false;
  const s = String(line ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '"') { cur += '"'; has = true; i++; continue; }
    if (ch === '"') { inQ = !inQ; has = true; continue; }
    if (!inQ && /\s/.test(ch)) { if (has) { out.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) out.push(cur);
  return out;
}

const isPowershellExe = (tok) => { const b = baseName(tok); return b === 'powershell' || b === 'pwsh'; };

/** Escape-hatch verdict for a spawn: argv form parses the argv; command-line form tokenises quotes-aware, then applies the same rule. */
function powershellHatchForSpawn(base, argv, isCmdline, cmdline) {
  if (!isCmdline && (base === 'powershell' || base === 'pwsh')) return powershellEscapeHatch(argv);
  const tokens = tokenizeCmdline(cmdline);
  const idx = tokens.findIndex(isPowershellExe);
  if (idx >= 0) return powershellEscapeHatch(tokens.slice(idx + 1));
  return powershellEscapeHatchAnywhere(cmdline.split(/\s+/)); // mentioned but not an executable token: stay strict
}

/** Pure policy over a config; no side effects. */
function createPolicy(cfg) {
  const protectedRoots = cfg.protectedRoots || [];
  const allowWriteRoots = [cfg.root, ...(cfg.allowWriteRoots || [])].filter(Boolean);
  const { min, max } = cfg.portRange;
  const realPorts = new Set((cfg.realPorts || []).map(Number));
  // Tracked pids: our own pid plus children we spawned. A child is removed on 'exit'
  // (see install()), so a recycled pid is not silently trusted afterwards; a kill of a
  // tracked-but-recycled pid inside the tiny window before 'exit' is delivered remains
  // possible (documented weakness).
  const tracked = new Set([cfg.pid]);
  const realpath = cfg.realpath || ((p) => p);

  function canonical(p) {
    const abs = nodePath.resolve(String(p));
    // realpath the deepest existing ancestor so a junction/symlink into a
    // protected root is judged by its target, not by its spelling.
    let tail = '';
    let cur = abs;
    for (let i = 0; i < 64; i++) {
      let real;
      try { real = realpath(cur); } catch { real = undefined; }
      if (real) return tail ? nodePath.join(real, tail) : real;
      const parent = nodePath.dirname(cur);
      if (parent === cur) break;
      tail = tail ? nodePath.join(nodePath.basename(cur), tail) : nodePath.basename(cur);
      cur = parent;
    }
    return abs;
  }

  function checkListen(o) {
    if (o.fd != null || o.handle != null) throw new TrialViolation('listen', 'fd/handle listen is not allowed');
    if (o.path != null) {
      if (!PIPE_RE.test(String(o.path))) throw new TrialViolation('listen', `IPC path outside \\\\.\\pipe\\: ${o.path}`);
      return;
    }
    const port = Number(o.port ?? 0);
    if (!isLoopbackHost(o.host)) {
      throw new TrialViolation('listen', `host ${o.host === undefined ? '(unset: all interfaces)' : o.host} is not loopback (port ${port})`);
    }
    if (realPorts.has(port)) throw new TrialViolation('listen', `port ${port} is a LIVE port`);
    if (port === 0) return; // OS-assigned loopback ephemeral port (CCR probes for a free port this way)
    if (!(port >= min && port <= max)) throw new TrialViolation('listen', `port ${port} outside trial range ${min}-${max}`);
  }

  // Connects are loopback AND inside the trial port range: the sandbox has no business
  // talking to the live gateway (3456/3457/3458/4517) or any other local service.
  // A host-less net.connect(port) defaults to localhost, so an unset host is loopback
  // and is held to the same port rules.
  function checkConnect(o) {
    // Node treats ONLY a truthy `path` as IPC (`{path: '', host, port}` is a TCP connect): mirror it exactly
    if (o.path) return; // named-pipe / unix IPC is local by definition
    if (typeof o.lookup === 'function') throw new TrialViolation('connect', 'a custom lookup function could redirect a loopback name (airgap)');
    const host = o.host ?? o.hostname;
    if (host !== undefined && host !== null && host !== '' && !isLoopbackHost(host)) {
      throw new TrialViolation('connect', `non-loopback host ${host}:${o.port} (airgap)`);
    }
    const port = Number(o.port);
    if (o.port === undefined || o.port === null || o.port === '' || !Number.isInteger(port)) {
      throw new TrialViolation('connect', `missing or invalid port ${String(o.port)}`);
    }
    if (realPorts.has(port)) throw new TrialViolation('connect', `port ${port} is a LIVE port`);
    if (!(port >= min && port <= max)) throw new TrialViolation('connect', `loopback port ${port} outside trial range ${min}-${max}`);
  }

  function checkHostname(name, op) {
    if (name === undefined || name === null || name === '') return;
    if (!isLoopbackHost(name)) throw new TrialViolation('dns', `${op} of non-loopback name ${name} (airgap)`);
  }

  function pathText(p) {
    if (ArrayBuffer.isView(p)) return Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString();
    if (typeof p === 'object' && p.protocol === 'file:') return require('node:url').fileURLToPath(p);
    return String(p);
  }

  function checkWrite(p, op) {
    if (p === undefined || p === null || typeof p === 'number') return; // fd already opened through a checked open()
    const s = pathText(p);
    if (/^(?:\\\\\.\\)?nul$/i.test(s) || s === '/dev/null') return;
    const rp = canonical(s);
    for (const root of protectedRoots) {
      if (isUnder(rp, root)) throw new TrialViolation('write', `${op} ${s} -> ${rp} is under protected root ${root}`);
    }
    if (!allowWriteRoots.some((r) => isUnder(rp, r))) {
      throw new TrialViolation('write', `${op} ${s} -> ${rp} is outside the trial roots`);
    }
  }

  /** A path that must merely sit inside the trial roots (e.g. a native addon we are asked to load). */
  function checkInside(p, op) {
    const s = pathText(p);
    const rp = canonical(s);
    if (!allowWriteRoots.some((r) => isUnder(rp, r))) throw new TrialViolation('write', `${op} ${s} -> ${rp} is outside the trial roots`);
  }

  function checkKill(pid, sig) {
    if (sig === 0 || sig === '0') return; // existence probe
    if (!tracked.has(Number(pid))) throw new TrialViolation('kill', `signal ${sig ?? 'SIGTERM'} to untracked pid ${pid}`);
  }

  /** `isCmdline`: `file` is a whole command line (exec/execSync/shell) rather than an executable path. */
  function checkSpawn(file, args, isCmdline) {
    const argv = Array.isArray(args) ? args.map(String) : [];
    const cmdline = [String(file), ...argv].join(' ');
    const first = isCmdline ? String(file).trim().replace(/^"([^"]*)".*$/, '$1').split(/\s+/)[0] : String(file);
    const base = baseName(first);
    // Logged with secrets masked, then clipped to 600 chars (a key is never cut in half and left unmatchable).
    const deny = (why) => { throw new TrialViolation('spawn', `${why}: ${redactSecrets(cmdline).slice(0, 600)}`); };
    if (DENY_BASENAMES.has(base)) deny(`denied executable ${base}`);
    for (const re of DENY_CMDLINE) if (re.test(cmdline)) deny(`denied pattern ${re}`);
    if (base === 'powershell' || base === 'pwsh' || /\b(?:powershell|pwsh)(?:\.exe)?\b/i.test(cmdline)) {
      const hatch = powershellHatchForSpawn(base, argv, isCmdline, cmdline);
      if (hatch) deny(`denied PowerShell switch ${hatch}`);
    }
    if (/\bcertutil\b/i.test(cmdline)) {
      if (!/-(?:verify)?store\b/i.test(cmdline) || /-(?:add|del|repair)store|-importpfx|-setreg|-delkey/i.test(cmdline)) deny('certutil is read-only in the trial');
    }
    if (/\bnetsh\b/i.test(cmdline)) {
      if (!/\bshow\b/i.test(cmdline) || /\b(?:set|add|delete|reset|import|export)\b/i.test(cmdline)) deny('netsh is read-only in the trial');
    }
    if (base === 'taskkill' || /\btaskkill\b/i.test(cmdline)) {
      const pids = [...cmdline.matchAll(/\/PID\s+"?(\d+)"?/gi)].map((m) => Number(m[1]));
      if (!pids.length || pids.some((p) => !tracked.has(p)) || /\/(?:IM|FI)\b/i.test(cmdline)) deny('taskkill only for tracked pids');
    }
  }

  return { checkListen, checkConnect, checkHostname, checkWrite, checkInside, checkKill, checkSpawn, tracked, canonical };
}

const FS_PATH_ARGS = {
  writeFile: [0], writeFileSync: [0], appendFile: [0], appendFileSync: [0],
  truncate: [0], truncateSync: [0], unlink: [0], unlinkSync: [0],
  rmdir: [0], rmdirSync: [0], rm: [0], rmSync: [0], mkdir: [0], mkdirSync: [0],
  mkdtemp: [0], mkdtempSync: [0], rename: [0, 1], renameSync: [0, 1],
  copyFile: [1], copyFileSync: [1], cp: [1], cpSync: [1],
  symlink: [1], symlinkSync: [1], link: [0, 1], linkSync: [0, 1],
  chmod: [0], chmodSync: [0], chown: [0], chownSync: [0], lchown: [0], lchownSync: [0],
  utimes: [0], utimesSync: [0], lutimes: [0], lutimesSync: [0],
  createWriteStream: [0],
};
const PROMISE_PATH_ARGS = {
  writeFile: [0], appendFile: [0], truncate: [0], unlink: [0], rmdir: [0], rm: [0],
  mkdir: [0], mkdtemp: [0], rename: [0, 1], copyFile: [1], cp: [1], symlink: [1],
  link: [0, 1], chmod: [0], chown: [0], lchown: [0], utimes: [0], lutimes: [0],
};
// Read-style APIs whose options can carry a WRITE flag (readFile(p, {flag:'w'}) truncates).
const READ_FLAG_APIS = { readFile: 'flag', readFileSync: 'flag', createReadStream: 'flags' };

const DNS_NAMES = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'lookupService'];

function flagsWrite(flags, constants) {
  if (flags === undefined || flags === null) return false;
  const c = constants || { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 };
  if (typeof flags === 'number') return !!(flags & (c.O_WRONLY | c.O_RDWR | c.O_CREAT | c.O_APPEND | c.O_TRUNC));
  return /[wa+]/.test(String(flags));
}

// ---- better-sqlite3: a native addon opens whatever path it is handed, so the JS
// wrapper is put under the write policy. ATTACH DATABASE and VACUUM INTO write to
// an arbitrary file from inside SQL; they and native extension loading are denied.
const sqliteProxies = new WeakMap();
function sqlBlocked(sql) {
  const s = String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  if (/\bATTACH\b/i.test(s)) return 'ATTACH DATABASE';
  if (/\bVACUUM\b[^;]*\bINTO\b/i.test(s)) return 'VACUUM INTO';
  return undefined;
}
function wrapBetterSqlite(exp, policy, guarded) {
  if (typeof exp !== 'function') return exp;
  if (sqliteProxies.has(exp)) return sqliteProxies.get(exp);
  const checkOpen = (args) => guarded(() => {
    let file = args[0];
    let opts = args[1];
    if (file !== null && typeof file === 'object' && !ArrayBuffer.isView(file)) { opts = file; file = undefined; }
    if (opts && typeof opts === 'object' && opts.nativeBinding) policy.checkInside(opts.nativeBinding, 'better-sqlite3 nativeBinding');
    const readonly = !!(opts && typeof opts === 'object' && opts.readonly === true);
    if (typeof file === 'string' && file !== '' && file !== ':memory:' && !readonly) policy.checkWrite(file, 'better-sqlite3 open');
  });
  const proto = exp.prototype;
  if (proto && !proto.__uwTrial31Sqlite) {
    for (const name of ['prepare', 'exec']) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      proto[name] = function (sql, ...rest) {
        const why = sqlBlocked(sql);
        if (why) guarded(() => { throw new TrialViolation('write', `better-sqlite3 ${name}: ${why} is denied`); });
        return orig.call(this, sql, ...rest);
      };
    }
    if (typeof proto.loadExtension === 'function') {
      proto.loadExtension = function () { return guarded(() => { throw new TrialViolation('spawn', 'better-sqlite3 loadExtension is denied'); }); };
    }
    if (typeof proto.backup === 'function') {
      const orig = proto.backup;
      proto.backup = function (dest, ...rest) {
        try { guarded(() => policy.checkWrite(dest, 'better-sqlite3 backup')); } catch (e) { return Promise.reject(e); }
        return orig.call(this, dest, ...rest);
      };
    }
    Object.defineProperty(proto, '__uwTrial31Sqlite', { value: true });
  }
  const proxy = new Proxy(exp, {
    construct(target, args, newTarget) { checkOpen(args); return Reflect.construct(target, args, newTarget); },
    apply(target, thisArg, args) { checkOpen(args); return Reflect.apply(target, thisArg, args); },
  });
  sqliteProxies.set(exp, proxy);
  return proxy;
}
const SQLITE_REQUEST = /(?:^|[\\/])better-sqlite3(?:[\\/]|$)/;
function installModuleHook(Module, policy, guarded) {
  const orig = Module._load;
  if (typeof orig !== 'function') return;
  Module._load = function (request, ...rest) {
    const exp = orig.call(this, request, ...rest);
    if (typeof request === 'string' && SQLITE_REQUEST.test(request)) return wrapBetterSqlite(exp, policy, guarded);
    return exp;
  };
}

/**
 * Patches the given module objects in place. `mods` = {fs, net, dns, dgram,
 * child_process, process, module, worker_threads}; any may be omitted. Returns {policy}.
 */
function install(mods, cfg) {
  const policy = createPolicy(cfg);
  const log = cfg.log || (() => {});
  const guarded = (fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof TrialViolation) log('violation', { vkind: e.kind, message: e.message });
      throw e;
    }
  };
  const { fs, net, dns, dgram, child_process: cp, process: proc } = mods;

  if (fs) {
    const consts = fs.constants;
    const wrap = (target, name, idxs, isPromise) => {
      const orig = target[name];
      if (typeof orig !== 'function') return;
      target[name] = function (...args) {
        try {
          guarded(() => { for (const i of idxs) policy.checkWrite(args[i], `fs${isPromise ? '.promises' : ''}.${name}`); });
        } catch (e) { if (isPromise) return Promise.reject(e); throw e; }
        return orig.apply(this, args);
      };
    };
    for (const [name, idxs] of Object.entries(FS_PATH_ARGS)) wrap(fs, name, idxs, false);
    const wrapOpen = (target, name, isPromise) => {
      const orig = target[name];
      if (typeof orig !== 'function') return;
      target[name] = function (...args) {
        try {
          const flags = typeof args[1] === 'function' ? undefined : args[1];
          if (flagsWrite(flags, consts)) guarded(() => policy.checkWrite(args[0], `fs.${name}(${String(flags)})`));
        } catch (e) { if (isPromise) return Promise.reject(e); throw e; }
        return orig.apply(this, args);
      };
    };
    wrapOpen(fs, 'open', false);
    wrapOpen(fs, 'openSync', false);
    const wrapReadFlag = (target, name, key, isPromise) => {
      const orig = target[name];
      if (typeof orig !== 'function') return;
      target[name] = function (...args) {
        try {
          const o = args[1];
          const flag = o !== null && typeof o === 'object' ? o[key] : undefined;
          if (flagsWrite(flag, consts)) guarded(() => policy.checkWrite(args[0], `fs.${name}(${key}=${String(flag)})`));
        } catch (e) { if (isPromise) return Promise.reject(e); throw e; }
        return orig.apply(this, args);
      };
    };
    for (const [name, key] of Object.entries(READ_FLAG_APIS)) wrapReadFlag(fs, name, key, false);
    if (fs.promises) {
      for (const [name, idxs] of Object.entries(PROMISE_PATH_ARGS)) wrap(fs.promises, name, idxs, true);
      wrapOpen(fs.promises, 'open', true);
      wrapReadFlag(fs.promises, 'readFile', 'flag', true);
    }
    // Direct `new fs.WriteStream(path)` / `new fs.ReadStream(path, {flags:'w'})` bypass createWriteStream.
    const wrapStreamClass = (name, isWrite) => {
      let orig;
      try { orig = fs[name]; } catch { return; }
      if (typeof orig !== 'function') return;
      const check = (args) => guarded(() => {
        if (isWrite) { policy.checkWrite(args[0], `fs.${name}`); return; }
        const o = args[1];
        const flag = o !== null && typeof o === 'object' ? o.flags : undefined;
        if (flagsWrite(flag, consts)) policy.checkWrite(args[0], `fs.${name}(flags=${String(flag)})`);
      });
      const proxy = new Proxy(orig, {
        construct(t, args, nt) { check(args); return Reflect.construct(t, args, nt); },
        apply(t, thisArg, args) { check(args); return Reflect.apply(t, thisArg, args); },
      });
      Object.defineProperty(fs, name, { value: proxy, configurable: true, enumerable: true, writable: true });
    };
    wrapStreamClass('WriteStream', true);
    wrapStreamClass('ReadStream', false);
  }

  if (net) {
    if (net.Server && net.Server.prototype) {
      const orig = net.Server.prototype.listen;
      net.Server.prototype.listen = function (...args) {
        guarded(() => policy.checkListen(normListen(args)));
        return orig.apply(this, args);
      };
    }
    if (net.Socket && net.Socket.prototype) {
      const orig = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (...args) {
        guarded(() => policy.checkConnect(normConnect(args)));
        return orig.apply(this, args);
      };
    }
  }

  if (dns) {
    const wrapDns = (target, name, isPromise) => {
      const orig = target && target[name];
      if (typeof orig !== 'function') return;
      target[name] = function (hostname, ...rest) {
        try { guarded(() => policy.checkHostname(hostname, `dns.${name}`)); }
        catch (e) { if (isPromise) return Promise.reject(e); throw e; }
        return orig.call(this, hostname, ...rest);
      };
    };
    const targets = [
      [dns, false], [dns.promises, true],
      [dns.Resolver && dns.Resolver.prototype, false],
      [dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype, true],
    ];
    for (const [target, isPromise] of targets) for (const n of DNS_NAMES) wrapDns(target, n, isPromise);
  }

  if (dgram && dgram.Socket && dgram.Socket.prototype) {
    const proto = dgram.Socket.prototype;
    if (typeof proto.send === 'function') {
      const orig = proto.send;
      proto.send = function (...args) {
        const t = dgramSendTarget(args);
        if (t) guarded(() => policy.checkConnect(t));
        return orig.apply(this, args);
      };
    }
    if (typeof proto.connect === 'function') {
      const orig = proto.connect;
      proto.connect = function (...args) {
        guarded(() => policy.checkConnect({ host: typeof args[1] === 'string' ? args[1] : undefined, port: args[0] }));
        return orig.apply(this, args);
      };
    }
    if (typeof proto.bind === 'function') {
      const orig = proto.bind;
      proto.bind = function (...args) {
        guarded(() => policy.checkListen(normBind(args)));
        return orig.apply(this, args);
      };
    }
  }

  if (cp) {
    const preloadReq = cfg.childEnv && cfg.childEnv.NODE_OPTIONS;
    // A child's env is ALWAYS rebuilt: the caller's values for NODE_OPTIONS and every
    // UW_TRIAL31_* key are overwritten, never trusted. No env in the options = the
    // child would inherit process.env, which could have been altered in-process, so
    // an explicit env is synthesised from it.
    const applyEnv = (opts) => {
      const base = opts !== null && typeof opts === 'object' && !Array.isArray(opts) ? opts : {};
      const own = base.env !== null && typeof base.env === 'object' ? base.env : ((proc && proc.env) || {});
      const env = { ...own };
      for (const [k, v] of Object.entries(cfg.childEnv)) env[k] = v;
      if (preloadReq) env.NODE_OPTIONS = preloadReq;
      return { ...base, env };
    };
    const track = (child) => {
      if (child && child.pid) {
        const pid = child.pid;
        policy.tracked.add(pid);
        if (typeof child.once === 'function') child.once('exit', () => policy.tracked.delete(pid));
      }
      return child;
    };
    // [has args array, returns a ChildProcess, is a command line, is fork]
    const table = {
      spawn: [true, true, false], spawnSync: [true, false, false], execFile: [true, true, false],
      execFileSync: [true, false, false], fork: [true, true, false, true], exec: [false, true, true],
      execSync: [false, false, true],
    };
    for (const [name, [hasArgs, returnsChild, isCmdline, isFork]] of Object.entries(table)) {
      const orig = cp[name];
      if (typeof orig !== 'function') continue;
      const wrapper = function (...args) {
        let file = args[0];
        let argv = hasArgs && Array.isArray(args[1]) ? args[1] : [];
        if (isFork) { argv = [file, ...argv]; file = (proc && proc.execPath) || 'node'; }
        const shell = args.some((a) => a && typeof a === 'object' && !Array.isArray(a) && a.shell);
        guarded(() => policy.checkSpawn(file, argv, isCmdline || shell));
        if (cfg.childEnv) {
          // The options object sits after the args array, or straight after the
          // command when the args array is omitted.
          const oi = !hasArgs ? 1 : (Array.isArray(args[1]) ? 2 : ((args[1] === undefined || args[1] === null) && args.length > 2 ? 2 : 1));
          const cur = args[oi];
          if (typeof cur === 'function') args.splice(oi, 0, applyEnv(undefined));
          else if (cur === undefined || cur === null || (typeof cur === 'object' && !Array.isArray(cur))) args[oi] = applyEnv(cur);
        }
        const out = orig.apply(this, args);
        return returnsChild ? track(out) : out;
      };
      // util.promisify(exec/execFile) must keep resolving {stdout, stderr}; the stock
      // wrapper is lost when the function is replaced, so re-create it on top of the
      // guarded wrapper (a violation rejects the promise).
      if (name === 'exec' || name === 'execFile') {
        wrapper[nodeUtil.promisify.custom] = function (...args) {
          let child;
          const p = new Promise((resolve, reject) => {
            child = wrapper.call(this, ...args, (err, stdout, stderr) => {
              if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
            });
          });
          p.child = child;
          return p;
        };
      }
      cp[name] = wrapper;
    }
  }

  if (proc && typeof proc.kill === 'function') {
    const orig = proc.kill;
    proc.kill = function (pid, sig) {
      guarded(() => policy.checkKill(pid, sig));
      return orig.call(this, pid, sig);
    };
  }

  const wt = mods.worker_threads;
  if (wt && typeof wt.Worker === 'function' && cfg.childEnv) {
    // Workers inherit NODE_OPTIONS from process.env; one given its own env object would not.
    const proxy = new Proxy(wt.Worker, {
      construct(target, args, newTarget) {
        const opts = args[1] !== null && typeof args[1] === 'object' ? { ...args[1] } : {};
        if (opts.env !== null && typeof opts.env === 'object') opts.env = { ...opts.env, ...cfg.childEnv };
        args[1] = opts;
        return Reflect.construct(target, args, newTarget);
      },
    });
    wt.Worker = proxy;
  }

  if (mods.module) installModuleHook(mods.module, policy, guarded);

  return { policy };
}

module.exports = { TrialViolation, isLoopbackHost, isUnder, createPolicy, install, flagsWrite, wrapBetterSqlite, sqlBlocked, powershellEscapeHatch, tokenizeCmdline, dgramSendTarget };

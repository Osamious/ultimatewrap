// CCR 3.1.1 trial, fixes after G2 run 1 (three harness false positives + rerun hygiene). Fakes and temp dirs only:
// no real process other than `node -e` canaries under the guard, no registry, no real ports, no CCR, no real
// ~/.claude, %APPDATA% or Claude-3p. Fake secrets are assembled at runtime (GitHub push protection).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { systemTool, systemRoot, SYSTEM_TOOL_NAMES, CLAUDE_3P_LIBRARY_ID } from "../harness/trial31/config31.mjs";
import {
  runTool, runPs, listenerPid, makeTripwire31, claude3pSyncCollectors, realCollectors, tailRedacted, redactDaemonLog, redactSecrets, DAEMON_LOG_WARNING,
} from "../harness/trial31/tripwire31.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRIAL = path.join(HERE, "..", "harness", "trial31");
const { TrialViolation, createPolicy, install, powershellEscapeHatch, tokenizeCmdline } = require(path.join(TRIAL, "guard-core.cjs"));
const hex = (n = 24) => crypto.randomBytes(n).toString("hex");
const mkTemp = (p = "uw-trial31-g2fix-") => mkTmp(p);

// ================================================================ item 1: absolute system tools
const GIT_BASH_ENV = {
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\Program Files\\Git\\cmd;D:\\Anaconda3\\Library\\usr\\bin;C:\\Windows\\system32;C:\\Windows",
};

test("systemTool: every tool is an ABSOLUTE %SystemRoot%\\System32 path, whatever PATH says (Git-Bash ordering cannot redirect it)", () => {
  const want = {
    whoami: "C:\\Windows\\System32\\whoami.exe", icacls: "C:\\Windows\\System32\\icacls.exe", reg: "C:\\Windows\\System32\\reg.exe",
    taskkill: "C:\\Windows\\System32\\taskkill.exe", netstat: "C:\\Windows\\System32\\NETSTAT.EXE", where: "C:\\Windows\\System32\\where.exe",
    certutil: "C:\\Windows\\System32\\certutil.exe", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  };
  assert.deepEqual([...SYSTEM_TOOL_NAMES].sort(), Object.keys(want).sort());
  for (const [name, exe] of Object.entries(want)) {
    assert.equal(systemTool(name, GIT_BASH_ENV), exe, name);
    assert.equal(systemTool(`${name}.exe`, GIT_BASH_ENV), exe, `${name}.exe spelling`);
    assert.ok(path.win32.isAbsolute(exe));
    // no PATH segment (Git usr\bin included) can be the directory of the resolved tool
    for (const seg of GIT_BASH_ENV.PATH.split(";")) {
      if (/git/i.test(seg)) assert.notEqual(path.win32.dirname(systemTool(name, GIT_BASH_ENV)).toLowerCase(), seg.toLowerCase());
    }
    // reversing or emptying PATH changes nothing
    assert.equal(systemTool(name, { ...GIT_BASH_ENV, PATH: "C:\\Program Files\\Git\\usr\\bin" }), exe);
    assert.equal(systemTool(name, { SystemRoot: "C:\\Windows" }), exe);
  }
  assert.throws(() => systemTool("bash"), /unknown system tool/);
});

test("systemRoot: derived from SystemRoot/windir (any key case), hard-coded C:\\Windows fallback, never a relative or garbage value", () => {
  assert.equal(systemRoot({ SystemRoot: "D:\\WINNT" }), "D:\\WINNT");
  assert.equal(systemRoot({ SYSTEMROOT: "D:\\WINNT\\" }), "D:\\WINNT");
  assert.equal(systemRoot({ windir: "E:/Win" }), "E:\\Win");
  assert.equal(systemRoot({ SystemRoot: "..\\evil", windir: "F:\\W" }), "F:\\W", "an unusable SystemRoot falls through to windir");
  assert.equal(systemRoot({ SystemRoot: "relative\\dir" }), "C:\\Windows");
  assert.equal(systemRoot({}), "C:\\Windows");
  assert.equal(systemTool("whoami", { windir: "D:\\W" }), "D:\\W\\System32\\whoami.exe");
});

test("runTool/runPs/listenerPid: the executable handed to the child-process API is the absolute path, under a Git-Bash PATH", () => {
  const seen = [];
  const execFile = (exe, args, opts) => { seen.push({ exe, args, opts }); return "  4242 \n"; };
  const deps = { env: GIT_BASH_ENV, execFile };
  runTool("whoami", ["/user", "/fo", "csv", "/nh"], {}, deps);
  runTool("icacls", ["C:\\x"], {}, deps);
  runTool("reg", ["query", "HKCU\\Environment"], {}, deps);
  runTool("taskkill", ["/PID", "1", "/T", "/F"], { stdio: "ignore" }, deps);
  runTool("certutil", ["-user", "-store", "Root"], {}, deps);
  runPs("Get-Date", deps);
  assert.deepEqual(seen.map((s) => s.exe), [
    "C:\\Windows\\System32\\whoami.exe", "C:\\Windows\\System32\\icacls.exe", "C:\\Windows\\System32\\reg.exe", "C:\\Windows\\System32\\taskkill.exe",
    "C:\\Windows\\System32\\certutil.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);
  assert.ok(seen.every((s) => path.win32.isAbsolute(s.exe)));
  assert.equal(seen[3].opts.stdio, "ignore");
  assert.equal(seen[0].opts.windowsHide, true);
  // listenerPid goes through the injected ps and validates the port
  const scripts = [];
  assert.equal(listenerPid(39468, (s) => { scripts.push(s); return "4321\r\n"; }), 4321);
  assert.equal(listenerPid(39468, () => ""), undefined);
  assert.match(scripts[0], /-LocalPort 39468 -State Listen/);
  assert.throws(() => listenerPid("1; calc", () => ""), /invalid port/);
});

test("no harness/trial31 source runs a bare tool name or imports guard.mjs's PATH-resolved helpers (source scan)", () => {
  const files = fs.readdirSync(TRIAL).filter((f) => /\.(mjs|cjs)$/.test(f));
  assert.ok(files.length >= 8);
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const tools = "whoami|icacls|reg|powershell|pwsh|taskkill|netstat|where|certutil|setx|cmd";
  for (const f of files) {
    const src = strip(fs.readFileSync(path.join(TRIAL, f), "utf8"));
    if (f === "guard-core.cjs") continue; // policy text names these tools on purpose
    const apiRe = new RegExp(String.raw`(?:execFileSync|execFile|spawnSync|spawn|execSync)\(\s*["'\`](?:${tools})(?:\.exe)?["'\`]`, "i");
    assert.ok(!apiRe.test(src), `${f}: bare tool name passed to a process API`);
    // `exec("whoami", ...)` in applyOwnerOnlyAcl is the injectable executor (default: runTool), not child_process.exec
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)) assert.ok(!/(?<![\w])exec(?![\w])/.test(m[1]), `${f} imports child_process.exec`);
    // config31.mjs is where the absolute-path table itself lives
    const exeRe = new RegExp(String.raw`["'\`](?:${tools})\.exe["'\`]`, "i");
    if (f !== "config31.mjs") assert.ok(!exeRe.test(src), `${f}: a bare tool.exe literal (use systemTool)`);
    // the only direct child-process calls are the guarded canary and the daemon launch, both on process.execPath
    for (const m of src.matchAll(/(?<![.\w])(?:spawnSync|execFileSync|execFile|execSync)\(\s*([^,)]+)/g)) {
      assert.match(m[1], /^process\.execPath$/, `${f}: child-process call on ${m[1]}`);
    }
    for (const m of src.matchAll(/\bd\.spawn\(\s*([^,)]+)/g)) assert.equal(m[1], "spec.command", `${f}: daemon launch`);
  }
  // guard.mjs is imported only for the IsolationError class (its listenerPid/makeTripwire use PATH-resolved powershell / a whole-tree hash)
  for (const f of files.filter((x) => x.endsWith(".mjs"))) {
    for (const m of fs.readFileSync(path.join(TRIAL, f), "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/guard\.mjs"/g)) {
      assert.equal(m[1].trim(), "IsolationError", `${f} imports ${m[1].trim()} from guard.mjs`);
    }
  }
  const tw = fs.readFileSync(path.join(TRIAL, "tripwire31.mjs"), "utf8");
  assert.match(tw, /export function applyOwnerOnlyAcl\(root, exec = \(f, a\) => runTool\(f, a\)\)/);
});

// ================================================================ item 1b: guard matches absolute paths
const ROOT = "C:\\t\\root";
const cfg = (over = {}) => ({
  pid: 1000, root: ROOT, allowWriteRoots: [], portRange: { min: 39456, max: 39489 }, realPorts: [3456, 3457, 3458, 4517],
  protectedRoots: ["C:\\t\\home\\.claude"], ...over,
});
const denied = (fn, re) => assert.throws(fn, (e) => e instanceof TrialViolation && e.kind === "spawn" && (!re || re.test(e.message)), String(re));
const SYS = "C:\\Windows\\System32";
const PS_EXE = `${SYS}\\WindowsPowerShell\\v1.0\\powershell.exe`;

test("guard: deny-list and allowlists match ABSOLUTE tool paths (case-insensitive, either slash), as the harness now spawns them", () => {
  const p = createPolicy(cfg());
  p.tracked.add(777);
  for (const [f, a] of [
    [`${SYS}\\reg.exe`, ["add", "HKCU\\Environment", "/v", "Path", "/f"]], [`${SYS.toUpperCase()}\\REG.EXE`, ["DELETE", "HKCU\\X"]],
    ["C:/Windows/System32/reg.exe", ["import", "x.reg"]],
    [`${SYS}\\icacls.exe`, ["C:\\x", "/grant", "a:F"]], [`${SYS}\\ICACLS.EXE`, ["C:\\x"]],
    [`${SYS}\\taskkill.exe`, ["/PID", "9999", "/T", "/F"]], [`${SYS}\\taskkill.exe`, ["/IM", "node.exe"]],
    [`${SYS}\\certutil.exe`, ["-user", "-addstore", "Root", "x.cer"]], [`${SYS}\\certutil.exe`, ["-user", "-importpfx", "x.pfx"]],
    [`${SYS}\\setx.exe`, ["A", "b"]], [`${SYS}\\cmd.exe`, ["/c", "echo"]],
  ]) denied(() => p.checkSpawn(f, a, false));
  // the read-only forms the harness itself runs (it is not guarded, but a guarded 3.1.1 could run the same)
  p.checkSpawn(`${SYS}\\reg.exe`, ["query", "HKCU\\Environment", "/v", "Path"], false);
  p.checkSpawn(`${SYS}\\taskkill.exe`, ["/PID", "777", "/T", "/F"], false);
  p.checkSpawn(`${SYS}\\certutil.exe`, ["-user", "-store", "Root"], false);
  p.checkSpawn(`${SYS}\\whoami.exe`, ["/user", "/fo", "csv", "/nh"], false);
  for (const exe of [PS_EXE, PS_EXE.toUpperCase(), PS_EXE.replace(/\\/g, "/"), "C:\\Program Files\\PowerShell\\7\\pwsh.exe"]) {
    p.checkSpawn(exe, ["-NoProfile", "-Command", "Get-Date"], false);
    denied(() => p.checkSpawn(exe, ["-NoProfile", "-File", "x.ps1"], false), /-File/);
    denied(() => p.checkSpawn(exe, ["-EncodedCommand", "abc"], false), /encoded/);
  }
  // command-line form with a quoted absolute path containing a space
  denied(() => p.checkSpawn('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile -File x.ps1', [], true), /-File/);
  denied(() => p.checkSpawn(`"${SYS}\\reg.exe" add HKCU\\Environment /f`, [], true), /denied pattern/);
});

// ================================================================ item 3: PowerShell switch parsing
// A getAppInfo-shaped read-only probe (aGe in 3.1.1's cli.js: joined with spaces), plus the tokens the bug report names.
const PROBE_BODY = [
  "$ErrorActionPreference = 'SilentlyContinue';", "$roots = @(", "  [Environment]::GetFolderPath('Programs'),", "  [Environment]::GetFolderPath('Desktop')",
  ") | Where-Object { $_ } | Select-Object -Unique;", "$pattern = 'claude|anthropic';", "$shell = New-Object -ComObject WScript.Shell;",
  "Get-ChildItem -LiteralPath $roots -Filter '*.lnk' -File -Recurse |", "  Where-Object { $_.BaseName -match $pattern } |", "  ForEach-Object {",
  "    try { $target = $shell.CreateShortcut($_.FullName).TargetPath; if ($target) { $target } } catch {}", "  }",
].join(" ");
const TOKEN_BODY = `${PROBE_BODY} Write-Output 'flags -File -f -e -ec -enc -EncodedCommand -Command -'`;
const PS_HEAD = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

test("guard PowerShell (item 3): a read-only probe whose SCRIPT BODY contains -File / -f / -e is ALLOWED, in argv and command-line forms", () => {
  const p = createPolicy(cfg());
  for (const body of [PROBE_BODY, TOKEN_BODY, "Get-ChildItem -File", "Write-Output '-f -e'"]) {
    for (const exe of [PS_EXE, "powershell.exe", "powershell", "pwsh"]) {
      p.checkSpawn(exe, [...PS_HEAD, body], false);              // spawnSync(file, [args])
      p.checkSpawn(exe, [...PS_HEAD.slice(0, 4), "-c", body], false); // -c alias
      p.checkSpawn(exe, ["-NoProfile", `-Command`, body, "-File", "still-body.ps1"], false); // everything after -Command is body
      p.checkSpawn(exe, [body], false);                          // implicit -Command (first positional token)
    }
    // exec / shell:true form: one command line, quotes-aware
    p.checkSpawn(`"${PS_EXE}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${body.replace(/"/g, '\\"')}"`, [], true);
    p.checkSpawn(`powershell.exe -NoProfile -Command "${body.replace(/"/g, '\\"')}"`, [], true);
    p.checkSpawn(`powershell.exe -NoProfile -Command ${body}`, [], true);
    p.checkSpawn(PS_EXE, [...PS_HEAD, body], true);              // shell:true with an args array (joined)
  }
  // a value token is not a body: -ExecutionPolicy Bypass then real switches are still parsed as switches
  assert.equal(powershellEscapeHatch(["-ExecutionPolicy", "Bypass", "-Command", "x -File y"]), undefined);
  assert.equal(powershellEscapeHatch(["-NoProfile", "-Command:Get-ChildItem -File"]), undefined);
  assert.equal(powershellEscapeHatch(["Get-ChildItem", "-File"]), undefined, "implicit body");
});

test("guard PowerShell (item 3): the same tokens as REAL switches before the body are DENIED (argv and command-line forms)", () => {
  const p = createPolicy(cfg());
  const badArgv = [
    ["-File", "x.ps1"], ["-f", "x.ps1"], ["-fi", "x.ps1"], ["-e", "SQBFAFgA"], ["-ec", "abc"], ["-enc", "abc"], ["-EncodedCommand", "abc"], ["-encodedcommand:abc"],
    ["-NoProfile", "-File", "x.ps1", "-Command", "Get-Date"], ["-ExecutionPolicy", "Bypass", "-File", "a.ps1"], ["-NoProfile", "-e", "abc", "-Command", "Get-Date"],
    ["/File", "x.ps1"], ['"-File"', "x.ps1"], ["-File:x.ps1"], ["-Command", "-"], ["-c", "-"], ["-Command:-"], ["-NoProfile", "-"],
    ["-ExecutionPolicy", "-File", "x.ps1"], ["-NoProfile", "-EncodedCommand", "abc", "-Command", "Get-Date"],
  ];
  for (const exe of [PS_EXE, "powershell.exe", "pwsh"]) {
    for (const a of badArgv) denied(() => p.checkSpawn(exe, a, false), /denied PowerShell switch/);
  }
  for (const line of [
    `"${PS_EXE}" -NoProfile -File x.ps1`, "powershell -f x.ps1", "powershell -NoProfile -e abc", 'powershell -enc "abc"',
    'pwsh -Command -', "powershell -ExecutionPolicy Bypass -File a.ps1 -Command Get-Date", "node x.js powershell -File a.ps1",
  ]) denied(() => p.checkSpawn(line, [], true), /denied PowerShell switch/);
  assert.match(powershellEscapeHatch(["-Command", "-"]), /stdin/);
  assert.match(powershellEscapeHatch(["-e", "x"]), /encoded/);
  assert.match(powershellEscapeHatch(["-f", "x"]), /script file/);
  assert.equal(powershellEscapeHatch(["-NoProfile", "-Command", "Get-Date"]), undefined);
});

test("guard PowerShell (item 3): a script BODY is still scanned by the deny patterns (writers stay denied, even beside harmless -File tokens)", () => {
  const p = createPolicy(cfg());
  const bodies = [
    "[Environment]::SetEnvironmentVariable('Path','x','User')", "Set-ItemProperty HKCU:\\Environment Path x", "Set-ItemProperty -Path HKLM:\\SOFTWARE\\X -Name a -Value b",
    "Stop-Process -Id 5 -Force", "Invoke-Expression $x", "iex $x", "reg add HKCU\\Environment /v Path /d x /f", "New-Item HKCU:\\Software\\X",
    "Remove-Item HKCU:\\Software\\X -Recurse", "Get-ChildItem -File; [Environment]::SetEnvironmentVariable('A','b','User')", "Get-ChildItem -f -e; Stop-Process -Id 1",
    "$k.SetValue('a','b')", "Set-ExecutionPolicy Bypass",
  ];
  for (const b of bodies) {
    denied(() => p.checkSpawn(PS_EXE, [...PS_HEAD, b], false), /denied pattern/);
    denied(() => p.checkSpawn(`powershell.exe -NoProfile -Command "${b}"`, [], true), /denied pattern/);
    denied(() => p.checkSpawn("powershell", [b], false), /denied pattern/); // implicit body
  }
});

test("tokenizeCmdline: quotes group, \\\" is a literal quote, whitespace separates", () => {
  assert.deepEqual(tokenizeCmdline('"C:\\Program Files\\x.exe" -a "b c" d'), ["C:\\Program Files\\x.exe", "-a", "b c", "d"]);
  assert.deepEqual(tokenizeCmdline('a -Command "say \\"hi\\" -File"'), ["a", "-Command", 'say "hi" -File']);
  assert.deepEqual(tokenizeCmdline(""), []);
});

// ---------------------------------------------------------------- log length and redaction of a denied command line
test("guard violation text: the command line is logged up to 600 chars (was 160), with secrets masked before the clip", () => {
  const p = createPolicy(cfg());
  const long = `Write-Output '${"x".repeat(500)}'; [Environment]::SetEnvironmentVariable('A','b','User')`;
  let msg;
  try { p.checkSpawn(PS_EXE, [...PS_HEAD, long], false); } catch (e) { msg = e.message; }
  const cmdPart = msg.slice(msg.indexOf(": ", msg.indexOf("denied pattern")) + 2);
  assert.equal(cmdPart.length, 600, "clipped to exactly 600 chars, not 160");
  const web = hex(), key = `sk-${hex(12)}`;
  let m2;
  try { p.checkSpawn(PS_EXE, [...PS_HEAD, `Invoke-Expression 'curl http://127.0.0.1:39468/?ccr_web_token=${web} -H "Authorization: Bearer ${key}"'`], false); } catch (e) { m2 = e.message; }
  assert.ok(m2.includes("denied pattern"));
  assert.ok(!m2.includes(web) && !m2.includes(key), "no token or key survives in the violation text");
  assert.match(m2, /ccr_web_token=<redacted>/);
});

test("install(): a denied PowerShell spawn logs a 600-char redacted line; an allowed probe logs nothing and reaches child_process", () => {
  const calls = [], logs = [];
  const cp = { spawnSync: (...a) => { calls.push(a); return { status: 0 }; } };
  install({ child_process: cp, process: { env: {}, execPath: "node", kill() {} } }, { ...cfg(), log: (k, x) => logs.push([k, x]) });
  cp.spawnSync(PS_EXE, [...PS_HEAD, TOKEN_BODY], { encoding: "utf8" });
  assert.equal(calls.length, 1, "the read-only probe with -File in its body reached child_process");
  assert.equal(logs.length, 0);
  assert.throws(() => cp.spawnSync(PS_EXE, ["-NoProfile", "-File", "x.ps1"], {}), TrialViolation);
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "violation");
});

// ---------------------------------------------------------------- real-process canary (node -e with PowerShell-looking argv)
const PRELOAD = path.join(TRIAL, "preload-guard.cjs").replace(/\\/g, "/");
const q = (p) => `--require "${p.replace(/\\/g, "/")}"`;
test("canary (item 3): through the REAL preload, a PowerShell-looking argv with -File in the body runs; -File as a real switch is blocked (no PowerShell is ever run)", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox");
    fs.mkdirSync(root, { recursive: true });
    const script = path.join(dir, "canary.cjs");
    // The spawned program is `node -e 0`; the trailing argv only LOOKS like a PowerShell invocation. Nothing runs powershell.exe.
    fs.writeFileSync(script, `
      const cp = require('child_process');
      const out = {};
      const t = (n, fn) => { try { const r = fn(); out[n] = { blocked: false, status: r.status }; } catch (e) { out[n] = { blocked: e && e.code === 'UW_TRIAL31_VIOLATION', message: e && String(e.message).slice(0, 700) }; } };
      const node = process.execPath;
      const body = ${JSON.stringify(TOKEN_BODY)};
      t('body-with-file-tokens', () => cp.spawnSync(node, ['-e', '0', 'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', body]));
      t('real-file-switch', () => cp.spawnSync(node, ['-e', '0', 'powershell.exe', '-NoProfile', '-File', 'x.ps1']));
      t('body-with-writer', () => cp.spawnSync(node, ['-e', '0', 'powershell.exe', '-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('UW_CANARY','1','Process')"]));
      process.stdout.write(JSON.stringify(out));
    `);
    const env = {
      SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec,
      NODE_OPTIONS: q(PRELOAD), UW_TRIAL31_PRELOAD_ARG: q(PRELOAD), UW_TRIAL31_ROOT: root, UW_TRIAL31_PORT_RANGE: "39456-39457",
      UW_TRIAL31_REAL_PORTS: "3456,3457,3458,4517", UW_TRIAL31_PROTECTED: path.join(dir, "real-home"),
    };
    const r = spawnSync(process.execPath, [script], { env, encoding: "utf8", timeout: 90_000 });
    assert.equal(r.status, 0, `canary failed: ${r.stderr}`);
    const by = JSON.parse(r.stdout);
    assert.equal(by["body-with-file-tokens"].blocked, false, JSON.stringify(by["body-with-file-tokens"]));
    assert.equal(by["body-with-file-tokens"].status, 0);
    assert.equal(by["real-file-switch"].blocked, true, JSON.stringify(by["real-file-switch"]));
    assert.match(by["real-file-switch"].message, /PowerShell switch -File/);
    assert.equal(by["body-with-writer"].blocked, true);
    assert.match(by["body-with-writer"].message, /denied pattern/);
    // the violation log carries the (redacted) command line
    const log = fs.readFileSync(path.join(root, "violations.log"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(log.length, 2);
    assert.ok(log.every((l) => l.kind === "violation" && l.vkind === "spawn"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ================================================================ item 2: the narrow Claude-3p tripwire
function fakeClaude3p() {
  const root = mkTemp("uw-trial31-claude3p-");
  const w = (rel, txt = "x") => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, txt); return f; };
  w("claude_desktop_config.json", '{"deploymentMode":"3p"}\n');
  w(`configLibrary/${CLAUDE_3P_LIBRARY_ID}.json`, '{"inferenceProvider":"gateway"}\n');
  w("configLibrary/_meta.json", '{"appliedId":"x"}\n');
  for (const d of ["logs/main.log", "sentry/scope_v3.json", "Network/Network Persistent State", "Cache/Cache_Data/f_000001", "GPUCache/data_0", "Code Cache/js/index", "Preferences", "DIPS-wal"]) w(d, "a");
  return { root, w };
}

test("tripwire (item 2): Claude desktop's own churn (logs, Cache, sentry, Network, GPU caches, Preferences) does NOT trip; a change to a watched file does", () => {
  const { root, w } = fakeClaude3p();
  try {
    const tw = makeTripwire31({ collectors: claude3pSyncCollectors(root) });
    tw.assert("start");
    // churn everywhere else, including brand-new files and a bigger log
    w("logs/main.log", "a much longer line ".repeat(500));
    w("sentry/scope_v3.json", "changed");
    w("sentry/session.json", "new");
    w("Network/Network Persistent State", "changed");
    w("Cache/Cache_Data/f_000002", "new cache entry");
    fs.rmSync(path.join(root, "GPUCache"), { recursive: true, force: true });
    w("Code Cache/js/index", "changed");
    w("Preferences", "changed");
    w("host-creds-x.json", "new top-level file");
    w("blob_storage/a/b", "x");
    tw.assert("after-churn"); // must not throw
    // a watched file changes
    for (const [rel, re] of [
      ["claude_desktop_config.json", /claude_desktop_config\.json/], ["configLibrary/_meta.json", /_meta\.json/], [`configLibrary/${CLAUDE_3P_LIBRARY_ID}.json`, /configLibrary/],
    ]) {
      const t2 = makeTripwire31({ collectors: claude3pSyncCollectors(root) });
      const f = path.join(root, rel), was = fs.readFileSync(f);
      fs.writeFileSync(f, `${was}\n{"changed":true}`);
      assert.throws(() => t2.assert("g2"), (e) => /ISOLATION VIOLATION/.test(e.message) && re.test(e.message), rel);
      fs.writeFileSync(f, was);
      t2.assert("restored"); // and it is quiet again once restored
    }
    // a new / removed entry in configLibrary
    const t3 = makeTripwire31({ collectors: claude3pSyncCollectors(root) });
    w("configLibrary/another.json", "{}");
    assert.throws(() => t3.assert("g2"), /configLibrary-top/);
    fs.rmSync(path.join(root, "configLibrary", "another.json"));
    t3.assert("back");
    fs.rmSync(path.join(root, "configLibrary", "_meta.json"));
    assert.throws(() => t3.assert("g2"), /CHANGED/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("tripwire (item 2): a Claude-3p that does not exist is recorded as (absent) and only its CREATION trips", () => {
  const root = path.join(mkTemp("uw-trial31-claude3p-none-"), "Claude-3p");
  try {
    const c = claude3pSyncCollectors(root);
    assert.ok(Object.values(c).every((fn) => fn() === "(absent)"));
    const tw = makeTripwire31({ collectors: c });
    tw.assert("still absent");
    fs.mkdirSync(path.join(root, "logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "logs", "main.log"), "x");
    tw.assert("unrelated directory created");
    fs.writeFileSync(path.join(root, "claude_desktop_config.json"), "{}");
    assert.throws(() => tw.assert("config created"), /claude_desktop_config\.json/);
  } finally { fs.rmSync(path.dirname(root), { recursive: true, force: true }); }
});

test("tripwire (item 2): the default collector set has NO whole-tree Claude-3p collector and does not use guard.mjs's makeTripwire", () => {
  const keys = Object.keys(realCollectors());
  assert.ok(keys.every((k) => !k.startsWith("tree:")), keys.join(","));
  const c3p = keys.filter((k) => /claude-3p/.test(k));
  assert.deepEqual(c3p.sort(), [
    "file:real-claude-3p-claude_desktop_config.json", `file:real-claude-3p-configLibrary-${CLAUDE_3P_LIBRARY_ID}.json`,
    "file:real-claude-3p-configLibrary-_meta.json", "list:real-claude-3p-configLibrary-top",
  ].sort());
  for (const must of ["file:real-settings.json", "file:real-settings.local.json", "file:real-codex-config.toml", "list:real-downloads", "reg:hkcu-path"]) assert.ok(keys.includes(must), must);
  const src = fs.readFileSync(path.join(TRIAL, "tripwire31.mjs"), "utf8");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""), /\bmakeTripwire\(/);
});

// ================================================================ item 4/5: rerun message, daemon-log redaction
test("redaction: daemon.out.log's web token URL, bearer/key shapes and long hex are masked; the readable words survive; idempotent", () => {
  const web = hex(), svc = hex(), key = `sk-${hex(12)}`;
  const line = `CCR management server: http://127.0.0.1:39468/?ccr_web_token=${web} (service ${svc}) key=${key} Authorization: Bearer ${hex(16)}`;
  const r = redactDaemonLog(line);
  for (const s of [web, svc, key]) assert.ok(!r.includes(s), "a secret survived");
  assert.match(r, /CCR management server: http:\/\/127\.0\.0\.1:39468\/\?ccr_web_token=<redacted>/);
  assert.equal(redactDaemonLog(r), r, "idempotent");
  assert.equal(redactSecrets("nothing secret here: port 39468, pid 4242"), "nothing secret here: port 39468, pid 4242");
  assert.equal(redactSecrets(undefined), "");
  assert.ok(DAEMON_LOG_WARNING.includes("daemon.out.log") && /Never print/.test(DAEMON_LOG_WARNING));
});

test("tailRedacted: echoes only the last lines of a daemon log, with the token URL masked; an unreadable file echoes nothing", () => {
  const dir = mkTemp();
  try {
    const web = hex();
    const f = path.join(dir, "daemon.out.log");
    fs.writeFileSync(f, ["boot", "listening", `open http://127.0.0.1:39468/?ccr_web_token=${web}`, "ready"].join("\n") + "\n");
    const t = tailRedacted(f, 3);
    assert.ok(!t.includes(web));
    assert.match(t, /ccr_web_token=<redacted>/);
    assert.ok(!t.includes("boot"), "only the last 3 lines");
    assert.equal(tailRedacted(path.join(dir, "missing.log")), "");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

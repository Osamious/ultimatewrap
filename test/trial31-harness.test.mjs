// CCR 3.1.1 trial harness pieces that do not need a running CCR: the forced env /
// launch spec (config31.mjs) and the tripwire + auto-clean logic (tripwire31.mjs),
// driven with injected fakes. Nothing here reads or writes the real registry, the
// real ~/.claude, or the sandbox tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  TRIAL_ROOT, INSTALL_DIR, CLI_JS, PORT_RANGE, REAL_PORTS, WEB_PORT, GATEWAY_PORT, GATEWAY_CORE_PORT, STUB_PORT, PROTECTED_ROOTS,
  REAL_HOME, PRELOAD_ARG, newRunTokens, versionGte, buildEnv, printableEnv, launchSpec, assertLaunchSpec,
} from "../harness/trial31/config31.mjs";
import {
  makeTripwire31, loadBaseline, parseRegValue, restoreUserPathIfSpliced, isSandboxSegment, sandboxAliases, assertPathClean, NO_SANDBOX_SEGMENT,
  deleteSandbox, removeBackup, autoClean, assertOrClean, backupUserPath, PRESERVE, verifyRow, findSandboxDaemons, stopVerified, stopOwnedChild,
  copyVerified, rotateLogs, applyOwnerOnlyAcl, tokenizeCommandLine,
} from "../harness/trial31/tripwire31.mjs";
import { IsolationError } from "../harness/guard.mjs";

// A hostile parent env: everything that could steer the daemon at live state or the network.
const hostile = {
  SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", ComSpec: "C:\\Windows\\System32\\cmd.exe",
  USERPROFILE: "C:\\Users\\osami", HOME: "C:\\Users\\osami", APPDATA: "C:\\Users\\osami\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\osami\\AppData\\Local",
  CCR_WEB_PORT: "3458", CCR_WEB_HOST: "0.0.0.0", HOST: "0.0.0.0", PORT: "3456", CCR_GATEWAY_CONFIG_TIMEOUT_MS: "1000", CCR_INTERNAL_APP_DATA_DIR: "C:\\Users\\osami\\AppData\\Roaming",
  HTTPS_PROXY: "http://proxy.invalid:8080", http_proxy: "http://proxy.invalid:8080", NO_PROXY: "x", ALL_PROXY: "socks5://x",
  ANTHROPIC_API_KEY: "placeholder", OPENAI_API_KEY: "placeholder", CLAUDE_CONFIG_DIR: "C:\\Users\\osami\\.claude", NODE_OPTIONS: "--require C:/evil.js",
};

test("ports: trial range excludes every live port; web/gateway/core/stub all inside it", () => {
  for (const r of REAL_PORTS) assert.ok(r < PORT_RANGE[0] || r > PORT_RANGE[1], `live port ${r} inside the trial range`);
  for (const p of [WEB_PORT, GATEWAY_PORT, GATEWAY_CORE_PORT, STUB_PORT]) {
    assert.ok(p >= PORT_RANGE[0] && p <= PORT_RANGE[1], `${p} outside range`);
    assert.ok(!REAL_PORTS.includes(p));
  }
  assert.equal(GATEWAY_CORE_PORT, GATEWAY_PORT + 1, "3.1.1 derives corePort as PORT+1");
  // the management server scans up to 20 ports forward on EADDRINUSE; the guard range must cover the scan
  assert.ok(WEB_PORT + 19 <= PORT_RANGE[1], "every port the management server may scan up to must stay inside the guard range");
});

test("sandbox root is outside the repo and outside every protected root", () => {
  const repo = path.join(REAL_HOME, ".uw").toLowerCase();
  assert.ok(!(TRIAL_ROOT.toLowerCase() + "\\").startsWith(repo + "\\"), "sandbox must not live under the repo");
  for (const root of PROTECTED_ROOTS) {
    const r = root.toLowerCase();
    assert.ok(!(TRIAL_ROOT.toLowerCase() + "\\").startsWith(r + "\\"), `sandbox is under protected root ${root}`);
    assert.ok(!(r + "\\").startsWith(TRIAL_ROOT.toLowerCase() + "\\"), `protected root ${root} is under the sandbox`);
  }
  for (const needle of [".claude", ".codex", "AppData\\Roaming\\claude-code-router", "AppData\\Local\\Claude-3p", "Downloads"]) {
    assert.ok(PROTECTED_ROOTS.some((r) => r.endsWith(needle)), `${needle} must be protected`);
  }
});

test("buildEnv: a hostile parent env cannot steer the daemon", () => {
  const env = buildEnv(hostile);
  for (const k of ["HTTPS_PROXY", "http_proxy", "NO_PROXY", "ALL_PROXY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CCR_GATEWAY_CONFIG_TIMEOUT_MS"]) assert.equal(env[k], undefined, k);
  assert.equal(env.CCR_WEB_PORT, String(WEB_PORT));
  assert.equal(env.CCR_WEB_HOST, "127.0.0.1");
  assert.equal(env.NODE_OPTIONS, PRELOAD_ARG, "the parent's NODE_OPTIONS is replaced, not appended to");
  for (const k of ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME",
    "CCR_INTERNAL_HOME_DIR", "CCR_INTERNAL_APP_DATA_DIR", "CCR_INTERNAL_USER_DATA_DIR", "CCR_CONFIG_DIR"]) {
    assert.ok(env[k].toLowerCase().startsWith(TRIAL_ROOT.toLowerCase() + "\\"), `${k}=${env[k]}`);
  }
  assert.equal(env.HOMEDRIVE, "C:");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.match(env.UW_TRIAL31_PROTECTED, /\.claude/);
  assert.equal(env.UW_TRIAL31_PORT_RANGE, `${PORT_RANGE[0]}-${PORT_RANGE[1]}`);
});

test("printableEnv masks both per-run tokens and nothing else", () => {
  const tokens = newRunTokens();
  const shown = printableEnv(buildEnv(hostile, tokens));
  assert.equal(shown.CCR_WEB_AUTH_TOKEN, "***");
  assert.equal(shown.CCR_SERVICE_INSTANCE_TOKEN, "***");
  assert.ok(!JSON.stringify(shown).includes(tokens.web));
  assert.ok(!JSON.stringify(shown).includes(tokens.service));
  assert.equal(shown.CCR_WEB_PORT, String(WEB_PORT));
});

test("per-run tokens: random hex, distinct per run, forced into the env; the repo carries no constant token", () => {
  const a = newRunTokens(), b = newRunTokens();
  for (const t of [a.web, a.service, b.web, b.service]) assert.match(t, /^[0-9a-f]{48}$/);
  assert.notEqual(a.web, b.web);
  assert.notEqual(a.web, a.service);
  const env = buildEnv(hostile, a);
  assert.equal(env.CCR_WEB_AUTH_TOKEN, a.web);
  assert.equal(env.CCR_SERVICE_INSTANCE_TOKEN, a.service);
  const s1 = launchSpec(hostile), s2 = launchSpec(hostile);
  assert.notEqual(s1.env.CCR_WEB_AUTH_TOKEN, s2.env.CCR_WEB_AUTH_TOKEN);
  assert.deepEqual(s1.tokens, { web: s1.env.CCR_WEB_AUTH_TOKEN, service: s1.env.CCR_SERVICE_INSTANCE_TOKEN });
});

test("L7: HOST and PORT are forced to trial values whatever the parent says; NODE_OPTIONS quotes the preload path", () => {
  const env = buildEnv(hostile);
  assert.equal(env.HOST, "127.0.0.1");
  assert.equal(env.PORT, String(GATEWAY_PORT));
  assert.ok(Number(env.PORT) >= PORT_RANGE[0] && Number(env.PORT) <= PORT_RANGE[1] && !REAL_PORTS.includes(Number(env.PORT)));
  assert.match(PRELOAD_ARG, /^--require "[^"]*preload-guard\.cjs"$/);
  assert.ok(!PRELOAD_ARG.includes("\\"), "forward slashes only");
});

test("versionGte: zero-padded compare (\"1.0\" is NOT >= \"1.0.21\")", () => {
  assert.equal(versionGte("1.0", "1.0.21"), false);
  assert.equal(versionGte("1", "1.0.21"), false);
  assert.equal(versionGte("1.0.20", "1.0.21"), false);
  assert.equal(versionGte("1.0.21", "1.0.21"), true);
  assert.equal(versionGte("1.0.21.0", "1.0.21"), true);
  assert.equal(versionGte("1.0.22", "1.0.21"), true);
  assert.equal(versionGte("1.1", "1.0.21"), true);
  assert.equal(versionGte("2", "1.0.21"), true);
  assert.equal(versionGte("1.0.9", "1.0.21"), false, "numeric, not lexical");
  assert.equal(versionGte("1.0.x", "1.0.21"), false);
});

test("launchSpec: `serve --daemon-child --no-gateway` from the sandbox install, forced on the command line AND in env", () => {
  const spec = launchSpec(hostile);
  assertLaunchSpec(spec);
  assert.equal(spec.args[0], CLI_JS);
  assert.ok(CLI_JS.toLowerCase().startsWith(INSTALL_DIR.toLowerCase() + "\\"));
  assert.deepEqual(spec.args.slice(1), ["serve", "--daemon-child", "--no-open", "--no-gateway", "--host", "127.0.0.1", "--port", String(WEB_PORT)]);
  assert.ok(!spec.args.includes("start"), "`start` (detached daemon) is never used");
});

test("assertLaunchSpec rejects every way the spec could reach live state", () => {
  const mutate = (fn) => { const s = launchSpec(hostile); fn(s); return s; };
  const bad = {
    "gateway not disabled": (s) => { s.args = s.args.filter((a) => a !== "--no-gateway"); },
    "start subcommand": (s) => { s.args[1] = "start"; },
    "live web port 3458": (s) => { s.args[s.args.indexOf("--port") + 1] = "3458"; s.env.CCR_WEB_PORT = "3458"; },
    "out-of-range web port": (s) => { s.args[s.args.indexOf("--port") + 1] = "40000"; s.env.CCR_WEB_PORT = "40000"; },
    "env/cli port mismatch": (s) => { s.env.CCR_WEB_PORT = "39469"; },
    "wildcard host": (s) => { s.args[s.args.indexOf("--host") + 1] = "0.0.0.0"; },
    "global ccr cli": (s) => { s.args[0] = "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js"; },
    "real USERPROFILE": (s) => { s.env.USERPROFILE = "C:\\Users\\osami"; },
    "real APPDATA": (s) => { s.env.APPDATA = "C:\\Users\\osami\\AppData\\Roaming"; },
    "real LOCALAPPDATA": (s) => { s.env.LOCALAPPDATA = "C:\\Users\\osami\\AppData\\Local"; },
    "real CCR data dir": (s) => { s.env.CCR_INTERNAL_APP_DATA_DIR = "C:\\Users\\osami\\AppData\\Roaming"; },
    "missing HOME": (s) => { delete s.env.HOME; },
    "no preload": (s) => { s.env.NODE_OPTIONS = ""; },
    "extra NODE_OPTIONS": (s) => { s.env.NODE_OPTIONS += " --require C:/evil.js"; },
    "wildcard HOST": (s) => { s.env.HOST = "0.0.0.0"; },
    "live PORT": (s) => { s.env.PORT = "3456"; },
    "missing PORT": (s) => { delete s.env.PORT; },
    "short constant token": (s) => { s.env.CCR_WEB_AUTH_TOKEN = "uw-trial31-web-token-local-only"; s.tokens = undefined; },
    "web == service token": (s) => { s.env.CCR_SERVICE_INSTANCE_TOKEN = s.env.CCR_WEB_AUTH_TOKEN; s.tokens = undefined; },
    "tokens disagree with env": (s) => { s.tokens = { web: "a".repeat(48), service: "b".repeat(48) }; },
    "timeout knob set": (s) => { s.env.CCR_GATEWAY_CONFIG_TIMEOUT_MS = "500"; },
    "proxy inherited": (s) => { s.env.HTTPS_PROXY = "http://x"; },
    "foreign web token": (s) => { s.env.CCR_WEB_AUTH_TOKEN = "other"; },
    "browser open": (s) => { s.args = s.args.filter((a) => a !== "--no-open"); },
  };
  for (const [name, fn] of Object.entries(bad)) assert.throws(() => assertLaunchSpec(mutate(fn)), /trial31 launch spec rejected/, name);
});

// ---------- tripwire + auto-clean, with fakes ----------
const okBase = { assert() {} };
const mkCollectors = (state) => ({
  "file:a": () => state.a, "tree:b": () => state.b, "reg:proxy": () => state.proxy,
});

test("makeTripwire31: passes while unchanged; names each changed surface; the base tripwire's failure propagates", () => {
  const state = { a: "h1", b: "h2", proxy: "p1" };
  const tw = makeTripwire31({ base: okBase, collectors: mkCollectors(state) });
  tw.assert("stage-1");
  state.proxy = "p2";
  assert.throws(() => tw.assert("stage-2"), (e) => e instanceof IsolationError && /reg:proxy/.test(e.message) && /stage-2/.test(e.message) && !/file:a/.test(e.message));
  state.a = "x";
  assert.throws(() => tw.assert("stage-3"), /file:a, reg:proxy/);
  const failingBase = { assert() { throw new Error("settings.json CHANGED"); } };
  const tw2 = makeTripwire31({ base: failingBase, collectors: mkCollectors({ a: 1, b: 2, proxy: 3 }) });
  assert.throws(() => tw2.assert("x"), /settings\.json CHANGED/);
});

test("parseRegValue: raw type and value, spaces kept, other values ignored", () => {
  const out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    C:\\a b\\bin;%USERPROFILE%\\x;C:\\c\r\n    Pathext    REG_SZ    .X\r\n";
  assert.deepEqual(parseRegValue(out, "Path"), { type: "REG_EXPAND_SZ", value: "C:\\a b\\bin;%USERPROFILE%\\x;C:\\c" });
  assert.equal(parseRegValue(out, "Missing"), undefined);
});


test("makeTripwire31: persisted baseline is reloaded (not re-taken), hashes only; the trip message names the pre-trial copy", () => {
  const state = { a: "h1", b: "h2", proxy: "p1" };
  const tw = makeTripwire31({ base: okBase, collectors: mkCollectors(state) });
  const files = new Map();
  const fsx = { mkdirSync() {}, writeFileSync: (f, c) => files.set(f, c), readFileSync: (f) => { if (!files.has(f)) throw new Error("ENOENT"); return files.get(f); } };
  tw.save("run\\baseline.json", fsx);
  const persisted = JSON.parse(files.get("run\\baseline.json"));
  assert.deepEqual(persisted.baseline, { "file:a": "h1", "tree:b": "h2", "reg:proxy": "p1" }, "fingerprints only, no contents");
  assert.equal(persisted.version, 1);
  state.a = "CHANGED-DURING-TRIAL"; // a change made between start and teardown
  const loaded = loadBaseline("run\\baseline.json", fsx);
  const tw2 = makeTripwire31({ base: okBase, collectors: mkCollectors(state), baseline: loaded });
  assert.throws(() => tw2.assert("teardown:end"), (e) => e instanceof IsolationError && /file:a/.test(e.message) && /pre-trial settings copy/.test(e.message));
  const fresh = makeTripwire31({ base: okBase, collectors: mkCollectors(state) });
  fresh.assert("teardown:end"); // a fresh "now" baseline cannot see it: the reason teardown reloads the persisted one
  assert.equal(loadBaseline("missing.json", fsx), undefined);
  files.set("torn.json", "{\"baseline\":");
  assert.equal(loadBaseline("torn.json", fsx), undefined, "a torn baseline file is 'absent', not a crash");
});

test("tripwire collectors (code M6): the real ~/.codex tree is never content-hashed", async () => {
  const src = (await import("node:fs")).readFileSync(new URL("../harness/trial31/tripwire31.mjs", import.meta.url), "utf8");
  assert.ok(!/hashTree\(path\.join\(REAL_HOME, "\.codex"\)/.test(src), "no recursive hash of ~/.codex");
  assert.match(src, /"list:real-\.codex-top"/);
});

// ---------- HKCU PATH ----------
const SAVED = { type: "REG_EXPAND_SZ", value: "C:\\a;%USERPROFILE%\\b" };

test("restoreUserPathIfSpliced: removes ONLY sandbox segments from the CURRENT PATH; keeps edits made meanwhile", () => {
  const writes = [];
  const write = (s) => writes.push(s);
  const spliced = { type: "REG_EXPAND_SZ", value: `${TRIAL_ROOT}\\roaming\\claude-code-router\\bin;C:\\a;%USERPROFILE%\\b` };
  assert.deepEqual(restoreUserPathIfSpliced(SAVED, { read: () => spliced, write, aliases: [TRIAL_ROOT] }), { restored: true, removed: 1 });
  assert.deepEqual(writes, [SAVED], "the raw type and %VARS% survive");
  writes.length = 0;
  // an edit made during the trial (a NEW tool on PATH) must survive: the OLD saved value is not rewritten over it
  const edited = { type: "REG_EXPAND_SZ", value: `C:\\a;C:\\brand-new-tool;${TRIAL_ROOT}\\roaming\\bin;%USERPROFILE%\\b` };
  assert.equal(restoreUserPathIfSpliced(SAVED, { read: () => edited, write, aliases: [TRIAL_ROOT] }).restored, true);
  assert.deepEqual(writes, [{ type: "REG_EXPAND_SZ", value: "C:\\a;C:\\brand-new-tool;%USERPROFILE%\\b" }]);
  writes.length = 0;
  const userEdit = { type: "REG_EXPAND_SZ", value: "C:\\a;%USERPROFILE%\\b;C:\\new-tool" };
  assert.deepEqual(restoreUserPathIfSpliced(SAVED, { read: () => userEdit, write }), { restored: false, reason: NO_SANDBOX_SEGMENT });
  assert.equal(restoreUserPathIfSpliced(SAVED, { read: () => SAVED, write }).restored, false);
  assert.equal(restoreUserPathIfSpliced(SAVED, { read: () => undefined, write }).restored, false);
  assert.equal(restoreUserPathIfSpliced(SAVED, { read: () => ({ type: "REG_SZ", value: TRIAL_ROOT + "\\bin" }), write, aliases: [TRIAL_ROOT] }).restored, false, "would empty PATH: refused");
  assert.equal(writes.length, 0, "no write for the non-splice cases");
});

test("sandbox segment matching (sec M7): boundary-aware, slash/case/quote/trailing-backslash/8.3 tolerant", () => {
  const seg = (s) => isSandboxSegment(s, TRIAL_ROOT, [TRIAL_ROOT]);
  for (const s of [TRIAL_ROOT, `${TRIAL_ROOT}\\`, `${TRIAL_ROOT}\\roaming\\bin`, TRIAL_ROOT.toUpperCase() + "\\X", `"${TRIAL_ROOT}\\bin"`,
    `${TRIAL_ROOT.replace(/\\/g, "/")}/roaming/bin`, "C:\\Users\\osami\\UW-SCR~1\\roaming\\bin", "c:\\users\\osami\\uw-scr~2"]) assert.equal(seg(s), true, s);
  for (const s of [`${TRIAL_ROOT}-other\\bin`, `${TRIAL_ROOT}x`, "C:\\Users\\osami\\.uw", "C:\\Users\\osami\\UW-OTHER~1\\bin", "C:\\Windows", "", "%USERPROFILE%\\bin"]) assert.equal(seg(s), false, s);
  assert.equal(isSandboxSegment("D:\\alias\\bin", TRIAL_ROOT, [TRIAL_ROOT, "D:\\alias"]), true, "an injected realpath/short-path alias");
  const aliases = sandboxAliases(TRIAL_ROOT, { realpath: () => "D:\\real\\root", shortPath: () => "C:\\Users\\osami\\UW-SCR~1" });
  assert.deepEqual(aliases, [TRIAL_ROOT, "D:\\real\\root", "C:\\Users\\osami\\UW-SCR~1"]);
});

test("PATH preflight (code M3): refuses a PATH that already carries a sandbox segment; the backup is never overwritten", () => {
  assert.throws(() => assertPathClean(() => ({ type: "REG_SZ", value: `C:\\a;${TRIAL_ROOT}\\roaming\\bin` })), /already contains a sandbox segment/);
  assert.throws(() => assertPathClean(() => undefined), /refusing to start without a restore point/);
  assert.deepEqual(assertPathClean(() => SAVED), SAVED);
  const files = new Map();
  const fsx = { existsSync: (f) => files.has(f), mkdirSync() {}, writeFileSync: (f, c, o) => { if (o?.flag === "wx" && files.has(f)) throw new Error("EEXIST"); files.set(f, c); } };
  assert.deepEqual(backupUserPath(() => SAVED, { file: "b\\hkcu-path.json", fsx }), SAVED);
  const first = files.get("b\\hkcu-path.json");
  assert.throws(() => backupUserPath(() => ({ type: "REG_SZ", value: "DIFFERENT" }), { file: "b\\hkcu-path.json", fsx }), /already exists.*refusing to overwrite/);
  assert.equal(files.get("b\\hkcu-path.json"), first, "the first restore kit is intact");
});

test("backupUserPath refuses to proceed without a readable restore point", () => {
  assert.throws(() => backupUserPath(() => undefined, { file: "b\\x.json", fsx: { existsSync: () => false, mkdirSync() {}, writeFileSync() {} } }), /refusing to start without a restore point/);
});

// ---------- process identity (sec H2 / code H3) ----------
const NOW = Date.parse("2026-09-30T12:00:00Z");
const cmd = (over = "") => `"C:\\Program Files\\nodejs\\node.exe" ${CLI_JS} serve --daemon-child --no-open --no-gateway --host 127.0.0.1 --port 39468${over}`;
const row = (ProcessId, CommandLine, StartMs = NOW + 2000, Name = "node.exe") => ({ ProcessId, ParentProcessId: 1, Name, CommandLine, StartMs });

test("verifyRow: command line must name the sandbox cli.js AND --daemon-child, and not predate service.json's startedAt (minus margin)", () => {
  assert.equal(verifyRow(row(10, cmd()), { startedAtMs: NOW }).ok, true);
  assert.equal(verifyRow(row(10, cmd().replace(/\\/g, "/")), { startedAtMs: NOW }).ok, true, "slash spelling");
  assert.equal(verifyRow(row(10, cmd()), { startedAtMs: NOW + 60_000 }).ok, true, "started shortly before service.json was written: inside the margin");
  assert.equal(verifyRow(row(10, cmd(), NOW - 3_600_000), { startedAtMs: NOW }).ok, false, "an hour older than service.json");
  assert.equal(verifyRow(row(10, "C:\\Windows\\System32\\notepad.exe"), { startedAtMs: NOW }).ok, false);
  assert.equal(verifyRow(row(10, `node.exe ${CLI_JS} status`), { startedAtMs: NOW }).ok, false, "no --daemon-child");
  assert.equal(verifyRow(row(10, "node.exe C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\main\\cli.js serve --daemon-child"), { startedAtMs: NOW }).ok, false, "the LIVE global ccr daemon is not ours");
  assert.equal(verifyRow(row(10, null), {}).ok, false);
  assert.equal(verifyRow(row(10, cmd(), 0), { startedAtMs: NOW }).ok, false, "unknown start time cannot satisfy a known startedAt");
  assert.equal(verifyRow(row(10, cmd(), 0), {}).ok, true, "no startedAt known (teardown by scan): the command line decides");
});

test("verifyRow (sec M2): Name node.exe, argv[1] is the sandbox cli.js, a WHOLE --daemon-child token; hostile command lines never verify", () => {
  const q = (p) => '"' + p + '"';
  assert.deepEqual(tokenizeCommandLine('"C:/Program Files/node.exe" C:/x/cli.js "a b" --flag'), ["C:/Program Files/node.exe", "C:/x/cli.js", "a b", "--flag"]);
  assert.deepEqual(tokenizeCommandLine(null), []);
  // a bash -c wrapper that quotes BOTH strings inside one argument: argv[0] is not node.exe and there is no separate token
  const bashWrap = 'C:/Program Files/Git/bin/bash.exe -c "node ' + CLI_JS + ' serve --daemon-child"';
  assert.equal(verifyRow(row(10, bashWrap, NOW, "bash.exe"), {}).ok, false, "bash wrapper (Name is not node.exe)");
  assert.equal(verifyRow(row(10, bashWrap, NOW, "node.exe"), {}).ok, false, "even a node.exe Name cannot make a wrapper's single quoted argument verify");
  assert.equal(verifyRow(row(10, 'node.exe -e "console.log(1)" ' + q(CLI_JS) + " --daemon-child", NOW), {}).ok, false, "argv[1] is -e, not the cli.js");
  assert.equal(verifyRow(row(10, "node.exe " + CLI_JS + " serve --daemon-child-x"), {}).ok, false, "--daemon-child-x is not --daemon-child");
  assert.equal(verifyRow(row(10, "node.exe " + CLI_JS + " serve --daemon-child=1"), {}).ok, false, "a prefix is not a whole argument");
  assert.equal(verifyRow(row(10, "node.exe C:/other/script.js " + CLI_JS + " --daemon-child"), {}).ok, false, "the cli.js as a later argument of another script");
  assert.equal(verifyRow(row(10, "node.exe C:/other/script.js --daemon-child"), {}).ok, false, "another node script");
  assert.equal(verifyRow(row(10, cmd(), NOW, "notnode.exe"), {}).ok, false, "Name must be exactly node.exe");
  assert.equal(verifyRow(row(10, cmd(), NOW, "NODE.EXE"), {}).ok, true, "Name is case-insensitive");
  assert.equal(verifyRow(row(10, "node.exe " + CLI_JS.toUpperCase().replaceAll(path.sep, "/") + " serve --daemon-child"), {}).ok, true, "case/slash tolerant argv[1]");
  assert.equal(verifyRow(row(10, "node.exe"), {}).ok, false);
});

test("findSandboxDaemons (sec M2): the CreationDate gate applies when startedAt is known; without it the tokenised match alone decides", () => {
  const table = [row(101, cmd(), NOW), row(102, cmd(), NOW - 86_400_000), row(103, "node.exe " + CLI_JS + " serve --daemon-child-x", NOW)];
  assert.deepEqual(findSandboxDaemons(table, CLI_JS, { startedAtMs: NOW }), [101], "the day-old process is excluded");
  assert.deepEqual(findSandboxDaemons(table), [101, 102], "no startedAt: command line only (the caller says so)");
});

test("stopVerified: kills only a verified pid; a recycled pid is 'not-ours: skipped'; a dead pid is 'gone'; bad pids refuse", () => {
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const table = [row(101, cmd()), row(102, "C:\\Windows\\System32\\svchost.exe -k netsvcs"), row(103, cmd(), NOW - 86_400_000)];
  assert.deepEqual(stopVerified(101, { table, kill, startedAtMs: NOW }), { stopped: true });
  const recycled = stopVerified(102, { table, kill, startedAtMs: NOW });
  assert.equal(recycled.skipped, "not-ours: skipped");
  const stale = stopVerified(103, { table, kill, startedAtMs: NOW });
  assert.equal(stale.skipped, "not-ours: skipped");
  assert.deepEqual(stopVerified(999, { table, kill, startedAtMs: NOW }), { gone: true });
  assert.deepEqual(killed, [101], "only the verified pid was killed");
  for (const bad of [0, -5, 1.5, NaN, "12"]) assert.throws(() => stopVerified(bad, { table, kill }), /refusing to stop pid/);
  assert.deepEqual(findSandboxDaemons([...table, row(104, cmd().replace(CLI_JS, "C:\\other\\cli.js"))]), [101, 103]);
});

test("stopOwnedChild (start31 failure branch): an already-exited child is never signalled by pid; a live one is verified, else only its handle is killed", () => {
  const killed = [];
  const kill = (pid) => killed.push(pid);
  const handleKills = [];
  const mk = (over) => ({ pid: 201, exitCode: null, signalCode: null, kill: () => handleKills.push(201), ...over });
  assert.deepEqual(stopOwnedChild(mk({ exitCode: 1 }), { launchedAtMs: NOW, table: [row(201, cmd())], kill }), { alreadyExited: true });
  assert.deepEqual(stopOwnedChild(mk({ signalCode: "SIGTERM" }), { launchedAtMs: NOW, table: [row(201, cmd())], kill }), { alreadyExited: true });
  assert.deepEqual(stopOwnedChild(undefined, {}), { alreadyExited: true });
  assert.deepEqual(killed, []);
  assert.deepEqual(stopOwnedChild(mk(), { launchedAtMs: NOW, table: [row(201, cmd())], kill }), { stopped: true });
  assert.deepEqual(killed, [201]);
  const odd = stopOwnedChild(mk(), { launchedAtMs: NOW, table: [row(201, "something else")], kill });
  assert.equal(odd.killedHandleOnly, true);
  assert.deepEqual(killed, [201], "no pid-based kill when identity disagrees");
  assert.deepEqual(handleKills, [201]);
});

test("stopOwnedChild (code H1/sec M1): a throwing table read, a missing row, or a failing taskkill still kills a LIVE handle; an exited child is never killed", () => {
  const killed = [], handleKills = [];
  const kill = (pid) => killed.push(pid);
  const mk = (over) => ({ pid: 301, exitCode: null, signalCode: null, kill: () => handleKills.push(301), ...over });
  const boom = () => { throw new Error("powershell failed"); };
  // table read throws (readProcessTable is what runs when no table is injected; simulate through a getter)
  const throwingTable = { find: boom };
  const r1 = stopOwnedChild(mk(), { launchedAtMs: NOW, table: throwingTable, kill });
  assert.equal(r1.killedHandleOnly, true);
  assert.match(r1.error, /powershell failed/);
  assert.deepEqual(handleKills, [301]);
  // empty table row while the handle is alive
  const r2 = stopOwnedChild(mk(), { launchedAtMs: NOW, table: [], kill });
  assert.deepEqual([r2.gone, r2.killedHandleOnly], [true, true]);
  assert.deepEqual(handleKills, [301, 301]);
  // taskkill itself fails
  const r3 = stopOwnedChild(mk(), { launchedAtMs: NOW, table: [row(301, cmd())], kill: boom });
  assert.equal(r3.killedHandleOnly, true);
  assert.deepEqual(handleKills, [301, 301, 301]);
  // already exited (either code): nothing is killed, by pid or handle, even with a matching/empty/throwing table
  for (const dead of [{ exitCode: 0 }, { signalCode: "SIGKILL" }]) {
    for (const table of [[row(301, cmd())], [], throwingTable]) assert.deepEqual(stopOwnedChild(mk(dead), { launchedAtMs: NOW, table, kill }), { alreadyExited: true });
  }
  assert.deepEqual(handleKills, [301, 301, 301]);
  assert.deepEqual(killed, [], "no pid-based kill in any of these");
  // a healthy verified stop does not ALSO kill the handle
  assert.deepEqual(stopOwnedChild(mk(), { launchedAtMs: NOW, table: [row(301, cmd())], kill }), { stopped: true });
  assert.deepEqual([killed, handleKills.length], [[301], 3]);
});

// ---------- restore kit, deleteSandbox, autoClean ----------
const fakeFs = (files) => ({
  exists: () => true,
  realpath: (p) => p,
  lstat: (p) => ({ isSymbolicLink: () => files.get(p) === "link", isDirectory: () => files.get(p) === "dir" }),
});

test("deleteSandbox: default keeps the install and evidence logs (incl. rotated *.prev-*); purge removes everything; retries x3", async () => {
  const root = "C:\\fake\\root";
  const entries = ["home", "roaming", "local", "tmp", "backup", "npm", "npm-cache", "empty.npmrc", "violations.log", "guard-loaded.log", "violations.log.prev-2026-09-30T10-00-00-000Z", "run"];
  const removed = [];
  const rm = (p) => removed.push(path.basename(p));
  const deps = { rm, list: () => entries, ...fakeFs(new Map()) };
  assert.equal(await deleteSandbox(root, deps), true);
  assert.deepEqual(removed.sort(), ["backup", "home", "local", "roaming", "tmp"]);
  for (const keep of PRESERVE) assert.ok(!removed.includes(keep), keep);
  assert.ok(!removed.some((n) => /\.prev-/.test(n)), "rotated evidence survives a normal teardown");
  removed.length = 0;
  assert.equal(await deleteSandbox(root, { ...deps, preserve: ["backup", ...PRESERVE] }), true);
  assert.ok(!removed.includes("backup"), "the restore kit is preserved when asked");
  removed.length = 0;
  assert.equal(await deleteSandbox(root, { ...deps, preserve: [] }), true);
  assert.equal(removed.at(-1), "root", "purge removes the root itself");
  assert.ok(removed.some((n) => /\.prev-/.test(n)), "purge removes rotated logs too");
  let n = 0;
  const flaky = () => { if (++n < 3) throw new Error("EBUSY"); };
  assert.equal(await deleteSandbox(root, { ...deps, rm: flaky, list: () => ["home"] }), true);
  assert.equal(n, 3);
  assert.equal(await deleteSandbox(root, { ...deps, rm: () => { throw new Error("EBUSY"); }, list: () => ["home"] }), false);
}, { timeout: 15000 });

test("deleteSandbox (code LOW): absent root returns early; a root whose realpath differs is refused; reparse points are skipped, never deleted through", async () => {
  const root = "C:\\fake\\root";
  const removed = [];
  const rm = (p) => removed.push(path.basename(p));
  assert.equal(await deleteSandbox(root, { rm, exists: () => false, list: () => { throw new Error("must not list"); } }), true);
  assert.deepEqual(removed, []);
  assert.equal(await deleteSandbox(root, { rm, list: () => ["home"], exists: () => true, realpath: () => "D:\\elsewhere", lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => false }) }), false);
  assert.deepEqual(removed, [], "nothing deleted when the root is a junction to somewhere else");
  const files = new Map([[path.join(root, "roaming"), "link"], [path.join(root, "home"), "dir"], [path.join(root, "home", "inner"), "link"], [path.join(root, "tmp"), "file"]]);
  const list = (dir) => (dir === root ? ["roaming", "home", "tmp"] : dir === path.join(root, "home") ? ["inner"] : []);
  assert.equal(await deleteSandbox(root, { rm, list, ...fakeFs(files) }), false, "incomplete deletion is reported");
  assert.deepEqual(removed, ["tmp"], "the top-level junction and the directory hiding a nested junction were skipped");
});

test("removeBackup: only inside the sandbox root, never through a reparse point", () => {
  const removed = [];
  const rm = (p) => removed.push(p);
  assert.equal(removeBackup(path.join(TRIAL_ROOT, "backup"), { rm, exists: () => true, lstat: () => ({ isSymbolicLink: () => false }) }), true);
  assert.deepEqual(removed, [path.join(TRIAL_ROOT, "backup")]);
  assert.throws(() => removeBackup("C:\\Users\\osami\\.claude", { rm, exists: () => true, lstat: () => ({ isSymbolicLink: () => false }) }), /outside the sandbox root/);
  assert.throws(() => removeBackup(path.join(TRIAL_ROOT, "backup"), { rm, exists: () => true, lstat: () => ({ isSymbolicLink: () => true }) }), /reparse point/);
  assert.equal(removeBackup(path.join(TRIAL_ROOT, "backup"), { rm, exists: () => false }), true);
  assert.equal(removed.length, 1);
});

test("autoClean (sec H2/M7): the daemon is stopped FIRST, then PATH is restored, then the sandbox is deleted; failures are isolated; a skipped pid is reported", async () => {
  const order = [];
  const ctx = {
    savedPath: SAVED, pids: [11, 22, 33],
    restore: (s) => { order.push(["restore", s]); return { restored: true, removed: 1 }; },
    stop: (pid) => { order.push(["stop", pid]); if (pid === 11) throw new Error("taskkill failed"); if (pid === 22) return { skipped: "not-ours: skipped", why: "x" }; return { stopped: true }; },
    deletor: async (o) => { order.push(["delete", o.pathOk]); return true; },
  };
  const actions = await autoClean(ctx);
  assert.deepEqual(order.map((o) => o[0]), ["stop", "stop", "stop", "restore", "delete"], "stop precedes restore precedes delete");
  assert.deepEqual(actions.map((a) => a[0]), ["stop-error", "skipped", "stopped", "path", "sandbox-deleted", "path-ok"]);
  assert.equal(actions[1][2], "not-ours: skipped");
  assert.deepEqual(actions.at(-1), ["path-ok", true]);
  assert.deepEqual(order.at(-1), ["delete", true]);
  const failing = await autoClean({ ...ctx, pids: [], restore: () => { throw new Error("reg denied"); }, deletor: async (o) => { order.push(["delete", o.pathOk]); return true; } });
  assert.deepEqual(failing.at(-1), ["path-ok", false], "a failed PATH restore is reported so the kit is kept");
  assert.deepEqual(order.at(-1), ["delete", false]);
  const unreadable = await autoClean({ ...ctx, pids: [], restore: () => ({ restored: false, reason: "unreadable" }) });
  assert.deepEqual(unreadable.at(-1), ["path-ok", false]);
  const clean = await autoClean({ ...ctx, pids: [], restore: () => ({ restored: false, reason: NO_SANDBOX_SEGMENT }) });
  assert.deepEqual(clean.at(-1), ["path-ok", true]);
});

test("assertOrClean appends the actions and rethrows; a passing tripwire does nothing", async () => {
  const order = [];
  const ctx = { pids: [], restore: () => { order.push("restore"); return { restored: false, reason: NO_SANDBOX_SEGMENT }; }, deletor: async () => { order.push("delete"); return true; } };
  await assert.rejects(assertOrClean({ assert() { throw new Error("proxy CHANGED"); } }, "s", ctx), /proxy CHANGED \| auto-clean: \[.*sandbox-deleted/);
  assert.deepEqual(order, ["restore", "delete"]);
  order.length = 0;
  await assertOrClean({ assert() {} }, "s", ctx);
  assert.deepEqual(order, [], "a passing tripwire does nothing");
});

// ---------- small lifecycle helpers ----------
test("copyVerified (sec M2): temp name, sha compare, rename; an existing copy is re-verified by hash and replaced when it differs", () => {
  const files = new Map([["src.node", Buffer.from("REAL BINDING")]]);
  const fsx = {
    readFileSync: (f) => { if (!files.has(f)) throw new Error("ENOENT " + f); return files.get(f); },
    existsSync: (f) => files.has(f), mkdirSync() {},
    copyFileSync: (a, b) => files.set(b, Buffer.from(files.get(a))),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
    unlinkSync: (f) => files.delete(f),
  };
  assert.equal(copyVerified("src.node", "dst.node", fsx), "copied");
  assert.equal(files.get("dst.node").toString(), "REAL BINDING");
  assert.ok(![...files.keys()].some((k) => k.includes(".tmp-")), "no temp file left behind");
  assert.equal(copyVerified("src.node", "dst.node", fsx), "already-verified");
  files.set("dst.node", Buffer.from("CORRUPT"));
  assert.equal(copyVerified("src.node", "dst.node", fsx), "copied", "a differing existing copy is replaced");
  const torn = { ...fsx, copyFileSync: (a, b) => files.set(b, Buffer.from("TRUNCATED")) };
  files.delete("dst.node");
  assert.throws(() => copyVerified("src.node", "dst.node", torn), /does not match its sha256/);
  assert.equal(files.has("dst.node"), false, "a bad copy is never renamed into place");
  assert.ok(![...files.keys()].some((k) => k.includes(".tmp-")));
});

test("rotateLogs: stale evidence logs move to *.prev-<ts>; absent files are ignored", () => {
  const files = new Set(["v.log", "g.log"]);
  const fsx = { existsSync: (f) => files.has(f), renameSync: (a, b) => { files.delete(a); files.add(b); } };
  assert.deepEqual(rotateLogs(["v.log", "g.log", "missing.log"], "T1", fsx), ["v.log.prev-T1", "g.log.prev-T1"]);
  assert.deepEqual([...files].sort(), ["g.log.prev-T1", "v.log.prev-T1"]);
});

test("applyOwnerOnlyAcl (sec M9): grant by SID FIRST, then remove inheritance, then verify readback; a bad readback throws", () => {
  const calls = [];
  const good = (extra = "") => (f, a) => {
    calls.push([f, ...a]);
    if (f === "whoami") return "\"HOST\\osami\",\"S-1-5-21-1-2-3-1001\"\r\n";
    if (a.length === 1) return `${a[0]} HOST\\osami:(OI)(CI)(F)${extra}\r\n\r\nSuccessfully processed 1 files`;
    return "";
  };
  assert.deepEqual(applyOwnerOnlyAcl("C:\\root", good()), { user: "HOST\\osami", sid: "S-1-5-21-1-2-3-1001" });
  const icacls = calls.filter((c) => c[0] === "icacls").map((c) => c.slice(2).join(" ") || "(readback)");
  assert.deepEqual(icacls, ["/grant:r *S-1-5-21-1-2-3-1001:(OI)(CI)F", "/inheritance:r", "(readback)"], "grant before inheritance removal");
  assert.throws(() => applyOwnerOnlyAcl("C:\\root", good("\r\n      BUILTIN\\Users:(OI)(CI)(RX)")), /exactly one entry/);
  assert.throws(() => applyOwnerOnlyAcl("C:\\root", good("\r\n      NT AUTHORITY\\SYSTEM:(I)(F)")), /inherited entries remain|exactly one entry/);
  assert.throws(() => applyOwnerOnlyAcl("C:\\root", (f) => (f === "whoami" ? "garbage" : "")), /SID/);
  assert.throws(() => applyOwnerOnlyAcl("C:\\root", (f, a) => (f === "whoami" ? "\"HOST\\osami\",\"S-1-5-21-1\"" : a.length === 1 ? "C:\\root HOST\\someone-else:(OI)(CI)(F)" : "")), /does not hold full control/);
});

test("sec M8/code M6: the trip message tells the reader to compare against the pre-trial settings copy", () => {
  const tw = makeTripwire31({ base: okBase, collectors: { "file:x": () => "b" }, baseline: { "file:x": "a" } });
  assert.throws(() => tw.assert("s"), /mtimes and the pre-trial settings copy/);
});

// CCR 3.1.1 trial guard (harness/trial31/guard-core.cjs + preload-guard.cjs).
// Unit layer: the policy and the installer, driven with FAKE fs/net/dns/child_process/
// process modules, so no real fs write, socket, registry or CCR process is involved.
// Integration layer: a tiny canary script run under `node --require preload-guard.cjs`
// in a temp dir (a fake "protected" root and a fake sandbox root); every canary is one
// whose UNBLOCKED outcome is harmless (a file in a temp dir, a refused connect, a
// process-scope env var, taskkill on a non-existent pid).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const TRIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "trial31");
const { TrialViolation, isLoopbackHost, isUnder, createPolicy, install, flagsWrite } = require(path.join(TRIAL, "guard-core.cjs"));

const ROOT = "C:\\t\\root";
const HOME = "C:\\t\\home";
const cfg = (over = {}) => ({
  pid: 1000, root: ROOT, allowWriteRoots: [], portRange: { min: 39456, max: 39489 },
  realPorts: [3456, 3457, 3458, 4517],
  protectedRoots: [`${HOME}\\.claude`, `${HOME}\\.codex`, `${HOME}\\AppData\\Roaming\\claude-code-router`, `${HOME}\\AppData\\Local\\Claude-3p`, `${HOME}\\.uw`],
  ...over,
});
const violation = (fn, kind) => assert.throws(fn, (e) => e instanceof TrialViolation && e.code === "UW_TRIAL31_VIOLATION" && (!kind || e.kind === kind));

test("isLoopbackHost: literals only, no resolution", () => {
  for (const h of ["127.0.0.1", "127.9.9.9", "localhost", "LOCALHOST", "::1", "[::1]", "::ffff:127.0.0.1"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of [undefined, null, "", "0.0.0.0", "::", "10.0.0.5", "api.openai.com", "localhost.evil.com", "127.0.0.1.evil.com", "192.168.1.2"]) assert.equal(isLoopbackHost(h), false, String(h));
});

test("isUnder: boundary-aware, case-insensitive, slash- and \\\\?\\-tolerant", () => {
  assert.equal(isUnder("C:\\a\\b\\c", "C:\\a\\b"), true);
  assert.equal(isUnder("c:/A/B/c", "C:\\a\\b"), true);
  assert.equal(isUnder("\\\\?\\C:\\a\\b\\c", "C:\\a\\b"), true);
  assert.equal(isUnder("C:\\a\\b", "C:\\a\\b"), true);
  assert.equal(isUnder("C:\\a\\bc", "C:\\a\\b"), false, "sibling with a common prefix is not inside");
});

test("policy.listen: only loopback + trial range, never a live port, never all-interfaces", () => {
  const p = createPolicy(cfg());
  p.checkListen({ port: 39468, host: "127.0.0.1" });
  p.checkListen({ port: 39456, host: "localhost" });
  p.checkListen({ port: 39489, host: "::1" });
  p.checkListen({ port: 0, host: "127.0.0.1" }); // OS-assigned loopback port (CCR's free-port probe)
  p.checkListen({ path: "\\\\.\\pipe\\ccr-ipc" });
  for (const port of [3456, 3457, 3458, 4517]) violation(() => p.checkListen({ port, host: "127.0.0.1" }), "listen");
  violation(() => p.checkListen({ port: 39490, host: "127.0.0.1" }), "listen");
  violation(() => p.checkListen({ port: 39455, host: "127.0.0.1" }), "listen");
  violation(() => p.checkListen({ port: 39468 }), "listen"); // host unset = all interfaces
  violation(() => p.checkListen({ port: 39468, host: "0.0.0.0" }), "listen");
  violation(() => p.checkListen({ port: 39468, host: "::" }), "listen");
  violation(() => p.checkListen({ port: 0, host: "0.0.0.0" }), "listen");
  violation(() => p.checkListen({ path: "C:\\somewhere\\x.sock" }), "listen");
  violation(() => p.checkListen({ fd: 3 }), "listen");
  const inRange = createPolicy(cfg({ realPorts: [39460] }));
  violation(() => inRange.checkListen({ port: 39460, host: "127.0.0.1" }), "listen");
});

test("policy.connect/dns: airgap, loopback only", () => {
  const p = createPolicy(cfg());
  // loopback AND inside the trial range; a host-less connect defaults to localhost and is held to the same rules
  for (const o of [{ host: "127.0.0.1", port: 39470 }, { host: "localhost", port: 39470 }, { host: "::1", port: 39456 }, { port: 39470 }, { port: "39489" }, { path: "\\\\.\\pipe\\x" }]) p.checkConnect(o);
  for (const host of ["api.openai.com", "93.184.216.34", "8.8.8.8", "0.0.0.0", "generativelanguage.googleapis.com"]) violation(() => p.checkConnect({ host, port: 443 }), "connect");
  // sec H1: the live gateway ports and every other local service are unreachable, whatever the host spelling
  for (const port of [3456, 3457, 3458, 4517]) {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "127.9.9.9", "::ffff:127.0.0.1", undefined]) {
      violation(() => p.checkConnect({ host, port }), "connect");
    }
  }
  for (const port of [1, 53, 80, 39455, 39490, 65535]) violation(() => p.checkConnect({ host: "127.0.0.1", port }), "connect");
  for (const o of [{ host: "127.0.0.1" }, { host: "127.0.0.1", port: "abc" }, { host: "127.0.0.1", port: 39470.5 }, {}]) violation(() => p.checkConnect(o), "connect");
  violation(() => p.checkConnect({ host: "localhost", port: 39470, lookup: () => {} }), "connect");
  const inRange = createPolicy(cfg({ realPorts: [39460] }));
  violation(() => inRange.checkConnect({ host: "127.0.0.1", port: 39460 }), "connect");
  p.checkHostname("localhost", "dns.lookup");
  p.checkHostname(undefined, "dns.lookup");
  violation(() => p.checkHostname("api.anthropic.com", "dns.lookup"), "dns");
});

test("policy.write: default-deny outside the sandbox root; protected roots by name; traversal, casing, prefix traps", () => {
  const p = createPolicy(cfg());
  p.checkWrite(`${ROOT}\\home\\.claude\\settings.json`, "t"); // the SANDBOX's own .claude is fine
  p.checkWrite(`${ROOT}\\roaming\\claude-code-router\\config.sqlite`, "t");
  p.checkWrite("C:\\t\\root/tmp/x.txt", "t");
  p.checkWrite(7, "t"); // fd
  p.checkWrite(undefined, "t");
  p.checkWrite("NUL", "t");
  p.checkWrite("\\\\.\\nul", "t");
  const denied = [
    `${HOME}\\.claude\\settings.json`, `${HOME}\\.CLAUDE\\settings.local.json`, `${HOME}/.claude/settings.json`,
    `\\\\?\\${HOME}\\.claude\\settings.json`, `${HOME}\\.codex\\config.toml`,
    `${HOME}\\AppData\\Roaming\\claude-code-router\\service.json`, `${HOME}\\AppData\\Local\\Claude-3p\\x.json`,
    `${ROOT}\\..\\home\\.claude\\settings.json`, `${ROOT}\\tmp\\..\\..\\home\\.codex\\config.toml`,
    `${HOME}\\.uw\\keysync\\run.mjs`,
    `${HOME}\\.claude-evil\\x`, // not protected by name, still outside the sandbox root
    "C:\\t\\rootx\\file", // sibling sharing the root's prefix
    "C:\\Windows\\System32\\drivers\\etc\\hosts", "C:\\Users\\other\\Downloads\\k.json",
  ];
  for (const d of denied) violation(() => p.checkWrite(d, "fs.writeFileSync"), "write");
  violation(() => p.checkWrite(Buffer.from(`${HOME}\\.claude\\settings.json`), "t"), "write");
  violation(() => p.checkWrite(new URL("file:///C:/t/home/.claude/settings.json"), "t"), "write");
  assert.throws(() => p.checkWrite(`${HOME}\\.claude\\x`, "op"), /protected root/);
});

test("policy.write: a junction/symlink into a protected root is judged by its target", () => {
  const map = new Map([[`${ROOT}\\link`.toLowerCase(), `${HOME}\\.claude`]]);
  const realpath = (q) => { const hit = map.get(q.toLowerCase()); if (hit) return hit; if (q.toLowerCase().startsWith(ROOT.toLowerCase())) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return q; };
  const p = createPolicy(cfg({ realpath }));
  violation(() => p.checkWrite(`${ROOT}\\link\\settings.json`, "t"), "write");
  p.checkWrite(`${ROOT}\\plain\\file.txt`, "t");
});

test("policy.kill: only self and tracked children; probes (signal 0) always ok", () => {
  const p = createPolicy(cfg());
  p.checkKill(1000, "SIGTERM");
  p.checkKill(9664, 0);
  p.checkKill(9664, "0");
  violation(() => p.checkKill(9664, "SIGTERM"), "kill");
  violation(() => p.checkKill(9664), "kill");
  violation(() => p.checkKill(-9664, "SIGKILL"), "kill");
  p.tracked.add(555);
  p.checkKill(555, "SIGKILL");
});

test("policy.spawn: registry / PATH / proxy / cert / scheduler writers denied; benign commands pass", () => {
  const p = createPolicy(cfg());
  const ok = [
    ["node", ["-e", "1"]], ["C:\\Program Files\\nodejs\\node.exe", ["cli.js", "serve"]],
    ["reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings", "/v", "ProxyEnable"]],
    ["powershell.exe", ["-NoProfile", "-Command", "Get-Process | Select Id"]],
    ["certutil.exe", ["-user", "-store", "Root", "abc"]], ["netsh.exe", ["winhttp", "show", "proxy"]],
    ["where.exe", ["claude"]],
  ];
  for (const [f, a] of ok) p.checkSpawn(f, a, false);
  const bad = [
    ["reg.exe", ["add", "HKCU\\Environment", "/v", "Path", "/d", "x", "/f"]], ["reg", ["delete", "HKCU\\Software\\X", "/f"]],
    ["C:\\Windows\\System32\\reg.exe", ["import", "x.reg"]], ["setx", ["PATH", "x"]], ["setx.exe", ["A", "b"]],
    ["powershell.exe", ["-NoProfile", "-Command", "[Environment]::SetEnvironmentVariable('Path','x','User')"]],
    ["pwsh", ["-c", "Set-ItemProperty -Path HKCU:\\Environment -Name Path -Value x"]],
    ["powershell", ["-Command", "New-ItemProperty HKCU:\\Software\\X"]],
    ["powershell", ["-Command", "$sig='[DllImport(\"wininet.dll\")] static extern bool InternetSetOption(...)'"]],
    ["certutil.exe", ["-user", "-addstore", "Root", "ca.cer"]], ["certutil", ["-delstore", "Root", "x"]], ["certutil", ["-user", "-importpfx", "x.pfx"]],
    ["netsh.exe", ["winhttp", "set", "proxy", "proxy-server=x"]], ["netsh", ["winhttp", "reset", "proxy"]],
    ["schtasks", ["/create", "/tn", "x"]], ["regedit", ["/s", "x.reg"]], ["icacls", ["C:\\x", "/grant", "a:F"]], ["sc.exe", ["create", "x"]],
    ["taskkill.exe", ["/PID", "9664", "/T", "/F"]], ["taskkill", ["/IM", "node.exe", "/F"]],
  ];
  for (const [f, a] of bad) violation(() => p.checkSpawn(f, a, false), "spawn");
  // command-line (exec / shell) forms
  for (const line of ["reg add HKCU\\Environment /v Path /d x /f", "cmd /c setx A b", "\"C:\\Windows\\System32\\reg.exe\" add HKCU\\X", "cmd.exe /c certutil -user -addstore Root x.cer", "taskkill /IM node.exe"]) {
    violation(() => p.checkSpawn(line, [], true), "spawn");
  }
  p.checkSpawn("echo hello", [], true);
  p.checkSpawn("reg query HKCU\\Environment /v Path", [], true);
  p.tracked.add(777);
  p.checkSpawn("taskkill.exe", ["/PID", "777", "/T", "/F"], false);
  p.checkSpawn("taskkill /PID 1000 /F", [], true);
});

test("flagsWrite: string and numeric open flags", () => {
  for (const f of ["w", "wx", "a", "a+", "r+", "rs+", "w+"]) assert.equal(flagsWrite(f), true, f);
  for (const f of ["r", "rs", undefined, null]) assert.equal(flagsWrite(f), false, String(f));
  assert.equal(flagsWrite(0, { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 }), false);
  assert.equal(flagsWrite(1, { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 }), true);
  assert.equal(flagsWrite(2 | 256, { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 }), true);
});

// ---------- installer against fakes ----------
const FS_NAMES = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "truncate", "truncateSync", "unlink", "unlinkSync", "rmdir", "rmdirSync", "rm", "rmSync",
  "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "symlink", "symlinkSync", "link", "linkSync",
  "chmod", "chmodSync", "chown", "chownSync", "lchown", "lchownSync", "utimes", "utimesSync", "lutimes", "lutimesSync", "createWriteStream", "open", "openSync"];
const PROMISE_NAMES = ["writeFile", "appendFile", "truncate", "unlink", "rmdir", "rm", "mkdir", "mkdtemp", "rename", "copyFile", "cp", "symlink", "link", "chmod", "chown", "lchown", "utimes", "lutimes", "open"];

function fakes() {
  const calls = [];
  const rec = (name) => function (...args) { calls.push([name, ...args]); return `real:${name}`; };
  const fsm = { constants: { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 }, promises: {} };
  for (const n of FS_NAMES) fsm[n] = rec(`fs.${n}`);
  for (const n of PROMISE_NAMES) fsm.promises[n] = (...a) => { calls.push([`fsp.${n}`, ...a]); return Promise.resolve(`real:${n}`); };
  class Server { listen(...a) { calls.push(["net.listen", ...a]); return this; } }
  class Socket { connect(...a) { calls.push(["net.connect", ...a]); return this; } }
  const dns = { lookup: rec("dns.lookup"), resolve: rec("dns.resolve"), resolve4: rec("dns.resolve4"), resolve6: rec("dns.resolve6"), promises: {} };
  for (const n of ["lookup", "resolve", "resolve4", "resolve6"]) dns.promises[n] = (...a) => { calls.push([`dnsp.${n}`, ...a]); return Promise.resolve("ok"); };
  class DgramSocket { send(...a) { calls.push(["dgram.send", ...a]); } connect(...a) { calls.push(["dgram.connect", ...a]); } bind(...a) { calls.push(["dgram.bind", ...a]); } }
  let nextPid = 4000;
  const cp = {};
  for (const n of ["spawn", "execFile", "fork", "exec"]) cp[n] = (...a) => { calls.push([`cp.${n}`, ...a]); return { pid: ++nextPid }; };
  for (const n of ["spawnSync", "execFileSync", "execSync"]) cp[n] = (...a) => { calls.push([`cp.${n}`, ...a]); return Buffer.from(""); };
  const proc = { execPath: "C:\\node.exe", env: { PATH: "C:\\p", NODE_OPTIONS: "--require C:/evil.js" }, kill: (...a) => { calls.push(["process.kill", ...a]); return true; } };
  const log = [];
  const childEnv = { NODE_OPTIONS: "--require C:/g/preload-guard.cjs", UW_TRIAL31_ROOT: ROOT };
  const mods = { fs: fsm, net: { Server, Socket }, dns, dgram: { Socket: DgramSocket }, child_process: cp, process: proc };
  return { calls, mods, log, config: cfg({ log: (kind, extra) => log.push({ kind, ...extra }), childEnv }), Server, Socket, DgramSocket };
}
const callNames = (f) => f.calls.map((c) => c[0]);

test("install: every fs mutator blocks protected paths BEFORE reaching the real function, and logs", async () => {
  const f = fakes();
  install(f.mods, f.config);
  const prot = `${HOME}\\.claude\\settings.json`;
  const ok = `${ROOT}\\tmp\\a.txt`;
  const idxs = { rename: [prot, ok], renameSync: [prot, ok], copyFile: [ok, prot], copyFileSync: [ok, prot], cp: [ok, prot], cpSync: [ok, prot], symlink: [ok, prot], symlinkSync: [ok, prot], link: [ok, prot], linkSync: [ok, prot] };
  for (const n of FS_NAMES.filter((x) => !["open", "openSync"].includes(x))) {
    violation(() => f.mods.fs[n](...(idxs[n] ?? [prot, "data"])), "write");
  }
  for (const n of PROMISE_NAMES.filter((x) => x !== "open")) {
    await assert.rejects(f.mods.fs.promises[n](...(idxs[n] ?? [prot, "data"])), (e) => e instanceof TrialViolation, `fs.promises.${n}`);
  }
  assert.deepEqual(f.calls, [], "no blocked call reached the real implementation");
  assert.ok(f.log.length >= FS_NAMES.length, "violations are logged");
  assert.ok(f.log.every((l) => l.kind === "violation"));
  // hard-link/rename FROM a protected file is also refused (alias / move-out)
  violation(() => f.mods.fs.renameSync(prot, ok), "write");
  violation(() => f.mods.fs.linkSync(prot, ok), "write");
  // reading a protected file into the sandbox is not a write
  f.mods.fs.copyFileSync(prot, ok);
  f.mods.fs.cpSync(prot, ok);
  assert.deepEqual(callNames(f), ["fs.copyFileSync", "fs.cpSync"]);
});

test("install: allowed writes inside the sandbox pass through unchanged", async () => {
  const f = fakes();
  install(f.mods, f.config);
  const ok = `${ROOT}\\home\\.claude\\settings.json`;
  assert.equal(f.mods.fs.writeFileSync(ok, "x"), "real:fs.writeFileSync");
  assert.equal(await f.mods.fs.promises.writeFile(ok, "x"), "real:writeFile");
  f.mods.fs.mkdirSync(`${ROOT}\\d`, { recursive: true });
  f.mods.fs.renameSync(`${ROOT}\\a`, `${ROOT}\\b`);
  assert.deepEqual(callNames(f), ["fs.writeFileSync", "fsp.writeFile", "fs.mkdirSync", "fs.renameSync"]);
  assert.deepEqual(f.log, []);
});

test("install: open()/createWriteStream by flags - reads pass, writes are checked", async () => {
  const f = fakes();
  install(f.mods, f.config);
  const prot = `${HOME}\\.codex\\config.toml`;
  f.mods.fs.openSync(prot, "r");
  f.mods.fs.openSync(prot);
  f.mods.fs.open(prot, () => {});
  f.mods.fs.open(prot, "r", () => {});
  await f.mods.fs.promises.open(prot, "r");
  assert.equal(f.calls.length, 5);
  for (const flags of ["w", "a", "r+", "wx", 1, 2, 256]) violation(() => f.mods.fs.openSync(prot, flags), "write");
  violation(() => f.mods.fs.open(prot, "w", () => {}), "write");
  await assert.rejects(f.mods.fs.promises.open(prot, "a"), TrialViolation);
  f.mods.fs.openSync(`${ROOT}\\ok.txt`, "w");
  assert.equal(f.calls.length, 6);
});

test("install: net.listen / net.connect / dns / dgram", async () => {
  const f = fakes();
  install(f.mods, f.config);
  const srv = new f.Server(), sock = new f.Socket(), udp = new f.DgramSocket();
  srv.listen(39468, "127.0.0.1", () => {});
  srv.listen({ port: 39469, host: "127.0.0.1" });
  srv.listen("39470", "localhost");
  srv.listen(0, "127.0.0.1");
  for (const a of [[3456, "127.0.0.1"], [3458], [{ port: 3457, host: "127.0.0.1" }], [39468], [39468, "0.0.0.0"], [{ port: 39468 }], [39999, "127.0.0.1"], [], [{ fd: 4 }]]) {
    violation(() => srv.listen(...a), "listen");
  }
  sock.connect(39470, "127.0.0.1");
  sock.connect({ host: "localhost", port: 39469 });
  sock.connect(39470);
  for (const a of [[3456], [3456, "127.0.0.1"], [{ host: "localhost", port: 3456 }], [{ host: "::1", port: 3458 }], [[{ port: 4517 }, null]], [{ port: 3457, host: "127.0.0.1" }]]) violation(() => sock.connect(...a), "connect");
  sock.connect("\\\\.\\pipe\\x");
  violation(() => sock.connect({ host: "api.openai.com", port: 443 }), "connect");
  violation(() => sock.connect(443, "93.184.216.34"), "connect");
  const normalized = [{ host: "192.0.2.1", port: 80 }, null]; // what net.connect() passes to Socket#connect
  violation(() => sock.connect(normalized), "connect");
  sock.connect([{ host: "127.0.0.1", port: 39470 }, null]);
  violation(() => sock.connect({ host: "10.0.0.1", port: 80, lookup: () => {} }), "connect");
  f.mods.dns.lookup("localhost", () => {});
  violation(() => f.mods.dns.lookup("api.anthropic.com", () => {}), "dns");
  violation(() => f.mods.dns.resolve4("example.com"), "dns");
  await f.mods.dns.promises.lookup("127.0.0.1");
  await assert.rejects(f.mods.dns.promises.lookup("example.com"), TrialViolation);
  udp.send(Buffer.from("x"), 39470, "127.0.0.1");
  violation(() => udp.send(Buffer.from("x"), 53, "127.0.0.1"), "connect", "loopback but outside the trial range");
  violation(() => udp.send(Buffer.from("x"), 53, "8.8.8.8"), "connect");
  violation(() => udp.send("payload", 0, 7, 53, "1.1.1.1"), "connect");
  violation(() => udp.connect(53, "8.8.4.4"), "connect");
  violation(() => udp.connect(3456, "127.0.0.1"), "connect");
  violation(() => udp.bind(39470), "listen"); // no address = all interfaces
  violation(() => udp.bind({ port: 39470 }), "listen");
  violation(() => udp.bind(3456, "127.0.0.1"), "listen");
  udp.bind(39470, "127.0.0.1");
  udp.bind({ port: 39471, address: "::1" });
  assert.deepEqual(callNames(f), ["net.listen", "net.listen", "net.listen", "net.listen", "net.connect", "net.connect", "net.connect", "net.connect", "net.connect",
    "dns.lookup", "dnsp.lookup", "dgram.send", "dgram.bind", "dgram.bind"]);
});

test("install: child_process denies writers, tracks children, and re-injects the preload into env-bearing spawns", () => {
  const f = fakes();
  install(f.mods, f.config);
  const cp = f.mods.child_process;
  violation(() => cp.spawn("reg.exe", ["add", "HKCU\\Environment", "/f"]), "spawn");
  violation(() => cp.spawnSync("powershell.exe", ["-Command", "[Environment]::SetEnvironmentVariable('Path','x','User')"]), "spawn");
  violation(() => cp.exec("setx A b"), "spawn");
  violation(() => cp.execSync("cmd /c reg add HKCU\\X /f"), "spawn");
  violation(() => cp.execFile("certutil.exe", ["-user", "-addstore", "Root", "x.cer"]), "spawn");
  violation(() => cp.spawn("cmd.exe", ["/c", "netsh winhttp set proxy x"], { shell: true }), "spawn");
  assert.deepEqual(f.calls, [], "nothing reached the real child_process");
});

test("install: fork of a benign script passes and is tracked; taskkill of a tracked child is allowed", () => {
  const f = fakes();
  install(f.mods, f.config);
  const cp = f.mods.child_process;
  const child = cp.spawn("node", ["a.js"], { env: { SystemRoot: "C:\\Windows" } });
  assert.equal(child.pid, 4001);
  const sent = f.calls.find((c) => c[0] === "cp.spawn");
  assert.match(sent[3].env.NODE_OPTIONS, /--require C:\/g\/preload-guard\.cjs/);
  assert.equal(sent[3].env.UW_TRIAL31_ROOT, ROOT);
  assert.equal(sent[3].env.SystemRoot, "C:\\Windows");
  // options straight after the command (args omitted)
  cp.spawn("node", { env: { A: "1" } });
  assert.match(f.calls.at(-1)[2].env.NODE_OPTIONS, /preload-guard/);
  // an env that already has the preload is not doubled
  cp.spawn("node", [], { env: { NODE_OPTIONS: "--require C:/g/preload-guard.cjs --max-old-space-size=512" } });
  const n = f.calls.at(-1)[3].env.NODE_OPTIONS;
  assert.equal(n.split("preload-guard").length - 1, 1);
  // no env in options: an explicit env is synthesised from process.env with the guard values forced over it
  cp.spawn("node", [], {});
  assert.equal(f.calls.at(-1)[3].env.NODE_OPTIONS, "--require C:/g/preload-guard.cjs");
  assert.equal(f.calls.at(-1)[3].env.PATH, "C:\\p");
  cp.spawn("node", ["x.js"]); // no options object at all
  assert.equal(f.calls.at(-1)[3].env.NODE_OPTIONS, "--require C:/g/preload-guard.cjs");
  cp.execFile("node", ["x.js"], () => {}); // callback where the options would be
  assert.equal(f.calls.at(-1)[3].env.UW_TRIAL31_ROOT, ROOT);
  assert.equal(typeof f.calls.at(-1)[4], "function");
  cp.exec("echo hi", () => {});
  assert.equal(f.calls.at(-1)[2].env.NODE_OPTIONS, "--require C:/g/preload-guard.cjs");
  // L4: the caller's values for NODE_OPTIONS and UW_TRIAL31_* are never trusted
  cp.spawn("node", [], { env: { NODE_OPTIONS: "--require C:/evil.js", UW_TRIAL31_ROOT: "C:\\" } });
  const forced = f.calls.at(-1)[3].env;
  assert.equal(forced.NODE_OPTIONS, "--require C:/g/preload-guard.cjs");
  assert.equal(forced.UW_TRIAL31_ROOT, ROOT);
  cp.execFile("taskkill.exe", ["/PID", "4001", "/T", "/F"]);
  violation(() => cp.execFile("taskkill.exe", ["/PID", "9664", "/T", "/F"]), "spawn");
  cp.fork("worker.js", ["--x"], { env: { A: "1" } });
  const forked = f.calls.at(-1);
  assert.equal(forked[0], "cp.fork");
  assert.match(forked[3].env.NODE_OPTIONS, /preload-guard/);
  assert.equal(cp.execSync("echo hi").toString(), "");
});

test("install: process.kill only for self/tracked children; probes pass", () => {
  const f = fakes();
  install(f.mods, f.config);
  f.mods.process.kill(9664, 0);
  violation(() => f.mods.process.kill(9664, "SIGTERM"), "kill");
  violation(() => f.mods.process.kill(22100), "kill");
  const child = f.mods.child_process.spawn("node", ["x"]);
  f.mods.process.kill(child.pid, "SIGTERM");
  f.mods.process.kill(1000, "SIGTERM");
  assert.deepEqual(f.calls.filter((c) => c[0] === "process.kill").map((c) => c[1]), [9664, child.pid, 1000]);
});

test("install: omitted modules are skipped (the installer is total over its inputs)", () => {
  const { policy } = install({}, cfg());
  assert.equal(typeof policy.checkWrite, "function");
});

// ---------- integration: the real preload in a real node process, temp dirs only ----------
const PRELOAD = path.join(TRIAL, "preload-guard.cjs").replace(/\\/g, "/");
function mkTemp() { return mkTmp("uw-trial31-test-"); }
function guardedEnv(root, prot) {
  return {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec,
    NODE_OPTIONS: `--require ${PRELOAD}`, UW_TRIAL31_PRELOAD_ARG: `--require ${PRELOAD}`,
    UW_TRIAL31_ROOT: root, UW_TRIAL31_PORT_RANGE: "39456-39457", UW_TRIAL31_REAL_PORTS: "3456,3457,3458,4517",
    UW_TRIAL31_PROTECTED: prot,
  };
}

test("preload: refuses to run unguarded when unconfigured", () => {
  const r = spawnSync(process.execPath, ["--require", PRELOAD, "-e", "console.log('ran')"], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refusing to run unguarded/);
  assert.doesNotMatch(r.stdout, /ran/);
});

test("preload: canaries in a real node process are blocked with no side effect", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox");
    const prot = path.join(dir, "real-home", ".claude");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(prot, { recursive: true });
    const canary = path.join(dir, "canary.cjs");
    fs.writeFileSync(canary, `
const fs = require('fs'), net = require('net'), dns = require('dns'), cp = require('child_process'), path = require('path');
const [root, prot] = process.argv.slice(2);
const out = [];
const t = async (name, fn) => { try { await fn(); out.push({ name, blocked: false }); } catch (e) { out.push({ name, blocked: e && e.code === 'UW_TRIAL31_VIOLATION', code: e && e.code }); } };
(async () => {
  await t('write-protected', () => fs.writeFileSync(path.join(prot, 'settings.json'), '{}'));
  await t('write-sandbox', () => fs.writeFileSync(path.join(root, 'ok.txt'), 'ok'));
  await t('promises-write-protected', () => fs.promises.writeFile(path.join(prot, 'p.json'), '{}'));
  await t('stream-protected', () => fs.createWriteStream(path.join(prot, 's.json')));
  await t('open-w-protected', () => fs.openSync(path.join(prot, 'o.json'), 'w'));
  await t('mkdir-protected', () => fs.mkdirSync(path.join(prot, 'sub')));
  await t('rename-into-protected', () => { fs.writeFileSync(path.join(root, 'mv.txt'), 'x'); fs.renameSync(path.join(root, 'mv.txt'), path.join(prot, 'mv.txt')); });
  await t('listen-outside-range', () => { const s = net.createServer(); s.listen(39999, '127.0.0.1'); });
  await t('listen-all-interfaces', () => { const s = net.createServer(); s.listen(39456); });
  await t('connect-non-loopback', () => { net.connect({ host: '192.0.2.1', port: 80 }); });
  await t('dns-non-loopback', () => { dns.lookup('example.com', () => {}); });
  await t('registry-style-spawn', () => cp.spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::SetEnvironmentVariable('UW_TRIAL31_CANARY','1','Process')"]));
  await t('taskkill-untracked', () => cp.spawnSync('taskkill.exe', ['/PID', '999999']));
  const child = cp.spawnSync(process.execPath, ['-e', "console.log(String(!!process[Symbol.for('uw.trial31.guard')]))"], { env: { SystemRoot: process.env.SystemRoot }, encoding: 'utf8' });
  out.push({ name: 'child-env-without-preload-still-guarded', guardedChild: child.stdout.trim() });
  process.stdout.write(JSON.stringify(out));
})();
`);
    const r = spawnSync(process.execPath, [canary, root, prot], { env: guardedEnv(root, path.join(dir, "real-home")), encoding: "utf8", timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    const by = Object.fromEntries(res.map((x) => [x.name, x]));
    assert.equal(by["write-sandbox"].blocked, false, "the sandbox itself stays writable");
    for (const n of ["write-protected", "promises-write-protected", "stream-protected", "open-w-protected", "mkdir-protected", "rename-into-protected",
      "listen-outside-range", "listen-all-interfaces", "connect-non-loopback", "dns-non-loopback", "registry-style-spawn", "taskkill-untracked"]) {
      assert.equal(by[n].blocked, true, `${n} should be blocked (got ${JSON.stringify(by[n])})`);
    }
    assert.equal(by["child-env-without-preload-still-guarded"].guardedChild, "true");
    // no side effects
    assert.deepEqual(fs.readdirSync(prot), [], "nothing was created in the protected root");
    assert.equal(fs.readFileSync(path.join(root, "ok.txt"), "utf8"), "ok");
    const violations = fs.readFileSync(path.join(root, "violations.log"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(violations.length >= 12, `expected >= 12 logged violations, got ${violations.length}`);
    const loaded = fs.readFileSync(path.join(root, "guard-loaded.log"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(loaded.length >= 2, "both the canary and its child logged that the guard loaded");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// CCR 3.1.1 trial guard, round-2 hardening: unit layer (fakes only, no real fs/net/registry/process).
// Companion of trial31-guard.test.mjs; the real-process canaries are in trial31-canary.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const TRIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "trial31");
const { TrialViolation, createPolicy, install, wrapBetterSqlite, sqlBlocked, powershellEscapeHatch, dgramSendTarget } = require(path.join(TRIAL, "guard-core.cjs"));

const ROOT = "C:\\t\\root";
const HOME = "C:\\t\\home";
const cfg = (over = {}) => ({
  pid: 1000, root: ROOT, allowWriteRoots: [], portRange: { min: 39456, max: 39489 },
  realPorts: [3456, 3457, 3458, 4517],
  protectedRoots: [`${HOME}\\.claude`, `${HOME}\\.codex`],
  ...over,
});
const violation = (fn, kind) => assert.throws(fn, (e) => e instanceof TrialViolation && e.code === "UW_TRIAL31_VIOLATION" && (!kind || e.kind === kind));
const PRELOAD_REQ = "--require C:/g/preload-guard.cjs";

test("policy.spawn (sec M4/code M5): PowerShell escape hatches, iex, Stop-Process, every /PID, cmd/explorer/rundll32 are denied", () => {
  const p = createPolicy(cfg());
  p.tracked.add(777);
  const bad = [
    ["powershell.exe", ["-NoProfile", "-EncodedCommand", "SQBFAFgA"]], ["powershell", ["-enc", "abc"]], ["pwsh", ["-e", "abc"]], ["powershell", ["-ec", "abc"]],
    ["powershell", ["-File", "x.ps1"]], ["powershell", ["-f", "x.ps1"]], ["powershell", ["-Command", "-"]], ["powershell", ["-c", "-"]],
    ["powershell", ["-Command", "Invoke-Expression 'x'"]], ["powershell", ["-Command", "iex $x"]], ["powershell", ["-Command", "Stop-Process -Id 5 -Force"]],
    ["taskkill.exe", ["/PID", "777", "/PID", "9999", "/T", "/F"]], ["taskkill.exe", ["/PID", "9999", "/PID", "777"]], ["taskkill", ["/T"]],
    ["cmd.exe", ["/c", "echo hi"]], ["C:\\Windows\\System32\\cmd.exe", []], ["explorer.exe", ["C:\\"]], ["C:\\Windows\\explorer.exe", []], ["rundll32.exe", ["x.dll,Run"]],
  ];
  for (const [f, a] of bad) violation(() => p.checkSpawn(f, a, false), "spawn");
  for (const line of ["cmd /c echo hi", "start \"\" explorer.exe C:\\", "\"C:\\Windows\\System32\\rundll32.exe\" x.dll,Run", "powershell -enc abc", "echo x | cmd", "taskkill /PID 777 /PID 9999 /F"]) {
    violation(() => p.checkSpawn(line, [], true), "spawn");
  }
  const ok = [
    ["powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Get-Process | Select Id"]],
    ["powershell.exe", ["-NoProfile", "-Command", "Get-Content x -Encoding utf8"]],
    ["taskkill.exe", ["/PID", "777", "/PID", "1000", "/T"]],
    ["node", ["cmd-helper.js"]],
  ];
  for (const [f, a] of ok) p.checkSpawn(f, a, false);
  assert.match(powershellEscapeHatch(["-Command", "-"]), /stdin/);
  assert.equal(powershellEscapeHatch(["-NoProfile", "-Command", "Get-Date"]), undefined);
});

test("policy.write (L1): Uint8Array / Buffer view paths are decoded, not skipped", () => {
  const p = createPolicy(cfg());
  const prot = `${HOME}\\.claude\\settings.json`;
  violation(() => p.checkWrite(new Uint8Array(Buffer.from(prot)), "t"), "write");
  const big = Buffer.from(`xx${prot}yy`);
  violation(() => p.checkWrite(big.subarray(2, 2 + prot.length), "t"), "write"); // a view with a byteOffset
  p.checkWrite(new Uint8Array(Buffer.from(`${ROOT}\\ok.txt`)), "t");
});

test("install (L2): readFile/createReadStream with write flags and direct WriteStream/ReadStream construction are checked", async () => {
  const calls = [];
  class WriteStream { constructor(p, o) { calls.push(["WriteStream", p, o]); } }
  class ReadStream { constructor(p, o) { calls.push(["ReadStream", p, o]); } }
  const fsm = {
    constants: { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 256, O_APPEND: 8, O_TRUNC: 512 },
    readFile: (...a) => calls.push(["readFile", ...a]), readFileSync: (...a) => { calls.push(["readFileSync", ...a]); return "x"; },
    createReadStream: (...a) => calls.push(["createReadStream", ...a]), promises: { readFile: (...a) => { calls.push(["p.readFile", ...a]); return Promise.resolve("x"); } },
    WriteStream, ReadStream,
  };
  install({ fs: fsm }, cfg());
  const prot = `${HOME}\\.claude\\settings.json`;
  fsm.readFileSync(prot); fsm.readFileSync(prot, "utf8"); fsm.readFileSync(prot, { flag: "r" }); fsm.readFile(prot, { encoding: "utf8" }, () => {});
  fsm.createReadStream(prot); fsm.createReadStream(prot, { flags: "r" }); await fsm.promises.readFile(prot);
  assert.equal(calls.length, 7, "plain reads of a protected file pass");
  violation(() => fsm.readFileSync(prot, { flag: "w" }), "write");
  violation(() => fsm.readFileSync(prot, { flag: "a+" }), "write");
  violation(() => fsm.readFile(prot, { flag: "w" }, () => {}), "write");
  violation(() => fsm.createReadStream(prot, { flags: "w" }), "write");
  await assert.rejects(fsm.promises.readFile(prot, { flag: "w" }), TrialViolation);
  violation(() => new fsm.WriteStream(prot, {}), "write");
  violation(() => new fsm.ReadStream(prot, { flags: "a" }), "write");
  new fsm.WriteStream(`${ROOT}\\ok.log`, {});
  new fsm.ReadStream(prot, { flags: "r" });
  assert.equal(calls.length, 9);
});

test("install (L3): dns.Resolver / resolveAny / reverse / lookupService are guarded; dgram send target parsing", async () => {
  const calls = [];
  const names = ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse", "lookupService", "resolveTxt"];
  const mk = () => Object.fromEntries(names.map((n) => [n, () => { calls.push(n); return `real:${n}`; }]));
  class Resolver {}
  Object.assign(Resolver.prototype, mk());
  class PResolver {}
  Object.assign(PResolver.prototype, Object.fromEntries(names.map((n) => [n, () => Promise.resolve("ok")])));
  const dnsm = { ...mk(), Resolver, promises: { ...Object.fromEntries(names.map((n) => [n, () => Promise.resolve("ok")])), Resolver: PResolver } };
  install({ dns: dnsm }, cfg());
  for (const n of names) {
    violation(() => dnsm[n]("example.com"), "dns");
    violation(() => new Resolver()[n]("example.com"), "dns");
    await assert.rejects(dnsm.promises[n]("93.184.216.34"), TrialViolation);
    await assert.rejects(new PResolver()[n]("example.com"), TrialViolation);
  }
  dnsm.resolveAny("localhost");
  new Resolver().reverse("127.0.0.1");
  assert.equal(calls.length, 2);
  assert.deepEqual(dgramSendTarget([Buffer.from("x"), 39470, "127.0.0.1", () => {}]), { host: "127.0.0.1", port: 39470 });
  assert.deepEqual(dgramSendTarget(["x", 0, 1, 53, "8.8.8.8"]), { host: "8.8.8.8", port: 53 });
  assert.equal(dgramSendTarget([Buffer.from("x")]), undefined, "a connected-socket send has no target here (connect() was checked)");
});

function cpFakes(calls) {
  const cb = (a) => a.find((x) => typeof x === "function");
  const cp = {};
  for (const n of ["spawn", "spawnSync", "execFileSync", "fork", "execSync"]) cp[n] = (...a) => { calls.push([`cp.${n}`, ...a]); return { pid: 9 }; };
  cp.exec = (...a) => { calls.push(["cp.exec", ...a]); cb(a)(null, "OUT", "ERR"); return { pid: 4242 }; };
  cp.execFile = (...a) => { calls.push(["cp.execFile", ...a]); cb(a)(null, "FOUT", "FERR"); return { pid: 4243 }; };
  return cp;
}

test("install (item 10): util.promisify(exec/execFile) still resolves {stdout, stderr} through the guarded wrapper, and rejects on a violation", async () => {
  const calls = [];
  const cp = cpFakes(calls);
  install({ child_process: cp, process: { execPath: "C:\\node.exe", env: {}, kill() {} } }, cfg({ childEnv: { NODE_OPTIONS: PRELOAD_REQ, UW_TRIAL31_ROOT: ROOT } }));
  const p = promisify(cp.exec)("echo hi");
  assert.deepEqual(await p, { stdout: "OUT", stderr: "ERR" });
  assert.equal(p.child.pid, 4242, "the ChildProcess is exposed like the stock promisified exec");
  assert.deepEqual(await promisify(cp.execFile)("node", ["x.js"], { env: { A: "1" } }), { stdout: "FOUT", stderr: "FERR" });
  const sent = calls.find((c) => c[0] === "cp.execFile");
  assert.equal(sent[3].env.NODE_OPTIONS, PRELOAD_REQ, "the promisified path still injects the guard env");
  await assert.rejects(promisify(cp.exec)("reg add HKCU\\X /f"), (e) => e instanceof TrialViolation);
  await assert.rejects(promisify(cp.execFile)("cmd.exe", ["/c", "echo"]), (e) => e instanceof TrialViolation);
  assert.equal(calls.filter((c) => c[0] === "cp.exec" || c[0] === "cp.execFile").length, 2, "denied calls never reached the real function");
});

test("install: a tracked child is forgotten on exit (pid-reuse weakness narrowed)", () => {
  const handlers = {};
  const cp = { spawn: () => ({ pid: 5555, once: (ev, fn) => { handlers[ev] = fn; } }) };
  const { policy } = install({ child_process: cp }, cfg());
  cp.spawn("node", ["x"]);
  policy.checkKill(5555, "SIGTERM");
  handlers.exit();
  violation(() => policy.checkKill(5555, "SIGTERM"), "kill");
});

test("install: worker threads given their own env still get the guard env", () => {
  const seen = [];
  class Worker { constructor(file, opts) { seen.push([file, opts]); } }
  const wt = { Worker };
  install({ worker_threads: wt }, cfg({ childEnv: { NODE_OPTIONS: PRELOAD_REQ, UW_TRIAL31_ROOT: ROOT } }));
  new wt.Worker("w.js", { env: { A: "1", NODE_OPTIONS: "" } });
  assert.equal(seen[0][1].env.NODE_OPTIONS, PRELOAD_REQ);
  assert.equal(seen[0][1].env.A, "1");
  new wt.Worker("w.js");
  assert.deepEqual(seen[1][1], {});
});

test("better-sqlite3 wrapper (sec M2): file opens go through the write policy; ATTACH / VACUUM INTO / loadExtension are denied", async () => {
  const opened = [];
  class Database {
    constructor(file, opts) { opened.push([file, opts]); }
    prepare(sql) { return { sql }; }
    exec(sql) { return sql; }
    loadExtension() { return "loaded"; }
    backup(d) { return Promise.resolve(d); }
  }
  const policy = createPolicy(cfg());
  const DB = wrapBetterSqlite(Database, policy, (fn) => fn());
  assert.equal(wrapBetterSqlite(Database, policy, (fn) => fn()), DB, "idempotent");
  const prot = `${HOME}\\.claude\\x.db`;
  new DB(":memory:"); new DB(""); new DB(); new DB(`${ROOT}\\ok.db`); new DB(prot, { readonly: true }); new DB(Buffer.from("serialized"));
  assert.equal(opened.length, 6);
  violation(() => new DB(prot), "write");
  violation(() => new DB(`${HOME}\\elsewhere.db`), "write");
  violation(() => DB(prot), "write");
  violation(() => new DB(prot, { fileMustExist: true }), "write");
  violation(() => new DB(`${ROOT}\\ok.db`, { nativeBinding: "C:\\evil\\x.node" }), "write");
  new DB(`${ROOT}\\ok.db`, { nativeBinding: `${ROOT}\\npm\\better_sqlite3.node` });
  const db = new DB(":memory:");
  assert.deepEqual(db.prepare("SELECT 1"), { sql: "SELECT 1" });
  for (const sql of ["ATTACH DATABASE 'C:\\x.db' AS x", "attach 'x' as y", "/* c */ ATTACH/**/DATABASE 'x' AS y", "-- hi\nATTACH DATABASE 'x' AS y", "VACUUM INTO 'x.db'", "vacuum main into 'x'", "SELECT 1; ATTACH 'y' AS z"]) {
    violation(() => db.prepare(sql), "write");
    violation(() => db.exec(sql), "write");
  }
  assert.equal(sqlBlocked("SELECT attachments FROM t"), undefined, "a column that merely starts with the word is fine");
  assert.equal(db.exec("VACUUM"), "VACUUM", "plain VACUUM is fine");
  violation(() => db.loadExtension("x.dll"), "spawn");
  await assert.rejects(db.backup(prot), TrialViolation);
  assert.equal(await db.backup(`${ROOT}\\bak.db`), `${ROOT}\\bak.db`);
});

test("better-sqlite3 module hook: Module._load hands out the wrapped export for the package name and paths inside it only", () => {
  class Database { prepare() {} exec() {} }
  const Module = { _load: (req) => (/sqlite/.test(req) ? Database : { other: true }) };
  install({ module: Module }, cfg());
  const a = Module._load("better-sqlite3");
  assert.notEqual(a, Database);
  assert.equal(Module._load("C:\\x\\node_modules\\better-sqlite3\\lib\\index.js"), a);
  assert.equal(Module._load("better-sqlite3-multiple-ciphers"), Database, "a different package name is not matched");
  assert.deepEqual(Module._load("left-pad"), { other: true });
  violation(() => new a(`${HOME}\\.codex\\x.db`), "write");
});

test("policy.connect (sec M3): only a TRUTHY path is IPC, exactly like Node; {path:'', host, port} is a TCP connect held to the port rules", () => {
  const p = createPolicy(cfg());
  violation(() => p.checkConnect({ path: "", host: "127.0.0.1", port: 3456 }), "connect"); // live port
  violation(() => p.checkConnect({ path: "", host: "127.0.0.1", port: 80 }), "connect");
  violation(() => p.checkConnect({ path: "", host: "api.example.invalid", port: 443 }), "connect");
  violation(() => p.checkConnect({ path: "" }), "connect"); // no port at all: refused, not waved through as IPC
  p.checkConnect({ path: "", host: "127.0.0.1", port: 39470 }); // in range: a normal loopback connect
  p.checkConnect({ path: "\\\\.\\pipe\\x" }); // a real pipe path is still IPC
});

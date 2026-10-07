// CCR 3.1.1 trial guard: real-process canaries. Each canary runs in a real node child under
// `--require preload-guard.cjs` against TEMP dirs only (a fake sandbox root, a fake "protected"
// root, a fake node_modules), and every canary is one whose UNBLOCKED outcome is harmless:
// a file in a temp dir, a refused connect to a temp server the test itself opened on an
// ephemeral port, a `cmd /c echo`, a fake better-sqlite3 that never touches disk. Nothing here
// touches a real port, the real home, the registry or a CCR process.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TRIAL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "trial31");
const PRELOAD = path.join(TRIAL, "preload-guard.cjs").replace(/\\/g, "/");
const mkTemp = () => mkTmp("uw-trial31-canary-");
const q = (p) => `--require "${p.replace(/\\/g, "/")}"`;

function guardedEnv(root, protectedRoot, { portRange = "39456-39457", preload = PRELOAD, realPorts = "3456,3457,3458,4517" } = {}) {
  return {
    SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, ComSpec: process.env.ComSpec,
    NODE_OPTIONS: q(preload), UW_TRIAL31_PRELOAD_ARG: q(preload),
    UW_TRIAL31_ROOT: root, UW_TRIAL31_PORT_RANGE: portRange, UW_TRIAL31_REAL_PORTS: realPorts,
    UW_TRIAL31_PROTECTED: protectedRoot,
  };
}
const HEAD = `
const fs = require('fs'), net = require('net'), path = require('path'), cp = require('child_process'), util = require('util');
const out = [];
const t = async (name, fn) => { try { const v = await fn(); out.push({ name, blocked: false, value: v }); } catch (e) { out.push({ name, blocked: !!e && e.code === 'UW_TRIAL31_VIOLATION', code: e && e.code, message: e && String(e.message).slice(0, 120) }); } };
`;
function runCanary(dir, body, env, args = []) {
  const file = path.join(dir, "canary.cjs");
  fs.writeFileSync(file, `${HEAD}\n(async () => {\n${body}\nprocess.stdout.write(JSON.stringify(out));\n})();\n`);
  const r = spawnSync(process.execPath, [file, ...args], { env, encoding: "utf8", timeout: 90_000 });
  assert.equal(r.status, 0, `canary failed: ${r.stderr}`);
  return Object.fromEntries(JSON.parse(r.stdout).map((x) => [x.name, x]));
}
const listen = () => new Promise((res) => { const s = net.createServer((c) => c.end()); s.listen(0, "127.0.0.1", () => res(s)); });

test("canary: loopback connects are held to the trial range (host-less connect defaults to localhost); an in-range loopback connect works", async () => {
  const dir = mkTemp();
  const inRange = await listen();
  const outOfRange = await listen();
  const liveStandIn = await listen(); // a temp server declared "live" below: the real gateway port is never a connect target
  try {
    const root = path.join(dir, "sandbox");
    fs.mkdirSync(root, { recursive: true });
    const okPort = inRange.address().port, badPort = outOfRange.address().port;
    const by = runCanary(dir, `
      const [okPort, badPort, livePort] = process.argv.slice(2).map(Number);
      await t('connect-hostless-out-of-range', () => { net.connect(badPort); });
      await t('connect-127-out-of-range', () => { net.connect(badPort, '127.0.0.1'); });
      await t('connect-localhost-out-of-range', () => { net.connect({ host: 'localhost', port: badPort }); });
      await t('connect-ipv6-out-of-range', () => { net.connect({ host: '::1', port: badPort }); });
      await t('connect-live-port', () => { net.connect({ host: '127.0.0.1', port: livePort }); });
      await t('connect-empty-path-with-port', () => { net.connect({ path: '', host: '127.0.0.1', port: badPort }); });
      await t('connect-in-range', () => new Promise((res, rej) => { const s = net.connect(okPort, '127.0.0.1', () => { s.destroy(); res('connected'); }); s.on('error', rej); }));
    `, guardedEnv(root, path.join(dir, "real-home"), { portRange: `${okPort}-${okPort}`, realPorts: String(liveStandIn.address().port) }), [okPort, badPort, liveStandIn.address().port]);
    for (const n of ["connect-hostless-out-of-range", "connect-127-out-of-range", "connect-localhost-out-of-range", "connect-ipv6-out-of-range", "connect-live-port", "connect-empty-path-with-port"]) {
      assert.equal(by[n].blocked, true, `${n}: ${JSON.stringify(by[n])}`);
    }
    assert.equal(by["connect-in-range"].blocked, false);
    assert.equal(by["connect-in-range"].value, "connected");
  } finally { inRange.close(); outOfRange.close(); liveStandIn.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canary: L1/L2/L3 and spawn hardening are blocked in a real process, with no side effect", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox"), prot = path.join(dir, "real-home", ".claude");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(prot, { recursive: true });
    fs.writeFileSync(path.join(prot, "keep.txt"), "keep");
    const by = runCanary(dir, `
      const [prot] = process.argv.slice(2);
      const dgram = require('dgram');
      await t('L1-uint8array-path', () => fs.writeFileSync(new Uint8Array(Buffer.from(path.join(prot, 'u8.txt'))), 'x'));
      await t('L2-readFileSync-flag-w', () => fs.readFileSync(path.join(prot, 'keep.txt'), { flag: 'w' }));
      await t('L2-createReadStream-flags-w', () => fs.createReadStream(path.join(prot, 'keep.txt'), { flags: 'w' }));
      await t('L2-new-WriteStream', () => new fs.WriteStream(path.join(prot, 'ws.txt')));
      await t('L3-dgram-bind-all-interfaces', () => { const s = dgram.createSocket('udp4'); try { s.bind(0); } finally { try { s.close(); } catch {} } });
      await t('spawn-cmd-exe', () => cp.spawnSync('cmd.exe', ['/c', 'echo hi']));
      await t('spawn-exec-cmd', () => cp.execSync('cmd /c echo hi'));
      await t('spawn-powershell-encoded', () => cp.spawnSync('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from('Write-Output 1', 'utf16le').toString('base64')]));
      await t('spawn-taskkill-second-untracked-pid', () => cp.spawnSync('taskkill.exe', ['/PID', String(process.pid), '/PID', '999999']));
      await t('L4-child-env-overwritten', () => cp.spawnSync(process.execPath, ['-e', "process.stdout.write(String(!!process[Symbol.for('uw.trial31.guard')]))"], { env: { SystemRoot: process.env.SystemRoot, NODE_OPTIONS: '' }, encoding: 'utf8' }).stdout);
    `, guardedEnv(root, path.join(dir, "real-home")), [prot]);
    for (const n of ["L1-uint8array-path", "L2-readFileSync-flag-w", "L2-createReadStream-flags-w", "L2-new-WriteStream", "L3-dgram-bind-all-interfaces",
      "spawn-cmd-exe", "spawn-exec-cmd", "spawn-powershell-encoded", "spawn-taskkill-second-untracked-pid"]) {
      assert.equal(by[n].blocked, true, `${n}: ${JSON.stringify(by[n])}`);
    }
    assert.equal(by["L4-child-env-overwritten"].value, "true", "a caller-supplied empty NODE_OPTIONS does not produce an unguarded child");
    assert.deepEqual(fs.readdirSync(prot), ["keep.txt"], "nothing was created in the protected root");
    assert.equal(fs.readFileSync(path.join(prot, "keep.txt"), "utf8"), "keep", "the flag:'w' read did not truncate the protected file");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canary (item 10): util.promisify(child_process.execFile) resolves {stdout, stderr} under the real guard", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox");
    fs.mkdirSync(root, { recursive: true });
    const by = runCanary(dir, `
      await t('promisify-execFile', async () => { const p = util.promisify(cp.execFile)(process.execPath, ['-e', "process.stdout.write('hi')"]); const r = await p; return { stdout: r.stdout, hasChild: !!p.child }; });
      await t('promisify-exec-denied', () => util.promisify(cp.exec)('cmd /c echo x'));
    `, guardedEnv(root, path.join(dir, "real-home")));
    assert.equal(by["promisify-execFile"].blocked, false, JSON.stringify(by["promisify-execFile"]));
    assert.deepEqual(by["promisify-execFile"].value, { stdout: "hi", hasChild: true });
    assert.equal(by["promisify-exec-denied"].blocked, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canary (sec M5): a Worker thread is guarded, even one given its own env, and its load is logged with a thread id", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox"), prot = path.join(dir, "real-home", ".claude");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(prot, { recursive: true });
    const file = path.join(dir, "canary.cjs");
    fs.writeFileSync(file, `
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs'), path = require('path');
if (isMainThread) {
  const target = process.argv[2];
  const run = (opts) => new Promise((res) => { const w = new Worker(__filename, { workerData: { target }, ...opts }); w.once('message', res); w.once('error', (e) => res({ error: e.message })); });
  (async () => process.stdout.write(JSON.stringify([await run({}), await run({ env: {} }), await run({ env: { NODE_OPTIONS: '' }, execArgv: [] })])))();
} else {
  let r; try { fs.writeFileSync(path.join(workerData.target, 'w.txt'), 'x'); r = 'UNBLOCKED'; } catch (e) { r = e.code; }
  parentPort.postMessage({ guard: !!process[Symbol.for('uw.trial31.guard')], r });
}
`);
    const r = spawnSync(process.execPath, [file, prot], { env: guardedEnv(root, path.join(dir, "real-home")), encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.equal(res.length, 3);
    for (const x of res) assert.deepEqual(x, { guard: true, r: "UW_TRIAL31_VIOLATION" }, JSON.stringify(x));
    assert.deepEqual(fs.readdirSync(prot), [], "nothing was written by any worker");
    const loaded = fs.readFileSync(path.join(root, "guard-loaded.log"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(loaded.some((l) => l.thread === "main"));
    assert.ok(loaded.filter((l) => l.thread !== "main").length >= 3, `worker thread loads logged: ${JSON.stringify(loaded.map((l) => l.thread))}`);
    const viol = fs.readFileSync(path.join(root, "violations.log"), "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.ok(viol.filter((l) => l.thread !== "main").length >= 3, "the blocked worker writes are logged with their thread id");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canary (sec M2): a fake better-sqlite3 resolved from a temp node_modules is wrapped by the real preload", () => {
  const dir = mkTemp();
  try {
    const root = path.join(dir, "sandbox"), prot = path.join(dir, "real-home", ".claude");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(prot, { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "better-sqlite3"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "better-sqlite3", "package.json"), JSON.stringify({ name: "better-sqlite3", version: "0.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(dir, "node_modules", "better-sqlite3", "index.js"), `
class Database { constructor(f) { this.f = f; } prepare(s) { return { s }; } exec(s) { return s; } loadExtension() { return 'loaded'; } }
module.exports = Database;
`);
    const by = runCanary(dir, `
      const [prot, root] = process.argv.slice(2);
      const Database = require('better-sqlite3');
      await t('sqlite-open-protected', () => new Database(path.join(prot, 'x.db')));
      await t('sqlite-open-memory', () => new Database(':memory:').f);
      await t('sqlite-open-sandbox', () => new Database(path.join(root, 'ok.db')).f);
      await t('sqlite-attach', () => new Database(':memory:').prepare("ATTACH DATABASE 'x.db' AS y"));
      await t('sqlite-vacuum-into', () => new Database(':memory:').exec("VACUUM INTO 'x.db'"));
      await t('sqlite-load-extension', () => new Database(':memory:').loadExtension('x.dll'));
    `, guardedEnv(root, path.join(dir, "real-home")), [prot, root]);
    for (const n of ["sqlite-open-protected", "sqlite-attach", "sqlite-vacuum-into", "sqlite-load-extension"]) assert.equal(by[n].blocked, true, `${n}: ${JSON.stringify(by[n])}`);
    assert.equal(by["sqlite-open-memory"].blocked, false);
    assert.equal(by["sqlite-open-sandbox"].blocked, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("canary: a junction created inside the sandbox that points at a protected dir is blocked by its target", (t) => {
  const dir = mkTemp();
  const root = path.join(dir, "sandbox"), prot = path.join(dir, "real-home", ".claude"), link = path.join(root, "link");
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(prot, { recursive: true });
    const by = runCanary(dir, `
      const [prot, link] = process.argv.slice(2);
      let created = true, createErr;
      try { fs.symlinkSync(prot, link, 'junction'); } catch (e) { created = false; createErr = e.code; }
      out.push({ name: 'junction-created', created, createErr });
      if (created) {
        await t('write-through-junction', () => fs.writeFileSync(path.join(link, 'x.txt'), 'x'));
        await t('mkdir-through-junction', () => fs.mkdirSync(path.join(link, 'sub')));
        await t('stream-through-junction', () => fs.createWriteStream(path.join(link, 's.txt')));
      }
    `, guardedEnv(root, path.join(dir, "real-home")), [prot, link]);
    if (!by["junction-created"].created) return t.skip(`junction creation was refused by the OS (${by["junction-created"].createErr}); the realpath logic is covered by the unit test with a fake realpath`);
    for (const n of ["write-through-junction", "mkdir-through-junction", "stream-through-junction"]) assert.equal(by[n].blocked, true, `${n}: ${JSON.stringify(by[n])}`);
    assert.deepEqual(fs.readdirSync(prot), [], "nothing reached the protected dir through the junction");
  } finally {
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* not created */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("canary (config31 quoting): the preload path is quoted in NODE_OPTIONS, so a directory with a space still loads the guard", () => {
  const dir = mkTemp();
  try {
    const spaced = path.join(dir, "dir with space");
    fs.mkdirSync(spaced, { recursive: true });
    for (const f of ["guard-core.cjs", "preload-guard.cjs", "redact31.cjs"]) fs.copyFileSync(path.join(TRIAL, f), path.join(spaced, f));
    const root = path.join(dir, "sandbox");
    fs.mkdirSync(root, { recursive: true });
    const by = runCanary(dir, `
      await t('guard-flag', () => !!process[Symbol.for('uw.trial31.guard')]);
      await t('write-outside', () => fs.writeFileSync(path.join(process.argv[2], 'x.txt'), 'x'));
    `, guardedEnv(root, path.join(dir, "real-home"), { preload: path.join(spaced, "preload-guard.cjs") }), [dir]);
    assert.equal(by["guard-flag"].value, true);
    assert.equal(by["write-outside"].blocked, true);
    assert.equal(fs.existsSync(path.join(dir, "x.txt")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

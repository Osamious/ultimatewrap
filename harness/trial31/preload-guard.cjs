'use strict';
// NODE_OPTIONS=--require <this file>. Installs the trial guard (guard-core.cjs)
// into every node process the CCR 3.1.1 sandbox spawns. Configured ONLY through
// UW_TRIAL31_* env vars set by config31.mjs; if any required one is missing this
// file throws, so an unconfigured launch cannot run unguarded.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const child_process = require('node:child_process');
const path = require('node:path');
const Module = require('node:module');
const worker_threads = require('node:worker_threads');
const { isMainThread, threadId } = worker_threads;
const { install } = require('./guard-core.cjs');

const MARK = Symbol.for('uw.trial31.guard');
if (!process[MARK]) {
  const env = process.env;
  const need = (k) => {
    if (!env[k]) throw new Error(`[uw-trial31 guard] ${k} is not set; refusing to run unguarded`);
    return env[k];
  };
  const root = path.resolve(need('UW_TRIAL31_ROOT'));
  const [min, max] = need('UW_TRIAL31_PORT_RANGE').split('-').map(Number);
  const protectedRoots = need('UW_TRIAL31_PROTECTED').split(';').filter(Boolean);
  const allowWriteRoots = (env.UW_TRIAL31_ALLOW_WRITE || '').split(';').filter(Boolean);
  const realPorts = (env.UW_TRIAL31_REAL_PORTS || '').split(',').filter(Boolean).map(Number);
  const preloadArg = need('UW_TRIAL31_PRELOAD_ARG');
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error('[uw-trial31 guard] UW_TRIAL31_PORT_RANGE must be "min-max"');
  }

  // Captured BEFORE patching so logging can never be blocked by (or recurse into) the guard.
  const appendFileSync = fs.appendFileSync.bind(fs);
  const realpathNative = fs.realpathSync.native.bind(fs.realpathSync);
  fs.mkdirSync(root, { recursive: true });
  const violationsLog = path.join(root, 'violations.log');
  const loadedLog = path.join(root, 'guard-loaded.log');
  const line = (kind, extra) => JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, thread: isMainThread ? 'main' : threadId, kind, ...extra }) + '\n';
  const log = (kind, extra) => { try { appendFileSync(violationsLog, line(kind, extra)); } catch { /* the throw that follows is the signal */ } };

  const childEnv = { NODE_OPTIONS: preloadArg };
  for (const k of Object.keys(env)) if (k.startsWith('UW_TRIAL31_')) childEnv[k] = env[k];

  install({ fs, net, dns, dgram, child_process, process, module: Module, worker_threads }, {
    pid: process.pid, root, allowWriteRoots, protectedRoots, realPorts,
    portRange: { min, max }, realpath: realpathNative, log, childEnv,
  });
  process[MARK] = true;
  try { appendFileSync(loadedLog, line('loaded', { argv: process.argv.slice(1, 3).map((a) => path.basename(String(a))) })); } catch { /* best effort */ }
}

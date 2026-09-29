// One live sweep at a time (#114).
//
// Two sweeps would both append to state/bench.jsonl, both fold it into bench.json and
// each spend its own cap. So a live run holds an exclusive lock file next to the log,
// created with the `wx` flag (the OS makes "does not exist, create it" one step), and a
// second `--live`, or a `--compact` that would rewrite the log under a running sweep,
// is refused before anything is sent or written.
//
// TWO KINDS OF STALE LOCK, both taken over with a notice rather than blocking for ever:
//   - the holder's pid is not alive (it crashed or was killed; a process 'exit' handler
//     covers the normal ways out but not a hard kill)
//   - the lock is older than the run's own wall-clock limit plus a margin (a recycled pid
//     must not pin the lock for ever)
//
// A SECONDARY, best-effort check covers sweeps started by code that had no lock yet: a
// running `node ... bench-cli.mjs ... --live` process is looked for through the OS
// (PowerShell/CIM on Windows, `ps` elsewhere). It is injectable, so tests never spawn a
// process, and a failure to look is reported, not fatal: the lock is the guarantee, the
// scan is a courtesy.
//
// Nothing here reads a key or the vault.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { BENCH_LOG } from "../menu/bench-data.mjs";

export const LOCK_FILE = path.join(path.dirname(BENCH_LOG), "bench.lock");
const MARGIN_MS = 10 * 60000;          // past the run's own limit before an ALIVE holder is doubted
const NO_LIMIT_MS = 24 * 3600000;      // a run with no --max-minutes still is not allowed to hold it for ever
const WRITING_MS = 5000;               // an unreadable lock younger than this is someone mid-write

export const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);

/** Is `pid` a running process? EPERM means it exists and is not ours to signal: alive. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
}

// ------------------------------------------------- finding a lockless sweep

/** `node ... bench-cli.mjs ... --live`, and not a `--compact`, and not a test file. */
const isSweepCmd = (cmd) => /bench-cli\.mjs/.test(cmd) && /(^|\s)--live(\s|$)/.test(cmd) && !/--compact/.test(cmd);

/** Process list text -> [{ pid, cmd }]. Windows text is CIM JSON, elsewhere `pid args` lines. */
export function parseProcessList(text, platform = process.platform) {
  const out = [];
  if (platform === "win32") {
    let j = null;
    try { j = JSON.parse(text); } catch { return out; }
    for (const p of Array.isArray(j) ? j : j ? [j] : []) {
      if (Number.isInteger(p?.ProcessId) && typeof p?.CommandLine === "string") out.push({ pid: p.ProcessId, cmd: p.CommandLine });
    }
    return out;
  }
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), cmd: m[2] });
  }
  return out;
}

function listProcesses(platform = process.platform) {
  if (platform === "win32") {
    // Name is filtered to node so this very query (a powershell whose command line
    // mentions nothing of the sort) can never match itself.
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name like 'node%'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  }
  return execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
}

/**
 * Other running live sweeps, as `[{ pid, cmd }]`, or `null` when the machine could not be
 * asked (the caller says so; it is not an error).
 */
export function findSweepProcesses({ list = listProcesses, platform = process.platform, selfPid = process.pid } = {}) {
  let text;
  try { text = list(platform); } catch { return null; }
  return parseProcessList(text, platform).filter((p) => p.pid !== selfPid && isSweepCmd(p.cmd));
}

// ------------------------------------------------------------ the lock file

export function readLock(file = LOCK_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { exists: false }; }
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* raced with a release */ }
  try {
    const h = JSON.parse(text);
    if (Number.isInteger(h?.pid) && Number.isFinite(h?.startedAt)) return { exists: true, holder: h, mtimeMs };
  } catch { /* unreadable */ }
  return { exists: true, holder: null, mtimeMs };
}

/** Why a holder no longer counts, or null when it is alive and within its own limit. */
function staleReason(holder, { isAlive, now, marginMs }) {
  if (!isAlive(holder.pid)) return `process ${holder.pid} is not running`;
  const limit = (holder.maxMinutes ? holder.maxMinutes * 60000 : NO_LIMIT_MS) + marginMs;
  if (now() - holder.startedAt > limit) return `the lock is older than its ${Math.round(limit / 60000)} min limit`;
  return null;
}

const holderMsg = (h) => `another sweep is running (pid ${h.pid} since ${hhmm(h.startedAt)}${h.mode ? `, ${h.mode}` : ""}); nothing was sent`;
const strayMsg = (s) => `a sweep is running that holds no lock (pid ${s[0].pid}${s.length > 1 ? ` and ${s.length - 1} more` : ""}; ` +
  "started by code from before the lock existed); nothing was sent";

/**
 * Is a sweep running right now? Never creates or removes anything. `running` is true for a
 * live lock holder OR a lockless sweep process.
 */
export function sweepStatus({ file = LOCK_FILE, isAlive = pidAlive, findRunning = findSweepProcesses, now = Date.now, marginMs = MARGIN_MS } = {}) {
  const lock = readLock(file);
  let holder = null, stale = null;
  if (lock.exists && lock.holder) {
    stale = staleReason(lock.holder, { isAlive, now, marginMs });
    if (!stale) holder = lock.holder;
  }
  const found = findRunning();
  const stray = (found ?? []).filter((p) => p.pid !== holder?.pid);
  const message = holder ? holderMsg(holder) : stray.length ? strayMsg(stray) : null;
  return { running: !!message, holder, stray, unchecked: found === null, message, staleLock: lock.exists ? stale ?? (lock.holder ? null : "unreadable") : null };
}

/**
 * Take the lock, or say why not. `{ ok: true, release, tookOver, unchecked }` or
 * `{ ok: false, message }`. `release` is synchronous, idempotent and only removes a lock
 * that is still THIS run's, so it is safe in a `finally` and in a process 'exit' handler.
 */
export function acquireLock({
  file = LOCK_FILE, pid = process.pid, mode = null, maxMinutes = null,
  isAlive = pidAlive, findRunning = findSweepProcesses, now = Date.now, marginMs = MARGIN_MS,
} = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const startedAt = now();
  let tookOver = null;

  let got = false;
  for (let attempt = 0; attempt < 3 && !got; attempt++) {
    try {
      const fd = fs.openSync(file, "wx");
      try { fs.writeSync(fd, JSON.stringify({ pid, startedAt, mode, maxMinutes })); } finally { fs.closeSync(fd); }
      got = true;
    } catch (e) {
      if (e?.code !== "EEXIST") return { ok: false, message: `cannot create the sweep lock ${file}: ${e?.message ?? e}; nothing was sent` };
      const lock = readLock(file);
      if (!lock.exists) continue;                                   // released between our two looks: try again
      if (!lock.holder) {
        if (now() - lock.mtimeMs < WRITING_MS) return { ok: false, message: "another sweep is starting (its lock is still being written); nothing was sent" };
        tookOver = { pid: null, why: "the lock file is unreadable" };
      } else {
        const why = staleReason(lock.holder, { isAlive, now, marginMs });
        if (!why) return { ok: false, message: holderMsg(lock.holder), holder: lock.holder };
        tookOver = { pid: lock.holder.pid, why };
      }
      try { fs.unlinkSync(file); } catch { /* someone else took it over first; the next wx decides */ }
    }
  }
  if (!got) return { ok: false, message: "could not take the sweep lock (another process is racing for it); nothing was sent" };

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const cur = readLock(file);
      if (cur.holder && cur.holder.pid === pid && cur.holder.startedAt === startedAt) fs.unlinkSync(file);
    } catch { /* already gone */ }
  };

  // The lock covers sweeps that know about it. One started by older code does not, so ask
  // the OS too; if one is running, give the lock back and refuse.
  const found = findRunning();
  const stray = (found ?? []).filter((p) => p.pid !== pid);
  if (stray.length) { release(); return { ok: false, message: strayMsg(stray), stray }; }
  return { ok: true, release, tookOver, unchecked: found === null };
}

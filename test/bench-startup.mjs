// The startup budget, as a number that can fail.
//
// Measured: node boot + module graph + snapshot read + first frame string. A
// separate process per sample, because most of the cost being defended is module
// loading and an in-process loop would measure a warm cache five times.
//
// NOT measured, deliberately: the PowerShell wrapper's own start (~200 ms) and
// the terminal's paint. The first is unavoidable -- Node cannot call
// SetConsoleMode -- and the second is not ours.

import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const pexec = promisify(execFile);
export const BUDGET_MS = 300;
// The full ctrl+g cost: cmd dispatcher + PowerShell start (Add-Type compilation
// is the largest fixed cost here) + node + first frame. It is a SOFT budget --
// it warns, it does not fail -- because PowerShell's start time is not ours to
// fix, and the hard gate stays on the part we control. But it is measured and
// asserted rather than declared: the previous draft defined this constant and
// never referenced it anywhere, so the largest single component of the latency
// the user actually feels was unbudgeted.
export const WRAPPER_SOFT_MS = 700;
const MENU = path.join(os.homedir(), ".uw", "menu").replace(/\\/g, "/");

export function median(ns) {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function verdict(ms, budget = BUDGET_MS) {
  const ok = ms <= budget;
  return { ok, line: `${ok ? "PASS" : "FAIL"} first frame ${ms} ms (budget ${budget} ms)` };
}

// The child prints one number on stderr and nothing else there, so a stray
// console.log anywhere in the import graph turns into a parse failure rather than
// a silent wrong measurement. The FRAME goes to stdout, which is the point.
//
// Q1.5, and why this child is shaped the way it is. The previous version built a
// string, never wrote it, and forced `TERM: "dumb"` so that `motionEnabled` was
// false and the startup reveal -- which Q1.4 puts INSIDE the budget -- never ran.
// It therefore measured a quantity the 300 ms budget does not describe, and it
// was compared against `startup.json`, which the runtime records AFTER
// `out.write(HIDE + CLEAR)` and `run("open")` and so includes up to three
// `sleepSync(FRAME_MS)` pauses the bench excluded. Two incompatible numbers, one
// budget. This version writes the frames to stdout (a pipe here, a console in
// real use) with motion enabled and the environment inherited, and stops the
// clock on the completed write -- the same point `recordStartup` now uses.
const CHILD = `
const t0 = process.hrtime.bigint();
const { loadSnapshot } = await import("file://${MENU}/snapshot.mjs");
const { firstFrame, framesFor } = await import("file://${MENU}/uwpick.mjs");
const { detectCaps, motionEnabled, painter, sleepSync, FRAME_MS } =
  await import("file://${MENU}/style.mjs");
const r = loadSnapshot();
if (!r.ok) { process.stderr.write("snapshot " + r.reason); process.exit(3); }
const caps = detectCaps(process.env, 120);
const motion = motionEnabled({ env: process.env, flags: [], caps });
const f = firstFrame({ snap: r.snap, recents: [], favourites: [], caps, termRows: 30 });
if (!f.text.length) { process.exit(4); }
// The real open path: hide+clear, then the reveal burst, exactly as main() does.
process.stdout.write("\\x1b[?25l\\x1b[2J\\x1b[H");
for (const frame of framesFor("open", f.text.split("\\n"), { motion, painter: painter(caps), caps })) {
  process.stdout.write("\\x1b[H" + frame.join("\\n"));
  if (motion) sleepSync(FRAME_MS);
}
process.stderr.write(String(Number(process.hrtime.bigint() - t0) / 1e6));
`;

export async function sampleOnce() {
  // The frame goes to the stdout pipe and is discarded; the number comes back on
  // stderr. Writing to a pipe rather than to nowhere is deliberate: the write has
  // to actually complete for the measurement to mean "the frame reached the
  // console" (Q1.2). It is not identical to a real console write -- a pipe does
  // no terminal rendering -- but it is the same syscall path, and the alternative
  // measures string concatenation.
  const { stderr } = await pexec(process.execPath, ["--input-type=module", "-e", CHILD],
                                 { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const ms = Number(String(stderr).trim());
  if (!Number.isFinite(ms)) throw new Error(`bench child printed ${JSON.stringify(stderr)}`);
  return Math.round(ms);
}

export async function run(samples = 5) {
  const out = [];
  for (let i = 0; i < samples; i++) out.push(await sampleOnce());
  const m = median(out);
  return { samples: out, median: m, ok: verdict(m).ok };
}

/**
 * The wrapper-inclusive measurement: `uwpick.cmd` entry to process exit, with the
 * picker given an immediate quit. This is the number the user experiences when
 * they press ctrl+g, and it is roughly BUDGET_MS plus PowerShell's start.
 *
 * Soft: it prints and warns, it does not fail the run. It exists so that a
 * regression in the wrapper is visible rather than being attributed to the
 * picker, and so that WRAPPER_SOFT_MS means something.
 */
export async function sampleWrapper() {
  const os_ = await import("node:os"), fs_ = await import("node:fs");
  const buf = path.join(os_.tmpdir(), `uw-bench-${process.pid}.md`);
  fs_.writeFileSync(buf, "m\n");
  const t0 = process.hrtime.bigint();
  // Inspect the failure; do not swallow it. A bare catch here reports the BEST
  // number exactly when the chain is most broken: a missing uwpick.cmd, a spawn
  // error, or a PowerShell wrapper that dies before it reaches node are all very
  // fast, so the soft budget would print `ok` most confidently on a chain that
  // never ran. That matters here specifically, because uwpick-run.ps1 opens
  // CONIN$ to set the console mode and a `node --test` harness may have no
  // console -- which is exactly the environment this measurement runs in.
  let note = "";
  try {
    await pexec(path.join(MENU, "uwpick.cmd"), [buf],
                { timeout: 30000, env: { ...process.env, UW_PICKER_QUIT_IMMEDIATELY: "1" } });
  } catch (e) {
    const expected = 1;            // CONTRACT.handoff.discardExit: the abort path
    if (e.killed || e.signal) note = "TIMED OUT";
    else if (e.code === "ENOENT") note = "uwpick.cmd not found";
    else if (e.status !== expected) note = `unexpected exit ${e.status}`;
    // e.status === expected is the ordinary abort path and is not a note.
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  fs_.rmSync(buf, { force: true });
  return { ms, note };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/test/bench-startup.mjs")) {
  const r = await run(Number(process.argv[2] ?? 5));
  console.log(`samples: ${r.samples.join(", ")} ms`);
  console.log(verdict(r.median).line);
  const w = await sampleWrapper();
  if (w.note) {
    console.log(`WARN ctrl+g chain did not run cleanly: ${w.note} (${w.ms} ms) — ` +
                `this number is NOT a latency measurement`);
  } else {
    console.log(`${w.ms <= WRAPPER_SOFT_MS ? "ok  " : "WARN"} ctrl+g to exit ${w.ms} ms ` +
                `(soft budget ${WRAPPER_SOFT_MS} ms; the difference from the number above ` +
                `is cmd + PowerShell start, which is not ours to fix)`);
  }

  process.exit(r.ok ? 0 : 1);
}

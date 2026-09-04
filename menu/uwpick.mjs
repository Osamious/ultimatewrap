#!/usr/bin/env node
// UW model picker -- a terminal TUI that runs inside Claude Code's own
// external-editor handoff (ctrl+g / chat:externalEditor).
//
// WHY THIS WORKS WHERE EVERYTHING ELSE FAILED:
// CC's editor handoff calls enterAlternateScreen() -- which PAUSES its renderer
// and turns OFF raw mode -- then spawnSync's the editor with stdio:"inherit" and
// BLOCKS. So we get the real TTY, exclusively, with no repaint war and no
// keystroke war. (A hook's child cannot do this: hooks are spawned
// stdio:["ignore","pipe","pipe"], so they have no stdin at all.)
//
// This file is three responsibilities and no more: read the console, sequence
// frames, write the selection. Rows come from the snapshot, characters come from
// style.mjs, decisions come from pick-state.mjs, and the two strings Claude Code
// cares about come from cc-contract.mjs.

import fs from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { loadSnapshot, SNAPSHOT_FILE } from "./snapshot.mjs";
// NOTE: catalog.mjs is deliberately NOT imported here. It pulls in keysync and a
// 19.7 MB catalogue parse, and the picker's whole input is the pre-built
// snapshot (Q1.1). Routability arrives on the snapshot rows (Q1.3).
import { initState, reduce, view, tokenize } from "./pick-state.mjs";
import { handoffTarget, modelCommand, CONTRACT } from "./cc-contract.mjs";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff,
         recordStartup } from "./state.mjs";
import { frame, confirmLine, detectCaps, glyphsFor, painter, motionEnabled,
         slideFrames, revealFrames, flashFrames, sleepSync, FRAME_MS } from "./style.mjs";

const ESC = "\x1b";
const HOME = `${ESC}[H`;
const EL = `${ESC}[K`;                 // erase to end of line
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE = `${ESC}[?25l`, SHOW = `${ESC}[?25h`;

export function screen(v, meta, opts) { return frame(v, meta, opts).join("\n"); }

// Q3.7: cursor-home plus per-line erase, never a full clear between frames. A
// full clear is two writes the terminal renders separately, which is exactly what
// flicker is; the screen is cleared once on entry and once on exit and never in
// between.
function paint(out, lines) {
  out.write(HOME + lines.map((l) => l + EL).join("\n") + `${ESC}[J`);
}

export function firstFrame({ snap, recents, favourites, caps, termRows }) {
  const rows = snap.rows;
  const state = initState(rows, { recents, favourites, termRows });
  const meta = {
    providers: rows.length,
    models: rows.reduce((n, r) => n + r.models.length, 0),
    generatedAt: snap.generatedAt,
    // Q1.3: carried straight through from the snapshot the refresher wrote. The
    // picker asks nobody anything; it prints the stamp so the user can see how
    // old the dim state is rather than assuming it is live.
    routableAsOf: snap.routableAsOf ?? null,
  };
  return { state, meta, text: screen(view(state), meta, { caps }) };
}

export function failMessage(res) {
  const fix = "run: node C:/Users/osami/.uw/menu/snapshot.mjs --build";
  if (res.reason === "missing") return `uwpick: no catalogue snapshot at ${res.detail} — ${fix}`;
  if (res.reason === "schema") return `uwpick: snapshot is the wrong version (${res.detail}) — ${fix}`;
  return `uwpick: snapshot unreadable (${res.detail}) — ${fix}`;
}

export function framesFor(kind, lines, opts) {
  if (!opts.motion) return [lines];
  if (kind === "enter") return slideFrames(lines, 6, 3);
  // `back` slides from the same side and then trims, so the step stays POSITIVE.
  // Passing -6 here threw: slideFrames computes `" ".repeat(step * (f - 1))`, and
  // String.repeat rejects a negative count with RangeError, so every `back`
  // transition crashed the picker on the way out of a provider.
  if (kind === "back") return slideFrames(lines, 6, 3).map((f) => f.map((l) => l.trimStart()));
  if (kind === "open") return revealFrames(lines, 3);
  return flashFrames(lines, opts.index ?? 0, opts.painter, 2);
}

// One place that decides what happens to the handoff buffer, so the two halves of
// Q2.1 cannot drift apart. Both are needed: the exit code is what Claude Code
// reads, and the truncation is what makes the outcome right even if some layer
// swallows the code -- which is exactly what uwpick.cmd used to do.
function abort(out, FILE, message) {
  if (message) process.stderr.write(message + "\n");
  let emptied = false;
  if (FILE) { try { fs.writeFileSync(FILE, ""); emptied = true; } catch { /* see below */ } }
  // MEASURED on Claude Code 2.1.259, and it contradicts what this function used
  // to assume. A non-zero exit makes CC DISCARD the file and restore the input
  // exactly as it was before ctrl+g -- and what it was, on every path that
  // reaches here, is the sentinel the user typed to open the picker. So exiting
  // non-zero left a literal `m` sitting in the chat input after every esc and
  // every ctrl+c, and threw away the truncation above, which is the only thing
  // that could have cleared it. It also surfaced
  //   Uwpick.cmd quit unexpectedly (exit code 1)
  // to the user on an ordinary, deliberate cancel.
  //
  // Exiting 0 means CC accepts the file, and the file is now empty, so the input
  // is cleared. The truncation is what makes 0 safe: the reasoning this replaces
  // -- "exit 0 would submit `m` as a chat message" -- is only true of a file that
  // still HOLDS `m`, and by this line it does not.
  //
  // If the write failed there is nothing to accept, and accepting a file that
  // still contains the sentinel is the one outcome worse than the old
  // behaviour, so that path keeps the discarding exit.
  process.exit(emptied || !FILE ? CONTRACT.handoff.acceptExit
                                : CONTRACT.handoff.discardExit);
}

export function main() {
  const t0 = process.hrtime.bigint();
  const FILE = handoffTarget(process.argv);
  const out = process.stdout;
  const caps = detectCaps(process.env, out.columns ?? 80);
  const g = glyphsFor(caps), p = painter(caps);
  const motion = motionEnabled({ env: process.env, flags: process.argv.slice(2), caps });

  const loaded = loadSnapshot();
  if (!loaded.ok) {
    // Q2.1. Truncate AND exit non-zero. The buffer at this moment still holds the
    // `m` the user typed to get here, and exit 0 would submit it as a chat message.
    abort(out, FILE, failMessage({ ...loaded, detail: loaded.detail ?? SNAPSHOT_FILE }));
  }

  const { recents, favourites } = loadPickerState();
  let { state, meta } = firstFrame({
    snap: loaded.snap, recents, favourites, caps, termRows: out.rows || 30,
  });

  const lines = () => frame(view(state), meta, { caps });
  const run = (kind, index) => {
    for (const f of framesFor(kind, lines(), { motion, painter: p, caps, index })) {
      paint(out, f);
      if (motion) sleepSync(FRAME_MS);
    }
  };
  const draw = () => {
    state = reduce(state, { resize: out.rows || 30 }).state;
    paint(out, lines());
  };

  out.write(HIDE + CLEAR);
  run("open");                                     // startup reveal, inside the budget
  recordStartup(Number(process.hrtime.bigint() - t0) / 1e6);

  // NOTHING ASYNCHRONOUS HAPPENS BELOW THIS LINE, and nothing may be added.
  // The loop is a blocking readSync with no yield in its body, so the JS stack
  // never unwinds: the event loop is never re-entered, the microtask queue never
  // drains, and `process.exit()` inside `finish()` is the only way out. A promise
  // continuation or an `out.on("resize", ...)` here is unreachable code that a
  // unit test -- which has an event loop -- will happily pass (Q1.3, Q7.2). The
  // routability column is a field on the snapshot rows, put there by the
  // refresher. A terminal resize is picked up on the next keystroke, because
  // `draw()` reduces a `{resize}` event before painting; there is no way to
  // observe one sooner without a worker thread, and Q7.2 forbids adding one.

  let CONIN = null;
  try { CONIN = openSync("//./CONIN$", "r"); } catch { CONIN = null; }

  // Selection only. Every non-selection path goes through abort(), which
  // truncates the buffer and exits non-zero (Q2.1, Q2.3a).
  const finish = (target) => {
    let wrote = false;
    try {
      fs.writeFileSync(FILE, modelCommand(...target.split(/\/(.*)/s)));
      wrote = true;
    } catch {
      // The one string we exist to write did not get written. Exiting 0 here
      // would leave the sentinel in the buffer and submit `m` as chat input, so
      // this is an abort like any other -- and the user is told why.
      out.write(CLEAR + SHOW);
      abort(out, FILE, `uwpick: could not write the selection to ${FILE}`);
    }
    // Q3.3: the frame collapses to one line, which is what the user is left
    // looking at for the instant before Claude Code repaints.
    out.write(CLEAR + SHOW + confirmLine(target, g, p) + "\n");
    recordHandoff({ argv2: FILE ?? null, existed: !!FILE && fs.existsSync(FILE), wrote });
    process.exit(CONTRACT.handoff.acceptExit);      // 0: CC accepts the content
  };

  const quit = (why) => {
    out.write(CLEAR + SHOW);
    recordHandoff({ argv2: FILE ?? null, existed: !!FILE && fs.existsSync(FILE),
                    wrote: false, why });
    abort(out, FILE, null);
  };

  // The one escape hatch, and its only caller is test/bench-startup.mjs's
  // wrapper-inclusive measurement (Q1.5), which needs the whole ctrl+g chain to
  // run to completion without a console and without a human. It quits through the
  // ordinary abort path, so it measures the real exit sequence rather than a
  // shortcut past it.
  if (process.env.UW_PICKER_QUIT_IMMEDIATELY === "1") quit("bench");

  if (CONIN === null) {
    // Q2.6. The console is unusable, so there is nothing to pick; leaving `m` in
    // the buffer would turn an environment problem into a chat message.
    out.write(`\n\n  uwpick: cannot open CONIN$ — the console is not available.\n`);
    quit("no-conin");
  }

  const buf = Buffer.alloc(1024);
  for (;;) {
    let n = 0;
    try { n = readSync(CONIN, buf, 0, buf.length, null); }
    catch { break; }
    if (n <= 0) continue;

    // Q3.8: readSync hands back the whole console buffer, so a held arrow arrives
    // as several sequences in one chunk. Reduce each key in order, then draw once.
    const before = state.level;
    let exited = null, refav = null;
    for (const key of tokenize(buf.toString("utf8", 0, n))) {
      const r = reduce(state, key);
      state = r.state;
      if (r.favourite) refav = r.favourite;
      if (r.exit) { exited = r.exit; break; }
    }
    if (refav) {
      const next = toggleFavourite(refav);
      state = initState(loaded.snap.rows, { ...next, termRows: out.rows || 30 });
    }
    if (exited) {
      closeSync(CONIN);
      if (exited.target) {
        recordRecent(exited.target);
        run("select", view(state).cursor - view(state).top + 4);
        finish(exited.target);
      }
      quit("esc-or-ctrl-c");
    }
    if (state.level > before) run("enter");
    else if (state.level < before) run("back");
    else draw();
  }
  closeSync(CONIN);
  quit("read-error");
}

// Only run the loop when invoked as a program, never on import -- otherwise the
// test that imports `screen` would block on a console read.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/uwpick.mjs")) {
  main();
}

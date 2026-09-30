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
import { loadSnapshot, applyLive, SNAPSHOT_FILE } from "./snapshot.mjs";
import { openOverlay, decideOverlayReload, feedNote } from "./observed-data.mjs";
import { launchObserver } from "./observe-launch.mjs";
// NOTE: catalog.mjs is deliberately NOT imported here. It pulls in keysync and a
// 19.7 MB catalogue parse, and the picker's whole input is the pre-built
// snapshot (Q1.1). Routability arrives on the snapshot rows (Q1.3).
import { initState, reduce, view, tokenize, carryAcrossRebuild } from "./pick-state.mjs";
import { loadBench, oldestStampOf, ageHistOf } from "./bench-data.mjs";
import { handoffTarget, modelCommand, CONTRACT } from "./cc-contract.mjs";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff,
         recordStartup } from "./state.mjs";
import { frame, confirmLine, detectCaps, glyphsFor, painter, motionEnabled,
         slideFrames, revealFrames, flashFrames, sleepSync, keyIdWidth, flatIdWidth, FRAME_MS } from "./style.mjs";

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

/**
 * The header/stamp figures the renderer reads from the snapshot rows, and from the live overlay when `applyLive` laid it over them. Pure.
 * `observed` is `loadObserved()`: the newest live record's time (`liveAt`) is drawn only while the overlay is actually applied to a row
 * (`benchLive` above zero), and `liveOkTotal` is how many of the header's ok are live-derived.
 */
export function metaFor(snap, observed = null, nowMs = Date.now()) {
  const rows = snap.rows;
  const on = !!observed;                                    // the kill switch (or no overlay) means no live figure at all
  let liveAt = null;
  // The newest live record's time, from the overlay itself, whether `applyLive` fired or the snapshot was rebuilt after the overlay and baked the
  // live counts in (`benchLive` on the rows either way). A future-dated entry (past the skew allowance) is not evidence and is ignored; whether a probe
  // has since superseded an entry is only knowable once bench.json is read, and the exact figure replaces this one when a model screen loads it.
  if (on && observed.models?.size && rows.some((r) => r.benchLive > 0)) {
    for (const o of observed.models.values()) if (o.a * 1000 - nowMs <= 5 * 60_000 && (liveAt === null || o.a > liveAt)) liveAt = o.a;
  }
  return {
    providers: rows.length,
    models: rows.reduce((n, r) => n + r.models.length, 0),
    generatedAt: snap.generatedAt,
    // Q1.3: carried straight through from the snapshot the refresher wrote. The
    // picker asks nobody anything; it prints the stamp so the user can see how
    // old the dim state is rather than assuming it is live.
    routableAsOf: snap.routableAsOf ?? null,
    // R15/R16: same reasoning, same failure shape (B3/OQ-4) this file's own
    // comment already names for `routableAsOf` -- a field the renderer reads
    // and nobody writes renders a permanent, indistinguishable-from-broken
    // dash. `meta` is a fixed literal built here, not derived from `snap`
    // downstream, so adding the field to the snapshot (R15) without adding it
    // HERE would have shipped a header reading `undefined` on every row.
    discoveredAsOf: snap.discoveredAsOf ?? null,
    // #114: when the sweep behind the provider list's status counts was taken. Named
    // apart from `benchAsOf`, which the model screens set from bench.json itself.
    benchCountsAsOf: snap.benchAsOf ?? null,
    // #114: the provider list's key id column is sized to the longest key id over ALL
    // rows, once, so it neither drifts right on wide terminals nor moves while filtering.
    // The FULL key id is drawn (bucket included), so the width is the longest full id.
    keyIdW: keyIdWidth(rows),
    // The rows themselves, so the key id column can elide with distinctness across ALL of them.
    rows,
    // The same idea for flat scope's id column (its longest `provider/model` target), and the
    // header's total of ok models: the sum of the per-row counts baked into the snapshot.
    // `null` when no row carries bench data, which the header draws as a dash.
    flatIdW: flatIdWidth(rows),
    // `0 ok` only when at least one provider row has a fresh record (any status count above zero);
    // a snapshot whose counts are all zero knows nothing, and reads `- ok` like the live figures.
    okTotal: rows.some((r) => r.bench && Object.values(r.bench).some((n) => n > 0))
      ? rows.reduce((n, r) => n + (r.bench?.ok ?? 0), 0) : null,
    // The header percent leaves `gone` routes out of its denominator (models minus gone), from the same baked counts.
    goneTotal: rows.reduce((n, r) => n + (Number.isFinite(r.bench?.gone) ? r.bench.gone : 0), 0),
    // How many of that ok total came from the live overlay (drawn `812 ok (2 live)`), and the newest live record's time (epoch s).
    liveOkTotal: on ? rows.reduce((n, r) => n + (Number.isSafeInteger(r.benchLiveOk) ? r.benchLiveOk : 0), 0) : 0,
    liveAt,
  };
}

export function firstFrame({ snap, recents, favourites, caps, termRows, observed = null }) {
  const rows = snap.rows;
  // The provider list's outdated notice comes from the snapshot's baked stamp until bench.json is loaded.
  const state = initState(rows, { recents, favourites, termRows, benchOldestAt: snap.benchOldestAt ?? null, feedNote: feedNote(observed) });
  const meta = metaFor(snap, observed);
  return { state, meta, text: screen(view(state), meta, { caps }) };
}

export function failMessage(res) {
  const fix = "run: node C:/Users/osami/.uw/menu/snapshot.mjs --build";
  if (res.reason === "missing") return `uwpick: no catalogue snapshot at ${res.detail} — ${fix}`;
  if (res.reason === "schema") return `uwpick: snapshot is the wrong version (${res.detail}) — ${fix}`;
  return `uwpick: snapshot unreadable (${res.detail}) — ${fix}`;
}

// NO keysync state file is read here, and that is the design rather than an
// omission. An earlier revision of the Anthropic-catalog work added a banner fed
// by `~/.uw/state/new-anthropic-models.json`; the native picker now shows every
// live Anthropic id, so "new id detected, not added" no longer describes
// anything, and the coupling was removed with it. uwpick's whole input remains
// the pre-built catalogue snapshot.
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
// How long a fatal message stays on screen before we exit. MEASURED: under
// ctrl+g the user saw NOTHING at all. Claude Code runs the editor inside the
// alternate screen buffer and restores it the instant the child exits, so
// anything written here is wiped before it can be read -- and the only path that
// carries a message is the one a user who has never built a snapshot will hit,
// who has the least context to work out what happened. Holding the screen is the
// one way to make it readable while still leaving the chat input empty, which is
// what Q2.1 promises.
//
// Overridable so tests do not pay it, and so it can be turned off entirely.
const ERROR_HOLD_MS = Number(process.env.UW_PICKER_ERROR_HOLD_MS ?? 2500);

function abort(out, FILE, message) {
  if (message) {
    // ONE copy, on whichever stream the user can actually see. Writing to both
    // prints it twice whenever they share a terminal, which is the normal case
    // and which the first version of this did. stdout is the screen the picker
    // has been drawing on; stderr is the right place only when stdout is not a
    // terminal, i.e. when nothing was ever shown and the line is going to a log.
    if (out.isTTY) {
      try { out.write("\n" + message + "\n"); } catch { process.stderr.write(message + "\n"); }
      if (ERROR_HOLD_MS > 0) sleepSync(ERROR_HOLD_MS);
    } else {
      process.stderr.write(message + "\n");
    }
  }
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
  // THE LIVE OVERLAY AT OPEN: one small file (`observed.json`, about a millisecond), never bench.json. `applyLive` lays the recorder's
  // precomputed per-provider recount over the rows when it is newer than the snapshot; with no overlay, the kill switch on, or a
  // snapshot built after it, the snapshot comes back untouched. `loaded.snap` stays the BASE so a later change can re-apply cleanly.
  // The overlay's mtime is taken BEFORE it is read (`openOverlay`), so a write landing between the two is seen on the next keystroke.
  const opened = openOverlay();
  let observed = opened.observed;
  let snap = applyLive(loaded.snap, observed);
  let obsMtime = opened.mtime;
  let { state, meta } = firstFrame({
    snap, observed, recents, favourites, caps, termRows: out.rows || 30,
  });

  const lines = () => frame(view(state), meta, { caps });
  const run = (kind, index) => {
    for (const f of framesFor(kind, lines(), { motion, painter: p, caps, index })) {
      paint(out, f);
      if (motion) sleepSync(FRAME_MS);
    }
  };
  const draw = () => {
    // COLUMNS AS WELL AS ROWS. `caps.cols` was read once at startup and never
    // again, which was harmless while the frame was a fixed 78 and is not now:
    // widening the terminal would leave the frame at its launch width until the
    // picker was restarted. Same cadence as the row re-read beside it -- there is
    // no event loop here to hang a `resize` listener on, so both are refreshed on
    // the keystroke that triggers the redraw.
    //
    // Mutated rather than rebuilt: `glyphsFor`/`painter`/`motionEnabled` were
    // resolved from this object at startup and a fresh `detectCaps` would leave
    // them pointing at the old one.
    caps.cols = out.columns ?? caps.cols;
    state = reduce(state, { resize: out.rows || 30 }).state;
    paint(out, lines());
  };

  out.write(HIDE + CLEAR);
  run("open");                                     // startup reveal, inside the budget
  recordStartup(Number(process.hrtime.bigint() - t0) / 1e6);
  // After the first frame and the startup record: the one-shot catch-up child (detached, exits by itself; never throws into the picker).
  launchObserver();

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
  const finish = (target, routable) => {
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
    //
    // #48, "surface, do not block": the selection above already went through
    // unconditionally -- this only adds a second line when the picker itself
    // knew, at build time, that CCR had no route for this id. `routable` is
    // `false` (known dead), `true` (known live) or `null`/`undefined`
    // (never resolved, e.g. the gateway did not answer that build) -- only
    // the first warns; D9 forbids treating "unknown" as "dead".
    const warn = routable === false
      ? `\n${p.dim(`not in CCR's routing table as of ${String(loaded.snap.routableAsOf ?? "unknown").replace(/[^ -~]/g, "?").slice(0, 40)}; it may not respond`)}`
      : "";
    out.write(CLEAR + SHOW + confirmLine(target, g, p) + warn + "\n");
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

  // Set UW_PICK_TRACE to a path to record every read. This surface cannot be
  // driven by a test -- tmux gives a pty rather than a Windows console input
  // buffer, and synthetic WriteConsoleInput records were not observed to reach a
  // readSync on CONIN$ -- so when it misbehaves under Claude Code's ctrl+g the
  // only way to see what arrived is to write it down as it arrives. Off unless
  // the variable is set, and it never affects what the picker does with a key.
  const TRACE = process.env.UW_PICK_TRACE || null;
  const t = (ev, extra) => {
    if (!TRACE) return;
    try {
      fs.appendFileSync(TRACE, JSON.stringify({
        ms: Number(process.hrtime.bigint() - t0) / 1e6, ev, ...extra }) + "\n");
    } catch { /* tracing must never break the picker */ }
  };
  t("loop-start", { level: state.level, scope: state.scope });

  const buf = Buffer.alloc(1024);
  for (;;) {
    let n = 0;
    try { n = readSync(CONIN, buf, 0, buf.length, null); }
    catch (e) { t("read-threw", { message: String(e.message).slice(0, 120) }); break; }
    t("read", { n, hex: buf.toString("hex", 0, Math.max(0, Math.min(n, 64))),
                text: JSON.stringify(buf.toString("utf8", 0, Math.max(0, Math.min(n, 64)))),
                tokens: n > 0 ? tokenize(buf.toString("utf8", 0, n)).length : 0 });
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
      // initState rebuilds everything, so what is not derived from the snapshot (the view toggles, the bench reader with
      // its stamp and histograms) is carried across by `carryAcrossRebuild`.
      state = carryAcrossRebuild(state, initState(snap.rows, { ...next, termRows: out.rows || 30, nowMs: state.now }));
    }
    // THE OVERLAY CHANGED ON DISK (the recorder's child finished, or a confirmation landed): one `stat` per keystroke, inside a try/catch
    // (an error reads as "unchanged"). On a new mtime the overlay is read again and laid over the rows in place (the cursor, the level and the
    // filters stay where they are), the header figures are recomputed, and the bench reader is dropped from `meta` so the SINGLE `loadBench`
    // site below reloads it if a model screen is showing.
    // `decideOverlayReload` says what to do; a torn or half-written file is "keep" (the previous state stays, and it is tried again on the next
    // keystroke), only a missing file or the kill switch clears the overlay.
    const re = decideOverlayReload(obsMtime);
    if (re.kind === "keep") obsMtime = re.mtime;
    else if (re.kind === "apply" || re.kind === "clear") {
      obsMtime = re.mtime;
      observed = re.observed;
      snap = applyLive(loaded.snap, observed);
      const keep = state.provider?.keyId;
      state = { ...state, rows: snap.rows, provider: keep ? snap.rows.find((r) => r.keyId === keep) ?? state.provider : state.provider,
                feedNote: feedNote(observed) };
      meta = { ...meta, ...metaFor(snap, observed), benchOf: undefined };
    }
    // The live clock, refreshed per keystroke: the "confirming..." window and the age of a record written after the picker opened read it
    // (the open time `state.now` stays frozen so probe ages and bands do not tick while the picker is open).
    state = { ...state, liveNow: Date.now() };
    // #114: bench.json is read ONCE, synchronously, the first time a MODEL screen (level 1
    // or flat scope) is about to be drawn -- never at startup and never while only the
    // provider list is used. loadBench is total (a missing or corrupt file is an empty
    // result), so this cannot take the picker down. The reader goes to the renderer
    // through `meta` and to the reducer (the ok-only filter) as an event.
    if ((state.level > 0 || state.scope === "flat") && !meta.benchOf) {
      const b = loadBench();
      // `liveAt` (the newest merged live record) and the feed note come from the SAME read: exact now that the reader is merged.
      meta = { ...meta, benchOf: b.get, benchAsOf: b.size ? b.generatedAt : null, liveAt: b.live > 0 ? b.liveAt : null };
      // bench.json wins over the snapshot's baked stamp and histograms once it is loaded: the oldest record among the listed
      // routes, and each provider's age histogram. An empty or missing file has nothing to say: the snapshot's stay.
      const fromFile = b.size ? { benchOldestAt: oldestStampOf(snap.rows, b.get, state.now),
        benchHist: new Map(snap.rows.map((r) => [r.keyId, ageHistOf(r.provider, r.models, b.get, state.now)])) } : {};
      state = reduce(state, { benchOf: b.get, ...fromFile, feedNote: feedNote(b.overlay) }).state;
    }
    if (exited) {
      closeSync(CONIN);
      if (exited.target) {
        recordRecent(exited.target);
        run("select", view(state).cursor - view(state).top + 4);
        finish(exited.target, exited.routable);
      }
      quit("esc-or-ctrl-c");
    }
    if (state.level > before) run("enter");
    else if (state.level < before) run("back");
    else draw();
    // AFTER the draw, so a trace line is evidence the repaint was reached and not
    // merely that the key was read. Without this the trace can prove input
    // arrives and still not say whether anything moved on screen, which is the
    // difference between an input bug and a rendering one.
    t("after", { level: state.level, scope: state.scope,
                 cursor: view(state).cursor, filter: view(state).filter,
                 items: view(state).items.length });
  }
  closeSync(CONIN);
  quit("read-error");
}

// Only run the loop when invoked as a program, never on import -- otherwise the
// test that imports `screen` would block on a console read.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/uwpick.mjs")) {
  main();
}

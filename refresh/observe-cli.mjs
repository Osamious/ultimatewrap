// Live model status: the one-shot entry. Run it as
//
//   node --no-warnings refresh/observe-cli.mjs --catchup              read new usage rows, update state/observed.json (default)
//   node --no-warnings refresh/observe-cli.mjs --catchup --dry        compute and print, write NOTHING (no overlay, run file or lock)
//   node --no-warnings refresh/observe-cli.mjs --catchup --dry --backfill-days 3   ... as if the first run started 3 days back
//                                                     (applies only when there is no watermark yet; ignored otherwise)
//   node refresh/observe-cli.mjs --status | --reset | --off | --on
//
//   node --no-warnings refresh/observe-cli.mjs --confirm <provider/id>   ONE confirmation probe (spawned by --catchup, never typed by hand)
//
// Exactly one mode flag per run (--catchup is the default when none is given); two are refused with exit 2.
// It is a short-lived process that exits by itself, not a daemon. `--catchup` never contacts the gateway; `--confirm` sends one
// tiny probe of one model (plan D). The persistent kill
// switch is the sentinel file state/observe.off: `--off` creates it, `--on` removes it, and while it exists both
// `--catchup` and `--confirm` exit at once, silently. `--status`, `--reset`, `--on` and `--off` always work.

import { fileURLToPath } from "node:url";
import path from "node:path";
import { observePaths, observeEnabled, observeStatus, resetObserved, runCatchup, runConfirm, setObserveOff, isConfirmKey } from "./observe.mjs";

const MODE_FLAGS = new Set(["--catchup", "--confirm", "--status", "--reset", "--off", "--on"]);

/** Argv -> options, or `{ error }`. At most ONE mode flag: `--off --catchup` is a contradiction, not a request. */
export function parseArgs(argv) {
  const o = { mode: "catchup", dry: false, backfillDays: null, key: null };
  const modes = [];                                     // exactly one of --catchup --confirm --status --reset --off --on
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (MODE_FLAGS.has(a)) modes.push(a);
    if (a === "--catchup") o.mode = "catchup";
    else if (a === "--confirm") {
      o.mode = "confirm"; o.key = argv[++i] ?? null;
      if (!isConfirmKey(o.key)) return { error: "--confirm takes one provider/id (letters, digits and . _ : @ + / [ ] -)" };
    }
    else if (a === "--status") o.mode = "status";
    else if (a === "--reset") o.mode = "reset";
    else if (a === "--off") o.mode = "off";
    else if (a === "--on") o.mode = "on";
    else if (a === "--dry") o.dry = true;
    else if (a === "--backfill-days") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 30) return { error: "--backfill-days takes a whole number from 1 to 30" };
      o.backfillDays = n;
    } else return { error: `unrecognised argument ${JSON.stringify(a)}` };
  }
  if (modes.length > 1) return { error: `only one mode at a time, got ${modes.join(" and ")}` };
  if (o.dry && o.mode !== "catchup") return { error: "--dry goes with --catchup" };
  if (o.backfillDays !== null && o.mode !== "catchup") return { error: "--backfill-days goes with --catchup" };
  return o;
}

const line = (out, s) => out(`observe: ${s}`);

/** The whole CLI as a function (`out`/`err` and the dirs are injectable). Returns the exit code. */
export async function main(argv, { out = console.log, err = console.error, stateDir, ...engine } = {}) {
  const o = parseArgs(argv);
  if (o.error) { err(`observe: ${o.error}`); return 2; }
  const P = observePaths(stateDir);
  const dir = P.dir;

  if (o.mode === "status") {
    const s = observeStatus(dir);
    line(out, `${s.enabled ? "enabled" : `DISABLED (remove ${path.basename(P.off)} or run --on)`}`);
    line(out, `last run: ${s.ranAt ?? "never"}${s.lastError ? `; last error: ${s.lastError}` : "; no error"}`);
    line(out, `feed: ${s.feed ?? "unknown"}${s.lockedRuns ? `; ${s.lockedRuns} locked run(s) in a row` : ""}`);
    if (s.feed === "unavailable:schema" && s.missing.length) line(out, `usage_events columns missing: ${s.missing.join(", ")}`);
    line(out, `watermark: ${s.wm ? `id ${s.wm.id}${s.wm.at ? ` (row time ${s.wm.at})` : ""}` : "none yet"}${s.reset ? "; the last run re-initialised it (the router's table was reset)" : ""}`);
    line(out, `overlay: ${s.models} model record(s), ${s.pend} pending${s.writtenAt ? `, written ${s.writtenAt}` : ""}`);
    if (s.lastSkip) line(out, `last run examined ${s.lastExamined}; skipped ${JSON.stringify(s.lastSkip)}`);
    return 0;
  }
  if (o.mode === "off") { line(out, setObserveOff(dir, true) ? `disabled (created ${P.off})` : "already disabled"); return 0; }
  if (o.mode === "on") { line(out, setObserveOff(dir, false) ? `enabled (removed ${P.off})` : "already enabled"); return 0; }
  if (o.mode === "reset") {
    const removed = resetObserved(dir);
    line(out, removed.length ? `removed ${removed.join(", ")}; the next run starts at the first UW-probe row in the last 3 days, else at the router's current last row` : "nothing to remove");
    return 0;
  }

  // catch-up and confirm: the kill switch first, silently.
  if (!observeEnabled(dir)) return 0;
  if (o.mode === "confirm") {
    const r = await runConfirm({ key: o.key, stateDir, ...engine });
    line(out, r.outcome === "skipped" ? `confirm skipped (${r.reason})` : `confirm ${r.outcome}: probe said ${r.s}${r.reason ? ` (${r.reason})` : ""}`);
    return 0;
  }

  const r = await runCatchup({ stateDir, dry: o.dry, backfillDays: o.backfillDays, ...engine });
  if (r.skipped) { line(out, `skipped (${r.skipped}: another run holds the lock)`); return 0; }
  if (!r.ok) { err(`observe: failed: ${r.error}`); return 1; }
  const byClass = {};
  for (const w of r.wouldWrite) byClass[w.s] = (byClass[w.s] ?? 0) + 1;
  line(out, `${o.dry ? "DRY RUN (nothing written)" : "done"}: feed ${r.feed}; examined ${r.examined} row(s) in ${r.ms} ms${r.reset ? "; watermark re-initialised" : ""}`);
  line(out, `watermark ${r.wm ? r.wm.id : "none"}; skipped by reason ${JSON.stringify(r.skip)}`);
  line(out, `${o.dry ? "would write" : "wrote"} ${r.wouldWrite.length} record(s) ${JSON.stringify(byClass)}${r.confirm?.length ? `; ${r.confirm.length} failing -> ok flip(s) seen` : ""}`);
  const asked = o.dry ? r.confirmWould : r.confirmSpawned;
  if (asked?.length || Object.keys(r.confirmSkip ?? {}).length) line(out, `confirmation probes: ${o.dry ? "would request" : "requested"} ${asked?.length ?? 0}; not requested by reason ${JSON.stringify(r.confirmSkip ?? {})}`);
  // Only a run that read rows has these facts; an unavailable feed (missing DB, changed schema, ...) has nothing to say about them.
  if (r.provSeam !== undefined) line(out, `messages from ${r.msgSource ?? "none"}; per-provider recount ${r.provSeam ? "baked" : "not available yet (bakeBench not exported)"}`);
  if (r.error) line(out, `note: ${r.error}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A hung child must not linger: a run is a few tens of milliseconds, so ten seconds is generous.
  setTimeout(() => process.exit(3), process.argv.includes("--confirm") ? 90_000 : 10_000).unref();
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`observe: ${e?.message ?? e}`); process.exit(1); });
}

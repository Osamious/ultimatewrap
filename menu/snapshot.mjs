// The picker's whole input, pre-joined.
//
// catalog.mjs:build() is the expensive path: it imports keysync, reads the vault
// through a PowerShell round trip, parses a 19.7 MB catalogue and joins the two.
// That work belongs to whoever refreshes the catalogue, not to whoever presses
// ctrl+g -- at which point Claude Code has already blanked the screen and the
// user is watching an empty terminal (Q1.1).
//
// The file is deliberately dumb: no functions, no derived state, only the cells a
// row draws plus the context limits Task A14 reads. Anything that needs the full
// catalogue is by definition not the picker.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic } from "./atomic.mjs";

// 2 since 2026-09-06. Bumped once for three meaning changes at once: `tools`,
// `vision` and `reason` are now tri-state rather than coerced booleans, and
// `outputKind` and `routable` are new. Nothing here validates fields, so an old
// file would load and render silently wrong -- with `false` where the catalogue
// said nothing and every row undimmed. The bump is what forces the rebuild.
export const SNAPSHOT_SCHEMA = 2;
export const SNAPSHOT_FILE = path.join(os.homedir(), ".uw", "catalog", "snapshot.json");

// routableSet's own default is 400 ms and stays right for a latency-budgeted
// caller. This is not one: main() already parses a 19.7 MB catalogue and reads
// the vault through a PowerShell round trip, on a path the operator invoked
// deliberately and is not watching, so 400 ms was sized for a caller that does
// not exist. 5,000 is the same order as run.mjs's other non-interactive waits
// and still well under the work it sits beside.
//
// This is the one number in the task whose whole purpose is that getting it
// wrong is silent: a timeout here produces a snapshot with routability unknown
// for all 1,588 rows, which is byte-for-byte the artifact this task exists to
// remove and is indistinguishable from never having asked. Hence the explicit
// pass and the announcement below.
const ROUTABLE_TIMEOUT_MS = 5000;

export function buildSnapshot(built) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    generatedAt: built.generatedAt ?? null,
    // The stamp style.mjs:269-271 renders and uwpick.mjs:56 reads. Both have read
    // it since they were written and nothing ever wrote it, so the header has
    // shown a dash in every session that has ever run -- and the dash is exactly
    // the disclosure meant to reveal that no routability was resolved. The
    // mechanism built to make the failure visible was itself part of the failure.
    routableAsOf: built.routableAsOf ?? null,
    builtAt: new Date().toISOString(),
    rows: built.rows.map((r) => ({
      keyId: r.keyId, provider: r.provider, free: r.free,
      planCount: r.planCount, health: r.health,
      models: r.models.map((m) => ({
        id: m.id, ctx: m.ctx, pin: m.pin, pout: m.pout, badge: m.badge,
        tools: m.tools, vision: m.vision, reason: m.reason,
        // An explicit literal, so every field the picker draws has to be named
        // here to survive. That is not a hypothetical property: `routable` was
        // set by buildFrom, omitted from this list, and dropped on every build --
        // the snapshot stayed valid, the picker kept rendering, and a test
        // asserting the exact key set certified the drop as correct.
        outputKind: m.outputKind, routable: m.routable,
      })),
    })),
  };
}

export function writeSnapshotFile(snap, file = SNAPSHOT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(snap));      // not pretty-printed: this is read, not edited
  return file;
}

// Four outcomes, each with its own caller-visible reason. A single boolean here
// would collapse "you have not built it yet" into "your build is corrupt", and
// those need different sentences from the picker (Q2.1, Q2.2).
export function loadSnapshot(file = SNAPSHOT_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { ok: false, reason: "missing", detail: file }; }
  let snap;
  try { snap = JSON.parse(text); }
  catch (e) { return { ok: false, reason: "unreadable", detail: String(e.message).slice(0, 120) }; }
  if (snap?.schemaVersion !== SNAPSHOT_SCHEMA || !Array.isArray(snap.rows)) {
    return { ok: false, reason: "schema",
             detail: `expected schemaVersion ${SNAPSHOT_SCHEMA}, found ${JSON.stringify(snap?.schemaVersion)}` };
  }
  return { ok: true, snap };
}

export function contextIndex(snap) {
  const ix = new Map();
  for (const r of snap?.rows ?? []) {
    for (const m of r.models ?? []) {
      if (Number.isFinite(m.ctx)) ix.set(`${r.provider}/${m.id}`, m.ctx);
    }
  }
  return ix;
}

export async function main(argv = process.argv.slice(2),
                           { rpc, file = SNAPSHOT_FILE, log = (s) => console.log(s) } = {}) {
  if (!argv.includes("--build")) {
    log("usage: node menu/snapshot.mjs --build");
    process.exit(2);
  }
  // EXTEND the existing dynamic import; never add a static one. snapshot.mjs is
  // inside uwpick's transitive import graph and catalog.mjs statically imports
  // keysync.mjs, so a top-level `import { routableSet } from "./catalog.mjs"`
  // would compile, pass every test, and quietly move both modules onto the
  // picker's 300 ms startup path -- invalidating the line-budget test's
  // definition of its own scope (standing constraint 25). The dynamic form is
  // what keeps the expensive half of this file out of the picker.
  const { build, routableSet, makeRoutableOf } = await import("./catalog.mjs");
  const { set, fresh } = await routableSet({ timeoutMs: ROUTABLE_TIMEOUT_MS, rpc });
  const snap = buildSnapshot(build({
    routableOf: makeRoutableOf(set, fresh),
    routableAsOf: fresh ? new Date().toISOString() : null,
  }));
  const written = writeSnapshotFile(snap, file);
  const models = snap.rows.reduce((n, r) => n + r.models.length, 0);
  log(`snapshot: ${written}`);
  log(`  ${snap.rows.length} providers, ${models} models, catalogue ${snap.generatedAt}`);

  // Two degraded readings, two distinct lines, and both PRINT rather than throw.
  // A snapshot with unknown routability is honest and usable -- null renders
  // undimmed by design -- and one built while the gateway served nothing is an
  // accurate reading; a build that refuses to produce either leaves the picker
  // with no input at all. The announcement is the control; failing would be the
  // overreaction.
  //
  // They are separate lines because they are separate facts: `fresh: false` means
  // nobody answered, `fresh` with an empty set means someone answered "nothing".
  // The second is the more alarming screen -- every row dims while the header
  // stamp claims the answer is fresh -- and it is the one a reader would
  // otherwise diagnose as a broken build.
  if (!fresh) {
    log(`  routability: the gateway did not answer within ${ROUTABLE_TIMEOUT_MS}ms, so it is ` +
        `unknown for all ${models} rows and the header stamp will show a dash`);
  } else if (set.size === 0) {
    log("  routability: the gateway answered with no routable providers, " +
        `so every one of the ${models} rows will render dimmed`);
  } else {
    log(`  routability: ${set.size} targets routable as of ${snap.routableAsOf}`);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/snapshot.mjs")) {
  await main();
}

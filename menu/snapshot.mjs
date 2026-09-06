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

export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_FILE = path.join(os.homedir(), ".uw", "catalog", "snapshot.json");

export function buildSnapshot(built) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    generatedAt: built.generatedAt ?? null,
    builtAt: new Date().toISOString(),
    rows: built.rows.map((r) => ({
      keyId: r.keyId, provider: r.provider, free: r.free,
      planCount: r.planCount, health: r.health,
      models: r.models.map((m) => ({
        id: m.id, ctx: m.ctx, pin: m.pin, pout: m.pout, badge: m.badge,
        tools: m.tools, vision: m.vision, reason: m.reason,
        // An explicit literal, so every field the picker draws has to be named
        // here to survive. That is the property: a field buildFrom sets but this
        // list omits is dropped silently, with the snapshot still valid and every
        // test still green.
        outputKind: m.outputKind,
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

export async function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--build")) {
    console.log("usage: node menu/snapshot.mjs --build");
    process.exit(2);
  }
  const { build } = await import("./catalog.mjs");
  const snap = buildSnapshot(build());
  const file = writeSnapshotFile(snap);
  const models = snap.rows.reduce((n, r) => n + r.models.length, 0);
  console.log(`snapshot: ${file}`);
  console.log(`  ${snap.rows.length} providers, ${models} models, catalogue ${snap.generatedAt}`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/snapshot.mjs")) {
  await main();
}

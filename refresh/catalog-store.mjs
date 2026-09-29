// B4 (not B5): insulate keysync from the CCR bundle disappearing on a global
// reinstall -- a FLAT copy-out, not a versioned store. No `current` pointer,
// no lock file, no version directories, no pruning: the shipped
// `writeAtomic`-based system already gives one-writer atomicity, and B5's
// version-store machinery solves a problem (concurrent writers, rollback)
// this project does not have.
//
// Why this exists at all: `keysync.mjs` used to hardcode the bundle path with
// no fallback -- `readJson` threw ENOENT outright the moment that path moved.
// A global `npm i -g` has already silently wiped a local patch once
// (plans/phase6-menu-and-catalogue.md:8024-8030); the bundle path is exactly
// as fragile.
//
//   node refresh/catalog-store.mjs      copy the live bundle to the local store

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../menu/atomic.mjs";

export const BUNDLE_PATH =
  "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\models.json";
export const STORE_FILE = path.join(os.homedir(), ".uw", "catalog", "models.json");

export function assertSchema(doc) {
  if (!doc || doc.schemaVersion !== 2) {
    throw new Error(`catalogue schema mismatch: expected schemaVersion 2, got ${doc?.schemaVersion}`);
  }
  return doc;
}

// Copies the bundle OUT to the local store. Never writes the source (the
// node_modules tree is not this project's to mutate). Returns the path
// written to.
export function copyOut(src = BUNDLE_PATH, opts = {}) {
  const dest = opts.dest ?? STORE_FILE;
  const raw = fs.readFileSync(src, "utf8");
  assertSchema(JSON.parse(raw));   // fail before writing a bad copy over a good one
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  writeAtomic(dest, raw);
  return dest;
}

// The local copy if present, else the bundle path -- with a LOGGED warning,
// never a silent fallback. A fallback nobody sees is the same failure mode as
// no fallback at all.
export function resolveCatalogPath(opts = {}) {
  const local = opts.storeFile ?? STORE_FILE;
  if (fs.existsSync(local)) return local;
  const bundle = opts.bundlePath ?? BUNDLE_PATH;
  console.warn(`catalog-store: no local copy at ${local}, falling back to ${bundle} ` +
    `(run 'node refresh/catalog-store.mjs' to create one)`);
  return bundle;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dest = copyOut();
  console.log(`Copied catalogue to ${dest}`);
}

// B4: keysync.mjs used to hardcode the CCR bundle's node_modules path with no
// fallback -- a global `npm i -g` reinstall (which has already silently wiped
// a local patch once) leaves that path exactly as fragile as an ENOENT crash.
// This pins the flat copy-out and the resolve-with-fallback behaviour, and
// the regression guard that closes the actual gap: the hardcode must never
// come back into keysync.mjs itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { copyOut, resolveCatalogPath, assertSchema, BUNDLE_PATH, STORE_FILE }
  from "../refresh/catalog-store.mjs";

const SCHEMA_2 = { schemaVersion: 2, models: [] };

test("assertSchema accepts schemaVersion 2 and rejects everything else", () => {
  assert.deepEqual(assertSchema(SCHEMA_2), SCHEMA_2);
  for (const bad of [null, undefined, {}, { schemaVersion: 1 }, { schemaVersion: "2" }]) {
    assert.throws(() => assertSchema(bad), /schema mismatch/);
  }
});

test("copyOut writes a flat copy, never touching the source", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-catalog-store-"));
  const src = path.join(dir, "src.json");
  const dest = path.join(dir, "nested", "models.json");
  const srcText = JSON.stringify(SCHEMA_2);
  fs.writeFileSync(src, srcText);

  const written = copyOut(src, { dest });
  assert.equal(written, dest);
  assert.equal(fs.readFileSync(dest, "utf8"), srcText);
  assert.equal(fs.readFileSync(src, "utf8"), srcText, "the source must be untouched");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("copyOut refuses a schema mismatch before writing a bad copy over a good one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-catalog-store-"));
  const src = path.join(dir, "src.json");
  const dest = path.join(dir, "models.json");
  fs.writeFileSync(dest, JSON.stringify(SCHEMA_2));   // a good prior copy
  fs.writeFileSync(src, JSON.stringify({ schemaVersion: 1 }));

  assert.throws(() => copyOut(src, { dest }), /schema mismatch/);
  assert.deepEqual(JSON.parse(fs.readFileSync(dest, "utf8")), SCHEMA_2,
    "a rejected source must never overwrite the last good local copy");

  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveCatalogPath prefers the local store when present", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-catalog-store-"));
  const storeFile = path.join(dir, "models.json");
  fs.writeFileSync(storeFile, JSON.stringify(SCHEMA_2));
  assert.equal(resolveCatalogPath({ storeFile }), storeFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveCatalogPath falls back to the bundle path when no local copy exists, with a warning", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-catalog-store-"));
  const storeFile = path.join(dir, "does-not-exist.json");
  const bundlePath = "C:\\fake\\bundle\\models.json";

  let warned = "";
  const orig = console.warn;
  console.warn = (msg) => { warned = msg; };
  try {
    assert.equal(resolveCatalogPath({ storeFile, bundlePath }), bundlePath);
  } finally {
    console.warn = orig;
  }
  assert.match(warned, /no local copy/);
  assert.match(warned, /falling back/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("the real BUNDLE_PATH and STORE_FILE are the values keysync.mjs used to hardcode", () => {
  // Not a claim that the bundle exists on every machine this runs on -- just
  // that this module is the ONE place that path is allowed to live now.
  assert.match(BUNDLE_PATH, /claude-code-router.*models\.json$/);
  assert.match(STORE_FILE, /catalog[\\/]models\.json$/);
});

// -------------------------------------------------------- regression guard
// The actual defect: keysync.mjs hardcoded the bundle path with no fallback.
// This is the gap that let it happen unnoticed -- a plain grep, scoped to the
// one file this milestone fixes, so a reintroduced hardcode there fails a
// test instead of waiting for a reinstall to prove it wrong again.

test("keysync.mjs no longer hardcodes the CCR bundle path", () => {
  const src = fs.readFileSync(new URL("../keysync/keysync.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /node_modules.*claude-code-router.*models\.json/,
    "the catalogue path must be resolved through refresh/catalog-store.mjs, not hardcoded");
  assert.match(src, /resolveCatalogPath/, "loadCatalog must resolve the path through catalog-store.mjs");
});

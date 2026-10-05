// A guard for tests that must never touch the REAL `~/.uw/state`: wraps the fs entry points a reader or writer would use and records any path
// under it. Call `guardRealState(after, assert)` at the top of a test file; the hook asserts, once every test has run, that nothing was recorded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// The functions a reader or writer of files can reach, by form (S-F12: the router writes with the async callback forms and fs.promises, and a guard that only wrapped the
// synchronous ones saw none of that). `paths` is how many leading arguments name a path (rename and copyFile name two).
const SYNC = { readFileSync: 1, statSync: 1, lstatSync: 1, existsSync: 1, writeFileSync: 1, appendFileSync: 1, openSync: 1, readdirSync: 1, renameSync: 2, unlinkSync: 1, rmSync: 1, rmdirSync: 1,
  mkdirSync: 1, copyFileSync: 2, truncateSync: 1, utimesSync: 1, accessSync: 1, mkdtempSync: 1,
  // SEC-7: the rest of the filesystem surface a reader, a writer or a link maker can reach (a copy, a symlink or hard link whose target or source is the real folder, a permission or
  // owner change, a listing through opendir or a glob, a link read, a canonical-path lookup, a watcher)
  cpSync: 2, symlinkSync: 2, linkSync: 2, chmodSync: 1, chownSync: 1, lutimesSync: 1, opendirSync: 1, globSync: 1, readlinkSync: 1, realpathSync: 1, watchFile: 1 };
const CALLBACK = { readFile: 1, stat: 1, lstat: 1, writeFile: 1, appendFile: 1, open: 1, readdir: 1, rename: 2, unlink: 1, rm: 1, rmdir: 1, mkdir: 1, copyFile: 2, truncate: 1, utimes: 1, access: 1, createWriteStream: 1, createReadStream: 1,
  cp: 2, symlink: 2, link: 2, chmod: 1, chown: 1, lutimes: 1, mkdtemp: 1, opendir: 1, glob: 1, readlink: 1, realpath: 1, watch: 1 };
const PROMISES = { readFile: 1, stat: 1, lstat: 1, writeFile: 1, appendFile: 1, open: 1, readdir: 1, rename: 2, unlink: 1, rm: 1, rmdir: 1, mkdir: 1, copyFile: 2, truncate: 1, utimes: 1, access: 1, cp: 2,
  symlink: 2, link: 2, chmod: 1, chown: 1, lutimes: 1, mkdtemp: 1, opendir: 1, glob: 1, readlink: 1, realpath: 1, watch: 1 };
// NOTE (documented, not editable here): menu/uwpick.mjs:18 does `import { openSync, readSync, closeSync } from "node:fs"`. A NAMED import of a builtin binds the original function when
// that module is evaluated, BEFORE a test file calls guardRealState, so those three calls are not seen by this guard (the default-import callers are). If a test must observe them, patch
// the callers' module or pass the picker an fs seam; this guard cannot rebind a named import after the fact.
// Which argument positions of a WRITE-class call name the path it changes (the others are only read). A call that writes under the real state folder
// THROWS before it reaches the file system (a recorded touch is reported at the end of the run, after the damage): a test file must never write there.
// `open` is judged by its flags. The guard's own self-test uses a temp root and only records.
const WRITES = { writeFile: [0], appendFile: [0], rename: [0, 1], unlink: [0], rm: [0], rmdir: [0], mkdir: [0], truncate: [0], utimes: [0], lutimes: [0], copyFile: [1], cp: [1],
  symlink: [1], link: [1], chmod: [0], chown: [0], mkdtemp: [0], createWriteStream: [0] };
const writeIdx = (name, args) => {
  const base = name.replace(/^promises./, "").replace(/Sync$/, "").replace(/.native$/, "");
  if (base === "open") { const fl = args[1]; return typeof fl === "string" ? (/[wa+]/.test(fl) ? [0] : []) : typeof fl === "number" ? (fl & 3 ? [0] : []) : []; }
  return WRITES[base] ?? [];
};
const asPath = (p) => (typeof p === "string" ? p : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? p.toString() : null);

/** `opts.root` replaces the real state folder (the guard's own self-test uses a temp folder: no test may name the real one to prove the guard works). */
export function guardRealState(after, assert, opts = {}) {
  const real = (opts.root ?? path.join(os.homedir(), ".uw", "state")).toLowerCase();
  const touched = [];
  // A canonical-path or link lookup (realpath, readlink) of the real folder ITSELF is the protective comparison keysync/subagent-policy.mjs makes on purpose (it resolves the protected
  // folders to refuse a fixture path that lies under one) and reveals no content, so it is not a touch; the same lookup of anything INSIDE the folder is.
  const LOOKUP = /^(promises\.)?(realpath|readlink)(Sync)?(\.native)?$/;
  const hit = (name, args, n) => { for (let i = 0; i < n; i++) { const p = asPath(args[i]); if (p === null) continue; const r = path.resolve(p).toLowerCase(); if (r.startsWith(real) && !(LOOKUP.test(name) && r.replace(/[\/]+$/, "") === real.replace(/[\/]+$/, ""))) { touched.push(`${name}:${p}`); if (opts.root === undefined && writeIdx(name, args).includes(i)) throw new Error(`refused: a test tried to write under the real state folder (${name} ${p})`); return; } } };
  const wrap = (holder, name, n, label) => {
    const orig = holder[name];
    if (typeof orig !== "function") return;
    holder[name] = function (...args) { hit(label, args, n); return orig.apply(this, args); };
    if (typeof orig.native === "function") holder[name].native = function (...args) { hit(`${label}.native`, args, n); return orig.native.apply(this, args); };   // realpath and realpathSync carry a .native variant
  };
  for (const [name, n] of Object.entries(SYNC)) wrap(fs, name, n, name);
  for (const [name, n] of Object.entries(CALLBACK)) wrap(fs, name, n, name);
  for (const [name, n] of Object.entries(PROMISES)) wrap(fs.promises, name, n, `promises.${name}`);
  after(() => { assert.deepEqual(touched, [], "no test in this file reads or writes the real ~/.uw/state"); });
  return touched;
}

// ---- content guard for the REAL files an offline test must never change (an earlier executor overwrote the real state/bench.json with a
// fixture helper). Content is hashed and NEVER printed: a failure names the files only. Not for a file that also calls guardRealState (that
// guard would record these deliberate reads of state/).
const REAL = (() => {
  const home = os.homedir();
  return {
    bench: path.join(home, ".uw", "state", "bench.json"), observed: path.join(home, ".uw", "state", "observed.json"),
    catalogSnapshot: path.join(home, ".uw", "catalog", "snapshot.json"), claudeSettings: path.join(home, ".claude", "settings.json"),
    registry: path.join(home, ".llmkeys", "registry.json"), keyChoices: path.join(home, ".llmkeys", "key-choices.json"),
    vaultScript: path.join(home, ".llmkeys", "ApiKeyVault.ps1"),
  };
})();
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hashFile = (f) => { try { return sha(fs.readFileSync(f)); } catch { return "absent"; } };
/** sha256 of each named real file, or "absent": compare absence with absence. */
export const realFileHashes = (names) => Object.fromEntries(names.map((n) => [n, hashFile(REAL[n])]));
/** sha256 of every file under test/fixtures (recursively): a real file whose bytes equal one of these was written by a fixture helper (the incident signature). */
export function fixtureHashes() {
  const out = new Set(), root = path.join(path.dirname(fileURLToPath(import.meta.url)));
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.add(sha(fs.readFileSync(f))); } };
  walk(root);
  return out;
}
/**
 * `strict` files must have the same hash before and after (nothing but the test could be changing them). `signature` files are changed
 * LEGITIMATELY by other processes (a bench sweep, the observed-feed writer, keysync), so a different hash alone is not a failure: they
 * fail only when the new content is byte-identical to a test fixture file, which no legitimate writer produces.
 */
export function assertRealFilesUntouched(assert, before, after, { strict = [], signature = [] } = {}) {
  assert.deepEqual(strict.filter((n) => before[n] !== after[n]), [], "real files whose content hash changed during the test run (names only)");
  const fx = fixtureHashes();
  assert.deepEqual(signature.filter((n) => before[n] !== after[n] && fx.has(after[n])), [], "real files that now hold byte-for-byte fixture content: a fixture helper wrote them (names only)");
}

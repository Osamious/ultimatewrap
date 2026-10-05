// The fixture flag helper (plan 4, M6, 9.2b): materialises the fixture trio (and the other fixture files) into a temp
// directory and prints the FULL flag set of the subagent-policy CLI on ONE line, so no acceptance command carries a
// literal `...`:
//
//   T=$(mktemp -d); F=$(node test/fixtures/subagent-flags.mjs --dir "$T")
//   node keysync/key.mjs subagent-policy set --mode dynamic --source all-providers --dry yes $F
//
// An extra `--<flag> <value>` on its command line overrides that flag's value (for example `--registry-file
// "$T/nonexistent.json"` to simulate an unreadable registry). Also `import { fixtureFlags }` for tests.
// Refuses: a directory containing a space (the output is split on spaces); a directory whose realpath is outside os.tmpdir(); a temp
// root that is, or contains, the home folder; a directory that is neither absent nor empty nor already one of these fixture
// directories (a marker file says so). A REUSED directory (marker present) is checked entry by entry: every top-level entry must be
// the marker, `state`, `llmkeys` or a known fixture file name, and NO entry anywhere in it may be a symlink or junction (a
// pre-planted `state` junction would make the emitted --state-dir write through it). Every emitted flag path must also resolve
// (realpath) to somewhere under the temp root. These checks run before any write; they are a check-then-write sequence, not a lock:
// a link planted between the check and the write by a concurrent process is not caught. Files are copied with COPYFILE_EXCL, so a
// re-run (the acceptance commands run it twice on one directory, the second time with an override flag) keeps what an earlier step
// or a test already changed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent");
// flag -> file name inside the temp directory
export const FLAG_FILES = Object.freeze({
  "--providers-file": "providers.json", "--snapshot-file": "snapshot.json", "--bench-file": "bench.json",
  "--observed-file": "observed.json", "--default-model-file": "default-model.json", "--registry-file": "registry.json",
  "--key-choices-file": "key-choices.json", "--vault-providers-file": "vault-providers.json", "--settings-file": "settings.json",
  "--tool-fidelity-file": "tool-fidelity.json",          // deliberately NOT materialised: absent means every row is `u`
});
const fwd = (p) => p.split(path.sep).join("/");

export const MARKER = ".uw-subagent-fixture";
/** realpath of the deepest existing ancestor plus the not-yet-existing tail (so an absent directory can still be placed). */
function resolveReal(p) {
  let head = path.resolve(p), tail = "";
  for (;;) {
    try { return path.join(fs.realpathSync(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail = path.join(path.basename(head), tail); head = up;
  }
}
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

const under = (child, dir) => norm(child).startsWith(norm(dir) + path.sep);
const knownNames = () => new Set([MARKER, "state", "llmkeys", ...fs.readdirSync(SRC), ...Object.values(FLAG_FILES)]);
/** Every entry below `d` through lstat: a symlink or junction anywhere is refused (lstat does not follow, and reports a junction as a link). */
function refuseLinks(d) {
  for (const e of fs.readdirSync(d)) {
    const p = path.join(d, e), st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`fixture directory holds a symlink or junction, refused: ${p}`);
    if (st.isDirectory()) refuseLinks(p);
  }
}

/** The refusal rules with NO side effect: returns {target, reuse} or throws. Pure, so a test can aim it at the real folders; `root` and `home` are injectable. */
export function checkFixtureDir(dir, { root = resolveReal(os.tmpdir()), home = os.homedir() } = {}) {
  if (/\s/.test(dir)) throw new Error(`fixture directory must not contain whitespace: ${dir}`);
  const target = resolveReal(dir), h = resolveReal(home);
  if (norm(h) === norm(root) || under(h, root)) throw new Error(`the temp root ${root} is, or contains, the home folder ${h}: a fixture folder there could shadow real state; point TEMP/TMPDIR elsewhere`);
  if (!under(target, root)) throw new Error(`fixture directory must be inside ${root}, found ${target}`);
  let reuse = false;
  if (fs.existsSync(target)) {
    if (fs.lstatSync(path.resolve(dir)).isSymbolicLink()) throw new Error(`fixture directory is itself a symlink or junction, refused: ${path.resolve(dir)}`);
    if (!fs.statSync(target).isDirectory()) throw new Error(`fixture directory is not a directory: ${target}`);
    const have = fs.readdirSync(target);
    reuse = have.includes(MARKER);
    if (have.length && !reuse) throw new Error(`fixture directory must be absent or empty (it is not): ${target}`);
    if (reuse) {
      const known = knownNames(), foreign = have.filter((n) => !known.has(n));
      if (foreign.length) throw new Error(`fixture directory holds files that are not fixture files, refused: ${foreign.join(", ")} in ${target}`);
      refuseLinks(target);
    }
  }
  return { target, reuse };
}

export function materialize(dir) {
  const { target, reuse } = checkFixtureDir(dir);
  fs.mkdirSync(path.join(target, "state"), { recursive: true });
  fs.mkdirSync(path.join(target, "llmkeys"), { recursive: true });
  if (!reuse) fs.writeFileSync(path.join(target, MARKER), "materialised by test/fixtures/subagent-flags.mjs\n", { flag: "wx" });
  for (const f of fs.readdirSync(SRC)) {
    try { fs.copyFileSync(path.join(SRC, f), path.join(target, f), fs.constants.COPYFILE_EXCL); }
    catch (e) { if (!(reuse && e.code === "EEXIST")) throw e; }
  }
  return dir;
}

/** The flag array for `dir` (materialises it first); `overrides` maps a flag to a replacement value. */
export function fixtureFlags(dir, overrides = {}) {
  const d = path.resolve(dir);
  materialize(d);
  const base = { "--policy-file": path.join(d, "llmkeys", "subagent-policy.json"), "--state-dir": path.join(d, "state"),
    ...Object.fromEntries(Object.entries(FLAG_FILES).map(([k, f]) => [k, path.join(d, f)])) };
  const root = resolveReal(os.tmpdir()), out = [];
  for (const [k, v] of Object.entries(base)) {
    const emit = overrides[k] ?? v;                                  // an override is emitted too, so it is held to the same rule
    if (!under(resolveReal(emit), root)) throw new Error(`emitted ${k} ${emit} resolves outside ${root}, refused`);
    out.push(k, fwd(emit));
  }
  return out;
}

/** The same flags as an object keyed WITHOUT the leading dashes (the shape `resolvePaths` takes). */
export function fixtureFlagMap(dir, overrides = {}) {
  const a = fixtureFlags(dir, overrides), o = {};
  for (let i = 0; i < a.length; i += 2) o[a[i].slice(2)] = a[i + 1];
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
  const dir = get("--dir");
  if (!dir) { console.error("usage: subagent-flags.mjs --dir <temp dir> [--<flag> <value> ...]"); process.exit(1); }
  const overrides = {};
  for (let i = 0; i < argv.length; i += 2) if (argv[i] !== "--dir") overrides[argv[i]] = argv[i + 1];
  try { console.log(fixtureFlags(dir, overrides).join(" ")); }
  catch (e) { console.error(e.message); process.exit(1); }
}

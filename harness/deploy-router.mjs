// Deploys (and restores) the LIVE custom router file, plan section 6.7 (cr-B1), stage S0b.
//
//   node harness/deploy-router.mjs                                   plan only: paths, the five deploy steps, the restore command
//   node harness/deploy-router.mjs --deploy yes --candidate <file>   run the five steps
//   node harness/deploy-router.mjs --restore yes [--from <backup>]   steps 1, 2, 4 (+ the post-check) on a backup
//
// Why it exists: CCR re-requires `spike/uw-router.cjs` on EVERY request and turns any load-time failure into `undefined`, so a bad
// router file sends all traffic to the anchor with no restart to cause or cure it. Nothing reaches the live file unless it passed
// `node --check`, an exact-bytes require smoke test (in a child process, on a copy laid out as tmp/spike/uw-router.cjs so the
// router's __dirname-derived state is scratch) and a hash check, and it lands by temp file plus atomic rename after a backup.
//
// Paths. With NO path flag the run targets the real repo `spike/uw-router.cjs` (LIVE) and only `--deploy yes` / `--restore yes`
// act on it. `--live <file>` and `--scratch <dir>` redirect the run to a rehearsal tree; they are all-or-nothing (one without the
// other is a usage error). A rehearsal is an ALLOW-LIST: live, scratch, candidate and backup must all resolve (realpath of the deepest
// existing ancestor) to somewhere under the OS temp dir, and any path that starts with two backslashes after resolution (a UNC path
// such as the admin share spelling of the real spike/ folder, in either slash direction, and the \\?\ device form) is refused BEFORE any
// filesystem call, because a UNC spelling of the real spike/ would otherwise slip past a deny-list. The old deny-list stays too: every resolved path is also refused when its realpath lies in the real repo spike/, ~/.claude,
// ~/.llmkeys, state/ or catalog/. Blank and missing flag values are rejected (a blank value must never fall through to the real
// default), the booleans are exactly `yes` or `no`.
//
// THREAT NOTE. The smoke test REQUIRES the candidate, so the candidate runs with the owner's privileges: a hostile candidate is NOT in the
// threat model (the candidate is the owner's own reviewed file, router/uw-router.s0b.cjs or .next.cjs). What the smoke test does defend
// against is an ACCIDENTAL pass: the verdict is read from the child's STDOUT as a marker line that carries a per-run nonce, deleted from the
// child's environment before the candidate is loaded; the whole child script runs inside one function scope, so the nonce and the verdict writer are
// NOT global bindings a candidate can reach by name (a candidate that guesses the nonce, or goes looking for it in the heap, the stack or the stdout
// stream, CAN forge a verdict: that candidate is out of the threat model, and the forged-verdict tests pin only the accidental shapes). The child's
// environment is limited to UW_SMOKE_* plus SystemRoot, PATH and TEMP, and a module that exits at load time (or prints nothing) FAILS.
//
// Fault injection. Every step takes an `fs` seam (default node:fs) plus `rename`, so the tests corrupt a temp file, a backup or the scratch
// copy and land a different file by rename, and each guard (temp hash, backup hash, scratch hash, post-check hash, temp name collision,
// changed-between-read-and-check) must fire.
import nodeFs from "node:fs";
const fs = nodeFs;
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "..");
export const LIVE_ROUTER = path.join(REPO, "spike", "uw-router.cjs");
export const BACKUP_PREFIX = "uw-router.cjs.bak-pre-subpolicy-";
export const RETRY_DELAYS_MS = [10, 30, 90, 270, 810];
const BOOLS = ["deploy", "restore"], PATHS = ["candidate", "from", "live", "scratch"];

export class DeployError extends Error {
  constructor(msg, code = 2) { super(msg); this.code = code; }
}
const usage = (msg) => new DeployError(`E_USAGE: ${msg}`, 1);

/** The folders a rehearsal must never name: real spike/, Claude settings, the vault, UW state and catalog (both the repo copy and ~/.uw). */
export function protectedDirs({ home = os.homedir(), repo = REPO } = {}) {
  const dirs = [path.join(repo, "spike"), path.join(repo, "state"), path.join(repo, "catalog"),
    path.join(home, ".uw", "spike"), path.join(home, ".uw", "state"), path.join(home, ".uw", "catalog"),
    path.join(home, ".claude"), path.join(home, ".llmkeys")];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

const realNative = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
/** realpath of the deepest existing ancestor plus the not-yet-existing tail: a path that does not exist yet (or sits behind a junction) still resolves. */
function realish(p) {
  let head = path.resolve(p), tail = "";
  for (;;) {
    try { return path.join(realNative(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail = path.join(path.basename(head), tail); head = up;
  }
}
const normCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const isUnder = (child, dir) => { const c = normCase(child), d = normCase(dir); return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

export function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw usage(`unexpected argument ${JSON.stringify(a)}`);
    const name = a.slice(2);
    if (!BOOLS.includes(name) && !PATHS.includes(name)) throw usage(`unknown flag ${a}`);
    if (name in flags) throw usage(`flag ${a} given twice`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usage(`flag ${a} needs an explicit value${BOOLS.includes(name) ? " (yes or no)" : ""}; every flag takes one`);
    i += 1;
    if (BOOLS.includes(name)) {
      if (v !== "yes" && v !== "no") throw usage(`flag ${a} takes exactly yes or no, found ${JSON.stringify(v)}`);
      flags[name] = v === "yes";
    } else {
      if (v.trim() === "") throw usage(`flag ${a} needs a file path, found an empty or blank value`);
      flags[name] = v;
    }
  }
  if (flags.deploy && flags.restore) throw usage("--deploy yes and --restore yes are exclusive");
  if (flags.deploy && !flags.candidate) throw usage("--deploy yes needs --candidate <path> (S0b deploys router/uw-router.s0b.cjs)");
  if (flags.restore && flags.candidate) throw usage("--candidate belongs to --deploy; a restore names its file with --from");
  if (flags.deploy && flags.from) throw usage("--from belongs to --restore");
  if (("live" in flags) !== ("scratch" in flags)) {
    throw usage(`incomplete rehearsal flag set: --live and --scratch go together (given: ${["live", "scratch"].filter((k) => k in flags).map((k) => "--" + k).join(" ")}); one alone would mix a rehearsal path with a real default`);
  }
  return flags;
}

/** Resolve every path the run will touch; refuse any that lies in a protected folder when the run is a rehearsal. */
export function resolveRun(flags, { protect = protectedDirs(), tmpRoot = os.tmpdir() } = {}) {
  const rehearsal = "live" in flags;
  const live = rehearsal ? path.resolve(flags.live) : LIVE_ROUTER;
  const scratchRoot = rehearsal ? path.resolve(flags.scratch) : os.tmpdir();
  const r = { rehearsal, live, scratchRoot,
    candidate: flags.candidate ? path.resolve(flags.candidate) : null,
    from: flags.from ? path.resolve(flags.from) : null };
  if (rehearsal) {
    // ALLOW-LIST. UNC and device paths first, on the raw spelling, before anything touches the filesystem (a realpath of a UNC admin share would
    // itself reach the real file).
    for (const [k, p] of [["live", live], ["scratch", scratchRoot], ["candidate", r.candidate], ["from", r.from]]) {
      if (p && p.startsWith("\\\\")) throw usage(`refusing --${k} ${JSON.stringify(p)}: a UNC or device path can name the real file under another spelling; a rehearsal names a plain local path under the temp dir`);
    }
    const tmpReal = realish(tmpRoot);
    for (const [k, p] of [["live", live], ["scratch", scratchRoot], ["candidate", r.candidate], ["from", r.from]]) {
      if (p && !isUnder(realish(p), tmpReal)) throw usage(`refusing --${k} ${JSON.stringify(p)}: a rehearsal must resolve under the OS temp dir ${tmpReal} (allow-list); it resolves to ${realish(p)}`);
    }
  }
  const real = protect.flatMap((d) => [path.resolve(d), realish(d)]);
  // The scratch root and the candidate are checked in BOTH modes (a smoke tree or a candidate inside the live folders is never right);
  // live and the backups are checked in a rehearsal only, because in live mode they are the real spike/ by design.
  const checks = [["scratch", scratchRoot], ["candidate", r.candidate]];
  if (rehearsal) checks.push(["live", live], ["from", r.from]);
  for (const [k, p] of checks) {
    if (!p) continue;
    const mine = [p, realish(p)];
    const hit = real.find((d) => mine.some((m) => isUnder(m, d)));
    if (hit) throw usage(`refusing --${k} ${JSON.stringify(p)}: it lies under ${hit}, a real spike, Claude, vault, state or catalog folder; a rehearsal names its own temp tree`);
  }
  if (r.from) {
    const same = normCase(path.dirname(realish(r.from))) === normCase(path.dirname(realish(live)));
    if (!same || !path.basename(r.from).startsWith(BACKUP_PREFIX)) {
      throw usage(`--from ${JSON.stringify(r.from)} must be a ${BACKUP_PREFIX}* file next to ${JSON.stringify(live)}`);
    }
  }
  return r;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The command that undoes THIS run. `from` names the backup explicitly (a restore without --from is refused once more than one backup exists). */
export function restoreCommand(r, from) {
  return `node harness/deploy-router.mjs --restore yes${r.rehearsal ? ` --live ${r.live} --scratch ${r.scratchRoot}` : ""}${from ? ` --from ${from}` : ""}`;
}

export function planText(r) {
  return [
    `deploy-router PLAN: nothing executed (add --deploy yes --candidate <file>, or --restore yes, to act)`,
    `mode: ${r.rehearsal ? "REHEARSAL on a scratch tree" : "LIVE (default paths)"}`,
    `live router file: ${r.live}`, `smoke scratch root: ${r.scratchRoot}`, `candidate: ${r.candidate ?? "(none given)"}`,
    `backups: ${r.live}.bak-pre-subpolicy-<yyyymmdd-hhmm> (never overwritten; the OLDEST is the original, pre-first-deploy file)`,
    `deploy steps (refused up front when the live file already equals the candidate):`,
    `  1. node --check <candidate>`,
    `  2. require smoke test on the exact candidate bytes in <scratch>/spike/uw-router.cjs (awaited calls, verdict read from the child's stdout) and sha256 equality`,
    `  3. backup of the live file, copy hash verified`,
    `  4. temp file next to the live file, hash verified, atomic rename (retry ${RETRY_DELAYS_MS.join(", ")} ms on EPERM)`,
    `  5. post-check: re-hash the live file and node --check it`,
    `with more than one backup, --restore yes needs --from <backup> (it is refused otherwise); a deploy prints the ORIGINAL backup and its own restore command`,
    `restore: ${restoreCommand(r)}`,
  ].join("\n");
}

// ---------------------------------------------------------------- the steps
// Every step takes an `fs` seam (default node:fs) so a fault-injection test can corrupt what a write lands.

/**
 * Step 1: `node --check` on the exact file; the bytes must still be the ones that were read. A file whose extension is not .cjs
 * (a backup is named uw-router.cjs.bak-pre-subpolicy-<stamp>, which node refuses as an unknown extension) is checked as a .cjs
 * copy of the same bytes in a fresh scratch folder, because that is how CCR loads it once it is renamed over the live file.
 */
export function stepCheck(file, expectSha, scratchRoot = os.tmpdir(), { fs: f = nodeFs } = {}) {
  let target = file, tmp = null;
  try {
    if (path.extname(file) !== ".cjs") {
      f.mkdirSync(scratchRoot, { recursive: true });
      tmp = f.mkdtempSync(path.join(scratchRoot, "uw-router-check-"));
      target = path.join(tmp, "uw-router.cjs");
      f.copyFileSync(file, target);
    }
    try { execFileSync(process.execPath, ["--check", target], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 }); }
    catch (e) { throw new DeployError(`node --check refused ${file}: ${String(e.stderr || e.message).trim().split("\n").slice(0, 4).join(" | ")}`); }
  } finally { if (tmp) f.rmSync(tmp, { recursive: true, force: true }); }
  if (expectSha && sha256(f.readFileSync(file)) !== expectSha) throw new DeployError(`${file} changed between reading and checking`);
}

// Runs in a CHILD process (a candidate that calls process.exit, hangs or throws at module scope must not take the script down).
// Every route() call is AWAITED: the export is async, and comparing an un-awaited Promise would prove nothing (M-f).
// The verdict is ONE stdout line `UW_SMOKE_VERDICT <nonce> <json>`; the nonce comes in by env and is deleted before the candidate is loaded.
export const SMOKE_MARK = "UW_SMOKE_VERDICT";
const SMOKE = `
(function () {
const { createRequire } = require("node:module");
const file = process.env.UW_SMOKE_FILE, nonce = process.env.UW_SMOKE_NONCE;
delete process.env.UW_SMOKE_NONCE;
const done = (r) => { process.stdout.write(["", "${SMOKE_MARK} " + nonce + " " + JSON.stringify(r), ""].join(String.fromCharCode(10)), () => process.exit(r.ok ? 0 : 1)); };
const within = (p, what) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(what + " did not settle in 5 s")), 5000))]);
(async () => {
  try {
    const route = createRequire(file)(file);
    if (typeof route !== "function") throw new Error("module.exports is " + typeof route + ", not a function");
    const MODEL = "anthropic/claude-sonnet-5";
    const got = await within(route({ body: { model: MODEL }, headers: {} }, { Providers: [] }, {}), "the sonnet call");
    if (typeof got !== "string") throw new Error("the awaited sonnet call returned " + typeof got + ", not a string");
    if (got !== MODEL) throw new Error("the awaited sonnet call returned " + JSON.stringify(got) + ", not " + JSON.stringify(MODEL));
    const empty = await within(route({ body: { model: "" }, headers: {} }, { Providers: [] }, {}), "the empty-model call");
    if (empty !== undefined) throw new Error("an empty model returned " + JSON.stringify(empty) + ", not undefined");
    const hostile = [undefined, null, { body: null }, { body: { model: MODEL, tools: "not-an-array" }, headers: null }, { body: { model: { toString() { throw new Error("hostile"); } } } }];
    for (const [i, h] of hostile.entries()) {
      const v = await within(route(h, { Providers: [] }, {}), "hostile call " + i);
      if (v !== undefined && typeof v !== "string") throw new Error("hostile call " + i + " returned " + typeof v);
    }
    done({ ok: true });
  } catch (e) { done({ ok: false, error: String(e && e.message || e) }); }
})();
})();
`;

/** Step 2: require smoke on the EXACT BYTES, laid out as <tmp>/spike/uw-router.cjs so __dirname-derived state is scratch. */
export function stepSmoke(buf, scratchRoot, { fs: f = nodeFs } = {}) {
  f.mkdirSync(scratchRoot, { recursive: true });
  const tmp = f.mkdtempSync(path.join(scratchRoot, "uw-router-smoke-"));
  try {
    const dir = path.join(tmp, "spike"), file = path.join(dir, "uw-router.cjs");
    f.mkdirSync(dir);
    f.writeFileSync(file, buf);
    const want = sha256(buf);
    if (sha256(f.readFileSync(file)) !== want) throw new DeployError("scratch copy hash differs from the candidate right after writing");
    const nonce = crypto.randomBytes(16).toString("hex");
    // The child sees UW_SMOKE_* plus SystemRoot, PATH and TEMP and nothing else of the parent's environment (no proxy, key, ANTHROPIC_*, CCR_*).
    const env = { UW_SMOKE_FILE: file, UW_SMOKE_NONCE: nonce };
    for (const k of ["SystemRoot", "PATH", "TEMP"]) if (process.env[k] !== undefined) env[k] = process.env[k];
    let exit = 0, stdout = "", stderr = "";
    try {
      stdout = String(execFileSync(process.execPath, ["-e", SMOKE], { cwd: tmp, timeout: 30000, stdio: ["ignore", "pipe", "pipe"], env, maxBuffer: 1 << 20 }));
    } catch (e) { exit = e.status ?? 1; stdout = String(e.stdout ?? ""); stderr = String(e.stderr || e.message).trim().split("\n").slice(0, 3).join(" | "); }
    const verdicts = stdout.split(/\r?\n/).filter((l) => l.startsWith(`${SMOKE_MARK} ${nonce} `));
    let r = null;
    if (verdicts.length === 1) { try { r = JSON.parse(verdicts[0].slice(`${SMOKE_MARK} ${nonce} `.length)); } catch { r = null; } }
    if (!r) throw new DeployError(`smoke test produced no verdict (exit ${exit}${stderr ? `: ${stderr}` : ""}); the module ended the process, hung or never reached the checks`);
    if (!r.ok || exit !== 0) throw new DeployError(`smoke test failed: ${r.error ?? `exit ${exit}`}`);
    if (sha256(f.readFileSync(file)) !== want) throw new DeployError("the smoke test modified the scratch copy (sha256 differs from the candidate)");
    return want;
  } finally { f.rmSync(tmp, { recursive: true, force: true }); }
}

const stampOf = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

/** Step 3: copy the live file to a NEVER-overwritten backup name (a second deploy in the same minute adds -2, -3, ...) and verify the copy. */
export function stepBackup(live, { now = () => new Date(), fs: f = nodeFs } = {}) {
  let bytes;
  try { bytes = f.readFileSync(live); } catch (e) { throw new DeployError(`cannot read the live router file ${live}: ${e.code ?? e.message}`); }
  const base = `${live}.bak-pre-subpolicy-${stampOf(now())}`;
  for (let n = 1; n < 1000; n++) {
    const target = n === 1 ? base : `${base}-${n}`;
    try { f.writeFileSync(target, bytes, { flag: "wx" }); } catch (e) { if (e.code === "EEXIST") continue; throw new DeployError(`cannot write the backup ${target}: ${e.code ?? e.message}`); }
    if (sha256(f.readFileSync(target)) !== sha256(bytes)) { f.rmSync(target, { force: true }); throw new DeployError(`backup ${target} failed its hash check`); }
    return { backup: target, sha: sha256(bytes) };
  }
  throw new DeployError("no free backup name in this minute (999 taken)");
}

/**
 * Step 4: temp file in the SAME directory, hash-verified, atomic rename with Windows EPERM backoff; the temp is removed on failure and the live file
 * is never written in place. The temp name is created with the exclusive `wx` flag: a name that already exists (an earlier crashed run with the same
 * pid, a planted file) is NOT ours to delete or reuse, so the next suffix is tried and only a temp THIS call created is ever removed.
 */
export function stepSwap(live, buf, { fs: f = nodeFs, rename = (a, b) => f.renameSync(a, b), sleep = sleepSync, delays = RETRY_DELAYS_MS, tag = String(process.pid) } = {}) {
  const want = sha256(buf);
  let tmp = null;
  try {
    for (let n = 1; n <= 50 && tmp === null; n++) {
      const cand = `${live}.tmp-${tag}${n === 1 ? "" : `-${n}`}`;
      try { f.writeFileSync(cand, buf, { flag: "wx" }); tmp = cand; }
      catch (e) {
        if (e.code === "EEXIST") continue;
        f.rmSync(cand, { force: true });
        throw new DeployError(`cannot write the temp file ${cand}: ${e.code ?? e.message}; live file untouched`);
      }
    }
    if (tmp === null) throw new DeployError(`no free temp file name next to ${live} (${live}.tmp-${tag}, -2 ... -50 all exist): remove the stale .tmp-* files by hand; live file untouched`);
    if (sha256(f.readFileSync(tmp)) !== want) throw new DeployError(`temp file ${tmp} failed its hash check; live file untouched`);
    for (let i = 0; ; i++) {
      try { rename(tmp, live); return; }
      catch (e) {
        if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || i >= delays.length) throw new DeployError(`atomic rename onto ${live} failed after ${i} retries (${e.code ?? e.message}); live file untouched`);
        sleep(delays[i]);
      }
    }
  } catch (e) { if (tmp) f.rmSync(tmp, { force: true }); throw e; }
}

/** Step 5: re-hash and `node --check` the live path; it is NOT executed (its state directory is __dirname-derived and would be the real one). */
export function stepPost(live, wantSha, { fs: f = nodeFs } = {}) {
  if (sha256(f.readFileSync(live)) !== wantSha) throw new DeployError(`live file hash is not the deployed hash`);
  stepCheck(live, undefined, undefined, { fs: f });
}

/** Every `uw-router.cjs.bak-pre-subpolicy-*` next to the live file, OLDEST first (stamp, then suffix number; other names are ignored). Throws when there is none. */
export function listBackups(live, { fs: f = nodeFs } = {}) {
  const dir = path.dirname(live), re = new RegExp(`^${path.basename(live).replace(/\./g, "\\.")}\\.bak-pre-subpolicy-(\\d{8}-\\d{4})(?:-(\\d+))?$`);
  const found = f.readdirSync(dir).map((n) => { const m = re.exec(n); return m ? { n, stamp: m[1], seq: Number(m[2] ?? 1) } : null; }).filter(Boolean);
  if (!found.length) throw new DeployError(`no ${BACKUP_PREFIX}* backup next to ${live}`);
  found.sort((a, b) => (a.stamp === b.stamp ? a.seq - b.seq : a.stamp < b.stamp ? -1 : 1));
  return found.map((x) => path.join(dir, x.n));
}
/** The newest backup (kept for callers that want it; a restore never picks it by itself once there is more than one). */
export function newestBackup(live) { return listBackups(live).at(-1); }

// ---------------------------------------------------------------- the two actions

const run = (out, label, fn) => {
  try { const v = fn(); out(`${label} OK`); return v; }
  catch (e) { out(`${label} FAILED`); throw e; }
};

export function deploy(r, { out = console.log, ...seams } = {}) {
  const f = seams.fs ?? nodeFs;
  out(`deploy-router: DEPLOY ${r.rehearsal ? "(REHEARSAL tree)" : "(LIVE)"} ${r.live}`);
  let buf;
  try { buf = f.readFileSync(r.candidate); } catch (e) { throw new DeployError(`cannot read the candidate ${r.candidate}: ${e.code ?? e.message}`); }
  const want = sha256(buf);
  out(`candidate ${r.candidate} sha256 ${want}`);
  let liveSha = null;
  try { liveSha = sha256(f.readFileSync(r.live)); } catch { /* an unreadable live file fails at step 3 with its own message */ }
  if (liveSha === want) throw new DeployError(`E_NOOP: the live file already holds the candidate bytes (sha256 ${want}); nothing to deploy and NO backup is made (a backup of the same bytes would become the newest one and hide the original)`, 1);
  run(out, "step 1/5 node --check candidate .......", () => stepCheck(r.candidate, want, r.scratchRoot, seams));
  run(out, "step 2/5 require smoke on exact bytes ..", () => stepSmoke(buf, r.scratchRoot, seams));
  const { backup } = run(out, "step 3/5 backup of the live file ......", () => stepBackup(r.live, seams));
  out(`  backup: ${backup}`);
  run(out, "step 4/5 temp file + atomic rename ....", () => stepSwap(r.live, buf, seams));
  try { run(out, "step 5/5 post-check (hash, node --check)", () => stepPost(r.live, want, seams)); }
  catch (e) { out(`THE LIVE FILE WAS REPLACED BUT FAILED ITS POST-CHECK: restore now with: ${restoreCommand(r, backup)}`); throw e; }
  const original = listBackups(r.live, seams)[0];
  out(`ORIGINAL BACKUP (the live file as it was before the FIRST deploy; keep it, the restore of last resort): ${original}`);
  out(`live sha256 ${want}`);
  out(`restore: ${restoreCommand(r, backup)}`);
}

export function restore(r, { out = console.log, ...seams } = {}) {
  let from = r.from;
  if (!from) {
    const all = listBackups(r.live, seams);
    if (all.length > 1) {
      throw new DeployError(`E_AMBIGUOUS: --restore yes without --from is refused: ${all.length} backups exist next to ${r.live} and the newest is rarely the one wanted after two deploys. Name one with --from <path>:\n${all.map((b, i) => `  ${i + 1}. ${b}${i === 0 ? "  (the ORIGINAL: the live file before the first deploy)" : ""}`).join("\n")}`, 1);
    }
    from = all[0];
  }
  out(`deploy-router: RESTORE ${r.rehearsal ? "(REHEARSAL tree)" : "(LIVE)"} ${r.live} from ${from}`);
  let buf;
  try { buf = (seams.fs ?? nodeFs).readFileSync(from); } catch (e) { throw new DeployError(`cannot read the backup ${from}: ${e.code ?? e.message}`); }
  const want = sha256(buf);
  out(`backup sha256 ${want}`);
  run(out, "restore 1/3 node --check backup ......", () => stepCheck(from, want, r.scratchRoot, seams));
  run(out, "restore 2/3 require smoke (exact bytes)", () => stepSmoke(buf, r.scratchRoot, seams));
  run(out, "restore 3/3 temp file + atomic rename ", () => stepSwap(r.live, buf, seams));
  run(out, "restore post-check (hash, node --check)", () => stepPost(r.live, want, seams));
  out(`live sha256 ${want}`);
}

/** Returns the process exit code: 0 ok, 1 usage or refusal (nothing touched), 2 a step failed. */
export function main(argv, { out = console.log, err = console.error, protect, ...seams } = {}) {
  try {
    const flags = parseArgs(argv);
    const r = resolveRun(flags, protect ? { protect } : undefined);
    if (flags.deploy) deploy(r, { out, ...seams });
    else if (flags.restore) restore(r, { out, ...seams });
    else out(planText(r));
    return 0;
  } catch (e) {
    if (!(e instanceof DeployError)) throw e;
    err(e.message);
    return e.code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));

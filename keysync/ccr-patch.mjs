// One command for the five local patches to the installed router (closes #98).
//
//   node keysync/ccr-patch.mjs [--check | --apply | --revert | --seed-store]
//                              [--only A,C,...] [--force-version]
//
// Default is --check: read-only, reports each of A-E as applied / NOT APPLIED /
// UNEXPECTED. The recipes (what A-E are, why, and their markers) live in
// menu/ccr-patches.mjs; this file is only the mechanism.
//
// EXIT CODES  0 as asked (check: all applied; apply/revert: done or nothing to do)
//             1 refusal (unexpected counts, syntax gate, version guard, bad args)
//             2 a target file is missing or unreadable
//             3 --check found patches not applied (a state, not an error)
//
// WHAT IT NEVER DOES: write outside the install tree and ~/.uw/ccr-pristine,
// touch service.json or any settings, contact or restart the gateway, print file
// contents, or run npm. Applying changes FILES; the running gateway keeps the
// old code until it is restarted by a human.
//
// HOW A WRITE HAPPENS (every file is planned before any is written)
//   1. read bytes, decode as latin1: a lossless byte<->char map, so CRLF, LF,
//      mixed endings and non-ASCII bytes come back exactly. Never normalised.
//   2. classify each recipe strictly (applied / stock / unexpected). Anything
//      unexpected refuses the whole run, no writes.
//   3. build the candidate, assert the byte delta, write it beside the target
//      (same directory, same extension), and `node --check` it. The unmodified
//      file is checked the same way first, so a broken gate cannot pass silently.
//   4. capture the pristine original into ~/.uw/ccr-pristine/<version>/ (only
//      when the file is fully stock), then rename the checked candidate over the
//      target. Second-file failure restores the first from memory.
//   5. re-read from disk, re-classify, print pre -> post sha.
//
// MISSING TARGETS. A target that cannot be read makes only ITS patches "target
// missing" (E for the library, A-D for cli.js); the rest are still classified.
//   --check   prints every status, missing ones as "target missing", exits 2.
//   --apply / --revert with any WANTED patch's target missing refuse with exit 2
//             naming those patches. Nothing is half-applied silently: to work on
//             the reachable file only, say so with --only (e.g. --only A,B,C,D).
//
// REVERT GATE. `node --check` runs on the candidate only. For a revert the
// unmodified bytes are the PATCHED file, so gating on them would refuse exactly
// when the patched bundle is broken, which is when a revert is most wanted. The
// baseline gate (unmodified file must itself pass) stays for apply.
//
// KNOWN AND DEFERRED (announced, not fixed in this round)
//   L2  corrupt-.orig message wording in storePristine
//   L3  manifest `patchIds` can go stale after a partial apply then a full apply;
//       `uw doctor` must NOT trust patchIds, only the recorded shas
//   L4  no try-wrap around applyPatch/revertPatch in run() (they throw on
//       unexpected input; classify has already ruled that out on every path here)
//   L7  exit code 1 covers both refusals and unexpected exceptions
//   L9  the syntax gate runs process.execPath --check with no timeout
//   L10 count() with an empty needle (recipe validation already rejects empty finds)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CONTRACT, ccrVersion, gatewayLibVersion } from "../menu/ccr-client.mjs";
import { PATCHES, count, classify, describe, applyPatch, revertPatch } from "../menu/ccr-patches.mjs";
import { writeAtomic } from "../menu/atomic.mjs";

const FILE_ORDER = ["gatewayLib", "cli"];       // write order: the library first, then the bundle
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const s16 = (h) => h.slice(0, 16);
const text = (buf) => buf.toString("latin1");
const bytes = (t) => Buffer.from(t, "latin1");

function realNodeCheck(file) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    // node prints the offending source line, which in a minified bundle is one
    // enormous line; keep the message short.
    return { ok: false, message: String(e.stderr || e.message).slice(0, 600) };
  }
}

export function realDeps() {
  return {
    targets: { cli: CONTRACT.gatewayBundle, gatewayLib: CONTRACT.gatewayLibBundle },
    installDir: CONTRACT.installDir,
    storeDir: path.join(os.homedir(), ".uw", "ccr-pristine"),
    version: ccrVersion(),
    libVersion: gatewayLibVersion(),
    verifiedVersion: CONTRACT.verifiedVersion,
    patches: PATCHES,
    nodeCheck: realNodeCheck,
    now: () => new Date().toISOString(),
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    rename: fs.renameSync,
    fsync: fs.fsyncSync,
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  };
}

function parseArgs(argv) {
  const o = { mode: null, only: null, force: false };
  const setMode = (m) => { if (o.mode && o.mode !== m) throw new Error(`--${o.mode} and --${m} are mutually exclusive`); o.mode = m; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check" || a === "--apply" || a === "--revert" || a === "--seed-store") setMode(a.slice(2));
    else if (a === "--force-version") o.force = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v) throw new Error("--only needs ids, e.g. --only A,C");
      o.only = v.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
    } else throw new Error(`unknown argument ${a}`);
  }
  o.mode ??= "check";
  return o;
}

// ---- pristine store --------------------------------------------------------

const versionDir = (deps) => path.join(deps.storeDir, String(deps.version ?? "unknown").replace(/[^\w.-]/g, "_"));
const readManifest = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")); } catch { return null; }
};

/** Store `pristine` bytes for `key`, keyed by version + sha256. Verifies rather than overwrites a file already there. */
export function storePristine(deps, key, { relPath, pristine, patched, provenance, patchIds }) {
  const dir = versionDir(deps);
  fs.mkdirSync(dir, { recursive: true });
  const ps = sha(pristine);
  const orig = path.join(dir, `${key}.${s16(ps)}.orig`);
  if (fs.existsSync(orig)) {
    if (sha(fs.readFileSync(orig)) !== ps) throw new Error(`pristine store file ${orig} does not match its own name; refusing to overwrite it`);
  } else writeAtomic(orig, pristine);
  const manifest = readManifest(dir) ?? { ccrVersion: deps.version ?? null, files: {} };
  const prev = manifest.files?.[key];
  manifest.files ??= {};
  manifest.files[key] = {
    relPath, pristineSha256: ps, pristineBytes: pristine.length,
    patchedSha256: patched ? sha(patched) : null,
    provenance: prev?.pristineSha256 === ps && prev.provenance === "captured" ? "captured" : provenance,
    at: deps.now(), patchIds,     // informational only: stale after a partial then full apply (L3); trust the shas
  };
  writeAtomic(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { file: orig, sha: ps };
}

/** The verified pristine bytes for `key` in this version's store, or null. */
function storeLookup(deps, key) {
  const dir = versionDir(deps);
  const e = readManifest(dir)?.files?.[key];
  if (!e?.pristineSha256) return null;
  try {
    const buf = fs.readFileSync(path.join(dir, `${key}.${s16(e.pristineSha256)}.orig`));
    return sha(buf) === e.pristineSha256 ? { entry: e, buf } : null;
  } catch { return null; }
}

// ---- reporting -------------------------------------------------------------

function lineEndings(t) {
  const crlf = count(t, "\r\n"), lf = count(t, "\n") - crlf;
  return crlf && lf ? `mixed (${crlf} CRLF, ${lf} LF)` : crlf ? "CRLF" : "LF";
}

function report(deps, files, states) {
  const { out } = deps;
  out(`CCR ${deps.version ?? "?"} (recipes verified for ${deps.verifiedVersion}), ai-gateway ${deps.libVersion ?? "?"}`);
  for (const key of FILE_ORDER) {
    const f = files[key];
    if (f) out(`  ${path.basename(f.target)}  sha256 ${s16(f.sha)}  ${f.pre.length} bytes  ${lineEndings(f.text)}`);
  }
  for (const { patch, c } of states) {
    const label = { applied: "applied", stock: "NOT APPLIED", missing: "target missing" }[c.state] ?? "UNEXPECTED";
    let extra = "";
    if (c.state === "applied") {
      const d = patch.detect?.(files[patch.file].text);
      extra = d?.value != null ? `  [${d.value} ms]` : patch.markers.length ? `  [${patch.markers.join(", ")}]` : "";
    }
    out(`  ${patch.id}  ${label.padEnd(14)}  ${patch.title}${extra}`);
    if (c.state === "unexpected") out(`       ${describe(c)}`);
  }
}

const RESTART_NOTICE =
  "Restart required: the running gateway still holds the previous code. ccr stop && ccr start --no-open " +
  "(this script never restarts it). Until then `uw doctor` reads the FILE, not the process: green with a stale process is possible.";

// ---- writing ---------------------------------------------------------------

const tmpPath = (target, tag) => {
  const ext = path.extname(target);
  return path.join(path.dirname(target), `${path.basename(target, ext)}.uwpatch-${process.pid}${tag}${ext}`);
};

/** open + write + fsync + close (as menu/atomic.mjs writeAtomic does), so a rename never publishes bytes still only in the page cache. */
function writeSynced(deps, file, buf) {
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, buf);
    (deps.fsync ?? fs.fsyncSync)(fd);
  } finally { fs.closeSync(fd); }
}

function renameRetry(deps, from, to) {
  for (let i = 0; ; i++) {
    try { deps.rename(from, to); return; }
    catch (e) {
      if (!["EPERM", "EBUSY"].includes(e.code) || i >= 3) throw e;
      deps.sleep(50 * 4 ** i);
    }
  }
}

/**
 * Gate, store and write a set of planned files. A plan is
 * `{ key, target, pre, next, gate, baseline, verify(diskBuf) -> string|null, beforeWrite() }`.
 * `gate` syntax-checks the candidate; `baseline` also requires the unmodified
 * file to pass first (apply only, see REVERT GATE at the top).
 * Returns an exit code. Nothing is renamed until every candidate has passed.
 */
function commit(deps, plans, verb) {
  const { out, err } = deps;
  const temps = [];
  const cleanup = () => { for (const t of temps) fs.rmSync(t, { force: true }); };
  try {
    for (const p of plans) {
      p.tmp = tmpPath(p.target, "");
      temps.push(p.tmp);
      if (p.gate && p.baseline) {
        const base = tmpPath(p.target, "-base");
        temps.push(base);
        fs.writeFileSync(base, p.pre);
        const b = deps.nodeCheck(base);
        fs.rmSync(base, { force: true });
        if (!b.ok) { err(`refusing: the UNMODIFIED ${path.basename(p.target)} fails node --check, so the syntax gate cannot vouch for a change. ${b.message ?? ""}`); return 1; }
      }
      writeSynced(deps, p.tmp, p.next);
      if (p.gate) {
        const g = deps.nodeCheck(p.tmp);
        if (!g.ok) { err(`refusing: the ${verb === "apply" ? "patched" : "reverted"} ${path.basename(p.target)} fails node --check; nothing was written. ${g.message ?? ""}`); return 1; }
      }
    }
    for (const p of plans) p.beforeWrite?.();
    const done = [];
    try {
      for (const p of plans) {
        // Re-read immediately before the swap: anything that wrote the target since
        // it was read (an npm install, a hand edit) would be silently overwritten.
        let cur = null;
        try { cur = fs.readFileSync(p.target); } catch { /* unreadable counts as changed */ }
        if (!cur || sha(cur) !== sha(p.pre)) throw Object.assign(new Error(`${path.basename(p.target)} changed on disk after it was read; aborting`), { uwChanged: true });
        renameRetry(deps, p.tmp, p.target);
        done.push(p);
      }
    } catch (e) {
      err(e.uwChanged ? e.message : `write failed on ${path.basename(plans[done.length].target)}: ${e.message}`);
      for (const p of done.reverse()) {
        try {
          const rb = tmpPath(p.target, "-rb");
          temps.push(rb);
          writeSynced(deps, rb, p.pre);
          renameRetry(deps, rb, p.target);
          err(`restored ${path.basename(p.target)} to its previous bytes`);
        } catch (e2) { err(`COULD NOT restore ${path.basename(p.target)}: ${e2.message}`); }
      }
      return 1;
    }
  } finally { cleanup(); }
  let bad = 0;
  for (const p of plans) {
    const after = fs.readFileSync(p.target);
    const problem = p.verify(after);
    out(`  ${path.basename(p.target)}: ${s16(sha(p.pre))} -> ${s16(sha(after))}${problem ? `   PROBLEM: ${problem}` : ""}`);
    if (problem) bad++;
  }
  if (bad) { err(`${verb} wrote the files but the post-write check failed`); return 1; }
  out(RESTART_NOTICE);
  out("RED = A or C missing on the verified version; AMBER = B, D, E missing, or any state on an unverified version.");
  return 0;
}

const delta = (patch, from, to) => patch.steps.reduce((n, s) => n + (s[to].length - s[from].length) * s.count, 0);

// ---- modes -----------------------------------------------------------------

function seedStore(deps, files, patches) {
  const { out, err } = deps;
  const ready = [];                  // reconstruct and prove every file before storing any
  for (const key of FILE_ORDER) {
    const f = files[key];
    const mine = patches.filter((p) => p.file === key);
    if (!f || !mine.length) continue;
    const bad = mine.map((p) => classify(f.text, p)).filter((c) => c.state !== "applied");
    if (bad.length) { err(`cannot seed ${key}: not fully patched (${bad.map(describe).join(" | ")}). Use --apply on a stock file instead; it captures the pristine bytes itself.`); return 1; }
    let orig = f.text;
    for (const p of mine) orig = revertPatch(orig, p);
    let again = orig;
    for (const p of mine) again = applyPatch(again, p);
    if (again !== f.text) { err(`cannot seed ${key}: re-applying the recipes to the reconstruction does not reproduce the installed bytes`); return 1; }
    ready.push({ key, f, orig, mine });
  }
  for (const { key, f, orig, mine } of ready) {
    const r = storePristine(deps, key, {
      relPath: path.relative(deps.installDir, f.target).split(path.sep).join("/"),
      pristine: bytes(orig), patched: f.pre, provenance: "reconstructed", patchIds: mine.map((p) => p.id),
    });
    out(`  ${key}: pristine ${s16(r.sha)} (${orig.length} bytes, ${lineEndings(orig)}) stored as reconstructed; re-apply reproduces ${s16(f.sha)}`);
  }
  return 0;
}

export function run(argv, deps = realDeps()) {
  const { out, err } = deps;
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(e.message); return 1; }
  const all = deps.patches ?? PATCHES;
  if (opts.mode === "seed-store" && opts.only) { err("--seed-store takes no --only"); return 1; }
  const unknown = (opts.only ?? []).filter((id) => !all.some((p) => p.id === id));
  if (unknown.length) { err(`unknown patch id ${unknown.join(",")}`); return 1; }
  const wanted = opts.only ? all.filter((p) => opts.only.includes(p.id)) : all;

  const files = {}, missing = {};
  for (const key of FILE_ORDER) {
    if (!wanted.some((p) => p.file === key)) continue;
    const target = deps.targets[key];
    let pre;
    try { pre = fs.readFileSync(target); } catch { err(`target not readable: ${target}`); missing[key] = target; continue; }
    files[key] = { key, target, pre, text: text(pre), sha: sha(pre) };
  }

  if (opts.mode === "seed-store") return Object.keys(missing).length ? 2 : seedStore(deps, files, all);

  const states = wanted.map((patch) => ({ patch, c: missing[patch.file] ? { id: patch.id, state: "missing", steps: [], guards: [] } : classify(files[patch.file].text, patch) }));
  report(deps, files, states);

  if (opts.mode === "check") return states.some((s) => s.c.state === "missing") ? 2 : states.every((s) => s.c.state === "applied") ? 0 : 3;
  const gone = states.filter((s) => s.c.state === "missing").map((s) => s.patch.id);
  if (gone.length) { err(`refusing: ${gone.join(",")} cannot be reached (target file missing); nothing was written. Name the reachable patches with --only to work on them alone.`); return 2; }

  const unexpected = states.filter((s) => s.c.state === "unexpected");
  if (opts.mode === "apply") {
    if (unexpected.length) { err(`refusing: ${unexpected.map((s) => s.patch.id).join(",")} in an unexpected state; nothing was written (counts above)`); return 1; }
    const todo = states.filter((s) => s.c.state === "stock");
    if (!todo.length) { out("already applied -- nothing to do"); return 0; }
    if (!opts.force) {
      for (const { patch } of todo) {
        const [have, want, what] = patch.file === "cli"
          ? [deps.version, deps.verifiedVersion, "CCR"]
          : [deps.libVersion, patch.verifiedFor?.gatewayLib, "ai-gateway"];
        if (!want) { err(`refusing: patch ${patch.id} records no verified ${what} version, so the version guard cannot vouch for this install. --force-version overrides this guard only; the exact-count checks still apply.`); return 1; }
        if (have !== want) { err(`refusing: patch ${patch.id} is verified for ${what} ${want}, installed is ${have ?? "unknown"}. --force-version overrides this guard only; the exact-count checks still apply.`); return 1; }
      }
    }
    const plans = [];
    for (const key of FILE_ORDER) {
      const f = files[key];
      const mine = todo.filter((s) => s.patch.file === key).map((s) => s.patch);
      if (!f || !mine.length) continue;
      let next = f.text;
      for (const p of mine) next = applyPatch(next, p);
      const want = mine.reduce((n, p) => n + delta(p, "find", "replace"), 0);
      if (next.length - f.text.length !== want) { err(`refusing: byte delta ${next.length - f.text.length} for ${key}, recipes say ${want}`); return 1; }
      for (const p of mine) if (classify(next, p).state !== "applied") { err(`refusing: ${p.id} does not classify as applied after the edit`); return 1; }
      const fullyStock = all.filter((p) => p.file === key).every((p) => classify(f.text, p).state === "stock");
      const nextBuf = bytes(next);
      plans.push({
        key, target: f.target, pre: f.pre, next: nextBuf, gate: true, baseline: true,
        beforeWrite: () => {
          if (!fullyStock) { out(`  ${key}: pristine not captured (file already partly patched; --seed-store can reconstruct it)`); return; }
          const r = storePristine(deps, key, {
            relPath: path.relative(deps.installDir, f.target).split(path.sep).join("/"),
            pristine: f.pre, patched: nextBuf, provenance: "captured", patchIds: mine.map((p) => p.id),
          });
          out(`  ${key}: pristine ${s16(r.sha)} stored (${path.basename(r.file)})`);
        },
        verify: (buf) => {
          const t = text(buf);
          const bad = all.filter((p) => p.file === key && (mine.includes(p) || classify(f.text, p).state === "applied"))
            .filter((p) => classify(t, p).state !== "applied");
          return bad.length ? `${bad.map((p) => p.id).join(",")} not applied on disk` : null;
        },
      });
    }
    try { return commit(deps, plans, "apply"); }
    catch (e) { err(`refusing: ${e.message}`); return 1; }
  }

  // revert
  const plans = [];
  for (const key of FILE_ORDER) {
    const f = files[key];
    const mine = states.filter((s) => s.patch.file === key);
    if (!f || !mine.length) continue;
    let store = null;
    if (!opts.only) {
      const hit = storeLookup(deps, key);
      if (hit && hit.entry.patchedSha256 === f.sha) store = hit;
    }
    if (store) {
      plans.push({
        key, target: f.target, pre: f.pre, next: store.buf, gate: false,   // the original bytes, byte for byte
        verify: (buf) => (sha(buf) === store.entry.pristineSha256 ? null : "restored file does not match the stored original"),
      });
      out(`  ${key}: restoring the stored original ${s16(store.entry.pristineSha256)}`);
      continue;
    }
    const bad = mine.filter((s) => s.c.state === "unexpected");
    if (bad.length) { err(`refusing: ${bad.map((s) => s.patch.id).join(",")} in an unexpected state and no stored original matches this file; nothing was written`); return 1; }
    const todo = mine.filter((s) => s.c.state === "applied").map((s) => s.patch);
    if (!todo.length) continue;
    let next = f.text;
    for (const p of todo) next = revertPatch(next, p);
    const want = todo.reduce((n, p) => n + delta(p, "replace", "find"), 0);
    if (next.length - f.text.length !== want) { err(`refusing: byte delta ${next.length - f.text.length} for ${key}, recipes say ${want}`); return 1; }
    plans.push({
      key, target: f.target, pre: f.pre, next: bytes(next), gate: true, baseline: false,
      verify: (buf) => {
        const t = text(buf);
        const bad2 = todo.filter((p) => classify(t, p).state !== "stock");
        return bad2.length ? `${bad2.map((p) => p.id).join(",")} not reverted on disk` : null;
      },
    });
    out(`  ${key}: reverting ${todo.map((p) => p.id).join(",")} by inverse recipe`);
  }
  if (!plans.length) { out("already stock -- nothing to revert"); return 0; }
  try { return commit(deps, plans, "revert"); }
  catch (e) { err(`refusing: ${e.message}`); return 1; }
}

// Compare real paths so a junction or symlink invocation still matches; when the
// entry point is named ccr-patch.mjs but cannot be matched, say so and fail
// rather than import quietly, do nothing and exit 0.
const samePath = (a, b) => {
  try {
    const [x, y] = [fs.realpathSync(a), fs.realpathSync(b)];
    return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
  } catch { return false; }
};
const entry = process.argv[1];
if (entry && samePath(fileURLToPath(import.meta.url), entry)) process.exitCode = run(process.argv.slice(2));
else if (entry && path.basename(entry).toLowerCase() === "ccr-patch.mjs") {
  console.error(`ccr-patch: invoked as ${entry} but could not confirm it is this module; nothing was run`);
  process.exitCode = 1;
}

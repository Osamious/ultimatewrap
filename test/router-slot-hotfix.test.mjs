// Stage S0b (plan 6.6, 6.7, D-e): the exact-match slot hotfix `router/uw-router.s0b.cjs` and its deploy script
// `harness/deploy-router.mjs`. EVERYTHING here runs on fresh mkdtemp scratch trees: nothing writes the real spike/, ~/.claude,
// ~/.llmkeys, state/ or catalog/ (the last test pins that), and nothing contacts the gateway.
//
// INTENDED DIFFERENCES from `git show 6edfdee:spike/uw-router.cjs` (the explicit list; every other request/slot combination must
// be IDENTICAL, which the differential asserts exhaustively over the matrix below):
//   D1  an id that CONTAINS `claude-opus-5` but is not exactly `anthropic/claude-opus-5` or `claude-opus-5` (60 snapshot ids, V29):
//       old rewrote it to slot.model (or returned undefined on a bad slot); new serves it as asked.
//   D2  an exact slot id with an unusable slot (corrupt JSON, empty file, missing file, JSON null, no/empty/non-string `model`):
//       old returned undefined (falls to the anchor, V1); new returns asked.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import {
  REPO, LIVE_ROUTER, BACKUP_PREFIX, RETRY_DELAYS_MS, DeployError, protectedDirs, parseArgs, resolveRun, stepSwap, stepBackup, newestBackup, main,
  deploy, stepCheck, stepSmoke, stepPost, listBackups, SMOKE_MARK,
} from "../harness/deploy-router.mjs";

const SCRIPT = path.join(REPO, "harness", "deploy-router.mjs");
const S0B = path.join(REPO, "router", "uw-router.s0b.cjs");
const OLD = execFileSync("git", ["show", "6edfdee:spike/uw-router.cjs"], { cwd: REPO, encoding: "buffer", maxBuffer: 1 << 20 });
const V29 = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "router-slot-v29-ids.json"), "utf8")).ids;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const liveDir = path.dirname(LIVE_ROUTER);
const realSnapshot = () => ({ router: sha(fs.readFileSync(LIVE_ROUTER)), slot: sha(fs.readFileSync(path.join(liveDir, "slot.json"))), names: fs.readdirSync(liveDir).filter((n) => !/\.bak-pre-subpolicy-/.test(n)).sort().join("|") });   // sa-H: a live deploy leaves .bak-pre-subpolicy-* copies beside the router; they are the deploy's, not a test's
const before = realSnapshot();

const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-s0b-")); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A rehearsal tree: <T>/spike/uw-router.cjs seeded with `seed`, an identity slot, and a scratch root <T>/sm. */
function tree(seed = OLD) {
  const T = tmp(), spike = path.join(T, "spike");
  fs.mkdirSync(spike);
  fs.writeFileSync(path.join(spike, "uw-router.cjs"), seed);
  fs.writeFileSync(path.join(spike, "slot.json"), '{\n  "model": "anthropic/claude-opus-5"\n}');
  return { T, spike, live: path.join(spike, "uw-router.cjs"), sm: path.join(T, "sm"), flags: (more = []) => ["--live", path.join(spike, "uw-router.cjs"), "--scratch", path.join(T, "sm"), ...more] };
}
const cli = (args, cwd = os.tmpdir()) => { const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const candidate = (T, name, src) => { const f = path.join(T, name); fs.writeFileSync(f, src); return f; };
// a rehearsal is an allow-list (under the OS temp dir only): the real candidate is rehearsed from a COPY inside the temp tree
const s0b = (t, name = "s0b.cjs") => candidate(t.T, name, fs.readFileSync(S0B));
const leftovers = (spike) => fs.readdirSync(spike).filter((n) => n.startsWith(BACKUP_PREFIX) || n.includes(".tmp-"));

// ---------------------------------------------------------------- the router: differential against git 6edfdee

/** Load router bytes as <dir>/spike/uw-router.cjs (so __dirname is a scratch dir) with an optional slot.json body; returns the route function. */
function load(src, slotBody) {
  const T = tmp(), dir = path.join(T, "spike");
  fs.mkdirSync(dir);
  const file = path.join(dir, "uw-router.cjs");
  fs.writeFileSync(file, src);
  if (slotBody !== null) fs.writeFileSync(path.join(dir, "slot.json"), slotBody);
  return createRequire(file)(file);
}
const SLOTS = {
  identity: '{"model":"anthropic/claude-opus-5"}', pinned: '{"model":"openrouter/anthropic/claude-sonnet-5"}',
  corrupt: '{"model": ', empty: "", missing: null, jsonNull: "null", noModel: "{}", emptyModel: '{"model":""}', numModel: '{"model":5}',
};
const USABLE = new Set(["identity", "pinned"]);
const EXACT = ["anthropic/claude-opus-5", "claude-opus-5"];
const OTHER = ["anthropic/claude-sonnet-5", "anthropic/claude-haiku-4-5", "claude-opus-4-7", "openrouter/some/model:free", "x", "claude-opus-4-5"];
const req = (model) => ({ body: { model }, headers: {} });

test("fixture: exactly the 60 V29 ids, each contains claude-opus-5, none is an exact slot id", () => {
  assert.equal(V29.length, 60);
  assert.equal(new Set(V29).size, 60);
  for (const id of V29) { assert.ok(id.includes("claude-opus-5"), id); assert.ok(!EXACT.includes(id), id); }
});

test("differential vs git 6edfdee: only the D1 and D2 intended differences, everything else identical", async () => {
  const seen = { D1: 0, D2: 0, same: 0 };
  for (const [slotName, body] of Object.entries(SLOTS)) {
    const oldR = load(OLD, body), newR = load(fs.readFileSync(S0B), body);
    const slotModel = USABLE.has(slotName) ? JSON.parse(body).model : undefined;
    const ids = [...V29, ...EXACT, ...OTHER, ""];
    for (const asked of ids) {
      const o = await oldR(req(asked)), n = await newR(req(asked));
      const ctx = `slot=${slotName} asked=${JSON.stringify(asked)}`;
      if (asked.includes("claude-opus-5") && !EXACT.includes(asked)) {       // D1
        assert.equal(n, asked, ctx);
        assert.equal(o, slotModel, `${ctx}: old rewrote to the slot model (or undefined on a bad slot)`);
        seen.D1++;
      } else if (EXACT.includes(asked) && !USABLE.has(slotName)) {            // D2
        assert.equal(o, undefined, ctx);
        assert.equal(n, asked, ctx);
        seen.D2++;
      } else {
        assert.equal(n, o, `${ctx}: not an intended difference`);
        seen.same++;
      }
    }
  }
  assert.equal(seen.D1, 60 * Object.keys(SLOTS).length, "every V29 id was exercised against every slot state");
  assert.equal(seen.D2, EXACT.length * (Object.keys(SLOTS).length - USABLE.size));
  assert.ok(seen.same > 40, "the identical class is exercised too, not just the differences");
});

test("slot semantics kept: an exact id follows slot.json (identity, pinned); the hot switch still works", async () => {
  for (const id of EXACT) {
    assert.equal(await load(fs.readFileSync(S0B), SLOTS.identity)(req(id)), "anthropic/claude-opus-5");
    assert.equal(await load(fs.readFileSync(S0B), SLOTS.pinned)(req(id)), "openrouter/anthropic/claude-sonnet-5");
  }
  const r = load(fs.readFileSync(S0B), SLOTS.pinned);
  assert.equal(await r(req("zenmux/anthropic/claude-opus-5.5")), "zenmux/anthropic/claude-opus-5.5", "a substring id is NOT redirected to the pinned slot");
});

test("hostile requests never throw and never return a non-string (new router); empty model is undefined", async () => {
  const r = load(fs.readFileSync(S0B), SLOTS.corrupt);
  for (const h of [undefined, null, {}, { body: null }, { body: {} }, { body: { model: "" } }, { body: { model: null } }]) assert.equal(await r(h), undefined);
  assert.equal(await r({ body: { model: "anthropic/claude-sonnet-5", tools: "nope" }, headers: null }), "anthropic/claude-sonnet-5");
  assert.equal(await r({ body: { model: { toString() { throw new Error("x"); } } } }), undefined);
  assert.equal(await r({ body: { model: 5 } }), "5");
});

test("the candidate keeps the live file's header untouched and drops the substring test", () => {
  const norm = (b) => b.toString("utf8").replace(/\r\n/g, "\n");
  const oldLines = norm(OLD).split("\n"), newLines = norm(fs.readFileSync(S0B)).split("\n");
  assert.deepEqual(newLines.slice(0, 36), oldLines.slice(0, 36), "the 36 header lines (contract notes, #47 rationale) are byte-identical modulo EOL");
  const code = newLines.filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.ok(!/\.includes\(\s*["']claude-opus-5["']\s*\)/.test(code), "no substring test left in code");
  assert.ok(/SLOT_IDS\.has\(asked\)/.test(code));
});

// ---------------------------------------------------------------- the deploy script

test("default mode is a plan: five steps and the restore command, nothing written", () => {
  const t = tree();
  const r = cli(t.flags(["--candidate", s0b(t)]));
  assert.equal(r.code, 0, r.err);
  for (const n of [1, 2, 3, 4, 5]) assert.match(r.out, new RegExp(`\\n  ${n}\\. `));
  assert.match(r.out, /restore: node harness\/deploy-router\.mjs --restore yes --live /);
  assert.deepEqual(leftovers(t.spike), []);
  assert.deepEqual(fs.readFileSync(t.live), OLD);
  assert.equal(fs.existsSync(t.sm), false, "plan mode does not even create the scratch root");
  const live = cli([]);                                                       // the default (live) plan is also only text
  assert.equal(live.code, 0);
  assert.match(live.out, /mode: LIVE/);
  assert.match(live.out, /restore: node harness\/deploy-router\.mjs --restore yes\s*$/);
});

test("deploy the S0b candidate on a scratch tree: five steps OK, backup of the old bytes, restore command last", async () => {
  const t = tree();
  const r = cli(t.flags(["--deploy", "yes", "--candidate", s0b(t)]));
  assert.equal(r.code, 0, r.err + r.out);
  for (const n of [1, 2, 3, 4, 5]) assert.match(r.out, new RegExp(`step ${n}/5 .*OK`), r.out);
  assert.doesNotMatch(r.out, /FAILED/);
  assert.match(r.out.trim().split("\n").at(-1), /^restore: node harness\/deploy-router\.mjs --restore yes --live /);
  assert.deepEqual(fs.readFileSync(t.live), fs.readFileSync(S0B), "the live file now holds the exact candidate bytes");
  const baks = leftovers(t.spike);
  assert.equal(baks.length, 1);
  assert.match(baks[0], /^uw-router\.cjs\.bak-pre-subpolicy-\d{8}-\d{4}$/);
  assert.deepEqual(fs.readFileSync(path.join(t.spike, baks[0])), OLD, "the backup is the old live bytes");
  assert.deepEqual(fs.readdirSync(t.sm), [], "the smoke tree is removed");
  const route = createRequire(t.live)(t.live);                                // behaviour on the scratch deployment
  assert.equal(await route(req(V29[0])), V29[0]);
  assert.equal(await route(req("claude-opus-5")), "anthropic/claude-opus-5");
});

test("restore works: with ONE backup a bare --restore yes restores it (it is the original) and re-checks it; --from names one", () => {
  const t = tree();
  assert.equal(cli(t.flags(["--deploy", "yes", "--candidate", s0b(t)])).code, 0);
  const baks = leftovers(t.spike).sort();
  assert.equal(baks.length, 1);
  const r = cli(t.flags(["--restore", "yes"]));
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /restore 1\/3 .*OK/); assert.match(r.out, /restore 2\/3 .*OK/); assert.match(r.out, /restore 3\/3 .*OK/);
  assert.deepEqual(fs.readFileSync(t.live), OLD, "restored to the original live router bytes");
  assert.equal(cli(t.flags(["--deploy", "yes", "--candidate", s0b(t)])).code, 0);
  const r2 = cli(t.flags(["--restore", "yes", "--from", path.join(t.spike, baks[0])]));
  assert.equal(r2.code, 0, r2.err + r2.out);
  assert.deepEqual(fs.readFileSync(t.live), OLD);
  assert.equal(leftovers(t.spike).filter((n) => n.includes(".tmp-")).length, 0, "a restore leaves no temp file");
});

test("deploy A, deploy B, restore (S0b-2): the deploy prints the ORIGINAL backup, a bare --restore yes is refused once there are two backups (lists them, marks the oldest), --from works, and a deploy of what is already live is refused with no new backup", () => {
  const t = tree();
  const candA = s0b(t, "a.cjs"), candB = candidate(t.T, "b.cjs", fs.readFileSync(S0B, "utf8") + "\n// variant B\n");
  const A = fs.readFileSync(candA), B = fs.readFileSync(candB);
  const dA = cli(t.flags(["--deploy", "yes", "--candidate", candA]));
  assert.equal(dA.code, 0, dA.err + dA.out);
  const bak1 = path.join(t.spike, leftovers(t.spike)[0]);
  assert.match(dA.out, new RegExp(`ORIGINAL BACKUP .*: ${bak1.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`, "m"), "the first deploy names its own backup as the original");
  const dB = cli(t.flags(["--deploy", "yes", "--candidate", candB]));
  assert.equal(dB.code, 0, dB.err + dB.out);
  const baks = leftovers(t.spike).sort();
  assert.equal(baks.length, 2);
  const bak2 = baks.map((n) => path.join(t.spike, n)).find((p) => p !== bak1);
  assert.deepEqual(fs.readFileSync(bak1), OLD); assert.deepEqual(fs.readFileSync(bak2), A);
  assert.match(dB.out, new RegExp(`ORIGINAL BACKUP .*: ${bak1.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`, "m"), "the second deploy still points at the FIRST backup (bak1 is a prefix of bak2's name in one minute: the match is anchored), not at its own");
  assert.equal(dB.out.trim().split("\n").at(-1), `restore: node harness/deploy-router.mjs --restore yes --live ${t.live} --scratch ${t.sm} --from ${bak2}`, "the last line restores THIS deploy's pre-image explicitly");
  // a bare restore is now ambiguous: refused, nothing touched, both backups listed, the oldest marked
  const amb = cli(t.flags(["--restore", "yes"]));
  assert.equal(amb.code, 1, amb.out + amb.err);
  assert.match(amb.err, /E_AMBIGUOUS/); assert.ok(amb.err.includes(bak1) && amb.err.includes(bak2));
  assert.match(amb.err, new RegExp(`1\\. .*${path.basename(bak1)}  \\(the ORIGINAL`));
  assert.ok(!/2\. .*\(the ORIGINAL/.test(amb.err));
  assert.deepEqual(fs.readFileSync(t.live), B, "the refused restore touched nothing");
  const toOrig = cli(t.flags(["--restore", "yes", "--from", bak1]));
  assert.equal(toOrig.code, 0, toOrig.err + toOrig.out);
  assert.deepEqual(fs.readFileSync(t.live), OLD);
  const toA = cli(t.flags(["--restore", "yes", "--from", bak2]));
  assert.equal(toA.code, 0); assert.deepEqual(fs.readFileSync(t.live), A);
  // deploying what is already live is refused up front: no step ran, no backup was added
  const noop = cli(t.flags(["--deploy", "yes", "--candidate", candA]));
  assert.equal(noop.code, 1, noop.out + noop.err); assert.match(noop.err, /E_NOOP/); assert.doesNotMatch(noop.out, /step 1\/5/);
  assert.deepEqual(leftovers(t.spike).sort(), baks, "no backup was made by the refused deploy");
  assert.deepEqual(fs.readFileSync(t.live), A);
});

const BROKEN = {
  "a syntax error (step 1)": [1, "module.exports = async function route( {"],
  "a module-scope throw (step 2)": [2, 'throw new Error("load-time boom");\nmodule.exports = async () => "x";'],
  "a missing require (step 2)": [2, 'require("uw-no-such-module-xyz");\nmodule.exports = async (r) => String(r?.body?.model ?? "") || undefined;'],
  "a non-function export (step 2)": [2, 'module.exports = { route: async () => "x" };'],
  "a module that ends the process (step 2)": [2, "process.exit(0);"],
  "the non-awaited bug: async work returned inside try, never awaited (step 2)": [2,
    'async function inner(req) { throw new Error("late"); }\n' +
    'module.exports = async function route(req) { try { return inner(req); } catch { return String(req?.body?.model ?? "") || undefined; } };'],
  "a Promise that resolves to a non-string (step 2)": [2, 'module.exports = async (req) => (req?.body?.model ? new Promise((r) => setTimeout(() => r(42), 5)) : undefined);'],
  "a Promise that resolves to the wrong string (step 2)": [2, 'module.exports = async (req) => (req?.body?.model ? Promise.resolve("anthropic/claude-opus-5") : undefined);'],
  "a call that never settles (step 2)": [2, "module.exports = () => new Promise(() => {});"],
  "a router that throws on a hostile request (step 2)": [2, 'module.exports = async (req) => { const m = String(req.body.model); return m || undefined; };'],
  "an empty-model call that answers (step 2)": [2, 'module.exports = async (req) => String(req?.body?.model ?? "") || "anthropic/claude-opus-5";'],
};
for (const [name, [step, src]] of Object.entries(BROKEN)) {
  test(`a deliberately broken candidate is refused, live untouched, no backup: ${name}`, () => {
    const t = tree();
    const bad = candidate(t.T, "bad.cjs", src);
    const r = cli(t.flags(["--deploy", "yes", "--candidate", bad]));
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, new RegExp(`step ${step}/5 .*FAILED`), r.out);
    assert.doesNotMatch(r.out, /step 3\/5/, "refused before the backup step");
    assert.deepEqual(fs.readFileSync(t.live), OLD, "live file untouched");
    assert.deepEqual(leftovers(t.spike), [], "no backup and no temp file");
    assert.deepEqual(fs.existsSync(t.sm) ? fs.readdirSync(t.sm) : [], [], "smoke and check trees cleaned up");
  });
}

test("a restore of a corrupt backup is refused at step 1 (syntax) or 2 (load), live untouched", () => {
  for (const [src, step] of [["module.exports = async function route( {", 1], ['throw new Error("x");', 2]]) {
    const t = tree();
    const bak = path.join(t.spike, `${BACKUP_PREFIX}20260101-0000`);
    fs.writeFileSync(bak, src);
    const r = cli(t.flags(["--restore", "yes"]));
    assert.equal(r.code, 2, r.out + r.err);
    assert.match(r.out, new RegExp(`restore ${step}/3 .*FAILED`));
    assert.deepEqual(fs.readFileSync(t.live), OLD);
    const r2 = cli(t.flags(["--restore", "yes", "--from", bak]));
    assert.equal(r2.code, 2);
    assert.deepEqual(fs.readFileSync(t.live), OLD);
  }
  const t = tree();                                                           // no backup at all
  const r = cli(t.flags(["--restore", "yes"]));
  assert.equal(r.code, 2);
  assert.match(r.err, /no uw-router\.cjs\.bak-pre-subpolicy-\* backup|no .*backup next to/);
});

test("--from must be a backup next to the live file", () => {
  const t = tree();
  const other = candidate(t.T, "elsewhere.cjs", "module.exports = async () => undefined;");
  const r = cli(t.flags(["--restore", "yes", "--from", other]));
  assert.equal(r.code, 1);
  assert.match(r.err, /must be a uw-router\.cjs\.bak-pre-subpolicy-/);
  assert.deepEqual(fs.readFileSync(t.live), OLD);
});

// ---------------------------------------------------------------- path discipline (F6/G1)

test("flag discipline: blank, missing and non-yes/no values, unknown flags, half rehearsal sets", () => {
  const bad = [["--deploy"], ["--deploy", "--candidate", "x"], ["--deploy", "true"], ["--deploy", "1"], ["--restore", "YES"], ["--live", ""], ["--live", "   ", "--scratch", "s"],
    ["--live", "a", "--scratch", ""], ["--candidate", ""], ["--candidate", " "], ["--from", ""], ["--live", "a"], ["--scratch", "s"], ["--bogus", "x"], ["stray"],
    ["--deploy", "yes"], ["--deploy", "yes", "--restore", "yes", "--candidate", "c"], ["--restore", "yes", "--candidate", "c"], ["--deploy", "yes", "--candidate", "c", "--from", "f"],
    ["--live", "a", "--live", "b", "--scratch", "s"]];
  for (const a of bad) assert.throws(() => parseArgs(a), (e) => e instanceof DeployError && e.code === 1 && /E_USAGE/.test(e.message), JSON.stringify(a));
  assert.doesNotThrow(() => parseArgs(["--deploy", "no"]));
  assert.doesNotThrow(() => parseArgs(["--live", "a", "--scratch", "s", "--deploy", "yes", "--candidate", "c"]));
});

test("the real protected folders include spike/, state/, catalog/, ~/.claude and ~/.llmkeys", () => {
  const p = protectedDirs().map((d) => d.toLowerCase());
  for (const need of [path.join(REPO, "spike"), path.join(REPO, "state"), path.join(REPO, "catalog"), path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".llmkeys")]) {
    assert.ok(p.includes(need.toLowerCase()), need);
  }
});

test("a rehearsal naming a REAL protected path is refused (plan mode only; no yes flag is ever given with a real path here)", () => {
  const t = tree();
  const real = [LIVE_ROUTER, path.join(liveDir, "x.cjs"), path.join(os.homedir(), ".claude", "x.cjs"), path.join(os.homedir(), ".llmkeys", "x.cjs"),
    path.join(REPO, "state", "x.cjs"), path.join(REPO, "catalog", "x.cjs")];
  for (const p of real) {
    for (const flagset of [["--live", p, "--scratch", t.sm], ["--live", t.live, "--scratch", p], ["--live", t.live, "--scratch", t.sm, "--candidate", p]]) {
      const r = cli(flagset);
      assert.equal(r.code, 1, `${JSON.stringify(flagset)}\n${r.out}`);
      assert.match(r.err, /refusing --(live|scratch|candidate)/);
    }
  }
  assert.equal(cli(["--live", `${LIVE_ROUTER.toUpperCase()}`, "--scratch", t.sm]).code, process.platform === "win32" ? 1 : 0, "case-folded spelling on Windows");
  assert.equal(cli(["--live", path.join(liveDir, "..", "spike", "uw-router.cjs"), "--scratch", t.sm]).code, 1, "a .. spelling");
});

test("with the protected set injected, --deploy yes and --restore yes refuse before writing anything (live, scratch, candidate, junction, case)", () => {
  const t = tree(), fakeSpike = path.join(t.T, "fake-protected"), seen = [];
  fs.mkdirSync(fakeSpike);
  const inside = path.join(fakeSpike, "uw-router.cjs");
  fs.writeFileSync(inside, OLD);
  const protect = [fakeSpike];
  const run = (a) => { const out = [], err = []; const code = main(a, { out: (s) => out.push(s), err: (s) => err.push(s), protect }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const cases = [
    ["--live", inside, "--scratch", t.sm, "--deploy", "yes", "--candidate", s0b(t)],
    ["--live", inside, "--scratch", t.sm, "--restore", "yes"],
    ["--live", t.live, "--scratch", path.join(fakeSpike, "sm"), "--deploy", "yes", "--candidate", s0b(t)],
    ["--live", t.live, "--scratch", t.sm, "--deploy", "yes", "--candidate", inside],
    ["--live", path.join(fakeSpike, "..", "fake-protected", "uw-router.cjs"), "--scratch", t.sm, "--deploy", "yes", "--candidate", s0b(t)],
    ["--live", inside.toUpperCase(), "--scratch", t.sm, "--deploy", "yes", "--candidate", s0b(t)],
  ];
  const link = path.join(t.T, "link");
  fs.symlinkSync(fakeSpike, link, process.platform === "win32" ? "junction" : "dir");
  cases.push(["--live", path.join(link, "uw-router.cjs"), "--scratch", t.sm, "--deploy", "yes", "--candidate", s0b(t)]);
  for (const a of cases) {
    if (process.platform !== "win32" && a.includes(inside.toUpperCase())) continue;   // case folding is a Windows property
    const r = run(a);
    assert.equal(r.code, 1, `${JSON.stringify(a)} -> ${r.out}${r.err}`);
    assert.match(r.err, /refusing --/);
    seen.push(r.out);
  }
  assert.ok(seen.every((o) => o === ""), "no step output at all: refused before any step ran");
  assert.deepEqual(fs.readFileSync(inside), OLD, "the injected protected file is untouched");
  assert.deepEqual(fs.readdirSync(fakeSpike), ["uw-router.cjs"], "nothing was written into the protected folder");
  assert.deepEqual(fs.readFileSync(t.live), OLD);
  assert.deepEqual(leftovers(t.spike), []);
});

// ---------------------------------------------------------------- unit seams

test("atomic swap retries with the 10/30/90/270/810 ms backoff on EPERM, then succeeds", () => {
  const t = tree(), delays = [];
  let n = 0;
  stepSwap(t.live, fs.readFileSync(S0B), { sleep: (ms) => delays.push(ms), rename: (a, b) => { if (++n <= 3) throw Object.assign(new Error("busy"), { code: "EPERM" }); fs.renameSync(a, b); } });
  assert.deepEqual(delays, [10, 30, 90]);
  assert.deepEqual(RETRY_DELAYS_MS, [10, 30, 90, 270, 810]);
  assert.deepEqual(fs.readFileSync(t.live), fs.readFileSync(S0B));
  assert.deepEqual(leftovers(t.spike), []);
});

test("atomic swap that keeps failing aborts with the temp file removed and the live file untouched; a non-retryable error does not retry", () => {
  const t = tree(), delays = [];
  const eperm = () => { throw Object.assign(new Error("busy"), { code: "EPERM" }); };
  assert.throws(() => stepSwap(t.live, fs.readFileSync(S0B), { sleep: (ms) => delays.push(ms), rename: eperm }), /live file untouched/);
  assert.deepEqual(delays, [10, 30, 90, 270, 810]);
  assert.deepEqual(fs.readFileSync(t.live), OLD);
  assert.deepEqual(leftovers(t.spike), []);
  const d2 = [];
  assert.throws(() => stepSwap(t.live, fs.readFileSync(S0B), { sleep: (ms) => d2.push(ms), rename: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }), /ENOENT/);
  assert.deepEqual(d2, []);
  assert.deepEqual(leftovers(t.spike), []);
});

test("backups are never overwritten (same minute adds -2, -3) and their hash is verified; newestBackup orders by stamp then number", () => {
  const t = tree(), now = () => new Date(2026, 9, 3, 14, 5);
  const a = stepBackup(t.live, { now }), b = stepBackup(t.live, { now }), c = stepBackup(t.live, { now });
  assert.deepEqual([a, b, c].map((x) => path.basename(x.backup)), [`${BACKUP_PREFIX}20261003-1405`, `${BACKUP_PREFIX}20261003-1405-2`, `${BACKUP_PREFIX}20261003-1405-3`]);
  for (const x of [a, b, c]) assert.equal(sha(fs.readFileSync(x.backup)), sha(OLD));
  for (let i = 4; i <= 10; i++) stepBackup(t.live, { now });
  stepBackup(t.live, { now: () => new Date(2026, 9, 3, 14, 4) });
  fs.writeFileSync(path.join(t.spike, "uw-router.cjs.bak-other"), "x");
  assert.equal(path.basename(newestBackup(t.live)), `${BACKUP_PREFIX}20261003-1405-10`, "-10 sorts after -2");
  assert.throws(() => stepBackup(path.join(t.spike, "nope.cjs")), /cannot read the live router file/);
});

// ---------------------------------------------------------------- S0b-1: the rehearsal guard is an ALLOW-LIST (plan mode only: no yes flag is ever given with a real or UNC path here)

test("rehearsal allow-list (S0b-1): UNC spellings of the REAL spike/ file are refused before any filesystem call, in every role; the real file is untouched", () => {
  const t = tree();
  const seen = [];
  const m = mock.method(fs.realpathSync, "native", (p, ...a) => { seen.push(String(p)); return m.mock.original(p, ...a); });
  const forms = ["\\\\localhost\\C$\\Users\\osami\\.uw\\spike\\uw-router.cjs", "\\\\127.0.0.1\\C$\\Users\\osami\\.uw\\spike\\uw-router.cjs", "//localhost/C$/Users/osami/.uw/spike/uw-router.cjs",
    "\\\\?\\C:\\Users\\osami\\.uw\\spike\\uw-router.cjs", "\\\\.\\C:\\Users\\osami\\.uw\\spike\\uw-router.cjs"];
  try {
    for (const unc of forms) {
      for (const flagset of [["--live", unc, "--scratch", t.sm], ["--live", t.live, "--scratch", unc], ["--live", t.live, "--scratch", t.sm, "--candidate", unc], ["--live", t.live, "--scratch", t.sm, "--from", unc]]) {
        const r = cli(flagset);
        assert.equal(r.code, 1, `${JSON.stringify(flagset)}\n${r.out}`);
        assert.match(r.err, /refusing --(live|scratch|candidate|from) .*UNC or device path/);
        assert.equal(r.out, "", "no plan was printed");
      }
    }
    seen.length = 0;
    const out = [], err = [];
    assert.equal(main(["--live", forms[0], "--scratch", t.sm], { out: (s) => out.push(s), err: (s) => err.push(s) }), 1);
    assert.deepEqual(seen.filter((p) => p.startsWith("\\\\")), [], "no realpath call was made on the UNC spelling");
  } finally { m.mock.restore(); }
  assert.deepEqual(realSnapshot(), before, "the real spike/ is untouched");
});

test("rehearsal allow-list (S0b-1): live, scratch, candidate and backup must resolve under the OS temp dir; a junction out of it, the repo's own router/ and the home folder are refused; a temp path still works", () => {
  const t = tree();
  const home = path.join(os.homedir(), "uw-s0b-rehearsal-not-here");
  const cases = [
    [["--live", path.join(home, "uw-router.cjs"), "--scratch", t.sm], /refusing --live .*must resolve under the OS temp dir/],
    [["--live", t.live, "--scratch", path.join(home, "sm")], /refusing --scratch .*must resolve under the OS temp dir/],
    [["--live", t.live, "--scratch", t.sm, "--candidate", S0B], /refusing --candidate .*must resolve under the OS temp dir/],
    [["--live", t.live, "--scratch", t.sm, "--from", path.join(home, `${BACKUP_PREFIX}20260101-0000`)], /refusing --from .*must resolve under the OS temp dir/],
  ];
  for (const [flags, re] of cases) { const r = cli(flags); assert.equal(r.code, 1, JSON.stringify(flags)); assert.match(r.err, re); }
  const link = path.join(t.T, "to-repo");                        // a junction INSIDE the temp tree that leads to the repo (read-only: only the link is created)
  fs.symlinkSync(path.join(REPO, "harness"), link, process.platform === "win32" ? "junction" : "dir");
  try {
    const r = cli(["--live", path.join(link, "x.cjs"), "--scratch", t.sm]);
    assert.equal(r.code, 1, r.out); assert.match(r.err, /refusing --live .*it resolves to /);
  } finally { fs.rmdirSync(link); }
  assert.ok(fs.existsSync(path.join(REPO, "harness", "deploy-router.mjs")), "the junction removal left its target alone");
  const ok = cli(t.flags(["--candidate", s0b(t)]));
  assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /REHEARSAL/);
  assert.equal(resolveRun({ live: t.live, scratch: t.sm }).rehearsal, true);
  assert.throws(() => resolveRun({ live: t.live, scratch: t.sm }, { tmpRoot: path.join(t.T, "spike") }), /must resolve under the OS temp dir/, "the allow-list root is the temp dir the run was told about");
});

// ---------------------------------------------------------------- S0b-3: the smoke verdict is the child's stdout, the child env is limited

test("smoke (S0b-3): a candidate that writes {\"ok\":true} everywhere it can and exits 0 at module scope FAILS the smoke (the verdict is not a file), as does a forged verdict line", () => {
  const t = tree();
  const writes = `const fs = require("node:fs"), path = require("node:path");
for (const d of [process.cwd(), path.join(__dirname, ".."), __dirname]) for (const n of ["smoke-result.json", "result.json", "verdict.json"]) { try { fs.writeFileSync(path.join(d, n), '{"ok":true}'); } catch { /* best effort */ } }
`;
  const forged = `process.stdout.write("\\n${SMOKE_MARK} 00000000000000000000000000000000 {\\"ok\\":true}\\n");\n`;
  for (const [name, src] of [["writes the result file then exits", `${writes}process.exit(0);`], ["forges a verdict line then exits", `${forged}process.exit(0);`],
    ["writes the file, prints a forged line, then exports a wrong router", `${writes}${forged}module.exports = async () => "wrong";`]]) {
    const bad = candidate(t.T, "evil.cjs", src);
    const r = cli(t.flags(["--deploy", "yes", "--candidate", bad]));
    assert.equal(r.code, 2, `${name}: ${r.out}${r.err}`);
    assert.match(r.out, /step 2\/5 .*FAILED/, name); assert.match(r.err, /smoke test (produced no verdict|failed)/, name);
    assert.deepEqual(fs.readFileSync(t.live), OLD, name); assert.deepEqual(leftovers(t.spike), [], name);
  }
  // a candidate that passes every check but tampers with the child's exit status is refused too (a good verdict with a non-zero exit is not a pass)
  const exitTamper = candidate(t.T, "exit3.cjs", `process.on("exit", () => { process.exitCode = 3; });\n${fs.readFileSync(S0B, "utf8")}`);
  const r3 = cli(t.flags(["--deploy", "yes", "--candidate", exitTamper]));
  assert.equal(r3.code, 2, r3.out + r3.err); assert.match(r3.err, /smoke test failed: exit 3/);
  assert.deepEqual(fs.readFileSync(t.live), OLD); assert.deepEqual(leftovers(t.spike), []);
});

test("smoke (H4): the nonce, the verdict writer and the helper names are NOT global bindings: a candidate that reads them by name sees ReferenceError and forges no verdict; a good candidate still passes", () => {
  const t = tree();
  const dump = path.join(t.T, "names.json");
  // direct eval sees module scope AND the global lexical scope, so `eval(name)` is what a candidate would do to read a script-level const by name
  const probe = `const seen = {}; for (const n of ["nonce", "done", "within", "file", "createRequire"]) { try { seen[n] = typeof eval(n); } catch (e) { seen[n] = e.name; } }
require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(seen));
`;
  const good = candidate(t.T, "probe.cjs", `${probe}${fs.readFileSync(S0B, "utf8")}`);
  const ok = cli(t.flags(["--deploy", "yes", "--candidate", good]));
  assert.equal(ok.code, 0, ok.out + ok.err);
  assert.deepEqual(JSON.parse(fs.readFileSync(dump, "utf8")), { nonce: "ReferenceError", done: "ReferenceError", within: "ReferenceError", file: "ReferenceError", createRequire: "ReferenceError" }, "none of them is reachable by name");
  // a candidate that reads the nonce by name and prints a well-formed verdict with it: before the IIFE this PASSED the smoke
  const t2 = tree();
  const forge = `let n; try { n = eval("nonce"); } catch (e) { /* not reachable */ }
if (n) process.stdout.write("\\n${SMOKE_MARK} " + n + ' {"ok":true}\\n');
process.exit(0);
`;
  const bad = candidate(t2.T, "forge-by-name.cjs", forge);
  const r = cli(t2.flags(["--deploy", "yes", "--candidate", bad]));
  assert.equal(r.code, 2, r.out + r.err);
  assert.match(r.err, /smoke test produced no verdict/);
  assert.deepEqual(fs.readFileSync(t2.live), OLD); assert.deepEqual(leftovers(t2.spike), []);
});

test("smoke (S0b-3): the child sees UW_SMOKE_FILE, SystemRoot, PATH and TEMP and nothing else of the parent's environment; the nonce is gone before the candidate loads", () => {
  const t = tree();
  const dump = path.join(t.T, "envdump.json");
  const src = `require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(Object.keys(process.env)));\n${fs.readFileSync(S0B, "utf8")}`;
  const cand = candidate(t.T, "dump.cjs", src);
  const secrets = { ANTHROPIC_API_KEY: ["s", "k-", "ZZ11yy22XX33ww44VV55uu66"].join(""), HTTPS_PROXY: "http://proxy.invalid:1", CLAUDE_CONFIG_DIR: "C:\\real\\claude", CCR_WEB_AUTH_TOKEN: "tok" };
  const r = spawnSync(process.execPath, [SCRIPT, ...t.flags(["--deploy", "yes", "--candidate", cand])], { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, ...secrets } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const keys = JSON.parse(fs.readFileSync(dump, "utf8")).map((k) => k.toUpperCase());
  for (const k of Object.keys(secrets)) assert.ok(!keys.includes(k), `${k} leaked into the smoke child`);
  assert.ok(!keys.includes("UW_SMOKE_NONCE"), "the nonce was deleted before the candidate ran");
  assert.ok(keys.includes("UW_SMOKE_FILE"));
  // Windows injects its own defaults (USERPROFILE, WINDIR, ...) into any child whatever the parent passes, so the expectation is measured: a trivial
  // child given exactly the variables the smoke passes (UW_SMOKE_FILE, SystemRoot, PATH, TEMP) shows what the OS adds; the smoke child must see no more.
  const restricted = { UW_SMOKE_FILE: "x" };
  for (const k of ["SystemRoot", "PATH", "TEMP"]) if (process.env[k] !== undefined) restricted[k] = process.env[k];
  const base = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(Object.keys(process.env)))"], { env: restricted, encoding: "utf8" });
  const baseKeys = JSON.parse(base.stdout).map((k) => k.toUpperCase());
  const extra = keys.filter((k) => !baseKeys.includes(k));
  assert.deepEqual(extra, [], `variables beyond what the restricted env gives any child: ${extra.join(",")}`);
  assert.ok(keys.length <= baseKeys.length);
});

// ---------------------------------------------------------------- S0b-4: fault injection (each guard must fire; the mutation proof is in the report)

const tag = (n) => `T${n}`;
const corrupting = (match) => ({ ...fs, writeFileSync: (p, b, o) => fs.writeFileSync(p, match(String(p)) ? Buffer.concat([Buffer.from(b), Buffer.from("X")]) : b, o) });

test("fault injection: step 5 compares the live file's hash to the deployed hash (a live file that differs is refused)", () => {
  const t = tree();
  assert.throws(() => stepPost(t.live, sha(Buffer.from("not the live bytes"))), (e) => e instanceof DeployError && /live file hash is not the deployed hash/.test(e.message));
  assert.doesNotThrow(() => stepPost(t.live, sha(OLD)));
});

test("fault injection: a rename that lands DIFFERENT bytes is caught by the post-check, which names the restore command; running it restores the original", () => {
  const t = tree();
  const cand = s0b(t), out = [];
  const r = resolveRun(parseArgs(t.flags(["--deploy", "yes", "--candidate", cand])));
  const evil = (a, b) => { fs.rmSync(a, { force: true }); fs.writeFileSync(b, "module.exports = async () => undefined;\n"); };
  assert.throws(() => deploy(r, { out: (s) => out.push(s), rename: evil }), (e) => e instanceof DeployError && /live file hash is not the deployed hash/.test(e.message));
  const text = out.join("\n");
  assert.match(text, /step 5\/5 .*FAILED/); assert.match(text, /THE LIVE FILE WAS REPLACED BUT FAILED ITS POST-CHECK: restore now with: node harness\/deploy-router\.mjs --restore yes --live .* --from /);
  const cmd = /restore now with: node harness\/deploy-router\.mjs (.*)$/m.exec(text)[1].split(" ");
  assert.notDeepEqual(fs.readFileSync(t.live), OLD);
  const back = cli(cmd);
  assert.equal(back.code, 0, back.out + back.err);
  assert.deepEqual(fs.readFileSync(t.live), OLD, "the printed command restored the original bytes");
});

test("fault injection: the temp file's hash is verified before the rename (a write that corrupts the temp is refused, the temp removed, the live file untouched)", () => {
  const t = tree();
  let renamed = false;
  assert.throws(() => stepSwap(t.live, fs.readFileSync(S0B), { fs: corrupting((p) => p.includes(".tmp-")), tag: tag(1), rename: () => { renamed = true; } }),
    (e) => e instanceof DeployError && /temp file .* failed its hash check; live file untouched/.test(e.message));
  assert.equal(renamed, false); assert.deepEqual(fs.readFileSync(t.live), OLD); assert.deepEqual(leftovers(t.spike), []);
});

test("fault injection: the backup copy's hash is verified (a corrupted backup is removed and refused)", () => {
  const t = tree();
  assert.throws(() => stepBackup(t.live, { fs: corrupting((p) => p.includes(".bak-pre-subpolicy-")), now: () => new Date(2026, 9, 3, 14, 5) }),
    (e) => e instanceof DeployError && /backup .* failed its hash check/.test(e.message));
  assert.deepEqual(leftovers(t.spike), [], "the corrupt backup was removed");
  assert.deepEqual(fs.readFileSync(t.live), OLD);
});

test("fault injection: a temp name that already exists (wx EEXIST) is never overwritten or deleted and never surfaces as a raw EEXIST: the next suffix is used; all taken is a DeployError", () => {
  const t = tree();
  const stale = `${t.live}.tmp-${tag(7)}`;
  fs.writeFileSync(stale, "someone else's temp file");
  stepSwap(t.live, fs.readFileSync(S0B), { tag: tag(7) });
  assert.deepEqual(fs.readFileSync(t.live), fs.readFileSync(S0B), "the swap succeeded with the next suffix");
  assert.equal(fs.readFileSync(stale, "utf8"), "someone else's temp file", "the foreign temp file was not touched");
  assert.deepEqual(leftovers(t.spike), [path.basename(stale)], "nothing of ours is left behind");
  const t3 = tree();                                             // a foreign temp file AND a later failure of ours: only the temp THIS call created is removed
  const stale3 = `${t3.live}.tmp-${tag(9)}`;
  fs.writeFileSync(stale3, "another run's temp file");
  assert.throws(() => stepSwap(t3.live, fs.readFileSync(S0B), { fs: corrupting((p) => p.includes(".tmp-")), tag: tag(9) }), /failed its hash check/);
  assert.equal(fs.readFileSync(stale3, "utf8"), "another run's temp file", "the foreign temp file survived our failure");
  assert.deepEqual(leftovers(t3.spike), [path.basename(stale3)], "our own temp (the -2 name) was removed");
  const t2 = tree();
  const allTaken ={ ...fs, writeFileSync: (p, b, o) => { if (o && o.flag === "wx") throw Object.assign(new Error("exists"), { code: "EEXIST" }); return fs.writeFileSync(p, b, o); } };
  let err;
  try { stepSwap(t2.live, fs.readFileSync(S0B), { fs: allTaken, tag: tag(8) }); } catch (e) { err = e; }
  assert.ok(err instanceof DeployError && err.code === 2 && /no free temp file name/.test(err.message), `not a raw EEXIST: ${err && err.code}`);
  assert.deepEqual(fs.readFileSync(t2.live), OLD);
  const io = { ...fs, writeFileSync: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  assert.throws(() => stepSwap(t2.live, fs.readFileSync(S0B), { fs: io }), (e) => e instanceof DeployError && /cannot write the temp file .*ENOSPC/.test(e.message));
});

test("fault injection: step 1 refuses a file that changed between reading and checking (a wrong expected hash, and a second read that returns other bytes)", () => {
  const t = tree();
  const file = candidate(t.T, "chk.cjs", fs.readFileSync(S0B));
  assert.doesNotThrow(() => stepCheck(file, sha(fs.readFileSync(S0B))));
  assert.throws(() => stepCheck(file, sha(Buffer.from("other"))), (e) => e instanceof DeployError && /changed between reading and checking/.test(e.message));
  let reads = 0;
  const swapped = { ...fs, readFileSync: (p, o) => (path.resolve(String(p)) === path.resolve(file) && ++reads === 1 ? Buffer.from("swapped after the syntax check") : fs.readFileSync(p, o)) };
  assert.throws(() => stepCheck(file, sha(fs.readFileSync(S0B)), os.tmpdir(), { fs: swapped }), /changed between reading and checking/);
});

test("fault injection: step 2 re-hashes the scratch copy right after writing it and again after the smoke ran (a corrupt write, and a candidate that edits its own file)", () => {
  const t = tree();
  assert.throws(() => stepSmoke(fs.readFileSync(S0B), t.sm, { fs: corrupting((p) => /uw-router-smoke-.*[\\/]spike[\\/]uw-router\.cjs$/.test(p)) }),
    (e) => e instanceof DeployError && /scratch copy hash differs from the candidate right after writing/.test(e.message));
  const selfEdit = candidate(t.T, "selfedit.cjs", `${fs.readFileSync(S0B, "utf8")}\nrequire("node:fs").appendFileSync(__filename, "\\n// edited by itself\\n");\n`);
  const r = cli(t.flags(["--deploy", "yes", "--candidate", selfEdit]));
  assert.equal(r.code, 2, r.out + r.err); assert.match(r.err, /the smoke test modified the scratch copy/);
  assert.deepEqual(fs.readFileSync(t.live), OLD); assert.deepEqual(leftovers(t.spike), []);
  assert.deepEqual(fs.existsSync(t.sm) ? fs.readdirSync(t.sm) : [], [], "the smoke tree is removed even after a refusal");
});

// ---------------------------------------------------------------- D5: the plan 9.1 contract pins as source-text assertions

test("contract pin 7 (plan 9.1): deploy runs node --check, then the smoke test, then the backup, then temp+rename, then the post-check, and nothing writes the live path directly", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const dep = src.slice(src.indexOf("export function deploy("), src.indexOf("export function restore("));
  const at = ["stepCheck(", "stepSmoke(", "stepBackup(", "stepSwap(", "stepPost("].map((n) => dep.indexOf(n));
  assert.ok(at.every((i, n) => i > 0 && (n === 0 || i > at[n - 1])), `deploy step order is not check < smoke < backup < swap < post: ${at}`);
  const swap = src.slice(src.indexOf("export function stepSwap("), src.indexOf("export function stepPost("));
  assert.ok(/flag: "wx"/.test(swap) && /rename\(tmp, live\)/.test(swap) && /\.tmp-/.test(swap), "stepSwap writes an exclusive temp file and renames it over live");
  assert.ok(!/writeFileSync\(\s*(r\.)?live\b/.test(src), "no writeFileSync straight to the live path");
  assert.ok(!/(copyFileSync|renameSync|appendFileSync|createWriteStream)\([^;]*,\s*(r\.)?live\b/.test(src.replace(/rename\(tmp, live\)/g, "")), "no other direct write to the live path");
  const res = src.slice(src.indexOf("export function restore("), src.indexOf("/** Returns the process exit code"));
  const rat = ["stepCheck(", "stepSmoke(", "stepSwap(", "stepPost("].map((n) => res.indexOf(n));
  assert.ok(rat.every((i, n) => i > 0 && (n === 0 || i > rat[n - 1])), "restore runs the same steps in the same order");
});

test("contract pin 13 (plan 9.1): the smoke test AWAITS every call to the exported route function", () => {
  const src = fs.readFileSync(SCRIPT, "utf8");
  const smoke = src.slice(src.indexOf("const SMOKE = `"), src.indexOf("`;", src.indexOf("const SMOKE = `")));
  const calls = smoke.split("\n").filter((l) => /\broute\(/.test(l) && !/typeof route|const route =/.test(l));
  assert.ok(calls.length >= 3, `expected at least three route() call lines, found ${calls.length}`);
  for (const l of calls) assert.ok(/await within\(route\(/.test(l), `a route() call is not awaited: ${l.trim()}`);
  assert.ok(/for \(const \[i, h\] of hostile\.entries\(\)\)/.test(smoke) && /await within\(route\(h,/.test(smoke), "the hostile loop awaits too");
});

// ---------------------------------------------------------------- D5: the differential on whitespace, case, non-string and null variants, through the OLD router too

test("differential vs git 6edfdee (variants): whitespace, case and prefix variants of the slot id, non-string models and null requests behave identically except the D1/D2 differences", async () => {
  const MODELS = [" claude-opus-5", "claude-opus-5 ", "CLAUDE-OPUS-5", "Claude-Opus-5", "xclaude-opus-5", "claude-opus-5x", "Anthropic/claude-opus-5", "anthropic/claude-opus-5 ", " anthropic/claude-opus-5",
    "anthropic/CLAUDE-OPUS-5", 5, 0, true, false, {}, [], ["claude-opus-5"], ["anthropic/claude-opus-5"], [" claude-opus-5"], { toString() { return "claude-opus-5"; } }, { toString() { return "xclaude-opus-5"; } }, { toString() { throw new Error("hostile"); } }];
  const REQS = [...MODELS.map((m) => ({ body: { model: m }, headers: {} })), undefined, null, {}, { body: null }, { body: {} }, { body: { model: null } }, { body: { model: undefined } }, { headers: null, body: { model: "x" } }, { body: { model: "claude-opus-5", tools: "nope" }, headers: null }];
  const askedOf = (rq) => { try { return String(rq?.body?.model ?? ""); } catch { return ""; } };
  const seen = { D1: 0, D2: 0, same: 0, empty: 0, exact: 0 };
  for (const [slotName, body] of Object.entries(SLOTS)) {
    const oldR = load(OLD, body), newR = load(fs.readFileSync(S0B), body);
    const slotModel = USABLE.has(slotName) ? JSON.parse(body).model : undefined;
    for (const rq of REQS) {
      const o = await oldR(rq), n = await newR(rq), a = askedOf(rq), ctx = `slot=${slotName} asked=${JSON.stringify(a)}`;
      if (!a) { assert.equal(o, undefined, ctx); assert.equal(n, undefined, ctx); seen.empty++; }
      else if (EXACT.includes(a)) {
        if (USABLE.has(slotName)) { assert.equal(o, slotModel, ctx); assert.equal(n, slotModel, ctx); seen.exact++; }
        else { assert.equal(o, undefined, ctx); assert.equal(n, a, ctx); seen.D2++; }
      } else if (a.includes("claude-opus-5")) { assert.equal(o, slotModel, `${ctx}: old rewrote to the slot (or undefined)`); assert.equal(n, a, ctx); seen.D1++; }
      else { assert.equal(o, a, ctx); assert.equal(n, a, ctx); seen.same++; }
    }
  }
  assert.ok(seen.D1 >= 8 * Object.keys(SLOTS).length && seen.D2 >= 2 && seen.exact >= 2 && seen.same >= 20 && seen.empty >= 8, `every class was exercised: ${JSON.stringify(seen)}`);
  const upper = askedOf({ body: { model: "CLAUDE-OPUS-5" } });
  assert.ok(!upper.includes("claude-opus-5"), "uppercase is not the substring the old router tested (it served it as asked): the matrix pins that");
});

test("no part of this file touched the real spike/ (hashes and the directory listing are unchanged)", () => {
  assert.deepEqual(realSnapshot(), before);
  assert.ok(!/\.tmp-/.test(realSnapshot().names), "no temp file of a test is left in spike/ (a live deploy's own .bak-pre-subpolicy-* copies are ignored)");
});

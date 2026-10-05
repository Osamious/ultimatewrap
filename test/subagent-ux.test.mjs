// The CLI UX wave (plan 7.2, stage S1d): the pure verdict, `status`, `last`, `preset`, `help`, `wizard`, `pause`/`resume`/`undo`, `why`, the one code table,
// the E_EMPTY cures, the what-if `explain`, the verdict-first `set` and `show`. Every run names fixture files: the in-process runner REFUSES an argv
// without `--state-dir`, so no test here can fall through to the real ~/.llmkeys or state/. A no-touch guard fingerprints the real ~/.llmkeys, state/subagent and
// service.json (and hashes bench, the catalogue snapshot and Claude's settings) before and after the whole file; guardRealState records any fs call under the real state folder.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { fixtureFlags, fixtureFlagMap } from "./fixtures/subagent-flags.mjs";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import * as lib from "../keysync/subagent-policy.mjs";
import { verdict, verdictLine, deltaText, STATES, SILENT_MS } from "../menu/subagent-verdict.mjs";
import { CODES, codeRow, CLI, KINDS, degradingCodes, NO_FIX } from "../menu/subagent-codes.mjs";
import { PRESETS, runWizard, presetListText, flagsText, ttyAsker } from "../keysync/subagent-wizard.mjs";

guardRealState(after, assert);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(ROOT, "keysync", "key.mjs");
// every directory this file makes is removed after the run (it used to leave one `uw-ux-*` folder per call behind); only a folder this file made, by its own prefix and parent, is ever removed
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-ux-")); made.push(d); return d; };
after(() => {
  for (const d of made) if (path.dirname(d) === os.tmpdir() && path.basename(d).startsWith("uw-ux-")) fs.rmSync(d, { recursive: true, force: true });
});
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const wr = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o)); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

// ---- no-touch guard: guardRealState records ANY fs call under the real ~/.uw/state during this file; the one child process (the wizard without a terminal) runs against a
// sentinel HOME whose bytes are compared before and after. (The real ~/.llmkeys is never named by any argv: the in-process runner refuses an argv without a fixture --state-dir.)
// ---- fixtures
function setup() {
  const dir = tmp();
  const F = fixtureFlags(dir), m = fixtureFlagMap(dir);
  return { dir, F, m, owner: m["policy-file"], root: m["state-dir"], state: path.join(m["state-dir"], "subagent"), compiled: path.join(m["state-dir"], "subagent", "policy.json"),
    flag: path.join(m["state-dir"], "subagent", "shadow.flag"), prev: `${m["policy-file"]}.prev`, P: ["--policy-file", m["policy-file"], "--state-dir", m["state-dir"]] };
}
/** In-process run: refuses an argv that does not name a fixture state folder, so a real file can never be reached. */
async function run(argv, opts = {}) {
  assert.ok(argv.includes("--state-dir") || argv[0] === "why", "every in-process run names a fixture --state-dir (`why` reads no file at all)");
  const out = [], err = [];
  const status = await lib.runSubagentPolicy(argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {}, opts);
  return { status, out: out.join("\n"), err: err.join("\n"), first: err[0] ?? out[0] ?? "", lines: out };
}
const SET = (s, ...a) => run(["set", ...a, ...s.F]);
const SHOW = (s, ...a) => run(["show", ...a, ...s.F]);
const STATUS = (s, ...a) => run(["status", ...a, ...s.F]);
const FREE = ["--source", "all-providers", "--mode", "free", "--free-scope", "providers"];
const DYN = ["--source", "all-providers", "--mode", "dynamic"];
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const dirHash = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex"); } };
  walk(dir);
  return out;
};
const status = (s, over = {}, name = "status-abc.json") => wr(path.join(s.state, name), { schema: 1, updatedAt: new Date().toISOString(), since: new Date(Date.now() - 3600000).toISOString(), pid: process.pid, routerVersion: 2,
  policy: { state: "ok", contentHash: rd(s.compiled).contentHash, enforcement: "shadow", inject: "off", rollbackFlag: false }, counters: { req: 40, main: 30, sub: 9, aux: 1 }, warnings: [], ...over });
const INTERNAL_ID = /\b(?:D-[a-z]{1,2}|cr-[A-Za-z0-9]+|R-v2-\d+|ar-\d+|n:1|I\d{2}|QB-\d+)\b/;

// =====================================================================================================================
// 1. the pure verdict
// =====================================================================================================================
const OWNER = { schema: 1, source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", allow: [], classLog: "on", banded: true, handoffNotice: true };
const COMPILED = { schema: 1, contentHash: "abc123abc123", compiledAt: new Date(NOW - 2 * 3600000).toISOString(), empty: false, owner: { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", banded: true }, counts: {}, models: [], lists: {} };
const FRESH = { ...COMPILED, compiledAt: new Date(NOW - 60000).toISOString() };
const OLD = { ...COMPILED, compiledAt: new Date(NOW - 72 * 3600000).toISOString() };
const STATUS_OK = (over = {}) => ({ updatedAt: new Date(NOW - 60000).toISOString(), policy: { contentHash: "abc123abc123" }, warnings: [], ...over });
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v); return Object.freeze(o); };

test("verdict: every state is reachable from fixture inputs and carries one plain sentence and one fix command", () => {
  const cases = [
    ["OFF", null, null, null, false],
    ["SAVED-NOT-COMPILED", OWNER, null, null, false],
    ["SAVED-NOT-COMPILED", { ...OWNER, mode: "free" }, COMPILED, STATUS_OK(), false],          // the owner file moved on after the last compile
    ["NOT-WIRED", OWNER, COMPILED, null, false],                                              // compiled 2 h ago and no router has ever reported
    ["NOT-WIRED", OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "0ther0ther00" } }), false],   // the router ran for an hour after the compile and still reports another copy
    ["WAITING", OWNER, FRESH, null, false],                                                   // saved a minute ago, no request yet
    ["WAITING", OWNER, COMPILED, STATUS_OK({ updatedAt: new Date(NOW - 3 * 3600000).toISOString(), policy: { contentHash: "0ther0ther00" } }), false],   // a report from before this save
    ["IDLE", OWNER, OLD, STATUS_OK({ updatedAt: new Date(NOW - 26 * 3600000).toISOString() }), false],
    ["SHADOW", OWNER, COMPILED, STATUS_OK(), false],
    ["ENFORCING", { ...OWNER, enforcement: "enforce" }, { ...COMPILED, owner: { ...COMPILED.owner, enforcement: "enforce" } }, STATUS_OK(), false],
    ["PAUSED", OWNER, COMPILED, STATUS_OK(), "2026-10-05T10:00:00.000Z"],
    ["PAUSED", null, null, null, true],                                                      // a pause with no saved policy is still a pause
    ["DEGRADED", OWNER, COMPILED, STATUS_OK(), "auto:ERRORS:2026-10-05T10:00:00.000Z"],
    ["DEGRADED", OWNER, { ...COMPILED, empty: true }, STATUS_OK(), false],
    ["DEGRADED", OWNER, COMPILED, STATUS_OK({ warnings: [{ code: "POLICY_NEWER" }] }), false],
    ["DEGRADED", { ...OWNER, enforcement: "enforce" }, { ...COMPILED, gate: { code: "CLASSIFIER_UNMEASURED" }, owner: { ...COMPILED.owner, enforcement: "shadow" } }, STATUS_OK(), false],
  ];
  const seen = new Set();
  for (const [want, o, c, st, fl] of cases) {
    const v = verdict(o, c, st, fl, NOW);
    assert.equal(v.state, want, JSON.stringify([want, v]));
    seen.add(v.state);
    assert.ok(v.sentence.length > 20 && !/\n/.test(v.sentence), `${v.label}: one sentence`);
    assert.ok(/^(node |start |check |remove |run )/.test(v.fix) || v.fix.startsWith(CLI), `${v.label}: one fix command, found ${v.fix}`);
    assert.doesNotMatch(v.sentence + v.fix, INTERNAL_ID, "no internal id in a verdict");
    assert.equal(verdictLine(v).split(":")[0], v.state === "DEGRADED" ? v.label : v.state);
  }
  assert.deepEqual([...seen].sort(), [...STATES].sort(), "all nine states were produced");
  assert.equal(verdict(OWNER, { ...COMPILED, empty: true }, STATUS_OK(), false, NOW).code, "EMPTY_SET");
  assert.equal(verdict(OWNER, COMPILED, STATUS_OK({ warnings: [{ code: "POLICY_NEWER" }] }), false, NOW).label, "DEGRADED(POLICY_NEWER)");
});

test("verdict: the word stays SHADOW and says it logs what it would do and changes nothing; the router's own headline wins when present", () => {
  const v = verdict(OWNER, COMPILED, STATUS_OK(), false, NOW);
  assert.match(v.sentence, /logs what it would do and changes nothing/);
  const h = verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "abc123abc123", enforcement: "shadow", headline: "logs what it would do, changes nothing (14 agents so far)" } }), false, NOW);
  assert.equal(h.sentence, "logs what it would do, changes nothing (14 agents so far)");
  assert.equal(h.headline, h.sentence);
  const dirty = verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "abc123abc123", enforcement: "shadow", headline: "ok\u001b[31m\u202e bad" } }), false, NOW);
  assert.ok(!/[\u0000-\u001f\u202e]/.test(dirty.sentence), "router-written text is made printable");
  assert.equal(verdict(OWNER, COMPILED, STATUS_OK(), false, NOW).fix, `${CLI} last`);
});

test("verdict: it is pure (inputs may be frozen and are never changed, the same inputs give the same answer) and a PAUSE outranks everything but is never hidden by a stale compile", () => {
  const inputs = deepFreeze(JSON.parse(JSON.stringify([OWNER, COMPILED, STATUS_OK(), false])));
  const a = verdict(...inputs, NOW), b = verdict(...inputs, NOW);
  assert.deepEqual(a, b);
  assert.deepEqual(inputs, JSON.parse(JSON.stringify([OWNER, COMPILED, STATUS_OK(), false])), "inputs untouched");
  assert.equal(verdict({ ...OWNER, mode: "free" }, COMPILED, STATUS_OK(), "2026-10-05T10:00:00.000Z", NOW).state, "PAUSED");
  assert.doesNotMatch(read("menu/subagent-verdict.mjs"), /node:fs|node:os|Date\.now\(|process\./, "the verdict module has no I/O and no clock");
  // an enforcing policy whose router reports a degrading warning is DEGRADED, not ENFORCING
  assert.equal(verdict({ ...OWNER, enforcement: "enforce" }, { ...COMPILED, owner: { ...COMPILED.owner, enforcement: "enforce" } }, STATUS_OK({ warnings: [{ code: "ROUTER_ERROR" }] }), false, NOW).state, "DEGRADED");
  // a warning that does not degrade (COOLING) leaves SHADOW alone
  assert.equal(verdict(OWNER, COMPILED, STATUS_OK({ warnings: [{ code: "COOLING" }] }), false, NOW).state, "SHADOW");
});

test("verdict: show, status and set print the SAME first line for every real state of a fixture (one function feeds them all)", async () => {
  const s = setup();
  const first = async () => [(await STATUS(s)).lines[0], (await SHOW(s)).lines[0]];
  // OFF
  let [a, b] = await first(); assert.match(a, /^OFF: /); assert.equal(a, b);
  // WAITING then SHADOW (a router status that matches the compiled hash)
  const set = await SET(s, ...DYN); assert.equal(set.status, 0, set.err);
  [a, b] = await first(); assert.match(a, /^WAITING: /); assert.equal(a, b);
  assert.equal(set.lines[0], "SAVED: saved and compiled; the router uses it from its next request.", "a set on a not-yet-reported compile says SAVED (the same state status calls WAITING)");
  status(s);
  [a, b] = await first(); assert.match(a, /^SHADOW: /); assert.equal(a, b);
  // DEGRADED from a router warning
  status(s, { warnings: [{ code: "POLICY_NEWER", since: new Date().toISOString() }] });
  [a, b] = await first(); assert.match(a, /^DEGRADED\(POLICY_NEWER\): /); assert.equal(a, b);
  status(s);
  // SAVED-NOT-COMPILED (compiled file removed)
  fs.rmSync(s.compiled);
  [a, b] = await first(); assert.match(a, /^SAVED-NOT-COMPILED: /); assert.equal(a, b);
  assert.equal((await run(["rebuild", "--quiet", "yes", ...s.F])).status, 0);
  // ENFORCING (both files say enforce: the CLI itself would refuse to compile this without live providers and a classifier record, which is the point of the gate)
  const o = rd(s.owner), c = rd(s.compiled); o.enforcement = "enforce"; c.owner.enforcement = "enforce"; wr(s.owner, o); wr(s.compiled, c); status(s);
  [a, b] = await first(); assert.match(a, /^ENFORCING: /); assert.equal(a, b);
  // PAUSED
  assert.equal((await run(["pause", ...s.P])).status, 0);
  [a, b] = await first(); assert.match(a, /^PAUSED: /); assert.equal(a, b);
});

test("verdict: the fix command printed for every state is a command the CLI accepts (parses on the fixture flags), or the doctor", async () => {
  const s = setup();
  const checkFix = async () => {
    const r = await STATUS(s);
    const m = /^next: (.*)$/m.exec(r.out);
    assert.ok(m, r.out);
    const cmd = m[1];
    if (cmd.startsWith("node harness/")) return cmd;                                             // a printed hint (the deploy plan): no flags to parse
    assert.ok(cmd.startsWith(`${CLI} `), cmd);
    const args = cmd.slice(CLI.length + 1).split(" ").filter((x) => x !== "--live" && x !== "yes");      // a fixture run needs no --live; the real run does, and parseArgs checks that elsewhere
    assert.doesNotThrow(() => lib.parseArgs([...args, ...(["rebuild", "resume", "undo", "preset", "wizard"].includes(args[0]) ? s.F : args[0] === "pause" ? s.P : args[0] === "last" ? ["--state-dir", s.root] : s.F)]), cmd);
    return cmd;
  };
  assert.match(await checkFix(), /preset/);                                                    // OFF
  await SET(s, ...DYN); assert.match(await checkFix(), /status$/);                             // WAITING
  status(s); assert.match(await checkFix(), /last/);                                           // SHADOW
  fs.rmSync(s.compiled); assert.match(await checkFix(), /rebuild/);                            // SAVED-NOT-COMPILED
  await run(["rebuild", "--quiet", "yes", ...s.F]);
  await run(["pause", ...s.P]); assert.match(await checkFix(), /resume/);                      // PAUSED
  status(s, { warnings: [{ code: "POLICY_NEWER" }] }); fs.rmSync(s.flag);                      // DEGRADED
  assert.match(await checkFix(), /deploy-router/);
});

test("verdict: delta text (pure): toggles that changed, eligible and provider counts with their denominator, first-policy and unchanged forms", () => {
  const T = (o = {}) => ({ source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", allow: [], ...o });
  assert.equal(deltaText({ toggles: T(), eligible: 14, providers: 5 }, { toggles: T({ mode: "free" }), eligible: 7, providers: 2 }, 6),
    "mode dynamic -> free; eligible 14 -> 7 models, 5 -> 2 providers (of 6 providers in the gateway's provider list)", "the denominator is the providers (the model count is a share of the chosen scope on the ALLOWED line)");
  assert.equal(deltaText(null, { toggles: T(), eligible: 14, providers: 5 }, 6), "new policy: eligible 14 models on 5 providers (of 6 providers in the gateway's provider list)");
  assert.equal(deltaText(null, { toggles: T({ mode: "inherit" }), eligible: null, providers: null }, 6), "new policy: every subagent follows main (no model list)", "no 'eligible every subagent' sentence");
  assert.equal(deltaText({ toggles: T(), eligible: 14, providers: 5 }, { toggles: T(), eligible: 14, providers: 5 }, 6), "no toggle changed; eligible 14 models on 5 providers, unchanged (of 6 providers in the gateway's provider list)");
  assert.equal(deltaText(null, { toggles: T(), eligible: 1, providers: 1 }, 1), "new policy: eligible 1 model on 1 provider (of 1 provider in the gateway's provider list)", "singular forms");
  assert.match(deltaText({ toggles: T(), eligible: 14, providers: 5 }, { toggles: T({ ctx: "1m", enforcement: "enforce" }), eligible: 1, providers: 1 }, 18), /^ctx any -> 1m, enforcement shadow -> enforce; eligible 14 -> 1 models, 5 -> 1 providers/);
  assert.match(deltaText({ toggles: T(), eligible: 14, providers: 5 }, { toggles: T({ mode: "inherit" }), eligible: null, providers: null }, 18), /^mode dynamic -> inherit; eligible: 14 models on 5 providers -> every subagent follows main/);
  assert.match(deltaText({ toggles: T(), eligible: 14, providers: 5 }, { toggles: T({ banded: false, allow: ["a/b"] }), eligible: 14, providers: 5 }), /banded yes -> no, pinned models 0 -> 1/);
  assert.equal(deltaText({ toggles: T() }, { toggles: T({ mode: "free" }) }), "mode dynamic -> free", "without counts the counts are left out, never guessed");
});

// =====================================================================================================================
// 2. verdict-first set and show, the delta line, the funnel behind --detail
// =====================================================================================================================
test("set: verdict first, then the next step, the delta line and the policy; the funnel and the raw warnings only with --detail yes", async () => {
  const s = setup();
  const a = await SET(s, ...DYN); assert.equal(a.status, 0, a.err);
  assert.equal(a.lines[0], "SAVED: saved and compiled; the router uses it from its next request.", "F1: a successful set never opens with NOT-WIRED");
  assert.equal(a.lines[1], "next: node keysync/key.mjs subagent-policy status", "F1: the next step is status, never the doctor (it has no subagent check yet)");
  assert.equal(a.lines[2], "change: new policy: eligible 14 models on 5 providers (of 6 providers in the gateway's provider list)");
  assert.match(a.lines[3], /^policy: mode dynamic, source all-providers, ctx any, enforcement shadow$/);
  assert.match(a.out, /^ALLOWED: 14 models \(of 14 in the chosen scope; verified 3, small 0, unverified 11\)$/m);
  assert.match(a.out, /^SUBSTITUTABLE: 10 of 14 allowed/m);
  assert.doesNotMatch(a.out, /chat-capable, not pool row|funnel \(denominator|^FRAGILE:|^UNVERIFIED:/m, "the raw funnel and raw warnings are behind --detail yes");
  assert.match(a.out, /HELPER CALLS: free governs subagents with tools/, "the helper-call sentence stays on every set");
  const b = await SET(s, ...FREE);
  assert.equal(b.lines[2], "change: mode dynamic -> free; eligible 14 -> 7 models, 5 -> 2 providers (of 6 providers in the gateway's provider list)", "the delta compares what the old policy gives today with the new one");
  const d = await SET(s, ...FREE, "--detail", "yes", "--dry", "yes");
  assert.match(d.out, /funnel \(denominator = 18 snapshot routes/); assert.match(d.out, /^FREE PROMISE: /m);
  assert.match(d.lines[0], /^PREVIEW \(nothing is saved\)\. SHADOW: logs what it would do and changes nothing; subagents still run exactly as they ask\.$/, "a preview is judged as if the router had picked it up, so it says what the choice does");
  assert.match(d.lines[1], /^to save this: node keysync\/key\.mjs subagent-policy set --source all-providers --mode free --free-scope providers --ctx any$/);
  // U3: one 'nothing saved' sentence and ONE save command per preview
  const dry = await SET(s, ...DYN, "--dry", "yes");
  assert.equal(dry.lines.filter((l) => /nothing is saved|nothing written|was saved/i.test(l)).length, 1, dry.out);
  assert.equal(dry.lines.filter((l) => /(^|\s)(to save|save it)/i.test(l)).length, 1, dry.out);
  assert.doesNotMatch(dry.out, /\(dry run: nothing written\)/);
});

test("set: advisories are collapsed into counted plain-words lines with their denominators (eligible, usable, THIN, FREE NOT GUARANTEED, $15+/M output, N of M not tool-tested); --detail yes lists them all", async () => {
  const s = setup();
  const f = await SET(s, ...FREE, "--dry", "yes", "--detail", "yes");
  assert.match(f.out, /^needs attention \(\d+\):$/m);
  assert.match(f.out, /^  - 7 of 7 eligible models are not tool-tested/m);
  // U2: the verb follows the first number (1 of 2 providers HAS, 2 of 2 providers HAVE)
  assert.match(f.out, /^  - FREE NOT GUARANTEED: 1 of 2 providers has fewer than 3 usable models; when no free model fits a request, the model it asked for \(possibly paid\) runs it$/m);
  assert.match(f.out, /^  - 1 of 2 providers has eligible models but none usable as a stand-in/m);
  assert.match(f.out, /^  - 1 of 7 eligible models has a price; on a free key/m);
  const one = await SET(s, ...FREE, "--free-scope", "models", "--ctx", "1m", "--dry", "yes", "--detail", "yes");
  assert.match(one.out, /^  - THIN: only 1 usable model for all providers; a fan-out of subagents lands on those few$/m);
  assert.match(one.out, /^  - 1 of 1 eligible models is not tool-tested/m, "U2: 1 of 1 models IS not tool-tested");
  const dyn = await SET(s, ...DYN, "--dry", "yes", "--detail", "yes");
  assert.match(dyn.out, /^  - \d+ of 14 eligible models (cost|costs) \$15\+\/M output$/m);
  assert.match(dyn.out, /^  - 11 of 14 eligible models are not tool-tested/m);
  for (const r of [f, one, dyn]) { const att = r.lines.filter((l) => /^  - /.test(l)).join("\n"); assert.doesNotMatch(att, INTERNAL_ID, "no plan id in an advisory line"); assert.doesNotMatch(att, /\(D-|cr-m|cr-M/); }
  // every count in an attention line is "N of M" (a denominator travels with it)
  for (const l of f.lines.filter((x) => /^  - /.test(x))) if (/^  - \d+ /.test(l)) assert.match(l, /^  - \d+ of \d+ /, l);
  // U4: the account-state line names its population (the models in the gateway's provider list), never an undefined "selectors"
  assert.doesNotMatch(f.out, /selectors are left out|selector is left out/);
});

test("set (D6, U1): a default preview shows at most the TOP 3 needs-attention lines by severity, then (+N more: --detail yes); --detail yes shows them all in the same order", async () => {
  const s = setup();
  const r = await SET(s, ...FREE, "--dry", "yes");
  const shown = r.lines.filter((l) => /^  - /.test(l));
  assert.equal(shown.length, 3, r.out);
  const total = Number(/^needs attention \((\d+)\):$/m.exec(r.out)[1]);
  assert.ok(total > 3, "the fixture has more than three advisories");
  assert.ok(r.lines.includes(`  (+${total - 3} more: --detail yes)`), r.out);
  // severity 1 first: the router will not do what you expect (FREE NOT GUARANTEED), then tool-test status; informational lines never outrank those
  assert.match(shown[0], /^  - (FREE NOT GUARANTEED|THIN|\d+ of \d+ providers? ha(s|ve) eligible models but none usable)/);
  const all = (await SET(s, ...FREE, "--dry", "yes", "--detail", "yes")).lines.filter((l) => /^  - /.test(l));
  assert.equal(all.length, total, "--detail yes lists every one");
  assert.deepEqual(all.slice(0, 3), shown, "the top 3 are the first 3 of the full list");
  const rank = (l) => (/^  - (FREE NOT GUARANTEED|THIN|\d+ of \d+ providers? ha(s|ve) eligible models but none usable|the context floor)/.test(l) ? 1 : /costs?|price|credit/.test(l) ? 2 : /tool-tested/.test(l) ? 3 : 4);
  assert.deepEqual(all.map(rank), [...all.map(rank)].sort((a, b) => a - b), "severity never goes back down");
  const none = await SET(s, "--mode", "inherit", "--dry", "yes");
  assert.doesNotMatch(none.out, /more: --detail yes\)/, "no '+N more' when nothing was cut");
});

test("show: verdict first, the last-change delta when an undo generation exists, the free-scope funnel only with --detail yes, plain not-tool-tested line", async () => {
  const s = setup();
  assert.match((await SHOW(s)).lines[0], /^OFF: /);
  await SET(s, ...DYN); await SET(s, ...FREE);
  const r = await SHOW(s);
  assert.match(r.lines[0], /^WAITING: /); assert.match(r.lines[1], /^next: /);
  assert.match(r.lines[2], /^last change \(`node keysync\/key\.mjs subagent-policy undo --live yes` goes back\): mode dynamic -> free$/);
  assert.doesNotMatch(r.out, /free-scope funnel/); assert.match((await SHOW(s, "--detail", "yes")).out, /free-scope funnel/);
  assert.match(r.out, /^7 of 7 eligible models are not tool-tested/m);
  assert.match(r.out, /HELPER CALLS: free governs subagents with tools/);
  assert.doesNotMatch(r.out, INTERNAL_ID); assert.doesNotMatch(r.out, /\(D-[a-z]\)/);
  // U5: the technical fields are behind --detail yes, and show and status print `policy:` in the SAME format
  assert.doesNotMatch(r.out, /providersLive|contentHash|compiler 2|inject off/, "no internal field in the default view");
  const det = await SHOW(s, "--detail", "yes");
  for (const needle of [/providersLive false/, /contentHash [0-9a-f]{12}/, /compiler 2/, /inject off/]) assert.match(det.out, needle);
  const pol = (x) => /^policy: (.*)$/m.exec(x)[1];
  assert.equal(pol(r.out), "mode free (free providers), source all-providers, ctx any, enforcement shadow");
  assert.equal(pol(r.out), pol((await STATUS(s)).out), "show and status say the same policy line");
  // U4: show's sub-counts carry their denominators
  assert.match(r.out, /^compiled: \S+ ago; 7 eligible models of 18 snapshot routes \(verified 0 of 7, small 0 of 7, unverified 7 of 7, premium \d+ of 7, alias \d+ of 7\)$/m);
  assert.match(r.out, /providers with no usable stand-in: .* \(\d+ of \d+\); thin, fewer than 3 usable: .* \(\d+ of \d+\)/);
});

// =====================================================================================================================
// 3. status
// =====================================================================================================================
test("status: the verdict, the one fix, the policy, what was compiled and what the router reported, with plain warning lines from the code table (plain + fix)", async () => {
  const s = setup();
  await SET(s, ...FREE);
  status(s, { warnings: [{ code: "COOLING", since: new Date().toISOString(), detail: "1 model cooling" }, { code: "TOTALLY_NEW", since: new Date().toISOString() }] });
  const r = await STATUS(s);
  assert.equal(r.status, 0, r.err);
  assert.match(r.lines[0], /^SHADOW: /);
  assert.match(r.out, /^policy: mode free \(free providers\), source all-providers, ctx any, enforcement shadow$/m);
  assert.match(r.out, /^compiled: .* ago, 7 eligible models of 18 snapshot routes \(7 of 7 not tool-tested\)$/m);
  assert.match(r.out, /^router: last seen .* ago; 9 subagent requests of 40 requests since /m);
  const c = codeRow("COOLING");
  assert.ok(r.out.includes(`warning COOLING: ${c.plain} (1 model cooling)`), r.out);
  assert.ok(r.out.includes(`warning   fix: ${c.fix}`), "the fix command comes from the same table row");
  assert.match(r.out, /warning TOTALLY_NEW: a code this version does not know/);
  assert.doesNotMatch(r.out, INTERNAL_ID);
});

test("status: answers in under 1 s on fixtures (QB-6) and reads nothing but the fixture files", async () => {
  const s = setup();
  await SET(s, ...DYN); status(s);
  const before = dirHash(s.dir);
  const t0 = process.hrtime.bigint();
  const r = await STATUS(s);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(r.status, 0);
  assert.ok(ms < 1000, `status took ${ms.toFixed(0)} ms`);
  assert.deepEqual(dirHash(s.dir), before, "status writes nothing");
});

// =====================================================================================================================
// 4. last
// =====================================================================================================================
function writeLog(s) {
  const L = (o) => JSON.stringify(o);
  // the router's agents.jsonl v2 line (router logAgent): no `role`, no sticky marker (those live in decisions.jsonl); a handoff line adds from, to, hop, rsrc, reason, aid_full
  const base = { v: 2, w: "a", sid: "s1aaaaaa", pid8: null, tag: null, main: "anthropic/claude-sonnet-5-5", ph: "abc", tc: 1000, ms: 0.3 };
  const cur = [
    L({ ...base, t: "2026-10-05T11:00:00.000Z", aid: "agent-1", asked: "anthropic/claude-sonnet-5", act: "substitute", would: "fx-free-a/fxa-alpha", ret: "anthropic/claude-sonnet-5", why: "not-in-set", pol: "shadow", flags: [], path: "new" }),
    L({ ...base, t: "2026-10-05T11:10:00.000Z", aid: "agent-2", asked: "anthropic/claude-haiku-4-5", act: "substitute", would: "fx-free-a/fxa-beta", ret: "fx-free-a/fxa-beta", why: "not-in-set", pol: "enforce", flags: ["FRAGILE_SET"], path: "new" }),
    "{\"t\":\"nope\"}",                                                                       // a line with no usable time: unreadable
    L({ ...base, t: "2026-10-05T11:30:00.000Z", aid: "agent-2", asked: "anthropic/claude-haiku-4-5", act: "handoff", from: "fx-free-a/fxa-beta", to: "fx-free-a/fxa-gamma", hop: 1, rsrc: "len", reason: "retry:len:2", aid_full: "agent-2", would: "fx-free-a/fxa-gamma", ret: "fx-free-a/fxa-gamma", why: "retry:len:2", pol: "enforce", flags: [], path: "handoff" }),
    L({ ...base, t: "2026-10-05T11:45:00.000Z", sid: "s2bbbbbb", aid: "agent-9", asked: "evil\u001b[31m/x\u202e", act: "substitute", would: "fx-free-a/fxa-alpha", ret: "evil\u001b[31m/x\u202e", why: "not-in-set", pol: "shadow", flags: [], path: "new" }),
    L({ ...base, t: "2026-10-05T11:50:00.000Z", aid: "agent-3", asked: "anthropic/claude-haiku-4-5", act: "keep", would: null, ret: "anthropic/claude-haiku-4-5", why: null, pol: "shadow", flags: [], path: "new" }),
    "{\"v\":2,\"t\":\"2026-10-05T11:55",                                                      // a torn last line
  ];
  fs.mkdirSync(s.state, { recursive: true });
  fs.writeFileSync(path.join(s.state, "agents.jsonl"), cur.join("\n"));
  fs.writeFileSync(path.join(s.state, "agents.1.jsonl"), L({ ...base, t: "2026-10-04T10:00:00.000Z", sid: "s0old", aid: "agent-0", asked: "anthropic/claude-sonnet-5", act: "substitute", would: "fx-free-a/fxa-alpha", ret: "anthropic/claude-sonnet-5", why: "not-in-set", pol: "shadow", flags: [], path: "new" }) + "\n");
}
const LAST = (s, ...a) => run(["last", ...a, "--state-dir", s.root], { now: NOW });
// U8: `last` prints LOCAL time with an "ago" suffix (the UTC ISO time is in --json only)
const pad2 = (v) => String(v).padStart(2, "0");
const agoOf = (ms) => { const sec = Math.round(ms / 1000); return sec < 120 ? `${sec}s` : sec < 7200 ? `${Math.round(sec / 60)}m` : sec < 172800 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`; };
const when = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} (${agoOf(NOW - d.getTime())} ago)`; };

test("last: human lines (local time and ago, asked, ran, policy says/would, flags), rotated files, torn and unreadable lines skipped and counted, control characters made printable", async () => {
  const s = setup(); writeLog(s);
  const r = await LAST(s, "50");
  assert.equal(r.status, 0, r.err);
  assert.match(r.lines[0], /^last 6 of 6 agent decisions:$/);
  assert.ok(r.lines.includes(`${when("2026-10-04T10:00:00.000Z")}  asked anthropic/claude-sonnet-5  ran anthropic/claude-sonnet-5  policy would use fx-free-a/fxa-alpha  because not-in-set`), "the rotated file is read; shadow: ran equals asked, the policy would use another");
  assert.ok(r.lines.includes(`${when("2026-10-05T11:10:00.000Z")}  asked anthropic/claude-haiku-4-5  ran fx-free-a/fxa-beta  policy chose fx-free-a/fxa-beta  because not-in-set  [FRAGILE_SET]`), "enforce: ran is what the router returned");
  assert.ok(r.lines.includes(`${when("2026-10-05T11:30:00.000Z")}  ${lib.formatHandoff({ from: "fx-free-a/fxa-beta", to: "fx-free-a/fxa-gamma", reason: "retry:len:2", hop: 1 })} (enforce)`), "a handoff line is the formatHandoff text and says which mode it was logged in");
  assert.ok(r.lines.includes(`${when("2026-10-05T11:50:00.000Z")}  asked anthropic/claude-haiku-4-5  ran anthropic/claude-haiku-4-5  no policy choice`), "a keep line");
  assert.doesNotMatch(r.out, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ|  (sub|aux|main)  |helper call: never rewritten|sticky: kept/m, "no UTC 'Z' time, and no dead class or sticky column");
  assert.ok(!r.out.includes("\u001b") && !r.out.includes("\u202e"), "control and bidi characters never reach the terminal");
  assert.match(r.out, /asked evil\?\[31m\/x\?/);
  const sum = r.out.slice(r.out.indexOf("summary"));
  assert.match(sum, /^summary \(of 5 decisions shown, plus 1 handoff; 3 sessions in the window; 2 unreadable lines skipped\):/);
  assert.match(sum, /^  ran on: anthropic 3, evil\?\[31m 1, fx-free-a 1 \(of 5\)$/m);
  assert.match(sum, /^  policy would use \/ chose: fx-free-a 4 \(of 4 with a policy choice\)$/m);
  assert.match(sum, /  moved to another model: 4 of 5; unchanged: 1 of 5 \(shadow mode only logs: nothing was actually changed\)/);
  assert.match(sum, /Claude Code's transcript shows the model that was REQUESTED, not the one that served the request/);
  assert.doesNotMatch(r.out, INTERNAL_ID);
});

test("last [N] and --since: the newest N in time order; a window drops older lines and says so in every denominator", async () => {
  const s = setup(); writeLog(s);
  const two = await LAST(s, "2");
  assert.match(two.lines[0], /^last 2 of 6 agent decisions:$/);
  assert.equal(two.lines.filter((l) => /^2026-/.test(l)).length, 2);
  const day = await LAST(s, "--since", "24h");
  assert.match(day.lines[0], /^last 5 of 5 agent decisions in the last 24h:$/, "the 26 h old rotated line is outside the window");
  const week = await LAST(s, "--since", "7d");
  assert.match(week.lines[0], /^last 6 of 6 agent decisions in the last 7d:$/);
  const none = await LAST(s, "--since", "5m");
  assert.match(none.out, /^no agent decisions to show in the last 5m \(read 2 log file\(s\) in .*; 6 decisions in all, 2 unreadable lines skipped\)/);
  for (const bad of [["0"], ["1000"], ["abc"], ["--since", "2"], ["--since", "h"], ["--since", "1w"], ["5", "6"]]) assert.equal((await LAST(s, ...bad)).status, 1, bad.join(" "));
  const empty = setup();
  assert.match((await LAST(empty)).out, /^no agent decisions to show \(read 0 log file\(s\)/);
});

test("last --json yes (F10): the frozen schema in a fixed key order with the router's real fields: no dead `class` or `sticky`, a `mode` (shadow|enforce as logged) and structured from/to/hop on a handoff; ISO UTC times; golden bytes", async () => {
  const s = setup(); writeLog(s);
  const r = await LAST(s, "3", "--json", "yes");
  assert.equal(r.status, 0, r.err);
  assert.equal(r.lines.length, 1);
  assert.ok(!/\u001b/.test(r.out));
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ["schema", "kind", "window", "denominators", "lines"]);
  assert.deepEqual(Object.keys(j.window), ["since", "until", "limit"]);
  assert.deepEqual(Object.keys(j.denominators), ["agentLines", "shown", "sessions", "unreadableLines", "filesRead"]);
  for (const l of j.lines) { assert.deepEqual(Object.keys(l), ["t", "sid", "aid", "act", "asked", "ran", "would", "why", "flags", "handoff", "from", "to", "hop", "moved", "mode", "path"]); assert.match(l.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); }
  const golden = { schema: 1, kind: "last", window: { since: null, until: "2026-10-05T12:00:00.000Z", limit: 3 }, denominators: { agentLines: 6, shown: 3, sessions: 3, unreadableLines: 2, filesRead: 2 },
    lines: [
      { t: "2026-10-05T11:30:00.000Z", sid: "s1aaaaaa", aid: "agent-2", act: "handoff", asked: "anthropic/claude-haiku-4-5", ran: "fx-free-a/fxa-gamma", would: "fx-free-a/fxa-gamma", why: "retry:len:2", flags: [],
        handoff: "HANDOFF fx-free-a/fxa-beta -> fx-free-a/fxa-gamma (retry 2, hop 1)", from: "fx-free-a/fxa-beta", to: "fx-free-a/fxa-gamma", hop: 1, moved: null, mode: "enforce", path: "handoff" },
      { t: "2026-10-05T11:45:00.000Z", sid: "s2bbbbbb", aid: "agent-9", act: "substitute", asked: "evil?[31m/x?", ran: "evil?[31m/x?", would: "fx-free-a/fxa-alpha", why: "not-in-set", flags: [],
        handoff: null, from: null, to: null, hop: null, moved: true, mode: "shadow", path: "new" },
      { t: "2026-10-05T11:50:00.000Z", sid: "s1aaaaaa", aid: "agent-3", act: "keep", asked: "anthropic/claude-haiku-4-5", ran: "anthropic/claude-haiku-4-5", would: null, why: null, flags: [],
        handoff: null, from: null, to: null, hop: null, moved: false, mode: "shadow", path: "new" },
    ] };
  assert.equal(r.out, JSON.stringify(golden), "byte-for-byte golden");
  const w = JSON.parse((await LAST(s, "--since", "24h", "--json", "yes")).out);
  assert.equal(w.window.since, "2026-10-04T12:00:00.000Z"); assert.equal(w.window.limit, 20); assert.equal(w.denominators.agentLines, 5);
  // the JSON tells shadow from enforce for every moved line (a `moved: true` alone never did)
  const all = JSON.parse((await LAST(s, "50", "--json", "yes")).out).lines;
  assert.deepEqual(all.filter((l) => l.moved === true).map((l) => l.mode).sort(), ["enforce", "shadow", "shadow", "shadow"]);
});

// =====================================================================================================================
// 5. preset
// =====================================================================================================================
test("preset: with no name it lists the five with live counts from the shared funnel (equal to what set prints); nothing is written", async () => {
  const s = setup();
  const before = dirHash(s.dir);
  const r = await run(["preset", ...s.F]);
  assert.equal(r.status, 0, r.err);
  for (const k of ["follow-main", "any", "free", "free-wide", "free-1m"]) assert.ok(new RegExp(`^  ${k.padEnd(11)}  `, "m").test(r.out), k);
  assert.match(r.out, /denominator = 18 snapshot routes/);
  assert.match(r.out, /follow-main .*\(no list: every subagent follows main\)/);
  assert.match(r.out, /eligible 14 models on 5 of 6 providers, usable 10 of 14/);
  assert.match(r.out, /^  free  +free models only: the models tagged free +eligible 5 models on 3 of 6 providers, usable 4 of 5$/m, "D3: `free` is the NARROW set");
  assert.match(r.out, /^  free-wide  .*eligible 7 models on 2 of 6 providers, usable 3 of 7$/m, "D3: `free-wide` is every model on a free-labelled provider");
  assert.match(r.out, /eligible 1 model on 1 of 6 providers, usable 1 of 1/);
  // U5: eligible and usable are defined once, here
  assert.match(r.out, /^eligible = passes your choices; usable = a known context of at least 128,000, so it can stand in for a subagent\.$/m);
  // the same counts the set preview of that preset prints (one funnel)
  for (const [k, re] of [["any", /^ALLOWED: 14 models/m], ["free", /^ALLOWED: 5 models/m], ["free-wide", /^ALLOWED: 7 models/m], ["free-1m", /^ALLOWED: 1 model /m]]) assert.match((await run(["preset", k, ...s.F])).out, re, k);
  assert.deepEqual(dirHash(s.dir), before, "no file changed");
  assert.doesNotMatch(r.out, INTERNAL_ID);
  assert.deepEqual(Object.keys(PRESETS), ["follow-main", "any", "free", "free-wide", "free-1m"]);
});

test("preset <name>: prints the equivalent flags and the preview with ONE save command, saves nothing; --confirm yes saves exactly the expansion; --dry yes wins over --confirm yes; every free preview shows BOTH free counts", async () => {
  const s = setup();
  const expect = { "follow-main": { mode: "inherit" }, any: { source: "all-providers", mode: "dynamic", ctx: "any" }, free: { source: "all-providers", mode: "free", freeScope: "models", ctx: "any" },
    "free-wide": { source: "all-providers", mode: "free", freeScope: "providers", ctx: "any" }, "free-1m": { source: "all-providers", mode: "free", freeScope: "providers", ctx: "1m" } };
  const prev = await run(["preset", "free", ...s.F]);
  assert.equal(prev.status, 0, prev.err);
  assert.match(prev.out, /^preset free: free models only: the models tagged free$/m);
  assert.match(prev.out, /^equivalent to: node keysync\/key\.mjs subagent-policy set --source all-providers --mode free --free-scope models --ctx any$/m);
  assert.match(prev.out, /^PREVIEW \(nothing is saved\)\. /m);
  assert.match(prev.out, /^to save it: node keysync\/key\.mjs subagent-policy preset free --confirm yes$/m, "a fixture run needs no --live, so the printed command has none");
  // U3: one 'nothing saved' sentence, one save command (the old output also printed `to save this: set ...` and `Nothing was saved. To save it: ...`)
  assert.doesNotMatch(prev.out, /to save this:|Nothing was saved|dry run: nothing written/);
  assert.equal(prev.lines.filter((l) => /nothing is saved|nothing written|was saved/i.test(l)).length, 1, prev.out);
  assert.equal(prev.lines.filter((l) => /(^|\s)to save/i.test(l)).length, 1, prev.out);
  // D3: both counts, from the same live funnel, in every preview of a free preset
  for (const k of ["free", "free-wide", "free-1m"]) assert.match((await run(["preset", k, ...s.F])).out, /^free sets: 5 models tagged free; 7 models on free-labelled providers \(both of 15 tool-eligible models\)$/m, k);
  assert.equal(fs.existsSync(s.owner), false);
  const dry = await run(["preset", "free", "--confirm", "yes", "--dry", "yes", ...s.F]);
  assert.equal(dry.status, 0); assert.equal(fs.existsSync(s.owner), false, "--dry yes wins");
  for (const [name, want] of Object.entries(expect)) {
    const t = setup();
    const r = await run(["preset", name, "--confirm", "yes", ...t.F]);
    assert.equal(r.status, 0, `${name}: ${r.err}`);
    const o = rd(t.owner);
    for (const [k, v] of Object.entries(want)) assert.equal(o[k], v, `${name}.${k}`);
    assert.equal(o.enforcement, "shadow", "a preset never enforces");
    assert.ok(fs.existsSync(t.compiled), "the compiled copy is written too");
  }
  assert.equal((await run(["preset", "nope", ...s.F])).status, 1);
});

test("preset: on REAL paths a confirmed preset needs --live yes (nothing written without it); a preview and the list do not", () => {
  assert.throws(() => lib.parseArgs(["preset", "free", "--confirm", "yes"]), (e) => e.code === "E_USAGE" && /preset with no file flags writes the REAL files/.test(e.message));
  assert.doesNotThrow(() => lib.parseArgs(["preset", "free", "--confirm", "yes", "--live", "yes"]));
  assert.doesNotThrow(() => lib.parseArgs(["preset", "free"]));
  assert.doesNotThrow(() => lib.parseArgs(["preset"]));
  assert.doesNotThrow(() => lib.parseArgs(["preset", "free", "--confirm", "yes", "--dry", "yes"]), "a dry confirmed preset writes nothing");
});

// =====================================================================================================================
// 6. help
// =====================================================================================================================
test("help: the owner's toggle map (toggle 1 source, toggle 2 mode with the free scope, toggle 3 ctx, the other switches) and every command, no internal id", () => {
  const h = lib.usageText;
  for (const needle of [/Toggle 1 +source +--source same-provider\|all-providers/, /Toggle 2 +mode +--mode dynamic\|inherit\|free/, /--free-scope models\|providers\|providers\+deposit/, /Toggle 3 +context +--ctx any\|128k\|200k\|256k\|512k\|1m\|prefer-256k\|prefer-512k\|prefer-1m/,
    /--banded yes\|no/, /--handoff-notice yes\|no/, /--enforce shadow\|enforce/, /--inject off\|on/, /--allow provider\/model/, /--live yes/, /rollback needs no flag/]) assert.match(h, needle);
  for (const c of [...lib.COMMANDS, "help"]) assert.ok(new RegExp(`(^|\\s)${c}( |$|\\|)`, "m").test(h), `the help names ${c}`);
  assert.doesNotMatch(h, INTERNAL_ID);
  assert.match(h, /shadow mode only logs what it would do and changes nothing/);
  // U6: only what is true today (no plan-internal future tense), the two words defined once, the real shape of status, wizard needs --live yes
  assert.doesNotMatch(h, /will pass it|auto-rebuild and keysync|not built yet/);
  assert.match(h, /eligible = a model that passes your choices; usable = an eligible model with a known context of at least 128,000/);
  assert.match(h, /status +the verdict first .* about five lines/);
  assert.match(h, /wizard --live yes/);
  assert.match(h, /preset +list the ready-made choices .*free-wide/);
  assert.match(h, /--lift-pause yes/);
  assert.ok(h.split("\n").find((l) => /Toggle 3/.test(l)).length < 130, "the Toggle 3 line is short");
  assert.ok(lib.COMMANDS.includes("wizard") && lib.COMMANDS.includes("status") && lib.COMMANDS.includes("last"));
});

// =====================================================================================================================
// 7. E_EMPTY: why, runnable cures, nothing written
// =====================================================================================================================
test("E_EMPTY: the first line and exit 2 are unchanged; then WHY (the relay is a subscription route in no free scope), Fix A and Fix B with the consequence of each, and 'Nothing was written'", async () => {
  const s = setup();
  const r = await SET(s, "--source", "same-provider", "--mode", "free");
  assert.equal(r.status, 2);
  const L = r.err.split("\n");
  assert.match(L[0], /^E_EMPTY: the free providers filter removed all 3 of anthropic's candidates \(main provider, likely main \(default model\)\) under free providers; nothing written$/);
  assert.match(L[1], /^why: anthropic is a subscription route \(a flat-rate relay\), and subscription routes are in no free scope, so mode free leaves it no model to hand its subagents to$/);
  assert.match(L[2], /^Fix A: node keysync\/key\.mjs subagent-policy set --source all-providers --mode free --free-scope providers --ctx any   \(subagents may then run on models of any provider; 3 usable models; this saves it\)$/);
  assert.match(L[3], /^Fix B: node keysync\/key\.mjs subagent-policy set --source same-provider --mode dynamic --ctx any   \(any model, paid ones included, so cost is no longer limited to free; 3 usable models; this saves it\)$/);
  assert.match(r.err, /--allow-empty yes/);
  assert.equal(L.at(-1), "Nothing was written.");
  assert.equal(fs.existsSync(s.owner), false); assert.equal(fs.existsSync(s.compiled), false);
  assert.doesNotMatch(r.err, INTERNAL_ID);
});

test("E_EMPTY: each cure is a valid command that, run, is NOT empty (exit 0, ALLOWED above 0) and still saves nothing under --dry yes", async () => {
  const s = setup();
  const r = await SET(s, "--source", "same-provider", "--mode", "free");
  const cures = [...r.err.matchAll(/^Fix [AB]: (node keysync\/key\.mjs subagent-policy set [^(]*?)\s{2,}\(/gm)].map((m) => m[1]);
  assert.equal(cures.length, 2);
  for (const cure of cures) {
    const args = cure.slice(CLI.length + 1).split(" ");
    assert.doesNotThrow(() => lib.parseArgs([...args, "--dry", "yes", ...s.F]), cure);
    const out = await run([...args, "--dry", "yes", ...s.F]);
    assert.equal(out.status, 0, `${cure}: ${out.err}`);
    assert.match(out.out, /^ALLOWED: [1-9]\d* models/m, cure);
  }
  // on a REAL run the printed cure carries --live yes (a real set needs it), a fixture run does not
  assert.ok(!cures.some((c) => /--live/.test(c)));
  assert.equal(fs.existsSync(s.owner), false);
});

// =====================================================================================================================
// 8. explain what-if
// =====================================================================================================================
test("explain what-if: --source/--mode/--free-scope/--ctx answer 'would model X be allowed under policy Y' and save NOTHING (the whole fixture folder is byte-identical)", async () => {
  const s = setup();
  const before = dirHash(s.dir);
  const E = (id, ...a) => run(["explain", id, ...a, ...s.F]);
  const paidFree = await E("fx-paid/fxp-plain", "--source", "all-providers", "--mode", "free", "--free-scope", "providers");
  assert.equal(paidFree.status, 0, paidFree.err);
  assert.match(paidFree.lines[1], /^ANSWER: fx-paid\/fxp-plain would NOT be allowed under mode free \(free providers\), source all-providers, ctx any: it is outside free providers \(what-if: nothing was saved\)$/);
  const dyn = await E("fx-paid/fxp-plain", "--source", "all-providers", "--mode", "dynamic");
  assert.match(dyn.lines[1], /^ANSWER: fx-paid\/fxp-plain WOULD be allowed under mode dynamic, source all-providers, ctx any \(what-if: nothing was saved\)$/);
  const free = await E("fx-free-a/fxa-alpha", "--source", "all-providers", "--mode", "free", "--free-scope", "models");
  assert.match(free.lines[1], /^ANSWER: fx-free-a\/fxa-alpha (WOULD|would NOT) be allowed under mode free \(free models\)/);
  const ctx = await E("fx-free-a/fxa-alpha", "--source", "all-providers", "--mode", "dynamic", "--ctx", "1m");
  assert.match(ctx.lines[1], /^ANSWER: fx-free-a\/fxa-alpha would NOT be allowed under mode dynamic, source all-providers, ctx 1m: it has less than 1M of known context and the context floor is 1m/);
  const inh = await E("fx-paid/fxp-plain", "--mode", "inherit");
  assert.match(inh.lines[1], /^ANSWER: under mode inherit every non-exempt subagent runs on main's own model, so fx-paid\/fxp-plain is used exactly when main itself runs on it \(what-if: nothing was saved\)$/);
  const plain = await E("fx-paid/fxp-plain");
  assert.doesNotMatch(plain.lines[1], /what-if/, "no flag, no what-if note");
  assert.equal((await E("fx-paid/fxp-plain", "--mode", "dynamic", "--free-scope", "models")).status, 1, "--free-scope needs mode free, as in set");
  assert.equal((await E("fx-paid/fxp-plain", "--mode", "fixed")).status, 1);
  assert.equal((await E("nope/none", "--mode", "dynamic")).status, 3);
  assert.deepEqual(dirHash(s.dir), before, "no what-if wrote or changed any file");
  assert.equal(fs.existsSync(s.owner), false);
  // the case it must not break: with a saved policy the saved toggles still answer when no flag is given, and a what-if never rewrites them
  await SET(s, ...FREE);
  const saved = fs.readFileSync(s.owner, "utf8");
  assert.match((await E("fx-paid/fxp-plain")).lines[1], /^ANSWER: fx-paid\/fxp-plain would NOT be allowed under mode free \(free providers\)/);
  await E("fx-paid/fxp-plain", "--mode", "dynamic");
  assert.equal(fs.readFileSync(s.owner, "utf8"), saved);
});

// =====================================================================================================================
// 9. wizard
// =====================================================================================================================
const ABORT = Object.assign(new Error("cancelled"), { name: "AbortError", code: "ABORT_ERR" });
function scripted(answers) {
  const prompts = [];
  return { prompts, ask: async (q) => { prompts.push(q); if (!answers.length) throw new Error(`unexpected prompt: ${q}`); const a = answers.shift(); if (a === ABORT) throw ABORT; return a; } };
}
const WIZ = (s, fake, extra = {}) => run(["wizard", ...s.F], { isTTY: true, ask: fake.ask, ...extra });

test("wizard: a default on every question; Enter all the way saves FREE in shadow mode (D-t) after asking at most 3 questions and one confirmation", async () => {
  const s = setup();
  const fake = scripted(["", "", "", ""]);                                                       // Q1, Q2, Q3 (main is the relay: outside every free scope), save?
  const r = await WIZ(s, fake);
  assert.equal(r.status, 0, r.err);
  assert.equal(fake.prompts.length, 4, "three questions and one confirmation");
  assert.match(fake.prompts[0], /Enter = 3\]/); assert.match(fake.prompts[1], /Enter = 1\]/); assert.match(fake.prompts[2], /Free needs different providers\. Use all providers\? \[Y\/n\]/); assert.match(fake.prompts[3], /Save in shadow mode\? \[Y\/n\]/);
  assert.match(r.out, /Who should run your subagents\?/); assert.match(r.out, /3  free: only models tagged free \(5 models; the wide set of every model on a provider you labelled free is the preset free-wide\)   \(default\)/, "D3: answer 3 is the narrow set and says how to get the wide one");
  assert.match(r.out, /^Equivalent command: node keysync\/key\.mjs subagent-policy set --source all-providers --mode free --free-scope models --ctx any --enforce shadow$/m);
  assert.match(r.out, /^PREVIEW \(nothing is saved\)\. /m);
  const o = rd(s.owner);
  assert.deepEqual([o.source, o.mode, o.freeScope, o.ctx, o.enforcement, o.inject], ["all-providers", "free", "models", "any", "shadow", "off"]);
  assert.ok(fs.existsSync(s.compiled));
  assert.doesNotMatch(r.out, INTERNAL_ID);
});

test("wizard: answers 1 and 2 (and the context floor 2 and 3); follow-main asks only one question; a wizard never enforces even over an enforcing owner file", async () => {
  const s1 = setup(); const f1 = scripted(["1", ""]);
  assert.equal((await WIZ(s1, f1)).status, 0); assert.equal(f1.prompts.length, 2, "one question and the confirmation"); assert.equal(rd(s1.owner).mode, "inherit");
  const s2 = setup(); const f2 = scripted(["2", "3", "y"]);
  assert.equal((await WIZ(s2, f2)).status, 0);
  assert.deepEqual([rd(s2.owner).mode, rd(s2.owner).ctx, rd(s2.owner).source], ["dynamic", "1m", "all-providers"]); assert.equal(f2.prompts.length, 3, "no Q3 for a non-free answer");
  const s3 = setup(); const f3 = scripted(["2", "2", ""]);
  await WIZ(s3, f3); assert.equal(rd(s3.owner).ctx, "prefer-1m");
  const s4 = setup(); wr(s4.owner, { ...OWNER, enforcement: "enforce", inject: "on" });
  const f4 = scripted(["2", "", ""]);
  assert.equal((await WIZ(s4, f4)).status, 0);
  assert.equal(rd(s4.owner).enforcement, "shadow", "the wizard saves a trial: enforcement shadow");
});

test("wizard: 'no' to the Q3 question keeps same-provider, the preview REFUSES (E_EMPTY, exit 2), nothing is saved and no confirmation is asked", async () => {
  const s = setup(); const fake = scripted(["3", "", "n"]);
  const r = await WIZ(s, fake);
  assert.equal(r.status, 2);
  assert.match(r.err, /^E_EMPTY: /m); assert.match(r.err, /^Fix A: /m);
  assert.equal(fake.prompts.length, 3, "no 'Save?' prompt after a refused preview");
  assert.equal(fs.existsSync(s.owner), false); assert.equal(fs.existsSync(s.compiled), false);
  assert.match(r.out, /Nothing was written\./);
});

test("wizard: Ctrl-C (or Ctrl-D) at ANY prompt writes nothing; 'n' to the save question writes nothing", async () => {
  for (const abortAt of [0, 1, 2, 3]) {
    const s = setup(); const before = dirHash(s.dir);
    const answers = ["", "", "", ""]; answers[abortAt] = ABORT;
    const r = await WIZ(s, scripted(answers));
    assert.equal(r.status, 1, `abort at prompt ${abortAt}`);
    assert.match(r.out, /Cancelled: nothing was written\./);
    assert.deepEqual(dirHash(s.dir), before, `abort at prompt ${abortAt}: the fixture folder is byte-identical`);
  }
  const s = setup(); const r = await WIZ(s, scripted(["", "", "", "n"]));
  assert.equal(r.status, 0); assert.match(r.out, /Nothing was written\./); assert.equal(fs.existsSync(s.owner), false);
});

test("wizard: a question re-asks an unreadable answer and gives up after 3 (nothing written); the save question too", async () => {
  const s = setup(); const f = scripted(["x", "9", "", "", "", ""]);
  const r = await WIZ(s, f);
  assert.equal(r.status, 0, r.err); assert.match(r.out, /Please answer 1, 2, 3 \(or press Enter for 3\)\./); assert.ok(fs.existsSync(s.owner));
  const g = setup(); const bad = scripted(["x", "y", "z"]);
  const r2 = await WIZ(g, bad);
  assert.equal(r2.status, 1); assert.match(r2.out, /No readable answer: nothing was written\./); assert.equal(fs.existsSync(g.owner), false);
});

test("wizard: without a terminal it REFUSES (exit 1, first line E_USAGE), prints the preset list, asks nothing and writes nothing", async () => {
  const s = setup(); const fake = scripted([]); const before = dirHash(s.dir);
  const r = await run(["wizard", ...s.F], { isTTY: false, ask: fake.ask });
  assert.equal(r.status, 1);
  assert.match(r.err.split("\n")[0], /^E_USAGE: the wizard needs an interactive terminal/);
  for (const k of Object.keys(PRESETS)) assert.match(r.err, new RegExp(`^  ${k}\\s`, "m"));
  assert.equal(fake.prompts.length, 0); assert.deepEqual(dirHash(s.dir), before);
  // through the real CLI process (no TTY on a spawned child), against a sentinel HOME that must stay byte-identical
  const home = tmp(); fs.mkdirSync(path.join(home, ".llmkeys"), { recursive: true }); wr(path.join(home, ".llmkeys", "subagent-policy.json"), JSON.stringify(OWNER));
  const hb = dirHash(home);
  const p = spawnSync(process.execPath, [KEY, "subagent-policy", "wizard", "--live", "yes"], { encoding: "utf8", timeout: 60000, input: "3\n", env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home } });
  assert.equal(p.status, 1); assert.match(p.stderr, /^E_USAGE: the wizard needs an interactive terminal/); assert.match(p.stderr, /follow-main/);
  assert.deepEqual(dirHash(home), hb);
});

test("wizard (pure): at most 3 questions whatever the answers, the printed equivalent command parses, and it never reaches a file by itself", async () => {
  const log = [];
  for (const answers of [["", "", "", ""], ["1", ""], ["2", "2", ""], ["3", "3", "n", ""]]) {
    const fake = scripted([...answers]); const saved = [];
    const res = await runWizard({ isTTY: true, ask: fake.ask, out: (l) => log.push(l), cli: CLI, mainOutsideFree: async () => true, preview: async () => 0, save: async (f) => { saved.push(f); return 0; } });
    assert.ok(res.asked <= 3, `asked ${res.asked}`);
    assert.ok(fake.prompts.length <= 4);
    if (saved.length) { assert.equal(saved[0].enforce, "shadow"); assert.doesNotThrow(() => lib.parseArgs(["set", ...flagsText(saved[0]).split(" "), "--live", "yes"])); }
  }
  assert.doesNotMatch(read("keysync/subagent-wizard.mjs"), /node:fs|writeFile|appendFile|mkdirSync/, "the wizard module holds no file I/O");
  assert.equal(presetListText(CLI).filter((l) => /^  [a-z]/.test(l)).length, 5, "one line per preset (plus its set line, the eligible/usable definition and the closing hint)");
});

// =====================================================================================================================
// 10. pause, resume, undo
// =====================================================================================================================
test("pause: the compile-free alias of rollback, exempt from --live; the plain message; it records what to come back to and keeps the toggles", async () => {
  assert.doesNotThrow(() => lib.parseArgs(["pause"]), "pause needs no --live");
  assert.doesNotThrow(() => lib.parseArgs(["rollback"]));
  for (const c of ["resume", "undo"]) assert.throws(() => lib.parseArgs([c]), (e) => e.code === "E_USAGE" && new RegExp(`${c} with no file flags writes the REAL files`).test(e.message), c);
  for (const c of ["resume", "undo"]) assert.doesNotThrow(() => lib.parseArgs([c, "--live", "yes"]));
  const s = setup();
  await SET(s, ...DYN);
  const r = await run(["pause", ...s.P]);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.lines[0], "PAUSED: Subagents run exactly as they asked, from the next request. Your toggles are kept. To continue: node keysync/key.mjs subagent-policy resume --live yes", "F12: one `PAUSED:` form and a runnable command (prefix and --live yes), the same words status uses");
  assert.equal((await STATUS(s)).lines[0].split(" To continue:")[0], r.lines[0].split(" To continue:")[0], "pause and status say the same sentence");
  assert.match(r.lines[1], /^pause: wrote .*shadow\.flag and set enforcement=shadow inject=off in the owner file/);
  assert.ok(fs.existsSync(s.flag));
  const o = rd(s.owner); assert.deepEqual([o.mode, o.source, o.ctx], ["dynamic", "all-providers", "any"], "the toggles are kept");
  const rb = setup(); await SET(rb, ...DYN);
  const r2 = await run(["rollback", ...rb.P]);
  assert.equal(r2.lines[0], r.lines[0]); assert.match(r2.lines[1], /^rollback: wrote /, "rollback stays an alias with its own name in the technical line");
  const none = setup();
  assert.equal((await run(["pause", ...none.P])).status, 0);
  assert.deepEqual(fs.readdirSync(none.state), ["shadow.flag"], "with no owner file pause creates only shadow.flag");
});

test("resume: an unmet gate refuses it and the pause stays; a pause that held shadow resumes to shadow; an AUTO_ROLLBACK is cleared; not paused says so", async () => {
  // a policy that enforced (the owner file says enforce), then paused
  const s = setup();
  wr(s.owner, { ...OWNER, enforcement: "enforce" });
  assert.equal((await run(["pause", ...s.P])).status, 0);
  assert.equal(rd(s.owner).enforcement, "shadow");
  const rec = rd(path.join(s.state, "paused-from.json")); assert.equal(rec.enforcement, "enforce");
  const refused = await run(["resume", ...s.F]);
  assert.equal(refused.status, 1);
  assert.match(refused.first, /^E_PRECONDITION: --enforce enforce needs live Providers/);
  assert.ok(fs.existsSync(s.flag), "the pause stays after a refused resume");
  assert.equal(rd(s.owner).enforcement, "shadow"); assert.ok(fs.existsSync(path.join(s.state, "paused-from.json")));
  assert.equal(refused.out, "", "nothing is announced as resumed");
  // a pause that held shadow
  const t = setup(); await SET(t, ...DYN);
  await run(["pause", ...t.P]);
  const ok = await run(["resume", ...t.F]);
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.lines[0], /^RESUMED\. The pause is lifted and enforcement is back to shadow \(checked like `set --enforce enforce`\)\.$/);
  assert.equal(fs.existsSync(t.flag), false); assert.equal(fs.existsSync(path.join(t.state, "paused-from.json")), false);
  assert.equal(rd(t.owner).enforcement, "shadow");
  // the router's own tripwire
  const a = setup(); await SET(a, ...DYN);
  wr(a.flag, "auto:ERRORS:2026-10-05T10:00:00.000Z\n");
  assert.match((await STATUS(a)).lines[0], /^DEGRADED\(AUTO_ROLLBACK\): /);
  assert.equal((await run(["resume", ...a.F])).status, 0);
  assert.equal(fs.existsSync(a.flag), false);
  assert.doesNotMatch((await STATUS(a)).lines[0], /AUTO_ROLLBACK/);
  assert.match((await run(["resume", ...a.F])).out, /^Not paused: nothing to resume\.$/);
  // a pause with no saved policy: the flag is lifted, nothing else is created
  const n = setup(); await run(["pause", ...n.P]);
  const lifted = await run(["resume", ...n.F]);
  assert.equal(lifted.status, 0); assert.match(lifted.out, /^PAUSE LIFTED\. No policy is saved/); assert.equal(fs.existsSync(n.flag), false); assert.equal(fs.existsSync(n.owner), false);
});

test("pause twice keeps the FIRST record (the enforcement to come back to); a set clears the pause and its record", async () => {
  const s = setup();
  wr(s.owner, { ...OWNER, enforcement: "enforce" });
  await run(["pause", ...s.P]); await run(["pause", ...s.P]);
  assert.equal(rd(path.join(s.state, "paused-from.json")).enforcement, "enforce", "a second pause over a pause does not overwrite the real prior enforcement with shadow");
  const set = await SET(s, ...DYN);
  assert.equal(set.status, 0, set.err);
  assert.equal(fs.existsSync(s.flag), false); assert.equal(fs.existsSync(path.join(s.state, "paused-from.json")), false);
});

test("undo: one generation; written atomically BEFORE a real set changes the owner file; restores it and recompiles; a second undo says there is none", async () => {
  const s = setup();
  assert.equal((await SET(s, ...DYN)).status, 0);
  assert.equal(fs.existsSync(s.prev), false, "the first set has no earlier policy to keep");
  const A = fs.readFileSync(s.owner, "utf8");
  assert.equal((await SET(s, ...FREE)).status, 0);
  assert.equal(fs.readFileSync(s.prev, "utf8"), A, "the earlier owner file is kept byte for byte");
  assert.deepEqual(fs.readdirSync(path.dirname(s.owner)).sort(), ["subagent-policy.json", "subagent-policy.json.prev"], "no temp file is left beside it (atomic write)");
  // a set that changes nothing keeps the real earlier generation
  await SET(s, ...FREE);
  assert.equal(fs.readFileSync(s.prev, "utf8"), A, "a repeated set does not overwrite the generation undo goes back to");
  // a dry set never writes it
  const mid = fs.readFileSync(s.prev, "utf8");
  await SET(s, ...DYN, "--ctx", "1m", "--dry", "yes"); assert.equal(fs.readFileSync(s.prev, "utf8"), mid);
  const u = await run(["undo", ...s.F]);
  assert.equal(u.status, 0, u.err);
  assert.match(u.lines[0], /^UNDONE\. Your previous policy is back\.$/);
  assert.match(u.out, /^change: mode free -> dynamic; eligible 7 -> 14 models, 2 -> 5 providers \(of 6 providers in the gateway's provider list\)$/m);
  assert.equal(rd(s.owner).mode, "dynamic");
  assert.equal(rd(s.compiled).owner.mode, "dynamic", "the compiled copy follows");
  assert.equal(fs.existsSync(s.prev), false);
  const again = await run(["undo", ...s.F]);
  assert.equal(again.status, 1); assert.match(again.first, /^E_PRECONDITION: nothing to undo: no earlier policy is kept/);
  assert.equal(rd(s.owner).mode, "dynamic");
});

test("undo: clear keeps the policy one step back, so undo after clear brings it back (and lifts a pause)", async () => {
  const s = setup();
  await SET(s, ...FREE);
  const was = fs.readFileSync(s.owner, "utf8");
  const c = await run(["clear", "--policy-file", s.owner, "--state-dir", s.root]);
  assert.equal(c.status, 0, c.err); assert.match(c.out, /undo: your policy was kept one step back/);
  assert.equal(fs.existsSync(s.owner), false); assert.equal(fs.readFileSync(s.prev, "utf8"), was);
  const u = await run(["undo", ...s.F]);
  assert.equal(u.status, 0, u.err);
  assert.equal(rd(s.owner).mode, "free");
  assert.ok(fs.existsSync(s.compiled));
});

test("undo after a FAILED compile: the earlier toggles are restored, the router is PAUSED instead, the error is printed and the exit code is the compile's", async () => {
  const s = setup();
  await SET(s, ...DYN); await SET(s, ...FREE);
  fs.writeFileSync(s.m["snapshot-file"], "{ not json");                                           // the snapshot can no longer be read
  const u = await run(["undo", ...s.F]);
  assert.equal(u.status, 4);
  assert.match(u.err.split("\n")[0], /^E_SNAPSHOT:/);
  assert.match(u.out, /UNDO restored your earlier toggles \(mode dynamic, source all-providers, ctx any, enforcement shadow\) but could not apply them\. PAUSED: Subagents run exactly as they asked, from the next request\. Your toggles are kept\. Fix the cause above, then save again with a set \(a set lifts the pause\)\.$/m);
  assert.doesNotMatch(u.out, /resume/, "F11: no `resume` is suggested: it would run the same failing compile");
  assert.equal(rd(s.owner).mode, "dynamic", "the earlier toggles are saved");
  assert.ok(fs.existsSync(s.flag), "the safe landing is the pause");
  assert.equal(fs.existsSync(s.prev), false, "one generation only");
  assert.match((await STATUS(s)).lines[0], /^PAUSED: /);
});

// =====================================================================================================================
// 11. why and the one code table
// =====================================================================================================================
test("why <CODE>: plain words, the one fix command and the plan section from the one table; any case; a list with no code; an unknown code is a usage error", async () => {
  const s = setup();
  const r = await run(["why", "EMPTY_SET"]);
  assert.equal(r.status, 0, r.err);
  const row = codeRow("EMPTY_SET");
  assert.deepEqual(r.lines, ["EMPTY_SET (warning)", row.plain, `fix: ${row.fix}`, `  note: ${row.fixNote}`, `plan: section ${row.planRef}; the router is NOT doing what you saved while this holds`]);
  assert.deepEqual((await run(["why", "empty_set"])).lines, r.lines);
  assert.equal((await run(["why", "retryHdr"])).lines[0], "retryHdr (counter)");
  const list = await run(["why"]);
  assert.equal(list.status, 0); assert.match(list.out, /^warnings \(\d+\): /m); assert.match(list.out, /^counters \(\d+\): /m); assert.match(list.out, /^errors \(\d+\): .*E_EMPTY/m);
  const bad = await run(["why", "NOT_A_CODE"]);
  assert.equal(bad.status, 1); assert.match(bad.first, /^E_USAGE: no code "NOT_A_CODE" in the table/);
  assert.equal((await run(["why", "A", "B"])).status, 1);
});

/** Every code the router, the funnel, the library and key.mjs can emit, found by scanning their sources: Map code -> where it is emitted. */
function emittedCodes() {
  const router = read("router/uw-router.next.cjs"), funnel = read("menu/subagent-funnel.mjs"), lib_ = read("keysync/subagent-policy.mjs");
  const want = new Map();
  const add = (code, from) => { if (!want.has(code)) want.set(code, from); };
  for (const m of router.matchAll(/\bwarn(?:Set)?\("([A-Z][A-Z_0-9]+)"/g)) add(m[1], "router warn()");
  const pol = /warn\(`POLICY_\$\{([^`]*)\}`/.exec(router);
  assert.ok(pol, "the router builds POLICY_* codes in one template");
  for (const m of pol[1].matchAll(/"([A-Z]+)"/g)) add(`POLICY_${m[1]}`, "router POLICY_ template");
  for (const line of router.split("\n").filter((l) => /\bflags\b/.test(l) || /flags\.push/.test(l))) for (const m of line.matchAll(/"([A-Z][A-Z_]{3,})"/g)) add(m[1], "router flags");
  for (const m of router.matchAll(/"(INVARIANT|ERRORS)"/g)) add(m[1], "router tripwire");
  for (const m of router.matchAll(/\b(?:f|flags)\.push\("([A-Z][A-Z_]{3,})"\)/g)) add(m[1], "router flag push");
  for (const m of router.match(/const COUNTERS = \[([\s\S]*?)\];/)[1].matchAll(/"([A-Za-z0-9]+)"/g)) add(m[1], "router COUNTERS");
  for (const m of funnel.matchAll(/\bwarn\("([A-Z][A-Z_0-9]+)"/g)) add(m[1], "funnel warn()");
  for (const m of lib_.matchAll(/code: "([A-Z][A-Z_0-9]+)"/g)) add(m[1], "library warning");
  for (const m of lib_.matchAll(/"(E_[A-Z_]{3,})"/g)) add(m[1], "library exit code");
  for (const m of read("keysync/key.mjs").matchAll(/"(E_TIER_INVALID)"/g)) add(m[1], "key.mjs");
  return want;
}

test("code table: every warning, flag, error and counter the router and the library can emit has a row (the router and library sources are scanned)", () => {
  const router = read("router/uw-router.next.cjs");
  const want = emittedCodes();
  assert.ok(want.size > 100, `the scan found ${want.size} codes`);
  const missing = [...want].filter(([c]) => !codeRow(c)).map(([c, f]) => `${c} (${f})`);
  assert.deepEqual(missing, [], "codes with no row in menu/subagent-codes.mjs");
  // the plan 5.4 closed list
  for (const c of ["POLICY_ABSENT_SKIPPED", "POLICY_CORRUPT", "POLICY_OVERSIZE", "POLICY_SCHEMA", "EMPTY_SET", "UNKNOWN_MAIN", "UNRESOLVABLE_CANDIDATE", "UNRESOLVABLE_ASKED", "SLOT_ERROR", "NATIVE_MENU_PRESENT", "CTX_UNDELIVERED",
    "INHERIT_BELOW_CTX", "INHERIT_PREMIUM_MAIN", "UNVERIFIED_ALLOWED", "PAYLOAD_RISK", "FREE_PROMISE_BREAK", "CLASSIFIER_UNMEASURED", "TIER_MISMATCH", "FREE_LIST_STALE", "TIER_UNREADABLE", "DETECTOR_DRIFT", "ROUTER_ERROR",
    "POLICY_NEWER", "POLICY_HASH", "AUTO_ROLLBACK", "HANDOFF", "LOG_DROPPED", "COOLING", "OVERLAY_UNREADABLE", "AUTOREBUILD_FAILED", "NO_ROWS_FOR_MAIN"]) assert.ok(codeRow(c), `plan 5.4: ${c}`);
  // and the table holds nothing the router does not count
  const counters = new Set([...router.match(/const COUNTERS = \[([\s\S]*?)\];/)[1].matchAll(/"([A-Za-z0-9]+)"/g)].map((m) => m[1]));
  assert.deepEqual(CODES.filter((r) => r.kind === "counter" && !counters.has(r.code)).map((r) => r.code), [], "a counter row for a counter the router does not have");
});

test("code table: unique codes, every row has plain words, a fix and a plan section; a warning's fix is a command or an instruction; no plan id in plain or fix; degrading codes are warnings", () => {
  const seen = new Set();
  for (const r of CODES) {
    assert.ok(!seen.has(r.code), `duplicate ${r.code}`); seen.add(r.code);
    assert.ok(KINDS.includes(r.kind), r.code);
    assert.ok(typeof r.plain === "string" && r.plain.length >= 12, `${r.code}: plain`);
    assert.ok(typeof r.fix === "string" && r.fix.length >= 8, `${r.code}: fix`);
    assert.ok(typeof r.planRef === "string" && r.planRef.length > 0, `${r.code}: planRef`);
    assert.doesNotMatch(r.plain + " " + r.fix, INTERNAL_ID, `${r.code}: no plan id in what a user reads`);
    assert.ok(!/[\u0000-\u001f]/.test(r.plain + r.fix));
  }
  assert.ok(degradingCodes().length >= 8 && degradingCodes().every((c) => codeRow(c).kind === "warning"));
  for (const c of ["POLICY_NEWER", "POLICY_HASH", "EMPTY_SET", "AUTO_ROLLBACK", "ROUTER_ERROR"]) assert.ok(degradingCodes().includes(c), c);
  assert.ok(!degradingCodes().includes("COOLING") && !degradingCodes().includes("HANDOFF"));
  assert.equal(codeRow("nope"), null);
  assert.equal(codeRow("__proto__"), null); assert.equal(codeRow("constructor"), null);
});

test("every surface renders plain + fix from the table: why, status and the verdict of a degrading warning say the same words", async () => {
  const s = setup(); await SET(s, ...DYN);
  const row = codeRow("POLICY_NEWER");
  status(s, { warnings: [{ code: "POLICY_NEWER", since: new Date().toISOString() }] });
  const st = await STATUS(s), why = await run(["why", "POLICY_NEWER"]);
  assert.ok(st.out.includes(row.plain) && st.out.includes(`fix: ${row.fix}`));
  assert.ok(why.out.includes(row.plain) && why.out.includes(row.fix));
  assert.ok(st.lines[0].includes(row.plain), "the verdict sentence is the table's plain text");
  assert.equal(st.lines[1], `next: ${row.fix}`);
});

// =====================================================================================================================
// 12. the whole default output carries no plan id (grep), no secret, printable text only
// =====================================================================================================================
test("no internal id (D-x, cr-x, n:1, I-notes, QB, R-v2) appears in the default output of any new or changed command", async () => {
  const s = setup(); writeLog(s);
  await SET(s, ...DYN); await SET(s, ...FREE); status(s, { warnings: [{ code: "COOLING" }] });
  const outs = [
    (await SET(s, ...FREE, "--dry", "yes")).out, (await SET(s, "--source", "same-provider", "--mode", "free", "--dry", "yes")).err, (await SHOW(s)).out, (await STATUS(s)).out, (await LAST(s)).out,
    (await run(["preset", ...s.F])).out, (await run(["preset", "any", ...s.F])).out, lib.usageText, (await run(["pause", ...s.P])).out, (await run(["resume", ...s.F])).out, (await run(["undo", ...s.F])).out,
    (await run(["explain", "fx-paid/fxp-plain", "--mode", "free", ...s.F])).out.split("\n").slice(0, 2).join("\n"),
  ];
  for (const o of outs) { assert.doesNotMatch(o, INTERNAL_ID); assert.doesNotMatch(o, /\((?:D|cr)-[A-Za-z0-9]+\)/); assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(o), "no control character"); }
  // the raw detail and `why` keep them (that is where they belong)
  assert.match((await SET(s, ...FREE, "--detail", "yes", "--dry", "yes")).out, /\(cr-m3\)/);
  assert.match((await run(["why", "EMPTY_SET"])).out, /plan: section 6\.2/);
});

// =====================================================================================================================
// 13. the new commands follow the fixture-flag rules (pure parse: no file is read or written)
// =====================================================================================================================
test("flag rules: status/show need policy-file and state-dir together, last needs only state-dir, resume/undo/preset/wizard need the set trio, why takes none; a half set is E_USAGE", () => {
  const bad = (argv, re) => assert.throws(() => lib.parseArgs(argv), (e) => e.code === "E_USAGE" && e.exit === 1 && re.test(e.message), argv.join(" "));
  bad(["status", "--policy-file", "x"], /incomplete test-flag set/);
  bad(["last", "--policy-file", "x"], /unknown or not applicable flag --policy-file for last/);
  bad(["last", "--providers-file", "x"], /unknown or not applicable flag/);
  bad(["why", "--state-dir", "x"], /unknown or not applicable flag --state-dir for why/);
  bad(["resume", "--policy-file", "x", "--state-dir", "y"], /incomplete test-flag set: .*--providers-file/);
  bad(["undo", "--state-dir", "y"], /incomplete test-flag set/);
  bad(["wizard", "--state-dir", "y"], /incomplete test-flag set/);
  bad(["preset", "free", "--policy-file", "x"], /incomplete test-flag set/);
  bad(["pause", "--policy-file", "x"], /incomplete test-flag set: --policy-file requires --state-dir too for pause/);
  bad(["last", "--since", "1w"], /--since takes a number and a unit/);
  bad(["last", "--json", "maybe"], /takes exactly yes or no/);
  bad(["preset", "wat"], /usage: subagent-policy preset \[follow-main\|any\|free\|free-wide\|free-1m\]/);
  bad(["show", "--detail"], /needs an explicit value/);
  assert.equal(lib.parseArgs(["last", "5", "--state-dir", "x"]).target, "5");
  assert.equal(lib.parseArgs(["why", "EMPTY_SET"]).target, "EMPTY_SET");
  assert.equal(lib.parseArgs(["preset", "free-1m"]).target, "free-1m");
  assert.equal(lib.parseArgs(["show", "--detail", "yes", "--policy-file", "a", "--state-dir", "b"]).flags.detail, true);
  // a fixture path under a real folder is still refused for the read-only commands
  assert.throws(() => lib.resolvePaths({ "state-dir": path.join(os.homedir(), ".uw", "state") }), (e) => e.code === "E_USAGE" && /real vault/.test(e.message));
});

// =====================================================================================================================
// 14. the S1d fix round (review findings F1-F22, owner decisions D1-D8, UX points U1-U9)
// =====================================================================================================================
const minutes = (n) => new Date(NOW - n * 60000).toISOString();

test("verdict (D4): WAITING, IDLE and NOT-WIRED are told apart by what the router has reported and how old the compile is", () => {
  // no status at all: a compile younger than 10 minutes is WAITING, older is NOT-WIRED
  const young = { ...COMPILED, compiledAt: minutes(9) }, old = { ...COMPILED, compiledAt: minutes(11) };
  assert.equal(verdict(OWNER, young, null, false, NOW).state, "WAITING");
  assert.equal(verdict(OWNER, old, null, false, NOW).state, "NOT-WIRED");
  assert.equal(verdict(OWNER, { ...COMPILED, compiledAt: undefined }, null, false, NOW).state, "NOT-WIRED", "an unknown compile time is not 'fresh'");
  const w = verdict(OWNER, young, null, false, NOW);
  assert.match(w.sentence, /^saved and compiled; no router has reported yet, and it uses the policy from its next request\.$/);
  assert.equal(w.savedSentence, "saved and compiled; the router uses it from its next request.");
  assert.equal(w.fix, `${CLI} status`);
  // the router reported this exact copy and then went quiet for over 24 h: IDLE, with the age and the reassurance
  const idle = verdict(OWNER, OLD, STATUS_OK({ updatedAt: minutes(26 * 60) }), false, NOW);
  assert.equal(idle.state, "IDLE");
  assert.equal(idle.sentence, "last request seen 26 h ago; the router reports only while Claude Code runs; nothing is wrong unless you used Claude Code since.");
  assert.equal(verdict(OWNER, OLD, STATUS_OK({ updatedAt: minutes(23 * 60) }), false, NOW).state, "SHADOW", "23 h of quiet is not idle");
  // NOT-WIRED never points at the doctor (it has no subagent check yet)
  for (const v of [verdict(OWNER, old, null, false, NOW), verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "0ther0ther00" } }), false, NOW)]) assert.doesNotMatch(v.fix, /doctor/);
});

test("verdict (F2): a status written BEFORE the latest compile cannot keep a DEGRADED alive; the same warning from a status written after it still degrades", () => {
  const stale = STATUS_OK({ updatedAt: minutes(180), policy: { state: "corrupt" }, warnings: [{ code: "POLICY_CORRUPT" }] });       // compiled 2 h ago, this report is 3 h old
  const a = verdict(OWNER, COMPILED, stale, false, NOW);
  assert.equal(a.state, "WAITING", JSON.stringify(a));
  assert.equal(verdict(OWNER, COMPILED, STATUS_OK({ policy: { state: "corrupt" }, warnings: [{ code: "POLICY_CORRUPT" }] }), false, NOW).label, "DEGRADED(POLICY_CORRUPT)", "a current report of the problem still degrades");
  // a report that names another copy than the compiled one is about the old file too
  assert.notEqual(verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "0ther0ther00" }, warnings: [{ code: "POLICY_HASH" }] }), false, NOW).state, "DEGRADED");
});

test("verdict (F2) end to end: DEGRADED(POLICY_NEWER) from the router, then a rebuild that changes the file: status says WAITING, not the old DEGRADED", async () => {
  const s = setup(); await SET(s, ...DYN);
  status(s, { warnings: [{ code: "POLICY_NEWER", since: new Date().toISOString() }] });
  assert.match((await STATUS(s)).lines[0], /^DEGRADED\(POLICY_NEWER\): /);
  await new Promise((r) => setTimeout(r, 15));
  const fix = await SET(s, ...DYN, "--ctx", "prefer-1m");                                       // the owner changes the policy: a new compiled copy, newer than the report
  assert.equal(fix.status, 0, fix.err);
  const after = await STATUS(s);
  assert.match(after.lines[0], /^WAITING: /, after.out);
  assert.doesNotMatch(after.lines[0], /DEGRADED/);
});

test("verdict (F3): the router's headline is used only when its enforcement equals the compiled owner's: a contradiction never reaches the first line", () => {
  const ENF = { ...COMPILED, owner: { ...COMPILED.owner, enforcement: "enforce" } };
  const shadowButRouterSaysEnforce = verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "abc123abc123", enforcement: "enforce", headline: "ENFORCING: logs what it would do..." } }), false, NOW);
  assert.equal(shadowButRouterSaysEnforce.state, "SHADOW");
  assert.equal(shadowButRouterSaysEnforce.sentence, "logs what it would do and changes nothing; subagents still run exactly as they ask.");
  assert.equal(shadowButRouterSaysEnforce.headline, null);
  const enforceButRouterSaysShadow = verdict({ ...OWNER, enforcement: "enforce" }, ENF, STATUS_OK({ policy: { contentHash: "abc123abc123", enforcement: "shadow", headline: "SHADOW: Subagents run on the models the policy picks" } }), false, NOW);
  assert.equal(enforceButRouterSaysShadow.state, "ENFORCING");
  assert.equal(enforceButRouterSaysShadow.sentence, "subagents run on the models the policy picks; helper calls are left alone.");
  // and a headline that agrees still wins
  assert.equal(verdict(OWNER, COMPILED, STATUS_OK({ policy: { contentHash: "abc123abc123", enforcement: "shadow", headline: "logs what it would do (3 agents)" } }), false, NOW).sentence, "logs what it would do (3 agents)");
});

test("status (F21): a fleet half on an older compiled copy is WAITING with a note, not healthy; a recycled pid cannot keep a long-dead worker's file alive", async () => {
  const s = setup(); await SET(s, ...DYN);
  const c = rd(s.compiled);
  const base = { schema: 1, pid: process.pid, routerVersion: 2, counters: { req: 3, main: 2, sub: 1, aux: 0 }, warnings: [] };
  wr(path.join(s.state, "status-aaa.json"), { ...base, updatedAt: new Date().toISOString(), policy: { state: "ok", contentHash: c.contentHash, enforcement: "shadow", inject: "off" } });
  wr(path.join(s.state, "status-bbb.json"), { ...base, updatedAt: new Date(Date.now() - 3 * 86400000).toISOString(), policy: { state: "ok", contentHash: "0lder0lder00", enforcement: "shadow", inject: "off" } });
  // the second file is three days old: its pid exists (it is this process) but the pid alone must not make it live
  const r = lib.readStatus(path.join(s.state, "status.json"));
  assert.equal(r.status.workers, 1, "the stale file is not a live worker");
  assert.deepEqual(r.status.policyHashes, [c.contentHash]);
  assert.match((await STATUS(s)).lines[0], /^SHADOW: /);
  // a live worker (reported a minute ago) still on the older copy: WAITING with the count
  wr(path.join(s.state, "status-bbb.json"), { ...base, updatedAt: new Date(Date.now() - 60000).toISOString(), policy: { state: "ok", contentHash: "0lder0lder00", enforcement: "shadow", inject: "off" } });
  const mixed = await STATUS(s);
  assert.match(mixed.lines[0], /^WAITING: .*1 of 2 router workers still report an older copy\./, mixed.out);
  assert.equal(lib.readStatus(path.join(s.state, "status.json")).status.policyHashes.length, 2);
});

test("set (F1): a changed set says SAVED (never NOT-WIRED, never the doctor); an unchanged set the router already reported says SHADOW", async () => {
  const s = setup(); await SET(s, ...DYN); status(s);
  const same = await SET(s, ...DYN);
  assert.match(same.lines[0], /^SHADOW: /, same.out);
  const changed = await SET(s, ...DYN, "--ctx", "prefer-1m");
  assert.equal(changed.lines[0], "SAVED: saved and compiled; the router uses it from its next request.");
  assert.equal(changed.lines[1], `next: ${CLI} status`);
  assert.doesNotMatch(changed.out, /NOT-WIRED|doctor/);
});

test("status (D5): a corrupt owner file is DEGRADED(E_OWNER_CORRUPT) with the clear command and exit 4; show keeps its loud error", async () => {
  const s = setup();
  wr(s.owner, "{broken");
  const r = await STATUS(s);
  assert.equal(r.status, 4);
  assert.match(r.lines[0], /^DEGRADED\(E_OWNER_CORRUPT\): Your saved policy file is unreadable or invalid\./);
  assert.equal(r.lines[1], `next: ${CLI} clear --live yes`);
  assert.match(r.lines[2], /^detail: owner policy file .* is not valid JSON/);
  assert.equal(r.err, "");
  const sh = await SHOW(s);
  assert.equal(sh.status, 4); assert.match(sh.err, /^E_OWNER_CORRUPT: /); assert.equal(sh.out, "", "show still dies loudly, as pinned");
});

test("undo (D1): while PAUSED it is refused (E_PRECONDITION naming resume), nothing changes; --lift-pause yes goes back one step, lifts the pause and says so", async () => {
  const s = setup(); await SET(s, ...DYN); await SET(s, ...FREE);
  assert.equal((await run(["pause", ...s.P])).status, 0);
  const prevBefore = fs.readFileSync(s.prev, "utf8"), ownerBefore = fs.readFileSync(s.owner, "utf8");
  const refused = await run(["undo", ...s.F]);
  assert.equal(refused.status, 1);
  assert.match(refused.first, /^E_PRECONDITION: undo is refused while the policy is paused \(it would also lift the pause\)\. Run `node keysync\/key\.mjs subagent-policy resume --live yes` first, or run undo with --lift-pause yes/);
  assert.equal(fs.readFileSync(s.prev, "utf8"), prevBefore, "the undo generation is still there"); assert.equal(fs.readFileSync(s.owner, "utf8"), ownerBefore);
  assert.ok(fs.existsSync(s.flag), "the pause stays");
  const lifted = await run(["undo", "--lift-pause", "yes", ...s.F]);
  assert.equal(lifted.status, 0, lifted.err);
  assert.ok(lifted.lines.includes("pause lifted (--lift-pause yes)"), lifted.out);
  assert.equal(fs.existsSync(s.flag), false); assert.equal(rd(s.owner).mode, "dynamic");
  assert.doesNotThrow(() => lib.parseArgs(["undo", "--lift-pause", "yes", "--live", "yes"]));
  assert.throws(() => lib.parseArgs(["resume", "--lift-pause", "yes", "--live", "yes"]), (e) => e.code === "E_USAGE");
  // the case it must not break: undo with no pause needs no flag
  const t = setup(); await SET(t, ...DYN); await SET(t, ...FREE);
  assert.equal((await run(["undo", ...t.F])).status, 0);
});

test("wizard (D2, F9): it needs --live yes on real paths like every writer (refused before the first question); the equivalent command it prints carries --live yes on a real path", async () => {
  assert.throws(() => lib.parseArgs(["wizard"]), (e) => e.code === "E_USAGE" && /^wizard with no file flags writes the REAL files .*shadow\.flag.*; pass --live yes to confirm/.test(e.message));
  assert.doesNotThrow(() => lib.parseArgs(["wizard", "--live", "yes"]));
  const home = tmp(); fs.mkdirSync(path.join(home, ".llmkeys"), { recursive: true }); wr(path.join(home, ".llmkeys", "subagent-policy.json"), JSON.stringify(OWNER));
  const hb = dirHash(home);
  const p = spawnSync(process.execPath, [KEY, "subagent-policy", "wizard"], { encoding: "utf8", timeout: 60000, input: "3\n", env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home } });
  assert.equal(p.status, 1); assert.match(p.stderr, /^E_USAGE: wizard with no file flags writes the REAL files/); assert.doesNotMatch(p.stderr, /terminal/);
  assert.deepEqual(dirHash(home), hb, "a refused wizard touches nothing");
  for (const [live, tail] of [[true, " --live yes"], [false, ""]]) {
    const out = []; const fake = scripted(["3", "1", "n"]);
    await runWizard({ isTTY: true, ask: fake.ask, out: (l) => out.push(l), cli: CLI, live, mainOutsideFree: async () => false, preview: async () => 0, save: async () => 0 });
    assert.ok(out.includes(`Equivalent command: ${CLI} set --source all-providers --mode free --free-scope models --ctx any --enforce shadow${tail}`), out.join("\n"));
  }
  // the equivalent command printed on a real path parses as a real save
  assert.doesNotThrow(() => lib.parseArgs(["set", "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--ctx", "any", "--enforce", "shadow", "--live", "yes"]));
});

test("undo fallback (F11): when the restored toggles cannot be applied the WHOLE refusal is printed with words that are true (the earlier toggles ARE saved), and no resume that would fail again is suggested", async () => {
  const s = setup();
  assert.equal((await SET(s, "--source", "same-provider", "--mode", "free", "--allow-empty", "yes")).status, 0);      // the relay main has no free model: this earlier policy compiles empty for main
  assert.equal((await SET(s, ...DYN)).status, 0);
  const u = await run(["undo", ...s.F]);
  assert.equal(u.status, 2, u.err);
  const L = u.err.split("\n");
  assert.match(L[0], /^E_EMPTY: .*; your earlier toggles are saved, paused$/);
  assert.ok(L.some((l) => /^Fix A: /.test(l)), "the cures are printed, not only the first line");
  assert.equal(L.at(-1), "Your earlier toggles are saved, paused.");
  assert.doesNotMatch(u.err, /nothing written|Nothing was written/i, "undo DID write the owner file");
  assert.doesNotMatch(u.out + u.err, /resume/);
  assert.equal(rd(s.owner).source, "same-provider"); assert.ok(fs.existsSync(s.flag));
  assert.match(u.out, /Fix the cause above, then save again with a set \(a set lifts the pause\)\.$/m);
});

test("set (F13): a real set during a pause lifts it and SAYS so, including that enforcement stays shadow when it was enforce before the pause; a preview says it would lift", async () => {
  const s = setup();
  wr(s.owner, { ...OWNER, enforcement: "enforce" });
  await run(["pause", ...s.P]);
  const dry = await SET(s, ...DYN, "--dry", "yes");
  assert.ok(dry.lines.includes("NOTE: the policy is paused now; saving it for real lifts the pause"), dry.out);
  assert.ok(fs.existsSync(s.flag), "a preview lifts nothing");
  const set = await SET(s, ...DYN);
  assert.equal(set.status, 0, set.err);
  assert.ok(set.lines.includes("pause lifted; enforcement stays shadow (it was enforce before the pause)"), set.out);
  assert.equal(fs.existsSync(s.flag), false);
  const t = setup(); await SET(t, ...DYN); await run(["pause", ...t.P]);
  assert.ok((await SET(t, ...DYN, "--ctx", "prefer-1m")).lines.includes("pause lifted; enforcement stays shadow"), "a pause that held shadow has no 'was enforce' note");
  const u = setup(); await SET(u, ...DYN);
  assert.ok(!(await SET(u, ...DYN, "--ctx", "prefer-1m")).out.includes("pause lifted"), "no pause, no message");
});

test("F12: one PAUSED form (`PAUSED:`), never `PAUSED.`, and the continue command is complete (prefix and --live yes)", async () => {
  assert.doesNotMatch(read("keysync/subagent-policy.mjs"), /PAUSED\. /);
  const s = setup(); await SET(s, ...DYN);
  const p = await run(["pause", ...s.P]);
  assert.match(p.lines[0], /^PAUSED: .* To continue: node keysync\/key\.mjs subagent-policy resume --live yes$/);
  assert.match((await STATUS(s)).out, /^next: node keysync\/key\.mjs subagent-policy resume --live yes$/m);
});

test("code table (F14, F15): EVERY fix command of EVERY row parses through the real argument parser (a typo'd flag cannot ship); a fix is a command and its extra instruction is a separate fixNote", async () => {
  const keyMjs = read("keysync/key.mjs");
  let parsed = 0;
  for (const r of CODES) {
    assert.ok(r.fixNote === undefined || (typeof r.fixNote === "string" && r.fixNote.length > 8 && !/\n/.test(r.fixNote)), `${r.code}: fixNote`);
    if (r.fix === NO_FIX) { assert.ok(r.kind === "counter" || r.kind === "warning" || r.kind === "flag", r.code); continue; }
    assert.ok(r.fix.startsWith("node "), `${r.code}: a fix is a runnable command (or the informational marker), found ${JSON.stringify(r.fix)}`);
    if (r.fix.startsWith(`${CLI} `)) {
      const argv = r.fix.slice(CLI.length + 1).replace(/<provider\/model>/g, "fx/model").split(" ");
      if (argv[0] !== "help") assert.doesNotThrow(() => lib.parseArgs(argv), `${r.code}: ${r.fix}`);
      parsed += 1;
    } else if (r.fix.startsWith("node keysync/key.mjs ")) assert.ok(new RegExp(`"${r.fix.split(" ")[2]}"`).test(keyMjs), `${r.code}: key.mjs has a ${r.fix.split(" ")[2]} command`);
    else assert.ok(fs.existsSync(path.join(ROOT, r.fix.split(" ")[1])), `${r.code}: ${r.fix} names a script that exists`);
    if (r.degrades) assert.doesNotMatch(r.fix, /--dry yes|preset( \w[\w-]*)?$/, `${r.code}: a degrading code's fix is a repair, not a preview`);
  }
  assert.ok(parsed >= 50, `parsed ${parsed} subagent-policy fix commands`);
  assert.equal(CODES.length, 130, "the table holds 130 rows");
  // the rows the review named
  assert.equal(codeRow("FREE_PROMISE_BREAK").fix, `${CLI} show --detail yes`);
  assert.equal(codeRow("UNKNOWN_MAIN").fix, `${CLI} status`); assert.match(codeRow("UNKNOWN_MAIN").fixNote, /start a request in the main session first/);
  assert.equal(codeRow("POLICY_NEWER").fix, "node harness/deploy-router.mjs"); assert.match(codeRow("POLICY_NEWER").fixNote, /redeploy a router/);
  assert.equal(codeRow("CLASSIFIER_UNMEASURED").fix, `${CLI} set --enforce shadow --live yes`);
  assert.equal(codeRow("ROUTER_ERROR").fix, `${CLI} last`);
  for (const c of ["POLICY_OVERSIZE", "EMPTY_SET", "E_EMPTY"]) assert.doesNotMatch(codeRow(c).fix, /--dry yes|preset free\b/, c);
  assert.match(codeRow("EMPTY_SET").fix, /preset any --confirm yes --live yes$/);
  // a mistyped flag in a fix IS caught by this test: the parser refuses it
  assert.throws(() => lib.parseArgs(["show", "--detial", "yes"]), (e) => e.code === "E_USAGE");
  // `why` shows the note under the fix, and nothing else changes
  const why = await run(["why", "UNKNOWN_MAIN"]);
  assert.ok(why.lines.includes(`fix: ${CLI} status`) && why.lines.includes(`  note: ${codeRow("UNKNOWN_MAIN").fixNote}`), why.out);
});

test("code table (D7): the 8 rows with no emitter in the built code are marked planned (why says so); a planned row that IS emitted is a failure, and so is an emitted row not in the table", async () => {
  const emitted = emittedCodes();
  const PLANNED = ["POLICY_ABSENT_SKIPPED", "UNVERIFIED_ALLOWED", "PAYLOAD_RISK", "FREE_LIST_STALE", "TIER_UNREADABLE", "DETECTOR_DRIFT", "AUTOREBUILD_FAILED", "NO_ROWS_FOR_MAIN"];
  assert.deepEqual(CODES.filter((r) => r.planned).map((r) => r.code).sort(), [...PLANNED].sort());
  for (const r of CODES) {
    if (r.planned) assert.ok(!emitted.has(r.code), `${r.code} is marked planned but something emits it (${emitted.get(r.code)}): clear the mark`);
    else if (r.kind !== "counter" && r.kind !== "error") assert.ok(emitted.has(r.code), `${r.code} is not marked planned but nothing emits it: mark it planned or emit it`);
  }
  for (const c of PLANNED) assert.ok(!emitted.has(c), c);
  const why = await run(["why", "DETECTOR_DRIFT"]);
  assert.ok(why.lines.includes("planned: nothing emits this yet"), why.out);
  assert.ok(!(await run(["why", "EMPTY_SET"])).lines.includes("planned: nothing emits this yet"));
});

test("no plan id in ANY default output, error paths and warnings included (the D-a, D-j, plan 12.5, G3 and plan 6.7 leaks)", async () => {
  const PLAN_ID = /\bD-[a-z]{1,2}\b|\bplan \d|\bG3\b|\(plan|cr-[A-Za-z0-9]+|\bR-v2-\d+|\bQB-\d+/;
  const s = setup();
  const errs = [];
  for (const argv of [["set", "--mode", "fixed", ...s.F], ["set", "--source", "all-providers", "--mode", "dynamic", "--free-scope", "models", ...s.F], ["explain", "fx-paid/fxp-plain", "--mode", "dynamic", "--free-scope", "models", ...s.F],
    ["set", "--source", "all-providers", "--mode", "dynamic", "--enforce", "enforce", ...s.F]]) errs.push((await run(argv)).err);
  assert.equal(errs.length, 4); for (const e of errs) assert.notEqual(e, "", "every case printed an error");
  // the classifier-record refusal (a live compile would reach it: ask the library directly)
  assert.throws(() => lib.checkEnforcePreconditions({ stateDir: s.state }, { providersLive: true }, { enforcement: "enforce" }), (e) => { errs.push(e.message); return e.code === "E_PRECONDITION"; });
  // the router-too-old warning on set and rebuild
  await SET(s, ...DYN);
  status(s, { routerVersion: 1 });
  const warn = [(await SET(s, ...DYN, "--ctx", "prefer-1m")).out, (await run(["rebuild", ...s.F])).out];
  assert.match(warn[0], /needs router v2 but the running router reports v1/);
  for (const o of [...errs, ...warn, (await SET(s, ...FREE, "--dry", "yes")).out]) assert.doesNotMatch(o, PLAN_ID);
  assert.match(errs[3], /^E_PRECONDITION: --enforce enforce needs live Providers/);
  assert.match(errs[4], /^--enforce enforce is blocked: state\/subagent\/accuracy\.json must hold a classifier verdict PASS younger than 30 days$/);
});

test("ttyAsker (F18): an answer is returned; EOF before the question and EOF in the same tick reject with AbortError; a stream already destroyed fails closed instead of waiting for ever", async () => {
  const abort = (e) => e?.name === "AbortError";
  const input = new PassThrough(), a = ttyAsker(input, new PassThrough());
  const p = a.ask("q? "); input.write("hello\n");
  assert.equal(await p, "hello");
  input.end(); await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(a.ask("again? "), abort, "EOF before the question");
  a.close();
  const i2 = new PassThrough(), a2 = ttyAsker(i2, new PassThrough());
  const p2 = a2.ask("x? "); i2.end();
  await assert.rejects(p2, abort, "EOF in the same tick");
  a2.close();
  // a stream destroyed BEFORE the asker is made never emits `close` to a late listener: it used to hang for ever
  const i3 = new PassThrough(); i3.destroy();
  const a3 = ttyAsker(i3, new PassThrough());
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("ttyAsker hung on a destroyed stream")), 2000));
  await assert.rejects(Promise.race([a3.ask("x? "), timeout]), abort, "a destroyed stream fails closed");
  a3.close();
});

test("runbook 5b (F19): every documented example runs in a fixture with the MINIMAL flags its command takes (`last` only --state-dir; pause, rollback and clear only --policy-file and --state-dir; the rest the full set), and none is refused as a usage error", async () => {
  const md = read("docs/runbook.md").replace(/\r\n/g, "\n");
  const sec = md.slice(md.indexOf("### 5b."), md.indexOf("## 6. Phase B"));
  const cmds = [...sec.matchAll(/^node keysync\/key\.mjs subagent-policy ([^#\n]*?)\s*(?:#.*)?$/gm)].map((m) => m[1].trim());
  assert.ok(cmds.length >= 12, `found ${cmds.length} documented commands`);
  const s = setup(); writeLog(s);
  const flagsFor = (argv) => (["last"].includes(argv[0]) ? ["--state-dir", s.root] : ["pause", "rollback", "clear"].includes(argv[0]) ? s.P : argv[0] === "why" ? [] : s.F);
  for (const c of cmds) {
    const argv = c.split(/\s+/).filter(Boolean);
    const run1 = argv.filter((x, i) => !(x === "--live" || (argv[i - 1] === "--live" && x === "yes")));
    const r = await run([...run1, ...flagsFor(run1)], { isTTY: false, now: NOW });
    assert.ok(!/incomplete test-flag set|unknown or not applicable flag|needs an explicit value|takes exactly yes or no/.test(r.err), `${c}: refused as a flag error: ${r.err}`);
    assert.ok([0, 1, 2, 3].includes(r.status), `${c}: exit ${r.status} ${r.err}`);
    // a wizard has no terminal here, undo has nothing to undo after one save, explain asks about a model the fixture may not hold: those exits are expected, a flag error is not
    if (!["wizard", "undo", "explain"].includes(run1[0])) assert.equal(r.status, 0, `${c}: ${r.err}`);
  }
  // the runbook says so, and says what the full-set shortcut does NOT cover
  const flat = sec.replace(/\s+/g, " ");
  assert.match(flat, /`last` takes only `--state-dir /);
  assert.match(flat, /`pause`, `rollback` and `clear` take only `--policy-file /);
  assert.match(flat, /`\$F` given to `last`, `pause`, `rollback`, `clear` or `why` is refused as E_USAGE/);
  assert.match(flat, /preset free-wide/);
  assert.match(flat, /--lift-pause yes/); assert.match(flat, /`wizard`/);
});

// =====================================================================================================================
// 14. revision 11, policy-side fix round: the context toggle everywhere (preview, show, preset, wizard, explain), inferred ctx, known issues, re-probe, payload wording
// =====================================================================================================================
const FLOORS_LINE = /^CONTEXT FLOORS: of \d+ rows in the chosen scope, \d+ have no known ctx; known ctx >= 128k \d+, >= 200k \d+, >= 256k \d+, >= 512k \d+, >= 1M \d+; \d+ of the \d+ unknown rows pass 128k on an inferred ctx/m;

test("the `set --dry yes` preview prints rows per context floor with their denominators; --detail adds them to the funnel too; the numbers do not move with the ctx value (they describe the scope, not the choice)", async () => {
  const s = setup();
  const a = await SET(s, ...DYN, "--ctx", "any", "--dry", "yes");
  assert.equal(a.status, 0, a.err);
  assert.match(a.out, FLOORS_LINE);
  const floors = (r) => r.out.split("\n").find((l) => l.startsWith("CONTEXT FLOORS"));
  const b = await SET(s, ...DYN, "--ctx", "prefer-256k", "--dry", "yes");
  assert.equal(floors(b), floors(a), "same scope, same rows per floor");
  assert.match(b.out, /ALLOWED: \d+ models? \(of \d+ in the chosen scope, ctx prefer-256k: rows of at least 256k form the higher band;/);
  const c = await SET(s, ...DYN, "--ctx", "128k", "--dry", "yes");
  assert.match(c.out, /after the ctx 128k filter/);
  assert.match((await SET(s, ...DYN, "--ctx", "prefer-1m", "--dry", "yes")).out, /ctx prefer-1m: rows of at least 1M form the higher band/);
  const d = await SET(s, ...DYN, "--ctx", "any", "--dry", "yes", "--detail", "yes");
  assert.match(d.out, FLOORS_LINE);
  assert.ok(!INTERNAL_ID.test(a.out), "no plan id in the default preview");
});

test("`preset` with no name lists one context line per preset (rows per floor with denominators), and `preset free-1m` (a preset that mentions 1m) still previews", async () => {
  const s = setup();
  const r = await run(["preset", ...s.F]);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out.split("\n").filter((l) => /^\s+context: of \d+ rows, \d+ unknown; known >= 128k \d+, >= 200k \d+, >= 256k \d+, >= 512k \d+, >= 1M \d+$/.test(l)).length, 4, "a context line under each of the 4 presets that have a list");
  const p = await run(["preset", "free-1m", ...s.F]);
  assert.ok(p.status === 0 || p.status === 2, p.err);
  assert.match(p.out, /--ctx 1m/);
});

test("`show` prints the compiled rows per context floor and, with --detail, names the free models waiting for a re-probe; the payload gate is called inert when pb is unknown", async () => {
  const s = setup();
  const r = await SET(s, ...DYN);
  assert.equal(r.status, 0, r.err);
  const sh = await SHOW(s);
  assert.match(sh.out, /^  CONTEXT FLOORS: of \d+ rows in the chosen scope/m);
  assert.match(sh.out, /^  payload limits: \d+ of \d+ eligible models have no known request-size limit, so the size check does nothing for them until a limit is measured \(a tool test records one\); live shadow: 317 of 337 classified subagent requests \(94%\) were over 200 KB and 71 \(21%\) over 1 MB/m);
  const c = rd(s.compiled);
  const wt = { ...c, counts: { ...c.counts, reprobe: 2 }, reprobe: [{ s: "pa/a:free", status: "rate", ageDays: 6 }, { s: "pa/b:free", status: "timeout", ageDays: 5 }] };
  wr(s.compiled, wt);
  assert.match((await SHOW(s)).out, /2 free-tagged models wait for a re-probe \(dropped on a transient bench status, not dead\) \(--detail yes names them\)/);
  assert.match((await SHOW(s, "--detail", "yes")).out, /wait for a re-probe .*: pa\/a:free \(rate\), pa\/b:free \(timeout\)/);
  wr(s.compiled, { ...wt, counts: { ...wt.counts, accountStateRows: 1 }, accountStateRows: [{ s: "pa/orca:free", status: "rate", ageDays: 6, why: "auth" }] });
  assert.match((await SHOW(s)).out, /1 free-tagged models show an account state \(their stored message names your plan, key or balance\), not a pending re-probe \(--detail yes names them\)/);
  assert.match((await SHOW(s, "--detail", "yes")).out, /show an account state .*: pa\/orca:free \(auth\)/);
  const st = await STATUS(s);
  assert.match(st.out, /^payload limits: /m, "status says it too");
});

test("explain: an INFERRED ctx is named as such, a seeded known issue is named with its number, a payload cap names its source, the ctx floor in the verdict text follows the toggle", async () => {
  const s = setup();
  const sn = rd(s.m["snapshot-file"]);
  const pa = sn.rows.find((r) => r.provider === "fx-free-a"), pb = sn.rows.find((r) => r.provider === "fx-free-b");
  const tpl = pa.models[0];
  pa.models.push({ ...tpl, id: "sib-model", ctx: 500000 });
  pb.models.push({ ...tpl, id: "sib-model:free", ctx: null });
  wr(s.m["snapshot-file"], sn);
  const pr = rd(s.m["providers-file"]);
  pr.Providers.find((p) => p.name === "fx-free-a").models.push("sib-model"); pr.Providers.find((p) => p.name === "fx-free-b").models.push("sib-model:free");
  wr(s.m["providers-file"], pr);
  const bn = rd(s.m["bench-file"]);
  bn.models["fx-free-a/sib-model"] = { ...bn.models["fx-free-a/fxa-alpha"] }; bn.models["fx-free-b/sib-model:free"] = { ...bn.models["fx-free-a/fxa-alpha"] };
  wr(s.m["bench-file"], bn);
  const e = await run(["explain", "fx-free-b/sib-model:free", ...s.F]);
  assert.equal(e.status, 0, e.err);
  assert.match(e.out, /^ctx: 128,000 \(INFERRED \(c\?\) from a same-name sibling: a 128k floor-only prior, never the asked floor or a ranking class above 128k\)/m);
  const e256 = await run(["explain", "fx-free-b/sib-model:free", "--ctx", "256k", ...s.F]);
  assert.match(e256.out, /would NOT be allowed under mode dynamic, source all-providers, ctx 256k: it has less than 256k of known context and the context floor is 256k/);
  assert.match(e.out, /^rank: position \d+ of \d+.*first strike=0, big step \(v only\)=\d, L4 \(v only\)=\d, ttft quantile bucket=\d, ctx class=4, price 2b=\d, recency \(order only, calendar-dependent\)=\d, alias=\d/m);
});

test("wizard: the context question offers the hard floors and the soft preferences, prints the rows per floor above it, and answer 2 and 3 keep their old meaning (prefer-1m, 1m)", async () => {
  const outs = [], asked = [];
  const answers = ["2", "6", "y"];
  const res = await runWizard({ isTTY: true, ask: async (p) => { asked.push(p); return answers.shift() ?? ""; }, out: (l) => outs.push(l), cli: "CLI", mainOutsideFree: async () => false,
    preview: async () => 0, save: async (f) => { outs.push(`SAVE ${flagsText(f)}`); return 0; }, ctxFloorLine: async (free) => `FLOORS(${free})` });
  assert.equal(res.code, 0);
  const text = outs.join("\n");
  assert.match(text, /FLOORS\(false\)/);
  for (const w of ["only 1M", "only models with at least 128k", "at least 200k", "at least 256k", "at least 512k", "prefer 256k or more", "prefer 512k or more", "prefer 1M"]) assert.ok(text.includes(w), w);
  assert.match(text, /SAVE .*--ctx 256k/, "answer 6 is the 256k floor");
  const old = ["3", "2", "y"], o2 = [];
  const r2 = await runWizard({ isTTY: true, ask: async () => old.shift() ?? "", out: (l) => o2.push(l), cli: "CLI", mainOutsideFree: async () => false, preview: async () => 0, save: async (f) => { o2.push(`SAVE ${flagsText(f)}`); return 0; } });
  assert.equal(r2.code, 0);
  assert.match(o2.join("\n"), /SAVE .*--ctx prefer-1m/, "answer 2 still means prefer-1m");
});

test("F1: a policy compiled by an OLDER compiler (stamp 1) is rebuilt by `rebuild --if-stale yes` and the next call is up to date; the stamp is outside the hash and minRouter is unchanged, so the router reads both", async () => {
  const s = setup();
  assert.equal((await SET(s, ...DYN)).status, 0);
  const c = rd(s.compiled);
  assert.equal(c.builtFrom.compiler, lib.COMPILER_VERSION); assert.equal(lib.COMPILER_VERSION, 2);
  assert.equal((await run(["rebuild", "--if-stale", "yes", ...s.F])).out, "up to date: nothing to rebuild", "a current file is not rebuilt");
  const old = { ...c, builtFrom: { ...c.builtFrom, compiler: 1 } };
  wr(s.compiled, old);
  assert.equal(lib.hashOf(old), old.contentHash, "the compiler stamp is not routing content: the old file still verifies");
  const r = await run(["rebuild", "--if-stale", "yes", ...s.F]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^rebuilt /m, "the old stamp is stale");
  const fresh = rd(s.compiled);
  assert.equal(fresh.builtFrom.compiler, 2);
  assert.deepEqual([fresh.minRouter, fresh.contentHash], [old.minRouter, old.contentHash], "minRouter and the hash are unchanged: only the stamp moved");
  assert.equal((await run(["rebuild", "--if-stale", "yes", ...s.F])).out, "up to date: nothing to rebuild");
});

// `node keysync/key.mjs subagent-policy ...` end to end on the fixture trio (plan 7, 9.1, 12 S1). Every run passes the
// fixture flag set (so rpc() is never reached) and runs with USERPROFILE, HOME and APPDATA pointed at a temp directory. A
// no-touch guard fingerprints the real ~/.llmkeys, state/subagent and service.json before and after the whole file.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fixtureFlagMap, checkFixtureDir, materialize } from "./fixtures/subagent-flags.mjs";
import * as lib from "../keysync/subagent-policy.mjs";
import { realFileHashes, assertRealFilesUntouched } from "./fixtures/no-real-state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(ROOT, "keysync", "key.mjs");
const FLAGS = path.join(ROOT, "test", "fixtures", "subagent-flags.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-cli-"));
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const wr = (f, o) => fs.writeFileSync(f, typeof o === "string" ? o : JSON.stringify(o));

// ---- no-touch guard (9.1 principle): names, sizes and mtimes of what a test must never change
function fingerprint() {
  const home = os.homedir(), out = {};
  // sa-H: the LIVE router (and the keysync sweeps beside it) write their own logs, status files and per-session state into state/subagent while this suite runs, so those are not what a test could have
  // touched: they are left out (names only, by the router's own file-name rules). policy.json, shadow.flag, the owner files and everything else a CLI command writes stay fingerprinted.
  const LIVE_ROUTER_OUT = /^((agents|classify|decisions)(\.\d+)?\.jsonl|status(-[A-Za-z0-9_-]{1,64})?\.json|(main|agents)-[A-Za-z0-9_-]{1,64}\.(json|jsonl)|cooling\.json|[^\\/]*\.lock|[^\\/]*\.tmp-[^\\/]*)$/;
  const walk = (d) => { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (LIVE_ROUTER_OUT.test(e.name) && d.endsWith(path.join(".uw", "state", "subagent"))) continue; else { try { const s = fs.statSync(f); out[f] = `${s.size}:${s.mtimeMs}`; } catch { /* raced */ } } } };
  walk(path.join(home, ".llmkeys"));
  walk(path.join(home, ".uw", "state", "subagent"));
  // tool-fidelity.json (and its lock, temp and backup side files) is rewritten by the live tool-fidelity sweep, and bench.lock by every bench run, so neither is fingerprinted; only the files below are
  for (const f of ["accuracy.json", "autorebuild.json"]) { try { const s = fs.statSync(path.join(home, ".uw", "state", f)); out[f] = `${s.size}:${s.mtimeMs}`; } catch { out[f] = "absent"; } }
  const svc = path.join(process.env.APPDATA ?? "", "claude-code-router", "service.json");
  try { const s = fs.statSync(svc); out[svc] = `${s.size}:${s.mtimeMs}`; } catch { out[svc] = "absent"; }
  return out;
}
// Content guard for the real files a fixture helper once overwrote (hash only, never printed). bench.json, the catalog snapshot and Claude's
// settings.json must be byte-identical afterwards. observed.json is rewritten legitimately by the live observer while the suite runs, so it
// fails only when its new content is byte-for-byte a test fixture file (the incident signature), not merely because it changed.
const STRICT = ["bench", "catalogSnapshot", "claudeSettings"], SIGNATURE = ["observed"];
let before0, realHashes0;
before(() => { before0 = fingerprint(); realHashes0 = realFileHashes([...STRICT, ...SIGNATURE]); });
after(() => {
  assert.deepEqual(fingerprint(), before0, "no test in this file touched ~/.llmkeys, state/subagent or service.json");
  assertRealFilesUntouched(assert, realHashes0, realFileHashes([...STRICT, ...SIGNATURE]), { strict: STRICT, signature: SIGNATURE });
});

function setup(over = []) {
  const dir = tmp();
  const r = spawnSync(process.execPath, [FLAGS, "--dir", dir, ...over], { encoding: "utf8" });         // the helper itself, as the acceptance commands run it
  assert.equal(r.status, 0, r.stderr);
  const flags = r.stdout.trim().split(" ");
  return { dir, F: flags, state: path.join(dir, "state", "subagent"), owner: path.join(dir, "llmkeys", "subagent-policy.json") };
}
// A REAL-LOOKING home for every child process: it holds sentinel copies of everything the CLI could resolve by default (the owner
// file with enforcement ON, the vault registry, key choices, default model, Claude settings, the snapshot, the bench, a compiled
// policy). A run that follows a default path instead of the fixture flags would read or change them; the tree is hashed before
// and after EVERY cli() call and must be identical. (The helper used to hand the child an EMPTY home, which hid exactly that.)
const FX = path.join(ROOT, "test", "fixtures", "subagent");
const SENTINEL_OWNER = { schema: 1, source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "enforce", inject: "on", unverified: "allow-warn", allow: [], classLog: "on", setAt: "2026-10-01T00:00:00.000Z" };
function sentinelHome() {
  const home = tmp();
  const put = (rel, body) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); };
  const copy = (rel, src) => put(rel, fs.readFileSync(path.join(FX, src)));
  put(".llmkeys/subagent-policy.json", JSON.stringify(SENTINEL_OWNER, null, 2));
  copy(".llmkeys/registry.json", "registry.json"); copy(".llmkeys/providers.json", "vault-providers.json"); copy(".llmkeys/key-choices.json", "key-choices.json");
  copy(".llmkeys/default-model.json", "default-model.json"); copy(".claude/settings.json", "settings.json");
  copy(".uw/catalog/snapshot.json", "snapshot.json"); copy(".uw/state/bench.json", "bench.json"); copy(".uw/state/observed.json", "observed.json");
  put(".uw/state/subagent/policy.json", "{\"sentinel\":true}"); put(".uw/state/subagent/status.json", "{\"sentinel\":true}");
  return home;
}
const treeOf = (home) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(home, f)] = fs.readFileSync(f, "utf8"); } };
  walk(home);
  return out;
};
function cli(args, { env = {}, home = sentinelHome() } = {}) {
  const before = treeOf(home);
  const r = spawnSync(process.execPath, [KEY, "subagent-policy", ...args], { encoding: "utf8", timeout: 60000,
    env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home, ...env } });
  assert.deepEqual(treeOf(home), before, "the real-looking HOME (owner file, vault, settings, snapshot, bench, compiled policy) was not touched");
  return { status: r.status, out: r.stdout, err: r.stderr, first: (r.stderr || r.stdout).split("\n")[0], home };
}
const SET = (s, ...a) => cli(["set", ...a, ...s.F]);

test("acceptance 3: same-provider free is empty for the relay main: exit 2, first line E_EMPTY naming the stage, nothing written", () => {
  const s = setup();
  const r = SET(s, "--source", "same-provider", "--mode", "free", "--dry", "yes");
  assert.equal(r.status, 2);
  assert.equal(r.first, "E_EMPTY: the free providers filter removed all 3 of anthropic's candidates (main provider, likely main (default model)) under free providers; nothing written");
  assert.match(r.err, /^Fix A: node keysync\/key\.mjs subagent-policy set --source all-providers --mode free --free-scope providers --ctx any .*3 usable models/m);
  assert.equal(fs.existsSync(s.owner), false);
  const real = SET(s, "--source", "same-provider", "--mode", "free");
  assert.equal(real.status, 2);
  assert.equal(fs.existsSync(s.owner), false, "a refusal writes nothing");
  assert.equal(fs.existsSync(path.join(s.state, "policy.json")), false);
});

test("acceptance 4: all-providers free models ctx 1m: ALLOWED 1, SUBSTITUTABLE 1 and a FRAGILE warning (the fixture holds exactly one 1M free-models row)", () => {
  const s = setup();
  const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--ctx", "1m", "--detail", "yes", "--dry", "yes");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^ALLOWED: 1 model \(of 5 in the chosen scope, after the ctx 1m filter; verified 0, small 0, unverified 1\)$/m, "U2: one model, singular");
  assert.match(r.out, /^SUBSTITUTABLE: 1 of 1 allowed/m);
  assert.match(r.out, /^FRAGILE: fewer than 3 usable candidates/m);
  assert.match(r.out, /\(DRY\)/);
  assert.equal(fs.existsSync(s.owner), false);
});

test("acceptance 5: the three scope funnels carry the fixture counts: 5, 7 on 2, 9 on 4, deposit-strict-skipped 2, ALIAS 2", () => {
  const s = setup();
  const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--detail", "yes", "--dry", "yes");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /free models \.+ 5 on 3 providers \(1 >= 1M\)/);
  assert.match(r.out, /free providers \.+ 7 on 2 providers/);
  assert.match(r.out, /free providers \+ deposit \.+ 9 on 4 providers/);
  assert.match(r.out, /deposit-strict-skipped \.+ 2\b/);
  assert.match(r.out, /ALIAS \(counted separately\) \.+ 2 probe-ok pool aliases/);
  assert.match(r.out, /denominator = 18 snapshot routes/);
});

test("acceptance 6: providers and providers+deposit print the same funnels, name fx-free-b in emptyProviders and print the FREE PROMISE line", () => {
  const s = setup();
  for (const scope of ["providers", "providers+deposit"]) {
    const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", scope, "--detail", "yes", "--dry", "yes");
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /free models \.+ 5 on 3 providers/);
    assert.match(r.out, /free providers \+ deposit \.+ 9 on 4 providers/);
    assert.match(r.out, /^emptyProviders: fx-free-b/m);
    assert.match(r.out, /^FREE PROMISE: /m);
  }
  const dep = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers+deposit", "--detail", "yes", "--dry", "yes");
  assert.match(dep.out, /thinProviders: fx-dep, fx-paid/);
});

test("acceptance 7: dynamic prints the funnel; inherit with same-provider prints 'source ignored under inherit'", () => {
  const s = setup();
  const d = SET(s, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes");
  assert.equal(d.status, 0, d.err);
  assert.match(d.out, /^ALLOWED: 14 models \(of 14 in the chosen scope/m);   // 15 probe-ok selectors minus the fx-mgmt row (an excluded tier is never admitted, G17)
  const i = SET(s, "--mode", "inherit", "--source", "same-provider", "--dry", "yes");
  assert.equal(i.status, 0, i.err);
  assert.match(i.out, /source ignored under inherit/);
  const noSource = SET(s, "--mode", "inherit", "--dry", "yes");
  assert.equal(noSource.status, 0, "inherit does not require --source on the first set");
});

test("acceptance 8: --mode fixed, --free-scope with a non-free mode, --dry foo and a trailing --dry all exit 1 with E_USAGE", () => {
  const s = setup();
  const fixed = SET(s, "--mode", "fixed", "--dry", "yes");
  assert.equal(fixed.status, 1); assert.match(fixed.first, /^E_USAGE: .*inherit/);
  const fs_ = SET(s, "--mode", "dynamic", "--source", "all-providers", "--free-scope", "models", "--dry", "yes");
  assert.equal(fs_.status, 1); assert.match(fs_.first, /^E_USAGE: --free-scope is only valid with --mode free/);
  const foo = cli(["set", "--dry", "foo", ...s.F]);
  assert.equal(foo.status, 1); assert.match(foo.first, /^E_USAGE: .*yes or no/);
  const trailing = cli(["set", ...s.F, "--dry"]);
  assert.equal(trailing.status, 1); assert.match(trailing.first, /^E_USAGE: flag --dry needs an explicit value/);
  assert.equal(cli(["set", "--dry", "true", ...s.F]).status, 1);
  assert.equal(cli(["set", "--dry", "1", ...s.F]).status, 1);
  const swallow = cli(["set", "--dry", "--source", "all-providers", ...s.F]);
  assert.equal(swallow.status, 1); assert.match(swallow.first, /needs an explicit value/);
  assert.equal(cli(["set", "--dry", "no", "--mode", "dynamic", "--source", "all-providers", ...s.F]).status, 0, "no is the same as absent (and writes)");
});

test("acceptance 9: an unreadable registry refuses the providers scopes with exit 4 E_TIER_UNREADABLE; scope models compiles with the TIERS warning", () => {
  const s = setup(["--registry-file", path.join(tmp(), "nonexistent.json")]);
  const p = SET(s, "--mode", "free", "--source", "all-providers", "--free-scope", "providers", "--dry", "yes");
  assert.equal(p.status, 4); assert.equal(p.first, "E_TIER_UNREADABLE: the vault registry or key choices could not be read; free providers needs the key tier (registry missing)");
  const d = SET(s, "--mode", "free", "--source", "all-providers", "--free-scope", "providers+deposit", "--dry", "yes");
  assert.equal(d.status, 4);
  const m = SET(s, "--mode", "free", "--source", "all-providers", "--free-scope", "models", "--detail", "yes", "--dry", "yes");
  assert.equal(m.status, 0, m.err);
  assert.match(m.out, /^TIERS: registry unreadable/m);
  assert.match(m.out, /free providers \.+ unavailable/);
});

test("acceptance 10: rollback with no owner file exits 0 and creates ONLY shadow.flag, with every input missing", () => {
  const dir = tmp(), state = path.join(dir, "state");
  const r = cli(["rollback", "--state-dir", state]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(fs.readdirSync(state), ["subagent"], "only the subagent folder under the state root");
  assert.deepEqual(fs.readdirSync(path.join(state, "subagent")), ["shadow.flag"], "ONLY shadow.flag");
  assert.match(r.out, /no owner file: nothing else created/);
});

test("rollback with an owner file flips enforcement to shadow and inject off; set clears the flag", () => {
  const s = setup();
  wr(s.owner, { schema: 1, source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "enforce", inject: "on", unverified: "allow-warn", allow: [], classLog: "on" });
  const r = cli(["rollback", "--state-dir", path.join(s.dir, "state"), "--policy-file", s.owner]);
  assert.equal(r.status, 0, r.err);
  const o = rd(s.owner);
  assert.deepEqual([o.enforcement, o.inject, o.mode], ["shadow", "off", "dynamic"]);
  assert.ok(fs.existsSync(path.join(s.dir, "state", "subagent", "shadow.flag")));
  const set = SET(s, "--enforce", "shadow");
  assert.equal(set.status, 0, set.err);
  assert.equal(fs.existsSync(path.join(s.dir, "state", "subagent", "shadow.flag")), false, "set clears the flag");
});

test("first set without --source and --mode fails with usage; --dry yes writes nothing; corrupt owner file is a loud error on show and set", () => {
  const s = setup();
  const a = SET(s, "--ctx", "any");
  assert.equal(a.status, 1); assert.match(a.first, /^E_USAGE: the first `set` needs --source and --mode/);
  const b = SET(s, "--source", "all-providers");
  assert.equal(b.status, 1);
  const noSource = SET(s, "--mode", "dynamic");
  assert.equal(noSource.status, 1, "writing needs an explicit source"); assert.match(noSource.first, /^E_USAGE: the first `set` needs --source and --mode/);
  const noSourceDry = SET(s, "--mode", "dynamic", "--dry", "yes");
  assert.equal(noSourceDry.status, 0, "a dry first set previews"); assert.match(noSourceDry.out, /NOTE: no --source given on a first dry run: previewed as all-providers/);
  assert.equal(fs.existsSync(s.owner), false);
  const dry = SET(s, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes");
  assert.equal(dry.status, 0);
  assert.equal(fs.existsSync(s.owner), false); assert.equal(fs.existsSync(s.state), false, "not even the state directory");
  wr(s.owner, "{broken");
  for (const argv of [["show", ...s.F], ["set", "--source", "all-providers", "--mode", "dynamic", ...s.F]]) {
    const r = cli(argv);
    assert.equal(r.status, 4, argv[0]); assert.match(r.first, /^E_OWNER_CORRUPT: /);
  }
  assert.equal(fs.readFileSync(s.owner, "utf8"), "{broken", "never overwritten");
});

test("set writes the owner file and the compiled file (schema 1, contentHash), merges later flags, and does not rewrite an unchanged compile", () => {
  const s = setup();
  const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers+deposit", "--ctx", "any");
  assert.equal(r.status, 0, r.err);
  const o = rd(s.owner);
  assert.deepEqual([o.source, o.mode, o.freeScope, o.ctx, o.enforcement, o.inject, o.unverified, o.schema], ["all-providers", "free", "providers+deposit", "any", "shadow", "off", "allow-warn", 1]);
  const c = rd(path.join(s.state, "policy.json"));
  assert.equal(c.schema, 1); assert.equal(c.counts.allowed, 9); assert.deepEqual(c.emptyProviders, ["fx-free-b"]);
  assert.match(c.contentHash, /^[0-9a-f]{12}$/);
  const mtime = fs.statSync(path.join(s.state, "policy.json")).mtimeMs;
  const again = SET(s, "--inject", "off");
  assert.equal(again.status, 0);
  assert.match(again.out, /compiled policy unchanged/);
  assert.equal(fs.statSync(path.join(s.state, "policy.json")).mtimeMs, mtime);
  const merged = SET(s, "--ctx", "1m");
  assert.equal(merged.status, 0, merged.err);
  assert.deepEqual([rd(s.owner).mode, rd(s.owner).ctx, rd(s.owner).freeScope], ["free", "1m", "providers+deposit"], "later set merges only the flags given");
});

test("empty-set rule (D-c): empty for SOME other providers saves with a warning; empty for every provider refuses; --allow-empty yes overrides", () => {
  const s = setup();
  const ok = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers", "--detail", "yes");
  assert.equal(ok.status, 0, ok.err);
  assert.match(ok.out, /EMPTY for 1 provider\(s\).*fx-free-b/);
  assert.ok(fs.existsSync(s.owner));
  const s2 = setup();
  const none = SET(s2, "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--ctx", "1m", "--min-set", "1");
  assert.equal(none.status, 0, "one 1M free-models row exists in the fixture");
  const s3 = setup();
  wr(path.join(s3.dir, "bench.json"), { ...rd(path.join(s3.dir, "bench.json")), models: {} });                    // every bench record gone: nothing is probe-ok
  const empty = SET(s3, "--source", "all-providers", "--mode", "dynamic");
  assert.equal(empty.status, 2); assert.equal(empty.first, "E_EMPTY: the tools stage removed all 0 of all candidates; nothing written");
  assert.equal(fs.existsSync(s3.owner), false);
  const forced = SET(s3, "--source", "all-providers", "--mode", "dynamic", "--allow-empty", "yes");
  assert.equal(forced.status, 0, forced.err);
  assert.match(forced.out, /WARNING \(--allow-empty yes\)/);
  assert.equal(rd(path.join(s3.state, "policy.json")).empty, true);
  const mainEmpty = SET(setup(), "--source", "same-provider", "--mode", "free", "--allow-empty", "yes");
  assert.equal(mainEmpty.status, 0, mainEmpty.err);
});

test("free-scope: defaults to providers, accepted only with --mode free, an exit-2 refusal on an empty scope names the scope", () => {
  const s = setup();
  const d = SET(s, "--source", "all-providers", "--mode", "free", "--detail", "yes", "--dry", "yes");
  assert.match(d.out, /free-scope=providers \(free providers\)/);
  const bad = SET(s, "--source", "all-providers", "--mode", "dynamic", "--free-scope", "providers", "--dry", "yes");
  assert.equal(bad.status, 1);
  const s2 = setup();
  wr(path.join(s2.dir, "registry.json"), []);                                                                      // no free-tier provider at all
  const e = SET(s2, "--source", "all-providers", "--mode", "free", "--free-scope", "providers", "--dry", "yes");
  assert.equal(e.status, 2); assert.equal(e.first, "E_EMPTY: the free providers filter removed all 15 of all candidates under free providers; nothing written");
});

test("the test-only flags follow the all-or-nothing rule: any file flag without --policy-file, --state-dir and --providers-file is refused", () => {
  const s = setup();
  const only = (name) => { const i = s.F.indexOf(name); return [name, s.F[i + 1]]; };
  for (const f of ["--snapshot-file", "--bench-file", "--registry-file", "--key-choices-file", "--settings-file"]) {
    const r = cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes", ...only(f)]);
    assert.equal(r.status, 1, f); assert.match(r.first, /^E_USAGE: incomplete test-flag set/);
  }
  const r = cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes", ...only("--policy-file"), ...only("--state-dir")]);
  assert.equal(r.status, 1, "policy and state alone would fall through to the live gateway: refused");
});

test("ambient env vars are ignored with a printed line", () => {
  const s = setup();
  const r = cli(["show", ...s.F], { env: { UW_SUBAGENT_POLICY_FILE: "C:/elsewhere/x.json", UW_SUBAGENT_STATE_DIR: "C:/elsewhere" } });
  assert.equal(r.status, 0, r.err);
  assert.match(r.err, /ambient UW_SUBAGENT_POLICY_FILE is set and IGNORED/);
  assert.match(r.out, /policy off: no owner file at .*llmkeys/, "the explicit flag won, not the ambient variable");
});

test("show: 'policy off' with no files; with a policy it prints owner, compiled summary with the three free-scope funnels, staleness, the helper-call statement", () => {
  const s = setup();
  const off = cli(["show", "--detail", "yes", ...s.F]);
  assert.equal(off.status, 0); assert.match(off.out, /^policy off: no owner file at .*llmkeys.*subagent-policy\.json \(the router behaves exactly as before\)$/m);
  assert.match(off.out, /HELPER CALLS: free governs subagents with tools; background helper calls \(titles, summaries, compaction, small-fast\) still use the relay in every mode/);
  SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers");
  const on = cli(["show", "--detail", "yes", ...s.F]);
  assert.equal(on.status, 0, on.err);
  assert.match(on.out, /^policy: mode free \(free providers\), source all-providers, ctx any, enforcement shadow$/m);
  assert.match(on.out, /^ {2}owner file .*subagent-policy\.json: unverified=allow-warn allow=0 inject=off setAt=\d{4}-/m);
  assert.match(on.out, /^ {2}compiled \d{4}-\S+, contentHash [0-9a-f]{12}, compiler 3, providersLive false$/m);
  assert.match(on.out, /free models \.+ 5 on 3 providers/); assert.match(on.out, /free providers \+ deposit \.+ 9 on 4 providers/);
  assert.match(on.out, /^7 of 7 eligible models are not tool-tested/m);
  assert.match(on.out, /^ {2}providers with no usable stand-in: fx-free-b \(1 of 2\); thin, fewer than 3 usable: none \(0 of 2\)$/m);
  assert.match(on.out, /status: no status\.json yet/);
  wr(path.join(s.state, "shadow.flag"), "x");
  assert.match(cli(["show", ...s.F]).out, /ROLLBACK FLAG PRESENT/);
  SET(s, "--mode", "dynamic");                                          // compiled now matches again
  wr(s.owner, { ...rd(s.owner), mode: "free" });                       // owner edited by hand: compiled is stale
  assert.match(cli(["show", ...s.F]).out, /policy not applied/);
  const set = SET(s, "--source", "all-providers", "--mode", "dynamic");
  assert.match(set.out, /HELPER CALLS: free governs subagents with tools/);
});

test("show reads a status.json written by the router and the inherit premium-main warning", () => {
  const s = setup();
  wr(path.join(s.dir, "default-model.json"), { model: "anthropic/claude-opus-5" });
  SET(s, "--mode", "inherit", "--source", "same-provider");
  fs.mkdirSync(s.state, { recursive: true });
  wr(path.join(s.state, "status.json"), { schema: 1, updatedAt: new Date().toISOString(), counters: { req: 7, main: 2, sub: 4, aux: 1, substitute: 3, error: 0 },
    warnings: [{ code: "EMPTY_SET", since: "x", detail: "mainProvider=groq" }], mainBySession: { a1b2c3d4: { model: "anthropic/claude-opus-5", t: new Date().toISOString() } } });
  const r = cli(["show", ...s.F]);
  assert.match(r.out, /INHERIT PREMIUM MAIN: the likely main anthropic\/claude-opus-5 is Opus- or Fable-priced/);
  assert.match(r.out, /7 requests: main 2, sub 4, aux 1; 3 of 4 sub requests moved to another model; 0 of 7 requests hit an internal error/, "U4: every raw counter carries its denominator");
  assert.match(r.out, /router warning EMPTY_SET: mainProvider=groq/);
  assert.match(r.out, /main of session a1b2c3d4: anthropic\/claude-opus-5/);
});

test("clear removes the owner file, the compiled file, shadow.flag and the session files, and exits 0 even when absent", () => {
  const s = setup();
  SET(s, "--source", "all-providers", "--mode", "dynamic");
  for (const f of ["main-s1.json", "agents-s1.json", "shadow.flag", "decisions.jsonl"]) wr(path.join(s.state, f), "{}");
  const r = cli(["clear", "--policy-file", s.owner, "--state-dir", path.join(s.dir, "state")]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(fs.readdirSync(s.state).sort(), ["decisions.jsonl"], "logs stay; policy, flag and session files go");
  assert.equal(fs.existsSync(s.owner), false);
  assert.equal(cli(["clear", "--policy-file", s.owner, "--state-dir", path.join(s.dir, "state")]).status, 0);
});

test("explain: exit 3 E_UNKNOWN_MODEL for an unknown id; a full answer for a known one; a dropped route says why; --tool-fidelity-file is read from the fixture", () => {
  const s = setup();
  const u = cli(["explain", "nope/missing", ...s.F]);
  assert.equal(u.status, 3); assert.match(u.first, /^E_UNKNOWN_MODEL: /);
  const e = cli(["explain", "fx-free-a/fxa-big:free", ...s.F]);
  assert.equal(e.status, 0, e.err);
  for (const re of [/found: yes \(2 snapshot route\(s\) collapse to this selector\)/, /key tier: free \(source: vault registry; key id personal\.fx-free-a\.free\)/, /ALIAS: no; free tag: yes/,
    /ctx: 1,000,000/, /n:1 listing-only/, /free models: PASS/, /free providers: PASS/, /free providers \+ deposit: PASS/, /rank: position \d+ of 14/]) assert.match(e.out, re);
  const dep = cli(["explain", "fx-dep/fxd-plain", ...s.F]);
  assert.match(dep.out, /free providers \+ deposit: FAIL \(deposit-strict-skipped: no free tag on a free-deposit provider\)/);
  const rel = cli(["explain", "anthropic/claude-sonnet-5-5[1m]", ...s.F]);
  assert.match(rel.out, /tool tier: v \(provenance\)/); assert.match(rel.out, /free models: FAIL \(tier subscription is in no free scope\)/);
  const alias = cli(["explain", "fx-free-a/kilo-auto/free", ...s.F]);
  assert.match(alias.out, /ALIAS: yes \(pool rule/);
  wr(path.join(s.dir, "tool-fidelity.json"), { schema: 1, models: { "fx-free-a/fxa-alpha": { t: "t" } } });
  assert.match(cli(["explain", "fx-free-a/fxa-alpha", ...s.F]).out, /tool tier: t \(tool-fidelity\), tool-fidelity record present/);
  assert.ok(!/proven to accept/.test(cli(["explain", "fx-free-a/fxa-alpha", ...s.F]).out), "no big step result: nothing is claimed");
  wr(path.join(s.dir, "tool-fidelity.json"), { schema: 1, models: { "fx-free-a/fxa-alpha": { t: "t", lvr: "ppnn", big: "p" }, "fx-free-a/fxa-beta": { t: "t", lvr: "ppnn", big: "f" } } });
  assert.match(cli(["explain", "fx-free-a/fxa-alpha", ...s.F]).out, /^proven to accept 400 KB \(400,000 bytes\): the tool sweep's big step passed \(compiled as bk 400000; .*it changes no tier, rank or count here\)$/m);
  assert.ok(!/proven to accept/.test(cli(["explain", "fx-free-a/fxa-beta", ...s.F]).out), "a failed big step is never reported as proof");
  const gone = cli(["explain", "fx-free-a/fxa-dead", ...s.F]);
  assert.equal(gone.status, 0); assert.match(gone.out, /stage: bench-gone/);
});

test("rebuild: recompiles the current owner file; --if-stale yes is a no-op when nothing changed; a model flipped to pay leaves only after rebuild; never changes the owner file", () => {
  const s = setup();
  assert.equal(cli(["rebuild", ...s.F]).status, 1, "no owner file");
  SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers");
  const ownerBefore = fs.readFileSync(s.owner, "utf8");
  const noop = cli(["rebuild", "--if-stale", "yes", ...s.F]);
  assert.equal(noop.status, 0, noop.err); assert.match(noop.out, /up to date: nothing to rebuild/);
  const quiet = cli(["rebuild", "--if-stale", "yes", "--quiet", "yes", ...s.F]);
  assert.equal(quiet.out, "", "quiet: nothing printed");
  assert.ok(rd(path.join(s.state, "policy.json")).models.some((m) => m.s === "fx-free-a/fxa-alpha"));
  wr(path.join(s.dir, "observed.json"), { schema: 1, writtenAt: "2026-10-03T12:00:00.000Z", feed: "ok", models: { "fx-free-a/fxa-alpha": { s: "pay", t: 100, a: 1790800000, l: 1 } } });
  assert.ok(rd(path.join(s.state, "policy.json")).models.some((m) => m.s === "fx-free-a/fxa-alpha"), "still listed until the rebuild");
  const stale = cli(["rebuild", "--if-stale", "yes", ...s.F]);
  assert.equal(stale.status, 0, stale.err); assert.match(stale.out, /rebuilt /);
  assert.ok(!rd(path.join(s.state, "policy.json")).models.some((m) => m.s === "fx-free-a/fxa-alpha"), "excluded after the rebuild");
  assert.equal(fs.readFileSync(s.owner, "utf8"), ownerBefore, "rebuild never changes the owner file");
  const s2 = setup();
  wr(path.join(s2.dir, "bench.json"), { ...rd(path.join(s2.dir, "bench.json")), models: {} });
  wr(s2.owner, { schema: 1, source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", allow: [], classLog: "on" });
  const empty = cli(["rebuild", ...s2.F]);
  assert.equal(empty.status, 2); assert.match(empty.first, /^E_EMPTY: the compiled policy is empty/);
  assert.equal(rd(path.join(s2.state, "policy.json")).empty, true, "written with empty: true");
});

// F13 + F20: a fixture flag set can never satisfy the live-gateway check; a gateway-down compile cannot enforce either, whatever the wall clock says
test("--enforce enforce: refused with E_PRECONDITION whenever the Providers are not live: a fixture providers file (even with a fresh classifier PASS) and a gateway-down compile", () => {
  const s = setup();
  const r = SET(s, "--source", "all-providers", "--mode", "dynamic", "--enforce", "enforce");
  assert.equal(r.status, 1); assert.match(r.first, /^E_PRECONDITION: --enforce enforce needs live Providers/);
  assert.equal(fs.existsSync(s.owner), false, "a refusal writes nothing");
  fs.mkdirSync(s.state, { recursive: true });
  wr(path.join(s.state, "accuracy.json"), { at: new Date().toISOString(), verdict: "PASS" });
  const withPass = SET(s, "--source", "all-providers", "--mode", "dynamic", "--enforce", "enforce");
  assert.equal(withPass.status, 1, "the fixture providers file is not live, so no fixture flag set can satisfy the gateway check");
  assert.match(withPass.first, /^E_PRECONDITION: .*needs live Providers/);
  assert.equal(fs.existsSync(s.owner), false);
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic", "--enforce", "shadow").status, 0, "shadow needs nothing");
  // gateway down: the providers file is missing. The snapshot stamps are made FRESH here, so the verdict does not depend on the wall clock
  // (the fixture stamps are 2026-10-01 and would age past the 7-day trust window)
  const down = setup(["--providers-file", path.join(tmp(), "gone.json")]);
  const snapPath = path.join(down.dir, "snapshot.json"), snap = rd(snapPath);
  snap.routableAsOf = new Date().toISOString(); snap.builtAt = new Date().toISOString(); wr(snapPath, snap);
  fs.mkdirSync(down.state, { recursive: true });
  wr(path.join(down.state, "accuracy.json"), { at: new Date().toISOString(), verdict: "PASS" });
  const dn = SET(down, "--source", "all-providers", "--mode", "dynamic", "--enforce", "enforce", "--dry", "yes");
  assert.equal(dn.status, 1, "exit 1");
  assert.match(dn.first, /^E_PRECONDITION: --enforce enforce needs live Providers \(a gateway-down compile cannot prove resolvability\)/);
  assert.match(dn.out + dn.err, /PROVIDERS: live Providers unreadable|^E_PRECONDITION/m);
});

test("F13: rebuild with an owner file that says enforce keeps the router in shadow behaviour and surfaces CLASSIFIER_UNMEASURED; show says so instead of STALE", () => {
  const s = setup();
  wr(s.owner, { ...SENTINEL_OWNER, setAt: undefined });
  fs.mkdirSync(s.state, { recursive: true });
  wr(path.join(s.state, "accuracy.json"), { at: new Date().toISOString(), verdict: "PASS" });          // even a fresh PASS: the fixture providers are not live
  const r = cli(["rebuild", ...s.F]);
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /^CLASSIFIER_UNMEASURED: the owner file says enforcement=enforce but --enforce enforce needs live Providers/m);
  const c = rd(path.join(s.state, "policy.json"));
  assert.equal(c.owner.enforcement, "shadow", "the compiled file the router reads carries shadow");
  assert.equal(c.gate.code, "CLASSIFIER_UNMEASURED");
  assert.equal(rd(s.owner).enforcement, "enforce", "the owner file is never changed by a rebuild");
  const show = cli(["show", ...s.F]);
  assert.match(show.out, /^CLASSIFIER_UNMEASURED: /m); assert.ok(!/STALE: the owner file differs/.test(show.out), "a gated rebuild is not 'stale'");
  // the case it must not break: with the preconditions met the same owner compiles as enforce and carries no gate. Run in-process (the CLI cannot supply a live gateway).
  const dir = tmp(), flags = fixtureFlagMap(dir);
  return (async () => {
    const lib = await import("../keysync/subagent-policy.mjs");
    const p = lib.resolvePaths(flags);
    const live = await lib.gatherInputs(p, { liveProviders: await lib.readProviders(p) });
    fs.mkdirSync(p.stateDir, { recursive: true }); wr(path.join(p.stateDir, "accuracy.json"), { at: new Date().toISOString(), verdict: "PASS" });
    assert.doesNotThrow(() => lib.checkEnforcePreconditions(p, live, { ...SENTINEL_OWNER }));
    const ok = lib.compile(live, { ...lib.OWNER_DEFAULTS, ...SENTINEL_OWNER }).compiled;
    assert.equal(ok.owner.enforcement, "enforce"); assert.equal(ok.gate, undefined);
  })();
});


test("--allow pins an unverified model under allow-t and is stored once per pin; a malformed pin is a usage error", () => {
  const s = setup();
  wr(path.join(s.dir, "tool-fidelity.json"), { schema: 1, models: { "fx-free-a/fxa-alpha": { t: "t" } } });
  const base = SET(s, "--source", "all-providers", "--mode", "dynamic", "--unverified", "allow-t", "--dry", "yes");
  assert.match(base.out, /^ALLOWED: 4 models/m, "v (3 relay) and t (1), of 15");
  const pinned = SET(s, "--source", "all-providers", "--mode", "dynamic", "--unverified", "allow-t", "--allow", "fx-free-b/fxb-one", "--allow", "fx-dep/fxd-plain");
  assert.equal(pinned.status, 0, pinned.err);
  assert.match(pinned.out, /^ALLOWED: 6 models/m);
  assert.deepEqual(rd(s.owner).allow, ["fx-free-b/fxb-one", "fx-dep/fxd-plain"]);
  assert.equal(SET(s, "--allow", "not a pin").status, 1);
});

test("exit codes: 0 ok, 1 usage, 2 empty, 3 unknown model, 4 (corrupt owner, unreadable registry, corrupt key choices, ambiguous key, bad snapshot), 5 write failure", () => {
  const s = setup();
  assert.equal(cli(["show", ...s.F]).status, 0);
  assert.equal(cli(["bogus"]).status, 1);
  assert.equal(SET(s, "--source", "same-provider", "--mode", "free", "--dry", "yes").status, 2);
  assert.equal(cli(["explain", "x/y", ...s.F]).status, 3);
  const c1 = setup(); wr(c1.owner, "{"); assert.equal(cli(["show", ...c1.F]).status, 4);
  const c2 = setup(["--registry-file", path.join(tmp(), "n.json")]);
  const r2 = SET(c2, "--source", "all-providers", "--mode", "free", "--dry", "yes"); assert.equal(r2.status, 4); assert.match(r2.first, /^E_TIER_UNREADABLE/);
  const c3 = setup(); wr(path.join(c3.dir, "key-choices.json"), "{bad");
  const r3 = SET(c3, "--source", "all-providers", "--mode", "free", "--dry", "yes"); assert.equal(r3.status, 4); assert.match(r3.first, /^E_TIER_UNREADABLE/); assert.match(r3.first, /key choices corrupt/);
  const c4 = setup();
  const reg = rd(path.join(c4.dir, "registry.json")); reg.push({ ...reg[0], id: "personal.fx-free-a.paid", tier: "paid", envVarName: "LLM_X" }); wr(path.join(c4.dir, "registry.json"), reg);
  const r4 = SET(c4, "--source", "all-providers", "--mode", "free", "--dry", "yes"); assert.equal(r4.status, 4); assert.match(r4.first, /^E_KEY_AMBIGUOUS: /); assert.match(r4.first, /fx-free-a/);
  const r4b = SET(c4, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes"); assert.equal(r4b.status, 0, "dynamic does not need tiers: ambiguity does not block it");
  const c5 = setup(); fs.rmSync(path.join(c5.dir, "snapshot.json"));
  const r5 = SET(c5, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes"); assert.equal(r5.status, 4); assert.match(r5.first, /E_SNAPSHOT:missing/);
  const c5b = setup(); fs.rmSync(path.join(c5b.dir, "bench.json"));
  assert.match(SET(c5b, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes").first, /E_SNAPSHOT:bench-missing/);
  const c6 = setup();
  fs.rmSync(path.join(c6.dir, "state"), { recursive: true }); fs.mkdirSync(path.join(c6.dir, "state")); wr(path.join(c6.dir, "state", "subagent"), "i am a file, not a directory");
  const r6 = SET(c6, "--source", "all-providers", "--mode", "dynamic");
  assert.equal(r6.status, 5); assert.match(r6.first, /^E_WRITE: /);
});

test("no secret, key id of a real vault or config object is printed; output is the policy report only", () => {
  const s = setup();
  const out = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers+deposit");
  const text = out.out + out.err + fs.readFileSync(path.join(s.state, "policy.json"), "utf8") + fs.readFileSync(s.owner, "utf8");
  assert.ok(!/api_key|apikey|bearer|password|secret|sk-[A-Za-z0-9]{8}/i.test(text), "no credential material in anything written or printed");
  assert.ok(!/LLM_PERSONAL/.test(text), "env var names are not copied into the compiled file");
});

// =====================================================================================================================
// Fix round S1/S1c (F1 F3 F6 F9 F11 F19 F21 F24). Every cli() call below also asserts the real-looking HOME stayed identical.
// =====================================================================================================================
const stateOf = (s) => path.join(s.dir, "state");

test("F6a: rollback and clear with --state-dir ALONE never resolve the owner file to the real one (the sentinel owner in the real-looking HOME survives); --policy-file alone is refused", () => {
  const s = setup();
  const home = sentinelHome();
  const owner = path.join(home, ".llmkeys", "subagent-policy.json"), before = fs.readFileSync(owner, "utf8");
  const r = cli(["rollback", "--state-dir", stateOf(s)], { home });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(fs.readdirSync(path.join(stateOf(s), "subagent")), ["shadow.flag"], "ONLY shadow.flag (acceptance 10 verbatim)");
  assert.equal(fs.readFileSync(owner, "utf8"), before, "the sentinel owner file (enforcement ON) was not flipped to shadow");
  assert.match(JSON.parse(before).enforcement, /^enforce$/);
  const c = cli(["clear", "--state-dir", stateOf(s)], { home });
  assert.equal(c.status, 0, c.err); assert.match(c.out, /no owner file named: it was left alone/);
  assert.equal(fs.readFileSync(owner, "utf8"), before, "clear with --state-dir alone left the sentinel owner file in place");
  assert.equal(fs.existsSync(path.join(stateOf(s), "subagent", "shadow.flag")), false, "clear did remove the fixture's own flag");
  for (const cmd of ["rollback", "clear"]) {
    const alone = cli([cmd, "--policy-file", s.owner], { home });
    assert.equal(alone.status, 1, cmd); assert.match(alone.first, /^E_USAGE: incomplete test-flag set: --policy-file requires --state-dir too for /);
    assert.equal(fs.readFileSync(owner, "utf8"), before);
  }
});

test("F6b: a fixture run that forgot a file flag FAILS instead of quietly reading the real default (snapshot, bench, registry, key choices, vault providers, settings, default model)", () => {
  const s = setup();
  const get = (n) => [n, s.F[s.F.indexOf(n) + 1]];
  const three = [...get("--policy-file"), ...get("--state-dir"), ...get("--providers-file")];      // the old minimum: it let every other file default to the real one
  const a = cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes", ...three]);
  assert.equal(a.status, 4, "the real-looking HOME holds a valid snapshot and bench; they must not be found"); assert.match(a.first, /^E_SNAPSHOT:missing/);
  const five = [...three, ...get("--snapshot-file"), ...get("--bench-file"), ...get("--observed-file")];
  const b = cli(["set", "--source", "all-providers", "--mode", "free", "--free-scope", "providers", "--dry", "yes", ...five]);
  assert.equal(b.status, 4, "the vault registry in the real-looking HOME must not supply the tiers"); assert.match(b.first, /^E_TIER_UNREADABLE: /);
  const c = cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes", ...five]);
  assert.equal(c.status, 0, c.err);
  assert.ok(!/SUBAGENT_OVERRIDE_SET/.test(c.out), "the settings of the real-looking HOME were not read");
  const d = cli(["set", "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--detail", "yes", "--dry", "yes", ...five]);
  assert.equal(d.status, 0, d.err); assert.match(d.out, /^TIERS: registry unreadable/m, "strict fallback with the warning, not the HOME registry");
  const e = cli(["show", ...get("--policy-file"), ...get("--state-dir")]);
  assert.equal(e.status, 0, e.err); assert.match(e.out, /policy off: no owner file at .*llmkeys/);
});

test("F6c: clear refuses a --policy-file that does not parse as an owner file (another file, a corrupt file, a text file) and still removes a real owner file", () => {
  const s = setup();
  const other = path.join(s.dir, "important.json");
  for (const body of ['{"hello":1}', "{broken", "dear diary, do not delete", "[]"]) {
    wr(other, body);
    const r = cli(["clear", "--policy-file", other, "--state-dir", stateOf(s)]);
    assert.equal(r.status, 1, body); assert.match(r.first, /^E_USAGE: refusing to remove .*important\.json: it does not parse as an owner policy file/);
    assert.equal(fs.readFileSync(other, "utf8"), body, "left exactly as it was");
  }
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  assert.equal(cli(["clear", "--policy-file", s.owner, "--state-dir", stateOf(s)]).status, 0);
  assert.equal(fs.existsSync(s.owner), false, "a real owner file is removed");
});

test("F6d: the fixture helper refuses a directory outside os.tmpdir() or one that is not empty, never overwrites, and leaves a sentinel file unchanged", () => {
  const FXH = { checkFixtureDir, materialize };
  // the refusal rules have no side effect, so they can be aimed at the REAL folders (this is what went wrong once: the helper was run with --dir on them)
  for (const dir of [path.join(os.homedir(), ".uw", "state"), path.join(ROOT, "test"), ROOT, os.homedir(), os.tmpdir(), path.join(os.tmpdir(), "..", "uw-guard-escape")]) {
    assert.throws(() => FXH.checkFixtureDir(dir), /must be inside|absent or empty/, dir);
  }
  const d = tmp(); wr(path.join(d, "bench.json"), "SENTINEL");                                // a fixture-named file that already exists
  assert.throws(() => FXH.materialize(d), /absent or empty/);
  const r = spawnSync(process.execPath, [FLAGS, "--dir", d], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /absent or empty/);
  assert.deepEqual(fs.readdirSync(d), ["bench.json"], "nothing else was created in it");
  assert.equal(fs.readFileSync(path.join(d, "bench.json"), "utf8"), "SENTINEL", "and the existing file is byte for byte as it was");
  const e = tmp();
  FXH.materialize(e);
  assert.ok(fs.existsSync(path.join(e, "snapshot.json")) && fs.existsSync(path.join(e, "state")) && fs.existsSync(path.join(e, "llmkeys")));
  wr(path.join(e, "bench.json"), "EDITED");
  FXH.materialize(e);                                                                       // the acceptance commands re-run the helper on one directory
  assert.equal(fs.readFileSync(path.join(e, "bench.json"), "utf8"), "EDITED", "COPYFILE_EXCL: a re-run does not overwrite");
  const f = path.join(tmp(), "absent-child");
  FXH.materialize(f); assert.ok(fs.existsSync(path.join(f, "bench.json")), "an absent directory under os.tmpdir() is created");
});

test("F1: set --inject on then --inject off leaves the compiled owner.inject OFF (the hash covers the whole owner block, inject included)", () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic", "--inject", "on").status, 0);
  const on = rd(path.join(s.state, "policy.json"));
  assert.equal(on.owner.inject, "on"); assert.notEqual(on.inject.all, "");
  const off = SET(s, "--inject", "off");
  assert.equal(off.status, 0, off.err);
  const c = rd(path.join(s.state, "policy.json"));
  assert.equal(c.owner.inject, "off", "the router reads owner.inject: it must not keep rewriting the Agent tool description");
  assert.notEqual(c.contentHash, on.contentHash);
  assert.equal(rd(s.owner).inject, "off");
});

test("F3: an unrelated snapshot row refreshes the counts in the compiled file but not the hash or the injected text (no prompt-cache miss)", () => {
  const s = setup();
  SET(s, "--source", "all-providers", "--mode", "dynamic", "--inject", "on");
  const c1 = rd(path.join(s.state, "policy.json"));
  const snap = rd(path.join(s.dir, "snapshot.json")); snap.rows[2].models.push({ ...snap.rows[2].models[0], id: "unrelated-image", outModality: "image" }); wr(path.join(s.dir, "snapshot.json"), snap);
  const r = cli(["rebuild", ...s.F]);
  assert.equal(r.status, 0, r.err);
  const c2 = rd(path.join(s.state, "policy.json"));
  assert.equal(c2.counts.universe, c1.counts.universe + 1, "the counts in the file are current (of 18 snapshot routes, one more)");
  assert.equal(c2.contentHash, c1.contentHash, "the hash is routing content only");
  assert.deepEqual(c2.inject, c1.inject, "so the injected text did not rotate");
  const again = cli(["rebuild", ...s.F]);
  assert.match(again.out, /unchanged, not rewritten/);
});

test("F9: more than 24 --allow pins is a usage error and writes nothing (the saved owner file must always load again)", () => {
  const s = setup();
  const pins = Array.from({ length: 25 }, (_, i) => ["--allow", `fx-free-a/m${i}`]).flat();
  const r = SET(s, "--source", "all-providers", "--mode", "dynamic", ...pins);
  assert.equal(r.status, 1); assert.match(r.first, /^E_USAGE: too many --allow pins: 25 \(limit 24\)/);
  assert.equal(fs.existsSync(s.owner), false);
  const ok = SET(s, "--source", "all-providers", "--mode", "dynamic", ...pins.slice(0, 48));
  assert.equal(ok.status, 0, ok.err);
  assert.equal(cli(["show", ...s.F]).status, 0, "the file written with 24 pins loads again");
});

test("F11: valid-JSON hostile compiled, status and registry files end in a clear error or a repair, never a raw TypeError", () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const noCrash = (r) => assert.ok(!/TypeError|ReferenceError|at file:|node:internal/.test(r.err + r.out), `no raw crash text: ${(r.err + r.out).slice(0, 200)}`);
  for (const hostile of ["{}", "null", "[]", "5", '{"schema":1}', '{"schema":1,"owner":{},"counts":{},"models":[null],"lists":{}}']) {
    wr(path.join(s.state, "policy.json"), hostile);
    const sh = cli(["show", ...s.F]);
    assert.equal(sh.status, 4, hostile); assert.match(sh.first, /^E_COMPILED_CORRUPT: .*not a compiled policy.*run `rebuild`/); noCrash(sh);
    const rb = cli(["rebuild", "--if-stale", "yes", ...s.F]);
    assert.equal(rb.status, 0, `${hostile}: ${rb.err}`); assert.match(rb.out, /rebuilt /); noCrash(rb);
    assert.equal(rd(path.join(s.state, "policy.json")).schema, 1, "the rebuild repaired it");
    wr(path.join(s.state, "policy.json"), hostile);
    const st = SET(s, "--ctx", "any");
    assert.equal(st.status, 0, `${hostile}: ${st.err}`); noCrash(st);
  }
  for (const hostile of ["null", "[]", "7", '{"warnings":5,"mainBySession":7,"counters":3}', '{"warnings":[null,7,{"code":"X"}],"mainBySession":{"a":null,"b":5}}']) {
    wr(path.join(s.state, "status.json"), hostile);
    const sh = cli(["show", ...s.F]);
    assert.equal(sh.status, 0, `${hostile}: ${sh.err}`); noCrash(sh);
    const set = SET(s, "--ctx", "any");
    assert.equal(set.status, 0, `${hostile}: ${set.err}`); noCrash(set);                       // the refusal rule reads the status file too
  }
  for (const hostile of ["[null]", '[{"id":"x"}]', '[{"id":"x","provider":"fx-free-a","tier":"free"},null]']) {
    wr(path.join(s.dir, "registry.json"), hostile);
    const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers", "--dry", "yes");
    assert.equal(r.status, 4, hostile); assert.match(r.first, /^E_TIER_UNREADABLE: /); noCrash(r);
    assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic", "--dry", "yes").status, 0, "dynamic needs no tiers");
  }
});

test("F19: rollback with a corrupt owner file still sets the flag and SAYS SO: the success line, then the corrupt-file error, never a bare error after a set flag", () => {
  const s = setup();
  wr(s.owner, "{broken");
  const r = cli(["rollback", "--state-dir", stateOf(s), "--policy-file", s.owner]);
  assert.equal(r.status, 4);
  assert.match(r.out.split("\n")[0], /^PAUSED: Subagents run exactly as they asked, from the next request\. Your toggles are kept\. To continue: node keysync\/key\.mjs subagent-policy resume --live yes$/);
  assert.match(r.out, /^rollback: wrote .*shadow\.flag \(the owner file could NOT be changed, see below\); the router acts as shadow from its next request/m);
  assert.match(r.err, /^E_OWNER_CORRUPT: /); assert.match(r.err, /the flag IS set and the router acts as shadow/);
  assert.ok(fs.existsSync(path.join(stateOf(s), "subagent", "shadow.flag")));
  assert.equal(fs.readFileSync(s.owner, "utf8"), "{broken", "the corrupt owner file is not overwritten");
});

test("F21: strings the router wrote are printed without control characters (an escape sequence in a model name or a warning detail)", () => {
  const s = setup();
  SET(s, "--source", "all-providers", "--mode", "dynamic");
  const now = new Date().toISOString(), esc = String.fromCharCode(27), bel = String.fromCharCode(7);
  wr(path.join(s.state, "status.json"), { schema: 1, updatedAt: now, counters: {}, warnings: [{ code: `X${esc}[31m`, detail: `evil${esc}]0;pwn${bel}` }],
    mainBySession: { [`ab${esc}cd`]: { model: `m${esc}[2Jx`, t: now } } });
  const r = cli(["show", ...s.F]);
  assert.equal(r.status, 0, r.err);
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(r.out), "no control character reaches the terminal");
  assert.match(r.out, /router warning X\?\[31m: evil\?\]0;pwn\?/);
  assert.match(r.out, /main of session ab\?cd: m\?\[2Jx/);
});

test("F24: scope free models never exits E_KEY_AMBIGUOUS (strict rule plus a KEY_AMBIGUOUS warning); the provider scopes keep exit 4", () => {
  const s = setup();
  const reg = rd(path.join(s.dir, "registry.json")); reg.push({ ...reg[0], id: "personal.fx-free-a.paid", tier: "paid", envVarName: "LLM_X" }); wr(path.join(s.dir, "registry.json"), reg);
  const m = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--detail", "yes", "--dry", "yes");
  assert.equal(m.status, 0, m.err);
  assert.match(m.out, /^KEY_AMBIGUOUS: 1 provider\(s\) have several keys and no recorded choice, so no tier: fx-free-a; scope free models applies the STRICT rule to them \(free tag only\)/m);
  assert.match(m.out, /^NO_TIER: 1 of \d+ providers with probe-ok models have no resolvable key tier/m);
  for (const scope of ["providers", "providers+deposit"]) {
    const e = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", scope, "--dry", "yes");
    assert.equal(e.status, 4, scope); assert.match(e.first, /^E_KEY_AMBIGUOUS: .*fx-free-a/);
  }
});

test("F22: the report prints the population next to every count it restates", () => {
  const s = setup();
  const r = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers+deposit", "--detail", "yes", "--dry", "yes");
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /deposit-strict-skipped \.+ 2 of 4 probe-ok selectors on paid and deposit providers/);
  assert.match(r.out, /ALIAS \(counted separately\) \.+ 2 probe-ok pool aliases of 15 probe-ok selectors/);
  assert.match(r.out, /^DEPOSIT STRICT: 2 of 4 probe-ok selectors/m);
  assert.match(r.out, /^CREDIT: .*\(\d+ of \d+ models in the chosen set are positive-priced\)/m);
});

test("F20: explain answers 'would be chosen as the substitute when main is X' with the router's own rule; no dead expression in the price line", () => {
  const s = setup();
  const e = cli(["explain", "fx-free-a/fxa-alpha", ...s.F]);
  assert.equal(e.status, 0, e.err);
  assert.match(e.out, /^shortlist: listed; would be chosen as the substitute (when main is on: [a-z-]+(, [a-z-]+)* \(of \d+ providers in the set; spread over the first 3 rows of the lead rank band by agent hash\)|never, for any provider in the set)/m);
  assert.match(e.out, /^price: \$0\/\$0|^price: free/m);
});

// =====================================================================================================================
// Second fix round (G1 G8 G10 G12). Failing-first: every one of these fails on the code it replaced.
// =====================================================================================================================
const ALL_FILE_FLAGS = lib.FILE_FLAGS.map((f) => `--${f}`);
const swapFlag = (flags, name, v) => { const a = [...flags]; a[a.indexOf(name) + 1] = v; return a; };

test("G1: an EMPTY or blank value for ANY file flag is a usage error (exit 1) for every command: nothing is resolved or written (the real-looking HOME and the fixture folder stay byte-identical)", () => {
  const s = setup();
  const dirBefore = treeOf(s.dir);
  const owner = s.F[s.F.indexOf("--policy-file") + 1], stateDir = s.F[s.F.indexOf("--state-dir") + 1];
  const plans = [
    ["set", ["set", "--source", "all-providers", "--mode", "dynamic", ...s.F], ALL_FILE_FLAGS],
    ["show", ["show", ...s.F], ALL_FILE_FLAGS],
    ["explain", ["explain", "fx-free-a/fxa-alpha", ...s.F], ALL_FILE_FLAGS],
    ["rebuild", ["rebuild", ...s.F], ALL_FILE_FLAGS],
    ["rollback", ["rollback", "--policy-file", owner, "--state-dir", stateDir], ["--policy-file", "--state-dir"]],
    ["clear", ["clear", "--policy-file", owner, "--state-dir", stateDir], ["--policy-file", "--state-dir"]],
  ];
  let n = 0;
  for (const [cmd, args, flags] of plans) for (const flag of flags) for (const blank of ["", "  "]) {
    const r = cli(swapFlag(args, flag, blank));                       // cli() hashes the whole sentinel HOME before and after
    assert.equal(r.status, 1, `${cmd} ${flag} ${JSON.stringify(blank)}: ${r.out}${r.err}`);
    assert.match(r.first, new RegExp(`^E_USAGE: flag ${flag} needs a file path`), `${cmd} ${flag}`);
    assert.equal(r.out, "", `${cmd} ${flag}: nothing was printed as if it had run`);
    n += 1;
  }
  assert.equal(n, (4 * 12 + 2 * 2) * 2, "6 commands: 4 take all 12 file flags, rollback and clear take 2; each with 2 blank spellings");
  assert.deepEqual(treeOf(s.dir), dirBefore, "the fixture folder was not written either");
});

test("G1: parseArgs and resolvePaths (pure) reject a blank file flag, and resolvePaths never uses truthiness for a flag that IS present", () => {
  for (const cmd of lib.COMMANDS) {
    const flags = cmd === "rollback" || cmd === "clear" ? ["policy-file", "state-dir"] : lib.FILE_FLAGS;
    for (const f of flags) for (const blank of ["", " ", "   \t"]) {
      assert.throws(() => lib.parseArgs([cmd, ...(cmd === "explain" ? ["x/y"] : []), `--${f}`, blank]), (e) => e.code === "E_USAGE" && e.exit === 1 && e.message.includes(`--${f}`), `${cmd} --${f} ${JSON.stringify(blank)}`);
    }
  }
  for (const f of lib.FILE_FLAGS) assert.throws(() => lib.resolvePaths({ [f]: "" }), (e) => e.code === "E_USAGE", `resolvePaths --${f} ""`);
  assert.throws(() => lib.resolvePaths({ "state-dir": "  ", "policy-file": "x" }), (e) => e.code === "E_USAGE");
  // the case it must not break: a real value still resolves, and no file flag at all still gives the real defaults (no fixture mode)
  const dir = tmp(), ok = lib.resolvePaths(fixtureFlagMap(dir));
  assert.equal(ok.stateRoot, path.resolve(dir, "state")); assert.equal(ok.policyFile, path.resolve(dir, "llmkeys", "subagent-policy.json"));
  assert.equal(lib.resolvePaths({}).stateRoot, lib.STATE_ROOT); assert.equal(lib.resolvePaths({}).policyFile, lib.OWNER_FILE); assert.equal(lib.resolvePaths({}).providersFile, null);
});

test("G1: a test-flag path under a real vault, Claude, state or catalog folder is refused however it is spelled (absent tail, .., case, junction), and a look-alike sibling is not", () => {
  const home = tmp(), protect = lib.protectedDirs(home, {});          // an empty environment: no CCR data folder (the loop below creates every protected folder it is given)
  for (const d of protect) fs.mkdirSync(d, { recursive: true });
  const base = fixtureFlagMap(tmp());                                  // every path in another temp folder
  assert.doesNotThrow(() => lib.resolvePaths(base, { protect }));
  const refused = (k, v) => assert.throws(() => lib.resolvePaths({ ...base, [k]: v }, { protect }), (e) => e.code === "E_USAGE" && e.exit === 1 && /lies under/.test(e.message), `${k} ${v}`);
  refused("state-dir", path.join(home, ".uw", "state"));
  refused("state-dir", path.join(home, ".uw", "state", "subagent"));
  refused("policy-file", path.join(home, ".llmkeys", "subagent-policy.json"));
  refused("settings-file", path.join(home, ".claude", "settings.json"));
  refused("snapshot-file", path.join(home, ".uw", "catalog", "snapshot.json"));
  refused("bench-file", path.join(home, ".uw", "state", "bench.json"));
  refused("registry-file", path.join(home, ".llmkeys", "not-yet", "deeper", "registry.json"));          // the folder does not exist yet: the nearest existing ancestor decides
  refused("registry-file", path.join(home, "x", "..", ".llmkeys", "registry.json"));
  if (process.platform === "win32") refused("registry-file", path.join(home, ".LLMKEYS", "registry.json"));
  const link = path.join(tmp(), "link");
  fs.symlinkSync(path.join(home, ".llmkeys"), link, "junction");
  refused("registry-file", path.join(link, "registry.json"));                                          // a junction in a temp folder that points at the real one
  assert.doesNotThrow(() => lib.resolvePaths({ ...base, "registry-file": path.join(home, ".llmkeys-backup", "registry.json") }, { protect }), "a sibling that merely starts with the same letters is not under it");
  assert.doesNotThrow(() => lib.resolvePaths({ ...base, "registry-file": path.join(home, ".uw", "other", "registry.json") }, { protect }));
});

test("G1: through the CLI, a --state-dir or --policy-file that names the real-looking HOME's own folders is refused and the sentinel files are untouched", () => {
  const s = setup(), home = sentinelHome();
  const set = (...a) => ["set", "--source", "all-providers", "--mode", "dynamic", ...a];
  const a = cli(set(...swapFlag(s.F, "--state-dir", path.join(home, ".uw", "state"))), { home });
  assert.equal(a.status, 1, a.out + a.err); assert.match(a.first, /^E_USAGE: refusing --state-dir .*lies under/);
  const b = cli(set(...swapFlag(s.F, "--policy-file", path.join(home, ".llmkeys", "subagent-policy.json"))), { home });
  assert.equal(b.status, 1); assert.match(b.first, /^E_USAGE: refusing --policy-file/);
  const c = cli(["rollback", "--policy-file", path.join(home, ".llmkeys", "subagent-policy.json"), "--state-dir", stateOf(s)], { home });
  assert.equal(c.status, 1); assert.match(c.first, /^E_USAGE: refusing --policy-file/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".llmkeys", "subagent-policy.json"), "utf8")).enforcement, "enforce", "the sentinel owner file was not flipped");
  const d = cli(["clear", "--policy-file", s.owner, "--state-dir", stateOf(s)], { home });             // the case it must not break: the fixture's own folders
  assert.equal(d.status, 0, d.err);
});

test("G8: a reused fixture folder is checked entry by entry: a pre-planted junction (state, llmkeys, nested, or named like a fixture file) and a foreign file are refused before any write; the plain re-run (acceptance 9) still works", () => {
  const fresh = () => { const d = tmp(); materialize(d); return d; };
  const victim = tmp();
  const refuseAndKeepVictimEmpty = (d, re, what) => {
    assert.throws(() => materialize(d), re, what);
    assert.throws(() => checkFixtureDir(d), re, what);
    const r = spawnSync(process.execPath, [FLAGS, "--dir", d], { encoding: "utf8" });
    assert.equal(r.status, 1, what); assert.equal(r.stdout, "", `${what}: no flag line is emitted`); assert.match(r.stderr, re, what);
    assert.deepEqual(fs.readdirSync(victim), [], `${what}: nothing was written through the link`);
  };
  for (const name of ["state", "llmkeys"]) {
    const d = fresh(); fs.rmSync(path.join(d, name), { recursive: true }); fs.symlinkSync(victim, path.join(d, name), "junction");
    refuseAndKeepVictimEmpty(d, /symlink or junction/, `${name} is a junction`);
  }
  { const d = fresh(); fs.mkdirSync(path.join(d, "state", "subagent")); fs.symlinkSync(victim, path.join(d, "state", "subagent", "inner"), "junction"); refuseAndKeepVictimEmpty(d, /symlink or junction/, "a nested junction"); }
  { const d = fresh(); fs.rmSync(path.join(d, "registry.json")); fs.symlinkSync(victim, path.join(d, "registry.json"), "junction"); refuseAndKeepVictimEmpty(d, /symlink or junction/, "a junction named like a fixture file"); }
  { const d = fresh(); fs.writeFileSync(path.join(d, "notes.txt"), "keep"); refuseAndKeepVictimEmpty(d, /not fixture files.*notes\.txt/, "a foreign file");
    assert.equal(fs.readFileSync(path.join(d, "notes.txt"), "utf8"), "keep"); }
  { const d = tmp(); fs.symlinkSync(victim, path.join(d, "alias"), "junction");                           // the folder named on the command line is itself a link
    assert.throws(() => checkFixtureDir(path.join(d, "alias")), /outside|symlink or junction/); assert.deepEqual(fs.readdirSync(victim), []); }
  // the cases it must not break: the same folder re-run, with an override, and after a test edited a fixture file or the CLI wrote state
  const d = fresh();
  fs.writeFileSync(path.join(d, "bench.json"), "EDITED"); fs.mkdirSync(path.join(d, "state", "subagent"), { recursive: true }); fs.writeFileSync(path.join(d, "state", "subagent", "policy.json"), "{}");
  const again = spawnSync(process.execPath, [FLAGS, "--dir", d, "--registry-file", path.join(d, "nonexistent.json")], { encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr); assert.match(again.stdout, /nonexistent\.json/);
  assert.equal(fs.readFileSync(path.join(d, "bench.json"), "utf8"), "EDITED");
});

test("G8: the temp root may not be, or contain, the home folder; every emitted path (an override too) must resolve under the temp root", () => {
  const root = fs.realpathSync(os.tmpdir()), under = path.join(root, `uw-g8-${process.pid}`);
  assert.throws(() => checkFixtureDir(path.join(under, "x"), { root, home: root }), /is, or contains, the home folder/, "root equals home");
  assert.throws(() => checkFixtureDir(path.join(under, "x"), { root, home: path.join(root, "h") }), /is, or contains, the home folder/, "root is an ancestor of home");
  assert.doesNotThrow(() => checkFixtureDir(path.join(under, "x"), { root, home: path.join(path.dirname(root), "elsewhere-home") }), "a home outside the temp root is fine");
  const d = tmp();
  const realFile = path.join(os.homedir(), ".llmkeys", "registry.json");                                    // only ever resolved, never opened
  const r = spawnSync(process.execPath, [FLAGS, "--dir", d, "--registry-file", realFile], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /emitted --registry-file .* resolves outside/); assert.equal(r.stdout, "");
  const ok = spawnSync(process.execPath, [FLAGS, "--dir", d, "--registry-file", path.join(d, "elsewhere.json")], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
});

test("G10: show prints the router's effective mode (status.policy.enforcement, inject, rollback flag) and ANY gate in the compiled file, not only an enforce-gated one", () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const none = cli(["show", "--detail", "yes", ...s.F]);
  assert.ok(!/router effective mode/.test(none.out) && !/CLASSIFIER_UNMEASURED/.test(none.out), "no status and no gate: neither line");
  const now = new Date().toISOString();
  wr(path.join(s.state, "status.json"), { schema: 1, updatedAt: now, counters: {}, warnings: [], mainBySession: {}, policy: { state: "ok", enforcement: "shadow", inject: "off", rollbackFlag: true } });
  const withStatus = cli(["show", "--detail", "yes", ...s.F]);
  assert.doesNotMatch(cli(["show", ...s.F]).out, /router effective mode/, "U5: the router's internal mode line is behind --detail yes");
  assert.match(withStatus.out, /^ {2}router effective mode: enforcement shadow, inject off, rollback flag set \(acts as shadow\); policy ok$/m);
  const c = rd(path.join(s.state, "policy.json")); c.gate = { code: "CLASSIFIER_UNMEASURED", text: "CLASSIFIER_UNMEASURED: demo gate‮" }; wr(path.join(s.state, "policy.json"), c);
  const withGate = cli(["show", ...s.F]);
  assert.match(withGate.out, /^CLASSIFIER_UNMEASURED: demo gate\?$/m, "printed although the owner file does not say enforce (the old rule printed it only for an enforce-gated rebuild), bidi control replaced");
});

test("G12: rebuild prints the KEY_AMBIGUOUS and NO_TIER lines `set` prints (never with --quiet), and the compiled builtFrom stores them OUTSIDE the hash; a clean registry stores none", () => {
  const s = setup();
  const regFile = path.join(s.dir, "registry.json"), reg = rd(regFile);
  wr(regFile, [...reg, { ...reg[0], id: "personal.fx-free-a.paid", tier: "paid", envVarName: "LLM_X" }]);            // fx-free-a now has two keys and no recorded choice
  const set = SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "models", "--detail", "yes");
  assert.equal(set.status, 0, set.err); assert.match(set.out, /^KEY_AMBIGUOUS: /m);
  const rb = cli(["rebuild", ...s.F]);
  assert.equal(rb.status, 0, rb.err);
  assert.match(rb.out, /^KEY_AMBIGUOUS: 1 provider\(s\) have several keys and no recorded choice, so no tier: fx-free-a;/m);
  assert.match(rb.out, /^NO_TIER: 1 of \d+ providers with probe-ok models have no resolvable key tier/m);
  const stale = cli(["rebuild", "--if-stale", "yes", ...s.F]);
  assert.match(stale.out, /^up to date: nothing to rebuild$/m); assert.match(stale.out, /^KEY_AMBIGUOUS: /m, "the up-to-date path surfaces them too");
  const quiet = cli(["rebuild", "--quiet", "yes", ...s.F]);
  assert.equal(quiet.out, "", "--quiet prints nothing");
  const c = rd(path.join(s.state, "policy.json"));
  assert.deepEqual(c.builtFrom.tierWarnings.map((w) => w.code).sort(), ["KEY_AMBIGUOUS", "NO_TIER"]);
  assert.equal(lib.hashOf(c), c.contentHash, "the stored hash is the hash of the routing content");
  assert.equal(lib.hashOf({ ...c, builtFrom: { ...c.builtFrom, tierWarnings: [] } }), c.contentHash, "tierWarnings is outside the hash: clearing it does not change it");
  // the case it must not break: a clean registry in dynamic mode prints and stores no tier warning
  const t = setup(); assert.equal(SET(t, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const clean = cli(["rebuild", ...t.F]);
  assert.ok(!/KEY_AMBIGUOUS|NO_TIER/.test(clean.out)); assert.deepEqual(rd(path.join(t.state, "policy.json")).builtFrom.tierWarnings, []);
});

test("G13: explain's free-scope verdicts read the vocabulary data: a management and a subscription provider are in no free scope, a paid one is strict (deposit-strict-skipped)", () => {
  const s = setup();
  const mgmt = cli(["explain", "fx-mgmt/fxm-one", ...s.F]);
  assert.equal(mgmt.status, 0, mgmt.err);
  assert.match(mgmt.out, /^key tier: management /m);
  for (const scope of ["free models", "free providers", "free providers \\+ deposit"]) assert.match(mgmt.out, new RegExp(`^${scope}: FAIL \\(tier management is in no free scope\\)$`, "m"), scope);
  const paid = cli(["explain", "fx-paid/fxp-plain", ...s.F]);
  assert.match(paid.out, /^free providers \+ deposit: FAIL \(deposit-strict-skipped: no free tag on a paid provider\)$/m);
  const rel = cli(["explain", "anthropic/claude-sonnet-5-5", ...s.F]);
  assert.match(rel.out, /^free providers: FAIL \(tier subscription is in no free scope\)$/m);
});

test("content guard logic: a changed strict file fails; a signature file fails only when its new content is a fixture file; absence compares with absence", () => {
  const fixtureBench = crypto.createHash("sha256").update(fs.readFileSync(path.join(FX, "bench.json"))).digest("hex");
  const hs = (o) => ({ bench: "a".repeat(64), observed: "b".repeat(64), claudeSettings: "absent", ...o });
  const run = (b, a, o) => assertRealFilesUntouched(assert, b, a, o);
  run(hs(), hs(), { strict: ["bench", "claudeSettings"], signature: ["observed"] });                              // nothing changed, an absent file stays absent
  assert.throws(() => run(hs(), hs({ bench: "c".repeat(64) }), { strict: ["bench"] }), /real files whose content hash changed/);
  assert.throws(() => run(hs(), hs({ claudeSettings: "d".repeat(64) }), { strict: ["claudeSettings"] }), /real files whose content hash changed/, "absent to present is a change");
  run(hs(), hs({ observed: "e".repeat(64) }), { signature: ["observed"] });                                        // the live observer wrote it: not a failure
  assert.throws(() => run(hs(), hs({ bench: fixtureBench }), { signature: ["bench"] }), /byte-for-byte fixture content/, "the incident: a real file now holds a fixture copy");
});

// =====================================================================================================================
// Router v2 (ar-8, ar-10, ar-14, ar-17): owner switches, version note, cheap staleness check, clear
// =====================================================================================================================
test("router v2: set --banded and --handoff-notice take an explicit yes or no; both land in the compiled owner block; banded is in the hash, handoffNotice is not; the usage text names both; an owner file from before them loads with the defaults", () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const c0 = rd(path.join(s.state, "policy.json"));
  assert.deepEqual([c0.owner.banded, c0.owner.handoffNotice, rd(s.owner).banded, rd(s.owner).handoffNotice], [true, true, true, true], "both default to on");
  assert.equal(SET(s, "--banded", "no").status, 0);
  const c1 = rd(path.join(s.state, "policy.json"));
  assert.equal(c1.owner.banded, false); assert.notEqual(c1.contentHash, c0.contentHash, "banded is routing content: the hash moves");
  assert.equal(rd(s.owner).banded, false);
  assert.match(SET(s, "--banded", "no").out, /BANDED: off/, "a non-default switch is stated in the report");
  assert.equal(SET(s, "--banded", "yes").status, 0);
  assert.equal(rd(path.join(s.state, "policy.json")).contentHash, c0.contentHash, "back on: the original hash");
  assert.equal(SET(s, "--handoff-notice", "no").status, 0);
  const c2 = rd(path.join(s.state, "policy.json"));
  assert.equal(c2.owner.handoffNotice, false); assert.equal(c2.contentHash, c0.contentHash, "handoffNotice is outside the hash: the injected marker does not rotate");
  assert.deepEqual(c2.inject, c0.inject);
  for (const bad of [["--banded", "maybe"], ["--banded", "true"], ["--handoff-notice", "1"]]) {
    const r = SET(s, ...bad);
    assert.equal(r.status, 1, bad.join(" ")); assert.match(r.first, /takes exactly yes or no/);
  }
  const bare = cli(["set", "--banded"]);
  assert.equal(bare.status, 1);
  assert.match(lib.usageText, /--banded yes\|no/); assert.match(lib.usageText, /--handoff-notice yes\|no/);
  // an owner file written before these switches loads with them on
  const old = { schema: 1, source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", allow: [], classLog: "on" };
  const f = path.join(s.dir, "old-owner.json"); wr(f, old);
  const loaded = lib.loadOwner(f);
  assert.deepEqual([loaded.banded, loaded.handoffNotice], [true, true]);
  wr(f, { ...old, banded: "yes" });
  assert.throws(() => lib.loadOwner(f), /banded must be true or false/);
});

test("router v2: set and rebuild warn when the compiled policy needs a newer router than status.json says is running; clear removes the session journal files too", () => {
  const s = setup();
  fs.mkdirSync(s.state, { recursive: true });
  wr(path.join(s.state, "status.json"), { schema: 1, updatedAt: new Date().toISOString(), routerVersion: 1, counters: {}, warnings: [], mainBySession: {}, policy: { state: "ok" } });
  const set = SET(s, "--source", "all-providers", "--mode", "dynamic");
  assert.equal(set.status, 0, set.err);
  assert.match(set.out, /WARNING: this compiled policy needs router v2 but the running router reports v1: it will IGNORE the policy \(POLICY_NEWER\)/);
  const rb = cli(["rebuild", "--quiet", "no", ...s.F]);
  assert.match(rb.out, /needs router v2 but the running router reports v1/);
  wr(path.join(s.state, "status.json"), { schema: 1, updatedAt: new Date().toISOString(), routerVersion: 2, counters: {}, warnings: [], mainBySession: {}, policy: { state: "ok" } });
  assert.doesNotMatch(SET(s, "--source", "all-providers", "--mode", "dynamic").out, /POLICY_NEWER/);
  for (const f of ["main-s1.json", "agents-s1.jsonl", "agents-s2.json", "status-abc.json", "status-1k2.json", "cooling.json", "decisions.jsonl", "agents.jsonl"]) wr(path.join(s.state, f), "{}\n");
  const cl = cli(["clear", "--policy-file", s.owner, "--state-dir", path.join(s.dir, "state")]);
  assert.equal(cl.status, 0, cl.err);
  assert.deepEqual(fs.readdirSync(s.state).sort(), ["agents.jsonl", "decisions.jsonl", "status.json"], "R14: journals, session files, cooling.json and the per-worker status files go; the decision logs and the merged status.json stay");
  assert.match(cl.out, /2 session file\(s\) and 3 cooling or worker status file\(s\)|3 session file\(s\) and 3 cooling or worker status file\(s\)/);
});

test("router v2 (ar-14): rebuild --if-stale compares the cheap stamps BEFORE compiling: unchanged inputs compile nothing, a changed input (observed overlay, owner toggle) compiles once", async () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "free", "--free-scope", "providers").status, 0);
  const run = async (...a) => { const out = [], err = []; const code = await lib.runSubagentPolicy(["rebuild", ...a, ...s.F], { out: (l) => out.push(l), err: (l) => err.push(l) }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const n0 = lib.compileStats.compiles;
  const same = await run("--if-stale", "yes");
  assert.equal(same.code, 0, same.err); assert.match(same.out, /up to date: nothing to rebuild/);
  assert.equal(lib.compileStats.compiles, n0, "no compile ran");
  wr(path.join(s.dir, "observed.json"), { schema: 1, writtenAt: "2026-10-03T12:00:00.000Z", feed: "ok", models: { "fx-free-a/fxa-alpha": { s: "pay", t: 100, a: 1790800000, l: 1 } } });
  const changed = await run("--if-stale", "yes");
  assert.match(changed.out, /rebuilt /); assert.equal(lib.compileStats.compiles, n0 + 1, "exactly one compile for the changed input");
  const owner = rd(s.owner); wr(s.owner, { ...owner, banded: false });
  const toggled = await run("--if-stale", "yes");
  assert.match(toggled.out, /rebuilt /, "an owner toggle is not 'up to date'");
  assert.equal(rd(path.join(s.state, "policy.json")).owner.banded, false);
  const again = await run("--if-stale", "yes");
  assert.match(again.out, /up to date/); assert.equal(lib.compileStats.compiles, n0 + 2);
});

// =====================================================================================================================
// Fix round for router v2 (R12, CLI-1, S-F7, S-F8, R13, R14, D1 ctx). Each test names the item.
// =====================================================================================================================
const keyRaw = (args, home = sentinelHome()) => {
  const before = treeOf(home);
  const r = spawnSync(process.execPath, [KEY, ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home } });
  assert.deepEqual(treeOf(home), before, "the real-looking HOME was not touched");
  return { status: r.status, out: r.stdout, err: r.stderr, home };
};

test("R12: a bare `subagent-policy` and `help` print the usage text (exit 0, nothing written); the text names every flag value, --ctx any|128k|200k|256k|512k|1m|prefer-256k|prefer-512k|prefer-1m and --live yes", () => {
  for (const args of [["subagent-policy"], ["subagent-policy", "help"], ["subagent-policy", "--help"]]) {
    const r = keyRaw(args);
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.err}`);
    assert.equal(r.out.trim(), lib.usageText, "the usage text is what is printed, through key.mjs");
    assert.equal(r.err, "");
  }
  for (const needle of [/--ctx any\|128k\|200k\|256k\|512k\|1m\|prefer-256k\|prefer-512k\|prefer-1m/, /--live yes/, /rollback needs no flag/, /--mode dynamic\|inherit\|free/, /--enforce shadow\|enforce/, /--source same-provider\|all-providers/]) assert.match(lib.usageText, needle);
  const bad = keyRaw(["subagent-policy", "frobnicate"]);
  assert.equal(bad.status, 1); assert.match(bad.err, /^E_USAGE: unknown subcommand "frobnicate"/);
});

test("CLI-1 (D5): set, rebuild and clear with NO file flag and no --live yes exit 1 E_USAGE naming the REAL paths and write nothing (HOME, USERPROFILE and APPDATA point at a temp dir); --dry yes, show and explain are unaffected; rollback is EXEMPT", () => {
  for (const args of [["set", "--source", "all-providers", "--mode", "dynamic"], ["set", "--source", "all-providers", "--mode", "dynamic", "--live", "no"], ["rebuild"], ["rebuild", "--if-stale", "yes", "--quiet", "yes"], ["clear"]]) {
    const home = sentinelHome();
    const r = cli(args, { home });                                                          // cli() fingerprints the whole home before and after: nothing written
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.first, /^E_USAGE: (set|rebuild|clear) with no file flags writes the REAL files /, r.first);
    assert.ok(r.err.includes(path.join(home, ".llmkeys", "subagent-policy.json")), "names the real owner file");
    assert.ok(r.err.includes(path.join(home, ".uw", "state", "subagent", "policy.json")), "names the real compiled file");
    assert.match(r.err, /--live yes/);
  }
  // the case it must not break: a fixture run needs no --live, and --live yes is accepted with or without fixture flags
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  assert.equal(cli(["rebuild", "--quiet", "yes", ...s.F]).status, 0);
  assert.equal(cli(["rebuild", "--quiet", "yes", "--live", "yes", ...s.F]).status, 0, "--live yes beside fixture flags is harmless");
  assert.equal(cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes", ...s.F]).status, 0);
  // a dry set on the real paths passes the guard (it writes nothing); it then fails or succeeds on its own inputs, never with E_USAGE about --live
  const dry = cli(["set", "--source", "all-providers", "--mode", "dynamic", "--dry", "yes"]);
  assert.doesNotMatch(dry.err, /pass --live yes/);
  // rollback with no file flags and no --live works exactly as before: acceptance 10 of plan 17
  const home = sentinelHome(); fs.rmSync(path.join(home, ".llmkeys", "subagent-policy.json"));
  const rb = spawnSync(process.execPath, [KEY, "subagent-policy", "rollback"], { encoding: "utf8", timeout: 60000, env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home } });
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(fs.existsSync(path.join(home, ".uw", "state", "subagent", "shadow.flag")), "rollback wrote shadow.flag");
  assert.ok(!fs.existsSync(path.join(home, ".llmkeys", "subagent-policy.json")), "and created no owner file");
  const home2 = sentinelHome();
  const rb2 = spawnSync(process.execPath, [KEY, "subagent-policy", "rollback"], { encoding: "utf8", timeout: 60000, env: { ...process.env, USERPROFILE: home2, HOME: home2, APPDATA: home2, LOCALAPPDATA: home2 } });
  assert.equal(rb2.status, 0, rb2.stderr);
  const flipped = JSON.parse(fs.readFileSync(path.join(home2, ".llmkeys", "subagent-policy.json"), "utf8"));
  assert.deepEqual([flipped.enforcement, flipped.inject], ["shadow", "off"], "with an owner file it flips it to shadow and inject off");
});

test("S-F8: a UNC path (\\\\localhost\\C$\\..., \\\\127.0.0.1\\C$\\..., a device path) is refused for every file flag; a plain local temp path is not", { skip: process.platform !== "win32" && "UNC paths are a Windows form" }, () => {
  const s = setup();
  const real = lib.protectedDirs(os.homedir(), {});                   // the four home folders; CCR's own data folder is added when the environment names one
  const uncs = [
    "\\\\localhost\\" + path.join(os.homedir(), ".uw", "state").replace(":", "$"),
    "\\\\127.0.0.1\\" + path.join(os.homedir(), ".llmkeys").replace(":", "$"),
    "//localhost/" + path.join(os.homedir(), ".uw", "state").replace(":", "$").replace(/\\/g, "/"),
    "\\\\?\\" + path.join(os.homedir(), ".uw", "state"),
    "\\\\" + "nowhere-host" + "\\share\\x",
  ];
  assert.ok(real.length === 4);
  assert.equal(lib.protectedDirs(os.homedir(), { UW_CCR_DATA_DIR: "C:\\ccr-data" }).length, 5, "the CCR data folder (the request log lives there) is the fifth");
  for (const k of lib.FILE_FLAGS) {
    for (const unc of uncs) {
      const flags = { [k]: unc };
      assert.throws(() => lib.resolvePaths(flags), (e) => e.code === "E_USAGE" && /UNC path/.test(e.message), `--${k} ${unc}`);
    }
  }
  // through the CLI: exit 1, nothing touched
  const r = cli(["rebuild", ...swapFlag(s.F, "--state-dir", uncs[0])]);
  assert.equal(r.status, 1); assert.match(r.first, /^E_USAGE: refusing --state-dir .*UNC path/);
  // the case it must not break: a local temp fixture still resolves
  assert.doesNotThrow(() => lib.resolvePaths({ "state-dir": path.join(s.dir, "state") }));
});

test("SEC-3 REGRESSION: a UNC path is refused BEFORE any filesystem call touches it: realpath of a remote UNC name opens an SMB connection (42 s to be refused in the PoC), so no realpath, stat or open of a path with two leading backslashes may happen, and the refusal is immediate; a local path is still resolved", { skip: process.platform !== "win32" && "UNC paths are a Windows form" }, () => {
  const BS2 = String.fromCharCode(92).repeat(2);
  const remote = BS2 + "192.0.2.1" + String.fromCharCode(92) + "share" + String.fromCharCode(92) + "fixture" + String.fromCharCode(92) + "x.json";        // a remote-looking host in the documentation range: a probe of it would be a network attempt
  const touched = [];
  const names = ["realpathSync", "statSync", "lstatSync", "existsSync", "openSync", "readFileSync", "accessSync", "readdirSync"];
  const orig = Object.fromEntries(names.map((n) => [n, fs[n]])), nativeOrig = fs.realpathSync.native;
  const spy = (n, f) => function (p, ...a) { if (String(p).startsWith(BS2)) { touched.push(`${n} ${String(p)}`); throw Object.assign(new Error("ENOENT (stubbed: no network)"), { code: "ENOENT" }); } return f.call(this, p, ...a); };
  for (const n of names) fs[n] = spy(n, orig[n]);
  fs.realpathSync.native = spy("realpathSync.native", nativeOrig);
  let err, ms;
  try {
    const t0 = process.hrtime.bigint();
    try { lib.resolvePaths({ "state-dir": remote }); } catch (e) { err = e; }
    ms = Number(process.hrtime.bigint() - t0) / 1e6;
  } finally { for (const n of names) fs[n] = orig[n]; fs.realpathSync.native = nativeOrig; }
  assert.ok(err && err.code === "E_USAGE" && /UNC path/.test(err.message), "refused as a UNC path");
  assert.deepEqual(touched, [], "no filesystem call touched the UNC path");
  assert.ok(ms < 1000, `${ms.toFixed(1)} ms: the refusal does not wait for the network`);
  // every file flag, through the CLI as well
  for (const k of lib.FILE_FLAGS) {
    const t0 = process.hrtime.bigint(); assert.throws(() => lib.resolvePaths({ [k]: remote }), (e) => e.code === "E_USAGE" && /UNC path/.test(e.message), `--${k}`);
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 1000, `--${k} is immediate`);
  }
  // the case it must not break: a local fixture path still goes through the real-folder comparison (realpath IS used for it)
  const s = setup();
  assert.doesNotThrow(() => lib.resolvePaths({ "state-dir": path.join(s.dir, "state") }));
  assert.throws(() => lib.resolvePaths({ "state-dir": path.join(os.homedir(), ".uw", "state") }), (e) => e.code === "E_USAGE" && /real vault/.test(e.message));
});

test("S-F7: rebuild --if-stale verifies the compiled file's own contentHash: a hand-edited compiled file (stamps intact, hash stale) is rebuilt, never 'up to date'; an untouched one still exits early; --min-set changes no compiled byte", async () => {
  const s = setup();
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const file = path.join(s.state, "policy.json");
  const pristine = fs.readFileSync(file, "utf8");
  const run = async (...a) => { const out = [], err = []; const code = await lib.runSubagentPolicy(["rebuild", ...a, ...s.F], { out: (l) => out.push(l), err: (l) => err.push(l) }); return { code, out: out.join("\n"), err: err.join("\n") }; };
  const n0 = lib.compileStats.compiles;
  const same = await run("--if-stale", "yes");
  assert.match(same.out, /up to date/); assert.equal(lib.compileStats.compiles, n0, "untouched: no compile (the early exit still works)");
  const c = JSON.parse(pristine);
  c.models[0].s = "evil/model";                                                             // routing content edited by hand; every stamp and the stored contentHash are untouched
  fs.writeFileSync(file, JSON.stringify(c) + "\n");
  assert.notEqual(lib.hashOf(c), c.contentHash, "the stored hash no longer matches the content");
  const fixed = await run("--if-stale", "yes");
  assert.doesNotMatch(fixed.out, /up to date/, "NOT reported up to date");
  assert.match(fixed.out, /rebuilt /); assert.equal(lib.compileStats.compiles, n0 + 1);
  const strip = (t) => { const o = JSON.parse(t); delete o.compiledAt; return JSON.stringify(o); };
  assert.equal(strip(fs.readFileSync(file, "utf8")), strip(pristine), "the file is back to the compiled content (only compiledAt moved)");
  // --min-set: two compiles that differ only in --min-set write the same bytes, so the early exit may ignore it
  const a = await run("--min-set", "1"), snap1 = strip(fs.readFileSync(file, "utf8"));
  const b = await run("--min-set", "9"), snap2 = strip(fs.readFileSync(file, "utf8"));
  assert.equal(a.code, 0); assert.equal(b.code, 0); assert.equal(snap1, snap2);
});

test("D1: set --ctx takes any, prefer-1m and 1m; the value lands in the owner file and the compiled owner block (in the hash); prefer-1m leaves the row count unchanged and 1m filters; a bad value is a usage error that lists every value", () => {
  const s = setup();
  const hashes = {}, counts = {};
  for (const ctx of ["any", "prefer-1m", "1m"]) {
    const r = SET(s, "--source", "all-providers", "--mode", "dynamic", "--ctx", ctx);
    assert.equal(r.status, ctx === "1m" ? r.status : 0, r.err);
    if (r.status !== 0) { assert.equal(r.status, 2, "ctx 1m may empty the fixture set: the refusal rule, not a crash"); continue; }
    const c = rd(path.join(s.state, "policy.json"));
    assert.equal(c.owner.ctx, ctx); assert.equal(rd(s.owner).ctx, ctx);
    hashes[ctx] = c.contentHash; counts[ctx] = c.models.length;
  }
  assert.notEqual(hashes.any, hashes["prefer-1m"], "ctx is routing content: the hash moves");
  assert.equal(counts.any, counts["prefer-1m"], "prefer-1m is an ordering and band change, never a filter");
  const bad = SET(s, "--ctx", "2m");
  assert.equal(bad.status, 1); assert.match(bad.first, /must be one of any\|128k\|200k\|256k\|512k\|1m\|prefer-256k\|prefer-512k\|prefer-1m/);
  assert.equal(SET(s, "--ctx", "prefer-1m", "--dry", "yes").status, 0);
  assert.match(SET(s, "--ctx", "prefer-1m", "--detail", "yes", "--dry", "yes").out, /ctx=prefer-1m/);
  assert.throws(() => lib.validateOwner({ ...lib.OWNER_DEFAULTS, ctx: "2m" }), /ctx must be one of any\|128k\|200k\|256k\|512k\|1m\|prefer-256k\|prefer-512k\|prefer-1m/);
  // D-bk: every hard floor and soft preference is accepted by the real CLI; the dry preview prints rows per floor with their denominators
  for (const ctx of ["128k", "200k", "256k", "512k", "prefer-256k", "prefer-512k"]) {
    const d = SET(s, "--source", "all-providers", "--mode", "dynamic", "--ctx", ctx, "--dry", "yes");
    assert.ok(d.status === 0 || d.status === 2, `${ctx}: ${d.err}`);
    if (d.status === 0) assert.match(d.out, /^CONTEXT FLOORS: of \d+ rows in the chosen scope, \d+ have no known ctx; known ctx >= 128k \d+, >= 200k \d+, >= 256k \d+, >= 512k \d+, >= 1M \d+; \d+ of the \d+ unknown rows pass 128k on an inferred ctx/m, `${ctx}: rows per floor with denominators in the preview`);
  }
});

test("R13: explain describes the REAL rule: the lead rank band, its band id, the cooling and overlay demotion, and the tool-tier fallback (v, then t, never an untested u); banding off says it is the old pool, and a row of a lower band is 'never' a substitute only while banding is on", () => {
  const s = setup();
  wr(path.join(s.dir, "tool-fidelity.json"), { generatedAt: "2026-10-01T00:00:00.000Z", models: { "fx-free-a/fxa-alpha": { t: "v" }, "fx-free-a/fxa-gamma": { t: "v" } } });   // two verified rows beside the relay rows: the lead band, the rest unverified
  assert.equal(SET(s, "--source", "all-providers", "--mode", "dynamic").status, 0);
  const e = cli(["explain", "fx-free-a/fxa-alpha", ...s.F]);
  assert.equal(e.status, 0, e.err);
  assert.match(e.out, /^band: \d+ \(equal tool tier, health, ctx preference and price class/m);
  assert.match(e.out, /^fallback: a cooling model .*demoted, never removed.*LOWER tool tier only if it is tested \(v, then t\), never an untested u/m);
  assert.match(e.out, /rank: position \d+ of \d+.*keys tool tier \(band\)=\d, health: latest status ok \(band\)=0, ctx preference \(band\)=0, price class 2b \(band\)=\d, first strike=0, sweep demotion \(blocked by the sweep, never excluded\)=\d, big step \(v only\)=\d, L4 \(v only\)=\d, forced-choice only \(fc\)=\d, argument fidelity failed \(af\)=\d, tool_result use failed \(er, br\)=\d, ttft quantile bucket=\d, ctx class=\d, price 2b=\d, recency \(order only, calendar-dependent\)=\d, alias=\d, spawn failed \(sp: a last tie-breaker; matters only for a row that acts as a MAIN agent\)=\d/);
  const low = cli(["explain", "fx-free-a/fxa-big:free", ...s.F]);
  assert.match(low.out, /would be chosen as the substitute never, for any provider in the set/, "an unverified row behind a verified band: never");
  assert.equal(SET(s, "--banded", "no").status, 0);
  const off = cli(["explain", "fx-free-a/fxa-big:free", ...s.F]);
  assert.match(off.out, /banding is OFF: the old pool, not limited to one band/);
  assert.match(off.out, /would be chosen as the substitute when main is on: fx-free-a/, "the old pool reaches past the band");
});

// Boundary and source-shape contracts of the subagent policy (plan 9.1): what the router may name, what the library may
// import and call, that R1 (no gateway restart) cannot drift, and that the shared rules have one home.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as CC from "../menu/cc-contract.mjs";
import * as CCR from "../menu/ccr-client.mjs";
import { restartRelevantFingerprint } from "../keysync/safety.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { ENUMS, MIN_ROUTER, HASH_KEYS, HASH_OWNER_EXCLUDE } from "../keysync/subagent-policy.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const stripComments = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const ROUTER = read("router", "uw-router.next.cjs");

test("(1) the router's header, tag and tool-name literals equal the contract constants", () => {
  const h = CC.CONTRACT.subagent.headers;
  const lit = (name) => new RegExp(`const ${name} = "([^"]+)"`).exec(ROUTER)?.[1];
  assert.equal(lit("H_AGENT"), h.agentId); assert.equal(lit("H_SID"), h.sessionId); assert.equal(lit("H_SID_ALT"), h.sessionIdAlt);
  assert.equal(lit("H_CLASS"), h.requestClass); assert.equal(lit("H_TYPE"), h.agentType); assert.equal(lit("H_BETA"), h.beta); assert.equal(lit("H_LEN"), h.contentLength);
  assert.ok(CC.CONTRACT.subagent.beta1m.startsWith(lit("BETA_1M")), "the router's beta needle is a prefix of the contract's header value");
  assert.equal(lit("TAG_OPEN"), CCR.CONTRACT.subagentTag.open);
  // router v2: two names that menu/cc-contract.mjs does not hold are pinned by literal (the live header set is in research/phase6/15-zero-token-switching.md)
  assert.equal(lit("H_PARENT"), "x-claude-code-parent-agent-id", "the parent agent id header (logged as pid8, never used in a decision)");
  assert.equal(lit("H_RETRY"), "x-stainless-retry-count", "the SDK's retry count header (the secondary handoff signal)");
  assert.equal(h.agentId, "x-claude-code-agent-id");
  assert.deepEqual(JSON.parse(/const AGENT_TOOLS = (\[[^\]]+\])/.exec(ROUTER)[1]), [...CC.CONTRACT.subagent.toolNames]);
  assert.equal(CCR.CONTRACT.subagentTag.close, "</CCR-SUBAGENT-MODEL>");
  assert.equal(CCR.CONTRACT.subagentTag.example, "Provider/model");
});

test("(2)+(10) the tag and data-folder scan lists the router directory and passes on it", () => {
  const src = read("test", "contracts.test.mjs");
  assert.match(src, /\["menu", "refresh", "keysync", "harness", "spike", "router"\]/);
  for (const needle of [/x-ccr-client/, /uw-probe/, /UW_CCR_DATA_DIR/, /usage\.sqlite/, /request-logs\.sqlite/]) {
    for (const f of ["router/uw-router.next.cjs", "keysync/subagent-policy.mjs", "menu/subagent-funnel.mjs", "menu/tiers.mjs", "menu/pool-rule.mjs"]) {
      assert.ok(!needle.test(read(...f.split("/"))), `${f} must not match ${needle}`);
    }
  }
  for (const f of ["menu/subagent-funnel.mjs", "menu/tiers.mjs", "menu/pool-rule.mjs"]) {
    for (const n of [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/]) assert.ok(!n.test(read(...f.split("/"))), `${f} vs ${n}`);
  }
});

test("(3) R1: the library, the router and the CLI branch contain no saveConfig, no spawn or exec of run.mjs, and read the gateway only through getConfig", () => {
  const lib = stripComments(read("keysync", "subagent-policy.mjs")), router = stripComments(ROUTER);
  const key = read("keysync", "key.mjs");
  const branch = key.slice(key.indexOf('case "subagent-policy"'), key.indexOf("default:", key.indexOf('case "subagent-policy"')));
  for (const [name, body] of [["library", lib], ["router", router], ["key.mjs branch", branch]]) {
    assert.ok(!/saveConfig/.test(body), `${name}: no saveConfig`);
    assert.ok(!/child_process|\b(spawn|spawnSync|execSync|execFile|execFileSync|fork)\b/.test(body), `${name}: no child process`);
    assert.ok(!/run\.mjs|keysync\.mjs.*run/.test(body), `${name}: never starts keysync`);
  }
  assert.deepEqual([...lib.matchAll(/rpc\("([A-Za-z]+)"/g)].map((m) => m[1]), ["getConfig"], "the only gateway call is the read-only getConfig");
  assert.ok(!/fetch\(|http\.request|net\.connect/.test(router), "the router makes no network call");
});

test("(4) restartRelevantFingerprint is identical across a CUSTOM_ROUTER_PATH or policy-file change (R1 pinned against drift of the predicate)", () => {
  const base = () => ({ Providers: [{ name: "acme", api_base_url: "https://acme.invalid/v1", models: ["a", "b"] }],
    gateway: { enabled: true, host: "127.0.0.1", port: 3456, corePort: 3457 }, plugins: [], Router: { rules: [] }, profile: { profiles: [] } });
  const a = base(), b = base();
  b.CUSTOM_ROUTER_PATH = "C:\\Users\\x\\.uw\\spike\\uw-router.cjs";
  b.Router.fallback = { mode: "off" };
  b.profile.profiles.push({ id: "p", env: { UW_POLICY: "x" } });
  assert.equal(restartRelevantFingerprint(a), restartRelevantFingerprint(b));
});

test("(5) source order: the router has no await at all, returns before any await-bearing path, and its finally block cannot throw", () => {
  const code = stripComments(ROUTER);
  assert.ok(!/\bawait\b/.test(code.replace(/async function route/, "")), "no await anywhere: every fs call is synchronous");
  const fin = code.slice(code.indexOf("} finally {"));
  assert.match(fin, /try \{[\s\S]*slowReq[\s\S]*\} catch/, "the budget bookkeeping sits in its own try/catch");
  assert.ok(code.indexOf("if (!asked0) return undefined;") < code.indexOf("const P = loadPolicy();"), "the empty-model answer comes before any state is touched");
  assert.ok(code.indexOf("loadPolicy();") < code.indexOf("handleSubagent()"), "policy state is checked before any classification");
});

test("(6) no test file requires router/uw-router.next.cjs from its repo location (its state path would be the live one)", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "test")).filter((x) => /\.(mjs|cjs)$/.test(x))) {
    if (f === "subagent-contract.test.mjs") continue;                        // this file quotes the pattern it scans for
    const body = read("test", f);
    assert.ok(!/(require|import)\s*\(?[^)\n]*uw-router\.next/.test(body), `${f} must copy the router into a scratch tree, never require it in place`);
  }
  assert.match(read("test", "subagent-router.test.mjs"), /fs\.copyFileSync\(file, live\)/, "the router tests copy it first");
});

test("(8) the value fixed is accepted nowhere: not in the enums, not in the router", () => {
  assert.ok(!ENUMS.mode.includes("fixed"));
  assert.deepEqual(ENUMS.mode, ["dynamic", "inherit", "free"]);
  assert.ok(!/["']fixed["']/.test(ROUTER));
  assert.ok(!/["']fixed["']/.test(stripComments(read("menu", "subagent-funnel.mjs"))));
});

// F20: pinned to the commit that was HEAD when the S1 stage was authored (git rev-parse HEAD, 2026-10-03). "HEAD" made this test
// vacuous the moment the stage was committed (HEAD would then already contain the additions); a fixed base keeps it meaningful.
const BASE = "14b078a57d5fdbcd04de2722cbeb884a96a60bc8";
test("(11) menu/ccr-client.mjs changes are additive only: every base-commit export survives, nothing was removed, routableFromConfig is unchanged on a fixture", () => {
  assert.equal(spawnSync("git", ["cat-file", "-t", BASE], { cwd: ROOT, encoding: "utf8" }).stdout.trim(), "commit", "the pinned base commit exists");
  const head = spawnSync("git", ["show", `${BASE}:menu/ccr-client.mjs`], { cwd: ROOT, encoding: "utf8" });
  assert.equal(head.status, 0, head.stderr);
  const names = [...head.stdout.matchAll(/^export (?:async )?(?:function|const|let|class) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]);
  assert.ok(names.length >= 10);
  for (const n of names) assert.ok(n in CCR, `export ${n} still exists`);
  const num = spawnSync("git", ["diff", "--numstat", BASE, "--", "menu/ccr-client.mjs"], { cwd: ROOT, encoding: "utf8" });
  const [added, removed] = (num.stdout.trim().split(/\s+/));
  assert.equal(removed ?? "0", "0", `no line of ccr-client.mjs was removed or changed (added ${added ?? 0})`);
  const cfg = { Providers: [{ name: "p", models: ["a", "b[1m]"] }, { name: "q", models: "ab" }, { name: "r" }, null] };
  assert.deepEqual([...CCR.routableFromConfig(cfg)].sort(), ["p/a", "p/b[1m]"]);
  assert.deepEqual([...CCR.routableFromConfig(null)], []);
  const cc = spawnSync("git", ["diff", "--numstat", BASE, "--", "menu/cc-contract.mjs"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cc.stdout.trim().split(/\s+/)[1] ?? "0", "0", "cc-contract.mjs is additive too");
});

test("(12) one pool-alias constant: style.mjs and the funnel import it; keysync POOL_IDS stays a subset; no third fork", () => {
  assert.match(read("menu", "style.mjs"), /import \{ POOL_ALIAS_RE \} from "\.\/pool-rule\.mjs"/);
  assert.ok(!/\(auto\|router\|default\|free\)/.test(read("menu", "style.mjs")), "style.mjs holds no copy of the alternation");
  assert.match(read("menu", "subagent-funnel.mjs"), /from "\.\/pool-rule\.mjs"/);
  const ks = read("keysync", "keysync.mjs");
  const alts = /const POOL_IDS = \/\(\^\|\\\/\)\(([^)]+)\)\$\/i;/.exec(ks)?.[1].split("|");
  assert.deepEqual(alts, ["auto", "router", "default"]);
  const shared = /\(([^)]+)\)\$/.exec(POOL_ALIAS_RE.source)[1].split("|");
  for (const a of alts) assert.ok(shared.includes(a), `${a} is covered by POOL_ALIAS_RE`);
  assert.ok(shared.includes("free") && !alts.includes("free"), "free is the one extra, deliberately");
  assert.equal(POOL_ALIAS_RE.flags, "i");
  assert.match(read("keysync", "subagent-policy.mjs"), /from "\.\.\/menu\/pool-rule\.mjs"/);
});

test("(14) the funnel, the tier vocabulary and the pool rule import nothing outside menu/pool-rule.mjs and menu/tiers.mjs; the library imports funnel from the funnel", () => {
  const imports = (f) => [...read("menu", f).matchAll(/^import [^;]*? from "([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports("subagent-funnel.mjs").sort(), ["./pool-rule.mjs", "./tiers.mjs"]);
  assert.deepEqual(imports("tiers.mjs"), []);
  assert.deepEqual(imports("pool-rule.mjs"), []);
  for (const f of ["subagent-funnel.mjs", "tiers.mjs", "pool-rule.mjs"]) {
    const body = stripComments(read("menu", f));
    assert.ok(!/node:/.test(body), `${f} names no node: module`);
    assert.ok(!/\b(refresh|keysync)\//.test(body), `${f} names no refresh/ or keysync/ path`);
    assert.ok(!/\bprocess\b|\bBuffer\b|\brequire\(/.test(body), `${f} uses no Node global`);
  }
  assert.match(read("keysync", "subagent-policy.mjs"), /import \{[^}]*\bfunnel\b[^}]*\} from "\.\.\/menu\/subagent-funnel\.mjs"/);
});

test("(16) router v2 pins: its version meets the compiler's minRouter, its hash lists are the compiler's, its agent-id charset is the documented one, and it names no module beyond fs and path", () => {
  assert.equal(Number(/const ROUTER_VERSION = (\d+);/.exec(ROUTER)[1]), MIN_ROUTER, "the router version is the oldest router the compiler writes for");
  assert.ok(ROUTER.includes(`const HASH_KEYS = ${JSON.stringify(HASH_KEYS).replace(/","/g, '", "')};`));
  assert.ok(ROUTER.includes(`const HASH_OWNER_EXCLUDE = ${JSON.stringify(HASH_OWNER_EXCLUDE).replace(/","/g, '", "')};`));
  assert.match(ROUTER, /const AGENT_RE = \/\^\[A-Za-z0-9_@\.:-\]\{1,128\}\$\/;/);
  assert.match(ROUTER, /const SID_RE = \/\^\[A-Za-z0-9_-\]\{1,64\}\$\/;/, "only the session id (which reaches file names) keeps the narrow charset");
  assert.deepEqual([...ROUTER.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]).sort(), ["node:fs", "node:fs", "node:path"], "fs and path in the body, fs once in the loader (its one stat of the file itself)");
  const code = stripComments(ROUTER);
  assert.ok(!/\bAtomics\b/.test(code), "no blocking sleep anywhere in the router");
  assert.ok(!/readFileSync\(file, "utf8"\)\)[^;]*sleep/.test(code));
  assert.equal(HASH_OWNER_EXCLUDE.includes("banded"), false, "banded is routing content: it is hashed");
});

test("(17) S-F2 + SEC-1 + O4b pin (a DELIBERATE change to the no-module-scope-side-effect rule): the whole body is one factory evaluated once per process; the only module-scope code is the loader, which does exactly these module-scope statements per load: ONE statSync of __filename, ONE globalThis lookup, ONE guarded splice of this module out of module.parent.children; it keys the stored implementation by path plus (mtimeMs, size, ino) plus the compiled source's own length and hash, and keeps module.exports a function with __test", () => {
  const code = stripComments(ROUTER);
  assert.ok(code.trimStart().startsWith("const __uwImpl = function (IMPL_ID) {"), "the first statement of the file is the factory: nothing runs at module scope before the loader");
  const loaderAt = code.indexOf("module.exports = (function load() {");
  assert.ok(loaderAt > 0 && code.indexOf("module.exports = (function load() {", loaderAt + 1) < 0, "exactly one loader, last in the file");
  const loader = code.slice(loaderAt);
  assert.equal((loader.match(/statSync\(/g) || []).length, 1, "one stat");
  assert.match(loader, /statSync\(__filename\)/);
  assert.equal((loader.match(/globalThis/g) || []).length, 1, "one globalThis lookup");
  assert.match(loader, /st\.mtimeMs \+ ":" \+ st\.size \+ ":" \+ st\.ino \+ ":" \+ src\.length \+ ":" \+ h/, "the identity is mtime, size, inode AND the compiled source's own length and hash (SEC-1)");
  assert.match(loader, /src = __uwImpl\.toString\(\)/, "the source identity is taken from the bytes that were compiled, not from a second read of the file");
  assert.match(loader, /src\.slice\(0, 4096\) \+ src\.slice\(-4096\)/, "the hash covers the first and the last 4,096 characters");
  assert.equal((loader.match(/\.children/g) || []).length, 3, "the parent's children list is named only in the one guarded statement (the array check, lastIndexOf, splice)");
  assert.equal((loader.match(/\.splice\(/g) || []).length, 1, "exactly one splice");
  assert.match(loader, /try \{ const p = module\.parent; if \(p && Array\.isArray\(p\.children\)\) \{ const i = p\.children\.lastIndexOf\(module\); if \(i >= 0\) p\.children\.splice\(i, 1\); \} \} catch/, "the splice is guarded by try/catch and by a parent check");
  assert.ok(!/require\.cache|delete require/.test(loader), "the loader never touches require.cache: CCR deletes its own entry");
  assert.ok(!/\b(readFileSync|writeFileSync|appendFileSync|setTimeout|setInterval|openSync|readdirSync)\b/.test(loader), "no other I/O and no timer in the loader");
  const body = code.slice(0, loaderAt);
  assert.match(body, /return module\.exports;\s*\};\s*$/, "the factory returns the function that carries __test");
  assert.ok(ROUTER.includes("module.exports.__test = seam;"));
  assert.ok(!/__uwRouterImpl/.test(body), "the registry is touched by the loader only");
});

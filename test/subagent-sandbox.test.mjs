// Offline checks for the S0 sandbox pieces (stub upstream, probe router, spec and refusal logic, PASS/FINDING parsing, arguments, the
// orchestrator flow). Nothing here starts a CCR daemon, runs the sandbox, or contacts 127.0.0.1:3456-3458 or 4517: the stub listens only on an
// OS-assigned loopback port, the router files run as COPIES in fresh mkdtemp dirs, and the orchestrator is driven with an in-memory fs and a
// fake world (fake sys, fake rpc, fake fetch, fake clock). Real-fs tests (junctions, the real fixture compile) use fresh mkdtemp trees only.
// Fake credentials are built at runtime from split pieces.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createStub, assertStubPort, assertStubHost, STUB_HOST, assertLabelsPath, MARKER_RE, STUB_PORT, RECORDED_HEADERS, normaliseStep } from "../harness/stub-upstream.mjs";
import { STUB_PORT as CFG_STUB_PORT, PORT_RANGE as CFG_RANGE, WEB_PORT, WEB_AUTH_TOKEN, CCR_CONFIG_DIR as CFG_CCR_DIR, CCR_SERVICE_JSON } from "../harness/config.mjs";
import * as config from "../harness/config.mjs";
import {
  buildSpec, assertSandboxSpec, safeWritePath, safeEvidencePath, SIDE_EFFECTS, CANNOT_VERIFY, NEVER_TOUCH, SANDBOX_OWNED, SCRATCH_ROOT, REPO_ROOT, HARNESS_DIR, PROBE_ROUTER_SRC,
  NEXT_ROUTER_SRC, SCRATCH_ROUTER, SCRATCH_STATE_DIR, LIVE_SETTINGS, LIVE_SERVICE_JSON, GUARD_LOADED_LOG, VIOLATIONS_LOG, TAKEOVER_FILE,
  PRELOAD_ARG, RefusalError, formatLine, parseLine, evaluateRun, REQUIRED, fingerprintLive, diffFingerprint, describeFingerprint, baselineOf, proveIsolation,
  assertIsolationProven, parseListenPorts, PROTECTED_ROOTS, SANDBOX_PORTS, REAL_PORTS, SCRATCH_SETTINGS, EVIDENCE_ROOT, APPROVAL_FILE, PRECREATE_DIRS, START_CREATES, MUST_BE_ABSENT, ENV_DIR_VARS,
  treeOf, liveServicePid, realish, LIVE_STATE_SUBAGENT, ROUTER_RUNTIME_RE, CCR_CONFIG_DIR, hashExecutedFiles, EXECUTED_FILES, descendantsLeafFirst, BOOTSTRAP_LIVE_SAFE, resolveCcrInstall, ccrInstallLines, approvalUsedFile, isApprovalUsedFile, distOf, isUnder, PROOF_RETRY, isTransientNetError,
} from "../harness/subagent-sandbox-spec.mjs";
import {
  parseArgs, runE2e, renderPlan, planOf, buildRequest, findProfileKey, buildShadowPolicy, realSys, evalA0Probe, evalE4, evalE5, evalE12, evalE7, evalE13, evalA1,
  evalA0Next, evalA2, evalA8, evalA11, ANCHOR, TAG_MODEL, ASKED_MODEL, E4_MARK, EXPERIMENTS, bareOf, modelIs, minimalEnv, MINIMAL_ENV_KEYS, assertGatewayUrl, USAGE,
  realOnSignal, HANDLED_SIGNALS, OPERATING_NOTES, llmkeyTargetLines, ensureProfileKey, profileKeyId,
  buildEnforcePolicy, X8_MARK, NOTICE_MARK, X9_MODES, X9_CASES, fallbackFor, evalX1, evalX2, evalX3, evalX4, evalX5, evalX7, evalX8, evalX9a, evalX9b, evalX9c, evalX9d, evalX9e, x9Table, evalH1,
  hostCheckX6, X6_DEFAULTS, bodyHashes, X5_LENGTHS, NOT_RUN, policyContentHash, proxyVarsSet,
} from "../harness/subagent-e2e.mjs";
import { makeTripwire, tripwireCollectors, assertRouterClean as realAssertRouterClean } from "../harness/guard.mjs";

const require = createRequire(import.meta.url);
const tmpRoots = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-s0-test-")); tmpRoots.push(d); return d; };
after(() => { for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true }); });
const fake = (kind) => ["test", kind, crypto.randomBytes(6).toString("hex")].join("-");   // not secret-shaped; assembled at runtime
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ASCII_KEY = ["s", "k-", "A1b2C3d4E5f6G7h8I9j0K1l2"].join("");                        // secret-SHAPED, assembled from pieces (GitHub push protection)

// ---------------------------------------------------------------- stub upstream
let stub, stubPort;
before(async () => { stub = createStub({ port: 0 }); stubPort = await stub.start(); });
after(async () => { await stub.stop(); });
const post = (body, headers = {}, p = "/v1/messages") => fetch(`http://127.0.0.1:${stubPort}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("stub: records model, whitelisted headers, body size and hash, tool names and the Agent description; never a credential or the body", async () => {
  stub.clear();
  const key = fake("key");
  const body = { model: "uwstub/m-free", max_tokens: 8, system: "secret-looking system text", messages: [{ role: "user", content: "private user text" }],
    tools: [{ name: "Agent", description: "agent desc [x]", input_schema: { type: "object" } }, { name: "Bash", description: "b" }] };
  const raw = JSON.stringify(body);
  const res = await post(raw, { "x-api-key": key, authorization: `Bearer ${key}`, "anthropic-beta": "context-1m", "x-uw-subpolicy": "probe", "x-claude-code-session-id": "s1" });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.content[0].type, "text");
  const [r] = stub.records;
  assert.equal(r.model, "uwstub/m-free");
  assert.equal(r.bodyBytes, Buffer.byteLength(raw));
  assert.equal(r.bodySha256, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.deepEqual(r.toolNames, ["Agent", "Bash"]);
  assert.equal(r.agentToolDescription, "agent desc [x]");
  assert.equal(r.headers["anthropic-beta"], "context-1m");
  assert.equal(r.headers["x-uw-subpolicy"], "probe");
  const dump = JSON.stringify(r);
  for (const leak of [key, "private user text", "secret-looking system text", "authorization", "x-api-key"]) assert.ok(!dump.includes(leak), `record must not contain ${leak}`);
});

test("stub: answers a valid SSE stream for stream:true and JSON otherwise; 404 for other routes; 400 for a non-JSON body (still recorded)", async () => {
  stub.clear();
  const s = await post({ model: "m", stream: true, messages: [] });
  assert.equal(s.headers.get("content-type"), "text/event-stream");
  const txt = await s.text();
  const types = [...txt.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
  assert.deepEqual(types, ["message_start", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
  assert.equal((await fetch(`http://127.0.0.1:${stubPort}/v1/other`, { method: "POST", body: "{}" })).status, 404);
  assert.equal((await post("not json")).status, 400);
  assert.equal(stub.records.length, 3);
  assert.equal(stub.records[2].model, null);
});

test("stub: scripted Agent call carries the UWGT marker, the counter is per label, and a later body containing the marker is labelled in the labels file", async () => {
  const dir = mk();
  const labelsFile = path.join(dir, "labels.jsonl");
  const s2 = createStub({ port: 0, labelsFile, script: { onMain: () => ({ subagent_type: "Explore", label: "sub-explore" }) } });
  const p = await s2.start();
  try {
    const call = async (body, headers = {}) => (await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })).json();
    const main = { model: "m", messages: [{ role: "user", content: "go" }], tools: [{ name: "Agent" }] };
    const a = await call(main);
    const b = await call(main);
    assert.equal(a.stop_reason, "tool_use");
    assert.equal(a.content[0].name, "Agent");
    assert.equal(a.content[0].input.subagent_type, "Explore");
    assert.match(a.content[0].input.prompt, MARKER_RE);
    assert.equal(MARKER_RE.exec(a.content[0].input.prompt)[2], "1");
    assert.equal(MARKER_RE.exec(b.content[0].input.prompt)[2], "2");
    // a subagent request (agent id header) carrying the marker is NOT a main request: plain text reply, and the marker is labelled
    const sub = await call({ model: "m", messages: [{ role: "user", content: a.content[0].input.prompt }], tools: [{ name: "Agent" }] }, { "x-claude-code-agent-id": "ag1", "x-claude-code-session-id": "sid-7" });
    assert.equal(sub.stop_reason, "end_turn");
    const labels = fs.readFileSync(labelsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(labels.map((l) => [l.label, l.n, l.sid]), [["sub-explore", 1, "sid-7"]]);
    assert.ok(s2.records[2].marker && s2.records[2].marker.label === "sub-explore");
  } finally { await s2.stop(); }
});

test("stub: refuses live ports, ports outside the sandbox range, a labels file outside scratch or tmp, and binds loopback only", () => {
  for (const p of [3456, 3457, 3458, 4517]) assert.throws(() => assertStubPort(p), /LIVE port/);
  for (const p of [80, CFG_RANGE[0] - 1, CFG_RANGE[1] + 1, -1, 1.5]) assert.throws(() => assertStubPort(p));
  assert.doesNotThrow(() => assertStubPort(0));
  assert.doesNotThrow(() => assertStubPort(STUB_PORT));
  assert.equal(STUB_PORT, SANDBOX_PORTS.stub);
  assert.throws(() => createStub({ port: 3456 }), /LIVE port/);
  assert.throws(() => assertLabelsPath(path.join(REPO_ROOT, "state", "labels.jsonl")), /outside/);
  assert.throws(() => assertLabelsPath(path.join(os.homedir(), ".llmkeys", "x.jsonl")), /outside/);
  assert.doesNotThrow(() => assertLabelsPath(path.join(os.tmpdir(), "x.jsonl")));
  assert.doesNotThrow(() => assertLabelsPath(path.join(SCRATCH_ROOT, "state", "x.jsonl")));
});

test("single source: STUB_PORT and the sandbox port range are defined ONCE (harness/config.mjs) and imported everywhere (code#16)", () => {
  assert.equal(STUB_PORT, CFG_STUB_PORT);
  assert.equal(STUB_PORT, 39459, "port 39459 stays");
  assert.deepEqual(CFG_RANGE, [39456, 39489]);
  const src = (f) => fs.readFileSync(path.join(HARNESS_DIR, f), "utf8");
  for (const f of ["subagent-sandbox-spec.mjs", "stub-upstream.mjs", "subagent-e2e.mjs"]) {
    const t = src(f);
    assert.ok(!/\b39459\b|\b39489\b/.test(t), `${f} restates a sandbox port literal instead of importing it`);
    assert.ok(!/\b(STUB_PORT|PORT_RANGE|RELAY_PORT)\s*=/.test(t), `${f} redefines a port constant`);
  }
  assert.match(src("config.mjs"), /export const STUB_PORT = 39459/);
  assert.match(src("config.mjs"), /3\.1\.1/, "the stopped 3.1.1 plan's headroom reservation is noted beside the constant");
  assert.equal(SANDBOX_PORTS.stub, STUB_PORT);
});

// ---------------------------------------------------------------- config.mjs rpc: sandbox web port only, no redirects (sec#11, sec#12)
test("config rpc: refuses a service.json that names any port but the sandbox web port, and every sandbox fetch uses redirect:error", async () => {
  const svc = (port) => JSON.stringify({ pid: 1234, url: `http://127.0.0.1:${port}/?ccr_web_token=${WEB_AUTH_TOKEN}` });
  let svcText = svc(3458), fetched = [];
  const e1 = mock.method(fs, "existsSync", (p) => (path.resolve(String(p)) === path.resolve(CCR_SERVICE_JSON) ? true : e1.mock.original(p)));
  const r1 = mock.method(fs, "readFileSync", (p, ...a) => (path.resolve(String(p)) === path.resolve(CCR_SERVICE_JSON) ? svcText : r1.mock.original(p, ...a)));
  const f1 = mock.method(globalThis, "fetch", async (url, init) => { fetched.push([String(url), init]); return { json: async () => ({ ok: true, value: "v" }) }; });
  try {
    await assert.rejects(config.rpc("getConfig"), /rpc refused: .*web port 3458, not 39458/);
    assert.equal(fetched.length, 0, "no request was made to the live web port");
    svcText = svc(WEB_PORT);
    assert.equal(await config.rpc("getConfig"), "v");
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][0], `http://127.0.0.1:${WEB_PORT}/api/ccr/rpc`);
    assert.equal(fetched[0][1].redirect, "error");
  } finally { f1.mock.restore(); r1.mock.restore(); e1.mock.restore(); }
});

// ---------------------------------------------------------------- the probe router (as a COPY in a temp tree)
function probeTree() {
  const root = mk();
  fs.mkdirSync(path.join(root, "spike"), { recursive: true });
  const file = path.join(root, "spike", "uw-router.cjs");
  fs.copyFileSync(PROBE_ROUTER_SRC, file);
  const fresh = () => { delete require.cache[require.resolve(file)]; return require(file); };
  return { root, file, fresh, state: path.join(root, "state", "subagent") };
}
const dropRouterState = () => { const st = globalThis.__uwSub; if (st && st.fds) for (const k of ["d", "c"]) if (st.fds[k]) { try { fs.closeSync(st.fds[k].fd); } catch { /* closed */ } } delete globalThis.__uwSub; };
const lines = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const setMode = (t, mode) => { fs.mkdirSync(t.state, { recursive: true }); fs.writeFileSync(path.join(t.state, "probe-control.json"), JSON.stringify({ mode })); };

test("probe router (tracked at harness/probe-router.cjs, outside the scratch root): records the A0 flags, tokenCount and content-length, edits the Agent description (E4), adds a header (E5), counts on globalThis (E7) with a module-scope control m", async () => {
  assert.ok(!PROBE_ROUTER_SRC.toLowerCase().startsWith(SCRATCH_ROOT.toLowerCase() + path.sep), "the probe source is outside the scratch root: the stock teardown cannot delete it");
  assert.equal(path.dirname(PROBE_ROUTER_SRC), HARNESS_DIR);
  assert.ok(fs.existsSync(PROBE_ROUTER_SRC));
  const t = probeTree();
  delete globalThis.__uwProbeN;
  const req = () => ({ body: { model: ASKED_MODEL, tools: [{ name: "Agent", description: "d" }, { name: "Bash", description: "b" }] }, headers: { "content-length": "321", "x-claude-code-agent-id": "a1" },
    builtInClaudeCodeSubagent: true, builtInSubagentModel: TAG_MODEL, tokenCount: 77 });
  const r1 = req();
  assert.equal(await t.fresh()(r1), ASKED_MODEL);
  assert.equal(r1.body.tools[0].description, `d\n${E4_MARK}`);
  assert.equal(r1.body.tools[1].description, "b");
  assert.equal(r1.headers["x-uw-subpolicy"], "probe");
  await t.fresh()(req()); await t.fresh()(req());              // a fresh require each time: CCR deletes the cache entry per request
  const log = lines(path.join(t.state, "probe.jsonl"));
  assert.deepEqual(log.map((l) => l.n), [1, 2, 3]);
  assert.deepEqual(log.map((l) => l.m), [1, 1, 1], "the module is re-evaluated each time: the module-scope control stays 1");
  assert.equal(log[0].bl, true); assert.equal(log[0].tag, TAG_MODEL); assert.equal(log[0].tokenCount, 77); assert.equal(log[0].contentLength, "321"); assert.equal(log[0].mutated, true);
  assert.match(evalE7(log), /^PASS \[probe\] E7 globalThis counter n=1,2,3 persists while the module-scope control m stays 1/);
  delete globalThis.__uwProbeN;
});

test("probe router: E7 control counter: a require cache that is NOT deleted makes m rise with n, and the evaluator says 'cache not deleted' instead of PASS (code#5)", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN;
  const route = t.fresh();
  const req = () => ({ body: { model: ASKED_MODEL }, headers: {} });
  await route(req()); await route(req()); await route(req());  // the SAME module instance: nothing deleted the cache
  const log = lines(path.join(t.state, "probe.jsonl"));
  assert.deepEqual(log.map((l) => [l.n, l.m]), [[1, 1], [2, 2], [3, 3]]);
  assert.match(evalE7(log), /^FINDING \[probe\] E7 cache not deleted/);
  assert.match(evalE7(log.map(({ m: _m, ...x }) => x)), /^FINDING \[probe\] E7 .*no module-scope control counter/, "lines without m cannot be judged");
  delete globalThis.__uwProbeN;
});

test("probe router: mutated is false (not absent) when the body has no Agent tool, so E4 is unmeasured, not silently passed (code#8)", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN;
  await t.fresh()({ body: { model: ASKED_MODEL, tools: [{ name: "Bash", description: "b" }] }, headers: {} });
  const [l] = lines(path.join(t.state, "probe.jsonl"));
  assert.strictEqual(l.mutated, false);
  assert.match(evalE4({ stubRec: { agentToolDescription: `x ${E4_MARK}` }, probe: l }), /^FINDING \[probe\] E4 .*unmeasured/);
  assert.match(evalE4({ stubRec: { agentToolDescription: `x ${E4_MARK}` }, probe: { mode: "mutate" } }), /^FINDING \[probe\] E4 .*unmeasured/, "an absent mutated is unmeasured too (!== true)");
  delete globalThis.__uwProbeN;
});

test("probe router: keep-tag (E13 control) clears nothing, returns undefined and edits nothing; clear-tag clears the tag; an empty model returns undefined; no module-scope effect", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN;
  setMode(t, "keep-tag");
  const k = { body: { model: ASKED_MODEL, tools: [{ name: "Agent", description: "d" }] }, headers: {}, builtInSubagentModel: TAG_MODEL };
  assert.equal(await t.fresh()(k), undefined);
  assert.equal(k.builtInSubagentModel, TAG_MODEL, "the control arm leaves the tag in place");
  assert.equal(k.body.tools[0].description, "d");
  assert.equal(k.headers["x-uw-subpolicy"], undefined);
  setMode(t, "clear-tag");
  const r = { body: { model: ASKED_MODEL, tools: [{ name: "Agent", description: "d" }] }, headers: {}, builtInSubagentModel: TAG_MODEL };
  assert.equal(await t.fresh()(r), undefined);
  assert.equal(r.builtInSubagentModel, undefined);
  assert.equal(r.body.tools[0].description, "d");
  assert.equal(r.headers["x-uw-subpolicy"], undefined);
  assert.deepEqual(lines(path.join(t.state, "probe.jsonl")).map((l) => l.mode), ["keep-tag", "clear-tag"]);
  assert.equal(await t.fresh()({ body: {} }), undefined);
  const root2 = mk();                                          // loading the module alone writes nothing (no module-scope side effect)
  fs.mkdirSync(path.join(root2, "spike"), { recursive: true });
  fs.copyFileSync(PROBE_ROUTER_SRC, path.join(root2, "spike", "uw-router.cjs"));
  require(path.join(root2, "spike", "uw-router.cjs"));
  assert.equal(fs.existsSync(path.join(root2, "state")), false);
  delete globalThis.__uwProbeN;
});

// ---------------------------------------------------------------- the exact bytes of router/uw-router.next.cjs, as a COPY, driven like CCR drives it
test("next router (real bytes, temp tree): A1 absent policy is exact and silent; the synthetic shadow policy gives A0/A2 evidence; globalThis counters accumulate (A8)", async () => {
  const root = mk();
  fs.mkdirSync(path.join(root, "spike"), { recursive: true });
  const file = path.join(root, "spike", "uw-router.cjs");
  fs.copyFileSync(NEXT_ROUTER_SRC, file);
  fs.writeFileSync(path.join(root, "spike", "slot.json"), JSON.stringify({ model: "anthropic/claude-opus-5" }));
  assert.equal(sha(fs.readFileSync(file)), sha(fs.readFileSync(NEXT_ROUTER_SRC)));
  const state = path.join(root, "state", "subagent");
  const route = () => { delete require.cache[require.resolve(file)]; return require(file); };
  const config_ = { Providers: [{ name: "uwstub", enabled: true, models: ["m-main", "m-free", "m-big"] }] };
  const sub = () => ({ body: { model: ASKED_MODEL, tools: [{ name: "Agent" }, { name: "Bash" }] }, headers: { "x-claude-code-agent-id": "uws0-a2", "x-claude-code-session-id": "uws0-main", "content-length": "100" },
    builtInClaudeCodeSubagent: true, builtInSubagentModel: TAG_MODEL, tokenCount: 10, sessionId: "uws0-main" });
  dropRouterState();
  try {
    const a = await route()({ body: { model: "uwstub/m-main", tools: [{ name: "Agent" }] }, headers: { "x-claude-code-session-id": "uws0-main" } }, config_);
    const b = await route()(sub(), config_);
    assert.equal(evalA1({ models: [a, b], expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: fs.existsSync(state) }),
      formatLine("PASS", "next", "A1", `policy absent: the upstream received exactly the requested models uwstub/m-main, ${ASKED_MODEL} (spelling: selector) and the router wrote nothing`));
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "policy.json"), JSON.stringify(buildShadowPolicy(new Date("2026-10-03T00:00:00Z"))));
    const ret = await route()(sub(), config_);
    assert.equal(ret, ASKED_MODEL);
    route().__test.flush();                                                                      // R7: the first status write is asynchronous like every other; the seam flush writes it now
    const first = JSON.parse(fs.readFileSync(path.join(state, "status.json"), "utf8"));
    await route()({ body: { model: "uwstub/m-main", tools: [{ name: "Agent" }] }, headers: { "x-claude-code-session-id": "uws0-main" }, sessionId: "uws0-main" }, config_);
    await route()({ body: { model: "uwstub/m-main", tools: [{ name: "Agent" }] }, headers: { "x-claude-code-session-id": "uws0-main" }, sessionId: "uws0-main" }, config_);
    const dec = lines(path.join(state, "decisions.jsonl")).find((x) => x.role === "sub");
    const cls = lines(path.join(state, "classify.jsonl")).find((x) => x.cls === "sub");
    assert.match(evalA0Next({ classify: cls, decision: dec }), /^PASS \[next\] A0 /);
    assert.match(evalA2({ decision: dec, stubModel: ret }), /^PASS \[next\] A2 /);
    route().__test.flush();
    const status = JSON.parse(fs.readFileSync(path.join(state, "status.json"), "utf8"));
    assert.equal(status.policy.state, "ok", "the router's own loader accepts the synthetic policy");
    assert.equal(globalThis.__uwSub.counters.req, 5, "counters accumulate across fresh requires (five calls here)");
    assert.equal(first.since, status.since, "status.since is stable across flushes in one process");
    assert.match(evalA8({ status: { counters: { req: 6 }, since: status.since }, first: { since: first.since }, min: 6, loadFailure: false, logFiles: 0 }), /^PASS \[next\] A8 /);
  } finally { dropRouterState(); }
});

// ---------------------------------------------------------------- spec and refusal logic (pure)
test("spec: the default launch spec passes, every redirect is under the scratch root, the web port is forced, and nothing inherited can carry a credential or proxy", () => {
  const parent = { PATH: "C:\\x", SystemRoot: "C:\\Windows", ANTHROPIC_API_KEY: fake("k"), HTTPS_PROXY: "http://p", CLAUDE_CODE_OAUTH_TOKEN: fake("t"), CCR_WEB_PORT: "3458", OPENAI_API_KEY: fake("o") };
  const spec = buildSpec(parent);
  assert.doesNotThrow(() => assertSandboxSpec(spec));
  const env = spec.env;
  for (const k of ["ANTHROPIC_API_KEY", "HTTPS_PROXY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY"]) assert.equal(env[k], undefined);
  assert.equal(env.CCR_WEB_PORT, "39458", "the inherited 3458 is overridden, never trusted");
  assert.equal(env.PORT, "39456");
  assert.equal(env.NODE_OPTIONS, PRELOAD_ARG);
  assert.equal(env.PATH, "C:\\x");
  assert.deepEqual(Object.values(spec.ports).sort(), [39456, 39457, 39458, 39459]);
  assert.ok(!REAL_PORTS.some((p) => Object.values(spec.ports).includes(p)));
  assert.doesNotThrow(() => assertSandboxSpec(buildSpec(parent, { preloadGuard: false })));
  assert.equal(buildSpec(parent, { preloadGuard: false }).env.NODE_OPTIONS, undefined);
});

test("spec: assertSandboxSpec REFUSES each tamper that could reach live state", () => {
  const base = () => buildSpec({ PATH: "C:\\x" });
  const bad = (mut, re) => { const s = base(); mut(s); assert.throws(() => assertSandboxSpec(s), (e) => e instanceof RefusalError && re.test(e.message), String(re)); };
  bad((s) => { delete s.env.CCR_WEB_PORT; }, /CCR_WEB_PORT/);
  bad((s) => { s.env.CCR_WEB_PORT = "3458"; }, /CCR_WEB_PORT/);
  bad((s) => { s.env.PORT = "3456"; }, /PORT/);
  bad((s) => { s.ports.gateway = 3456; }, /outside|LIVE/);
  bad((s) => { s.ports.stub = 4517; }, /outside|LIVE/);
  bad((s) => { s.ports.core = s.ports.gateway; }, /distinct/);
  bad((s) => { s.env.LOCALAPPDATA = path.join(os.homedir(), "AppData", "Local"); }, /LOCALAPPDATA/);
  bad((s) => { delete s.env.CCR_INTERNAL_APP_DATA_DIR; }, /CCR_INTERNAL_APP_DATA_DIR/);
  bad((s) => { s.env.USERPROFILE = os.homedir(); }, /USERPROFILE/);
  bad((s) => { s.env.HTTPS_PROXY = "http://proxy"; }, /proxy/);
  bad((s) => { s.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:3456"; }, /credential or routing/);
  bad((s) => { s.env.SOME_API_KEY = "x"; }, /credential or routing/);
  bad((s) => { s.settingsFile = LIVE_SETTINGS; }, /settingsFile/);
  bad((s) => { s.routers.scratchCopy = path.join(REPO_ROOT, "spike", "uw-router.cjs"); }, /inside the sandbox root/);
  bad((s) => { s.root = path.join(REPO_ROOT, "state"); }, /not the sandbox scratch root/);
  bad((s) => { s.env.NODE_OPTIONS = "--require x.cjs"; }, /NODE_OPTIONS/);
  bad((s) => { s.env.UW_TRIAL31_PROTECTED += `;${path.join(os.homedir(), ".uw")}`; }, /contains the sandbox root/);
  bad((s) => { s.env.UW_TRIAL31_PROTECTED = s.env.UW_TRIAL31_PROTECTED.split(";").filter((r) => !/\.llmkeys$/i.test(r)).join(";"); }, /llmkeys/);
  bad((s) => { s.env.UW_TRIAL31_REAL_PORTS = "3456,3457"; }, /real ports/);
  bad((s) => { s.env.CCR_WEB_HOST = "0.0.0.0"; }, /127\.0\.0\.1/);
  bad((s) => { s.env.TEMP = path.join(SCRATCH_ROOT, "elsewhere-not-precreated"); }, /neither pre-created by the preflight nor created by start\.ps1/);
});

test("spec: safeWritePath accepts only the scratch root (or a named extra root) and refuses every protected path and traversal", () => {
  assert.doesNotThrow(() => safeWritePath(path.join(SCRATCH_ROOT, "spike", "uw-router.cjs")));
  const home = os.homedir();
  for (const p of [path.join(REPO_ROOT, "state", "bench.json"), path.join(REPO_ROOT, "state", "subagent", "policy.json"), path.join(home, ".llmkeys", "registry.json"),
    path.join(home, ".claude", "settings.json"), path.join(REPO_ROOT, "catalog", "snapshot.json"), path.join(REPO_ROOT, "router", "uw-router.next.cjs"),
    path.join(REPO_ROOT, "spike", "uw-router.cjs"), path.join(SCRATCH_ROOT, "..", "..", "state", "x.json"), path.join(SCRATCH_ROOT, "..", "elsewhere.txt"), path.join(os.tmpdir(), "x.txt"),
    "\\\\localhost\\C$\\Users\\osami\\.uw\\state\\x.json"]) {
    assert.throws(() => safeWritePath(p), RefusalError, p);
  }
  assert.doesNotThrow(() => safeWritePath(path.join(os.tmpdir(), "x.txt"), [os.tmpdir()]));
  assert.throws(() => safeWritePath(path.join(home, ".llmkeys", "x"), [home]), RefusalError, "a protected path stays protected even under an allowed extra root");
});

test("spec: safeWritePath re-checks the REALPATH: a junction inside an allowed tree that leads to a protected or outside folder is refused (sec#9); the retained-evidence path accepts its two exact places only", () => {
  const T = mk(), allowed = path.join(T, "allowed"), forbidden = path.join(T, "forbidden"), outside = path.join(T, "outside");
  for (const d of [allowed, forbidden, outside]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(forbidden, "keep.txt"), "keep");
  const toForbidden = path.join(allowed, "link-protected"), toOutside = path.join(allowed, "link-outside");
  fs.symlinkSync(forbidden, toForbidden, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(outside, toOutside, process.platform === "win32" ? "junction" : "dir");
  try {
    assert.doesNotThrow(() => safeWritePath(path.join(allowed, "ok", "x.txt"), [allowed], [forbidden]), "a plain path under the allowed root is fine");
    assert.throws(() => safeWritePath(path.join(toForbidden, "x.txt"), [allowed], [forbidden]), (e) => e instanceof RefusalError && /under protected/.test(e.message), "lexically allowed, really under a protected root");
    assert.throws(() => safeWritePath(path.join(toForbidden, "deeper", "not-yet", "x.txt"), [allowed], [forbidden]), RefusalError, "a target that does not exist yet still resolves through the junction");
    assert.throws(() => safeWritePath(path.join(toOutside, "x.txt"), [allowed]), (e) => e instanceof RefusalError && /outside the sandbox scratch root/.test(e.message), "lexically allowed, really outside every allowed root");
    assert.equal(realish(path.join(toOutside, "a", "b")), path.join(fs.realpathSync.native(outside), "a", "b"));
    // Node's recursive rm unlinks a link inside a tree, it does not follow it (the teardown's rmSafe relies on this)
    fs.rmSync(allowed, { recursive: true, force: true });
    assert.ok(fs.existsSync(path.join(forbidden, "keep.txt")), "removing a tree that holds a junction left the junction's target alone");
  } finally { for (const l of [toForbidden, toOutside]) { try { fs.rmdirSync(l); } catch { /* removed above */ } } }
  assert.doesNotThrow(() => safeEvidencePath(path.join(EVIDENCE_ROOT, "2026-10-03T00-00-00-000Z", "violations.log.txt")));
  assert.doesNotThrow(() => safeEvidencePath(APPROVAL_FILE));
  for (const p of [path.join(SCRATCH_ROOT, "x.txt"), path.join(REPO_ROOT, "state", "x.json"), path.join(HARNESS_DIR, "other.txt"), path.join(HARNESS_DIR, "g1-approval.json.bak"), path.join(os.homedir(), ".claude", "x"), path.join(os.tmpdir(), "x")]) {
    assert.throws(() => safeEvidencePath(p), RefusalError, p);
  }
  assert.ok(!SANDBOX_OWNED.some((n) => path.join(SCRATCH_ROOT, n).toLowerCase() === EVIDENCE_ROOT.toLowerCase()) && !EVIDENCE_ROOT.toLowerCase().startsWith(SCRATCH_ROOT.toLowerCase() + path.sep), "evidence lives outside SANDBOX_OWNED and the scratch root");
  assert.ok(!APPROVAL_FILE.toLowerCase().startsWith(SCRATCH_ROOT.toLowerCase() + path.sep));
  const gi = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  assert.match(gi, /^harness\/g1-\*$/m, "evidence and approval are gitignored");
  assert.ok(!execFileSyncOk("git", ["check-ignore", "-q", "harness/probe-router.cjs"]), "the probe router source is NOT ignored (it is tracked source)");
});
function execFileSyncOk(cmd, args) { try { execFileSync(cmd, args, { cwd: REPO_ROOT, stdio: "ignore" }); return true; } catch { return false; } }

test("spec: the side-effect inventory names every surface the owner listed, and NEVER_TOUCH covers the paths the task forbids", () => {
  const ids = SIDE_EFFECTS.map((s) => s.id);
  for (const need of ["live-settings", "credential-manager", "live-ports", "web-port", "sandbox-ports", "process-list", "claude-config-dir", "uw-state", "llmkeys", "uw-catalog", "network-egress-update-checks", "logs", "hkcu-path", "live-service-json", "global-profile-takeover", "system-proxy"]) {
    assert.ok(ids.includes(need), `missing side effect ${need}`);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SIDE_EFFECTS) assert.ok(["prevent", "detect", "prevent+detect", "record"].includes(s.mode) && s.how.length > 10, s.id);
  const nt = NEVER_TOUCH.map((p) => p.toLowerCase());
  for (const need of [path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".llmkeys"), path.join(REPO_ROOT, "state"), path.join(REPO_ROOT, "catalog")]) assert.ok(nt.includes(need.toLowerCase()), need);
  assert.ok(CANNOT_VERIFY.length >= 6);
  assert.ok(!SANDBOX_OWNED.includes("probe-router.cjs"), "teardown never deletes the probe router source");
});

test("spec: line format round-trips, malformed lines parse to null, evaluateRun enforces the required ids and must-pass ids", () => {
  const l = formatLine("FINDING", "probe", "E12", "tokenCount\nABSENT   at the router");
  assert.equal(l, "FINDING [probe] E12 tokenCount ABSENT at the router");
  assert.deepEqual(parseLine(l), { kind: "FINDING", router: "probe", id: "E12", detail: "tokenCount ABSENT at the router" });
  for (const bad of ["PASS probe A0 x", "pass [probe] A0 x", "PASS [probe] Z0 x", "PASS [live] A0 x", "", "PASS [next] A1"]) assert.equal(parseLine(bad), null, bad);
  assert.throws(() => formatLine("OK", "probe", "A0", "x")); assert.throws(() => formatLine("PASS", "live", "A0", "x")); assert.throws(() => formatLine("PASS", "probe", "Q9", "x"));
  const probeAll = REQUIRED.probe.present.map((id) => formatLine(id === "A0" ? "PASS" : "FINDING", "probe", id, "x"));
  assert.equal(evaluateRun(probeAll, ["probe"]).ok, true);
  assert.match(evaluateRun(probeAll.filter((x) => !x.includes(" E5 ")), ["probe"]).problems[0], /E5 has no line/);
  assert.match(evaluateRun(probeAll.map((x) => x.replace("PASS [probe] A0", "FINDING [probe] A0")), ["probe"]).problems.join(), /A0 must PASS/);
  assert.equal(evaluateRun([...probeAll, formatLine("FAIL", "probe", "E4", "x")], ["probe"]).ok, false);
  const nextAll = REQUIRED.next.present.map((id) => formatLine("PASS", "next", id, "x"));
  assert.equal(evaluateRun(nextAll, ["next"]).ok, true);
  assert.equal(evaluateRun(nextAll.map((x) => x.replace("PASS [next] A11", "FINDING [next] A11")), ["next"]).ok, false, "A11 on the exact bytes is PASS-only");
  assert.equal(evaluateRun([...probeAll], ["probe", "next"]).ok, false, "both runs requested: the next lines are missing");
});

// ---------------------------------------------------------------- evaluators
const probeLine = (o = {}) => ({ n: 1, m: 1, pid: 9, mode: "mutate", bl: true, tag: TAG_MODEL, tokenCount: 50, contentLength: "900", mutated: true, ...o });
const rec = (o = {}) => ({ model: ASKED_MODEL, bodyBytes: 900, headers: { "x-uw-subpolicy": "probe" }, agentToolDescription: `d\n${E4_MARK}`, ...o });
test("evaluators: A0 FAILs for every missing gate signal and PASSes only with both", () => {
  assert.match(evalA0Probe({ status: 502 }), /^FAIL \[probe\] A0 the probe router never ran/);
  assert.match(evalA0Probe({ probe: probeLine({ bl: false }) }), /^FAIL \[probe\] A0 builtInClaudeCodeSubagent is not true/);
  assert.match(evalA0Probe({ probe: probeLine({ tag: null }) }), /^FAIL \[probe\] A0 builtInSubagentModel is null/);
  assert.match(evalA0Probe({ probe: probeLine() }), /^PASS \[probe\] A0 /);
  assert.match(evalA0Next({ classify: { bl: 0 }, decision: { tag: TAG_MODEL } }), /^FAIL \[next\] A0 /);
  assert.match(evalA0Next({ classify: { bl: 1 }, decision: { tag: null } }), /^FAIL \[next\] A0 /);
  assert.match(evalA0Next({}), /^FAIL \[next\] A0 .*no line/);
});
test("evaluators: E4 E5 E12 give FINDING (not FAIL) when the design is blocked and PASS when it holds; E12 needs a POSITIVE content-length and prints the upstream difference", () => {
  assert.match(evalE4({ stubRec: rec(), probe: probeLine() }), /^PASS \[probe\] E4/);
  assert.match(evalE4({ stubRec: rec({ agentToolDescription: "d" }), probe: probeLine() }), /^FINDING \[probe\] E4 .*did NOT reach/);
  assert.match(evalE4({ stubRec: rec(), probe: probeLine({ mutated: false }) }), /^FINDING \[probe\] E4 .*unmeasured/);
  assert.match(evalE4({ status: 502 }), /^FINDING \[probe\] E4 no upstream request/);
  assert.match(evalE5({ stubRec: rec() }), /^PASS \[probe\] E5/);
  assert.match(evalE5({ stubRec: rec({ headers: {} }) }), /^FINDING \[probe\] E5 .*ABSENT/);
  assert.match(evalE12({ probe: probeLine(), stubRec: rec() }), /^PASS \[probe\] E12 tokenCount=50 and content-length=900 .*upstream received 900 body bytes, \+0 against content-length/);
  assert.match(evalE12({ probe: probeLine(), stubRec: rec({ bodyBytes: 1000 }) }), /upstream received 1000 body bytes, \+100 against content-length/);
  assert.match(evalE12({ probe: probeLine({ contentLength: null }), stubRec: rec() }), /^FINDING \[probe\] E12 content-length ABSENT/);
  assert.match(evalE12({ probe: probeLine({ contentLength: "0" }), stubRec: rec() }), /^FINDING \[probe\] E12 content-length ABSENT or not a positive number/);
  assert.match(evalE12({ probe: probeLine({ contentLength: "-5" }), stubRec: rec() }), /^FINDING \[probe\] E12 content-length ABSENT or not a positive number/);
  assert.match(evalE12({ probe: probeLine({ contentLength: "abc" }), stubRec: rec() }), /^FINDING \[probe\] E12 content-length ABSENT or not a positive number/);
  assert.match(evalE12({ probe: probeLine({ tokenCount: null }) }), /^FINDING \[probe\] E12 tokenCount ABSENT/);
  assert.match(evalE12({}), /^FINDING \[probe\] E12 the probe router did not run/);
});
const arm = (mode, model, status = 200) => ({ status, stubRec: model === undefined ? undefined : rec({ model }), probe: probeLine({ mode }) });
test("evaluators: E13 has a CONTROL arm: the tag must be honoured first, in either model spelling, and a bare 'm-free' can no longer pass the clear arm vacuously (code#2, code#1)", () => {
  assert.match(evalE13({ control: arm("keep-tag", TAG_MODEL), clear: arm("clear-tag", ANCHOR) }), /^PASS \[probe\] E13 .*control arm served the tag \(uwstub\/m-free, selector spelling\)/);
  assert.match(evalE13({ control: arm("keep-tag", "m-free"), clear: arm("clear-tag", "m-main") }), /^PASS \[probe\] E13 .*control arm served the tag \(m-free, bare spelling\)/);
  // the vacuous-pass case: CCR sends bare names and clearing did NOT stop the tag; comparing against the full selector would have PASSed
  assert.match(evalE13({ control: arm("keep-tag", "m-free"), clear: arm("clear-tag", "m-free") }), /^FINDING \[probe\] E13 clearing builtInSubagentModel did NOT stop/);
  assert.match(evalE13({ control: arm("keep-tag", TAG_MODEL), clear: arm("clear-tag", TAG_MODEL) }), /^FINDING \[probe\] E13 clearing .* did NOT stop/);
  // control arm does not show the tag honoured: E13 is undecidable, whatever the clear arm did
  assert.match(evalE13({ control: arm("keep-tag", ASKED_MODEL), clear: arm("clear-tag", ANCHOR) }), /^FINDING \[probe\] E13 E13 undecidable: the control arm did not show the tag honoured/);
  assert.match(evalE13({ control: arm("keep-tag", undefined, 502), clear: arm("clear-tag", ANCHOR) }), /^FINDING \[probe\] E13 E13 undecidable: the control arm reached no upstream \(HTTP 502\)/);
  assert.match(evalE13({ clear: arm("clear-tag", ANCHOR) }), /^FINDING \[probe\] E13 E13 undecidable: the control arm \(probe mode keep-tag\) did not run/);
  assert.match(evalE13({ control: arm("mutate", TAG_MODEL), clear: arm("clear-tag", ANCHOR) }), /undecidable/, "a control that ran in the wrong mode is not a control");
  assert.match(evalE13({ control: arm("keep-tag", TAG_MODEL), clear: arm("clear-tag", undefined, 502) }), /^FINDING \[probe\] E13 inconclusive/);
  assert.match(evalE13({ control: arm("keep-tag", TAG_MODEL), clear: arm("mutate", ANCHOR) }), /^FINDING \[probe\] E13 the probe did not run in clear-tag mode/);
});
test("evaluators: ONE normaliser accepts the selector or the part after the first slash and nothing else; A1 and A2 record the observed spelling (code#1)", () => {
  assert.equal(bareOf("uwstub/m-free"), "m-free"); assert.equal(bareOf("a/b/c"), "b/c"); assert.equal(bareOf("plain"), "plain");
  assert.ok(modelIs("uwstub/m-free", TAG_MODEL) && modelIs("m-free", TAG_MODEL));
  assert.ok(!modelIs("other/m-free", TAG_MODEL) && !modelIs("m-big", TAG_MODEL) && !modelIs(undefined, TAG_MODEL) && !modelIs("M-FREE", TAG_MODEL));
  assert.match(evalA1({ models: ["m-main", "m-big"], expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: false }), /^PASS \[next\] A1 .*\(spelling: bare\)/);
  assert.match(evalA1({ models: ["uwstub/m-main", "m-big"], expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: false }), /^PASS \[next\] A1 .*\(spelling: selector\+bare\)/);
  assert.match(evalA1({ models: ["m-main", "m-free"], expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: false }), /^FAIL \[next\] A1 policy absent/);
  assert.match(evalA1({ models: ["m-main"], expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: false }), /^FAIL \[next\] A1 /, "a short list is not a match");
  assert.match(evalA2({ decision: { would: TAG_MODEL, ret: ASKED_MODEL }, stubModel: "m-big" }), /^PASS \[next\] A2 .*bare spelling/);
  assert.match(evalA2({ decision: { would: TAG_MODEL, ret: ASKED_MODEL }, stubModel: ASKED_MODEL }), /^PASS \[next\] A2 .*selector spelling/);
  assert.match(evalA2({ decision: { would: TAG_MODEL, ret: ASKED_MODEL }, stubModel: "m-free" }), /^FAIL \[next\] A2 shadow must return asked/);
});
test("evaluators: E7 distinguishes persistence, reset-per-request, several processes and an undeleted cache; A1 A2 A8 A11 FAIL on a violation", () => {
  const ns = (...a) => a.map((n) => ({ n, m: 1, pid: 1 }));
  assert.match(evalE7(ns(1, 2, 3)), /^PASS/);
  assert.match(evalE7(ns(1, 1, 1)), /^FINDING \[probe\] E7 .*did NOT persist/);
  assert.match(evalE7([{ n: 1, m: 1, pid: 1 }, { n: 2, m: 1, pid: 2 }, { n: 3, m: 1, pid: 1 }]), /^FINDING.*processes/);
  assert.match(evalE7(ns(1, 2)), /^FINDING.*unmeasured/);
  assert.match(evalE7([{ n: 1, m: 1, pid: 1 }, { n: 2, m: 2, pid: 1 }, { n: 3, m: 3, pid: 1 }]), /^FINDING \[probe\] E7 cache not deleted/);
  assert.match(evalA1({ models: ["a"], expected: ["b"], stateDirExists: false }), /^FAIL \[next\] A1/);
  assert.match(evalA1({ models: ["a"], expected: ["a"], stateDirExists: true }), /^FAIL \[next\] A1 .*silent/);
  assert.match(evalA2({ decision: { would: TAG_MODEL, ret: TAG_MODEL }, stubModel: TAG_MODEL }), /^FAIL \[next\] A2 shadow must return asked/);
  assert.match(evalA2({ decision: { would: "x", ret: ASKED_MODEL }, stubModel: ASKED_MODEL }), /^FAIL \[next\] A2 decision would/);
  assert.match(evalA2({}), /^FAIL \[next\] A2 no shadow decision/);
  const st = (o = {}) => ({ counters: { req: 6 }, since: "t0", ...o });
  assert.match(evalA8({ status: st(), first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 2 }), /^PASS \[next\] A8 .*status\.since stable .*in 2 CCR log files\.$/);
  assert.match(evalA8({ status: st({ counters: { req: 5 } }), first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 2 }), /^FAIL \[next\] A8 globalThis counters did not accumulate: counters\.req=5, expected at least 6/);
  assert.match(evalA8({ status: st({ counters: { req: 9 } }), first: { since: "t0" }, min: 6, loadFailure: true, logFiles: 2 }), /^FAIL \[next\] A8 CCR logged/);
  assert.match(evalA8({ status: null, first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 0 }), /^FAIL \[next\] A8/);
  assert.match(evalA8({ status: st({ since: "t1" }), first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 2 }), /^FAIL \[next\] A8 status\.since changed/);
  assert.match(evalA8({ status: st(), first: null, min: 6, loadFailure: false, logFiles: 2 }), /^FAIL \[next\] A8 no status\.json was captured at the first flush/);
  assert.match(evalA8({ status: st(), first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 0 }), /^PASS \[next\] A8 .*NOTE: 0 CCR log files were found, so the absence .* is UNVERIFIED/, "logFiles 0 is reported as a note");
  const fpA = { settingsSha: "a".repeat(64), settingsBaseUrl: "u", settingsMarkers: 2, liveServicePid: 7, liveServiceSha: "b".repeat(64), "listener:3456": 5, claudeSettingsNames: "settings.json:3" };
  assert.match(evalA11("next", fpA, { ...fpA }), /^PASS \[next\] A11 live gateway untouched: settings sha256 aaaaaaaaaaaa/);
  assert.match(evalA11("next", fpA, { ...fpA, "listener:3456": 6 }), /^FAIL \[next\] A11 .*listener:3456/);
  assert.match(evalA11("probe", fpA, { ...fpA, liveServicePid: 8 }), /^FAIL \[probe\] A11 .*liveServicePid/);
  assert.match(evalA11("probe", fpA, { ...fpA, credTargetsSha: "zzz" }), /^PASS/, "a non-gateway drift is the proof's job, not A11's");
  assert.match(evalA11("next", { ...fpA, liveServicePid: null }, { ...fpA, liveServicePid: null }), /^FINDING \[next\] A11 the live gateway was not observed in the baseline/, "no live pid in the baseline: unchanged proves nothing (code#7)");
  assert.match(evalA11("next", { ...fpA, "listener:3456": null }, { ...fpA, "listener:3456": null }), /^FINDING \[next\] A11 /);
});

test("synthetic shadow policy: deterministic for a fixed clock, three stub models, and the SAME SHAPE as a real compile() of the fixture trio (key sets at every level, the `i` price format, byProvider empty under all-providers)", async () => {
  const p = buildShadowPolicy(new Date("2026-10-03T00:00:00Z"));
  assert.equal(p.schema, 1);
  assert.equal(p.owner.enforcement, "shadow");
  assert.deepEqual(p.models.map((m) => m.s), ["uwstub/m-main", "uwstub/m-free", "uwstub/m-big"]);
  assert.equal(p.lists.all, null, "router v2: lists.all is null when it is the identity 0..n-1 (the router reads the rows by index)");
  assert.deepEqual(p.lists.prov, { uwstub: [0, 1, 2] });
  assert.deepEqual(buildShadowPolicy(new Date("2026-10-03T00:00:00Z")), p);
  // the REAL compiler, on the fixture trio materialised in a fresh temp tree (fixture flags only; no real vault, snapshot, bench or state path)
  const { fixtureFlagMap } = await import("./fixtures/subagent-flags.mjs");
  const pol = await import("../keysync/subagent-policy.mjs");
  const dir = path.join(mk(), "fx");
  const paths = pol.resolvePaths(fixtureFlagMap(dir));
  assert.ok(Object.values(paths).every((v) => v === null || v === undefined || typeof v !== "string" || String(v).toLowerCase().startsWith(os.tmpdir().toLowerCase()) || String(v).toLowerCase().startsWith(fs.realpathSync.native(os.tmpdir()).toLowerCase())), "every resolved path is under the temp dir");
  const g = await pol.gatherInputs(paths, { nowMs: Date.parse("2026-10-03T00:00:00Z") });
  const owner = { ...pol.OWNER_DEFAULTS, source: "all-providers", mode: "dynamic", enforcement: "shadow", inject: "off" };
  const { compiled } = pol.compile(g, owner, { now: () => new Date("2026-10-03T00:00:00Z") });
  // revision 11 (policy-side fix round): the compiler grew ADDITIVE keys the router never reads (a `reprobe` list, and counts for the non-agent drop, known issues, inferred ctx, re-probe and rows per ctx floor); the harness
  // synthetic policy is a hash-pinned router INPUT and is left as it is, so the shape comparison ignores exactly these
  const COMPILER_ONLY = { top: ["reprobe", "accountStateRows", "unreachable", "demoted", "gatewayCompat", "providerPatterns", "reprobeSkipped"], counts: ["nonAgent", "knownBad", "ctxInferred", "reprobe", "accountStateRows", "ctxStats", "unreachable", "demoted", "gatewayCompat", "ctxUnproven", "benchOk", "providerPatterns", "reprobeSkipped"] };
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(p).filter((k) => k !== "synthetic"), keys(compiled).filter((k) => !COMPILER_ONLY.top.includes(k)), "top-level keys (synthetic: true is the one documented extra; the compiler-only additive keys are ignored)");
  assert.equal(p.contentHash, pol.hashOf(p), "the router verifies contentHash, so the synthetic file carries the compiler's real hash of its own content");
  assert.equal(compiled.lists.all, null, "the real compile stores lists.all as null when it is the identity");
  assert.deepEqual(keys(p.rollout), keys(compiled.rollout), "keys of rollout");
  assert.equal(p.minRouter, compiled.minRouter);
  for (const k of ["owner", "builtFrom", "counts", "main", "sticky", "inject", "lists"]) assert.deepEqual(keys(p[k]), keys(compiled[k]).filter((x) => k !== "counts" || !COMPILER_ONLY.counts.includes(x)), `keys of ${k}`);
  assert.ok(compiled.lists.prov && typeof compiled.lists.prov === "object" && Object.keys(compiled.lists.prov).length > 0 && Object.values(compiled.lists.prov).every((l) => Array.isArray(l)), "prov is keyed by provider, as in the synthetic file");
  assert.deepEqual(keys(p.models[0]), keys(compiled.models[0]), "row keys");
  for (const [a, b] of [[p.owner, compiled.owner]]) for (const k of Object.keys(b)) assert.equal(typeof a[k], typeof b[k], `owner.${k} type`);
  assert.match(compiled.models[0].i, /^\$[\d.]+\/\$[\d.]+$/, "the compiler's price text format");
  assert.match(p.models[0].i, /^\$[\d.]+\/\$[\d.]+$/, "the synthetic row uses the same price text format");
  assert.deepEqual(compiled.lists.byProvider, {}, "all-providers compiles an empty byProvider");
  assert.deepEqual(p.lists.byProvider, {});
  assert.ok(fs.readdirSync(dir).length > 0 && !fs.existsSync(path.join(REPO_ROOT, "state", "_not-given")), "the fixture tree is the temp one");
});

test("requests: the four shapes carry exactly the signals the router classes on; findProfileKey matches by profile id and reports field names only on a miss", () => {
  const key = fake("key");
  const main = buildRequest("main", { key, model: "m" }), sub = buildRequest("sub", { key, model: "m", tag: TAG_MODEL }), aux = buildRequest("aux", { key, model: "m" }), bg = buildRequest("bg", { key, model: "m" });
  assert.equal(main.headers["x-claude-code-agent-id"], undefined); assert.equal(main.body.tools.length, 2);
  assert.ok(sub.headers["x-claude-code-agent-id"]); assert.match(JSON.stringify(sub.body.system), /cc_is_subagent=true/); assert.match(sub.body.messages[0].content[0].text, /^<CCR-SUBAGENT-MODEL>uwstub\/m-free</);
  assert.ok(aux.headers["x-claude-code-agent-id"]); assert.equal(aux.body.tools, undefined);
  assert.equal(bg.headers["x-claude-code-agent-id"], undefined); assert.equal(bg.body.tools, undefined);
  for (const r of [main, sub, aux, bg]) { assert.match(r.headers["user-agent"], /claude/i); assert.equal(r.headers["x-api-key"], key); }
  assert.throws(() => buildRequest("nope", { key }));
  const cfg = { profile: { profiles: [{ id: "default-claude-code", agent: "claude-code", enabled: true }] }, APIKEYS: [{ id: "default", key: fake("a") }, { id: "profile:default-claude-code", key, name: "Profile: Default Claude Code" }] };
  assert.equal(findProfileKey(cfg).key, key); assert.equal(findProfileKey(cfg).keyId, "profile:default-claude-code");
  const miss = findProfileKey({ ...cfg, APIKEYS: [{ id: "other", key: fake("b"), secretField: 1 }] });
  assert.match(miss.error, /no API key whose id is "profile:default-claude-code" \(the id CCR derives for profile "default-claude-code"; 1 key entries, fields: id,key,secretField\)/);
  assert.ok(!miss.error.includes("test-"), "no key value in the message");
  assert.match(findProfileKey({ profile: { profiles: [] } }).error, /no enabled claude-code profile/);
});

test("profile key (CCR 3.0.22 os()/mLe()): the entry id is exactly profile:<id with runs outside [a-zA-Z0-9_.-] as '-', ends trimmed, case kept>; every other spelling MUST miss, the legacy single APIKEY does not count", () => {
  const key = fake("k");
  const withId = (id) => ({ profile: { profiles: [{ id: "default-claude-code", agent: "claude-code", enabled: true }] }, APIKEYS: [{ id, key }] });
  for (const wrong of ["profile-default-claude-code", "default-claude-code", "Default Claude Code", "Profile:default-claude-code", "PROFILE:default-claude-code", "profile:Default-Claude-Code", "default"]) {
    const r = findProfileKey(withId(wrong));
    assert.ok(r.error && !r.key, `"${wrong}" must not match`);
  }
  assert.equal(findProfileKey(withId("profile:default-claude-code")).key, key);
  assert.ok(findProfileKey({ ...withId("x"), APIKEY: key }).error, "the legacy single APIKEY is not a profile key");
  assert.ok(findProfileKey({ ...withId("profile:default-claude-code"), APIKEYS: [{ id: "profile:default-claude-code", key: "  " }] }).error, "a blank key does not count");
  const idOf = (p) => findProfileKey({ profile: { profiles: [{ agent: "claude-code", enabled: true, ...p }] }, APIKEYS: [] }).error.match(/id is "([^"]*)"/)[1];
  assert.equal(idOf({ id: "My Profile.1" }), "profile:My-Profile.1");
  assert.equal(idOf({ id: "", name: "X Y" }), "profile:X-Y");
  assert.equal(idOf({ id: "  --a  b__c!!  " }), "profile:a-b__c");
  assert.equal(idOf({ id: "", name: "" }), "profile:claude-code", "agent is the last fallback");
  assert.equal(idOf({ id: "!!!", name: "" }), "profile:profile", "an id with no usable character becomes 'profile'");
  assert.equal(profileKeyId({ id: "My Profile.1" }), "profile:My-Profile.1");
});

test("ensureProfileKey: adds ONE entry {createdAt, id, key, name} for the enabled claude-code profile when missing, with a runtime-generated key; idempotent; a blank key is filled; nothing without such a profile; never touches other entries", () => {
  const mkCfg = (apikeys) => ({ profile: { profiles: [{ id: "My Profile.1", agent: "claude-code", enabled: true }, { id: "other", agent: "claude-code", enabled: false }] }, APIKEYS: apikeys });
  const c = mkCfg([{ id: "default", key: fake("d") }]);
  const r = ensureProfileKey(c);
  assert.deepEqual(r, { id: "profile:My-Profile.1", added: true });
  assert.equal(c.APIKEYS.length, 2); assert.equal(c.APIKEYS[0].id, "default");
  const e = c.APIKEYS[1];
  assert.deepEqual(Object.keys(e).sort(), ["createdAt", "id", "key", "name"]);
  assert.equal(e.id, "profile:My-Profile.1"); assert.equal(e.name, "Profile: My Profile.1"); assert.match(e.key, /^ccr-profile-[A-Za-z0-9_-]{24}$/); assert.ok(Number.isFinite(Date.parse(e.createdAt)));
  const again = ensureProfileKey(c);
  assert.deepEqual(again, { id: "profile:My-Profile.1", added: false }); assert.equal(c.APIKEYS.length, 2, "no duplicate on a second call"); assert.equal(c.APIKEYS[1].key, e.key, "the key is kept");
  const k1 = mkCfg([]), k2 = mkCfg([]); ensureProfileKey(k1); ensureProfileKey(k2); assert.notEqual(k1.APIKEYS[0].key, k2.APIKEYS[0].key, "generated at run time, not a constant");
  const blank = mkCfg([{ createdAt: "t", id: "profile:My-Profile.1", key: "", name: "Profile: x" }]);
  assert.deepEqual(ensureProfileKey(blank), { id: "profile:My-Profile.1", added: true }); assert.equal(blank.APIKEYS.length, 1); assert.match(blank.APIKEYS[0].key, /^ccr-profile-/); assert.equal(blank.APIKEYS[0].name, "Profile: x");
  const noKeys = { profile: { profiles: [{ id: "p", agent: "claude-code", enabled: true, name: "  Shown  " }] } };
  assert.equal(ensureProfileKey(noKeys).added, true); assert.equal(noKeys.APIKEYS[0].name, "Profile: Shown", "the name is trimmed, as CCR's hLe does");
  assert.equal(ensureProfileKey({ profile: { profiles: [{ id: "p", agent: "claude-code", enabled: false }] } }), null);
  assert.equal(ensureProfileKey({}), null);
});

test("arguments: usage, value flag validation, unknown flags, the approval flags, mode exclusivity", () => {
  assert.deepEqual(parseArgs([]).opts, { plan: false, experimentsOnly: false, g1: false, preloadGuard: true, teardown: false, approvePlan: false, help: false, router: "both", noGuardToken: null });
  const a = parseArgs(["--experiments-only", "--g1-approved", "--router", "next", "--no-preload-guard", "--i-understand-no-guard", "0123456789ab"]);
  assert.ok(a.ok); assert.equal(a.opts.router, "next"); assert.equal(a.opts.preloadGuard, false); assert.equal(a.opts.experimentsOnly, true); assert.equal(a.opts.noGuardToken, "0123456789ab");
  assert.equal(parseArgs(["--router", "live"]).ok, false);
  assert.equal(parseArgs(["--router"]).ok, false);
  assert.equal(parseArgs(["--bogus"]).ok, false);
  assert.equal(parseArgs(["--plan", "extra"]).ok, false);
  assert.equal(parseArgs(["--g1-approved", "yes"]).ok, false, "boolean flags take no value (a stray token is an error, not swallowed)");
  for (const bad of [["--i-understand-no-guard"], ["--i-understand-no-guard", "short"], ["--i-understand-no-guard", "0123456789AB"], ["--i-understand-no-guard", "0123456789abc"]]) assert.equal(parseArgs(bad).ok, false, bad.join(" "));
  assert.equal(parseArgs(["--approve-plan"]).opts.approvePlan, true);
  for (const bad of [["--plan", "--teardown"], ["--approve-plan", "--plan"], ["--approve-plan", "--teardown"]]) assert.equal(parseArgs(bad).ok, false, bad.join(" "));
  const help = USAGE.join("\n");
  for (const need of ["--approve-plan", "--i-understand-no-guard", "g1-approval.json", "NOT sufficient", "24 h", "--plan"]) assert.ok(help.includes(need), `--help lacks ${need}`);
});

// ---------------------------------------------------------------- the orchestrator flow, driven by a fake world (no daemon, no network, no real fs writes)
const norm = (p) => path.resolve(p).toLowerCase();
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [norm(k), v]));
  const dirs = new Set();
  const log = [], reads = [];
  const e = (c) => Object.assign(new Error(c), { code: c });
  return {
    files, dirs, log, reads,
    existsSync: (p) => files.has(norm(p)) || dirs.has(norm(p)) || [...files.keys(), ...dirs].some((k) => k.startsWith(norm(p) + path.sep)),
    readFileSync: (p, enc) => { reads.push(norm(p)); const v = files.get(norm(p)); if (v === undefined) throw e("ENOENT"); return enc ? String(v) : Buffer.from(v); },
    writeFileSync: (p, data) => { log.push(["write", p]); files.set(norm(p), Buffer.isBuffer(data) ? data : String(data)); },
    renameSync: (a, b) => { log.push(["rename", a, b]); if (!files.has(norm(a))) throw e("ENOENT"); files.set(norm(b), files.get(norm(a))); files.delete(norm(a)); },
    mkdirSync: (p) => { log.push(["mkdir", p]); dirs.add(norm(p)); },
    rmSync: (p) => { log.push(["rm", p]); for (const k of [...files.keys(), ...dirs]) if (k === norm(p) || k.startsWith(norm(p) + path.sep)) { files.delete(k); dirs.delete(k); } },
    readdirSync: (dir) => { const d = norm(dir) + path.sep, seen = new Map(); for (const k of [...files.keys(), ...dirs]) if (k.startsWith(d)) { const rest = k.slice(d.length).split(path.sep)[0]; seen.set(rest, k.slice(d.length).includes(path.sep) || dirs.has(k)); } return [...seen].map(([name, isDir]) => ({ name, isDirectory: () => isDir })); },
  };
}

const PROBE_BYTES = fs.readFileSync(PROBE_ROUTER_SRC), NEXT_BYTES = fs.readFileSync(NEXT_ROUTER_SRC);
const CCR_FAKE = { found: true, cmd: "C:\fake\ccr.cmd", cmdSha: "c".repeat(64), cli: "C:\fake\cli.js", cliSha: "d".repeat(64), name: "@fake/claude-code-router", version: "3.0.22" };
const DAEMON_ROW = { pid: 5000, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js serve --daemon-child --no-gateway" };
const CHILD_ROW = { pid: 5001, ppid: 5000, name: "node.exe", cmd: "node claude-code-router/dist/gateway-bootstrap.js" };
/**
 * The fake world. LIVE-SHAPED topology by default (observed 2026-10-03): daemon 5000 holds the web and gateway ports, its child 5001 holds the core port.
 * opt: daemonHoldsAll (old single-process topology), childListen [{addr,port}], childNoGuard, bare (the stub sees BARE model names), plus the per-test switches used below.
 */
function world(opt = {}) {
  const live = { settings: JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" }, apiKeyHelper: "x" }), service: JSON.stringify({ pid: 100, url: "http://127.0.0.1:3458/?ccr_web_token=zzz" }) };
  const w = { started: false, gatewayUp: false, childAlive: false, stubUp: false, ranProbe: false, tornDown: false, calls: { runStep: 0, fetch: 0, createStub: 0, stopProcess: [], rpc: [], assertRouterClean: 0, hashFiles: 0, ccrInstall: 0 }, probeN: 0, tripStages: [], stepEnvs: [],
    fetchInits: [], startDirs: [], live, signalHandler: null, unhooked: false, destroyed: [] };
  const mem = memFs({ [PROBE_ROUTER_SRC]: PROBE_BYTES, [NEXT_ROUTER_SRC]: NEXT_BYTES });   // the REAL router bytes: the run compares them with the hashes the approved plan names
  const stubRecs = [];
  const spell = (m) => (opt.bare ? bareOf(m) : m);
  const stubObj = { records: stubRecs, start: async () => { w.stubUp = true; return 39459; }, stop: async () => { w.stubUp = false; }, clear: () => { stubRecs.length = 0; },
    setScript: (sc) => { w.script = sc ?? {}; w.pending = (w.script.sequence ?? []).map((x) => (typeof x === "number" ? { status: x } : { status: 200, ...x })); }, pending: () => w.pending.length };
  w.script = {}; w.pending = [];
  const cfg = { profile: { enabled: true, profiles: [{ id: "default-claude-code", agent: "claude-code", enabled: true }] }, APIKEYS: opt.profileKey ? [{ createdAt: "2026-10-04T00:00:00.000Z", id: "profile:default-claude-code", key: opt.profileKey, name: "Profile: default-claude-code" }] : [], Providers: [], ...(opt.startFallback ? { Router: { fallback: opt.startFallback } } : {}) };
  const sandboxRows = () => (w.started ? [DAEMON_ROW, ...(w.childAlive ? [CHILD_ROW] : []), ...(opt.strayCcr ? [{ pid: 6000, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js" }] : [])] : []);
  const guardPids = () => (opt.noGuard ? [] : [5000, ...(opt.childNoGuard || !w.childAlive ? [] : [5001])]);
  const sys = {
    selfPid: 4000,
    readText: (p) => {
      if (norm(p) === norm(LIVE_SETTINGS)) return w.started && opt.settingsChange ? live.settings + " " : live.settings;
      if (norm(p) === norm(LIVE_SERVICE_JSON)) return opt.noLive ? null : live.service;
      if (norm(p) === norm(GUARD_LOADED_LOG)) return w.started && guardPids().length ? guardPids().map((pid) => JSON.stringify({ pid, kind: "loaded" })).join("\n") + "\n" : mem.files.get(norm(p)) ?? null;
      if (norm(p) === norm(TAKEOVER_FILE)) return w.started && opt.takeover ? JSON.stringify({ profiles: [{ settingsFile: opt.takeover }] }) : null;
      return mem.files.has(norm(p)) ? String(mem.files.get(norm(p))) : null;
    },
    sha256File: (p) => (norm(p) === norm(LIVE_SETTINGS) ? ((w.started && opt.settingsChange) || (w.tornDown && opt.driftAtEnd) ? "b".repeat(64) : "a".repeat(64)) : "(absent)"),
    listDir: (p) => (/\.claude$/i.test(p) ? ["settings.json:77", "history.jsonl:12345"] : null),
    listenerPid: (port) => {
      if (port === 3456) return (w.started && opt.liveOwnerChange) || (opt.liveOwnerAfter === "provider" && w.gatewayUp) || (opt.liveOwnerAfter === "run" && w.ranProbe) ? 999 : opt.noLive ? undefined : 100;
      if (port === 3457) return opt.childOwnsLive && w.childAlive ? 5001 : 100;
      if (port === 3458) return 100;
      if (port === 4517) return 200;
      if (port === 39458) return opt.heldAfterStop === 39458 && w.tornDown ? 5000 : w.started ? (opt.webHolder ?? 5000) : opt.preHeld === 39458 ? 777 : undefined;
      if (port === 39456) return opt.heldAfterStop === 39456 && w.tornDown ? 5000 : opt.preHeld === 39456 && !w.started ? 777 : w.started && w.gatewayUp ? (opt.gatewayPidFlip && w.swapped ? 5001 : 5000) : undefined;
      if (port === 39457) {
        if (opt.heldAfterStop === 39457 && w.tornDown) return 5001;
        if (opt.preHeld === 39457 && !w.started) return 777;
        if (!(w.started && w.gatewayUp)) return undefined;
        return opt.strangerCore ? 777 : opt.daemonHoldsAll ? 5000 : w.childAlive ? 5001 : undefined;
      }
      if (port === 39459) return w.stubUp ? 4000 : undefined;
      return undefined;
    },
    listenPortsOf: (pid) => {
      if (pid === 5000) return [{ addr: "127.0.0.1", port: 39458 }, ...(w.gatewayUp ? [{ addr: "127.0.0.1", port: 39456 }, ...(opt.daemonHoldsAll ? [{ addr: "127.0.0.1", port: 39457 }] : []), { addr: "127.0.0.1", port: 51234 }] : []), ...(opt.badListen ? [{ addr: "0.0.0.0", port: 39458 }] : [])];
      if (pid === 5001) return [...(w.gatewayUp && !opt.daemonHoldsAll ? [{ addr: "127.0.0.1", port: 39457 }] : []), ...(opt.childListen ?? [])];
      return [];
    },
    processes: () => [{ pid: 100, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js serve" }, ...(opt.baselineHas5000 && !w.started ? [DAEMON_ROW] : []), ...sandboxRows()],
    credSha: () => (w.started && opt.credChange ? "c2" : "c1"), proxySha: () => (w.started && opt.proxyChange ? "p2" : "p1"), supervisorState: () => "Disabled",
    stopProcess: (pid) => {
      w.calls.stopProcess.push(pid);
      if (pid === 5001) w.childAlive = false;
      if (pid === 5000) { w.started = false; w.gatewayUp = false; w.childAlive = false; w.tornDown = true; }
    },
  };
  const probeRouterActive = () => { const v = mem.files.get(norm(SCRATCH_ROUTER)); return v !== undefined && Buffer.from(v).equals(PROBE_BYTES); };
  const probePath = path.join(SCRATCH_STATE_DIR, "probe.jsonl");
  const append = (f, o) => mem.files.set(norm(f), (mem.files.get(norm(f)) ?? "") + JSON.stringify(o) + "\n");
  const controlObj = () => { try { return JSON.parse(String(mem.files.get(norm(path.join(SCRATCH_STATE_DIR, "probe-control.json"))))) || {}; } catch { return {}; } };
  const control = () => controlObj().mode || "mutate";
  let reqCount = 0, clock = 1.7e12;                             // a fake clock: sleep advances it, so a wait that never succeeds ends at once
  w.nowMs = () => clock;
  const d = {
    fs: mem, sys, env: { PATH: "C:\\x", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\fake", TEMP: "C:\\Temp", ANTHROPIC_API_KEY: ASCII_KEY, NO_PROXY: "proxy.invalid", CLAUDE_CONFIG_DIR: "C:\\real\\claude" },
    out: (s) => w.out.push(s), err: (s) => w.err.push(s),
    sleep: async (ms) => { clock += ms; }, now: () => clock,
    resolveWebPort: () => { if (!w.started) throw new Error("no service.json"); return { port: 39458, pid: 5000 }; },
    runStep: async (step, env) => {
      w.calls.runStep++; w.stepEnvs.push({ id: step.id, env });
      if (step.id === "start") {
        w.started = true; w.childAlive = true;
        w.startDirs = ENV_DIR_VARS.map((k) => buildSpec(d.env).env[k]);
        w.existedAtStart = w.startDirs.map((p) => mem.existsSync(p));
        if (opt.violationsText) mem.files.set(norm(VIOLATIONS_LOG), opt.violationsText);
        if (opt.ccrLog) mem.files.set(norm(path.join(CCR_CONFIG_DIR, "logs", "daemon.out.log")), opt.ccrLog);
        if (opt.signalAt === "start" && w.signalHandler) await w.signalHandler("SIGINT");
      }
      if (step.id === "bootstrap") w.gatewayUp = !!opt.gatewayEarly;
      return { code: opt.stepFail === step.id ? 1 : 0, tail: opt.stepTail ?? "" };
    },
    // the executed files are hashed from the REAL working tree (read only); opt.hashFilesAt {n: read} swaps the bytes seen by the n-th call (a file that changed mid-run)
    ccrInstall: () => (opt.ccrMissing ? { found: false, reason: "no ccr launcher on PATH" } : opt.ccrAt && w.calls.ccrInstall++ >= opt.ccrAt ? { ...CCR_FAKE, cliSha: "e".repeat(64) } : CCR_FAKE),
    hashFiles: () => { const n = ++w.calls.hashFiles; return opt.hashFilesAt?.[n] ? hashExecutedFiles(opt.hashFilesAt[n]) : hashExecutedFiles(); },
    interactive: () => !opt.nonInteractive,
    ask: async (q) => { w.asked = q; return opt.typed !== undefined ? opt.typed : /(([0-9a-f]{12}))/.exec(q)[1]; },
    makeTripwire: () => ({ assert: (stage) => { w.tripStages.push(stage); (w.tripTorn ??= {})[stage] = w.tornDown; if (opt.tripwireAt === stage || (w.started && opt.tripwire)) throw new Error(`ISOLATION VIOLATION: ${stage}`); } }),
    onSignal: (fn) => { w.signalHandler = fn; return () => { w.signalHandler = null; w.unhooked = true; }; },
    guard: {
      assertIsolatedInstance: async () => { if (opt.notIsolated) throw new Error("ISOLATION VIOLATION: daemon paths"); },
      assertIsolatedConfig: async (c) => { if (opt.postSaveIsoFail && c) throw new Error("ISOLATION VIOLATION: persisted config"); },
      assertPayloadIsolated: () => { if (opt.payloadBad) throw new Error("ISOLATION VIOLATION: payload"); },
      assertRouterClean: () => { w.calls.assertRouterClean++; if (opt.routerDirty === w.calls.assertRouterClean) throw new Error("ISOLATION VIOLATION: router rules"); },
      assertDesktopSyncLandedInScratch: () => { if (opt.desktopSyncMissing) throw new Error("ISOLATION VIOLATION: desktop sync"); },
      assertGatewayBound: () => { if (opt.gatewayNotBound) throw new Error("ISOLATION VIOLATION: gateway not bound"); return 5000; },
    },
    rpc: async (method, args) => {
      w.calls.rpc.push(method);
      if (method === "getConfig") { const c = structuredClone(cfg); if (opt.noProfile) delete c.profile; if (opt.enhancedRouteFalse) c.routing = { enhancedRoute: false }; if (opt.profileRouteFalse) c.profile.profiles[0].routing = { enhancedRoute: false }; if (opt.rulesEnabled && w.gatewayUp) c.Router = { ...c.Router, rules: [{ id: "r1", enabled: true }] }; if (opt.editedRouterPath && w.gatewayUp) c.CUSTOM_ROUTER_PATH = opt.editedRouterPath; return c; }
      if (method === "saveConfig") { (w.fbSeen ??= []).push(args[0].Router?.fallback?.mode ?? null); if (opt.rejectSwap && args[0].Router?.fallback?.mode === opt.rejectSwap) throw new Error("saveConfig failed: boom"); if (opt.rebindAfterEdit && args[0].Providers?.[0]?.models?.length === 4) w.down = opt.rebindAfterEdit; if (opt.failRestore && w.everSwapped && args[0].Router?.fallback?.mode === "off") throw new Error("saveConfig failed: boom"); Object.assign(cfg, structuredClone(args[0])); if (w.swapped) w.everSwapped = true; w.swapped = !!args[0].Router?.fallback?.mode && args[0].Router.fallback.mode !== "off"; if (args[0].Providers?.length) { w.gatewayUp = true; w.calls.providerSaves = (w.calls.providerSaves ?? 0) + 1; } const out = structuredClone(cfg); if (opt.restoreDoesNotPersist && w.everSwapped && args[0].Router?.fallback?.mode === "off") cfg.Router = { ...cfg.Router, fallback: { mode: "model-chain", models: ["uwstub/m-free"], retryCount: 1 } }; if (opt.routerPathRewrite) out.CUSTOM_ROUTER_PATH = opt.routerPathRewrite; return out; }
      throw new Error(`unexpected rpc ${method}`);
    },
    createStub: () => { w.calls.createStub++; return stubObj; },
    fetch: async (url, init) => {
      w.calls.fetch++; w.fetchInits.push(init);
      assert.match(url, /^http:\/\/127\.0\.0\.1:39456\/v1\/messages$/, "every synthetic request goes to the sandbox gateway only");
      if (w.down > 0) { w.down--; w.failedFetches = (w.failedFetches ?? 0) + 1; throw new TypeError("fetch failed"); }
      const body = JSON.parse(init.body), orig = JSON.parse(init.body), h = init.headers;
      const text = JSON.stringify(body.messages);
      // CCR's enricher (V6/Oy) runs only when the key the request carries is the entry whose id is exactly profile:<mLe of the profile id> (G1 attempt 2 failed on this)
      const keyOk = !!opt.skipKeyCheck || (cfg.APIKEYS ?? []).some((k) => k.id === "profile:default-claude-code" && typeof k.key === "string" && k.key !== "" && k.key === h["x-api-key"]);
      const tag = keyOk ? /<CCR-SUBAGENT-MODEL>([^<]+)</.exec(text)?.[1] ?? null : null;
      const sub = keyOk && h["x-claude-code-agent-id"] !== undefined && /cc_is_subagent=true/.test(JSON.stringify(body.system));
      if (!opt.noBillingStrip && Array.isArray(body.system) && String(body.system[0]?.text ?? "").startsWith("x-anthropic-billing-header:")) { body.system.shift(); if (!body.system.length) delete body.system; }
      const desc0 = body.tools?.find((t) => t.name === "Agent")?.description ?? "";
      const isMain = h["x-claude-code-agent-id"] === undefined && !!body.tools?.some((t) => t.name === "Agent");
      const pid = opt.workers ? opt.workers[(w.callN = (w.callN ?? 0) + 1) % opt.workers.length] : 5000;
      let model = body.model, mutate = false;
      // what the upstream receives: the router's edits (a copy of the body the fake gateway parsed), or the original when opt.x8Dropped says an edit never reaches it
      const upstream = (m) => {
        const step = w.pending.length ? w.pending.shift() : { status: 200 };
        const ub = opt.x8Dropped ? orig : body, sys = ub.system;
        const rec = { model: spell(m), bodyBytes: init.body.length,
          headers: { ...(mutate && !opt.dropE5 ? { "x-uw-subpolicy": "probe" } : {}), ...(h["x-stainless-retry-count"] !== undefined ? { "x-stainless-retry-count": h["x-stainless-retry-count"] } : {}), ...(h["x-claude-code-agent-id"] !== undefined && !opt.noAgentIdUp ? { "x-claude-code-agent-id": h["x-claude-code-agent-id"] } : {}) },
          agentToolDescription: mutate && desc0 ? `${desc0}\n${E4_MARK}` : desc0 || null,
          systemShape: typeof sys === "string" ? "string" : Array.isArray(sys) ? "array" : "absent", markers: {}, sysBlocks: Array.isArray(sys) ? sys.length : null,
          sysCc: Array.isArray(sys) ? sys.flatMap((b, i) => (b && b.cache_control !== undefined && !opt.ccDropped ? [i] : [])) : [], messagesLen: ub.messages.length,
          messagesSha256: sha(JSON.stringify(opt.x8TouchMessages ? [...ub.messages, {}] : ub.messages ?? null)), toolsSha256: sha(JSON.stringify(ub.tools ?? null)),
          sent: { status: step.status, retryAfter: step.retryAfter ?? null, cut: step.cut ?? null } };
        for (const mk of w.script.markers ?? []) rec.markers[mk] = (sys === undefined ? "" : JSON.stringify(sys)).includes(mk);
        stubRecs.push(rec);
        return step;
      };
      if (probeRouterActive()) {
        reqCount++; w.ranProbe = true;
        w.probeN = opt.noPersist ? 1 : w.probeN + 1;
        const mode = control(), ctl = controlObj();
        mutate = mode === "mutate" && !opt.dropE4;
        const shape = (v) => (typeof v !== "string" ? null : { len: v.length, at: v.includes("@"), ok: /^[A-Za-z0-9_@.:-]{1,128}$/.test(v), form: v.replace(/[A-Za-z]+/g, "a").replace(/[0-9]+/g, "9").slice(0, 40) });
        const fp = sha(JSON.stringify((cfg.Providers ?? []).map((p) => [p.name, p.enabled, p.models]))).slice(0, 12), first = w.cfgPrev === undefined;
        const aidHdr = opt.agentIdMangled ? String(h["x-claude-code-agent-id"] ?? "").split("@")[0] || undefined : h["x-claude-code-agent-id"];
        const line = { t: new Date(clock).toISOString(), n: w.probeN, m: opt.cacheNotDeleted ? w.probeN : 1, pid, mode, asked: body.model, bl: opt.noBl ? false : sub, tag: opt.noBl ? null : tag, tokenCount: opt.noTokenCount ? null : 42,
          contentLength: opt.noContentLength ? null : String(init.body.length), mutated: mode === "mutate" ? !!desc0 : undefined,
          cfg: { first, same: first ? null : !opt.newConfigEachRequest, provSame: first ? null : w.cfgPrev.fp === fp || !!opt.providersInPlace, provN: (cfg.Providers ?? []).length, fp },
          hdr: { aid: shape(aidHdr), par: shape(h["x-claude-code-parent-agent-id"]), sid: shape(h["x-claude-code-session-id"]), retry: opt.retryHdrStripped || h["x-stainless-retry-count"] === undefined ? null : String(h["x-stainless-retry-count"]) },
          ml: body.messages.length, lh: sha(JSON.stringify(body.messages[body.messages.length - 1])).slice(0, 12) };
        w.cfgPrev = { fp };
        if (mode === "keep-tag") model = tag && !opt.tagNotHonoured ? tag : body.model;
        else if (mode === "clear-tag") model = tag ? (opt.clearNoEffect ? tag : ANCHOR) : body.model;
        else if (mode === "timer") { line.timer = true; line.delayMs = ctl.delayMs ?? 300; w.timerOf = { n: w.probeN, pid, at: clock, delay: line.delayMs }; }
        else if (mode === "sys-string" || mode === "sys-array") {
          const want = mode === "sys-string" ? "string" : "array", have = typeof body.system === "string" ? "string" : Array.isArray(body.system) ? "array" : "absent";
          line.before = { shape: have }; line.edited = false;
          if (have === want) { if (want === "string") body.system += `\n${X8_MARK}`; else body.system.push({ type: "text", text: X8_MARK }); line.edited = true; }
        } else if (mode === "registry") line.reg = { keys: opt.registryKeys ?? 1, own: opt.registryOwn ?? true, id: "i" };
        const fireTimer = () => { if (w.timerOf && !opt.timerDies) append(probePath, { kind: "timer", of: w.timerOf.n, pid: w.timerOf.pid, t: new Date(w.timerOf.at + w.timerOf.delay).toISOString() }); w.timerOf = null; };
        if (w.timerOf && mode !== "timer") { if (opt.timerEarly) { fireTimer(); append(probePath, line); } else { append(probePath, line); fireTimer(); } } else append(probePath, line);
      } else {
        const policyText = mem.files.get(norm(path.join(SCRATCH_STATE_DIR, "policy.json")));
        if (opt.policyAbsentWrites) mem.files.set(norm(path.join(SCRATCH_STATE_DIR, "decisions.jsonl")), "x");
        if (policyText !== undefined) {
          reqCount++;
          const enforce = JSON.parse(String(policyText)).owner?.enforcement === "enforce", aid = h["x-claude-code-agent-id"];
          if (sub && !enforce) {
            append(path.join(SCRATCH_STATE_DIR, "decisions.jsonl"), { role: "sub", tag, would: tag, ret: body.model, act: "honour-tag" });
            append(path.join(SCRATCH_STATE_DIR, "classify.jsonl"), { cls: "sub", bl: 1, ag: 1 });
            if (!opt.noAgentsLog) append(path.join(SCRATCH_STATE_DIR, "agents.jsonl"), { v: 2, aid: aid.slice(0, 12), path: "shadow", act: "honour-tag", would: tag, ret: body.model });
          }
          if (sub && enforce) {                                       // a tiny stand-in for the enforcing router: keep, then hand off on a repeated length, then stay
            w.agentsState ??= new Map();
            const key = `${h["x-claude-code-session-id"]}:${aid}`, ml = body.messages.length;
            let e = w.agentsState.get(key);
            if (!e) { e = { model: body.model, ml, hops: 0 }; w.agentsState.set(key, e); append(path.join(SCRATCH_STATE_DIR, "agents.jsonl"), { v: 2, aid: aid.slice(0, 12), path: "new", act: "keep", ret: e.model }); }
            else if (e.ml === ml && !opt.noHandoff) {
              const from = e.model, to = ["uwstub/m-main", "uwstub/m-free", "uwstub/m-big"].find((x) => x !== from);
              e.model = to; e.hops += 1;
              append(path.join(SCRATCH_STATE_DIR, "agents.jsonl"), { v: 2, aid: aid.slice(0, 12), aid_full: aid, path: "handoff", act: "handoff", from, to, hop: e.hops, rsrc: "len", reason: "retry:len:1", ret: to });
              if (!opt.noticeDropped && Array.isArray(body.system)) body.system.push({ type: "text", text: `${NOTICE_MARK} Your previous model ${from} hit a limit.` });
            }
            e.ml = ml; model = e.model;
          }
          mem.files.set(norm(path.join(SCRATCH_STATE_DIR, "status.json")), JSON.stringify({ policy: { state: "ok" }, pid: 5000, since: opt.sinceResets ? `s${reqCount}` : "2026-10-03T00:00:00.000Z", counters: { req: opt.noPersist ? 1 : reqCount + 2 - (opt.reqShortBy ?? 0) } }));
          if (!opt.noWorkerFile) mem.files.set(norm(path.join(SCRATCH_STATE_DIR, "status-w1.json")), "{}");
        }
      }
      // the fake gateway: one upstream attempt, then (only when Router.fallback says so) more, with CCR's own sleeps (Retry-After clamped 1 ms..60 s, else 1 s * 2^n up to 30 s)
      const fb = opt.noFallbackSwap ? { mode: "off" } : cfg.Router?.fallback ?? { mode: "off" };
      const first = model;
      let step = upstream(first), attempts = 1, slept = 0;
      const maxExtra = isMain && opt.mainNoChain && fb.mode === "model-chain" ? 0 : fb.mode === "retry" ? (fb.retryCount ?? 1) : fb.mode === "model-chain" ? (fb.models ?? []).length : 0;
      const retryable = (s) => [408, 409, 429].includes(s) || s >= 500;
      for (let i = 0; i < maxExtra && step.status >= 400 && (fb.mode === "model-chain" || retryable(step.status)); i++) {
        const ra = step.retryAfter;
        slept += ra != null ? Math.max(1, Math.min(60000, ra * 1000)) : Math.min(30000, 1000 * 2 ** i);
        step = upstream(fb.mode === "model-chain" ? fb.models[i] : first); attempts++;
      }
      if (opt.ccrRetriesAlone && step.status >= 400 && attempts === 1) { step = upstream(first); attempts++; slept += 1000; }
      clock += slept;
      const headers = new Headers();
      if (step.status >= 400 && step.retryAfter != null && !opt.noRetryAfterForward) headers.set("retry-after", String(step.retryAfter));
      if (attempts > 1) headers.set("x-ccr-fallback-attempts", String(attempts));
      return { status: step.status, headers, text: async () => "{}" };
    },
    buildSpec: opt.spec ?? buildSpec,
  };
  w.out = []; w.err = []; w.mem = mem; w.stub = stubObj; w.env = d.env; w.cfg = cfg;
  return { w, d };
}
const planShaOf = (argv, env) => { const { opts } = parseArgs(argv); return sha(renderPlan(buildSpec(env, { preloadGuard: opts.preloadGuard }), { ...opts, ccr: CCR_FAKE }).join("\n")); };
const seedApproval = (w, argv, over = {}) => w.mem.files.set(norm(APPROVAL_FILE), over.raw ?? JSON.stringify({ schema: 1, planSha256: over.sha ?? planShaOf(argv, w.env), approvedAt: over.at ?? new Date(w.nowMs()).toISOString() }));
const go = (w, d, argv, over) => { if (!over?.none) seedApproval(w, argv, over); return runE2e(argv, d).then((code) => ({ code, w, out: w.out.join("\n"), err: w.err.join("\n") })); };
const run = (argv, opt = {}, over) => { const { w, d } = world(opt); return go(w, d, argv, over); };
const GO = ["--experiments-only", "--g1-approved"];

test("flow: --plan prints the plan and its sha256, exits 0, and performs no I/O but hashing the executed files (every other dependency throws)", async () => {
  const boom = (n) => () => { throw new Error(`--plan touched ${n}`); };
  const trap = (n) => new Proxy({}, { get: (_, k) => boom(`${n}.${String(k)}`) });
  const out = [];
  const traps = { fs: trap("fs"), sys: trap("sys"), rpc: boom("rpc"), runStep: boom("runStep"), fetch: boom("fetch"), createStub: boom("createStub"), makeTripwire: boom("makeTripwire"),
    resolveWebPort: boom("resolveWebPort"), guard: trap("guard"), onSignal: boom("onSignal"), interactive: boom("interactive"), ask: boom("ask"), out: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), env: { PATH: "C:\\x" } };
  let hashed = 0;
  traps.hashFiles = () => { hashed++; return hashExecutedFiles(); };     // the ONE read --plan makes: the sha256 of the files the run executes
  const code = await runE2e(["--plan"], traps);
  assert.equal(code, 0);
  assert.equal(hashed, 1, "--plan hashes the executed files once and reads nothing else");
  const text = out.join("\n");
  for (const need of ["39456", "39457", "39458", "39459", "CCR_WEB_PORT=39458", "gateway.port/corePort", "NEVER used: 3456, 3457, 3458, 4517", "MUST NEVER TOUCH", "CANNOT VERIFY",
    "Windows Credential Manager", "settings.json", ".llmkeys", "\\state", "\\catalog", "process-list", "credential-manager", "claude-config-dir", "logs:", "web-port", "G1", "--g1-approved",
    "start.ps1", "bootstrap-live-safe.mjs", "probe-router.cjs", "router/uw-router.next.cjs", "system-proxy", "--approve-plan", "g1-approval.json", "g1-evidence", "TEARDOWN IDENTITY", "process TREE",
    "MINIMAL environment", "must all be ABSENT", "redirect:error", "model spelling", "control"]) assert.ok(text.includes(need), `plan lacks: ${need}`);
  for (const s of SIDE_EFFECTS) assert.ok(text.includes(`${s.id}:`), `plan lacks side effect ${s.id}`);
  for (const e of EXPERIMENTS) assert.ok(text.includes(e.id), e.id);
  assert.ok(!/(sk-|ghp_|hf_|AKIA)[A-Za-z0-9]{8}/.test(text), "no secret-shaped text");
  assert.ok(!text.includes("uw-harness-local-only-token"), "the web token is masked");
  const spec = buildSpec({ PATH: "x" });
  const all = out.slice();
  assert.match(all.at(-1), /^plan sha256: [0-9a-f]{64}$/);
  const planText = all.slice(0, -2).join("\n");                       // the hashed text excludes the blank line and the hash line
  assert.equal(all.at(-1).split(": ")[1], sha(planText), "the printed hash is the sha256 of exactly the text above it");
  assert.deepEqual(renderPlan(spec, { router: "both" }).join("\n"), planText, "the plan is deterministic");
  assert.equal(planOf(spec, { router: "both" }).sha, sha(planText));
  assert.notEqual(planOf(spec, { router: "probe" }).sha, planOf(spec, { router: "both" }).sha, "the router choice is part of the approved text");
  assert.notEqual(planOf(buildSpec({ PATH: "x" }, { preloadGuard: false }), { router: "both" }).sha, planOf(spec, { router: "both" }).sha, "so is the guard choice");
  const noGuard = [];
  await runE2e(["--plan", "--no-preload-guard"], { ...traps, out: (s) => noGuard.push(s) });
  assert.match(noGuard.join("\n"), /no-guard token: --i-understand-no-guard [0-9a-f]{12}/, "the plan of the guard-off run prints its own token");
  assert.ok(!out.join("\n").includes("--i-understand-no-guard "), "a default plan has no token line");
});

test("flow: refuses without --experiments-only (exit 2) and without --g1-approved (exit 2), starting nothing", async () => {
  for (const argv of [[], ["--g1-approved"], ["--experiments-only"]]) {
    const r = await run(argv, {});
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.w.calls.runStep, 0); assert.equal(r.w.calls.fetch, 0); assert.equal(r.w.started, false);
  }
  assert.equal((await run(["--bogus"], {})).code, 2);
});

test("flow (sec#6): --g1-approved alone is NOT enough: a missing, stale, future, corrupt or wrong-hash approval refuses (exit 2) and starts nothing; the approval binds the exact plan text", async () => {
  const cases = [
    ["no approval file", { none: true }, /no approval file/],
    ["corrupt JSON", { raw: "{nope" }, /not valid JSON/],
    ["wrong shape", { raw: JSON.stringify({ planSha256: 5 }) }, /wrong shape/],
    ["25 hours old", { at: new Date(1.7e12 - 25 * 3600 * 1000).toISOString() }, /25 h old \(valid 24 h\)/],
    ["dated in the future", { at: new Date(1.7e12 + 3600 * 1000).toISOString() }, /dated in the future/],
    ["unreadable timestamp", { at: "yesterday" }, /timestamp is unreadable/],
    ["a different plan (another router choice)", { sha: planShaOf([...GO, "--router", "probe"], { PATH: "x" }) }, /DIFFERENT plan/],
    ["a hash of nothing", { sha: sha("") }, /DIFFERENT plan/],
  ];
  for (const [name, over, re] of cases) {
    const r = await run(GO, {}, over);
    assert.equal(r.code, 2, name); assert.match(r.err, /--g1-approved alone is not enough/, name); assert.match(r.err, re, name);
    assert.equal(r.w.calls.runStep, 0, name); assert.equal(r.w.calls.fetch, 0, name); assert.equal(r.w.started, false, name);
  }
  const r23 = await run(GO, {}, { at: new Date(1.7e12 - 23 * 3600 * 1000).toISOString() });
  assert.equal(r23.code, 0, `23 h old is still valid: ${r23.err}`);
});

test("flow (sec#6): --approve-plan writes harness/g1-approval.json with the plan sha256 and an ISO timestamp, starts nothing, and a following run with the same flags is approved; other flags are not", async () => {
  const { w, d } = world({});
  assert.equal(await runE2e(["--approve-plan"], d), 0);
  assert.equal(w.calls.runStep, 0); assert.equal(w.started, false);
  const doc = JSON.parse(w.mem.files.get(norm(APPROVAL_FILE)));
  assert.equal(doc.schema, 1); assert.equal(doc.planSha256, planShaOf([], d.env)); assert.equal(doc.approvedAt, new Date(w.nowMs()).toISOString());
  for (const [kind, ...p] of w.mem.log.filter((x) => x[0] === "write" || x[0] === "rename")) for (const f of p) assert.ok(norm(f).startsWith(norm(APPROVAL_FILE)), `approval wrote outside its file: ${f}`);
  const ok = await runE2e(GO, d);
  assert.equal(ok, 0, w.err.join("\n"));
  const { w: w2, d: d2 } = world({});
  w2.mem.files.set(norm(APPROVAL_FILE), JSON.stringify({ schema: 1, planSha256: planShaOf([], w2.env), approvedAt: new Date(w2.nowMs()).toISOString() }));
  assert.equal(await runE2e([...GO, "--router", "next"], d2), 2, "an approval for the default plan does not cover --router next");
  assert.equal(w2.calls.runStep, 0);
});

test("flow (sec#6): --no-preload-guard needs a SECOND explicit token (the first 12 hex of ITS plan hash) for --approve-plan and for the run; the default stays guard ON", async () => {
  const sha0 = planShaOf(["--no-preload-guard"], { PATH: "x" });
  const tok = sha0.slice(0, 12);
  for (const argv of [["--approve-plan", "--no-preload-guard"], [...GO, "--no-preload-guard"], ["--approve-plan", "--no-preload-guard", "--i-understand-no-guard", "000000000000"], [...GO, "--no-preload-guard", "--i-understand-no-guard", sha(sha0).slice(0, 12)]]) {
    const { w, d } = world({});
    seedApproval(w, ["--no-preload-guard"], { sha: sha0 });
    const code = await runE2e(argv, d);
    assert.equal(code, 2, argv.join(" "));
    assert.match(w.err.join("\n"), /second explicit token/); assert.equal(w.calls.runStep, 0);
    assert.equal(w.mem.files.has(norm(APPROVAL_FILE)), true, "the pre-seeded approval was not replaced");
  }
  const a = world({});
  assert.equal(await runE2e(["--approve-plan", "--no-preload-guard", "--i-understand-no-guard", tok], a.d), 0);
  assert.equal(JSON.parse(a.w.mem.files.get(norm(APPROVAL_FILE))).preloadGuard, false);
  const r = await run([...GO, "--no-preload-guard", "--i-understand-no-guard", tok], { noGuard: true }, { sha: sha0 });
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(r.w.stepEnvs[0].env.NODE_OPTIONS, undefined, "no preload guard in the daemon env when it was dropped on purpose");
  const dflt = await run(GO, {});
  assert.equal(dflt.w.stepEnvs[0].env.NODE_OPTIONS, PRELOAD_ARG, "the default run carries the guard");
});

test("flow: preflight refusals happen before anything is started (sandbox port held, missing router source, stale guard log, a live sandbox daemon)", async () => {
  const r1 = await run(GO, { preHeld: 39458 });
  assert.equal(r1.code, 1); assert.match(r1.err, /sandbox port 39458 \(web\) is already held by pid 777/); assert.equal(r1.w.calls.runStep, 0);
  const a = world({});
  a.w.mem.files.delete(norm(NEXT_ROUTER_SRC)); seedApproval(a.w, GO);
  assert.equal(await runE2e(GO, a.d), 1); assert.match(a.w.err.join("\n"), /the router under test is missing/); assert.equal(a.w.calls.runStep, 0);
  const b = world({}); b.w.mem.files.set(norm(VIOLATIONS_LOG), "x\n"); seedApproval(b.w, GO);
  assert.equal(await runE2e(GO, b.d), 1); assert.match(b.w.err.join("\n"), /stale guard logs/); assert.equal(b.w.calls.runStep, 0);
  const c = world({});                                           // a sandbox daemon is alive although no leftover directory exists: only the daemon check can see it
  c.d.resolveWebPort = () => ({ port: 39458, pid: 5000 }); c.d.sys.processes = () => [{ pid: 100, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js serve" }, DAEMON_ROW]; seedApproval(c.w, GO);
  assert.equal(await runE2e(GO, c.d), 1); assert.match(c.w.err.join("\n"), /a sandbox daemon \(pid 5000\) is already running: run --teardown first/); assert.equal(c.w.calls.runStep, 0);
});

test("flow (sec#3): a leftover scratch tree (appdata, localappdata, claude-config, daemon-env.json, claude-settings.json) REFUSES the run before anything starts; config.sqlite is never read", async () => {
  assert.deepEqual(MUST_BE_ABSENT.map((p) => path.basename(p)).sort(), ["appdata", "claude-config", "claude-settings.json", "daemon-env.json", "localappdata"]);
  for (const leftover of MUST_BE_ABSENT) {
    const { w, d } = world({});
    if (/\.json$/.test(leftover)) w.mem.files.set(norm(leftover), "{}"); else w.mem.dirs.add(norm(leftover));
    w.mem.files.set(norm(path.join(CCR_CONFIG_DIR, "config.sqlite")), "SQLITE-SECRET-BYTES");
    const r = await go(w, d, GO);
    assert.equal(r.code, 1, leftover); assert.match(r.err, /not fresh/); assert.match(r.err, new RegExp(path.basename(leftover).replace(/\./g, "\\.")));
    assert.match(r.err, /node harness\/subagent-e2e\.mjs --teardown/);
    assert.ok(!r.err.includes("SQLITE-SECRET") && !r.out.includes("SQLITE-SECRET"));
    assert.equal(w.calls.runStep, 0); assert.equal(w.started, false); assert.equal(w.calls.fetch, 0);
    assert.deepEqual(w.mem.reads.filter((p) => p.startsWith(norm(path.join(SCRATCH_ROOT, "appdata")))), [], "nothing under appdata was read");
  }
});

test("flow (sec#7): every directory the sandbox environment points at exists before step 0 (pre-created by the preflight) or is one start.ps1 / CCR create themselves", async () => {
  const r = await run(GO, {});
  assert.equal(r.code, 0, r.err + r.out);
  const spec = buildSpec({ PATH: "x" });
  assert.deepEqual(r.w.startDirs, ENV_DIR_VARS.map((k) => spec.env[k]));
  r.w.startDirs.forEach((p, i) => {
    const pre = PRECREATE_DIRS.some((x) => norm(x) === norm(p)), byStart = START_CREATES.some((x) => norm(x) === norm(p));
    assert.ok(pre !== byStart, `${p} is in exactly one list`);
    if (pre) assert.equal(r.w.existedAtStart[i], true, `${p} was not created before step 0`); else assert.equal(r.w.existedAtStart[i], false, `${p} is created by the start step, so it must not exist beforehand`);
  });
  for (const t of ["home", "tmp"]) assert.ok(r.w.startDirs.some((p) => norm(p) === norm(path.join(SCRATCH_ROOT, t))), `${t} is among the env directories`);
  for (const [op, p] of r.w.mem.log.filter((x) => x[0] === "mkdir")) assert.ok(norm(p).startsWith(norm(SCRATCH_ROOT) + path.sep), `mkdir outside scratch: ${p}`);
});

test("flow: ALL GREEN world (live-shaped tree): probe then next run, every required line present, exit 0, before and after blocks printed, teardown stops only the verified daemon tree, bootstrap gets a minimal env", async () => {
  const r = await run(GO, {});
  assert.equal(r.code, 0, r.err + r.out);
  const parsed = r.out.split("\n").map(parseLine).filter(Boolean);
  for (const id of REQUIRED.probe.present) assert.ok(parsed.some((p) => p.router === "probe" && p.id === id), `probe ${id}`);
  for (const id of REQUIRED.next.pass) assert.equal(parsed.find((p) => p.router === "next" && p.id === id)?.kind, "PASS", `next ${id}`);
  assert.equal(parsed.filter((p) => p.kind === "FAIL").length, 0);
  assert.equal(parsed.find((p) => p.id === "E13")?.kind, "PASS", "E13 passes with its control arm");
  assert.match(r.out, /BEFORE live: settings sha256 aaaaaaaaaaaa \(ANTHROPIC_BASE_URL http:\/\/127\.0\.0\.1:3456, 2 markers\); service\.json pid 100; listener pids 3456=100 3457=100 3458=100 4517=200/);
  assert.match(r.out, /AFTER {2}live: settings sha256 aaaaaaaaaaaa .*service\.json pid 100; listener pids 3456=100 /);
  assert.match(r.out, /live state identical before and after/);
  assert.match(r.out, /GREEN {1,2}1 live listeners/);
  assert.match(r.out, /sandbox tree listens on 5000:39458\+39456\+51234\(ephemeral\) 5001:39457/, "the proof names what each tree member holds");
  assert.ok(!/RED /.test(r.out));
  assert.deepEqual(r.w.calls.stopProcess, [5001, 5000], "the sandbox daemon tree, child first, never the live pid 100");
  assert.equal(r.w.calls.runStep, 2);
  assert.equal(r.w.stubUp, false);
  assert.match(r.out, /probe router installed \(sha256 [0-9a-f]{64}; LF-normalised [0-9a-f]{64}\)/);
  assert.match(r.out, /router under test installed: exact bytes of router\/uw-router\.next\.cjs \(sha256 [0-9a-f]{64}/);
  const rmPaths = r.w.mem.log.filter((x) => x[0] === "rm").map((x) => x[1]);
  const ren = r.w.mem.log.find((x) => x[0] === "rename");
  assert.equal(norm(ren[1]), norm(APPROVAL_FILE), "the first rename consumes the approval file (one-use, atomic)");
  assert.match(path.basename(ren[2]), /^g1-approval\.used-\d+-\d+$/, "to a unique used name");
  assert.equal(norm(rmPaths[0]), norm(ren[2]), "the first removal is the consumed (renamed) approval file");
  for (const p of rmPaths.slice(1)) { assert.ok(norm(p).startsWith(norm(SCRATCH_ROOT) + path.sep), p); }
  const writes = r.w.mem.log.filter((x) => (x[0] === "write" || x[0] === "rename") && !(x[0] === "rename" && norm(x[1]) === norm(APPROVAL_FILE))).flatMap((x) => x.slice(1));
  for (const p of writes) assert.ok(norm(p).startsWith(norm(SCRATCH_ROOT) + path.sep), `write outside scratch: ${p}`);
  assert.equal(String(r.w.mem.files.get(norm(path.join(SCRATCH_ROOT, "spike", "slot.json"))) ?? ""), "", "teardown removed the whole spike dir (slot.json is gone)");
  assert.ok(r.w.fetchInits.length >= 10 && r.w.fetchInits.every((i) => i.redirect === "error"), "every sandbox fetch uses redirect:error (sec#12)");
  // sec#13: the bootstrap step gets a MINIMAL env, not process.env; the start step gets the forced sandbox env
  const boot = r.w.stepEnvs.find((s) => s.id === "bootstrap").env, startEnv = r.w.stepEnvs.find((s) => s.id === "start").env;
  assert.deepEqual(Object.keys(boot).sort(), [...MINIMAL_ENV_KEYS].sort());
  for (const leak of [ASCII_KEY, "proxy.invalid", "C:\\real\\claude"]) assert.ok(!JSON.stringify(boot).includes(leak), `bootstrap env leaks ${leak}`);
  assert.ok(!JSON.stringify(startEnv).includes(ASCII_KEY) && startEnv.CCR_WEB_PORT === "39458");
  assert.deepEqual(minimalEnv({ PATH: "p", ANTHROPIC_API_KEY: "k", TEMP: "t" }), { PATH: "p", TEMP: "t" });
  // sec#4 and the tripwire call sites, in order
  const order = ["e2e:start", "e2e:after-start", "after-bootstrap", "e2e:after-configure", "after-provider-save"].map((s) => r.w.tripStages.indexOf(s));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `tripwire stages out of order: ${r.w.tripStages.join(",")}`);
  assert.equal(r.w.tripStages.indexOf("e2e:after-start"), r.w.tripStages.indexOf("e2e:start") + 1, "the first thing after step 0 is the tripwire");
});

test("flow: the OLD single-process topology (daemon holds all three ports) is GREEN as well, and the process tree is still verified", async () => {
  const r = await run(GO, { daemonHoldsAll: true });
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /sandbox tree listens on 5000:39458\+39456\+39457\+51234\(ephemeral\) 5001:-/);
});

test("flow: --router probe and --router next each run only their own experiments", async () => {
  const p = await run([...GO, "--router", "probe"], {});
  assert.equal(p.code, 0); assert.ok(!/\[next\]/.test(p.out)); assert.match(p.out, /PASS \[probe\] A11/);
  const n = await run([...GO, "--router", "next"], {});
  assert.equal(n.code, 0, n.err + n.out); assert.ok(!/\[probe\]/.test(n.out)); assert.match(n.out, /PASS \[next\] A8/);
});

test("flow (sec#1 HIGH): a live-shaped tree where the CHILD holds the core port is GREEN at the pre-provider proof, even with the gateway already up; a stranger on the core or web port is RED", async () => {
  const early = await run(GO, { gatewayEarly: true });
  assert.equal(early.code, 0, early.err + early.out);
  const stranger = await run(GO, { gatewayEarly: true, strangerCore: true });
  assert.equal(stranger.code, 1); assert.match(stranger.err, /core 39457 is held by 777, not the sandbox daemon tree/);
  assert.equal(stranger.w.calls.fetch, 0);
  const web = await run(GO, { webHolder: 777 });
  assert.equal(web.code, 1); assert.match(web.err, /web 39458 held by 777, expected one of the sandbox daemon tree 5000,5001/);
});

test("flow: every isolation failure REFUSES before the first synthetic request, cleans up, and exits 1", async () => {
  const cases = [
    ["live settings changed after the daemon started", { settingsChange: true }, /live settings\.json, service\.json.*settingsSha/],
    ["a live listener owner changed", { liveOwnerChange: true }, /listener:3456/],
    ["the system proxy setting changed", { proxyChange: true }, /proxySha/],
    ["the tripwire fires", { tripwire: true }, /ISOLATION VIOLATION/],
    ["the daemon is not the isolated instance", { notIsolated: true }, /daemon paths/],
    ["the takeover file points at the live settings file", { takeover: LIVE_SETTINGS }, /settingsFile/],
    ["the takeover file points at a tilde path to the live settings", { takeover: "~/.claude/settings.json" }, /settingsFile/],
    ["the preload guard was not loaded in the daemon", { noGuard: true }, /guard loaded in pids none/],
    ["the preload guard was not loaded in the daemon's CHILD", { childNoGuard: true }, /missing from the tree 5001/],
    ["a stray CCR process appeared", { strayCcr: true }, /stray=6000/],
    ["the daemon listens on a non-loopback address", { badListen: true }, /not loopback/],
    ["the daemon's child listens on 0.0.0.0:8080", { gatewayEarly: true, childListen: [{ addr: "0.0.0.0", port: 8080 }] }, /pid 5001: 0\.0\.0\.0:8080 is not loopback/],
    ["the daemon's child listens on a LIVE port", { gatewayEarly: true, childListen: [{ addr: "127.0.0.1", port: 3456 }] }, /pid 5001: 127\.0\.0\.1:3456 is a LIVE port/],
    ["the daemon's child listens on loopback 8080 (outside the range)", { gatewayEarly: true, childListen: [{ addr: "127.0.0.1", port: 8080 }] }, /pid 5001: 127\.0\.0\.1:8080 is outside/],
    ["the credential manager changed", { credChange: true }, /credTargetsSha/],
    ["a start step failed", { stepFail: "start" }, /step start exited 1/],
    ["the bootstrap step failed", { stepFail: "bootstrap" }, /step bootstrap exited 1/],
  ];
  for (const [name, opt, re] of cases) {
    const r = await run(GO, opt);
    assert.equal(r.code, 1, name);
    assert.match(r.err + r.out, re, name);
    assert.equal(r.w.calls.fetch, 0, `${name}: no synthetic request was sent`);
    assert.equal(r.w.calls.createStub, 0, `${name}: the stub was never started`);
    assert.ok(!/PASS \[/.test(r.out), `${name}: no experiment line`);
    assert.deepEqual(r.w.calls.stopProcess.filter((p) => ![5000, 5001].includes(p)), [], `${name}: only the sandbox daemon tree may be stopped`);
  }
});

test("flow: RED only at the post-provider proof, and only at the post-router-run proof, still REFUSES with an unproven isolation (the proof runs at every stage)", async () => {
  const a = await run(GO, { liveOwnerAfter: "provider" });
  assert.equal(a.code, 1); assert.match(a.err, /isolation NOT proven.*listener:3456/); assert.equal(a.w.calls.fetch, 0, "refused before the first synthetic request");
  const b = await run([...GO, "--router", "probe"], { liveOwnerAfter: "run" });
  assert.equal(b.code, 1); assert.match(b.err, /isolation NOT proven.*listener:3456/);
  assert.ok(b.w.calls.fetch > 0, "the probe run itself happened; the proof after it caught the change");
  assert.match(b.out, /FAIL \[probe\] A11/);
});

test("flow: the tripwire runs at start, immediately after `ccr start` (also when that step exits non-zero) and after the configure step; each one refuses", async () => {
  for (const stage of ["e2e:start", "e2e:after-start", "e2e:after-configure"]) {
    const r = await run(GO, { tripwireAt: stage });
    assert.equal(r.code, 1, stage); assert.match(r.err, new RegExp(`ISOLATION VIOLATION: ${stage}`), stage);
    assert.equal(r.w.calls.fetch, 0, stage);
    assert.equal(r.w.tripStages.includes(stage), true);
  }
  const start = await run(GO, { tripwireAt: "e2e:start" });
  assert.equal(start.w.calls.runStep, 0, "a tripped tripwire before the start starts nothing");
  const afterStart = await run(GO, { tripwireAt: "e2e:after-start" });
  assert.equal(afterStart.w.calls.runStep, 1, "tripped right after step 0: the bootstrap never ran");
  const nz = await run(GO, { stepFail: "start", tripwireAt: "e2e:after-start" });          // the non-zero path: the tripwire is consulted first and its message wins
  assert.equal(nz.code, 1); assert.match(nz.err, /ISOLATION VIOLATION: e2e:after-start/); assert.ok(!/step start exited/.test(nz.err));
  const nz2 = await run(GO, { stepFail: "start" });
  assert.deepEqual(nz2.w.tripStages.slice(0, 2), ["e2e:start", "e2e:after-start"], "the tripwire ran on the refuse-on-nonzero path");
  assert.match(nz2.err, /step start exited 1/);
});

test("flow: each guard a run depends on refuses on its own: spec tamper, payload, post-save config, router rules (before and after the save), persisted router path, desktop sync, gateway bound, config shape", async () => {
  const tampered = () => { const s = buildSpec({ PATH: "C:\\x" }); s.ports.gateway = 3456; return s; };
  const cases = [
    ["a tampered launch spec", { spec: tampered }, /outside|LIVE/, { runStep: 0 }],
    ["the payload fails isolation BEFORE it is sent", { payloadBad: true }, /ISOLATION VIOLATION: payload/, { noSave: true }],
    ["the persisted config fails isolation AFTER the save", { postSaveIsoFail: true }, /persisted config/, {}],
    ["Router rules are not clean before the save", { routerDirty: 1 }, /router rules/, { noSave: true }],
    ["Router rules are not clean after the save", { routerDirty: 2 }, /router rules/, {}],
    ["the persisted CUSTOM_ROUTER_PATH is not the scratch copy", { routerPathRewrite: path.join(REPO_ROOT, "spike", "uw-router.cjs") }, /persisted CUSTOM_ROUTER_PATH is not the scratch copy/, {}],
    ["the desktop sync did not land in scratch", { desktopSyncMissing: true }, /desktop sync/, {}],
    ["the gateway is not bound", { gatewayNotBound: true }, /gateway not bound/, {}],
    ["the sandbox config has no profile object", { noProfile: true }, /no profile\.profiles array/, { noSave: true }],
    ["routing.enhancedRoute is false", { enhancedRouteFalse: true }, /enhancedRoute is false in the sandbox config \(routing\)/, { noSave: true }],
    ["profile.routing.enhancedRoute is false (the field CCR's enricher reads)", { profileRouteFalse: true }, /enhancedRoute is false in the sandbox config \(profile\.routing of the enabled claude-code profile, the field CCR's enricher reads\)/, { noSave: true }],
  ];
  for (const [name, opt, re, ex] of cases) {
    const r = await run(GO, opt);
    assert.equal(r.code, 1, name); assert.match(r.err, re, name);
    assert.equal(r.w.calls.fetch, 0, `${name}: no request was sent`);
    if (ex.runStep !== undefined) assert.equal(r.w.calls.runStep, ex.runStep, name);
    if (ex.noSave) assert.equal(r.w.calls.providerSaves ?? 0, 0, `${name}: no provider-carrying saveConfig was sent`);
  }
  assert.equal(assertGatewayUrlThrows("http://127.0.0.1:3456/v1/messages"), true); assert.equal(assertGatewayUrlThrows("http://localhost:39456/v1/messages"), true);
  assert.equal(assertGatewayUrlThrows("http://127.0.0.1:39456/v1/messages"), false);
});
test("source-order pin: send() validates the gateway URL BEFORE it calls fetch (the URL is a constant, so only the call order is checkable)", () => {
  const src = fs.readFileSync(path.join(HARNESS_DIR, "subagent-e2e.mjs"), "utf8");
  const send = src.slice(src.indexOf("async function send("), src.indexOf("async function runProbePhase("));
  assert.ok(send.includes("assertGatewayUrl(url)") && send.includes("d.fetch("), "send() calls both");
  assert.ok(send.indexOf("assertGatewayUrl(url)") < send.indexOf("d.fetch("), "the check precedes the fetch");
});
function assertGatewayUrlThrows(u) { try { assertGatewayUrl(u); return false; } catch (e) { return e instanceof RefusalError; } }

test("flow: a final live-state drift that appears only AFTER the teardown fails the run; an incomplete teardown (a port still held) exits 1 and says so", async () => {
  const drift = await run(GO, { driftAtEnd: true });
  assert.equal(drift.code, 1); assert.match(drift.out, /LIVE STATE CHANGED: settingsSha/);
  for (const port of [39457, 39458]) {
    const held = await run(GO, { heldAfterStop: port });
    assert.equal(held.code, 1, `port ${port}`); assert.match(held.out, new RegExp(`WARNING sandbox \\w+ port ${port} is still held by pid`)); assert.match(held.out, /TEARDOWN INCOMPLETE/);
    assert.match(held.out, /summary: .*NOT OK/);
  }
});

test("flow (sec#2): --teardown stops a pid only after its identity is verified; every refusal exits 1 and calls stopProcess never (each check is the only one tripping in its case)", async () => {
  const mkTd = (mut) => { const { w, d } = world({}); w.started = true; w.childAlive = true; w.gatewayUp = true; mut?.(w, d); return { w, d }; };
  const stopped = async (mut) => { const { w, d } = mkTd(mut); const code = await runE2e(["--teardown"], d); return { code, w, out: w.out.join("\n") }; };
  const ok = await stopped();
  assert.equal(ok.code, 0, ok.out); assert.deepEqual(ok.w.calls.stopProcess, [5001, 5000]);
  assert.deepEqual(ok.w.mem.log.filter((x) => x[0] === "rm").map((x) => path.basename(x[1])).sort(), [...SANDBOX_OWNED].sort());
  const row = (pid, cmd) => ({ pid, ppid: 1, name: "node.exe", cmd });
  const dc = "node claude-code-router/cli.js serve --daemon-child";
  // 1. the scratch service.json names the LIVE daemon's pid and command line (and it "holds" the sandbox web port)
  const live = await stopped((w, d) => {
    d.resolveWebPort = () => ({ port: 39458, pid: 100 });
    d.sys.processes = () => [row(100, dc)]; d.sys.listenerPid = ((orig) => (p) => (p === 39458 ? 100 : orig(p)))(d.sys.listenerPid);
  });
  assert.equal(live.code, 1); assert.deepEqual(live.w.calls.stopProcess, []); assert.match(live.out, /not a verified sandbox CCR daemon/);
  // 2. ONLY the live service.json pid check can refuse: a pid that equals it but owns no live port
  const livePid = await stopped((w, d) => {
    w.live.service = JSON.stringify({ pid: 6100, url: "http://127.0.0.1:3458/?ccr_web_token=zzz" });
    d.resolveWebPort = () => ({ port: 39458, pid: 6100 }); d.sys.processes = () => [row(6100, dc)];
    d.sys.listenerPid = ((orig) => (p) => (p === 39458 ? 6100 : orig(p)))(d.sys.listenerPid);
  });
  assert.equal(livePid.code, 1); assert.deepEqual(livePid.w.calls.stopProcess, []); assert.match(livePid.out, /it is the pid in the live service\.json/);
  // 3. ONLY the live-port ownership check can refuse: a pid that owns 3457 but is not the live service.json pid
  const owner = await stopped((w, d) => {
    d.resolveWebPort = () => ({ port: 39458, pid: 6200 }); d.sys.processes = () => [row(6200, dc)];
    d.sys.listenerPid = ((orig) => (p) => (p === 39458 || p === 3457 ? 6200 : orig(p)))(d.sys.listenerPid);
  });
  assert.equal(owner.code, 1); assert.deepEqual(owner.w.calls.stopProcess, []); assert.match(owner.out, /it owns live port\(s\) 3457/);
  // 4. ONLY the sandbox-port ownership check can refuse: right command line, but it holds neither the web port nor parents the gateway holder
  const noPorts = await stopped((w, d) => {
    d.resolveWebPort = () => ({ port: 39458, pid: 6300 }); d.sys.processes = () => [row(6300, dc)];
    d.sys.listenerPid = ((orig) => (p) => (p === 39458 ? 777 : p === 39456 || p === 39457 ? undefined : orig(p)))(d.sys.listenerPid);
  });
  assert.equal(noPorts.code, 1); assert.deepEqual(noPorts.w.calls.stopProcess, []); assert.match(noPorts.out, /holds neither the sandbox web port nor is the parent/);
  // 5. ONLY the command-line check can refuse: holds the web port, but is not a CCR daemon-child
  const cmd = await stopped((w, d) => { d.sys.processes = () => [row(5000, "chrome.exe --foo")]; });
  assert.equal(cmd.code, 1); assert.deepEqual(cmd.w.calls.stopProcess, []); assert.match(cmd.out, /not a verified sandbox CCR daemon.*command line is not the CCR daemon-child/);
  // 6. a descendant that owns a live port stops the whole teardown
  const kid = await stopped((w, d) => { d.sys.listenerPid = ((orig) => (p) => (p === 3457 ? 5001 : orig(p)))(d.sys.listenerPid); });
  assert.equal(kid.code, 1); assert.deepEqual(kid.w.calls.stopProcess, []); assert.match(kid.out, /its descendant 5001: it owns live port\(s\) 3457/);
  // 7. the process is already gone / no daemon at all: nothing to stop, exit 0
  const gone = await stopped((w, d) => { d.sys.processes = () => []; d.sys.listenerPid = (p) => ({ 3456: 100, 3457: 100, 3458: 100, 4517: 200 })[p]; });
  assert.equal(gone.code, 0); assert.match(gone.out, /no longer running/);
  const none = world({}); assert.equal(await runE2e(["--teardown"], none.d), 0); assert.deepEqual(none.w.calls.stopProcess, []);
  // 8. the stop worked but a sandbox port is still held afterwards: exit 1
  const held = await stopped((w, d) => { d.sys.stopProcess = () => { w.calls.stopProcess.push("x"); }; });
  assert.equal(held.code, 1); assert.match(held.out, /WARNING sandbox .* is still held/);
});

test("flow (sec#2): a pid in the BASELINE live CCR set is never stopped, even when it presents as the sandbox daemon", async () => {
  const r = await run(GO, { baselineHas5000: true });
  assert.deepEqual(r.w.calls.stopProcess, [], "pid 5000 was in the baseline: refused");
  assert.equal(r.code, 1); assert.match(r.out, /it is in the baseline set of LIVE CCR pids/); assert.match(r.out, /TEARDOWN INCOMPLETE/);
});

test("flow (sec#8): SIGINT during the run runs the identity-verified teardown once, unhooks the handler after the run, and the teardown is not repeated", async () => {
  const r = await run(GO, { signalAt: "start" });
  assert.deepEqual(r.w.calls.stopProcess, [5001, 5000], "stopped once, tree order");
  assert.equal(r.w.unhooked, true); assert.equal(r.w.signalHandler, null);
  assert.match(r.err, /SIGINT: keeping the evidence, then running the identity-verified selective teardown/);
  assert.equal(r.code, 1, "the interrupted run fails (the daemon it was waiting for is gone)");
  assert.equal(r.w.calls.fetch, 0);
  const clean = await run(GO, {});
  assert.equal(clean.w.unhooked, true, "the handler is removed after a normal run too");
});

test("flow (sec#5): a refused run copies violations.log and the last 200 lines of each CCR log, REDACTED, to the evidence dir outside the scratch root, prints the violation lines, and the teardown does not take them", async () => {
  const hex = crypto.randomBytes(16).toString("hex");
  const violations = [`deny connect 8.8.8.8:443 ccr_web_token=${hex}`, `deny write C:\\Users\\osami\\.claude\\settings.json key ${ASCII_KEY}`].join("\n") + "\n";
  const ccrLog = Array.from({ length: 300 }, (_, i) => `line ${i + 1} Authorization: Bearer ${ASCII_KEY} ${WEB_AUTH_TOKEN}`).join("\n");
  const r = await run(GO, { violationsText: violations, ccrLog });
  assert.equal(r.code, 1); assert.match(r.err, /isolation NOT proven/);
  assert.match(r.err, /violations\.log \(2 lines, redacted\): deny connect 8\.8\.8\.8:443 ccr_web_token=<redacted> \| deny write /);
  const ev = [...r.w.mem.files.entries()].filter(([k]) => k.startsWith(norm(EVIDENCE_ROOT) + path.sep));
  const names = ev.map(([k]) => path.basename(k)).sort();
  assert.deepEqual(names, ["ccr-logs__daemon.out.log.txt", "guard-loaded.log.txt", "violations.log.txt"].sort());
  const dirs = new Set(ev.map(([k]) => path.dirname(k)));
  assert.equal(dirs.size, 1); assert.match(path.basename([...dirs][0]), /^2023-11-1\dt\d\d-\d\d-\d\d-\d{3}z$/, "a timestamped directory (fake clock; keys are lower-cased by the fake fs)");
  const all = ev.map(([, v]) => String(v)).join("\n");
  for (const leak of [hex, ASCII_KEY, WEB_AUTH_TOKEN]) assert.ok(!all.includes(leak), `evidence leaks ${leak.slice(0, 6)}...`);
  assert.ok(!r.err.includes(hex) && !r.err.includes(ASCII_KEY));
  const ccr = String(ev.find(([k]) => k.endsWith("daemon.out.log.txt"))[1]).trim().split("\n");
  assert.equal(ccr.length, 200); assert.match(ccr[0], /^line 101 /); assert.match(ccr.at(-1), /^line 300 /);
  assert.match(String(ev.find(([k]) => k.endsWith("violations.log.txt"))[1]), /ccr_web_token=<redacted>/);
  assert.ok(ev.every(([k]) => !k.startsWith(norm(SCRATCH_ROOT) + path.sep)), "nothing was retained inside SANDBOX_OWNED");
  assert.ok(r.w.mem.log.filter((x) => x[0] === "rm").every((x) => !norm(x[1]).startsWith(norm(EVIDENCE_ROOT))), "the teardown removed none of it");
  assert.equal(r.w.mem.files.has(norm(VIOLATIONS_LOG)), false, "while the scratch copy of the log is gone");
  assert.match(r.out, /evidence retained outside the scratch root: .*g1-evidence/);
  const clean = await run(GO, {});
  assert.ok([...clean.w.mem.files.keys()].every((k) => !k.startsWith(norm(EVIDENCE_ROOT))), "a clean run retains nothing");
});

test("flow: A0 failing (enricher gate unsatisfied) aborts with FAIL, prints no later experiment, and does not run the next router", async () => {
  const r = await run(GO, { noBl: true });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL \[probe\] A0 builtInClaudeCodeSubagent is not true/);
  assert.ok(!/ E4 /.test(r.out) && !/\[next\]/.test(r.out));
  assert.match(r.err, /A0 FAILED|PROBLEM: probe A0/);
});

test("flow: a missing profile key aborts with FAIL A0 and field names only", async () => {
  const { w, d } = world({});
  const orig = d.rpc;
  d.rpc = async (m, a) => { const v = await orig(m, a); if (m === "saveConfig") v.APIKEYS = [{ id: "unrelated", key: fake("x") }]; return v; };
  seedApproval(w, GO);
  assert.equal(await runE2e(GO, d), 1);
  assert.match(w.out.join("\n") + w.err.join("\n"), /no API key whose id is "profile:default-claude-code" \(the id CCR derives for profile "default-claude-code"; 1 key entries, fields: id,key\)/);
  assert.equal(w.calls.fetch, 0);
});

test("flow: blocked design points are FINDING lines and the run still exits 0 (E4, E5, E12, E7, E13)", async () => {
  const r = await run([...GO, "--router", "probe"], { dropE4: true, dropE5: true, noContentLength: true, noPersist: true });
  assert.equal(r.code, 0, r.err + r.out);
  const by = Object.fromEntries(r.out.split("\n").map(parseLine).filter(Boolean).map((p) => [p.id, p.kind]));
  assert.equal(by.A0, "PASS"); assert.equal(by.E4, "FINDING"); assert.equal(by.E5, "FINDING"); assert.equal(by.E12, "FINDING"); assert.equal(by.E7, "FINDING");
});

test("flow (code#1, code#2): CCR sending BARE model names is handled everywhere, E13 uses its control arm, and cannot pass vacuously because of spelling", async () => {
  const bare = await run(GO, { bare: true });
  assert.equal(bare.code, 0, bare.err + bare.out);
  const by = Object.fromEntries(bare.out.split("\n").map(parseLine).filter(Boolean).map((p) => [`${p.router}:${p.id}`, p]));
  assert.equal(by["next:A1"].kind, "PASS"); assert.match(by["next:A1"].detail, /\(spelling: bare\)/);
  assert.equal(by["next:A2"].kind, "PASS"); assert.match(by["next:A2"].detail, /bare spelling/);
  assert.equal(by["probe:E13"].kind, "PASS"); assert.match(by["probe:E13"].detail, /control arm served the tag \(m-free, bare spelling\)/);
  const selector = await run(GO, {});
  assert.match(selector.out, /PASS \[next\] A1 .*\(spelling: selector\)/);
  assert.match(selector.out, /PASS \[probe\] E13 .*control arm served the tag \(uwstub\/m-free, selector spelling\)/);
  // clearing the tag changes nothing and CCR spells names bare: the old selector-only comparison would have called this a PASS
  const vac = await run([...GO, "--router", "probe"], { bare: true, clearNoEffect: true });
  assert.match(vac.out, /FINDING \[probe\] E13 clearing builtInSubagentModel did NOT stop/);
  // the control arm does not show the tag honoured: undecidable, never a PASS
  const und = await run([...GO, "--router", "probe"], { tagNotHonoured: true });
  assert.match(und.out, /FINDING \[probe\] E13 E13 undecidable: the control arm did not show the tag honoured/);
  assert.equal(und.code, 0, "a FINDING is not a failure");
});

test("flow (code#5..#12): E7 reports 'cache not deleted'; A8 FAILs on a changed since, on a Failed-to-load log and notes 0 log files; A11 is a FINDING when the baseline lacks the live gateway", async () => {
  const e7 = await run([...GO, "--router", "probe"], { cacheNotDeleted: true });
  assert.match(e7.out, /FINDING \[probe\] E7 cache not deleted/); assert.equal(e7.code, 0);
  const since = await run([...GO, "--router", "next"], { sinceResets: true });
  assert.equal(since.code, 1); assert.match(since.out, /FAIL \[next\] A8 status\.since changed/);
  const few = await run([...GO, "--router", "next"], { reqShortBy: 1 });                       // five requests reached the router, six were sent: the minimum is six
  assert.equal(few.code, 1); assert.match(few.out, /FAIL \[next\] A8 globalThis counters did not accumulate: counters\.req=5, expected at least 6/);
  const lf = await run([...GO, "--router", "next"], { ccrLog: "boot\nFailed to load custom router: boom\n" });
  assert.equal(lf.code, 1); assert.match(lf.out, /FAIL \[next\] A8 CCR logged `Failed to load custom router`/);
  const logsOk = await run([...GO, "--router", "next"], { ccrLog: "boot\nready\n" });
  assert.equal(logsOk.code, 0, logsOk.err + logsOk.out); assert.match(logsOk.out, /PASS \[next\] A8 .* in 1 CCR log files\.$/m);
  const green = await run([...GO, "--router", "next"], {});
  assert.match(green.out, /PASS \[next\] A8 .*NOTE: 0 CCR log files were found/);
  const nolive = await run([...GO, "--router", "next"], { noLive: true });
  assert.equal(nolive.code, 1); assert.match(nolive.out, /FINDING \[next\] A11 the live gateway was not observed in the baseline/); assert.match(nolive.out, /WARNING: the live gateway was not observed/);
});

test("flow (code#10): the router copy is hashed on BOTH sides and the full sha256 is printed; a source that changes during the copy, or a corrupt copy, refuses", async () => {
  const a = world({});
  const real = a.w.mem.readFileSync; let n = 0;
  a.w.mem.readFileSync = (p, enc) => (norm(p) === norm(PROBE_ROUTER_SRC) && ++n > 1 ? Buffer.from("CHANGED-UNDER-US") : real(p, enc));
  const r1 = await go(a.w, a.d, GO);
  assert.equal(r1.code, 1); assert.match(r1.err, /changed while it was being copied/); assert.equal(r1.w.calls.fetch, 0);
  const b = world({});
  const origRename = b.w.mem.renameSync;
  b.w.mem.renameSync = (x, y) => { origRename(x, y); if (norm(y) === norm(SCRATCH_ROUTER)) b.w.mem.files.set(norm(y), "CORRUPT"); };
  const r2 = await go(b.w, b.d, GO);
  assert.equal(r2.code, 1); assert.match(r2.err, /the scratch router copy differs from .* after the write/);
});

// ---------------------------------------------------------------- fingerprint and proof units
function fakeSys(over = {}) {
  return { readText: (p) => (norm(p) === norm(LIVE_SETTINGS) ? '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:3456"}}' : norm(p) === norm(LIVE_SERVICE_JSON) ? '{"pid":100}' : null),
    sha256File: () => "e".repeat(64), listDir: () => null, listenerPid: (p) => p, credSha: () => "c", proxySha: () => "px", supervisorState: () => "Disabled", processes: () => [], selfPid: 1, ...over };
}
test("fingerprint: holds hashes, pids and names only; diff names what changed (the system proxy included); a missing settings file is a state, not a crash", () => {
  const a = fingerprintLive(fakeSys());
  assert.equal(a.settingsBaseUrl, "http://127.0.0.1:3456"); assert.equal(a.liveServicePid, 100); assert.equal(a["listener:4517"], 4517); assert.equal(a.proxySha, "px");
  assert.deepEqual(diffFingerprint(a, { ...a }), []);
  assert.match(diffFingerprint(a, { ...a, "listener:3456": 1 })[0], /^listener:3456: 3456 -> 1$/);
  assert.match(diffFingerprint(a, { ...a, proxySha: "other" })[0], /^proxySha: px -> other$/);
  assert.match(describeFingerprint(a), /^settings sha256 eeeeeeeeeeee .*service\.json pid 100; listener pids 3456=3456 3457=3457 3458=3458 4517=4517$/);
  const none = fingerprintLive(fakeSys({ readText: () => null, sha256File: () => "(absent)" }));
  assert.equal(none.settingsMarkers, -1); assert.equal(none.settingsBaseUrl, "(absent)"); assert.equal(none.liveServicePid, null);
  assert.equal(baselineOf(fakeSys({ processes: () => [{ pid: 3, ppid: 1, name: "node", cmd: "x claude-code-router y" }, { pid: 4, ppid: 1, name: "node", cmd: "other" }] })).ccrPids.join(), "3");
  assert.equal(liveServicePid(fakeSys()), 100);
  assert.equal(liveServicePid(fakeSys({ readText: () => "{torn" })), "(unparseable)");
  assert.equal(liveServicePid(fakeSys({ readText: () => null })), null);
  assert.equal(typeof realSys().proxySha, "function");
});
// The LIVE v2 router (G2) writes into state/subagent all the time; the isolation proof must not go RED on that, but must on anything a run must never change.
const RUNTIME_NAMES = ["agents-d2e51e39-fb60-42f2-a847-b70dc99f0a25.jsonl", "agents.jsonl", "agents.3.jsonl", "main-b3e07c44.json", "status.json", "status-jbw.json", "decisions.jsonl", "decisions.1.jsonl", "classify.jsonl",
  "classify.1.jsonl", "cooling.json", "status-jbw.json.tmp-123s", "main-x.json.tmp-9a4", "cooling.json.tmp-77s", "something.lock"];
/** A live state/subagent as a mutable map name -> {size, text}; the fake sys serves listDir (name:size) and sha256File from it. */
function liveStateSys(files) {
  const sys = fakeSys({
    listDir: (p) => (norm(p) === norm(LIVE_STATE_SUBAGENT) ? [...files.keys()].map((n) => `${n}:${files.get(n).size}`).sort() : null),
    sha256File: (p) => { const n = path.basename(p); return norm(path.dirname(p)) === norm(LIVE_STATE_SUBAGENT) && files.has(n) ? `h:${files.get(n).text}` : "(absent)"; },
  });
  return sys;
}
const baseLive = () => new Map([["policy.json", { size: 25987, text: "P1" }], ...RUNTIME_NAMES.slice(0, 6).map((n) => [n, { size: 10, text: "r" }])]);
async function stateCheck(files, mutate) {
  const sys = liveStateSys(files);
  const ctx = { spec: buildSpec({ PATH: "x" }), baseline: baselineOf(sys), phase: "pre-provider", daemonPid: undefined, selfPid: 1, stage: "t" };
  mutate(files);
  const r = await proveIsolation(ctx, { sys, tripwire: { assert() {} } });
  const c = r.checks.find((x) => /state[/]subagent/.test(x.name));
  return { c, others: r.checks.filter((x) => !x.ok && x !== c) };
}
test("proof (state/subagent): the live router's own runtime churn is GREEN, a changed policy.json, a toggled shadow.flag or a new unknown file is RED", async () => {
  for (const n of RUNTIME_NAMES) assert.ok(ROUTER_RUNTIME_RE.test(n), `${n} is router runtime`);
  for (const n of ["policy.json", "shadow.flag", "policy.json.bak", "agentsx.jsonl", "main-.json", "status-.json", "statusx.json", "notes.txt", "observed.json", "cooling.json.bak", "decisions.jsonl.old", "classify.txt"]) assert.ok(!ROUTER_RUNTIME_RE.test(n), `${n} is NOT router runtime`);
  // churn: every runtime name appears, vanishes, grows, a new session's files show up: still GREEN
  let r = await stateCheck(baseLive(), (m) => {
    for (const n of RUNTIME_NAMES) m.set(n, { size: 999, text: "new" });
    m.delete("agents.jsonl"); m.set("agents-aaaaaaaa-bbbb.jsonl", { size: 5, text: "z" }); m.set("main-zzzz.json", { size: 84, text: "z" });
  });
  assert.equal(r.c.ok, true, r.c.detail); assert.equal(r.others.length, 0);
  // RED: policy.json content changed (same size), then size changed
  r = await stateCheck(baseLive(), (m) => m.set("policy.json", { size: 25987, text: "P2" })); assert.equal(r.c.ok, false); assert.match(r.c.detail, /policySha/);
  r = await stateCheck(baseLive(), (m) => m.set("policy.json", { size: 25988, text: "P1" })); assert.equal(r.c.ok, false); assert.match(r.c.detail, /stateSubagentOther/);
  // RED: policy.json removed; shadow.flag appears, then changes content
  r = await stateCheck(baseLive(), (m) => m.delete("policy.json")); assert.equal(r.c.ok, false);
  r = await stateCheck(baseLive(), (m) => m.set("shadow.flag", { size: 20, text: "auto:x" })); assert.equal(r.c.ok, false); assert.match(r.c.detail, /shadowFlagSha/);
  const withFlag = () => { const m = baseLive(); m.set("shadow.flag", { size: 20, text: "auto:x" }); return m; };
  r = await stateCheck(withFlag(), (m) => m.set("shadow.flag", { size: 20, text: "auto:y" })); assert.equal(r.c.ok, false);
  r = await stateCheck(withFlag(), (m) => m.delete("shadow.flag")); assert.equal(r.c.ok, false);
  // RED: a NEW unknown file, and a new file that only looks like a runtime one
  r = await stateCheck(baseLive(), (m) => m.set("sandbox-leak.json", { size: 1, text: "x" })); assert.equal(r.c.ok, false); assert.match(r.c.detail, /sandbox-leak\.json/);
  r = await stateCheck(baseLive(), (m) => m.set("policy.json.bak", { size: 1, text: "x" })); assert.equal(r.c.ok, false);
  // the folder disappearing is a difference too
  const sys0 = liveStateSys(baseLive()); const b0 = fingerprintLive(sys0);
  assert.notDeepEqual(b0.stateSubagentOther, fingerprintLive(fakeSys()).stateSubagentOther);
});
test("proof (state/subagent) mutation: a fingerprint that ignores EVERYTHING in the folder, or ignores NOTHING, fails the same table", async () => {
  const table = async (fpState) => {
    const verdicts = [];
    const run = async (files, mutate) => { const a = fpState(files); mutate(files); const b = fpState(files); verdicts.push(a === b); };
    await run(baseLive(), (m) => { for (const n of RUNTIME_NAMES) m.set(n, { size: 999, text: "new" }); });   // must be equal (GREEN)
    await run(baseLive(), (m) => m.set("policy.json", { size: 25987, text: "P2" }));                               // must differ
    await run(baseLive(), (m) => m.set("sandbox-leak.json", { size: 1, text: "x" }));                             // must differ
    await run(baseLive(), (m) => m.set("shadow.flag", { size: 20, text: "a" }));                                   // must differ
    return verdicts.join();
  };
  const want = "true,false,false,false";
  const real = (files) => { const f = fingerprintLive(liveStateSys(files)); return JSON.stringify([f.stateSubagentOther, f.policySha, f.shadowFlagSha]); };
  assert.equal(await table(real), want);
  assert.notEqual(await table(() => "x"), want);                                                                  // ignore everything
  assert.notEqual(await table((files) => [...files.keys()].map((n) => `${n}:${files.get(n).size}`).sort().join("|")), want);   // ignore nothing (the old listing)
});
test("proof: a failing check names itself, a thrown check is a failed check (the proof never throws), assertIsolationProven refuses", async () => {
  const sys = fakeSys();
  const base = baselineOf(sys);
  const ctx = { spec: buildSpec({ PATH: "x" }), baseline: base, phase: "pre-provider", daemonPid: undefined, selfPid: 1, stage: "t" };
  const ok = await proveIsolation(ctx, { sys, tripwire: { assert() {} } });
  assert.equal(ok.ok, true, JSON.stringify(ok.checks.filter((c) => !c.ok)));
  const bad = await proveIsolation(ctx, { sys, tripwire: { assert() { throw new Error("boom"); } } });
  assert.equal(bad.ok, false);
  assert.match(bad.checks.find((c) => !c.ok).detail, /threw: boom/);
  assert.throws(() => assertIsolationProven(bad), (e) => e instanceof RefusalError && /isolation NOT proven/.test(e.message));
  assert.equal(assertIsolationProven(ok), ok);
});

/** A live-shaped sandbox tree as seen by the proof: daemon 5000 (gateway + web), child 5001 (core), optional grandchild; `over` tweaks it. */
async function proveTree(over = {}) {
  const guard = over.guard ?? [5000, 5001];
  const listen = { 5000: [{ addr: "127.0.0.1", port: 39456 }, { addr: "127.0.0.1", port: 39458 }, { addr: "127.0.0.1", port: 50123 }], 5001: [{ addr: "127.0.0.1", port: 39457 }], ...over.listen };
  const holders = { 3456: 100, 3457: 100, 3458: 100, 4517: 200, 39456: 5000, 39457: 5001, 39458: 5000, 39459: 1, ...over.holders };
  const rows = [{ pid: 100, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js serve" }];
  const before = fakeSys({ processes: () => rows, listenerPid: (p) => holders[p] });
  const baseline = baselineOf(before);
  const treeRows = over.rows ?? [DAEMON_ROW, CHILD_ROW];
  const sys = fakeSys({ processes: () => [...rows, ...treeRows], listenerPid: (p) => holders[p], listenPortsOf: (pid) => listen[pid] ?? [],
    readText: (p) => (norm(p) === norm(GUARD_LOADED_LOG) ? guard.map((pid) => JSON.stringify({ pid })).join("\n") : norm(p) === norm(VIOLATIONS_LOG) ? over.violations ?? null : fakeSys().readText(p)) });
  const ctx = { spec: buildSpec({ PATH: "x" }), baseline, phase: over.phase ?? "post-provider", daemonPid: 5000, selfPid: 1, stage: "t" };
  ctx.swapRan = over.swapRan; ctx.track = over.track;
  const res = await proveIsolation(ctx, { sys, tripwire: { assert() {} }, assertIsolatedInstance: over.assertIsolatedInstance ?? (async () => {}), assertIsolatedConfig: over.assertIsolatedConfig ?? (async () => {}), resolveWebPort: over.resolveWebPort ?? (() => ({ port: 39458, pid: 5000 })), getConfig: over.getConfig, assertRouterClean: realAssertRouterClean, sleep: over.sleep, now: over.now, redact: over.redact });
  const by = (re) => res.checks.find((c) => re.test(c.name));
  return { res, ports: by(/sandbox ports held/), guard: by(/guard loaded/), proc: by(/process table/), fallback: by(/persisted Router.fallback/), web: by(/daemon web port and token/), cfg: by(/persisted config isolated/), core: by(/core worker pid changed/) };
}
test("proof (sec#1 HIGH): the live-shaped tree (daemon: gateway+web, CHILD: core) is GREEN; a child on 0.0.0.0:8080, on a live port, outside the range, a grandchild, or a stranger on a sandbox port is RED", async () => {
  const g = await proveTree();
  assert.equal(g.res.ok, true, JSON.stringify(g.res.checks.filter((c) => !c.ok)));
  assert.match(g.ports.detail, /sandbox tree listens on 5000:39456\+39458\+50123\(ephemeral\) 5001:39457/);
  assert.equal((await proveTree({ rows: [DAEMON_ROW], holders: { 39457: 5000 }, listen: { 5000: [{ addr: "127.0.0.1", port: 39456 }, { addr: "127.0.0.1", port: 39457 }, { addr: "127.0.0.1", port: 39458 }] }, guard: [5000] })).res.ok, true, "the old one-process shape too");
  for (const [name, over, re] of [
    ["child on 0.0.0.0:8080", { listen: { 5001: [{ addr: "127.0.0.1", port: 39457 }, { addr: "0.0.0.0", port: 8080 }] } }, /pid 5001: 0\.0\.0\.0:8080 is not loopback/],
    ["child on live loopback 3456", { listen: { 5001: [{ addr: "127.0.0.1", port: 39457 }, { addr: "127.0.0.1", port: 3456 }] } }, /pid 5001: 127\.0\.0\.1:3456 is a LIVE port/],
    ["child on loopback 8080", { listen: { 5001: [{ addr: "127.0.0.1", port: 39457 }, { addr: "127.0.0.1", port: 8080 }] } }, /8080 is outside/],
    ["a grandchild on 0.0.0.0:9", { rows: [DAEMON_ROW, CHILD_ROW, { pid: 5002, ppid: 5001, name: "node.exe", cmd: "node claude-code-router/x.js" }], guard: [5000, 5001, 5002], listen: { 5002: [{ addr: "0.0.0.0", port: 9 }] } }, /pid 5002: 0\.0\.0\.0:9 is not loopback/],
    ["core held by a stranger", { holders: { 39457: 777 } }, /core 39457 held by 777, expected one of the sandbox daemon tree 5000,5001/],
    ["gateway held by nobody", { holders: { 39456: undefined } }, /gateway 39456 held by nobody/],
    ["stub not held by the orchestrator", { holders: { 39459: 6 } }, /stub 39459 held by 6, expected the orchestrator 1/],
  ]) {
    const r = await proveTree(over);
    assert.equal(r.res.ok, false, name); assert.equal(r.ports.ok, false, name); assert.match(r.ports.detail, re, name);
  }
});
test("proof (sec#1): the PRE-provider rule: web must be held by the tree; gateway and core, when held, must be held by the tree (the daemon's child counts); a stranger is RED", async () => {
  assert.equal((await proveTree({ phase: "pre-provider" })).ports.ok, true);
  assert.equal((await proveTree({ phase: "pre-provider", holders: { 39456: undefined, 39457: undefined } })).ports.ok, true, "gateway and core not up yet is fine");
  const s = await proveTree({ phase: "pre-provider", holders: { 39457: 777 } });
  assert.equal(s.ports.ok, false); assert.match(s.ports.detail, /core 39457 is held by 777, not the sandbox daemon tree/);
  const w = await proveTree({ phase: "pre-provider", holders: { 39458: 777 } });
  assert.equal(w.ports.ok, false); assert.match(w.ports.detail, /web 39458 held by 777/);
  assert.equal(treeOf([DAEMON_ROW, CHILD_ROW, { pid: 9, ppid: 1, name: "node", cmd: "x" }], 5000).join(), "5000,5001");
});
test("proof (sec#1): the guard must be loaded in the daemon AND in every node process of its tree; violations.log must be empty", async () => {
  assert.equal((await proveTree()).guard.ok, true);
  const noChild = await proveTree({ guard: [5000] });
  assert.equal(noChild.guard.ok, false); assert.match(noChild.guard.detail, /missing from the tree 5001/);
  const noDaemon = await proveTree({ guard: [5001] });
  assert.equal(noDaemon.guard.ok, false); assert.match(noDaemon.guard.detail, /missing from the tree 5000/);
  const viol = await proveTree({ violations: "deny x\n" });
  assert.equal(viol.guard.ok, false); assert.match(viol.guard.detail, /violations 1/);
  const wrapper = await proveTree({ rows: [DAEMON_ROW, CHILD_ROW, { pid: 5003, ppid: 5000, name: "ccr.exe", cmd: "ccr.exe claude-code-router" }], guard: [5000, 5001] });
  assert.equal(wrapper.guard.ok, true, "a non-node wrapper process is not required to load a node preload");
});

test("proof: listen-port classification (loopback sandbox range ok, ephemeral recorded, live and non-loopback and out-of-range refused)", () => {
  const r = parseListenPorts([{ addr: "127.0.0.1", port: 39458 }, { addr: "127.0.0.1", port: 50000 }, { addr: "127.0.0.1", port: 3458 }, { addr: "0.0.0.0", port: 39456 }, { addr: "127.0.0.1", port: 8080 }]);
  assert.deepEqual(r.rec, [39458, "50000(ephemeral)"]);
  assert.equal(r.bad.length, 3);
  assert.match(r.bad.join(), /3458 is a LIVE port/); assert.match(r.bad.join(), /not loopback/); assert.match(r.bad.join(), /8080 is outside/);
  assert.equal(SCRATCH_SETTINGS.startsWith(SCRATCH_ROOT), true);
});

test("real sys adapter: file helpers work on a temp dir (the PowerShell-backed methods are not called here)", () => {
  const s = realSys();
  const dir = mk();
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  fs.mkdirSync(path.join(dir, "sub"));
  assert.equal(s.readText(path.join(dir, "a.txt")), "hello");
  assert.equal(s.readText(path.join(dir, "nope")), null);
  assert.equal(s.sha256File(path.join(dir, "a.txt")), crypto.createHash("sha256").update("hello").digest("hex"));
  assert.equal(s.sha256File(path.join(dir, "nope")), "(absent)");
  assert.deepEqual(s.listDir(dir), ["a.txt:5", "sub:0"]);
  assert.equal(s.listDir(path.join(dir, "nope")), null);
  assert.equal(s.selfPid, process.pid);
  assert.throws(() => s.stopProcess(-1), /bad pid/);
  assert.throws(() => s.stopProcess("1; calc"), /bad pid/);
});

// ================================================================ third fix round (H1 .. H10); every test below FAILS on the pre-round code
const FIXTURE_FLAGS = path.join(REPO_ROOT, "test", "fixtures", "subagent-flags.mjs");
const KEY_CLI = path.join(REPO_ROOT, "keysync", "key.mjs");
/** reads each executed file from the real working tree (read only); `altered` gets one extra line appended (a file edited after the plan was read) */
const readWith = (altered) => (f) => { const b = fs.readFileSync(f); return altered && norm(f) === norm(altered) ? Buffer.concat([b, Buffer.from("\n// edited after the plan was read\n")]) : b; };
const planShaWithFiles = (argv, env, fileHashes) => { const { opts } = parseArgs(argv); return sha(renderPlan(buildSpec(env, { preloadGuard: opts.preloadGuard }), { ...opts, fileHashes, ccr: CCR_FAKE }).join("\n")); };

test("tripwire (H1, J1, J2): the Claude desktop app's own churn (sentry/, session.json, logs/, config.json, claude_desktop_config.json, a window-position key, a new host-creds file, top-level names, Downloads growth) leaves it quiet; an edit of configLibrary/<id>.json or _meta.json, a new or removed library entry, or a new Downloads file trips it", () => {
  const root = mk(), c3p = path.join(root, "Claude-3p"), dl = path.join(root, "Downloads"), settings = path.join(root, "settings.json");
  for (const d of ["sentry", "logs", "configLibrary"]) fs.mkdirSync(path.join(c3p, d), { recursive: true });
  fs.mkdirSync(dl);
  const put = (f, t) => fs.writeFileSync(f, t);
  const lib = (n) => path.join(c3p, "configLibrary", n);
  put(settings, "{}"); put(path.join(c3p, "claude_desktop_config.json"), '{"a":1}'); put(path.join(c3p, "config.json"), '{"quickWindowPosition":{"x":1}}'); put(path.join(c3p, "sentry", "scope_v3.json"), "s0");
  put(path.join(c3p, "session.json"), "x0"); put(path.join(c3p, "logs", "main.log"), "l0"); put(lib("_meta.json"), '{"appliedId":"a"}'); put(lib("8f69.json"), '{"inferenceModelsUpdatedAt":"t0"}'); put(path.join(dl, "a.zip"), "zip");
  let userPath = "P1";
  const tw = makeTripwire([settings], { claude3pDir: c3p, downloadsDir: dl, userPath: () => userPath });
  tw.assert("baseline");
  // the app's churn: contents of sentry/session/logs rewritten, a NEW nested file, a download growing in place with a new mtime
  put(path.join(c3p, "sentry", "scope_v3.json"), "s1 longer"); put(path.join(c3p, "session.json"), "x1"); fs.appendFileSync(path.join(c3p, "logs", "main.log"), "more\n");
  put(path.join(c3p, "sentry", "new-event.json"), "e"); fs.appendFileSync(path.join(dl, "a.zip"), "grows"); fs.utimesSync(path.join(dl, "a.zip"), new Date(2020, 1, 1), new Date(2020, 1, 1));
  assert.doesNotThrow(() => tw.assert("app churn"), "running-app churn must not trip the tripwire");
  // J2: the app's OWN state files and per-launch names: a window move/resize/update/restart is not a breach
  put(path.join(c3p, "config.json"), '{"quickWindowPosition":{"x":99},"bootFrameLayout":"b","updaterBannerStagedAt":"now"}');
  put(path.join(c3p, "claude_desktop_config.json"), '{"a":1,"preferences":{"sidebarMode":"x"}}');
  put(path.join(c3p, `host-creds-${crypto.randomUUID()}.json`), "{}"); fs.mkdirSync(path.join(c3p, "Local Storage")); put(path.join(c3p, "exported.json"), "x");
  assert.doesNotThrow(() => tw.assert("app state"), "config.json, claude_desktop_config.json, a new host-creds file, new top-level names: quiet");
  const trips = (re, why) => assert.throws(() => tw.assert("x"), re, why);
  // J1: what CCR's desktop sync rewrites: configLibrary/<id>.json (every sync), _meta.json
  put(lib("8f69.json"), '{"inferenceModelsUpdatedAt":"t1"}'); trips(/configLibrary CHANGED/, "in-place edit of the profile file (same name, same size)"); put(lib("8f69.json"), '{"inferenceModelsUpdatedAt":"t0"}'); tw.assert("restored");
  put(lib("_meta.json"), '{"appliedId":"b"}'); trips(/configLibrary CHANGED/, "in-place edit of _meta.json"); put(lib("_meta.json"), '{"appliedId":"a"}'); tw.assert("restored");
  put(lib("abc.json"), "{}"); trips(/configLibrary CHANGED/, "new configLibrary profile"); fs.rmSync(lib("abc.json")); tw.assert("restored");
  fs.rmSync(lib("8f69.json")); trips(/configLibrary CHANGED/, "removed profile file"); put(lib("8f69.json"), '{"inferenceModelsUpdatedAt":"t0"}'); tw.assert("restored");
  fs.mkdirSync(lib("sub")); trips(/configLibrary CHANGED/, "new library subfolder"); fs.rmdirSync(lib("sub")); tw.assert("restored");
  // a NEW file in Downloads (exportData), also in a subfolder; and the other watched surfaces
  put(path.join(dl, "ccr-export.json"), "keys"); trips(/Downloads CHANGED/, "new Downloads file"); fs.rmSync(path.join(dl, "ccr-export.json")); tw.assert("restored");
  fs.mkdirSync(path.join(dl, "sub")); put(path.join(dl, "sub", "k.json"), "k"); trips(/Downloads CHANGED/, "new Downloads file in a subfolder"); fs.rmSync(path.join(dl, "sub"), { recursive: true }); tw.assert("restored");
  put(settings, '{"x":1}'); trips(/settings\.json CHANGED/, "the settings file"); put(settings, "{}"); tw.assert("restored");
  userPath = "P2"; trips(/env:userPath CHANGED/, "user PATH"); userPath = "P1"; tw.assert("restored");
});

test("tripwire (H1, J1): an absent configLibrary equals an absent one; creating it or a file in it trips; a Claude-3p folder that does not exist at all is a state, not a crash; an unreadable library file is a fingerprint of its own", () => {
  const root = mk(), c3p = path.join(root, "Claude-3p"), dl = path.join(root, "Downloads");
  fs.mkdirSync(c3p); fs.mkdirSync(dl);
  const mkTw = (dir) => makeTripwire([], { claude3pDir: dir, downloadsDir: dl, userPath: () => "P" });
  const tw = mkTw(c3p);
  tw.assert("absent == absent");
  fs.writeFileSync(path.join(c3p, "config.json"), "{}");
  assert.doesNotThrow(() => tw.assert("config.json is the app's own file"));
  fs.mkdirSync(path.join(c3p, "configLibrary"));
  assert.throws(() => tw.assert("created"), /CHANGED/);
  const none = mkTw(path.join(root, "no-such-dir"));
  assert.doesNotThrow(() => none.assert("whole folder absent"));
  fs.mkdirSync(path.join(root, "no-such-dir"));
  assert.doesNotThrow(() => none.assert("an empty Claude-3p folder is still no library"));
  // an unreadable (here: a directory where a .json file is expected) library file is a fingerprint of its own, never a throw out of the collector
  const odd = path.join(root, "odd"); fs.mkdirSync(path.join(odd, "configLibrary", "x.json"), { recursive: true });
  const c = tripwireCollectors([], { claude3pDir: odd, downloadsDir: dl, userPath: () => "P" });
  const key = [...c.keys()].find((k) => k.startsWith("library:"));
  assert.match(c.get(key)(), /^[0-9a-f]{64}$/, "a folder named x.json is a d: entry, not a read");
  assert.ok(![...c.keys()].some((k) => /config\.json|claude_desktop_config|names:.*Claude-3p$/.test(k)), "no collector for the app's own files or the top-level names");
});

test("approval (H2): --approve-plan refuses without an interactive terminal (exit 2, nothing written, no prompt) and the typed confirmation must be exactly the first 12 hex of the plan sha256", async () => {
  const non = world({ nonInteractive: true });
  assert.equal(await runE2e(["--approve-plan"], non.d), 2);
  assert.match(non.w.err.join("\n"), /needs an interactive terminal/);
  assert.equal(non.w.asked, undefined, "no prompt was shown"); assert.equal(non.w.mem.files.has(norm(APPROVAL_FILE)), false);
  const want = planShaOf([], world({}).w.env).slice(0, 12);
  for (const typed of ["", "yes", want.toUpperCase(), want.slice(0, 11), `${want}0`, ` ${want}`, planShaOf(["--router", "next"], world({}).w.env).slice(0, 12)]) {
    const { w, d } = world({ typed });
    assert.equal(await runE2e(["--approve-plan"], d), 2, `typed ${JSON.stringify(typed)}`);
    assert.match(w.err.join("\n"), /does not match the plan sha256: nothing was approved/);
    assert.equal(w.mem.files.has(norm(APPROVAL_FILE)), false, `typed ${JSON.stringify(typed)} wrote an approval`);
  }
  const { w, d } = world({});
  assert.equal(await runE2e(["--approve-plan"], d), 0, w.err.join("\n"));
  assert.ok(w.asked.includes(`(${want})`), "the prompt prints the 12 hex the owner must type");
  const doc = JSON.parse(w.mem.files.get(norm(APPROVAL_FILE)));
  assert.equal(doc.planSha256.slice(0, 12), want);
  assert.deepEqual(doc.files, hashExecutedFiles(), "the approval records the file hashes it covers");
  const crlf = world({ typed: `${want}\r\n` });                         // a line terminator from the terminal is not part of the typed text
  assert.equal(await runE2e(["--approve-plan"], crlf.d), 0);
  assert.match(USAGE.join("\n"), /interactive terminal/); assert.match(USAGE.join("\n"), /ONE-USE/);
});

test("approval (H2): the approval file is CONSUMED at run start: a second run needs a fresh approval, also after a refusal; one whose files no longer match the CURRENT plan exits 2 and starts nothing", async () => {
  const first = await run(GO, {});
  assert.equal(first.code, 0, first.err + first.out);
  assert.equal(first.w.mem.files.has(norm(APPROVAL_FILE)), false, "the approval was deleted");
  assert.match(first.out, /approval consumed \(plan sha256 [0-9a-f]{64}\)/);
  const { w, d } = world({});
  seedApproval(w, GO);
  assert.equal(await runE2e(GO, d), 0);
  assert.equal(await runE2e(GO, d), 2, "same world, no fresh approval: refused");
  assert.match(w.err.join("\n"), /no approval file/);
  // consumed even when a later preflight check refuses (a sandbox port already held)
  const refused = await run(GO, { preHeld: 39458 });
  assert.equal(refused.code, 1); assert.equal(refused.w.calls.runStep, 0);
  assert.equal(refused.w.mem.files.has(norm(APPROVAL_FILE)), false, "a refused run still used up its approval");
  // a file changed after the approval: the plan hash differs, the exit is 2, the message names the file, nothing starts and the approval is left alone
  const edited = norm(path.join(HARNESS_DIR, "guard.mjs"));
  const fh = hashExecutedFiles(readWith(edited));
  const stale = world({});
  const shaX = planShaWithFiles(GO, stale.w.env, fh);
  seedApproval(stale.w, GO, { raw: JSON.stringify({ schema: 1, planSha256: shaX, approvedAt: new Date(stale.w.nowMs()).toISOString(), files: fh }) });
  assert.equal(await runE2e(GO, stale.d), 2);
  assert.match(stale.w.err.join("\n"), /DIFFERENT plan.*executed file changed since the approval \(harness\/guard\.mjs\)/);
  assert.equal(stale.w.calls.runStep, 0); assert.equal(stale.w.mem.files.has(norm(APPROVAL_FILE)), true, "a refused approval check does not consume it");
});

test("plan (H3): the plan text lists the sha256 of every executed file (raw working-tree bytes AND LF-normalised), so the plan hash covers each of them; the run prints them again and refuses when one changed since the plan", async () => {
  const names = EXECUTED_FILES.map((f) => path.relative(REPO_ROOT, f).replace(/\\/g, "/"));
  assert.deepEqual(names, ["harness/subagent-e2e.mjs", "harness/subagent-sandbox-spec.mjs", "harness/guard.mjs", "harness/config.mjs", "harness/stub-upstream.mjs", "harness/probe-router.cjs",
    "harness/bootstrap-live-safe.mjs", "harness/start.ps1", "harness/trial31/preload-guard.cjs", "harness/trial31/guard-core.cjs", "harness/trial31/redact31.cjs", "router/uw-router.next.cjs"]);
  const spec = buildSpec({ PATH: "x" });
  const text = renderPlan(spec, { router: "both" }).join("\n");
  for (const f of hashExecutedFiles()) {
    assert.match(f.raw, /^[0-9a-f]{64}$/, `${f.file} is present and hashed`);
    assert.ok(text.includes(`  ${f.file}  raw ${f.raw}  lf ${f.lf}`), `plan lacks the hashes of ${f.file}`);
  }
  // raw vs LF: CRLF bytes give a different raw hash and the SAME lf hash as the LF bytes
  const lf = Buffer.from("a\nb\n"), crlf = Buffer.from("a\r\nb\r\n");
  const h = (b) => hashExecutedFiles(() => b)[0];
  assert.notEqual(h(crlf).raw, h(lf).raw); assert.equal(h(crlf).lf, h(lf).lf); assert.equal(h(lf).raw, sha(lf)); assert.equal(hashExecutedFiles(() => null)[0].raw, "(absent)");
  // an edit to ANY of the executed files changes the plan hash (so the approval no longer matches)
  const base = planOf(spec, { router: "both" }).sha;
  for (const f of EXECUTED_FILES) assert.notEqual(planOf(spec, { router: "both", fileHashes: hashExecutedFiles(readWith(f)) }).sha, base, `an edit to ${path.basename(f)} must change the plan hash`);
  assert.equal(planOf(spec, { router: "both" }).sha, planOf(spec, { router: "both" }).sha, "deterministic");
  // the run prints them again at start
  const ok = await run(GO, {});
  for (const f of hashExecutedFiles()) assert.ok(ok.out.includes(`${f.file}  raw ${f.raw}  lf ${f.lf}`), `run output lacks ${f.file}`);
  // ... and a file that changes between the approved plan and the start (second hashing) refuses BEFORE anything starts
  const moved = await run(GO, { hashFilesAt: { 2: readWith(NEXT_ROUTER_SRC) } });
  assert.equal(moved.code, 1); assert.match(moved.err, /an executed file changed between the approved plan and the start: router\/uw-router\.next\.cjs/);
  assert.equal(moved.w.calls.runStep, 0); assert.equal(moved.w.started, false);
});

test("plan (H7): the system-proxy line keeps its backslashes, the protected roots are PRINTED (no '<27 protected roots; listed under side effects>' claim) and the operating notes name every hazard", () => {
  const text = renderPlan(buildSpec({ PATH: "x" }), { router: "both" }).join("\n");
  assert.ok(text.includes("HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings ProxyEnable"), "backslashes survive");
  assert.ok(!text.includes("HKCUSoftware"));
  assert.ok(!/listed under side effects/.test(text), "the false pointer is gone");
  const short = (r) => String(r).replace(REPO_ROOT, "<repo>").replace(os.homedir(), "~");
  for (const r of PROTECTED_ROOTS) assert.ok(text.includes(short(r)), `plan does not print the protected root ${short(r)}`);
  assert.match(text, new RegExp(`${PROTECTED_ROOTS.length} protected roots`));
  for (const need of ["IRREVERSIBLE", "config.sqlite", "WAL", "ONE-USE", "CLOSED terminal", "SIGHUP/SIGBREAK", "claude-code-router", "turns the process-table check RED", "uwpick, keysync and ccr commands must NOT run during G1",
    "core.autocrlf=true", "do NOT re-checkout between G1 and G2a", "stock harness/teardown.mjs must NOT be used", "no identity check", "deletes the whole scratch root", "OPERATING NOTES"]) assert.ok(text.includes(need), `plan lacks: ${need}`);
  assert.equal(OPERATING_NOTES.length, 9);
  assert.equal(renderPlan(buildSpec({ PATH: "x" }), { router: "both" }).join("\n"), text, "deterministic");
});

test("redaction (H5): bare key, AIza, Authorization Basic, array-valued api_key, Cookie and Set-Cookie values are masked; the PASS/FINDING/FAIL line format and the flow's own output are not over-redacted", async () => {
  const { redactSecrets } = require("../harness/trial31/redact31.cjs");
  const aiza = ["AI", "za", "SyA1B2C3D4E5F6G7H8I9J0K1L2"].join(""), b64 = Buffer.from(["user", "pass-1234"].join(":")).toString("base64"), secret = ["Zq9", "Xw8Vv7Uu6Tt5Ss4"].join("");
  const shapes = [
    [`{"key":"${secret}"}`, secret], [`GET /v1?key=${secret}&x=1`, secret], [`key: ${secret}`, secret], [`Authorization: Basic ${b64}`, b64], [`proxy-authorization: Basic ${b64}`, b64],
    [`"api_key":["${secret}","${secret}x"]`, secret], [`APIKEYS: ["${secret}"]`, secret], [`api_keys=${secret}`, secret], [`Cookie: sid=${secret}; other=1`, secret],
    [`Set-Cookie: sid=${secret}; Path=/; HttpOnly`, secret], [`url https://x.invalid/?q=1&key=${aiza}`, aiza], [aiza, aiza],
  ];
  for (const [text, leak] of shapes) { const out = redactSecrets(text); assert.ok(!out.includes(leak), `leaked from ${JSON.stringify(text)} -> ${out}`); assert.equal(redactSecrets(out), out, "idempotent"); }
  // not over-redacted: every PASS/FINDING/FAIL line the evaluators format, and ordinary words next to the new keywords
  const all = await run(GO, {});
  const lines = all.out.split("\n").filter((l) => parseLine(l));
  assert.ok(lines.length >= 10, `only ${lines.length} PASS/FINDING/FAIL lines`);
  for (const l of lines) assert.equal(redactSecrets(l), l, `over-redacted: ${l}`);
  for (const l of ["PASS [probe] E12 tokenCount=42 and content-length=900 reach the router", "FAIL [probe] A0 no API key whose id matches profile \"x\" (2 key entries, fields: id,key)", "FINDING [probe] E5 monkey=1 turnkey: yes", "FAIL [next] A8 counters.req=3, expected at least 6"]) assert.equal(redactSecrets(l), l, l);
  // the failure tail of a step (the `ccr start` tail) is redacted before it is printed, at the print site (a fake runner returns it raw)
  const tail = `ccr: Authorization: Bearer ${ASCII_KEY} key=${secret} Cookie: sid=${secret} ${aiza}`;
  const r = await run(GO, { stepFail: "start", stepTail: tail });
  assert.equal(r.code, 1); assert.match(r.err, /step start exited 1:/);
  for (const leak of [ASCII_KEY, secret, aiza]) assert.ok(!r.err.includes(leak) && !r.out.includes(leak), `the step tail leaked ${leak.slice(0, 5)}...`);
  const b = await run(GO, { stepFail: "bootstrap", stepTail: tail });
  for (const leak of [ASCII_KEY, secret, aiza]) assert.ok(!b.err.includes(leak) && !b.out.includes(leak), `the bootstrap tail leaked ${leak.slice(0, 5)}...`);
});

test("signals (H6): the handler keeps the evidence BEFORE the teardown deletes the logs; SIGINT, SIGTERM, SIGHUP and SIGBREAK are all handled and every one exits non-zero", async () => {
  const violations = `deny connect 8.8.8.8:443 ccr_web_token=${crypto.randomBytes(16).toString("hex")}\n`;
  const { w, d } = world({ signalAt: "start", violationsText: violations, ccrLog: "daemon line 1\ndaemon line 2" });
  const stop = d.sys.stopProcess;
  d.sys.stopProcess = (pid) => { w.mem.log.push(["stop", pid]); stop(pid); };
  seedApproval(w, GO);
  const code = await runE2e(GO, d);
  assert.equal(code, 1);
  const firstEvidence = w.mem.log.findIndex((x) => x[0] === "write" && norm(x[1]).startsWith(norm(EVIDENCE_ROOT) + path.sep));
  const firstStop = w.mem.log.findIndex((x) => x[0] === "stop");
  assert.ok(firstEvidence >= 0, "the evidence was written");
  assert.ok(firstStop >= 0 && firstEvidence < firstStop, `evidence (log #${firstEvidence}) must precede the first stop (log #${firstStop})`);
  const kept = [...w.mem.files.keys()].filter((k) => k.startsWith(norm(EVIDENCE_ROOT) + path.sep)).map((k) => path.basename(k)).sort();
  assert.deepEqual(kept, ["ccr-logs__daemon.out.log.txt", "guard-loaded.log.txt", "violations.log.txt"].sort(), "the scratch logs were copied out while they still existed");
  assert.deepEqual(w.calls.stopProcess, [5001, 5000], "the teardown ran once");
  // the real registration: all four signals, each a non-zero exit, the unregister function removes every listener
  assert.deepEqual(Object.keys(HANDLED_SIGNALS).sort(), ["SIGBREAK", "SIGHUP", "SIGINT", "SIGTERM"]);
  const exits = [], calls = [];
  const exit = mock.method(process, "exit", (c) => { exits.push(c); });
  const before = Object.keys(HANDLED_SIGNALS).map((s) => process.listenerCount(s));
  try {
    const unhook = realOnSignal(async (sig) => { calls.push(sig); });
    assert.deepEqual(Object.keys(HANDLED_SIGNALS).map((s) => process.listenerCount(s)), before.map((n) => n + 1));
    unhook();
    assert.deepEqual(Object.keys(HANDLED_SIGNALS).map((s) => process.listenerCount(s)), before, "unhook removed every listener");
    for (const sig of Object.keys(HANDLED_SIGNALS)) { const unh = realOnSignal(async (s) => { calls.push(s); }); process.emit(sig); await new Promise((r) => setTimeout(r, 20)); unh(); }
  } finally { exit.mock.restore(); }
  assert.deepEqual(calls.sort(), ["SIGBREAK", "SIGHUP", "SIGINT", "SIGTERM"]);
  assert.equal(exits.length, 4); assert.ok(exits.every((c) => Number.isInteger(c) && c > 0), `exit codes ${exits}`);
});

test("teardown (H8): descendants are stopped LEAF FIRST (grandchild before child before the daemon), whatever order the process table lists them in", async () => {
  const rows = [{ pid: 5000, ppid: 1 }, { pid: 5002, ppid: 5001 }, { pid: 5003, ppid: 5002 }, { pid: 5001, ppid: 5000 }, { pid: 5004, ppid: 5000 }, { pid: 9, ppid: 1 }];
  assert.deepEqual(descendantsLeafFirst(rows, 5000), [5003, 5002, 5001, 5004], "deepest first, then the shallower ones; unrelated pid 9 never");
  const grandRow = { pid: 5002, ppid: 5001, name: "node.exe", cmd: "node claude-code-router/dist/worker.js" };
  const { w, d } = world({});
  w.started = true; w.childAlive = true; w.gatewayUp = true;
  d.sys.processes = () => [{ pid: 100, ppid: 1, name: "node.exe", cmd: "node claude-code-router/cli.js serve" }, DAEMON_ROW, grandRow, CHILD_ROW];   // the grandchild is LISTED before its parent
  assert.equal(await runE2e(["--teardown"], d), 0, w.out.join("\n"));
  assert.deepEqual(w.calls.stopProcess, [5002, 5001, 5000], "grandchild, child, daemon");
});

test("keysync set (H10): a shadow.flag that cannot be removed prints one line saying the router stays in shadow; a removable flag prints none and is removed", () => {
  const run1 = (flagIsDir) => {
    const dir = mk();
    const h = spawnSync(process.execPath, [FIXTURE_FLAGS, "--dir", dir], { encoding: "utf8" });
    assert.equal(h.status, 0, h.stderr);
    const state = path.join(dir, "state", "subagent");
    fs.mkdirSync(state, { recursive: true });
    const flag = path.join(state, "shadow.flag");
    if (flagIsDir) { fs.mkdirSync(flag); fs.writeFileSync(path.join(flag, "x"), "x"); } else fs.writeFileSync(flag, "x");
    const home = mk();
    const r = spawnSync(process.execPath, [KEY_CLI, "subagent-policy", "set", "--source", "all-providers", "--mode", "dynamic", ...h.stdout.trim().split(" ")], { encoding: "utf8", timeout: 60000,
      env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, LOCALAPPDATA: home } });
    return { r, exists: fs.existsSync(flag) };
  };
  const stuck = run1(true);
  assert.equal(stuck.r.status, 0, stuck.r.stderr);
  const warn = stuck.r.stdout.split("\n").filter((l) => /shadow\.flag could not be removed/.test(l));
  assert.equal(warn.length, 1, `exactly one warning line: ${stuck.r.stdout}`);
  assert.match(warn[0], /^WARNING: .*shadow\.flag could not be removed \(\w+\): the router STAYS IN SHADOW/);
  assert.equal(stuck.exists, true);
  const fine = run1(false);
  assert.equal(fine.r.status, 0, fine.r.stderr);
  assert.ok(!/could not be removed/.test(fine.r.stdout + fine.r.stderr), "a removable flag prints no warning");
  assert.equal(fine.exists, false, "and is removed");
});

// ================================================================ fourth fix round (s0r3 J1-J12)
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const evOf = (w, d) => {                                           // an ordered call log over the slow seams of the fake world
  const ev = [];
  const wrap = (obj, name, label) => { const o = obj[name]; obj[name] = (...a) => { ev.push(`${label}${a[0] === undefined || typeof a[0] === "object" ? "" : `:${a[0]}`}`); return o(...a); }; };
  wrap(d.sys, "listenerPid", "listener"); wrap(d.sys, "processes", "processes"); wrap(d.sys, "stopProcess", "stop"); wrap(d.sys, "credSha", "credSha"); wrap(d.sys, "proxySha", "proxySha");
  const rpc0 = d.rpc; d.rpc = async (m, a) => { ev.push(`rpc:${m}`); return rpc0(m, a); };
  const stop0 = w.stub.stop; w.stub.stop = async () => { ev.push("stub.stop"); return stop0(); };
  const rm0 = d.fs.rmSync; d.fs.rmSync = (p, o) => { ev.push(`rm:${path.basename(p)}`); return rm0(p, o); };
  return ev;
};

test("teardown (J5): the daemon tree is stopped BEFORE the slow probes: only the identity checks (one process table, one probe per live port, the web-port holder) run first; no scrub rpc, no stub stop, no port loop, no removal; the scrub is only the fallback for a daemon that was NOT stopped", async () => {
  const { w, d } = world({}); w.started = true; w.childAlive = true; w.gatewayUp = true;
  const ev = evOf(w, d);
  assert.equal(await runE2e(["--teardown"], d), 0, w.out.join("\n"));
  const first = ev.findIndex((e) => e.startsWith("stop:"));
  assert.ok(first > 0);
  const before = ev.slice(0, first);
  assert.deepEqual(before.filter((e) => !e.startsWith("listener")), ["processes"], `only the process table precedes the stop: ${before.join(" ")}`);
  assert.ok(before.length <= 6, `at most 1 process table + 4 live ports + 1 web holder before the stop (memoised across pids): ${before.join(" ")}`);
  for (const slow of ["rpc:", "stub.stop", "rm:", "credSha", "proxySha"]) assert.ok(!before.some((e) => e.startsWith(slow)), `${slow} ran before the stop`);
  const after = ev.slice(first);
  assert.ok(after.some((e) => e.startsWith("rm:")), "the removal comes after the stop");
  assert.ok(!ev.some((e) => e.startsWith("rpc:")), "a daemon that was stopped is not scrubbed through the web RPC (it is gone; the scratch config is deleted)");
  // the main flow: stop, then the stub, then the sandbox-port check (the stub port included), then the removal
  const full = world({}); const ev3 = evOf(full.w, full.d);
  assert.equal((await go(full.w, full.d, GO)).code, 0);
  const iStop = ev3.findIndex((e) => e.startsWith("stop:")), iStub = ev3.indexOf("stub.stop"), iRm = ev3.findIndex((e, i) => i > iStub && e.startsWith("rm:") && e !== "rm:g1-approval.json");
  assert.ok(iStop > 0 && iStub > iStop && iRm > iStub, `stop (#${iStop}) < stub.stop (#${iStub}) < removal (#${iRm})`);
  assert.ok(ev3.slice(iStub, iRm).includes("listener:39459"), "the stub port is checked after the stub stopped and before the removal");
  assert.ok(!ev3.slice(0, iStop).some((e) => /^rm:(appdata|localappdata|spike|state|home|tmp)/.test(e)), "nothing sandbox-owned was removed before the stop");
  // the fallback: an UNVERIFIED daemon is not stopped, and only then is the provider scrubbed
  const un = world({}); un.w.started = true; un.w.childAlive = true; un.w.gatewayUp = true;
  un.d.sys.processes = () => [{ pid: 5000, ppid: 1, name: "node.exe", cmd: "chrome.exe --foo" }];
  const ev2 = evOf(un.w, un.d);
  assert.equal(await runE2e(["--teardown"], un.d), 1);
  assert.deepEqual(un.w.calls.stopProcess, []);
  assert.ok(ev2.includes("rpc:getConfig") && ev2.includes("rpc:saveConfig"), "the scrub is the fallback when the daemon was not stopped");
});

test("teardown (J5, B2 case it must not break): every identity refusal still refuses with the memoised live-port probes and the lazy holder probes (live port, no sandbox port, descendant on a live port); the clean case still stops the tree", async () => {
  const mkTd = (mut) => { const { w, d } = world({}); w.started = true; w.childAlive = true; w.gatewayUp = true; mut?.(w, d); return { w, d }; };
  const dc = "node claude-code-router/cli.js serve --daemon-child";
  const row = (pid, cmd) => ({ pid, ppid: 1, name: "node.exe", cmd });
  const probe = async (mut) => { const { w, d } = mkTd(mut); const code = await runE2e(["--teardown"], d); return { code, w, out: w.out.join("\n") }; };
  const ownerOf = (d, map) => { const orig = d.sys.listenerPid; d.sys.listenerPid = (p) => (p in map ? map[p] : orig(p)); };
  const a = await probe((w, d) => { d.resolveWebPort = () => ({ port: 39458, pid: 6200 }); d.sys.processes = () => [row(6200, dc)]; ownerOf(d, { 39458: 6200, 3457: 6200 }); });
  assert.equal(a.code, 1); assert.deepEqual(a.w.calls.stopProcess, []); assert.match(a.out, /it owns live port\(s\) 3457/);
  const b = await probe((w, d) => { d.resolveWebPort = () => ({ port: 39458, pid: 6300 }); d.sys.processes = () => [row(6300, dc)]; ownerOf(d, { 39458: 777, 39456: undefined, 39457: undefined }); });
  assert.equal(b.code, 1); assert.deepEqual(b.w.calls.stopProcess, []); assert.match(b.out, /holds neither the sandbox web port nor is the parent/);
  const c = await probe((w, d) => { ownerOf(d, { 3457: 5001 }); });
  assert.equal(c.code, 1); assert.deepEqual(c.w.calls.stopProcess, []); assert.match(c.out, /its descendant 5001: it owns live port\(s\) 3457/);
  const ok = await probe();
  assert.equal(ok.code, 0); assert.deepEqual(ok.w.calls.stopProcess, [5001, 5000]);
});

test("signals (J3): realOnSignal uses process.on (still hooked after the first signal), runs fn once, answers a signal during it with 'teardown in progress, wait' and does NOT exit, exits once with the FIRST signal's code, and unhook removes every listener", async () => {
  const names = Object.keys(HANDLED_SIGNALS), before = names.map((n) => process.listenerCount(n));
  const exits = [], said = [], calls = [];
  let release; const gate = new Promise((r) => { release = r; });
  const unhook = realOnSignal(async (sig) => { calls.push(sig); await gate; }, { exit: (c) => exits.push(c), say: (m) => said.push(m) });
  process.emit("SIGHUP");
  assert.equal(process.listenerCount("SIGHUP"), before[names.indexOf("SIGHUP")] + 1, "a first signal does not unregister the handler (process.once would have)");
  process.emit("SIGHUP"); process.emit("SIGBREAK"); process.emit("SIGINT");
  await tick();
  assert.deepEqual(calls, ["SIGHUP"], "fn ran once");
  assert.equal(said.length, 3); assert.ok(said.every((m) => /teardown in progress, wait/.test(m)), said.join("|"));
  assert.deepEqual(exits, [], "no exit while the teardown runs");
  release(); await tick();
  assert.deepEqual(exits, [129], "one exit, with the first signal's code");
  unhook();
  assert.deepEqual(names.map((n) => process.listenerCount(n)), before, "unhook removed every listener");
});

test("signals (J3, J4): a signal during the MAIN-FLOW teardown waits for that same teardown (memoised promise, handler hooked until it completed): two signals make ONE teardown and ONE exit, after the teardown finished", async () => {
  const { w, d } = world({});
  const exits = [], said = [], before = process.listenerCount("SIGINT"); let during = -1;
  d.onSignal = (fn) => realOnSignal(fn, { exit: (c) => { w.mem.log.push(["exit", c]); exits.push(c); }, say: (m) => said.push(m) });
  const stop = d.sys.stopProcess;
  d.sys.stopProcess = (pid) => { stop(pid); if (pid === 5000) { during = process.listenerCount("SIGINT"); process.emit("SIGINT"); process.emit("SIGTERM"); } };   // two signals in the middle of the teardown at the end of the run
  w.stub.stop = async () => { await tick(30); w.stubUp = false; };                                                                                        // the teardown has more to do after the stop
  seedApproval(w, GO);
  await runE2e(GO, d);
  await tick(50);
  assert.equal(during, before + 1, "the handler was still hooked while the main-flow teardown ran");
  assert.deepEqual(w.calls.stopProcess, [5001, 5000], "ONE teardown");
  assert.deepEqual(exits, [130], "ONE exit, the first signal's code");
  assert.equal(said.filter((m) => /SIGTERM: teardown in progress, wait/.test(m)).length, 1);
  const lastRm = w.mem.log.map((x, i) => (x[0] === "rm" && norm(x[1]).startsWith(norm(SCRATCH_ROOT)) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const exitAt = w.mem.log.findIndex((x) => x[0] === "exit");
  assert.ok(lastRm >= 0 && exitAt > lastRm, `the exit (log #${exitAt}) came after the LAST sandbox removal (log #${lastRm}): the teardown was not cut off`);
  assert.equal(process.listenerCount("SIGINT"), before, "unhooked after the teardown");
});

test("run (J8): the tripwire is asserted again AFTER the teardown (main flow and signal path); a write to live state that appears only then fails the run", async () => {
  const ok = await run(GO, {});
  assert.equal(ok.code, 0, ok.err + ok.out);
  assert.equal(ok.w.tripStages.at(-1), "e2e:after-teardown"); assert.equal(ok.w.tripTorn["e2e:after-teardown"], true, "asserted after the stop");
  const bad = await run(GO, { tripwireAt: "e2e:after-teardown" });
  assert.equal(bad.code, 1); assert.match(bad.err, /FAILED: ISOLATION VIOLATION: e2e:after-teardown/);
  const sig = await run(GO, { signalAt: "start", tripwireAt: "e2e:after-teardown" });
  assert.match(sig.err, /after the teardown \(signal path\): ISOLATION VIOLATION: e2e:after-teardown/);
});

test("run (J6): the router bytes are compared with the APPROVED hash at the point of use: a router that differs from the approved plan refuses BEFORE any copy; a helper changed before the bootstrap step refuses before that step runs", async () => {
  for (const [name, src, flag] of [["harness/probe-router.cjs", PROBE_ROUTER_SRC, "probe"], ["router/uw-router.next.cjs", NEXT_ROUTER_SRC, "next"]]) {
    const a = world({});
    const real = a.w.mem.readFileSync;
    a.w.mem.readFileSync = (p, enc) => (norm(p) === norm(src) ? Buffer.concat([real(p), Buffer.from("\n// edited after the approved re-hash\n")]) : real(p, enc));   // the file the plan hashed is the real one; the copy would read edited bytes consistently
    const r = await go(a.w, a.d, [...GO, "--router", flag]);
    assert.equal(r.code, 1, name); assert.ok(r.err.includes(`${name} changed since the approved plan`), r.err); assert.equal(r.w.calls.fetch, 0);
    assert.ok(!r.w.mem.log.some((x) => x[0] === "write" && /uw-router\.cjs/.test(x[1])), "nothing was copied into scratch");
  }
  const bootstrapEdited = await run(GO, { hashFilesAt: { 3: readWith(BOOTSTRAP_LIVE_SAFE) } });
  assert.equal(bootstrapEdited.code, 1); assert.match(bootstrapEdited.err, /an executed file changed after the run started, before step bootstrap: harness\/bootstrap-live-safe\.mjs/);
  assert.equal(bootstrapEdited.w.calls.runStep, 1, "start ran, bootstrap did not"); assert.deepEqual(bootstrapEdited.w.calls.stopProcess, [5001, 5000], "and the started daemon was torn down");
  const fine = await run(GO, {});
  assert.equal(fine.code, 0, fine.err); assert.equal(fine.w.calls.hashFiles, 3, "plan, start re-hash, before-bootstrap re-hash");
});

test("approval (J12): two runs that both read a valid approval before either consumed it: ONE wins (atomic rename to a unique used name), the other exits 2 and starts nothing; the renamed file must be the one that was checked", async () => {
  const a = world({}), b = world({});
  b.d.fs = a.d.fs; b.w.mem = a.w.mem;                                // one shared file system
  seedApproval(a.w, GO);
  const snapshot = String(a.w.mem.files.get(norm(APPROVAL_FILE)));
  const readB = b.d.sys.readText;
  b.d.sys.readText = (p) => (norm(p) === norm(APPROVAL_FILE) ? snapshot : readB(p));   // B read the approval before A renamed it (the race window)
  const [ra, rb] = await Promise.all([runE2e(GO, a.d), runE2e(GO, b.d)]);
  assert.equal(ra, 0, a.w.err.join("\n")); assert.equal(rb, 2, "the loser is refused");
  assert.match(b.w.err.join("\n"), /the approval file could not be consumed/); assert.equal(b.w.calls.runStep, 0); assert.equal(b.w.calls.fetch, 0);
  assert.equal(a.w.mem.files.has(norm(APPROVAL_FILE)), false);
  assert.equal([...a.w.mem.files.keys()].filter((k) => /g1-approval\.used-/.test(k)).length, 0, "the winner removed the used file");
  // the used name is unique per pid and time, lives next to the approval file, and is writable only through safeEvidencePath
  assert.ok(isApprovalUsedFile(approvalUsedFile(123, 456))); assert.ok(!isApprovalUsedFile(path.join(os.tmpdir(), "g1-approval.used-1-2")));
  assert.equal(safeEvidencePath(approvalUsedFile(123, 456)), approvalUsedFile(123, 456));
  assert.throws(() => safeEvidencePath(path.join(HARNESS_DIR, "g1-approval.used-abc")), RefusalError);
  // the file renamed away is NOT the one that was checked (replaced in the window): refused, nothing starts
  const c = world({});
  seedApproval(c.w, GO);
  const ren = c.w.mem.renameSync;
  c.w.mem.renameSync = (x, y) => { c.w.mem.files.set(norm(x), JSON.stringify({ schema: 1, planSha256: "f".repeat(64), approvedAt: new Date(c.w.nowMs()).toISOString() })); ren(x, y); };
  assert.equal(await runE2e(GO, c.d), 2); assert.match(c.w.err.join("\n"), /is not the file that was checked/); assert.equal(c.w.calls.runStep, 0);
});

test("redaction (J9): URL userinfo is masked (user:pass@, token@), idempotently, without touching ordinary URLs or PASS/FAIL lines; the FAILED line, the refusal text and the teardown notes are redacted at their print site", async () => {
  const { redactSecrets } = require("../harness/trial31/redact31.cjs");
  const pw = ["Pw9", "Zq8Xv7Ww6"].join(""), tok = ["Tk4", "Lm3Nn2Pp1Qq"].join("");
  for (const [text, leak] of [[`see https://bob:${pw}@example.invalid/x?y=1`, pw], [`git ssh://${tok}@host.invalid/r`, tok], [`a http://u:${pw}@h.invalid and http://${tok}@z.invalid`, pw]]) {
    const out = redactSecrets(text); assert.ok(!out.includes(leak), out); assert.equal(redactSecrets(out), out, "idempotent");
  }
  for (const keep of ["http://127.0.0.1:3456/v1/messages", "PASS [probe] A0 mail a@b.invalid is not a URL", "https://example.invalid/a@b"]) assert.equal(redactSecrets(keep), keep, keep);
  const secret = `Authorization: Bearer ${ASCII_KEY} https://u:${pw}@host.invalid key=${tok}`;
  const leaks = [ASCII_KEY, pw, tok];
  // FAILED line: an exception out of the flow (here an RPC error text) is masked before it is cut to 300 characters
  const f = world({});
  const rpc0 = f.d.rpc; f.d.rpc = async (m, a) => { if (m === "getConfig" && f.w.started) throw new Error(`getConfig failed: ${secret}`); return rpc0(m, a); };
  const r = await go(f.w, f.d, GO);
  assert.equal(r.code, 1); assert.match(r.err, /FAILED: getConfig failed:/);
  for (const l of leaks) assert.ok(!r.err.includes(l) && !r.out.includes(l), `the FAILED line leaked ${l.slice(0, 4)}...`);
  // a refusal message (RefusalError text) goes through the redactor too
  const g = world({ stepFail: "start", stepTail: secret });
  const r2 = await go(g.w, g.d, GO);
  for (const l of leaks) assert.ok(!r2.err.includes(l) && !r2.out.includes(l), `the refusal leaked ${l.slice(0, 4)}...`);
  // teardown notes: the scrub fallback prints the RPC error text, masked (an unverified daemon is not stopped, so the scrub runs)
  const t = world({}); t.w.started = true; t.w.childAlive = true; t.w.gatewayUp = true;
  t.d.sys.processes = () => [{ pid: 5000, ppid: 1, name: "node.exe", cmd: "chrome.exe" }];
  t.d.rpc = async () => { throw new Error(`getConfig failed: ${secret}`); };
  assert.equal(await runE2e(["--teardown"], t.d), 1);
  assert.match(t.w.out.join("\n"), /teardown: scrub skipped: getConfig failed:/);
  for (const l of leaks) assert.ok(!t.w.out.join("\n").includes(l), `the teardown note leaked ${l.slice(0, 4)}...`);
});

test("plan (J10): the plan prints ccr.cmd, the CCR package version and the sha256 of dist/main/cli.js; resolution is read-only and deterministic; NOT FOUND is printed and the run AND --approve-plan refuse; a CCR change after the plan voids the approval or refuses the start", async () => {
  const root = mk(), nodejs = path.join(root, "nodejs"), pkgDir = path.join(nodejs, "node_modules", "@fake", "claude-code-router"), cli = path.join(pkgDir, "dist", "main", "cli.js");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  const shim = '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@fake\\claude-code-router\\dist\\main\\cli.js" %*\r\n';
  fs.writeFileSync(path.join(nodejs, "ccr.cmd"), shim); fs.writeFileSync(path.join(nodejs, "ccr"), "#!/bin/sh\n"); fs.writeFileSync(cli, "// cli v1\n"); fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@fake/claude-code-router", version: "9.9.9" }));
  const env = { PATH: [path.join(root, "empty"), nodejs, "C:\\elsewhere"].join(path.delimiter) };
  const r1 = resolveCcrInstall({ env });
  assert.equal(r1.found, true, JSON.stringify(r1)); assert.equal(r1.version, "9.9.9"); assert.equal(r1.cmd, path.join(nodejs, "ccr.cmd")); assert.equal(r1.cli, cli);
  assert.equal(r1.cliSha, sha("// cli v1\n")); assert.equal(r1.cmdSha, sha(shim));
  assert.deepEqual(resolveCcrInstall({ env }), r1, "deterministic");
  const txt = ccrInstallLines(r1).join("\n");
  for (const need of [r1.cmd, "9.9.9", "@fake/claude-code-router", r1.cliSha, r1.cmdSha, cli]) assert.ok(txt.includes(need), `plan line lacks ${need}`);
  // a CCR update (or a different ccr) changes the plan text and so its hash
  const spec = buildSpec({ PATH: "x" });
  const h1 = planOf(spec, { router: "both", ccr: r1 }).sha;
  fs.writeFileSync(cli, "// cli v2\n"); const r2 = resolveCcrInstall({ env });
  assert.notEqual(planOf(spec, { router: "both", ccr: r2 }).sha, h1, "a changed cli.js changes the plan hash");
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@fake/claude-code-router", version: "9.9.10" }));
  assert.notEqual(planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha, planOf(spec, { router: "both", ccr: r2 }).sha, "a changed version changes the plan hash");
  assert.ok(renderPlan(spec, { router: "both", ccr: r1 }).join("\n").includes(r1.cliSha), "renderPlan prints it in the EXECUTED FILES section");
  // not found / refused shapes
  fs.mkdirSync(path.join(root, "other")); fs.writeFileSync(path.join(root, "other", "ccr.ps1"), "x");
  for (const [why, e] of [["empty PATH", { PATH: "" }], ["no ccr on PATH", { PATH: root }], ["another launcher first", { PATH: [path.join(root, "other"), nodejs].join(path.delimiter) }]]) {
    const nf = resolveCcrInstall({ env: e }); assert.equal(nf.found, false, why);
    assert.match(ccrInstallLines(nf).join("\n"), /CCR install: NOT FOUND \(/, why);
  }
  fs.writeFileSync(path.join(nodejs, "ccr.cmd"), "@echo off\r\nnode something-else\r\n"); assert.equal(resolveCcrInstall({ env }).found, false, "a shim that names no cli.js");
  // the run and --approve-plan refuse a NOT FOUND install; nothing starts and the approval is not consumed
  const miss = await run(GO, { ccrMissing: true });
  assert.equal(miss.code, 1); assert.match(miss.err, /the installed CCR was NOT FOUND/); assert.equal(miss.w.calls.runStep, 0); assert.equal(miss.w.mem.files.has(norm(APPROVAL_FILE)), true, "not consumed");
  const ap = world({ ccrMissing: true }); assert.equal(await runE2e(["--approve-plan"], ap.d), 1); assert.match(ap.w.err.join("\n"), /NOT FOUND/); assert.equal(ap.w.mem.files.has(norm(APPROVAL_FILE)), false);
  const planOut = []; await runE2e(["--plan"], { ...world({ ccrMissing: true }).d, out: (x) => planOut.push(x) });
  assert.match(planOut.join("\n"), /CCR install: NOT FOUND/, "--plan still prints (and hashes) the NOT FOUND text");
  // a CCR that changes between the approved plan and the start refuses before anything starts
  const moved = await run(GO, { ccrAt: 1 });
  assert.equal(moved.code, 1); assert.match(moved.err, /the installed CCR .* changed between the approved plan and the start/); assert.equal(moved.w.calls.runStep, 0);
  // --plan reads the executed files and the CCR install, nothing else
  const boom = (n) => () => { throw new Error(`--plan touched ${n}`); };
  const out = []; let seen = 0;
  assert.equal(await runE2e(["--plan"], { fs: new Proxy({}, { get: (_, k) => boom(`fs.${String(k)}`) }), sys: new Proxy({}, { get: (_, k) => boom(`sys.${String(k)}`) }), rpc: boom("rpc"), runStep: boom("runStep"), fetch: boom("fetch"), env: { PATH: "x" }, hashFiles: () => hashExecutedFiles(), ccrInstall: () => { seen++; return CCR_FAKE; }, out: (s) => out.push(s), err: (s) => out.push(s) }), 0);
  assert.equal(seen, 1); assert.ok(out.join("\n").includes(CCR_FAKE.cliSha));
});

test("credentials (J7): only the LLMKEY:* target lines of `cmdkey /list` are hashed, so another application's credential never changes the fingerprint; an LLMKEY target added or removed does", () => {
  const base = "Currently stored credentials:\n\n    Target: LegacyGeneric:target=LLMKEY:alpha\n    Type: Generic\n    User: u\n\n    Target: LegacyGeneric:target=LLMKEY:beta\n    Type: Generic\n";
  const other = base + "\n    Target: LegacyGeneric:target=SomeOtherApp:token\n    Type: Generic\n    Target: MicrosoftAccount:user=x@y.invalid\n";
  assert.equal(llmkeyTargetLines(other), llmkeyTargetLines(base), "another application's credential is not part of the fingerprint");
  assert.equal(llmkeyTargetLines(base).split("\n").length, 2);
  assert.notEqual(llmkeyTargetLines(base + "    Target: LegacyGeneric:target=LLMKEY:gamma\n"), llmkeyTargetLines(base), "a new LLMKEY target changes it");
  assert.notEqual(llmkeyTargetLines(base.replace("LLMKEY:beta", "LLMKEY:betb")), llmkeyTargetLines(base), "a renamed target changes it");
  assert.equal(llmkeyTargetLines(""), ""); assert.equal(llmkeyTargetLines(undefined), "");
  assert.ok(!/target-name hash only/.test(CANNOT_VERIFY.join("\n")) && /LLMKEY:\* targets only/.test(CANNOT_VERIFY.join("\n")), "the cannot-verify list says what the hash covers");
});

test("text (J1, J2, J5, J7, J11, J12): the plan, the operating notes and --help say what is built: tripwire scope and what it no longer covers, the false-RED list, honest closed-terminal wording, mandatory --experiments-only, evidence retention, A11 on both routers, signal exit codes, the web RPC port, the profile and key, the approval's limits, the stub's records", () => {
  const plan = renderPlan(buildSpec({ PATH: "x" }), { router: "both" }).join("\n");
  const help = USAGE.join("\n");
  const has = (text, re, why) => assert.match(text, re, why);
  // J1/J2: no false claim, and the plan states the scope and what is no longer covered
  has(plan, /fingerprints ONLY the configLibrary folder: the NAME of every entry and the sha256 of the CONTENT of every \*\.json/, "claude-3p side effect");
  has(plan, /NO LONGER covered by the tripwire.*config\.json.*claude_desktop_config\.json.*other Claude-3p files edited in place.*top-level or nested names.*model-catalog/s);
  has(plan, /preload guard.*LOCALAPPDATA redirect.*assertDesktopSyncLandedInScratch/s);
  assert.ok(!/content-hashes claude_desktop_config\.json and config\.json/.test(plan), "the false claim is gone");
  // J5: honest closed-terminal wording and the order
  has(plan, /usually leaves time to stop the daemon but this is NOT guaranteed/); has(plan, /run `node harness\/subagent-e2e\.mjs --teardown` before anything else/);
  assert.ok(!/the handler then keeps the evidence and runs the identity-verified teardown\); after a killed/.test(plan), "the old note text is gone");
  has(plan, /ORDER: the daemon tree is stopped FIRST/);
  // J7: every named false-RED cause
  for (const need of ["settings.json or settings.local.json", "/config, /model, /theme, a plugin change", "'always allow'", "~/Downloads", "user PATH by an installer", "bench, refresh, keysync or uwpick run", "catalog/", "LLMKEY:", "claude-code-router", "Claude desktop restart"]) assert.ok(plan.includes(need), `the false-RED note lacks: ${need}`);
  // J11
  has(plan, /MANDATORY: a run without --experiments-only exits 2/); has(help, /--experiments-only  MANDATORY: a run without it exits 2/);
  has(plan, /retained ONLY when the run is refused or throws, on a signal, or when violations\.log is non-empty/);
  has(help, /A11 \(live gateway untouched\) is evaluated after EACH router run, on both routers/);
  has(help, /129 SIGHUP, 130 SIGINT, 143 SIGTERM, 149 SIGBREAK/);
  has(plan, /set through the web RPC port 39458 \(not the core port 39457\) and asserted after the save/);
  has(plan, /the script does NOT create a profile; it ADDS ONLY a sandbox-config API key entry for it when missing \(ensureProfileKey, id profile:<mLe of the profile id>, key generated at run time and never printed\) through this same sandbox-only save, never touching live files.*FAIL A0 before any request and a teardown.*approval is already consumed.*fresh --approve-plan/s);
  has(plan, /\[record\] sandbox-profile-key: an API key entry for the enabled claude-code profile, ADDED to the SANDBOX config when missing/);
  assert.ok(!/the script does NOT create a profile or a key/.test(plan), "the old claim is gone");
  has(plan, /it records per request the model, content-length, body byte length and sha256, the tool NAMES, the Agent tool description and the whitelisted headers \(anthropic-beta/);
  assert.ok(!/ONLY model/.test(plan + help));
  has(plan, /it reads only the files hashed under EXECUTED FILES and the installed CCR it prints there/);
  const src = fs.readFileSync(path.join(HARNESS_DIR, "subagent-e2e.mjs"), "utf8");
  assert.ok(!/no I\/O at all/.test(src), "no 'no I/O' claim in the source");
  // J12: the approval's limits are stated plainly in --help
  has(help, /WHAT THE APPROVAL PROVES: the plan text and the bytes of every executed file are unchanged since the hash was typed, and it blocks an accidental or scripted run\. It does NOT prove a human acted/);
  has(help, /atomic rename \(exactly one of two racing runs wins it\)/);
  // the claims of the redaction comment are true: every free-text print site of the run goes through the redactor
  assert.ok(!/redacted at the source AND again at every print site/.test(src), "the false 'every print site' comment is gone");
  assert.ok(!/oneLine\((failure|e)\.message/.test(src), "no print site passes an exception message through oneLine alone");
});

// ================================================================ ROUTER V2 UPDATE: the revision 10 experiments (X1-X9, H1), the probe modes, the stub scripting, X6, the plan text
const kindOf = (out, id, router) => parseLine(out.split("\n").find((l) => parseLine(l)?.id === id && (!router || parseLine(l).router === router)) ?? "")?.kind;
const lineOf = (out, id, router) => out.split("\n").find((l) => parseLine(l)?.id === id && (!router || parseLine(l).router === router));

test("flow (T4, T6): ALL GREEN world: every new experiment has its line, X7 and the exact-bytes checks PASS, the informational ones PASS on a conforming gateway, Router.fallback and the Providers edit are restored, and the not-run lines are printed", async () => {
  const r = await run(GO, {});
  assert.equal(r.code, 0, r.err + r.out);
  const ids = ["X1", "X2", "X3", "X4", "X5", "X7", "X8", "X9a", "X9b", "X9c", "X9d", "X9e"];
  for (const id of ids) assert.equal(kindOf(r.out, id, "probe"), "PASS", `${id}: ${lineOf(r.out, id, "probe")}`);
  assert.equal(kindOf(r.out, "H1", "next"), "PASS", lineOf(r.out, "H1", "next"));
  for (const id of ["A0", "A1", "A2", "A8", "A11"]) assert.equal(kindOf(r.out, id, "next"), "PASS", `${id}: ${lineOf(r.out, id, "next")}`);
  assert.match(lineOf(r.out, "A2", "next"), /agents\.jsonl carries the same would\/ret/);
  assert.match(lineOf(r.out, "A8", "next"), /1 status-<w>\.json file next to status\.json.*__uwRouterImpl holds 1 key \(the router file\) in pid 5000/);
  assert.equal(r.out.split("\n").filter((l) => /^(PASS|FINDING|FAIL) \[/.test(l) && !parseLine(l)).length, 0, "every result line parses");
  for (const n of NOT_RUN) assert.ok(r.out.includes(n), `the run prints: ${n.slice(0, 40)}`);
  assert.equal(r.w.cfg.Router?.fallback?.mode ?? "off", "off", "Router.fallback is back to off at the end");
  assert.deepEqual(r.w.cfg.Router?.fallback?.models ?? [], []);
  assert.deepEqual(r.w.cfg.Providers[0].models, ["m-main", "m-free", "m-big"], "the X1 edit was undone");
  const swaps = r.w.fbSeen.filter((m) => m !== null && m !== undefined);
  assert.deepEqual(swaps.slice(-4), ["off", "model-chain", "retry", "off"], `the swaps in order, ending with the restore: ${swaps.join(",")}`);
  assert.ok(r.w.tripStages.includes("e2e:after-x9-model-chain") && r.w.tripStages.includes("e2e:after-x9-restore") && r.w.tripStages.includes("e2e:after-x1-edit"), "the tripwire runs after every hot edit");
  assert.ok(r.w.calls.assertRouterClean >= 3, "the restore is read back through assertRouterClean");
  assert.ok(r.w.mem.files.has(norm(path.join(SCRATCH_STATE_DIR, "agents.jsonl"))) === false, "the teardown removed the state directory");
});

const AT = { len: 25, at: true, ok: true, form: "a-a@a-a9a9a" };
const cl = (o = {}) => ({ n: 7, m: 1, pid: 9, t: "2026-10-05T00:00:00.000Z", cfg: { first: false, same: true, provSame: true, provN: 1, fp: "aaaaaaaaaaaa" }, hdr: { aid: AT, par: AT, sid: { len: 6, at: false, ok: true, form: "a-9" }, retry: null }, ml: 1, lh: "bbbbbbbbbbbb", ...o });
const x9ev = (over = {}) => {
  const attempts = (mode, id) => (mode === "off" ? 1 : mode === "model-chain" ? 2 : id === "400" || id === "413" ? 1 : 2);
  const cases = X9_MODES.flatMap((mode) => X9_CASES.map((cs) => ({ mode, id: cs.id, status: mode === "off" || attempts(mode, cs.id) === 1 ? cs.step.status : 200, headers: mode === "off" && cs.step.retryAfter ? { "retry-after": String(cs.step.retryAfter) } : {}, ms: 1000, attempts: attempts(mode, cs.id), models: ["uwstub/m-big"], routerCalls: 1 })));
  return { gw: { before: 5000, after: 5000 }, cases, main: { mode: "model-chain", id: "main", status: 200, headers: {}, ms: 1000, attempts: 2, models: [], routerCalls: 1 }, ...over };
};

test("evaluators (T4) X1: PASS on a new Providers array, FINDING when it is mutated in place, not visible, edited under it, served by two processes or unmeasured; never PASS on missing evidence", () => {
  const ok = { l1: cl(), l2: cl(), l3: cl({ cfg: { first: false, same: true, provSame: false, provN: 2, fp: "cccccccccccc" } }), edit: { ok: true, gwBefore: 5000, gwAfter: 5000 } };
  assert.match(evalX1(ok), /^PASS \[probe\] X1 an edit gives a NEW Providers array.*across the edit: config same object, Providers NEW object, fingerprint changed, 1 -> 2 providers; gateway pid unchanged \(5000\)/);
  assert.match(evalX1({ ...ok, l3: cl({ cfg: { first: false, same: true, provSame: true, provN: 2, fp: "cccccccccccc" } }) }), /^FINDING \[probe\] X1 Providers is the SAME array after an edit \(mutated in place\)/);
  assert.match(evalX1({ ...ok, l3: cl({ cfg: { first: false, same: true, provSame: false, provN: 1, fp: "aaaaaaaaaaaa" } }) }), /^FINDING \[probe\] X1 the Providers edit is not visible at the router/);
  assert.match(evalX1({ ...ok, l3: cl({ pid: 10, cfg: ok.l3.cfg }) }), /^FINDING \[probe\] X1 unmeasured: the three calls were served by 2 processes/);
  assert.match(evalX1({ ...ok, edit: { ok: false, why: "saveConfig failed: boom" } }), /^FINDING \[probe\] X1 unmeasured: the Providers edit .* did not complete \(saveConfig failed: boom\)/);
  assert.match(evalX1({ ...ok, edit: { ok: true, gwBefore: 5000, gwAfter: 5001 } }), /gateway pid CHANGED 5000 -> 5001: the edit restarted it/);
  for (const bad of [undefined, {}, { l1: cl(), l2: cl() }, { l1: {}, l2: {}, l3: {} }]) assert.match(evalX1(bad), /^FINDING \[probe\] X1 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X2: counts the distinct pids, says what one worker means, and an empty or short record is unmeasured", () => {
  const ln = (...pids) => pids.map((pid) => cl({ pid }));
  assert.match(evalX2({ sent: 12, lines: ln(...Array(12).fill(5)) }), /^PASS \[probe\] X2 12 concurrent requests were served by 1 distinct process \(pids 5\); ONE worker: the cross-worker paths .* cannot be exercised live/);
  assert.match(evalX2({ sent: 12, lines: ln(...[1, 2, 3].flatMap((p) => Array(4).fill(p))) }), /^PASS \[probe\] X2 12 concurrent requests were served by 3 distinct processes \(pids 1,2,3\); several workers/);
  for (const bad of [undefined, { sent: 12, lines: [] }, { sent: 12, lines: ln(1, 2) }, { sent: 0, lines: ln(1) }]) assert.match(evalX2(bad), /^FINDING \[probe\] X2 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X3: PASS only when the header reaches the router on the retry and CCR makes ONE attempt per inbound request; says what it does not claim; unmeasured otherwise", () => {
  const step = (sent, status, routerRetry, upstream = 1, headers = {}) => ({ sent, status, headers, routerRetry, upstream, upRetry: null });
  const good = { cases: [{ name: "429", steps: [step(0, 429, "0", 1, { "retry-after": "5" }), step(1, 200, "1")] }, { name: "503", steps: [step(0, 503, "0"), step(1, 200, "1")] }] };
  const p = evalX3(good);
  assert.match(p, /^PASS \[probe\] X3 429: router saw retry-count 0,1, upstream attempts 1,1, client saw 429,200 retry-after 5; 503: router saw retry-count 0,1/);
  assert.match(p, /CCR fallback off by default \(1 attempt per request\) \(whether Claude Code itself retries is NOT claimed: 6\.1c binary analysis; the real client is S2d\)/);
  const absent = evalX3({ cases: [{ name: "429", steps: [step(0, 429, null), step(1, 200, null)] }] });
  assert.match(absent, /^FINDING \[probe\] X3 429: the retry-count header did NOT reach the router on the retried request, so len is the only retry signal/);
  assert.match(absent, /router saw retry-count absent,absent/);
  assert.match(evalX3({ cases: [{ name: "503", steps: [step(0, 200, "0", 2), step(1, 200, "1")] }] }), /^FINDING \[probe\] X3 503: CCR made 2\/1 upstream attempts per inbound request with Router\.fallback off: its own fallback is NOT off by default/);
  for (const bad of [undefined, { cases: [] }, { cases: [{ name: "429", steps: [step(0, 429, "0")] }] }, { cases: [{ name: "429", steps: [step(0, 429, undefined), step(1, 200, undefined)] }] }]) assert.match(evalX3(bad), /^FINDING \[probe\] X3 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X4: team ids with an @ pass through in shape; a lost @, a rejected charset, a changed length or a missing parent or session id is a FINDING (with the charset cure); unmeasured without a header record", () => {
  const ok = { probe: cl(), stubRec: { headers: { "x-claude-code-agent-id": "x" } }, sent: { agentId: "ccr-logs@session-f49cde2f" } };
  assert.match(evalX4(ok), /^PASS \[probe\] X4 team ids pass through to the router unchanged in shape: agent id present \(25 characters, form a-a@a-a9a9a, charset ok\); parent id present \(25 characters.*session id present; forwarded upstream/);
  assert.match(evalX4({ ...ok, stubRec: { headers: {} } }), /not forwarded upstream/);
  assert.match(evalX4({ ...ok, probe: cl({ hdr: { ...cl().hdr, aid: { ...AT, at: false } } }) }), /^FINDING \[probe\] X4 the team agent id lost its @ part/);
  assert.match(evalX4({ ...ok, probe: cl({ hdr: { ...cl().hdr, aid: { ...AT, ok: false, form: "a a" } } }) }), /FAILS \^\[A-Za-z0-9_@\.:-\]\{1,128\}\$: widen the charset BEFORE G2/);
  assert.match(evalX4({ ...ok, probe: cl({ hdr: { ...cl().hdr, aid: { ...AT, len: 9 } } }) }), /the agent id changed in transit \(25 characters sent, 9 seen\)/);
  assert.match(evalX4({ ...ok, probe: cl({ hdr: { ...cl().hdr, par: null, sid: null } }) }), /parent-agent-id is absent.*session-id is absent/);
  assert.match(evalX4({ ...ok, probe: cl({ hdr: { ...cl().hdr, aid: null } }) }), /^FINDING \[probe\] X4 x-claude-code-agent-id did not reach the router/);
  for (const bad of [undefined, {}, { probe: {} }]) assert.match(evalX4(bad), /^FINDING \[probe\] X4 unmeasured/);
});

test("evaluators (T4) X5: PASS when the router sees 1,3,5,5,3 and only the retry repeats a length; FINDING when the length is altered, the retry body differs or another turn repeats; unmeasured on a short record", () => {
  const mkl = (lens, lhs) => lens.map((ml, i) => cl({ ml, lh: lhs?.[i] ?? `h${ml}${i}`.padEnd(12, "0") }));
  const same = ["a", "b", "c", "c", "d"].map((x) => x.repeat(12));
  assert.match(evalX5({ sent: X5_LENGTHS, lines: mkl(X5_LENGTHS, same) }), /^PASS \[probe\] X5 the router sees 1,3,5,5,3: only the repeated 5 equals the previous length \(the len retry signal fires once, on the retry, last-message hash identical\); growth by 2 and the compaction drop to 3 do not fire it/);
  assert.match(evalX5({ sent: X5_LENGTHS, lines: mkl([1, 3, 5, 7, 3], same) }), /^FINDING \[probe\] X5 the router sees messages\.length 1,3,5,7,3 but 1,3,5,5,3 were sent: CCR changes the length on the way/);
  assert.match(evalX5({ sent: X5_LENGTHS, lines: mkl(X5_LENGTHS, ["a", "b", "c", "x", "d"].map((x) => x.repeat(12))) }), /^FINDING \[probe\] X5 the retried body's last message differs from the first attempt's/);
  assert.match(evalX5({ sent: [1, 3, 3, 5, 5], lines: mkl([1, 3, 3, 5, 5], ["a", "b", "b", "c", "c"].map((x) => x.repeat(12))) }), /^FINDING \[probe\] X5 the len rule .* fires at positions 3,5, expected only the retry at 3/);
  for (const bad of [undefined, { sent: X5_LENGTHS, lines: mkl([1, 3]) }, { sent: [], lines: [] }, { sent: X5_LENGTHS, lines: X5_LENGTHS.map(() => ({})) }]) assert.match(evalX5(bad), /^FINDING \[probe\] X5 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X7 (REQUIRED): PASS only when the timer fires AFTER the next call re-evaluated the module; FAIL when it never fires; FINDING when undecidable, early or unmeasured", () => {
  const A = cl({ n: 5, timer: true, t: "2026-10-05T00:00:00.000Z" }), B = cl({ n: 6, m: 1, t: "2026-10-05T00:00:00.050Z" });
  const T = { kind: "timer", of: 5, pid: 9, t: "2026-10-05T00:00:00.800Z" };
  assert.match(evalX7({ log: [A, B, T] }), /^PASS \[probe\] X7 a request-scoped setTimeout\(\.\.\.\)\.unref\(\) fired 800 ms after its request, AFTER the next request re-evaluated the module \(m=1, n=6/);
  assert.match(evalX7({ log: [A, B] }), /^FAIL \[probe\] X7 the request-scoped setTimeout\(\.\.\.\)\.unref\(\) did NOT fire.*remove the failure-path retry timer/);
  assert.match(evalX7({ log: [A, T, B] }), /^FINDING \[probe\] X7 the timer fired BEFORE the next call was recorded/);
  assert.match(evalX7({ log: [A, { ...B, m: 2 }, T] }), /^FINDING \[probe\] X7 X7 undecidable: the module was not re-evaluated by the next call \(m=2\)/);
  assert.match(evalX7({ log: [{ ...T, of: 99 }, A, B] }), /^FAIL/, "a timer line of ANOTHER call is not this call's timer");
  for (const bad of [undefined, { log: [] }, { log: [A] }, { log: [B, T] }, { log: [T] }]) assert.match(evalX7(bad), /^FINDING \[probe\] X7 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X8: PASS when both shapes carry the marker with messages and tools byte-identical and cache_control kept; each deviation is a FINDING naming it; an empty arm is unmeasured", () => {
  const sent = (o = {}) => ({ messages: "m".repeat(64), tools: "t".repeat(64), blocks: 2, ccIdx: 1, ...o });
  const rec = (shape, o = {}) => ({ systemShape: shape, markers: { [X8_MARK]: true }, messagesSha256: "m".repeat(64), toolsSha256: "t".repeat(64), sysBlocks: shape === "array" ? 3 : null, sysCc: shape === "array" ? [1] : [], ...o });
  const arm = (shape, o = {}, ro = {}) => ({ probe: { edited: true, before: { shape } }, stubRec: rec(shape, ro), sent: sent(o) });
  const good = { string: arm("string", { blocks: null, ccIdx: null }), array: arm("array") };
  assert.match(evalX8(good), /^PASS \[probe\] X8 a router edit of the system prompt reaches the upstream in both shapes on the plain \/v1\/messages path \(string: marker appended; array: marker block appended, cache_control kept on block 1\); messages and tools byte-identical by sha256; the OpenAI-converted path is NOT-RUN/);
  const f = (string, array) => evalX8({ string: string ?? good.string, array: array ?? good.array });
  assert.match(f(arm("string", {}, { markers: { [X8_MARK]: false } })), /^FINDING \[probe\] X8 the string marker did NOT reach the upstream.*BEST EFFORT/);
  assert.match(f(null, arm("array", {}, { sysCc: [] })), /cache_control on system block 1 \(1 as sent\) is GONE at the upstream/);
  // CCR 3.0.22 strips the leading billing block of a subagent request before the router: one block fewer and cache_control one index lower
  const stripped = (o = {}, ro = {}) => arm("array", { stripped: 1, ...o }, { sysBlocks: 2, sysCc: [0], ...ro });
  assert.match(f(null, stripped()), /^PASS \[probe\] X8 .*cache_control kept on block 0 after CCR stripped the 1 billing block/);
  assert.match(f(null, stripped({}, { sysBlocks: 3 })), /the upstream holds 3 system blocks, 2 expected \(the 2 sent, minus 1 billing block CCR strips, plus the marker block\)/);
  assert.match(f(null, stripped({}, { sysCc: [1] })), /cache_control on system block 0 \(1 as sent\) is GONE/);
  assert.match(f(null, arm("array", {}, { sysBlocks: 3, sysCc: [1] })), /^PASS /, "the case it must not break: with nothing stripped the old expectation holds");
  assert.match(f(null, arm("array", {}, { sysBlocks: 2 })), /the upstream holds 2 system blocks, 3 expected/);
  assert.match(f(arm("string", {}, { messagesSha256: "x".repeat(64) })), /messages differ at the upstream \(string\)/);
  assert.match(f(null, arm("array", {}, { toolsSha256: "x".repeat(64) })), /tools differ at the upstream \(array\)/);
  assert.match(f(arm("string", {}, { systemShape: "array" })), /the upstream system shape is array, string was sent/);
  assert.match(f({ ...arm("string"), probe: { edited: false, before: { shape: "array" } } }), /the probe did not edit the string system \(shape at the router: array\)/);
  for (const bad of [undefined, {}, { string: good.string }, { string: {}, array: {} }, { string: { ...good.string, stubRec: null }, array: good.array }]) assert.match(evalX8(bad), /^FINDING \[probe\] X8 unmeasured/, JSON.stringify(bad));
});

test("evaluators (T4) X9a-e: PASS on a conforming matrix; each deviation is a FINDING that names it; the table lists 18 rows; an empty run is unmeasured, and X9c/X9d are untested when no second attempt ever happened", () => {
  const ev = x9ev();
  assert.match(evalX9a(ev), /^PASS \[probe\] X9a Router\.fallback was hot-swapped through the web RPC with the gateway pid unchanged \(5000\); attempts for a 429 without Retry-After: off 1, model-chain 2, retry 2/);
  assert.match(evalX9a({ ...ev, gw: { before: 5000, after: 5001 } }), /^FINDING \[probe\] X9a the sandbox gateway pid changed or was not observed \(5000 -> 5001\).*not shown to be a hot swap \(R1\)/);
  assert.match(evalX9a({ ...ev, gw: { before: null, after: null } }), /^FINDING \[probe\] X9a .*not observed/);
  const flat = x9ev(); for (const c of flat.cases) c.attempts = 1; flat.main.attempts = 1;
  assert.match(evalX9a(flat), /^FINDING \[probe\] X9a the swap was not observed to take effect \(attempts for a 429 without Retry-After: off 1, model-chain 1, retry 1\)/);
  assert.match(evalX9b(ev), /^PASS \[probe\] X9b 18 of 18 cases answered .*request_logs fields \(resolved_model, route_attempt_count, gateway_final_attempt, gateway_error\): not recorded/);
  assert.match(evalX9b({ ...ev, cases: ev.cases.slice(1) }), /^FINDING \[probe\] X9b only 17 of 18 cases/);
  assert.match(evalX9c(ev), /^PASS \[probe\] X9c the probe router saw exactly 1 call per inbound request in 19 of 19 requests, including \d+ with more than one upstream attempt/);
  const two = x9ev(); two.cases[6].routerCalls = 2;
  assert.match(evalX9c(two), /^FINDING \[probe\] X9c 1 of 19 inbound requests reached the probe router other than once \(model-chain\/ra3=2\)/);
  assert.match(evalX9c(flat), /^FINDING \[probe\] X9c no upstream retry or fallback attempt happened in any of 19 cases, so .* is untested/);
  assert.match(evalX9d(ev), /^PASS \[probe\] X9d the model-chain also applies to a MAIN-shaped request \(2 upstream attempts, client status 200\): the fallback is global/);
  assert.match(evalX9d({ ...ev, main: { ...ev.main, attempts: 1, status: 429 } }), /^FINDING \[probe\] X9d the model-chain did NOT apply to a MAIN-shaped request \(1 attempt, client status 429\).*contradicts "global"/);
  assert.match(evalX9d(flat), /^FINDING \[probe\] X9d the chain made no second attempt even for the subagent case/);
  assert.match(evalX9e(ev), /^PASS \[probe\] X9e with the fallback off CCR forwards the upstream retry-after to the client \(sent 3 and 3600, client saw 3 and 3600\)/);
  const strip = x9ev(); for (const c of strip.cases) c.headers = {};
  assert.match(evalX9e(strip), /^FINDING \[probe\] X9e with the fallback off CCR did NOT forward the upstream retry-after to the client/);
  const chg = x9ev(); chg.cases.find((c) => c.mode === "off" && c.id === "ra3600").headers = { "retry-after": "60" };
  assert.match(evalX9e(chg), /^PASS \[probe\] X9e .*client saw 3 and 60: CHANGED in transit/);
  const rows = x9Table(ev);
  assert.equal(rows.length, 18); assert.ok(rows.every((r) => !/NOT MEASURED/.test(r)));
  assert.match(rows[1], /X9 off\s+ra3600\s+client status 429, upstream attempts 1, router calls 1, delay 1\.0 s, retry-after 3600/);
  assert.equal(x9Table({ cases: [] }).filter((r) => /NOT MEASURED/.test(r)).length, 18);
  for (const e of [evalX9a, evalX9b, evalX9c, evalX9d, evalX9e]) assert.match(e({}), /^FINDING \[probe\] X9[a-e] (unmeasured|only 0 of 18)/, "an empty evidence record never passes");
});

test("evaluators (T6) H1: PASS on a handoff with the notice on request 2 only; FINDING (never FAIL) on each mismatch, with the observed values; an empty record is unmeasured", () => {
  const rec = (model, notice = false) => ({ model, markers: { [NOTICE_MARK]: notice } });
  const hl = { act: "handoff", from: "uwstub/m-big", to: "uwstub/m-main", aid_full: "agent-1", hop: 1, rsrc: "len" };
  const ok = { recs: [rec("uwstub/m-big"), rec("uwstub/m-main", true), rec("uwstub/m-main")], agents: [{ act: "keep" }, hl], x8Reached: true, aid: "agent-1" };
  assert.match(evalH1(ok), /^PASS \[next\] H1 handoff smoke as expected: requests served by m-big > m-main > m-main, 1 handoff line, notice at the stub no\/yes\/no, X8 reached/);
  assert.match(evalH1({ ...ok, recs: [rec("m-big"), rec("m-main", true), rec("m-main")] }), /^PASS/, "either model spelling");
  assert.match(evalH1({ ...ok, x8Reached: null, recs: [rec("m-big"), rec("m-main"), rec("m-main")] }), /^PASS .*X8 not run/, "no judgement of the notice when X8 did not run");
  assert.match(evalH1({ ...ok, x8Reached: false, recs: [rec("m-big"), rec("m-main"), rec("m-main")] }), /^PASS .*X8 not reached/);
  const cases = [
    ["same model on request 2", { recs: [rec("m-big"), rec("m-big", true), rec("m-big")] }, /request 2 \(same length\) was served by the SAME model m-big/],
    ["no handoff line", { agents: [{ act: "keep" }] }, /agents\.jsonl holds 0 handoff lines, 1 expected/],
    ["two handoff lines", { agents: [hl, hl] }, /holds 2 handoff lines/],
    ["no aid_full", { agents: [{ ...hl, aid_full: undefined }] }, /lacks from\/to\/aid_full/],
    ["line disagrees with the stub", { agents: [{ ...hl, to: "uwstub/m-free" }] }, /says uwstub\/m-big -> uwstub\/m-free but the stub saw m-big then m-main/],
    ["header source", { agents: [{ ...hl, rsrc: "hdr" }] }, /the retry source is hdr, expected len/],
    ["notice missing", { recs: [rec("m-big"), rec("m-main", false), rec("m-main")] }, /notice is MISSING from the system at the stub although X8 showed/],
    ["notice on request 3", { recs: [rec("m-big"), rec("m-main", true), rec("m-main", true)] }, /the notice appeared on request 3/],
    ["notice on request 1", { recs: [rec("m-big", true), rec("m-main", true), rec("m-main")] }, /the notice appeared on request 1/],
    ["request 3 leaves the new model", { recs: [rec("m-big"), rec("m-main", true), rec("m-big")] }, /request 3 \(grown messages\) was served by m-big, not the handed-off model m-main/],
  ];
  for (const [name, over, re] of cases) { const l = evalH1({ ...ok, ...over }); assert.match(l, /^FINDING \[next\] H1 /, name); assert.match(l, re, name); assert.match(l, /Observed: requests served by/, `${name}: the observed values are printed`); }
  assert.match(evalH1({ ...ok, x8Reached: false, recs: [rec("m-big"), rec("m-main", true), rec("m-main")] }), /^FINDING .*the handoff notice reached the stub although X8 showed a system edit does not/);
  for (const bad of [undefined, {}, { recs: [] }, { recs: [rec("a"), rec("b")] }]) assert.match(evalH1(bad), /^FINDING \[next\] H1 handoff smoke unmeasured/, JSON.stringify(bad));
});

test("evaluators (T1) A2 and A8 on router v2: agents.jsonl must carry the shadow line, a status-<w>.json must exist, the loader registry holds ONE key or the line says it was not observed; the older evidence shape still passes", () => {
  const dec = { would: TAG_MODEL, ret: ASKED_MODEL }, ag = { aid: "uws0-a2", path: "shadow", would: TAG_MODEL, ret: ASKED_MODEL };
  assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL, agents: [ag] }), /^PASS \[next\] A2 .*agents\.jsonl carries the same would\/ret/);
  assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL, agents: [] }), /^FAIL \[next\] A2 agents\.jsonl has no shadow line for the new agent uws0-a2 \(0 lines\)/);
  assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL, agents: [{ ...ag, path: "new" }] }), /^FAIL \[next\] A2 agents\.jsonl has no shadow line/);
  assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL, agents: [{ ...ag, ret: TAG_MODEL }] }), /^FAIL \[next\] A2 agents\.jsonl line disagrees with decisions\.jsonl/);
  assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL }), /^PASS \[next\] A2 /, "no agents key: judged on decisions.jsonl alone");
  const base = { status: { counters: { req: 6 }, since: "t0", pid: 7 }, first: { since: "t0" }, min: 6, loadFailure: false, logFiles: 1 };
  assert.match(evalA8({ ...base, workerFiles: 1, registry: { keys: 1, own: true, pid: 7 } }), /^PASS \[next\] A8 .*; 1 status-<w>\.json file next to status\.json \(pid 7\); __uwRouterImpl holds 1 key \(the router file\) in pid 7; no `Failed to load custom router` in 1 CCR log files\.$/);
  assert.match(evalA8({ ...base, workerFiles: 2, registry: { keys: 1, own: true, pid: 8 } }), /2 status-<w>\.json files .*\(the status worker is pid 7: another worker\)/);
  assert.match(evalA8({ ...base, workerFiles: 0, registry: { keys: 1, own: true, pid: 7 } }), /^FAIL \[next\] A8 no status-<w>\.json exists next to status\.json/);
  assert.match(evalA8({ ...base, workerFiles: 1, registry: { keys: 3, own: true, pid: 7 } }), /^FAIL \[next\] A8 globalThis\.__uwRouterImpl holds 3 keys \(pid 7\) after 6 requests/);
  assert.match(evalA8({ ...base, workerFiles: 1, registry: undefined }), /^PASS \[next\] A8 .*registry globalThis\.__uwRouterImpl NOT OBSERVED \(no peek ran\)/);
  assert.match(evalA8({ ...base, workerFiles: 1, registry: { keys: 0, own: false, pid: 9 } }), /^PASS \[next\] A8 .*registry not seen by the peek \(pid 9, 0 keys, own entry no\).*not a failure/);
  assert.doesNotMatch(evalA8(base), /registry|status-<w>/, "the older evidence shape carries no v2 sentence");
});

test("flow (T4, T6): a gateway that deviates turns the informational experiments into FINDING lines and the run still exits 0; X7 FAIL, A2 without agents.jsonl, A8 without a status-<w>.json and a growing loader registry FAIL the run", async () => {
  const P = [...GO, "--router", "probe"], N = [...GO, "--router", "next"];
  const arms = [
    [P, "X1", { providersInPlace: true }, "FINDING", /Providers is the SAME array after an edit/],
    [P, "X1", { workers: [5000, 5001] }, "FINDING", /unmeasured: the three calls were served by 2 processes/],
    [P, "X2", { workers: [5000, 5001, 5001] }, "PASS", /served by 2 distinct processes.*several workers/],
    [P, "X3", { retryHdrStripped: true }, "FINDING", /the retry-count header did NOT reach the router on the retried request/],
    [P, "X3", { ccrRetriesAlone: true }, "FINDING", /its own fallback is NOT off by default/],
    [P, "X4", { agentIdMangled: true }, "FINDING", /the team agent id lost its @ part/],
    [P, "X7", { timerEarly: true }, "FINDING", /the timer fired BEFORE the next call was recorded/],
    [P, "X7", { cacheNotDeleted: true }, "FINDING", /undecidable: the module was not re-evaluated/],
    [P, "X8", { x8Dropped: true }, "FINDING", /marker did NOT reach the upstream/],
    [P, "X8", { ccDropped: true }, "FINDING", /cache_control on system block 0 \(1 as sent\) is GONE/],
    [P, "X8", { noBillingStrip: true }, "FINDING", /the upstream holds 3 system blocks, 2 expected \(the 2 sent, minus 1 billing block CCR strips, plus the marker block\)/],
    [P, "X8", { x8TouchMessages: true }, "FINDING", /messages differ at the upstream/],
    [P, "X9a", { noFallbackSwap: true }, "FINDING", /the swap was not observed to take effect/],
    [P, "X9a", { gatewayPidFlip: true }, "FINDING", /gateway pid changed or was not observed \(5000 -> 5001\)/],
    [P, "X9c", { noFallbackSwap: true }, "FINDING", /no upstream retry or fallback attempt happened/],
    [P, "X9d", { mainNoChain: true }, "FINDING", /did NOT apply to a MAIN-shaped request/],
    [P, "X9e", { noRetryAfterForward: true }, "FINDING", /did NOT forward the upstream retry-after/],
    [N, "H1", { noHandoff: true }, "FINDING", /request 2 \(same length\) was served by the SAME model/],
    [GO, "H1", { noticeDropped: true }, "FINDING", /notice is MISSING/],
    [GO, "H1", { x8Dropped: true }, "PASS", /X8 not reached/],
    [N, "A8", { registryKeys: 0 }, "PASS", /registry not seen by the peek/],
  ];
  for (const [argv, id, opt, kind, re] of arms) {
    const r = await run(argv, opt);
    assert.equal(r.code, 0, `${id} ${JSON.stringify(opt)}: ${r.err}${r.out.slice(-300)}`);
    assert.equal(kindOf(r.out, id), kind, `${id} ${JSON.stringify(opt)}: ${lineOf(r.out, id)}`);
    assert.match(lineOf(r.out, id), re, `${id} ${JSON.stringify(opt)}`);
    assert.equal(r.out.split("\n").filter((l) => parseLine(l)?.kind === "FAIL").length, 0, `${id}: a FINDING is never a FAIL`);
  }
  const fails = [
    [P, "X7", { timerDies: true }, /FAIL \[probe\] X7 the request-scoped setTimeout.*did NOT fire/],
    [N, "A2", { noAgentsLog: true }, /FAIL \[next\] A2 agents\.jsonl has no shadow line/],
    [N, "A8", { noWorkerFile: true }, /FAIL \[next\] A8 no status-<w>\.json exists/],
    [N, "A8", { registryKeys: 2 }, /FAIL \[next\] A8 globalThis\.__uwRouterImpl holds 2 keys/],
  ];
  for (const [argv, id, opt, re] of fails) {
    const r = await run(argv, opt);
    assert.equal(r.code, 1, `${id} ${JSON.stringify(opt)} must fail the run`);
    assert.match(r.out, re, id);
  }
});

test("flow (T4): X9 restores Router.fallback: a failed restore prints FAIL X9a and exits 1, an enabled Router.rules entry or a non-stub chain model refuses before any save, and the teardown scrubs a still-swapped fallback", async () => {
  const f = await run([...GO, "--router", "probe"], { failRestore: true });
  assert.equal(f.code, 1);
  assert.match(f.out, /FAIL \[probe\] X9a Router\.fallback could NOT be restored to its original value in the sandbox config: saveConfig failed: boom/);
  const rules = await run([...GO, "--router", "probe"], { rulesEnabled: true });
  assert.equal(rules.code, 1); assert.match(rules.err, /x1-edit: an enabled Router\.rules entry exists/);
  assert.ok(!(rules.w.fbSeen ?? []).includes("model-chain"), "refused before any swap was saved");
  for (const mode of X9_MODES) for (const m of fallbackFor(mode).models) assert.match(m, /^uwstub\//, "a chain model is always a stub model");
  assert.deepEqual(fallbackFor("off"), { mode: "off", models: [] });
  assert.equal(fallbackFor("model-chain").models.length, 1, "the chain holds ONE stub model");
  // the teardown of a daemon that was NOT stopped scrubs Router.fallback back to off with the providers
  const un = world({}); un.w.started = true; un.w.childAlive = true; un.w.gatewayUp = true;
  un.w.cfg.Router = { fallback: { mode: "model-chain", models: ["uwstub/m-free"], retryCount: 1 } }; un.w.cfg.Providers = [{ name: "uwstub" }];
  un.d.sys.processes = () => [{ pid: 5000, ppid: 1, name: "node.exe", cmd: "chrome.exe --foo" }];
  assert.equal(await runE2e(["--teardown"], un.d), 1);
  assert.equal(un.w.cfg.Router.fallback.mode, "off"); assert.deepEqual(un.w.cfg.Router.fallback.models, []); assert.equal(un.w.cfg.Router.fallback.retryCount, 1, "other fields are kept");
  assert.deepEqual(un.w.cfg.Providers, []);
  assert.match(un.w.out.join("\n"), /scrubbed Providers\[\], CUSTOM_ROUTER_PATH and Router\.fallback \(back to off\)/);
});

test("flow (T4): the probe and the stub are only ever driven through the sandbox gateway and the sandbox web RPC (getConfig and saveConfig), with redirect:error and a request ceiling, and the harness still refuses without approval, a clean scratch tree or a proven isolation", async () => {
  const r = await run(GO, {});
  assert.deepEqual([...new Set(r.w.calls.rpc)].sort(), ["getConfig", "saveConfig"]);
  assert.ok(r.w.fetchInits.length > 60 && r.w.fetchInits.every((i) => i.redirect === "error" && i.signal instanceof AbortSignal), "every request: redirect:error and an abort signal (150 s ceiling)");
  assert.equal((await run(GO, {}, { none: true })).code, 2, "no approval file: refused");
  const dirty = world({}); dirty.w.mem.files.set(norm(path.join(SCRATCH_ROOT, "appdata", "x")), "x");
  const rr = await go(dirty.w, dirty.d, GO); assert.equal(rr.code, 1); assert.match(rr.err, /scratch tree is not fresh/); assert.equal(rr.w.calls.fetch, 0);
  const red = await run(GO, { liveOwnerAfter: "provider" }); assert.equal(red.code, 1); assert.equal(red.w.calls.fetch, 0, "an unproven isolation sends nothing");
});

// ---------------------------------------------------------------- the stub (T3)
test("stub (T3): scripted per-request answers are consumed in order, Retry-After is SENT in whole seconds only when scripted, and a request's own retry-after or credential is never recorded", async () => {
  const s = createStub({ port: 0, script: { sequence: [200, { status: 429, retryAfter: 5 }, { status: 429, retryAfter: 90 }, { status: 429, retryAfter: 3600 }, { status: 429 }, 503, 529, 400, 413, 502] } });
  const p = await s.start();
  try {
    const key = fake("key");
    const send = () => fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": key, authorization: `Bearer ${key}`, "retry-after": "7777", "x-stainless-retry-count": "2", "x-claude-code-parent-agent-id": "team-lead@session-f49cde2f" }, body: JSON.stringify({ model: "uwstub/m-free", messages: [{ role: "user", content: "private text" }] }) });
    const got = [];
    for (let i = 0; i < 11; i++) { const r = await send(); got.push([r.status, r.headers.get("retry-after")]); await r.text(); }
    assert.deepEqual(got, [[200, null], [429, "5"], [429, "90"], [429, "3600"], [429, null], [503, null], [529, null], [400, null], [413, null], [502, null], [200, null]], "the 11th request finds the sequence empty: 200");
    assert.equal(s.pending(), 0);
    assert.deepEqual(s.records.map((x) => x.sent.status), [200, 429, 429, 429, 429, 503, 529, 400, 413, 502, 200]);
    assert.deepEqual(s.records.map((x) => x.sent.retryAfter), [null, 5, 90, 3600, null, null, null, null, null, null, null]);
    const dump = JSON.stringify(s.records);
    for (const leak of [key, "authorization", "x-api-key", "7777", "private text"]) assert.ok(!dump.includes(leak), `a record must not contain ${leak}`);
    assert.ok(!RECORDED_HEADERS.includes("retry-after"), "retry-after is a header the stub sends, never one it records");
    assert.equal(s.records[0].headers["x-stainless-retry-count"], "2"); assert.equal(s.records[0].headers["x-claude-code-parent-agent-id"], "team-lead@session-f49cde2f");
    const e = await (await (async () => { s.setScript({ sequence: [429] }); return send(); })()).json();
    assert.deepEqual(e, { type: "error", error: { type: "rate_limit_error", message: "stub: scripted failure" } });
    s.setScript({ status: 500 }); const legacy = await send(); assert.equal(legacy.status, 500); await legacy.text();
    s.setScript({ sequence: [503], status: 500 }); assert.equal((await send()).status, 503, "a sequence step wins over the legacy status"); assert.equal((await send()).status, 500, "then the legacy status applies");
  } finally { await s.stop(); }
});

test("stub (T3): a stream cut sends message_start only and destroys the socket; a script with a bad status, Retry-After, cut or marker list is refused when it is set", async () => {
  const s = createStub({ port: 0 });
  const p = await s.start();
  try {
    s.setScript({ sequence: [{ cut: "after-message_start" }] });
    const res = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", stream: true, messages: [] }) });
    assert.equal(res.status, 200); assert.equal(res.headers.get("content-type"), "text/event-stream");
    const rd = res.body.getReader(), first = await rd.read();
    assert.match(Buffer.from(first.value).toString(), /^event: message_start\ndata: .*"type":"message_start"/);
    await assert.rejects(async () => { for (;;) { const x = await rd.read(); if (x.done) throw new Error("ended cleanly: the stream was not cut"); } }, /terminated|aborted|socket|ended cleanly/i);
    assert.notEqual(s.records[0].sent, null); assert.equal(s.records[0].sent.cut, "after-message_start");
    const after = await fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "m", messages: [] }) });
    assert.equal(after.status, 200, "the next request is served normally"); await after.text();
  } finally { await s.stop(); }
  for (const bad of [{ sequence: [99] }, { sequence: [600] }, { sequence: [{ status: 429, retryAfter: -1 }] }, { sequence: [{ status: 429, retryAfter: 1.5 }] }, { sequence: [{ status: 429, retryAfter: 86401 }] },
    { sequence: [{ cut: "mid-stream" }] }, { sequence: "429" }, { markers: "x" }, { markers: [""] }, { markers: [1] }, { markers: Array(9).fill("m") }, { markers: ["x".repeat(65)] }]) {
    assert.throws(() => createStub({ port: 0, script: bad }), /stub (step|script)/, JSON.stringify(bad));
    assert.throws(() => createStub({ port: 0 }).setScript(bad), /stub (step|script)/, JSON.stringify(bad));
  }
  assert.deepEqual(normaliseStep(429), { status: 429, retryAfter: null, cut: null });
  assert.deepEqual(normaliseStep({ status: 429, retryAfter: 0 }), { status: 429, retryAfter: 0, cut: null });
});

test("stub (T3, X8): records the system SHAPE (string, array, absent), whether the harness's own markers occur in it, the cache_control indexes and the sha256 of messages and tools; the system text is never stored", async () => {
  const s = createStub({ port: 0, script: { markers: ["[m1]", "[m2]"] } });
  const p = await s.start();
  try {
    const post1 = (b) => fetch(`http://127.0.0.1:${p}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.text());
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools = [{ name: "Bash", description: "b" }];
    await post1({ model: "m", system: "secret system text [m1]", messages: msgs, tools });
    await post1({ model: "m", system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b" }, { type: "text", text: "[m2]", cache_control: { type: "ephemeral" } }], messages: msgs, tools });
    await post1({ model: "m", messages: msgs });
    const [a, b, c] = s.records;
    assert.equal(a.systemShape, "string"); assert.deepEqual(a.markers, { "[m1]": true, "[m2]": false }); assert.equal(a.sysBlocks, null); assert.deepEqual(a.sysCc, []);
    assert.equal(b.systemShape, "array"); assert.deepEqual(b.markers, { "[m1]": false, "[m2]": true }); assert.equal(b.sysBlocks, 3); assert.deepEqual(b.sysCc, [0, 2]);
    assert.equal(c.systemShape, "absent"); assert.deepEqual(c.markers, { "[m1]": false, "[m2]": false });
    const h = bodyHashes({ messages: msgs, tools });
    assert.equal(a.messagesSha256, h.messages); assert.equal(a.toolsSha256, h.tools); assert.equal(a.messagesLen, 1);
    assert.equal(c.toolsSha256, sha("null"), "absent tools hash as null on both sides");
    assert.equal(c.toolsSha256, bodyHashes({ messages: msgs }).tools);
    assert.ok(!JSON.stringify(s.records).includes("secret system text"));
    s.setScript({}); await post1({ model: "m", system: "x [m1]", messages: msgs });
    assert.deepEqual(s.last().markers, {}, "no markers configured: none recorded");
  } finally { await s.stop(); }
});

// ---------------------------------------------------------------- the probe router (T2), as a COPY in a temp tree
test("probe router (T2): every call records the X1 config identity, the X2 pid, the X4 header SHAPES and the X5 messages record, in any mode, and never a header value, a model list or a credential", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN; delete globalThis.__uwProbeCfg;
  const secret = fake("apikey");
  const cfgA = { Providers: [{ name: "uwstub", enabled: true, models: ["a"], api_key: secret }] };
  const mkreq = (o = {}) => ({ body: { model: ASKED_MODEL, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }, headers: { "x-claude-code-agent-id": "ccr-logs@session-f49cde2f", "x-claude-code-parent-agent-id": "team-lead@session-f49cde2f", "x-claude-code-session-id": "s-1", "x-stainless-retry-count": "1", ...o } });
  try {
    setMode(t, "observe");
    await t.fresh()(mkreq(), cfgA); await t.fresh()(mkreq(), cfgA);
    cfgA.Providers[0].models.push("b");                                  // an edit IN PLACE: the identity survives, the fingerprint changes
    await t.fresh()(mkreq(), cfgA);
    await t.fresh()(mkreq(), structuredClone(cfgA));                     // a NEW object with the same content
    await t.fresh()(mkreq({ "x-claude-code-agent-id": "bad id!" }), undefined);
    const raw = fs.readFileSync(path.join(t.state, "probe.jsonl"), "utf8"), L = lines(path.join(t.state, "probe.jsonl"));
    assert.deepEqual(L[0].cfg, { first: true, same: null, provSame: null, provN: 1, fp: L[0].cfg.fp });
    assert.deepEqual([L[1].cfg.first, L[1].cfg.same, L[1].cfg.provSame, L[1].cfg.fp === L[0].cfg.fp], [false, true, true, true]);
    assert.deepEqual([L[2].cfg.same, L[2].cfg.provSame, L[2].cfg.fp !== L[1].cfg.fp], [true, true, true], "an in-place edit: same objects, a different fingerprint");
    assert.deepEqual([L[3].cfg.same, L[3].cfg.provSame, L[3].cfg.fp === L[2].cfg.fp, L[3].cfg.provN], [false, false, true, 1], "a new object: both false, the same fingerprint");
    assert.deepEqual(L[4].cfg.provN, null, "no config argument: no provider count");
    assert.deepEqual(L[0].hdr.aid, { len: 25, at: true, ok: true, form: "a-a@a-a9a9a" });
    assert.deepEqual(L[0].hdr.par, { len: 26, at: true, ok: true, form: "a-a@a-a9a9a" });
    assert.deepEqual(L[0].hdr.sid, { len: 3, at: false, ok: true, form: "a-9" });
    assert.equal(L[0].hdr.retry, "1");
    assert.equal(L[4].hdr.aid.ok, false, "a rejected charset is recorded as such");
    assert.equal(L[0].ml, 1); assert.match(L[0].lh, /^[0-9a-f]{12}$/); assert.equal(L[0].pid, process.pid);
    for (const leak of [secret, "ccr-logs", "team-lead", "session-f49cde2f", '"s-1"', "hello"]) assert.ok(!raw.includes(leak), `probe.jsonl must not contain ${leak}`);
    assert.deepEqual(fs.readdirSync(t.state).sort(), ["probe-control.json", "probe.jsonl"]);
  } finally { delete globalThis.__uwProbeN; delete globalThis.__uwProbeCfg; }
});

test("probe router (T2, X7): mode timer schedules an unref'd request-scoped timer that FIRES after a fresh require deleted the module (the harness's A then B), and evalX7 reads the real log as PASS and the log without the timer line as FAIL", async () => {
  const src = fs.readFileSync(PROBE_ROUTER_SRC, "utf8");
  assert.match(src, /setTimeout\([\s\S]*?\)\.unref\(\)/, "the timer is unref'd");
  const t = probeTree();
  delete globalThis.__uwProbeN; delete globalThis.__uwProbeCfg;
  try {
    setMode(t, "timer");
    fs.writeFileSync(path.join(t.state, "probe-control.json"), JSON.stringify({ mode: "timer", delayMs: 150 }));
    const req = () => ({ body: { model: ASKED_MODEL, messages: [] }, headers: {} });
    assert.equal(await t.fresh()(req()), ASKED_MODEL);                  // A
    setMode(t, "observe");
    assert.equal(await t.fresh()(req()), ASKED_MODEL);                  // B: a new module instance, A's cache entry is gone
    await new Promise((r) => setTimeout(r, 450));
    const log = lines(path.join(t.state, "probe.jsonl"));
    assert.deepEqual(log.map((l) => l.kind ?? (l.timer ? "A" : "B")), ["A", "B", "timer"]);
    assert.equal(log[0].delayMs, 150); assert.equal(log[2].of, log[0].n); assert.equal(log[2].pid, process.pid);
    assert.match(evalX7({ log }), /^PASS \[probe\] X7 /);
    assert.match(evalX7({ log: log.filter((l) => l.kind !== "timer") }), /^FAIL \[probe\] X7 /);
    fs.writeFileSync(path.join(t.state, "probe-control.json"), JSON.stringify({ mode: "timer", delayMs: 1 }));
    await t.fresh()(req());
    await new Promise((r) => setTimeout(r, 120));
    const clamped = lines(path.join(t.state, "probe.jsonl")).filter((l) => l.timer).at(-1);
    assert.equal(clamped.delayMs, 50, "the delay is clamped to 50..5000 ms");
  } finally { delete globalThis.__uwProbeN; delete globalThis.__uwProbeCfg; }
});

test("probe router (T2, X8): sys-string appends the marker to a string system ONCE, sys-array pushes ONE marker block onto an array system and keeps cache_control on the original last block; messages and tools are never touched; the wrong shape is not edited; the line carries the before and after hashes", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN;
  try {
    const mk2 = (system) => ({ body: { model: ASKED_MODEL, system, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [{ name: "Bash", description: "b" }] }, headers: {} });
    const hashes = (b) => bodyHashes(b);
    setMode(t, "sys-string");
    const s = mk2("SYSTEM TEXT"), s0 = hashes(s.body);
    assert.equal(await t.fresh()(s), ASKED_MODEL);
    assert.equal(s.body.system, `SYSTEM TEXT\n${X8_MARK}`);
    assert.deepEqual(hashes(s.body), s0, "messages and tools are byte-identical");
    const wrong = mk2([{ type: "text", text: "a" }]);
    await t.fresh()(wrong);
    assert.deepEqual(wrong.body.system, [{ type: "text", text: "a" }], "an array system is left alone in sys-string mode");
    setMode(t, "sys-array");
    const blocks = [{ type: "text", text: "billing" }, { type: "text", text: "agent", cache_control: { type: "ephemeral" } }];
    const a = mk2(structuredClone(blocks)), a0 = hashes(a.body);
    await t.fresh()(a);
    assert.equal(a.body.system.length, 3); assert.deepEqual(a.body.system.slice(0, 2), blocks, "the original blocks, cache_control included, are unchanged");
    assert.deepEqual(a.body.system[2], { type: "text", text: X8_MARK }, "the marker block carries no cache_control");
    assert.deepEqual(hashes(a.body), a0);
    const strW = mk2("plain"); await t.fresh()(strW);
    assert.equal(strW.body.system, "plain", "a string system is left alone in sys-array mode");
    const absent = mk2(undefined); delete absent.body.system; await t.fresh()(absent); assert.equal(absent.body.system, undefined, "no system: nothing invented");
    const L = lines(path.join(t.state, "probe.jsonl"));
    assert.deepEqual(L.map((l) => l.edited), [true, false, true, false, false]);
    assert.equal(L[0].before.shape, "string"); assert.equal(L[0].after.shape, "string"); assert.notEqual(L[0].before.sys, L[0].after.sys);
    assert.equal(L[0].before.msgs, L[0].after.msgs); assert.equal(L[0].before.tools, L[0].after.tools);
    assert.equal(L[0].before.msgs, s0.messages.slice(0, 12)); assert.equal(L[0].before.tools, s0.tools.slice(0, 12), "the probe hashes the same way the stub and the harness do");
    assert.equal(L[2].after.shape, "array"); assert.equal(L[4].before.shape, "absent");
  } finally { delete globalThis.__uwProbeN; }
});

test("probe router (T2): mode registry reads globalThis.__uwRouterImpl (keys, own entry, id), observe touches nothing and returns asked, an unknown mode behaves like observe", async () => {
  const t = probeTree();
  delete globalThis.__uwProbeN; const saved = globalThis.__uwRouterImpl;
  try {
    const req = () => ({ body: { model: ASKED_MODEL, tools: [{ name: "Agent", description: "d" }] }, headers: {} });
    setMode(t, "registry");
    delete globalThis.__uwRouterImpl;
    await t.fresh()(req());
    globalThis.__uwRouterImpl = { [require.resolve(t.file)]: { id: "1:2:3:4:5", impl: () => {} }, other: {} };
    await t.fresh()(req());
    globalThis.__uwRouterImpl = { other: {} };
    await t.fresh()(req());
    const L = lines(path.join(t.state, "probe.jsonl"));
    assert.deepEqual(L.map((l) => l.reg), [{ keys: 0, own: false, id: null }, { keys: 2, own: true, id: "1:2:3:4:5" }, { keys: 1, own: false, id: null }]);
    for (const mode of ["observe", "bogus-mode"]) {
      setMode(t, mode);
      const r = req();
      assert.equal(await t.fresh()(r), ASKED_MODEL, mode);
      assert.equal(r.body.tools[0].description, "d", `${mode} edits nothing`); assert.equal(r.headers["x-uw-subpolicy"], undefined);
    }
  } finally { delete globalThis.__uwProbeN; if (saved === undefined) delete globalThis.__uwRouterImpl; else globalThis.__uwRouterImpl = saved; }
});

// ---------------------------------------------------------------- router v2 compatibility of the exact-bytes pass (T1, T6), on the REAL bytes in a temp tree
function nextTree() {
  const root = mk();
  fs.mkdirSync(path.join(root, "spike"), { recursive: true });
  const file = path.join(root, "spike", "uw-router.cjs");
  fs.copyFileSync(NEXT_ROUTER_SRC, file);
  fs.writeFileSync(path.join(root, "spike", "slot.json"), JSON.stringify({ model: "anthropic/claude-opus-5" }));
  const state = path.join(root, "state", "subagent");
  const route = () => { delete require.cache[require.resolve(file)]; return require(file); };
  return { root, file, state, route, cfg: { Providers: [{ name: "uwstub", enabled: true, models: ["m-main", "m-free", "m-big"] }] } };
}
const ccrReq = (shape, o) => { const q = buildRequest(shape, { key: "k", ...o }); return { body: q.body, headers: { ...q.headers }, builtInClaudeCodeSubagent: shape === "sub", builtInSubagentModel: o.tag, tokenCount: 10, sessionId: o.session }; };

test("next router (real bytes, T1): router v2 writes status.json AND status-<w>.json and decisions.jsonl AND agents.jsonl for a shadow decision, the loader registry holds ONE key across many fresh requires, and a probe copied over the same path in the same process reads it (the harness's peek)", async () => {
  const t = nextTree();
  fs.mkdirSync(t.state, { recursive: true });
  fs.writeFileSync(path.join(t.state, "policy.json"), JSON.stringify(buildShadowPolicy(new Date("2026-10-03T00:00:00Z"))));
  dropRouterState(); const savedReg = globalThis.__uwRouterImpl; delete globalThis.__uwRouterImpl;
  try {
    const main = () => ccrReq("main", { model: "uwstub/m-main", session: "uws0-main" });
    const sub = ccrReq("sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "uws0-a2", session: "uws0-main" });
    assert.equal(await t.route()(main(), t.cfg), "uwstub/m-main");
    assert.equal(await t.route()(sub, t.cfg), ASKED_MODEL);
    for (let i = 0; i < 4; i++) await t.route()(main(), t.cfg);
    assert.deepEqual(Object.keys(globalThis.__uwRouterImpl), [require.resolve(t.file)], "ONE registry key (the router file) after 6 requests through fresh requires");
    t.route().__test.flush();
    const names = fs.readdirSync(t.state);
    const workerFiles = names.filter((n) => /^status-[0-9a-z]{1,13}\.json$/.test(n));
    assert.equal(workerFiles.length, 1, `status-<w>.json next to status.json: ${names.join(",")}`);
    const status = JSON.parse(fs.readFileSync(path.join(t.state, "status.json"), "utf8")), wstatus = JSON.parse(fs.readFileSync(path.join(t.state, workerFiles[0]), "utf8"));
    assert.equal(status.pid, process.pid); assert.equal(wstatus.w, status.w);
    const dec = lines(path.join(t.state, "decisions.jsonl")).find((x) => x.role === "sub"), agents = lines(path.join(t.state, "agents.jsonl"));
    assert.equal(agents.length, 1, "one agents.jsonl line per NEW agent");
    assert.match(evalA2({ decision: dec, stubModel: ASKED_MODEL, agents }), /^PASS \[next\] A2 .*agents\.jsonl carries the same would\/ret/);
    // the peek: the probe bytes over the same path, one fresh require in the same process
    fs.copyFileSync(PROBE_ROUTER_SRC, t.file);
    fs.writeFileSync(path.join(t.state, "probe-control.json"), JSON.stringify({ mode: "registry" }));
    await t.route()({ body: { model: ASKED_MODEL }, headers: {} }, t.cfg);
    const peek = lines(path.join(t.state, "probe.jsonl")).at(-1);
    assert.equal(peek.reg.keys, 1); assert.equal(peek.reg.own, true); assert.equal(peek.reg.id.split(":").length, 5, "the registry id is the loader's mtime:size:ino:length:hash");
    assert.match(evalA8({ status, first: { since: status.since }, min: 6, loadFailure: false, logFiles: 1, workerFiles: workerFiles.length, registry: { keys: peek.reg.keys, own: peek.reg.own, pid: peek.pid } }), /^PASS \[next\] A8 .*1 status-<w>\.json file next to status\.json \(pid \d+\); __uwRouterImpl holds 1 key \(the router file\) in pid \d+/);
    assert.equal(status.counters.req, 6, "counters accumulate: six requests reached the router");
  } finally { dropRouterState(); if (savedReg === undefined) delete globalThis.__uwRouterImpl; else globalThis.__uwRouterImpl = savedReg; }
});

test("next router (real bytes, T6): the ENFORCE synthetic policy loads, a retry by length hands the subagent to a DIFFERENT model with ONE handoff line (from, to, aid_full, rsrc len), the notice is appended once to the array system with messages and tools byte-identical, a grown request stays; shadow never hands off; evalH1 agrees", async () => {
  const pe = buildEnforcePolicy(new Date("2026-10-03T00:00:00Z")), ps = buildShadowPolicy(new Date("2026-10-03T00:00:00Z"));
  assert.equal(pe.owner.enforcement, "enforce"); assert.equal(pe.contentHash, ps.contentHash, "enforcement is not part of the hash");
  assert.equal(pe.contentHash, policyContentHash(pe)); assert.deepEqual(Object.keys(pe), Object.keys(ps));
  assert.deepEqual(buildEnforcePolicy(new Date("2026-10-03T00:00:00Z")), pe, "deterministic for a fixed clock");
  assert.equal(pe.contentHash, (await import("../keysync/subagent-policy.mjs")).hashOf(pe), "the compiler's own hash of the enforce file");
  const sid = "uws0-h1", aid = "uws0-h1a";
  const sequence = async (policy, agent) => {
    const t = nextTree(); fs.mkdirSync(t.state, { recursive: true });
    fs.writeFileSync(path.join(t.state, "policy.json"), JSON.stringify(policy));
    dropRouterState();
    try {
      const mk3 = (n) => ccrReq("sub", { model: ASKED_MODEL, session: sid, agentId: agent, messages: n, agentTool: false });
      await t.route()(ccrReq("main", { model: ANCHOR, session: sid }), t.cfg);
      const r1 = mk3(3), r2 = mk3(3), r3 = mk3(5), pristine = mk3(3);
      const models = [await t.route()(r1, t.cfg), await t.route()(r2, t.cfg), await t.route()(r3, t.cfg)];
      t.route().__test.flush();
      const status = JSON.parse(fs.readFileSync(path.join(t.state, "status.json"), "utf8"));
      return { models, reqs: [r1, r2, r3], pristine, agents: fs.existsSync(path.join(t.state, "agents.jsonl")) ? lines(path.join(t.state, "agents.jsonl")).filter((l) => l.aid === agent.slice(0, 12)) : [], status };
    } finally { dropRouterState(); }
  };
  const e = await sequence(pe, aid);
  assert.equal(e.status.policy.state, "ok"); assert.equal(e.status.policy.enforcement, "enforce", "the router's own loader accepts the synthetic enforce policy");
  assert.equal(e.models[0], ASKED_MODEL); assert.notEqual(e.models[1], e.models[0], "request 2 (same length) is handed off"); assert.equal(e.models[2], e.models[1], "request 3 (grown) stays on the new model");
  const hand = e.agents.filter((l) => l.act === "handoff");
  assert.equal(hand.length, 1); assert.deepEqual([hand[0].from, hand[0].to, hand[0].aid_full, hand[0].rsrc, hand[0].hop], [ASKED_MODEL, e.models[1], aid, "len", 1]);
  const marked = (r) => JSON.stringify(r.body.system).includes(NOTICE_MARK);
  assert.deepEqual(e.reqs.map(marked), [false, true, false], "the notice is appended on the first request after the handoff only");
  assert.deepEqual(bodyHashes(e.reqs[1].body), bodyHashes(e.pristine.body), "messages and tools are byte-identical after the router edit");
  assert.equal(e.reqs[1].body.system.length, e.pristine.body.system.length + 1, "ONE block appended to the array system");
  const recs = e.reqs.map((r, i) => ({ model: e.models[i], markers: { [NOTICE_MARK]: marked(r) } }));
  assert.match(evalH1({ recs, agents: e.agents, x8Reached: true, aid }), /^PASS \[next\] H1 /);
  assert.match(evalH1({ recs, agents: e.agents, x8Reached: false, aid }), /^FINDING \[next\] H1 .*notice reached the stub although X8/, "judged against what X8 showed");
  const s = await sequence(ps, "uws0-h1s");
  assert.deepEqual(s.models, [ASKED_MODEL, ASKED_MODEL, ASKED_MODEL], "shadow returns asked every time");
  assert.equal(s.agents.filter((l) => l.act === "handoff").length, 0, "shadow never hands off");
  assert.deepEqual(s.reqs.map(marked), [false, false, false], "and never edits the system prompt");
});

// ---------------------------------------------------------------- requests and arguments of the update
test("requests (T4): the experiment options leave the four default shapes alone; messages are an odd count with identical bytes on a re-send; system shapes, cache_control, the parent id, the retry count and an Agent-less tools list", () => {
  const key = fake("key");
  const base = buildRequest("sub", { key, model: "m", tag: TAG_MODEL });
  assert.equal(base.body.messages.length, 1); assert.ok(Array.isArray(base.body.system) && base.body.system.length === 2); assert.equal(base.body.tools.length, 2);
  assert.equal(base.headers["x-claude-code-parent-agent-id"], undefined); assert.equal(base.headers["x-stainless-retry-count"], undefined);
  const a = buildRequest("sub", { key, model: "m", messages: 5, agentId: "ccr-logs@session-f49cde2f", parent: "team-lead@session-f49cde2f", retryCount: 1, agentTool: false, systemCache: true });
  assert.deepEqual(a.body.messages.map((x) => x.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(a.headers["x-claude-code-agent-id"], "ccr-logs@session-f49cde2f"); assert.equal(a.headers["x-claude-code-parent-agent-id"], "team-lead@session-f49cde2f"); assert.equal(a.headers["x-stainless-retry-count"], "1");
  assert.deepEqual(a.body.tools.map((x) => x.name), ["Bash"], "no Agent tool, as a real subagent has");
  assert.deepEqual(a.body.system.map((b) => b.cache_control ?? null), [null, { type: "ephemeral" }], "cache_control on the LAST system block only");
  assert.match(JSON.stringify(a.body.system), /cc_is_subagent=true/);
  const s = buildRequest("sub", { key, model: "m", systemShape: "string" });
  assert.equal(typeof s.body.system, "string"); assert.match(s.body.system, /cc_is_subagent=true;\nYou are a synthetic sandbox agent\.$/);
  assert.equal(buildRequest("main", { key, model: "m", systemShape: "string", systemCache: true }).body.system, "You are a synthetic sandbox agent.", "cache_control is for the array shape only");
  assert.equal(JSON.stringify(buildRequest("sub", { key, model: "m", messages: 3 }).body), JSON.stringify(buildRequest("sub", { key, model: "m", messages: 3 }).body), "a re-send is byte-identical (the retry of X5)");
  assert.notEqual(JSON.stringify(buildRequest("sub", { key, model: "m", messages: 3 }).body), JSON.stringify(buildRequest("sub", { key, model: "m", messages: 5 }).body));
  for (const n of [0, 2, 4, 1.5, -1]) assert.throws(() => buildRequest("sub", { key, model: "m", messages: n }), /odd count/);
  assert.throws(() => buildRequest("sub", { key, model: "m", systemShape: "blocks" }), /unknown system shape/);
});

test("arguments (T4, T5): --host-check takes x6 only and stands alone; the default option object is unchanged; the help text names the new mode, the experiments and the not-run items", () => {
  const ok = parseArgs(["--host-check", "x6"]);
  assert.ok(ok.ok); assert.equal(ok.opts.hostCheck, "x6");
  assert.equal("hostCheck" in parseArgs([]).opts, false, "the key exists only when the flag is given");
  for (const bad of [["--host-check"], ["--host-check", "x7"], ["--host-check", "x6", "--plan"], ["--host-check", "x6", "--experiments-only"], ["--host-check", "x6", "--g1-approved"], ["--host-check", "x6", "--teardown"], ["--host-check", "x6", "--approve-plan"]]) assert.equal(parseArgs(bad).ok, false, bad.join(" "));
  const help = USAGE.join("\n");
  for (const need of ["--host-check x6", "STANDALONE", "10,000 renames of a 250 KB file", "X1 X2 X3 X4 X5 X7 X8 X9a-X9e", "X7 is REQUIRED", "H1", "X9f (PARKED", "X9g, X9h", "scenario suite S2d", "OpenAI-converted path of X8"]) assert.ok(help.includes(need), `--help lacks: ${need}`);
});

test("plan (T5): the plan names every new experiment, the hot edits, the duration, the NOT-RUN and PARKED lines and the new files it writes; it is deterministic, changes with the router choice and the guard choice, and each variant has its own sha256", async () => {
  const spec = buildSpec({ PATH: "x" });
  const text = renderPlan(spec, { router: "both", ccr: CCR_FAKE }).join("\n");
  for (const e of EXPERIMENTS) assert.ok(text.includes(`${e.id.padEnd(4)} [${e.router}]`), `plan lacks experiment ${e.id}`);
  for (const id of ["X1", "X2", "X3", "X4", "X5", "X7", "X8", "X9a", "X9b", "X9c", "X9d", "X9e", "H1"]) assert.ok(EXPERIMENTS.some((e) => e.id === id), `EXPERIMENTS lacks ${id}`);
  for (const need of ["HOT EDITS of the SANDBOX config", "Router.fallback (off, then model-chain with the ONE model uwstub/m-free", "restored to its original value at the end and read back through assertRouterClean", "DURATION", "NOT RUN / PARKED (stated, not hidden)", "PARKED X9f", "NOT-RUN X9g and X9h", "NOT-RUN X8 on the OpenAI-converted path", "NOT-RUN X6 here", "--host-check x6",
    "agents.jsonl", "status-<w>.json", "probe mode: mutate, observe, keep-tag, clear-tag, timer, sys-string, sys-array, registry", "ENFORCE variant for H1", "X7 must not FAIL", "H1 is informational", "sandbox-router-fallback", "the system SHAPE (string, array or absent)", "retry-after is a header it SENDS, never one it records"]) assert.ok(text.includes(need), `plan lacks: ${need}`);
  for (const n of NOT_RUN) assert.ok(text.includes(n), "the plan carries every NOT_RUN line");
  assert.equal(OPERATING_NOTES.length, 9, "the operating notes are unchanged");
  const a = planOf(spec, { router: "both", ccr: CCR_FAKE }), b = planOf(spec, { router: "both", ccr: CCR_FAKE });
  assert.equal(a.sha, b.sha); assert.deepEqual(a.lines, b.lines);
  const probeOnly = planOf(spec, { router: "probe", ccr: CCR_FAKE }).sha, noGuard = planOf(buildSpec({ PATH: "x" }, { preloadGuard: false }), { router: "both", ccr: CCR_FAKE }).sha;
  assert.equal(new Set([a.sha, probeOnly, noGuard]).size, 3, "default, --router probe and --no-preload-guard are three different approvals");
  const out = [];
  const traps = { fs: new Proxy({}, { get: () => () => { throw new Error("--plan touched fs"); } }), hashFiles: () => hashExecutedFiles(), ccrInstall: () => CCR_FAKE, out: (s) => out.push(s), err: (s) => out.push(`ERR ${s}`), env: { PATH: "C:\\x" } };
  assert.equal(await runE2e(["--plan", "--router", "probe"], traps), 0);
  assert.match(out.at(-1), /^plan sha256: [0-9a-f]{64}$/);
  assert.equal(out.at(-1).split(": ")[1], sha(renderPlan(buildSpec(traps.env, { preloadGuard: true }), { router: "probe", ccr: CCR_FAKE }).join("\n")), "the printed hash is the sha256 of the plan text of that variant");
});

// ---------------------------------------------------------------- X6, the standalone host check (T4)
function fakeX6Fs({ eperm = [], ebusy = [], tornAt = [], readErr = [], outside = false } = {}) {
  const log = { mkdtemp: [], writes: [], renames: [], rm: [], reads: 0 }, files = new Map();
  let n = 0;
  const err = (code) => Object.assign(new Error(code), { code });
  const promises = {
    mkdtemp: async (prefix) => { const d = outside ? "C:\\elsewhere\\uw-x6-abc" : `${prefix}${++n}`; log.mkdtemp.push(d); return d; },
    writeFile: async (p, b) => { log.writes.push(p); files.set(p, Buffer.from(b)); },
    rename: async (a, b) => { const i = log.renames.length + 1; log.renames.push([a, b]); if (eperm.includes(i)) throw err("EPERM"); if (ebusy.includes(i)) throw err("EBUSY"); files.set(b, files.get(a)); files.delete(a); },
    readFile: async (p) => { log.reads++; if (readErr.includes(log.reads)) throw err("EBUSY"); const b = Buffer.from(files.get(p)); if (tornAt.includes(log.reads)) b[b.length - 1] ^= 0xff; return b; },
    rm: async (p) => { log.rm.push(p); },
  };
  return { fsx: { promises }, log };
}

test("host check X6 (T4): counts EPERM, EBUSY, other errors and torn reads with a concurrent reader, works only inside one fresh uw-x6- directory under the temp dir and removes it, and states the verdict", async () => {
  const tmp = path.join(os.tmpdir(), "fake-x6-root");
  const out = [];
  const w = fakeX6Fs({ eperm: [2, 5], ebusy: [7], tornAt: [3], readErr: [4] });
  const res = await hostCheckX6({ fsx: w.fsx, tmpdir: tmp, renames: 20, bytes: 64, out: (l) => out.push(l) });
  assert.equal(res.done, 17, "20 renames, 3 failed");
  assert.deepEqual(res.renameErrors, { EPERM: 2, EBUSY: 1 }); assert.deepEqual(res.readErrors, { EBUSY: 1 });
  assert.ok(res.reads >= 1 && res.torn === 1, `one torn read was injected and found (reads ${res.reads}, torn ${res.torn})`);
  assert.equal(w.log.mkdtemp.length, 1); assert.ok(w.log.mkdtemp[0].startsWith(path.join(tmp, "uw-x6-")));
  for (const p of [...w.log.writes, ...w.log.renames.flat()]) assert.ok(p.startsWith(w.log.mkdtemp[0]), `touched only its own directory: ${p}`);
  assert.deepEqual(w.log.rm, [w.log.mkdtemp[0]], "the directory is removed, and only that one");
  assert.match(out[0], /^X6 host check: 17 of 20 renames of 64 bytes completed in [\d.]+ s with a concurrent reader \(\d+ reads\)$/);
  assert.match(out[1], /^X6 rename errors: EPERM 2, EBUSY 1, other 0 \(EPERM=2 EBUSY=1\)$/);
  assert.match(out[2], /^X6 reader errors: EPERM 0, EBUSY 1, other 0 \(EBUSY=1\); torn reads 1 of \d+$/);
  assert.match(out[3], /^X6 verdict \(informational\): EPERM, EBUSY or torn reads OBSERVED/);
  const clean = fakeX6Fs(), out2 = [];
  const r2 = await hostCheckX6({ fsx: clean.fsx, tmpdir: tmp, renames: 10, bytes: 32, out: (l) => out2.push(l) });
  assert.equal(r2.done, 10); assert.equal(r2.torn, 0); assert.deepEqual(r2.renameErrors, {});
  assert.match(out2[3], /^X6 verdict \(informational\): no EPERM, EBUSY or torn read on this host/);
  const spyOut = fakeX6Fs({ outside: true });
  await assert.rejects(hostCheckX6({ fsx: spyOut.fsx, tmpdir: tmp, renames: 1, bytes: 32 }), /x6 refused: .* is not a fresh uw-x6- directory under/);
  assert.equal(spyOut.log.writes.length, 0, "nothing was written in a directory outside the temp dir"); assert.deepEqual(spyOut.log.rm, [], "and nothing was removed there");
  assert.deepEqual(X6_DEFAULTS, { renames: 10000, bytes: 250 * 1024 });
});

test("host check X6 (T4): --host-check x6 through runE2e needs no approval, no spec and no daemon and touches nothing but its own temp directory; a REAL run on a small count in a fresh mkdtemp tree finds no torn read", async () => {
  const w = fakeX6Fs(), out = [], errs = [];
  const boom = (n) => () => { throw new Error(`--host-check touched ${n}`); };
  const code = await runE2e(["--host-check", "x6"], { x6: { fsx: w.fsx, tmpdir: path.join(os.tmpdir(), "fake-x6-root"), renames: 6, bytes: 32 }, out: (s) => out.push(s), err: (s) => errs.push(s),
    rpc: boom("rpc"), runStep: boom("runStep"), fetch: boom("fetch"), createStub: boom("createStub"), makeTripwire: boom("makeTripwire"), hashFiles: boom("hashFiles"), ccrInstall: boom("ccrInstall"), onSignal: boom("onSignal"), ask: boom("ask"), interactive: boom("interactive"),
    sys: new Proxy({}, { get: () => boom("sys") }), guard: new Proxy({}, { get: () => boom("guard") }), env: { PATH: "x" } });
  assert.equal(code, 0, errs.join("\n")); assert.equal(out.length, 4); assert.match(out[0], /^X6 host check: 6 of 6 renames/);
  const bad = await runE2e(["--host-check", "x6"], { x6: { fsx: fakeX6Fs({ outside: true }).fsx, tmpdir: path.join(os.tmpdir(), "fake-x6-root"), renames: 1, bytes: 32 }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(bad, 1); assert.match(errs.join("\n"), /host check x6 failed: x6 refused/);
  const root = mk(), real = [];
  const r = await hostCheckX6({ tmpdir: root, renames: 40, bytes: 4096, out: (l) => real.push(l) });
  assert.equal(r.done + Object.values(r.renameErrors).reduce((a, b) => a + b, 0), 40, "every rename was either counted done or counted as an error (an EPERM from the open reader is what X6 measures)");
  assert.equal(r.torn, 0, "an atomic rename never shows a torn file to a reader");
  assert.deepEqual(fs.readdirSync(root), [], "the directory it made is gone");
});

test("flow (T4): every hot edit is checked locally BEFORE it is sent: a persisted fallback with a non-stub model or an unknown mode refuses the run at the first edit, with no swap saved and the sandbox config otherwise untouched", async () => {
  const bad = await run([...GO, "--router", "probe"], { startFallback: { mode: "model-chain", models: ["anthropic/claude-sonnet-5"] } });
  assert.equal(bad.code, 1); assert.match(bad.err, /x1-edit: a fallback model is not a uwstub\/\* selector/);
  assert.equal(bad.w.fbSeen.length, 1, "only the configure step saved: no edit with that payload was sent");
  const odd = await run([...GO, "--router", "probe"], { startFallback: { mode: "weird", models: [] } });
  assert.equal(odd.code, 1); assert.match(odd.err, /x1-edit: Router\.fallback\.mode "weird" is not off, retry or model-chain/);
  const wrongPath = await run([...GO, "--router", "probe"], { editedRouterPath: "C:\\Users\\osami\\.uw\\spike\\uw-router.cjs" });
  assert.equal(wrongPath.code, 1); assert.match(wrongPath.err, /x1-edit: the config's CUSTOM_ROUTER_PATH is not the scratch copy/);
  assert.equal(wrongPath.w.calls.rpc.filter((m) => m === "saveConfig").length, 1, "only the provider save of the configure step happened");
});

test("flow (T4): a daemon that rejects one X9 swap makes that mode unmeasured (naming the error) and the run continues, restoring Router.fallback; a gateway that re-binds after the X1 edit is retried, one that never comes back leaves X1 unmeasured", async () => {
  const rej = await run([...GO, "--router", "probe"], { rejectSwap: "retry" });
  assert.equal(rej.code, 0, rej.err + rej.out.slice(-300));
  assert.match(lineOf(rej.out, "X9a"), /^FINDING \[probe\] X9a unmeasured: .*\(swap errors: retry: saveConfig failed: boom\)/);
  assert.match(lineOf(rej.out, "X9b"), /^FINDING \[probe\] X9b only 12 of 18 cases .*\(swap errors: retry: saveConfig failed: boom\)/);
  assert.equal(rej.w.fbSeen.filter((m) => m !== null).at(-1), "off", "restored after the rejected swap");
  assert.equal(kindOf(rej.out, "X9c"), "PASS"); assert.equal(kindOf(rej.out, "X8"), "PASS", "the other experiments are not affected");
  const rb = await run([...GO, "--router", "probe"], { rebindAfterEdit: 2 });
  assert.equal(rb.code, 0, rb.err); assert.equal(rb.w.failedFetches, 2, "two calls hit the re-binding gateway");
  assert.equal(kindOf(rb.out, "X1"), "PASS", lineOf(rb.out, "X1"));
  const gone = await run([...GO, "--router", "probe"], { rebindAfterEdit: 99 });
  assert.match(lineOf(gone.out, "X1"), /^FINDING \[probe\] X1 unmeasured: fewer than three probe lines/, "a gateway that never answers after the edit leaves X1 unmeasured, never PASS");
  assert.equal(gone.w.cfg.Providers[0]?.models.length, 3, "the X1 edit was undone even though the gateway stayed down");
});

// ================================================================ fix round for the S0 harness (review findings F1-F10): each behaviour fix has a regression test that FAILS on the old code and the case it must not break
const evidenceOf = (w) => [...w.mem.files.entries()].filter(([k]) => k.startsWith(norm(EVIDENCE_ROOT) + path.sep));
const evText = (w, name) => String(evidenceOf(w).find(([k]) => path.basename(k) === name)?.[1] ?? "");
const wrapRpc = (d, hook) => { const orig = d.rpc; d.rpc = (m, a) => hook(m, a, orig); };

test("F1: a fatal guard error in X1 keeps every line already computed (A0 E4 E5 E12 E7 E13), says so, exits 1, tears down, and the evidence holds the lines, probe.jsonl and the stub records (sizes and hashes only, no bodies)", async () => {
  const { w, d } = world({});
  let n = 0; const real = d.guard.assertPayloadIsolated;
  d.guard.assertPayloadIsolated = (...a) => { if (++n >= 2) throw new Error("ISOLATION VIOLATION: x1 payload"); return real(...a); };
  const r = await go(w, d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1);
  for (const id of ["A0", "E4", "E5", "E12", "E7", "E13"]) assert.ok(lineOf(r.out, id), `${id} was discarded by the throw`);
  assert.equal(kindOf(r.out, "A0"), "PASS"); assert.equal(lineOf(r.out, "X1"), undefined, "X1 itself never got a line");
  assert.match(r.out, /the run stopped before its verdict: 6 result lines were already emitted above \(.*PASS \d+.*\); they are kept in the retained evidence as result-lines\.txt/);
  assert.match(r.err, /FAILED: ISOLATION VIOLATION: x1 payload/);
  assert.deepEqual(w.calls.stopProcess, [5001, 5000], "the teardown ran");
  const lines = evText(w, "result-lines.txt").trim().split("\n");
  assert.equal(lines.length, 6); assert.match(lines[0], /^PASS \[probe\] A0 /);
  assert.ok(evText(w, "probe.jsonl.txt").includes('"mode"'), "probe.jsonl is kept");
  const clean = await run([...GO, "--router", "probe"], {});
  assert.deepEqual(evidenceOf(clean.w), [], "a clean run retains nothing");
});

test("F1, F5a: a fatal error inside the X9 swap loop (a tripwire throw right after the model-chain swap) still restores Router.fallback, then aborts with exit 1, and the lines through X8 plus the cases measured so far are kept", async () => {
  const r = await run([...GO, "--router", "probe"], { tripwireAt: "e2e:after-x9-model-chain" });
  assert.equal(r.code, 1);
  assert.match(r.err, /FAILED: ISOLATION VIOLATION: e2e:after-x9-model-chain/);
  const seen = r.w.fbSeen.filter((m) => m !== null);
  assert.equal(seen.at(-1), "off", "the restore ran after the swap that threw"); assert.ok(seen.includes("model-chain"));
  assert.equal(r.w.cfg.Router.fallback.mode, "off");
  for (const id of ["A0", "E4", "E7", "E13", "X1", "X2", "X3", "X4", "X5", "X7", "X8"]) assert.ok(lineOf(r.out, id), `${id} kept`);
  assert.equal(lineOf(r.out, "X9a"), undefined, "no X9 verdict was computed");
  assert.match(r.out, /X9 off\s+ra3\s+client status 429/, "the off cases measured before the throw are printed");
  assert.match(evText(r.w, "result-lines.txt"), /X8 /);
  const stubText = evText(r.w, "stub-records.jsonl.txt");
  assert.ok(stubText.length > 0 && /"bodyBytes":\d+/.test(stubText) && /"messagesSha256":"/.test(stubText) && /"headerNames":\[/.test(stubText), "the stub records are kept as sizes, hash fields (the redactor masks long hex) and header names");
  for (const leak of ["agentToolDescription", "x-api-key", ASCII_KEY, "hello"]) assert.ok(!stubText.includes(leak), `the stub evidence must not carry ${leak}`);
  // the case it must not break: a swap the daemon merely REJECTS (an ordinary error) still only makes that mode unmeasured and the run goes on
  const rej = await run([...GO, "--router", "probe"], { rejectSwap: "retry" });
  assert.equal(rej.code, 0, rej.err); assert.ok(lineOf(rej.out, "X9a"));
});

test("F1: a failed restore in X9 (assertRouterClean refuses the persisted config after the swap) keeps A0..X8, prints FAIL X9a, exits 1 and the evidence holds the lines", async () => {
  const { w, d } = world({ startFallback: { mode: "off", models: [] } });
  d.guard.assertRouterClean = realAssertRouterClean;
  let afterSwap = false;
  wrapRpc(d, async (m, a, orig) => { if (m === "saveConfig" && a[0].Router?.fallback?.mode === "retry") afterSwap = true; const v = await orig(m, a); if (m === "getConfig" && afterSwap) { const c = structuredClone(v); c.Router.fallback = { mode: "model-chain", models: ["uwstub/m-free"], retryCount: 1 }; return c; } return v; });
  const r = await go(w, d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL \[probe\] X9a Router\.fallback could NOT be restored to its original value in the sandbox config: ISOLATION VIOLATION: Router\.fallback\.mode="model-chain"/);
  for (const id of ["A0", "E4", "E7", "E13", "X1", "X8"]) assert.ok(lineOf(r.out, id), `${id} kept`);
  assert.match(evText(w, "result-lines.txt"), /PASS \[probe\] A0 /);
});

test("F2: the restore is read back on a FRESH getConfig: a saveConfig echo that says off while the daemon persisted a model-chain is caught (FAIL X9a, exit 1); a clean persisted config stays green", async () => {
  const bad = world({ startFallback: { mode: "off", models: [] }, restoreDoesNotPersist: true });
  bad.d.guard.assertRouterClean = realAssertRouterClean;
  const r = await go(bad.w, bad.d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1, "the echo said off, the persisted value did not");
  assert.match(r.out, /FAIL \[probe\] X9a Router\.fallback could NOT be restored.*model-chain/);
  const ok = world({ startFallback: { mode: "off", models: [] } });
  ok.d.guard.assertRouterClean = realAssertRouterClean;
  const g = await go(ok.w, ok.d, [...GO, "--router", "probe"]);
  assert.equal(g.code, 0, g.err + g.out.slice(-400)); assert.equal(kindOf(g.out, "X9a"), "PASS");
  assert.equal(ok.w.calls.rpc.filter((m) => m === "getConfig").length > 5, true);
});

test("F2: a leftover chain that only the END-OF-RUN proof can see (the restore's own read-back was fooled) makes the proof RED and the run exit 1; a clean config reads green at every proof", async () => {
  const { w, d } = world({ startFallback: { mode: "off", models: [] }, restoreDoesNotPersist: true });
  d.guard.assertRouterClean = realAssertRouterClean;
  let hide = false;
  wrapRpc(d, async (m, a, orig) => {
    if (m === "saveConfig" && a[0].Router?.fallback?.mode === "off" && w.everSwapped) hide = true;
    const v = await orig(m, a);
    if (m === "getConfig" && hide) { hide = false; const c = structuredClone(v); c.Router.fallback = { mode: "off", models: [] }; return c; }   // only the restore's read-back is shown the clean value
    return v;
  });
  const r = await go(w, d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /isolation NOT proven: .*persisted Router\.fallback read back on a FRESH getConfig .*model-chain/);
  assert.match(r.out, /RED +\d+ persisted Router\.fallback read back on a FRESH getConfig/);
  const good = world({ startFallback: { mode: "off", models: [] } });
  good.d.guard.assertRouterClean = realAssertRouterClean;
  const g = await go(good.w, good.d, GO);
  assert.equal(g.code, 0, g.err);
  assert.ok((g.out.match(/GREEN +\d+ persisted Router\.fallback read back on a FRESH getConfig/g) ?? []).length >= 3, "after provider save, after the probe run and after the next run");
});

test("F2: proveIsolation reads Router.fallback FRESH: a leftover chain, retry, a chain model under off or an enabled rule is RED; an absent fallback is recorded before the swap step and RED after it; pre-provider and a caller without the seam skip it", async () => {
  const off = { mode: "off", models: [] };
  const clean = await proveTree({ getConfig: async () => ({ Router: { fallback: off } }), swapRan: true });
  assert.equal(clean.res.ok, true, JSON.stringify(clean.res.checks.filter((c) => !c.ok))); assert.equal(clean.fallback.ok, true); assert.match(clean.fallback.detail, /mode off, 0 chain models, swap step has run/);
  for (const [name, cfg, ran] of [["model-chain after the swap", { Router: { fallback: { mode: "model-chain", models: ["uwstub/m-free"], retryCount: 1 } } }, true], ["model-chain before the swap", { Router: { fallback: { mode: "model-chain", models: ["uwstub/m-free"] } } }, false],
    ["retry", { Router: { fallback: { mode: "retry", models: [], retryCount: 1 } } }, true], ["off with a chain model", { Router: { fallback: { mode: "off", models: ["uwstub/m-free"] } } }, true], ["an enabled rule", { Router: { fallback: off, rules: [{ id: "r1", enabled: true }] } }, true],
    ["an unknown mode", { Router: { fallback: { mode: "weird", models: [] } } }, false]]) {
    const t = await proveTree({ getConfig: async () => cfg, swapRan: ran });
    assert.equal(t.fallback.ok, false, name); assert.equal(t.res.ok, false, name);
    assert.throws(() => assertIsolationProven(t.res), /isolation NOT proven: .*persisted Router\.fallback read back on a FRESH getConfig/, name);
  }
  const absentBefore = await proveTree({ getConfig: async () => ({}), swapRan: false });
  assert.equal(absentBefore.fallback.ok, true); assert.equal(absentBefore.fallback.recorder, true); assert.match(absentBefore.fallback.detail, /absent in the fresh config \(recorded, not judged before the swap step/);
  const absentAfter = await proveTree({ getConfig: async () => ({ Router: {} }), swapRan: true });
  assert.equal(absentAfter.fallback.ok, false); assert.match(absentAfter.fallback.detail, /ABSENT after the swap step/);
  const thrown = await proveTree({ getConfig: async () => { throw new Error("rpc boom"); }, swapRan: true });
  assert.equal(thrown.fallback.ok, false); assert.match(thrown.fallback.detail, /threw: rpc boom/);
  let asked = 0;
  const pre = await proveTree({ phase: "pre-provider", getConfig: async () => { asked++; return {}; } });
  assert.equal(pre.fallback, undefined); assert.equal(asked, 0, "the bare pre-provider config is not asked");
  assert.equal((await proveTree({})).fallback, undefined, "no getConfig seam: no such check (the orchestrator always passes it)");
});

test("F3: X7 needs the SAME worker for the timer call and the next call (and the timer line from that worker); different pids are a FINDING 'undecidable', never a PASS; the same pid still PASSes", async () => {
  const A = cl({ n: 5, pid: 100, timer: true, t: "2026-10-05T00:00:00.000Z" }), B = cl({ n: 1, pid: 200, m: 1, t: "2026-10-05T00:00:00.050Z" });
  const T = { kind: "timer", of: 5, pid: 100, t: "2026-10-05T00:00:00.800Z" };
  const v = evalX7({ log: [A, B, T] });
  assert.match(v, /^FINDING \[probe\] X7 X7 undecidable: calls served by different workers \(pid 100 for the timer call, pid 200 for the next\)/);
  assert.match(evalX7({ log: [A, { ...B, pid: 100, n: 6 }, T] }), /^PASS \[probe\] X7 /, "the same worker passes");
  assert.match(evalX7({ log: [A, { ...B, pid: 100, n: 6 }, { ...T, pid: 200 }] }), /^FAIL \[probe\] X7 .*did NOT fire/, "a timer line from another process is not this call's timer");
  const r = await run([...GO, "--router", "probe"], { workers: [5000, 5001] });
  assert.equal(r.code, 0, r.err); assert.equal(kindOf(r.out, "X7"), "FINDING"); assert.match(lineOf(r.out, "X7"), /different workers/);
  assert.equal(kindOf((await run([...GO, "--router", "probe"], {})).out, "X7"), "PASS");
});

test("F4: empty or partial evidence is never a vacuous PASS: X9b counts ANSWERED cases, X9e is unmeasured without an answer, X3 is unmeasured when the client got no status, X4 says 'no upstream record'", async () => {
  const dead = x9ev(); for (const c of dead.cases) { c.status = null; c.attempts = 0; c.routerCalls = 0; c.headers = {}; }
  assert.match(evalX9b(dead), /^FINDING \[probe\] X9b only 0 of 18 cases .*answered: the table is incomplete/);
  const half = x9ev(); for (const c of half.cases.slice(0, 8)) c.status = null;
  assert.match(evalX9b(half), /^FINDING \[probe\] X9b only 10 of 18 cases .*answered/);
  assert.match(evalX9b(x9ev()), /^PASS \[probe\] X9b 18 of 18 cases answered /, "the case it must not break: 18 answered cases pass");
  const ra = x9ev(); ra.cases.find((c) => c.mode === "off" && c.id === "ra3").status = null;
  assert.match(evalX9e(ra), /^FINDING \[probe\] X9e unmeasured: .*no HTTP answer/);
  assert.doesNotMatch(evalX9e(dead), /did NOT forward|Claude Code never sees/);
  assert.match(evalX9e(x9ev()), /^PASS \[probe\] X9e /, "answered and forwarded still passes");
  assert.match(evalX9e(strip9()), /^FINDING \[probe\] X9e with the fallback off CCR did NOT forward/, "answered and NOT forwarded is still the finding");
  const step = (sent, status, routerRetry) => ({ sent, status, headers: {}, routerRetry, upstream: 1, upRetry: null });
  assert.match(evalX3({ cases: [{ name: "429", steps: [step(0, null, "0"), step(1, null, "1")] }] }), /^FINDING \[probe\] X3 unmeasured: the client got no HTTP answer to 429/);
  assert.match(evalX3({ cases: [{ name: "429", steps: [step(0, 429, "0"), step(1, null, "1")] }] }), /^FINDING \[probe\] X3 unmeasured: the client got no HTTP answer to 429/, "one missing answer is enough");
  assert.doesNotMatch(evalX3({ cases: [{ name: "429", steps: [step(0, null, "0"), step(1, null, "1")] }] }), /client saw ,/);
  assert.match(evalX3({ cases: [{ name: "429", steps: [step(0, 429, "0"), step(1, 200, "1")] }] }), /^PASS \[probe\] X3 429: .*client saw 429,200/);
  const probeHdr = { hdr: { aid: AT, par: AT, sid: { len: 6, at: false, ok: true, form: "a-9" } } };
  assert.match(evalX4({ probe: probeHdr, sent: { agentId: "x" } }), /no upstream record \(whether the agent id is forwarded upstream is unmeasured\)/);
  assert.match(evalX4({ probe: probeHdr, stubRec: { headers: {} } }), /; not forwarded upstream/, "with a record and no header it still says not forwarded");
  assert.match(evalX4({ probe: probeHdr, stubRec: { headers: { "x-claude-code-agent-id": "a" } } }), /; forwarded upstream/);
  // and through the flow: a gateway that never answers leaves the experiments unmeasured, never PASS
  const none = await run([...GO, "--router", "probe"], { rebindAfterEdit: 0 });
  assert.equal(none.code, 0, none.err);
});
const strip9 = () => { const s = x9ev(); for (const c of s.cases) c.headers = {}; return s; };

test("F5b: editSandboxConfig checks the payload BEFORE sending it, the persisted result AFTER the save, and that every provider is the stub (uwstub at 127.0.0.1:<stub port>) only", async () => {
  const pre = world({}); let n = 0; const realP = pre.d.guard.assertPayloadIsolated;
  pre.d.guard.assertPayloadIsolated = (...a) => { if (++n >= 2) throw new Error("ISOLATION VIOLATION: edit payload"); return realP(...a); };
  const p = await go(pre.w, pre.d, [...GO, "--router", "probe"]);
  assert.equal(p.code, 1); assert.match(p.err, /edit payload/); assert.equal(p.w.calls.rpc.filter((m) => m === "saveConfig").length, 1, "the refused edit was never sent");
  const post = world({}); let k = 0;
  post.d.guard.assertIsolatedConfig = async (c) => { if (c && ++k >= 2) throw new Error("ISOLATION VIOLATION: persisted edit"); };
  const q = await go(post.w, post.d, [...GO, "--router", "probe"]);
  assert.equal(q.code, 1); assert.match(q.err, /persisted edit/); assert.equal(q.w.calls.rpc.filter((m) => m === "saveConfig").length, 2, "the edit WAS saved, then the persisted result was refused");
  const prov = world({}); let saves = 0;
  wrapRpc(prov.d, async (m, a, orig) => { if (m === "saveConfig") saves++; const v = await orig(m, a); if (m === "getConfig" && saves >= 1) v.Providers = [...(v.Providers ?? []), { name: "other", api_base_url: "https://example.invalid", models: ["x"], enabled: true }]; return v; });
  const s = await go(prov.w, prov.d, [...GO, "--router", "probe"]);
  assert.equal(s.code, 1); assert.match(s.err, /x1-edit: a provider other than the sandbox stub \(uwstub at 127\.0\.0\.1:39459\) is in the config/); assert.equal(saves, 1, "nothing was sent");
  const wrongUrl = world({}); let sv = 0;
  wrapRpc(wrongUrl.d, async (m, a, orig) => { if (m === "saveConfig") sv++; const v = await orig(m, a); if (m === "getConfig" && sv >= 1) v.Providers[0].api_base_url = "http://127.0.0.1:3456"; return v; });
  const u = await go(wrongUrl.w, wrongUrl.d, [...GO, "--router", "probe"]);
  assert.equal(u.code, 1); assert.match(u.err, /a provider other than the sandbox stub/, "the stub provider pointing anywhere else is refused too");
  const fine = await run([...GO, "--router", "probe"], {});
  assert.equal(fine.code, 0, "the case it must not break: the stub-only config edits as before");
});

test("F5c: the stub binds the IPv4 loopback address only (the server address is 127.0.0.1) and refuses any other host", async () => {
  const s = createStub({ port: 0 });
  assert.equal(s.address(), null, "not listening before start");
  const port = await s.start();
  try {
    const a = s.address();
    assert.equal(a.address, "127.0.0.1"); assert.equal(a.family, "IPv4"); assert.equal(a.port, port);
    assert.equal(STUB_HOST, "127.0.0.1");
  } finally { await s.stop(); }
  for (const bad of ["0.0.0.0", "::", "localhost", "::1", "192.168.1.5", ""]) assert.throws(() => createStub({ port: 0, host: bad }), /stub host .* is not 127\.0\.0\.1: the stub binds loopback only/, String(bad));
  assert.throws(() => assertStubHost("0.0.0.0"), /loopback only/); assert.doesNotThrow(() => assertStubHost("127.0.0.1"));
  assert.match(fs.readFileSync(path.join(HARNESS_DIR, "stub-upstream.mjs"), "utf8"), /server\.listen\(\{ port, host \}/, "listen takes the validated host, no literal elsewhere");
});

test("F6: the plan carries the NOT-RUN X3 (b)(c)(d)(f) line and the stub prose no longer reads as coverage; the run prints it", async () => {
  const line = "NOT-RUN X3 (b)(c)(d)(f): Retry-After 5/90, repeated 529, stream cut: need the real client; the stub can send them";
  assert.ok(NOT_RUN.includes(line));
  const text = renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n");
  assert.ok(text.includes(`  ${line}`)); assert.match(text, /It CAN script per-request answers .* but this run exercises only 429 \(Retry-After 3, 3600 and none\), 503, 400, 413 and 502: Retry-After 5 and 90, a repeated 529 and a stream cut have NO synthetic run \(see NOT-RUN X3 below\), so the list is a capability, not coverage/);
  const r = await run([...GO, "--router", "probe"], {});
  assert.ok(r.out.split("\n").includes(line), "printed after the probe run");
});

test("F7: the plan text states the expected duration (about 8-15 min, estimated, not measured), the worst case (18 X9 cases at the 150 s ceiling = 45 min), the whole-config saveConfig round trip and the RPC timeout", () => {
  const text = renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n");
  for (const need of ["DURATION: expected about 8-15 minutes, ESTIMATED from CCR's 60 s Retry-After clamp", "NOT MEASURED", "WORST CASE: the 18 X9 cases at the 150 s request ceiling are 45 minutes", "every sandbox web RPC call a 120 s timeout", "fails the run CLOSED (teardown, evidence)",
    "Each hot edit round-trips the WHOLE sandbox config through saveConfig and may restart the sandbox gateway", "trigger the desktop sync into the scratch Claude-3p"]) assert.ok(text.includes(need), `plan lacks: ${need}`);
  assert.ok(!text.includes("the run has no other timeout"), "the old claim is gone");
  assert.equal(18 * 150 / 60, 45);
});

test("F7: config.rpc has a per-call timeout (120 s default, overridable only through its third argument) that throws RpcTimeoutError; any other failure is not wrapped; the timeout is FATAL in the run (exit 1, teardown, evidence), not an 'unmeasured' swap", async () => {
  const svc = JSON.stringify({ pid: 1234, url: `http://127.0.0.1:${WEB_PORT}/?ccr_web_token=${WEB_AUTH_TOKEN}` });
  const e1 = mock.method(fs, "existsSync", (p) => (path.resolve(String(p)) === path.resolve(CCR_SERVICE_JSON) ? true : e1.mock.original(p)));
  const r1 = mock.method(fs, "readFileSync", (p, ...a) => (path.resolve(String(p)) === path.resolve(CCR_SERVICE_JSON) ? svc : r1.mock.original(p, ...a)));
  const seen = [];
  const f1 = mock.method(globalThis, "fetch", (url, init) => new Promise((_, reject) => { seen.push(init); init.signal.addEventListener("abort", () => reject(init.signal.reason)); }));
  try {
    assert.equal(config.RPC_TIMEOUT_MS, 120000);
    await assert.rejects(config.rpc("saveConfig", [{}], { timeoutMs: 30 }), (e) => e instanceof config.RpcTimeoutError && e.name === "RpcTimeoutError" && /^saveConfig timed out after 30 ms/.test(e.message));
    assert.ok(seen[0].signal instanceof AbortSignal && seen[0].redirect === "error");
    f1.mock.restore();
    const f2 = mock.method(globalThis, "fetch", async (url, init) => { seen.push(init); throw new TypeError("fetch failed"); });
    await assert.rejects(config.rpc("getConfig"), (e) => e instanceof TypeError && !(e instanceof config.RpcTimeoutError));
    f2.mock.restore();
    const f3 = mock.method(globalThis, "fetch", async (url, init) => { seen.push(init); return { json: async () => ({ ok: true, value: 7 }) }; });
    assert.equal(await config.rpc("getConfig"), 7, "a prompt answer still works"); assert.ok(seen.at(-1).signal instanceof AbortSignal);
    f3.mock.restore();
  } finally { f1.mock.restore(); r1.mock.restore(); e1.mock.restore(); }
  // in the run: a timed-out saveConfig at an X9 swap stops the run, restores, tears down and keeps the evidence (an ordinary rejected swap stays 'unmeasured': see the T4 test)
  const { w, d } = world({});
  wrapRpc(d, async (m, a, orig) => { if (m === "saveConfig" && a[0].Router?.fallback?.mode === "model-chain") throw new config.RpcTimeoutError("saveConfig timed out after 120000 ms (no answer from the sandbox web RPC)"); return orig(m, a); });
  const r = await go(w, d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1); assert.match(r.err, /FAILED: saveConfig timed out after 120000 ms/);
  assert.equal(lineOf(r.out, "X9a"), undefined, "not reported as an unmeasured X9");
  assert.equal(w.fbSeen.filter((m) => m !== null).at(-1), "off", "the restore ran"); assert.deepEqual(w.calls.stopProcess, [5001, 5000]);
  assert.match(evText(w, "result-lines.txt"), /X8 /);
});

test("F8: the CCR install section hashes every dist/main/*.js (names and sha256, sorted), lists .bak-* files by name and size as present-not-loaded WITHOUT reading them, and a changed loaded file changes the plan hash while a .bak with the same name and size does not", () => {
  const root = mk(), main = path.join(root, "nodejs", "node_modules", "@fake", "claude-code-router", "dist", "main"), pkgDir = path.join(root, "nodejs", "node_modules", "@fake", "claude-code-router"), nodejs = path.join(root, "nodejs");
  fs.mkdirSync(main, { recursive: true });
  fs.writeFileSync(path.join(nodejs, "ccr.cmd"), '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@fake\\claude-code-router\\dist\\main\\cli.js" %*\r\n');
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "@fake/claude-code-router", version: "9.9.9" }));
  const files = { "cli.js": "cli", "gateway-bootstrap.js": "gb", "route-script-worker.js": "rsw", "request-log-worker.js": "rlw", "notes.txt": "n", "cli.js.bak-old": "OLDCLI", "cli.js.bak-timeout": "TT" };
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(main, n), c);
  fs.mkdirSync(path.join(main, "sub.js"));                               // a directory named like a script is not a file
  const env = { PATH: nodejs };
  const reads = [];
  const spyFs = { ...fs, readFileSync: (p, ...a) => { reads.push(String(p)); return fs.readFileSync(p, ...a); } };
  const c1 = resolveCcrInstall({ env, fsx: spyFs });
  assert.equal(c1.found, true);
  assert.deepEqual(c1.dist.loaded, ["cli.js", "gateway-bootstrap.js", "request-log-worker.js", "route-script-worker.js"].map((n) => ({ name: n, sha: sha(files[n]) })), "every dist/main/*.js, sorted, hashed");
  assert.deepEqual(c1.dist.baks, [{ name: "cli.js.bak-old", size: 6 }, { name: "cli.js.bak-timeout", size: 2 }]);
  assert.ok(!reads.some((p) => /\.bak-/.test(p)), "a .bak-* file is never read");
  assert.ok(!reads.some((p) => /notes\.txt/.test(p)), "only *.js is hashed");
  const txt = ccrInstallLines(c1).join("\n");
  assert.match(txt, /dist\/main\/\*\.js  4 files the daemon can load, sha256 each \(sorted by name\):/);
  for (const n of ["gateway-bootstrap.js", "route-script-worker.js", "request-log-worker.js"]) assert.ok(txt.includes(`${n}  sha256 ${sha(files[n])}`), n);
  assert.match(txt, /present, NOT loaded, not hashed \(names and sizes only\): cli\.js\.bak-old \(6 bytes\), cli\.js\.bak-timeout \(2 bytes\)/);
  assert.deepEqual(resolveCcrInstall({ env }), resolveCcrInstall({ env }), "deterministic");
  const spec = buildSpec({ PATH: "x" }), h0 = planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha;
  fs.writeFileSync(path.join(main, "cli.js.bak-old"), "OTHERX"); assert.equal(planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha, h0, "same name and size: the backup's bytes are not part of the plan");
  fs.writeFileSync(path.join(main, "gateway-bootstrap.js"), "gb2"); const h1 = planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha;
  assert.notEqual(h1, h0, "a changed worker file the daemon loads changes the plan hash (cli.js alone would not see it)");
  fs.writeFileSync(path.join(main, "new-worker.js"), "w"); assert.notEqual(planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha, h1, "a new loaded file does");
  fs.writeFileSync(path.join(main, "cli.js.bak-extra"), "x"); const h2 = planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha;
  fs.rmSync(path.join(main, "cli.js.bak-extra")); assert.notEqual(planOf(spec, { router: "both", ccr: resolveCcrInstall({ env }) }).sha, h2, "a new .bak name changes it");
  assert.deepEqual(distOf(path.join(root, "absent")), { error: "ENOENT" }, "an unreadable directory is said, not thrown");
  assert.match(ccrInstallLines({ ...c1, dist: { error: "ENOENT" } }).join("\n"), /dist\/main\/\*\.js  NOT LISTED \(ENOENT\)/);
  assert.doesNotMatch(ccrInstallLines(CCR_FAKE).join("\n"), /dist\/main/, "an install object without the listing prints none");
  assert.match(ccrInstallLines({ found: false, reason: "no ccr launcher on PATH" }).join("\n"), /CCR install: NOT FOUND \(no ccr launcher on PATH\)/, "NOT FOUND is unchanged");
  const real = Date.now(); resolveCcrInstall({ env: { PATH: "C:\\nowhere" } }); assert.ok(Date.now() - real < 2000);
});

test("F9: --host-check x6 refuses a temp dir under a protected folder BEFORE creating anything, runs the directory through safeWritePath containment, removes its directory on a signal, and says not to run during G1", async () => {
  const w1 = fakeX6Fs();
  for (const bad of [path.join(os.homedir(), ".claude", "tmp"), path.join(os.homedir(), "Downloads"), path.join(REPO_ROOT, "state"), path.join(os.homedir(), ".llmkeys")]) {
    await assert.rejects(hostCheckX6({ fsx: w1.fsx, tmpdir: bad, renames: 2, bytes: 32, onSignal: () => () => {} }), /x6 refused: the temp dir .* is under the protected folder/, bad);
  }
  assert.equal(w1.log.mkdtemp.length, 0, "nothing was created in a protected folder"); assert.deepEqual(w1.log.writes, []);
  assert.equal(isUnder(path.join(os.tmpdir(), "x"), os.homedir()), true, "the real temp dir sits under the home folder, which is not itself protected");
  const okOut = [];
  const fine = await hostCheckX6({ fsx: fakeX6Fs().fsx, tmpdir: path.join(os.tmpdir(), "fake-x6-root"), renames: 3, bytes: 32, out: (l) => okOut.push(l), onSignal: () => () => {} });
  assert.equal(fine.done, 3, "the case it must not break: an ordinary temp dir runs");
  // a signal in the middle: the work stops, the directory is removed ONCE, the handler is unhooked
  const w = fakeX6Fs(); let handler, unhooked = false, sig, nw = 0;
  const wf = w.fsx.promises.writeFile;
  w.fsx.promises.writeFile = async (p, b) => { await wf(p, b); if (++nw === 5 && handler) sig = handler("SIGINT"); };
  const res = await hostCheckX6({ fsx: w.fsx, tmpdir: path.join(os.tmpdir(), "fake-x6-root"), renames: 1000, bytes: 32, onSignal: (fn) => { handler = fn; return () => { unhooked = true; }; } });
  await sig;
  assert.equal(typeof handler, "function", "a signal handler is registered");
  assert.ok(res.done < 1000, `the work stopped early (${res.done} of 1000)`);
  assert.deepEqual(w.log.rm, [w.log.mkdtemp[0]], "the directory is removed once, and only that one"); assert.equal(unhooked, true);
  // through runE2e: the notice is printed, and the default seam registers the REAL signal handlers and removes them again
  const errs = [], before = process.listenerCount("SIGINT");
  const code = await runE2e(["--host-check", "x6"], { x6: { fsx: fakeX6Fs().fsx, tmpdir: path.join(os.tmpdir(), "fake-x6-root"), renames: 3, bytes: 32 }, out: () => {}, err: (s) => errs.push(s) });
  assert.equal(code, 0); assert.ok(errs.some((e) => /--host-check x6: do not run this during G1 \(it loads the disk and can disturb the X7 timer margins\)/.test(e)));
  assert.equal(process.listenerCount("SIGINT"), before, "the real handlers were unhooked again");
  assert.ok(USAGE.join("\n").includes("DO NOT RUN IT DURING G1"));
  assert.ok(NOT_RUN.some((n) => /X6/.test(n) && /do NOT run it during G1/.test(n)));
});

test("F10: a run is REFUSED (exit 1, before the approval is consumed, names only) when NODE_USE_ENV_PROXY, HTTP_PROXY, HTTPS_PROXY or ALL_PROXY is set in the orchestrator's own environment, in any letter case; NO_PROXY alone is fine", async () => {
  const secret = "http://user:" + fake("pw") + "@proxy.invalid:8080";
  for (const [name, value] of [["NODE_USE_ENV_PROXY", "1"], ["HTTP_PROXY", secret], ["HTTPS_PROXY", secret], ["ALL_PROXY", secret], ["https_proxy", secret], ["All_Proxy", secret], ["http_proxy", secret]]) {
    const { w, d } = world({});
    d.env = { ...d.env, [name]: value };
    const r = await go(w, d, GO);
    assert.equal(r.code, 1, name); assert.equal(w.calls.runStep, 0, `${name}: nothing started`); assert.equal(w.calls.fetch, 0);
    assert.match(r.err, new RegExp(`refusing: ${name} is set in this shell`), name);
    assert.ok(!r.err.includes("proxy.invalid") && !r.err.includes("user:"), `${name}: the value (it can carry credentials) is never printed`);
    assert.equal(w.mem.files.has(norm(APPROVAL_FILE)), true, `${name}: the approval was NOT consumed`);
  }
  const many = world({}); many.d.env = { ...many.d.env, HTTP_PROXY: "http://p", ALL_PROXY: "http://p" };
  const m = await go(many.w, many.d, GO);
  assert.match(m.err, /refusing: ALL_PROXY, HTTP_PROXY are set in this shell/);
  assert.deepEqual(proxyVarsSet({ NO_PROXY: "x", no_proxy: "y", PATH: "p" }), [], "NO_PROXY alone is fine");
  assert.deepEqual(proxyVarsSet({ HTTP_PROXY: "", HTTPS_PROXY: "  " }), [], "an empty value is not a proxy");
  assert.deepEqual(proxyVarsSet({ node_use_env_proxy: "1", Https_Proxy: "x" }), ["Https_Proxy", "node_use_env_proxy"]);
  const ok = await run(GO, {});
  assert.equal(ok.code, 0, "the case it must not break: a shell with NO_PROXY only (the default world) runs");
  assert.ok(renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n").includes("this shell's own NODE_USE_ENV_PROXY, HTTP_PROXY, HTTPS_PROXY or ALL_PROXY"));
});

// ================================================================ fix round 2: CCR 3.0.22's profile key id (G1 attempt 2 failed at A0)
const profileKeyEntries = (w) => (w.cfg.APIKEYS ?? []).filter((k) => k.id === "profile:default-claude-code");

test("G1-2 root cause: a sandbox config WITHOUT the profile key gets exactly ONE sandbox-only entry {createdAt, id profile:default-claude-code, key ccr-profile-<24>, name} in the same save (applyProfile:false), A0 PASSes (the fake enricher accepts only that id), and the key is never printed", async () => {
  const r = await run([...GO, "--router", "probe"], {});
  assert.equal(r.code, 0, r.err + r.out.slice(-300)); assert.equal(kindOf(r.out, "A0"), "PASS");
  const es = profileKeyEntries(r.w);
  assert.equal(es.length, 1, "one entry, not two");
  assert.deepEqual(Object.keys(es[0]).sort(), ["createdAt", "id", "key", "name"]); assert.match(es[0].key, /^ccr-profile-[A-Za-z0-9_-]{24}$/); assert.equal(es[0].name, "Profile: default-claude-code");
  for (const where of [r.out, r.err, renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n")]) assert.ok(!where.includes(es[0].key), "the generated key is never printed");
  assert.ok(evidenceOf(r.w).length === 0 && ![...r.w.mem.files.values()].some((v) => String(v).includes(es[0].key)), "and never written to a file the harness makes");
  // the case it must not break: a key CCR (or an earlier step) already created is KEPT, no second entry, the same key is used
  const K = ["ccr-profile-", fake("seed").replace(/[^A-Za-z0-9]/g, "").slice(0, 24).padEnd(24, "x")].join("");
  const have = await run([...GO, "--router", "probe"], { profileKey: K });
  assert.equal(have.code, 0, have.err); assert.equal(kindOf(have.out, "A0"), "PASS");
  assert.equal(profileKeyEntries(have.w).length, 1); assert.equal(profileKeyEntries(have.w)[0].key, K, "the existing key is not replaced");
  assert.ok(!have.out.includes(K) && !have.err.includes(K));
});

test("G1-2: with the OLD wrong key id the enricher would not run: a fake gateway that accepts only the real id shows A0 FAIL when the persisted config lacks that entry, and nothing is sent (pre-flight, before A0's request)", async () => {
  const { w, d } = world({});
  wrapRpc(d, async (m, a, orig) => { const v = await orig(m, a); if (m === "saveConfig") v.APIKEYS = [{ id: "profile-default-claude-code", key: ["ccr-profile-", fake("old")].join("") }]; return v; });
  const r = await go(w, d, [...GO, "--router", "probe"]);
  assert.equal(r.code, 1); assert.equal(w.calls.fetch, 0, "no request was sent");
  assert.match(r.err, /no API key whose id is "profile:default-claude-code" \(the id CCR derives for profile "default-claude-code"; 1 key entries, fields: id,key\)/);
  assert.match(r.out, /FAIL \[probe\] A0 no API key whose id is "profile:default-claude-code"/);
});

test("G1-2: the profile key never leaks: a bare ccr-profile-... token in a CCR log line, the evidence, the output and the teardown notes are masked verbatim (the shared redactor only masks keys by context)", async () => {
  const K = ["ccr-profile-", fake("leak").replace(/[^A-Za-z0-9]/g, "").padEnd(24, "q").slice(0, 24)].join("");
  const r = await run([...GO, "--router", "probe"], { profileKey: K, ccrLog: `daemon booted, using key ${K} for the profile\nline 2`, tripwireAt: "e2e:after-x9-model-chain" });
  assert.equal(r.code, 1);
  const ev = evidenceOf(r.w);
  assert.ok(ev.length > 0 && ev.some(([k]) => /daemon\.out\.log\.txt$/.test(k)), "the CCR log was retained");
  for (const [k, v] of ev) assert.ok(!String(v).includes(K), `evidence ${path.basename(k)} leaks the key`);
  assert.ok(!r.out.includes(K) && !r.err.includes(K));
  assert.match(evText(r.w, "ccr-logs__daemon.out.log.txt"), /daemon booted, using key <redacted> for the profile/);
  const plain = await run([...GO, "--router", "probe"], { ccrLog: `using key ${K}`, tripwireAt: "e2e:after-x9-model-chain" });
  assert.ok(evText(plain.w, "ccr-logs__daemon.out.log.txt").includes(K), "control: without the key in the run, nothing else is masked (the literal is what the run registered)");
});

test("G1-2: a leaking run key survives only as long as the run: RUN_SECRETS is cleared at the start of the next run", async () => {
  const K = ["ccr-profile-", fake("old2").replace(/[^A-Za-z0-9]/g, "").padEnd(24, "z").slice(0, 24)].join("");
  await run([...GO, "--router", "probe"], { profileKey: K });
  const next = await run([...GO, "--router", "probe"], { ccrLog: `using key ${K}`, tripwireAt: "e2e:after-x9-model-chain", skipKeyCheck: true });
  assert.ok(evText(next.w, "ccr-logs__daemon.out.log.txt").includes(K), "a previous run's key is not masked in a later run (no state leaks between runs)");
});

test("G1-2: a string-shaped system on a subagent request is NOT flagged by CCR (VUe wants an array whose first block starts with the billing header): documented here; the X8 string arm and H1 do not depend on bl", () => {
  const q = buildRequest("sub", { key: "k", model: "m", systemShape: "string" });
  assert.equal(typeof q.body.system, "string"); assert.ok(q.body.system.startsWith("x-anthropic-billing-header:"));
  const a = buildRequest("sub", { key: "k", model: "m" });
  assert.ok(Array.isArray(a.body.system) && a.body.system[0].text.startsWith("x-anthropic-billing-header:") && /cc_is_subagent=true;/.test(a.body.system[0].text), "the array shape starts with the billing block");
  assert.ok(a.headers["user-agent"].toLowerCase().includes("claude"));
});

// ================================================================ fix round 3: the proof's web-RPC calls survive a transient network error (G1 attempt 3: CCR respawned its core worker, one fetch failed, the run went RED)
const netErr = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:39458`), { code }) });
const clock = () => { let t = 1e12; const sleeps = []; return { sleeps, sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, advance: (ms) => { t += ms; } }; };
const web = (r) => r.web;

test("G1-3: a transient network error in the daemon-identity check is retried (service.json re-read and re-verified at EVERY attempt), the check goes GREEN, and the line says on which attempt", async () => {
  const c = clock(); let calls = 0, resolves = 0; const resolvesAtCall = [];
  const t = await proveTree({ ...c, resolveWebPort: () => { resolves++; return { port: 39458, pid: 5000 }; },
    assertIsolatedInstance: async () => { resolvesAtCall.push(resolves); if (++calls < 3) throw netErr("ECONNREFUSED"); } });
  assert.equal(web(t).ok, true, web(t).detail); assert.equal(calls, 3);
  assert.match(web(t).detail, /^web 39458 pid 5000; reached on attempt 3 of 5 after a transient network error$/);
  assert.deepEqual(c.sleeps, [1500, 1500], "1.5 s between attempts");
  assert.ok(resolvesAtCall[1] > resolvesAtCall[0] && resolvesAtCall[2] > resolvesAtCall[1], "service.json was re-read before every attempt");
  assert.equal(t.res.ok, true, JSON.stringify(t.res.checks.filter((x) => !x.ok)));
  const first = await proveTree({ ...clock(), assertIsolatedInstance: async () => {} });
  assert.equal(web(first).detail, "web 39458 pid 5000", "the case it must not break: no failure, no retry note");
});

test("G1-3: five transient failures stay RED and name the cause (error.cause.code and message, one line, redacted), the attempt count and the elapsed time; no sixth attempt; a persistent ECONNREFUSED stays RED", async () => {
  const c = clock(); let calls = 0;
  const t = await proveTree({ ...c, assertIsolatedInstance: async () => { calls++; throw netErr("ECONNREFUSED"); }, redact: (x) => x.replace("127.0.0.1", "<ip>") });
  assert.equal(web(t).ok, false); assert.equal(t.res.ok, false); assert.equal(calls, 5, "at most five attempts");
  assert.match(web(t).detail, /^threw: ECONNREFUSED connect ECONNREFUSED <ip>:39458: still failing after 5 attempts over 6000 ms \(transient network errors only; an isolation mismatch is never retried\)$/);
  assert.throws(() => assertIsolationProven(t.res), /isolation NOT proven: .*daemon web port and token.*ECONNREFUSED/);
  assert.equal(c.sleeps.length, 4);
  // the 10 s ceiling: slow attempts stop the retries early
  const slow = clock(); let n = 0;
  const s2 = await proveTree({ ...slow, assertIsolatedInstance: async () => { n++; slow.advance(4000); throw netErr("ETIMEDOUT"); } });
  assert.equal(web(s2).ok, false); assert.equal(n, 2, "never past the 10 s ceiling in all"); assert.match(web(s2).detail, /ETIMEDOUT.*after 2 attempts over \d+ ms/);
  // a message-only transport error (no cause) is transient too, and a plain failure is not
  let m = 0; const msgOnly = await proveTree({ ...clock(), assertIsolatedInstance: async () => { m++; throw new Error("read ECONNRESET"); } });
  assert.equal(m, 5); assert.equal(web(msgOnly).ok, false);
  let b = 0; const boom = await proveTree({ ...clock(), assertIsolatedInstance: async () => { b++; throw new Error("boom"); } });
  assert.equal(b, 1, "an error that is not a network error is not retried"); assert.match(web(boom).detail, /^threw: boom$/);
});

test("G1-3: an isolation MISMATCH is never retried: a wrong pid or port in service.json, an isolation violation from the identity check or the config check, and a refusal are RED on the FIRST attempt (no sleep, no second call); a mismatch that appears on a later attempt stops the retries at once", async () => {
  for (const [name, over, re] of [["wrong pid", { resolveWebPort: () => ({ port: 39458, pid: 9999 }) }, /service\.json says port 39458 pid 9999/], ["wrong port", { resolveWebPort: () => ({ port: 3458, pid: 5000 }) }, /service\.json says port 3458 pid 5000/]]) {
    const c = clock(); let calls = 0;
    const t = await proveTree({ ...c, ...over, assertIsolatedInstance: async () => { calls++; } });
    assert.equal(web(t).ok, false, name); assert.match(web(t).detail, re, name); assert.equal(calls, 0, `${name}: the daemon was not even asked`); assert.deepEqual(c.sleeps, [], name);
  }
  for (const [name, key, err] of [["identity violation", "assertIsolatedInstance", new Error("ISOLATION VIOLATION: daemon reports configDir=\"C:\\real\" under ECONNRESET")], ["config violation", "assertIsolatedConfig", new Error("ISOLATION VIOLATION: persisted gateway.port=3456")], ["refusal", "assertIsolatedInstance", new RefusalError("REFUSED: x")]]) {
    const c = clock(); let calls = 0;
    const t = await proveTree({ ...c, [key]: async () => { calls++; throw err; } });
    assert.equal(t.res.ok, false, name); assert.equal(calls, 1, `${name}: exactly one attempt`); assert.deepEqual(c.sleeps, [], `${name}: no sleep`);
  }
  // pid flips after one transient failure: RED at attempt 2, no further call
  const c = clock(); let calls = 0, res = 0;
  const t = await proveTree({ ...c, resolveWebPort: () => ({ port: 39458, pid: ++res <= 1 ? 5000 : 9999 }), assertIsolatedInstance: async () => { calls++; throw netErr("ECONNRESET"); } });
  assert.equal(web(t).ok, false); assert.equal(calls, 1); assert.match(web(t).detail, /service\.json says port 39458 pid 9999/); assert.deepEqual(c.sleeps, [1500]);
});

test("G1-3: every proof call to the sandbox web RPC has the retry: the persisted-config check and the fresh Router.fallback read go GREEN after transient errors (attempts reported), and stay RED when they persist", async () => {
  let ci = 0, gc = 0;
  const t = await proveTree({ ...clock(), swapRan: true, assertIsolatedConfig: async () => { if (++ci < 2) throw netErr("ECONNRESET"); }, getConfig: async () => { if (++gc < 3) throw netErr("ECONNREFUSED"); return { Router: { fallback: { mode: "off", models: [] } } }; } });
  assert.equal(t.cfg.ok, true); assert.match(t.cfg.detail, /^ok; reached on attempt 2 of 5/);
  assert.equal(t.fallback.ok, true); assert.match(t.fallback.detail, /swap step has run; reached on attempt 3 of 5 after a transient network error$/);
  assert.equal(t.res.ok, true, JSON.stringify(t.res.checks.filter((x) => !x.ok)));
  let n = 0;
  const bad = await proveTree({ ...clock(), swapRan: true, getConfig: async () => { n++; throw netErr("ECONNREFUSED"); } });
  assert.equal(n, 5); assert.equal(bad.fallback.ok, false); assert.match(bad.fallback.detail, /ECONNREFUSED.*5 attempts/);
  let k = 0; const cfgBad = await proveTree({ ...clock(), assertIsolatedConfig: async () => { k++; throw netErr("ECONNREFUSED"); } });
  assert.equal(k, 5); assert.equal(cfgBad.cfg.ok, false);
  let kk = 0; const gb = await proveTree({ ...clock(), assertIsolatedConfig: async () => { kk++; throw new Error("ISOLATION VIOLATION: persisted PORT=3456"); } });
  assert.equal(kk, 1); assert.equal(gb.cfg.ok, false);
});

test("G1-3: a core worker pid that changed since the previous post-provider proof is a RECORD line (old -> new, gateway and daemon pids), never a failure; the first proof, an unchanged pid and a proof without a tracker print none", async () => {
  const track = {};
  const first = await proveTree({ track });
  assert.equal(first.core, undefined, "nothing to compare with yet"); assert.equal(track.core, 5001);
  const same = await proveTree({ track }); assert.equal(same.core, undefined, "unchanged: no line");
  const CH2 = { pid: 7777, ppid: 5000, name: "node.exe", cmd: CHILD_ROW.cmd };
  const moved = await proveTree({ track, rows: [DAEMON_ROW, CH2], holders: { 39457: 7777 }, listen: { 7777: [{ addr: "127.0.0.1", port: 39457 }], 5001: [] }, guard: [5000, 7777] });
  assert.equal(moved.res.ok, true, JSON.stringify(moved.res.checks.filter((x) => !x.ok)));
  assert.equal(moved.core.ok, true); assert.equal(moved.core.recorder, true);
  assert.match(moved.core.detail, /^sandbox core worker pid changed 5001 -> 7777 during the run; gateway pid unchanged \(5000\), daemon pid 5000 unchanged \(service\.json check\)$/);
  assert.equal(track.core, 7777, "the new pid is remembered");
  assert.equal(moved.res.checks.at(-1).name, moved.core.name, "last in the list: the numbering of the other checks does not move");
  const gw = await proveTree({ track: { core: 7777, gateway: 4000 } , rows: [DAEMON_ROW, CH2], holders: { 39457: 8888, 39456: 5000 }, listen: { 7777: [{ addr: "127.0.0.1", port: 39457 }] } });
  assert.ok(gw.core === undefined || gw.core.recorder === true);
  assert.equal((await proveTree({})).core, undefined, "no tracker: no record");
  assert.equal((await proveTree({ phase: "pre-provider", track: { core: 1 } })).core, undefined, "pre-provider: the core port is not judged yet");
});

test("G1-3 flow: a transient fetch failure in the proof after EACH router run (probe and next) is retried and the run still ends OK; a persistent one is RED, exit 1, cause in the message; an isolation violation there is RED at once with ONE call", async () => {
  const mkWorld = (opt) => { const { w, d } = world(opt); return { w, d }; };
  const { w, d } = mkWorld({}); const failed = {}; let calls = 0; const sl = [], osl = d.sleep; d.sleep = async (ms) => { sl.push(ms); return osl(ms); };
  d.guard.assertIsolatedInstance = async () => { calls++; const st = w.tripStages.at(-1); if ((st === "after-probe-run" || st === "after-next-run") && !failed[st]) { failed[st] = true; throw netErr("ECONNREFUSED"); } };
  const r = await go(w, d, GO);
  assert.equal(r.code, 0, r.err + r.out.slice(-500));
  assert.equal((r.out.match(/GREEN +\d+ daemon web port and token \(service\.json\) are ours.*reached on attempt 2 of 5 after a transient network error/g) ?? []).length, 2, "after the probe run AND after the next run");
  assert.equal(sl.filter((x) => x === 1500).length, 2, "the orchestrator hands its own sleep to the proof: one 1.5 s gap per retried proof");
  const p = mkWorld({}); p.d.guard.assertIsolatedInstance = async () => { if (p.w.tripStages.at(-1) === "after-probe-run") throw netErr("ECONNREFUSED"); };
  const pr = await go(p.w, p.d, GO);
  assert.equal(pr.code, 1); assert.match(pr.err, /isolation NOT proven: #\d+ daemon web port and token.*ECONNREFUSED connect ECONNREFUSED 127\.0\.0\.1:39458: still failing after 5 attempts/);
  assert.equal(lineOf(pr.out, "X9a") !== undefined, true, "the probe lines printed before the RED proof are kept");
  let vc = 0; const v = mkWorld({}); v.d.guard.assertIsolatedInstance = async () => { if (v.w.tripStages.at(-1) === "after-probe-run") { vc++; throw new Error("ISOLATION VIOLATION: daemon paths"); } };
  const vr = await go(v.w, v.d, GO);
  assert.equal(vr.code, 1); assert.equal(vc, 1, "a violation is never retried");
});

test("G1-3 flow: a core worker respawned during the probe run prints a RECORD line (old -> new, gateway unchanged), the run does not fail, and the next proof says nothing more", async () => {
  const { w, d } = world({}), s = d.sys, oL = s.listenerPid, oP = s.processes, oLP = s.listenPortsOf, oR = s.readText;
  const swapped = () => w.ranProbe && w.started;
  const CH2 = { pid: 5002, ppid: 5000, name: "node.exe", cmd: CHILD_ROW.cmd };
  s.listenerPid = (p) => (p === 39457 && swapped() && w.childAlive ? 5002 : oL(p));
  s.processes = () => oP().map((r) => (swapped() && r.pid === 5001 ? CH2 : r));
  s.listenPortsOf = (pid) => (pid === 5002 ? oLP(5001) : oLP(pid));
  s.readText = (p) => (norm(p) === norm(GUARD_LOADED_LOG) && swapped() ? [5000, 5002].map((pid) => JSON.stringify({ pid })).join("\n") + "\n" : oR(p));
  const r = await go(w, d, GO);
  assert.equal(r.code, 0, r.err + r.out.slice(-600));
  const rec = r.out.split("\n").filter((l) => /^RECORD +\d+ sandbox core worker pid changed/.test(l));
  assert.equal(rec.length, 1, rec.join("\n")); assert.match(rec[0], /changed 5001 -> 5002 during the run; gateway pid unchanged \(5000\), daemon pid 5000 unchanged/);
  assert.ok(!/RED /.test(r.out));
  assert.ok(SIDE_EFFECTS.some((e) => e.id === "sandbox-core-worker-respawn" && e.mode === "record"), "listed in the side-effect inventory as a record");
  assert.match(renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n"), /\[record\] sandbox-core-worker-respawn: [\s\S]*retried \(at most 5 attempts, 1\.5 s apart, 10 s in all/);
});

test("G1-3: the plan says CCR may respawn its core child during the fallback swaps, that the proof's web-RPC calls retry a transient network error only (bounded) and never a mismatch, and the retry limits are the ones the code uses", () => {
  const text = renderPlan(buildSpec({ PATH: "x" }), { router: "both", ccr: CCR_FAKE }).join("\n");
  for (const need of ["CCR may respawn its core worker (the daemon's child holding the core port) during the Router.fallback swaps", "retried for a transient network error only (fetch failed, ECONNRESET, ECONNREFUSED, a timeout), at most 5 attempts 1.5 s apart and 10 s in all", "a mismatch (wrong port or pid, a config that is not isolated) is NEVER retried and is RED at once", "A changed core worker pid is printed as a RECORD line, not a failure",
    "the proof's calls to the sandbox web RPC (daemon identity, persisted config, Router.fallback read) retry a transient network error only (5 attempts, 1.5 s apart, 10 s in all"]) assert.ok(text.includes(need), `plan lacks: ${need}`);
  assert.deepEqual(PROOF_RETRY, { attempts: 5, gapMs: 1500, ceilingMs: 10000 });
  for (const e of [netErr("ECONNRESET"), netErr("ECONNREFUSED"), new Error("fetch failed"), Object.assign(new Error("x"), { name: "TimeoutError" }), new config.RpcTimeoutError("saveConfig timed out after 1 ms")]) assert.equal(isTransientNetError(e), true, String(e.message));
  for (const e of [new Error("boom"), new Error("ISOLATION VIOLATION: ECONNRESET"), new RefusalError("REFUSED: ECONNRESET"), Object.assign(new Error("service.json says port 1"), { mismatch: true }), new Error("rpc refused: the sandbox service.json names web port 3458, not 39458"), null]) assert.equal(isTransientNetError(e), false, String(e?.message));
});

// ---- the session hooks the scenario suite (harness/subagent-scenarios.mjs) and the self-test use: an injected approval ceremony, injected phases and an injected verdict. The default path is unchanged (every test above).
test("flow (S2d hooks): d.externalApproval replaces the approval FILE (not read, not consumed), d.sessionPhases replace the probe and next phases AFTER the same proofs, and d.sessionVerdict decides the exit", async () => {
  const seen = { approvals: 0, phases: 0, ctxKeys: null };
  const { w, d } = world({});
  d.externalApproval = async ({ plan, fileHashes, ccr }) => { seen.approvals += 1; assert.match(plan.sha, /^[0-9a-f]{64}$/); assert.ok(fileHashes.length > 5); assert.equal(ccr?.found, true, "the orchestrator hands the CCR install it resolved to the external approval, which compares it with the pin"); return null; };
  d.sessionPhases = async (ctx) => { seen.phases += 1; seen.ctxKeys = Object.keys(ctx).sort(); ctx.emit("SCENARIO PASS 1 T (1 of 1 run) :: ok"); return { abort: false }; };
  d.sessionVerdict = (lines) => ({ ok: lines.some((l) => /^SCENARIO PASS/.test(l)), problems: [], counts: { PASS: 1 } });
  const r = await go(w, d, [...GO, "--router", "next"], { none: true });
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual([seen.approvals, seen.phases], [1, 1]);
  for (const k of ["d", "key", "stub", "emit", "out", "approved", "tripwire", "fallback", "shared"]) assert.ok(seen.ctxKeys.includes(k), `ctx.${k}`);
  assert.ok(!w.mem.log.some((x) => x[0] === "rename" && norm(x[1]) === norm(APPROVAL_FILE)), "the approval FILE was never consumed");
  assert.ok(!/probe router installed|router under test installed/.test(r.out), "the probe and next phases did not run");
  assert.match(r.out, /GREEN {1,2}1 live listeners/); assert.match(r.out, /live state identical before and after/); assert.match(r.out, /summary: {"PASS":1}; OK/);
  assert.deepEqual(w.calls.stopProcess, [5001, 5000], "the same identity-verified teardown");
});

test("flow (S2d hooks): a refusal from d.externalApproval exits 2 and starts nothing; a sessionVerdict that is not ok exits 1; without the hooks the approval FILE is still required", async () => {
  let { w, d } = world({});
  d.externalApproval = async () => "no approval for this suite";
  d.sessionPhases = async () => { throw new Error("must not run"); };
  let r = await go(w, d, [...GO, "--router", "next"], { none: true });
  assert.equal(r.code, 2); assert.match(r.err, /refusing: no approval for this suite/); assert.equal(w.calls.runStep, 0, "nothing was started");
  ({ w, d } = world({}));
  d.externalApproval = async () => null; d.sessionPhases = async (ctx) => { ctx.emit("SCENARIO FAIL 2 T (0 of 1 run) :: bad"); return {}; };
  d.sessionVerdict = () => ({ ok: false, problems: ["scenario 2 FAILED: bad"], counts: { FAIL: 1 } });
  r = await go(w, d, [...GO, "--router", "next"], { none: true });
  assert.equal(r.code, 1); assert.match(r.err, /PROBLEM: scenario 2 FAILED: bad/); assert.match(r.out, /NOT OK/);
  r = await run([...GO, "--router", "next"], {}, { none: true });
  assert.equal(r.code, 2, "no hooks and no approval file: refused as before"); assert.match(r.err, /no approval file/);
});

test("stub: script.decide scripts ONE model's failure per request and falls through to the sequence and the default when it returns nothing", async () => {
  const stub = createStub({ port: 0, script: { decide: (r) => (r.model === "uwstub/m-free" ? { status: 429, retryAfter: 90 } : undefined), sequence: [503] } });
  const port = await stub.start();
  try {
    const post = (model) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "x" }] }) });
    const a = await post("uwstub/m-free"), b = await post("uwstub/m-big"), c = await post("uwstub/m-big");
    assert.deepEqual([a.status, a.headers.get("retry-after"), b.status, c.status], [429, "90", 503, 200], "decide first, then the sequence (consumed only when decide passes), then 200");
  } finally { await stub.stop(); }
});

test("stub: a decide rule that THROWS (or returns an invalid step) never crashes the stub: the request falls through to the sequence and the default", async () => {
  const stub = createStub({ port: 0, script: { decide: (r) => { if (r.model === "uwstub/m-free") throw new Error("rule bug"); return 99999; }, sequence: [503] } });
  const port = await stub.start();
  try {
    const post = (model) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "x" }] }) });
    const a = await post("uwstub/m-free"), b = await post("uwstub/m-big"), c = await post("uwstub/m-big");
    assert.deepEqual([a.status, b.status, c.status], [503, 200, 200], "a thrown rule and an invalid step fall through (the first request consumes the sequence), nothing crashes");
  } finally { await stub.stop(); }
});

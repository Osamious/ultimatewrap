// Availability and unnamed refusals are never x (migration included); the gateway's own translation failures stay x but are tagged `xw: gateway`, listed, and can be asked again alone; argument
// fidelity means "would corrupt a real Edit". Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, SWEEP_FAST, freshDir, fakeFetch, goodModel, http, ok, ev, stream, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { probeModel, runKind, afCheck, isAvailabilityText, GATEWAY_WORDS } from "../refresh/tool-fidelity-probe.mjs";
import { main, parseArgs, plan } from "../refresh/tool-fidelity-cli.mjs";
import { buildRecord, cleanFidelity, migrateTransient, transientReason, gatewayInsights, saveFidelity, loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { AWKWARD, EDIT_TOOL } from "../refresh/tool-fidelity-fixture.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const body = (msg) => JSON.stringify({ error: { message: msg, target_providers: ["openai"] } });
const THOUGHT = "google: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly";
const EMPTY = "nvidia: request: Value error, Empty content is not allowed for assistant messages";

// ---------------------------------------------------------------- (1) availability is never x

test("the two real cases: 'temporarily unavailable. Try another model' and 'Upstream request failed' at L2 are pending upstream-unavailable, not a strike, not x, in any number of runs", async () => {
  for (const msg of ["anymodel: The selected model is temporarily unavailable. Try another model.", "cloudflare: Upstream request failed."]) {
    for (const round of [1, 2, 3]) {
      const f = fakeFetch((c) => (kindOf(c) === "2" ? { status: 400, body: body(msg), headers: {} } : goodModel(c)));
      const done = {};
      const r = await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
      assert.deepEqual([r.inconclusive.reason, done[1].v, done[2]], ["upstream-unavailable", "p", undefined], `${msg} round ${round}`);
    }
  }
  assert.ok(isAvailabilityText(body("cloudflare: Upstream request failed.")));
  assert.ok(!isAvailabilityText(body("tools.2.input_schema: invalid")));
});

test("end to end over several runs: such a provider never gets a record or a strike, and a model that answers later is probed normally", async () => {
  let up = false;
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }], { answer: (c) => (!up && kindOf(c) === "2" ? http(400, "fa: Upstream request failed.") : goodModel(c)) });
  for (let i = 0; i < 3; i += 1) {
    await run(["--live"], e.deps);
    assert.deepEqual(Object.keys(loadFidelity(e.out).models), [], `run ${i + 1}: nothing recorded`);
  }
  up = true;
  await run(["--live"], e.deps);
  assert.equal(loadFidelity(e.out).models["fa/a1"].t, "t", "once the upstream answers, the model is probed normally");
});

// ---------------------------------------------------------------- (2) gateway translation failures

test("a gateway-translation refusal ('missing a thought_signature', 'Empty content is not allowed for assistant messages') is a VERDICT (the gateway cannot carry the call) flagged gw; two strikes make it x and the record is tagged xw gateway", async () => {
  for (const msg of [THOUGHT, EMPTY]) {
    const { r } = await one("2", () => http(400, msg));
    assert.deepEqual([r.v, r.gw], ["f", true], msg);
    assert.ok(GATEWAY_WORDS.test(msg));
    const done = { 1: { v: "p" }, 2: { v: "f", why: r.why, kind: "schema", gw: true } };
    const first = buildRecord(null, done, { now: NOW });
    assert.deepEqual([first.strikes, first.t, first.xw], [1, "u", undefined], "the first strike is provisional: nothing is tagged yet");
    const second = buildRecord(first, done, { now: NOW });
    assert.deepEqual([second.t, second.xw, second.lvr], ["x", "gateway", "pfnn"], "confirmed: x for routing, and tagged");
    assert.equal(cleanFidelity(second)?.xw, "gateway");
    const healed = buildRecord(second, { 2: { v: "p" } }, { now: NOW });
    assert.deepEqual([healed.t, healed.xw], ["t", undefined], "a pass after a gateway fix clears the tag");
  }
  const plain = buildRecord(record("ppnn", { why: undefined }), { 2: { v: "f", why: "HTTP 400: tool schema rejected", kind: "schema" } }, { now: NOW });
  assert.equal(plain.xw, undefined, "a real schema failure is not tagged");
  assert.equal(cleanFidelity({ ...record("ppnn"), xw: "other" }), null, "only `gateway` is a valid tag");
});

test("the insights block lists the gateway failures by provider with the provider's words; the report and the dry run print it", async () => {
  const store = {
    "google/g1": record("pfnn", { strikes: 2, sl: 2, why: `L2: HTTP 400: ${body(THOUGHT)}`, xw: "gateway" }), "google/g2": record("pfnn", { strikes: 2, sl: 2, why: `L2: HTTP 400: ${body(THOUGHT)}`, xw: "gateway" }),
    "nvidia/n1": record("pfnn", { strikes: 2, sl: 2, why: `L2: HTTP 400: ${body(EMPTY)}`, xw: "gateway" }), "fa/x": record("fnnn", { strikes: 2, sl: 1, why: "L1: answered in text instead of calling the tool" }),
  };
  const ins = gatewayInsights(store);
  assert.deepEqual(ins.map((x) => [x.provider, x.n]), [["google", 2], ["nvidia", 1]]);
  assert.match(ins[0].hint, /Function call is missing a thought_signature/);
  const e = cliEnv([{ provider: "google", keyId: "k.g.free", models: [m("g1"), m("g2")] }, { provider: "nvidia", keyId: "k.n.free", models: [m("n1")] }, { provider: "fa", keyId: "k.fa.free", models: [m("x")] }]);
  saveFidelity(e.out, store, { now: NOW });
  const dry = await run([], e.deps);
  assert.match(dry.out, /failing because of the gateway's request translation \(fixable there, not limits of the models; they stay x for routing; `--retry-failed --only-gateway` asks them again after a fix\): 3 record\(s\)/);
  assert.match(dry.out, /google: 2 -- .*thought_signature/);
  assert.match(dry.out, /nvidia: 1 -- .*Empty content is not allowed for assistant messages/);
});

test("--retry-failed --only-gateway asks again ONLY the gateway-tagged failures (dry by default); a model that passes after a gateway fix loses the tag; the flag needs --retry-failed", async () => {
  assert.ok(parseArgs(["--only-gateway"]).error);
  assert.equal(parseArgs(["--retry-failed", "--only-gateway"]).onlyGateway, true);
  const store = {
    "fa/gw": record("pfnn", { strikes: 2, sl: 2, why: `L2: HTTP 400: ${body(THOUGHT)}`, xw: "gateway" }),
    "fa/legit": record("fnnn", { strikes: 2, sl: 1, why: "L1: answered in text instead of calling the tool" }),
    "fa/fine": record("ppnn"),
  };
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("gw"), m("legit"), m("fine")] }]);
  saveFidelity(e.out, store, { now: NOW });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--retry-failed", "--only-gateway"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /1 model\(s\) queued of 3/);
  assert.equal(calls(e.f).length, 0);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  const live = await run(["--retry-failed", "--only-gateway", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.deepEqual([...new Set(calls(e.f).map((c) => c.body.model))], ["fa/gw"], "the other failure and the passing model are not asked");
  const after = loadFidelity(e.out).models;
  assert.deepEqual([after["fa/gw"].t, after["fa/gw"].xw, after["fa/gw"].strikes], ["t", undefined, undefined]);
  assert.equal(after["fa/legit"].t, "x", "the genuine failure is untouched");
});

// ---------------------------------------------------------------- (3) migration

test("transientReason: an availability sentence or an unnamed 400 at L1, L2, L3 (3a/3b) or L6 is not a verdict; a named refusal, the big step and the gateway's words are not touched", () => {
  const why = (lvl, msg, st = 400) => `L${lvl}: HTTP ${st}: ${body(msg)}`;
  assert.deepEqual(transientReason(why(2, "anymodel: The selected model is temporarily unavailable. Try another model.")), { level: 2, shape: "temporarily unavailable" });
  assert.deepEqual(transientReason(why(2, "cloudflare: Upstream request failed.")), { level: 2, shape: "upstream request failed" });
  assert.deepEqual(transientReason(why(1, "nararouter: The requested model is not available.")), { level: 1, shape: "unnamed 400" });
  assert.deepEqual(transientReason(`L3: [3b] HTTP 400: ${body("Upstream provider rejected the request")}`), { level: 3, shape: "upstream rejected" });
  assert.deepEqual(transientReason(why(6, "Service unavailable, please retry")), { level: 6, shape: "service unavailable" });
  for (const keep of [why(2, THOUGHT), why(2, EMPTY), why(3, "tools.2.input_schema is invalid"), why(5, "bad request"), "L1: answered in text instead of calling the tool", why(1, "tool use is not supported by the provided model"), why(1, "x: Invalid API key", 401), "", undefined])
    assert.equal(transientReason(keep), null, String(keep));
});

test("migrateTransient (pure): clears what availability produced (a confirmed x, a strike), resets the failed pass (L1+L2 together, L3 with the big step), removes what is otherwise unknown, tags the gateway x's, resets stale af reasons and touches nothing else", () => {
  const W = (l, msg) => `L${l}: HTTP 400: ${body(msg)}`;
  const store = {
    "a/x2": record("pfnn", { strikes: 2, sl: 2, why: W(2, "anymodel: The selected model is temporarily unavailable. Try another model."), af: "p" }),
    "a/s1": record("nnnn", { strikes: 1, sl: 1, why: W(1, "nararouter: The requested model is not available.") }),
    "a/gw": record("pfnn", { strikes: 2, sl: 2, why: W(2, THOUGHT) }),
    "a/gwtagged": record("pfnn", { strikes: 2, sl: 2, why: W(2, THOUGHT), xw: "gateway" }),
    "a/l3": record("ppfn", { strikes: 2, sl: 3, why: `L3: [3b] HTTP 400: ${body("Upstream request failed.")}`, big: "p" }),
    "a/legit": record("fnnn", { strikes: 2, sl: 1, why: "L1: answered in text instead of calling the tool" }),
    "a/afold": record("ppnn", { af: "f", afw: "file_path: newline count differs" }),
    "a/afreal": record("ppnn", { af: "f", afw: "old_string: newline lost" }),
    "a/optional": record("ppnn", { af: "f", afw: "replace_all: missing" }),
  };
  const before = JSON.stringify(store);
  const r = migrateTransient(store);
  assert.equal(JSON.stringify(store), before, "pure");
  assert.deepEqual(r.cleared.map((c) => [c.key, c.kind, c.shape, c.level, c.removed]), [["a/x2", "failed", "temporarily unavailable", 2, true], ["a/s1", "strike", "unnamed 400", 1, true], ["a/l3", "failed", "upstream request failed", 3, false]]);
  assert.equal(r.store["a/x2"], undefined, "L1 and L2 are one pass: a reset asks both again; nothing else was known, so the record goes");
  assert.equal(r.store["a/s1"], undefined, "nothing else known: removed");
  const l3 = r.store["a/l3"];
  assert.deepEqual([l3.lvr, l3.big, l3.strikes], ["ppnn", undefined, undefined], "an L3 reset clears the big step and L4 with it");
  assert.deepEqual(r.tagged, ["a/gw"]);
  assert.equal(r.store["a/gw"].xw, "gateway");
  assert.equal(r.store["a/gw"].t, "x", "still x for routing");
  assert.equal(r.store["a/gwtagged"], store["a/gwtagged"]);
  assert.deepEqual(r.afReset.sort(), ["a/afold", "a/optional"]);
  assert.deepEqual([r.store["a/afold"].af, r.store["a/afold"].afw], [undefined, undefined]);
  assert.equal(r.store["a/afreal"], store["a/afreal"], "a real mangling is kept");
  assert.equal(r.store["a/legit"], store["a/legit"]);
  const again = migrateTransient(r.store);
  assert.deepEqual([again.cleared, again.tagged, again.afReset], [[], [], []], "idempotent");
  assert.deepEqual(migrateTransient(null).cleared, []);
});

test("--reset-transient is dry by default (counts per shape, kind and provider, the gateway tags, the af resets); --live applies it under the lock, atomically, and the pending entries go with the records", async () => {
  const W = (l, msg) => `L${l}: HTTP 400: ${body(msg)}`;
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("u1"), m("g1"), m("ok")] }]);
  saveFidelity(e.out, { "fa/u1": record("pfnn", { strikes: 2, sl: 2, why: W(2, "fa: The selected model is temporarily unavailable. Try another model.") }), "fa/g1": record("pfnn", { strikes: 2, sl: 2, why: W(2, THOUGHT) }), "fa/ok": record("ppnn", { af: "f", afw: "file_path: backslash doubled" }) },
    { now: NOW, pending: { "fa/u1": { r: "error", n: 2, at: NOW.toISOString() } } });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--reset-transient"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /1 of 3 record\(s\) came from an availability or unnamed refusal, never a verdict about tools: confirmed failures 1; shapes: temporarily unavailable 1; 1 would be removed \(asked again from scratch\), 0 keep their other results/);
  assert.match(dry.out, /by provider: fa 1/);
  assert.match(dry.out, /1 would be tagged xw gateway \(they stay x\)/);
  assert.match(dry.out, /argument-fidelity failures that came from the old test content .*: 1 would be cleared/);
  assert.match(dry.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  const live = await run(["--reset-transient", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /1 record\(s\) cleared, 1 tagged xw gateway and 1 argument-fidelity result\(s\) cleared/);
  const st = loadFidelity(e.out);
  assert.deepEqual([st.models["fa/u1"], st.models["fa/g1"].xw, st.models["fa/g1"].t, st.models["fa/ok"].af], [undefined, "gateway", "x", undefined]);
  assert.equal(st.pending["fa/u1"], undefined);
  assert.ok(!fs.existsSync(e.deps.lockFile));
  assert.match((await run(["--reset-transient", "--live"], e.deps)).out, /nothing to change/);
  const f = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("u1")] }]);
  saveFidelity(f.out, { "fa/u1": record("pfnn", { strikes: 2, sl: 2, why: W(2, "fa: Upstream request failed.") }) }, { now: NOW });
  f.deps.saveImpl = () => { throw new Error("disk full"); };
  const bad = await run(["--reset-transient", "--live"], f.deps);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /could not save \(disk full\); nothing was changed/);
  assert.equal(parseArgs(["--reset-transient"]).resetTransient, true);
});

// ---------------------------------------------------------------- (4) argument fidelity means "would corrupt a real Edit"

const withArgs = (over) => ({ ...AWKWARD, ...over });

test("the test content is realistic: the path has spaces, a non-ASCII letter and Windows separators but no newline and no escape look-alike; the awkward characters live in the strings", () => {
  assert.match(AWKWARD.file_path, / /);
  assert.match(AWKWARD.file_path, /[^\x00-\x7f]/);
  assert.ok(AWKWARD.file_path.includes("\\") && !AWKWARD.file_path.includes("\n") && !AWKWARD.file_path.includes("\t"));
  assert.ok(!/\\[bfnrtu"\/\\]/.test(AWKWARD.file_path), "no segment starts with an escape letter, so a JSON round trip cannot be confused");
  assert.ok(AWKWARD.old_string.includes("\n") && AWKWARD.old_string.includes("\\n") && AWKWARD.old_string.includes('"'), "the escape traps are in old_string");
});

test("afCheck: a path with / for \\ passes (a path is a path), an optional parameter left out passes, a REQUIRED field left out fails, a mangled string still fails", () => {
  assert.deepEqual(afCheck(withArgs({ file_path: AWKWARD.file_path.replace(/\\/g, "/") })), { af: "p" });
  assert.deepEqual(afCheck(withArgs({ file_path: AWKWARD.file_path.replace(/\\/g, "\\\\") })).af, "f", "doubled separators are a different path");
  assert.deepEqual(afCheck(withArgs({ file_path: AWKWARD.file_path.replace("My Documents", "My_Documents") })).afw, "file_path: text differs at 16");
  const noOpt = { ...AWKWARD }; delete noOpt.replace_all; delete noOpt.start_line;
  assert.deepEqual(afCheck(noOpt), { af: "p" });
  const noReq = { ...AWKWARD }; delete noReq.old_string;
  assert.deepEqual(afCheck(noReq), { af: "f", afw: "old_string: missing" });
  assert.deepEqual(afCheck(withArgs({ replace_all: "true" })), { af: "f", afw: "replace_all: boolean sent as string" }, "an optional parameter that IS present must be right");
  assert.equal(afCheck(withArgs({ old_string: AWKWARD.old_string.replace(/\n/g, "") })).afw, "old_string: newline lost");
});

// ---------------------------------------------------------------- helpers

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
const one = async (kind, answer) => { const f = fakeFetch(answer); return { r: await runKind(kind, conn(f)), f }; };
function cliEnv(rows, { answer } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], sweep: { ...SWEEP_FAST }, retryDelayMs: 1, rateBackoffMs: 1 };
  return { dir, deps, f, out: deps.outFile };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(pinL12(argv), deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));
void plan; void ok; void ev; void stream; void EDIT_TOOL;

test("a truly UNNAMED 400 (no availability word either) is pending upstream-unavailable at every small level, but a size refusal at the big step", async () => {
  for (const msg of ["Bad request", "nararouter: The requested model is not available.", "request failed", "400"]) {
    for (const k of ["1", "1a", "2", "3a", "3b", "6", "2e"]) {
      const { r } = await one(k, () => http(400, msg));
      assert.deepEqual([r.v, r.reason], ["i", "upstream-unavailable"], `${k}: ${msg}`);
    }
    assert.deepEqual([(await one("5", () => http(400, msg))).r.kind], ["size"], "the big step: an unnamed 400 is a size refusal (a cap)");
  }
});

test("the gateway tag survives a CLIPPED reason: the flag comes from the whole body, and the record also recognises the phrase in a stored reason", async () => {
  const long = `${"x".repeat(400)} ${THOUGHT}`;
  const { r } = await one("2", () => http(400, long));
  assert.equal(r.v, "f");
  assert.ok(!GATEWAY_WORDS.test(r.why), "the stored reason was clipped before the phrase");
  assert.equal(r.gw, true, "but the verdict knows");
  const done = {};
  await probeModel({ levels: [1, 2], done, ...FREE, ...conn(fakeFetch((c) => (kindOf(c) === "2" ? http(400, long) : goodModel(c)))) });
  assert.equal(done[2].gw, true, "the engine keeps it on the level's result");
  const first = buildRecord(null, done, { now: NOW });
  const second = buildRecord(first, done, { now: NOW });
  assert.deepEqual([second.t, second.xw], ["x", "gateway"]);
  const byText = buildRecord(buildRecord(null, { 1: { v: "p" }, 2: { v: "f", why: `HTTP 400: ${THOUGHT}`, kind: "schema" } }, { now: NOW }), { 1: { v: "p" }, 2: { v: "f", why: `HTTP 400: ${THOUGHT}`, kind: "schema" } }, { now: NOW });
  assert.equal(byText.xw, "gateway", "a reason that carries the phrase is enough");
});

test("transientReason: an availability sentence is recognised whatever the status or other words (422, a `type` field), and the big step is not migrated", () => {
  const W = (l, msg, st = 400) => `L${l}: HTTP ${st}: ${body(msg)}`;
  assert.equal(transientReason(W(2, "Service unavailable, please retry", 422)).shape, "service unavailable");
  assert.equal(transientReason(W(2, "Upstream request failed (type: api_error)")).shape, "upstream request failed");
  assert.equal(transientReason(W(5, "Upstream request failed.")), null, "the big step is left alone: a refusal there is a size cap, never x");
});

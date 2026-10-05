// Classification fixes from pilot run 2: a wallet that is empty is an account state (pay), a 400 that says the model must be called another way is a routing matter (route-shape), a 400 that
// says nothing about the request is an upstream one-off until it repeats word for word (upstream-400), and the two non-blocking marker failures carry a short reason (afw, l4w).
// Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, fakeFetch, goodModel, http, ok, ev, stream, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { runKind, probeModel, afCheck, MAX_MODEL_REQUESTS } from "../refresh/tool-fidelity-probe.mjs";
import { main } from "../refresh/tool-fidelity-cli.mjs";
import { buildRecord, cleanFidelity, summaryOf, loadFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";
import { AWKWARD, EDIT_TOOL, ECHO_TOOL } from "../refresh/tool-fidelity-fixture.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const one = async (kind, answer) => { const f = fakeFetch(answer); return { r: await runKind(kind, conn(f)), f }; };

// ---------------------------------------------------------------- (1) an empty wallet is an ACCOUNT state

test("a 400 that says the WALLET is empty is `pay` (an account state, never a failure): the TeamoRouter sentence and its relatives", async () => {
  for (const msg of [
    "Your TeamoRouter wallet balance is insufficient. Recharge at https://teamo.example/pay to continue.",
    "balance insufficient, please recharge your account", "Your credit balance is too low", "You have run out of credits", "Please top up your account to continue",
    "Credit limit reached for this key", "Insufficient wallet funds", "Payment required: add funds to continue", "Not enough credits for this request"]) {
    const { r } = await one("1", () => http(400, msg));
    assert.deepEqual([r.v, r.s], ["i", "pay"], msg);
  }
  const probe = await probeModel({ levels: [1, 2], done: {}, ...FREE, ...conn(fakeFetch(() => http(400, "Your TeamoRouter wallet balance is insufficient. Recharge at [url] to continue.")) ) });
  assert.equal(probe.inconclusive.s, "pay");
  assert.equal(probe.inconclusive.reason, undefined);
});

test("the old false positive stays fixed: a tool or schema name that merely CONTAINS balance, recharge or purchase in a schema refusal is still a verdict about the request, not an account state", async () => {
  for (const msg of ["tools.3.input_schema: tool 'check_balance' has an invalid schema", "Invalid tool name recharge_card: does not match pattern", "tools.0.name: 'purchase_item' is not a valid name",
    "tools.2.input_schema.properties.topup: 'string' is not valid under any of the given schemas", "unsupported keyword anyOf in the parameters of billing_lookup"]) {
    const { r } = await one("1", () => http(400, msg));
    assert.equal(r.v, "f", msg);
    assert.equal(r.kind, "schema", msg);
  }
  const echo = await one("1", () => ({ status: 400, body: JSON.stringify({ error: { message: "tool 'check_balance' schema invalid" }, request: { tools: [{ name: "check_balance", description: "Return the insufficient funds of a wallet; recharge it" }] } }), headers: {} }));
  assert.equal(echo.r.v, "f", "the echo of a tool description in the body is not the provider's sentence");
});

test("end to end: a wallet 400 on L1 is pending pay, never a strike, never a record; the provider is named in the attention block with the models it skipped", async () => {
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1")] }], {
    answer: (c) => (c.body.model.startsWith("fa/") ? http(400, "Your TeamoRouter wallet balance is insufficient. Recharge at [url] to continue.") : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.models), ["fb/b1"], "no record for the wallet-less provider, no strike either");
  assert.equal(st.pending["fa/a1"].r, "pay");
  assert.match(r.out, /fa: pay \(no credit or the plan does not allow it\) -- 2 model\(s\) skipped/);
});

// ---------------------------------------------------------------- (2) a route that wants another shape

test("a 400 that says the model must be called another way is `route-shape`: inconclusive, with the provider's words as a hint, never a strike", async () => {
  for (const msg of ['Model "claude-opus-5" must be called via /provider/v1/messages (Anthropic Messages shape)', "Wrong endpoint for this model", "Please use /v1/messages for this model", "unsupported protocol for this route",
    "This model is only available via the /v1/chat/completions endpoint"]) {
    const { r } = await one("1", () => http(400, msg));
    assert.deepEqual([r.v, r.s, r.reason], ["i", "error", "route-shape"], msg);
    assert.ok(r.hint.length > 5 && r.hint.length <= 120, r.hint);
  }
  const probe = await probeModel({ levels: [1, 2], done: {}, ...FREE, ...conn(fakeFetch(() => http(400, 'Model "x" must be called via /provider/v1/messages'))) });
  assert.deepEqual([probe.inconclusive.reason, probe.inconclusive.hint.includes("must be called via")], ["route-shape", true]);
  const normal = await one("1", () => http(400, "tools.0.input_schema: unsupported keyword anyOf"));
  assert.equal(normal.r.v, "f", "a schema refusal is not a route shape");
});

test("end to end: a route-shape 400 is pending route-shape (no record, no strike), and the report names the provider and the provider's hint in a routing-fix block", async () => {
  const e = cliEnv([{ provider: "cc", keyId: "k.cc.free", models: [m("opus"), m("sonnet")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1")] }], {
    answer: (c) => (c.body.model.startsWith("cc/") ? http(400, 'Model "claude-opus-5" must be called via /provider/v1/messages (Anthropic Messages shape)') : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.deepEqual(Object.keys(st.models), ["fb/b1"]);
  assert.equal(st.pending["cc/opus"].r, "route-shape");
  assert.equal(st.pending["cc/sonnet"].r, "route-shape");
  assert.match(r.out, /providers needing a routing fix \(.*pending: route-shape\):/);
  assert.match(r.out, /cc: 2 model\(s\) -- the provider said: Model "claude-opus-5" must be called via/);
  assert.equal(calls(e.f).filter((c) => c.body.model === "cc/opus").length, 1, "no retry of a route that cannot answer");
});

// ---------------------------------------------------------------- (3) a 400 that says nothing about the request

test("a 400 that names nothing about the request (\"Upstream provider rejected the request\") is asked ONCE more: the same words twice are the provider's answer (a verdict), anything else stays pending upstream-400", async () => {
  const msg = "Upstream provider rejected the request";
  const twice = fakeFetch(() => http(400, msg));
  const d = {};
  const r = await probeModel({ levels: [3], prior: "ppnn", done: d, ...FREE, ...conn(twice) });
  assert.equal(twice.calls.length, 2, "asked twice");
  assert.deepEqual([d[3].v, d[3].kind], ["f", "schema"], "identical twice: a verdict");
  assert.equal(r.inconclusive, undefined);
  let n = 0;
  const differs = fakeFetch(() => http(400, ++n === 1 ? "Upstream provider rejected the request" : "Upstream gateway refused it (try later)"));
  const r2 = await probeModel({ levels: [1, 2], done: {}, ...FREE, ...conn(differs) });
  assert.deepEqual([r2.inconclusive.s, r2.inconclusive.reason], ["error", "upstream-400"], "different words: a one-off, pending");
  const heals = fakeFetch((c) => (++n % 2 === 0 ? http(400, msg) : goodModel(c)));
  n = 0;
  const d3 = {};
  const r3 = await probeModel({ levels: [1], done: d3, ...FREE, ...conn(heals) });
  assert.equal(r3.inconclusive, undefined);
  assert.equal(d3[1].v, "p", "the second attempt passed: the model is fine");
  const ids = fakeFetch(() => http(400, `Upstream provider rejected the request (request ${["8f3a9c2e", "1d4b7a90"][0]}-aaaa)`));
  let k = 0;
  const f2 = fakeFetch(() => http(400, `Upstream provider rejected the request (request ${k++ ? "5c6d7e8f" : "8f3a9c2e"}-aaaa)`));
  const d4 = {};
  await probeModel({ levels: [3], prior: "ppnn", done: d4, ...FREE, ...conn(f2) });
  assert.equal(d4[3].v, "f", "request ids in the text do not make two identical refusals different");
  void ids;
});

test("a 400 that names the request's shape is a verdict at once (one request): schema, tool, parameter, format words", async () => {
  for (const msg of ["Invalid parameter: tools[3].input_schema", "unsupported tool_choice", "Malformed JSON in the request", "tools.2.name: too long", "input validation failed"]) {
    const f = fakeFetch(() => http(400, msg));
    const d = {};
    await probeModel({ levels: [3], prior: "ppnn", done: d, ...FREE, ...conn(f) });
    assert.equal(f.calls.length, 1, msg);
    assert.equal(d[3].v, "f", msg);
  }
});

test("the confirmed upstream 400 is read like any other refusal: at the big step it is a SIZE cap, not a schema verdict; the confirmation counts toward the request ceiling", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "5" ? http(400, "bad request") : goodModel(c)));
  const d = {}, st = {};
  await probeModel({ levels: [1, 2, 3, 5], done: d, state: st, ...FREE, ...conn(f) });
  assert.deepEqual([d[5].v, d[5].kind], ["f", "size"]);
  assert.equal(f.calls.filter((c) => kindOf(c) === "5").length, 2);
  const g = fakeFetch(() => http(400, "Upstream provider rejected the request"));
  const r = await probeModel({ levels: [1], done: {}, state: { requests: MAX_MODEL_REQUESTS - 1 }, ...FREE, ...conn(g) });
  assert.equal(g.calls.length, 1, "one request left: the confirmation is not sent");
  assert.equal(r.inconclusive.reason, "request-cap");
});

test("end to end: an unconfirmed upstream 400 is pending upstream-400 (no record, no strike) and the report counts it; a repeated one becomes a first strike like any schema refusal", async () => {
  let n = 0;
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }, { provider: "fb", keyId: "k.fb.free", models: [m("b1")] }], {
    answer: (c) => (c.body.model === "fa/a1" ? http(400, ++n % 2 ? "Upstream provider rejected the request" : "Upstream gateway refused it (try later)") : goodModel(c)) });
  const r = await run(["--live", "--per-provider", "1"], e.deps);
  const st = loadFidelity(e.out);
  assert.equal(st.pending["fa/a1"].r, "upstream-400");
  assert.ok(!st.models["fa/a1"]);
  assert.match(r.out, /pending: upstream-400 \(a 400 that says nothing about the request; asked twice, not word for word the same twice; never a verdict, a later run asks again\): 1 model\(s\)/);
  const e2 = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("a1")] }], { answer: (c) => http(400, "Upstream provider rejected the request") });
  await run(["--live"], e2.deps);
  const rec = loadFidelity(e2.out).models["fa/a1"];
  assert.deepEqual([rec.strikes, rec.t], [1, "u"], "the same words twice: a first strike (provisional), like any schema refusal");
});

// ---------------------------------------------------------------- (4) afw and l4w, and the strictness of the argument check

const calling = (v) => () => ok(stream(ev.tool(0, EDIT_TOOL, JSON.stringify(v)), ev.stop("tool_use")));
const mangled = (k, fn) => ({ ...AWKWARD, [k]: fn(AWKWARD[k]) });

test("afCheck is exact where an Edit would fail (a lost newline, a doubled backslash, CRLF, NFD, trailing whitespace, an escaped character, a stringified integer or boolean, a missing field) and says WHAT differed, in at most 60 characters", () => {
  const cases = [
    [mangled("old_string", (s) => s.replace(/\n/g, "")), "old_string: newline lost"],
    [mangled("old_string", (s) => s.replace(/\n/g, "\r\n")), "old_string: CRLF line endings"],
    [mangled("old_string", (s) => `${s}\n`), "old_string: trailing whitespace changed"],
    [mangled("old_string", (s) => s.replace(/é/g, "é")), "old_string: unicode normalisation (NFC/NFD)"],
    [mangled("old_string", (s) => s.replace(/é/g, "\\u00e9")), "old_string: unicode escaped as \\u"],
    [mangled("file_path", (s) => s.replace(/\\/g, "\\\\")), "file_path: backslash doubled"],
    [mangled("old_string", (s) => s.replace(/\t/g, "  ").replace(/\n/g, " \n")), null],
    [mangled("old_string", (s) => s.replace(/"/g, "'")), "old_string: quote changed"],
    [mangled("new_string", (s) => s.replace(/🚀/u, "?")), "new_string: astral character lost"],
    [{ ...AWKWARD, start_line: "12" }, "start_line: integer sent as string"],
    [{ ...AWKWARD, replace_all: "true" }, "replace_all: boolean sent as string"],
    [(() => { const { file_path, ...rest } = AWKWARD; return rest; })(), "file_path: missing"],
  ];
  for (const [v, want] of cases) {
    const r = afCheck(v);
    assert.equal(r.af, "f");
    if (want) assert.equal(r.afw, want);
    assert.ok(r.afw.length <= 60 && /^[ -~]+$/.test(r.afw), r.afw);
  }
  assert.deepEqual(afCheck({ ...AWKWARD }), { af: "p" });
  assert.deepEqual(afCheck({ replace_all: true, start_line: 12, new_string: AWKWARD.new_string, old_string: AWKWARD.old_string, file_path: AWKWARD.file_path }), { af: "p" }, "key order does not matter");
  assert.deepEqual(afCheck({ ...AWKWARD, extra_field: "x" }), { af: "p" }, "a field the schema does not name does not matter to the arguments that were asked for");
});

test("L1: a mangled argument fails `af` (never L1), carries `afw` in the verdict, and the record keeps it, clears it on a later pass, and summaryOf prints it", async () => {
  const bad = await one("1a", calling(mangled("old_string", (s) => s.replace(/\n/g, ""))));
  assert.deepEqual([bad.r.v, bad.r.af, bad.r.afw], ["p", "f", "old_string: newline lost"]);
  const good = await one("1a", calling({ ...AWKWARD }));
  assert.deepEqual([good.r.v, good.r.af, good.r.afw], ["p", "p", undefined]);
  const rec = buildRecord(null, { 1: { v: "p", af: "f", afw: "old_string: newline lost" }, 2: { v: "p" } }, { now: NOW });
  assert.equal(rec.afw, "old_string: newline lost");
  assert.equal(cleanFidelity(rec)?.afw, "old_string: newline lost", "the cleaner accepts it and keeps it");
  assert.ok(summaryOf(rec).notes.some((n) => /argument fidelity failed: old_string: newline lost/.test(n)));
  const later = buildRecord(rec, { 1: { v: "p", af: "p" }, 2: { v: "p" } }, { now: NOW });
  assert.equal(later.afw, undefined, "a later pass clears the note");
  const untouched = buildRecord(rec, { 3: { v: "p", bytes: 1000 } }, { now: NOW });
  assert.equal(untouched.afw, "old_string: newline lost", "a probe that did not look at L1 keeps it");
  for (const badNote of ["x".repeat(61), "café", "", 5, "line\nbreak"]) assert.equal(cleanFidelity({ ...rec, afw: badNote }), null, JSON.stringify(badNote));
});

test("L4: a failed parallel-call check carries `l4w` (how many calls of 2 came back, or what else was wrong), stored on the record, cleared by a later pass", async () => {
  const single = await one("3b", () => ok(stream(ev.tool(0, ECHO_TOOL, '{"message":"a"}', "toolu_a"), ev.stop("tool_use"))));
  assert.deepEqual([single.r.l4, single.r.l4w], ["f", "1 call of 2"]);
  const none = await one("3b", () => ok(stream(ev.text(0, "ok"), ev.stop("end_turn"))));
  assert.deepEqual([none.r.l4, none.r.l4w], ["f", "0 call of 2"]);
  const two = await one("3b", () => ok(stream(ev.tool(0, ECHO_TOOL, '{"message":"a"}', "toolu_a"), ev.tool(1, ECHO_TOOL, '{"message":"b"}', "toolu_b"), ev.stop("tool_use"))));
  assert.equal(two.r.l4, "p");
  assert.equal(two.r.l4w, undefined);
  const base = buildRecord(null, { 1: { v: "p" }, 2: { v: "p" }, 3: { v: "p", bytes: 1 }, 4: { v: "f", why: "1 tool call instead of 2 parallel calls", w: "1 call of 2" } }, { now: NOW });
  assert.equal(base.l4w, "1 call of 2");
  assert.equal(cleanFidelity(base)?.l4w, "1 call of 2");
  assert.ok(summaryOf(base).notes.some((n) => /parallel calls failed: 1 call of 2/.test(n)));
  const healed = buildRecord(base, { 4: { v: "p", bytes: 1 } }, { now: NOW });
  assert.equal(healed.l4w, undefined);
  void record;
});

// ---------------------------------------------------------------- the CLI helpers

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
function cliEnv(rows, { answer } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
  return { dir, deps, f, out: deps.outFile };
}
async function run(argv, deps) {
  const out = [], err = [], lg = console.log, er = console.error;
  console.log = (...a) => out.push(a.join(" ")); console.error = (...a) => err.push(a.join(" "));
  let code;
  try { code = await main(argv, deps); } finally { console.log = lg; console.error = er; }
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const calls = (f) => f.calls.filter((c) => !c.url.endsWith("/health"));

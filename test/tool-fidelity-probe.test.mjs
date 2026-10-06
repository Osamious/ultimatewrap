// The tool-fidelity requests against fake streams: every request kind, every verdict and every failure mode, offline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { ev, stream, fakeFetch, ok, http, goodModel, kindOf } from "./fixtures/tool-fidelity-helpers.mjs";
import { runKind, buildBody, kindSize, levelSize, kindsOf, judge, BUDGETS, TIMEOUTS_MS, TIMEOUT_CAPS_MS, TIMEOUT_FACTOR } from "../refresh/tool-fidelity-probe.mjs";
import { AWKWARD, BIG_RESULT_FACT, LONG_TOOL, ERROR_RESULT } from "../refresh/tool-fidelity-fixture.mjs";

guardRealState(after, assert);
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const kind = async (k, answer, extra) => { const f = fakeFetch(answer); const r = await runKind(k, conn(f, extra)); return { r, f }; };
const edit = (over = {}) => JSON.stringify({ file_path: AWKWARD.file_path, old_string: AWKWARD.old_string, new_string: AWKWARD.new_string, replace_all: AWKWARD.replace_all, start_line: AWKWARD.start_line, ...over });
const callEcho = (json = '{"message":"hello"}') => ok(stream(ev.tool(0, "fx_echo", json), ev.stop("tool_use")));
const callEdit = (json = edit()) => ok(stream(ev.tool(0, "fx_edit", json), ev.stop("tool_use")));

test("request shapes: L1 leaves the choice to the model, 1f forces it, L2 carries a ~20 KB result with the fact at the END, 2e an is_error result, 3a is small, 3b ~157 KB, 5 ~400 KB, 6 offers the Agent tool", () => {
  const b1 = buildBody("1", "p/m");
  assert.deepEqual(b1.tool_choice, { type: "auto" });
  assert.deepEqual([b1.tools.length, b1.tools[0].name], [1, "fx_echo"], "L1 is a SIMPLE echo call");
  assert.equal(b1.stream, true);
  assert.ok(b1.messages[0].content.includes('"hello"') && !b1.messages[0].content.includes(AWKWARD.old_string), "a plain short message: no awkward content in L1");
  assert.deepEqual(buildBody("1f", "p/m").tool_choice, { type: "tool", name: "fx_echo" });
  const b1a = buildBody("1a", "p/m");
  assert.deepEqual([b1a.tool_choice, b1a.tools.length, b1a.tools[0].name], [{ type: "auto" }, 1, "fx_edit"]);
  assert.ok(b1a.messages[0].content.includes(AWKWARD.file_path) && b1a.messages[0].content.includes(AWKWARD.old_string) && b1a.messages[0].content.includes(AWKWARD.new_string), "the argument-fidelity request carries the awkward texts it must copy");
  assert.deepEqual(buildBody("1af", "p/m").tool_choice, { type: "tool", name: "fx_edit" });
  const b2 = buildBody("2", "p/m");
  const [u, a, r] = b2.messages;
  assert.equal(a.content[0].type, "tool_use");
  assert.equal(r.content[0].tool_use_id, a.content[0].id, "the tool_result answers the assistant's tool_use id");
  assert.ok(r.content[0].content.length > 19000 && r.content[0].content.length < 22000, "about 20 KB");
  assert.ok(r.content[0].content.trimEnd().endsWith(`${BIG_RESULT_FACT}.`), "the fact is on the LAST line");
  assert.ok(!r.content[0].content.slice(0, -200).includes(BIG_RESULT_FACT), "and nowhere before it");
  assert.equal(b2.tool_choice, undefined, "the round trip does not force a call");
  const b7 = buildBody("2e", "p/m");
  assert.equal(b7.messages[2].content[0].is_error, true);
  assert.equal(b7.messages[2].content[0].content, ERROR_RESULT);
  assert.ok(kindSize("1").bytes < 1500 && kindSize("1a").bytes < 3000 && kindSize("2e").bytes < 3000 && kindSize("6").bytes < 3000, "the cheap requests are small");
  assert.ok(kindSize("3a").bytes > 4000 && kindSize("3a").bytes < 12000, `3a is about 6-9 KB: ${kindSize("3a").bytes}`);
  assert.ok(kindSize("3b").bytes > 150000 && kindSize("3b").bytes < 165000, `3b: ${kindSize("3b").bytes}`);
  assert.ok(kindSize("3b").inTokens > 37000 && kindSize("3b").inTokens < 42000);
  assert.ok(kindSize("5").bytes > 390000 && kindSize("5").bytes < 410000);
  const b6 = buildBody("6", "p/m");
  assert.deepEqual([b6.tools.length, b6.tools[0].name, b6.tool_choice], [1, "Agent", { type: "auto" }]);
  assert.deepEqual(b6.tools[0].input_schema.properties.subagent_type.enum.slice(0, 2), ["general-purpose", "Explore"]);
  assert.ok(/three independent/.test(b6.messages[0].content) && /Agent tool/.test(b6.messages[0].content), "the task plainly warrants delegating");
});

test("cache_control rides on the system block and the LAST tool of 3a, 3b and the big step, exactly as the real client sends it; `noCc` leaves it off", () => {
  for (const k of ["3a", "3b", "5"]) {
    const b = buildBody(k, "p/m");
    assert.deepEqual(b.system[0].cache_control, { type: "ephemeral" }, `${k}: system block`);
    assert.deepEqual(b.tools.at(-1).cache_control, { type: "ephemeral" }, `${k}: last tool`);
    assert.equal(b.tools.slice(0, -1).some((t) => t.cache_control), false, `${k}: only the last tool`);
    const off = buildBody(k, "p/m", undefined, { noCc: true });
    assert.equal(typeof off.system, "string");
    assert.equal(JSON.stringify(off).includes("cache_control"), false, `${k}: no marker at all without cc`);
  }
  assert.ok(buildBody("3a", "p/m").tools.some((t) => t.name === LONG_TOOL), "3a offers the MCP-style long name");
  assert.ok(LONG_TOOL.length >= 55 && LONG_TOOL.length <= 64 && /^mcp__[a-z_]+$/.test(LONG_TOOL));
  assert.ok(buildBody("3b", "p/m").tools.some((t) => t.name === LONG_TOOL), "and so does the 157 KB set");
});

test("budgets and timeouts are small and pinned: 256 for L1, L2, 3a, 3b and the error result, 512 for the big step, spawn and the argument-fidelity request; timeout floors 45 s, 90 s and 120 s by request class, caps 120 s, 180 s and 240 s", () => {
  assert.deepEqual({ ...BUDGETS }, { "1": 256, "1f": 256, "1a": 512, "1af": 512, "2": 256, "2e": 256, "3a": 256, "3b": 256, "5": 512, "6": 512 });
  assert.deepEqual({ ...TIMEOUTS_MS }, { small: 45000, "157": 90000, big: 120000 });
  assert.deepEqual({ ...TIMEOUT_CAPS_MS }, { small: 120000, "157": 180000, big: 240000 });
  assert.equal(TIMEOUT_FACTOR, 3);
  for (const k of Object.keys(BUDGETS)) assert.equal(buildBody(k, "p/m").max_tokens, BUDGETS[k], k);
  assert.equal(buildBody("1", "p/m", 999).max_tokens, 999, "an explicit budget wins");
});

test("which requests a todo sends: L3 is 3a then 3b, L4 alone is 3b, L4 beside L3 is nothing extra; the level sizes follow", () => {
  assert.deepEqual(kindsOf([1, 2]), ["1", "1a", "2"], "L1 is two requests: the simple call and the argument-fidelity request");
  assert.deepEqual(kindsOf([3, 4]), ["3a", "3b"]);
  assert.deepEqual(kindsOf([4]), ["3b"]);
  assert.deepEqual(kindsOf([1, 2, 3, 4, 5, 6, 7]), ["1", "1a", "2", "2e", "3a", "3b", "5", "6"]);
  assert.equal(levelSize(4).requests, 0);
  assert.equal(levelSize(4, { withLevel3: false }).requests, 1);
  assert.equal(levelSize(3).requests, 2);
  assert.equal(levelSize(3).bytes, kindSize("3a").bytes + kindSize("3b").bytes);
});

test("every request goes to the gateway URL with the probe client tag and stream:true", async () => {
  const { f } = await kind("1", goodModel);
  const c = f.calls[0];
  assert.equal(c.url, "http://gw.test/v1/messages");
  assert.equal(c.body.model, "p/m");
  assert.equal(c.headers["x-api-key"], "k");
  assert.equal(c.headers["x-ccr-client"], "uw-probe");
  assert.equal(c.body.stream, true);
});

test("L1: a SIMPLE echo call with the choice left AUTO passes on a tool_use with valid JSON and the required argument; it says nothing about awkward content", async () => {
  const { r, f } = await kind("1", () => callEcho());
  assert.deepEqual([r.v, r.af, r.reqs, r.forced], ["p", undefined, 1, undefined]);
  assert.equal(f.calls.length, 1, "a pass under auto sends no forced request");
  assert.equal(kindOf(f.calls[0]), "1");
});

test("1a (argument fidelity): the awkward-content Edit call under AUTO, `af` p when every field comes back byte for byte (multi-line, quotes, backslashes, unicode, JSON in a string, boolean, integer); never a failure of the level", async () => {
  const { r, f } = await kind("1a", () => callEdit());
  assert.deepEqual([r.v, r.af, r.reqs], ["p", "p", 1]);
  assert.equal(kindOf(f.calls[0]), "1a");
  const bad = await kind("1a", () => callEdit('{"file_path":"x'));
  assert.deepEqual([bad.r.v, bad.r.af, bad.r.afw], ["p", "f", "arguments not valid JSON"], "invalid JSON for awkward content is an af failure, not a failed request");
  const other = await kind("1a", () => ok(stream(ev.tool(0, "rm_rf", "{}"), ev.stop("tool_use"))));
  assert.deepEqual([other.r.v, other.r.af, other.r.afw], ["p", "f", "called another tool"]);
  const missing = await kind("1a", () => callEdit('{"old_string":"a","new_string":"b"}'));
  assert.deepEqual([missing.r.v, missing.r.af, missing.r.afw], ["p", "f", "file_path: missing"]);
});

test("argument fidelity `af`: any change in any field fails `af`, never the request (the call itself was well formed)", async () => {
  const mutations = {
    "a backslash lost": { old_string: AWKWARD.old_string.replace(String.fromCharCode(92) + " and a literal", " and a literal") }, "unicode mangled": { new_string: AWKWARD.new_string.replace("🚀", "?") },
    "newline turned into space": { old_string: AWKWARD.old_string.replace("\n\t", " \t") }, "JSON string re-escaped": { new_string: JSON.stringify(JSON.parse(AWKWARD.new_string.split("\n")[0])) + "\n" + AWKWARD.new_string.split("\n")[1] },
    "boolean sent as a string": { replace_all: "true" }, "integer sent as a string": { start_line: "12" }, "integer sent as a float": { start_line: 12.5 }, "path altered": { file_path: AWKWARD.file_path.toLowerCase() },
    "trailing space": { old_string: `${AWKWARD.old_string} ` },
  };
  for (const [name, over] of Object.entries(mutations)) {
    const { r } = await kind("1a", () => callEdit(edit(over)));
    assert.deepEqual([r.v, r.af], ["p", "f"], name);
  }
  const exact = await kind("1a", () => callEdit(edit({ replace_all: true, start_line: 12 })));
  assert.equal(exact.r.af, "p");
});

test("L1 failure modes: text instead of a call, no content, invalid JSON, a tool that was not offered, the required argument missing", async () => {
  const text = await kind("1", () => ok(stream(ev.text(0, "done"), ev.stop())), { });
  assert.deepEqual([text.r.v, text.r.nocall], ["f", true]);
  const bad = await kind("1", () => callEcho('{"message":"x'));
  assert.deepEqual([bad.r.v, bad.r.why], ["f", "tool call arguments are not valid JSON"], "a SIMPLE call with broken JSON is a real L1 failure");
  assert.equal((await kind("1", () => callEcho('["x"]'))).r.v, "f", "arguments must be a JSON object");
  const other = await kind("1", () => ok(stream(ev.tool(0, "rm_rf", "{}"), ev.stop("tool_use"))));
  assert.deepEqual([other.r.v, other.r.why], ["f", "tool call names a tool that was not offered"]);
  const miss = await kind("1", () => callEcho("{}"));
  assert.deepEqual([miss.r.v, miss.r.why], ["f", "a tool call lacks the required argument `message`"]);
});

test("FORCED fallback: only when auto yields NO call. A model that calls when forced is `fc` p (clean L1 pass but class t at best), one that fails forced too is `fc` f; a backend that rejects a forced choice leaves the auto verdict", async () => {
  const seen = [];
  const f = fakeFetch((c) => { seen.push(kindOf(c)); return kindOf(c) === "1f" ? callEcho() : ok(stream(ev.text(0, "I would echo it."), ev.stop())); });
  const r = await runKind("1", conn(f));
  assert.deepEqual(seen, ["1", "1f"]);
  assert.deepEqual([r.v, r.fc, r.forced, r.reqs, r.af], ["p", "p", true, 2, undefined]);
  const both = await runKind("1", conn(fakeFetch(() => ok(stream(ev.text(0, "no"), ev.stop())))));
  assert.deepEqual([both.v, both.fc, both.reqs], ["f", "f", 2]);
  const refused = await runKind("1", conn(fakeFetch((c) => (kindOf(c) === "1f" ? http(400, "tool_choice is not supported by this model") : ok(stream(ev.text(0, "no"), ev.stop()))))));
  assert.deepEqual([refused.v, refused.fc, refused.forcedRejected, refused.reqs], ["f", undefined, true, 2], "the backend does not take a forced choice: the auto verdict stands, no fc");
  const hardFail = await kind("1", () => http(400, "schema rejected"));
  assert.equal(hardFail.f.calls.length, 1, "an HTTP verdict is not a 'no call': nothing is forced");
  const inc = await runKind("1", conn(fakeFetch((c) => (kindOf(c) === "1f" ? http(429, "slow") : ok(stream(ev.text(0, "no"), ev.stop()))))));
  assert.deepEqual([inc.v, inc.s], ["i", "rate"], "an inconclusive forced answer is inconclusive");
});

test("HTTP 400, 413 and 422 on a tool-bearing request are verdicts: failed, with the reason redacted and clipped", async () => {
  for (const status of [400, 413, 422]) {
    const { r } = await kind("3b", () => http(status, `schema rejected ${"y".repeat(500)}`));
    assert.equal(r.v, "f", `HTTP ${status}`);
    assert.equal(r.http, status);
    assert.ok(r.why.length <= 160, "clipped");
  }
  const fake = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");           // built at run time: no key-shaped literal in the source
  const leaky = await kind("1", () => http(400, `bad request for key ${fake}`));
  assert.ok(!leaky.r.why.includes(fake.slice(0, 12)), "a key-shaped string in the provider's sentence is masked");
});

test("account and moment failures are INCONCLUSIVE, never a failed verdict: 429 rate, 402 pay, 401 auth, 404 gone, 500 error", async () => {
  const cases = [[429, "slow down", "rate"], [402, "payment required", "pay"], [401, "bad key", "auth"], [404, "not found", "gone"], [500, "oops", "error"], [503, "unavailable", "error"]];
  for (const [status, msg, s] of cases) {
    const { r } = await kind("1", () => http(status, msg));
    assert.deepEqual([r.v, r.s], ["i", s], `HTTP ${status}`);
  }
  const ra = await kind("1", () => http(429, "slow down", { "retry-after": "7" }));
  assert.equal(ra.r.ra, 7000, "Retry-After is carried for the engine's backoff");
  const quota = await kind("1", () => http(400, "insufficient balance, please top up"));
  assert.deepEqual([quota.r.v, quota.r.s], ["i", "pay"], "a 400 that says the account is empty is the account's state, not the model's");
});

test("stream error events: an account/overload sentence is inconclusive; an unexplained one before any content is a failure; a 200 with no events says nothing", async () => {
  assert.deepEqual(Object.values((({ r }) => ({ v: r.v, s: r.s }))(await kind("1", () => ok(stream(ev.error("Overloaded, try again")))))), ["i", "error"]);
  assert.equal((await kind("1", () => ok(stream(ev.error("unsupported schema keyword anyOf"))))).r.v, "f");
  const none = await kind("1", () => ok(""));
  assert.deepEqual([none.r.v, none.r.s], ["i", "error"]);
});

test("a budget spent on hidden reasoning (max_tokens, no content) is inconclusive `empty`, never a failed call, at every kind", async () => {
  for (const k of ["1", "2", "2e", "3a", "3b", "5", "6"]) {
    const { r } = await kind(k, () => ok(stream(ev.stop("max_tokens"))));
    assert.deepEqual([r.v, r.s], ["i", "empty"], k);
  }
});

test("TIMEOUTS are per request class and inconclusive: small 15 s, 157 KB 60 s, 400 KB 90 s by default; a hung request is `timeout`, a caller's abort is not a result", async () => {
  const hang = async (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
  const t0 = Date.now();
  const small = await runKind("1", conn(hang, { timeouts: { small: 30, "157": 5000, big: 5000 } }));
  assert.deepEqual([small.v, small.s], ["i", "timeout"]);
  assert.ok(Date.now() - t0 < 2500, "the SMALL class timeout applied, not the long ones");
  const t1 = Date.now();
  const mid = await runKind("3b", conn(hang, { timeouts: { small: 5000, "157": 40, big: 5000 } }));
  const big = await runKind("5", conn(hang, { timeouts: { small: 5000, "157": 5000, big: 50 } }));
  assert.deepEqual([mid.s, big.s], ["timeout", "timeout"]);
  assert.ok(Date.now() - t1 < 4500, "each request kind used its own class");
  const ac = new AbortController();
  const p = runKind("1", conn(hang, { signal: ac.signal }));
  ac.abort();
  assert.deepEqual(await p, { aborted: true });
  const net = await runKind("1", conn(async () => { throw new Error("socket hang up"); }));
  assert.deepEqual([net.v, net.s], ["i", "error"]);
});

test("L2: a final text answer passes; `br` is p when the answer uses the fact from the END of the 20 KB result and f when it does not; calling the tool again, no answer and a 400 fail", async () => {
  const good = await kind("2", goodModel);
  assert.deepEqual([good.r.v, good.r.br], ["p", "p"]);
  const wrong = await kind("2", () => ok(stream(ev.text(0, "The code is AB-0001."), ev.stop())));
  assert.deepEqual([wrong.r.v, wrong.r.br], ["p", "f"], "an answer, but not from the end of the result: L2 holds, `br` fails");
  const again = await kind("2", () => ok(stream(ev.tool(0, "fx_read", '{"file_path":"/ws/report.txt"}'), ev.stop("tool_use"))));
  assert.deepEqual([again.r.v, again.r.why], ["f", "called the tool again instead of answering"]);
  assert.deepEqual([(await kind("2", () => ok(stream(ev.stop())))).r.why], ["no final answer after the tool result"]);
  assert.equal((await kind("2", () => http(400, "messages.2: tool_result blocks are not supported"))).r.v, "f", "a 400 on the round trip is exactly what L2 exists to catch");
  assert.equal((await kind("2", () => ok(stream(ev.text(0, `code ${BIG_RESULT_FACT}`), ev.error("upstream decode failed"))))).r.v, "f");
});

test("L7 the error result: an answer (text) or a retry (a new call) passes `er`; an EMPTY answer fails; a 400 fails", async () => {
  assert.equal((await kind("2e", goodModel)).r.v, "p");
  assert.equal((await kind("2e", () => ok(stream(ev.tool(0, "fx_read", '{"file_path":"/ws/other.txt"}'), ev.stop("tool_use"))))).r.v, "p", "retrying with another call is a reaction");
  const empty = await kind("2e", () => ok(stream(ev.text(0, "  "), ev.stop())));
  assert.deepEqual([empty.r.v, empty.r.why], ["f", "empty answer after an error result"]);
  assert.equal((await kind("2e", () => http(400, "tool_result is_error is not supported"))).r.v, "f");
});

test("3a (the constructs request): an answer passes; the long MCP-style name coming back exactly is `nm` p, a different name `nm` f, no call at all says nothing; a construct rejection is the schema verdict", async () => {
  const good = await kind("3a", goodModel);
  assert.deepEqual([good.r.v, good.r.nm], ["p", "p"]);
  const mangled = await kind("3a", () => ok(stream(ev.tool(0, LONG_TOOL.slice(0, 40), '{"mode":"demo"}'), ev.stop("tool_use"))));
  assert.deepEqual([mangled.r.v, mangled.r.nm], ["p", "f"]);
  const text = await kind("3a", () => ok(stream(ev.text(0, "I would call it."), ev.stop())));
  assert.deepEqual([text.r.v, text.r.nm], ["p", undefined]);
  const construct = await kind("3a", () => http(400, "tools.0.input_schema: unsupported keyword anyOf"));
  assert.deepEqual([construct.r.v, construct.r.kind], ["f", "schema"], "3a is small: a refusal here is never about size");
  const big = await kind("3a", () => http(400, "request payload too large"));
  assert.equal(big.r.kind, "schema");
  const name = await kind("3a", () => http(400, "tools.0.name: String should match pattern '^[a-zA-Z0-9_-]{1,64}$'"));
  assert.deepEqual([name.r.v, name.r.nmFail, name.r.kind], ["f", true, "schema"], "a 400 naming the tool name is a verdict, flagged for `nm`");
  assert.equal((await kind("3a", () => ok(stream(ev.stop())))).r.v, "f");
});

test("a 400 that names cache_control is flagged `ccFail` (a verdict the caller can act on) at 3a, 3b and the big step only", async () => {
  for (const k of ["3a", "3b", "5"]) {
    const { r } = await kind(k, () => http(400, "system.0.cache_control: Extra inputs are not permitted"));
    assert.deepEqual([r.v, r.ccFail, r.kind], ["f", true, "schema"], k);
  }
  const l1 = await kind("1", () => http(400, "cache_control is not permitted"));
  assert.equal(l1.r.ccFail, undefined, "L1 sends no marker");
  const idle = await kind("3b", () => http(400, "tools.7.input_schema: unsupported keyword anyOf"));
  assert.equal(idle.r.ccFail, undefined);
});

test("3b (the 157 KB request): accepted and answered passes L3 and ALSO answers L4 (two parallel calls with streamed arguments); the size sent is reported; a refusal at that size fails", async () => {
  const good = await kind("3b", goodModel);
  assert.deepEqual([good.r.v, good.r.l4], ["p", "p"]);
  assert.ok(good.r.bytes > 150000 && good.r.bytes < 165000, `bytes sent: ${good.r.bytes}`);
  const one = await kind("3b", () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}'), ev.stop("tool_use"))));
  assert.deepEqual([one.r.v, one.r.l4, one.r.l4why], ["p", "f", "1 tool call instead of 2 parallel calls"], "L3 holds, L4 fails: no strike, no class change");
  const same = await kind("3b", () => ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "same"), ev.tool(1, "fx_echo", '{"message":"b"}', "same"), ev.stop("tool_use"))));
  assert.equal(same.r.l4, "f");
  const whole = (i, id, input) => `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name: "fx_echo", input } })}\n\nevent: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: i })}\n\n`;
  const notStreamed = await kind("3b", () => ok(stream(whole(0, "a", { message: "a" }), whole(1, "b", { message: "b" }), ev.stop("tool_use"))));
  assert.deepEqual([notStreamed.r.l4, notStreamed.r.l4why], ["f", "the tool call arguments were not streamed (no argument deltas)"]);
  const asText = await kind("3b", () => ok(stream(ev.text(0, "ok"), ev.stop())));
  assert.deepEqual([asText.r.v, asText.r.l4], ["p", "f"], "an answer in text is accepted (L3) but is not parallel calls");
  const tooBig = await kind("3b", () => http(413, "request entity too large"));
  assert.deepEqual([tooBig.r.v, tooBig.r.kind, tooBig.r.http], ["f", "size", 413]);
  assert.deepEqual([(await kind("3b", () => ok(stream(ev.stop())))).r.why], ["empty answer to the large request"]);
  assert.equal((await kind("3b", () => ok(stream(ev.tool(0, "fx_echo", '{"message":'), ev.stop("tool_use"))))).r.v, "f");
});

test("the big step (5): accepted and answered passes; any 400 there is about SIZE (after 157 KB was accepted); a rate or tokens-per-minute limit is never a verdict", async () => {
  assert.equal((await kind("5", goodModel)).r.v, "p");
  const big = await kind("5", () => http(400, "request too large"));
  assert.deepEqual([big.r.v, big.r.kind], ["f", "size"]);
  for (const [status, msg] of [[413, "Request too large for model on tokens per minute (TPM): Limit 6000, Requested 40000"], [400, "Rate limit reached: 30 requests per minute"], [422, "quota exceeded, try again in 20s"]]) {
    const { r } = await kind("5", () => http(status, msg));
    assert.deepEqual([r.v, r.s], ["i", "rate"], `${status}: ${msg}`);
  }
});

test("spawn (6): a valid Agent call with a prompt and a recognised subagent_type passes; text, another tool, bad JSON, a short prompt, an unknown type and a missing description fail", async () => {
  assert.equal((await kind("6", goodModel)).r.v, "p");
  const call = (o) => ok(stream(ev.tool(0, "Agent", JSON.stringify({ description: "Investigate", prompt: "Investigate the module thoroughly", subagent_type: "Explore", ...o })), ev.stop("tool_use")));
  assert.deepEqual([(await kind("6", () => ok(stream(ev.text(0, "I will look."), ev.stop())))).r.why], ["answered in text instead of delegating"]);
  assert.equal((await kind("6", () => ok(stream(ev.tool(0, "fx_edit", "{}"), ev.stop("tool_use"))))).r.why, "tool call names a tool that was not offered");
  assert.equal((await kind("6", () => ok(stream(ev.tool(0, "Agent", '{"prompt":'), ev.stop("tool_use"))))).r.why, "tool call arguments are not valid JSON");
  assert.equal((await kind("6", () => call({ prompt: "hi" }))).r.why, "the Agent call has no usable prompt");
  assert.equal((await kind("6", () => call({ prompt: "" }))).r.v, "f");
  assert.equal((await kind("6", () => call({ subagent_type: "wizard" }))).r.why, "the Agent call names a subagent_type that was not offered");
  assert.equal((await kind("6", () => call({ description: undefined }))).r.why, "the Agent call lacks a description");
  assert.equal((await kind("6", () => call({ subagent_type: "code-reviewer" }))).r.v, "p", "any of the offered types");
});

test("a THINKING block is not content: thinking, then a stop on max_tokens with no text or tool call, is inconclusive; thinking then a call is judged on the call", async () => {
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  const think = (i, t) => sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } }) + sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: t } }) + sse("content_block_stop", { type: "content_block_stop", index: i });
  assert.deepEqual([(await kind("1", () => ok(stream(think(0, "hmm"), ev.stop("max_tokens"))))).r.s], ["empty"]);
  assert.equal((await kind("1", () => ok(stream(think(0, "hmm"), ev.tool(1, "fx_echo", '{"message":"hello"}'), ev.stop("tool_use"))))).r.v, "p");
  assert.equal((await kind("1", () => ok(stream(think(0, "hmm"), ev.stop("end_turn"))))).r.v, "f", "thinking and a normal stop with no call is a real miss");
});

test("judge is pure over a parsed stream: a no-body response is inconclusive", () => {
  assert.equal(judge("1", { noBody: true, blocks: [] }).v, "i");
});

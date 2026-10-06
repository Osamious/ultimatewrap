// L1 is a SIMPLE call; argument fidelity (awkward content) is its own request after L1 passed and never a strike; a refused AUTO tool choice goes to the forced fallback; the strikes the old
// awkward-content L1 produced are cleared by a dry-by-default migration. Offline: fixtures only, a fake gateway, temp directories.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { pinL12, freshDir, fakeFetch, goodModel, http, ok, ev, stream, kindOf, record } from "./fixtures/tool-fidelity-helpers.mjs";
import { probeModel, runKind } from "../refresh/tool-fidelity-probe.mjs";
import { main, parseArgs } from "../refresh/tool-fidelity-cli.mjs";
import { buildRecord, migrateStrikes, oldL1Reason, saveFidelity, loadFidelity, cleanFidelity, FILE_NAME, REAL_FILE } from "../refresh/tool-fidelity.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);
guardRealState(after, assert);
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const FREE = { tier: "free" };
const conn = (f, extra = {}) => ({ fetchImpl: f, url: "http://gw.test/v1/messages", key: "k", model: "p/m", ...extra });
const kinds = (f) => f.calls.map(kindOf);
const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const NVIDIA = '{"error":{"message":"nvidia: \\"auto\\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set"}}';

/** A model that CAN call tools but cannot emit awkward content: invalid JSON for the Edit-style request, a good answer to everything else. */
const awkwardBreaker = (c) => (kindOf(c) === "1a" || kindOf(c) === "1af" ? ok(stream(ev.tool(0, "fx_edit", '{"file_path":"C:\\\\Users\\\\demo\\\\notes\\\\todo.md","old_string":"line one\n\tinde'), ev.stop("tool_use"))) : goodModel(c));

test("a model that can call tools but returns invalid JSON ONLY for awkward content reaches class t with `af` f and a reason: no strike, never x", async () => {
  const f = fakeFetch(awkwardBreaker);
  const done = {};
  const r = await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
  assert.equal(r.inconclusive, undefined);
  assert.deepEqual(kinds(f), ["1", "1a", "2"]);
  assert.deepEqual([done[1].v, done[1].af, done[1].afw, done[2].v], ["p", "f", "arguments not valid JSON", "p"]);
  const rec = buildRecord(null, done, { now: NOW });
  assert.deepEqual([rec.lvr, rec.t, rec.ok, rec.af, rec.afw, rec.strikes], ["ppnn", "t", true, "f", "arguments not valid JSON", undefined]);
});

test("end to end: the same model in a live run is recorded t with af f, with no strike at any level, and the second run asks nothing more", async () => {
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("brk"), m("fine")] }], { answer: (c) => (c.body.model === "fa/brk" ? awkwardBreaker(c) : goodModel(c)) });
  const r = await run(["--live"], e.deps);
  assert.equal(r.code, 0, r.err + r.out);
  const st = loadFidelity(e.out).models;
  assert.deepEqual([st["fa/brk"].lvr, st["fa/brk"].t, st["fa/brk"].af, st["fa/brk"].strikes], ["ppnn", "t", "f", undefined]);
  assert.deepEqual([st["fa/fine"].lvr, st["fa/fine"].af, st["fa/fine"].afw], ["ppnn", "p", undefined]);
  assert.match(r.out, /first strikes? 0|failed once, asked again next run 0/);
});

test("a SIMPLE call with invalid JSON is a real L1 failure (the model cannot form a call): a first strike, the second confirms it", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "1" ? ok(stream(ev.tool(0, "fx_echo", '{"message":"hel'), ev.stop("tool_use"))) : goodModel(c)));
  const done = {};
  await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
  assert.deepEqual([done[1].v, done[1].why], ["f", "tool call arguments are not valid JSON"]);
  assert.ok(!kinds(f).includes("1a"), "no argument-fidelity request for a model that failed L1");
  const first = buildRecord(null, done, { now: NOW });
  assert.deepEqual([first.strikes, first.t], [1, "u"]);
  assert.deepEqual(buildRecord(first, done, { now: NOW }).t, "x", "the second confirms");
});

test("a tool call CUT OFF by the output budget is no verdict about the model: the budget is asked once more, larger, and the model is judged on the whole call", async () => {
  const f = fakeFetch((c) => (c.body.max_tokens < 2048 ? ok(stream(ev.tool(0, c.body.tools[0].name, '{"message":"hel'), ev.stop("max_tokens"))) : goodModel(c)));
  const done = {}, state = {};
  const r = await probeModel({ levels: [1], done, state, ...FREE, ...conn(f) });
  assert.equal(r.inconclusive, undefined);
  assert.deepEqual([done[1].v, done[1].af], ["p", "p"]);
  assert.equal(state.escalated, true);
  const never = await runKind("1", conn(fakeFetch(() => ok(stream(ev.tool(0, "fx_echo", '{"message":"hel'), ev.stop("max_tokens"))))));
  assert.deepEqual([never.v, never.s], ["i", "empty"], "truncated JSON at the budget is inconclusive, not a failed call");
  const real = await runKind("1", conn(fakeFetch(() => ok(stream(ev.tool(0, "fx_echo", '{"message":"hel'), ev.stop("tool_use"))))));
  assert.equal(real.v, "f", "the same JSON on a NORMAL stop is the model's own breakage");
});

test("a server that refuses the AUTO tool choice is routed to the forced fallback: forced passes -> L1 p with fc p (class t), never a strike; the argument-fidelity request does the same", async () => {
  for (const msg of [NVIDIA, "tool_choice 'auto' is not supported by this endpoint", "\"auto\" tool choice requires --enable-auto-tool-choice"]) {
    const f = fakeFetch((c) => (c.body.tool_choice?.type === "auto" ? { status: 400, body: msg.startsWith("{") ? msg : JSON.stringify({ error: { message: msg } }), headers: {} } : goodModel(c)));
    const done = {};
    await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
    assert.deepEqual(kinds(f), ["1", "1f", "1a", "1af", "2"], msg);
    assert.deepEqual([done[1].v, done[1].fc, done[1].af, done[2].v], ["p", "p", "p", "p"], msg);
    const rec = buildRecord(null, done, { now: NOW });
    assert.deepEqual([rec.t, rec.fc, rec.strikes], ["t", "p", undefined], msg);
  }
  const both = fakeFetch(() => http(400, JSON.parse(NVIDIA).error.message));
  const d2 = {};
  await probeModel({ levels: [1, 2], done: d2, ...FREE, ...conn(both) });
  assert.deepEqual(kinds(both).slice(0, 2), ["1", "1f"], "forced was tried before anything is recorded");
  assert.ok(!kinds(both).includes("1a"));
  assert.equal(d2[1].v, "f", "refused both ways: the endpoint takes no tool choice at all: a real failure");
});

test("a text answer or no call under AUTO is a strike only AFTER the forced fallback was tried; a model that calls when forced is t with fc p, never a strike", async () => {
  for (const reply of [() => ev.text(0, "I would echo hello."), () => ""]) {
    const seen = [];
    const f = fakeFetch((c) => { seen.push(kindOf(c)); return kindOf(c) === "1f" ? goodModel({ ...c, body: { ...c.body, tool_choice: undefined } }) : kindOf(c) === "1" ? ok(stream(reply(), ev.stop("end_turn"))) : goodModel(c); });
    const done = {};
    await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
    assert.deepEqual(seen.slice(0, 2), ["1", "1f"], "forced right after the auto miss");
    assert.deepEqual([done[1].v, done[1].fc], ["p", "p"]);
    assert.equal(buildRecord(null, done, { now: NOW }).strikes, undefined);
  }
  const stubborn = fakeFetch((c) => (["1", "1f"].includes(kindOf(c)) ? ok(stream(ev.text(0, "no"), ev.stop("end_turn"))) : goodModel(c)));
  const d = {};
  await probeModel({ levels: [1, 2], done: d, ...FREE, ...conn(stubborn) });
  assert.deepEqual(kinds(stubborn).slice(0, 2), ["1", "1f"], "both tried, then the failure is recorded");
  assert.deepEqual([d[1].v, d[1].fc], ["f", "f"]);
  assert.equal(buildRecord(null, d, { now: NOW }).strikes, 1);
});

// ---------------------------------------------------------------- the migration

const strikeRec = (why, over = {}) => record("nnnn", { strikes: 1, sl: 1, why, ...over });

test("oldL1Reason names what the old L1 got wrong: awkward JSON (and the old required file_path), a refused auto choice, an empty wallet, a route shape; nothing else", () => {
  assert.equal(oldL1Reason("L1: tool call arguments are not valid JSON"), "awkward-json");
  assert.equal(oldL1Reason("L1: a tool call lacks the required argument `file_path`"), "awkward-json");
  assert.equal(oldL1Reason(`L1: HTTP 400: ${NVIDIA}`), "auto-choice");
  assert.equal(oldL1Reason('L1: HTTP 400: {"error":{"message":"teamo: Your TeamoRouter wallet balance is insufficient. Recharge at [url] to continue."}}'), "wallet");
  assert.equal(oldL1Reason('L1: HTTP 400: {"error":{"message":"commandcode: Model \\"x\\" must be called via /provider/v1/messages (Anthropic Messages shape)"}}'), "route-shape");
  for (const keep of ["L1: answered in text instead of calling the tool", "L1: no tool call in the answer", 'L1: HTTP 400: {"error":{"message":"nscale: The following parameters are not supported for this model: tools, tool_choice"}}',
    "L2: tool call arguments are not valid JSON", "L3: tool call arguments are not valid JSON", "", undefined, 5]) assert.equal(oldL1Reason(keep), null, String(keep));
});

test("migrateStrikes (pure): clears first strikes and confirmed failures that came from the old L1, removes what is otherwise unknown, keeps other results, touches nothing else and is idempotent", () => {
  const store = {
    "a/awk": strikeRec("L1: tool call arguments are not valid JSON"),
    "a/auto": strikeRec(`L1: HTTP 400: ${NVIDIA}`),
    "a/wallet": strikeRec('L1: HTTP 400: {"error":{"message":"Your wallet balance is insufficient. Recharge at [url]"}}'),
    "a/confirmed": record("fnnn", { strikes: 2, sl: 1, why: "L1: tool call arguments are not valid JSON" }),
    "a/legacy": record("fnnn", { why: "L1: tool call arguments are not valid JSON" }),
    "a/kept": record("ppnn", { strikes: 1, sl: 1, why: "L1: tool call arguments are not valid JSON", fc: "p" }),
    "a/text": strikeRec("L1: answered in text instead of calling the tool"),
    "a/nocall": record("fnnn", { strikes: 2, sl: 1, why: "L1: no tool call in the answer" }),
    "a/nscale": strikeRec('L1: HTTP 400: {"error":{"message":"nscale: The following parameters are not supported for this model: tools, tool_choice"}}'),
    "a/l2": record("pfnn", { strikes: 1, sl: 2, why: "L2: tool call arguments are not valid JSON" }),
    "a/good": record("pppn"),
  };
  const before = JSON.stringify(store);
  const m = migrateStrikes(store);
  assert.equal(JSON.stringify(store), before, "pure: the input is not changed");
  assert.deepEqual(m.cleared.map((c) => [c.key, c.kind, c.reason, c.removed]), [
    ["a/awk", "strike", "awkward-json", true], ["a/auto", "strike", "auto-choice", true], ["a/wallet", "strike", "wallet", true], ["a/confirmed", "failed", "awkward-json", true], ["a/legacy", "failed", "awkward-json", true], ["a/kept", "strike", "awkward-json", false]]);
  assert.deepEqual(Object.keys(m.store).sort(), ["a/good", "a/kept", "a/l2", "a/nocall", "a/nscale", "a/text"]);
  const kept = m.store["a/kept"];
  assert.deepEqual([kept.strikes, kept.sl, kept.why, kept.lvr, kept.t, kept.fc], [undefined, undefined, undefined, "ppnn", "t", "p"], "the rest of what is known about it stays; its class is worked out again");
  assert.ok(cleanFidelity(kept));
  for (const k of ["a/text", "a/nocall", "a/nscale", "a/l2", "a/good"]) assert.equal(m.store[k], store[k], `${k} is untouched`);
  assert.deepEqual(migrateStrikes(m.store).cleared, [], "idempotent");
  assert.deepEqual(migrateStrikes(null).cleared, []);
});

test("--reset-awkward-json is dry by default: it counts, by kind, reason and provider, and writes nothing; --live applies it under the lock, atomically, and the next run asks L1 again with the plain call", async () => {
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("awk"), m("auto"), m("text"), m("good")] }]);
  saveFidelity(e.out, { "fa/awk": strikeRec("L1: tool call arguments are not valid JSON"), "fa/auto": strikeRec(`L1: HTTP 400: ${NVIDIA}`), "fa/text": strikeRec("L1: answered in text instead of calling the tool"), "fa/good": record("ppnn") }, { now: NOW });
  const before = fs.readFileSync(e.out, "utf8");
  const dry = await run(["--reset-awkward-json"], e.deps);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /2 of 4 record\(s\) came from the awkward-content L1 or a refused auto tool choice: first strikes 2; reason: auto-choice 1, awkward-json 1; 2 would be removed \(asked again from scratch\), 0 keep their other results/);
  assert.match(dry.out, /by provider: fa 2/);
  assert.match(dry.out, /nothing was written/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before, "byte for byte");
  assert.equal(calls(e.f).length, 0);
  const live = await run(["--reset-awkward-json", "--live"], e.deps);
  assert.equal(live.code, 0, live.err + live.out);
  assert.match(live.out, /2 record\(s\) cleared in tool-fidelity\.json; the next run asks L1 again with the plain echo call/);
  assert.deepEqual(Object.keys(loadFidelity(e.out).models).sort(), ["fa/good", "fa/text"]);
  assert.equal(loadFidelity(e.out).models["fa/text"].strikes, 1, "the legitimate strike keeps its place");
  assert.ok(!fs.existsSync(e.deps.lockFile), "the lock is released");
  const again = await run(["--reset-awkward-json", "--live"], e.deps);
  assert.match(again.out, /0 of 2 record\(s\)/);
  assert.match(again.out, /nothing to clear/);
  const next = await run(["--live"], e.deps);
  assert.equal(next.code, 0, next.err + next.out);
  assert.ok(calls(e.f).some((c) => c.body.model === "fa/awk" && kindOf(c) === "1"), "the cleared model is asked L1 again, with the plain call");
  assert.equal(loadFidelity(e.out).models["fa/text"].t, "t", "the legitimate first strike was asked again by the ordinary strike rule (and passed here)");
});

test("--reset-awkward-json: a save that fails changes nothing and says so; a corrupt file is refused; the flag parses and needs no other option", async () => {
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("awk")] }]);
  saveFidelity(e.out, { "fa/awk": strikeRec("L1: tool call arguments are not valid JSON") }, { now: NOW });
  const before = fs.readFileSync(e.out, "utf8");
  e.deps.saveImpl = () => { throw new Error("disk full"); };
  const bad = await run(["--reset-awkward-json", "--live"], e.deps);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /could not save \(disk full\); nothing was changed/);
  assert.equal(fs.readFileSync(e.out, "utf8"), before);
  fs.writeFileSync(e.out, "{broken");
  assert.equal((await run(["--reset-awkward-json"], cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("x")] }], { out: e.out }).deps)).code, 1);
  assert.equal(parseArgs(["--reset-awkward-json"]).resetAwkwardJson, true);
});

// ---------------------------------------------------------------- the CLI helpers

const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 256000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
function cliEnv(rows, { answer, out } = {}) {
  const dir = freshDir();
  const known = new Set(rows.flatMap((r) => r.models.map((x) => `${r.provider}/${x.id}`)));
  const f = fakeFetch(answer ?? goodModel);
  const deps = { snapshot: { ok: true, snap: { rows } }, bench: { get: (k) => (known.has(k) ? { s: "ok", t: 400, a: 1790699779 } : null) }, tiers: Object.fromEntries(rows.map((r) => [r.provider, "free"])),
    outFile: out ?? path.join(dir, FILE_NAME), lockFile: path.join(dir, "bench.lock"), gateway: { base: "http://gw.test", key: "k" }, fetch: f, now: () => NOW,
    isAlive: () => false, findRunning: () => [], sweep: { backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1 }, retryDelayMs: 1 };
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
void sse;

test("an argument-fidelity request that gets NO verdict (a rate limit, a timeout) leaves `af` unset: L1 and L2 keep their verdicts and the model is not marked as mangling anything", async () => {
  const f = fakeFetch((c) => (kindOf(c) === "1a" ? http(429, "slow down") : goodModel(c)));
  const done = {};
  const r = await probeModel({ levels: [1, 2], done, ...FREE, ...conn(f) });
  assert.equal(r.inconclusive, undefined);
  assert.deepEqual([done[1].v, done[1].af, done[1].afw, done[2].v], ["p", undefined, undefined, "p"]);
});

test("the reset also drops the pending entries of the models it cleared", async () => {
  const e = cliEnv([{ provider: "fa", keyId: "k.fa.free", models: [m("awk"), m("good")] }]);
  saveFidelity(e.out, { "fa/awk": strikeRec("L1: tool call arguments are not valid JSON"), "fa/good": record("ppnn") }, { now: NOW, pending: { "fa/awk": { r: "error", n: 2, at: NOW.toISOString() }, "fa/other": { r: "rate", n: 1, at: NOW.toISOString() } } });
  await run(["--reset-awkward-json", "--live"], e.deps);
  assert.deepEqual(Object.keys(loadFidelity(e.out).pending), ["fa/other"]);
});

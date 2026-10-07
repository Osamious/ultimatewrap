// After a --live run that wrote records, the sweep rebuilds the picker snapshot as an ASYNC child process.
// Nothing here starts a real build: the child is a fake (an EventEmitter), or the `deps.rebuildSnapshot` seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import { rebuildAfterRun, buildSnapshotChild, parseArgs, modelsSig } from "../refresh/bench-cli.mjs";
import { BENCH_SCHEMA } from "../menu/bench-data.mjs";
import { redactClip } from "../menu/redact.mjs";

const cap = async (fn) => {
  const err = [], log = [], e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { ret: await fn(), err, log }; } finally { console.error = e; console.log = l; }
};
// Fake secret-shaped strings are BUILT AT RUN TIME, so the source holds no contiguous token-looking literal
// (GitHub push protection rejects those, even in a test). `fake(kind)` must still match the redaction rules:
// the sanity test below asserts `redactClip` masks every kind used in this file.
const body = (unit, n) => unit.repeat(n);
const fake = (kind) => ({
  sk: () => "sk" + "-" + body("a1B2c3", 7),
  hf: () => "hf" + "_" + body("aB3dE", 7),
  bearer: () => "Bearer " + body("a1B2c3", 6),
  keyed: () => "api_key" + "=" + body("Zz9Yy8", 5),
})[kind]();
const KEY = fake("sk"), HF = fake("hf"), BEARER = fake("bearer"), KEYED = fake("keyed");
const FRAGMENT = "7f3a9c*****e21d";           // a masked form, not a token
const SECRET_SHAPES = [KEY, HF, BEARER, KEYED.split("=")[1], FRAGMENT, "7f3a9c", "e21d"];
const leaks = (text) => SECRET_SHAPES.some((k) => text.includes(k) || text.includes(k.slice(0, 16)));

test("the fake secrets are runtime-built and really are the shapes the redaction rules mask", () => {
  for (const [name, s] of [["sk", KEY], ["hf", HF], ["bearer", BEARER], ["api_key=", KEYED]]) {
    const masked = redactClip(`prefix ${s} suffix`, 200);
    assert.equal(masked.includes(s.split(/[ =]/).pop().slice(0, 12)), false, `${name}: redactClip masks it`);
  }
});
const CMD = "node menu/snapshot.mjs --build";

// The real output of `menu/snapshot.mjs --build` (see its `log(...)` calls): a path line, a bench line, the
// providers line, the discovery and relay lines, then exactly one routability line.
const OUT = (rout = "  routability: 380 targets routable as of 2026-09-30T10:01:00.000Z") =>
  ["snapshot: C:\\Users\\x\\.uw\\state\\snapshot.json", "  bench: 5900 records as of 2026-09-30T10:00:00.000Z",
   "  41 providers, 5900 models, catalogue 2026-09-29T00:00:00.000Z", "  discovery: 12 providers discovered", "  relay: catalogue fetched", rout, ""].join("\n");
const DEGRADED_OUT = OUT("  routability: the gateway did not answer within 5000ms, so it is unknown for all 5900 rows and the header stamp will show a dash");

/** A fake child: `script(child)` runs on the next tick and drives its events. */
const fakeSpawn = (script, seen = {}) => (cmd, args, opts) => {
  Object.assign(seen, { cmd, args, opts });
  const c = new EventEmitter();
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.killed = false;
  c.kill = () => { c.killed = true; return true; };
  seen.child = c;
  setImmediate(() => script?.(c));
  return c;
};
const exits = (status, { stdout = "", stderr = "" } = {}) => (c) => { if (stdout) c.stdout.emit("data", stdout); if (stderr) c.stderr.emit("data", stderr); c.emit("close", status, null); };

// ------------------------------------------------------------ rebuildAfterRun

test("nothing written: the rebuild is not called and nothing is printed", async () => {
  let calls = 0;
  for (const recorded of [0, undefined, null]) {
    const out = await cap(() => rebuildAfterRun(recorded, { rebuildSnapshot: () => { calls += 1; return { ok: true, line: "x" }; } }));
    assert.equal(out.ret, null); assert.deepEqual([out.log, out.err], [[], []]);
  }
  assert.equal(calls, 0);
});

test("written something: the rebuild is called once (with the abort signal) and one success line is printed", async () => {
  let calls = 0, got;
  const ac = new AbortController();
  const out = await cap(() => rebuildAfterRun(12, { rebuildSnapshot: (a) => { calls += 1; got = a; return { ok: true, line: "41 providers, 5900 models; routability: 380 targets routable" }; } }, { signal: ac.signal }));
  assert.equal(calls, 1); assert.equal(out.ret, "rebuilt"); assert.equal(got.signal, ac.signal);
  assert.deepEqual(out.log, ["bench: snapshot rebuilt (41 providers, 5900 models; routability: 380 targets routable)"]);
  assert.deepEqual(out.err, []);
});

test("a failing, throwing, rejecting or empty rebuild prints exactly one warning and never throws", async () => {
  const seams = [() => ({ ok: false, reason: "exit 1: boom" }), () => { throw new Error("spawn exploded"); }, async () => { throw new Error("rejected"); }, () => undefined];
  for (const rebuildSnapshot of seams) {
    const out = await cap(() => rebuildAfterRun(3, { rebuildSnapshot }));
    assert.equal(out.ret, "failed"); assert.deepEqual(out.log, [], "no success line");
    assert.equal(out.err.length, 1);
    assert.match(out.err[0], /^bench: warning: snapshot not rebuilt \(.+\); run: node menu\/snapshot\.mjs --build$/);
  }
});

test("key-shaped text (including the masked-fragment form 7f3a9c*****e21d) is masked in the success line and in a failure reason", async () => {
  const okOut = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: true, line: `built with ${KEY} and ${BEARER} and ${FRAGMENT} done` }) }));
  const badOut = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: false, reason: `exit 1: ${KEYED} rejected, ${KEY}, ${HF}, ${FRAGMENT}` }) }));
  for (const text of [...okOut.log, ...okOut.err, ...badOut.log, ...badOut.err]) assert.equal(leaks(text), false, text);
  assert.match(okOut.log[0], /^bench: snapshot rebuilt \(/);
});

test("the printed line is at most 120 characters of the seam's line", async () => {
  const out = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: true, line: "z".repeat(500) }) }));
  assert.ok(out.log[0].length <= "bench: snapshot rebuilt ()".length + 120);
});

test("M1: a gateway that does not answer /health (or a health check that throws) skips the rebuild, with one info line", async () => {
  for (const healthy of [async () => false, async () => { throw new Error("boom"); }]) {
    let calls = 0;
    const out = await cap(() => rebuildAfterRun(5, { rebuildSnapshot: () => { calls += 1; return { ok: true, line: "x" }; } }, { healthy }));
    assert.equal(calls, 0); assert.equal(out.ret, "skipped");
    assert.deepEqual(out.log, [`bench: snapshot not rebuilt (gateway not answering); run: ${CMD} when it is back`]);
    assert.deepEqual(out.err, []);
  }
  let calls = 0;
  const up = await cap(() => rebuildAfterRun(5, { rebuildSnapshot: () => { calls += 1; return { ok: true, line: "x" }; } }, { healthy: async () => true }));
  assert.equal(calls, 1); assert.equal(up.ret, "rebuilt");
});

test("M1: a build whose output says routability was unknown is a WARNING, never a success line", async () => {
  const expected = `bench: warning: snapshot rebuilt WITHOUT routability (gateway did not answer); rebuild when it is back: ${CMD}`;
  const viaChild = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout: DEGRADED_OUT })) }) }));
  assert.deepEqual(viaChild.err, [expected]); assert.deepEqual(viaChild.log, []); assert.equal(viaChild.ret, "degraded");
  const viaFlag = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: true, line: "41 providers", degraded: true }) }));
  assert.deepEqual(viaFlag.err, [expected]); assert.deepEqual(viaFlag.log, []);
  const viaLine = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: true, line: "routability: the gateway did not answer within 5000ms" }) }));
  assert.deepEqual(viaLine.err, [expected]);
  const fine = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout: OUT() })) }) }));
  assert.deepEqual(fine.err, []); assert.equal(fine.log.length, 1);
});

test("L4: a closed stdout/stderr (a console that throws) cannot turn a good sweep into a failure", async () => {
  const l = console.log, e = console.error;
  console.log = () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); };
  console.error = () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); };
  try {
    assert.equal(await rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: true, line: "x" }) }), "rebuilt");
    assert.equal(await rebuildAfterRun(1, { rebuildSnapshot: () => ({ ok: false, reason: "x" }) }), "failed");
    assert.equal(await rebuildAfterRun(1, {}, { healthy: async () => false }), "skipped");
  } finally { console.log = l; console.error = e; }
});

// ------------------------------------------------------------ the default child (async)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the default child is `node menu/snapshot.mjs --build` in the repo root, hidden window, piped output, async", async () => {
  const seen = {};
  const p = buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout: OUT() }), seen) });
  assert.ok(p instanceof Promise, "returns a promise: the event loop is not blocked");
  await p;
  assert.equal(seen.cmd, process.execPath);
  assert.equal(path.resolve(seen.args[0]), path.join(ROOT, "menu", "snapshot.mjs"));
  assert.equal(seen.args[1], "--build"); assert.equal(seen.args.length, 2);
  assert.equal(path.resolve(seen.opts.cwd), ROOT);
  assert.equal(seen.opts.windowsHide, true);
  assert.deepEqual(seen.opts.stdio, ["ignore", "pipe", "pipe"]);
});

test("L2: the success line is the providers line plus the routability line of the real output, not just the last line", async () => {
  const r = await buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout: OUT() })) });
  assert.deepEqual(r, { ok: true, line: "41 providers, 5900 models, catalogue 2026-09-29T00:00:00.000Z; routability: 380 targets routable as of 2026-09-30T10:01:00.000Z", degraded: false });
  const odd = await buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout: "something\nunexpected\n" })) });
  assert.equal(odd.line, "unexpected", "an unrecognised format falls back to the last line");
  const empty = await buildSnapshotChild({ spawn: fakeSpawn(exits(0)) });
  assert.deepEqual(empty, { ok: true, line: "", degraded: false });
});

test("only the summary lines are printed: a key in the path line, the bench line or stderr never reaches the console", async () => {
  const stdout = OUT().replace("snapshot: C:", `snapshot: ${KEY} C:`).replace("  bench:", `  bench: ${FRAGMENT}`);
  const out = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => buildSnapshotChild({ spawn: fakeSpawn(exits(0, { stdout, stderr: `warn ${KEY}` })) }) }));
  assert.equal(out.log.length, 1); assert.deepEqual(out.err, []);
  assert.equal(leaks(out.log[0]), false, out.log[0]);
  assert.match(out.log[0], /41 providers, 5900 models/);
});

test("output is captured tail-only under a bound: a flood before the summary does not lose the summary", async () => {
  const flood = (c) => { for (let i = 0; i < 40; i++) c.stdout.emit("data", "x".repeat(50000) + "\n"); c.stdout.emit("data", OUT()); c.emit("close", 0, null); };
  const r = await buildSnapshotChild({ spawn: fakeSpawn(flood) });
  assert.equal(r.ok, true); assert.match(r.line, /41 providers, 5900 models/);
});

test("L1: a failed child is a reason, never a throw: stderr-only failure, Node's version footer skipped, the Error: line preferred", async () => {
  const stack = "file:///x/menu/snapshot.mjs:9\n  throw e;\n  ^\n\nTypeError: rpc is not a function\n    at main (file:///x/menu/snapshot.mjs:1:1)\n\nNode.js v25.0.0\n";
  const a = await buildSnapshotChild({ spawn: fakeSpawn(exits(1, { stderr: stack })) });
  assert.deepEqual(a, { ok: false, reason: "exit 1: TypeError: rpc is not a function" });
  const b = await buildSnapshotChild({ spawn: fakeSpawn(exits(2, { stderr: `first\nfailed with ${KEY}\nNode.js v25.0.0\n` })) });
  assert.match(b.reason, /^exit 2: failed with /, "no Error: line: the last line that is not the Node footer");
  const c = await buildSnapshotChild({ spawn: fakeSpawn(exits(3, { stderr: "Node.js v25.0.0\n" })) });
  assert.equal(c.reason, "exit 3");
  const d = await buildSnapshotChild({ spawn: fakeSpawn((ch) => ch.emit("close", null, "SIGKILL")) });
  assert.equal(d.reason, "exit SIGKILL");
  const out = await cap(() => rebuildAfterRun(1, { rebuildSnapshot: () => b }));
  assert.equal(out.err.length, 1); assert.equal(leaks(out.err[0]), false, out.err[0]);
});

test("spawn error and a throwing spawn are reasons, not throws", async () => {
  const e = await buildSnapshotChild({ spawn: fakeSpawn((c) => c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }))) });
  assert.deepEqual(e, { ok: false, reason: "ENOENT" });
  const t = await buildSnapshotChild({ spawn: () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); } });
  assert.deepEqual(t, { ok: false, reason: "EACCES" });
});

test("M2: a hung child is killed at the timeout and reported (seconds wording for a sub-minute timeout)", async () => {
  const seen = {};
  const r = await buildSnapshotChild({ spawn: fakeSpawn(null, seen), timeoutMs: 20 });
  assert.equal(r.ok, false); assert.match(r.reason, /^timed out after \d+s$/);
  assert.equal(seen.child.killed, true, "the child was killed");
  seen.child.emit("close", 0, null);      // a late close changes nothing: the promise already settled
});

test("M2: the default timeout is 5 minutes and is worded in minutes", async () => {
  const orig = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new Error("timeout"));      // fire immediately, whatever the delay
  try {
    const seen = {};
    const r = await buildSnapshotChild({ spawn: fakeSpawn(null, seen) });
    assert.deepEqual(r, { ok: false, reason: "timed out after 5 min" });
    assert.equal(seen.child.killed, true);
  } finally { AbortSignal.timeout = orig; }
});

test("M2: Ctrl-C during the rebuild kills the child and prints one line; nothing throws and the caller's code is untouched", async () => {
  const ac = new AbortController(), seen = {};
  const out = await cap(() => rebuildAfterRun(4, { rebuildSnapshot: ({ signal }) => buildSnapshotChild({ spawn: fakeSpawn(null, seen), signal }) }, { signal: ac.signal, healthy: async () => { setImmediate(() => ac.abort()); return true; } }));
  assert.equal(out.ret, "failed");
  assert.equal(seen.child.killed, true);
  assert.deepEqual(out.log, []);
  assert.equal(out.err.length, 1);
  assert.match(out.err[0], /^bench: warning: snapshot not rebuilt \(interrupted \(Ctrl-C\)\); run: node menu\/snapshot\.mjs --build$/);
  const pre = new AbortController(); pre.abort();
  const already = await buildSnapshotChild({ spawn: fakeSpawn(null, {}), signal: pre.signal });
  assert.equal(already.reason, "interrupted (Ctrl-C)");
});

// ------------------------------------------------------------ L3: did the records change

test("L3: modelsSig ignores generatedAt but sees a changed, added or removed record", () => {
  const dir = mkTmp("uw-sig-"), f = path.join(dir, "bench.json");
  const write = (models, generatedAt) => fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt, models }));
  write({ "s/a": { s: "ok", a: 1 }, "o/b": { s: "gone", a: 1 } }, "t1");
  const base = modelsSig(f);
  write({ "s/a": { s: "ok", a: 1 }, "o/b": { s: "gone", a: 1 } }, "t2 (a compaction that kept every record)");
  assert.equal(modelsSig(f), base);
  write({ "s/a": { s: "ok", a: 2 }, "o/b": { s: "gone", a: 1 } }, "t1"); assert.notEqual(modelsSig(f), base);
  write({ "s/a": { s: "ok", a: 1 } }, "t1"); assert.notEqual(modelsSig(f), base);
  write({ "s/a": { s: "ok", a: 1 }, "o/b": { s: "gone", a: 1 }, "x/y": { s: "ok", a: 1 } }, "t1"); assert.notEqual(modelsSig(f), base);
});

// ------------------------------------------------------------ where it sits

test("--live rebuilds last: awaited, unconditionally, after history, compaction and the exit code, inside runMain (source order)", () => {
  // BRITTLE BY DESIGN, like the history order test: `main --live` needs the real gateway settings and /health and
  // there is no injection seam for them, so the placement is asserted on the source text. If this fails after a
  // refactor, move the call, not the test.
  const src = fs.readFileSync(new URL("../refresh/bench-cli.mjs", import.meta.url), "utf8");
  const calls = [...src.matchAll(/rebuildAfterRun\(/g)].map((m) => m.index);
  const def = src.indexOf("export async function rebuildAfterRun(") + "export async function ".length;
  const site = calls.filter((i) => i !== def);
  assert.equal(site.length, 1, "exactly one call site");
  const at = site[0];
  const lineStart = src.lastIndexOf("\n", at) + 1;
  assert.match(src.slice(lineStart, at), /^\s*await $/, "the call is its own awaited statement");
  assert.equal(/\bif\s*\(/.test(src.slice(lineStart, at)), false, "and not the body of an if");
  const between = src.slice(src.indexOf("const code = sweepExit(result)"), at);
  assert.equal(/\bif \(code[^)]*\)\s*\{/.test(between), false, "not inside an `if (code ...)` block");
  assert.equal(/\bif \(code[^)]*\)\s*await/.test(between), false);
  const runMain = src.indexOf("async function runMain(");
  assert.ok(at > runMain, "inside runMain (main's try/finally releases the lock after it returns)");
  assert.ok(at > src.indexOf("if (!o.live) {", runMain), "not on the dry / read-only path");
  assert.ok(at > src.indexOf("if (o.compact) {", runMain), "not on the --compact path");
  assert.ok(at > src.lastIndexOf("saveHistory(o, deps)"), "history first");
  assert.ok(at > src.lastIndexOf("const n = compact("), "after the end-of-run compaction");
  assert.ok(at > src.indexOf("const code = sweepExit(result)"), "after the exit code is fixed");
  const ret = src.indexOf("return code;", at);
  assert.ok(ret > at && ret - at < 700, "and the run returns right after it");
  const flat = src.split(/\s+/).join(" ");
  assert.ok(flat.includes("try { return await runMain(o, lockDeps, deps); } finally { if (lock) { lock.release();"), "runMain runs inside the try whose finally releases the lock");
  const tail = src.slice(at, ret);
  assert.match(tail, /wrote \? done : 0/, "keyed on records that really changed, not on results appended");
  assert.match(tail, /result\.outage\?\.gaveUp/, "skipped when the sweep gave up on a dead gateway");
  assert.match(tail, /gatewayUp\(gw\.base\)/, "and when /health does not answer");
  assert.match(tail, /signal: rebuilding\.signal/, "abortable by Ctrl-C");
  assert.ok(src.indexOf("const before = modelsSig();") < src.indexOf("createLogWriter()", src.indexOf("const before = modelsSig();")), "the 'before' signature is taken before the first write");
});

test("Ctrl-C during the rebuild is wired: the first aborts the child, the second forces the exit (source)", () => {
  const src = fs.readFileSync(new URL("../refresh/bench-cli.mjs", import.meta.url), "utf8");
  const flat = src.split(/\s+/).join(" ");
  assert.ok(flat.includes("if (rebuilding) { if (rebuilding.signal.aborted) process.exit(130); rebuilding.abort(); return; }"));
});

test("no --no-snapshot flag: the rebuild is always on", () => {
  assert.ok(parseArgs(["--no-snapshot"]).error);
});

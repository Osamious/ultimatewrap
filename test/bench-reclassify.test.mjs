// #114: --reclassify-notices, the one-shot maintenance pass that turns `ok` records whose reply is really an error or
// account notice (a provider's refusal delivered as a 200 stream) into auth / pay / error. Temp directories only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reclassifyNotice, reclassifyNotices, readBench, isFresh } from "../refresh/bench-store.mjs";
import { parseArgs, main, EXIT_BUSY } from "../refresh/bench-cli.mjs";
import { acquireLock } from "../refresh/bench-lock.mjs";
import { loadBench, BENCH_SCHEMA } from "../menu/bench-data.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-rcn-"));
const NOTICE = "The account behind this API key doesn't ";
const NOW = Date.parse("2026-09-29T12:00:00Z");
const DAY = 864e5;
const none = () => [];
const cap = async (fn) => {
  const err = [], log = [], e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { code: await fn(), err, log }; } finally { console.error = e; console.log = l; }
};

test("reclassifyNotice: an ok whose preview is a notice becomes auth / pay / error; everything else is untouched", () => {
  const rec = { s: "ok", t: 2645, d: 2645, r: 12.5, o: 0, a: 9, p: NOTICE, k: 0, b: 1024 };
  const r = reclassifyNotice(rec);
  assert.equal(r.changed, true); assert.equal(r.kind, "auth");
  assert.deepEqual(Object.keys(r.rec).sort(), ["a", "b", "d", "m", "p", "s"], "t, r, o and k are dropped; a, d, p, b are kept");
  assert.equal(r.rec.s, "auth"); assert.equal(r.rec.d, 2645); assert.equal(r.rec.a, 9); assert.equal(r.rec.p, NOTICE);
  assert.equal(r.rec.m, `reclassified from ok (HTTP 200 notice): ${NOTICE}`);
  assert.equal(reclassifyNotice({ s: "ok", p: "Insufficient credits. Please top up." }).kind, "pay");
  assert.equal(reclassifyNotice({ s: "ok", p: "Error: upstream request failed" }).kind, "error");
  for (const untouched of [{ s: "ok", t: 5, p: "Hello, how are you today?" }, { s: "ok", t: 5, p: "Error: I should say hello", k: 1 },
                           { s: "auth", p: NOTICE }, { s: "ok" }, { s: "gone", p: "Unauthorized" }, null]) {
    const x = reclassifyNotice(untouched);
    assert.equal(x.changed, false); assert.equal(x.rec, untouched);
  }
  assert.equal(reclassifyNotice(r.rec).changed, false, "idempotent: a reclassified record is no longer ok");
});

test("reclassifyNotices rewrites bench.json AND the log, atomically; a dry run writes nothing; a second run changes nothing", () => {
  const dir = tmp(); const file = path.join(dir, "bench.json"); const log = path.join(dir, "bench.jsonl");
  const models = {
    "pollinations/a": { s: "ok", t: 2645, d: 2645, r: 3, o: 0, a: 9, p: NOTICE },
    "pollinations/b": { s: "ok", t: 3000, d: 3000, o: 0, a: 9, p: "Insufficient credits. Please top up your balance" },
    "openai/c": { s: "ok", t: 800, d: 1900, r: 40, o: 12, a: 9, p: "Hello there, friend of mine" },
    "aihubmix/d": { s: "ok", t: 300, d: 400, o: 20, a: 9, p: "Error: I should say hello", k: 1 },
    "kilo/e": { s: "pay", a: 9, m: "Add credits" },
  };
  fs.writeFileSync(file, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "G", params: { prompt: "P" }, models }));
  fs.writeFileSync(log, [JSON.stringify({ key: "pollinations/z", s: "ok", t: 5, d: 5, o: 0, a: 10, p: NOTICE }), JSON.stringify({ key: "openai/y", s: "ok", t: 5, p: "Hello!" }), '{"key":"torn'].join("\n") + "\n");
  const original = fs.readFileSync(file, "utf8"), originalLog = fs.readFileSync(log, "utf8");

  const dry = reclassifyNotices({ benchFile: file, logFile: log, dry: true });
  assert.deepEqual([dry.ok, dry.records, dry.changed, dry.logRecords, dry.logChanged], [true, 5, 2, 2, 1]);
  assert.deepEqual(dry.byStatus, { auth: 2, pay: 1 });
  assert.equal(dry.samples.length, 3);
  assert.equal(fs.readFileSync(file, "utf8"), original, "dry: bench.json untouched"); assert.equal(fs.readFileSync(log, "utf8"), originalLog, "dry: log untouched");

  const r = reclassifyNotices({ benchFile: file, logFile: log });
  assert.deepEqual([r.changed, r.logChanged], [2, 1]);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.generatedAt, "G"); assert.deepEqual(raw.params, { prompt: "P" });
  assert.equal(raw.models["pollinations/a"].s, "auth"); assert.equal(raw.models["pollinations/b"].s, "pay");
  for (const k of ["openai/c", "aihubmix/d", "kilo/e"]) assert.deepEqual(raw.models[k], models[k], `${k} is untouched`);
  const logText = fs.readFileSync(log, "utf8");
  assert.ok(logText.includes('"s":"auth"') && logText.includes('{"key":"openai/y","s":"ok","t":5,"p":"Hello!"}') && logText.includes('{"key":"torn'), "the log is rewritten line by line, the torn line as it was");
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp")).length, 0);

  const bytes = fs.readFileSync(file, "utf8"), logBytes = fs.readFileSync(log, "utf8");
  const again = reclassifyNotices({ benchFile: file, logFile: log });
  assert.deepEqual([again.changed, again.logChanged], [0, 0]);
  assert.equal(fs.readFileSync(file, "utf8"), bytes); assert.equal(fs.readFileSync(log, "utf8"), logBytes, "a second run rewrites nothing");
});

test("reclassifyNotices: an unreadable bench.json does not stop the log; nothing readable at all is a refusal", () => {
  const dir = tmp(); const file = path.join(dir, "bench.json"); const log = path.join(dir, "bench.jsonl");
  fs.writeFileSync(file, "{nope");
  fs.writeFileSync(log, JSON.stringify({ key: "p/a", s: "ok", t: 5, o: 0, p: NOTICE }) + "\n");
  const r = reclassifyNotices({ benchFile: file, logFile: log });
  assert.equal(r.ok, true); assert.equal(r.benchOk, false); assert.equal(r.logChanged, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{nope");
  assert.equal(reclassifyNotices({ benchFile: path.join(dir, "n.json"), logFile: path.join(dir, "n.jsonl") }).ok, false);
});

test("a reclassified record is a normal non-ok record for the loader and the merge rules", () => {
  const dir = tmp(); const file = path.join(dir, "bench.json");
  fs.writeFileSync(file, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "G", models: { "p/a": { s: "ok", t: 5, d: 5, o: 0, a: Math.floor(NOW / 1000), p: NOTICE } } }));
  reclassifyNotices({ benchFile: file, logFile: path.join(dir, "l") });
  const rec = loadBench(file).get("p/a");
  assert.equal(rec.s, "auth"); assert.equal(rec.t, null); assert.match(rec.m, /^reclassified from ok/);
  assert.equal(isFresh(readBench(file).get("p/a"), { ttlMs: 7 * DAY, nowMs: NOW }), true, "auth is a real result, so it stays fresh");
});

test("--reclassify-notices and --dry parse; combining or a lone --dry is an error", () => {
  const o = parseArgs(["--reclassify-notices", "--dry"]);
  assert.equal(o.reclassify, true); assert.equal(o.dry, true);
  assert.equal(parseArgs([]).reclassify, false); assert.equal(parseArgs([]).dry, false);
  for (const argv of [["--reclassify-notices", "--live"], ["--reclassify-notices", "--compact"], ["--reclassify-notices", "--redact"], ["--dry"], ["--live", "--dry"]]) {
    assert.ok(parseArgs(argv).error, JSON.stringify(argv));
  }
});

test("main --reclassify-notices: --dry previews and writes nothing, the plain run rewrites, a second run is a no-op, the lock is released", async () => {
  const dir = tmp(); const benchFile = path.join(dir, "bench.json"); const logFile = path.join(dir, "bench.jsonl"); const lockFile = path.join(dir, "bench.lock");
  fs.writeFileSync(benchFile, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: {
    "pollinations/a": { s: "ok", t: 9, d: 9, o: 0, a: 1, p: NOTICE }, "openai/b": { s: "ok", t: 9, d: 9, o: 5, a: 1, p: "Hello there, friend" } } }));
  const raw = fs.readFileSync(benchFile, "utf8");
  const deps = { benchFile, logFile, lockFile, findRunning: none };
  const dry = await cap(() => main(["--reclassify-notices", "--dry"], deps));
  assert.equal(dry.code, 0);
  assert.match(dry.log.join("\n"), /would reclassify 1 of 2 record\(s\) in bench\.json \(ok -> auth 1\)/);
  assert.match(dry.log.join("\n"), /pollinations\/a  ->  auth/); assert.match(dry.log.join("\n"), /--dry: nothing was written/);
  assert.equal(fs.readFileSync(benchFile, "utf8"), raw);
  const real = await cap(() => main(["--reclassify-notices"], deps));
  assert.equal(real.code, 0);
  assert.match(real.log.join("\n"), /reclassified 1 of 2 record\(s\) in bench\.json \(ok -> auth 1\)/);
  assert.equal(readBench(benchFile).get("pollinations/a").s, "auth"); assert.equal(readBench(benchFile).get("openai/b").s, "ok");
  assert.equal(fs.existsSync(lockFile), false);
  const again = await cap(() => main(["--reclassify-notices"], deps));
  assert.match(again.log.join("\n"), /reclassified 0 of 2 record\(s\).*nothing needed it/);
});

test("main --reclassify-notices is refused under a running sweep (exit 5) and touches nothing; a missing file exits 1", async () => {
  const dir = tmp(); const benchFile = path.join(dir, "bench.json"); const lockFile = path.join(dir, "bench.lock");
  const raw = JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: { "p/a": { s: "ok", t: 9, o: 0, a: 1, p: NOTICE } } });
  fs.writeFileSync(benchFile, raw);
  acquireLock({ file: lockFile, pid: 4001, now: () => Date.now(), findRunning: none });
  const busy = await cap(() => main(["--reclassify-notices"], { benchFile, logFile: path.join(dir, "l"), lockFile, isAlive: (p) => p === 4001, findRunning: none }));
  assert.equal(busy.code, EXIT_BUSY);
  assert.match(busy.err.join("\n"), /cannot reclassify -- another sweep is running \(pid 4001/);
  assert.equal(fs.readFileSync(benchFile, "utf8"), raw);
  const missing = await cap(() => main(["--reclassify-notices"], { benchFile: path.join(dir, "none.json"), logFile: path.join(dir, "l"), lockFile: path.join(dir, "k"), findRunning: none }));
  assert.equal(missing.code, 1);
  assert.match(missing.err.join("\n"), /cannot reclassify -- no readable bench\.json/);
});

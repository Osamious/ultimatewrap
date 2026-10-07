// #114: persistence (append log, compaction, resume) and the picker-side data module.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import {
  createLogWriter, readLog, readBench, loadExisting, isFresh, compact, toStored,
} from "../refresh/bench-store.mjs";
import {
  STATUSES, TRANSIENT, statusCode, statusTone, benchKey, benchKeyOf, cleanRecord,
  fmtMs, fmtTps, previewText, loadBench, BENCH_SCHEMA, PREVIEW_CHARS,
} from "../menu/bench-data.mjs";

const tmp = () => mkTmp("uw-bench-");
const NOW = Date.parse("2026-09-29T12:00:00Z");
const sec = (ms) => Math.floor(ms / 1000);

// ----------------------------------------------------------- vocabulary

test("every status has a code of at most 4 characters and a tone", () => {
  for (const s of STATUSES) {
    assert.ok(statusCode(s).length >= 1 && statusCode(s).length <= 4, s);
    assert.ok(["ok", "warn", "bad", "dim"].includes(statusTone(s)), s);
  }
  assert.equal(statusCode("nonsense"), "?", "an unknown status draws ?, never a guess");
});

test("transient statuses are exactly the ones that describe the moment of the run", () => {
  assert.deepEqual([...TRANSIENT].sort(), ["error", "rate", "skip", "timeout"]);
});

test("keys strip the [1m] suffix so a tagged picker row finds its measurement", () => {
  assert.equal(benchKey("kilo", "nemotron:free[1m]"), "kilo/nemotron:free");
  assert.equal(benchKeyOf("kilo/nemotron:free[1M]"), "kilo/nemotron:free");
  assert.equal(benchKey("a", "b"), "a/b");
});

// ------------------------------------------------------------ formatters

test("fmtMs is at most five characters across the whole range", () => {
  const cases = { 0: "0ms", 842: "842ms", 999: "999ms", 1000: "1.00s", 1234: "1.23s", 9999: "10.00s",
                  12345: "12.3s", 99999: "100.0s", 123456: "123s" };
  for (const ms of [0, 842, 999, 1000, 1234, 12345, 123456]) {
    assert.ok(fmtMs(ms).length <= 5, `${ms} -> ${fmtMs(ms)}`);
  }
  assert.equal(fmtMs(842), "842ms"); assert.equal(fmtMs(1234), "1.23s");
  assert.equal(fmtMs(12345), "12.3s"); assert.equal(fmtMs(123456), "123s");
  assert.equal(fmtMs(null), ""); assert.equal(fmtMs(NaN), ""); assert.equal(fmtMs(-1), "");
  void cases;
});

test("fmtTps is at most four characters, and `-` when unmeasured", () => {
  assert.equal(fmtTps(null), "-"); assert.equal(fmtTps(undefined), "-"); assert.equal(fmtTps(-3), "-");
  assert.equal(fmtTps(8.34), "8.3"); assert.equal(fmtTps(132.4), "132"); assert.equal(fmtTps(1500), "1.5k");
  for (const r of [0, 0.4, 9.9, 10, 999.9, 1000, 25000]) assert.ok(fmtTps(r).length <= 4, `${r} -> ${fmtTps(r)}`);
});

test("previewText marks thinking, explains skips, and respects the width", () => {
  assert.equal(previewText({ s: "ok", p: "Hello there", k: 0 }, 40), "Hello there");
  assert.equal(previewText({ s: "ok", p: "Let me think", k: 1 }, 40), "~Let me think");
  assert.equal(previewText({ s: "skip", w: "unfunded" }, 40), "skipped: unfunded");
  assert.equal(previewText({ s: "ok", p: "abcdefghij", k: 0 }, 4), "abcd");
  assert.equal(previewText({ s: "ok", p: "x" }, 0), "");
  assert.equal(previewText(null, 20), "");
});

// ------------------------------------------------------ record hygiene

test("cleanRecord rejects unknown statuses and non-record values", () => {
  for (const bad of [null, undefined, 5, "ok", [], {}, { s: "weird" }]) assert.equal(cleanRecord(bad), null);
});

test("cleanRecord never lets a non-number reach a numeric cell", () => {
  const c = cleanRecord({ s: "ok", t: "fast", d: -5, r: NaN, o: Infinity, a: null, p: "hi" });
  assert.deepEqual([c.t, c.d, c.r, c.o, c.a], [null, null, null, null, null]);
});

test("cleanRecord sanitizes a preview a hand-edited or older file could carry", () => {
  const c = cleanRecord({ s: "ok", p: "\x1b[2Jboom‮evil\x07" + "y".repeat(100) });
  assert.equal(/[\x00-\x1f\x7f-\x9f‮]/.test(c.p), false);
  assert.ok([...c.p].length <= PREVIEW_CHARS);
});

// ---------------------------------------------------------------- log

test("the log round-trips records, last line wins, and a torn final line is skipped", () => {
  const dir = tmp(); const file = path.join(dir, "bench.jsonl");
  const w = createLogWriter(file);
  w.append("a/x", { s: "ok", t: 100, d: 200, a: 1 });
  w.append("a/x", { s: "ok", t: 50, d: 90, a: 2 });
  w.append("b/y", { s: "rate", a: 3 });
  w.close();
  fs.appendFileSync(file, '{"key":"c/z","s":"ok","t":1');           // an interrupted write
  const m = readLog(file);
  assert.equal(m.size, 2, "the torn line lost one probe and nothing else");
  assert.equal(m.get("a/x").t, 50, "later records override earlier ones");
});

test("a missing log or bench file reads as empty, never as an error", () => {
  const dir = tmp();
  assert.equal(readLog(path.join(dir, "none")).size, 0);
  assert.equal(readBench(path.join(dir, "none")).size, 0);
});

test("stored records omit empty fields", () => {
  assert.deepEqual(toStored({ s: "ok", t: 5, d: null, r: undefined, p: "", k: 0, w: "" }), { s: "ok", t: 5 });
  assert.deepEqual(toStored({ s: "ok", k: 1, p: "x" }), { s: "ok", k: 1, p: "x" });
});

test("the writer amortises fsync but appends every record immediately", () => {
  const dir = tmp(); const file = path.join(dir, "l.jsonl");
  const w = createLogWriter(file, { fsyncEvery: 1000, fsyncMs: 1e9 });
  for (let i = 0; i < 50; i++) w.append(`p/m${i}`, { s: "ok", a: i });
  assert.equal(readLog(file).size, 50, "readable before any sync or close: a crash loses only the un-synced tail");
  w.close();
  w.close();                                                          // idempotent
});

// ------------------------------------------------------------- resume

test("resume: a recent measurement is fresh; an old one, or a transient one, is not", () => {
  const ttl = 7 * 864e5;
  assert.equal(isFresh({ s: "ok", a: sec(NOW - 864e5) }, { ttlMs: ttl, nowMs: NOW }), true);
  assert.equal(isFresh({ s: "ok", a: sec(NOW - 8 * 864e5) }, { ttlMs: ttl, nowMs: NOW }), false, "past the ttl");
  for (const s of ["rate", "timeout", "error", "skip"]) {
    assert.equal(isFresh({ s, a: sec(NOW) }, { ttlMs: ttl, nowMs: NOW }), false, `${s} is retried, not trusted`);
  }
  assert.equal(isFresh({ s: "ok" }, { ttlMs: ttl, nowMs: NOW }), false, "no timestamp: not fresh");
  assert.equal(isFresh({ s: "gone", a: sec(NOW) }, { ttlMs: ttl, nowMs: NOW }), true, "a retired model stays retired");
});

test("resume reads bench.json overlaid by the log, so an interrupted run loses nothing", () => {
  const dir = tmp(); const benchFile = path.join(dir, "bench.json"), logFile = path.join(dir, "bench.jsonl");
  fs.writeFileSync(benchFile, JSON.stringify({ schema: BENCH_SCHEMA, models: { "a/old": { s: "ok", a: 1 }, "a/x": { s: "ok", t: 9, a: 1 } } }));
  const w = createLogWriter(logFile); w.append("a/x", { s: "ok", t: 1, a: 2 }); w.append("b/new", { s: "ok", a: 2 }); w.close();
  const m = loadExisting({ benchFile, logFile });
  assert.deepEqual([...m.keys()].sort(), ["a/old", "a/x", "b/new"]);
  assert.equal(m.get("a/x").t, 1, "the log is newer than the compacted file");
});

// ------------------------------------------------------------ compaction

test("compact folds the log into bench.json, prunes vanished models, then truncates the log", () => {
  const dir = tmp(); const benchFile = path.join(dir, "bench.json"), logFile = path.join(dir, "bench.jsonl");
  fs.writeFileSync(benchFile, JSON.stringify({ schema: BENCH_SCHEMA, models: { "gone/m": { s: "ok", a: 1 }, "keep/m": { s: "ok", t: 5, a: 1 } } }));
  const w = createLogWriter(logFile); w.append("keep/m", { s: "ok", t: 7, a: 2 }); w.append("new/m", { s: "ok", a: 2 }); w.close();
  const n = compact({ benchFile, logFile, keep: new Set(["keep/m", "new/m"]), now: () => new Date(NOW) });
  assert.equal(n, 2);
  const out = JSON.parse(fs.readFileSync(benchFile, "utf8"));
  assert.equal(out.schema, BENCH_SCHEMA);
  assert.equal(out.generatedAt, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(Object.keys(out.models).sort(), ["keep/m", "new/m"]);
  assert.equal(out.models["keep/m"].t, 7);
  assert.equal(fs.readFileSync(logFile, "utf8"), "", "the log is empty once its contents are safely in bench.json");
});

test("compact drops records the reader would reject rather than persisting them", () => {
  const dir = tmp(); const benchFile = path.join(dir, "b.json"), logFile = path.join(dir, "l.jsonl");
  fs.writeFileSync(logFile, JSON.stringify({ key: "a/x", s: "banana" }) + "\n" + JSON.stringify({ key: "a/y", s: "ok", a: 1 }) + "\n");
  compact({ benchFile, logFile });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(benchFile, "utf8")).models), ["a/y"]);
});

test("a crash between writing bench.json and truncating the log replays idempotently", () => {
  const dir = tmp(); const benchFile = path.join(dir, "b.json"), logFile = path.join(dir, "l.jsonl");
  const w = createLogWriter(logFile); w.append("a/x", { s: "ok", t: 3, a: 5 }); w.close();
  compact({ benchFile, logFile });
  fs.writeFileSync(logFile, JSON.stringify({ key: "a/x", s: "ok", t: 3, a: 5 }) + "\n");   // as if truncate never ran
  compact({ benchFile, logFile });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(benchFile, "utf8")).models), ["a/x"]);
});

// ------------------------------------------------------- picker reader

test("loadBench: missing, corrupt, wrong-schema and malformed files are all empty, never a throw", () => {
  const dir = tmp();
  const put = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  for (const f of [path.join(dir, "absent"), put("corrupt", "{not json"), put("old", JSON.stringify({ schema: 0, models: {} })),
                   put("nomodels", JSON.stringify({ schema: BENCH_SCHEMA })), put("arr", JSON.stringify({ schema: BENCH_SCHEMA, models: 5 }))]) {
    const b = loadBench(f);
    assert.equal(b.size, 0); assert.equal(b.get("a/x"), null); assert.equal(b.generatedAt, null);
  }
});

test("loadBench: lookups clean the record and strip [1m] from the target", () => {
  const dir = tmp(); const f = path.join(dir, "b.json");
  fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "2026-09-29T12:00:00.000Z",
    models: { "kilo/m:free": { s: "ok", t: 800, d: 1900, r: 40, o: 40, a: 5, p: "Hi\x1b[31m" }, "a/bad": { s: "nope" } } }));
  const b = loadBench(f);
  assert.equal(b.size, 2);
  assert.equal(b.generatedAt, "2026-09-29T12:00:00.000Z");
  assert.equal(b.get("kilo/m:free[1m]").t, 800, "a tagged picker target finds the bare-id record");
  assert.equal(b.get("kilo/m:free").p, "Hi", "the escape sequence is stripped on read");
  assert.equal(b.get("a/bad"), null, "an unusable record is null");
  assert.equal(b.get("a/absent"), null);
  assert.equal(b.get("__proto__"), null, "a prototype name is not a model");
  assert.equal(b.get("constructor"), null);
});

test("loadBench on a 6,000-row file is fast enough to do on a keypress", () => {
  const dir = tmp(); const f = path.join(dir, "b.json");
  const models = {};
  for (let i = 0; i < 6000; i++) models[`prov${i % 60}/model-${i}`] = { s: "ok", t: 800 + i, d: 1900, r: 40, o: 40, a: 1, p: "Hello there, friend of mine" };
  fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models }));
  const t0 = performance.now();
  const b = loadBench(f);
  const first = b.get("prov0/model-0");
  const ms = performance.now() - t0;
  assert.equal(b.size, 6000); assert.equal(first.t, 800);
  assert.ok(ms < 150, `loading 6,000 rows took ${ms.toFixed(1)} ms`);
  assert.ok(fs.statSync(f).size < 1_000_000, `bench.json for 6,000 rows is ${fs.statSync(f).size} bytes`);
});

// ------------------------------------------------- the provider's own message (`m`)

const HOSTILE = "\x1b[2J\x1b]0;pwned\x07bad‮txt​\x00 end";
const noControl = (s) => !/[\x00-\x1f\x7f-\x9f]|[​-‏‪-‮⁦-⁩]/.test(s);

test("`m` is stored for a non-ok result, capped at 160 characters; the 120-character `p` that is its prefix is NOT stored twice", () => {
  const sentence = "The requested model 'omni-moderation-2024-09-26' does not exist. " + "x ".repeat(300);
  const s = toStored({ s: "gone", d: 40, a: 5, p: sentence.slice(0, PREVIEW_CHARS), m: sentence });
  assert.equal([...s.m].length, 160);
  assert.equal("p" in s, false, "m already starts with p: the duplicate is dropped");
  // ...and the record reads back with the same p, derived from m
  const back = cleanRecord(s);
  assert.equal([...back.p].length, PREVIEW_CHARS);
  assert.ok(back.m.startsWith(back.p));
  // a `p` that is NOT a prefix of `m` (a note, a different sentence) is kept
  const note = toStored({ s: "skip", w: "spend-cap", p: "retry not sent: spend cap reached (first try error)", a: 5 });
  assert.match(note.p, /^retry not sent/);
  const hidden = toStored({ s: "empty", o: 61, p: "budget spent on hidden reasoning", m: "budget spent on hidden reasoning (stop_reason max_tokens, 61 tokens)" });
  assert.equal(hidden.p, "budget spent on hidden reasoning", "a `p` that is only a PREFIX of a longer `m` (not its own clip) is kept: it is a different, shorter text");
  assert.equal(cleanRecord(hidden).p, "budget spent on hidden reasoning");
  assert.equal(toStored({ s: "ok", d: 1, p: "hi" }).m, undefined, "a record without a message stores none");
  assert.equal(toStored({ s: "gone", m: "" }).m, undefined);
  assert.equal(toStored({ s: "gone", m: 42 }).m, undefined, "a non-string is dropped, not stored");
  assert.equal(toStored({ s: "ok", t: 5, p: "x".repeat(300) }).p.length, PREVIEW_CHARS, "an ok preview is clipped to the stored length");
});

test("hostile text in `m` is stripped on write AND on load, and the picker never gets it in `p`", () => {
  assert.ok(noControl(toStored({ s: "error", m: HOSTILE }).m), "sanitized on write");
  const dir = tmp(); const f = path.join(dir, "bench.json");
  // A hand-edited or older file: the load-side pass is the one that cannot be skipped.
  fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x",
    models: { "a/m": { s: "error", a: 1, p: "short", m: HOSTILE + "y".repeat(400) }, "a/n": { s: "ok", a: 1, p: "hi" }, "a/o": { s: "error", a: 1, m: 7 } } }));
  const b = loadBench(f);
  const rec = b.get("a/m");
  assert.ok(noControl(rec.m), JSON.stringify(rec.m));
  assert.ok([...rec.m].length <= 160);
  assert.equal(rec.p, "short");
  assert.equal("m" in b.get("a/n"), false, "a record with no message has the shape it always had");
  assert.equal("m" in b.get("a/o"), false, "a non-string message is ignored");
  assert.equal(cleanRecord({ s: "gone", m: HOSTILE }).m.includes("\x1b"), false);
});

test("`m` survives the log, a torn last line, compaction and a reload", () => {
  const dir = tmp(); const log = path.join(dir, "b.jsonl"); const file = path.join(dir, "b.json");
  const w = createLogWriter(log);
  w.append("a/one", { s: "gone", a: 10, p: "The requested model 'x'", m: "The requested model 'x' does not exist" });
  w.append("a/two", { s: "auth", a: 11, m: "Invalid API key" });
  w.close();
  fs.appendFileSync(log, '{"key":"a/three","s":"error","a":12,"m":"torn mid-wri');   // an interrupted write
  const back = readLog(log);
  assert.equal(back.get("a/one").m, "The requested model 'x' does not exist");
  assert.equal(back.has("a/three"), false, "the torn line is dropped, the rest kept");
  assert.equal(compact({ benchFile: file, logFile: log }), 2);
  const b = loadBench(file);
  assert.equal(b.get("a/one").m, "The requested model 'x' does not exist");
  assert.equal(b.get("a/two").m, "Invalid API key");
  assert.equal(readBench(file).get("a/two").m, "Invalid API key", "the raw file carries it too");
});

test("bench.json for 6,000 records stays under 1.5 MB with 120-character previews and 160-character messages (typical), and under 2 MB in the worst case", () => {
  const real = [
    "The requested model 'omni-moderation-2024-09-26' does not exist", "The model gemma-7b-it has been decommissioned",
    "Upstream request failed: Model glm-4.6 not found", "Invalid API key provided. You can find your API key at https://example.com/keys",
    "Insufficient balance. Please top up your account to use this model", "The selected model is temporarily unavailable",
    "no complete answer within 240000 ms; first token at 1200 ms", "rate limit exceeded for model gpt-4o on requests per min",
  ];
  const answers = ["Hello there, friend of mine", "Hello, how are you today?", "Hi! Nice to meet you, friend.", "Hello there, hope you are well"];
  const thinking = "The user wants me to say hello in exactly five words. Let me think about the best five-word greeting that is friendly and clear".slice(0, PREVIEW_CHARS);
  const build = ({ msgOf, okP, okShare = 3 }) => {
    const dir = tmp(); const log = path.join(dir, "b.jsonl"); const file = path.join(dir, "b.json");
    const w = createLogWriter(log);
    for (let i = 0; i < 6000; i++) {
      const ok = i % okShare === 0;
      w.append(`prov${i % 60}/some-model-name-${i}`, ok
        ? { s: "ok", t: 800 + i, d: 1900, r: 40.5, o: 40, a: 1790000000, p: okP(i), k: 0 }
        : { s: "error", d: 900, a: 1790000000, p: msgOf(i).slice(0, PREVIEW_CHARS), m: msgOf(i) });
    }
    w.close();
    compact({ benchFile: file, logFile: log });
    return fs.statSync(file).size;
  };
  // typical: a third answer in a few words, the rest a realistic provider sentence
  const typical = build({ msgOf: (i) => real[i % real.length], okP: (i) => answers[i % answers.length] });
  // heavy: every answer is a full 120-character (thinking) preview, every non-ok message is at the 160-character cap
  const heavy = build({ msgOf: (i) => `${i} `.padEnd(160, "z"), okP: () => thinking });
  // worst: nothing but answered rows with full 120-character previews
  const worst = build({ msgOf: () => "x", okP: (i) => `${i} `.padEnd(PREVIEW_CHARS, "q"), okShare: 1 });
  console.log(`bench.json, 6,000 records: typical ${typical} B, heavy ${heavy} B, all-ok-120 ${worst} B`);
  assert.ok(typical < 1_500_000, `bench.json is ${typical} bytes with typical messages`);
  assert.ok(heavy < 1_500_000, `bench.json is ${heavy} bytes with a third of the rows at 120-character previews and the rest at 160-character messages`);
  assert.ok(worst < 2_000_000, `bench.json is ${worst} bytes with every row an answer at the 120-character cap`);
});

// ------------------------------------------- a flaky re-probe never erases a good record

import { mergeRecord } from "../refresh/bench-store.mjs";

const DAY = 864e5;
const at = (ms) => sec(NOW - ms);
const TTL = 7 * DAY;

test("mergeRecord: a transient newer record does not replace a fresh real one; everything else is last-wins", () => {
  const opts = { ttlMs: TTL, nowMs: NOW };
  const ok = { s: "ok", t: 800, d: 1900, a: at(1 * DAY), p: "hi" };
  assert.equal(mergeRecord(ok, { s: "error", a: at(0), m: "boom" }, opts), ok, "ok then error: the ok stays");
  for (const s of ["rate", "timeout", "skip"]) assert.equal(mergeRecord(ok, { s, a: at(0) }, opts), ok, s);
  const newer = { s: "ok", t: 500, d: 1000, a: at(0), p: "again" };
  assert.equal(mergeRecord(ok, newer, opts), newer, "ok then a newer ok: the newer wins");
  const gone = { s: "gone", a: at(0) };
  assert.equal(mergeRecord(ok, gone, opts), gone, "a newer REAL result of another kind wins too (the model was retired)");
  const oldOk = { s: "ok", a: at(10 * DAY) };
  const err = { s: "error", a: at(0) };
  assert.equal(mergeRecord(oldOk, err, opts), err, "an ok past the ttl is not protected");
  const pay = { s: "pay", a: at(1 * DAY) };
  assert.equal(mergeRecord(pay, err, opts), pay, "pay then error: the pay (a real, fresh finding) stays");
  const err0 = { s: "error", a: at(2 * DAY) };
  assert.equal(mergeRecord(err0, err, opts), err, "error then error: the newer");
  assert.equal(mergeRecord(err0, { s: "ok", a: at(0) }, opts).s, "ok", "error then ok");
  assert.equal(mergeRecord(undefined, err, opts), err, "nothing older: the newer");
  assert.equal(mergeRecord(ok, { s: "nonsense" }, opts), ok, "an unusable newer record replaces nothing");
  assert.equal(mergeRecord({ s: "ok" }, err, opts), err, "an older record with no timestamp is not fresh, so it is not protected");
});

const withLog = (bench, logLines) => {
  const dir = tmp(); const file = path.join(dir, "b.json"); const log = path.join(dir, "b.jsonl");
  if (bench) fs.writeFileSync(file, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: bench }));
  fs.writeFileSync(log, logLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { file, log };
};

test("compact keeps the good record when the log's newer one for the same model is transient", () => {
  const good = { s: "ok", t: 800, d: 1900, a: at(1 * DAY), p: "hi" };
  // ok in the previous bench.json, error in the log: a --force run in a flaky hour
  const a = withLog({ "p/m": good }, [{ key: "p/m", s: "error", d: 30000, a: at(0), m: "boom" }]);
  assert.equal(compact({ benchFile: a.file, logFile: a.log, now: () => new Date(NOW), ttlMs: TTL }), 1);
  assert.deepEqual(readBench(a.file).get("p/m"), good);
  assert.equal(fs.readFileSync(a.log, "utf8"), "", "the log is truncated after the fold, as before");
  // ok then error, both in the log (an interrupted run resumed before a compaction)
  const b = withLog(null, [{ key: "p/m", s: "ok", t: 800, a: at(1 * DAY), p: "hi" }, { key: "p/m", s: "timeout", a: at(0) }]);
  assert.equal(fs.readFileSync(b.log, "utf8").trim().split("\n").length, 2, "both results were appended: the log itself loses nothing");
  compact({ benchFile: b.file, logFile: b.log, now: () => new Date(NOW), ttlMs: TTL });
  assert.equal(readBench(b.file).get("p/m").s, "ok");
});

test("compact: a newer ok wins, an ok past the ttl loses to the error, pay survives an error, error then error keeps the newer", () => {
  const cases = [
    ["ok then newer ok", { s: "ok", t: 800, a: at(2 * DAY), p: "old" }, { s: "ok", t: 500, a: at(0), p: "new" }, "new"],
    ["ok past the ttl then error", { s: "ok", a: at(10 * DAY), p: "old" }, { s: "error", a: at(0), p: "boom" }, "boom"],
    ["pay then error", { s: "pay", a: at(1 * DAY), p: "needs credit" }, { s: "error", a: at(0), p: "boom" }, "needs credit"],
    ["error then error", { s: "error", a: at(2 * DAY), p: "first" }, { s: "error", a: at(0), p: "second" }, "second"],
    ["error then ok", { s: "error", a: at(2 * DAY), p: "first" }, { s: "ok", a: at(0), p: "fine" }, "fine"],
  ];
  for (const [name, older, newer, wantP] of cases) {
    const w = withLog({ "p/m": older }, [{ key: "p/m", ...newer }]);
    compact({ benchFile: w.file, logFile: w.log, now: () => new Date(NOW), ttlMs: TTL });
    assert.equal(readBench(w.file).get("p/m").p, wantP, name);
  }
});

test("the resume read sees the protected record too, so a good row is not re-probed", () => {
  const w = withLog({ "p/m": { s: "ok", t: 800, a: at(1 * DAY), p: "hi" } }, [{ key: "p/m", s: "error", a: at(0) }]);
  const ex = loadExisting({ benchFile: w.file, logFile: w.log, ttlMs: TTL, nowMs: NOW });
  assert.equal(ex.get("p/m").s, "ok");
  assert.equal(isFresh(ex.get("p/m"), { ttlMs: TTL, nowMs: NOW }), true, "so a resume skips it");
  // and without the protection window a stale ok is replaced
  const stale = withLog({ "p/m": { s: "ok", a: at(30 * DAY) } }, [{ key: "p/m", s: "error", a: at(0) }]);
  assert.equal(loadExisting({ benchFile: stale.file, logFile: stale.log, ttlMs: TTL, nowMs: NOW }).get("p/m").s, "error");
});

test("compact still prunes rows the catalogue dropped and skips unusable records", () => {
  const w = withLog({ "p/keep": { s: "ok", a: at(1 * DAY) }, "p/gone": { s: "ok", a: at(1 * DAY) } }, [{ key: "p/keep", s: "error", a: at(0) }, { key: "p/bad", s: "???" }]);
  compact({ benchFile: w.file, logFile: w.log, keep: new Set(["p/keep"]), now: () => new Date(NOW), ttlMs: TTL });
  assert.deepEqual([...readBench(w.file).keys()], ["p/keep"]);
  assert.equal(readBench(w.file).get("p/keep").s, "ok");
});

// ---------------------------------------------- provider text is redacted at rest

import { redactRecord, redactBench } from "../refresh/bench-store.mjs";

const SAMBA = "sambanova: Incorrect API key provided: 7f3a9c*****e21d.";
const GO = "commandcode: Your Go plan doesn't include API access. Upgrade to Provider or higher at https://commandcode.ai/billing to use these endpoints.";
const leaks = (s) => /7f3a9c|e21d|https?:\/\/|commandcode\.ai/.test(s);

test("toStored redacts `m` and the head of a non-ok `p`, and leaves an ok answer alone", () => {
  const s = toStored({ s: "auth", d: 30, a: 5, p: SAMBA.slice(0, 40), m: SAMBA });
  assert.equal(s.m, "sambanova: Incorrect API key provided: [masked-key].");
  assert.equal(leaks(s.m), false);
  const p = toStored({ s: "pay", p: "Upgrade at https://commandcode.ai/billing", m: GO });
  assert.equal(leaks(p.p), false, p.p); assert.equal(leaks(p.m), false);
  assert.match(p.m, /Upgrade to Provider or higher at \[url\] to use these endpoints\./);
  const ok = toStored({ s: "ok", p: "See https://example.com for more", t: 1 });
  assert.equal(ok.p, "See https://example.com for more", "an ok `p` is the model's own answer, not provider text");
});

test("cleanRecord redacts on load too (a file written before redaction existed), and keeps `b` only when present", () => {
  const dir = tmp(); const f = path.join(dir, "bench.json");
  fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: {
    "s/a": { s: "auth", a: 1, p: "sambanova: Incorrect API key provided: 4796c", m: SAMBA },
    "c/b": { s: "pay", a: 1, m: GO },
    "o/k": { s: "ok", a: 1, t: 5, p: "hi", b: 1024 },
    "o/n": { s: "ok", a: 1, t: 5, p: "hi" },
    "o/x": { s: "ok", a: 1, b: -3 },
  } }));
  const b = loadBench(f);
  assert.equal(leaks(b.get("s/a").m), false); assert.equal(leaks(b.get("c/b").m), false);
  assert.equal(leaks(b.get("s/a").p), false);
  assert.equal(b.get("o/k").b, 1024);
  assert.equal("b" in b.get("o/n"), false, "no `b` unless the probe used a non-default budget");
  assert.equal("b" in b.get("o/x"), false, "a nonsense budget is ignored");
});

test("`b` (the probe's max_tokens) is stored when it is not the default budget", () => {
  assert.equal(toStored({ s: "ok", t: 1, b: 1024 }).b, 1024);
  assert.equal(toStored({ s: "ok", t: 1 }).b, undefined);
});

test("redactRecord reports whether it changed anything, and never touches the measurements", () => {
  const rec = { s: "auth", a: 5, d: 40, t: 7, m: SAMBA, p: "sambanova: Incorrect API key provided: 7f3a9c*", w: "" };
  const r = redactRecord(rec);
  assert.equal(r.changed, true);
  assert.deepEqual([r.rec.s, r.rec.a, r.rec.d, r.rec.t], ["auth", 5, 40, 7]);
  assert.equal(redactRecord(r.rec).changed, false, "idempotent");
  assert.equal(redactRecord({ s: "ok", p: "https://x.com", t: 1 }).changed, false, "an ok answer is not provider text");
  assert.equal(redactRecord({ s: "gone", a: 1 }).changed, false);
  assert.equal(redactRecord(null).changed, false);
});

test("redactBench rewrites bench.json once, keeps everything else as it was, and a second run changes nothing", () => {
  const dir = tmp(); const file = path.join(dir, "bench.json"); const log = path.join(dir, "bench.jsonl");
  const models = {
    "sambanova/a": { s: "auth", a: 9, d: 30, p: SAMBA, m: SAMBA },
    "commandcode/b": { s: "pay", a: 9, d: 40, m: GO },
    "openai/c": { s: "ok", a: 9, t: 800, d: 1900, p: "Hello there", o: 12 },
    "aihubmix/d": { s: "gone", a: 9, m: "The model `x` does not exist" },
  };
  fs.writeFileSync(file, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "2026-09-29T14:29:03.034Z", params: { prompt: "P", maxTokens: 96 }, models }));
  fs.writeFileSync(log, [JSON.stringify({ key: "sambanova/z", s: "auth", a: 10, m: SAMBA }), '{"key":"torn","s":"err'].join("\n") + "\n");
  const r = redactBench({ benchFile: file, logFile: log });
  assert.deepEqual([r.ok, r.records, r.changed, r.logRecords, r.logChanged], [true, 4, 2, 1, 1]);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.generatedAt, "2026-09-29T14:29:03.034Z"); assert.deepEqual(raw.params, { prompt: "P", maxTokens: 96 });
  assert.deepEqual(raw.models["openai/c"], models["openai/c"], "an untouched record is exactly the same");
  assert.equal(raw.models["aihubmix/d"].m, models["aihubmix/d"].m);
  assert.equal(leaks(JSON.stringify(raw)), false, "nothing sensitive is left in the file");
  assert.equal(raw.models["sambanova/a"].d, 30);
  const logText = fs.readFileSync(log, "utf8");
  assert.equal(leaks(logText), false);
  assert.ok(logText.includes('{"key":"torn","s":"err'), "a torn log line is left exactly as it was");
  const again = redactBench({ benchFile: file, logFile: log });
  assert.deepEqual([again.changed, again.logChanged], [0, 0]);
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp")).length, 0, "no temp file left behind");
});

test("redactBench refuses a missing, corrupt or foreign-schema file and writes nothing", () => {
  const dir = tmp();
  assert.equal(redactBench({ benchFile: path.join(dir, "none.json"), logFile: path.join(dir, "l") }).ok, false);
  const bad = path.join(dir, "bad.json"); fs.writeFileSync(bad, "{nope");
  assert.equal(redactBench({ benchFile: bad, logFile: path.join(dir, "l") }).ok, false);
  const other = path.join(dir, "other.json"); fs.writeFileSync(other, JSON.stringify({ schema: 999, models: {} }));
  assert.equal(redactBench({ benchFile: other, logFile: path.join(dir, "l") }).ok, false);
  assert.equal(fs.readFileSync(bad, "utf8"), "{nope");
});

test("compact redacts whatever it folds in, including a log written before redaction existed", () => {
  const dir = tmp(); const file = path.join(dir, "b.json"); const log = path.join(dir, "b.jsonl");
  fs.writeFileSync(log, JSON.stringify({ key: "sambanova/a", s: "auth", a: sec(NOW), m: SAMBA, p: SAMBA }) + "\n");
  compact({ benchFile: file, logFile: log, now: () => new Date(NOW), ttlMs: 7 * 864e5 });
  assert.equal(leaks(fs.readFileSync(file, "utf8")), false);
});

test("an `empty` is a real result: a newer ok replaces it, a newer error or timeout does NOT (mergeRecord)", () => {
  const opts = { ttlMs: 7 * 864e5, nowMs: NOW };
  const empty = { s: "empty", d: 3000, o: 96, a: sec(NOW - 864e5), p: "budget spent on hidden reasoning", m: "budget spent on hidden reasoning (stop_reason max_tokens, 96 tokens)" };
  const ok1024 = { s: "ok", t: 9000, d: 20000, o: 700, a: sec(NOW), p: "Hello", b: 1024 };
  assert.equal(mergeRecord(empty, ok1024, opts), ok1024, "the re-probe that now answers ok replaces the empty");
  for (const s of ["error", "timeout", "rate", "skip"]) assert.equal(mergeRecord(empty, { s, a: sec(NOW) }, opts), empty, `a newer ${s} does not overwrite the empty`);
  const empty2 = { s: "empty", a: sec(NOW), o: 1024 };
  assert.equal(mergeRecord(empty, empty2, opts), empty2, "empty then empty: the newer (a real result) wins");
  const w = withLog({ "p/m": empty }, [{ key: "p/m", ...ok1024 }]);
  compact({ benchFile: w.file, logFile: w.log, now: () => new Date(NOW), ttlMs: 7 * 864e5 });
  const kept = readBench(w.file).get("p/m");
  assert.equal(kept.s, "ok"); assert.equal(kept.b, 1024, "and the budget it was probed with is carried");
});

// ------------------------------------------------- an ok preview is the model's text

test("an ok `p` keeps its links and prose but has credentials and ids masked, on write, on load and in --redact", () => {
  const p = "Visit https://example.com or use key sk-abcdefghijklmnopqrstuvwx (req_011CTbgXq2LmNv7Bc1Rt5Yw8)";
  const s = toStored({ s: "ok", t: 5, p });
  assert.match(s.p, /^Visit https:\/\/example\.com/); assert.equal(/sk-abcdefghij|req_011/.test(s.p), false);
  const dir = tmp(); const f = path.join(dir, "bench.json");
  fs.writeFileSync(f, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: { "a/b": { s: "ok", a: 1, t: 5, p: "key sk-abcdefghijklmnopqrstuvwx" } } }));
  assert.equal(/sk-abcdefghij/.test(loadBench(f).get("a/b").p), false, "masked on load");
  const r = redactBench({ benchFile: f, logFile: path.join(dir, "l") });
  assert.equal(r.changed, 1, "and --redact counts it");
  assert.equal(/sk-abcdefghij/.test(fs.readFileSync(f, "utf8")), false);
  assert.equal(redactRecord({ s: "ok", p: "See https://example.com", t: 1 }).changed, false, "a plain link in an answer is not touched");
});

// ------------------------------------------------- --redact without a readable bench.json

test("redactBench still redacts a non-empty LOG when bench.json is missing or corrupt", () => {
  for (const setup of [(f) => {}, (f) => fs.writeFileSync(f, "{nope"), (f) => fs.writeFileSync(f, JSON.stringify({ schema: 999, models: {} }))]) {
    const dir = tmp(); const file = path.join(dir, "bench.json"); const log = path.join(dir, "bench.jsonl");
    setup(file);
    fs.writeFileSync(log, [JSON.stringify({ key: "s/a", s: "auth", a: 5, m: SAMBA, p: "sambanova: Incorrect API key provided: 7f3a9c*" }), '{"key":"torn'].join("\n") + "\n");
    const r = redactBench({ benchFile: file, logFile: log });
    assert.equal(r.ok, true); assert.equal(r.benchOk, false);
    assert.deepEqual([r.logRecords, r.logChanged], [1, 1]);
    assert.equal(leaks(fs.readFileSync(log, "utf8")), false);
    assert.ok(!/7f3a9c/.test(fs.readFileSync(log, "utf8")), "the truncated single-asterisk fragment is masked too");
    if (fs.existsSync(file)) assert.ok(fs.readFileSync(file, "utf8") === "{nope" || fs.readFileSync(file, "utf8").includes("999"), "the unreadable bench.json is left exactly as it was");
  }
  const dir = tmp();
  assert.equal(redactBench({ benchFile: path.join(dir, "n.json"), logFile: path.join(dir, "n.jsonl") }).ok, false, "nothing readable at all is still a refusal");
});

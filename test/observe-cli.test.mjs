// Live status C3: the one-shot entry (--catchup, --dry, --status, --reset, --off, --on), the kill switch, and --redact over the
// overlay. Everything runs in TEMP directories through `main()`'s injectable seams; nothing here opens the real router data or
// the real state/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { main, parseArgs } from "../refresh/observe-cli.mjs";
import { observeEnabled, readOverlay } from "../refresh/observe.mjs";
import { redactBench, redactRecord, archiveBench } from "../refresh/bench-store.mjs";
import { mkEnv, mkTmp, buildUsage, writeBench, fake, fakeCore, NOW, iso, epoch, T0 } from "./fixtures/observe-fixture.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function cli(e, argv, extra = {}) {
  const out = [], err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s), stateDir: e.stateDir, snapshotFile: e.snapshotFile,
    usageDb: e.usageDb, logsDb: e.logsDb, nowMs: NOW, bake: null, spawn: e.spawn, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("parseArgs: modes, --dry only with --catchup, --backfill-days is bounded", () => {
  assert.equal(parseArgs([]).mode, "catchup");
  assert.equal(parseArgs(["--confirm", "a/b"]).key, "a/b");
  assert.equal(parseArgs(["--catchup", "--dry", "--backfill-days", "3"]).backfillDays, 3);
  assert.match(parseArgs(["--status", "--dry"]).error, /--dry goes with --catchup/);
  assert.match(parseArgs(["--backfill-days", "0"]).error, /1 to 30/);
  assert.match(parseArgs(["--bogus"]).error, /unrecognised/);
});

test("the script itself refuses an unknown flag with exit 2 and touches nothing", () => {
  const r = spawnSync(process.execPath, ["--no-warnings", path.join(ROOT, "refresh", "observe-cli.mjs"), "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised argument/);
});

test("--catchup writes the overlay and the run file, says what it did, and leaves no lock behind", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429 });
  const r = await cli(e, ["--catchup"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /done: feed ok; examined 1 row\(s\)/);
  assert.match(r.out, /wrote 1 record\(s\) \{"rate":1\}/);
  assert.deepEqual(fs.readdirSync(e.stateDir).sort(), ["observed.json", "observed.run"]);
});

test("--catchup --dry prints the aggregates and writes nothing at all", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429 });
  e.u.insert({ client: "uw-probe" });
  const snap = () => fs.readdirSync(e.stateDir).map((f) => [f, fs.readFileSync(path.join(e.stateDir, f), "utf8")]);
  const before = snap();
  const r = await cli(e, ["--catchup", "--dry"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /DRY RUN \(nothing written\)/);
  assert.match(r.out, /examined 2 row\(s\) in \d+ ms/);
  assert.match(r.out, /"probe":1/);
  assert.match(r.out, /would write 1 record\(s\)/);
  assert.deepEqual(snap(), before, "no overlay or run file rewritten, and no lock or temp file created");
});

test("a failing -> ok flip is reported as wanting a confirmation (C4 acts on it)", async () => {
  const e = await mkEnv();
  writeBench(e.benchFile, { "prov/m1": { s: "rate", a: epoch(T0) - 60 } });
  await e.init();
  e.u.insert({ request_id: "flip" });
  const r = await cli(e, ["--catchup"]);
  assert.match(r.out, /1 failing -> ok flip\(s\) seen/);
  assert.match(r.out, /confirmation probes: requested 1/);
  assert.equal(e.spawned.length, 1);
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].cf, 1);
});

test("the kill switch: with observe.off present --catchup and --confirm exit 0 at once and silently, touching nothing", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429 });
  const snap = () => fs.readdirSync(e.stateDir).map((f) => [f, fs.readFileSync(path.join(e.stateDir, f), "utf8")]);
  const before = snap();
  fs.writeFileSync(e.P.off, "x");
  assert.equal(observeEnabled(e.stateDir), false);
  for (const argv of [["--catchup"], ["--confirm", "prov/m1"], ["--catchup", "--dry"]]) {
    const r = await cli(e, argv);
    assert.equal(r.code, 0);
    assert.equal(r.out, "");
    assert.equal(r.err, "");
  }
  assert.deepEqual(snap().filter(([f]) => f !== "observe.off"), before, "nothing was touched");
  fs.rmSync(e.P.off);
  const on = await cli(e, ["--catchup"]);
  assert.match(on.out, /examined 1 row\(s\)/, "removing the sentinel restores it");
});

test("--confirm with nothing to confirm skips quietly (exit 0) and never probes; a malformed key is refused (exit 2)", async () => {
  const e = await mkEnv();
  const probe = () => { throw new Error("must not probe"); };
  const r = await cli(e, ["--confirm", "prov/m1"], { probe });
  assert.equal(r.code, 0);
  assert.match(r.out, /confirm skipped \(no-flip\)/);
  const bad = await cli(e, ["--confirm", "--catchup"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--confirm takes one provider\/id/);
  assert.equal((await cli(e, ["--confirm", "a b;rm"])).code, 2);
});

test("--off creates the sentinel, --on removes it, and both say when nothing changed", async () => {
  const e = await mkEnv();
  assert.match((await cli(e, ["--off"])).out, /disabled \(created/);
  assert.equal(fs.existsSync(e.P.off), true);
  assert.match((await cli(e, ["--off"])).out, /already disabled/);
  assert.match((await cli(e, ["--on"])).out, /enabled \(removed/);
  assert.equal(fs.existsSync(e.P.off), false);
  assert.match((await cli(e, ["--on"])).out, /already enabled/);
});

test("--reset removes the overlay and the run file (and only those), prints what it removed, and the next run starts at the last row", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429 });
  await cli(e, ["--catchup"]);
  fs.writeFileSync(path.join(e.stateDir, "bench.json"), "{}");
  const r = await cli(e, ["--reset"]);
  assert.match(r.out, /removed observed\.json, observed\.run/);
  assert.deepEqual(fs.readdirSync(e.stateDir), ["bench.json"]);
  assert.match((await cli(e, ["--reset"])).out, /nothing to remove/);
  e.u.insert({ status_code: 429 });
  const again = await cli(e, ["--catchup"]);
  assert.match(again.out, /examined 0 row\(s\)/, "history is not re-read");
});

test("--status prints enabled, last run, feed, watermark, counts and the last error", async () => {
  const e = await mkEnv();
  const empty = await cli(e, ["--status"]);
  assert.match(empty.out, /enabled/);
  assert.match(empty.out, /last run: never; no error/);
  assert.match(empty.out, /watermark: none yet/);
  await e.init();
  e.u.insert({ status_code: 429 });
  e.u.insert({ status_code: 502, request_id: "p1" });
  await cli(e, ["--catchup"]);
  const s = (await cli(e, ["--status"])).out;
  assert.match(s, new RegExp(`last run: ${iso(NOW)}; no error`));
  assert.match(s, /feed: ok/);
  assert.match(s, /watermark: id 3/);
  assert.match(s, /overlay: 1 model record\(s\), 1 pending/);
  fs.writeFileSync(e.P.off, "x");
  assert.match((await cli(e, ["--status"])).out, /DISABLED/);
});

test("a run with no usable snapshot fails soft: exit 1, the error lands in observed.run, --status shows it, the overlay is untouched", async () => {
  const e = await mkEnv();
  await e.init();
  e.u.insert({ status_code: 429 });
  await cli(e, ["--catchup"]);
  const before = fs.readFileSync(e.P.overlay, "utf8");
  fs.rmSync(e.snapshotFile);
  const r = await cli(e, ["--catchup"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no usable snapshot/);
  assert.equal(fs.readFileSync(e.P.overlay, "utf8"), before);
  assert.match((await cli(e, ["--status"])).out, /last error: no usable snapshot/);
});

// ----------------------------------------------------------------- --redact and history cover the overlay

const overlayWith = (models) => JSON.stringify({ schema: 1, writtenAt: iso(NOW), feed: "ok", wm: null, tagId: null, models, pend: {}, conf: {}, confDay: { d: null, n: 0 } });

test("--redact also redacts m and a non-ok p in observed.json, under the overlay lock, and a second run changes nothing", () => {
  const t = mkTmp();
  writeBench(t.benchFile, {});
  const dirty = `leaked ${fake("sk")} at https://evil.example.com/x`;
  fs.writeFileSync(path.join(t.stateDir, "observed.json"), overlayWith({
    "prov/m1": { s: "rate", a: 5, l: 1, m: dirty, p: dirty },
    "prov/m2": { s: "ok", a: 5, l: 1 },
  }));
  const r = redactBench({ benchFile: t.benchFile, logFile: path.join(t.stateDir, "bench.jsonl") });
  assert.equal(r.observedRecords, 2);
  assert.equal(r.observedChanged, 1);
  const o = readOverlay(path.join(t.stateDir, "observed.json"));
  assert.ok(!JSON.stringify(o).includes(fakeCore("sk")));
  assert.doesNotMatch(JSON.stringify(o), /evil.example/);
  assert.equal(o.models["prov/m2"].s, "ok", "the rest is carried over untouched");
  assert.equal(redactBench({ benchFile: t.benchFile, logFile: path.join(t.stateDir, "bench.jsonl") }).observedChanged, 0);
  assert.deepEqual(fs.readdirSync(t.stateDir).sort(), ["bench.json", "observed.json"], "no lock or temp file left behind");
});

test("--redact skips the overlay (not an error) while the overlay lock is held, and never rewrites it", () => {
  const t = mkTmp();
  writeBench(t.benchFile, {});
  const file = path.join(t.stateDir, "observed.json");
  fs.writeFileSync(file, overlayWith({ "prov/m1": { s: "rate", a: 5, l: 1, m: fake("sk") } }));
  fs.writeFileSync(path.join(t.stateDir, "observed.lock"), JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 }));
  const before = fs.readFileSync(file, "utf8");
  const r = redactBench({ benchFile: t.benchFile, logFile: path.join(t.stateDir, "bench.jsonl") });
  assert.equal(r.ok, true);
  assert.equal(r.observedSkipped, true);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("--redact with no overlay behaves exactly as before (the result has no overlay fields)", () => {
  const t = mkTmp();
  writeBench(t.benchFile, { "a/b": { s: "ok", a: 1 } });
  const r = redactBench({ benchFile: t.benchFile, logFile: path.join(t.stateDir, "none.jsonl") });
  assert.equal("observedRecords" in r, false);
});

test("redactRecord still handles a live overlay record's m and p", () => {
  const r = redactRecord({ s: "rate", m: `key ${fake("sk")}`, l: 1 });
  assert.equal(r.changed, true);
  assert.equal(r.rec.l, 1);
});

test("history backups copy bench.json only: no observed file ever reaches bench-history/", () => {
  const t = mkTmp();
  writeBench(t.benchFile, { "a/b": { s: "ok", a: 1 } });
  fs.writeFileSync(path.join(t.stateDir, "observed.json"), overlayWith({}));
  archiveBench({ benchFile: t.benchFile });
  const hist = fs.readdirSync(path.join(t.stateDir, "bench-history"));
  assert.ok(hist.length >= 1);
  assert.ok(hist.every((f) => !/observed/.test(f)), hist.join(","));
});

// ----------------------------------------------------------------- review round

test("two mode flags are refused with exit 2 and nothing runs", async () => {
  for (const argv of [["--off", "--catchup"], ["--catchup", "--confirm", "prov/m1"], ["--status", "--reset"], ["--on", "--off"], ["--confirm", "prov/m1", "--catchup"]]) {
    assert.match(parseArgs(argv).error, /only one mode at a time/, argv.join(" "));
  }
  const e = await mkEnv();
  const r = await cli(e, ["--off", "--catchup"]);
  assert.equal(r.code, 2);
  assert.equal(fs.existsSync(e.P.off), false, "--off was not carried out");
  assert.equal(parseArgs(["--catchup", "--dry"]).mode, "catchup", "one mode plus modifiers is fine");
});

test("--status prints only sanitized text: an ESC/OSC-laden overlay and run file cannot inject terminal sequences", async () => {
  const e = await mkEnv();
  const esc = "001b", bel = "0007";
  fs.writeFileSync(e.P.overlay, JSON.stringify({ schema: 1, writtenAt: `${esc}]0;evil${bel}2026`, feed: `ok${esc}[31mRED${esc}[0m`, wm: { id: `${esc}[2J`, at: `${esc}]8;;http://x${bel}at` }, models: {}, pend: null, conf: {}, confDay: { d: null, n: 0 } }));
  fs.writeFileSync(e.P.run, JSON.stringify({ ranAt: `${esc}[1mnow`, error: `${esc}]0;title\u0007boom`, skip: { [`${esc}[31mk`]: 3, bad: "x" }, examined: `${esc}[2J` }));
  const r = await cli(e, ["--status"]);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out + r.err, /\u001b|\u0007/);
  assert.match(r.out, /boom/);
});

test("--redact: a transient failure on observed.json cannot stop bench.json from being redacted", () => {
  const t = mkTmp();
  const dirty = `leaked ${fake("sk")} here`;
  writeBench(t.benchFile, { "a/b": { s: "rate", a: 1, m: dirty } });
  const overlay = path.join(t.stateDir, "observed.json");
  fs.writeFileSync(overlay, overlayWith({ "prov/m1": { s: "rate", a: 5, l: 1, m: dirty } }));
  fs.chmodSync(overlay, 0o444);                                      // a read-only file: the atomic rename over it fails with EPERM/EACCES
  try {
    const r = redactBench({ benchFile: t.benchFile, logFile: path.join(t.stateDir, "none.jsonl") });
    assert.equal(r.ok, true);
    assert.equal(r.changed, 1);
    assert.equal(r.observedSkipped, true);
    assert.ok(!fs.readFileSync(t.benchFile, "utf8").includes(fakeCore("sk")));
  } finally { fs.chmodSync(overlay, 0o666); }
});

test("an unavailable feed prints no read-run facts, --status names the missing columns (sanitized), and --reset says where the next run starts", async () => {
  const e = await mkEnv();
  const bad = path.join(e.dir, "bad.sqlite");
  const b = buildUsage(bad, { dropColumn: "status_code" });
  b.insert({});
  b.close();
  const r = await cli(e, ["--catchup"], { usageDb: bad });
  assert.equal(r.code, 0);
  assert.match(r.out, /feed unavailable:schema/);
  assert.doesNotMatch(r.out, /per-provider recount|messages from/);
  const s = (await cli(e, ["--status"])).out;
  assert.match(s, /feed: unavailable:schema/);
  assert.match(s, /usage_events columns missing: status_code/);
  const esc = "\u001b";
  const run = JSON.parse(fs.readFileSync(e.P.run, "utf8"));
  fs.writeFileSync(e.P.run, JSON.stringify({ ...run, missing: [`${esc}[31mevil_col`, 5] }));
  const dirty = (await cli(e, ["--status"])).out;
  assert.doesNotMatch(dirty, /\u001b/);
  assert.match(dirty, /columns missing: .*evil_col/);
  assert.match((await cli(e, ["--reset"])).out, /the next run starts at the first UW-probe row in the last 3 days, else at the router's current last row/);
});

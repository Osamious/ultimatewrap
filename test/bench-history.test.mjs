// Dated history backups of bench.json (archiveBench) and the CLI paths that call it. Every test uses a
// temp directory: nothing here reads or writes the real ~/.uw/state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { archiveBench } from "../refresh/bench-store.mjs";
import { parseArgs, main, DEFAULTS } from "../refresh/bench-cli.mjs";
import { BENCH_SCHEMA } from "../menu/bench-data.mjs";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-history-"));
const bench = (models = { "s/a": { s: "ok", a: 1, t: 5, p: "hi" } }) => JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models });
const at = (iso) => () => new Date(iso);
const list = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const setup = (text = bench()) => {
  const dir = scratch(); const benchFile = path.join(dir, "bench.json"); const historyDir = path.join(dir, "bench-history");
  if (text !== null) fs.writeFileSync(benchFile, text);
  return { dir, benchFile, historyDir };
};

test("archives bench.json as is, under a UTC-stamped name, with no temp debris", () => {
  const { benchFile, historyDir } = setup();
  const r = archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:15:07.123Z") });
  assert.equal(r.archived, path.join(historyDir, "bench-20260930T101507Z.json"));
  assert.equal(fs.readFileSync(r.archived, "utf8"), fs.readFileSync(benchFile, "utf8"));
  assert.deepEqual(list(historyDir), ["bench-20260930T101507Z.json"]);
  assert.equal(r.pruned, 0);
});

test("the default history directory is bench-history/ beside the bench file", () => {
  const { dir, benchFile } = setup();
  const r = archiveBench({ benchFile, now: at("2026-09-30T10:15:07Z") });
  assert.equal(r.archived, path.join(dir, "bench-history", "bench-20260930T101507Z.json"));
});

test("identical content is not duplicated; changed content is", () => {
  const { benchFile, historyDir } = setup();
  assert.ok(archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00Z") }).archived);
  const again = archiveBench({ benchFile, historyDir, now: at("2026-09-30T11:00:00Z") });
  assert.equal(again.archived, null);
  assert.equal(again.unchanged, "bench-20260930T100000Z.json");
  assert.equal(list(historyDir).length, 1);
  fs.writeFileSync(benchFile, bench({ "s/a": { s: "gone", a: 2 } }));
  assert.ok(archiveBench({ benchFile, historyDir, now: at("2026-09-30T12:00:00Z") }).archived);
  assert.equal(list(historyDir).length, 2);
});

test("prunes to the newest `keep`, by name", () => {
  const { benchFile, historyDir } = setup();
  for (let h = 0; h < 5; h++) {
    fs.writeFileSync(benchFile, bench({ "s/a": { s: "ok", a: h + 1 } }));
    archiveBench({ benchFile, historyDir, keep: 3, now: at(`2026-09-30T0${h}:00:00Z`) });
  }
  assert.deepEqual(list(historyDir), ["bench-20260930T020000Z.json", "bench-20260930T030000Z.json", "bench-20260930T040000Z.json"]);
  fs.writeFileSync(benchFile, bench({ "s/a": { s: "ok", a: 99 } }));
  const r = archiveBench({ benchFile, historyDir, keep: 1, now: at("2026-09-30T09:00:00Z") });
  assert.equal(r.pruned, 3); assert.equal(r.kept, 1); assert.equal(r.of, 4);
  assert.deepEqual(list(historyDir), ["bench-20260930T090000Z.json"]);
});

test("pruning touches only bench-<stamp>.json: other files and directories survive", () => {
  const { benchFile, historyDir } = setup();
  fs.mkdirSync(path.join(historyDir, "bench-2026.json"), { recursive: true });   // a directory with a bench-*.json look
  for (const f of ["notes.txt", "bench-old.json", "bench.json.bak", "picker.json"]) fs.writeFileSync(path.join(historyDir, f), "keep me");
  for (const h of [1, 2, 3]) {
    fs.writeFileSync(benchFile, bench({ "s/a": { s: "ok", a: h } }));
    archiveBench({ benchFile, historyDir, keep: 1, now: at(`2026-09-30T0${h}:00:00Z`) });
  }
  assert.deepEqual(list(historyDir), ["bench-2026.json", "bench-20260930T030000Z.json", "bench-old.json", "bench.json.bak", "notes.txt", "picker.json"]);
});

test("missing, blank or record-less bench.json is a quiet skip; corrupt or foreign-schema is a failure; neither throws or creates the directory", () => {
  for (const text of [null, "", "  \n", bench({})]) {
    const { benchFile, historyDir } = setup(text);
    const r = archiveBench({ benchFile, historyDir });
    assert.equal(r.archived, null, JSON.stringify(text));
    assert.equal(r.skipped, true, JSON.stringify(text));
    assert.match(r.reason, /\S/);
    assert.equal(fs.existsSync(historyDir), false, "nothing to copy, nothing created");
  }
  for (const text of ["{ not json", JSON.stringify({ schema: BENCH_SCHEMA + 1, models: { "s/a": { s: "ok" } } }), "[]"]) {
    const { benchFile, historyDir } = setup(text);
    const r = archiveBench({ benchFile, historyDir });
    assert.equal(r.archived, null, JSON.stringify(text));
    assert.equal(r.skipped, undefined, "a corrupt file is a failure to report, not a quiet skip");
    assert.match(r.reason, /corrupt or another schema/);
    assert.equal(fs.existsSync(historyDir), false);
  }
});

test("another read failure reports its error code, not 'no bench.json'", () => {
  const { dir, historyDir } = setup(null);
  const benchFile = path.join(dir, "bench.json"); fs.mkdirSync(benchFile);       // a directory where the file should be
  const r = archiveBench({ benchFile, historyDir });
  assert.equal(r.archived, null);
  assert.equal(r.skipped, undefined);
  assert.match(r.reason, /cannot read bench\.json: [A-Z]{4,}/);
});

test("a history directory that cannot be created: archived null with a reason, no throw", () => {
  const { dir, benchFile } = setup();
  const blocker = path.join(dir, "blocker"); fs.writeFileSync(blocker, "a file, not a directory");
  const r = archiveBench({ benchFile, historyDir: path.join(blocker, "bench-history") });
  assert.equal(r.archived, null);
  assert.match(r.reason, /\S/);
});

test("two archives in the same second do not clobber each other, and still sort by time", () => {
  const { benchFile, historyDir } = setup();
  const t = at("2026-09-30T10:00:00.100Z");
  const a = archiveBench({ benchFile, historyDir, now: t });
  fs.writeFileSync(benchFile, bench({ "s/a": { s: "gone", a: 2 } }));
  const b = archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00.900Z") });
  assert.notEqual(a.archived, b.archived);
  assert.deepEqual(list(historyDir), ["bench-20260930T100000Z.json", "bench-20260930T100000Z_02.json"]);
  assert.match(fs.readFileSync(a.archived, "utf8"), /"ok"/);
  assert.match(fs.readFileSync(b.archived, "utf8"), /"gone"/);
  fs.writeFileSync(benchFile, bench({ "s/a": { s: "ok", a: 3 } }));
  archiveBench({ benchFile, historyDir, keep: 2, now: at("2026-09-30T10:00:01Z") });
  assert.deepEqual(list(historyDir), ["bench-20260930T100000Z_02.json", "bench-20260930T100001Z.json"], "the older same-second copy is the one pruned");
});

test("keep below 1 cannot prune the copy just written", () => {
  const { benchFile, historyDir } = setup();
  const r = archiveBench({ benchFile, historyDir, keep: 0, now: at("2026-09-30T10:00:00Z") });
  assert.ok(r.archived); assert.equal(list(historyDir).length, 1);
});

test("clock skew: a clock behind an existing stamp still writes the new copy, and prune never deletes it", () => {
  for (const [keep, expect] of [[2, ["bench-20260930T100000Z.json", "bench-20300101T000000Z.json"]], [1, ["bench-20260930T100000Z.json"]]]) {
    const { benchFile, historyDir } = setup();
    archiveBench({ benchFile, historyDir, now: at("2030-01-01T00:00:00Z") });
    fs.writeFileSync(benchFile, bench({ "s/a": { s: "gone", a: 2 } }));
    const r = archiveBench({ benchFile, historyDir, keep, now: at("2026-09-30T10:00:00Z") });
    assert.ok(r.archived && fs.existsSync(r.archived), "keep " + keep + ": the reported path exists");
    assert.deepEqual(list(historyDir), expect, "keep " + keep + ": at most " + keep + " copies, the new one always among them");
    assert.equal(r.kept, expect.length);
  }
});

test("a directory squatting the newest slot is never read, deleted or counted, and does not stop the copy", () => {
  const { benchFile, historyDir } = setup();
  fs.mkdirSync(path.join(historyDir, "bench-29990101T000000Z.json"), { recursive: true });
  const r = archiveBench({ benchFile, historyDir, keep: 1, now: at("2026-09-30T10:00:00Z") });
  assert.ok(r.archived && fs.statSync(r.archived).isFile());
  assert.equal(fs.statSync(path.join(historyDir, "bench-29990101T000000Z.json")).isDirectory(), true, "the directory survives even at keep 1");
  // and a directory sitting on the very name the new copy would take pushes it to the next suffix
  const b = setup(); fs.mkdirSync(path.join(b.historyDir, "bench-20260930T100000Z.json"), { recursive: true });
  const r2 = archiveBench({ benchFile: b.benchFile, historyDir: b.historyDir, now: at("2026-09-30T10:00:00Z") });
  assert.equal(path.basename(r2.archived), "bench-20260930T100000Z_02.json");
});

test("no free name in the second (the 100th archive): a reason, no throw, nothing deleted", () => {
  const { benchFile, historyDir } = setup();
  fs.mkdirSync(historyDir, { recursive: true });
  const names = ["bench-20260930T100000Z.json", ...Array.from({ length: 98 }, (_, i) => "bench-20260930T100000Z_" + String(i + 2).padStart(2, "0") + ".json")];
  for (const n of names) fs.writeFileSync(path.join(historyDir, n), "x");
  const r = archiveBench({ benchFile, historyDir, keep: 1, now: at("2026-09-30T10:00:00Z") });
  assert.equal(r.archived, null);
  assert.match(r.reason, /no free history name/);
  assert.equal(list(historyDir).length, 99, "the refusal deleted nothing");
});

test("stale .tmp-* debris of a history name is removed at archive time; nothing else with a tmp look is", () => {
  const { benchFile, historyDir } = setup();
  fs.mkdirSync(historyDir, { recursive: true });
  const debris = ["bench-20260101T000000Z.json.tmp-1234", "bench-20260101T000000Z_02.json.tmp-9"];
  const keepers = ["bench-2026.json.tmp-1", "notes.json.tmp-5", "bench-20260101T000000Z.json.tmp-abc", "other.tmp-1"];
  for (const f of [...debris, ...keepers]) fs.writeFileSync(path.join(historyDir, f), "x");
  archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00Z") });
  for (const f of debris) assert.equal(fs.existsSync(path.join(historyDir, f)), false, f);
  for (const f of keepers) assert.equal(fs.existsSync(path.join(historyDir, f)), true, f);
});

// ------------------------------------------------------------------ the CLI

test("--keep-history: default 30, a positive integer is taken, 0 / negative / fractional / non-numeric / missing are errors", () => {
  assert.equal(DEFAULTS.keepHistory, 30);
  assert.equal(parseArgs([]).keepHistory, 30);
  assert.equal(parseArgs(["--keep-history", "5"]).keepHistory, 5);
  assert.equal(parseArgs(["--keep-history", "1"]).error, undefined);
  for (const argv of [["--keep-history", "0"], ["--keep-history", "-2"], ["--keep-history", "1.5"], ["--keep-history", "abc"], ["--keep-history"]]) {
    assert.match(parseArgs(argv).error ?? "", /--keep-history needs an integer of at least 1/, JSON.stringify(argv));
  }
  assert.ok(parseArgs(["--no-history"]).error, "--no-history is deliberately not offered");
});

const cap = async (fn) => {
  const err = [], log = [], e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { code: await fn(), err, log }; } finally { console.error = e; console.log = l; }
};
const none = () => [];
const leaky = { schema: BENCH_SCHEMA, generatedAt: "x", models: {
  "s/a": { s: "auth", a: 1, m: "sambanova: Incorrect API key provided: 7f3a9c*****e21d." }, "o/b": { s: "ok", a: 1, t: 5, p: "hi" } } };
const cli = () => {
  const { dir, benchFile, historyDir } = setup(JSON.stringify(leaky));
  return { dir, benchFile, historyDir, deps: { benchFile, logFile: path.join(dir, "bench.jsonl"), lockFile: path.join(dir, "bench.lock"), findRunning: none } };
};

test("--reclassify-notices --dry creates no history directory", async () => {
  const { historyDir, deps } = cli();
  const out = await cap(() => main(["--reclassify-notices", "--dry"], deps));
  assert.equal(out.code, 0);
  assert.equal(fs.existsSync(historyDir), false);
  assert.equal(out.log.some((l) => /history/.test(l)), false);
});

test("the history copy is REDACTED: no key fragment, measurements and statuses identical to the source", () => {
  const { benchFile, historyDir } = setup(JSON.stringify(leaky));
  const r = archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00Z") });
  const copy = fs.readFileSync(r.archived, "utf8");
  assert.equal(/7f3a9c|e21d/.test(copy), false, "the masked key fragment is gone from the copy");
  assert.equal(/7f3a9c/.test(fs.readFileSync(benchFile, "utf8")), true, "and the source really did hold it");
  const src = leaky.models, got = JSON.parse(copy);
  assert.equal(got.schema, leaky.schema); assert.equal(got.generatedAt, leaky.generatedAt);
  for (const k of Object.keys(src)) {
    const { m: sm, ...srcRest } = src[k]; const { m: gm, ...gotRest } = got.models[k];
    assert.deepEqual(gotRest, srcRest, k + ": every measurement and status is untouched");
    if (sm) assert.match(gm, /Incorrect API key provided/, "the readable sentence stays");
  }
});

test("a bench.json that needs no redaction (compact JSON, as the tool writes it) is copied identically", () => {
  const { benchFile, historyDir } = setup();
  const r = archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00Z") });
  assert.equal(fs.readFileSync(r.archived, "utf8"), fs.readFileSync(benchFile, "utf8"));
});

test("the identical-skip compares the REDACTED content: a leaky source is not re-archived every run", () => {
  const { benchFile, historyDir } = setup(JSON.stringify(leaky));
  assert.ok(archiveBench({ benchFile, historyDir, now: at("2026-09-30T10:00:00Z") }).archived);
  const again = archiveBench({ benchFile, historyDir, now: at("2026-09-30T11:00:00Z") });
  assert.equal(again.archived, null); assert.ok(again.unchanged);
});

test("--redact: the history copy holds no key fragment, and equals what bench.json becomes", async () => {
  const { benchFile, historyDir, deps } = cli();
  const before = fs.readFileSync(benchFile, "utf8");
  const out = await cap(() => main(["--redact"], deps));
  assert.equal(out.code, 0);
  const files = list(historyDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^bench-\d{8}T\d{6}Z\.json$/);
  const copy = fs.readFileSync(path.join(historyDir, files[0]), "utf8");
  assert.equal(/7f3a9c/.test(copy), false, "never less redacted than the file the run produces");
  assert.notEqual(before, fs.readFileSync(benchFile, "utf8"), "bench.json was rewritten");
  assert.equal(copy, fs.readFileSync(benchFile, "utf8"), "after --redact, bench.json and the copy carry the same text");
  assert.match(out.log.join("\n"), new RegExp("bench: history saved -> bench-history/" + files[0].replace(".", "\\.") + " \\(kept 1 of 1\\)"));
  const again = await cap(() => main(["--redact"], deps));
  assert.match(again.log.join("\n"), /bench: history unchanged \(identical to bench-\d{8}T\d{6}Z\.json\)/);
  assert.equal(list(historyDir).length, 1, "a second run with nothing new adds nothing");
});

test("a run with no bench.json yet prints a quiet info line, not a warning", async () => {
  const { dir, benchFile, historyDir } = setup(null);
  const out = await cap(() => main(["--redact"], { benchFile, logFile: path.join(dir, "bench.jsonl"), lockFile: path.join(dir, "bench.lock"), findRunning: none, historyDir }));
  assert.equal(out.err.filter((l) => /history/.test(l)).length, 0);
  assert.equal(fs.existsSync(historyDir), false);
  // --redact itself then refuses (nothing to redact); the history line is what matters here
  assert.match(out.log.join("\n"), /bench: history skipped \(no bench\.json yet\)/);
});

test("a real --reclassify-notices saves one history copy first", async () => {
  const { benchFile, historyDir, deps } = cli();
  fs.writeFileSync(benchFile, JSON.stringify({ schema: BENCH_SCHEMA, generatedAt: "x", models: { "s/a": { s: "ok", a: 1, t: 5, p: "Error: quota exceeded" } } }));
  const before = fs.readFileSync(benchFile, "utf8");
  const out = await cap(() => main(["--reclassify-notices"], deps));
  assert.equal(out.code, 0);
  const files = list(historyDir);
  assert.equal(files.length, 1);
  assert.equal(fs.readFileSync(path.join(historyDir, files[0]), "utf8"), before);
  assert.notEqual(fs.readFileSync(benchFile, "utf8"), before);
});

test("--compact saves one history copy first (a fake snapshot, temp files)", async () => {
  const { dir, benchFile, historyDir, deps } = cli();
  fs.writeFileSync(path.join(dir, "bench.jsonl"), JSON.stringify({ key: "o/b", s: "ok", a: 2, t: 9 }) + "\n");
  const snapshot = { ok: true, snap: { rows: [{ provider: "s", models: [{ id: "a", routable: true }] }, { provider: "o", models: [{ id: "b", routable: true }] }] } };
  const out = await cap(() => main(["--compact", "--keep-history", "2"], { ...deps, snapshot }));
  assert.equal(out.code, 0);
  const files = list(historyDir);
  assert.equal(files.length, 1);
  const copy = JSON.parse(fs.readFileSync(path.join(historyDir, files[0]), "utf8"));
  assert.equal(copy.models["o/b"].a, 1, "the copy is bench.json BEFORE the log was folded in");
  assert.equal(/7f3a9c/.test(JSON.stringify(copy)), false, "and it is redacted");
  assert.equal(JSON.parse(fs.readFileSync(benchFile, "utf8")).models["o/b"].a, 2, "the log was folded in after the copy");
  assert.equal(fs.readFileSync(path.join(dir, "bench.jsonl"), "utf8"), "");
});

test("a failing history does not fail the run: one warning line, the work still happens", async () => {
  const { dir, benchFile, deps } = cli();
  const blocker = path.join(dir, "blocker"); fs.writeFileSync(blocker, "not a directory");
  const out = await cap(() => main(["--redact"], { ...deps, historyDir: path.join(blocker, "bench-history") }));
  assert.equal(out.code, 0);
  assert.equal(out.err.filter((l) => /history/.test(l)).length, 1);
  assert.match(out.err.join("\n"), /bench: warning: history not saved \(.+\); continuing/);
  assert.match(out.log.join("\n"), /bench: redacted 1 of 2 record\(s\)/);
  assert.equal(/7f3a9c/.test(fs.readFileSync(benchFile, "utf8")), false);
  const scan = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of scan(dir)) assert.equal(/7f3a9c/.test(fs.readFileSync(f, "utf8")), false, "no fragment anywhere: " + f);
});

test("--keep-history 0 and a non-numeric value are refused with exit 2 before anything happens", async () => {
  const { historyDir, deps } = cli();
  for (const v of ["0", "many"]) {
    const out = await cap(() => main(["--redact", "--keep-history", v], deps));
    assert.equal(out.code, 2);
    assert.match(out.err.join("\n"), /bench: --keep-history needs an integer of at least 1/);
  }
  assert.equal(fs.existsSync(historyDir), false);
});

test("--keep-history N prunes the CLI's history to N", async () => {
  const { benchFile, historyDir, deps } = cli();
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(benchFile, bench({ "s/a": { s: "ok", a: i + 1, m: "x" } }));
    await cap(() => main(["--redact", "--keep-history", "2"], { ...deps, now: at(`2026-09-30T0${i}:00:00Z`) }));
  }
  assert.deepEqual(list(historyDir), ["bench-20260930T010000Z.json", "bench-20260930T020000Z.json"]);
});

test("--live saves history after the plan is printed and before the log is opened (source order)", () => {
  // BRITTLE BY DESIGN. main --live needs the real gateway settings and /health, and this project adds no
  // injection seam for that, so the only test of the live path's ordering is the source text itself: the last
  // saveHistory call in runMain (the live one; the compact one is earlier) must come after the plan print
  // and before the log writer is created, the first write. If this fails after a refactor, move the call, not the test.
  const src = fs.readFileSync(new URL("../refresh/bench-cli.mjs", import.meta.url), "utf8");
  const save = src.lastIndexOf("saveHistory(o, deps)");
  const plan = src.lastIndexOf("printPlan(sum, o, fresh, gw");
  const writer = src.indexOf("createLogWriter()");
  assert.ok(save > 0 && plan > 0 && writer > 0, "all three anchors exist");
  assert.ok(plan < save, "after the plan print (so a refused start archives nothing)");
  assert.ok(save < writer, "before the first write");
  assert.ok(src.indexOf("acquireLock", src.indexOf("if (o.live)")) < save, "after the sweep lock is taken");
});

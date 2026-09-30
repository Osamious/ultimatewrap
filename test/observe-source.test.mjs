// Live status C3, section A: the read-only usage feed. Every test builds a TEMP sqlite with the router's column names and a
// TEMP state directory; the real router data and the real state/ are never opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main as cliMain } from "../refresh/observe-cli.mjs";
import { runCatchup, openUsage, failureSql, readFailureText, observePaths, readOverlay } from "../refresh/observe.mjs";
import { usageDb as routerUsageDb, requestLogsDb as routerLogsDb } from "../menu/ccr-client.mjs";
import { mkTmp, buildUsage, writeSnapshot, NOW, iso } from "./fixtures/observe-fixture.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function env({ logs = true, dropColumn = null } = {}) {
  const t = mkTmp();
  writeSnapshot(t.snapshotFile, { prov: ["m1", "m2", "m3"], other: ["x"] });
  const u = buildUsage(t.usageDb, { logs, dropColumn });
  const run = (o = {}) => runCatchup({ stateDir: t.stateDir, snapshotFile: t.snapshotFile, usageDb: t.usageDb, logsDb: t.logsDb, nowMs: NOW, bake: null, spawn: () => { throw new Error("no spawn in this test"); }, ...o });
  return { ...t, u, run, P: observePaths(t.stateDir) };
}

test("a missing database is a value, not a throw, and creates nothing when it never worked", async () => {
  const e = env();
  const r = await e.run({ usageDb: path.join(e.dir, "nope.sqlite") });
  assert.equal(r.ok, true);
  assert.equal(r.feed, "unavailable:missing");
  assert.equal(fs.existsSync(e.P.overlay), false);
  assert.deepEqual(openUsage({ usageDb: path.join(e.dir, "nope.sqlite") }), { ok: false, feed: "unavailable:missing" });
});

test("a missing usage column fails soft: the feed says schema, the existing overlay keeps its records and watermark", async () => {
  const e = env();
  e.u.insert({});
  await e.run();                                        // first run: watermark at max(id)
  e.u.insert({ status_code: 429, request_id: "r-a" });
  const good = await e.run();
  const before = readOverlay(e.P.overlay);
  assert.equal(good.wouldWrite.length, 1);
  e.u.close();
  const bad = env({ dropColumn: "status_code" });
  bad.u.insert({});
  fs.copyFileSync(e.P.overlay, bad.P.overlay);
  const r = await bad.run();
  assert.equal(r.feed, "unavailable:schema");
  assert.deepEqual(r.missing, ["status_code"]);
  const after = readOverlay(bad.P.overlay);
  assert.equal(after.feed, "unavailable:schema");
  assert.deepEqual(after.models, before.models, "records untouched");
  assert.deepEqual(after.wm, before.wm, "watermark untouched");
});

test("a schema problem with no overlay yet still writes the status, so the picker can say so", async () => {
  const e = env({ dropColumn: "duration_ms" });
  const r = await e.run();
  assert.equal(r.feed, "unavailable:schema");
  assert.equal(readOverlay(e.P.overlay).feed, "unavailable:schema");
});

test("no request_logs table: the feed stays ok and failures classify from the status alone", async () => {
  const e = env({ logs: false });
  e.u.insert({});
  await e.run();
  e.u.insert({ status_code: 429, request_id: "r-1" });
  const r = await e.run();
  assert.equal(r.feed, "ok");
  assert.equal(r.msgSource, "none");
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].m, "HTTP 429 (provider message not kept)");
});

test("the message source may be the router's separate request-log file", async () => {
  const e = env({ logs: false });
  const other = buildUsage(e.logsDb, { logs: true });
  other.log("r-9", { body: JSON.stringify({ error: { message: "Insufficient credits. Please top up." } }) });
  other.close();
  e.u.insert({});
  await e.run();
  e.u.insert({ status_code: 429, request_id: "r-9" });
  const r = await e.run();
  assert.equal(r.msgSource, "request-log-db");
  const rec = readOverlay(e.P.overlay).models["prov/m1"];
  assert.equal(rec.s, "pay", "the decisive words come from the message");
});

test("the watermark advances over rows that are excluded (probe traffic, ignorable 400s, unknown models)", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  e.u.insert({ client: "uw-probe", status_code: 429 });
  e.u.insert({ status_code: 400, request_id: "r-400" });
  e.u.insert({ model: "not-a-route" });
  const r = await e.run();
  assert.equal(r.examined, 3);
  assert.equal(r.wm.id, 4);
  assert.equal(r.wouldWrite.length, 0);
  assert.equal(r.skip.probe, 1);
  assert.equal(r.skip.ignored400, 1);
  assert.equal(r.skip.unknownKey, 1);
  const again = await e.run();
  assert.equal(again.examined, 0, "nothing is read twice");
});

test("5,001 rows are read as two batches: none read twice, none skipped", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  e.u.db.exec("begin");
  for (let i = 0; i < 5001; i++) e.u.insert({ request_id: `bulk-${i}` });
  e.u.db.exec("commit");
  const r = await e.run();
  assert.equal(r.examined, 5001);
  assert.equal(r.wm.id, 5002);
  assert.equal((await e.run()).examined, 0);
});

test("a budget stop resumes exactly at the saved id", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  for (let i = 0; i < 25; i++) e.u.insert({ request_id: `b-${i}` });
  let t = 0;
  const first = await e.run({ batchSize: 10, budgetMs: 100, clock: () => (t += 1000) });
  assert.equal(first.examined, 10, "one batch, then the budget is spent");
  assert.equal(first.wm.id, 11);
  const second = await e.run({ batchSize: 10 });
  assert.equal(second.examined, 15, "the rest, no row twice");
  assert.equal(second.wm.id, 26);
});

test("first run with no tagged rows starts at max(id): history is not read", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) e.u.insert({ status_code: 429 });
  const r = await e.run();
  assert.equal(r.examined, 0);
  assert.equal(r.wm.id, 5);
  assert.equal(r.wouldWrite.length, 0);
  assert.equal(r.tagId, null);
});

test("first run with tagged rows starts at the first tagged id inside the window", async () => {
  const e = env();
  const at = (days) => iso(NOW - days * 86400000);
  e.u.insert({ created_at: at(9) });                       // old history: never read
  e.u.insert({ created_at: at(2), status_code: 429 });     // before the first tag: not read
  e.u.insert({ created_at: at(2), client: "uw-probe" });   // id 3: the tag epoch
  e.u.insert({ created_at: at(1), status_code: 429, request_id: "after" });
  const r = await e.run();
  assert.equal(r.tagId, 3);
  assert.equal(r.examined, 2, "the tagged row itself (skipped as probe) and the row after it");
  assert.equal(r.wouldWrite.length, 1);
  assert.equal(r.wouldWrite[0].s, "rate");
});

test("an explicit backfill window starts at the first row inside it, tags or not", async () => {
  const e = env();
  e.u.insert({ created_at: iso(NOW - 9 * 86400000) });
  e.u.insert({ created_at: iso(NOW - 2 * 86400000), status_code: 429 });
  e.u.insert({ created_at: iso(NOW - 1 * 86400000), status_code: 403, request_id: "z" });
  const r = await e.run({ backfillDays: 3, dry: true });
  assert.equal(r.examined, 2);
});

test("a reset table (ids restart) re-initialises the watermark and keeps the overlay", async () => {
  const e = env();
  for (let i = 0; i < 3; i++) e.u.insert({});
  await e.run();
  e.u.insert({ status_code: 429, request_id: "keep" });
  await e.run();
  e.u.db.exec("delete from usage_events; delete from sqlite_sequence");
  e.u.insert({});
  const r = await e.run();
  assert.equal(r.reset, true);
  assert.equal(r.wm.id, 1, "started again at the current last row");
  assert.equal(Object.keys(readOverlay(e.P.overlay).models).length, 1);
});

test("the handle is read-only: a write through it throws", () => {
  const e = env();
  const h = openUsage({ usageDb: e.usageDb });
  assert.equal(h.ok, true);
  assert.throws(() => h.db.exec("create table x (a)"));
  assert.throws(() => h.db.prepare("insert into usage_events (created_at) values ('x')").run());
  h.close();
});

test("--dry writes nothing: no overlay, no run file, no lock, no temp file", async () => {
  const e = env();
  e.u.insert({});
  await e.run({ dry: true });
  e.u.insert({ status_code: 429 });
  const r = await e.run({ dry: true });
  assert.equal(r.wrote, false);
  assert.deepEqual(fs.readdirSync(e.stateDir), []);
});

test("a held lock makes a second run skip cleanly", async () => {
  const e = env();
  e.u.insert({});
  fs.writeFileSync(e.P.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 }));
  const r = await e.run({ nowMs: Date.now() });
  assert.equal(r.skipped, "locked");
  assert.equal(fs.existsSync(e.P.overlay), false);
});

test("a normal run leaves no lock and no temp debris behind", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  assert.deepEqual(fs.readdirSync(e.stateDir).sort(), ["observed.json", "observed.run"]);
});

test("UW_CCR_DATA_DIR redirects the usage and request-log database paths", () => {
  assert.equal(routerUsageDb({ UW_CCR_DATA_DIR: "X:/tmp/d" }), path.join("X:/tmp/d", "usage.sqlite"));
  assert.equal(routerLogsDb({ UW_CCR_DATA_DIR: "X:/tmp/d" }), path.join("X:/tmp/d", "request-logs.sqlite"));
  const r = spawnSync(process.execPath, ["--no-warnings", "-e",
    `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "menu", "ccr-client.mjs")).href)}).then((m) => console.log(m.CONTRACT.usageDb))`],
  { env: { ...process.env, UW_CCR_DATA_DIR: "X:/tmp/dd" }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), path.join("X:/tmp/dd", "usage.sqlite"));
});

test("observe.mjs names none of the five CCR/Claude path needles", () => {
  for (const f of ["observe.mjs", "observe-cli.mjs"]) {
    const body = fs.readFileSync(path.join(ROOT, "refresh", f), "utf8");
    for (const n of [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/]) assert.doesNotMatch(body, n, `${f} ${n}`);
  }
});

test("importing the engine and opening the database prints no ExperimentalWarning, even without --no-warnings", () => {
  const e = env();
  e.u.close();
  const src = `import(${JSON.stringify(pathToFileURL(path.join(ROOT, "refresh", "observe.mjs")).href)}).then((m) => { const h = m.openUsage({ usageDb: ${JSON.stringify(e.usageDb)} }); console.log(h.ok); h.close?.(); })`;
  const r = spawnSync(process.execPath, ["-e", src], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), "true");
  assert.equal(r.stderr, "");
});

// --------------------------------------------------------------- the body column (privacy, plan F)

test("the failure statement extracts inside SQLite behind json_valid, and only the named scalars leave it", () => {
  const sql = failureSql(2);
  assert.match(sql, /json_valid\(response_body_text\)/);
  assert.match(sql, /json_extract\(response_body_text, '\$\.error\.message'\)/);
  for (const bad of [/request_body_text/, /request_headers/, /response_headers/, /credential/, /\bselect\s+\*/i, /\burl\b/]) assert.doesNotMatch(sql, bad);
});

test("no substr of a body column exists anywhere under refresh/, and every response_body_text mention is inside json_valid/json_extract or the column list", () => {
  for (const f of fs.readdirSync(path.join(ROOT, "refresh")).filter((n) => n.endsWith(".mjs"))) {
    const body = fs.readFileSync(path.join(ROOT, "refresh", f), "utf8");
    assert.doesNotMatch(body, /substr\s*\(\s*response_body_text/i, f);
    assert.doesNotMatch(body, /request_body_text/, `${f} must never name the request body`);
    if (f !== "observe.mjs") { assert.doesNotMatch(body, /response_body_text/, f); continue; }
    const rest = body.replace(/json_valid\(response_body_text\)/g, "").replace(/json_extract\(response_body_text, /g, "")
      .replace(/const LOG_COLS = \[[^\]]*\];/, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(rest, /response_body_text/, "an uncovered mention of the body column");
  }
});

test("a body that embeds model output, or is cut mid-JSON, never reaches a stored record", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  const google = JSON.stringify({ error: { message: "quota exceeded for this project", code: 429 }, candidates: [{ content: { parts: [{ text: "MODEL-OUTPUT-SECRET" }] } }] });
  const cut = `{"error":{"message":"half a json with MODEL-OUTPUT-SECRET`;
  e.u.insert({ status_code: 429, request_id: "g1", model: "m1" });
  e.u.log("g1", { body: google });
  e.u.insert({ status_code: 500, request_id: "c1", model: "m2" });
  e.u.log("c1", { body: cut });
  const r = await e.run();
  const models = readOverlay(e.P.overlay).models;
  assert.equal(models["prov/m1"].m, "quota exceeded for this project");
  assert.equal(r.skip.pending, 1, "the cut body is a first ambiguous failure with no message");
  const dump = JSON.stringify(fs.readFileSync(e.P.overlay, "utf8")) + JSON.stringify(fs.readFileSync(e.P.run, "utf8"));
  assert.doesNotMatch(dump, /MODEL-OUTPUT-SECRET|USER-PROMPT-SECRET/);
});

test("readFailureText returns short scalars, tolerates invalid JSON and an unreadable log", () => {
  const e = env();
  e.u.log("a", { body: JSON.stringify({ error: { message: "M", code: "c", type: "t", status: "S" } }), error: "gw" });
  e.u.log("b", { body: "not json {" });
  e.u.close();
  const h = openUsage({ usageDb: e.usageDb });
  const m = readFailureText(h.logs, ["a", "b", "none"]);
  assert.deepEqual(m.get("a"), { msg: "M", code: "c", typ: "t", st: "S", error: "gw", gerr: "" });
  assert.deepEqual(m.get("b"), { msg: "", code: "", typ: "", st: "", error: "", gerr: "" });
  assert.equal(m.has("none"), false);
  h.close();
  assert.equal(readFailureText(null, ["a"]).size, 0);
});

// --------------------------------------------------------------- review round

test("an overlay that cannot be READ (not merely absent) skips the run: no first-run reset, no lost records, the reason is in observed.run", async () => {
  const e = env();
  e.u.insert({});
  await e.run();
  e.u.insert({ status_code: 429, request_id: "r-a" });
  await e.run();
  const good = fs.readFileSync(e.P.overlay, "utf8");
  fs.rmSync(e.P.overlay);
  fs.mkdirSync(e.P.overlay);                                   // reading a directory fails with EISDIR: unreadable, not missing
  e.u.insert({ status_code: 429, request_id: "r-b", model: "m2" });
  const r = await e.run();
  assert.equal(r.skipped, "overlay-unreadable");
  const run = JSON.parse(fs.readFileSync(e.P.run, "utf8"));
  assert.equal(run.reason, "overlay-unreadable");
  assert.match(run.error, /overlay-unreadable: EISDIR/);
  fs.rmdirSync(e.P.overlay);
  fs.writeFileSync(e.P.overlay, good);
  const after = await e.run();
  assert.equal(after.examined, 1, "the watermark was never reset: only the new row is read");
  assert.equal(Object.keys(readOverlay(e.P.overlay).models).length, 2);
  assert.equal(readOverlay(path.join(e.dir, "does-not-exist.json")), null, "a MISSING file is still a first run");
});

test("first run with a tagged row but nothing in the last 3 days starts at the end, not at the old tag", async () => {
  const e = env();
  const old = (d) => iso(NOW - d * 86400000);
  e.u.insert({ created_at: old(9), client: "uw-probe" });
  e.u.insert({ created_at: old(9), status_code: 429, request_id: "old-fail" });
  const r = await e.run();
  assert.equal(r.wm.id, 2);
  assert.equal(r.examined, 0);
  assert.equal(r.tagId, 1);
});

test("SQL bounds: the size column gates every parse, an oversized body is never parsed, and only 200 failing ids are read per run", async () => {
  const sql = failureSql(1);
  assert.equal((sql.match(/response_body_size_bytes <= 262144 and json_valid\(response_body_text\)/g) ?? []).length, 4);
  assert.match(sql, /case when .* then json_extract\(response_body_text, '\$\.error\.message'\) end/);
  const e = env();
  e.u.insert({});
  await e.run();
  e.u.insert({ status_code: 429, request_id: "big" });
  e.u.log("big", { body: JSON.stringify({ error: { message: "should not be read" } }), size: 300000 });
  await e.run();
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].m, "HTTP 429 (provider message not kept)");

  const f = env();
  f.u.insert({});
  await f.run();
  f.u.db.exec("begin");
  for (let i = 0; i < 250; i++) { f.u.insert({ status_code: 429, request_id: `many-${i}`, model: "m1" }); f.u.log(`many-${i}`, { body: JSON.stringify({ error: { message: `sentence ${i}` } }) }); }
  f.u.db.exec("commit");
  await f.run();
  // one key, 250 events: the last one wins. Its text was beyond the 200-id cap, so it has the fixed text; the cap is per run.
  assert.equal(readOverlay(f.P.overlay).models["prov/m1"].m, "HTTP 429 (provider message not kept)");
  const g = env();
  g.u.insert({});
  await g.run();
  for (let i = 0; i < 150; i++) { g.u.insert({ status_code: 429, request_id: `few-${i}`, model: "m1" }); g.u.log(`few-${i}`, { body: JSON.stringify({ error: { message: `sentence ${i}` } }) }); }
  await g.run();
  assert.equal(readOverlay(g.P.overlay).models["prov/m1"].m, "sentence 149");
});

test("a damaged overlay heals: pend null, conf an array and confDay a number are replaced by empty containers, and the run completes", async () => {
  const e = env();
  e.u.insert({});
  fs.writeFileSync(e.P.overlay, JSON.stringify({ schema: 1, writtenAt: iso(NOW), feed: "ok", wm: null, tagId: null, models: {}, pend: null, conf: [], confDay: 5 }));
  await e.run();
  e.u.insert({ status_code: 429, request_id: "heal" });
  const r = await e.run();
  assert.equal(r.ok, true);
  const o = readOverlay(e.P.overlay);
  assert.deepEqual([o.pend, o.conf, o.confDay], [{}, {}, { d: null, n: 0 }]);
  assert.equal(o.models["prov/m1"].s, "rate");
});

test("a damaged snapshot cannot stop the run from finishing: null rows and models that are not arrays are ignored, observed.run is written", async () => {
  const e = env();
  fs.writeFileSync(e.snapshotFile, JSON.stringify({ schemaVersion: 9, rows: [null, { provider: "prov", keyId: "prov.key", models: 5 }, { provider: "prov", keyId: "k2", models: [null, { id: "m1" }] }, 7, { models: [] }] }));
  e.u.insert({});
  const r = await e.run();
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(e.P.run, "utf8")).ranAt, iso(NOW));
  e.u.insert({ status_code: 429, request_id: "x" });
  await e.run({ bake: (row) => ({ bench: null, benchFlags: null, benchAgeHist: [] }) });
  assert.equal(readOverlay(e.P.overlay).models["prov/m1"].s, "rate");
});

test("EVERY early-exit path of a run still stamps observed.run (the picker's launcher throttles on its mtime); only the kill switch stays silent", async () => {
  const stale = "2020-01-01T00:00:00.000Z";
  const stamp = (e) => fs.writeFileSync(e.P.run, JSON.stringify({ ranAt: stale, error: "kept from before", examined: 7 }));
  const ranAt = (e) => JSON.parse(fs.readFileSync(e.P.run, "utf8"));
  const paths = {
    "database missing": async (e) => e.run({ usageDb: path.join(e.dir, "nope.sqlite") }),
    "schema changed": async () => { const b = env({ dropColumn: "status_code" }); stamp(b); await b.run(); return b; },
    "no usable snapshot": async (e) => { fs.rmSync(e.snapshotFile); return e.run(); },
    "overlay unreadable": async (e) => { fs.mkdirSync(e.P.overlay); return e.run(); },
    "lock busy": async (e) => { fs.writeFileSync(e.P.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: null, maxMinutes: 2 })); return e.run(); },
  };
  for (const [name, go] of Object.entries(paths)) {
    let e = env();
    e.u.insert({});
    stamp(e);
    const out = await go(e);
    if (out && out.P) e = out;
    const run = ranAt(e);
    assert.equal(run.ranAt, iso(NOW), `${name}: ranAt moved`);
  }
  // an early exit keeps what the file said before (the stamp is content-minimal: only ranAt changes)
  const e = env();
  e.u.insert({});
  stamp(e);
  await e.run({ usageDb: path.join(e.dir, "nope.sqlite") });
  assert.equal(ranAt(e).ranAt, iso(NOW));
  // the kill switch: silent, nothing touched (the CLI exits before the engine)
  const k = env();
  stamp(k);
  fs.writeFileSync(k.P.off, "x");
  const before = fs.statSync(k.P.run).mtimeMs;
  const code = await cliMain(["--catchup"], { out() {}, err() {}, stateDir: k.stateDir, snapshotFile: k.snapshotFile, usageDb: k.usageDb, logsDb: k.logsDb, nowMs: NOW, bake: null });
  assert.equal(code, 0);
  assert.equal(fs.statSync(k.P.run).mtimeMs, before);
  assert.equal(ranAt(k).ranAt, stale);
});

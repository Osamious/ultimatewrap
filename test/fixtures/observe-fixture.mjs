// Shared by test/observe-*.test.mjs. Builds a TEMP directory with a hand-made usage.sqlite (the router's column names for
// usage_events and request_logs), a snapshot and a bench.json. It never touches the real router data or the real state/.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { SNAPSHOT_SCHEMA } from "../../menu/snapshot.mjs";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

export const T0 = Date.parse("2026-09-30T10:00:00.000Z");
export const NOW = T0 + 3600_000;
export const iso = (ms) => new Date(ms).toISOString();

// Everything a test file creates is removed when the file's tests end: databases closed first (Windows will not delete an open file),
// then the directory, retried, and an EPERM that survives the retries is ignored (it must not fail a test run).
const madeDirs = new Set();
const openDbs = new Set();
after(() => {
  for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
  for (const dir of madeDirs) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* left for the OS temp cleaner */ } }
});

export function mkTmp(prefix = "uw-observe-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.add(dir);
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  return { dir, stateDir, usageDb: path.join(dir, "usage.sqlite"), logsDb: path.join(dir, "request-logs.sqlite"), snapshotFile: path.join(dir, "snapshot.json"), benchFile: path.join(stateDir, "bench.json") };
}

const USAGE_DDL = `create table usage_events (
  id integer primary key autoincrement, created_at text not null, request_id text, client text, provider text, model text,
  logical_model text, path text, method text, status_code integer, duration_ms integer, input_tokens integer, output_tokens integer,
  credential_id text);
create index idx_usage_created on usage_events(created_at);`;
const LOGS_DDL = `create table request_logs (
  id integer primary key autoincrement, request_id text, source_usage_id integer, status_code integer, error text, gateway_error text,
  request_body_text text, response_body_text text, response_body_size_bytes integer, request_headers text, response_headers text);
create index idx_logs_req on request_logs(request_id);`;

/** A usage database (and, in the same file, a request_logs table unless `logs: false`). Returns handles for inserting. */
export function buildUsage(file, { logs = true, dropColumn = null } = {}) {
  const db = new DatabaseSync(file);
  openDbs.add(db);
  db.exec(dropColumn ? USAGE_DDL.replace(new RegExp(`\\b${dropColumn}\\b[^,]*,`), "") : USAGE_DDL);
  if (logs) db.exec(LOGS_DDL);
  let n = 0;
  const insert = (r) => {
    n += 1;
    const o = { created_at: iso(T0 + n * 1000), request_id: `req-${n}`, client: "Profile: Claude Code", provider: "prov", model: "m1",
                status_code: 200, duration_ms: 500, output_tokens: 10, ...r };
    if (dropColumn) delete o[dropColumn];
    const cols = Object.keys(o);
    db.prepare(`insert into usage_events (${cols.join(",")}) values (${cols.map(() => "?").join(",")})`).run(...cols.map((c) => o[c]));
    return o;
  };
  const log = (requestId, { body = null, error = null, gateway_error = null, status_code = 500, request_body = "USER-PROMPT-SECRET", size = null } = {}) => {
    db.prepare("insert into request_logs (request_id, status_code, error, gateway_error, request_body_text, response_body_text, response_body_size_bytes) values (?,?,?,?,?,?,?)")
      .run(requestId, status_code, error, gateway_error, request_body, body, size ?? Buffer.byteLength(body ?? ""));
  };
  return { db, insert, log, close: () => db.close() };
}

export function writeSnapshot(file, providers) {
  const rows = Object.entries(providers).map(([provider, ids]) => ({ keyId: `${provider}.key`, provider, models: ids.map((id) => (typeof id === "string" ? { id } : id)) }));
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: SNAPSHOT_SCHEMA, generatedAt: iso(T0), builtAt: iso(T0), rows }));
}

export function writeBench(file, models) {
  fs.writeFileSync(file, JSON.stringify({ schema: 1, generatedAt: iso(T0), models }));
}

export const epoch = (ms) => Math.floor(ms / 1000);

/** A whole scratch world: snapshot, usage db, state dir, and `run()` bound to them (the engine's temp-dir seams). */
export async function mkEnv({ providers = { prov: ["m1", "m2", "m3", "m4"], other: ["x"], third: ["y"], anthropic: ["claude-sonnet-5"] }, logs = true } = {}) {
  const { runCatchup, observePaths } = await import("../../refresh/observe.mjs");
  const t = mkTmp();
  writeSnapshot(t.snapshotFile, providers);
  const u = buildUsage(t.usageDb, { logs });
  const spawned = [];
  const spawn = (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { unref() {} }; };
  const run = (o = {}) => runCatchup({ stateDir: t.stateDir, snapshotFile: t.snapshotFile, usageDb: t.usageDb, logsDb: t.logsDb, nowMs: NOW, bake: null, spawn, ...o });
  // The first run only sets the watermark (history is never read), so a test inserts its rows after `init()`.
  const init = async () => { u.insert({ request_id: "seed" }); return run(); };
  return { ...t, u, run, init, spawned, spawn, P: observePaths(t.stateDir) };
}

// Fake secret-shaped strings are BUILT AT RUN TIME, so no source file holds a contiguous token-looking literal (GitHub push protection
// rejects those, even in a test). The sanity test in observe-classify.test.mjs asserts `redactClip` masks every kind.
const body = (unit, n) => unit.repeat(n);
export const fake = (kind) => ({
  sk: () => "sk" + "-" + body("a1B2c3", 7),
  hf: () => "hf" + "_" + body("aB3dE", 7),
  bearer: () => "Bearer " + body("a1B2c3", 6),
  keyed: () => "api_key" + "=" + body("Zz9Yy8", 5),
})[kind]();
/** The part of a fake secret that must never survive redaction (its first 12 characters after any prefix). */
export const fakeCore = (kind) => fake(kind).split(/[ =]/).pop().slice(0, 12);

// C0 spike, run by a HUMAN: does the gateway record `client = uw-probe` for a tagged probe?
//
//   node refresh/spike-client-tag.mjs --only openrouter/laguna-s-2.1:free           dry: says what it would do
//   node refresh/spike-client-tag.mjs --live --only openrouter/laguna-s-2.1:free    ONE real probe
//
// DRY BY DEFAULT. `--live` sends exactly ONE request through the existing `probeOne` (so the tag is whatever `probeOne`
// really sends) for the one named row, then opens the router's usage database READ-ONLY and looks for THAT probe's row:
// a row newer than the pre-probe watermark whose provider and model match the row probed (the model may be stored as
// `provider/id` or as the bare id). Rows from other traffic never end the wait and never confirm anything.
//
// VERDICT (last line) and EXIT CODE:
//   TAG CONFIRMED: client = uw-probe          0   the probe's row carries the tag
//   TAG NOT RECORDED (observed client: X)     3   the probe's row exists with another client
//   INCONCLUSIVE                              4   no matching row appeared within the wait
// Other exits: 1 refusal or failure, 2 bad arguments. It prints at most 5 rows, six columns only (id, created_at,
// provider, model, status_code, client), matching rows first.
//
// Writes nothing: no bench.json, no log, no history copy, no snapshot rebuild. Refuses a row that is not in the
// picker's snapshot, and a row whose worst-case cost is above the economy ceiling ($0.01). Never prints a key.
// The one ExperimentalWarning that node:sqlite prints is swallowed while the module loads; nothing else is filtered.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { gatewayConnection, usageDb, CONTRACT as CCR } from "../menu/ccr-client.mjs";
import { benchKeyOf } from "../menu/bench-data.mjs";
import { buildTargets, probeOne, STREAM_CUT_FACTOR } from "./bench.mjs";
import { ECONOMY_DEFAULTS } from "./bench-cli.mjs";

const MAX_TOKENS = 96;
const TIMEOUT_MS = 45000;
const COLUMNS = ["id", "created_at", "provider", "model", "status_code", "client"];
const REQUEST_ID_HEADERS = ["x-request-id", "request-id"];
const SHOW_ROWS = 5;
const SCAN_ROWS = 500;                 // newest rows examined per poll: bounds the work if other traffic is heavy

export const EXIT = Object.freeze({ CONFIRMED: 0, REFUSED: 1, USAGE: 2, NOT_RECORDED: 3, INCONCLUSIVE: 4 });

export function parseArgs(argv) {
  const o = { live: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--live") o.live = true;
    else if (a === "--only") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) return { error: "--only needs one provider/id" };
      if (!v.includes("/") || v.includes(",") || /\s/.test(v) || v.startsWith("/") || v.endsWith("/")) {
        return { error: `--only takes exactly ONE provider/id, got ${JSON.stringify(v.slice(0, 60))}` };
      }
      o.only = benchKeyOf(v);
    } else return { error: `unrecognised argument ${JSON.stringify(a)}` };
  }
  if (!o.only) return { error: "--only <provider/id> is required (one row; there is no whole-provider mode)" };
  return o;
}

/** Opens the usage database READ-ONLY (never checkpoints, never writes). Throws when it cannot. */
export function openReadOnly(file) {
  // Load node:sqlite with its ExperimentalWarning swallowed, then put emitWarning back exactly as it was.
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(String(warning?.message ?? warning))) return undefined;
    return orig.call(process, warning, ...rest);
  };
  let DatabaseSync;
  try { ({ DatabaseSync } = process.getBuiltinModule("node:sqlite")); } finally { process.emitWarning = orig; }
  const db = new DatabaseSync(file, { readOnly: true, timeout: 250 });
  db.exec("PRAGMA query_only = 1");
  return db;
}

/** `{ ok, maxId }` from a usage database after checking the six columns exist, else `{ ok: false, reason }`. */
export function readWatermark(db) {
  const have = new Set(db.prepare("pragma table_info(usage_events)").all().map((c) => c.name));
  const missing = COLUMNS.filter((c) => !have.has(c));
  if (missing.length) return { ok: false, reason: `usage_events lacks column(s): ${missing.join(", ")}` };
  return { ok: true, maxId: db.prepare("select max(id) as m from usage_events").get()?.m ?? 0 };
}

/** Rows with `id > afterId` (newest SCAN_ROWS of them, oldest first), the six whitelisted columns only. */
export function readSince(db, afterId) {
  return db.prepare(`select ${COLUMNS.join(", ")} from usage_events where id > ? order by id desc limit ?`)
    .all(afterId, SCAN_ROWS).reverse();
}

/** The most recent `n` rows overall, the six whitelisted columns only (context when nothing new arrived). */
export function readLatest(db, n = SHOW_ROWS) {
  return db.prepare(`select ${COLUMNS.join(", ")} from usage_events order by id desc limit ?`).all(n);
}

/** Is `row` a row for the probed target? The model may carry the provider prefix or not. */
export const rowMatches = (row, t) => row.provider === t.provider && (row.model === t.key || row.model === t.id);

/** The verdict for the rows that arrived after the probe. Pure. */
export function verdict(fresh, t) {
  const mine = fresh.filter((r) => rowMatches(r, t));
  if (!mine.length) return { kind: "INCONCLUSIVE", mine };
  if (mine.some((r) => r.client === CCR.probeClient)) return { kind: "CONFIRMED", mine };
  return { kind: "NOT_RECORDED", mine, observed: mine[mine.length - 1].client };
}

const fmtRow = (r) => COLUMNS.map((c) => String(r[c] ?? "")).join("  ");

/**
 * `deps` exists for tests: `snapshot`, `gateway`, `fetchImpl`, `usageFile`, `openDb`, `waitMs`, `pollMs`, `out`, `err`.
 * Returns the exit code (see EXIT).
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const o = parseArgs(argv);
  if (o.error) { err(`spike: ${o.error}`); return EXIT.USAGE; }

  const loaded = deps.snapshot ?? loadSnapshot();
  if (!loaded.ok) { err(`spike: no usable snapshot (${loaded.reason}) -- run: node menu/snapshot.mjs --build`); return EXIT.REFUSED; }
  const targets = [...buildTargets(loaded.snap, { only: [o.only], maxTokens: STREAM_CUT_FACTOR * MAX_TOKENS }).values()].flat();
  if (targets.length !== 1) {
    err(`spike: ${o.only} is not a probeable row of the current snapshot (unknown, non-text or unroutable); nothing was sent`);
    return EXIT.REFUSED;
  }
  const t = targets[0];
  const worst = t.worst ?? t.cost;
  if (!t.free && worst > ECONOMY_DEFAULTS.maxRowCost) {
    err(`spike: ${o.only} costs up to $${worst.toFixed(4)} per probe, above the $${ECONOMY_DEFAULTS.maxRowCost} ceiling; refusing. Pick a free or cheaper row.`);
    return EXIT.REFUSED;
  }

  const usageFile = deps.usageFile === undefined ? usageDb() : deps.usageFile;
  const tag = `${CCR.clientHeader}: ${CCR.probeClient}`;
  if (!o.live) {
    const gw = deps.gateway === undefined ? gatewayConnection({ run: () => "-" }) : deps.gateway;   // presence check: nothing is executed
    out(`spike: dry run. Would send ONE probe to ${t.key} (${t.free ? "free" : `worst case $${worst.toFixed(4)}`}, max_tokens ${MAX_TOKENS}) carrying the header "${tag}".`);
    out(`  gateway settings: ${gw ? "found (loopback)" : "NOT FOUND -- a live run would refuse"}`);
    out(`  then read-only: ${usageFile ?? "router data folder NOT FOUND"}${usageFile ? ` (${fs.existsSync(usageFile) ? "present" : "NOT FOUND"})` : ""}, rows newer than the probe, columns ${COLUMNS.join(", ")}`);
    out("spike: no request was made. Add --live to send it.");
    return 0;
  }

  const gw = deps.gateway === undefined ? gatewayConnection() : deps.gateway;
  if (!gw) { err("spike: cannot find the gateway address or its key in Claude Code's settings; nothing was sent"); return EXIT.REFUSED; }
  if (!usageFile) { err("spike: router data not found (no app-data folder); nothing was sent"); return EXIT.REFUSED; }
  let db, before;
  try {
    db = (deps.openDb ?? openReadOnly)(usageFile);
    before = readWatermark(db);
  } catch (e) { try { db?.close(); } catch { /* ignore */ } err(`spike: cannot open the usage database read-only (${e?.code ?? e?.message}); nothing was sent`); return EXIT.REFUSED; }
  if (!before.ok) { try { db.close(); } catch { /* ignore */ } err(`spike: ${before.reason}; nothing was sent`); return EXIT.REFUSED; }

  try {
    let requestId = null;
    const realFetch = deps.fetchImpl ?? fetch;
    const fetchImpl = async (...a) => {
      const res = await realFetch(...a);
      for (const h of REQUEST_ID_HEADERS) { const v = res?.headers?.get?.(h); if (v && !requestId) requestId = String(v).slice(0, 80); }
      return res;
    };
    out(`spike: sending ONE tagged probe to ${t.key} ...`);
    const r = await probeOne({ fetchImpl, url: `${gw.base}/v1/messages`, key: gw.key, model: t.key, maxTokens: MAX_TOKENS, timeoutMs: TIMEOUT_MS });
    out(`spike: observed status ${r.s}${r.http ? ` (HTTP ${r.http})` : ""}, ttft ${r.t ?? "n/a"} ms, total ${r.d ?? "n/a"} ms, request id ${requestId ?? "not exposed by the gateway response"}`);

    // The usage row is written after the response completes. Poll until a row for THIS target (newer than the pre-probe
    // watermark) shows up or the wait ends; rows from other traffic neither end the wait nor count.
    const waitMs = deps.waitMs ?? 8000, pollMs = deps.pollMs ?? 250;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    let fresh = readSince(db, before.maxId);
    for (let waited = 0; !fresh.some((row) => rowMatches(row, t)) && waited < waitMs; waited += pollMs) {
      await sleep(pollMs);
      fresh = readSince(db, before.maxId);
    }
    const v = verdict(fresh, t);
    // At most SHOW_ROWS rows: this probe's rows first, then the newest others; with nothing new, the latest rows for context.
    const shown = fresh.length
      ? [...v.mine.slice().reverse(), ...fresh.filter((row) => !v.mine.includes(row)).reverse()].slice(0, SHOW_ROWS)
      : readLatest(db);
    out(fresh.length ? `usage rows since the probe (${fresh.length} new; this probe's first, at most ${SHOW_ROWS} shown):` : `no new usage row; the latest ${shown.length} for context:`);
    out(`  ${COLUMNS.join("  ")}`);
    for (const row of shown) out(`  ${fmtRow(row)}`);
    if (v.kind === "CONFIRMED") { out(`TAG CONFIRMED: client = ${CCR.probeClient}`); return EXIT.CONFIRMED; }
    if (v.kind === "NOT_RECORDED") { out(`TAG NOT RECORDED (observed client: ${v.observed ?? "(none)"})`); return EXIT.NOT_RECORDED; }
    out(`INCONCLUSIVE: no usage row for ${t.key} appeared within ${waitMs} ms of the probe`);
    return EXIT.INCONCLUSIVE;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; },
              (e) => { console.error(`spike: ${e?.message ?? e}`); process.exitCode = 1; });
}

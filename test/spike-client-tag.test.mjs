// C0 spike helper: argument validation, dry mode, and the live verdict logic. A fake snapshot, a fake gateway, a fake
// fetch and a temp sqlite only: no real request, no real router database, no real state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, main, readWatermark, readSince, openReadOnly, verdict, rowMatches, EXIT } from "../refresh/spike-client-tag.mjs";

const M = (id, over = {}) => ({ id, pin: 0, pout: 0, badge: "FREE", outputKind: "text", routable: true, ...over });
const snapshot = { ok: true, snap: { rows: [
  { provider: "or", models: [M("free-a"), M("dear", { pin: 100, pout: 500, badge: "PAID" }), M("img", { outputKind: "nontext" })] },
] } };
const GW = { base: "http://gw.test", key: "SECRET-KEY-VALUE" };
const PROBE = "uw-probe", REAL = "Profile: Claude Code";

const capture = () => { const lines = [], errs = []; return { lines, errs, out: (s) => lines.push(s), err: (s) => errs.push(s) }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A temp usage database; the writable handle is closed and the folder removed when the test ends. */
const tmpDb = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-spike-"));
  const file = path.join(dir, "usage.sqlite");
  const db = new DatabaseSync(file);
  db.exec("create table usage_events (id integer primary key, created_at text, request_id text, client text, provider text, model text, status_code integer, duration_ms integer, output_tokens integer, secret_body text)");
  t.after(() => { try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, db };
};
const insert = (db, r) => db.prepare("insert into usage_events (created_at, request_id, client, provider, model, status_code, duration_ms, output_tokens, secret_body) values (?,?,?,?,?,?,?,?,?)")
  .run("2026-09-30T10:00:00Z", "reqid-hidden", r.client, r.provider ?? "or", r.model ?? "or/free-a", r.status ?? 200, 100, 5, "PRIVATE BODY TEXT");

const sseBody = () => new TextEncoder().encode(
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello there my friend" } })}\n\n` +
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`);
/** A gateway whose 200 answer streams one greeting; `onCall(init)` runs when the request arrives (the "gateway" writes its rows). */
const okFetch = (onCall = () => {}, seen = []) => async (url, init) => {
  seen.push({ url, headers: init.headers });
  onCall(init);
  const body = sseBody();
  let done = false;
  return { ok: true, status: 200, headers: { get: (k) => (k === "x-request-id" ? "req-123" : null) },
           body: { getReader: () => ({ read: async () => (done ? { done: true } : (done = true, { done: false, value: body })), cancel: async () => {} }) } };
};
const live = (t, fetchImpl, over = {}) => {
  const d = tmpDb(t), c = capture();
  return { d, c, run: (pre) => { pre?.(d.db); return main(["--live", "--only", "or/free-a"], { snapshot, gateway: GW, fetchImpl: fetchImpl(d.db), usageFile: d.file, waitMs: 400, pollMs: 5, out: c.out, err: c.err, ...over }); } };
};

// ---------------------------------------------------------------- arguments and dry mode

test("parseArgs: --only is required, takes exactly one provider/id, and unknown flags are refused", () => {
  assert.match(parseArgs([]).error, /--only/);
  assert.match(parseArgs(["--live"]).error, /--only/);
  assert.match(parseArgs(["--only"]).error, /provider\/id/);
  assert.match(parseArgs(["--only", "--live"]).error, /provider\/id/);
  assert.match(parseArgs(["--only", "openrouter"]).error, /ONE provider\/id/, "a bare provider is never a whole-provider run");
  assert.match(parseArgs(["--only", "a/b,c/d"]).error, /ONE provider\/id/);
  assert.match(parseArgs(["--only", "a/b c"]).error, /ONE provider\/id/);
  assert.match(parseArgs(["--only", "a/b", "--force"]).error, /unrecognised/);
  assert.deepEqual(parseArgs(["--only", "a/b"]), { live: false, only: "a/b" });
  assert.deepEqual(parseArgs(["--live", "--only", "a/b"]), { live: true, only: "a/b" });
});

test("main: bad arguments exit 2 and send nothing", async () => {
  const c = capture();
  let fetched = 0;
  assert.equal(await main(["--live"], { snapshot, gateway: GW, fetchImpl: async () => { fetched++; }, out: c.out, err: c.err }), EXIT.USAGE);
  assert.equal(fetched, 0);
  assert.match(c.errs[0], /--only/);
});

test("dry mode: says what it would do, sends nothing, opens nothing, prints no key", async () => {
  const c = capture();
  let fetched = 0;
  const code = await main(["--only", "or/free-a"], {
    snapshot, gateway: GW, usageFile: path.join(os.tmpdir(), "no-such-usage.sqlite"),
    fetchImpl: async () => { fetched++; }, openDb: () => { throw new Error("must not open in dry mode"); },
    out: c.out, err: c.err,
  });
  assert.equal(code, 0);
  assert.equal(fetched, 0);
  const text = c.lines.join("\n");
  assert.match(text, /dry run/);
  assert.match(text, /or\/free-a/);
  assert.match(text, /x-ccr-client: uw-probe/);
  assert.match(text, /no request was made/);
  assert.doesNotMatch(text, /SECRET-KEY-VALUE/);
  assert.deepEqual(c.errs, []);
});

test("dry mode with no router data folder says so instead of printing a path", async () => {
  const c = capture();
  assert.equal(await main(["--only", "or/free-a"], { snapshot, gateway: GW, usageFile: null, out: c.out, err: c.err }), 0);
  assert.match(c.lines.join("\n"), /router data folder NOT FOUND/);
});

test("refusals: a row not in the snapshot, a non-text row, and a row above the $0.01 ceiling, in dry and live mode", async () => {
  for (const isLive of [false, true]) {
    for (const [only, why] of [["or/nope", /not a probeable row/], ["or/img", /not a probeable row/], ["or/dear", /above the \$0\.01 ceiling/]]) {
      const c = capture();
      let fetched = 0;
      const code = await main([...(isLive ? ["--live"] : []), "--only", only], {
        snapshot, gateway: GW, fetchImpl: async () => { fetched++; }, openDb: () => { throw new Error("must not open"); }, out: c.out, err: c.err,
      });
      assert.equal(code, EXIT.REFUSED, `${only} live=${isLive}`);
      assert.equal(fetched, 0);
      assert.match(c.errs.join("\n"), why);
    }
  }
});

test("a missing snapshot, gateway or router data folder refuses before anything is sent", async () => {
  let c = capture();
  assert.equal(await main(["--only", "or/free-a"], { snapshot: { ok: false, reason: "absent" }, out: c.out, err: c.err }), EXIT.REFUSED);
  assert.match(c.errs[0], /no usable snapshot/);
  let fetched = 0;
  const fetchImpl = async () => { fetched++; };
  c = capture();
  assert.equal(await main(["--live", "--only", "or/free-a"], { snapshot, gateway: null, fetchImpl, out: c.out, err: c.err }), EXIT.REFUSED);
  assert.match(c.errs[0], /gateway/);
  c = capture();
  assert.equal(await main(["--live", "--only", "or/free-a"], { snapshot, gateway: GW, usageFile: null, fetchImpl, out: c.out, err: c.err }), EXIT.REFUSED);
  assert.match(c.errs[0], /router data not found/);
  assert.equal(fetched, 0);
});

test("live: an unreadable usage database refuses BEFORE the probe is sent", async () => {
  const c = capture();
  let fetched = 0;
  const code = await main(["--live", "--only", "or/free-a"], {
    snapshot, gateway: GW, usageFile: path.join(os.tmpdir(), "uw-spike-missing", "usage.sqlite"),
    fetchImpl: async () => { fetched++; }, out: c.out, err: c.err,
  });
  assert.equal(code, EXIT.REFUSED);
  assert.equal(fetched, 0);
  assert.match(c.errs[0], /cannot open the usage database/);
});

// ---------------------------------------------------------------- the reader

test("the reader selects the six whitelisted columns only, opened read-only; a schema without them is reported", (t) => {
  const d = tmpDb(t);
  insert(d.db, { client: "x" });
  const ro = openReadOnly(d.file);
  try {
    assert.deepEqual(readWatermark(ro), { ok: true, maxId: 1 });
    assert.deepEqual(Object.keys(readSince(ro, 0)[0]), ["id", "created_at", "provider", "model", "status_code", "client"]);
    assert.throws(() => ro.exec("insert into usage_events (client) values ('w')"), "opened read-only");
  } finally { ro.close(); }
  const bad = new DatabaseSync(":memory:");
  t.after(() => bad.close());
  bad.exec("create table usage_events (id integer primary key, created_at text)");
  assert.match(readWatermark(bad).reason, /lacks column/);
});

test("openReadOnly swallows node:sqlite's ExperimentalWarning and leaves nothing else filtered (fresh process)", (t) => {
  const d = tmpDb(t);
  d.db.close();
  const mod = new URL("../refresh/spike-client-tag.mjs", import.meta.url).href;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { openReadOnly } = await import(${JSON.stringify(mod)});
     const before = process.emitWarning;
     const db = openReadOnly(${JSON.stringify(d.file)}); db.close();
     if (process.emitWarning !== before) throw new Error("emitWarning was not restored");
     process.emitWarning("some other warning", "CustomWarning");`],
    { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /ExperimentalWarning|SQLite/i);
  assert.match(r.stderr, /some other warning/, "other warnings still print");
});

test("rowMatches accepts provider/id and the bare id for the probed provider only; verdict is pure", () => {
  const tgt = { provider: "or", id: "free-a", key: "or/free-a" };
  assert.equal(rowMatches({ provider: "or", model: "or/free-a" }, tgt), true);
  assert.equal(rowMatches({ provider: "or", model: "free-a" }, tgt), true);
  assert.equal(rowMatches({ provider: "other", model: "or/free-a" }, tgt), false);
  assert.equal(rowMatches({ provider: "or", model: "or/other" }, tgt), false);
  assert.equal(verdict([], tgt).kind, "INCONCLUSIVE");
  assert.equal(verdict([{ provider: "or", model: "or/free-a", client: PROBE }], tgt).kind, "CONFIRMED");
  assert.deepEqual(verdict([{ provider: "or", model: "free-a", client: REAL }], tgt).observed, REAL);
});

// ---------------------------------------------------------------- the live verdict

test("live, tag recorded: one probe with the header, verdict CONFIRMED, exit 0, only the six columns printed", async (t) => {
  const seen = [];
  const { c, run } = live(t, (db) => okFetch((init) => insert(db, { client: init.headers["x-ccr-client"] }), seen));
  const code = await run((db) => insert(db, { client: REAL }));
  assert.equal(code, EXIT.CONFIRMED, c.errs.join("\n"));
  assert.equal(seen.length, 1, "exactly ONE request");
  assert.equal(seen[0].url, "http://gw.test/v1/messages");
  assert.equal(seen[0].headers["x-ccr-client"], "uw-probe");
  const text = c.lines.join("\n");
  assert.match(text, /observed status ok/);
  assert.match(text, /request id req-123/);
  assert.equal(c.lines.at(-1), "TAG CONFIRMED: client = uw-probe");
  assert.doesNotMatch(text, /PRIVATE BODY TEXT|SECRET-KEY-VALUE|reqid-hidden/);
  assert.match(text, /id {2}created_at {2}provider {2}model {2}status_code {2}client/);
});

test("a foreign row landing first does not end the wait; the probe's row arriving late still confirms", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => {
    insert(db, { client: REAL, provider: "anthropic", model: "anthropic/claude-sonnet-5" });      // foreign, lands at once
    setTimeout(() => insert(db, { client: PROBE }), 60);                                           // the probe's row, late
  }));
  assert.equal(await run(), EXIT.CONFIRMED, c.lines.join("\n"));
  assert.equal(c.lines.at(-1), "TAG CONFIRMED: client = uw-probe");
});

test("a tagged row for a DIFFERENT model (another sweep) never confirms: INCONCLUSIVE, exit 4", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => insert(db, { client: PROBE, provider: "or", model: "or/some-other-model" })), { waitMs: 60 });
  assert.equal(await run(), EXIT.INCONCLUSIVE);
  assert.match(c.lines.at(-1), /^INCONCLUSIVE/);
  assert.ok(!c.lines.some((l) => /TAG CONFIRMED/.test(l)));
});

test("a tagged row for the same model name under ANOTHER provider never confirms", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => insert(db, { client: PROBE, provider: "elsewhere", model: "or/free-a" })), { waitMs: 60 });
  assert.equal(await run(), EXIT.INCONCLUSIVE);
  assert.match(c.lines.at(-1), /^INCONCLUSIVE/);
});

test("more than 5 foreign rows cannot hide the probe's row: it is found and shown first, at most 5 rows printed", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => {
    insert(db, { client: PROBE });                                                                  // the probe's row (lowest new id)
    for (let i = 0; i < 12; i++) insert(db, { client: REAL, provider: "anthropic", model: "anthropic/claude-sonnet-5" });
  }));
  assert.equal(await run(), EXIT.CONFIRMED);
  const shown = c.lines.filter((l) => /^ {2}\d+ {2}2026/.test(l));
  assert.equal(shown.length, 5);
  assert.match(shown[0], / {2}or {2}or\/free-a {2}200 {2}uw-probe$/, "the probe's own row leads");
});

test("the model may be stored as the bare id: it still matches", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => insert(db, { client: PROBE, model: "free-a" })));
  assert.equal(await run(), EXIT.CONFIRMED);
  assert.equal(c.lines.at(-1), "TAG CONFIRMED: client = uw-probe");
});

test("the probe's row exists but carries the default client: TAG NOT RECORDED with the observed value, exit 3", async (t) => {
  const { c, run } = live(t, (db) => okFetch(() => insert(db, { client: REAL })));
  assert.equal(await run(), EXIT.NOT_RECORDED);
  assert.equal(c.lines.at(-1), `TAG NOT RECORDED (observed client: ${REAL})`);
});

test("a refused probe (429) is still judged on its usage row", async (t) => {
  const { c, run } = live(t, (db) => async () => { insert(db, { client: REAL, status: 429 }); return { ok: false, status: 429, headers: { get: () => null }, text: async () => "{}" }; });
  assert.equal(await run(), EXIT.NOT_RECORDED);
  assert.match(c.lines.join("\n"), /observed status rate/);
});

test("no row at all before the wait ends: INCONCLUSIVE (not NOT RECORDED), exit 4; an OLD tagged row does not count", async (t) => {
  const { c, run } = live(t, () => async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "{}" }), { waitMs: 40 });
  assert.equal(await run((db) => insert(db, { client: PROBE })), EXIT.INCONCLUSIVE);
  assert.match(c.lines.join("\n"), /no new usage row/);
  assert.match(c.lines.at(-1), /^INCONCLUSIVE: no usage row for or\/free-a/);
  await sleep(0);
});

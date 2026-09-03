import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSnapshot, writeSnapshotFile, loadSnapshot, contextIndex,
         SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";

const scratch = (name) => {
  const d = path.join(os.homedir(), ".uw", "harness", "scratch", "snapshot");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
};

const BUILT = {
  generatedAt: "2026-08-24T12:22:28.162Z",
  rows: [
    { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
      models: [{ id: "acme-chat-1", ctx: 163840, pin: 0, pout: 0, badge: "FREE?",
                 tools: true, vision: false, reason: true },
               { id: "acme-pro-1", ctx: null, pin: 0.3, pout: 1.2, badge: "PAID",
                 tools: true, vision: true, reason: false }] },
    { keyId: "relay.anthropic.subscription", provider: "anthropic", free: null, planCount: 1,
      health: "ok",
      models: [{ id: "claude-opus-5", ctx: 200000, pin: null, pout: null, badge: "PLAN",
                 tools: true, vision: true, reason: true }] },
  ],
};

test("buildSnapshot stamps the schema and keeps every display field", () => {
  const s = buildSnapshot(BUILT);
  assert.equal(s.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(s.generatedAt, BUILT.generatedAt);
  assert.equal(typeof s.builtAt, "string");
  assert.equal(s.rows.length, 2);
  assert.deepEqual(Object.keys(s.rows[0]).sort(),
                   ["free", "health", "keyId", "models", "planCount", "provider"]);
  assert.deepEqual(Object.keys(s.rows[0].models[0]).sort(),
                   ["badge", "ctx", "id", "pin", "pout", "reason", "tools", "vision"]);
});

test("a snapshot round-trips through the file", () => {
  const f = scratch("ok.json");
  writeSnapshotFile(buildSnapshot(BUILT), f);
  const r = loadSnapshot(f);
  assert.equal(r.ok, true);
  assert.equal(r.snap.rows[1].models[0].id, "claude-opus-5");
  assert.equal(fs.readdirSync(path.dirname(f)).some((n) => n.includes(".tmp-")), false);
});

test("a missing file reports `missing`, not an empty menu", () => {
  const r = loadSnapshot(scratch("nope.json"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
});

test("an unparseable file reports `unreadable` and quotes nothing sensitive", () => {
  const f = scratch("bad.json");
  fs.writeFileSync(f, "{ this is not json");
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a truncated snapshot is unreadable rather than empty", () => {
  const f = scratch("cut.json");
  fs.writeFileSync(f, JSON.stringify(buildSnapshot(BUILT)).slice(0, 120));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a future schema is refused with the observed version quoted", () => {
  const f = scratch("v9.json");
  fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: 9 }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.match(r.detail, /9/);
});

test("contextIndex maps provider/model to context tokens and skips unknowns", () => {
  const ix = contextIndex(buildSnapshot(BUILT));
  assert.equal(ix.get("acme/acme-chat-1"), 163840);
  assert.equal(ix.get("anthropic/claude-opus-5"), 200000);
  assert.equal(ix.has("acme/acme-pro-1"), false);
  assert.equal(ix.size, 2);
});

test("the snapshot carries no catalogue internals", () => {
  const text = JSON.stringify(buildSnapshot(BUILT));
  for (const leak of ["pricing", "offers", "per1MTokens", "modalities", "capabilities", "limits"]) {
    assert.equal(text.includes(leak), false, `snapshot leaked ${leak}`);
  }
});

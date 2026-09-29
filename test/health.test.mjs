// Task B7, fold-only half (Milestone 3). `writeHealthFromOutcomes` -- the
// per-refresh projection -- is deliberately NOT shipped in this branch; see
// `menu/health.mjs`'s header for why. These tests cover exactly what ships:
// the reader/resolver in `menu/health.mjs` and the fold/one-off-writer in
// `refresh/health-writer.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readHealth, resolveHealth, makeHealthOf, outranks,
         SOURCE_RANK, MAX_HEALTH_AGE_MS } from "../menu/health.mjs";
import { foldProbeResults, writeHealthFromProbeFile } from "../refresh/health-writer.mjs";

// ------------------------------------------------------------- the producer

test("folding the existing probe file gives every probed provider a verdict", () => {
  const doc = { at: "2026-09-02T19:53:00.000Z", results: [
    { id: "personal.google.free", state: "ok" },
    { id: "personal_maestro.deepseek.paid", state: "broken", status: 402, why: "Insufficient Balance" },
    { id: "personal.dead.free", state: "auth", status: 401 },
    { id: "personal.unprobed.free", state: "skipped" },
  ] };
  const h = foldProbeResults(doc);
  assert.equal(h.generatedAt, doc.at);
  assert.equal(h.providers.google.lastOk, doc.at);
  assert.equal(h.providers.google.consecutiveFails, 0);
  assert.equal(h.providers.deepseek.consecutiveFails, 1);
  assert.equal(h.providers.dead.consecutiveFails, 1);
  assert.equal(h.providers.unprobed.lastOk, null, "skipped is not evidence either way");
});

test("a provider is healthy if ANY of its credentials answered", () => {
  // The column answers "can I use this provider", not "is every key for it good".
  const h = foldProbeResults({ at: "2026-09-02T19:53:00.000Z", results: [
    { id: "personal.acme.free", state: "auth" },
    { id: "work.acme.paid", state: "ok" },
  ] });
  assert.equal(h.providers.acme.lastOk, "2026-09-02T19:53:00.000Z");
  assert.equal(h.providers.acme.consecutiveFails, 0);
});

test("writeHealthFromProbeFile writes an atomic file and returns the fold", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-health-writer-"));
  const src = path.join(dir, "probe.json");
  const out = path.join(dir, "health.json");
  fs.writeFileSync(src, JSON.stringify({ at: "2026-09-02T19:53:00.000Z", results: [
    { id: "personal.acme.free", state: "ok" },
  ] }));
  const result = writeHealthFromProbeFile(src, out);
  assert.equal(result.providers.acme.lastOk, "2026-09-02T19:53:00.000Z");
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), result);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeHealthFromProbeFile returns null for a file with no results", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-health-writer-"));
  const src = path.join(dir, "missing.json");
  assert.equal(writeHealthFromProbeFile(src, path.join(dir, "health.json")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------- the reader

const NOW = Date.parse("2026-09-10T00:00:00Z");
const fresh = { generatedAt: "2026-09-09T00:00:00Z", providers: {} };
const old = { generatedAt: "2026-06-01T00:00:00Z", providers: {} };

test("a missing file reads as empty rather than throwing", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-health-"));
  assert.deepEqual(readHealth(path.join(d, "nope.json")), { generatedAt: null, providers: {} });
  fs.rmSync(d, { recursive: true, force: true });
});

test("notes that record breakage win over everything", () => {
  assert.equal(resolveHealth({ notes: "502 upstream_error on all tried models" },
                             { consecutiveFails: 0 }, fresh, NOW), "broken");
});

test("three consecutive failures is broken", () => {
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 3 }, fresh, NOW), "broken");
});

test("one or two failures is not yet broken", () => {
  // Not-broken is not the same as ok. The entry has to carry keyed evidence to
  // reach ok; with only a failure count it is unmeasured, which renders stale.
  const probed = { consecutiveFails: 2, source: "probe", lastOk: fresh.generatedAt, at: fresh.generatedAt };
  assert.equal(resolveHealth({ notes: "" }, probed, fresh, NOW), "ok");
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 2 }, fresh, NOW), "stale");
});

test("requiresBalance renders as needs $ when nothing is broken", () => {
  assert.equal(resolveHealth({ requiresBalance: true }, { consecutiveFails: 0 }, fresh, NOW), "needs $");
});

test("the three sources are ordered, and only the keyed two can reach ok", () => {
  const AT = fresh.generatedAt;
  const entry = (source) => ({ source, at: AT, lastOk: AT, consecutiveFails: 0 });
  assert.equal(resolveHealth({}, entry("probe"), fresh, NOW), "ok");
  assert.equal(resolveHealth({}, entry("keyed-listing"), fresh, NOW), "ok",
    "tier 2 authenticates the real credential — that is evidence a key works");
  assert.equal(resolveHealth({}, entry("listing"), fresh, NOW), "stale",
    "tier 1 uses no key at all and can never be evidence of health");
  assert.ok(outranks("probe", "keyed-listing"));
  assert.ok(outranks("keyed-listing", "listing"));
  assert.equal(outranks("listing", "probe"), false);
});

test("keyed evidence without a lastOk is still unmeasured", () => {
  assert.equal(resolveHealth({}, { source: "keyed-listing", at: fresh.generatedAt },
                             fresh, NOW), "stale");
});

test("health older than the age limit is refused and renders stale", () => {
  assert.equal(resolveHealth({ notes: "" },
                             { consecutiveFails: 5, source: "probe", lastOk: old.generatedAt,
                               at: old.generatedAt }, old, NOW), "stale");
});

test("the age refusal does not hide a note-recorded breakage", () => {
  assert.equal(resolveHealth({ notes: "key valid, chat backend down" },
                             { consecutiveFails: 5 }, old, NOW), "broken");
});

test("the age limit is fourteen days", () => {
  assert.equal(MAX_HEALTH_AGE_MS, 14 * 24 * 3600 * 1000);
});

test("a provider with no recorded measurement is stale, not ok and not broken", () => {
  // "No entry" means nobody has measured this provider. Rendering that as ok
  // is the guess this design forbids; broken would be the opposite guess and
  // is equally wrong. Stale is the honest answer.
  assert.equal(resolveHealth({ notes: "" }, undefined, fresh, NOW), "stale");
});

test("makeHealthOf resolves by provider name", () => {
  const f = makeHealthOf(new Map([["p", { notes: "" }]]),
                         { generatedAt: fresh.generatedAt, providers: { p: { consecutiveFails: 3 } } },
                         NOW);
  assert.equal(f("p"), "broken");
  assert.equal(f("unknown-provider"), "stale",
    "a provider with no entry is unmeasured, not healthy");
});

test("SOURCE_RANK orders probe above keyed-listing above listing", () => {
  assert.ok(SOURCE_RANK.probe > SOURCE_RANK["keyed-listing"]);
  assert.ok(SOURCE_RANK["keyed-listing"] > SOURCE_RANK.listing);
});

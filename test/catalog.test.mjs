import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { priceOf, isTextOut, badgeOf, buildFrom, routableSet, makeRoutableOf } from "../menu/catalog.mjs";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(doc.models.map((m) => [m.model, m]));

const catalog = () => {
  const byProvider = new Map();
  for (const m of doc.models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { byProvider, generatedAt: doc.generatedAt };
};

test("priceOf reads pricing.offers[].per1MTokens", () => {
  assert.deepEqual(priceOf(byId["acme-chat-1"]), { in: 0, out: 0 });
  assert.deepEqual(priceOf(byId["acme-pro-1"]), { in: 0.3, out: 1.2 });
});

test("priceOf returns null for the legacy shape keysync's inferTier reads", () => {
  assert.equal(priceOf(byId["acme-legacy-1"]), null);
  assert.equal(priceOf(byId["blank-a"]), null);
});

test("isTextOut is true when output modality is absent or includes text", () => {
  assert.equal(isTextOut(byId["acme-chat-1"]), true);
  assert.equal(isTextOut(byId["blank-a"]), true);
  assert.equal(isTextOut(byId["acme-image-1"]), false);
});

test("badgeOf: no price evidence renders blank, never PAID", () => {
  assert.equal(badgeOf(byId["blank-a"]), "");
  assert.equal(badgeOf(byId["acme-legacy-1"]), "");
});

test("badgeOf: a non-zero token price is PAID", () => {
  assert.equal(badgeOf(byId["acme-pro-1"]), "PAID");
});

test("badgeOf: zero price with unknown cadence is FREE?", () => {
  assert.equal(badgeOf(byId["acme-chat-1"]), "FREE?");
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "" }), "FREE?");
});

test("badgeOf: zero price with a recurring grant is FREE", () => {
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "recurring" }), "FREE");
});

test("badgeOf: zero price with a one-time grant is blank, not FREE and not PAID", () => {
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "one-time" }), "");
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "none" }), "");
});

test("badgeOf: guard G1 blanks a zero token price on a non-text-output model", () => {
  assert.equal(badgeOf(byId["acme-image-1"]), "");
  assert.equal(badgeOf(byId["acme-image-1"], { cadence: "recurring" }), "");
});

test("badgeOf: planCovered wins over price", () => {
  assert.equal(badgeOf(byId["acme-pro-1"], { planCovered: true }), "PLAN");
  assert.equal(badgeOf(byId["blank-a"], { planCovered: true }), "PLAN");
});

const input = (overrides = {}) => ({
  chosen: [
    { id: "personal.acme.free", provider: "acme" },
    { id: "personal.blank.paid", provider: "blank" },
  ],
  providers: new Map([
    ["acme", { testModel: "acme-chat-1", notes: "", requiresBalance: false }],
    ["blank", { testModel: "blank-a", notes: "", requiresBalance: false }],
  ]),
  catalog: catalog(),
  ...overrides,
});

test("buildFrom: free is a count when price data exists", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.free, 1);
  assert.equal(acme.models.length, 4);
});

test("buildFrom: free is null when no model has any price data", () => {
  const { rows } = buildFrom(input());
  const blank = rows.find((r) => r.provider === "blank");
  assert.equal(blank.free, null);
  assert.notEqual(blank.free, 0);
});

test("buildFrom: planCount is separate from free", () => {
  const { rows } = buildFrom(input({
    cadenceOf: () => ({ cadence: "", planCovered: true }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.planCount, 4);
  assert.equal(acme.free, 0);
});

test("buildFrom: a recurring cadence promotes FREE? to FREE", () => {
  const { rows } = buildFrom(input({
    cadenceOf: (name) => ({ cadence: name === "acme" ? "recurring" : "" }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.find((m) => m.id === "acme-chat-1").badge, "FREE");
  assert.equal(acme.free, 1);
});

test("buildFrom: the testModel leads and is not duplicated", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.filter((m) => m.id === "acme-chat-1").length, 1);
});

test("buildFrom: a testModel absent from the catalogue is prepended with a blank badge", () => {
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const { rows } = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p,
  }));
  assert.equal(rows[0].models[0].id, "acme-unlisted");
  assert.equal(rows[0].models[0].badge, "");
});

test("buildFrom: ids that fail admitId are dropped, not rendered", () => {
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "evil\x1b[2J", capabilities: {} });
  const { rows } = buildFrom(input({ catalog: c }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.some((m) => m.id.includes("\x1b")), false);
  assert.equal(acme.models.length, 4);
});

test("buildFrom: the relay is injected with PLAN badges", () => {
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5", "claude-sonnet-5"] },
  }));
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.equal(relay.keyId, "relay.anthropic.subscription");
  assert.equal(relay.models.every((m) => m.badge === "PLAN"), true);
  assert.equal(relay.free, null);
  assert.equal(relay.planCount, 2);
});

test("writeAtomic leaves no partial file and replaces the previous contents", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.json");
  writeAtomic(f, '{"v":1}');
  writeAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":2}');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});

test("readJsonOr never throws", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ truncated");
  assert.deepEqual(readJsonOr(bad, { fallback: true }), { fallback: true });
  assert.deepEqual(readJsonOr(path.join(dir, "nope.json"), null), null);
});

test("routableSet reports whether its answer is fresh, and never throws", async () => {
  const live = await routableSet({
    rpc: async () => ({ Providers: [{ name: "acme", models: ["acme-chat-1"] }] }),
  });
  assert.equal(live.fresh, true);
  assert.equal(live.set.has("acme/acme-chat-1"), true);

  const dead = await routableSet({ rpc: async () => null });
  assert.equal(dead.fresh, false);
  assert.equal(dead.set instanceof Set, true);
  assert.equal(dead.set.size, 0);
});

test("routableOf turns a set into the per-row field, and absence means unknown", () => {
  // fresh=false must not become "everything is unroutable": that would dim all
  // 1,584 rows the one time the gateway is down, which is the most alarming
  // possible rendering of "nobody asked". Unknown is null, and null does not dim.
  const known = makeRoutableOf(new Set(["acme/acme-chat-1"]), true);
  assert.equal(known("acme/acme-chat-1"), true);
  assert.equal(known("acme/acme-pro-1"), false);
  const unknown = makeRoutableOf(new Set(), false);
  assert.equal(unknown("acme/acme-chat-1"), null);
});

// The companion assertion — that uwpick.mjs never calls routableSet — lives in
// Task A10's test file, where uwpick.mjs exists. Putting it here would need a
// gate on a file a later task creates, which Constraint 15a forbids.

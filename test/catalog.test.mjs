import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { priceOf, isTextOut, badgeOf, capsOf, buildFrom, routableSet, makeRoutableOf,
         writeSlot, readSlot } from "../menu/catalog.mjs";
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

test("priceOf answers about MY key, not about the first offer in the array", () => {
  // The case provider-matching exists for, and it was previously untested: the
  // fixture had no entry with more than one offer and none whose offers[].provider
  // differed from the row's. The live catalogue has 973 entries with two or more
  // offers and 792 where offers[0] belongs to another host, so reverting to
  // offers[0] -- the exact defect the comment at priceOf records -- passed the
  // whole suite while badging rows with a different vendor's price.
  //
  // Foreign offers only: the honest answer is null, never the first offer's zero.
  assert.equal(priceOf(byId["multi-foreign-only"], "multi"), null);
  assert.equal(priceOf(byId["multi-foreign-only"]), null, "two usable offers, none identifiable");
  assert.equal(badgeOf(byId["multi-foreign-only"], { providerName: "multi" }), "",
    "a free-looking foreign offer must not badge the row FREE");

  // Mine present but not first: the matching offer wins, so a reversion to
  // offers[0] returns 9.00/9.00 here and this fails.
  assert.deepEqual(priceOf(byId["multi-mine-second"], "multi"), { in: 1, out: 2 });
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

test("capsOf keeps a measured `false` distinct from an absent key", () => {
  // The whole bug in two assertions. `!!undefined === false` made an entry with no
  // `reasoning` key indistinguishable from one the catalogue measured as lacking
  // reasoning, and 9 of the 45 matched picker rows are in exactly that state.
  //
  // The `false` half is the one that matters, and it is the half a test written
  // only around the unknown case cannot see: mutating `?? null` to `|| null` fixes
  // nothing and breaks this line, because `false || null === null` sends a known
  // capability straight back to unknown (mutation boundary 2).
  assert.equal(capsOf({ capabilities: { reasoning: false } }).reason, false);
  assert.equal(capsOf({ capabilities: {} }).reason, null);

  assert.deepEqual(capsOf({ capabilities: {} }), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf({}), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf(undefined), { tools: null, vision: null, reason: null });
  assert.deepEqual(capsOf({ capabilities: { toolCalling: true, imageInput: false } }),
                   { tools: true, vision: false, reason: null });
});

test("buildFrom carries the tri-state through, and synthetic rows do not invent one", () => {
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5"] },
  }));
  const acme = rows.find((r) => r.provider === "acme");
  const row = Object.fromEntries(acme.models.map((m) => [m.id, m]));

  // capabilities: {toolCalling: true, imageInput: false, reasoning: true}
  assert.equal(row["acme-chat-1"].tools, true);
  assert.equal(row["acme-chat-1"].vision, false, "a measured false stays false");
  // capabilities: {} -- no key at all
  assert.deepEqual([row["acme-image-1"].tools, row["acme-image-1"].vision,
                    row["acme-image-1"].reason], [null, null, null]);
  // capabilities: {..., reasoning: false}
  assert.equal(row["acme-pro-1"].reason, false);

  // A testModel with no catalogue entry: the row exists BECAUSE nothing was
  // measured, so all-false would be a claim the code cannot support.
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const solo = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }], providers: p,
  })).rows[0].models[0];
  assert.equal(solo.id, "acme-unlisted");
  assert.deepEqual([solo.tools, solo.vision, solo.reason], [null, null, null]);

  // The relay is the one all-true set that survives: the Anthropic subscription
  // models are known first-hand, not looked up.
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.deepEqual([relay.models[0].tools, relay.models[0].vision, relay.models[0].reason],
                   [true, true, true]);
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

test("a failed writeAtomic leaves the target intact and no debris behind", () => {
  // The target was already safe -- it keeps its previous contents, which is the
  // guarantee. What was not safe is the leftover `<file>.tmp-<pid>`: a full disk
  // or a revoked permission left one on every attempt, and the picker's own state
  // tests assert no such file survives a write.
  //
  // Forced by renaming onto a non-empty directory, which fails after the temp file
  // has been created and written.
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic-fail");
  const target = path.join(dir, "occupied");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "child"), "keep me");

  assert.throws(() => writeAtomic(target, '{"v":1}'), "a real failure must still fail");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), [],
    "the temp file must not survive the failure");
  assert.equal(fs.readFileSync(path.join(target, "child"), "utf8"), "keep me");
});

test("buildFrom stays silent: the display path must not write to the console", () => {
  // buildFrom runs inside the picker, which owns a full-screen frame in the
  // alternate screen. admitRemoteModels' SECURITY line landed in the middle of
  // one. Zero rejections across the 4,298 bundled ids today, so it was latent --
  // and it goes live with Task B6, where discovery returns raw provider strings
  // instead of a curated bundle. The routing path still reports the same
  // rejections, with an ordinary stdout.
  const c = catalog();
  c.byProvider.set("evil", [{ provider: "evil", model: "uw/fast", capabilities: {} },
                            { provider: "evil", model: "ok-1", capabilities: {} }]);
  const said = [];
  const realWarn = console.warn;
  console.warn = (m) => said.push(String(m));
  try {
    buildFrom({ chosen: [{ id: "personal.evil.free", provider: "evil" }],
                providers: new Map([["evil", { testModel: "uw/slot-1", notes: "" }]]),
                catalog: c });
  } finally { console.warn = realWarn; }
  assert.deepEqual(said, [], "the picker's build path must print nothing");
});

test("the slot round-trips atomically and survives a missing or corrupt file", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "slot");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "slot.json");
  fs.rmSync(f, { force: true });

  assert.equal(readSlot(f), "", "a missing slot reads as no pin, not a throw");

  writeSlot("acme/acme-chat-1", f);
  assert.equal(readSlot(f), "acme/acme-chat-1");
  // Through writeAtomic: a plain write truncates in place, so an interrupt leaves
  // a prefix that readSlot's catch turns into "" -- a pin silently forgotten
  // rather than an error. No temp file may survive either.
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")), []);

  writeSlot("zeta/zeta-two", f);
  assert.equal(readSlot(f), "zeta/zeta-two", "a rewrite replaces rather than appends");

  fs.writeFileSync(f, '{"model": "acme/hal');   // the truncation shape itself
  assert.equal(readSlot(f), "", "a half-written slot reads as no pin");
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

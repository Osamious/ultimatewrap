// #148: the snapshot stores a key id WHOLE (it was clipped to 30 code points, which cut the tier suffix off a 32-character id),
// and the model-list header shows the whole id when the frame has room. Pure fixtures; nothing here reads ~/.llmkeys or state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildFrom, KEYID_STORE_MAX } from "../menu/catalog.mjs";
import { buildSnapshot } from "../menu/snapshot.mjs";
import { detectCaps, frame, frameWidth, KEYID_MAX } from "../menu/style.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const catalog = () => {
  const byProvider = new Map();
  for (const m of doc.models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { byProvider, generatedAt: doc.generatedAt };
};
const rowFor = (id) => buildSnapshot(buildFrom({
  chosen: [{ id, provider: "acme" }],
  providers: new Map([["acme", { testModel: "acme-chat-1", notes: "", requiresBalance: false }]]),
  catalog: catalog(),
})).rows[0];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;

test("a 47-character key id reaches the snapshot whole, and its tier suffix parses", () => {
  const id = "personal.averyveryveryverylongprovidername.free";
  assert.equal(cps(id), 47);
  const row = rowFor(id);
  assert.equal(row.keyId, id);
  assert.equal(row.keyId.split(".").pop(), "free", "the tier of the vault id");
});

test("the 32-character tokenforge id keeps its tier (the id #148 was filed for)", () => {
  assert.equal(rowFor("personal.tokenforgeaistudio.free").keyId, "personal.tokenforgeaistudio.free");
});

test("a 70-character id is bounded by the safety constant, which is not 30", () => {
  const id = "personal." + "x".repeat(56) + ".paid";
  assert.equal(cps(id), 70);
  assert.ok(KEYID_STORE_MAX >= 70 && KEYID_STORE_MAX > KEYID_MAX);
  assert.equal(rowFor(id).keyId, id);
  const hostile = "personal." + "y".repeat(KEYID_STORE_MAX + 50) + ".free";
  assert.equal(cps(rowFor(hostile).keyId), KEYID_STORE_MAX, "a runaway id is bounded");
});

test("control and invisible characters are still stripped from a stored key id", () => {
  assert.equal(rowFor("personal.\x1b[2Jac\x07me‮.free​").keyId, "personal.acme.free");
});

test("the model-list header shows the whole id and stays exactly the frame width", () => {
  const ids = ["personal.averyveryveryverylongprovidername.free",
               "personal." + "z".repeat(50) + ".free"];            // 64 = KEYID_MAX
  assert.equal(cps(ids[1]), KEYID_MAX);
  for (const keyId of ids) {
    const row = { keyId, provider: "acme", free: 0, planCount: 0, health: "ok", bench: null, benchFlags: null, benchAgeHist: null,
                  models: [{ id: "m1", ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false, reason: false,
                             outputKind: "text", routable: true }] };
    const v = { level: 1, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false, provider: row, more: 0,
                items: row.models.map((model) => ({ kind: "model", model, row, target: `acme/${model.id}` })) };
    for (const [name, base] of [["unicode", detectCaps({ WT_SESSION: "1", COLORTERM: "truecolor" }, 120)],
                                ["ascii", detectCaps({ TERM: "dumb" }, 80)]]) {
      for (const cols of [80, 100, 132]) {
        const caps = { ...base, cols };
        const lines = frame(v, { providers: 1, models: 1, generatedAt: "2026-09-29T12:00:00Z" }, { caps }).map(strip);
        const fw = frameWidth(caps);
        assert.equal(lines.every((l) => cps(l) === fw), true, `${name} ${cols}: every line is ${fw} wide`);
        const room = fw - 5 - cps(lines[0].includes("▸") ? "UW ▸ " : "UW > ") - cps(lines[0].includes("▸") ? " ▸ models" : " > models");
        if (cps(keyId) <= room) assert.ok(lines[0].includes(keyId), `${name} ${cols}: header carries the whole id`);
        else assert.ok(/\.\.\.|…/.test(lines[0]), `${name} ${cols}: a clipped id is marked`);
        assert.ok(/models/.test(lines[0]), `${name} ${cols}: the title keeps its tail`);
      }
    }
  }
});

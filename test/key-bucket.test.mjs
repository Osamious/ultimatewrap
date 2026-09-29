// #114, provider list: the key id is drawn IN FULL (the shared `personal.` bucket included: nothing is omitted or
// noted in the title), and the columns are separated by dim rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCaps, painter, frame, frameWidth, keyIdWidth, KEYID_MAX, layoutFor } from "../menu/style.mjs";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { firstFrame } from "../menu/uwpick.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };
const rows = (...ids) => ids.map((keyId) => ({ keyId }));
const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, ctx: null, pin: null, pout: null, badge: "",
  tools: false, vision: false, reason: false, routable: null }));
const prow = (keyId, o = {}) => ({ keyId, provider: keyId.split(".")[1] ?? "p", free: 1, planCount: 0, health: "ok",
  models: mk(3), bench: null, benchFlags: null, ...o });

test("keyIdWidth measures the FULL ids, header minimum, capped", () => {
  const r = rows("personal.openrouter.free", "personal.a.b");
  assert.equal(keyIdWidth(r), 24, "the full id, bucket included");
  assert.equal(keyIdWidth(rows("personal.a")), 10);
  assert.equal(keyIdWidth(rows("a")), 6, "never narrower than `key id`");
  assert.equal(keyIdWidth(rows("z".repeat(80))), KEYID_MAX, "capped");
  assert.equal(keyIdWidth(rows("personal_mxene.alibaba.paid")), 27, "a long real id is measured whole");
});

const META = { providers: 4, models: 12, generatedAt: "x", routableAsOf: "2026-09-29T09:18:00Z" };
const ROWS = [prow("personal.openrouter.free"), prow("personal.google.free"), prow("personal.chutes.paid"),
              prow("personal.veniceai.free"), prow("personal.xai.paid"),
              prow("relay.anthropic.subscription")];
const meta = { ...META, providers: ROWS.length, keyIdW: keyIdWidth(ROWS), rows: ROWS };

test("the provider list draws every key id in full, bucket included, with no 'ids shown without' note", () => {
  for (const env of [UNI, ASCII]) {
    const lines = frame(view(initState(ROWS)), meta, { caps: detectCaps(env, 134) }).map(strip);
    assert.equal(lines[0].includes("ids shown without"), false, lines[0]);
    for (const id of ["personal.openrouter.free", "personal.google.free", "personal.veniceai.free", "relay.anthropic.subscription"]) {
      assert.ok(lines.some((l) => l.includes(id) && l.includes(env === UNI ? "┆" : ":")), `${id} whole in its row`);
    }
  }
});

test("filtering matches the full key id, which is now also the drawn one", () => {
  let s = initState(ROWS);
  for (const ch of "personal") s = reduce(s, ch).state;
  assert.equal(view(s).items.length, 5, "relay has no `personal`");
  const lines = frame(view(s), meta, { caps: detectCaps(UNI, 134) });
  assert.ok(lines.every((l) => cps(strip(l)) === 132));
  let e = initState(ROWS);
  e = reduce(e, "e").state;
  const hl = frame(view(e), meta, { caps: detectCaps(UNI, 134) }).find((l) => strip(l).includes("personal.google.free"));
  assert.ok(hl.includes("\x1b[1me\x1b"), "a match inside the drawn id is highlighted (on a row that is not selected)");
  let t = initState(ROWS);
  for (const ch of "venice") t = reduce(t, ch).state;
  assert.equal(reduce(t, "\r").state.provider.keyId, "personal.veniceai.free");
});

test("firstFrame measures the width once, over the whole snapshot, and carries no bucket", () => {
  const snap = { schemaVersion: 9, generatedAt: "x", builtAt: "x", rows: ROWS };
  const f = firstFrame({ snap, recents: [], favourites: [], caps: detectCaps(ASCII, 80), termRows: 30 });
  assert.equal(Object.hasOwn(f.meta, "keyIdBucket"), false, "the bucket plumbing is gone");
  assert.equal(f.meta.keyIdW, 28, "the longest full id (relay.anthropic.subscription)");
  assert.ok(f.text.includes("personal.openrou"), "at 80 columns the ids start with their full head");
});

test("every provider-list line is exactly the frame width with full ids and the rules drawn", () => {
  const withBench = ROWS.map((r, i) => ({ ...r, bench: { ok: i, empty: 0, auth: 0, pay: 0, rate: 0, gone: 1, timeout: 0, error: 0, skip: 0 },
    benchFlags: { dead: false, needsMoney: false } }));
  const m = { ...meta, rows: withBench, keyIdW: keyIdWidth(withBench) };
  for (const env of [UNI, ASCII]) {
    for (const cols of [40, 80, 84, 100, 112, 134, 400]) {
      const caps = detectCaps(env, cols);
      for (const st of [initState(withBench), { ...initState(withBench), cur: [2, 0, 0] }]) {
        for (const l of frame(view(st), m, { caps })) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}: ${strip(l)}`);
      }
    }
  }
});

test("level-0 rules: header and rows agree, selected rows invert whole, pinned rows carry none", () => {
  const withBench = ROWS.map((r) => ({ ...r, bench: { ok: 3, empty: 0, auth: 0, pay: 0, rate: 0, gone: 0, timeout: 0, error: 0, skip: 0 },
    benchFlags: { dead: false, needsMoney: false } }));
  const m = { ...meta, rows: withBench, keyIdW: keyIdWidth(withBench) };
  for (const [env, S] of [[UNI, "┆"], [ASCII, ":"]]) {
    for (const cols of [80, 100, 134]) {
      const caps = detectCaps(env, cols);
      const lines = frame(view(initState(withBench)), m, { caps }).map(strip);
      const head = lines.find((l) => l.includes("key id"));
      const at = (l) => [...l].map((ch, i) => (ch === S ? i : -1)).filter((i) => i >= 0);
      const row = lines[lines.indexOf(head) + 2];   // the second provider row (elided at narrow widths)
      assert.deepEqual(at(row), at(head), `cols ${cols}`);
      assert.ok(at(head).length >= 10, "models, status, ok and the seven raw counts each get a rule");
    }
  }
  const caps = detectCaps(UNI, 134);
  const sel = frame(view(initState(withBench)), m, { caps })[4];
  assert.ok(sel.includes("\x1b[7m") && strip(sel).includes("┆"), "the inverse covers the whole row, rules included");
  const pinnedV = { level: 0, scope: "tree", filter: "", legend: false, cursor: 9, top: 0, empty: false, provider: null, more: 0,
    items: [{ kind: "pinned", mark: "*", target: "acme/some-model" }] };
  const pinned = frame(pinnedV, m, { caps }).map(strip).find((l) => l.includes("acme/some-model"));
  assert.equal(pinned.includes("┆"), false, "a pinned row is unseparated");
});

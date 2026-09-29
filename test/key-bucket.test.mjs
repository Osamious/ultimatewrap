// #114, provider list: the bucket segment (`personal.`) that nearly every key id shares is
// not drawn, and the columns are separated by dim rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectCaps, painter, frame, frameWidth, keyIdBucket, keyIdShown, keyIdWidth, layoutFor } from "../menu/style.mjs";
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

test("the bucket is the leading segment shared by (nearly) every row, and only if ids stay unique", () => {
  assert.equal(keyIdBucket(rows("personal.a.free", "personal.b.paid")), "personal.");
  assert.equal(keyIdBucket(rows("personal.a.free", "personal.b.paid", "relay.c.sub")), "", "2 of 3 is under 80%");
  const many = [...Array.from({ length: 9 }, (_, i) => `personal.p${i}.free`), "relay.anthropic.subscription"];
  assert.equal(keyIdBucket(rows(...many)), "personal.", "9 of 10 keeps it; the odd row shows its full id");
  assert.equal(keyIdShown("relay.anthropic.subscription", "personal."), "relay.anthropic.subscription");
  assert.equal(keyIdShown("personal.p1.free", "personal."), "p1.free");
  assert.equal(keyIdBucket(rows("personal.a.free", "personal.a.free")), "", "shortening must never merge two rows");
  assert.equal(keyIdBucket(rows("personal.x")), "", "one row is not a pattern");
  assert.equal(keyIdBucket(rows("alpha", "beta")), "", "no dots, no bucket");
  assert.equal(keyIdBucket([]), "");
  assert.equal(keyIdBucket(undefined), "");
  assert.equal(keyIdShown("anything", ""), "anything");
  assert.equal(keyIdShown(undefined, "personal."), "");
});

test("keyIdWidth measures the ids AS DRAWN, header minimum, capped", () => {
  const r = rows("personal.openrouter.free", "personal.a.b");
  assert.equal(keyIdWidth(r), 24, "no bucket: the full id");
  assert.equal(keyIdWidth(r, "personal."), 15, "with the bucket omitted");
  assert.equal(keyIdWidth(rows("personal.a"), "personal."), 6, "never narrower than `key id`");
  assert.equal(keyIdWidth(rows("z".repeat(80)), ""), 30, "capped");
});

const META = { providers: 4, models: 12, generatedAt: "x", routableAsOf: "2026-09-29T09:18:00Z" };
const ROWS = [prow("personal.openrouter.free"), prow("personal.google.free"), prow("personal.chutes.paid"),
              prow("personal.veniceai.free"), prow("personal.xai.paid"),
              prow("relay.anthropic.subscription")];
const bucket = keyIdBucket(ROWS);
const meta = { ...META, providers: ROWS.length, keyIdBucket: bucket, keyIdW: keyIdWidth(ROWS, bucket) };

test("the provider list draws ids without the bucket, keeps other buckets whole, and says so in the title", () => {
  assert.equal(bucket, "personal.");
  for (const env of [UNI, ASCII]) {
    const lines = frame(view(initState(ROWS)), meta, { caps: detectCaps(env, 134) }).map(strip);
    assert.ok(lines[0].includes("ids shown without personal."), lines[0]);
    assert.ok(lines.some((l) => /openrouter\.free\s/.test(l)));
    // the FULL id line (above the footer) is the one place the omitted bucket is spelled out
    assert.ok(lines.filter((l) => l.includes("personal.openrouter")).every((l) => l.includes("id: personal.openrouter.free")));
    assert.ok(lines.some((l) => l.includes("relay.anthropic.subscription")), "a row in another bucket keeps its full id");
  }
  const none = frame(view(initState(ROWS)), { ...meta, keyIdBucket: "" }, { caps: detectCaps(ASCII, 134) }).map(strip);
  assert.equal(none[0].includes("ids shown without"), false, "no bucket, no note");
  assert.ok(none.some((l) => l.includes("personal.openrouter.free")));
});

test("filtering still matches the full key id, including the omitted segment", () => {
  let s = initState(ROWS);
  for (const ch of "personal") s = reduce(s, ch).state;
  assert.equal(view(s).items.length, 5, "the omitted segment still filters (relay has no `personal`)");
  const lines = frame(view(s), meta, { caps: detectCaps(UNI, 134) });
  assert.ok(lines.every((l) => cps(strip(l)) === 132));
  let e = initState(ROWS);
  e = reduce(e, "e").state;
  const hl = frame(view(e), meta, { caps: detectCaps(UNI, 134) }).find((l) => strip(l).includes("google.free"));
  assert.ok(hl.includes("\x1b[1me\x1b"), "a match inside the shown part is highlighted (on a row that is not selected)");
  let t = initState(ROWS);
  for (const ch of "venice") t = reduce(t, ch).state;
  // enter selects the row whose FULL id is behind the drawn one
  assert.equal(reduce(t, "\r").state.provider.keyId, "personal.veniceai.free");
});

test("firstFrame measures the bucket and the width once, over the whole snapshot", () => {
  const snap = { schemaVersion: 7, generatedAt: "x", builtAt: "x", rows: ROWS };
  const f = firstFrame({ snap, recents: [], favourites: [], caps: detectCaps(ASCII, 80), termRows: 30 });
  assert.equal(f.meta.keyIdBucket, "personal.");
  assert.equal(f.meta.keyIdW, 28, "the relay row's full id is the longest drawn");
  assert.ok(f.text.includes("openrouter.f"), "at 80 columns the 12 available characters now start with the provider");
});

test("every provider-list line is exactly the frame width with the bucket omitted and the rules drawn", () => {
  const withBench = ROWS.map((r, i) => ({ ...r, bench: { ok: i, empty: 0, auth: 0, pay: 0, rate: 0, gone: 1, timeout: 0, error: 0, skip: 0 },
    benchFlags: { dead: false, needsMoney: false } }));
  const m = { ...meta, keyIdW: keyIdWidth(withBench, bucket) };
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
  const m = { ...meta, keyIdW: keyIdWidth(withBench, bucket) };
  for (const [env, S] of [[UNI, "┆"], [ASCII, ":"]]) {
    for (const cols of [80, 100, 134]) {
      const caps = detectCaps(env, cols);
      const lines = frame(view(initState(withBench)), m, { caps }).map(strip);
      const head = lines.find((l) => l.includes("key id"));
      const at = (l) => [...l].map((ch, i) => (ch === S ? i : -1)).filter((i) => i >= 0);
      const row = lines.find((l) => l.includes("google.free"));
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

// C2 of the live-status feature: `menu/observed-data.mjs` (the overlay reader) and its merge into `loadBench`. Temp directories only:
// nothing here reads or writes the real `~/.uw/state`. The recorder itself (`refresh/observe*.mjs`) is tested in its own files.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { fileURLToPath } from "node:url";
import { loadBench, cleanRecord, isLive, oldestStampOf, ageHistOf, recordAge, countStatuses, outdatedNotice, STATUSES, benchKey } from "../menu/bench-data.mjs";
import { loadObserved, feedNote, cleanObservedRecord, observeEnabled, observeOffFile, OBSERVED_STATUSES, OBSERVED_MAX_ENTRIES, OBSERVED_MAX_BYTES, OBSERVED_SCHEMA } from "../menu/observed-data.mjs";
import { toStored } from "../refresh/bench-store.mjs";
import { redactClip } from "../menu/redact.mjs";
import { firstFrame } from "../menu/uwpick.mjs";
import { detectCaps } from "../menu/style.mjs";

guardRealState(after, assert);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const tmp = () => mkTmp("uw-overlay-");
const done = (d) => fs.rmSync(d, { recursive: true, force: true });
const put = (dir, name, v) => fs.writeFileSync(path.join(dir, name), typeof v === "string" ? v : JSON.stringify(v));
const bench = (models) => ({ schema: 1, generatedAt: new Date().toISOString(), models });
const overlay = (models, o = {}) => ({ schema: OBSERVED_SCHEMA, writtenAt: new Date().toISOString(), feed: "ok", wm: { id: 5, seq: 5, at: new Date().toISOString() }, models, pend: {}, conf: {}, ...o });
const withDir = (fn) => { const d = tmp(); try { return fn(d, path.join(d, "bench.json"), path.join(d, "observed.json")); } finally { done(d); } };
const M = (id) => ({ id, ctx: 1, pin: 0, pout: 0, badge: "", tools: true, vision: false, reason: false, routable: true });

// ------------------------------------------------------------------ a missing, torn, wrong or hostile file is no overlay

test("a missing, torn, wrong-schema, oversized or malformed overlay is null, and loadBench is then exactly the bench.json reader", () => withDir((d, bf, of) => {
  put(d, "bench.json", bench({ "p/a": { s: "ok", a: NOW - 10, t: 5, d: 9, p: "hi" } }));
  const alone = loadBench(bf, { observed: false });
  const same = (b) => { assert.deepEqual(b.get("p/a"), alone.get("p/a")); assert.equal(b.size, alone.size); assert.equal(b.live, 0); };
  assert.equal(loadObserved(of), null, "missing");
  same(loadBench(bf));
  const cases = {
    torn: '{"schema":1,"models":{"p/a":{"s":"ra',
    wrongSchema: JSON.stringify({ schema: 2, models: { "p/a": { s: "rate", a: NOW } } }),
    noSchema: JSON.stringify({ models: { "p/a": { s: "rate", a: NOW } } }),
    modelsArray: JSON.stringify({ schema: 1, models: [] }),
    modelsMissing: JSON.stringify({ schema: 1 }),
    modelsString: JSON.stringify({ schema: 1, models: "x" }),
    array: "[]", nullJson: "null", number: "7", empty: "",
  };
  for (const [name, body] of Object.entries(cases)) {
    put(d, "observed.json", body);
    assert.equal(loadObserved(of), null, name);
    same(loadBench(bf));
  }
  // over the size cap: refused unread
  fs.writeFileSync(of, JSON.stringify(overlay({ "p/a": { s: "rate", a: NOW } })) + " ".repeat(OBSERVED_MAX_BYTES));
  assert.equal(loadObserved(of), null, "oversized");
  same(loadBench(bf));
  // a directory where the file should be
  fs.rmSync(of); fs.mkdirSync(of);
  assert.equal(loadObserved(of), null, "a directory");
  same(loadBench(bf));
}));

test("with no bench.json at all, an overlay alone is still a reader (its keys are visible); with neither it is the empty result", () => withDir((d, bf, of) => {
  assert.equal(loadBench(bf).size, 0);
  assert.equal(loadBench(bf).get("p/a"), null);
  assert.equal(loadBench(bf).live, 0);
  put(d, "observed.json", overlay({ "p/a": { s: "rate", a: NOW - 5, m: "Rate limit" } }));
  const b = loadBench(bf);
  assert.equal(b.size, 1);
  assert.equal(b.generatedAt, null);
  assert.equal(b.get("p/a").s, "rate");
  assert.equal(b.get("p/a").l, 1);
  assert.equal(b.live, 1);
}));

// ------------------------------------------------------------------------ the kill switch

test("the sentinel observe.off makes every reader ignore the overlay; removing it restores the merge; no overlay means nothing changes", () => withDir((d, bf, of) => {
  put(d, "bench.json", bench({ "p/a": { s: "ok", a: NOW - 3600, t: 5, d: 9 } }));
  put(d, "observed.json", overlay({ "p/a": { s: "rate", a: NOW - 10 } }));
  assert.equal(observeEnabled(of), true, "on by default");
  assert.equal(loadBench(bf).get("p/a").s, "rate");
  put(d, "observe.off", "");
  assert.equal(observeEnabled(of), false);
  assert.equal(observeOffFile(of), path.join(d, "observe.off"));
  assert.equal(loadObserved(of), null);
  const off = loadBench(bf);
  assert.equal(off.get("p/a").s, "ok", "bench.json only");
  assert.equal(off.live, 0);
  assert.equal(off.overlay, null);
  assert.equal(off.get.isLive("p/a"), false);
  fs.rmSync(path.join(d, "observe.off"));
  assert.equal(loadBench(bf).get("p/a").s, "rate", "removing the sentinel restores it");
  // the sentinel is beside the OVERLAY: another directory's sentinel does not switch this one off
  const other = tmp();
  try { put(other, "observe.off", ""); assert.equal(loadBench(bf).get("p/a").s, "rate"); } finally { done(other); }
}));

// -------------------------------------------------------------------------- merge rules

test("merge: the newer `a` wins, a tie goes to the probe, an older overlay entry is ignored, an overlay-only key is visible", () => withDir((d, bf, of) => {
  put(d, "bench.json", bench({
    "p/newer": { s: "ok", a: NOW - 1000, t: 5, d: 9, p: "probe reply" },
    "p/tie": { s: "ok", a: NOW - 500, p: "probe reply" },
    "p/older": { s: "ok", a: NOW - 100, p: "probe reply" },
    "p/skip": { s: "skip", a: NOW - 50, w: "spend-cap" },
    "p/untouched": { s: "auth", a: NOW - 700, m: "bad key" },
  }));
  put(d, "observed.json", overlay({
    "p/newer": { s: "rate", a: NOW - 900, m: "Rate limit exceeded" },
    "p/tie": { s: "gone", a: NOW - 500 },
    "p/older": { s: "pay", a: NOW - 200 },
    "p/skip": { s: "pay", a: NOW - 60 },                     // older than the skip, but a skip is not a measurement
    "p/only": { s: "error", a: NOW - 30, m: "HTTP 502 x2, no 200 between" },
  }));
  const b = loadBench(bf);
  assert.equal(b.get("p/newer").s, "rate");
  assert.equal(b.get("p/newer").l, 1);
  assert.equal(b.get("p/tie").s, "ok", "a tie goes to the probe record");
  assert.equal(b.get("p/tie").l, undefined);
  assert.equal(b.get("p/older").s, "ok", "an overlay entry older than the probe record is ignored");
  assert.equal(b.get("p/skip").s, "pay", "a skip never beats a live record");
  assert.equal(b.get("p/untouched").s, "auth");
  assert.equal(b.get("p/only").s, "error");
  assert.equal(b.get("p/none"), null);
  assert.deepEqual(["p/newer", "p/tie", "p/older", "p/skip", "p/untouched", "p/only"].map((k) => b.get.isLive(k)), [true, false, false, true, false, true]);
  assert.equal(b.live, 3);
  assert.equal(b.liveAt, NOW - 30, "the newest live record's time");
  assert.equal(b.get.records, 6, "the union of the key sets: 5 probe keys plus the one only the overlay knows");
  assert.equal(b.size, 6);
  // the probe reader is the probe file alone; `{ observed: false }` is the same view
  assert.equal(b.probe("p/newer").s, "ok");
  assert.equal(b.probe("p/only"), null);
  assert.equal(loadBench(bf, { observed: false }).get("p/newer").s, "ok");
  assert.equal(loadBench(bf, { observed: false }).size, 5);
  // metadata for the picker's notes
  assert.equal(b.overlay.feed, "ok");
  assert.equal(b.overlay.entries, 5);
  assert.equal(typeof b.overlay.writtenAt, "string");
}));

test("merge: a record dated in the future is ignored on either side; a live record's display time is its own", () => withDir((d, bf) => {
  put(d, "bench.json", bench({ "p/fp": { s: "ok", a: NOW + 9 * DAY }, "p/ok": { s: "ok", a: NOW - 1000 } }));
  put(d, "observed.json", overlay({ "p/fp": { s: "rate", a: NOW - 20 }, "p/fo": { s: "rate", a: NOW + 9 * DAY }, "p/ok": { s: "rate", a: NOW - 20 } }));
  const b = loadBench(bf);
  assert.equal(b.get("p/fp").s, "rate", "an unusable (future) probe record does not block a live one");
  assert.equal(b.get("p/fo"), null, "a future-dated overlay record is ignored");
  assert.equal(recordAge(b.get("p/ok"), NOW * 1000), 20, "the live record's own time is its age");
  assert.equal(b.live, 2);
}));

test("the sibling default: a temp bench file never reads the real overlay, and the overlay path can be named", () => withDir((d, bf) => {
  put(d, "bench.json", bench({ "p/a": { s: "ok", a: NOW - 5 } }));
  const seen = [];
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { seen.push(String(p)); return real(p, ...rest); };
  try { loadBench(bf); } finally { fs.readFileSync = real; }
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((p) => p.startsWith(d)), `only the temp directory was read: ${seen.join(", ")}`);
  const elsewhere = tmp();
  try {
    put(elsewhere, "custom.json", overlay({ "p/a": { s: "rate", a: NOW } }));
    assert.equal(loadBench(bf, { observed: path.join(elsewhere, "custom.json") }).get("p/a").s, "rate");
  } finally { done(elsewhere); }
}));

// ---------------------------------------------------------------- age credit is from probes only

test("a live record never refreshes `oldest probe`, the age histogram or the outdated notice; get.stamp is the probe's", () => withDir((d, bf) => {
  const old = NOW - 10 * DAY;
  put(d, "bench.json", bench({ "p/a": { s: "ok", a: old }, "p/b": { s: "ok", a: old + 60 } }));
  put(d, "observed.json", overlay({ "p/a": { s: "rate", a: NOW - 5 }, "p/c": { s: "ok", a: NOW - 5 } }));
  const merged = loadBench(bf), probe = loadBench(bf, { observed: false });
  const rows = [{ keyId: "personal.p.free", provider: "p", models: [M("a"), M("b"), M("c")] }];
  assert.equal(merged.get("p/a").s, "rate", "the row shows the live status");
  assert.equal(merged.get.stamp("p/a"), old, "but its stamp is the probe's");
  assert.equal(merged.get.stamp("p/c"), null, "and null for a key only the overlay knows");
  assert.equal(oldestStampOf(rows, merged.get, NOW * 1000), oldestStampOf(rows, probe.get, NOW * 1000));
  assert.deepEqual(ageHistOf("p", rows[0].models, merged.get, NOW * 1000), ageHistOf("p", rows[0].models, probe.get, NOW * 1000));
  const hist = ageHistOf("p", rows[0].models, merged.get, NOW * 1000);
  assert.equal(hist.reduce((n, [, c]) => n + c, 0), 2, "two probe records; the live-only key adds none");
  assert.equal(outdatedNotice(new Date(old * 1000).toISOString(), [hist], NOW * 1000) !== null, true, "the notice still fires: the live flips did not refresh anything");
  // the counts DO see the live status (they are counts of what is drawn, with their own population)
  assert.deepEqual([countStatuses("p", rows[0].models, merged.get, NOW * 1000).rate, countStatuses("p", rows[0].models, merged.get, NOW * 1000).ok], [1, 2]);
}));

// ------------------------------------------------------------- flags and shapes

test("the live flags survive cleanRecord (l, q, v, cf, cfa) and add nothing when absent; a hand-edited bench.json cannot make a row live", () => withDir((d, bf) => {
  const plain = { s: "ok", t: 5, d: 9, r: 1, o: 2, a: NOW, p: "hi", k: 0, w: "" };
  const before = cleanRecord(plain);
  assert.deepEqual(Object.keys(before).sort(), ["a", "d", "k", "o", "p", "r", "s", "t", "w"], "today's exact shape");
  assert.deepEqual(cleanRecord({ ...plain, l: 1, q: "9f2c", v: 1, cf: 1, cfa: 12 }), { ...before, l: 1, q: "9f2c", v: 1, cf: 1, cfa: 12 });
  for (const junk of [{ l: 2 }, { l: true }, { l: "1" }, { v: 0 }, { cf: 2 }, { q: 5 }, { q: "" }]) assert.deepEqual(cleanRecord({ ...plain, ...junk }), before, JSON.stringify(junk));
  assert.deepEqual(cleanRecord({ ...plain, cf: 1, cfa: -3 }), { ...before, cf: 1 });
  assert.equal(isLive({ l: 1 }), true);
  assert.equal(isLive({}), false);
  assert.equal(isLive(null), false);
  // through the merge
  put(d, "bench.json", bench({ "p/fake": { s: "ok", a: NOW - 50, l: 1, q: "x", v: 1, cf: 1 } }));
  put(d, "observed.json", overlay({ "p/real": { s: "ok", a: NOW - 5, q: "req-1", v: 1, cf: 1, cfa: NOW - 4, t: 400, d: 900, o: 7, p: "hello there" } }));
  const b = loadBench(bf);
  assert.deepEqual(b.get("p/fake"), cleanRecord({ s: "ok", a: NOW - 50 }), "the probe side carries no live flags");
  assert.equal(b.get.isLive("p/fake"), false);
  const r = b.get("p/real");
  assert.deepEqual([r.l, r.q, r.v, r.cf, r.cfa, r.t, r.d, r.o, r.p], [1, "req-1", 1, 1, NOW - 4, 400, 900, 7, "hello there"]);
}));

test("the sweep's writer never emits an overlay flag: toStored has no l, q, v, cf or cfa", () => {
  const out = toStored({ s: "ok", t: 5, d: 9, a: NOW, p: "x", l: 1, q: "req", v: 1, cf: 1, cfa: 3 });
  for (const f of ["l", "q", "v", "cf", "cfa"]) assert.equal(Object.hasOwn(out, f), false, f);
  assert.deepEqual(Object.keys(out).sort(), ["a", "d", "p", "s", "t"]);
});

// ---------------------------------------------------------------- hostile content

test("every overlay field is rebuilt from a closed vocabulary: statuses, numbers, capped sanitized text, hostile keys", () => withDir((d, bf, of) => {
  const ESC = "\x1b[2J\x1b]0;PWN\x07\x1b[31m";
  // A secret-shaped string, assembled at run time so no scanner sees a literal in the source.
  const FAKE_KEY = "sk" + "-" + "ABCDEF0123456789" + "ABCDEF0123456789";
  assert.equal(redactClip(FAKE_KEY, 200).includes("ABCDEF0123456789"), false, "sanity: the redaction masks the built string");
  put(d, "bench.json", bench({}));
  const models = {
    "p/evil": { s: "rate", a: NOW - 5, m: ESC + "Rate limit " + FAKE_KEY + " see https://user:pw@example.com/x?token=abc " + "y".repeat(5000),
                p: ESC + "q".repeat(500), w: "w".repeat(400), q: ESC + "r".repeat(300), t: -5, d: NaN, r: "9", o: 7.5, extra: "not a field", url: "http://x" },
    "p/skip": { s: "skip", a: NOW },
    "p/status": { s: "weird", a: NOW },
    "p/nostatus": { a: NOW },
    "p/badA": { s: "ok", a: "9" },
    "p/negA": { s: "ok", a: -4 },
    "p/zeroA": { s: "ok", a: 0 },
    "p/nanA": { s: "ok", a: null },
    "p/arr": ["ok"],
    "p/null": null,
    "p/str": "ok",
    "p/proto": { s: "ok", a: NOW - 1 },
    ["k".repeat(300)]: { s: "ok", a: NOW - 1 },
  };
  Object.defineProperty(models, "__proto__", { value: { s: "rate", a: NOW - 1 }, enumerable: true, configurable: true, writable: true });   // an OWN key, as JSON.parse makes one
  fs.writeFileSync(of, JSON.stringify(overlay(models)));
  assert.ok(fs.readFileSync(of, "utf8").includes('"__proto__":{'), "the file really carries the hostile key");
  const o = loadObserved(of);
  assert.ok(o);
  assert.deepEqual([...o.models.keys()].sort(), ["__proto__", "p/evil", "p/proto"].sort());
  assert.equal(o.dropped, 11, "every refused entry is counted");
  const ev = o.models.get("p/evil");
  assert.deepEqual(Object.keys(ev).sort(), ["a", "l", "m", "o", "p", "q", "s", "w"].sort(), "known fields only; negative, NaN and string numbers are dropped");
  assert.equal(ev.o, 7.5);
  assert.equal(ev.l, 1);
  for (const k of ["m", "p", "w", "q"]) assert.equal(/[\x00-\x08\x0b-\x1f\x7f\x1b]/.test(ev[k]), false, `${k} has no control byte`);
  assert.ok(ev.m.length <= 160 && ev.p.length <= 120 && ev.w.length <= 20 && ev.q.length <= 40, "capped");
  // through the reader: redacted a second time, never a secret or a link
  const b = loadBench(bf);
  const r = b.get("p/evil");
  assert.equal(new RegExp(FAKE_KEY.slice(3, 15) + "|user:pw|token=abc").test(JSON.stringify(r)), false, JSON.stringify(r));
  assert.ok(r.m.length <= 160);
  // a `__proto__` key is just a key, and Object.prototype is untouched
  assert.equal(b.get("__proto__").s, "rate");
  assert.equal({}.s, undefined);
  assert.equal(Object.getPrototypeOf(o.models.get("__proto__")), Object.prototype);
}));

test("the closed status vocabulary is the bench vocabulary without skip, and cleanObservedRecord only ever emits known fields", () => {
  assert.deepEqual([...OBSERVED_STATUSES].sort(), STATUSES.filter((s) => s !== "skip").sort());
  for (const s of OBSERVED_STATUSES) assert.equal(cleanObservedRecord({ s, a: NOW })?.s, s);
  for (const bad of ["skip", "", "OK", "ok ", null, undefined, 5, {}, ["ok"], "constructor", "__proto__"]) assert.equal(cleanObservedRecord({ s: bad, a: NOW }), null, String(bad));
  const known = new Set(["s", "t", "d", "r", "o", "a", "p", "k", "w", "m", "b", "x", "l", "q", "v", "cf", "cfa"]);
  const all = cleanObservedRecord({ s: "ok", a: NOW, t: 1, d: 2, r: 3, o: 4, p: "p", k: 1, w: "w", m: "m", b: 96, x: 1, l: 0, q: "q", v: 1, cf: 1, cfa: 9, zzz: 1 });
  for (const f of Object.keys(all)) assert.ok(known.has(f), f);
  assert.equal(all.l, 1, "l is forced: everything in the overlay was observed live");
});

test("size and count caps: over the entry cap only the newest survive; a big but legal file still reads", () => withDir((d, bf, of) => {
  const models = {};
  for (let i = 0; i < OBSERVED_MAX_ENTRIES + 50; i++) models[`p/m${i}`] = { s: "rate", a: NOW - 10_000 + i };
  fs.writeFileSync(of, JSON.stringify(overlay(models)));
  const o = loadObserved(of);
  assert.equal(o.models.size, OBSERVED_MAX_ENTRIES);
  assert.equal(o.dropped, 50);
  assert.equal(o.models.has("p/m0"), false, "the oldest are the ones dropped");
  assert.equal(o.models.has(`p/m${OBSERVED_MAX_ENTRIES + 49}`), true);
  assert.ok(fs.statSync(of).size < OBSERVED_MAX_BYTES);
}));

test("the envelope: feed, writtenAt, wm and prov are rebuilt too", () => withDir((d, bf, of) => {
  put(d, "observed.json", overlay({ "p/a": { s: "ok", a: NOW } }, {
    feed: "\x1b[31mpwned", writtenAt: "yesterday", wm: { id: "7", seq: -1, at: "x" },
    prov: { "personal.p.free": { bench: { ok: 3, rate: -1, weird: 9, skip: 2 }, benchFlags: { dead: false, alive: "yes", status: "alive" }, benchAgeHist: [[490000, 3], ["x", 1], [1, 0]], live: 2, liveOk: 1 },
            ["k".repeat(300)]: { bench: {} }, bad: 5 } }));
  const o = loadObserved(path.join(d, "observed.json"));
  assert.equal(o.feed, "ok", "an unknown feed word is the neutral one");
  assert.equal(o.writtenAt, null);
  assert.deepEqual(o.wm, { id: null, seq: null, at: null });
  assert.equal(o.prov.size, 1);
  assert.deepEqual(o.prov.get("personal.p.free"), { bench: { ok: 3, skip: 2 }, benchFlags: { dead: false, status: "alive" }, benchAgeHist: [[490000, 3]], live: 2, liveOk: 1 });
  put(d, "observed.json", overlay({}, { feed: "unavailable:locked", writtenAt: "2026-09-30T08:12:03.120Z", prov: "junk" }));
  const o2 = loadObserved(path.join(d, "observed.json"));
  assert.equal(o2.prov, null);
  assert.equal(o2.writtenAt, "2026-09-30T08:12:03.120Z");
  assert.equal(o2.models.size, 0);
}));

test("feedNote: words for each unhealthy feed, nothing for a healthy one, never the file's own text", () => {
  assert.equal(feedNote(null), null);
  assert.equal(feedNote({ feed: "ok" }), null);
  assert.equal(feedNote({ feed: "warn:key-mapping" }), "live feed: key mapping changed");
  assert.equal(feedNote({ feed: "unavailable:schema" }), "live feed unavailable (schema changed)");
  assert.equal(feedNote({ feed: "unavailable:missing" }), "live feed unavailable (no router data)");
  assert.equal(feedNote({ feed: "unavailable:node-sqlite" }), "live feed unavailable (no node:sqlite)");
  assert.equal(feedNote({ feed: "unavailable:locked", writtenAt: "2026-09-30T08:12:03.120Z" }), "live feed: locked, showing the last update 08:12Z");
  assert.equal(feedNote({ feed: "unavailable:locked", writtenAt: "\x1b[2Jnope" }), "live feed: locked");
  assert.equal(feedNote({ feed: "\x1b[2J" }), null);
});

// ------------------------------------------------------------------ laziness and the import graph

test("nothing reads bench.json or observed.json at startup: importing the modules and drawing the first frame read neither", () => {
  const snap = { schemaVersion: 9, generatedAt: "x", builtAt: "x", rows: [{ keyId: "personal.p.free", provider: "p", free: 0, planCount: 0, health: "ok", models: [M("a")] }] };
  const seen = [];
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...rest) => { seen.push(String(p)); return real(p, ...rest); };
  try { firstFrame({ snap, recents: [], favourites: [], caps: detectCaps({ TERM: "dumb" }, 100), termRows: 30 }); } finally { fs.readFileSync = real; }
  assert.equal(seen.some((p) => /bench\.json|observed\.json|observe\.off/.test(p)), false, `read at startup: ${seen.join(", ")}`);
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "menu", "uwpick.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal((src.match(/\bloadBench\(/g) ?? []).length, 1, "still one loadBench call site");
  assert.equal((src.match(/\bloadObserved\(/g) ?? []).length, 0, "uwpick never calls the reader itself");
  assert.equal((src.match(/\bopenOverlay\(/g) ?? []).length, 1, "the overlay is read once at open (stat first)");
  assert.equal((src.match(/\bdecideOverlayReload\(/g) ?? []).length, 1, "and re-read only through the reload decision");
});

test("observed-data.mjs is import-light and in the picker's graph, which still reaches nothing under refresh/ or keysync/", () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const own = fs.readFileSync(path.join(root, "menu", "observed-data.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  const imports = [...own.matchAll(/^\s*import\b[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./atomic.mjs", "./sanitize.mjs", "node:fs", "node:os", "node:path"], "fs, path, os, atomic and sanitize only");
  assert.equal(/\b(writeFileSync|writeAtomic|renameSync|unlinkSync|rmSync|appendFileSync|mkdirSync)\b/.test(own), false, "the reader never writes");
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    for (const m of src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["'](\.[^"']+)["']/gm)) walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(path.join(root, "menu", "uwpick.mjs"));
  const rel = [...seen].map((f) => path.relative(root, f).replaceAll("\\", "/"));
  assert.ok(rel.includes("menu/observed-data.mjs"), rel.join(", "));
  for (const f of rel) assert.doesNotMatch(f, /^(refresh|keysync)\//, f);
});

test("the default overlay path is beside bench.json in the state directory", async () => {
  const { OBSERVED_FILE } = await import("../menu/observed-data.mjs");
  const { BENCH_FILE } = await import("../menu/bench-data.mjs");
  assert.equal(path.dirname(OBSERVED_FILE), path.dirname(BENCH_FILE));
  assert.equal(path.basename(OBSERVED_FILE), "observed.json");
  assert.equal(benchKey("p", "x[1m]"), "p/x");
});

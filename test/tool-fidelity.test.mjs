// The tool-fidelity store, derivation, two strikes, size caps, queue, estimates and the flip diff. Offline: fixtures only, in temp directories.
// ISOLATION BY CONSTRUCTION: every write goes to a file under os.tmpdir(), and the writer's notion of "the real file" (`realFile`) is ALSO a temp
// file, so nothing in this file can name the user's real state file as a write target. `guardRealState` throws on any write under it anyway.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync as rawExists } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { guardRealState } from "./fixtures/no-real-state.mjs";
import { realFileState } from "./fixtures/real-file-state.mjs";
import { freshDir, checkTmpDir, record } from "./fixtures/tool-fidelity-helpers.mjs";
import {
  contiguous, outOfOrder, lvOf, classOf, compiledClass, cellOf, cleanFidelity, loadFidelity, saveFidelity, capRecords, renderFile, buildRecord, mergeRecord,
  probeSet, fidelityCounts, queueFor, failedLevels, selectOnly, limitEntries, estimate, paidFallback, applyProviderCap, flipDiff, requeueL3Failures, rankInV, payloadCapOf,
  capBelowFor, isProvisional, keyOk, REAL_FILE, FILE_NAME, KIND, MAX_FILE_BYTES, MAX_READ_BYTES,
  summaryOf, liftDeepProbes, clampDeep, restrictToFree, coverage, coverageLines, orderCosts, wallEstimate, levelCosts,
} from "../refresh/tool-fidelity.mjs";
import { FIXTURE_ID } from "../refresh/tool-fidelity-fixture.mjs";
import { kindsOf } from "../refresh/tool-fidelity-probe.mjs";
import { funnel, fnv1a32 } from "../menu/subagent-funnel.mjs";
import { RELAY_KEY_ID } from "../menu/tiers.mjs";
import { loadBench } from "../menu/bench-data.mjs";
import { compact, createLogWriter } from "../refresh/bench-store.mjs";

const REAL_BEFORE = realFileState(REAL_FILE);                  // taken BEFORE the real-state guard is installed (the comparison after the run is a hook that runs after the guard's own)
const touched = guardRealState(after, assert);
// the end of the run: the real state file is exactly as it was before it
after(() => { assert.equal(realFileState(REAL_FILE), REAL_BEFORE, "the real state/tool-fidelity.json is still there (or still absent): a test never creates or deletes it"); });
const NOW = new Date("2026-10-05T10:00:00.000Z");
const at = (ms) => new Date(NOW.getTime() + ms);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const rec = (lvr, extra) => record(lvr, extra, NOW);
// the writer's options for a temp target: `realFile` is a different temp file, so the writer's own real-file guard is exercised without the real one
const opts = (d, extra = {}) => ({ realFile: path.join(d, "the-real-one", FILE_NAME), now: NOW, ...extra });
const run = (prior, done, extra) => buildRecord(prior, done, { now: NOW, ...extra });
const P = { v: "p" }, F = (why = "boom", kind) => ({ v: "f", why, ...(kind ? { kind } : {}) });

// ---------------------------------------------------------------- derivation

test("derivation over EVERY lvr of length 4 over p/f/n (81 strings): digit, class, lv and ok follow the plan's table", () => {
  const all = [];
  for (const a of "pfn") for (const b of "pfn") for (const c of "pfn") for (const d of "pfn") all.push(a + b + c + d);
  assert.equal(all.length, 81);
  for (const lvr of all) {
    const r = { lvr, fx: FIXTURE_ID, t: classOf(lvr) };
    const k = lvr[0] === "p" ? [...lvr].findIndex((c) => c !== "p") : 0;
    const run = k === -1 ? 4 : k;                                       // levels passed in a row, by an independent reading of the string
    const digit = lvr[0] === "f" ? "x" : lvr[0] === "n" ? "-" : String(Math.max(1, run));
    assert.equal(cellOf(r), digit, `cell of ${lvr}`);
    const want = lvr[0] === "n" ? "u" : run >= 3 ? "v" : run === 2 ? "t" : "x";
    assert.equal(classOf(lvr), want, `class of ${lvr}`);
    assert.equal(classOf({ lvr }), want, `class of the bare record ${lvr}`);
    assert.equal(lvOf(lvr), run >= 4 ? 4 : run === 3 ? 3 : run === 2 ? 1 : 0, `lv of ${lvr}`);
    assert.deepEqual(cleanFidelity(rec(lvr)), rec(lvr), `${lvr} round-trips through the cleaner`);
  }
});

test("the plan's cell table, by name: x, 1, 2, 3, 4, - and the L4-without-L3 case", () => {
  const cell = (lvr) => cellOf({ lvr, fx: FIXTURE_ID });
  assert.deepEqual(["fnnn", "pfnn", "ppfn", "pppf", "pppp", "nnnn", "ppfp"].map(cell), ["x", "1", "2", "3", "4", "-", "2"]);
  assert.deepEqual(["fnnn", "pfnn", "ppfn", "pppf", "pppp", "nnnn", "ppfp"].map(classOf), ["x", "x", "t", "v", "v", "u", "t"], "1 compiles as x (L1 AND L2 are needed); 2 as t; 3 and 4 as v");
  assert.deepEqual(outOfOrder("ppfp"), [4]);
  assert.deepEqual(outOfOrder("pppp"), []);
  assert.deepEqual(outOfOrder("pfpp"), [3, 4]);
});

test("TWO STRIKES in the class: a confirmed L3 failure that is NOT about size is x; with a size cap it is t; with one strike or no strikes it is t; a size refusal never makes x", () => {
  assert.equal(classOf({ lvr: "ppfn", strikes: 2, sl: 3 }), "x", "confirmed schema failure at L3");
  assert.equal(classOf({ lvr: "ppfp", strikes: 2, sl: 3 }), "x", "L4 passing does not rescue it");
  assert.equal(classOf({ lvr: "ppfn", strikes: 2, sl: 3, capBelow: 150000 }), "t", "refused for SIZE: the model works at small size");
  assert.equal(classOf({ lvr: "ppfn", strikes: 1, sl: 3 }), "t", "one strike: provisional, the class stays as before");
  assert.equal(classOf({ lvr: "ppfn" }), "t", "an L3 failure with no strike record keeps the old reading");
  assert.equal(classOf({ lvr: "nnnn", strikes: 1, sl: 1 }), "u", "a first L1 failure of a model never tested: still untested");
  assert.equal(cellOf({ lvr: "ppfn", strikes: 2, sl: 3, fx: FIXTURE_ID }), "x", "the picker shows what the compiler does");
  assert.equal(cellOf({ lvr: "ppfn", strikes: 2, sl: 3, capBelow: 150000, fx: FIXTURE_ID }), "2");
  assert.equal(isProvisional({ strikes: 1, sl: 1 }), true);
  assert.equal(isProvisional({ strikes: 2, sl: 1 }), false);
});

test("an outdated fixture adds only the `*`: the digit and the class are the LAST result, never `u`", () => {
  const r = { lvr: "pppp", fx: "cc-tools-0", t: "v" };
  assert.equal(cellOf(r), "4*");
  assert.equal(cellOf({ lvr: "ppnn", fx: "cc-tools-0" }), "2*");
  assert.equal(cellOf({ lvr: "fnnn", fx: "cc-tools-0" }), "x*");
  assert.equal(cellOf({ lvr: "nnnn", fx: "cc-tools-0" }), "-", "nothing run is `-` with or without a fixture");
  assert.equal(compiledClass(r), "v");
  assert.equal(cellOf(null), "-");
});

test("an alias row shows its digit but compiles at most `u`; a failed alias stays `x`", () => {
  assert.equal(compiledClass({ t: "v", alias: true }), "u");
  assert.equal(compiledClass({ t: "t", alias: true }), "u");
  assert.equal(compiledClass({ t: "x", alias: true }), "x");
  assert.equal(compiledClass({ t: "v" }), "v");
  assert.equal(cellOf({ lvr: "pppp", fx: FIXTURE_ID, alias: true }), "4");
});

// ---------------------------------------------------------------- building a record: two strikes, size caps, the big step

test("buildRecord writes lvr, lv, t and ok together; L3 refused for SIZE with L4 failing writes lvr `ppff`, class `t` and a payload cap; L4 PASSING at that size contradicts the refusal", () => {
  const r = run(null, { 1: P, 2: P, 3: { v: "f", why: "HTTP 413: too large", kind: "size", bytes: 156892 }, 4: { v: "f", why: "HTTP 413", kind: "size", bytes: 156947 } });
  assert.equal(r.lvr, "ppff");
  assert.equal(r.t, "t");
  assert.equal(r.lv, 1, "lv counts levels passed in a row: L1 and L2");
  assert.equal(r.ok, true);
  assert.equal(r.why, "L3: HTTP 413: too large");
  assert.equal(r.capBelow, 150000, "just under the size that was refused");
  assert.equal(r.strikes, undefined, "a size refusal is not a strike");
  assert.equal(payloadCapOf(r), 150000);
  assert.deepEqual(cleanFidelity(r), r, "the writer's own record is accepted by the cleaner");
  const odd = run(null, { 1: P, 2: P, 3: { v: "f", why: "HTTP 413: too large", kind: "size", bytes: 156892 }, 4: { v: "p", bytes: 156947 } });
  assert.deepEqual([odd.lvr, odd.t, odd.capBelow, odd.maxBytes], ["ppfp", "t", undefined, 156947], "a request of that size WAS answered: the refusal was the moment, so no cap is claimed; the class is still t");
});

test("TWO STRIKES: the first L1/L2 failure is provisional (the model stays untested and queued), the second CONFIRMS it as x; a pass in between clears the strike", () => {
  const first = run(null, { 1: P, 2: F("no final answer") });
  assert.deepEqual([first.lvr, first.t, first.strikes, first.sl, first.ok], ["nnnn", "u", 1, 2, false], "the L1 pass is not kept beside an unconfirmed L2 failure");
  assert.equal(first.why, "L2: no final answer");
  assert.deepEqual(cleanFidelity(first), first);
  const second = run(first, { 1: P, 2: F("no final answer") }, { now: at(1000) });
  assert.deepEqual([second.lvr, second.t, second.strikes, second.sl, second.ok], ["pfnn", "x", 2, 2, false]);
  assert.deepEqual(cleanFidelity(second), second);
  const cleared = run(first, { 1: P, 2: P }, { now: at(1000) });
  assert.deepEqual([cleared.lvr, cleared.t, cleared.strikes], ["ppnn", "t", undefined], "it passed the second time: no strike left");
  const other = run(first, { 1: F("now L1"), 2: P }, { now: at(1000) });
  assert.deepEqual([other.lvr, other.strikes, other.sl], ["nnnn", 1, 1], "a failure at a DIFFERENT level is a first strike of its own, not a confirmation");
});

test("TWO STRIKES for L3: a first schema failure keeps the class t and the L4 result; the second makes it x; a size refusal at L3 is never a strike", () => {
  const pp = rec("ppnn");
  const first = run(pp, { 3: F("HTTP 400: unsupported keyword anyOf", "schema"), 4: P });
  assert.deepEqual([first.lvr, first.t, first.strikes, first.sl], ["ppnp", "t", 1, 3], "L4 learned something and keeps it; L3 stays `n`, so it is asked again");
  const second = run(first, { 3: F("HTTP 400: unsupported keyword anyOf", "schema") }, { now: at(1000) });
  assert.deepEqual([second.lvr, second.t, second.strikes, second.ok], ["ppfp", "x", 2, false]);
  const size = run(pp, { 3: { v: "f", why: "HTTP 413", kind: "size", bytes: 156892 } });
  assert.deepEqual([size.lvr, size.t, size.strikes, size.capBelow], ["ppfn", "t", undefined, 150000]);
  const passAfter = run(first, { 3: { v: "p", bytes: 156892 } }, { now: at(1000) });
  assert.deepEqual([passAfter.lvr, passAfter.t, passAfter.strikes], ["pppp", "v", undefined]);
});

test("the strike waits when a later probe does not look at the struck level; a pass at the struck level clears it", () => {
  const first = run(rec("ppnn"), { 3: F("x", "schema") });
  const other = run(first, { 4: P }, { now: at(1000) });
  assert.deepEqual([other.strikes, other.sl, other.lvr], [1, 3, "ppnp"]);
});

test("the BIG step: stored in `big` (not in lvr); only after L3; a size refusal there sets capBelow near 400 KB and keeps the model v; L3 failing later drops it", () => {
  const v = rec("pppn");
  const pass = run(v, { 5: { v: "p", bytes: 399900 } });
  assert.deepEqual([pass.lvr, pass.big, pass.t, pass.maxBytes, pass.capBelow], ["pppn", "p", "v", 399900, undefined]);
  const refused = run(v, { 5: { v: "f", why: "HTTP 400: request too large", kind: "size", bytes: 399900 } });
  assert.deepEqual([refused.lvr, refused.big, refused.t, refused.capBelow, refused.strikes], ["pppn", "f", "v", 390000, undefined]);
  assert.equal(refused.why, "L5: HTTP 400: request too large");
  assert.equal(capBelowFor(399900), 390000);
  assert.equal(capBelowFor(156892), 150000);
  assert.equal(capBelowFor(400000), 390000, "strictly under the size that failed");
  assert.equal(run(rec("ppnn"), { 5: P }), null, "a big step with no L3 pass behind it is not a result");
  const gone = run(pass, { 3: { v: "f", why: "now fails", kind: "size", bytes: 156892 } }, { now: at(1000) });
  assert.equal(gone.big, undefined, "big means nothing once L3 does not pass");
  const stale = run(refused, { 5: { v: "p", bytes: 399900 } }, { now: at(1000) });
  assert.equal(stale.capBelow, undefined, "a pass beyond the recorded refusal contradicts it");
  assert.deepEqual(cleanFidelity(refused), refused);
  assert.equal(cleanFidelity({ ...refused, big: "x" }), null);
});

test("no level ran: no record (never a row of `n` characters); an `n` level asked but skipped does not count as a result", () => {
  assert.equal(run(null, {}), null);
  assert.equal(run(null, { 3: { v: "n" }, 4: { v: "n" } }), null);
  assert.equal(run(rec("fnnn", { strikes: 2, sl: 1 }), { 3: { v: "n" } }), null);
});

test("partial merge: a later pass that runs only L3 and L4 keeps the L1 and L2 results and the fixture rule holds", () => {
  const first = run(null, { 1: P, 2: P }, { fixtureId: "cc-tools-0" });
  assert.equal(first.lvr, "ppnn");
  const second = run(first, { 3: { v: "p", bytes: 150000 }, 4: { v: "p", bytes: 150000 } }, { now: at(1000), fixtureId: "cc-tools-1" });
  assert.equal(second.lvr, "pppp");
  assert.equal(second.fx, "cc-tools-1", "L3 and L4 ran against the new fixture");
  const third = run(second, { 1: P, 2: P }, { now: at(2000), fixtureId: "cc-tools-2" });
  assert.equal(third.fx, "cc-tools-1", "re-running only L1 and L2 does not relabel an L3/L4 result as measured against the newer fixture");
  assert.equal(third.maxBytes, 150000, "the largest answered size is kept");
});

test("cleanFidelity accepts lvr of exactly four characters over p/f/n and rejects every malformed one", () => {
  const good = rec("ppnn");
  assert.ok(cleanFidelity(good));
  for (const bad of ["ppn", "ppnnn", "ppnx", "PPNN", "pp nn", "", null, 42, ["p", "p", "n", "n"], undefined]) assert.equal(cleanFidelity({ ...good, lvr: bad }), null, `lvr ${JSON.stringify(bad)}`);
  const { lvr, ...noLvr } = good;
  assert.equal(cleanFidelity(noLvr), null, "a missing lvr makes the record invalid: there is NO coarse fallback from lv");
});

test("cleanFidelity rejects unknown fields, out-of-range values, an inconsistent strike pair, and a t, lv or ok that is not what the fields derive", () => {
  const good = rec("pppp");
  assert.ok(cleanFidelity(good));
  for (const [name, bad] of Object.entries({
    "unknown field": { ...good, extra: 1 }, "t disagrees": { ...good, t: "x" }, lv: { ...good, lv: 1 }, ok: { ...good, ok: false }, at: { ...good, at: "yesterday" },
    "fx space": { ...good, fx: "has space" }, "fx empty": { ...good, fx: "" }, "maxBytes <0": { ...good, maxBytes: -1 }, "maxBytes big": { ...good, maxBytes: 4_000_001 },
    "maxBytes frac": { ...good, maxBytes: 1.5 }, alias: { ...good, alias: "yes" }, why: { ...good, why: 5 }, big: { ...good, big: "q" }, capBelow0: { ...good, capBelow: 0 },
    capBelowBig: { ...good, capBelow: 4_000_001 }, "strikes alone": { ...good, strikes: 1 }, "sl alone": { ...good, sl: 1 }, "strikes 3": { ...good, strikes: 3, sl: 1 }, "sl 4": { ...good, strikes: 1, sl: 4 },
  })) assert.equal(cleanFidelity(bad), null, name);
  const sized = rec("ppfn", { strikes: 2, sl: 3, capBelow: 150000 });
  assert.equal(sized.t, "t");
  assert.deepEqual(cleanFidelity(sized), sized, "a confirmed L3 failure WITH a size cap is class t, and the cleaner agrees");
  assert.equal(cleanFidelity({ ...sized, t: "x" }), null);
  const x = rec("ppfn", { strikes: 2, sl: 3 });
  assert.equal(x.t, "x");
  assert.equal(cleanFidelity({ ...x, t: "t" }), null, "t must be what the strikes derive");
  for (const bad of [[], null, "pppp", 7]) assert.equal(cleanFidelity(bad), null);
});

test("cleanFidelity redacts and clips a stored reason again on load (the fake key is built at run time)", () => {
  const fake = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
  const r = cleanFidelity({ ...rec("fnnn", { strikes: 2, sl: 1 }), why: `L1: ${"z".repeat(300)} ${fake}` });
  assert.ok(r.why.length <= 160);
  assert.ok(!r.why.includes(fake.slice(0, 12)));
});

test("mergeRecord: a fresher result replaces; a result older than the stored one does not clobber it", () => {
  const old = record("pppp", {}, new Date("2026-10-01T00:00:00Z")), fresh = record("fnnn", { strikes: 2, sl: 1 }, new Date("2026-10-05T00:00:00Z"));
  assert.equal(mergeRecord(old, fresh), fresh);
  assert.equal(mergeRecord(fresh, old), fresh, "a late-finishing older run");
  assert.equal(mergeRecord(undefined, old), old);
});

test("requeueL3Failures: a provider's L3 failures (and a pending L3 strike) go back to `n` with the size cap; other levels, other providers and passes are untouched", () => {
  const store = {
    "fa/size": rec("ppfn", { capBelow: 150000 }), "fa/schema": rec("ppfn", { strikes: 2, sl: 3, why: "L3: schema" }), "fa/pend": rec("ppnn", { strikes: 1, sl: 3 }),
    "fa/pass": rec("pppp"), "fa/x1": rec("fnnn", { strikes: 2, sl: 1, why: "L1: no" }), "fb/size": rec("ppfn", { capBelow: 150000 }), "fa/l4": rec("pppf", { why: "L4: one call" }),
  };
  const out = requeueL3Failures(store, "fa");
  assert.deepEqual(Object.keys(out).sort(), ["fa/pend", "fa/schema", "fa/size"]);
  assert.deepEqual([out["fa/size"].lvr, out["fa/size"].capBelow, out["fa/size"].t], ["ppnn", undefined, "t"]);
  assert.deepEqual([out["fa/schema"].lvr, out["fa/schema"].strikes, out["fa/schema"].t, out["fa/schema"].why], ["ppnn", undefined, "t", undefined], "the failure it came from is gone, so is its reason");
  assert.deepEqual([out["fa/pend"].lvr, out["fa/pend"].strikes], ["ppnn", undefined]);
  assert.equal(JSON.stringify(store["fb/size"]), JSON.stringify(rec("ppfn", { capBelow: 150000 })), "the input is not changed");
  assert.deepEqual(Object.keys(requeueL3Failures(store, "nope")), []);
  const q = queueFor({ models: [{ key: "fa/size", provider: "fa", id: "size", free: true }] }, { "fa/size": out["fa/size"] }, [3]);
  assert.deepEqual(q.map((e) => e.todo), [[3]], "and the next lazy L3 pass asks again");
});

// ---------------------------------------------------------------- the file

test("loadFidelity: absent is untested (never failed); corrupt, foreign and oversized files are reasons; bad records are rejected, kept raw and counted", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  assert.deepEqual(loadFidelity(f), { ok: true, absent: true, models: {}, rejected: {}, pending: {}, held: {}, generatedAt: null, dropped: 0 });
  fs.writeFileSync(f, "{not json");
  assert.deepEqual(loadFidelity(f), { ok: false, reason: "corrupt" });
  fs.writeFileSync(f, JSON.stringify({ schema: 1, models: {} }));
  assert.deepEqual(loadFidelity(f), { ok: false, reason: "schema" }, "no kind marker: not this file (bench.json has the same schema number)");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, kind: KIND, generatedAt: "2026-10-05T10:00:00.000Z", models: { "p/good": rec("ppnn"), "p/bad": { lvr: "ppnn" }, "p/newer": { ...rec("ppnn"), future: 1 }, "__proto__/x": rec("ppnn"), noslash: rec("ppnn") } }));
  const r = loadFidelity(f);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.models), ["p/good"]);
  assert.deepEqual(Object.keys(r.rejected).sort(), ["p/bad", "p/newer"], "records of a good key that this version could not read are handed back raw");
  assert.equal(r.dropped, 4);
  assert.equal(r.generatedAt, "2026-10-05T10:00:00.000Z");
  fs.writeFileSync(f, "﻿" + JSON.stringify({ schema: 1, kind: KIND, models: {} }));
  assert.equal(loadFidelity(f).ok, true, "a BOM from a PowerShell editor is tolerated");
  fs.writeFileSync(f, JSON.stringify({ schema: 1, kind: KIND, pad: "x".repeat(MAX_READ_BYTES), models: {} }));
  assert.deepEqual(loadFidelity(f), { ok: false, reason: "too-large" }, "a hostile or runaway file is never read into memory");
});

test("saveFidelity: atomic write, sorted keys, one record per line, no temp debris, stable bytes on a re-save, and the loader reads back every record", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  const models = { "b/two": rec("pppp", { big: "p" }), "a/one": rec("ppfp", { alias: true, capBelow: 150000 }), "c/three": rec("fnnn", { strikes: 2, sl: 1 }) };
  const r = saveFidelity(f, models, opts(d));
  assert.equal(r.records, 3);
  assert.deepEqual(fs.readdirSync(d), [FILE_NAME], "no .tmp debris");
  assert.equal(fs.readFileSync(f, "utf8").split("\n").length, 6, "header, three records, closer, trailing newline");
  const back = loadFidelity(f);
  assert.deepEqual(Object.keys(back.models), ["a/one", "b/two", "c/three"]);
  assert.deepEqual(back.models["a/one"], models["a/one"]);
  assert.deepEqual(back.models["b/two"], models["b/two"]);
  const h = sha(f);
  saveFidelity(f, back.models, opts(d));
  assert.equal(sha(f), h, "a no-change re-save is byte-identical");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).kind, KIND);
});

test("records this version could not read are KEPT by the next save, and replaced only by a valid record of the same key", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  const odd = { lvr: "ppnn", future: "field", at: "2026-10-05T10:00:00.000Z" };
  saveFidelity(f, { "p/ok": rec("ppnn") }, opts(d, { preserve: { "p/odd": odd, "p/replaced": odd } }));
  const first = loadFidelity(f);
  assert.deepEqual(Object.keys(first.rejected).sort(), ["p/odd", "p/replaced"]);
  assert.deepEqual(first.rejected["p/odd"], odd, "kept byte for byte");
  saveFidelity(f, { ...first.models, "p/replaced": rec("pppp") }, opts(d, { preserve: first.rejected }));
  const second = loadFidelity(f);
  assert.deepEqual(Object.keys(second.rejected), ["p/odd"], "a valid record replaces its raw twin");
  assert.equal(second.models["p/replaced"].t, "v");
});

test("a result NEVER expires by age: a record from years ago loads, cells and compiles exactly as written", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  saveFidelity(f, { "p/old": record("pppp", {}, new Date("2019-01-01T00:00:00Z")) }, opts(d, { now: new Date("2019-01-01T00:00:00Z") }));
  const r = loadFidelity(f).models["p/old"];
  assert.equal(r.t, "v");
  assert.equal(cellOf(r), "4");
  assert.equal(compiledClass(r), "v");
  assert.equal(r.at, "2019-01-01T00:00:00.000Z");
  assert.deepEqual(queueFor({ models: [{ key: "p/old", provider: "p", id: "old", free: true }] }, { "p/old": r }), [], "an old record is not re-queued either");
});

test("saveFidelity refuses a wrong file name, an existing file that is not this file, and 'the real file' without --live (the real file is a TEMP file here, by construction)", () => {
  const d = freshDir();
  assert.throws(() => saveFidelity(path.join(d, "bench.json"), {}, opts(d)), /only writes a file named tool-fidelity\.json/);
  const f = path.join(d, FILE_NAME);
  fs.writeFileSync(f, JSON.stringify({ schema: 1, generatedAt: "x", models: { "p/m": { s: "ok", a: 1 } } }));
  const h = sha(f);
  assert.throws(() => saveFidelity(f, {}, opts(d)), /exists and is not a tool-fidelity file/);
  assert.equal(sha(f), h, "the foreign file is untouched");
  fs.writeFileSync(f, "garbage");
  assert.throws(() => saveFidelity(f, {}, opts(d)), /not overwritten/);
  fs.rmSync(f);
  // the guard compares against `realFile`: name THIS file as the real one and the write is refused without live, allowed with it
  const guarded = { realFile: f, now: NOW };
  assert.throws(() => saveFidelity(f, { "p/m": rec("ppnn") }, guarded), /real state file is written only by a --live run/);
  assert.throws(() => saveFidelity(f, {}, { ...guarded, live: false }), /--live/);
  assert.equal(fs.existsSync(f), false, "nothing was written");
  saveFidelity(f, { "p/m": rec("ppnn") }, { ...guarded, live: true });
  assert.ok(loadFidelity(f).models["p/m"]);
  // the same file spelled another way is the same file (a relative or differently cased path cannot dodge the comparison)
  const alt = path.join(d, ".", "sub", "..", FILE_NAME);
  fs.rmSync(f);
  assert.throws(() => saveFidelity(alt, {}, guarded), /--live/);
});

test("the real-file comparison uses REAL paths: the same directory reached through a junction is the same file", () => {
  const d = freshDir(), real = path.join(d, "real"), link = path.join(d, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, "junction");
  const viaLink = path.join(link, FILE_NAME), asReal = path.join(real, FILE_NAME);
  assert.throws(() => saveFidelity(viaLink, { "p/m": rec("ppnn") }, { realFile: asReal, now: NOW }), /--live/, "spelled through the junction, it is still the real file");
  assert.throws(() => saveFidelity(asReal, {}, { realFile: viaLink, now: NOW }), /--live/, "and the other way round");
  assert.equal(fs.existsSync(asReal), false, "nothing was written");
  saveFidelity(viaLink, { "p/m": rec("ppnn") }, { realFile: path.join(d, "elsewhere", FILE_NAME), now: NOW });
  assert.ok(loadFidelity(asReal).models["p/m"], "a different 'real file' does not block it");
});

test("the default 'real file' is under the user's home state folder and is never written by this file: only its name and location are checked", () => {
  assert.equal(path.basename(REAL_FILE), FILE_NAME);
  assert.ok(REAL_FILE.toLowerCase().startsWith(path.join(os.homedir(), ".uw", "state").toLowerCase()));
});

test("the temp-directory guard of these tests refuses a non-empty directory and one outside the temp folder", () => {
  const d = freshDir();
  fs.writeFileSync(path.join(d, "x"), "1");
  assert.throws(() => checkTmpDir(d), /must be empty/);
  assert.throws(() => checkTmpDir(path.dirname(REAL_FILE)), /must be inside|must be empty/);
  assert.throws(() => checkTmpDir(os.homedir()), /must be inside/);
});

test("the real-state guard THROWS before a write under the real state folder lands (and only records a read)", () => {
  const touchedBefore = touched.length;
  const real = path.join(os.homedir(), ".uw", "state", "never-written-by-a-test.tmp");
  assert.throws(() => fs.writeFileSync(real, "x"), /refused: a test tried to write under the real state folder/);
  assert.throws(() => fs.mkdirSync(path.join(real, "d")), /refused/);
  assert.throws(() => fs.renameSync(path.join(freshDir(), "a"), real), /refused/);
  assert.throws(() => fs.rmSync(real, { force: true }), /refused/);
  assert.throws(() => fs.openSync(real, "w"), /refused/);
  assert.equal(rawExists(real), false, "nothing reached the file system");
  touched.length = touchedBefore;                                            // these touches were the point of the test, not a leak
});

test("saveFidelity retries a rename that is held for a moment, and gives up (throwing) on any other error", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  let calls = 0;
  const flaky = (file, text) => { if (++calls < 3) { const e = new Error("held"); e.code = "EPERM"; throw e; } fs.writeFileSync(file, text); };
  saveFidelity(f, { "p/m": rec("ppnn") }, opts(d, { writeImpl: flaky, retryMs: 1 }));
  assert.equal(calls, 3);
  assert.ok(loadFidelity(f).models["p/m"]);
  const dead = () => { const e = new Error("disk full"); e.code = "ENOSPC"; throw e; };
  assert.throws(() => saveFidelity(f, {}, opts(d, { writeImpl: dead })), /disk full/);
  let n = 0;
  const always = () => { n += 1; const e = new Error("held"); e.code = "EBUSY"; throw e; };
  assert.throws(() => saveFidelity(f, {}, opts(d, { writeImpl: always, retries: 2, retryMs: 1 })), /held/);
  assert.equal(n, 3, "the first try plus 2 retries");
  assert.ok(loadFidelity(f).models["p/m"], "the earlier file survived the failures");
});

test("capacity, not expiry: the cap is measured on the file AS WRITTEN; off-catalogue models go first, then the oldest, then records this version could not read", () => {
  const models = {};
  for (let i = 0; i < 40; i++) models[`p/m${i}`] = record("ppnn", {}, at(-i * 1000));
  const size = (m, now = NOW) => Buffer.byteLength(renderFile(Object.entries(m), now));
  assert.deepEqual(capRecords(models, { maxBytes: 1e9 }).dropped, []);
  const keep = new Set(Object.keys(models).filter((k) => k !== "p/m5" && k !== "p/m6"));
  const cap = size(models) - 300;
  const out = capRecords(models, { keep, maxBytes: cap });
  assert.ok(out.dropped.includes("p/m5") && out.dropped.includes("p/m6"), "gone-from-catalogue first");
  assert.ok(size(out.models) <= cap, "the kept records fit the cap exactly as rendered");
  assert.ok(size(out.models) > cap - 400, "and it did not throw away more than it had to");
  assert.equal(capRecords(models, { maxBytes: size(models) - 100 }).dropped[0], "p/m39", "else the oldest at");
  const withRaw = capRecords({ "p/a": rec("ppnn") }, { preserve: { "p/raw": { lvr: "ppnn", future: 1 } }, maxBytes: size({ "p/a": rec("ppnn") }) + 20 });
  assert.deepEqual([Object.keys(withRaw.models), Object.keys(withRaw.preserve)], [[], ["p/raw"]], "a record this version could not read (maybe a newer writer's) is the last to go");
});

test("the written file never passes MAX_FILE_BYTES, whatever the record sizes (measured on the bytes written, not an estimate)", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME);
  const models = {};
  for (let i = 0; i < 9000; i++) models[`prov${i % 50}/model-number-${i}`] = rec(i % 3 ? "pppp" : "ppfn", { big: "p", capBelow: i % 3 ? undefined : 150000, why: i % 3 ? undefined : `L3: ${"w".repeat(100)}` });
  const r = saveFidelity(f, models, opts(d));
  const bytes = fs.statSync(f).size;
  assert.equal(bytes, r.bytes);
  assert.ok(bytes <= MAX_FILE_BYTES, `${bytes} bytes written against a cap of ${MAX_FILE_BYTES}`);
  assert.ok(bytes > MAX_FILE_BYTES - 500, "and it filled the cap rather than stopping far short");
  assert.ok(r.dropped.length > 0 && loadFidelity(f).ok, "it dropped some, and the result is still a good file");
});

// ---------------------------------------------------------------- cr-M3: the bench never touches this file, and this file never touches the bench

test("bench machinery leaves tool-fidelity.json byte-identical, and a tool-fidelity write leaves bench data byte-identical (failing-first test of the cr-M3 loss mode)", () => {
  const d = freshDir(), f = path.join(d, FILE_NAME), bf = path.join(d, "bench.json"), lg = path.join(d, "bench.jsonl");
  const bench = { schema: 1, generatedAt: "2026-10-05T00:00:00.000Z", params: {}, models: { "p/m": { s: "ok", t: 400, a: 1790699779 } } };
  fs.writeFileSync(bf, JSON.stringify(bench));
  saveFidelity(f, { "p/m": rec("pppp") }, opts(d));
  const hf = sha(f), hb = sha(bf);
  loadBench(bf, { observed: false });
  assert.equal(sha(f), hf, "loadBench");
  compact({ keep: new Set(["p/m"]), ttlMs: 864e5 * 400, benchFile: bf, logFile: lg });
  assert.equal(sha(f), hf, "compact");
  const w = createLogWriter(lg);
  w.append("p/m", { s: "ok", t: 1, a: 1790699790 }); w.close();
  compact({ keep: new Set(["p/m"]), ttlMs: 864e5 * 400, benchFile: bf, logFile: lg });
  assert.equal(sha(f), hf, "a bench merge of a fresher record");
  const hb2 = sha(bf);
  saveFidelity(f, { "p/m": rec("fnnn", { strikes: 2, sl: 1 }) }, opts(d, { now: at(5000) }));
  assert.equal(sha(bf), hb2, "a tool-fidelity write does not touch bench.json");
  assert.notEqual(hb, hb2, "(the bench compaction did change bench.json, so the test above is not vacuous)");
});

// ---------------------------------------------------------------- the probe set, counts and the queue (fixture world)

const world = () => {
  const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });
  const rows = [
    { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN", pin: 3, pout: 15 })] },
    { provider: "fa", keyId: "k.fa.free", models: [m("a1"), m("a2"), m("a3", { tools: false, ctx: null }), m("auto"), m("img", { outputKind: "nontext" }), m("down", { routable: false })] },
    { provider: "pb", keyId: "k.pb.paid", models: [m("b1", { badge: "PAID", pin: 1, pout: 4 }), m("b2", { badge: "PAID", pin: 2, pout: 8 }), m("b3", { badge: null, pin: null, pout: null }), m("b4-dead", { badge: "PAID", pin: 1, pout: 1 })] },
  ];
  const ok = (a = 1790699779) => ({ s: "ok", t: 400, a });
  const b = { "anthropic/claude-x": ok(), "fa/a1": ok(), "fa/a2": ok(), "fa/a3": ok(), "fa/auto": ok(), "pb/b1": ok(), "pb/b2": ok(), "pb/b3": ok(), "pb/b4-dead": { s: "gone", a: 1 } };
  return { snap: { rows }, bench: { get: (k) => b[k] ?? null } };
};

test("the probe set: probe-ok models only; the relay is NOT probed (reported); tools:false models ARE in; non-text and unroutable rows are out (denominators)", () => {
  const { snap, bench } = world();
  const s = probeSet(snap, bench);
  assert.equal(s.models.length, 7, "7 probe-ok non-relay models of 8 listed (b4-dead is not probe-ok); img and down never listed");
  assert.deepEqual(s.relay, ["anthropic/claude-x"]);
  assert.equal(s.notProbeOk, 1);
  assert.ok(s.models.some((x) => x.key === "fa/a3" && x.toolsFalse), "the tools:false model is in the probe set");
  assert.ok(s.models.some((x) => x.key === "fa/auto" && x.alias));
  assert.ok(!s.models.some((x) => x.key.startsWith("anthropic/")), "relay models are never in the probe set");
  assert.deepEqual(s.models.filter((x) => x.provider === "pb").map((x) => x.key), ["pb/b1", "pb/b2", "pb/b3"], "free first, then cheapest, unpriced last");
  const c = fidelityCounts(s, {});
  assert.deepEqual([c.probeOk, c.relay, c.probeSet, c.withRecord, c.withRecordCurrent, c.toolsFalse, c.queued, c.ctxUnknown], [8, 1, 7, 0, 0, 1, 7, 1], "context unknown is its own count: 1 of 7");
});

test("an id this file cannot hold (whitespace, a prototype name, over-long) is left out of the probe set and counted, so it is not re-probed forever", () => {
  const { snap, bench } = world();
  const bad = ["has space", "x".repeat(300)];
  snap.rows[1].models.push(...bad.map((id) => ({ id, outModality: "chat", tools: true, pin: 0, pout: 0, badge: "FREE" })), { id: "ok-id", outModality: "chat", tools: true, pin: 0, pout: 0 });
  snap.rows.push({ provider: "__proto__", keyId: "k.p.free", models: [{ id: "m", outModality: "chat", tools: true, pin: 0, pout: 0 }] });
  const b = (k) => (bad.some((i) => k === `fa/${i}`) || k === "__proto__/m" || k === "fa/ok-id" ? { s: "ok", a: 1790699779 } : bench.get(k));
  const s = probeSet(snap, { get: b });
  assert.equal(s.badId, 3);
  assert.ok(s.models.some((x) => x.key === "fa/ok-id"));
  assert.ok(!s.models.some((x) => !keyOk(x.key)), "every key in the set can be written back");
  assert.equal(fidelityCounts(s, {}).badId, 3);
});

test("a route whose every listing says tools:false counts as tools:false; one that says true somewhere does not", () => {
  const { snap, bench } = world();
  snap.rows.push({ provider: "fa", keyId: "k.fa.free2", models: [{ id: "a3", outModality: "chat", tools: true, pin: 0, pout: 0, badge: "FREE" }] });
  assert.equal(probeSet(snap, bench).models.find((x) => x.key === "fa/a3").toolsFalse, false);
});

test("the incremental queue: probe-ok models with NO result; an OUTDATED fixture is not re-queued; a confirmed failure is not re-queued either; a model with a result is never re-probed", () => {
  const { snap, bench } = world();
  const s = probeSet(snap, bench);
  const store = { "fa/a1": rec("ppnn"), "fa/a2": rec("ffnn", { strikes: 2, sl: 1 }), "pb/b1": rec("pppp", { fx: "cc-tools-0" }) };
  const c = fidelityCounts(s, store);
  assert.deepEqual([c.withRecord, c.withRecordCurrent, c.outdated, c.queued], [3, 2, 1, 4]);
  const q = queueFor(s, store);
  assert.deepEqual(q.map((e) => e.key).sort(), ["fa/a3", "fa/auto", "pb/b2", "pb/b3"], "the 4 without a result");
  assert.ok(q.every((e) => e.todo.join() === "1,2"), "L1 and L2 first");
  assert.deepEqual(queueFor(s, Object.fromEntries(s.models.map((m) => [m.key, rec("ppnn")]))), [], "everything has a record: nothing is queued, however many runs");
  assert.equal(queueFor(s, store, [1, 2], { force: true }).length, 7, "--force asks again");
});

test("a provisional record (one strike) is not a result: it is counted apart and its struck level is asked once more; the other levels are not", () => {
  const { snap, bench } = world();
  const s = probeSet(snap, bench);
  const store = { "fa/a1": rec("nnnn", { strikes: 1, sl: 1 }), "fa/a2": rec("ppnn", { strikes: 1, sl: 3 }), "fa/a3": rec("ppnn"), "fa/auto": rec("ppnn", { strikes: 1, sl: 2 }) };
  const c = fidelityCounts(s, store);
  assert.deepEqual([c.withRecord, c.pending], [3, 3], "a1 has no result yet (its record only remembers the strike); a2, a3 and auto have");
  const q = queueFor(s, store, [1, 2]);
  assert.ok(q.some((e) => e.key === "fa/a1" && e.todo.join() === "1,2"), "a first L1 failure: asked the pair again");
  assert.ok(!q.some((e) => e.key === "fa/a2"), "a2's strike is at L3: an L1+L2 run does not touch it");
  assert.deepEqual(q.find((e) => e.key === "fa/auto")?.todo, [1, 2], "a model that already HAS results and failed the pair once is asked the pair again, without --force");
  assert.deepEqual(queueFor(s, store, [3]).filter((e) => e.key === "fa/a2").map((e) => e.todo), [[3]], "an L3 pass asks the struck level again");
});

test("lazy levels: L3 and L4 are asked only of models that PASSED L1 and L2 (or are being asked them now) and have `n` there; the big step only after an L3 pass", () => {
  const { snap, bench } = world();
  const s = probeSet(snap, bench);
  const store = { "fa/a1": rec("ppnn"), "fa/a2": rec("pppn"), "fa/a3": rec("ffnn", { strikes: 2, sl: 1 }), "fa/auto": rec("pfnn", { strikes: 2, sl: 2 }), "pb/b1": rec("pppp"), "pb/b2": rec("pppp", { big: "p" }) };
  const q = queueFor(s, store, [3, 4]);
  assert.deepEqual(q.map((e) => [e.key, e.todo.join()]), [["fa/a1", "3,4"], ["fa/a2", "4"]], "models that did not pass L1+L2, and models with no record, are NOT queued for the 157 KB levels");
  assert.deepEqual(queueFor(s, store, [5]).map((e) => e.key), ["fa/a2", "pb/b1"], "big: L3 passed and no big result yet");
  assert.deepEqual(queueFor(s, store, [1, 2, 3, 4]).filter((e) => e.key === "pb/b3").map((e) => e.todo), [[1, 2, 3, 4]], "a model never tested is asked all of them together; the ladder stops where it must");
  assert.deepEqual(queueFor(s, {}, [3, 4]), [], "no L3 before any L1+L2 result exists");
});

test("RETRY-FAILED asks again ONLY models of class x and only the levels that failed; a passing record is never touched", () => {
  const { snap, bench } = world();
  const s = probeSet(snap, bench);
  const store = { "fa/a1": rec("ffnn", { strikes: 2, sl: 1 }), "fa/a2": rec("pfnn", { strikes: 2, sl: 2 }), "fa/a3": rec("ppfn", { strikes: 2, sl: 3 }), "fa/auto": rec("ppnn"), "pb/b1": rec("ppfn", { capBelow: 150000 }), "pb/b2": rec("nnnn", { strikes: 1, sl: 1 }) };
  const q = queueFor(s, store, [1, 2], { retryFailed: true });
  assert.deepEqual(q.map((e) => [e.key, e.todo.join()]), [["fa/a1", "1,2"], ["fa/a2", "2"], ["fa/a3", "3"]], "t records, size-capped records and provisional ones are not retried");
  assert.deepEqual(failedLevels(rec("ppfn")), [3]);
  assert.deepEqual(failedLevels(rec("pfnn")), [2]);
  // and what a retry that passes does to the record: only the failed level changes, the passes stay, the strikes clear
  const a2 = run(store["fa/a2"], { 2: P }, { now: at(1000) });
  assert.deepEqual([a2.lvr, a2.t, a2.strikes], ["ppnn", "t", undefined]);
  const a3 = run(store["fa/a3"], { 3: { v: "p", bytes: 156892 } }, { now: at(1000) });
  assert.deepEqual([a3.lvr, a3.t], ["pppn", "v"]);
  const again = run(store["fa/a1"], { 1: F("still"), 2: F("still") }, { now: at(1000) });
  assert.deepEqual([again.lvr, again.t, again.strikes], ["ffnn", "x", 2], "failing again stays confirmed: no extra strike round");
});

test("--only and --limit narrow like the bench: provider or provider/model; limit is round-robin across providers", () => {
  const { snap, bench } = world();
  const q = queueFor(probeSet(snap, bench), {});
  assert.deepEqual(selectOnly(q, ["pb"]).map((e) => e.key), ["pb/b1", "pb/b2", "pb/b3"]);
  assert.deepEqual(selectOnly(q, ["fa/a2", "pb/b3"]).map((e) => e.key), ["fa/a2", "pb/b3"]);
  assert.deepEqual(selectOnly(q, ["nope"]), []);
  assert.deepEqual(limitEntries(q, 3).map((e) => e.key), ["fa/a1", "pb/b1", "fa/a2"]);
  assert.equal(limitEntries(q, null).length, 7);
});

// ---------------------------------------------------------------- estimates and caps

test("estimate: L1+L2 is 3 requests per model (the simple call, the argument-fidelity request and L2: ~5.5k tokens, the 20 KB result is in L2); L3 is two requests (3a + 3b, ~41k) and L4 rides in them; the big step is ~100k; free costs nothing; paid is priced in AND out", () => {
  const { snap, bench } = world();
  const set = probeSet(snap, bench);
  const q = queueFor(set, {});
  const e = estimate(q, { maxTokens: 512 });
  assert.equal(e.requests, 21, "3 requests x 7 models");
  assert.ok(e.inTokens > 7 * 5000 && e.inTokens < 7 * 6200, `L1 (~320 tokens) + L2 (~5,200 with the 20 KB result): ${e.inTokens}`);
  assert.equal(e.paidModels, 3);
  const b1 = e.entries.find((x) => x.key === "pb/b1"), a1 = e.entries.find((x) => x.key === "fa/a1");
  assert.equal(a1.cost, 0);
  assert.ok(Math.abs(b1.cost - ((b1.tin * 1 + 3 * 512 * 4) / 1e6)) < 1e-12, "input tokens x input price + output tokens x output price (a maxTokens override applies to every request)");
  assert.ok(Math.abs(Object.values(b1.lc).reduce((a, b) => a + b, 0) - b1.cost) < 1e-12 && Object.keys(b1.lc).join() === "1,2", "the cost of each level is available, so a probe that stops part way can be charged for the levels it completed");
  const b3 = e.entries.find((x) => x.key === "pb/b3");
  assert.ok(Math.abs(b3.cost - ((b3.tin * 2 + 3 * 512 * 8) / 1e6)) < 1e-12, "an unpriced paid row is charged the HIGHEST listed paid price (2 in, 8 out here)");
  const done = Object.fromEntries(set.models.map((m) => [m.key, rec("ppnn")]));
  const l3 = estimate(queueFor(set, done, [3, 4]), { fallback: null });
  assert.equal(l3.requests, 14, "L3 is two requests per model, and L4 (parallel calls) rides in the 157 KB one: it adds none");
  assert.ok(l3.inTokens > 7 * 40000 && l3.inTokens < 7 * 43000, `3a + 3b: ${l3.inTokens}`);
  assert.ok(Object.values(l3.entries[0].lc).every((x) => x >= 0) && l3.entries[0].lc[4] === 0, "L4 has no cost of its own beside L3");
  const only4 = estimate(queueFor(set, Object.fromEntries(set.models.map((m) => [m.key, rec("pppn")])), [4]));
  assert.equal(only4.requests, 7, "L4 alone (L3 already passed) is one 157 KB request");
  const bigStep = estimate(queueFor(set, Object.fromEntries(set.models.map((m) => [m.key, rec("pppn")])), [5]));
  assert.equal(bigStep.requests, 7);
  assert.ok(bigStep.sizes[5].inTokens > 95000 && bigStep.sizes[5].inTokens < 105000, `the big step: ${bigStep.sizes[5].inTokens}`);
  const full = estimate([{ key: "fa/z", provider: "fa", id: "z", free: true, todo: [1, 2, 3, 4, 5, 6, 7] }]);
  assert.ok(full.inTokens > 140000 && full.inTokens < 156000, `a fully tested model is about 150,000 input tokens: ${full.inTokens}`);
  assert.equal(full.entries[0].reqs, 8, "L1, 1a, L2, 3a, 3b, big, spawn, error result");
  assert.deepEqual(full.entries[0].kinds, ["1", "1a", "2", "2e", "3a", "3b", "5", "6"]);
});

test("the unpriced-row price is the highest listed paid price of the WHOLE probe set, so a narrowed run is charged like a full one", () => {
  const { snap, bench } = world();
  const set = probeSet(snap, bench);
  assert.deepEqual(paidFallback(set.models), { in: 2, out: 8 });
  const only = selectOnly(queueFor(set, {}), ["pb/b3"]);
  const narrow = estimate(only, { maxTokens: 512 }), whole = estimate(only, { maxTokens: 512, fallback: paidFallback(set.models) });
  assert.ok(narrow.usd < whole.usd, "left to itself a lone unpriced row would fall back to the documented default, far below the set's highest price");
  const b3 = whole.entries[0];
  assert.ok(Math.abs(b3.cost - ((b3.tin * 2 + 3 * 512 * 8) / 1e6)) < 1e-12);
});

test("with no listed paid price at all, an unpriced paid row is charged the bench's documented unpriced price", () => {
  const e = estimate([{ key: "p/x", provider: "p", id: "x", free: false, pin: null, pout: null, todo: [1, 2] }], { maxTokens: 100 });
  const tin = e.entries[0].tin;
  assert.ok(Math.abs(e.usd - ((tin * 0.6 + 300 * 3) / 1e6)) < 1e-12);
});

test("the per-provider cap: models are taken in order until the next would pass it; the rest of that provider waits; a model that alone passes the cap never blocks the others and says what cap it needs", () => {
  const entries = (p, n, tin) => Array.from({ length: n }, (_, i) => ({ key: `${p}/m${i}`, provider: p, tin }));
  const { kept, waiting, tooBig } = applyProviderCap([...entries("a", 10, 1000), ...entries("b", 3, 1000)], 4500);
  assert.equal(kept.filter((e) => e.provider === "a").length, 4);
  assert.equal(waiting.filter((e) => e.provider === "a").length, 6);
  assert.equal(kept.filter((e) => e.provider === "b").length, 3);
  assert.deepEqual(tooBig, []);
  assert.equal(applyProviderCap(entries("a", 2, 100), 150000).waiting.length, 0);
  const odd = applyProviderCap([{ key: "a/x", provider: "a", tin: 5000 }, { key: "a/y", provider: "a", tin: 10 }, { key: "a/z", provider: "a", tin: 3995 }, { key: "a/w", provider: "a", tin: 10 }], 4000);
  assert.deepEqual(odd.kept.map((e) => e.key), ["a/y"], "x alone costs more than the cap: it is out; y fits; z would pass the cap and waits");
  assert.deepEqual(odd.tooBig.map((e) => e.key), ["a/x"]);
  assert.deepEqual(odd.waiting.map((e) => e.key), ["a/z", "a/w"], "once a model waits, the later ones of its provider do not jump the queue");
  assert.equal(odd.needed, 5000, "the smallest cap that lets every queued model run");
  const none = applyProviderCap(entries("a", 3, 900), 100);
  assert.deepEqual([none.kept.length, none.tooBig.length, none.needed], [0, 3, 900]);
});

// ---------------------------------------------------------------- the compiler agrees (parity), through the real funnel

function compiled(records, rows, { unverified = "allow-warn", toolsOverride } = {}) {
  const models = {};
  for (const [k, r] of Object.entries(records)) models[k] = { ...r };
  const names = [...new Set(rows.map((r) => r.provider))];
  const providers = names.map((name) => ({ name, enabled: true, models: rows.filter((r) => r.provider === name).flatMap((r) => r.models.map((m) => m.id)) }));
  const tiers = Object.fromEntries(names.map((n) => [n, n === "anthropic" ? "subscription" : "free"]));
  const bench = { get: () => ({ s: "ok", a: 1790699779, t: 400 }), isLive: () => false };
  return funnel({ rows, bench, nowMs: 1790700000000, providers, tiers, toolFidelity: toolsOverride !== undefined ? toolsOverride : { models } }, { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", unverified, allow: [] });
}
const m = (id, over = {}) => ({ id, outModality: "chat", ctx: 200000, tools: true, pin: 0, pout: 0, badge: "FREE", ...over });

test("PARITY with the compiler: the stored t compiles to exactly the class the cell table says; ppfp with a size cap compiles as t; confirmed failures are absent from every list", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("m-pp"), m("m-ppfp-size"), m("m-ppfp-schema"), m("m-ppp"), m("m-pppp"), m("m-fail"), m("m-pf"), m("m-none"), m("m-tf", { tools: false }), m("m-prov"), m("auto")] },
                { provider: "anthropic", keyId: RELAY_KEY_ID, models: [m("claude-x", { badge: "PLAN" })] }];
  const records = { "fa/m-pp": rec("ppnn"), "fa/m-ppfp-size": rec("ppfp", { capBelow: 150000 }), "fa/m-ppfp-schema": rec("ppfp", { strikes: 2, sl: 3 }), "fa/m-ppp": rec("pppn"), "fa/m-pppp": rec("pppp"),
                    "fa/m-fail": rec("fnnn", { strikes: 2, sl: 1 }), "fa/m-pf": rec("pfnn", { strikes: 2, sl: 2 }), "fa/m-tf": rec("ppnn"), "fa/auto": rec("pppp", { alias: true }), "fa/m-prov": rec("nnnn", { strikes: 1, sl: 1 }) };
  const r = compiled(records, rows);
  const tier = (s) => r.models.find((x) => x.s === s)?.t;
  assert.equal(tier("fa/m-pp"), "t");
  assert.equal(tier("fa/m-ppfp-size"), "t", "L4 passed, L3 refused for size: t (small payloads work)");
  assert.equal(tier("fa/m-ppfp-schema"), undefined, "L3 failed twice for a reason that is not size: x, in no list");
  assert.equal(tier("fa/m-ppp"), "v");
  assert.equal(tier("fa/m-pppp"), "v");
  assert.equal(tier("fa/m-none"), "u", "no record: unverified");
  assert.equal(tier("fa/m-prov"), "u", "one strike: still unverified, not x");
  assert.equal(tier("fa/m-tf"), "t", "a tools:false model that passes L1+L2 compiles as t");
  assert.equal(tier("fa/auto"), "u", "an alias row is capped at u whatever its digit");
  assert.equal(tier("anthropic/claude-x"), "v", "the relay is verified by provenance, never probed");
  assert.ok(!r.models.some((x) => ["fa/m-fail", "fa/m-pf", "fa/m-ppfp-schema"].includes(x.s)), "x models are in no compiled list");
  for (const [k, rc] of Object.entries(records)) {
    const want = compiledClass(rc);
    if (want === "x") assert.equal(tier(k), undefined, k);
    else if (rc.strikes === 1) assert.equal(tier(k), "u", k);
    else assert.equal(tier(k), want, `${k} compiles as the cell table says`);
  }
});

test("PARITY over EVERY record the cleaner accepts (81 lvr strings x strike, size-cap and big variants): the stored class compiles to exactly compiledClass, x never appears, a first strike stays untested", () => {
  const variants = [{}, { strikes: 1, sl: 1 }, { strikes: 1, sl: 3 }, { strikes: 2, sl: 1 }, { strikes: 2, sl: 2 }, { strikes: 2, sl: 3 }, { strikes: 2, sl: 3, capBelow: 150000 }, { capBelow: 150000 }, { big: "p" }, { big: "f", capBelow: 390000 }];
  const all = [];
  for (const a of "pfn") for (const b of "pfn") for (const c of "pfn") for (const d of "pfn") all.push(a + b + c + d);
  const records = {}, models = [];
  let n = 0;
  for (const lvr of all) for (const v of variants) {
    const r = rec(lvr, v);
    if (!cleanFidelity(r)) continue;                       // the cleaner decides what is a record at all
    const id = `m${n++}`;
    records[`fa/${id}`] = r; models.push(m(id));
  }
  assert.ok(n > 600, `${n} accepted records`);
  const res = compiled(records, [{ provider: "fa", keyId: "k.fa.free", models }]);
  const tier = new Map(res.models.map((x) => [x.s, x.t]));
  let x = 0, u = 0, shown = 0;
  for (const [k, r] of Object.entries(records)) {
    const want = r.alias && r.t !== "x" ? "u" : r.t;
    assert.equal(want, compiledClass(r));
    if (want === "x") { x += 1; assert.equal(tier.has(k), false, `${k} ${JSON.stringify(r)} is x and must be in no list`); continue; }
    shown += 1; if (want === "u") u += 1;
    assert.equal(tier.get(k), want, `${k} ${JSON.stringify(r)}`);
  }
  assert.ok(x > 100 && u > 100 && shown + x === n, `x ${x}, u ${u}, compiled ${shown} of ${n}`);
});

test("the compiler's payload cap: capBelow lowers `pb` (to the smaller of it and a listed cap); maxBytes NEVER sets one; no capBelow leaves `pb` as listed", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("unlisted"), m("listed-big", { limit: { bytes: 900000 } }), m("listed-small", { limit: { bytes: 80000 } }), m("answered-only"), m("plain")] }];
  const records = {
    "fa/unlisted": rec("ppfn", { capBelow: 150000 }), "fa/listed-big": rec("pppn", { big: "f", capBelow: 390000 }), "fa/listed-small": rec("ppfn", { capBelow: 150000 }),
    "fa/answered-only": { ...rec("pppp"), maxBytes: 399900 }, "fa/plain": rec("ppnn"),
  };
  const r = compiled(records, rows);
  const pb = (s) => r.models.find((x) => x.s === s).pb;
  assert.equal(pb("fa/unlisted"), 150000, "no listed cap: the observed refusal becomes the cap");
  assert.equal(pb("fa/listed-big"), 390000, "a listed 900 KB and an observed refusal at 400 KB: the lower one");
  assert.equal(pb("fa/listed-small"), 80000, "a lower listed cap stays");
  assert.equal(pb("fa/answered-only"), 0, "maxBytes is a LOWER bound: it never becomes a cap");
  assert.equal(pb("fa/plain"), 0);
  assert.equal(payloadCapOf(records["fa/answered-only"]), 0);
  assert.equal(r.counts.payloadRisk, 3, "the three capped models count as payload-risk, as a listed cap would");
});

test("RANK inside v: big passed, then big not run, then big failed; then L4 the same way; nothing outside v moves; the key order is the helper's", () => {
  const ids = ["v-big-p", "v-big-n-l4p", "v-big-n-l4n", "v-big-n-l4f", "v-big-f", "t-1", "u-1"];
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: ids.map((id) => m(id)) }];
  const records = { "fa/v-big-p": rec("pppf", { big: "p" }), "fa/v-big-n-l4p": rec("pppp"), "fa/v-big-n-l4n": rec("pppn"), "fa/v-big-n-l4f": rec("pppf"), "fa/v-big-f": rec("pppp", { big: "f" }), "fa/t-1": rec("ppnn") };
  const r = compiled(records, rows);
  assert.deepEqual(r.models.map((x) => x.s), ["fa/v-big-p", "fa/v-big-n-l4p", "fa/v-big-n-l4n", "fa/v-big-n-l4f", "fa/v-big-f", "fa/t-1", "fa/u-1"]);
  assert.deepEqual(r.models.map((x) => x.t), ["v", "v", "v", "v", "v", "t", "u"]);
  assert.deepEqual(rankInV(rec("pppp", { big: "p" })), [0, 0]);
  assert.deepEqual(rankInV(rec("pppn")), [1, 1]);
  assert.deepEqual(rankInV(rec("pppf", { big: "f" })), [2, 2]);
  const noV = compiled({ "fa/t-1": rec("ppnp", {}), "fa/u-1": rec("ppnf") }, [{ provider: "fa", keyId: "k.fa.free", models: [m("t-1"), m("u-1")] }]);
  assert.deepEqual(noV.models.map((x) => x.s), ["fa/t-1", "fa/u-1"], "L4 results do not reorder class t rows");
});

test("with no tool-fidelity data the funnel's order and rank keys are as before (the new keys are constant 0 outside class v)", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("a"), m("b"), m("c")] }];
  // a DIFFERENTIAL: no records, an absent fidelity file (null) and an empty one give the same order, rank keys and bands; and that order is the funnel own deterministic tie-break order
  // (rows equal on every key are ordered by fnv1a32 of the selector, then the selector), so the new tool-fidelity keys add nothing outside class v
  const r = compiled({}, rows);
  const absent = compiled({}, rows, { toolsOverride: null }), empty = compiled({}, rows, { toolsOverride: { models: {} } });
  const sig = (x) => JSON.stringify({ s: x.models.map((y) => y.s), b: x.models.map((y) => y.b), g: x.models.map((y) => y.g), k: x.models.map((y) => x.groups.get(y.s).rk) });
  assert.equal(sig(absent), sig(r), "an absent file is the same as no records");
  assert.equal(sig(empty), sig(r), "an empty file is the same as no records");
  assert.deepEqual(r.models.map((x) => x.s), ["fa/a", "fa/b", "fa/c"].sort((p, q) => fnv1a32(p) - fnv1a32(q) || (p < q ? -1 : 1)), "the order is the id-hash order of rows equal on every key");
  assert.deepEqual(r.models.map((x) => x.b), [0, 0, 0]);
  for (const x of r.models) assert.deepEqual(r.groups.get(x.s).rk.slice(4, 7), [0, 0, 0], "strike, big step and L4 are constant 0 without tool-fidelity data");
});

test("flipDiff: the removed-model diff of tightening `unverified` names the models, the emptied providers and the count; it applies nothing", () => {
  const rows = [{ provider: "fa", keyId: "k.fa.free", models: [m("v1"), m("t1"), m("u1")] }, { provider: "fb", keyId: "k.fb.free", models: [m("u2"), m("u3")] }, { provider: "fc", keyId: "k.fc.free", models: [m("v2")] }];
  const records = { "fa/v1": rec("pppp"), "fa/t1": rec("ppnn"), "fc/v2": rec("pppp") };
  const before = compiled(records, rows, { unverified: "allow-warn" }), t = compiled(records, rows, { unverified: "allow-t" }), v = compiled(records, rows, { unverified: "pin-only" });
  assert.equal(before.models.length, 6);
  const d = flipDiff(before.models, t.models, { to: "allow-t" });
  assert.deepEqual(d.removed, ["fa/u1", "fb/u2", "fb/u3"]);
  assert.deepEqual(d.emptied, ["fb"]);
  assert.equal(d.remaining, 3);
  assert.match(d.text, /^unverified -> allow-t: this removes 3 of 6 model\(s\) and empties 1 provider\(s\): fb/);
  const d2 = flipDiff(before.models, v.models, { to: "pin-only" });
  assert.deepEqual(d2.removed, ["fa/t1", "fa/u1", "fb/u2", "fb/u3"]);
  assert.deepEqual(d2.thinned, ["fa"]);
  assert.match(d2.text, /removes 4 of 6/);
  assert.match(flipDiff(before.models, before.models).text, /removes 0 of 6 model\(s\) and empties no provider/);
  const snapshot = JSON.stringify(before.models);
  flipDiff(before.models, t.models);
  assert.equal(JSON.stringify(before.models), snapshot, "pure: the inputs are not changed");
});

test("the plan's id series do not appear in any user-visible string of the library", () => {
  for (const f of ["tool-fidelity.mjs", "tool-fidelity-probe.mjs", "tool-fidelity-cli.mjs"]) {
    const src = fs.readFileSync(new URL(`../refresh/${f}`, import.meta.url), "utf8");
    const strings = [...src.replace(/^\s*\/\/.*$/gm, "").matchAll(/`([^`]*)`|"([^"\\]*)"/g)].map((x) => x[1] ?? x[2]).join("\n");
    assert.ok(!/\b(D-a[a-z]|QB-\d+|CQ\d|G[1-7]\b|cr-M\d|R[1-7]\b)/.test(strings), f);
  }
});

const U = (...keys) => keys.map((k) => ({ key: k }));

// ---------------------------------------------------------------- the markers (fc, af, br, er, nm, cc, sp, d3), the deep-probe lift, the summary

test("markers are kept OUT of lvr and never change the class, except `fc` p (L1 passed only when forced): class t at best", () => {
  const all = run(null, { 1: { v: "p", af: "p" }, 2: { v: "p", br: "p" }, 3: { v: "p", nm: "p", cc: "p", bytes: 156800 }, 4: { v: "p", bytes: 156800 }, 5: { v: "p", bytes: 399700, cc: "p" }, 6: P, 7: P });
  assert.deepEqual([all.lvr, all.t, all.af, all.br, all.nm, all.cc, all.er, all.sp, all.big], ["pppp", "v", "p", "p", "p", "p", "p", "p", "p"]);
  assert.deepEqual(cleanFidelity(all), all);
  const bad = run(null, { 1: { v: "p", af: "f" }, 2: { v: "p", br: "f" }, 3: { v: "p", nm: "f", cc: "f", bytes: 1 }, 6: F("no"), 7: F("no") });
  assert.equal(bad.t, "v", "af, br, nm, cc and er failing do not lower the class");
  assert.deepEqual([bad.af, bad.br, bad.nm, bad.cc, bad.er], ["f", "f", "f", "f", "f"]);
  const forced = run(null, { 1: { v: "p", fc: "p", af: "p" }, 2: P, 3: { v: "p", bytes: 156800 } });
  assert.deepEqual([forced.lvr, forced.t, forced.fc, forced.ok], ["pppn", "t", "p", true], "passed only when forced: t, not v");
  assert.equal(classOf({ lvr: "pppp", fc: "p" }), "t");
  assert.equal(classOf({ lvr: "ppnn", fc: "p" }), "t");
  assert.equal(classOf({ lvr: "pppn", fc: "f" }), "v", "fc f is the L1 failure itself, not a cap on a pass");
  const clean = run(forced, { 1: { v: "p", af: "p" } }, { now: at(1000) });
  assert.deepEqual([clean.fc, clean.t], [undefined, "v"], "auto passes on a later probe: the forced-only mark clears and the class is clean");
  assert.equal(cleanFidelity({ ...forced, t: "v" }), null, "the cleaner derives the cap too");
  for (const k of ["fc", "af", "nm", "cc", "br", "er", "sp"]) { assert.equal(cleanFidelity({ ...all, [k]: "x" }), null, k); assert.equal(cleanFidelity({ ...all, [k]: "n" }), null, `${k}: absent means not run, never stored as n`); }
  assert.equal(cleanFidelity({ ...all, d3: "z" }), null);
  assert.ok(cleanFidelity({ ...all, d3: "i" }));
});

test("d3 says what decided L3: a (failed at 3a), b (failed at 3b), i (implied by the big step); a pass clears it", () => {
  const a = run(rec("ppnn"), { 3: { v: "f", why: "[3a] HTTP 400: anyOf", kind: "schema", nm: "p", cc: "p" } });
  assert.deepEqual([a.d3, a.strikes, a.sl, a.lvr], [undefined, 1, 3, "ppnn"], "first strike: provisional, nothing learned is kept");
  const a2 = run(a, { 3: { v: "f", why: "[3a] HTTP 400: anyOf", kind: "schema", nm: "p", cc: "p" } }, { now: at(1000) });
  assert.deepEqual([a2.d3, a2.t, a2.strikes, a2.nm, a2.cc, a2.why], ["a", "x", 2, "p", "p", "L3: [3a] HTTP 400: anyOf"]);
  const b = run(rec("ppnn"), { 3: { v: "f", why: "[3b] HTTP 413", kind: "size", bytes: 156800 } });
  assert.deepEqual([b.d3, b.capBelow, b.t], ["b", 150000, "t"]);
  const imp = run(rec("ppnn"), { 3: { v: "p", implied: "big", bytes: 399700, cc: "p" }, 5: { v: "p", bytes: 399700 } });
  assert.deepEqual([imp.lvr, imp.d3, imp.big, imp.t], ["pppn", "i", "p", "v"]);
  const pass = run(imp, { 3: { v: "p", bytes: 156800 } }, { now: at(1000) });
  assert.equal(pass.d3, undefined);
  assert.deepEqual(cleanFidelity(imp), imp);
});

test("SPAWN (sl 6): a first failure is provisional (the record keeps what it was, class unchanged), the second confirms `sp` f, a pass clears the strike; it never lowers the class and never blocks another strike", () => {
  const base = rec("pppp");
  const first = run(base, { 6: F("no usable prompt") });
  assert.deepEqual([first.strikes, first.sl, first.sp, first.t], [1, 6, undefined, "v"]);
  assert.equal(isProvisional(first), true);
  assert.deepEqual(cleanFidelity(first), first);
  const second = run(first, { 6: F("no usable prompt") }, { now: at(1000) });
  assert.deepEqual([second.strikes, second.sl, second.sp, second.t], [2, 6, "f", "v"], "confirmed: sp f, class still v");
  const pass = run(first, { 6: P }, { now: at(1000) });
  assert.deepEqual([pass.sp, pass.strikes], ["p", undefined]);
  const busy = run(rec("ppnn", { strikes: 1, sl: 3 }), { 6: F("x") });
  assert.deepEqual([busy.strikes, busy.sl, busy.sp], [1, 3, undefined], "the strike slot is taken by the L3 strike: the spawn failure is dropped, not recorded");
  const classStrike = run(base, { 3: F("[3a] anyOf", "schema"), 6: F("x") });
  assert.deepEqual([classStrike.strikes, classStrike.sl, classStrike.sp], [1, 3, undefined], "a class-level strike in the same probe wins the slot");
  assert.equal(run(null, { 6: P }), null, "spawn alone is a result (it ran), but a model with no L1+L2 result is never asked it (queue)");
});

test("a provisional class-level strike keeps EVERY marker as it was: nothing learned in a probe that is not confirmed is written", () => {
  const prior = rec("pppn", { af: "p", br: "p", nm: "p", cc: "p", er: "p" });
  const prov = run(prior, { 1: { v: "f", why: "no call", af: undefined, fc: "f" }, 2: { v: "p", br: "f" } });
  assert.deepEqual([prov.strikes, prov.sl, prov.af, prov.br, prov.fc, prov.lvr], [1, 1, "p", "p", undefined, "pppn"]);
});

test("er and br: the error-result answer and the end-of-result fact are plain markers from their own requests", () => {
  const r = run(rec("ppnn"), { 7: P });
  assert.equal(r.er, "p");
  assert.equal(run(rec("ppnn"), { 7: F("empty") }).er, "f", "a failed error-result case is recorded at once: it is not a class level, so no strike");
  assert.equal(run(rec("ppnn", { er: "p" }), { 2: { v: "p", br: "f" } }, { now: at(1000) }).br, "f");
});

test("summaryOf: the class, the four letters and every marker as p / f / n, with the notes a bare class hides; the text is compact", () => {
  const r = rec("pppp", { big: "p", sp: "p", af: "f", nm: "p", cc: "p", br: "p", er: "p", fc: "p", d3: "i", capBelow: 390000 });
  const s = summaryOf(r);
  assert.deepEqual([s.class, s.lvr, s.l4, s.big, s.sp, s.af, s.nm, s.cc, s.br, s.er, s.fc, s.d3], ["t", "pppp", "p", "p", "p", "f", "p", "p", "p", "p", "p", "i"]);
  assert.equal(s.text, "pppp big+ sp+ af- nm+ cc+ br+ er+");
  assert.ok(s.notes.some((n) => /only when the tool call was forced/.test(n)) && s.notes.some((n) => /implication/.test(n)) && s.notes.some((n) => /390000/.test(n)));
  const bare = summaryOf(rec("ppnn"));
  assert.deepEqual([bare.l4, bare.big, bare.sp, bare.af, bare.fc, bare.notes], ["n", "n", "n", "n", "n", []]);
  assert.equal(bare.text, "ppnn big? sp? af? nm? cc? br? er?");
  assert.equal(summaryOf(rec("nnnn", { strikes: 1, sl: 6 })).notes[0], "failed once at L6: asked again");
  assert.equal(summaryOf(null), null);
  assert.deepEqual(summaryOf(rec("ppfn", { d3: "a" })).notes, ["L3 failed at the constructs request (3a), before the 157 KB request"]);
});

test("queueFor, the new levels: spawn (6) and the error result (7) only of models that passed L1+L2 and have no result; a struck spawn is asked again; L4 alone only behind an L3 pass; nothing is re-sent", () => {
  const set = { models: [{ key: "fa/a", provider: "fa", id: "a", free: true }] };
  const all = [1, 2, 3, 4, 5, 6, 7];
  assert.deepEqual(queueFor(set, {}, all).map((e) => e.todo), [[1, 2, 3, 4, 5, 6, 7]], "a fresh model: everything, in one run");
  assert.deepEqual(queueFor(set, { "fa/a": rec("ppnn") }, all).map((e) => e.todo), [[3, 4, 5, 6, 7]], "L1+L2 done: only what is missing");
  assert.deepEqual(queueFor(set, { "fa/a": rec("pppp", { big: "p", sp: "p", er: "p" }) }, all), [], "everything has a result: nothing is sent");
  assert.deepEqual(queueFor(set, { "fa/a": rec("pppn", { big: "p", sp: "p", er: "p" }) }, all).map((e) => e.todo), [[4]], "L4 alone, behind a passed L3");
  assert.deepEqual(queueFor(set, { "fa/a": rec("ppfn", { capBelow: 150000, sp: "p", er: "p" }) }, all), [], "L3 failed (size): L4 and the big step are not asked");
  assert.deepEqual(queueFor(set, { "fa/a": rec("pppp", { big: "p", er: "p", strikes: 1, sl: 6 }) }, all).map((e) => e.todo), [[6]], "the spawn that failed once is asked again");
  assert.deepEqual(queueFor(set, { "fa/a": rec("ffnn", { strikes: 2, sl: 1 }) }, all), [], "a confirmed failure: nothing deep, nothing re-sent");
  assert.deepEqual(queueFor(set, {}, [6, 7]), [], "spawn and the error result for a model with no L1+L2 result are not asked");
  assert.deepEqual(queueFor(set, { "fa/a": rec("ppnn") }, [6, 7]).map((e) => e.todo), [[6, 7]]);
  assert.deepEqual(queueFor(set, { "fa/a": rec("pppp", { sp: "p" }) }, [6], { force: true }).map((e) => e.todo), [[6]], "--force asks again");
  assert.deepEqual(queueFor(set, {}, [4]), [], "L4 alone with no L3 result: nothing");
});

test("liftDeepProbes needs ALL of: --include-tier, an explicit --levels, --live, an explicit --max-spend and the printed estimate; each missing one is named", () => {
  const good = { includeTiers: ["paid"], levelsExplicit: true, levels: [1, 2, 3], live: true, maxSpendExplicit: true, printed: true };
  assert.equal(liftDeepProbes(good).ok, true);
  const gaps = { includeTiers: [[], "--include-tier"], levelsExplicit: [false, "explicit --levels"], levels: [[], "explicit --levels"], live: [false, "--live"], maxSpendExplicit: [false, "--max-spend"], printed: [false, "printed per-tier cost"] };
  for (const [k, [bad, word]] of Object.entries(gaps)) {
    const r = liftDeepProbes({ ...good, [k]: bad });
    assert.equal(r.ok, false, k);
    assert.ok(r.missing.some((m) => m.includes(word)), `${k}: ${r.missing.join("; ")}`);
    assert.equal(r.lift, undefined, "no capability is handed out");
  }
  assert.equal(liftDeepProbes({}).ok, false);
  assert.deepEqual(liftDeepProbes({}).missing.length, 5);
  assert.deepEqual(liftDeepProbes({ ...good, includeTiers: ["management"] }).ok, false, "management can never be lifted");
  assert.deepEqual(liftDeepProbes({ ...good, includeTiers: ["paid", "management", "free-deposit"] }).lift.tiers, ["paid", "free-deposit"]);
});

test("clampDeep drops EVERY level of a model that is not on a free tier (or lifted), counts them by tier (an unlabelled provider as `unlabelled`), and keeps the rest", () => {
  const e = (key, tier, todo) => ({ key, provider: key.split("/")[0], tier, todo });
  const q = [e("a/1", "free", [1, 2, 3, 5]), e("b/1", "paid", [1, 2, 3, 5]), e("c/1", undefined, [1, 2, 6]), e("d/1", "free-deposit", [3]), e("f/1", "management", [1])];
  const c = clampDeep(q);
  assert.deepEqual(c.entries.map((x) => [x.key, x.todo]), [["a/1", [1, 2, 3, 5]]], "nothing is left of the others, not even L1 or L2");
  assert.deepEqual(c.clamped, { models: 4, byTier: { paid: 1, unlabelled: 1, "free-deposit": 1, management: 1 } });
  const lifted = liftDeepProbes({ includeTiers: ["paid"], levelsExplicit: true, levels: [1, 2, 3], live: true, maxSpendExplicit: true, printed: true }).lift;
  assert.deepEqual(clampDeep(q, { lift: lifted }).entries.map((x) => [x.key, x.todo]).filter(([k]) => k === "b/1"), [["b/1", [1, 2, 3, 5]]], "a lifted tier keeps every level it was asked; the others do not");
  assert.equal(clampDeep(q, { lift: lifted }).clamped.byTier.paid, undefined);
});

test("restrictToFree: only providers whose key tier is free (or a lifted tier) stay in the probe set; the rest are listed with their tier and counted by tier, unlabelled included", () => {
  const set = { models: [{ key: "a/1", provider: "a" }, { key: "a/2", provider: "a" }, { key: "b/1", provider: "b" }, { key: "c/1", provider: "c" }, { key: "d/1", provider: "d" }, { key: "e/1", provider: "e" }], relay: ["r/1"] };
  const tiers = { a: "free", b: "paid", c: "free-deposit", d: "management" };
  const r = restrictToFree(set, tiers);
  assert.deepEqual(r.models.map((m) => m.key), ["a/1", "a/2"]);
  assert.deepEqual(r.notFree.map((m) => [m.key, m.tier]), [["b/1", "paid"], ["c/1", "free-deposit"], ["d/1", "management"], ["e/1", null]]);
  assert.deepEqual(r.byTier, { free: 2, paid: 1, "free-deposit": 1, management: 1, unlabelled: 1 });
  assert.deepEqual(r.relay, ["r/1"], "the relay keeps its own handling");
  assert.equal(restrictToFree(set, null).models.length, 0, "no tier data: nothing counts as free");
  const lifted = liftDeepProbes({ includeTiers: ["paid"], levelsExplicit: true, levels: [1], live: true, maxSpendExplicit: true, printed: true }).lift;
  assert.deepEqual(restrictToFree(set, tiers, lifted).models.map((m) => m.key), ["a/1", "a/2", "b/1"], "a lifted tier is in; management never is");
  assert.equal(restrictToFree({ ...set, models: [{ key: "x/1", provider: "__proto__" }] }, tiers).models.length, 0, "a hostile provider name is just unlabelled");
});

test("coverage: OPTIONAL levels do not block `tested` but are counted while they have not run (only where deep probes are allowed); the evidence names the markers", () => {
  const store = { "p/a": rec("pppp", { big: "p", sp: "p", er: "p", af: "p" }), "p/b": rec("pppn"), "p/c": rec("ppnn"), "p/d": rec("ppnn"), "p/x": rec("ffnn", { strikes: 2, sl: 1 }) };
  const cov = coverage(U("p/a", "p/b", "p/c", "p/d", "p/x", "p/new"), store, { level: "l3", deepOk: (k) => k !== "p/d" });
  assert.equal(cov.counts.tested, 3, "a, b and the confirmed failure x; p/c and p/d have L1+L2 but no L3 yet: pending, not tested, for the L3 ledger");
  const t = Object.fromEntries(cov.tested.map((x) => [x.key, x.evidence]));
  assert.equal(t["p/a"], "pppp big p af p er p sp p");
  const l12 = coverage(U("p/a", "p/b", "p/c", "p/d", "p/x", "p/new"), store, { level: "l12", deepOk: (k) => k !== "p/d" });
  assert.equal(l12.counts.tested, 5, "L1+L2 is the required level there: tested whatever the optional ones say");
  assert.deepEqual(l12.optional, { l4: 1, big: 1, sp: 2, er: 2 }, "b: l4 big sp er; c: sp er (its L3 has not run, so no big); d is not deep-allowed: not counted; x failed: not counted; a is complete");
  assert.match(coverageLines(l12, "L1+L2").join("\n"), /optional levels not run yet among the 5 tested \(they do not block being tested\): L4 1, big 1, spawn 2, error-result 2/);
  assert.equal(coverage(U("p/a"), store, { level: "l12" }).optional.sp, 0);
});

test("orderCosts: expected input tokens per passer of l3-first and big-first from MEASURED rates; wallEstimate: a range, longer when requests are big or providers few; levelCosts: the per-level table", () => {
  const oc = orderCosts({ r3: 0.9, rb: 0.8 });
  assert.ok(Math.abs(oc.l3First - (oc.c3 + 0.9 * oc.cb)) < 1e-9 && Math.abs(oc.bigFirst - (oc.cb + (1 - 0.72) * oc.c3)) < 1e-9);
  assert.ok(oc.bigFirst < oc.l3First, "most models pass both: big-first saves the 3a and 3b requests of every big passer");
  assert.ok(orderCosts({ r3: 0.2, rb: 0.5 }).bigFirst > orderCosts({ r3: 0.2, rb: 0.5 }).l3First, "few pass L3: l3-first stops at L3 and never pays the 100k");
  assert.equal(orderCosts({ r3: 0, rb: 0 }).l3First, orderCosts({ r3: 0, rb: 0 }).c3, "nobody passes L3: l3-first costs just 3a + 3b");
  assert.equal(orderCosts({ r3: 2, rb: 0.5 }), null, "an impossible rate is refused");
  const rated = (n, prov, todo) => Array.from({ length: n }, (_, i) => ({ key: `${prov}/${i}`, provider: prov, todo, kinds: kindsOf(todo) }));
  const small = wallEstimate(rated(10, "a", [1, 2]), { concurrency: 8, perProvider: 2, latencyMs: 2000 });
  const deep = wallEstimate(rated(10, "a", [1, 2, 3, 5]), { concurrency: 8, perProvider: 2, latencyMs: 2000 });
  assert.ok(deep.lowSec > small.lowSec * 5, `big requests dominate: ${small.lowSec} -> ${deep.lowSec}`);
  assert.equal(deep.highSec, deep.lowSec * 3);
  const wide = wallEstimate([...rated(5, "a", [1, 2]), ...rated(5, "b", [1, 2]), ...rated(5, "c", [1, 2]), ...rated(5, "d", [1, 2])], { concurrency: 8, perProvider: 2, latencyMs: 2000 });
  const narrow = wallEstimate(rated(20, "a", [1, 2]), { concurrency: 8, perProvider: 2, latencyMs: 2000 });
  assert.ok(narrow.lowSec > wide.lowSec, "the same requests on one provider take longer than spread over four");
  const lc = levelCosts();
  assert.deepEqual(lc.map((x) => [x.level, x.requests]), [[1, 2], [2, 1], [3, 2], [5, 1], [6, 1], [7, 1]]);
  assert.ok(lc.find((x) => x.level === 3).inTokens > 40000 && lc.find((x) => x.level === 5).inTokens > 95000 && lc.find((x) => x.level === 1).inTokens < 800);
  assert.ok(lc.reduce((a, x) => a + x.inTokens, 0) > 140000 && lc.reduce((a, x) => a + x.inTokens, 0) < 156000, "a fully tested model: about 150,000");
  assert.equal(levelCosts(100).find((x) => x.level === 1).outTokens, 200, "a --max-tokens override applies to both requests of level 1");
});

test("requeueL3Failures keeps the markers (af, br, er, sp, nm, cc, fc) of the record it resets", () => {
  const store = { "fa/m": rec("ppfn", { capBelow: 150000, af: "p", br: "p", er: "p", sp: "p", nm: "p", cc: "p", d3: "b" }) };
  const out = requeueL3Failures(store, "fa")["fa/m"];
  assert.deepEqual([out.lvr, out.af, out.br, out.er, out.sp, out.nm, out.cc, out.capBelow, out.d3], ["ppnn", "p", "p", "p", "p", "p", "p", undefined, undefined]);
});

test("wallEstimate: with the default concurrency the whole run is bounded by 8 requests in flight, not by the slowest provider alone", () => {
  const rated = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}/m`, provider: `p${i}`, todo: [1, 2], kinds: kindsOf([1, 2]) }));
  const one = wallEstimate(rated.slice(0, 1), { perProvider: 2, latencyMs: 2000 });
  const all = wallEstimate(rated, { perProvider: 2, latencyMs: 2000 });
  assert.ok(all.lowSec > one.lowSec * 4, `20 providers through 8 slots take about 2.5 times one provider's two requests per slot-pair: ${one.lowSec} -> ${all.lowSec}`);
});

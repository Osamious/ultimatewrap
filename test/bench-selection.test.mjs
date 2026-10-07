// #114: which rows a run selects. An `--only-file` that contributes nothing is an error whatever else was given; when
// both narrowing flags contribute the selection is their union and the plan says how many rows each gave.
// The snapshot and the existing records are injected: nothing here reads the real state.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { main } from "../refresh/bench-cli.mjs";

const M = (id, o = {}) => ({ id, badge: "PAID", pin: 1, pout: 2, outputKind: "text", routable: true, ...o });
const snapshot = { ok: true, snap: { rows: [
  { provider: "a", models: [M("x"), M("y")] }, { provider: "b", models: [M("z")] }, { provider: "c", models: [M("w"), M("v"), M("u")] },
] } };
const dir = () => mkTmp("uw-sel-");
const list = (d, text) => { const f = path.join(d, "list.txt"); fs.writeFileSync(f, text); return f; };
const run = async (argv, d) => {
  const err = [], log = [], e = console.error, l = console.log;
  console.error = (...a) => err.push(a.join(" ")); console.log = (...a) => log.push(a.join(" "));
  try { return { code: await main(argv, { snapshot, existing: new Map(), lockFile: path.join(d, "bench.lock"), findRunning: () => [] }), err: err.join("\n"), log: log.join("\n") }; }
  finally { console.error = e; console.log = l; }
};

test("--only-file with NO probeable row is an error, alone or beside --only (it must never quietly become the whole provider)", async () => {
  const d = dir();
  const f = list(d, "# nothing here is in the snapshot\nnope/one\nnope/two\n");
  const alone = await run(["--only-file", f], d);
  assert.equal(alone.code, 1);
  assert.match(alone.err, /--only-file list\.txt contributes no probeable row \(none of its 2 listed row\(s\) is in the current snapshot\); nothing was planned/);
  const both = await run(["--only", "c", "--only-file", f], d);
  assert.equal(both.code, 1, "--only c alone would have planned 3 rows");
  assert.match(both.err, /contributes no probeable row/);
  assert.doesNotMatch(both.log, /row\(s\) to probe/, "no plan was printed");
});

test("--only plus --only-file is a UNION, and the plan says how many rows each gave", async () => {
  const d = dir();
  const out = await run(["--only", "c", "--only-file", list(d, "a/x\n")], d);
  assert.equal(out.code, 0);
  assert.match(out.log, /selection is the UNION of --only c \(3 row\(s\)\) and --only-file \(1 row\(s\)\): 4 row\(s\)/);
  assert.match(out.log, /\n4 row\(s\) to probe across 2 provider\(s\)/);
});

test("--only-file alone selects exactly its rows, and reports the ones the snapshot does not have", async () => {
  const d = dir();
  const out = await run(["--only-file", list(d, "a/x\nb/z\nmissing/q\n")], d);
  assert.equal(out.code, 0);
  assert.match(out.log, /3 row\(s\) listed, 2 probeable in the current snapshot; 1 not in it \(or not probeable\), skipped: missing\/q/);
  assert.match(out.log, /\n2 row\(s\) to probe across 2 provider\(s\)/);
  assert.doesNotMatch(out.log, /UNION/, "no union line without --only");
});

test("an empty --only is still an error, and nothing is planned", async () => {
  const d = dir();
  const out = await run(["--only", ","], d);
  assert.equal(out.code, 2);
  assert.match(out.err, /--only needs at least one/);
});

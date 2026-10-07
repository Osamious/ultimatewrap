// Issue #157 guard: a fixed test file must leave no uw-<kind>-<6 chars> folder behind in os.tmpdir().
// The child is a real `node --test` run (NODE_TEST_CONTEXT is dropped from its environment: with it a nested run prints "run() is being called
// recursively", runs nothing and exits 0, which would make every count here vacuous). Its TEMP/TMP/TMPDIR point at a fresh folder, so its
// os.tmpdir() holds only what it made and a parallel test file cannot move the count.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkTmp } from "./helpers/tmp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEAK = /^uw-[a-z]+-[A-Za-z0-9]{6}$/;
const count = (dir) => fs.readdirSync(dir).filter((n) => LEAK.test(n)).length;
const num = (out, key) => Number(out.match(new RegExp("^ℹ " + key + " ([0-9]+)", "m"))?.[1] ?? NaN);
function runTestFile(file) {
  const tmp = mkTmp("uw-leakguard-");
  const { NODE_TEST_CONTEXT, ...rest } = process.env;
  const env = { ...rest, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
  const before = count(tmp), r = spawnSync(process.execPath, ["--test", "--test-reporter=spec", file], { env, encoding: "utf8", timeout: 120000 });
  const out = r.stdout + r.stderr;
  return { before, after: count(tmp), r, out, tests: num(out, "tests"), pass: num(out, "pass") };
}

test("a fixed test file (state.test.mjs, 11 folders a run before the fix) really ran and leaves the same count of uw-*-xxxxxx folders", () => {
  const { before, after, r, out, tests, pass } = runTestFile(path.join(HERE, "state.test.mjs"));
  assert.equal(r.status, 0, out);
  assert.ok(tests > 0 && pass === tests, `the child must run tests and pass them all, not skip (tests ${tests}, pass ${pass}):\n${out}`);
  assert.equal(after, before, `${after - before} uw-*-xxxxxx folder(s) left behind`);
});

test("negative control: through the same node --test path, a fixture test that leaves one uw-neg-xxxxxx folder is counted +1, so the guard can fail", () => {
  const dir = mkTmp("uw-leakfix-");
  const fixture = path.join(dir, "neg.test.mjs");
  fs.writeFileSync(fixture, 'import { test } from "node:test";\nimport fs from "node:fs";\nimport os from "node:os";\nimport path from "node:path";\ntest("leaks one", () => { fs.mkdtempSync(path.join(os.tmpdir(), "uw-neg-")); });\n');
  const { before, after, r, out, tests, pass } = runTestFile(fixture);
  assert.equal(r.status, 0, out);
  assert.ok(tests === 1 && pass === 1, `the fixture ran (tests ${tests}, pass ${pass}):\n${out}`);
  assert.equal(after - before, 1);
});

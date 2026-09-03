import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { median, verdict, run, BUDGET_MS } from "./bench-startup.mjs";
import { SNAPSHOT_FILE } from "../menu/snapshot.mjs";

test("median is the middle sample, not the mean", () => {
  assert.equal(median([100, 900, 110]), 110);
  assert.equal(median([50]), 50);
  assert.equal(median([]), null);
});

test("verdict states the budget and the observed number in one line", () => {
  const ok = verdict(120);
  assert.equal(ok.ok, true);
  assert.match(ok.line, /120/);
  assert.match(ok.line, new RegExp(String(BUDGET_MS)));
  assert.equal(verdict(BUDGET_MS + 1).ok, false);
  assert.equal(verdict(BUDGET_MS).ok, true);
});

test("the first frame is built in under the budget, five times", { timeout: 60000 }, async (t) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    t.skip("no snapshot built yet — run: node menu/snapshot.mjs --build");
    return;
  }
  const r = await run(5);
  assert.equal(r.samples.length, 5);
  assert.ok(r.ok, `median ${r.median} ms exceeds the ${BUDGET_MS} ms budget: ${r.samples.join(", ")}`);
});

test("the bench measures a whole process, not an in-process call", async () => {
  const src = fs.readFileSync(new URL("./bench-startup.mjs", import.meta.url), "utf8");
  assert.match(src, /spawn|execFile/);
  assert.equal(src.includes("performance.now() - start"), false);
});

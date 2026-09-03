import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const MENU = "C:/Users/osami/.uw/menu";

test("every menu file lives under ~/.uw/menu", () => {
  for (const f of ["catalog.mjs", "uwpick.mjs", "uwpick-run.ps1", "uwpick.cmd"]) {
    assert.ok(fs.existsSync(`${MENU}/${f}`), `missing ${f}`);
  }
});

test("catalog.mjs exports the builder surface", async () => {
  const m = await import("file:///C:/Users/osami/.uw/menu/catalog.mjs");
  for (const name of ["build", "routableSet"]) {
    assert.equal(typeof m[name], "function", `catalog.mjs must export ${name}`);
  }
});

test("no menu file still points at the spike directory", () => {
  // catalog.mjs included: it is the one file whose CONTENTS Task A2 changed, its
  // slot path having pointed into spike/, and it was the only moved file this
  // guard did not read. Clean today, so this closes a coverage gap rather than a
  // bug -- but the gap was over exactly the file most likely to regress.
  for (const f of ["catalog.mjs", "uwpick.mjs", "uwpick-run.ps1", "uwpick.cmd"]) {
    const src = fs.readFileSync(`${MENU}/${f}`, "utf8");
    assert.ok(!/[\\/]spike[\\/]/.test(src), `${f} still references the spike directory`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const DOC = "C:/Users/osami/.uw/docs/qa-interactive-protocol.md";

// All twenty ids, not the fifteen the plan listed.
//
// The plan's own version of this file declared fifteen REQUIRED ids and then
// specified twenty sections -- P11a/b/c cover the three abort paths and P14a/b
// cover the uninstall guards. With `assert.equal(steps.length, REQUIRED.length)`
// below, that version could not pass against the document it specified. The list
// is the contract; it has to name every section that exists, or the check that
// the protocol has not silently lost a step is checking nothing.
const REQUIRED = [
  "P1-sentinel-dispatch", "P2-provider-columns", "P3-provider-filter",
  "P4-filter-by-model-name", "P5-descend", "P6-model-columns",
  "P7-select-writes-chat-input", "P8-esc-ladder", "P9-tab-flat-scope",
  "P10-ctrl-c", "P11-passthrough-editor",
  "P11a-esc-leaves-the-chat-input-empty",
  "P11b-ctrl-c-leaves-the-chat-input-empty",
  "P11c-missing-snapshot-leaves-the-chat-input-empty",
  "P12-console-restored", "P13-motion", "P14-legend-and-empty-state",
  "P14a-omc-survives-uninstall", "P14b-uninstall-refuses-a-foreign-command",
  "P15-statusline-footer",
];

test("the protocol document exists", () => {
  assert.ok(fs.existsSync(DOC));
});

test("every required step id is present exactly once", () => {
  const src = fs.readFileSync(DOC, "utf8");
  for (const id of REQUIRED) {
    // Anchored to the heading, not a bare substring. `P11-passthrough-editor`
    // occurs inside no other id, but `P1` and `P14` are prefixes of `P11a` and
    // `P14a`, and a substring count would have made a missing section invisible
    // the moment a longer id mentioned it.
    const hits = src.split(`### ${id}\n`).length - 1;
    assert.equal(hits, 1, `step ${id} appears ${hits} times as a heading, want 1`);
  }
});

test("the document declares no step the list does not know about", () => {
  // The other direction, and the one that actually catches drift: adding a
  // section without adding its id would otherwise pass every check above.
  const src = fs.readFileSync(DOC, "utf8");
  const found = [...src.matchAll(/^### (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(found, REQUIRED);
});

test("every step declares Do, Expected and Fail means", () => {
  const src = fs.readFileSync(DOC, "utf8");
  const steps = src.split(/^### /m).slice(1);
  assert.equal(steps.length, REQUIRED.length);
  for (const s of steps) {
    const id = s.slice(0, s.indexOf("\n"));
    assert.match(s, /\*\*Do:\*\*/, `step has no Do block: ${id}`);
    assert.match(s, /\*\*Expected:\*\*/, `step has no Expected block: ${id}`);
    assert.match(s, /\*\*Fail means:\*\*/, `step has no Fail means block: ${id}`);
  }
});

test("no step tells the operator to press ctrl+g before typing the sentinel", () => {
  // THE REGRESSION THIS FILE EXISTS TO PREVENT, and it is not hypothetical: the
  // plan's own text for P1, P11a and P11c said "press ctrl+g, type `m`, press
  // enter", which cannot work. uwpick.cmd dispatches on the FIRST LINE of the
  // buffer Claude Code hands it, so the sentinel must already be in the chat
  // input when ctrl+g is pressed. Pressing ctrl+g on an empty prompt correctly
  // falls through to the real editor -- so an operator following that order
  // types `m` into notepad and reports P1 as failed against working software.
  const src = fs.readFileSync(DOC, "utf8");
  const bad = src.split("\n").filter((l) => /ctrl\+g[^.\n]*\btype\b/i.test(l));
  assert.deepEqual(bad, [], "sentinel must be typed BEFORE ctrl+g");
});

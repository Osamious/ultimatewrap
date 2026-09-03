import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff } from "../menu/state.mjs";

// Never the live file: every test gets its own scratch path.
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-state-"));
  return path.join(d, "picker.json");
};

test("a missing file loads as empty rather than throwing", () => {
  assert.deepEqual(loadPickerState(scratch()), { recents: [], favourites: [] });
});

test("a corrupt file loads as empty rather than throwing", () => {
  const f = scratch();
  fs.writeFileSync(f, "{not json");
  assert.deepEqual(loadPickerState(f), { recents: [], favourites: [] });
});

test("recents are most-recent-first and deduped", () => {
  const f = scratch();
  recordRecent("a/one", f);
  recordRecent("b/two", f);
  recordRecent("a/one", f);
  assert.deepEqual(loadPickerState(f).recents, ["a/one", "b/two"]);
});

test("recents cap at 10", () => {
  const f = scratch();
  for (let i = 0; i < 14; i++) recordRecent(`p/m${i}`, f);
  const { recents } = loadPickerState(f);
  assert.equal(recents.length, 10);
  assert.equal(recents[0], "p/m13");
});

test("a corrupt file is preserved under a new name, never deleted", () => {
  const f = scratch();
  fs.writeFileSync(f, "{ half-written");
  const s = loadPickerState(f);
  assert.deepEqual(s, { recents: [], favourites: [] });
  const kept = fs.readdirSync(path.dirname(f)).filter((n) => n.includes(".corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f), kept[0]), "utf8"), "{ half-written");
});

test("saves go through writeAtomic, leaving no temp files behind", () => {
  const f = scratch();
  recordRecent("a/one", f);
  toggleFavourite("a/one", f);
  assert.equal(fs.readdirSync(path.dirname(f)).some((n) => n.includes(".tmp-")), false);
  assert.deepEqual(loadPickerState(f), { recents: ["a/one"], favourites: ["a/one"] });
});

test("toggleFavourite adds then removes", () => {
  const f = scratch();
  assert.deepEqual(toggleFavourite("a/one", f).favourites, ["a/one"]);
  assert.deepEqual(toggleFavourite("a/one", f).favourites, []);
});

test("favourites survive a recents write", () => {
  const f = scratch();
  toggleFavourite("a/one", f);
  recordRecent("b/two", f);
  const s = loadPickerState(f);
  assert.deepEqual(s.favourites, ["a/one"]);
  assert.deepEqual(s.recents, ["b/two"]);
});

test("a non-string target is refused", () => {
  const f = scratch();
  recordRecent(null, f);
  recordRecent(42, f);
  assert.deepEqual(loadPickerState(f).recents, []);
});

test("the written file is valid JSON with only the two keys", () => {
  const f = scratch();
  recordRecent("a/one", f);
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["favourites", "recents"]);
});

test("recordHandoff appends one parseable line per call", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-handoff-"));
  const f = path.join(d, "handoff.json");
  recordHandoff({ sentinel: "m", wrote: false }, f);
  recordHandoff({ sentinel: "model", wrote: true }, f);
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sentinel, "model");
  assert.equal(typeof JSON.parse(lines[0]).at, "string");
});

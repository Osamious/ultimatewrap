import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const UW = "C:/Users/osami/.uw";
const git = (...args) =>
  execFileSync("git", ["-C", UW, ...args], { encoding: "utf8" }).trim();

test("~/.uw is a git repository", () => {
  assert.equal(git("rev-parse", "--is-inside-work-tree"), "true");
});

test(".gitignore excludes every named scratch class", () => {
  const ignored = [
    "keysync/keys.log",
    "keysync/run.mjs.bak-msgfix",
    "spike/keys.log",
    "spike/buf1.md",
    "spike/d.md",
    "spike/crlf.md",
    "spike/cc_strings.txt",
    "spike/diag.txt",
    "spike/render.out",
    "harness/scratch/anything.json",
    "state/picker.json",
    "catalog/models.json",
  ];
  for (const p of ignored) {
    assert.equal(git("check-ignore", "-q", p) ?? "", "", `${p} should be ignored`);
  }
});

test("no file under the repo references a key value from ~/.llmkeys", () => {
  const tracked = git("ls-files").split("\n").filter(Boolean);
  for (const f of tracked) {
    assert.ok(!f.startsWith(".."), `tracked file escapes the repo: ${f}`);
    assert.ok(fs.existsSync(`${UW}/${f}`), `tracked file missing: ${f}`);
  }
});

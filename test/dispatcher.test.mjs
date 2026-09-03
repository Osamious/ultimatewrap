import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const CMD = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";
const FAKE = "C:\\Users\\osami\\.uw\\test\\fixtures\\fake-editor.cmd";
// The picker itself is replaced for these tests: we assert the DISPATCH decision,
// not the TUI. UW_PICK_OVERRIDE short-circuits the powershell branch.
const NOOP = "C:\\Users\\osami\\.uw\\test\\fixtures\\fake-picker.cmd";

// Everything runs through `cmd.exe /c`. Node refuses to execFile a .cmd directly
// -- it has since the 2024 argument-injection fix -- so invoking the dispatcher
// by path throws EINVAL before the batch file is ever reached, and a test written
// that way fails for a reason that has nothing to do with dispatch.
const runCmd = (target, buf, env) => {
  try {
    execFileSync("cmd.exe", ["/c", target, buf], { encoding: "utf8", stdio: "pipe", env });
    return 0;
  } catch (e) { return e.status ?? -1; }
};

// A .cmd that exits with a chosen code, so the propagation rule can be tested in
// both directions. Written with CRLF: cmd.exe is reliable about line endings in
// batch files in a way it is not about much else.
const exiter = (dir, code) => {
  const f = path.join(dir, `exit${code}.cmd`);
  fs.writeFileSync(f, ["@echo off", `exit /b ${code}`, ""].join("\r\n"));
  return f;
};

const scratchDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-dispatch-"));

function dispatch(firstLine) {
  const dir = scratchDir();
  const buf = path.join(dir, "buffer.md");
  const marker = path.join(dir, "marker.txt");
  fs.writeFileSync(buf, firstLine + "\r\n");
  const code = runCmd(CMD, buf, { ...process.env,
    UW_REAL_EDITOR: FAKE, UW_PICK_OVERRIDE: NOOP, UW_TEST_MARKER: marker });
  const log = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  return { log, code, buffer: fs.readFileSync(buf, "utf8") };
}

for (const sentinel of ["m", "model", ">>m", "M", "Model"]) {
  test(`"${sentinel}" reaches the picker, not the editor`, () => {
    const { log } = dispatch(sentinel);
    assert.match(log, /picker/);
    assert.doesNotMatch(log, /passthrough/);
  });
}

for (const other of ["hello world", "/model foo/bar", "mm", "models", "# heading", "  m"]) {
  test(`"${other}" is handed to the real editor unchanged`, () => {
    const { log, buffer } = dispatch(other);
    assert.match(log, /passthrough/);
    assert.doesNotMatch(log, /picker/);
    assert.match(buffer, new RegExp(other.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  });
}

test("the buffer path reaches the editor verbatim", () => {
  const { log } = dispatch("hello");
  assert.match(log, /buffer\.md/);
});

test("an empty buffer goes to the editor, not the picker", () => {
  const { log } = dispatch("");
  assert.match(log, /passthrough/);
});

// --- the exit contract, which is the whole point of this task ---------------
//
// Claude Code sees only the dispatcher's exit code, and exit 0 means ACCEPT THE
// BUFFER. The two branches therefore need opposite rules, and the previous
// version of these tests asserted only WHICH PROGRAM RAN -- never what the
// dispatcher returned, which is the single value Claude Code acts on.

test("the sentinel branch propagates a non-zero child exit", () => {
  // Q2.1/Q2.6: this is what makes Claude Code discard the buffer on every abort.
  // The buffer here holds `m`, so exit 0 would submit the letter m as a chat
  // message -- which is what esc, ctrl+c, a missing snapshot and an unopenable
  // CONIN$ all used to do.
  for (const [line, want] of [["m", 1], ["model", 3], [">>m", 1]]) {
    const dir = scratchDir();
    const buf = path.join(dir, "b.md");
    fs.writeFileSync(buf, line + "\r\n");
    const code = runCmd(CMD, buf, { ...process.env,
      UW_TEST_MARKER: path.join(dir, "m.txt"),
      UW_PICK_OVERRIDE: exiter(dir, want), UW_REAL_EDITOR: FAKE });
    assert.equal(code, want, `"${line}" must return the picker's own exit code`);
  }
});

test("the sentinel branch still returns 0 when the picker succeeds", () => {
  const dir = scratchDir();
  const buf = path.join(dir, "b.md");
  fs.writeFileSync(buf, "m\r\n");
  const code = runCmd(CMD, buf, { ...process.env,
    UW_TEST_MARKER: path.join(dir, "m.txt"),
    UW_PICK_OVERRIDE: exiter(dir, 0), UW_REAL_EDITOR: FAKE });
  assert.equal(code, 0, "a completed selection must be accepted");
});

test("the passthrough branch returns 0 even when the editor fails", () => {
  // The inverse rule, and the reason the two branches differ: here the buffer
  // holds the user's prose and a non-zero exit would throw it away.
  const dir = scratchDir();
  const buf = path.join(dir, "prose.md");
  fs.writeFileSync(buf, "how do I write a test for this?\r\n");
  const code = runCmd(CMD, buf, { ...process.env,
    UW_TEST_MARKER: path.join(dir, "m.txt"), UW_REAL_EDITOR: exiter(dir, 7) });
  assert.equal(code, 0, "a failing editor must never make CC discard the user's prose");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const PS1 = "C:/Users/osami/.uw/menu/uwpick-run.ps1";
const REPORT = path.join(os.homedir(), ".uw", "state", "conmode.json");

const run = (child) => {
  try { fs.unlinkSync(REPORT); } catch {}
  const buf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uw-buf-")), "b.md");
  fs.writeFileSync(buf, "m\n");
  let code = 0, out = "";
  try {
    out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
                                      "-File", buf, "-ChildScript", child, "-Diagnose"],
                       { encoding: "utf8", stdio: "pipe", timeout: 30000 });
  } catch (e) { code = e.status ?? -1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  // No console, no measurement. The wrapper opens CONIN$ to set the input mode,
  // and a piped harness -- which is what `node --test` is when it is not attached
  // to a terminal -- has no console input buffer to open. The wrapper says so and
  // exits 1 before writing any report, so the honest outcome is to skip rather
  // than to assert against a file that was never written or, worse, to loosen the
  // assertions until a no-console run passes.
  if (!fs.existsSync(REPORT)) return { code, out, report: null };
  return { code, out, report: JSON.parse(fs.readFileSync(REPORT, "utf8")) };
};

const needsConsole = (t, r) => {
  if (r.report) return false;
  t.skip(`no console available to this harness: ${r.out.trim().split("\n")[0] || "(no output)"}`);
  return true;
};

test("the wrapper restores the console mode after a child that exits 1", (t) => {
  const r = run("../test/fixtures/exit1.mjs");
  if (needsConsole(t, r)) return;
  assert.equal(r.report.childExit, 1);
  assert.equal(r.report.restored, r.report.saved,
    "the saved console mode must be restored even when the child fails");
});

test("the wrapper sets raw VT input while the child runs", (t) => {
  const r = run("../test/fixtures/exit1.mjs");
  if (needsConsole(t, r)) return;
  assert.equal(r.report.set, 0x280);
  assert.equal((r.report.set & 0x02) === 0, true, "ENABLE_LINE_INPUT must be off");
  assert.equal((r.report.set & 0x04) === 0, true, "ENABLE_ECHO_INPUT must be off");
  assert.equal((r.report.set & 0x01) === 0, true, "ENABLE_PROCESSED_INPUT must be off");
});

test("the wrapper propagates the child's exit code", (t) => {
  const r = run("../test/fixtures/exit1.mjs");
  if (needsConsole(t, r)) return;
  assert.equal(r.code, 1);
});

// Static, so it holds with or without a console. These are the two facts that
// have already cost time once each: PowerShell 5.1 parses 0xC0000000 as an Int32,
// which overflows to -1073741824 and throws on the [uint32] cast before the
// P/Invoke is reached; and the restore has to sit in `finally` or a crashing
// child leaves the console raw and the parent shell unusable.
test("the access mask is written in decimal, not hex", () => {
  const src = fs.readFileSync(PS1, "utf8");
  assert.match(src, /\[uint32\]3221225472/);
  // Strip PowerShell comments before forbidding the hex form. The comment that
  // explains WHY the hex form is wrong has to name it, so a raw-source match
  // fails against the file's own documentation -- the third time this exact
  // shape has appeared in this plan's guards, after uwpick.mjs's `.then(` /
  // `on("resize")` / `await` trio. Only executable text can be wrong here.
  const code = src.replace(/#.*$/gm, "");
  assert.doesNotMatch(code, /0xC0000000/i,
    "the hex literal overflows Int32 in PowerShell 5.1 and throws on the cast");
});

test("the restore is in a finally block, not on the success path", () => {
  const src = fs.readFileSync(PS1, "utf8");
  const fin = src.indexOf("} finally {");
  assert.ok(fin > 0, "the wrapper must have a finally block");
  assert.ok(src.indexOf("SetConsoleMode($h, $saved)") > fin,
    "the restore must run after a crash, not only after a clean exit");
});

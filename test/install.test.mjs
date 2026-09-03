import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

// `import`, not `require`. This file is ESM, where `require` is not defined, so
// the original `require("node:path")` calls threw ReferenceError before any
// assertion ran -- the same defect ccr-client.mjs carried in Task A4.
const PS1 = "C:/Users/osami/.uw/menu/install.ps1";
const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), tag));

// -WhatIf and -StateFile keep this off the real User environment entirely.
function plan(args, stateFile, currentEditor) {
  const scratch = tmpdir("uw-inst-");
  const state = stateFile ?? path.join(scratch, "install.json");
  let code = 0, out = "";
  try {
    out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
      "-WhatIf", "-StateFile", state, "-CurrentEditor", currentEditor ?? "", ...args],
      { encoding: "utf8", stdio: "pipe" });
  } catch (e) { code = e.status ?? -1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  return { code, out, state };
}

test("with no EDITOR set, it plans to set both variables", () => {
  const { code, out } = plan([], null, "");
  assert.equal(code, 0);
  assert.match(out, /EDITOR\s*->.*uwpick\.cmd/i);
  assert.match(out, /UW_REAL_EDITOR\s*->/i);
});

test("with a foreign EDITOR and no -Force, it refuses with exit 2", () => {
  const { code, out } = plan([], null, "C:\\Program Files\\vim\\vim.exe");
  assert.equal(code, 2);
  assert.match(out, /refus/i);
  assert.match(out, /vim\.exe/);
  assert.match(out, /-Force/);
});

test("with a foreign EDITOR and -Force, it preserves it into UW_REAL_EDITOR", () => {
  const { code, out } = plan(["-Force"], null, "C:\\Program Files\\vim\\vim.exe");
  assert.equal(code, 0);
  assert.match(out, /UW_REAL_EDITOR\s*->.*vim\.exe/i);
});

test("re-running over an EDITOR we set is idempotent and needs no -Force", () => {
  const scratch = tmpdir("uw-inst2-");
  const state = path.join(scratch, "install.json");
  const cmd = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";
  fs.writeFileSync(state, JSON.stringify({ editorSetBy: "uw", editorValue: cmd }));
  const { code, out } = plan([], state, cmd);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /refus/i);
});

test("-WhatIf writes no state file", () => {
  const { state } = plan([], null, "");
  assert.equal(fs.existsSync(state), false);
});

// --- the optional statusline shim ------------------------------------------
// Every one of these runs against a scratch settings.json. None of them can see
// the live file, which is the rule for the whole suite (constraint 15).
const settings = (command) => {
  const f = path.join(tmpdir("uw-set-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({
    model: "opus", statusLine: { type: "command", command },
    permissions: { allow: ["Bash(git:*)"] },
  }, null, 2));
  return f;
};

test("-Hud plans to wrap the existing command and keeps it intact", () => {
  const f = settings('"C:/node.exe" "C:/hud/omc-hud.mjs"');
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 0);
  assert.match(out, /statusLine\s*->\s*node .*hud-shim\.mjs.*--.*omc-hud\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).statusLine.command,
               '"C:/node.exe" "C:/hud/omc-hud.mjs"', "-WhatIf must not have written");
});

test("-Hud refuses with exit 3 when there is no statusline to wrap", () => {
  const f = path.join(tmpdir("uw-set2-"), "settings.json");
  fs.writeFileSync(f, JSON.stringify({ model: "opus" }));
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 3);
  assert.match(out, /nothing to wrap|no statusLine/i);
});

test("-Hud is idempotent: a second run reports it is already installed", () => {
  const f = settings('node "C:/Users/osami/.uw/menu/hud-shim.mjs" -- "C:/node.exe" "x.mjs"');
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 0);
  assert.match(out, /already installed/i);
});

test("-Hud -HudUninstall restores the stored command exactly", () => {
  const original = '"C:/node.exe" "C:/hud/omc-hud.mjs" --wide';
  // The wrapper must actually LOOK like ours, or guard 1 correctly refuses to
  // touch it. The plan's fixture wrapped with `shim.mjs`, which does not contain
  // "hud-shim.mjs", so it exercised the "someone else rewrote this" branch while
  // asserting the restore branch's output.
  const f = settings(`node "hud-shim.mjs" -- ${original}`);
  const scratch = tmpdir("uw-hud-");
  const state = path.join(scratch, "install.json");
  fs.writeFileSync(path.join(scratch, "hud-install.json"),
                   JSON.stringify({ previousCommand: original, settings: f }));
  const { code, out } = plan(["-Hud", "-HudUninstall", "-SettingsFile", f], state, "");
  assert.equal(code, 0);
  // /restore/i, not /restored/i: under -WhatIf the script says "would restore",
  // which is the correct tense for a dry run and does not contain "restored".
  assert.match(out, /restore/i);
  assert.ok(out.includes(original));
});

test("-Hud -HudUninstall refuses to revert a command someone else rewrote", () => {
  // OMC owns statusLine.command too, and /omc-setup or omc-doctor can replace
  // UW's wrapper at any time. Writing the recorded previousCommand back would
  // then look like a successful uninstall and would have reverted an OMC update.
  const original = '"C:/node.exe" "C:/hud/omc-hud.mjs"';
  const f = settings('"C:/node.exe" "C:/hud/omc-hud.mjs" --brand-new');
  const scratch = tmpdir("uw-hud2-");
  const state = path.join(scratch, "install.json");
  fs.writeFileSync(path.join(scratch, "hud-install.json"),
                   JSON.stringify({ previousCommand: original, settings: f }));
  const { code, out } = plan(["-Hud", "-HudUninstall", "-SettingsFile", f], state, "");
  assert.equal(code, 0);
  assert.match(out, /no longer UW's wrapper/i);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).statusLine.command,
               '"C:/node.exe" "C:/hud/omc-hud.mjs" --brand-new', "it must be left alone");
});

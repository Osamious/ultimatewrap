// `keysync/run.mjs --no-restart`: an apply that refuses, writing nothing, when the
// change would restart the gateway. Exists because a live apply restarts CCR's
// gateway on a content diff, every running Claude Code session routes through
// that gateway, and an unattended or agent-driven run must be able to promise it
// cannot cause that. run.mjs cannot be executed from a test (it reads the vault
// and talks to a live CCR), so the wiring is pinned by source order and the
// prediction it depends on is exercised directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { restartRelevantFingerprint } from "../keysync/safety.mjs";

const source = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8");
// Full-line comments stripped: an indexOf that matches prose in a comment passes
// while the code it describes is gone (the vacuity the repo's own tests name).
const code = source.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

const at = (needle) => {
  const i = code.indexOf(needle);
  assert.ok(i >= 0, `run.mjs no longer contains ${needle}; re-anchor this test`);
  return i;
};

test("--no-restart refuses BEFORE any restore point or write is made", () => {
  const guard = at('has("--no-restart") && willRestart');
  assert.ok(guard < at("snapshotConfigDb(liveConfigDb()"), "the config.sqlite snapshot must come after the guard");
  assert.ok(guard < at("fs.copyFileSync(SETTINGS, backup)"), "the settings backup must come after the guard");
  assert.ok(guard < at('await rpc("saveConfig"'), "saveConfig must come after the guard");
});

test("the refusal exits non-zero and says nothing was written", () => {
  const guard = at('has("--no-restart") && willRestart');
  const block = code.slice(guard, guard + 900);
  assert.match(block, /process\.exit\(2\)/);
  assert.match(block, /Nothing was written/);
});

test("the restart prediction is computed once, above step 0", () => {
  assert.equal(code.split("const afterFingerprint =").length - 1, 1);
  assert.equal(code.split("const willRestart =").length - 1, 1);
  assert.ok(at("const willRestart =") < at("fs.copyFileSync(SETTINGS, backup)"));
});

// ------------------------------------------- the prediction the flag rests on

const base = () => ({
  Providers: [{ name: "acme", api_base_url: "https://acme.invalid/v1", models: ["a", "b"] }],
  gateway: { enabled: true, host: "127.0.0.1", port: 3456, corePort: 3457 },
  observability: { requestLogs: true, requestLogBodyCapture: "errors" },
  plugins: [],
  profile: { profiles: [{ id: "default-claude-code", env: { A: "1" } }] },
  Router: { rules: [] },
});

test("an unchanged config predicts no restart", () => {
  assert.equal(restartRelevantFingerprint(base()), restartRelevantFingerprint(base()));
});

test("changing Providers predicts a restart", () => {
  const b = base();
  b.Providers[0].models.push("c");
  assert.notEqual(restartRelevantFingerprint(base()), restartRelevantFingerprint(b));
});

test("adding a plugin predicts a restart (why wiring a CCR plugin needs one)", () => {
  const b = base();
  b.plugins = [{ id: "uw-schema-sanitizer", enabled: true }];
  assert.notEqual(restartRelevantFingerprint(base()), restartRelevantFingerprint(b));
});

test("a profile-env-only change does NOT predict a restart", () => {
  // The re-added CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY lives in
  // profile.profiles[].env, which CCR's restart predicate never reads -- so the
  // startup-slowdown repair is exactly the kind of apply --no-restart permits.
  const b = base();
  b.profile.profiles[0].env = { A: "1", CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" };
  b.Router = { rules: [{ id: "x" }] };
  assert.equal(restartRelevantFingerprint(base()), restartRelevantFingerprint(b));
});

// Slow-startup regression: CCR writes CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
// into Claude Code's settings env on every profile apply, and at UW's model
// count that makes launch ~10x slower (~100 s vs ~16 s, measured 2026-09-09;
// re-confirmed 2026-09-29). A hand edit held only until the next apply, so the
// fix is a guard in the apply path plus a doctor check for every other route.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripGatewayDiscovery, GATEWAY_DISCOVERY_ENV } from "../keysync/keysync.mjs";
import { assertSettingsInvariants } from "../keysync/safety.mjs";
import { checkGatewayDiscovery, diagnose, GATEWAY_DISCOVERY_CACHE_WARN_BYTES }
  from "../menu/doctor.mjs";

test("the constant names the variable Claude Code actually reads", () => {
  assert.equal(GATEWAY_DISCOVERY_ENV, "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY");
});

test("stripGatewayDiscovery removes the variable and reports it", () => {
  const s = { env: { [GATEWAY_DISCOVERY_ENV]: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" } };
  assert.equal(stripGatewayDiscovery(s), true);
  assert.deepEqual(s.env, { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" });
});

test("stripGatewayDiscovery removes ANY value, because Claude Code gates on truthiness", () => {
  // `if(!a.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY)` -- read from the shipped
  // 2.1.284 binary -- so "0" and "false" are truthy strings and leave it ON.
  for (const v of ["1", "0", "false", "true"]) {
    const s = { env: { [GATEWAY_DISCOVERY_ENV]: v } };
    assert.equal(stripGatewayDiscovery(s), true, `value ${JSON.stringify(v)}`);
    assert.equal(GATEWAY_DISCOVERY_ENV in s.env, false);
  }
});

test("stripGatewayDiscovery is a no-op, and says so, when nothing is set", () => {
  assert.equal(stripGatewayDiscovery({}), false);
  assert.equal(stripGatewayDiscovery({ env: {} }), false);
  assert.equal(stripGatewayDiscovery(null), false);
  const s = { env: { OTHER: "x" } };
  assert.equal(stripGatewayDiscovery(s), false);
  assert.deepEqual(s.env, { OTHER: "x" });
});

test("removing the variable passes the settings-integrity check the write is held to", () => {
  // run.mjs asserts settings.json changed only what keysync owns. The env entry
  // is nested, not a top-level key, so this must not trip the rollback -- the
  // failure mode would be a guard that works and then gets undone.
  const before = { env: { [GATEWAY_DISCOVERY_ENV]: "1", A: "1" }, permissions: { allow: [] },
                   modelPicker: { options: [] } };
  const after = structuredClone(before);
  stripGatewayDiscovery(after);
  assert.doesNotThrow(() => assertSettingsInvariants(before, after));
});

test("run.mjs strips the variable BEFORE it writes settings.json", () => {
  // Order is the whole point: CCR has just written the file with the variable
  // in it, so stripping after the write would leave it there.
  const code = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  const strip = code.indexOf("stripGatewayDiscovery(settings)");
  const write = code.indexOf("atomicWriteJson(SETTINGS, settings)");
  assert.ok(strip > 0, "run.mjs must call stripGatewayDiscovery(settings)");
  assert.ok(write > 0, "the settings write moved; re-anchor this test");
  assert.ok(strip < write, "the strip must precede the write");
});

// ---------------------------------------------------------------- doctor check

test("doctor: the variable being set is RED, whatever its value", () => {
  for (const envValue of ["1", "0", ""]) {
    const c = checkGatewayDiscovery({ envValue, cacheBytes: null });
    assert.equal(c.verdict, "red", `value ${JSON.stringify(envValue)}`);
    assert.equal(c.ok, false);
    assert.match(c.evidence, /keysync\/run\.mjs/);
  }
});

test("doctor: an oversized leftover cache with the variable unset is AMBER, not red", () => {
  const c = checkGatewayDiscovery({ envValue: undefined,
                                    cacheBytes: GATEWAY_DISCOVERY_CACHE_WARN_BYTES + 1 });
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /KB/);
});

test("doctor: a small cache, or none, with the variable unset is green", () => {
  for (const cacheBytes of [null, 0, GATEWAY_DISCOVERY_CACHE_WARN_BYTES]) {
    const c = checkGatewayDiscovery({ envValue: undefined, cacheBytes });
    assert.equal(c.verdict, "green", `cacheBytes ${cacheBytes}`);
    assert.equal(c.ok, true);
  }
});

test("doctor: the variable outranks the cache when both are present", () => {
  const c = checkGatewayDiscovery({ envValue: "1", cacheBytes: 900_000 });
  assert.equal(c.verdict, "red");
});

test("diagnose includes the check only when given inputs, and takes the worst verdict", () => {
  const base = { env: {}, handoff: [], current: {}, pinned: {} };
  const without = diagnose(base);
  assert.equal(without.checks.some((c) => c.name === "startup-discovery"), false);
  const red = diagnose({ ...base, gatewayDiscovery: { envValue: "1", cacheBytes: null } });
  const row = red.checks.find((c) => c.name === "startup-discovery");
  assert.equal(row?.verdict, "red");
  assert.equal(red.verdict, "red");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { transform, wrapCommand, unwrapCommand } from "../menu/hud-shim.mjs";

const SHIM = path.join(os.homedir(), ".uw", "menu", "hud-shim.mjs");

const IX = new Map([["google/gemini-3.5-pro", 1000000],
                    ["anthropic/claude-opus-5", 200000]]);
const PAYLOAD = (over = {}) => JSON.stringify({
  session_id: "s1", version: "2.1.258",
  model: { id: "google/gemini-3.5-pro", display_name: "Google > gemini-3.5-pro" },
  context_window: {
    total_input_tokens: 168661, total_output_tokens: 377, context_window_size: 200000,
    current_usage: { input_tokens: 2, output_tokens: 377,
                     cache_creation_input_tokens: 37950, cache_read_input_tokens: 130709 },
    used_percentage: 84, remaining_percentage: 16, ...over,
  },
  cost: { total_cost_usd: 1.5 },
});

// --- Step 0: the measured payload, and the three cases that follow from it ---
//
// Captured 2026-09-03 from a throwaway session with a CCR-routed non-Anthropic
// model selected, read from the OMC HUD's own stdin cache:
//
//   model.id           = "google/gemini-3.5-flash-lite"
//   model.display_name = "google > gemini-3.5-flash-lite"
//   version            = 2.1.259
//   context_window_size = 200000        <- the defect: the real window is 1048576
//
// Two facts settle the shim's key shape. Non-Anthropic ids arrive as BARE
// `provider/model` with no decoration, so the exact lookup is correct. And the
// `[1m]` suffix seen on `anthropic/claude-opus-5[1m]` is Anthropic-specific -- a
// 1M-context beta marker -- so a miss there is the right answer rather than a
// bug: relay rows carry `ctx: null`, and the live index holds zero `anthropic/*`
// keys. This index mirrors that.
const REAL_IX = new Map([["google/gemini-3.5-flash-lite", 1048576]]);
const REAL_PAYLOAD = (id) => JSON.stringify({
  session_id: "s1", version: "2.1.259",
  model: { id, display_name: "google > gemini-3.5-flash-lite" },
  context_window: { context_window_size: 200000 },
});

test("the measured non-Anthropic id hits the index and gets the real window", () => {
  const out = JSON.parse(transform(REAL_PAYLOAD("google/gemini-3.5-flash-lite"), REAL_IX));
  assert.equal(out.context_window.context_window_size, 1048576,
    "the HUD showed 200000 for a model whose window is 1048576");
});

test("a suffixed Anthropic id misses and forwards untouched", () => {
  assert.equal(transform(REAL_PAYLOAD("anthropic/claude-opus-5[1m]"), REAL_IX), null);
});

test("an id in no index at all forwards untouched", () => {
  assert.equal(transform(REAL_PAYLOAD("nobody/nothing"), REAL_IX), null);
});

test("a decorated non-Anthropic id still resolves, defensively", () => {
  // Costs nothing and changes no current behaviour, since nothing decorates a
  // non-Anthropic id today. It means a future Claude Code that starts doing so
  // degrades to a correct lookup instead of silently forwarding forever -- which
  // is the failure mode Step 0 existed to rule out, and the one that passes every
  // test while doing nothing.
  const out = JSON.parse(transform(REAL_PAYLOAD("google/gemini-3.5-flash-lite[1m]"), REAL_IX));
  assert.equal(out.context_window.context_window_size, 1048576);
});

// --- Step 0a: the observed OMC statusline command --------------------------
// Not a made-up shape: mixed separators and quoted paths are exactly what the
// wrapper has to survive. Backslashes are escaped -- written as single-character
// \n this literal would contain actual newlines rather than an nvm4w path.
export const OMC_COMMAND =
  '"C:\\nvm4w\\nodejs\\node.exe" "C:/Users/osami/.claude/hud/omc-hud.mjs"';

test("the wrapped command survives wrapping and unwrapping unchanged", () => {
  const wrapped = wrapCommand(SHIM, OMC_COMMAND);
  assert.ok(wrapped.endsWith(OMC_COMMAND), "the remainder is opaque and passed through byte for byte");
  assert.equal(unwrapCommand(wrapped), OMC_COMMAND);
});

test("unwrapCommand refuses a command that is not ours", () => {
  assert.equal(unwrapCommand(OMC_COMMAND), null);
  assert.equal(unwrapCommand(""), null);
  assert.equal(unwrapCommand('node "other.mjs" -- x'), null);
});

test("the mixed separators and the nvm4w interpreter survive untouched", () => {
  // UW appends a prefix and removes the same prefix; the remainder is bytes. It
  // must not normalise separators or resolve the interpreter -- both are OMC's
  // business, and the pinned absolute node.exe is OMC's choice to make.
  const wrapped = wrapCommand(SHIM, OMC_COMMAND);
  assert.match(wrapped, /nvm4w\\nodejs\\node\.exe/);
  assert.match(wrapped, /\.claude\/hud\/omc-hud\.mjs/);
});

// --- transform ---------------------------------------------------------------

test("a known model gets the real context window", () => {
  const out = JSON.parse(transform(PAYLOAD(), IX));
  assert.equal(out.context_window.context_window_size, 1000000);
});

test("percentages are recomputed from current_usage, not scaled", () => {
  const out = JSON.parse(transform(PAYLOAD(), IX));
  const used = 2 + 37950 + 130709;                       // 168661
  assert.equal(out.context_window.used_percentage, Math.round((used / 1000000) * 100));
  assert.equal(out.context_window.remaining_percentage, 100 - out.context_window.used_percentage);
});

test("without current_usage the percentages are left exactly as they arrived", () => {
  const raw = PAYLOAD({ current_usage: undefined });
  const out = JSON.parse(transform(raw, IX));
  assert.equal(out.context_window.context_window_size, 1000000);
  assert.equal(out.context_window.used_percentage, 84);
  assert.equal(out.context_window.remaining_percentage, 16);
});

test("an unknown model forwards the original untouched", () => {
  const raw = JSON.stringify({ model: { id: "nobody/nothing" }, context_window: {} });
  assert.equal(transform(raw, IX), null);
});

test("a model whose window already matches forwards the original untouched", () => {
  const raw = JSON.stringify({
    model: { id: "anthropic/claude-opus-5" },
    context_window: { context_window_size: 200000 },
  });
  assert.equal(transform(raw, IX), null);
});

test("non-JSON forwards the original untouched", () => {
  assert.equal(transform("this is not json", IX), null);
  assert.equal(transform("", IX), null);
});

test("an empty index forwards the original untouched", () => {
  assert.equal(transform(PAYLOAD(), new Map()), null);
});

test("every other field survives the round trip byte for byte in meaning", () => {
  const before = JSON.parse(PAYLOAD());
  const after = JSON.parse(transform(PAYLOAD(), IX));
  assert.equal(after.session_id, before.session_id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.model, before.model);
  assert.deepEqual(after.cost, before.cost);
  assert.equal(after.context_window.total_input_tokens, before.context_window.total_input_tokens);
  assert.deepEqual(after.context_window.current_usage, before.context_window.current_usage);
});

test("percentages stay integers within 0 and 100 even for absurd usage", () => {
  const raw = PAYLOAD({ current_usage: { input_tokens: 99e9, output_tokens: 0,
                                         cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const cw = JSON.parse(transform(raw, IX)).context_window;
  assert.equal(cw.used_percentage, 100);
  assert.equal(cw.remaining_percentage, 0);
  assert.equal(Number.isInteger(cw.used_percentage), true);
});

test("end to end: the shim wraps a command and passes stdout and exit code through", () => {
  const dir = path.join(os.homedir(), ".uw", "harness", "scratch", "hud");
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, "stub.mjs");
  fs.writeFileSync(stub, [
    "import fs from 'node:fs';",
    "const raw = fs.readFileSync(0, 'utf8');",
    "process.stdout.write(raw);",
    "process.exit(7);",
  ].join("\n"));

  const r = spawnSync(process.execPath, [SHIM, "--", `"${process.execPath}" "${stub}"`],
                      { input: PAYLOAD(), encoding: "utf8" });
  assert.equal(r.status, 7);
  // The live snapshot is the index here, so the assertion is about pass-through
  // and exit code rather than about a particular window: this payload's model is
  // a fixture id that the real catalogue may or may not carry.
  assert.ok(r.stdout.length > 0, "the payload must reach the wrapped command");
  assert.doesNotThrow(() => JSON.parse(r.stdout));

  const bad = spawnSync(process.execPath, [SHIM, "--", `"${process.execPath}" "${stub}"`],
                        { input: "not json at all", encoding: "utf8" });
  assert.equal(bad.stdout, "not json at all");
  assert.equal(bad.status, 7);
});

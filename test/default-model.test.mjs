// The owner's fixed default model (plans/default-model-fix-plan.md, candidate A).
//
// run.mjs cannot be executed from a test (it reads the vault and talks to a live
// CCR), so its wiring is pinned by source order, the repo's style (see
// no-restart-guard.test.mjs), and the behaviour is exercised through the pure
// functions it calls plus `fakeCcrApply`, an offline mirror of what CCR does to
// settings.json on every profile apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { spawnSync } from "node:child_process";
import {
  DefaultModelError, DEFAULT_MODEL_ENV_KEYS, validateShape, envFormOf, load, resolveDefault,
  withDefaultModel, applyDefaultModel, assertDefaultModel, assertSavedProfile, savedProfileModels,
  envModelChangeWarning, setDefaultModel, clearDefaultModel, showDefaultModel, SET_NOTE, CLEAR_NOTE,
  formatShow, resolveDefaultModelFile, assertNoOrphanMarker, writeMarker, markerFor, markerPresent,
  postCommitNotice, DEFAULT_MODEL_FILE, DEFAULT_MODEL_MARKER, MAX_FILE_BYTES
} from "../keysync/default-model.mjs";
import { ANTHROPIC_TIERS, stripOneMSuffix } from "../keysync/keysync.mjs";
import { assertSettingsInvariants, restartRelevantFingerprint } from "../keysync/safety.mjs";
import { admitId } from "../menu/sanitize.mjs";

const SONNET55 = "anthropic/claude-sonnet-5-5[1m]";
const tmp = () => mkTmp("uw-defmodel-");
const write = (dir, name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };

// ------------------------------------------------------------- the CCR mirror
// Mirrors CCR 3.0.22 (research copy packages/core/src/profiles/service.ts
// applyClaudeCodeProfile :387/:420-421 + :2218-2244, and
// agents/claude-code/environment.ts :11-20, :51-71): clear the 8 managed env keys,
// re-derive the three model vars from profile.model (one value, three names) and the
// alias vars from the tier fields, appending `[1m]` iff the id's window is >= 1M and
// it is not already suffixed. ANTHROPIC_SMALL_FAST_MODEL is cleared and never
// re-set. Every other key (model, effortLevel, modelSettings, ...) is untouched.
const MANAGED = [
  "ANTHROPIC_MODEL", "CCR_CLAUDE_CODE_MODEL", "CODEXL_CLAUDE_CODE_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"
];
const WINDOWS = {
  "anthropic/claude-opus-5": 1e6, "anthropic/claude-sonnet-5": 1e6, "anthropic/claude-fable-5-1": 1e6,
  "anthropic/claude-sonnet-5-5": 1e6
};
function fakeCcrApply(settings, profile, windows = WINDOWS) {
  const out = structuredClone(settings);
  const env = { ...(out.env ?? {}) };
  for (const k of MANAGED) delete env[k];
  const one = (id) => (!id ? "" : /\[1m\]$/i.test(id) ? id : (windows[id] >= 1e6 ? `${id}[1m]` : id));
  const m = one(profile.model);
  if (m) env.ANTHROPIC_MODEL = env.CCR_CLAUDE_CODE_MODEL = env.CODEXL_CLAUDE_CODE_MODEL = m;
  if (profile.fableModel) env.ANTHROPIC_DEFAULT_FABLE_MODEL = one(profile.fableModel);
  if (profile.opusModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = one(profile.opusModel);
  if (profile.sonnetModel) env.ANTHROPIC_DEFAULT_SONNET_MODEL = one(profile.sonnetModel);
  const haiku = profile.haikuModel || profile.smallFastModel;
  if (haiku) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = one(haiku);
  out.env = env;
  return out;
}

// What run.mjs does after saveConfig, in its order: CCR rewrite -> re-assert ->
// strip -> final assertion. Returns { settings, healed }.
function chain(settingsIn, tiers, def, windows) {
  const settings = fakeCcrApply(settingsIn, tiers, windows);
  const healed = applyDefaultModel(settings, def);
  stripOneMSuffix(settings);
  assertDefaultModel(settings, def);
  return { settings, healed };
}

const ownerSettings = () => ({
  model: "anthropic/claude-opus-5[1m]",
  effortLevel: "high",
  modelSettings: { "claude-sonnet-5-5": { effort: "high" }, [SONNET55]: { effort: "xhigh" } },
  permissions: { allow: ["Bash(git status)"] },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
  apiKeyHelper: "node helper.js",
  env: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:3456",
    ANTHROPIC_MODEL: "anthropic/claude-opus-5[1m]",
    CCR_CLAUDE_CODE_MODEL: "anthropic/claude-opus-5[1m]",
    CODEXL_CLAUDE_CODE_MODEL: "anthropic/claude-opus-5[1m]"
  }
});
const def = { model: SONNET55, via: "default-file" };
const profileWith = (tiers) => ({ ...tiers });

// ----------------------------------------------------------------- shape rules
test("shape: the deny-list accepts every real picker-row shape, including [1M] and ~", () => {
  for (const id of [SONNET55, "teamorouter/kimi-k3[1M]", "openrouter/~z-ai/glm-latest",
    "tokenrouter/anthropic/claude-sonnet-5[1m]", "groq/llama-3.3-70b-versatile"]) {
    assert.equal(validateShape(id), id);
  }
});

test("shape: empty, whitespace, control, quote, comma, backslash and no-slash ids are rejected", () => {
  for (const id of ["", " ", "a/b c", "a/b\n", "a/b\u0000c", "a/\"b", "a/b,c", "a\\b/c", "noslash", "/x", "x/", 5, null, undefined]) {
    assert.throws(() => validateShape(id), DefaultModelError, JSON.stringify(id));
  }
});

test("envFormOf: anthropic/* keeps [1m]/[1M]; third party loses it; same answer as stripOneMSuffix", () => {
  assert.equal(envFormOf(SONNET55), SONNET55);
  assert.equal(envFormOf("anthropic/x[1M]"), "anthropic/x[1M]");
  assert.equal(envFormOf("acme/x[1m]"), "acme/x");
  assert.equal(envFormOf("acme/x[1M]"), "acme/x");
  assert.equal(envFormOf("acme/x"), "acme/x");
  for (const v of [SONNET55, "anthropic/x[1M]", "acme/x[1m]", "acme/x[1M]", "acme/x"]) {
    const s = { env: { ANTHROPIC_MODEL: v } };
    stripOneMSuffix(s);
    assert.equal(s.env.ANTHROPIC_MODEL, envFormOf(v), v);
  }
});

// ---------------------------------------------------------------------- loader
test("load: ENOENT is the ONLY null; unset keeps today's behaviour", () => {
  const d = tmp();
  assert.equal(load(path.join(d, "absent.json")), null);
});

test("load: a corrupt or malformed file is a loud error naming the file, never 'unset'", () => {
  const d = tmp();
  const cases = {
    corrupt: "{not json", empty: "", array: "[]", nul: "null", noModel: "{}",
    nonString: '{"model":5}', emptyString: '{"model":""}', control: '{"model":"a/b\\nc"}',
    noSlash: '{"model":"sonnet"}', quote: '{"model":"a/\\"b"}', comma: '{"model":"a/b,c"}'
  };
  for (const [name, text] of Object.entries(cases)) {
    const f = write(d, `${name}.json`, text);
    assert.throws(() => load(f), (e) => e instanceof DefaultModelError && e.message.includes(f), name);
  }
});

test("load: tolerates a BOM and CRLF (a hand edit in Notepad) and reads the owner's value", () => {
  const d = tmp();
  const f = write(d, "dm.json", `﻿{\r\n  "model": "${SONNET55}",\r\n  "setAt": "2026-10-01T00:00:00.000Z"\r\n}\r\n`);
  assert.deepEqual(load(f), { model: SONNET55, setAt: "2026-10-01T00:00:00.000Z" });
});

test("load: an unreadable path (a directory) throws rather than reading as unset", () => {
  const d = tmp();
  assert.throws(() => load(d), DefaultModelError);
});

// -------------------------------------------------------------------- resolve
const rows = (...ids) => ids.map((model) => ({ model }));

test("resolve: an exact picker row is honoured; null def is null", () => {
  assert.equal(resolveDefault(null, rows(SONNET55)), null);
  assert.deepEqual(resolveDefault({ model: SONNET55 }, rows("x/y", SONNET55)), { model: SONNET55, via: "default-file" });
});

test("resolve: an id absent from built.picker is loud, names the value, file, near-miss and remedies", () => {
  const d = tmp();
  const prev = process.env.UW_DEFAULT_MODEL_FILE;
  process.env.UW_DEFAULT_MODEL_FILE = path.join(d, "dm.json");
  try {
    const bare = "anthropic/claude-sonnet-5-5";
    assert.throws(() => resolveDefault({ model: bare }, rows(SONNET55, "x/y")), (e) => {
      assert.ok(e instanceof DefaultModelError);
      for (const needle of ["anthropic/claude-sonnet-5-5", path.join(d, "dm.json"), SONNET55, "default-model clear", "--no-profile"]) {
        assert.ok(e.message.includes(needle), `missing ${needle} in: ${e.message}`);
      }
      return true;
    });
    // case is significant: the id is written verbatim into env
    assert.throws(() => resolveDefault({ model: SONNET55.toUpperCase() }, rows(SONNET55)), DefaultModelError);
  } finally {
    if (prev === undefined) delete process.env.UW_DEFAULT_MODEL_FILE; else process.env.UW_DEFAULT_MODEL_FILE = prev;
  }
});

test("resolve: an anthropic default with the relay down fails loudly and names the cause + --no-profile", () => {
  const relayDownPicker = rows("openrouter/x", "groq/y");
  assert.throws(() => resolveDefault({ model: SONNET55 }, relayDownPicker, { anthropicOn: false }), (e) =>
    e instanceof DefaultModelError && /relay is down/.test(e.message) && e.message.includes("--no-profile"));
});

// ---------------------------------------------------------------------- tiers
test("withDefaultModel: only `model` changes; relay-on keeps the five other tier constants", () => {
  const snapshot = structuredClone(ANTHROPIC_TIERS);
  const t = withDefaultModel(ANTHROPIC_TIERS, def);
  assert.notEqual(t, ANTHROPIC_TIERS);
  assert.equal(t.model, SONNET55);
  const { model: _a, ...restA } = ANTHROPIC_TIERS;
  const { model: _b, ...restT } = t;
  assert.deepEqual(restT, restA);
  assert.deepEqual(ANTHROPIC_TIERS, snapshot, "ANTHROPIC_TIERS must never be mutated");
});

test("withDefaultModel: relay-off keeps every other tier on the anchor", () => {
  const anchor = "openrouter/some-model";
  const base = { model: anchor, opusModel: anchor, sonnetModel: anchor, haikuModel: anchor, smallFastModel: anchor, fableModel: anchor };
  const t = withDefaultModel(base, def);
  assert.deepEqual(t, { ...base, model: SONNET55 });
  assert.deepEqual(base.model, anchor);
});

test("unset: withDefaultModel returns today's tiers object itself; apply/assert are no-ops", () => {
  const snapshot = structuredClone(ANTHROPIC_TIERS);
  assert.equal(withDefaultModel(ANTHROPIC_TIERS, null), ANTHROPIC_TIERS);
  const s = ownerSettings();
  const before = structuredClone(s);
  assert.equal(applyDefaultModel(s, null), 0);
  assert.doesNotThrow(() => assertDefaultModel(s, null));
  assert.deepEqual(s, before);
  assert.deepEqual(ANTHROPIC_TIERS, snapshot);
});

// ------------------------------------------------------------- the CCR cycle
test("default honoured: CCR derives the three vars from profile.model; the four tier mappings stay", () => {
  const tiers = withDefaultModel(ANTHROPIC_TIERS, def);
  const { settings, healed } = chain(ownerSettings(), profileWith(tiers), def);
  for (const k of DEFAULT_MODEL_ENV_KEYS) assert.equal(settings.env[k], SONNET55, k);
  assert.equal(healed, 0, "CCR already produced exactly this");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "anthropic/claude-opus-5[1m]");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "anthropic/claude-sonnet-5[1m]");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "anthropic/claude-haiku-4-5-20251001");
  assert.equal(settings.env.ANTHROPIC_DEFAULT_FABLE_MODEL, "anthropic/claude-fable-5-1[1m]");
});

test("idempotent: a second pass over its own output is byte-identical", () => {
  const tiers = withDefaultModel(ANTHROPIC_TIERS, def);
  const first = chain(ownerSettings(), profileWith(tiers), def).settings;
  const second = chain(first, profileWith(tiers), def).settings;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("CCR takeover re-asserted: a stale profile (old anchor) rewrites all three; keysync puts the default back", () => {
  const stale = { ...ANTHROPIC_TIERS }; // profile.model = anthropic/claude-opus-5, what a CCR apply from a stale DB uses
  const rewritten = fakeCcrApply(ownerSettings(), stale);
  for (const k of DEFAULT_MODEL_ENV_KEYS) assert.equal(rewritten.env[k], "anthropic/claude-opus-5[1m]");
  const { settings, healed } = chain(ownerSettings(), stale, def);
  assert.equal(healed, 3);
  for (const k of DEFAULT_MODEL_ENV_KEYS) assert.equal(settings.env[k], SONNET55, k);
});

test("CCR adds [1m] to a bare default: keysync restores the owner's exact spelling", () => {
  const bare = { model: "anthropic/claude-sonnet-5-5" };
  const tiers = withDefaultModel(ANTHROPIC_TIERS, bare);
  const rewritten = fakeCcrApply(ownerSettings(), tiers);
  assert.equal(rewritten.env.ANTHROPIC_MODEL, "anthropic/claude-sonnet-5-5[1m]");
  const { settings, healed } = chain(ownerSettings(), tiers, bare);
  assert.equal(healed, 3);
  for (const k of DEFAULT_MODEL_ENV_KEYS) assert.equal(settings.env[k], "anthropic/claude-sonnet-5-5", k);
});

test("third-party default: re-asserted pre-strip, [1m] dropped by the existing strip, assertion agrees", () => {
  const tp = { model: "teamorouter/kimi-k3[1M]" };
  const tiers = withDefaultModel(ANTHROPIC_TIERS, tp);
  const { settings } = chain(ownerSettings(), tiers, tp);
  for (const k of DEFAULT_MODEL_ENV_KEYS) assert.equal(settings.env[k], "teamorouter/kimi-k3", k);
});

test("assertDefaultModel throws naming the variable when any of the three is missing or different", () => {
  for (const k of DEFAULT_MODEL_ENV_KEYS) {
    const s = { env: Object.fromEntries(DEFAULT_MODEL_ENV_KEYS.map((x) => [x, SONNET55])) };
    delete s.env[k];
    assert.throws(() => assertDefaultModel(s, def), (e) => e.message.includes(k), `missing ${k}`);
    s.env[k] = "anthropic/claude-opus-5[1m]";
    assert.throws(() => assertDefaultModel(s, def), (e) => e.message.includes(k), `different ${k}`);
  }
  assert.throws(() => assertDefaultModel({}, def), DefaultModelError);
});

test("effort and every other key untouched: only the three vars may differ; invariants hold", () => {
  const input = ownerSettings();
  const afterCcr = fakeCcrApply(input, ANTHROPIC_TIERS);
  const { settings } = chain(input, withDefaultModel(ANTHROPIC_TIERS, def), def);
  for (const k of ["model", "effortLevel", "modelSettings", "permissions", "hooks", "apiKeyHelper"]) {
    assert.deepEqual(settings[k], input[k], k);
  }
  assert.equal(settings.env.ANTHROPIC_BASE_URL, input.env.ANTHROPIC_BASE_URL);
  const changed = Object.keys({ ...afterCcr.env, ...settings.env }).filter((k) => afterCcr.env[k] !== settings.env[k]);
  assert.deepEqual(changed.sort(), [...DEFAULT_MODEL_ENV_KEYS].sort());
  assert.doesNotThrow(() => assertSettingsInvariants(afterCcr, settings));
});

test("the mirror itself leaves model/effortLevel/modelSettings alone (guards the fake)", () => {
  const input = ownerSettings();
  const out = fakeCcrApply(input, ANTHROPIC_TIERS);
  for (const k of ["model", "effortLevel", "modelSettings"]) assert.deepEqual(out[k], input[k], k);
});

// ------------------------------------------------- persisted input + warnings
const savedConfig = (m1, m2) => ({
  profile: { profiles: [{ id: "p1", agent: "claude-code", enabled: true, model: m1 }], claudeCode: { model: m2 } }
});

test("assertSavedProfile: passes only when profile.profiles[] and profile.claudeCode.model both persisted the default", () => {
  assert.doesNotThrow(() => assertSavedProfile(savedConfig(SONNET55, SONNET55), "p1", def));
  assert.throws(() => assertSavedProfile(savedConfig("anthropic/claude-opus-5", SONNET55), "p1", def), /profile\.profiles\[\]\.model/);
  assert.throws(() => assertSavedProfile(savedConfig(SONNET55, "anthropic/claude-opus-5"), "p1", def), /profile\.claudeCode\.model/);
  assert.throws(() => assertSavedProfile({}, "p1", def), DefaultModelError);
  assert.doesNotThrow(() => assertSavedProfile({}, "p1", null));
  assert.deepEqual(savedProfileModels(savedConfig("a/b", "c/d"), "p1"), { profileModel: "a/b", claudeCodeModel: "c/d" });
  assert.deepEqual(savedProfileModels({}, "p1"), { profileModel: undefined, claudeCodeModel: undefined });
});

test("envModelChangeWarning: warns when the run would change a hand-set value; read-only; never throws", () => {
  const d = tmp();
  const f = write(d, "settings.json", JSON.stringify({ env: { ANTHROPIC_MODEL: SONNET55 } }));
  const bytes = fs.readFileSync(f);
  const w = envModelChangeWarning(f, "anthropic/claude-opus-5");
  assert.match(w, /WARNING/);
  assert.ok(w.includes(SONNET55) && w.includes("anthropic/claude-opus-5"));
  assert.deepEqual(fs.readFileSync(f), bytes, "must not write");
  assert.equal(envModelChangeWarning(f, "anthropic/claude-sonnet-5-5"), null, "[1m] spelling is not a change");
  assert.equal(envModelChangeWarning(path.join(d, "absent.json"), "x/y"), null);
  assert.equal(envModelChangeWarning(write(d, "bad.json", "{oops"), "x/y"), null);
  assert.equal(envModelChangeWarning(write(d, "noenv.json", "{}"), "x/y"), null);
});

test("fingerprint: a default-only change (profile model fields) predicts no gateway restart", () => {
  const base = () => ({
    Providers: [{ name: "acme", api_base_url: "https://acme.invalid/v1", models: ["a"] }],
    gateway: { enabled: true, host: "127.0.0.1", port: 3456, corePort: 3457 },
    plugins: [], Router: { rules: [] },
    profile: { profiles: [{ id: "p1", agent: "claude-code", model: "anthropic/claude-opus-5" }],
      claudeCode: { model: "anthropic/claude-opus-5" } }
  });
  const b = base();
  b.profile.profiles[0].model = SONNET55;
  b.profile.claudeCode.model = SONNET55;
  assert.equal(restartRelevantFingerprint(base()), restartRelevantFingerprint(b));
});

// ------------------------------------------------------------------------ CLI
test("CLI logic: set writes parseable LF JSON, leaves no temp debris, never reads built-rows.json", () => {
  const d = tmp();
  const f = path.join(d, "default-model.json");
  // The REAL snapshot shape: an object, taken BEFORE relay rows are added, so it holds zero anthropic/* rows.
  write(d, "built-rows.json", JSON.stringify({ generatedAt: "2026-10-01T00:00:00.000Z", rows: ["openrouter/x"] }));
  const idsFile = write(d, "ids.json", JSON.stringify({ ids: ["claude-sonnet-5-5"] }));
  const r = setDefaultModel({ id: SONNET55, file: f, idsFile, now: () => new Date("2026-10-01T12:00:00Z") });
  assert.deepEqual(r.warnings, []);
  const text = fs.readFileSync(f, "utf8");
  assert.ok(!text.includes("\r"));
  assert.deepEqual(JSON.parse(text), { model: SONNET55, setAt: "2026-10-01T12:00:00.000Z" });
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes(".tmp-")), []);
  assert.deepEqual(load(f), { model: SONNET55, setAt: "2026-10-01T12:00:00.000Z" });
  for (const f of ["default-model.mjs", "key.mjs"]) {
    const src = strip(fs.readFileSync(new URL(`../keysync/${f}`, import.meta.url), "utf8"));
    assert.ok(!src.includes("built-rows"), `${f} must not gate on the pre-relay snapshot`);
  }
});

test("CLI logic: set rejects a bad shape and writes nothing", () => {
  const d = tmp();
  const f = path.join(d, "default-model.json");
  assert.throws(() => setDefaultModel({ id: "no-slash", file: f }), DefaultModelError);
  assert.throws(() => setDefaultModel({ id: 'a/"b', file: f }), DefaultModelError);
  assert.ok(!fs.existsSync(f));
});

test("CLI logic: an unknown anthropic id is an ADVISORY warning, never a refusal; --force silences it", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  const idsFile = write(d, "ids.json", JSON.stringify({ ids: ["claude-opus-5"] }));
  const r = setDefaultModel({ id: SONNET55, file: f, idsFile });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /claude-sonnet-5-5/);
  assert.equal(load(f).model, SONNET55);
  assert.deepEqual(setDefaultModel({ id: SONNET55, file: f, idsFile, force: true }).warnings, []);
  assert.equal(setDefaultModel({ id: SONNET55, file: f, idsFile: path.join(d, "nope.json") }).warnings.length, 1);
  const tp = setDefaultModel({ id: "openrouter/x", file: f, idsFile }).warnings;
  assert.equal(tp.length, 1, "a non-anthropic id gets the shape-checked-only advisory, not the cache advisory");
  assert.match(tp[0], /shape-checked only/);
  assert.match(tp[0], /live picker rows at the next run/);
  assert.ok(!tp[0].includes("Anthropic id cache"));
});

test("CLI logic: show reports unset and set; clear removes the file and is idempotent", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  assert.deepEqual(showDefaultModel({ file: f }), { file: f, def: null });
  setDefaultModel({ id: SONNET55, file: f, idsFile: path.join(d, "x.json") });
  assert.equal(showDefaultModel({ file: f }).def.model, SONNET55);
  assert.deepEqual(clearDefaultModel({ file: f }), { file: f, existed: true, marker: markerFor(f), markerRemoved: false });
  assert.ok(!fs.existsSync(f));
  assert.deepEqual(clearDefaultModel({ file: f }), { file: f, existed: false, marker: markerFor(f), markerRemoved: false });
});

test("CLI end to end (subprocess, temp file): set / show / clear, with the owner-facing notes", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  const key = new URL("../keysync/key.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const run = (...a) => spawnSync(process.execPath, [key, "default-model", ...a],
    { encoding: "utf8", env: { ...process.env, UW_DEFAULT_MODEL_FILE: f } });
  let r = run("show");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /default model: none/);
  r = run("set", SONNET55, "--force");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(SET_NOTE), r.stdout);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).model, SONNET55);
  r = run("show");
  assert.match(r.stdout, new RegExp(`default model: ${SONNET55.replace(/[[\]]/g, "\\$&")}`));
  r = run("set", "bad id/with space");
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).model, SONNET55, "a rejected set keeps the previous value");
  r = run("clear");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(CLEAR_NOTE), r.stdout);
  assert.ok(!fs.existsSync(f));
  fs.writeFileSync(f, "{corrupt");
  r = run("show");
  assert.equal(r.status, 1, "a corrupt file is loud in the CLI too");
});

// ------------------------------------------------------------- wiring by order
const RUN = fs.readFileSync(new URL("../keysync/run.mjs", import.meta.url), "utf8");
const MOD = fs.readFileSync(new URL("../keysync/default-model.mjs", import.meta.url), "utf8");
const strip = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const code = strip(RUN);
const at = (needle, from = 0) => {
  const i = code.indexOf(needle, from);
  assert.ok(i >= 0, `run.mjs no longer contains ${needle}; re-anchor this test`);
  return i;
};

// The REAL --dry exit line. (`if (dry) {` first occurs INSIDE the default block, so it is not an anchor.)
const DRY_EXIT = 'console.log("\\n--dry: nothing written.")';

test("wiring: the default is resolved before --dry returns and before any lock/backup/snapshot/save", () => {
  const resolve = at("resolveDefault(loaded,");
  const dry = at(DRY_EXIT);
  assert.ok(resolve < dry, "validated before --dry's exit, like collisions.fatal");
  for (const later of ["acquireLock()", "fs.copyFileSync(SETTINGS, backup)", "snapshotConfigDb(liveConfigDb()", 'await rpc("saveConfig"']) {
    assert.ok(resolve < at(later), `resolveDefault must precede ${later}`);
  }
  const block = code.slice(resolve, dry);
  assert.ok(block.indexOf('!has("--no-profile")') < block.indexOf("process.exit(1)"), "--no-profile only warns");
  assert.ok(block.includes("console.warn("));
});

test("wiring: --dry reads no settings.json and calls no settings-reading helper", () => {
  const dry = at(DRY_EXIT);
  const end = at("process.exit(0);", dry);
  const dryRegion = code.slice(0, end);
  assert.ok(!/readFileSync\(SETTINGS/.test(dryRegion), "no settings read before --dry exits");
  assert.ok(!dryRegion.includes("envModelChangeWarning("));
  assert.ok(!dryRegion.includes("SETTINGS"), "SETTINGS is not even resolved before --dry exits");
});

test("wiring: tiers carry the default; the no-default settings read happens before saveConfig, read-only", () => {
  assert.ok(at("withDefaultModel(") < at("const p = cfg.profile?.profiles?.find"));
  const warn = at("envModelChangeWarning(SETTINGS");
  assert.ok(warn < at('await rpc("saveConfig"'));
  assert.ok(warn > at("const applyProfile ="));
  assert.ok(code.slice(warn - 40, warn).includes("!def") || code.slice(warn - 120, warn).includes("!def"));
});

test("wiring: the persisted-profile assertion runs after saveConfig, inside the restore-on-failure try, before the settings merge", () => {
  const save = at('await rpc("saveConfig"');
  const tryAt = at("try {", save);
  const assertAt = at("assertSavedProfile(saved, p.id, def)");
  assert.ok(save < tryAt && tryAt < assertAt);
  assert.ok(assertAt < at("const settingsRaw ="));
  assert.ok(assertAt < at("atomicWriteJson(SETTINGS, settings)"));
  assert.ok(assertAt < at("} catch (err) {", save), "inside the try whose catch restores settings");
});

test("wiring: re-assert before the strip; final assertion after the invariants and before 'keysync complete'", () => {
  assert.ok(at("applyDefaultModel(settings, def)") < at("stripOneMSuffix(settings)"));
  const inv = at("assertSettingsInvariants(settingsBefore, final)");
  const fin = at("assertDefaultModel(final, def)");
  assert.ok(inv < fin && fin < at('console.log("keysync complete")'));
  assert.ok(fin < at("} catch (err) {", fin), "inside the try");
});

test("wiring: the log line sits beside the anchor line and the saved line prints the persisted model", () => {
  const anchor = at("profile anchor: ${anchorModel}");
  const line = at("(from default-model.json; overrides the anchor for profile.model)");
  assert.ok(line > anchor && line - anchor < 400);
  assert.ok(code.includes("profile.model=${savedModels.profileModel"));
  assert.ok(!code.includes("profile.model=${anchorModel}"));
});

test("wiring: ANTHROPIC_TIERS is never an assignment target and the loader never uses readJsonOr", () => {
  for (const src of [code, strip(MOD)]) {
    assert.ok(!/ANTHROPIC_TIERS(\.\w+)?\s*=[^=>]/.test(src));
  }
  assert.ok(!strip(MOD).includes("readJsonOr"));
});

// ======================================================= security-review fixes
// ---- M3: the repo sanitiser on the id, hostile ids, length cap
test("M3: real picker-row shapes pass admitId on the whole id and on both parts, and validateShape", () => {
  for (const id of ["teamorouter/kimi-k3[1M]", "openrouter/~z-ai/glm-latest", SONNET55]) {
    const slash = id.indexOf("/");
    for (const part of [id, id.slice(0, slash), id.slice(slash + 1)]) assert.notEqual(admitId(part), null, `${part} of ${id}`);
    assert.equal(validateShape(id), id);
  }
});

test("M3: hostile ids (C1, zero-width, RLO, unpaired surrogate, over-length, traversal, flag-like) are all refused", () => {
  const hostile = {
    c1: "a/b\u0085c", zeroWidth: "a/b\u200Bc", rlo: "a/b\u202Ec", lowSurrogate: "a/b\uDC00c", highSurrogate: "a/b\uD83D",
    longer: "a/" + "b".repeat(127), traversal: "a/../b", leadingDash: "-a/b", leadingSlashModel: "a//b",
    bom: "a/b\uFEFFc", lineSep: "a/b\u2028c", esc: "a/b\u001b[2Jc"
  };
  for (const [name, id] of Object.entries(hostile)) {
    assert.throws(() => validateShape(id), (e) => e instanceof DefaultModelError &&
      !/[\u0000-\u001f\u0085\u200B\u202E\uDC00\uD83D]/.test(e.message), name);
  }
  assert.equal(validateShape("a/" + "b".repeat(126)), "a/" + "b".repeat(126), "128 code points is the cap");
  assert.equal([..."a/" + "b".repeat(127)].length, 129);
  assert.equal(validateShape("a/\u{1F600}x"), "a/\u{1F600}x", "a well-formed astral pair is not a lone surrogate");
});

test("M3: the same hostile ids in the FILE are refused by load with the file named", () => {
  const d = tmp();
  for (const [name, id] of Object.entries({ c1: "a/b\u0085c", rlo: "a/b\u202Ec", zw: "a/b\u200Bc" })) {
    const f = write(d, `${name}.json`, JSON.stringify({ model: id }));
    assert.throws(() => load(f), (e) => e instanceof DefaultModelError && e.message.includes(f), name);
  }
  const f = write(d, "long.json", JSON.stringify({ model: "a/" + "b".repeat(127) }));
  assert.throws(() => load(f), DefaultModelError);
});

test("M3: __proto__ key cannot supply or pollute; duplicate keys are last-wins; BOM + CRLF accepted", () => {
  const d = tmp();
  const only = write(d, "p1.json", '{"__proto__":{"model":"evil/x"}}');
  assert.throws(() => load(only), DefaultModelError, "an inherited-looking model is not a model");
  const both = write(d, "p2.json", '{"__proto__":{"polluted":true},"model":"a/b"}');
  assert.deepEqual(load(both), { model: "a/b" });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const dup = write(d, "dup.json", '{"model":"a/first","model":"a/second"}');
  assert.equal(load(dup).model, "a/second");
  const bomCrlf = write(d, "bom.json", "\uFEFF{\r\n\"model\": \"a/b\"\r\n}\r\n");
  assert.equal(load(bomCrlf).model, "a/b");
});

// ---- L2: size cap and non-regular files
test("L2: the read is capped at 4 KB and a non-regular file is a loud error", () => {
  const d = tmp();
  const pad = (n) => JSON.stringify({ model: "a/b" }) + " ".repeat(n);
  const ok = write(d, "ok.json", pad(MAX_FILE_BYTES - JSON.stringify({ model: "a/b" }).length));
  assert.equal(fs.statSync(ok).size, MAX_FILE_BYTES);
  assert.equal(load(ok).model, "a/b");
  const big = write(d, "big.json", pad(MAX_FILE_BYTES - JSON.stringify({ model: "a/b" }).length + 1));
  assert.throws(() => load(big), (e) => e instanceof DefaultModelError && /bytes/.test(e.message) && e.message.includes(big));
  assert.throws(() => load(d), (e) => e instanceof DefaultModelError && /not a regular file/.test(e.message));
  assert.match(strip(MOD), /statSync\(file\)/);
});

// ---- M1(a): env override ignored on a live run
test("M1a: a live run ignores UW_DEFAULT_MODEL_FILE unless --default-model-file is given", () => {
  const env = { UW_DEFAULT_MODEL_FILE: "/tmp/elsewhere.json" };
  const live = resolveDefaultModelFile({ target: "live", args: [], env });
  assert.equal(live.file, DEFAULT_MODEL_FILE);
  assert.equal(live.ignoredEnv, true);
  assert.equal(resolveDefaultModelFile({ target: "live", args: [], env: {} }).ignoredEnv, false);
  const iso = resolveDefaultModelFile({ target: "isolated", args: [], env });
  assert.deepEqual([iso.file, iso.ignoredEnv], ["/tmp/elsewhere.json", false]);
  assert.equal(resolveDefaultModelFile({ target: "dry", args: [], env }).file, "/tmp/elsewhere.json");
  assert.equal(resolveDefaultModelFile({ target: "dry", args: [], env: {} }).file, DEFAULT_MODEL_FILE);
  const flagged = resolveDefaultModelFile({ target: "live", args: ["--target", "live", "--default-model-file", "x.json"], env });
  assert.equal(flagged.file, path.resolve("x.json"));
  assert.equal(flagged.ignoredEnv, false);
  for (const bad of [["--default-model-file"], ["--default-model-file", "--dry"]]) {
    assert.throws(() => resolveDefaultModelFile({ target: "live", args: bad, env }), DefaultModelError);
  }
});

test("M1a: run.mjs uses the resolver (never the ambient env), warns loudly, and prints the source path", () => {
  assert.ok(code.includes("resolveDefaultModelFile({ target, args })"));
  assert.ok(!/\bdefaultModelFile\(/.test(code), "run.mjs must not read the env override directly");
  assert.ok(code.includes("UW_DEFAULT_MODEL_FILE is set and IGNORED for a live run"));
  assert.ok(code.includes("(source: ${dmf.file})"));
  assert.ok(at("resolveDefaultModelFile({ target, args })") < at("loadDefaultModel(dmf.file)"));
});

// ---- M1(b): the 'none' line prints the path; MINOR 1
test("M1b: 'none' names the resolved path (run.mjs and show)", () => {
  assert.ok(code.includes("default model: none (${dmf.file} absent; profile anchor decides)"));
  assert.ok(!code.includes("no default-model.json)"));
  const d = tmp();
  const f = path.join(d, "absent.json");
  assert.equal(formatShow({ file: f, def: null }), `default model: none (${f} absent; the profile anchor decides)`);
});

test("MINOR 1: --no-profile + a failed resolve prints 'not applied', never the 'none' line", () => {
  const catchAt = at("defFailed = true;");
  const failedLine = at("default model: not applied (see warning above)");
  const noneLine = at("default model: none (${dmf.file} absent");
  assert.ok(catchAt < failedLine && failedLine < noneLine);
  assert.ok(code.slice(failedLine - 40, failedLine).includes("else if (defFailed)"));
  const catchBody = code.slice(at("} catch (e) {", at("assertNoOrphanMarker(loaded")), catchAt);
  assert.ok(catchBody.includes('!has("--no-profile")') && catchBody.includes("process.exit(1)"));
  assert.ok(catchBody.indexOf("console.warn(") > catchBody.indexOf("process.exit(1)"));
});

// ---- M1(c): last-applied marker
test("M1c: marker present + file absent refuses with actionable text; every other combination passes", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  assert.notEqual(markerFor(f), DEFAULT_MODEL_MARKER, "a non-default file never maps to the real marker");
  assert.equal(markerFor(DEFAULT_MODEL_FILE), DEFAULT_MODEL_MARKER);
  assert.equal(path.basename(DEFAULT_MODEL_MARKER), "default-model.applied.json");
  assert.equal(path.basename(path.dirname(DEFAULT_MODEL_MARKER)), "state");
  assert.doesNotThrow(() => assertNoOrphanMarker(null, f), "no file, no marker: unset");
  const m = writeMarker({ file: f, model: SONNET55, now: () => new Date("2026-10-01T12:00:00Z") });
  assert.equal(m, markerFor(f));
  assert.deepEqual(JSON.parse(fs.readFileSync(m, "utf8")), { model: SONNET55, appliedAt: "2026-10-01T12:00:00.000Z" });
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes(".tmp-")), []);
  assert.ok(markerPresent(f));
  assert.throws(() => assertNoOrphanMarker(null, f), (e) => e instanceof DefaultModelError &&
    e.message.includes(f) && e.message.includes("default-model set") && e.message.includes("default-model clear") &&
    e.message.includes("Nothing was written"));
  assert.doesNotThrow(() => assertNoOrphanMarker({ model: SONNET55 }, f), "file present: fine");
});

test("M1c: the refusal sits with the other default-model refusals, before any write, and --no-profile is exempt", () => {
  const orphan = at("assertNoOrphanMarker(loaded, dmf.file)");
  assert.ok(orphan < at("resolveDefault(loaded,"));
  assert.ok(orphan < at(DRY_EXIT));
  for (const later of ["acquireLock()", "fs.copyFileSync(SETTINGS, backup)", "snapshotConfigDb(liveConfigDb()", 'await rpc("saveConfig"']) {
    assert.ok(orphan < at(later), later);
  }
  const line = code.slice(code.lastIndexOf("\n", orphan), code.indexOf("\n", orphan));
  assert.ok(line.includes('!has("--no-profile")') && line.includes('target === "live"'));
});

test("M1c: the marker is written only after the final assertion, on the verified live path, once", () => {
  assert.equal(code.split("writeMarker(").length - 1, 1);
  const w = at("writeMarker({ file: dmf.file");
  assert.ok(w > at("assertDefaultModel(final, def)"));
  assert.ok(w > at("writeVerified = true;"));
  assert.ok(w > at("} catch (err) {", at('await rpc("saveConfig"')), "outside the rollback try");
  const guard = code.slice(code.lastIndexOf("if (writeVerified) {", w), w);
  assert.ok(guard.startsWith("if (writeVerified) {"));
  assert.ok(guard.includes('target === "live" && def'));
  assert.ok(!code.slice(0, at("writeVerified = true;")).includes("writeMarker("), "never before success");
});

test("M1c: clear removes both the file and the marker; idempotent; --no-profile path untouched", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  setDefaultModel({ id: SONNET55, file: f, idsFile: path.join(d, "x.json") });
  writeMarker({ file: f, model: SONNET55 });
  const r = clearDefaultModel({ file: f });
  assert.deepEqual([r.existed, r.markerRemoved], [true, true]);
  assert.ok(!fs.existsSync(f) && !fs.existsSync(markerFor(f)));
  assert.doesNotThrow(() => assertNoOrphanMarker(load(f), f), "after clear a live run falls back to the anchor");
  const again = clearDefaultModel({ file: f });
  assert.deepEqual([again.existed, again.markerRemoved], [false, false]);
  writeMarker({ file: f, model: SONNET55 });
  assert.equal(clearDefaultModel({ file: f }).markerRemoved, true, "an orphan marker alone is cleaned too");
  assert.match(fs.readFileSync(new URL("../keysync/key.mjs", import.meta.url), "utf8"), /last-applied marker/);
});

test("M1c: show warns when only the marker survives", () => {
  const d = tmp();
  const f = path.join(d, "dm.json");
  writeMarker({ file: f, model: SONNET55 });
  const text = formatShow({ file: f, def: null });
  assert.match(text, /WARNING/);
  assert.ok(text.includes("default-model set") && text.includes("default-model clear"));
});

// ---- M2: post-commit failure message
test("M2: the post-commit notice names the committed DB, the later-apply risk, the snapshot and restore command", () => {
  const hint = 'copy "C:\\snap\\config.sqlite.dpapi" over config.sqlite';
  const n = postCommitNotice({ snapshot: "C:\\snap\\config.sqlite.dpapi", restoreHint: hint, settingsRestored: true });
  for (const needle of ["ALREADY committed", "profile.model", "Providers", "Only settings.json was restored",
    "gateway start, saveApiKeys, profile launch", "rewrite settings.json", "C:\\snap\\config.sqlite.dpapi", hint]) {
    assert.ok(n.includes(needle), `missing ${needle} in:\n${n}`);
  }
  assert.match(postCommitNotice({ snapshot: "s", restoreHint: "h", settingsRestored: false }), /settings\.json was NOT restored either/);
  assert.match(postCommitNotice({ snapshot: null, restoreHint: null, settingsRestored: true }), /No CCR config snapshot/);
});

test("M2: run.mjs prints the notice FIRST in the catch, only when a default was set", () => {
  const save = at('await rpc("saveConfig"');
  const catchAt = at("} catch (err) {", save);
  const notice = at("postCommitNotice({", catchAt);
  assert.ok(catchAt < notice && notice < at("WRITE FAILED:", catchAt));
  assert.ok(notice > at("restoreSettings(backup, SETTINGS)", catchAt));
  assert.ok(code.slice(notice - 60, notice).includes("if (def)"));
  assert.ok(code.slice(notice, at("WRITE FAILED:", catchAt)).includes("restoreConfigDbHint(dbSnapshot)"));
});

// ---- L1, L6, L7
test("L1: show output passes setAt and note through sanitizeDisplay", () => {
  const esc = String.fromCharCode(27);
  const text = formatShow({ file: "/x/dm.json", def: { model: SONNET55, setAt: `2026${esc}[2J-10\u202E`, note: `hi${esc}]52;c;AAAA\u0007\u200Bthere` } });
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200B-\u200F\u202A-\u202E]/.test(text.replace("\n", "")), JSON.stringify(text));
  assert.ok(text.includes("note: "));
  assert.ok(!text.includes(esc));
});

test("L3: set and clear on a directory are DefaultModelErrors with actionable text, never a stack", () => {
  const d = tmp();
  const dir = path.join(d, "dm.json");
  fs.mkdirSync(dir);
  assert.throws(() => setDefaultModel({ id: SONNET55, file: dir, idsFile: path.join(d, "x.json") }),
    (e) => e instanceof DefaultModelError && /directory/.test(e.message) && e.message.includes(dir));
  assert.throws(() => clearDefaultModel({ file: dir }),
    (e) => e instanceof DefaultModelError && /directory/.test(e.message) && /Remove it by hand/.test(e.message));
  assert.ok(fs.statSync(dir).isDirectory(), "clear did not touch it");
  const f = path.join(d, "blocked", "dm.json");
  fs.writeFileSync(path.join(d, "blocked"), "a file where a directory should be");
  assert.throws(() => setDefaultModel({ id: SONNET55, file: f, idsFile: path.join(d, "x.json") }), DefaultModelError);
  const key = new URL("../keysync/key.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const action of [["set", SONNET55, "--force"], ["clear"]]) {
    const r = spawnSync(process.execPath, [key, "default-model", ...action],
      { encoding: "utf8", env: { ...process.env, UW_DEFAULT_MODEL_FILE: dir } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.ok(!/\n\s+at /.test(r.stderr), `no stack trace: ${r.stderr}`);
    assert.ok(r.stderr.includes("directory"));
  }
});

test("L6: the copy-pasteable set hint is JSON-quoted and sanitised", () => {
  const d = tmp();
  const esc = String.fromCharCode(27);
  const f = write(d, "s.json", JSON.stringify({ env: { ANTHROPIC_MODEL: `evil"; calc${esc}[2J\u202E/x` } }));
  const w = envModelChangeWarning(f, "anthropic/claude-opus-5");
  assert.ok(!w.includes(esc) && !w.includes("\u202E"));
  const hint = w.slice(w.indexOf("default-model set ") + "default-model set ".length, w.indexOf(" and re-run"));
  assert.doesNotThrow(() => JSON.parse(hint), hint);
  assert.ok(hint.startsWith('"') && hint.endsWith('"'));
});

test("L7: set on a non-anthropic id says it is shape-checked only and verified at the next run", () => {
  const d = tmp();
  const r = setDefaultModel({ id: "teamorouter/kimi-k3[1M]", file: path.join(d, "dm.json"), idsFile: path.join(d, "x.json") });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /shape-checked only/);
  assert.match(r.warnings[0], /refuses a profile run if the row is absent/);
});

// ---- code review MINOR 4 (pin note), source pins only (run.mjs cannot be executed here)
test("MINOR 4: the pin note compares envFormOf-normalised forms when a default is set", () => {
  assert.ok(code.includes("envFormOf(pin.pinned)") && code.includes("envFormOf(def.model)"));
  assert.equal(envFormOf("teamorouter/kimi-k3[1M]").toLowerCase(), envFormOf("teamorouter/kimi-k3").toLowerCase());
  assert.equal(envFormOf("anthropic/claude-sonnet-5-5[1m]"), "anthropic/claude-sonnet-5-5[1m]");
});

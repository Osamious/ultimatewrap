// The owner's fixed default model: the model every NEW Claude Code session starts
// on, held in ~/.llmkeys/default-model.json and never decided by keysync.
//
// Why a data file and not a constant (the key-choices.json precedent in
// keysync.mjs): changing it must not be a source edit. Why it needs more than a
// settings.json hand edit: CCR clears and re-derives env.ANTHROPIC_MODEL /
// CCR_CLAUDE_CODE_MODEL / CODEXL_CLAUDE_CODE_MODEL from `profile.model` on EVERY
// apply (research copy: packages/core/src/profiles/service.ts applyClaudeCodeProfile
// and agents/claude-code/environment.ts), so the durable lever is the profile's
// model (the input) plus an assertion on the env (the output). See
// plans/default-model-fix-plan.md.
//
// DELIBERATELY NOT readJsonOr: that returns its fallback on ANY error, so a typo in
// this file would silently become "unset" and the anchor would override the
// owner's choice -- the exact failure this feature exists to prevent. Only an
// absent file means unset; a corrupt one is a loud error.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic } from "../menu/atomic.mjs";
import { admitId, classifyRefusal, sanitizeDisplay } from "../menu/sanitize.mjs";
import { CACHE_FILE as ANTHROPIC_IDS_CACHE } from "./anthropic-catalog.mjs";

export class DefaultModelError extends Error {
  constructor(message) { super(message); this.name = "DefaultModelError"; }
}

/** The three env vars CCR derives from `profile.model` (one value, three names). */
export const DEFAULT_MODEL_ENV_KEYS = ["ANTHROPIC_MODEL", "CCR_CLAUDE_CODE_MODEL", "CODEXL_CLAUDE_CODE_MODEL"];

export const DEFAULT_MODEL_FILE = path.join(os.homedir(), ".llmkeys", "default-model.json");
/** Read at call time so a test (or a one-off dry run) can point it at a temp file. */
export const defaultModelFile = () => process.env.UW_DEFAULT_MODEL_FILE || DEFAULT_MODEL_FILE;

/** A default file bigger than this is not a default file ({"model":"..."} is under 200 bytes). */
export const MAX_FILE_BYTES = 4096;
/** Same cap as menu/sanitize.mjs MAX_CODE_POINTS (the id lands in settings.json). */
const MAX_ID_CODE_POINTS = 128;

/**
 * Which file a run reads. A LIVE run ignores UW_DEFAULT_MODEL_FILE unless
 * `--default-model-file <path>` is on the command line: an ambient env var must not
 * be able to point the real profile at a different (or absent) file, because an
 * absent file reads as "unset" and the anchor then overrides the owner's choice.
 * --dry and --target isolated may honour the env var (tests do).
 */
export function resolveDefaultModelFile({ target, args = [], env = process.env }) {
  const i = args.indexOf("--default-model-file");
  if (i >= 0) {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) throw new DefaultModelError("--default-model-file needs a path");
    return { file: path.resolve(v), source: "--default-model-file", ignoredEnv: false };
  }
  const e = env.UW_DEFAULT_MODEL_FILE;
  if (target === "live") return { file: DEFAULT_MODEL_FILE, source: "default location", ignoredEnv: Boolean(e) };
  return e ? { file: e, source: "UW_DEFAULT_MODEL_FILE", ignoredEnv: false }
    : { file: DEFAULT_MODEL_FILE, source: "default location", ignoredEnv: false };
}

/**
 * The last-applied marker: written after a successful LIVE profile-writing apply
 * that had a default. File absent + marker present = the file vanished (or an env
 * override pointed elsewhere) after a default was live, so a run refuses instead of
 * silently reverting to the anchor. The real file's marker lives in state/ (local,
 * gitignored); any other file's marker sits beside it, so a test or a
 * --default-model-file run can never touch the real one.
 */
export const DEFAULT_MODEL_MARKER = path.join(path.dirname(ANTHROPIC_IDS_CACHE), "default-model.applied.json");
const sameFile = (a, b) => (process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
export const markerFor = (file) => (sameFile(file, DEFAULT_MODEL_FILE) ? DEFAULT_MODEL_MARKER : `${file}.applied.json`);

/** Fail-closed: anything but a definite ENOENT counts as present. */
export function markerPresent(file) {
  try { fs.statSync(markerFor(file)); return true; } catch (e) { return e?.code !== "ENOENT"; }
}

export function writeMarker({ file, model, now = () => new Date() }) {
  const m = markerFor(file);
  fs.mkdirSync(path.dirname(m), { recursive: true });
  writeAtomic(m, JSON.stringify({ model, appliedAt: now().toISOString() }, null, 2) + "\n");
  return m;
}

/** Throws when the default file is absent (loaded === null) but the marker says one was applied. */
export function assertNoOrphanMarker(loaded, file) {
  if (loaded !== null || !markerPresent(file)) return;
  throw new DefaultModelError(
    `default model file ${file} is ABSENT but ${markerFor(file)} records that a default model was applied by a ` +
    `previous live run; applying now would silently revert new sessions to the profile anchor. Nothing was written. ` +
    `Restore the file: node keysync/key.mjs default-model set <id>   or deliberately return to the anchor: ` +
    `node keysync/key.mjs default-model clear   (clear removes the file and the marker). ` +
    `Or run with --no-profile (gateway-only; writes no profile and no settings.json).`);
}

/** Printed FIRST when a post-saveConfig step fails on a run that carried a default. */
export function postCommitNotice({ snapshot, restoreHint, settingsRestored }) {
  return [
    "IMPORTANT (default model): CCR's config DB has ALREADY committed the new profile.model and Providers; " +
      "that commit was NOT rolled back.",
    settingsRestored
      ? "Only settings.json was restored."
      : "settings.json was NOT restored either (see the messages below).",
    "A later CCR-initiated apply (gateway start, saveApiKeys, profile launch) will rewrite settings.json from the " +
      "DB's profile.model, so env.ANTHROPIC_MODEL can change without any keysync run.",
    snapshot
      ? `Restore point (config DB as it was before this run): ${snapshot}\n  Restore command: ${restoreHint}`
      : "No CCR config snapshot exists for this target; there is nothing to restore the DB from.",
    "Or fix the cause and re-run keysync: it re-commits the profile and re-asserts the default."
  ].join("\n  ");
}

export const SET_NOTE =
  "takes effect at the next live keysync run; until then any CCR re-apply (gateway start, saveApiKeys, " +
  "profile launch) can revert the settings env to the previous anchor -- set the file and apply in one sitting";
export const CLEAR_NOTE =
  "cleared: the anchor behaviour returns (the profile model follows the tier constants) at the next live " +
  "keysync run; a re-apply is needed for settings.json to change";

/**
 * Shape check, DENY-list on purpose: an allow-list rejects real picker rows
 * (`[1M]` uppercase, `~` inside ids). What must never reach an env value or a
 * JSON string is whitespace/control characters, a quote, a comma or a backslash.
 * The row's existence is checked separately, against the built picker.
 */
export function validateShape(id) {
  if (typeof id !== "string" || id === "") throw new DefaultModelError("default model id must be a non-empty string");
  const shown = JSON.stringify(sanitizeDisplay(id, 140));
  if ([...id].length > MAX_ID_CODE_POINTS) throw new DefaultModelError(`default model id ${shown} is longer than ${MAX_ID_CODE_POINTS} characters`);
  // admitId deliberately lets an unpaired surrogate through (menu/sanitize.mjs, KNOWN LIMIT).
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id)) {
    throw new DefaultModelError(`default model id ${shown} contains an unpaired surrogate`);
  }
  if (/[\s\u0000-\u001f\u007f]/.test(id)) throw new DefaultModelError(`default model id ${shown} contains whitespace or a control character`);
  if (/["\\,]/.test(id)) throw new DefaultModelError(`default model id ${shown} contains a forbidden character (quote, comma or backslash)`);
  const slash = id.indexOf("/");
  if (slash < 1 || slash === id.length - 1) {
    throw new DefaultModelError(`default model id ${shown} is not <provider>/<model>`);
  }
  // The repo sanitiser, on the whole id and on each part, as picker rows are admitted.
  for (const part of [id, id.slice(0, slash), id.slice(slash + 1)]) {
    if (admitId(part) === null) {
      throw new DefaultModelError(`default model id ${shown} is refused by the id sanitiser (${classifyRefusal(part)})`);
    }
  }
  return id;
}

/**
 * The value as it must stand in settings.json AFTER stripOneMSuffix: `anthropic/*`
 * keeps `[1m]` (Claude Code knows those ids), anything else loses a trailing
 * `[1m]`/`[1M]`. Mirrors stripOneMSuffix in keysync.mjs so the post-write
 * assertion cannot disagree with the strip that runs before it.
 */
export function envFormOf(id) {
  return /^anthropic\//i.test(id) ? id : id.replace(/\[1m\]$/i, "");
}

/** `null` ONLY when the file does not exist. Anything else wrong throws. */
export function load(file = defaultModelFile()) {
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) throw new DefaultModelError(`default model file ${file} is not a regular file; remove it by hand`);
    if (st.size > MAX_FILE_BYTES) throw new DefaultModelError(`default model file ${file} is ${st.size} bytes (limit ${MAX_FILE_BYTES}); it is not a default model file`);
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof DefaultModelError) throw e;
    if (e?.code === "ENOENT") return null;
    throw new DefaultModelError(`cannot read default model file ${file}: ${e.message}`);
  }
  let obj;
  try {
    obj = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (e) {
    throw new DefaultModelError(`default model file ${file} is not valid JSON (${e.message}); ` +
      `fix it or run: node keysync/key.mjs default-model clear`);
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new DefaultModelError(`default model file ${file} must be a JSON object like {"model":"<provider>/<id>"}`);
  }
  try { validateShape(obj.model); }
  catch (e) { throw new DefaultModelError(`default model file ${file}: ${e.message}`); }
  return { model: obj.model, ...(obj.setAt ? { setAt: obj.setAt } : {}), ...(obj.note ? { note: obj.note } : {}) };
}

/**
 * The default must be an EXACT row of the post-relay built picker (it is written
 * verbatim into env, so case and `[1m]` matter). null def = unset = no override.
 * Relay down / row pruned / typo all land here and are loud, never a fallback.
 */
export function resolveDefault(def, builtPicker, { anthropicOn = true, file = defaultModelFile() } = {}) {
  if (!def) return null;
  const rows = (builtPicker ?? []).map((r) => r.model);
  if (rows.includes(def.model)) return { model: def.model, via: "default-file" };
  const norm = (s) => s.toLowerCase().replace(/\[1m\]$/, "");
  const near = rows.filter((m) => norm(m) === norm(def.model)).slice(0, 3);
  const cause = /^anthropic\//i.test(def.model) && !anthropicOn
    ? "the Anthropic relay is down (or --no-anthropic was given), so no anthropic/* rows were built"
    : "typo, or the row was pruned from the catalogue";
  throw new DefaultModelError(
    `default model "${def.model}" (from ${file}) is not a row in the built picker: ${cause}.` +
    (near.length ? ` Near-miss row(s): ${near.join(", ")}.` : "") +
    ` Nothing was written; previous values are kept. Remedies: bring the relay up / fix the id with ` +
    `\`node keysync/key.mjs default-model set <id>\`, or \`default-model clear\`, or run with --no-profile ` +
    `(gateway-only run, writes no profile and no settings.json).`);
}

/** New tiers object (never mutates ANTHROPIC_TIERS): only `model` is overridden. */
export function withDefaultModel(tiers, def) {
  return def ? { ...tiers, model: def.model } : tiers;
}

/** Sets the three env vars to the default (pre-strip). Returns how many changed. */
export function applyDefaultModel(settings, def) {
  if (!def) return 0;
  settings.env = settings.env && typeof settings.env === "object" ? settings.env : {};
  let changed = 0;
  for (const k of DEFAULT_MODEL_ENV_KEYS) {
    if (settings.env[k] !== def.model) { settings.env[k] = def.model; changed += 1; }
  }
  return changed;
}

/** Final-state check (post strip). Throws naming the variable. */
export function assertDefaultModel(settings, def) {
  if (!def) return;
  const want = envFormOf(def.model);
  for (const k of DEFAULT_MODEL_ENV_KEYS) {
    const got = settings.env?.[k];
    if (got !== want) {
      throw new DefaultModelError(`post-write check: env.${k} is ${JSON.stringify(got)} but the default model is ${JSON.stringify(want)}`);
    }
  }
}

/** The claude-code profile entry in a config, chosen the way run.mjs chooses `p`. */
function claudeCodeProfile(cfg, id) {
  const list = cfg?.profile?.profiles ?? [];
  return (id !== undefined && list.find((x) => x.id === id && x.agent === "claude-code"))
    || list.find((x) => x.agent === "claude-code" && x.enabled !== false)
    || list.find((x) => x.agent === "claude-code");
}

/** What CCR actually persisted (the saveConfig return), or undefined where absent. */
export function savedProfileModels(saved, profileId) {
  return {
    profileModel: claudeCodeProfile(saved, profileId)?.model,
    claudeCodeModel: saved?.profile?.claudeCode?.model
  };
}

/**
 * The persisted INPUT check: CCR re-derives the three env vars from these, so if
 * they are not the default a later CCR-initiated apply reverts it. Throws so the
 * existing catch in run.mjs restores settings.
 */
export function assertSavedProfile(saved, profileId, def) {
  if (!def) return;
  const got = savedProfileModels(saved, profileId);
  for (const [name, v] of [["profile.profiles[].model", got.profileModel], ["profile.claudeCode.model", got.claudeCodeModel]]) {
    if (v !== def.model) {
      throw new DefaultModelError(`saveConfig persisted ${name}=${JSON.stringify(v)} but the default model is ` +
        `${JSON.stringify(def.model)}; a later CCR apply would revert the settings env`);
    }
  }
}

/**
 * def === null on a live profile-writing run: tell the owner, loudly, if this run
 * is about to change env.ANTHROPIC_MODEL (e.g. a hand edit that is about to be
 * reverted). READ-ONLY and never throws; returns the warning text or null.
 */
export function envModelChangeWarning(settingsFile, expectedModel) {
  let current;
  try {
    current = JSON.parse(fs.readFileSync(settingsFile, "utf8").replace(/^\uFEFF/, ""))?.env?.ANTHROPIC_MODEL;
  } catch { return null; }
  if (typeof current !== "string") return null;
  const norm = (s) => s.toLowerCase().replace(/\[1m\]$/, "");
  if (norm(current) === norm(expectedModel)) return null;
  // settings.json is hand-editable: show and quote the value only after sanitising it.
  const cur = sanitizeDisplay(current, 160);
  return `WARNING: no default model is set, so this run will change env.ANTHROPIC_MODEL from ` +
    `${cur} to ${expectedModel} (the profile anchor). To keep ${cur} run: ` +
    `node keysync/key.mjs default-model set ${JSON.stringify(cur)} and re-run.`;
}

// ------------------------------------------------------------------ CLI backing
// key.mjs runs its switch at import and cannot be imported by a test, so the
// logic lives here and key.mjs only prints.

/** ADVISORY only: an anthropic/ id whose bare form is not in the live-id cache. */
function anthropicAdvisory(id, idsFile) {
  if (!/^anthropic\//i.test(id)) return null;
  const bare = id.replace(/^anthropic\//i, "").replace(/\[1m\]$/i, "");
  let ids;
  try { ids = JSON.parse(fs.readFileSync(idsFile, "utf8").replace(/^\uFEFF/, ""))?.ids; } catch { ids = null; }
  if (!Array.isArray(ids)) return `could not read the Anthropic id cache (${idsFile}); "${bare}" is unchecked`;
  return ids.includes(bare) ? null : `"${bare}" is not in the Anthropic id cache (${idsFile}); the id may be new or mistyped. ` +
    `keysync verifies the row against the live picker at run time and refuses a profile run if it is absent`;
}

/** Shape validation + advisory only. Never consults the pre-relay row snapshot. */
export function setDefaultModel({ id, file = defaultModelFile(), idsFile = ANTHROPIC_IDS_CACHE, now = () => new Date(), force = false }) {
  validateShape(id);
  const warnings = [];
  if (!force) { const w = anthropicAdvisory(id, idsFile); if (w) warnings.push(w); }
  if (!/^anthropic\//i.test(id)) {
    warnings.push(`"${sanitizeDisplay(id)}" is shape-checked only; keysync verifies it against the live picker rows ` +
      `at the next run and refuses a profile run if the row is absent`);
  }
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      throw new DefaultModelError(`${file} is a directory, not a file; remove it by hand, then run set again`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify({ model: id, setAt: now().toISOString() }, null, 2) + "\n");
  } catch (e) {
    throw e instanceof DefaultModelError ? e : fsFailure("write default model file", file, e);
  }
  return { file, model: id, warnings };
}

/** An fs failure becomes a DefaultModelError with an actionable text, never a stack trace. */
function fsFailure(verb, target, e) {
  const why = ["EISDIR", "EPERM", "EBUSY", "EACCES"].includes(e?.code)
    ? "it may be a directory, read-only, or held open by another program (editor, antivirus): close it and retry"
    : "check the path and permissions and retry";
  return new DefaultModelError(`cannot ${verb} ${target}: ${e?.code ?? "error"} ${e?.message ?? e}; ${why}`);
}

/** Removes the file AND the last-applied marker (a deliberate return to the anchor). */
export function clearDefaultModel({ file = defaultModelFile() } = {}) {
  const marker = markerFor(file);
  let existed = false;
  let markerRemoved = false;
  try {
    // Marker first: if the file removal then fails, the file stays and no marker is left to cause a refusal.
    for (const f of [marker, file]) {
      let st = null;
      try { st = fs.lstatSync(f); } catch (e) { if (e?.code !== "ENOENT") throw e; }
      if (!st) continue;
      if (st.isDirectory()) {
        throw new DefaultModelError(`${f} is a directory, not a file; clear did not touch it. Remove it by hand (rmdir), then run clear again`);
      }
      fs.rmSync(f);
      if (f === file) existed = true; else markerRemoved = true;
    }
  } catch (e) {
    throw e instanceof DefaultModelError ? e : fsFailure("remove", file, e);
  }
  return { file, existed, marker, markerRemoved };
}

export function showDefaultModel({ file = defaultModelFile() } = {}) {
  const def = load(file);
  return { file, def };
}

/** The `show` text. Every file-derived string passes through sanitizeDisplay. */
export function formatShow({ file, def }) {
  const f = sanitizeDisplay(file, 260);
  if (!def) {
    const orphan = markerPresent(file)
      ? `\nWARNING: ${sanitizeDisplay(markerFor(file), 260)} exists: a default was applied by a live run and the file is now absent. ` +
        "A live run will refuse until you run: node keysync/key.mjs default-model set <id>  or  default-model clear"
      : "";
    return `default model: none (${f} absent; the profile anchor decides)${orphan}`;
  }
  const at = def.setAt ? `, set ${sanitizeDisplay(def.setAt, 40)}` : "";
  const note = def.note ? `\n  note: ${sanitizeDisplay(def.note, 200)}` : "";
  return `default model: ${def.model} (${f}${at})${note}`;
}

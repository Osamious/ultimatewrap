// The I/O SHELL around the pure funnel (`menu/subagent-funnel.mjs`) for the subagent model policy (plan sections 4, 5, 7).
// It reads the snapshot, bench, observed overlay, registry (through the existing `filterRegistry` and `chooseKeys`),
// live Providers, settings and the tool-fidelity file; calls `funnel`; adds what is not a count (injection text,
// contentHash, owner file load/validate/save, the compiled file, report and `explain` text); and runs the
// `subagent-policy` CLI commands. `keysync/key.mjs` only parses nothing and prints nothing for it: it hands argv here.
//
// R1: this module never writes CCR config and never starts keysync. Its only gateway contact is the read-only
// config fetch in `fetchProvidersLive`, used only when no `--providers-file` is given.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { writeAtomic } from "../menu/atomic.mjs";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { loadBench, BENCH_FILE, BENCH_OUTDATED_DAYS } from "../menu/bench-data.mjs";
import { classifyTight } from "../refresh/bench.mjs";
import { capBand, sizeCell } from "../menu/payload-cap.mjs";
import { load as loadDefaultModel, DEFAULT_MODEL_FILE } from "./default-model.mjs";
import { filterRegistry, chooseKeys } from "./keysync.mjs";
import { CONTRACT as CC } from "../menu/cc-contract.mjs";
import { CONTRACT as CCR, rpc, requestLogsDb, dataDir } from "../menu/ccr-client.mjs";
import { funnel, emptyStage, FREE_TAG, SCOPE_NAMES, FREE_SCOPES, DEFAULT_MIN_SET, SUBSTITUTE_FLOOR, SUBSTITUTE_K, PREMIUM_RULE,
  providerOf, stripOneM, CTX_VALUES, CTX_FLOORS, ctxSpec, ctxLabel, ctxClassOf, TTFT_BUCKETS, knownIssueText, payloadSampleText } from "../menu/subagent-funnel.mjs";
import { POOL_ALIAS_RE } from "../menu/pool-rule.mjs";
import { isExcludedTier, freeScopeOf, RELAY_TIER } from "../menu/tiers.mjs";
import { CLI, CODES, codeRow, KINDS } from "../menu/subagent-codes.mjs";
import { verdict, verdictLine, savedLine, fixLine, deltaText, ownerDiffers, corruptVerdict } from "../menu/subagent-verdict.mjs";
import { runWizard, ttyAsker, PRESETS, presetListText, flagsText } from "./subagent-wizard.mjs";
export { PRESETS };

export const COMPILER_VERSION = 2;                  // 2: revision 11 policy-side fix round (ctx floors, inferred ctx, rank order); the stamp is outside the hash, so `rebuild --if-stale` recompiles an older file and the router (minRouter 2) reads both
/** The oldest router that can read a file this compiler writes (router v2: `lists.prov`, `row.b`, a null `lists.all`, a verified `contentHash`, the `rollout` block). It sits OUTSIDE the hash. */
export const MIN_ROUTER = 2;
const LLMKEYS = path.join(os.homedir(), ".llmkeys");
export const OWNER_FILE = path.join(LLMKEYS, "subagent-policy.json");
export const STATE_ROOT = path.join(os.homedir(), ".uw", "state");
export const STATE_DIR = path.join(STATE_ROOT, "subagent");
export const OWNER_MAX_BYTES = 4096;
export const COMPILED_MAX_BYTES = 1024 * 1024;
export const ALLOW_MAX = 24, ALLOW_PIN_MAX = 100;                  // keeps a saved owner file under OWNER_MAX_BYTES: it must always load again
/** The owner's one-use approval of a self-test plan (harness/g1-* is gitignored); a fixture run keeps its own under the fixture state folder. */
export const SELFTEST_APPROVAL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "g1-selftest-approval.json");
export const REPROBE_LIST_MAX = 200;
export const INJECT_MAX_BYTES = 2048;
export const INJECT_MAX_ENTRIES = 20;
export const INJECT_PER_PROVIDER = 3;
export const STALE_SNAPSHOT_MS = BENCH_OUTDATED_DAYS * 24 * 3600 * 1000;
export const STATUS_FRESH_MS = 30 * 60 * 1000;               // "the router has been seen recently" for the refusal rule
export const PID_TRUST_MS = 24 * 3600 * 1000;               // a status file older than this is not "live" on its pid alone (pids are recycled)
export const MAIN_TTL_MS = 6 * 3600 * 1000;
export const ACCURACY_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const HELPER_CALLS_NOTE = "HELPER CALLS: free governs subagents with tools; background helper calls (titles, summaries, compaction, small-fast) still use the relay in every mode";
const ROLLOUT_NOTE = "ROLLOUT: shadow first. `enforcement` stays shadow until the classifier gate has passed; `rollback` is compile-free and takes effect on the next request.";
const AMBIENT_ENV = ["UW_SUBAGENT_POLICY_FILE", "UW_SUBAGENT_STATE_DIR", "UW_DEFAULT_MODEL_FILE"];

export const ENUMS = Object.freeze({
  source: ["same-provider", "all-providers"], mode: ["dynamic", "inherit", "free"], "free-scope": [...FREE_SCOPES],
  ctx: [...CTX_VALUES], enforce: ["shadow", "enforce"], inject: ["off", "on"], unverified: ["allow-warn", "allow-t", "pin-only"],
});
const BOOLS = ["dry", "allow-empty", "quiet", "if-stale", "banded", "handoff-notice", "live", "detail", "json", "confirm", "lift-pause", "outcomes", "plan", "approve-plan", "run"];
export const FILE_FLAGS = Object.freeze(["policy-file", "state-dir", "providers-file", "snapshot-file", "bench-file", "observed-file",
  "default-model-file", "registry-file", "key-choices-file", "vault-providers-file", "settings-file", "tool-fidelity-file"]);
const OWNER_FLAGS = ["source", "mode", "free-scope", "ctx", "enforce", "inject", "unverified", "allow", "banded", "handoff-notice"];
const WHATIF_FLAGS = ["source", "mode", "free-scope", "ctx"];
const CMD_FLAGS = Object.freeze({
  set: [...OWNER_FLAGS, "dry", "allow-empty", "min-set", "live", "detail", ...FILE_FLAGS],
  show: ["detail", ...FILE_FLAGS], explain: [...WHATIF_FLAGS, ...FILE_FLAGS], rebuild: ["quiet", "if-stale", "min-set", "live", ...FILE_FLAGS],
  clear: ["policy-file", "state-dir", "live"], rollback: ["policy-file", "state-dir"],
  // the S1d wave: status and last only read; pause is rollback by another name; resume and undo write the owner file again (D-ar, I36: they need --live yes);
  // preset and wizard are sugar over set; why reads the code table
  status: [...FILE_FLAGS], last: ["since", "json", "state-dir"], pause: ["policy-file", "state-dir"],
  resume: ["min-set", "live", ...FILE_FLAGS], undo: ["min-set", "live", "lift-pause", ...FILE_FLAGS],
  preset: ["confirm", "dry", "live", "detail", "min-set", ...FILE_FLAGS], wizard: ["min-set", "live", ...FILE_FLAGS], why: [],
  // S2a and S2c: report only reads (the prices come from the snapshot, the ground truth from the request log, both named by a fixture run); selftest prints, approves or runs
  report: ["since", "session", "json", "outcomes", "logs-file", "state-dir", "snapshot-file"], selftest: ["plan", "approve-plan", "run", "live"],
});
export const COMMANDS = Object.freeze(Object.keys(CMD_FLAGS));

export class PolicyError extends Error {
  constructor(code, message, exit = 1, extra = []) { super(message); this.name = "PolicyError"; this.code = code; this.exit = exit; this.extra = extra; }
}
const usage = (m) => new PolicyError("E_USAGE", m, 1);

// ------------------------------------------------------------------ small fs helpers
// A synchronous pause without a timer (the Windows rename-over-open-reader retry, plan 5.4).
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* best effort */ } };
const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOENT", "EACCES"]);

/** Read and parse JSON; `retry` retries EPERM/EBUSY/ENOENT with backoff (readers, 5.4). Returns {ok, value|reason}. */
export function readJsonFile(file, { retry = false } = {}) {
  const delays = retry ? [20, 40, 60, 80, 100] : [];
  for (let i = 0; ; i++) {
    try { return { ok: true, value: JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) }; }
    catch (e) {
      if (e?.code === "ENOENT" && !retry) return { ok: false, reason: "missing" };
      if (retry && TRANSIENT.has(e?.code) && i < delays.length) { sleepMs(delays[i]); continue; }
      return { ok: false, reason: e?.code === "ENOENT" ? "missing" : e instanceof SyntaxError ? "corrupt" : "unreadable" };
    }
  }
}

/** Atomic write with the rename retries of 5.4; a final failure is E_WRITE (exit 5). */
export function writeFileRetry(file, text) {
  const delays = [10, 30, 90];
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); writeAtomic(file, text); return; }
    catch (e) {
      if ((e?.code === "EPERM" || e?.code === "EBUSY") && i < delays.length) { sleepMs(delays[i]); continue; }
      throw new PolicyError("E_WRITE", `cannot write ${file}: ${e?.code ?? e?.message}`, 5);
    }
  }
}
const sha = (text, n = 12) => crypto.createHash("sha256").update(text).digest("hex").slice(0, n);

// ------------------------------------------------------------------ owner file (5.1)
export const OWNER_DEFAULTS = Object.freeze({ schema: 1, source: "same-provider", mode: "dynamic", freeScope: "providers", ctx: "any",
  enforcement: "shadow", inject: "off", unverified: "allow-warn", allow: [], classLog: "on", banded: true, handoffNotice: true });
const SEL_PIN = /^[A-Za-z0-9_.:@+~-]+\/[A-Za-z0-9_./:@+~-]{1,63}$/;

export function validateOwner(o) {
  const bad = (m) => new PolicyError("E_OWNER_CORRUPT", `owner policy file is invalid: ${m}`, 4);
  if (!o || typeof o !== "object" || Array.isArray(o)) throw bad("not a JSON object");
  if (o.schema !== 1) throw bad(`schema must be 1, found ${JSON.stringify(o.schema)}`);
  const pick = (k, list, f = k) => { if (!list.includes(o[f])) throw bad(`${f} must be one of ${list.join("|")}, found ${JSON.stringify(o[f])}`); };
  pick("source", ENUMS.source); pick("mode", ENUMS.mode); pick("freeScope", ENUMS["free-scope"]); pick("ctx", ENUMS.ctx);
  pick("enforcement", ENUMS.enforce); pick("inject", ENUMS.inject); pick("unverified", ENUMS.unverified); pick("classLog", ["on", "off"]);
  for (const k of ["banded", "handoffNotice"]) if (o[k] !== undefined && typeof o[k] !== "boolean") throw bad(`${k} must be true or false, found ${JSON.stringify(o[k])}`);
  if (!Array.isArray(o.allow) || o.allow.some((x) => typeof x !== "string" || !SEL_PIN.test(x) || x.length > ALLOW_PIN_MAX)) throw bad(`allow must be a list of provider/model (each at most ${ALLOW_PIN_MAX} characters)`);
  if (o.allow.length > ALLOW_MAX) throw bad(`allow holds ${o.allow.length} pins (limit ${ALLOW_MAX})`);
  return o;
}

/** `null` ONLY when the file does not exist; anything else wrong is a loud error (V13, not readJsonOr). */
export function loadOwner(file) {
  let st;
  try { st = fs.statSync(file); } catch (e) { if (e?.code === "ENOENT") return null; throw new PolicyError("E_OWNER_CORRUPT", `cannot read owner policy file ${file}: ${e?.code}`, 4); }
  if (!st.isFile()) throw new PolicyError("E_OWNER_CORRUPT", `owner policy file ${file} is not a regular file`, 4);
  if (st.size > OWNER_MAX_BYTES) throw new PolicyError("E_OWNER_CORRUPT", `owner policy file ${file} is ${st.size} bytes (limit ${OWNER_MAX_BYTES})`, 4);
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
    if (obj && typeof obj === "object") { if (obj.classLog === undefined) obj.classLog = "on"; if (obj.banded === undefined) obj.banded = true; if (obj.handoffNotice === undefined) obj.handoffNotice = true; } }
  catch (e) { throw new PolicyError("E_OWNER_CORRUPT", `owner policy file ${file} is not valid JSON (${e.message}); fix it or run: node keysync/key.mjs subagent-policy clear`, 4); }
  return validateOwner(obj);
}
export function saveOwner(file, owner, now = () => new Date()) {
  const out = { ...owner, setAt: now().toISOString() };
  validateOwner(out);
  const text = JSON.stringify(out, null, 2) + "\n";
  // loadOwner refuses a file over OWNER_MAX_BYTES, so a file that would not load again is never written
  if (Buffer.byteLength(text) > OWNER_MAX_BYTES) throw new PolicyError("E_USAGE", `the owner policy would be ${Buffer.byteLength(text)} bytes (limit ${OWNER_MAX_BYTES}); remove some --allow pins`, 1);
  writeFileRetry(file, text);
  return out;
}

// ------------------------------------------------------------------ args (7)
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS.includes(cmd)) throw usage(`unknown subcommand ${JSON.stringify(cmd ?? "")}; expected one of ${COMMANDS.join(", ")}`);
  const flags = {}, pos = [], allow = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    if (!CMD_FLAGS[cmd].includes(name)) throw usage(`unknown or not applicable flag ${a} for ${cmd}`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw usage(`flag ${a} needs an explicit value${BOOLS.includes(name) ? " (yes or no)" : ENUMS[name] ? ` (${ENUMS[name].join("|")})` : ""}; every flag takes one`);
    }
    i += 1;
    if (BOOLS.includes(name)) { if (v !== "yes" && v !== "no") throw usage(`flag ${a} takes exactly yes or no, found ${JSON.stringify(v)}`); flags[name] = v === "yes"; continue; }
    if (name === "mode" && v === "fixed") throw usage("--mode fixed was renamed to --mode inherit; there is no alias");
    if (ENUMS[name]) { if (!ENUMS[name].includes(v)) throw usage(`flag ${a} must be one of ${ENUMS[name].join("|")}, found ${JSON.stringify(v)}`); flags[name] = v; continue; }
    if (name === "min-set") { if (!/^[1-9]\d{0,3}$/.test(v)) throw usage(`flag ${a} takes a positive integer, found ${JSON.stringify(v)}`); flags[name] = Number(v); continue; }
    if (name === "allow") { if (!SEL_PIN.test(v) || v.length > ALLOW_PIN_MAX) throw usage(`flag ${a} takes provider/model of at most ${ALLOW_PIN_MAX} characters, found ${JSON.stringify(v.slice(0, 120))}`); allow.push(v); continue; }
    if (v.trim() === "") throw usage(`flag ${a} needs a file path, found an empty or blank value`);   // "" would resolve to a REAL default or to the cwd
    flags[name] = v;                                              // a file path
  }
  if (cmd === "explain") { if (pos.length !== 1) throw usage("usage: subagent-policy explain <provider/model> [--source ..] [--mode ..] [--free-scope ..] [--ctx ..] [flags]"); }
  else if (cmd === "why") { if (pos.length > 1) throw usage("usage: subagent-policy why [CODE]"); }
  else if (cmd === "preset") { if (pos.length > 1 || (pos[0] !== undefined && !Object.hasOwn(PRESETS, pos[0]))) throw usage(`usage: subagent-policy preset [${Object.keys(PRESETS).join("|")}] [--confirm yes]`); }
  else if (cmd === "report" || cmd === "selftest") { if (pos.length) throw usage(`unexpected argument ${JSON.stringify(pos[0])} for ${cmd}`); }
  else if (cmd === "last") {
    if (pos.length > 1 || (pos[0] !== undefined && !/^[1-9]\d{0,2}$/.test(pos[0]))) throw usage("usage: subagent-policy last [N] [--since 1h|24h|7d] [--json yes] (N is a number from 1 to 999)");
  } else if (pos.length) throw usage(`unexpected argument ${JSON.stringify(pos[0])} for ${cmd}`);
  if (flags.since !== undefined && !/^[1-9]\d{0,3}[mhd]$/.test(flags.since)) throw usage(`flag --since takes a number and a unit, like 1h, 24h or 7d, found ${JSON.stringify(String(flags.since).slice(0, 40))}`);
  if (flags.session !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(flags.session)) throw usage(`flag --session takes a session id of letters, digits, _ and - (at most 64), found ${JSON.stringify(String(flags.session).slice(0, 40))}`);
  if (flags["logs-file"] !== undefined && !("state-dir" in flags)) throw usage("incomplete test-flag set: --logs-file requires --state-dir too (the request log is read from the real data folder only when no test flag is given)");
  if ([flags.plan, flags["approve-plan"], flags.run].filter(Boolean).length > 1) throw usage("selftest: --plan, --approve-plan and --run are separate steps: give one");
  if (allow.length) flags.allow = allow;
  // The all-or-nothing safety rule (4): a half-fixtured run must never mix fixture input with the real ~/.llmkeys or state/.
  // rollback and clear read no input file, but they write the owner file and the state folder: --policy-file alone would pair a
  // fixture owner file with the REAL state folder, so it is refused; --state-dir alone leaves the owner file alone (resolvePaths).
  if ((cmd === "rollback" || cmd === "pause" || cmd === "clear") && "policy-file" in flags && !("state-dir" in flags)) {
    throw usage(`incomplete test-flag set: --policy-file requires --state-dir too for ${cmd} (it would otherwise act on the real state folder)`);
  }
  const given = FILE_FLAGS.filter((f) => f in flags);
  // A command that WRITES the real files needs an explicit `--live yes` (a set without --dry, rebuild, clear, run with no file flag at all). `rollback` is exempt: it only moves toward safety and
  // one word must work in an emergency.
  // resume and undo write the owner file again (the direction away from safety), and a preset that is confirmed is a set: all three need it too. So does the wizard: a real save never
  // happens without an explicit `--live yes` on the command line, so the wizard is refused up front (before it asks a question) rather than after the answers.
  const writes = (cmd === "set" && !flags.dry) || cmd === "rebuild" || cmd === "clear" || cmd === "resume" || cmd === "undo" || cmd === "wizard" || (cmd === "preset" && flags.confirm === true && !flags.dry) || (cmd === "selftest" && (flags["approve-plan"] === true || flags.run === true));
  if (!given.length && writes && flags.live !== true) {
    const real = cmd === "selftest" ? [SELFTEST_APPROVAL_FILE] : [OWNER_FILE, path.join(STATE_DIR, "policy.json"), ...(cmd === "set" || cmd === "clear" || cmd === "preset" || cmd === "resume" || cmd === "undo" || cmd === "wizard" ? [path.join(STATE_DIR, "shadow.flag")] : []), ...(cmd === "clear" ? [path.join(STATE_DIR, "<session, cooling and status files>")] : [])];
    throw usage(`${cmd} with no file flags writes the REAL files ${real.join(", ")}; pass --live yes to confirm (a fixture run names its own files with the test flags; --dry yes previews a set; rollback and pause need no flag)`);
  }
  if (given.length) {
    const need = cmd === "set" || cmd === "explain" || cmd === "rebuild" || cmd === "preset" || cmd === "wizard" || cmd === "resume" || cmd === "undo" ? ["policy-file", "state-dir", "providers-file"]
      : cmd === "show" || cmd === "status" ? ["policy-file", "state-dir"] : cmd === "last" || cmd === "report" ? ["state-dir"] : [];
    const missing = need.filter((f) => !(f in flags));
    if (missing.length) throw usage(`incomplete test-flag set: ${given.map((f) => "--" + f).join(" ")} requires ${need.map((f) => "--" + f).join(" ")} too (missing ${missing.map((f) => "--" + f).join(" ")})`);
  }
  return { cmd, flags, target: pos[0] ?? null };
}

/** The folders a fixture run must never name: the real vault, Claude settings, UW state and catalog (resolved against the home folder in use). */
export const protectedDirs = (home = os.homedir(), env = process.env) => [path.join(home, ".llmkeys"), path.join(home, ".claude"), path.join(home, ".uw", "state"), path.join(home, ".uw", "catalog"), ...(dataDir(env) ? [dataDir(env)] : [])];   // the last is CCR's own data folder (the request log lives there)
const realNative = (p) => (fs.realpathSync.native ?? fs.realpathSync)(p);
/** realpath of the deepest existing ancestor plus the not-yet-existing tail: a path that does not exist yet (or sits behind a junction) still resolves. */
function realish(p) {
  let head = path.resolve(p), tail = "";
  for (;;) {
    try { return path.join(realNative(head), tail); } catch { /* not there yet */ }
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    tail = path.join(path.basename(head), tail); head = up;
  }
}
const normCase = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
const isUnder = (child, dir) => { const c = normCase(child), d = normCase(dir); return c === d || c.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };

export function resolvePaths(flags, { env = process.env, protect = protectedDirs(os.homedir(), env) } = {}) {
  const given = (k) => flags[k] !== undefined;
  for (const k of [...FILE_FLAGS, "logs-file"]) if (given(k) && String(flags[k]).trim() === "") throw usage(`flag --${k} needs a file path, found an empty or blank value`);   // truthiness would send it to a REAL default
  // `--state-dir` names the state ROOT (the stand-in for ~/.uw/state); the policy files live in its `subagent` folder, as the
  // router's own location-derived path does, and the tool-fidelity file sits at its top level.
  const stateRoot = given("state-dir") ? path.resolve(flags["state-dir"]) : STATE_ROOT;
  const stateDir = path.join(stateRoot, "subagent");
  // The all-or-nothing rule (4), enforced on the VALUES: once any file flag is given the run is a fixture run, and every file it
  // was NOT given resolves to a path that does not exist (under the fixture's own state root), never to a real default. A fixture
  // run that forgot a flag therefore fails loudly instead of quietly reading the real vault, settings, bench or snapshot.
  const fixture = FILE_FLAGS.some(given);
  // Defence in depth: a fixture run names its own temp folders. An explicit path whose realpath (or whose nearest existing
  // ancestor's) lies under a real folder is refused, however it was spelled (a junction, a `..`, a different case, a short name).
  if (fixture) {
    const real = protect.flatMap((d) => [path.resolve(d), realish(d)]);
    for (const k of [...FILE_FLAGS, "logs-file"]) {
      if (!given(k)) continue;
      // SEC-3: the RESOLVED path is tested for a UNC prefix BEFORE realish() runs: realish() calls realpath, and realpath of a remote UNC path makes Windows open an SMB connection (42 s to be refused). A local junction that leads to a UNC target is still caught by the second test below.
      const abs = path.resolve(flags[k]);
      if (abs.startsWith("\\\\")) throw usage(`refusing --${k} ${JSON.stringify(path.resolve(flags[k]))}: a UNC path (two leading backslashes) can reach a real folder by a name the local checks do not recognise; a test-flag run names its own local temp folders`);
      const mine = [abs, realish(flags[k])];
      // S-F8: a UNC path (\\\\localhost\\C$\\..., \\\\127.0.0.1\\C$\\..., \\\\?\\C:\\...) can name a real folder behind a name no local-path comparison recognises: refused outright, like harness/deploy-router.mjs does
      if (mine.some((m) => m.startsWith("\\\\"))) throw usage(`refusing --${k} ${JSON.stringify(path.resolve(flags[k]))}: a UNC path (two leading backslashes) can reach a real folder by a name the local checks do not recognise; a test-flag run names its own local temp folders`);
      const hit = real.find((d) => mine.some((m) => isUnder(m, d)));
      if (hit) throw usage(`refusing --${k} ${JSON.stringify(path.resolve(flags[k]))}: it lies under ${hit}, a real vault, Claude, state or catalog folder; a test-flag run names its own temp folders`);
    }
  }
  const f = (k, real) => (given(k) ? path.resolve(flags[k]) : fixture ? path.join(stateRoot, "_not-given", k) : real);
  return {
    // --state-dir without --policy-file (rollback, clear): the owner file is treated as ABSENT, never resolved to the real one
    policyFile: given("policy-file") ? path.resolve(flags["policy-file"]) : given("state-dir") ? null : OWNER_FILE,
    fixture, stateRoot, stateDir, compiledFile: path.join(stateDir, "policy.json"),
    statusFile: path.join(stateDir, "status.json"), flagFile: path.join(stateDir, "shadow.flag"),
    providersFile: given("providers-file") ? path.resolve(flags["providers-file"]) : null,
    logsFile: given("logs-file") ? path.resolve(flags["logs-file"]) : fixture ? null : requestLogsDb(env),     // the request log of CCR: a fixture run reads one only when it names it
    snapshotFile: f("snapshot-file", undefined), benchFile: f("bench-file", BENCH_FILE), observedFile: f("observed-file", undefined),
    defaultModelFile: f("default-model-file", DEFAULT_MODEL_FILE),
    registryFile: f("registry-file", path.join(LLMKEYS, "registry.json")),
    keyChoicesFile: f("key-choices-file", path.join(LLMKEYS, "key-choices.json")),
    vaultProvidersFile: f("vault-providers-file", path.join(LLMKEYS, "providers.json")),
    settingsFile: f("settings-file", CC.paths.settings),
    toolFidelityFile: given("tool-fidelity-file") ? path.resolve(flags["tool-fidelity-file"]) : path.join(stateRoot, "tool-fidelity.json"),   // always under the state root in use
  };
}

// ------------------------------------------------------------------ input readers
/** The registry/providers pair, parsed the way `loadVault` does (BOM tolerant) but from explicit files. */
export function readVaultFiles({ registryFile, providersFile }) {
  const reg = readJsonFile(registryFile), prov = readJsonFile(providersFile);
  if (!reg.ok) return { ok: false, reason: `registry ${reg.reason}` };
  if (!prov.ok) return { ok: false, reason: `vault providers ${prov.reason}` };
  if (!Array.isArray(reg.value) || !Array.isArray(prov.value)) return { ok: false, reason: "registry or vault providers is not a list" };
  // valid JSON of the wrong shape (a null row, a row without a string provider) is a torn or hostile file: unreadable, never a TypeError
  const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
  if (!reg.value.every((r) => isObj(r) && typeof r.provider === "string" && typeof r.id === "string")) return { ok: false, reason: "registry has a malformed row" };
  if (!prov.value.every((p) => isObj(p) && typeof p.provider === "string")) return { ok: false, reason: "vault providers has a malformed row" };
  return { ok: true, registry: reg.value, providers: new Map(prov.value.map((p) => [p.provider, p])) };
}

/**
 * Provider -> tier, from the registry through filterRegistry then chooseKeys, exactly as keysync wires keys (D-k, I11).
 * Returns {tiers|null, reason?, ambiguous[]}: `tiers` is null when the registry or key choices cannot be read; a PRESENT but
 * corrupt key-choices file is unreadable, an ABSENT one means no choices (not `loadKeyChoices`: it turns corrupt into {}).
 */
export function readTiers(p) {
  const v = readVaultFiles({ registryFile: p.registryFile, providersFile: p.vaultProvidersFile });
  if (!v.ok) return { tiers: null, reason: v.reason, ambiguous: [] };
  let choices = {};
  const c = readJsonFile(p.keyChoicesFile);
  if (c.ok) choices = c.value && typeof c.value === "object" ? c.value : {};
  else if (c.reason !== "missing") return { tiers: null, reason: `key choices ${c.reason}`, ambiguous: [] };
  const filtered = filterRegistry(v.registry, v.providers);
  let chosen, ambiguous = [];
  try { chosen = chooseKeys(filtered, choices); }
  catch (e) {
    const m = /multi-key provider\(s\) with no deliberate choice in .*?: (\[.*\]) —/.exec(String(e.message));
    ambiguous = m ? JSON.parse(m[1]) : [{ provider: "?", ids: [] }];
    const amb = new Set(ambiguous.map((a) => a.provider));
    chosen = chooseKeys(filtered.filter((r) => !amb.has(r.provider)), choices);
  }
  const tiers = Object.create(null);                              // keyed by a provider name: no prototype, so __proto__ and constructor are ordinary own keys
  for (const r of chosen) tiers[r.provider] = r.tier;
  // A provider whose ONLY key is a management key was removed by filterRegistry, so it would otherwise read as "no tier" and the
  // strict rule would let a free-tagged row of it into scope models. Management is never admitted (D-k): name it.
  const ambNames = new Set(ambiguous.map((a) => a.provider));
  for (const r of v.registry) if (isExcludedTier(r.tier) && !Object.hasOwn(tiers, r.provider) && !ambNames.has(r.provider)) tiers[r.provider] = r.tier;
  return { tiers, ambiguous, keyIds: Object.fromEntries(chosen.map((r) => [r.provider, r.id])) };
}

const normProviders = (arr) => arr.filter((x) => x && typeof x.name === "string")
  .map((x) => ({ name: x.name, models: Array.isArray(x.models) ? x.models.filter((m) => typeof m === "string") : [], enabled: x.enabled,
    described: Array.isArray(x.modelDescriptions) ? x.modelDescriptions.length > 0 : !!x.modelDescriptions }));

/** Read-only fetch of the live Providers: the compiler keeps name, models, enabled and the presence of descriptions only. */
export async function fetchProvidersLive() {
  const cfg = await rpc("getConfig", [], { timeoutMs: 5000 });
  return Array.isArray(cfg?.Providers) ? normProviders(cfg.Providers) : null;
}

export async function readProviders(p) {
  if (p.providersFile) {
    const r = readJsonFile(p.providersFile);
    const list = r.ok ? (Array.isArray(r.value) ? r.value : r.value?.Providers) : null;
    return Array.isArray(list) ? normProviders(list) : null;
  }
  return fetchProvidersLive();
}

function readBench(p) {
  const raw = readJsonFile(p.benchFile);
  if (!raw.ok) throw new PolicyError("E_SNAPSHOT", `E_SNAPSHOT:bench-${raw.reason}: ${p.benchFile}`, 4);
  if (raw.value?.schema !== 1 || typeof raw.value.models !== "object") throw new PolicyError("E_SNAPSHOT", "E_SNAPSHOT:bench-schema", 4);
  const b = loadBench(p.benchFile, p.observedFile ? { observed: p.observedFile } : {});
  // Router v2 (ar-14): `get` and `isLive` are asked about every selector once per stage and again per scope; both are pure per selector within one compile,
  // so each answer is computed once (the measured steady-state funnel went from 150-290 ms to a few tens of ms). The records are the same objects, so the output is byte-identical.
  const gets = new Map(), lives = new Map();
  const get = (k) => { if (gets.has(k)) return gets.get(k); const v = b.get(k); gets.set(k, v); return v; };
  const isLive = (k) => { if (lives.has(k)) return lives.get(k); const v = b.get.isLive(k); lives.set(k, v); return v; };
  return { get, isLive, generatedAt: b.generatedAt, overlayWrittenAt: b.overlay?.writtenAt ?? null };
}

function readToolFidelity(file) {
  const r = readJsonFile(file);
  if (!r.ok) return null;                                         // absent: every row is `u`
  return r.value && typeof r.value.models === "object" ? r.value : null;
}

function aliasValuesFrom(file) {
  const r = readJsonFile(file);
  const env = r.ok ? (r.value?.env ?? {}) : {};
  const k = CC.subagent.envKeys;
  return { values: { opus: env[k.opus], sonnet: env[k.sonnet], haiku: env[k.haiku], fable: env[k.fable], model: env[k.model], smallFast: env[k.smallFast] },
    subagentOverride: typeof env[k.subagentOverride] === "string" && env[k.subagentOverride] !== "" };
}

/** Everything the funnel needs, plus the stamps `builtFrom` records. Throws PolicyError for an unreadable snapshot or bench. */
export async function gatherInputs(p, { nowMs = Date.now(), liveProviders } = {}) {
  const snap = loadSnapshot(p.snapshotFile);
  if (!snap.ok) throw new PolicyError("E_SNAPSHOT", `E_SNAPSHOT:${snap.reason}: ${snap.detail ?? ""}`, 4);
  const bench = readBench(p);
  const tiersRes = readTiers(p);
  // `liveProviders` is a library-level seam (a unit test supplying what a live fetch returned: an array, or null for "gateway down");
  // the CLI never passes it. Providers read from a --providers-file are a FIXTURE: they are used, but never stamped live, so no
  // fixture flag set can satisfy the live-gateway precondition of --enforce enforce.
  const injected = liveProviders !== undefined;
  const providers = injected ? liveProviders : await readProviders(p);
  const fromFixture = !injected && providers !== null && !!p.providersFile;
  const live = providers !== null && !fromFixture;
  const warnings = [];
  if (providers === null) {
    const asOf = Date.parse(snap.snap.routableAsOf ?? "");
    if (!Number.isFinite(asOf) || nowMs - asOf > STALE_SNAPSHOT_MS) {
      throw new PolicyError("E_SNAPSHOT", `E_SNAPSHOT:providers: live Providers unreadable and the snapshot routable flags are older than ${BENCH_OUTDATED_DAYS} days`, 4);
    }
    warnings.push({ code: "PROVIDERS_FALLBACK", text: "PROVIDERS: live Providers unreadable (gateway down?); using the snapshot routable flag, stamped providersLive: false; --enforce enforce is refused" });
  } else {
    if (fromFixture) warnings.push({ code: "PROVIDERS_FIXTURE", text: "PROVIDERS: read from --providers-file (a fixture): stamped providersLive: false; --enforce enforce is refused" });
    if (providers.some((x) => x.described)) {
      warnings.push({ code: "NATIVE_MENU_PRESENT", text: "NATIVE_MENU_PRESENT: a provider has modelDescriptions, so CCR also injects its own model list (two lists)" });
    }
  }
  const builtAt = Date.parse(snap.snap.builtAt ?? "");
  if (Number.isFinite(builtAt) && nowMs - builtAt > STALE_SNAPSHOT_MS) {
    warnings.push({ code: "SNAPSHOT_STALE", text: `STALE: snapshot built ${snap.snap.builtAt} is older than ${BENCH_OUTDATED_DAYS} days (a warning, never a prune)` });
  }
  const benchAt = Date.parse(bench.generatedAt ?? "");
  if (Number.isFinite(benchAt) && Number.isFinite(builtAt) && benchAt < builtAt) {
    warnings.push({ code: "BENCH_OLDER", text: `STALE: bench generated ${bench.generatedAt} is older than the snapshot (a warning, never a prune)` });
  }
  const { values: aliasValues, subagentOverride } = aliasValuesFrom(p.settingsFile);
  if (subagentOverride) warnings.push({ code: "SUBAGENT_OVERRIDE_SET", text: `${CC.subagent.envKeys.subagentOverride} is set in the settings env: it hard-overrides the subagent model and defeats this policy` });
  let defaultModel = null;
  try { defaultModel = loadDefaultModel(p.defaultModelFile)?.model ?? null; } catch { defaultModel = null; }
  const tf = readToolFidelity(p.toolFidelityFile);
  return {
    funnelInputs: { rows: snap.snap.rows, bench, nowMs, providers, tiers: tiersRes.tiers, toolFidelity: tf, aliasValues, defaultModel, classifyBench: (rec) => classifyTight(typeof rec?.m === "string" ? rec.m : "") },   // F6: the bench's own tight reading of a stored message (pay, auth, gone or null)
    providersLive: live, tiersRes, defaultModel, warnings,
    stamps: { snapshotBuiltAt: snap.snap.builtAt ?? null, snapshotSchema: snap.snap.schemaVersion, benchGeneratedAt: bench.generatedAt,
      observedWrittenAt: bench.overlayWrittenAt, tfAsOf: tf?.generatedAt ?? null,
      // the inputs with no timestamp of their own (settings env aliases, the default model, the tool-fidelity file body): `rebuild --if-stale` compares this stamp instead of compiling to find out
      inputsHash: sha(JSON.stringify({ aliasValues, defaultModel, tf }), 12) },
    providersHash: providers ? sha(providers.map((x) => `${x.name}:${x.enabled === false ? "off" : "on"}:${x.models.join(",")}`).sort().join("|")) : null,
  };
}

// ------------------------------------------------------------------ injection text (6.4)
const ctxText = (c, inferred = false) => (inferred ? `~${Math.floor(c / 1000)}k?` : c >= 1000000 ? "1M" : c > 0 ? `${Math.floor(c / 1000)}k` : "ctx?");
const speedText = (h) => TTFT_BUCKETS[h] ?? "?";
const toolsText = (t) => (t === "v" ? "verified" : t === "t" ? "small" : "UNVERIFIED");
const capText = (pb) => (pb > 0 ? `${Math.round(pb / 1024)}k` : "unknown");
export function injectRow(r) {
  return `- ${r.s}  ${ctxText(r.c, !!r.ci)}  ${r.i}  tools:${toolsText(r.t)}  ${speedText(r.h)}  cap:${capText(r.pb)}${r.al ? "  ALIAS" : ""}${r.p ? "  $$" : ""}`;
}
function renderBlock(rows, hash, owner, scopeNote) {
  const { open, close, example } = CCR.subagentTag;
  const head = `[uw-subagent-policy v1 ${hash}]\nUW subagent routing policy is active (mode ${owner.mode}, source ${owner.source}${scopeNote}, ctx ${owner.ctx}). ` +
    `When calling this tool, the prompt parameter MUST start with ${open}${example}${close} on its own first line, replacing ${example} with one ID from the list below. ` +
    "When the tool model field accepts exact strings, set it to the same ID. If the model field only permits built-in aliases, leave it unset and rely on the tag. " +
    "CCR removes the tag before the agent runs. An ID outside this list is replaced by policy and the replacement is logged. Do not put the tag in description or subagent_type.";
  const build = (shown) => {
    const unv = rows.filter((r) => r.t === "u").length;
    const lines = [head, `Allowed subagent models (${shown.length} of ${rows.length} shown; ordered by reliability then context, NOT by quality or price; columns: ctx, price per M tokens, tools verification, speed bucket, payload cap):`,
      ...shown.map(injectRow)];
    if (unv > 0) lines.push(`Notice: ${unv} of ${rows.length} listed models have UNVERIFIED tool support (not yet tested under Claude Code's tool payload); a subagent on one may fail on tool use. Premium-priced rows are marked $$. Pick for the task, not for position in this list.`);
    else lines.push("Premium-priced rows are marked $$. Pick for the task, not for position in this list.");
    return lines.join("\n");
  };
  let shown = rows.slice(0, INJECT_MAX_ENTRIES);
  while (shown.length > 0 && Buffer.byteLength(build(shown)) > INJECT_MAX_BYTES) shown = shown.slice(0, -1);
  return build(shown);
}
const capPerProvider = (rows) => { const n = new Map(); return rows.filter((r) => { const p = providerOf(r.s), k = (n.get(p) ?? 0) + 1; n.set(p, k); return k <= INJECT_PER_PROVIDER; }); };

function renderInject(res, owner, hash) {
  const { open, close, example } = CCR.subagentTag;
  const out = { all: "", byProvider: {}, empty: "", promptNote: "" };
  out.empty = `UW subagent policy WARNING: no subagent model is eligible under mode ${owner.mode} / source ${owner.source}. Subagents will run on the model they request, unchanged. Tell the user.`;
  out.promptNote = `[uw-subagent-policy v1 ${hash}] Start with ${open}${example}${close} on its own first line, using one ID from the list in this tool's description.`;
  if (owner.mode === "inherit") return out;
  if (owner.source === "all-providers") out.all = res.models.length ? renderBlock(capPerProvider(res.models), hash, owner, "") : out.empty;
  else {
    // Object.fromEntries DEFINES the keys, so a provider named __proto__ stays an own key (an assignment would be dropped)
    out.byProvider = Object.fromEntries(Object.entries(res.lists.byProvider).map(([p, idx]) => [p, renderBlock(idx.map((i) => res.models[i]), hash, owner, ` ${p}`)]));
    // A provider with rows but no substitute pool keeps its list (the honour path serves a tag main chose from it); a
    // provider with NO rows has no entry, and the router then falls back to `empty`.
  }
  return out;
}

// ------------------------------------------------------------------ compile (5.2)
// The hash covers ROUTING CONTENT and nothing else: what the router decides with and what main is told. The owner block is
// hashed WHOLE (so toggling inject changes it), the models and lists, and the derived maps. Counts, timestamps and build stamps
// are not routing content: a snapshot row that changes only the funnel counts must not rotate the injected text (a prompt-cache
// miss for every running session). An explicit allow-list, so a new volatile field is excluded by default.
// Router v2 (ar-10): the owner fields that steer only HOW the router behaves, not what main is told or which rows are candidates, are outside the
// hashed owner block, so flipping `enforcement`, `classLog` or `handoffNotice` never rotates the injected marker line (a prompt-cache miss for every
// running session). The router (router/uw-router.next.cjs, HASH_OWNER_EXCLUDE) recomputes the hash with the same rule; a test pins the two lists equal.
// `lists.prov` and every row's `b` are routing content and in the hash through `lists` and `models`; `minRouter` and `rollout` are not.
export const HASH_KEYS = ["schema", "owner", "empty", "emptyProviders", "thinProviders", "tiers", "substitutable", "exempt", "ctxHints", "models", "lists"];
export const HASH_OWNER_EXCLUDE = ["enforcement", "classLog", "handoffNotice"];
export function hashOf(compiled) {
  const owner = isObject(compiled.owner) ? Object.fromEntries(Object.entries(compiled.owner).filter(([k]) => !HASH_OWNER_EXCLUDE.includes(k))) : compiled.owner;
  return sha(JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, k === "owner" ? owner : compiled[k]]))));
}
/** The owner block the compiled file carries (what a rebuild compares with what is on disk). */
export const ownerBlock = (owner) => ({ source: owner.source, mode: owner.mode, freeScope: owner.freeScope, ctx: owner.ctx, enforcement: owner.enforcement,
  inject: owner.inject, unverified: owner.unverified, classLog: owner.classLog, banded: owner.banded !== false, handoffNotice: owner.handoffNotice !== false });
export const tiersHashOf = (tiers) => sha(JSON.stringify(Object.entries(Object.fromEntries(Object.entries(tiers ?? {}))).sort()));
/** Everything that decides the compiled content apart from the stamped inputs: the owner toggles that reach the funnel (allow pins included) and the banded switch. */
export const ownerHashOf = (owner) => sha(JSON.stringify([owner.source, owner.mode, owner.freeScope, owner.ctx, owner.unverified, [...(owner.allow ?? [])].sort(), owner.banded !== false]));
/** Counts the full compiles this process ran (a test asserts that `rebuild --if-stale yes` on an unchanged input compiles nothing). */
export const compileStats = { compiles: 0 };
/** Same compiled content apart from the compile time: what decides whether the file is rewritten at all. */
const sameCompiled = (a, b) => !!a && JSON.stringify({ ...a, compiledAt: 0 }) === JSON.stringify({ ...b, compiledAt: 0 });

const identityList = (a, n) => Array.isArray(a) && a.length === n && a.every((v, i) => v === i);
export function compile(g, owner, { now = () => new Date(), minSet, gate } = {}) {
  const toggles = { source: owner.source, mode: owner.mode, freeScope: owner.freeScope, ctx: owner.ctx, unverified: owner.unverified, allow: owner.allow };
  const res = funnel({ ...g.funnelInputs, minSet }, toggles);
  compileStats.compiles += 1;
  const o = ownerBlock(owner);
  const tiers = Object.fromEntries(Object.entries(g.funnelInputs.tiers ?? {}));      // a plain object with OWN keys: JSON writes and reads a __proto__ key as one
  const tierWarnings = [...g.warnings, ...res.warnings].filter((w) => w.code === "KEY_AMBIGUOUS" || w.code === "NO_TIER").map((w) => ({ code: w.code, text: w.text }));
  const compiled = {
    schema: 1, minRouter: MIN_ROUTER, rollout: { canaryPct: 100, salt: "uw-r1" },       // both OUTSIDE the hash; the rollout field is inert (no CLI flag sets it): every agent is enforced
    contentHash: "", compiledAt: now().toISOString(), owner: o,
    builtFrom: { ...g.stamps, providersLive: g.providersLive, providersHash: g.providersHash, tiersHash: tiersHashOf(tiers), ownerHash: ownerHashOf(owner), compiler: COMPILER_VERSION,
      tierWarnings },                                           // F24: outside the hash (builtFrom is not routing content); a rebuild prints them and an auto-rebuild can surface them
    empty: res.empty, emptyReasons: [], emptyProviders: res.emptyProviders, thinProviders: res.thinProviders, tiers, substitutable: res.substitutable,
    exempt: res.exempt, ctxHints: res.ctxHints,
    counts: { universe: res.counts.universe, allowed: res.counts.allowed, verified: res.counts.verified, small: res.counts.small, unverified: res.counts.unverified,
      premium: res.counts.premium, payloadRisk: res.counts.payloadRisk, payloadUnknown: res.counts.payloadUnknown, tfAsOf: g.stamps.tfAsOf, alias: res.counts.alias,
      freeScopes: res.counts.freeScopes, depositStrictSkipped: res.counts.depositStrictSkipped, idRejected: res.counts.idRejected,
      nonAgent: res.counts.nonAgent, knownBad: res.counts.knownBad, ctxInferred: res.counts.ctxInferred, reprobe: res.counts.reprobe, accountStateRows: res.counts.accountStateRows, ctxStats: res.ctxStats,
      funnel: res.stages.map((s) => ({ stage: s.stage, n: s.n })) },
    accountStateRows: res.accountRows.slice(0, REPROBE_LIST_MAX),   // outside the hash: free models whose stored message names the ACCOUNT (plan, key, balance): not dead and not waiting for a re-probe
    reprobe: res.reprobe.slice(0, REPROBE_LIST_MAX),       // outside the hash: free-tagged rows dropped on a transient bench status of an old sample, for the re-probe and the ledger (sa-A7)
    models: res.models, lists: { ...res.lists, all: identityList(res.lists.all, res.models.length) ? null : res.lists.all },   // `all` is null when it is the identity 0..n-1 (the router then reads the rows by index)
    main: { ttlSec: MAIN_TTL_MS / 1000 }, sticky: { ttlSec: MAIN_TTL_MS / 1000, maxEntries: 256 },
    inject: { all: "", byProvider: {}, empty: "", promptNote: "" },
  };
  if (res.empty) {
    const st = emptyStage(res, null);
    compiled.emptyReasons.push(st ? `${st.text} removed all ${st.before} candidates` : "no substitutable candidate");
  }
  compiled.contentHash = hashOf(compiled);
  compiled.inject = renderInject(res, o, compiled.contentHash);
  if (gate) compiled.gate = gate;                                 // attached BEFORE the size check: the file the router reads is the file that is measured
  const size = Buffer.byteLength(JSON.stringify(compiled) + "\n");     // the file is written with a trailing newline: count it, the router's cap is on the file
  if (size > COMPILED_MAX_BYTES) throw new PolicyError("E_PRECONDITION", `compiled policy would be ${size} bytes (limit ${COMPILED_MAX_BYTES})`, 1);
  return { compiled, res };
}

// ------------------------------------------------------------------ main provider (refusal rule b) and status
const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const STATUS_WORKER_RE = /^status-[0-9a-z]{1,13}\.json$/;
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
const ms = (v) => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : 0; };
/** Sums the numeric values of `obj` into `into` (a Map: a router-written key such as __proto__ is an ordinary key here, never a prototype write). */
const sumInto = (into, obj) => { if (isObject(obj)) for (const [k, v] of Object.entries(obj)) if (typeof v === "number" && Number.isFinite(v)) into.set(k, (into.get(k) ?? 0) + v); };
/**
 * ONE status out of the per-worker files `status-<w>.json` (router v2, ar-6: each CCR worker writes its own file, so two workers never overwrite each other):
 * counters, matrix and the by-model and by-provider tallies are SUMMED, warnings are unioned by code keeping the OLDEST `since`, `mainBySession` keeps the
 * newest entry per session, the latency histograms add bucket by bucket, `routerVersion` is the OLDEST running router (the constraint a compiled file must meet).
 */
export function mergeStatus(parts) {
  const sorted = [...parts].sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
  const out = { ...sorted[0], workers: parts.length };
  const counters = new Map(), matrix = new Map(), byModel = new Map(), byProvider = new Map(), auxBy = new Map(), lat = new Map(), warn = new Map(), mains = new Map();
  let since = Infinity, ver = Infinity, enforced = 0;
  for (const p of parts) {
    sumInto(counters, p.counters); sumInto(matrix, p.matrix); sumInto(byModel, p.byModel); sumInto(byProvider, p.byProvider);
    if (typeof p.enforcedSeen === "number") enforced += p.enforcedSeen;
    if (ms(p.since) && ms(p.since) < since) since = ms(p.since);
    if (typeof p.routerVersion === "number") ver = Math.min(ver, p.routerVersion);
    if (isObject(p.aux?.byModel)) for (const [k, v] of Object.entries(p.aux.byModel)) {
      if (!isObject(v)) continue;
      const a = auxBy.get(k) ?? { n: 0, bytesSum: 0, bytesMax: 0 };
      a.n += Number(v.n) || 0; a.bytesSum += Number(v.bytesSum) || 0; a.bytesMax = Math.max(a.bytesMax, Number(v.bytesMax) || 0); auxBy.set(k, a);
    }
    if (isObject(p.latency)) for (const [path_, arr] of Object.entries(p.latency)) {
      if (!Array.isArray(arr)) continue;
      const cur = lat.get(path_) ?? arr.map(() => 0);
      arr.forEach((v, i) => { if (typeof v === "number") cur[i] = (cur[i] ?? 0) + v; }); lat.set(path_, cur);
    }
    for (const w of Array.isArray(p.warnings) ? p.warnings : []) {
      if (!isObject(w) || typeof w.code !== "string") continue;
      const had = warn.get(w.code);
      if (!had) warn.set(w.code, { ...w });
      else { if (ms(w.since) && (!ms(had.since) || ms(w.since) < ms(had.since))) had.since = w.since; if (ms(p.updatedAt) >= ms(had.at)) { had.detail = w.detail ?? had.detail; had.at = p.updatedAt; } }
    }
    if (isObject(p.mainBySession)) for (const [k, v] of Object.entries(p.mainBySession)) if (isObject(v) && (!mains.has(k) || ms(v.t) > ms(mains.get(k).t))) mains.set(k, v);
  }
  out.counters = Object.fromEntries(counters); out.matrix = Object.fromEntries(matrix);
  out.byModel = Object.fromEntries(byModel); out.byProvider = Object.fromEntries(byProvider);
  out.aux = { ...(isObject(sorted[0].aux) ? sorted[0].aux : {}), byModel: Object.fromEntries(auxBy) };
  out.latency = Object.fromEntries(lat);
  out.warnings = [...warn.values()].map(({ at, ...w }) => w);
  out.mainBySession = Object.fromEntries(mains);
  out.enforcedSeen = enforced;
  // every worker's own reported compiled-copy hash: the policy block above is the NEWEST worker's, so a fleet that is half on an older copy would otherwise read healthy
  out.policyHashes = [...new Set(parts.map((p) => (isObject(p.policy) && typeof p.policy.contentHash === "string" ? p.policy.contentHash : null)).filter((h) => h !== null))];
  if (Number.isFinite(since)) out.since = new Date(since).toISOString();
  if (Number.isFinite(ver)) out.routerVersion = ver; else delete out.routerVersion;
  return out;
}
export function readStatus(statusFile) {
  const dir = path.dirname(statusFile);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => STATUS_WORKER_RE.test(n)); } catch { /* no state folder yet */ }
  const parts = [];
  for (const n of names) { const r = readJsonFile(path.join(dir, n), { retry: true }); if (r.ok && isObject(r.value)) parts.push(r.value); }
  if (parts.length) {
    // live = seen within the freshness window, or the process is still there AND the file is not stale (a recycled pid must not keep a long-dead worker's file alive);
    // when none is, the newest file still speaks for "router last seen"
    const now = Date.now();
    const live = parts.filter((p) => now - ms(p.updatedAt) < STATUS_FRESH_MS || (Number.isInteger(p.pid) && p.pid > 0 && now - ms(p.updatedAt) < PID_TRUST_MS && pidAlive(p.pid)));
    const use = live.length ? live : [[...parts].sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt))[0]];
    return { ok: true, status: mergeStatus(use) };
  }
  const r = readJsonFile(statusFile, { retry: true });
  if (!r.ok) return { ok: false, reason: r.reason };
  return isObject(r.value) ? { ok: true, status: r.value } : { ok: false, reason: "schema" };      // valid JSON that is not an object is as unusable as a torn file
}
/** The compiled file with its SHAPE checked: valid JSON such as {} or null is a torn or hostile file, not a policy (no raw TypeError later). */
export function readCompiled(file, opts) {
  const r = readJsonFile(file, opts);
  if (!r.ok) return r;
  const c = r.value;
  const ok = isObject(c) && c.schema === 1 && isObject(c.owner) && isObject(c.counts) && Array.isArray(c.models) && isObject(c.lists) && c.models.every(isObject);
  return ok ? r : { ok: false, reason: "schema" };
}
/** Router-written strings are untrusted when printed: control and bidi-control characters (an escape sequence or a reordering mark in a model name) become "?". */
export const printable = (v, max = 160) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : v === null || v === undefined ? "" : "?").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, max);   // C0, DEL, C1 (U+009B is a CSI), bidi overrides and isolates
/** One handoff line for people: `HANDOFF groq/x -> sambanova/y (retry 1, hop 1)`, from an agents.jsonl line with act "handoff" (pure; router-written text is made printable). */
export function formatHandoff(line) {
  const l = isObject(line) ? line : {};
  const m = /^retry:[a-z]{1,8}:(\d{1,3})$/.exec(printable(l.reason ?? l.why ?? "", 80));
  return `HANDOFF ${printable(l.from ?? "?", 160)} -> ${printable(l.to ?? l.ret ?? "?", 160)} (retry ${m ? m[1] : "?"}, hop ${Number.isInteger(l.hop) ? l.hop : "?"})`;
}
/** The provider of the most recently learned main (live status, router seen recently), else of the likely main (default model). */
export function mainProviderOf(p, g, nowMs = Date.now()) {
  const s = readStatus(p.statusFile);
  if (s.ok) {
    const upd = Date.parse(s.status.updatedAt ?? "");
    const mains = Object.values(s.status.mainBySession ?? {}).filter((m) => m && typeof m.model === "string" && Date.parse(m.t) > nowMs - MAIN_TTL_MS)
      .sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
    if (Number.isFinite(upd) && nowMs - upd < STATUS_FRESH_MS && mains.length) return { provider: providerOf(mains[0].model), source: "learned main (live status)", others: [...new Set(mains.slice(1).map((m) => providerOf(m.model)))] };
  }
  if (g.defaultModel) return { provider: providerOf(stripOneM(g.defaultModel)), source: "likely main (default model)", others: [] };
  return { provider: null, source: "unknown", others: [] };
}

/** A provider's substitutable count as an OWN read: a provider (or learned main) named constructor or __proto__ must not read a prototype member. */
const subOf = (res, p) => (Object.hasOwn(res.substitutable, p) ? res.substitutable[p] : 0);

/** A provider's key tier: the registry map first, else the tier the funnel gave its rows (the relay's is by provenance, not by registry). */
function providerTier(g, prov, res = null) {
  if (!prov) return null;
  const t = g.funnelInputs.tiers;
  if (t && Object.hasOwn(t, prov)) return t[prov];
  const r = res ?? funnel(g.funnelInputs, { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [] });
  for (const x of r.groups.values()) if (x.provider === prov && x.tier) return x.tier;
  return null;
}
const providerCount = (models) => new Set(models.map((r) => providerOf(r.s))).size;
/** The `set` command that would save `owner` (the equivalent flags a preview, the wizard and the E_EMPTY cures print). `--live yes` only where a real file is written. */
export function setCommand(owner, { live = false } = {}) {
  const f = [];
  if (owner.mode !== "inherit") f.push(`--source ${owner.source}`);
  f.push(`--mode ${owner.mode}`);
  if (owner.mode === "free") f.push(`--free-scope ${owner.freeScope}`);
  f.push(`--ctx ${owner.ctx}`);
  if (owner.enforcement !== "shadow") f.push(`--enforce ${owner.enforcement}`);
  if (owner.inject !== "off") f.push(`--inject ${owner.inject}`);
  if (owner.unverified !== "allow-warn") f.push(`--unverified ${owner.unverified}`);
  if (owner.banded === false) f.push("--banded no");
  if (owner.handoffNotice === false) f.push("--handoff-notice no");
  for (const a of owner.allow ?? []) f.push(`--allow ${a}`);
  return `${CLI} set ${f.join(" ")}${live ? " --live yes" : ""}`;
}
const CURE_CLAUSE = {
  "source": "subagents may then run on models of any provider",
  "free-scope": (s) => `the list becomes ${SCOPE_NAMES[s]}`,
  "mode": "any model, paid ones included, so cost is no longer limited to free",
  "ctx": (c) => `drops the ${ctxLabel(c)}-context floor`,
};

/** Exit-2 refusal: the first line stays `E_EMPTY: ...; nothing written`, then WHY it is empty and runnable cures (Fix A, Fix B) with the consequence of each (R2, D-c; plan 7.2 item 5). */
function refusal(g, owner, res, main, why, fixture = false) {
  const prov = why === "main" ? main.provider : null;
  const st = emptyStage(res, prov);
  const lines = [];
  const alts = [];
  // the count a flag change would give: main's provider under same-provider (rule b), the whole pool otherwise
  const countOf = (r, patch) => (prov && (patch.source ?? owner.source) === "same-provider" ? subOf(r, prov) : r.substitutable["*"]);
  const tryToggle = (key, patch, clause) => {
    const r = funnel({ ...g.funnelInputs }, { ...res.toggles, ...patch });
    if (!r.refuse) alts.push({ key, patch, n: countOf(r, patch), clause });
  };
  if (owner.source === "same-provider") tryToggle("source", { source: "all-providers" }, CURE_CLAUSE.source);
  if (owner.mode === "free") {
    for (const s of FREE_SCOPES) if (s !== owner.freeScope) tryToggle("free-scope", { freeScope: s }, CURE_CLAUSE["free-scope"](s));
    tryToggle("mode", { mode: "dynamic" }, CURE_CLAUSE.mode);
  }
  if (ctxSpec(owner.ctx).hard > 0) tryToggle("ctx", { ctx: "any" }, CURE_CLAUSE.ctx(owner.ctx));
  const good = alts.filter((a) => a.n > 0).sort((a, b) => b.n - a.n);
  const scope = owner.mode === "free" ? ` under ${SCOPE_NAMES[owner.freeScope]}` : "";
  const subject = prov ? `${prov}'s candidates (main provider, ${main.source})` : "all candidates";
  lines.push(`E_EMPTY: ${st ? `${st.text} removed all ${st.before} of ${subject}${scope}` : `no substitute pool for ${subject}${scope}`}; nothing written`);
  const tier = providerTier(g, prov, res);
  lines.push(`why: ${owner.mode === "free" && tier && freeScopeOf(tier) === null
    ? `${prov} is a ${tier} route${tier === RELAY_TIER ? " (a flat-rate relay)" : ""}, and ${tier} routes are in no free scope, so mode free leaves it no model to hand its subagents to`
    : st ? `${st.text} left none of the ${st.before} candidates` : "no candidate has a known context of at least 128,000"}`);
  const letters = ["A", "B"];
  good.slice(0, 2).forEach((a, i) => {
    const cmd = setCommand({ ...owner, ...a.patch }, { live: !fixture });
    lines.push(`Fix ${letters[i]}: ${cmd}   (${typeof a.clause === "function" ? a.clause(a.patch.freeScope) : a.clause}; ${a.n} usable models; this saves it)`);
  });
  if (!good.length) lines.push("Fix: no single change gives a usable model; pick a ready-made choice with `" + `${CLI} preset` + "`, or save it empty on purpose with `--allow-empty yes` (the router then serves each subagent the model it ASKED for)");
  else lines.push("Or save it empty on purpose with `--allow-empty yes`: every subagent then runs the model it ASKED for.");
  for (const o of main.others ?? []) if (subOf(res, o) === 0) lines.push(`WARNING: another learned main provider ${o} also has an empty substitute pool`);
  lines.push("Nothing was written.");
  return new PolicyError("E_EMPTY", lines.join("\n"), 2);
}

// ------------------------------------------------------------------ report
const n = (v) => Number(v).toLocaleString("en-US");
const dots = (label, w = 34) => `${label} ${".".repeat(Math.max(2, w - label.length))}`;

/** Both free counts of a free policy, from the live funnel (the narrow set and the wide set are both always shown, whichever the policy picked). */
function freeSetsLine(res) {
  const c = res.counts, f = c.freeScopes ?? {};
  const wide = f.providers?.unavailable ? "an unknown number of (the key registry is unreadable) models" : `${n(f.providers?.n ?? 0)} ${f.providers?.n === 1 ? "model" : "models"}`;
  return `free sets: ${n(f.models?.n ?? 0)} ${f.models?.n === 1 ? "model" : "models"} tagged free; ${wide} on free-labelled providers (both of ${n(c.toolsPass)} tool-eligible models)`;
}

/** Rows per context floor (D-bk), each with its denominator, so a floor is chosen knowingly: measured contexts only; the unknown rows are in none of the floors. */
export function ctxFloorsCompact(st) {
  return st ? `context: of ${n(st.rows)} rows, ${n(st.unknown)} unknown; known ${Object.entries(st.ge).map(([k, v]) => `>= ${ctxLabel(k)} ${n(v)}`).join(", ")}` : null;
}
export function ctxFloorsLine(st, ctx = "any") {
  if (!st) return "CONTEXT FLOORS: unavailable";
  const ge = Object.entries(st.ge).map(([k, v]) => `>= ${ctxLabel(k)} ${n(v)}`).join(", ");
  return `CONTEXT FLOORS: of ${n(st.rows)} rows in the chosen scope, ${n(st.unknown)} have no known ctx; known ctx ${ge}; ${n(st.inferred)} of the ${n(st.unknown)} unknown rows pass 128k on an inferred ctx (c?: a same-name sibling's context, a 128k floor-only prior, never the asked floor)${ctxSpec(ctx).hard > 0 ? `; ctx ${ctx} tests the measured ctx only, so those ${n(st.inferred)} are left out` : ""}`;
}
/** The honest state of the payload gate (sa-A1): a row with no known request-size limit (pb 0) is never held back for size, so the gate is inert for it until a limit is measured. */
export const payloadGateLine = (k) => (k && k.payloadUnknown > 0 && k.allowed > 0
  ? `payload limits: ${n(k.payloadUnknown)} of ${n(k.allowed)} eligible models have no known request-size limit, so the size check does nothing for them until a limit is measured (a tool test records one); live shadow: ${payloadSampleText()}` : null);
/** The two headline count lines of a non-inherit report (the default `set` output keeps exactly these; `--detail yes` adds the whole funnel). */
function allowedLines(res, minSet) {
  const c = res.counts, T = res.toggles;
  const free = T.mode === "free" ? [freeSetsLine(res)] : [];
  return [`ALLOWED: ${n(c.allowed)} ${c.allowed === 1 ? "model" : "models"} (of ${n(c.chosenScopeN)} in the chosen scope${ctxSpec(T.ctx).hard > 0 ? `, after the ctx ${T.ctx} filter` : ctxSpec(T.ctx).prefer > 0 ? `, ctx ${T.ctx}: rows of at least ${ctxLabel(T.ctx.slice(7))} form the higher band` : ""}; verified ${c.verified}, small ${c.small}, unverified ${c.unverified})`,
    `SUBSTITUTABLE: ${n(c.substitutable)} of ${n(c.allowed)} allowed (known ctx >= ${n(SUBSTITUTE_FLOOR)}${c.ctxInferred ? `; ${n(c.ctxInferred)} of the ${n(c.allowed)} pass the floor on an inferred ctx` : ""}); providers with substitutable < ${minSet ?? DEFAULT_MIN_SET}: ${Object.keys(res.substitutable).filter((p) => p !== "*" && res.substitutable[p] < (minSet ?? DEFAULT_MIN_SET)).sort().join(", ") || "(none)"}`, ctxFloorsLine(res.ctxStats, T.ctx), ...free];
}

export function formatReport({ owner, res, g, header, dry, minSet }) {
  const c = res.counts, T = res.toggles;
  const L = [];
  L.push(`subagent policy${dry ? " (DRY)" : ""}: source=${T.mode === "inherit" ? `${T.source} (ignored under inherit)` : T.source} mode=${T.mode}${T.mode === "free" ? ` free-scope=${T.freeScope} (${SCOPE_NAMES[T.freeScope]})` : ""} ctx=${T.ctx} enforcement=${owner.enforcement} inject=${owner.inject}`);
  L.push(`funnel (denominator = ${n(c.universe)} snapshot routes, snapshot built ${g.stamps.snapshotBuiltAt ?? "?"}, schema ${g.stamps.snapshotSchema}; live Providers ${g.providersLive ? "read" : "NOT read (fallback)"}; stage 1 counts routes, later stages count distinct selectors after the [1m] collapse):`);
  L.push(`  ${dots("chat-capable, not pool row")} ${n(c.chatCapable)} of ${n(c.universe)} routes`);
  L.push(`  ${dots("in live Providers")} ${n(c.inProviders)} selectors (from ${n(c.routesInProviders)} routes)`);
  L.push(`  ${dots("id-rejected (cr-m3)")} ${n(c.idRejected)} of ${n(c.chatCapable)} chat-capable routes`);
  if (c.nonAgent) L.push(`  ${dots("non-agent ids")} ${n(c.nonAgent)} of ${n(c.chatCapable)} chat-capable routes (safety, guard, embed, rerank, ocr, lora, moderation or under 4B in the id; never candidates, never lend a ctx)`);
  if (c.oneMSpellingOnly) L.push(`  ${dots("only a [1m] spelling listed")} ${n(c.oneMSpellingOnly)} of ${n(c.chatCapable)} chat-capable routes (no wire id can name them; dropped)`);
  L.push(`  ${dots("bench ok (any age)")} ${n(c.benchOk)} of ${n(c.inProviders)} selectors`);
  L.push(`  ${dots("tools != false")} ${n(c.toolsPass)} of ${n(c.benchOk)} selectors`);
  if (c.knownBad) L.push(`  ${dots("known issue (seed)")} ${n(c.knownBad)} of ${n(c.benchOk)} probe-ok selectors excluded by a known issue until a real tool test says otherwise (explain names it)`);
  if (c.accountStateRows) L.push(`  ${dots("account state")} ${n(c.accountStateRows)} of ${n(c.inProviders)} selectors: free-tagged, dropped on a transient bench status whose stored message names your account (plan, key or balance), so a re-probe will not change it: ${res.accountRows.slice(0, 12).map((x) => `${x.s} (${x.why})`).join(", ")}${res.accountRows.length > 12 ? ` and ${res.accountRows.length - 12} more` : ""}`);
  if (c.reprobe) L.push(`  ${dots("re-probe (not dead)")} ${n(c.reprobe)} of ${n(c.inProviders)} selectors: free-tagged, dropped on a transient bench status of a sample older than 2 days: ${res.reprobe.slice(0, 12).map((x) => `${x.s} (${x.status}, ${x.ageDays} d)`).join(", ")}${res.reprobe.length > 12 ? ` and ${res.reprobe.length - 12} more` : ""}`);
  L.push("  free scopes (probe-ok selectors after the tools stage; tier from the vault registry, D-k):");
  for (const s of FREE_SCOPES) {
    const f = c.freeScopes[s];
    L.push(`    ${dots(SCOPE_NAMES[s], 32)} ${f.unavailable ? "unavailable (registry unreadable)" : `${n(f.n)} on ${n(f.providers)} providers (${n(f.ctx1m)} >= 1M)`}`);
  }
  // two definitions, each with its own denominator: the strict rule skips every untagged selector of the population; the `free
  // models` rule counts only those of them that carry a free badge or price 0 (the rows a weaker rule would have let in)
  const dsk = c.depositStrictSkipped;
  L.push(`    ${dots("deposit-strict-skipped", 32)} ${n(dsk["providers+deposit"])} of ${n(dsk.population)} probe-ok selectors on paid and deposit providers (free models rule: ${n(dsk.models)} of those ${n(dsk["providers+deposit"])} skipped rows are badge-labelled or price 0; listed by explain)`);
  L.push(`    ${dots("ALIAS (counted separately)", 32)} ${n(c.aliasProbeOk)} probe-ok pool aliases of ${n(c.benchOk)} probe-ok selectors; flagged ALIAS, never above tier u, ranked below non-alias at equal keys`);
  if (T.mode === "inherit") {
    L.push(`  ${dots("chosen mode")} inherit: no candidate lists; every non-exempt subagent gets main's exact model`);
    L.push(`exempt under inherit: ${res.exempt.join(", ") || "(none)"}`);
  } else {
    L.push(`  ${dots(`chosen scope: ${T.mode === "free" ? SCOPE_NAMES[T.freeScope] : "all probe-ok models"}`)} ${n(c.chosenScopeN)} of ${n(c.toolsPass)} selectors`);
    L.push(`  ${dots("ctx >= 1M in the chosen scope")} ${n(c.chosenScopeCtx1m)} of ${n(c.chosenScopeN)}`);
    L.push(...allowedLines(res, minSet), `emptyProviders: ${res.emptyProviders.join(", ") || "(none)"}; thinProviders: ${res.thinProviders.join(", ") || "(none)"}`);
  }
  for (const w of [...g.warnings, ...res.warnings]) L.push(w.text);
  L.push(HELPER_CALLS_NOTE);
  return L.join("\n");
}

// ------------------------------------------------------------------ commands
// Scope `free models` (plan section 7) never exits E_KEY_AMBIGUOUS: it applies the strict rule (free tag only) to a provider whose
// tier it cannot assign, with a warning. The provider scopes need the tier itself, so they keep the exit.
const ensureNoUnreadableTiers = (g, owner) => {
  if (owner.mode === "free" && g.funnelInputs.tiers !== null && g.tiersRes.ambiguous.length) {
    const a = g.tiersRes.ambiguous;
    if (owner.freeScope !== "models") {
      throw new PolicyError("E_KEY_AMBIGUOUS", `multi-key provider(s) with no deliberate choice, so no tier can be assigned: ${JSON.stringify(a)}; record one with: node keysync/key.mjs prefer <provider> <id>`, 4);
    }
    g.warnings.push({ code: "KEY_AMBIGUOUS", text: `KEY_AMBIGUOUS: ${a.length} provider(s) have several keys and no recorded choice, so no tier: ${a.map((x) => printable(x.provider, 40)).join(", ")}; scope free models applies the STRICT rule to them (free tag only)` });
  }
};

function mergeOwner(existing, flags, notes) {
  const base = existing ? { ...existing } : { ...OWNER_DEFAULTS };
  const first = !existing;
  const need = "the first `set` needs --source and --mode (no hidden defaults for the two toggles that change who serves work); --source is optional only with --mode inherit";
  if (first && !flags.mode) throw usage(need);
  if (first && !flags.source && flags.mode !== "inherit") {
    // A DRY first set may omit --source (the S1 acceptance commands do): it previews under all-providers and says so.
    // Writing still needs an explicit choice.
    if (!flags.dry) throw usage(need);
    base.source = "all-providers";
    notes.push("NOTE: no --source given on a first dry run: previewed as all-providers; a real first `set` needs --source");
  }
  const map = { source: "source", mode: "mode", "free-scope": "freeScope", ctx: "ctx", enforce: "enforcement", inject: "inject", unverified: "unverified", banded: "banded", "handoff-notice": "handoffNotice" };
  for (const [f, k] of Object.entries(map)) if (flags[f] !== undefined) base[k] = flags[f];
  if (flags.allow) base.allow = [...new Set([...(base.allow ?? []), ...flags.allow])];
  if (base.allow.length > ALLOW_MAX) throw usage(`too many --allow pins: ${base.allow.length} (limit ${ALLOW_MAX}); the owner file must stay under ${OWNER_MAX_BYTES} bytes`);
  if (flags["free-scope"] !== undefined && base.mode !== "free") throw usage("--free-scope is only valid with --mode free");
  return base;
}

export function checkEnforcePreconditions(p, g, owner, nowMs = Date.now()) {
  if (owner.enforcement !== "enforce") return;
  if (!g.providersLive) throw new PolicyError("E_PRECONDITION", "--enforce enforce needs live Providers (a gateway-down compile cannot prove resolvability)", 1);
  const acc = readJsonFile(path.join(p.stateDir, "accuracy.json"));
  const at = acc.ok ? Date.parse(acc.value?.at ?? "") : NaN;
  if (!acc.ok || acc.value?.verdict !== "PASS" || !Number.isFinite(at) || nowMs - at > ACCURACY_MAX_AGE_MS) {
    throw new PolicyError("E_PRECONDITION", "--enforce enforce is blocked: state/subagent/accuracy.json must hold a classifier verdict PASS younger than 30 days", 1);
  }
}

/** The one pause sentence (`PAUSED:` here, in the verdict and in undo): a runnable way out unless there is none that can succeed. */
const pausedLine = (resume = RESUME_COMMAND) => `PAUSED: Subagents run exactly as they asked, from the next request. Your toggles are kept.${resume ? ` To continue: ${resume}` : ""}`;
const prevOf = (p) => (p.policyFile ? `${p.policyFile}.prev` : null);
const pausedFromOf = (p) => path.join(p.stateDir, "paused-from.json");
/** The one `policy:` line of `set`, `status` and `show` (inject is a prompt-text switch, named only when it is on). */
const plainPolicy = (o) => `mode ${o.mode}${o.mode === "free" ? ` (${SCOPE_NAMES[o.freeScope]})` : ""}, ${o.mode === "inherit" ? "source ignored under inherit: every subagent gets main's exact model" : `source ${o.source}`}, ctx ${o.ctx}, enforcement ${o.enforcement}${o.inject === "on" ? ", inject on" : ""}`;
/** Providers with a model in the gateway's live provider list: the denominator of every provider count a delta prints. */
const providerTotalOf = (res) => new Set([...res.groups.values()].map((x) => x.provider)).size;
const togglesOf = (o) => ({ source: o.source, mode: o.mode, freeScope: o.freeScope, ctx: o.ctx, unverified: o.unverified, allow: o.allow });
const fmtCount = (v) => Number(v).toLocaleString("en-US");

/** {toggles, eligible, providers} of an owner file under the CURRENT inputs (the delta line compares what the old policy would give today with what the new one gives). */
function sideOf(g, owner, res = null, minSet) {
  try {
    const r = res ?? funnel({ ...g.funnelInputs, minSet }, togglesOf(owner));
    return owner.mode === "inherit" ? { toggles: owner, eligible: null, providers: null } : { toggles: owner, eligible: r.counts.allowed, providers: providerCount(r.models) };
  } catch { return { toggles: owner }; }
}

/** "$in/$out" display price -> the output price in USD per million tokens, or null. */
const outPrice = (i) => { const m = /\/\$?([\d.]+)$/.exec(String(i ?? "")); return m ? Number(m[1]) : null; };
// grammar of "N of M ...": the verb follows the FIRST number (1 of 2 providers has, 2 of 2 providers have)
const hasHave = (k) => (k === 1 ? "has" : "have");
const isAre = (k) => (k === 1 ? "is" : "are");
const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
/**
 * The advisories of one report collapsed into counted plain-words lines, each with a severity (D6): 1 = the router will not do what you expect (FREE NOT GUARANTEED,
 * no usable stand-in, THIN), 2 = cost or credit, 3 = tool-test status, 4 = informational. Returns [{sev, text}] in severity order (stable inside a severity).
 * "eligible" = passes your toggles; "usable" = a known context of at least 128,000, so it can stand in for a subagent. Each line carries its denominator; the raw lines stay behind --detail yes.
 */
export function attentionLines(res, g, owner, minSet = DEFAULT_MIN_SET) {
  const L = [], c = res.counts, T = res.toggles, inherit = T.mode === "inherit";
  const add = (sev, text) => L.push({ sev, text });
  const codes = new Set([...g.warnings, ...res.warnings].map((w) => w.code));
  const covered = new Set(["SOURCE_IGNORED", "UNVERIFIED", "PREMIUM", "PAYLOAD", "FRAGILE", "EMPTY_PROVIDERS", "FREE_PROMISE", "CREDIT", "FREE_PROVIDERS", "ACCOUNT_STATE", "INHERIT_PREMIUM_MAIN", "INHERIT_BELOW_CTX"]);
  if (!inherit) {
    const nm = res.models.length;
    if (c.unverified > 0) add(3, `${c.unverified} of ${nm} eligible models ${isAre(c.unverified)} not tool-tested (a subagent on one may fail when it uses tools)`);
    const sub = res.substitutable, setProv = [...new Set(res.models.map((r) => providerOf(r.s)))].sort();
    const thin = res.effectiveSource === "all-providers" ? (sub["*"] > 0 && sub["*"] < minSet ? [["all providers", sub["*"]]] : [])
      : setProv.filter((p) => sub[p] > 0 && sub[p] < minSet).map((p) => [p, sub[p]]);
    if (thin.length) add(1, `THIN: only ${thin.map(([p, k]) => `${plural(k, "usable model")} for ${p}`).join(", ")}; a fan-out of subagents lands on those few`);
    if (res.emptyProviders.length) {
      const k = res.emptyProviders.length;
      add(1, `${k} of ${setProv.length} providers ${hasHave(k)} eligible models but none usable as a stand-in (a known context of at least ${fmtCount(SUBSTITUTE_FLOOR)} is needed): ${res.emptyProviders.slice(0, 6).join(", ")}${k > 6 ? ` and ${k - 6} more` : ""}; their subagents run as they asked`);
    }
    if (T.mode === "free") {
      const fr = setProv.filter((p) => sub[p] < SUBSTITUTE_K).length;
      add(1, `FREE NOT GUARANTEED: ${fr} of ${setProv.length} providers ${hasHave(fr)} fewer than ${SUBSTITUTE_K} usable models; when no free model fits a request, the model it asked for (possibly paid) runs it`);
      if (c.creditPositive > 0) add(2, `${c.creditPositive} of ${nm} eligible models ${c.creditPositive === 1 ? "has" : "have"} a price; on a free key they use up credit faster than price-0 models`);
    }
    const dear = res.models.filter((r) => (outPrice(r.i) ?? 0) >= 15).length;
    if (dear > 0) add(2, `${dear} of ${nm} eligible models ${dear === 1 ? "costs" : "cost"} $15+/M output`);
    if (c.payloadRisk > 0) add(4, `${c.payloadRisk} of ${nm} eligible models ${c.payloadRisk === 1 ? "refuses" : "refuse"} requests over 1 MB (${c.payloadUnknown} more ${c.payloadUnknown === 1 ? "has" : "have"} no known limit)`);
  } else {
    for (const w of res.warnings) if (w.code === "INHERIT_PREMIUM_MAIN") add(2, "every subagent will run on main's model, and that model costs $15+/M output or is Opus- or Fable-class");
    for (const w of res.warnings) if (w.code === "INHERIT_BELOW_CTX") add(1, "the context floor is 1M but main's model is smaller; subagents inherit it anyway");
  }
  const a = c.accountState;
  if (a && a.pay + a.auth + a.rate > 0) add(4, `${a.pay + a.auth + a.rate} of ${c.inProviders} models in the gateway's provider list ${a.pay + a.auth + a.rate === 1 ? "is" : "are"} left out for account state (payment, key or rate limit); ${a.pay + a.auth + a.rate === 1 ? "it is" : "they are"} not removed from routing`);
  for (const code of codes) {
    if (covered.has(code)) continue;
    const row = codeRow(code);
    if (row) add(4, `${row.plain} [${code}]`);
  }
  return L.map((x, i) => ({ ...x, i })).sort((x, y) => x.sev - y.sev || x.i - y.i).map(({ sev, text }) => ({ sev, text }));
}

/** ` --live yes` where a real save is printed for a real path; a fixture run names its own files and needs none. */
const liveSfx = (p) => (p.fixture ? "" : " --live yes");
/** The one runnable way out of a pause (the printed command carries its own prefix and `--live yes`). */
const RESUME_COMMAND = `${CLI} resume --live yes`;

async function cmdSet(p, flags, io, opts = {}) {
  const existing = loadOwner(p.policyFile);
  const notes = [];
  const owner = mergeOwner(existing, flags, notes);
  validateOwner({ ...owner, schema: 1 });
  const g = await gatherInputs(p);
  ensureNoUnreadableTiers(g, owner);
  const { compiled, res } = compile(g, owner, { minSet: flags["min-set"] });
  if (res.refuse) throw new PolicyError("E_TIER_UNREADABLE", `E_TIER_UNREADABLE: ${res.refuse.text} (${g.tiersRes.reason ?? "unreadable"})`, 4);
  const lines = [];
  const main = mainProviderOf(p, g);
  let refused = null;
  if (owner.mode !== "inherit") {
    if (res.empty) refused = refusal(g, owner, res, main, "all", p.fixture);
    else if (owner.source === "same-provider" && main.provider && subOf(res, main.provider) === 0) refused = refusal(g, owner, res, main, "main", p.fixture);
  }
  if (refused && !flags["allow-empty"]) throw refused;
  checkEnforcePreconditions(p, g, owner);
  const sr = readStatus(p.statusFile), nowMs = opts.now ?? Date.now();
  const prev = readCompiled(p.compiledFile);
  const unchanged = prev.ok && sameCompiled(prev.value, compiled);
  const pausedNow = readFlag(p) !== false;
  // the state the saved policy would be in (a real set also lifts a pause). A PREVIEW is judged as if the router had picked it up (it is not compiled yet, so "waiting" would say nothing about the choice).
  // A real set judges the file as it will stand on disk: an unchanged compile is not rewritten, so the router's earlier report of it still counts.
  const v = flags.dry ? verdict(owner, compiled, { updatedAt: compiled.compiledAt, policy: { contentHash: compiled.contentHash } }, false, nowMs)
    : verdict(owner, unchanged ? prev.value : compiled, sr.ok ? sr.status : null, false, nowMs);
  const delta = deltaText(existing ? sideOf(g, existing, null, flags["min-set"]) : null, sideOf(g, owner, res), providerTotalOf(res));
  lines.push(flags.dry ? `PREVIEW (nothing is saved). ${verdictLine(v)}` : savedLine(v));
  if (flags.dry) { const hint = opts.saveHint === undefined ? `to save this: ${setCommand(owner, { live: !p.fixture })}` : opts.saveHint; if (hint) lines.push(hint); }
  else lines.push(fixLine(v));
  lines.push(`change: ${delta}`, `policy: ${plainPolicy(owner)}`);
  const att = attentionLines(res, g, owner, flags["min-set"] ?? DEFAULT_MIN_SET);
  if (flags.dry && pausedNow) lines.push("NOTE: the policy is paused now; saving it for real lifts the pause");
  if (owner.mode === "inherit" && !flags.detail) lines.push(`exempt under inherit: ${res.exempt.join(", ") || "(none)"}`);
  if (owner.mode !== "inherit" && !flags.detail) lines.push(...allowedLines(res, flags["min-set"]));
  // the top 3 by severity (D6): the router will not do what you expect, then cost or credit, then tool-test status, then information; --detail yes shows them all
  const shown = flags.detail ? att : att.slice(0, 3);
  lines.push(att.length ? `needs attention (${att.length}):` : "needs attention: nothing", ...shown.map((x) => `  - ${x.text}`));
  if (att.length > shown.length) lines.push(`  (+${att.length - shown.length} more: --detail yes)`);
  if (flags.detail) lines.push(formatReport({ owner, res, g, dry: !!flags.dry, minSet: flags["min-set"] }));
  else lines.push(HELPER_CALLS_NOTE, `more: add --detail yes for the whole funnel and every raw warning; \`${CLI} why <CODE>\` explains a code`);
  lines.push(...notes, ...ownerNotes(owner), ...routerVersionNote(p, compiled));
  if (refused) lines.push(`WARNING (--allow-empty yes): ${refused.message.split("\n")[0].replace(/; nothing written$/, "")}; saved anyway, the router will serve each subagent the model it ASKED for`);
  if (owner.mode !== "inherit" && owner.source === "same-provider") lines.push(`main provider for the refusal rule: ${main.provider ?? "unknown"} (${main.source})`);
  const changed = !prev.ok || prev.value.contentHash !== compiled.contentHash;                 // the hash is routing content only: the injected text rotates only when it changes
  if (owner.inject === "on" && changed) lines.push("NOTE: this policy changes prompt text; running sessions pay one prompt-cache miss");
  if (flags.dry) { for (const l of lines) io.out(l); return 0; }
  // the one previous generation `undo` goes back to: written atomically BEFORE the owner file changes, and only when the toggles really change (a repeated set keeps the real earlier one)
  if (p.policyFile && existing) {
    const same = (a, b) => JSON.stringify({ ...a, setAt: 0 }) === JSON.stringify({ ...b, setAt: 0 });
    if (!same(existing, owner)) writeFileRetry(prevOf(p), JSON.stringify(existing, null, 2) + "\n");
  }
  const before = pausedNow ? readJsonFile(pausedFromOf(p)) : null;
  const wasEnforce = before?.ok && isObject(before.value) && before.value.enforcement === "enforce";
  const saved = saveOwner(p.policyFile, owner);
  if (!unchanged) writeFileRetry(p.compiledFile, JSON.stringify(compiled) + "\n");
  else lines.push("compiled policy unchanged; not rewritten");
  try { fs.rmSync(p.flagFile, { force: true }); fs.rmSync(pausedFromOf(p), { force: true }); }                // a real `set` is the explicit act that lifts a pause
  catch (e) { lines.push(`WARNING: ${p.flagFile} could not be removed (${printable(e.code ?? e.message, 40)}): the router STAYS IN SHADOW (asked returned, stickiness bypassed) until that file is deleted`); }
  if (pausedNow && !opts.resumed) lines.push(`pause lifted; enforcement stays ${owner.enforcement}${wasEnforce && owner.enforcement !== "enforce" ? " (it was enforce before the pause)" : ""}`);
  lines.push(`saved: ${p.policyFile} (setAt ${saved.setAt}); compiled ${p.compiledFile} (contentHash ${compiled.contentHash})`);
  // a save that follows a preview already shown (the wizard) prints the outcome only: the verdict, the change and the policy, then what needs a word
  for (const l of lines.filter((x, i) => !opts.brief || i < 4 || /^(WARNING|NOTE:|pause lifted|saved:)/.test(x))) io.out(l);
  return 0;
}

/** Non-default router-behaviour switches are stated in the report; the defaults print nothing, so an unchanged report stays byte-identical. */
const ownerNotes = (owner) => [
  ...(owner.banded === false ? ["BANDED: off: the substitute spread ignores rank bands (the old behaviour); `set --banded yes` restores the banded spread"] : []),
  ...(owner.handoffNotice === false ? ["HANDOFF NOTICE: off: after a handoff the router adds no line to the subagent's system prompt (the handoff itself is still logged)"] : []),
];
/** A compiled file that needs a newer router than the one status.json says is running would be ignored by it (state `newer`): say so before the owner relies on it. */
function routerVersionNote(p, compiled) {
  const sr = readStatus(p.statusFile);
  const v = sr.ok ? sr.status.routerVersion : undefined;
  return Number.isInteger(v) && Number.isInteger(compiled.minRouter) && compiled.minRouter > v
    ? [`WARNING: this compiled policy needs router v${compiled.minRouter} but the running router reports v${v}: it will IGNORE the policy (POLICY_NEWER) and serve every model as asked until the router file is replaced`] : [];
}

/** `N of M`: how many of the providers behind a compiled copy's models are in a list (the denominator is the providers that have an eligible model). */
const providersOfCompiled = (c) => new Set((c.models ?? []).map((r) => providerOf(r.s))).size;
function describeCompiled(c, age, detail = false) {
  const o = c.owner, k = c.counts, a = k.allowed, P = providersOfCompiled(c);
  const lst = (arr) => (arr?.length ? arr.join(", ") : "none");
  const empties = c.emptyProviders ?? [], thin = c.thinProviders ?? [];
  return [`compiled: ${age} ago; ${fmtCount(a)} eligible ${a === 1 ? "model" : "models"} of ${fmtCount(k.universe)} snapshot routes (verified ${k.verified} of ${a}, small ${k.small ?? 0} of ${a}, unverified ${k.unverified} of ${a}, premium ${k.premium} of ${a}, alias ${k.alias ?? 0} of ${a})${c.empty ? "; EMPTY: no model is eligible" : ""}`,
    `  providers with no usable stand-in: ${lst(empties)} (${empties.length} of ${P}); thin, fewer than ${DEFAULT_MIN_SET} usable: ${lst(thin)} (${thin.length} of ${P})`,
    ...(k.ctxStats ? [`  ${ctxFloorsLine(k.ctxStats, o.ctx)}`] : []),
    ...(payloadGateLine(k) ? [`  ${payloadGateLine(k)}`] : []),
    ...(k.ctxInferred ? [`  ${k.ctxInferred} of ${a} eligible models pass the 128k floor on an inferred ctx (c?, a sibling's context)`] : []),
    ...(k.accountStateRows ? [`  ${k.accountStateRows} free-tagged models show an account state (their stored message names your plan, key or balance), not a pending re-probe${detail && Array.isArray(c.accountStateRows) ? `: ${c.accountStateRows.slice(0, 20).map((x) => `${printable(x.s, 100)} (${printable(x.why, 8)})`).join(", ")}${c.accountStateRows.length > 20 ? ` and ${c.accountStateRows.length - 20} more` : ""}` : " (--detail yes names them)"}`] : []),
    ...(k.reprobe ? [`  ${k.reprobe} free-tagged models wait for a re-probe (dropped on a transient bench status, not dead)${detail && Array.isArray(c.reprobe) ? `: ${c.reprobe.slice(0, 20).map((x) => `${printable(x.s, 100)} (${printable(x.status, 12)})`).join(", ")}${c.reprobe.length > 20 ? ` and ${c.reprobe.length - 20} more` : ""}` : " (--detail yes names them)"}`] : []),
    ...(detail ? [`  compiled ${c.compiledAt}, contentHash ${c.contentHash}, compiler ${c.builtFrom?.compiler}, providersLive ${c.builtFrom?.providersLive}`,
      "  free-scope funnel (probe-ok selectors after the tools stage, whatever scope is chosen):",
      ...FREE_SCOPES.map((s) => { const f = c.counts.freeScopes?.[s]; return `    ${dots(SCOPE_NAMES[s], 30)} ${!f || f.unavailable ? "unavailable" : `${f.n} on ${f.providers} providers`}`; }),
      `  owner in the compiled file: mode ${o.mode}, source ${o.source}, ctx ${o.ctx}, enforcement ${o.enforcement}, inject ${o.inject}${o.banded === undefined ? "" : `, banded ${o.banded}`}${o.handoffNotice === undefined ? "" : `, handoff notice ${o.handoffNotice}`}${c.minRouter === undefined ? "" : `; needs router v${c.minRouter}`}`] : [])];
}
export const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`; };
/** Content of shadow.flag as the verdict wants it: false when absent, else the text (or true when it cannot be read). */
function readFlag(p) {
  if (!fs.existsSync(p.flagFile)) return false;
  try { return fs.readFileSync(p.flagFile, "utf8").trim() || true; } catch { return true; }
}
/** The previous owner generation `undo` would restore, or null (absent, unreadable or invalid: show never fails because of it). */
function readPrev(p) {
  const f = prevOf(p);
  if (!f) return null;
  try { return loadOwner(f); } catch { return null; }
}
/** The plain-words warning lines of a status (one line each: the plain wording and the fix, both from the one code table). */
const warningLines = (warnings, indent = "") => (Array.isArray(warnings) ? warnings : []).filter(isObject).flatMap((w) => {
  const row = codeRow(String(w.code));
  const code = printable(w.code, 40);
  return row ? [`${indent}${code}: ${row.plain}${w.detail ? ` (${printable(w.detail, 120)})` : ""}`, `${indent}  fix: ${row.fix}${row.fixNote ? ` (${row.fixNote})` : ""}`]
    : [`${indent}${code}: a code this version does not know${w.detail ? ` (${printable(w.detail, 120)})` : ""}; \`${CLI} why\` lists the known ones`];
});

async function cmdShow(p, flags, io, opts = {}) {
  const owner = loadOwner(p.policyFile);
  const L = [];
  const flagContent = readFlag(p);
  const flag = flagContent !== false;
  const cr = readCompiled(p.compiledFile, { retry: true });
  const sr = readStatus(p.statusFile);
  const nowMs = opts.now ?? Date.now();
  const v = verdict(owner, cr.ok ? cr.value : null, sr.ok ? sr.status : null, flagContent, nowMs);
  L.push(verdictLine(v), fixLine(v));
  const prevOwner = owner ? readPrev(p) : null;
  if (prevOwner) L.push(`last change (\`${CLI} undo --live yes\` goes back): ${deltaText({ toggles: prevOwner }, { toggles: owner })}`);
  if (!owner) L.push(`policy off: no owner file at ${p.policyFile} (the router behaves exactly as before)`);
  else {
    L.push(`policy: ${plainPolicy(owner)}`);
    if (flags.detail) L.push(`  owner file ${p.policyFile}: unverified=${owner.unverified} allow=${owner.allow.length} inject=${owner.inject} setAt=${owner.setAt ?? "?"}`);
  }
  if (flag) {
    // the router's tripwire writes `auto:<code>:<iso>` into the same file `rollback` writes (router v2); a hand-written or CLI flag holds a timestamp
    const auto = /^auto:([A-Z_]{1,40}):(\S{1,40})/.exec(typeof flagContent === "string" ? flagContent : "");
    L.push(auto ? `AUTO-ROLLBACK (${auto[1]} at ${printable(auto[2], 40)}): the router paused itself and returns every model as asked; only an explicit \`set\` or \`resume\` clears it`
      : "ROLLBACK FLAG PRESENT: shadow.flag exists, the router acts as shadow (asked returned, stickiness bypassed) until `set` clears it");
  }
  let compiled = null;
  if (!cr.ok && cr.reason === "schema") throw new PolicyError("E_COMPILED_CORRUPT", "compiled policy file " + p.compiledFile + " is valid JSON but not a compiled policy (torn or hostile); the router ignores it: run `rebuild` or `set`", 4);
  if (!cr.ok) L.push(cr.reason === "missing" ? `compiled policy: none at ${p.compiledFile}${owner ? " (run `rebuild` or `set`: policy not applied)" : ""}` : `compiled policy unreadable (${cr.reason})`);
  else {
    compiled = cr.value;
    const t = Date.parse(compiled.compiledAt ?? "");
    L.push(...describeCompiled(compiled, Number.isFinite(t) ? ago(Date.now() - t) : "?", !!flags.detail));
    if (owner && ownerDiffers(owner, compiled)) L.push("STALE: the owner file differs from the compiled file: policy not applied (run `rebuild`)");
    if (isObject(compiled.gate) && typeof compiled.gate.text === "string") L.push(printable(compiled.gate.text, 400));
    if (compiled.counts.unverified > 0) L.push(`${compiled.counts.unverified} of ${compiled.counts.allowed} eligible models ${isAre(compiled.counts.unverified)} not tool-tested (a subagent on one may fail when it uses tools)`);
    if (compiled.owner.mode === "inherit") {
      const likely = (() => { try { return loadDefaultModel(p.defaultModelFile)?.model ?? null; } catch { return null; } })();
      const row = likely ? compiled.models.find((r) => r.s === stripOneM(likely)) : null;
      if (row?.p) L.push(`INHERIT PREMIUM MAIN: the likely main ${stripOneM(likely)} is Opus- or Fable-priced (${row.i})`);
    }
  }
  if (!sr.ok) L.push(sr.reason === "missing" ? "status: no status.json yet (the router has not run with a policy)" : `status unreadable right now (${sr.reason})`);
  else {
    const s = sr.status, cn = isObject(s.counters) ? s.counters : {};
    const upd = Date.parse(s.updatedAt ?? "");
    const rq = cn.req ?? 0, sb = cn.sub ?? 0;
    L.push(`status: router last seen ${printable(s.updatedAt ?? "?", 40)}${Number.isFinite(upd) ? ` (${ago(nowMs - upd)} ago)` : ""}; ${rq} requests: main ${cn.main ?? 0}, sub ${sb}, aux ${cn.aux ?? 0}; ${cn.substitute ?? 0} of ${sb} sub requests moved to another model; ${cn.error ?? 0} of ${rq} requests hit an internal error`);
    // everything below was written by the router from client-controlled strings: control characters never reach the terminal
    // the router's own headline, unless it repeats the verdict or contradicts the compiled copy (its hash leaves enforcement out, so the two can disagree)
    if (isObject(s.policy) && typeof s.policy.headline === "string" && (!compiled || s.policy.enforcement === compiled.owner.enforcement) && printable(s.policy.headline, 200) !== v.sentence) L.push(`  ${printable(s.policy.headline, 200)}`);
    if (Number.isInteger(s.workers) && s.workers > 1) L.push(`  (merged over ${s.workers} router worker status files)`);
    if (flags.detail && isObject(s.policy)) L.push(`  router effective mode: enforcement ${printable(s.policy.enforcement ?? "?", 20)}, inject ${printable(s.policy.inject ?? "?", 20)}${s.policy.rollbackFlag ? ", rollback flag set (acts as shadow)" : ""}; policy ${printable(s.policy.state ?? "?", 20)}`);
    for (const w of Array.isArray(s.warnings) ? s.warnings : []) if (isObject(w)) L.push(`  router warning ${printable(w.code, 40)}${w.detail ? `: ${printable(w.detail)}` : ""}`);
    for (const [sid, m] of Object.entries(isObject(s.mainBySession) ? s.mainBySession : {})) if (isObject(m)) L.push(`  main of session ${printable(sid, 16)}: ${printable(m.model)}`);
  }
  L.push(HELPER_CALLS_NOTE, ROLLOUT_NOTE);
  for (const l of L) io.out(l);
  return 0;
}

/** `status`: the verdict, its one fix, then the policy, the compiled copy and what the router last reported (about five lines; QB-6: any state is answered by this one command). */
async function cmdStatus(p, flags, io, opts = {}) {
  let owner;
  try { owner = loadOwner(p.policyFile); }
  catch (e) {
    // a saved policy that cannot be read is a state `status` reports (exit 4), not a crash; `show` keeps its loud error
    if (!(e instanceof PolicyError) || e.code !== "E_OWNER_CORRUPT") throw e;
    const cv = corruptVerdict();
    for (const l of [verdictLine(cv), fixLine(cv), `detail: ${printable(e.message.split("\n")[0], 300)}`]) io.out(l);
    return e.exit;
  }
  const flagContent = readFlag(p);
  const cr = readCompiled(p.compiledFile, { retry: true });
  const sr = readStatus(p.statusFile);
  const nowMs = opts.now ?? Date.now();
  const compiled = cr.ok ? cr.value : null;
  const status = sr.ok ? sr.status : null;
  const v = verdict(owner, compiled, status, flagContent, nowMs);
  const L = [verdictLine(v), fixLine(v)];
  if (owner) L.push(`policy: ${plainPolicy(owner)}`);
  if (compiled) {
    const t = Date.parse(compiled.compiledAt ?? "");
    L.push(`compiled: ${Number.isFinite(t) ? `${ago(nowMs - t)} ago` : "time unknown"}, ${compiled.counts.allowed} eligible ${compiled.counts.allowed === 1 ? "model" : "models"} of ${compiled.counts.universe} snapshot routes (${compiled.counts.unverified} of ${compiled.counts.allowed} not tool-tested)`);
    const pg = payloadGateLine(compiled.counts);
    if (pg) L.push(pg);
  } else if (!cr.ok && cr.reason !== "missing") L.push(`compiled policy: unreadable (${cr.reason})`);
  if (status) {
    const cn = isObject(status.counters) ? status.counters : {};
    const upd = Date.parse(status.updatedAt ?? "");
    L.push(`router: last seen ${Number.isFinite(upd) ? `${ago(nowMs - upd)} ago` : "at an unknown time"}; ${cn.sub ?? 0} subagent requests of ${cn.req ?? 0} requests since ${printable(status.since ?? "?", 40)}`);
    if (v.state === "WAITING") L.push("  (this report predates your latest save, or comes from a router still on the older copy: the router uses the new one from its next request)");
    L.push(...warningLines(status.warnings, "warning "));
  } else L.push(sr.reason === "missing" ? "router: no status file yet (it has not run with a policy)" : `router: status unreadable right now (${sr.reason})`);
  for (const l of L) io.out(l);
  return 0;
}

// ------------------------------------------------------------------ last (plan 7.2 item 2)
const LOG_FILES = ["agents.3.jsonl", "agents.2.jsonl", "agents.1.jsonl", "agents.jsonl"];       // oldest first: the current file plus three rotated generations
const LOG_READ_MAX = 4 * 1024 * 1024;
/** Reads the agent decision log and its rotated files; a torn or non-object line is skipped and counted, never fatal. */
export const CLASS_FILES = ["classify.1.jsonl", "classify.jsonl"];                                // the classifier log (one line per classified request) and its one rotated generation
export function readAgentLog(stateDir, names = LOG_FILES) {
  const lines = [];
  let unreadable = 0, files = 0;
  for (const name of names) {
    let text;
    try {
      const f = path.join(stateDir, name), st = fs.statSync(f);
      if (!st.isFile()) continue;
      if (st.size > LOG_READ_MAX) {                               // bounded: only the tail of an oversized file, and its first (partial) line is dropped
        const fd = fs.openSync(f, "r");
        try { const b = Buffer.alloc(LOG_READ_MAX); fs.readSync(fd, b, 0, LOG_READ_MAX, st.size - LOG_READ_MAX); text = b.toString("utf8").replace(/^[^\n]*\n/, ""); } finally { fs.closeSync(fd); }
      } else text = fs.readFileSync(f, "utf8");
    } catch { continue; }
    files += 1;
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let o;
      try { o = JSON.parse(raw); } catch { unreadable += 1; continue; }
      if (!isObject(o) || typeof o.t !== "string" || !Number.isFinite(Date.parse(o.t))) { unreadable += 1; continue; }
      lines.push(o);
    }
  }
  lines.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));        // rotated generations are older, but a clock step must not scramble the list
  return { lines, unreadable, files };
}
export const UNITS = { m: 60000, h: 3600000, d: 86400000 };
export const sinceMs = (v) => Number(v.slice(0, -1)) * UNITS[v.slice(-1)];
const sel = (v) => printable(v ?? "", 160);
/** One agents.jsonl line (the router's v2 line: no role and no sticky marker, those live in decisions.jsonl) as a stable record of plain fields. */
function lastRecord(o) {
  const handoff = o.act === "handoff";
  const asked = o.asked == null ? null : sel(o.asked);
  const ran = o.ret == null ? asked : sel(o.ret);
  const would = o.would == null ? null : sel(o.would);
  const enforcing = o.pol === "enforce";
  const moved = handoff ? null : enforcing ? (ran !== null && asked !== null && ran !== asked) : (would !== null && asked !== null && would !== asked);
  return { t: new Date(Date.parse(o.t)).toISOString(), sid: sel(o.sid ?? "").slice(0, 16), aid: o.aid == null ? null : sel(o.aid), act: sel(o.act ?? "?").slice(0, 32), asked, ran, would,
    why: o.why == null ? null : sel(o.why).slice(0, 120), flags: (Array.isArray(o.flags) ? o.flags : []).filter((x) => typeof x === "string").map((x) => sel(x).slice(0, 40)).slice(0, 8),
    handoff: handoff ? formatHandoff(o) : null, from: handoff ? sel(o.from ?? "?") : null, to: handoff ? sel(o.to ?? o.ret ?? "?") : null, hop: handoff && Number.isInteger(o.hop) ? o.hop : null, moved, mode: enforcing ? "enforce" : o.pol === "shadow" ? "shadow" : null, path: o.path == null ? null : sel(o.path).slice(0, 16) };
}
const pad2 = (v) => String(v).padStart(2, "0");
/** Local time of a log line plus how long ago it was (the UTC ISO time is in --json only): `2026-10-05 13:30:00 (30m ago)`. */
export const localWhen = (iso, nowMs) => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} (${ago(nowMs - d.getTime())} ago)`; };
function lastText(r, nowMs) {
  const when = localWhen(r.t, nowMs);
  const tail = r.flags.length ? `  [${r.flags.join("; ")}]` : "";
  if (r.handoff) return `${when}  ${r.handoff}${r.mode ? ` (${r.mode})` : ""}${tail}`;
  const verb = r.mode === "enforce" ? "policy chose" : r.mode === "shadow" ? "policy would use" : "policy says";
  const pol = r.would === null ? (r.why ? `no policy choice (${r.why})` : "no policy choice") : r.would === r.asked ? "policy agrees" : `${verb} ${r.would}`;
  return `${when}  asked ${r.asked ?? "?"}  ran ${r.ran ?? "?"}  ${pol}${r.why && r.would !== null ? `  because ${r.why}` : ""}${tail}`;
}
export const tally = (vals) => { const m = new Map(); for (const v of vals) m.set(v, (m.get(v) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); };
export const provOf = (s) => (s ? providerOf(stripOneM(s)) : "?");

async function cmdLast(p, flags, io, target, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const limit = target ? Number(target) : 20;
  const sinceT = flags.since ? nowMs - sinceMs(flags.since) : null;
  const { lines: all, unreadable, files } = readAgentLog(p.stateDir);
  const inWin = sinceT === null ? all : all.filter((o) => Date.parse(o.t) >= sinceT);
  const recs = inWin.slice(-limit).map(lastRecord);
  const real = recs.filter((r) => r.handoff === null);
  const sessions = new Set(inWin.map((o) => printable(o.sid ?? "", 64)));
  const moved = real.filter((r) => r.moved === true).length;
  const den = { agentLines: inWin.length, shown: recs.length, sessions: sessions.size, unreadableLines: unreadable, filesRead: files };
  if (flags.json) {
    io.out(JSON.stringify({ schema: 1, kind: "last", window: { since: sinceT === null ? null : new Date(sinceT).toISOString(), until: new Date(nowMs).toISOString(), limit },
      denominators: den, lines: recs.map((r) => ({ t: r.t, sid: r.sid, aid: r.aid, act: r.act, asked: r.asked, ran: r.ran, would: r.would, why: r.why, flags: r.flags,
        handoff: r.handoff, from: r.from, to: r.to, hop: r.hop, moved: r.moved, mode: r.mode, path: r.path })) }));
    return 0;
  }
  if (!recs.length) {
    io.out(`no agent decisions to show${sinceT === null ? "" : ` in the last ${flags.since}`} (read ${files} log file(s) in ${p.stateDir}; ${all.length} decisions in all, ${unreadable} unreadable lines skipped). The router writes one line per new subagent once a policy is compiled.`);
    return 0;
  }
  io.out(`last ${recs.length} of ${inWin.length} agent decisions${sinceT === null ? "" : ` in the last ${flags.since}`}:`);
  for (const r of recs) io.out(lastText(r, nowMs));
  const ranOn = tally(real.map((r) => provOf(r.ran))), wouldOn = tally(real.filter((r) => r.would !== null).map((r) => provOf(r.would)));
  const fmtT = (t) => t.map(([k, v]) => `${k} ${v}`).join(", ");
  io.out(`summary (of ${real.length} decisions shown${recs.length - real.length ? `, plus ${recs.length - real.length} handoff${recs.length - real.length === 1 ? "" : "s"}` : ""}; ${den.sessions} sessions in the window; ${unreadable} unreadable lines skipped):`);
  io.out(`  ran on: ${fmtT(ranOn) || "(none)"} (of ${real.length})`);
  io.out(`  policy would use / chose: ${fmtT(wouldOn) || "(none)"} (of ${wouldOn.reduce((a, [, v]) => a + v, 0)} with a policy choice)`);
  io.out(`  moved to another model: ${moved} of ${real.length}; unchanged: ${real.length - moved} of ${real.length}${real.some((r) => r.mode === "shadow") ? " (shadow mode only logs: nothing was actually changed)" : ""}`);
  io.out("  note: Claude Code's transcript shows the model that was REQUESTED, not the one that served the request; this list shows what the router returned.");
  return 0;
}

async function cmdClear(p, flags, io) {
  const rm = (f) => { try { fs.rmSync(f, { force: true }); return true; } catch (e) { throw new PolicyError("E_WRITE", `cannot remove ${f}: ${e?.code}`, 5); } };
  // An owner file path the caller NAMED must parse as an owner file before it is removed: `--policy-file` pointing at some other
  // file is refused, not deleted. The DEFAULT owner file is removed as it stands (a corrupt one is exactly what `clear` repairs),
  // and with no owner path at all (--state-dir alone) there is no owner file to touch.
  if (p.policyFile && p.policyFile !== OWNER_FILE) {
    try { loadOwner(p.policyFile); }
    catch (e) {
      if (e instanceof PolicyError) throw new PolicyError("E_USAGE", `refusing to remove ${p.policyFile}: it does not parse as an owner policy file (${e.message.replace(/^owner policy file is invalid: /, "")}); delete it by hand if that is really what you want`, 1);
      throw e;
    }
  }
  // the one generation `undo` goes back to: the owner file as it stands, kept before it is removed (only when it parses: a corrupt file is not worth restoring)
  let kept = false;
  if (p.policyFile) { try { const was = loadOwner(p.policyFile); if (was) { writeFileRetry(prevOf(p), JSON.stringify(was, null, 2) + "\n"); kept = true; } } catch { /* corrupt or unreadable: nothing to keep */ } }
  if (p.policyFile) rm(p.policyFile);
  rm(p.compiledFile); rm(p.flagFile); rm(pausedFromOf(p));
  let k = 0, o = 0;
  try {
    for (const f of fs.readdirSync(p.stateDir)) {
      if (/^(main|agents)-[A-Za-z0-9_-]{1,64}\.(json|jsonl)$/.test(f)) { rm(path.join(p.stateDir, f)); k += 1; }
      else if (f === "cooling.json" || /^status-[0-9a-z]{1,13}\.json$/.test(f)) { rm(path.join(p.stateDir, f)); o += 1; }       // the cooling state and the per-worker status files (a live worker writes its own again)
    }
  } catch { /* no state dir */ }
  io.out(`cleared ${p.policyFile ? "the owner file" : "(no owner file named: it was left alone)"}, the compiled file, shadow.flag, ${k} session file(s) and ${o} cooling or worker status file(s); the router reverts to exact legacy behaviour on its next request`);
  if (kept) io.out(`undo: your policy was kept one step back; \`${CLI} undo --live yes\` brings it back`);
  return 0;
}

/** `rollback` and its alias `pause`: the compile-free flip. Also remembers what to come back to, so `resume` restores enforcement only if it was on. */
async function cmdRollback(p, flags, io, name = "rollback") {
  const wasPaused = fs.existsSync(p.flagFile);
  writeFileRetry(p.flagFile, `${new Date().toISOString()}\n`);       // the flag first: it IS the flip, and it needs no input
  let flipped = false, corrupt = null, remembered = true;
  if (p.policyFile) {
    try {
      const owner = loadOwner(p.policyFile);
      if (owner) {
        // a second pause over a pause keeps the first record (the real enforcement to come back to); a failure to remember never blocks the emergency flip
        if (!wasPaused || !fs.existsSync(pausedFromOf(p))) {
          try { writeFileRetry(pausedFromOf(p), JSON.stringify({ at: new Date().toISOString(), enforcement: owner.enforcement, inject: owner.inject }) + "\n"); } catch { remembered = false; }
        }
        saveOwner(p.policyFile, { ...owner, enforcement: "shadow", inject: "off" }); flipped = true;
      }
    } catch (e) { if (e instanceof PolicyError && e.code === "E_OWNER_CORRUPT") corrupt = e; else throw e; }
  }
  const what = !p.policyFile ? " (no owner file: nothing else created)" : corrupt ? " (the owner file could NOT be changed, see below)"
    : flipped ? " and set enforcement=shadow inject=off in the owner file" : " (no owner file: nothing else created)";
  io.out(pausedLine());
  io.out(`${name}: wrote ${p.flagFile}${what}; the router acts as shadow from its next request. \`set\` clears the flag.`);
  if (!remembered) io.out("note: the previous enforcement could not be recorded; `resume` will use what the owner file says now");
  if (corrupt) {
    io.err(`${corrupt.code}: ${corrupt.message}`);
    io.err("the flag IS set and the router acts as shadow; the owner file was left as it is: repair it, or run clear");
    return corrupt.exit;
  }
  return 0;
}

/**
 * `resume`: lifts the pause (an explicit pause or the router's own AUTO_ROLLBACK) and puts enforcement back to what it was when paused, through the SAME `set` path
 * as `set --enforce enforce`, so an unmet gate refuses it and the pause stays (it never bypasses a precondition). A pause that held shadow resumes to shadow.
 */
async function cmdResume(p, flags, io, opts = {}) {
  const flagContent = readFlag(p);
  const r = readJsonFile(pausedFromOf(p));
  const rec = r.ok && isObject(r.value) ? r.value : null;
  const owner = loadOwner(p.policyFile);
  if (flagContent === false && !rec) { io.out("Not paused: nothing to resume."); return 0; }
  if (!owner) {
    try { fs.rmSync(p.flagFile, { force: true }); fs.rmSync(pausedFromOf(p), { force: true }); } catch (e) { throw new PolicyError("E_WRITE", `cannot remove ${p.flagFile}: ${e?.code}`, 5); }
    io.out(`PAUSE LIFTED. No policy is saved, so subagents run exactly as they ask. \`${CLI} preset\` lists the ready-made choices.`);
    return 0;
  }
  const enforce = ENUMS.enforce.includes(rec?.enforcement) ? rec.enforcement : owner.enforcement;
  const inject = ENUMS.inject.includes(rec?.inject) ? rec.inject : owner.inject;
  const buf = [];
  await cmdSet(p, { enforce, inject, "min-set": flags["min-set"] }, { out: (l) => buf.push(l), err: io.err }, { ...opts, resumed: true });     // a refusal throws here, before anything is written and before any text is printed
  io.out(`RESUMED. The pause is lifted and enforcement is back to ${enforce} (checked like \`set --enforce enforce\`).`);
  for (const l of buf) io.out(l);
  return 0;
}

/** `undo`: restores the one previous owner generation (`.prev`), recompiles it, and falls back to a pause when it cannot be applied. */
async function cmdUndo(p, flags, io, opts = {}) {
  const prevFile = prevOf(p);
  if (!prevFile) throw usage("undo needs the owner file (use --policy-file with --state-dir)");
  const prevOwner = loadOwner(prevFile);
  if (!prevOwner) throw new PolicyError("E_PRECONDITION", "nothing to undo: no earlier policy is kept (undo goes back exactly one step, and only a set or clear that changed something keeps one; `clear` switches the policy off)", 1);
  // undo would lift a pause as a side effect (the direction away from safety): refused unless the owner says so
  const paused = readFlag(p) !== false;
  if (paused && !flags["lift-pause"]) {
    throw new PolicyError("E_PRECONDITION", `undo is refused while the policy is paused (it would also lift the pause). Run \`${RESUME_COMMAND}\` first, or run undo with --lift-pause yes to go back one step and lift the pause in one command`, 1);
  }
  const current = loadOwner(p.policyFile);
  saveOwner(p.policyFile, prevOwner);                                // atomic; the earlier toggles are back even if what follows fails
  fs.rmSync(prevFile, { force: true });                              // one generation only: a second undo finds nothing
  try {
    const g = await gatherInputs(p);
    ensureNoUnreadableTiers(g, prevOwner);
    const { compiled, res } = compile(g, prevOwner, { minSet: flags["min-set"] });
    if (res.refuse) throw new PolicyError("E_TIER_UNREADABLE", `E_TIER_UNREADABLE: ${res.refuse.text} (${g.tiersRes.reason ?? "unreadable"})`, 4);
    const main = mainProviderOf(p, g);
    if (prevOwner.mode !== "inherit") {
      if (res.empty) throw refusal(g, prevOwner, res, main, "all", p.fixture);
      if (prevOwner.source === "same-provider" && main.provider && subOf(res, main.provider) === 0) throw refusal(g, prevOwner, res, main, "main", p.fixture);
    }
    checkEnforcePreconditions(p, g, prevOwner);
    const prevC = readCompiled(p.compiledFile);
    if (!sameCompiled(prevC.ok ? prevC.value : null, compiled)) writeFileRetry(p.compiledFile, JSON.stringify(compiled) + "\n");
    fs.rmSync(p.flagFile, { force: true }); fs.rmSync(pausedFromOf(p), { force: true });
    const sr = readStatus(p.statusFile);
    const v = verdict(prevOwner, compiled, sr.ok ? sr.status : null, false, opts.now ?? Date.now());
    io.out("UNDONE. Your previous policy is back.");
    if (paused) io.out("pause lifted (--lift-pause yes)");
    io.out(savedLine(v)); io.out(fixLine(v));
    io.out(`change: ${deltaText(current ? sideOf(g, current, null, flags["min-set"]) : null, sideOf(g, prevOwner, res), providerTotalOf(res))}`);
    io.out(`policy: ${plainPolicy(prevOwner)}`);
    return 0;
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    // the restored toggles could not be compiled or applied: the safe landing is the pause (the earlier toggles stay saved)
    const quiet = { out() {}, err() {} };
    await cmdRollback(p, {}, quiet, "pause");
    // the whole refusal, with the words that are true here: undo DID write the owner file (your earlier toggles), it only wrote no compiled copy
    for (const l of e.message.split("\n")) io.err(l.replace(/; nothing written$/, "; your earlier toggles are saved, paused").replace(/^Nothing was written\.$/, "Your earlier toggles are saved, paused."));
    io.out(`UNDO restored your earlier toggles (${plainPolicy(prevOwner)}) but could not apply them. ${pausedLine(null)} Fix the cause above, then save again with a set (a set lifts the pause).`);
    return e.exit;
  }
}

/** `why [CODE]`: what a code means in plain words and the one command that fixes it (the one table of menu/subagent-codes.mjs; the plan section is shown here only). */
async function cmdWhy(p, flags, io, target) {
  if (!target) {
    for (const k of KINDS) io.out(`${k}s (${CODES.filter((r) => r.kind === k).length}): ${CODES.filter((r) => r.kind === k).map((r) => r.code).join(", ")}`);
    io.out(`ask about one: ${CLI} why <CODE>`);
    return 0;
  }
  const row = codeRow(target);
  if (!row) throw usage(`no code ${JSON.stringify(printable(target, 40))} in the table; \`${CLI} why\` with no code lists them`);
  for (const l of [`${row.code} (${row.kind})`, row.plain, ...(row.planned ? ["planned: nothing emits this yet"] : []), `fix: ${row.fix}`, ...(row.fixNote ? [`  note: ${row.fixNote}`] : []), `plan: section ${row.planRef}${row.degrades ? "; the router is NOT doing what you saved while this holds" : ""}`]) io.out(l);
  return 0;
}

/** The toggles of a preset on top of an owner's other settings, as the funnel takes them. */
const presetToggles = (base, flags) => ({ ...togglesOf(base), ...(flags.source ? { source: flags.source } : {}), mode: flags.mode, freeScope: flags["free-scope"] ?? base.freeScope, ctx: flags.ctx ?? base.ctx });

/** `preset [name]`: with no name, the four presets with live counts from the shared funnel; with a name, the equivalent flags and the preview, saved only with `--confirm yes`. */
async function cmdPreset(p, flags, io, name, opts = {}) {
  if (!name) {
    let counts = null, universe = null;
    try {
      const g = await gatherInputs(p);
      const base = loadOwner(p.policyFile) ?? { ...OWNER_DEFAULTS };
      counts = {};
      for (const [k, pr] of Object.entries(PRESETS)) {
        const r = funnel({ ...g.funnelInputs, minSet: flags["min-set"] }, presetToggles(base, pr.flags));
        universe = r.counts.universe;
        counts[k] = pr.flags.mode === "inherit" ? { eligible: null } : { eligible: r.counts.allowed, providers: providerCount(r.models), providerTotal: providerTotalOf(r), usable: r.counts.substitutable, ctx: ctxFloorsCompact(r.ctxStats) };
      }
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      counts = Object.fromEntries(Object.keys(PRESETS).map((k) => [k, { error: `counts unavailable: ${e.message.split("\n")[0].slice(0, 100)}` }]));
    }
    io.out(`ready-made choices (counts come from the same funnel as set${universe === null ? "" : `; denominator = ${fmtCount(universe)} snapshot routes`}); none is saved until you confirm it:`);
    for (const l of presetListText(CLI, counts)) io.out(l);
    return 0;
  }
  const pr = PRESETS[name];
  const confirm = flags.confirm === true && !flags.dry;
  io.out(`preset ${name}: ${pr.plain}`);
  io.out(`equivalent to: ${CLI} set ${flagsText(pr.flags)}`);
  // ONE save command per preview: the preset's own (the set command it expands to is only the description above)
  await cmdSet(p, { ...pr.flags, dry: !confirm, detail: flags.detail, "min-set": flags["min-set"] }, io, { ...opts, saveHint: `to save it: ${CLI} preset ${name} --confirm yes${liveSfx(p)}` });
  return 0;
}

/** `wizard`: at most 3 questions on a terminal; a preview; saves a shadow-mode policy only after a yes. Everything it reads or writes goes through `set`. */
async function cmdWizard(p, flags, io, opts = {}) {
  const tty = opts.isTTY ?? !!(process.stdin.isTTY && process.stdout.isTTY);
  const asker = opts.ask ? { ask: opts.ask, close() {} } : tty ? ttyAsker() : { ask: async () => { throw new Error("no terminal"); }, close() {} };
  const run = async (wf, dry) => {
    try { await cmdSet(p, { ...wf, dry, "min-set": flags["min-set"] }, io, { ...opts, saveHint: null, brief: !dry }); return 0; }
    catch (e) { if (!(e instanceof PolicyError)) throw e; for (const l of e.message.split("\n")) io.err(l); return e.exit; }
  };
  try {
    const res = await runWizard({
      isTTY: tty, ask: asker.ask, out: io.out, cli: CLI, live: !p.fixture,
      ctxFloorLine: async (free) => {
        try { const g = await gatherInputs(p); return ctxFloorsLine(funnel({ ...g.funnelInputs, minSet: flags["min-set"] }, presetToggles(loadOwner(p.policyFile) ?? { ...OWNER_DEFAULTS }, (free ? PRESETS.free : PRESETS.any).flags)).ctxStats); }
        catch { return null; }
      },
      freeNarrowCount: async () => {
        try { const g = await gatherInputs(p); return funnel({ ...g.funnelInputs, minSet: flags["min-set"] }, presetToggles(loadOwner(p.policyFile) ?? { ...OWNER_DEFAULTS }, PRESETS.free.flags)).counts.freeScopes.models.n; }
        catch { return null; }
      },
      mainOutsideFree: async () => {
        try { const g = await gatherInputs(p); const t = providerTier(g, mainProviderOf(p, g).provider); return t !== null && freeScopeOf(t) === null; }
        catch { return null; }
      },
      preview: (wf) => run(wf, true), save: (wf) => run(wf, false),
    });
    for (const l of res.refusal ?? []) io.err(l);
    return res.code;
  } finally { asker.close(); }
}

/** The enforce preconditions of `set`, evaluated for a rebuild: null when met (or not asked for), else the PolicyError naming what is unmet. */
function enforceGate(p, g, owner) {
  try { checkEnforcePreconditions(p, g, owner); return null; }
  catch (e) { if (e instanceof PolicyError) return e; throw e; }
}

async function cmdRebuild(p, flags, io) {
  const owner = loadOwner(p.policyFile);
  if (!owner) throw new PolicyError("E_PRECONDITION", "no owner policy file: nothing to rebuild (run `set` first)", 1);
  const g = await gatherInputs(p);
  ensureNoUnreadableTiers(g, owner);
  const prev = readCompiled(p.compiledFile);
  // The owner says enforce but a precondition of `set --enforce enforce` no longer holds (the gateway cannot be read, the
  // classifier verdict has expired): the rebuild keeps the ROUTER in shadow behaviour (the compiled file carries shadow) and
  // says so, instead of compiling a policy that enforces on evidence that is gone. The owner file is never changed.
  const gate = enforceGate(p, g, owner);
  const eff = gate ? { ...owner, enforcement: "shadow" } : owner;
  const gateOut = gate ? { code: "CLASSIFIER_UNMEASURED", text: `CLASSIFIER_UNMEASURED: the owner file says enforcement=enforce but ${gate.message.replace(/^E_PRECONDITION: /, "")}; the compiled file carries enforcement=shadow, so the router stays in shadow behaviour until the precondition holds and \`rebuild\` is run again` } : undefined;
  // `--if-stale yes` compares the CHEAP stamps before it compiles anything (router v2, ar-14): the inputs' own stamps, the hash of the inputs that carry no stamp
  // (settings aliases, default model, tool-fidelity body), the providers and tiers hashes, the owner toggles and the gate. All equal means the compile would write the
  // same bytes, so it never runs; the stamps are the ones a compile records in `builtFrom`.
  if (flags["if-stale"] && prev.ok) {
    const a = prev.value.builtFrom ?? {};
    const b = { ...g.stamps, providersLive: g.providersLive, providersHash: g.providersHash, tiersHash: tiersHashOf(g.funnelInputs.tiers), ownerHash: ownerHashOf(eff), compiler: COMPILER_VERSION };
    const cheapSame = ["snapshotBuiltAt", "benchGeneratedAt", "observedWrittenAt", "providersHash", "providersLive", "tiersHash", "ownerHash", "inputsHash", "tfAsOf", "compiler"].every((k) => a[k] === b[k])
      && JSON.stringify(prev.value.owner) === JSON.stringify(ownerBlock(eff)) && !prev.value.gate === !gateOut && prev.value.minRouter === MIN_ROUTER
      && hashOf(prev.value) === prev.value.contentHash;                 // S-F7: a hand-edited compiled file keeps its stamps but not its hash: it is rebuilt, never reported up to date (--min-set changes no compiled byte: it only steers the warning text)
    if (cheapSame) {
      if (!flags.quiet) { io.out("up to date: nothing to rebuild"); for (const w of a.tierWarnings ?? []) io.out(printable(w.text, 400)); }
      return 0;
    }
  }
  const { compiled, res } = compile(g, eff, { minSet: flags["min-set"], gate: gateOut });      // the gate is part of the measured file (the 1 MiB cap is on what is written)
  if (res.refuse) throw new PolicyError("E_TIER_UNREADABLE", `E_TIER_UNREADABLE: ${res.refuse.text}`, 4);
  const same = sameCompiled(prev.ok ? prev.value : null, compiled);
  if (!same) writeFileRetry(p.compiledFile, JSON.stringify(compiled) + "\n");
  if (!flags.quiet) io.out(`rebuilt ${p.compiledFile}: contentHash ${compiled.contentHash}${same ? " (unchanged, not rewritten)" : ""}; allowed ${res.counts.allowed}`);
  if (gate) io.out(compiled.gate.text);
  if (!flags.quiet) for (const l of [...ownerNotes(eff), ...routerVersionNote(p, compiled)]) io.out(l);
  if (!flags.quiet) for (const w of compiled.builtFrom.tierWarnings) io.out(printable(w.text, 400));       // F24: the same KEY_AMBIGUOUS and NO_TIER lines `set` prints
  if (res.empty) throw new PolicyError("E_EMPTY", `E_EMPTY: the compiled policy is empty (${compiled.emptyReasons.join("; ")}); written with empty: true, the router will report EMPTY_SET and serve each subagent the model it asked for`, 2);
  return 0;
}

/**
 * "Would be chosen as the substitute when main is X" (plan 7): the router's own rule (6.1b, 6.2) applied to the compiled rows. The usable pool is the rows with a known context
 * of at least the substitute floor. BANDED (the default): the candidates are the first K rows, in rank order, of the LEAD row's band (a band = equal tool tier, health, context
 * preference class and price class); with banding off, the top K of the leading tie group, filled from the next rows. Per request the router also skips a row that cannot fit it
 * or does not resolve, and DEMOTES a cooling model or one the observer marks rate, pay or auth: those are used only when nothing else is usable. Fit, payload, resolvability,
 * cooling and the overlay cannot be known here.
 */
function substituteLine(res, selector, banded = true) {
  const T = res.toggles;
  if (T.mode === "inherit") return "not a substitute under inherit (every non-exempt subagent gets main's exact model)";
  const pool = res.models.filter((r) => r.c >= SUBSTITUTE_FLOOR);
  const topK = (rows) => {
    if (!rows.length) return [];
    if (banded) return rows.filter((r) => r.b === rows[0].b).slice(0, SUBSTITUTE_K);
    const top = [];
    for (const r of rows) if (top.length < SUBSTITUTE_K && r.g === rows[0].g) top.push(r);
    for (const r of rows) if (top.length < SUBSTITUTE_K && !top.includes(r)) top.push(r);
    return top;
  };
  const providers = [...new Set(res.models.map((r) => providerOf(r.s)))].sort();
  const when = providers.filter((p) => {
    const own = pool.filter((r) => providerOf(r.s) === p);
    const rows = own.length ? own : T.source === "all-providers" ? pool : [];
    return topK(rows).some((r) => r.s === selector);
  });
  const fallback = T.source === "all-providers" && pool.length > 0 && topK(pool).some((r) => r.s === selector);
  const spread = banded ? `spread over the first ${SUBSTITUTE_K} rows of the lead rank band by agent hash` : `spread over the top ${SUBSTITUTE_K} by agent hash (banding is OFF: the old pool, not limited to one band)`;
  const where = when.length ? `when main is on: ${when.slice(0, 8).join(", ")}${when.length > 8 ? ` and ${when.length - 8} more` : ""} (of ${providers.length} providers in the set; ${spread})` : "never, for any provider in the set";
  return `would be chosen as the substitute ${where}${fallback ? "; also when main's provider has no rows of its own" : ""}`;
}
/** What happens when the lead band is not usable (the router's fallback rule, D2), stated once for `explain`. */
const FALLBACK_RULE = "fallback: a cooling model (the 2 min, 10 min, 60 min, 6 h ladder, per provider key too) or one the observer marks rate within 2 h, pay or auth within 24 h is demoted, never removed; when the whole lead band is demoted the router uses the next band of the SAME tool tier, then a LOWER tool tier only if it is tested (v, then t), never an untested u; when nothing tested remains it uses the demoted lead row, or keeps the current model on a handoff";

/** Plain words for the stage at which a model stopped (the `explain` ANSWER line). */
const STAGE_PLAIN = (grp, owner) => {
  const st = String(grp.stage ?? "");
  if (st.startsWith("bench-")) return grp.status && grp.status !== "ok" ? `its last speed test was ${grp.status}, not ok` : "it has no speed-test record";
  return ({ "tools-false-claim": "the catalogue says it cannot use tools", "tools-failed": "it failed the tool test", "known-bad": `${grp.knownIssue ? knownIssueText(grp.knownIssue) : "known issue"}, and no real tool test has overridden it`, "tools-unverified": "it is not tool-tested and the unverified setting excludes untested models",
    "excluded-tier": `its key tier (${grp.tier}) is an excluded tier`, "scope": owner.mode === "free" ? `it is outside ${SCOPE_NAMES[owner.freeScope]}` : "it is outside the chosen scope",
    "ctx": `it has less than ${ctxLabel(owner.ctx)} of known context and the context floor is ${owner.ctx}` })[st] ?? `it stopped at ${st}`;
};

async function cmdExplain(p, flags, io, target) {
  // what-if (plan 7.2 item 4): --source/--mode/--free-scope/--ctx replace the saved toggles FOR THIS ANSWER ONLY; nothing is written
  const base = loadOwner(p.policyFile) ?? { ...OWNER_DEFAULTS, source: "all-providers", mode: "dynamic" };
  const whatIf = WHATIF_FLAGS.some((k) => flags[k] !== undefined);
  const owner = { ...base, ...(flags.source ? { source: flags.source } : {}), ...(flags.mode ? { mode: flags.mode } : {}), ...(flags["free-scope"] ? { freeScope: flags["free-scope"] } : {}), ...(flags.ctx ? { ctx: flags.ctx } : {}) };
  if (flags["free-scope"] !== undefined && owner.mode !== "free") throw usage("--free-scope is only valid with --mode free");
  const policyText = `mode ${owner.mode}${owner.mode === "free" ? ` (${SCOPE_NAMES[owner.freeScope]})` : ""}, source ${owner.source}, ctx ${owner.ctx}`;
  const answer = (yes, because) => `ANSWER: ${bare} ${yes ? "WOULD be allowed" : "would NOT be allowed"} under ${policyText}${yes ? "" : `: ${because}`}${whatIf ? " (what-if: nothing was saved)" : ""}`;
  const g = await gatherInputs(p);
  const toggles = { source: owner.source, mode: owner.mode, freeScope: owner.freeScope, ctx: owner.ctx, unverified: owner.unverified, allow: owner.allow };
  const res = funnel(g.funnelInputs, toggles);
  const bare = stripOneM(target);
  const grp = res.groups.get(bare);
  const dropped = res.dropped.get(bare);
  const known = grp || dropped || g.funnelInputs.rows.some((r) => (r.models ?? []).some((m) => `${r.provider}/${stripOneM(m.id)}` === bare));
  if (!known) throw new PolicyError("E_UNKNOWN_MODEL", `no model ${JSON.stringify(target)} in the snapshot`, 3);
  const L = [`explain ${bare}`];
  if (!grp) {
    L.push(answer(false, `it is never a candidate (${dropped ?? "unknown"})`));
    L.push(`found: yes, but never a candidate: ${dropped ?? "unknown"} (chat-capable and in live Providers are the first two stages)`);
    for (const l of L) io.out(l); return 0;
  }
  const tf = g.funnelInputs.toolFidelity?.models?.[grp.selector];
  L.push(owner.mode === "inherit" ? `ANSWER: under mode inherit every non-exempt subagent runs on main's own model, so ${bare} is used exactly when main itself runs on it${whatIf ? " (what-if: nothing was saved)" : ""}` : answer(grp.stage === "in-set", STAGE_PLAIN(grp, owner)));
  L.push(`found: yes (${grp.routes} snapshot route(s) collapse to this selector)`, "chat-capable: yes", `in live Providers: yes (${grp.selector})`);
  const rec = grp.rec;
  L.push(`bench: ${rec ? `${rec.s}${Number.isFinite(rec.a) ? `, probed ${ago(Date.now() - rec.a * 1000)} ago` : ""}${Number.isFinite(rec.t) ? `, TTFT ${rec.t} ms` : ""}${g.funnelInputs.bench.isLive(grp.selector) ? ", live overlay" : ""}` : "no record"}`);
  L.push(`tools claim: ${grp.toolsAny ? "not false" : "false"} (catalogue, untrusted); tool tier: ${grp.toolTier ?? "n/a"}${grp.toolBasis ? ` (${grp.toolBasis})` : ""}${tf ? ", tool-fidelity record present" : ", no tool-fidelity record"}`);
  L.push(`key tier: ${grp.tier ?? "none"} (source: vault registry; key id ${(g.tiersRes.keyIds && Object.hasOwn(g.tiersRes.keyIds, grp.provider) ? g.tiersRes.keyIds[grp.provider] : undefined) ?? grp.keyId ?? "?"})`);
  L.push(`ALIAS: ${grp.alias ? `yes (pool rule ${POOL_ALIAS_RE} matched; never above tier u)` : "no"}; free tag: ${grp.tag ? `yes (${FREE_TAG})` : "no"}`);
  L.push(`price: ${res.models.find((r) => r.s === grp.selector)?.i ?? (grp.pin == null && grp.pout == null ? "$?" : `$${grp.pin}/$${grp.pout}`)}; free verdict: ${grp.pin === 0 && grp.pout === 0 ? "price 0 (free on a free-labelled provider, like a free-tagged row)" : "not price 0"}; premium: ${grp.premium ? `yes (${PREMIUM_RULE.families.join("/")} family or output >= $${PREMIUM_RULE.outUsdPerM}/M)` : "no"}${grp.pricedButBadged ? "; PRICED_BUT_BADGED" : ""}`);
  if (grp.knownIssue) L.push(`${knownIssueText(grp.knownIssue)}${grp.knownIssue.kind === "cap" ? ` (a size cap of about ${sizeCell(grp.knownIssue.capBelow)}, never an x)` : ""}; used only until a real tool-fidelity record exists`);
  if (grp.accountState) L.push(`account state: its bench status is ${grp.status} but the stored message names your account (${grp.accountState}); a re-probe will not change it, so it is not listed as waiting`);
  if (grp.reprobe) L.push(`re-probe: its bench status is ${grp.status} on a sample older than 2 days; a transient status is not proof it cannot work, so it waits for a re-probe`);
  L.push(`ctx: ${grp.c > 0 ? n(grp.c) : "unknown"} (${grp.ci ? "INFERRED (c?) from a same-name sibling: a 128k floor-only prior, never the asked floor or a ranking class above 128k" : grp.tag1m ? "[1m] sibling" : grp.c > 0 ? "catalogue" : "unknown"}${grp.n ? "; n:1 listing-only, needs the context-1m beta header" : ""}); substitutable: ${grp.c >= SUBSTITUTE_FLOOR ? "yes" : "no (needs a known context of at least 128,000)"}`);
  L.push(`payload cap: ${grp.limit > 0 ? `${sizeCell(grp.limit)} (band ${capBand(grp.limit)}; source ${grp.limitSource ?? "?"})` : "unknown (the size check does nothing for it until a limit is measured)"}`);
  if (grp.in) {
    for (const s of FREE_SCOPES) {
      const why = grp.in[s] ? "PASS" : freeScopeOf(grp.tier) === null ? `FAIL (tier ${grp.tier} is in no free scope)`
        : g.funnelInputs.tiers === null && s !== "models" ? "FAIL (registry unreadable)"
        : freeScopeOf(grp.tier) === "deposit" && !grp.tag ? `FAIL (deposit-strict-skipped: no free tag on a ${grp.tier} provider)` : "FAIL (not a free-labelled model)";
      L.push(`${SCOPE_NAMES[s]}: ${why}`);
    }
  } else L.push(`stage: ${grp.stage}${grp.status && grp.status !== "ok" ? ` (bench ${grp.status})` : ""}: not probe-ok and tool-eligible, so in no scope`);
  if (isExcludedTier(grp.tier)) L.push(`excluded: key tier ${grp.tier} is an excluded tier (menu/tiers.mjs): its models are never admitted under any mode or scope`);
  L.push(`toggles: source=${owner.source} mode=${owner.mode} ctx=${owner.ctx}: ${grp.stage === "in-set" ? "IN the allowed set" : `NOT in the allowed set (stopped at ${grp.stage})`}`);
  const idx = res.models.findIndex((r) => r.s === grp.selector);
  if (idx >= 0) {
    const labels = ["tool tier (band)", "health: latest status ok (band)", "ctx preference (band)", "price class 2b (band)", "first strike", "big step (v only)", "L4 (v only)", "ttft quantile bucket", "ctx class", "price 2b", "recency (order only, calendar-dependent)", "alias"];
    L.push(`rank: position ${idx + 1} of ${res.models.length} (ordered by reliability then context, NOT by quality or price); keys ${labels.map((l, i) => `${l}=${grp.rk[i]}`).join(", ")}`);
    L.push(`shortlist: ${idx < INJECT_MAX_ENTRIES ? "listed" : "beyond the 20-entry injected shortlist"}; ${substituteLine(res, grp.selector, owner.banded !== false)}`);
    L.push(`band: ${grp.b} (equal tool tier, health, ctx preference and price class; rows in one band are interchangeable for the spread)`, FALLBACK_RULE);
  }
  for (const l of L) io.out(l);
  return 0;
}

// ------------------------------------------------------------------ entry
/** Runs one `subagent-policy` command. `io` is {out, err}; returns the exit code. Never throws for an expected failure. */
export async function runSubagentPolicy(argv, io, env = process.env, opts = {}) {
  // `opts` is a library-level seam for tests ({now, isTTY, ask}); the CLI never passes it
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") { io.out(usageText); return 0; }      // R12: nothing to run is not an error; say what can be run
  try {
    for (const k of AMBIENT_ENV) if (env[k]) io.err(`NOTE: ambient ${k} is set and IGNORED (the policy is steered only by explicit flags and its default locations)`);
    const { cmd, flags, target } = parseArgs(argv);
    const p = resolvePaths(flags, { env });
    switch (cmd) {
      case "set": return await cmdSet(p, flags, io, opts);
      case "show": return await cmdShow(p, flags, io, opts);
      case "status": return await cmdStatus(p, flags, io, opts);
      case "last": return await cmdLast(p, flags, io, target, opts);
      case "preset": return await cmdPreset(p, flags, io, target, opts);
      case "wizard": return await cmdWizard(p, flags, io, opts);
      case "clear": return await cmdClear(p, flags, io);
      case "rollback": return await cmdRollback(p, flags, io, "rollback");
      case "pause": return await cmdRollback(p, flags, io, "pause");
      case "resume": return await cmdResume(p, flags, io, opts);
      case "undo": return await cmdUndo(p, flags, io, opts);
      case "why": return await cmdWhy(p, flags, io, target);
      // loaded on demand, like key.mjs loads this module: the report pulls in the SQLite reader, the self-test the sandbox harness constants, and no other command needs either
      case "report": return await (await import("./subagent-report.mjs")).cmdReport(p, flags, io, opts);
      case "selftest": return await (await import("./subagent-selftest.mjs")).cmdSelftest(p, flags, io, opts);
      case "rebuild": return await cmdRebuild(p, flags, io);
      case "explain": return await cmdExplain(p, flags, io, target);
      default: throw usage(`unknown subcommand ${cmd}`);
    }
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    const first = e.message.startsWith("E_") ? e.message : `${e.code}: ${e.message}`;
    io.err(first);
    for (const x of e.extra) io.err(x);
    return e.exit;
  }
}

export const usageText = [
  "usage: key.mjs subagent-policy <command> [flags]   (every flag takes an explicit value; booleans are exactly yes or no)",
  "",
  "Choose which model your subagents run on. A trial is safe: shadow mode only logs what it would do and changes nothing.",
  "Words used: eligible = a model that passes your choices; usable = an eligible model with a known context of at least 128,000, so it can stand in for a subagent.",
  "",
  "Quick start",
  "  preset                    list the ready-made choices with live counts (follow-main, any, free, free-wide, free-1m)",
  "  preset free               preview one: the equivalent flags and what it would do; nothing is saved (free = only models tagged free; free-wide = every model on a provider you labelled free)",
  "  preset free --confirm yes save it (add --live yes when it writes your real files)",
  "  wizard --live yes         three questions on a terminal, a preview, then a save in shadow mode (it needs --live yes on your real files, like every command that saves)",
  "  status                    the verdict first (off, saved, waiting, wired, idle, shadow, enforcing, paused or degraded) and the one command that helps, then the policy, the compiled copy and what the router last reported: about five lines",
  "  last [N] [--since 1h|24h|7d] [--json yes]   what the last subagents asked for, what ran, what the policy would use",
  "",
  "The three toggles (set takes them as flags)",
  "  Toggle 1  source   --source same-provider|all-providers   same-provider: only main's own provider; all-providers: any provider",
  "  Toggle 2  mode     --mode dynamic|inherit|free            dynamic: any model; inherit: main's own model; free: free models only",
  "            (free)   --free-scope models|providers|providers+deposit   which models count as free (only with --mode free): models = tagged free; providers = every model on a provider you labelled free",
  "  Toggle 3  context  --ctx any|128k|200k|256k|512k|1m|prefer-256k|prefer-512k|prefer-1m",
  "            any: no floor; 128k to 1m: only models with at least that known context; prefer-256k, prefer-512k, prefer-1m: those first, nothing excluded (set --dry yes prints rows per floor)",
  "Other switches: --banded yes|no (the substitute spread stays inside the lead rank band; default yes), --handoff-notice yes|no (after a retry-driven handoff the router adds one line to the subagent's system prompt; default yes),",
  "  --enforce shadow|enforce, --inject off|on, --allow provider/model (pin one model; repeatable), --unverified allow-warn|allow-t|pin-only.",
  "",
  "All commands",
  "  set [toggles and switches] [--dry yes] [--detail yes]   compute and (without --dry yes) save; --detail yes prints the whole funnel and every raw warning",
  "  show [--detail yes]       the saved policy, the compiled copy and what the router reported",
  "  explain <provider/model> [--source ..] [--mode ..] [--free-scope ..] [--ctx ..]   would this model be allowed? the flags ask 'what if' and save nothing",
  "  report [--since 1h|24h|7d] [--session ID] [--json yes] [--outcomes yes]   asked -> ran per agent, what the policy would have used, and an input-token cost estimate against main's own model; --outcomes yes joins the gateway request log (read only)",
  "  selftest --plan yes       what a sandbox self-test would do, and its plan hash; it starts nothing (the run needs your typed approval: --approve-plan yes, then --run yes)",
  "  why [CODE]                what a warning or error code means in plain words, and the command that fixes it",
  "  pause | resume | undo     pause: subagents run as they asked from the next request (your toggles are kept); resume: continue (checked like set --enforce enforce); undo: back one step (refused while paused unless --lift-pause yes)",
  "  rebuild [--if-stale yes]  recompile the saved policy after a bench sweep, keysync run or key change",
  "  clear                     remove the policy; the router goes back to exact legacy behaviour",
  "  rollback                  the same as pause",
  "  help                      this text",
  "A set (without --dry yes), rebuild, clear, resume, undo or wizard that writes the REAL files needs --live yes; rollback needs no flag (pause is the same command); a test-flag run names its own files instead.",
].join("\n");

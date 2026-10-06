// Stage S0 of the subagent model policy: the sandbox EXPERIMENTS (plan 9.2, 12.0 Phase B, 12.1 S0, 12.2). BUILT OFFLINE AND NOT RUN: the run
// needs owner gate G1 (a SECOND CCR 3.0.22 daemon beside the live one).
//
//   node harness/subagent-e2e.mjs --plan [--router R] [--no-preload-guard]     prints exactly what a run WOULD start, write and never touch, then its sha256; READS only the files it hashes (EXECUTED FILES) and the installed CCR (ccr.cmd, package.json, dist/main/cli.js), writes and starts nothing
//   node harness/subagent-e2e.mjs --approve-plan [--router R] [--no-preload-guard --i-understand-no-guard <12 hex>]
//                                                                              OWNER ACT, interactive terminal only: type the first 12 hex of the plan sha256; writes harness/g1-approval.json (ONE-USE, valid 24 h at most)
//   node harness/subagent-e2e.mjs --experiments-only --g1-approved [--router probe|next|both] [--no-preload-guard --i-understand-no-guard <12 hex>]
//                                                                              --experiments-only is MANDATORY (a run without it exits 2); needs the flag AND a valid approval file whose hash equals the CURRENT --plan text; the approval file is CONSUMED (atomically renamed) at run start
//   node harness/subagent-e2e.mjs --teardown                                   removes only what this script created, after verifying the daemon identity
//   node harness/subagent-e2e.mjs --host-check x6                              STANDALONE (no approval, no daemon, no sandbox): 10,000 renames of 250 KB with a concurrent reader inside one fresh directory under the OS temp dir
//
// Revision 10: the probe run also carries X1-X5, X7, X8 and X9a-e (X7 must PASS, the rest are informational FINDING-level); the exact-bytes run is router v2 (A8 reads status-<w>.json and the loader
// registry, A2 reads agents.jsonl) and ends with the handoff smoke H1. X6 is the standalone host check above; X9f, X9g, X9h and the real-Claude-Code part of X3 are NOT here (see NOT_RUN).
//
// A run starts the sandbox daemon (harness/start.ps1, harness/bootstrap-live-safe.mjs), proves isolation, and ONLY THEN sends any request.
// The proof is mandatory: if any check is red the run is REFUSED (exit 1) before the first synthetic request and the sandbox is cleaned up.
// Importing this module starts nothing; every effect goes through the injectable dependency object `d` (the unit tests drive it with fakes).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { rpc, resolveWebPort, WEB_AUTH_TOKEN, RpcTimeoutError } from "./config.mjs";
import {
  makeTripwire, assertIsolatedInstance, assertIsolatedConfig, assertPayloadIsolated, assertRouterClean, assertDesktopSyncLandedInScratch,
  assertGatewayBound, listenerPid,
} from "./guard.mjs";
import { createStub, STUB_MODELS, RECORDED_HEADERS } from "./stub-upstream.mjs";
import {
  RefusalError, buildSpec, assertSandboxSpec, printableEnv, safeWritePath, safeEvidencePath, SIDE_EFFECTS, CANNOT_VERIFY, NEVER_TOUCH, NEVER_TOUCH_NON_FS,
  SANDBOX_OWNED, SANDBOX_PORTS, REAL_PORTS, PORT_RANGE, PROBE_ROUTER_SRC, NEXT_ROUTER_SRC, SCRATCH_ROOT, SCRATCH_ROUTER, SCRATCH_SLOT, SCRATCH_STATE_DIR,
  VIOLATIONS_LOG, GUARD_LOADED_LOG, REQUIRED, formatLine, evaluateRun, oneLine, diffFingerprint, describeFingerprint, baselineOf, proveIsolation,
  assertIsolationProven, CCR_CONFIG_DIR, EVIDENCE_ROOT, APPROVAL_FILE, APPROVAL_MAX_AGE_MS, PRECREATE_DIRS, MUST_BE_ABSENT, START_CREATES, liveServicePid, treeOf,
  hashExecutedFiles, descendantsLeafFirst, PROTECTED_ROOTS, REPO_ROOT, resolveCcrInstall, ccrInstallLines, approvalUsedFile, isUnder, realish,
} from "./subagent-sandbox-spec.mjs";

const { redactSecrets: redactBase, redactDaemonLog } = createRequire(import.meta.url)("./trial31/redact31.cjs");   // read-only reuse of the 3.1.1 trial redactor
/** Literal secrets this run knows (the sandbox profile key, found or generated): the shared redactor masks keys by context (x-api-key:, "key":), not a bare ccr-profile-... token in free text, so every one is also masked verbatim. Cleared at the start of each run. */
const RUN_SECRETS = new Set();
const redactSecrets = (t) => { let s = redactBase(t); for (const k of RUN_SECRETS) s = s.split(k).join("<redacted>"); return s; };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ANCHOR = "uwstub/m-main";
export const TAG_MODEL = "uwstub/m-free";
export const ASKED_MODEL = "uwstub/m-big";
export const E4_MARK = "[uwpr-e4]";
const SYS32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const PS = path.join(SYS32, "WindowsPowerShell", "v1.0", "powershell.exe");
const INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

// ---------------------------------------------------------------- model spelling (one normaliser for every stub-model comparison)
/** The part of a selector after its FIRST slash (`uwstub/m-free` -> `m-free`); a selector without a slash is its own bare form. */
export const bareOf = (sel) => { const s = String(sel ?? ""), i = s.indexOf("/"); return i < 0 ? s : s.slice(i + 1); };
/** CCR very likely sends the BARE model name to an anthropic_messages upstream, and the full selector is the other plausible spelling: both are accepted, nothing else is. */
export const modelIs = (got, selector) => typeof got === "string" && (got === selector || got === bareOf(selector));
export const spellingOf = (got, selector) => (got === selector ? "selector" : got === bareOf(selector) ? "bare" : "other");

// ---------------------------------------------------------------- arguments
const BOOL_FLAGS = new Set(["--plan", "--experiments-only", "--g1-approved", "--no-preload-guard", "--teardown", "--approve-plan", "--help"]);
export function parseArgs(argv) {
  const opts = { plan: false, experimentsOnly: false, g1: false, preloadGuard: true, teardown: false, approvePlan: false, help: false, router: "both", noGuardToken: null };
  const errors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--router") {
      const v = argv[++i];
      if (!["probe", "next", "both"].includes(v)) errors.push(`--router needs probe, next or both (got ${v === undefined ? "nothing" : v})`);
      else opts.router = v;
    } else if (a === "--i-understand-no-guard") {
      const v = argv[++i];
      if (!/^[0-9a-f]{12}$/.test(String(v))) errors.push(`--i-understand-no-guard needs the first 12 hex characters of the plan sha256 (got ${v === undefined ? "nothing" : oneLine(v, 20)})`);
      else opts.noGuardToken = v;
    } else if (a === "--host-check") {
      const v = argv[++i];
      if (v !== "x6") errors.push(`--host-check needs x6 (got ${v === undefined ? "nothing" : oneLine(v, 20)})`);
      else opts.hostCheck = v;                                    // the key exists only when given, so the default option object is unchanged
    } else if (BOOL_FLAGS.has(a)) {
      if (a === "--plan") opts.plan = true; else if (a === "--experiments-only") opts.experimentsOnly = true; else if (a === "--g1-approved") opts.g1 = true;
      else if (a === "--no-preload-guard") opts.preloadGuard = false; else if (a === "--teardown") opts.teardown = true; else if (a === "--approve-plan") opts.approvePlan = true; else opts.help = true;
    } else errors.push(`unknown argument ${oneLine(a, 40)}`);
  }
  if ([opts.plan, opts.teardown, opts.approvePlan].filter(Boolean).length > 1) errors.push("--plan, --approve-plan and --teardown are separate modes: give one");
  if (opts.hostCheck && (opts.plan || opts.teardown || opts.approvePlan || opts.experimentsOnly || opts.g1)) errors.push("--host-check is a standalone mode: give it alone");
  return { ok: errors.length === 0, errors, opts };
}
export const USAGE = [
  "usage: node harness/subagent-e2e.mjs --plan [--router probe|next|both] [--no-preload-guard]",
  "       node harness/subagent-e2e.mjs --approve-plan [--router probe|next|both] [--no-preload-guard --i-understand-no-guard <12 hex>]",
  "       node harness/subagent-e2e.mjs --experiments-only --g1-approved [--router probe|next|both] [--no-preload-guard --i-understand-no-guard <12 hex>]",
  "       node harness/subagent-e2e.mjs --teardown",
  "       node harness/subagent-e2e.mjs --host-check x6",
  "  --plan              print what a run would start, write and never touch, then `plan sha256: <hex>`; reads only the files it hashes and the installed CCR (ccr.cmd, package.json, dist/main/cli.js), writes and starts nothing",
  "  --approve-plan      OWNER ACT (never an agent's): needs an interactive terminal (stdin and stdout TTY; exit 2 otherwise) AND the first 12 hex of the plan sha256 typed exactly;",
  "                      then writes harness/g1-approval.json (sha256 + ISO timestamp). ONE-USE: a run consumes the file at start by an atomic rename (exactly one of two racing runs wins it), so each run needs a fresh approval; valid 24 h at most; starts nothing",
  "                      WHAT THE APPROVAL PROVES: the plan text and the bytes of every executed file are unchanged since the hash was typed, and it blocks an accidental or scripted run. It does NOT prove a human acted: anything that can run this script in a terminal can type the 12 hex",
  "  --experiments-only  MANDATORY: a run without it exits 2 (the full A0-A13 gate run is stage S3 and is not built). The S0 experiments: A0 E4 E5 E7 E12 E13 and X1 X2 X3 X4 X5 X7 X8 X9a-X9e on the probe router (X7 is REQUIRED: a timer that never fires is a FAIL; X1-X5, X8, X9 are informational, FINDING-level); A0 A1 A2 A8 (router v2: status-<w>.json, agents.jsonl, loader registry) and the handoff smoke H1 (informational) on the exact bytes of router/uw-router.next.cjs; A11 (live gateway untouched) is evaluated after EACH router run, on both routers",
  "                      NOT RUN here: X9f (PARKED: a plugin needs a gateway restart, R1), X9g, X9h and the real-Claude-Code parts of X3 (they need `claude -p`: scenario suite S2d), the OpenAI-converted path of X8, X6 (standalone: --host-check x6)",
  "  --host-check x6     STANDALONE, no approval, no daemon, no sandbox: 10,000 renames of a 250 KB file with a concurrent reader inside ONE fresh directory under the OS temp dir (removed at the end, also on a signal; refused when the temp dir is under a protected folder); prints the counts of EPERM, EBUSY, other errors and torn reads. Touches nothing else. DO NOT RUN IT DURING G1: it loads the disk and can disturb the X7 timer margins",
  "  --g1-approved       owner gate G1, necessary but NOT sufficient: a run also needs a valid harness/g1-approval.json whose hash equals the CURRENT --plan text (same flags)",
  "  --router            which run (default both: probe first, then the exact next bytes); part of the plan text, so part of the hash",
  "  --no-preload-guard  drop the fail-closed process guard (default ON). Reviewed owner choice: ALSO needs --i-understand-no-guard <first 12 hex chars of the",
  "                      plan sha256 of `--plan --no-preload-guard`>, for --approve-plan and for the run",
  "  --teardown          stop the identity-verified sandbox daemon tree FIRST (leaf first), then the stub, then check the sandbox ports, remove only the directories this script created; exit 1 if a sandbox port is still held",
  "exit: 0 every required line present and no FAIL; 1 a FAIL, a refusal, an unproven isolation or an incomplete teardown; 2 usage or missing gate/approval;",
  "      129 SIGHUP, 130 SIGINT, 143 SIGTERM, 149 SIGBREAK (a signal: the evidence is kept, the teardown runs to its end, then the process exits with that code; a second signal during the teardown is ignored with a message)",
];

// ---------------------------------------------------------------- synthetic requests (shapes of plan 9.2)
export const AGENT_TOOL = { name: "Agent", description: "Launch a new agent to handle a task.", input_schema: { type: "object", properties: { prompt: { type: "string", description: "The task for the agent" }, subagent_type: { type: "string" } }, required: ["prompt"] } };
export const BASH_TOOL = { name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } };
const BILLING = "x-anthropic-billing-header: cc_version=2.1.0; cc_entrypoint=cli; cc_is_subagent=true;";
export const SHAPES = ["main", "sub", "aux", "bg"];

/**
 * main: Agent tool, session id, no agent id. sub: agent id, billing flag, tools, optional tag line. aux: agent id, no tools. bg: no agent id, no tools.
 * Options for the revision 10 experiments (defaults leave the four shapes exactly as they were): `messages` (an ODD count n: user, assistant, user, ...; the last is a user turn, the
 * texts are deterministic so a re-send is byte-identical), `systemShape` ("array" default, or "string": the billing text and the sentence joined by a newline), `systemCache` (cache_control
 * on the LAST system block, array shape), `agentTool` (false: a tools list without the Agent tool, as a real subagent has), `parent` (x-claude-code-parent-agent-id) and `retryCount` (x-stainless-retry-count).
 */
export function buildRequest(shape, { key, model, session = "uws0-main", agentId = "uws0-agent-1", tag, messages = 1, systemShape = "array", systemCache = false, parent, retryCount, agentTool = true } = {}) {
  if (!SHAPES.includes(shape)) throw new Error(`unknown request shape ${shape}`);
  if (!Number.isInteger(messages) || messages < 1 || messages % 2 === 0) throw new Error(`messages must be an odd count (the last turn is the user's), got ${messages}`);
  if (!["array", "string"].includes(systemShape)) throw new Error(`unknown system shape ${systemShape}`);
  const headers = {
    "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.0 (external, cli)",
    "x-claude-code-session-id": session,
  };
  const withAgent = shape === "sub" || shape === "aux";
  if (withAgent) headers["x-claude-code-agent-id"] = agentId;
  if (parent !== undefined) headers["x-claude-code-parent-agent-id"] = parent;
  if (retryCount !== undefined) headers["x-stainless-retry-count"] = String(retryCount);
  const blocks = [{ type: "text", text: "You are a synthetic sandbox agent." }];
  if (shape === "sub") blocks.unshift({ type: "text", text: BILLING });
  if (systemCache && systemShape === "array") blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  const system = systemShape === "string" ? blocks.map((b) => b.text).join("\n") : blocks;
  const tools = shape === "main" || shape === "sub" ? [...(agentTool ? [structuredClone(AGENT_TOOL)] : []), structuredClone(BASH_TOOL)] : [];
  const text = `${tag ? `<CCR-SUBAGENT-MODEL>${tag}</CCR-SUBAGENT-MODEL>\n` : ""}hello`;
  const turns = Array.from({ length: messages }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: i === 0 ? text : `turn-${i}` }] }));
  const body = { model, max_tokens: 16, stream: false, system, messages: turns };
  if (tools.length) body.tools = tools;
  return { headers, body };
}
/** sha256 of the JSON text of messages and of tools as a request carries them: the stub hashes the parsed body the same way, so equal hashes mean the upstream received the same bytes of those two fields. */
export const bodyHashes = (body) => ({ messages: sha(JSON.stringify(body.messages ?? null)), tools: sha(JSON.stringify(body.tools ?? null)) });

/**
 * CCR 3.0.22 (dist/main/cli.js os()/mLe()): the id of a profile's API key entry is `profile:` + the profile's id (else name, else agent) trimmed, every run of characters outside
 * [a-zA-Z0-9_.-] turned into one '-', leading and trailing '-' cut, CASE KEPT (an empty result is 'profile'). The gateway sets x-auth-api-key-id to the matched ENTRY id and the enricher
 * (V6/Oy) accepts the request only when that id equals os(profile). Nothing else matches: no lower-casing, no match by name, no legacy single APIKEY.
 */
export const profileKeyId = (p) => `profile:${String(p.id || p.name || p.agent).trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "profile"}`;
const enabledClaudeProfile = (cfg) => (cfg?.profile?.profiles ?? []).find((x) => x && x.agent === "claude-code" && x.enabled);
/** The enricher matches the request key to the enabled claude-code profile by the exact entry id profileKeyId(profile). Field names only are reported on a miss, never values; the wanted id is not a secret. */
export function findProfileKey(cfg) {
  const p = enabledClaudeProfile(cfg);
  if (!p) return { error: "no enabled claude-code profile in the sandbox config" };
  const want = profileKeyId(p), keys = Array.isArray(cfg.APIKEYS) ? cfg.APIKEYS : [];
  const hit = keys.find((k) => k && typeof k.key === "string" && k.key.trim() && k.id === want);
  if (hit) return { key: hit.key, profileId: p.id, keyId: want };
  const fields = [...new Set(keys.flatMap((k) => (k && typeof k === "object" ? Object.keys(k) : [])))].sort().join(",");
  return { error: `no API key whose id is "${oneLine(want, 80)}" (the id CCR derives for profile "${oneLine(p.id, 40)}"; ${keys.length} key entries, fields: ${fields || "none"})` };
}
/**
 * Adds, to the SANDBOX config object about to be saved (applyProfile stays false, the live files are never touched), the API key entry CCR would create for the enabled claude-code profile
 * through its applyProfile path, which saveConfig(..., {applyProfile:false}) skips: {createdAt, id: profileKeyId, key: ccr-profile-<24 random url-safe characters>, name: "Profile: <name||id||agent>"}.
 * The key is generated here at run time, never printed and never kept in the plan or the evidence (RUN_SECRETS masks it). Idempotent: an entry with that id and a non-blank key is left alone;
 * one with a blank key gets a key (what CCR's O8 does). Returns {id, added} or null when there is no enabled claude-code profile.
 */
export function ensureProfileKey(cfg) {
  const p = enabledClaudeProfile(cfg);
  if (!p) return null;
  const id = profileKeyId(p);
  if (!Array.isArray(cfg.APIKEYS)) cfg.APIKEYS = [];
  const fresh = () => `ccr-profile-${crypto.randomBytes(18).toString("base64url").slice(0, 24)}`;
  const at = cfg.APIKEYS.findIndex((k) => k && k.id === id);
  if (at >= 0) {
    if (typeof cfg.APIKEYS[at].key === "string" && cfg.APIKEYS[at].key.trim()) return { id, added: false };
    cfg.APIKEYS[at] = { ...cfg.APIKEYS[at], key: fresh() };
    return { id, added: true };
  }
  cfg.APIKEYS.push({ createdAt: new Date().toISOString(), id, key: fresh(), name: `Profile: ${p.name?.trim() || p.id || p.agent}` });
  return { id, added: true };
}

// ---------------------------------------------------------------- the evaluators: pure functions of evidence (unit-tested without a daemon)
const L = (kind, router, id, detail) => formatLine(kind, router, id, detail);
export function evalA0Probe(ev) {
  if (!ev.probe) return L("FAIL", "probe", "A0", `the probe router never ran (CUSTOM_ROUTER_PATH not honoured, or the request was refused first: HTTP ${ev.status ?? "none"})`);
  if (ev.probe.bl !== true) return L("FAIL", "probe", "A0", "builtInClaudeCodeSubagent is not true: the enricher gate is not satisfied (profile key id, user-agent or routing.enhancedRoute; V22), every later PASS would be meaningless");
  if (ev.probe.tag !== TAG_MODEL) return L("FAIL", "probe", "A0", `builtInSubagentModel is ${oneLine(JSON.stringify(ev.probe.tag), 60)}, expected ${TAG_MODEL}`);
  return L("PASS", "probe", "A0", `enricher gate satisfied: builtInClaudeCodeSubagent=true and builtInSubagentModel=${TAG_MODEL} reached the router`);
}
export function evalE4(ev) {
  if (!ev.stubRec) return L("FINDING", "probe", "E4", `no upstream request arrived (HTTP ${ev.status ?? "none"}): E4 unmeasured`);
  if (!ev.probe || ev.probe.mutated !== true) return L("FINDING", "probe", "E4", "the probe router did not report an edit of an Agent tool (no Agent tool in the body, or no probe line): E4 unmeasured");
  if (String(ev.stubRec.agentToolDescription ?? "").includes(E4_MARK)) return L("PASS", "probe", "E4", "the router edit of the Agent tool description reached the upstream (injection, G4, is not blocked by E4)");
  return L("FINDING", "probe", "E4", "the router body edit did NOT reach the upstream: injection (G4) stays off and dynamic relies on the alias path");
}
export function evalE5(ev) {
  if (!ev.stubRec) return L("FINDING", "probe", "E5", "no upstream request arrived: E5 unmeasured");
  if (ev.stubRec.headers?.["x-uw-subpolicy"] === "probe") return L("PASS", "probe", "E5", "the added header reached the upstream");
  return L("FINDING", "probe", "E5", "the added header is ABSENT at the upstream (a finding, not a failure: only visibility and E6b lose)");
}
export function evalE12(ev) {
  const tc = ev.probe?.tokenCount, cl = ev.probe?.contentLength;
  const tcOk = typeof tc === "number" && Number.isFinite(tc), clN = Number(cl), clOk = cl !== null && cl !== undefined && Number.isFinite(clN) && clN > 0;
  if (!ev.probe) return L("FINDING", "probe", "E12", "the probe router did not run: E12 unmeasured");
  if (tcOk && clOk) {
    const up = ev.stubRec?.bodyBytes;
    return L("PASS", "probe", "E12", `tokenCount=${tc} and content-length=${cl} reach the router (upstream received ${up ?? "?"} body bytes${typeof up === "number" ? `, ${up - clN >= 0 ? "+" : ""}${up - clN} against content-length: the router edit and CCR's re-serialisation` : ""})`);
  }
  return L("FINDING", "probe", "E12", `${tcOk ? "" : "tokenCount ABSENT "}${clOk ? "" : "content-length ABSENT or not a positive number "}at the router: ${clOk ? "context-fit" : "payload fit is compile-time only and `set` says so"}`.trim());
}
export function evalE7(probeLines) {
  const mine = probeLines.filter((l) => l && typeof l.n === "number");
  if (mine.length < 3) return L("FINDING", "probe", "E7", `only ${mine.length} probe lines: E7 unmeasured`);
  const pids = new Set(mine.map((l) => l.pid));
  if (pids.size > 1) return L("FINDING", "probe", "E7", `requests were served by ${pids.size} processes: globalThis persistence cannot be judged`);
  const ms = mine.map((l) => l.m);
  if (ms.some((x) => typeof x !== "number")) return L("FINDING", "probe", "E7", "the probe lines carry no module-scope control counter m: E7 unmeasured (n alone cannot tell persistence from a cache that was never deleted)");
  if (ms.some((x) => x > 1)) return L("FINDING", "probe", "E7", `cache not deleted: the module-scope control counter m=${ms.join(",")} rose, so the module was NOT re-evaluated per request and a rising n proves nothing about globalThis persistence`);
  const ok = mine.every((l, i) => i === 0 || l.n === mine[i - 1].n + 1);
  return ok ? L("PASS", "probe", "E7", `globalThis counter n=${mine.map((l) => l.n).join(",")} persists while the module-scope control m stays 1 (the module is re-evaluated on every request: the require cache is deleted per request)`)
    : L("FINDING", "probe", "E7", `globalThis counter ${mine.map((l) => l.n).join(",")} did NOT persist: main learning must rely on its files`);
}
/** ev = {control, clear}, each {status, stubRec, probe}. The control arm (probe mode keep-tag: router returns undefined, clears nothing) must show the tag HONOURED; only then does the clear-tag arm count. */
export function evalE13(ev) {
  const c = ev.control, k = ev.clear;
  if (!c?.probe || c.probe.mode !== "keep-tag") return L("FINDING", "probe", "E13", "E13 undecidable: the control arm (probe mode keep-tag) did not run");
  if (!c.stubRec) return L("FINDING", "probe", "E13", `E13 undecidable: the control arm reached no upstream (HTTP ${c.status ?? "none"}), so the tag mechanism itself is not shown to work`);
  if (!modelIs(c.stubRec.model, TAG_MODEL)) return L("FINDING", "probe", "E13", `E13 undecidable: the control arm did not show the tag honoured (upstream served ${oneLine(c.stubRec.model, 60)}, expected ${TAG_MODEL} or ${bareOf(TAG_MODEL)})`);
  const spelling = spellingOf(c.stubRec.model, TAG_MODEL);
  if (!k?.probe || k.probe.mode !== "clear-tag") return L("FINDING", "probe", "E13", "the probe did not run in clear-tag mode: E13 unmeasured");
  if (!k.stubRec) return L("FINDING", "probe", "E13", `inconclusive: nothing was served (HTTP ${k.status ?? "none"}); the tag was not honoured but no model answered`);
  if (modelIs(k.stubRec.model, TAG_MODEL)) return L("FINDING", "probe", "E13", `clearing builtInSubagentModel did NOT stop CCR honouring the tag (served ${oneLine(k.stubRec.model, 60)}): UNRESOLVABLE_ASKED stays the only signal for an out-of-set tag`);
  return L("PASS", "probe", "E13", `clearing builtInSubagentModel stopped the tag: the control arm served the tag (${oneLine(c.stubRec.model, 60)}, ${spelling} spelling), the clear arm served ${oneLine(k.stubRec.model, 60)} (${spellingOf(k.stubRec.model, ANCHOR) === "other" ? "not the tag" : spellingOf(k.stubRec.model, ANCHOR)})`);
}
export function evalA1(ev) {
  const exp = ev.expected;
  const same = Array.isArray(ev.models) && ev.models.length === exp.length && ev.models.every((m, i) => modelIs(m, exp[i]));
  if (!same) return L("FAIL", "next", "A1", `policy absent: the upstream received ${JSON.stringify(ev.models)}, expected exactly ${JSON.stringify(exp)} (selector or bare spelling)`);
  if (ev.stateDirExists) return L("FAIL", "next", "A1", "policy absent but the router created its state directory (it must stay silent)");
  const sp = [...new Set(ev.models.map((m, i) => spellingOf(m, exp[i])))].join("+");
  return L("PASS", "next", "A1", `policy absent: the upstream received exactly the requested models ${ev.models.join(", ")} (spelling: ${sp}) and the router wrote nothing`);
}
export function evalA0Next(ev) {
  if (!ev.classify || ev.classify.bl !== 1) return L("FAIL", "next", "A0", `the router's class log shows bl=${ev.classify ? ev.classify.bl : "no line"}: the enricher gate is not satisfied on the exact bytes`);
  if (!ev.decision || ev.decision.tag !== TAG_MODEL) return L("FAIL", "next", "A0", `the router's decision log shows tag=${ev.decision ? oneLine(String(ev.decision.tag), 60) : "no line"}, expected ${TAG_MODEL}`);
  return L("PASS", "next", "A0", `enricher gate satisfied on the exact bytes: bl=1 and tag=${TAG_MODEL} in the router's own logs`);
}
/**
 * Router v2 writes ONE decision line to decisions.jsonl AND, for a new agent, one line to agents.jsonl (`ev.agents`: the parsed lines of agents.jsonl; a flow always passes the array, so
 * an empty file is a FAIL, never a pass by omission). A caller that passes no `agents` (an older unit test) is judged on decisions.jsonl alone.
 */
export function evalA2(ev) {
  const d = ev.decision;
  if (!d) return L("FAIL", "next", "A2", "no shadow decision line was written");
  if (d.would !== TAG_MODEL) return L("FAIL", "next", "A2", `decision would=${oneLine(String(d.would), 60)}, expected ${TAG_MODEL}`);
  if (d.ret !== ASKED_MODEL || !modelIs(ev.stubModel, ASKED_MODEL)) return L("FAIL", "next", "A2", `shadow must return asked: ret=${oneLine(String(d.ret), 60)}, upstream received ${oneLine(String(ev.stubModel), 60)}`);
  let ag = "";
  if (ev.agents !== undefined) {
    const a = (ev.agents ?? []).find((x) => x && x.aid === "uws0-a2" && x.path === "shadow");
    if (!a) return L("FAIL", "next", "A2", `agents.jsonl has no shadow line for the new agent uws0-a2 (${(ev.agents ?? []).length} lines): router v2 logs one line per new agent there as well as in decisions.jsonl`);
    if (a.would !== TAG_MODEL || a.ret !== ASKED_MODEL) return L("FAIL", "next", "A2", `agents.jsonl line disagrees with decisions.jsonl: would=${oneLine(String(a.would), 60)} ret=${oneLine(String(a.ret), 60)}`);
    ag = "; agents.jsonl carries the same would/ret";
  }
  return L("PASS", "next", "A2", `shadow: would=${TAG_MODEL}, ret = asked (${ASKED_MODEL}), upstream model = asked (${oneLine(ev.stubModel, 60)}, ${spellingOf(ev.stubModel, ASKED_MODEL)} spelling)${ag}`);
}
/**
 * ev: {loadFailure, status (status.json), first (status.json at the first flush), min, logFiles} plus, for router v2: `workerFiles` (the number of status-<w>.json files next to
 * status.json) and `registry` ({keys, own, pid} read by a probe in the same process after the run: the size of globalThis.__uwRouterImpl, the stat-keyed loader registry, which must hold ONE key,
 * the router file). Both are optional here (older unit tests: with no `registry` key the line carries no registry sentence); a flow always passes both keys, `registry` undefined when the peek returned nothing, and that is SAID in the line, not passed over.
 */
export function evalA8(ev) {
  if (ev.loadFailure) return L("FAIL", "next", "A8", "CCR logged `Failed to load custom router` for the exact bytes (E7)");
  const req = ev.status?.counters?.req;
  if (!(Number.isFinite(req) && req >= ev.min)) return L("FAIL", "next", "A8", `globalThis counters did not accumulate: counters.req=${req}, expected at least ${ev.min} (state reset per request?)`);
  if (!ev.first || typeof ev.first.since !== "string") return L("FAIL", "next", "A8", "no status.json was captured at the first flush: status.since stability cannot be judged");
  if (ev.status.since !== ev.first.since) return L("FAIL", "next", "A8", `status.since changed between the first flush (${oneLine(ev.first.since, 30)}) and the last (${oneLine(String(ev.status.since), 30)}): the router state was reset`);
  if (ev.workerFiles !== undefined && !(ev.workerFiles >= 1)) return L("FAIL", "next", "A8", "no status-<w>.json exists next to status.json: router v2 writes a per-worker status file as well");
  const r = ev.registry;
  if (r && r.keys > 1) return L("FAIL", "next", "A8", `globalThis.__uwRouterImpl holds ${r.keys} keys (pid ${r.pid}) after ${req} requests: the loader registry grows, one key (the router file) is expected`);
  const notes = [];
  if (ev.workerFiles !== undefined) notes.push(`${ev.workerFiles} status-<w>.json file${ev.workerFiles === 1 ? "" : "s"} next to status.json (pid ${oneLine(String(ev.status.pid ?? "?"), 10)})`);
  if (!("registry" in ev)) { /* an older caller: no registry judgement */ }
  else if (r === undefined || r === null) notes.push("implementation registry globalThis.__uwRouterImpl NOT OBSERVED (no peek ran)");
  else if (r.keys === 1 && r.own) notes.push(`__uwRouterImpl holds 1 key (the router file) in pid ${r.pid}${ev.status.pid !== undefined && ev.status.pid !== r.pid ? ` (the status worker is pid ${ev.status.pid}: another worker)` : ""}`);
  else notes.push(`registry not seen by the peek (pid ${r.pid}, ${r.keys} keys, own entry ${r.own ? "yes" : "no"}): that worker never held the router, or the entry was replaced; not a failure`);
  const note = ev.logFiles === 0 ? " NOTE: 0 CCR log files were found, so the absence of `Failed to load custom router` is UNVERIFIED (nothing to search)" : "";
  return L("PASS", "next", "A8", `globalThis persisted across ${req} requests (counters.req=${req}), status.since stable (${oneLine(ev.status.since, 30)})${notes.length ? `; ${notes.join("; ")}` : ""}; no \`Failed to load custom router\` in ${ev.logFiles} CCR log files.${note}`);
}
export function evalA11(phase, before, after) {
  if (before.liveServicePid == null || before["listener:3456"] == null) {
    return L("FINDING", phase, "A11", `the live gateway was not observed in the baseline (service.json pid ${before.liveServicePid ?? "none"}, listener 3456 ${before["listener:3456"] ?? "none"}): "untouched" cannot be asserted`);
  }
  const watch = diffFingerprint(before, after).filter((x) => /^(listener:|liveService|settings|claudeSettingsNames)/.test(x));
  return watch.length ? L("FAIL", phase, "A11", `the live gateway or its files changed: ${watch.join("; ")}`)
    : L("PASS", phase, "A11", `live gateway untouched: ${describeFingerprint(after)}`);
}

/**
 * A synthetic SHADOW policy for the exact-bytes run. It is a router INPUT, not compiler output, but it is built to the SAME SHAPE as keysync/subagent-policy.mjs compile()
 * (a test compares the key sets of every object against a real compile of the fixture trio): rows hold s,c,f,t,h,m,n,i,p,pb,al,fp,ft,g with `i` the compiler's
 * `$in/$out` text, and under source all-providers `lists.byProvider` is empty. `synthetic: true` is the ONE extra key. The router's own loader must accept it
 * (state ok in status.json, unit-tested against the real bytes).
 */
export function buildShadowPolicy(now = new Date()) {
  const row = (s) => ({ s, c: 200000, f: 0, t: "v", h: 0, m: 0, n: 0, i: "$0/$0", p: 0, pb: 0, al: 0, fp: 0, ft: 0, g: 0, b: 0 });
  const models = STUB_MODELS.map((m) => row(`uwstub/${m}`));
  const p = {
    schema: 1, synthetic: true, minRouter: 2, rollout: { canaryPct: 100, salt: "uw-r1" }, contentHash: "", compiledAt: now.toISOString(),
    owner: { source: "all-providers", mode: "dynamic", freeScope: "providers", ctx: "any", enforcement: "shadow", inject: "off", unverified: "allow-warn", classLog: "on", banded: true, handoffNotice: true },
    builtFrom: { snapshotBuiltAt: null, snapshotSchema: null, benchGeneratedAt: null, observedWrittenAt: null, tfAsOf: null, inputsHash: null, providersLive: false, providersHash: null, tiersHash: null, ownerHash: null, compiler: 1, tierWarnings: [] },
    empty: false, emptyReasons: [], emptyProviders: [], thinProviders: [], tiers: { uwstub: "free" }, substitutable: { uwstub: models.length, "*": models.length },
    exempt: [], ctxHints: {},
    counts: { universe: models.length, allowed: models.length, verified: models.length, small: 0, unverified: 0, premium: 0, payloadRisk: 0, payloadUnknown: models.length, tfAsOf: null, alias: 0,
      freeScopes: {}, depositStrictSkipped: 0, idRejected: 0, funnel: [] },
    models, lists: { all: null, byProvider: {}, prov: { uwstub: models.map((_, i) => i) } },       // router v2 shapes: `all` is null when it is the identity, `prov` lists every provider's rows
    main: { ttlSec: 21600 }, sticky: { ttlSec: 21600, maxEntries: 256 }, inject: { all: "", byProvider: {}, empty: "", promptNote: "" },
  };
  p.contentHash = policyContentHash(p);                                // router v2 VERIFIES the hash: the synthetic file carries the real one (a test pins this to the compiler's hashOf)
  return p;
}
// The compiler's hashOf (keysync/subagent-policy.mjs), rule for rule, kept here because the harness imports nothing from keysync/: the allow-listed keys in order,
// the owner block without the behaviour-only fields (enforcement, classLog, handoffNotice), sha256, the first 12 hex characters.
const HASH_KEYS = ["schema", "owner", "empty", "emptyProviders", "thinProviders", "tiers", "substitutable", "exempt", "ctxHints", "models", "lists"];
const HASH_OWNER_EXCLUDE = ["enforcement", "classLog", "handoffNotice"];
export function policyContentHash(p) {
  const owner = Object.fromEntries(Object.entries(p.owner).filter(([k]) => !HASH_OWNER_EXCLUDE.includes(k)));
  return crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(HASH_KEYS.map((k) => [k, k === "owner" ? owner : p[k]])))).digest("hex").slice(0, 12);
}

/**
 * The ENFORCE variant for the handoff smoke (H1): the same synthetic file with owner.enforcement "enforce" (mode dynamic, source all-providers, handoffNotice on). `enforcement` is not
 * part of the hash, so it carries the same contentHash as the shadow file. The three stub rows are one band with one tool tier, so a handoff from m-big has a non-cooling target.
 */
export function buildEnforcePolicy(now = new Date()) {
  const p = buildShadowPolicy(now);
  p.owner = { ...p.owner, enforcement: "enforce" };
  p.contentHash = policyContentHash(p);
  return p;
}

// ---------------------------------------------------------------- the revision 10 experiments (plan 12.2 X1-X9, 12.1 S0, 6.1b E handoff smoke): pure functions of evidence
export const X8_MARK = "[uwpr-x8]";                                   // the marker the probe router appends (probe-router.cjs)
export const NOTICE_MARK = "[UW handoff]";                            // the marker the router's handoff notice starts with (router v2 injectNotice)
export const X1_MODEL = "m-x1";                                       // the model the X1 Providers edit adds to (and removes from) the sandbox stub provider
/** The X9 matrix: Router.fallback modes x upstream failures. Every case scripts [failure, 200], so a fallback attempt, if CCR makes one, finds a 200. */
export const X9_MODES = ["off", "model-chain", "retry"];
export const X9_CASES = [
  { id: "ra3", step: { status: 429, retryAfter: 3 } }, { id: "ra3600", step: { status: 429, retryAfter: 3600 } }, { id: "ra-none", step: { status: 429 } },
  { id: "400", step: { status: 400 } }, { id: "413", step: { status: 413 } }, { id: "502", step: { status: 502 } },
];
/** A hot-swap value for Router.fallback: ONE stub model for the chain, one retry for `retry` (the waits are CCR's own sleeps, clamped to 60 s). */
export const fallbackFor = (mode) => (mode === "off" ? { mode: "off", models: [] } : mode === "model-chain" ? { mode, models: [TAG_MODEL], retryCount: 1 } : { mode, models: [], retryCount: 1 });
const UNM = (id, why) => L("FINDING", "probe", id, `unmeasured: ${why}`);
const plural = (n, w, many = `${w}s`) => `${n} ${n === 1 ? w : many}`;

/** ev: {l1, l2, l3} three consecutive probe call lines (A, B before a sandbox Providers edit, C after it) and edit: {ok, why, gwBefore, gwAfter}. */
export function evalX1(ev) {
  const [a, b, c] = [ev?.l1, ev?.l2, ev?.l3];
  if (!a?.cfg || !b?.cfg || !c?.cfg) return UNM("X1", "fewer than three probe lines carry a config record");
  if (!ev.edit?.ok) return UNM("X1", `the Providers edit through the sandbox web RPC did not complete (${oneLine(ev.edit?.why ?? "no detail", 120)})`);
  if (new Set([a.pid, b.pid, c.pid]).size > 1) return UNM("X1", `the three calls were served by ${new Set([a.pid, b.pid, c.pid]).size} processes (${[a.pid, b.pid, c.pid].join(",")}): object identity cannot be compared across processes`);
  const gw = ev.edit.gwBefore === ev.edit.gwAfter ? `gateway pid unchanged (${ev.edit.gwAfter ?? "?"})` : `gateway pid CHANGED ${ev.edit.gwBefore ?? "?"} -> ${ev.edit.gwAfter ?? "?"}: the edit restarted it`;
  const obj = (same) => (same ? "same object" : "NEW object");
  const facts = `across two requests: config ${obj(b.cfg.same)}, Providers ${obj(b.cfg.provSame)}; across the edit: config ${obj(c.cfg.same)}, Providers ${obj(c.cfg.provSame)}, fingerprint ${b.cfg.fp === c.cfg.fp ? "UNCHANGED" : "changed"}, ${b.cfg.provN} -> ${c.cfg.provN} providers; ${gw}`;
  if (b.cfg.fp === c.cfg.fp) return L("FINDING", "probe", "X1", `the Providers edit is not visible at the router (fingerprint unchanged): ${facts}`);
  if (c.cfg.provSame === true) return L("FINDING", "probe", "X1", `Providers is the SAME array after an edit (mutated in place): an identity-keyed cache would go stale, so the index must carry a fingerprint or compare lengths too: ${facts}`);
  return L("PASS", "probe", "X1", `an edit gives a NEW Providers array, so an identity-keyed index rebuilds on its own: ${facts}`);
}

/** ev: {sent, lines}: the number of concurrent requests sent and the probe call lines they produced. */
export function evalX2(ev) {
  const lines = (ev?.lines ?? []).filter((l) => l && Number.isInteger(l.pid));
  if (!(ev?.sent > 0) || lines.length < ev.sent) return UNM("X2", `${lines.length} probe lines for ${ev?.sent ?? 0} concurrent requests`);
  const pids = [...new Set(lines.map((l) => l.pid))].sort((x, y) => x - y);
  return L("PASS", "probe", "X2", `${plural(lines.length, "concurrent request")} were served by ${plural(pids.length, "distinct process", "distinct processes")} (pids ${pids.join(",")}); ${pids.length === 1
    ? "ONE worker: the cross-worker paths (journal tail reads, per-worker status, cooling.json) are built and unit-tested but cannot be exercised live"
    : "several workers: the cross-worker paths can be exercised live"}`);
}

/** ev: {cases: [{name, steps: [{sent, status, headers, routerRetry, upstream, upRetry}, {...}]}]}: the same body twice (retry-count 0 then 1) against a forced upstream failure. */
export function evalX3(ev) {
  const cases = ev?.cases ?? [];
  if (!cases.length || cases.some((c) => (c.steps ?? []).length !== 2 || c.steps.some((s) => s.routerRetry === undefined || !Number.isInteger(s.upstream)))) return UNM("X3", "a case has no complete pair of requests");
  if (cases.some((c) => c.steps.some((s) => s.status == null))) return UNM("X3", `the client got no HTTP answer to ${cases.filter((c) => c.steps.some((s) => s.status == null)).map((c) => c.name).join(", ")} (a transport error or timeout): "client saw" cannot be reported`);
  const issues = [], facts = [];
  for (const c of cases) {
    const [s0, s1] = c.steps, ra = s0.headers?.["retry-after"];
    facts.push(`${c.name}: router saw retry-count ${[s0, s1].map((s) => s.routerRetry ?? "absent").join(",")}, upstream attempts ${c.steps.map((s) => s.upstream).join(",")}, client saw ${c.steps.map((s) => s.status).join(",")}${ra ? ` retry-after ${oneLine(ra, 10)}` : ""}`);
    if (s1.routerRetry !== "1") issues.push(`${c.name}: the retry-count header did NOT reach the router on the retried request, so len is the only retry signal`);
    if (c.steps.some((s) => s.upstream !== 1)) issues.push(`${c.name}: CCR made ${c.steps.map((s) => s.upstream).join("/")} upstream attempts per inbound request with Router.fallback off: its own fallback is NOT off by default`);
  }
  const tail = "(whether Claude Code itself retries is NOT claimed: 6.1c binary analysis; the real client is S2d)";
  return issues.length ? L("FINDING", "probe", "X3", `${issues.join("; ")}. ${facts.join("; ")} ${tail}`) : L("PASS", "probe", "X3", `${facts.join("; ")}; CCR fallback off by default (1 attempt per request) ${tail}`);
}

/** ev: {probe, stubRec, sent: {agentId}}: a request with a team agent id (`name@session`), a parent agent id and a session id. */
export function evalX4(ev) {
  const hd = ev?.probe?.hdr;
  if (!hd) return UNM("X4", "no probe line with a header record");
  const { aid, par, sid } = hd, issues = [];
  if (!aid) issues.push("x-claude-code-agent-id did not reach the router");
  else {
    if (!aid.at) issues.push("the team agent id lost its @ part");
    if (!aid.ok) issues.push(`the agent id form ${aid.form} FAILS ^[A-Za-z0-9_@.:-]{1,128}$: widen the charset BEFORE G2`);
    if (ev.sent?.agentId && aid.len !== ev.sent.agentId.length) issues.push(`the agent id changed in transit (${ev.sent.agentId.length} characters sent, ${aid.len} seen)`);
  }
  if (!par) issues.push("x-claude-code-parent-agent-id is absent at the router");
  if (!sid) issues.push("x-claude-code-session-id is absent at the router");
  const up = !ev.stubRec ? "no upstream record (whether the agent id is forwarded upstream is unmeasured)" : ev.stubRec.headers?.["x-claude-code-agent-id"] ? "forwarded upstream" : "not forwarded upstream";
  const facts = `agent id ${aid ? `present (${aid.len} characters, form ${aid.form}, charset ${aid.ok ? "ok" : "REJECTED"})` : "ABSENT"}; parent id ${par ? `present (${par.len} characters, form ${par.form})` : "ABSENT"}; session id ${sid ? "present" : "ABSENT"}; ${up}`;
  return issues.length ? L("FINDING", "probe", "X4", `${issues.join("; ")}. ${facts}`) : L("PASS", "probe", "X4", `team ids pass through to the router unchanged in shape: ${facts}`);
}

/** ev: {sent: [lengths sent in order], lines: probe call lines in order}. The retry of the third request is the same body again; the last length is a compaction. */
export function evalX5(ev) {
  const lines = ev?.lines ?? [], sent = ev?.sent ?? [], lens = lines.map((l) => l.ml);
  if (!sent.length || lines.length !== sent.length || lens.some((n) => !Number.isInteger(n))) return UNM("X5", `${lines.length} probe lines for ${sent.length} requests`);
  if (lens.join() !== sent.join()) return L("FINDING", "probe", "X5", `the router sees messages.length ${lens.join(",")} but ${sent.join(",")} were sent: CCR changes the length on the way, and the len retry signal reads the changed value`);
  const fires = lens.map((n, i) => i > 0 && n === lens[i - 1]);
  const retryAt = sent.findIndex((n, i) => i > 0 && n === sent[i - 1]);
  if (retryAt > 0 && lines[retryAt].lh !== lines[retryAt - 1].lh) return L("FINDING", "probe", "X5", `the retried body's last message differs from the first attempt's (hash ${lines[retryAt - 1].lh} vs ${lines[retryAt].lh}): not a byte-identical retry at the router`);
  const only = fires.every((f, i) => f === (i === retryAt));
  if (!only) return L("FINDING", "probe", "X5", `the len rule (length equals the previous one) fires at positions ${fires.map((f, i) => (f ? i + 1 : 0)).filter(Boolean).join(",") || "none"}, expected only the retry at ${retryAt + 1}: lengths ${lens.join(",")}`);
  return L("PASS", "probe", "X5", `the router sees ${lens.join(",")}: only the repeated ${lens[retryAt]} equals the previous length (the len retry signal fires once, on the retry, last-message hash identical); growth by 2 and the compaction drop to ${lens[lens.length - 1]} do not fire it; no normal turn repeated a length here`);
}

/** ev: {log: the probe.jsonl lines of the arm in order (call lines and `timer` lines)}: call A in mode timer, then call B in mode observe at once, then a wait. REQUIRED: its line must exist, and FAIL fails the run. */
export function evalX7(ev) {
  const log = ev?.log ?? [], calls = log.filter((l) => l && typeof l.n === "number");
  const a = calls.find((l) => l.timer === true), ia = log.indexOf(a), b = calls.find((l) => l !== a && log.indexOf(l) > ia);
  if (!a || !b) return UNM("X7", "the timer call or the call after it has no probe line");
  if (a.pid !== b.pid) return L("FINDING", "probe", "X7", `X7 undecidable: calls served by different workers (pid ${a.pid ?? "?"} for the timer call, pid ${b.pid ?? "?"} for the next): a fresh worker has m=1 trivially, so the cache-entry deletion is not shown`);
  if (!(b.m <= 1)) return L("FINDING", "probe", "X7", `X7 undecidable: the module was not re-evaluated by the next call (m=${b.m}), so the cache entry was not deleted between them`);
  const t = log.find((l) => l && l.kind === "timer" && l.of === a.n && l.pid === a.pid);   // n is a per-process counter: the timer line must come from the process that armed it
  if (!t) return L("FAIL", "probe", "X7", "the request-scoped setTimeout(...).unref() did NOT fire after the next request had re-evaluated the module (m=1): remove the failure-path retry timer, a failed flush then waits for the next request's flush");
  if (log.indexOf(t) < log.indexOf(b)) return L("FINDING", "probe", "X7", "the timer fired BEFORE the next call was recorded, so the cache-entry deletion was not in between: inconclusive, repeat");
  return L("PASS", "probe", "X7", `a request-scoped setTimeout(...).unref() fired ${Date.parse(t.t) - Date.parse(a.t)} ms after its request, AFTER the next request re-evaluated the module (m=${b.m}, n=${b.n}: the cache entry was deleted): the failure-path retry timer is viable`);
}

/** One X8 arm. arm: {probe, stubRec, sent: {messages, tools, blocks, ccIdx, stripped}} (sent = the sha256 of the messages and tools and the system blocks the harness sent). Returns the problems, or null when the arm is unmeasured. */
function x8Arm(shape, arm) {
  const { probe, stubRec: r, sent } = arm ?? {};
  if (!probe || !r || !sent) return null;
  const bad = [];
  if (probe.edited !== true) bad.push(`the probe did not edit the ${shape} system (shape at the router: ${probe.before?.shape ?? "?"})`);
  if (r.systemShape !== shape) bad.push(`the upstream system shape is ${r.systemShape}, ${shape} was sent`);
  if (r.markers?.[X8_MARK] !== true) bad.push(`the ${shape} marker did NOT reach the upstream`);
  if (r.messagesSha256 !== sent.messages) bad.push(`messages differ at the upstream (${shape})`);
  if (r.toolsSha256 !== sent.tools) bad.push(`tools differ at the upstream (${shape})`);
  if (shape === "array") {
    // CCR 3.0.22 (VUe) REMOVES the leading x-anthropic-billing-header block of a subagent-flagged array system before the custom router runs: the harness reports how many it sent (`stripped`), so the
    // expected count is the original blocks minus those plus the marker block, and cache_control moves up by the same number
    const strip = sent.stripped ?? 0, ccWant = sent.ccIdx - strip;
    if (r.sysBlocks !== sent.blocks - strip + 1) bad.push(`the upstream holds ${r.sysBlocks} system blocks, ${sent.blocks - strip + 1} expected (the ${sent.blocks} sent, minus ${strip} billing block${strip === 1 ? "" : "s"} CCR strips, plus the marker block)`);
    if (!(r.sysCc ?? []).includes(ccWant)) bad.push(`cache_control on system block ${ccWant} (${sent.ccIdx} as sent) is GONE at the upstream (blocks with it: ${(r.sysCc ?? []).join(",") || "none"})`);
  }
  return bad;
}
/** ev: {string: arm, array: arm}. Plain /v1/messages path only: the OpenAI-converted path needs a second stub provider and is NOT-RUN. */
export function evalX8(ev) {
  const s = x8Arm("string", ev?.string), a = x8Arm("array", ev?.array);
  if (s === null || a === null) return UNM("X8", `the ${s === null ? "string" : "array"} arm has no probe line or no upstream request`);
  const bad = [...s, ...a];
  if (bad.length) return L("FINDING", "probe", "X8", `${bad.join("; ")}: the handoff notice is BEST EFFORT and the runbook says so (the handoff still shows in last, the status headline and show)`);
  return L("PASS", "probe", "X8", `a router edit of the system prompt reaches the upstream in both shapes on the plain /v1/messages path (string: marker appended; array: marker block appended, cache_control kept on block ${ev.array.sent.ccIdx - (ev.array.sent.stripped ?? 0)}${ev.array.sent.stripped ? ` after CCR stripped the ${ev.array.sent.stripped} billing block` : ""}); messages and tools byte-identical by sha256; the OpenAI-converted path is NOT-RUN`);
}

const x9case = (ev, mode, id) => (ev?.cases ?? []).find((c) => c.mode === mode && c.id === id);
/** ev: {gw: {before, after}, cases: [{mode, id, status, headers, ms, attempts, models, routerCalls}], main: {attempts, status}}. X9 f/g/h are not here (PARKED / NOT-RUN). */
export function evalX9a(ev) {
  const off = x9case(ev, "off", "ra-none"), chain = x9case(ev, "model-chain", "ra-none"), retry = x9case(ev, "retry", "ra-none");
  if (!off || !chain || !retry || !ev.gw) return UNM("X9a", `the 429-without-Retry-After case is missing for off, model-chain or retry${ev.swapErrors?.length ? ` (swap errors: ${ev.swapErrors.join(" | ")})` : ""}`);
  const att = `attempts for a 429 without Retry-After: off ${off.attempts}, model-chain ${chain.attempts}, retry ${retry.attempts}`;
  if (ev.gw.before == null || ev.gw.before !== ev.gw.after) return L("FINDING", "probe", "X9a", `the sandbox gateway pid changed or was not observed (${ev.gw.before ?? "none"} -> ${ev.gw.after ?? "none"}) while Router.fallback was swapped: not shown to be a hot swap (R1). ${att}`);
  if (!(chain.attempts > off.attempts) && !(retry.attempts > off.attempts)) return L("FINDING", "probe", "X9a", `the swap was not observed to take effect (${att})`);
  return L("PASS", "probe", "X9a", `Router.fallback was hot-swapped through the web RPC with the gateway pid unchanged (${ev.gw.after}); ${att}`);
}
/** The detail lines of the X9 matrix (printed by the run; the X9b line itself only counts). Request-log columns are not read: no harness seam opens the sandbox database. */
export function x9Table(ev) {
  return X9_MODES.flatMap((mode) => X9_CASES.map((cs) => {
    const c = x9case(ev, mode, cs.id);
    if (!c) return `  X9 ${mode.padEnd(11)} ${cs.id.padEnd(8)} NOT MEASURED`;
    const fb = Object.entries(c.headers ?? {}).filter(([k]) => k.startsWith("x-ccr-")).map(([k, v]) => `${k}=${oneLine(v, 30)}`).join(" ") || "none";
    return `  X9 ${mode.padEnd(11)} ${cs.id.padEnd(8)} client status ${c.status ?? "none"}, upstream attempts ${c.attempts}, router calls ${c.routerCalls}, delay ${((c.ms ?? 0) / 1000).toFixed(1)} s, retry-after ${c.headers?.["retry-after"] ?? "none"}, x-ccr-* ${fb}, models ${(c.models ?? []).map(bareOf).join(">") || "none"}`;
  }));
}
export function evalX9b(ev) {
  const total = X9_MODES.length * X9_CASES.length, got = X9_MODES.flatMap((m) => X9_CASES.map((c) => x9case(ev, m, c.id))).filter((c) => c && c.status != null).length;   // a case the client never got an answer to is not a measurement
  if (got < total) return L("FINDING", "probe", "X9b", `only ${got} of ${total} cases (3 modes x 6 failures) were answered: the table is incomplete${ev.swapErrors?.length ? ` (swap errors: ${ev.swapErrors.join(" | ")})` : ""}`);
  return L("PASS", "probe", "X9b", `${got} of ${total} cases answered (status at the client, attempts, delay, x-ccr-fallback-* headers; the table is printed above); request_logs fields (resolved_model, route_attempt_count, gateway_final_attempt, gateway_error): not recorded (no harness seam reads the sandbox database)`);
}
export function evalX9c(ev) {
  const all = [...(ev?.cases ?? []), ...(ev?.main ? [ev.main] : [])];
  if (!all.length) return UNM("X9c", "no case was run");
  const many = all.filter((c) => c.routerCalls !== 1), retried = all.filter((c) => c.attempts > 1);
  if (many.length) return L("FINDING", "probe", "X9c", `${many.length} of ${all.length} inbound requests reached the probe router other than once (${many.slice(0, 4).map((c) => `${c.mode}/${c.id}=${c.routerCalls}`).join(", ")}): a fallback attempt re-runs, or an attempt skips, the custom router`);
  if (!retried.length) return L("FINDING", "probe", "X9c", `no upstream retry or fallback attempt happened in any of ${all.length} cases, so "a fallback attempt does not re-run the router" is untested`);
  return L("PASS", "probe", "X9c", `the probe router saw exactly 1 call per inbound request in ${all.length} of ${all.length} requests, including ${retried.length} with more than one upstream attempt (a fallback attempt does not re-run the custom router)`);
}
export function evalX9d(ev) {
  const m = ev?.main, chain = x9case(ev, "model-chain", "ra-none");
  if (!m || !chain) return UNM("X9d", "the main-shaped model-chain case or the subagent model-chain case is missing");
  if (!(chain.attempts > 1)) return L("FINDING", "probe", "X9d", `the chain made no second attempt even for the subagent case (attempts ${chain.attempts}): scope cannot be judged`);
  return m.attempts > 1 ? L("PASS", "probe", "X9d", `the model-chain also applies to a MAIN-shaped request (${m.attempts} upstream attempts, client status ${m.status}): the fallback is global`)
    : L("FINDING", "probe", "X9d", `the model-chain did NOT apply to a MAIN-shaped request (${m.attempts} attempt, client status ${m.status}) although it did to the subagent request: contradicts "global" (6.1c)`);
}
export function evalX9e(ev) {
  const a = x9case(ev, "off", "ra3"), b = x9case(ev, "off", "ra3600");
  if (!a || !b) return UNM("X9e", "the fallback-off Retry-After 3 or 3600 case is missing");
  if (a.status == null || b.status == null) return UNM("X9e", "the fallback-off Retry-After 3 or 3600 case got no HTTP answer (a transport error or timeout), so what CCR forwards is not known");
  const ra = [a.headers?.["retry-after"], b.headers?.["retry-after"]];
  if (ra.some((v) => v === undefined)) return L("FINDING", "probe", "X9e", `with the fallback off CCR did NOT forward the upstream retry-after to the client (sent 3 and 3600, client saw ${ra.map((v) => v ?? "none").join(" and ")}): Claude Code never sees the server's delay`);
  return L("PASS", "probe", "X9e", `with the fallback off CCR forwards the upstream retry-after to the client (sent 3 and 3600, client saw ${ra.join(" and ")}${ra[0] !== "3" || ra[1] !== "3600" ? ": CHANGED in transit" : ""})`);
}

/**
 * H1, the handoff smoke on the exact bytes with the ENFORCE policy (informational: a mismatch is a FINDING with the observed values, never a failure of the run).
 * ev: {recs: [the three stub records, in order], agents: the agents.jsonl lines of the agent, x8Reached: true|false|null (X8 array arm, null when X8 did not run), aid}
 * Expected: request 2 (same length: the len retry signal) is served by a DIFFERENT model than request 1, agents.jsonl holds ONE act:"handoff" line with from, to and aid_full, the notice
 * marker is at the stub on request 2 only (and only when X8 showed a system edit reaches the upstream), request 3 (grown messages) stays on the new model with no new handoff.
 */
export function evalH1(ev) {
  const recs = ev?.recs ?? [];
  if (recs.length !== 3) return L("FINDING", "next", "H1", `handoff smoke unmeasured: ${recs.length} of 3 requests reached the stub`);
  const [r1, r2, r3] = recs, m = recs.map((r) => bareOf(r.model)), hand = (ev.agents ?? []).filter((l) => l && l.act === "handoff");
  const bad = [];
  if (m[0] === m[1]) bad.push(`request 2 (same length) was served by the SAME model ${m[1]} as request 1: no handoff`);
  if (hand.length !== 1) bad.push(`agents.jsonl holds ${hand.length} handoff lines, 1 expected`);
  else {
    const h = hand[0];
    if (!h.from || !h.to || h.aid_full !== ev.aid) bad.push(`the handoff line lacks from/to/aid_full (from ${h.from ?? "none"}, to ${h.to ?? "none"}, aid_full ${h.aid_full ?? "none"})`);
    else if (bareOf(h.from) !== m[0] || bareOf(h.to) !== m[1]) bad.push(`the handoff line says ${h.from} -> ${h.to} but the stub saw ${m[0]} then ${m[1]}`);
    if (h.rsrc !== "len") bad.push(`the retry source is ${h.rsrc ?? "none"}, expected len`);
  }
  const mk = (r) => r.markers?.[NOTICE_MARK] === true;
  if (ev.x8Reached === true && !mk(r2)) bad.push("the handoff notice is MISSING from the system at the stub although X8 showed a system edit reaches the upstream");
  if (ev.x8Reached === false && mk(r2)) bad.push("the handoff notice reached the stub although X8 showed a system edit does not");
  if (mk(r1) || mk(r3)) bad.push(`the notice appeared on request ${mk(r1) ? 1 : 3}: it belongs on the first request after a handoff only`);
  if (m[2] !== m[1]) bad.push(`request 3 (grown messages) was served by ${m[2]}, not the handed-off model ${m[1]}`);
  const obs = `requests served by ${m.join(" > ")}, ${plural(hand.length, "handoff line")}, notice at the stub ${[r1, r2, r3].map((r) => (mk(r) ? "yes" : "no")).join("/")}, X8 ${ev.x8Reached === null || ev.x8Reached === undefined ? "not run" : ev.x8Reached ? "reached" : "not reached"}`;
  return bad.length ? L("FINDING", "next", "H1", `${bad.join("; ")}. Observed: ${obs}`) : L("PASS", "next", "H1", `handoff smoke as expected: ${obs}`);
}

// ---------------------------------------------------------------- X6, the standalone host check: renames of a 250 KB file with a concurrent reader, in a directory of its own under the OS temp dir
export const X6_DEFAULTS = { renames: 10000, bytes: 250 * 1024 };
/**
 * Writes N versions of a file of `bytes` bytes through a temp name and an atomic rename onto ONE target while a reader reads the target in a loop, and counts EPERM, EBUSY, other errors and torn
 * reads (a read whose length is not `bytes` or whose first and last 16 bytes disagree). The work uses the ASYNC fs calls (libuv thread pool), so writer and reader really run at the same time.
 * Everything happens inside one fresh directory made under `tmpdir` and removed at the end, also on a signal (`onSignal` registers the handler and returns its unregister function;
 * the default is realOnSignal: SIGINT, SIGTERM, SIGHUP and SIGBREAK stop the work, remove the directory, then exit non-zero). `fsx` is the fs module (a fake in tests).
 * CONTAINMENT: `tmpdir` itself must not lie under a protected folder (NEVER_TOUCH or PROTECTED_ROOTS, realpath-resolved: a TEMP set to ~/Downloads or ~/.claude is refused BEFORE anything is
 * created), the made directory must be a fresh uw-x6- directory under `tmpdir`, and it passes safeWritePath with `tmpdir` as the only extra root (lexical path and realpath, never a protected path).
 */
export async function hostCheckX6({ fsx = fs, tmpdir = os.tmpdir(), renames = X6_DEFAULTS.renames, bytes = X6_DEFAULTS.bytes, out = () => {}, onSignal = realOnSignal } = {}) {
  const protectedHit = [...NEVER_TOUCH, ...PROTECTED_ROOTS].find((r) => isUnder(realish(tmpdir), realish(r)));
  if (protectedHit) throw new Error(`x6 refused: the temp dir ${tmpdir} is under the protected folder ${protectedHit}: nothing was created`);
  const dir = await fsx.promises.mkdtemp(path.join(tmpdir, "uw-x6-"));
  const root = path.resolve(tmpdir).toLowerCase() + path.sep, mine = path.resolve(dir).toLowerCase();
  if (!mine.startsWith(root) || !path.basename(mine).startsWith("uw-x6-")) throw new Error(`x6 refused: ${dir} is not a fresh uw-x6- directory under ${tmpdir}`);
  try { safeWritePath(dir, [tmpdir]); } catch (e) { throw new Error(`x6 refused: ${e.message}`); }
  const target = path.join(dir, "x6.dat"), tmp = path.join(dir, "x6.tmp");
  const body = (i) => { const tag = Buffer.from(String(i % 1e9).padStart(16, "0")); const b = Buffer.alloc(bytes, 0x61); tag.copy(b, 0); tag.copy(b, bytes - 16); return b; };
  const count = (map, e) => { const k = String(e && e.code ? e.code : "OTHER"); map[k] = (map[k] || 0) + 1; };
  const res = { dir, renames, bytes, done: 0, renameErrors: {}, reads: 0, readErrors: {}, torn: 0, ms: 0 };
  const t0 = Date.now();
  let stopped = false, work, removed;
  const cleanup = () => (removed ??= Promise.resolve().then(() => fsx.promises.rm(dir, { recursive: true, force: true })).catch(() => { /* the directory is ours and under the temp dir: a leftover is harmless */ }));
  const unhook = onSignal(async () => { stopped = true; try { await work; } catch { /* the work's own error is reported by the main path */ } await cleanup(); });
  try {
    await fsx.promises.writeFile(target, body(0));
    let writing = true;
    const writer = (async () => {
      for (let i = 1; i <= renames && !stopped; i++) {
        try { await fsx.promises.writeFile(tmp, body(i)); await fsx.promises.rename(tmp, target); res.done++; } catch (e) { count(res.renameErrors, e); }
      }
      writing = false;
    })();
    const reader = (async () => {
      while (writing && !stopped) {
        try {
          const b = await fsx.promises.readFile(target);
          res.reads++;
          if (b.length !== bytes || !b.subarray(0, 16).equals(b.subarray(bytes - 16))) res.torn++;
        } catch (e) { count(res.readErrors, e); }
      }
    })();
    work = Promise.all([writer, reader]);
    await work;
  } finally {
    res.ms = Date.now() - t0;
    await cleanup();
    unhook();
  }
  const tally = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  const c = (m, k) => m[k] || 0;
  const other = (m) => Object.entries(m).filter(([k]) => k !== "EPERM" && k !== "EBUSY").reduce((a, [, v]) => a + v, 0);
  res.summary = [
    `X6 host check: ${res.done} of ${renames} renames of ${bytes} bytes completed in ${(res.ms / 1000).toFixed(1)} s with a concurrent reader (${res.reads} reads)`,
    `X6 rename errors: EPERM ${c(res.renameErrors, "EPERM")}, EBUSY ${c(res.renameErrors, "EBUSY")}, other ${other(res.renameErrors)} (${tally(res.renameErrors)})`,
    `X6 reader errors: EPERM ${c(res.readErrors, "EPERM")}, EBUSY ${c(res.readErrors, "EBUSY")}, other ${other(res.readErrors)} (${tally(res.readErrors)}); torn reads ${res.torn} of ${res.reads}`,
    `X6 verdict (informational): ${c(res.renameErrors, "EPERM") + c(res.renameErrors, "EBUSY") + c(res.readErrors, "EPERM") + c(res.readErrors, "EBUSY") + res.torn === 0 && res.done === renames ? "no EPERM, EBUSY or torn read on this host: the writer retry numbers (5.4) are a precaution, the reader retry rule stays mandatory for cooling.json, main-<sid>.json and the journal" : "EPERM, EBUSY or torn reads OBSERVED: keep the writer retry numbers (5.4) and the mandatory reader retry rule"}`,
  ];
  for (const l of res.summary) out(l);
  return res;
}

// ---------------------------------------------------------------- the real system adapter (thin; every method is injectable)
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
/** Free text that can carry a credential (an exception, an RPC error, a step tail, a refusal) is masked BEFORE it is cut to length and printed. */
const safeMsg = (m, n = 300) => oneLine(redactSecrets(m), n);
const intPid = (pid) => { if (!Number.isInteger(pid) || pid <= 0) throw new Error(`bad pid ${pid}`); return pid; };
const intPort = (p) => { if (!Number.isInteger(p) || p <= 0 || p > 65535) throw new Error(`bad port ${p}`); return p; };
/**
 * The PowerShell texts of the process stop, exported so a test can PARSE them (never run them). LOCALE: the 'no listener' answer of the probe is read from the error id CmdletizationQuery_NotFound or, failing that, the English text
 * 'No MSFT_NetTCPConnection objects found'; on another locale a port with no listener may therefore read as a FAILED probe, which REFUSES (fail closed, never a false 'free').
 */
export const PS_PROBE_LISTENER = (port) => `try { $c = @(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop); if ($c.Count -gt 0) { 'PID:' + $c[0].OwningProcess } else { 'NONE' } } catch { if ($_.FullyQualifiedErrorId -match 'CmdletizationQuery_NotFound' -or $_.Exception.Message -match 'No MSFT_NetTCPConnection objects found') { 'NONE' } else { 'FAIL' } }`;
export const parseProbe = (text) => { const m = /^PID:(\d+)$/.exec(String(text).trim()); if (m) return { ok: true, pid: Number(m[1]) }; if (String(text).trim() === "NONE") return { ok: true, pid: null }; return { ok: false }; };
export const PS_ANCESTORS = (pid) => `$ErrorActionPreference = 'Stop'; $all = @{}; Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $all[[int]$_.ProcessId] = [int]$_.ParentProcessId }; $p = ${pid}; $out = @(); for ($i = 0; $i -lt 40; $i++) { if (-not $all.ContainsKey($p)) { break }; $p = $all[$p]; if ($p -eq 0) { break }; $out += $p }; ($out -join ',')`;
export const parseAncestors = (text) => String(text).trim().split(",").filter(Boolean).map((x) => { const n = Number(x); if (!Number.isInteger(n) || n <= 0) throw new Error("unreadable ancestor list"); return n; });
export const PS_STOP_VERIFIED = (pid) => `$ErrorActionPreference = 'Stop'; $id = ${pid}; $p = Get-Process -Id $id; $c = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id); if (-not $c) { throw 'IDENTITY: no process row' }; if ($c.CreationDate.ToUniversalTime().ToString('o') -ne $env:UW_SNAP_CREATED) { throw 'IDENTITY: creation time differs' }; if ([string]$c.CommandLine -ne $env:UW_SNAP_CMD) { throw 'IDENTITY: command line differs' }; if ([math]::Abs(($p.StartTime.ToUniversalTime() - $c.CreationDate.ToUniversalTime()).TotalSeconds) -gt 2) { throw 'IDENTITY: the handle is another process' }; $p.Kill(); if (-not $p.WaitForExit(5000)) { throw 'NOT_GONE' }; 'KILLED'`;
/** The lines of `cmdkey /list` that name an LLMKEY:* credential (the `Target:` line; matched on the LLMKEY: name so a localised label does not matter), trimmed and sorted: only these are hashed, so another application adding or removing a Windows credential is not a false RED. */
export const llmkeyTargetLines = (text) => String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => /LLMKEY:/i.test(l)).sort().join("\n");
export function realSys() {
  const ps = (cmd) => execFileSync(PS, ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8", timeout: 30000, windowsHide: true }).trim();
  const json = (text) => { if (!text) return []; const v = JSON.parse(text); return Array.isArray(v) ? v : [v]; };
  const regQuery = (name) => { try { return execFileSync(path.join(SYS32, "reg.exe"), ["query", INTERNET_SETTINGS, "/v", name], { encoding: "utf8", timeout: 15000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { return `(absent ${String(e.status ?? e.code ?? "")})`; } };
  return {
    selfPid: process.pid,
    readText: (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } },
    sha256File: (p) => { try { return sha(fs.readFileSync(p)); } catch { return "(absent)"; } },
    listDir: (p) => {
      try {
        return fs.readdirSync(p, { withFileTypes: true }).map((e) => { let s = 0; if (!e.isDirectory()) { try { s = fs.statSync(path.join(p, e.name)).size; } catch { /* raced */ } } return `${e.name}:${s}`; }).sort();
      } catch { return null; }
    },
    listenerPid: (port) => listenerPid(port),
    listenPortsOf: (pid) => json(ps(`Get-NetTCPConnection -OwningProcess ${intPid(pid)} -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress`))
      .map((r) => ({ addr: String(r.LocalAddress), port: Number(r.LocalPort) })),
    // created: the process's creation time as a UTC ISO string. Windows does NOT invalidate a stale ParentProcessId when a pid is reused, so a parent link is trusted only when the child is YOUNGER than its parent.
    processes: () => json(ps("Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|ccr' } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='Created';e={ if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null } }} | ConvertTo-Json -Compress"))
      .map((r) => ({ pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId), name: String(r.Name), cmd: String(r.CommandLine ?? ""), created: r.Created ? String(r.Created) : null })),
    // A STRICT probe: {ok:true, pid} or {ok:true, pid:null} (no listener) or {ok:false} when the probe itself failed. listenerPid above cannot tell a failed probe from no listener.
    listenerProbe: (port) => { try { return parseProbe(ps(PS_PROBE_LISTENER(intPort(port)))); } catch { return { ok: false }; } },
    // every ancestor pid of `pid` (parent first), from the UNFILTERED process table: the orchestrator's own chain (cmd.exe, a shell, claude) is not in the node|ccr table
    ancestorsOf: (pid) => parseAncestors(ps(PS_ANCESTORS(intPid(pid)))),
    // identify AND stop in ONE step (pid reuse): a handle is taken, the creation time and command line are compared with the verified snapshot, any difference refuses, then the handle is killed and the exit awaited
    stopVerified: (snap) => {
      const out = execFileSync(PS, ["-NoProfile", "-NonInteractive", "-Command", PS_STOP_VERIFIED(intPid(snap.pid))], { encoding: "utf8", timeout: 30000, windowsHide: true, env: { ...process.env, UW_SNAP_CREATED: String(snap.created ?? ""), UW_SNAP_CMD: String(snap.cmd ?? "") } }).trim();
      if (out !== "KILLED") throw new Error(`stop of pid ${snap.pid} did not confirm: ${safeMsg(out, 80)}`);
    },
    credSha: () => { try { return sha(llmkeyTargetLines(execFileSync(path.join(SYS32, "cmdkey.exe"), ["/list"], { encoding: "utf8", timeout: 15000, windowsHide: true }))); } catch (e) { return `(unreadable ${String(e.status ?? e.code ?? "")})`; } },
    proxySha: () => sha(regQuery("ProxyEnable") + regQuery("ProxyServer")),     // read-only reg query; only the hash is kept (the values are never printed)
    supervisorState: () => { try { return ps("(Get-ScheduledTask -TaskName 'UW Process Supervision' -ErrorAction SilentlyContinue).State") || "absent"; } catch { return "(unreadable)"; } },
    stopProcess: (pid) => { ps(`Stop-Process -Id ${intPid(pid)} -Force -ErrorAction SilentlyContinue`); },
  };
}

/** The bootstrap step runs under the REAL home (its tripwire watches the real settings file) but with a MINIMAL environment: no proxy, key, ANTHROPIC_*, CLAUDE_* or CCR_* from the parent. */
export const MINIMAL_ENV_KEYS = ["SystemRoot", "PATH", "USERPROFILE", "TEMP"];
export const minimalEnv = (env) => Object.fromEntries(MINIMAL_ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

function realRunStep(step, env) {
  const r = spawnSync(step.cmd, step.args, { env, encoding: "utf8", timeout: 180000, windowsHide: true, maxBuffer: 8 << 20 });
  const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n").map((l) => l.trim()).filter(Boolean).slice(-6).join(" | ");
  return { code: r.status ?? (r.error ? 1 : 0), tail: oneLine(redactSecrets(tail), 400) };       // redacted at the source AND again where the tail is printed; the other free-text print sites (FAILED line, refusals, teardown notes, signal and evidence errors) go through redactSecrets/safeMsg
}

/** The signals a closing terminal or a stop request can deliver (SIGHUP: console closed; SIGBREAK: Ctrl+Break on Windows). The exit code is 128 + the signal number, so it is never 0. */
export const HANDLED_SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143, SIGBREAK: 149 };
/**
 * Registers every handled signal (process.on, NOT once: with no listener left Node's default action ends the process, and a second Ctrl+C would kill a teardown halfway);
 * the FIRST signal runs `fn` to its end and then exits non-zero; a signal while that is running prints 'teardown in progress, wait' and does NOT exit.
 * Returns the unregister function, which the caller must call only AFTER the teardown has completed. exit/say are injectable (tests).
 */
export function realOnSignal(fn, { exit = (c) => process.exit(c), say = (m) => console.error(m) } = {}) {
  let running = null;
  const hs = Object.entries(HANDLED_SIGNALS).map(([sig, code]) => {
    const h = () => {
      if (running) { say(`${sig}: teardown in progress, wait (the sandbox daemon is being stopped; a second signal does not interrupt it)`); return running; }
      running = (async () => { try { await fn(sig); } finally { exit(code); } })();
      return running;
    };
    process.on(sig, h);
    return [sig, h];
  });
  return () => { for (const [sig, h] of hs) process.off(sig, h); };
}

/** The real owner-act seams: both streams must be a TTY, and the confirmation is typed at a readline prompt. */
const realInteractive = () => !!(process.stdin.isTTY && process.stdout.isTTY);
const realAsk = (question) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (a) => { rl.close(); resolve(a); });
});

export function defaults() {
  return {
    fs, sys: realSys(), env: process.env, out: console.log, err: console.error, rpc, resolveWebPort, runStep: realRunStep, createStub, buildSpec, onSignal: realOnSignal, hashFiles: hashExecutedFiles, ccrInstall: () => resolveCcrInstall(), interactive: realInteractive, ask: realAsk,
    makeTripwire, fetch: (...a) => globalThis.fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(),
    guard: { assertIsolatedInstance, assertIsolatedConfig, assertPayloadIsolated, assertRouterClean, assertDesktopSyncLandedInScratch, assertGatewayBound },
  };
}

// ---------------------------------------------------------------- the plan (a pure function of its inputs: the spec, the file hashes and the CCR install it is handed; rendering performs no I/O, the CALLER reads the executed files and the CCR install)
export const EXPERIMENTS = [
  { id: "A0", router: "probe, next", what: "enricher pre-assertion (V22/V25)", evidence: "a tagged subagent-shaped request carrying the claude-code PROFILE key and a claude user-agent reaches the router with builtInClaudeCodeSubagent=true and builtInSubagentModel set", fail: "FAIL and ABORT (nothing after it would mean anything)" },
  { id: "E4", router: "probe", what: "a router body edit reaches the upstream", evidence: `the stub's recorded Agent tool description holds ${E4_MARK} (and the probe reported mutated:true)`, fail: "FINDING (gates G4)" },
  { id: "E5", router: "probe", what: "an added header reaches the upstream", evidence: "the stub's recorded x-uw-subpolicy header", fail: "FINDING (not a failure)" },
  { id: "E7", router: "probe", what: "globalThis survives the per-request require-cache deletion", evidence: "the probe's globalThis counter n increments 1,2,3 in one process WHILE its module-scope control counter m stays 1 (m rising = cache not deleted)", fail: "FINDING (main learning relies on files)" },
  { id: "E12", router: "probe", what: "content-length and tokenCount reach the router", evidence: "both present in the probe's record, content-length a positive number (printed against the stub's received body bytes)", fail: "FINDING (payload fit compile-time only)" },
  { id: "E13", router: "probe", what: "clearing builtInSubagentModel stops the tag being honoured", evidence: `CONTROL arm first (probe mode keep-tag, router returns undefined and clears nothing): the stub must receive ${TAG_MODEL} (selector or bare spelling); only then, with the tag cleared (mode clear-tag) the stub must not receive it`, fail: "FINDING (E13 undecidable when the control arm does not show the tag honoured)" },
  { id: "A1", router: "next", what: "policy file absent: exactly the requested model, router silent", evidence: "stub models equal the asked models (selector or bare spelling, recorded); no scratch state directory", fail: "FAIL" },
  { id: "A2", router: "next", what: "shadow with a tag: asked returned, would logged (router v2 logs to decisions.jsonl AND agents.jsonl)", evidence: `decisions.jsonl would=${TAG_MODEL}, ret=asked, and the agents.jsonl shadow line of the new agent carries the same would/ret; stub model=asked (either spelling)`, fail: "FAIL" },
  { id: "A8", router: "next", what: "globalThis persists on the exact bytes (router v2: stat-keyed factory loader, evaluated once per process); real CCR loads the file", evidence: "status.json (written ASYNCHRONOUSLY, the first flush is polled for up to 1 s) counters.req >= 6 after a 5.5 s pause, status.since equal to the first flush's, at least one status-<w>.json next to status.json, no `Failed to load custom router` in the sandbox CCR logs (0 log files is reported as a note); after the run the PROBE router is put back for one peek and reads the size of globalThis.__uwRouterImpl in the same process: it must hold exactly 1 key (a peek served by another worker, or an unobserved registry, is said in the line and is not a failure)", fail: "FAIL" },
  { id: "A11", router: "probe, next", what: "live gateway untouched", evidence: "live listener pids, live service.json pid and hash, live settings hash equal the baseline; the baseline must HOLD a live service.json pid and a listener on 3456, else FINDING", fail: "FAIL" },
  { id: "X1", router: "probe", what: "are `config` and `config.Providers` the same objects on every request, and does a Providers edit through the sandbox web RPC give a new array or mutate the old one?", evidence: `three main-shaped calls (the third AFTER an edit that adds model ${X1_MODEL} to the stub provider, restored afterwards): config === previous, Providers === previous, provider count, a fingerprint of provider names and model lists; same pid required`, fail: "FINDING (informational: decides the ar-4 index key)" },
  { id: "X2", router: "probe", what: "how many worker processes serve router calls", evidence: "12 concurrent main-shaped requests; the number of distinct process.pid values in the probe's records", fail: "FINDING (informational: weight of the cross-worker paths)" },
  { id: "X3", router: "probe", what: "SYNTHETIC: does x-stainless-retry-count reach the router, and is CCR's own fallback off by default?", evidence: "the same subagent-shaped body twice with the header 0 then 1 against a forced upstream 429 and then a 503 (stub steps [failure, 200]): the header value at the router, upstream attempts per inbound (1 = no CCR retry), the status and retry-after the client sees. It does NOT claim whether Claude Code retries (6.1c binary analysis)", fail: "FINDING (informational: decides the ar-17 signal; the real-Claude-Code part is NOT-RUN, S2d)" },
  { id: "X4", router: "probe", what: "do team agent ids (`name@session`), the parent agent id and the session id reach the router, and in which shape?", evidence: "one request with agent id ccr-logs@session-f49cde2f, parent team-lead@session-f49cde2f and a session id: presence, length, form and charset (^[A-Za-z0-9_@.:-]{1,128}$) at the router, forwarded upstream or not", fail: "FINDING (informational: a rejected shape means widening the charset BEFORE G2)" },
  { id: "X5", router: "probe", what: "messages.length per turn of an agent, on a retry and across a compaction", evidence: "one agent sends 1, 3, 5, the same body again (the retry), then 3 (a compaction): the router's records of messages.length and of the last message's hash; the len rule must fire on the retry only", fail: "FINDING (informational: decides whether len can false-positive)" },
  { id: "X7", router: "probe", what: "REQUIRED: does a request-scoped setTimeout(...).unref() still fire after CCR deletes the module's cache entry on the next request?", evidence: "call A in probe mode timer (a 300 ms timer), call B at once (mode observe, re-evaluates the module, m=1), a wait of up to 2.5 s for the timer's line, which must come AFTER B's line", fail: "FAIL when it never fires (the failure-path retry timer must be removed), which fails the run; FINDING when unmeasured or undecidable (the module was not re-evaluated)" },
  { id: "X8", router: "probe", what: "does a router edit of a SUBAGENT request's system (string and array shape) reach the upstream byte for byte, messages and tools untouched, cache_control kept?", evidence: `the probe appends ${X8_MARK} to a string system and pushes a marker block onto an array system whose last block carries cache_control (CCR 3.0.22 strips the leading x-anthropic-billing-header block of a subagent request BEFORE the router runs, so the expected block count and the cache_control index are adjusted by that one block); the stub records the shape, the marker, the cache_control indexes and the sha256 of messages and tools, compared with the hashes sent. The OpenAI-converted path is NOT-RUN (no second stub provider)`, fail: "FINDING (informational: the handoff notice is best effort)" },
  { id: "X9a", router: "probe", what: "does hot-swapping Router.fallback (model-chain with one stub model, retry) take effect with the sandbox gateway pid unchanged?", evidence: "the sandbox web RPC saveConfig (never the live config) with a local check per swap; attempts for a 429 without Retry-After under off, model-chain, retry; listener pid of the sandbox gateway before and after. Router.fallback is restored to its original value (off) at the end and read back through assertRouterClean on a FRESH getConfig (the echo of saveConfig is checked too, but it is not a read of what the daemon persisted)", fail: "FINDING (informational; the fallback chain stays OFF whatever it shows, 6.1c)" },
  { id: "X9b", router: "probe", what: "status, delay, attempts and x-ccr-fallback-* headers for a 429 with Retry-After 3, 3600 and none, a 400, a 413 and a 502, under off, model-chain and retry", evidence: "18 cases, each one inbound request with stub steps [failure, 200]; the table is printed; the CCR waits are real (Retry-After clamped to 60 s, so the 3600 cases under model-chain and retry take about a minute each); request_logs fields are NOT recorded (no harness seam reads the sandbox database)", fail: "FINDING (informational)" },
  { id: "X9c", router: "probe", what: "the probe router sees exactly ONE call per inbound request, also when CCR makes more than one upstream attempt", evidence: "router calls per inbound request over all 19 requests; at least one case must have more than one upstream attempt or the claim is untested", fail: "FINDING (informational)" },
  { id: "X9d", router: "probe", what: "the model-chain also applies to a MAIN-shaped request (global scope)", evidence: "a main-shaped request under model-chain with stub steps [429, 200]: upstream attempts", fail: "FINDING (informational)" },
  { id: "X9e", router: "probe", what: "does CCR forward an upstream retry-after to the client when the fallback is off?", evidence: "the retry-after response header at the client for stub Retry-After 3 and 3600 with the fallback off", fail: "FINDING (informational)" },
  { id: "H1", router: "next", what: "HANDOFF SMOKE (exact bytes, ENFORCE synthetic policy, informational): a retry signal moves a subagent to a different model", evidence: `main-shaped request teaches main; a subagent request (agent id header, billing block, an Agent-less tools list: Bash only, 3 messages) is the decision; the SAME 3 messages again is the retry signal len: the stub must receive a DIFFERENT model, agents.jsonl must hold one act:"handoff" line with from, to and aid_full (rsrc len), the notice marker ${NOTICE_MARK} must be at the stub on that request (when X8 showed a system edit reaches the upstream); a third request with 5 messages stays on the new model with no new handoff`, fail: "FINDING with the observed values (never a failure of the run)" },
];
/** Stated, not hidden: what this run does NOT do. Part of the plan text (so of its hash) and printed again after the probe run. */
export const NOT_RUN = [
  "PARKED X9f: a gateway transform plugin returning responseHeaders {\"retry-after\":\"1\"}: plugins are in the restart set, so installing one needs a gateway restart (R1); to be tried only in the sandbox, never live; nothing is built for it",
  "NOT-RUN X9g and X9h (the hook channel, and which of 429, 529 and 5xx triggers Claude Code's own --fallback-model) and the real-Claude-Code parts of X3: they need a real `claude -p` and belong to the S2d scenario suite",
  "NOT-RUN X3 (b)(c)(d)(f): Retry-After 5/90, repeated 529, stream cut: need the real client; the stub can send them",
  "NOT-RUN X8 on the OpenAI-converted path: it needs a second stub provider of type openai, which this update does not build",
  "NOT-RUN X6 here: it is the standalone host check, `node harness/subagent-e2e.mjs --host-check x6` (a temp directory of its own, no daemon, no approval); do NOT run it during G1 (it loads the disk and can disturb the X7 timer margins)",
];

const shortRoot = (r) => String(r).replace(REPO_ROOT, "<repo>").replace(os.homedir(), "~");

/** Facts the owner needs before approving that no check can show. Part of the plan text, so part of its hash. */
export const OPERATING_NOTES = [
  "`--teardown` is IRREVERSIBLE: it deletes the September scratch leftovers (appdata incl. config.sqlite and its WAL, localappdata, claude-config, daemon-env.json, claude-settings.json) and every other SANDBOX_OWNED name listed above. start.ps1 says that config.sqlite may hold a REAL provider key: back up anything you want to keep BEFORE it. A run refuses while those leftovers exist, so G1 needs this deletion first.",
  "the approval is ONE-USE: a run consumes harness/g1-approval.json at start (an atomic rename to harness/g1-approval.used-<pid>-<ts>, then removed; before the preflight), so a second run, or a rerun after any refusal, needs a fresh `--approve-plan`. That includes the first-run outcomes below. The approval proves that the plan text and the executed files are unchanged since the hash was typed and it blocks an accidental run; it does NOT prove a human acted.",
  "a CLOSED terminal usually leaves time to stop the daemon but this is NOT guaranteed: the daemon tree is stopped FIRST by the teardown, after its identity checks (about 6 PowerShell calls at 1.5-2.3 s each) and before the slower probes, but Windows ends a console process some seconds after its window closes and the handler runs only if the console delivers SIGHUP/SIGBREAK. If in doubt run `node harness/subagent-e2e.mjs --teardown` before anything else, and always after a killed terminal.",
  "the run uses the ENABLED claude-code profile that bootstrap-live-safe.mjs leaves and the API key entry whose id is exactly profile:<profile id with every run outside [a-zA-Z0-9_.-] turned into '-', case kept> (CCR's own id for it; findProfileKey). It does not create the profile. It ADDS that key entry to the SANDBOX config when it is missing (ensureProfileKey: CCR creates it only in its applyProfile path, which these saves skip), in the payload of the sandbox-only saveConfig with applyProfile:false; the key is generated at run time, never printed and never written to the plan or the evidence, and no live file, vault or credential is touched. A missing profile, or a key that does not read back with that id, is FAIL A0 before any request (the run is torn down, and the approval is already consumed: a new attempt needs a fresh `--approve-plan`).",
  "LEGITIMATE live activity that turns the proof or the tripwire RED (a false RED: the run is refused or fails and must be repeated; quiesce these first): writes to ~/.claude/settings.json or settings.local.json (any /config, /model, /theme, a plugin change, an 'always allow' answered in a session whose cwd is the home folder); a new, renamed or deleted file anywhere under ~/Downloads; a change of the user PATH by an installer; a bench, refresh, keysync or uwpick run that changes the names or sizes in catalog/ or in ~/.llmkeys, or that rewrites state/subagent/policy.json or shadow.flag or adds a non-runtime file there (the live router's own runtime files in state/subagent are ignored by rule); another application adding or removing a Windows credential whose target contains LLMKEY: (other applications' credentials are not hashed); a change inside the real Claude-3p configLibrary folder; any other process whose command line contains `claude-code-router`. NOT a false RED any more: a Claude desktop restart, window move, resize or update (config.json, claude_desktop_config.json and top-level names are no longer watched).",
  "anything else whose command line contains `claude-code-router` while the run is going (another ccr process, other agents' sessions) turns the process-table check RED and refuses the run: quiesce other sessions first.",
  "uwpick, keysync and ccr commands must NOT run during G1: they talk to or restart the live gateway, and a ccr command line contains `claude-code-router`, which turns the process-table check RED.",
  "router/uw-router.next.cjs is LF in the working tree; core.autocrlf=true on this machine would turn a re-checkout into CRLF. Both hashes are printed (raw = the bytes that run, lf = comparable with a git blob): do NOT re-checkout between G1 and G2a.",
  "recovery is `node harness/subagent-e2e.mjs --teardown` ONLY. The stock harness/teardown.mjs must NOT be used: it kills the pid in the scratch service.json with no identity check and deletes the whole scratch root.",
];

/** Renders the plan text. The text is the thing the owner approves: planOf() hashes exactly these lines. opts.fileHashes (default: hashed now from the working tree) is [{file, raw, lf}]. */
export function renderPlan(spec, opts = {}) {
  const o = [];
  const p = (s = "") => o.push(s);
  p("== subagent-e2e PLAN (--plan writes, starts and contacts NOTHING; it reads only the files hashed under EXECUTED FILES and the installed CCR it prints there; this is a description) ==");
  p(`mode: experiments-only (MANDATORY: a run without --experiments-only exits 2); routers: ${opts.router ?? "both"}; preload guard: ${spec.preloadGuard ? "ON (trial31 preload-guard.cjs, fail-closed, DEFAULT)" : "OFF (--no-preload-guard, reviewed owner choice; run needs --i-understand-no-guard <first 12 hex of the plan sha256 below>)"}`);
  p("gate: G1 (owner). A run needs --g1-approved AND harness/g1-approval.json holding the sha256 of THIS text (same flags), written by `--approve-plan` (interactive terminal only, the first 12 hex of this sha256 typed), ONE-USE (the run consumes the file at start by an atomic rename) and valid 24 h at most. The approval proves the plan text and the executed files are unchanged since the hash was typed and blocks an accidental run; it does not prove a human acted. Nothing below has been run.");
  p();
  p("-- WOULD START (all ports forced in config AND env on every start; web port is env-controlled, gateway/core are DB-config controlled) --");
  p(`  sandbox CCR 3.0.22 daemon: web ${SANDBOX_PORTS.web} (CCR_WEB_PORT), gateway ${SANDBOX_PORTS.gateway}, core ${SANDBOX_PORTS.core} (config.gateway.port/corePort, HOST, PORT forced by bootstrap-live-safe.mjs)`);
  p("    (live evidence: the daemon holds the gateway and web ports, its CHILD process gateway-bootstrap.js holds the core port; the proof judges the whole daemon process TREE)");
  p(`  stub upstream: 127.0.0.1:${SANDBOX_PORTS.stub} (in this orchestrator's process, models ${STUB_MODELS.join(", ")}); it records per request the model, content-length, body byte length and sha256, the tool NAMES, the Agent tool description and the whitelisted headers (${RECORDED_HEADERS.join(", ")}); never a body or a credential header. For X8 and X9 it also records the system SHAPE (string, array or absent), whether the harness's own markers occur in the system, the indexes of system blocks that carry cache_control, messages.length and the sha256 of messages and of tools, and what it SENT back. It CAN script per-request answers (200, 429 with and without a Retry-After of whole seconds such as 5, 90 or 3600, 503, 529, 400, 413, 502, a stream cut after message_start), but this run exercises only 429 (Retry-After 3, 3600 and none), 503, 400, 413 and 502: Retry-After 5 and 90, a repeated 529 and a stream cut have NO synthetic run (see NOT-RUN X3 below), so the list is a capability, not coverage; retry-after is a header it SENDS, never one it records from a request`);
  p(`  allowed sandbox port range ${PORT_RANGE.join("-")} (harness/config.mjs, one place); NEVER used: ${REAL_PORTS.join(", ")} (live gateway 3456/3457, live web 3458, Anthropic relay 4517)`);
  p("  commands, in order:");
  for (const c of spec.commands) p(`    ${c.id}: ${path.basename(c.cmd)} ${c.args.map((a) => (path.isAbsolute(a) ? path.relative(path.dirname(HERE), a) : a)).join(" ")}   (${c.note})`);
  p("    the start step runs under the forced sandbox environment below; the bootstrap step runs under the REAL home (so its tripwire watches the real settings file) with a MINIMAL environment: " + MINIMAL_ENV_KEYS.join(", ") + " only");
  p(`    then in-process: rpc getConfig/saveConfig against the SANDBOX web port only (the rpc refuses any port but ${SANDBOX_PORTS.web}; provider uwstub -> stub, CUSTOM_ROUTER_PATH -> scratch copy: set through the web RPC port ${SANDBOX_PORTS.web} (not the core port ${SANDBOX_PORTS.core}) and asserted after the save; the ENABLED claude-code profile that bootstrap-live-safe.mjs leaves gets model uwstub/m-main: the script does NOT create a profile; it ADDS ONLY a sandbox-config API key entry for it when missing (ensureProfileKey, id profile:<mLe of the profile id>, key generated at run time and never printed) through this same sandbox-only save, never touching live files, and finds it again on the persisted config (findProfileKey, exact id); a missing profile, or a key that does not read back, is FAIL A0 before any request and a teardown, and the approval is already consumed, so a new attempt needs a fresh --approve-plan), applyProfile:false; every sandbox fetch uses redirect:error`);
  p("  HOT EDITS of the SANDBOX config, through the same web RPC and never the live config: X1 adds and removes the stub model m-x1 on provider uwstub; X9 swaps Router.fallback (off, then model-chain with the ONE model uwstub/m-free, then retry with retryCount 1, restored to its original value at the end and read back through assertRouterClean on a FRESH getConfig: saveConfig's return value is the daemon's normalised echo, not a read of what it persisted, so it is checked too but is not the proof; every later isolation proof reads Router.fallback fresh again and runs assertRouterClean on it, which refuses a leftover model-chain or retry, a stray rule and a missing fallback object once the swap step has started; before it an absent fallback is only reported, because assertRouterClean already refused it at the configure step). Each payload passes assertPayloadIsolated and a local check (mode off|retry|model-chain, chain models only uwstub/*, no enabled Router.rules) BEFORE it is sent, each result assertIsolatedConfig, and the tripwire runs after each edit; the teardown scrubs Router.fallback again when the daemon was not stopped");
  p("  DURATION: expected about 8-15 minutes, ESTIMATED from CCR's 60 s Retry-After clamp (the two 3600 cases under model-chain and retry take about a minute each) plus A8's 5.5 s pause and the per-request waits; NOT MEASURED, this run has never been done. WORST CASE: the 18 X9 cases at the 150 s request ceiling are 45 minutes, plus the rest of the run. Every request has that 150 s ceiling and every sandbox web RPC call a 120 s timeout (harness/config.mjs): a call that gets no answer fails the run CLOSED (teardown, evidence), it is never skipped as 'unmeasured', so a hung saveConfig no longer waits for Ctrl+C. CCR may respawn its core worker (the daemon's child holding the core port) during the Router.fallback swaps, and the web RPC can fail for a moment meanwhile (G1 attempt 3): the web-RPC calls INSIDE the isolation proof are retried for a transient network error only (fetch failed, ECONNRESET, ECONNREFUSED, a timeout), at most 5 attempts 1.5 s apart and 10 s in all, each re-reading service.json and re-checking port and pid; a mismatch (wrong port or pid, a config that is not isolated) is NEVER retried and is RED at once, and a failure that persists after the retries is RED with its cause. A changed core worker pid is printed as a RECORD line, not a failure Each hot edit round-trips the WHOLE sandbox config through saveConfig and may restart the sandbox gateway (X9a records whether the pid changed) or trigger the desktop sync into the scratch Claude-3p");
  p();
  p("-- PREFLIGHT (refuses before anything starts) --");
  p("  this shell's own NODE_USE_ENV_PROXY, HTTP_PROXY, HTTPS_PROXY or ALL_PROXY (any letter case, non-empty) REFUSES the run (exit 1, the names only are printed, BEFORE the approval is consumed): the orchestrator's own fetch and web RPC must not be able to leave through a proxy (NO_PROXY alone is fine; the daemon environment already drops them all)");
  p(`  the probe router and the router under test exist; no sandbox port is held; no stale guard logs; no sandbox daemon alive; the live service.json pid and a listener on 3456 are recorded`);
  p(`  the scratch tree is FRESH: ${MUST_BE_ABSENT.map((x) => path.basename(x)).join(", ")} must all be ABSENT (else run \`node harness/subagent-e2e.mjs --teardown\`; no config file is read or printed)`);
  p("  created by the preflight (through safeWritePath, so every directory the sandbox env points at exists before step 0): " + PRECREATE_DIRS.map((x) => path.relative(SCRATCH_ROOT, x)).join(", "));
  p("  created by start.ps1 / CCR itself (must be absent beforehand): " + START_CREATES.map((x) => path.relative(SCRATCH_ROOT, x)).join(", "));
  p();
  p("-- DIRECTORIES the sandbox owns (created under the scratch root; removed by teardown; nothing else under it is deleted) --");
  p(`  root ${spec.root}`);
  for (const n of SANDBOX_OWNED) p(`    ${n}`);
  p("-- FILES this run would write (all under the scratch root, each through safeWritePath: lexical path AND realpath re-checked) --");
  for (const f of [SCRATCH_ROUTER, SCRATCH_SLOT, path.join(SCRATCH_STATE_DIR, "policy.json") + "  (synthetic shadow policy, then the ENFORCE variant for H1; next run only)", path.join(SCRATCH_STATE_DIR, "probe-control.json") + "  (probe mode: mutate, observe, keep-tag, clear-tag, timer, sys-string, sys-array, registry)",
    path.join(SCRATCH_STATE_DIR, "probe.jsonl") + "  (written by the probe router)", path.join(SCRATCH_STATE_DIR, "decisions.jsonl, agents.jsonl, classify.jsonl, status.json, status-<w>.json") + "  (written by the router under test, with main-<sid>.json and agents-<sid>.jsonl session files and cooling.json when it cools)",
    VIOLATIONS_LOG + ", " + GUARD_LOADED_LOG + "  (written by the guard)"]) p(`    ${f}`);
  p(`  files READ (never written): router/uw-router.next.cjs (source of the exact bytes), harness/probe-router.cjs (tracked source of the probe, OUTSIDE the scratch root; the stock harness/teardown.mjs cannot delete it)`);
  p(`  OUTSIDE the scratch root (the only such writes; survive the teardown): ${EVIDENCE_ROOT}\\<timestamp>\\ (retained ONLY when the run is refused or throws, on a signal, or when violations.log is non-empty: violations.log and the last 200 lines of each CCR log, redacted; a run that ends with only an experiment FAIL line, and a clean run, retain nothing) and ${APPROVAL_FILE} (written only by --approve-plan; consumed at run start by an atomic rename to harness\g1-approval.used-<pid>-<ts>, removed right after)`);
  p("  also written, inside the scratch root only, by the EXISTING harness steps: start.ps1 (owner-only ACL on the scratch root via icacls, daemon-env.json, the daemon's config.sqlite and logs under appdata) and bootstrap-live-safe.mjs (claude-settings.json)");
  p("  NOTE: stale entries from the September sandbox (appdata, localappdata, claude-config, daemon-env.json, claude-settings.json) exist today: a run REFUSES until `--teardown` removed them (it removes only the SANDBOX_OWNED names above)");
  p();
  p("-- FORCED ENVIRONMENT of the sandbox daemon tree (everything not on the whitelist is dropped: no proxy, API key, ANTHROPIC_*, CLAUDE_*, CCR_* from the parent) --");
  for (const [k, v] of Object.entries(printableEnv(spec.env)).sort(([a], [b]) => a.localeCompare(b))) {
    if (k === "NODE_OPTIONS" || k === "UW_TRIAL31_PRELOAD_ARG") p(`    ${k}=${oneLine(v, 90)}`);
    else if (k === "UW_TRIAL31_PROTECTED") { const roots = String(v).split(";").map(shortRoot); p(`    ${k}= ${roots.length} protected roots (the preload guard denies writes under each; ~ = home, <repo> = this repository): ${roots.join("; ")}`); }
    else if (!/^(Program|Common|ALLUSERS|PUBLIC|PATHEXT|Path|PATH|OS$|PROCESSOR|NUMBER_OF|COMPUTERNAME|USERNAME|USERDOMAIN|System|windir|ComSpec)/i.test(k)) p(`    ${k}=${v}`);
  }
  p("    (plus the inherited system variables: SystemRoot, windir, ComSpec, PATH, PATHEXT, ProgramFiles*, USERNAME, ... )");
  p();
  p("-- EXPERIMENTS and their evidence --");
  for (const e of EXPERIMENTS) p(`  ${e.id.padEnd(4)} [${e.router}] ${e.what}: ${e.evidence}. Negative: ${e.fail}`);
  p(`  model spelling: CCR may hand the upstream the selector (uwstub/m-main) or the bare name (m-main); one normaliser accepts either, the observed spelling is printed in the PASS detail`);
  p(`  required on the probe run: a line for ${REQUIRED.probe.present.join(", ")}, ${REQUIRED.probe.pass.join(" and ")} must PASS, X7 must not FAIL (the other X lines are informational: FINDING-level when they deviate); required on the exact next bytes: a line for ${REQUIRED.next.present.join(", ")}, PASS for ${REQUIRED.next.pass.join(", ")} (H1 is informational)`);
  p();
  p("-- NOT RUN / PARKED (stated, not hidden) --");
  for (const n of NOT_RUN) p(`  ${n}`);
  p("  line format: `PASS|FINDING|FAIL [probe|next] <id> <detail>`; exit 0 only when every required line is present and none is FAIL");
  p();
  p("-- REFUSES TO RUN (exit 1, before the first synthetic request) unless ALL hold --");
  for (const s of ["the launch spec passes assertSandboxSpec (every redirect under the scratch root, every directory variable pre-created or created by start.ps1, web port forced, ports distinct and in range, no live port, no inherited credential/proxy variable, guard roots do not contain the sandbox root)",
    "the preflight above holds, and the tripwire over live state is quiet immediately after `ccr start` (also when that step exits non-zero)",
    "after start and bootstrap, then again after the provider save, then after each router run: the isolation proof is all GREEN (below)"]) p(`  - ${s}`);
  p("  on SIGINT/SIGTERM/SIGHUP/SIGBREAK the evidence is kept FIRST (the teardown deletes the logs it is copied from), then the identity-verified selective teardown runs to its end (a second signal during it only prints 'teardown in progress, wait'), then the exit code is 129 SIGHUP, 130 SIGINT, 143 SIGTERM or 149 SIGBREAK; a teardown that leaves a sandbox port held exits 1; the tripwire is asserted again after the teardown");
  p();
  p("-- THE ISOLATION PROOF (every check below must be GREEN) --");
  p("  live listeners 3456/3457/3458/4517 owned by the same pids; live settings/service.json/credentials/proxy/PATH/vault/state/catalog/Downloads/Claude-3p unchanged; process table: the live CCR set unchanged and every new CCR process descends from the sandbox daemon;");
  p("  tripwire; sandbox ports held by the daemon's process TREE (stub by this orchestrator) with EVERY listener of EVERY tree process loopback, inside the range and not live; daemon web port and token; persisted config; takeover file;");
  p("  the preload guard loaded in the daemon pid and every node process of its tree, and violations.log empty;");
  p("  the proof's calls to the sandbox web RPC (daemon identity, persisted config, Router.fallback read) retry a transient network error only (5 attempts, 1.5 s apart, 10 s in all, service.json re-read and port and pid re-verified at each attempt; the attempt count and the cause are in the line) and never an isolation mismatch; a core worker pid that changed since the previous proof is a RECORD line");
  p();
  p("-- SIDE EFFECTS CHECKED (mode: prevent = stopped, detect = compared before/after, record = measured) --");
  for (const s of SIDE_EFFECTS) p(`  [${s.mode}] ${s.id}: ${s.what}\n      how: ${s.how}`);
  p("-- the proof also prints, before and after the run: live settings sha256 (12 chars), live service.json pid, listener pids on 3456/3457/3458/4517 --");
  p();
  p("-- TEARDOWN IDENTITY (stopProcess is the only destructive act on a process) --");
  p("  ORDER: the daemon tree is stopped FIRST (after the identity checks, leaf first); only then the stub, the sandbox-port check and the removal of the directories this script created. The slow side-effect probes are not run before the stop. A daemon that could not be identified is NOT stopped, and only then is the sandbox provider scrubbed through the web RPC.");
  p("  a pid is stopped only if: it is not in the baseline live CCR set; it is not the live service.json pid (read in --teardown mode too); it owns none of 3456/3457/3458/4517;");
  p("  its command line is the CCR daemon-child; and it holds the sandbox web port or is the parent of the process holding the sandbox gateway/core port. Its descendants are stopped first, deepest first (children before parents), under the same exclusions.");
  p();
  p("-- EXECUTED FILES (every file this run executes or loads: sha256 of the raw working-tree bytes / of the LF-normalised bytes; the plan hash covers these lines; printed again at run start, and a run REFUSES if any differs from the approved plan; each file is re-checked against the approved hash before the step that uses it, and the router copies against it before they are copied) --");
  for (const f of opts.fileHashes ?? hashExecutedFiles()) p(`  ${f.file}  raw ${f.raw}  lf ${f.lf}`);
  for (const l of ccrInstallLines(opts.ccr ?? resolveCcrInstall())) p(l);
  p();
  p("-- OPERATING NOTES (read before approving) --");
  for (const n of OPERATING_NOTES) p(`  - ${n}`);
  p();
  p("-- FILES AND RESOURCES THIS RUN MUST NEVER TOUCH --");
  for (const n of NEVER_TOUCH) p(`  ${n}`);
  for (const n of NEVER_TOUCH_NON_FS) p(`  ${n}`);
  p();
  p("-- SIDE EFFECTS THE GUARD CANNOT VERIFY (named, not hidden) --");
  for (const c of CANNOT_VERIFY) p(`  - ${c}`);
  return o;
}
/** The plan lines and the sha256 of exactly that text (lines joined with \n). The approval binds this hash. */
export function planOf(spec, opts = {}) {
  const lines = renderPlan(spec, opts);
  return { lines, sha: sha(lines.join("\n")) };
}

// ---------------------------------------------------------------- the flow
const refuse = (m) => { throw new RefusalError(`REFUSED: ${m}`); };
export const logObj = (text) => (text ?? "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
export const assertGatewayUrl = (u) => { const x = new URL(u); if (x.hostname !== "127.0.0.1" || Number(x.port) !== SANDBOX_PORTS.gateway) refuse(`request URL ${u} is not the sandbox gateway`); };

export function writeSafe(d, file, data) {
  const abs = safeWritePath(file);
  d.fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  d.fs.writeFileSync(tmp, data);
  d.fs.renameSync(tmp, abs);
  return abs;
}
/** Removal goes through safeWritePath (a target that resolves through a junction to anywhere outside the scratch root is refused). Node's recursive rm unlinks a link inside the tree, it does not follow it (pinned by a real-fs test). */
export function rmSafe(d, target) { d.fs.rmSync(safeWritePath(target), { recursive: true, force: true }); }
/** The retained-evidence write: exact evidence root or approval file only, tmp + rename in the same directory. */
function writeEvidence(d, file, data) {
  const abs = safeEvidencePath(file);
  d.fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}`;
  d.fs.writeFileSync(tmp, data);
  d.fs.renameSync(tmp, abs);
  return abs;
}

/**
 * Copies the source router into the scratch tree and re-hashes BOTH sides. The comparison is byte-exact on purpose: with core.autocrlf=true a git
 * checkout writes CRLF into the working tree, so the sha256 of router/uw-router.next.cjs differs between checkouts and from `git show`'s LF bytes.
 * The run hashes the WORKING-TREE file it copies (never a git blob) and prints that hash in full, plus the LF-normalised hash so it can be compared with a blob.
 */
export function installRouter(d, which, approved, { keepState = false } = {}) {
  const src = which === "probe" ? PROBE_ROUTER_SRC : NEXT_ROUTER_SRC;
  const bytes = d.fs.readFileSync(src);
  // read at its point of use, minutes after the approved re-hash: the bytes about to be copied must still be the APPROVED bytes (the source-vs-copy comparison below cannot see an edit made before the copy)
  const rel = path.relative(REPO_ROOT, src).replace(/\\/g, "/"), want0 = approved?.get(rel);
  if (!want0 || sha(bytes) !== want0) refuse(`${rel} changed since the approved plan (sha256 ${sha(bytes).slice(0, 12)}, approved ${want0 ? want0.slice(0, 12) : "none"}): refusing before it is copied into the sandbox`);
  writeSafe(d, SCRATCH_ROUTER, bytes);
  const want = sha(bytes);
  if (sha(d.fs.readFileSync(SCRATCH_ROUTER)) !== want) refuse(`the scratch router copy differs from ${src} after the write`);
  if (sha(d.fs.readFileSync(src)) !== want) refuse(`${src} changed while it was being copied`);
  writeSafe(d, SCRATCH_SLOT, JSON.stringify({ model: "anthropic/claude-opus-5" }) + "\n");
  if (!keepState) rmSafe(d, SCRATCH_STATE_DIR);                    // a fresh state directory per run: the router is location-derived, so this is ITS state (keepState: the registry peek puts the probe back WITHOUT wiping what the exact bytes wrote)
  return { sha: want, lfSha: sha(Buffer.from(String(Buffer.from(bytes).toString("utf8")).replace(/\r\n/g, "\n"))), src };
}

export async function waitFor(d, pred, ms = 8000) {
  const end = d.now() + ms;
  for (;;) { const v = pred(); if (v) return v; if (d.now() >= end) return undefined; await d.sleep(50); }
}

async function configureSandbox(d, spec) {
  const g = d.guard;
  const cfg = structuredClone(await d.rpc("getConfig"));
  if (!cfg.profile || !Array.isArray(cfg.profile.profiles)) refuse("the sandbox config has no profile.profiles array: the enabled claude-code profile (and its key) cannot be found");
  const prof = cfg.profile.profiles.find((x) => x.agent === "claude-code" && x.enabled);
  if (cfg.routing?.enhancedRoute === false || prof?.routing?.enhancedRoute === false) refuse("enhancedRoute is false in the sandbox config (" + (prof?.routing?.enhancedRoute === false ? "profile.routing of the enabled claude-code profile, the field CCR's enricher reads" : "routing") + "): CCR's enricher does not run, so builtInClaudeCodeSubagent can never be true and A0 cannot pass (V22)");
  g.assertRouterClean(cfg);
  cfg.Providers = [{ name: "uwstub", provider: "uwstub", type: "anthropic_messages", api_base_url: `http://127.0.0.1:${SANDBOX_PORTS.stub}`, api_key: "stub", models: [...STUB_MODELS], autoFetchModels: false, enabled: true }];
  cfg.CUSTOM_ROUTER_PATH = SCRATCH_ROUTER;
  cfg.observability = { ...cfg.observability, requestLogs: true };
  if (prof) prof.model = ANCHOR;
  const ensured = ensureProfileKey(cfg);                         // the key CCR creates only in its applyProfile path, which this save skips; sandbox config only
  for (const k of cfg.APIKEYS ?? []) if (k && typeof k.key === "string" && k.key.length >= 8) RUN_SECRETS.add(k.key);
  cfg.profile.claudeCode = { ...cfg.profile.claudeCode, model: ANCHOR, smallFastModel: ANCHOR };
  g.assertPayloadIsolated(cfg, { allowProviders: true });         // validate what is about to be SENT, not just the echo
  const saved = await d.rpc("saveConfig", [cfg, { applyProfile: false }]);
  await g.assertIsolatedConfig(saved);
  g.assertRouterClean(saved);
  if (saved.CUSTOM_ROUTER_PATH !== SCRATCH_ROUTER || /[\\/]\.uw[\\/]spike[\\/]/i.test(String(saved.CUSTOM_ROUTER_PATH))) refuse("the persisted CUSTOM_ROUTER_PATH is not the scratch copy");
  g.assertDesktopSyncLandedInScratch();
  g.assertGatewayBound();
  const k = findProfileKey(saved);                                 // exact id match on the PERSISTED config: a key CCR normalised away is an error here, before any request
  if (k.key) RUN_SECRETS.add(k.key);
  return { ...k, keyAdded: ensured?.added === true, fallback: structuredClone(saved.Router?.fallback ?? { mode: "off", models: [] }) };   // the original Router.fallback (off, asserted above): X9 restores exactly this
}

const PROBE_LOG = path.join(SCRATCH_STATE_DIR, "probe.jsonl");
const probeAll = (d) => logObj(d.sys.readText(PROBE_LOG));
const callsOf = (lines) => lines.filter((l) => l && typeof l.n === "number");              // the probe also writes `timer` lines, which carry no n
const setProbeMode = (d, mode, extra = {}) => writeSafe(d, path.join(SCRATCH_STATE_DIR, "probe-control.json"), JSON.stringify({ mode, ...extra }));
const REQUEST_CEILING_MS = 150000;                                                          // a CCR sleep is at most 60 s per attempt: the ceiling leaves room for two
const KEPT_RESPONSE_HEADERS = (k) => k === "retry-after" || k.startsWith("x-ccr-");        // everything else a response carries is dropped, never stored

/** One synthetic request to the SANDBOX gateway. Returns {status, headers (retry-after and x-ccr-* only, redacted), ms (the injectable clock), hashes (sha256 of messages and tools as sent), req}; status null on a transport error. */
export async function send(d, key, shape, over = {}) {
  const url = `http://127.0.0.1:${SANDBOX_PORTS.gateway}/v1/messages`;
  assertGatewayUrl(url);
  const req = buildRequest(shape, { key, ...over });
  const t0 = d.now();
  let res;
  try { res = await d.fetch(url, { method: "POST", redirect: "error", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(REQUEST_CEILING_MS) }); }
  catch (e) { return { status: null, error: safeMsg(e.message, 80), headers: {}, ms: d.now() - t0, req }; }
  let bodyError;
  try { await res.text(); } catch (e) { bodyError = safeMsg(e.message, 80); }               // a stream cut: the status is still the answer
  const headers = {};
  if (res.headers && typeof res.headers.forEach === "function") res.headers.forEach((v, k) => { const n = String(k).toLowerCase(); if (KEPT_RESPONSE_HEADERS(n)) headers[n] = safeMsg(v, 80); });
  return { status: res.status, headers, ms: d.now() - t0, hashes: bodyHashes(req.body), req, ...(bodyError ? { bodyError } : {}) };
}

/** A guard failure or a refusal must stop the run; any other error (an RPC that failed, a timeout) only makes the experiment that needed it unmeasured. */
const isFatal = (e) => e instanceof RefusalError || e instanceof RpcTimeoutError || /ISOLATION VIOLATION/.test(String(e && e.message));   // a timed-out RPC may or may not have been applied: the run stops (teardown, evidence), it does not make one experiment "unmeasured"
/**
 * One hot edit of the SANDBOX config through the sandbox web RPC (config.mjs rpc refuses every other port). The payload passes assertPayloadIsolated and the local checks BEFORE it is
 * sent (Router.fallback mode off|retry|model-chain with chain models only uwstub/*, no enabled Router.rules, CUSTOM_ROUTER_PATH the scratch copy), the persisted result passes
 * assertIsolatedConfig, and the tripwire runs after it. assertRouterClean is NOT used for a swap (it refuses every fallback mode but off by design); it is used for the RESTORE.
 */
export async function editSandboxConfig(c, label, mutate) {
  const { d } = c, g = d.guard;
  const cfg = structuredClone(await d.rpc("getConfig"));
  mutate(cfg);
  if (cfg.CUSTOM_ROUTER_PATH !== SCRATCH_ROUTER) refuse(`${label}: the config's CUSTOM_ROUTER_PATH is not the scratch copy`);
  const fb = cfg.Router?.fallback ?? { mode: "off", models: [] };
  if (!["off", "retry", "model-chain"].includes(fb.mode)) refuse(`${label}: Router.fallback.mode "${oneLine(fb.mode, 20)}" is not off, retry or model-chain`);
  if ((fb.models ?? []).some((m) => !/^uwstub\//.test(String(m)))) refuse(`${label}: a fallback model is not a uwstub/* selector`);
  if ((cfg.Router?.rules ?? []).some((r) => r && r.enabled !== false)) refuse(`${label}: an enabled Router.rules entry exists`);
  if (!(cfg.Providers ?? []).every((p) => p && p.name === "uwstub" && p.api_base_url === `http://127.0.0.1:${SANDBOX_PORTS.stub}`)) refuse(`${label}: a provider other than the sandbox stub (uwstub at 127.0.0.1:${SANDBOX_PORTS.stub}) is in the config`);
  g.assertPayloadIsolated(cfg, { allowProviders: true });
  const saved = await d.rpc("saveConfig", [cfg, { applyProfile: false }]);
  await g.assertIsolatedConfig(saved);
  if (saved.CUSTOM_ROUTER_PATH !== SCRATCH_ROUTER) refuse(`${label}: the persisted CUSTOM_ROUTER_PATH is not the scratch copy`);
  c.tripwire?.assert(`e2e:after-${label}`);
  return saved;
}
export async function restoreFallback(c) {
  const saved = await editSandboxConfig(c, "x9-restore", (cfg) => { cfg.Router = { ...cfg.Router, fallback: structuredClone(c.fallback ?? fallbackFor("off")) }; });
  c.d.guard.assertRouterClean(saved);                              // the ECHO saveConfig returned (CCR 3.0.22 returns the normalised object, not a database read): necessary, not sufficient
  c.d.guard.assertRouterClean(await c.d.rpc("getConfig"));         // what the daemon PERSISTED: mode off, no chain models, no rules, read fresh (the proof reads it fresh again at every later stage)
}

// ---- the experiment runners: each sends synthetic requests, reads the probe's and the stub's records, and returns the evidence its evaluator takes
const nextCall = async (d, before, ms = 3000) => { await waitFor(d, () => callsOf(probeAll(d)).length > before, ms); return callsOf(probeAll(d))[before]; };
const providerModels = (cfg, add) => { const p = (cfg.Providers ?? []).find((x) => x && x.name === "uwstub"); if (!p) refuse("provider uwstub is missing from the sandbox config"); p.models = add ? [...STUB_MODELS, X1_MODEL] : [...STUB_MODELS]; };

async function runX1(c) {
  const { d, key, stub } = c;
  setProbeMode(d, "observe"); stub.setScript({}); stub.clear();
  const one = async () => {
    for (let i = 0; i < 6; i++) {                                    // a transport error (the gateway re-binding after an edit) is retried; any HTTP status is an answer
      const before = callsOf(probeAll(d)).length, r = await send(d, key, "main", { model: ASKED_MODEL, session: "uws0-x1" });
      if (r.status !== null) return nextCall(d, before);
      await d.sleep(1000);
    }
    return undefined;
  };
  const l1 = await one(), l2 = await one();
  const gwBefore = d.sys.listenerPid(SANDBOX_PORTS.gateway), edit = { ok: false };
  try { await editSandboxConfig(c, "x1-edit", (cfg) => providerModels(cfg, true)); edit.ok = true; } catch (e) { if (isFatal(e)) throw e; edit.why = safeMsg(e.message, 120); }
  let l3;
  try { l3 = await one(); }
  finally { if (edit.ok) await editSandboxConfig(c, "x1-restore", (cfg) => providerModels(cfg, false)); }   // never leave the sandbox edited: a failure here propagates
  return { l1, l2, l3, edit: { ...edit, gwBefore, gwAfter: d.sys.listenerPid(SANDBOX_PORTS.gateway) } };
}
async function runX2(c) {
  const { d, key, stub } = c, N = 12;
  setProbeMode(d, "observe"); stub.setScript({}); stub.clear();
  const before = callsOf(probeAll(d)).length;
  await Promise.all(Array.from({ length: N }, (_, i) => send(d, key, "main", { model: ASKED_MODEL, session: `uws0-x2-${i}` })));
  await waitFor(d, () => callsOf(probeAll(d)).length >= before + N, 3000);
  return { sent: N, lines: callsOf(probeAll(d)).slice(before) };
}
export const X4_AGENT = "ccr-logs@session-f49cde2f", X4_PARENT = "team-lead@session-f49cde2f";
async function runX4(c) {
  const { d, key, stub } = c;
  setProbeMode(d, "observe"); stub.setScript({}); stub.clear();
  const before = callsOf(probeAll(d)).length;
  await send(d, key, "sub", { model: ASKED_MODEL, agentId: X4_AGENT, parent: X4_PARENT, session: "uws0-x4", agentTool: false });
  return { probe: await nextCall(d, before), stubRec: stub.records[0], sent: { agentId: X4_AGENT } };
}
export const X5_LENGTHS = [1, 3, 5, 5, 3];                          // turn 1, turn 2, turn 3, the retry of turn 3, a compaction
async function runX5(c) {
  const { d, key, stub } = c;
  setProbeMode(d, "observe"); stub.setScript({}); stub.clear();
  const before = callsOf(probeAll(d)).length;
  for (const n of X5_LENGTHS) await send(d, key, "sub", { model: ASKED_MODEL, agentId: "uws0-x5", session: "uws0-x5", messages: n, agentTool: false });
  await waitFor(d, () => callsOf(probeAll(d)).length >= before + X5_LENGTHS.length, 3000);
  return { sent: X5_LENGTHS, lines: callsOf(probeAll(d)).slice(before) };
}
async function runX3(c) {
  const { d, key, stub } = c, cases = [];
  setProbeMode(d, "observe");
  for (const status of [429, 503]) {
    stub.setScript({ sequence: [{ status }, 200] }); stub.clear();
    const steps = [];
    for (const rc of [0, 1]) {
      const before = callsOf(probeAll(d)).length, recs0 = stub.records.length;
      const r = await send(d, key, "sub", { model: ASKED_MODEL, agentId: "uws0-x3", session: "uws0-x3", messages: 3, retryCount: rc, agentTool: false });
      const line = await nextCall(d, before), recs = stub.records.slice(recs0);
      steps.push({ sent: rc, status: r.status, headers: r.headers, routerRetry: line ? (line.hdr?.retry ?? null) : undefined, upstream: recs.length, upRetry: recs[0]?.headers?.["x-stainless-retry-count"] ?? null });
    }
    cases.push({ name: String(status), steps });
  }
  return { cases };
}
async function runX8Arm(c, shape) {
  const { d, key, stub } = c;
  setProbeMode(d, shape === "string" ? "sys-string" : "sys-array"); stub.setScript({ markers: [X8_MARK] }); stub.clear();
  const before = callsOf(probeAll(d)).length;
  const r = await send(d, key, "sub", { model: ASKED_MODEL, agentId: `uws0-x8-${shape}`, session: "uws0-x8", systemShape: shape, systemCache: shape === "array", agentTool: false });
  const sys = r.req?.body?.system;
  return { probe: await nextCall(d, before), stubRec: stub.records[0], sent: { ...(r.hashes ?? {}), blocks: Array.isArray(sys) ? sys.length : null, ccIdx: Array.isArray(sys) ? sys.length - 1 : null,
    stripped: Array.isArray(sys) && sys.length && String(sys[0]?.text ?? "").startsWith("x-anthropic-billing-header:") ? 1 : 0 } };
}
async function runX7(c) {
  const { d, key, stub } = c;
  stub.setScript({}); stub.clear();
  const start = probeAll(d).length;
  setProbeMode(d, "timer", { delayMs: 800 });                       // 800 ms (the probe's default is 300): margin for the harness's own latency between call A and call B
  await send(d, key, "main", { model: ASKED_MODEL, session: "uws0-x7" });
  setProbeMode(d, "observe");
  await send(d, key, "main", { model: ASKED_MODEL, session: "uws0-x7" });   // B: CCR deletes the module's cache entry and requires it again
  await waitFor(d, () => probeAll(d).slice(start).some((l) => l.kind === "timer"), 3500);
  return { log: probeAll(d).slice(start) };
}
async function x9Run(c, mode, id, shape, step) {
  const { d, key, stub } = c;
  stub.setScript({ sequence: [step, 200] }); stub.clear();
  const before = callsOf(probeAll(d)).length;
  const r = await send(d, key, shape, { model: ASKED_MODEL, agentId: `uws0-x9-${mode.slice(0, 2)}-${id}`, session: `uws0-x9-${mode.slice(0, 2)}`, agentTool: shape === "main" });
  await waitFor(d, () => callsOf(probeAll(d)).length > before, 2000);
  return { mode, id, status: r.status, headers: r.headers, ms: r.ms, attempts: stub.records.length, models: stub.records.map((x) => x.model), routerCalls: callsOf(probeAll(d)).length - before };
}
async function runX9(c) {
  const { d } = c, ev = { gw: { before: d.sys.listenerPid(SANDBOX_PORTS.gateway), after: null }, cases: [], main: null, swapErrors: [] };
  setProbeMode(d, "observe");
  c.shared.swapStarted = true;                                      // from here the proof reads Router.fallback fresh and an absent one is RED
  let err;
  try {
    for (const mode of X9_MODES) {
      try { await editSandboxConfig(c, `x9-${mode}`, (cfg) => { cfg.Router = { ...cfg.Router, fallback: fallbackFor(mode) }; }); }
      catch (e) { if (isFatal(e)) throw e; ev.swapErrors.push(`${mode}: ${safeMsg(e.message, 100)}`); continue; }      // the daemon rejected this swap: its cases stay unmeasured
      for (const cs of X9_CASES) ev.cases.push(await x9Run(c, mode, cs.id, "sub", cs.step));
      if (mode === "model-chain") ev.main = await x9Run(c, mode, "main", "main", { status: 429 });
    }
    ev.gw.after = d.sys.listenerPid(SANDBOX_PORTS.gateway);
  } catch (e) { err = e; }
  try { await restoreFallback(c); }
  catch (e) { c.out(L("FAIL", "probe", "X9a", `Router.fallback could NOT be restored to its original value in the sandbox config: ${safeMsg(e.message, 160)} (the teardown scrubs it too)`)); throw e; }
  if (err) { for (const l of x9Table(ev)) c.out(l); throw err; }   // the cases measured before the throw are kept, not discarded with it
  return ev;
}

async function runProbePhase(c) {
  const { d, key, stub } = c, emit = c.emit;                       // every line is emitted (printed and kept) the moment its evaluator returns, so a later throw cannot discard it
  const info = installRouter(d, "probe", c.approved);
  c.out(`probe router installed (sha256 ${info.sha}; LF-normalised ${info.lfSha}) at the scratch copy`);
  const probeLog = () => logObj(d.sys.readText(path.join(SCRATCH_STATE_DIR, "probe.jsonl")));
  const setMode = (mode) => writeSafe(d, path.join(SCRATCH_STATE_DIR, "probe-control.json"), JSON.stringify({ mode }));
  setMode("mutate");
  stub.clear();
  const r0 = await send(d, key, "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "uws0-a0" });
  await waitFor(d, () => stub.records.length >= 1 && probeLog().length >= 1, 8000);
  const ev0 = { status: r0.status, stubRec: stub.records[0], probe: probeLog()[0] };
  const a0 = evalA0Probe(ev0);
  emit(a0);
  if (a0.startsWith("FAIL")) return { abort: true };
  emit(evalE4(ev0)); emit(evalE5(ev0)); emit(evalE12(ev0));
  for (let i = 0; i < 2; i++) await send(d, key, "main", { model: ASKED_MODEL, session: "uws0-main" });
  await waitFor(d, () => probeLog().length >= 3, 8000);
  emit(evalE7(probeLog()));
  // E13: the CONTROL arm first (the router returns undefined and clears nothing: CCR must still honour the tag), then the clear-tag arm.
  const arm = async (mode, agentId) => {
    setMode(mode);
    stub.clear();
    const before = probeLog().length;
    const r = await send(d, key, "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId });
    await waitFor(d, () => probeLog().length > before, 8000);
    await waitFor(d, () => stub.records.length >= 1, 1500);
    return { status: r.status, stubRec: stub.records[0], probe: probeLog()[before] };
  };
  const control = await arm("keep-tag", "uws0-a13c");
  const clear = await arm("clear-tag", "uws0-a13");
  emit(evalE13({ control, clear }));
  // the revision 10 experiments, all on the probe router (X1-X5, X8 and X9 are informational; X7 must PASS)
  emit(evalX1(await runX1(c))); emit(evalX2(await runX2(c))); emit(evalX3(await runX3(c))); emit(evalX4(await runX4(c))); emit(evalX5(await runX5(c))); emit(evalX7(await runX7(c)));
  const x8 = { string: await runX8Arm(c, "string"), array: await runX8Arm(c, "array") };
  emit(evalX8(x8));
  c.shared.x8Reached = x8.array.probe && x8.array.stubRec ? x8.array.stubRec.markers?.[X8_MARK] === true : undefined;      // what H1 may expect of its notice
  const x9 = await runX9(c);
  for (const l of x9Table(x9)) c.out(l);
  for (const e of [evalX9a, evalX9b, evalX9c, evalX9d, evalX9e]) emit(e(x9));
  for (const n of NOT_RUN) c.out(n);
  return { abort: false };
}

/** Walks the CCR config dir for log-like files (never config.sqlite or any other binary) and calls fn(file, relativeName). */
function walkLogs(d, fn) {
  const walk = (dir, depth) => {
    let names;
    try { names = d.fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); continue; }
      if (/\.(log|txt|jsonl)$/i.test(e.name)) fn(p, path.relative(CCR_CONFIG_DIR, p));
    }
  };
  walk(CCR_CONFIG_DIR, 0);
}
function scanLoadFailure(d) {
  let files = 0, found = false;
  walkLogs(d, (p) => {
    files++;
    try { if (String(d.fs.readFileSync(p, "utf8")).includes("Failed to load custom router")) found = true; } catch { /* locked log */ }
  });
  return { found, files };
}

async function runNextPhase(c) {
  const { d, key, stub } = c, emit = c.emit;
  const info = installRouter(d, "next", c.approved);
  c.out(`router under test installed: exact bytes of router/uw-router.next.cjs (sha256 ${info.sha}; LF-normalised ${info.lfSha})`);
  stub.setScript({}); stub.clear();                                // no scripted answer or marker of the probe run leaks into this one
  const s1 = d.sys, dirExists = () => d.fs.existsSync(SCRATCH_STATE_DIR);
  const statusNow = () => { try { return JSON.parse(s1.readText(path.join(SCRATCH_STATE_DIR, "status.json")) ?? "null"); } catch { return null; } };
  await send(d, key, "main", { model: "uwstub/m-main", session: "uws0-main" });
  await send(d, key, "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "uws0-a1" });
  await waitFor(d, () => stub.records.length >= 2, 8000);
  emit(evalA1({ models: stub.records.map((r) => r.model), expected: ["uwstub/m-main", ASKED_MODEL], stateDirExists: dirExists() }));
  writeSafe(d, path.join(SCRATCH_STATE_DIR, "policy.json"), JSON.stringify(buildShadowPolicy(new Date(d.now()))));
  stub.clear();
  const rd = (f) => logObj(s1.readText(path.join(SCRATCH_STATE_DIR, f)));
  await send(d, key, "sub", { model: ASKED_MODEL, tag: TAG_MODEL, agentId: "uws0-a2" });
  await waitFor(d, () => rd("decisions.jsonl").length >= 1 && stub.records.length >= 1, 8000);
  const decision = rd("decisions.jsonl").find((x) => x.role === "sub");
  const classify = rd("classify.jsonl").find((x) => x.cls === "sub");
  emit(evalA0Next({ classify, decision })); emit(evalA2({ decision, stubModel: stub.records[0]?.model, agents: rd("agents.jsonl") }));      // router v2 logs the new agent to decisions.jsonl AND agents.jsonl
  await waitFor(d, () => statusNow() !== null, 1000);                // R7: the router's first status write is asynchronous (no synchronous flush on the request path): poll up to 1 s for it
  const first = statusNow();                                       // the first flush: its `since` must still be the last flush's
  for (let i = 0; i < 2; i++) await send(d, key, "main", { model: "uwstub/m-main", session: "uws0-main" });
  await d.sleep(5500);                                            // the router flushes status at most every 5 s: a request after the pause forces a flush
  await send(d, key, "main", { model: "uwstub/m-main", session: "uws0-main" });
  await waitFor(d, () => (s1.readText(path.join(SCRATCH_STATE_DIR, "status.json")) ?? "").includes('"req"'), 4000);
  const status = statusNow();
  const sc = scanLoadFailure(d);
  const workerFiles = (() => { try { return d.fs.readdirSync(SCRATCH_STATE_DIR).map((e) => (typeof e === "string" ? e : e.name)).filter((n) => /^status-[0-9a-z]{1,13}.json$/.test(n)).length; } catch { return 0; } })();
  // H1 (informational) runs on the exact bytes AFTER the A8 evidence was taken (it changes the policy and the counters); then the probe is put back for ONE peek at the loader registry
  emit(await runHandoffSmoke(c));
  const registry = await peekRegistry(c);
  // six requests reached the router in all (A1 two, A2 one, two mains, one after the pause) and the router counts every request, policy or not
  emit(evalA8({ status, first, min: 6, loadFailure: sc.found, logFiles: sc.files, workerFiles, registry }));
  return { abort: false };
}

/** H1: the handoff smoke on the exact bytes with the ENFORCE synthetic policy (see evalH1). The state directory is the router's own, so the evidence is read from agents.jsonl. */
async function runHandoffSmoke(c) {
  const { d, key, stub } = c, sid = "uws0-h1", aid = "uws0-h1a";
  writeSafe(d, path.join(SCRATCH_STATE_DIR, "policy.json"), JSON.stringify(buildEnforcePolicy(new Date(d.now()))));
  stub.setScript({ markers: [NOTICE_MARK] }); stub.clear();
  const sub = (messages) => send(d, key, "sub", { model: ASKED_MODEL, session: sid, agentId: aid, messages, agentTool: false });
  await send(d, key, "main", { model: ANCHOR, session: sid });       // teaches main (the Agent tool and a session id)
  await sub(3);                                                      // the decision
  await sub(3);                                                      // the SAME length again: the retry signal len
  await sub(5);                                                      // grown messages: no handoff
  await waitFor(d, () => stub.records.length >= 4, 4000);
  const agents = logObj(d.sys.readText(path.join(SCRATCH_STATE_DIR, "agents.jsonl"))).filter((l) => l && l.aid === aid);
  return evalH1({ recs: stub.records.slice(1, 4), agents, x8Reached: c.shared?.x8Reached ?? null, aid });
}

/** Puts the PROBE router back in the scratch copy (the state directory is kept) and reads globalThis.__uwRouterImpl in whichever worker answers, twice. Undefined when no probe line came back. */
async function peekRegistry(c) {
  const { d, key, stub } = c;
  const info = installRouter(d, "probe", c.approved, { keepState: true });
  c.out(`probe router put back for the registry peek (sha256 ${info.sha}); the state directory of the exact bytes is kept`);
  setProbeMode(d, "registry"); stub.setScript({}); stub.clear();
  const before = callsOf(probeAll(d)).length;
  for (let i = 0; i < 2; i++) await send(d, key, "main", { model: ASKED_MODEL, session: "uws0-main" });
  await waitFor(d, () => callsOf(probeAll(d)).length >= before + 2, 3000);
  const l = callsOf(probeAll(d)).slice(before).filter((x) => x.reg).pop();
  return l ? { keys: l.reg.keys, own: l.reg.own, pid: l.pid } : undefined;
}

/** The evidence of a refused or failed run, copied OUT of the scratch root before the teardown deletes it: violations.log and the last 200 lines of each CCR log, redacted. */
function collectEvidence(d, { lines = [], stubRecords = [] } = {}) {
  const stamp = new Date(d.now()).toISOString().replace(/[:.]/g, "-");
  const dir = path.join(EVIDENCE_ROOT, stamp);
  const ev = { dir, violations: [], files: [] };
  const clean = (t) => redactSecrets(t).split(WEB_AUTH_TOKEN).join("<redacted>");
  const put = (name, text) => { writeEvidence(d, path.join(dir, name), text); ev.files.push(name); };
  // a throw ends the run before its verdict and the teardown deletes state/: the result lines already emitted, probe.jsonl (counts, hashes, booleans and id shapes only, written by the probe router) and
  // the stub's records reduced to sizes, hashes, shapes and header NAMES (never a body, a header value or the Agent tool description) are kept here
  if (lines.length) put("result-lines.txt", lines.map(clean).join("\n") + "\n");
  const probe = d.sys.readText(PROBE_LOG);
  if (probe != null) put("probe.jsonl.txt", clean(probe.split(/\r?\n/).filter(Boolean).slice(-500).join("\n")) + "\n");
  if (stubRecords.length) put("stub-records.jsonl.txt", stubRecords.slice(-500).map((r) => clean(JSON.stringify({ seq: r.seq, t: r.t, path: r.path, model: r.model, bodyBytes: r.bodyBytes, bodySha256: r.bodySha256, messagesLen: r.messagesLen, messagesSha256: r.messagesSha256,
    toolsSha256: r.toolsSha256, toolNames: r.toolNames, systemShape: r.systemShape, sysBlocks: r.sysBlocks, sysCc: r.sysCc, markers: r.markers, sent: r.sent, headerNames: Object.keys(r.headers ?? {}) }))).join("\n") + "\n");
  const viol = d.sys.readText(VIOLATIONS_LOG);
  if (viol != null) { ev.violations = viol.split(/\r?\n/).filter(Boolean).map(clean); put("violations.log.txt", ev.violations.join("\n") + "\n"); }
  const loaded = d.sys.readText(GUARD_LOADED_LOG);
  if (loaded != null) put("guard-loaded.log.txt", clean(loaded));
  walkLogs(d, (p, rel) => {
    let text; try { text = String(d.fs.readFileSync(p, "utf8")); } catch { return; }
    put(`ccr-${rel.replace(/[\\/]+/g, "__")}.txt`, redactDaemonLog(clean(text.split(/\r?\n/).slice(-200).join("\n"))) + "\n");
  });
  return ev;
}

// ---------------------------------------------------------------- teardown (identity-verified)
/** Why this pid must NOT be stopped (an empty list = it may be). The checks need no baseline, so --teardown mode applies them too. `owners(port)` answers who listens on a live port (memoised by the caller: one probe per port, not one per pid). */
function stopRefusals(d, pid, baseline, owners = (p) => d.sys.listenerPid(p)) {
  const why = [];
  if (baseline?.ccrPids?.includes(pid)) why.push("it is in the baseline set of LIVE CCR pids");
  const live = liveServicePid(d.sys);
  if (live != null && pid === live) why.push("it is the pid in the live service.json");
  const held = REAL_PORTS.filter((p) => owners(p) === pid);
  if (held.length) why.push(`it owns live port(s) ${held.join(",")}`);
  return why;
}

/**
 * ORDER (a closed console window gives the process only a few seconds): the daemon tree is stopped FIRST, after the identity checks and nothing else. Those checks
 * need the process table (one PowerShell call), one probe per live port (memoised across pids) and the sandbox web-port holder; the stub, the sandbox-port check, the
 * removal and every other slow probe come AFTER the stop. The provider scrub through the web RPC is only a fallback for a daemon that was NOT stopped (it is a
 * dead end once the daemon is gone, and the scratch config is deleted below anyway). `afterStop` (the stub) runs right after the stop, before the port check.
 */
async function selectiveTeardown(d, spec, { baseline, afterStop } = {}) {
  const notes = [];
  let ok = true;
  const note = (s, bad = false) => { const t = redactSecrets(s); notes.push(t); if (bad) ok = false; d.out(`teardown: ${t}`); };
  let svcPid, stopped = false;
  try { svcPid = d.resolveWebPort().pid; } catch { note("no running sandbox daemon (service.json absent or not ours)"); }
  if (svcPid) {
    const rows = d.sys.processes();
    const row = rows.find((r) => r.pid === svcPid);
    if (!row) { note(`pid ${svcPid} is no longer running (nothing to stop)`); stopped = true; }
    else {
      const seen = new Map(), owners = (p) => { if (!seen.has(p)) seen.set(p, d.sys.listenerPid(p)); return seen.get(p); };
      const why = stopRefusals(d, svcPid, baseline, owners);
      if (!/claude-code-router/i.test(row.cmd) || !/daemon-child/i.test(row.cmd)) why.push("its command line is not the CCR daemon-child");
      const holder = (n) => d.sys.listenerPid(spec.ports[n]);
      // lazy: the web-port holder is one probe; the gateway/core holders are asked only when the daemon does not hold the web port itself
      const holdsWeb = holder("web") === svcPid;
      const parentOfGateway = holdsWeb || ["gateway", "core"].some((n) => { const h = holder(n); return h !== undefined && rows.some((r) => r.pid === h && r.ppid === svcPid); });
      if (!holdsWeb && !parentOfGateway) why.push("it holds neither the sandbox web port nor is the parent of the process holding the sandbox gateway or core port");
      const kids = descendantsLeafFirst(rows, svcPid);             // deepest first: a child is stopped before its parent
      for (const k of kids) { const w = stopRefusals(d, k, baseline, owners); if (w.length) why.push(`its descendant ${k}: ${w.join(", ")}`); }
      if (why.length) note(`pid ${svcPid} is not a verified sandbox CCR daemon (${why.join("; ")}): NOT stopped`, true);
      else {
        for (const k of kids) { d.sys.stopProcess(k); note(`stopped sandbox daemon descendant pid ${k}`); }
        d.sys.stopProcess(svcPid); note(`stopped sandbox daemon pid ${svcPid}`);
        stopped = true;
      }
    }
  }
  if (afterStop) { try { await afterStop(); } catch { /* best effort: the stub is in this process */ } }
  if (svcPid && !stopped) {
    try {
      const cfg = structuredClone(await d.rpc("getConfig"));
      cfg.Providers = []; cfg.CUSTOM_ROUTER_PATH = ""; cfg.Router = { ...cfg.Router, fallback: { ...cfg.Router?.fallback, mode: "off", models: [] } };   // X9's hot-swapped fallback is scrubbed too
      d.guard.assertPayloadIsolated(cfg);                         // still isolated, still has its global anchor (never disable the profile subsystem)
      await d.rpc("saveConfig", [cfg, { applyProfile: false }]);
      note("the daemon was NOT stopped: scrubbed Providers[], CUSTOM_ROUTER_PATH and Router.fallback (back to off) from the sandbox config");
    } catch (e) { note(`scrub skipped: ${safeMsg(e.message, 120)}`); }
  }
  let held = [];
  for (let i = 0; i < 4; i++) {
    held = ["gateway", "core", "web", "stub"].map((n) => [n, d.sys.listenerPid(spec.ports[n])]).filter(([, o]) => o);
    if (!held.length) break;
    await d.sleep(400);
  }
  for (const [n, o] of held) note(`WARNING sandbox ${n} port ${spec.ports[n]} is still held by pid ${o}`, true);
  for (const name of SANDBOX_OWNED) {
    const target = path.join(SCRATCH_ROOT, name);
    for (let i = 0; i < 3; i++) { try { rmSafe(d, target); break; } catch (e) { if (i === 2) note(`could not remove ${name}: ${safeMsg(e.message, 80)}`, true); else await d.sleep(500); } }
  }
  note(`removed sandbox-owned entries (${SANDBOX_OWNED.length} names); everything else under the scratch root was left alone`);
  return { notes, ok };
}

// ---------------------------------------------------------------- approval (owner act) and the run
const checkNoGuardToken = (opts, sha256) => {
  if (!opts.preloadGuard && opts.noGuardToken !== sha256.slice(0, 12)) {
    return "--no-preload-guard drops the fail-closed guard and needs a second explicit token: --i-understand-no-guard <the first 12 hex characters of the plan sha256 printed by `--plan --no-preload-guard`>";
  }
  return null;
};

function checkApproval(d, text, sha256, fileHashes = []) {
  const how = "run `node harness/subagent-e2e.mjs --plan` (same flags), read it, then `--approve-plan` (an owner act)";
  if (text == null) return `no approval file ${APPROVAL_FILE}: ${how}`;
  let a;
  try { a = JSON.parse(text); } catch { return `the approval file is not valid JSON: ${how}`; }
  if (!a || a.schema !== 1 || typeof a.planSha256 !== "string" || typeof a.approvedAt !== "string") return `the approval file has the wrong shape: ${how}`;
  const at = Date.parse(a.approvedAt);
  if (!Number.isFinite(at)) return `the approval timestamp is unreadable: ${how}`;
  const age = d.now() - at;
  if (age > APPROVAL_MAX_AGE_MS) return `the approval is ${Math.round(age / 3600000)} h old (valid 24 h): ${how}`;
  if (age < -5 * 60 * 1000) return `the approval is dated in the future: ${how}`;
  if (a.planSha256 !== sha256) {
    const changed = Array.isArray(a.files) ? fileHashes.filter((f) => { const o = a.files.find((x) => x && x.file === f.file); return !o || o.raw !== f.raw || o.lf !== f.lf; }).map((f) => f.file) : [];
    return `the approval is for a DIFFERENT plan (approved ${a.planSha256.slice(0, 12)}, current ${sha256.slice(0, 12)}): the plan text changed, other flags were used${changed.length ? `, or an executed file changed since the approval (${changed.join(", ")})` : ""}; ${how}`;
  }
  return null;
}

/** The names (never the values: a proxy URL can carry credentials) of the variables that would send this orchestrator's own fetch and RPC through a proxy. NO_PROXY alone is harmless. */
export const proxyVarsSet = (env) => Object.keys(env ?? {}).filter((k) => /^(NODE_USE_ENV_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY)$/i.test(k) && String(env[k] ?? "").trim() !== "").sort();

export async function runE2e(argv, io = {}) {
  const d = { ...defaults(), ...io };
  const parsed = parseArgs(argv);
  if (!parsed.ok) { for (const e of parsed.errors) d.err(e); for (const l of USAGE) d.err(l); return 2; }
  const opts = parsed.opts;
  if (opts.help) { for (const l of USAGE) d.out(l); return 0; }
  if (opts.hostCheck) {                                            // X6: standalone, touches only a directory of its own under the OS temp dir; needs neither the spec, the approval nor the sandbox
    d.err("--host-check x6: do not run this during G1 (it loads the disk and can disturb the X7 timer margins)");
    try { await hostCheckX6({ ...(d.x6 ?? {}), out: d.out }); return 0; } catch (e) { d.err(`host check x6 failed: ${safeMsg(e.message, 200)}`); return 1; }
  }
  let spec;
  try { spec = assertSandboxSpec(d.buildSpec(d.env, { preloadGuard: opts.preloadGuard })); } catch (e) { d.err(e.message); return 1; }
  const fileHashes = d.hashFiles();                                // the reads --plan makes: the sha256 of every file the run executes or loads ...
  const ccr = d.ccrInstall();                                      // ... and the installed CCR (ccr.cmd, package.json, dist/main/cli.js), resolved without running anything
  const plan = planOf(spec, { ...opts, fileHashes, ccr });
  if (opts.plan) {
    for (const l of plan.lines) d.out(l);
    d.out(""); d.out(`plan sha256: ${plan.sha}`);
    if (!spec.preloadGuard) d.out(`no-guard token: --i-understand-no-guard ${plan.sha.slice(0, 12)}`);
    return 0;
  }
  if (opts.teardown) { const r = await selectiveTeardown(d, spec); return r.ok ? 0 : 1; }
  if (opts.approvePlan) {
    const tokenErr = checkNoGuardToken(opts, plan.sha);
    if (tokenErr) { d.err(tokenErr); return 2; }
    if (!ccr.found) { d.err(`refusing to approve a plan whose CCR install is NOT FOUND (${oneLine(ccr.reason, 160)})`); return 1; }
    if (!d.interactive()) { d.err("--approve-plan is an owner act and needs an interactive terminal (stdin and stdout both a TTY): refusing. Run it yourself in a console, after reading --plan."); return 2; }
    const want = plan.sha.slice(0, 12);
    d.out(`approving the plan whose sha256 begins ${want} (flags: --router ${opts.router}${spec.preloadGuard ? "" : " --no-preload-guard"}); read --plan first`);
    const typed = String(await d.ask(`type the first 12 hex characters of the plan sha256 (${want}) to approve, anything else cancels: `)).replace(/[\r\n]+$/, "");
    if (typed !== want) { d.err("the typed confirmation does not match the plan sha256: nothing was approved"); return 2; }
    const doc = { schema: 1, planSha256: plan.sha, approvedAt: new Date(d.now()).toISOString(), router: opts.router, preloadGuard: spec.preloadGuard, files: fileHashes };
    writeEvidence(d, APPROVAL_FILE, JSON.stringify(doc, null, 2) + "\n");
    d.out(`approval written: ${APPROVAL_FILE} (plan sha256 ${plan.sha}; ONE-USE, valid 24 h at most; run with the same flags)`);
    return 0;
  }
  if (!opts.experimentsOnly) { d.err("the full A0-A13 gate run is stage S3 and is not built in S0: pass --experiments-only"); return 2; }
  if (!opts.g1) { d.err("refusing: gate G1 (start a second CCR 3.0.22 daemon beside the live one) needs the owner's explicit approval; pass --g1-approved"); return 2; }
  const tokenErr = checkNoGuardToken(opts, plan.sha);
  if (tokenErr) { d.err(tokenErr); return 2; }
  if (!ccr.found) { d.err(`refusing: the installed CCR was NOT FOUND (${oneLine(ccr.reason, 160)}): nothing can be said about the code the run would execute`); return 1; }
  const proxied = proxyVarsSet(d.env);                             // BEFORE the approval is consumed: this orchestrator's own fetch and RPC must not be able to leave through a proxy (the daemon env already drops them)
  if (proxied.length) { d.err(`refusing: ${proxied.join(", ")} ${proxied.length === 1 ? "is" : "are"} set in this shell, which could send the sandbox gateway and web RPC traffic through a proxy. Unset ${proxied.length === 1 ? "it" : "them"} (NO_PROXY alone is fine) and run again; nothing was started and the approval was not consumed`); return 1; }
  // `d.externalApproval` (the scenario suite and the self-test, harness/subagent-scenarios.mjs): THEIR OWN typed-approval ceremony has already been checked and consumed by the caller, so this run's file
  // is not read; it returns null, or the text of a refusal. Without it nothing changes: the approval file below is checked and consumed here.
  const ext = d.externalApproval ? await d.externalApproval({ plan, fileHashes, ccr }) : null;
  if (ext) { d.err(`refusing: ${ext}`); return 2; }
  const approvalText = d.externalApproval ? null : d.sys.readText(APPROVAL_FILE);
  const approvalErr = d.externalApproval ? null : checkApproval(d, approvalText, plan.sha, fileHashes);
  if (approvalErr) { d.err(`refusing: --g1-approved alone is not enough. ${approvalErr}`); return 2; }
  // ONE-USE, and race-free: the approval is consumed by an ATOMIC RENAME to a unique name before anything else happens. Of two runs that both passed the check above only the one whose rename
  // succeeds proceeds (a rename of a file that is already gone fails); a refusal later (or a crash) still needs a fresh approval for the next run. The renamed file must hold the bytes that were checked.
  const used = approvalUsedFile(d.sys.selfPid, d.now());
  if (!d.externalApproval) {
  try { d.fs.renameSync(safeEvidencePath(APPROVAL_FILE), safeEvidencePath(used)); } catch (e) { d.err(`refusing: the approval file could not be consumed (${oneLine(e.code ?? e.message, 120)}): another run may have consumed it first; a run needs a fresh --approve-plan`); return 2; }
  if (d.sys.readText(used) !== approvalText) { d.err(`refusing: the consumed approval (${path.basename(used)}) is not the file that was checked; a run needs a fresh --approve-plan`); return 2; }
  try { d.fs.rmSync(safeEvidencePath(used), { force: true }); } catch { /* best effort: harness/g1-* is gitignored and the file is inert */ }
  }
  d.out(`approval consumed (plan sha256 ${plan.sha}); executed files:`);
  for (const f of fileHashes) d.out(`  ${f.file}  raw ${f.raw}  lf ${f.lf}`);
  const routers = opts.router === "both" ? ["probe", "next"] : [opts.router];
  RUN_SECRETS.clear();
  const lines = [], shared = {};                                    // lines: every result line, in the order emitted (the verdict reads all of them); shared: what the phases hand to each other and to the proof (x8Reached, swapStarted)
  let failure, baseline, stub, daemonPid, started = false, evidence, td, unhook = () => {};
  const say = (s) => d.out(s);
  const emit = (l) => { lines.push(l); say(l); };
  const deps = (tripwire) => ({ sys: d.sys, tripwire, assertIsolatedInstance: d.guard.assertIsolatedInstance, assertIsolatedConfig: d.guard.assertIsolatedConfig, resolveWebPort: d.resolveWebPort, getConfig: () => d.rpc("getConfig"), assertRouterClean: d.guard.assertRouterClean, sleep: d.sleep, now: d.now, redact: (t) => redactSecrets(t) });
  const prove = async (tripwire, phase, stage) => {
    const r = await proveIsolation({ spec, baseline, phase, daemonPid, selfPid: d.sys.selfPid, stage, swapRan: shared.swapStarted === true, track: (shared.proofTrack ??= {}) }, deps(tripwire));
    for (const ch of r.checks) say(`${ch.recorder ? "RECORD" : ch.ok ? "GREEN " : "RED   "} ${ch.n} ${ch.name} :: ${ch.detail}`);
    return assertIsolationProven(r);
  };
  const approved = new Map(fileHashes.map((f) => [f.file, f.raw]));
  const movedFiles = (now) => (now.length !== fileHashes.length ? ["(file list differs)"] : now.filter((f, i) => f.raw !== fileHashes[i]?.raw || f.lf !== fileHashes[i]?.lf || f.file !== fileHashes[i]?.file).map((f) => f.file));
  let tripwire, tdPromise;
  // The PROMISE is memoised: a second caller (a signal during the main-flow teardown) waits for the SAME teardown instead of getting undefined and exiting while it is half done.
  const teardownOnce = () => (tdPromise ??= Promise.resolve().then(async () => { td = await selectiveTeardown(d, spec, { baseline, afterStop: async () => { if (stub) await stub.stop(); } }); return td; }));   // assigned BEFORE the teardown body runs: even a re-entrant call gets the same promise
  const afterTeardownTripwire = () => { try { tripwire?.assert("e2e:after-teardown"); return null; } catch (e) { return e; } };
  try {
    for (const [what, file] of [["the probe router", PROBE_ROUTER_SRC], ["the router under test", NEXT_ROUTER_SRC]]) if (!d.fs.existsSync(file)) refuse(`${what} is missing: ${file}`);
    const stale = MUST_BE_ABSENT.filter((p) => d.fs.existsSync(p));
    if (stale.length) refuse(`the scratch tree is not fresh: ${stale.map((p) => path.basename(p)).join(", ")} exist under ${SCRATCH_ROOT} (a leftover of an earlier sandbox). Run \`node harness/subagent-e2e.mjs --teardown\` first; no config file is read or printed`);
    baseline = baselineOf(d.sys);
    say(`BEFORE live: ${describeFingerprint(baseline)}`);
    if (baseline.liveServicePid == null || baseline["listener:3456"] == null) say("WARNING: the live gateway was not observed (no live service.json pid or no listener on 3456): A11 will be a FINDING, not a PASS");
    for (const [n, p] of Object.entries(spec.ports)) { const o = d.sys.listenerPid(p); if (o) refuse(`sandbox port ${p} (${n}) is already held by pid ${o}`); }
    if (spec.preloadGuard && (d.sys.readText(VIOLATIONS_LOG) != null || d.sys.readText(GUARD_LOADED_LOG) != null)) refuse("stale guard logs exist from an earlier run: run --teardown first");
    try { const w = d.resolveWebPort(); if (d.sys.processes().some((r) => r.pid === w.pid)) refuse(`a sandbox daemon (pid ${w.pid}) is already running: run --teardown first`); } catch (e) { if (e instanceof RefusalError) throw e; /* no service.json: no daemon */ }
    tripwire = d.makeTripwire();
    tripwire.assert("e2e:start");
    say(`Announcement: starting a SANDBOX CCR 3.0.22 daemon on ${SANDBOX_PORTS.gateway}-${SANDBOX_PORTS.web} beside the live one. The live gateway is not touched or restarted.`);
    const again = d.hashFiles();                                  // the files hashed now must be the ones the approved plan named
    const moved = movedFiles(again);
    if (moved.length || again.length !== fileHashes.length) refuse(`an executed file changed between the approved plan and the start: ${moved.join(", ") || "(file list differs)"}`);
    if (ccrInstallLines(d.ccrInstall()).join("\n") !== ccrInstallLines(ccr).join("\n")) refuse("the installed CCR (ccr.cmd, package version or dist/main/cli.js) changed between the approved plan and the start");
    started = true;
    unhook = d.onSignal(async (sig) => {
      d.err(`${sig}: keeping the evidence, then running the identity-verified selective teardown`);
      if (!evidence) { try { evidence = collectEvidence(d, { lines, stubRecords: stub?.records }); } catch (e) { d.err(`evidence not retained: ${safeMsg(e.message, 160)}`); } }   // BEFORE the teardown: it deletes the logs the evidence is copied from (cheap: local files only)
      await teardownOnce();                                       // the memoised promise: a signal during the main-flow teardown waits for that same teardown
      const e = afterTeardownTripwire();
      if (e) d.err(`after the teardown (signal path): ${safeMsg(e.message, 300)}`);
    });
    for (const dir of PRECREATE_DIRS) d.fs.mkdirSync(safeWritePath(dir), { recursive: true });   // every directory the sandbox env points at exists before step 0
    for (const [i, step] of spec.commands.entries()) {
      if (i > 0) { const m = movedFiles(d.hashFiles()); if (m.length) refuse(`an executed file changed after the run started, before step ${step.id}: ${m.join(", ")}`); }   // each file is re-checked at its point of use (the bootstrap script, the guard and the helpers it loads)
      const r = await d.runStep(step, i === 0 ? spec.env : minimalEnv(d.env));   // the bootstrap runs under the REAL home so its tripwire watches the REAL settings file, with a minimal env
      if (i === 0) tripwire.assert("e2e:after-start");                 // first thing after `ccr start`, also when it exited non-zero: a takeover write is the likeliest failure
      if (r.code !== 0) refuse(`step ${step.id} exited ${r.code}: ${redactSecrets(r.tail)}`);
      if (i === 0) daemonPid = d.resolveWebPort().pid;
      say(`step ${step.id} ok`);
    }
    await prove(tripwire, "pre-provider", "after-bootstrap");
    stub = d.createStub({ port: SANDBOX_PORTS.stub });
    await stub.start();
    const k = await configureSandbox(d, spec);
    tripwire.assert("e2e:after-configure");
    if (k.error) { emit(L("FAIL", routers[0], "A0", `${k.error}: the enricher gate cannot be satisfied`)); throw new RefusalError(`REFUSED: ${k.error}`); }
    await prove(tripwire, "post-provider", "after-provider-save");
    const ctx = { d, key: k.key, stub, out: say, emit, approved, tripwire, fallback: k.fallback, shared, baseline, daemonPid: () => daemonPid };      // baseline (the LIVE CCR pids) and the sandbox daemon pid: the scenario suite's identity-checked stop of the sandbox core worker needs both
    if (d.sessionPhases) {                                          // the scenario suite: its phases run on the SAME sandbox, after the same proofs, and end with the same isolation proof
      const res = await d.sessionPhases(ctx);
      emit(evalA11("next", baseline, baselineOf(d.sys)));
      await prove(tripwire, "post-provider", "after-scenarios");
      if (res?.abort) shared.aborted = true;
    } else for (const r of routers) {
      const res = r === "probe" ? await runProbePhase(ctx) : await runNextPhase(ctx);
      emit(evalA11(r, baseline, baselineOf(d.sys)));
      await prove(tripwire, "post-provider", `after-${r}-run`);
      if (res.abort) break;
    }
  } catch (e) { failure = e; }
  finally {
    // the signal handler stays hooked until the teardown has COMPLETED: unhooked earlier, a Ctrl+C during it would get Node's default action and end the process halfway
    if (started) {
      try { if (!evidence && (failure || (d.sys.readText(VIOLATIONS_LOG) ?? "") !== "")) evidence = collectEvidence(d, { lines, stubRecords: stub?.records }); } catch (e) { d.err(`evidence not retained: ${safeMsg(e.message, 160)}`); }
      try { await teardownOnce(); } catch (e) { d.err(`teardown failed: ${safeMsg(e.message, 160)}`); }
      const te = afterTeardownTripwire();                          // a write to live state that appeared only while the sandbox was being stopped
      if (te) { if (failure) d.err(`after the teardown: ${safeMsg(te.message, 300)}`); else failure = te; }
    }
    unhook();
  }
  const after = baselineOf(d.sys);
  const drift = baseline ? diffFingerprint((({ ccrPids: _c, ...b }) => b)(baseline), (({ ccrPids: _c, ...a }) => a)(after)) : [];
  say(`AFTER  live: ${describeFingerprint(after)}`);
  say(drift.length ? `LIVE STATE CHANGED: ${drift.join("; ")}` : "live state identical before and after");
  if (evidence) say(`evidence retained outside the scratch root: ${evidence.dir} (${evidence.files.length} files, redacted)`);
  if (td && !td.ok) say("TEARDOWN INCOMPLETE: a sandbox port is still held, a process was not stopped, or an entry could not be removed (see the teardown lines above); run --teardown");
  if (failure) {
    if (lines.length) say(`the run stopped before its verdict: ${lines.length} result line${lines.length === 1 ? "" : "s"} were already emitted above (${Object.entries(evaluateRun(lines, routers).counts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"})${evidence ? "; they are kept in the retained evidence as result-lines.txt" : ""}`);
    d.err(failure instanceof RefusalError ? safeMsg(failure.message, 2000) : `FAILED: ${safeMsg(failure.message, 300)}`);
    if (evidence?.violations.length) d.err(`violations.log (${evidence.violations.length} line${evidence.violations.length === 1 ? "" : "s"}, redacted): ${evidence.violations.slice(0, 10).map((v) => oneLine(v, 200)).join(" | ")}`);
    return 1;
  }
  const verdict = d.sessionVerdict ? d.sessionVerdict(lines) : evaluateRun(lines, routers);
  for (const p of verdict.problems) d.err(`PROBLEM: ${p}`);
  if (evidence?.violations.length) d.err(`violations.log (${evidence.violations.length} lines, redacted): ${evidence.violations.slice(0, 10).map((v) => oneLine(v, 200)).join(" | ")}`);
  const good = verdict.ok && drift.length === 0 && (!td || td.ok);
  say(`summary: ${JSON.stringify(verdict.counts)}; ${good ? "OK" : "NOT OK"}`);
  return good ? 0 : 1;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase();
if (isMain) process.exit(await runE2e(process.argv.slice(2)));

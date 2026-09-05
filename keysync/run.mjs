// keysync runner. Applies the generated config to a CCR instance.
//
//   node run.mjs --dry                 build + validate, write nothing
//   node run.mjs --target isolated     apply to the isolated harness instance
//   node run.mjs --target live         apply to the live CCR install
//
// --target live writes the REAL ~/.claude/settings.json and will change how any
// running Claude Code session routes. It refuses unless --i-know is also passed.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { RESERVED } from "../menu/denylist.mjs";
import { fetchAnthropicIds } from "./anthropic-catalog.mjs";
import {
  loadVault, filterRegistry, chooseKeys, loadCatalog, buildProviders,
  validate, stripOneMSuffix, reconcileUserModelPin, KEY_CHOICES, ANCHOR_PREFERENCE,
  ANTHROPIC_RELAY, ANTHROPIC_TIERS
} from "./keysync.mjs";
import {
  snapshotConfigDb, deleteStaleWifToken, retainOnSuccess, capFailedSnapshots,
  restoreSettings, restoreConfigDbHint, liveConfigDir, liveConfigDb,
  acquireLock, restartRelevantFingerprint, waitForGateway, otherClaudeSessions,
  atomicWriteJson
} from "./safety.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const target = val("--target", "dry");
const dry = has("--dry") || target === "dry";

const EXPECTED_PROVIDERS = 44;
const BUILT_ROWS = "C:\\Users\\osami\\.uw\\keysync\\built-rows.json";

/**
 * S1: the bare-id collision guard. Report 08 F1 is stopped here and nowhere else.
 *
 * WHY HERE AND NOT IN buildProviders. The exploitable condition is SOLE
 * OWNERSHIP of a Claude-shaped id across the whole built config -- CCR's
 * `providerModelMatches` iterates raw Providers[].models[] behind only a
 * provider-level enabled gate, and `resolve()` binds on exactly one match,
 * returning undefined on more than one. `buildProviders` processes one provider
 * at a time and cannot evaluate ownership. That is why the old name-rejection
 * control sat in the wrong function AND enforced the wrong rule.
 *
 * WHAT IT DOES NOT DO: prune. No model is removed, no provider is dropped. It
 * reports, and on the one dangerous shape it stops the run.
 *
 * @param {object[]} providers  the built `Providers[]`, each `{name, models: [{id}]}`
 * @param {object}  [opts]
 * @param {string}  [opts.relay="anthropic"]   the provider name of our own relay
 * @param {boolean} [opts.allowBare=false]     --allow-bare-claude-names
 * @param {Set<string>|null} [opts.realIds=null]  ids Anthropic actually publishes
 *   (from anthropic-catalog.mjs's live /v1/models, unioned with ANTHROPIC_FULL by
 *   the caller). null means "could not be determined" and the guard falls back
 *   to the old, broader RESERVED-only match -- see the narrowing comment below.
 * @returns {{hijackable: object[], shadowed: object[], fatal: boolean, message: string}}
 */
export function checkBareCollisions(providers, { relay = "anthropic", allowBare = false, realIds = null } = {}) {
  const byBare = new Map();
  for (const p of providers ?? []) {
    // CCR's own gate. `providerModelMatches` checks the provider is enabled before
    // it looks at any id, so a disabled co-owner does not count towards ownership
    // there -- and counting it here would read two owners as ambiguous while CCR
    // sees exactly one match and binds. Always true in today's generated config,
    // so this is a latent divergence rather than a live one.
    if (p.enabled === false) continue;
    for (const m of p.models ?? []) {
      // Accepts both shapes deliberately: the built config carries `models` as a
      // string[], while the guard's own tests inject `{id}` objects.
      const id = String(m?.id ?? m ?? "");
      // An id that already carries a `/` is vendor-prefixed and is not what
      // Claude Code sends for a built-in row, so it cannot be the stage-4 match.
      // tokenharbor lists exactly this shape; treating it as hijackable would
      // block a live reseller for a threat that cannot reach it.
      if (id.includes("/")) continue;
      // RESERVED is imported, not re-typed. The previous inline regex was
      // /^(claude|opus|sonnet|haiku)([-\d]|$)/ -- it omitted `fable` entirely and
      // its boundary class was narrower than the denylist's, so `sonnet.1` and
      // `haiku_2` were reserved by one definition and invisible to the other.
      if (!RESERVED.test(id)) continue;
      // NARROWING (BACKLOG item 2). RESERVED asks "is this Claude-SHAPED"; the
      // guard's actual concern is "could Claude Code send this bare and bind it
      // to the wrong host", which only a REAL Anthropic id can ever trigger --
      // Claude Code never emits a name Anthropic has not published. Without
      // this, `claude-opus-5-thinking` (a reseller invention; extended thinking
      // is a request parameter, not a model) reads as hijackable at tabiai and
      // gorouter for a threat that cannot reach it.
      //
      // realIds === null means "could not be determined" (relay unreachable,
      // no cache) -- fall back to the OLD broad behaviour rather than either
      // extreme. Silently trusting every RESERVED id when uncertain would
      // under-flag; silently rejecting all of them would refuse the escape
      // hatch this guard exists to preserve. RESERVED alone, unchanged, is what
      // shipped before this task and is the safe default when unverifiable.
      if (realIds !== null && !realIds.has(id)) continue;
      if (!byBare.has(id)) byBare.set(id, new Set());
      byBare.get(id).add(p.name);
    }
  }

  const hijackable = [], shadowed = [];
  for (const [id, owners] of byBare) {
    if (owners.size === 1 && !owners.has(relay)) hijackable.push({ id, owner: [...owners][0] });
    else if (owners.size > 1) shadowed.push({ id, owners: [...owners].sort() });
  }
  hijackable.sort((a, b) => a.id.localeCompare(b.id));
  shadowed.sort((a, b) => a.id.localeCompare(b.id));

  // THE REMEDY WORDING IS LOAD-BEARING, and a test asserts it. An error that
  // tells the operator to remove a provider's model is an error that teaches a
  // rule-2 violation, and it would send them to delete the very models tabiai
  // and gorouter are being paid for. The two honest remedies are: give the id a
  // second owner by starting the relay, or accept the routing deliberately.
  let message;
  if (hijackable.length) {
    // OFFER THE RELAY ONLY WHERE IT CAN ACTUALLY HELP. Co-ownership works only for
    // ids the relay itself serves, and the id most likely to fire this guard is
    // `claude-opus-4-8` -- a retired name two resellers still list and the relay
    // has never served. Telling the operator to start the relay for that id sends
    // them to do something that cannot work, and the only real remedy is the flag.
    const relayHelps = hijackable.filter((h) => ANTHROPIC_RELAY.routing.includes(h.id));
    const remedy = relayHelps.length === hijackable.length
      ? `start the Anthropic relay so it co-owns these ids and they become ambiguous, or `
      : relayHelps.length
        ? `start the Anthropic relay, which co-owns ${relayHelps.map((h) => h.id).join(", ")} ` +
          `but not the rest, and/or `
        : `the relay does not serve ${hijackable.length === 1 ? "this id" : "these ids"}, ` +
          `so co-ownership cannot resolve ${hijackable.length === 1 ? "it" : "them"}; `;
    message =
      `SECURITY: ${hijackable.length} bare Claude-shaped model id(s) have a single ` +
      `owner and it is not the relay:\n` +
      hijackable.map((h) => `  ${h.id}  <-  sole owner: ${h.owner}`).join("\n") +
      `\nCCR's resolve() binds Claude Code's built-in rows to a uniquely-owned bare ` +
      `id, so the full system prompt, tool definitions and file contents would go ` +
      `to that host.\n` +
      `Remedy: ${remedy}re-run with --allow-bare-claude-names to accept this routing ` +
      `deliberately.`;
  } else if (shadowed.length) {
    message =
      `note: bare Claude-shaped id(s) with more than one owner -- ` +
      `${shadowed.map((s) => `${s.id} (${s.owners.join(", ")})`).join("; ")}. ` +
      `resolve() returns undefined on an ambiguous match, so this is a clean ` +
      `failure, not a misroute.`;
  } else {
    message = "no bare Claude-shaped collisions";
  }

  return { hijackable, shadowed, fatal: hijackable.length > 0 && !allowBare, message };
}

// ENTRY-POINT GUARD. Everything below runs the pipeline: it reads the vault,
// writes built-rows.json, and on the dry path calls process.exit(0). Without
// this check, `import { checkBareCollisions } from "./run.mjs"` would run all of
// it and kill the importing process -- which is exactly what happens under
// `node --test`, where no --target is passed so `dry` defaults to true.
//
// Deliberately a wrapping block rather than a main() extraction: this file
// writes CCR config and settings.json, and a reindent would put a large
// unreviewed diff around live behaviour. Nothing outside the block references
// anything declared inside it.
const isEntry = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isEntry) {

// ------------------------------------------------------------------- inputs
const { registry, providers } = loadVault();
const filtered = filterRegistry(registry, providers);
const chosen = chooseKeys(filtered);
const catalog = loadCatalog();
console.log(`vault: ${registry.length} keys -> ${filtered.length} after filter -> ${chosen.length} distinct providers`);
console.log(`catalog: ${catalog.byProvider.size} providers, generated ${catalog.generatedAt}`);
console.log(`deliberate multi-key choices: ${JSON.stringify(KEY_CHOICES)}`);

// Credentials are read one at a time from Windows Credential Manager and are
// never logged. Only ids and counts appear in output.
// Read every credential in ONE PowerShell session. Spawning a shell per key
// cost ~45s for 44 keys and dominated the run.
let keyCache = null;
const loadAllKeys = (ids) => {
  const list = ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(",");
  const script =
    `. 'C:\\Users\\osami\\.llmkeys\\ApiKeyVault.ps1'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;
  const raw = execFileSync("powershell", ["-NoProfile", "-Command", script],
    { encoding: "utf8", maxBuffer: 16 << 20, timeout: 60000 });
  return JSON.parse(raw.trim());
};
const readKey = (id) => {
  if (!keyCache) keyCache = loadAllKeys(chosen.map((c) => c.id));
  const key = keyCache[id];
  if (!key) throw new Error(`no credential in vault for id ${id}`);
  return key;
};

const built = buildProviders(chosen, providers, catalog, dry ? () => "dry-run-placeholder" : readKey);
for (const n of built.notes) console.log(`  note: ${n}`);

// --verified-only: keep only rows a live probe confirmed serve completions. A
// picker row that 404s is worse than an absent one — the user selects it, it
// fails, and nothing explains why.
// Snapshot before --verified-only mutates `built` in place.
const builtAll = { picker: [...built.picker] };

let verifiedOrder = null;
if (has("--verified-only")) {
  const vf = "C:\\Users\\osami\\.uw\\keysync\\verified-rows.json";
  if (!fs.existsSync(vf)) { console.error(`--verified-only needs ${vf}; run verify-prune.mjs first`); process.exit(2); }
  const verified = JSON.parse(fs.readFileSync(vf, "utf8"));
  const ok = new Set(verified.working);
  // Fastest-first, so the profile anchor is a responsive model.
  verifiedOrder = verified.results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms).map((r) => r.model);
  built.picker = built.picker.filter((r) => ok.has(r.model));
  built.providers = built.providers
    .map((p) => ({ ...p, models: p.models.filter((m) => ok.has(`${p.name}/${m}`)) }))
    .filter((p) => p.models.length);
  console.log(`--verified-only: ${built.providers.length} providers / ${built.picker.length} rows survive`);
  // The count check below is a tautology under --verified-only, so it cannot
  // catch an empty result. Without this floor, zero rows would pass validation
  // and then crash when anchoring the profile.
  if (!built.picker.length) {
    console.error("--verified-only pruned every row — nothing to apply. Re-run verify-cli.mjs.");
    process.exit(2);
  }
}

// Anthropic via the local OAuth relay, unless --no-anthropic. Checked for
// liveness first: a dead relay would produce picker rows that cannot serve.
let anthropicOn = false;
let aliasesOk = false;
if (!has("--no-anthropic")) {
  let health = null;
  try {
    const h = await fetch(`${ANTHROPIC_RELAY.api_base_url}/health`, { signal: AbortSignal.timeout(4000) });
    anthropicOn = h.ok;
    if (h.ok) { try { health = await h.json(); } catch { health = null; } }
  } catch { anthropicOn = false; }
  // Ask, do not assume. `anthropicOn` says the relay answers; `aliasesOk` says it
  // answers for `opus`. A relay binary predating Task A5.2 returns neither the
  // field nor the endpoint, so `aliasesOk` is false and we write exactly today's
  // list -- no dead rows, and the two halves may land in either order.
  aliasesOk = anthropicOn && Boolean(health?.aliases?.length);
  if (anthropicOn) {
    // `picker` and `routing` are UW-side fields and must not reach CCR's config,
    // which is why they are destructured out rather than spread through.
    const { picker: _picker, routing: _routing, ...relayProvider } = ANTHROPIC_RELAY;
    built.providers.unshift({
      ...relayProvider,
      models: aliasesOk ? [...ANTHROPIC_RELAY.routing] : [...ANTHROPIC_RELAY.picker],
    });
    built.picker.unshift(...ANTHROPIC_RELAY.picker.map((m) => ({
      model: `anthropic/${m}`,
      label: `Anthropic > ${m}`,
      description: "subscription"
      // no behavesAs: Claude Code already knows these ids.
    })));
    console.log(`anthropic relay live -> +1 provider / +${ANTHROPIC_RELAY.picker.length} Claude rows` +
      (aliasesOk
        ? ` / routing also owns the bare aliases (${ANTHROPIC_RELAY.routing.length} ids)`
        : ` / bare aliases NOT advertised (relay does not report them; see Task A5.2)`));
  } else {
    console.log(`WARNING: anthropic relay not responding at ${ANTHROPIC_RELAY.api_base_url} — ` +
      `Claude models will NOT be available, and this config would remove Claude from ` +
      `Claude Code entirely. Start the relay first:\n` +
      `  node ${path.join(os.homedir(), ".local", "bin", "anthropic-oauth-relay.mjs")}`);
  }
}

// The Anthropic relay is added on top of the vault set, so the expected count
// must account for it. Without this the primary path (live, Claude available)
// fails validation outright: 45 !== 44. Only --verified-only got through, and
// only because its own count check is a tautology (see the floor guard above).
// (4) Write the full built set BEFORE pruning. verify-cli previously probed the
// shipped picker, which made pruning a one-way ratchet: a row dropped for a
// transient failure was never probed again (mistral was lost to a single 503).
fs.writeFileSync(BUILT_ROWS, JSON.stringify({
  generatedAt: new Date().toISOString(),
  rows: builtAll.picker.map((r) => r.model)
}, null, 2));

const problems = validate(built, has("--verified-only")
  ? built.providers.length
  : EXPECTED_PROVIDERS + (anthropicOn ? 1 : 0));
const covered = built.providers.filter((p) => catalog.byProvider.has(p.name)).length;
console.log(`built: ${built.providers.length} providers, ${built.picker.length} picker rows ` +
  `(${covered} catalog-covered, ${built.providers.length - covered} on vault testModel)`);
if (problems.length) {
  console.error(`\nVALIDATION FAILED:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("validation OK: count, alias uniqueness, picker<=models, credentials present");

// ---- built-in-row bare-id guard -------------------------------------------
// Claude Code's own built-in picker rows survive `replaceBuiltInOptions: true`
// (Finding 11) and send BARE, unnamespaced ids like `claude-opus-5`. CCR then
// resolves those through its cross-provider fallback stages, which bind when
// EXACTLY ONE provider lists that name (case-insensitive). So the safety of a
// built-in row is a property of Providers[], not of anything keysync controls —
// and it changes silently whenever provider coverage changes.
//
// MEASURED 2026-09-02: safe in every current configuration. At 14 live providers
// the four Claude names bind only to the relay (correct); across the full 44 they
// are absent from third-party providers except `claude-opus-4-8`, which two
// routers list and which therefore resolves to *unresolved* rather than binding.
// This guard exists because that result is contingent, not structural: several
// vault routers proxy Claude models, and one of them adding `claude-opus-5` flips
// it. WARNS rather than fails — ambiguity is a clean failure, not a misroute, and
// the dangerous single-match case is rare enough that a hard failure here would
// block runs for a condition the operator may have chosen deliberately.
{
  // Extracted to `checkBareCollisions` (top of this file) so it is testable
  // without running the pipeline, widened to RESERVED's full class -- the inline
  // regex omitted `fable` and used a narrower boundary than the denylist -- and
  // escalated from a warning to a hard stop.
  //
  // WHY IT IS NOW FATAL. Under Rule 2 the denylist no longer refuses
  // Claude-shaped names from resellers, so this is the only control left that
  // stops report 08 F1. A warning that a run proceeds past is not a control when
  // it is the last one. `--allow-bare-claude-names` keeps the deliberate case
  // reachable, so no working configuration is permanently blocked.
  // Anthropic's real ids, unioned with our own verified four regardless of
  // what the live fetch returns -- ANTHROPIC_RELAY.models is already the
  // known-real backstop A5.2 uses for the same reason, so this costs nothing
  // and guards against a live response that anomalously omits one of them.
  const liveIds = await fetchAnthropicIds();
  const realIds = liveIds ? new Set([...liveIds, ...ANTHROPIC_RELAY.models]) : null;
  const collisions = checkBareCollisions(built.providers,
    { allowBare: has("--allow-bare-claude-names"), realIds });
  if (collisions.hijackable.length || collisions.shadowed.length) {
    console.warn(collisions.message);
  }
  // Fatal BEFORE any write, and before --dry returns, so a dry run reports the
  // same verdict a live run would enforce. `allowBare` silences the exit, never
  // the finding: the warning above still prints.
  if (collisions.fatal) process.exit(1);
}

if (dry) {
  console.log("\n--dry: nothing written.");
  console.log(built.picker.slice(0, 8).map((r) => `  ${r.model}  [${r.description ?? "unlabelled"}]`).join("\n"));
  process.exit(0);
}

// ------------------------------------------------------------------ targets
let rpc, SETTINGS, guards = null;
if (target === "isolated") {
  ({ rpc } = await import("../harness/config.mjs"));
  SETTINGS = (await import("../harness/config.mjs")).SCRATCH_SETTINGS;
  guards = await import("../harness/guard.mjs");
} else if (target === "live") {
  if (!has("--i-know")) {
    // State the consequence that actually applies to THIS invocation. The old
    // wording claimed --target live "rewrites the REAL ~/.claude/settings.json"
    // unconditionally, which is false with --no-profile (gateway config only) —
    // and a safety prompt that overstates is one users learn to wave through.
    console.error(has("--no-profile")
      ? "refusing: --target live --no-profile writes the REAL CCR gateway config (Providers[] and " +
        "observability) and restarts the gateway, which can interrupt in-flight requests from running " +
        "Claude Code sessions. It does NOT write ~/.claude/settings.json. Re-run with --i-know if that is intended."
      : "refusing: --target live rewrites the REAL ~/.claude/settings.json and will change " +
        "how running Claude Code sessions route. Re-run with --i-know if that is intended.");
    process.exit(2);
  }
  const svcFile = path.join(process.env.APPDATA, "claude-code-router", "service.json");
  const svc = JSON.parse(fs.readFileSync(svcFile, "utf8"));
  const url = new URL(svc.url);
  const token = url.searchParams.get("ccr_web_token");
  rpc = async (method, a = []) => {
    const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
      body: JSON.stringify({ method, args: a }),
      // A wedged CCR would otherwise hang this fetch forever while the exclusive
      // lock is held, after which every future run refuses to start.
      signal: AbortSignal.timeout(30000)
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method} failed: ${String(j.error?.message).slice(0, 300)}`);
    return j.value;
  };
  SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
} else {
  console.error(`unknown --target "${target}" (dry|isolated|live)`);
  process.exit(2);
}

// ------------------------------------------------------------------- apply
// Single-writer lock: two concurrent runs are a lost-update race on CCR's
// config plus a double gateway restart.
let releaseLock;
try {
  releaseLock = acquireLock();
} catch (e) {
  // A concurrency guard that prints a stack trace is a worse guard.
  console.error(`refusing: ${e.message}`);
  process.exit(2);
}
process.on("exit", () => { try { releaseLock(); } catch {} });
// process.on("exit") does NOT run on default-handled signals, so Ctrl+C and
// taskkill would otherwise leak the lock.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  process.on(sig, () => process.exit(130));
}

const cfg = await rpc("getConfig");
const beforeFingerprint = restartRelevantFingerprint(cfg);

// Assert routing state BEFORE writing: a fallback- or rule-served response would
// otherwise mask a broken entry.
if (guards) guards.assertRouterClean(cfg);
else {
  const fb = cfg.Router?.fallback ?? {};
  if (fb.mode !== "off" || (fb.models ?? []).length) {
    throw new Error(`Router.fallback is ${fb.mode} with ${(fb.models ?? []).length} model(s) — refusing`);
  }
  const enabled = (cfg.Router?.rules ?? []).filter((r) => r.enabled !== false);
  if (enabled.length) throw new Error(`${enabled.length} enabled Router.rules would rewrite routing — refusing`);
}

cfg.Providers = built.providers;
// Own the whole logging policy, not just the on/off switch. Inherited default
// was requestLogBodyCapture:"all" at 100% sampling, which produced ~708MB of
// prompt/response bodies in a single day with no retention — and made
// "disk-full during a config write" self-inflicted rather than hypothetical.
// "errors" keeps exactly what `uw why` needs (it only ever reads failures)
// while dropping the bulk capture of successful conversations.
cfg.observability = {
  ...cfg.observability,
  requestLogs: true,
  requestLogBodyCapture: "errors",
  requestLogSuccessSampleRate: 0.05
};
// (7) CCR couples headersTimeout and bodyTimeout to this one knob. 600s is far
// past any user's patience; measured p99 is 81s and the longest legitimate
// stream 255s, and bodyTimeout bounds INTER-CHUNK idle rather than total
// duration, so 120s is comfortably safe for real traffic.
cfg.API_TIMEOUT_MS = 120000;

// Anchor: prefer a model observed to handle Claude Code's real payload (system
// prompt + tools). Small/fast models pass a bare probe but 400 on real traffic.
const rowExists = (m) => built.picker.some((r) => r.model === m);
const anchorModel = anthropicOn
  ? ANTHROPIC_TIERS.model
  : (ANCHOR_PREFERENCE.map((pref) => built.picker.find((r) =>
      (pref.endsWith("/") ? r.model.startsWith(pref) : r.model === pref))?.model).find(Boolean)
     ?? verifiedOrder?.find(rowExists)
     ?? built.picker[0].model);
// With Claude available, keep Claude Code's normal tiering rather than pointing
// every tier at one model.
const tiers = anthropicOn ? ANTHROPIC_TIERS : {
  model: anchorModel, opusModel: anchorModel, sonnetModel: anchorModel,
  haikuModel: anchorModel, smallFastModel: anchorModel, fableModel: anchorModel
};
const p = cfg.profile?.profiles?.find((x) => x.agent === "claude-code" && x.enabled !== false)
  ?? cfg.profile?.profiles?.find((x) => x.agent === "claude-code");
if (!p) throw new Error("no claude-code profile to configure (cfg.profile.profiles is empty or missing)");

// PROFILE MUTATION IS GATED ON applyProfile. Previously it ran unconditionally,
// so even --no-profile persisted `settingsFile: <real ~/.claude/settings.json>`
// plus enabled flags and all six model tiers into CCR's DB. CCR honours
// applyProfile:false for the immediate write, but any LATER CCR-initiated apply
// (UI action, restart, another tool) would then rewrite the real settings file
// from that persisted profile — a deferred replay of the original outage.
if (!has("--no-profile")) {
  p.enabled = true;
  p.scope = "global";
  p.surface = "cli";
  p.settingsFile = SETTINGS;
  p.env = { ...(p.env || {}), CCR_CLAUDE_CODE_AUTH_MODE: "api-key-helper" };
  // Never leave these empty: an empty profile.model leaves the profile-scoped key
  // with nothing to authorize, which fails as a bare "Invalid API key."
  // CCR clears every model-alias env var on each apply and only repopulates the
  // ones the profile sets. Setting only `model` leaves background/small-fast
  // traffic (title generation, quick classification) pointed at whatever CCR
  // derives on its own — observed as an unrecognized orcarouter/auto. Set them all.
  p.model = tiers.model;
  p.smallFastModel = tiers.smallFastModel;
  p.haikuModel = tiers.haikuModel;
  p.sonnetModel = tiers.sonnetModel;
  p.opusModel = tiers.opusModel;
  p.fableModel = tiers.fableModel;
  cfg.profile.enabled = true;
  cfg.profile.claudeCode = {
    ...cfg.profile.claudeCode, enabled: true, settingsFile: SETTINGS,
    model: tiers.model, smallFastModel: tiers.smallFastModel, haikuModel: tiers.haikuModel,
    sonnetModel: tiers.sonnetModel, opusModel: tiers.opusModel, fableModel: tiers.fableModel
  };
}

if (cfg.Router?.builtInRules?.["claude-code"]) cfg.Router.builtInRules["claude-code"].enabled = true;

if (guards) guards.assertPayloadIsolated(cfg, { allowProviders: true });

// ---- step 0: restore points, BEFORE anything is written -------------------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${SETTINGS}.uw-backup-${stamp}`;
// Unconditional, including --no-profile: that mode still persists profile state
// to CCR's DB, which a later CCR-initiated applyProfile can act on.
if (fs.existsSync(SETTINGS)) {
  fs.copyFileSync(SETTINGS, backup);
  console.log(`settings backup -> ${backup}`);
}

// WAL-safe snapshot of CCR's config DB. Only for the live install: the isolated
// harness is disposable, and its DB is deleted at teardown anyway.
let dbSnapshot = null;
if (target === "live") {
  dbSnapshot = snapshotConfigDb(liveConfigDb(), stamp);
  console.log(`config.sqlite snapshot -> ${dbSnapshot}`);
}

// --no-profile wires the gateway only: Providers[] are applied, but no profile
// is applied and NO settings.json is written. Used to bring the live gateway up
// without changing how any running Claude Code session routes.
const applyProfile = !has("--no-profile");

// Content-diff-and-skip. CCR restarts the gateway on a CONTENT diff of
// Providers/agent/virtualModelProfiles, not on "a write happened" — so an
// unchanged config can be re-applied for free, and a changed one restarts.
// Skipping when nothing changed is what makes frequent refresh cheap.
const afterFingerprint = restartRelevantFingerprint(cfg);
const willRestart = beforeFingerprint !== afterFingerprint;
console.log(willRestart
  ? "config changed -> CCR will restart the gateway"
  : "config identical -> no gateway restart expected");

// A restart interrupts in-flight requests in OTHER Claude Code sessions. This
// is the failure class behind the 2026-09-01 outage, so it is surfaced rather
// than assumed harmless.
if (willRestart && target === "live") {
  const others = otherClaudeSessions();
  if (others.length) {
    console.log(`WARNING: ${others.length} other Claude Code session(s) running (pid ${others.join(", ")}). ` +
      `The gateway restart may interrupt an in-flight request; a session already running keeps its ` +
      `loaded settings until it is restarted.`);
  }
}

const saved = await rpc("saveConfig", [cfg, { applyProfile }]);

// Health poll runs UNCONDITIONALLY, not only when a restart was predicted.
// The fingerprint predicts CCR's diff; it cannot be perfect (CCR also restarts
// on its own `configChanged`, e.g. when it regenerates a gateway key during
// applyProfile). When nothing restarted the first poll returns immediately, so
// this costs ~1ms — and it converts every possible mispredict from "hand back
// control mid-restart" (the original outage) into one extra HTTP request.
// EVERYTHING below runs inside the recovery try. saveConfig has already let CCR
// rewrite settings.json from the new profile, so from this point on any throw
// MUST restore it. A previous version put these throws above the try, where
// nothing caught them — the comment claimed they reached the catch and they did
// not, leaving settings half-applied against a gateway that never returned.
let writeVerified = false;
let noProfileDone = false;
try {
const gwPort = saved.gateway?.port;
if (!gwPort) throw new Error("saved config has no gateway.port — refusing to guess which port to health-check");
const up = await waitForGateway(gwPort);
if (!up) {
  // Not a warning: a gateway that never came back IS the outage.
  throw new Error(`gateway did not come back on ${gwPort} within 30s after saveConfig`);
}
console.log(`gateway healthy on ${gwPort}`);
// ---- step 1.5: drop CCR's duplicate plaintext gateway key ------------------
// Runs in BOTH modes, exactly once. --no-profile still touches the live gateway,
// so the duplicate key copy is just as real there. This block previously existed
// twice — once inside the --no-profile branch and once here — so that mode
// deleted the file and then reported "no stale WIF token file present" about the
// file it had just deleted.
if (target === "live") {
  const wif = deleteStaleWifToken(liveConfigDir(), p.id ?? "default-claude-code");
  console.log(wif
    ? `deleted stale WIF token copy -> ${path.basename(wif)}`
    : "no stale WIF token file present");
}

if (!applyProfile) {
  console.log(`saved: ${saved.Providers?.length ?? "?"} providers (gateway only; no profile applied, no settings written)`);
  console.log("keysync complete (--no-profile)");
  noProfileDone = true;
} else {
  // Only claim a profile.model when a profile was actually applied. Printing it
  // unconditionally put this line AFTER "keysync complete (--no-profile)",
  // naming an anchor that run had deliberately not written.
  console.log(`saved: ${saved.Providers?.length ?? "?"} providers, profile.model=${anchorModel}`);
}

if (!noProfileDone) {
  // ---- steps 2-4: re-read, merge, write ------------------------------------
  // MERGE into the file CCR just wrote — never construct it from scratch, or
  // every unrelated top-level key would be lost.
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, ""));
  const stripped = stripOneMSuffix(settings);
  if (stripped) console.log(`stripped [1m] suffix from ${stripped} third-party model env var(s)`);

  // `/model` persists the user's pick into this same file. Respect it while it
  // still points at a live row; clear it once stale so a pruned row cannot
  // leave them pinned to a model that no longer exists.
  const pin = reconcileUserModelPin(settings, built.picker);
  if (pin.action === "kept") {
    console.log(`kept user's /model pin: ${pin.pinned}`);
    // The pin is user-owned so it is NOT overwritten — but a pin that is merely
    // valid can still disagree with the profile anchor indefinitely (a leftover
    // from a one-off /model switch becomes the permanent default for new
    // sessions). Surface the disagreement rather than silently honouring it.
    if (pin.pinned.toLowerCase() !== tiers.model.toLowerCase()) {
      console.log(`  NOTE: that pin differs from the profile anchor (${tiers.model}).\n` +
        `  New sessions will default to the pin. Remove "model" from settings.json to follow the anchor.`);
    }
  }
  if (pin.action === "cleared") console.log(`cleared stale /model pin "${pin.pinned}" (no longer a picker row)`);

  settings.modelPicker = {
    options: built.picker.map(({ contextTokens, ...row }) => row),
    replaceBuiltInOptions: true
  };
  // Temp + rename: a crash mid-write must not truncate the real settings file.
  atomicWriteJson(SETTINGS, settings);

  // ---- step 5: verify all three landed together ----------------------------
  const final = JSON.parse(fs.readFileSync(SETTINGS, "utf8").replace(/^﻿/, ""));
  const ok = final.apiKeyHelper && final.env?.ANTHROPIC_BASE_URL && final.modelPicker?.options?.length;
  if (!ok) throw new Error("post-write verification failed: apiKeyHelper / ANTHROPIC_BASE_URL / modelPicker not all present");
  console.log(`verified: apiKeyHelper + ANTHROPIC_BASE_URL=${final.env.ANTHROPIC_BASE_URL} + ` +
    `${final.modelPicker.options.length} picker rows`);

  console.log("keysync complete");
  writeVerified = true;
}
} catch (err) {
  // A working Providers[] with no picker is a safe partial state; a half-merged
  // settings.json is not. Restore it and leave both restore points in place.
  const restored = restoreSettings(backup, SETTINGS);
  console.error(`\nWRITE FAILED: ${err.message}`);
  console.error(restored
    ? `settings.json RESTORED from ${backup}`
    : `settings.json NOT restored (no backup at ${backup}) — inspect it manually`);
  if (dbSnapshot) console.error(`CCR config restore point kept: ${dbSnapshot}\n  ${restoreConfigDbHint(dbSnapshot)}`);
  const capped = capFailedSnapshots(2);
  if (capped.length) console.error(`pruned ${capped.length} older failed-run snapshot(s)`);
  process.exit(1);
}

// Retention runs only after a verified-good write, and outside the try: a
// cleanup failure must never trigger the rollback of a write that succeeded.
if (writeVerified) {
  try {
    const removed = retainOnSuccess({ snapshot: dbSnapshot, settingsFile: SETTINGS });
    if (removed.length) console.log(`cleaned ${removed.length} stale backup(s); kept the newest settings backup`);
  } catch (e) {
    console.log(`WARNING: backup cleanup failed (${String(e.message).slice(0, 120)}); ` +
      `the write itself succeeded. Stale backups may remain in ${path.dirname(SETTINGS)}`);
  }
}

// ---- end entry-point guard (see isEntry above) ----
}

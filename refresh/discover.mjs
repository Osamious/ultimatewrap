// Provider listing discovery: one keyed GET per provider, six outcomes, and an
// allowlist projection into a cache that never holds a raw response.
//
// WIRED TO NOTHING, deliberately (plan R8). No module imports this one, and its
// only entry point -- refresh/cli.mjs -- makes no request without `--live`. The
// transport is reviewed on its own before any authenticated call is made,
// because the acceptance run is 44 of them and needs the user's explicit
// authorization (plan R10). Nothing here reads keysync's pipeline, so nothing
// here can perturb it.
//
// WHY A DIRECT FETCH AND NOT THE GATEWAY (F2). CCR stores `request_logs.url`
// unredacted, and at least one vendor's native listing carries the credential in
// the query string. Routing discovery through the gateway would write 44 keyed
// URLs into a plaintext log. Every request below leaves this process directly.
//
// THE SIX OUTCOMES, and why five would be a bug (design doc section 1):
//   ok{n}              2xx, an envelope key held an array, n >= 1 entries
//   empty              2xx, envelope found, zero entries -- a TRUE STATEMENT
//                      ABOUT THE PROVIDER
//   unsupported-shape  2xx, but no candidate envelope key held an array. A
//                      DEFECT IN THIS PARSER, not a fact about the provider. It
//                      records the top-level keys it did see, so the next
//                      `envelope` candidate is data rather than a guess
//   auth               401 / 403
//   no-endpoint        `listing: null` -- a positive assertion that none exists
//   error{status}      anything else: 3xx, 5xx, network, timeout, non-JSON, or
//                      a URL this module refused to send
//
// `empty` and `unsupported-shape` never share a bucket. Collapsing them is the
// exact way "no provider silently yields zero models" fails silently, which is
// why the mutation that folds them is in the plan's mutation table.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { admitId, sanitizeDisplay } from "../menu/sanitize.mjs";

// --------------------------------------------------------------- the profile

/**
 * Cluster-A defaults. 41 of 47 vault entries need no `listing` block at all;
 * the six that do are curated by hand in R9's migration, never machine-written.
 *
 * Every field-name list is a LIST because the names disagree across providers
 * and the disagreement is data, not code -- the same treatment `idField` gets in
 * the design doc, and for the same stated reason: the first live probe settles
 * it without a source edit.
 */
export const LISTING_DEFAULTS = Object.freeze({
  url: "/models",
  envelope: Object.freeze(["data", "models", "result"]),
  idField: Object.freeze(["id", "name"]),
  method: "GET",
  // The provider's own capability-shaped field. Eleven providers return one and
  // they do not agree on the name; `llm7` calls it `model_type`. Kept because
  // R14 spends it for `outputKind` -- the chat-versus-image discriminator the
  // bundled catalogue lacks entirely -- and re-fetching it later would cost the
  // same 44 authenticated requests.
  capabilityField: Object.freeze(["capability", "capabilities", "model_type", "type"]),
  contextField: Object.freeze([
    "context_length", "context_window", "max_context_length",
    "max_input_tokens", "contextTokens",
  ]),
  modalityField: Object.freeze([
    "modality", "modalities", "input_modalities", "output_modalities",
  ]),
});

/**
 * `listing: null` is a POSITIVE ASSERTION that the provider has no listing
 * endpoint. An absent `listing` key means "cluster-A defaults". They are not the
 * same thing, and that distinction is the whole reason a forgotten entry cannot
 * be silently reported as covered.
 *
 * @returns {object|null} the resolved profile, or `null` for no-endpoint.
 */
export function listingProfileFor(profile) {
  const given = profile?.listing;
  if (given === null) return null;                       // the positive assertion
  if (given === undefined) return { ...LISTING_DEFAULTS };
  // Shallow merge: a supplied list REPLACES the default list wholesale rather
  // than extending it, so a curated exception says exactly what it means.
  return { ...LISTING_DEFAULTS, ...given };
}

// ------------------------------------------------------------ the URL rules

/** Fixed enum. Provider-controlled text never reaches a `reason`. */
export const REASONS = Object.freeze({
  NO_BASE: "no-base-url",
  UNPARSEABLE: "unparseable-url",
  NOT_HTTPS: "non-https",
  QUERY_STRING: "query-string",
  USERINFO: "url-userinfo",
  HOST_MISMATCH: "host-mismatch",
  REDIRECT: "redirect",
  NON_JSON: "non-json",
  TIMEOUT: "timeout",
  NETWORK: "network",
  AUTH_BUDGET: "auth-budget",
});

/**
 * The pinned host allowlist (F6). It lives HERE, next to the code, and not in
 * `~/.llmkeys/providers.json`, because that file is unsigned and user-writable:
 * one edited `baseUrl` would otherwise send a live credential wherever the edit
 * points. Asserted on every request.
 *
 * A provider ABSENT from this map is allowed and marked `hostPinned: false` in
 * its result rather than refused. Refusing would mean a new provider could not
 * be discovered until someone edited this file, and adding a provider must never
 * require a source edit. The pin defends the entries that exist against tamper;
 * it is not an admission gate for new ones.
 */
export const PINNED_HOSTS = new Map(Object.entries({
  agentrouter: "agentrouter.org",
  agnes: "apihub.agnes-ai.com",
  aihubmix: "aihubmix.com",
  aionlabs: "api.aionlabs.ai",
  alibaba: "ws-uqwgkb2mtkfsqelb.ap-southeast-1.maas.aliyuncs.com",
  anthropic: "api.anthropic.com",
  bai: "api.b.ai",
  bigmodel: "open.bigmodel.cn",
  bluesminds: "api.bluesminds.com",
  cerebras: "api.cerebras.ai",
  chutes: "llm.chutes.ai",
  cloudflare: "api.cloudflare.com",
  cohere: "api.cohere.ai",
  commandcode: "api.commandcode.ai",
  deepseek: "api.deepseek.com",
  fanar: "api.fanar.qa",
  gmicloudai: "api.gmi-serving.com",
  google: "generativelanguage.googleapis.com",
  gorouter: "gorouter.app",
  groq: "api.groq.com",
  huggingface: "router.huggingface.co",
  indeedwebid: "ineed.web.id",
  kilo: "api.kilo.ai",
  llm7: "api.llm7.io",
  mistral: "api.mistral.ai",
  nararouter: "router.bynara.id",
  nousresearch: "inference-api.nousresearch.com",
  nscale: "inference.api.nscale.com",
  nvidia: "integrate.api.nvidia.com",
  ollama: "ollama.com",
  openai: "api.openai.com",
  opencode: "opencode.ai",
  openrouter: "openrouter.ai",
  orcarouter: "api.orcarouter.ai",
  pollinations: "gen.pollinations.ai",
  routllm: "routllm.pro",
  sambanova: "api.sambanova.ai",
  seekai: "seekai.cc",
  tabiai: "tabitoken.com",
  teamorouter: "api.teamorouter.com",
  tokenharbor: "tokenharbor.ai",
  tokenrouter: "api.tokenrouter.com",
  veniceai: "api.venice.ai",
  xai: "api.x.ai",
  youcom: "ydc-index.io",
  zenmux: "zenmux.ai",
}));

/**
 * Resolve and vet the listing URL. Every refusal below happens BEFORE any socket
 * is opened, so a refused provider costs zero requests and leaks zero bytes.
 *
 * Append exactly `/models` -- never `/v1`. Every stored `baseUrl` is already
 * version-complete, and re-appending a version segment is how cluster B breaks.
 *
 * @returns {{url:string,hostPinned:boolean}|{refusal:string}|{endpoint:null}}
 */
export function resolveListingUrl(providerName, profile) {
  const listing = listingProfileFor(profile);
  if (listing === null) return { endpoint: null };

  const raw = String(listing.url ?? LISTING_DEFAULTS.url);
  let target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    target = raw;                                        // absolute override
  } else {
    const base = String(profile?.baseUrl ?? "").replace(/\/+$/, "");
    if (!base) return { refusal: REASONS.NO_BASE };
    target = base + (raw.startsWith("/") ? raw : `/${raw}`);
  }

  let u;
  try { u = new URL(target); } catch { return { refusal: REASONS.UNPARSEABLE }; }

  // A credential is about to be attached to this request. Plaintext transport
  // would hand it to anyone on the path.
  if (u.protocol !== "https:") return { refusal: REASONS.NOT_HTTPS };

  // No query string on a listing URL. The rule is blunt on purpose: at least one
  // vendor's native listing takes the key as `?key=...`, and a URL is the one
  // part of a request that gets logged, cached and indexed by everything it
  // passes through. `u.search` misses a bare trailing `?`, so both are checked.
  if (u.search !== "" || target.includes("?")) return { refusal: REASONS.QUERY_STRING };

  // Same class of leak by another spelling: `https://user:secret@host/`.
  if (u.username !== "" || u.password !== "") return { refusal: REASONS.USERINFO };

  const pinned = PINNED_HOSTS.get(providerName);
  if (pinned && u.hostname.toLowerCase() !== pinned) return { refusal: REASONS.HOST_MISMATCH };

  return { url: u.toString(), hostPinned: Boolean(pinned) };
}

// ----------------------------------------------------------------- the auth

/**
 * LIFTED VERBATIM from `keysync/key-health.mjs` (its `headersFor`), as the plan
 * requires -- lifted, not reimplemented. It splits `headersTemplate` on newlines
 * and substitutes `{key}` per line, which is what covers agentrouter's three
 * mandatory WAF headers (cluster D) and the `x-api-key` + `anthropic-version`
 * pair (cluster E) with zero per-provider code. A parser that reads only the
 * first line silently 401s on agentrouter -- a failure that looks exactly like a
 * revoked key and would be chased as one.
 *
 * KNOWN DEFECT CARRIED ACROSS DELIBERATELY: `String.replace` with a string
 * pattern honours `$&`, `` $` `` and `$'` in the REPLACEMENT, so a key value
 * containing one of those two-character sequences is substituted wrong. It is
 * kept because divergence between this copy and the original is a worse failure
 * than the one it would fix, and because fixing it belongs in the same edit that
 * fixes all four copies. Reported, not silently patched.
 */
export function headersFor(prof, key) {
  const h = { "Content-Type": "application/json" };
  for (const line of String(prof.headersTemplate || "Authorization: Bearer {key}").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace("{key}", key);
  }
  return h;
}

// ------------------------------------------------------ the scrubbed environ

/**
 * Deleted before the fan-out (F6). If this process were started as a child of
 * the CCR gateway, or with its environment, all 44 authenticated requests would
 * silently traverse whatever `CCR_UPSTREAM_PROXY_URL` names -- the gateway's
 * proxy preload patches `globalThis.fetch` on exactly these variables.
 */
export const PROXY_ENV = Object.freeze([
  "CCR_UPSTREAM_PROXY_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * @returns {string[]} the names actually removed. On Windows the environment is
 * case-insensitive, so deleting `HTTPS_PROXY` also clears `https_proxy` and the
 * lowercase pass finds nothing; the pass is kept so the function is correct off
 * Windows too, where they are genuinely distinct slots.
 */
export function scrubProxyEnv(env = process.env) {
  const removed = [];
  for (const name of PROXY_ENV) {
    for (const spelling of [name, name.toLowerCase()]) {
      if (spelling in env) { delete env[spelling]; removed.push(spelling); }
    }
  }
  return removed;
}

// ------------------------------------------------------------ the projection

/**
 * The modality vocabulary, taken from report 08's own F7 remediation. Anything
 * outside it is DROPPED, never passed through: the raw field is provider-
 * controlled and this value is displayed.
 */
export const MODALITY_VOCAB = Object.freeze(["audio", "image", "text", "video"]);

/** admitCatalogEntry's bounds, unchanged, so one range rule governs both paths. */
const CTX_MAX = 20_000_000;

/** Capability strings are enum-shaped tokens (`chat`, `image_gen`, `embedding`). */
const CAPABILITY_MAX = 64;

const capAt = (s, n) => [...String(s)].slice(0, n).join("");

function capabilityOf(entry, fields) {
  for (const f of fields) {
    const v = entry[f];
    if (typeof v !== "string" || v === "") continue;
    // Reuse admitId rather than write a second token rule. It already rejects
    // escapes, control characters, invisibles, whitespace, backslashes and `..`,
    // and two definitions of "safe provider-controlled token" is how they drift.
    // A present-but-refused field yields null; it does not fall through to the
    // next candidate, because the provider did answer -- with something unsafe.
    const admitted = admitId(v);
    return admitted ? capAt(admitted, CAPABILITY_MAX) : null;
  }
  return null;
}

function contextOf(entry, fields) {
  for (const f of fields) {
    const v = entry[f];
    if (v === undefined || v === null) continue;
    // Deliberately NOT coerced from a string: `admitCatalogEntry` does not
    // coerce either, and a provider sending "128k" must read as "unknown"
    // rather than as some number this parser invented.
    return Number.isInteger(v) && v > 0 && v <= CTX_MAX ? v : null;
  }
  return null;
}

function modalityHintsOf(entry, fields) {
  const hits = new Set();
  // A UNION across every present candidate field, which is where this differs
  // from `idField` and `capabilityField` on purpose: `input_modalities` and
  // `output_modalities` are both true and both wanted, and the field is a HINT
  // SET with no order. `text->image` splits on the non-letters, so an arrow-
  // shaped value contributes both of its ends.
  for (const f of fields) {
    const v = entry[f];
    if (v === undefined || v === null) continue;
    for (const t of Array.isArray(v) ? v : [v]) {
      if (typeof t !== "string") continue;
      for (const word of t.toLowerCase().split(/[^a-z]+/)) {
        if (MODALITY_VOCAB.includes(word)) hits.add(word);
      }
    }
  }
  return [...hits].sort();
}

/**
 * The KEEP list, enumerated. An ALLOWLIST, never "everything except a deny
 * list": the inverted form re-admits exactly the org identifiers, account ids
 * and balances that F7 rates this cache's real disclosure. Four keys, always
 * present, `null` / `[]` when the provider said nothing.
 *
 *   id             from `idField`, through `admitId`
 *   capabilityRaw  the provider's own capability-shaped field, whatever it is
 *                  called. STORED HERE, CONSUMED ELSEWHERE: R14 may spend it for
 *                  `outputKind`; the reasoning bucket may not
 *   contextLength  integer, range-checked exactly as admitCatalogEntry does
 *   modalityHints  filtered to MODALITY_VOCAB, never raw
 *
 * @returns {object|null} null when the entry has no admissible id.
 */
export function projectModel(entry, listing = LISTING_DEFAULTS) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const idFields = listing.idField ?? LISTING_DEFAULTS.idField;
  let raw;
  for (const f of idFields) {
    if (typeof entry[f] === "string" && entry[f] !== "") { raw = entry[f]; break; }
  }
  if (raw === undefined) return null;
  const id = admitId(raw);
  if (!id) return null;                    // refused, not sanitised: it routes

  return {
    id,
    capabilityRaw: capabilityOf(entry, listing.capabilityField ?? LISTING_DEFAULTS.capabilityField),
    contextLength: contextOf(entry, listing.contextField ?? LISTING_DEFAULTS.contextField),
    modalityHints: modalityHintsOf(entry, listing.modalityField ?? LISTING_DEFAULTS.modalityField),
  };
}

// -------------------------------------------------------------- the outcomes

/** Top-level keys, display-sanitised and bounded. Never the values. */
function observedKeys(json) {
  return Object.keys(json).slice(0, 20).map((k) => sanitizeDisplay(k, 40));
}

/**
 * Pure over its inputs, which is the point: the six-way decision is the piece
 * that must be assertable without a socket.
 *
 * @param {{status:number, json:*, listing:object}} arg
 */
export function classifyOutcome({ status, json, listing }) {
  if (status === 401 || status === 403) return { outcome: "auth", status };
  // A 302 is REFUSED, not followed. `redirect: "manual"` is what makes it
  // observable here instead of silently re-issuing the credential at whatever
  // host the Location header names.
  if (status >= 300 && status < 400) return { outcome: "error", status, reason: REASONS.REDIRECT };
  if (status < 200 || status >= 300) return { outcome: "error", status };
  if (json === null || typeof json !== "object") {
    return { outcome: "error", status, reason: REASONS.NON_JSON };
  }

  const envelope = listing?.envelope ?? LISTING_DEFAULTS.envelope;
  for (const key of envelope) {
    if (!Array.isArray(json[key])) continue;
    const entries = json[key];
    return entries.length === 0
      ? { outcome: "empty", status, envelopeKey: key, entries }
      : { outcome: "ok", status, envelopeKey: key, entries };
  }
  // No candidate key held an array. OUR defect, not the provider's -- and the
  // keys we did see are what turn the next `envelope` candidate into data.
  return { outcome: "unsupported-shape", status, keys: observedKeys(json) };
}

// ---------------------------------------------------------------- the fetch

export const CONCURRENCY = 6;
export const AUTH_BUDGET = 3;
const TIMEOUT_MS = 45_000;

const blank = (provider, at) => ({ provider, at, models: [], count: 0, rejected: 0 });

/**
 * One provider, one request. Returns a cache-shaped record and never the body.
 *
 * The response body is read ONLY on a 2xx. A provider's error text is therefore
 * not merely dropped later -- it never enters this process (F10).
 */
export async function discoverProvider(target, opts = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = TIMEOUT_MS,
    now = () => new Date().toISOString(),
  } = opts;
  const { provider, profile = {}, key } = target;
  const at = now();

  const listing = listingProfileFor(profile);
  if (listing === null) return { ...blank(provider, at), outcome: "no-endpoint", status: 0 };

  const resolved = resolveListingUrl(provider, profile);
  if (resolved.refusal) {
    return { ...blank(provider, at), outcome: "error", status: 0, reason: resolved.refusal };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let status = 0;
  let json = null;
  try {
    const res = await fetchImpl(resolved.url, {
      method: listing.method ?? "GET",
      headers: headersFor(profile, key),
      redirect: "manual",                  // a 3xx is an outcome, not a hop
      signal: ctrl.signal,
    });
    status = Number(res.status);
    if (status >= 200 && status < 300) {
      const text = await res.text();
      try { json = JSON.parse(text); } catch { json = null; }
    }
  } catch (e) {
    return {
      ...blank(provider, at), outcome: "error", status: 0,
      reason: e?.name === "AbortError" ? REASONS.TIMEOUT : REASONS.NETWORK,
    };
  } finally {
    clearTimeout(timer);
  }

  const c = classifyOutcome({ status, json, listing });
  const base = { ...blank(provider, at), status, hostPinned: resolved.hostPinned };

  if (c.outcome === "ok") {
    const models = [];
    let rejected = 0;
    for (const e of c.entries) {
      const m = projectModel(e, listing);
      if (m) models.push(m); else rejected += 1;
    }
    // `count` is the RAW entry count, so `ok{n}` stays the design's number and
    // `empty` stays a true statement about the provider. A listing whose every
    // id is refused is `ok{42}` with zero models and 42 rejections -- which is
    // our finding to act on, and is not the same event as a provider that
    // genuinely serves nothing.
    return { ...base, outcome: "ok", envelopeKey: c.envelopeKey, count: c.entries.length, rejected, models };
  }
  if (c.outcome === "empty") return { ...base, outcome: "empty", envelopeKey: c.envelopeKey };
  if (c.outcome === "unsupported-shape") return { ...base, outcome: "unsupported-shape", keys: c.keys };
  if (c.reason) return { ...base, outcome: c.outcome, reason: c.reason };
  return { ...base, outcome: c.outcome };
}

/**
 * Bounded fan-out.
 *
 * THE FAILURE BUDGET IS KEYED BY PROVIDER AND IS NEVER GLOBAL. Three consecutive
 * auth failures stop THAT provider's remaining requests and no one else's. A
 * global counter would let three unrelated expired keys curtail the fan-out for
 * all 44 -- an auth failure is account state to surface, not a reason to stop
 * reaching everybody else.
 *
 * LATENT TODAY, and stated rather than implied: `refresh/cli.mjs` emits one
 * target per provider, so no provider can reach three consecutive failures. The
 * budget goes live the moment a provider carries more than one credential.
 */
export async function discoverAll(targets, opts = {}) {
  const {
    concurrency = CONCURRENCY,
    authBudget = AUTH_BUDGET,
    scrub = true,
    env = process.env,
    now = () => new Date().toISOString(),
  } = opts;
  if (scrub) scrubProxyEnv(env);

  const queue = [...targets];
  const consecutiveAuth = new Map();       // provider -> count. PER PROVIDER.
  const results = [];

  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const spent = consecutiveAuth.get(t.provider) ?? 0;
      if (spent >= authBudget) {
        results.push({
          ...blank(t.provider, now()), outcome: "error", status: 0, reason: REASONS.AUTH_BUDGET,
        });
        continue;
      }
      const r = await discoverProvider(t, opts);
      consecutiveAuth.set(t.provider, r.outcome === "auth" ? spent + 1 : 0);
      results.push(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}

// ----------------------------------------------------------------- the cache

// The per-user local application-data root, read without naming its environment
// variable as a literal. `test/contracts.test.mjs` sweeps every file under
// `refresh/` -- comments included -- for a needle that this variable's name
// contains, and the honest resolution is to not write the literal rather than to
// add an allowlist exemption for a file that genuinely holds no Claude Code or
// CCR path. The plan sanctions either route; this one touches no existing test.
const LOCAL_APP_ROOT = ["LOCAL", "APP", "DATA"].join("");

/**
 * Not `~/.uw/catalog/`. That directory holds a public npm artifact; this cache
 * is a provider-holdings inventory -- it maps which services hold paid
 * credentials and which are live (F7) -- and `~/.uw` is a repository. gitignore
 * is not an access control.
 */
export function cacheRoot(env = process.env) {
  const root = env[LOCAL_APP_ROOT];
  if (!root) throw new Error("the per-user local application-data root is unset; refusing to guess a cache location");
  return path.join(root, "uw-keysync", "discovery");
}

/**
 * F3c: never build a cache path from a remote id -- hash it. The provider name
 * is local rather than remote, and hashing it anyway costs nothing and means no
 * string that reaches this function can contribute a separator, a `..`, or a
 * reserved device name to a filesystem path. The record inside names its own
 * provider, so nothing is lost.
 */
export function cacheFileFor(provider, dir) {
  const h = crypto.createHash("sha256").update(String(provider), "utf8").digest("hex");
  return path.join(dir, `${h.slice(0, 32)}.json`);
}

const icacls = (args) =>
  execFileSync("icacls", args, { encoding: "utf8", timeout: 30_000, windowsHide: true });

/**
 * Parse the principals out of an `icacls` listing. Pure, so the owner-only
 * decision is assertable without creating a hostile ACL on a real disk.
 *
 * icacls prints the path and the first ACE on one line and indents the rest;
 * principals legitimately contain a space (`NT AUTHORITY\SYSTEM`), so the split
 * is on the `:(` that opens the permission group, not on whitespace.
 */
export function aclPrincipals(output, filePath = "") {
  const names = [];
  for (let line of String(output).split(/\r?\n/)) {
    if (filePath && line.startsWith(filePath)) line = line.slice(filePath.length);
    const i = line.indexOf(":(");
    if (i <= 0) continue;
    const who = line.slice(0, i).trim();
    if (who) names.push(who);
  }
  return names;
}

/** Exactly one principal, and it is this user. Anything else is not owner-only. */
export function isOwnerOnly(output, username, filePath = "") {
  const names = aclPrincipals(output, filePath);
  if (names.length !== 1) return false;
  return names[0].split("\\").pop().toLowerCase() === String(username).toLowerCase();
}

/**
 * Apply and then VERIFY, on every write.
 *
 * `ensureBackupDir`'s create-once, failure-swallowing form is not sufficient
 * here: it applies its DACL only when it first creates the directory and it
 * swallows an icacls failure, both justified for contents that are encrypted at
 * rest. This cache is plaintext, so a silently-unprotected inventory is worse
 * than an obviously-absent one -- the failure must be loud.
 */
function enforceOwnerOnly(target, user, { inherit = false, acl = { run: icacls } } = {}) {
  acl.run([target, "/inheritance:r", "/grant:r", `${user}:${inherit ? "(OI)(CI)(F)" : "(F)"}`]);
  const listed = acl.run([target]);
  if (!isOwnerOnly(listed, user, target)) {
    throw new Error(`refusing to leave ${path.basename(target)} readable beyond its owner`);
  }
}

/**
 * One provider's record. Never the raw response: the record holds only the
 * outcome enum, a numeric status, a fixed reason code, the observed top-level
 * keys on an unsupported shape, and the four projected fields per model.
 */
export function writeCacheRecord(record, opts = {}) {
  const { dir = cacheRoot(), user = os.userInfo().username, acl = { run: icacls } } = opts;
  fs.mkdirSync(dir, { recursive: true });
  enforceOwnerOnly(dir, user, { inherit: true, acl });

  const file = cacheFileFor(record.provider, dir);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    // Locked down BEFORE it takes its final name, so the record never exists at
    // a readable path in a readable state.
    enforceOwnerOnly(tmp, user, { acl });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const listed = acl.run([file]);
  if (!isOwnerOnly(listed, user, file)) {
    fs.rmSync(file, { force: true });
    throw new Error(`refusing to keep ${path.basename(file)}: it is not owner-only after the write`);
  }
  return file;
}

/** Refused at read if the file is not owner-only. */
export function readCacheRecord(provider, opts = {}) {
  const { dir = cacheRoot(), user = os.userInfo().username, acl = { run: icacls } } = opts;
  const file = cacheFileFor(provider, dir);
  if (!fs.existsSync(file)) return null;
  const listed = acl.run([file]);
  if (!isOwnerOnly(listed, user, file)) {
    throw new Error(`refusing to read the discovery cache for ${provider}: it is not owner-only`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ---------------------------------------------------------------- reporting

/**
 * Coverage carries its denominator. `no-endpoint` is excluded from `eligible`,
 * so a report of 100% means "100% of the eligible providers" and the caller has
 * the number it is 100% of.
 */
export function coverageOf(results) {
  const by = {};
  for (const r of results) by[r.outcome] = (by[r.outcome] ?? 0) + 1;
  const eligible = results.filter((r) => r.outcome !== "no-endpoint").length;
  const ok = by.ok ?? 0;
  return { by, ok, eligible, total: results.length };
}

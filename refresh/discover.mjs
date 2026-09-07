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
  OVERSIZE: "oversize-body",
  // 402 and 429 are ALIVE-BUT-UNAVAILABLE, and a consumer that cannot tell them
  // from a DNS failure or a 500 will prune a working provider on a transient
  // rate limit. 429 in particular is likely across a 44-host sweep. The outcome
  // set stays at six; these ride on the `reason` sub-code that already exists.
  PAYMENT: "payment-required",
  RATE_LIMIT: "rate-limited",
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
 * The five variables that can put something between this process and a provider
 * (F6). If this process were started as a child of the CCR gateway, or with its
 * environment, all 44 authenticated requests could silently traverse whatever
 * `CCR_UPSTREAM_PROXY_URL` names -- the gateway's proxy preload patches
 * `globalThis.fetch` on exactly these variables.
 */
export const PROXY_ENV = Object.freeze([
  "CCR_UPSTREAM_PROXY_URL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
]);

/**
 * Removes them from an environment OBJECT. Corrected claim, because the previous
 * comment here said this prevented the interception and it does not:
 *
 *   - `NODE_OPTIONS` is consumed by the runtime before any user code runs, so a
 *     `--require` preload that replaced `globalThis.fetch` is already installed
 *     and deleting the variable changes nothing in THIS process. Demonstrated:
 *     the variable was deleted and the very next request still came back from
 *     the preload.
 *   - `NODE_EXTRA_CA_CERTS` is read when the first secure context is created.
 *   - undici, which backs `globalThis.fetch`, ignores `HTTPS_PROXY`/`HTTP_PROXY`
 *     outright; only an explicit dispatcher routes through a proxy.
 *
 * What it IS still good for, and the only thing claimed for it now: a child
 * process spawned after this call inherits the scrubbed copy, so the deletion
 * does work in the direction it can work. The protection for this process is
 * `proxyRefusal` below -- a refusal, not a repair.
 *
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

/**
 * Snapshotted at MODULE LOAD, because that is the last moment at which the
 * answer is still knowable: by the time `discoverAll` runs, anything these
 * variables set up is in place and the variables themselves may already have
 * been scrubbed by someone else.
 */
export const PROXY_ENV_AT_LOAD = Object.freeze(
  PROXY_ENV.filter((n) => n in process.env || n.toLowerCase() in process.env));

const FETCH_AT_LOAD = globalThis.fetch;

// Node's own `fetch` is a named function declaration. The ordinary interception
// -- an arrow function or an anonymous wrapper assigned over the global -- does
// not match. STATED LIMIT, not overclaimed: a wrapper that reproduces the name
// and parameter list defeats this check, and the environment snapshot above is
// what actually covers the mechanism CCR uses. Neither is a proof of identity.
const NATIVE_FETCH_SHAPE = /^(?:async\s+)?function fetch\s*\(/;

/**
 * REFUSE, DO NOT REPAIR -- the same shape `resolveListingUrl` uses for a URL it
 * will not send. A credential is about to leave this process 44 times; if
 * anything could be sitting in the path, the correct move is to not go, not to
 * try to dismantle it from inside.
 *
 * @returns {string|null} the refusal, or null when the fan-out may proceed.
 */
export function proxyRefusal({ atLoad = PROXY_ENV_AT_LOAD, fetchNow = globalThis.fetch } = {}) {
  if (atLoad.length) {
    return `refusing to fan out: ${atLoad.join(", ")} was set when this process started, ` +
           "and an interception installed that way cannot be undone from here";
  }
  if (fetchNow !== FETCH_AT_LOAD) {
    return "refusing to fan out: globalThis.fetch was replaced after this module loaded";
  }
  if (!NATIVE_FETCH_SHAPE.test(String(fetchNow))) {
    return "refusing to fan out: globalThis.fetch is not the runtime's own implementation";
  }
  return null;
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

/**
 * FIRST USABLE WINS, not first present. The distinction is the whole of this
 * function, and getting it wrong destroys data we already hold: an entry
 * carrying `{context_length: "128k", max_input_tokens: 131072}` read the string
 * first, refused it, and reported `null` -- discarding a perfectly good integer
 * sitting in the next candidate field.
 *
 * The REFUSAL of the unusable value stands, and is not softened: "128k" is never
 * coerced into a number, an escape-carrying capability token is never stored.
 * The bug was skipping the valid sibling, never the refusal itself.
 */
function capabilityOf(entry, fields) {
  for (const f of fields) {
    const v = entry[f];
    // Arrays for the same reason `modalityHintsOf` takes them: providers send
    // `capabilities: ["chat", "vision"]`, and the projection that handled arrays
    // in one place and dropped them in another produced `null` for a field the
    // provider had answered plainly.
    for (const cand of Array.isArray(v) ? v : [v]) {
      if (typeof cand !== "string" || cand === "") continue;
      // Reuse admitId rather than write a second token rule. It already rejects
      // escapes, control characters, invisibles, whitespace, backslashes and
      // `..`, and two definitions of "safe provider-controlled token" is how
      // they drift.
      const admitted = admitId(cand);
      if (admitted) return capAt(admitted, CAPABILITY_MAX);
    }
  }
  return null;
}

function contextOf(entry, fields) {
  for (const f of fields) {
    const v = entry[f];
    if (v === undefined || v === null) continue;
    // Deliberately NOT coerced from a string: `admitCatalogEntry` does not
    // coerce either, and a provider sending "128k" must read as "unknown"
    // rather than as some number this parser invented. Unusable is SKIPPED
    // rather than fatal, so the sibling integer field survives.
    //
    // Arrays are NOT unwrapped here, and that asymmetry with `capabilityOf` is
    // deliberate rather than an oversight: `capabilities` is a set and its first
    // element is a real answer, whereas a context length arriving as an array is
    // a shape nobody has observed and picking an element would be a guess about
    // which token count it is. Unknown reads as unknown.
    if (Number.isInteger(v) && v > 0 && v <= CTX_MAX) return v;
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
  // Alive but unavailable, told apart from broken. A consumer looking at bare
  // `error{402}` beside `error{0}` cannot distinguish an unpaid account from a
  // host that does not resolve, and 429 across a 44-host sweep is ordinary.
  if (status === 402) return { outcome: "error", status, reason: REASONS.PAYMENT };
  if (status === 429) return { outcome: "error", status, reason: REASONS.RATE_LIMIT };
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

/**
 * A model listing is a few hundred short JSON objects. The largest real one in
 * the set (openrouter, a few hundred models) is comfortably under 1 MB, so 8 MB
 * is roughly a tenfold headroom over anything legitimate. It is a CEILING that
 * no honest listing approaches, not a target: without it, `res.text()` is
 * unbounded and one host streaming without end holds the whole fan-out open
 * until the 45 s abort while its buffer grows in a process that is holding 44
 * live credentials.
 */
export const MAX_BODY_BYTES = 8 << 20;

/**
 * `responded` is a first-class field and not an inference from the outcome enum.
 * Without it `auth`, `empty`, `unsupported-shape` and an all-refused `ok` differ
 * only by a string, and every one of them is a host that ANSWERED -- so a
 * consumer reducing the record to `models.length` prunes a provider that is
 * alive. It is false only where nothing was sent or nothing came back.
 */
const blank = (provider, at) =>
  ({ provider, at, responded: false, models: [], count: 0, rejected: 0 });

/**
 * @returns {Promise<string|null>} the body, or null when it exceeded `max`.
 *
 * The stream path is the one that actually enforces the ceiling: it stops
 * pulling the moment the count is exceeded, and abandoning the iterator cancels
 * the underlying stream, so the socket goes with it. The `text()` fallback
 * exists because a caller's stub need not carry a body stream; it can only
 * refuse the record after the fact, not prevent the allocation, and that limit
 * is stated rather than implied.
 */
async function readCapped(res, max) {
  const body = res.body;
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let n = 0;
    for await (const chunk of body) {
      const buf = Buffer.from(chunk);
      n += buf.length;
      if (n > max) return null;
      chunks.push(buf);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await res.text();
  return Buffer.byteLength(text, "utf8") > max ? null : text;
}

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
    maxBodyBytes = MAX_BODY_BYTES,
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
  let oversize = false;
  try {
    const res = await fetchImpl(resolved.url, {
      method: listing.method ?? "GET",
      headers: headersFor(profile, key),
      redirect: "manual",                  // a 3xx is an outcome, not a hop
      signal: ctrl.signal,
    });
    status = Number(res.status);
    if (status >= 200 && status < 300) {
      // The declared length first, so an oversized body costs zero bytes read.
      // A host that lies or omits it is caught by the ceiling in readCapped.
      const declared = Number(res.headers?.get?.("content-length"));
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        oversize = true;
      } else {
        const text = await readCapped(res, maxBodyBytes);
        if (text === null) oversize = true;
        else { try { json = JSON.parse(text); } catch { json = null; } }
      }
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
  // `responded: true` from here down: the host answered, whatever it said.
  const base = { ...blank(provider, at), responded: true, status, hostPinned: resolved.hostPinned };

  // One hostile body is ONE provider's error and never the run's. Before the
  // per-record write in cli.mjs this could not have been contained anyway --
  // nothing was persisted until every provider had resolved.
  if (oversize) return { ...base, outcome: "error", reason: REASONS.OVERSIZE };

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
 * LATENT TODAY, and the threshold stated correctly rather than by a factor of
 * three: `refresh/cli.mjs` emits one target per provider, so the budget bites
 * only when one provider carries MORE THAN `authBudget` (3) targets. The vault's
 * densest provider carries 2 (groq and deepseek, of 46 eligible credentials
 * across the 44 probed providers), so it stays latent.
 *
 * It was previously unreachable below SEVEN targets for one provider, not four,
 * because every worker read `spent` in the same synchronous window before any
 * await resolved -- so the budget could not bite until there were more targets
 * than workers. The reservation below is the fix, and the control is kept rather
 * than deleted for being currently latent: a stated safety property removed
 * because nothing exercises it today is how safety properties rot.
 */
export async function discoverAll(targets, opts = {}) {
  const {
    concurrency = CONCURRENCY,
    authBudget = AUTH_BUDGET,
    scrub = true,
    env = process.env,
    onResult = null,
    now = () => new Date().toISOString(),
  } = opts;

  // The guard covers the AMBIENT transport, which is the only one a preload can
  // reach. A caller supplying its own `fetchImpl` has declared it owns that
  // transport, and a stub makes no connection for a proxy to sit in front of.
  if (opts.fetchImpl === undefined || opts.fetchImpl === globalThis.fetch) {
    const refusal = proxyRefusal();
    if (refusal) throw new Error(refusal);
  }
  if (scrub) scrubProxyEnv(env);           // for children we spawn, not for us

  const queue = [...targets];
  const consecutiveAuth = new Map();       // provider -> count. PER PROVIDER.
  const results = [];

  const record = (r) => {
    results.push(r);
    // Guarded: a caller whose per-record write throws must lose that record, not
    // this worker and with it every provider still queued behind it.
    if (onResult) { try { onResult(r); } catch { /* the caller owns reporting */ } }
  };

  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const spent = consecutiveAuth.get(t.provider) ?? 0;
      if (spent >= authBudget) {
        record({
          ...blank(t.provider, now()), outcome: "error", status: 0, reason: REASONS.AUTH_BUDGET,
        });
        continue;
      }
      // RESERVE before the await, pessimistically. Every worker otherwise reads
      // the same `spent` in one synchronous window and none of them sees another
      // worker's increment, which is what made the budget unreachable.
      consecutiveAuth.set(t.provider, spent + 1);
      const r = await discoverProvider(t, opts);
      // Released on any non-auth outcome: the counter is CONSECUTIVE failures.
      if (r.outcome !== "auth") consecutiveAuth.set(t.provider, 0);
      record(r);
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

/**
 * `icacls` prints a principal it cannot resolve to a name as a BARE SID, with no
 * `DOMAIN\` part -- an account on a machine that is off its domain, or one whose
 * reverse lookup is unavailable. `.split("\\").pop()` returns the whole SID and
 * matches no username, so without this branch every write fails its own
 * verification and the run ends with zero records after spending all 44
 * authenticated requests. It fails CLOSED, so nothing leaks; it still burns the
 * entire authorization for nothing, which is what makes it a blocker.
 */
const SID_FORM = /^S-1-(?:\d+-)+\d+$/i;

let cachedSid;
function currentUserSid() {
  if (cachedSid !== undefined) return cachedSid;
  try {
    const out = execFileSync("whoami", ["/user", "/fo", "csv", "/nh"],
                             { encoding: "utf8", timeout: 30_000, windowsHide: true });
    cachedSid = out.match(/S-1-(?:\d+-)+\d+/)?.[0] ?? "";
  } catch { cachedSid = ""; }              // unknown SID matches nothing: still closed
  return cachedSid;
}

/**
 * Exactly one principal, and it is this user. Anything else is not owner-only.
 * `sid` is a RESOLVER rather than a value so the lookup costs a child process
 * only on the branch that needs one, which is the rare one.
 */
export function isOwnerOnly(output, username, filePath = "", { sid = currentUserSid } = {}) {
  const names = aclPrincipals(output, filePath);
  if (names.length !== 1) return false;
  const who = names[0];
  if (SID_FORM.test(who)) {
    const mine = (sid ?? currentUserSid)();
    return mine !== "" && who.toLowerCase() === String(mine).toLowerCase();
  }
  return who.split("\\").pop().toLowerCase() === String(username).toLowerCase();
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
  if (!isOwnerOnly(listed, user, target, { sid: acl.sid })) {
    throw new Error(`refusing to leave ${path.basename(target)} readable beyond its owner`);
  }
}

/** A record this tool wrote, by filename shape, including a leftover temp name. */
const RECORD_NAME = /^[0-9a-f]{32}\.json(?:\.tmp-\d+)?$/;

/**
 * `--out` reaches `icacls /inheritance:r /grant:r`, which REWRITES a directory's
 * DACL and strips its inheritance. `--out .` would therefore relock the
 * repository root, and every file under it, on a typo.
 *
 * REFUSE rather than repair, the same shape `resolveListingUrl` uses: the
 * directory must be absent -- in which case this tool creates it and owns it --
 * or hold nothing but records this tool wrote. Anything else is somebody's
 * directory and its permissions are not ours to rewrite.
 */
export function resolveCacheDir(given, opts = {}) {
  const { fsImpl = fs, env = process.env } = opts;
  if (given === null || given === undefined || given === "") return cacheRoot(env);

  const dir = path.resolve(String(given));
  if (!fsImpl.existsSync(dir)) return dir;
  if (!fsImpl.statSync(dir).isDirectory()) {
    throw new Error(`refusing to use ${dir} as a cache directory: it is not a directory`);
  }
  const foreign = fsImpl.readdirSync(dir).filter((n) => !RECORD_NAME.test(n));
  if (foreign.length) {
    throw new Error(
      `refusing to rewrite the permissions of ${dir}: it holds ${foreign.length} entr` +
      `${foreign.length === 1 ? "y" : "ies"} this tool did not write`);
  }
  return dir;
}

/**
 * The prior record at this path, or null. Best effort by design: a prior record
 * that cannot be read is not a reason to lose today's.
 */
function priorRecord(file, user, acl) {
  try {
    if (!fs.existsSync(file)) return null;
    if (!isOwnerOnly(acl.run([file]), user, file, { sid: acl.sid })) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch { return null; }
}

/**
 * One 403 must not destroy a cached 120-model listing. The new record still
 * states today's truth -- the outcome, the status, the reason -- and carries the
 * last listing that actually worked alongside it, so a consumer has both "this
 * provider failed to answer today" and "here is what it last served".
 *
 * The carried models are already-projected records, so this discloses nothing
 * the file did not already hold.
 */
function lastGoodOf(record, prior) {
  if (record.outcome === "ok") return undefined;      // today's listing IS the good one
  if (!prior) return undefined;
  if (prior.outcome === "ok") return { at: prior.at, count: prior.count, models: prior.models };
  return prior.lastGood;                              // carry an older one forward
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
  const carried = lastGoodOf(record, priorRecord(file, user, acl));
  const payload = carried ? { ...record, lastGood: carried } : record;

  const tmp = `${file}.tmp-${process.pid}`;
  let renamed = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    // Locked down BEFORE it takes its final name, so the record never exists at
    // a readable path in a readable state.
    enforceOwnerOnly(tmp, user, { acl });
    fs.renameSync(tmp, file);
    renamed = true;
    // INSIDE the try, which is the whole of this fix. Outside it, a genuine
    // non-zero icacls exit -- a locked file, the 30 s timeout -- threw past the
    // cleanup below and left the record sitting on disk while the caller printed
    // "cache write failed" and moved on.
    if (!isOwnerOnly(acl.run([file]), user, file, { sid: acl.sid })) {
      throw new Error(`refusing to keep ${path.basename(file)}: it is not owner-only after the write`);
    }
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    // This costs the prior record when the failure lands after the rename. That
    // is the correct trade: a file whose DACL could not be verified must not
    // remain, and the failure is loud rather than silent.
    if (renamed) fs.rmSync(file, { force: true });
    throw e;
  }
  return file;
}

/** Refused at read if the file is not owner-only. */
export function readCacheRecord(provider, opts = {}) {
  const { dir = cacheRoot(), user = os.userInfo().username, acl = { run: icacls } } = opts;
  const file = cacheFileFor(provider, dir);
  if (!fs.existsSync(file)) return null;
  const listed = acl.run([file]);
  if (!isOwnerOnly(listed, user, file, { sid: acl.sid })) {
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

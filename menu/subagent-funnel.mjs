// The ONE shared PURE funnel behind the subagent model policy (plan sections 5.3, 8; D-o). Every count, every stage,
// every refusal verdict and the ranked candidate lists come from `funnel()`. The CLI shell (`keysync/subagent-policy.mjs`)
// and, later, the picker toggle pane both call it, so `set`, `show`, `explain` and the pane cannot disagree.
//
// No I/O, no `node:` import, no other import than the two shared rule modules: the picker import graph may not reach
// keysync/ or refresh/ (test/bench-counts.test.mjs), and a contract test pins this import list.
//
// Population words are kept next to every count on purpose (stage 1 counts snapshot ROUTES; every later stage counts
// distinct SELECTORS after the `[1m]` collapse), because a figure true of one population restated about another is
// this project's most common defect.
import { POOL_ALIAS_RE } from "./pool-rule.mjs";
import { RELAY_KEY_ID, RELAY_TIER, freeScopeOf, isExcludedTier, isProvenanceVerified } from "./tiers.mjs";

/** The free tag (I9): the token `free` delimited by `:`, `/`, `_`, `.`, `-` or an edge. Tested on the BARE id. */
export const FREE_TAG = /(^|[:/_.-])free($|[:/_.-])/i;
/** Provider-supplied ids are UNTRUSTED (cr-m3): a selector that fails this never reaches a list or injected text. */
export const SELECTOR_MAX = 160;                               // sa-A10: 13 of 6,080 routes were rejected at the old 64-character cap; 160 is the router's own log-selector cap
export const SELECTOR_RE = new RegExp(`^[A-Za-z0-9_./:@+~-]{1,${SELECTOR_MAX}}$`);
export const SUBSTITUTE_FLOOR = 128000;
export const ONE_M = 1000000;
export const PAYLOAD_RISK_BYTES = 1000000;
// The request size the tool sweep's big step sends (about 400 KB): a record with `big: "p"` proves the model ACCEPTED a body of this size. It is emitted on the compiled row as `bk` (routing data: it is in the content hash
// through `models`; it changes no eligibility, rank, tier or count, and a router that does not know the field ignores it). A `big: "f"`, a missing or a garbled `big` never emits it.
export const BIG_PROVEN_BYTES = 400000;
/** Measured in the live shadow (state/subagent/classify.jsonl, 2026-10-05; never read by a test): 337 classified subagent requests, 317 over 200 KB, 71 over 1 MB (sa-A1). */
export const PAYLOAD_SAMPLE = Object.freeze({ n: 337, over200k: 317, over1m: 71 });
const pct = (a, b) => Math.round((100 * a) / b);
export const payloadSampleText = () => `${PAYLOAD_SAMPLE.over200k} of ${PAYLOAD_SAMPLE.n} classified subagent requests (${pct(PAYLOAD_SAMPLE.over200k, PAYLOAD_SAMPLE.n)}%) were over 200 KB and ${PAYLOAD_SAMPLE.over1m} (${pct(PAYLOAD_SAMPLE.over1m, PAYLOAD_SAMPLE.n)}%) over 1 MB`;

// ---- toggle 3, the context toggle (D-bg, D-bk). A HARD floor excludes rows below it (an empty result is the empty-set refusal); a SOFT preference makes rows at or above it a higher band and
// excludes nothing; `any` excludes nothing. Whatever the value, the substitute floor the router derives from the compiled `ctxHints` is capped at the toggle's own floor (128k for `any` and every
// soft preference): the asked model's own context never raises it, the router's per-request token fit check does that work.
export const CTX_FLOORS = Object.freeze({ "128k": 128000, "200k": 200000, "256k": 256000, "512k": 512000, "1m": ONE_M });
export const CTX_PREFERS = Object.freeze({ "prefer-256k": 256000, "prefer-512k": 512000, "prefer-1m": ONE_M });
export const CTX_VALUES = Object.freeze(["any", ...Object.keys(CTX_FLOORS), ...Object.keys(CTX_PREFERS)]);
export const ctxSpec = (ctx) => ({ hard: Object.hasOwn(CTX_FLOORS, ctx) ? CTX_FLOORS[ctx] : 0, prefer: Object.hasOwn(CTX_PREFERS, ctx) ? CTX_PREFERS[ctx] : 0 });
/** The substitute floor handed to the router through `ctxHints`: the hard floor, but never below the 128k substitute floor. */
export const hintCapOf = (ctx) => Math.max(SUBSTITUTE_FLOOR, ctxSpec(ctx).hard);
/** In-band ctx CLASSES (D-bh, D-bk): 0 >= 1M, 1 >= 512k, 2 >= 256k, 3 >= 200k, 4 >= 128k, 5 below or unknown. */
export const CTX_CLASS_FLOORS = Object.freeze([[ONE_M, "1M"], [512000, "512k"], [256000, "256k"], [200000, "200k"], [SUBSTITUTE_FLOOR, "128k"]]);
export const ctxClassOf = (c) => { const i = CTX_CLASS_FLOORS.findIndex(([v]) => c >= v); return i < 0 ? CTX_CLASS_FLOORS.length : i; };
/** The printable name of a ctx value in a sentence: 1m is 1M, 256k stays 256k. */
export const ctxLabel = (ctx) => (ctx === "1m" ? "1M" : ctx);
/** TTFT quantile buckets (D-bh): the cut points are computed over the eligible set, so the buckets are equal-sized whatever the provider mix. 4 = no TTFT recorded. */
export const TTFT_BUCKETS = Object.freeze(["fast", "ok", "slow", "very slow"]);

// ---- non-agent ids (D-bi): safety classifiers, guards, embedders, rerankers, OCR, LoRA adapters and tiny (under 4B) models are never candidates, so no inference can make one a substitute
const NON_AGENT_RE = /(^|[^a-z])(safety|safeguard|(nemo|ass)?guard|embed[a-z]*|rerank|reranker|ocr|lora|moderation|transcribe|nvclip|melotts|sentence-transformers|image|imagen|translate|translation|search|deepsearch)($|[^a-z])|(^|[^a-z0-9])(asr|tts|whisper|clip|colbert|bge|e5)($|[^a-z0-9])/i;   // embed[a-z]* covers embedding, embeddings, embeddinggemma, embedqa, embedcode; asr/tts/whisper are speech, clip/colbert/bge/e5 retrieval models; image/imagen are image generators, translate/translation are translators, search is a search-grounded or search-agent model (gemini-*-preview-search, relace-search): a WORD of the id, so `research` and `searcher` are not caught
const TINY_B_RE = /(^|[-_/:@])(\d+(?:\.\d+)?)b($|[-_/:@])/ig;
export const TINY_MODEL_B = 4;
/** `non-agent-model` or null, from the BARE id only (untrusted text, never executed). */
export function nonAgentReason(bare) {
  const id = String(bare);
  if (NON_AGENT_RE.test(id)) return "non-agent-model";
  for (const m of id.matchAll(TINY_B_RE)) if (Number(m[2]) < TINY_MODEL_B) return "non-agent-model";
  return null;
}

// ---- known issues (sa-A6): a seed for rows that fail on a Claude Code tool request, used ONLY until a real tool-fidelity record exists (a real record always wins), and ONLY for the named provider.
// kind x = a tool failure prior (tier x); kind cap = a size refusal, never x (D-ba): it sets the payload cap upper bound. issue is the GitHub issue number, null when none is filed.
export const KNOWN_ISSUES = Object.freeze([
  { issue: 118, provider: "aihubmix", ids: ["coding-glm-5.1-free"], kind: "x", text: "aihubmix coding-glm-5.1-free answers 400 to a tool schema (the glm-5.x backend)" },
  { issue: 119, provider: "aihubmix", ids: ["xiaomi-mimo-v2.5-pro-free"], kind: "x", text: "aihubmix xiaomi-mimo-v2.5-pro-free answers 400 to the Artifact tool schema" },
  { issue: null, provider: "nvidia", ids: ["openai/gpt-oss-20b"], kind: "x", text: "the same model answers 400 to a tool request at groq (not filed)" },
  { issue: 109, provider: "orcarouter", ids: ["deepseek/deepseek-v4-flash-free", "deepseek-v4-flash-free"], kind: "cap", capBelow: 408000, text: "the free tier refuses a 408 KB request" },
].map((k) => Object.freeze({ ...k, ids: Object.freeze(k.ids) })));
/** EXACT ids only (the provider key plus the bare id the issue names): a sibling model or a newer version is not the model the evidence is about. */
export const knownIssueOf = (provider, bare) => KNOWN_ISSUES.find((k) => k.provider === provider && k.ids.includes(String(bare).toLowerCase())) ?? null;
export const knownIssueText = (k) => `known issue ${k.issue === null ? "(not filed)" : `#${k.issue}`}: ${k.text}`;

// ---- bench statuses that are NOT proof of non-function (sa-A7): a transient failure on an old sample is a reason to re-probe, never to exclude silently
export const REPROBE_AGE_S = 2 * 86400;
export const isTransientDrop = (rec) => !!rec && (rec.s === "rate" || rec.s === "timeout" || rec.s === "empty" || (rec.s === "error" && /fetch failed/i.test(String(rec.m ?? ""))));
/** Premium (D-b, Q3): catalogue family opus or fable, or an output price at least this many USD per M tokens. */
export const PREMIUM_RULE = Object.freeze({ families: Object.freeze(["opus", "fable"]), outUsdPerM: 20 });
export const FREE_SCOPES = Object.freeze(["models", "providers", "providers+deposit"]);
export const SCOPE_NAMES = Object.freeze({ "models": "free models", "providers": "free providers", "providers+deposit": "free providers + deposit" });
export const DEFAULT_MIN_SET = 3;
export const SUBSTITUTE_K = 3;

const FAMILY_RE = new RegExp(`(^|[^a-z])(${PREMIUM_RULE.families.join("|")})([^a-z]|$)`, "i");
const OPUS_MT = /(^|[^a-z])opus-mt(?=[^a-z]|$)/gi;               // sa-A12: Helsinki-NLP opus-mt is a translation model, not Claude Opus
/** A plain object with the same OWN keys (a key named __proto__ stays an own key, JSON.stringify writes it, JSON.parse reads it back as one). */
const own = (o) => Object.fromEntries(Object.entries(o));
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const stripOneM = (id) => String(id).replace(/\[1m\]$/i, "");
const providerOf = (sel) => { const s = String(sel); const i = s.indexOf("/"); return i < 0 ? s : s.slice(0, i); };
const lastDot = (s) => { const i = String(s ?? "").lastIndexOf("."); return i < 0 ? "" : String(s).slice(i + 1); };

/** FNV-1a, 32 bit, over the UTF-8 bytes, unsigned (plan 5.3). */
export function fnv1a32(str) {
  let h = 2166136261;
  for (const b of new TextEncoder().encode(String(str))) { h ^= b; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** `$in/$out` per million tokens, trailing zeros trimmed; `free` when both are 0; `$?` when neither is listed. */
export function priceText(pin, pout) {
  const a = num(pin), b = num(pout);
  if (a === null && b === null) return "$?";
  if (a === 0 && b === 0) return "free";
  const f = (v) => (v === null ? "?" : "$" + String(Number(v.toFixed(4))));
  return `${f(a)}/${f(b)}`;
}
/** price = pin + pout when both are listed, the listed one when only one is, null when neither (rank key 2b, 5.3). */
export const priceSum = (pin, pout) => {
  const a = num(pin), b = num(pout);
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
};
export const isPremium = (bareId, pout) => FAMILY_RE.test(String(bareId).replace(OPUS_MT, "$1")) || (num(pout) !== null && num(pout) >= PREMIUM_RULE.outUsdPerM);

const chatCapable = (m) => m && m.mode !== true &&
  (m.outModality === "chat" || m.outModality === "chat?" || (m.outModality == null && m.outputKind !== "nontext"));

/** The one resolvability rule (cr-m7): provider present, enabled !== false, and its models list includes the rest. */
export function resolvable(sel, providers) {
  const s = String(sel);
  const i = s.indexOf("/");
  if (i < 1 || !Array.isArray(providers)) return false;
  const p = providers.find((x) => x && x.name === s.slice(0, i));
  return !!p && p.enabled !== false && Array.isArray(p.models) && p.models.includes(s.slice(i + 1));
}

const TOOL_RANK = { v: 0, t: 1, u: 2 };

// ---- the tool sweep's own evidence about a model's CURRENT state (state/tool-fidelity.json top level `pending` {key:{r,n,at,since?,rn?,why?}} and `held` {provider:{r,at}}). The sweep result is the LATEST state of the model:
// health is the model's current state, calendar independent, so a bench-ok record six days old does not outvote a sweep that is blocked on it. `at` is wall-clock on purpose: it records WHEN the failure happened, it is not
// an expiry. A confirmed t or v record NEWER than the pending entry (its own `at`) wins and the entry is ignored; a garbled `at` on the entry (or on the record it would be compared with) makes the entry UNUSABLE (fail open:
// nothing happens). `since`, `rn` and `why` are additive and tolerated; `rn` (the runs in a row with THIS reason) drives the soft threshold; an entry without it is a legacy one and counts as rn = 1 (its `n` counts every run whatever the reason, so it proves nothing about THIS one). Nothing else in `pending` is ever used.
//   HARD (a hard state is never asked again, so its count freezes at 1 or 2 and is ignored): gone, pay, auth and canary-gone/-pay/-auth. gone EXCLUDES the row (`unreachable`) unless it has a confirmed t or v record (then it
//   DEMOTES); pay and auth DEMOTE. As in the sweep (hardState) a canary-gone or canary-pay entry of a provider that has confirmed results is no verdict about this model and is ignored; canary-auth stays.
//   SOFT (recoverable, at least SWEEP_MIN_N runs in a row): rate, upstream-unavailable, slow, timeout, error, quota DEMOTE, never exclude. error NEVER excludes. The scheduling and budget reasons (cap, spend, row-cost, not-run,
//   request-cap, priced-over-row-cap, reasoning-budget, route-shape, empty) say nothing about the model and are never used.
//   HELD providers: held gone or pay applies only when the provider has NO confirmed t or v record (the sweep's holdIsWrong: a provider that answered is never gone and never out of credit as a whole); held auth always applies
//   (the key is the account; a pass NEWER than the hold wins). held gone excludes, held pay and auth demote.
export const SWEEP_MIN_N = 3;
export const SWEEP_SOFT = Object.freeze(["rate", "upstream-unavailable", "slow", "timeout", "error", "quota"]);
export const SWEEP_DEMOTE = SWEEP_SOFT;                                                   // the soft reasons (the name kept for importers): demote at SWEEP_MIN_N runs in a row, never exclude
export const SWEEP_HARD = Object.freeze(["gone", "pay", "auth"]);
/** The rank keys, in order (the one list `explain` prints). The first four are the BAND keys; the rest order rows INSIDE a band. Every marker key is `clean above flagged`; the spawn marker is the LAST key, a tie-breaker only. */
export const RANK_LABELS = Object.freeze(["tool tier (band)", "health: latest status ok (band)", "ctx preference (band)", "price class 2b (band)", "first strike", "sweep demotion (blocked by the sweep, never excluded)",
  "big step (v only)", "L4 (v only)", "forced-choice only (fc)", "argument fidelity failed (af)", "tool_result use failed (er, br)",
  "ttft quantile bucket", "ctx class", "price 2b", "recency (order only, calendar-dependent)", "alias", "spawn failed (sp: a last tie-breaker; matters only for a row that acts as a MAIN agent)"]);
/** Mirror of the sweep module's confirmedProviders and holdIsWrong: a test pins the two to each other. */
export const confirmedByProvider = (models) => {
  const out = Object.create(null);
  for (const [k, r] of Object.entries(models ?? {})) if (r && (r.t === "t" || r.t === "v")) { const p = k.slice(0, k.indexOf("/")); out[p] = (out[p] ?? 0) + 1; }
  return out;
};
export const holdIsWrong = (h, confirmed, provider) => !!h && (h.r === "gone" || h.r === "pay") && (confirmed?.[provider] ?? 0) > 0;
const atMs = (iso) => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) ? t : NaN; };
const okEntry = (e) => !!e && typeof e === "object" && typeof e.r === "string" && Number.isFinite(atMs(e.at));

/** Eligibility of a tool tier under the owner's `unverified` setting (5.1, 8 stage 4). `x` is never eligible. */
export function toolEligible(tier, unverified, pinned) {
  if (tier === "x") return false;
  if (tier === "v") return true;
  if (pinned) return true;
  if (unverified === "pin-only") return false;
  if (unverified === "allow-t") return tier === "t";
  return true;                                                  // allow-warn: v, t and u
}

/**
 * @param inputs {rows, bench:{get,isLive}, nowMs, providers|null, tiers|null, toolFidelity|null, aliasValues, defaultModel, minSet}
 *   rows         snapshot rows (schema 9 shape); bench.get(`provider/bareId`) -> {s,t,a}|null; providers: live
 *                [{name, models, enabled}] or null (gateway down: the snapshot `routable` flag is used);
 *                tiers: {provider: tier} from the registry or null (unreadable); toolFidelity: {models:{key:{t,alias}}}|null.
 * @param toggles {source, mode, freeScope, ctx, unverified, allow}
 */
export function funnel(inputs, toggles) {
  const { rows = [], bench, providers = null, tiers = null, toolFidelity = null, aliasValues = {}, defaultModel = null, classifyBench = null } = inputs;
  const nowMs = Number.isFinite(inputs.nowMs) ? inputs.nowMs : 0;
  const minSet = Number.isInteger(inputs.minSet) && inputs.minSet >= 1 ? inputs.minSet : DEFAULT_MIN_SET;
  const T = { source: "same-provider", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [], ...toggles };
  const allow = new Set(T.allow ?? []);
  const warnings = [];
  const warn = (code, text) => warnings.push({ code, text });

  const counts = { universe: 0, chatCapable: 0, routesInProviders: 0, inProviders: 0, idRejected: 0, benchOk: 0, toolsPass: 0,
    accountState: { pay: 0, auth: 0, rate: 0 }, unverifiedExcluded: 0, oneMSpellingOnly: 0, nonAgent: 0, unreachable: 0, gatewayCompat: 0, reprobeSkipped: 0 };
  const unreachable = [], gatewayCompat = [];
  const sweepPending = toolFidelity && typeof toolFidelity.pending === "object" && toolFidelity.pending && !Array.isArray(toolFidelity.pending) ? toolFidelity.pending : {};
  const sweepHeld = toolFidelity && typeof toolFidelity.held === "object" && toolFidelity.held && !Array.isArray(toolFidelity.held) ? toolFidelity.held : {};
  const confirmedBy = confirmedByProvider(toolFidelity?.models);
  const passOf = (tf) => !!tf && (tf.t === "v" || tf.t === "t");
  /** What the tool sweep says about this row's CURRENT state: {kind: "unreachable" | "demote", r, n, at, source, hard} or null (see the rules above). */
  const sweepFinding = (g, tf) => {
    const conf = confirmedBy[g.provider] ?? 0, tfAt = tf ? atMs(tf.at) : 0;
    const newerPass = (at) => passOf(tf) && tfAt > atMs(at);
    const found = [];
    const pe = Object.hasOwn(sweepPending, g.selector) ? sweepPending[g.selector] : null;
    if (okEntry(pe) && !(tf && !Number.isFinite(tfAt)) && !newerPass(pe.at)) {
      const m = /^(canary-)?(pay|auth|gone)$/.exec(pe.r);
      const hard = m && !(m[1] && m[2] !== "auth" && conf > 0) ? m[2] : null;
      const runs = Number.isInteger(pe.rn) && pe.rn >= 1 ? pe.rn : 1;                     // a legacy entry (no rn) counts as ONE run: its n counts every run whatever the reason (cap, then error, ...); it heals when the next live sweep writes rn
      const n = runs;
      if (hard === "gone") found.push({ kind: passOf(tf) ? "demote" : "unreachable", r: "gone", n: null, at: pe.at, source: "pending", hard: true });
      else if (hard) found.push({ kind: "demote", r: hard, n: null, at: pe.at, source: "pending", hard: true });
      else if (SWEEP_SOFT.includes(pe.r) && runs >= SWEEP_MIN_N) found.push({ kind: "demote", r: pe.r, n, at: pe.at, source: "pending", hard: false });
    }
    const he = Object.hasOwn(sweepHeld, g.provider) ? sweepHeld[g.provider] : null;
    if (okEntry(he) && !(tf && !Number.isFinite(tfAt)) && SWEEP_HARD.includes(he.r) && !holdIsWrong(he, confirmedBy, g.provider) && !(he.r === "auth" && newerPass(he.at))) {
      found.push({ kind: he.r === "gone" ? "unreachable" : "demote", r: he.r, n: null, at: he.at, source: "held", hard: true });
    }
    return found.find((x) => x.kind === "unreachable") ?? found[0] ?? null;
  };
  const provOk = Object.create(null), provFind = Object.create(null), reprobeSkipped = [];
  const nonAgent = [];
  const idRejected = [];
  const dropped = new Map();                                    // `provider/bare` -> why a route never became a candidate
  const tierMismatch = [];
  const groups = new Map();                                     // selector -> aggregate over the collapsed routes

  // ---- stages 1-2: chat-capable, selector, [1m] collapse, sanitiser
  for (const r of rows) {
    const provider = r.provider;
    const relay = r.keyId === RELAY_KEY_ID;
    const regTier = relay ? RELAY_TIER : (tiers && Object.hasOwn(tiers, provider) ? tiers[provider] : undefined);   // own read: a provider may be named __proto__ or constructor
    if (tiers && !relay && regTier && lastDot(r.keyId) && lastDot(r.keyId) !== regTier
        && !tierMismatch.some((x) => x.provider === provider)) {
      tierMismatch.push({ provider, snapshot: lastDot(r.keyId), registry: regTier });
    }
    for (const m of r.models ?? []) {
      counts.universe += 1;
      const bare = stripOneM(m.id);
      const key = `${provider}/${bare}`;
      if (!chatCapable(m)) { dropped.set(key, "not-chat-capable"); continue; }
      counts.chatCapable += 1;
      if (nonAgentReason(bare)) { counts.nonAgent += 1; nonAgent.push(key); dropped.set(key, "non-agent-model"); continue; }   // D-bi: judged on the bare id, before any grouping, so it can neither be a candidate nor lend an inferred ctx
      // The selector emitted is always the BARE one (Claude Code strips [1m] from the wire model), so the bare spelling is what
      // must resolve and what the sanitiser judges: a route spelled `x[1m]` whose bare `x` is listed is the same selector as `x`.
      // Only the [1m] spelling listed means no wire id can reach it: its own drop reason, never id-rejected.
      let sel = null;
      if (providers) {
        if (resolvable(key, providers)) sel = key;
        else if ((bare !== m.id && resolvable(`${provider}/${m.id}`, providers)) || resolvable(`${key}[1m]`, providers)) {
          counts.oneMSpellingOnly += 1; dropped.set(key, "only-1m-spelling-listed"); continue;
        }
      } else if (m.routable !== false) sel = key;
      if (!sel) { dropped.set(key, "not-in-providers"); continue; }
      if (!SELECTOR_RE.test(sel)) { counts.idRejected += 1; idRejected.push(sel); dropped.set(key, "id-rejected"); continue; }
      counts.routesInProviders += 1;
      let g = groups.get(`${provider}/${bare}`);
      if (!g) {
        g = { selector: `${provider}/${bare}`, provider, bare, tier: regTier, relay, keyId: r.keyId ?? null, ctx: 0, tag1m: false, tag1mOnly: false,
              bareCtx: 0, toolsAny: false, badgeFree: false, pin: null, pout: null, limit: 0, limitSource: null, provenance: m.provenance ?? null, routes: 0 };
        groups.set(g.selector, g);
      }
      g.routes += 1;
      const c = num(m.ctx) ?? 0;
      if (c > g.ctx) g.ctx = c;
      if (bare !== m.id) g.tag1m = true;
      if (bare === m.id && c > g.bareCtx) g.bareCtx = c;
      if (m.tools !== false) g.toolsAny = true;
      if (m.badge === "FREE" || m.badge === "FREE?") g.badgeFree = true;
      if (g.pin === null && g.pout === null) { g.pin = num(m.pin); g.pout = num(m.pout); }
      const lb = num(m.limit?.bytes) ?? num(r.limit?.bytes) ?? 0;
      if (lb > g.limit) { g.limit = lb; g.limitSource = "catalogue"; }
    }
  }
  counts.inProviders = groups.size;

  // ---- inferred ctx (D-bi, sa-A5): a row with NO known context takes the smallest known context of its same-name siblings (the same underlying model on any provider), but only as a
  // FLOOR-ONLY prior, flagged `ci`: it is clamped to the 128k substitute floor, so it can never satisfy a higher floor, never reach a ctx class above >= 128k, and is never shown as measured.
  // The smallest sibling is used so one small route vetoes it; a sibling with no known ctx lends nothing. A SIBLING is the same model: the same last id segment up to a tier suffix (:free, -free), a date or an
  // @region, AND the same vendor path (the segments before the last) whenever both ids have one. A pool alias (auto, router, default, free: the model behind the name changes) neither borrows nor lends,
  // and neither does a re-upload namespace (community/, user/, hf/ ...): the same file name there is not the same model.
  const nameKey = (bare) => String(bare).split("/").pop().toLowerCase().replace(/\[1m\]$/, "").replace(/@[a-z]{2,6}$/, "").replace(/[:_-]free$/, "")
    .replace(/[-_]?(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  const vendorOf = (bare) => String(bare).toLowerCase().split("/").slice(0, -1).join("/");
  const REUPLOAD = /^(community|users?|hf|huggingface|uploads?)$/i;
  const infers = (g) => !POOL_ALIAS_RE.test(g.bare) && !String(g.bare).split("/").slice(0, -1).some((seg) => REUPLOAD.test(seg));
  const byName = new Map();
  for (const g of groups.values()) {
    g.cm = Math.max(g.ctx, g.tag1m ? ONE_M : 0);                    // the measured context (catalogue or a [1m] sibling), 0 when unknown
    g.ci = 0;
    if (!infers(g)) continue;
    const k = nameKey(g.bare);
    (byName.get(k) ?? byName.set(k, []).get(k)).push(g);
  }
  for (const sibs of byName.values()) {
    if (sibs.length < 2) continue;
    for (const g of sibs) {
      if (g.cm > 0) continue;
      const vg = vendorOf(g.bare);
      const known = sibs.filter((x) => x !== g && x.cm > 0 && (!vg || !vendorOf(x.bare) || vendorOf(x.bare) === vg)).map((x) => x.cm);
      if (known.length && Math.min(...known) >= SUBSTITUTE_FLOOR) g.ci = 1;
    }
  }

  // ---- stages 3-4 per selector group
  const probeOk = [];                                           // groups that pass stages 1-4, with their tool tier
  const reprobe = [], accountRows = [];
  let aliasProbeOk = 0;
  for (const g of groups.values()) {
    const rec = bench?.get ? bench.get(g.selector) : null;
    g.status = rec ? rec.s : null;
    g.rec = rec ?? null;
    g.ok = !!rec && rec.s === "ok" && Number.isFinite(rec.a);
    g.premium = isPremium(g.bare, g.pout);
    g.alias = POOL_ALIAS_RE.test(g.bare);
    g.tag = FREE_TAG.test(g.bare);
    g.c = g.cm > 0 ? g.cm : g.ci ? SUBSTITUTE_FLOOR : 0;
    g.oneM = g.c >= ONE_M;
    g.n = g.oneM && (g.relay || g.bareCtx < ONE_M) ? 1 : 0;
    const ok = g.ok;
    if (rec && (rec.s === "pay" || rec.s === "auth" || rec.s === "rate")) counts.accountState[rec.s] += 1;
    if (!ok) {
      g.stage = g.stage ?? (rec ? `bench-${rec.s}` : "bench-none");
      // sa-A7: a free-tagged (or free-labelled-provider) row dropped on a transient status of an OLD sample is not dead, it is unknown: it waits for a re-probe and is named, never silently excluded
      if (isTransientDrop(rec) && Number.isFinite(rec.a) && nowMs / 1000 - rec.a > REPROBE_AGE_S && (g.tag || g.badgeFree || freeScopeOf(g.tier) === "providers")) {
        // the stored message can say the ACCOUNT is the reason (a plan, a key, an empty balance: the shell classifies it with the bench `classifyTight`): that is account state, not a model waiting for a re-probe
        // the tool sweep's own repeated evidence wins over a single old bench message: a model the sweep found gone or erroring at its last N attempts is not "waiting for a re-probe", and one it found out of credit is account state
        const sw = sweepFinding(g, toolFidelity?.models?.[g.selector] ?? null);
        const why = sw?.kind === "unreachable" ? "gone" : sw?.kind === "demote" && sw.r === "pay" ? "pay" : (typeof classifyBench === "function" ? classifyBench(rec) : null);
        const row = { s: g.selector, status: rec.s, ageDays: Math.floor((nowMs / 1000 - rec.a) / 86400) };
        if (why === "pay" || why === "auth") { g.accountState = why; accountRows.push({ ...row, why }); }
        else if (why !== "gone") { g.reprobe = true; reprobe.push(row); }
        else if (sw?.kind === "unreachable") { g.reprobeSkipped = sw; counts.reprobeSkipped += 1; reprobeSkipped.push({ ...row, r: sw.r, source: sw.source }); }      // never silent: named in a list (the sweep says it is gone, so it does not wait for a re-probe)
      }
      continue;
    }
    counts.benchOk += 1;
    provOk[g.provider] = (provOk[g.provider] ?? 0) + 1;
    if (g.alias) aliasProbeOk += 1;
    const tf = toolFidelity?.models?.[g.selector] ?? null;
    // M2: a record the sweep tagged xw:gateway failed because of the GATEWAY's own request translation, not the model: left out with that reason, and asked again only when CCR changes (a new CCR build re-queues it)
    if (tf?.xw === "gateway") { g.stage = "gateway-compat"; g.gatewayCompat = true; counts.gatewayCompat += 1; gatewayCompat.push(g.selector); continue; }
    // B1: the tool sweep's latest state of the model (see sweepFinding): a hard gone without any confirmed pass (or a held gone provider) is UNREACHABLE (left out, listed, never an allow-pin override); everything else only DEMOTES
    const sf = sweepFinding(g, tf);
    if (sf && sf.source === "pending") { const byR = (provFind[g.provider] ??= Object.create(null)); byR[sf.r] = (byR[sf.r] ?? 0) + 1; }
    if (sf?.kind === "unreachable") { g.stage = "unreachable"; g.unreachable = sf; counts.unreachable += 1; unreachable.push({ s: g.selector, r: sf.r, n: sf.n, at: sf.at, source: sf.source }); continue; }
    if (sf?.kind === "demote") g.demoted = sf;
    let tier, basis;
    // A known-issue seed stays in force until a record carries a REAL result at L3 or the big step (or is a confirmed x): an L1+L2-only record never sends a tool set or a 408 KB body, so it proves nothing about either.
    const ki = knownIssueOf(g.provider, g.bare);
    const realResult = !!tf && (tf.t === "x" || tf.lvr?.[2] === "p" || tf.lvr?.[2] === "f" || tf.big === "p" || tf.big === "f");
    const seed = ki && !realResult ? ki : null;
    if (seed) g.knownIssue = seed;
    if (isProvenanceVerified(g.tier)) { tier = "v"; basis = "provenance"; }
    else if (seed?.kind === "x") { tier = "x"; basis = "known-issue"; }
    else if (tf && ["v", "t", "x"].includes(tf.t)) { tier = g.alias && tf.t !== "x" ? "u" : tf.t; basis = "tool-fidelity"; }
    else if (g.toolsAny) { tier = "u"; basis = "unprobed"; }
    else { g.stage = "tools-false-claim"; continue; }
    g.toolTier = tier; g.toolBasis = basis;
    g.bigProven = tf?.big === "p";
    // Measured tool fidelity beyond the class (state/tool-fidelity.json): the big step and L4 are rank keys inside class v, and a REFUSAL about size
    // (capBelow, an observed upper bound) lowers the payload cap. maxBytes is only a lower bound and never sets a cap.
    if (basis === "tool-fidelity") {
      g.tfBig = tf.big === "p" || tf.big === "f" ? tf.big : "n";
      g.tfL4 = typeof tf.lvr === "string" && (tf.lvr[3] === "p" || tf.lvr[3] === "f") ? tf.lvr[3] : "n";
      const cap = Number.isInteger(tf.capBelow) && tf.capBelow > 0 ? tf.capBelow : 0;
      if (cap && (g.limit === 0 || cap < g.limit)) { g.limit = cap; g.limitSource = "capBelow"; }
    }
    if (seed?.kind === "cap" && basis !== "provenance" && (g.limit === 0 || seed.capBelow < g.limit)) { g.limit = seed.capBelow; g.limitSource = "known-issue"; }
    // sa-T3: a provisional first strike (refresh/tool-fidelity.mjs: strikes 1) is read from ANY record, class or not; it ranks below a clean row of the same class and never excludes
    g.tfStrike = tf && tf.strikes === 1 ? 1 : 0;
    // H2 markers (never a band key, never an exclusion): clean above flagged. fc p = L1 passed only when the call was forced; af f = argument fidelity failed; (a stored `pt` marker of an older sweep is tolerated and IGNORED: it never ranks); er f or br f = the is_error case or the use of a long tool_result failed; sp f = the spawn call failed
    g.mk = basis === "tool-fidelity" ? { fc: tf.fc === "p" ? 1 : 0, af: tf.af === "f" ? 1 : 0, erbr: tf.er === "f" || tf.br === "f" ? 1 : 0, sp: tf.sp === "f" ? 1 : 0 } : { fc: 0, af: 0, erbr: 0, sp: 0 };
    if (!toolEligible(tier, T.unverified, allow.has(g.selector))) { counts.unverifiedExcluded += 1; g.stage = tier === "x" ? (basis === "known-issue" ? "known-bad" : "tools-failed") : "tools-unverified"; continue; }
    counts.toolsPass += 1;
    g.stage = "tools-pass";
    probeOk.push(g);
  }

  // ---- free scopes (5): the tier comes from the registry only
  const tierOf = (g) => g.tier;                                 // undefined when the provider has no resolvable key or the registry is unreadable
  // what each tier feeds comes from the vocabulary data (menu/tiers.mjs), never from a second list here
  const scopeOf = freeScopeOf;
  const strictTier = (t) => scopeOf(t) === "deposit";
  const freeTier = (t) => scopeOf(t) === "providers";
  const scopeStats = { models: new Set(), providers: new Set(), "providers+deposit": new Set() };
  const scopeN = { models: 0, providers: 0, "providers+deposit": 0 };
  const scopeCtx1m = { models: 0, providers: 0, "providers+deposit": 0 };
  const skipped = { models: 0, "providers+deposit": 0, population: 0 };   // population: probe-ok selectors on paid and deposit tiers, the denominator of both counts
  const skippedIds = [];
  let pricedButBadged = 0;
  for (const g of probeOk) {
    const t = tierOf(g);
    const noScope = scopeOf(t) === null;
    const zero = priceSum(g.pin, g.pout) === 0;
    g.in = { models: false, providers: false, "providers+deposit": false };
    if (!noScope) {
      // ONE free verdict for the `free models` scope (sa-A11): on a free-labelled provider a row is free when it carries the free tag, the FREE badge or a listed price of exactly 0 for both input and
      // output (a `price: free` row and its `:free` sibling then agree); on a paid or deposit provider only the free tag counts (the strict rule, a price of 0 is not a promise there).
      g.in.models = freeTier(t) ? (g.badgeFree || g.tag || (num(g.pin) === 0 && num(g.pout) === 0)) : g.tag;
      g.in.providers = tiers !== null && freeTier(t);
      g.in["providers+deposit"] = tiers !== null && (freeTier(t) || (strictTier(t) && g.tag));
    }
    if (strictTier(t)) skipped.population += 1;
    if (strictTier(t) && !g.tag) {
      if (g.badgeFree || zero) { skipped.models += 1; g.skipReason = "deposit-strict-skipped"; }
      skipped["providers+deposit"] += 1;
      skippedIds.push(g.selector);
    }
    if (g.in.models && g.badgeFree && (priceSum(g.pin, g.pout) ?? 0) > 0) { pricedButBadged += 1; g.pricedButBadged = true; }
    for (const s of FREE_SCOPES) if (g.in[s]) { scopeN[s] += 1; scopeStats[s].add(g.provider); if (g.oneM) scopeCtx1m[s] += 1; }
  }
  const freeScopes = {};
  for (const s of FREE_SCOPES) {
    freeScopes[s] = tiers === null && s !== "models" ? { n: null, providers: null, ctx1m: null, unavailable: true }
      : { n: scopeN[s], providers: scopeStats[s].size, ctx1m: scopeCtx1m[s] };
  }

  const refuse = T.mode === "free" && T.freeScope !== "models" && tiers === null
    ? { code: "E_TIER_UNREADABLE", text: `the vault registry or key choices could not be read; ${SCOPE_NAMES[T.freeScope]} needs the key tier` } : null;
  if (tiers === null) {
    warn("TIERS", "TIERS: registry unreadable: free scopes providers and providers+deposit are refused; scope models falls back to the STRICT rule (free tag only) for every provider");
  }

  // ---- toggle 2 (free) and toggle 3 (ctx): the chosen set, with a record of every stage for emptiness reporting
  // An EXCLUDED tier (management, menu/tiers.mjs) is never admitted under any mode or scope (plan revision 7 item 8): no row, no list, no count.
  const excludedTier = (g) => isExcludedTier(g.tier);
  const inScope = (g) => !excludedTier(g) && (T.mode !== "free" ? true : g.in?.[T.freeScope] === true);
  const ctxHard = ctxSpec(T.ctx).hard, ctxPrefer = ctxSpec(T.ctx).prefer;
  const set = [];
  const perProvider = Object.create(null);                      // keyed by a provider name, which may be __proto__ or constructor: no prototype, so the key is always an own one
  const pp = (p) => (perProvider[p] ??= { benchOk: 0, tools: 0, scope: 0, ctx: 0, sub: 0 });
  for (const g of groups.values()) if (g.ok) pp(g.provider).benchOk += 1;
  for (const g of probeOk) {
    const p = pp(g.provider);
    p.tools += 1;
    if (!inScope(g)) { g.stage = excludedTier(g) ? "excluded-tier" : "scope"; continue; }
    p.scope += 1;
    if (ctxHard > 0 && !(g.cm >= ctxHard)) { g.stage = "ctx"; continue; }               // a hard floor tests the MEASURED ctx (cm): an unknown ctx is below it, and an inferred ctx (a floor-only prior for the default 128k substitute floor) is never counted, whatever the floor
    p.ctx += 1;
    g.stage = "in-set";
    if (g.c >= SUBSTITUTE_FLOOR) p.sub += 1;
    set.push(g);
  }
  const totals = { benchOk: counts.benchOk, tools: counts.toolsPass, scope: 0, ctx: 0, sub: 0 };
  for (const p of Object.values(perProvider)) { totals.scope += p.scope; totals.ctx += p.ctx; totals.sub += p.sub; }

  // ---- rank (5.3, revised by owner decision D1): the BAND keys come first, in this order: 1 tool tier, 2 HEALTH (the model's latest status is probe-ok: yes or no, AGE IGNORED, so the
  // band never depends on the calendar), 3 context preference class (only under a soft ctx preference prefer-256k, prefer-512k or prefer-1m: rows at or above it first), 4 price class (free
  // providers under mode free). Then, INSIDE a band only, the ordering keys: 5 strike (a provisional first tool-fidelity strike after a clean row, sa-T3), 6 sweep demotion (the tool sweep failed at its last 3+ attempts for a reason that is not "gone" or "error" and no newer pass
  // exists: ranked below clean rows, never excluded), 7 big step and 8 L4 (class v only), then the H2 MARKERS, each "clean above flagged" and none a band key: 9 fc (forced-choice only), 10 af (argument fidelity failed),
  // 11 er or br (the is_error case or the long tool_result failed), then 12 TTFT QUANTILE bucket (D-bh), 13 ctx CLASS (>= 1M, >= 512k, >= 256k, >= 200k, >= 128k, below or unknown; an inferred ctx is at most the 128k class),
  // 14 price value, 15 RECENCY class (live within 7 days, probe within 14 days, older: CALENDAR-DEPENDENT, so it is an ordering key only: it never outranks latency or context), 16 non-alias first, and LAST 17 sp (the spawn
  // call failed: a tie-breaker that matters only for a row that acts as a MAIN agent); then a hash of the id (FNV-1a), then the id. RANK_LABELS names them.
  const price2b = T.mode === "free" && T.freeScope !== "models";
  // TTFT QUANTILE buckets over the eligible set (D-bh): fast / ok / slow / very slow are the quartiles of the TTFTs of the rows in THIS set (nearest rank), so the buckets are equal-sized whatever the data
  // (the old fixed 1 s / 3 s cuts put 97.5% of the rows in one bucket); 4 = no TTFT recorded.
  const ttfts = set.map((g) => num(g.rec?.t)).filter((v) => v !== null).sort((a, b) => a - b);
  const ttftCuts = [0.25, 0.5, 0.75].map((q) => (ttfts.length ? ttfts[Math.max(0, Math.ceil(q * ttfts.length) - 1)] : null));
  const ttftBucket = (t) => (t === null ? 4 : t <= ttftCuts[0] ? 0 : t <= ttftCuts[1] ? 1 : t <= ttftCuts[2] ? 2 : 3);
  const keyOf = (g) => {
    const rec = g.rec;
    const ageS = nowMs / 1000 - (rec?.a ?? 0);
    const live = !!(bench?.isLive && bench.isLive(g.selector));
    const recency = live && ageS <= 7 * 86400 ? 0 : ageS <= 14 * 86400 ? 1 : 2;       // ordering inside a band only: with more than 3 rows in a band it still makes the choice of the top 3 calendar dependent
    const healthOk = rec && rec.s === "ok" ? 0 : 1;                                    // the latest bench status merged with the observer overlay (bench.get): admitted rows are ok, so this is constant in a set; it is a band key for the day a non-ok row is admitted
    const ctxPref = ctxPrefer > 0 && !(g.c >= ctxPrefer) ? 1 : 0;                     // soft preference (D-bk): rows at or above it are a higher band; nothing is excluded
    // classes (plan 5.3, revision 8 item 2, owner ruling Q6): 0 price 0 on a free-tier row, 0t strict-free-tag row on a paid or deposit provider, U unknown price, P positive price
    let pc = 0, pv = 0;
    if (price2b) {
      if (freeTier(tierOf(g))) {
        const p = priceSum(g.pin, g.pout);
        pc = p === 0 ? 0 : p === null ? 2 : 3;
        pv = p === null ? 0 : p;
      } else pc = 1;
    }
    const h = ttftBucket(num(rec?.t));
    g.h = h;
    // inside class v (never elsewhere): big step passed, then not run, then failed; then L4 the same way. Constant 0 outside v, so no other row moves.
    const inV = g.toolTier === "v" && g.toolBasis === "tool-fidelity";
    const pnf = { p: 0, n: 1, f: 2 };
    return [TOOL_RANK[g.toolTier] ?? 2, healthOk, ctxPref, pc, g.tfStrike ? 1 : 0, g.demoted ? 1 : 0, inV ? pnf[g.tfBig] : 0, inV ? pnf[g.tfL4] : 0, g.mk.fc, g.mk.af, g.mk.erbr, h, ctxClassOf(g.c), pv, recency, g.alias ? 1 : 0, g.mk.sp];
  };
  for (const g of set) g.rk = keyOf(g);
  const cmpKeys = (a, b) => { for (let i = 0; i < a.rk.length; i++) if (a.rk[i] !== b.rk[i]) return a.rk[i] - b.rk[i]; return 0; };
  // the final tie-break is a hash of the selector (FNV-1a, the funnel own hash), then the selector itself so it stays total: deterministic, but not biased toward early-alphabet providers in the top K
  const tieOf = (g) => (g.tie ??= fnv1a32(g.selector));
  set.sort((a, b) => cmpKeys(a, b) || tieOf(a) - tieOf(b) || (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
  let gi = -1;
  set.forEach((g, i) => { if (i === 0 || cmpKeys(set[i - 1], g) !== 0) gi += 1; g.g = gi; });
  // BAND (router v2, ar-4; D1): rows equal on the first four rank keys [tool tier, health yes/no, context preference class, price class]; constant over every later key (recency,
  // price value, ctx, TTFT, alias, id), so a band is a contiguous run of the sorted set. The banded spread chooses only among the rows of the lead row's band: a row with a
  // worse tier, health, context preference or price class is never mixed into a fan-out that has a better one. The recency class is NOT a band key.
  const BAND_KEYS = 4;
  const cmpBand = (a, b) => { for (let i = 0; i < BAND_KEYS; i++) if (a.rk[i] !== b.rk[i]) return a.rk[i] - b.rk[i]; return 0; };
  let bi = -1;
  set.forEach((g, i) => { if (i === 0 || cmpBand(set[i - 1], g) !== 0) bi += 1; g.b = bi; });

  // ---- compiled rows, lists, emptiness maps
  const fx = T.mode === "free";
  const models = set.map((g) => ({
    s: g.selector, c: g.c, f: g.in.models ? 1 : 0, t: g.toolTier, h: g.h, m: g.oneM ? 1 : 0, n: g.n,
    i: priceText(g.pin, g.pout), p: g.premium ? 1 : 0, pb: g.limit, al: g.alias ? 1 : 0,
    fp: fx && freeTier(tierOf(g)) ? 1 : 0, ft: fx && strictTier(tierOf(g)) && g.tag ? 1 : 0, g: g.g, b: g.b,
    ...(g.ci ? { ci: 1 } : {}),                                  // c? : the context is INFERRED from a sibling, a floor-only 128k prior, never measured
    ...(g.limit > 0 && g.limitSource ? { pbSource: g.limitSource } : {}),   // where pb came from: catalogue | capBelow (a tool-fidelity size refusal) | known-issue
    ...(g.bigProven ? { bk: BIG_PROVEN_BYTES } : {}),            // the sweep proved the model accepts a body this size (record big: "p"); additive, read by no rank key
  }));
  const inherit = T.mode === "inherit";
  const lists = { all: [], byProvider: Object.create(null), prov: Object.create(null) };
  if (!inherit) {
    if (T.source === "all-providers") lists.all = models.map((_, i) => i);
    else models.forEach((row, i) => { (lists.byProvider[providerOf(row.s)] ??= []).push(i); });
    // `prov`: every provider's rows in rank order, whatever the source (ar-4): the router scans main's own provider first without filtering the whole list
    models.forEach((row, i) => { (lists.prov[providerOf(row.s)] ??= []).push(i); });
  }
  const substitutable = Object.create(null);
  const setProviders = new Set();
  models.forEach((row) => {
    const p = providerOf(row.s);
    setProviders.add(p);
    substitutable[p] = (substitutable[p] ?? 0) + (row.c >= SUBSTITUTE_FLOOR ? 1 : 0);
  });
  substitutable["*"] = Object.entries(substitutable).reduce((a, [, v]) => a + v, 0);
  const emptyProviders = [], thinProviders = [];
  for (const p of [...setProviders].sort()) {
    if (substitutable[p] === 0) emptyProviders.push(p);
    else if (substitutable[p] < SUBSTITUTE_K) thinProviders.push(p);
  }
  const effectiveSource = inherit ? "same-provider" : T.source;
  const empty = !inherit && substitutable["*"] === 0;

  // ---- counts of the chosen set
  const tierCount = { v: 0, t: 0, u: 0 };
  let premium = 0, payloadRisk = 0, payloadUnknown = 0, alias = 0, oneMListing = 0, credit = 0;
  models.forEach((row, i) => {
    tierCount[row.t] += 1; if (row.p) premium += 1; if (row.al) alias += 1; if (row.n) oneMListing += 1;
    if (row.pb === 0) payloadUnknown += 1; else if (row.pb < PAYLOAD_RISK_BYTES) payloadRisk += 1;
    if (row.fp && (priceSum(set[i].pin, set[i].pout) ?? 0) > 0) credit += 1;
  });
  const chosenScope = probeOk.filter(inScope);
  // rows per context floor over the chosen scope, BEFORE the ctx toggle (the counts the `set` preview, `show` and the picker print so a floor is chosen knowingly): measured contexts only; the unknown rows are in none
  // of the floors, and `inferred` of them pass 128k on a sibling's context (a floor-only prior)
  const ctxStats = { rows: chosenScope.length, unknown: chosenScope.filter((g) => g.cm === 0).length, inferred: chosenScope.filter((g) => g.ci).length,
    ge: Object.fromEntries(Object.entries(CTX_FLOORS).map(([k, v]) => [k, chosenScope.filter((g) => g.cm >= v).length])) };
  counts.ctxInferred = models.filter((r) => r.ci).length;
  counts.ctxUnproven = counts.ctxInferred;                       // M1: a row whose 128k rests on a sibling's context: the only proof is the ~400 KB big step (about 100k tokens), the router's per-request fit check decides
  const demoted = set.filter((g) => g.demoted).map((g) => ({ s: g.selector, r: g.demoted.r, n: g.demoted.n, at: g.demoted.at, source: g.demoted.source, hard: g.demoted.hard })).sort((a, b) => (a.s < b.s ? -1 : 1));
  counts.demoted = demoted.length;
  // a PATTERN across a provider's bench-ok rows (the same pending reason on at least 3 and at least half of them): the provider, not the models, is probably the cause. Shown instead of a wall of single lines; nothing is excluded for it.
  const providerPatterns = [];
  for (const [p, byR] of Object.entries(provFind)) {
    const [r, k] = Object.entries(byR).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (k >= 3 && 2 * k >= provOk[p]) providerPatterns.push({ provider: p, reason: r, rows: k, of: provOk[p] });
  }
  providerPatterns.sort((a, b) => (a.provider < b.provider ? -1 : 1));
  counts.providerPatterns = providerPatterns.length;

  // ---- hints for the router
  const exempt = [];
  for (const k of ["haiku", "smallFast"]) {
    const v = aliasValues[k];
    if (typeof v === "string" && v) { const b = stripOneM(v); if (!exempt.includes(b)) exempt.push(b); }
  }
  const ctxHints = Object.create(null);                         // keyed by a settings alias value or a selector: own keys only
  // The router takes the substitute floor from these values (max(ctxHints[asked], 128000)). D-bg/D-bk: whatever the asked model's own context is (a [1m] alias says 1M), the value is CAPPED at the toggle's
  // floor (128k under `any` and every soft preference, the hard floor otherwise), so the asked model never raises the floor above what the owner chose; the per-request token fit does the rest.
  const hintCap = hintCapOf(T.ctx);
  const hintFor = (raw) => {
    if (typeof raw !== "string" || !raw) return;
    const b = stripOneM(raw), g = groups.get(b);
    const c = Math.min(Math.max(g?.c ?? 0, raw !== b ? ONE_M : 0), hintCap);
    if (c > 0) { ctxHints[b] = c; if (raw !== b) ctxHints[raw] = c; }
  };
  for (const k of ["opus", "sonnet", "haiku", "fable", "model", "smallFast"]) hintFor(aliasValues[k]);
  hintFor(defaultModel);
  for (const row of models) ctxHints[row.s] = Math.min(row.c, hintCap);

  // ---- warnings
  const likelyMain = defaultModel ? stripOneM(defaultModel) : null;
  const mainGroup = likelyMain ? groups.get(likelyMain) : null;
  if (inherit) {
    warn("SOURCE_IGNORED", "source ignored under inherit (the subagent gets main's exact model, which is by definition same-provider)");
    if (T.ctx === "1m" && likelyMain && !(mainGroup?.oneM || /\[1m\]$/i.test(defaultModel))) {
      warn("INHERIT_BELOW_CTX", `INHERIT BELOW CTX: --ctx 1m with --mode inherit: main ${likelyMain} is below 1M; subagents inherit it anyway (D-d)`);
    }
    if (mainGroup?.premium) {
      warn("INHERIT_PREMIUM_MAIN", `INHERIT PREMIUM MAIN: --mode inherit would give every non-exempt subagent main's model, and the likely main ${likelyMain} is Opus- or Fable-priced (${priceText(mainGroup.pin, mainGroup.pout)})`);
    }
  } else {
    const nu = tierCount.u;
    if (nu > 0) warn("UNVERIFIED", `UNVERIFIED: ${nu} of ${models.length} allowed models have unverified tool support (D-f)`);
    if (premium > 0) warn("PREMIUM", `PREMIUM: ${premium} of ${models.length} allowed models are Opus- or Fable-priced (price shown per row; no cap, D-b)`);
    if (models.length > 0) warn("PAYLOAD", `PAYLOAD: ${payloadRisk} of ${models.length} allowed models have a known payload cap below ${PAYLOAD_RISK_BYTES.toLocaleString("en-US")} bytes; ${payloadUnknown} have no known cap, so the payload gate is inert for them until a cap is measured (live shadow: ${payloadSampleText()})`);
    if (counts.unreachable > 0) warn("UNREACHABLE", `UNREACHABLE: ${counts.unreachable} of ${counts.benchOk} bench-ok ${counts.unreachable === 1 ? "model" : "models"} left out: the tool sweep found ${counts.unreachable === 1 ? "it" : "them"} gone and no confirmed pass exists (gone is a hard answer the sweep does not ask again; a held provider counts the same); an --allow pin does not override it (listed by show --detail yes and explain)`);
    if (demoted.length > 0) warn("DEMOTED", `DEMOTED: ${demoted.length} of ${models.length} allowed ${demoted.length === 1 ? "model ranks" : "models rank"} below clean rows because the tool sweep is blocked on ${demoted.length === 1 ? "it" : "them"} (rate, upstream-unavailable, slow, timeout, error or quota for ${SWEEP_MIN_N}+ runs in a row; pay, auth, or a gone answer with an earlier pass at once); none is excluded`);
    if (counts.gatewayCompat > 0) warn("GATEWAY_COMPAT", `GATEWAY_COMPAT: ${counts.gatewayCompat} of ${counts.benchOk} bench-ok ${counts.gatewayCompat === 1 ? "model" : "models"} left out because the tool test failed in the gateway's own request translation, not in the model; asked again only when CCR changes; an --allow pin does not override it`);
    if (counts.ctxUnproven > 0) warn("CTX_UNPROVEN", `CTX UNPROVEN: ${counts.ctxUnproven} of ${models.length} allowed models rest on an INFERRED 128k context (a same-name sibling's); the only measured proof is the 400 KB big step (about 100k tokens), so the router's per-request fit check decides, not this flag`);
    if (providerPatterns.length > 0) warn("PROVIDER_PATTERN", `PROVIDER_PATTERN: ${providerPatterns.slice(0, 6).map((x) => `${x.provider}: ${x.rows} of ${x.of} bench-ok rows pending ${x.reason}`).join("; ")}${providerPatterns.length > 6 ? ` and ${providerPatterns.length - 6} more` : ""}: the same sweep state on most of a provider's rows points at the provider, not the models; the rows are demoted or left out one by one, never the whole provider`);
    if (reprobe.length > 0) warn("REPROBE", `REPROBE: ${reprobe.length} free-tagged or free-provider models were dropped on a transient bench status (rate, empty, timeout, fetch failed) of a sample older than 2 days: not dead, waiting for a re-probe (listed by show --detail)`);
    if (oneMListing > 0) warn("ONE_M_LISTING", `1M basis listing-only for ${oneMListing} of ${models.length} allowed rows (n:1)`);
    if (alias > 0) warn("ALIAS", `ALIAS: ${alias} of ${models.length} allowed rows are pool aliases, flagged ALIAS, never above tier u`);
    const frag = [];
    if (effectiveSource === "all-providers") { if (substitutable["*"] > 0 && substitutable["*"] < minSet) frag.push(["all providers", substitutable["*"]]); }
    else for (const p of [...setProviders].sort()) if (substitutable[p] > 0 && substitutable[p] < minSet) frag.push([p, substitutable[p]]);
    if (frag.length) {
      const shown = frag.slice(0, 10).map(([p, n]) => `${p} (${n})`).join(", ") + (frag.length > 10 ? ` and ${frag.length - 10} more` : "");
      warn("FRAGILE", `FRAGILE: fewer than ${minSet} usable candidates for ${shown}: a fan-out concentrates on that many model(s) (cr-M6)`);
    }
    if (emptyProviders.length) warn("EMPTY_PROVIDERS", `EMPTY for ${emptyProviders.length} provider(s) with rows in the set but no substitute pool: ${emptyProviders.join(", ")} (saved anyway, D-c)`);
  }
  if (T.mode === "free") {
    const fragileN = [...setProviders].filter((p) => substitutable[p] < SUBSTITUTE_K).length;
    warn("FREE_PROMISE", `FREE PROMISE: ${fragileN} provider(s) have substitutable < ${SUBSTITUTE_K} and ${emptyProviders.length} have 0; when a free-mode request cannot be served from the free set the model it ASKED for (possibly paid) serves it, visibly (counter freeBreak, FREE_PROMISE_BREAK)`);
    const nFreeProv = Object.values(tiers ?? {}).filter(freeTier).length;
    warn("FREE_PROVIDERS", `FREE PROVIDERS: the tier is YOUR label from the vault registry; a provider labelled free that bills will bill (${nFreeProv} providers labelled free)`);
    warn("CREDIT", `CREDIT: free providers have token or credit limits; price-0 models rank first, then cheapest (${credit} of ${models.length} models in the chosen set are positive-priced)`);
    const noTier = [...new Set(probeOk.filter((g) => tiers !== null && !g.relay && tierOf(g) === undefined).map((g) => g.provider))].sort();
    if (noTier.length) warn("NO_TIER", `NO_TIER: ${noTier.length} of ${new Set(probeOk.map((g) => g.provider)).size} providers with probe-ok models have no resolvable key tier (no key, or several keys with no recorded choice): ${noTier.slice(0, 8).join(", ")}${noTier.length > 8 ? ` and ${noTier.length - 8} more` : ""}; the strict rule applies (free tag only) and they are in no provider scope`);
  }
  if (pricedButBadged > 0) warn("PRICED_BUT_BADGED", `PRICED_BUT_BADGED: ${pricedButBadged} models carry a free badge but a non-zero listed price`);
  if (skipped["providers+deposit"] > 0) warn("DEPOSIT_STRICT", `DEPOSIT STRICT: ${skipped["providers+deposit"]} of ${skipped.population} probe-ok selectors on paid or deposit providers lack a free tag and are skipped by the strict rule (listed by explain)`);
  for (const x of tierMismatch) warn("TIER_MISMATCH", `TIER_MISMATCH: snapshot key id says ${x.snapshot}, registry says ${x.registry} for provider ${x.provider} (registry used)`);
  if (counts.oneMSpellingOnly > 0) warn("ONLY_1M_SPELLING", `ONLY_1M_SPELLING: ${counts.oneMSpellingOnly} of ${counts.chatCapable} chat-capable routes are listed in Providers only with a [1m] spelling, which no wire model id can name; dropped (listed by explain)`);
  if (idRejected.length) warn("ID_REJECTED", `ID_REJECTED: ${idRejected.length} selector(s) failed the id sanitiser (listed by explain): ${idRejected.slice(0, 5).map((x) => x.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 80)).join(", ")}`);
  if (counts.accountState.pay + counts.accountState.auth + counts.accountState.rate > 0) {
    const a = counts.accountState;
    warn("ACCOUNT_STATE", `${a.pay + a.auth + a.rate} responding models excluded for account state (pay ${a.pay}, auth ${a.auth}, rate ${a.rate}) of ${groups.size} selectors: state, not death, never pruned from routing`);
  }

  return {
    toggles: T, refuse, empty, effectiveSource,
    counts: { ...counts, allowed: models.length, verified: tierCount.v, small: tierCount.t, unverified: tierCount.u, premium, payloadRisk, payloadUnknown,
      alias, aliasProbeOk, oneMListing, creditPositive: credit, pricedButBadged,
      depositStrictSkipped: { ...skipped }, freeScopes, substitutable: substitutable["*"],
      chosenScopeN: chosenScope.length, chosenScopeCtx1m: chosenScope.filter((g) => g.oneM).length, reprobe: reprobe.length, accountStateRows: accountRows.length,
      knownBad: [...groups.values()].filter((g) => g.stage === "known-bad").length, unreachable: counts.unreachable, demoted: demoted.length, gatewayCompat: counts.gatewayCompat, ctxUnproven: counts.ctxUnproven, providerPatterns: providerPatterns.length, reprobeSkipped: counts.reprobeSkipped },
    totals, perProvider: own(perProvider), models, lists: { all: lists.all, byProvider: own(lists.byProvider), prov: own(lists.prov) }, substitutable: own(substitutable), emptyProviders, thinProviders, exempt, ctxHints: own(ctxHints), warnings, idRejected, tierMismatch,
    skippedIds, groups, dropped, ctxStats, ttftCuts, nonAgent, providerPatterns, reprobeSkipped: reprobeSkipped.sort((a, b) => (a.s < b.s ? -1 : 1)), unreachable: unreachable.sort((a, b) => (a.s < b.s ? -1 : 1)), demoted, gatewayCompat: gatewayCompat.sort(), reprobe: reprobe.sort((a, b) => (a.s < b.s ? -1 : 1)), accountRows: accountRows.sort((a, b) => (a.s < b.s ? -1 : 1)),
    stages: [
      { stage: "chat-capable", n: counts.chatCapable, of: counts.universe, unit: "routes" },
      { stage: "in-providers", n: counts.inProviders, of: counts.chatCapable, unit: "selectors (routes after the [1m] collapse)" },
      { stage: "bench-ok", n: counts.benchOk, of: counts.inProviders, unit: "selectors" },
      { stage: "tools-not-false", n: counts.toolsPass, of: counts.benchOk, unit: "selectors" },
    ],
  };
}

/** The first stage at which a provider (or, with null, the whole universe) lost every candidate, for the E_EMPTY text. */
export function emptyStage(result, provider = null) {
  const c = provider === null ? result.totals : (Object.hasOwn(result.perProvider, provider) ? result.perProvider[provider] : { benchOk: 0, tools: 0, scope: 0, ctx: 0, sub: 0 });
  const seq = [["tools", "the tools stage", c.benchOk], ["scope", `the ${result.toggles.mode === "free" ? SCOPE_NAMES[result.toggles.freeScope] : "scope"} filter`, c.tools],
    ["ctx", `the ctx ${result.toggles.ctx} filter`, c.scope], ["sub", "the substitute floor (known context of at least 128,000)", c.ctx]];
  const after = [c.tools, c.scope, c.ctx, c.sub];
  for (let i = 0; i < seq.length; i++) if (after[i] === 0) return { stage: seq[i][0], text: seq[i][1], before: seq[i][2] };
  return null;
}

export { providerOf, stripOneM };

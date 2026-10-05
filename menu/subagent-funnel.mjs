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
export const SELECTOR_RE = /^[A-Za-z0-9_./:@+~-]{1,64}$/;
export const SUBSTITUTE_FLOOR = 128000;
export const ONE_M = 1000000;
export const PAYLOAD_RISK_BYTES = 1000000;
/** Premium (D-b, Q3): catalogue family opus or fable, or an output price at least this many USD per M tokens. */
export const PREMIUM_RULE = Object.freeze({ families: Object.freeze(["opus", "fable"]), outUsdPerM: 20 });
export const FREE_SCOPES = Object.freeze(["models", "providers", "providers+deposit"]);
export const SCOPE_NAMES = Object.freeze({ "models": "free models", "providers": "free providers", "providers+deposit": "free providers + deposit" });
export const DEFAULT_MIN_SET = 3;
export const SUBSTITUTE_K = 3;

const FAMILY_RE = new RegExp(`(^|[^a-z])(${PREMIUM_RULE.families.join("|")})([^a-z]|$)`, "i");
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
export const isPremium = (bareId, pout) => FAMILY_RE.test(String(bareId)) || (num(pout) !== null && num(pout) >= PREMIUM_RULE.outUsdPerM);

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
  const { rows = [], bench, providers = null, tiers = null, toolFidelity = null, aliasValues = {}, defaultModel = null } = inputs;
  const nowMs = Number.isFinite(inputs.nowMs) ? inputs.nowMs : 0;
  const minSet = Number.isInteger(inputs.minSet) && inputs.minSet >= 1 ? inputs.minSet : DEFAULT_MIN_SET;
  const T = { source: "same-provider", mode: "dynamic", freeScope: "providers", ctx: "any", unverified: "allow-warn", allow: [], ...toggles };
  const allow = new Set(T.allow ?? []);
  const warnings = [];
  const warn = (code, text) => warnings.push({ code, text });

  const counts = { universe: 0, chatCapable: 0, routesInProviders: 0, inProviders: 0, idRejected: 0, benchOk: 0, toolsPass: 0,
    accountState: { pay: 0, auth: 0, rate: 0 }, unverifiedExcluded: 0, oneMSpellingOnly: 0 };
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
              bareCtx: 0, toolsAny: false, badgeFree: false, pin: null, pout: null, limit: 0, provenance: m.provenance ?? null, routes: 0 };
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
      g.limit = Math.max(g.limit, num(m.limit?.bytes) ?? num(r.limit?.bytes) ?? 0);
    }
  }
  counts.inProviders = groups.size;

  // ---- stages 3-4 per selector group
  const probeOk = [];                                           // groups that pass stages 1-4, with their tool tier
  let aliasProbeOk = 0;
  for (const g of groups.values()) {
    const rec = bench?.get ? bench.get(g.selector) : null;
    g.status = rec ? rec.s : null;
    g.rec = rec ?? null;
    g.ok = !!rec && rec.s === "ok" && Number.isFinite(rec.a);
    g.premium = isPremium(g.bare, g.pout);
    g.alias = POOL_ALIAS_RE.test(g.bare);
    g.tag = FREE_TAG.test(g.bare);
    g.c = Math.max(g.ctx, g.tag1m ? ONE_M : 0);
    g.oneM = g.c >= ONE_M;
    g.n = g.oneM && (g.relay || g.bareCtx < ONE_M) ? 1 : 0;
    const ok = g.ok;
    if (rec && (rec.s === "pay" || rec.s === "auth" || rec.s === "rate")) counts.accountState[rec.s] += 1;
    if (!ok) { g.stage = g.stage ?? (rec ? `bench-${rec.s}` : "bench-none"); continue; }
    counts.benchOk += 1;
    if (g.alias) aliasProbeOk += 1;
    const tf = toolFidelity?.models?.[g.selector] ?? null;
    let tier, basis;
    if (isProvenanceVerified(g.tier)) { tier = "v"; basis = "provenance"; }
    else if (tf && ["v", "t", "x"].includes(tf.t)) { tier = g.alias && tf.t !== "x" ? "u" : tf.t; basis = "tool-fidelity"; }
    else if (g.toolsAny) { tier = "u"; basis = "unprobed"; }
    else { g.stage = "tools-false-claim"; continue; }
    g.toolTier = tier; g.toolBasis = basis;
    // Measured tool fidelity beyond the class (state/tool-fidelity.json): the big step and L4 are rank keys inside class v, and a REFUSAL about size
    // (capBelow, an observed upper bound) lowers the payload cap. maxBytes is only a lower bound and never sets a cap.
    if (basis === "tool-fidelity") {
      g.tfBig = tf.big === "p" || tf.big === "f" ? tf.big : "n";
      g.tfL4 = typeof tf.lvr === "string" && (tf.lvr[3] === "p" || tf.lvr[3] === "f") ? tf.lvr[3] : "n";
      const cap = Number.isInteger(tf.capBelow) && tf.capBelow > 0 ? tf.capBelow : 0;
      if (cap) g.limit = g.limit > 0 ? Math.min(g.limit, cap) : cap;
    }
    if (!toolEligible(tier, T.unverified, allow.has(g.selector))) { counts.unverifiedExcluded += 1; g.stage = tier === "x" ? "tools-failed" : "tools-unverified"; continue; }
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
      g.in.models = freeTier(t) ? (g.badgeFree || g.tag) : g.tag;
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
  const set = [];
  const perProvider = Object.create(null);                      // keyed by a provider name, which may be __proto__ or constructor: no prototype, so the key is always an own one
  const pp = (p) => (perProvider[p] ??= { benchOk: 0, tools: 0, scope: 0, ctx: 0, sub: 0 });
  for (const g of groups.values()) if (g.ok) pp(g.provider).benchOk += 1;
  for (const g of probeOk) {
    const p = pp(g.provider);
    p.tools += 1;
    if (!inScope(g)) { g.stage = excludedTier(g) ? "excluded-tier" : "scope"; continue; }
    p.scope += 1;
    if (T.ctx === "1m" && !g.oneM) { g.stage = "ctx"; continue; }
    p.ctx += 1;
    g.stage = "in-set";
    if (g.c >= SUBSTITUTE_FLOOR) p.sub += 1;
    set.push(g);
  }
  const totals = { benchOk: counts.benchOk, tools: counts.toolsPass, scope: 0, ctx: 0, sub: 0 };
  for (const p of Object.values(perProvider)) { totals.scope += p.scope; totals.ctx += p.ctx; totals.sub += p.sub; }

  // ---- rank (5.3, revised by owner decision D1): the BAND keys come first, in this order: 1 tool tier, 2 HEALTH (the model's latest status is probe-ok: yes or no, AGE IGNORED, so the
  // band never depends on the calendar), 3 context preference class (only under ctx prefer-1m: rows of at least 1M first), 4 price class (free providers under mode free). Then, INSIDE a
  // band only, the ordering keys: 5 recency class (live within 7 days, probe within 14 days, older: a pure ordering key), 6 price value, 7 ctx desc, 8 TTFT, 9 non-alias first; then the id.
  const price2b = T.mode === "free" && T.freeScope !== "models";
  const keyOf = (g) => {
    const rec = g.rec;
    const ageS = nowMs / 1000 - (rec?.a ?? 0);
    const live = !!(bench?.isLive && bench.isLive(g.selector));
    const recency = live && ageS <= 7 * 86400 ? 0 : ageS <= 14 * 86400 ? 1 : 2;       // ordering inside a band only: with more than 3 rows in a band it still makes the choice of the top 3 calendar dependent
    const healthOk = rec && rec.s === "ok" ? 0 : 1;                                    // the latest bench status merged with the observer overlay (bench.get): admitted rows are ok, so this is constant in a set; it is a band key for the day a non-ok row is admitted
    const ctxClass = T.ctx === "prefer-1m" && !(g.c >= ONE_M) ? 1 : 0;
    // classes (plan 5.3, revision 8 item 2, owner ruling Q6): 0 price 0 on a free-tier row, 0t strict-free-tag row on a paid or deposit provider, U unknown price, P positive price
    let pc = 0, pv = 0;
    if (price2b) {
      if (freeTier(tierOf(g))) {
        const p = priceSum(g.pin, g.pout);
        pc = p === 0 ? 0 : p === null ? 2 : 3;
        pv = p === null ? 0 : p;
      } else pc = 1;
    }
    const ttft = num(rec?.t);
    const h = ttft === null ? 2 : ttft < 1000 ? 0 : ttft < 3000 ? 1 : 2;
    g.h = h;
    // inside class v (never elsewhere): big step passed, then not run, then failed; then L4 the same way. Constant 0 outside v, so no other row moves.
    const inV = g.toolTier === "v" && g.toolBasis === "tool-fidelity";
    const pnf = { p: 0, n: 1, f: 2 };
    return [TOOL_RANK[g.toolTier] ?? 2, healthOk, ctxClass, pc, inV ? pnf[g.tfBig] : 0, inV ? pnf[g.tfL4] : 0, recency, pv, -g.c, h, g.alias ? 1 : 0];
  };
  for (const g of set) g.rk = keyOf(g);
  const cmpKeys = (a, b) => { for (let i = 0; i < a.rk.length; i++) if (a.rk[i] !== b.rk[i]) return a.rk[i] - b.rk[i]; return 0; };
  set.sort((a, b) => cmpKeys(a, b) || (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
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

  // ---- hints for the router
  const exempt = [];
  for (const k of ["haiku", "smallFast"]) {
    const v = aliasValues[k];
    if (typeof v === "string" && v) { const b = stripOneM(v); if (!exempt.includes(b)) exempt.push(b); }
  }
  const ctxHints = Object.create(null);                         // keyed by a settings alias value or a selector: own keys only
  const hintFor = (raw) => {
    if (typeof raw !== "string" || !raw) return;
    const b = stripOneM(raw), g = groups.get(b);
    const c = Math.max(g?.c ?? 0, raw !== b ? ONE_M : 0);
    if (c > 0) { ctxHints[b] = c; if (raw !== b) ctxHints[raw] = c; }
  };
  for (const k of ["opus", "sonnet", "haiku", "fable", "model", "smallFast"]) hintFor(aliasValues[k]);
  hintFor(defaultModel);
  for (const row of models) ctxHints[row.s] = row.c;

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
    if (models.length > 0) warn("PAYLOAD", `PAYLOAD: ${payloadRisk} of ${models.length} allowed models have a known payload cap below ${PAYLOAD_RISK_BYTES.toLocaleString("en-US")} bytes (largest observed subagent body 919 KB); ${payloadUnknown} have no known cap`);
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
      chosenScopeN: chosenScope.length, chosenScopeCtx1m: chosenScope.filter((g) => g.oneM).length },
    totals, perProvider: own(perProvider), models, lists: { all: lists.all, byProvider: own(lists.byProvider), prov: own(lists.prov) }, substitutable: own(substitutable), emptyProviders, thinProviders, exempt, ctxHints: own(ctxHints), warnings, idRejected, tierMismatch,
    skippedIds, groups, dropped,
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
    ["ctx", "the ctx 1m filter", c.scope], ["sub", "the substitute floor (known context of at least 128,000)", c.ctx]];
  const after = [c.tools, c.scope, c.ctx, c.sub];
  for (let i = 0; i < seq.length; i++) if (after[i] === 0) return { stage: seq[i][0], text: seq[i][1], before: seq[i][2] };
  return null;
}

export { providerOf, stripOneM };

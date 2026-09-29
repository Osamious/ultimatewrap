// Builds every table of the study from ~/.uw/state/bench.json + ~/.uw/catalog/snapshot.json (+ discovery caches, + the two
// bench backups). READ-ONLY on all inputs. Writes data.json, models.csv, providers.csv into plans/bench-study/.
import fs from "node:fs"; import path from "node:path";
import { load, loadDiscovery, snap, benchFile, bench, readJson, H, OUT, pct, q, iso, strip, LAST_RUN_START_S, redact, normListId } from "./lib.mjs";
import { cluster, textOf } from "./clusters.mjs";

const before = readJson(path.join(H, ".uw/state/bench.before-probe-all.json")).models;
const first = readJson(path.join(H, ".uw/state/bench.first-sweep.json")).models;
const disc = loadDiscovery();
const all = load();
const rows = all.filter((r) => r.eligible);           // eligible = text-or-unknown output, routable !== false
const STATUS = ["ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate"];
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

// ---------------------------------------------------------------- enrich
const idsOf = new Map();                              // provider -> Map(lowercase id -> canonical id)
for (const r of all) { if (!idsOf.has(r.provider)) idsOf.set(r.provider, new Map()); idsOf.get(r.provider).set(strip(r.id).toLowerCase(), strip(r.id)); }
for (const [p, d] of disc) { if (!idsOf.has(p)) idsOf.set(p, new Map()); for (const id of d.ids) idsOf.get(p).set(id.toLowerCase(), id); }
const norm = (s) => s.toLowerCase().replace(/[._]/g, "-");
const SUFFIX = /(:free|:batch\w*|-free|@eu|@us|-latest|:nitro|:floor|:thinking)$/i;
function siblings(p, x) {
  const map = idsOf.get(p) ?? new Map(); const xl = x.toLowerCase(); const out = [];
  const nx = norm(x), xs = x.replace(SUFFIX, "").toLowerCase();
  for (const [yl, y] of map) {
    if (yl === xl) continue;
    if (yl.endsWith("/" + xl)) out.push({ y, type: "org-prefixed-sibling" });
    else if (xl.includes("/") && yl === xl.split("/").pop()) out.push({ y, type: "bare-sibling" });
    else if (norm(y) === nx) out.push({ y, type: "punctuation-or-case" });
    else if (xs !== xl && (yl === xs)) out.push({ y, type: "suffix-stripped" });
  }
  return out;
}
const listedNorm = new Map(); for (const [p, d] of disc) listedNorm.set(p, new Set([...d.ids].map(normListId)));
// ids that name a non-chat model (embedding, rerank, speech, image, video, realtime...). Used only as SECONDARY evidence next to a message.
const NONCHAT_ID = /embed|rerank|(^|[-/_.])tts([-/_.]|$)|(^|[-/_.])asr([-/_.]|$)|transcri|whisper|speech|imagen|image|(^|[-/_.])wan\d|video|(^|[-/_.])veo([-/_.]|$)|voyage|audio|realtime|-live|live-|(^|[-/_.])ocr([-/_.]|$)|moderation|guard|classif|diarize|caption|(^|[-/_.])flux|sdxl|diffusion|dall-?e|lyria|(^|[-/_.])aqa([-/_.]|$)|mamba/i;
const evOk = (key) => [bench[key], before[key], first[key]].some((r) => r && r.s === "ok");
const evAnswered = (key) => [bench[key], before[key], first[key]].some((r) => r && (r.s === "ok" || r.s === "empty"));
const bareOf = (key) => norm(key.slice(key.indexOf("/") + 1).split("/").pop());
const okBare = new Map();                             // normalized last-segment -> Set(providers) with an ok route
for (const r of rows) if (r.rec.s === "ok") { const b = bareOf(r.key); if (!okBare.has(b)) okBare.set(b, new Set()); okBare.get(b).add(r.provider); }

const EXPLICIT_GONE = new Set(["gone:model-does-not-exist", "gone:model-not-found", "gone:not-found(generic)", "gone:decommissioned-or-deprecated",
  "gone:invalid-or-unsupported-model-name", "gone:no-endpoints-or-unavailable"]);
const AMBIG = /do not have access|not have access|or you do/i;

for (const r of rows) {
  const rec = r.rec; r.status = rec.s; r.text = textOf(rec); r.fullMsg = !!rec.m; r.cause = cluster(rec.s, r.text);
  // openai and groq word this "The model `x` does not exist or you do not have access to it."; a legacy record keeps only the
  // first 40 characters, so the tail that makes it ambiguous is cut off: treat that prefix as ambiguous too.
  const legacyTruncatedModelSentence = r.legacy && !r.rec.m && /: the model `/i.test(r.text) && !/decommission|deprecat|retired|removed/i.test(r.text);
  if (r.status === "gone" && r.cause === "gone:model-does-not-exist" && (AMBIG.test(r.text) || legacyTruncatedModelSentence)) r.cause = "gone:does-not-exist-OR-no-access(ambiguous)";
  // an id ending in :batch is a batch-API twin of a chat model, whatever the provider's sentence says
  r.isBatch = /:batch/i.test(strip(r.id));
  if (r.status === "gone" && r.isBatch) r.cause = "gone:batch-variant-not-chat";
  r.batchBaseOk = r.isBatch && bench[`${r.provider}/${strip(r.id).replace(/:batch\w*$/i, "")}`]?.s === "ok";
  // REV2: an uninformative error sentence on an id that names a non-chat model is "non-chat?" (weaker than a sentence that says so)
  if (r.status === "error" && (r.cause === "error:model-rejects-request-shape" || r.cause === "error:opaque-upstream-failure") && NONCHAT_ID.test(strip(r.id))) r.cause = "error:non-chat-by-id(message-uninformative)";
  if (r.status === "error" && r.cause === "error:no-text-output(non-chat-or-budget)" && NONCHAT_ID.test(strip(r.id))) r.cause = "error:non-chat-by-message";
  r.everOk = evOk(r.key); r.everAnswered = evAnswered(r.key);
  r.listedExact = !!disc.get(r.provider)?.ids.has(strip(r.id));                 // old check (exact id): prefix- and suffix-blind
  r.listed = !!listedNorm.get(r.provider)?.has(normListId(r.id));               // REV2: normalised (`models/` prefix, [1m] suffix, case)
  r.provAdj = r.prov === "catalogue-only" && r.listed ? "listing-verified(by normalised id)" : r.prov;
  r.nonChatId = NONCHAT_ID.test(strip(r.id));
  r.sibs = r.status === "ok" ? [] : siblings(r.provider, strip(r.id)).map((s) => ({ ...s, ok: bench[`${r.provider}/${s.y}`]?.s === "ok" }));
  r.sibOk = r.sibs.some((s) => s.ok);
  // batch twin of an ok model: not a spelling problem, and not fixable (a batch id is not a chat route)
  r.sibKind = !r.sibOk ? "" : r.isBatch ? "batch-twin" : r.sibs.some((s) => s.ok && s.type === "punctuation-or-case") ? "spelling" : r.sibs.some((s) => s.ok && s.type === "suffix-stripped") ? "variant-suffix" : "prefix";
  r.fixableSib = r.sibOk && !r.isBatch;
  r.crossOk = r.status === "ok" ? false : (okBare.get(bareOf(r.key))?.size ?? 0) > 0 && ![...(okBare.get(bareOf(r.key)) ?? [])].every((p) => p === r.provider);
}

// ----------------------------------------------------- proposed action
const LABEL = {
  "pay:insufficient-balance": "needs top-up", "pay:model-locked-until-purchase": "locked until purchase", "pay:model-needs-minimum-balance": "needs min balance",
  "pay:plan-or-premium-gated": "plan-gated", "pay:gift-or-promo-balance-cannot-cover-model": "needs cash balance", "pay:daily-check-in-required": "daily check-in",
  "pay:402-opaque-upstream-message": "payment/plan? (opaque)", "pay:deposit-required": "deposit required", "pay:other": "payment/plan",
  "pay:MISCLASSIFIED-realtime-model(not-a-balance-issue)": "non-chat (realtime)",
  "auth:client-restricted": "restricted client", "auth:model-opt-in-required(Labs)": "opt-in required", "auth:bad-or-inactive-key": "bad key",
  "auth:aggregator-model-access-denied-or-offline": "no access/offline", "auth:plan-or-consent-restricted-model": "plan/consent required",
  "auth:access-denied(alibaba-region-or-model)": "access denied", "auth:opaque-upstream-message": "auth? (opaque)", "auth:other": "auth",
  "rate:quota-exhausted(free-tier-or-daily)": "quota exhausted", "rate:rate-limited(momentary)": "rate-limited",
  "rate:MISCLASSIFIED-really-pay(insufficient-credits)": "needs top-up", "rate:MISCLASSIFIED-free-access-not-enabled(account-gate)": "free access not enabled",
  "rate:provider-error(unspecific)": "provider error",
};
// Verdict visible: the stored sentence itself carries a not-found / removed / invalid wording (a 40-character legacy snippet that
// only matches by provider style, e.g. google's `models/` prefix, does NOT count).
const VERDICT_VISIBLE = /archived|not exist|does not|not found|not a valid|invalid model|unsupported model|unknown model|no endpoints|decommission|deprecated|retired|removed|was remov|no available|no longer|is not supported|couldn'?t find|requested model is not valid/i;
// A gone row is a remove candidate only if ALL hold (REV2: listing check normalised, verdict must be visible, id must not look non-chat)
const removeCandidate = (r) => r.status === "gone" && EXPLICIT_GONE.has(r.cause) && r.prov === "catalogue-only" && !r.listed && VERDICT_VISIBLE.test(r.text)
  && !r.nonChatId && !r.everAnswered && !r.fixableSib && !r.isBatch;
function action(r) {
  const c = r.cause, s = r.status;
  if (s === "ok") return "keep";
  if (s === "empty") return c === "empty:budget-spent-on-hidden-reasoning" ? "re-probe first (max_tokens>=1024); keep, label 'reasoning-heavy' if it then answers" : "re-probe first; keep";
  if (s === "pay") return `label: ${LABEL[c] ?? "payment/plan"}; keep in picker (state)`;
  if (s === "auth") return `label: ${LABEL[c] ?? "auth"}; keep in picker (state)`;
  if (s === "rate") return `re-probe first; then label: ${LABEL[c] ?? "rate-limited"}; keep`;
  if (s === "timeout") return "re-probe first; keep (label 'slow/timeout' only if it repeats)";
  if (s === "error") {
    if (c.startsWith("error:fetch-failed")) return "re-probe first (gateway/local fetch failure, not model state); no label";
    if (c === "error:non-chat-by-message") return "hide behind filter (provider's own sentence says non-chat); reversible, model row kept in data";
    if (c.startsWith("error:non-chat-by-id")) return "label: 'non-chat?' (message uninformative, id names a non-chat model); re-probe once; reclassify outputKind only if it repeats";
    if (c === "error:chat-needs-other-route") return "label: 'needs other route' (Anthropic Messages / Interactions API); keep; probe through that route";
    if (c === "error:chat-no-streaming") return "label: 'no streaming'; keep; re-probe with a non-streaming request";
    if (c.startsWith("error:chat-entitlement")) return "label: 'not activated' (entitlement); keep (state)";
    if (c.startsWith("error:no-text-output")) return "re-probe first (larger max_tokens); label 'no text in budget' if it repeats; do not hide";
    if (c.startsWith("error:upstream-overloaded")) return "re-probe first; keep";
    if (c.startsWith("error:model-rejects")) return "re-probe with model-specific request (may need list-content or params); label 'rejects plain chat'";
    if (c.startsWith("error:model-unavailable")) return "re-probe first; label 'not served (upstream)' if it repeats; keep";
    return "re-probe first; label 'unavailable (upstream)' if it repeats; keep";
  }
  if (s === "gone") {
    if (r.everAnswered) return "keep: ever answered in a bench file; label 'not found now' and re-probe";
    if (c === "gone:batch-variant-not-chat") return r.batchBaseOk ? "hide behind filter (batch-API twin; the base id answers ok)" : "label: 'batch-only'; keep (no ok chat twin)";
    if (c === "gone:non-chat-by-message") return "hide behind filter (provider's own sentence says non-chat); reversible";
    if (c.startsWith("gone:not-a-chat-model")) return "label: 'needs Responses API?'; re-probe through the Responses route; do not hide";
    if (c.startsWith("gone:no-longer-available-to-new-users")) return "label: 'restricted (new users)'; keep (account state, not gone)";
    if (c.startsWith("gone:no-channel-for-account-group")) return "label: 'no channel for account'; keep (entitlement)";
    if (c.startsWith("gone:google-models-prefix")) return "label: 'not found or not for generateContent'; re-probe first (store the full sentence)";
    if (r.fixableSib) return `fix first: same provider has an ok sibling (${r.sibKind}); dedupe/alias to it, then hide this id`;
    if (removeCandidate(r)) return r.legacy ? "REMOVE candidate (explicit not-found, catalogue-only, not in listing, never answered) - re-probe once first (legacy record)" : "REMOVE candidate (explicit not-found, catalogue-only, not in listing, never answered)";
    if (EXPLICIT_GONE.has(c) && r.prov === "catalogue-only" && !r.listed && r.nonChatId) return "hide behind filter (id looks non-chat; the model may exist, so not 'gone'); re-probe once";
    if (EXPLICIT_GONE.has(c) && r.prov === "catalogue-only" && !r.listed && !VERDICT_VISIBLE.test(r.text)) return "label: 'not found?'; re-probe first (stored snippet shows no verdict; store the full sentence)";
    if (r.listed) return "label: 'listed but 404' ; re-probe first (provider lists it)";
    if (c === "gone:404-opaque-upstream-message" || c === "gone:404-provider-not-found(no-detail)" || c === "gone:unspecific-message" || c === "gone:other") return "label: 'unreachable (404)'; re-probe first; no removal (message not explicit)";
    if (r.prov === "config-asserted") return "keep: named by our own config; label 'not found'";
    return "label: 'not found'; re-probe first (explicit message but provenance not catalogue-only, or ambiguous wording)";
  }
  return "";
}
for (const r of rows) r.action = action(r);

// ------------------------------------------------------- aggregates
const D = { meta: {}, pop: {}, prov: [], ok: {}, perf: {}, causes: {}, siblings: {}, pay: {}, proposal: {} };
D.meta = {
  benchGeneratedAt: benchFile.generatedAt, snapshotGeneratedAt: snap.generatedAt, snapshotRoutableAsOf: snap.routableAsOf, snapshotDiscoveredAsOf: snap.discoveredAsOf,
  snapshotBenchAsOf: snap.benchAsOf, snapshotBuiltAt: snap.builtAt, schemaVersion: snap.schemaVersion,
  beforeProbeAllGeneratedAt: readJson(path.join(H, ".uw/state/bench.before-probe-all.json")).generatedAt, firstSweepGeneratedAt: readJson(path.join(H, ".uw/state/bench.first-sweep.json")).generatedAt,
  earliestRecord: iso(Math.min(...Object.values(bench).map((r) => r.a))), latestRecord: iso(Math.max(...Object.values(bench).map((r) => r.a))),
  lastRunStartApprox: iso(LAST_RUN_START_S), benchKeys: Object.keys(bench).length,
};
const kinds = {}; for (const r of all) inc(kinds, r.outputKind);
D.pop = {
  routes: all.length, uniqueKeys: new Set(all.map((r) => r.key)).size, nonChat: all.length - rows.length, eligible: rows.length, eligibleKeys: new Set(rows.map((r) => r.key)).size,
  outputKind: kinds, probedFresh: rows.filter((r) => r.probed).length, pending: rows.filter((r) => !r.probed).length,
  legacyRecords: rows.filter((r) => r.legacy).length, currentRunRecords: rows.filter((r) => !r.legacy).length,
  status: Object.fromEntries(STATUS.map((s) => [s, rows.filter((r) => r.status === s).length])),
  statusLegacy: Object.fromEntries(STATUS.map((s) => [s, rows.filter((r) => r.status === s && r.legacy).length])),
  hasM: rows.filter((r) => r.rec.m).length, nonOk: rows.filter((r) => r.status !== "ok").length,
  nonOkNoM: rows.filter((r) => r.status !== "ok" && !r.rec.m).length, m1Routes: all.filter((r) => r.m1).length,
};

// per provider
const provNames = snap.rows.map((r) => r.provider);
const perProv = {};
for (const p of provNames) {
  const all_p = all.filter((r) => r.provider === p), el = all_p.filter((r) => r.eligible);
  const c = Object.fromEntries(STATUS.map((s) => [s, el.filter((r) => r.status === s).length]));
  const answers = c.ok + c.empty; const probed = el.filter((r) => r.probed).length;
  const t = el.filter((r) => r.status === "ok" && Number.isFinite(r.rec.t)).map((r) => r.rec.t);
  const tps = el.filter((r) => r.status === "ok" && Number.isFinite(r.rec.r)).map((r) => r.rec.r);
  let verdict;
  if (probed === 0) verdict = "no-probed-rows";
  else if (answers === 0 && el.every((r) => ["auth", "error", "timeout", "gone"].includes(r.status))) verdict = "dead (nothing answered; all auth/error/timeout/gone)";
  else if (answers === 0 && el.every((r) => r.status === "pay")) verdict = "needs-money (every row pay)";
  else if (answers === 0) verdict = "no-answer (mixed pay/auth/gone/error)";
  else if (c.ok / probed >= 0.5) verdict = "healthy (ok-rate >= 50%)";
  else if (c.ok / probed >= 0.1) verdict = "partial (ok-rate 10-50%)";
  else verdict = "mostly-blocked (ok-rate < 10%, but answers)";
  const el2 = el.filter((r) => !r.cause.startsWith("error:fetch-failed"));
  const dead2 = el2.length > 0 && c.ok + c.empty === 0 && el2.every((r) => ["auth", "error", "timeout", "gone"].includes(r.status));
  const money2 = el2.length > 0 && c.ok + c.empty === 0 && el2.every((r) => r.status === "pay");
  const verdictAdj = probed === 0 ? "no-probed-rows" : dead2 ? "dead" : money2 ? "needs-money" : answers === 0 ? "no-answer (mixed)" : verdict.split(" ")[0];
  const causeCounts = {}; for (const r of el) if (r.status !== "ok") inc(causeCounts, r.cause);
  const topCause = Object.entries(causeCounts).sort((x, y) => y[1] - x[1])[0];
  const dominant = topCause ? topCause[0] + " (" + topCause[1] + ")" : "";
  const row = snap.rows.find((r) => r.provider === p);
  perProv[p] = { provider: p, keyId: row.keyId, routes: all_p.length, nonChat: all_p.length - el.length, eligible: el.length, probed, pending: el.length - probed, ...c, okRate: probed ? c.ok / probed : null,
    answerRate: probed ? answers / probed : null, verdict, verdictAdj, dominant, legacy: el.filter((r) => r.legacy).length, catalogueOnly: el.filter((r) => r.prov === "catalogue-only").length,
    discoveryOutcome: disc.get(p) ? `${disc.get(p).status}/${disc.get(p).outcome}/${disc.get(p).count}` : "none", medTtft: q(t, 0.5), medTps: q(tps, 0.5), free: row.free, planCount: row.planCount, health: row.health };
}
D.prov = Object.values(perProv);

// ---------------------------------------------------- what works
const ok = rows.filter((r) => r.status === "ok");
const grp = (arr, f) => { const o = {}; for (const r of arr) inc(o, f(r)); return o; };
const band = (c) => (c == null ? "unknown" : c <= 8192 ? "<=8k" : c <= 32768 ? "8k-32k" : c <= 131072 ? "32k-128k" : c <= 262144 ? "128k-256k" : c <= 1048576 ? "256k-1M" : ">1M");
D.ok = {
  n: ok.length, byBadge: grp(ok, (r) => r.badge || "(blank)"), byProv: grp(ok, (r) => r.prov), byBand: grp(ok, (r) => band(r.ctx)),
  eligByBadge: grp(rows, (r) => r.badge || "(blank)"), eligByProv: grp(rows, (r) => r.prov), eligByBand: grp(rows, (r) => band(r.ctx)),
  tools: ok.filter((r) => r.tools).length, vision: ok.filter((r) => r.vision).length, reason: ok.filter((r) => r.reason).length,
  eligTools: rows.filter((r) => r.tools).length, eligVision: rows.filter((r) => r.vision).length, eligReason: rows.filter((r) => r.reason).length,
  previewIsReasoning: ok.filter((r) => r.rec.k === 1).length, legacy: ok.filter((r) => r.legacy).length,
  byOutputKind: grp(ok, (r) => r.outputKind), eligByOutputKind: grp(rows, (r) => r.outputKind),
  okByBadgeRate: null,
};
const dist = (vals) => ({ n: vals.length, p10: q(vals, 0.1), median: q(vals, 0.5), p90: q(vals, 0.9), min: q(vals, 0), max: q(vals, 1) });
const tt = ok.filter((r) => Number.isFinite(r.rec.t)), tp = ok.filter((r) => Number.isFinite(r.rec.r));
// REV2: two populations that must never be mixed. burst = the whole answer arrived at once (d - t <= 50 ms): `t` is time to WHOLE answer.
// streamed = text arrived incrementally: `t` is time to first token.
const isBurst = (r) => r.rec.d - r.rec.t <= 50;
const okBurst = ok.filter((r) => Number.isFinite(r.rec.t) && isBurst(r)), okStream = ok.filter((r) => Number.isFinite(r.rec.t) && !isBurst(r));
D.perf = {
  ttftMixedAll: dist(tt.map((r) => r.rec.t)), total: dist(ok.filter((r) => Number.isFinite(r.rec.d)).map((r) => r.rec.d)), tps: dist(tp.map((r) => r.rec.r)),
  burst: { n: okBurst.length, timeToWholeAnswer: dist(okBurst.map((r) => r.rec.t)), legacy: dist(okBurst.filter((r) => r.legacy).map((r) => r.rec.t)), current: dist(okBurst.filter((r) => !r.legacy).map((r) => r.rec.t)) },
  streamed: { n: okStream.length, ttft: dist(okStream.map((r) => r.rec.t)), total: dist(okStream.map((r) => r.rec.d)), legacy: dist(okStream.filter((r) => r.legacy).map((r) => r.rec.t)), current: dist(okStream.filter((r) => !r.legacy).map((r) => r.rec.t)) },
  tpsNull: ok.filter((r) => !Number.isFinite(r.rec.r)).length, tpsNullLowTokens: ok.filter((r) => !Number.isFinite(r.rec.r) && Number.isFinite(r.rec.o) && r.rec.o < 8).length,
  tpsNullNoO: ok.filter((r) => !Number.isFinite(r.rec.r) && !Number.isFinite(r.rec.o)).length,
  ttftLegacy: dist(tt.filter((r) => r.legacy).map((r) => r.rec.t)), ttftCurrent: dist(tt.filter((r) => !r.legacy).map((r) => r.rec.t)),
  ttftReasoningPreview: dist(tt.filter((r) => r.rec.k === 1).map((r) => r.rec.t)), ttftAnswerPreview: dist(tt.filter((r) => r.rec.k !== 1).map((r) => r.rec.t)),
};
D.perf.currentVsLegacyMedianRatio = D.perf.ttftCurrent.median / D.perf.ttftLegacy.median;
const pick = (r) => ({ key: r.key, badge: r.badge, t: r.rec.t, d: r.rec.d, r: r.rec.r, o: r.rec.o, k: r.rec.k, reason: r.reason, legacy: r.legacy });
const answerStream = okStream.filter((r) => r.rec.k !== 1), answerBurst = okBurst.filter((r) => r.rec.k !== 1);
D.perf.fastestStreamedTtft25 = [...answerStream].sort((a, b) => a.rec.t - b.rec.t).slice(0, 25).map(pick);
D.perf.slowestStreamedTtft25 = [...okStream].sort((a, b) => b.rec.t - a.rec.t).slice(0, 25).map(pick);
D.perf.fastestBurstTotal25 = [...answerBurst].sort((a, b) => a.rec.t - b.rec.t).slice(0, 25).map(pick);
D.perf.slowestBurstTotal25 = [...okBurst].sort((a, b) => b.rec.t - a.rec.t).slice(0, 25).map(pick);
D.perf.fastestTps25 = [...tp].filter((r) => r.rec.o >= 20).sort((a, b) => b.rec.r - a.rec.r).slice(0, 25).map(pick);
D.perf.slowestTps25 = [...tp].filter((r) => r.rec.o >= 20).sort((a, b) => a.rec.r - b.rec.r).slice(0, 25).map(pick);
D.perf.perProvider = D.prov.filter((p) => p.ok > 0).map((p) => {
  const st = okStream.filter((r) => r.provider === p.provider), bu = okBurst.filter((r) => r.provider === p.provider), rs = ok.filter((r) => r.provider === p.provider);
  return { provider: p.provider, n: rs.length, streamedN: st.length, ttftStreamed: dist(st.map((r) => r.rec.t)), burstN: bu.length, totalBurst: dist(bu.map((r) => r.rec.t)),
    legacyShare: rs.filter((r) => r.legacy).length / rs.length, tps: dist(rs.filter((r) => Number.isFinite(r.rec.r)).map((r) => r.rec.r)) };
});
// empty group
const em = rows.filter((r) => r.status === "empty");
D.empty = {
  n: em.length, hidden: em.filter((r) => r.cause === "empty:budget-spent-on-hidden-reasoning").length, legacyNoMsg: em.filter((r) => r.cause === "empty:legacy-no-message").length,
  endTurn: em.filter((r) => r.cause === "empty:stream-ended-no-content").length, oPositive: em.filter((r) => r.rec.o > 0).length, o96plus: em.filter((r) => r.rec.o >= 90).length,
  o64: em.filter((r) => r.rec.o === 64).length, oZeroOrNull: em.filter((r) => !(r.rec.o > 0)).length, byProv: grp(em, (r) => r.provider),
  reasonFlag: em.filter((r) => r.reason).length, sample: em.slice(0, 5).map((r) => ({ key: r.key, o: r.rec.o, cause: r.cause, reason: r.reason })),
};

// ----------------------------------------------------- causes
const nonok = rows.filter((r) => r.status !== "ok");
const byCause = {};
for (const r of nonok) { (byCause[r.cause] ??= []).push(r); }
D.causes = Object.entries(byCause).map(([cause, rs]) => ({
  cause, status: rs[0].status, n: rs.length, legacy: rs.filter((r) => r.legacy).length, prov: grp(rs, (r) => r.prov), providers: grp(rs, (r) => r.provider),
  everOk: rs.filter((r) => r.everOk).length, everAnswered: rs.filter((r) => r.everAnswered).length, sibOk: rs.filter((r) => r.sibOk).length, listed: rs.filter((r) => r.listed).length,
  crossOk: rs.filter((r) => r.crossOk).length,
  examples: (() => { const seen = new Set(), out = []; for (const r of rs) { if (seen.has(r.provider) && out.length >= 1 && rs.length > 3) continue; seen.add(r.provider); out.push(`${r.key}`); if (out.length >= 3) break; } if (out.length < 3) for (const r of rs) { if (!out.includes(r.key)) out.push(r.key); if (out.length >= 3) break; } return out; })(),
  sampleMsg: rs[0].text.slice(0, 120),
})).sort((a, b) => a.status.localeCompare(b.status) || b.n - a.n);
D.statusByProvider = {};
for (const s of STATUS) D.statusByProvider[s] = Object.fromEntries(D.prov.filter((p) => p[s] > 0).sort((a, b) => b[s] - a[s]).map((p) => [p.provider, p[s]]));

// misclassification candidates
const mis = [];
const add = (kind, filter, note) => { const rs = nonok.filter(filter); mis.push({ kind, note, n: rs.length, providers: grp(rs, (r) => r.provider), examples: rs.slice(0, 3).map((r) => r.key + " | " + r.text.slice(0, 90)) }); };
add("rate -> really pay", (r) => r.cause.startsWith("rate:MISCLASSIFIED-really-pay"), "429 carrying 'Insufficient credits'; classifyHttp checks QUOTA before the status");
add("rate -> account gate", (r) => r.cause.startsWith("rate:MISCLASSIFIED-free-access"), "orcarouter 'Free models are not available to this account yet' is an entitlement, not a rate limit");
add("rate -> quota (state, not momentary)", (r) => r.cause.startsWith("rate:quota-exhausted"), "google 'exceeded your current quota' / aihubmix 'limit of the free model quota': a quota is state, retrying now will not help");
add("error -> non-chat by the provider's own sentence (hide behind filter)", (r) => r.cause === "error:non-chat-by-message", "audio/video/image/realtime/decision/ASR/TTS models rejected on a chat request");
add("error -> non-chat by id only (message uninformative: label 'non-chat?')", (r) => r.cause.startsWith("error:non-chat-by-id"), "the sentence says nothing; only the id names a non-chat model");
add("error -> chat model that needs another route / no streaming / not activated (label, never hide)", (r) => r.cause === "error:chat-needs-other-route" || r.cause === "error:chat-no-streaming" || r.cause.startsWith("error:chat-entitlement"), "commandcode Claude ids via /provider/v1/messages, infron gpt-5.5-pro no streaming, alibaba kimi-k3 product not activated");
add("error -> no text output (chat model with no text inside the budget, or non-chat)", (r) => r.cause.startsWith("error:no-text-output"), "alibaba/google 'response does not contain text output': re-probe with a larger budget");
add("gone -> batch twin, base id ok (hide), or batch-only (label)", (r) => r.cause === "gone:batch-variant-not-chat", ":batch ids; 4 :batch routes answered ok and are NOT in this row (status ok)");
add("gone -> non-chat by the provider's own sentence (openai Responses API, zenmux /v1/chat/completions)", (r) => r.cause === "gone:non-chat-by-message", "explicit non-chat text that used to read 'listed but 404'");
add("gone -> 'not a chat model' (aihubmix): Responses-API-only chat models", (r) => r.cause.startsWith("gone:not-a-chat-model"), "gpt-5.5-pro, gpt-5.2-pro, o3-pro");
add("gone -> google 'new users' restriction or group entitlement (account state)", (r) => r.cause.startsWith("gone:no-longer-available-to-new-users") || r.cause.startsWith("gone:no-channel-for-account-group"), "state, not gone");
add("gone -> google `models/x` (not found OR not supported for generateContent)", (r) => r.cause.startsWith("gone:google-models-prefix"), "verdict not visible in the stored snippet; full sentence is ambiguous");
add("pay -> non-chat (realtime)", (r) => r.cause.startsWith("pay:MISCLASSIFIED-realtime"), "alibaba qwen3-s2s-flash-realtime: 'There are no suitable clusters.'");
add("pay opaque (402 with 'Upstream request failed.')", (r) => r.cause === "pay:402-opaque-upstream-message", "status code says pay but the message says nothing: cause unverified (balance/plan/other)");
add("auth opaque ('Upstream request failed.' on 401/403)", (r) => r.cause === "auth:opaque-upstream-message", "cloudflare/kktoken/justdowork: gateway hides the provider message");
add("gone opaque (404 'Upstream request failed.')", (r) => r.cause === "gone:404-opaque-upstream-message", "nvidia/cloudflare: 404 with no reason; NVIDIA lists these org-prefixed ids yet 404s them");
add("auth -> really gone/no-access ('does not exist or you do not have access')", (r) => r.cause === "auth:aggregator-model-access-denied-or-offline", "aihubmix uses 401/403 for missing/offline/disabled models");
add("gone -> really no-access (openai 'does not exist or you do not have access')", (r) => r.cause.startsWith("gone:does-not-exist-OR-no-access"), "ambiguous: could be an entitlement (auth-like) rather than removal");
add("gone with an ok sibling in same provider (spelling/variant-suffix/prefix), excluding :batch twins", (r) => r.status === "gone" && r.fixableSib, "");
add("gone :batch twin of an ok model", (r) => r.status === "gone" && r.isBatch && r.sibOk, "batch-API id, not a chat route");
add("gone but the provider's own listing names the id", (r) => r.status === "gone" && r.listed, "listing-verified yet 404: routing/entitlement, not removal");
add("error -> really gone (message says model unavailable/not served)", (r) => r.cause === "error:model-unavailable-or-not-served", "'cannot be served at the moment', 'Model is unavailable', 'No available providers'");
add("error 'fetch failed' (probe artefact, not model state)", (r) => r.cause.startsWith("error:fetch-failed"), "no HTTP response reached us: gateway/local network; present all run, densest 13:10-13:50Z");
add("timeout with first token (slow, not dead)", (r) => r.status === "timeout" && Number.isFinite(r.rec.t), "");
D.mis = mis;

// ------------------------------------------------ fixable (siblings)
const gone = rows.filter((r) => r.status === "gone");
const sibTypes = {};
for (const r of gone) for (const t of new Set(r.sibs.filter((s) => s.ok).map((s) => s.type))) inc(sibTypes, t);
D.siblings = {
  goneN: gone.length, withAnySibling: gone.filter((r) => r.sibs.length).length, withOkSibling: gone.filter((r) => r.sibOk).length, sibTypesOk: sibTypes,
  crossProviderOk: gone.filter((r) => r.crossOk).length,
  kinds: grp(gone.filter((r) => r.sibOk), (r) => r.sibKind), fixable: gone.filter((r) => r.fixableSib).length,
  fixableByProvider: grp(gone.filter((r) => r.fixableSib), (r) => r.provider),
  batchAll: gone.filter((r) => r.isBatch).length, batchAllStatuses: grp(rows.filter((r) => r.isBatch), (r) => r.status), batchTotal: rows.filter((r) => r.isBatch).length,
  byProvider: grp(gone.filter((r) => r.sibOk), (r) => r.provider),
  pairs: gone.filter((r) => r.sibOk).map((r) => ({ provider: r.provider, gone: strip(r.id), ok: r.sibs.filter((s) => s.ok).map((s) => `${s.y} [${s.type}]`), cause: r.cause, prov: r.prov })),
  anySibNotOk: gone.filter((r) => r.sibs.length && !r.sibOk).length,
  errorWithOkSibling: rows.filter((r) => r.status === "error" && r.sibOk).length,
  nvidia: (() => { const nv = gone.filter((r) => r.provider === "nvidia"); return { n: nv.length, listed: nv.filter((r) => r.listed).length, catalogueOnly: nv.filter((r) => r.prov === "catalogue-only").length, orgSibling: nv.filter((r) => r.sibs.some((s) => s.type === "org-prefixed-sibling")).length, orgSiblingOk: nv.filter((r) => r.sibs.some((s) => s.type === "org-prefixed-sibling" && s.ok)).length, bareNoSlash: nv.filter((r) => !r.id.includes("/")).length }; })(),
  goneListedByProv: grp(gone.filter((r) => r.listed), (r) => r.prov), goneByProv: grp(gone, (r) => r.prov),
  goneListedByProvider: grp(gone.filter((r) => r.listed), (r) => r.provider),
};

// ------------------------------------------------ pay / funding
const pay = rows.filter((r) => r.status === "pay");
D.pay = {
  n: pay.length,
  byProvider: D.prov.filter((p) => p.pay > 0).map((p) => {
    const rs = pay.filter((r) => r.provider === p.provider);
    return { provider: p.provider, pay: p.pay, probed: p.probed, ok: p.ok, freeRoutesPay: rs.filter((r) => r.badge === "FREE" || r.badge === "FREE?").length,
      causes: grp(rs, (r) => r.cause.replace(/^pay:/, "")), partial: p.ok > 0, payShare: p.pay / p.probed, badgePay: grp(rs, (r) => r.badge || "(blank)") };
  }).sort((a, b) => b.pay - a.pay),
  freeBadgePay: pay.filter((r) => r.badge === "FREE").length, freeQBadgePay: pay.filter((r) => r.badge === "FREE?").length,
  byBadge: grp(pay, (r) => r.badge || "(blank)"),
};
const auth = rows.filter((r) => r.status === "auth");
D.auth = { n: auth.length, byProvider: grp(auth, (r) => r.provider) };

// -------------------------------------------------- proposal
const actClass = (a) => (a === "keep" ? "keep" : a.startsWith("REMOVE") ? "remove-candidate" : a.startsWith("label") ? "label" : a.startsWith("hide") ? "hide-filter" : a.startsWith("fix first") ? "fix-first" : a.startsWith("re-probe") ? "re-probe-first" : "keep+label(other)");
D.labelMap = LABEL;
D.proposal.byCause = D.causes.map((c) => {
  const rs = byCause[c.cause];
  return { cause: c.cause, status: c.status, n: c.n, legacy: c.legacy, prov: c.prov, everAnswered: c.everAnswered, sibOk: c.sibOk, listed: c.listed,
    actions: grp(rs, (r) => r.action), classes: grp(rs, (r) => actClass(r.action)), byProvider: c.providers };
});
const removal = gone.filter((r) => r.action.startsWith("REMOVE"));
const goneExplicit = gone.filter((r) => EXPLICIT_GONE.has(r.cause) || r.cause.startsWith("gone:does-not-exist-OR"));
// funnel, each step applied to what the previous step left
const fun = []; let cur = gone;
const step = (name, keep) => { const before = cur.length; cur = cur.filter(keep); fun.push({ name, remaining: cur.length, dropped: before - cur.length }); };
step("explicit not-found / removed / invalid-model cause (incl. the ambiguous 'or you do not have access' wording)", (r) => EXPLICIT_GONE.has(r.cause) || r.cause.startsWith("gone:does-not-exist-OR"));
step("catalogue-only provenance (as stored in the snapshot)", (r) => r.prov === "catalogue-only");
step("NOT named by the provider's listing after normalising `models/` and `[1m]`", (r) => !r.listed);
step("not the ambiguous 'does not exist or you do not have access' wording", (r) => !r.cause.startsWith("gone:does-not-exist-OR"));
step("verdict visible in the stored sentence (not a 40-char snippet matched by provider style)", (r) => VERDICT_VISIBLE.test(r.text));
step("id does not name a non-chat model", (r) => !r.nonChatId);
step("no ok sibling id in the same provider (spelling / variant suffix)", (r) => !r.fixableSib);
step("never ok/empty in any of the 3 bench files", (r) => !r.everAnswered);
const probeTimes = (key, st) => [bench[key], before[key], first[key]].filter((x) => x && x.s !== "skip" && (!st || x.s === st)).map((x) => x.a);   // a `skip` is not a probe
const distinct = (a) => new Set(a).size;
const revPrev = new Set(JSON.parse(fs.readFileSync(path.join(OUT, "prev/rev1-remove-candidates.json"), "utf8")));
const candKeys = new Set(removal.map((r) => `${r.provider}/${r.id}`));
const diff = (A, B) => [...A].filter((k) => !B.has(k));
const byProv = (ks) => { const o = {}; for (const k of ks) inc(o, k.slice(0, k.indexOf("/"))); return o; };
const why = (k) => { const r = rows.find((x) => `${x.provider}/${x.id}` === k); return r ? `${r.cause} | ${r.action.split(";")[0].slice(0, 50)} | listed=${r.listed} nonChatId=${r.nonChatId} verdictVisible=${VERDICT_VISIBLE.test(r.text)}` : "(not an eligible route)"; };
D.proposal.removal = {
  goneN: gone.length, funnel: fun,
  explicitMsg: goneExplicit.length, explicitCatalogueOnly: goneExplicit.filter((r) => r.prov === "catalogue-only").length,
  explicitCatalogueOnlyEverAnswered: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.everAnswered).length,
  explicitCatalogueOnlyEverOk: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.everOk).length,
  explicitCatalogueOnlyAmbiguous: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.cause.startsWith("gone:does-not-exist-OR")).length,
  explicitCatalogueOnlySibOk: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.fixableSib).length,
  explicitCatalogueOnlyLegacy: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.legacy).length,
  explicitCatalogueOnlyCrossOk: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.crossOk).length,
  candidatesCrossOk: removal.filter((r) => r.crossOk).length,
  catalogueOnlyGoneNotCandidateByCause: grp(gone.filter((r) => r.prov === "catalogue-only" && !r.action.startsWith("REMOVE")), (r) => r.cause),
  candidates: removal.length, candidatesLegacy: removal.filter((r) => r.legacy).length, candidatesCurrent: removal.filter((r) => !r.legacy).length,
  candidatesByProvider: grp(removal, (r) => r.provider), candidatesByCause: grp(removal, (r) => r.cause),
  catalogueOnlyGone: gone.filter((r) => r.prov === "catalogue-only").length,
  catalogueOnlyGoneNotCandidate: gone.filter((r) => r.prov === "catalogue-only" && !r.action.startsWith("REMOVE")).length,
  catalogueOnlyGoneNotCandidateByAction: grp(gone.filter((r) => r.prov === "catalogue-only" && !r.action.startsWith("REMOVE")), (r) => r.action.split(";")[0].replace(/\(.*?\)/g, "").trim().slice(0, 70)),
  everOkExcluded: goneExplicit.filter((r) => r.prov === "catalogue-only" && r.everAnswered).map((r) => r.key),
  // evidence depth: every candidate rests on how many independent probe times / days?
  evidence: {
    candidates: removal.length,
    withTwoDistinctGoneProbeTimes: removal.filter((r) => distinct(probeTimes(r.key, "gone")) >= 2).length,
    withTwoDistinctProbeTimesAnyStatus: removal.filter((r) => distinct(probeTimes(r.key)) >= 2).length,
    withOneProbeTime: removal.filter((r) => distinct(probeTimes(r.key)) === 1).length,
    withEarlierErrorRecord: removal.filter((r) => [before[r.key], first[r.key]].some((x) => x && x.s === "error")).length,
    calendarDaysSpanned: new Set(removal.flatMap((r) => probeTimes(r.key).map((t) => iso(t).slice(0, 10)))).size,
    routesThatWentOkToNonOk: rows.filter((r) => [before[r.key], first[r.key]].some((x) => x && x.s === "ok") && r.status !== "ok").length,
  },
  // reconciliation: this build vs revision 1 (467) vs the independent critic's set (454)
  reconcile: {
    rev1: revPrev.size, now: candKeys.size,
    droppedSinceRev1: diff(revPrev, candKeys).length, droppedSinceRev1ByProvider: byProv(diff(revPrev, candKeys)),
    droppedSinceRev1Reasons: grp(diff(revPrev, candKeys).map((k) => ({ k })), (o) => why(o.k).split(" | ")[0] + " | " + why(o.k).split(" | ")[1]),
    addedSinceRev1: diff(candKeys, revPrev).length,
  },
};
// listing normalisation audit: which providers' catalogue-only routes are actually named by the listing once `models/` and `[1m]` are normalised
{
  const cat = rows.filter((r) => r.prov === "catalogue-only");
  D.listingAudit = {
    catalogueOnlyEligible: cat.length, namedAfterNormalisation: cat.filter((r) => r.listed).length, namedExact: cat.filter((r) => r.listedExact).length,
    byProvider: grp(cat.filter((r) => r.listed), (r) => r.provider), okAmongNamed: cat.filter((r) => r.listed && r.status === "ok").length,
    goneNamedAfterNormalisation: gone.filter((r) => r.listed).length, goneNamedExact: gone.filter((r) => r.listedExact).length,
    revCandidatesNowListed: [...revPrev].filter((k) => rows.some((r) => `${r.provider}/${r.id}` === k && r.listed)).map((k) => k),
    okCatalogueOnly: ok.filter((r) => r.prov === "catalogue-only").length, okCatalogueOnlyNotListed: ok.filter((r) => r.prov === "catalogue-only" && !r.listed).length,
    okCatalogueOnlyListedExamples: ok.filter((r) => r.prov === "catalogue-only" && r.listed).map((r) => r.key),
    okCatalogueOnlyNotListedByProvider: grp(ok.filter((r) => r.prov === "catalogue-only" && !r.listed), (r) => r.provider),
  };
}
const impact = {};
for (const p of provNames) impact[p] = { keep: 0, label: 0, hide: 0, remove: 0, reprobe: 0, fix: 0, other: 0 };
for (const r of rows) {
  const c = actClass(r.action), o = impact[r.provider];
  if (c === "keep") o.keep++; else if (c === "remove-candidate") o.remove++; else if (c === "label") o.label++; else if (c === "hide-filter") o.hide++;
  else if (c === "fix-first") o.fix++; else if (c === "re-probe-first") o.reprobe++; else o.other++;
}
D.proposal.impact = impact;
D.proposal.actionTotals = grp(rows, (r) => r.action);
D.proposal.actionClassTotals = grp(rows, (r) => actClass(r.action));

// ---- REV2 additions ----------------------------------------------------------------------------------------------------------
// (a) [1m] routes: how many have a separate bare-id sibling ROUTE in the same provider (i.e. would double-count a model)?
{
  const bareRoutes = new Set(all.map((r) => `${r.provider}/${r.id}`));
  const m1 = all.filter((r) => r.m1);
  D.m1 = { routes: m1.length, withBareSiblingRoute: m1.filter((r) => bareRoutes.has(`${r.provider}/${strip(r.id)}`)).length, eligibleRoutes: m1.filter((r) => r.eligible).length,
    withBareSiblingExamples: m1.filter((r) => bareRoutes.has(`${r.provider}/${strip(r.id)}`)).map((r) => `${r.provider}/${r.id}`) };
}
// (b) re-probe-worthy set: every route whose proposed action carries a re-probe instruction, split by what the PRIMARY action is
{
  const mention = rows.filter((r) => /re-probe/i.test(r.action));
  const cls = (r) => actClass(r.action);
  D.reprobe = { total: mention.length, primary: mention.filter((r) => cls(r) === "re-probe-first").length, labelAndReprobe: mention.filter((r) => cls(r) === "label").length,
    removeButReprobeOnce: mention.filter((r) => cls(r) === "remove-candidate").length, hideAndReprobe: mention.filter((r) => cls(r) === "hide-filter").length,
    other: mention.filter((r) => !["re-probe-first", "label", "remove-candidate", "hide-filter"].includes(cls(r))).length,
    primaryByCause: grp(mention.filter((r) => cls(r) === "re-probe-first"), (r) => r.cause), labelAndReprobeByCause: grp(mention.filter((r) => cls(r) === "label"), (r) => r.cause) };
}
// (c) snapshot benchFlags vs the report's provider verdicts
{
  const snapDead = snap.rows.filter((r) => r.benchFlags?.dead).map((r) => r.provider), snapMoney = snap.rows.filter((r) => r.benchFlags?.needsMoney).map((r) => r.provider);
  const myDead = D.prov.filter((p) => p.verdictAdj === "dead").map((p) => p.provider), myMoney = D.prov.filter((p) => p.verdictAdj === "needs-money").map((p) => p.provider);
  D.benchFlags = { snapDead, snapMoney, myDead, myMoney, deadOnlyMine: myDead.filter((p) => !snapDead.includes(p)), deadOnlySnap: snapDead.filter((p) => !myDead.includes(p)),
    moneyOnlyMine: myMoney.filter((p) => !snapMoney.includes(p)), moneyOnlySnap: snapMoney.filter((p) => !myMoney.includes(p)),
    deepseek: (() => { const p = D.prov.find((x) => x.provider === "deepseek"); return { pay: p.pay, error: p.error, probed: p.probed }; })() };
}
// (d) fetch failed: time clustering and same-second bursts
{
  const last = rows.filter((r) => !r.legacy), ffs = (r) => r.cause.startsWith("error:fetch-failed");
  const inW = (r) => r.rec.a >= Date.parse("2026-09-29T13:10:00Z") / 1000 && r.rec.a < Date.parse("2026-09-29T13:50:00Z") / 1000;
  const inside = last.filter(inW), outside = last.filter((r) => !inW(r));
  const ffTimes = rows.filter(ffs).map((r) => ({ a: r.rec.a, p: r.provider })).sort((x, y) => x.a - y.a);
  let bursts = 0, i = 0; const groups = [];
  while (i < ffTimes.length) { let j = i; while (j + 1 < ffTimes.length && ffTimes[j + 1].a - ffTimes[i].a <= 3) j++; const g = ffTimes.slice(i, j + 1); if (g.length >= 4 && new Set(g.map((x) => x.p)).size >= 3) { bursts++; groups.push(g.length); } i = j + 1; }
  const f1 = Object.values(first).filter((r) => r.s !== "skip");
  D.fetchFailed = { total: rows.filter(ffs).length, lastRunRecords: last.length, insideWindowRecords: inside.length, insideWindowFF: inside.filter(ffs).length, outsideWindowRecords: outside.length, outsideWindowFF: outside.filter(ffs).length,
    insideShare: inside.filter(ffs).length / inside.length, outsideShare: outside.filter(ffs).length / outside.length,
    sweep1Probes: f1.length, sweep1FF: f1.filter((r) => /fetch failed/i.test(r.p ?? "")).length, sweep1Share: f1.filter((r) => /fetch failed/i.test(r.p ?? "")).length / f1.length,
    sameSecondBursts: bursts, burstSizes: groups, providers: new Set(rows.filter(ffs).map((r) => r.provider)).size, immediateRefusal: rows.filter(ffs).filter((r) => r.rec.d < 100).length };
}
// (e) non-chat / batch: corrected split (REV2). Every row keeps its own status; only the message and the ok-twin evidence decide.
{
  const cnt = (f) => rows.filter(f).length;
  D.nonchat = {
    goneByMessage: cnt((r) => r.cause === "gone:non-chat-by-message"), goneByMessageByProvider: grp(rows.filter((r) => r.cause === "gone:non-chat-by-message"), (r) => r.provider),
    errorByMessage: cnt((r) => r.cause === "error:non-chat-by-message"), errorByMessageByProvider: grp(rows.filter((r) => r.cause === "error:non-chat-by-message"), (r) => r.provider),
    errorById: cnt((r) => r.cause.startsWith("error:non-chat-by-id")), errorByIdByProvider: grp(rows.filter((r) => r.cause.startsWith("error:non-chat-by-id")), (r) => r.provider),
    goneIdLooksNonChat: cnt((r) => r.status === "gone" && r.action.startsWith("hide behind filter (id looks non-chat")),
    batchGoneTotal: cnt((r) => r.cause === "gone:batch-variant-not-chat"), batchTwinBaseOk: cnt((r) => r.cause === "gone:batch-variant-not-chat" && r.batchBaseOk), batchOnly: cnt((r) => r.cause === "gone:batch-variant-not-chat" && !r.batchBaseOk),
    batchRoutesAll: cnt((r) => r.isBatch), batchRoutesOk: cnt((r) => r.isBatch && r.status === "ok"), batchOkKeys: rows.filter((r) => r.isBatch && r.status === "ok").map((r) => r.key),
    notAChatModel: cnt((r) => r.cause.startsWith("gone:not-a-chat-model")), notAChatModelIds: rows.filter((r) => r.cause.startsWith("gone:not-a-chat-model")).map((r) => r.key),
    chatNeedsOtherRoute: cnt((r) => r.cause === "error:chat-needs-other-route"), chatNoStreaming: cnt((r) => r.cause === "error:chat-no-streaming"), chatEntitlement: cnt((r) => r.cause.startsWith("error:chat-entitlement")),
    noTextOutput: cnt((r) => r.cause.startsWith("error:no-text-output")), noTextOutputIds: rows.filter((r) => r.cause.startsWith("error:no-text-output")).map((r) => r.key),
    chatOtherRouteIds: rows.filter((r) => ["error:chat-needs-other-route", "error:chat-no-streaming"].includes(r.cause) || r.cause.startsWith("error:chat-entitlement")).map((r) => r.key),
    googleNewUsers: cnt((r) => r.cause.startsWith("gone:no-longer-available-to-new-users")), groupEntitlement: cnt((r) => r.cause.startsWith("gone:no-channel-for-account-group")),
    rev1: { errorNonChat: 161, goneNonChatBatch: 175 },
  };
  D.nonchat.hiddenTotal = cnt((r) => r.action.startsWith("hide"));
  D.nonchat.hiddenByAction = grp(rows.filter((r) => r.action.startsWith("hide")), (r) => r.action.slice(0, 80));
  D.nonchat.newSplit = { hideByMessage: D.nonchat.goneByMessage + D.nonchat.errorByMessage, hideBatchTwin: D.nonchat.batchTwinBaseOk, hideIdLooksNonChat: D.nonchat.goneIdLooksNonChat,
    labelNonChatMaybe: D.nonchat.errorById, labelBatchOnly: D.nonchat.batchOnly, labelOtherRoute: D.nonchat.chatNeedsOtherRoute + D.nonchat.chatNoStreaming + D.nonchat.notAChatModel,
    labelEntitlement: D.nonchat.chatEntitlement + D.nonchat.googleNewUsers + D.nonchat.groupEntitlement, reprobeNoText: D.nonchat.noTextOutput };
}
// (f) retention: which date applies to what
D.retention = {
  ttlDays: 7, displayDays: 14,
  legacyDefaultReprobeFrom: iso(Math.min(...rows.filter((r) => r.legacy).map((r) => r.rec.a)) + 7 * 86400), legacyDefaultReprobeUntil: iso(Math.max(...rows.filter((r) => r.legacy).map((r) => r.rec.a)) + 7 * 86400),
  legacyTransient: rows.filter((r) => r.legacy && ["error", "rate", "timeout", "skip"].includes(r.status)).length,
  legacyStatuses: grp(rows.filter((r) => r.legacy), (r) => r.status),
};
// (g) top-up: pay routes the provider's own listing names (after normalisation) vs raw catalogue pay routes
for (const p of D.pay.byProvider) {
  const rs = pay.filter((r) => r.provider === p.provider);
  p.payNamed = rs.filter((r) => !(r.prov === "catalogue-only" && !r.listed)).length; p.payCatalogueOnly = rs.length - p.payNamed;
  p.listingCount = disc.get(p.provider)?.ids.size ?? null;
  const pv = D.prov.find((x) => x.provider === p.provider);
  const nonPayNonFF = pv.probed - p.pay - rows.filter((r) => r.provider === p.provider && r.cause.startsWith("error:fetch-failed")).length;
  p.condN = nonPayNonFF; p.condOk = nonPayNonFF > 0 ? pv.ok / nonPayNonFF : null;
}
D.pay.byProviderNamed = [...D.pay.byProvider].sort((a, b) => b.payNamed - a.payNamed || b.pay - a.pay);
// (h) the three presentation groups used everywhere: ok / empty (answered, no text) / did not answer
D.groups = { ok: D.pop.status.ok, empty: D.pop.status.empty, notAnswered: D.pop.nonOk - D.pop.status.empty };


// top non-ok sentences per provider (numbers stripped), for the dead / partial provider discussion
D.provMsg = {};
for (const p of provNames) {
  const m = new Map();
  for (const r of rows) if (r.provider === p && r.status !== "ok") { const t = r.status + ": " + r.text.replace(/[0-9]+/g, "#").slice(0, 90); m.set(t, (m.get(t) || 0) + 1); }
  D.provMsg[p] = [...m].sort((a, b) => b[1] - a[1]).slice(0, 3);
}
D.emptyDetail = { hiddenReasoningReasonFlag: rows.filter((r) => r.cause === "empty:budget-spent-on-hidden-reasoning" && r.reason).length,
  hiddenLegacy: rows.filter((r) => r.cause === "empty:budget-spent-on-hidden-reasoning" && r.legacy).length,
  legacyNoMsgOk0: rows.filter((r) => r.cause === "empty:legacy-no-message" && !(r.rec.o > 0)).length,
  legacyNoMsgOpos: rows.filter((r) => r.cause === "empty:legacy-no-message" && r.rec.o > 0).length,
  answeredElsewhereOk: rows.filter((r) => r.status === "empty" && r.crossOk).length };
D.okExtra = {
  streamedIncrementally: ok.filter((r) => r.rec.d - r.rec.t > 50).length, singleBurst: ok.filter((r) => r.rec.d - r.rec.t <= 50).length,
  oGe96: ok.filter((r) => r.rec.o >= 96).length, oGt96: ok.filter((r) => r.rec.o > 96).length,
  thinkingOnlyOk: ok.filter((r) => r.rec.k === 1).length, m1Routes: rows.filter((r) => r.m1).length, m1Ok: rows.filter((r) => r.m1 && r.status === "ok").length,
  nullBadgeOk: ok.filter((r) => !r.badge).length,
};
D.staleAt = { legacyOldest: iso(Math.min(...rows.map((r) => r.rec.a))), legacyStaleOn: iso(Math.min(...rows.map((r) => r.rec.a)) + 14 * 86400), currentStaleOn: iso(Math.min(...rows.filter((r) => !r.legacy).map((r) => r.rec.a)) + 14 * 86400), allStaleOn: iso(Math.max(...rows.map((r) => r.rec.a)) + 14 * 86400) };
// ------------------------------------------------------ writers
const csv = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const mh = ["provider", "id", "badge", "provenance", "outputKind", "ctx", "status", "cause", "t", "d", "r", "o", "message", "probed_at", "fresh", "pending", "legacy_record", "ever_ok_any_bench_file", "listed_in_provider_listing_normalised", "ok_sibling", "proposed_action"];
const lines = [mh.join(",")];
for (const r of all) {
  if (!r.eligible) { lines.push([r.provider, r.id, r.badge, r.prov, r.outputKind, r.ctx ?? "", "non-chat (not probed)", "", "", "", "", "", "", "", "n/a", "no", "", "", "", "", "excluded from probing (outputKind nontext): keep excluded / hide behind non-chat filter"].map(csv).join(",")); continue; }
  const rec = r.rec;
  lines.push([r.provider, r.id, r.badge, r.prov, r.outputKind, r.ctx ?? "", r.status, r.cause, rec.t ?? "", rec.d ?? "", rec.r ?? "", rec.o ?? "", r.text, iso(rec.a), r.fresh ? "yes" : "no", r.probed ? "no" : "yes",
    r.legacy ? "yes" : "no", r.everOk ? "yes" : "no", r.listed ? "yes" : "no", r.sibOk ? r.sibs.filter((s) => s.ok).map((s) => s.y).join("|") : "", r.action].map(csv).join(","));
}
fs.writeFileSync(path.join(OUT, "models.csv"), lines.join("\n") + "\n");
const ph = ["provider", "keyId", "routes", "non_chat", "eligible", "probed", "pending", ...STATUS, "ok_rate", "answer_rate", "verdict", "verdict_excl_fetch_failed", "dominant_blocker", "legacy_records", "catalogue_only_rows", "discovery(status/outcome/count)", "median_ttft_ms", "median_tps", "free_models_flag", "plan_count", "health", "picker_remove_candidates", "picker_labeled", "picker_hidden", "picker_fix_first", "picker_reprobe_first"];
const pl = [ph.join(",")];
for (const p of D.prov) { const i = impact[p.provider]; pl.push([p.provider, p.keyId, p.routes, p.nonChat, p.eligible, p.probed, p.pending, ...STATUS.map((s) => p[s]), p.okRate == null ? "" : p.okRate.toFixed(4), p.answerRate == null ? "" : p.answerRate.toFixed(4), p.verdict, p.verdictAdj, p.dominant, p.legacy, p.catalogueOnly, p.discoveryOutcome, p.medTtft ?? "", p.medTps ?? "", p.free, p.planCount, p.health, i.remove, i.label, i.hide, i.fix, i.reprobe].map(csv).join(",")); }
fs.writeFileSync(path.join(OUT, "providers.csv"), pl.join("\n") + "\n");
fs.writeFileSync(path.join(OUT, "data.json"), redact(JSON.stringify(D, null, 1)));
console.log("wrote", lines.length - 1, "model rows", pl.length - 1, "provider rows");
console.log(JSON.stringify(D.pop), JSON.stringify(D.proposal.actionClassTotals));

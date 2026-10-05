// `subagent-policy report` (plan 7.2 item 13, D-w, stage S2a): per agent and in total, "asked -> ran", why, what the policy WOULD have used, and an input-token cost
// estimate against main's own model, always labelled ESTIMATE_LABEL. Every figure names its population in the same sentence (the project's most common defect is a number
// true of one population restated about another). Reads only: the agent log (`agents.jsonl` and its rotated files), the merged router status counters, the snapshot for
// prices and, with `--outcomes yes`, CCR's `request_logs` through an injectable read-only seam (a fixture database in every test, never the real one). The `--json` form
// has a FROZEN shape: `REPORT_SCHEMA` and the key order built below are pinned by a test. `last --json` keeps its own S1d shape.
import fs from "node:fs";
import { readAgentLog, readStatus, readCompiled, printable, formatHandoff, localWhen, sinceMs, tally, provOf, CLASS_FILES, payloadGateLine } from "./subagent-policy.mjs";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { stripOneM } from "../menu/subagent-funnel.mjs";
import { loadSqlite } from "../refresh/observe.mjs";

export const REPORT_SCHEMA = 2;                     // 2: contextGrowth and payload were appended (revision 11, D-bl, sa-A1)
export const ESTIMATE_LABEL = "estimate, input tokens only, snapshot prices";
export const JOIN_WINDOW_MS = 2000;                 // the plan's session prefix and +/- 2 s window (9.3)
export const TEXT_ROWS = 20, JSON_ROWS = 200, HANDOFF_ROWS = 50, LOG_ROW_LIMIT = 5000;
const HEADERS_MAX = 65536;                          // a header blob larger than this is never handed to json_valid

const isObject = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sel = (v) => printable(v ?? "", 160);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const money = (v) => `$${v.toFixed(4)}`;
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const normTime = (s) => { const t = String(s ?? ""); return Date.parse(/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d+)?$/.test(t) ? `${t.replace(" ", "T")}Z` : t); };

/**
 * One agents.jsonl line as plain fields. The router writes that file in exactly three shapes (logAgent: path "shadow", "new" and "handoff"); sampled repeat requests and the shadow
 * "would hand over" lines live in decisions.jsonl and are NOT read here. kind: `handoff` (a retry-driven hand-over, enforcing) or `decision` (one per new agent).
 */
export function reportRecord(o) {
  const kind = o.act === "handoff" ? "handoff" : "decision";
  const asked = o.asked == null ? null : sel(o.asked);
  const ran = o.ret == null ? asked : sel(o.ret);
  const would = o.would == null ? null : sel(o.would);
  const mode = o.pol === "enforce" ? "enforce" : o.pol === "shadow" ? "shadow" : null;
  const act = sel(o.act ?? "?").slice(0, 32);
  // a policy "keep" never moved anything: when the model that ran still differs from the one asked for, the legacy slot rewrite (slot.json) did that, not the policy
  const moved = kind !== "decision" ? null : would === null || act === "keep" ? false : mode === "enforce" ? (ran !== null && asked !== null && ran !== asked) : (asked !== null && would !== asked);
  const rewritten = kind === "decision" && act === "keep" && ran !== null && asked !== null && ran !== asked;
  const hand = kind === "handoff" ? formatHandoff({ from: o.from ?? o.ret, to: o.to ?? o.would ?? o.ret, reason: o.reason ?? o.why, hop: o.hop }) : null;
  return { t: new Date(Date.parse(o.t)).toISOString(), sid: sel(o.sid ?? "").slice(0, 16), aid: o.aid == null ? null : sel(o.aid), kind, act, asked, ran, would, main: o.main == null ? null : sel(o.main), why: o.why == null ? null : sel(o.why).slice(0, 120),
    mode, tc: num(o.tc), moved, rewritten, handoff: hand, flags: (Array.isArray(o.flags) ? o.flags : []).filter((x) => typeof x === "string").map((x) => sel(x).slice(0, 40)).slice(0, 8) };
}

/** `provider/id` -> listed input price in USD per million tokens (null when the snapshot lists none), the FIRST route of a model winning. */
export function priceIndex(snap) {
  const ix = new Map();
  for (const r of snap?.rows ?? []) for (const m of r.models ?? []) {
    const k = `${r.provider}/${m.id}`;
    if (!ix.has(k)) ix.set(k, num(m.pin));
  }
  return ix;
}
const priceOf = (ix, selector) => (selector == null ? null : ix.get(selector) ?? ix.get(stripOneM(selector)) ?? null);

/** The estimate: input tokens of the FIRST request of each agent (the log holds one line per new agent) times the listed input price. Pure. */
export function estimate(decisions, ix) {
  const pop = { decisions: decisions.length, noTokenCount: 0, noMain: 0, priceUnknown: 0, eligible: 0 };
  let tokens = 0, inherit = 0, asRan = 0, policy = 0;
  const per = new Map();
  for (const r of decisions) {
    if (r.tc === null || r.tc <= 0) { pop.noTokenCount += 1; continue; }
    if (r.main === null) { pop.noMain += 1; continue; }
    const used = r.mode === "enforce" ? r.ran : r.would ?? r.ran;
    const pm = priceOf(ix, r.main), pr = priceOf(ix, r.ran), pp = priceOf(ix, used);
    if (pm === null || pr === null || pp === null) { pop.priceUnknown += 1; continue; }
    const c = { inherit: (r.tc / 1e6) * pm, asRan: (r.tc / 1e6) * pr, policy: (r.tc / 1e6) * pp };
    pop.eligible += 1; tokens += r.tc; inherit += c.inherit; asRan += c.asRan; policy += c.policy;
    per.set(r, { inherit: round6(c.inherit), asRan: round6(c.asRan), policy: round6(c.policy) });
  }
  return { pop, tokens, inherit, asRan, policy, per };
}

const LOG_SQL = `select created_at, requested_model, resolved_model, status_code,
  case when length(request_headers) <= ${HEADERS_MAX} and json_valid(request_headers) then json_extract(request_headers, '$."x-claude-code-session-id"') end as sid,
  case when length(request_headers) <= ${HEADERS_MAX} and json_valid(request_headers) then json_extract(request_headers, '$."x-claude-code-agent-id"') end as aid
  from request_logs where created_at >= ? and created_at <= ? order by created_at limit ${LOG_ROW_LIMIT}`;
const LOG_COLUMNS = ["created_at", "requested_model", "resolved_model", "status_code", "request_headers"];
export const LOG_QUERY = LOG_SQL;

/**
 * The real read-only opener: SQLite opened read-only with `query_only` on, so a statement that writes fails even if one were ever built. Returns `{ok, query, columns, close}` or
 * `{ok: false, reason}`; never throws. `onOpen(db)` is a test seam called with the hardened handle (a test proves an INSERT on it fails). The only statement run is LOG_SQL (named scalars; no header, no body leaves the database) plus a table_info check.
 */
export function openRequestLogs(file, { onOpen } = {}) {
  const sqlite = loadSqlite();
  if (!sqlite?.DatabaseSync) return { ok: false, reason: "node:sqlite is not available in this Node" };
  if (!file) return { ok: false, reason: "no request log was named" };
  if (!fs.existsSync(file)) return { ok: false, reason: "the request log file was not found" };
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 250 });
    db.exec("PRAGMA query_only = 1");
    if (onOpen) onOpen(db);
    const columns = new Set(db.prepare("pragma table_info(request_logs)").all().map((r) => r.name));
    return { ok: true, columns, query: (from, to) => db.prepare(LOG_SQL).all(from, to), close: () => { try { db.close(); } catch { /* closed */ } } };
  } catch (e) {
    try { db?.close(); } catch { /* closed */ }
    return { ok: false, reason: /locked|busy/i.test(String(e?.message)) ? "the request log is locked right now" : "the request log could not be opened read-only" };
  }
}

const sameModel = (resolved, ran) => {
  if (!resolved || !ran) return false;
  const a = stripOneM(String(resolved)).toLowerCase(), b = stripOneM(ran).toLowerCase(), i = b.indexOf("/");
  return a === b || (i > 0 && (a === b.slice(i + 1) || a === `${b.slice(0, i)},${b.slice(i + 1)}`));
};
/** Pure: pairs each decision with the nearest unused request-log row of the same session prefix within +/- JOIN_WINDOW_MS; a decision that has an agent id needs a row of that agent (a decision without one matches on session and time alone). */
export function joinOutcomes(decisions, rows) {
  const used = new Set();
  const rs = rows.map((r) => ({ ...r, ts: normTime(r.created_at), sid: String(r.sid ?? "").toLowerCase(), aid: String(r.aid ?? "").toLowerCase() })).filter((r) => Number.isFinite(r.ts));
  let considered = 0, matched = 0, equalsRan = 0, differs = 0, failed = 0;
  const per = new Map();
  for (const d of decisions) {
    if (!d.sid || d.ran === null) continue;
    considered += 1;
    const t = Date.parse(d.t), sid = d.sid.toLowerCase(), aid = (d.aid ?? "").toLowerCase();
    let best = null;
    for (const r of rs) {
      if (used.has(r) || !r.sid || !r.sid.startsWith(sid) || Math.abs(r.ts - t) > JOIN_WINDOW_MS) continue;
      if (aid && !(r.aid && (r.aid.startsWith(aid) || aid.startsWith(r.aid)))) continue;    // a decision with an agent id matches only a row of that agent; a row without one is NEVER a fallback (left unmatched rather than guessed)
      if (best === null || Math.abs(r.ts - t) < Math.abs(best.ts - t)) best = r;
    }
    if (best === null) continue;
    used.add(best);
    matched += 1;
    const same = sameModel(best.resolved_model, d.ran), bad = Number(best.status_code) >= 400;
    if (same) equalsRan += 1; else differs += 1;
    if (bad) failed += 1;
    per.set(d, { resolved: sel(best.resolved_model), status: Number.isFinite(Number(best.status_code)) ? Number(best.status_code) : null, sameAsRan: same });
  }
  return { considered, matched, equalsRan, differs, failed, unmatched: considered - matched, per };
}

function readOutcomes(p, decisions, opts) {
  const open = (opts.openLogs ?? openRequestLogs)(p.logsFile);
  if (!open?.ok) return { requested: true, available: false, reason: open?.reason ?? "the request log is unavailable", rowsRead: 0 };
  try {
    const missing = LOG_COLUMNS.filter((c) => !open.columns.has(c));
    if (missing.length) return { requested: true, available: false, reason: `request_logs has no ${missing.join(", ")} column`, rowsRead: 0 };
    if (!decisions.length) return { requested: true, available: true, reason: null, rowsRead: 0, ...joinOutcomes([], []) };
    const ts = decisions.map((d) => Date.parse(d.t));
    const rows = open.query(new Date(Math.min(...ts) - JOIN_WINDOW_MS).toISOString(), new Date(Math.max(...ts) + JOIN_WINDOW_MS).toISOString());
    return { requested: true, available: true, reason: null, rowsRead: rows.length, truncated: rows.length >= LOG_ROW_LIMIT, ...joinOutcomes(decisions, rows) };
  } catch { return { requested: true, available: false, reason: "the request log could not be read", rowsRead: 0 }; }
  finally { open.close?.(); }
}

const COUNTER_KEYS = ["req", "main", "sub", "substitute", "keep", "stickyHit", "handoff", "handoffNone", "error"];
function counterBlock(sr) {
  if (!sr.ok) return { available: false, reason: sr.reason, since: null, ...Object.fromEntries(COUNTER_KEYS.map((k) => [k, null])) };
  const c = isObject(sr.status.counters) ? sr.status.counters : {};
  return { available: true, reason: null, since: typeof sr.status.since === "string" ? printable(sr.status.since, 40) : null, ...Object.fromEntries(COUNTER_KEYS.map((k) => [k, num(c[k]) ?? 0])) };
}

/**
 * --session: the router logs only the first 8 characters of a session id, so a session matches when it equals the logged id, or when it is a LONGER id (the whole session id) whose
 * first characters are exactly the logged id. A shorter text than the logged id matches nothing: a typed fragment is never a prefix search.
 */
export const sessionMatches = (given, logged) => { const g = String(given).toLowerCase(), l = String(logged).toLowerCase(); return l !== "" && (g === l || (g.length > l.length && g.startsWith(l))); };

const rank = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const r2 = (v) => Math.round(v * 100) / 100;
/**
 * CONTEXT GROWTH (D-bl; an ESTIMATE): per subagent, the largest token count of a LATER request divided by the token count of its FIRST request, from the classifier log (every classified
 * request carries the router's own token count `tc`; agents.jsonl holds only the first). It lets the owner set the headroom multiple k from shadow data; nothing is applied. Population
 * words: agents are subagents seen in the window with an agent id and a token count; only those with at least two counted requests have a ratio. Pure.
 */
export function contextGrowth(classLines, { sinceT = null, session = null } = {}) {
  const by = new Map();
  let requests = 0, bytesN = 0, over200k = 0, over1m = 0;
  for (const o of classLines ?? []) {
    if (!isObject(o) || o.cls !== "sub") continue;
    const t = Date.parse(o.t);
    if (!Number.isFinite(t) || (sinceT !== null && t < sinceT)) continue;
    if (session !== null && session !== undefined && !sessionMatches(session, String(o.sid ?? ""))) continue;
    if (o.bb === "b0" || o.bb === "b1" || o.bb === "b2" || o.bb === "b3") { bytesN += 1; if (o.bb === "b2" || o.bb === "b3") over200k += 1; if (o.bb === "b3") over1m += 1; }
    const tc = num(o.tc);
    if (tc === null || tc <= 0 || typeof o.aid !== "string" || o.aid === "") continue;
    requests += 1;
    const k = `${String(o.sid ?? "")}|${o.aid}`;
    (by.get(k) ?? by.set(k, []).get(k)).push({ t, tc });
  }
  const peaks = [];
  for (const arr of by.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.t - b.t);
    peaks.push(Math.max(...arr.slice(1).map((x) => x.tc / arr[0].tc)));
  }
  peaks.sort((a, b) => a - b);
  return { label: "estimate", agents: by.size, measurable: peaks.length, singleRequest: by.size - peaks.length, requests,
    ratio: peaks.length ? { median: r2(rank(peaks, 0.5)), p90: r2(rank(peaks, 0.9)), max: r2(peaks[peaks.length - 1]) } : null,
    sizeSample: { requests: bytesN, over200k, over1m } };
}

/** The whole report as one plain object (the `--json` shape, in its frozen key order). Pure given its inputs. */
export function buildReport({ lines, unreadable, files, status, snap, nowMs, since, session, outcomes, limit = JSON_ROWS, classLines = [], compiled = null }) {
  const sinceT = since ? nowMs - sinceMs(since) : null;
  const inWin = lines.map(reportRecord).filter((r) => (sinceT === null || Date.parse(r.t) >= sinceT) && (session === undefined || session === null || sessionMatches(session, r.sid)));
  const decisions = inWin.filter((r) => r.kind === "decision"), handoffs = inWin.filter((r) => r.kind === "handoff");
  const ix = priceIndex(snap?.ok ? snap.snap : null);
  const est = estimate(decisions, ix);
  const modes = [...new Set(decisions.map((r) => r.mode).filter((m) => m !== null))];
  const out = outcomes ? readOutcomes(outcomes.p, decisions, outcomes.opts) : { requested: false };
  const listed = decisions.slice(-limit), handListed = handoffs.slice(-HANDOFF_ROWS);
  const moved = decisions.filter((r) => r.moved === true).length, noChoice = decisions.filter((r) => r.would === null).length;
  const gen = snap?.ok ? snap.snap.generatedAt ?? snap.snap.builtAt ?? null : null;
  return {
    schema: REPORT_SCHEMA, kind: "report", estimateLabel: ESTIMATE_LABEL,
    window: { since: sinceT === null ? null : new Date(sinceT).toISOString(), until: new Date(nowMs).toISOString(), session: session ?? null },
    denominators: { agentLines: inWin.length, decisions: decisions.length, handoffs: handoffs.length, sessions: new Set(decisions.map((r) => r.sid)).size, unreadableLines: unreadable, filesRead: files, agentsListed: listed.length, handoffsListed: handListed.length },
    totals: { mode: modes.length === 0 ? null : modes.length === 1 ? modes[0] : "mixed", moved, unchanged: decisions.length - moved - noChoice, noPolicyChoice: noChoice, keptButRewritten: decisions.filter((r) => r.rewritten).length,
      ranOn: tally(decisions.map((r) => provOf(r.ran))).map(([provider, n]) => ({ provider, n })), wouldUse: tally(decisions.filter((r) => r.would !== null).map((r) => provOf(r.would))).map(([provider, n]) => ({ provider, n })) },
    counters: counterBlock(status),
    estimate: { snapshotAvailable: !!snap?.ok, snapshotBuiltAt: gen === null ? null : printable(gen, 40), population: est.pop, tokens: est.tokens, currency: "USD", inheritUsd: round6(est.inherit), asRanUsd: round6(est.asRan), policyUsd: round6(est.policy), policyMinusInheritUsd: round6(est.policy - est.inherit) },
    outcomes: out.requested ? { requested: true, available: out.available, reason: out.reason, rowsRead: out.rowsRead, truncated: out.truncated ?? false, considered: out.considered ?? 0, matched: out.matched ?? 0, resolvedEqualsRan: out.equalsRan ?? 0, resolvedDiffers: out.differs ?? 0, errorStatus: out.failed ?? 0, unmatched: out.unmatched ?? 0, joinWindowMs: JOIN_WINDOW_MS }
      : { requested: false, available: false, reason: null, rowsRead: 0, truncated: false, considered: 0, matched: 0, resolvedEqualsRan: 0, resolvedDiffers: 0, errorStatus: 0, unmatched: 0, joinWindowMs: JOIN_WINDOW_MS },
    agents: listed.map((r) => ({ t: r.t, sid: r.sid, aid: r.aid, asked: r.asked, ran: r.ran, would: r.would, why: r.why, mode: r.mode, main: r.main, tokens: r.tc, moved: r.moved, flags: r.flags,
      costUsd: est.per.get(r) ?? null, outcome: out.per?.get(r) ?? null })),
    handoffs: handListed.map((r) => ({ t: r.t, sid: r.sid, aid: r.aid, text: r.handoff })),
    contextGrowth: contextGrowth(classLines, { sinceT, session }),
    payload: { compiledAvailable: !!compiled, allowed: compiled ? num(compiled.counts?.allowed) : null, unknownLimit: compiled ? num(compiled.counts?.payloadUnknown) : null, gateLine: compiled ? payloadGateLine(compiled.counts ?? {}) : null },
  };
}

/** The report for people: every figure with the population it was counted over. Pure. */
export function renderReport(r, nowMs) {
  const d = r.denominators, tot = r.totals, L = [];
  const win = r.window.since === null ? "" : `, since ${r.window.since.slice(0, 16).replace("T", " ")} UTC`;
  if (!d.agentLines) {
    L.push(`no agent decisions to report${r.window.since === null ? "" : " in that window"}${r.window.session ? ` for session ${r.window.session}` : ""} (read ${plural(d.filesRead, "log file")}; ${d.unreadableLines} unreadable lines skipped). The router writes one line per new subagent once a policy is compiled.`);
    return L;
  }
  const enf = tot.mode === "enforce";
  const modeWord = tot.mode === "shadow" ? "shadow mode: the policy only logged what it would do; nothing was actually changed" : enf ? "enforcing: the router really served the policy's model" : tot.mode === "mixed" ? "shadow and enforcing lines are both in this window" : "no policy mode was logged";
  L.push(`report: ${plural(d.decisions, "agent decision")} (one logged per new subagent) in ${plural(d.sessions, "session")}${win}${r.window.session ? `, session ${r.window.session}` : ""}; ${modeWord}`);
  L.push(`asked -> ran, and what the policy ${enf ? "chose" : "would use"} (newest ${Math.min(TEXT_ROWS, r.agents.length)} of ${d.decisions} agent decisions):`);
  for (const a of r.agents.slice(-TEXT_ROWS)) {
    const pol = a.would === null ? "no policy choice" : a.would === a.asked ? "policy agrees" : `${a.mode === "enforce" ? "policy chose" : "policy would use"} ${a.would}`;
    const cost = a.costUsd ? `  est ${money(a.costUsd.policy)} vs ${money(a.costUsd.inherit)} on main` : "";
    const out = a.outcome ? `  gateway ${a.outcome.sameAsRan ? "served it" : `resolved ${a.outcome.resolved || "?"}`}${a.outcome.status !== null && a.outcome.status >= 400 ? ` (HTTP ${a.outcome.status})` : ""}` : "";
    L.push(`  ${localWhen(a.t, nowMs)}  asked ${a.asked ?? "?"}  ran ${a.ran ?? "?"}  ${pol}${a.why && a.would !== null ? `  because ${a.why}` : ""}${cost}${out}`);
  }
  L.push(`summary (of ${plural(d.decisions, "agent decision")}):`);
  const fmtT = (t) => t.map((x) => `${x.provider} ${x.n}`).join(", ") || "(none)";
  L.push(`  ran on: ${fmtT(tot.ranOn)} (of ${d.decisions})`);
  L.push(`  policy ${enf ? "chose" : "would use"}: ${fmtT(tot.wouldUse)} (of ${tot.wouldUse.reduce((s, x) => s + x.n, 0)} with a policy choice)`);
  L.push(`  ${enf ? "moved to another model" : "would move to another model"}: ${tot.moved} of ${d.decisions}; unchanged: ${tot.unchanged} of ${d.decisions}; no policy choice: ${tot.noPolicyChoice} of ${d.decisions}`);
  if (tot.keptButRewritten) L.push(`  ${tot.keptButRewritten} of ${d.decisions} ran on a different model than asked although the policy kept it (the old model-slot rewrite did that, not the policy; they count as unchanged)`);
  if (d.handoffs) L.push(`  hand-overs after a limit: ${plural(d.handoffs, "hand-over line")} in this window, each moved a running agent to another model${d.handoffsListed < d.handoffs ? ` (--json yes lists only the newest ${d.handoffsListed} of ${d.handoffs})` : ""}`);
  const c = r.counters;
  L.push(c.available
    ? `router counters since ${c.since ?? "an unknown time"} (the router's lifetime, NOT limited to this window): ${c.sub} subagent requests of ${c.req} requests; ${c.substitute} of ${c.sub} subagent requests moved to another model, ${c.keep} of ${c.sub} left as asked; ${c.stickyHit} repeat requests kept on their model; ${plural(c.handoff, "hand-over")} done, ${plural(c.handoffNone, "limit")} with nothing to hand over to; ${c.error} of ${c.req} requests hit an internal error`
    : `router counters: unavailable (status ${c.reason ?? "unreadable"})`);
  const e = r.estimate, p = e.population;
  if (!e.snapshotAvailable) L.push(`savings (${ESTIMATE_LABEL}): unavailable, the model snapshot could not be read, so no price is known`);
  else if (!p.eligible) L.push(`savings (${ESTIMATE_LABEL}): none of the ${plural(p.decisions, "agent decision")} can be priced (${p.noTokenCount} without a token count, ${p.noMain} without a known main model, ${p.priceUnknown} with a model the snapshot lists no price for)`);
  else {
    const diff = e.policyMinusInheritUsd;
    L.push(`savings (${ESTIMATE_LABEL}${e.snapshotBuiltAt ? `, snapshot of ${e.snapshotBuiltAt.slice(0, 10)}` : ""}): of ${p.eligible} of ${p.decisions} agent decisions that can be priced (${p.noTokenCount} without a token count, ${p.noMain} without a known main model, ${p.priceUnknown} with an unlisted price), their ${e.tokens.toLocaleString("en-US")} input tokens would cost about ${money(e.inheritUsd)} on main's own model, ${money(e.asRanUsd)} on what ran, and ${money(e.policyUsd)} on what the policy ${enf ? "chose" : "would use"}: ${diff === 0 ? "no difference" : diff < 0 ? `about ${money(-diff)} less than main's model` : `about ${money(diff)} MORE than main's model`}. Only the first request of each agent is counted (the log holds one line per new agent), so the real totals are higher.`);
  }
  const o = r.outcomes;
  if (o.requested) {
    L.push(o.available
      ? `outcomes (the gateway request log, read only, joined by session, agent and a ${o.joinWindowMs / 1000} second window): matched ${o.matched} of ${o.considered} agent decisions (${o.rowsRead} log rows read${o.truncated ? `, STOPPED AT THE ${LOG_ROW_LIMIT}-ROW LIMIT: later rows were not read, so some unmatched agents may only be beyond it` : ""}); the gateway resolved the logged model on ${o.resolvedEqualsRan} of ${o.matched} matched, another model on ${o.resolvedDiffers} of ${o.matched}; ${o.errorStatus} of ${o.matched} matched returned an error status (400 or above)${o.unmatched ? `; ${o.unmatched} of ${o.considered} had no matching request (the gateway keeps only recent request rows, for a time this report does not know, so older agents can be missing)` : ""}`
      : `outcomes: unavailable (${o.reason})`);
  }
  const cg = r.contextGrowth;
  if (cg.measurable) L.push(`context growth (${cg.label}, the router's token counts from its classifier log): of ${plural(cg.agents, "subagent")} with a token count (${plural(cg.requests, "request")}), ${cg.measurable} made two or more requests; the largest later request of each was a median ${cg.ratio.median}x, 90th percentile ${cg.ratio.p90}x, at most ${cg.ratio.max}x its FIRST request (n = ${cg.measurable} subagents; ${cg.singleRequest} with one counted request have no ratio). Nothing is changed by this; it is the measurement for the headroom multiple.`);
  else L.push(`context growth (${cg.label}): not measurable: of ${plural(cg.agents, "subagent")} with a token count in the classifier log, none made two or more counted requests in this window`);
  if (cg.sizeSample.requests) L.push(`request size (the classifier log's size buckets): ${cg.sizeSample.over200k} of ${cg.sizeSample.requests} classified subagent requests (${Math.round((100 * cg.sizeSample.over200k) / cg.sizeSample.requests)}%) were over 200 KB and ${cg.sizeSample.over1m} (${Math.round((100 * cg.sizeSample.over1m) / cg.sizeSample.requests)}%) over 1 MB`);
  if (r.payload.gateLine) L.push(r.payload.gateLine);
  L.push("note: Claude Code's transcript shows the model that was REQUESTED, not the one that served the request; this report shows what the router returned.");
  return L;
}

/** The command: reads, builds, prints. Exit 0 whenever the report could be produced (an unreadable log or snapshot is said inside it, never silently left out). */
export async function cmdReport(p, flags, io, opts = {}) {
  const nowMs = opts.now ?? Date.now();
  const { lines, unreadable, files } = readAgentLog(p.stateDir);
  const status = readStatus(p.statusFile);
  const snap = loadSnapshot(p.snapshotFile);
  const cr = readCompiled(p.compiledFile);
  const report = buildReport({ lines, unreadable, files, status, snap, nowMs, since: flags.since, session: flags.session, outcomes: flags.outcomes ? { p, opts } : null,
    classLines: readAgentLog(p.stateDir, CLASS_FILES).lines, compiled: cr.ok ? cr.value : null });
  if (flags.json) { io.out(JSON.stringify(report)); return 0; }
  for (const l of renderReport(report, nowMs)) io.out(l);
  return 0;
}

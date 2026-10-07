// The classifier accuracy and shadow-tally evaluator (plan 12.5 and 12.1 S3 items 3 and 7; issue #154).
//
//   node keysync/subagent-accuracy.mjs [--since 7d|30d] [--json yes] [--write yes --live yes]
//
// READ-ONLY apart from the one optional output file `state/subagent/accuracy.json`. It reads the router's classifier log generations and the decision and agent logs in bounded chunks, EXCLUDES the UW
// tooling's own sessionless probe traffic from every denominator, computes T1..T6 of 12.5 with the population named in the same sentence as every number, tallies what each of the three modes
// (dynamic, inherit, free) WOULD have used for every subagent request, and prints PASS, FAIL or INSUFFICIENT per metric with the reason. It starts no process and sends no request.
//
// GROUND TRUTH (round 2). Without `rc` the router's class is a pure function of the two detectors the log records (agent id, billing flag) and the tool count, so a check of the class against those
// detectors only shows that the router agrees with itself ("0 of 1,756 main requests misclassified" is true by construction). A PASS therefore needs GROUND-TRUTH-LABELLED evidence: `rc`, the request
// class Claude Code sends when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 (header x-claude-code-request-class: main|subagent|workflow|compaction|auxiliary). T1, T2 and T4 are judged on rc-labelled requests only;
// the detector-consensus figures stay printed, marked REPORTED, and are never gated. T5 (two independent header signals, agent id against the billing flag) is a real cross-check and needs no rc.
//
// INDEPENDENCE. Requests cluster per agent, so T1 and T5 also need distinct built-in agents, and T1 carries a second Wilson bound with one sample per agent (its worst outcome); the more conservative bound binds.
//
// WHAT THE LOG CANNOT SHOW (stated in the output, never hidden): a helper request is never in the decision log and carries no returned model, so "helper calls rewritten" is counted as (a) helper requests the
// router classified sub, exempt or other (or main while carrying an agent id or the billing flag) and (b) helper-shaped rows of the decision log whose returned model differs from the asked one. A helper
// call classified main is never REWRITTEN (main is passed through), so an rc helper with no detector set that the router called main is a counted sample, not a violation.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { CLASS_FILES, CLASS_READ_MAX, isProbeRow, isProbeSid, resolvePaths, gatherInputs, compile, loadOwner, OWNER_DEFAULTS, PolicyError, readJsonFile, writeFileRetry, UNITS, printable, FILE_FLAGS } from "./subagent-policy.mjs";
import { providerOf, SUBSTITUTE_FLOOR, SUBSTITUTE_K } from "../menu/subagent-funnel.mjs";

export const ACCURACY_SCHEMA = 2;
export const Z95 = 1.645;                                          // one-sided 95%: n = 200 with no miss gives 98.67%, one miss 97.79% (the figures of 12.5)
/**
 * The accepted thresholds (plan 12.5, decision Q2) and the minimum samples. Frozen: a mutated copy must fail a test. `maxAgeDays` is the EXPIRY of a written PASS and the longest window;
 * `maxEvidenceAgeDays` is how old the newest counted request may be.
 */
export const THRESHOLDS = Object.freeze({ t1Pct: 99, t1Wilson: 97, t2Rewritten: 0, t2MinHelpers: 200, t4Misclassified: 0, t5MaxDisagreePct: 1, maxAgeDays: 30, maxEvidenceAgeDays: 7, futureToleranceMs: 5 * 60 * 1000 });
export const MIN_SAMPLES = Object.freeze({ perSubagentType: 40, subagentTypes: 5, distinctAgents: 30, helperTotal: 200, perLabelledHelperType: 40, main: 200, mainSessions: 2, mainModelSwitches: 1, sessions: 3, perSession: 20, days: 2, builtIn: 40, t1: 200 });
export const CLASS_NAMES = Object.freeze(["main", "sub", "aux", "exempt", "other"]);
const RC_SET = Object.freeze(["main", "subagent", "workflow", "compaction", "auxiliary"]);
const DECISION_FILES = Object.freeze(["decisions.2.jsonl", "decisions.1.jsonl", "decisions.jsonl"]);
const AGENT_FILES = Object.freeze(["agents.3.jsonl", "agents.2.jsonl", "agents.1.jsonl", "agents.jsonl"]);
const DAY_MS = 86400000;
const MAIN_TTL_MS = 6 * 3600 * 1000;                               // the router's main-model memory (compiled `main.ttlSec`)
const CAPS = Object.freeze({ sessions: 5000, agents: 20000, types: 64, tallyKeys: 5000, models: 4000 });
const KINDS_NOTE = "teammate = an agent id without the billing flag; built-in = both detectors; billing-only = the flag without an agent id";
export const HINT_LINE = "enable the gateway hint headers (CLAUDE_CODE_GATEWAY_HINT_HEADERS=1; the router reads the x-claude-code-request-class header) so the router sees the client's own request class";

// ------------------------------------------------------------------ pure math
/** One-sided Wilson lower bound for k successes in n trials (z = 1.645 is the 95% one-sided bound). 0 for an empty sample. */
export function wilsonLower(k, n, z = Z95) {
  if (!(n > 0) || !(k >= 0)) return 0;
  const p = Math.min(1, k / n), z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}
/** The fewest samples with NO miss whose Wilson lower bound reaches `pct` (88 for 97%). */
export function samplesForBound(pct = THRESHOLDS.t1Wilson) { for (let n = 1; n < 100000; n++) if (100 * wilsonLower(n, n) >= pct) return n; return Infinity; }
const pctText = (k, n, d = 1) => (n > 0 ? `${((100 * k) / n).toFixed(d)}%` : "n/a");
const num = (v) => Number(v).toLocaleString("en-US");
const clip = (v, n) => printable(v, n);

// ------------------------------------------------------------------ bounded readers
/**
 * Calls `onObj(parsedObject)` for every line of the named files, OLDEST FIRST, in bounded 1 MiB chunks. A file larger than `maxBytes` gives only its newest `maxBytes` (its first partial line dropped);
 * a line longer than `maxLine` is dropped and counted; a torn or non-object line is counted, never fatal; an absent file is listed as absent (a directory with only some generations is normal).
 * Memory: one chunk plus one carried partial line, whatever the file size. Returns what was read of what exists.
 */
export function streamJsonl(dir, names, onObj, { maxBytes = CLASS_READ_MAX, chunk = 1024 * 1024, maxLine = 1024 * 1024 } = {}) {
  const log = { files: [], keptBytes: 0, readBytes: 0, unreadableLines: 0 };
  const take = (raw) => {
    if (!raw.trim()) return;
    let o;
    try { o = JSON.parse(raw); } catch { log.unreadableLines += 1; return; }
    if (!o || typeof o !== "object" || Array.isArray(o)) { log.unreadableLines += 1; return; }
    onObj(o);
  };
  for (const name of names) {
    const f = path.join(dir, name);
    let st;
    try { st = fs.statSync(f); } catch (e) { log.files.push({ name, state: e?.code === "ENOENT" ? "absent" : "unreadable", why: e?.code === "ENOENT" ? undefined : (e?.code ?? "error") }); continue; }
    if (!st.isFile()) { log.files.push({ name, state: "unreadable", why: "not a file" }); continue; }
    const start = Math.max(0, st.size - maxBytes);
    let fd = null;
    try {
      fd = fs.openSync(f, "r");
      const buf = Buffer.allocUnsafe(chunk);
      let pos = start, carry = Buffer.alloc(0), skip = start > 0;
      while (pos < st.size) {
        const n = fs.readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let from = 0, nl;
        while ((nl = data.indexOf(10, from)) !== -1) { if (skip) skip = false; else take(data.toString("utf8", from, nl)); from = nl + 1; }
        carry = Buffer.from(data.subarray(from));
        if (carry.length > maxLine) { if (!skip) log.unreadableLines += 1; carry = Buffer.alloc(0); skip = true; }
      }
      if (carry.length && !skip) take(carry.toString("utf8"));
    } catch (e) { log.files.push({ name, state: "unreadable", why: e?.code ?? "error" }); continue; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* read already */ } } }
    log.files.push({ name, state: "read", size: st.size, read: st.size - start, truncated: start > 0 });
    log.keptBytes += st.size; log.readBytes += st.size - start;
  }
  return log;
}

// ------------------------------------------------------------------ row normalisation (hostile-field safe)
const AT_RE = /^[A-Za-z0-9_.:@+-]{1,32}$/;
const timeOf = (o) => (typeof o.t === "string" ? Date.parse(o.t) : NaN);
const sel = (v) => (typeof v === "string" && v ? clip(v, 120) : null);
const BYTE_BUCKETS = Object.freeze({ b0: 25 * 1024, b1: 125 * 1024, b2: 450 * 1024, b3: 1536 * 1024 });   // a representative size per router bucket (under 50 KB, 50-200 KB, 0.2-1 MB, over 1 MB): an ESTIMATE
/** A classifier line as plain fields, or null when it has no usable time or class string. A missing `nt` (tool count) leaves `nt` null: such a line cannot be shaped and is counted apart. */
export function normClassRow(o) {
  const ms = timeOf(o);
  if (!Number.isFinite(ms) || typeof o.cls !== "string") return null;
  const rc = typeof o.rc === "string" && RC_SET.includes(o.rc) ? o.rc : null;
  return {
    ms, day: new Date(ms).toISOString().slice(0, 10), cls: CLASS_NAMES.includes(o.cls) ? o.cls : "other",
    ag: o.ag === 1, bl: o.bl === 1, ga: o.ga === 1, nt: Number.isFinite(o.nt) && o.nt >= 0 ? o.nt : null,
    sid: typeof o.sid === "string" ? clip(o.sid, 16) : "", aid: typeof o.aid === "string" ? clip(o.aid, 64) : null, m: sel(o.m),
    rc, at: typeof o.at === "string" && AT_RE.test(o.at) ? o.at : null, tc: Number.isFinite(o.tc) && o.tc >= 0 ? o.tc : null,
    bb: typeof o.bb === "string" && Object.hasOwn(BYTE_BUCKETS, o.bb) ? o.bb : null,
    probe: isProbeRow(o), hasSid: o.hasSid === true || o.hasSid === false ? o.hasSid : null,
  };
}
const normDecision = (o) => {
  const ms = timeOf(o);
  if (!Number.isFinite(ms)) return null;
  return { ms, sid: typeof o.sid === "string" ? clip(o.sid, 16) : "", role: typeof o.role === "string" ? o.role : null, ag: o.ag === 1, bl: o.bl === 1, tools: Number.isFinite(o.tools) ? o.tools : null,
    asked: sel(o.asked), would: sel(o.would), ret: sel(o.ret), act: typeof o.act === "string" ? clip(o.act, 32) : "", ph: typeof o.ph === "string" ? clip(o.ph, 16) : null, pol: o.pol === "enforce" ? "enforce" : "shadow" };
};
const normAgent = (o) => {
  const ms = timeOf(o);
  if (!Number.isFinite(ms)) return null;
  return { ms, sid: typeof o.sid === "string" ? clip(o.sid, 16) : "", asked: sel(o.asked), would: sel(o.would), ret: sel(o.ret), act: typeof o.act === "string" ? clip(o.act, 32) : "", ph: typeof o.ph === "string" ? clip(o.ph, 16) : null };
};

// ------------------------------------------------------------------ the offline shadow decision
const OBSERVED_ACTS = new Set(["keep", "substitute", "honour-tag", "inherit", "unknown-main", "empty-set", "unresolvable", "reject-unresolvable"]);
const BIG_REQ = 200 * 1024, BK_MAX = 64 * 1024 * 1024;               // the router's R-v3 constants: above 200 KB a row with an unknown payload cap ranks last
const own = (o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);
/** A compiled policy as the router would index it. */
export function policyView(compiled) {
  const idx = new Map();
  (compiled.models ?? []).forEach((r, i) => idx.set(r.s, i));
  return { pol: compiled, idx };
}
const listOf = (v, L) => (L === null ? v.pol.models.map((_, i) => i) : Array.isArray(L) ? L : []);
const fitsTok = (row, tc) => !!row && row.c > 0 && (!Number.isFinite(tc) || tc * 1.1 <= row.c);
const fitsBytes = (row, bytes) => !row || !(row.pb > 0) || !(bytes > 0) || bytes <= row.pb;
const unkBig = (row, bytes) => bytes > BIG_REQ && !(row.pb > 0) && !(typeof row.bk === "number" && row.bk > 0 && row.bk <= BK_MAX && row.bk >= bytes);
/**
 * What the compiled policy of one mode WOULD use for one subagent request: {kind, picks}. kind is keep (the asked model stays), move (a policy model serves it), none (no eligible substitute: empty set,
 * nothing usable) or no-main (same-provider or inherit with no learned main). picks is [[model, weight]]: a deterministic spread over the lead pool shares the request equally (expected value, NOT the
 * router's exact hash pick). This mirrors the router's `decide` and `pickSubstitute` for the SET, the context floor, the token fit, the payload cap and the unknown-cap-ranks-last rule of R-v3 (on a
 * representative size per log bucket), the lead band, K and main-first. It deliberately ignores cooling and overlay demotion (a live, per-minute state the log does not keep) and the handoff tier rule:
 * those change WHICH model, rarely WHETHER one is eligible. There is no rule in the router that reads a request's tool COUNT.
 */
export function predictUse(view, { asked, main, tc, bytes = 0 }) {
  const pol = view.pol, owner = pol.owner ?? {}, rowOf = (s) => (view.idx.has(s) ? pol.models[view.idx.get(s)] : null);
  if (owner.mode === "inherit") {
    if (Array.isArray(pol.exempt) && pol.exempt.includes(asked)) return { kind: "keep", picks: [[asked, 1]] };
    if (!main) return { kind: "no-main", picks: [] };
    return main === asked ? { kind: "keep", picks: [[asked, 1]] } : { kind: "move", picks: [[main, 1]] };
  }
  const same = owner.source !== "all-providers";
  if (same && !main) return { kind: "no-main", picks: [] };
  const S0 = same ? own(pol.lists?.byProvider, providerOf(main)) : (pol.lists?.all === undefined ? null : pol.lists.all);
  const S0idx = S0 === undefined ? [] : listOf(view, S0);
  if (!S0idx.length) return { kind: "none", picks: [] };
  const inS = new Set(S0idx);
  const askedRow = rowOf(asked);
  if (askedRow && inS.has(view.idx.get(asked)) && fitsTok(askedRow, tc) && fitsBytes(askedRow, bytes)) return { kind: "keep", picks: [[asked, 1]] };
  const hint = own(pol.ctxHints, asked), floor = Math.max(typeof hint === "number" ? hint : 0, SUBSTITUTE_FLOOR), banded = owner.banded !== false;
  const usable = (r) => !!r && r.c >= floor && fitsTok(r, tc) && fitsBytes(r, bytes);
  const scan = (idxs, prov, lim) => {
    const got = [], unk = [];
    let lead = null;
    for (const i of idxs) {
      if (got.length >= lim) break;
      const r = pol.models[i];
      if (!r || (prov !== null && providerOf(r.s) !== prov)) continue;
      if (banded && lead !== null && r.b !== lead.b) break;
      const big = unkBig(r, bytes);
      if (big && unk.length >= SUBSTITUTE_K) continue;
      if (!usable(r)) continue;
      if (big) { unk.push(r); continue; }                          // an unknown payload cap on a big request ranks last and never sets the lead band
      if (lead === null) lead = r;
      got.push(r);
    }
    return { got, unk };
  };
  const pool = (lim) => {
    let res = null;
    if (main) {
      const mp = providerOf(main), pl = own(pol.lists?.prov, mp);
      res = Array.isArray(pl) ? scan(pl, null, lim) : same ? scan(S0idx, null, lim) : scan(S0idx, mp, lim);
    }
    if (!res || res.got.length === 0) { const r2 = scan(S0idx, null, lim); res = { got: r2.got, unk: res && res.unk.length ? res.unk : r2.unk }; }
    return res;
  };
  const mainRow = main ? rowOf(main) : null;
  if (mainRow && inS.has(view.idx.get(main)) && usable(mainRow) && !unkBig(mainRow, bytes)) {
    if (!banded) return { kind: "move", picks: [[main, 1]] };
    const lead = pool(1).got[0];
    if (!lead || !(mainRow.b > lead.b)) return { kind: "move", picks: [[main, 1]] };
  }
  const res = pool(SUBSTITUTE_K);
  const top = res.got.length ? res.got : (banded && res.unk.length ? res.unk.filter((r) => r.b === res.unk[0].b) : res.unk);
  return top.length ? { kind: "move", picks: top.map((r) => [r.s, 1 / top.length]) } : { kind: "none", picks: [] };
}
const emptyTally = (view) => ({ mode: view.pol.owner?.mode ?? "?", source: view.pol.owner?.source ?? "?", rows: view.pol.models?.length ?? 0, requests: 0, keep: 0, moved: 0, none: 0, noMain: 0, byProvider: new Map(), byModel: new Map() });
const bump = (m, k, w) => { if (!m.has(k) && m.size >= CAPS.models) k = "~other"; m.set(k, (m.get(k) ?? 0) + w); };
/** Tallies the aggregated subagent requests ([{asked, main, tc, bytes, n}]) against every mode's policy view. Pure. */
export function shadowTally(aggs, views) {
  return Object.entries(views).map(([name, view]) => {
    const t = emptyTally(view); t.mode = name;
    for (const a of aggs) {
      const u = predictUse(view, a);
      t.requests += a.n;
      if (u.kind === "keep") t.keep += a.n; else if (u.kind === "none") t.none += a.n; else if (u.kind === "no-main") t.noMain += a.n;
      else {
        t.moved += a.n;
        for (const [m, w] of u.picks) { bump(t.byModel, m, a.n * w); bump(t.byProvider, providerOf(m), a.n * w); }
      }
    }
    return t;
  });
}
const shares = (m, total) => new Map([...m.entries()].map(([k, v]) => [k, total > 0 ? (100 * v) / total : 0]));
/** Modelled against observed shares (of the requests that MOVE), side by side, largest first: [{k, modelled, observed, diff}] in percentage points. Pure. */
export function compareShares(modelled, observed, top = 8) {
  const a = shares(modelled.map, modelled.total), b = shares(observed.map, observed.total);
  return [...new Set([...a.keys(), ...b.keys()])].map((k) => { const x = a.get(k) ?? 0, y = b.get(k) ?? 0; return { k, modelled: +x.toFixed(1), observed: +y.toFixed(1), diff: +(x - y).toFixed(1) }; })
    .sort((p, q) => Math.max(q.modelled, q.observed) - Math.max(p.modelled, p.observed) || (p.k < q.k ? -1 : 1)).slice(0, top);
}

// ------------------------------------------------------------------ the evaluator
const obsAcc = () => ({ n: 0, keep: 0, moved: 0, none: 0, byProvider: new Map(), byModel: new Map(), askedByProvider: new Map() });
const armsOf = () => ({ sub: 0, exempt: 0, main: 0, other: 0 });
function newAcc(nowMs, sinceMsV, fromMs = null) {
  const win = Math.min(sinceMsV, THRESHOLDS.maxAgeDays * DAY_MS);
  return {
    cutoff: Math.max(nowMs - win, fromMs ?? -Infinity), nowMs, windowMs: win, fromMs, excl: fromMs === null ? null : newAcc(nowMs, sinceMsV, null),
    rows: 0, inWindow: 0, future: 0, probe: 0, probeAgentShaped: 0, malformed: 0, noToolCount: 0, client: 0, counted: 0, newest: 0, oldest: Infinity,
    cls: { main: 0, sub: 0, aux: 0, exempt: 0, other: 0 }, sessionCounts: new Map(), days: new Set(),
    rcLogged: 0, atLogged: 0,
    cons: { sub: { n: 0, ok: 0 }, main: { n: 0, ok: 0 }, helperExcluded: 0 },          // detector consensus: REPORTED, never gated (the class is a function of these signals)
    t1: { n: 0, sub: 0, exempt: 0, missBy: { main: 0, aux: 0, other: 0 }, agents: new Map(), agentsCapped: false },   // rc-labelled tool-carrying subagent requests; agents: key -> missed?
    single: { n: 0, sub: 0 },                                      // exactly one detector, no rc: uncorroborated
    subTypes: new Map(), builtAgents: new Set(), agentsCapped: false,
    toolless: { n: 0 },
    helper: { lastViolMs: 0, rc: { n: 0, aux: 0, viol: armsOf(), passthroughMain: 0, byType: new Map() }, shaped: { n: 0, aux: 0, viol: armsOf() }, unlabelledMain: 0 },
    main: { n: 0, notMain: armsOf(), sessions: new Set(), models: new Map() },   // rc-labelled main requests
    builtIn: { n: 0, noAgentId: 0, agents: new Set() },
    matrix: {},
    mainBySid: new Map(), subAgg: new Map(), subRequests: 0, subAggDropped: 0, askMain: { known: 0, same: 0 },
    dec: { lastRewriteMs: 0, rows: 0, probe: 0, helperRows: 0, helperRewritten: 0, mainLearnNonMain: 0, observed: obsAcc(), observedLive: obsAcc(), hashes: new Set() },
    ag: { rows: 0, probe: 0, observed: obsAcc() },
    hash: crypto.createHash("sha256"),
  };
}
const bumpType = (m, k) => { if (!m.has(k) && m.size >= CAPS.types) k = "~other"; m.set(k, (m.get(k) ?? 0) + 1); };
function addMatrix(acc, truth, cls) { const r = (acc.matrix[truth] ??= { main: 0, sub: 0, exempt: 0, aux: 0, other: 0 }); r[cls] += 1; }
/** A helper request is a T2 violation when the router called it sub, exempt or other, or main although an agent id or the billing flag was set; main on a request with neither is a passthrough, never a rewrite. */
const helperViolation = (cls, agentShaped) => cls === "sub" || cls === "exempt" || cls === "other" || (cls === "main" && agentShaped);
const agentKey = (r) => `${r.sid}:${r.aid ?? "?"}`;

function feedClass(acc, o) {
  acc.rows += 1;
  const r = normClassRow(o);
  if (!r) { acc.malformed += 1; return; }
  if (r.ms < acc.cutoff) { if (acc.excl) feedClass(acc.excl, o); return; }   // before the --since bound: counted in a side accumulator, so the bound's effect is visible, never in the verdict
  if (r.ms > acc.nowMs + THRESHOLDS.futureToleranceMs) { acc.future += 1; return; }   // a future-dated line is a clock fault (and could mint a second UTC day): not counted
  acc.inWindow += 1;
  if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; return; }
  acc.client += 1;
  if (r.nt === null) { acc.noToolCount += 1; return; }
  acc.counted += 1;
  acc.newest = Math.max(acc.newest, r.ms); acc.oldest = Math.min(acc.oldest, r.ms);
  acc.cls[r.cls] += 1;
  if (r.rc) acc.rcLogged += 1;
  if (r.at) acc.atLogged += 1;
  if (acc.sessionCounts.has(r.sid) || acc.sessionCounts.size < CAPS.sessions) acc.sessionCounts.set(r.sid, (acc.sessionCounts.get(r.sid) ?? 0) + 1);
  acc.days.add(r.day);
  acc.hash.update(`${r.ms}|${r.sid}|${r.cls}|${+r.ag}${+r.bl}|${r.nt}|${r.rc ?? ""}\n`);
  const agentShaped = r.ag || r.bl, tools = r.nt > 0, key = agentKey(r);
  const rcSub = r.rc === "subagent" || r.rc === "workflow", rcHelper = r.rc === "compaction" || r.rc === "auxiliary";
  // ---- detector consensus (REPORTED only): what the two signals say, whatever rc says
  // an rc-labelled helper is routed to the aux path whatever its detectors say (router v4), so it is NOT a consensus sample: counted apart, never as a regression of the sub or main counters
  if (rcHelper) acc.cons.helperExcluded += 1;
  else if (!agentShaped) { acc.cons.main.n += 1; if (r.cls === "main") acc.cons.main.ok += 1; }
  else if (r.ag && r.bl && tools) { acc.cons.sub.n += 1; if (r.cls === "sub" || r.cls === "exempt") acc.cons.sub.ok += 1; }
  // ---- types and agents
  if (agentShaped && tools && r.rc !== "main" && !rcHelper) {
    bumpType(acc.subTypes, r.at ? `at:${r.at}` : r.ag && r.bl ? "built-in" : r.ag ? "teammate" : "billing-only");
    if (r.bl || rcSub) { if (acc.builtAgents.size < CAPS.agents) acc.builtAgents.add(key); else acc.agentsCapped = true; }
  }
  if (r.bl) { acc.builtIn.n += 1; if (!r.ag) acc.builtIn.noAgentId += 1; if (acc.builtIn.agents.size < CAPS.agents) acc.builtIn.agents.add(key); }
  // ---- ground truth: rc only
  if (r.rc === "main") {
    const m = acc.main; m.n += 1;
    if (r.cls !== "main") m.notMain[r.cls] += 1;
    m.sessions.add(r.sid);
    if (tools) {                                                    // a /model switch is judged on tool-carrying main rows only
      let s = m.models.get(r.sid);
      if (!s && m.models.size < CAPS.sessions) { s = new Set(); m.models.set(r.sid, s); }
      if (s && s.size < 4 && r.m) s.add(r.m);
    }
    addMatrix(acc, "main", r.cls);
  } else if (rcSub) {
    if (tools) {
      const t = acc.t1; t.n += 1;
      const miss = r.cls !== "sub" && r.cls !== "exempt";
      if (r.cls === "sub") t.sub += 1; else if (r.cls === "exempt") { t.sub += 1; t.exempt += 1; } else t.missBy[r.cls] += 1;
      if (t.agents.has(key) || t.agents.size < CAPS.agents) t.agents.set(key, (t.agents.get(key) ?? false) || miss); else t.agentsCapped = true;
      addMatrix(acc, "sub", r.cls);
    } else { acc.toolless.n += 1; addMatrix(acc, "sub-toolless", r.cls); }
  } else if (rcHelper) {
    const h = acc.helper.rc; h.n += 1;
    if (r.cls === "aux") h.aux += 1; else if (helperViolation(r.cls, agentShaped)) { h.viol[r.cls] += 1; acc.helper.lastViolMs = Math.max(acc.helper.lastViolMs, r.ms); } else h.passthroughMain += 1;
    bumpType(h.byType, r.rc);
    addMatrix(acc, `helper-${r.rc}`, r.cls);
  } else if (agentShaped && !tools) {
    const h = acc.helper.shaped; h.n += 1;                          // helper-shaped by the detectors alone: reported, and a violation still fails (a router that calls it sub is wrong whatever rc says)
    if (r.cls === "aux") h.aux += 1; else if (helperViolation(r.cls, true)) { h.viol[r.cls] += 1; acc.helper.lastViolMs = Math.max(acc.helper.lastViolMs, r.ms); }
    addMatrix(acc, "helper-shaped", r.cls);
  } else if (!agentShaped && !tools && !r.rc && r.cls === "main") acc.helper.unlabelledMain += 1;
  if (!r.rc && agentShaped && tools && !(r.ag && r.bl)) { acc.single.n += 1; if (r.cls === "sub" || r.cls === "exempt") acc.single.sub += 1; addMatrix(acc, "single-detector", r.cls); }
  // ---- main model memory and the subagent aggregate for the tally
  if (r.cls === "main" && r.ga && r.m && r.sid) acc.mainBySid.set(r.sid, { ms: r.ms, m: r.m });
  if ((r.cls === "sub" || r.cls === "exempt") && tools && r.m) {
    const mm = acc.mainBySid.get(r.sid), main = mm && r.ms - mm.ms <= MAIN_TTL_MS && r.ms >= mm.ms ? mm.m : null;
    const tcb = r.tc === null ? "" : Math.ceil(r.tc / 2000) * 2000;
    const k = `${r.m}\u0000${main ?? ""}\u0000${tcb}\u0000${r.bb ?? ""}`;
    const e = acc.subAgg.get(k);
    if (e) e.n += 1; else if (acc.subAgg.size < CAPS.tallyKeys) acc.subAgg.set(k, { asked: r.m, main, tc: tcb === "" ? null : tcb, bytes: r.bb ? BYTE_BUCKETS[r.bb] : 0, n: 1 }); else acc.subAggDropped += 1;
    acc.subRequests += 1;
    if (main) { acc.askMain.known += 1; if (main === r.m) acc.askMain.same += 1; }
  }
}
function feedObserved(o, d) {
  if (!OBSERVED_ACTS.has(d.act) || !d.asked) return;
  o.n += 1;
  bump(o.askedByProvider, providerOf(d.asked), 1);
  if (d.would === null) { if (d.act === "keep") o.keep += 1; else o.none += 1; }
  else if (d.would === d.asked) o.keep += 1;
  else { o.moved += 1; bump(o.byModel, d.would, 1); bump(o.byProvider, providerOf(d.would), 1); }
}
function feedDecision(acc, o, liveHash) {
  const d = normDecision(o);
  if (d && d.ms < acc.cutoff && acc.excl) feedDecision(acc.excl, o, liveHash);
  if (!d || d.ms < acc.cutoff || d.ms > acc.nowMs + THRESHOLDS.futureToleranceMs) return;
  acc.dec.rows += 1;
  if (isProbeSid(d.sid)) { acc.dec.probe += 1; return; }
  if ((d.ag || d.bl) && d.tools === 0) { acc.dec.helperRows += 1; if (d.asked && d.ret && d.ret !== d.asked) { acc.dec.helperRewritten += 1; acc.dec.lastRewriteMs = Math.max(acc.dec.lastRewriteMs, d.ms); } }
  // Only a main-learn row with an agent id or the billing flag is seen here. NOT detected: a main-class rc helper (rc auxiliary or compaction, no detector, Agent tool present) that router v3 sends down the
  // main path, where it calls learnMain with the helper's asked model; its decision row carries no detector and cannot be told from a real main request. Router v4 routes every rc helper to the aux path,
  // so it can no longer reach learnMain: the leg is only a gap against v3 logs, and nothing is polluted while the helper asks the main model itself. Deliberately no counter for it.
  if (d.act === "main-learn" && (d.ag || d.bl)) acc.dec.mainLearnNonMain += 1;
  if (d.role === "sub") {
    if (d.ph && OBSERVED_ACTS.has(d.act)) acc.dec.hashes.add(d.ph);
    feedObserved(acc.dec.observed, d);
    if (liveHash && d.ph === liveHash) feedObserved(acc.dec.observedLive, d);
  }
}
function feedAgent(acc, o) {
  const a = normAgent(o);
  if (!a || a.ms < acc.cutoff || a.ms > acc.nowMs + THRESHOLDS.futureToleranceMs) return;
  acc.ag.rows += 1;
  if (isProbeSid(a.sid)) { acc.ag.probe += 1; return; }
  feedObserved(acc.ag.observed, a);
}

/** What the --since bound discarded (null without a bound): client rows before it, and how many of them were T1 misses, T2 violations or T4 misses, so a bound can never hide its own effect. */
function excludedByFrom(acc) {
  const x = acc.excl;
  if (!x) return null;
  const t1Miss = x.t1.missBy.main + x.t1.missBy.aux + x.t1.missBy.other, t2Viol = sumArms(x.helper.rc.viol) + sumArms(x.helper.shaped.viol) + x.dec.helperRewritten, t4Miss = sumArms(x.main.notMain) + x.dec.mainLearnNonMain;
  return { rows: x.counted, t1Miss, t2Viol, t4Miss, violations: t1Miss + t2Viol + t4Miss };
}
const mk = (id, name, status, reason, extra = {}) => ({ id, name, status, reason, ...extra });
const sumArms = (a) => a.sub + a.exempt + a.main + a.other;
/**
 * Computes every metric from an accumulator. Returns the full record (also the JSON). `versions` = {cc, ccr} (T6). Pure given the accumulator.
 */
export function evaluate(acc, { versions = {}, nowMs = acc.nowMs } = {}) {
  const T = THRESHOLDS, M = MIN_SAMPLES;
  const sessions = [...acc.sessionCounts.values()].filter((n) => n >= M.perSession).length, days = acc.days.size;
  const newestAgeDays = acc.newest ? (nowMs - acc.newest) / DAY_MS : null;
  const missing = [];
  const metrics = {};
  const groundTruthMissing = acc.rcLogged === 0;
  const gtLine = `ground truth missing: rc is logged on 0 of ${num(acc.counted)} rows; ${HINT_LINE}`;
  if (groundTruthMissing) missing.push(gtLine);
  // ---- T1: rc-labelled tool-carrying subagent requests, from distinct built-in agents
  const t1 = acc.t1, miss = t1.missBy.main + t1.missBy.aux + t1.missBy.other;
  const agN = t1.agents.size, agK = [...t1.agents.values()].filter((x) => !x).length;
  const wReq = wilsonLower(t1.sub, t1.n), wAg = wilsonLower(agK, agN), bound = Math.min(wReq, wAg), need = samplesForBound();
  {
    const popText = `${num(t1.n)} rc-labelled tool-carrying subagent requests from ${num(agN)} distinct built-in agents`;
    let status, reason;
    const ratePass = t1.n > 0 && 100 * (t1.sub / t1.n) >= T.t1Pct && 100 * bound >= T.t1Wilson;
    if (t1.n < M.t1) { status = "INSUFFICIENT"; reason = `${num(t1.n)} of ${num(M.t1)} rc-labelled tool-carrying subagent requests${miss ? `; ${miss} already classified other than sub (aux ${t1.missBy.aux}, main ${t1.missBy.main}, other ${t1.missBy.other})` : ""}`; missing.push(`T1 needs ${num(M.t1 - t1.n)} more rc-labelled subagent requests`); }
    else if (agN < M.distinctAgents) { status = "INSUFFICIENT"; reason = `${num(agN)} of ${M.distinctAgents} distinct built-in agents (${num(t1.n)} rc-labelled requests come from them; requests cluster per agent)`; missing.push(`T1 needs ${M.distinctAgents - agN} more distinct built-in agents`); }
    else if (ratePass) { status = "PASS"; reason = `${pctText(t1.sub, t1.n, 2)} classified sub of ${popText} (Wilson lower bound ${(100 * wReq).toFixed(1)}% per request, ${(100 * wAg).toFixed(1)}% per agent; the lower binds)`; }
    else if (miss > 0) { status = "FAIL"; reason = `${pctText(t1.sub, t1.n, 2)} classified sub of ${popText}; Wilson lower bound ${(100 * wReq).toFixed(1)}% per request, ${(100 * wAg).toFixed(1)}% per agent; need at least ${T.t1Pct}% and ${T.t1Wilson}%`; }
    else { status = "INSUFFICIENT"; reason = `no miss in ${popText}, but the per-agent Wilson lower bound is ${(100 * wAg).toFixed(1)}%: ${need} distinct built-in agents with no miss are needed for ${T.t1Wilson}%`; missing.push(`T1 needs ${Math.max(0, need - agN)} more distinct built-in agents for the ${T.t1Wilson}% bound`); }
    metrics.T1 = mk("T1", "subagent requests classified sub", status, reason, { population: popText, n: t1.n, k: t1.sub, exempt: t1.exempt, misses: miss, agents: agN, agentsWithoutMiss: agK, pct: t1.n ? +(100 * t1.sub / t1.n).toFixed(3) : null,
      wilsonLowerRequests: +(100 * wReq).toFixed(3), wilsonLowerAgents: +(100 * wAg).toFixed(3), wilsonLower: +(100 * bound).toFixed(3), agentsForBound: need,
      need: `at least ${T.t1Pct}% and Wilson lower bound (per request and per agent, the lower binds) at least ${T.t1Wilson}%, over at least ${M.t1} rc-labelled requests from at least ${M.distinctAgents} agents` });
  }
  // ---- detector consensus: REPORTED, never gated
  {
    const c = acc.cons;
    metrics.CONS = mk("CONS", "detector consensus", "REPORTED", `${num(c.sub.ok)} of ${num(c.sub.n)} requests with both detectors set and tools were classified sub, ${num(c.main.ok)} of ${num(c.main.n)} requests with neither detector set were classified main (${num(c.helperExcluded)} rc-labelled helper rows are left out of both counts: the router routes them to the aux path whatever their detectors say); the router's class is a function of these two signals, so this checks only that it agrees with itself and is not gated`, { helperExcluded: c.helperExcluded, subN: c.sub.n, subOk: c.sub.ok, mainN: c.main.n, mainOk: c.main.ok });
  }
  // ---- T2: rc-labelled helpers, plus the zero-tolerance legs
  const hr = acc.helper.rc, hs = acc.helper.shaped;
  const hViol = sumArms(hr.viol) + sumArms(hs.viol) + acc.dec.helperRewritten;
  {
    let status, reason;
    const lastViol = Math.max(acc.helper.lastViolMs, acc.dec.lastRewriteMs), instantAfter = (ms) => new Date(ms + 1000).toISOString();
    const sinceHint = lastViol > 0 && (acc.fromMs === null || acc.fromMs <= lastViol) ? `; the newest is dated ${new Date(lastViol).toISOString()}: if the router was fixed after that, --since ${instantAfter(lastViol)} starts the window just after it (the bound applies to EVERY metric, T1 and T4 as well as T2, and what it discards is recorded as window.excludedByFrom; older rows keep the old misclassification until they age out of the ${T.maxAgeDays}-day window)` : "";
    if (hViol > 0) { status = "FAIL"; reason = `${hViol} helper calls classified sub, exempt or other (or main with a detector set), or returned on another model: ${sumArms(hr.viol)} of ${num(hr.n)} rc-labelled helper requests, ${sumArms(hs.viol)} of ${num(hs.n)} detector-shaped helper requests, ${acc.dec.helperRewritten} of ${num(acc.dec.helperRows)} helper-shaped decision-log rows${sinceHint}`; }
    else if (hr.n < T.t2MinHelpers) { status = "INSUFFICIENT"; reason = `${num(hr.n)} of ${num(T.t2MinHelpers)} rc-labelled helper requests (compaction or auxiliary); no helper call rewritten so far in ${num(hs.n)} detector-shaped helper requests`; missing.push(`T2 needs ${num(T.t2MinHelpers - hr.n)} more rc-labelled helper requests`); }
    else { status = "PASS"; reason = `0 helper calls rewritten of ${num(hr.n)} rc-labelled helper requests (${num(hr.passthroughMain)} passed through as main, never rewritten)`; }
    metrics.T2 = mk("T2", "helper calls rewritten", status, reason, { n: hr.n, aux: hr.aux, rewritten: hViol, classifiedSub: hr.viol.sub + hs.viol.sub, passthroughMain: hr.passthroughMain, detectorShaped: hs.n,
      unlabelledHelperShapedMain: acc.helper.unlabelledMain, decisionRowsHelperShaped: acc.dec.helperRows, decisionRowsRewritten: acc.dec.helperRewritten, need: `zero rewritten in at least ${T.t2MinHelpers} rc-labelled helper requests` });
  }
  // ---- T3 (reported)
  metrics.T3 = mk("T3", "tool-less real subagents", "REPORTED", acc.rcLogged ? `${num(acc.toolless.n)} tool-less requests labelled subagent by rc of ${num(t1.n + acc.toolless.n)} rc-labelled subagent requests (${pctText(acc.toolless.n, t1.n + acc.toolless.n)}; the owner is told above 5%)` : `not observable: rc is not logged on any of ${num(acc.counted)} client requests, so a tool-less real subagent cannot be told from a helper call`, { n: acc.toolless.n, of: t1.n + acc.toolless.n });
  // ---- T4: rc-labelled main requests
  const mn = acc.main, mMiss = sumArms(mn.notMain), mViol = mMiss + acc.dec.mainLearnNonMain;
  {
    let status, reason;
    if (mViol > 0) { status = "FAIL"; reason = `${mMiss} of ${num(mn.n)} rc-labelled main requests classified other than main and ${acc.dec.mainLearnNonMain} main-learn events caused by a non-main request`; }
    else if (mn.n < M.main) { status = "INSUFFICIENT"; reason = `${num(mn.n)} of ${num(M.main)} rc-labelled main requests (none misclassified so far)`; missing.push(`T4 needs ${num(M.main - mn.n)} more rc-labelled main requests`); }
    else { status = "PASS"; reason = `0 misclassified of ${num(mn.n)} rc-labelled main requests`; }
    metrics.T4 = mk("T4", "main requests misclassified", status, reason, { n: mn.n, misclassified: mMiss, mainLearnNonMain: acc.dec.mainLearnNonMain, need: `zero in at least ${M.main} rc-labelled main requests` });
  }
  // ---- T5 (built-in only; two independent header signals, needs no rc)
  {
    const b = acc.builtIn, rate = b.n ? 100 * b.noAgentId / b.n : 0, agentsB = b.agents.size;
    let status, reason;
    if (b.n < M.builtIn) { status = "INSUFFICIENT"; reason = `${num(b.n)} of ${num(M.builtIn)} built-in subagent requests (the billing flag set)`; missing.push(`T5 needs ${num(M.builtIn - b.n)} more built-in subagent requests (the billing flag set)`); }
    else if (agentsB < M.distinctAgents) { status = "INSUFFICIENT"; reason = `${num(agentsB)} of ${M.distinctAgents} distinct built-in agents (${num(b.n)} built-in requests come from them)`; missing.push(`T5 needs ${M.distinctAgents - agentsB} more distinct built-in agents`); }
    else if (rate <= T.t5MaxDisagreePct) { status = "PASS"; reason = `${pctText(b.noAgentId, b.n, 2)} of ${num(b.n)} built-in requests from ${num(agentsB)} agents had no agent id`; }
    else { status = "FAIL"; reason = `${pctText(b.noAgentId, b.n, 2)} of ${num(b.n)} built-in requests had no agent id; at most ${T.t5MaxDisagreePct}%`; }
    metrics.T5 = mk("T5", "detector disagreement, built-in only", status, reason, { n: b.n, disagree: b.noAgentId, agents: agentsB });
  }
  // ---- T6
  {
    const cc = wholeVersion(versions.cc, { suffix: "(Claude Code)" }), ccr = wholeVersion(versions.ccr), ok = !!(cc && ccr);
    metrics.T6 = mk("T6", "versions recorded", ok ? "PASS" : "INSUFFICIENT", ok ? `Claude Code ${clip(cc, 40)}, CCR ${clip(ccr, 40)}, measured ${new Date(nowMs).toISOString().slice(0, 10)}` : "Claude Code and CCR versions are not recorded as whole versions (x.y.z): pass --cc-version and --ccr-version (an update of either invalidates the verdict)", { cc: cc ?? null, ccr: ccr ?? null });
    if (!ok) missing.push("T6 needs --cc-version and --ccr-version");
  }
  // ---- minimums
  const mins = [];
  const addMin = (id, have, needN, noun, detail = "") => { const ok = have >= needN; const text = ok ? `${noun}: ${num(have)} (need ${num(needN)})${detail}` : `${num(have)} of ${num(needN)} ${noun}${detail}`; mins.push({ id, have, need: needN, ok, text }); if (!ok) missing.push(text); };
  const typeRows = [...acc.subTypes.entries()].sort((a, b) => b[1] - a[1]);
  const typesMet = typeRows.filter(([, n]) => n >= M.perSubagentType).length;
  const totalSub = typeRows.reduce((a, [, n]) => a + n, 0);
  const typeText = typeRows.map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none";
  const atOnSub = typeRows.filter(([k]) => k.startsWith("at:")).reduce((a, [, n]) => a + n, 0);
  addMin("subagent-types", typesMet, M.subagentTypes, `subagent types with ${M.perSubagentType} requests each`, ` (${typeText})${atOnSub === 0 && totalSub > 0 ? `; agent type is not logged (at null on ${num(totalSub)} of ${num(totalSub)} tool-carrying subagent-shaped requests), so only the kinds built-in, teammate and billing-only exist: set CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 or record a labelled window` : ""}`);
  addMin("distinct-agents", acc.builtAgents.size, M.distinctAgents, "distinct built-in agents (session and agent id pairs; teammates do not count)");
  const hl = [...hr.byType.entries()], hlShort = hl.filter(([, n]) => n < M.perLabelledHelperType);
  addMin("helper-total", hr.n, M.helperTotal, "rc-labelled helper requests (compaction or auxiliary)", ` (${hl.map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  if (hl.length) addMin("helper-types", hl.length - hlShort.length, hl.length, `labelled helper types with ${M.perLabelledHelperType} requests each`, ` (short: ${hlShort.map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  else mins.push({ id: "helper-types", have: 0, need: 0, ok: true, text: "helper types (title, compaction, small-fast, summary): only compaction and auxiliary are labelled by rc; the others cannot be told apart, so the total of rc-labelled helper requests is what is checked" });
  let switches = 0; for (const s of mn.models.values()) if (s.size >= 2) switches += 1;
  addMin("main", mn.n, M.main, "rc-labelled main requests");
  addMin("main-sessions", mn.sessions.size, M.mainSessions, "sessions with rc-labelled main requests");
  addMin("main-model-switch", switches, M.mainModelSwitches, "sessions whose main model changed on tool-carrying requests (a /model switch)");
  addMin("sessions", sessions, M.sessions, `client sessions with at least ${M.perSession} requests`);
  addMin("days", days, M.days, "UTC days with client traffic");
  // ---- age: the newest counted request must be recent; the 30 days is the expiry of a written PASS
  const ageOk = newestAgeDays !== null && newestAgeDays < T.maxEvidenceAgeDays;
  const age = mk("AGE", "evidence age", ageOk ? "PASS" : "INSUFFICIENT", newestAgeDays === null ? "no client request in the window" : `newest client request ${newestAgeDays.toFixed(1)} days old (limit ${T.maxEvidenceAgeDays}); a written PASS expires ${T.maxAgeDays} days after it is written`, { newestAgeDays });
  if (!ageOk) missing.push(`AGE: no client request younger than ${T.maxEvidenceAgeDays} days`);
  const gated = [metrics.T1, metrics.T2, metrics.T4, metrics.T5, metrics.T6, age];
  const verdict = gated.some((x) => x.status === "FAIL") ? "FAIL" : gated.every((x) => x.status === "PASS") && mins.every((x) => x.ok) ? "PASS" : "INSUFFICIENT";
  return { verdict, metrics, age, minimums: mins, missing, groundTruthMissing, groundTruthLine: groundTruthMissing ? gtLine : null, matrix: acc.matrix, kinds: KINDS_NOTE, typeCounts: Object.fromEntries(typeRows), helperTypeCounts: Object.fromEntries(hr.byType), sessions, days: [...acc.days].sort(), newestAgeDays };
}

// ------------------------------------------------------------------ the three-mode policies
const MODES = Object.freeze(["dynamic", "inherit", "free"]);
/** Compiles the policy of each mode from the on-disk inputs (snapshot, bench, tool fidelity, owner file): no gateway call unless --providers-file is given. Returns {views, base, live} or {error}. */
async function buildViews(p, { nowMs, providersFile }) {
  try {
    const g = await gatherInputs(p, { nowMs, ...(providersFile ? {} : { liveProviders: null }) });
    let base = { ...OWNER_DEFAULTS, source: "all-providers" };
    try { const o = p.policyFile ? loadOwner(p.policyFile) : null; if (o) base = o; } catch { /* a corrupt owner file: the defaults stand */ }
    const views = {};
    for (const mode of MODES) views[mode] = policyView(compile(g, { ...base, mode, enforcement: "shadow", allow: base.allow ?? [] }).compiled);
    const live = readJsonFile(p.compiledFile);
    const lv = live.ok ? live.value : null;
    const same = lv && views[lv.owner?.mode];
    return { views, base: { source: base.source, freeScope: base.freeScope, ctx: base.ctx, unverified: base.unverified }, providersLive: g.providersLive,
      live: lv ? { mode: lv.owner?.mode ?? null, rows: Array.isArray(lv.models) ? lv.models.length : null, contentHash: typeof lv.contentHash === "string" ? lv.contentHash : null, recompiledRows: same ? views[lv.owner.mode].pol.models.length : null } : null };
  } catch (e) { return { error: e instanceof PolicyError ? e.message.slice(0, 200) : `${e?.code ?? e?.name ?? "error"}` }; }
}

const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => [k, +v.toFixed(2)]);
const obsOut = (o) => ({ n: o.n, keep: o.keep, moved: o.moved, none: o.none, byProvider: topN(o.byProvider, 12), byModel: topN(o.byModel, 12), askedByProvider: topN(o.askedByProvider, 6) });
const tallyOut = (t) => ({ mode: t.mode, source: t.source, rows: t.rows, requests: t.requests, keep: t.keep, moved: t.moved, none: t.none, noMain: t.noMain, byProvider: topN(t.byProvider, 15), byModel: topN(t.byModel, 15) });

/**
 * The whole evaluation of a state folder. `p` = resolved paths ({stateDir, ...}). Returns {record, text}: record is the JSON shape, text the lines.
 */
export async function runEvaluation(p, { nowMs = Date.now(), sinceMsV = 30 * DAY_MS, sinceDate = null, versions = {}, tally = true, providersFile = false, sample = null } = {}) {
  const acc = newAcc(nowMs, sinceMsV, sinceDate === null ? null : Date.parse(sinceDate));
  let liveHash = null;
  const lv = readJsonFile(p.compiledFile ?? path.join(p.stateDir, "policy.json"));
  if (lv.ok && typeof lv.value?.contentHash === "string") liveHash = lv.value.contentHash.slice(0, 16);
  let k = 0;
  const clog = streamJsonl(p.stateDir, CLASS_FILES, (o) => { feedClass(acc, o); if (sample && (++k & 4095) === 0) sample(); });
  const dlog = streamJsonl(p.stateDir, DECISION_FILES, (o) => feedDecision(acc, o, liveHash), { maxBytes: 8 * 1024 * 1024 });
  const alog = streamJsonl(p.stateDir, AGENT_FILES, (o) => feedAgent(acc, o), { maxBytes: 8 * 1024 * 1024 });
  const ev = evaluate(acc, { versions, nowMs });
  let tallies = null, tallyNote = null, policies = null, comparison = null;
  if (tally) {
    const v = await buildViews(p, { nowMs, providersFile });
    if (v.error) tallyNote = `shadow tally per mode unavailable: ${v.error}`;
    else {
      policies = { base: v.base, live: v.live, providersLive: v.providersLive, modes: Object.fromEntries(Object.entries(v.views).map(([n, x]) => [n, x.pol.models.length])) };
      const raw = shadowTally([...acc.subAgg.values()], v.views);
      tallies = raw.map(tallyOut);
      const liveMode = v.live?.mode, mt = raw.find((t) => t.mode === liveMode), obs = acc.dec.observedLive.n ? acc.dec.observedLive : acc.dec.observed;
      if (mt && obs.moved > 0 && mt.moved > 0) {
        comparison = { mode: liveMode, basis: acc.dec.observedLive.n ? `policy ${liveHash}` : "every policy in the window", observedMoved: obs.moved, modelledMoved: mt.moved,
          providers: compareShares({ map: mt.byProvider, total: mt.moved }, { map: obs.byProvider, total: obs.moved }), models: compareShares({ map: mt.byModel, total: mt.moved }, { map: obs.byModel, total: obs.moved }) };
      }
    }
  }
  const evidence = { classRowsCounted: acc.counted, sha256: acc.hash.digest("hex"), policyContentHash: lv.ok && typeof lv.value?.contentHash === "string" ? lv.value.contentHash : null };
  const record = {
    schema: ACCURACY_SCHEMA, verdict: ev.verdict, at: new Date(nowMs).toISOString(), ccVersion: ev.metrics.T6.cc, ccrVersion: ev.metrics.T6.ccr,
    minSamples: MIN_SAMPLES, thresholds: THRESHOLDS, matrix: ev.matrix, groundTruthMissing: ev.groundTruthMissing,
    window: { from: sinceDate === null ? null : new Date(acc.fromMs).toISOString(), excludedByFrom: excludedByFrom(acc), since: new Date(acc.cutoff).toISOString(), until: new Date(nowMs).toISOString(), days: ev.days, newestAgeDays: ev.newestAgeDays === null ? null : +ev.newestAgeDays.toFixed(2) },
    populations: { classifierLines: acc.rows, inWindow: acc.inWindow, probeExcluded: acc.probe, probeAgentShaped: acc.probeAgentShaped, futureExcluded: acc.future, unreadableOrMalformed: acc.malformed + clog.unreadableLines, noToolCount: acc.noToolCount, clientCounted: acc.counted, sessions: acc.sessionCounts.size, sessionsQualified: ev.sessions, rcLogged: acc.rcLogged, atLogged: acc.atLogged,
      classes: acc.cls, decisionRows: acc.dec.rows, decisionProbeExcluded: acc.dec.probe, agentRows: acc.ag.rows, agentProbeExcluded: acc.ag.probe },
    metrics: ev.metrics, age: ev.age, minimums: ev.minimums, missing: ev.missing, typeCounts: ev.typeCounts, helperTypeCounts: ev.helperTypeCounts,
    single: { n: acc.single.n, classifiedSub: acc.single.sub, note: KINDS_NOTE },
    shadow: { subagentRequests: acc.subRequests, droppedKeys: acc.subAggDropped, askedMain: acc.askMain, modes: tallies, note: tallyNote, policies, comparison,
      observed: { requests: obsOut(acc.dec.observed), requestsUnderLivePolicy: obsOut(acc.dec.observedLive), agents: obsOut(acc.ag.observed), policyHashesSeen: acc.dec.hashes.size, liveHash } },
    evidence, logs: { classify: clog, decisions: dlog, agents: alog },
  };
  return { record, text: renderText(record) };
}

// ------------------------------------------------------------------ text
const fileLine = (name, l) => {
  const read = l.files.filter((f) => f.state === "read"), absent = l.files.filter((f) => f.state === "absent"), bad = l.files.filter((f) => f.state === "unreadable"), tr = l.files.filter((f) => f.truncated);
  let s = `${name}: read ${(l.readBytes / 1048576).toFixed(1)} of ${(l.keptBytes / 1048576).toFixed(1)} MiB (${read.length} of ${l.files.length} files)`;
  if (tr.length) s += `; TRUNCATED to the newest part of ${tr.map((f) => f.name).join(", ")}`;
  if (absent.length) s += `; absent: ${absent.map((f) => f.name).join(", ")}`;
  if (bad.length) s += `; UNREADABLE: ${bad.map((f) => `${f.name} (${clip(f.why ?? "?", 30)})`).join(", ")}`;
  if (l.unreadableLines) s += `; ${l.unreadableLines} unreadable lines skipped`;
  return s;
};
const shareLine = (label, n, of) => `${label} ${num(Math.round(n))} (${pctText(n, of)})`;
export function renderText(r) {
  const L = [], P = r.populations;
  L.push(`CLASSIFIER ACCURACY: ${r.verdict}   (window ${r.window.since.slice(0, 10)} to ${r.window.until.slice(0, 10)}${r.window.from ? `, bounded from ${r.window.from} by --since: discarded ${num(r.window.excludedByFrom.rows)} client rows incl. ${num(r.window.excludedByFrom.violations)} violations (T1 misses ${r.window.excludedByFrom.t1Miss}, T2 ${r.window.excludedByFrom.t2Viol}, T4 ${r.window.excludedByFrom.t4Miss}); the bound applies to every metric` : ""}, newest counted request ${r.window.newestAgeDays === null ? "n/a" : `${r.window.newestAgeDays} days`} old)`);
  if (r.groundTruthMissing) L.push(`GROUND TRUTH MISSING: rc is logged on 0 of ${num(P.clientCounted)} rows; ${HINT_LINE}. Without it T1, T2 and T4 can only show that the router agrees with itself, so they cannot reach PASS. If the setting is already in ~/.claude/settings.json, only Claude Code sessions started after it send rc; running sessions keep the old behaviour until restarted.`);
  L.push(fileLine("classifier log", r.logs.classify));
  L.push(fileLine("decision log", r.logs.decisions));
  L.push(fileLine("agent log", r.logs.agents));
  L.push(`EXCLUDED from every denominator below: ${num(P.probeExcluded)} of ${num(P.inWindow)} classifier lines in the window are sessionless probe traffic (hasSid false or a "nosession" id; ${num(P.probeAgentShaped)} of them agent-shaped); ${num(P.decisionProbeExcluded)} sessionless decision rows and ${num(P.agentProbeExcluded)} sessionless agent rows${P.futureExcluded ? `; ${num(P.futureExcluded)} lines dated more than 5 minutes in the future` : ""}${P.unreadableOrMalformed ? `; ${num(P.unreadableOrMalformed)} unreadable or malformed lines` : ""}${P.noToolCount ? `; ${num(P.noToolCount)} client lines without a tool count` : ""}`);
  L.push(`COUNTED: ${num(P.clientCounted)} client requests in ${P.sessions} sessions (${P.sessionsQualified} with at least ${MIN_SAMPLES.perSession} requests) on ${r.window.days.length} UTC days: main ${num(P.classes.main)}, sub ${num(P.classes.sub)}, aux ${num(P.classes.aux)}, exempt ${num(P.classes.exempt)}${P.classes.other ? `, other ${num(P.classes.other)}` : ""}. rc (the client's own class, the only ground truth) is logged on ${num(P.rcLogged)} of ${num(P.clientCounted)}, the agent type on ${num(P.atLogged)}.`);
  L.push("");
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) { const m = r.metrics[id]; L.push(`${id} ${m.name}: ${m.status}: ${m.reason}`); }
  L.push(`AGE ${r.age.name}: ${r.age.status}: ${r.age.reason}`);
  L.push(`CONSENSUS (REPORTED, not gated): ${r.metrics.CONS.reason}`);
  if (r.single.n) L.push(`UNCORROBORATED (one detector, no rc; ${KINDS_NOTE}): ${num(r.single.n)} tool-carrying requests, ${shareLine("classified sub", r.single.classifiedSub, r.single.n)}; they are not in T1 because nothing independent confirms them`);
  const hrs = r.metrics.T2;
  L.push(`HELPER EVIDENCE: the router does not log a returned model for a helper request; ${num(hrs.decisionRowsHelperShaped)} helper-shaped rows are in the decision log (${num(hrs.decisionRowsRewritten)} returned on another model); the router returns the asked model for aux and exempt requests by construction. ${num(hrs.unlabelledHelperShapedMain)} unlabelled helper-shaped main rows (no detector, no tools, no rc) are NOT T2 samples: without rc they cannot be told from a main request.`);
  L.push("");
  L.push("MINIMUM SAMPLES (all must be met, or the verdict is INSUFFICIENT, never PASS):");
  for (const m of r.minimums) L.push(`  ${m.ok ? "ok     " : "MISSING"} ${m.text}`);
  if (r.missing.length) { L.push(""); L.push("WHAT IS MISSING:"); for (const x of r.missing) L.push(`  - ${x}`); }
  L.push("");
  const sh = r.shadow;
  L.push(`SHADOW TALLY (G3 preconditions 1 and 7): ${num(sh.subagentRequests)} client subagent requests in the window (probe traffic excluded)${sh.droppedKeys ? `, ${sh.droppedKeys} not tallied (key cap)` : ""}.`);
  if (sh.note) L.push(`  ${sh.note}`);
  if (sh.modes) {
    const pl = sh.policies, ob = sh.observed;
    L.push(`  Modelled offline from the compiled policy of each mode (owner file toggles: source ${pl.base.source}, free scope ${pl.base.freeScope}, ctx ${pl.base.ctx}; inputs on disk, providers from the snapshot routable flag${pl.providersLive ? "" : ", NOT the live gateway"}); expected-value spread over the lead pool; payload caps use a representative size per log bucket; it ignores cooling and demotion, which move requests between models and cause part of the difference to the observed figures below.`);
    L.push(`  Observed modes: ${pl.live?.mode ?? "?"} only (the router's own shadow decisions under policy ${ob.liveHash ?? "?"}). dynamic and inherit are MODELLED ONLY, unvalidated: ${num(sh.askedMain.same)} of ${num(sh.askedMain.known)} subagent requests with a learned main ask the main model itself, so both modes keep nearly everything and no sample exercises their substitution.`);
    if (pl.live && pl.live.recompiledRows !== null) L.push(`  Cross-check: the live policy.json (mode ${pl.live.mode}) holds ${pl.live.rows} rows; this recompile of mode ${pl.live.mode} holds ${pl.live.recompiledRows}${pl.live.rows === pl.live.recompiledRows ? " (same)" : " (DIFFERENT: the live file was built from live Providers or newer inputs)"}.`);
    for (const t of sh.modes) {
      L.push(`  mode ${t.mode}${t.mode === "inherit" ? "" : ` (${t.rows} rows)`}: of ${num(t.requests)} subagent requests: ${shareLine("would move off the asked model", t.moved, t.requests)}, ${shareLine("keep it", t.keep, t.requests)}, ${shareLine("no eligible substitute", t.none, t.requests)}, ${shareLine("no learned main model", t.noMain, t.requests)}`);
      if (t.byProvider.length) L.push(`    by provider (of the ${num(t.moved)} that move): ${t.byProvider.map(([k, v]) => `${k} ${num(Math.round(v))}`).join(", ")}`);
      if (t.byModel.length) L.push(`    top models: ${t.byModel.slice(0, 8).map(([k, v]) => `${k} ${num(Math.round(v))}`).join(", ")}`);
    }
    if (sh.comparison) {
      const c = sh.comparison;
      L.push(`  MODELLED vs OBSERVED, mode ${c.mode}, share of the requests that move (modelled ${num(c.modelledMoved)} requests, observed ${num(c.observedMoved)} under ${c.basis}); difference in points:`);
      L.push(`    by provider: ${c.providers.map((x) => `${x.k} ${x.modelled}% vs ${x.observed}% (${x.diff >= 0 ? "+" : ""}${x.diff})`).join("; ")}`);
      L.push(`    by model: ${c.models.map((x) => `${x.k} ${x.modelled}% vs ${x.observed}% (${x.diff >= 0 ? "+" : ""}${x.diff})`).join("; ")}`);
      L.push(`    A remaining gap is the part the model does not reproduce (cooling and demotion at that moment, exact byte sizes, policy changes inside the window): read the modelled figures as approximate, the observed ones as exact for the policy then active; the observed shares rest on ${num(ob.agents.n)} agents, one sticky pick each, so they are lumpy.`);
    }
    for (const [label, o] of [["observed (the router's own shadow decisions, every policy in the window)", ob.requests], [`observed under the live policy ${ob.liveHash ?? "?"}`, ob.requestsUnderLivePolicy], ["observed per new agent (agents.jsonl: one line per agent)", ob.agents]]) {
      if (!o.n) { L.push(`  ${label}: no rows`); continue; }
      L.push(`  ${label}: of ${num(o.n)}: ${shareLine("would move", o.moved, o.n)}, ${shareLine("keep", o.keep, o.n)}, ${shareLine("no policy choice", o.none, o.n)}${o.byProvider.length ? `; by provider ${o.byProvider.slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
    }
  }
  L.push("");
  L.push(`This verdict is evidence for the owner's G3 decision, never the decision. Binding: ${num(r.evidence.classRowsCounted)} rows hashed ${r.evidence.sha256.slice(0, 12)}, policy ${r.evidence.policyContentHash ? r.evidence.policyContentHash.slice(0, 12) : "none"}.`);
  return L;
}

// ------------------------------------------------------------------ CLI
export const USAGE = [
  "usage: node keysync/subagent-accuracy.mjs [--since 7d|30d|DATE] [--json yes] [--write yes --live yes] [--cc-version V --ccr-version V] [--tally no]",
  "  Reads the router's classifier, decision and agent logs (read-only), excludes sessionless probe traffic, prints T1..T6 with PASS, FAIL or INSUFFICIENT and the shadow tally of the three modes.",
  "  A PASS needs rc (the client's own request class: CLAUDE_CODE_GATEWAY_HINT_HEADERS=1); detector-only evidence stays INSUFFICIENT.",
  "  --since DATE  start the window at a date (2026-10-07 or 2026-10-07T09:30:00Z, UTC): rows logged before it are not counted, in EVERY metric (T1, T2, T4 and T5 alike, not T2 only). A datetime needs Z or an offset. Use it after a router fix, so rows from before the fix do not fail T2. Printed in the header with what it discarded, recorded in accuracy.json as window.from and window.excludedByFrom. Default: none.",
  "  --since       evidence window, a number and h or d, at most 30d (a written PASS expires after 30 days; older lines are not counted). Default 30d. The newest counted request must be under 7 days old.",
  "  --json yes    print the whole record as JSON and nothing else on stdout (notes go to stderr).",
  "  --write yes --live yes   write state/subagent/accuracy.json (atomic). Dry by default; BOTH flags are required. The file replaces the previous verdict, including a PASS (a warning says so).",
  "  --cc-version, --ccr-version   the versions measured (T6); without them the verdict cannot be PASS.",
  "  --tally no    skip the three-mode tally (the log checks only).",
  "  Test flags (a fixture run): --state-dir DIR plus any of --snapshot-file --bench-file --observed-file --tool-fidelity-file --settings-file --default-model-file --registry-file --key-choices-file --vault-providers-file --providers-file --policy-file.",
  "  Exit: 0 computed (any verdict, INSUFFICIENT included), 1 write or read failure, 2 usage.",
].join("\n");
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;   // a date, or a datetime that STATES its zone (Z or an offset): a bare datetime would mean a different instant on every machine
const ISO_NO_ZONE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
/** True when the date part names a real day: 2026-02-30 would be read as March 2 by the parser, so it is refused (the date is rebuilt from its parts and must give the same text back). */
const realDay = (v) => { const [y, m, d] = v.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === v.slice(0, 10); };
/** The enforce gate's own rule (keysync/subagent-policy.mjs wholeVersion): x.y.z with an optional -pre or +build tag, nothing else; `suffix` is stripped first (Claude Code prints "2.1.289 (Claude Code)"). null when it is not a whole version. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;
export const wholeVersion = (v, { suffix = "" } = {}) => { let t = typeof v === "string" ? v.trim() : ""; if (suffix && t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim(); return VERSION_RE.test(t) ? t : null; };
const VALUE_FLAGS = ["since", "cc-version", "ccr-version", ...FILE_FLAGS];
const BOOL_FLAGS = ["json", "write", "live", "tally"];
export function parseAccuracyArgs(argv) {
  const flags = {};
  const bad = (m) => new PolicyError("E_USAGE", m, 2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw bad(`unexpected argument ${JSON.stringify(clip(a, 40))}`);
    const name = a.slice(2);
    if (!VALUE_FLAGS.includes(name) && !BOOL_FLAGS.includes(name)) throw bad(`unknown flag ${clip(a, 40)}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw bad(`flag ${a} needs an explicit value${BOOL_FLAGS.includes(name) ? " (yes or no)" : ""}`);
    i += 1;
    if (BOOL_FLAGS.includes(name)) { if (v !== "yes" && v !== "no") throw bad(`flag ${a} takes exactly yes or no, found ${JSON.stringify(clip(v, 20))}`); flags[name] = v === "yes"; continue; }
    if (name === "since" && ISO_NO_ZONE_RE.test(v)) throw bad(`flag --since ${JSON.stringify(clip(v, 40))} needs Z or an offset (like 2026-10-07T09:30:00Z or 2026-10-07T09:30:00+02:00): a datetime without a zone is a different instant on every machine`);
    if (name === "since" && ISO_RE.test(v)) {                       // a date bounds the START of the window (rows logged before it are not counted); a duration is the length of the window
      const ms = Date.parse(v);
      if (!Number.isFinite(ms) || !realDay(v)) throw bad(`flag --since takes a real date like 2026-10-07 or 2026-10-07T09:30:00Z, found ${JSON.stringify(clip(v, 40))}`);
      flags.sinceDate = new Date(ms).toISOString(); continue;
    }
    if (name === "since") {
      if (!/^[1-9]\d{0,3}[hd]$/.test(v)) throw bad(`flag --since takes a number and h or d, like 24h, 7d or 30d, or a date like 2026-10-07, found ${JSON.stringify(clip(v, 20))}`);
      if (Number(v.slice(0, -1)) * UNITS[v.slice(-1)] > THRESHOLDS.maxAgeDays * DAY_MS) throw bad(`flag --since ${v} is longer than ${THRESHOLDS.maxAgeDays}d: a written PASS expires after ${THRESHOLDS.maxAgeDays} days, so older traffic is never counted`);
      flags[name] = v; continue;
    }
    if (name === "cc-version" || name === "ccr-version") {
      const w = wholeVersion(v, name === "cc-version" ? { suffix: "(Claude Code)" } : {});
      if (!w) throw bad(`flag ${a} takes a whole version, x.y.z with an optional -pre or +build tag${name === "cc-version" ? ` (the text \`claude --version\` prints, like "2.1.289 (Claude Code)", is accepted)` : ""}, found ${JSON.stringify(clip(v, 40))}: the enforce gate refuses anything else`);
      flags[name] = w; continue;
    }
    if (v.trim() === "") throw bad(`flag ${a} needs a file path`);
    flags[name] = v;
  }
  if (flags.write && !flags.live) throw bad("--write yes needs --live yes too: it replaces state/subagent/accuracy.json, the file the enforce precondition reads");
  if (flags.live && !flags.write) throw bad("--live yes only goes with --write yes");
  return flags;
}

/** The CLI body, with its sinks injected. Returns the exit code. With --json yes stdout carries the JSON record only; the dry and WROTE notes and warnings go to stderr. */
export async function runSubagentAccuracy(argv, io, env = process.env, opts = {}) {
  let flags;
  try { flags = parseAccuracyArgs(argv); } catch (e) { if (e instanceof PolicyError) { io.err(e.message); io.err(USAGE); return 2; } throw e; }
  const nowMs = opts.now ?? Date.now();
  if (flags.sinceDate && Date.parse(flags.sinceDate) > nowMs + THRESHOLDS.futureToleranceMs) { io.err(`flag --since ${flags.sinceDate} is in the future: the window would be empty`); return 2; }
  let p;
  try { p = resolvePaths(flags, { env }); } catch (e) { if (e instanceof PolicyError) { io.err(e.message); return 2; } throw e; }
  let rec;
  try {
    rec = await runEvaluation(p, { nowMs, sinceDate: flags.sinceDate ?? null, sinceMsV: flags.since ? Number(flags.since.slice(0, -1)) * UNITS[flags.since.slice(-1)] : 30 * DAY_MS, versions: { cc: flags["cc-version"], ccr: flags["ccr-version"] }, tally: flags.tally !== false, providersFile: !!flags["providers-file"] });
  } catch (e) { io.err(`cannot evaluate: ${clip(e?.code ?? e?.message ?? "error", 120)}`); return 1; }
  const note = flags.json ? io.err : io.out;
  if (flags.json) io.out(JSON.stringify(rec.record, null, 2)); else for (const l of rec.text) io.out(l);
  if (flags.write) {
    const file = path.join(p.stateDir, "accuracy.json");
    const prev = readJsonFile(file);
    try { writeFileRetry(file, JSON.stringify(rec.record, null, 2) + "\n"); }
    catch (e) { io.err(`cannot write ${file}: ${clip(e?.message ?? "error", 120)}`); return 1; }
    note(`WROTE ${file}: verdict ${rec.record.verdict}${prev.ok && prev.value?.verdict ? ` (replaced a previous ${clip(prev.value.verdict, 20)} from ${clip(prev.value.at ?? "?", 30)})` : ""}`);
    if (rec.record.verdict === "PASS" && !rec.record.evidence.policyContentHash) io.err("NOTE: there is no compiled policy (state/subagent/policy.json), so this PASS records no policy content hash and the enforce check will refuse it: rebuild the policy, then evaluate again");
    const prevAt = prev.ok ? Date.parse(prev.value?.at ?? "") : NaN;
    if (prev.ok && prev.value?.verdict === "PASS" && rec.record.verdict !== "PASS" && Number.isFinite(prevAt) && nowMs - prevAt < THRESHOLDS.maxAgeDays * DAY_MS) {
      io.err(`WARNING: replaced an unexpired PASS (written ${clip(prev.value.at, 30)}, valid until ${new Date(prevAt + THRESHOLDS.maxAgeDays * DAY_MS).toISOString()}) with ${rec.record.verdict}: enforcement is blocked until a new PASS is written`);
    }
  } else note("dry: nothing written (--write yes --live yes writes state/subagent/accuracy.json)");
  return 0;
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const code = await runSubagentAccuracy(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n") });
  process.exitCode = code;
}

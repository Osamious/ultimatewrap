// The classifier accuracy and shadow-tally evaluator (plan 12.5 and 12.1 S3 items 3 and 7; issue #154).
//
//   node keysync/subagent-accuracy.mjs [--since 7d|30d] [--json yes] [--write yes --live yes]
//
// READ-ONLY apart from the one optional output file `state/subagent/accuracy.json`. It reads the router's classifier log generations and the decision and agent logs in bounded chunks, EXCLUDES the UW
// tooling's own sessionless probe traffic from every denominator, computes T1..T6 of 12.5 with the population named in the same sentence as every number, tallies what each of the three modes
// (dynamic, inherit, free) WOULD have used for every subagent request, and prints PASS, FAIL or INSUFFICIENT per metric with the reason. It starts no process and sends no request.
//
// GROUND TRUTH. The log carries no label, so a request's true class comes from the best evidence it carries, and the output says which: (1) `rc`, the authoritative request class Claude Code
// sends when CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 (main|subagent|workflow|compaction|auxiliary); (2) otherwise the two independent detectors the router logs, the agent id (`ag`) and the billing flag
// (`bl`): both set = a built-in subagent, both clear = main. A request on which exactly one detector fires (a teammate: an agent id and no billing flag) has NO second opinion and is reported on its
// own line, never counted as corroborated. Agreement of the detectors is a consistency check, not a labelled sample: the labelled sets of 12.5 (sandbox, gt-labels) remain the stronger evidence.
//
// WHAT THE LOG CANNOT SHOW (stated in the output, never hidden): a helper request is never in the decision log and carries no returned model, so "helper calls rewritten" is counted as (a) helper-shaped
// requests the router did NOT classify aux and (b) helper-shaped rows of the decision log whose returned model differs from the asked one; the router returns the asked model by construction (`finish`).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { CLASS_FILES, CLASS_READ_MAX, isProbeRow, isProbeSid, resolvePaths, gatherInputs, compile, loadOwner, OWNER_DEFAULTS, PolicyError, readJsonFile, writeFileRetry, UNITS, printable, FILE_FLAGS } from "./subagent-policy.mjs";
import { providerOf, SUBSTITUTE_FLOOR, SUBSTITUTE_K } from "../menu/subagent-funnel.mjs";

export const ACCURACY_SCHEMA = 1;
export const Z95 = 1.645;                                          // one-sided 95%: n = 200 with no miss gives 98.67%, one miss 97.79% (the figures of 12.5)
/** The accepted thresholds (plan 12.5, decision Q2) and the minimum samples. Frozen: a mutated copy must fail a test. */
export const THRESHOLDS = Object.freeze({ t1Pct: 99, t1Wilson: 97, t2Rewritten: 0, t2MinHelpers: 200, t4Misclassified: 0, t5MaxDisagreePct: 1, maxAgeDays: 30 });
export const MIN_SAMPLES = Object.freeze({ perSubagentType: 40, subagentTypes: 5, distinctAgents: 30, helperTotal: 200, perLabelledHelperType: 40, main: 200, mainSessions: 2, mainModelSwitches: 1, sessions: 3, days: 2, builtIn: 40, t1: 200 });
export const CLASS_NAMES = Object.freeze(["main", "sub", "aux", "exempt", "other"]);
const RC_SET = Object.freeze(["main", "subagent", "workflow", "compaction", "auxiliary"]);
const DECISION_FILES = Object.freeze(["decisions.2.jsonl", "decisions.1.jsonl", "decisions.jsonl"]);
const AGENT_FILES = Object.freeze(["agents.3.jsonl", "agents.2.jsonl", "agents.1.jsonl", "agents.jsonl"]);
const DAY_MS = 86400000;
const MAIN_TTL_MS = 6 * 3600 * 1000;                               // the router's main-model memory (compiled `main.ttlSec`)
const CAPS = Object.freeze({ sessions: 5000, agents: 20000, types: 64, tallyKeys: 5000, models: 4000 });
const KINDS_NOTE = "teammate = an agent id without the billing flag; built-in = both detectors; billing-only = the flag without an agent id";

// ------------------------------------------------------------------ pure math
/** One-sided Wilson lower bound for k successes in n trials (z = 1.645 is the 95% one-sided bound). 0 for an empty sample. */
export function wilsonLower(k, n, z = Z95) {
  if (!(n > 0) || !(k >= 0)) return 0;
  const p = Math.min(1, k / n), z2 = z * z;
  return Math.max(0, (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n));
}
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
const own = (o, k) => (o && typeof o === "object" && Object.hasOwn(o, k) ? o[k] : undefined);
/** A compiled policy as the router would index it. */
export function policyView(compiled) {
  const idx = new Map();
  (compiled.models ?? []).forEach((r, i) => idx.set(r.s, i));
  return { pol: compiled, idx };
}
const listOf = (v, L) => (L === null ? v.pol.models.map((_, i) => i) : Array.isArray(L) ? L : []);
const fitsTok = (row, tc) => !!row && row.c > 0 && (!Number.isFinite(tc) || tc * 1.1 <= row.c);
/**
 * What the compiled policy of one mode WOULD use for one subagent request: {kind, picks}. kind is keep (the asked model stays), move (a policy model serves it), none (no eligible substitute: empty set,
 * nothing usable) or no-main (same-provider or inherit with no learned main). picks is [[model, weight]]: a deterministic spread over the lead pool shares the request equally (expected value, NOT the
 * router's exact hash pick). This mirrors the router's `decide` and `pickSubstitute` for the SET, the context floor, the token fit, the lead band, K and main-first. It deliberately ignores cooling and
 * overlay demotion, the payload byte caps (the log keeps a size bucket only) and the tool-tier rule: those change WHICH model, rarely WHETHER one is eligible.
 */
export function predictUse(view, { asked, main, tc }) {
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
  if (askedRow && inS.has(view.idx.get(asked)) && fitsTok(askedRow, tc)) return { kind: "keep", picks: [[asked, 1]] };
  const hint = own(pol.ctxHints, asked), floor = Math.max(typeof hint === "number" ? hint : 0, SUBSTITUTE_FLOOR), banded = owner.banded !== false;
  const usable = (r) => !!r && r.c >= floor && fitsTok(r, tc);
  const scan = (idxs, prov, lim) => {
    const got = [];
    let lead = null;
    for (const i of idxs) {
      if (got.length >= lim) break;
      const r = pol.models[i];
      if (!r || (prov !== null && providerOf(r.s) !== prov)) continue;
      if (banded && lead !== null && r.b !== lead.b) break;
      if (!usable(r)) continue;
      if (lead === null) lead = r;
      got.push(r);
    }
    return got;
  };
  const pool = (lim) => {
    let got = [];
    if (main) {
      const mp = providerOf(main), pl = own(pol.lists?.prov, mp);
      got = Array.isArray(pl) ? scan(pl, null, lim) : same ? scan(S0idx, null, lim) : scan(S0idx, mp, lim);
    }
    return got.length ? got : scan(S0idx, null, lim);
  };
  const mainRow = main ? rowOf(main) : null;
  if (mainRow && inS.has(view.idx.get(main)) && usable(mainRow)) {
    if (!banded) return { kind: "move", picks: [[main, 1]] };
    const lead = pool(1)[0];
    if (!lead || !(mainRow.b > lead.b)) return { kind: "move", picks: [[main, 1]] };
  }
  const got = pool(SUBSTITUTE_K);
  return got.length ? { kind: "move", picks: got.map((r) => [r.s, 1 / got.length]) } : { kind: "none", picks: [] };
}
const emptyTally = (view) => ({ mode: view.pol.owner?.mode ?? "?", source: view.pol.owner?.source ?? "?", rows: view.pol.models?.length ?? 0, requests: 0, keep: 0, moved: 0, none: 0, noMain: 0, byProvider: new Map(), byModel: new Map() });
const bump = (m, k, w) => { if (!m.has(k) && m.size >= CAPS.models) k = "~other"; m.set(k, (m.get(k) ?? 0) + w); };
/** Tallies the aggregated subagent requests ([{asked, main, tc, n}]) against every mode's policy view. Pure. */
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

// ------------------------------------------------------------------ the evaluator
function newAcc(nowMs, sinceMsV) {
  const win = Math.min(sinceMsV, THRESHOLDS.maxAgeDays * DAY_MS);
  return {
    cutoff: nowMs - win, nowMs, windowMs: win,
    rows: 0, inWindow: 0, probe: 0, probeAgentShaped: 0, malformed: 0, noToolCount: 0, client: 0, counted: 0, newest: 0, oldest: Infinity,
    cls: { main: 0, sub: 0, aux: 0, exempt: 0, other: 0 }, sessions: new Set(), days: new Set(),
    rcLogged: 0, atLogged: 0,
    t1: { n: 0, sub: 0, exempt: 0, missBy: { main: 0, aux: 0, other: 0 }, viaRc: 0, viaDetectors: 0 },
    single: { n: 0, sub: 0 },                                      // exactly one detector, no rc: uncorroborated
    subTypes: new Map(), agents: new Set(), agentsCapped: false,
    toolless: { n: 0, rcSub: 0 },
    helper: { n: 0, aux: 0, notAux: { sub: 0, exempt: 0, main: 0, other: 0 }, byType: new Map() },
    main: { n: 0, notMain: { sub: 0, aux: 0, exempt: 0, other: 0 }, sessions: new Set(), models: new Map(), viaRc: 0 },
    builtIn: { n: 0, noAgentId: 0 },
    matrix: {},
    mainBySid: new Map(), subAgg: new Map(), subRequests: 0, subAggDropped: 0,
    dec: { rows: 0, probe: 0, helperRows: 0, helperRewritten: 0, mainLearnNonMain: 0, observed: obsAcc(), observedLive: obsAcc(), hashes: new Set() },
    ag: { rows: 0, probe: 0, observed: obsAcc() },
    hash: crypto.createHash("sha256"),
  };
}
const obsAcc = () => ({ n: 0, keep: 0, moved: 0, none: 0, byProvider: new Map(), byModel: new Map(), askedByProvider: new Map() });
const bumpType = (m, k) => { if (!m.has(k) && m.size >= CAPS.types) k = "~other"; m.set(k, (m.get(k) ?? 0) + 1); };

function addMatrix(acc, truth, cls) { const r = (acc.matrix[truth] ??= { main: 0, sub: 0, exempt: 0, aux: 0, other: 0 }); r[cls] += 1; }

function feedClass(acc, o) {
  acc.rows += 1;
  const r = normClassRow(o);
  if (!r) { acc.malformed += 1; return; }
  if (r.ms < acc.cutoff || r.ms > acc.nowMs + DAY_MS) return;     // outside the window (a line stamped more than a day in the future is a clock fault: not counted)
  acc.inWindow += 1;
  if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; return; }
  acc.client += 1;
  if (r.nt === null) { acc.noToolCount += 1; return; }
  acc.counted += 1;
  acc.newest = Math.max(acc.newest, r.ms); acc.oldest = Math.min(acc.oldest, r.ms);
  acc.cls[r.cls] += 1;
  if (r.rc) acc.rcLogged += 1;
  if (r.at) acc.atLogged += 1;
  if (acc.sessions.size < CAPS.sessions) acc.sessions.add(r.sid);
  acc.days.add(r.day);
  acc.hash.update(`${r.ms}|${r.sid}|${r.cls}|${+r.ag}${+r.bl}|${r.nt}\n`);
  const agentShaped = r.ag || r.bl, tools = r.nt > 0;
  // ---- truth
  let truth = null, via = null;
  if (r.rc) { via = "rc"; truth = r.rc === "main" ? "main" : r.rc === "subagent" || r.rc === "workflow" ? "sub" : "helper"; }
  else if (!agentShaped) { via = "detectors"; truth = "main"; }
  else if (r.ag && r.bl) { via = "detectors"; truth = tools ? "sub" : "helper-shaped"; }
  else truth = "single";
  // ---- type groups
  if (agentShaped && tools && truth !== "main" && truth !== "helper") {
    const kind = r.ag && r.bl ? "built-in" : r.ag ? "teammate" : "billing-only";
    bumpType(acc.subTypes, r.at ? `at:${r.at}` : kind);
    const key = `${r.sid}:${r.aid ?? "?"}`;
    if (acc.agents.size < CAPS.agents) acc.agents.add(key); else acc.agentsCapped = true;
  }
  if (r.bl) { acc.builtIn.n += 1; if (!r.ag) acc.builtIn.noAgentId += 1; }
  // ---- metrics
  if (truth === "main") {
    acc.main.n += 1; if (via === "rc") acc.main.viaRc += 1;
    if (r.cls !== "main") acc.main.notMain[r.cls] += 1;
    acc.main.sessions.add(r.sid);
    let s = acc.main.models.get(r.sid);
    if (!s) { if (acc.main.models.size < CAPS.sessions) { s = new Set(); acc.main.models.set(r.sid, s); } }
    if (s && s.size < 4 && r.m) s.add(r.m);
    addMatrix(acc, "main", r.cls);
  } else if (truth === "sub") {
    if (tools) {
      acc.t1.n += 1; via === "rc" ? acc.t1.viaRc++ : acc.t1.viaDetectors++;
      if (r.cls === "sub") acc.t1.sub += 1; else if (r.cls === "exempt") { acc.t1.sub += 1; acc.t1.exempt += 1; } else acc.t1.missBy[r.cls] += 1;
      addMatrix(acc, "sub", r.cls);
    } else { acc.toolless.n += 1; acc.toolless.rcSub += 1; addMatrix(acc, "sub-toolless", r.cls); }
  } else if (truth === "single") {
    if (tools) { acc.single.n += 1; if (r.cls === "sub" || r.cls === "exempt") acc.single.sub += 1; addMatrix(acc, "single-detector", r.cls); }
  }
  if (agentShaped && !tools && truth !== "sub") {
    // helper-shaped: an agent id or the flag and no tool: the router calls it aux (I8a); T2 says none may be classified sub or rewritten
    acc.helper.n += 1;
    if (r.cls === "aux") acc.helper.aux += 1; else acc.helper.notAux[r.cls] += 1;
    bumpType(acc.helper.byType, r.rc ?? "unlabelled");
    addMatrix(acc, r.rc ? `helper-${r.rc}` : "helper-shaped", r.cls);
  } else if (r.rc === "compaction" || r.rc === "auxiliary") {
    acc.helper.n += 1;
    if (r.cls === "aux") acc.helper.aux += 1; else acc.helper.notAux[r.cls] += 1;
    bumpType(acc.helper.byType, r.rc);
    addMatrix(acc, `helper-${r.rc}`, r.cls);
  }
  // ---- main model memory and the subagent aggregate for the tally
  if (r.cls === "main" && r.ga && r.m && r.sid) acc.mainBySid.set(r.sid, { ms: r.ms, m: r.m });
  if ((r.cls === "sub" || r.cls === "exempt") && tools && r.m) {
    const mm = acc.mainBySid.get(r.sid), main = mm && r.ms - mm.ms <= MAIN_TTL_MS && r.ms >= mm.ms ? mm.m : null;
    const tcb = r.tc === null ? "" : Math.ceil(r.tc / 2000) * 2000;
    const k = `${r.m}\u0000${main ?? ""}\u0000${tcb}`;
    const e = acc.subAgg.get(k);
    if (e) e.n += 1; else if (acc.subAgg.size < CAPS.tallyKeys) acc.subAgg.set(k, { asked: r.m, main, tc: tcb === "" ? null : tcb, n: 1 }); else acc.subAggDropped += 1;
    acc.subRequests += 1;
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
  if (!d || d.ms < acc.cutoff || d.ms > acc.nowMs + DAY_MS) return;
  acc.dec.rows += 1;
  if (isProbeSid(d.sid)) { acc.dec.probe += 1; return; }
  if ((d.ag || d.bl) && d.tools === 0) { acc.dec.helperRows += 1; if (d.asked && d.ret && d.ret !== d.asked) acc.dec.helperRewritten += 1; }
  if (d.act === "main-learn" && (d.ag || d.bl)) acc.dec.mainLearnNonMain += 1;
  if (d.role === "sub") {
    if (d.ph && OBSERVED_ACTS.has(d.act)) acc.dec.hashes.add(d.ph);
    feedObserved(acc.dec.observed, d);
    if (liveHash && d.ph === liveHash) feedObserved(acc.dec.observedLive, d);
  }
}
function feedAgent(acc, o) {
  const a = normAgent(o);
  if (!a || a.ms < acc.cutoff || a.ms > acc.nowMs + DAY_MS) return;
  acc.ag.rows += 1;
  if (isProbeSid(a.sid)) { acc.ag.probe += 1; return; }
  feedObserved(acc.ag.observed, a);
}

const mk = (id, name, status, reason, extra = {}) => ({ id, name, status, reason, ...extra });
/**
 * Computes every metric from an accumulator. Returns the full record (also the JSON). `versions` = {cc, ccr} (T6). Pure given the accumulator.
 */
export function evaluate(acc, { versions = {}, nowMs = acc.nowMs } = {}) {
  const T = THRESHOLDS, M = MIN_SAMPLES;
  const sessions = acc.sessions.size, days = acc.days.size;
  const newestAgeDays = acc.newest ? (nowMs - acc.newest) / DAY_MS : null;
  const missing = [];
  const metrics = {};
  const pop = (name, n) => `of ${num(n)} ${name}`;
  // ---- T1
  const t1 = acc.t1, miss = t1.missBy.main + t1.missBy.aux + t1.missBy.other, w1 = wilsonLower(t1.sub, t1.n);
  {
    const popText = `${num(t1.n)} corroborated tool-carrying subagent requests (${num(t1.viaRc)} by rc, ${num(t1.viaDetectors)} by both detectors)`;
    let status, reason;
    if (t1.n < M.t1) { status = "INSUFFICIENT"; reason = `${num(t1.n)} of ${num(M.t1)} corroborated subagent requests${miss ? `; ${miss} already classified other than sub (aux ${t1.missBy.aux}, main ${t1.missBy.main}, other ${t1.missBy.other})` : ""}`; missing.push(`T1 needs ${num(M.t1 - t1.n)} more corroborated subagent requests`); }
    else if (100 * (t1.sub / t1.n) >= T.t1Pct && 100 * w1 >= T.t1Wilson) { status = "PASS"; reason = `${pctText(t1.sub, t1.n, 2)} classified sub ${pop("corroborated subagent requests", t1.n)} (Wilson lower bound ${(100 * w1).toFixed(1)}%)`; }
    else { status = "FAIL"; reason = `${pctText(t1.sub, t1.n, 2)} classified sub ${pop("corroborated subagent requests", t1.n)}, Wilson lower bound ${(100 * w1).toFixed(1)}%; need at least ${T.t1Pct}% and ${T.t1Wilson}%`; }
    metrics.T1 = mk("T1", "subagent requests classified sub", status, reason, { population: popText, n: t1.n, k: t1.sub, exempt: t1.exempt, misses: miss, pct: t1.n ? +(100 * t1.sub / t1.n).toFixed(3) : null, wilsonLower: +(100 * w1).toFixed(3), need: `at least ${T.t1Pct}% and Wilson lower bound at least ${T.t1Wilson}%, over at least ${M.t1}` });
  }
  // ---- T2
  const h = acc.helper, hViol = h.notAux.sub + h.notAux.exempt + h.notAux.main + h.notAux.other + acc.dec.helperRewritten;
  {
    let status, reason;
    if (hViol > 0) { status = "FAIL"; reason = `${hViol} helper calls classified other than aux or returned on another model (${h.notAux.sub} sub, ${h.notAux.exempt} exempt, ${h.notAux.main} main, ${h.notAux.other} other; ${acc.dec.helperRewritten} rewritten in the decision log) ${pop("helper-shaped client requests", h.n)}`; }
    else if (h.n < T.t2MinHelpers) { status = "INSUFFICIENT"; reason = `${num(h.n)} of ${num(T.t2MinHelpers)} helper-shaped requests (no helper call rewritten so far)`; missing.push(`T2 needs ${num(T.t2MinHelpers - h.n)} more helper-shaped requests (an agent id or the billing flag, and no tools)`); }
    else { status = "PASS"; reason = `0 helper calls rewritten ${pop("helper-shaped client requests", h.n)}`; }
    metrics.T2 = mk("T2", "helper calls rewritten", status, reason, { n: h.n, aux: h.aux, rewritten: hViol, classifiedSub: h.notAux.sub, decisionRowsHelperShaped: acc.dec.helperRows, decisionRowsRewritten: acc.dec.helperRewritten, need: `zero rewritten in at least ${T.t2MinHelpers}` });
  }
  // ---- T3 (reported)
  {
    const real = t1.n + acc.toolless.rcSub;
    metrics.T3 = mk("T3", "tool-less real subagents", "REPORTED", acc.rcLogged ? `${num(acc.toolless.rcSub)} tool-less requests labelled subagent by rc ${pop("subagent requests", real)} (${pctText(acc.toolless.rcSub, real)}; the owner is told above 5%)` : `not observable: rc is not logged on any of ${num(acc.counted)} client requests, so a tool-less real subagent cannot be told from a helper call (helper-shaped requests are counted under T2)`, { n: acc.toolless.rcSub, of: real });
  }
  // ---- T4
  const mn = acc.main, mMiss = mn.notMain.sub + mn.notMain.aux + mn.notMain.exempt + mn.notMain.other, mViol = mMiss + acc.dec.mainLearnNonMain;
  {
    let status, reason;
    if (mViol > 0) { status = "FAIL"; reason = `${mMiss} main requests classified other than main and ${acc.dec.mainLearnNonMain} main-learn events caused by a non-main request ${pop("main requests", mn.n)}`; }
    else if (mn.n < M.main) { status = "INSUFFICIENT"; reason = `${num(mn.n)} of ${num(M.main)} main requests (none misclassified so far)`; missing.push(`T4 needs ${num(M.main - mn.n)} more main requests`); }
    else { status = "PASS"; reason = `0 misclassified ${pop("main requests", mn.n)}`; }
    metrics.T4 = mk("T4", "main requests misclassified", status, reason, { n: mn.n, misclassified: mMiss, mainLearnNonMain: acc.dec.mainLearnNonMain, viaRc: mn.viaRc, need: `zero in at least ${M.main}` });
  }
  // ---- T5 (built-in only)
  {
    const b = acc.builtIn, rate = b.n ? 100 * b.noAgentId / b.n : 0;
    let status, reason;
    if (b.n < M.builtIn) { status = "INSUFFICIENT"; reason = `${num(b.n)} of ${num(M.builtIn)} built-in subagent requests (the billing flag set)`; missing.push(`T5 needs ${num(M.builtIn - b.n)} more built-in subagent requests (the billing flag set)`); }
    else if (rate <= T.t5MaxDisagreePct) { status = "PASS"; reason = `${pctText(b.noAgentId, b.n, 2)} of ${num(b.n)} built-in requests had no agent id`; }
    else { status = "FAIL"; reason = `${pctText(b.noAgentId, b.n, 2)} of ${num(b.n)} built-in requests had no agent id; at most ${T.t5MaxDisagreePct}%`; }
    metrics.T5 = mk("T5", "detector disagreement, built-in only", status, reason, { n: b.n, disagree: b.noAgentId });
  }
  // ---- T6
  {
    const ok = typeof versions.cc === "string" && versions.cc && typeof versions.ccr === "string" && versions.ccr;
    metrics.T6 = mk("T6", "versions recorded", ok ? "PASS" : "INSUFFICIENT", ok ? `Claude Code ${clip(versions.cc, 40)}, CCR ${clip(versions.ccr, 40)}, measured ${new Date(nowMs).toISOString().slice(0, 10)}` : "Claude Code and CCR versions are not recorded: pass --cc-version and --ccr-version (an update of either invalidates the verdict)", { cc: versions.cc ?? null, ccr: versions.ccr ?? null });
    if (!ok) missing.push("T6 needs --cc-version and --ccr-version");
  }
  // ---- minimums
  const mins = [];
  const addMin = (id, have, need, noun, detail = "") => { const ok = have >= need; const text = ok ? `${noun}: ${typeof have === "number" ? num(have) : have} (need ${num(need)})${detail}` : `${typeof have === "number" ? num(have) : have} of ${num(need)} ${noun}${detail}`; mins.push({ id, have, need, ok, text }); if (!ok) missing.push(text); };
  const typeRows = [...acc.subTypes.entries()].sort((a, b) => b[1] - a[1]);
  const typesMet = typeRows.filter(([, n]) => n >= M.perSubagentType).length;
  const totalSub = typeRows.reduce((a, [, n]) => a + n, 0);
  const typeText = typeRows.map(([k, n]) => `${k} ${num(n)}`).join(", ") || "none";
  const atOnSub = typeRows.filter(([k]) => k.startsWith("at:")).reduce((a, [, n]) => a + n, 0);
  addMin("subagent-types", typesMet, M.subagentTypes, `subagent types with ${M.perSubagentType} requests each`, ` (${typeText})${atOnSub === 0 && totalSub > 0 ? `; agent type is not logged (at null on ${num(totalSub)} of ${num(totalSub)} tool-carrying subagent-shaped requests), so only the kinds built-in, teammate and billing-only exist: set CLAUDE_CODE_GATEWAY_HINT_HEADERS=1 or record a labelled window` : ""}`);
  addMin("distinct-agents", acc.agents.size, M.distinctAgents, "distinct subagents (session and agent id pairs)");
  const hl = [...h.byType.entries()].filter(([k]) => k !== "unlabelled");
  const hlShort = hl.filter(([, n]) => n < M.perLabelledHelperType);
  addMin("helper-total", h.n, M.helperTotal, "helper-shaped requests (an agent id or the billing flag, no tools)", ` (${[...h.byType.entries()].map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  if (hl.length) addMin("helper-types", hl.length - hlShort.length, hl.length, `labelled helper types with ${M.perLabelledHelperType} requests each`, ` (short: ${hlShort.map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  else mins.push({ id: "helper-types", have: 0, need: 0, ok: true, text: "helper types (title, compaction, small-fast, summary) cannot be told apart without rc: only the total of helper-shaped requests is checked" });
  let switches = 0; for (const s of mn.models.values()) if (s.size >= 2) switches += 1;
  addMin("main", mn.n, M.main, "main requests");
  addMin("main-sessions", mn.sessions.size, M.mainSessions, "sessions with main requests");
  addMin("main-model-switch", switches, M.mainModelSwitches, "sessions whose main model changed (a /model switch)");
  addMin("sessions", sessions, M.sessions, "client sessions");
  addMin("days", days, M.days, "UTC days with client traffic");
  // ---- age
  const ageOk = newestAgeDays !== null && newestAgeDays < T.maxAgeDays;
  const age = mk("AGE", "evidence age", ageOk ? "PASS" : "INSUFFICIENT", newestAgeDays === null ? "no client request in the window" : `newest client request ${newestAgeDays.toFixed(1)} days old (limit ${T.maxAgeDays}); a PASS expires ${T.maxAgeDays} days after it is written`, { newestAgeDays });
  if (!ageOk) missing.push("AGE: no client traffic younger than 30 days");
  const gated = [metrics.T1, metrics.T2, metrics.T4, metrics.T5, metrics.T6, age];
  const verdict = gated.some((x) => x.status === "FAIL") ? "FAIL" : gated.every((x) => x.status === "PASS") && mins.every((x) => x.ok) ? "PASS" : "INSUFFICIENT";
  return { verdict, metrics, age, minimums: mins, missing, matrix: acc.matrix, kinds: KINDS_NOTE, typeCounts: Object.fromEntries(typeRows), helperTypeCounts: Object.fromEntries(h.byType), sessions, days: [...acc.days].sort(), newestAgeDays };
}

// ------------------------------------------------------------------ the three-mode policies
const MODES = Object.freeze(["dynamic", "inherit", "free"]);
/** Compiles the policy of each mode from the on-disk inputs (snapshot, bench, tool fidelity, owner file): no gateway call unless --providers-file is given. Returns {views, note, live} or {error}. */
async function buildViews(p, { nowMs, providersFile }) {
  try {
    const g = await gatherInputs(p, { nowMs, ...(providersFile ? {} : { liveProviders: null }) });
    let base = { ...OWNER_DEFAULTS, source: "all-providers" };
    try { const o = p.policyFile ? loadOwner(p.policyFile) : null; if (o) base = o; } catch { /* a corrupt owner file: the defaults stand, said below */ }
    const views = {};
    for (const mode of MODES) views[mode] = policyView(compile(g, { ...base, mode, enforcement: "shadow", allow: base.allow ?? [] }).compiled);
    const live = readJsonFile(p.compiledFile);
    const lv = live.ok ? live.value : null;
    const same = lv && views[lv.owner?.mode];
    return { views, base: { source: base.source, freeScope: base.freeScope, ctx: base.ctx, unverified: base.unverified }, providersLive: g.providersLive,
      live: lv ? { mode: lv.owner?.mode ?? null, rows: Array.isArray(lv.models) ? lv.models.length : null, contentHash: typeof lv.contentHash === "string" ? lv.contentHash : null, recompiledRows: same ? views[lv.owner.mode].pol.models.length : null } : null };
  } catch (e) { return { error: e instanceof PolicyError ? e.message.slice(0, 200) : `${e?.code ?? e?.name ?? "error"}` }; }
}

const obsOut = (o) => ({ n: o.n, keep: o.keep, moved: o.moved, none: o.none, byProvider: topN(o.byProvider, 12), byModel: topN(o.byModel, 12), askedByProvider: topN(o.askedByProvider, 6) });
const topN = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([k, v]) => [k, +v.toFixed(2)]);
const tallyOut = (t) => ({ mode: t.mode, source: t.source, rows: t.rows, requests: t.requests, keep: t.keep, moved: t.moved, none: t.none, noMain: t.noMain, byProvider: topN(t.byProvider, 15), byModel: topN(t.byModel, 15) });

/**
 * The whole evaluation of a state folder. `p` = resolved paths ({stateDir, ...}). Returns {record, text}: record is the JSON shape, text the lines.
 */
export async function runEvaluation(p, { nowMs = Date.now(), sinceMsV = 30 * DAY_MS, versions = {}, tally = true, providersFile = false, sample = null } = {}) {
  const acc = newAcc(nowMs, sinceMsV);
  let liveHash = null;
  const lv = readJsonFile(p.compiledFile ?? path.join(p.stateDir, "policy.json"));
  if (lv.ok && typeof lv.value?.contentHash === "string") liveHash = lv.value.contentHash.slice(0, 16);
  let k = 0;
  const clog = streamJsonl(p.stateDir, CLASS_FILES, (o) => { feedClass(acc, o); if (sample && (++k & 4095) === 0) sample(); });
  const dlog = streamJsonl(p.stateDir, DECISION_FILES, (o) => feedDecision(acc, o, liveHash), { maxBytes: 8 * 1024 * 1024 });
  const alog = streamJsonl(p.stateDir, AGENT_FILES, (o) => feedAgent(acc, o), { maxBytes: 8 * 1024 * 1024 });
  const ev = evaluate(acc, { versions, nowMs });
  let tallies = null, tallyNote = null, policies = null;
  if (tally) {
    const v = await buildViews(p, { nowMs, providersFile });
    if (v.error) tallyNote = `shadow tally per mode unavailable: ${v.error}`;
    else {
      policies = { base: v.base, live: v.live, providersLive: v.providersLive, modes: Object.fromEntries(Object.entries(v.views).map(([k, x]) => [k, x.pol.models.length])) };
      tallies = shadowTally([...acc.subAgg.values()], v.views).map(tallyOut);
    }
  }
  const evidence = { classRowsCounted: acc.counted, sha256: acc.hash.digest("hex"), policyContentHash: lv.ok && typeof lv.value?.contentHash === "string" ? lv.value.contentHash : null };
  const record = {
    schema: ACCURACY_SCHEMA, verdict: ev.verdict, at: new Date(nowMs).toISOString(), ccVersion: versions.cc ?? null, ccrVersion: versions.ccr ?? null,
    minSamples: MIN_SAMPLES, thresholds: THRESHOLDS, matrix: ev.matrix,
    window: { since: new Date(acc.cutoff).toISOString(), until: new Date(nowMs).toISOString(), days: ev.days, newestAgeDays: ev.newestAgeDays === null ? null : +ev.newestAgeDays.toFixed(2) },
    populations: { classifierLines: acc.rows, inWindow: acc.inWindow, probeExcluded: acc.probe, probeAgentShaped: acc.probeAgentShaped, unreadableOrMalformed: acc.malformed + clog.unreadableLines, noToolCount: acc.noToolCount, clientCounted: acc.counted, sessions: ev.sessions, rcLogged: acc.rcLogged, atLogged: acc.atLogged,
      classes: acc.cls, decisionRows: acc.dec.rows, decisionProbeExcluded: acc.dec.probe, agentRows: acc.ag.rows, agentProbeExcluded: acc.ag.probe },
    metrics: ev.metrics, age: ev.age, minimums: ev.minimums, missing: ev.missing, typeCounts: ev.typeCounts, helperTypeCounts: ev.helperTypeCounts,
    single: { n: acc.single.n, classifiedSub: acc.single.sub, note: KINDS_NOTE },
    shadow: { subagentRequests: acc.subRequests, droppedKeys: acc.subAggDropped, modes: tallies, note: tallyNote, policies,
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
  L.push(`CLASSIFIER ACCURACY: ${r.verdict}   (window ${r.window.since.slice(0, 10)} to ${r.window.until.slice(0, 10)}, evidence newest ${r.window.newestAgeDays === null ? "n/a" : `${r.window.newestAgeDays} days`} old)`);
  L.push(fileLine("classifier log", r.logs.classify));
  L.push(fileLine("decision log", r.logs.decisions));
  L.push(fileLine("agent log", r.logs.agents));
  L.push(`EXCLUDED from every denominator below: ${num(P.probeExcluded)} of ${num(P.inWindow)} classifier lines in the window are sessionless probe traffic (hasSid false or a "nosession" id; ${num(P.probeAgentShaped)} of them agent-shaped); ${num(P.decisionProbeExcluded)} sessionless decision rows and ${num(P.agentProbeExcluded)} sessionless agent rows${P.unreadableOrMalformed ? `; ${num(P.unreadableOrMalformed)} unreadable or malformed lines` : ""}${P.noToolCount ? `; ${num(P.noToolCount)} client lines without a tool count` : ""}`);
  L.push(`COUNTED: ${num(P.clientCounted)} client requests in ${P.sessions} sessions on ${r.window.days.length} UTC days: main ${num(P.classes.main)}, sub ${num(P.classes.sub)}, aux ${num(P.classes.aux)}, exempt ${num(P.classes.exempt)}${P.classes.other ? `, other ${num(P.classes.other)}` : ""}. Ground truth: rc is logged on ${num(P.rcLogged)} of ${num(P.clientCounted)} (the authoritative class), the agent type on ${num(P.atLogged)}; otherwise the two detectors (agent id, billing flag) are the only cross-check, which tests consistency, not labelled truth.`);
  L.push("");
  for (const id of ["T1", "T2", "T3", "T4", "T5", "T6"]) { const m = r.metrics[id]; L.push(`${id} ${m.name}: ${m.status}: ${m.reason}`); }
  L.push(`AGE ${r.age.name}: ${r.age.status}: ${r.age.reason}`);
  if (r.single.n) L.push(`UNCORROBORATED (one detector, no rc; ${KINDS_NOTE}): ${num(r.single.n)} tool-carrying requests, ${shareLine("classified sub", r.single.classifiedSub, r.single.n)}; they are not in T1 because nothing independent confirms them`);
  const hrs = r.metrics.T2;
  L.push(`HELPER EVIDENCE: the router does not log a returned model for a helper request; ${num(hrs.decisionRowsHelperShaped)} helper-shaped rows are in the decision log (${num(hrs.decisionRowsRewritten)} returned on another model); the router returns the asked model for aux and exempt requests by construction`);
  L.push("");
  L.push("MINIMUM SAMPLES (all must be met, or the verdict is INSUFFICIENT, never PASS):");
  for (const m of r.minimums) L.push(`  ${m.ok ? "ok     " : "MISSING"} ${m.text}`);
  if (r.missing.length) { L.push(""); L.push("WHAT TRAFFIC IS MISSING:"); for (const x of r.missing) L.push(`  - ${x}`); }
  L.push("");
  const sh = r.shadow;
  L.push(`SHADOW TALLY (G3 preconditions 1 and 7): ${num(sh.subagentRequests)} client subagent requests in the window (probe traffic excluded)${sh.droppedKeys ? `, ${sh.droppedKeys} not tallied (key cap)` : ""}.`);
  if (sh.note) L.push(`  ${sh.note}`);
  if (sh.modes) {
    const pl = sh.policies;
    L.push(`  Modelled offline from the compiled policy of each mode (owner file toggles: source ${pl.base.source}, free scope ${pl.base.freeScope}, ctx ${pl.base.ctx}; inputs on disk, providers from the snapshot routable flag${pl.providersLive ? "" : ", NOT the live gateway"}); expected-value spread over the lead pool, ignoring cooling, payload caps and the tier rule; a model the request would keep counts as not moved.`);
    if (pl.live && pl.live.recompiledRows !== null) L.push(`  Cross-check: the live policy.json (mode ${pl.live.mode}) holds ${pl.live.rows} rows; this recompile of mode ${pl.live.mode} holds ${pl.live.recompiledRows}${pl.live.rows === pl.live.recompiledRows ? " (same)" : " (DIFFERENT: the live file was built from live Providers or newer inputs)"}.`);
    for (const t of sh.modes) {
      L.push(`  mode ${t.mode}${t.mode === "inherit" ? "" : ` (${t.rows} rows)`}: of ${num(t.requests)} subagent requests: ${shareLine("would move off the asked model", t.moved, t.requests)}, ${shareLine("keep it", t.keep, t.requests)}, ${shareLine("no eligible substitute", t.none, t.requests)}, ${shareLine("no learned main model", t.noMain, t.requests)}`);
      if (t.byProvider.length) L.push(`    by provider (of the ${num(t.moved)} that move): ${t.byProvider.map(([k, v]) => `${k} ${num(Math.round(v))}`).join(", ")}`);
      if (t.byModel.length) L.push(`    top models: ${t.byModel.slice(0, 8).map(([k, v]) => `${k} ${num(Math.round(v))}`).join(", ")}`);
    }
    const ob = sh.observed;
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
  "usage: node keysync/subagent-accuracy.mjs [--since 7d|30d] [--json yes] [--write yes --live yes] [--cc-version V --ccr-version V] [--tally no]",
  "  Reads the router's classifier, decision and agent logs (read-only), excludes sessionless probe traffic, prints T1..T6 with PASS, FAIL or INSUFFICIENT and the shadow tally of the three modes.",
  "  --since       evidence window, a number and h or d, at most 30d (a PASS expires after 30 days; older lines are not counted). Default 30d.",
  "  --json yes    print the whole record as JSON instead of text.",
  "  --write yes --live yes   write state/subagent/accuracy.json (atomic). Dry by default; BOTH flags are required. The file replaces the previous verdict, including a PASS.",
  "  --cc-version, --ccr-version   the versions measured (T6); without them the verdict cannot be PASS.",
  "  --tally no    skip the three-mode tally (the log checks only).",
  "  Test flags (a fixture run): --state-dir DIR plus any of --snapshot-file --bench-file --observed-file --tool-fidelity-file --settings-file --default-model-file --registry-file --key-choices-file --vault-providers-file --providers-file --policy-file.",
  "  Exit: 0 computed (any verdict, INSUFFICIENT included), 1 write or read failure, 2 usage.",
].join("\n");
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
    if (name === "since") {
      if (!/^[1-9]\d{0,3}[hd]$/.test(v)) throw bad(`flag --since takes a number and h or d, like 24h, 7d or 30d, found ${JSON.stringify(clip(v, 20))}`);
      if (Number(v.slice(0, -1)) * UNITS[v.slice(-1)] > THRESHOLDS.maxAgeDays * DAY_MS) throw bad(`flag --since ${v} is longer than ${THRESHOLDS.maxAgeDays}d: a PASS expires after ${THRESHOLDS.maxAgeDays} days, so older traffic is never counted`);
      flags[name] = v; continue;
    }
    if (name === "cc-version" || name === "ccr-version") { if (!/^[A-Za-z0-9._+~-]{1,40}$/.test(v)) throw bad(`flag ${a} takes a version of letters, digits and . _ + ~ -, found ${JSON.stringify(clip(v, 40))}`); flags[name] = v; continue; }
    if (v.trim() === "") throw bad(`flag ${a} needs a file path`);
    flags[name] = v;
  }
  if (flags.write && !flags.live) throw bad("--write yes needs --live yes too: it replaces state/subagent/accuracy.json, the file the enforce precondition reads");
  if (flags.live && !flags.write) throw bad("--live yes only goes with --write yes");
  return flags;
}

/** The CLI body, with its sinks injected. Returns the exit code. */
export async function runSubagentAccuracy(argv, io, env = process.env, opts = {}) {
  let flags;
  try { flags = parseAccuracyArgs(argv); } catch (e) { if (e instanceof PolicyError) { io.err(e.message); io.err(USAGE); return 2; } throw e; }
  const nowMs = opts.now ?? Date.now();
  let p;
  try { p = resolvePaths(flags, { env }); } catch (e) { if (e instanceof PolicyError) { io.err(e.message); return 2; } throw e; }
  let rec;
  try {
    rec = await runEvaluation(p, { nowMs, sinceMsV: flags.since ? Number(flags.since.slice(0, -1)) * UNITS[flags.since.slice(-1)] : 30 * DAY_MS, versions: { cc: flags["cc-version"], ccr: flags["ccr-version"] }, tally: flags.tally !== false, providersFile: !!flags["providers-file"] });
  } catch (e) { io.err(`cannot evaluate: ${clip(e?.code ?? e?.message ?? "error", 120)}`); return 1; }
  if (flags.json) io.out(JSON.stringify(rec.record, null, 2)); else for (const l of rec.text) io.out(l);
  if (flags.write) {
    const file = path.join(p.stateDir, "accuracy.json");
    const prev = readJsonFile(file);
    try { writeFileRetry(file, JSON.stringify(rec.record, null, 2) + "\n"); }
    catch (e) { io.err(`cannot write ${file}: ${clip(e?.message ?? "error", 120)}`); return 1; }
    io.out(`WROTE ${file}: verdict ${rec.record.verdict}${prev.ok && prev.value?.verdict ? ` (replaced a previous ${clip(prev.value.verdict, 20)} from ${clip(prev.value.at ?? "?", 30)})` : ""}`);
  } else io.out("dry: nothing written (--write yes --live yes writes state/subagent/accuracy.json)");
  return 0;
}

const isMain = (() => { try { return process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isMain) {
  const code = await runSubagentAccuracy(process.argv.slice(2), { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n") });
  process.exitCode = code;
}

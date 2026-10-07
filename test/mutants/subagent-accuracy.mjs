// Mutation check for keysync/subagent-accuracy.mjs: each mutant breaks ONE rule (the probe exclusion, the rc requirement, a threshold, a minimum, the writer) in a COPY of the module that sits next to the
// original (its relative imports must resolve), points test/subagent-accuracy.test.mjs at the copy through UW_TEST_ACCURACY, and expects the suite to FAIL. A mutant the suite lets pass is a hole in the
// tests and exits 1.
//   node test/mutants/subagent-accuracy.mjs [name-fragment]
// The copy is deleted afterwards; nothing else is written. Run time: about 7 seconds per mutant.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "keysync", "subagent-accuracy.mjs");
const COPY = path.join(ROOT, "keysync", "subagent-accuracy.mutant.mjs");
const text = fs.readFileSync(SRC, "utf8");

// [name, original text or RegExp (must occur exactly once), replacement]
const MUTANTS = [
  ["exclusion: probe class rows are counted as client rows", "if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; return; }", "if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; }"],
  ["exclusion: hasSid false is ignored (only the session spelling counts)", "probe: isProbeRow(o),", "probe: isProbeSid(o.sid),"],
  ["exclusion: the session spelling is ignored (only hasSid false counts)", "probe: isProbeRow(o),", "probe: o.hasSid === false,"],
  ["exclusion: probe decision rows are counted", "if (isProbeSid(d.sid)) { acc.dec.probe += 1; return; }", "if (isProbeSid(d.sid)) { acc.dec.probe += 1; }"],
  ["exclusion: probe agent rows are counted", "if (isProbeSid(a.sid)) { acc.ag.probe += 1; return; }", "if (isProbeSid(a.sid)) { acc.ag.probe += 1; }"],
  ["rc requirement: detector-only built-in rows count as T1 ground truth", "} else if (rcSub) {", "} else if (rcSub || (r.ag && r.bl)) {"],
  ["rc requirement: detector-only rows count as T4 main samples", "if (r.rc === \"main\") {", "if (r.rc === \"main\" || !agentShaped) {"],
  ["rc requirement: detector-shaped helpers count as T2 labelled samples", "} else if (rcHelper) {", "} else if (rcHelper || (agentShaped && !tools)) {"],
  ["T1 percentage 99 -> 100", "t1Pct: 99,", "t1Pct: 100,"],
  ["T1 percentage 99 -> 98", "t1Pct: 99,", "t1Pct: 98,"],
  ["T1 Wilson bound 97 -> 99.5", "t1Wilson: 97,", "t1Wilson: 99.5,"],
  ["Wilson z 1.645 -> 1.0", "export const Z95 = 1.645;", "export const Z95 = 1.0;"],
  ["Wilson body: centre term sign", "(p + z2 / (2 * n) - z * Math.sqrt(", "(p - z2 / (2 * n) - z * Math.sqrt("],
  ["Wilson body: radicand term sign", "p * (1 - p)) / n + z2 / (4 * n * n))", "p * (1 - p)) / n - z2 / (4 * n * n))"],
  ["Wilson body: denominator sign", "/ (1 + z2 / n));", "/ (1 - z2 / n));"],
  ["T1 binding bound ignores the per-agent bound", "bound = Math.min(wReq, wAg)", "bound = wReq"],
  ["T1 does not need distinct agents", "else if (agN < M.distinctAgents)", "else if (false)"],
  ["T1 minimum 200 -> 199", "builtIn: 40, t1: 200", "builtIn: 40, t1: 199"],
  ["T1 minimum 200 -> 201", "builtIn: 40, t1: 200", "builtIn: 40, t1: 201"],
  ["T2 tolerance: one rewritten helper is allowed", "if (hViol > 0) { status = \"FAIL\"", "if (hViol > 1) { status = \"FAIL\""],
  ["T2 minimum 200 -> 199", "t2MinHelpers: 200,", "t2MinHelpers: 199,"],
  ["T2 minimum 200 -> 201", "t2MinHelpers: 200,", "t2MinHelpers: 201,"],
  ["T2 ignores the decision log rewrites", "if (d.asked && d.ret && d.ret !== d.asked) { acc.dec.helperRewritten += 1;", "if (false) { acc.dec.helperRewritten += 1;"],
  ["T2 arm: sub is not a violation", "cls === \"sub\" || cls === \"exempt\" || cls === \"other\" ||", "cls === \"exempt\" || cls === \"other\" ||"],
  ["T2 arm: exempt is not a violation", "cls === \"sub\" || cls === \"exempt\" || cls === \"other\" ||", "cls === \"sub\" || cls === \"other\" ||"],
  ["T2 arm: other is not a violation", "cls === \"sub\" || cls === \"exempt\" || cls === \"other\" ||", "cls === \"sub\" || cls === \"exempt\" ||"],
  ["T2 arm: main with a detector set is not a violation", "|| (cls === \"main\" && agentShaped);", ";"],
  ["T2 arm: main with no detector IS a violation (a passthrough is counted as a rewrite)", "(cls === \"main\" && agentShaped)", "cls === \"main\""],
  ["T4 tolerance: one misclassified main is allowed", "if (mViol > 0) { status = \"FAIL\"", "if (mViol > 1) { status = \"FAIL\""],
  ["T4 ignores main-learn by a subagent", "if (d.act === \"main-learn\" && (d.ag || d.bl)) acc.dec.mainLearnNonMain += 1;", "if (false) acc.dec.mainLearnNonMain += 1;"],
  ["T4 main minimum 200 -> 199", "perLabelledHelperType: 40, main: 200,", "perLabelledHelperType: 40, main: 199,"],
  ["T4 main minimum 200 -> 201", "perLabelledHelperType: 40, main: 200,", "perLabelledHelperType: 40, main: 201,"],
  ["T5 limit 1% -> 2.5%", "t5MaxDisagreePct: 1,", "t5MaxDisagreePct: 2.5,"],
  ["T5 boundary: exactly 1% fails (<= becomes <)", "else if (rate <= T.t5MaxDisagreePct)", "else if (rate < T.t5MaxDisagreePct)"],
  ["T5 minimum 40 -> 39", "builtIn: 40, t1:", "builtIn: 39, t1:"],
  ["T5 does not need distinct agents", "else if (agentsB < M.distinctAgents)", "else if (false)"],
  ["T6 versions are not required", "const cc = wholeVersion(versions.cc, { suffix: \"(Claude Code)\" }), ccr = wholeVersion(versions.ccr), ok = !!(cc && ccr);", "const cc = wholeVersion(versions.cc, { suffix: \"(Claude Code)\" }), ccr = wholeVersion(versions.ccr), ok = true;"],
  ["T6 takes a free-text version (the gate would refuse it)", "ok = !!(cc && ccr);", "ok = !!(versions.cc && versions.ccr);"],
  ["consensus counters count rc-labelled helper rows", "if (rcHelper) acc.cons.helperExcluded += 1;", "if (false) acc.cons.helperExcluded += 1;"],
  ["version rule: no end anchor", "const VERSION_RE = /^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.+-]+)?$/;", "const VERSION_RE = /^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.+-]+)?/;"],
  ["version rule: no start anchor", "const VERSION_RE = /^\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.+-]+)?$/;", "const VERSION_RE = /\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.+-]+)?$/;"],
  ["version rule: the pre-release or build tag is refused", "(?:[-+][0-9A-Za-z.+-]+)?$/;", "$/;"],
  ["version rule: the Claude Code suffix is not stripped", "if (suffix && t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();", ""],
  ["version rule: the suffix is stripped for CCR too", "{ suffix: \"(Claude Code)\" } : {});", "{ suffix: \"(Claude Code)\" } : { suffix: \"(Claude Code)\" });"],
  ["since date: the window start ignores it", "cutoff: Math.max(nowMs - win, fromMs ?? -Infinity),", "cutoff: nowMs - win,"],
  ["since date: a date is read as a duration error", "flags.sinceDate = new Date(ms).toISOString(); continue;", "continue;"],
  ["since date: a future date is accepted", "Date.parse(flags.sinceDate) > nowMs + THRESHOLDS.futureToleranceMs", "false"],
  ["since date: the header does not say it", "${r.window.from ? `, bounded from", "${false ? `, bounded from"],
  ["since date: rows before the bound are not tallied apart (classify)", "if (r.ms < acc.cutoff) { if (acc.excl) feedClass(acc.excl, o); return; }", "if (r.ms < acc.cutoff) { return; }"],
  ["since date: decision rows before the bound are not tallied apart", "if (d && d.ms < acc.cutoff && acc.excl) feedDecision(acc.excl, o, liveHash);", ""],
  ["since date: excludedByFrom is not recorded", "excludedByFrom: excludedByFrom(acc),", "excludedByFrom: null,"],
  ["since date: excluded violations omit the T1 misses", "violations: t1Miss + t2Viol + t4Miss", "violations: t2Viol + t4Miss"],
  ["since date: excluded T2 violations omit the decision-log rewrites", "sumArms(x.helper.shaped.viol) + x.dec.helperRewritten", "sumArms(x.helper.shaped.viol)"],
  ["since date: excluded T4 misses omit main-learn", "sumArms(x.main.notMain) + x.dec.mainLearnNonMain", "sumArms(x.main.notMain)"],
  ["since date: a bare datetime is accepted", "if (name === \"since\" && ISO_NO_ZONE_RE.test(v))", "if (false)"],
  ["since date: a nonexistent day is accepted", "|| !realDay(v)", ""],
  ["since date: the offset is dropped", "const ms = Date.parse(v);", "const ms = Date.parse(v.slice(0, 19) + \"Z\");"],
  ["since date: the usage does not say every metric", "in EVERY metric (T1, T2, T4 and T5 alike, not T2 only). ", ""],
  ["since date: accuracy.json does not record it", "window: { from: sinceDate === null ? null : new Date(acc.fromMs).toISOString(),", "window: { from: null,"],
  ["T2 hint: never shown", "lastViol > 0 && (acc.fromMs === null || acc.fromMs <= lastViol)", "false && (acc.fromMs === null || acc.fromMs <= lastViol)"],
  ["T2 hint: shown only without a date", "(acc.fromMs === null || acc.fromMs <= lastViol)", "(acc.fromMs === null)"],
  ["T2 hint: the instant is the violating row itself, not just after it", "new Date(ms + 1000).toISOString()", "new Date(ms).toISOString()"],
  ["T2 hint: the next UTC day instead of an instant", "instantAfter = (ms) => new Date(ms + 1000).toISOString();", "instantAfter = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS).toISOString().slice(0, 10);"],
  ["T2 hint: does not say the bound applies to every metric", "the bound applies to EVERY metric, T1 and T4 as well as T2, and ", ""],
  ["T2 hint: the decision-log leg is not tracked", "acc.dec.lastRewriteMs = Math.max(acc.dec.lastRewriteMs, d.ms);", ""],
  ["T2 hint: the rc leg is not tracked", "helperViolation(r.cls, agentShaped)) { h.viol[r.cls] += 1; acc.helper.lastViolMs = Math.max(acc.helper.lastViolMs, r.ms); }", "helperViolation(r.cls, agentShaped)) { h.viol[r.cls] += 1; }"],
  ["T2 hint: the detector-shaped leg is not tracked", "helperViolation(r.cls, true)) { h.viol[r.cls] += 1; acc.helper.lastViolMs = Math.max(acc.helper.lastViolMs, r.ms); }", "helperViolation(r.cls, true)) { h.viol[r.cls] += 1; }"],
  ["per-type minimum 40 -> 39", "perSubagentType: 40,", "perSubagentType: 39,"],
  ["subagent types needed 5 -> 4", "subagentTypes: 5,", "subagentTypes: 4,"],
  ["distinct agents 30 -> 29", "distinctAgents: 30,", "distinctAgents: 29,"],
  ["teammates count as built-in agents", "if (r.bl || rcSub) {", "if (r.bl || rcSub || r.ag) {"],
  ["labelled helper type minimum 40 -> 39", "perLabelledHelperType: 40,", "perLabelledHelperType: 39,"],
  ["main sessions 2 -> 1", "mainSessions: 2,", "mainSessions: 1,"],
  ["main model switch not required", "mainModelSwitches: 1,", "mainModelSwitches: 0,"],
  ["main model switch counted on tool-less rows too", /if \(tools\) \{\s+\/\/ a \/model switch/, "if (true) { // a /model switch"],
  ["client sessions 3 -> 2", "sessions: 3, perSession: 20,", "sessions: 2, perSession: 20,"],
  ["per-session minimum 20 -> 19", "perSession: 20,", "perSession: 19,"],
  ["UTC days 2 -> 1", "days: 2, builtIn", "days: 1, builtIn"],
  ["evidence age limit 7 -> 8 days", "maxEvidenceAgeDays: 7,", "maxEvidenceAgeDays: 8,"],
  ["PASS expiry and window 30 -> 31 days", "maxAgeDays: 30,", "maxAgeDays: 31,"],
  ["AGE removed from the gated set", "const gated = [metrics.T1, metrics.T2, metrics.T4, metrics.T5, metrics.T6, age];", "const gated = [metrics.T1, metrics.T2, metrics.T4, metrics.T5, metrics.T6];"],
  ["future tolerance 5 minutes -> 1 day", "futureToleranceMs: 5 * 60 * 1000", "futureToleranceMs: 24 * 3600 * 1000"],
  ["future tolerance 5 minutes -> 1 minute", "futureToleranceMs: 5 * 60 * 1000", "futureToleranceMs: 60 * 1000"],
  ["rc subagent is not read", "const rcSub = r.rc === \"subagent\" || r.rc === \"workflow\"", "const rcSub = r.rc === \"workflow\""],
  ["rc workflow is not read", "const rcSub = r.rc === \"subagent\" || r.rc === \"workflow\"", "const rcSub = r.rc === \"subagent\""],
  ["exempt is not a correct sub classification", "else if (r.cls === \"exempt\") { t.sub += 1; t.exempt += 1; }", "else if (r.cls === \"exempt\") { t.exempt += 1; t.missBy.other += 1; }"],
  ["the window is not clamped to 30 days", "const win = Math.min(sinceMsV, THRESHOLDS.maxAgeDays * DAY_MS);", "const win = sinceMsV;"],
  ["a verdict is PASS without the minimums", "gated.every((x) => x.status === \"PASS\") && mins.every((x) => x.ok)", "gated.every((x) => x.status === \"PASS\")"],
  ["writer: the verdict field is not the computed one", "schema: ACCURACY_SCHEMA, verdict: ev.verdict,", "schema: ACCURACY_SCHEMA, verdict: \"PASS\","],
  ["writer: the at field is not now", "at: new Date(nowMs).toISOString(), ccVersion", "at: new Date(0).toISOString(), ccVersion"],
  ["write: --write does not need --live", "if (flags.write && !flags.live) throw bad(", "if (false) throw bad("],
  ["json: the notes stay on stdout", "const note = flags.json ? io.err : io.out;", "const note = io.out;"],
  ["warning: an unexpired PASS is replaced silently", "rec.record.verdict !== \"PASS\" && Number.isFinite(prevAt)", "false && Number.isFinite(prevAt)"],
  ["warning: an expired PASS also warns", "nowMs - prevAt < THRESHOLDS.maxAgeDays * DAY_MS", "true"],
  ["tally: inherit never keeps an exempt model", "if (Array.isArray(pol.exempt) && pol.exempt.includes(asked)) return { kind: \"keep\", picks: [[asked, 1]] };", ""],
  ["tally: the lead pool is not capped at K", "const res = pool(SUBSTITUTE_K);", "const res = pool(99);"],
  ["tally: bands are mixed", "if (banded && lead !== null && r.b !== lead.b) break;", ""],
  ["tally: the context floor ignores the asked-model hint", "const hint = own(pol.ctxHints, asked), floor", "const hint = undefined, floor"],
  ["tally: payload caps are ignored", "const fitsBytes = (row, bytes) => !row || !(row.pb > 0) || !(bytes > 0) || bytes <= row.pb;", "const fitsBytes = () => true;"],
  ["tally: an unknown cap never ranks last", "const unkBig = (row, bytes) => bytes > BIG_REQ &&", "const unkBig = (row, bytes) => false &&"],
  ["tally: a proven bk does not cover the request", "row.bk >= bytes", "false"],
  ["tally: main-first takes an unknown-cap main", " && !unkBig(mainRow, bytes)", ""],
];

const countOf = (from) => (from instanceof RegExp ? (text.match(new RegExp(from.source, "g")) ?? []).length : text.split(from).length - 1);
const only = process.argv[2];
let survived = 0, run = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (only && !name.includes(only)) continue;
    const n = countOf(from);
    if (n !== 1) { console.log(`BROKEN MUTANT (pattern occurs ${n} times): ${name}`); survived += 1; continue; }
    fs.writeFileSync(COPY, text.replace(from, () => to));
    const r = spawnSync(process.execPath, ["--test", path.join(ROOT, "test", "subagent-accuracy.test.mjs")], { env: { ...process.env, UW_TEST_ACCURACY: COPY }, encoding: "utf8", timeout: 240000 });
    run += 1;
    const killed = r.status !== 0;
    if (!killed) survived += 1;
    console.log(`${killed ? "killed  " : "SURVIVED"} ${name}`);
  }
} finally { fs.rmSync(COPY, { force: true }); }
console.log(`${run} mutants run, ${survived} survived`);
process.exit(survived ? 1 : 0);

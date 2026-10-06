// Mutation check for keysync/subagent-accuracy.mjs: each mutant breaks ONE rule (the probe exclusion, a threshold, a minimum) in a COPY of the module that sits next to the original (its relative imports
// must resolve), points test/subagent-accuracy.test.mjs at the copy through UW_TEST_ACCURACY, and expects the suite to FAIL. A mutant the suite lets pass is a hole in the tests and exits 1.
//   node test/mutants/subagent-accuracy.mjs [name-fragment]
// The copy is deleted afterwards; nothing else is written. Run time: about 6 seconds per mutant.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "keysync", "subagent-accuracy.mjs");
const COPY = path.join(ROOT, "keysync", "subagent-accuracy.mutant.mjs");
const text = fs.readFileSync(SRC, "utf8");

// [name, original text (must occur exactly once), replacement]
const MUTANTS = [
  ["exclusion: probe class rows are counted as client rows", "if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; return; }", "if (r.probe) { acc.probe += 1; if (r.ag || r.bl) acc.probeAgentShaped += 1; }"],
  ["exclusion: hasSid false is ignored (only the session spelling counts)", "probe: isProbeRow(o),", "probe: isProbeSid(o.sid),"],
  ["exclusion: the session spelling is ignored (only hasSid false counts)", "probe: isProbeRow(o),", "probe: o.hasSid === false,"],
  ["exclusion: probe decision rows are counted", "if (isProbeSid(d.sid)) { acc.dec.probe += 1; return; }", "if (isProbeSid(d.sid)) { acc.dec.probe += 1; }"],
  ["exclusion: probe agent rows are counted", "if (isProbeSid(a.sid)) { acc.ag.probe += 1; return; }", "if (isProbeSid(a.sid)) { acc.ag.probe += 1; }"],
  ["T1 percentage 99 -> 100", "t1Pct: 99,", "t1Pct: 100,"],
  ["T1 percentage 99 -> 98", "t1Pct: 99,", "t1Pct: 98,"],
  ["T1 Wilson bound 97 -> 99.5", "t1Wilson: 97,", "t1Wilson: 99.5,"],
  ["Wilson z 1.645 -> 1.0", "export const Z95 = 1.645;", "export const Z95 = 1.0;"],
  ["T1 minimum 200 -> 199", "main: 200, mainSessions: 2, mainModelSwitches: 1, sessions: 3, days: 2, builtIn: 40, t1: 200", "main: 200, mainSessions: 2, mainModelSwitches: 1, sessions: 3, days: 2, builtIn: 40, t1: 199"],
  ["T1 minimum 200 -> 201", "builtIn: 40, t1: 200", "builtIn: 40, t1: 201"],
  ["T2 tolerance: one rewritten helper is allowed", "if (hViol > 0) { status = \"FAIL\"", "if (hViol > 1) { status = \"FAIL\""],
  ["T2 minimum 200 -> 199", "t2MinHelpers: 200,", "t2MinHelpers: 199,"],
  ["T2 minimum 200 -> 201", "t2MinHelpers: 200,", "t2MinHelpers: 201,"],
  ["T2 ignores the decision log rewrites", "if (d.asked && d.ret && d.ret !== d.asked) acc.dec.helperRewritten += 1;", "if (false) acc.dec.helperRewritten += 1;"],
  ["T4 tolerance: one misclassified main is allowed", "if (mViol > 0) { status = \"FAIL\"", "if (mViol > 1) { status = \"FAIL\""],
  ["T4 ignores main-learn by a subagent", "if (d.act === \"main-learn\" && (d.ag || d.bl)) acc.dec.mainLearnNonMain += 1;", "if (false) acc.dec.mainLearnNonMain += 1;"],
  ["T4 main minimum 200 -> 199", "helperTotal: 200, perLabelledHelperType: 40, main: 200,", "helperTotal: 200, perLabelledHelperType: 40, main: 199,"],
  ["T4 main minimum 200 -> 201", "perLabelledHelperType: 40, main: 200,", "perLabelledHelperType: 40, main: 201,"],
  ["T5 limit 1% -> 2.5%", "t5MaxDisagreePct: 1,", "t5MaxDisagreePct: 2.5,"],
  ["T5 minimum 40 -> 39", "builtIn: 40, t1:", "builtIn: 39, t1:"],
  ["T6 versions are not required", "const ok = typeof versions.cc === \"string\" && versions.cc && typeof versions.ccr === \"string\" && versions.ccr;", "const ok = true;"],
  ["per-type minimum 40 -> 39", "perSubagentType: 40,", "perSubagentType: 39,"],
  ["subagent types needed 5 -> 4", "subagentTypes: 5,", "subagentTypes: 4,"],
  ["distinct agents 30 -> 29", "distinctAgents: 30,", "distinctAgents: 29,"],
  ["labelled helper type minimum 40 -> 39", "perLabelledHelperType: 40,", "perLabelledHelperType: 39,"],
  ["main sessions 2 -> 1", "mainSessions: 2,", "mainSessions: 1,"],
  ["main model switch not required", "mainModelSwitches: 1,", "mainModelSwitches: 0,"],
  ["client sessions 3 -> 2", "sessions: 3, days: 2,", "sessions: 2, days: 2,"],
  ["UTC days 2 -> 1", "days: 2, builtIn", "days: 1, builtIn"],
  ["age limit 30 -> 31 days", "maxAgeDays: 30 }", "maxAgeDays: 31 }"],
  ["a single detector counts as corroborated (teammates enter T1)", "else if (r.ag && r.bl) { via = \"detectors\";", "else if (r.ag || r.bl) { via = \"detectors\";"],
  ["rc subagent is not read", "r.rc === \"subagent\" || r.rc === \"workflow\" ? \"sub\"", "r.rc === \"workflow\" ? \"sub\""],
  ["rc workflow is not read", "r.rc === \"subagent\" || r.rc === \"workflow\" ? \"sub\"", "r.rc === \"subagent\" ? \"sub\""],
  ["exempt is not a correct sub classification", "else if (r.cls === \"exempt\") { acc.t1.sub += 1; acc.t1.exempt += 1; }", "else if (r.cls === \"exempt\") { acc.t1.exempt += 1; acc.t1.missBy.other += 1; }"],
  ["the window is not clamped to 30 days", "const win = Math.min(sinceMsV, THRESHOLDS.maxAgeDays * DAY_MS);", "const win = sinceMsV;"],
  ["a verdict is PASS without the minimums", "gated.every((x) => x.status === \"PASS\") && mins.every((x) => x.ok)", "gated.every((x) => x.status === \"PASS\")"],
  ["tally: inherit never keeps an exempt model", "if (Array.isArray(pol.exempt) && pol.exempt.includes(asked)) return { kind: \"keep\", picks: [[asked, 1]] };", ""],
  ["tally: the lead pool is not capped at K", "const got = pool(SUBSTITUTE_K);", "const got = pool(99);"],
  ["tally: bands are mixed", "if (banded && lead !== null && r.b !== lead.b) break;", ""],
  ["tally: the context floor ignores the asked-model hint", "const hint = own(pol.ctxHints, asked), floor", "const hint = undefined, floor"],
  ["write: --write does not need --live", "if (flags.write && !flags.live) throw bad(", "if (false) throw bad("],
];

const only = process.argv[2];
let survived = 0, run = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    if (only && !name.includes(only)) continue;
    const n = text.split(from).length - 1;
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

// Sweep comparison: bench.first-sweep.json (sweep 1) vs bench.json (final merged view), with bench.before-probe-all.json as the
// mid-point (taken before the probe-all run). Unit: bench KEY (provider/id with [1m] stripped), 5,793 in every file. READ-ONLY.
import fs from "node:fs"; import path from "node:path";
import { H, OUT, readJson, iso, q, redact } from "./lib.mjs";
import { cluster, textOf } from "./clusters.mjs";
const S = (f) => readJson(path.join(H, ".uw/state", f));
const F = S("bench.first-sweep.json"), B = S("bench.before-probe-all.json"), C = S("bench.json");
const first = F.models, mid = B.models, fin = C.models;
const keys = Object.keys(fin);
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const provOf = (k) => k.slice(0, k.indexOf("/"));
const ST = ["ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate", "skip"];
const TRANSIENT = new Set(["rate", "timeout", "error", "skip"]);
const D = { meta: { firstGeneratedAt: F.generatedAt, midGeneratedAt: B.generatedAt, finalGeneratedAt: C.generatedAt, keysFirst: Object.keys(first).length, keysMid: Object.keys(mid).length, keysFinal: keys.length } };

// distribution per file
const dist = (m) => { const o = {}; for (const r of Object.values(m)) inc(o, r.s); return o; };
D.dist = { first: dist(first), mid: dist(mid), final: dist(fin) };
D.skipReasonFirst = {}; for (const r of Object.values(first)) if (r.s === "skip") inc(D.skipReasonFirst, r.w);
D.skipReasonMid = {}; for (const r of Object.values(mid)) if (r.s === "skip") inc(D.skipReasonMid, r.w);
D.firstTimes = { min: iso(Math.min(...Object.values(first).map((r) => r.a))), max: iso(Math.max(...Object.values(first).map((r) => r.a))) };

// stage steps: first -> mid (run2) and mid -> final (run3)
const changed = (a, b) => keys.filter((k) => a[k].a !== b[k].a || a[k].s !== b[k].s);
const run2 = changed(first, mid), run3 = changed(mid, fin);
D.run2 = { changed: run2.length, trans: {} };
for (const k of run2) inc(D.run2.trans, `${first[k].s}->${mid[k].s}`);
D.run3 = { changed: run3.length };
D.run2Window = run2.length ? { min: iso(Math.min(...run2.map((k) => mid[k].a))), max: iso(Math.max(...run2.map((k) => mid[k].a))) } : null;

// (1) transition matrix first -> final
const M = {}; for (const s of ST) M[s] = Object.fromEntries(ST.map((t) => [t, 0]));
for (const k of keys) M[first[k].s][fin[k].s]++;
D.matrix = M;

// (2) first-sweep skip -> final, per provider
const skipKeys = keys.filter((k) => first[k].s === "skip");
D.skip = { n: skipKeys.length, toFinal: {}, byReason: {}, byProvider: {} };
for (const k of skipKeys) {
  inc(D.skip.toFinal, fin[k].s);
  const w = first[k].w; D.skip.byReason[w] ??= {}; inc(D.skip.byReason[w], fin[k].s);
  const p = provOf(k); D.skip.byProvider[p] ??= { skip: 0, ok: 0, answered: 0, ...Object.fromEntries(ST.map((s) => [s, 0])) };
  const o = D.skip.byProvider[p]; o.skip++; o[fin[k].s]++;
  if (fin[k].s === "ok" || fin[k].s === "empty") o.answered++;
}
D.skip.realAnswer = skipKeys.filter((k) => fin[k].s !== "skip").length;
D.skip.answeredOkEmpty = skipKeys.filter((k) => fin[k].s === "ok" || fin[k].s === "empty").length;
D.skip.ok = skipKeys.filter((k) => fin[k].s === "ok").length;
D.skip.top15 = Object.entries(D.skip.byProvider).sort((a, b) => b[1].skip - a[1].skip).slice(0, 15).map(([p, o]) => ({ provider: p, ...o }));
D.skip.stillSkip = skipKeys.filter((k) => fin[k].s === "skip").length;

// (3) first-sweep error -> final
const errKeys = keys.filter((k) => first[k].s === "error");
D.err = { n: errKeys.length, toFinal: {}, goneCauses: {}, goneWithMessage: 0, sameMessage: 0, byProviderGone: {} };
for (const k of errKeys) {
  inc(D.err.toFinal, fin[k].s);
  if (fin[k].s === "gone") { const c = cluster("gone", textOf(fin[k])); inc(D.err.goneCauses, c); inc(D.err.byProviderGone, provOf(k)); if (fin[k].m) D.err.goneWithMessage++; }
}
D.err.firstPreviewSample = errKeys.filter((k) => fin[k].s === "gone").slice(0, 6).map((k) => `${k} | first p="${first[k].p ?? ""}" -> final m="${(fin[k].m ?? fin[k].p ?? "").slice(0, 70)}"`);
D.err.byFinalProvider = {}; for (const k of errKeys) { const p = provOf(k); D.err.byFinalProvider[p] ??= {}; inc(D.err.byFinalProvider[p], fin[k].s); }
// same for every transient first status
D.trans = {}; for (const s of ["error", "timeout", "rate"]) { const ks = keys.filter((k) => first[k].s === s); D.trans[s] = { n: ks.length, toFinal: {} }; for (const k of ks) inc(D.trans[s].toFinal, fin[k].s); }

// (4) non-transient -> different result
const nt = keys.filter((k) => !TRANSIENT.has(first[k].s));
D.nt = { n: nt.length, unchanged: nt.filter((k) => first[k].a === fin[k].a).length, reprobed: nt.filter((k) => first[k].a !== fin[k].a).length,
  changedToNonTransient: [], changedToTransient: [], sameStatusReprobed: 0 };
for (const k of nt) {
  if (first[k].a === fin[k].a) continue;
  if (first[k].s === fin[k].s) { D.nt.sameStatusReprobed++; continue; }
  const row = { key: k, from: first[k].s, to: fin[k].s, fromP: (first[k].p ?? "").slice(0, 50), toM: (fin[k].m ?? fin[k].p ?? "").slice(0, 80), stage: mid[k].a === first[k].a ? "run3" : "run2", firstAt: iso(first[k].a), finalAt: iso(fin[k].a) };
  (TRANSIENT.has(fin[k].s) ? D.nt.changedToTransient : D.nt.changedToNonTransient).push(row);
}

// (5) fresh result in sweep 1 only / sweep 2 only / both. "real result" = any non-skip record. sweep 2 = written by the probe-all run (a >= its first record)
const run3Start = Math.min(...run3.map((k) => fin[k].a));
D.run3Start = iso(run3Start);
const real1 = (k) => first[k].s !== "skip";
const real2 = (k) => fin[k].a >= run3Start && fin[k].s !== "skip";
D.fresh = { sweep1Only: 0, sweep2Only: 0, both: 0, neither: 0, midOnly: 0 };
for (const k of keys) {
  const a = real1(k), b = real2(k);
  if (a && b) D.fresh.both++; else if (a) { if (mid[k].a !== first[k].a && mid[k].s !== "skip" && fin[k].a === mid[k].a) D.fresh.midOnly++; else D.fresh.sweep1Only++; } else if (b) D.fresh.sweep2Only++; else D.fresh.neither++;
}
D.fresh.realFirst = keys.filter(real1).length; D.fresh.realSecond = keys.filter(real2).length;
D.fresh.firstRealNotReprobedByRun3 = keys.filter((k) => real1(k) && fin[k].a < run3Start).length;
D.fresh.firstRealNotReprobedAtAll = keys.filter((k) => real1(k) && fin[k].a === first[k].a).length;

// (6) 401 outage rows: candidates = rows with no probe-all result. Check directly, then use timestamp gaps as the outage trace.
D.outage = { noRun3Result: keys.filter((k) => fin[k].a < run3Start).length, ofWhichFirstSkip: keys.filter((k) => fin[k].a < run3Start && first[k].s === "skip").length,
  finalSkipRecords: keys.filter((k) => fin[k].s === "skip").length };
const times = run3.map((k) => fin[k].a).sort((a, b) => a - b);
const gaps = []; for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] >= 45) gaps.push({ from: iso(times[i - 1]).slice(11, 19), to: iso(times[i]).slice(11, 19), seconds: times[i] - times[i - 1] });
D.outage.gaps45s = gaps;
D.outage.gapCount = gaps.length;
D.outage.gapSeconds = gaps.reduce((a, g) => a + g.seconds, 0);
// records timestamped in the first 2 minutes after each gap, by provider, with their first status (the natural place for requeued rows to land)
const after = new Set();
for (const g of gaps) { const to = Date.parse("2026-09-29T" + g.to + "Z") / 1000; for (const k of run3) if (fin[k].a >= to && fin[k].a <= to + 120) after.add(k); }
D.outage.reprobedRightAfterGap = after.size;
D.outage.reprobedRightAfterGapByProvider = {}; D.outage.reprobedRightAfterGapFirst = {}; D.outage.reprobedRightAfterGapFinal = {};
for (const k of after) { inc(D.outage.reprobedRightAfterGapByProvider, provOf(k)); inc(D.outage.reprobedRightAfterGapFirst, first[k].s); inc(D.outage.reprobedRightAfterGapFinal, fin[k].s); }

// provider movement: first-sweep verdict vs final verdict (same rule as providerFlags, keys as rows)
const deadKind = (r) => ["auth", "error", "timeout", "gone"].includes(r.s) || (r.s === "skip" && r.w === "provider-dead");
const verdict = (recs) => { const c = {}; for (const r of recs) inc(c, r.s); const ans = (c.ok || 0) + (c.empty || 0);
  if (ans === 0 && recs.every(deadKind)) return "dead"; if (ans === 0 && recs.every((r) => r.s === "pay" || (r.s === "skip" && r.w === "unfunded"))) return "needs-money";
  if (ans === 0) return "no-answer (mixed/skip)"; return (c.ok || 0) / recs.length >= 0.5 ? "healthy" : (c.ok || 0) / recs.length >= 0.1 ? "partial" : "mostly-blocked"; };
const provs = [...new Set(keys.map(provOf))];
D.providers = provs.map((p) => { const ks = keys.filter((k) => provOf(k) === p); const f1 = ks.map((k) => first[k]), f3 = ks.map((k) => fin[k]);
  const c1 = {}, c3 = {}; for (const r of f1) inc(c1, r.s); for (const r of f3) inc(c3, r.s);
  return { provider: p, keys: ks.length, firstOk: c1.ok || 0, finalOk: c3.ok || 0, firstSkip: c1.skip || 0, firstVerdict: verdict(f1), finalVerdict: verdict(f3), firstAnswered: (c1.ok || 0) + (c1.empty || 0), finalAnswered: (c3.ok || 0) + (c3.empty || 0) }; });
D.movers = D.providers.filter((p) => p.firstAnswered === 0 && p.finalAnswered > 0);
D.moversSkipped = D.providers.filter((p) => p.firstSkip >= p.keys * 0.5 && p.finalAnswered > p.firstAnswered);
D.verdictTransitions = {}; for (const p of D.providers) inc(D.verdictTransitions, `${p.firstVerdict} -> ${p.finalVerdict}`);
D.okDelta = D.providers.filter((p) => p.finalOk !== p.firstOk).sort((a, b) => (b.finalOk - b.firstOk) - (a.finalOk - a.firstOk)).map((p) => ({ provider: p.provider, from: p.firstOk, to: p.finalOk }));

fs.writeFileSync(path.join(OUT, "sweeps.json"), redact(JSON.stringify(D, null, 1)));
if (process.argv[2] === "print") console.log(JSON.stringify(D, (k, v) => (k === "okDelta" || k === "providers" ? undefined : v), 1));
console.log("wrote sweeps.json");

// (3b) did the FIRST sweep already carry an explicit not-found sentence for those error->gone rows (classifier effect), or not (re-probe effect)?
{
  const EXPL = /not exist|not found|invalid model|unsupported model|not a valid|no endpoints|decommission|deprecated|retired|removed|no available|has been d|couldn'?t find|models\//i;
  const toGone = errKeys.filter((k) => fin[k].s === "gone");
  D.err.toGoneN = toGone.length;
  D.err.toGoneFirstHadNotFoundText = toGone.filter((k) => EXPL.test(first[k].p ?? "")).length;
  D.err.toGoneFirstWasFetchFailed = toGone.filter((k) => /fetch failed/i.test(first[k].p ?? "")).length;
  D.err.toGoneFirstOther = toGone.filter((k) => !EXPL.test(first[k].p ?? "") && !/fetch failed/i.test(first[k].p ?? "")).map((k) => `${k} | first p="${first[k].p}"`);
  D.err.firstFetchFailed = errKeys.filter((k) => /fetch failed/i.test(first[k].p ?? "")).length;
  D.err.firstFetchFailedToFinal = {}; for (const k of errKeys.filter((k) => /fetch failed/i.test(first[k].p ?? ""))) inc(D.err.firstFetchFailedToFinal, fin[k].s);
  // error rows in the first sweep whose text already said "not found" but stayed error in final (would be gone under the new rule)
  D.err.finalErrorTextLooksGone = errKeys.filter((k) => fin[k].s === "error" && EXPL.test(fin[k].m ?? "")).length;
  D.err.errorReprobedByRun3 = errKeys.filter((k) => fin[k].a >= run3Start).length;
  fs.writeFileSync(path.join(OUT, "sweeps.json"), redact(JSON.stringify(D, null, 1)));
}

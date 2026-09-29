// Sweep-comparison pieces of REPORT.md, generated from sweeps.json (built by sweeps.mjs).
import fs from "node:fs"; import path from "node:path";
import { OUT } from "./lib.mjs";
export const SW = JSON.parse(fs.readFileSync(path.join(OUT, "sweeps.json"), "utf8"));
const n = (x) => (x == null ? "" : Number(x).toLocaleString("en-US"));
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : "n/a");
const T = (head, body) => `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${body.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
const ST = ["ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate", "skip"];
const K = SW.meta.keysFinal;

export function topNote() {
  const d = SW.dist;
  return `> **Which sweep does this study cover?** \`state/bench.json\` is the *merged latest-record-per-key* view, not one sweep. Its ${n(K)} records come from three writes: **${n(SW.nt.unchanged)} records are sweep-1 records that were never re-probed** (sweep 1: ${SW.firstTimes.min} to ${SW.firstTimes.max}, old classifier, old dead/unfunded breakers, no provider message \`m\`); **${n(SW.outage.noRun3Result - SW.nt.unchanged)} records come from a partial second run** (${SW.run2Window.min} to ${SW.run2Window.max}; ${n(SW.run2.changed)} records touched, most of which the third run then overwrote); and **${n(SW.run3.changed)} records come from the probe-all run** (${SW.run3Start} to ${SW.meta.finalGeneratedAt}). So the "2,283 carried-over" records in sec 1 are 2,226 from sweep 1 plus 57 from the partial second run. Every number in this report is about that merged final view; the differences between sweep 1 and the final view are in **sec 7 (Sweep comparison)**. Unit there: bench key (${n(K)} keys; the route counts elsewhere are 1 higher because of one \`[1m]\` twin).\n`;
}

export function execLine() {
  const d = SW.dist; const mv = SW.movers;
  const gain = d.final.ok - d.first.ok;
  return `- **What the second sweep changed.** Of ${n(K)} bench keys, sweep 1 had ok ${n(d.first.ok)} (${pct(d.first.ok, K)}) and left ${n(d.first.skip)} (${pct(d.first.skip, K)}) unprobed (\`skip\`: ${n(SW.skipReasonFirst["unfunded"])} unfunded, ${n(SW.skipReasonFirst["provider-dead"])} provider-dead, ${n(SW.skipReasonFirst["spend-cap"])} spend-cap, ${SW.skipReasonFirst["row-cost"]} row-cost); the final view has ok ${n(d.final.ok)} (${pct(d.final.ok, K)}), +${n(gain)}, and 0 skips. ${n(SW.skip.ok)} of the ${n(SW.skip.n)} skipped rows turned out ok (${n(SW.skip.answeredOkEmpty)} answered incl. empty) but ${n(SW.skip.toFinal.pay)} came back \`pay\` and ${n(SW.skip.toFinal.gone)} \`gone\`, so unfunded/dead skipping was mostly right about the money and wrong about ${mv.length} providers that in fact answer: ${mv.map((p) => `${p.provider} ${p.firstOk}->${p.finalOk}`).join(", ")} (ok keys, sweep 1 -> final). No sweep-1 non-transient result (${n(SW.nt.n)} rows) was ever re-probed, so the ${n(SW.nt.unchanged)} legacy records are unconfirmed rather than confirmed.`;
}

export function section() {
  const o = [];
  const w = (s = "") => o.push(s);
  const d = SW.dist, M = SW.matrix, nt = SW.nt, sk = SW.skip, er = SW.err, fr = SW.fresh, og = SW.outage;
  w(`## 7. Sweep comparison`);
  w();
  w(`Files: \`bench.first-sweep.json\` (generatedAt ${SW.meta.firstGeneratedAt}, a copy of bench.json taken right after sweep 1), \`bench.before-probe-all.json\` (generatedAt ${SW.meta.midGeneratedAt}, taken before the probe-all run, i.e. after the partial second run) and \`bench.json\` (generatedAt ${SW.meta.finalGeneratedAt}, final). Unit: bench key; ${n(K)} keys in every file. Percentages are of ${n(K)} keys unless a denominator is named.`);
  w();
  w(`### 7.1 Status distribution by stage`);
  w();
  w(T(["Status", "Sweep 1", "After partial run 2", "Final (probe-all merged)", "Change sweep 1 -> final"], ST.map((s) => [s, n(d.first[s] || 0), n(d.mid[s] || 0), n(d.final[s] || 0), (d.final[s] || 0) - (d.first[s] || 0) >= 0 ? `+${n((d.final[s] || 0) - (d.first[s] || 0))}` : `-${n((d.first[s] || 0) - (d.final[s] || 0))}`]).concat([["total", n(K), n(K), n(K), ""]])));
  w(`Sweep 1 \`skip\` reasons (${n(d.first.skip)} rows): unfunded ${n(SW.skipReasonFirst.unfunded)}, provider-dead ${n(SW.skipReasonFirst["provider-dead"])}, spend-cap ${n(SW.skipReasonFirst["spend-cap"])}, row-cost ${SW.skipReasonFirst["row-cost"]}. The partial second run (${n(SW.run2.changed)} records touched) did not improve coverage before the probe-all run started: ${n(SW.run2.trans["error->skip"] + SW.run2.trans["timeout->skip"])} error/timeout rows became \`skip\` through the dead-provider breaker (skip ${n(d.first.skip)} -> ${n(d.mid.skip)}), and ${n(SW.run2.trans["skip->pay"] + SW.run2.trans["skip->ok"] + SW.run2.trans["skip->auth"] + SW.run2.trans["skip->gone"] + SW.run2.trans["skip->error"] + SW.run2.trans["skip->empty"])} skip rows got a real answer. The probe-all run (${n(SW.run3.changed)} keys re-recorded) removed every remaining skip.`);
  w();
  w(`### 7.2 Transition matrix: sweep-1 status (rows) -> final status (columns), keys`);
  w();
  w(T(["sweep 1 \\ final", ...ST, "row total"], ST.map((s) => [`**${s}**`, ...ST.map((t) => (M[s][t] ? n(M[s][t]) : "0")), n(ST.reduce((a, t) => a + M[s][t], 0))]).concat([["**col total**", ...ST.map((t) => n(ST.reduce((a, s) => a + M[s][t], 0))), n(K)]])));
  w(`Reading it: the top-left five rows (ok, empty, pay, auth, gone) are pure diagonal because those ${n(nt.n)} sweep-1 records were never re-probed (the 7-day ttl skipped them). The whole off-diagonal mass is in the last four rows: \`skip\` (${n(sk.n)} rows) and the retryable statuses error (${n(SW.trans.error.n)}), timeout (${n(SW.trans.timeout.n)}), rate (${n(SW.trans.rate.n)}). Of those ${n(SW.trans.error.n + SW.trans.timeout.n + SW.trans.rate.n)} retryable rows, ${n(SW.trans.error.toFinal.ok + SW.trans.timeout.toFinal.ok + SW.trans.rate.toFinal.ok)} became ok, ${n(SW.trans.timeout.toFinal.empty)} empty, ${n(SW.trans.error.toFinal.pay + SW.trans.timeout.toFinal.pay + SW.trans.rate.toFinal.pay)} pay, ${n(SW.trans.error.toFinal.gone)} gone, and ${n(SW.trans.error.toFinal.error + SW.trans.timeout.toFinal.error + SW.trans.rate.toFinal.error + SW.trans.error.toFinal.timeout + SW.trans.timeout.toFinal.timeout + SW.trans.error.toFinal.rate + SW.trans.rate.toFinal.rate)} stayed in error/timeout/rate.`);
  w();
  w(`### 7.3 Sweep-1 \`skip\` rows: what they became`);
  w();
  w(`${n(sk.n)} sweep-1 \`skip\` keys. All ${n(sk.realAnswer)} now hold a real result (${n(sk.stillSkip)} still skip). Final status of those keys: ${Object.entries(sk.toFinal).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${n(v)} (${pct(v, sk.n)})`).join(", ")}. **${n(sk.ok)} became ok (${pct(sk.ok, sk.n)} of the skipped rows); ${n(sk.answeredOkEmpty)} answered (ok or empty).**`);
  w();
  w(T(["Skip reason (sweep 1)", "rows", "ok", "empty", "pay", "auth", "gone", "error", "rate", "timeout"], Object.entries(sk.byReason).map(([r, c]) => [r, n(Object.values(c).reduce((a, b) => a + b, 0)), n(c.ok || 0), n(c.empty || 0), n(c.pay || 0), n(c.auth || 0), n(c.gone || 0), n(c.error || 0), n(c.rate || 0), n(c.timeout || 0)])));
  w(`Top 15 providers by number of skipped keys (final status of those keys):`);
  w();
  w(T(["provider", "skipped in sweep 1", "now ok", "ok or empty", "pay", "gone", "auth", "error", "rate", "timeout", "ok share of the skipped"], sk.top15.map((p) => [p.provider, n(p.skip), n(p.ok), n(p.answered), n(p.pay), n(p.gone), n(p.auth), n(p.error), n(p.rate), n(p.timeout), pct(p.ok, p.skip)])));
  w(`Where the skip breaker was wrong: openai (322 skipped, 46 ok + 16 empty; per the engine's own comments it looked dead because its cheapest row was text-moderation-007), mistral (198 skipped, 20 ok; per the engine's comments its first row was a Labs model needing an opt-in), nousresearch (163 skipped, 114 ok), aihubmix (108 skipped, 35 ok), xkiro (96 skipped, 26 ok). Where it was right: kilo, experientiallabs, orcarouter, tokenrouter, veniceai, deepseek, opencode, commandcode, zenmux (each <= 3.4% ok; pay is 59-94% of their skipped rows).`);
  w();
  w(`### 7.4 Sweep-1 \`error\` rows under the new classifier`);
  w();
  w(`${n(er.n)} sweep-1 \`error\` keys (${n(er.errorReprobedByRun3)} re-probed by the probe-all run) ended as: ${Object.entries(er.toFinal).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${n(v)} (${pct(v, er.n)})`).join(", ")}. So **${n(er.toFinal.gone)} became gone (${pct(er.toFinal.gone, er.n)})**, ${n(er.toFinal.error)} stayed error (${pct(er.toFinal.error, er.n)}), ${n(er.n - er.toFinal.gone - er.toFinal.error)} became something else (ok ${er.toFinal.ok}, pay ${er.toFinal.pay}, rate ${er.toFinal.rate}, timeout ${er.toFinal.timeout}).`);
  w();
  const firstExplicit = er.toGoneN - er.toGoneFirstOther.filter((x) => /Upstream request failed/.test(x)).length - er.toGoneFirstWasFetchFailed;
  w(`Of the ${n(er.toGoneN)} error->gone rows I compared the sweep-1 text (\`p\`, 40 characters) with the final message: **${n(firstExplicit)} already said "model not found / not supported / not valid / decommissioned" in sweep 1** but the old classifier filed them as \`error\` (that is the message-based gone rule at work: mostly huggingface "The requested model 'x' does not exist" ${er.byProviderGone.huggingface}, aihubmix ${er.byProviderGone.aihubmix}, openrouter, groq, kiosapi); **${n(er.toGoneN - firstExplicit)} changed for another reason**: ${er.toGoneFirstOther.filter((x) => /Upstream request failed/.test(x)).length} were an opaque "Upstream request failed." (cloudflare 3, nvidia 1) that returned 404 the second time, and ${er.toGoneFirstWasFetchFailed} was \`fetch failed\` in sweep 1 (openai/text-moderation-latest). ${n(er.firstFetchFailed)} sweep-1 errors were \`fetch failed\`; they ended ${Object.entries(er.firstFetchFailedToFinal).map(([s, v]) => `${s} ${v}`).join(", ")}: sweep 1 also had gateway/network noise. Conversely ${n(er.finalErrorTextLooksGone)} final \`error\` rows still carry wording a broad not-found pattern matches ("no available providers", "cannot be served"): they are the \`error:model-unavailable-or-not-served\` cluster of sec 3.4, deliberately left as error by the classifier. Only the provider-supplied sentence separates the two effects; the status codes are not persisted.`);
  w();
  w(`### 7.5 Non-transient result -> different non-transient result`);
  w();
  w(`**${n(nt.changedToNonTransient.length)} rows changed** (population: the ${n(nt.n)} sweep-1 keys with status ok/empty/pay/auth/gone). ${n(nt.changedToTransient.length)} changed to a transient status, and ${n(nt.sameStatusReprobed)} were re-probed with the same status. The reason is not stability: **${n(nt.reprobed)} of those ${n(nt.n)} keys were re-probed at all** (the ttl skipped all ${n(nt.unchanged)}), so this comparison cannot show whether a sweep-1 ok is still ok, or a sweep-1 pay is still pay. Evidence of flip-flopping would need a forced re-probe of a sample (recommended: 200 random sweep-1 ok and 200 gone rows).`);
  w();
  w(`### 7.6 Fresh result in sweep 1 only / probe-all only / both`);
  w();
  w(`"Real result" = a non-skip record. Sweep 1 gave ${n(fr.realFirst)} of ${n(K)} keys (${pct(fr.realFirst, K)}) a real result; the probe-all run gave ${n(fr.realSecond)} (${pct(fr.realSecond, K)}).`);
  w();
  w(T(["Population", "Keys", "% of " + n(K)], [
    ["real result in sweep 1 only (never re-probed by probe-all)", n(fr.sweep1Only + fr.midOnly), pct(fr.sweep1Only + fr.midOnly, K)],
    ["  of which untouched since sweep 1", n(fr.sweep1Only), pct(fr.sweep1Only, K)],
    ["  of which re-recorded by the partial second run only", n(fr.midOnly), pct(fr.midOnly, K)],
    ["real result in the probe-all run only (sweep 1 had \`skip\`)", n(fr.sweep2Only), pct(fr.sweep2Only, K)],
    ["real result in both (sweep-1 error/timeout/rate re-probed)", n(fr.both), pct(fr.both, K)],
    ["real result in neither sweep proper (sweep 1 skip, answered only by the partial second run)", n(fr.neither), pct(fr.neither, K)],
    ["**total**", n(K), "100%"],
  ]));
  w(`Both sweeps are in the final view, but they cover different populations: the ${n(fr.sweep1Only + fr.midOnly + fr.neither)} keys without a probe-all result (${n(fr.sweep1Only)} untouched + ${n(fr.midOnly)} + ${n(fr.neither)} from the partial second run) are exactly the ${n(og.noRun3Result)} carried-over records of sec 1; every one of them is a non-transient status (ok/empty/pay/auth/gone).`);
  w();
  w(`### 7.7 The 401 rows the gateway outages "put back unrecorded"`);
  w();
  w(`I could not find them as a residue: after the probe-all run **${n(og.noRun3Result)} keys have no probe-all result and every one of them has a real (non-skip) record** (${n(og.noRun3Result - nt.unchanged)} from the partial second run, of which ${n(og.ofWhichFirstSkip)} were sweep-1 skips; ${n(nt.unchanged)} untouched since sweep 1; 0 \`skip\` records remain in the final file). The run's own tally says 3,510 recorded and 3,510 keys differ from the pre-run backup, so the requeued rows were re-probed later in the same run. The trace of the outages is in the timestamps: the probe-all run's records have ${og.gapCount} silent gaps of >= 45 s, all between 14:16 and 14:27 (${og.gapSeconds} s in total): ${og.gaps45s.map((g) => `${g.from}-${g.to}Z (${g.seconds}s)`).join(", ")}. The ${n(og.reprobedRightAfterGap)} keys recorded within 2 minutes after those gaps are the best available proxy for the rows that were put back (the log says 12 outages, 401 rows; shorter outages leave no visible gap, so this proxy is a floor, not a count). All ${n(og.reprobedRightAfterGap)} were \`skip\` in sweep 1. Their providers: ${Object.entries(og.reprobedRightAfterGapByProvider).sort((a, b) => b[1] - a[1]).map(([p, v]) => `${p} ${v}`).join(", ")}. Their final status: ${Object.entries(og.reprobedRightAfterGapFinal).sort((a, b) => b[1] - a[1]).map(([s, v]) => `${s} ${v}`).join(", ")}, i.e. ${pct(og.reprobedRightAfterGapFinal.pay, og.reprobedRightAfterGap)} \`pay\`, the outcome those unfunded providers gave everywhere else, which is what a correctly re-probed set should look like. Not verifiable from the files: which exact 401 keys were held. If you need certainty, the gateway request log is the only place the held keys would appear; the engine does not persist them.`);
  w();
  w(`### 7.8 Providers that moved`);
  w();
  w(`Provider verdict (same rule as \`providerFlags\`, applied to keys): sweep 1 -> final, over ${SW.providers.length} providers: ${Object.entries(SW.verdictTransitions).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join("; ")}.`);
  w();
  w(`**Providers with nothing answering in sweep 1 that answer in the final view (${SW.movers.length}):**`);
  w();
  w(T(["provider", "keys", "sweep-1 skipped", "ok sweep 1", "ok final", "verdict sweep 1", "verdict final"], SW.movers.sort((a, b) => b.finalOk - a.finalOk).map((p) => [p.provider, n(p.keys), n(p.firstSkip), n(p.firstOk), n(p.finalOk), p.firstVerdict, p.finalVerdict])));
  w(`Largest ok gains (keys): ${SW.okDelta.slice(0, 12).map((x) => `${x.provider} ${x.from} -> ${x.to}`).join("; ")}. Total ok ${n(d.first.ok)} -> ${n(d.final.ok)} (+${n(d.final.ok - d.first.ok)}): ${n(sk.ok)} from sweep-1 skips and ${n(SW.trans.error.toFinal.ok + SW.trans.timeout.toFinal.ok + SW.trans.rate.toFinal.ok)} from re-probed error/timeout/rate rows.`);
  w();
  return o.join("\n");
}

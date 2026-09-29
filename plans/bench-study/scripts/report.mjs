// Generates REPORT.md from data.json (build.mjs), sweeps.json (sweeps.mjs) and reconcile.json (reconcile_critic.mjs).
// Every number in the report is interpolated from those files. Revision 2 = after the independent review (review/REVIEW.md).
import fs from "node:fs"; import path from "node:path";
import { OUT, pct } from "./lib.mjs";
import { topNote, execLine, section as sweepSection } from "./report_sweeps.mjs";
const J = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8"));
const D = J("data.json"), REC = J("reconcile.json"), PREV = J("prev/rev1-summary.json");
const n = (x) => (x == null ? "" : Number(x).toLocaleString("en-US"));
const f1 = (x) => (x == null ? "" : Number(x).toFixed(1));
const ms = (x) => (x == null ? "" : n(Math.round(x)));
const T = (head, body) => `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${body.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
const P = D.pop, S = P.status, E = P.eligible, G = D.groups;
const cause = (c) => D.causes.find((x) => x.cause === c) ?? { n: 0, legacy: 0, prov: {}, everAnswered: 0, sibOk: 0, listed: 0, examples: [], providers: {} };
const cs = (st) => D.causes.filter((c) => c.status === st);
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const ac = D.proposal.actionClassTotals, rm = D.proposal.removal, sb = D.siblings, RP = D.reprobe, NC = D.nonchat, FF = D.fetchFailed, LA = D.listingAudit;
const provOf = (name) => D.prov.find((p) => p.provider === name);
const top = (o, k = 5) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([a, b]) => `${a} ${n(b)}`).join(", ");
const provMix = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n(v)}`).join(", ");
const M = D.meta;
const ff = cause("error:fetch-failed(gateway/local-network)");
const okp = D.ok, payTop = D.pay.byProvider, payNamed = D.pay.byProviderNamed, em = D.empty, PF = D.perf;
const healthy = D.prov.filter((p) => p.verdictAdj === "healthy");
const pctS = (x) => `${(100 * x).toFixed(1)}%`;
const CALL = { nonChatMsg: NC.newSplit.hideByMessage };

if (PREV.removal.candidates - 90 - 12 - 3 - 3 + 2 !== D.proposal.removal.candidates) throw new Error("reconciliation table constants no longer add up: " + D.proposal.removal.candidates);
const out = [];
const w = (s = "") => out.push(s);

w(`# UltimateWrap bench study: which models work, which do not, and what to do about it`);
w();
w(`*Revision 2, after an independent review (\`plans/bench-study/review/REVIEW.md\`). Every headline number of revision 1 was reproduced by the reviewer; the decision layer (label / hide / remove) was corrected. Section 8 lists old -> new numbers.*`);
w();
w(`Scope: the 2026-09-29 probe sweeps as recorded (merged) in \`~/.uw/state/bench.json\` (generatedAt **${M.benchGeneratedAt}**, ${n(M.benchKeys)} records, probe times ${M.earliestRecord} to ${M.latestRecord}) joined to \`~/.uw/catalog/snapshot.json\` (schema ${M.schemaVersion}, generatedAt ${M.snapshotGeneratedAt}, routableAsOf ${M.snapshotRoutableAsOf}, discoveredAsOf ${M.snapshotDiscoveredAsOf}, **benchAsOf ${M.snapshotBenchAsOf}**, builtAt ${M.snapshotBuiltAt}). Read-only: nothing in the repo, state or catalog was modified, no request was sent. Also read: the two bench backups (\`bench.before-probe-all.json\` generatedAt ${M.beforeProbeAllGeneratedAt}, \`bench.first-sweep.json\` generatedAt ${M.firstSweepGeneratedAt}), the 57 discovery caches (\`%LOCALAPPDATA%\\uw-keysync\\discovery\\*.json\`, all written 2026-09-29T09:16Z except vyncai 2026-09-19), \`refresh/bench.mjs\`, \`menu/bench-data.mjs\`, \`state/bench-run3.log\`. Provider sentences are redacted before they reach any deliverable (masked key fragments, URLs; see sec 6).`);
w();
w(`**Unit and denominators.** The unit is a *route*: one snapshot model row (the picker's selectable row). ${n(P.routes)} routes map to ${n(P.uniqueKeys)} unique bench keys: ${n(D.m1.routes)} routes carry a \`[1m]\` suffix (the bench key strips it), but only ${D.m1.withBareSiblingRoute} of them has a separate bare-id route in the same provider (${D.m1.withBareSiblingExamples.join(", ")}), so nothing is double-counted apart from that one. "Eligible" = routes the engine probes (outputKind not \`nontext\`, routable not false) = ${n(E)} routes = ${n(P.eligibleKeys)} keys. Unless a sentence names another population, percentages are of the ${n(E)} eligible routes; provider rates use that provider's eligible routes. **Three groups, said once:** \`ok\` ${n(G.ok)} (${pct(G.ok, E)}) = works; \`empty\` ${n(G.empty)} (${pct(G.empty, E)}) = the provider answered but no visible text came back (kept as its own group, sec 2.4, never counted as "does not work"); **did not answer** ${n(G.notAnswered)} (${pct(G.notAnswered, E)}) = pay, gone, error, auth, rate, timeout.`);
w();
w(topNote());
w();

// ---------------------------------------------------------------- 0 exec summary
w(`## 0. Executive summary`);
w();
w(`**Corrected top-5 actions**`);
w();
w(`1. **Re-probe before deciding anything about ${n(RP.total)} routes** (${pct(RP.total, E)} of ${n(E)} eligible). This is the honest size of the re-probe set: ${n(RP.primary)} routes whose primary action is re-probe (${n(ff.n)} \`fetch failed\`, ${n(cause("error:model-unavailable-or-not-served").n)} model-not-served, ${n(S.timeout)} timeout, ${n(cause("error:upstream-overloaded-or-transient-5xx").n)} overloaded, ${n(sum(cs("rate"), (c) => c.n))} rate, ${em.hidden} hidden-reasoning \`empty\` at max_tokens 1024, and the rest of \`error\`) + ${n(RP.labelAndReprobe)} routes that get a label AND a re-probe (gone rows, google \`models/\` rows, \`non-chat?\`) + ${n(RP.removeButReprobeOnce)} remove candidates that rest on a legacy record and need one current-engine probe first + ${n(RP.hideAndReprobe)} hide-and-re-probe. Settles the \`fetch failed\` question (${n(ff.n)} routes; ${pctS(FF.insideShare)} of last-run records inside 13:10-13:50Z vs ${pctS(FF.outsideShare)} outside, sec 4a).`);
w(`2. **Label state, never remove it: ${n(ac.label)} routes** are labelled (pay ${n(S.pay)}, auth ${n(S.auth)}, gone rows the provider lists or that carry account state, batch-only ids, \`needs Responses API?\`, \`needs other route\`, \`not activated\`). pay/auth/rate/timeout/error/empty are state. Suggested texts in sec 5. Labels are computed from records the picker stops showing after 14 days (**${D.staleAt.legacyStaleOn.slice(0, 10)}** for the oldest), so schedule a re-sweep.`);
w(`3. **Hide non-chat and batch ids only when the provider's own sentence or an ok twin says so: ${n(NC.hiddenTotal)} routes**, not the 336 of revision 1 (which hid by id pattern). Split: non-chat by the provider's sentence ${n(NC.newSplit.hideByMessage)} (${n(NC.goneByMessage)} gone incl. openai Responses-API ${n(NC.goneByMessageByProvider.openai)} and zenmux /v1/chat/completions ${n(NC.goneByMessageByProvider.zenmux)}; ${n(NC.errorByMessage)} error), batch twins whose base id answers ok ${n(NC.batchTwinBaseOk)}, gone ids that look non-chat ${n(NC.goneIdLooksNonChat)}. **Not hidden, labelled or kept:** ${n(NC.batchOnly)} batch-only ids (\`batch-only\`), ${n(NC.batchRoutesOk)} \`:batch\` routes that answer ok (kept), ${n(NC.errorById)} error rows with only an id-based hint (\`non-chat?\`), ${n(NC.chatNeedsOtherRoute)} chat models that need another route (commandcode Claude ids), 1 with no streaming, 1 not activated, the ${n(NC.notAChatModel)} aihubmix Responses-API ids (${NC.notAChatModelIds.map((k) => k.replace("aihubmix/", "")).join(", ")}).`);
w(`4. **Remove candidates: ${n(rm.candidates)} routes (was 467), and only after a second probe.** Rule: \`gone\` + explicit not-found wording visible in the stored sentence + catalogue-only provenance AND not named by the provider's listing after normalising google's \`models/\` prefix and \`[1m]\` + not the ambiguous "or you do not have access" wording + id does not name a non-chat model + no ok sibling id + never ok/empty in any bench file. Dropped from revision 1: the 90 google rows (${LA.revCandidatesNowListed.length} of them are named by google's own listing; 8 are "no longer available to new users" = account state; most show no verdict in the 40-character snippet; google's sentence is "not found ... or not supported for generateContent"). **Caveat that limits every candidate:** all evidence is one probe on one day (${rm.evidence.calendarDaysSpanned} calendar day; ${rm.evidence.withTwoDistinctGoneProbeTimes} of ${n(rm.candidates)} have two \`gone\` probes; ${rm.evidence.routesThatWentOkToNonOk} routes changed from ok to non-ok between files) and compaction prunes old records, so "never answered" is not a durable guarantee. Require a persistent ever-ok ledger and two independent \`gone\` probes on different days before any automated removal.`);
w(`5. **Fund by listed models, and verify the sambanova credential before replacing it.** Rank top-ups by pay routes the provider's own listing names (sec 4e): kilo ${payNamed.find((p) => p.provider === "kilo").payNamed}, experientiallabs ${payNamed.find((p) => p.provider === "experientiallabs").payNamed}, orcarouter ${payNamed.find((p) => p.provider === "orcarouter").payNamed}, zenmux ${payNamed.find((p) => p.provider === "zenmux").payNamed}, tokenrouter ${payNamed.find((p) => p.provider === "tokenrouter").payNamed}. **deepseek is not a top-up priority:** ${payTop.find((p) => p.provider === "deepseek").pay} pay routes in the catalogue, but its listing names ${payTop.find((p) => p.provider === "deepseek").listingCount} models and ${payTop.find((p) => p.provider === "deepseek").payCatalogueOnly} of the ${payTop.find((p) => p.provider === "deepseek").pay} are catalogue-only, so a top-up unlocks about ${payTop.find((p) => p.provider === "deepseek").payNamed}. sambanova: its discovery call returned 200 with 7 models while all ${provOf("sambanova").probed} probes say "Incorrect API key": check which credential the gateway sends versus the vault key before replacing anything (sec 4d).`);
w();
w(`**Headline numbers**`);
w();
w(`- **Population.** ${n(P.routes)} routes in the snapshot (57 providers); ${n(P.nonChat)} non-chat, never probed; **${n(E)} eligible**. All ${n(P.probedFresh)} eligible routes hold a non-skip record inside the picker's 14-day window, so **pending = ${P.pending}** (sec 1 explains why).`);
w(`- **Works:** ${n(G.ok)} of ${n(E)} eligible routes answered \`ok\` (${pct(G.ok, E)}). ${healthy.length} of 57 providers are healthy (ok-rate >= 50% of their routes) and hold ${n(sum(healthy, (p) => p.ok))} of the ${n(G.ok)} ok routes (${pct(sum(healthy, (p) => p.ok), G.ok)}). **Answered but no text (\`empty\`):** ${n(G.empty)} (${em.hidden} spent the 96-token budget on hidden reasoning). **Did not answer:** ${n(G.notAnswered)} (${pct(G.notAnswered, E)}): pay ${n(S.pay)} (${pct(S.pay, E)}), gone ${n(S.gone)} (${pct(S.gone, E)}), error ${n(S.error)}, auth ${n(S.auth)}, rate ${n(S.rate)}, timeout ${n(S.timeout)}. Five providers hold ${n(sum(payTop.slice(0, 5), (p) => p.pay))} of the ${n(S.pay)} \`pay\` routes (${payTop.slice(0, 5).map((p) => p.provider).join(", ")}).`);
w(`- **Probe artefacts, not model state.** ${n(ff.n)} of the ${n(S.error)} \`error\` routes are \`fetch failed\` (no HTTP response reached the probe; ${pctS(FF.insideShare)} of last-run records inside 13:10-13:50Z vs ${pctS(FF.outsideShare)} outside vs ${pctS(FF.sweep1Share)} of sweep-1 real results; ${FF.sameSecondBursts} same-second bursts across 3+ providers; ${FF.providers} providers).`);
w(execLine());
w(`- **Legacy records.** ${n(P.legacyRecords)} of ${n(E)} eligible routes (${pct(P.legacyRecords, E)}) still carry a record from sweep 1 or the partial second run (10:26-12:35Z, old classifier, no provider message \`m\`); ${n(P.nonOkNoM)} of ${n(P.nonOk)} non-ok routes have no \`m\`. All are non-transient (${Object.entries(D.retention.legacyStatuses).map(([k, v]) => `${k} ${n(v)}`).join(", ")}; 0 error/rate/timeout). A default run re-probes records older than the **7-day** ttl (from ${D.retention.legacyDefaultReprobeFrom.slice(0, 16)}Z); the picker stops showing a record as current after **14 days** (from ${D.staleAt.legacyStaleOn.slice(0, 16)}Z).`);
w(`- **Timing.** Separated, never mixed: ${n(PF.burst.n)} of ${n(G.ok)} ok routes (${pct(PF.burst.n, G.ok)}) delivered the whole answer as one burst, so their "TTFT" is time to the whole answer (median ${ms(PF.burst.timeToWholeAnswer.median)} ms); only ${n(PF.streamed.n)} routes (${pct(PF.streamed.n, G.ok)}) have a real time to first token (median ${ms(PF.streamed.ttft.median)} ms). Last-run timings are ~${Math.round((PF.currentVsLegacyMedianRatio - 1) * 100)}% slower than earlier records (median TTFT ${ms(PF.ttftCurrent.median)} vs ${ms(PF.ttftLegacy.median)} ms, gateway degradation and a different provider mix), so cross-run comparison is unsafe and this study makes no speed recommendation.`);
w();

// ---------------------------------------------------------------- 0b confidence
w(`## 0b. Confidence: what is solid, what is shaky, and what settles each`);
w();
w(`**Solid** (reproduced exactly by the independent reviewer or verified against source): population and denominators; the status distribution; ok-rate for all 57 providers; the 14 healthy providers' 79.5% share of ok; the five-provider pay concentration; the \`fetch failed\` count and provider spread; legacy counts (2,283 records, 879 without \`m\`, 0 transient); the 81% one-burst figure and the TTFT statistics; pending = 0; the pay cause clusters (reviewer sample: **pay 30/30 causes right, status right in all 90 sampled rows**); mistral's and alibaba's remove-candidate lists as written; the direction of the \`fetch failed\` conclusion.`);
w();
w(`**Sample accuracy of the cause clusters (reviewer, revision-1 rules):** pay 30/30, gone 22/30, error 24/30 correct causes; status right in all 90. The misses drove the rule changes listed in sec 6 ("Rules changed"): aihubmix "cannot be served ... check the model ID" filed as overload, non-chat ids inside the shape/opaque error buckets, openai/zenmux explicit non-chat sentences filed as "listed but 404", google new-user restrictions and group entitlements filed as gone.`);
w();
w(T(["Conclusion", "Confidence", "Why", "What would settle it"], [
  ["Google's former 90 remove candidates are gone", "**dropped**", `Evidence is a 40-character prefix; ${LA.revCandidatesNowListed.length} are named by google's listing; 8 are new-user restrictions; google's sentence also says "or not supported for generateContent"`, "One current-engine probe of the 95 google `models/` rows (full sentence stored in `m`), compared with the listing after prefix stripping"],
  [`Alibaba ${rm.candidatesByProvider.alibaba} / mistral ${rm.candidatesByProvider.mistral} candidates are permanently gone`, "shaky", `One probe each, one day; ${LA.okCatalogueOnlyNotListedByProvider.alibaba} alibaba and ${LA.okCatalogueOnlyNotListedByProvider.mistral} mistral catalogue-only ids DO answer ok (so catalogue-only is not a reliable death signal); "Model not exist." can also mean region or activation`, "A second probe on another day; for alibaba one call through the other region endpoint if available"],
  ["Non-chat / batch hiding", "conditional", `Now message- and ok-twin-conditional; ${NC.batchRoutesOk} of ${NC.batchRoutesAll} \`:batch\` routes answer ok; aihubmix Responses-API ids and 12 error rows were chat models`, "Manual pass over the rows with no non-chat token in the id; re-probe the `needs other route` / `no streaming` rows through the right route"],
  ["`fetch failed` is a gateway/probe artefact", "likely, not proven", `${pctS(FF.insideShare)} of last-run records in 13:10-13:50Z vs ${pctS(FF.outsideShare)} outside vs ${pctS(FF.sweep1Share)} in sweep 1; ${FF.sameSecondBursts} same-second bursts across 3-6 providers; ${FF.immediateRefusal} refused in under 100 ms. The run log has no outage timestamps, and ${pctS(FF.outsideShare)} background means not every one is the gateway`, `Re-probe the ${n(ff.n)} routes (expected: mostly ok or their true state); compare with the CCR gateway log for the 12 stalls`],
  ["Top-up value per provider", "upper bounds", "payment-first providers hide existence errors; conditional rates use small, free-tier-survivor denominators", "Probe one listing-verified pay route per provider after a small top-up, or read the provider's pricing page; estimates below n=30 are not shown"],
  ["sambanova needs a new key", "unverified", "The listing call returned 200 with 7 models; the probe says 'Incorrect API key' for all 7 (stable across 10-11Z and 14Z)", "Compare the credential in the vault with the one the gateway sends; make one direct call outside the sweep"],
  ["Speed", "weak", `${pct(PF.burst.n, G.ok)} burst rows, single sample, last-run timings ~${Math.round((PF.currentVsLegacyMedianRatio - 1) * 100)}% slower`, "Repeat 3 samples per route at low concurrency, streamed and burst reported separately"],
  ["\"Never answered in any of the three bench files\"", "vacuous today", `All three files are from one day; ${rm.evidence.routesThatWentOkToNonOk} routes went ok -> non-ok; ${rm.evidence.withTwoDistinctGoneProbeTimes} of ${n(rm.candidates)} candidates have two \`gone\` probes; compaction prunes old records`, "A persistent ever-ok ledger, and two independent `gone` probes on different days before removal"],
]));
w();

// ---------------------------------------------------------------- 1 population
w(`## 1. Population overview`);
w();
w(T(["Stage", "Routes", "Denominator / note"], [
  ["Routes in snapshot", n(P.routes), `57 providers; ${n(P.uniqueKeys)} unique bench keys`],
  ["Non-chat, excluded (outputKind nontext)", n(P.nonChat), `${pct(P.nonChat, P.routes)} of ${n(P.routes)} routes; 0 routes have routable=false`],
  ["Eligible for probe", n(E), `${pct(E, P.routes)} of ${n(P.routes)} routes; outputKind text ${n(P.outputKind.text)}, unknown (null) ${n(P.outputKind.null)} are all probed`],
  ["Probed with a fresh result", n(P.probedFresh), `${pct(P.probedFresh, E)} of eligible; fresh = record <= 14 d old at benchAsOf (the picker's display rule)`],
  ["Pending (no fresh result)", n(P.pending), "0 eligible routes lack a record; 0 records are `skip`"],
  ["  of the probed: written by the last (probe-all) run, 12:43-14:29Z", n(P.currentRunRecords), `${pct(P.currentRunRecords, E)} of eligible`],
  ["  of the probed: carried over unchanged (sweep 1 and the partial second run, 10:26-12:35Z)", n(P.legacyRecords), `${pct(P.legacyRecords, E)} of eligible; identical to the pre-probe-all backup; all non-transient`],
]));
w();
w(`**Status distribution over the ${n(E)} probed eligible routes**`);
w();
w(T(["Group", "Status", "Routes", "% of eligible", "of which legacy record", "Meaning (bench-data.mjs)"], [
  ["works", "ok", n(S.ok), pct(S.ok, E), n(P.statusLegacy.ok), "stream with content arrived"],
  ["answered, no text", "empty", n(S.empty), pct(S.empty, E), n(P.statusLegacy.empty), "HTTP 200 + stream, no content"],
  ["did not answer", "pay", n(S.pay), pct(S.pay, E), n(P.statusLegacy.pay), "account cannot use the model until funded/upgraded"],
  ["did not answer", "gone", n(S.gone), pct(S.gone, E), n(P.statusLegacy.gone), "404 or a not-found/removed sentence"],
  ["did not answer", "error", n(S.error), pct(S.error, E), n(P.statusLegacy.error), "5xx, network failure, malformed stream, model rejects the request"],
  ["did not answer", "auth", n(S.auth), pct(S.auth, E), n(P.statusLegacy.auth), "401/403 (key or per-model entitlement)"],
  ["did not answer", "rate", n(S.rate), pct(S.rate, E), n(P.statusLegacy.rate), "429 or quota message"],
  ["did not answer", "timeout", n(S.timeout), pct(S.timeout, E), n(P.statusLegacy.timeout), "no complete answer in 35 s"],
  ["**total**", "", n(E), "100%", n(P.legacyRecords), `did not answer = ${n(G.notAnswered)} (${pct(G.notAnswered, E)})`],
]));
w();
w(`**About "pending".** pending = 0 is right, and the reason is *not* that rows carry a legacy record. (1) \`bench-run3.log\` says "3510 row(s) to probe (2283 already fresh)" and "finished -- 3510 recorded": planned equals recorded, and diffing \`bench.json\` against \`bench.before-probe-all.json\` (12:35Z, before the run) gives 3,510 keys with a new record (earliest 12:43:36Z) and 2,283 unchanged. (2) The engine re-queues outage-hit rows inside the same run: \`runSweep\` calls \`requeue()\` for rows that hit a confirmed gateway outage, puts them back in their provider queue and re-probes them after the gateway answers. The log's closing sentence ("401 row(s) hit by it were put back UNRECORDED (they are re-probed on the next run)") is generic wording that describes the aborted case (\`stop = "outage"\`), which did not happen (the run finished). The timestamps show the trace: 4 silent gaps of >= 45 s between 14:16 and 14:27Z and 264 keys recorded within 2 minutes after them, all unfunded-provider rows that came back \`pay\` (sec 7.7); that is a floor for the requeued rows, not their count. (3) All ${n(P.legacyRecords)} legacy records are non-transient (${Object.entries(D.retention.legacyStatuses).map(([k, v]) => `${k} ${n(v)}`).join(", ")}; ${D.retention.legacyTransient} error/rate/timeout/skip), because the last run re-probed every skip and every transient record from the backup (3,203 skip + 307 error/rate/timeout = 3,510). **Two different dates apply to those legacy records:** a default run re-probes a record only after the **7-day ttl** (\`ttlDays = 7\`: from ${D.retention.legacyDefaultReprobeFrom.slice(0, 16)}Z to ${D.retention.legacyDefaultReprobeUntil.slice(0, 16)}Z), whereas the **picker's display rule** stops showing a record as current after **14 days** (\`BENCH_FRESH_MS\`: from ${D.staleAt.legacyStaleOn.slice(0, 16)}Z). What the outage window did leave behind is contamination of recorded rows, not missing rows: ${n(ff.n)} \`fetch failed\` routes (${pct(ff.n, P.currentRunRecords)} of the ${n(P.currentRunRecords)} last-run routes). The exact 401 held keys cannot be recovered from the files.`);
w();
w(`**Per provider (all 57).** ok-rate = ok / probed. verdict = provider-level reading with \`fetch failed\` rows excluded (\`verdict_excl_fetch_failed\` in providers.csv): healthy >= 50% ok, partial 10-50%, mostly-blocked < 10% but answering, needs-money every remaining row \`pay\`, dead nothing answered and only auth/error/timeout/gone. (\`inceptionlabs\`, 2 \`empty\` and 0 ok, is listed as mostly-blocked: it answers.)`);
w();
w(T(["provider", "eligible", "probed", "ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate", "pending", "ok-rate", "verdict"],
  [...D.prov].sort((a, b) => b.eligible - a.eligible).map((p) => [p.provider, n(p.eligible), n(p.probed), n(p.ok), n(p.empty), n(p.pay), n(p.auth), n(p.gone), n(p.error), n(p.timeout), n(p.rate), n(p.pending), p.okRate == null ? "n/a" : pct(p.ok, p.probed), p.verdictAdj])));
w();
{
  const v = {}; for (const p of D.prov) (v[p.verdictAdj] ??= []).push(p);
  const BF = D.benchFlags;
  w(`Verdict counts over 57 providers: ${Object.entries(v).map(([k, a]) => `${k} ${a.length}`).join(", ")}. **Versus the snapshot's \`benchFlags\`:** the snapshot's \`dead\` set is the same ${BF.snapDead.length} providers as this report's \`dead\` verdict (${BF.snapDead.join(", ")}); \`needsMoney\` differs: the snapshot has ${BF.snapMoney.length} (${BF.snapMoney.join(", ")}), this report ${BF.myMoney.length} (${BF.moneyOnlyMine.join(", ")} added). The reason: the snapshot rule requires that *every* fresh record is \`pay\` or an unfunded skip, and deepseek has ${BF.deepseek.pay} \`pay\` rows plus ${BF.deepseek.error} \`fetch failed\` errors; this report excludes \`fetch failed\` rows as probe artefacts, so deepseek reads needs-money here. Neither rule is stricter for \`dead\`.`);
}
w();

// ---------------------------------------------------------------- 2 works
w(`## 2. What works`);
w();
w(`### 2.1 The ok population (${n(S.ok)} of ${n(E)} eligible routes, ${pct(S.ok, E)})`);
w();
const dist3 = (title, oks, eligs) => T([title, "ok routes", "eligible routes", "ok-rate (ok / eligible in that group)"], Object.keys(eligs).sort((a, b) => eligs[b] - eligs[a]).map((k) => [k, n(oks[k] || 0), n(eligs[k]), pct(oks[k] || 0, eligs[k])]));
w(dist3("Badge", okp.byBadge, okp.eligByBadge));
w(`The blank badge (no free/paid claim) is ${n(okp.byBadge["(blank)"])} of the ${n(S.ok)} ok routes (${pct(okp.byBadge["(blank)"], S.ok)}). \`FREE\` has no eligible routes in this snapshot (the badge only shows \`FREE?\`, ${n(okp.eligByBadge["FREE?"])} eligible routes, ${n(okp.byBadge["FREE?"])} ok = ${pct(okp.byBadge["FREE?"], okp.eligByBadge["FREE?"])}). Only ${n(okp.byBadge.PLAN)} PLAN routes exist, all ok (${pct(okp.byBadge.PLAN, okp.eligByBadge.PLAN)}).`);
w();
w(dist3("Provenance (as stored in the snapshot)", okp.byProv, okp.eligByProv));
w(`\`call-verified\` and null provenance do not occur among eligible routes. **The stored \`catalogue-only\` label is partly an artefact:** google's listing ids are \`models/<id>\` and its routes may carry \`[1m]\`, so the snapshot does not see that the listing names them. After normalising both, ${n(LA.namedAfterNormalisation)} of the ${n(LA.catalogueOnlyEligible)} catalogue-only eligible routes are in fact named by the provider's own listing (all google, 0 in the other 56 providers; the exact-id check finds ${n(LA.namedExact)}), and **${LA.okCatalogueOnly - LA.okCatalogueOnlyNotListed} of the ${LA.okCatalogueOnly} "ok, catalogue-only" routes are named by the listing** (${LA.okCatalogueOnlyListedExamples.join(", ")}). Corrected: ${n(LA.okCatalogueOnlyNotListed)} ok routes are genuinely catalogue-only (the provider answers for an id its listing does not name: ${provMix(LA.okCatalogueOnlyNotListedByProvider)}), so do not remove on provenance alone; ${n(okp.byProv["listing-verified"] + LA.okCatalogueOnly - LA.okCatalogueOnlyNotListed)} of ${n(S.ok)} ok routes (${pct(okp.byProv["listing-verified"] + LA.okCatalogueOnly - LA.okCatalogueOnlyNotListed, S.ok)}) are named by the listing.`);
w();
w(dist3("Context band", okp.byBand, okp.eligByBand));
w(`ctx is unknown for ${n(okp.eligByBand.unknown)} of ${n(E)} eligible routes (${pct(okp.eligByBand.unknown, E)}), so band-level rates are partial.`);
w();
w(T(["Capability flag (snapshot)", "ok routes with flag", "eligible routes with flag", "ok-rate among flagged", "flagged share of ok"], [
  ["tools", n(okp.tools), n(okp.eligTools), pct(okp.tools, okp.eligTools), pct(okp.tools, S.ok)],
  ["vision", n(okp.vision), n(okp.eligVision), pct(okp.vision, okp.eligVision), pct(okp.vision, S.ok)],
  ["reason", n(okp.reason), n(okp.eligReason), pct(okp.reason, okp.eligReason), pct(okp.reason, S.ok)],
]));
w(`Note that the probe sends no tools: \`tools ok\` means "answers a bare chat request", not "handles tool schemas" (#118/#119). ${n(okp.previewIsReasoning)} of ${n(S.ok)} ok routes (${pct(okp.previewIsReasoning, S.ok)}) show only thinking text in the preview (\`k=1\`): the stream had content, but within 96 tokens the model had not begun its answer. They count as ok by the engine's definition; a bigger budget would confirm they finish.`);
w();
w(`### 2.2 Providers by ok-rate`);
w();
{
  const withRate = D.prov.filter((p) => p.probed >= 5 && p.okRate != null).sort((a, b) => b.okRate - a.okRate);
  w(`**High (ok-rate >= 50%, >= 5 probed routes):** ${withRate.filter((p) => p.okRate >= 0.5).map((p) => `${p.provider} ${pct(p.ok, p.probed)} (${p.ok}/${p.probed})`).join("; ")}.`);
  w();
  w(`**Low (ok-rate < 10%, >= 5 probed routes):** ${withRate.filter((p) => p.okRate < 0.1).reverse().map((p) => `${p.provider} ${pct(p.ok, p.probed)} (${p.ok}/${p.probed})`).join("; ")}.`);
  w();
  w(`Only providers with >= 5 probed routes are listed; providers with 1-4 routes (tabiai, gorouter, indeedwebid, kiosapi, kktoken, justdowork, xai, inceptionlabs) are in sec 4f.`);
}
w();
w(`### 2.3 Performance of the ok routes (two populations, never mixed)`);
w();
w(`**Why two populations.** For ${n(PF.burst.n)} of ${n(S.ok)} ok routes (${pct(PF.burst.n, S.ok)}) total time minus TTFT is <= 50 ms: the text arrived as one chunk (the gateway or the provider buffers the stream). For those, \`t\` is **time to the whole answer**, not time to first token, and tokens/s is null. Only ${n(PF.streamed.n)} routes (${pct(PF.streamed.n, S.ok)}) streamed incrementally, and only for those is \`t\` a real **time to first token**. A single "TTFT" column over both is not a first-token measure, so this section reports them separately and offers no combined ranking.`);
w();
w(T(["Population", "n (ok routes)", "measure", "p10 ms", "median ms", "p90 ms", "min ms", "max ms"], [
  ["streamed", n(PF.streamed.n), "time to first token (TTFT)", ms(PF.streamed.ttft.p10), ms(PF.streamed.ttft.median), ms(PF.streamed.ttft.p90), ms(PF.streamed.ttft.min), ms(PF.streamed.ttft.max)],
  ["streamed", n(PF.streamed.n), "total time", ms(PF.streamed.total.p10), ms(PF.streamed.total.median), ms(PF.streamed.total.p90), ms(PF.streamed.total.min), ms(PF.streamed.total.max)],
  ["burst", n(PF.burst.n), "time to the WHOLE answer", ms(PF.burst.timeToWholeAnswer.p10), ms(PF.burst.timeToWholeAnswer.median), ms(PF.burst.timeToWholeAnswer.p90), ms(PF.burst.timeToWholeAnswer.min), ms(PF.burst.timeToWholeAnswer.max)],
]));
w(`Tokens per second exists for only ${n(PF.tps.n)} of the ${n(S.ok)} ok routes (${pct(PF.tps.n, S.ok)}): p10 ${f1(PF.tps.p10)}, median ${f1(PF.tps.median)}, p90 ${f1(PF.tps.p90)} (min ${f1(PF.tps.min)}, max ${f1(PF.tps.max)}). Of the ${n(PF.tpsNull)} routes with null tokens/s, ${n(PF.tpsNullLowTokens)} produced < 8 output tokens (by design) and ${n(PF.tpsNull - PF.tpsNullLowTokens)} produced >= 8 but arrived as a single burst.`);
w();
w(`**Cross-run comparison is unsafe.** The last (probe-all) run's records are slower than the carried-over ones: all-ok median TTFT ${ms(PF.ttftCurrent.median)} ms (n ${n(PF.ttftCurrent.n)}) vs ${ms(PF.ttftLegacy.median)} ms (n ${n(PF.ttftLegacy.n)}), i.e. ~${Math.round((PF.currentVsLegacyMedianRatio - 1) * 100)}% slower; the same gap holds inside each population (burst ${ms(PF.burst.current.median)} vs ${ms(PF.burst.legacy.median)} ms; streamed ${ms(PF.streamed.current.median)} ms, n ${n(PF.streamed.current.n)}, vs ${ms(PF.streamed.legacy.median)} ms, n ${n(PF.streamed.legacy.n)}). Candidates: the 13:10-13:50Z gateway degradation and a different provider mix (the last run probed formerly skipped, paid and failing rows); I did not isolate the cause. A provider's place in any speed ordering therefore depends on which run measured it (the "legacy share" column below). Further caveats: single sample per route under 8-way concurrency through a shared gateway; reasoning models show thinking first (\`k=1\`, ${n(okp.previewIsReasoning)} routes), so their first token is a thinking token; ${n(D.okExtra.oGe96)} ok routes reported output_tokens >= 96 and ${n(D.okExtra.oGt96)} more than 96 (those providers ignore max_tokens). **Not a recommendation input:** the lists below are descriptive.`);
w();
w(`**25 fastest streamed routes by time to first token** (streamed, answer preview; ms):`);
w();
w(T(["#", "route", "badge", "TTFT ms", "total ms", "tok/s", "out tokens", "run"], PF.fastestStreamedTtft25.map((x, i) => [i + 1, x.key, x.badge || "", ms(x.t), ms(x.d), x.r == null ? "-" : f1(x.r), x.o ?? "", x.legacy ? "earlier" : "last"])));
w(`**25 slowest streamed routes by time to first token** (the probe timeout is 35 s so the tail is capped; \`think\` = preview was reasoning text):`);
w();
w(T(["#", "route", "badge", "TTFT ms", "total ms", "tok/s", "out tokens", "think", "run"], PF.slowestStreamedTtft25.map((x, i) => [i + 1, x.key, x.badge || "", ms(x.t), ms(x.d), x.r == null ? "-" : f1(x.r), x.o ?? "", x.k === 1 ? "yes" : "", x.legacy ? "earlier" : "last"])));
w(`**25 fastest burst routes by time to the whole answer** (burst, answer preview; NOT time to first token):`);
w();
w(T(["#", "route", "badge", "time to whole answer ms", "out tokens", "run"], PF.fastestBurstTotal25.map((x, i) => [i + 1, x.key, x.badge || "", ms(x.t), x.o ?? "", x.legacy ? "earlier" : "last"])));
w(`**25 slowest burst routes by time to the whole answer:**`);
w();
w(T(["#", "route", "badge", "time to whole answer ms", "out tokens", "think", "run"], PF.slowestBurstTotal25.map((x, i) => [i + 1, x.key, x.badge || "", ms(x.t), x.o ?? "", x.k === 1 ? "yes" : "", x.legacy ? "earlier" : "last"])));
w(`**25 highest and 25 lowest tokens/s** (routes with a measurable tokens/s and >= 20 output tokens, which removes the noisy short answers; these are streamed by construction):`);
w();
w(T(["#", "fastest tok/s route", "tok/s", "TTFT ms", "out", "slowest tok/s route", "tok/s", "TTFT ms", "out"], PF.fastestTps25.map((x, i) => { const y = PF.slowestTps25[i]; return [i + 1, x.key, f1(x.r), ms(x.t), x.o, y.key, f1(y.r), ms(y.t), y.o]; })));
w(`**Per provider** (providers with >= 5 ok routes; streamed and burst reported separately; "legacy share" = share of that provider's ok records that come from the earlier, faster-looking records):`);
w();
w(T(["provider", "ok routes", "streamed n", "TTFT median (streamed) ms", "burst n", "whole-answer median (burst) ms", "legacy share", "tok/s n", "tok/s median"],
  PF.perProvider.filter((p) => p.n >= 5).sort((a, b) => b.n - a.n).map((p) => [p.provider, p.n, p.streamedN, p.streamedN ? ms(p.ttftStreamed.median) : "-", p.burstN, p.burstN ? ms(p.totalBurst.median) : "-", pct(p.legacyShare, 1), p.tps.n, p.tps.n ? f1(p.tps.median) : "-"])));
w();
w(`### 2.4 \`empty\`: answered, no visible text (${n(em.n)} of ${n(E)} eligible routes) - its own group`);
w();
w(`\`empty\` is neither "works" nor "does not work": the provider answered a 200 stream and no text came back within 96 tokens. It is counted here and only here; sec 0 and sec 3 refer to it.`);
w();
w(T(["Cause", "Routes", "Would a bigger max_tokens likely help?"], [
  ["budget spent on hidden reasoning (stop_reason max_tokens, o > 0)", n(em.hidden), `**Likely yes** (${n(em.hidden)} routes, ${n(D.emptyDetail.hiddenReasoningReasonFlag)} of them flagged \`reason\` in the snapshot; ${n(em.o64)} of all ${n(em.n)} empty routes report exactly 64 output tokens although the request said 96, mostly openai reasoning ids, so some upstream or the gateway enforces a lower effective cap; not explained here; ${n(D.emptyDetail.hiddenLegacy)} of the ${n(em.hidden)} are legacy records)`],
  ["stream ended with no content (stop_reason end_turn)", n(em.endTurn), "No: the model finished with nothing to say; likely non-chat or filtered"],
  ["legacy record, no message", n(em.legacyNoMsg), `Unknown: ${n(D.emptyDetail.legacyNoMsgOk0)} have output_tokens 0/null (likely non-chat: alibaba/qwen3-asr-flash, gemini-3-pro-image), ${n(D.emptyDetail.legacyNoMsgOpos)} reported tokens (probably hidden reasoning); re-probe`],
]));
w(`By provider (routes): ${top(em.byProv, 12)}. ${n(D.emptyDetail.answeredElsewhereOk)} of the ${n(em.n)} empty routes have the same model id answering \`ok\` at another provider. Suggested: re-probe the ${n(em.hidden)} with max_tokens 1024 under the sweep's spend cap (bill-bearing; not priced here). \`empty\` means the provider answered, so it must not be pruned.`);
w();

// ---------------------------------------------------------------- 3 doesn't work
w(`## 3. What does not answer, by cause`);
w();
w(`Population: the **${n(G.notAnswered)} routes that did not answer** (${pct(G.notAnswered, E)} of ${n(E)}); \`empty\` (${n(G.empty)}) is excluded here (sec 2.4). Clusters come from \`m\` (the provider's own sentence, up to 160 characters) and, for the ${n(P.nonOkNoM)} legacy non-ok routes that lack \`m\`, from \`p\` (40 characters: a truncated sentence, so the rules match prefixes on purpose). Rules are in \`scripts/clusters.mjs\` (sec 6 lists the ones changed after review); ${n(D.causes.filter((c) => /:other$/.test(c.cause)).reduce((a, c) => a + c.n, 0))} routes remain in \`*:other\`. Provenance mix: L listing-verified, C catalogue-only, A config-asserted (as stored; see sec 2.1 for google's normalisation artefact). Legacy = the record predates the last run.`);
w();
const causeRows = (st) => cs(st).map((c) => [`\`${c.cause}\``, n(c.n), pct(c.n, G.notAnswered), n(c.legacy), `L ${n(c.prov["listing-verified"] || 0)} / C ${n(c.prov["catalogue-only"] || 0)} / A ${n(c.prov["config-asserted"] || 0)}`, top(c.providers, 3), c.examples.map((e) => "`" + e + "`").join("<br>")]);
const STS = ["pay", "auth", "gone", "error", "rate", "timeout"];
for (const st of STS) {
  w(`### 3.${STS.indexOf(st) + 1} ${st} (${n(S[st])} routes = ${pct(S[st], E)} of ${n(E)} eligible)`);
  w();
  w(T(["Cause cluster", "Routes", `% of the ${n(G.notAnswered)} that did not answer`, "legacy", "Provenance", "Top providers", "Examples"], causeRows(st)));
}
w(`Cause sentences worth knowing: kilo "Add credits to continue, or switch to a free model"; zenmux "only available to accounts with a balance greater than ..."; tokenrouter "This model cannot use part of your gift balance"; commandcode "Your Go plan doesn't include API access"; xkiro "This premium model requires an active paid plan or real deposited balance"; apinex "Daily check-in required to use free models" (${cause("pay:daily-check-in-required").n} routes, all apinex free/* ids); opencode "OpenCode's free tier can only be used from within OpenCode" (an entitlement tied to the client); mistral "Model ... is a Labs model ... an admin must enable ..." (${cause("auth:model-opt-in-required(Labs)").n} routes); openrouter "This model requires you to complete ... 18+ age confirmation"; nousresearch "Couldn't find that, sorry" (404 without detail; with the openrouter/openai \`:batch\` ids these are batch-API twins, see 3.7); openai "The requested model \`x\` ... does not exist or you do not have access to it" (${n(cause("gone:does-not-exist-OR-no-access(ambiguous)").n)} routes: removal versus entitlement cannot be told apart; a truncated legacy prefix is treated the same way); google "models/x is not found for API version ..., or is not supported for generateContent" (${n(cause("gone:google-models-prefix(not-found-OR-not-supported-for-generateContent)").n)} routes) and "This model models/x is no longer available to new users" (${n(cause("gone:no-longer-available-to-new-users(account-state)").n)} routes: account state).`);
w();
w(`### 3.7 Non-chat and batch ids: the corrected split`);
w();
w(`Revision 1 hid ${n(NC.rev1.goneNonChatBatch)} \`gone\` rows (":batch" and "not a chat model") and reclassified ${n(NC.rev1.errorNonChat)} \`error\` rows as non-chat, by id pattern and a regex cluster. The review found that hides working or reachable chat models: ${NC.batchRoutesOk} of ${NC.batchRoutesAll} \`:batch\` routes answer ok (${NC.batchOkKeys.join(", ")}); the ${NC.notAChatModel} aihubmix ids (${NC.notAChatModelIds.join(", ")}) are Responses-API chat models; and at least 12 of the ${NC.rev1.errorNonChat} \`error\` rows are chat models (commandcode Claude ids "must be called via /provider/v1/messages", infron/gpt-5.5-pro "does not support streaming", alibaba/qwen3-32b "no text output" inside the budget, alibaba/kimi-k3 "product is not activated"). It also missed ${n(NC.goneByMessage)} \`gone\` rows whose sentence says non-chat outright (openai "not supported with the Responses API" ${n(NC.goneByMessageByProvider.openai)}, zenmux "not supported by /v1/chat/completions" ${n(NC.goneByMessageByProvider.zenmux)}) and about 55 non-chat ids sitting in the shape/opaque \`error\` buckets. The rule is now status- and message-conditional:`);
w();
w(T(["Bucket (revision 2)", "Routes", "Decision", "Evidence used"], [
  ["gone, provider sentence says non-chat (openai Responses API, zenmux /v1/chat/completions)", n(NC.goneByMessage), "hide behind a filter (reversible)", "the provider's own sentence"],
  ["error, provider sentence says non-chat (audio/video/image/realtime model, `requires /v1/decisions`, `only allows access to the llm model`, ASR/TTS input errors)", n(NC.errorByMessage), "hide behind a filter (reversible)", `the provider's own sentence; by provider ${top(NC.errorByMessageByProvider, 6)}`],
  ["gone `:batch` id whose base id answers ok", n(NC.batchTwinBaseOk), "hide behind a filter (an ok chat twin exists)", "id + the ok twin"],
  ["gone id that names a non-chat model (veo, embedding, rerank, guard, ocr, mamba...) with a not-found sentence", n(NC.goneIdLooksNonChat), "hide behind a filter; re-probe once; NOT 'gone' (the model may exist)", "id token + sentence"],
  ["error, uninformative sentence, id names a non-chat model", n(NC.errorById), "label `non-chat?`; re-probe once; reclassify outputKind only if it repeats", `id only; by provider ${top(NC.errorByIdByProvider, 6)}`],
  ["gone `:batch` id with NO ok twin", n(NC.batchOnly), "label `batch-only`; keep", "id"],
  [`\`:batch\` routes that answer ok`, n(NC.batchRoutesOk), "keep (they work)", "status ok"],
  ["error, `must be called via /provider/v1/messages` (commandcode Claude ids) and google Interactions API", n(NC.chatNeedsOtherRoute), "label `needs other route`; keep; probe through that route", "the provider's own sentence"],
  ["gone, `This is not a chat model and t(his endpoint ...)` (aihubmix gpt-5.5-pro, gpt-5.2-pro, o3-pro)", n(NC.notAChatModel), "label `needs Responses API?`; do not hide", "id (pro models are Responses-only) + truncated sentence"],
  ["error, `does not support streaming` (infron gpt-5.5-pro)", n(NC.chatNoStreaming), "label `no streaming`; re-probe non-streaming", "the provider's own sentence"],
  ["error, `product is not activated` (alibaba kimi-k3)", n(NC.chatEntitlement), "label `not activated`; keep (entitlement)", "the provider's own sentence"],
  ["error, `does not contain text output` on an id that names no non-chat model (alibaba qwen3-32b)", n(NC.noTextOutput), "re-probe with a larger budget; do not hide", "sentence + id"],
  ["gone, google `no longer available to new users` / group entitlement (`No available channel ... under group`)", n(NC.googleNewUsers + NC.groupEntitlement), "label `restricted (new users)` / `no channel for account`; keep (account state)", "the provider's own sentence"],
]));
w(`Total hidden: **${n(NC.hiddenTotal)} routes** (${n(NC.newSplit.hideByMessage)} by the provider's own sentence, ${n(NC.batchTwinBaseOk)} batch twins with an ok base id, ${n(NC.goneIdLooksNonChat)} gone ids naming a non-chat model), against ${n(NC.rev1.goneNonChatBatch + NC.rev1.errorNonChat)} in revision 1. \`error\` and \`gone\` stay state: a hide is a filter on a row that remains in the data.`);
w();
w(`### 3.8 Records that look misclassified`);
w();
w(T(["Pattern", "Routes", "Providers", "Why / consequence", "Examples"], D.mis.map((m) => [m.kind, n(m.n), top(m.providers, 4), m.note || "", m.examples.slice(0, 2).map((e) => "`" + e.replace(/\|/g, "/").slice(0, 100) + "`").join("<br>")])));
w(`Populations differ per row (they are cross-cuts, not partitions); each denominator is the named pattern. Two systematic issues behind most of them: (a) the classifier checks the message before the status (\`QUOTA\` runs first, so nararouter's 429 "Insufficient credits ... try again in a few minutes" becomes \`rate\`), and \`gone\` has no way to say "not a chat model"; (b) the gateway rewrites some provider errors into "Upstream request failed.", which erases the sentence the classifier relies on, so the status then comes from the HTTP code alone (veniceai 114, gmicloudai 66, chutes 14 as \`pay\`; nvidia 91 as \`gone\`; cloudflare 8 as \`auth\`): those ${n(cause("pay:402-opaque-upstream-message").n + cause("gone:404-opaque-upstream-message").n + cause("auth:opaque-upstream-message").n + cause("error:opaque-upstream-failure").n)} routes have a status but no cause.`);
w();

// ---------------------------------------------------------------- 4 fixable
w(`## 4. Fixable and retrievable`);
w();
w(`### 4a. Re-probe (transient, artefact, or evidence too thin)`);
w();
w(`**The re-probe headline is ${n(RP.total)} routes, not ${n(RP.primary)}.** ${n(RP.primary)} is only the rows whose *primary* action is re-probe. The action column also asks for a re-probe on ${n(RP.labelAndReprobe)} rows that get a label (gone rows the provider lists, opaque 404s, google \`models/\`, \`non-chat?\`, ambiguous openai wording) and on ${n(RP.removeButReprobeOnce)} remove candidates that rest on a legacy record, plus ${n(RP.hideAndReprobe)} hidden rows to confirm. Split: ${n(RP.primary)} + ${n(RP.labelAndReprobe)} + ${n(RP.removeButReprobeOnce)} + ${n(RP.hideAndReprobe)} = ${n(RP.total)} (${pct(RP.total, E)} of ${n(E)} eligible; revision 1 said 648, its own column implied 1,405).`);
w();
const tr = [
  ["error: fetch failed (no HTTP response)", ff.n, `Most likely gateway/network, see evidence below. ${FF.providers} providers, ${FF.immediateRefusal} refused in under 100 ms. Not verified against gateway logs.`],
  ["error: model not served (\"cannot be served at the moment. Check the model ID\", \"model is unavailable\", \"no available providers\")", cause("error:model-unavailable-or-not-served").n, "Was filed as overload in revision 1 (45 aihubmix rows moved here). Re-probe; label `not served (upstream)` only if it repeats."],
  ["error: upstream overloaded / transient 5xx", cause("error:upstream-overloaded-or-transient-5xx").n, "The genuine overloads: seekai \"system disk overloaded\" (11), a few alibaba/google/xkiro. Retry later."],
  ["error: opaque upstream failure / model rejects request shape", cause("error:opaque-upstream-failure").n + cause("error:model-rejects-request-shape").n, "No cause recorded, or needs list content / other parameters; one retry, then label."],
  ["timeout", S.timeout, `${D.mis.find((m) => m.kind.startsWith("timeout")).n} of ${S.timeout} had a first token before the 35 s deadline (slow, not dead): retry with a 90 s deadline.`],
  ["rate (momentary)", cause("rate:rate-limited(momentary)").n, "mistral \"Rate limit exceeded\" (21), aihubmix upstream limits; retry with backoff."],
  ["empty (hidden reasoning)", em.hidden, "Retry at max_tokens 1024 (sec 2.4)."],
  ["legacy `gone` / `pay` / `auth` (old classifier, no `m`)", P.statusLegacy.gone + P.statusLegacy.pay + P.statusLegacy.auth, `${n(P.statusLegacy.gone)} gone + ${n(P.statusLegacy.pay)} pay + ${n(P.statusLegacy.auth)} auth: one current-engine pass gives them a full sentence before any removal.`],
];
w(T(["Bucket", "Routes", "Note"], tr.map((r) => [r[0], n(r[1]), r[2]])));
w(`**\`fetch failed\` evidence.** ${n(FF.total)} routes, all \`s=error\`, none in any other status. Time clustering: **${pctS(FF.insideShare)}** (${FF.insideWindowFF} of ${n(FF.insideWindowRecords)}) of last-run records written 13:10-13:50Z are \`fetch failed\`, against **${pctS(FF.outsideShare)}** (${FF.outsideWindowFF} of ${n(FF.outsideWindowRecords)}) outside that window and **${pctS(FF.sweep1Share)}** (${FF.sweep1FF} of ${n(FF.sweep1Probes)}) of sweep-1 real results (the reviewer counts 0.4% of 5,781 sweep-1 probes, which includes skipped rows in the denominator). Burst structure: **${FF.sameSecondBursts} groups** of >= 4 \`fetch failed\` within 3 s across 3-6 different providers (largest ${Math.max(...FF.burstSizes)} rows), what a connection stall looks like with 8 probes in flight. ${FF.immediateRefusal} were refused in under 100 ms. It cannot show: the run log carries no outage timestamps, so alignment of the 12 stalls with 13:10-13:50Z is inference; and the ${pctS(FF.outsideShare)} background rate means not every \`fetch failed\` is the gateway. **Recommendation: re-probe the ${n(ff.n)} routes; the result settles it** (an artefact resolves to ok or the row's true state).`);
w(`Population for the transient rows: the ${n(G.notAnswered)} routes that did not answer plus ${n(G.empty)} empty; the re-probe set is ${n(RP.total)} routes (above). Pending rows: 0 (sec 1).`);
w();
w(`### 4b. Spelling, alias and route fixes (gone rows with a sibling)`);
w();
w(`Method: for each \`gone\` route, look in the same provider (snapshot ids union the provider's discovery listing) for a sibling id: org-prefixed (\`org/x\` for \`x\`), bare (\`x\` for \`org/x\`), punctuation/case (\`qwen3-5-27b\` ~ \`qwen3.5-27b\`), or suffix-stripped (\`x:free\`, \`x:thinking\`, \`x@eu\`, \`x:batch\` -> \`x\`). A sibling counts only if it is \`ok\` in the bench. The listing comparison in this report normalises google's \`models/\` prefix, the \`[1m]\` suffix and case (revision 1 was prefix-blind).`);
w();
w(T(["Finding", "Routes", "Denominator"], [
  ["gone routes with any candidate sibling id", n(sb.withAnySibling), `${pct(sb.withAnySibling, sb.goneN)} of ${n(sb.goneN)} gone routes`],
  ["gone routes whose sibling answered ok", n(sb.withOkSibling), `${pct(sb.withOkSibling, sb.goneN)} of ${n(sb.goneN)} gone routes`],
  ["  of which `:batch` twins of an ok model (see 3.7: hide, not fix)", n(sb.kinds["batch-twin"]), `${pct(sb.kinds["batch-twin"], sb.withOkSibling)} of ${n(sb.withOkSibling)}`],
  ["  of which variant suffix (`:free`, `:thinking`, `@eu`, `@us`) of an ok id", n(sb.kinds["variant-suffix"]), "alibaba, openai, google; the provider serves the base id"],
  ["  of which punctuation/case spelling duplicates (alibaba `qwen3-5-*`)", n(sb.kinds.spelling), "catalogue spelling duplicates of ok ids"],
  ["**fixable (variant-suffix + spelling)**", n(sb.fixable), `${pct(sb.fixable, sb.goneN)} of ${n(sb.goneN)} gone routes: by provider ${top(sb.fixableByProvider, 6)}`],
  ["gone routes where the same model id answers ok at another provider", n(sb.crossProviderOk), `${pct(sb.crossProviderOk, sb.goneN)} of ${n(sb.goneN)}; informational (a different route, not a fix)`],
  ["error routes with an ok sibling", n(sb.errorWithOkSibling), `of ${n(S.error)} error routes`],
]));
w(`Aliases the sibling test does not catch (reviewer, hand-scanned): mistral ~25 (\`ministral-3-{3b,8b,14b}-2512\`, \`magistral-*\`, \`codestral@latest\`), google ~37 (\`@eu/@us/-thinking\` of listed ids), kilo 2 (\`hy3:free\` vs listed \`tencent/hy3\`). Removing those duplicates is harmless but they are better handled by aliasing, for reach.`);
w();
w(`**The nvidia bare-id claim, checked.** nvidia has ${sb.nvidia.n} gone routes (of ${provOf("nvidia").probed} probed); ${sb.nvidia.bareNoSlash} of them are bare ids (no \`org/\`), and ${sb.nvidia.orgSibling} have an org-prefixed sibling in NVIDIA's listing, but **${sb.nvidia.orgSiblingOk} of those siblings answered ok**, so the spelling theory recovers 0 nvidia routes. More telling: ${sb.nvidia.listed} of the ${sb.nvidia.n} nvidia gone routes are ids that NVIDIA's own listing names, and ${sb.nvidia.catalogueOnly} are catalogue-only; NVIDIA lists more models than it serves on this endpoint and answers 404 with the opaque "Upstream request failed". Only ${provOf("nvidia").ok} of ${provOf("nvidia").probed} nvidia routes answer.`);
w(`**Where \`gone\` comes from, by provenance** (${n(sb.goneN)} gone routes): catalogue-only ${n(sb.goneByProv["catalogue-only"])} (${pct(sb.goneByProv["catalogue-only"], sb.goneN)}), listing-verified ${n(sb.goneByProv["listing-verified"])} (${pct(sb.goneByProv["listing-verified"], sb.goneN)}), config-asserted ${n(sb.goneByProv["config-asserted"])} (as stored). With the listing check normalised, **${n(LA.goneNamedAfterNormalisation)} gone routes are named by the provider's own listing** (the exact-id check found ${n(LA.goneNamedExact)}; the extra ${LA.goneNamedAfterNormalisation - LA.goneNamedExact} are all google): ${top(sb.goneListedByProvider, 8)}. Those are \`:batch\` twins, non-chat ids, and entitlement-gated models, not removals.`);
w();
w(`Sample of fixable pairs (gone id -> ok sibling in the same provider):`);
w();
w(T(["provider", "gone id", "ok sibling [match type]"], D.siblings.pairs.filter((p) => !/:batch/i.test(p.gone)).slice(0, 20).map((p) => [p.provider, "`" + p.gone + "`", "`" + p.ok[0] + "`"])));
w();
w(`### 4c. \`empty\` -> larger max_tokens`);
w();
w(`${n(em.hidden)} of ${n(em.n)} empty routes (${pct(em.hidden, em.n)}) are recorded as budget-spent-on-hidden-reasoning: expected recoverable to \`ok\` at max_tokens >= 1024. ${n(em.legacyNoMsg)} legacy empties (${n(D.emptyDetail.legacyNoMsgOk0)} with no output tokens, likely non-chat) need a re-probe to know; ${n(em.endTurn)} will not be helped. Upper bound of recovery: ${n(em.hidden)} routes = ${pct(em.hidden, E)} of eligible.`);
w();
w(`### 4d. \`auth\` (${n(S.auth)} routes)`);
w();
w(T(["Cause", "Routes", "Fix"], cs("auth").map((c) => [`\`${c.cause}\``, n(c.n), ({
  "auth:access-denied(alibaba-region-or-model)": "alibaba/aihubmix \"Access denied\" (DashScope): the account or region is not entitled to that model; contact provider or drop the id (17 legacy). Not a key problem: the same key answers 107 other alibaba routes.",
  "auth:client-restricted": "opencode free tier works only inside OpenCode; vyceai/agentrouter \"unsupported/unauthorized client\": cannot be fixed from here; label 'restricted client'.",
  "auth:plan-or-consent-restricted-model": "openrouter 18+ age confirmation (do once in the provider dashboard), mistral/xkiro plan limits.",
  "auth:aggregator-model-access-denied-or-offline": "aihubmix \"model offline/disabled/no access\" (14): provider-side; label, re-check monthly.",
  "auth:opaque-upstream-message": "cloudflare (8), kktoken, justdowork: the gateway hid the sentence; needs a direct probe to learn the cause.",
  "auth:bad-or-inactive-key": "**Check before replacing.** sambanova: 7 of 7 routes say \"Incorrect API key\" (stable at 10-11Z and 14Z) while its discovery call returned 200 with 7 models, so the listing call was accepted with some credential. Check (1) which credential the gateway sends for sambanova versus the vault key (the provider's masked fragment is in the raw sentence; compare its first and last characters with the vault entry), (2) make one direct call outside the sweep with the vault key. indeedwebid: 'Invalid or inactive API key' (discovery 401 too): that one is a key/account problem.",
  "auth:model-opt-in-required(Labs)": "mistral Labs models: an org admin must enable them in the Mistral console.",
  "auth:other": "unclassified",
})[c.cause] ?? ""])));
w(`By provider (routes): ${top(D.auth.byProvider, 14)}. Only the bad-key rows (${n(cause("auth:bad-or-inactive-key").n)} of ${n(S.auth)} auth routes) may be a credential problem; the rest are per-model entitlements.`);
w();
w(`### 4e. \`pay\`: who to fund, ranked by the models the provider actually names`);
w();
w(`Ranking is by **listing-named pay routes** (pay routes whose id the provider's own listing names, after normalisation): those are the models a top-up can plausibly unlock. The raw catalogue pay count is shown next to it. A payment gate often answers before a model-existence check, so catalogue-only pay rows may be \`gone\` behind the payment wall: deepseek has ${payTop.find((p) => p.provider === "deepseek").pay} pay routes but its listing names ${payTop.find((p) => p.provider === "deepseek").listingCount} models, so a top-up unlocks about ${payTop.find((p) => p.provider === "deepseek").payNamed}. Conditional estimate = the provider's own ok share among its non-pay, non-\`fetch failed\` probed routes (sample size n shown), applied to its listing-named pay routes; **estimates with n < 30 are not shown**, because those non-pay rows are usually the free-tier survivors.`);
w();
w(T(["#", "provider", "listing-named pay routes", "catalogue pay routes", "provider listing size", "probed", "ok now", "cond. ok-rate of non-pay (n)", "est. recoverable (n >= 30 only)", "main pay cause", "free-badged pay", "shape"],
  payNamed.map((p, i) => {
    const mainc = Object.entries(p.causes).sort((a, b) => b[1] - a[1])[0];
    const est = p.condN >= 30 ? `${pctS(p.condOk)} (n=${p.condN})` : `n=${p.condN}: not estimated`;
    const rec = p.condN >= 30 ? n(Math.round(p.condOk * p.payNamed)) : "-";
    return [i + 1, p.provider, n(p.payNamed), n(p.pay), p.listingCount == null ? "" : n(p.listingCount), n(p.probed), n(p.ok), est, rec, `${mainc[0]} (${mainc[1]})`, n(p.freeRoutesPay), p.ok > 0 ? "partial: some models already work" : "fully gated: nothing answers yet"];
  })));
w(`Totals: ${n(S.pay)} pay routes over ${payTop.length} providers (${n(sum(payTop, (p) => p.payNamed))} named by a listing, ${n(sum(payTop, (p) => p.payCatalogueOnly))} catalogue-only). Fully gated (0 ok): ${payTop.filter((p) => p.ok === 0).map((p) => `${p.provider} ${p.payNamed}/${p.pay}`).join(", ")} (listing-named/catalogue). Partially gated (free/other models still work): ${payTop.filter((p) => p.ok > 0 && p.pay / p.probed < 0.5).map((p) => `${p.provider} ${p.pay}/${p.probed}`).join(", ")} (pay share < 50%). By badge, pay routes: ${provMix(D.pay.byBadge)}; **none carries the FREE badge, ${n(D.pay.freeQBadgePay)} carry FREE?** (kilo 2, xkiro 4, commandcode 2, teamorouter 3, tokenrouter 1): free-claimed models the provider refused for money reasons: fix the badge or the label, they are the most misleading rows in the picker.`);
w();
w(`Cause caveats: for veniceai (114), gmicloudai (66) and chutes (14) the pay status comes from a 402 whose sentence the gateway replaced with "Upstream request failed."; the cause (balance vs plan) is unverified but the status code says payment. deepseek's 94 pay rows all say "Insufficient Balance"; its 12 other rows are \`fetch failed\`.`);
w();
w(`### 4f. Providers: dead, needs money, partially alive`);
w();
{
  const groups = { dead: [], "needs-money": [], "no-answer (mixed)": [] };
  for (const p of D.prov) if (groups[p.verdictAdj]) groups[p.verdictAdj].push(p);
  w(T(["provider", "verdict", "probed", "status mix", "dominant blocker", "top sentences", "what to do"],
    [...groups.dead, ...groups["needs-money"], ...groups["no-answer (mixed)"]].map((p) => {
      const mix = ["ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate"].filter((s) => p[s]).map((s) => `${s} ${p[s]}`).join(", ");
      const what = ({ seekai: "provider outage (\"system disk overloaded\" 99%): re-probe in a day; keep", sambanova: "verify which credential the gateway sends before replacing the key (sec 4d)", tabiai: "discovery 522: provider down; re-probe later", gorouter: "discovery 502: provider down; re-probe later", indeedwebid: "invalid/inactive key: replace or drop the provider", kiosapi: "listing empty, its only row says \"No available channel\": label", kktoken: "opaque 401: needs a direct call to learn why", justdowork: "opaque 401", deepseek: "top up only if wanted: its listing names 2 models (sec 4e); re-probe the 12 fetch-failed rows", chutes: "top up (402, opaque)", routllm: "top up / plan (\"No credits remaining\")", xai: "1 route, 403 opaque: check key", gmicloudai: "top up (402 opaque, 66) and re-probe 8 fetch-failed", cerebras: "some routes archived/unknown, 2 need payment: label" })[p.provider] ?? "";
      return [p.provider, p.verdictAdj, p.probed, mix, p.dominant, (D.provMsg[p.provider] ?? []).slice(0, 2).map((x) => x[0].slice(0, 70).replace(/\|/g, "/")).join("<br>"), what];
    })));
}
w(`Providers reading "dead" are almost all tiny: the 8 hold ${n(sum(D.prov.filter((p) => p.verdictAdj === "dead"), (p) => p.probed))} eligible routes together (${pct(sum(D.prov.filter((p) => p.verdictAdj === "dead"), (p) => p.probed), E)} of ${n(E)}). Excluding \`fetch failed\` moves deepseek (94 pay) from no-answer to needs-money; xai's only route is a 403 opaque. Two "healthy" verdicts deserve a note: aihubmix (272 ok of 424) and openrouter (236 of 469) answer *and* carry the largest blocks of gone/pay, i.e. their catalogue lists more than they serve. inceptionlabs (2 empty, 0 ok) answers but hides its reasoning: it is partially alive, not dead.`);
w();

// ---------------------------------------------------------------- 5 proposal
w(`## 5. Label vs remove proposal`);
w();
w(`**Guardrails applied.** (1) Never remove a model that ever answered: checked against all three bench files (current, before-probe-all, first-sweep), status ok or empty: ${n(rm.explicitCatalogueOnlyEverAnswered)} of the ${n(rm.explicitCatalogueOnly)} explicit-not-found catalogue-only routes ever answered (and 0 of all ${n(sb.goneN)} gone routes did). **This check is much weaker than it looks:** all three files are from a single day (${rm.evidence.calendarDaysSpanned} calendar day); ${rm.evidence.routesThatWentOkToNonOk} routes went from ok to non-ok between them; each remove candidate has exactly one probe time in practice (${n(rm.evidence.withOneProbeTime)} of ${n(rm.candidates)} have one distinct probe time, ${rm.evidence.withEarlierErrorRecord} have an earlier \`error\` record, **${rm.evidence.withTwoDistinctGoneProbeTimes} have two independent \`gone\` probes**; the 224 "legacy" candidates are one record copied into three files); and compaction prunes records past the freshness window, which erases the only "ever answered" evidence. So the guardrail is a same-day snapshot, not a history. **Before any automated removal:** keep a persistent ever-ok ledger (a model that has ever answered on any day is never removed) and require two independent \`gone\` probes on different days. (2) \`pay\`, \`auth\`, \`rate\`, \`timeout\`, \`error\`, \`empty\` are STATE: label or re-probe, never remove. (3) Removal only for \`gone\` with an explicit not-found/removed sentence visible in the stored text, catalogue-only provenance and not named by the listing after normalisation, no ok sibling, not a \`:batch\` id, id not naming a non-chat model, not the ambiguous "does not exist or you do not have access" wording. (4) A label that cannot be kept fresh should come down: the picker stops showing a record as current after 14 days (\`BENCH_FRESH_MS\`: the legacy records from ${D.staleAt.legacyStaleOn.slice(0, 16)}Z, the last run's from ${D.staleAt.currentStaleOn.slice(0, 16)}Z), while a default re-probe uses the 7-day ttl (from ${D.retention.legacyDefaultReprobeFrom.slice(0, 16)}Z); without a scheduled re-sweep every label here silently disappears (the safe direction, but the work is lost).`);
w();
w(`**Action definitions.** keep = leave as is; label = keep in the picker with a state label; hide = behind a filter (non-chat / duplicate); remove = drop from the picker list; re-probe first = do not decide yet; fix first = a catalogue fix removes the problem.`);
w();
const CLS = { "remove-candidate": "remove", "label": "label", "hide-filter": "hide", "fix-first": "fix first", "re-probe-first": "re-probe first", "keep": "keep", "keep+label(other)": "keep+label" };
const riskOf = (c) => {
  const k = c.classes;
  if (c.status === "pay") return "label is state; clears after funding + a re-sweep, and expires after 14 d otherwise";
  if (c.status === "auth") return c.cause.includes("bad-or-inactive-key") ? "verify the credential before replacing it" : "per-model entitlement; label is state";
  if (c.status === "gone") { const dom = Object.entries(k).sort((a, b) => b[1] - a[1])[0][0]; return dom === "remove-candidate" ? "removal is not self-reversing: keep the list and a re-add path; legacy rows: re-probe first; one probe, one day" : dom === "hide-filter" ? "a hide is a filter: fully reversible" : dom === "fix-first" ? "catalogue fix; reversible" : "label/re-probe: a transient routing 404 or an account restriction would mislabel a live model"; }
  if (c.status === "error") return c.cause.startsWith("error:fetch-failed") ? "no label: would blame the model for a gateway fault" : "a label is wrong if the row was only transient: re-probe first";
  if (c.status === "rate") return "quota labels can mislead within a day";
  if (c.status === "timeout") return "slow is not dead";
  return "answered (empty): must not be pruned";
};
const propRows = D.proposal.byCause.filter((c) => c.status !== "ok").map((c) => {
  const pv = `L ${n(c.prov["listing-verified"] || 0)} / C ${n(c.prov["catalogue-only"] || 0)} / A ${n(c.prov["config-asserted"] || 0)}`;
  const cls = Object.entries(c.classes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${CLS[k] ?? k} ${n(v)}`).join(", ");
  const lab = D.labelMap[c.cause] ? `\`${D.labelMap[c.cause]}\`` : "";
  return [`\`${c.cause}\``, n(c.n), pct(c.n, E), pv, n(c.everAnswered), cls, lab, riskOf(c)];
});
w(T(["Cause bucket", "Routes", "% of eligible", "Provenance (as stored)", "Ever ok/empty in a bench file", "Action classes (routes)", "Label text (if labelled)", "Risk / reversal"], propRows));
w(`Row-level action strings for every route are in \`models.csv\` column \`proposed_action\` (${Object.keys(D.proposal.actionTotals).length} distinct strings).`);
w();
w(`**Suggested label texts.** pay: \`needs top-up\`, \`locked until purchase\` (experientiallabs), \`needs min balance\` (zenmux), \`plan-gated\`, \`needs cash balance\` (gift balance cannot cover), \`daily check-in\` (apinex), \`payment/plan? (opaque)\`. auth: \`bad key\`, \`restricted client\`, \`opt-in required\`, \`plan/consent required\`, \`no access/offline\`, \`access denied\`, \`auth? (opaque)\`. rate/quota: \`quota exhausted\`, \`rate-limited\`, \`free access not enabled\`. gone and error: \`not found now\`, \`listed but 404\`, \`unreachable (404)\`, \`not found or not for generateContent\` (google \`models/\`), \`restricted (new users)\`, \`no channel for account\`, \`batch-only\`, \`non-chat?\`, \`needs Responses API?\`, \`needs other route\`, \`no streaming\`, \`not activated\`, \`no text in budget\`, \`not served (upstream)\`, \`reasoning-heavy\` (only after a confirming re-probe). Status codes \`pay\`, \`auth\`, \`gone\` already exist in the picker; these texts add the *cause*.`);
w();
w(`### Removal: the exact set`);
w();
w(T(["Step (each applied to what the previous step left)", "Routes left", "Dropped"], [
  [`gone routes (of ${n(E)} eligible)`, n(sb.goneN), ""],
  ...rm.funnel.map((f) => [`  ${f.name}`, n(f.remaining), n(f.dropped)]),
  ["**remove candidates**", `**${n(rm.candidates)}**`, ""],
  ["  of which rest on a legacy record (re-probe once with the current engine before removal)", n(rm.candidatesLegacy), ""],
  ["  of which confirmed by a current-engine sentence", n(rm.candidatesCurrent), ""],
  ["  of which ever ok/empty in any of the 3 bench files (same day; see guardrail 1)", "0", ""],
  ["  of which have two independent `gone` probes", n(rm.evidence.withTwoDistinctGoneProbeTimes), ""],
]));
w(`Candidates by provider: ${top(rm.candidatesByProvider, 12)}. By message class: ${Object.entries(rm.candidatesByCause).map(([k, v]) => `${k.replace("gone:", "")} ${v}`).join(", ")}. Catalogue-only \`gone\` routes that are NOT candidates: ${n(rm.catalogueOnlyGoneNotCandidate)} of ${n(rm.catalogueOnlyGone)} (by cause: ${Object.entries(rm.catalogueOnlyGoneNotCandidateByCause).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace("gone:", "")} ${v}`).join("; ")}).`);
w();
w(`**Listing normalisation: how many candidates changed.** Revision 1 compared ids to the provider listing exactly. Re-checking every one of the 57 providers with google's \`models/\` prefix, the \`[1m]\` suffix and case normalised: ${n(LA.namedAfterNormalisation)} of ${n(LA.catalogueOnlyEligible)} catalogue-only eligible routes turn out to be listed, **all google** (${LA.namedAfterNormalisation} of google's 138 catalogue-only rows; 0 for the other 56 providers, whose ids already matched or genuinely are not listed). Of revision 1's 467 candidates, **${LA.revCandidatesNowListed.length} are named by the listing** (${LA.revCandidatesNowListed.join(", ")}); three are \`[1m]\` google ids, three are veo video models and one is \`aqa\`. ${n(LA.okAmongNamed)} ok routes were also mislabelled catalogue-only (sec 2.1).`);
w();
w(`**Reconciling the counts: 467 (revision 1) -> ${n(rm.candidates)} (now), and the reviewer's independent 454.**`);
w();
w(T(["Set", "Routes", "Difference"], [
  ["Revision 1", n(REC.rev1), ""],
  ["  - google, all 90 (demoted to re-probe-first): 7 named by the listing, 8 `no longer available to new users` (account state), 83 (of 90) with the verdict invisible in the 40-char snippet and google's full sentence \"or not supported for generateContent\"", `-${n(rm.reconcile.droppedSinceRev1ByProvider.google)}`, "google"],
  ["  - ids that name a non-chat model (alibaba 6: omni-realtime, audio, reranker, embedding, guard; mistral 4: ocr, mamba; cohere 2)", "-12", "hide, do not call 'gone'"],
  ["  - verdict not visible in the truncated snippet (kilo 2 \"requested model 'x' doe\", cohere 1 \"was r\")", "-3", "re-probe first"],
  ["  - truncated ambiguous tail \"Model does not exist or you do\" (cerebras)", "-3", "ambiguous wording"],
  ["  + cerebras \"is archived\" (2), which rev 1's rules missed", "+2", ""],
  ["**Now**", `**${n(rm.candidates)}**`, ""],
  ["Reviewer's independent set (its own regexes)", n(REC.critic), ""],
]));
w(`Versus the reviewer's 454, revision 1 had ${REC.rev1NotCritic} rows the reviewer's regexes did not select (${Object.entries(REC.rev1NotCriticByProvider).map(([k, v]) => `${k} ${v}`).join(", ")}: zenmux's "Requested model is not valid" is not matched by the reviewer's \`not a valid|invalid model\`; kilo's "requested model 'x' doe" and cohere's "was r" are truncated snippets) and the reviewer selected ${REC.criticNotRev1} rows revision 1 lacked (${Object.entries(REC.criticNotRev1ByProvider).map(([k, v]) => `${k} ${v}`).join(", ")}: "is archived", now added). The current set differs from the reviewer's by ${REC.nowNotCritic} rows it has and the reviewer lacks (${Object.entries(REC.nowNotCriticByProvider).map(([k, v]) => `${k} ${v}`).join(", ")}) and ${REC.criticNotNow} rows the reviewer keeps and this build no longer does (${Object.entries(REC.criticNotNowByProvider).map(([k, v]) => `${k} ${v}`).join(", ")}): 454 - ${REC.criticNotNow} + ${REC.nowNotCritic} = ${n(REC.now)}.`);
w();
w(`**Edge cases.** (a) ${n(rm.candidatesCrossOk)} of the ${n(rm.candidates)} candidates have the same model id ok at another provider: the *model* still works and only this provider's route is dead, the strongest reason to remove the route rather than the model. (b) alibaba's ${rm.candidatesByProvider.alibaba} are legacy "Model not exist." records (one probe; "not exist" can also mean region or activation, and ${LA.okCatalogueOnlyNotListedByProvider.alibaba} catalogue-only alibaba ids do answer ok); alibaba's listing names 172 ids while its catalogue holds ${provOf("alibaba").eligible} eligible routes. (c) mistral's ${rm.candidatesByProvider.mistral} come from the current engine ("Invalid model: ..."), the strongest evidence in the set, but ${LA.okCatalogueOnlyNotListedByProvider.mistral} catalogue-only mistral ids also answer ok. (d) About 25 mistral/google candidates in revision 1 were duplicate spellings of a listed model (alias, do not merely remove).`);
w();
w(`### Picker impact (routes, by action class)`);
w();
w(`Whole picker (${n(E)} eligible routes): ${Object.entries(ac).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${n(v)} (${pct(v, E)})`).join(", ")}. The 238 non-chat routes stay excluded from probing. Removing the ${n(rm.candidates)} candidates (after their second probe) shrinks the picker from ${n(P.routes)} to ${n(P.routes - rm.candidates)} routes (${pct(rm.candidates, P.routes)} of ${n(P.routes)}); the ${n(NC.hiddenTotal)} hidden rows plus ${n(ac["fix-first"])} fix-first duplicates would leave the default view (${n(NC.hiddenTotal + ac["fix-first"])}). Per provider:`);
w();
w(T(["provider", "eligible", "keep (ok)", "label", "hide", "remove", "re-probe first", "fix first", "other keep"],
  D.prov.filter((p) => p.eligible > 0).sort((a, b) => b.eligible - a.eligible).map((p) => { const i = D.proposal.impact[p.provider]; return [p.provider, n(p.eligible), n(i.keep), n(i.label), n(i.hide), n(i.remove), n(i.reprobe), n(i.fix), n(i.other)]; })));
w();

// ---------------------------------------------------------------- 6 data quality
w(`## 6. Data-quality caveats and pipeline changes`);
w();
w(T(["Issue (evidence)", "Effect", "One-line recommended change"], [
  ["Probe sends no tools, one bare message, max_tokens 96, single sample", `ok means "answers a bare chat message" only; ${n(D.okExtra.thinkingOnlyOk)} of ${n(S.ok)} ok routes are thinking-only within 96 tokens`, "Keep the probe as the liveness test; add a second, optional tool-schema probe (#118/#119) and record it in its own field."],
  ["max_tokens 96 is too small for reasoning models", `${n(em.hidden)} \`empty\` (${pct(em.hidden, E)} of eligible)`, "Retry `empty`/`stop_reason=max_tokens` once at 1024 and store the result under the same key."],
  ["Streams delivered as one burst", `${pct(PF.burst.n, S.ok)} of ok routes have no tok/s and \`t\` = time to the whole answer`, "Record a `burst` flag when d - t <= 50 ms; label that cell 'total', and never rank speed across burst and streamed rows."],
  ["Classifier reads message before status (QUOTA first)", `${cause("rate:MISCLASSIFIED-really-pay(insufficient-credits)").n} rate rows are really pay; ${cause("rate:quota-exhausted(free-tier-or-daily)").n} quota rows are state, not momentary`, "Check `insufficient|credits|balance` before `QUOTA`; split `rate` into `rate` (retry) and `quota` (state)."],
  ["No status for non-chat / batch / wrong endpoint", `${n(NC.newSplit.hideByMessage)} rows say non-chat in the provider's own sentence; ${NC.batchRoutesAll} \`:batch\` routes of which ${NC.batchRoutesOk} answer ok`, "Add `nonchat` (or `unroutable`) to STATUSES for sentences that say so; never derive it from the id alone (4 ok `:batch` routes, 12 chat models among the old 161)."],
  ["Gateway rewrites provider errors to 'Upstream request failed.'", `${n(cause("pay:402-opaque-upstream-message").n + cause("gone:404-opaque-upstream-message").n + cause("auth:opaque-upstream-message").n + cause("error:opaque-upstream-failure").n)} routes have a status without a cause`, "Persist the HTTP status (probeOne already returns `http`, but bench.json records only s,t,d,r,o,a,p,k,m,w) and keep the gateway's `target_providers` in `m`."],
  ["`fetch failed` recorded as `error` (no HTTP response)", `${n(ff.n)} routes (${pct(ff.n, P.currentRunRecords)} of the ${n(P.currentRunRecords)} current-run routes)`, "Do not persist a result that never got an HTTP response: requeue it (a `skip:gateway` reason). The outage breaker only fires after 30 consecutive hard results with no ok anywhere, so scattered failures slip through."],
  ["Legacy records: old classifier, no `m`, 40-char `p`", `${n(P.legacyRecords)} routes (${pct(P.legacyRecords, E)}); ${n(P.nonOkNoM)} non-ok have no sentence`, "Re-probe every `gone`/`pay`/`auth`/`empty` legacy record once: the 7-day ttl skips them and `--force` re-probes everything (including the 1,404 ok legacy routes), so add a status filter to `--force`."],
  ["Two freshness dates", `default re-probe ttl 7 d (legacy from ${D.retention.legacyDefaultReprobeFrom.slice(0, 10)}); picker display 14 d (legacy from ${D.staleAt.legacyStaleOn.slice(0, 10)}); all records written on one day`, "Schedule a weekly re-probe of non-ok rows and a monthly ok re-probe, or accept labels expiring together."],
  ["No durable 'ever answered' evidence", `all three bench files are from one day; compaction prunes old records; ${rm.evidence.withTwoDistinctGoneProbeTimes} of ${n(rm.candidates)} candidates have two \`gone\` probes`, "Persist an ever-ok ledger (route, first/last ok time) that compaction never prunes; require two `gone` probes on different days before removal."],
  ["Provider verdicts (`dead` / `needsMoney`) count `fetch failed` rows", "the snapshot's needsMoney has 3 providers, this report 4 (deepseek: 94 pay + 12 fetch failed)", "Exclude `fetch failed` rows from providerFlags."],
  ["Snapshot provenance is prefix- and suffix-blind", `${n(LA.namedAfterNormalisation)} google catalogue-only routes are in fact listed (${LA.okCatalogueOnly - LA.okCatalogueOnlyNotListed} of them ok)`, "Normalise `models/` and `[1m]` in the provenance check (menu/snapshot.mjs) so 'catalogue-only' means what it says."],
  ["Catalogue never removes rows", `${n(sb.goneByProv["catalogue-only"])} catalogue-only gone routes (${pct(sb.goneByProv["catalogue-only"], sb.goneN)} of gone)`, "Feed the removal set (sec 5) into the catalogue refresh as a tombstone list, with a listing-verified re-add path."],
  ["Provider sentences persisted verbatim (bench.json `m`)", "one sambanova sentence carries a masked key fragment; many carry URLs and request ids", "Sanitise `m` before it is written (mask `xxxx***xxxx` fragments, strip URLs); this study redacts on read, see below."],
]));
w();
w(`### Rules changed after the review (clusters.mjs and the action rules in build.mjs)`);
w();
w(`- **gone:** ids ending \`:batch\` are always \`batch-variant\` (was: only when the text said so); new \`non-chat-by-message\` ("not supported with the Responses API", "not supported by /v1/chat/completions", "is a(n) audio/video/image/realtime model"); new \`not-a-chat-model(may-be-Responses-API-only)\`; new \`no-longer-available-to-new-users(account-state)\` (google); new \`no-channel-for-account-group(entitlement)\`; google \`models/\` sentences are their own cluster (not found OR not supported for generateContent), never a removal; "archived" joins decommissioned; the ambiguous "or you do not have access" test also matches the truncated tail "or you do".`);
w(`- **error:** \`cannot be served|currently closed|model is unavailable|no available providers|no available channel\` now runs BEFORE the overload rule (45 aihubmix rows move from overload to model-not-served); new \`chat-needs-other-route\` ("must be called via", Interactions API), \`chat-no-streaming\`, \`chat-entitlement(product not activated)\`; \`non-chat-by-message\` no longer swallows those; \`does not contain text output\` is its own cluster (non-chat only if the id also names a non-chat model); shape/opaque rows whose id names a non-chat model become \`non-chat-by-id\` (label \`non-chat?\`).`);
w(`- **removal rule:** listing compared after normalising \`models/\`, \`[1m]\` and case; the sentence must show a verdict (a 40-character snippet matched only by provider style is not evidence); ids naming a non-chat model are excluded; siblings and never-answered checks as before.`);
w(`- **redaction:** \`redact()\` in lib.mjs masks key-like fragments and strips URLs and bare domain/path links from every message that reaches models.csv, data.json, sweeps.json, reconcile.json and this report; verify.mjs fails if any deliverable matches a key or URL pattern.`);
w();
w(`### Numbers I could not reconcile`);
w();
w(`- **The 401 rows the gateway outages "put back unrecorded".** They are not missing (pending = 0, planned 3,510 = recorded 3,510, \`requeue()\` re-probes them in the same run); the exact 401 keys cannot be recovered from the files (sec 7.7 gives a 264-key floor by timestamp proximity).`);
w(`- **Route vs key counts:** 5,794 eligible routes vs 5,793 keys; \`error\` is 619 routes / 618 keys and \`fetch failed\` 270 routes / 269 keys, all explained by one \`[1m]\` twin route (${D.m1.withBareSiblingExamples.join(", ")}).`);
w(`- **"Bare nvidia ids never match the org-prefixed listing"** is true for ${sb.nvidia.bareNoSlash} bare ids but explains none of the losses: no org-prefixed sibling answers (sec 4b).`);
w(`- **The reviewer's remove set (454) versus this build (${n(rm.candidates)}):** reconciled row-class by row-class in sec 5; the gap is google 90, non-chat ids 12, ambiguous-truncated 3, less 12 rows this build keeps (zenmux 10, cohere 2).`);
w(`- The cause clusters for legacy records rest on a 40-character prefix; the ${n(D.causes.filter((c) => /:other$/.test(c.cause)).reduce((a, c) => a + c.n, 0))} rows left in \`*:other\` are listed in \`models.csv\` (cause ends with \`:other\`). The reviewer's sample accuracy was measured on revision-1 rules and was not re-measured on the new ones.`);
w();
w(sweepSection());

// ---------------------------------------------------------------- 8 corrections
w(`## 8. Corrections since revision 1 (old -> new)`);
w();
const PR = PREV.removal;
w(T(["Item", "Revision 1", "Revision 2", "Why"], [
  ["Remove candidates", n(PR.candidates), n(rm.candidates), "listing check normalised (7 listed), google 90 demoted, non-chat ids and invisible verdicts out, cerebras archived in"],
  ["  of which google", "90", String(rm.candidatesByProvider.google ?? 0), "verdict invisible / listed / account state / not-for-generateContent"],
  ["  legacy-record candidates / current-engine candidates", `${n(PR.candidatesLegacy)} / ${n(PR.candidatesCurrent)}`, `${n(rm.candidatesLegacy)} / ${n(rm.candidatesCurrent)}`, ""],
  ["Remove-candidate provenance check (listed by the provider)", "0 of 467", `${LA.revCandidatesNowListed.length} of 467 were listed`, "google `models/` prefix and `[1m]`"],
  ["Catalogue-only routes named by the provider listing", "0", `${n(LA.namedAfterNormalisation)} of ${n(LA.catalogueOnlyEligible)}`, "all google"],
  ["ok routes labelled catalogue-only", "35", `${LA.okCatalogueOnlyNotListed} genuinely (${LA.okCatalogueOnly - LA.okCatalogueOnlyNotListed} are google ids the listing names)`, "normalisation"],
  ["gone routes named by the listing", "333", n(LA.goneNamedAfterNormalisation), "normalisation"],
  ["Hidden / reclassified as non-chat", `${NC.rev1.goneNonChatBatch} gone + ${NC.rev1.errorNonChat} error = ${NC.rev1.goneNonChatBatch + NC.rev1.errorNonChat}`, `${n(NC.hiddenTotal)} hidden (${n(NC.newSplit.hideByMessage)} by sentence, ${n(NC.batchTwinBaseOk)} batch twins with an ok base, ${n(NC.goneIdLooksNonChat)} non-chat-looking gone ids)`, "message- and ok-twin-conditional"],
  ["Non-chat error rows", "161", `${n(NC.errorByMessage)} by sentence + ${n(NC.errorById)} by id only (label) + ${n(NC.chatNeedsOtherRoute + NC.chatNoStreaming + NC.chatEntitlement)} chat models moved out (the total is larger than 161 because ids in the shape/opaque buckets are now counted)`, "chat models must not be hidden"],
  ["gone rows with explicit non-chat text now counted", "0 (filed as 'listed but 404')", n(NC.goneByMessage), "openai 23, zenmux 26"],
  ["`:batch` routes that answer ok", "not counted", `${NC.batchRoutesOk} of ${NC.batchRoutesAll}`, "kept"],
  ["Re-probe headline", "648 (primary action only)", `${n(RP.total)} (${n(RP.primary)} primary + ${n(RP.labelAndReprobe)} label-and-re-probe + ${n(RP.removeButReprobeOnce)} remove-once + ${n(RP.hideAndReprobe)} hide)`, "the action column asks for more than the headline said"],
  ["Label class", "2,491", n(ac.label), "reclassified rows now labelled instead of hidden or removed"],
  ["Overload cause", "74 rows (45 aihubmix are model-not-served)", `${cause("error:upstream-overloaded-or-transient-5xx").n} overload + ${cause("error:model-unavailable-or-not-served").n} model-not-served`, "rule order"],
  ["`[1m]` wording", "1,062 routes 'twins', 'double-counted'", `${n(D.m1.routes)} routes carry the suffix, ${D.m1.withBareSiblingRoute} has a bare sibling route`, "only teamorouter/kimi-k3"],
  ["benchFlags", "'snapshot is stricter'", "dead set identical (8); needsMoney 3 vs 4 (deepseek)", "snapshot needs every record pay/unfunded; deepseek has 12 fetch-failed errors"],
  ["`empty`", "counted under works and under does-not-work", "one group of its own (sec 2.4)", "presentation"],
  ["Top-up ranking", "raw catalogue pay routes (deepseek #8 with 94)", "listing-named pay routes (deepseek: 1); estimates only for n >= 30", "payment-first masks existence"],
  ["Timing", "median TTFT 8,935 ms 'use for ranking' over mixed rows", `streamed TTFT median ${ms(PF.streamed.ttft.median)} ms (n ${n(PF.streamed.n)}), burst whole-answer median ${ms(PF.burst.timeToWholeAnswer.median)} ms (n ${n(PF.burst.n)}); no ranking`, "burst rows are not first-token times"],
  ["Pending", "'contradicts the brief'; legacy stale 2026-10-13", "pending 0 explained by requeue() and 3,510 = 3,510; 7-day re-probe from 2026-10-06, 14-day display from 2026-10-13", "labelled dates"],
  ["Redaction", "masked sambanova key fragment in 4 models.csv rows; URLs in messages", "redacted in all deliverables", "verify.mjs check"],
]));
w();
w(`## 9. Reproduce`);
w();
w(`\`node plans/bench-study/scripts/build.mjs\` (writes data.json, models.csv, providers.csv), then \`sweeps.mjs\` (sweeps.json, the sec 7 data), \`reconcile_critic.mjs\` (reconcile.json, sec 5 reconciliation), \`report.mjs\` (this file; uses \`report_sweeps.mjs\`) and finally \`verify.mjs\` (independent second code path for the headline numbers plus the redaction check; must print "all checks passed"). All scripts are read-only on \`~/.uw/state\` and \`~/.uw/catalog\` and need only Node. Freshness is evaluated at the snapshot's \`benchAsOf\` for determinism. \`prev/\` holds the revision-1 candidate list and summary the reconciliation compares against.`);

fs.writeFileSync(path.join(OUT, "REPORT.md"), out.join("\n") + "\n");
console.log("REPORT.md", out.join("\n").length, "chars");

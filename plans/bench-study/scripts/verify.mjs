// Second, independent code path for the headline numbers: does NOT import lib.mjs / clusters.mjs / build.mjs.
// It reads the raw JSON files directly with different logic (e.g. legacy = "record identical to the pre-probe-all backup",
// fetch failed = raw message equality on bench.json, removal rule = its own regexes) and compares with data.json.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const H = os.homedir();
const J = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const snap = J(path.join(H, ".uw/catalog/snapshot.json"));
const bench = J(path.join(H, ".uw/state/bench.json")).models;
const before = J(path.join(H, ".uw/state/bench.before-probe-all.json")).models;
const first = J(path.join(H, ".uw/state/bench.first-sweep.json")).models;
const D = J(path.join(H, ".uw/plans/bench-study/data.json"));
let fails = 0;
const chk = (name, mine, theirs) => { const okk = JSON.stringify(mine) === JSON.stringify(theirs); if (!okk) fails++; console.log(okk ? "PASS" : "FAIL", name, JSON.stringify(mine), okk ? "" : "vs data.json " + JSON.stringify(theirs)); };

let routes = 0, nontext = 0; const st = {}, byProv = {}, gone = [];
for (const row of snap.rows) for (const m of row.models) {
  routes++;
  if (m.outputKind === "nontext" || m.routable === false) { nontext++; continue; }
  const key = row.provider + "/" + m.id.replace(/\[1m\]$/i, "");
  const rec = bench[key];
  st[rec.s] = (st[rec.s] || 0) + 1;
  (byProv[row.provider] ??= {})[rec.s] = ((byProv[row.provider] ?? {})[rec.s] || 0) + 1;
  if (rec.s === "gone") gone.push({ key, prov: m.provenance, id: m.id, rec, provider: row.provider });
}
chk("routes", routes, D.pop.routes);
chk("non-chat routes", nontext, D.pop.nonChat);
chk("eligible routes", routes - nontext, D.pop.eligible);
for (const s of ["ok", "empty", "pay", "auth", "gone", "error", "timeout", "rate"]) chk("status " + s, st[s] || 0, D.pop.status[s]);
chk("sum of statuses == eligible", Object.values(st).reduce((a, b) => a + b, 0), D.pop.eligible);
chk("per-provider ok, sum over providers", Object.values(byProv).reduce((a, p) => a + (p.ok || 0), 0), D.prov.reduce((a, p) => a + p.ok, 0));
for (const p of ["openrouter", "aihubmix", "kilo", "alibaba", "nvidia"]) chk("ok " + p, byProv[p].ok || 0, D.prov.find((x) => x.provider === p).ok);
// legacy = record byte-identical (a and s) to the pre-probe-all backup
let legacy = 0; for (const k of Object.keys(bench)) if (before[k] && before[k].a === bench[k].a && before[k].s === bench[k].s) legacy++;
chk("legacy records (unchanged vs pre-probe-all backup), by key", legacy, 2283);
chk("keys in bench.json", Object.keys(bench).length, D.meta.benchKeys);
// key level (bench.json) is one fewer than route level (snapshot): one [1m] route shares its record with its twin
const ffKeys = Object.keys(bench).filter((k) => bench[k].m === "fetch failed");
let ffRoutes = 0; for (const row of snap.rows) for (const m of row.models) if (!(m.outputKind === "nontext" || m.routable === false) && bench[row.provider + "/" + m.id.replace(/\[1m\]$/i, "")]?.m === "fetch failed") ffRoutes++;
chk("fetch failed, routes (raw m equality via snapshot walk)", ffRoutes, D.causes.find((c) => c.cause.startsWith("error:fetch-failed")).n);
console.log("INFO fetch failed at key level:", ffKeys.length, "(one [1m] twin route explains the +1 at route level)");
chk("records without m among non-ok", Object.values(bench).filter((r) => r.s !== "ok" && !r.m).length, D.pop.nonOkNoM);
// removal rule, independently (revision 2): own regexes, own listing normalisation read straight from the discovery files.
// gone + snapshot provenance catalogue-only + NOT named by the provider listing (lowercase, no `models/`, no [1m]) + explicit not-found/removed wording
// visible in the stored sentence + not a :batch id + not the ambiguous "or you do not have access" wording + not a non-chat/Responses/google-prefix/new-user/group
// sentence + id names no non-chat model + no same-provider ok sibling + never ok/empty in any of the 3 bench files.
const EXPL = /not exist|not found|invalid model|unsupported model|not a valid|requested model is not valid|no endpoints|decommission|deprecated|retired|archived|was removed|was remov|couldn'?t find|selected model is unavail|no available|is not supported/i;
const AMB = /do not have access|or you do/i;
const NOT_A_REMOVAL = /responses api|by \/v1\/chat\/completions|not a chat model|new users|no available channel|^google: models\//i;
const NONCHAT_ID = /embed|rerank|(^|[-\/_.])tts([-\/_.]|$)|(^|[-\/_.])asr([-\/_.]|$)|transcri|whisper|speech|imagen|image|(^|[-\/_.])wan\d|video|(^|[-\/_.])veo([-\/_.]|$)|voyage|audio|realtime|-live|live-|(^|[-\/_.])ocr([-\/_.]|$)|moderation|guard|classif|diarize|caption|(^|[-\/_.])flux|sdxl|diffusion|dall-?e|lyria|(^|[-\/_.])aqa([-\/_.]|$)|mamba/i;
const everAns = (k) => [bench[k], before[k], first[k]].some((r) => r && (r.s === "ok" || r.s === "empty"));
const okIds = new Map(); for (const row of snap.rows) for (const m of row.models) { const id = m.id.replace(/\[1m\]$/i, ""); if (bench[row.provider + "/" + id]?.s === "ok") { if (!okIds.has(row.provider)) okIds.set(row.provider, new Set()); okIds.get(row.provider).add(id.toLowerCase()); } }
const nz = (s) => s.toLowerCase().replace(/[._]/g, "-");
const hasOkSib = (p, id) => { const set = okIds.get(p); if (!set) return false; const base = id.toLowerCase().replace(/(:free|:thinking|-free|@eu|@us|-latest|:nitro|:floor)$/, ""); if (base !== id.toLowerCase() && set.has(base)) return true; const n = nz(id); for (const y of set) if (y !== id.toLowerCase() && nz(y) === n) return true; for (const y of set) if (y.endsWith("/" + id.toLowerCase())) return true; return false; };
// listing ids straight from the discovery files, normalised
const DISC = path.join(process.env.LOCALAPPDATA ?? "", "uw-keysync", "discovery"); const listed = new Map();
for (const f of fs.readdirSync(DISC)) { try { const j = J(path.join(DISC, f)); listed.set(j.provider, new Set((j.models ?? []).map((m) => String(m.id).toLowerCase().replace(/\[1m\]$/i, "").replace(/^models\//, "")))); } catch { /* skip */ } }
const isListed = (p, id) => !!listed.get(p)?.has(id.toLowerCase().replace(/\[1m\]$/i, "").replace(/^models\//, ""));
let cand = 0; const byP = {}; let catNamed = 0;
for (const row of snap.rows) for (const m of row.models) if (!(m.outputKind === "nontext" || m.routable === false) && m.provenance === "catalogue-only" && isListed(row.provider, m.id)) catNamed++;
for (const g of gone) {
  const text = g.rec.m ?? g.rec.p ?? "";
  if (g.prov !== "catalogue-only") continue;
  if (isListed(g.provider, g.id)) continue;
  if (/:batch|:ba/i.test(g.id)) continue;
  if (NOT_A_REMOVAL.test(text) || AMB.test(text)) continue;
  if (!EXPL.test(text)) continue;
  if (/^[a-z0-9_-]+: upstream request failed/i.test(text) || /bad response status|not found the model/i.test(text)) continue;
  if (NONCHAT_ID.test(g.id.replace(/\[1m\]$/i, ""))) continue;
  if (everAns(g.key)) continue;
  if (hasOkSib(g.provider, g.id.replace(/\[1m\]$/i, ""))) continue;
  cand++; byP[g.provider] = (byP[g.provider] || 0) + 1;
}
chk("removal candidates (independent rule, rev 2)", cand, D.proposal.removal.candidates);
chk("removal candidates by provider (independent)", Object.fromEntries(Object.entries(byP).sort()), Object.fromEntries(Object.entries(D.proposal.removal.candidatesByProvider).sort()));
chk("catalogue-only eligible routes named by the listing after normalisation", catNamed, D.listingAudit.namedAfterNormalisation);
chk("gone + catalogue-only", gone.filter((g) => g.prov === "catalogue-only").length, D.proposal.removal.catalogueOnlyGone);
chk("gone that ever answered in any bench file", gone.filter((g) => everAns(g.key)).length, 0);
{
  // [1m] routes with a bare sibling route, independent count
  const ids = new Set(); for (const row of snap.rows) for (const m of row.models) ids.add(row.provider + "/" + m.id);
  let m1 = 0, m1bare = 0; for (const row of snap.rows) for (const m of row.models) if (/\[1m\]$/i.test(m.id)) { m1++; if (ids.has(row.provider + "/" + m.id.replace(/\[1m\]$/i, ""))) m1bare++; }
  chk("[1m] routes / with a bare sibling route", [m1, m1bare], [D.m1.routes, D.m1.withBareSiblingRoute]);
  // :batch routes and how many answer ok
  let b = 0, bok = 0; for (const row of snap.rows) for (const m of row.models) if (/:batch/i.test(m.id) && !(m.outputKind === "nontext")) { b++; if (bench[row.provider + "/" + m.id.replace(/\[1m\]$/i, "")]?.s === "ok") bok++; }
  chk(":batch routes / ok", [b, bok], [D.nonchat.batchRoutesAll, D.nonchat.batchRoutesOk]);
  // snapshot benchFlags sets
  chk("snapshot benchFlags.dead set", snap.rows.filter((r) => r.benchFlags?.dead).map((r) => r.provider).sort(), [...D.benchFlags.snapDead].sort());
  chk("snapshot benchFlags.needsMoney set", snap.rows.filter((r) => r.benchFlags?.needsMoney).map((r) => r.provider).sort(), [...D.benchFlags.snapMoney].sort());
  // burst vs streamed split on keys (independent loop)
  let burst = 0, streamed = 0; for (const [k, r] of Object.entries(bench)) if (r.s === "ok" && Number.isFinite(r.t)) (r.d - r.t <= 50 ? burst++ : streamed++);
  chk("burst / streamed ok keys", [burst, streamed], [D.perf.burst.n, D.perf.streamed.n]);
  // fetch-failed time window share (independent)
  const lo = Date.parse("2026-09-29T13:10:00Z") / 1000, hi = Date.parse("2026-09-29T13:50:00Z") / 1000, start = Date.parse("2026-09-29T12:40:00Z") / 1000;
  let inN = 0, inF = 0, outN = 0, outF = 0; for (const r of Object.values(bench)) { if (r.a < start) continue; const w = r.a >= lo && r.a < hi; if (w) { inN++; if (r.m === "fetch failed") inF++; } else { outN++; if (r.m === "fetch failed") outF++; } }
  { const got = [inF, inN, outF, outN], want = [D.fetchFailed.insideWindowFF, D.fetchFailed.insideWindowRecords, D.fetchFailed.outsideWindowFF, D.fetchFailed.outsideWindowRecords]; const okk = got.every((x, i) => Math.abs(x - want[i]) <= 1); if (!okk) fails++; console.log(okk ? "PASS" : "FAIL", "fetch failed inside/outside 13:10-13:50Z (keys vs routes, tolerance 1 for the [1m] twin)", JSON.stringify(got), JSON.stringify(want)); }
}
// pay ranking (raw catalogue pay routes)
const payRank = Object.entries(byProv).map(([p, c]) => [p, c.pay || 0]).filter(([, n]) => n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
chk("top-8 pay providers", payRank, D.pay.byProvider.map((p) => [p.provider, p.pay]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8));
// perf medians via a different quantile method (nearest-rank; lib.mjs interpolates)
const oks = Object.values(bench).filter((r) => r.s === "ok" && Number.isFinite(r.t)).map((r) => r.t).sort((a, b) => a - b);
const nr = (arr, p) => arr[Math.max(0, Math.ceil(p * arr.length) - 1)];
console.log("INFO all-ok TTFT median nearest-rank", nr(oks, 0.5), "vs interpolated", D.perf.ttftMixedAll.median, "| n keys", oks.length, "(routes", D.perf.ttftMixedAll.n + ")");

// ---- redaction: no deliverable may contain a masked/real key fragment, a key-looking token or a URL
{
  const files = ["REPORT.md", "models.csv", "providers.csv", "data.json", "sweeps.json", "reconcile.json"].map((f) => path.join(H, ".uw/plans/bench-study", f));
  const pats = [[/[A-Za-z0-9]{6,}\*{3,}[A-Za-z0-9]{2,}/, "masked key fragment"], [/\bsk-[A-Za-z0-9_-]{8,}/, "sk- key"], [/https?:\/\//i, "URL"], [/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|io|net|org|dev|app|bond|co|cn|ru|xyz|cloud)\/\S+/i, "domain/path link"], [/\bBearer\s+[A-Za-z0-9._-]{12,}/i, "bearer token"]];
  for (const f of files) { const t = fs.readFileSync(f, "utf8"); for (const [re, what] of pats) { const m = t.match(re); chk(`redaction: ${path.basename(f)} has no ${what}`, m ? m[0].slice(0, 40) : null, null); } }
}

// ---- sweep comparison, independent recount (plain loops over the raw files; does not use sweeps.mjs)
{
  const SWJ = J(path.join(H, ".uw/plans/bench-study/sweeps.json"));
  const f1 = J(path.join(H, ".uw/state/bench.first-sweep.json")).models;
  const ks = Object.keys(bench);
  let skipToOk = 0, skipTotal = 0, errToGone = 0, errTotal = 0, ntTotal = 0, ntChanged = 0, okOkDiag = 0, skipPay = 0;
  for (const k of ks) {
    const a = f1[k], b = bench[k];
    if (a.s === "skip") { skipTotal++; if (b.s === "ok") skipToOk++; if (b.s === "pay") skipPay++; }
    if (a.s === "error") { errTotal++; if (b.s === "gone") errToGone++; }
    if (["ok", "empty", "pay", "auth", "gone"].includes(a.s)) { ntTotal++; if (a.s !== b.s || a.a !== b.a) ntChanged++; }
    if (a.s === "ok" && b.s === "ok") okOkDiag++;
  }
  chk("sweep1 skip rows", skipTotal, SWJ.skip.n);
  chk("sweep1 skip -> ok", skipToOk, SWJ.skip.ok);
  chk("sweep1 skip -> pay", skipPay, SWJ.skip.toFinal.pay);
  chk("sweep1 error rows", errTotal, SWJ.err.n);
  chk("sweep1 error -> gone", errToGone, SWJ.err.toFinal.gone);
  chk("non-transient sweep1 rows / changed at all", [ntTotal, ntChanged], [SWJ.nt.n, SWJ.nt.reprobed]);
  chk("ok -> ok diagonal", okOkDiag, SWJ.matrix.ok.ok);
  chk("ok sweep1 / final", [Object.values(f1).filter((r) => r.s === "ok").length, Object.values(bench).filter((r) => r.s === "ok").length], [SWJ.dist.first.ok, SWJ.dist.final.ok]);
  const newer = ks.filter((k) => bench[k].a >= Date.parse("2026-09-29T12:40:00Z") / 1000).length;
  chk("keys written by probe-all run (a >= 12:40Z)", newer, SWJ.run3.changed);
}
console.log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed");
process.exitCode = fails ? 1 : 0;

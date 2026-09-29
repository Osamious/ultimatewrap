// Reconciles remove-candidate sets: revision 1 (467, from prev/rev1-remove-candidates.json), the critic's independent rule (454,
// re-implemented from review/t6.mjs, whose output set was not saved: review/rem.json is a copy of the 467), and the current build.
// READ-ONLY. Writes reconcile.json.
import fs from "node:fs"; import path from "node:path";
import { load, bench, readJson, H, OUT, strip, redact } from "./lib.mjs";
const before = readJson(path.join(H, ".uw/state/bench.before-probe-all.json")).models, first = readJson(path.join(H, ".uw/state/bench.first-sweep.json")).models;
const rows = load().filter((r) => r.eligible);
const txt = (r) => r.rec.m || r.rec.p || "";
const explicit = /not exist|not found|no endpoints|invalid model|not a valid|unsupported model|unknown model|was removed|end of life|deprecat|decommission|archived|models\/|no longer/i;
const ambiguous = /not have access/i, nonchat = /not a chat model|chat\/completions|cannot be used with the chat/i;
const norm = (id) => strip(id).split("/").pop().replace(/[:@].*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
const okBy = new Set(); for (const r of rows) if (r.rec.s === "ok" || r.rec.s === "empty") okBy.add(r.provider + "|" + norm(r.id));
const everOk = (k) => [bench[k], first[k], before[k]].some((x) => x && ["ok", "empty"].includes(x.s));
const criticSet = new Set(rows.filter((r) => r.rec.s === "gone" && r.prov === "catalogue-only" && explicit.test(txt(r)) && !ambiguous.test(txt(r)) && !nonchat.test(txt(r)) && !/:batch/i.test(r.id) && !/:ba/.test(txt(r))
  && !okBy.has(r.provider + "|" + norm(r.id)) && !everOk(r.key)).map((r) => `${r.provider}/${r.id}`));
const rev1 = new Set(JSON.parse(fs.readFileSync(path.join(OUT, "prev/rev1-remove-candidates.json"), "utf8")));
const data = JSON.parse(fs.readFileSync(path.join(OUT, "data.json"), "utf8"));
// current build's candidates, read back from models.csv (column proposed_action starts with REMOVE)
function parseCsvLine(line) { const o = []; let cur = "", q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; } else if (c === '"') q = true; else if (c === ",") { o.push(cur); cur = ""; } else cur += c; } o.push(cur); return o; }
const now = new Set(fs.readFileSync(path.join(OUT, "models.csv"), "utf8").split(String.fromCharCode(10)).slice(1).filter(Boolean).map(parseCsvLine).filter((c) => /^REMOVE candidate/.test(c[20] ?? "")).map((c) => c[0] + "/" + c[1]));
const byP = (ks) => { const o = {}; for (const k of ks) { const p = k.slice(0, k.indexOf("/")); o[p] = (o[p] || 0) + 1; } return o; };
const diff = (A, B) => [...A].filter((k) => !B.has(k));
const byKey = new Map(rows.map((r) => [`${r.provider}/${r.id}`, r]));
const text = (k) => (byKey.get(k) ? redact(txt(byKey.get(k))).replace(/[(]?request[_ ]id: ?[A-Za-z0-9-]*/gi, "").slice(0, 60) : "");
const out = {
  rev1: rev1.size, critic: criticSet.size, nowFromBuild: data.proposal.removal.candidates,
  rev1NotCritic: diff(rev1, criticSet).length, rev1NotCriticByProvider: byP(diff(rev1, criticSet)), rev1NotCriticRows: diff(rev1, criticSet).map((k) => `${k} | ${text(k)}`),
  now: now.size, nowNotCritic: diff(now, criticSet).length, nowNotCriticByProvider: byP(diff(now, criticSet)), nowNotCriticRows: diff(now, criticSet).map((k) => `${k} | ${text(k)}`),
  criticNotNow: diff(criticSet, now).length, criticNotNowByProvider: byP(diff(criticSet, now)),
  criticNotRev1: diff(criticSet, rev1).length, criticNotRev1ByProvider: byP(diff(criticSet, rev1)), criticNotRev1Rows: diff(criticSet, rev1).map((k) => `${k} | ${text(k)}`),
};
fs.writeFileSync(path.join(OUT, "reconcile.json"), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, rev1NotCriticRows: out.rev1NotCriticRows.length, criticNotRev1Rows: out.criticNotRev1Rows.length }));
console.log(out.rev1NotCriticRows.join("\n")); console.log("---"); console.log(out.criticNotRev1Rows.join("\n"));

import { load } from "../lib.mjs";
const rows = load().filter((r) => r.eligible && r.rec && r.rec.s !== "ok");
const cur = rows.filter((r) => !r.legacy && r.rec.m), leg = rows.filter((r) => r.legacy);
console.log("nonlegacy w/ m", cur.length, "legacy", leg.length);
// does p == m.slice(0,40)?
let eq = 0, neq = 0; const ex = [];
for (const r of cur) { const p = r.rec.p ?? "", m = r.rec.m; if (m.startsWith(p) || m.startsWith(p.replace(/…$/, ""))) eq++; else { neq++; if (ex.length < 8) ex.push([p, m.slice(0, 60)]); } }
console.log({ eq, neq }, ex);
// legacy: xref
const idx = cur.map((r) => ({ s: r.rec.s, m: r.rec.m, prov: r.provider }));
let matched = 0, agree = 0, disagree = 0, none = 0; const dis = {};
for (const r of leg) {
  const p = r.rec.p ?? ""; if (!p) { none++; continue; }
  const hits = idx.filter((x) => x.prov === r.provider && x.m.startsWith(p));
  if (!hits.length) { none++; continue; }
  matched++;
  const sts = new Set(hits.map((h) => h.s));
  if (sts.has(r.rec.s) && sts.size === 1) agree++; else { disagree++; const k = `${r.provider} old=${r.rec.s} now=${[...sts]} p=${p}`; dis[k] = (dis[k] || 0) + 1; }
}
console.log({ matched, agree, disagree, none });
for (const [k, n] of Object.entries(dis).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(n, k);
const st = {}; for (const r of leg) st[r.rec.s] = (st[r.rec.s] || 0) + 1; console.log("legacy nonok by status", st);

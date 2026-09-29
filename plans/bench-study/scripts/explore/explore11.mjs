import { load, loadDiscovery } from "../lib.mjs";
const rows = load().filter((r) => r.eligible); const d = loadDiscovery();
const nv = rows.filter((r) => r.provider === "nvidia");
const st = {}; for (const r of nv) { const k = r.rec.s + "/" + r.prov; st[k] = (st[k] || 0) + 1; } console.log("nvidia", nv.length, st);
console.log("listing sample", [...d.get("nvidia").ids].slice(0, 12));
console.log("nvidia gone sample", nv.filter((r) => r.rec.s === "gone").slice(0, 12).map((r) => r.id));
console.log("nvidia ok", nv.filter((r) => r.rec.s === "ok").map((r) => r.id));
const listIds = [...d.get("nvidia").ids];
const gone = nv.filter((r) => r.rec.s === "gone"); let sib = 0;
for (const r of gone) { const y = listIds.filter((l) => l.toLowerCase().endsWith("/" + r.id.toLowerCase())); if (y.length) sib++; }
console.log("nvidia gone with org/ sibling in listing", sib, "of", gone.length);
// provenance overview all
const pv = {}; for (const r of rows) { const k = r.rec.s + "|" + r.prov; pv[k] = (pv[k] || 0) + 1; } 
const tab = {}; for (const [k, n] of Object.entries(pv)) { const [s, p] = k.split("|"); (tab[s] ??= {})[p] = n; } console.table(tab);

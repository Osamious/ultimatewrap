import { load } from "../lib.mjs"; import { cluster, textOf } from "../clusters.mjs";
const rows = load().filter((r) => r.eligible && r.rec && r.rec.s !== "ok");
const g = {};
for (const r of rows) { const c = cluster(r.rec.s, textOf(r.rec)); const norm = (r.provider + ": " + textOf(r.rec).replace(/\d+/g, "#")).slice(0, 110); (g[c] ??= new Map()).set(norm, (g[c].get(norm) || 0) + 1); }
const pat = process.argv[2] ?? "";
for (const [c, mp] of Object.entries(g).sort()) { if (pat && !c.includes(pat)) continue; console.log("==", c); for (const [m, n] of [...mp].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] || 5))) console.log("   ", n, m); }

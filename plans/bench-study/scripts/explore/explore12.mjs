import { load, iso } from "../lib.mjs";
const rows = load().filter((r) => r.eligible && !r.legacy);
const b = {};
for (const r of rows) { const t = iso(r.rec.a).slice(11, 15) + "0"; b[t] ??= { n: 0, ff: 0 }; b[t].n++; if (r.rec.m === "fetch failed") b[t].ff++; }
for (const [t, v] of Object.entries(b).sort()) console.log(t, v.n, v.ff, "#".repeat(Math.round(v.ff / 2)));

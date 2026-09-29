import { load } from "../lib.mjs"; import { cluster, textOf } from "../clusters.mjs";
const rows = load().filter((r) => r.eligible && r.rec && r.rec.s !== "ok");
const tot = {}, ex = {};
for (const r of rows) { const c = cluster(r.rec.s, textOf(r.rec)); tot[c] = (tot[c] || 0) + 1; (ex[c] ??= []).push(r.provider + ": " + textOf(r.rec).slice(0, 70)); }
for (const [c, n] of Object.entries(tot).sort()) console.log(String(n).padStart(5), c);
const which = process.argv[2]; if (which) { const seen = new Map(); for (const e of ex[which] ?? []) seen.set(e, (seen.get(e) || 0) + 1); for (const [e, n] of [...seen].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log("   ", n, e); }

import { load } from "../lib.mjs";
const rows = load().filter((r) => r.eligible && r.rec && r.rec.s !== "ok");
const re = new RegExp(process.argv[2], "i"); const st = process.argv[3];
const seen = new Set();
for (const r of rows) { if (st && r.rec.s !== st) continue; const t = r.rec.m ?? r.rec.p; if (!re.test(r.provider + ": " + t)) continue; const k = r.provider + t.replace(/\d+/g, "#"); if (seen.has(k)) continue; seen.add(k); if (seen.size > +(process.argv[4] || 12)) break; console.log(r.rec.s, r.key, "|", t); }

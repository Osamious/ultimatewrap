import { load } from "../lib.mjs";
const rows = load().filter((r) => r.eligible && r.rec);
const norm = (s) => String(s ?? "").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>").replace(/\d+/g, "#").slice(0, 90);
const by = {};
for (const r of rows) { if (r.rec.s === "ok") continue; const k = r.rec.s; by[k] ??= new Map(); const msg = norm(r.rec.m ?? ("P:" + r.rec.p)); by[k].set(msg, (by[k].get(msg) || 0) + 1); }
const which = process.argv[2];
for (const [s, mp] of Object.entries(by)) { if (which && s !== which) continue; console.log("=====", s, [...mp.values()].reduce((a, b) => a + b, 0), "distinct", mp.size); for (const [m, n] of [...mp].sort((a, b) => b[1] - a[1]).slice(0, +(process.argv[3] || 40))) console.log(String(n).padStart(5), m); }

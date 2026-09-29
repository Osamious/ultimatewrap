import fs from "node:fs";
const L = fs.readFileSync("plans/bench-study/models.csv", "utf8").split("\n");
import { load } from "../lib.mjs";
const rows = load().filter((r) => r.eligible && r.rec.s !== "ok");
import { cluster, textOf } from "../clusters.mjs";
const want = process.argv[2], st = process.argv[3];
const seen = new Map();
for (const r of rows) { if (r.rec.s !== st) continue; const t = textOf(r.rec); if (!new RegExp(want, "i").test(t)) continue; const k = r.provider + "|" + t.replace(/[0-9a-z]{8,}/gi, "#").replace(/\d+/g, "#").slice(0, 110); if (!seen.has(k)) seen.set(k, []); seen.get(k).push(r.key); }
for (const [k, v] of [...seen].sort((a, b) => b[1].length - a[1].length).slice(0, +(process.argv[4] || 40))) console.log(String(v.length).padStart(4), k, "|", v[0]);

import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const H = os.homedir();
const b = JSON.parse(fs.readFileSync(path.join(H, ".uw/state/bench.json"), "utf8")).models;
const hist = {};
for (const [k, r] of Object.entries(b)) {
  const h = new Date(r.a * 1000).toISOString().slice(0, 13);
  hist[h] ??= { n: 0, withM: 0, nonok: 0, byS: {} };
  hist[h].n++; if (r.m) hist[h].withM++; if (r.s !== "ok") hist[h].nonok++;
  hist[h].byS[r.s] = (hist[h].byS[r.s] || 0) + 1;
}
for (const [h, v] of Object.entries(hist).sort()) console.log(h, v.n, "withM", v.withM, "nonok", v.nonok, JSON.stringify(v.byS));

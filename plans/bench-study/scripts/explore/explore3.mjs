import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const H = os.homedir();
const rd = (f) => JSON.parse(fs.readFileSync(path.join(H, ".uw/state", f), "utf8"));
const cur = rd("bench.json"), before = rd("bench.before-probe-all.json"), first = rd("bench.first-sweep.json");
console.log("gen", cur.generatedAt, before.generatedAt, first.generatedAt);
for (const [n, o] of [["before", before], ["first", first]]) {
  let same = 0, diff = 0, missing = 0;
  for (const [k, r] of Object.entries(cur.models)) {
    const p = o.models[k];
    if (!p) { missing++; continue; }
    (p.a === r.a && p.s === r.s ? same++ : diff++);
  }
  const dist = {}; for (const r of Object.values(o.models)) dist[r.s] = (dist[r.s] || 0) + 1;
  console.log(n, Object.keys(o.models).length, { same, diff, missing }, JSON.stringify(dist));
}
// records untouched since 'before' by age
const stale = Object.entries(cur.models).filter(([k, r]) => before.models[k] && before.models[k].a === r.a);
const lastA = Math.max(...stale.map(([, r]) => r.a)); console.log("untouched", stale.length, "last a", new Date(lastA * 1000).toISOString());
const changed = Object.entries(cur.models).filter(([k, r]) => !before.models[k] || before.models[k].a !== r.a);
console.log("changed", changed.length, "min a", new Date(Math.min(...changed.map(([, r]) => r.a)) * 1000).toISOString());
const dist = {}; for (const [, r] of stale) dist[r.s] = (dist[r.s] || 0) + 1; console.log("untouched by status", JSON.stringify(dist));
const dist2 = {}; for (const [, r] of changed) dist2[r.s] = (dist2[r.s] || 0) + 1; console.log("changed by status", JSON.stringify(dist2));
// before dist skip?
const skips = Object.entries(before.models).filter(([, r]) => r.s === "skip"); console.log("before skip", skips.length);
// records in 'before' with s in TRANSIENT and untouched?
const trans = stale.filter(([, r]) => ["rate","timeout","error","skip"].includes(r.s)); console.log("untouched transient", trans.length);

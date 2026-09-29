import { load, loadDiscovery, snap } from "../lib.mjs";
const d = loadDiscovery();
console.log("discovery providers", d.size);
for (const [p, v] of d) console.log(p.padEnd(18), v.at?.slice(0, 16), "resp", v.responded, "st", v.status, "out", v.outcome, "count", v.count, "ids", v.ids.size, "trunc", v.truncated, "rej", Array.isArray(v.rejected) ? v.rejected.length : v.rejected);

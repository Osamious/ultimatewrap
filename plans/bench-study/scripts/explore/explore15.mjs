import { load, loadDiscovery, strip } from "../lib.mjs";
const rows = load().filter((r) => r.eligible); const d = loadDiscovery();
const norm1 = (s) => strip(s).toLowerCase().replace(/^models\//, "");
const res = {};
for (const r of rows) {
  const dd = d.get(r.provider); if (!dd) continue;
  const ids = dd.ids; const nids = new Set([...ids].map(norm1));
  const exact = ids.has(strip(r.id));
  const n1 = nids.has(norm1(r.id));
  const org = [...nids].some((x) => x.endsWith("/" + norm1(r.id)));
  const bare = norm1(r.id).includes("/") && nids.has(norm1(r.id).split("/").pop());
  if (r.prov === "catalogue-only") {
    const o = (res[r.provider] ??= { cat: 0, exact: 0, norm: 0, orgSibling: 0, bareSibling: 0 });
    o.cat++; if (exact) o.exact++; if (n1) o.norm++; if (org) o.orgSibling++; if (bare) o.bareSibling++;
  }
}
const t = { cat: 0, exact: 0, norm: 0, orgSibling: 0, bareSibling: 0 };
for (const [p, o] of Object.entries(res)) { for (const k in t) t[k] += o[k]; if (o.norm || o.orgSibling || o.bareSibling) console.log(p, JSON.stringify(o)); }
console.log("TOTAL catalogue-only eligible routes", JSON.stringify(t));
const m1 = load().filter((r) => r.m1); const bareRoute = new Set(load().map((r) => r.provider + "/" + r.id));
console.log("[1m] routes", m1.length, "with bare route sibling", m1.filter((r) => bareRoute.has(r.provider + "/" + strip(r.id))).length);

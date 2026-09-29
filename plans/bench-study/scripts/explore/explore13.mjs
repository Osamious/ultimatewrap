import { load } from "../lib.mjs";
const ok = load().filter((r) => r.eligible && r.rec.s === "ok");
for (const [n, f] of [["legacy", (r) => r.legacy], ["current", (r) => !r.legacy]]) {
  const s = ok.filter(f); const nul = s.filter((r) => !Number.isFinite(r.rec.r)); const big = nul.filter((r) => r.rec.o >= 8);
  console.log(n, s.length, "tps null", nul.length, "of which o>=8", big.length, "o<8", nul.length - big.length, "o dist(null,o>=8) d-t median", big.map((r) => r.rec.d - r.rec.t).sort((a, b) => a - b)[Math.floor(big.length / 2)]);
}
const s = ok.filter((r) => Number.isFinite(r.rec.r)); console.log("with tps: d-t median", s.map((r) => r.rec.d - r.rec.t).sort((a, b) => a - b)[Math.floor(s.length / 2)]);
const dt = ok.map((r) => r.rec.d - r.rec.t); console.log("d==t count", dt.filter((x) => x <= 50).length, "of", ok.length);
const o = ok.map((r) => r.rec.o).sort((a, b) => a - b); console.log("o quantiles", o[0], o[Math.floor(o.length * 0.1)], o[Math.floor(o.length / 2)], o[Math.floor(o.length * 0.9)], o.at(-1), "o>=96", o.filter((x) => x >= 96).length);

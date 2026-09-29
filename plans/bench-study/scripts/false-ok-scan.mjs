// READ-ONLY scan of ~/.uw/state/bench.json for `ok` records whose preview does not look like an answer to
// "Say hello in 5 words." but like an error, notice or account message delivered as stream content
// (HTTP 200). Nothing is written. Usage: node plans/bench-study/scripts/false-ok-scan.mjs [bench.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = process.argv[2] ?? path.join(os.homedir(), ".uw", "state", "bench.json");
const bench = JSON.parse(fs.readFileSync(file, "utf8")).models;

const PATTERNS = {
  "api key": /api[ _-]?key/i, account: /\baccount\b/i, credit: /\bcredits?\b/i, quota: /\bquota\b/i, balance: /\bbalance\b/i,
  unauthorized: /unauthori[sz]ed|forbidden|not authori[sz]ed/i, subscribe: /subscri(?:be|ption)|upgrade|\bplan\b/i,
  "rate limit": /rate.?limit|too many requests/i, error: /\berror\b|\bfailed\b|exception/i,
  "not available": /not available|unavailable|not supported|no longer/i, "sorry-cant": /(?:sorry|apologi[sz]e)[^.]{0,30}(?:can(?:no|')t|unable)/i,
  "model not found": /model.{0,20}not found|does not exist/i, token: /\btokens?\b/i, blocked: /blocked|banned|suspended|denied/i,
};
const HELLO = /^(?:hello|hi|hey|greetings|good (?:morning|day|evening)|howdy|yo|salut|hola|bonjour)\b/i;

const oks = Object.entries(bench).filter(([, v]) => v.s === "ok");
const flagged = [];
for (const [key, v] of oks) {
  const p = String(v.p ?? "");
  const hits = Object.entries(PATTERNS).filter(([, re]) => re.test(p)).map(([n]) => n);
  if (hits.length) flagged.push({ key, provider: key.split("/")[0], p, o: v.o ?? null, k: v.k ?? 0, hits, hello: HELLO.test(p) });
}
const byPreview = new Map();
for (const f of flagged) {
  const e = byPreview.get(f.p) ?? { p: f.p, n: 0, providers: new Set(), ex: [], os: [] };
  e.n += 1; e.providers.add(f.provider); if (e.ex.length < 3) e.ex.push(f.key); e.os.push(f.o); byPreview.set(f.p, e);
}
const repeated = new Map();
for (const [key, v] of oks) { const k = `${key.split("/")[0]}\u0000${v.p ?? ""}`; repeated.set(k, (repeated.get(k) ?? 0) + 1); }

console.log(`ok records: ${oks.length}; preview matches at least one error-ish pattern: ${flagged.length}`);
const perProv = {};
for (const f of flagged) perProv[f.provider] = (perProv[f.provider] ?? 0) + 1;
console.log("per provider:", JSON.stringify(Object.fromEntries(Object.entries(perProv).sort((a, b) => b[1] - a[1]))));
console.log("\ndistinct flagged previews (count, providers, tokens seen, 3 example ids):");
for (const e of [...byPreview.values()].sort((a, b) => b.n - a.n).slice(0, 60)) {
  const os = [...new Set(e.os)].sort((a, b) => a - b);
  console.log(`  x${e.n}  [${[...e.providers].join(",")}]  o=${os.slice(0, 6).join("/")}  ${JSON.stringify(e.p)}  e.g. ${e.ex.join(", ")}`);
}
console.log("\nsame preview repeated across >= 5 models of one provider:");
for (const [k, n] of [...repeated].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  const [prov, p] = k.split("\u0000"); console.log(`  x${n}  ${prov}  ${JSON.stringify(p)}`);
}
const tiny = oks.filter(([, v]) => Number.isFinite(v.o) && v.o <= 3 && String(v.p ?? "").length >= 30);
console.log(`\nlong preview (>=30 chars) from a tiny output (<=3 tokens): ${tiny.length}`, tiny.slice(0, 5).map(([k, v]) => `${k} o=${v.o} ${JSON.stringify(v.p)}`));
const noHello = oks.filter(([, v]) => !v.k && !HELLO.test(String(v.p ?? "")) && Object.values(PATTERNS).some((re) => re.test(String(v.p ?? ""))));
console.log(`\nflagged AND not a greeting AND not thinking-text: ${noHello.length}`);

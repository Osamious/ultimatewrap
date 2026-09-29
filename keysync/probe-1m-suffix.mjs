// Which providers tolerate a `[1m]`-suffixed model id?
//
// WHY THIS IS A PROVIDER FACT, NOT A MODEL FACT. The relay strips `[1m]` at its
// own last hop; CCR does NOT -- MEASURED, an upstream 404 echoes it back
// verbatim (`Model "groq/llama-3.3-70b-versatile[1m]" is not configured`). So
// the suffix reaches the provider's own id parser, and a provider either
// normalises it away or fails to find the id. That is one property of one
// parser, so ANY model this provider actually serves answers the question --
// which is what lets a provider with no credit for Claude still be measured on
// a free model it does serve.
//
// THE CONTROL IS THE WHOLE DESIGN. A provider that is out of credit,
// unauthenticated or off-plan fails the suffixed request for a reason that has
// nothing to do with the suffix. So each candidate is probed BARE first, and
// only a model that answers bare is allowed to decide the verdict. Without
// that, "rejects" and "broke" are the same string, and the tagging rule would
// read a billing failure as a measurement.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";

const s = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".claude", "settings.json"), "utf8").replace(/^\uFEFF/, ""));
const key = execFileSync(s.apiKeyHelper.replace(/^"|"$/g, ""), { encoding: "utf8", shell: true }).trim();
const gw = s.env.ANTHROPIC_BASE_URL;
const snap = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".uw", "catalog", "snapshot.json"), "utf8"));

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const MAX_CANDIDATES = Number(process.env.UW_PROBE_CANDIDATES ?? 5);
const FREEISH = new Set(["FREE", "FREE?"]);

// ORDERED BY WHAT IS MOST LIKELY TO ANSWER, THEN BY WHAT IS CHEAPEST TO SPEND.
// Free-first alone was measured to waste the whole budget: it led with
// `inkling-small:free` and `ling-3.0-flash-free`, ids the provider does not
// actually serve, and the run reported `unknown` for a provider that was never
// really asked. A model the provider's OWN listing named is the one most likely
// to exist, so provenance leads and price breaks the tie inside a rung.
const PROV_RANK = { "call-verified": 0, "listing-verified": 1, "config-asserted": 2 };
const rank = (m) => PROV_RANK[m.provenance] ?? 3;
const candidatesFor = (row) => row.models
  .filter((m) => m.routable === true && m.mode !== true)
  // `:batch` is a different endpoint and would answer a different question.
  .filter((m) => !/:batch$/i.test(String(m.id)))
  // An id that already ends in the suffix cannot test whether adding one is
  // tolerated -- teamorouter really does serve a model called `kimi-k3[1M]`.
  .filter((m) => !/\[1m\]$/i.test(String(m.id)))
  // `auto` and friends route to a pool rather than a model, and answer about
  // the pool's capacity instead of the provider's id parser.
  .filter((m) => !/^(auto|router|default)$/i.test(String(m.id)))
  .sort((a, b) => rank(a) - rank(b)
    || (FREEISH.has(b.badge) ? 1 : 0) - (FREEISH.has(a.badge) ? 1 : 0))
  .slice(0, MAX_CANDIDATES)
  .map((m) => m.id);

const post = async (model) => {
  try {
    const res = await fetch(`${gw}/v1/messages`, { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });
    const txt = await res.text();
    if (res.ok) return { ok: true, msg: "" };
    let m = txt.slice(0, 200);
    try { const j = JSON.parse(txt); const a = j?.error?.attempts?.[0];
      m = String(a?.details?.error?.message ?? a?.details?.message ?? j?.error?.message ?? m); } catch {}
    return { ok: false, msg: m.slice(0, 130) };
  } catch (e) { return { ok: false, msg: String(e.message).slice(0, 90) }; }
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = snap.rows.filter((r) => r.provider !== "anthropic")
  .filter((r) => !only.length || only.includes(r.provider));
console.log(`probing ${rows.length} provider(s), up to ${MAX_CANDIDATES} candidate(s) each\n`);

const prev = (() => { try {
  return JSON.parse(fs.readFileSync(path.join(os.homedir(), ".uw", "state", "onem-suffix-probe.json"), "utf8")).verdicts ?? {};
} catch { return {}; } })();

const verdicts = { ...prev };
for (const row of rows) {
  let answered = null, lastWhy = "no routable candidate";
  for (const id of candidatesFor(row)) {
    const bare = await post(`${row.provider}/${id}`);
    await pause(350);
    if (bare.ok) { answered = id; break; }
    lastWhy = bare.msg;
  }
  if (!answered) {
    // AN `unknown` NEVER CLOBBERS A MEASUREMENT. This run asked a different
    // candidate than the last one -- free-first ordering picks whatever is
    // cheapest today -- so a provider measured `accepts` last week can hit a
    // per-model balance rule this week and answer nothing. Overwriting the
    // earlier verdict would trade evidence for its absence, which is the one
    // direction this file is not allowed to move in. A real verdict
    // (accepts/rejects) still overwrites: that is a new measurement, and a
    // provider is free to change its parser.
    const kept = prev[row.provider];
    if (kept && kept.verdict !== "unknown") {
      console.log(`kept     ${row.provider.padEnd(14)} nothing answered bare this run; ` +
        `keeping measured "${kept.verdict}"`);
      continue;
    }
    verdicts[row.provider] = { verdict: "unknown", id: null, why: lastWhy };
    console.log(`unknown  ${row.provider.padEnd(14)} nothing answered bare: ${lastWhy.slice(0, 70)}`);
    continue;
  }
  const one = await post(`${row.provider}/${answered}[1m]`);
  let verdict = one.ok ? "accepts" : "rejects", why = one.msg;
  if (!one.ok) {
    // THE SECOND CONTROL, and the first run needed it. A suffixed request can
    // fail for a reason the suffix had nothing to do with: `agnes` answered
    // bare and then returned "You've reached the API rate limit for free
    // users" -- a rate limit recorded as a parser refusal, and `rejects` is
    // honoured absolutely, so a false one silences a provider's rows for good.
    //
    // Re-ask BARE. Still working means the suffix really is the only
    // difference; failing too means the window moved under both and this run
    // measured nothing.
    await pause(1200);
    const again = await post(`${row.provider}/${answered}`);
    if (!again.ok) {
      verdict = "unknown";
      why = `suffixed failed (${one.msg.slice(0, 60)}) but bare stopped working too (${again.msg.slice(0, 60)})`;
    }
  }
  const kept = prev[row.provider];
  if (verdict === "unknown" && kept && kept.verdict !== "unknown") {
    console.log(`kept     ${row.provider.padEnd(14)} inconclusive this run; keeping measured "${kept.verdict}"`);
    await pause(500);
    continue;
  }
  verdicts[row.provider] = { verdict, id: answered, why };
  console.log(`${verdict.padEnd(8)} ${row.provider.padEnd(14)} ${answered}${one.ok ? "" : "   " + why.slice(0, 80)}`);
  await pause(500);
}

const out = path.join(os.homedir(), ".uw", "state", "onem-suffix-probe.json");
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), verdicts }, null, 2));
const n = (v) => Object.values(verdicts).filter((x) => x.verdict === v).length;
console.log(`\naccepts ${n("accepts")} / rejects ${n("rejects")} / unknown ${n("unknown")}  -> ${out}`);

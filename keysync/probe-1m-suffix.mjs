// Which resellers accept a `[1m]`-suffixed Claude id?
//
// CCR does NOT strip the suffix -- MEASURED: an upstream 404 echoes it back
// verbatim ("Model \"groq/...[1m]\" is not configured"). So a reseller either
// tolerates it or 404s on it, and which one is a per-provider FACT that has to
// be measured. Tagging a row whose provider has not answered to this would turn
// a working row into a dead one, which is strictly worse than a 200k window.
//
// Bare is probed alongside as the control: a provider that is simply down, out
// of credit or unauthenticated must not be recorded as "rejects the suffix".
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { execFileSync } from "node:child_process";

const s = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".claude", "settings.json"), "utf8").replace(/^\uFEFF/, ""));
const key = execFileSync(s.apiKeyHelper.replace(/^"|"$/g, ""), { encoding: "utf8", shell: true }).trim();
const gw = s.env.ANTHROPIC_BASE_URL;
const snap = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".uw", "catalog", "snapshot.json"), "utf8"));

const ONE_M = 1_000_000;
// One representative row per provider: the cheapest question that still answers
// it, since the suffix is handled by the provider's id parser rather than by any
// one model.
const pick = new Map();
for (const r of snap.rows) {
  if (r.provider === "anthropic") continue;
  for (const m of r.models) {
    if (!/claude/i.test(m.id) || m.routable !== true) continue;
    if (!(Number.isFinite(m.ctx) && m.ctx >= ONE_M)) continue;
    // Skip decorated ids: `:batch` is a different endpoint and `~` is a
    // free-tier tail marker, neither of which represents the normal row.
    if (/[:~]/.test(m.id)) continue;
    if (!pick.has(r.provider)) pick.set(r.provider, m.id);
  }
}

const post = async (model) => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${gw}/v1/messages`, { method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }) });
    const txt = await res.text();
    if (res.ok) return { ok: true, ms: Date.now() - t0, msg: "" };
    let m = txt.slice(0, 200);
    try { const j = JSON.parse(txt); const a = j?.error?.attempts?.[0];
      m = String(a?.details?.error?.message ?? a?.details?.message ?? j?.error?.message ?? m); } catch {}
    return { ok: false, ms: Date.now() - t0, msg: m.slice(0, 130) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, msg: String(e.message).slice(0, 90) }; }
};

console.log(`probing ${pick.size} reseller(s) for [1m] tolerance\n`);
const verdicts = {};
for (const [provider, id] of pick) {
  const target = `${provider}/${id}`;
  const bare = await post(target);
  await new Promise((r) => setTimeout(r, 500));
  const one = await post(`${target}[1m]`);
  // Three outcomes, and the third is why bare is probed at all.
  const verdict = one.ok ? "accepts"
    : bare.ok ? "rejects"
    : "unknown";
  verdicts[provider] = { verdict, id, bare: bare.ok, suffix: one.ok, why: one.msg || bare.msg };
  console.log(`${verdict.padEnd(8)} ${provider.padEnd(14)} ${id}`);
  console.log(`         bare ${bare.ok ? "OK" : "FAIL " + bare.msg.slice(0, 80)}`);
  console.log(`         [1m] ${one.ok ? "OK" : "FAIL " + one.msg.slice(0, 80)}`);
  await new Promise((r) => setTimeout(r, 700));
}

const out = path.join(os.homedir(), ".uw", "state", "onem-suffix-probe.json");
fs.writeFileSync(out, JSON.stringify({ at: Date.now(), verdicts }, null, 2));
const n = (v) => Object.values(verdicts).filter((x) => x.verdict === v).length;
console.log(`\naccepts ${n("accepts")} / rejects ${n("rejects")} / unknown ${n("unknown")}  -> ${out}`);

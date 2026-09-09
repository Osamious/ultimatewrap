// How many of the 153 rows #108 blocked actually work now?
// Samples the affected family and a control group that must not regress.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const settings = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".claude", "settings.json"), "utf8").replace(/^﻿/, ""));
const key = execFileSync(settings.apiKeyHelper.replace(/^"|"$/g, ""),
  { encoding: "utf8", shell: true }).trim();
const gateway = settings.env.ANTHROPIC_BASE_URL;

const openai = settings.modelPicker.options
  .map((r) => r.model).filter((m) => m.startsWith("openai/"));
const AFFECTED = /(^|[/:])(gpt-5|o1|o3|o4)/i;
const affected = openai.filter((m) => AFFECTED.test(m));
const control = openai.filter((m) => !AFFECTED.test(m));

// Deterministic spread rather than the first N, which would over-sample one
// naming family and flatter the result.
const pick = (arr, n) => Array.from({ length: Math.min(n, arr.length) },
  (_, i) => arr[Math.floor(i * arr.length / Math.min(n, arr.length))]);

const post = async (model) => {
  const t0 = Date.now();
  try {
    const res = await fetch(`${gateway}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // 4096, because these are reasoning models: at a small budget they spend
      // it all on internal reasoning and return no text, which reads as a
      // failure and is not one.
      body: JSON.stringify({ model, max_tokens: 4096,
        messages: [{ role: "user", content: "Reply with exactly: ROUTED" }] }),
    });
    const txt = await res.text();
    if (res.ok) return { ok: true, ms: Date.now() - t0, msg: "" };
    let msg = txt.slice(0, 120);
    try {
      const j = JSON.parse(txt);
      const a = j?.error?.attempts?.[0];
      msg = String(a?.details?.error?.message ?? a?.details?.message ?? j?.error?.message ?? msg);
    } catch { /* raw */ }
    return { ok: false, ms: Date.now() - t0, msg: msg.slice(0, 110) };
  } catch (e) { return { ok: false, ms: Date.now() - t0, msg: String(e.message).slice(0, 90) }; }
};

const run = async (label, models) => {
  console.log(`\n=== ${label} (${models.length} sampled) ===`);
  let ok = 0; const fails = [];
  for (const m of models) {
    const r = await post(m);
    if (r.ok) ok++; else fails.push([m, r.msg]);
    console.log(`  ${r.ok ? "OK  " : "FAIL"} ${String(r.ms).padStart(6)}ms  ${m}${r.ok ? "" : "  -- " + r.msg}`);
    await new Promise((s) => setTimeout(s, 700));
  }
  console.log(`  ${ok}/${models.length} routed`);
  return { ok, total: models.length, fails };
};

console.log(`openai rows: ${openai.length} total, ${affected.length} in the affected family, ${control.length} control`);
const a = await run("AFFECTED family (gpt-5 / o1 / o3 / o4)", pick(affected, 12));
const c = await run("CONTROL (must not regress)", pick(control, 6));

console.log(`\naffected: ${a.ok}/${a.total} routed  (was 0/${a.total} before the patch)`);
console.log(`control : ${c.ok}/${c.total} routed`);
if (a.fails.length) {
  console.log("\nremaining failures in the affected family, by reason:");
  const by = {};
  for (const [, msg] of a.fails) { const k = msg.slice(0, 60); by[k] = (by[k] || 0) + 1; }
  for (const [k, n] of Object.entries(by).sort((x, y) => y[1] - x[1])) console.log(`  ${n}x  ${k}`);
}
const stillParam = a.fails.filter(([, m]) => /max_tokens/.test(m)).length;
console.log(`\nrows still failing on the max_tokens parameter: ${stillParam} (the defect #108 names)`);

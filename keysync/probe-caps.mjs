// Probe every provider's FREE tier with a Claude-Code-sized request, and record
// what it does. Fills the `limit` field schema 4 added.
//
// IN keysync/, NOT menu/. It reads settings.json and talks to the gateway, and
// test/contracts.test.mjs forbids a menu module from knowing that layout -- only
// the two contract modules may. The vocabulary it classifies with stays in
// menu/payload-cap.mjs, which is pure and couples to nothing.
//
//   node keysync/probe-caps.mjs [--rows N] [--all] [--provider NAME] [--dry]
//
// SYNTHETIC PAYLOAD, NEVER A REPLAY. CCR's `request-log-bodies` holds real
// Claude Code requests at exactly the right size, and replaying one would be the
// easy implementation -- it would also ship the user's actual conversation, file
// contents and tool output to 45 third-party providers, several of which are
// free tiers with no confidentiality guarantee whatsoever. The payload below is
// built from filler to the same SIZE and SHAPE, which is the only property the
// question depends on.
//
// SIZE IS THE WHOLE POINT. `keysync/provider-sweep.mjs` sends 1KB and measures
// reachability; every capped free tier passes it and then fails in real use.
// MEASURED 2026-09-09: `orcarouter/deepseek/deepseek-v4-flash-free` answered a
// 1KB probe in 2.1s and refused a real 408KB request.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CC_MIN_BYTES, CC_TYPICAL_BYTES, verdictOf, aggregate, sizeCell } from "../menu/payload-cap.mjs";
import { SNAPSHOT_FILE } from "../menu/snapshot.mjs";

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? dflt) : dflt;
};
// Caps are provider-wide where they exist -- MEASURED 2026-09-09, three
// orcarouter free rows from three unrelated vendors returned the identical
// refusal -- so a handful of rows per provider is enough to find the answer AND
// to detect disagreement. Probing all 54 of aihubmix's free rows would cost 50
// requests to learn what 5 already say.
const PER_PROVIDER = argv.includes("--all") ? Infinity : Number(flag("--rows", 5));
const ONLY = flag("--provider", null);
const DRY = argv.includes("--dry");
const FORCE = argv.includes("--force");
const CONCURRENCY = 4;
const TIMEOUT_MS = 45000;
// Gap between consecutive requests to the SAME provider. Free tiers meter by the
// minute, and four 400KB requests fired back to back is what turned a clean
// 400-with-a-cap into 429s on the run that recorded them.
const PACE_MS = Number(flag("--pace", 4000));

const settings = JSON.parse(fs.readFileSync(
  path.join(os.homedir(), ".claude", "settings.json"), "utf8").replace(/^﻿/, ""));
const gateway = settings.env?.ANTHROPIC_BASE_URL;
if (!gateway) throw new Error("no ANTHROPIC_BASE_URL in settings.json");
const key = execFileSync(settings.apiKeyHelper.replace(/^"|"$/g, ""),
  { encoding: "utf8", shell: true }).trim();

// A request the size of Claude Code's smallest. Most of the bulk is tool
// schemas, because that is where it is in a real request: 144.1KB of 153.3KB.
function ccSizedBody(model, targetBytes = CC_TYPICAL_BYTES) {
  const tools = [];
  for (let i = 0; tools.length < 40; i++) {
    tools.push({
      name: `probe_tool_${i}`,
      description: `Probe tool ${i}. ` + "Describes an operation in the detail a real tool schema carries. ".repeat(24),
      input_schema: { type: "object", required: ["path"], properties: {
        path: { type: "string", description: "A filesystem path. ".repeat(12) },
        flag: { type: "boolean", description: "An optional switch. ".repeat(12) },
        mode: { type: "string", enum: ["read", "write", "append"], description: "How to open it. ".repeat(12) },
      } },
    });
  }
  const body = { model, max_tokens: 512, stream: false,
                 system: "You are a helpful assistant. " .repeat(40),
                 tools, messages: [{ role: "user", content: "Reply with exactly: OK" }] };
  // Pad to the real floor so the probe asks the question a user actually hits.
  const size = JSON.stringify(body).length;
  if (size < targetBytes) {
    body.system += "Context. ".repeat(Math.ceil((targetBytes - size) / 9));
  }
  return body;
}

async function post(model, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(`${gateway}/v1/messages`, {
      method: "POST", signal: controller.signal,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const txt = await res.text();
    if (res.ok) return { ok: true, status: 200, message: "", ms: Date.now() - started };
    let status = res.status, message = txt.slice(0, 200);
    try {
      const j = JSON.parse(txt);
      const a = j?.error?.attempts?.[0];
      status = a?.status ?? status;
      message = String(a?.details?.error?.message ?? a?.details?.message ?? a?.message ?? j?.error?.message ?? message);
    } catch { /* keep the raw slice */ }
    return { ok: false, status, message, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: e.name === "AbortError" ? 0 : -1,
             message: e.name === "AbortError" ? `no response in ${TIMEOUT_MS}ms` : String(e.message), ms: Date.now() - started };
  } finally { clearTimeout(timer); }
}

// Where exactly does a size refusal start? Only run for a provider that actually
// refused on size, and only ONCE per provider, since the cap is a tier-wide
// policy rather than a per-model one.
async function bisectCap(model) {
  const body = ccSizedBody(model);
  const filler = "Context. ";
  const base = { ...body, system: "You are a helpful assistant. " };
  const at = async (bytes) => {
    const b = { ...base, system: base.system + filler.repeat(Math.max(0, Math.ceil(bytes / 9))) };
    const size = JSON.stringify(b).length;
    const r = await post(model, b);
    return { ok: r.ok || verdictOf(r) !== "unusable", size };
  };
  let lo = 0, hi = CC_TYPICAL_BYTES, loSize = 0;
  const first = await at(lo);
  if (!first.ok) return null;         // refuses even an empty request: not a size cap
  loSize = first.size;
  for (let i = 0; i < 8 && hi - lo > 4096; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await at(mid);
    if (r.ok) { lo = mid; loSize = r.size; } else { hi = mid; }
  }
  return loSize;
}

const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8").replace(/^﻿/, ""));
const targets = snap.rows
  .filter((r) => !ONLY || r.provider === ONLY)
  .map((r) => ({ row: r, free: r.models.filter((m) => m.badge === "FREE?" || m.badge === "FREE") }))
  .filter((t) => t.free.length > 0);

const totalRows = targets.reduce((n, t) => n + Math.min(t.free.length, PER_PROVIDER), 0);
console.log(`${targets.length} provider(s) with free rows, probing up to ${PER_PROVIDER} row(s) each ` +
  `(~${totalRows} requests at ${sizeCell(CC_TYPICAL_BYTES)} each)`);
console.log(`gateway ${gateway}${DRY ? "  [DRY RUN -- nothing written]" : ""}\n`);

let cursor = 0;
const results = new Map();
async function worker() {
  while (cursor < targets.length) {
    const t = targets[cursor++];
    const provider = t.row.provider;
    const rows = t.free.slice(0, PER_PROVIDER);
    const perModel = new Map();
    for (const m of rows) {
      const target = `${provider}/${m.id}`;
      // PACED, because an unpaced sweep manufactures the 429s it then records.
      // Requests to ONE provider are already serial; this adds a gap between
      // them so a free tier's per-minute allowance is not spent by the probe
      // itself. Different providers still run concurrently, since a pause for
      // one is not a pause for another.
      if (perModel.size > 0) await new Promise((r2) => setTimeout(r2, PACE_MS));
      const r = await post(target, ccSizedBody(target));
      const v = verdictOf(r);
      perModel.set(m.id, { verdict: v, status: r.status, detail: String(r.message).slice(0, 200) });
      console.log(`  ${v.padEnd(9)} ${String(r.status).padStart(3)} ${String(r.ms).padStart(6)}ms  ${target}`);
    }
    // One bisect per provider, and only when something actually refused on size.
    let bytes = null;
    const sized = [...perModel.entries()].find(([, e]) => e.verdict === "unusable");
    if (sized) {
      bytes = await bisectCap(`${provider}/${sized[0]}`);
      console.log(`  ${"cap".padEnd(9)}     ${bytes ? sizeCell(bytes) : "(no cap found -- retracting `unusable`)"}  ${provider}`);
      // THE BISECT IS ALLOWED TO OVERRULE THE CLASSIFIER. A null result means the
      // row refused a request of every size including an empty one, which is not
      // what a size cap does -- so the `unusable` verdict was a text match on a
      // message that was about something else. Recording it anyway would publish
      // a permanent "this is capped" from a transient refusal, and the earlier
      // `mistral` 429 is exactly that case. Demoted to `rate`, the honest "we
      // learned nothing this run".
      if (!bytes) for (const [id, e] of perModel) if (e.verdict === "unusable") perModel.set(id, { ...e, verdict: "rate" });
    }
    const verdicts = [...perModel.values()].map((e) => e.verdict);
    results.set(provider, { perModel, bytes, agg: aggregate(verdicts) });
    console.log(`  => ${provider}: ${aggregate(verdicts)}${bytes ? ` (${sizeCell(bytes)})` : ""}\n`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const at = new Date().toISOString();
for (const row of snap.rows) {
  const res = results.get(row.provider);
  const free = row.models.filter((m) => m.badge === "FREE?" || m.badge === "FREE");
  if (!res) { row.limit = free.length === 0 ? { verdict: "none", bytes: null, at } : (row.limit ?? null); continue; }

  // A RATE-LIMITED RUN MUST NOT ERASE A GOOD MEASUREMENT. `rate` means the
  // provider refused to tell us anything, and a sweep that hammers a free tier
  // produces exactly that -- MEASURED 2026-09-09: orcarouter answered a clean
  // 400 with a 245KB cap on the first pass, then 429 on all four rows once this
  // prober had been run against it repeatedly, and the second result overwrote
  // the first. Keeping the older, more informative value is right in a way that
  // "newest wins" is not: the new reading is not a later observation of the same
  // fact, it is an absence of observation.
  // `--force` exists because the guard below protects whatever is already there,
  // INCLUDING a value written by an earlier, buggier classifier. MEASURED
  // 2026-09-09: `mistral` was recorded `unusable` by a run that read a 429 as a
  // size cap; after that bug was fixed the next run was rate limited, and the
  // guard faithfully preserved the wrong answer. Age is not trustworthiness.
  const prior = FORCE ? null : row.limit;
  if (res.agg === "rate" && prior && !["rate", "unknown"].includes(prior.verdict)) {
    console.log(`  keeping earlier ${prior.verdict}${prior.bytes ? ` (${sizeCell(prior.bytes)})` : ""} for ${row.provider} -- this run was rate limited`);
    continue;
  }
  row.limit = { verdict: res.agg, bytes: res.bytes ?? null, at };
  for (const m of row.models) {
    const e = res.perModel.get(m.id);
    // Only a row that was actually probed gets a verdict. An unprobed free row
    // keeps `null` and renders `?` -- inheriting the provider's answer would be
    // asserting a measurement nobody took.
    m.limit = e ? { verdict: e.verdict, bytes: e.verdict === "unusable" ? res.bytes ?? null : null, at }
      : (free.includes(m) ? null : { verdict: "none", bytes: null, at });
  }
}

const tally = {};
for (const r of snap.rows) { const v = r.limit?.verdict ?? "unknown"; tally[v] = (tally[v] || 0) + 1; }
console.log("provider verdicts:", JSON.stringify(tally));

if (DRY) { console.log("\nDRY RUN -- snapshot not written"); process.exit(0); }
fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap));
console.log(`\nwrote ${SNAPSHOT_FILE}`);

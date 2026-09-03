// Phase 5, Stage A — static invariants. Zero upstream requests, read-only.
//
// HARD GATE: if T1.1 or T1.4 fails, no later Phase 5 stage may run. Without an
// empty fallback chain every attribution assertion downstream is uninterpretable,
// and without a verified backup the destructive stage is how the two prior
// state-destruction incidents happened.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LIVE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");

const svc = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, "claude-code-router", "service.json"), "utf8"));
const url = new URL(svc.url);
const token = url.searchParams.get("ccr_web_token");
const rpc = async (method, args = []) => {
  const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
    body: JSON.stringify({ method, args })
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${String(j.error?.message).slice(0, 200)}`);
  return j.value;
};

const results = [];
const record = (id, name, ok, detail, gate = false) => {
  results.push({ id, name, ok, detail, gate });
  console.log(`${ok ? "PASS" : "FAIL"}  ${id}  ${name}`);
  if (detail) console.log(`        ${detail}`);
};

const cfg = await rpc("getConfig");
const settings = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8").replace(/^﻿/, ""));
const rows = settings.modelPicker?.options ?? [];

// ---- T1.1 no silent fallback can rescue a misroute -------------------------
{
  const fb = cfg.Router?.fallback ?? {};
  const chainEmpty = (fb.models ?? []).length === 0;
  // "retry" bypasses models[] entirely, so an empty array alone is NOT enough.
  const modeOk = fb.mode !== "retry";
  const pickerIds = new Set(rows.map((r) => r.model));
  const rewriting = (cfg.Router?.rules ?? []).filter((r) => r.enabled !== false);
  record("T1.1", "fallback chain empty + no rewriting rules",
    chainEmpty && modeOk && rewriting.length === 0,
    `mode=${fb.mode} models=${(fb.models ?? []).length} enabledRules=${rewriting.length} ` +
    `pickerRows=${pickerIds.size}`, true);
}

// ---- T1.2 the stale-entry hazard is unreachable by construction ------------
// Highest value per cost in the whole gate: a bare id can silently bind to
// whichever single provider happens to list that model name. If keysync never
// emits one, the dangerous path is unreachable from the shipped pipeline and
// only hand-edits can reintroduce it.
{
  const bare = rows.filter((r) => !/^[^/]+\/.+$/.test(r.model));
  record("T1.2", "every picker row is a namespaced provider/model selector",
    bare.length === 0,
    bare.length ? `BARE IDS: ${bare.map((b) => b.model).join(", ")}` : `${rows.length}/${rows.length} namespaced`);
}

// ---- T1.3 every row is actually resolvable ---------------------------------
{
  const configured = new Set();
  for (const p of cfg.Providers ?? []) {
    for (const m of p.models ?? []) configured.add(`${p.name}/${m}`.toLowerCase());
  }
  const orphans = rows.filter((r) => !configured.has(r.model.toLowerCase()));
  record("T1.3", "picker rows all exist in Providers[].models",
    orphans.length === 0,
    orphans.length ? `ORPHANS: ${orphans.map((o) => o.model).join(", ")}` : `${rows.length} rows all resolvable`);
}

// ---- T1.4 a restore point exists and is actually usable --------------------
{
  const dir = path.dirname(LIVE_SETTINGS);
  const base = `${path.basename(LIVE_SETTINGS)}.uw-backup-`;
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort().reverse();
  let usable = false, detail = "no backup found";
  if (backups.length) {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8").replace(/^﻿/, ""));
      // A backup that parses but has no picker is not a restore point.
      usable = (b.modelPicker?.options?.length ?? 0) > 0;
      detail = `${backups[0]} parses, ${b.modelPicker?.options?.length ?? 0} rows`;
    } catch (e) { detail = `${backups[0]} does NOT parse: ${e.message.slice(0, 60)}`; }
  }
  record("T1.4", "a newest settings backup exists and is restorable", usable, detail, true);
}

// ---- context for later stages (not pass/fail) ------------------------------
const anchors = {
  model: settings.env?.ANTHROPIC_MODEL,
  opus: settings.env?.ANTHROPIC_DEFAULT_OPUS_MODEL,
  sonnet: settings.env?.ANTHROPIC_DEFAULT_SONNET_MODEL,
  haiku: settings.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  fable: settings.env?.ANTHROPIC_DEFAULT_FABLE_MODEL
};
console.log(`\ncontext: ${rows.length} rows / ${new Set(rows.map((r) => r.model.split("/")[0])).size} providers`);
console.log(`anchors: ${JSON.stringify(anchors)}`);
console.log(`replaceBuiltInOptions: ${settings.modelPicker?.replaceBuiltInOptions}`);

const failed = results.filter((r) => !r.ok);
const gateFailed = failed.filter((r) => r.gate);
console.log(`\n=== Stage A: ${results.length - failed.length}/${results.length} passed ===`);
if (gateFailed.length) {
  console.error(`HARD GATE FAILED (${gateFailed.map((g) => g.id).join(", ")}) — do not run later Phase 5 stages.`);
  process.exit(2);
}
if (failed.length) { console.error(`non-gating failures: ${failed.map((f) => f.id).join(", ")}`); process.exit(1); }
console.log("Stage A clean — later stages may proceed.");

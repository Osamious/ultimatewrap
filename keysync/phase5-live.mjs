// Phase 5, Stage C — T4.2 sampled real-payload routing against LIVE.
//
// Samples three rows by PATH CLASS rather than re-testing all 18: (i) Anthropic
// through the OAuth relay, (ii) a direct vault-key third party, (iii) the
// smallest/most fragile row. Phase 3's verify-cli already probed the shipped set
// under the real client; re-running all 18 would spend 18 paid requests to
// re-prove a closed criterion.
//
// The assertion is the request log's `provider` field, not the response text:
// content coming back is not evidence that a particular provider served it.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const LIVE_SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const CLAUDE = path.join(os.homedir(), ".local", "bin", "claude.exe");

const svc = JSON.parse(fs.readFileSync(
  path.join(process.env.APPDATA, "claude-code-router", "service.json"), "utf8"));
const url = new URL(svc.url);
const token = url.searchParams.get("ccr_web_token");
const rpc = async (method, args = []) => {
  const res = await fetch(`http://127.0.0.1:${url.port}/api/ccr/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
    body: JSON.stringify({ method, args })
  });
  const j = await res.json();
  if (!j.ok) throw new Error(`${method}: ${j.error?.message}`);
  return j.value;
};

const settings = JSON.parse(fs.readFileSync(LIVE_SETTINGS, "utf8").replace(/^﻿/, ""));
const rows = settings.modelPicker.options.map((o) => o.model);

const sample = [
  { klass: "relay (Anthropic subscription)", model: rows.find((m) => m.startsWith("anthropic/claude-haiku")) },
  { klass: "direct vault key", model: rows.find((m) => m.startsWith("google/")) ?? rows.find((m) => !m.startsWith("anthropic/")) },
  { klass: "fragile small-context", model: rows.find((m) => /qwen3-4b/i.test(m)) ?? rows.find((m) => m.startsWith("nscale/")) }
].filter((s) => s.model);

function runClaude(model) {
  return new Promise((resolve) => {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID|ANTHROPIC_|CCR_)/i.test(k)) continue;
      env[k] = v;
    }
    const child = spawn(CLAUDE, ["--settings", LIVE_SETTINGS, "--model", model,
      "-p", "Reply with the single word: ping"], { env, cwd: os.homedir(), shell: false });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => child.kill("SIGKILL"), 150000);
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

let pass = 0;
for (const s of sample) {
  const t0 = Date.now();
  const r = await runClaude(s.model);
  const logs = await rpc("getRequestLogs", [{ limit: 20 }]);
  const rowsLog = (Array.isArray(logs) ? logs : logs.items ?? []).filter(
    (l) => new Date(l.createdAt ?? 0).getTime() >= t0);
  const mine = rowsLog.find((l) => String(l.requestedModel ?? l.model ?? "") === s.model) ?? rowsLog[0];

  const expectedProvider = s.model.split("/")[0];
  const servedBy = mine?.provider;
  const status = mine?.statusCode;
  // Attribution is the assertion; content is only a liveness signal. Requiring
  // the literal word misreported a correct route once (Gemini answered "Pong."
  // to a "reply with ping" prompt) — which is precisely why this suite judges on
  // the request log rather than on prose.
  const ok = r.code === 0 && r.out.trim().length > 0 && status === 200 &&
    String(servedBy ?? "").toLowerCase() === expectedProvider.toLowerCase();
  if (ok) pass++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${s.klass}`);
  console.log(`        ${s.model}`);
  console.log(`        exit=${r.code} status=${status} servedBy=${servedBy} (expected ${expectedProvider}) ` +
    `resolved=${mine?.resolvedModel} reply="${r.out.trim().slice(0, 30)}"`);
}
console.log(`\n=== T4.2: ${pass}/${sample.length} sampled path classes route correctly ===`);
process.exit(pass === sample.length ? 0 : 1);

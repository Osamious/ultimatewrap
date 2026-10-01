// The isolation proof for the CCR 3.1.1 sandbox's FIRST start (gate G2). Assertions,
// never print-and-eyeball; no token or key is ever printed. Every check runs inside
// its own guard: a check that throws becomes a RED check, it never aborts the proof.
// Imported by start31.mjs; does not start anything itself.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync as realSpawnSync } from "node:child_process";
import {
  TRIAL_ROOT, HOME, ROAMING, SERVICE_JSON, VIOLATIONS_LOG, GUARD_LOADED_LOG, PORT_RANGE, REAL_PORTS, REAL_SETTINGS, LOOPBACK,
} from "./config31.mjs";
import { readUserPathRaw, restoreUserPathIfSpliced, readProcessTable, runPs as ps } from "./tripwire31.mjs"; // ps: absolute powershell.exe
const under = (p, root) => !!p && path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase() + "\\");
const SETTINGS_RE = /ANTHROPIC_BASE_URL|apiKeyHelper/;
const isLoopbackAddr = (a) => /^(127\.|::1$|::ffff:127\.)/.test(String(a));
const inTrialRange = (p) => Number.isInteger(p) && p >= PORT_RANGE[0] && p <= PORT_RANGE[1] && !REAL_PORTS.includes(p);

/** Count of lines in the REAL settings.json matching the takeover markers; -1 = unreadable (a sentinel, never "equal"). */
export function settingsMarkerCount(file = REAL_SETTINGS, fsx = fs) {
  try { return fsx.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => SETTINGS_RE.test(l)).length; } catch { return -1; }
}

/** {count, hash} of the real settings.json (count -1 / hash "(unreadable)" when it cannot be read). */
export function settingsState(file = REAL_SETTINGS, fsx = fs) {
  try {
    const buf = fsx.readFileSync(file);
    return { count: buf.toString("utf8").split(/\r?\n/).filter((l) => SETTINGS_RE.test(l)).length, hash: crypto.createHash("sha256").update(buf).digest("hex") };
  } catch { return { count: -1, hash: "(unreadable)" }; }
}

/** Check 3: marker count AND hash unchanged; an unreadable file on either side is RED, never "equal by -1". */
export function checkSettings(before, after) {
  const unreadable = !before || !after || before.count < 0 || after.count < 0 || before.hash === "(unreadable)" || after.hash === "(unreadable)";
  const ok = !unreadable && before.count === after.count && before.hash === after.hash;
  return { ok, detail: unreadable ? `UNREADABLE before=${before?.count} after=${after?.count}` : `markers before=${before.count} after=${after.count} hash ${before.hash === after.hash ? "unchanged" : "CHANGED"}` };
}

/** Parses guard-loaded.log tolerantly: a torn/garbled line is counted, never thrown on. */
export function parseLoadedLog(text) {
  const entries = [];
  let torn = 0;
  for (const l of String(text || "").split(/\r?\n/).filter(Boolean)) {
    try {
      const o = JSON.parse(l);
      const ms = Date.parse(o.ts);
      if (Number.isInteger(o.pid) && Number.isFinite(ms)) entries.push({ ms, pid: o.pid, thread: o.thread });
      else torn++;
    } catch { torn++; }
  }
  return { entries, torn };
}

/**
 * Check 8: violations.log empty AND every node.exe pid of the daemon tree logged that the guard
 * loaded, counting only lines written at or after `launchMs` (stale lines from an earlier run
 * cannot satisfy it; the logs are also rotated before launch).
 */
export function checkGuardLoaded({ violationsText, loadedText, launchMs, nodePids, mainPid }) {
  const viol = String(violationsText || "").trim();
  const violN = viol ? viol.split(/\r?\n/).length : 0;
  const { entries, torn } = parseLoadedLog(loadedText);
  const fresh = entries.filter((e) => e.ms >= launchMs);
  const loadedMain = new Set(fresh.filter((e) => e.thread === "main").map((e) => e.pid));
  const workerLines = fresh.filter((e) => e.thread !== "main").length;
  const missing = nodePids.filter((p) => !loadedMain.has(p));
  const ok = violN === 0 && loadedMain.has(mainPid) && missing.length === 0;
  return {
    ok,
    detail: `violations=${violN} guardLoadedPids=${[...loadedMain].join(",") || "(none)"} nodePids=${nodePids.join(",")} missing=${missing.join(",") || "none"} workerThreadLines=${workerLines} staleLines=${entries.length - fresh.length} tornLines=${torn}`,
  };
}

/** pid + all descendants, from process rows ({ProcessId, ParentProcessId}). */
export function pidTree(rootPid, rows = readProcessTable()) {
  const kids = new Map();
  for (const r of rows) (kids.get(r.ParentProcessId) ?? kids.set(r.ParentProcessId, []).get(r.ParentProcessId)).push(r.ProcessId);
  const out = [rootPid];
  for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) ?? []));
  return [...new Set(out)];
}

function netRows(pids, state) {
  const list = pids.join(",");
  const raw = ps(`Get-NetTCPConnection -State ${state} -ErrorAction SilentlyContinue | Where-Object { @(${list}) -contains $_.OwningProcess } | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess | ConvertTo-Json -Compress`);
  return raw ? [].concat(JSON.parse(raw)) : [];
}

/** The auth header is only ever sent to a loopback port inside the trial range. */
async function rpc(port, method, token, args = []) {
  if (!inTrialRange(port)) throw new Error(`refusing to send the web auth header to port ${port}: outside the trial range or live`);
  const res = await fetch(`http://${LOOPBACK}:${port}/api/ccr/rpc`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-ccr-web-auth": token },
    body: JSON.stringify({ method, args }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method} failed: ${String(json.error?.message).slice(0, 200)}`);
  return json.value;
}

function walkNames(dir, max = 200) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (out.length >= max) return;
      if (e.isDirectory()) walk(p);
      else { let sz = -1; try { sz = fs.statSync(p).size; } catch { /* ignore */ } out.push(`${path.relative(TRIAL_ROOT, p)} (${sz} B)`); }
    }
  };
  walk(dir);
  return out;
}

/**
 * Pre-launch canary: proves THIS node + THIS env honours the preload before anything real launches.
 * A child with the launch env checks the guard symbol and attempts one harmless write outside the
 * sandbox root (a tiny temp file that the child deletes if, wrongly, it was allowed).
 * @returns {{ok:boolean, detail:string}}
 */
export function preLaunchCanary(spec, { spawnSync = realSpawnSync, probePath } = {}) {
  const probe = probePath ?? path.join(path.dirname(TRIAL_ROOT), `uw-trial31-canary-${crypto.randomBytes(4).toString("hex")}.tmp`);
  const script = "const fs=require('fs');const probe=process.argv[1];let blocked=false,code;"
    + "try{fs.writeFileSync(probe,'x');try{fs.unlinkSync(probe)}catch{}}catch(e){blocked=!!e&&e.code==='UW_TRIAL31_VIOLATION';code=e&&e.code}"
    + "process.stdout.write(JSON.stringify({guard:!!process[Symbol.for('uw.trial31.guard')],blocked,code}))";
  const r = spawnSync(process.execPath, ["-e", script, probe], { env: spec.env, cwd: spec.cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
  let j;
  try { j = JSON.parse(String(r.stdout || "")); } catch { /* fall through */ }
  const ok = r.status === 0 && !!j && j.guard === true && j.blocked === true;
  return { ok, detail: ok ? "guard flag set and an outside write was blocked" : `guard=${j?.guard} blocked=${j?.blocked} code=${j?.code} status=${r.status} stderr=${String(r.stderr || "").slice(0, 160)}` };
}

const defaultIo = () => ({
  readServiceJson: () => JSON.parse(fs.readFileSync(SERVICE_JSON, "utf8")), // never printed: it carries the token
  procRows: () => readProcessTable(),
  netRows,
  rpc,
  readUserPath: readUserPathRaw,
  restore: restoreUserPathIfSpliced,
  settingsState: () => settingsState(),
  readText: (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""),
  walkNames,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

/**
 * @param {{pid:number, launchedAtMs:number, tokens:{web:string,service:string}, tripwire:{assert:Function}, savedPath:object, settingsBefore:{count:number,hash:string}, livePortPidsBefore:Record<number,number|undefined>, listenerPid:Function, io?:object}} ctx
 * @returns {Promise<{ok:boolean, checks:{n:number,name:string,ok:boolean,detail:string,recorder?:boolean}[], measurements:object}>}
 */
export async function verifyIsolation(ctx) {
  const io = { ...defaultIo(), ...(ctx.io ?? {}) };
  const checks = [];
  const add = (n, name, ok, detail, extra = {}) => checks.push({ n, name, ok: !!ok, detail, ...extra });
  const attempt = async (n, name, fn) => {
    try { const r = await fn(); add(n, name, r.ok, r.detail, r.extra); }
    catch (e) { add(n, name, false, `check threw: ${String(e && e.message).slice(0, 200)}`); }
  };
  let svc, webPort, tree = [], svcErr;
  try {
    svc = io.readServiceJson();
    webPort = Number(new URL(svc.url).port);
    tree = pidTree(ctx.pid, io.procRows());
  } catch (e) { svcErr = `service.json/process table unusable: ${String(e && e.message).slice(0, 160)}`; }
  const measurements = { homeWrites: [], webPort, tree };

  await attempt(1, "listening ports of the daemon pid tree are all loopback, in the trial range, none live", async () => {
    if (svcErr) throw new Error(svcErr);
    const listen = io.netRows(tree, "Listen");
    const bad = listen.filter((r) => !inTrialRange(r.LocalPort));
    const nonLoop = listen.filter((r) => !isLoopbackAddr(r.LocalAddress));
    return {
      ok: listen.length > 0 && bad.length === 0 && nonLoop.length === 0 && svc.pid === ctx.pid && listen.some((r) => r.LocalPort === webPort),
      detail: `pids=${tree.join(",")} ports=${listen.map((r) => `${r.LocalAddress}:${r.LocalPort}`).join(",") || "(none)"} badPort=${bad.map((r) => r.LocalPort).join(",") || "none"} nonLoopbackBind=${nonLoop.map((r) => r.LocalAddress).join(",") || "none"}`,
    };
  });
  await attempt(1.5, "zero non-loopback established connections from the daemon pid tree", async () => {
    if (svcErr) throw new Error(svcErr);
    const est = io.netRows(tree, "Established").filter((r) => !/^(127\.|::1$)/.test(r.RemoteAddress));
    return { ok: est.length === 0, detail: `non-loopback=${est.length}` };
  });
  await attempt(2, "tripwire over live state", async () => {
    try { ctx.tripwire.assert("g2:first-start"); return { ok: true, detail: "unchanged" }; }
    catch (e) { return { ok: false, detail: String(e.message).slice(0, 300) }; }
  });
  await attempt(3, "real ~\\.claude\\settings.json marker count AND sha256 unchanged (unreadable is RED)", async () => checkSettings(ctx.settingsBefore, io.settingsState()));
  await attempt(4, "service.json carries this run's random web and service tokens", async () => {
    if (svcErr) throw new Error(svcErr);
    let ok = false;
    try { ok = new URL(svc.url).searchParams.get("ccr_web_token") === ctx.tokens.web && svc.serviceToken === ctx.tokens.service; } catch { /* fallthrough */ }
    return { ok, detail: ok ? "match" : "MISMATCH (env did not reach the daemon; may not be our instance)" };
  });
  await attempt(5, "getAppInfo paths under the sandbox, desktop === false", async () => {
    if (svcErr) throw new Error(svcErr);
    const info = await io.rpc(webPort, "getAppInfo", ctx.tokens.web);
    const fields = { configDir: info.configDir, dataDir: info.dataDir, configDbFile: info.configDbFile, requestLogsDbFile: info.requestLogsDbFile, usageDbFile: info.usageDbFile };
    const off = Object.entries(fields).filter(([, v]) => !under(v, TRIAL_ROOT) && v !== TRIAL_ROOT);
    const ok = off.length === 0 && info.desktop === false;
    return { ok, detail: off.length ? `outside: ${off.map(([k]) => k).join(",")}` : `version=${info.version} desktop=${info.desktop}${info.desktop === false ? "" : " (expected false)"}` };
  });
  // 6. RECORDER, not an assertion: what the daemon wrote into the scratch home/roaming is measurement M7.
  await attempt(6, "M7 recorder: scratch home/roaming contents (measurement, not an assertion)", async () => {
    const homeWrites = [...io.walkNames(HOME), ...io.walkNames(ROAMING)];
    measurements.homeWrites = homeWrites;
    return { ok: true, detail: `${homeWrites.length} files recorded`, extra: { recorder: true } };
  });
  await attempt(7, "HKCU user PATH unchanged", async () => {
    const cur = io.readUserPath();
    const same = !!cur && cur.value === ctx.savedPath.value && cur.type === ctx.savedPath.type;
    let restored = "";
    if (!same) restored = ` restore=${JSON.stringify(io.restore(ctx.savedPath))}`;
    return { ok: same, detail: (same ? "unchanged" : "CHANGED") + restored };
  });
  await attempt(8, "violations.log empty and the guard loaded (this run) in EVERY node.exe of the daemon tree", async () => {
    let r;
    for (let i = 0; i < 4; i++) {
      const rows = io.procRows();
      const nodePids = pidTree(ctx.pid, rows).filter((p) => /^node(\.exe)?$/i.test(String(rows.find((x) => x.ProcessId === p)?.Name ?? "node.exe")));
      r = checkGuardLoaded({ violationsText: io.readText(VIOLATIONS_LOG), loadedText: io.readText(GUARD_LOADED_LOG), launchMs: ctx.launchedAtMs, nodePids: nodePids.length ? nodePids : [ctx.pid], mainPid: ctx.pid });
      if (r.ok || /violations=[1-9]/.test(r.detail)) break;
      await io.sleep(500); // a just-forked node may not have finished its preload yet
    }
    return r;
  });
  // Live ports still owned by the same pids as before launch.
  await attempt(9, "live ports 3456/3457/3458/4517 owned by the same pids as before", async () => {
    const liveNow = Object.fromEntries(REAL_PORTS.map((p) => [p, ctx.listenerPid(p)]));
    return { ok: REAL_PORTS.every((p) => liveNow[p] === ctx.livePortPidsBefore[p]), detail: JSON.stringify(liveNow) };
  });

  checks.sort((a, b) => a.n - b.n);
  return { ok: checks.every((c) => c.ok), checks, measurements };
}

export function renderProof(result, meta) {
  const label = (c) => (c.recorder ? "RECORD" : c.ok ? "GREEN" : "RED");
  const rows = result.checks.map((c) => `| ${c.n} | ${c.name} | ${label(c)} | ${c.detail.replace(/\|/g, "/")} |`).join("\n");
  return `# CCR ${meta.version} isolation proof (stage 1, gate G2)\n\nGenerated ${new Date().toISOString()} by verify-isolation31.mjs. Zero providers, \`--no-gateway\`, airgap on.\n\n| # | check | result | detail |\n|---|-------|--------|--------|\n${rows}\n\nOverall: ${result.ok ? "ALL GREEN" : "FAILED"}\n\n## Files the daemon wrote into the scratch home/roaming (M7)\n${result.measurements.homeWrites.map((l) => `- ${l}`).join("\n") || "- (none)"}\n`;
}

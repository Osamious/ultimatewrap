// THROWAWAY S0 probe router (plan 12.1 S0, 12.2 X1-X9). TRACKED source at harness/probe-router.cjs, OUTSIDE the sandbox scratch root (so neither the stock
// harness/teardown.mjs, which deletes the whole scratch root, nor selectiveTeardown can remove it). Run only as a COPY at
// harness/scratch/spike/uw-router.cjs inside the sandbox; never wired live. State is derived from the copy's own location
// (..\state\subagent), so the copy writes only inside the sandbox scratch tree, and it writes ONE file: probe.jsonl. It records sizes, hashes, booleans, counts and
// the SHAPE of ids, never a body, a header value or a credential.
//
// Every call records (so the X-experiments need no mode): A0 flags, E12 (tokenCount, content-length), E7 (`n` on globalThis, `m` at MODULE scope), X1 (`cfg`: is `config`
// and `config.Providers` the same object as on the previous call in this process, the provider count and a fingerprint of provider names and model lists), X2 (`pid`), X4
// (`hdr`: presence and shape of the agent id, parent agent id, session id and the retry count), X5 (`ml` messages.length, `lh` a hash of the last message).
// The mode (read per request from probe-control.json, absent = "mutate") decides what the router does:
//   mutate    edit the Agent tool description (E4), add a header (E5), return asked
//   observe   touch nothing, return asked (X1-X5, X9)
//   keep-tag  E13 CONTROL arm: touch nothing, return undefined; CCR must then still honour the tag (proves the tag mechanism works at all)
//   clear-tag E13 test arm: clear builtInSubagentModel, return undefined
//   timer     X7: a request-scoped setTimeout(...).unref() that appends a `timer` line 300 ms later (probe-control.json may carry delayMs, 50..5000) (does it fire after CCR deleted this module's cache entry?), return asked
//   sys-string / sys-array   X8: append the marker to a string system / push a marker block onto an array system (once), record sha256 prefixes of system, messages and tools before and after
//   registry  record the size of globalThis.__uwRouterImpl (router v2's loader registry, left behind by an earlier run of the exact bytes in the same process), return asked
// E7: CCR deletes the require-cache entry per request, so the module is re-evaluated each time and `m` restarts at 1; `n` on globalThis
// survives. `n` rising with `m` staying 1 is the proof; `m` rising means the cache was NOT deleted and `n` proves nothing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const DIR = path.join(__dirname, "..", "state", "subagent");
const X8_MARK = "[uwpr-x8]";
let m = 0;                                                                   // module-scope control counter (E7); the only module-scope state
const h12 = (v) => crypto.createHash("sha256").update(JSON.stringify(v === undefined ? null : v)).digest("hex").slice(0, 12);
const shape = (v) => (typeof v !== "string" ? null : { len: v.length, at: v.includes("@"), ok: /^[A-Za-z0-9_@.:-]{1,128}$/.test(v), form: v.replace(/[A-Za-z]+/g, "a").replace(/[0-9]+/g, "9").slice(0, 40) });
const sysShape = (s) => (typeof s === "string" ? "string" : Array.isArray(s) ? "array" : "absent");
const record = (o) => { try { fs.mkdirSync(DIR, { recursive: true }); fs.appendFileSync(path.join(DIR, "probe.jsonl"), JSON.stringify(o) + "\n"); } catch { /* recording is best effort */ } };

module.exports = async function route(req, config) {
  const asked = String((req && req.body && req.body.model) ?? "");
  if (!asked) return undefined;
  m += 1;
  let ctl = {};
  try { ctl = JSON.parse(fs.readFileSync(path.join(DIR, "probe-control.json"), "utf8")) || {}; } catch { /* absent: default */ }
  const mode = typeof ctl.mode === "string" && ctl.mode ? ctl.mode : "mutate";
  globalThis.__uwProbeN = (globalThis.__uwProbeN || 0) + 1;                  // E7: survives the per-request require-cache deletion?
  const h = (req && req.headers) || {};
  const hv = (k) => (Array.isArray(h[k]) ? h[k][0] : h[k]);
  const msgs = Array.isArray(req.body.messages) ? req.body.messages : [];
  const prov = config && Array.isArray(config.Providers) ? config.Providers : null;
  const prev = globalThis.__uwProbeCfg;                                      // X1: identity across calls (null on the first call of this process)
  const line = { t: new Date().toISOString(), n: globalThis.__uwProbeN, m, pid: process.pid, mode, asked,
    bl: req.builtInClaudeCodeSubagent === true, tag: req.builtInSubagentModel ?? null, tokenCount: req.tokenCount ?? null,
    contentLength: h["content-length"] ?? null, agentId: h["x-claude-code-agent-id"] ? 1 : 0,
    cfg: { first: !prev, same: prev ? prev.c === config : null, provSame: prev ? prev.p === prov : null, provN: prov ? prov.length : null,
      fp: h12(prov ? prov.map((p) => [p && p.name, p && p.enabled, p && p.models]) : null) },
    hdr: { aid: shape(hv("x-claude-code-agent-id")), par: shape(hv("x-claude-code-parent-agent-id")), sid: shape(hv("x-claude-code-session-id")),
      retry: typeof hv("x-stainless-retry-count") === "string" ? hv("x-stainless-retry-count").slice(0, 16) : null },
    ml: msgs.length, lh: h12(msgs[msgs.length - 1]) };
  globalThis.__uwProbeCfg = { c: config, p: prov };
  if (mode === "clear-tag") req.builtInSubagentModel = undefined;            // E13 test arm: does the later policy chain still see the tag?
  else if (mode === "mutate") {
    line.mutated = false;                                                    // stays false when the body has no Agent tool: E4 is then unmeasured
    for (const t of Array.isArray(req.body.tools) ? req.body.tools : []) {   // E4: a body edit that must reach the upstream
      if (/^(agent|task)$/i.test(String(t && t.name))) { t.description = `${t.description || ""}\n[uwpr-e4]`; line.mutated = true; }
    }
    h["x-uw-subpolicy"] = "probe";                                           // E5: an added header that must reach the upstream
    line.headerSet = true;
  } else if (mode === "timer") {                                             // X7: the closure outlives this module's cache entry only if the timer fires
    const delay = Math.max(50, Math.min(5000, Number(ctl.delayMs) || 300));    // the control file may lengthen the 300 ms default (the harness uses 800 ms for margin)
    setTimeout(() => record({ kind: "timer", of: line.n, pid: process.pid, t: new Date().toISOString() }), delay).unref();
    line.timer = true; line.delayMs = delay;
  } else if (mode === "sys-string" || mode === "sys-array") {                // X8: ONE edit of the system prompt, in the shape the mode names
    const hashes = () => ({ shape: sysShape(req.body.system), sys: h12(req.body.system), msgs: h12(req.body.messages), tools: h12(req.body.tools) });
    line.before = hashes();
    line.edited = false;
    if (mode === "sys-string" && typeof req.body.system === "string") { req.body.system = `${req.body.system}\n${X8_MARK}`; line.edited = true; }
    else if (mode === "sys-array" && Array.isArray(req.body.system)) { req.body.system.push({ type: "text", text: X8_MARK }); line.edited = true; }
    line.after = hashes();
  } else if (mode === "registry") {                                          // router v2's loader registry (keyed by this file's path, which is the router's path in the sandbox)
    const reg = globalThis.__uwRouterImpl;
    line.reg = { keys: reg && typeof reg === "object" ? Object.keys(reg).length : 0, own: !!(reg && reg[__filename]), id: reg && reg[__filename] ? String(reg[__filename].id).slice(0, 80) : null };
  }                                                                          // keep-tag and observe: nothing touched
  record(line);
  return mode === "keep-tag" || mode === "clear-tag" ? undefined : asked;
};

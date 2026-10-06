// Scripted stub upstream for the subagent-policy sandbox (plan 9.2, 12.5). A local Anthropic-messages server that answers a
// minimal valid SSE (or JSON) reply and RECORDS exactly what reached it, so the experiments can read "what did the upstream
// receive" instead of inferring it.
//
// What is recorded per request (and nothing else): arrival time, sequence number, the request model, the content-length header,
// the byte length and sha256 of the body, the whitelisted headers below, the tool NAMES, the Agent tool description (our own
// injected text: synthetic bodies carry no user data) and, for X8, the SHAPE of the system prompt (string, array or absent), whether the
// harness's own marker strings occur in it, the indexes of system blocks that carry cache_control, messages.length and the sha256 of messages
// and of tools, plus what the stub itself SENT (status, Retry-After seconds, a stream cut). Bodies are never stored, and credential headers
// (x-api-key, authorization) are never recorded: the whitelist is the only path a header can take into a record. `retry-after` is a header
// the stub SENDS (a scripted 429 and so on, see createStub); it is deliberately not on the whitelist, so a request's own retry-after is never stored.
//
// It can script a subagent spawn: when a MAIN-shaped request (Agent tool present, no agent id) arrives and a script says so, the
// reply is an Agent tool call whose prompt carries the marker `UWGT:<label>:<n>`; when a later request body contains such a marker the
// stub appends `{t, sid, label, n}` to the labels file (ground truth for the classifier protocol, plan 12.5). Importing this module
// starts nothing. It binds loopback only, and refuses any port that is a live CCR or relay port.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { SCRATCH_ROOT, STUB_PORT, PORT_RANGE, LIVE_PORTS, RELAY_PORT } from "./config.mjs";

export { STUB_PORT };                             // the number lives in harness/config.mjs (one place)
export const STUB_MODELS = ["m-main", "m-free", "m-big"];
const REAL_PORTS = [...LIVE_PORTS, RELAY_PORT];
const [SANDBOX_PORT_MIN, SANDBOX_PORT_MAX] = PORT_RANGE;
// Request headers only: no credential header is on this list and `retry-after` is deliberately NOT (it is a header the stub SENDS, never one it records from a request).
export const RECORDED_HEADERS = ["anthropic-beta", "anthropic-version", "x-uw-subpolicy", "user-agent", "content-length",
  "x-claude-code-agent-id", "x-claude-code-session-id", "x-claude-code-request-class", "x-claude-code-agent-type", "x-claude-code-parent-agent-id", "x-stainless-retry-count"];
export const MARKER_RE = /UWGT:([A-Za-z0-9_-]{1,32}):(\d{1,6})/;
const BODY_MAX = 8 * 1024 * 1024;
const DESC_MAX = 8192;
const RECORDS_MAX = 2000;

const here = (p) => path.resolve(p).toLowerCase();
const under = (p, root) => { const a = here(p), r = here(root); return a === r || a.startsWith(r + path.sep); };

/** The labels file may only live inside the sandbox scratch root or the OS temp dir (unit tests use the latter). */
export function assertLabelsPath(file) {
  if (!file) return;
  if (!under(file, SCRATCH_ROOT) && !under(file, os.tmpdir())) {
    throw new Error(`stub labels file ${file} is outside the sandbox scratch root and the temp dir`);
  }
}

export function assertStubPort(port) {
  if (!Number.isInteger(port) || port < 0) throw new Error(`stub port ${port} is not a non-negative integer`);
  if (REAL_PORTS.includes(port)) throw new Error(`stub port ${port} is a LIVE port`);
  if (port !== 0 && (port < SANDBOX_PORT_MIN || port > SANDBOX_PORT_MAX)) {
    throw new Error(`stub port ${port} is outside the sandbox range ${SANDBOX_PORT_MIN}-${SANDBOX_PORT_MAX} (0 = OS-assigned, tests only)`);
  }
}

/** The stub listens on the IPv4 loopback address and nothing else: any other host (0.0.0.0, ::, a LAN address, localhost) is refused when the stub is created. */
export const STUB_HOST = "127.0.0.1";
export function assertStubHost(host) {
  if (host !== STUB_HOST) throw new Error(`stub host ${String(host)} is not ${STUB_HOST}: the stub binds loopback only`);
}

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const MARKERS_MAX = 8;

/**
 * One scripted answer. A bare number is a status. `retryAfter` is whole SECONDS (the stub sends `Retry-After: <n>`; 0..86400), `cut: "after-message_start"` answers 200 with
 * ONLY the message_start event and then destroys the socket (a stream cut). Everything else is refused here, so a typo in a script cannot become an odd response.
 */
export function normaliseStep(step) {
  const o = typeof step === "number" ? { status: step } : { ...(step ?? {}) };
  const status = o.status ?? 200;
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(`stub step: status ${status} is not an integer 200..599`);
  const ra = o.retryAfter ?? null;
  if (ra !== null && !(Number.isInteger(ra) && ra >= 0 && ra <= 86400)) throw new Error(`stub step: retryAfter ${ra} is not whole seconds 0..86400`);
  const cut = o.cut ?? null;
  if (cut !== null && cut !== "after-message_start") throw new Error(`stub step: cut ${cut} is not "after-message_start"`);
  return { status, retryAfter: ra, cut };
}
function normaliseScript(s) {
  const sc = { ...(s ?? {}) };
  if (sc.sequence !== undefined) { if (!Array.isArray(sc.sequence)) throw new Error("stub script: sequence must be an array"); sc.sequence = sc.sequence.map(normaliseStep); }
  if (sc.markers !== undefined) {
    if (!Array.isArray(sc.markers) || sc.markers.length > MARKERS_MAX || sc.markers.some((m) => typeof m !== "string" || m.length < 1 || m.length > 64)) throw new Error(`stub script: markers must be at most ${MARKERS_MAX} strings of 1..64 characters`);
  }
  if (sc.userMarkers !== undefined) {
    if (!Array.isArray(sc.userMarkers) || sc.userMarkers.length > MARKERS_MAX || sc.userMarkers.some((m) => typeof m !== "string" || m.length < 1 || m.length > 64)) throw new Error(`stub script: userMarkers must be at most ${MARKERS_MAX} strings of 1..64 characters`);
  }
  return sc;
}
const SYS_SHAPES = (sys) => (typeof sys === "string" ? "string" : Array.isArray(sys) ? "array" : "absent");
const ERROR_TYPE = { 429: "rate_limit_error", 529: "overloaded_error", 400: "invalid_request_error", 413: "request_too_large" };

const lower = (h) => { const o = {}; for (const [k, v] of Object.entries(h || {})) o[k.toLowerCase()] = Array.isArray(v) ? v[0] : v; return o; };
const toolName = (t) => String((t && (t.name ?? (t.function && t.function.name))) ?? "");
const isAgentTool = (n) => n.toLowerCase() === "agent" || n.toLowerCase() === "task";

function sseEvents(model, blocks, stop) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let s = ev("message_start", { message: { id: "msg_stub", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  blocks.forEach((b, i) => {
    if (b.type === "text") {
      s += ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      s += ev("content_block_delta", { index: i, delta: { type: "text_delta", text: b.text } });
    } else {
      s += ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      s += ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    s += ev("content_block_stop", { index: i });
  });
  s += ev("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
  s += ev("message_stop", {});
  return s;
}

/**
 * createStub({port, script, labelsFile})
 *   script.onMain(record) -> undefined | {subagent_type, label}   (scripted Agent tool call; n is counted per label)
 *   script.text           -> reply text (default "stub-ok")
 *   script.status         -> HTTP status to answer instead (default 200); used to rehearse upstream failures
 *   script.sequence       -> per-request steps, consumed in order, one per /v1/messages request (each a status number or {status, retryAfter (seconds), cut}); when it is empty the
 *                            answer is script.status or 200. Steps: 200, 429 with and without retryAfter, 503, 529, 400, 413, 502, {cut: "after-message_start"}
 *   script.decide         -> (rec) => a step (a status number or {status, retryAfter, cut}) for THIS request, or undefined to fall through to the sequence and the default; scripts the failure of one model
 *   script.userMarkers    -> like markers, but looked for in the request's MESSAGES: rec.userMarkers[<marker>] (true/false); rec.toolResults is always the number of tool_result blocks in the messages. A REAL client's turns are told apart by them
 *                            (the turn that carries the user's prompt and no tool_result yet is the one to answer with the scripted Agent call; a retry of it gets the same answer). rec.sent.kind is "tool_use" or "text" for a 200 answer
 *   script.markers        -> strings (at most 8, each at most 64 characters) whose presence in the request's SYSTEM is recorded as rec.markers[<marker>] (true/false); the marker text is the
 *                            harness's own, the system text is never stored
 */
export function createStub({ port = STUB_PORT, script = {}, labelsFile, host = STUB_HOST } = {}) {
  assertStubPort(port);
  assertStubHost(host);
  assertLabelsPath(labelsFile);
  const records = [];
  const counters = new Map();
  let seq = 0;
  let current = normaliseScript(script);
  let pending = [...(current.sequence ?? [])];

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0, tooBig = false;
    req.on("data", (c) => { size += c.length; if (size > BODY_MAX) tooBig = true; else chunks.push(c); });
    req.on("end", () => {
      const h = lower(req.headers);
      const rec = { seq: ++seq, t: new Date().toISOString(), method: req.method, path: req.url, bodyBytes: size, bodySha256: null, model: null,
        headers: {}, toolNames: [], agentToolDescription: null, marker: null,
        systemShape: null, markers: {}, userMarkers: {}, toolResults: null, sysBlocks: null, sysCc: [], messagesLen: null, messagesSha256: null, toolsSha256: null, sent: null };
      for (const k of RECORDED_HEADERS) if (h[k] !== undefined) rec.headers[k] = String(h[k]).slice(0, 256);
      let body = null;
      if (!tooBig) {
        const buf = Buffer.concat(chunks);
        rec.bodySha256 = crypto.createHash("sha256").update(buf).digest("hex");
        try { body = JSON.parse(buf.toString("utf8")); } catch { body = null; }
      }
      if (body && typeof body === "object") {
        rec.model = typeof body.model === "string" ? body.model.slice(0, 160) : null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        rec.toolNames = tools.map(toolName).slice(0, 64);
        for (const t of tools) {
          if (!isAgentTool(toolName(t))) continue;
          const holder = typeof t.name === "string" ? t : t.function || t;
          if (typeof holder.description === "string") { rec.agentToolDescription = holder.description.slice(0, DESC_MAX); break; }
        }
        // X8 evidence, sizes and hashes only: the SHAPE of the system prompt, whether the harness's own markers occur in it, the indexes of blocks that carry cache_control, and
        // the sha256 of messages and of tools (compared by the harness with the hashes of what it sent: "byte-identical" is a hash comparison, no body is kept)
        rec.systemShape = SYS_SHAPES(body.system);
        const sysText = rec.systemShape === "absent" ? "" : JSON.stringify(body.system);
        for (const mk of current.markers ?? []) rec.markers[mk] = sysText.includes(mk);
        if (rec.systemShape === "array") { rec.sysBlocks = body.system.length; rec.sysCc = body.system.flatMap((b, i) => (b && typeof b === "object" && b.cache_control !== undefined ? [i] : [])); }
        rec.messagesLen = Array.isArray(body.messages) ? body.messages.length : null;
        // what turn of the conversation this is, without keeping a word of it: whether the harness's own USER markers occur in the messages (a boolean per marker) and how many tool_result blocks the messages hold
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const msgText = (current.userMarkers ?? []).length ? JSON.stringify(msgs) : "";
        for (const mk of current.userMarkers ?? []) rec.userMarkers[mk] = msgText.includes(mk);
        rec.toolResults = msgs.reduce((n, m) => n + (m && Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "tool_result").length : 0), 0);
        rec.messagesSha256 = sha256(JSON.stringify(body.messages ?? null));
        rec.toolsSha256 = sha256(JSON.stringify(body.tools ?? null));
        const m = MARKER_RE.exec(JSON.stringify(body.messages ?? []));
        if (m) {
          rec.marker = { label: m[1], n: Number(m[2]) };
          if (labelsFile) {
            try { fs.appendFileSync(labelsFile, JSON.stringify({ t: rec.t, sid: String(h["x-claude-code-session-id"] ?? "").slice(0, 64), label: m[1], n: Number(m[2]) }) + "\n"); }
            catch { /* the record below is still kept; a labels write failure is surfaced by the caller reading the file */ }
          }
        }
      }
      records.push(rec);
      if (records.length > RECORDS_MAX) records.shift();

      const isMessages = req.method === "POST" && /^\/v1\/messages(\?|$)/.test(String(req.url));
      if (!isMessages) { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"stub: unknown route"}'); return; }
      if (!body) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"stub: body is not JSON"}'); return; }
      // script.decide(rec): a per-request rule (for example a 429 for ONE model); a step it returns is used first, undefined or null falls through to the sequence
      let decided = null;
      try { decided = typeof current.decide === "function" ? current.decide(rec) : null; } catch { decided = null; }       // a throwing rule must never crash the stub: it falls through to the sequence
      let step;
      try { step = decided ? normaliseStep(decided) : pending.length ? pending.shift() : null; } catch { step = pending.length ? pending.shift() : null; }       // a bad step is ignored, not thrown
      if (step && step.cut) {                                       // a stream cut: message_start only, then the socket is destroyed
        rec.sent = { status: 200, retryAfter: null, cut: step.cut };
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(sseEvents(rec.model || "stub", [], "end_turn").split("\n\n")[0] + "\n\n", () => req.socket.destroy());
        return;
      }
      if (step && step.status !== 200) {
        rec.sent = { status: step.status, retryAfter: step.retryAfter, cut: null };
        const hdrs = { "content-type": "application/json", ...(step.retryAfter !== null ? { "retry-after": String(step.retryAfter) } : {}) };
        res.writeHead(step.status, hdrs);
        res.end(JSON.stringify({ type: "error", error: { type: ERROR_TYPE[step.status] ?? "api_error", message: "stub: scripted failure" } }));
        return;
      }
      if (!step && current.status && current.status !== 200) { rec.sent = { status: current.status, retryAfter: null, cut: null }; res.writeHead(current.status, { "content-type": "application/json" }); res.end('{"error":"stub: scripted failure"}'); return; }
      rec.sent = { status: 200, retryAfter: null, cut: null };

      const model = rec.model || "stub";
      const blocks = [];
      let stop = "end_turn";
      const isMain = rec.toolNames.some(isAgentTool) && h["x-claude-code-agent-id"] === undefined;
      const call = isMain && typeof current.onMain === "function" ? current.onMain(rec) : undefined;
      if (call && call.label) {
        const label = String(call.label).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || "x";
        const n = (counters.get(label) ?? 0) + 1;
        counters.set(label, n);
        blocks.push({ type: "tool_use", id: `toolu_stub_${seq}`, name: "Agent",
          input: { description: `scripted spawn ${label}`, subagent_type: String(call.subagent_type ?? "general-purpose"), prompt: `UWGT:${label}:${n}\nscripted task` } });
        stop = "tool_use";
        rec.sent.kind = "tool_use";
      } else {
        rec.sent.kind = "text";
        blocks.push({ type: "text", text: current.text ?? "stub-ok" });
      }
      const wantsStream = body.stream === true;
      if (wantsStream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(sseEvents(model, blocks, stop));
      } else {
        const content = blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text } : { type: "tool_use", id: b.id, name: b.name, input: b.input }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msg_stub", type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
      }
    });
  });

  return {
    records,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host }, () => { server.off("error", reject); resolve(server.address().port); });
    }),
    address: () => server.address(),
    stop: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
    setScript: (s) => { current = normaliseScript(s); pending = [...(current.sequence ?? [])]; },
    pending: () => pending.length,
    clear: () => { records.length = 0; },
    last: () => records[records.length - 1],
  };
}

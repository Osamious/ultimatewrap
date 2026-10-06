// Shared helpers of the tool-fidelity tests: fake answer streams, a fake fetch, and a temp-directory guard.
// Everything here is offline: no request leaves the process and no real state file is read or written.
import { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classOf, lvOf } from "../../refresh/tool-fidelity.mjs";
import { FIXTURE_ID, AWKWARD, BIG_RESULT_FACT } from "../../refresh/tool-fidelity-fixture.mjs";

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * A fresh, EMPTY directory directly under the OS temp folder. Refuses anything else, in the way the other fixture helpers do (an
 * earlier unguarded helper overwrote real state): `dir` must resolve under os.tmpdir(), must not be the home folder or hold it, and
 * must be absent or empty.
 */
export function freshDir(prefix = "uw-tf-") {
  const root = real(os.tmpdir()), dir = fs.mkdtempSync(path.join(root, prefix));
  checkTmpDir(dir);
  made.add(dir);
  return dir;
}
// Every directory freshDir made, removed when the test file finishes (an earlier version left about 50 per run behind). Only these: a directory something else
// made under the same prefix is never touched.
const made = new Set();
export const madeDirs = () => [...made];
export function cleanupDirs() {
  const n = made.size;
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* still held by a scanner: the OS temp cleaner gets it */ } }
  made.clear();
  return n;
}
after(cleanupDirs);
export function checkTmpDir(dir, { root = real(os.tmpdir()), home = os.homedir() } = {}) {
  const target = real(dir), h = real(home);
  if (norm(h) === norm(root) || norm(h).startsWith(norm(root) + path.sep)) throw new Error(`the temp root ${root} is, or contains, the home folder: refused`);
  if (!norm(target).startsWith(norm(root) + path.sep)) throw new Error(`directory must be inside ${root}, found ${target}: refused`);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`directory must be empty: ${target}: refused`);
  return target;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
export const ev = {
  start: (inTok) => sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", content: [], ...(inTok ? { usage: { input_tokens: inTok } } : {}) } }),
  tool: (index, name, json, id = `toolu_${index}`) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } })
    + [...json.matchAll(/[\s\S]{1,7}/g)].map((m) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: m[0] } })).join("")
    + sse("content_block_stop", { type: "content_block_stop", index }),
  text: (index, text) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
    + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) + sse("content_block_stop", { type: "content_block_stop", index }),
  stop: (reason = "end_turn", outTok = 5) => sse("message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: outTok } }) + sse("message_stop", { type: "message_stop" }),
  error: (message) => sse("error", { type: "error", error: { type: "api_error", message } }),
};
export const stream = (...parts) => [ev.start(), ...parts].join("");
/** A stream whose first event reports `inTok` input tokens (the usage a real provider sends). */
export const streamWith = (inTok, ...parts) => [ev.start(inTok), ...parts].join("");

/**
 * The sweep seam of every CLI test: backoffs of 1 to 2 ms and a gap of 1 ms, and a BOUNDED wake timer. The engine (refresh/bench.mjs runSweep) parks on a wake timer when every provider is paused or
 * busy; when a provider's pause ends between the engine's launch pass and its wake-time reading (a 1 ms backoff makes that likely: about 1 run in 50 with a rate-limited model) it computes no short
 * timer, and the only wake left is the max-minutes backstop (150 min): the run, and the suite, hang. The wake timer is therefore cut to 50 ms here, which turns a missed wake into a 50 ms delay: the loop
 * simply looks again. (Only the wake timer and the outage poll go through `timers`; a spurious early wake is harmless to the engine.)
 */
export const SWEEP_FAST = Object.freeze({ backoffBaseMs: 1, backoffMaxMs: 2, coolGapMs: 1, timers: Object.freeze({ set: (fn, ms, ...a) => setTimeout(fn, Math.min(ms, 50), ...a), clear: (h) => clearTimeout(h) }) });

/**
 * The default levels of a CLI run are L1+L2+L6+L7 (the baseline); most tests are about caps, holds, ledgers and queues in units of the L1+L2 request cost, so their `main` calls pin `--levels 12`
 * (unless the test names `--levels`, `--candidates` or `--sample` itself). The tests of the new default say so and do not use this.
 */
export const pinL12 = (argv) => (argv.some((a) => a === "--levels" || a === "--candidates" || a === "--sample") ? argv : ["--levels", "12", ...argv]);

/** A fetch that answers every call with `answer(call)` and records the calls: `{url, body, headers}`. */
export function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: String(url), headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null, bytes: init.body ? Buffer.byteLength(init.body) : 0 };
    calls.push(call);
    if (String(url).endsWith("/health")) return new Response("ok", { status: 200 });
    const a = await answer(call, calls.length);
    if (a instanceof Response) return a;
    return new Response(a.body ?? "", { status: a.status ?? 200, headers: a.headers ?? {} });
  };
  f.calls = calls;
  f.model = (c) => c.body?.model;
  return f;
}
export const ok = (body) => ({ status: 200, body, headers: { "content-type": "text/event-stream" } });
export const http = (status, message, headers = {}) => ({ status, body: JSON.stringify({ error: { message } }), headers });

/** Which request KIND a call is (read from its body): 1 (a simple echo call), 1f (forced), 1a (argument fidelity), 1af (forced),  2, 2e (error result), 3a (constructs), 3b (157 KB, parallel), 5 (big), 6 (spawn). */
export function kindOf(call) {
  const b = call.body, names = (b.tools ?? []).map((t) => t.name), last = b.messages.at(-1);
  if (names.length === 1 && names[0] === "Agent") return "6";
  if (names.length === 1 && names[0] === "fx_echo") return b.tool_choice?.type === "tool" ? "1f" : "1";
  if (names.length === 1 && names[0] === "fx_edit") return b.tool_choice?.type === "tool" ? "1af" : "1a";
  if (Array.isArray(last?.content) && last.content.some((c) => c.type === "tool_result")) return last.content.some((c) => c.is_error) ? "2e" : "2";
  if (names.includes("mcp__plugin_demo__a_long_tool_name_for_testing_construct_x") && names.length < 10) return "3a";
  return names.length > 100 ? "5" : "3b";
}
const ASKED = JSON.stringify({ file_path: AWKWARD.file_path, old_string: AWKWARD.old_string, new_string: AWKWARD.new_string, replace_all: AWKWARD.replace_all, start_line: AWKWARD.start_line });
/** The answer of a well-behaved model for the request kind it receives (read from the request, so one answer function serves a whole sweep). */
export function goodModel(call) {
  const k = kindOf(call), b = call.body;
  if (k === "1" || k === "1f") return ok(stream(ev.tool(0, "fx_echo", '{"message":"hello"}'), ev.stop("tool_use")));
  if (k === "1a" || k === "1af") return ok(stream(ev.tool(0, "fx_edit", ASKED), ev.stop("tool_use")));
  if (k === "2") return ok(stream(ev.text(0, `The deployment code is ${BIG_RESULT_FACT}.`), ev.stop()));
  if (k === "2e") return ok(stream(ev.text(0, "The file does not exist, so I cannot read its first line."), ev.stop()));
  if (k === "3a") return ok(stream(ev.tool(0, "mcp__plugin_demo__a_long_tool_name_for_testing_construct_x", '{"mode":"demo","limit":3}'), ev.stop("tool_use")));
  if (k === "6") return ok(stream(ev.tool(0, "Agent", JSON.stringify({ description: "Investigate auth", prompt: "Investigate the auth module: configuration, dependencies and tests.", subagent_type: "Explore" })), ev.stop("tool_use")));
  if (k === "5") return ok(stream(ev.tool(0, "fx_echo", '{"message":"ok"}'), ev.stop("tool_use")));
  void b;
  return ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "toolu_a"), ev.tool(1, "fx_echo", '{"message":"b"}', "toolu_b"), ev.stop("tool_use")));
}

/**
 * A stored record built straight from its fields, with every derived field (lv, t, ok) computed by the library's own rules: the shape a probe would have
 * written. `extra` carries the optional fields (strikes, sl, capBelow, big, alias, why, fx, maxBytes); an undefined value is left out.
 */
export function record(lvr, extra = {}, now = new Date("2026-10-05T10:00:00.000Z")) {
  const set = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
  const t = classOf({ lvr, ...set });
  return { lv: lvOf(lvr), lvr, t, ok: t === "v" || t === "t", at: now.toISOString(), fx: FIXTURE_ID, maxBytes: 0, ...set };
}

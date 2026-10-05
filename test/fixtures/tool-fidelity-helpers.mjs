// Shared helpers of the tool-fidelity tests: fake answer streams, a fake fetch, and a temp-directory guard.
// Everything here is offline: no request leaves the process and no real state file is read or written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classOf, lvOf } from "../../refresh/tool-fidelity.mjs";
import { FIXTURE_ID } from "../../refresh/tool-fidelity-fixture.mjs";

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
  return dir;
}
export function checkTmpDir(dir, { root = real(os.tmpdir()), home = os.homedir() } = {}) {
  const target = real(dir), h = real(home);
  if (norm(h) === norm(root) || norm(h).startsWith(norm(root) + path.sep)) throw new Error(`the temp root ${root} is, or contains, the home folder: refused`);
  if (!norm(target).startsWith(norm(root) + path.sep)) throw new Error(`directory must be inside ${root}, found ${target}: refused`);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`directory must be empty: ${target}: refused`);
  return target;
}

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
export const ev = {
  start: () => sse("message_start", { type: "message_start", message: { id: "m1", role: "assistant", content: [] } }),
  tool: (index, name, json, id = `toolu_${index}`) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } })
    + [...json.matchAll(/[\s\S]{1,7}/g)].map((m) => sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: m[0] } })).join("")
    + sse("content_block_stop", { type: "content_block_stop", index }),
  text: (index, text) => sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } })
    + sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text } }) + sse("content_block_stop", { type: "content_block_stop", index }),
  stop: (reason = "end_turn") => sse("message_delta", { type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: 5 } }) + sse("message_stop", { type: "message_stop" }),
  error: (message) => sse("error", { type: "error", error: { type: "api_error", message } }),
};
export const stream = (...parts) => [ev.start(), ...parts].join("");

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

/** The answer of a well-behaved model for the level the request is (read from the request, so one answer function serves a whole sweep). */
export function goodModel(call) {
  const b = call.body, last = b.messages.at(-1);
  const forced = !!b.tool_choice;
  if (Array.isArray(last?.content) && last.content[0]?.type === "tool_result") return ok(stream(ev.text(0, "It returned ping."), ev.stop()));
  if (forced) return ok(stream(ev.tool(0, "fx_echo", '{"message":"ping"}'), ev.stop("tool_use")));
  if (/twice/.test(String(last.content))) return ok(stream(ev.tool(0, "fx_echo", '{"message":"a"}', "toolu_a"), ev.tool(1, "fx_echo", '{"message":"b"}', "toolu_b"), ev.stop("tool_use")));
  return ok(stream(ev.tool(0, "fx_echo", '{"message":"ok"}'), ev.stop("tool_use")));
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

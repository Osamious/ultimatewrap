// The tool-fidelity ladder (issue #121): requests that ask, one at a time, whether a model really handles tools, each as cheap as it can be.
//
// LEVELS (what is stored) and the REQUESTS that answer them:
//   L1  one tool call, tool_choice AUTO as Claude Code sends it, a task that plainly requires the Edit-style call. The same call carries ARGUMENT FIDELITY (`af`: every field comes back
//       byte for byte, the boolean a boolean, the integer an integer). Only when auto yields no call is the call FORCED (`fc`): a model that passes only when forced is class t, not clean.
//   L2  a tool_result round trip with a ~20 KB result whose fact is at the END (`br`: the answer uses it); no 400, a final text answer.   L7: the same with an is_error result (`er`).
//   L3  3a: a ~6 KB request with the awkward constructs, an MCP-style long tool name (`nm`) and cache_control (`cc`): a construct rejection is the schema verdict and the model never pays
//       the 40,000 tokens. 3b: the ~157 KB fixture, which also asks two PARALLEL calls: accepted and answered is L3, parallel calls with streamed arguments is L4. 3a passing does not imply L3.
//   L5  the "big" step: the ~400 KB fixture, asked only of a model that passed L3 (kept out of the four-letter result string).   L6 `spawn`: the Agent tool, auto choice (`sp`).
//
// A request has three outcomes. `p` passed and `f` failed are VERDICTS about the model. `i` is INCONCLUSIVE: the answer says something about the account or the moment (a rate or tokens-
// per-minute limit, an empty balance, a dead key, a 5xx, a timeout, a budget spent on hidden reasoning), not about tools; the caller leaves the model un-recorded and tries again later.
//
// A failed verdict carries a `kind`: `size` (the provider refused the request for its SIZE: 413, a body naming size or context length, any refusal at the big step) or `schema` (anything else).
//
// COST DISCIPLINE. Each request has its own small max_tokens and its own timeout class; the stream is CANCELLED once the content the level needs is complete (a model that keeps talking
// after its calls costs no more output); a thinking-only stop is asked once more with a larger budget. Deep levels (above L2) are clamped away for any provider that is not on the `free` tier:
// that rule lives HERE, in `probeModel`, so a caller that builds its own queue is still bound by it (see `liftDeepProbes` in tool-fidelity.mjs).
//
// Every dependency is injected (fetch, clock) so the ladder runs in tests against fake streams. Nothing here reads a key or a file.

import { createSseParser, classifyHttp, classifyTight, parseRetryAfter, extractMessage } from "./bench.mjs";
import { redactClip } from "../menu/redact.mjs";
import { CONTRACT as CCR } from "../menu/ccr-client.mjs";
import {
  fixture, bigFixture, constructsTools, echoTool, editTool, readTool, agentTool, bigResult, AWKWARD, BIG_RESULT_FACT, ERROR_RESULT, CACHE_CONTROL,
  ECHO_TOOL, EDIT_TOOL, READ_TOOL, AGENT_TOOL, LONG_TOOL, AGENT_TYPES,
} from "./tool-fidelity-fixture.mjs";

export const LEVEL_NUMBERS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export const NOT_FREE_REASON = "not-free-tier (skipped for now)";   // the ledger reason of a model whose key tier is not free: it is not probed at any level
export const MAX_MODEL_REQUESTS = 12;      // a HARD ceiling on the requests sent to one model in a run (every level, retry, escalation, forced fallback and cache_control re-ask); reaching it is pending: request-cap, never a verdict
const ERROR_BODY_BYTES = 2048;             // how much of a refusal is read
export const ESCALATED_MAX_TOKENS = 2048;  // the ONE bump for a model whose whole budget went on thinking (see probeModel)
/** The output budget of each request: just enough for the answer it asks for. */
export const BUDGETS = Object.freeze({ "1": 256, "1f": 256, "1a": 512, "1af": 512, "2": 256, "2e": 256, "3a": 256, "3b": 256, "5": 512, "6": 512 });
export const PROBE_MAX_TOKENS = BUDGETS["1"];          // the smallest budget; kept as the name callers print
/** Timeout classes in ms: small requests, the 157 KB request, the 400 KB request. A timeout is inconclusive, never a verdict. */
// Timeouts are ADAPTIVE: 3 x the model's own bench total time, between a floor and a cap per request class (the floors alone for a model with no bench record). The real free-tier
// latency through the gateway is far above a fixed few seconds, and a timeout is never a verdict. A timed-out request is asked once more at DOUBLE the time inside the same run.
export const TIMEOUTS_MS = Object.freeze({ small: 45000, "157": 90000, big: 120000 });          // the floors
export const TIMEOUT_CAPS_MS = Object.freeze({ small: 120000, "157": 180000, big: 240000 });
export const TIMEOUT_FACTOR = 3;
/** The timeouts of one model, in ms per request class: `TIMEOUT_FACTOR` x its bench total time (`rec.d`), clamped to [floor, cap]; the floors when the bench has no usable time for it. */
export function timeoutsFor(rec, floors = TIMEOUTS_MS, caps = TIMEOUT_CAPS_MS) {
  const d = Number.isFinite(rec?.d) && rec.d > 0 ? rec.d : null;
  const one = (k) => (d === null ? floors[k] : Math.min(caps[k], Math.max(floors[k], TIMEOUT_FACTOR * d)));
  return { small: one("small"), "157": one("157"), big: one("big") };
}
const CLASS_OF = Object.freeze({ "1": "small", "1f": "small", "1a": "small", "1af": "small", "2": "small", "2e": "small", "3a": "small", "3b": "157", "5": "big", "6": "small" });
const LEVEL_OF = Object.freeze({ "1": 1, "1f": 1, "1a": 1, "1af": 1, "2": 2, "2e": 7, "3a": 3, "3b": 3, "5": 5, "6": 6 });
const EXPECT_TOOLS = Object.freeze({ "1": 1, "1f": 1, "1a": 1, "1af": 1, "2": 0, "2e": 0, "3a": 1, "3b": 2, "5": 1, "6": 1 });
const WHY_CHARS = 160;
const STREAM_CHAR_CAP = 40000;             // a model that never stops streaming is judged on what it sent so far
const AFTER_DONE_EVENTS = 50;              // events read after the expected calls are closed while waiting for the usage event
// Limits on what one answer may cost us to read (a hostile or broken upstream): bytes, events and blocks.
export const STREAM_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, events: 20000, blocks: 64 });

const ASK = Object.freeze({
  1: `Call the ${ECHO_TOOL} tool once with the message "hello".`,
  "1a": `Edit the file ${AWKWARD.file_path}: replace the text between <old> and </old> with the text between <new> and </new>, in every occurrence, starting from line ${AWKWARD.start_line}. Call the ${EDIT_TOOL} tool; copy both texts exactly, character for character.\n<old>${AWKWARD.old_string}</old>\n<new>${AWKWARD.new_string}</new>`,
  2: "The report you just read is above. What is the deployment code of this release? Answer in one short sentence.",
  "2e": "Read /ws/missing.txt and tell me its first line.",
  "3a": `Call the ${LONG_TOOL} tool with mode "demo" and limit 3.`,
  "3b": `Call the ${ECHO_TOOL} tool twice in the same turn: once with the message "a" and once with the message "b".`,
  5: `Call the ${ECHO_TOOL} tool once with the message "ok".`,
  6: "This repository has three independent modules: auth, billing and search. I need an investigation of each: where it is configured, what it depends on and what tests cover it. Do the three investigations in parallel by delegating them to sub-agents with the Agent tool.",
});
const ROUND_TRIP_ID = "toolu_fx0001";

const withCache = (tools) => { const t = structuredClone(tools); t[t.length - 1] = { ...t[t.length - 1], cache_control: { ...CACHE_CONTROL } }; return t; };
const systemBlocks = (text, cc) => (cc ? [{ type: "text", text, cache_control: { ...CACHE_CONTROL } }] : text);

/**
 * The request body of one KIND (`1`, `1f` forced, `2`, `2e`, `3a`, `3b`, `5`, `6`) for `model`. Pure: the planner measures these bytes, the probe sends them.
 * `noCc` leaves the cache_control markers off (a provider that rejected them is not sent them again).
 */
export function buildBody(kind, model, maxTokens = BUDGETS[kind], { noCc = false } = {}) {
  const base = { model, max_tokens: maxTokens, stream: true };
  const cc = !noCc;
  if (kind === "1" || kind === "1f") return { ...base, tools: [echoTool()], ...(kind === "1f" ? { tool_choice: { type: "tool", name: ECHO_TOOL } } : { tool_choice: { type: "auto" } }), messages: [{ role: "user", content: ASK[1] }] };
  if (kind === "1a" || kind === "1af") return { ...base, tools: [editTool()], ...(kind === "1af" ? { tool_choice: { type: "tool", name: EDIT_TOOL } } : { tool_choice: { type: "auto" } }), messages: [{ role: "user", content: ASK["1a"] }] };
  if (kind === "2" || kind === "2e") {
    const err = kind === "2e";
    return {
      ...base, tools: [readTool()],
      messages: [
        { role: "user", content: err ? ASK["2e"] : "Read /ws/report.txt and tell me the deployment code of the release it describes." },
        { role: "assistant", content: [{ type: "tool_use", id: ROUND_TRIP_ID, name: READ_TOOL, input: { file_path: err ? "/ws/missing.txt" : "/ws/report.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: ROUND_TRIP_ID, content: err ? ERROR_RESULT : bigResult(), ...(err ? { is_error: true } : {}) }, ...(err ? [] : [{ type: "text", text: ASK[2] }])] },
      ],
    };
  }
  if (kind === "3a") { const t = constructsTools(); if (!cc) delete t[t.length - 1].cache_control; return { ...base, system: systemBlocks("You are a coding assistant. Use the tools you are given.", cc), tools: t, messages: [{ role: "user", content: ASK["3a"] }] }; }
  if (kind === "6") return { ...base, tools: [agentTool()], tool_choice: { type: "auto" }, messages: [{ role: "user", content: ASK[6] }] };
  const fx = kind === "5" ? bigFixture() : fixture();
  return { ...base, system: systemBlocks(fx.system, cc), tools: cc ? withCache(fx.tools) : fx.tools, messages: [{ role: "user", content: ASK[kind === "5" ? 5 : "3b"] }] };
}

const sizeCache = new Map();
/** Bytes and an input-token estimate (bytes / 4, the figure the plan uses) of ONE request kind. */
export function kindSize(kind) {
  if (!sizeCache.has(kind)) { const bytes = Buffer.byteLength(JSON.stringify(buildBody(kind, "provider/model"))); sizeCache.set(kind, { bytes, inTokens: Math.ceil(bytes / 4) }); }
  return sizeCache.get(kind);
}
/** The request kinds a todo list sends, in order: L3 is 3a then 3b (3b also answers L4); L4 alone is 3b; L7 is the error-result request. */
export const kindsOf = (todo) => {
  const t = new Set(todo), out = [];
  if (t.has(1)) out.push("1", "1a");
  if (t.has(2)) out.push("2");
  if (t.has(7)) out.push("2e");
  if (t.has(3)) out.push("3a", "3b"); else if (t.has(4)) out.push("3b");
  if (t.has(5)) out.push("5");
  if (t.has(6)) out.push("6");
  return out;
};
/** Bytes and input tokens of one LEVEL as the plan counts them (L4 rides in the L3 request: no cost of its own unless it is asked alone; `withLevel3` says L3 is in the same todo). */
export function levelSize(level, { withLevel3 = true } = {}) {
  const kinds = level === 3 ? ["3a", "3b"] : level === 4 ? (withLevel3 ? [] : ["3b"]) : kindsOf([level]);
  return kinds.reduce((a, k) => ({ bytes: a.bytes + kindSize(k).bytes, inTokens: a.inTokens + kindSize(k).inTokens, requests: a.requests + 1 }), { bytes: 0, inTokens: 0, requests: 0 });
}

const clip = (s) => redactClip(String(s ?? "").replace(/\s+/g, " ").trim(), WHY_CHARS);
const pass = (extra = {}) => ({ v: "p", ...extra });
const fail = (why, extra = {}) => ({ v: "f", why: clip(why), kind: "schema", ...extra });
const inconclusive = (s, why, extra = {}) => ({ v: "i", s, why: clip(why), ...extra });

// Read on the provider's OWN sentence (never on the whole body, which can echo a tool name such as `check_balance`): the account is out of money in words the bench's reader does not know
// ("Your wallet balance is insufficient. Recharge at ..."), or the route says the model must be called another way. Neither says anything about the model.
const WALLET_WORDS = /(wallet|account|credit|balance)[^.]{0,40}(insufficient|too low|empty|exhausted|depleted|not enough)|(insufficient|not enough|no remaining|out of) [^.]{0,20}(credits?|balance|funds|wallet|quota)|(please |kindly )?(recharge|top[ -]?up) (your|at|to|the)|credit limit (reached|exceeded|is)|payment required|add (funds|credits)/i;
const ROUTE_WORDS = /must be called (via|through|at|using)|should be called (via|through|at)|wrong endpoint|use (the )?\/[\w./{}-]*v\d[\w./{}-]*|unsupported protocol|not supported (on|at) this (endpoint|route|api)|(only|exclusively) (available|supported) (via|on|at|through) [^.]{0,40}(\/v\d|messages|chat\/completions)/i;
// A 400 whose sentence names none of these says nothing about the request's shape ("Upstream provider rejected the request"): an upstream hiccup until it repeats word for word.
const SCHEMA_WORDS = /thought_signature|empty content|assistant messages?|schema|tools?\b|function|parameter|argument|format|propert|field|required|json|enum|anyof|oneof|\$ref|tool_choice|input|type\b|unsupported|not supported|invalid|malformed|validation|too (large|big|long)|context|token/i;
/** The tight reading of a refusal text, plus the two shapes above: `{s, reason?, hint?}` or null. */
function tightRead(text) {
  const t = classifyTight(text);
  if (t) return { s: t };
  const msg = extractMessage(text);
  if (WALLET_WORDS.test(msg)) return { s: "pay" };
  if (ROUTE_WORDS.test(msg)) return { s: "error", reason: "route-shape", hint: clip(msg).slice(0, 120) };
  return null;
}
/** What the provider's own sentence in a refusal says about the ACCOUNT or the ROUTE, for records written before those readings existed: `"pay"`, `"route-shape"` or null. */
export const accountOrRoute = (text) => { const t = tightRead(text); return t ? (t.s === "pay" ? "pay" : t.reason ?? null) : null; };
/**
 * A sentence about AVAILABILITY, not about the request ("The selected model is temporarily unavailable. Try another model.", "Upstream request failed.", service unavailable, please retry, an internal error,
 * overload, capacity): it says nothing about tools, whatever the status, so it is NEVER a verdict and never a strike toward x. Unless the same sentence names the schema or the tool choice as the problem.
 */
export const AVAIL_WORDS = /temporar(il)?y[ -]?(un)?available|try another model|upstream (request |provider |service )?(failed|error|rejected|unavailable)|service (is )?(temporarily )?unavailable|currently unavailable|please (re)?try|\bretry\b|internal (server )?error|overload|at capacity|bad gateway|gateway time-?out|no (healthy )?(upstream|backend)/i;
const NAMES_REQUEST = /schema|tool[ _-]?choice|tools?\.\d|input_schema|parameter|propert|anyof|oneof|\$ref|function call|thought_signature|empty content/i;
/** Whether a refusal text is about availability only (see AVAIL_WORDS), read on the provider's own sentence. */
export const isAvailabilityText = (text) => { const m = extractMessage(text); return AVAIL_WORDS.test(m) && !NAMES_REQUEST.test(m); };
/**
 * The gateway's own translation of an Anthropic request to the provider's shape fails ("Function call is missing a thought_signature in functionCall parts", "Empty content is not allowed for
 * assistant messages" for an assistant turn that has only a tool_use): a real failure for practical use through this gateway, but not a limit of the model. The record stays x and is tagged `xw: gateway`.
 */
export const GATEWAY_WORDS = /thought_signature|empty content is not allowed for assistant messages/i;

const TRANSIENT_WORDS = /overload|rate.?limit|too many|try again|timed? ?out|unavailable|capacity|temporar|busy|quota/i;
// A refusal that is about the account's allowance or the moment, never about the model, whatever the status (a 413 can say this too).
const LIMIT_WORDS = /per[ -]minute|per[ -]second|per[ -]day|tokens? per|requests? per|\btpm\b|\brpm\b|rate[ -]?limit|too many requests|quota|try again (in|later)|retry (in|after)/i;
// A refusal that is about the request's SIZE.
const SIZE_WORDS = /too (large|big|long)|entity too large|payload|request size|content[ -]length|body (is )?too|exceeds? (the )?(maximum|max|limit|size)|maximum (context|request|content|body)|context[ -]?(length|window)|input is too|prompt is too|too many tokens|reduce the (length|size)/i;
// The provider saying the model or its route cannot take tools at all: a verdict about the model, even when it comes as a 404.
const NOTOOLS = /no endpoints? (found )?(that )?(support|supporting)\w* (tool|function)|(does(n'?t| not)|do(n'?t| not)) support (tool|function)|(tools?|function[ -]?calling|tool[ -]use) (is |are )?(not|un)supported|unsupported.{0,20}\btools?\b|tool use is not (available|supported)|tools? (is|are) not (available|enabled)/i;
// A 400 that names the cache_control marker, and one that names the tool NAME (its length or pattern).
const CC_WORDS = /cache[ _-]?control/i;
const NAME_WORDS = /(tool|function)[ _.-]?name|name.{0,40}(too long|exceed|max(imum)? length|must (match|be)|pattern|invalid|does not match)|tools\.\d+\.name|\^\[a-zA-Z0-9_-\]/i;

/** The streamed arguments of one tool_use block: the joined partial_json, or the object the start event carried. */
function argsOf(block) {
  const raw = block.json === "" ? JSON.stringify(block.start ?? {}) : block.json;
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v } : { ok: false }; }
  catch { return { ok: false }; }
}

/**
 * Reads the answer stream into `{blocks, streamError, stopped, events, stopReason, overflow, inTok, outTok}`. Never throws on a malformed event. With `expect` (the number of
 * tool_use blocks the level needs) it STOPS reading, and cancels the stream, once that many are closed and the usage event has been seen (or a few more events have passed).
 */
async function readStream(res, { signal, expect = 0 } = {}) {
  const reader = res.body?.getReader?.();
  if (!reader) return { noBody: true, blocks: [], streamError: null, stopped: false };
  const dec = new TextDecoder(), parser = createSseParser();
  const blocks = new Map(), closed = new Set();
  let streamError = null, stopped = false, chars = 0, events = 0, stopReason = null, bytes = 0, overflow = false, inTok = null, outTok = null, sawUsage = false, after = 0, early = false;
  const block = (index) => {
    let b = blocks.get(index);
    if (!b && blocks.size < STREAM_LIMITS.blocks) { b = { type: null, name: null, id: null, start: null, json: "", text: "" }; blocks.set(index, b); }
    return b ?? null;
  };
  try {
    scan: for (;;) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      bytes += typeof value === "string" ? value.length : value?.byteLength ?? 0;
      if (bytes > STREAM_LIMITS.bytes) { overflow = true; break; }
      for (const ev of parser.push(typeof value === "string" ? value : dec.decode(value, { stream: true }))) {
        events += 1;
        if (events > STREAM_LIMITS.events) { overflow = true; break scan; }
        const d = ev.data;
        if (ev.type === "message_start") { const n = d?.message?.usage?.input_tokens; if (Number.isFinite(n)) inTok = n; }
        else if (ev.type === "content_block_start" && Number.isInteger(d?.index)) {
          const b = block(d.index);
          if (!b) { overflow = true; break scan; }
          const c = d.content_block ?? {};
          Object.assign(b, { type: c.type ?? null, name: c.name ?? null, id: c.id ?? null, start: c.input ?? null });
        } else if (ev.type === "content_block_delta" && Number.isInteger(d?.index)) {
          const b = block(d.index);
          if (!b) { overflow = true; break scan; }
          const dl = d.delta ?? {};
          if (dl.type === "input_json_delta") { b.json += dl.partial_json ?? ""; b.type ??= "tool_use"; chars += (dl.partial_json ?? "").length; }
          else if (dl.type === "text_delta") { b.text += dl.text ?? ""; b.type ??= "text"; chars += (dl.text ?? "").length; }
          else if (dl.type === "thinking_delta") { b.type ??= "thinking"; chars += (dl.thinking ?? "").length; }
        } else if (ev.type === "content_block_stop" && Number.isInteger(d?.index)) closed.add(d.index);
        else if (ev.type === "message_delta") {
          if (typeof d?.delta?.stop_reason === "string") stopReason = d.delta.stop_reason;
          const n = d?.usage?.output_tokens; if (Number.isFinite(n)) outTok = n;
          sawUsage = true;
        } else if (ev.type === "error") streamError = d?.error?.message ?? "stream error";
        else if (ev.type === "message_stop") { stopped = true; break scan; }
        if (chars > STREAM_CHAR_CAP) break scan;
        // the needed content is complete: every expected call is closed and the usage has been seen (or enough events have passed without it): stop paying for output
        if (expect > 0 && [...blocks].filter(([i, b]) => b.type === "tool_use" && closed.has(i)).length >= expect) {
          if (sawUsage || ++after > AFTER_DONE_EVENTS) { early = true; break scan; }
        }
      }
    }
  } finally {
    let t;
    try { await Promise.race([Promise.resolve(reader.cancel()), new Promise((r) => { t = setTimeout(r, 500); })]); } catch { /* closed */ }
    clearTimeout(t);
  }
  return { blocks: [...blocks.values()], streamError, stopped, events, stopReason, overflow, inTok, outTok, early };
}

const toolBlocks = (r) => r.blocks.filter((b) => b.type === "tool_use");
const textOf = (r) => r.blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

const count = (str, ch) => str.split(ch).length - 1;
/** The first difference between the string that was sent and the string that came back, in a few words (at most 60 characters in all): the kind of mangling, not the text. */
function stringDiff(want, got) {
  if (got.replace(/\r\n/g, "\n") === want) return "CRLF line endings";
  if (got.trimEnd() === want.trimEnd()) return "trailing whitespace changed";
  if (got.normalize("NFC") === want.normalize("NFC")) return "unicode normalisation (NFC/NFD)";
  if (got.includes("\\u") && !want.includes("\\u")) return "unicode escaped as \\u";
  if (got.replace(/\\\\/g, "\\") === want && got !== want) return "backslash doubled";
  if (count(want, "\n") > 0 && count(got, "\n") === 0) return "newline lost";
  if (got.replace(/\s+/g, " ") === want.replace(/\s+/g, " ")) return "whitespace collapsed";
  if (count(want, "\n") !== count(got, "\n")) return "newline count differs";
  if (count(got, "\\") < count(want, "\\")) return "backslash lost";
  if (count(got, '"') !== count(want, '"')) return "quote changed";
  if (/[\ud800-\udbff]/.test(want) && !/[\ud800-\udbff]/.test(got)) return "astral character lost";
  let i = 0;
  while (i < want.length && want[i] === got[i]) i += 1;
  return `text differs at ${i}`;
}
/**
 * Argument fidelity of the Edit-style call: every field byte for byte, the boolean a boolean, the integer an integer. Exact on purpose: a real Edit finds its `old_string` only when it is
 * byte for byte what the file holds, so a lost newline, a doubled backslash, CRLF, a different Unicode normalisation or trailing whitespace is a call that fails in use, not a test being strict.
 * Key order, fields the schema does not name, a path written with "/" for "\\" and an optional parameter that was left out do not matter: the check means "would corrupt a real Edit". Returns `{af: "p"}` or `{af: "f", afw}`: `afw` is what differed (a few words, the first field that does).
 */
const AF_OPTIONAL = new Set(["replace_all", "start_line"]);                            // the schema does not require them: leaving one out changes the edit's reach, it corrupts no text
const samePath = (a, b) => typeof a === "string" && typeof b === "string" && a.replace(/\\/g, "/") === b.replace(/\\/g, "/");
export function afCheck(v) {
  for (const k of Object.keys(AWKWARD)) {
    const want = AWKWARD[k], got = v[k];
    if (got === want) continue;
    if (k === "file_path" && samePath(got, want)) continue;                                  // a path is a path: / and \\ are the same separator to every file tool
    if (got === undefined) { if (AF_OPTIONAL.has(k)) continue; return { af: "f", afw: `${k}: missing` }; }          // an optional parameter the model left out is not a mangled argument
    if (typeof got !== typeof want) return { af: "f", afw: `${k}: ${typeof want === "number" ? "integer" : typeof want} sent as ${typeof got}` };
    return { af: "f", afw: `${k}: ${typeof want === "string" ? stringDiff(want, got) : "value changed"}` };
  }
  return { af: "p" };
}

/** Judges the stream of one request KIND. Pure over `readStream`'s result. */
export function judge(kind, r) {
  if (r.noBody) return inconclusive("error", "HTTP 200 with no response body");
  if (r.overflow) return fail("the answer stream passed the size limits (too many bytes, events or blocks)");
  const tools = toolBlocks(r);
  // CONTENT means text or a tool call: a thinking block is not content. An answer that spent its budget on thinking and ended on max_tokens says nothing about tools, at any level.
  const usable = tools.length > 0 || !!textOf(r);
  if (r.streamError && isAvailabilityText(r.streamError)) return inconclusive("error", `stream error: ${r.streamError}`, { reason: "upstream-unavailable", hint: clip(extractMessage(r.streamError)).slice(0, 120) });
  if (r.streamError && !usable) {
    const tight = tightRead(r.streamError);
    if (tight) return inconclusive(tight.s, `stream error: ${r.streamError}`, tight.reason ? { reason: tight.reason, hint: tight.hint } : {});
    if (TRANSIENT_WORDS.test(r.streamError)) return inconclusive("error", `stream error: ${r.streamError}`);
    return fail(`stream error before any content: ${r.streamError}`);
  }
  if (!r.events) return inconclusive("error", "HTTP 200 with no stream events");
  if (!usable && r.stopReason === "max_tokens") return inconclusive("empty", "output budget spent before any text or tool call (stop_reason max_tokens)");
  const bad = tools.find((b) => !argsOf(b).ok);
  // a tool call cut off by the output budget (stop_reason max_tokens, arguments unfinished) says nothing about the model: the budget is asked once more, larger
  if (bad && r.stopReason === "max_tokens") return inconclusive("empty", "output budget spent in the middle of a tool call (stop_reason max_tokens)");
  if (kind === "1a" || kind === "1af") {
    if (!tools.length) return fail(textOf(r) ? "answered in text instead of calling the tool" : "no tool call in the answer", { nocall: true });
    if (bad) return pass({ af: "f", afw: "arguments not valid JSON" });
    const call = tools.find((b) => b.name === EDIT_TOOL);
    if (!call) return pass({ af: "f", afw: "called another tool" });
    return pass(afCheck(argsOf(call).value));
  }
  if (kind === "1" || kind === "1f") {
    if (!tools.length) return fail(textOf(r) ? "answered in text instead of calling the tool" : "no tool call in the answer", { nocall: true });
    if (bad) return fail("tool call arguments are not valid JSON");
    const call = tools.find((b) => b.name === ECHO_TOOL);
    if (!call) return fail("tool call names a tool that was not offered");
    if (typeof argsOf(call).value.message !== "string") return fail("a tool call lacks the required argument `message`");
    return pass();
  }
  if (kind === "2") {
    if (r.streamError) return fail(`stream error: ${r.streamError}`);
    const text = textOf(r);
    if (!text) return fail(tools.length ? "called the tool again instead of answering" : "no final answer after the tool result");
    return pass({ br: text.includes(BIG_RESULT_FACT) ? "p" : "f" });
  }
  if (kind === "2e") {
    if (r.streamError && !tools.length && !textOf(r)) return fail(`stream error: ${r.streamError}`);
    return textOf(r) || tools.length ? pass() : fail("empty answer after an error result");
  }
  if (kind === "6") {
    if (!tools.length) return fail(textOf(r) ? "answered in text instead of delegating" : "no tool call in the answer");
    if (bad) return fail("tool call arguments are not valid JSON");
    const call = tools.find((b) => b.name === AGENT_TOOL);
    if (!call) return fail("tool call names a tool that was not offered");
    const v = argsOf(call).value;
    if (typeof v.prompt !== "string" || v.prompt.trim().length < 10) return fail("the Agent call has no usable prompt");
    if (!AGENT_TYPES.includes(v.subagent_type)) return fail("the Agent call names a subagent_type that was not offered");
    if (typeof v.description !== "string") return fail("the Agent call lacks a description");
    return pass();
  }
  if (kind === "3a") {
    if (bad) return fail("tool call arguments are not valid JSON");
    if (r.streamError && !usable) return fail(`stream error: ${r.streamError}`);
    const named = tools.map((b) => b.name);
    // the name round trip: the long MCP-style name comes back exactly (`nm`), or a call came back under a different name; no call at all says nothing about names
    const nm = named.includes(LONG_TOOL) ? "p" : named.length ? "f" : undefined;
    return usable ? pass({ nm }) : fail("empty answer to the constructs request");
  }
  // 3b and 5: the large request was accepted and answered with something well formed; 3b also carries the parallel-call level (L4)
  if (bad) return fail("tool call arguments are not valid JSON");
  if (!usable) return fail("empty answer to the large request");
  if (r.streamError) return fail(`stream error: ${r.streamError}`);
  if (kind === "5") return pass();
  const echoes = tools.filter((b) => b.name === ECHO_TOOL);
  const par = echoes.length >= 2 && new Set(echoes.map((b) => b.id ?? b)).size >= 2 && echoes.every((b) => b.json !== "" && typeof argsOf(b).value.message === "string");
  return pass({ l4: par ? "p" : "f", ...(par ? {} : { l4why: echoes.length < 2 ? `${echoes.length} tool call instead of 2 parallel calls` : echoes.length >= 2 && echoes.some((b) => b.json === "") ? "the tool call arguments were not streamed (no argument deltas)" : "parallel tool calls share one id or lack the argument",
    l4w: echoes.length < 2 ? `${echoes.length} call of 2` : echoes.some((b) => b.json === "") ? "args not streamed" : "shared id or no arg" }) });
}

/** A server that cannot take the AUTO tool choice ("auto" tool choice requires --enable-auto-tool-choice): only a FORCED choice can pass, so this routes to the forced fallback and is never a strike by itself. */
const AUTO_REFUSED = /auto(matic)?"? tool[ _-]?choice|enable-auto-tool-choice|tool[_ ]choice.{0,60}(\bauto\b|requires|not supported|unsupported|only)/i;
const autoRefused = (r) => (r.http === 400 || r.http === 422 || r.http === 501) && AUTO_REFUSED.test(String(r.body ?? ""));

/** The text of a refusal, at most `limit` bytes of it: the body is read in chunks and cancelled when enough has come, so a hostile or huge error page costs nothing. */
async function readBounded(res, limit) {
  try {
    const reader = res.body?.getReader?.();
    if (!reader) return String(await res.text()).slice(0, limit);
    const dec = new TextDecoder();
    let text = "", bytes = 0;
    while (bytes < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength; text += dec.decode(value, { stream: true });
    }
    try { await Promise.race([Promise.resolve(reader.cancel()), new Promise((r) => setTimeout(r, 200).unref?.())]); } catch { /* closed */ }
    return text.slice(0, limit);
  } catch { return ""; }                                                                         // an unreadable body
}

/** One request and its judgement; `body` is the request text. Resolves `{v, ..., bytes, ms, inTok, outTok}` or `{aborted: true}`; never rejects. */
async function send(kind, body, { fetchImpl, url, key, timeoutMs, signal, now = () => performance.now() }) {
  const bytes = Buffer.byteLength(body);
  const t0 = now();
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  const tele = (extra = {}) => ({ bytes, ms: Math.round(now() - t0), ...extra });
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", [CCR.clientHeader]: CCR.probeClient },
      body, signal: ac.signal,
    });
    if (!res.ok) {
      const text = await readBounded(res, ERROR_BODY_BYTES);
      const ra = parseRetryAfter(res.headers?.get?.("retry-after"));
      return { ...httpVerdict(kind, res.status, text, ra), http: res.status, body: text, ...tele() };
    }
    const rs = await readStream(res, { signal: ac.signal, expect: EXPECT_TOOLS[kind] });
    return { ...judge(kind, rs), ...tele({ inTok: rs.inTok, outTok: rs.outTok, early: rs.early }) };
  } catch (e) {
    if (timedOut) return { ...inconclusive("timeout", `no complete answer within ${timeoutMs} ms`), ...tele() };
    if (signal?.aborted) return { aborted: true };
    return { ...inconclusive("error", e?.message ?? e), ...tele() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * What an HTTP refusal means. A 400, 413 or 422 on a tool-bearing request is the model or its provider refusing the request itself: a verdict, unless the sentence is about the ACCOUNT
 * (`classifyTight`) or a LIMIT of the moment (tokens per minute, rate: a 413 can say that too). A route that says it has no tool support is a verdict even as a 404. A 400 that names
 * cache_control is flagged (`ccFail`) so the caller can ask again without it and still learn the level; one that names the tool name is a verdict flagged `nmFail`. Everything else
 * (401, 402, 403, 404, 429, 5xx) is read by `classifyHttp` and is inconclusive.
 */
function httpVerdict(kind, status, text, ra) {
  const extra = ra !== null && ra !== undefined ? { ra } : {};
  const why = `HTTP ${status}: ${text}`;
  const clientErr = status === 400 || status === 413 || status === 422;
  if (NOTOOLS.test(text) && (clientErr || status === 404)) return fail(why, { kind: "schema" });
  if (clientErr) {
    const tight = tightRead(text);
    if (tight) return inconclusive(tight.s, why, { ...extra, ...(tight.reason ? { reason: tight.reason, hint: tight.hint } : {}) });
    if (LIMIT_WORDS.test(text)) return inconclusive("rate", why, extra);
    // availability, or a 400 that names nothing about the request: never a verdict (pending upstream-unavailable, asked again by a later run). At the big step an unnamed 400 stays a size refusal.
    const msg400 = extractMessage(text);
    if (isAvailabilityText(text) || (status === 400 && kind !== "5" && !SCHEMA_WORDS.test(msg400))) return inconclusive("error", why, { ...extra, reason: "upstream-unavailable", hint: clip(msg400).slice(0, 120) });
    if (CC_WORDS.test(text) && (kind === "3a" || kind === "3b" || kind === "5")) return fail(why, { kind: "schema", ccFail: true });
    const size = status === 413 || SIZE_WORDS.test(text) || kind === "5";       // a refusal only at the big step, after the 157 KB step was accepted, is about size
    return fail(why, { kind: size && kind !== "3a" ? "size" : "schema", ...(NAME_WORDS.test(text) && kind === "3a" ? { nmFail: true } : {}), ...(GATEWAY_WORDS.test(text) ? { gw: true } : {}) });
  }
  return inconclusive(classifyHttp(status, text), why, extra);
}

/**
 * One request kind against one model. Resolves `{v, why?, kind?, s?, ra?, http?, bytes, ms, reqs, ...fields}` or `{aborted: true}`; never rejects. `noCc` (state) keeps the markers off.
 * L1 is asked with the choice left to the model; only when that yields NO call is it asked FORCED (`forced: true` on the result, with the forced answer), and a forced request the
 * backend rejects for tool_choice leaves the auto verdict standing.
 */
export async function runKind(kind, { fetchImpl = fetch, url, key, model, maxTokens, timeoutMs, timeouts = TIMEOUTS_MS, signal = null, noCc = false } = {}) {
  const conn = { fetchImpl, url, key, signal };
  const budget = maxTokens ?? BUDGETS[kind];
  const limit = timeoutMs ?? timeouts[CLASS_OF[kind]];
  const go = (k) => send(k, JSON.stringify(buildBody(k, model, budget, { noCc })), { ...conn, timeoutMs: limit });
  const first = await go(kind);
  if (first.aborted) return first;
  if ((kind === "1" || kind === "1a") && first.v === "f" && (first.nocall || autoRefused(first))) {
    const forced = await go(kind === "1" ? "1f" : "1af");
    if (forced.aborted) return forced;
    if (forced.v === "i") return { ...forced, reqs: 2 };
    if (kind === "1a") return { ...forced, reqs: 2, forced: true, ms: first.ms + forced.ms };
    if (forced.http === 400 && /tool_choice/i.test(forced.body ?? "")) return { ...first, reqs: 2, forcedRejected: true };       // the backend does not take a forced choice: the auto answer stands
    return { ...forced, reqs: 2, forced: true, fc: forced.v === "p" ? "p" : "f", ms: first.ms + forced.ms };
  }
  return { ...first, reqs: 1 };
}

// ------------------------------------------------------------------ the engine

/**
 * The deep-probe rule, in one place: levels above L2 are sent only for a provider whose key tier is `free`, or whose tier an explicit, validated lift names (`lift` is the
 * frozen capability `liftDeepProbes` hands out; nothing else, no string, no flag, no environment variable, is accepted). An unknown tier is NOT free.
 */
export const LIFTS = new WeakSet();
export const deepAllowed = (tier, lift = null) => tier === "free" || (!!lift && LIFTS.has(lift) && Array.isArray(lift.tiers) && lift.tiers.includes(tier));

/**
 * The levels asked for one model, in order. `done` (mutated) holds the verdicts already reached for it, so a retry after an inconclusive request repeats only that one. L3 and L4
 * need L1 and L2 passed, L5 needs L3 passed, L6 and L7 need L1 and L2 passed (`prior` is the stored per-level string, `nnnn` for none; `flags` the stored record, for the markers).
 * A model whose key tier is not `free` (and is not lifted: `deepAllowed(tier, lift)`) is not probed AT ALL, at any level including L1 and L2: every asked level is recorded
 * `{v: "n", why: NOT_FREE_REASON, clamped: true}`, zero requests are sent and the result is `{done, requests: 0, clamped: [every level], tele}`. A lifted tier may get any level that was asked.
 * `order: "big-first"` with a known `ctx` of at least 200,000 asks the big step before L3: a pass implies L3 (recorded `implied`, the 157 KB requests are skipped); a failure then
 * runs L3 to locate the cause. Resolves
 *   `{aborted: true}`
 *   `{inconclusive: {s, why, ra?, reason?, escalated?}, requests, tele}`   nothing is recorded; the model is tried again later
 *   `{done, requests, escalated?, tele, clamped}`                         every asked level has a verdict; `done` maps level -> {v, why?, kind?, bytes?, ...fields}
 * THINKING-ONLY ESCALATION. An answer that was only thinking and stopped at max_tokens is inconclusive. The first time it happens for a model in this run, the SAME request is asked
 * again once with `ESCALATED_MAX_TOKENS` (and the model's later requests use it: `state`, kept by the caller across the engine's retries, holds `{maxTokens, escalated, noCc}`).
 * Still empty after the bump: inconclusive `empty` with `reason: "reasoning-budget"`, never a failure.
 */
export async function probeModel({ levels, prior = "nnnn", flags = null, done = {}, state = {}, tier = null, lift = null, order = "l3-first", ctx = 0, tele = [], ...conn }) {
  let requests = 0;
  const deep = deepAllowed(tier, lift);
  const want = [...new Set(levels)].sort((a, b) => a - b);
  const clamped = [];
  if (!deep) {                                                                                       // the owner's rule, enforced here so no entry point can get round it
    for (const l of want) { if (!done[l]) done[l] = { v: "n", why: NOT_FREE_REASON, clamped: true }; clamped.push(l); }
    return { done, requests: 0, tele, clamped };
  }
  const passed = (n) => (done[n]?.v ?? (prior[n - 1] === "p" ? "p" : "n")) === "p";
  const kindBudget = (k) => Math.max(conn.maxTokens ?? BUDGETS[k], state.maxTokens ?? 0);
  if (flags?.cc === "f") state.noCc = true;
  const CAPPED = { v: "i", s: "error", why: `the request ceiling of ${MAX_MODEL_REQUESTS} for one model was reached`, capped: true };
  const spent = (r) => { requests += r.reqs ?? 1; state.requests = (state.requests ?? 0) + (r.reqs ?? 1); };
  const ask = async (kind) => {
    if ((state.requests ?? 0) >= MAX_MODEL_REQUESTS) return CAPPED;
    const base = (conn.timeouts ?? TIMEOUTS_MS)[CLASS_OF[kind]];
    const opts = { ...conn, maxTokens: kindBudget(kind), noCc: !!state.noCc, timeoutMs: base * (state.tmult ?? 1) };
    let r = await runKind(kind, opts);
    if (r.aborted) return r;
    spent(r);
    const teleOf = (x, max) => ({ kind, level: LEVEL_OF[kind], bytes: x.bytes ?? 0, ms: x.ms ?? 0, inTok: x.inTok ?? null, outTok: x.outTok ?? null, v: x.v, s: x.s, early: !!x.early, reqs: x.reqs ?? 1, max });
    if (r.v === "i" && r.s === "empty" && !state.escalated && kindBudget(kind) < ESCALATED_MAX_TOKENS) {
      if ((state.requests ?? 0) >= MAX_MODEL_REQUESTS) return CAPPED;
      state.escalated = true; state.maxTokens = ESCALATED_MAX_TOKENS;
      tele.push(teleOf(r, opts.maxTokens));                                       // the thinking-only request was sent and its output spent: it is accounted for too
      r = await runKind(kind, { ...conn, maxTokens: ESCALATED_MAX_TOKENS, noCc: !!state.noCc });
      if (r.aborted) return r;
      spent(r);
    }
    tele.push(teleOf(r, state.escalated ? ESCALATED_MAX_TOKENS : opts.maxTokens));
    // a timeout: asked once more at DOUBLE the time inside this run (it counts toward the request ceiling, and the model's later requests keep the doubled time); a second timeout at the
    // doubled value ends the model for this run: on L1 as "slow" (with the seconds it was given), elsewhere as a plain timeout. Never a verdict.
    if (r.v === "i" && r.s === "timeout") {
      if ((state.tmult ?? 1) < 2) { state.tmult = 2; return ask(kind); }
      return kind === "1" ? { ...r, slow: true, secs: Math.round((opts.timeoutMs ?? 0) / 100) / 10 } : r;
    }
    // a 400 that names cache_control: note it, stop sending the markers to this model and ask the same request again so the level is still learned
    if (r.ccFail && !opts.noCc) { state.noCc = true; state.ccFail = true; const again = await ask(kind); return again.aborted || again.v === "i" ? again : { ...again, cc: "f" }; }
    return r;
  };
  const stop = (r) => (r.slow
    ? { inconclusive: { s: "timeout", reason: "slow", secs: r.secs, why: r.why }, requests, tele }
    : r.capped
    ? { inconclusive: { s: "error", reason: "request-cap", why: r.why }, requests, tele }
    : r.v === "i" && r.s === "empty"
    ? { inconclusive: { s: "empty", reason: "reasoning-budget", why: r.why, ...(state.escalated ? { escalated: true } : {}) }, requests, tele }
    : { inconclusive: { s: r.s, why: r.why, ...(r.ra !== undefined ? { ra: r.ra } : {}), ...(r.http ? { http: r.http } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.hint ? { hint: r.hint } : {}) }, requests, tele });

  const bigFirst = order === "big-first" && ctx >= 200000 && want.includes(5) && deep;
  const row = (r, extra = {}) => ({ v: r.v, ...(r.why ? { why: r.why } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(r.gw ? { gw: true } : {}), ...extra });
  // L3: 3a (constructs), then 3b (157 KB, which also answers L4). 3a's verdict is kept in `state` so a retry after an inconclusive 3b does not ask it again.
  const doL3 = async () => {
    if (!state.l3a) {
      const a = await ask("3a");
      if (a.aborted) return a;
      if (a.v === "i") return stop(a);
      state.l3a = { v: a.v, why: a.why, kind: a.kind, nm: a.nmFail ? "f" : a.nm, cc: state.ccFail ? "f" : a.cc ?? (state.noCc ? undefined : "p") };
    }
    const { nm, cc } = state.l3a, marks = { ...(nm ? { nm } : {}), ...(cc ? { cc } : {}) };
    if (state.l3a.v === "f") { done[3] = { v: "f", why: `[3a] ${state.l3a.why}`, kind: state.l3a.kind, ...marks }; return null; }
    const b = await ask("3b");
    if (b.aborted) return b;
    if (b.v === "i") return stop(b);
    done[3] = { v: b.v, ...(b.why ? { why: `[3b] ${b.why}` } : {}), ...(b.kind ? { kind: b.kind } : {}), bytes: b.bytes, ...marks };
    if (b.v === "p" && b.l4) done[4] = { v: b.l4, ...(b.l4why ? { why: b.l4why } : {}), ...(b.l4w ? { w: b.l4w } : {}), bytes: b.bytes };
    return null;
  };
  const doBig = async () => {
    const r = await ask("5");
    if (r.aborted) return r;
    if (r.v === "i") return stop(r);
    done[5] = row(r, { bytes: r.bytes, ...(r.cc ? { cc: r.cc } : {}) });
    return null;
  };

  for (const level of want) {
    if (done[level]) continue;
    const pair = passed(1) && passed(2);
    const notRun = (why) => { done[level] = { v: "n", why }; };
    if (level === 1 || level === 2) {
      const r = await ask(level === 1 ? "1" : "2");
      if (r.aborted) return r;
      if (r.v === "i") return stop(r);
      done[level] = row(r, level === 1 ? { ...(r.fc ? { fc: r.fc } : {}) } : { ...(r.br ? { br: r.br } : {}) });
      if (level === 1 && r.v === "p") {
        // argument fidelity is its own small request AFTER L1 passed: awkward content (multi-line text, quotes, backslashes, unicode) in an Edit-style call. A failure sets `af` f and `afw` only: it is
        // never a strike and never lowers the class. No verdict (a timeout, a limit) leaves `af` unset.
        const a = await ask("1a");
        if (a.aborted) return a;
        if (a.v === "p") { done[1].af = a.af; if (a.afw) done[1].afw = a.afw; }
        else if (a.v === "f") { done[1].af = "f"; done[1].afw = a.nocall ? "no tool call" : a.http ? `HTTP ${a.http}` : "no usable call"; }
      }
    } else if (level === 3) {
      if (!pair) { notRun("not run: L1 and L2 did not both pass"); continue; }
      if (bigFirst && !done[5]) {
        const x = await doBig(); if (x) return x;
        if (done[5]?.v === "p") { done[3] = { v: "p", implied: "big", bytes: done[5].bytes, ...(done[5].cc ? { cc: done[5].cc } : {}) }; continue; }     // a pass at 400 KB implies the 157 KB step
      }
      const x = await doL3(); if (x) return x;
    } else if (level === 4) {
      if (!pair) { notRun("not run: L1 and L2 did not both pass"); continue; }
      if (!passed(3)) { notRun("not run: L3 did not pass"); continue; }
      const b = await ask("3b");                                                                    // L3 passed earlier (or by the big step): only the 157 KB request answers L4
      if (b.aborted) return b;
      if (b.v === "i") return stop(b);
      done[4] = b.v === "p" ? { v: b.l4 ?? "f", ...(b.l4why ? { why: b.l4why } : {}), ...(b.l4w ? { w: b.l4w } : {}), bytes: b.bytes } : { v: "n", why: "not run: the 157 KB request did not pass" };
    } else if (level === 5) {
      if (!pair) { notRun("not run: L1 and L2 did not both pass"); continue; }
      if (!bigFirst && !passed(3)) { notRun("not run: L3 did not pass"); continue; }                // (big-first asks it ahead of L3, above, and needs no L3)
      const x = await doBig(); if (x) return x;
    } else if (level === 6 || level === 7) {
      if (!pair) { notRun("not run: L1 and L2 did not both pass"); continue; }
      const r = await ask(level === 6 ? "6" : "2e");
      if (r.aborted) return r;
      if (r.v === "i") return stop(r);
      done[level] = row(r);
    }
  }
  return { done, requests, tele, clamped, ...(state.escalated ? { escalated: true } : {}) };
}

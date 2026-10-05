// The tool-fidelity ladder (issue #121): requests that ask, one at a time, whether a model really handles tools.
//
//   L1  one FORCED tool call comes back as a well-formed tool_use with valid JSON arguments (and the required argument)
//   L2  a tool_result round trip (assistant tool_use, user tool_result) ends in a final text answer, no 400
//   L3  the ~157 KB synthetic fixture (refresh/tool-fidelity-fixture.mjs) is accepted and answered
//   L4  two PARALLEL tool calls come back with STREAMED arguments, on the same fixture
//   L5  the "big" step: a ~400 KB fixture, asked only of a model that passed L3 (kept out of the four-letter result string)
//
// A level has three outcomes. `p` passed and `f` failed are VERDICTS about the model. `i` is INCONCLUSIVE: the answer says something
// about the account or the moment (a rate or tokens-per-minute limit, an empty balance, a dead key, a 5xx, a timeout, a budget spent on
// hidden reasoning), not about tools. An inconclusive level is never recorded as a failure (a billing problem is state, not death): the
// caller leaves the model un-recorded and it is tried again later.
//
// A failed verdict carries a `kind` that decides what the caller may conclude from it:
//   size     the provider refused the request for its SIZE (413, a body naming size or context length, any refusal at the big step)
//   schema   anything else that failed (a rejected schema, a missing tool call, a malformed answer)
//
// Every dependency is injected (fetch, clock) so the ladder runs in tests against fake streams. Nothing here reads a key or a file:
// the caller hands in the gateway URL and key, exactly as the bench does.

import { createSseParser, classifyHttp, classifyTight, parseRetryAfter } from "./bench.mjs";
import { redactClip } from "../menu/redact.mjs";
import { CONTRACT as CCR } from "../menu/ccr-client.mjs";
import { fixture, bigFixture, smallTools, ECHO_TOOL } from "./tool-fidelity-fixture.mjs";

export const LEVEL_NUMBERS = Object.freeze([1, 2, 3, 4, 5]);
export const PROBE_MAX_TOKENS = 512;       // room for a reasoning model to think and then call the tool
const WHY_CHARS = 160;
const STREAM_CHAR_CAP = 40000;             // a model that never stops streaming is judged on what it sent so far
// Limits on what one answer may cost us to read (a hostile or broken upstream): bytes, events and blocks.
export const STREAM_LIMITS = Object.freeze({ bytes: 2 * 1024 * 1024, events: 20000, blocks: 64 });

const PROMPTS = {
  1: `Call the ${ECHO_TOOL} tool with the message "ping".`,
  2: `Call the ${ECHO_TOOL} tool with the message "ping", then tell me in one short sentence what it returned.`,
  3: `Call the ${ECHO_TOOL} tool once with the message "ok".`,
  4: `Call the ${ECHO_TOOL} tool twice in the same turn: once with the message "a" and once with the message "b".`,
  5: `Call the ${ECHO_TOOL} tool once with the message "ok".`,
};
const ROUND_TRIP_ID = "toolu_fx0001";

/** The request body of one level for `model`. Pure: the planner measures these bytes, the probe sends them. `toolChoice: "auto"` is the L1 retry. */
export function buildBody(level, model, maxTokens = PROBE_MAX_TOKENS, { toolChoice = null } = {}) {
  const base = { model, max_tokens: maxTokens, stream: true };
  if (level === 1) return { ...base, tools: smallTools(), tool_choice: toolChoice === "auto" ? { type: "auto" } : { type: "tool", name: ECHO_TOOL }, messages: [{ role: "user", content: PROMPTS[1] }] };
  if (level === 2) {
    return {
      ...base, tools: smallTools(),
      messages: [
        { role: "user", content: PROMPTS[2] },
        { role: "assistant", content: [{ type: "tool_use", id: ROUND_TRIP_ID, name: ECHO_TOOL, input: { message: "ping" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: ROUND_TRIP_ID, content: "ping" }] },
      ],
    };
  }
  const fx = level === 5 ? bigFixture() : fixture();
  return { ...base, system: fx.system, tools: fx.tools, messages: [{ role: "user", content: PROMPTS[level] }] };
}

/** Bytes and an input-token estimate (bytes / 4, the figure the plan uses) for one level's request. */
export function levelSize(level, maxTokens = PROBE_MAX_TOKENS) {
  const bytes = Buffer.byteLength(JSON.stringify(buildBody(level, "provider/model", maxTokens)));
  return { bytes, inTokens: Math.ceil(bytes / 4) };
}

const clip = (s) => redactClip(String(s ?? "").replace(/\s+/g, " ").trim(), WHY_CHARS);
const pass = (extra = {}) => ({ v: "p", ...extra });
const fail = (why, extra = {}) => ({ v: "f", why: clip(why), kind: "schema", ...extra });
const inconclusive = (s, why, extra = {}) => ({ v: "i", s, why: clip(why), ...extra });

const TRANSIENT_WORDS = /overload|rate.?limit|too many|try again|timed? ?out|unavailable|capacity|temporar|busy|quota/i;
// A refusal that is about the account's allowance or the moment, never about the model, whatever the status (a 413 can say this too).
const LIMIT_WORDS = /per[ -]minute|per[ -]second|per[ -]day|tokens? per|requests? per|\btpm\b|\brpm\b|rate[ -]?limit|too many requests|quota|try again (in|later)|retry (in|after)/i;
// A refusal that is about the request's SIZE.
const SIZE_WORDS = /too (large|big|long)|entity too large|payload|request size|content[ -]length|body (is )?too|exceeds? (the )?(maximum|max|limit|size)|maximum (context|request|content|body)|context[ -]?(length|window)|input is too|prompt is too|too many tokens|reduce the (length|size)/i;
// The provider saying the model or its route cannot take tools at all: a verdict about the model, even when it comes as a 404.
const NOTOOLS = /no endpoints? (found )?(that )?(support|supporting)\w* (tool|function)|(does(n'?t| not)|do(n'?t| not)) support (tool|function)|(tools?|function[ -]?calling|tool[ -]use) (is |are )?(not|un)supported|unsupported.{0,20}\btools?\b|tool use is not (available|supported)|tools? (is|are) not (available|enabled)/i;

/** The streamed answer of one tool_use block: the joined partial_json, or the object the start event carried. */
function argsOf(block) {
  const raw = block.json === "" ? JSON.stringify(block.start ?? {}) : block.json;
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? { ok: true, value: v } : { ok: false }; }
  catch { return { ok: false }; }
}

/** Reads the whole answer stream into `{blocks, streamError, stopped, events, stopReason, overflow}`. Never throws on a malformed event. */
async function readStream(res, { signal } = {}) {
  const reader = res.body?.getReader?.();
  if (!reader) return { noBody: true, blocks: [], streamError: null, stopped: false };
  const dec = new TextDecoder(), parser = createSseParser();
  const blocks = new Map();
  let streamError = null, stopped = false, chars = 0, events = 0, stopReason = null, bytes = 0, overflow = false;
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
        if (ev.type === "content_block_start" && Number.isInteger(d?.index)) {
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
        } else if (ev.type === "message_delta") { if (typeof d?.delta?.stop_reason === "string") stopReason = d.delta.stop_reason; }
        else if (ev.type === "error") streamError = d?.error?.message ?? "stream error";
        else if (ev.type === "message_stop") { stopped = true; break scan; }
        if (chars > STREAM_CHAR_CAP) break scan;
      }
    }
  } finally {
    let t;
    try { await Promise.race([Promise.resolve(reader.cancel()), new Promise((r) => { t = setTimeout(r, 500); })]); } catch { /* closed */ }
    clearTimeout(t);
  }
  return { blocks: [...blocks.values()], streamError, stopped, events, stopReason, overflow };
}

const toolBlocks = (r) => r.blocks.filter((b) => b.type === "tool_use");
const textOf = (r) => r.blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();

/** Judges the stream of one level. Pure over `readStream`'s result. */
export function judge(level, r) {
  if (r.noBody) return inconclusive("error", "HTTP 200 with no response body");
  if (r.overflow) return fail("the answer stream passed the size limits (too many bytes, events or blocks)");
  const tools = toolBlocks(r);
  // CONTENT means text or a tool call: a thinking block is not content. An answer that spent its budget on thinking and ended on
  // max_tokens says nothing about tools, at any level (the bench records the same case as `empty`).
  const usable = tools.length > 0 || !!textOf(r);
  if (r.streamError && !usable) {
    const tight = classifyTight(r.streamError);
    if (tight) return inconclusive(tight, `stream error: ${r.streamError}`);
    if (TRANSIENT_WORDS.test(r.streamError)) return inconclusive("error", `stream error: ${r.streamError}`);
    return fail(`stream error before any content: ${r.streamError}`);
  }
  if (!r.events) return inconclusive("error", "HTTP 200 with no stream events");
  if (!usable && r.stopReason === "max_tokens") return inconclusive("empty", "output budget spent before any text or tool call (stop_reason max_tokens); raise --max-tokens");
  const bad = tools.find((b) => !argsOf(b).ok);
  if (level === 1 || level === 4) {
    const want = level === 1 ? 1 : 2;
    if (!tools.length) return fail(textOf(r) ? "answered in text instead of calling the tool" : "no tool call in the answer");
    if (bad) return fail("tool call arguments are not valid JSON");
    if (tools.some((b) => b.name !== ECHO_TOOL)) return fail("tool call names a tool that was not offered");
    if (tools.some((b) => typeof argsOf(b).value.message !== "string")) return fail("a tool call lacks the required argument `message`");
    if (level === 4 && tools.length < want) return fail(`one tool call instead of ${want} parallel calls`);
    if (level === 4 && new Set(tools.map((b) => b.id ?? b)).size < want) return fail("parallel tool calls share one id");
    if (level === 4 && tools.some((b) => b.json === "")) return fail("the tool call arguments were not streamed (no argument deltas)");
    return pass();
  }
  if (level === 2) {
    if (r.streamError) return fail(`stream error: ${r.streamError}`);
    if (!textOf(r)) return fail(tools.length ? "called the tool again instead of answering" : "no final answer after the tool result");
    return pass();
  }
  // L3 and L5: the big request was accepted and answered with something well formed
  if (bad) return fail("tool call arguments are not valid JSON");
  if (!usable) return fail("empty answer to the large request");
  if (r.streamError) return fail(`stream error: ${r.streamError}`);
  return pass();
}

/** One request and its judgement; `body` is the request text. Resolves `{v, ...}` or `{aborted: true}`; never rejects. */
async function send(level, body, { fetchImpl, url, key, timeoutMs, signal }) {
  const bytes = Buffer.byteLength(body);
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener("abort", onAbort, { once: true }); }
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", [CCR.clientHeader]: CCR.probeClient },
      body, signal: ac.signal,
    });
    if (!res.ok) {
      let text = "";
      try { text = (await res.text()).slice(0, 2048); } catch { /* unreadable body */ }
      const ra = parseRetryAfter(res.headers?.get?.("retry-after"));
      return { ...httpVerdict(level, res.status, text, ra), http: res.status, bytes, body: text };
    }
    return { ...judge(level, await readStream(res, { signal: ac.signal })), bytes };
  } catch (e) {
    if (timedOut) return { ...inconclusive("timeout", `no complete answer within ${timeoutMs} ms`), bytes };
    if (signal?.aborted) return { aborted: true };
    return { ...inconclusive("error", e?.message ?? e), bytes };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/**
 * What an HTTP refusal means. A 400, 413 or 422 on a tool-bearing request is the model or its provider refusing the request itself: a
 * verdict, unless the sentence is about the ACCOUNT (an empty balance, a dead key: `classifyTight`, the anchors that cannot be fooled by
 * an echoed tool name) or about a LIMIT of the moment (tokens per minute, rate: a 413 can say that too). A route that says it has no
 * tool support is a verdict even as a 404. Everything else (401, 402, 403, 404, 429, 5xx) is read by `classifyHttp` and is inconclusive.
 */
function httpVerdict(level, status, text, ra) {
  const extra = ra !== null && ra !== undefined ? { ra } : {};
  const why = `HTTP ${status}: ${text}`;
  const clientErr = status === 400 || status === 413 || status === 422;
  if (NOTOOLS.test(text) && (clientErr || status === 404)) return fail(why, { kind: "schema" });
  if (clientErr) {
    const tight = classifyTight(text);
    if (tight) return inconclusive(tight, why, extra);
    if (LIMIT_WORDS.test(text)) return inconclusive("rate", why, extra);
    const size = status === 413 || SIZE_WORDS.test(text) || level === 5;      // a refusal only at the big step, after the 157 KB step was accepted, is about size
    return fail(why, { kind: size ? "size" : "schema" });
  }
  return inconclusive(classifyHttp(status, text), why, extra);
}

/**
 * One level against one model. Resolves `{v, why?, kind?, s?, ra?, http?, bytes, reqs}` or `{aborted: true}`; never rejects.
 * `v`: `p` passed, `f` failed (a verdict), `i` inconclusive (`s` says why: auth, pay, rate, gone, error, timeout or empty).
 * L1 forces a tool; a 400 that names `tool_choice` is retried ONCE with the choice left to the model before any verdict (`reqs` counts both).
 */
export async function runLevel(level, { fetchImpl = fetch, url, key, model, maxTokens = PROBE_MAX_TOKENS, timeoutMs = 240000, signal = null } = {}) {
  const conn = { fetchImpl, url, key, timeoutMs, signal };
  const first = await send(level, JSON.stringify(buildBody(level, model, maxTokens)), conn);
  if (first.aborted) return first;
  if (level === 1 && first.http && (first.http === 400 || first.http === 422) && /tool_choice/i.test(first.body ?? "")) {
    const second = await send(level, JSON.stringify(buildBody(level, model, maxTokens, { toolChoice: "auto" })), conn);
    if (second.aborted) return second;
    return { ...second, reqs: 2, retriedAuto: true };
  }
  return { ...first, reqs: 1 };
}

/**
 * The levels asked for one model, in order. `done` (mutated) holds the verdicts already reached for it, so a retry after an
 * inconclusive level repeats only that level. L3 and L4 need L1 and L2 passed, and L5 needs L3 passed (`prior` is the stored per-level
 * string, `nnnn` for none): a model that cannot call a tool is not sent 40,000 tokens. Resolves
 *   `{aborted: true}`
 *   `{inconclusive: {s, why, ra?}, requests}`        nothing is recorded; the model is tried again later
 *   `{done, requests, bytes}`                        every asked level has a verdict; `done` maps level -> {v, why?, kind?, bytes?}
 */
export async function probeModel({ levels, prior = "nnnn", done = {}, ...conn }) {
  let requests = 0;
  const passed = (n) => (done[n]?.v ?? (prior[n - 1] === "p" ? "p" : "n")) === "p";
  for (const level of [...levels].sort((a, b) => a - b)) {
    if (done[level]) continue;
    if ((level === 3 || level === 4) && !(passed(1) && passed(2))) { done[level] = { v: "n", why: "not run: L1 and L2 did not both pass" }; continue; }
    if (level === 5 && !passed(3)) { done[level] = { v: "n", why: "not run: L3 did not pass" }; continue; }
    const r = await runLevel(level, conn);
    if (r.aborted) return { aborted: true };
    requests += r.reqs ?? 1;
    if (r.v === "i") return { inconclusive: { s: r.s, why: r.why, ...(r.ra !== undefined ? { ra: r.ra } : {}), ...(r.http ? { http: r.http } : {}) }, requests };
    done[level] = { v: r.v, ...(r.why ? { why: r.why } : {}), ...(r.kind ? { kind: r.kind } : {}), ...(level >= 3 ? { bytes: r.bytes } : {}) };
  }
  return { done, requests };
}

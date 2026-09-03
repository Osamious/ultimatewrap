#!/usr/bin/env node
// THROWAWAY SPIKE — does Claude Code's MCP elicitation render a usable model picker?
//
// Answers, in one session, the questions that decide the Phase 6 design:
//   1. does an `enum` + `enumNames` elicitation render as a SELECTABLE list?
//   2. is there type-ahead search? (the binary suggests a 2s prefix buffer)
//   3. do space-padded labels survive, i.e. do we get COLUMNS?
//   4. how many rows are visible — is it the terminal height, or /model's 10-row cap?
//   5. does it scale to a realistic catalogue (400 rows) without choking?
//   6. does `right` expand a row into a detail view?
//
// Hand-rolled JSON-RPC over stdio: keysync has no package.json and this must not
// add a dependency for a spike we may throw away.
//
// Protocol note: elicitation is a SERVER->CLIENT request issued *during* a
// tools/call, so this needs bidirectional RPC — we send `elicitation/create` and
// await the client's response before returning the tool result.

import readline from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

// Pending server->client requests, keyed by id.
let nextId = 1000;
const pending = new Map();

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    // If the client never answers, fail loudly rather than hang the tool call.
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`${method} timed out after 300s`)); }
    }, 300000);
  });
}

// ---------------------------------------------------------------- fixture data
// Padded to fixed widths so we can see whether columns survive the renderer.
const pad = (s, n) => String(s).slice(0, n).padEnd(n);

const PROVIDERS = [
  ["personal.alibaba.paid",      343, "—",  "ok"],
  ["personal.openai.paid",       337, "—",  "ok"],
  ["personal.mistral.free",      193, "—",  "ok"],
  ["personal.google.free",       185, "—",  "ok"],
  ["sportsvector2.google.paid",  185, "—",  "ok"],
  ["personal.deepseek.paid",     105, "—",  "ok"],
  ["personal.openrouter.free",    98, "18", "ok"],
  ["personal.kilo.free",          96, "19", "ok"],
  ["personal.nvidia.free",        44, "—",  "ok"],
  ["personal.cohere.free",        37, "—",  "ok"],
  ["personal.zenmux.free",        23, "5",  "ok"],
  ["personal.groq.free",          20, "—",  "ok"],
  ["personal.tokenrouter.free",   12, "3",  "ok"],
  ["personal.indeedwebid.free",    1, "—",  "chat down"],
];

const providerRows = () => ({
  values: PROVIDERS.map((p) => p[0]),
  labels: PROVIDERS.map(([id, n, free, health]) =>
    `${pad(id, 26)} ${String(n).padStart(4)} ${pad(free, 3)} ${health}`),
});

// 400 synthetic models — enough to answer "does it scale", and to see how the
// scroll window behaves well past /model's 10-row viewport.
function bigModelRows(count = 400) {
  const fams = ["qwen3-max", "qwen3-coder", "glm-5.3", "deepseek-v4", "llama-4", "gpt-oss", "mistral-lg", "gemma-4"];
  const values = [], labels = [];
  for (let i = 0; i < count; i++) {
    const id = `${fams[i % fams.length]}-${String(i).padStart(3, "0")}`;
    const ctx = [8, 32, 131, 262, 1000][i % 5];
    const price = (0.05 + (i % 40) * 0.07).toFixed(2);
    const badge = i % 11 === 0 ? "FREE" : i % 17 === 0 ? "BAL$" : "PAID";
    const caps = `${i % 3 === 0 ? "V" : "-"}${i % 2 === 0 ? "R" : "-"}`;
    values.push(id);
    labels.push(`${pad(id, 20)} ${String(ctx + "k").padStart(5)} ${("$" + price).padStart(6)} ${badge.padEnd(4)} ${caps}`);
  }
  return { values, labels };
}

async function elicit(message, { values, labels }) {
  const res = await request("elicitation/create", {
    message,
    requestedSchema: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          title: "Selection",
          // oneOf/const/title instead of enum/enumNames — tests whether the
          // stray leading quote (and with it, prefix type-ahead) goes away.
          oneOf: values.map((v, i) => ({ const: v, title: labels[i] })),
        },
      },
      required: ["choice"],
    },
  });
  return res;
}

const TOOLS = [
  { name: "spike_pick_provider",
    description: "SPIKE 1: 14 providers with padded columns. Tests rendering, columns, row count.",
    inputSchema: { type: "object", properties: {} } },
  { name: "spike_pick_model_large",
    description: "SPIKE 2: 400 models. Tests scaling, scroll window, and type-ahead search.",
    inputSchema: { type: "object", properties: {} } },
  { name: "spike_two_level",
    description: "SPIKE 3: provider, then that provider's models — two elicitations in sequence.",
    inputSchema: { type: "object", properties: {} } },
];

async function callTool(name) {
  if (name === "spike_pick_provider") {
    const r = await elicit(
      "SPIKE 1 — pick a provider.  Columns: key id | models | free | health\n" +
      "Try: arrow keys, PageDown, and TYPING a few letters (type-ahead?).",
      providerRows());
    return `elicitation returned: ${JSON.stringify(r)}`;
  }
  if (name === "spike_pick_model_large") {
    const r = await elicit(
      "SPIKE 2 — 400 models.  Columns: model | ctx | price | badge | caps\n" +
      "Check: how many rows visible? does typing filter? does `right` expand a row?",
      bigModelRows(400));
    return `elicitation returned: ${JSON.stringify(r)}`;
  }
  if (name === "spike_two_level") {
    const a = await elicit("SPIKE 3, level 1 of 2 — pick a provider.", providerRows());
    const picked = a?.content?.choice ?? a?.choice ?? "(none)";
    if (a?.action && a.action !== "accept") return `level 1 ${a.action}; stopped.`;
    const b = await elicit(`SPIKE 3, level 2 of 2 — models for ${picked}.`, bigModelRows(60));
    return `level1=${picked}  level2=${JSON.stringify(b)}`;
  }
  throw new Error(`unknown tool ${name}`);
}

// ------------------------------------------------------------------- dispatch
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // A response to one of OUR requests (i.e. the elicitation result).
  if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }

  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const fail  = (m) => send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: m } });

  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "uw-elicit-spike", version: "0.0.1" },
      });
    case "notifications/initialized":
      return;                                   // notification: no id, no reply
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      try {
        const text = await callTool(msg.params?.name);
        return reply({ content: [{ type: "text", text }] });
      } catch (e) {
        return fail(String(e?.message ?? e).slice(0, 300));
      }
    default:
      if (msg.id !== undefined) return fail(`unsupported method ${msg.method}`);
  }
});

process.on("uncaughtException", (e) => {
  process.stderr.write(`spike uncaught: ${e?.message}\n`);
});

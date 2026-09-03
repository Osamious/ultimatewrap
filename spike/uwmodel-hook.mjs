#!/usr/bin/env node
// SPIKE — UserPromptSubmit hook: can we render a COLUMN TABLE to the user and
// block the prompt so the turn costs ZERO Anthropic tokens?
//
// Questions this answers, which reading the binary could not:
//   1. does `decision:"block"` / `continue:false` really stop the API call?
//   2. which field actually renders to the USER — `reason` or `systemMessage`?
//   3. do space-padded COLUMNS survive that render, or get collapsed/wrapped?
//   4. what is the real line cap? (binary says 20; verify by overflowing it)
//   5. does `suppressOriginalPrompt` hide the "Original prompt: …" suffix?
//
// SAFETY — this runs on EVERY prompt the user types. A crash here would make the
// session untypeable, so every path is fail-open: on any error, any unexpected
// input, or any prompt that is not ours, emit {continue:true} and get out of the
// way. Nothing here touches CCR, settings.json, or the network.

import fs from "node:fs";

const PREFIX = ">>";

// Fail-open helper: whatever happens, the user's prompt must still go through.
function passThrough() {
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }));
  process.exit(0);
}

// Block the turn and show text. We deliberately populate BOTH `reason` and
// `systemMessage` because the binary suggests each renders through a different
// path, and the point of the spike is to find out which one the user sees.
// MEASURED: setting `decision:"block"` AND `continue:false` together produced a
// bare "Operation stopped by hook" with the text discarded — two different block
// paths collided and the coarser one won. So each variant is now emitted alone,
// to find which one actually renders text to the USER.
function emit(o) { process.stdout.write(JSON.stringify(o)); process.exit(0); }

const VARIANTS = {
  // A: the documented block path, reason only, no `continue`.
  a: (t) => emit({ decision: "block", reason: t,
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } }),
  // B: the coarse path, with its own message field.
  b: (t) => emit({ continue: false, stopReason: t }),
  // C: systemMessage while still blocking via decision.
  c: (t) => emit({ decision: "block", reason: "(reason field)", systemMessage: t,
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } }),
  // D: NOT blocking — does systemMessage display on a pass-through?
  //    This one DOES cost a turn; it is the control.
  d: (t) => emit({ continue: true, systemMessage: t }),
};

let VARIANT = "a";
function block(text) { (VARIANTS[VARIANT] || VARIANTS.a)(text); }

const pad = (s, n) => String(s).slice(0, n).padEnd(n);
const rpad = (s, n) => String(s).slice(0, n).padStart(n);

// Same fixture as the MCP spike, so the two renderings are directly comparable.
const PROVIDERS = [
  ["personal.alibaba.paid",      343, "-",  "ok"],
  ["personal.openai.paid",       337, "-",  "ok"],
  ["personal.mistral.free",      193, "-",  "ok"],
  ["personal.google.free",       185, "-",  "ok"],
  ["sportsvector2.google.paid",  185, "-",  "ok"],
  ["personal.deepseek.paid",     105, "-",  "ok"],
  ["personal.openrouter.free",    98, "18", "ok"],
  ["personal.kilo.free",          96, "19", "ok"],
  ["personal.nvidia.free",        44, "-",  "ok"],
  ["personal.cohere.free",        37, "-",  "ok"],
  ["personal.zenmux.free",        23, "5",  "ok"],
  ["personal.groq.free",          20, "-",  "ok"],
  ["personal.tokenrouter.free",   12, "3",  "ok"],
  ["personal.indeedwebid.free",    1, "-",  "chat down"],
];

const MODELS = [
  ["qwen3-max",         "262k", "$1.20/$6.00", "PAID", "-R", "ok"],
  ["qwen3-coder-plus",  "131k", "$0.30/$1.20", "PAID", "--", "ok"],
  ["qwen3-vl-plus",     "131k", "$0.80/$2.40", "PAID", "V-", "ok"],
  ["qwen3-omni",        "131k", "$1.60/$6.40", "PAID", "VR", "ok"],
  ["qwen3-flash",        "1M",  "$0.05/$0.20", "FREE", "--", "ok"],
];

function providerTable() {
  const L = [];
  L.push("  " + pad("key id", 27) + rpad("models", 7) + "  " + pad("free", 5) + "health");
  L.push("  " + "-".repeat(27) + "-".repeat(7) + "  " + "-".repeat(5) + "-".repeat(9));
  for (const [id, n, free, health] of PROVIDERS) {
    L.push("  " + pad(id, 27) + rpad(n, 7) + "  " + pad(free, 5) + health);
  }
  return L;
}

function modelTable(provider) {
  const L = [];
  L.push(`  ${provider}`);
  L.push("  " + pad("model", 20) + rpad("ctx", 6) + "  " + pad("$in/$out", 14) + pad("badge", 6) + pad("caps", 5) + "health");
  L.push("  " + "-".repeat(20) + "-".repeat(6) + "  " + "-".repeat(14) + "-".repeat(6) + "-".repeat(5) + "-".repeat(6));
  MODELS.forEach(([m, ctx, price, badge, caps, health], i) => {
    L.push(`  ${i + 1}. ` + pad(m, 17) + rpad(ctx, 6) + "  " + pad(price, 14) + pad(badge, 6) + pad(caps, 5) + health);
  });
  return L;
}

let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  passThrough();
}

let input;
try {
  input = JSON.parse(raw);
} catch {
  passThrough();
}

const prompt = String(input?.prompt ?? "");
if (!prompt.trimStart().startsWith(PREFIX)) passThrough();

try {
  let arg = prompt.trimStart().slice(PREFIX.length).trim();
  // ">>a p" -> variant a, command p.  Bare ">>p" keeps the default variant.
  const m = /^([abcd])\s+(.*)$/.exec(arg);
  if (m) { VARIANT = m[1]; arg = m[2].trim(); }

  if (arg === "" || arg === "?" || arg === "help") {
    block([
      "UW model hook — SPIKE",
      "",
      "  >>p            provider table",
      "  >>m <name>     that provider's models",
      "  >>lines        emit 40 lines, to find the real display cap",
      "",
      "If you can read this and NO tokens were spent, the mechanism works.",
    ].join("\n"));
  }

  if (arg === "p" || arg === "providers") {
    block(["UW providers  (spike — nothing is actually switched)", "", ...providerTable()].join("\n"));
  }

  if (arg.startsWith("m")) {
    const name = arg.slice(1).trim() || "personal.alibaba.paid";
    block(["UW models  (spike)", "", ...modelTable(name)].join("\n"));
  }

  // Deliberately overflow: the binary claims a 20-line cap. Emit 40 numbered
  // lines and see how many actually render — a truncated tail is the answer.
  if (arg === "lines") {
    const L = ["line-cap probe: 40 lines follow, numbered. Report the LAST one you see.", ""];
    for (let i = 1; i <= 40; i++) L.push(`  line ${String(i).padStart(2, "0")} ${"=".repeat(40)}`);
    block(L.join("\n"));
  }

  block(`unknown: ">>${arg}"   try >>p, >>m alibaba, >>lines, or >>help`);
} catch (e) {
  // Never let a bug in the table builder eat the user's prompt.
  passThrough();
}

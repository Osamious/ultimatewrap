// Everything this project knows about Claude Code lives here. Nothing else may
// import a Claude Code path, parse its payloads, or hard-code its semantics.
//
// Why a module rather than a comment: Claude Code auto-updates on the `latest`
// channel. When the handoff or the statusline shape moves, the failure should be
// one named check in `uw doctor`, not a renderer that silently writes into a file
// nobody reads.
//
// MEASURED against 2.1.258 on this machine:
//   - ctrl+g calls enterAlternateScreen(), then spawnSync($EDITOR, [tmpfile],
//     {stdio:"inherit"}). The buffer path is argv[2] for a bare `node script.mjs`
//     invocation.
//   - Exit 0 makes the file's contents the chat input. Any non-zero exit discards
//     it and leaves the input untouched -- which is also our clean-abort path.
//   - The statusline command receives one JSON object on stdin whose `version`,
//     `model.{id,display_name}` and `context_window.*` fields are the only ones
//     we depend on.

import path from "node:path";
import os from "node:os";
import { admitId } from "./sanitize.mjs";

export const CONTRACT = Object.freeze({
  product: "claude-code",
  fingerprint: "2.1.258",
  handoff: Object.freeze({ argvIndex: 2, acceptExit: 0, discardExit: 1 }),
  command: Object.freeze({ model: "/model " }),
  // The only Claude Code paths this project may name. `uw doctor` and the
  // installer read them from here rather than building their own (Q4.3).
  paths: Object.freeze({
    settings: path.join(os.homedir(), ".claude", "settings.json"),
    statusLineKey: "statusLine",
  }),
  statusline: Object.freeze({
    modelPath: "model.id",
    displayPath: "model.display_name",
    contextPath: "context_window.context_window_size",
    usageKeys: Object.freeze([
      "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
    ]),
  }),
});

export function handoffTarget(argv) {
  const p = argv?.[CONTRACT.handoff.argvIndex];
  return typeof p === "string" && p.length ? p : null;
}

// The one place the switch syntax exists. `admitId` runs on the model half only:
// the provider half comes from our own vault metadata, not from remote data.
export function modelCommand(provider, model) {
  const id = admitId(model);
  if (id === null) throw new Error(`modelCommand: model id rejected: ${JSON.stringify(String(model))}`);
  return `${CONTRACT.command.model}${provider}/${id}`;
}

export function parseStatusline(text) {
  let p = null;
  try { p = JSON.parse(String(text)); } catch { return null; }
  if (!p || typeof p !== "object") return null;
  if (!p.model || typeof p.model.id !== "string") return null;
  if (!p.context_window || typeof p.context_window !== "object") return null;
  return p;
}

export function usedTokens(payload) {
  const u = payload?.context_window?.current_usage;
  if (!u || typeof u !== "object") return null;
  let total = 0;
  for (const k of CONTRACT.statusline.usageKeys) total += Number(u[k] ?? 0);
  return Number.isFinite(total) ? total : null;
}

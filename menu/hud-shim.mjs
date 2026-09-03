#!/usr/bin/env node
// A statusline wrapper that fixes exactly one number.
//
//   node hud-shim.mjs -- <the original statusLine.command>
//
// Claude Code reports context_window_size from its own model knowledge, so after
// a switch to a non-Anthropic model the footer's "context left" counts against
// the wrong denominator. The catalogue knows the real limit; the snapshot already
// carries it. Nothing else is touched, no OMC file is read or written, and the
// only foreign contract used is the statusline stdin shape, which lives in
// cc-contract.mjs like every other one (Q4.1).
//
// Failure policy, and it is absolute: if anything goes wrong the ORIGINAL bytes
// are forwarded. A footer that is wrong about one number is a nuisance; a footer
// that is empty on every prompt is a bug report in the wrong repository.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { parseStatusline, usedTokens } from "./cc-contract.mjs";
import { loadSnapshot, contextIndex, SNAPSHOT_FILE } from "./snapshot.mjs";

// Strip a trailing bracketed decoration, e.g. `...-opus-5[1m]`. Defensive only:
// nothing decorates a NON-Anthropic id today, so this changes no current
// behaviour. It exists because the alternative failure is silent -- a decorated
// id misses the index, transform returns null, the footer keeps its wrong number,
// and every test still passes, because "not in the index" is a legitimate answer.
const undecorate = (id) => String(id).replace(/\[[^\]]*\]$/, "");

export function transform(raw, ix) {
  const p = parseStatusline(raw);
  if (!p) return null;
  // MEASURED 2026-09-03, and this is the fact the whole task rests on. A payload
  // captured with a CCR-routed non-Anthropic model selected reports
  //   model.id = "google/gemini-3.5-flash-lite"
  // -- a bare `provider/model` target, exactly the key shape contextIndex builds
  // from the snapshot, so the exact lookup below is correct rather than assumed.
  // That payload also carried context_window_size 200000 for a model whose real
  // window is 1048576, which is the defect this shim exists to correct.
  //
  // The `[1m]` suffix observed on `anthropic/claude-opus-5[1m]` is
  // Anthropic-specific -- a 1M-context beta marker. A miss there is the RIGHT
  // answer: relay rows carry `ctx: null`, so the live index holds zero
  // `anthropic/*` keys and Claude Code already knows its own windows.
  const real = ix.get(p.model.id) ?? ix.get(undecorate(p.model.id));
  if (!Number.isFinite(real) || real === p.context_window.context_window_size) return null;

  const cw = { ...p.context_window, context_window_size: real };
  const used = usedTokens(p);
  if (used != null) {
    cw.used_percentage = Math.max(0, Math.min(100, Math.round((used / real) * 100)));
    cw.remaining_percentage = 100 - cw.used_percentage;
  }
  return JSON.stringify({ ...p, context_window: cw });
}

// The wrapper prefix, in one place, so install.ps1's write and any later read
// cannot disagree about its shape. The existing command is appended as an OPAQUE
// string: never parsed, never re-quoted, never separator-normalised. The observed
// value mixes `\` and `/` and pins an absolute node.exe under nvm4w, and all of
// that is OMC's business (Q4.7).
const PREFIX_RE = /^node\s+"([^"]*hud-shim\.mjs)"\s+--\s+/;

export function wrapCommand(shimPath, existing) {
  return `node "${String(shimPath).replace(/\\/g, "/")}" -- ${existing}`;
}

export function unwrapCommand(wrapped) {
  const m = PREFIX_RE.exec(String(wrapped ?? ""));
  return m ? String(wrapped).slice(m[0].length) : null;
}

// The index, cached on the snapshot's mtime.
//
// This runs on EVERY statusline repaint, which is latency the user feels directly
// as terminal lag while typing. Reading and JSON-parsing snapshot.json each time
// is work the shim does not need to repeat: the file only changes when a refresh
// promotes a new one. `mtimeMs` is one `statSync` -- cheap enough to do per
// repaint -- and it invalidates exactly when the snapshot is rewritten.
//
// The process is short-lived under a statusline command, so in practice this
// caches within a run rather than across them; it is still the right shape,
// because a statusline command that is kept alive (or a future in-process host)
// gets the benefit for free, and the failure mode of a stale cache here is one
// repaint showing the previous context size.
let CACHE = { at: -1, ix: null };
function cachedIndex() {
  const snapPath = SNAPSHOT_FILE;
  let mt = -1;
  try { mt = fs.statSync(snapPath).mtimeMs; } catch { return null; }
  if (CACHE.at === mt && CACHE.ix) return CACHE.ix;
  const snap = loadSnapshot();
  if (!snap.ok) return null;
  CACHE = { at: mt, ix: contextIndex(snap.snap) };
  return CACHE.ix;
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--");
  const command = i >= 0 ? argv.slice(i + 1).join(" ") : "";
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
  if (!command) { process.stdout.write(""); return 0; }

  let payload = raw;
  try {
    const ix = cachedIndex();
    if (ix) payload = transform(raw, ix) ?? raw;
  } catch { payload = raw; }

  const r = spawnSync(command, { input: payload, shell: true,
                                 stdio: ["pipe", "inherit", "inherit"] });
  return r.status ?? 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/hud-shim.mjs")) {
  process.exit(main());
}

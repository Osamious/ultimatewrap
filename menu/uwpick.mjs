#!/usr/bin/env node
// UW model picker — a terminal TUI that runs inside Claude Code's own external-editor
// handoff (ctrl+g / chat:externalEditor).
//
// WHY THIS WORKS WHERE EVERYTHING ELSE FAILED:
// CC's editor handoff calls enterAlternateScreen() — which PAUSES its renderer and
// turns OFF raw mode — then spawnSync's the editor with stdio:"inherit" and BLOCKS.
// So we get the real TTY, exclusively, with no repaint war and no keystroke war.
// (A hook's child cannot do this: hooks are spawned stdio:["ignore","pipe","pipe"],
// so they have no stdin at all, and CC keeps painting throughout.)
//
// CONTRACT: argv[2] is a temp .md holding the current chat input. Whatever we leave
// in that file becomes the new chat input. We write "/model <id>" and exit 0 —
// a non-zero exit makes CC discard the content.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { build, routableSet } from "./catalog.mjs";

const FILE = process.argv[2];
const STATE = path.join(os.homedir(), ".uw", "state");
fs.mkdirSync(STATE, { recursive: true });
const KEYLOG = path.join(STATE, "keys.log");
const out = process.stdout;

const { rows } = build();
const routable = await routableSet();

// ------------------------------------------------------------------ rendering
const ESC = "\x1b";
const hideCur = () => out.write(`${ESC}[?25l`);
const showCur = () => out.write(`${ESC}[?25h`);
const clear   = () => out.write(`${ESC}[2J${ESC}[H`);
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const inv = (s) => `${ESC}[7m${s}${ESC}[0m`;
const grn = (s) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s) => `${ESC}[31m${s}${ESC}[0m`;
const cya = (s) => `${ESC}[36m${s}${ESC}[0m`;

const pad  = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
const rpad = (s, n) => String(s ?? "").slice(0, n).padStart(n);
const ctxS = (c) => (c == null ? "" : c >= 1e6 ? `${c / 1e6}M` : `${Math.round(c / 1000)}k`);
const money = (v) => (v == null ? "" : v === 0 ? "0" : v.toFixed(2));

// ---------------------------------------------------------------------- state
let level = 0;            // 0 = providers, 1 = models
let q = ["", ""];         // one filter per level, kept independently
let cur = [0, 0];
let top = [0, 0];
let provider = null;

// Level-1 match also searches MODEL names, so typing "opus" finds the provider that
// serves it. Without this a two-level menu forces you to already know the answer.
const provMatch = (r, s) =>
  !s || r.keyId.toLowerCase().includes(s) || r.models.some((m) => m.id.toLowerCase().includes(s));

const provRows  = () => rows.filter((r) => provMatch(r, q[0].toLowerCase()));
const modelRows = () => {
  if (!provider) return [];
  const s = q[1].toLowerCase();
  return provider.models.filter((m) => !s || m.id.toLowerCase().includes(s));
};
const list = () => (level === 0 ? provRows() : modelRows());
const target = (m) => `${provider.provider}/${m.id}`;

function draw() {
  const rowsAvail = Math.max(5, (out.rows || 30) - 6);
  const items = list();
  if (cur[level] >= items.length) cur[level] = Math.max(0, items.length - 1);
  if (cur[level] < top[level]) top[level] = cur[level];
  if (cur[level] >= top[level] + rowsAvail) top[level] = cur[level] - rowsAvail + 1;

  const L = [];
  L.push(cya("  UW model picker") + dim(`   ${rows.length} providers · ${routable.size} routable`));
  L.push("");
  if (level === 0) {
    L.push(`  ${cya("filter")} ${q[0]}${inv(" ")}`);
    L.push(dim("  " + pad("key id", 30) + rpad("models", 7) + "  " + pad("free", 6) + "health"));
  } else {
    L.push(`  ${cya(provider.keyId)} ${dim("›")} ${q[1]}${inv(" ")}`);
    L.push(dim("  " + pad("model", 34) + rpad("ctx", 6) + " " + rpad("$in", 7) + rpad("$out", 7)
               + "  " + pad("badge", 6) + "caps"));
  }

  const slice = items.slice(top[level], top[level] + rowsAvail);
  slice.forEach((it, i) => {
    const idx = top[level] + i;
    const sel = idx === cur[level];
    let line;
    if (level === 0) {
      const free = it.free == null ? dim("—") : it.free ? grn(String(it.free)) : "0";
      const h = it.health === "broken" ? red(it.health) : dim(it.health);
      line = "  " + pad(it.keyId, 30) + rpad(it.models.length, 7) + "  "
           + pad(it.free == null ? "—" : String(it.free), 6) + it.health;
      line = sel ? inv(line) : "  " + pad(it.keyId, 30) + rpad(it.models.length, 7) + "  "
                 + (it.free == null ? dim(pad("—", 6)) : pad(String(it.free), 6)) + h;
    } else {
      const ok = routable.has(target(it));
      const badge = it.badge === "FREE?" ? grn(pad(it.badge, 6)) : dim(pad(it.badge, 6));
      const caps = `${it.tools ? "T" : "-"}${it.vision ? "V" : "-"}${it.reason ? "R" : "-"}`;
      const plain = (ok ? "  " : dim("· ")) + pad(it.id, 34) + rpad(ctxS(it.ctx), 6) + " "
                  + rpad(money(it.pin), 7) + rpad(money(it.pout), 7) + "  ";
      line = sel ? inv(plain.replace(/\x1b\[[0-9;]*m/g, "") + pad(it.badge, 6) + caps)
                 : plain + badge + dim(caps);
    }
    L.push(line);
  });

  const more = items.length - (top[level] + slice.length);
  if (more > 0) L.push(dim(`  … ${more} more`));
  L.push("");
  L.push(true
    ? dim(level === 0
        ? "  type to filter · ↑↓ move · enter open · esc quit"
        : "  type to filter · ↑↓ move · enter select · esc back · dim rows are not routable")
    : dim("  LINE MODE (no raw tty): type a filter then Enter · a NUMBER then Enter to pick · "
        + "'b' back · 'q' quit"));
  clear();
  out.write(L.join("\n"));
}

// ------------------------------------------------------------------- key loop
function finish(text) {
  showCur();
  clear();
  try { if (FILE && text != null) fs.writeFileSync(FILE, text); } catch {}
  process.exit(0);                 // MUST be 0, or CC discards the content
}

// MEASURED, not assumed: under CC's ctrl+g handoff the child gets
//   stdin.isTTY = undefined, setRawMode absent, 0 bytes ever delivered.
// process.stdin is simply dead here. But the Windows console input device opens
// fine as "//./CONIN$" (forward slashes — the backslash forms both ENOENT), and a
// blocking readSync on it returns keystrokes. So read the console directly.
//
// Reads are blocking and synchronous, which is exactly right for a modal picker:
// we own the terminal until we exit, and CC is blocked in spawnSync anyway.
import { openSync, readSync, closeSync } from "node:fs";

let CONIN = null;
try { CONIN = openSync("//./CONIN$", "r"); } catch { CONIN = null; }

if (CONIN === null) {
  // No console: render once and leave the input untouched rather than hang.
  draw();
  out.write("\n\n  cannot open the console for input (//./CONIN$) — exiting.\n");
  finish(null);
}

hideCur();
draw();

const buf = Buffer.alloc(64);
for (;;) {
  let n = 0;
  try { n = readSync(CONIN, buf, 0, buf.length, null); }
  catch { break; }
  if (n <= 0) continue;
  const key = buf.toString("utf8", 0, n);
  // So a failed run still produces evidence instead of "nothing happened".
  try { fs.appendFileSync(KEYLOG, JSON.stringify([...buf.slice(0, n)]) + "\n"); } catch {}
  const c0 = key.charCodeAt(0);
  const items = list();

  if (c0 === 3) { closeSync(CONIN); finish(null); }              // ctrl+c
  else if (key.length >= 3 && c0 === 27 && key[1] === "[") {      // arrows
    const d = key[2];
    if (d === "A") cur[level] = Math.max(0, cur[level] - 1);
    if (d === "B") cur[level] = Math.min(items.length - 1, cur[level] + 1);
    draw();
  } else if (key.length === 1 && c0 === 27) {                     // esc
    if (level === 1) { level = 0; draw(); } else { closeSync(CONIN); finish(null); }
  } else if (c0 === 13 || c0 === 10) {                            // enter
    const it = items[cur[level]];
    if (it) {
      if (level === 0) { provider = it; level = 1; q[1] = ""; cur[1] = 0; top[1] = 0; draw(); }
      else { closeSync(CONIN); finish("/model " + target(it)); }
    }
  } else if (c0 === 127 || c0 === 8) {                            // backspace
    q[level] = q[level].slice(0, -1); cur[level] = 0; top[level] = 0; draw();
  } else if (key.length === 1 && c0 >= 32 && c0 <= 126) {         // live filter
    q[level] += key; cur[level] = 0; top[level] = 0; draw();
  }
}
closeSync(CONIN);
finish(null);

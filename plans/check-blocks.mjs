// Extract every fenced JavaScript block from the plan and run `node --check`
// over each one. Reports the failures with their starting line number.
//
// This exists because three rounds of reading missed five blocks that do not
// parse. Reading a code block proves nothing about whether it parses; running the
// parser over it does. Costs seconds.
//
//   node check-blocks.mjs [plan.md]
//
// Blocks that are deliberately partial fragments (shown for context, not for
// pasting) are listed in FRAGMENTS by their opening line so they do not create
// permanent noise. Every other failure is a real defect.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const file = process.argv[2] ?? "phase6-menu-and-catalogue.md";
const src = fs.readFileSync(file, "utf8").split("\n");

// Blocks that are deliberately incomplete snippets — a signature line plus the
// line under it, or a single line to substitute — are shown for splicing into an
// existing function rather than for pasting whole, so they cannot parse standalone
// and their failure is expected.
//
// They are marked IN THE PLAN with a `// FRAGMENT:` comment on their first line,
// not listed here by line number. A line-number list goes stale on the next edit
// that adds a line above it, and then either hides a real defect at a shifted line
// or reports a known fragment as new — I had it that way for one edit and it went
// stale immediately. Marking the block itself also puts the "this is not
// pasteable whole" note where the implementer reads it.
const isFragment = (text) => /^\s*\/\/\s*FRAGMENT\b/m.test(text.split("\n").slice(0, 3).join("\n"));

const blocks = [];
let open = null;
src.forEach((line, i) => {
  const fence = /^```(\w*)\s*$/.exec(line);
  if (!fence) return;
  if (open === null) {
    if (fence[1] === "js" || fence[1] === "javascript") open = { lang: fence[1], start: i + 1, body: [] };
    else open = { lang: fence[1] || "(none)", start: i + 1, body: null };
  } else {
    if (open.body) blocks.push({ start: open.start, text: open.body.join("\n") });
    open = null;
  }
});
if (open) console.error(`WARNING: unclosed fence opened at line ${open.start}`);

// second pass to capture bodies
open = null;
const bodies = [];
src.forEach((line, i) => {
  const fence = /^```(\w*)\s*$/.exec(line);
  if (fence) {
    if (open === null) open = { lang: fence[1], start: i + 1, body: [] };
    else { if (open.lang === "js" || open.lang === "javascript") bodies.push({ start: open.start, text: open.body.join("\n") }); open = null; }
    return;
  }
  if (open) open.body.push(line);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "uw-check-"));
let failed = 0, fragments = 0;
const failures = [];
for (const b of bodies) {
  const f = path.join(tmp, `b${b.start}.mjs`);
  fs.writeFileSync(f, b.text);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    const msg = String(e.stderr ?? "").split("\n").filter((l) => /Error|SyntaxError/.test(l))[0] ?? "parse error";
    if (isFragment(b.text)) { fragments++; continue; }
    failed++;
    failures.push(`  L${String(b.start).padStart(5)}  ${msg.trim().slice(0, 110)}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`${file}: ${bodies.length} fenced JavaScript blocks checked`);
if (fragments) console.log(`${fragments} known partial fragments skipped`);
if (failed) {
  console.log(`\n${failed} FAILED to parse:`);
  console.log(failures.join("\n"));
} else {
  console.log("all blocks parse");
}
process.exit(failed ? 1 : 0);

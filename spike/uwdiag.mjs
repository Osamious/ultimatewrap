// Runs under Claude Code's real ctrl+g handoff, records what the child process
// actually receives, then exits immediately. No interactive loop, so it cannot
// hang the session.
//
// NOTE: every path here uses FORWARD SLASHES and String.raw. Backslash escaping
// was silently mangled when this file was authored through a shell heredoc, so an
// earlier run wrote its results to a garbage filename instead of the intended one.
// Node accepts forward slashes on Windows; this avoids the whole class.

import fs from "node:fs";

const OUT = "C:/Users/osami/.uw/spike/diag.txt";
const L = [];
const p = (k, v) => L.push(`${String(k).padEnd(30)} ${v}`);

p("argv", JSON.stringify(process.argv.slice(1)));
p("stdin.isTTY", String(process.stdin.isTTY));
p("stdout.isTTY", String(process.stdout.isTTY));
p("stderr.isTTY", String(process.stderr.isTTY));
p("setRawMode is function", String(typeof process.stdin.setRawMode === "function"));

try {
  process.stdin.setRawMode(true);
  p("setRawMode(true)", "OK");
  process.stdin.setRawMode(false);
} catch (e) {
  p("setRawMode(true)", `THREW ${e.code ?? ""} ${String(e.message).slice(0, 70)}`);
}

for (const fd of [0, 1, 2]) {
  try {
    const st = fs.fstatSync(fd);
    p(`fd${fd} type`,
      st.isCharacterDevice() ? "chardev" : st.isFIFO() ? "pipe"
      : st.isFile() ? "file" : "other");
  } catch (e) { p(`fd${fd} fstat`, `ERR ${e.code}`); }
}

// The Windows console input device. Readable even when stdin has been redirected
// or detached — which is the whole point of testing it. String.raw so the
// backslashes survive verbatim.
const devices = ["CONIN$", String.raw`\\.\CONIN$`, "//./CONIN$"];
for (const dev of devices) {
  try {
    const fd = fs.openSync(dev, "r");
    p(`open ${dev}`, `OK fd=${fd}`);
    // Can we actually READ a keystroke from it? Non-blocking peek.
    try {
      const buf = Buffer.alloc(16);
      const n = fs.readSync(fd, buf, 0, 16, null);
      p(`  read ${dev}`, `${n} bytes`);
    } catch (e) { p(`  read ${dev}`, `ERR ${e.code}`); }
    fs.closeSync(fd);
  } catch (e) { p(`open ${dev}`, `ERR ${e.code}`); }
}

p("TERM", process.env.TERM ?? "(unset)");
p("WT_SESSION", process.env.WT_SESSION ? "set" : "(unset)");

// Does anything reach stdin if we simply listen?
let got = 0;
process.stdin.on("data", (d) => { got += d.length; });
process.stdin.on("error", (e) => p("stdin error", e.code));
try { process.stdin.resume(); } catch (e) { p("stdin.resume()", `THREW ${e.code}`); }

setTimeout(() => {
  p("bytes on stdin in 2s", String(got));
  try {
    fs.writeFileSync(OUT, L.join("\n") + "\n");
  } catch (e) {
    // Last resort: leave it beside this script.
    try { fs.writeFileSync("diag-fallback.txt", L.join("\n") + "\n"); } catch {}
  }
  process.exit(0);
}, 2000);

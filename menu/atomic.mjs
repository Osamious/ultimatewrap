// Every state and catalogue file this project owns is written by a short-lived
// process the user can interrupt: the picker runs inside ctrl+g and ctrl+c is a
// documented way out of it. A truncated picker.json costs a favourites list; a
// truncated snapshot.json costs the next launch. Rename is atomic on NTFS for a
// same-directory target, so the reader either sees the whole old file or the
// whole new one and never a prefix of either.

import fs from "node:fs";

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// The BOM strip is not defensive padding. PowerShell 5.1's `Set-Content -Encoding
// UTF8` writes a BOM, this project writes three JSON files from PowerShell, and
// `JSON.parse` throws on a leading U+FEFF. Without the strip those three files
// would parse as the fallback -- an empty object -- and the callers would draw
// confident conclusions from it: A12's console-mode test would see no recorded
// mode and A15's checkHud would report "not installed" for an installed shim.
// keysync.mjs:19 already does exactly this, for exactly this reason.
export function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch { return fallback; }
}

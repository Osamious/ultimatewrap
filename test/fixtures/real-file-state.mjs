// The state of a file the tests must never touch: its content hash, or "absent". A test run compares the value taken at load with the value after the run.
// The read uses the ORIGINAL fs function (a named import binds it before any guard wraps the property), so the comparison itself is not counted as a touch of the real state folder.
import { readFileSync } from "node:fs";
import crypto from "node:crypto";

export function realFileState(file) {
  try { return crypto.createHash("sha256").update(readFileSync(file)).digest("hex"); } catch (e) { return e?.code === "ENOENT" ? "absent" : `unreadable:${e?.code}`; }
}

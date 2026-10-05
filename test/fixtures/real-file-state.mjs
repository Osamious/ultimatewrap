// Whether a file the tests must never create or delete is there: "present" or "absent". A test run compares the value taken at load with the value after the run. (Not its content: the real
// state file can be written by a live run in another process while the tests run, and every write by a test is already refused by the real-state guard.)
// The check uses the ORIGINAL fs function (a named import binds it before any guard wraps the property), so it is not counted as a touch of the real state folder.
import { existsSync } from "node:fs";

export function realFileState(file) {
  return existsSync(file) ? "present" : "absent";
}

// A guard for tests that must never touch the REAL `~/.uw/state`: wraps the fs entry points a reader or writer would use and records any path
// under it. Call `guardRealState(after, assert)` at the top of a test file; the hook asserts, once every test has run, that nothing was recorded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function guardRealState(after, assert) {
  const real = path.join(os.homedir(), ".uw", "state").toLowerCase();
  const touched = [];
  for (const name of ["readFileSync", "statSync", "existsSync", "writeFileSync", "openSync", "readdirSync", "renameSync", "unlinkSync", "mkdirSync"]) {
    const orig = fs[name];
    fs[name] = function (p, ...rest) {
      if (typeof p === "string" && path.resolve(p).toLowerCase().startsWith(real)) touched.push(`${name}:${p}`);
      return orig.call(this, p, ...rest);
    };
  }
  after(() => { assert.deepEqual(touched, [], "no test in this file reads or writes the real ~/.uw/state"); });
  return touched;
}

// Scratch directories that clean up after themselves (issue #157: the tests leaked one uw-* folder per call into %TEMP%).
// mkTmp(prefix) = fs.mkdtempSync under os.tmpdir(); every folder made through it is removed when the importing test file finishes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

const made = [];
export const mkTmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
// only a folder this helper made, directly under os.tmpdir(), is ever removed; a cleanup that cannot finish (a handle still open) must not fail the run
after(() => { for (const d of made) if (path.dirname(d) === os.tmpdir()) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ } } });

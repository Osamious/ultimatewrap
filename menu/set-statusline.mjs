// Set settings.json's statusLine.command, losslessly.
//
// This file exists because PowerShell 5.1's ConvertFrom-Json/ConvertTo-Json is
// not a round trip: it collapses single-element arrays into scalars, re-escapes
// non-ASCII into \uXXXX, renormalises numbers, and reformats indentation. Using
// it to change one string re-serialises the user's whole Claude Code
// configuration, and a `permissions.allow` with exactly one entry stops being an
// array. JSON.parse/JSON.stringify has none of those properties.
//
// It also gets the two guarantees the PowerShell path could not: atomic (Q2.8)
// and BOM-free (Q2.9), both from menu/atomic.mjs.
//
// The path is passed in as argv[1] rather than read from cc-contract.mjs on
// purpose: install.ps1 already resolves it (and -SettingsFile can override it for
// a test), and hard-coding it here would put a second Claude Code path outside
// the two contract modules, which Q4.3's grep would reject.
import fs from "node:fs";
import { writeAtomic, readJsonOr } from "./atomic.mjs";

const [file, command] = process.argv.slice(2);
if (!file || command == null) {
  console.error("usage: set-statusline.mjs <settings.json> <command>");
  process.exit(2);
}
const doc = readJsonOr(file, null);
if (doc === null) { console.error(`cannot parse ${file}; nothing written`); process.exit(1); }
doc.statusLine = { ...(doc.statusLine ?? {}), command };
writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");

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

// The command arrives in UW_STATUSLINE_COMMAND, not argv, and that is a fix
// rather than a preference. PowerShell 5.1 strips embedded `"` from a string
// passed as an argument to a NATIVE command, so `& node $nodeEdit $path $wrapped`
// wrote
//   node C:/.../hud-shim.mjs -- C:\nvm4w\nodejs\node.exe C:/.../omc-hud.mjs
// for a $wrapped that had been correctly quoted one line earlier. Claude Code
// runs the statusline through a POSIX-ish shell, which then ate the now-unguarded
// backslashes: the node path collapsed to `C:nvm4wnodejsnode.exe`, the child
// failed, and the footer was blank on every prompt. An environment variable
// crosses the process boundary as bytes, with no quoting rules to get wrong.
//
// argv[1] is still honoured so a hand-run keeps working, and so the two forms
// cannot drift apart.
const [file, argvCommand] = process.argv.slice(2);
const command = argvCommand ?? process.env.UW_STATUSLINE_COMMAND ?? null;
if (!file || command == null) {
  console.error("usage: set-statusline.mjs <settings.json> [<command>]");
  console.error("       (or set UW_STATUSLINE_COMMAND instead of passing it)");
  process.exit(2);
}
const doc = readJsonOr(file, null);
if (doc === null) { console.error(`cannot parse ${file}; nothing written`); process.exit(1); }
doc.statusLine = { ...(doc.statusLine ?? {}), command };
writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");

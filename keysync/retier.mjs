// `key.mjs retier <id> <new-tier> [--dry yes]` and the tier check `key.mjs add` runs before PowerShell (plan 7.1, D-k, S1c).
//
// The vault id embeds the tier (`bucket.provider.tier`) and the secret lives under `LLMKEY:<id>`, so a relabel moves a
// credential. The secret must NEVER reach node (Read-Host cannot be driven, and an argument leaks to the process list and to
// script-block logging): the copy runs inside ONE PowerShell process that is only ever handed ids. Node reaches the vault only
// through the seam `{ retierCopy(oldId, newId, newTier), verifySame(oldId, newId), deleteCredential(id), exists(id) }`; the tests inject an in-memory fake.
// Order (a crash between any two steps is recoverable by running the same command again, the old secret is removed last):
//   1 retierCopy      PowerShell: read old, write new, compare back, rewrite the registry row through the vault's own writer
//   2 key-choices     node, writeAtomic, only when a provider's choice names the old id
//   3 deleteCredential the old credential. A RESUME (the old id has no registry row any more) first runs verifySame, a PowerShell
//                      in-process compare of old and new, and needs `--force yes`: only the operator vouches that it is the leftover.
// Node NEVER rewrites registry.json: the vault's Save-KeyRegistry is the single writer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeAtomic } from "../menu/atomic.mjs";
import { isTier, tierList } from "../menu/tiers.mjs";

const LLMKEYS = path.join(os.homedir(), ".llmkeys");
const VAULT_SCRIPT = path.join(LLMKEYS, "ApiKeyVault.ps1");
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class RetierError extends Error {
  constructor(code, message, exit = 1) { super(message); this.name = "RetierError"; this.code = code; this.exit = exit; }
}

/** The `add` check: null when `tier` is in the vocabulary, else the full `E_TIER_INVALID` message (first line carries the code). */
export function tierError(tier) {
  if (isTier(tier)) return null;
  return `E_TIER_INVALID: ${tier === undefined || tier === "" ? "a tier is required" : `${JSON.stringify(tier)} is not a tier`}; ` +
    `valid tiers: ${tierList().join(", ")}`;
}

/** The vault's own rule (`New-EnvVarName`, ApiKeyVault.ps1:148): `LLM_` plus the id upper-cased, every non-alphanumeric an underscore. */
export const envVarNameOf = (id) => "LLM_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_");

/** The new id: the old id with its last dot-segment (the tier) replaced; null when the id has no tier segment. */
export const newIdOf = (id, newTier) => {
  const i = id.lastIndexOf(".");
  return i < 1 ? null : `${id.slice(0, i)}.${newTier}`.toLowerCase();
};

// ------------------------------------------------------------------ production seam (ids only, never a secret)
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Steps 1-4 of the plan in one process. `$v` and `$chk` hold the secret, are compared in-process and removed, and are never printed. */
export function copyScript(oldId, newId, newTier) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$old = ${q(oldId)}; $new = ${q(newId)}; $tier = ${q(newTier)}`,
    `$v = [Win32CredManager]::Read("LLMKEY:$old")`,
    `if (-not $v) { throw "no credential under LLMKEY:$old" }`,
    `$chk = [Win32CredManager]::Read("LLMKEY:$new")`,
    `if ($chk -and -not ($chk -ceq $v)) { throw "LLMKEY:$new already exists with a different value; refusing to overwrite it" }`,
    `[Win32CredManager]::Write("LLMKEY:$new", $v)`,
    `$chk = [Win32CredManager]::Read("LLMKEY:$new")`,
    `if (-not ($chk -ceq $v)) { throw "the copy under LLMKEY:$new does not match; registry unchanged" }`,
    "Remove-Variable v, chk",
    "$reg = @(Get-KeyRegistry)",
    "$rows = @($reg | Where-Object { $_.id -ceq $old })",
    `if ($rows.Count -ne 1) { throw "registry has $($rows.Count) rows for $old" }`,
    "$rows[0].id = $new; $rows[0].tier = $tier",
    `$rows[0].envVarName = "LLM_" + ($new.ToUpper() -replace '[^A-Z0-9]', '_')`,
    "Save-KeyRegistry $reg",
    `Write-Host "Retiered '$old' -> '$new'"`,
  ].join("\n");
}
/** The resume check: old and new compared in ONE process (`$v` and `$chk` never leave it), a non-zero exit when they differ. */
export function verifyScript(oldId, newId) {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$old = ${q(oldId)}; $new = ${q(newId)}`,
    `$v = [Win32CredManager]::Read("LLMKEY:$old")`,
    `$chk = [Win32CredManager]::Read("LLMKEY:$new")`,
    "$same = [bool]$v -and [bool]$chk -and ($chk -ceq $v)",
    "Remove-Variable v, chk",
    `if (-not $same) { throw "the credentials under LLMKEY:$old and LLMKEY:$new differ, or one is missing; nothing was deleted" }`,
  ].join("\n");
}
export const deleteScript = (id) => `[Win32CredManager]::Delete("LLMKEY:" + ${q(id)}) | Out-Null`;
export const existsScript = (id) => `if ([Win32CredManager]::Read("LLMKEY:" + ${q(id)})) { 'yes' } else { 'no' }`;

function psRun(spawn, script, { capture = false } = {}) {
  const dot = `. ${q(VAULT_SCRIPT)}\n${script}`;
  const encoded = Buffer.from(dot, "utf16le").toString("base64");        // no quoting problems, and ids are the only data in it
  return spawn("powershell", ["-NoProfile", "-EncodedCommand", encoded],
    capture ? { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] } : { stdio: "inherit" });
}

/** `spawn` is injectable so a test can inspect the exact argv without starting PowerShell. */
export function productionSeam(spawn = spawnSync) {
  return {
    retierCopy(oldId, newId, newTier) {
      if (psRun(spawn, copyScript(oldId, newId, newTier)).status !== 0) throw new Error("the PowerShell copy failed");
    },
    verifySame(oldId, newId) {
      if (psRun(spawn, verifyScript(oldId, newId)).status !== 0) throw new Error("the old and the new credential differ, or one is missing");
    },
    deleteCredential(id) {
      if (psRun(spawn, deleteScript(id)).status !== 0) throw new Error("the PowerShell delete failed");
    },
    exists(id) {
      const r = psRun(spawn, existsScript(id), { capture: true });
      if (r.status !== 0) throw new Error("the PowerShell existence check failed");
      return r.stdout.trim() === "yes";
    },
  };
}

// ------------------------------------------------------------------ command
/** What a fixture pair gets instead of the credential store: it can plan a move, and it refuses every question the resume cases ask. */
const FIXTURE_STORE = Object.freeze({
  exists() { throw new RetierError("E_USAGE", "a fixture pair (--registry-file, --choices-file) never consults the real credential store, and this registry is in a resume state (the old id is not in it) which needs one; plan a move, or inject a seam"); },
});
const readJsonStrict = (file, absentOk) => {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (absentOk && e.code === "ENOENT") return {};
    throw new RetierError("E_TIER_UNREADABLE", `cannot read ${file}: ${e.code ?? e.message}`, 4);
  }
  try { return JSON.parse(text.replace(/^﻿/, "")); }
  catch { throw new RetierError("E_TIER_UNREADABLE", `${file} is present but not valid JSON`, 4); }
};

function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const name = a.slice(2);
    if (!["dry", "force", "registry-file", "choices-file"].includes(name)) throw new RetierError("E_USAGE", `unknown flag ${a} for retier`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new RetierError("E_USAGE", `flag ${a} needs an explicit value${name === "dry" || name === "force" ? " (yes or no)" : ""}`);
    i += 1;
    if ((name === "dry" || name === "force") && v !== "yes" && v !== "no") throw new RetierError("E_USAGE", `flag --${name} takes exactly yes or no, found ${JSON.stringify(v)}`);
    flags[name] = name === "dry" || name === "force" ? v === "yes" : v;
  }
  if (pos.length !== 2) throw new RetierError("E_USAGE", `usage: key.mjs retier <id> <new-tier> [--dry yes] [--force yes]; valid tiers: ${tierList().join(", ")}`);
  return { id: pos[0], newTier: pos[1], dry: flags.dry === true, force: flags.force === true, registryFile: flags["registry-file"], choicesFile: flags["choices-file"] };
}

/** Pure decision over the registry rows, the choices map and a seam `exists`: what the command would do. */
export function planRetier({ id, newTier, registry, choices, exists }) {
  if (!ID_RE.test(id)) throw new RetierError("E_USAGE", `${JSON.stringify(id)} is not a valid key id`);
  const newId = newIdOf(id, newTier);
  if (!newId) throw new RetierError("E_USAGE", `'${id}' has no tier segment to replace`);
  const row = registry.find((r) => r.id === id);
  const newRow = registry.find((r) => r.id === newId);
  const asChoice = Object.entries(choices).filter(([, v]) => v === id).map(([p]) => p);
  if (row) {
    if (row.tier === newTier) throw new RetierError("E_USAGE", `'${id}' is already tier '${newTier}'; nothing to retier`);
    if (id.split(".").pop() !== row.tier) throw new RetierError("E_USAGE", `'${id}' does not end in its own tier '${row.tier}'; refusing to guess the new id`);
    if (newRow) throw new RetierError("E_USAGE", `the new id '${newId}' already exists in the registry`);
    return { kind: "move", id, newId, newTier, fromTier: row.tier, choiceProviders: asChoice };
  }
  if (newRow && newRow.tier === newTier) {
    const oldCred = exists(id), newCred = exists(newId);
    if (!oldCred && !asChoice.length) {
      // "done" is a CLAIM about a retier that finished; a mistyped id derives a new id that exists too. Evidence: the old id ends in a
      // tier of the vocabulary other than the new one, the new credential is present, the old one is gone, no choice names the old id.
      const oldTier = id.slice(id.lastIndexOf(".") + 1);
      if (newCred && isTier(oldTier) && oldTier !== newTier) return { kind: "done", id, newId, newTier };
      throw new RetierError("E_USAGE", `the old id '${id}' is unknown: it is not in the registry, no credential or key choice names it, and ${newCred ? "it does not end in a tier other than the new one" : `the new id '${newId}' has no credential either`}; nothing to resume (check the id)`);
    }
    return { kind: "resume", id, newId, newTier, oldCred, newCred, choiceProviders: asChoice };
  }
  throw new RetierError("E_USAGE", `'${id}' is not in the registry`);
}

export function runRetier(argv, io, opts = {}) {
  const injected = opts.seam !== undefined;
  const { seam = productionSeam() } = opts;
  let { registryFile, choicesFile } = opts;
  try {
    const a = parse(argv);
    // All-or-nothing (plan 4): one test-flag file given without the other would pair a fixture with the REAL vault file for the
    // other, so they go together. A fixture pair NEVER reaches the real credential store: without an injected seam it may only
    // plan (--dry yes), and it gets a store that refuses every question (the resume cases need one), never the real `exists`.
    const fixturePair = a.registryFile !== undefined || opts.registryFile !== undefined;
    if ((a.registryFile === undefined) !== (a.choicesFile === undefined)) {
      throw new RetierError("E_USAGE", "incomplete test-flag set: --registry-file and --choices-file go together (one alone would read the real vault file for the other)");
    }
    registryFile = a.registryFile ?? registryFile ?? path.join(LLMKEYS, "registry.json");
    choicesFile = a.choicesFile ?? choicesFile ?? path.join(LLMKEYS, "key-choices.json");
    const err = tierError(a.newTier);
    if (err) throw new RetierError("E_TIER_INVALID", err, 1);
    if (fixturePair && !a.dry && !injected) {
      throw new RetierError("E_USAGE", "--registry-file and --choices-file name fixtures: without --dry yes they would still move a REAL credential, so they are refused");
    }
    const registry = readJsonStrict(registryFile, false);
    if (!Array.isArray(registry) || !registry.every((r) => r && typeof r === "object" && typeof r.id === "string")) throw new RetierError("E_TIER_UNREADABLE", `${registryFile} is not a list of rows`, 4);
    const choices = readJsonStrict(choicesFile, true);
    if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new RetierError("E_TIER_UNREADABLE", `${choicesFile} is valid JSON but not a provider-to-id map`, 4);
    const store = fixturePair && !injected ? FIXTURE_STORE : seam;
    // a credential-store failure while PLANNING is an unreadable input (exit 4), never a stack trace
    const exists = (x) => {
      try { return store.exists(x); }
      catch (e) { throw e instanceof RetierError ? e : new RetierError("E_TIER_UNREADABLE", `cannot ask the credential store whether LLMKEY:${x} exists: ${e.message}`, 4); }
    };
    const p = planRetier({ id: a.id, newTier: a.newTier, registry, choices, exists });

    if (p.kind === "done") { io.out(`old id not in registry; new id exists; nothing to do ('${p.newId}' is tier ${p.newTier} and holds its credential)`); return 0; }
    io.out(`retier plan (${p.kind}): '${p.id}' -> '${p.newId}'` +
      `${p.kind === "move" ? ` (tier ${p.fromTier} -> ${p.newTier}, env var ${envVarNameOf(p.id)} -> ${envVarNameOf(p.newId)})` : ""}`);
    if (p.kind === "move") io.out("  1. in one PowerShell process: copy the credential, compare it, rewrite the registry row (id, tier, envVarName)");
    else io.out(`  1. already done: the registry names '${p.newId}'${p.newCred ? "" : "; its credential is MISSING"}`);
    io.out(`  2. key-choices.json: ${p.choiceProviders.length ? `repoint ${p.choiceProviders.join(", ")} to '${p.newId}'` : "unchanged (no provider names the old id)"}`);
    io.out(`  3. delete the old credential LLMKEY:${p.id}${p.kind === "resume" ? (p.oldCred ? " (needs --force yes: its registry row is gone, so a PowerShell compare of old and new runs first)" : " (already gone)") : ""}`);
    if (a.dry) { io.out("--dry yes: plan only, nothing was changed"); return 0; }

    if (p.kind === "resume" && p.oldCred && !p.newCred)
      throw new RetierError("E_WRITE", `the registry names '${p.newId}' but its credential is missing; refusing to delete the old one`, 5);
    if (p.kind === "resume" && p.oldCred) {
      if (!a.force) throw new RetierError("E_USAGE", `'${p.id}' has no registry row, so only you can vouch that LLMKEY:${p.id} is the leftover of an interrupted retier: re-run with --force yes to compare it with LLMKEY:${p.newId} and delete it (nothing was changed)`);
      try { seam.verifySame(p.id, p.newId); }
      catch (e) { throw new RetierError("E_WRITE", `${e.message}; the old credential was NOT deleted (nothing was changed)`, 5); }
    }
    try {
      if (p.kind === "move") seam.retierCopy(p.id, p.newId, p.newTier);
      if (p.choiceProviders.length) {
        for (const prov of p.choiceProviders) choices[prov] = p.newId;
        writeAtomic(choicesFile, JSON.stringify(choices, null, 2) + "\n");
        io.out(`key-choices.json: ${p.choiceProviders.join(", ")} -> '${p.newId}'`);
      }
      if (p.kind === "move" || p.oldCred) seam.deleteCredential(p.id);
    } catch (e) {
      throw new RetierError("E_WRITE", `${e.message}; run the same command again to resume (no secret is lost: the old one is removed last)`, 5);
    }
    io.out(`retiered '${p.id}' -> '${p.newId}'`);
    io.out("not done by retier: run keysync (owner-authorised) to propagate the new env var name, then `subagent-policy rebuild`");
    return 0;
  } catch (e) {
    if (!(e instanceof RetierError)) throw e;
    io.err(e.message.startsWith("E_") ? e.message : `${e.code}: ${e.message}`);
    return e.exit;
  }
}

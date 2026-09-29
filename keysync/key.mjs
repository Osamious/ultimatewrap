// #21: one CLI for the whole key lifecycle -- add, test, list, remove, and
// recording the deliberate choice a multi-key provider needs. No subcommand
// here reimplements filterRegistry/chooseKeys; every mutation re-runs the
// REAL functions from keysync.mjs against the just-mutated vault, so the
// ambiguity check this file surfaces is the same one `keysync/run.mjs` would
// hit on its next run -- never a second copy of the four exclusion rules.
//
// Two different subprocess shapes, and this is deliberate, not an oversight:
//   `add`  -- Add-ApiKey's `Read-Host -AsSecureString` must read from the real
//             terminal, so this uses spawnSync with stdio "inherit". Nothing
//             is parsed from its output; success/failure comes from the exit
//             code.
//   others -- no interactive prompt, so they keep the captured execFileSync
//             pattern `key-health.mjs` already uses, and parse structured
//             output where there is any.
import path from "node:path";
import os from "node:os";
import readline from "node:readline/promises";
import { spawnSync, execFileSync } from "node:child_process";
import { writeAtomic } from "../menu/atomic.mjs";
import { loadVault, filterRegistry, chooseKeys, loadKeyChoices, KEY_CHOICES_FILE }
  from "./keysync.mjs";

const VAULT_SCRIPT = path.join(os.homedir(), ".llmkeys", "ApiKeyVault.ps1");
const dotSource = (cmd) => `. '${VAULT_SCRIPT.replace(/'/g, "''")}'; ${cmd}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function runInherited(cmd) {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", dotSource(cmd)],
    { stdio: "inherit" });
  return r.status === 0;
}

function runCaptured(cmd) {
  return execFileSync("powershell", ["-NoProfile", "-Command", dotSource(cmd)],
    { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90000 });
}

// After any add/remove, re-check the REAL vault against the REAL choice file.
// Ambiguity for a provider this command did not touch is not this command's
// business to fix -- only prompt for one this command's own mutation created
// or could plausibly have created.
function reconcile({ promptFor } = {}) {
  const { registry, providers } = loadVault();
  const filtered = filterRegistry(registry, providers);
  try {
    chooseKeys(filtered);
    return { ok: true };
  } catch (err) {
    const match = /multi-key provider\(s\) with no deliberate choice in .*?: (\[.*\]) —/.exec(err.message);
    const ambiguous = match ? JSON.parse(match[1]) : [];
    if (promptFor) {
      const mine = ambiguous.find((a) => a.provider === promptFor);
      if (mine) return { ok: false, ambiguous, mine };
    }
    return { ok: false, ambiguous, mine: null };
  }
}

async function promptChoice(provider, ids) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nProvider '${provider}' now has ${ids.length} keys and no recorded choice:`);
  ids.forEach((id, i) => console.log(`  [${i}] ${id}`));
  let idx = -1;
  while (!(idx >= 0 && idx < ids.length)) {
    const ans = await rl.question(`Pick the one keysync should route on (0-${ids.length - 1}): `);
    idx = Number.parseInt(ans, 10);
  }
  rl.close();
  return ids[idx];
}

function writeChoice(provider, id) {
  const choices = loadKeyChoices();
  choices[provider] = id;
  writeAtomic(KEY_CHOICES_FILE, JSON.stringify(choices, null, 2) + "\n");
  console.log(`Recorded: '${provider}' -> '${id}' in ${KEY_CHOICES_FILE}`);
}

async function cmdAdd(args) {
  const [bucket, provider, tier] = args._;
  if (!bucket || !provider || !tier) {
    console.error("usage: key.mjs add <bucket> <provider> <tier> [--notes \"...\"]");
    process.exitCode = 1;
    return;
  }
  const notes = args.notes ?? "";
  const ok = runInherited(
    `Add-AndVerifyKey -Bucket ${q(bucket)} -Provider ${q(provider)} -Tier ${q(tier)} -Notes ${q(notes)}`);
  if (!ok) { process.exitCode = 1; return; }

  const result = reconcile({ promptFor: provider });
  if (result.ok) { console.log("Vault resolves cleanly -- no ambiguity."); return; }
  if (!result.mine) {
    console.log("Note: this add did not create the ambiguity below; leaving it for its own provider.");
    console.log(JSON.stringify(result.ambiguous, null, 2));
    return;
  }
  const chosenId = await promptChoice(provider, result.mine.ids);
  writeChoice(provider, chosenId);
  const after = reconcile();
  if (!after.ok) {
    console.error("Still ambiguous after recording a choice -- inspect manually:");
    console.error(JSON.stringify(after.ambiguous, null, 2));
    process.exitCode = 1;
  }
}

function cmdRemove(args) {
  const [id] = args._;
  if (!id) {
    console.error("usage: key.mjs remove <id>");
    process.exitCode = 1;
    return;
  }
  const ok = runInherited(`Remove-ApiKey -Id ${q(id)}`);
  if (!ok) { process.exitCode = 1; return; }

  const choices = loadKeyChoices();
  let changed = false;
  for (const [provider, chosenId] of Object.entries(choices)) {
    if (chosenId === id) { delete choices[provider]; changed = true; }
  }
  if (changed) {
    writeAtomic(KEY_CHOICES_FILE, JSON.stringify(choices, null, 2) + "\n");
    console.log(`Cleared dangling choice(s) pointing at '${id}' from ${KEY_CHOICES_FILE}.`);
  }

  const result = reconcile();
  if (result.ok) { console.log("Vault resolves cleanly -- no ambiguity."); return; }
  console.warn("Removing this key left the vault ambiguous -- record a choice with 'prefer':");
  console.warn(JSON.stringify(result.ambiguous, null, 2));
}

function cmdList() {
  process.stdout.write(runCaptured("List-ApiKeys | Out-String"));
}

function cmdTest(args) {
  const [id] = args._;
  if (!id) {
    console.error("usage: key.mjs test <id>");
    process.exitCode = 1;
    return;
  }
  runInherited(`Test-ApiKey -Id ${q(id)}`);
}

function cmdPrefer(args) {
  const [provider, id] = args._;
  if (!provider || !id) {
    console.error("usage: key.mjs prefer <provider> <id>");
    process.exitCode = 1;
    return;
  }
  const { registry, providers } = loadVault();
  const filtered = filterRegistry(registry, providers);
  const candidates = filtered.filter((r) => r.provider === provider);
  if (!candidates.some((c) => c.id === id)) {
    console.error(`'${id}' is not a live, filtered key for provider '${provider}'. ` +
      `Live options: ${candidates.map((c) => c.id).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }
  writeChoice(provider, id);
  const result = reconcile();
  if (!result.ok) {
    console.error("Still ambiguous elsewhere:");
    console.error(JSON.stringify(result.ambiguous, null, 2));
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[++i] ?? true; }
    else out._.push(a);
  }
  return out;
}

const [, , sub, ...rest] = process.argv;
const args = parseArgs(rest);

switch (sub) {
  case "add": await cmdAdd(args); break;
  case "remove": cmdRemove(args); break;
  case "list": cmdList(); break;
  case "test": cmdTest(args); break;
  case "prefer": cmdPrefer(args); break;
  default:
    console.error("usage: key.mjs <add|remove|list|test|prefer> ...");
    process.exitCode = 1;
}

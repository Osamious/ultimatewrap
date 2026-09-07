// The only entry point for `refresh/discover.mjs`.
//
//   node refresh/cli.mjs                       plan the run, make no request
//   node refresh/cli.mjs --only groq,agentrouter
//   node refresh/cli.mjs --live                fan out, write the cache
//
// DRY BY DEFAULT, and that is a safety property rather than a convenience. A
// live run is 44 authenticated requests against 44 third-party hosts and it
// needs the user's explicit authorization each time; a bare invocation, a typo
// or a shell-history recall must therefore cost nothing. Without `--live` this
// prints the resolved URL or the refusal for every provider and exits.
//
// It reads the vault files directly rather than through the keysync pipeline.
// That is deliberate for as long as discovery is unwired: the transport is
// reviewed on its own before anything authenticated runs, so nothing here can
// perturb the path that writes routing config. The cost is that keysync's
// deliberate multi-key choices are not visible here -- see chooseCredential.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  discoverAll, resolveListingUrl, listingProfileFor, writeCacheRecord,
  resolveCacheDir, coverageOf, PINNED_HOSTS,
} from "./discover.mjs";

const VAULT = path.join(os.homedir(), ".llmkeys");

const hasFlag = (args, f) => args.includes(f);
const valueOfFlag = (args, f) => {
  const i = args.indexOf(f);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};

// PowerShell 5.1 writes a BOM and JSON.parse throws on a leading U+FEFF; the
// vault files are PowerShell-written, so the strip is load-bearing rather than
// defensive padding. keysync's own reader does exactly this, for this reason.
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

/**
 * The same three exclusions `keysync/filterRegistry` applies, restated here
 * because this tree does not import that one. When discovery is wired, this
 * duplicate goes and the caller passes the filtered set in.
 */
function eligibleCredentials(registry, profiles) {
  return registry.filter((r) =>
    !/^sportsvector/i.test(String(r.bucket ?? "")) &&
    r.tier !== "management" &&
    profiles.has(r.provider) &&
    profiles.get(r.provider).protocol !== "generic");
}

/**
 * One credential per provider, chosen by lowest id so the pick is deterministic
 * and examinable rather than an unexamined timestamp.
 *
 * KNOWN LIMIT, stated rather than implied: keysync records DELIBERATE picks for
 * the two multi-key providers (a personal key preferred over an institutional
 * one, and a named primary), and this file cannot see them. Discovery is a
 * read-only listing call, so a different key of the same provider changes which
 * entitlements are listed but routes nothing. Consolidate onto keysync's choice
 * when discovery is wired.
 */
function chooseCredential(creds) {
  const byProvider = new Map();
  for (const c of [...creds].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!byProvider.has(c.provider)) byProvider.set(c.provider, c);
  }
  return [...byProvider.values()];
}

/**
 * Batch-load, use, then drop (F5). One PowerShell session for every id: a shell
 * per key costs about 45 seconds across the set. Key values are never printed,
 * never written, and never returned past this function.
 *
 * WHAT THE TEARDOWN ACTUALLY DOES, corrected: it drops every reference this
 * process holds to a key. It does NOT overwrite the bytes -- JS strings are
 * immutable, so assigning NULs to `cache[k]` allocates a NEW string and leaves
 * the original for the collector, and `raw` (the whole map, as one string) is
 * never cleared at all. Overwriting a JS string in place is not something this
 * language offers; claiming it did was the defect.
 */
export async function withKeys(ids, fn, { execFile = execFileSync } = {}) {
  const list = ids.map((i) => `'${String(i).replace(/'/g, "''")}'`).join(",");
  const script =
    `. '${path.join(VAULT, "ApiKeyVault.ps1").replace(/'/g, "''")}'; ` +
    `$out=@{}; foreach($id in @(${list})){ $v = Get-ApiKeyValue -Id $id; if($v){ $out[$id]=$v } }; ` +
    `$out | ConvertTo-Json -Compress -Depth 3`;

  let cache;
  try {
    const raw = execFile("powershell", ["-NoProfile", "-Command", script],
      { encoding: "utf8", maxBuffer: 16 << 20, timeout: 90_000 });
    cache = JSON.parse(raw.trim());
  } catch (e) {
    // THE ORIGINAL ERROR IS NEVER RETHROWN, and never inspected beyond a status.
    // The child's stdout is the id-to-key map for every selected provider, and
    // on a non-zero exit, the 90 s timeout or a maxBuffer overflow `execFileSync`
    // throws an Error carrying that stdout on `.stdout` and on `.output[1]`.
    // Node prints an uncaught error's own enumerable properties, so rethrowing
    // publishes the whole map to stderr. A future runtime may attach more
    // fields, so a fresh Error carrying one number is the only safe shape.
    throw new Error(`the vault read failed (${e?.status ?? e?.code ?? "no status"}); no key was read`);
  }

  try {
    return await fn((id) => cache[id]);
  } finally {
    for (const k of Object.keys(cache)) delete cache[k];
  }
}

// ------------------------------------------------------------------- the run

/**
 * Everything the run touches that is not pure computation arrives through this
 * parameter list, and nothing else does. That is not decoration: this function
 * is what R10 actually executes, and until it was reachable the only tested part
 * of this file was `withKeys`. A test can now drive the whole selection, plan,
 * fan-out and report with no vault on disk, no PowerShell child, no socket and
 * no `process.exit` -- which is the only way to assert the ORDER of those steps,
 * and the order is the safety property (`--out` validated before any request;
 * nothing sent at all without `--live`).
 *
 * @returns {number} the exit code, so the caller decides how to exit.
 */
export async function main({
  args = process.argv.slice(2),
  vault = VAULT,
  readJsonImpl = readJson,
  withKeysImpl = withKeys,
  discoverAllImpl = discoverAll,
  writeCacheRecordImpl = writeCacheRecord,
  resolveCacheDirImpl = resolveCacheDir,
  log = console.log,
  logError = console.error,
} = {}) {
  const profiles = new Map(readJsonImpl(path.join(vault, "providers.json")).map((p) => [p.provider, p]));
  const registry = readJsonImpl(path.join(vault, "registry.json"));

  const only = valueOfFlag(args, "--only");
  const wanted = only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null;

  let chosen = chooseCredential(eligibleCredentials(registry, profiles));
  if (wanted) chosen = chosen.filter((c) => wanted.has(c.provider));
  chosen.sort((a, b) => a.provider.localeCompare(b.provider));

  if (!chosen.length) {
    logError("no eligible provider matched. --only takes provider names, not credential ids.");
    return 2;
  }

  const targets = chosen.map((c) => ({ provider: c.provider, credentialId: c.id, profile: profiles.get(c.provider) }));

  // ---- the plan, printed either way, so a live run is never a surprise ------
  log(`${targets.length} provider${targets.length === 1 ? "" : "s"} selected\n`);
  for (const t of targets) {
    const listing = listingProfileFor(t.profile);
    if (listing === null) { log(`  ${t.provider.padEnd(16)} no-endpoint (listing: null)`); continue; }
    const r = resolveListingUrl(t.provider, t.profile);
    const pin = PINNED_HOSTS.has(t.provider) ? "" : "  [host not pinned]";
    log(`  ${t.provider.padEnd(16)} ${r.refusal ? `REFUSED ${r.refusal}` : r.url}${pin}`);
  }

  if (!hasFlag(args, "--live")) {
    log(`\nno request was made. Re-run with --live to fan out (${targets.length} authenticated requests).`);
    return 0;
  }

  // Validated BEFORE a single request is spent: this path reaches an icacls DACL
  // rewrite, and finding out it was `.` after 44 authenticated calls is the
  // wrong order to discover it in.
  const outDir = resolveCacheDirImpl(valueOfFlag(args, "--out"));

  // A partial or failed run RETAINS its cache, and each record is written THE
  // MOMENT ITS PROVIDER RESOLVES rather than after the fan-out. Writing at the
  // end meant a single unhandled failure anywhere in the fan-out discarded every
  // completed record and forced a re-authorized re-run of all 44 calls.
  const writeFailure = new Map();          // provider -> message, or null on success
  const onResult = (r) => {
    try { writeCacheRecordImpl(r, { dir: outDir }); writeFailure.set(r.provider, null); }
    catch (e) { writeFailure.set(r.provider, String(e.message).slice(0, 120)); }
  };

  const results = await withKeysImpl(targets.map((t) => t.credentialId), (keyOf) =>
    discoverAllImpl(targets.map((t) => ({ ...t, key: keyOf(t.credentialId) })), { onResult }));

  results.sort((a, b) => a.provider.localeCompare(b.provider));

  // ---- the report: providers by name, never a key, never a response body ----
  log("");
  for (const r of results) {
    const tail =
      r.outcome === "ok"
        ? `${r.models.length} kept of ${r.count} listed` +
          `${r.rejected ? `, ${r.rejected} refused` : ""}${r.truncated ? `, ${r.truncated} past the cap` : ""}`
        : r.outcome === "unsupported-shape" ? `shape seen: ${r.keys.join(", ") || "(none)"}` :
          r.outcome === "error" ? `${r.status || ""} ${r.reason ?? ""}`.trim() :
          r.outcome === "auth" ? String(r.status) : "";
    log(`  ${r.outcome.padEnd(18)} ${r.provider.padEnd(16)} ${tail}`);
  }

  for (const [provider, failure] of writeFailure) {
    if (failure) logError(`  cache write failed for ${provider}: ${failure}`);
  }
  const written = [...writeFailure.values()].filter((v) => v === null).length;

  const cov = coverageOf(results);
  const pct = cov.eligible ? Math.round((cov.ok / cov.eligible) * 1000) / 10 : 0;
  log(`\ncoverage ${cov.ok} of ${cov.eligible} eligible (${pct}%), ${cov.total} attempted, ${written} of ${results.length} records cached`);
  log(Object.entries(cov.by).map(([k, v]) => `${k} ${v}`).join("  "));

  const shapes = cov.by["unsupported-shape"] ?? 0;
  if (shapes) {
    log(`\n${shapes} of ${results.length} providers returned a shape this parser does not read.`);
    log("Re-run ONLY those providers after adding an envelope candidate; the other records stand.");
  }
  return written === results.length ? 0 : 1;
}

// Run only when invoked as the entry point, so the functions above are reachable
// from a test without the vault read and the fan-out running on import. Compared
// by resolved path rather than `import.meta.main`, which only exists from Node 24
// and would silently make this file a no-op below it.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}

// Key tier vocabulary, `add` validation and `retier` (plan 7.1, 9.1, stage S1c). Fixtures and an in-memory fake vault only: the
// real Credential Manager and ~/.llmkeys are never touched (a guard hashes the content of registry.json, key-choices.json and ApiKeyVault.ps1 around the whole file), and the
// production seam is exercised only through an injected spawn spy that never starts PowerShell.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TIERS, tierList, isTier } from "../menu/tiers.mjs";
import { runRetier, productionSeam, copyScript, verifyScript, deleteScript, existsScript, envVarNameOf, newIdOf } from "../keysync/retier.mjs";
import { filterRegistry, chooseKeys } from "../keysync/keysync.mjs";
import { realFileHashes, assertRealFilesUntouched } from "./fixtures/no-real-state.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = path.join(ROOT, "keysync", "key.mjs");
const tmp = () => mkTmp("uw-tiers-");
const rd = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const dirs = [];

// The fake secret is assembled at runtime from pieces (GH013: no token-shaped literal in a test file).
const SECRET = ["fake", "vault", "value", String(process.pid), "zz"].join("_");

// ---- no-touch guard: the three real vault files this file's subject could ever write, hashed by CONTENT (not the whole folder by size
// and mtime: a concurrent keysync run touches other files there and must not fail an unrelated test)
function fingerprint() {
  const out = {}, d = path.join(os.homedir(), ".llmkeys");
  for (const n of ["registry.json", "key-choices.json", "ApiKeyVault.ps1"]) {
    try { out[n] = crypto.createHash("sha256").update(fs.readFileSync(path.join(d, n))).digest("hex"); } catch { out[n] = "absent"; }
  }
  return out;
}
// state/bench.json is rewritten legitimately by bench sweeps, so it is checked by the incident signature only: it fails when it now holds
// byte-for-byte fixture content (a fixture helper once overwrote it), not merely because it changed.
let before0, bench0;
before(() => { before0 = fingerprint(); bench0 = realFileHashes(["bench"]); });
after(() => {
  assert.deepEqual(fingerprint(), before0, "no test in this file changed the real registry.json, key-choices.json or ApiKeyVault.ps1");
  assertRealFilesUntouched(assert, bench0, realFileHashes(["bench"]), { signature: ["bench"] });
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

// ---- fixtures: a registry, a choices file, and an in-memory vault that is the ONLY writer of the registry file
const row = (bucket, provider, tier, extra = {}) => {
  const id = `${bucket}.${provider}.${tier}`;
  return { added: "2026-09-01T10:00:00", bucket, envVarName: "LLM_" + id.toUpperCase().replace(/[^A-Z0-9]/g, "_"), id, notes: `n-${id}`, provider, tier, ...extra };
};
const ROWS = () => [row("b", "alpha", "paid"), row("b", "multi", "paid"), row("c", "multi", "free"), row("b", "other", "free"), row("b", "adm", "management")];
const PROVIDERS = new Map(["alpha", "multi", "other", "adm"].map((p) => [p, { protocol: "openai" }]));

function setup({ rows = ROWS(), choices, secretFor = ["b.alpha.paid", "b.multi.paid"] } = {}) {
  const dir = tmp(); dirs.push(dir);
  const registryFile = path.join(dir, "registry.json"), choicesFile = path.join(dir, "key-choices.json");
  fs.writeFileSync(registryFile, "﻿" + JSON.stringify(rows, null, 2));        // BOM like PowerShell 5.1
  if (choices !== undefined) fs.writeFileSync(choicesFile, JSON.stringify(choices, null, 2) + "\n");
  const creds = new Map(secretFor.map((id) => [id, SECRET]));
  const log = [];
  const vault = {
    creds, log, failAt: null,
    seam: {
      retierCopy(oldId, newId, newTier) {
        log.push(["copy", oldId, newId, newTier]);
        const v = creds.get(oldId);
        if (v === undefined) throw new Error("no credential under the old id");
        if (creds.has(newId) && creds.get(newId) !== v) throw new Error("the new id already exists with a different value; refusing to overwrite it");   // what copyScript does
        creds.set(newId, v);
        if (vault.failAt === "afterWriteNew") throw new Error("injected crash after write-new");
        if (creds.get(newId) !== v) throw new Error("copy mismatch");
        const reg = JSON.parse(fs.readFileSync(registryFile, "utf8").replace(/^﻿/, ""));
        const r = reg.find((x) => x.id === oldId);
        r.id = newId; r.tier = newTier; r.envVarName = envVarNameOf(newId);
        fs.writeFileSync(registryFile, "﻿" + JSON.stringify(reg, null, 2));
        if (vault.failAt === "afterCopy") throw new Error("injected crash after the registry update");
      },
      verifySame(oldId, newId) {
        log.push(["verify", oldId, newId]);
        if (creds.get(oldId) === undefined || creds.get(oldId) !== creds.get(newId)) throw new Error("the old and the new credential differ, or one is missing");
      },
      deleteCredential(id) {
        log.push(["delete", id]);
        if (vault.failAt === "beforeDelete") throw new Error("injected crash before the delete");
        creds.delete(id);
      },
      exists(id) { return creds.has(id); },
    },
  };
  const run = (...argv) => {
    const out = [], err = [];
    const code = runRetier(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, { seam: vault.seam, registryFile, choicesFile });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  return { dir, registryFile, choicesFile, vault, run, registry: () => JSON.parse(fs.readFileSync(registryFile, "utf8").replace(/^﻿/, "")), choices: () => rd(choicesFile) };
}

// ------------------------------------------------------------------ 1 vocabulary and the management contract
test("the vocabulary has exactly the five tiers and management is the only excluded one", () => {
  assert.deepEqual(tierList().sort(), ["free", "free-deposit", "management", "paid", "subscription"]);
  assert.deepEqual(tierList().filter((t) => TIERS[t].excluded), ["management"]);
  for (const t of tierList()) assert.ok(isTier(t));
  for (const bad of ["freee", "Paid", "deposit", "", undefined, null, "constructor", "__proto__"]) assert.equal(isTier(bad), false, String(bad));
});

test("contract: the management literals in keysync.mjs and refresh/cli.mjs equal the vocabulary excluded set", () => {
  const want = tierList().filter((t) => TIERS[t].excluded).sort();
  for (const f of ["keysync/keysync.mjs", "refresh/cli.mjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const found = [...src.matchAll(/\br\.tier !== "([a-z-]+)"/g)].map((m) => m[1]);
    assert.ok(found.length >= 1, `${f} has a tier exclusion literal`);
    assert.deepEqual([...new Set(found)].sort(), want, `${f} excludes exactly the vocabulary's excluded tiers`);
  }
});

// ------------------------------------------------------------------ 2 `add` validates before PowerShell
// A temp HOME whose ApiKeyVault.ps1 only drops a marker file: a tier that reaches PowerShell leaves the marker, a refused one cannot.
function addRun(...args) {
  const home = tmp(); dirs.push(home);
  const marker = path.join(home, "reached.txt");
  const vaultDir = path.join(home, ".llmkeys"); fs.mkdirSync(vaultDir);
  fs.writeFileSync(path.join(vaultDir, "ApiKeyVault.ps1"),
    `function Add-AndVerifyKey { param($Bucket,$Provider,$Tier,$Notes) Set-Content -Path '${marker}' -Value $Tier }\n`);
  fs.writeFileSync(path.join(vaultDir, "registry.json"), "[]");
  fs.writeFileSync(path.join(vaultDir, "providers.json"), "[]");
  const before = fs.readdirSync(vaultDir).sort().map((n) => fs.readFileSync(path.join(vaultDir, n), "utf8"));
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const r = spawnSync(process.execPath, [KEY, "add", ...args], { encoding: "utf8", env });
  const after = fs.readdirSync(vaultDir).sort().map((n) => fs.readFileSync(path.join(vaultDir, n), "utf8"));
  return { r, reached: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null, untouched: JSON.stringify(before) === JSON.stringify(after) };
}

for (const bad of ["freee", "Paid", "deposit", ""]) {
  test(`add refuses tier ${JSON.stringify(bad)} with E_TIER_INVALID before PowerShell is reached and touches nothing`, () => {
    const { r, reached, untouched } = addRun("b", "p", bad);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.split("\n")[0].startsWith("E_TIER_INVALID"), r.stderr);
    for (const t of tierList()) assert.ok(r.stderr.includes(t), `lists ${t}`);
    assert.equal(reached, null, "the PowerShell runner was not reached");
    assert.ok(untouched, "vault dir unchanged");
  });
}

test("add with the tier missing entirely is also refused with the tier list", () => {
  const { r, reached } = addRun("b", "p");
  assert.equal(r.status, 1);
  assert.ok(r.stderr.startsWith("E_TIER_INVALID"));
  assert.equal(reached, null);
});

test("add with a valid tier, free-deposit included, reaches the PowerShell step", () => {
  for (const t of ["free-deposit", "subscription"]) {
    const { r, reached } = addRun("b", "p", t);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(reached, t);
  }
});

// ------------------------------------------------------------------ 3 env var rule
test("env var rule: every row of a 78-row registry fixture derives its stored envVarName; free-deposit derives ...FREE_DEPOSIT", () => {
  const tiers = ["free", "paid", "management"];
  const rows = Array.from({ length: 78 }, (_, i) => {
    const bucket = i % 5 === 0 ? "osama.hasoneh" : `bk${i % 7}`, provider = `prov-${i}.x_${i % 3}`, tier = tiers[i % 3];
    const id = `${bucket}.${provider}.${tier}`;
    return { id, tier, envVarName: "LLM_" + id.toUpperCase().split(/[^A-Z0-9]/).join("_") };      // an independent spelling of the rule
  });
  assert.equal(rows.length, 78);
  for (const r of rows) assert.equal(envVarNameOf(r.id), r.envVarName, r.id);
  assert.equal(envVarNameOf("b.alpha.free-deposit"), "LLM_B_ALPHA_FREE_DEPOSIT");
  assert.equal(newIdOf("b.alpha.paid", "free-deposit"), "b.alpha.free-deposit");
  assert.equal(newIdOf("nodots", "free"), null);
});

// ------------------------------------------------------------------ 4 retier over the fake vault
test("retier moves the secret byte-identically and changes only id, tier and envVarName of one row", () => {
  const s = setup();
  const before = s.registry();
  const r = s.run("b.alpha.paid", "free-deposit");
  assert.equal(r.code, 0, r.err);
  assert.equal(s.vault.creds.get("b.alpha.free-deposit"), SECRET);
  assert.ok(!s.vault.creds.has("b.alpha.paid"));
  const after = s.registry(), i = before.findIndex((x) => x.id === "b.alpha.paid");
  assert.deepEqual({ ...after[i] }, { ...before[i], id: "b.alpha.free-deposit", tier: "free-deposit", envVarName: "LLM_B_ALPHA_FREE_DEPOSIT" });
  assert.deepEqual(after.filter((_, k) => k !== i), before.filter((_, k) => k !== i), "no other row changed");
  assert.deepEqual(s.vault.log.map((l) => l[0]), ["copy", "delete"], "old secret removed last");
  assert.ok(!fs.existsSync(s.choicesFile), "no choices file was created when none named the old id");
  assert.match(r.out, /not done by retier: run keysync/);
});

test("key-choices.json is updated only for providers that named the old id", () => {
  const s = setup({ choices: { multi: "b.multi.paid", other: "b.other.free" } });
  const r = s.run("b.multi.paid", "free");
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(s.choices(), { multi: "b.multi.free", other: "b.other.free" });
  const s2 = setup({ choices: { multi: "c.multi.free" } });
  const bytes = fs.readFileSync(s2.choicesFile, "utf8");
  assert.equal(s2.run("b.alpha.paid", "free").code, 0);
  assert.equal(fs.readFileSync(s2.choicesFile, "utf8"), bytes, "choices naming other ids stay byte-identical");
});

for (const failAt of ["afterWriteNew", "afterCopy", "beforeDelete"]) {
  for (const withChoice of [true, false]) {
    test(`crash injection ${failAt} (choices ${withChoice ? "name" : "do not name"} the old id): no secret lost, a re-run completes, old removed last`, () => {
      const s = setup({ choices: withChoice ? { multi: "b.multi.paid" } : { multi: "c.multi.free" } });
      s.vault.failAt = failAt;
      const first = s.run("b.multi.paid", "free");
      assert.equal(first.code, 5, first.out + first.err);
      assert.ok(first.err.startsWith("E_WRITE"));
      assert.ok(s.vault.creds.get("b.multi.paid") === SECRET || s.vault.creds.get("b.multi.free") === SECRET, "the secret is held under at least one id");
      assert.equal(s.vault.creds.get("b.multi.paid"), SECRET, "the old secret is still there after every crash point");
      if (failAt === "afterCopy" && withChoice) {
        // DANGLING CHOICE: the registry names only the new id while key-choices.json still names the old one. Loud, never silent.
        assert.throws(() => chooseKeys(filterRegistry(s.registry(), PROVIDERS), s.choices()), /multi-key provider\(s\) with no deliberate choice/);
      }
      s.vault.failAt = null;
      s.vault.log.length = 0;
      const resumes = failAt !== "afterWriteNew";                                  // the registry already names the new id: the old id has no row, so deleting its credential needs --force yes
      if (resumes) {
        const refused = s.run("b.multi.paid", "free");
        assert.equal(refused.code, 1, refused.out + refused.err); assert.match(refused.err, /^E_USAGE: .*--force yes/);
        assert.equal(s.vault.creds.get("b.multi.paid"), SECRET, "without --force the old credential is still there");
        assert.deepEqual(s.vault.log, [], "and no vault call was made");
      }
      const second = s.run("b.multi.paid", "free", ...(resumes ? ["--force", "yes"] : []));
      assert.equal(second.code, 0, second.err);
      assert.equal(s.vault.creds.get("b.multi.free"), SECRET);
      assert.ok(!s.vault.creds.has("b.multi.paid"));
      const reg = s.registry();
      assert.ok(reg.some((x) => x.id === "b.multi.free" && x.tier === "free" && x.envVarName === "LLM_B_MULTI_FREE"));
      assert.ok(!reg.some((x) => x.id === "b.multi.paid"));
      if (withChoice) assert.deepEqual(s.choices(), { multi: "b.multi.free" });
      assert.doesNotThrow(() => chooseKeys(filterRegistry(reg, PROVIDERS), withChoice ? s.choices() : { multi: "c.multi.free" }));
      const calls = s.vault.log.map((l) => l.join(" "));
      assert.equal(calls.at(-1), "delete b.multi.paid", "the delete is the last vault call of the finishing run");
      if (resumes) assert.equal(calls.at(-2), "verify b.multi.paid b.multi.free", "a resume compares old and new in the vault process right before the delete");
      assert.equal(calls.filter((c) => c.startsWith("copy")).length, failAt === "afterWriteNew" ? 1 : 0, "the copy is repeated only when it had not finished");
    });
  }
}

test("a dangling choice is harmless for a single-key provider", () => {
  const s = setup({ choices: { alpha: "b.alpha.paid" } });
  s.vault.failAt = "afterCopy";
  assert.equal(s.run("b.alpha.paid", "free").code, 5);
  const alphaOnly = s.registry().filter((r) => r.provider === "alpha");           // the provider under test is single-key
  assert.doesNotThrow(() => chooseKeys(filterRegistry(alphaOnly, PROVIDERS), s.choices()));
});

test("resume: a finished retier exits 0 with nothing to do and makes no vault call, and never says 'already retiered'", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  assert.equal(s.run("b.multi.paid", "free").code, 0);
  s.vault.log.length = 0;
  const r = s.run("b.multi.paid", "free");
  assert.equal(r.code, 0);
  assert.match(r.out, /^old id not in registry; new id exists; nothing to do/);
  assert.doesNotMatch(r.out, /already retiered/);
  assert.deepEqual(s.vault.log, []);
});

test("G3a: a MISTYPED old id is never reported as a finished retier: exit 1 E_USAGE saying the old id is unknown; so is a finished-looking registry whose new credential is gone", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  assert.equal(s.run("b.multi.paid", "free").code, 0);                                   // a real, finished retier: b.multi.free exists with its credential
  s.vault.log.length = 0;
  for (const typo of ["b.multi.paidd", "b.multi.pay", "b.multi.freee", "b.multi.free"]) {   // each derives new id b.multi.free (or already is it)
    const r = s.run(typo, "free");
    assert.equal(r.code, 1, typo); assert.match(r.err, /^E_USAGE: /, typo); assert.doesNotMatch(r.out + r.err, /already retiered|nothing to do/, typo);
  }
  assert.match(s.run("b.multi.paidd", "free").err, /old id 'b\.multi\.paidd' is unknown/);
  s.vault.creds.delete("b.multi.free");                                                    // the new credential is gone: not evidence of anything finished
  const gone = s.run("b.multi.paid", "free");
  assert.equal(gone.code, 1); assert.match(gone.err, /^E_USAGE: .*unknown/);
  assert.deepEqual(s.vault.log, [], "no vault call for any of them");
});

test("G3b: a resume that would delete an old credential with no registry row needs --force yes (a bare run changes nothing); --force alone does not turn a plain move into anything else", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  s.vault.failAt = "afterCopy";
  assert.equal(s.run("b.multi.paid", "free").code, 5);
  s.vault.failAt = null; s.vault.log.length = 0;
  const reg = fs.readFileSync(s.registryFile, "utf8"), ch = fs.readFileSync(s.choicesFile, "utf8");
  const bare = s.run("b.multi.paid", "free");
  assert.equal(bare.code, 1); assert.match(bare.err, /^E_USAGE: .*no registry row.*--force yes/);
  assert.match(bare.out, /needs --force yes/, "the plan says so");
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), reg); assert.equal(fs.readFileSync(s.choicesFile, "utf8"), ch);
  assert.equal(s.vault.creds.get("b.multi.paid"), SECRET); assert.deepEqual(s.vault.log, []);
  assert.equal(s.run("b.multi.paid", "free", "--force", "maybe").code, 1, "--force takes exactly yes or no");
  assert.equal(s.run("b.multi.paid", "free", "--force", "no").code, 1, "--force no is the same as absent");
  // the case it must not break: a plain MOVE (the old id still has its registry row) needs no --force, and --force yes on it is harmless
  const m = setup(); assert.equal(m.run("b.alpha.paid", "free").code, 0, m.err);
  const m2 = setup(); assert.equal(m2.run("b.alpha.paid", "free", "--force", "yes").code, 0);
  // a choice-only resume (old credential already gone) deletes nothing, so it needs no --force either
  const c = setup({ choices: { alpha: "b.alpha.paid" }, secretFor: ["b.alpha.paid"] });
  c.vault.failAt = "afterCopy"; assert.equal(c.run("b.alpha.paid", "free").code, 5);
  c.vault.creds.delete("b.alpha.paid"); c.vault.failAt = null;                              // the old credential is gone, the choice still names the old id
  const done = c.run("b.alpha.paid", "free");
  assert.equal(done.code, 0, done.err); assert.deepEqual(c.choices(), { alpha: "b.alpha.free" });
});

test("G3c: a resume compares old and new in the vault process before deleting: a differing pair exits 5 and the old credential survives; an equal pair completes", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  s.vault.failAt = "afterCopy";
  assert.equal(s.run("b.multi.paid", "free").code, 5);
  s.vault.failAt = null;
  s.vault.creds.set("b.multi.free", SECRET + "_different");                               // the new credential is not what the old one was
  s.vault.log.length = 0;
  const bad = s.run("b.multi.paid", "free", "--force", "yes");
  assert.equal(bad.code, 5, bad.out + bad.err); assert.match(bad.err, /^E_WRITE: .*differ.*NOT deleted/);
  assert.equal(s.vault.creds.get("b.multi.paid"), SECRET, "the old credential survives");
  assert.deepEqual(s.vault.log.map((l) => l[0]), ["verify"], "the compare ran, no delete followed");
  assert.deepEqual(s.choices(), { multi: "b.multi.paid" }, "key-choices.json was not repointed either: nothing changed");
  s.vault.creds.set("b.multi.free", SECRET);                                              // the case it must not break: an equal pair
  assert.equal(s.run("b.multi.paid", "free", "--force", "yes").code, 0);
  assert.ok(!s.vault.creds.has("b.multi.paid"));
});

test("G3d: a move onto a new id that already holds a DIFFERENT credential is refused (exit 5, nothing overwritten, old kept); the same value (a resumed copy) completes", () => {
  const s = setup();
  s.vault.creds.set("b.alpha.free", "someone-elses-credential");
  const before = fs.readFileSync(s.registryFile, "utf8");
  const r = s.run("b.alpha.paid", "free");
  assert.equal(r.code, 5, r.out + r.err); assert.match(r.err, /different value/);
  assert.equal(s.vault.creds.get("b.alpha.free"), "someone-elses-credential", "never overwritten");
  assert.equal(s.vault.creds.get("b.alpha.paid"), SECRET);
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), before);
  s.vault.creds.set("b.alpha.free", SECRET);
  assert.equal(s.run("b.alpha.paid", "free").code, 0, "the same value is fine");
});

test("G4: a credential-store failure while planning, and a key-choices file that is valid JSON but not an object, exit 4 E_TIER_UNREADABLE with no stack trace", () => {
  const resumeRows = [...ROWS().filter((r) => r.id !== "b.alpha.paid"), row("b", "alpha", "free")];   // the old id has no row: planning must ask the credential store
  const s = setup({ rows: resumeRows, secretFor: [] });
  const broken = { ...s.vault.seam, exists() { throw new Error("the PowerShell existence check failed"); } };
  const out = [], err = [];
  const code = runRetier(["b.alpha.paid", "free"], { out: (x) => out.push(x), err: (x) => err.push(x) }, { seam: broken, registryFile: s.registryFile, choicesFile: s.choicesFile });
  assert.equal(code, 4, out.join("\n") + err.join("\n")); assert.match(err.join("\n"), /^E_TIER_UNREADABLE: .*existence check failed/);
  assert.doesNotMatch(err.join("\n"), /\n\s+at /, "no stack trace");
  for (const body of ["null", "[]", "5", "\"text\"", "true"]) {
    const t = setup(); fs.writeFileSync(t.choicesFile, body);
    const r = t.run("b.alpha.paid", "free");
    assert.equal(r.code, 4, `${body}: ${r.out}${r.err}`); assert.match(r.err, /^E_TIER_UNREADABLE: .*not a provider-to-id map/, body);
    assert.deepEqual(t.vault.log, [], body);
  }
  const bad = setup(); fs.writeFileSync(bad.registryFile, JSON.stringify([null, 5]));
  assert.equal(bad.run("b.alpha.paid", "free").code, 4, "a registry with a non-object row is unreadable, not a TypeError");
  // the case it must not break: a valid object map, the empty one included, and a working store plan normally
  const ok = setup({ choices: {} }); assert.equal(ok.run("b.alpha.paid", "free").code, 0);
});

test("G5: a fixture pair under --dry yes never reaches the real credential store: planning a move works, a resume state is refused with E_USAGE, and a marker-writing vault script in the temp HOME is never run", () => {
  const home = tmp(); dirs.push(home);
  const marker = path.join(home, "reached.txt"), vaultDir = path.join(home, ".llmkeys"); fs.mkdirSync(vaultDir);
  fs.writeFileSync(path.join(vaultDir, "ApiKeyVault.ps1"), `Set-Content -Path '${marker}' -Value reached\n`);   // dot-sourced by every production seam call
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const run = (reg, ...a) => spawnSync(process.execPath, [KEY, "retier", ...a, "--dry", "yes", "--registry-file", reg.registryFile, "--choices-file", reg.choicesFile], { encoding: "utf8", env });
  const move = setup({ choices: { multi: "b.multi.paid" } });
  const m = run(move, "b.multi.paid", "free");
  assert.equal(m.status, 0, m.stderr); assert.match(m.stdout, /retier plan \(move\)/);
  const resume = setup({ rows: [...ROWS().filter((r) => r.id !== "b.alpha.paid"), row("b", "alpha", "free")], secretFor: [] });
  const r = run(resume, "b.alpha.paid", "free");
  assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, /^E_USAGE: .*never consults the real credential store/);
  assert.equal(fs.existsSync(marker), false, "PowerShell never dot-sourced the vault script: the real store was not asked");
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
});

test("resume refuses to delete the old credential when the new one is missing", () => {
  const s = setup({ rows: [...ROWS().filter((r) => r.id !== "b.alpha.paid"), row("b", "alpha", "free")], secretFor: ["b.alpha.paid"] });
  const r = s.run("b.alpha.paid", "free");
  assert.equal(r.code, 5);
  assert.ok(r.err.startsWith("E_WRITE"));
  assert.ok(s.vault.creds.has("b.alpha.paid"), "old credential kept");
  assert.deepEqual(s.vault.log, []);
});

// ------------------------------------------------------------------ 6 refusals and --dry
test("refusals: unknown id, tier outside the vocabulary, same tier, new id already present", () => {
  const s = setup();
  const reg = fs.readFileSync(s.registryFile, "utf8");
  const cases = [["b.nope.paid", "free", "E_USAGE"], ["b.alpha.paid", "Free", "E_TIER_INVALID"], ["b.alpha.paid", "deposit", "E_TIER_INVALID"],
    ["b.alpha.paid", "paid", "E_USAGE"], ["b.alpha.paid", "", "E_TIER_INVALID"]];
  const s2 = setup({ rows: [...ROWS(), row("b", "alpha", "free")] });          // b.alpha.free already exists
  for (const [id, tier, code] of cases) {
    const r = s.run(id, tier);
    assert.equal(r.code, 1, `${id} ${tier}`);
    assert.ok(r.err.split("\n")[0].startsWith(code), r.err);
  }
  assert.equal(s2.run("b.alpha.paid", "free").code, 1, "new id already present");
  assert.match(s2.run("b.alpha.paid", "free").err, /already exists/);
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), reg);
  assert.deepEqual(s.vault.log, []);
  assert.deepEqual(s2.vault.log, []);
  assert.equal(s.run("b.alpha.paid", "Free").err.includes("free-deposit"), true, "an invalid tier lists the valid ones");
});

test("usage errors: missing arguments, bare --dry, --dry with a non-boolean, unknown flag", () => {
  const s = setup();
  for (const argv of [[], ["b.alpha.paid"], ["b.alpha.paid", "free", "--dry"], ["b.alpha.paid", "free", "--dry", "maybe"], ["b.alpha.paid", "free", "--frobnicate", "yes"], ["a b", "free"]]) {
    const r = s.run(...argv);
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.ok(r.err.startsWith("E_USAGE"), r.err);
  }
  assert.deepEqual(s.vault.log, []);
});

test("--dry yes prints the plan and touches nothing: registry, choices and credentials identical, no vault call", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  const reg = fs.readFileSync(s.registryFile, "utf8"), ch = fs.readFileSync(s.choicesFile, "utf8"), creds = new Map(s.vault.creds);
  const r = s.run("b.multi.paid", "free", "--dry", "yes");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /retier plan \(move\): 'b\.multi\.paid' -> 'b\.multi\.free'/);
  assert.match(r.out, /LLM_B_MULTI_PAID -> LLM_B_MULTI_FREE/);
  assert.match(r.out, /repoint multi/);
  assert.match(r.out, /plan only, nothing was changed/);
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), reg);
  assert.equal(fs.readFileSync(s.choicesFile, "utf8"), ch);
  assert.deepEqual(s.vault.creds, creds);
  assert.deepEqual(s.vault.log, []);
});

test("unreadable inputs: a missing registry, a corrupt registry and a corrupt choices file exit 4 with E_TIER_UNREADABLE", () => {
  const s = setup();
  const reg = s.registryFile;
  const gone = runRetier(["b.alpha.paid", "free", "--registry-file", path.join(s.dir, "nope.json"), "--choices-file", s.choicesFile], { out() {}, err() {} }, { seam: s.vault.seam });
  assert.equal(gone, 4);
  fs.writeFileSync(s.choicesFile, "{not json");
  assert.equal(s.run("b.alpha.paid", "free").code, 4);
  fs.rmSync(s.choicesFile);
  fs.writeFileSync(reg, "not json");
  assert.equal(s.run("b.alpha.paid", "free").err.split("\n")[0].startsWith("E_TIER_UNREADABLE"), true);
  assert.deepEqual(s.vault.log, []);
});

// F6e: the same all-or-nothing discipline as subagent-policy: one fixture file alone would be paired with the REAL vault file for the other
test("retier test flags are all-or-nothing: --registry-file alone or --choices-file alone is refused; a fixture pair without --dry never reaches the real vault", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  const home = tmp(); dirs.push(home);
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const run = (...a) => spawnSync(process.execPath, [KEY, "retier", ...a], { encoding: "utf8", env });
  for (const alone of [["--registry-file", s.registryFile], ["--choices-file", s.choicesFile]]) {
    const r = run("b.multi.paid", "free-deposit", "--dry", "yes", ...alone);
    assert.equal(r.status, 1, alone[0]); assert.match(r.stderr, /^E_USAGE: incomplete test-flag set/);
    assert.equal(r.stdout, "", "nothing was planned or read");
  }
  const reg = fs.readFileSync(s.registryFile, "utf8");
  const wet = run("b.multi.paid", "free-deposit", "--registry-file", s.registryFile, "--choices-file", s.choicesFile);
  assert.equal(wet.status, 1); assert.match(wet.stderr, /^E_USAGE: .*fixtures.*REAL credential/);
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), reg);
  const dry = run("b.multi.paid", "free-deposit", "--dry", "yes", "--registry-file", s.registryFile, "--choices-file", s.choicesFile);
  assert.equal(dry.status, 0, "a dry plan over a fixture pair is the supported use");
  // the in-process seam (a test's fake vault) is still allowed to run a pair without --dry: that is how every other test here works
  const ok = runRetier(["b.alpha.paid", "free", "--registry-file", s.registryFile, "--choices-file", s.choicesFile], { out() {}, err() {} }, { seam: s.vault.seam });
  assert.equal(ok, 0);
});

// ------------------------------------------------------------------ the CLI itself, dry, against fixture files in a temp HOME
test("key.mjs retier --dry yes end to end on fixture files: exit 0, plan printed, fixture files and real ~/.llmkeys untouched", () => {
  const s = setup({ choices: { multi: "b.multi.paid" } });
  const home = tmp(); dirs.push(home);
  const reg = fs.readFileSync(s.registryFile, "utf8"), ch = fs.readFileSync(s.choicesFile, "utf8");
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  const r = spawnSync(process.execPath, [KEY, "retier", "b.multi.paid", "free-deposit", "--dry", "yes", "--registry-file", s.registryFile, "--choices-file", s.choicesFile], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /retier plan \(move\)/);
  assert.equal(fs.readFileSync(s.registryFile, "utf8"), reg);
  assert.equal(fs.readFileSync(s.choicesFile, "utf8"), ch);
  const bad = spawnSync(process.execPath, [KEY, "retier", "b.multi.paid", "freee", "--registry-file", s.registryFile, "--choices-file", s.choicesFile], { encoding: "utf8", env });
  assert.equal(bad.status, 1);
  assert.ok(bad.stderr.startsWith("E_TIER_INVALID"));
});

// ------------------------------------------------------------------ 7 the production seam passes ids only
// G6: an ALLOW-LIST, not a deny-list. Every script line that mentions a secret-holding variable ($v, $chk) must be one of these exact
// lines (assign from the vault, the compare, the write call, Remove-Variable); any other line that mentions one fails, whatever it
// does with it (`throw "bad $v"`, `"$v" | Out-File`, `${v}`, `$($chk)` all fail because the line is not on the list). Every vault
// read must be an assignment to one of them, and the only line that may print anything is the fixed success line with ids.
const SECRET_VARS = /\$[({]*(v|chk)\b/;
const ALLOWED_SECRET_LINES = {
  copy: [
    '$v = [Win32CredManager]::Read("LLMKEY:$old")',
    'if (-not $v) { throw "no credential under LLMKEY:$old" }',
    '$chk = [Win32CredManager]::Read("LLMKEY:$new")',
    'if ($chk -and -not ($chk -ceq $v)) { throw "LLMKEY:$new already exists with a different value; refusing to overwrite it" }',
    '[Win32CredManager]::Write("LLMKEY:$new", $v)',
    'if (-not ($chk -ceq $v)) { throw "the copy under LLMKEY:$new does not match; registry unchanged" }',
    "Remove-Variable v, chk",
  ],
  verify: [
    '$v = [Win32CredManager]::Read("LLMKEY:$old")',
    '$chk = [Win32CredManager]::Read("LLMKEY:$new")',
    "$same = [bool]$v -and [bool]$chk -and ($chk -ceq $v)",
    "Remove-Variable v, chk",
  ],
  del: [],
  exists: [],
};
function secretLineProblems(kind, text) {
  const allowed = new Set(ALLOWED_SECRET_LINES[kind]), bad = [];
  for (const line of text.split("\n")) {
    if (SECRET_VARS.test(line) && !allowed.has(line)) bad.push(`not an allowed secret line: ${line}`);
    if (/::Read\(/.test(line) && !/^\$(v|chk) = \[Win32CredManager\]::Read\(/.test(line) && !/^if \(\[Win32CredManager\]::Read\("LLMKEY:" \+ '[^']*'\)\) \{ 'yes' \} else \{ 'no' \}$/.test(line)) bad.push(`a vault read that is not assigned to a secret variable: ${line}`);
    if (/Write-Host|Write-Output|Write-Error|Write-Warning|Write-Verbose|Write-Debug|Out-(?!Null)|Tee-/i.test(line) && !/^Write-Host "Retiered '\$old' -> '\$new'"$/.test(line)) bad.push(`an output or pipe line that is not the fixed success line: ${line}`);
  }
  // every allowed line is actually present: the allow-list cannot rot into a list of lines the scripts no longer have
  for (const l of allowed) if (!text.split("\n").includes(l)) bad.push(`allow-list line missing from the script: ${l}`);
  return bad;
}

test("static: the production scripts carry ids only and never print, store or pass the secret (an allow-list of the lines that may touch it)", () => {
  const scripts = { copy: copyScript("b.alpha.paid", "b.alpha.free", "free"), verify: verifyScript("b.alpha.paid", "b.alpha.free"), del: deleteScript("b.alpha.paid"), exists: existsScript("b.alpha.paid") };
  assert.ok(scripts.copy.includes("'b.alpha.paid'") && scripts.copy.includes("'b.alpha.free'") && scripts.copy.includes("'free'"));
  assert.ok(scripts.verify.includes("'b.alpha.paid'") && scripts.verify.includes("'b.alpha.free'"));
  assert.ok(scripts.del.includes("'b.alpha.paid'") && scripts.exists.includes("'b.alpha.paid'"));
  for (const [k, text] of Object.entries(scripts)) {
    assert.doesNotMatch(text, /Read-Host|ConvertTo-SecureString|\$env:|Out-File|Set-Content|Add-Content|Start-Transcript/i, k);
    assert.deepEqual(secretLineProblems(k, text), [], k);
  }
  // the copy happens once, in one script, compared case-sensitively inside the process, and the variables are removed before the registry step
  assert.match(scripts.copy, /-ceq \$v/);
  assert.ok(scripts.copy.indexOf("Remove-Variable v, chk") < scripts.copy.indexOf("Save-KeyRegistry"));
  assert.ok(scripts.copy.indexOf("Read(") < scripts.copy.indexOf("Write(") && scripts.copy.indexOf("Write(") < scripts.copy.indexOf("Save-KeyRegistry"));
  // G3d: the pre-existing-new-value refusal sits BEFORE the write, so an unlike value is never overwritten
  assert.ok(scripts.copy.indexOf("already exists with a different value") < scripts.copy.indexOf("Write("), "the refusal precedes the write");
  assert.ok(scripts.copy.indexOf("Read(\"LLMKEY:$new\")") < scripts.copy.indexOf("Write("), "the new id is read before it is written");
  // G3c: the verify script removes the variables BEFORE it can throw, and compares with -ceq
  assert.ok(scripts.verify.indexOf("Remove-Variable v, chk") < scripts.verify.indexOf("throw"), "no secret variable survives into the throw");
  assert.match(scripts.verify, /-ceq \$v/);
  assert.doesNotMatch(scripts.del, /Remove-ApiKey/, "the old credential is deleted directly so the registry is not re-saved");
  assert.ok(!scripts.del.includes("Save-KeyRegistry") && !scripts.exists.includes("Save-KeyRegistry") && !scripts.verify.includes("Save-KeyRegistry"));
});

test("G6: the allow-list check itself catches the leaks a line-based scan would miss (it is not vacuous)", () => {
  const good = copyScript("b.a.paid", "b.a.free", "free");
  assert.deepEqual(secretLineProblems("copy", good), []);
  const leaks = [
    'throw "bad $v"',                                   // the case the old line-based scan missed
    'throw "bad ${v}"', 'throw "bad $($chk)"', '"$v" | Out-File x', 'Write-Host $chk', '$v | Set-Clipboard', 'Write-Output ($chk -ceq $v)',
    '[Win32CredManager]::Read("LLMKEY:$old")',          // a read that is printed by the host
    '[Win32CredManager]::Read("LLMKEY:$old") | Out-Host',
  ];
  for (const leak of leaks) {
    const bad = secretLineProblems("copy", good.replace("Remove-Variable v, chk", `${leak}\nRemove-Variable v, chk`));
    assert.ok(bad.length >= 1, `the allow-list rejects: ${leak}`);
  }
  // a rewritten allowed line is also rejected (and the missing original is reported)
  assert.ok(secretLineProblems("copy", good.replace('[Win32CredManager]::Write("LLMKEY:$new", $v)', '[Win32CredManager]::Write("LLMKEY:$new", $v); Write-Host $v')).length >= 1);
  assert.ok(secretLineProblems("verify", verifyScript("a.b.paid", "a.b.free").replace("Remove-Variable v, chk", "Remove-Variable v")).length >= 1, "a changed Remove-Variable line is not on the list");
});

test("G6: a seam that COULD leak does not: PowerShell output carrying the secret never reaches an io line, and only `exists` captures any output at all", () => {
  // Every spawned process answers with the secret on stdout AND stderr, as a script that printed it would. The tool reads captured
  // output in exactly one place (`exists`, compared with "yes" and discarded); everything else is stdio: inherit (never read by node).
  const calls = [];
  const spawn = (cmd, argv, opts) => { calls.push({ cmd, opts }); return { status: 0, stdout: `${SECRET}\n`, stderr: SECRET }; };
  const say = [];
  const io = { out: (x) => say.push(x), err: (x) => say.push(x) };
  const rows = [...ROWS().filter((r) => r.id !== "b.alpha.paid"), row("b", "alpha", "free")];
  const s = setup({ rows, secretFor: [] });
  const seam = productionSeam(spawn);
  // a MOVE (copy and delete) and a RESUME (exists, exists, verify, delete) through the production seam, with the leaking spawn
  const mv = setup();
  assert.equal(runRetier(["b.alpha.paid", "free"], io, { seam, registryFile: mv.registryFile, choicesFile: mv.choicesFile }), 0);
  const leakySeam = { ...seam, exists: () => true };                                  // a resume state: old and new both present
  const code = runRetier(["b.alpha.paid", "free", "--force", "yes"], io, { seam: leakySeam, registryFile: s.registryFile, choicesFile: s.choicesFile });
  assert.equal(code, 0, say.join("\n"));
  assert.equal(calls.length >= 3, true, "copy, verify and delete all went through the spy");
  assert.ok(!say.join("\n").includes(SECRET), "the secret the processes printed never reached the tool's own output");
  for (const c of calls) assert.deepEqual(c.opts, { stdio: "inherit" }, "copy, verify and delete never pipe the child's output into node");
  // `exists` is the only call that captures stdout, and what it returns is a boolean, never the text
  const probe = productionSeam((cmd, argv, opts) => { calls.push({ cmd, opts }); return { status: 0, stdout: `${SECRET}\n`, stderr: "" }; });
  assert.equal(probe.exists("b.alpha.paid"), false);
  assert.deepEqual(calls.at(-1).opts.stdio, ["ignore", "pipe", "inherit"]);
});

test("static: productionSeam runs powershell with an encoded command whose only data is ids, and parses the existence answer", () => {
  const calls = [];
  const spawn = (cmd, argv, opts) => { calls.push({ cmd, argv, opts }); return { status: 0, stdout: "yes\r\n" }; };
  const seam = productionSeam(spawn);
  seam.retierCopy("b.alpha.paid", "b.alpha.free", "free");
  seam.deleteCredential("b.alpha.paid");
  assert.equal(seam.exists("b.alpha.free"), true);
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.cmd, "powershell");
    assert.deepEqual(c.argv.slice(0, 2), ["-NoProfile", "-EncodedCommand"]);
    assert.equal(c.argv.length, 3, "nothing but the encoded command on the command line");
    const decoded = Buffer.from(c.argv[2], "base64").toString("utf16le");
    assert.match(decoded, /^\. '.*ApiKeyVault\.ps1'/);
    assert.ok(decoded.includes("b.alpha."));
  }
  assert.equal(productionSeam(() => ({ status: 0, stdout: "no\n" })).exists("x"), false);
  assert.throws(() => productionSeam(() => ({ status: 1, stdout: "" })).retierCopy("a.b.paid", "a.b.free", "free"), /PowerShell copy failed/);
});

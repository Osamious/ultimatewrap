import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  retainOnSuccess, restoreSettings, listSettingsBackups, parseBackupStamp, capFailedSnapshots,
  assertSettingsInvariants, SECURITY_CRITICAL_KEYS
} from "../keysync/safety.mjs";

// NEVER the live ~/.claude directory. Every test builds its own scratch tree and
// its own filenames: the one real settings backup on this machine is the user's
// only rollback point, and a test that read the live directory into something
// that then prunes would destroy exactly what this file exists to protect.
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-safety-"));
  const settings = path.join(d, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ modelPicker: { options: [{ model: "a/b" }] } }));
  return { dir: d, settings };
};

const writeBackup = (settings, stamp, body = "{}") => {
  const p = `${settings}.uw-backup-${stamp}`;
  fs.writeFileSync(p, body);
  return p;
};

// The two stamp formats that actually coexist on disk. `run.mjs:1269` writes the
// hyphenated one; the compact one is the format of the only settings backup this
// machine has (`settings.json.uw-backup-20260905T090726`, Sep 5).
const COMPACT_OLD = "20260905T090726";              // Sep 5 09:07:26
const HYPHEN_NEW = "2026-09-07T13-47-22-491Z";      // Sep 7 13:47:22.491 — NEWER

test("retention keeps the newest backup when two stamp formats coexist", () => {
  const { settings } = scratch();
  const older = writeBackup(settings, COMPACT_OLD);
  const newer = writeBackup(settings, HYPHEN_NEW);

  retainOnSuccess({ snapshot: null, settingsFile: settings, keepSettings: 1 });

  // A lexical sort compares "-" (0x2D) against "0" (0x30) at offset 4, putting
  // EVERY hyphenated stamp below EVERY compact one regardless of date — so
  // `.sort().reverse()` kept the Sep 5 file and deleted the run's own backup.
  assert.equal(fs.existsSync(newer), true, "the newest backup must survive retention");
  assert.equal(fs.existsSync(older), false, "the older backup should have been pruned");
});

test("restoreSettings reports 'no-backup' and leaves settings.json untouched", () => {
  const { settings } = scratch();
  const before = fs.readFileSync(settings, "utf8");
  const missing = `${settings}.uw-backup-does-not-exist`;

  const res = restoreSettings(missing, settings);

  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-backup");
  // The caller must not be sent to a rollback point that was never written.
  assert.equal(res.path, undefined, "a failure result must never name a written path");
  assert.equal(fs.readFileSync(settings, "utf8"), before, "nothing was attempted, so nothing changed");
});

test("restoreSettings reports 'restore-failed' when a real backup cannot be copied back", () => {
  const { dir } = scratch();
  // A regular file where a directory belongs: both the temp+rename path and the
  // direct-copy fallback fail with ENOTDIR, deterministically and on every OS.
  const blocker = path.join(dir, "blocked");
  fs.writeFileSync(blocker, "not a directory");
  const settings = path.join(blocker, "settings.json");
  const backup = writeBackup(path.join(dir, "settings.json"), HYPHEN_NEW, '{"real":"backup"}');

  const res = restoreSettings(backup, settings);

  assert.equal(res.ok, false);
  assert.equal(res.reason, "restore-failed");
  assert.equal(res.path, undefined);
  // This mode is the one where the backup DOES exist — the operator needs it.
  assert.equal(fs.existsSync(backup), true);
  assert.notEqual(res.reason, "no-backup", "the two failure modes must be distinguishable");
});

test("restoreSettings reports success with the path it actually wrote", () => {
  const { settings } = scratch();
  const backup = writeBackup(settings, HYPHEN_NEW, '{"restored":true}');

  const res = restoreSettings(backup, settings);

  assert.equal(res.ok, true);
  assert.equal(res.path, settings);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), { restored: true });
});

// ---- stamp ordering ---------------------------------------------------------

test("both stamp formats parse, and the newer one sorts first", () => {
  const older = parseBackupStamp(COMPACT_OLD);
  const newer = parseBackupStamp(HYPHEN_NEW);
  assert.equal(typeof older, "number", "the legacy compact stamp must stay parseable");
  assert.equal(typeof newer, "number");
  assert.ok(newer > older, "Sep 7 must order after Sep 5 across formats");
});

test("an unparseable stamp is neither pruned nor offered as the newest restore point", () => {
  const { settings } = scratch();
  const junk = writeBackup(settings, "handmade-copy");
  const real = writeBackup(settings, HYPHEN_NEW);
  assert.equal(parseBackupStamp("handmade-copy"), null);

  const listed = listSettingsBackups(settings);
  assert.deepEqual(listed.dated.map((b) => b.name), [path.basename(real)]);
  assert.deepEqual(listed.undatable.map((b) => b.name), [path.basename(junk)]);

  // Deleting a file we cannot date is the destructive direction of the error.
  retainOnSuccess({ snapshot: null, settingsFile: settings, keepSettings: 1 });
  assert.equal(fs.existsSync(junk), true, "an undatable backup must never be pruned");
  assert.equal(fs.existsSync(real), true);
});

test("a garbage stamp that Date.UTC would roll over is rejected, not silently misdated", () => {
  // Month 13 rolls into the next January rather than failing, which would date a
  // junk stamp into the future and make it look like the newest restore point.
  assert.equal(parseBackupStamp("20261301T000000"), null);
  assert.equal(parseBackupStamp("20260932T000000"), null);
  assert.equal(parseBackupStamp("2026-09-07T25-00-00-000Z"), null);
});

// ---- the phase5 health check and retention must agree ----------------------

test("the usability check selects the same backup retention keeps", () => {
  const { settings } = scratch();
  writeBackup(settings, COMPACT_OLD);
  const newer = writeBackup(settings, HYPHEN_NEW);

  // What phase5-statics T1.4 reads as "the newest restore point".
  const selected = listSettingsBackups(settings).dated[0].path;
  // What retention leaves behind.
  retainOnSuccess({ snapshot: null, settingsFile: settings, keepSettings: 1 });
  const survivors = fs.readdirSync(path.dirname(settings))
    .filter((f) => f.startsWith(`${path.basename(settings)}.uw-backup-`));

  assert.equal(selected, newer);
  assert.deepEqual(survivors, [path.basename(newer)],
    "a checker that confirms a restore point retention just deleted is worse than none");
});

test("phase5-statics reads backups through the shared helper, not its own sort", () => {
  // Binds the second call site to the one ordering helper. The defect was a
  // verbatim copy of retention's `.sort().reverse()`, and a second copy is how
  // the two would diverge again after this fix.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "keysync", "phase5-statics.mjs"), "utf8");
  assert.match(src, /listSettingsBackups/);
  assert.doesNotMatch(src, /readdirSync\([^)]*\)[\s\S]{0,80}?\.sort\(\)/);
});

// ---- settings.json integrity across the rewrite (#7 / report 08 F4) --------

const fixture = () => ({
  permissions: { defaultMode: "auto" },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.mjs" }] }] },
  autoMode: { environment: { trustedRepo: true, sensitiveDataLocations: ["~/.ssh"] } },
  enabledPlugins: { "oh-my-claudecode": true },
  extraKnownMarketplaces: {},
  statusLine: { type: "command", command: "node omc-hud.mjs" },
  apiKeyHelper: "C:\keyhelper.cmd",
  skillOverrides: {},
  skipDangerousModePermissionPrompt: true,
  skipAutoPermissionPrompt: true,
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456" },
  modelPicker: { options: [{ model: "a/b" }] }
});

test("a rewrite that drops autoMode is REJECTED", () => {
  const before = fixture();
  const after = fixture();
  delete after.autoMode;
  assert.throws(() => assertSettingsInvariants(before, after), /autoMode.*LOST/);
});

test("every security-critical key is rejected when silently dropped", () => {
  for (const key of SECURITY_CRITICAL_KEYS) {
    const before = fixture();
    const after = fixture();
    assert.ok(key in before, `fixture must exercise ${key}`);
    delete after[key];
    assert.throws(() => assertSettingsInvariants(before, after),
      new RegExp(`${key}.*LOST`), `dropping ${key} must be rejected`);
  }
});

test("a MODIFIED security-critical key is rejected even when the key survives", () => {
  const before = fixture();
  const after = fixture();
  // The exact silent-degradation case: defaultMode stays "auto" while the policy
  // governing auto-approval is emptied out.
  after.autoMode.environment.sensitiveDataLocations = [];
  assert.throws(() => assertSettingsInvariants(before, after), /autoMode.*MODIFIED/);
});

test("an unexpected new top-level key is rejected", () => {
  const before = fixture();
  const after = { ...fixture(), telemetryEndpoint: "https://evil.example" };
  assert.throws(() => assertSettingsInvariants(before, after), /telemetryEndpoint/);
});

test("the keys keysync owns may be added, changed and removed", () => {
  const before = fixture();
  delete before.modelPicker;
  before.model = "old/pin";
  const after = fixture();               // modelPicker added back, `model` removed
  assert.doesNotThrow(() => assertSettingsInvariants(before, after));
});

test("reordering keys is not a modification", () => {
  const before = fixture();
  const after = fixture();
  after.autoMode = { environment: { sensitiveDataLocations: ["~/.ssh"], trustedRepo: true } };
  assert.doesNotThrow(() => assertSettingsInvariants(before, after));
});

test("an unchanged rewrite passes", () => {
  assert.doesNotThrow(() => assertSettingsInvariants(fixture(), fixture()));
});

// ---- retention depth (report 08 F4) ----------------------------------------

test("keepSettings defaults to 5, so two bad runs cannot destroy the last good copy", () => {
  const { settings } = scratch();
  // Seven dated backups, oldest to newest.
  const made = ["01", "02", "03", "04", "05", "06", "07"]
    .map((d) => writeBackup(settings, `202609${d}T090000`));

  retainOnSuccess({ snapshot: null, settingsFile: settings }); // NO keepSettings

  const survivors = fs.readdirSync(path.dirname(settings))
    .filter((f) => f.startsWith(`${path.basename(settings)}.uw-backup-`)).sort();
  assert.deepEqual(survivors, made.slice(2).map((p) => path.basename(p)).sort(),
    "the newest five survive; only the two oldest are pruned");
});

// ---- capFailedSnapshots: same parser, INVERTED undatable policy ------------

const snapDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "uw-snaps-"));
const writeSnap = (dir, stamp, ext = ".sqlite.dpapi") => {
  const p = path.join(dir, `config-${stamp}${ext}`);
  fs.writeFileSync(p, "x");
  return path.basename(p);
};

test("capFailedSnapshots keeps the newest snapshot across mixed stamp formats", () => {
  const dir = snapDir();
  const older = writeSnap(dir, COMPACT_OLD);
  const newer = writeSnap(dir, HYPHEN_NEW);

  capFailedSnapshots(1, dir);

  assert.deepEqual(fs.readdirSync(dir), [newer],
    "the newest snapshot must survive; the lexical sort kept the wrong one");
  assert.equal(fs.existsSync(path.join(dir, older)), false);
});

test("an undatable config snapshot is PRUNED FIRST — the opposite of a settings backup", () => {
  const dir = snapDir();
  const junk = writeSnap(dir, "handmade");
  const newer = writeSnap(dir, HYPHEN_NEW);
  const older = writeSnap(dir, COMPACT_OLD);

  const removed = capFailedSnapshots(2, dir);

  // A snapshot holds every provider API key, so a file whose age cannot be
  // established is the one you least want left on disk.
  assert.deepEqual(removed, [junk], "the undatable snapshot is the first pruned");
  assert.deepEqual(fs.readdirSync(dir).sort(), [newer, older].sort());
});

test("capFailedSnapshots never keeps more files than max, even when all are undatable", () => {
  const dir = snapDir();
  for (const s of ["aa", "bb", "cc", "dd"]) writeSnap(dir, s);
  capFailedSnapshots(2, dir);
  assert.equal(fs.readdirSync(dir).length, 2, "the cap still binds when nothing parses");
});

test("the two policies are inverted: undatable kept as a settings backup, pruned as a snapshot", () => {
  const { settings } = scratch();
  const keptBackup = writeBackup(settings, "handmade-copy");
  writeBackup(settings, HYPHEN_NEW);
  retainOnSuccess({ snapshot: null, settingsFile: settings, keepSettings: 1 });

  const dir = snapDir();
  const prunedSnap = writeSnap(dir, "handmade-copy");
  writeSnap(dir, HYPHEN_NEW);
  capFailedSnapshots(1, dir);

  assert.equal(fs.existsSync(keptBackup), true, "a rollback point is never deleted on a guess");
  assert.equal(fs.existsSync(path.join(dir, prunedSnap)), false, "key material is not kept on a guess");
});

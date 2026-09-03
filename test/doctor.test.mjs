import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEnv, checkHandoff, checkFingerprint, checkContracts, checkHud,
         checkBundled, checkCcrPatch, checkRpcSurface, diagnose,
         MAX_HANDOFF_AGE_MS } from "../menu/doctor.mjs";

const CMD = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";

test("checkEnv passes when EDITOR points at the dispatcher", () => {
  const c = checkEnv({ EDITOR: CMD, UW_REAL_EDITOR: "C:\\Windows\\notepad.exe" });
  assert.equal(c.ok, true);
});

test("checkEnv fails and says so when EDITOR points elsewhere", () => {
  const c = checkEnv({ EDITOR: "C:\\Program Files\\vim\\vim.exe", UW_REAL_EDITOR: "x" });
  assert.equal(c.ok, false);
  assert.match(c.evidence, /vim\.exe/);
  assert.match(c.evidence, /uwpick\.cmd/);
});

test("checkEnv fails when UW_REAL_EDITOR is unset, because passthrough would open notepad", () => {
  const c = checkEnv({ EDITOR: CMD });
  assert.equal(c.ok, false);
  assert.match(c.evidence, /UW_REAL_EDITOR/);
});

test("checkHandoff passes on a recorded invocation that wrote a selection", () => {
  const c = checkHandoff([
    JSON.stringify({ at: "2026-09-02T10:00:00Z", argv2: "C:\\Temp\\x.md", existed: true, wrote: true }),
  ]);
  assert.equal(c.ok, true);
});

test("checkHandoff fails when argv[2] did not exist — the contract moved", () => {
  const c = checkHandoff([
    JSON.stringify({ at: "2026-09-02T10:00:00Z", argv2: null, existed: false, wrote: false }),
  ]);
  assert.equal(c.ok, false);
  assert.match(c.evidence, /argv\[2\]/);
});

test("checkHandoff reports unknown, not failure, when the picker has never run", () => {
  const c = checkHandoff([]);
  assert.equal(c.ok, false);
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /never/i);
});

test("checkFingerprint is green when the version and commit match", () => {
  const f = { ran: true, ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" };
  assert.equal(checkFingerprint(f, f).verdict, "green");
});

test("checkFingerprint is amber and names the delta when Claude Code auto-updated", () => {
  const c = checkFingerprint({ ccVersion: "2.1.300", ccCommit: "aaaa" },
                             { ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" });
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /2\.1\.258/);
  assert.match(c.evidence, /2\.1\.300/);
});

test("checkFingerprint is red when the version could not be read at all", () => {
  const c = checkFingerprint({}, { ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" });
  assert.equal(c.verdict, "red");
});

test("checkFingerprint is amber on a first run with nothing pinned", () => {
  const c = checkFingerprint({ ran: true, ccVersion: "2.1.258", ccCommit: "b" }, {});
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /no pinned/i);
  assert.match(c.evidence, /--accept-fingerprint/);
});

test("an unparseable `claude doctor` output is RED, not amber", () => {
  // The probe itself has broken. Amber here would let a format change decay into
  // "recorded, carry on" -- the doctor greening on the exact class of failure it
  // exists to detect.
  const c = checkFingerprint({ ran: true, parseFailed: true, raw: "Claude Code v9 :)" }, {});
  assert.equal(c.verdict, "red");
  assert.equal(c.ok, false);
  assert.match(c.evidence, /readClaudeFingerprint/);
});

test("version drift does not resolve itself; it asks for a human", () => {
  const c = checkFingerprint({ ran: true, ccVersion: "2.2.000", ccCommit: "z" },
                             { ccVersion: "2.1.258", ccCommit: "b" });
  assert.equal(c.verdict, "amber");
  assert.equal(c.ok, false, "drift is not a passing check");
  assert.match(c.evidence, /--accept-fingerprint/);
});

test("a stale handoff row stops being evidence, and is red once CC has run since", () => {
  // The failure mode this whole check exists for: when the editor protocol moves,
  // ctrl+g stops reaching the picker, NO new row is appended, and reading the last
  // row forever reports the last success as current health.
  const OLD = "2026-06-01T00:00:00.000Z";
  const rows = [JSON.stringify({ at: OLD, argv2: "C:\\t.md", existed: true, wrote: true })];
  const now = Date.parse("2026-09-03T00:00:00.000Z");

  const used = checkHandoff(rows, { now, claudeRunSince: Date.parse("2026-09-01T00:00:00.000Z") });
  assert.equal(used.verdict, "red");
  assert.match(used.evidence, /no longer reaching the picker/);

  const unused = checkHandoff(rows, { now, claudeRunSince: null });
  assert.equal(unused.verdict, "amber");

  const fresh = checkHandoff(
    [JSON.stringify({ at: "2026-09-02T00:00:00.000Z", argv2: "C:\\t.md",
                      existed: true, wrote: true })],
    { now, claudeRunSince: now });
  assert.equal(fresh.verdict, "green");
  assert.ok(MAX_HANDOFF_AGE_MS > 0);
});

test("diagnose reports the worst verdict and names the failing check", () => {
  const r = diagnose({
    env: { EDITOR: "notepad.exe" },
    handoff: [],
    current: { ran: true, ccVersion: "2.1.258", ccCommit: "b" },
    pinned: { ccVersion: "2.1.258", ccCommit: "b" },
  });
  assert.equal(r.verdict, "red");
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes("editor-wiring"));
});

test("diagnose is green when everything holds", () => {
  const f = { ran: true, ccVersion: "2.1.258", ccCommit: "b" };
  const now = Date.now();
  const r = diagnose({
    env: { EDITOR: CMD, UW_REAL_EDITOR: "C:\\Windows\\notepad.exe" },
    handoff: [JSON.stringify({ at: new Date(now - 1000).toISOString(),
                               argv2: "C:\\t.md", existed: true, wrote: true })],
    handoffOpts: { now, claudeRunSince: now },
    current: f, pinned: f,
  });
  assert.equal(r.verdict, "green");
});

test("a reverted gateway patch is RED and names the npm command that caused it", () => {
  // Report 10, P1 #10. The one CCR failure that presents as flakiness rather than
  // as a fault, so it has to be caught by inspection, not by symptom.
  const stock = 'x\r\nvar PN="gateway",K7=5e3,z7=15e3,aVe=4e3\r\ny';
  const c = checkCcrPatch({ file: "cli.js", read: () => stock });
  assert.equal(c.verdict, "red");
  assert.match(c.evidence, /5000 ms/);
  assert.match(c.evidence, /npm i -g/);
  assert.match(c.evidence, /INTERMITTENT/);
});

test("the patched bundle passes, and CRLF does not change the answer", () => {
  // The measured trap: 2,308,421 bytes CRLF against a 2,299,525-byte LF backup.
  // Any size or digest comparison that skips normalisation reports a difference
  // that is not one.
  const lf   = 'var PN="gateway",K7=2e4,z7=15e3';
  const crlf = lf.replace(/\n/g, "\r\n");
  for (const body of [lf, crlf, "prefix\r\n" + crlf]) {
    assert.equal(checkCcrPatch({ file: "cli.js", read: () => body }).verdict, "green");
  }
});

test("the patch check anchors on the stable literal, never on the minified name", () => {
  // K7 is a minified identifier; a rebuild may call it Q3 or zP. A check that
  // grepped for `K7=2e4` would report the patch missing on every future CCR
  // release, whether or not it actually is.
  const renamed = 'var PN="gateway",zP=2e4,z7=15e3';
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => renamed }).verdict, "green");

  // And when the anchor itself is gone, the honest answer is "this check is
  // stale", not "the patch is missing".
  const rebuilt = checkCcrPatch({ file: "cli.js", read: () => "var QQ=1,RR=2" });
  assert.equal(rebuilt.verdict, "amber");
  assert.match(rebuilt.evidence, /Do NOT assume the patch is absent/);
});

test("checkRpcSurface names the method that moved", () => {
  const gone = checkRpcSurface({ methods: { getAppInfo: true, getConfig: false, probeProvider: true } });
  assert.equal(gone.verdict, "red");
  assert.match(gone.evidence, /getConfig/);
});

// "The method did not answer" has four causes with three different owners. The
// check reported RED "the method names moved in an upgrade" for all of them.
// Every state below was measured against the live gateway before being encoded.
const ALL = ["getAppInfo", "getConfig", "probeProvider"];
const surface = (states) => ({
  methods: Object.fromEntries(ALL.map((m) => [m, states[m] === "ok" || states[m] === "error"])),
  states,
});

test("a 401 is RED and blames UW, because the gateway is alive and we are not authenticating", () => {
  // Measured: POST /api/ccr/rpc with no header -> 401 in 4 ms; with
  // x-ccr-web-auth carrying service.json's ccr_web_token -> 200. So this state
  // means our client stopped sending the header, which is our defect to fix.
  const c = checkRpcSurface(surface({ getAppInfo: "auth", getConfig: "auth", probeProvider: "auth" }));
  assert.equal(c.verdict, "red");
  assert.match(c.evidence, /x-ccr-web-auth/);
  assert.match(c.evidence, /UW defect/);
  assert.doesNotMatch(c.evidence, /the method names moved in an upgrade/);
});

test("a refused connection is amber: the gateway is down, service.json is just stale", () => {
  const c = checkRpcSurface(surface({ getAppInfo: "refused", getConfig: "refused", probeProvider: "refused" }));
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /not running|stale/i);
  assert.doesNotMatch(c.evidence, /the method names moved in an upgrade/);
});

test("a timeout is amber and says slow, not absent", () => {
  // The live cause. getAppInfo takes ~7.2 s repeatably while getConfig answers in
  // 6 ms, and an aborted call keeps the gateway busy so the calls queued behind it
  // time out too -- which is why the whole surface read as missing under the old
  // 2000 ms budget.
  const c = checkRpcSurface(surface({ getAppInfo: "timeout", getConfig: "timeout", probeProvider: "timeout" }));
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /slow, not absent/);
  assert.doesNotMatch(c.evidence, /the method names moved in an upgrade/);
});

test("a method that ran and returned ok:false is PRESENT — the name resolved", () => {
  // probeProvider does exactly this on a null argument: HTTP 500, ok:false, 2 ms.
  // The surface probe asks whether the NAME resolves, and it did.
  const c = checkRpcSurface(surface({ getAppInfo: "ok", getConfig: "ok", probeProvider: "error" }));
  assert.equal(c.verdict, "green");
});

test("a genuinely renamed method is still red, and named", () => {
  const c = checkRpcSurface({ methods: { getAppInfo: true, getConfig: false, probeProvider: true },
                              states: { getAppInfo: "ok", getConfig: "bad-body", probeProvider: "ok" } });
  assert.equal(c.verdict, "red");
  assert.match(c.evidence, /getConfig/);
  assert.match(c.evidence, /moved in an upgrade/);
});

test("an installed/running version split is reported before it bites", () => {
  // CCR updated on disk, gateway not restarted. The patch check reads the NEW
  // file while the live process still holds the OLD one, so both can be green
  // today and fail on the next restart.
  const split = checkRpcSurface({
    methods: { getAppInfo: true, getConfig: true, probeProvider: true },
    installedVersion: "3.1.0", runningVersion: "3.0.22",
  });
  assert.equal(split.verdict, "amber");
  assert.match(split.evidence, /without a restart/);
  assert.match(split.evidence, /next restart/);
});

test("checkBundled is amber, not red, when CCR's catalogue has moved", () => {
  // Amber because Task B4 copied the catalogue into ~/.uw/catalog/, so the picker
  // keeps working; what breaks is the next copy-out.
  const gone = checkBundled({ dir: "C:/nope", catalogue: "C:/nope/dist/models.json" });
  assert.equal(gone.verdict, "amber");
  assert.match(gone.evidence, /resolveInstall/);

  // import.meta.dirname / .filename, not __dirname: this file is ESM, where
  // __dirname is not defined and the reference throws before the assertion runs.
  const drift = checkBundled({ dir: import.meta.dirname, catalogue: import.meta.filename,
                               version: "3.1.0", verified: "3.0.22" });
  assert.equal(drift.verdict, "amber");
  assert.match(drift.evidence, /3\.1\.0/);
});

test("checkContracts is green only when the pinned version is the running one", () => {
  const ok = checkContracts({ ccObserved: "2.1.258", ccPinned: "2.1.258", service: { origin: "x" } });
  assert.equal(ok.verdict, "green");
  const drift = checkContracts({ ccObserved: "2.2.000", ccPinned: "2.1.258", service: { origin: "x" } });
  assert.equal(drift.verdict, "amber");
  assert.match(drift.evidence, /2\.2\.000/);
  assert.match(drift.evidence, /CONTRACT\.fingerprint/);
});

test("checkContracts degrades rather than fails when CCR is not running", () => {
  const c = checkContracts({ ccObserved: "2.1.258", ccPinned: "2.1.258", service: null });
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /cached set/);
});

test("checkHud passes when the shim is not installed at all", () => {
  const c = checkHud({ install: null });
  assert.equal(c.ok, true);
  assert.equal(c.verdict, "green");
  assert.match(c.evidence, /optional/);
});

test("checkHud is red when the command it wraps has gone, and names the undo", () => {
  const gone = checkHud({ install: { previousCommand: '"C:/gone/node.exe" "x.mjs"' },
                          wrappedExists: false, roundTrip: { ok: true } });
  assert.equal(gone.verdict, "red");
  // -HudUninstall, which is the flag install.ps1 actually implements. The task
  // named "-Uninstall", so the doctor's one actionable remedy pointed at a switch
  // that does not exist.
  assert.match(gone.evidence, /-HudUninstall/);
  const stale = checkHud({ install: { previousCommand: "x" }, wrappedExists: true,
                           roundTrip: { ok: false, why: "context size not applied" } });
  assert.equal(stale.verdict, "amber");
  assert.match(stale.evidence, /footer still works/);
});

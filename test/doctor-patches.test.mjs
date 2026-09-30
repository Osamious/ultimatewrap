// Doctor coverage for the five local CCR patches (Part 2 of
// plans/ccr-patch-consolidation-plan.md). Text is injected; nothing here touches
// the real install. The stock hunks come from the same fixture the patch script's
// tests use, and "applied" text is produced by the recipes themselves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { checkCcrPatch, checkCcrPatches, diagnose } from "../menu/doctor.mjs";
import { PATCHES, MARKERS, applyPatch } from "../menu/ccr-patches.mjs";

const H = JSON.parse(fs.readFileSync(new URL("./fixtures/ccr-3.0.22-hunks.json", import.meta.url), "utf8"));
const P = (id) => PATCHES.find((p) => p.id === id);
const eol = (s, e) => s.replace(/\r\n/g, "\n").replace(/\n/g, e);

const cliStock = (e = "\n") => eol(["// one", H.cli.A, "// two", H.cli.B, "// three", H.cli.C, "// four", H.cli.D, "// five", H.cli.Duse, "// tail"].join("\n"), e);
const libStock = (e = "\n") => eol(["// head", H.lib.E[0], "// mid", H.lib.E[1], "// tail"].join("\n"), e);
const apply = (text, ...ids) => ids.reduce((t, id) => applyPatch(t, P(id)), text);
const CLI_ALL = () => apply(cliStock(), "A", "B", "C", "D");
const LIB_ALL = () => apply(libStock(), "E");

const V = { version: "3.0.22", verified: "3.0.22", libVersion: "1.0.18" };
const run = (over = {}) => checkCcrPatches({ cliText: CLI_ALL(), libText: LIB_ALL(), ...V, ...over });
const by = (checks, name) => checks.find((c) => c.name === name);
const NAMES = { B: "ccr-savecfg-patch", C: "ccr-pd-cache-patch", D: "ccr-findprovider-patch", E: "ccr-error-detail-patch" };

test("sanity: the stock fixtures are stock and the applied fixtures pass every check green", () => {
  const checks = run();
  assert.deepEqual(checks.map((c) => c.name), Object.values(NAMES));
  for (const c of checks) assert.equal(c.verdict, "green", `${c.name}: ${c.evidence}`);
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => CLI_ALL() }).verdict, "green");
});

test("severity policy on the verified version: C is RED, B/D/E are AMBER, and evidence names the fix and the restart", () => {
  const checks = run({ cliText: cliStock(), libText: libStock() });
  const want = { B: "amber", C: "red", D: "amber", E: "amber" };
  for (const [id, verdict] of Object.entries(want)) {
    const c = by(checks, NAMES[id]);
    assert.equal(c.verdict, verdict, `${id}: ${c.evidence}`);
    assert.match(c.evidence, /node keysync\/ccr-patch\.mjs --check/);
    assert.match(c.evidence, /node keysync\/ccr-patch\.mjs --apply/);
    assert.match(c.evidence, /restart the gateway/);
  }
});

test("patch A missing is RED with the fix command appended, and stays RED on the verified version", () => {
  const c = checkCcrPatch({ file: "cli.js", read: () => cliStock(), ...V });
  assert.equal(c.verdict, "red");
  assert.match(c.evidence, /ccr-patch\.mjs --apply/);
  assert.match(c.evidence, /restart the gateway/);
});

test("each patch applied on its own is green while the others stay missing", () => {
  for (const id of ["B", "C", "D"]) {
    const checks = run({ cliText: apply(cliStock(), id), libText: libStock() });
    assert.equal(by(checks, NAMES[id]).verdict, "green", id);
    for (const other of ["B", "C", "D"].filter((x) => x !== id)) assert.notEqual(by(checks, NAMES[other]).verdict, "green");
  }
  assert.equal(by(run({ libText: LIB_ALL() }), NAMES.E).verdict, "green");
});

test("a version that is not the verified one demotes every missing patch to AMBER and says why", () => {
  const checks = run({ cliText: cliStock(), libText: libStock(), version: "3.1.1" });
  for (const c of checks) {
    assert.equal(c.verdict, "amber", `${c.name}: ${c.evidence}`);
  }
  for (const n of [NAMES.B, NAMES.C, NAMES.D]) {
    assert.match(by(checks, n).evidence, /3\.1\.1 is not the 3\.0\.22/);
    assert.match(by(checks, n).evidence, /Pd\/QQe were fixed upstream in 3\.1\.0; the other patches are unverified on this version/);
    assert.doesNotMatch(by(checks, n).evidence, /timeouts|error-detail/);
  }
  const a = checkCcrPatch({ file: "cli.js", read: () => cliStock(), version: "3.1.1", verified: "3.0.22" });
  assert.equal(a.verdict, "amber");
  assert.match(a.evidence, /fixed upstream/);
  // A different ai-gateway than recipe E was verified for: E was AMBER anyway, but the reason is named.
  const e = by(run({ libText: libStock(), libVersion: "1.1.0" }), NAMES.E);
  assert.equal(e.verdict, "amber");
  assert.match(e.evidence, /ai-gateway 1\.1\.0 is not the 1\.0\.18/);
});

test("unknown version (null) demotes a missing A or C to AMBER with 'CCR version unknown' wording, never RED", () => {
  const checks = run({ cliText: cliStock(), libText: libStock(), version: null });
  for (const c of checks) assert.equal(c.verdict, "amber", `${c.name}: ${c.evidence}`);
  for (const n of [NAMES.B, NAMES.C, NAMES.D]) assert.match(by(checks, n).evidence, /CCR version unknown/);
  const a = checkCcrPatch({ file: "cli.js", read: () => cliStock(), version: null, verified: "3.0.22" });
  assert.equal(a.verdict, "amber");
  assert.match(a.evidence, /CCR version unknown/);
  assert.match(a.evidence, /ccr-patch\.mjs --apply/);
  // The same missing patches with a known matching version are still RED (A and C).
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => cliStock(), ...V }).verdict, "red");
  assert.equal(by(run({ cliText: cliStock(), libText: libStock() }), NAMES.C).verdict, "red");
});

test("null or missing verified version demotes a missing A or C to AMBER: recipes cannot be claimed to apply", () => {
  for (const verified of [null, undefined]) {
    const checks = run({ cliText: cliStock(), libText: libStock(), verified });
    for (const c of checks) assert.equal(c.verdict, "amber", `${c.name}: ${c.evidence}`);
    assert.match(by(checks, NAMES.C).evidence, /not recorded/);
    const a = checkCcrPatch({ file: "cli.js", read: () => cliStock(), version: "3.0.22", verified });
    assert.equal(a.verdict, "amber");
    assert.match(a.evidence, /not recorded/);
  }
  // Both null (context supplied but unknown) is AMBER; a standalone call with no context keeps RED.
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => cliStock(), version: null, verified: null }).verdict, "amber");
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => cliStock() }).verdict, "red");
});

test("applied patches stay green on an unverified version (demotion only softens a MISSING patch)", () => {
  for (const c of run({ version: "3.1.1" })) assert.equal(c.verdict, "green", c.name);
});

test("anchor gone is AMBER 'do not assume absent', distinct from 'modified'", () => {
  const rebuilt = "var QQ=1,RR=2;function other(){}";
  const checks = run({ cliText: rebuilt, libText: "nothing here" });
  for (const c of checks) {
    assert.equal(c.verdict, "amber", c.name);
    assert.match(c.evidence, /anchor gone/, c.name);
    assert.match(c.evidence, /Do NOT assume the patch is absent/, c.name);
    assert.doesNotMatch(c.evidence, /modified\/unexpected/, c.name);
  }
});

test("anchor gone under CRLF is AMBER 'anchor gone', and stays so when the version also demotes", () => {
  const rebuilt = "var QQ=1,RR=2;\r\nfunction other(){}\r\n";
  const lib = "nothing here\r\n";
  for (const over of [{}, { version: "3.1.1" }, { version: null }]) {
    const checks = run({ cliText: rebuilt, libText: lib, ...over });
    for (const c of checks) {
      assert.equal(c.verdict, "amber", c.name);
      assert.match(c.evidence, /anchor gone/, c.name);
      assert.match(c.evidence, /Do NOT assume the patch is absent/, c.name);
      assert.doesNotMatch(c.evidence, /modified\/unexpected|is not the 3\.0\.22|version unknown/, c.name);
    }
  }
  const a = checkCcrPatch({ file: "cli.js", read: () => rebuilt, version: "3.1.1", verified: "3.0.22" });
  assert.equal(a.verdict, "amber");
  assert.match(a.evidence, /anchor .* is gone/);
});

test("markers present but the text edited is AMBER 'modified/unexpected' with counts, never RED or 'absent'", () => {
  const cli = CLI_ALL();
  // C: keep the markers, damage the second step's replacement.
  const brokenC = cli.replace("UW_c.set(UW_k,UW_v)", "UW_c.set(UW_k,UW_v,1)");
  // D: a third occurrence of the guard token.
  const brokenD = cli + "\nfunction x(){return QQe(a)}";
  // E: only one of the two sites patched.
  const { find, replace } = P("E").steps[0];
  const halfE = libStock().replace(find, () => replace); // first site only
  for (const [id, over] of [["C", { cliText: brokenC }], ["D", { cliText: brokenD }], ["E", { libText: halfE }]]) {
    const c = by(run(over), NAMES[id]);
    assert.equal(c.verdict, "amber", `${id}: ${c.evidence}`);
    assert.match(c.evidence, /modified\/unexpected/, id);
    assert.match(c.evidence, /expected x\d/, id);
    assert.doesNotMatch(c.evidence, /anchor gone/, id);
  }
  // B: a value that is neither the stock 3e4 nor the patched one.
  const oddB = cli.replace("yx=12e4", "yx=5e3");
  const b = by(run({ cliText: oddB }), NAMES.B);
  assert.equal(b.verdict, "amber");
  assert.match(b.evidence, /modified\/unexpected/);
});

test("CRLF, LF and mixed line endings give the same verdicts", () => {
  const verdicts = (cli, lib) => run({ cliText: cli, libText: lib }).map((c) => c.verdict);
  const stockLF = verdicts(cliStock(), libStock());
  assert.deepEqual(stockLF, ["amber", "red", "amber", "amber"]);
  assert.deepEqual(verdicts(cliStock("\r\n"), libStock("\r\n")), stockLF);
  assert.deepEqual(verdicts(CLI_ALL(), LIB_ALL()), ["green", "green", "green", "green"]);
  assert.deepEqual(verdicts(eol(CLI_ALL(), "\r\n"), eol(LIB_ALL(), "\r\n")), ["green", "green", "green", "green"]);
  const mixed = CLI_ALL().replace(/\n/, "\r\n");
  assert.deepEqual(verdicts(mixed, LIB_ALL()), ["green", "green", "green", "green"]);
});

test("an unreadable cli.js is AMBER for A-D (never 'absent'); the lib check is unaffected", () => {
  const checks = run({ cliText: null });
  for (const id of ["B", "C", "D"]) {
    const c = by(checks, NAMES[id]);
    assert.equal(c.verdict, "amber");
    assert.match(c.evidence, /cannot read/);
  }
  assert.equal(by(checks, NAMES.E).verdict, "green");
  const a = checkCcrPatch({ file: "cli.js", read: () => { throw new Error("EACCES"); } });
  assert.equal(a.verdict, "amber");
});

test("lib missing while cli is readable: A-D are still reported, E is AMBER naming the contract path", () => {
  const checks = run({ libText: null });
  for (const id of ["B", "C", "D"]) assert.equal(by(checks, NAMES[id]).verdict, "green");
  const e = by(checks, NAMES.E);
  assert.equal(e.verdict, "amber");
  assert.match(e.evidence, /CONTRACT\.gatewayLibBundle/);
  assert.match(e.evidence, /bundles ai-gateway inside cli\.js/);
  assert.match(e.evidence, /Do NOT assume/);
});

test("single source: every marker is in its recipe's replace text, and evidence quotes only MARKERS strings", () => {
  for (const p of PATCHES) {
    for (const m of MARKERS[p.id]) assert.ok(p.steps.some((s) => s.replace.includes(m)), `${p.id}: ${m}`);
  }
  const all = [...MARKERS.C, ...MARKERS.D, ...MARKERS.E];
  const shown = run().map((c) => c.evidence).join("\n");
  // The applied evidence for C, D, E quotes exactly the first marker of each recipe.
  for (const id of ["C", "D", "E"]) assert.ok(shown.includes(MARKERS[id][0]), id);
  assert.ok(all.length > 0);
  // No marker-looking token (UW_ prefix) may appear that is not a MARKERS entry.
  for (const tok of shown.match(/UW_[A-Za-z_]+/g) ?? []) {
    assert.ok(all.some((m) => m.includes(tok)), `evidence names ${tok}, which is not in MARKERS`);
  }
  const doctorSrc = fs.readFileSync(new URL("../menu/doctor.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(doctorSrc, /UW_PD_|UW_QQE_|UW_pdc|const _d=t&&/, "doctor.mjs must not spell marker strings");
});

test("diagnose(): the new checks come right after ccr-gateway-patch; worst verdict wins; RED only from C/A", () => {
  const base = {
    env: { EDITOR: "x", UW_REAL_EDITOR: "y" }, handoff: [], current: { ccVersion: "1", ccCommit: "c" },
    pinned: { ccVersion: "1", ccCommit: "c" },
  };
  const good = diagnose({ ...base, ccrPatch: { file: "cli.js", read: () => CLI_ALL() },
                          ccrPatches: { cliText: CLI_ALL(), libText: LIB_ALL(), ...V } });
  const names = good.checks.map((c) => c.name);
  const i = names.indexOf("ccr-gateway-patch");
  assert.deepEqual(names.slice(i, i + 5), ["ccr-gateway-patch", ...Object.values(NAMES)]);

  const missingE = diagnose({ ...base, ccrPatch: { file: "cli.js", read: () => CLI_ALL() },
                              ccrPatches: { cliText: CLI_ALL(), libText: libStock(), ...V } });
  assert.equal(missingE.checks.filter((c) => c.name.startsWith("ccr-")).some((c) => c.verdict === "red"), false);

  const missingC = diagnose({ ...base, ccrPatch: { file: "cli.js", read: () => CLI_ALL() },
                              ccrPatches: { cliText: apply(cliStock(), "A", "B", "D"), libText: LIB_ALL(), ...V } });
  assert.equal(missingC.verdict, "red");
  assert.equal(by(missingC.checks, NAMES.C).verdict, "red");

  // Omitting the argument leaves diagnose() exactly as before.
  assert.equal(diagnose({ ...base }).checks.some((c) => c.name === NAMES.C), false);
});

test("output shape and read-only contract are unchanged", () => {
  const src = fs.readFileSync(new URL("../menu/doctor.mjs", import.meta.url), "utf8");
  assert.match(src, /console\.log\(`\$\{c\.verdict\.toUpperCase\(\)\.padEnd\(6\)\} \$\{c\.name\.padEnd\(22\)\} \$\{c\.evidence\}`\)/);
  assert.match(src, /console\.log\(`\\nverdict: \$\{r\.verdict\}`\)/);
  assert.match(src, /process\.exitCode\s*=\s*r\.verdict === "red" \? 1 : 0/);
  // cli.js is read once in main(), and the only write remains capabilities.json.
  assert.equal((src.match(/readOrNull\(CCR\.CONTRACT\.gatewayBundle\)/g) ?? []).length, 1);
  assert.equal((src.match(/writeAtomic\(|writeFileSync\(|renameSync\(|appendFileSync\(/g) ?? []).length, 1);
  // Paths come from the contract, never hardcoded.
  assert.match(src, /CCR\.CONTRACT\.gatewayLibBundle/);
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""), /node_modules|ai-gateway[\\/]dist/);
});

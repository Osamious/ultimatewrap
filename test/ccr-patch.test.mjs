// keysync/ccr-patch.mjs and menu/ccr-patches.mjs, against synthetic install trees
// built in a temp dir from the real stock hunks (test/fixtures/ccr-3.0.22-hunks.json).
// Nothing here writes to the real install or the real pristine store; the two
// tests that read the real install are read-only and skip when it is absent or
// is not the exact 3.0.22 state they were written against.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkTmp } from "./helpers/tmp.mjs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PATCHES, MARKERS, classify, applyPatch, revertPatch, validateRecipes } from "../menu/ccr-patches.mjs";
import { run, realDeps } from "../keysync/ccr-patch.mjs";
import * as CCR from "../menu/ccr-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "ccr-3.0.22-hunks.json"), "utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const P = (id) => PATCHES.find((p) => p.id === id);

// ---- fixtures --------------------------------------------------------------

const cliLines = (extra = []) => [
  "// filler one", H.cli.A, "// filler two", H.cli.B, "// filler three", H.cli.C,
  "// filler four", H.cli.D, "// filler five", H.cli.Duse, ...extra, "// tail",
];
const libLines = () => ["// lib head", H.lib.E[0], "// lib middle", H.lib.E[1], "// lib tail"];
const join = (lines, eol) => lines.join(eol) + eol;

/** A synthetic install tree; `deps()` points the script at it. Cleaned up by the caller. */
function tree({ eol = "\n", version = "3.0.22", libVersion = "1.0.18", cli, lib } = {}) {
  const root = mkTmp("uwpatch-test-");
  const pkg = path.join(root, "pkg");
  const cliPath = path.join(pkg, "dist", "main", "cli.js");
  const libDir = path.join(pkg, "node_modules", "@the-next-ai", "ai-gateway");
  const libPath = path.join(libDir, "dist", "index.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.mkdirSync(path.dirname(libPath), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(libDir, "package.json"), JSON.stringify({ version: libVersion }));
  fs.writeFileSync(cliPath, Buffer.from(cli ?? join(cliLines(), eol), "latin1"));
  fs.writeFileSync(libPath, Buffer.from(lib ?? join(libLines(), eol), "latin1"));
  const storeDir = path.join(root, "store");
  const t = {
    root, pkg, cliPath, libPath, storeDir,
    cli: () => fs.readFileSync(cliPath), lib: () => fs.readFileSync(libPath),
    debris: () => [cliPath, libPath].flatMap((f) => fs.readdirSync(path.dirname(f)).filter((n) => /uwpatch/.test(n))),
    deps: (over = {}) => ({
      targets: { cli: cliPath, gatewayLib: libPath }, installDir: pkg, storeDir,
      version, libVersion, verifiedVersion: "3.0.22", patches: PATCHES,
      nodeCheck: () => ({ ok: true }), now: () => "2026-01-01T00:00:00.000Z",
      rename: fs.renameSync, sleep: () => {}, ...over,
    }),
    go(argv, over = {}) {
      const lines = [], errs = [];
      const d = { ...t.deps(over), out: (l) => lines.push(l), err: (l) => errs.push(l) };
      const code = run(argv, d);
      return { code, out: lines.join("\n"), err: errs.join("\n") };
    },
    done: () => fs.rmSync(root, { recursive: true, force: true }),
  };
  return t;
}

const withTree = (opts, fn) => {
  const t = tree(opts);
  try { return fn(t); } finally { t.done(); }
};

// ---- 1. recipes ------------------------------------------------------------

test("recipe validator passes on the real recipes and fails on the traps it exists for", () => {
  assert.deepEqual(validateRecipes(), { ok: true, problems: [] });
  const self = [{ id: "X", title: "t", file: "cli", severity: "red", steps: [{ find: "ab", replace: "xxabxx", count: 1 }], guards: [], markers: [] }];
  assert.match(validateRecipes(self).problems.join("|"), /contains its own find/);
  const nl = [{ ...self[0], steps: [{ find: "a\nb", replace: "c", count: 1 }] }];
  assert.match(validateRecipes(nl).problems.join("|"), /newline/);
  const dup = [self[0], self[0]];
  assert.match(validateRecipes(dup).problems.join("|"), /duplicate id/);
  const mk = [{ ...self[0], steps: [{ find: "ab", replace: "cd", count: 1 }], markers: ["zz"] }];
  assert.match(validateRecipes(mk).problems.join("|"), /marker zz/);
  const ov = [
    { id: "X", title: "t", file: "cli", severity: "red", steps: [{ find: "ab", replace: "cd", count: 1 }], guards: [], markers: [] },
    { id: "Y", title: "t", file: "cli", severity: "red", steps: [{ find: "ef", replace: "xabx", count: 1 }], guards: [], markers: [] },
  ];
  assert.match(validateRecipes(ov).problems.join("|"), /occurs inside/);
});

test("every marker is present in the applied text and absent from the stock text and from every find", () => {
  const cli = join(cliLines(), "\n"), lib = join(libLines(), "\n");
  assert.deepEqual(Object.keys(MARKERS), PATCHES.map((p) => p.id));
  for (const p of PATCHES) {
    const stock = p.file === "cli" ? cli : lib;
    const applied = applyPatch(stock, p);
    for (const m of MARKERS[p.id]) {
      assert.ok(applied.includes(m), `${p.id} marker ${m} found once applied`);
      assert.ok(!stock.includes(m), `${p.id} marker ${m} absent from stock`);
      assert.ok(p.steps.every((st) => !st.find.includes(m)), `${p.id} marker ${m} not in a find`);
      assert.ok(p.steps.some((st) => st.replace.includes(m)), `${p.id} marker ${m} in a replace`);
    }
  }
});

test("A and C are the red patches, the rest amber (Part 2 reads these)", () => {
  assert.deepEqual(PATCHES.filter((p) => p.severity === "red").map((p) => p.id), ["A", "C"]);
});

test("stock fixtures classify stock, applied text classifies applied, and the two are inverses", () => {
  const cli = join(cliLines(), "\n");
  const lib = join(libLines(), "\n");
  for (const p of PATCHES) {
    const src = p.file === "cli" ? cli : lib;
    assert.equal(classify(src, p).state, "stock", p.id);
    const done = applyPatch(src, p);
    assert.equal(classify(done, p).state, "applied", p.id);
    assert.equal(revertPatch(done, p), src, p.id);
    assert.throws(() => applyPatch(done, p), /is applied/);
    assert.throws(() => revertPatch(src, p), /is stock/);
  }
});

test("A and B semantic detectors are identifier-agnostic and threshold-based", () => {
  const A = P("A").detect, B = P("B").detect;
  assert.deepEqual(A('x;var PN="gateway",zP=2e4,z7=1,'), { state: "applied", value: 20000 });
  assert.deepEqual(A('x;var PN="gateway",K7=5e3,'), { state: "missing", value: 5000 });
  assert.equal(A("nothing here").state, "anchor-gone");
  assert.equal(A('var PN="gateway";').state, "anchor-gone");
  assert.deepEqual(B('"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=12e4,L2=1e4'), { state: "applied", value: 120000 });
  assert.deepEqual(B('"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=3e4,L2=1e4'), { state: "missing", value: 30000 });
  assert.equal(B("nothing").state, "anchor-gone");
  // CRLF must not change the answer
  assert.equal(A('var PN="gateway",K7=2e4,\r\nz').state, "applied");
});

// ---- 2. check --------------------------------------------------------------

test("check on a stock tree: exit 3, five NOT APPLIED, nothing written", () => withTree({}, (t) => {
  const before = [t.cli(), t.lib()].map(sha);
  const m = [fs.statSync(t.cliPath).mtimeMs, fs.statSync(t.libPath).mtimeMs];
  const r = t.go(["--check"]);
  assert.equal(r.code, 3);
  assert.equal((r.out.match(/NOT APPLIED/g) ?? []).length, 5);
  assert.deepEqual([t.cli(), t.lib()].map(sha), before);
  assert.deepEqual([fs.statSync(t.cliPath).mtimeMs, fs.statSync(t.libPath).mtimeMs], m);
  assert.equal(fs.existsSync(t.storeDir), false, "check must not create the store");
  assert.equal(t.go([]).code, 3, "no argument means --check");
}));

// ---- 3-4. apply ------------------------------------------------------------

test("apply: all five applied, +612 bytes in cli, second apply is a no-op that writes nothing", () => withTree({}, (t) => {
  const cli0 = t.cli(), lib0 = t.lib();
  const r = t.go(["--apply"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(t.cli().length - cli0.length, 612);
  const e = P("E").steps[0];
  assert.equal(t.lib().length - lib0.length, 2 * (e.replace.length - e.find.length));
  assert.notEqual(sha(t.cli()), sha(cli0));
  const c = t.go(["--check"]);
  assert.equal(c.code, 0);
  assert.equal((c.out.match(/\bapplied\b/g) ?? []).length, 5);
  assert.match(r.out, /Restart required/);
  const post = [sha(t.cli()), sha(t.lib())];
  const mt = fs.statSync(t.cliPath).mtimeMs;
  const again = t.go(["--apply"]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already applied/);
  assert.deepEqual([sha(t.cli()), sha(t.lib())], post);
  assert.equal(fs.statSync(t.cliPath).mtimeMs, mt);
  assert.deepEqual(t.debris(), []);
}));

test("C step 1 carries fragments of its own replacement: applying never yields two UW_PD_MAX", () => withTree({}, (t) => {
  t.go(["--apply"]);
  t.go(["--apply"]);
  t.go(["--apply", "--only", "C"]);
  const n = t.cli().toString("latin1").split("UW_PD_MAX=512").length - 1;
  assert.equal(n, 1);
  // a replace that survives inside the patched text must not read as stock
  const patched = t.cli().toString("latin1");
  assert.equal(classify(patched, P("C")).state, "applied");
  assert.equal(classify(patched, P("C")).steps[0].find, 0);
}));

// ---- 5. refusals on counts -------------------------------------------------

test("wrong counts refuse the whole run: nothing changes in EITHER file, and the message names the step and counts", () => {
  const cases = {
    "K7 anchor duplicated": { cli: join([...cliLines(), H.cli.A], "\n"), re: /A is unexpected.*step 1: find x2/ },
    "K7 anchor missing": { cli: join(cliLines(), "\n").replace("K7=5e3", "K7=6e3"), re: /A is unexpected.*step 1: find x0/ },
    "QQe token count 3": { cli: join(cliLines(["var z=QQe(1);"]), "\n"), re: /D is unexpected.*guard QQe: x3/ },
    "E with one site": { lib: join(["// lib head", H.lib.E[0], "// lib tail"], "\n"), re: /E is unexpected.*find x1, replace x0 \(expected x2\)/ },
  };
  for (const [name, { re, ...over }] of Object.entries(cases)) {
    withTree(over, (t) => {
      const before = [sha(t.cli()), sha(t.lib())];
      const r = t.go(["--apply"]);
      assert.equal(r.code, 1, name);
      assert.match(r.out, re, name);
      assert.deepEqual([sha(t.cli()), sha(t.lib())], before, name);
      assert.deepEqual(t.debris(), [], name);
      assert.equal(fs.existsSync(t.storeDir), false, name);
    });
  }
});

test("a partial state (C step 1 applied, step 2 not) is unexpected and refused", () => {
  const cli = join(cliLines(), "\n");
  const partial = cli.split(P("C").steps[0].find).join(P("C").steps[0].replace);
  assert.equal(classify(partial, P("C")).state, "unexpected");
  withTree({ cli: partial }, (t) => {
    const before = sha(t.cli());
    const r = t.go(["--apply"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /C is unexpected/);
    assert.equal(sha(t.cli()), before);
  });
});

// ---- 6. syntax gate --------------------------------------------------------

test("syntax gate: a failing candidate refuses, leaves the target untouched, no temp file, no store entry", () => withTree({}, (t) => {
  const before = [sha(t.cli()), sha(t.lib())];
  // baseline passes; a candidate containing the C marker fails
  const nodeCheck = (f) => (fs.readFileSync(f, "latin1").includes("UW_PD_MAX") ? { ok: false, message: "boom" } : { ok: true });
  const r = t.go(["--apply"], { nodeCheck });
  assert.equal(r.code, 1);
  assert.match(r.err, /fails node --check/);
  assert.deepEqual([sha(t.cli()), sha(t.lib())], before);
  assert.deepEqual(t.debris(), []);
  assert.equal(fs.existsSync(t.storeDir), false);
}));

test("syntax gate with the REAL node --check: broken recipe refused, good recipe applied, broken baseline refused", () => {
  const mk = (replace) => [{ id: "A", title: "t", file: "cli", severity: "red", steps: [{ find: "var a=1;", replace, count: 1 }], guards: [], markers: [] }];
  const real = realDeps().nodeCheck;
  const only = (t) => ({ nodeCheck: real, targets: { cli: t.cliPath } });
  withTree({ cli: "var a=1;\nvar b=2;\n" }, (t) => {
    const r = t.go(["--apply"], { ...only(t), patches: mk("var a=(;") });
    assert.equal(r.code, 1);
    assert.match(r.err, /patched .* fails node --check/);
    assert.equal(t.cli().toString(), "var a=1;\nvar b=2;\n");
    assert.deepEqual(t.debris(), []);
  });
  withTree({ cli: "var a=1;\nvar b=2;\n" }, (t) => {
    const r = t.go(["--apply"], { ...only(t), patches: mk("var a=3;") });
    assert.equal(r.code, 0, r.err);
    assert.equal(t.cli().toString(), "var a=3;\nvar b=2;\n");
  });
  withTree({ cli: "var a=1;\nvar b=;\n" }, (t) => {
    const r = t.go(["--apply"], { ...only(t), patches: mk("var a=3;") });
    assert.equal(r.code, 1);
    assert.match(r.err, /UNMODIFIED/);
    assert.equal(t.cli().toString(), "var a=1;\nvar b=;\n");
  });
});

// ---- 7. revert -------------------------------------------------------------

test("revert round trip: byte-identical to the original, via the stored original", () => withTree({}, (t) => {
  const cli0 = t.cli(), lib0 = t.lib();
  assert.equal(t.go(["--apply"]).code, 0);
  const r = t.go(["--revert"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /restoring the stored original/);
  assert.ok(t.cli().equals(cli0));
  assert.ok(t.lib().equals(lib0));
  assert.equal(t.go(["--revert"]).out.includes("already stock"), true);
  assert.deepEqual(t.debris(), []);
}));

test("--only C --revert uses the inverse recipe and leaves A, B, D, E applied", () => withTree({}, (t) => {
  t.go(["--apply"]);
  const r = t.go(["--revert", "--only", "C"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /by inverse recipe/);
  const c = t.go(["--check"]);
  assert.match(c.out, /C {2}NOT APPLIED/);
  for (const id of ["A", "B", "D", "E"]) assert.match(c.out, new RegExp(`${id} {2}applied`));
}));

test("a file edited after apply reverts by inverse recipe, keeping the edit", () => withTree({}, (t) => {
  const cli0 = t.cli();
  t.go(["--apply"]);
  fs.appendFileSync(t.cliPath, "// hand edit\n");
  const r = t.go(["--revert"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /by inverse recipe/);
  assert.ok(t.cli().equals(Buffer.concat([cli0, Buffer.from("// hand edit\n")])));
}));

test("revert refuses an unexpected file when no stored original matches", () => withTree({}, (t) => {
  t.go(["--apply"]);
  fs.rmSync(t.storeDir, { recursive: true, force: true });
  const broken = t.cli().toString("latin1").replace("UW_PD_MAX=512", "UW_PD_MAX=513");
  fs.writeFileSync(t.cliPath, Buffer.from(broken, "latin1"));
  const before = sha(t.cli());
  const r = t.go(["--revert"]);
  assert.equal(r.code, 1);
  assert.equal(sha(t.cli()), before);
}));

// ---- 8. versions -----------------------------------------------------------

test("version guard: another CCR version refuses apply naming both; --force-version still obeys the counts", () => {
  withTree({ version: "3.1.1" }, (t) => {
    const before = sha(t.cli());
    const r = t.go(["--apply"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /3\.0\.22/);
    assert.match(r.err, /3\.1\.1/);
    assert.equal(sha(t.cli()), before);
    assert.equal(t.go(["--check"]).code, 3, "check is not guarded");
    const f = t.go(["--apply", "--force-version"]);
    assert.equal(f.code, 0, f.err);
  });
  withTree({ version: "3.1.1", cli: join(cliLines(), "\n").replace("K7=5e3", "K7=6e3") }, (t) => {
    const before = sha(t.cli());
    const r = t.go(["--apply", "--force-version"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /A is unexpected/);
    assert.equal(sha(t.cli()), before);
  });
  withTree({ libVersion: "1.0.19" }, (t) => {
    const r = t.go(["--apply", "--only", "E"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /ai-gateway 1\.0\.18, installed is 1\.0\.19/);
    assert.equal(t.go(["--apply", "--only", "A"]).code, 0, "cli recipes depend on the CCR version, not the library's");
  });
});

// ---- 9. bytes --------------------------------------------------------------

test("CRLF, mixed endings and non-ASCII bytes round-trip byte for byte", () => {
  // UTF-8 for "café ☃" written as latin1 chars, plus bytes that are not valid UTF-8
  const utf8 = Buffer.from("// café ☃").toString("latin1");
  const junk = "// ÿþ\u0080 tail bytes";
  const variants = {
    crlf: () => ({ cli: join([...cliLines([utf8, junk])], "\r\n"), lib: join(libLines(), "\r\n") }),
    mixed: () => ({ cli: cliLines([utf8, junk]).map((l, i) => l + (i % 2 ? "\r\n" : "\n")).join(""), lib: libLines().map((l, i) => l + (i % 2 ? "\n" : "\r\n")).join("") }),
    lf: () => ({ cli: join(cliLines([utf8, junk]), "\n") }),
  };
  for (const [name, mk] of Object.entries(variants)) {
    withTree(mk(), (t) => {
      const cli0 = t.cli(), lib0 = t.lib();
      const r = t.go(["--apply"]);
      assert.equal(r.code, 0, `${name}: ${r.err}`);
      assert.ok(t.cli().includes(Buffer.from("// café ☃")), `${name}: utf-8 bytes survive apply`);
      assert.ok(t.cli().includes(Buffer.from([0x20, 0xff, 0xfe, 0x80, 0x20])), `${name}: invalid-utf8 bytes survive apply`);
      assert.equal(t.go(["--check"]).code, 0, name);
      const eolBefore = (cli0.toString("latin1").match(/\r\n/g) ?? []).length;
      assert.equal((t.cli().toString("latin1").match(/\r\n/g) ?? []).length, eolBefore, `${name}: CRLF count unchanged`);
      // both revert routes
      const inv = t.go(["--revert", "--only", "A,B,C,D,E"]);
      assert.equal(inv.code, 0, `${name}: ${inv.err}`);
      assert.ok(t.cli().equals(cli0), `${name}: inverse revert is byte-exact (cli)`);
      assert.ok(t.lib().equals(lib0), `${name}: inverse revert is byte-exact (lib)`);
      t.go(["--apply"]);
      assert.equal(t.go(["--revert"]).code, 0);
      assert.ok(t.cli().equals(cli0), `${name}: store revert is byte-exact`);
    });
  }
});

// ---- 10. store -------------------------------------------------------------

test("store: captured on the first apply, keyed by version and sha; reinstall re-captures; versions do not collide", () => withTree({}, (t) => {
  const cli0 = t.cli();
  t.go(["--apply"]);
  const dir = path.join(t.storeDir, "3.0.22");
  const man = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const e = man.files.cli;
  assert.equal(e.pristineSha256, sha(cli0));
  assert.equal(e.provenance, "captured");
  assert.equal(e.patchedSha256, sha(t.cli()));
  assert.equal(e.pristineBytes, cli0.length);
  assert.ok(fs.readFileSync(path.join(dir, `cli.${sha(cli0).slice(0, 16)}.orig`)).equals(cli0));
  assert.ok(man.files.gatewayLib);
  assert.deepEqual(e.patchIds, ["A", "B", "C", "D"]);

  // "npm i -g" again: a NEW stock file of the same version (different bytes)
  t.go(["--revert"]);
  const reinstalled = Buffer.from(join(cliLines(["// rebuilt filler"]), "\n"), "latin1");
  fs.writeFileSync(t.cliPath, reinstalled);
  assert.equal(t.go(["--apply"]).code, 0);
  const man2 = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(man2.files.cli.pristineSha256, sha(reinstalled));
  assert.ok(fs.existsSync(path.join(dir, `cli.${sha(cli0).slice(0, 16)}.orig`)), "the earlier original is never deleted");
  assert.ok(fs.existsSync(path.join(dir, `cli.${sha(reinstalled).slice(0, 16)}.orig`)));

  // another version, same store
  const other = tree({ version: "3.1.1" });
  try {
    const r = run(["--apply", "--force-version"], { ...other.deps({ storeDir: t.storeDir }), out: () => {}, err: () => {} });
    assert.equal(r, 0);
    assert.ok(fs.existsSync(path.join(t.storeDir, "3.1.1", "manifest.json")));
    assert.ok(fs.existsSync(path.join(t.storeDir, "3.0.22", "manifest.json")));
  } finally { other.done(); }
}));

test("store: a corrupted stored original is refused, never overwritten", () => withTree({}, (t) => {
  const cli0 = t.cli();
  t.go(["--apply"]);
  t.go(["--revert"]);
  const f = path.join(t.storeDir, "3.0.22", `cli.${sha(cli0).slice(0, 16)}.orig`);
  fs.writeFileSync(f, "tampered");
  const before = sha(t.cli());
  const r = t.go(["--apply"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /does not match its own name/);
  assert.equal(sha(t.cli()), before, "target untouched when the store step fails");
  assert.equal(fs.readFileSync(f, "utf8"), "tampered");
}));

test("--seed-store reconstructs the pristine bytes of an applied tree and re-applying reproduces the installed sha", () => withTree({}, (t) => {
  const cli0 = t.cli(), lib0 = t.lib();
  t.go(["--apply"]);
  fs.rmSync(t.storeDir, { recursive: true, force: true });
  const patched = [sha(t.cli()), sha(t.lib())];
  const r = t.go(["--seed-store"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([sha(t.cli()), sha(t.lib())], patched, "seeding never touches the install");
  const man = JSON.parse(fs.readFileSync(path.join(t.storeDir, "3.0.22", "manifest.json"), "utf8"));
  assert.equal(man.files.cli.provenance, "reconstructed");
  assert.equal(man.files.cli.pristineSha256, sha(cli0));
  assert.equal(man.files.gatewayLib.pristineSha256, sha(lib0));
  assert.equal(man.files.cli.patchedSha256, patched[0]);
  // and the seeded store is what --revert restores from
  const rv = t.go(["--revert"]);
  assert.match(rv.out, /restoring the stored original/);
  assert.ok(t.cli().equals(cli0));
  // a stock file cannot be seeded, and --only makes no sense
  assert.equal(t.go(["--seed-store"]).code, 1);
  assert.equal(t.go(["--seed-store", "--only", "A"]).code, 1);
}));

test("seed-store refuses when the recipes do not round-trip", () => withTree({}, (t) => {
  t.go(["--apply"]);
  fs.rmSync(t.storeDir, { recursive: true, force: true });
  const bad = t.cli().toString("latin1").replace("UW_PD_MAX=512", "UW_PD_MAX=513");
  fs.writeFileSync(t.cliPath, Buffer.from(bad, "latin1"));
  const r = t.go(["--seed-store"]);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(path.join(t.storeDir, "3.0.22", "manifest.json")), false);
}));

// ---- 11. atomicity ---------------------------------------------------------

test("a failing rename leaves both targets untouched and no debris", () => withTree({}, (t) => {
  const before = [sha(t.cli()), sha(t.lib())];
  const rename = () => { throw Object.assign(new Error("disk says no"), { code: "EIO" }); };
  const r = t.go(["--apply"], { rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /write failed/);
  assert.deepEqual([sha(t.cli()), sha(t.lib())], before);
  assert.deepEqual(t.debris(), []);
}));

test("second-file failure restores the first from its pre-image", () => withTree({}, (t) => {
  const before = [sha(t.cli()), sha(t.lib())];
  const rename = (from, to) => {
    if (to === t.cliPath && /uwpatch-\d+\.js$/.test(from)) throw Object.assign(new Error("locked"), { code: "EIO" });
    return fs.renameSync(from, to);
  };
  const r = t.go(["--apply"], { rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /restored index\.js/);
  assert.deepEqual([sha(t.cli()), sha(t.lib())], before);
  assert.deepEqual(t.debris(), []);
}));

test("EBUSY on rename is retried, then succeeds", () => withTree({}, (t) => {
  let fails = 0;
  const rename = (from, to) => {
    if (fails < 2) { fails++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); }
    return fs.renameSync(from, to);
  };
  const r = t.go(["--apply"], { rename });
  assert.equal(r.code, 0, r.err);
  assert.equal(t.go(["--check"]).code, 0);
}));

test("persistent EBUSY gives up with a clear error after retries", () => withTree({}, (t) => {
  let calls = 0;
  const rename = () => { calls++; throw Object.assign(new Error("busy"), { code: "EBUSY" }); };
  const before = sha(t.cli());
  const r = t.go(["--apply"], { rename });
  assert.equal(r.code, 1);
  assert.equal(calls, 4, "one try plus three retries on the first file");
  assert.equal(sha(t.cli()), before);
}));

// ---- arguments and targets -------------------------------------------------

test("bad arguments exit 1; a missing target exits 2; --only E reads only the library", () => withTree({}, (t) => {
  assert.equal(t.go(["--frobnicate"]).code, 1);
  assert.equal(t.go(["--apply", "--revert"]).code, 1);
  assert.equal(t.go(["--only", "Z"]).code, 1);
  assert.equal(t.go(["--only"]).code, 1);
  fs.rmSync(t.cliPath);
  assert.equal(t.go(["--check"]).code, 2);
  const e = t.go(["--check", "--only", "E"]);
  assert.equal(e.code, 3);
  assert.equal((e.out.match(/NOT APPLIED/g) ?? []).length, 1);
  assert.equal(t.go(["--apply", "--only", "E"]).code, 0);
  assert.equal(t.go(["--check", "--only", "E"]).code, 0);
}));

// ---- review round: gates, missing targets, byte safety, races ---------------

const synth = (steps, id = "A") => [{ id, title: "t", file: "cli", severity: "red", steps, guards: [], markers: [] }];

test("revert: a patched file failing the syntax gate reverts via the stock candidate; a broken stock candidate still refuses", () => {
  const real = realDeps().nodeCheck;
  const rec = synth([{ find: "var a=1;", replace: "var a=(;", count: 1 }]);
  const over = (t) => ({ nodeCheck: real, targets: { cli: t.cliPath }, patches: rec });
  withTree({ cli: "var a=(;\nvar b=2;\n" }, (t) => {
    const r = t.go(["--revert"], over(t));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /by inverse recipe/);
    assert.equal(t.cli().toString(), "var a=1;\nvar b=2;\n");
    assert.deepEqual(t.debris(), []);
  });
  withTree({ cli: "var a=(;\nvar b=;\n" }, (t) => {
    const r = t.go(["--revert"], over(t));
    assert.equal(r.code, 1);
    assert.match(r.err, /reverted .* fails node --check/);
    assert.doesNotMatch(r.err, /UNMODIFIED/);
    assert.equal(t.cli().toString(), "var a=(;\nvar b=;\n");
    assert.deepEqual(t.debris(), []);
  });
  // apply keeps its baseline gate: a broken unmodified file is still refused
  withTree({ cli: "var a=1;\nvar b=;\n" }, (t) => {
    const r = t.go(["--apply"], { ...over(t), patches: synth([{ find: "var a=1;", replace: "var a=3;", count: 1 }]) });
    assert.equal(r.code, 1);
    assert.match(r.err, /UNMODIFIED/);
  });
});

test("a missing library makes only E 'target missing': check reports A-D, apply needs an explicit --only", () => withTree({}, (t) => {
  fs.rmSync(t.libPath);
  const c = t.go(["--check"]);
  assert.equal(c.code, 2);
  assert.equal((c.out.match(/NOT APPLIED/g) ?? []).length, 4, "A-D are still classified");
  assert.match(c.out, /E {2}target missing/);
  const cli0 = sha(t.cli());
  const a = t.go(["--apply"]);
  assert.equal(a.code, 2);
  assert.match(a.err, /refusing: E cannot be reached/);
  assert.match(a.err, /--only/);
  assert.equal(sha(t.cli()), cli0, "no half apply");
  assert.equal(fs.existsSync(t.storeDir), false);
  assert.deepEqual(t.debris(), []);
  const b = t.go(["--apply", "--only", "A,B,C,D"]);
  assert.equal(b.code, 0, b.err);
  assert.notEqual(sha(t.cli()), cli0);
  const d = t.go(["--check"]);
  assert.equal(d.code, 2);
  assert.equal((d.out.match(/\bapplied\b/g) ?? []).length, 4);
  assert.match(d.out, /E {2}target missing/);
  assert.equal(t.go(["--check", "--only", "A,B,C,D"]).code, 0);
  assert.equal(t.go(["--revert"]).code, 2, "revert names E too");
  assert.equal(t.go(["--seed-store"]).code, 2);
}));

test("replacement text with $&, $1 and $$ round-trips byte for byte (split/join, never String.replace)", () => {
  const rec = synth([{ find: "var a=1;", replace: "var a=\"$&|$1|$$|$`|$'\";", count: 1 }])[0];
  const src = "var a=1;\nvar b=2;\n";
  const done = applyPatch(src, rec);
  assert.equal(done, "var a=\"$&|$1|$$|$`|$'\";\nvar b=2;\n");
  assert.equal(revertPatch(done, rec), src);
  withTree({ cli: src }, (t) => {
    assert.equal(t.go(["--apply"], { patches: [rec] }).code, 0);
    assert.equal(t.cli().toString(), done);
    assert.equal(t.go(["--revert", "--only", "A"], { patches: [rec] }).code, 0);
    assert.equal(t.cli().toString(), src);
  });
});

test("the error-detail shim rejects a caller-supplied --only instead of letting it override E", () => {
  const shim = path.join(ROOT, "keysync", "ccr-patch-error-detail.mjs");
  for (const args of [["--check", "--only", "A"], ["--only=A"], ["--only", "E"]]) {
    const r = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, /takes no --only/);
    assert.equal(r.stdout, "");
  }
});

test("partial apply (--only A), full apply, then revert is byte-exact (stale manifest falls back to the inverse recipe)", () => withTree({}, (t) => {
  const cli0 = t.cli(), lib0 = t.lib();
  assert.equal(t.go(["--apply", "--only", "A"]).code, 0);
  const full = t.go(["--apply"]);
  assert.equal(full.code, 0, full.err);
  assert.match(full.out, /cli: pristine not captured/);
  assert.equal(t.go(["--check"]).code, 0);
  const rv = t.go(["--revert"]);
  assert.equal(rv.code, 0, rv.err);
  assert.match(rv.out, /cli: reverting A,B,C,D by inverse recipe/);
  assert.match(rv.out, /gatewayLib: restoring the stored original/);
  assert.ok(t.cli().equals(cli0));
  assert.ok(t.lib().equals(lib0));
  assert.deepEqual(t.debris(), []);
}));

test("a target changed between read and rename aborts the run and rolls back what was already renamed", () => withTree({}, (t) => {
  const before = [t.cli(), t.lib()];
  let once = true;
  const rename = (from, to) => {
    fs.renameSync(from, to);
    // the library is renamed first; a concurrent writer then touches the bundle
    if (once && to === t.libPath) { once = false; fs.appendFileSync(t.cliPath, "// somebody else\n"); }
  };
  const r = t.go(["--apply"], { rename });
  assert.equal(r.code, 1);
  assert.match(r.err, /cli\.js changed on disk after it was read; aborting/);
  assert.match(r.err, /restored index\.js/);
  assert.ok(t.lib().equals(before[1]), "the library is back to its previous bytes");
  assert.ok(t.cli().equals(Buffer.concat([before[0], Buffer.from("// somebody else\n")])), "the concurrent edit is kept, not overwritten");
  assert.deepEqual(t.debris(), []);
}));

test("candidate and rollback temps are written with open+write+fsync+close, and fsynced before their rename", () => {
  withTree({}, (t) => {
    const ev = [];
    const fsync = (fd) => { ev.push("fsync"); fs.fsyncSync(fd); };
    const rename = (from, to) => { ev.push("rename"); fs.renameSync(from, to); };
    assert.equal(t.go(["--apply"], { fsync, rename }).code, 0);
    assert.deepEqual(ev, ["fsync", "fsync", "rename", "rename"]);
  });
  withTree({}, (t) => {
    const ev = [];
    const fsync = (fd) => { ev.push("fsync"); fs.fsyncSync(fd); };
    const rename = (from, to) => {
      if (to === t.cliPath) throw Object.assign(new Error("locked"), { code: "EIO" });
      ev.push("rename");
      fs.renameSync(from, to);
    };
    assert.equal(t.go(["--apply"], { fsync, rename }).code, 1);
    assert.deepEqual(ev, ["fsync", "fsync", "rename", "fsync", "rename"], "the rollback temp is fsynced too");
  });
});

test("version guard fails closed when no verified version is recorded; --force-version still overrides", () => withTree({}, (t) => {
  const before = sha(t.cli());
  for (const v of [undefined, ""]) {
    const r = t.go(["--apply"], { verifiedVersion: v });
    assert.equal(r.code, 1, String(v));
    assert.match(r.err, /records no verified CCR version/);
    assert.equal(sha(t.cli()), before);
  }
  assert.equal(t.go(["--apply", "--force-version"], { verifiedVersion: undefined }).code, 0);
}));

test("run as the entry point through a junction/symlink still runs (real paths are compared)", () => {
  const dir = mkTmp("uwpatch-link-");
  const link = path.join(dir, "link");
  try {
    try { fs.symlinkSync(path.join(ROOT, "keysync"), link, "junction"); } catch { return; }   // cannot create one here: nothing to test
    const r = spawnSync(process.execPath, [path.join(link, "ccr-patch.mjs"), "--only", "Z"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown patch id Z/);
  } finally {
    try { fs.rmSync(link, { force: true }); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 12. boundaries --------------------------------------------------------

const stripComments = (s) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");

test("the script names no install path, and the recipe module names none of the contract needles", () => {
  const script = stripComments(fs.readFileSync(path.join(ROOT, "keysync", "ccr-patch.mjs"), "utf8"));
  assert.doesNotMatch(script, /nvm4w/i);
  assert.doesNotMatch(script, /[A-Za-z]:\\/);
  assert.doesNotMatch(script, /node_modules|claude-code-router|APPDATA/);
  const mod = fs.readFileSync(path.join(ROOT, "menu", "ccr-patches.mjs"), "utf8");
  for (const n of [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/, /nvm4w/]) assert.doesNotMatch(mod, n);
  assert.doesNotMatch(mod, /^\s*import\b/m, "the recipe module is pure: no imports");
});

test("the picker's import graph does not reach the patch recipes", () => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f) || !fs.existsSync(f)) return;
    seen.add(f);
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:from|import\()\s*["'](\.[^"']+)["']/g)) walk(path.resolve(path.dirname(f), m[1]));
  };
  walk(path.join(ROOT, "menu", "uwpick.mjs"));
  assert.ok(seen.size > 3, "the walk found the picker's imports");
  assert.equal([...seen].some((f) => /ccr-patch/.test(f)), false);
});

test("the contract module names the bundled library, and reads its version or null", () => {
  assert.equal(path.basename(CCR.CONTRACT.gatewayLibBundle), "index.js");
  assert.ok(path.resolve(CCR.CONTRACT.gatewayLibBundle).startsWith(path.resolve(CCR.CONTRACT.installDir)));
  assert.match(CCR.CONTRACT.gatewayLibBundle.replace(/\\/g, "/"), /@the-next-ai\/ai-gateway\/dist\/index\.js$/);
  const v = CCR.gatewayLibVersion();
  assert.ok(v === null || /^\d+\.\d+\.\d+/.test(v));
});

// ---- 13. shim --------------------------------------------------------------

const REAL = { cli: CCR.CONTRACT.gatewayBundle, lib: CCR.CONTRACT.gatewayLibBundle };
const realOk = () => fs.existsSync(REAL.cli) && fs.existsSync(REAL.lib) &&
  sha(fs.readFileSync(REAL.cli)) === "160bf3ff4142b76b664a57b9f15e8abdc6bc3220faad1e4b1ec850c57b3ae168" &&
  sha(fs.readFileSync(REAL.lib)) === "1cf1eabe9e7c2d174927c88acb40de6f4297b06318ed325b69a1cacc51035438";

test("the error-detail shim is thin and reports exactly what ccr-patch.mjs --only E reports", { skip: !realOk() && "real install absent or not the verified 3.0.22 state" }, () => {
  const shimSrc = stripComments(fs.readFileSync(path.join(ROOT, "keysync", "ccr-patch-error-detail.mjs"), "utf8"));
  assert.doesNotMatch(shimSrc, /writeFileSync|copyFileSync|All target providers failed\.["']/);
  const a = spawnSync(process.execPath, [path.join(ROOT, "keysync", "ccr-patch-error-detail.mjs"), "--check"], { encoding: "utf8" });
  const b = spawnSync(process.execPath, [path.join(ROOT, "keysync", "ccr-patch.mjs"), "--check", "--only", "E"], { encoding: "utf8" });
  assert.equal(a.status, b.status);
  assert.equal(a.stdout, b.stdout);
  assert.equal(a.status, 0);
});

// ---- 14. real install, READ-ONLY ------------------------------------------

test("golden: --check against the real install reports A-E applied and writes nothing", { skip: !realOk() && "real install absent or not the verified 3.0.22 state" }, () => {
  const before = [REAL.cli, REAL.lib].map((f) => [sha(fs.readFileSync(f)), fs.statSync(f).mtimeMs]);
  const lines = [];
  const code = run(["--check"], { ...realDeps(), out: (l) => lines.push(l), err: (l) => lines.push(l) });
  const out = lines.join("\n");
  assert.equal(code, 0, out);
  for (const p of PATCHES) assert.match(out, new RegExp(`${p.id} {2}applied`));
  assert.match(out, /UW_PD_MAX=512/);
  assert.match(out, /\[20000 ms\]/);
  assert.match(out, /\[120000 ms\]/);
  assert.deepEqual([REAL.cli, REAL.lib].map((f) => [sha(fs.readFileSync(f)), fs.statSync(f).mtimeMs]), before);
});

test("recipe correctness against the real bytes: inverse reaches the stock sha, forward returns the installed sha (temp COPY only)", { skip: !realOk() && "real install absent or not the verified 3.0.22 state" }, () => {
  const STOCK_CLI_LF = "94aac2d2f15ba612c17c4c35e6bd84a4a1c957107913d9a7a0847cd9c88505db";
  const STOCK_LIB = "088a1dac2b56319ca15613ba45b4501ea76c2d5b4cbbda13b040e3964f588f9c";
  const INSTALLED_CLI = "160bf3ff4142b76b664a57b9f15e8abdc6bc3220faad1e4b1ec850c57b3ae168";
  const t = tree({});
  try {
    fs.copyFileSync(REAL.cli, t.cliPath);
    fs.copyFileSync(REAL.lib, t.libPath);
    const patched = [sha(t.cli()), sha(t.lib())];
    assert.equal(patched[0], INSTALLED_CLI);
    // real syntax gate on the real-sized bundle
    const real = realDeps().nodeCheck;
    const r = t.go(["--revert"], { nodeCheck: real });
    assert.equal(r.code, 0, r.err + r.out);
    assert.match(r.out, /by inverse recipe/);
    // stock provenance: the CRLF-normalised inverse IS the stock backup
    assert.equal(sha(Buffer.from(t.cli().toString("latin1").replace(/\r\n/g, "\n"), "latin1")), STOCK_CLI_LF);
    assert.equal(sha(t.lib()), STOCK_LIB);
    assert.equal(t.go(["--check"]).code, 3);
    // forward re-apply reproduces the installed bytes exactly
    const f = t.go(["--apply"], { nodeCheck: real });
    assert.equal(f.code, 0, f.err + f.out);
    assert.deepEqual([sha(t.cli()), sha(t.lib())], patched);
    // and the store restore path is byte-exact too
    assert.equal(t.go(["--revert"], { nodeCheck: real }).code, 0);
    assert.equal(sha(t.lib()), STOCK_LIB);
  } finally { t.done(); }
});

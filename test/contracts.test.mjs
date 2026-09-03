import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as CC from "../menu/cc-contract.mjs";
import * as CCR from "../menu/ccr-client.mjs";

const SAMPLE = {
  session_id: "s1",
  version: "2.1.258",
  model: { id: "anthropic/claude-opus-5", display_name: "Anthropic > claude-opus-5" },
  context_window: {
    total_input_tokens: 168661, total_output_tokens: 377, context_window_size: 200000,
    current_usage: { input_tokens: 2, output_tokens: 377,
                     cache_creation_input_tokens: 37950, cache_read_input_tokens: 130709 },
    used_percentage: 84, remaining_percentage: 16,
  },
};

test("modelCommand renders the exact line Claude Code accepts", () => {
  assert.equal(CC.modelCommand("google", "gemini-3.5-flash-lite"),
               "/model google/gemini-3.5-flash-lite");
});

test("modelCommand refuses an id sanitize would reject", () => {
  assert.throws(() => CC.modelCommand("google", "a\x1b[2Jb"), /rejected/);
  assert.throws(() => CC.modelCommand("google", "../../etc/passwd"), /rejected/);
});

test("handoffTarget reads argv position 2 and nothing else", () => {
  assert.equal(CC.handoffTarget(["node", "uwpick.mjs", "C:/tmp/buf.md"]), "C:/tmp/buf.md");
  assert.equal(CC.handoffTarget(["node", "uwpick.mjs"]), null);
  assert.equal(CC.handoffTarget([]), null);
});

test("exit codes carry the accept/discard semantics", () => {
  assert.equal(CC.CONTRACT.handoff.acceptExit, 0);
  assert.notEqual(CC.CONTRACT.handoff.discardExit, 0);
});

test("parseStatusline returns null on anything unexpected", () => {
  assert.equal(CC.parseStatusline("not json"), null);
  assert.equal(CC.parseStatusline(""), null);
  assert.equal(CC.parseStatusline(JSON.stringify({ hello: 1 })), null);
});

test("parseStatusline accepts the measured payload shape", () => {
  const p = CC.parseStatusline(JSON.stringify(SAMPLE));
  assert.equal(p.model.id, "anthropic/claude-opus-5");
  assert.equal(p.context_window.context_window_size, 200000);
});

test("usedTokens sums input plus both cache counters", () => {
  assert.equal(CC.usedTokens(SAMPLE), 2 + 37950 + 130709);
  assert.equal(CC.usedTokens({ context_window: {} }), null);
  assert.equal(CC.usedTokens({}), null);
});

test("both CONTRACT objects are frozen and fingerprinted", () => {
  assert.equal(Object.isFrozen(CC.CONTRACT), true);
  assert.equal(Object.isFrozen(CCR.CONTRACT), true);
  // Deliberately a literal, not CC.CONTRACT.fingerprint compared to itself. This
  // assertion is a tripwire: it fails whenever the constant moves, which forces
  // whoever moved it to have re-verified the handoff and the statusline shape
  // rather than bumping a number to make a doctor check go green.
  assert.equal(CC.CONTRACT.fingerprint, "2.1.259");
  assert.match(CCR.CONTRACT.rpcPath, /^\/api\//);
});

test("readService turns a service descriptor into an origin and a token", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "svc");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "service.json");
  fs.writeFileSync(f, JSON.stringify({ url: "http://127.0.0.1:3456/ui/?ccr_web_token=abc123" }));
  const s = CCR.readService(f);
  assert.equal(s.origin, "http://127.0.0.1:3456");
  assert.equal(s.token, "abc123");
  assert.equal(CCR.readService(path.join(dir, "missing.json")), null);
});

test("routableFromConfig flattens providers and models", () => {
  const set = CCR.routableFromConfig({
    Providers: [{ name: "google", models: ["gemini-3.5-flash-lite", "gemini-3.5-pro"] },
                { name: "groq", models: ["llama-4-scout"] },
                { name: "empty" }],
  });
  assert.equal(set.has("google/gemini-3.5-pro"), true);
  assert.equal(set.has("groq/llama-4-scout"), true);
  assert.equal(set.size, 3);
  assert.equal(CCR.routableFromConfig(null).size, 0);
});

const SVC = { origin: "http://x", token: "t" };

test("rpc never throws when the gateway misbehaves", async () => {
  const boom = () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: boom, service: SVC }), undefined);
  const slow = () => new Promise((_, rej) => setTimeout(() => rej(new Error("aborted")), 5));
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: slow, timeoutMs: 1, service: SVC }), undefined);
});

test("rpc distinguishes no answer from an answer of null", async () => {
  // This is the whole of probeRpcSurface's drift check, which decides a method
  // exists by testing `r !== undefined`. While every failure path returned null,
  // a refused connection and an unknown method both read as "present", so the
  // check reported three healthy methods against a dead gateway and could never
  // fail -- and uw doctor is built on it.
  const boom = () => { throw new Error("ECONNREFUSED"); };
  const answersNull = async () => ({ json: async () => ({ value: null }) });
  const answersValue = async () => ({ json: async () => ({ value: { version: "3.0.22" } }) });

  assert.equal(await CCR.rpc("m", [], { fetchImpl: boom, service: SVC }), undefined,
    "a transport failure is not an answer");
  assert.equal(await CCR.rpc("m", [], { fetchImpl: boom, service: null }), undefined,
    "no service descriptor is not an answer either");
  assert.equal(await CCR.rpc("m", [], { fetchImpl: answersNull, service: SVC }), null,
    "the gateway answered, and its answer was null");
  assert.deepEqual(await CCR.rpc("m", [], { fetchImpl: answersValue, service: SVC }),
    { version: "3.0.22" });

  // And the property that matters downstream: both failure forms stay falsy, so
  // `if (!cfg)` callers such as catalog.mjs:routableSet are unaffected.
  for (const f of [boom]) assert.ok(!(await CCR.rpc("m", [], { fetchImpl: f, service: SVC })));
});

test("no file anywhere in UW hard-codes an OMC path", () => {
  // Q4.7. Precisely what this checks, and what it does not: it forbids a PATH to
  // an OMC file appearing in UW's source. It does not forbid the string "OMC" --
  // install.ps1's uninstall message names OMC deliberately, because telling a user
  // which tool probably rewrote their statusline is the useful thing to say.
  //
  // The property being defended is narrower than "UW knows nothing about OMC" and
  // more useful: UW holds no OMC LOCATION that an OMC update, move or reinstall
  // could invalidate. It wraps whatever string statusLine.command contains and
  // forwards stdin verbatim on failure, so there is nothing to go stale.
  //
  // Full-line comments are stripped before matching, because the code may be
  // explained in terms of OMC even where it must not name an OMC path. Test
  // fixtures live outside menu/ and refresh/ and are exempt: they deliberately DO
  // carry the observed literal, so a change in OMC's command shape surfaces as a
  // failing round-trip test rather than as an untested assumption.
  const root = path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw");
  // Separators are normalised BEFORE matching, so every pattern stays a plain
  // forward-slash literal. A character class holding a backslash is fragile to
  // quote through shells, heredocs and editors — this project has broken JS that
  // way twice — and both `hud/omc-hud.mjs` and `hud\omc-hud.mjs` must be caught.
  // Verified against nine samples, including the three violating forms.
  const OMC_PATHS = [/omc-hud/i, /oh-my-claudecode/i, /hud\//i];
  const norm = (b) => b.replace(/\\/g, "/")
                       .replace(/^\s*(\/\/|#|REM\b).*$/gm, "");   // code, not commentary
  const offenders = [];
  for (const dir of ["menu", "refresh"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(mjs|ps1|cmd)$/.test(f)) continue;
      if (f === "hud-shim.mjs") continue;              // named for its job, not for OMC
      const body = norm(fs.readFileSync(path.join(d, f), "utf8"));
      for (const n of OMC_PATHS) if (n.test(body)) offenders.push(`${dir}/${f} matches ${n}`);
    }
  }
  assert.deepEqual(offenders, [],
    "UW must wrap whatever statusLine.command holds, never a path it believes OMC uses");
});

// Q4.3. The grep must cover .ps1 and .cmd, not just .mjs: install.ps1 is the file
// that names settings.json and uwpick.cmd is the file that names the wrapper, so
// a .mjs-only sweep exempts the two most likely offenders. Those two known paths
// get one named allowance each, keyed on file AND needle, so a NEW hard-coded
// path in either file still trips.
const BOUNDARY_ALLOW = new Map([
  ["cc-contract.mjs", /./],          // the contract module for Claude Code
  ["ccr-client.mjs", /./],           // the contract module for CCR
  // install.ps1 receives the settings path as a -SettingsFile parameter defaulted
  // from cc-contract; the literal below is only the default's documentation.
  ["install.ps1", /\.claude\b/],
  // uwpick.cmd names uwpick-run.ps1 relative to %~dp0 and nothing else; this
  // entry exists so a future absolute path is the thing that fails.
  ["uwpick.cmd", /(?!)/],            // matches nothing: no needle is allowed here
  // doctor.mjs quotes CCR's npm package name in the one actionable remedy it
  // prints -- "an `npm i -g @musistudio/claude-code-router` reverted the gateway
  // patch" -- and names node_modules in the comment explaining where the install
  // resolves. Neither is a path this file depends on; both are text a human
  // reads. Keyed to those two needles only, so a NEW settings path, APPDATA
  // reference or hard-coded loopback address in the doctor still trips the guard.
  ["doctor.mjs", /claude-code-router|node_modules/],
]);

test("no file outside the two contract modules names Claude Code or CCR", () => {
  const root = path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw");
  const needles = [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/];
  const offenders = [];
  for (const dir of ["menu", "refresh"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(mjs|ps1|cmd)$/.test(f)) continue;
      const allow = BOUNDARY_ALLOW.get(f);
      const body = fs.readFileSync(path.join(d, f), "utf8");
      for (const n of needles) {
        if (allow && allow.test(n.source)) continue;
        if (n.test(body)) offenders.push(`${dir}/${f} matches ${n}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("the boundary allowlist is keyed per file and per needle, not per file alone", () => {
  // A regression guard on the guard: if someone widens an entry to /./ for a
  // non-contract file, this fails, because that would silently exempt the file.
  for (const [f, re] of BOUNDARY_ALLOW) {
    if (f === "cc-contract.mjs" || f === "ccr-client.mjs") continue;
    assert.notEqual(re.source, ".", `${f} must not be exempted wholesale`);
  }
});

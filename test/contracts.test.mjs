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
  assert.equal(CC.CONTRACT.fingerprint, "2.1.258");
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

test("rpc returns null instead of throwing when the gateway misbehaves", async () => {
  const boom = () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: boom, service: { origin: "http://x", token: "t" } }), null);
  const slow = () => new Promise((_, rej) => setTimeout(() => rej(new Error("aborted")), 5));
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: slow, timeoutMs: 1, service: { origin: "http://x", token: "t" } }), null);
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

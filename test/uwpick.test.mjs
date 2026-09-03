import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { detectCaps, painter } from "../menu/style.mjs";
import { screen, firstFrame, failMessage, framesFor } from "../menu/uwpick.mjs";
import { recordStartup } from "../menu/state.mjs";

const CAPS = detectCaps({ TERM: "dumb" }, 80);          // deterministic: ASCII, no colour
const VT = detectCaps({ WT_SESSION: "1" }, 120);
const M = (id, badge = "", extra = {}) => ({ id, ctx: null, pin: null, pout: null, badge,
                                             tools: false, vision: false, reason: false,
                                             routable: null, ...extra });
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 12, planCount: 4, health: "ok",
    models: [M("acme-chat-1", "FREE?", { ctx: 163840, pin: 0, pout: 0, tools: true, reason: true,
                                         routable: true }),
             M("acme-pro-1", "PAID", { ctx: 1000000, pin: 0.3, pout: 1.2, vision: true,
                                       routable: false })] },
  { keyId: "personal.blank.paid", provider: "blank", free: null, planCount: 0, health: "broken",
    models: [M("blank-a")] },
];
const META = { providers: 2, models: 3, generatedAt: "2026-08-24T12:22:28.162Z",
               routableAsOf: "2026-08-24T12:25:00.000Z" };
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const show = (v, caps = CAPS) => plain(screen(v, META, { caps }));

test("the provider header names the required columns", () => {
  assert.match(show(view(initState(ROWS))), /key id\s+models\s+free\s+health/);
});

test("a nullable free column renders a dash, not a zero", () => {
  const line = show(view(initState(ROWS))).split("\n").find((l) => l.includes("personal.blank.paid"));
  assert.match(line, /-/);
  assert.doesNotMatch(line, /\s0\s/);
});

test("a provider with plan-covered models renders the +N plan form", () => {
  const line = show(view(initState(ROWS))).split("\n").find((l) => l.includes("personal.acme.free"));
  assert.match(line, /12 \+4 plan/);
});

test("the model header names the six required columns", () => {
  const s = reduce(initState(ROWS), "\r").state;
  assert.match(show(view(s)), /model\s+ctx\s+\$in\s+\$out\s+badge\s+TVR/);
});

test("model rows render ctx, prices, badge and caps", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const line = show(view(s)).split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /1M/);
  assert.match(line, /0\.30/);
  assert.match(line, /1\.20/);
  assert.match(line, /PAID/);
  assert.match(line, /-V-/);
});

test("a non-routable model row is dimmed rather than hidden", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const raw = screen(view(s), META, { caps: VT });
  const line = raw.split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /\x1b\[2m/);
  assert.equal(raw.includes("acme-pro-1"), true);
});

test("a row whose routability is unknown is NOT dimmed", () => {
  // Q1.3. `null` is "nobody checked", and the refresher writes null for every row
  // whenever it could not reach CCR. Dimming those would mean the picker shows
  // 1,584 apparently-broken models on the one occasion the gateway is down.
  const s = reduce(initState(ROWS), "\r").state;
  const unknown = { ...view(s) };
  unknown.items = unknown.items.map((it) => it.kind === "model"
    ? { ...it, model: { ...it.model, routable: null } } : it);
  const raw = screen(unknown, META, { caps: VT });
  for (const id of ["acme-chat-1", "acme-pro-1"]) {
    const line = raw.split("\n").find((l) => l.includes(id));
    // "Not dimmed" means the ROW is not wrapped in dim -- not that the escape is
    // absent. A bare search for \x1b[2m cannot express that: the PAID badge is
    // dim by design (badgeColour("PAID") === "dim"), so acme-pro-1 carries that
    // escape whether or not the row is dimmed, and the assertion failed on the
    // palette rather than on the behaviour.
    //
    // Dimming a row is `p.dim(strip(body))`, which STRIPS every inner sequence
    // before wrapping, so a dimmed row's only codes are 2 and 0. A surviving
    // capability or badge colour is therefore exact evidence the row was left
    // alone.
    const codes = [...line.matchAll(/\x1b\[([0-9;]*)m/g)].map((m) => m[1]);
    assert.ok(codes.some((c) => c !== "2" && c !== "0"),
      `${id} must not be dimmed whole when routability is unknown`);
  }
});

test("the header prints the routability stamp, and a dash when there is none", () => {
  assert.match(show(view(initState(ROWS))), /routable 08-24 12:25/);
  const noStamp = plain(screen(view(initState(ROWS)),
    { ...META, routableAsOf: null }, { caps: CAPS }));
  assert.match(noStamp, /routable -/);
});

test("uwpick.mjs contains no promise continuation and no resize listener", () => {
  // Q1.3 and Q7.2 as an executable guard rather than a comment. The blocking
  // readSync loop never re-enters the event loop, so a `.then()` or an
  // `on("resize")` here is code that cannot run -- and both were present in the
  // previous draft, promising a live routability column that always rendered
  // empty. This test is cheap and it fails the moment either comes back.
  const src = fs.readFileSync(
    path.join(os.homedir(), ".uw", "menu", "uwpick.mjs"), "utf8");
  // Strip line comments before matching, for EVERY pattern rather than only the
  // last one. The marker comment this guard protects names the very constructs it
  // forbids -- it spells out `out.on("resize", ...)` and the word `await` in
  // prose -- so a raw-source match fails against the file it is reading. Comment
  // stripping was applied to the `await` check alone, which left the other three
  // failing on their own documentation. Match only where a keyword could execute.
  const code = src.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\.then\s*\(/, "a promise continuation can never run in this process");
  assert.doesNotMatch(code, /\.on\s*\(\s*["']resize["']/, "a resize listener can never fire here");
  assert.doesNotMatch(code, /routableSet/, "routability is baked into the snapshot by the refresher");
  // `await` is the hole the other three leave open: it re-enters the event loop,
  // compiles fine, and passes a guard that only looks for `.then(`. `main` is not
  // async and nothing awaits it, so any `await` in this file is the change this
  // guard exists to stop.
  assert.doesNotMatch(code, /\bawait\b/, "an await would re-enter the event loop the loop cannot yield to");
  assert.doesNotMatch(code, /export\s+async\s+function\s+main/,
    "main must not be async: nothing awaits it, and the keyword invites the await above");
});

test("the empty state renders a row instead of a blank pane", () => {
  let s = initState(ROWS);
  for (const k of ["z", "z", "z", "z"]) s = reduce(s, k).state;
  assert.match(show(view(s)), /no match for "zzzz"/);
});

test("escape sequences in a model id cannot reach the frame", () => {
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: [M("evil\x1b[2Jx")] }];
  const s = reduce(initState(rows), "\r").state;
  assert.equal(screen(view(s), META, { caps: VT }).includes("\x1b[2J"), false);
});

test("the help line names the keys the reducer implements", () => {
  const out = show(view(initState(ROWS)));
  assert.match(out, /\[tab\]|\[⇥\]/);
  assert.match(out, /\[esc\]/);
});

// --- the four properties this task adds ------------------------------------

test("the first frame is produced synchronously, with no routability at all", () => {
  const snap = { schemaVersion: 1, generatedAt: META.generatedAt, builtAt: "x", rows: ROWS };
  const f = firstFrame({ snap, recents: [], favourites: [], caps: CAPS, termRows: 30 });
  assert.equal(typeof f.text, "string");
  assert.equal(f.text.includes("personal.acme.free"), true);
  assert.equal(f.meta.providers, 2);
  assert.equal(f.meta.models, 3);
  // Nothing here may be a promise: the whole point is that it runs before the RPC.
  assert.equal(typeof f.text.then, "undefined");
});

test("an unusable snapshot produces one actionable line naming the fix", () => {
  const m = failMessage({ reason: "missing", detail: "C:/Users/osami/.uw/catalog/snapshot.json" });
  assert.match(m, /snapshot\.json/);
  assert.match(m, /uw catalog refresh|snapshot\.mjs --build/);
  assert.equal(m.includes("\n"), false);
  assert.match(failMessage({ reason: "schema", detail: "expected schemaVersion 1, found 9" }), /found 9/);
});

test("motion off collapses every transition to a single frame", () => {
  const lines = ["a", "b", "c"];
  const off = { caps: CAPS, motion: false, painter: painter(CAPS) };
  for (const kind of ["enter", "back", "open", "select"]) {
    assert.deepEqual(framesFor(kind, lines, off), [lines]);
  }
});

test("motion on stays inside the three-frame budget", () => {
  const lines = ["a", "b", "c", "d"];
  const on = { caps: VT, motion: true, painter: painter(VT), index: 2 };
  assert.equal(framesFor("enter", lines, on).length, 3);
  assert.equal(framesFor("back", lines, on).length, 3);
  assert.equal(framesFor("open", lines, on).length, 3);
  assert.ok(framesFor("select", lines, on).length <= 4);
});

test("the picker's runtime path stays inside its line budget", () => {
  // Constraint 25, enforced rather than asserted in prose. The module list is
  // uwpick.mjs's transitive import graph, not a hand-picked set -- the first
  // version of the constraint omitted cc-contract.mjs and state.mjs, both
  // imported directly, so the budget under-counted the thing it bounded.
  //
  // Gated on the files existing so the suite stays at `# fail 0` before A10 lands
  // (Constraint 15a). Blank lines and comment-only lines do not count: the budget
  // exists because parse and execution cost scale with code, and this plan wants
  // its reasoning written down.
  const MENU_DIR = path.join(os.homedir(), ".uw", "menu");
  const RUNTIME = ["uwpick.mjs", "pick-state.mjs", "style.mjs", "snapshot.mjs",
                   "sanitize.mjs", "denylist.mjs", "atomic.mjs", "cc-contract.mjs",
                   "state.mjs"];
  const present = RUNTIME.filter((f) => fs.existsSync(path.join(MENU_DIR, f)));
  if (present.length < RUNTIME.length) return;              // not built yet

  const counts = present.map((f) => {
    const body = fs.readFileSync(path.join(MENU_DIR, f), "utf8");
    const n = body.split("\n")
      .filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;
    return [f, n];
  });
  const total = counts.reduce((a, [, n]) => a + n, 0);
  assert.ok(total <= 900,
    `picker runtime path is ${total} lines against a 900 budget:\n` +
    counts.map(([f, n]) => `  ${String(n).padStart(4)}  ${f}`).join("\n") +
    `\nThe 300 ms first-frame budget is what this bounds. Either cut, or change the ` +
    `number deliberately and say why.`);
});

test("recordStartup keeps a bounded sample set and a median", () => {
  const f = path.join(os.homedir(), ".uw", "harness", "scratch", "startup.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.rmSync(f, { force: true });
  let last;
  for (const ms of [100, 300, 200]) last = recordStartup(ms, f);
  assert.equal(last.samples.length, 3);
  assert.equal(last.median, 200);
  for (let i = 0; i < 30; i++) recordStartup(50, f);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).samples.length, 20);
});

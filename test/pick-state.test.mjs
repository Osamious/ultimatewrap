import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view, tokenize } from "../menu/pick-state.mjs";

const M = (id, badge = "") => ({ id, ctx: null, pin: null, pout: null, badge,
                                 tools: false, vision: false, reason: false,
                                 routable: null });
// NOTE on the third id: an earlier draft used `M("opus-lookalike")` here, which is
// a name Task A5.1 refuses. The reducer is pure and never calls the denylist --
// it receives Rows that buildFrom already filtered -- so the fixture was not
// broken, only misleading: it invited a reader to think a refused id can reach
// this layer. Renamed rather than kept, because a fixture that contradicts a
// security invariant is a comment that will one day be believed.
//
// Under Constraint 29 the id to picture here is `uw/fast`, not a Claude name: a
// Claude name from a reseller reaches this layer legitimately and often.
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
    models: [M("acme-chat-1", "FREE?"), M("acme-pro-1", "PAID"), M("acme-tiny-0")] },
  { keyId: "personal.zeta.paid", provider: "zeta", free: null, planCount: 0, health: "broken",
    models: [M("zeta-one"), M("zeta-two")] },
];

const drive = (s, keys) => {
  let out = { state: s, exit: null, favourite: null };
  for (const k of keys) {
    out = reduce(out.state, k);
    if (out.exit) break;
  }
  return out;
};

const ESC = "\x1b", UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", TAB = "\t";
const BS = "\x7f", CTRL_C = "\x03", CTRL_F = "\x06", QMARK = "?";

// --- tokenize (Q3.8) -------------------------------------------------------
// readSync on //./CONIN$ returns whatever is sitting in the console buffer, not
// one key. Every test below describes a chunk that arrives in real use and that
// the reducer alone would mishandle.

test("a held arrow key arrives as one chunk and moves once per repeat", () => {
  assert.deepEqual(tokenize("\x1b[A\x1b[A\x1b[B"), [UP, UP, DOWN]);
});

test("a CSI sequence is consumed up to its final byte, parameters included", () => {
  assert.deepEqual(tokenize("\x1b[1;5A"), ["\x1b[1;5A"]);      // ctrl+up
  assert.deepEqual(tokenize("\x1b[200~ab\x1b[201~"),
    ["\x1b[200~", "a", "b", "\x1b[201~"]);                      // bracketed paste
});

test("a bare ESC is one token and still walks the ladder", () => {
  assert.deepEqual(tokenize("\x1b"), [ESC]);
  assert.deepEqual(tokenize("\x1b\x1b"), [ESC, ESC]);
});

test("ordinary text splits by code point, not by code unit", () => {
  assert.deepEqual(tokenize("abc"), ["a", "b", "c"]);
  assert.deepEqual(tokenize("a\u{1F600}b"), ["a", "\u{1F600}", "b"]);
});

test("a mixed chunk yields the arrows AND the typed characters, in order", () => {
  // The defect this pins: the previous input loop tested
  // `key.length >= 3 && key[0] === ESC && key[1] === "["` against the WHOLE chunk,
  // matched the first arrow, moved one row, and discarded everything after it.
  // A two-byte chunk fell through every branch and vanished entirely.
  assert.deepEqual(tokenize("\x1b[A\x1b[A\x1b[Bx"), [UP, UP, DOWN, "x"]);
  // Needs a level-0 list longer than two rows, or the clamp -- not the tokeniser
  // -- decides the answer: bare ROWS has exactly two providers, so cur stops at
  // 1 whether one arrow arrives or ten, and the assertion could never fail.
  const s = initState(ROWS, { recents: ["zeta/zeta-two"], favourites: ["acme/acme-pro-1"] });
  let out = { state: s };
  for (const k of tokenize("\x1b[B\x1b[B")) out = reduce(out.state, k);
  assert.equal(out.state.cur[0], 2, "two down-arrows in one chunk must move two rows");
});

test("a truncated CSI at the end of a chunk is returned whole rather than dropped", () => {
  // The console can split a sequence across two reads. Emitting the fragment is
  // better than swallowing it: reduce() ignores an unrecognised key, and the
  // alternative -- buffering across iterations -- adds state to a pure function
  // for a case that costs one dropped keystroke.
  assert.deepEqual(tokenize("\x1b["), ["\x1b["]);
  assert.deepEqual(tokenize("a\x1b[1"), ["a", "\x1b[1"]);
});

test("level 0 lists providers", () => {
  const v = view(initState(ROWS));
  assert.equal(v.level, 0);
  assert.deepEqual(v.items.map((i) => i.row.keyId), ["personal.acme.free", "personal.zeta.paid"]);
});

test("level-0 filter matches the key id", () => {
  const { state } = drive(initState(ROWS), ["z", "e", "t"]);
  assert.deepEqual(view(state).items.map((i) => i.row.provider), ["zeta"]);
});

test("level-0 filter also matches member model ids", () => {
  const { state } = drive(initState(ROWS), ["t", "i", "n", "y"]);
  assert.deepEqual(view(state).items.map((i) => i.row.provider), ["acme"]);
});

test("enter descends into a provider and clears the model filter", () => {
  const { state } = drive(initState(ROWS), [ENTER]);
  const v = view(state);
  assert.equal(v.level, 1);
  assert.equal(v.provider.provider, "acme");
  assert.equal(v.filter, "");
  assert.equal(v.items.length, 3);
});

test("enter on a model exits with the /model line", () => {
  const { exit } = drive(initState(ROWS), [ENTER, DOWN, ENTER]);
  assert.deepEqual(exit, { target: "acme/acme-pro-1" });
});

test("arrows clamp at both ends without wrapping", () => {
  const a = drive(initState(ROWS), [UP, UP]);
  assert.equal(view(a.state).cursor, 0);
  const b = drive(initState(ROWS), [DOWN, DOWN, DOWN]);
  assert.equal(view(b.state).cursor, 1);
});

test("backspace pops the filter and resets the cursor", () => {
  const { state } = drive(initState(ROWS), ["z", "e", DOWN, BS]);
  assert.equal(view(state).filter, "z");
  assert.equal(view(state).cursor, 0);
});

test("the esc ladder: model level clears a filter, then goes back, then quits", () => {
  let s = initState(ROWS);
  s = reduce(s, ENTER).state;               // into acme
  s = reduce(s, "p").state;                 // model filter "p"
  assert.equal(view(s).filter, "p");
  s = reduce(s, ESC).state;                 // clears the model filter
  assert.equal(view(s).filter, "");
  assert.equal(view(s).level, 1);
  s = reduce(s, ESC).state;                 // back to providers
  assert.equal(view(s).level, 0);
  s = reduce(s, "z").state;                 // provider filter
  s = reduce(s, ESC).state;                 // clears it
  assert.equal(view(s).filter, "");
  const last = reduce(s, ESC);              // quits
  assert.deepEqual(last.exit, { target: null });
});

test("tab toggles the flat scope and searches provider/model", () => {
  let s = reduce(initState(ROWS), TAB).state;
  assert.equal(view(s).scope, "flat");
  s = drive(s, ["z", "e", "t", "a", "/", "z", "e", "t", "a", "-", "t"]).state;
  assert.deepEqual(view(s).items.map((i) => i.target), ["zeta/zeta-two"]);
  const { exit } = reduce(s, ENTER);
  assert.deepEqual(exit, { target: "zeta/zeta-two" });
});

test("esc leaves the flat scope before it quits", () => {
  let s = reduce(initState(ROWS), TAB).state;
  s = reduce(s, ESC).state;
  assert.equal(view(s).scope, "tree");
  assert.equal(view(s).level, 0);
});

test("recents and favourites are pinned at level 0 as visible duplicates", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"], favourites: ["acme/acme-pro-1"] });
  const v = view(s);
  assert.deepEqual(v.items.slice(0, 2).map((i) => i.target),
                   ["acme/acme-pro-1", "zeta/zeta-two"]);
  assert.deepEqual(v.items.slice(0, 2).map((i) => i.mark), ["*", "~"]);
  // Still present inside their provider. Three downs, not two: the two pinned
  // rows occupy indices 0 and 1, so the providers start at 2 and zeta is at 3.
  const zeta = reduce(reduce(reduce(s, DOWN).state, DOWN).state, DOWN).state;
  const inProvider = reduce(zeta, ENTER).state;
  assert.equal(view(inProvider).items.some((i) => i.model.id === "zeta-two"), true);
});

test("enter on a pinned row selects immediately, without descending", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"] });
  const { exit } = reduce(s, ENTER);
  assert.deepEqual(exit, { target: "zeta/zeta-two" });
});

test("a pinned row is filtered by its full target string", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"] });
  const { state } = drive(s, ["a", "/", "z"]);
  assert.deepEqual(view(state).items.map((i) => i.target ?? i.row.provider), ["zeta/zeta-two"]);
});

test("ctrl+f reports the focused model as a favourite toggle", () => {
  const s = reduce(initState(ROWS), ENTER).state;
  const r = reduce(s, CTRL_F);
  assert.equal(r.favourite, "acme/acme-chat-1");
  assert.equal(r.exit, null);
});

test("ctrl+f at the provider level is a no-op", () => {
  assert.equal(reduce(initState(ROWS), CTRL_F).favourite, null);
});

// `?` can be a command because MODEL_ID_OK excludes it: a filter containing `?`
// can never match any id, so the key costs the filter nothing. `f` is a different
// story -- `flash`, `flux` and `fast` all start with it -- which is why the
// favourite toggle is ctrl+f and not bare `f`.
test("? opens the legend overlay and does not enter the filter", () => {
  const r = reduce(initState(ROWS), QMARK);
  assert.equal(view(r.state).legend, true);
  assert.equal(view(r.state).filter, "");
});

test("any key closes the legend and restores the exact prior state", () => {
  const before = reduce(reduce(initState(ROWS), "z").state, "e").state;
  const opened = reduce(before, QMARK).state;
  assert.equal(view(opened).legend, true);
  const closed = reduce(opened, " ").state;
  assert.equal(view(closed).legend, false);
  assert.deepEqual(view(closed).filter, view(before).filter);
  assert.equal(view(closed).cursor, view(before).cursor);
});

test("the legend swallows the key that closes it, including enter and esc", () => {
  const opened = reduce(initState(ROWS), QMARK).state;
  assert.equal(reduce(opened, ENTER).exit, null);
  assert.equal(reduce(opened, ESC).exit, null);
  assert.equal(view(reduce(opened, ESC).state).legend, false);
});

test("an empty result set reports the query that produced it", () => {
  const v = view(drive(initState(ROWS), ["q", "q", "q"]).state);
  assert.equal(v.empty, true);
  assert.equal(v.filter, "qqq");
  assert.deepEqual(v.items, []);
});

test("ctrl+c exits without writing", () => {
  assert.deepEqual(reduce(initState(ROWS), CTRL_C).exit, { target: null });
});

test("an empty result set is reported, and enter on it does nothing", () => {
  const { state } = drive(initState(ROWS), ["q", "q", "q", "q"]);
  const v = view(state);
  assert.equal(v.empty, true);
  assert.equal(v.items.length, 0);
  assert.equal(reduce(state, ENTER).exit, null);
});

test("resize changes the window without moving the cursor", () => {
  const many = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: Array.from({ length: 40 }, (_, i) => M(`m${i}`)) }];
  let s = reduce(initState(many, { termRows: 30 }), ENTER).state;
  for (let i = 0; i < 20; i++) s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 20);
  const before = view(s).top;
  s = reduce(s, { resize: 12 }).state;
  assert.equal(view(s).cursor, 20);
  assert.notEqual(view(s).top, before);
  assert.ok(view(s).items.length <= 40);
});

test("the window keeps the cursor visible after a refilter", () => {
  const many = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: Array.from({ length: 40 }, (_, i) => M(`m${i}`)) }];
  let s = reduce(initState(many, { termRows: 30 }), ENTER).state;
  for (let i = 0; i < 30; i++) s = reduce(s, DOWN).state;
  s = reduce(s, "m").state;
  const v = view(s);
  assert.ok(v.cursor >= v.top && v.cursor < v.top + v.items.length + 1);
});

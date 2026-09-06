import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view, tokenize,
         isSelectable, nextSelectable } from "../menu/pick-state.mjs";

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

test("arrows wrap at both ends", () => {
  // Was "arrows clamp at both ends without wrapping", asserting the opposite.
  // It kept passing after the behaviour changed, for a reason worth recording:
  // ROWS has two entries, so [UP, UP] wraps 0 -> 1 -> 0 and [DOWN, DOWN, DOWN]
  // wraps 0 -> 1 -> 0 -> 1, landing on exactly the values it asserted. A
  // two-element fixture cannot tell clamping from wrapping at all -- every
  // sequence of length two or three returns to a value both behaviours produce.
  // The assertions below use single steps from a known end, which can.
  const a = drive(initState(ROWS), [UP]);
  assert.equal(view(a.state).cursor, ROWS.length - 1, "up from the top wraps to the end");
  const b = drive(initState(ROWS), [DOWN, DOWN]);
  assert.equal(view(b.state).cursor, 0, "down past the end wraps to the top");
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

// --- cursor wraparound -----------------------------------------------------

test("up from the first row wraps to the last, and down from the last wraps to the first", () => {
  // With 45 providers and model lists running to hundreds, the last row is the
  // one furthest from where the cursor starts. Without a wrap, reaching it means
  // holding a key rather than pressing one.
  let s = initState(ROWS);
  assert.equal(view(s).cursor, 0);
  s = reduce(s, UP).state;
  assert.equal(view(s).cursor, ROWS.length - 1, "up from the top must land on the last row");
  s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 0, "down from the bottom must land on the first row");
});

test("wraparound holds at the model level too", () => {
  let s = initState(ROWS);
  s = reduce(s, "\r").state;                       // descend into acme
  assert.equal(view(s).items.length, 3);
  s = reduce(s, UP).state;
  assert.equal(view(s).cursor, 2);
  s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 0);
});

test("an empty list does not wrap, and does not divide by zero", () => {
  let s = initState(ROWS);
  for (const ch of "zzzz") s = reduce(s, ch).state;
  assert.equal(view(s).items.length, 0);
  s = reduce(s, UP).state;
  assert.equal(view(s).cursor, 0);
  s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 0);
});

// --- non-chat rows: shown, dimmed, and never selected ----------------------
//
// The picker offers four rows that cannot answer a chat request under any
// configuration. They still RENDER -- the point is that enter refuses, not that
// the row disappears.

const PIC = (id) => ({ ...M(id), outputKind: "nontext" });
const CHAT = (id) => ({ ...M(id), outputKind: "text" });
// gap: a non-chat row sits BETWEEN two chat rows, so a single arrow has to cross
// exactly one and land on the far side. With the non-chat row at an end, wrapping
// and stepping produce the same index and the test cannot tell them apart.
const MIXED = [
  { keyId: "personal.mix.free", provider: "mix", free: null, planCount: 0, health: "ok",
    models: [CHAT("mix-chat-1"), PIC("mix-image-1"), CHAT("mix-chat-2")] },
];
const IMAGES = [
  { keyId: "personal.pic.free", provider: "pic", free: null, planCount: 0, health: "ok",
    models: [PIC("pic-a"), PIC("pic-b"), PIC("pic-c")] },
];

test("isSelectable blocks non-text output and nothing else", () => {
  assert.equal(isSelectable({ kind: "model", model: PIC("x") }), false);
  assert.equal(isSelectable({ kind: "model", model: CHAT("x") }), true);
  // The decided default: the catalogue said nothing, so the row stays usable. A
  // positive signal is required to take a row away.
  assert.equal(isSelectable({ kind: "model", model: { ...M("x"), outputKind: null } }), true);
  assert.equal(isSelectable({ kind: "provider", row: {} }), true);
  assert.equal(isSelectable({ kind: "pinned", target: "p/m" }), true);

  // D9: routable is NOT part of this. A stale routing measurement costs about
  // 114 rows that genuinely work, so it dims and enter still switches. Folding it
  // in here is the change this assertion exists to fail.
  assert.equal(isSelectable({ kind: "model", model: { ...CHAT("x"), routable: false } }), true);
});

test("a non-chat row is shown, not hidden", () => {
  const s = reduce(initState(MIXED), ENTER).state;
  assert.deepEqual(view(s).items.map((i) => i.model.id),
                   ["mix-chat-1", "mix-image-1", "mix-chat-2"]);
});

test("one arrow keypress moves exactly one SELECTABLE row, in both directions", () => {
  // The double-correction hazard, asserted directly. reduce computes the next
  // index and then calls clamp; if clamp's pull were written as "advance to the
  // next selectable" rather than "if not selectable, advance", a single press
  // would step over mix-image-1 here and then step again, landing back on
  // mix-chat-1 by way of the wrap. A test that only checks the cursor ended
  // somewhere selectable cannot see that at all.
  let s = reduce(initState(MIXED), ENTER).state;
  assert.equal(view(s).cursor, 0);
  s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 2, "down crosses the image row in one press");
  s = reduce(s, UP).state;
  assert.equal(view(s).cursor, 0, "and up crosses it back, once");
  // Wrapping still works across the skip.
  s = reduce(reduce(s, DOWN).state, DOWN).state;
  assert.equal(view(s).cursor, 0, "down from the last selectable wraps to the first");
});

test("enter on a non-chat row changes nothing, and ctrl+f refuses to pin it", () => {
  let s = reduce(initState(MIXED), ENTER).state;
  // Reach it by FILTER rather than by arrow -- the arrows step over it, so this
  // is the path that still lands the cursor on one.
  for (const ch of "image") s = reduce(s, ch).state;
  assert.equal(view(s).items.length, 1);
  assert.equal(view(s).items[0].model.id, "mix-image-1");

  const entered = reduce(s, ENTER);
  assert.equal(entered.exit, null);
  assert.equal(entered.state, s, "the state must be unchanged, not merely equivalent");
  assert.equal(reduce(s, CTRL_F).favourite, null,
    "a favourite is a target to switch to later; pinning one defers the refusal");
});

test("the viewport follows the corrected cursor, not the pre-correction one", () => {
  // clamp derives `top` FROM `cur`, so the pull to a selectable row has to happen
  // BEFORE that arithmetic. Settle afterwards and the window is computed around
  // the row the cursor was on, leaving the marker drawn outside the visible slice.
  //
  // The shape matters, and the obvious one does not work: on the arrow path
  // nextSelectable has already landed on a selectable index, so clamp's settle is
  // a no-op and the ordering is unobservable. The path that exercises it is the
  // one that hands clamp an UNSETTLED cursor -- reset() sets cur and top to 0 on
  // every filter change -- and the correction only crosses a viewport boundary if
  // the run of unselectable rows at the head is longer than the window. Ten
  // image rows against a six-row window is that shape.
  const models = Array.from({ length: 30 },
    (_, i) => (i < 10 ? PIC(`m${i}`) : CHAT(`m${i}`)));
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok", models }];
  let s = reduce(initState(rows, { termRows: 12 }), ENTER).state;
  s = reduce(s, "m").state;                    // matches all 30; reset then clamp
  const v = view(s);
  assert.equal(v.cursor, 10, "the cursor clears the leading image rows");
  assert.ok(v.cursor >= v.top && v.cursor < v.top + v.items.length,
    `cursor ${v.cursor} outside window [${v.top}, ${v.top + v.items.length})`);
  assert.equal(isSelectable(v.items[v.cursor - v.top]), true,
    "the row under the marker must be one enter can act on");
});

test("a list with nothing selectable terminates and leaves the cursor put", () => {
  // Reachable today: filtering `flux` in flat scope leaves 5 rows, every one of
  // them output ["image"]. Without the bound in nextSelectable this is an
  // unbounded loop inside a blocking readSync on //./CONIN$, with no event loop
  // to interrupt it and no way to kill it from the keyboard.
  assert.equal(nextSelectable([], 0, 1), 0);
  const all = [{ kind: "model", model: PIC("a") }, { kind: "model", model: PIC("b") }];
  assert.equal(nextSelectable(all, 0, 1), 0);
  assert.equal(nextSelectable(all, 1, -1), 1);

  let s = reduce(initState(IMAGES), ENTER).state;
  assert.equal(view(s).items.length, 3);
  s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 0);
  s = reduce(s, UP).state;
  assert.equal(view(s).cursor, 0);
  assert.equal(reduce(s, ENTER).exit, null);
});

test("clamp's settle takes the NEAREST selectable row and never wraps", () => {
  // The invariant the arrow comment states -- "a filter that shortens the list
  // must not teleport the cursor to the far end" -- asserted at the place that
  // enforces it. clamp() runs on resize, on the scope toggle and after every
  // filter edit; only an arrow press means "move", so only an arrow press may
  // wrap. A wrapping settle here sends a cursor near the END of the list all the
  // way back to index 0, moving it BACKWARDS over every selectable row between.
  //
  // WHITE-BOX ON PURPOSE, and the reason is worth stating so nobody "simplifies"
  // it into a keystroke sequence. Through the public key API the two settles are
  // today indistinguishable: the filter path is `clamp(reset(...))`, so the
  // cursor is already 0 before settle sees it, and every other clamp call site
  // inherits a cursor a previous clamp already settled. Reaching the branch
  // therefore means handing clamp a cursor parked on an unselectable index --
  // which is precisely the state a future list-shortening edit would produce.
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: [CHAT("b0"), CHAT("b1"), CHAT("b2"), CHAT("b3"), PIC("bimg")] }];
  const s = reduce(initState(rows), ENTER).state;
  const parked = { ...s, cur: [s.cur[0], 4, s.cur[2]] };        // on the non-chat tail
  const after = reduce(parked, { resize: 30 }).state;
  assert.equal(view(after).cursor, 3,
    "the cursor settles onto the adjacent selectable row, not across the whole list");
  assert.ok(view(after).cursor <= 4,
    "settling must never move the cursor UP past selectable rows");

  // Forward is still preferred when a selectable row lies ahead, which is what
  // keeps the viewport test above (leading non-chat rows) reading downward.
  const lead = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: [PIC("c0"), PIC("c1"), CHAT("c2")] }];
  const l = reduce(initState(lead), ENTER).state;
  assert.equal(view(l).cursor, 2, "from index 0 it scans forward, not backward");

  // And the all-unselectable list still terminates rather than spinning.
  const t = reduce(initState(IMAGES), ENTER).state;
  assert.equal(view(reduce(t, { resize: 30 }).state).cursor, 0);
});

test("a recents entry naming a non-chat model produces no pinned row", () => {
  // The pinned path, which is the one that affects existing users: pins are
  // persisted target STRINGS with no model object, so isSelectable reads them as
  // selectable by construction and enter on one still switched. Anyone who has
  // ever selected an image model has it in recents.
  //
  // The row itself is still in the tree below, dimmed -- what is dropped is a
  // duplicate shortcut whose only possible action is refusal.
  const s = initState(MIXED, { recents: ["mix/mix-image-1", "mix/mix-chat-2"],
                               favourites: ["mix/mix-image-1"] });
  assert.deepEqual(s.pinned.map((p) => p.target), ["mix/mix-chat-2"]);
  const v = view(s);
  assert.deepEqual(v.items.map((i) => i.target ?? i.row.provider),
                   ["mix/mix-chat-2", "mix"]);
  assert.deepEqual(reduce(s, ENTER).exit, { target: "mix/mix-chat-2" },
    "a chat-model pin must still select immediately");
});

test("a filter that shortens the list pins the cursor rather than wrapping it", () => {
  // Why the wrap lives in the arrow branch and not in clamp(). clamp also runs on
  // a filter change, a favourite toggle and a resize; there the correct move is to
  // pin the cursor inside the new list. If clamp wrapped, typing a character that
  // shortened the list under the cursor would teleport the selection to the far
  // end -- a filter would move the thing the user is aiming at.
  let s = initState(ROWS);
  s = reduce(s, DOWN).state;                       // cursor on zeta, index 1
  assert.equal(view(s).cursor, 1);
  for (const ch of "acme") s = reduce(s, ch).state; // one match, index 0 only
  assert.equal(view(s).items.length, 1);
  assert.equal(view(s).cursor, 0, "clamped to the new end, not wrapped past it");
});

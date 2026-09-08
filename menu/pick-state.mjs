// The two-level menu, as a pure reducer.
//
// Split out of the renderer for one reason: under CC's ctrl+g handoff the child
// has no usable stdin, so the interactive surface cannot be driven by a test
// harness. Keeping every decision here -- filtering, cursor, scope, the Esc
// ladder -- means the behaviour is testable by feeding it strings, and the
// renderer left behind is a formatter with no logic to get wrong.

const asTarget = (providerName, modelId) => `${providerName}/${modelId}`;

/**
 * Whether enter on this item can do anything.
 *
 * `false` for exactly one thing: a model whose output is measurably not text. It
 * cannot answer a chat request under any configuration, so offering it is
 * offering an error. `outputKind: null` -- the catalogue said nothing -- stays
 * selectable, because a positive signal is required to take a row away.
 *
 * `routable === false` is DELIBERATELY not here, and the omission has to be said
 * out loud because style.mjs dims both classes and the asymmetry then reads as an
 * oversight. Block only when selection cannot possibly succeed; dim when it
 * might. Non-text output is a fact about the model. Routability is a measurement
 * of a gateway configuration at one moment, and a stale one costs about 114 rows
 * that genuinely work -- so it dims, and enter still switches.
 */
export function isSelectable(item) {
  return !(item?.kind === "model" && item.model?.outputKind === "nontext");
}

/**
 * The nearest selectable index from `from` in `dir`, wrapping.
 *
 * Returns `from` when NOTHING in the list is selectable, and that guard is the
 * whole reason this is a function. It is reachable: filtering `flux` in flat
 * scope leaves 5 rows, every one of them `output: ["image"]`. Without the bound
 * this is an unbounded loop inside a blocking readSync on //./CONIN$, which has
 * no event loop to interrupt it and cannot be killed from the keyboard.
 *
 * `k < n` is that bound and it is the ONLY one needed: an empty list runs the
 * body zero times and falls straight to `return from`, so a separate length
 * check would be a guard that can never fire.
 */
export function nextSelectable(list, from, dir) {
  const n = list.length;
  let i = from;
  for (let k = 0; k < n; k++) {
    i = (i + dir + n) % n;
    if (isSelectable(list[i])) return i;
  }
  return from;
}

// "If the cursor is not on a selectable row, advance to the NEAREST one." Forward
// first, then backward, and DELIBERATELY NOT WRAPPING -- this is the whole
// difference from nextSelectable, whose wrap belongs to the arrow path alone.
//
// WHERE AN UNSETTLED CURSOR ACTUALLY REACHES clamp(), corrected 2026-09-06.
// A review reported this as a filter-keystroke teleport; that repro was wrong and
// the wrong version was briefly written here. The filter path is
// `clamp(reset(...))` (three call sites), and reset() zeroes `cur` before clamp
// ever sees it, so a filter can neither preserve a cursor nor wrap one.
//
// The paths that DO hand clamp a preserved cursor over a changed list take no
// reset: resize, the scope toggle, and the two esc steps (flat->tree, level 1->0).
// Each keeps `cur` while the list under it changes, so the cursor can land on an
// unselectable row -- and a wrap there jumps to the far end, which is exactly what
// the arrow comment below forbids: "a filter that shortens the list must not
// teleport the cursor to the far end. Only an explicit arrow press means 'move',
// so only an arrow press may wrap." This is where that is enforced.
//
// The backward scan is the fallback for the case the wrap was silently covering:
// nothing selectable at or after `i`.
//
// Idempotent on an already-selectable index by construction, which is what lets
// clamp() run on the arrow path without correcting a second time and moving two
// rows per keypress. Both loops are bounded by the list, so an all-unselectable
// list falls through to `return i` rather than spinning -- the same termination
// guard nextSelectable's `k < n` provides, and reachable for the same reason
// (filtering `flux` leaves 5 rows, every one of them `output: ["image"]`).
const settle = (list, i) => {
  if (isSelectable(list[i])) return i;
  for (let j = i + 1; j < list.length; j++) if (isSelectable(list[j])) return j;
  for (let j = i - 1; j >= 0; j--) if (isSelectable(list[j])) return j;
  return i;
};

export function initState(rows, { recents = [], favourites = [], termRows = 30 } = {}) {
  const known = new Set();
  // Built from SELECTABLE models only, which is where the pinned path is handled.
  // A pin is a persisted target STRING -- state.mjs returns nothing else -- so
  // initState builds it into a row with no `model` object at all, and isSelectable
  // reads it as selectable by construction. Anyone who ever selected
  // nscale/flux.1-schnell has it in recents, and enter on that pin still switched.
  //
  // This is a hide, under a principle that says show and never hide, so: the row
  // itself still renders in the tree, dimmed. What is dropped is a DUPLICATE
  // SHORTCUT to a row that is already visible and already refuses. A pin whose
  // only possible action is refusal is not information, it is a dead control --
  // and the filter two lines below already establishes exactly this rule for a
  // pin naming a model the catalogue dropped.
  for (const r of rows) for (const m of r.models) {
    if (isSelectable({ kind: "model", model: m })) known.add(asTarget(r.provider, m.id));
  }
  // Display cap, distinct from `MAX_RECENTS` (`state.mjs`, storage cap = 10).
  // MEASURED live: 10 stored recents, 0 favourites, 9 rendering after the
  // `known` filter above, and `rowsAvail` = 24 on a 30-row terminal -- the
  // pinned block was consuming 37% of the pane. At 5 it consumes 21%. Now
  // strictly the smaller of the two, so it is the only bound that ever limits
  // what renders; `MAX_RECENTS` can be read at `state.mjs` without implying it
  // is also the display count.
  const MAX_RECENTS_SHOWN = 5;
  // Favourites first, then recents, both filtered to targets that still exist.
  // A pinned row naming a model the catalogue dropped would be a dead selection.
  // Capped AFTER the favourite exclusion, not before -- a recent that is also a
  // favourite must not consume one of the five slots while rendering zero rows
  // under its own mark.
  const knownRecents = recents.filter((t) => known.has(t) && !favourites.includes(t));
  const shownRecents = knownRecents.slice(0, MAX_RECENTS_SHOWN);
  const pinned = [
    ...favourites.filter((t) => known.has(t)).map((target) => ({ kind: "pinned", target, mark: "*" })),
    ...shownRecents.map((target) => ({ kind: "pinned", target, mark: "~" })),
  ];
  return {
    rows, pinned,
    // #60: the cap is a hiding action and must disclose itself, the same
    // principle §2.5 already applies to a withheld model -- storage
    // (`recordRecent`, newest-first) still holds every entry this drops, so
    // `recentsHidden` is what lets style.mjs render "... N more" rather than
    // silently rendering fewer rows than the user remembers saving.
    recentsHidden: knownRecents.length - shownRecents.length,
    level: 0, scope: "tree", legend: false,
    q: ["", "", ""], cur: [0, 0, 0], top: [0, 0, 0],
    provider: null, termRows,
    // #51 (§2.5(b)/(c)), R18: null when closed, otherwise
    // `{ provider: <keyId>, top: <scroll offset> }` for the drill-in overlay.
    refusals: null,
  };
}

// Index into q/cur/top. Flat scope is its own slot so toggling back to the tree
// restores the filters the user had typed there.
const slot = (s) => (s.scope === "flat" ? 2 : s.level);

// R18's worst case, not the tree view's own 5: level 0's fixed chrome (title,
// meta bar, blank, column header, footer = 5) can carry TWO conditional
// lines at once -- the pre-existing bottom overflow ("... N more") and the
// new #60 recents-disclosure ("... N more recents") -- and the refusals
// overlay's own chrome (title, meta bar, blank, column header, blank, "any
// key closes", footer) is 7 fixed lines on its own. Both are shared against
// this ONE budget (the overlay's paging in `view()` and its arrow-scroll
// clamp below reuse it rather than inventing a second constant), so it must
// reserve for the more demanding of the two. MEASURED: at the old `- 6`,
// a provider that both fills the viewport AND withholds something rendered
// one line taller than the terminal (R16's forwarded bug); separately, the
// live vault's own default state (10 stored recents, 0 favourites) overflows
// level 0's first frame by exactly one line, on every launch. `- 7` costs one
// spare, harmless row in the common case (neither conditional line present,
// or the overlay's page short of a full screen) and is exact at both worst
// cases.
//
// The `Math.max(3, ...)` FLOOR is a separate, pre-existing tradeoff, restated
// here rather than left implicit now that the divisor changed: below a
// termRows of 10, this guarantees at least 3 visible rows -- never a
// zero-row pane -- at the cost of the overlay's 7-line chrome (7 + 3 = 10)
// exceeding an extremely small terminal. This is not new to this change: the
// original `- 6` already overflowed the tree/flat chrome (6 + 3 = 9) below a
// termRows of 9. Usable-with-a-floor beats correctly-sized-and-empty; a
// terminal shorter than 10 rows is far outside this product's stated target
// and is accepted, disclosed tradeoff rather than a silently broken one.
const rowsAvail = (s) => Math.max(3, (s.termRows || 30) - 7);

function flatItems(s) {
  const out = [];
  for (const r of s.rows) {
    for (const m of r.models) {
      out.push({ kind: "model", model: m, row: r, target: asTarget(r.provider, m.id) });
    }
  }
  return out;
}

function items(s) {
  const needle = s.q[slot(s)].toLowerCase();
  const has = (hay) => !needle || String(hay).toLowerCase().includes(needle);

  if (s.scope === "flat") return flatItems(s).filter((i) => has(i.target));

  if (s.level === 1) {
    const modelItems = s.provider.models
      .filter((m) => has(m.id))
      .map((m) => ({ kind: "model", model: m, row: s.provider,
                     target: asTarget(s.provider.provider, m.id) }));
    // #51 (§2.5(b), revision 11): a second door onto the ctrl+r overlay, placed
    // FIRST so it sits above every model row. It is not a model row -- it has
    // no id to match against a query -- so it never enters the filter's match
    // set: present only while nothing is filtering (hiding it while a query
    // narrows the models below is fine; a query MATCHING it as though it were
    // a model id would be the defect §2.5(b) names).
    const withheldCount = s.provider.refused?.length ?? 0;
    if (!needle && withheldCount > 0) {
      return [{ kind: "withheld-list", count: withheldCount }, ...modelItems];
    }
    return modelItems;
  }

  // Level 0. The filter matches member model ids too, so typing "opus" finds the
  // provider that SERVES it -- this is what makes two levels tolerable when you
  // already know the model name.
  const provs = s.rows
    .filter((r) => has(r.keyId) || r.models.some((m) => has(m.id)))
    .map((row) => ({ kind: "provider", row }));
  const pins = s.pinned.filter((p) => has(p.target));
  return [...pins, ...provs];
}

function clamp(s) {
  const list = items(s);
  const avail = rowsAvail(s);
  const i = slot(s);
  const cur = [...s.cur], top = [...s.top];
  cur[i] = Math.min(Math.max(0, cur[i]), Math.max(0, list.length - 1));
  // BEFORE the viewport arithmetic, not after. The three lines below derive `top`
  // FROM `cur`; settling afterwards computes the window around the row the cursor
  // was on rather than the one it ended on, and the screen scrolls to a row the
  // marker is not drawn on. This is also the only place reset() needs -- every
  // reset() call site is `clamp(reset(...))`, so a second settle there would be
  // unreachable code.
  cur[i] = settle(list, cur[i]);
  if (cur[i] < top[i]) top[i] = cur[i];
  if (cur[i] >= top[i] + avail) top[i] = cur[i] - avail + 1;
  top[i] = Math.max(0, Math.min(top[i], Math.max(0, list.length - avail)));
  return { ...s, cur, top };
}

const reset = (s) => {
  const i = slot(s);
  const cur = [...s.cur], top = [...s.top];
  cur[i] = 0; top[i] = 0;
  return { ...s, cur, top };
};

const NONE = { exit: null, favourite: null };

/**
 * Split one raw console read into individual keys (Q3.8).
 *
 * `readSync` on `//./CONIN$` hands back the whole console buffer, so this is not
 * an edge case: holding an arrow key delivers `ESC[A ESC[A ESC[A` in one chunk,
 * and a paste delivers a run of characters. `reduce` takes one key; feeding it a
 * chunk makes it match the first arrow, move one row, and discard the rest.
 *
 * This lives here, in the pure module, rather than inline in uwpick's loop, for
 * one reason: the defect is invisible to single-key fixtures, which is exactly
 * what the reducer's tests were. A tokeniser with its own multi-key tests is the
 * only version of this that a test can fail on.
 */
export function tokenize(chunk) {
  const s = String(chunk ?? "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      // CSI: ESC [ , parameter bytes 0x30-0x3f, intermediate 0x20-0x2f, final 0x40-0x7e.
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
      if (j < s.length && s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e) j++;
      out.push(s.slice(i, j));      // truncated tail is emitted whole; reduce ignores it
      i = j;
      continue;
    }
    // One code point, not one code unit: a surrogate pair must not be split, or
    // reduce sees two lone surrogates and appends two junk characters to the filter.
    const cp = String.fromCodePoint(s.codePointAt(i));
    out.push(cp);
    i += cp.length;
  }
  return out;
}

export function reduce(state, ev) {
  if (ev && typeof ev === "object" && Number.isFinite(ev.resize)) {
    let next = clamp({ ...state, termRows: ev.resize });
    // `clamp()` only re-derives the main list's `top`. Left alone, a resize
    // while the overlay is open (L1) can leave `refusals.top` scrolled past
    // the new, smaller max -- the page then starts mid-list with room to
    // show everything, and the very next single-row scroll press jumps `top`
    // back to a sane value in one keystroke, which reads as the overlay
    // teleporting rather than resizing.
    if (next.refusals) {
      const providerRow = next.rows.find((r) => r.keyId === next.refusals.provider);
      const total = providerRow?.refused?.length ?? 0;
      const maxTop = Math.max(0, total - rowsAvail(next));
      const top = Math.max(0, Math.min(next.refusals.top, maxTop));
      next = { ...next, refusals: { ...next.refusals, top } };
    }
    return { ...NONE, state: next };
  }
  const key = String(ev ?? "");
  const c0 = key.charCodeAt(0);
  const i = slot(state);
  const list = items(state);
  const focused = list[state.cur[i]] ?? null;

  if (c0 === 3) return { ...NONE, state, exit: { target: null } };               // ctrl+c

  // REFUSALS OVERLAY -- the pinned dispatch position (H1/L14): after the ctrl+c
  // check, before both the legend branch and the esc ladder. Placed after
  // legend, `?` would stack a second modal; placed after the esc ladder, esc
  // would fall through and clear the filter instead of closing this one.
  // What is reused from legend is the POSITION in the dispatch chain, not the
  // grammar: legend swallows every key including arrows in one branch; this is
  // a two-branch rule -- arrows scroll, everything else closes -- because a
  // modal with scrollable content establishes no precedent for eating the keys
  // that would scroll it.
  if (state.refusals) {
    // Any CSI sequence is arrow-SHAPED input, not a "close" instruction.
    // Left/Right/Home/End/PgUp/PgDn are silent no-ops everywhere else in this
    // picker -- the ordinary arrow handler below matches the same CSI prefix
    // and only acts on an `A`/`B` final, leaving every other final to fall
    // through to an unchanged `clamp()`. Closing the overlay on one of those
    // by accident would make it the one place that convention breaks (L2).
    if (key.length >= 3 && c0 === 27 && key[1] === "[") {
      if (key[2] === "A" || key[2] === "B") {
        const providerRow = state.rows.find((r) => r.keyId === state.refusals.provider);
        const total = providerRow?.refused?.length ?? 0;
        const avail = rowsAvail(state);
        const top = key[2] === "A"
          ? Math.max(0, state.refusals.top - 1)
          : Math.min(Math.max(0, total - avail), state.refusals.top + 1);
        return { ...NONE, state: { ...state, refusals: { ...state.refusals, top } } };
      }
      return { ...NONE, state };                        // other CSI finals: no-op, stays open
    }
    return { ...NONE, state: { ...state, refusals: null } };
  }

  // The legend is modal and swallows exactly one key, including enter and esc.
  // Swallowing is the point: a user who opens it to find out what esc does should
  // not have esc quit the picker on the way out.
  if (state.legend) return { ...NONE, state: { ...state, legend: false } };
  if (key === "?") return { ...NONE, state: { ...state, legend: true } };      // Q3.6

  if (key === "\t") {                                                          // scope toggle
    return { ...NONE, state: clamp({ ...state, scope: state.scope === "flat" ? "tree" : "flat" }) };
  }

  if (c0 === 18 && state.scope !== "flat") {                                 // ctrl+r
    // Reachable from BOTH levels (H3): at level 0 for the FOCUSED provider
    // under the cursor, and at level 1 for the provider being viewed
    // (`state.provider` -- already in hand, set on descent). A user who
    // notices models missing is looking at that provider's own model list,
    // not the provider index, so restricting this to level 0 would answer
    // the wrong half of the question. No-op wherever the refused count is
    // zero (including a pinned/recent row at level 0, which carries no
    // provider), so an empty overlay can never open.
    const providerRow = state.level === 0
      ? (focused?.kind === "provider" ? focused.row : null)
      : state.provider;
    if (!providerRow || (providerRow.refused?.length ?? 0) === 0) return { ...NONE, state };
    return { ...NONE, state: { ...state, refusals: { provider: providerRow.keyId, top: 0 } } };
  }

  if (c0 === 6 && focused?.kind === "model") {                                // ctrl+f
    // A favourite is a target the user intends to switch to later, so pinning one
    // that enter will refuse just moves the refusal into the future.
    if (!isSelectable(focused)) return { ...NONE, state };
    return { ...NONE, state, favourite: focused.target };
  }

  if (key.length >= 3 && c0 === 27 && key[1] === "[") {                        // arrows
    // Wrap at both ends. With 45 providers and lists running to hundreds of
    // models, the last row is the one furthest from the cursor's start, and
    // holding up to reach it is the difference between one key and a hundred.
    //
    // The wrap is HERE and not in clamp() deliberately. clamp also runs when the
    // filter changes, when a favourite is toggled and on resize, and there the
    // right behaviour is to pin the cursor inside the new list -- a filter that
    // shortens the list must not teleport the cursor to the far end. Only an
    // explicit arrow press means "move", so only an arrow press may wrap.
    //
    // nextSelectable rather than a bare +/-1: it steps over non-chat rows and
    // carries the wrap, so ONE keypress moves exactly one SELECTABLE row. The
    // clamp below then finds an already-selectable index and leaves it alone --
    // that idempotence is the whole reason `settle` is written as "if not
    // selectable, advance" rather than "advance to the next selectable". Written
    // the other way, a single arrow steps past the non-chat row here and then
    // steps again in clamp, and the cursor moves two rows per press.
    const cur = [...state.cur];
    const n = list.length;
    if (n > 0) {
      if (key[2] === "A") cur[i] = nextSelectable(list, cur[i], -1);
      if (key[2] === "B") cur[i] = nextSelectable(list, cur[i], +1);
    }
    return { ...NONE, state: clamp({ ...state, cur }) };
  }

  if (key.length === 1 && c0 === 27) {                                         // esc ladder
    if (state.q[i]) {
      const q = [...state.q]; q[i] = "";
      return { ...NONE, state: clamp(reset({ ...state, q })) };
    }
    if (state.scope === "flat") return { ...NONE, state: clamp({ ...state, scope: "tree" }) };
    if (state.level === 1) return { ...NONE, state: clamp({ ...state, level: 0, provider: null }) };
    return { ...NONE, state, exit: { target: null } };
  }

  if (c0 === 13 || c0 === 10) {                                                // enter
    if (!focused) return { ...NONE, state };
    // Revision 11: the WITHHELD LIST row is a second DOOR onto the same
    // overlay ctrl+r opens, not a second mechanism -- it sets the identical
    // `state.refusals` shape for the provider already being viewed.
    if (focused.kind === "withheld-list") {
      return { ...NONE, state: { ...state, refusals: { provider: state.provider.keyId, top: 0 } } };
    }
    if (focused.kind === "provider") {
      const q = [...state.q], cur = [...state.cur], top = [...state.top];
      q[1] = ""; cur[1] = 0; top[1] = 0;
      return { ...NONE, state: clamp({ ...state, level: 1, provider: focused.row, q, cur, top }) };
    }
    // Refuse rather than switch. The row is reachable here even with the arrows
    // stepping over it: a filter can land the cursor on one, and the pinned path
    // could still carry an old target. Returning `state` unchanged makes the
    // refusal silent and cheap, which is right -- the row is already dimmed and
    // already labelled, so the screen has said why before the key was pressed.
    if (!isSelectable(focused)) return { ...NONE, state };
    return { ...NONE, state, exit: { target: focused.target } };
  }

  if (c0 === 127 || c0 === 8) {                                                // backspace
    const q = [...state.q]; q[i] = q[i].slice(0, -1);
    return { ...NONE, state: clamp(reset({ ...state, q })) };
  }

  if (key.length === 1 && c0 >= 32 && c0 <= 126) {                             // live filter
    const q = [...state.q]; q[i] = q[i] + key;
    return { ...NONE, state: clamp(reset({ ...state, q })) };
  }

  return { ...NONE, state };
}

export function view(state) {
  const i = slot(state);
  const all = items(state);
  const avail = rowsAvail(state);
  const shown = all.slice(state.top[i], state.top[i] + avail);
  // The one projection this task adds, beside `legend`: `refusals` resolved
  // from the reducer's minimal `{provider, top}` into what style.mjs actually
  // renders -- the page of `refused[]` entries the current scroll offset
  // names, and the total the same paging arithmetic (`rowsAvail`) uses for
  // the arrow-scroll clamp above, so the two can never disagree about how
  // many rows a page holds.
  let refusals = null;
  if (state.refusals) {
    const providerRow = state.rows.find((r) => r.keyId === state.refusals.provider);
    const list = providerRow?.refused ?? [];
    const top = state.refusals.top;
    refusals = { provider: state.refusals.provider, top,
                 items: list.slice(top, top + avail), total: list.length };
  }
  return {
    level: state.level, scope: state.scope, filter: state.q[i], legend: state.legend,
    items: shown, cursor: state.cur[i], top: state.top[i],
    empty: all.length === 0, provider: state.provider,
    more: Math.max(0, all.length - (state.top[i] + shown.length)),
    recentsHidden: state.recentsHidden ?? 0,
    refusals,
  };
}

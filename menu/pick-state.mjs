// The two-level menu, as a pure reducer.
//
// Split out of the renderer for one reason: under CC's ctrl+g handoff the child
// has no usable stdin, so the interactive surface cannot be driven by a test
// harness. Keeping every decision here -- filtering, cursor, scope, the Esc
// ladder -- means the behaviour is testable by feeding it strings, and the
// renderer left behind is a formatter with no logic to get wrong.
//
// The ONE import, and it is content rather than rendering: the legend scrolls,
// so the reducer must know how many lines it has to clamp against. `legend.mjs`
// imports nothing itself -- it takes the glyph renderers as arguments -- so this
// cannot become a cycle back through `style.mjs`.
import { LEGEND_LENGTH } from "./legend.mjs";
// Light (fs + two tiny modules), already in the picker's graph via snapshot.mjs. The
// reducer needs the ONE definition of "fresh ok" so the filter and the header agree.
import { isOk, isGone, isUsable, outdatedNotice, oldestAgeOf } from "./bench-data.mjs";
import { liveAlias } from "./route-hints.mjs";

const asTarget = (providerName, modelId) => `${providerName}/${modelId}`;

/**
 * The 1M-context filter's rule. `ctx >= 1,000,000` alone is not enough: measured on
 * the real snapshot, 1,062 ids carry a `[1m]` tag and one of them
 * (`teamorouter/kimi-k3[1M]`) has a null ctx, while two ids reach 1M without the
 * tag. The tag is how the router is asked for the long window, so either signal
 * counts (and the tag is matched case-insensitively, as `bench-data` does).
 */
export const isOneM = (m) => (Number.isFinite(m?.ctx) && m.ctx >= 1_000_000) || /\[1m\]$/i.test(String(m?.id ?? ""));

// `gone` per target, memoised the same way as `ok` (the hide-gone toggle asks it for every row of a list).
const goneCache = new WeakMap();
function goneOf(s) {
  if (typeof s.benchOf !== "function") return () => false;
  let byNow = goneCache.get(s.benchOf);
  if (!byNow) goneCache.set(s.benchOf, byNow = new Map());
  let memo = byNow.get(s.now);
  if (!memo) byNow.set(s.now, memo = new Map());
  return (target) => {
    let v = memo.get(target);
    if (v === undefined) memo.set(target, v = isGone(s.benchOf(target), s.now));
    return v;
  };
}

// `ok` per target, computed once per (reader, clock): flat scope filters ~6,000 rows on
// every keystroke and each lookup cleans a record, so an unmemoised filter is ~100 ms a key.
const okCache = new WeakMap();
function okOf(s) {
  if (typeof s.benchOf !== "function") return () => false;
  let byNow = okCache.get(s.benchOf);
  if (!byNow) okCache.set(s.benchOf, byNow = new Map());
  let memo = byNow.get(s.now);
  if (!memo) byNow.set(s.now, memo = new Map());
  return (target) => {
    let v = memo.get(target);
    if (v === undefined) memo.set(target, v = isOk(s.benchOf(target), s.now));
    return v;
  };
}

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

// The session's view toggles and their defaults: ONE list, read by `initState` and by `carryAcrossRebuild`, so a new toggle
// added here is carried across a rebuild without anyone remembering to.
export const TOGGLE_DEFAULTS = Object.freeze({ okOnly: false, oneM: false, hideGone: false, freeOnly: false });
// What the bench reader loaded into the state (see `reduce`'s `{ benchOf }` event): not derived from the snapshot rows.
export const BENCH_FIELDS = Object.freeze(["benchOf", "benchOldestAt", "benchHist"]);

/**
 * A rebuilt state (`initState` after a favourite was toggled) with what the session had accumulated carried over: every
 * view toggle and the loaded bench reader with its stamp and histograms. Everything else (cursor, filters, level) restarts
 * as `initState` made it.
 */
export function carryAcrossRebuild(oldState, newState) {
  const out = { ...newState };
  for (const k of [...Object.keys(TOGGLE_DEFAULTS), ...BENCH_FIELDS]) out[k] = oldState[k];
  return out;
}

export function initState(rows, { recents = [], favourites = [], termRows = 30, nowMs = Date.now(), benchOldestAt = null } = {}) {
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
    // `null` closed, `{ top }` open -- the same nullable-object shape
    // `refusals` uses, now that the legend scrolls too. `view()` still projects
    // a BOOLEAN `legend` for the renderer and its tests, with the offset beside
    // it as `legendTop`, so nothing downstream has to learn the new shape.
    level: 0, scope: "tree", legend: null,
    // #114, MODEL LEVEL ONLY (level 1 and flat scope): two independent view filters that
    // AND with each other and with the typed filter. They PERSIST across levels and
    // scope for the whole session (unlike the typed filter, which is per level): they are
    // a view preference, and the header chips keep them visible. Plain booleans.
    ...TOGGLE_DEFAULTS,
    // The lazily loaded bench reader (`loadBench().get`), handed in by uwpick as an event
    // `{ benchOf }` the first time a model screen is drawn, so the reducer does no I/O. `now`
    // is fixed at init so "fresh" cannot change under a session.
    benchOf: null, now: nowMs,
    // The stamp (ISO) of the OLDEST bench record among the listed routes: the snapshot's until bench.json is loaded (then the
    // live one replaces it). The outdated notice's line is counted in the page size below, so the reducer must know it.
    benchOldestAt: typeof benchOldestAt === "string" ? benchOldestAt : null,
    // The per-provider age histograms from the loaded bench.json (`Map<keyId, [[epochHour, count], ...]>`); null until then, and the
    // rows' own baked `benchAgeHist` (the snapshot's) is read instead. Once loaded, bench.json wins.
    benchHist: null,
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
// The `Math.max(1, ...)` FLOOR is a separate tradeoff. A list screen is 6 fixed lines (title, filter,
// blank, column header, the full-id line, footer), plus one `extra` line (the model level's `reply:`
// line, or the rule under the pinned strip at level 0), plus the rows, plus up to two conditional
// lines ("... N more" and "... N more recents"). With a floor of ONE row a list screen fits a
// 10-row terminal in its worst case (6 + 1 + 1 + 2 = 10); the refusals overlay is 7 fixed lines
// (7 + 1 = 8). Below 10 rows the frame overflows by design: never a zero-row pane beats
// correctly-sized-and-empty, and a terminal that short is far outside this product's stated target.
// #114: 8, not 7 -- the FULL ID line (the selected row's unelided id, one line above the footer)
// is always present on a list screen and costs one row. The renderer reads the page size from
// `view().legendAvail` and the reducer clamps against this same function, so they cannot disagree.
// `extra`: the lines a list screen spends OUTSIDE the rows and the six fixed ones -- the model level's
// `reply:` line, and the rule under the pinned strip at level 0. Both renderer and reducer read the
// page size from here, so they cannot disagree.
// The outdated notice (a dedicated line above the footer) costs one more line on every LIST screen while it is showing. The
// legend and the withheld overlay are modals that do not draw it, so it costs them nothing.
// The age histogram of one provider row: the loaded bench.json's once it is in, else the snapshot's baked one (`undefined`
// when neither exists: no bench data, so nothing to say about its age).
const histOfRow = (s, r) => (s.benchHist ? (s.benchHist.get(r.keyId) ?? []) : r.benchAgeHist);
// `YYYY-MM-DD` when MORE than half of all the records are over 7 days old (the date is the OLDEST record's), else null.
const noticeDate = (s) => outdatedNotice(s.benchOldestAt, s.rows.map((r) => histOfRow(s, r)), s.now);
const extraLines = (s) => ((s.scope === "flat" || s.level === 1) ? 1
  : (s.pinned?.length > 0 ? 1 : 0)) + (!s.legend && !s.refusals && noticeDate(s) ? 1 : 0);
const rowsAvail = (s) => Math.max(1, (s.termRows || 30) - 8 - extraLines(s));

function flatItems(s) {
  const out = [];
  for (const r of s.rows) {
    for (const m of r.models) {
      out.push({ kind: "model", model: m, row: r, target: asTarget(r.provider, m.id) });
    }
  }
  return out;
}

// The live `ok` counts the model-level header shows: from the SAME reader the rows, the benched
// stamp and the ok-only filter use, so all of them agree. Memoised per (reader, clock): the flat
// total is a pass over every row, done once.
const okMemo = new WeakMap();
function okBook(s) {
  let m = okMemo.get(s.benchOf);
  if (!m || m.now !== s.now) okMemo.set(s.benchOf, m = { now: s.now, byRow: new WeakMap(), total: undefined });
  return m;
}
// `{ ok, fresh }` for one provider: MODEL ROWS whose latest fresh status is ok (exactly what the
// ok-only filter keeps; an `x` and `x[1m]` pair are two routes and count twice), and how many rows
// have ANY fresh record. Memoised per (reader, clock, row).
function liveTally(s, row) {
  const m = okBook(s);
  let t = m.byRow.get(row);
  if (!t) {
    t = { ok: 0, fresh: 0, gone: 0 };
    for (const m2 of row.models) {
      const rec = s.benchOf(`${row.provider}/${m2.id}`);
      if (isUsable(rec, s.now)) t.fresh += 1;
      if (isOk(rec, s.now)) t.ok += 1;
      if (isGone(rec, s.now)) t.gone += 1;
    }
    m.byRow.set(row, t);
  }
  return t;
}
// A reader with no records at all (bench.json missing, empty or unusable) knows nothing.
const noReader = (s) => typeof s.benchOf !== "function" || s.benchOf.records === 0;
/**
 * The model-level `ok` figure, or `null` (drawn `- ok`, never `0 ok`) when nothing was benched:
 * the reader has no records, or (at level 1) this provider has no FRESH record. `0` is reserved for
 * "at least one fresh record and none is ok".
 */
function liveOk(s, row) {
  if (noReader(s) || !row) return null;
  const t = liveTally(s, row);
  return t.fresh === 0 ? null : t.ok;
}
// How many routes of the open provider (or of every provider, in flat scope) have a fresh `gone` record: the
// denominator of the header's percent is models minus these. `null` when there is no reader to ask.
function liveGone(s, row) {
  if (noReader(s) || !row) return null;
  return liveTally(s, row).gone;
}
function liveGoneTotal(s) {
  if (noReader(s)) return null;
  const m = okBook(s);
  if (m.goneTotal === undefined) {
    let n = 0;
    for (const r of s.rows) n += liveTally(s, r).gone;
    m.goneTotal = n;
  }
  return m.goneTotal;
}
function liveOkTotal(s) {
  if (noReader(s)) return null;
  const m = okBook(s);
  if (m.total === undefined) {
    let ok = 0, fresh = 0;
    for (const r of s.rows) { const t = liveTally(s, r); ok += t.ok; fresh += t.fresh; }
    m.total = fresh === 0 ? null : ok;
  }
  return m.total;
}

function items(s) {
  const needle = s.q[slot(s)].toLowerCase();
  const has = (hay) => !needle || String(hay).toLowerCase().includes(needle);
  // The model-level toggles: ok-only (latest fresh bench status is exactly `ok`) and 1M+.
  const ok = s.okOnly ? okOf(s) : null;
  // Hide-gone: a row whose FRESH bench record is `gone` is out; a row with no fresh record is shown.
  const gone = s.hideGone ? goneOf(s) : null;
  // Free-only: the badge AS DRAWN is FREE or FREE? (the snapshot already blanked a FREE? whose fresh probe said pay).
  const passes = (target, m) => (!s.oneM || isOneM(m)) && (!ok || ok(target)) && (!gone || !gone(target))
    && (!s.freeOnly || m.badge === "FREE" || m.badge === "FREE?");

  if (s.scope === "flat") return flatItems(s).filter((i) => has(i.target) && passes(i.target, i.model));

  if (s.level === 1) {
    const modelItems = s.provider.models
      .filter((m) => has(m.id) && passes(asTarget(s.provider.provider, m.id), m))
      .map((m) => ({ kind: "model", model: m, row: s.provider,
                     target: asTarget(s.provider.provider, m.id) }));
    // #51 (§2.5(b), revision 11): a second door onto the ctrl+r overlay, placed
    // FIRST so it sits above every model row. It is not a model row -- it has
    // no id to match against a query -- so it never enters the filter's match
    // set: present only while nothing is filtering (hiding it while a query
    // narrows the models below is fine; a query MATCHING it as though it were
    // a model id would be the defect §2.5(b) names).
    const withheldCount = s.provider.refused?.length ?? 0;
    if (!needle && !s.okOnly && !s.oneM && !s.hideGone && !s.freeOnly && withheldCount > 0) {
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
  const avail = rowsAvail({ ...s, legend: null, refusals: null });      // the LIST page: a modal open over it (which draws no notice) must not clamp it wider
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
  if (ev && typeof ev === "object" && Object.hasOwn(ev, "benchOf")) {
    // The lazy bench reader arriving (see initState). The ok filter may change what the
    // list holds, so the cursor is re-clamped like any other list change.
    // `benchOldestAt` rides with it when the caller has computed it from the loaded reader (null: no records at all).
    const oldest = Object.hasOwn(ev, "benchOldestAt") ? { benchOldestAt: typeof ev.benchOldestAt === "string" ? ev.benchOldestAt : null } : {};
    // `benchHist` (a Map of keyId to age histogram) rides with it the same way.
    const hist = Object.hasOwn(ev, "benchHist") ? { benchHist: ev.benchHist instanceof Map ? ev.benchHist : null } : {};
    return { ...NONE, state: clamp({ ...state, ...oldest, ...hist, benchOf: typeof ev.benchOf === "function" ? ev.benchOf : null }) };
  }
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
    // The legend scrolls too, so it needs the identical re-clamp for the
    // identical reason (L1): left alone, growing the terminal while the legend
    // is scrolled to the bottom leaves `top` past the new maximum, and the page
    // renders with blank space below it until one keystroke snaps it back.
    if (next.legend) {
      const maxTop = Math.max(0, LEGEND_LENGTH - rowsAvail(next));
      next = { ...next, legend: { top: Math.max(0, Math.min(next.legend.top, maxTop)) } };
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

  // The legend is modal and swallows the key that closes it, including enter and
  // esc. Swallowing is the point: a user who opens it to find out what esc does
  // should not have esc quit the picker on the way out.
  //
  // ARROWS NOW SCROLL RATHER THAN CLOSE, which is the same two-branch grammar
  // the refusals overlay above uses and for the same reason: the legend grew a
  // glossary and no longer fits one screen, so it is scrollable content, and a
  // modal with scrollable content establishes no precedent for eating the keys
  // that would scroll it. Every other key still closes, so the pre-glossary
  // muscle memory (press anything to dismiss) is unchanged.
  if (state.legend) {
    if (key.length >= 3 && c0 === 27 && key[1] === "[") {
      if (key[2] === "A" || key[2] === "B") {
        const maxTop = Math.max(0, LEGEND_LENGTH - rowsAvail(state));
        const top = key[2] === "A"
          ? Math.max(0, state.legend.top - 1)
          : Math.min(maxTop, state.legend.top + 1);
        return { ...NONE, state: { ...state, legend: { top } } };
      }
      return { ...NONE, state };                        // other CSI finals: no-op, stays open
    }
    return { ...NONE, state: { ...state, legend: null } };
  }
  if (key === "?") return { ...NONE, state: { ...state, legend: { top: 0 } } };  // Q3.6

  // ctrl+o (ok-only) and ctrl+l (1M+ context), MODEL LEVEL ONLY: no-ops at level 0
  // (the modals above already swallowed the key). Chosen because they are free here
  // and free in the terminal: not ctrl+c/f/r/g (handoff)/i/m/j/h/z/s/q/d, and not
  // ctrl+b, which is now a plain no-op (the bench view it toggled is gone). Both are
  // control bytes below 32, so the live filter below can never insert them.
  // ctrl+x (hide-gone) and ctrl+e (free-only) join them: free in the terminal and here (ctrl+g is the handoff key that opens
  // the picker). ctrl+x works at EVERY level (one shared flag: at the provider list it hides no row, it switches the % figures
  // to ok / (models - gone)); the other three are model-level only and do nothing at the provider list.
  if ((c0 === 15 || c0 === 12 || c0 === 24 || c0 === 5) && key.length === 1) {
    if (c0 !== 24 && state.scope !== "flat" && state.level === 0) return { ...NONE, state };
    // At the provider list ctrl+x only flips the flag: no row changes, so the cursor and scroll stay where they are.
    if (c0 === 24 && state.scope !== "flat" && state.level === 0) return { ...NONE, state: { ...state, hideGone: !state.hideGone } };
    const next = c0 === 15 ? { ...state, okOnly: !state.okOnly }
      : c0 === 12 ? { ...state, oneM: !state.oneM }
      : c0 === 5 ? { ...state, freeOnly: !state.freeOnly } : { ...state, hideGone: !state.hideGone };
    return { ...NONE, state: clamp(reset(next)) };
  }

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
    // #48: SURFACE, DO NOT BLOCK. `isSelectable` deliberately excludes
    // `routable` (D9) -- a stale snapshot must not become a functional
    // outage -- so a row the picker itself dimmed as not-currently-routable
    // is still selectable here. `finish()` reads this to warn AFTER letting
    // the selection through, never to refuse it.
    return { ...NONE, state, exit: { target: focused.target, routable: focused.model?.routable } };
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

function aliasOfSelected(item, state) {
  if (item?.kind !== "model" || typeof state.benchOf !== "function") return null;
  return liveAlias(item.row?.provider ?? state.provider?.provider, item.model, state.benchOf, state.now);
}

function fullIdOf(item, flat) {
  if (!item || !isSelectable(item)) return null;
  if (item.kind === "model") return flat ? item.target : String(item.model?.id ?? "");
  if (item.kind === "provider") return String(item.row?.keyId ?? "");
  if (item.kind === "pinned") return String(item.target ?? "");
  return null;
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
                 items: list.slice(top, top + avail), total: list.length,
                 // the longest withheld id, so the overlay can size its own id column
                 idMax: list.reduce((n, e) => Math.max(n, [...String(e?.id ?? "")].length), 0) };
  }
  return {
    // BOOLEAN, deliberately, though the reducer now holds `null | {top}`. Every
    // consumer of `v.legend` asks "is the overlay up", and widening that to an
    // object would make `if (v.legend)` keep working while `=== true` silently
    // stopped -- the worst shape of change. The offset rides beside it.
    level: state.level, scope: state.scope, filter: state.q[i], legend: !!state.legend,
    okOnly: !!state.okOnly, oneM: !!state.oneM, hideGone: !!state.hideGone, freeOnly: !!state.freeOnly,
    // `YYYY-MM-DD` while the list is outdated (more than half its records are over 7 days old), else null: drawn as the yellow notice.
    notice: noticeDate(state),
    // The OLDEST probe age in seconds (against the session clock, never negative) of each provider row on this page, by key id:
    // `null` when the provider has no records, and no entry at all when there is no bench data to say (the `oldest probe` cell
    // draws `-` and blank respectively). Plain data (a Map), so two views of the same state compare equal.
    probeAges: new Map(shown.filter((it) => it.kind === "provider").flatMap((it) => {
      const h = histOfRow(state, it.row);
      return Array.isArray(h) ? [[it.row.keyId, oldestAgeOf(h, state.now)]] : [];
    })),
    // The session clock the freshness rule reads (fixed at init), so the renderer never asks the wall.
    now: state.now,
    legendTop: state.legend?.top ?? 0,
    legendTotal: LEGEND_LENGTH,
    // The page size, from the SAME `rowsAvail` the arrow-scroll clamp above
    // uses. Projected rather than recomputed in the renderer so the clamp and
    // the paging cannot disagree about how many lines fit -- the identical
    // reason `refusals.items` is sliced here rather than in style.mjs.
    legendAvail: avail,
    items: shown, cursor: state.cur[i], top: state.top[i],
    empty: all.length === 0, provider: state.provider,
    // How many MODEL rows the whole filtered list holds (not this page): the header's
    // "N of M" counts these, never the withheld-list door.
    modelCount: all.reduce((n, it) => n + (it.kind === "model" ? 1 : 0), 0),
    // The live ok figure for the model-level header: the open provider's, or every provider's in
    // flat scope; `null` when no bench data is loaded (drawn as a dash, never `0 ok`).
    okLive: state.scope === "flat" ? liveOkTotal(state) : state.level === 1 ? liveOk(state, state.provider) : undefined,
    // How many of the open provider's routes (every provider's, in flat scope) have a fresh `gone` record; the header's
    // percent leaves them out of its denominator. `null`/`undefined` when there is nothing to count.
    goneLive: state.scope === "flat" ? liveGoneTotal(state) : state.level === 1 ? liveGone(state, state.provider) : undefined,
    // The FULL id of the selected row -- what enter or ctrl+f acts on -- or null when nothing is
    // selectable there (the withheld door, a non-chat row, an empty list).
    fullId: fullIdOf(all[state.cur[i]] ?? null, state.scope === "flat"),
    // The working sibling of the selected row when it is a dead alias (`= <id>` on the id line).
    fullAlias: aliasOfSelected(all[state.cur[i]] ?? null, state),
    // The selected provider's plan-covered model count (the provider list no longer draws it).
    fullPlan: all[state.cur[i]]?.kind === "provider" ? (all[state.cur[i]].row?.planCount ?? 0) : 0,
    more: Math.max(0, all.length - (state.top[i] + shown.length)),
    recentsHidden: state.recentsHidden ?? 0,
    refusals,
  };
}

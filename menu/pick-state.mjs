// The two-level menu, as a pure reducer.
//
// Split out of the renderer for one reason: under CC's ctrl+g handoff the child
// has no usable stdin, so the interactive surface cannot be driven by a test
// harness. Keeping every decision here -- filtering, cursor, scope, the Esc
// ladder -- means the behaviour is testable by feeding it strings, and the
// renderer left behind is a formatter with no logic to get wrong.

const asTarget = (providerName, modelId) => `${providerName}/${modelId}`;

export function initState(rows, { recents = [], favourites = [], termRows = 30 } = {}) {
  const known = new Set();
  for (const r of rows) for (const m of r.models) known.add(asTarget(r.provider, m.id));
  // Favourites first, then recents, both filtered to targets that still exist.
  // A pinned row naming a model the catalogue dropped would be a dead selection.
  const pinned = [
    ...favourites.filter((t) => known.has(t)).map((target) => ({ kind: "pinned", target, mark: "*" })),
    ...recents.filter((t) => known.has(t) && !favourites.includes(t))
              .map((target) => ({ kind: "pinned", target, mark: "~" })),
  ];
  return {
    rows, pinned,
    level: 0, scope: "tree", legend: false,
    q: ["", "", ""], cur: [0, 0, 0], top: [0, 0, 0],
    provider: null, termRows,
  };
}

// Index into q/cur/top. Flat scope is its own slot so toggling back to the tree
// restores the filters the user had typed there.
const slot = (s) => (s.scope === "flat" ? 2 : s.level);

const rowsAvail = (s) => Math.max(3, (s.termRows || 30) - 6);

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
    return s.provider.models
      .filter((m) => has(m.id))
      .map((m) => ({ kind: "model", model: m, row: s.provider,
                     target: asTarget(s.provider.provider, m.id) }));
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
    return { ...NONE, state: clamp({ ...state, termRows: ev.resize }) };
  }
  const key = String(ev ?? "");
  const c0 = key.charCodeAt(0);
  const i = slot(state);
  const list = items(state);
  const focused = list[state.cur[i]] ?? null;

  if (c0 === 3) return { ...NONE, state, exit: { target: null } };               // ctrl+c

  // The legend is modal and swallows exactly one key, including enter and esc.
  // Swallowing is the point: a user who opens it to find out what esc does should
  // not have esc quit the picker on the way out.
  if (state.legend) return { ...NONE, state: { ...state, legend: false } };
  if (key === "?") return { ...NONE, state: { ...state, legend: true } };      // Q3.6

  if (key === "\t") {                                                          // scope toggle
    return { ...NONE, state: clamp({ ...state, scope: state.scope === "flat" ? "tree" : "flat" }) };
  }

  if (c0 === 6 && focused?.kind === "model") {                                // ctrl+f
    return { ...NONE, state, favourite: focused.target };
  }

  if (key.length >= 3 && c0 === 27 && key[1] === "[") {                        // arrows
    const cur = [...state.cur];
    if (key[2] === "A") cur[i] = cur[i] - 1;
    if (key[2] === "B") cur[i] = cur[i] + 1;
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
    if (focused.kind === "provider") {
      const q = [...state.q], cur = [...state.cur], top = [...state.top];
      q[1] = ""; cur[1] = 0; top[1] = 0;
      return { ...NONE, state: clamp({ ...state, level: 1, provider: focused.row, q, cur, top }) };
    }
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
  return {
    level: state.level, scope: state.scope, filter: state.q[i], legend: state.legend,
    items: shown, cursor: state.cur[i], top: state.top[i],
    empty: all.length === 0, provider: state.provider,
    more: Math.max(0, all.length - (state.top[i] + shown.length)),
  };
}

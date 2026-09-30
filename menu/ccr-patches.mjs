// The five local patches to the installed router, as DATA. Pure: no fs, no
// imports, no path literals. `keysync/ccr-patch.mjs` applies them; `menu/doctor.mjs`
// (Part 2) reads the same markers, so the two can never disagree about what
// "patched" looks like.
//
// EVERY FIND/REPLACE BELOW WAS EXTRACTED MECHANICALLY from the installed bundle
// against its stock backup, not typed from prose. `test/ccr-patch.test.mjs`
// re-proves them against the real files when they exist (inverse-apply reaches the
// stock sha, forward re-apply reaches the installed sha).
//
//   A  K7 gateway handshake timeout        5e3  -> 2e4      (cli)
//   B  yx saveConfig timeout               3e4  -> 12e4     (cli)
//   C  Pd provider-metadata cache          CCR#1775/#1776   (cli)
//   D  QQe findProvider Set cache          CCR#1777         (cli)
//   E  surface the upstream failure reason (#109)           (gatewayLib)
//
// Every step is one line: no CR or LF inside a find or a replace, so the file's
// line endings never affect matching. The script reads and writes latin1 so they
// round-trip byte for byte.
//
// TWO TRAPS this shape exists to avoid:
//   1. A replacement that CONTAINS its own anchor. C's first replacement ends in
//      `function Pd(e){`, which used to be the anchor, so "find count is 1" would
//      re-apply the patch and double it. The anchor is now `Ag;function Pd(e){`
//      (the replacement puts text between `Ag;` and `function`), and
//      `validateRecipes` rejects any replace that includes its own find.
//   2. Minified identifiers change per build. Detection for A and B therefore
//      anchors on the stable literal next to the number and reads the number,
//      tolerant; APPLYING is strict (exact strings, exact counts, version-locked).

const MIN = { A: 20000, B: 120000 };
const num = (s) => Number(s.replace(/e(\d+)/, (_, e) => "0".repeat(Number(e))));

// Handshake timeout: first numeric assignment after `var PN="gateway",`.
const detectA = (text) => {
  const norm = text.replace(/\r\n/g, "\n");
  const at = norm.indexOf('var PN="gateway",');
  if (at < 0) return { state: "anchor-gone", value: null };
  const m = /^var PN="gateway",[A-Za-z_$][\w$]*=(\d+(?:e\d+)?)/.exec(norm.slice(at));
  if (!m) return { state: "anchor-gone", value: null };
  const ms = num(m[1]);
  return { state: ms >= MIN.A ? "applied" : "missing", value: ms };
};

// saveConfig timeout: the SECOND numeric assignment after the service-token name.
const detectB = (text) => {
  const norm = text.replace(/\r\n/g, "\n");
  const at = norm.indexOf('"CCR_SERVICE_INSTANCE_TOKEN",');
  if (at < 0) return { state: "anchor-gone", value: null };
  const m = /^"CCR_SERVICE_INSTANCE_TOKEN",[A-Za-z_$][\w$]*=\d+(?:e\d+)?,[A-Za-z_$][\w$]*=(\d+(?:e\d+)?)/.exec(norm.slice(at));
  if (!m) return { state: "anchor-gone", value: null };
  const ms = num(m[1]);
  return { state: ms >= MIN.B ? "applied" : "missing", value: ms };
};

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const PATCHES = deepFreeze([
  {
    id: "A", title: "gateway handshake timeout (K7 5e3 -> 2e4)", file: "cli", severity: "red",
    steps: [{ find: 'var PN="gateway",K7=5e3,', replace: 'var PN="gateway",K7=2e4,', count: 1 }],
    guards: [], markers: [], detect: detectA,
  },
  {
    id: "B", title: "saveConfig timeout (yx 3e4 -> 12e4)", file: "cli", severity: "amber",
    steps: [{ find: '"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=3e4,', replace: '"CCR_SERVICE_INSTANCE_TOKEN",pdt=2e3,yx=12e4,', count: 1 }],
    guards: [], markers: [], detect: detectB,
  },
  {
    id: "C", title: "Pd provider-metadata cache", file: "cli", severity: "red",
    steps: [
      {
        find: 'Ag;function Pd(e){',
        replace: 'Ag;var UW_PD_CRYPTO=require("node:crypto"),UW_PD_MAX=512;function UW_pdc(){return UW_pdc.m||(UW_pdc.m=new Map())}function Pd(e){',
        count: 1,
      },
      {
        find: 'let n=AQe(t.providers,e);return n?{loadedFrom:t.loadedFrom,matchedBy:n.matchedBy,modelDisplayNames:hM(n.entry.modelDisplayNames),modelMetadata:hM(n.entry.modelMetadata),models:n.entry.models,provider:n.entry.provider,providerName:n.entry.providerName}:{loadedFrom:t.loadedFrom,models:[]}}',
        replace: 'let UW_k;try{UW_k=UW_PD_CRYPTO.createHash("sha256").update(JSON.stringify([e?.providerPresetId??"",e?.baseUrl??"",e?.name??"",e?.providerIds??[]])).digest("base64")}catch{UW_k=void 0}let UW_c=UW_pdc();if(UW_k!==void 0&&UW_c.has(UW_k))return UW_c.get(UW_k);let n=AQe(t.providers,e);let UW_v=n?{loadedFrom:t.loadedFrom,matchedBy:n.matchedBy,modelDisplayNames:hM(n.entry.modelDisplayNames),modelMetadata:hM(n.entry.modelMetadata),models:n.entry.models,provider:n.entry.provider,providerName:n.entry.providerName}:{loadedFrom:t.loadedFrom,models:[]};if(UW_k!==void 0){UW_c.size>=UW_PD_MAX&&UW_c.clear(),UW_c.set(UW_k,UW_v)}return UW_v}',
        count: 1,
      },
    ],
    guards: [], markers: ["UW_PD_MAX=512", "UW_PD_CRYPTO", "UW_pdc"],
  },
  {
    id: "D", title: "QQe findProvider Set cache", file: "cli", severity: "amber",
    steps: [{
      find: 'function QQe(e){return new Set([e.name,e.id,e.provider,Cr(e)].map(t=>t?.trim().toLowerCase()).filter(t=>!!t))}',
      replace: 'var UW_QQE_CACHE=new WeakMap();function QQe(e){let UW_QQE_C=UW_QQE_CACHE.get(e);if(UW_QQE_C)return UW_QQE_C;let UW_QQE_V=new Set([e.name,e.id,e.provider,Cr(e)].map(t=>t?.trim().toLowerCase()).filter(t=>!!t));return Object(e)===e&&UW_QQE_CACHE.set(e,UW_QQE_V),UW_QQE_V}',
      count: 1,
    }],
    // The name QQe occurs exactly twice in stock (definition + one call) and
    // still twice once patched (the cache identifiers are upper-case). A
    // different count means the function was renamed, split or newly called.
    guards: [{ token: "QQe", count: 2 }],
    markers: ["UW_QQE_CACHE=new WeakMap", "UW_QQE_V"],
  },
  {
    id: "E", title: "surface the upstream failure reason (#109)", file: "gatewayLib", severity: "amber",
    // Both multi-provider failure envelopes build `message` from this literal; `t`
    // is already bound to the last attempt in both. The prefix comes from
    // `providerName` (the configured name), never `provider` (the adapter type,
    // which named the wrong provider on the first try).
    steps: [{
      find: 'message:"All target providers failed.",',
      replace:
        'message:(()=>{try{const _d=t&&(t.details?.error?.message||t.details?.message||t.message);' +
        'if(!_d)return "All target providers failed.";' +
        'const _n=String(t.providerName||"").match(/^provider-(.+?)-[0-9a-f]{6,}/);' +
        'return (_n?_n[1]+": ":"")+String(_d).slice(0,400);}' +
        'catch{return "All target providers failed.";}})(),',
      count: 2,
    }],
    guards: [], markers: ["const _d=t&&(t.details?.error?.message"],
    verifiedFor: { gatewayLib: "1.0.18" },
  },
]);

/** id -> the strings that must all be present when that patch is applied (doctor and script share this). */
export const MARKERS = deepFreeze(Object.fromEntries(PATCHES.map((p) => [p.id, [...p.markers]])));

/** Non-overlapping occurrences of `s` in `text` (same count `split(s).length - 1` gives). */
export function count(text, s) {
  let n = 0, i = 0;
  while ((i = text.indexOf(s, i)) >= 0) { n++; i += s.length; }
  return n;
}

/**
 * Strict state of one patch in `text`:
 *   applied    every step's replace occurs `count` times and its find never, guards hold
 *   stock      every step's find occurs `count` times and its replace never, guards hold
 *   unexpected anything else (partial, mixed, duplicated, guard token moved)
 * A replacement that contains fragments of its find must never read as stock,
 * which is why `applied` is decided on the replace counts as well.
 */
export function classify(text, patch) {
  const steps = patch.steps.map((s, i) => ({ step: i + 1, find: count(text, s.find), replace: count(text, s.replace), expected: s.count }));
  const guards = (patch.guards ?? []).map((g) => ({ token: g.token, count: count(text, g.token), expected: g.count }));
  let state = "unexpected";
  if (guards.every((g) => g.count === g.expected)) {
    if (steps.every((s) => s.replace === s.expected && s.find === 0)) state = "applied";
    else if (steps.every((s) => s.find === s.expected && s.replace === 0)) state = "stock";
  }
  return { id: patch.id, state, steps, guards };
}

/** One line naming the counts behind a classification, for refusal messages. */
export function describe(c) {
  const s = c.steps.map((x) => `step ${x.step}: find x${x.find}, replace x${x.replace} (expected x${x.expected})`);
  const g = c.guards.map((x) => `guard ${x.token}: x${x.count} (expected x${x.expected})`);
  return `${c.id} is ${c.state}; ${[...s, ...g].join("; ")}`;
}

const rewrite = (text, patch, from, to, wantState) => {
  const c = classify(text, patch);
  if (c.state !== wantState) throw new Error(`patch ${describe(c)}`);
  let out = text;
  for (const s of patch.steps) out = out.split(s[from]).join(s[to]);
  return out;
};

/** stock -> applied. Throws (naming the counts) unless `text` is exactly stock for this patch. */
export function applyPatch(text, patch) { return rewrite(text, patch, "find", "replace", "stock"); }

/** applied -> stock (the inverse recipe). Throws unless `text` is exactly applied for this patch. */
export function revertPatch(text, patch) { return rewrite(text, patch, "replace", "find", "applied"); }

/** Recipe self-checks. `{ ok, problems }`; the test runs it, the script does not need to. */
export function validateRecipes(patches = PATCHES) {
  const problems = [];
  const ids = new Set();
  for (const p of patches) {
    if (ids.has(p.id)) problems.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!["cli", "gatewayLib"].includes(p.file)) problems.push(`${p.id}: unknown file ${p.file}`);
    if (!["red", "amber"].includes(p.severity)) problems.push(`${p.id}: unknown severity ${p.severity}`);
    if (!p.steps?.length) problems.push(`${p.id}: no steps`);
    for (const [i, s] of p.steps.entries()) {
      const at = `${p.id} step ${i + 1}`;
      if (/[\r\n]/.test(s.find) || /[\r\n]/.test(s.replace)) problems.push(`${at}: newline inside find/replace`);
      if (!s.find || s.replace.includes(s.find)) problems.push(`${at}: replace contains its own find (re-apply would double it)`);
      if (s.find === s.replace) problems.push(`${at}: replace equals find`);
      if (!Number.isInteger(s.count) || s.count < 1) problems.push(`${at}: bad count`);
    }
    for (const m of p.markers) {
      if (!p.steps.some((s) => s.replace.includes(m))) problems.push(`${p.id}: marker ${m} is in no replace`);
    }
  }
  // Steps must not interfere: no find inside another step's replace, within a
  // recipe or across recipes that edit the same file.
  const flat = patches.flatMap((p) => p.steps.map((s, i) => ({ at: `${p.id} step ${i + 1}`, file: p.file, ...s })));
  for (const a of flat) for (const b of flat) {
    if (a !== b && a.file === b.file && b.replace.includes(a.find)) problems.push(`${a.at}: its find occurs inside ${b.at}'s replace`);
  }
  return { ok: problems.length === 0, problems };
}

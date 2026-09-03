// Compare every declared Interfaces signature against the implementation's real
// one, and report the pairs that disagree.
//
// Four instances of "an Interfaces line describing a function that does not
// exist" have now been found across three rounds, each by a reviewer reading one
// against the other by hand:
//
//   tier1        declared Map<string, Entry[]>, returned Map<string, string[]>
//                — the whole round-2 blocker, stated in one word
//   writeHealth  declared (snapshot, now, out?), took (snapshot, now, {out, tier})
//   tier3        declared opts {confirmed, probe?, rpc?}, destructured neither
//   writeSnapshot declared a return, never mentioned that it throws
//
// A declaration is the spec an implementer works to. Where the two disagree, the
// implementer is asked to make an unguided decision on exactly the property the
// declaration exists to pin — and in three of the four cases above, deciding in
// the declaration's favour reinstated a defect.
//
// This does NOT try to auto-adjudicate. It extracts both sides, matches by name,
// and prints the pairs whose parameter lists differ so a human can judge. Fuzzy
// matching that silently "passed" would be the same failure one level up.
//
//   node check-interfaces.mjs [plan.md] [--all]
//
// Default scope is Phase B; --all covers the whole plan.
import fs from "node:fs";

const file = process.argv[2] ?? "phase6-menu-and-catalogue.md";
const all = process.argv.includes("--all");
const src = fs.readFileSync(file, "utf8");
const from = all ? 0 : src.indexOf("# Phase B —");
if (from < 0) { console.error("Phase B not found"); process.exit(2); }
const body = src.slice(from);
const lineOf = (idx) => src.slice(0, from + idx).split("\n").length;

// --- declared: `name(params) -> ret` inside a backtick span on an Interfaces line
const declared = new Map();
for (const m of body.matchAll(/`([A-Za-z_$][\w$.]*)\(([^`]*?)\)\s*->/g)) {
  const name = m[1].split(".").pop();
  if (declared.has(name)) continue;                 // first declaration wins
  declared.set(name, { params: m[2].trim(), at: lineOf(m.index) });
}

// --- implemented: export function / export const name = (...) =>
const impl = new Map();
const patterns = [
  /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([\s\S]*?)\)\s*\{/g,
  /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([\s\S]*?)\)\s*=>/g,
];
for (const re of patterns) {
  for (const m of body.matchAll(re)) {
    if (impl.has(m[1])) continue;
    impl.set(m[1], { params: m[2].replace(/\s+/g, " ").trim(), at: lineOf(m.index) });
  }
}

// Split on commas that are at depth 0 for BOTH brackets and angle brackets.
// Without the angle-bracket case, `outcomes: Map<string, Outcome>` splits into
// two parameters and every function taking a Map reports a false disagreement.
const splitTop = (s) => {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if ("({[<".includes(ch)) depth++;
    if (")}]>".includes(ch)) depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
};

// KNOWN LIMIT, so it is not re-investigated each run: a declaration containing an
// inline arrow-function TYPE, such as `cadenceOf?: (name) => {cadence?,
// planCovered?}`, parses wrongly here — the arrow's return-type braces look like
// the option object, and its keys are reported as ignored options. `buildFrom` is
// the only such declaration in this plan and it is correct as written; it is
// suppressed by name rather than by widening the parser, because a parser that
// tolerates arrow types would also stop catching the real cases.
const KNOWN_PARSE_LIMIT = new Set(["buildFrom"]);

// The KEYS of a destructuring pattern or a declared options object — never the
// default values. `{ root = CATALOG_DIR, now = Date.now() }` is `root, now`; the
// first version of this read CATALOG_DIR and Date as parameters and reported
// every store function as mismatched. A checker whose false positives outnumber
// its true ones is not read, which is the failure it exists to prevent.
const keysOf = (objBody) =>
  splitTop(objBody.replace(/^\{|\}$/g, ""))
    .map((e) => (e.trim().match(/^([A-Za-z_$][\w$]*)/) ?? [])[1])
    .filter(Boolean)
    .sort();

// Key sets are compared ONLY where the implementation actually destructures. That
// one rule removes both classes of false positive the first version produced:
//
//   `outcome: {kind, models?, at}` declared against `(prev, outcome)` — the
//   declaration is documenting the argument's shape and the implementation takes
//   it whole. Compatible; nothing to report.
//
//   `prev?` declared against `prev = { providers: {} }` — the braces are a default
//   value, not a pattern. Compatible.
//
// What remains is the signal: the implementation destructures a fixed set of
// option keys, and the declaration advertises a key that is not in it. That is
// the species this checker exists for — a caller reading the declaration passes
// an option the function silently ignores.
const paramNames = (params) => splitTop(params).map((p) => {
  const t = p.trim();
  if (t.startsWith("{")) return { destructured: true, keys: keysOf(t.slice(0, t.lastIndexOf("}") + 1)) };
  return { destructured: false, name: t.split(/[:=?]/)[0].trim() };
}).filter((p) => p.destructured || p.name);

const shape = (params) => paramNames(params).map((p) =>
  p.destructured ? "{" + p.keys.join(",") + "}" : p.name);

// Declared side: an option object may be written `opts?: {a?, b?}`, so pull the
// keys out of a type annotation too — but only when comparing against a
// destructured implementation parameter.
const declaredKeysAt = (params, i) => {
  const p = splitTop(params)[i];
  if (p == null) return null;
  const t = p.trim();
  const open = t.indexOf("{");
  if (open < 0) return null;
  const eq = t.indexOf("=");
  if (eq >= 0 && eq < open) return null;              // braces are a default value
  return keysOf(t.slice(open, t.lastIndexOf("}") + 1));
};

const rows = [];
for (const [name, d] of declared) {
  const i = impl.get(name);
  if (!i) continue;                                  // declared elsewhere, or prose
  if (KNOWN_PARSE_LIMIT.has(name)) continue;         // see the note above splitTop
  const dp = paramNames(d.params), ip = paramNames(i.params);
  const notes = [];
  if (dp.length !== ip.length) {
    notes.push(`arity ${dp.length} declared vs ${ip.length} implemented`);
  }
  ip.forEach((p, k) => {
    if (!p.destructured) return;                      // only destructured options
    const dk = declaredKeysAt(d.params, k);
    if (!dk) return;                                  // declaration says nothing useful
    const ghost = dk.filter((key) => !p.keys.includes(key));
    const undocumented = p.keys.filter((key) => !dk.includes(key));
    if (ghost.length) notes.push(`declared but IGNORED by the implementation: ${ghost.join(", ")}`);
    if (undocumented.length) notes.push(`accepted but undeclared: ${undocumented.join(", ")}`);
  });
  if (notes.length) rows.push({ name, d, i, ds: shape(d.params), is: shape(i.params), notes });
}

console.log(`${file}: ${declared.size} declared, ${impl.size} implemented, ` +
            `${rows.length} disagree (${all ? "whole plan" : "Phase B"})`);
for (const r of rows) {
  console.log(`\n  ${r.name}`);
  console.log(`    declared  L${r.d.at}: (${r.ds.join(", ")})`);
  console.log(`    implement L${r.i.at}: (${r.is.join(", ")})`);
  for (const n of r.notes) console.log(`    -> ${n}`);
}
process.exit(rows.length ? 1 : 0);

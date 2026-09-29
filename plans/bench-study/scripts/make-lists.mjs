// Targeted re-probe lists, derived from the study's models.csv (read-only) and written to
// plans/bench-study/lists/. Each list is one `provider/id` per line, ready for
//   node refresh/bench-cli.mjs --only-file plans/bench-study/lists/<name>.txt ...
//
//   empty55.txt      `empty` routes recorded as hidden reasoning (the provider answered, the
//                    96-token budget went on reasoning): re-probe with --max-tokens 1024
//   timeout42.txt    `timeout` routes: re-probe with the default 240 s timeout
//   transient.txt    every route whose CURRENT status is error, rate or timeout. For
//                    reference and for the dry plan only: a default run re-probes these by
//                    itself (they are TRANSIENT, so a resume never treats them as fresh)
//
// The bench key strips a trailing `[1m]`, so a route and its `[1m]` twin are one line.
// Usage: node plans/bench-study/scripts/make-lists.mjs   (from C:\Users\osami\.uw)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUDY = path.resolve(HERE, "..");
const OUT = path.join(STUDY, "lists");

/** Minimal RFC-4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"") { if (text[i + 1] === "\"") { cell += "\""; i++; } else quoted = false; } else cell += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

export const benchKey = (provider, id) => `${provider}/${String(id).replace(/\[1m\]$/i, "")}`;

/** The three lists, as sorted unique bench keys. Pure: rows in, lists out. */
export function buildLists(rows) {
  const pick = (f) => [...new Set(rows.filter(f).map((r) => benchKey(r.provider, r.id)))].sort();
  return {
    empty55: pick((r) => r.status === "empty" && r.cause === "empty:budget-spent-on-hidden-reasoning"),
    timeout42: pick((r) => r.status === "timeout"),
    transient: pick((r) => ["error", "rate", "timeout"].includes(r.status)),
  };
}

const byProvider = (keys) => {
  const m = new Map();
  for (const k of keys) m.set(k.split("/")[0], (m.get(k.split("/")[0]) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = parseCsv(fs.readFileSync(path.join(STUDY, "models.csv"), "utf8"));
  const lists = buildLists(rows);
  fs.mkdirSync(OUT, { recursive: true });
  const note = {
    empty55: "# empty routes recorded as budget spent on hidden reasoning (stop_reason max_tokens)\n# node refresh/bench-cli.mjs --only-file plans/bench-study/lists/empty55.txt --force --max-tokens 1024\n",
    timeout42: "# routes whose last probe timed out at 35 s (the default deadline is now 240 s)\n# node refresh/bench-cli.mjs --only-file plans/bench-study/lists/timeout42.txt --force\n",
    transient: "# every route whose CURRENT status is error, rate or timeout (reference: a default run re-probes these itself)\n",
  };
  for (const [name, keys] of Object.entries(lists)) {
    fs.writeFileSync(path.join(OUT, `${name}.txt`), `${note[name]}${keys.join("\n")}\n`);
    const top = byProvider(keys);
    console.log(`${name}.txt: ${keys.length} route(s) in ${top.length} provider(s)`);
    console.log(`  ${top.map(([p, n]) => `${p} ${n}`).join(", ")}`);
  }
}

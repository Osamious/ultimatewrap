// Shared loader: joins snapshot routes with bench records. READ-ONLY on ~/.uw/state and ~/.uw/catalog.
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import crypto from "node:crypto";
export const H = os.homedir();
export const SNAP_FILE = path.join(H, ".uw/catalog/snapshot.json");
export const BENCH_FILE = path.join(H, ".uw/state/bench.json");
export const DISC_DIR = path.join(process.env.LOCALAPPDATA ?? "", "uw-keysync", "discovery");
export const OUT = path.join(H, ".uw/plans/bench-study");
export const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
export const strip = (id) => String(id).replace(/\[1m\]$/i, "");
export const snap = readJson(SNAP_FILE);
export const benchFile = readJson(BENCH_FILE);
export const bench = benchFile.models;
// first run of the last sweep started after the pre-probe-all backup (12:35Z); 2283 records pre-date it.
export const LAST_RUN_START_S = Date.parse("2026-09-29T12:40:00Z") / 1000;
export const NOW_MS = Date.parse(snap.benchAsOf) + 0; // freshness evaluated at the bench timestamp (deterministic)
export const FRESH_MS = 14 * 24 * 3600 * 1000;
export function load() {
  const rows = [];
  for (const r of snap.rows) for (const m of r.models) {
    const key = `${r.provider}/${strip(m.id)}`;
    const eligible = !(m.outputKind === "nontext" || m.routable === false);
    const rec = bench[key] ?? null;
    const fresh = !!rec && Number.isFinite(rec.a) && NOW_MS - rec.a * 1000 >= 0 && NOW_MS - rec.a * 1000 <= FRESH_MS;
    rows.push({
      provider: r.provider, id: m.id, key, eligible, badge: m.badge ?? "", prov: m.provenance ?? "null",
      outputKind: m.outputKind ?? "null", ctx: m.ctx, tools: !!m.tools, vision: !!m.vision, reason: !!m.reason,
      pin: m.pin, pout: m.pout, rec, fresh, probed: eligible && fresh && !!rec && rec.s !== "skip",
      legacy: !!rec && rec.a < LAST_RUN_START_S, m1: /\[1m\]$/i.test(m.id),
    });
  }
  return rows;
}
export const providers = snap.rows.map((r) => r.provider);
export const discFile = (prov) => path.join(DISC_DIR, crypto.createHash("sha256").update(prov).digest("hex").slice(0, 32) + ".json");
export function pct(n, d) { return d ? `${(100 * n / d).toFixed(1)}%` : "n/a"; }
export function q(arr, p) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const i = (s.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
export const iso = (a) => (Number.isFinite(a) ? new Date(a * 1000).toISOString() : "");
// Discovery caches: one file per provider; keyed here by the `provider` field inside (not by hash name).
export function loadDiscovery() {
  const out = new Map();
  for (const f of fs.readdirSync(DISC_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = readJson(path.join(DISC_DIR, f));
      out.set(j.provider, { file: f, at: j.at, responded: !!j.responded, status: j.status, outcome: j.outcome, count: j.count, truncated: j.truncated,
        ids: new Set((j.models ?? []).map((m) => m.id)), rejected: j.rejected ?? [] });
    } catch { /* ignore unreadable */ }
  }
  return out;
}

// Redaction for anything that leaves the scripts as text: masked key fragments (`abc123*****wxyz`), key-looking tokens, URLs and bare
// domain/path links from provider messages. Provider sentences are third-party text and may quote credentials or link out.
export function redact(s) {
  return String(s ?? "")
    .replace(/https?:\/\/[^\s"')\]]*/gi, "[url]")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ai|io|net|org|dev|app|bond|co|cn|ru|xyz|cloud)\/[^\s"')\]]*/gi, "[url]")
    .replace(/[A-Za-z0-9]{3,}\*{3,}[A-Za-z0-9]{2,}/g, "[masked-key]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\b(?:Bearer|api[_-]?key[=:])\s*[A-Za-z0-9._-]{12,}/gi, "[key]");
}
// normalised listing id: lowercase, no `[1m]` suffix, no leading `models/` (google lists `models/<id>`)
export const normListId = (id) => strip(id).toLowerCase().replace(/^models\//, "");

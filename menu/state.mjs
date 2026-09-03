// Per-machine picker state. Not source, not committed (.gitignore excludes state/).
//
// Every function takes an optional file path so tests never touch the live file.
// Reads are total: a missing or corrupt file is an empty state, never a throw,
// because a picker that refuses to start over a bad preferences file is worse
// than one that forgets your favourites.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { writeAtomic, readJsonOr } from "./atomic.mjs";

const STATE_DIR = path.join(os.homedir(), ".uw", "state");
export const PICKER_STATE = path.join(STATE_DIR, "picker.json");
export const HANDOFF_LOG = path.join(STATE_DIR, "handoff.json");
export const STARTUP_FILE = path.join(STATE_DIR, "startup.json");

const MAX_RECENTS = 10;   // Q3.4
const MAX_FAVOURITES = 20;
const MAX_SAMPLES = 20;

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function loadPickerState(file = PICKER_STATE) {
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { recents: [], favourites: [] }; }
  try {
    const raw = JSON.parse(text);
    return { recents: strings(raw.recents), favourites: strings(raw.favourites) };
  } catch {
    // Q2.3: the file exists and is unparseable. Keep it -- it is the only copy of
    // a favourites list the user built by hand, and a rename costs nothing.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* read-only dir */ }
    return { recents: [], favourites: [] };
  }
}

function save(file, next) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(next, null, 2));   // Q2.8
  return next;
}

export function recordRecent(target, file = PICKER_STATE) {
  const s = loadPickerState(file);
  if (typeof target !== "string" || !target) return s;
  const recents = [target, ...s.recents.filter((t) => t !== target)].slice(0, MAX_RECENTS);
  return save(file, { recents, favourites: s.favourites });
}

export function toggleFavourite(target, file = PICKER_STATE) {
  const s = loadPickerState(file);
  if (typeof target !== "string" || !target) return s;
  const favourites = s.favourites.includes(target)
    ? s.favourites.filter((t) => t !== target)
    : [target, ...s.favourites].slice(0, MAX_FAVOURITES);
  return save(file, { recents: s.recents, favourites });
}

// Q1.2's number, recorded on every real run rather than only under benchmark, so
// a regression shows up in ordinary use instead of waiting for someone to measure.
export function recordStartup(ms, file = STARTUP_FILE) {
  const prev = readJsonOr(file, { samples: [] });
  const samples = [...(prev.samples ?? []), { at: new Date().toISOString(), ms }].slice(-MAX_SAMPLES);
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const next = { samples, median };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(next, null, 2));
  } catch { /* a lost sample is not worth failing a launch over */ }
  return next;
}

// One JSON line per picker invocation. This is the only evidence `uw doctor` has
// that CC's handoff contract still holds -- the argv shape it actually received,
// not the argv shape we believe it receives.
export function recordHandoff(entry, file = HANDOFF_LOG) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* observability must never break the picker */ }
}

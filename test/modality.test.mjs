// The model level's `modality` column: the primary OUTPUT modality of a route as one short word, derived
// at snapshot build from the best evidence and drawn from a closed vocabulary. Unknown stays unknown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { outputModalityOf, modalityWord, MODALITY_WORDS, MODALITY_SRCS, MODALITY_COLOURS } from "../menu/modality.mjs";
import { buildFrom } from "../menu/catalog.mjs";
import { buildSnapshot } from "../menu/snapshot.mjs";
import { detectCaps, painter, frame, frameWidth, layoutFor, modalityCell, modalityHue, MODALITY_TXT_W, FRAME_MIN, FRAME_MAX } from "../menu/style.mjs";
import { initState, view } from "../menu/pick-state.mjs";
import { legendLines } from "../menu/legend.mjs";
import { glyphsFor } from "../menu/style.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const cps = (s) => [...s].length;
const UNI = { WT_SESSION: "1", COLORTERM: "truecolor" }, ASCII = { TERM: "dumb" };

// ------------------------------------------------------------ the derivation

test("each source decides on its own evidence, and names itself", () => {
  // listing: the provider's own capability token
  for (const [tok, word] of [["chat", "chat"], ["text", "chat"], ["completion", "chat"], ["image", "image"], ["image_gen", "image"],
                             ["video", "video"], ["audio", "audio"], ["tts", "audio"], ["audio_to_text", "stt"], ["transcription", "stt"],
                             ["embedding", "embed"], ["embeddings", "embed"], ["rerank", "rank"], ["moderation", "mod"]]) {
    assert.deepEqual(outputModalityOf(null, tok, null), { v: word, src: "listing" }, tok);
  }
  assert.deepEqual(outputModalityOf(null, " Image-Gen ", null), { v: "image", src: "listing" }, "normalised like keysync's capabilityKind");
  // mode: the catalogue's LiteLLM function
  for (const [mode, word] of [["chat", "chat"], ["completion", "chat"], ["responses", "chat"], ["embedding", "embed"], ["rerank", "rank"],
                              ["moderation", "mod"], ["image_generation", "image"], ["image_edit", "image"], ["audio_speech", "audio"],
                              ["audio_transcription", "stt"], ["video_generation", "video"], ["ocr", "ocr"], ["realtime", "live"]]) {
    assert.deepEqual(outputModalityOf({ mode }, null, null), { v: word, src: "mode" }, mode);
  }
  // output: only a single-valued modalities.output list
  for (const [out, word] of [["text", "chat"], ["image", "image"], ["audio", "audio"], ["video", "video"], ["embedding", "embed"], ["score", "rank"]]) {
    assert.deepEqual(outputModalityOf({ modalities: { output: [out] } }, null, null), { v: word, src: "output" }, out);
  }
  // kind: known to be not chat, nothing more
  assert.deepEqual(outputModalityOf({}, null, "nontext"), { v: "other", src: "kind" });
});

test("precedence: the listing outranks the catalogue mode, which outranks the output list, which outranks the kind", () => {
  const entry = { mode: "chat", modalities: { output: ["video"] } };
  assert.equal(outputModalityOf(entry, "image", "nontext").v, "image", "a live `image` demotes a bundle that says chat");
  assert.equal(outputModalityOf(entry, null, null).v, "chat", "mode beats the output list");
  assert.equal(outputModalityOf(entry, null, "text").v, "chat");
  // ...unless the picker has already judged the route NOT a chat model (outputKind nontext): the label may not
  // contradict the row's own treatment, so that rung is skipped and the next one decides.
  assert.deepEqual(outputModalityOf(entry, null, "nontext"), { v: "video", src: "output" }, "mode said chat, the row is nontext: fall to the output list");
  assert.equal(outputModalityOf({ modalities: { output: ["video"] } }, null, "nontext").v, "video", "the output list beats the bare kind");
  // A mode more specific than `text` output wins: a transcription model outputs text but is not a chat model.
  assert.equal(outputModalityOf({ mode: "audio_transcription", modalities: { output: ["text"] } }, null, "text").v, "stt");
});

test("a nontext route is never labelled chat: the rung is skipped, and `other` is the floor", () => {
  // mode chat, nothing else, nontext -> other
  assert.deepEqual(outputModalityOf({ mode: "chat" }, null, "nontext"), { v: "other", src: "kind" });
  // output [text] would say chat: skipped too
  assert.deepEqual(outputModalityOf({ modalities: { output: ["text"] } }, null, "nontext"), { v: "other", src: "kind" });
  // a listing token that says chat against a nontext verdict (cannot come from keysync, but the function must not trust it)
  assert.deepEqual(outputModalityOf(null, "chat", "nontext"), { v: "other", src: "kind" });
  // a non-chat word from the same rung is untouched
  assert.deepEqual(outputModalityOf({ mode: "embedding" }, null, "nontext"), { v: "embed", src: "mode" });
  // and the same inputs on a text/unknown route still say chat
  for (const k of ["text", null]) assert.equal(outputModalityOf({ mode: "chat" }, null, k).v, "chat");
});

test("UNKNOWN STAYS UNKNOWN: no evidence, a mixed output list, a capability FLAG and an unlisted mode all give null", () => {
  assert.equal(outputModalityOf(null, null, null), null);
  assert.equal(outputModalityOf({}, null, "text"), null, "outputKind text alone is not a modality");
  assert.equal(outputModalityOf({ modalities: { output: [] } }, null, null), null);
  // `audio` + `text`, `image` + `text`: which one is primary is exactly what the list does not say
  assert.equal(outputModalityOf({ modalities: { output: ["audio", "text"] } }, null, "text"), null);
  assert.equal(outputModalityOf({ modalities: { output: ["image", "text"] } }, null, "text"), null);
  // capability FLAGS and vendor tiers are not modalities (keysync's own rule)
  for (const flag of ["tool_calling", "reasoning", "base", "model", "web_search", "systemone", "auto"]) {
    assert.equal(outputModalityOf(null, flag, null), null, flag);
  }
  // an unlisted LiteLLM mode falls through to the output list, it is not guessed
  assert.equal(outputModalityOf({ mode: "search", modalities: { output: ["audio", "text"] } }, null, null), null);
  assert.equal(outputModalityOf({ mode: "search", modalities: { output: ["text"] } }, null, null).src, "output");
});

test("hostile strings never become a value: prototype keys, escapes, non-strings", () => {
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty", "\x1b[2J", "chat\x07", "‮image", 7, {}, [], true]) {
    assert.equal(outputModalityOf({ mode: bad, modalities: { output: [bad] } }, bad, null), null, JSON.stringify(bad));
  }
  assert.equal(outputModalityOf({ modalities: { output: "image" } }, null, null), null, "a string where a list belongs");
  assert.equal(modalityWord("\x1b[2J"), null);
  assert.equal(modalityWord("chat\n"), null);
  assert.equal(modalityWord(undefined), null);
  for (const w of MODALITY_WORDS) assert.equal(modalityWord(w), w);
  assert.ok(MODALITY_WORDS.every((w) => cps(w) <= 5), "every word fits the cell");
  assert.ok(MODALITY_SRCS.includes("bench-ok"));
});

// ---------------------------------------------------- from the catalogue rows

test("buildFrom stamps the value and its source on every row; the listing outranks the bundle", () => {
  const E = (model, extra) => ({ provider: "p", model, modalities: { input: ["text"], output: ["text"] }, capabilities: {}, ...extra });
  const catalog = { byProvider: new Map([["p", [
    E("plain"), E("emb", { mode: "embedding", modalities: { input: ["text"], output: ["embedding"] } }),
    E("pic", { modalities: { input: ["text"], output: ["image"] } }), E("stt-1", { mode: "audio_transcription" }),
    E("mixed", { modalities: { input: ["text"], output: ["audio", "text"] } }),
  ]]]) };
  const discovery = { byProvider: new Map([["p", [{ id: "plain", capabilityRaw: "video" }, { id: "listed-only", capabilityRaw: "chat" },
                                                  { id: "flag-only", capabilityRaw: "tool_calling" }]]]) };
  const { rows } = buildFrom({ chosen: [{ id: "personal.p.free", provider: "p" }], providers: new Map([["p", { testModel: "plain", notes: "" }]]),
                               catalog, discovery, oneMVerdicts: new Map() });
  const by = Object.fromEntries(rows[0].models.map((m) => [m.id, m]));
  assert.deepEqual([by.plain.outModality, by.plain.outModalitySrc], ["video", "listing"], "the listing said video, the bundle said text");
  assert.deepEqual([by.emb.outModality, by.emb.outModalitySrc], ["embed", "mode"]);
  assert.deepEqual([by.pic.outModality, by.pic.outModalitySrc], ["image", "output"]);
  assert.deepEqual([by["stt-1"].outModality, by["stt-1"].outModalitySrc], ["stt", "mode"]);
  assert.deepEqual([by["listed-only"].outModality, by["listed-only"].outModalitySrc], ["chat", "listing"], "a route only the listing names");
  assert.deepEqual([by.mixed.outModality, by.mixed.outModalitySrc], [null, null], "a mixed list is not primary evidence");
  assert.deepEqual([by["flag-only"].outModality, by["flag-only"].outModalitySrc], [null, null], "a capability flag is not a modality");
});

// ------------------------------------------------------------ the snapshot

const NOW = 1_800_000_000_000;
const built = (models) => ({ generatedAt: "2026-09-29T00:00:00Z", rows: [{ keyId: "personal.p.free", provider: "p", free: 0, planCount: 0,
  health: "ok", models: models.map((m) => ({ ctx: null, pin: null, pout: null, badge: "", tools: null, vision: null, reason: null,
    outputKind: null, routable: null, provenance: null, mode: false, ...m })) }] });
const benchOf = (map) => { const get = (t) => map[t] ?? null; get.records = Object.keys(map).length; return { get, size: get.records, generatedAt: "2026-09-29T00:00:00Z" }; };
const okRec = (ageSec = 60) => ({ s: "ok", t: 100, d: 200, r: 30, a: Math.floor(NOW / 1000) - ageSec, p: "hi", k: 0, w: "" });

test("buildSnapshot keeps the catalogue's value and source", () => {
  const s = buildSnapshot(built([{ id: "a", outModality: "image", outModalitySrc: "output" }, { id: "b" }]), { nowMs: NOW });
  const [a, b] = s.rows[0].models;
  assert.deepEqual([a.outModality, a.outModalitySrc], ["image", "output"]);
  assert.equal(b.outModality, null);
  assert.equal(Object.hasOwn(b, "outModalitySrc"), false, "the source is absent when the value is null");
  assert.equal(s.schemaVersion, 9, "the current schema");
});

test("a fresh ok probe with no other evidence is `chat?` from `bench-ok`; failures, future-dated records and other evidence are not used", () => {
  const b = benchOf({
    "p/ok-only": okRec(), "p/stale": okRec(30 * 86400), "p/future": okRec(-3 * 86400), "p/failed": { ...okRec(), s: "error", p: "not a chat model" },
    "p/gone": { ...okRec(), s: "gone" }, "p/empt": { ...okRec(), s: "empty" }, "p/img": okRec(),
  });
  const s = buildSnapshot(built([{ id: "ok-only" }, { id: "stale" }, { id: "future" }, { id: "failed" }, { id: "gone" }, { id: "empt" }, { id: "never" },
                                 { id: "img", outModality: "image", outModalitySrc: "listing" }]), { bench: b, nowMs: NOW });
  const by = Object.fromEntries(s.rows[0].models.map((m) => [m.id, m]));
  assert.deepEqual([by["ok-only"].outModality, by["ok-only"].outModalitySrc], ["chat?", "bench-ok"]);
  assert.deepEqual([by.stale.outModality, by.stale.outModalitySrc], ["chat?", "bench-ok"], "an old ok probe still counts");
  for (const id of ["future", "failed", "gone", "empt", "never"]) assert.equal(by[id].outModality, null, `${id}: no positive evidence`);
  assert.deepEqual([by.img.outModality, by.img.outModalitySrc], ["image", "listing"], "a catalogued modality is never overwritten by the probe");
});

test("a tampered or unknown value in `built` is stored as null, never passed through", () => {
  const s = buildSnapshot(built([{ id: "x", outModality: "\x1b[2Jchat", outModalitySrc: "listing" }, { id: "y", outModality: "poem" }]), { nowMs: NOW });
  for (const m of s.rows[0].models) assert.equal(m.outModality, null);
  assert.equal(JSON.stringify(s).includes("\\u001b[2J"), false);
});

// ------------------------------------------------------------- the column

const M = (id, outModality, extra = {}) => ({ id, ctx: 128000, pin: 1, pout: 2, badge: "PAID", tools: true, vision: false, reason: false,
  provenance: "listing-verified", routable: true, outModality, ...extra });
const modelView = (models) => {
  const row = { keyId: "personal.p.free", provider: "p", free: 0, planCount: 0, health: "ok", models };
  return { row, v: { ...view(initState([row])), level: 1, provider: row, items: models.map((m) => ({ kind: "model", model: m, row, target: `p/${m.id}` })), cursor: 9 } };
};
const NAMES = ["chat", "chat?", "image", "audio", "video", "embed", "rank", "mod", "stt", "ocr", "live", "other"];

test("the modality cell: eight columns, left-aligned, its own colour per known word, dim `?` for anything else", () => {
  const p256 = painter({ ...detectCaps(UNI, 100), colours: 256 });
  const p16 = painter({ ...detectCaps(UNI, 100), colours: 16 });
  const p0 = painter({ ...detectCaps(ASCII, 100), colours: 0 });
  assert.equal(MODALITY_TXT_W, 8);
  for (const w of NAMES) {
    for (const p of [p256, p16, p0]) {
      const c = modalityCell(w, p);
      assert.equal(cps(strip(c)), 8, w);
      assert.equal(strip(c), w.padEnd(8), "left-aligned like the badge");
    }
    const c = MODALITY_COLOURS[w];
    assert.equal(modalityCell(w, p256), `\x1b[38;5;${c.c256}m${w.padEnd(8)}\x1b[0m`, `${w}: its own 256-colour code`);
    assert.equal(modalityCell(w, p16), `\x1b[${c.c16}m${w.padEnd(8)}\x1b[0m`, `${w}: its 16-colour code`);
    assert.equal(modalityCell(w, p0), w.padEnd(8), `${w}: no colour codes at all with colour off`);
    assert.equal(modalityHue(w, p256), `38;5;${c.c256}`);
  }
  for (const bad of [undefined, null, "", "\x1b[2J", "poem", 7, "chat\n"]) {
    assert.equal(strip(modalityCell(bad, p256)), "?       ", JSON.stringify(bad));
    assert.equal(modalityCell(bad, p256), "\x1b[2m?       \x1b[0m", "unknown is dim, not a type colour");
    assert.equal(modalityCell(bad, p0), "?       ");
  }
});

test("the modality colour table: twelve known words, twelve DISTINCT 256-colour codes and twelve distinct 16-colour codes", () => {
  assert.deepEqual(Object.keys(MODALITY_COLOURS).sort(), [...NAMES].sort(), "exactly the known words, nothing for `?`");
  const c256 = NAMES.map((w) => MODALITY_COLOURS[w].c256), c16 = NAMES.map((w) => MODALITY_COLOURS[w].c16);
  assert.equal(new Set(c256).size, 12);
  assert.equal(new Set(c16).size, 12);
  assert.notEqual(MODALITY_COLOURS.chat.c256, MODALITY_COLOURS["chat?"].c256, "chat and chat? differ");
  for (const n of c256) assert.ok(Number.isInteger(n) && n >= 16 && n <= 255, "a colour-cube or grey-ramp code, never a system colour");
  for (const n of c16) assert.ok([31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97].includes(n));
  assert.equal(Object.isFrozen(MODALITY_COLOURS), true);
});

test("header and rows: `modality` sits between badge and TVR, on the same rule columns, at every width, in both glyph sets", () => {
  const models = NAMES.map((w, i) => M(`m${i}`, w)).concat([M("unk", null), M("evil", "\x1b[2J\x07boom")]);
  const { v } = modelView(models);
  for (const [env, S] of [[UNI, "┆"], [ASCII, ":"]]) for (const cols of [80, 100, 134, 240, 400]) {
    const caps = detectCaps(env, cols);
    const lines = frame(v, { providers: 1, models: models.length }, { caps });
    for (const l of lines) assert.equal(cps(strip(l)), frameWidth(caps), `cols ${cols}`);
    const text = lines.map(strip);
    const head = text.find((l) => l.includes("badge"));
    assert.ok(head.indexOf("modality") > head.indexOf("badge") && head.indexOf("modality") < head.indexOf("TVR"), "badge, modality, TVR in that order");
    const at = (l) => [...l].map((c, i) => (c === S ? i : -1)).filter((i) => i >= 0);
    for (const name of ["m0", "m2", "m5", "unk", "evil"]) {
      const row = text.find((l) => l.includes(` ${name}`) && !l.includes("id:"));
      assert.deepEqual(at(row), at(head), `${name} at ${cols}`);
    }
    const col = head.indexOf("modality");
    const cell = (name) => text.find((l) => l.includes(` ${name}`) && !l.includes("id:")).slice(col, col + 8);
    assert.equal(cell("m0"), "chat    ");
    assert.equal(cell("m2"), "image   ");
    assert.equal(cell("m11"), "other   ");
    assert.equal(cell("unk"), "?       ", "unknown reads as unknown");
    assert.equal(cell("evil"), "?       ", "a hostile stored value is drawn as unknown");
    assert.equal(lines.join("").includes("\x07"), false);
  }
});

test("modality is always drawn and outlasts total and tok/s: the drop order is preview, tok/s, total", () => {
  for (const idW of [5, 12, 22, 30, 500]) for (let w = FRAME_MIN; w <= FRAME_MAX; w++) {
    const l = layoutFor(w, { idW });
    if (l.showPreview) assert.ok(l.showTps, `tok/s outlives the preview (${w}/${idW})`);
    if (l.showTps) assert.ok(l.showTotal, `total outlives tok/s (${w}/${idW})`);
  }
  // At the 78-column floor total and tok/s are already gone (a 22-column id is kept first), and modality is still there.
  const { v } = modelView([M("a-very-long-model-identifier-of-forty-chars", "image")]);
  const at78 = frame(v, { providers: 1, models: 1 }, { caps: detectCaps(ASCII, 80) }).map(strip);
  const head = at78.find((l) => l.includes("badge"));
  assert.ok(head.includes("modality") && !head.includes("total") && !head.includes("tok/s"), head);
  assert.ok(at78.some((l) => l.includes("image")));
});

test("in a model row each modality word carries its own colour, and unknown is dim", () => {
  const { v } = modelView([M("c", "chat"), M("i", "image"), M("u", null)]);
  const raw = frame(v, { providers: 1, models: 3 }, { caps: { ...detectCaps(UNI, 134), colours: 256 } });
  const rowOf = (name) => raw.find((l) => strip(l).includes(` ${name} `) && !strip(l).includes("id:"));
  assert.match(rowOf("i"), new RegExp(`\\x1b\\[38;5;${MODALITY_COLOURS.image.c256}mimage`));
  assert.match(rowOf("c"), new RegExp(`\\x1b\\[38;5;${MODALITY_COLOURS.chat.c256}mchat`));
  assert.match(rowOf("u"), /\x1b\[2m\?/);
  const bare = frame(v, { providers: 1, models: 3 }, { caps: { ...detectCaps(ASCII, 134), colours: 0 } });
  assert.equal(bare.join("").includes("\x1b"), false, "no colour codes with colour off");
  for (const l of raw) assert.equal(cps(strip(l)), frameWidth(detectCaps(UNI, 134)));
});

test("the legend defines every modality word, in its own colour, and the limit column is gone from it", () => {
  const stub = new Proxy({}, { get: () => (x) => x });
  const text = legendLines({ dashMatch: "!" }, stub, { provenanceDot: () => "#" }).join("\n");
  for (const w of NAMES) assert.ok(new RegExp(`^ {13}${w.replace("?", "\\?")} `, "m").test(text), `legend defines ${w}`);
  assert.ok(/chat\?/.test(text) && /never guessed|unknown/i.test(text));
  assert.equal(/FREE-TIER LIMIT|'limit' column/.test(text), false);
  // and draws each word through the same colour table the rows use
  const p = painter({ ...detectCaps(UNI, 100), colours: 256 });
  const coloured = legendLines(glyphsFor(detectCaps(UNI, 100)), p, { provenanceDot: () => "#", modality: (w) => (modalityWord(w) ? p.raw(modalityHue(w, p), w) : w) }).join("\n");
  for (const w of NAMES) assert.ok(coloured.includes(`\x1b[38;5;${MODALITY_COLOURS[w].c256}m${w}\x1b[0m`), `legend shows ${w} in its colour`);
});

test("an old snapshot row with no outModality field draws `?` and nothing throws", () => {
  const old = { id: "old", ctx: 1, pin: 0, pout: 0, badge: "", tools: true, vision: true, reason: true, provenance: null, routable: true };
  const { v } = modelView([old]);
  const lines = frame(v, { providers: 1, models: 1 }, { caps: detectCaps(ASCII, 100) }).map(strip);
  const row = lines.find((l) => l.includes(" old"));
  assert.ok(row.includes(":?       :"), row);
});

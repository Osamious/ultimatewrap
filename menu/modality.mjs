// The PRIMARY OUTPUT MODALITY of a model route, as one short word for the picker's `modality`
// column, plus the source that decided it. Pure and import-free (no cycle with catalog.mjs,
// snapshot.mjs or style.mjs, which all need it).
//
// UNKNOWN STAYS UNKNOWN. A word is returned only from positive evidence about THIS route:
//   1. listing   the provider's own capability token (a live `image` outranks a bundle entry that
//                says `text`, exactly as `keysync.outputKind` already ranks them, so the two
//                labels cannot contradict each other about one row)
//   2. mode      the catalogue entry's LiteLLM `mode` (`embedding`, `image_generation`, ...): the
//                route's declared function
//   3. output    the catalogue entry's `modalities.output`, only when it names ONE modality; a
//                mixed list (`audio` + `text`, `image` + `text`) does not say which is primary
//   4. kind      `outputKind === "nontext"` with none of the above: known to be not chat, not
//                known what it is: `other`
// and, later, at snapshot build, a fresh `ok` bench record with none of the above: `chat?`
// (it answered a chat probe with text: a model that can chat, but not proof it is *only* a chat
// model, so the question mark). Nothing is ever inferred from an id, and a probe that FAILED
// ("not a chat model", "/v1/chat/completions") is not evidence of anything here.
//
// Every value is from the closed list below, so a hostile string in a listing or a tampered
// snapshot can never reach a terminal through this column (`modalityWord` refuses the rest).

export const MODALITY_WORDS = Object.freeze(
  ["chat", "chat?", "image", "audio", "video", "embed", "rank", "mod", "stt", "ocr", "live", "other"]);
export const MODALITY_SRCS = Object.freeze(["listing", "mode", "output", "kind", "bench-ok"]);

const own = (t, k) => (Object.hasOwn(t, k) ? t[k] : undefined);   // never `constructor` / `__proto__`
const norm = (s) => (typeof s === "string" ? s.trim().toLowerCase().replace(/[\s-]+/g, "_") : "");

// The listing's own capability token. Only modality words: `tool_calling`, `reasoning`, `base`,
// `model`, `web_search` are capability FLAGS or vendor tiers, not modalities, and stay no-signal
// (see keysync's CAPABILITY_* comment).
const CAP = Object.freeze({
  chat: "chat", completion: "chat", completions: "chat", text: "chat",
  image: "image", image_gen: "image", vision_gen: "image",
  video: "video", video_gen: "video",
  audio: "audio", audio_gen: "audio", speech: "audio", tts: "audio",
  stt: "stt", transcription: "stt", audio_to_text: "stt",
  embed: "embed", embedding: "embed", embeddings: "embed",
  rerank: "rank", reranker: "rank",
  moderation: "mod",
});
// The catalogue's LiteLLM `mode`.
const MODE = Object.freeze({
  chat: "chat", completion: "chat", responses: "chat",
  embedding: "embed", rerank: "rank", moderation: "mod",
  image_generation: "image", image_edit: "image",
  audio_speech: "audio", audio_transcription: "stt",
  video_generation: "video", ocr: "ocr", realtime: "live",
});
const OUT = Object.freeze({ text: "chat", image: "image", audio: "audio", video: "video", embedding: "embed", score: "rank" });

/**
 * @param {object|null} entry  the catalogue entry (`modalities.output`, `mode`), or null
 * @param {string|null} capability  the listing's capability token (`capabilityRaw`), or null
 * @param {string|null} outputKind  `"text" | "nontext" | null`
 * @returns {{v: string, src: string}|null}  null = unknown
 */
export function outputModalityOf(entry, capability, outputKind) {
  // `outputKind === "nontext"` is the picker's own verdict that this route is NOT a chat model (and it is what
  // dims the row and blanks its window), so a rung that would answer `chat` against it is skipped rather than
  // trusted: the label may never contradict the row's own treatment. The next rung, or `other`, decides.
  const notChat = outputKind === "nontext";
  const take = (v, src) => (v && !(notChat && v === "chat") ? { v, src } : null);
  const hit = take(own(CAP, norm(capability)), "listing") ?? take(own(MODE, norm(entry?.mode)), "mode");
  if (hit) return hit;
  const out = entry?.modalities?.output;
  if (Array.isArray(out) && out.length > 0) {
    const set = new Set(out.map(norm));
    if (set.size === 1) {
      const o = take(own(OUT, [...set][0]), "output");
      if (o) return o;
    }
  }
  if (notChat) return { v: "other", src: "kind" };
  return null;
}

/** A stored value, validated: a word from the closed list, or null (drawn as `?`). */
export const modalityWord = (v) => (MODALITY_WORDS.includes(v) ? v : null);

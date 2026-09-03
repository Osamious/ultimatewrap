// UltimateWrap keysync — regenerates CCR's Providers[] and Claude Code's
// modelPicker from the ~/.llmkeys vault.
//
// DEVIATION FROM THE PLAN, STATED UP FRONT: the plan specifies repurposing the
// existing Rust crate. This is implemented in Node instead, to get a working,
// testable regenerator without a compile loop. All of Phase 3's acceptance
// criteria are behavioural and are enforced below; a Rust port can follow.
//
// Safety: this writes CCR config and a settings.json. WHICH settings.json is
// decided entirely by --target. Never point it at a settings file a running
// Claude Code session depends on (see the 2026-09-01 outage).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------- vault load
const LLMKEYS = path.join(os.homedir(), ".llmkeys");
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));

export function loadVault() {
  const registry = readJson(path.join(LLMKEYS, "registry.json"));
  const providers = readJson(path.join(LLMKEYS, "providers.json"));
  return { registry, providers: new Map(providers.map((p) => [p.provider, p])) };
}

// ------------------------------------------------------------------- filter
// Plan's rules: exclude the sportsvector* buckets, the `management` tier, the
// `generic` protocol, and orphans with no provider profile.
export function filterRegistry(registry, providers) {
  return registry.filter((r) =>
    !/^sportsvector/i.test(r.bucket) &&
    r.tier !== "management" &&
    providers.has(r.provider) &&
    providers.get(r.provider).protocol !== "generic");
}

// --------------------------------------------------------------- tie-breaks
// The plan requires multi-key providers resolve to a DELIBERATELY CHOSEN key by
// name, never by an unexamined timestamp. Only two providers survive the filter
// with multiple keys. Both choices are recorded here with their reason.
export const KEY_CHOICES = {
  // 19-second timestamp gap would otherwise silently route the user's personal
  // traffic through an institutional (university) key. Prefer the personal one.
  groq: "personal.groq.free",
  // Both are personal buckets; pick the primary one explicitly.
  deepseek: "personal_maestro.deepseek.paid"
};

export function chooseKeys(filtered) {
  const byProvider = new Map();
  for (const r of filtered) {
    if (!byProvider.has(r.provider)) byProvider.set(r.provider, []);
    byProvider.get(r.provider).push(r);
  }
  const chosen = [];
  const ambiguous = [];
  for (const [provider, entries] of byProvider) {
    if (entries.length === 1) { chosen.push(entries[0]); continue; }
    const want = KEY_CHOICES[provider];
    const pick = entries.find((e) => e.id === want);
    if (!pick) { ambiguous.push({ provider, ids: entries.map((e) => e.id) }); continue; }
    chosen.push(pick);
  }
  if (ambiguous.length) {
    throw new Error(`multi-key provider(s) with no deliberate choice in KEY_CHOICES: ` +
      `${JSON.stringify(ambiguous)} — decide by name, do not let a timestamp decide.`);
  }
  return chosen;
}

// ------------------------------------------------------------------ catalog
const CATALOG_FILE = "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\models.json";

export function loadCatalog() {
  const doc = readJson(CATALOG_FILE);
  const byProvider = new Map();
  for (const m of doc.models ?? []) {
    if (!m.provider || !m.model) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { generatedAt: doc.generatedAt, byProvider };
}

/** free / paid / unknown — a guess is worse than no label, so default to unknown. */
export function inferTier(entry) {
  const p = entry.pricing ?? {};
  const nums = [p.inputPerMillion, p.outputPerMillion, p.input, p.output]
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return "unknown";
  return nums.every((v) => v === 0) ? "free" : "paid";
}

// ------------------------------------------------------------ protocol rule
// VERIFIED 2026-09-01: CCR resolves a provider's protocol from its base-URL HOST
// via a built-in registry, and that wins over an explicit `type` AND over
// `protocolDetectionMode: "manual"`. Writing a protocol CCR disagrees with
// produces a 404 (right provider, wrong wire format). So the base URL and the
// protocol must be chosen together, to match what CCR will pick anyway.
export function resolveProtocol(vaultProvider) {
  const base = (vaultProvider.baseUrl || "").toLowerCase();
  if (base.includes("generativelanguage.googleapis.com")) {
    return { type: "gemini_generate_content", baseUrl: "https://generativelanguage.googleapis.com/v1beta" };
  }
  if (base.includes("anthropic")) {
    return { type: "anthropic_messages", baseUrl: vaultProvider.baseUrl };
  }
  return { type: "openai_chat_completions", baseUrl: vaultProvider.baseUrl };
}

// --------------------------------------------------------------- build plan
const MAX_MODELS_PER_PROVIDER = Number(process.env.UW_MAX_MODELS ?? 3);

// A model Claude Code knows, whose client-side handling every keysync row
// borrows. Mid-tier on purpose: it must not imply capabilities (or a context
// window) that a small third-party model cannot honour.
const BEHAVES_AS = process.env.UW_BEHAVES_AS ?? "claude-sonnet-4-6";

/**
 * Anthropic via the local OAuth relay, added as a first-class provider.
 *
 * WHY THIS EXISTS: without it, keysync removes Claude from Claude Code entirely.
 * The vault has no `anthropic` key (the filter drops it as an orphan), so CCR
 * ends up with zero Anthropic providers; `applyProfile` then repoints every
 * model-alias env var at a third-party model and `replaceBuiltInOptions: true`
 * strips the built-in rows. The 2026-09-01 live cutover did exactly that and had
 * to be rolled back. The relay resolves the subscription token itself, so no
 * Anthropic credential is ever written into CCR's config.
 */
export const ANTHROPIC_RELAY = {
  name: "anthropic",
  provider: "anthropic",
  type: "anthropic_messages",
  api_base_url: process.env.UW_ANTHROPIC_RELAY ?? "http://127.0.0.1:4517",
  api_key: "relay-ignores-this",
  autoFetchModels: false,
  enabled: true,
  // Verified live through CCR 2026-09-02.
  models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001", "claude-fable-5-1"]
};

// Per-tier anchors, so Claude Code keeps its normal tiering (cheap models for
// background work) instead of pointing every tier at one model.
export const ANTHROPIC_TIERS = {
  model: "anthropic/claude-opus-5",
  opusModel: "anthropic/claude-opus-5",
  sonnetModel: "anthropic/claude-sonnet-5",
  haikuModel: "anthropic/claude-haiku-4-5-20251001",
  smallFastModel: "anthropic/claude-haiku-4-5-20251001",
  fableModel: "anthropic/claude-fable-5-1"
};

// The profile anchor serves Claude Code's own traffic — a full system prompt
// plus tool definitions — which small models reject outright. Fastest-is-best
// is the wrong rule here; prefer models observed to handle that payload.
export const ANCHOR_PREFERENCE = [
  "google/gemini-3.5-flash-lite",
  "mistral/mistral-small-latest",
  "openrouter/",
  "groq/openai/gpt-oss-20b",
  "cerebras/",
  "bigmodel/"
];

export function buildProviders(chosen, providers, catalog, keyReader) {
  const out = [];
  const picker = [];
  const notes = [];

  for (const reg of chosen) {
    const vp = providers.get(reg.provider);
    const { type, baseUrl } = resolveProtocol(vp);
    const catalogEntries = catalog.byProvider.get(reg.provider) ?? [];

    // MEASURED 2026-09-01: preferring catalog ids over the vault's testModel
    // dropped the live pass rate to 4/44 — the bundled catalog lists models a
    // given key/tier often cannot actually call (mostly upstream 404s). The
    // vault's testModel is the probe-verified known-good id for this key, so it
    // leads; catalog entries are appended as extras.
    const models = [];
    const seen = new Set();
    if (vp.testModel) {
      const cat = catalogEntries.find((m) => m.model === vp.testModel);
      models.push({
        id: vp.testModel,
        tier: cat ? inferTier(cat) : "unknown",
        contextTokens: cat?.limits?.contextTokens
      });
      seen.add(vp.testModel);
    }
    if (catalogEntries.length) {
      // Curate rather than dump: the picker is a flat list and 44 providers x
      // full catalogs is unusable. Prefer free-tier, then shortest id.
      const ranked = catalogEntries
        .map((m) => ({ m, tier: inferTier(m) }))
        .sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
          a.m.model.length - b.m.model.length);
      for (const { m, tier } of ranked) {
        if (models.length >= MAX_MODELS_PER_PROVIDER || seen.has(m.model)) continue;
        models.push({ id: m.model, tier, contextTokens: m.limits?.contextTokens });
        seen.add(m.model);
      }
    }
    if (!models.length) {
      notes.push(`${reg.provider}: no testModel and no catalog entry — skipped`);
      continue;
    }

    const name = reg.provider;
    out.push({
      name,
      provider: name,
      type,
      api_base_url: baseUrl,
      api_key: keyReader(reg.id),
      models: models.map((m) => m.id),
      autoFetchModels: false,
      enabled: true
    });

    for (const m of models) {
      const row = {
        model: `${name}/${m.id}`,
        label: `${name} > ${m.id}`
      };
      // "unknown" gets no description: a guess is worse than no label.
      if (m.tier !== "unknown") row.description = m.tier;
      // VERIFIED: without behavesAs, Claude Code does not recognize a
      // provider-format id, warns on every launch, and assumes a 200k context
      // window regardless of the model's real one. behavesAs names a model it
      // DOES know whose client-side handling (prompt profile) to reuse.
      row.behavesAs = BEHAVES_AS;
      if (m.contextTokens) row.contextTokens = m.contextTokens;
      picker.push(row);
    }
  }
  return { providers: out, picker, notes };
}

// ------------------------------------------------------------- validations
export function validate({ providers, picker }, expectedCount) {
  const problems = [];

  if (providers.length !== expectedCount) {
    problems.push(`expected exactly ${expectedCount} providers, got ${providers.length}`);
  }

  // Alias uniqueness: CCR matches a selector's provider half against several
  // fields; a collision makes array order silently decide routing.
  const aliases = new Map();
  for (const p of providers) {
    // A provider's own name/provider fields are deliberately equal; only a
    // collision BETWEEN different providers makes array order decide routing.
    const own = new Set([p.name, p.provider].filter(Boolean).map((a) => a.toLowerCase()));
    for (const k of own) {
      if (aliases.has(k) && aliases.get(k) !== p.name) {
        problems.push(`alias collision "${k}": ${aliases.get(k)} vs ${p.name}`);
      }
      aliases.set(k, p.name);
    }
  }

  // Every picker row must exist verbatim in that provider's models[].
  const configured = new Set(providers.flatMap((p) => p.models.map((m) => `${p.name}/${m}`)));
  for (const row of picker) {
    if (!configured.has(row.model)) problems.push(`picker row "${row.model}" not in Providers[].models`);
  }

  // No credential may be empty.
  for (const p of providers) {
    if (!p.api_key || typeof p.api_key !== "string") problems.push(`provider "${p.name}" has no api_key`);
  }

  return problems;
}

/**
 * CCR appends "[1m]" to model env vars for >=1M-context models.
 *
 * MEASURED, and narrower than it first appeared: Claude Code rejects the
 * suffixed id (`unrecognized_model`) only for models it does not know — i.e.
 * THIRD-PARTY ids. On a real Claude model `[1m]` is legitimate and even
 * correct, so blanket-stripping it discarded a valid 1M-context selection.
 * Strip third-party suffixes; leave anthropic/* alone.
 *
 * NOTE ON DURABILITY: this runs after CCR's applyProfile, but ANY later
 * CCR-initiated apply (gateway restart, supervisor restart, UI action) re-adds
 * the suffix. That is inherent and cannot be fixed from here. It only matters
 * when an anchor is third-party — which is why an Anthropic anchor is preferred
 * whenever the relay is up.
 */
export function stripOneMSuffix(settings) {
  let stripped = 0;
  for (const k of Object.keys(settings.env ?? {})) {
    const v = settings.env[k];
    if (typeof v !== "string" || !/\[1m\]$/i.test(v)) continue;
    if (/^anthropic\//i.test(v)) continue; // legitimate on a model Claude Code knows
    settings.env[k] = v.replace(/\[1m\]$/i, "");
    stripped += 1;
  }
  return stripped;
}

/**
 * `/model` writes the user's pick into settings.json ("saved as your default for
 * new sessions") — the same file keysync owns. Treat `model` as USER-owned:
 * preserve it while it still names a live picker row, and clear it once it has
 * gone stale, so a pruned row cannot leave the user pinned to a dead model.
 */
export function reconcileUserModelPin(settings, pickerRows) {
  const pinned = settings.model;
  if (typeof pinned !== "string" || !pinned) return { action: "none" };
  const valid = pickerRows.some((r) => r.model.toLowerCase() === pinned.toLowerCase());
  if (valid) return { action: "kept", pinned };
  delete settings.model;
  return { action: "cleared", pinned };
}

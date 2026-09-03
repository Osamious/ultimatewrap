//! Hand-authored stand-in data for the catalog and the credential vault.
//!
//! TODO(phase-0.5): replace `FIXTURE_CATALOG` with a real captured CCR
//! catalog sample. Phase 0.5.B.3 locates the catalog/pricing file this CCR
//! install actually ships (the `models.json` path assumed in earlier rounds
//! was confirmed not to exist on this machine), and the plan's Phase 3
//! acceptance criterion is only then measurable against real data. The menu,
//! search, tier inference and label rendering are all independent of that, so
//! this fixture unblocks them today rather than waiting.
//!
//! Swapping in captured data is NOT the only thing left, and this fixture is
//! deliberately more generous than reality. Two facts confirmed against CCR's
//! own source, so Phase 5 inherits them rather than rediscovering them:
//!
//!   * **No pricing.** CCR's `/v1/models` entries carry only
//!     `id, capabilities, created_at, display_name, max_input_tokens,
//!     max_tokens, type` - see `createClaudeAppGatewayModelsResponse` in
//!     `packages/core/src/gateway/features/model-discovery.ts`. There is no
//!     price or cost field anywhere on them, so `infer_tier` returns
//!     `Unknown` for every real row and the vault plan hint is the *only*
//!     claim available. Pricing must come from wherever Phase 0.5.B.3 locates
//!     it, not from the catalog response.
//!   * **No provider field.** Non-Anthropic-native models are exposed under an
//!     encoded route id, `anthropic/claude-ccr-h<hex>`
//!     (`CLAUDE_APP_ENCODED_ROUTE_PREFIX`, `packages/core/src/agents/
//!     claude-app/gateway-routes.ts`). `catalog::rows_from_json`'s
//!     `id.split_once('/')` fallback therefore collapses the whole catalog
//!     into one bogus `anthropic` group. Recovering the real provider name
//!     needs the inverse of `encodeClaudeAppGatewayRouteModel` - reference
//!     implementation `decodeClaudeAppGatewayRouteId`, `gateway-routes.ts:319`.
//!     That decode is **deliberately not implemented in this phase**; the
//!     `#[ignore]`d `real_ccr_shaped_catalog_collapses_into_one_bogus_group`
//!     test in `catalog.rs` pins the current behaviour so the gap stays
//!     tracked and visible.
//!
//! The catalog entries deliberately reproduce the exact pricing shapes
//! Maestro's own `infer_tier` tests were built from - a `:free` / `-free` /
//! `/free` suffixed id, nested-object pricing with quoted numbers, an
//! array-shaped `{value,unit}` pricing object, an all-zero pricing object,
//! and an entry with nothing price-shaped at all.
//!
//! `FIXTURE_REGISTRY` is a genuine subset: `personal.routllm.free`,
//! `personal.cerebras.paid` and `personal.xai.paid` are copied verbatim from
//! `~/.llmkeys/registry.json` (56 entries: 42 free, 13 paid, 1 management).
//! Those three providers appear in the catalog with **no** pricing signal, so
//! they are exactly the rows that exercise the provider-plan-hint fallback.

/// Stand-in for CCR's Anthropic-branch `/v1/models` body.
pub const FIXTURE_CATALOG: &str = r#"{
  "data": [
    { "id": "google/gemma-4-26b-a4b-it:free", "display_name": "Gemma 4 26B (free)", "provider": "openrouter", "context_length": 128000 },
    { "id": "openrouter/qwen3-max", "display_name": "Qwen3 Max", "provider": "openrouter",
      "pricing": { "prompt": "0.0000012000", "completion": "0.0000060000" } },
    { "id": "tokenrouter/qwen3.8-max-free", "display_name": "Qwen3.8 Max (free)", "context_length": 262144 },
    { "id": "orcarouter/free", "display_name": "OrcaRouter Free" },
    { "id": "mindai/macaron-v1-tall", "display_name": "Macaron v1 Tall", "provider": "orcarouter",
      "pricing": { "completion": [ { "value": 2.6, "unit": "perMTokens" } ],
                   "prompt": [ { "value": 0.9, "unit": "perMTokens" } ] } },
    { "id": "aion-labs/aion-3.0", "display_name": "Aion 3.0",
      "pricing": { "prompt": "0.0000030000", "completion": "0.0000060000" } },
    { "id": "nscale/zero-cost-model", "display_name": "Nscale Zero Cost",
      "pricing": { "prompt": 0, "completion": 0 } },
    { "id": "plainprovider/plain-model", "display_name": "Plain Model", "context_length": 128000 },

    { "id": "routllm/auto", "display_name": "RoutLLM Auto", "context_length": 200000 },
    { "id": "routllm/balanced", "display_name": "RoutLLM Balanced", "context_length": 200000 },
    { "id": "cerebras/llama-3.3-70b", "display_name": "Llama 3.3 70B", "context_length": 65536 },
    { "id": "cerebras/qwen-3-coder-480b", "display_name": "Qwen 3 Coder 480B", "context_length": 131072 },
    { "id": "xai/grok-4-fast", "display_name": "Grok 4 Fast", "context_length": 2000000 },
    { "id": "xai/grok-4-fast[1m]", "display_name": "Grok 4 Fast (1M context)", "context_length": 1000000 },

    { "id": "chutes/deepseek-v3", "display_name": "DeepSeek V3",
      "pricing": { "prompt": "0.0000002700", "completion": "0.0000011000" } },
    { "id": "chutes/mystery-model", "display_name": "Chutes Mystery Model", "context_length": 32768 }
  ],
  "first_id": "google/gemma-4-26b-a4b-it:free",
  "last_id": "chutes/mystery-model",
  "has_more": false
}"#;

/// Four entries copied verbatim from the real `~/.llmkeys/registry.json`.
pub const FIXTURE_REGISTRY: &str = r#"[
    {
        "id":  "personal.routllm.free",
        "provider":  "routllm",
        "bucket":  "personal",
        "tier":  "free",
        "envVarName":  "LLM_PERSONAL_ROUTLLM_FREE",
        "notes":  "",
        "added":  "2026-08-19T18:58:32"
    },
    {
        "id":  "personal.cerebras.paid",
        "provider":  "cerebras",
        "bucket":  "personal",
        "tier":  "paid",
        "envVarName":  "LLM_PERSONAL_CEREBRAS_PAID",
        "notes":  "",
        "added":  "2026-08-19T22:11:19"
    },
    {
        "id":  "personal.xai.paid",
        "provider":  "xai",
        "bucket":  "personal",
        "tier":  "paid",
        "envVarName":  "LLM_PERSONAL_XAI_PAID",
        "notes":  "",
        "added":  "2026-08-19T22:50:01"
    },
    {
        "id":  "personal.chutes.paid",
        "provider":  "chutes",
        "bucket":  "personal",
        "tier":  "paid",
        "envVarName":  "LLM_PERSONAL_CHUTES_PAID",
        "notes":  "",
        "added":  "2026-08-19T23:01:53"
    }
]"#;

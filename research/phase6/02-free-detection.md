# Research: free/paid determinability per provider (2026-09-02)

Method: unauthenticated `GET` probes only; no auth headers, no billed calls, no key values
read. 19 small-provider `/v1/models` endpoints plus 10 `/api/pricing` endpoints probed
live; docs used where endpoints returned 401/403.

## Governing definition (user-set)

> **A free model has 0 pricing AND a quota/limit that resets regularly.**
> A one-time starting wallet credit does NOT make a provider "free available".

Two axes, and only one is machine-readable:

| axis | values | machine-readable? |
|---|---|---|
| price | 0 / non-zero / unknown | **often yes** |
| **grant cadence** | recurring / one-time / none | **almost never** |

## Live probe results, `/v1/models`, unauthenticated

| Provider | Status | Models | Price/free signal |
|---|---|---|---|
| **nousresearch** | **200 public** | **378** | Full OpenRouter-clone schema + 2 extra fields |
| **routllm** | **200 public** | 12 | `pricing{input,output,cache_read,cache_write}` USD/M + `tier_required` |
| **commandcode** | **200 public** | 62 | **None** — `id, object, created, owned_by, name, context_length` |
| agnes, bai, bigmodel, bluesminds, fanar, gmicloudai, indeedwebid, nararouter, seekai, teamorouter, tokenharbor, tokenrouter, xai | 401 | — | docs give nothing per-model |
| gorouter, tabiai | 403 (bot-challenge HTML) | — | WAF-blocked; **do not probe** (notes warn of real Opus billing) |
| agentrouter | 401 (even with WAF headers) | — | — |

### The three that pay off

**NousResearch** — 378 models, clones OpenRouter's schema exactly, plus two fields
OpenRouter lacks:
- **`synthesizedFreeVariant: true`** on 5 models — explicit boolean free flag
- **`pricing.original{prompt, completion, web_search, input_cache_read, input_cache_write}`**
  on **367/378** — the pre-discount upstream price. Nous resells below cost.

Agreement is perfect: 6 zero-priced, 6 `:free`-suffixed, identical sets both directions.
The boolean covers only 5 of 6 (`meituan/longcat-2.0:free` is zero-priced and suffixed but
lacks the flag) — **the flag is a subset of price, not a replacement.**

**RoutLLM** — carries both a price and a plan gate; the cleanest state-1/state-2 specimen:
```
tier=1  anthropic/claude-fable-5     in=10    out=50
tier=1  openai/gpt-5.6-luna          in=0.2   out=1.2
tier=0  deepseek/deepseek-v4-flash   in=0.14  out=0.28
tier=0  minimax/minimax-m2.7         in=0.3   out=1.2
```
Every `tier_required: 0` model has a **non-zero** price. The free-plan key can call them;
the price is what a paid account is charged. Price alone says "paid" — right for a cost
column, wrong for "can I use this at no charge".
Fields: `id, object, owned_by, display_name, context_window, max_output_tokens,
tier_required, pricing{input,output,cache_read,cache_write},
capabilities{streaming,tools,vision,image_generation}`.

**CommandCode** — 62 models, publicly listable, **zero price information**. One `-free` id
(`poolside/laguna-s-2.1-free`). And all 62 return `400 insufficient credits` on a zero
balance, so even the suffix is not an entitlement.

## The New-API `/api/pricing` discovery

Several gateways run the open-source **New-API / One-API** codebase, which exposes an
**unauthenticated `/api/pricing`** route that `/v1/models` does not.

| Base | `/api/pricing` | Entries | Schema |
|---|---|---|---|
| `api.tokenrouter.com` | **200, 62 KB** | 134 | New-API standard |
| `router.bynara.id` (nararouter) | **200, 27 KB** | 54 | custom, richer |
| `agentrouter.org` | **200, 1.1 KB** | 5 | New-API standard |
| seekai 401 · tabitoken 403 · b.ai 403 · tokenharbor/teamorouter/ineed/aihubmix 404 | — | — | — |

**New-API schema**: per entry `model_name, quota_type, model_ratio, completion_ratio,
model_price, cache_ratio, create_cache_ratio, audio_ratio, enable_groups[],
supported_endpoint_types[], vendor_id, tags, owner_by`; top level `group_ratio`,
`usable_group`, `tiered_pricing`, `candidates_pricing`, `vendors`.

### THE LANDMINE

`model_price: 0` does **not** mean free. It is only used when `quota_type == 1` (per-call
fixed pricing); for `quota_type == 0`, billing runs off `model_ratio × group_ratio`.

```
correct:  (quota_type == 0 && model_ratio == 0) || (quota_type == 1 && model_price == 0)
```

| | naive `model_price == 0` | correct test |
|---|---|---|
| tokenrouter | **123 of 134** | **3**: `z-ai/glm-5.3-free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`, `stealth/ox-alpha` |
| agentrouter | **5 of 5** (incl. `claude-opus-4-8` at `model_ratio: 4`) | **0** |

A naive parser labels **every Claude Opus model on agentrouter as free**. Note
`stealth/ox-alpha` — genuinely free, **no suffix**: another recall failure for the
id convention.

### Nara Router: the case that kills the boolean

Custom schema: `alias, display_name, input_credit_per_1k, output_credit_per_1k,
cache_read_credit_per_1k, supports_streaming, supports_vision, supports_image_generation,
supports_video_generation, reasoning, max_context_tokens, payg_enabled,` **`free_for_paid`**`,`
**`free_min_balance`**`, quota_weight, quota_weight_input, quota_weight_cache,
official_in_usd_m, official_out_usd_m`; top level `usd_to_idr: 17765`.

```
free_for_paid=True (6 models) — every one has a NON-ZERO credit price:
  deepseek-v4-flash-free   in=0.157  out=0.315   free_min_balance=10000
  glm-5.3-flash-free       in=0.266  out=0.887   free_min_balance=10000
  glm-5.3-free             in=7.435  out=23.366  free_min_balance=15000
  glm-5.2-promo            in=5.125  out=16.106  free_min_balance=30000
  mimo-v2.5-free           in=0.150  out=1.501   free_min_balance=10000
  qwen3.8-flash-free       in=0.799  out=2.502   free_min_balance=5000
```

Free **conditional on holding a minimum balance**. Suffix present, price says paid, truth
is neither.

The 5 genuinely zero-credit Nara models are all **image/video**: `agnes-image-2.0-flash`,
`agnes-image-2.1-flash`, `agnes-video-v2.0`, `grok-imagine`, `nano-banana-pro`. **Zero
*token* price on a non-text-output model means billed per image/second in a different
unit** — generalise this as a guard.

## Suffix convention reliability

| Convention | Providers |
|---|---|
| `:free` | nousresearch (6, perfect agreement), tokenharbor, tokenrouter, openrouter, kilo, zenmux |
| `-free` | tokenrouter, nararouter, teamorouter, commandcode, bai, seekai, aihubmix, opencode |
| `/free` | orcarouter, kilo |
| `-promo` | nararouter — same semantics as its `-free` |
| **No suffix, genuinely free** | tokenrouter `stealth/ox-alpha`; gmicloudai (`is_free` flag); agnes (platform-wide) |
| **Suffix, NOT free** | **nararouter — all 6, priced + balance-gated**; pollinations community re-exports |
| **"free" = ACCOUNT PLAN, not models** | routllm (`tier_required`), llm7 (`tier` ∈ {pro, turbo}; **no `free` value exists**) |

Measured precision: openrouter 18/18, nousresearch 6/6, tokenrouter 2/2 — but
**nararouter 0/6** and **pollinations 0/13**.

OpenRouter measured: 421 models, 21 zero-priced, 18 `:free`-suffixed.
**Precision 100%, recall 86%.** The three misses: `openrouter/free` (meta-model),
`google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`. The suffix namespace is
generic — the catalogue also carries **66 `:batch`-suffixed** models.

## Rate-limit headers — measured, and the answer is no

Full response headers captured on all 19 small-provider probes and 12 majors
(openrouter, huggingface, novita, pollinations, venice, chutes, llm7, groq, together,
mistral, xai, cerebras) with `-D -`, grepping `ratelimit|rate-limit|retry-after|x-credit`.
**Zero matches, on 200s and 401s alike.**

Rate-limit headers live on **inference** endpoints only:
- **Groq**: `x-ratelimit-limit-requests` (RPD), `-limit-tokens` (TPM), `-remaining-*`, `-reset-*` — docs say "always included"; `retry-after` on 429 only
- **OpenRouter**: `X-RateLimit-Limit/Remaining/Reset`, `Retry-After` — **429 only**
- OpenAI / Anthropic / Mistral / Cerebras — documented families, not probed

**Consequence**: headers are useless as a catalogue-build signal, because reading them
requires the billed call we are avoiding. Groq's free-tier state is visible *only* there —
which is exactly why Groq must be blank.

Two non-header quota signals that ARE free to read:
- **Pollinations** — `per_user_rpm` on 210/362 models, in the models response
- **OpenRouter** — `GET /api/v1/key` (`limit_remaining`, `usage_daily`, `is_free_tier`) — auth required, not billed

## models.dev coverage of the 23 uncovered providers — only 7

| Covered | models.dev id | models | zero-cost |
|---|---|---|---|
| agentrouter | `agentrouter` | 3 | 0 (all 3 have **no** `cost` field) |
| agnes | `agnes` | 3 | 2 |
| bigmodel | `zhipuai` | 15 | 2 |
| gmicloudai | `gmicloud` | 15 | 0 — **contradicts the provider's own `is_free` flag** |
| tokenrouter | `tokenrouter` | 1 | 1 — but only **1 of 134** models indexed |
| veniceai | `venice` | 101 | 0 |
| xai | `xai` | 12 | 0 (5 have no `cost`) |

**Absent (16 of 23)**: aionlabs, bai, bluesminds, commandcode, fanar, gorouter,
indeedwebid, llm7, nararouter, nousresearch, pollinations, routllm, seekai, tabiai,
teamorouter, tokenharbor.

Calibration warnings: presence ≠ useful coverage (tokenrouter 1/134); and **first-party
beats models.dev whenever both exist** (gmicloud).

## Distinguishing "subscription-covered" from "free PAYG"

Machine-readable for a handful; generally **must be curated**.

| Provider | Field | Semantics |
|---|---|---|
| **nararouter** | `free_for_paid` + `free_min_balance` | free iff balance ≥ threshold; price non-zero |
| **routllm** | `tier_required` (0/1) | 0 = included in free plan, priced anyway |
| **New-API family** | `enable_groups[]` + `group_ratio` | your key's group sets the multiplier; can be 0 |
| **OpenRouter** | `GET /api/v1/key` → `is_free_tier` | account-level, not per model |
| **huggingface** | `providers[].is_free` | true state-1 flag, currently 0/314 true |
| **nousresearch** | `synthesizedFreeVariant` | marks a free variant derived from a paid model |

Structural reason it usually cannot be derived: state 2 is a property of
**(model × your account's plan/balance/group)**, and a models endpoint is keyed on model
alone. Cloudflare is the clean illustration — 10,000 Neurons/day free on both plans, yet
`@cf/moonshotai/kimi-k2.6`, `@cf/zai-org/glm-5.2`, `@cf/deepseek-ai/deepseek-v4-pro-0813`
require paid billing regardless, and that carve-out exists **only in an HTML doc table**.

Curated annotation is unavoidable for at least: cloudflare, ollama-cloud, google, groq,
nvidia, cerebras, opencode (time-limited promo), agnes ("currently free"), aihubmix,
huggingface (monthly credit allowance). **Every curated entry needs an expiry** — opencode's
promo list and agnes's free status are both dated 2026-08 with no machine-readable end date.

## Recommended schema

```
free_state          ∈ { zero_price, plan_covered, quota_covered, paid, unknown }
free_state_source   ∈ { api_price, api_flag, api_plan_field, curated, absent }
free_state_verified_at : timestamp        # curated entries also carry an expiry
```

## Precedence order — first rule that fires wins; none fires ⇒ BLANK

```
P0  GUARDS — force BLANK regardless of anything below
    G1  output modality includes image/audio/video AND the zero price is a *token* price
        → billed in a different unit (nararouter agnes-image-*, grok-imagine, nano-banana-pro)
    G2  New-API source parsed with the naive model_price==0 test → invalid
    G3  internal/staging id (ai_infer_test_*, dev/*, gt-4p, bunny) or non-available status
        (novita status==4, fireworks state!=READY)
    G4  provider on the "catalogue lies" list (b.ai, commandcode, veniceai, indeedwebid,
        tabiai, gorouter) → listing is not an entitlement

P1  FIRST-PARTY EXPLICIT ZERO PRICE → free
    both input and output token prices present AND both == 0.
    openrouter · nousresearch · novita · venice · chutes · together · sambanova ·
    aionlabs · llm7 · routllm · New-API (correct predicate)

P2  FIRST-PARTY EXPLICIT BOOLEAN FLAG → free
    gmicloudai is_free · huggingface providers[].is_free · nousresearch synthesizedFreeVariant
    Ranked below P1 because on Nous the flag covers 5 of 6 zero-priced models.

P3  FIRST-PARTY PLAN/BALANCE FIELD → free_state = plan_covered, boolean BLANK
    nararouter free_for_paid+free_min_balance · routllm tier_required==0 ·
    New-API enable_groups + group_ratio==0

P4  CURATED ANNOTATION with a live-probe date → free, confidence=medium
    requires named model ids, verified_at, and an expiry.
    Expired → demote to BLANK, never to false.

P5  THIRD-PARTY CATALOGUE (models.dev) → free, confidence=low
    only when cost{input,output} BOTH present AND both == 0.
    Never when the cost field is absent (ollama 22/22, agentrouter 3/3).
    Never for nvidia (99/103 zeros encode a credits grant).
    Never import LiteLLM zeros at all — there 0 means "unset" (130 entries, mostly rerank/LoRA).
    First-party wins any disagreement.

P6  ID SUFFIX ALONE → BLANK, flag for review
    Never promote a suffix to true on a provider with no price feed.

P7  NOTHING FIRED → BLANK
```

## When the answer must be BLANK

Never write `No`/`false` for any of these:

1. **No price field anywhere** — NVIDIA NIM (82 models, 4 fields), Cerebras, Groq, DeepSeek, Google Gemini, Mistral, Alibaba/DashScope, **commandcode**, GitHub Copilot.
2. **Endpoint unreachable / schema unverified** — Nebius, Hyperbolic (401, no doc found); gorouter, tabiai (WAF, and probing bills Opus).
3. **Price present but partial** — HuggingFace's 106/314 rows with no `pricing` dict; `is_free:false` there is asserted without a price behind it.
4. **Non-USD unit with no conversion** — Pollinations (pollen), Cloudflare (Neurons), nararouter credits, Chutes (TAO).
5. **Zero token price on a non-text-output model** (G1).
6. **Plan- or balance-gated** (P3).
7. **Catalogue known not to reflect entitlement** (G4).
8. **Suffix is the only evidence** (P6).
9. **Curated annotation past its expiry.**

### Where `false` IS safe

Only when a first-party price feed returned **both** token prices, at least one non-zero,
for a text-output model, from a provider not on the G4 list: openrouter, nousresearch,
novita (status 1), venice, chutes, together, sambanova, aionlabs, llm7, routllm, and
correctly-parsed New-API gateways. Nowhere else.

## Major-provider `/v1/models` capability summary

| Provider | Models | Pricing in response? | Free signal |
|---|---|---|---|
| OpenRouter | 421 | **Yes** — `pricing.prompt/completion` decimal strings USD/token | `"0"` + `:free` |
| Hugging Face | 136 (314 rows) | Partial — 208/314 rows | **`providers[].is_free`** on all rows |
| Novita | 154 | **Yes** — `input_token_price_per_m` etc. | price 0 (unreliable) |
| Venice AI | 112 | **Yes** — `model_spec.pricing.*.{usd,diem}` | none zero |
| Chutes | 14 | **Yes** — `pricing.*` USD/M and `price.*.{tao,usd}` | none zero |
| Pollinations | 362 | In "pollen" | none zero; `per_user_rpm` on 210 |
| LLM7 | 44 | **Yes** — `pricing.*`, `pricing_mode` ∈ {token,second,image} | `tier` ∈ {pro,turbo}, no `free` |
| AionLabs | 4 | **Yes** | none zero |
| NVIDIA NIM | 82 | **No** — id/object/created/owned_by only | none |
| SambaNova | 7 (public subset) | **Yes** — USD/token strings | none zero |
| Groq | — | **No** — has `context_window`, `max_completion_tokens`, `active` | none |
| DeepSeek | — | **No** — id/object/owned_by only | none |
| Together | — | **Yes** — `pricing{hourly,input,output,base,finetune}` | — |
| Fireworks | — | control-plane only; `deprecationDate`, `state`, SKU pricing | — |
| Mistral | — | **No** — but `capabilities{}`, `max_context_length`, **`deprecation`** + replacement | none |
| Google Gemini | — | **No** — `inputTokenLimit`, `outputTokenLimit`, `thinking` | none |
| Cloudflare | — | `/v1/models` **405**; native search supports `format=openrouter` | — |

## Per-model metadata beyond free/paid

| Field | Reliably from |
|---|---|
| **Context window** | OpenRouter (`context_length` + `top_provider.context_length`), Together, Groq (`context_window`), Mistral (`max_context_length`), Gemini (`inputTokenLimit`), Fireworks, Novita, Venice, Chutes, SambaNova, LLM7, AionLabs, HF, Pollinations (166/362) |
| **Max output** | OpenRouter (`top_provider.max_completion_tokens`), Groq, Gemini, Novita, Venice, SambaNova, Chutes, AionLabs |
| **Modality** | OpenRouter (`architecture.modality`, `input_modalities[]`, `output_modalities[]`), HF, Novita, Chutes, Pollinations, Venice, LLM7, Mistral, Fireworks |
| **Created / release** | OpenRouter (`created` Unix), Together, Groq, Mistral, Novita, Venice, Chutes, HF, Pollinations, AionLabs (`date` ISO). NVIDIA values unreliable; **Cerebras docs show `created: 0` — do not trust** |
| **Deprecation** | Mistral (`deprecation` + `deprecation_replacement_model`), AionLabs (`expires_at` + `replacement_model_id`), Fireworks (`deprecationDate` + `state`), Cloudflare (`include_deprecated`), Novita (`status: 4`, inferred), OpenRouter (`expiration_date`, only 10/421) |
| **Availability** | OpenRouter `/models/{slug}/endpoints` (`uptime_last_30m/5m/1d`, `status`), LLM7 (`availability_last_hour_percent`), HF (`providers[].status`, `first_token_latency_ms`, `throughput`), Venice (`model_spec.offline`) |
| **Tools / structured output** | OpenRouter (`supported_parameters[]`), HF, Novita (`features[]`), Chutes, Venice, Mistral, Fireworks, LLM7 |
| **Reasoning** | OpenRouter (`reasoning.{mandatory,default_enabled}` on 294/421 — actionable: mandatory-reasoning models return empty content unless `max_tokens >= 512`), Novita, Venice, LLM7, AionLabs |
| **Benchmarks** | OpenRouter only (`benchmarks.artificial_analysis.*` on 240/421) |

## OpenRouter schema detail (richest case, verified on a live 421-model response)

Top level `{data:[...], total_count, links}`. Per-model, all 421/421:
`id, canonical_slug, hugging_face_id, name, created, description, context_length,
architecture, pricing, top_provider, per_request_limits, supported_parameters,
default_parameters, supported_voices, knowledge_cutoff, expiration_date, links`.
Optional: `reasoning` (294), `benchmarks` (240), `alias_target` (13).

`pricing` subfields by presence: `prompt` 421, `completion` 421, `input_cache_read` 254,
`web_search` 151, `input_cache_write` 75, `overrides` 60, `audio` 32,
`input_cache_write_1h` 31, `internal_reasoning` 30, `image` 29, `input_audio_cache` 27,
`image_output` 9, `audio_output` 2.

`per_request_limits` was **null on all 421** and no `request` key appeared — do not depend
on either.

A free model's `pricing` collapses to **only** `prompt` and `completion` — that absence is
itself a weak secondary signal.

`:free` rate limits (documented): 20 req/min regardless; 50 req/day under 10 lifetime
credits purchased, 1,000 req/day at ≥10.

Sub-resource `GET /api/v1/models/{canonical_slug}/endpoints` → `endpoints[]` with
`provider_name, tag, quantization, context_length, max_completion_tokens,
max_prompt_tokens, pricing.{prompt,completion,discount}, status, uptime_last_30m/5m/1d,
supports_tool_choice, supports_implicit_caching`.

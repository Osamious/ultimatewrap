# Research: quota, billing endpoints, payment taxonomy and display (2026-09-02)

Method: 47 providers × 20 candidate paths (GET, no auth), then a **control probe** on a
nonsense path, then a third pass with a deliberately invalid key to learn *which credential*
each endpoint accepts. `tabitoken.com` and `gorouter.app` excluded at the URL-builder level
and never contacted.

## The control probe changes how every 401 reads

**Six providers return 401/403 for every path, including nonexistent ones** — so a 401 there
is not evidence an endpoint exists.

| Provider | Nonsense-path result | Verdict |
|---|---|---|
| deepseek | 401 `Authentication Fails (governor)` | auth wall before routing |
| cohere | 401 `no api key supplied` | auth wall before routing |
| bigmodel (`/api/paas/v4/*`) | 401 | auth wall before routing |
| nararouter (`/v1/*`) | 401 `A valid API key is required.` | auth wall (its `/api/*` discriminates: 404) |
| youcom | 403 `Missing Authentication Token` | API Gateway default |
| b.ai | 403 `HTTP node only allows access to inference API paths (/v1/chat/completions, /v1/messages, /v1/responses, /v1/models, /v1/images/*)` | **explicitly states there is no account API** |
| agnes (`/api/*`) | 403 Cloudflare challenge | WAF; its `/v1/*` discriminates |
| openrouter (`/api/*`) | **200 SPA HTML** | the `/api/pricing` and `/api/status` 200s on openrouter are the marketing site, not an API. `/api/v1/*` discriminates (404) |
| gmicloud, sambanova, kilo, cloudflare | 405 on nonsense | 405 is their "no route" marker |
| routllm | 500 `Only HTML requests are supported here` | indeterminate |
| everyone else | 404 | **401 there IS proof of existence** |

## A. New-API / One-API gateways — 7 in this vault, not 3

Fingerprinted by `X-New-Api-Version` / `X-Oneapi-Request-Id` / vendor forks: **seekai**
(`v1.0.0-rc.25`), **bluesminds** (`v1.0.0-rc.21`), **tokenrouter**, **orcarouter**
(`X-Orca-Version`), **agentrouter**, **aihubmix** (`x-aihubmix-request-id`), **agnes**
(`AgnesAI_error`).

| Path | Auth | Billed | Observed | Fields |
|---|---|---|---|---|
| `GET /v1/dashboard/billing/subscription` (also without `/v1`) | **the `sk-` API key** — proven live (fake key flips "Token not provided" → "Invalid token") and in source: `router/dashboard.go` wraps it in `middleware.TokenAuth()` | no | 401 on all 7 | `object:"billing_subscription"`, `has_payment_method`, `soft_limit_usd`, `hard_limit_usd`, `system_hard_limit_usd`, `access_until` |
| `GET /v1/dashboard/billing/usage` | same | no | 401 on all 7 | `object:"list"`, `total_usage` |
| `GET /api/pricing` | **public unless the operator gates it** | no | **200**: tokenrouter, orcarouter, bluesminds, agentrouter, nararouter(custom). **401**: seekai. **404**: aihubmix. **403 WAF**: agnes | see below |
| `GET /api/status` | **public** | no | 200 on all 6 reachable | `quota_per_unit`, `quota_display_type`, `usd_exchange_rate`, `custom_currency_symbol`, `display_in_currency`, `checkin_enabled`, `price`, `stripe_unit_price`, `top_up_link`; orcarouter-only `promo_credit_enabled`, `promo_credit_default_expires_days`, `signup_grants`, `signup_grant_remaining`, `quota_for_new_user`, `drop_banner_enabled`/`drop_claim_path`/`drop_ends_at`, `boost_enabled`, `byok_enabled`; agentrouter-only `quota_for_invitee`/`quota_for_inviter`, `min_topup` |
| `GET /api/user/self` | **web session / access token — NOT the API key** (proved: sending the sk- key still returns `Session validation failed. Please log in again.`) | no | 401 | `quota`, `used_quota`, `request_count`, `group`, `aff_code`, `aff_count`, `aff_quota`, `aff_history_quota`, `inviter_id`, `stripe_customer`, `permissions` (`controller/user.go:538 buildSelfUserData`) |
| `GET /api/user/self/groups`, `/api/user/models`, `/api/user/dashboard` | session | no | 401 | group list / per-user model list |
| `GET /api/subscription/plans`, `/api/subscription/self` | session | no | **401** tokenrouter, orcarouter, bluesminds, seekai; **404** agentrouter, aihubmix | a real subscription system on 4 of 7 |
| `GET /api/ratio_config` | public when enabled | no | **200** bluesminds only; **403 "ratio configuration endpoint is disabled"** on the rest | `cache_ratio{}`, `completion_ratio{}`, `model_ratio{}` |

**Actionable:** `/api/status` → `HeaderNavModules.pricing.requireAuth` **predicts** whether
`/api/pricing` is public. seekai publishes `requireAuth:true` and returns 401; tokenrouter
publishes `false` and returns 200. Source: `router/api-router.go:35` —
`apiRouter.GET("/pricing", middleware.HeaderNavModuleAuth("pricing"), controller.GetPricing)`.

**The non-obvious win:** `/api/user/self` is unreachable from an API key, so for those 7
gateways the *only* credential-compatible balance path is the OpenAI-compatible billing pair.
**A plain `sk-` key gets you a USD balance on tokenrouter, orcarouter, bluesminds,
agentrouter, seekai, aihubmix and agnes.**

## B. First-party account endpoints proven real (401/400 with a bad key, 404 on nonsense)

| Provider | Endpoint | Auth | Billed |
|---|---|---|---|
| openrouter | `GET /api/v1/key`, `/credits`, `/activity`, `/keys`, `/auth/key` | `sk-or-` Bearer | no |
| chutes | `GET /users/me`, `/users/me/quotas`, `/users/me/discounts`, `/users/me/price_overrides`, **`/users/me/quota_usage/{chute_id}`** on `api.chutes.ai` (a **different host** from the inference base) | `cpk-` Bearer | no |
| veniceai | `GET /api/v1/api_keys`, `/api_keys/rate_limits`, `/api_keys/rate_limits/log`, `/billing/usage-history` | Bearer or x402 wallet sig | no |
| veniceai | `GET /api/v1/billing/usage` | — | **410 Gone**: *"sunset on 2026-09-16 … Use GET /api/v1/billing/usage-history"* |
| deepseek | `GET /user/balance` (no `/v1`) | Bearer | no |
| xai | `GET /v1/api-key`, `/v1/language-models` | Bearer | no |
| llm7 | `GET /v1/balance` | Bearer | no |
| orcarouter | `GET /v1/balance` (in addition to New-API routes) | Bearer | no |
| teamorouter | `GET /v1/usage`, `/api/user/self`, `/api/user/dashboard` | `x-api-key: sk-teamo-*` or Bearer OAuth/session | no |
| openai | `GET /v1/me`, `/usage`, `/organization/costs`, `/organization/usage/completions`, `/organization/projects`, `/dashboard/billing/subscription`, `/dashboard/billing/credit_grants` | Bearer (org/admin for `/organization/*`) | no |
| anthropic | `GET /v1/organizations/me`, `/cost_report`, `/usage_report/messages`, `/api_keys` | `x-api-key` **admin** key | no |
| huggingface | `GET https://huggingface.co/api/whoami-v2` | Bearer HF token | no — **and it carries `ratelimit: "api";r=9997;t=104` and `ratelimit-policy: "fixed window";"api";q=10000;w=300`** |

## C. Confirmed absent (not "unknown")

- **groq** — `/openai/v1/usage` → explicit `Unknown request URL`. Limits readable only from inference `x-ratelimit-*` headers or the HTML console.
- **cerebras** `/v1/usage` 404; **mistral** `/v1/billing` 404; **nscale, sambanova, nvidia, google, cloudflare, fanar, aionlabs, ollama, opencode, commandcode, tokenharbor, indeedwebid, gmicloudai, zenmux, kilo, alibaba, pollinations, nousresearch** — no account/balance/quota path on any of 20 probed shapes.
- **b.ai** — the gateway states it exposes inference paths only.
- **githubcopilot** — no base URL; account state is `GET https://api.github.com/user` + `X-OAuth-Scopes`.
- **youcom, cohere, bigmodel, nararouter, deepseek (path existence), routllm** — cannot be determined unauthenticated. deepseek is nonetheless documented.

## 2. Balance / wallet — exact fields and units

**Seven different units across 12 providers. This is the most dangerous thing here.**

| Provider | Endpoint | Fields | Unit |
|---|---|---|---|
| **New-API ×7** | `/v1/dashboard/billing/subscription` | `hard_limit_usd` = `soft_limit_usd` = `system_hard_limit_usd` | **USD**, computed as `(remain_quota + used_quota) / quota_per_unit` — *lifetime granted*, not remaining. `access_until` = token expiry epoch (0 = never) |
| | `/v1/dashboard/billing/usage` | `total_usage` | **US cents** (`controller/billing.go`: `TotalUsage: amount * 100`) |
| | → derived | **remaining USD = `hard_limit_usd` − `total_usage`/100** | the only way to get a balance with just the `sk-` key |
| | `/api/status` | `quota_per_unit` | **500000** on tokenrouter/orcarouter/agentrouter/seekai/aihubmix; **1000000** on bluesminds. **Quota units are not comparable across gateways — fetch per provider** |
| **⚠ SENTINEL** | | `hard_limit_usd == 100000000` | means **unlimited**, not $100M (`if token.UnlimitedQuota { amount = 100000000 }`) |
| **openrouter** | `/api/v1/key` | `limit`, `limit_remaining` (null = unlimited), `limit_reset`, `usage`, `usage_daily/weekly/monthly`, `byok_usage*`, `include_byok_in_limit`, `is_free_tier` | **"credits"** — docs never equate 1 credit to $1. **Do not label it USD** |
| **deepseek** | `/user/balance` | `is_available`, `balance_infos[].currency` (`CNY`\|`USD`), `.total_balance`, `.granted_balance`, `.topped_up_balance` — **strings** | CNY or USD. `granted_balance` = "total **not expired** granted balance" → an expiring grant |
| **veniceai** | `/api/v1/api_keys/rate_limits` | `data.balances.USD`, `.DIEM`, `accessPermitted`, `apiTier.{id,isCharged}`, `keyExpiration`, `nextEpochBegins` | **USD and DIEM** (staked token; 1 DIEM = $1/day of credits) |
| **chutes** | `/users/me`, `/users/me/quotas` | **cannot be determined** — docs list paths and status codes, no schema | expect **TAO and USD** (catalogue is dual-denominated) |
| **llm7** | `/v1/balance` | **cannot be determined** | catalogue prices `USD` per `1M tokens` |
| **orcarouter** | `/v1/balance` | **cannot be determined** | — |
| **teamorouter** | `/v1/usage` | **cannot be determined** | — |
| **nararouter** | catalogue only | `input_credit_per_1k`, `free_min_balance`, top-level `usd_to_idr: 17765.00147` | **credits pegged to IDR.** `free_min_balance: 15000` is 15000 credits, not dollars |
| **pollinations** | catalogue only | `pricing.currency: "pollen"` on all 362 | **pollen** — a private currency |
| **xai** | `/v1/api-key` | key metadata (`acl`, blocked flags); **no balance field documented** | — |
| **huggingface** | none | **HTML only** (`/settings/billing`) | USD |

### Against `requiresBalance: true` (16 providers)

**Readable with the vault credential (8):** seekai, tokenrouter, teamorouter, chutes,
veniceai, aihubmix, orcarouter, bluesminds.
**Not readable (7):** zenmux, routllm, pollinations, opencode, cerebras, xai, sambanova,
commandcode, bai (gateway refuses non-inference paths). **Unprobed (1):** gorouter.

**HTML-dashboard-only (flag these — no API):** groq, huggingface, zenmux, routllm, opencode,
cerebras, sambanova, commandcode, tokenharbor (`tokenharbor.ai/dashboard`, named in its own
401 body), b.ai, aihubmix's *raw* quota.

## 3. Per-model remaining quota — two real exceptions

**Per-account only for 45 of 47.** Two exceptions, both authenticated, neither billed:

- **Chutes — `GET https://api.chutes.ai/users/me/quota_usage/{chute_id}`**, documented as *"Check the current quota usage for a chute."* A chute is a deployed model, so this is genuinely per-model **usage**. Verified: 401 with a bad key, 404 on a sibling nonsense path. Response schema **cannot be determined**. Chutes also advertises `X-Chutes-Quota-Total/-Used/-Remaining`, `X-Chutes-RL-User`, `X-Chutes-RL-Chute` in `access-control-expose-headers` — `RL-Chute` implies a per-model counter, but which responses carry them cannot be determined without an inference call.
- **Venice — `GET /api/v1/api_keys/rate_limits`** returns `rateLimits[]` of `{apiModelId, rateLimits:[{amount, type}]}` with `type ∈ {RPM, RPD, TPM}`, plus `nextEpochBegins`. **A per-model limit ceiling with a reset time**, for all models, from one unbilled call.

Everything genuinely "you have N left today":
- **OpenRouter `/api/v1/key`** → `limit_remaining` + `usage_daily/weekly/monthly` + `limit_reset`. Per key, not per model. Free-tier rule numerically: `:free` = **20 req/min**, **50 req/day** under 10 lifetime credits, **1000 req/day** at ≥10.
- **New-API ×7** → remaining USD as derived above. Per token or per user.
- **Groq** → `x-ratelimit-*` on **inference responses only** — unreadable without spending. Enforced at the *organization* level.
- **Pollinations `per_user_rpm`** — present on **89 of 362** models today (values 2-320, modal 10 on 37). Differs from the 210/362 recorded earlier — **the catalogue moved.** It is a **ceiling, not a remaining count**.

**Nothing anywhere returns per-model *remaining* except Chutes.**

## 4. Payment-tier taxonomy — three orthogonal enums, not one

A single enum cannot be both complete and non-overlapping. Structurally, *how a model is
priced*, *whether the account can call it now*, and *what free money is attached to the
account* are three independent facts that real providers combine freely. Nara Router publishes
models simultaneously priced, free, and gated. Hugging Face charges full price for every model
while granting $0.10/month of recurring free money. Forcing those into one column produces
exactly the wrong labels the governing rule exists to prevent.

### 4A. `pay_tier` — how this *model* is priced (per model, mutually exclusive)

| Value | Definition | Detection | Real example |
|---|---|---|---|
| `free_recurring` | Price 0 **and** a quota that resets on a fixed cadence. **The governing definition.** | first-party price 0 **AND** curated `grantCadence: recurring` (or `/api/status.checkin_enabled`) | openrouter `google/gemma-4-26b-a4b-it:free` (18 `:free` of 421, 20 rpm / 50-1000 rpd, daily); kilo `isFree:true` (**19 of 365**); orcarouter `is_free_tier:true` (**3 of 186**); tokenrouter (**3 of 134**); ollama cloud |
| `free_promo` | Price 0 but time-boxed | **curated**, or `/api/status.drop_ends_at` / `promo_credit_default_expires_days` | opencode Zen `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free` |
| `plan_covered` | List price > 0, marginal price 0 because a subscription covers it | **curated**; partially `tier_required` | githubcopilot (all); nvidia 99/103; alibaba-token-plan 26/26; routllm `tier_required:0` on a paid plan |
| `balance_gated_free` | Feed price non-zero, free above a wallet threshold | first-party fields | nararouter — **6 models**: `deepseek-v4-flash-free` (in=0.157, floor 10000, `free_for_paid:true`), `glm-5.3-free` (7.435, 15000), `glm-5.3-flash-free`, `mimo-v2.5-free`, `qwen3.8-flash-free`, `minimax-m3-free` (5000, **`free_for_paid:false`**) |
| `wallet` | PAYG from a prepaid balance | `requiresBalance:true`, or a balance endpoint exists | chutes, veniceai, tokenrouter, orcarouter, aihubmix, opencode, commandcode |
| `metered` | PAYG billed to a card/invoice | default when price > 0 and no wallet | openai, anthropic, groq, mistral, google, cohere |
| `unknown` | No evidence. **Renders blank.** | — | all 62 commandcode; all 64 opencode; all 409 aihubmix `/v1/models`; all 135 huggingface; all 19 ollama; all 82 nvidia |

### 4B. `access_state` — can I call it right now (per model × credential)

| Value | Detection | Example |
|---|---|---|
| `callable` | dated live probe succeeded | `bai/deepseek-v4-flash`, `kilo/kilo-auto/free`, `opencode/big-pickle` |
| `needs_deposit` | probe returned a funding error | bai `claude-opus-5` → 403 `Deposit required`; commandcode all 58 → 400 `insufficient credits`; veniceai → 400 `Insufficient USD or Diem balance` |
| `needs_plan` | tier field | routllm `tier_required:1` (7 of 12) |
| `not_callable` | probe returned a hard error | indeedwebid — all models 502 `upstream_error` |
| `unknown` | never probed | default |

### 4C. `account_grant` — free money attached to the *provider account* (per provider)

| Value | Definition | Detection | Example |
|---|---|---|---|
| `recurring_credit` | Money allowance re-granted on a cadence | docs / curated | **huggingface: $0.10/month free, $2.00/month PRO** — and note its *models* are all `metered` |
| `recurring_checkin` | Quota grant claimable on a repeating cadence | **`/api/status.checkin_enabled: true`** — machine-readable | **seekai** (the only gateway with it true) |
| `signup_credit_onetime` | One-time grant at signup. **Does not make anything free.** | `/api/status.quota_for_new_user`, `signup_grants`; curated | orcarouter `quota_for_new_user: 500000` (= $1.00); youcom `$100 complimentary`; aihubmix `balanceNote`; agentrouter `quota_for_invitee/inviter: 25000000` (= $50) |
| `promo_credit_expiring` | Grant with an expiry | `promo_credit_enabled` + `promo_credit_default_expires_days`; `drop_ends_at` | orcarouter; deepseek `granted_balance` |
| `none` / `unknown` | | | |

### Derived single row badge (precedence, first match wins)

```
free_recurring                                            -> FREE
plan_covered                                              -> PLAN
free_promo | account_grant∈{signup_onetime, promo_expiring} -> TRY
balance_gated_free                                        -> BAL$
access_state∈{needs_deposit, needs_plan, not_callable}     -> LOCK
wallet | metered                                          -> PAID
else                                                      -> blank
```

### What can never be auto-detected

1. **Grant cadence itself.** Nothing in any `/v1/models`, `/api/pricing`, models.dev or LiteLLM feed says whether a zero price recurs. The only two machine-readable cadence signals in the whole vault are `/api/status.checkin_enabled` (1 provider) and OpenRouter's `limit_reset` (1 provider). **`free_recurring` is therefore mostly a curated verdict, and its absence must render blank.**
2. **`plan_covered`** — entirely curated. No provider publishes "your subscription covers this."
3. **`free_promo` vs `free_recurring`** — indistinguishable from any feed.
4. **Whether a listed model is entitled** — the G4 set needs a dated live probe.

### Landmines re-measured today

- **Naive `model_price == 0` on New-API**: tokenrouter **123/134** false positives (3 real); orcarouter **172/186** (3 real); bluesminds **50/50** (0 real); agentrouter **5/5** (0 real, incl. `claude-opus-4-8` at `model_ratio: 4`). The correct predicate reproduced exactly. **orcarouter's three real free models are `quota_type:1` with `model_price:0` AND carry `is_free_tier:true` + `free_base_model`** — so there the predicate can be cross-checked against a first-party flag, and they agree 3/3.
- **`group_ratio` does not currently rescue anything**: all four gateways publish `{default:1, vip:1}`, so effective price = `model_ratio × 1`. But **the formula must include it** — a 0 there would zero a price.
- **G1 still fires**: openrouter's only zero-price non-`:free` models are `google/lyria-3-pro-preview` and `-clip-preview` (audio) plus the `openrouter/free` alias; llm7's 9 zero-price models are all `pricing_mode: "image"`/`"second"`; nararouter's 5 zero-priced are all image/video.
- **NEW — conditional pricing.** Zenmux's `pricings.prompt` is an **array of tiers** `{value, unit, currency, conditions:{prompt_tokens:{gte,lt}}}` — **50 of 164 models carry conditions**, and four (all embeddings) are free below a token threshold and paid above. **A scalar price field cannot represent this** — store the array or store blank.
- **kilo's `isFree` is trustworthy**: 19 models, **zero** with a non-zero price; only 2 zero-price models lack the flag, both Google Lyria audio (G1). A clean first-party flag worth trusting.

## 5. Compact display

Fixed-width, positional, uppercase-only, pure ASCII. Uppercase badges can never be confused
with a model id. **Every field has a defined blank rendering, so "no evidence" is visually
distinct from "no"** — which is what the standing rule requires.

```
MODEL ROW:      V _ BADG _ C _ name
                │   │      │
                │   │      └─ cadence, 1 char
                │   └──────── payment tier, 4 chars
                └──────────── live-probe evidence, 1 char

V   '+' probed callable (dated)   '-' probed and refused   ' ' never probed
C   'd' daily   'w' weekly   'm' monthly   ' ' unknown

BADG  FREE  0 price AND a resetting quota      <- the governing definition, both axes true
      PLAN  0 marginal price, a plan you pay covers it
      TRY   0 price but time-boxed / one-time grant
      BAL$  0 price only above a wallet threshold
      PAID  costs money per call
      LOCK  listed but not callable on this credential
      '    '  (4 spaces) no evidence

PROVIDER ROW:   F _ name _ free/total
                F  '$' wallet funded   '!' wallet known empty
                   '?' wallet required, unreadable   ' ' n/a
                free/total: '  /62' when the free count is unknowable (no price data at all)
```

Nine columns of prefix on a model row, eleven on a provider row. **No colour required.** If
colour is added, carry it on **weight, not hue** — `FREE` bold, `PAID` normal, `LOCK`/unfunded
dim — and if hue is wanted use only blue/orange, never red/green. Every state stays legible in
monochrome, which is also what makes it survive conhost, `TERM=dumb`, piped output and
screenshots.

### Level 1, provider focused (100 cols)

```
  PROVIDERS               MODELS  openrouter, 421                DETAIL
  ---------------------   ------------------------------------   ---------------------------
> $ openrouter   18/421   + FREE d google/gemma-4-26b…-it:free    openrouter
  $ kilo         19/365     FREE d hy3                            https://openrouter.ai/api/v1
    nousresearch  6/378     FREE d minimax/minimax-m3:free
  ? tokenrouter   3/134     PAID   anthropic/claude-fable-5.1     421 models
  ? orcarouter    3/186     PAID   openai/gpt-5.6-sol               18 FREE  (:free, daily)
    nararouter    0/54      PAID   x-ai/grok-4.6                     3 blank (2 audio, 1 alias)
    zenmux        5/164            google/lyria-3-pro-preview      400 PAID
    bluesminds    0/50      PAID   openai/gpt-5.6-luna
    agentrouter   0/5       PAID   deepseek/deepseek-v4-pro       balance   credits  (not USD)
  ! commandcode   /62       PAID   moonshot/kimi-k2.6               readable via /api/v1/key
  ! veniceai      0/112     PAID   z-ai/glm-5.3                     not fetched this session
  ! bai           /42
    aihubmix      /409                                            free-tier rule
    opencode      /64                                               20 rpm; 50 rpd, or
    huggingface   /135                                               1000 rpd at >=10 credits
  ---------------------   ------------------------------------   ---------------------------
  FREE recurring  PLAN plan-covered  TRY time-boxed  BAL$ above-balance  PAID  LOCK  blank=unknown
```

`commandcode /62` and `bai /42` show the blank free-count: those catalogues carry **no price
information at all**, so "0 free" would be a claim we cannot make. `veniceai 0/112` *is* a
claim — Venice publishes full USD/DIEM prices for all 112 and none are zero.

### Level 2, model focused — a hard case

```
  PROVIDERS               MODELS  nararouter, 54                 DETAIL
  ---------------------   ------------------------------------   ---------------------------
    openrouter   18/421     PAID   deepseek-v4-pro                deepseek-v4-flash-free
    kilo         19/365   > BAL$   deepseek-v4-flash-free         nararouter
    nousresearch  6/378     BAL$   glm-5.3-free                   ---------------------------
    tokenrouter   3/134     BAL$   glm-5.3-flash-free             tier     BAL$
    orcarouter    3/186     BAL$   mimo-v2.5-free                 why      free ABOVE a balance
>   nararouter    0/54      BAL$   minimax-m3-free                         floor, priced below
    zenmux        5/164     BAL$   qwen3.8-flash-free
    bluesminds    0/50             nano-banana-pro                free_for_paid     true
    agentrouter   0/5              grok-imagine                   free_min_balance  10000 cr
  ! commandcode   /62              agnes-image-2.0-flash          your balance      not fetched
  ! veniceai      0/112     PAID   qwen3.8-max
                                                                  in   0.157408 cr / 1k tok
                                                                  out  0.315    cr / 1k tok
                                                                  1 credit is pegged to IDR
                                                                  (usd_to_idr 17765.00147)

                                                                  free count is 0, not blank:
                                                                  6 models are BAL$, which is
                                                                  not FREE under your rule

                                                                  source  /api/pricing (public)
                                                                  read    2026-09-02 08:13 UTC
```

`nano-banana-pro` / `grok-imagine` / `agnes-image-*` render **blank**, not `FREE`, even though
their token prices are literally 0 — guard G1. The detail pane explains why.

### What belongs in the detail pane, not the row

Everything numeric, everything with a unit, and every *reason*:

- exact prices with unit **and currency string** (`pollen`, `credits`, `TAO`, `DIEM`, IDR-pegged, `USD/1M`) — **a bare number in a row is a lie waiting to happen given seven currencies**
- the raw fields that produced the badge: `quota_type`, `model_ratio`, `model_price`, `completion_ratio`, `group_ratio`, `is_free_tier`, `isFree`, `is_free`, `free_for_paid`, `free_min_balance`, `tier_required`
- **which guard forced a blank** (G1/G2/G3/G4) — this is what makes a blank cell honest rather than lazy, and it is the highest-value thing in the pane
- `free_state_source` and `verified_at`
- the balance figure and its **as-of age**
- context length, modalities, `supported_endpoint_types`, `supported_parameters`
- provider warnings: WAF headers required (agentrouter needs `Originator: codex_cli_rs`), hidden-system-prompt cost, `max_tokens >= 512` quirks, `max_completion_tokens` vs `max_tokens`
- Zenmux's conditional pricing array, which **has no row representation at all**

## 6. Catalogue store schema

### Per model

| Field | Source | Refresh | Credential | Stale-dangerous |
|---|---|---|---|---|
| `provider`, `model_id` | catalogue | daily | some | no |
| `display_name`, `context_length`, `input_modalities`, `output_modalities`, `supported_endpoint_types` | catalogue | daily | some | no |
| `price_in`, `price_out`, `price_cache_read`, `price_cache_write` | first-party or `/api/pricing` | daily | no for 5 public gateways | no |
| `price_unit`, `price_currency` | same | daily | same | **no, but never default it** — 7 currencies |
| `price_tiers[]` (conditional) | zenmux `pricings[]`, orcarouter `tiered_pricing`/`timed_pricing`/`per_call_unit` | daily | no | no |
| `raw_billing{quota_type, model_ratio, model_price, completion_ratio, cache_ratio}` | `/api/pricing` | daily | no | no |
| `pay_tier` (4A) | derived | daily | — | **medium** — a promo ends and it silently becomes wrong |
| `pay_tier_source` ∈ `{api_flag, api_price, api_plan_field, curated, absent}` | derived | daily | — | no |
| `pay_tier_verified_at` | derived | — | — | no |
| `guard_applied` ∈ `{G1,G2,G3,G4,null}` | derived | daily | — | no |
| `free_for_paid`, `free_min_balance` | nararouter | daily | no | **HIGH** — the verdict flips when the balance crosses the floor, and the balance is volatile |
| `tier_required` | routllm | daily | key | medium |
| `is_free_flag` | kilo `isFree`, orcarouter `is_free_tier`, gmicloud `is_free`, nous `synthesizedFreeVariant` | daily | mixed | no |
| `free_base_model` | orcarouter | daily | no | no |
| `rate_limit_rpm/rpd/tpm` | pollinations `per_user_rpm` (public); venice `rateLimits[]` (key) | weekly | mixed | low |
| `rate_limit_epoch_end` | venice `nextEpochBegins` | on demand | key | medium |
| `access_state` (4B) + `access_checked_at` | live probe log | manual | key | **HIGH** — a green "callable" from three weeks ago is worse than blank |
| `quota_cadence` ∈ `{daily,weekly,monthly,onetime,none,unknown}` | **curated in providers.json** | manual | no | no |

### Per provider

| Field | Source | Refresh | Credential | Stale-dangerous |
|---|---|---|---|---|
| `provider`, `base_url`, `protocol`, `headers_template`, `waf_headers` | providers.json | manual | — | no |
| `requires_balance` | providers.json | manual | — | no |
| `gateway_family` ∈ `{new_api, openrouter_schema, first_party, unknown}` | `X-New-Api-Version` / `X-Oneapi-Request-Id` / schema shape | monthly | no | no |
| `pricing_endpoint`, `pricing_public` | `/api/status.HeaderNavModules.pricing.requireAuth` | weekly | no | no |
| `quota_per_unit`, `quota_display_type`, `usd_exchange_rate`, `custom_currency_symbol`, `display_in_currency` | `/api/status` | weekly | **no** | no |
| `balance_endpoint`, `balance_auth` ∈ `{api_key, session, admin_key, none}` | this census | quarterly re-probe | no | no |
| `balance_value`, `balance_currency`, `balance_is_unlimited`, `balance_as_of` | live call | **on focus only, never batch-cached** | key | **CRITICAL** — always render with its age; treat anything older than a few minutes as unknown. Decode the `1e8` sentinel as *unlimited*, not $100M |
| `usage_total`, `usage_daily/weekly/monthly` | OR `/api/v1/key`; New-API `/v1/dashboard/billing/usage` (cents) | on demand | key | low |
| `limit`, `limit_remaining`, `limit_reset` | OR `/api/v1/key` | on demand | key | medium |
| `key_expires_at` | New-API `access_until`; venice `keyExpiration` | weekly | key | medium |
| `account_grant` (4C) + `grant_amount` + `grant_currency` + `grant_resets` | `/api/status` + curated + docs | weekly / manual | no | medium |
| `checkin_enabled`, `promo_credit_enabled`, `promo_credit_default_expires_days`, `signup_grants`, `quota_for_new_user`, `drop_ends_at` | `/api/status` | weekly | **no** | no |
| `catalogue_trust` (G4 flag) | curated | manual | — | no |
| `model_count`, `free_count` (**nullable — null ≠ 0**) | derived | daily | — | no |
| `catalogue_fetched_at` | — | daily | — | no |

### Two load-bearing schema rules

1. **`free_count` must be nullable.** `0/112` on Venice is a measurement; `/62` on commandcode is the absence of one. **Collapsing them to `0` is the single most likely way this design ends up lying.**
2. **Never store a price without its currency in the same row.** Pollen, credits-pegged-to-IDR, TAO, DIEM, USD-per-1M and New-API's `quota_per_unit`-scaled units all appear as bare small floats and are mutually incomparable.

## One revision to a prior established fact

The established *"no `/v1/models` endpoint on any provider returns rate-limit headers"*
reproduced exactly — a header sweep across all 23 publicly-readable catalogue and
`/api/pricing` endpoints found **zero** `x-ratelimit-*`, `retry-after`, `quota` or `credit`
headers.

**The one addition:** `huggingface.co/api/whoami-v2` **does** return
`ratelimit: "api";r=9997;t=104` and `ratelimit-policy: "fixed window";"api";q=10000;w=300`
(10,000 requests per 300 s). That is a Hub-API platform limit, not an inference quota — it
does not weaken the conclusion, but it is the only non-inference endpoint in the vault
carrying such headers.

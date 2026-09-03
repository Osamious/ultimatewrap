# Research: provider API call shapes (2026-09-02)

Source: `~/.llmkeys/providers.json` (47 entries), `registry.json` (56 credentials,
UTF-8 **with BOM** — plain `json.load` fails, use `utf-8-sig`), `ApiKeyVault.ps1`.

## Two structural findings

**There is no model-listing field.** `ApiKeyVault.ps1` (lines 216, 301-314) only ever
constructs `POST {baseUrl}/chat/completions` (openai) or `POST {baseUrl}/messages`
(anthropic); `generic` gets no auto-call at all. The listing path is **pure convention —
`{baseUrl}/models`** — and every deviation lives only in free-text `notes`.

**Every URL is already version-complete.** 43/47 end in `/v1`; 2 carry a different version
segment (`/v1beta/openai`, `/api/paas/v4`); 1 is deliberately version-less (kilo); 1 is
empty (githubcopilot). **Never append `/v1` — append exactly `/models`.** No baseUrl has a
trailing slash, so plain concatenation is safe for all 46 non-empty entries.

## Per-provider table

Legend — Reg: credentials in registry.json. Bal: `requiresBalance`. MTP: `maxTokensParam`
(`-` = absent). All rows use `Authorization: Bearer {key}` unless noted.

| # | provider | Reg | baseUrl | ver-seg | proto | List endpoint | Auth deviations | testModel | Bal | MTP |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | indeedwebid | 1 | `https://ineed.web.id/v1` | /v1 | openai | `{base}/models` ✓200 | — | `ineed/freetier` | F | - |
| 2 | gmicloudai | 1 | `https://api.gmi-serving.com/v1` | /v1 | openai | `{base}/models` (has `is_free`) | — | `MiniMaxAI/MiniMax-M2.7` | F | - |
| 3 | seekai | 1 | `https://seekai.cc/v1` | /v1 | openai | `{base}/models` (no `is_free`) | — | `deepseek-v4-flash` | T | - |
| 4 | zenmux | 2 | `https://zenmux.ai/api/v1` | /v1 | openai | `{base}/models` | — | `z-ai/glm-5.3-free` | T | - |
| 5 | routllm | 1 | `https://routllm.pro/v1` | /v1 | openai | `{base}/models` (`tier_required`) | — | `deepseek/deepseek-v4-flash` | T | - |
| 6 | tokenrouter | 1 | `https://api.tokenrouter.com/v1` | /v1 | openai | `{base}/models` | — | `qwen/qwen3.8-max-free` | T | - |
| 7 | teamorouter | 1 | `https://api.teamorouter.com/v1` | /v1 | openai | `{base}/models` | — | `deepseek-v4-flash-free` | T | - |
| 8 | google | 4 | `https://generativelanguage.googleapis.com/v1beta/openai` | **/v1beta/openai** | openai | `/v1beta/openai/models` | compat layer; native Gemini uses `?key=` | `gemini-3.5-flash-lite` | F | - |
| 9 | deepseek | 2 | `https://api.deepseek.com/v1` | /v1 | openai | `{base}/models` | — | `deepseek-chat` | F | - |
| 10 | fanar | 1 | `https://api.fanar.qa/v1` | /v1 | openai | `{base}/models` | — | `Fanar` | F | - |
| 11 | openrouter | 2 | `https://openrouter.ai/api/v1` | /v1 | openai | `{base}/models` | **no HTTP-Referer/X-Title recorded** | `google/gemma-4-26b-a4b-it:free` | F | - |
| 12 | pollinations | 1 | `https://gen.pollinations.ai/v1` | /v1 | openai | `{base}/models` | — | `openai` (alias/router) | T | - |
| 13 | groq | 3 | `https://api.groq.com/openai/v1` | /v1 | openai | `{base}/models` | — | `openai/gpt-oss-20b` | F | - |
| 14 | nararouter | 1 | `https://router.bynara.id/v1` | /v1 | openai | `{base}/models` | — | `deepseek-v4-pro-free` | F | - |
| 15 | orcarouter | 1 | `https://api.orcarouter.ai/v1` | /v1 | openai | `{base}/models` | — | `orcarouter/free` | F | - |
| 16 | tokenharbor | 1 | `https://tokenharbor.ai/v1` | /v1 | openai | `{base}/models` | — | `deepseek-v4-flash:free` | F | - |
| 17 | opencode | 1 | `https://opencode.ai/zen/v1` | /v1 | openai | `{base}/models` | — | `deepseek-v4-flash-free` | T | - |
| 18 | openai | 1 | `https://api.openai.com/v1` | /v1 | openai | `{base}/models` | — | `gpt-5-nano` | F | **`max_completion_tokens`** |
| 19 | alibaba | 1 | `https://ws-uqwgkb2mtkfsqelb.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` | /v1 | openai | `{base}/models` ✓200 | — | `qwen3.8-27b` | F | max_tokens |
| 20 | githubcopilot | 1 | **`""` EMPTY** | - | **generic** | **NONE** | — | **`""`** | F | max_tokens |
| 21 | mistral | 1 | `https://api.mistral.ai/v1` | /v1 | openai | `{base}/models` | — | `mistral-small-latest` | F | max_tokens |
| 22 | huggingface | 1 | `https://router.huggingface.co/v1` | /v1 | openai | `{base}/models` (has `is_free`) | — | `prism-ml/Ternary-Bonsai-27B-AWQ-4bit:together` | F | max_tokens |
| 23 | llm7 | 1 | `https://api.llm7.io/v1` | /v1 | openai | `{base}/models` (43-44 models) | works keyless @30 RPM | `DeepSeek-V4-Flash-0731` | F | max_tokens |
| 24 | ollama | 1 | `https://ollama.com/v1` | /v1 | openai | `{base}/models` | — | `gpt-oss:20b` | F | max_tokens |
| 25 | cerebras | 1 | `https://api.cerebras.ai/v1` | /v1 | openai | `{base}/models` | — | `gpt-oss-120b` | T | max_tokens |
| 26 | nvidia | 1 | `https://integrate.api.nvidia.com/v1` | /v1 | openai | `{base}/models` (82, id/object/created/owned_by only) | — | `deepseek-ai/deepseek-v4-flash-0731` | F | max_tokens |
| 27 | aionlabs | 1 | `https://api.aionlabs.ai/v1` | /v1 | openai | `{base}/models` — **returns `models`, not `data`** | — | `aion-labs/aion-3.0-mini` | F | max_tokens |
| 28 | cohere | 1 | `https://api.cohere.ai/compatibility/v1` | /v1 | openai | `{base}/models` | — | `command-r7b-12-2024` | F | max_tokens |
| 29 | agnes | 1 | `https://apihub.agnes-ai.com/v1` | /v1 | openai | `{base}/models` | — | `agnes-2.0-flash` | F | max_tokens |
| 30 | kilo | 1 | `https://api.kilo.ai/api/gateway` | **NONE** | openai | `/api/gateway/models` | — | `kilo-auto/free` | F | max_tokens |
| 31 | xai | 1 | `https://api.x.ai/v1` | /v1 | openai | `{base}/models` | — | `grok-4-fast` | T | max_tokens |
| 32 | cloudflare | 1 | `https://api.cloudflare.com/client/v4/accounts/{acctId}/ai/v1` | /v1 | openai | **`/v1/models` 405 → use `…/ai/models/search?task=Text%20Generation`** | — | `@cf/openai/gpt-oss-120b` | F | max_tokens |
| 33 | sambanova | 1 | `https://api.sambanova.ai/v1` | /v1 | openai | `{base}/models` | — | `Meta-Llama-3.3-70B-Instruct` | T | max_tokens |
| 34 | nscale | 1 | `https://inference.api.nscale.com/v1` | /v1 | openai | `{base}/models` | — | `Qwen/Qwen3-4B-Instruct-2507` | F | max_tokens |
| 35 | anthropic | **0** | `https://api.anthropic.com/v1` | /v1 | **anthropic** | `{base}/models` | **`x-api-key` + `anthropic-version: 2023-06-01`** | `claude-haiku-4-5-20251001` | F | max_tokens |
| 36 | chutes | 1 | `https://llm.chutes.ai/v1` | /v1 | openai | `{base}/models` | — | `unsloth/Mistral-Nemo-Instruct-2407-TEE` | T | max_tokens |
| 37 | bigmodel | 1 | `https://open.bigmodel.cn/api/paas/v4` | **/api/paas/v4** | openai | `/api/paas/v4/models` (note says `/v1/models` — **wrong**) | — | `glm-4.5-air` | F | max_tokens |
| 38 | tabiai | 1 | `https://tabitoken.com/v1` | /v1 | openai | `{base}/models` (4 models, all Opus) | — | `claude-opus-4-8` | F | max_tokens |
| 39 | bai | 1 | `https://api.b.ai/v1` | /v1 | openai | `{base}/models` (42 listed, **7 callable**) | — | `deepseek-v4-flash` | T | max_tokens |
| 40 | commandcode | 1 | `https://api.commandcode.ai/provider/v1` | /v1 | openai | note says `GET /models`; 62 models | — | `deepseek/deepseek-v4-flash` | T | max_tokens |
| 41 | gorouter | 1 | `https://gorouter.app/v1` | /v1 | openai | `{base}/models` ✓200 (4 models) | — | `claude-opus-4-8` | T | max_tokens |
| 42 | veniceai | 1 | `https://api.venice.ai/api/v1` | /v1 | openai | `{base}/models` ✓200 (112-113, `model_spec.pricing`) | — | `venice-uncensored-1-2` | T | max_tokens |
| 43 | bluesminds | 1 | `https://api.bluesminds.com/v1` | /v1 | openai | `{base}/models` ✓200 (27) | — | `meta/llama-3.1-8b-instruct` | F | max_tokens |
| 44 | agentrouter | 1 | `https://agentrouter.org/v1` | /v1 | openai | `{base}/models` ✓200 (3) | **WAF: `Originator: codex_cli_rs`, `Version: 0.101.0`, `User-Agent: codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464`** | `gpt-5.6-sol` | F | max_tokens |
| 45 | aihubmix | 1 | `https://aihubmix.com/v1` | /v1 | openai | `{base}/models` (401 models) | — | `coding-glm-5.2-free` | T | max_tokens |
| 46 | youcom | 1 | `https://ydc-index.io/v1` | /v1 | **generic** | **NONE — `/models` 403** | **`X-API-Key: {key}`** | **`""`** | F | max_tokens |
| 47 | nousresearch | 1 | `https://inference-api.nousresearch.com/v1` | /v1 | openai | `{base}/models` (370-378 models) | — | `upstage/solar-pro4:free` | F | max_tokens |

## Schema census (47 entries)

| Field | Count | Notes |
|---|---|---|
| `provider` | 47 | primary key, lowercased by `Set-ProviderProfile` |
| `docsUrl` | 47 | one admittedly a guess (gorouter) |
| `baseUrl` | 47 | 1 is `""` |
| `protocol` | 47 | enum-validated: `openai\|anthropic\|generic` |
| `headersTemplate` | 47 | newline-separated `Name: value`, `{key}` placeholder |
| `testModel` | 47 | 2 are `""` |
| `notes` | 47 | free text, carries **all** operational knowledge |
| `requiresBalance` | 47 | bool — 16 true |
| `updated` | 47 | ISO-ish, **no timezone** |
| `maxTokensParam` | **30** | absent on the 17 oldest |
| `accountInfo` | **29** | **22 are `{}`** → only 7 carry real data |

**No entry has**: `modelsEndpoint`, `listPath`, `apiVersion`, `queryAuth`, `extraHeaders`,
`defaultModel`, `recommendedModel`, `pricing`, `rateLimit`, `deprecated`, `trust`.

`headersTemplate` has only 4 distinct values: Bearer (44), anthropic x-api-key (1),
agentrouter Bearer+3 WAF headers (1), youcom `X-API-Key` (1).

## The 7 call-shape clusters

| # | Cluster | n | Handling |
|---|---|---|---|
| **A** | Plain OpenAI | **38** | `GET {base}/models`, Bearer, `{data:[{id}]}` — pure loop |
| **B** | Non-`/v1` version segment | 3 | identical if you concatenate; breaks only on hard-coded `/v1/models`. google, bigmodel, kilo |
| **C** | Non-`data` envelope | 1 | aionlabs returns `{models:[…]}` — parse `data ?? models` |
| **D** | WAF headers | 1 | agentrouter: 401 `unauthorized client detected` without its 3 headers |
| **E** | Non-Bearer auth | 2 | anthropic (`x-api-key`+version), youcom (`X-API-Key`) |
| **F** | Endpoint absent/different | 2 | cloudflare (405 → native `models/search`, `{result:[…]}` envelope); youcom (403) |
| **G** | No HTTP surface | 1 | githubcopilot — skip, or it builds `"" + "/models"` |

**A+B+C = 41 of 47 through one code path.** Only 6 need per-provider code.

## Providers needing bespoke handling

- **githubcopilot** — empty baseUrl/testModel, protocol `generic`. No sanctioned REST endpoint. Exclude.
- **youcom** — a web-search API, not an LLM provider. `/models` and `/chat/completions` both 403. Notes: *"Not usable as a maestro backend."* Exclude.
- **cloudflare** — `/v1/models` 405; needs `…/ai/models/search?task=Text%20Generation` and a Cloudflare-shaped response. Base URL embeds a per-account id — not portable.
- **agentrouter** — 3 mandatory WAF headers on every request incl. discovery, encoded as extra newline-separated lines in `headersTemplate`. A parser reading only the first line silently 401s.
- **anthropic** — only `x-api-key` entry, and **the only providers.json entry with zero credentials in registry.json**.
- **aionlabs** — top-level `models` instead of `data`.
- **commandcode** — notes say `GET /models` while baseUrl ends `/provider/v1`. Ambiguous; needs one probe.
- **zenmux** — two key classes: `sk-mg-v1-` (management, `/v1/models` only) vs `sk-ai-v1-` (inference). registry holds both; for listing prefer the management key.
- **kilo** — only version-less base URL.
- **alibaba** — per-workspace dedicated domain; generic dashscope endpoints 401 even with a valid key. Not portable.
- **tabiai / gorouter** — listing is fine, but notes carry cost warnings for chat probes.

## Operational judgments quoted from `notes`

**Trust / caution:**
- **teamorouter**: *"Marketing presence … reads as heavy self-promotional SEO content targeting an 'OpenClaw' product I don't recognize — treat with some caution, avoid routing sensitive prompts until more trusted."*
- **tabiai**: *"CAUTION: a trivial test prompt used 6554 prompt_tokens — a large hidden system prompt is injected server-side (response metadata shows usage_source:anthropic/billing_usage.source:claude_messages, suggesting this proxies real Claude billing…). At Opus pricing this is NOT a negligible-cost test like other providers — avoid casual re-testing."*
- **gorouter**: *"treat a first real call here as similarly non-negligible-cost until proven otherwise."* Also *"docsUrl is best-guess root domain only — /docs, /docs/api, /api, /keys all returned bot-blocked 403 via curl."*
- **githubcopilot**: *"No public/ToS-sanctioned direct chat-completions REST endpoint … out of scope for Test-ApiKey."*

**Content-policy outliers** (relevant if the menu tags models): **aionlabs** —
*"unmoderated (is_moderated:false) models specifically tuned for roleplay/storytelling incl.
mature/darker themes"*; **veniceai** — *"several models explicitly marketed as
uncensored/unmoderated … similar caution to aionlabs."*

**Catalogue ≠ callable** (the single most important refresher caveat):
- **bai**: *"Router exposing 42 models … but PROBED LIVE 2026-08-22: only 7 actually respond 200 on this key with zero deposit … the catalog is NOT an accurate guide to what's callable on a $0 balance, always probe with a real chat/completions call before trusting a listed id."* Also *"heavily rate-limited (429s under light concurrent load; single sequential calls ~2-8s apart clear it)."*
- **commandcode**: *"ALL 58 models, on BOTH endpoints, return 400 'insufficient credits'."*
- **veniceai**: lists fine (200) but chat 400s *"Insufficient USD or Diem balance."*
- **tokenharbor**: *"vendor-prefixed names like tokenharbor/x are NOT callable."*
- **indeedwebid**: *"GET /v1/models returns 200 … POST /v1/chat/completions returns 502 upstream_error on all tried models as of 2026-08-26 — key valid, chat backend down."*

**Model-parameter gotchas** (affect probing, not listing): openai needs
`max_completion_tokens`; aihubmix and nousresearch reasoning models return empty content at
`finish_reason=length` unless `max_tokens >= ~512`.

## Data-quality issues

1. **`anthropic` has no credential** — only entry with zero registry match.
2. **Two orphaned registry credentials with no provider profile**: `personal.inferx.free`, and `personal.vercel.free` whose provider is **`VERCEL`** (uppercase, violating the lowercasing every other entry follows) — both fail `Get-ProviderProfile`.
3. **bigmodel notes wrong** — says `/v1/models`, host has no `/v1`.
4. **commandcode path ambiguity** — notes vs baseUrl disagree.
5. **`accountInfo` effectively a 7-entry field** — 22 of 29 are `{}`.
6. **`maxTokensParam` absent on the 17 oldest entries** — cosmetic, consumer defaults correctly.
7. **Escaping corruption** — five notes contain a stray backslash where a word was lost (`"No \\ models"`, `"No literal \\ model"`), almost certainly a mangled `$0` from PowerShell interpolation. Shows notes went through a lossy write path.
8. **Staleness** — 34 of 47 stamped `2026-08-19`; only 6 are `2026-08-22` or later. `updated` carries no timezone.
9. **indeedwebid** live-broken for chat (502) per its own note; listing still works.

## Corroboration: `~/.maestro/model_cache.json`

659 KB, 50 top-level keys named by credential slot (`agentrouter-free`,
`google-sportsvector1-paid`, `openrouter-free`, …), each
`{fetched_at_unix_secs, models:[{id, capability, display_name, tier}]}`. An existing
successful run of exactly this refresh.

The 5 providers.json entries **absent** from that cache are precisely the bespoke/skip set:
`githubcopilot`, `youcom`, `cloudflare`, `anthropic` — plus **`xai`**, which is the one
surprise: a plain cluster-A entry with no note explaining its absence. Worth one probe.

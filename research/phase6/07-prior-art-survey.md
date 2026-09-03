# Research: prior art — model selection at scale (2026-09-02)

All endpoints and package metadata verified live.

## Two headline recommendations

**(a) Do not build a metadata store. Consume [models.dev](https://models.dev).** Verified
live: **212 providers, 7,502 models**, MIT, bot-synced **multiple times per hour**, with a
**zero-dependency daily npm snapshot**. Strictly better than LiteLLM's file for this use case.

**(b) Two-level browse: master-detail split; fzf as an accelerator without `--preview`.**
`fzf --preview` on Windows is a real trap (see the TUI toolchain report).

## The metadata question — measured head-to-head

| | **models.dev** | **LiteLLM `model_prices_and_context_window.json`** |
|---|---|---|
| Raw URL | `https://models.dev/api.json` (4.4 MB) | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` (2.1 MB) |
| Providers | **212** | 131 |
| Models | **7,502** | 3,518 |
| Structure | Nested: `provider → models → model` | **Flat**: one giant map, provider baked into key strings |
| Licence | **MIT** (clean) | MIT, but repo licence reports `NOASSERTION`; `enterprise/` separately licensed. The JSON itself is MIT. |
| Update cadence | Bot commits hourly (`chore(sync): update OpenRouter model catalog`) | Continuous, bundled into general LiteLLM commits |
| npm package | **`@opencode-ai/models` v0.0.62, MIT, ZERO dependencies, published daily** | none |
| HTTP caching | **ETag + `must-revalidate`** → cheap conditional refresh | GitHub raw (ETag available) |

### models.dev schema — verified field frequency across all 7,502

```
id, name, description, attachment, reasoning, tool_call,
release_date, last_updated, modalities{input[],output[]},
open_weights, limit{context, output, input?}          ← all 7502/7502
cost{input, output, cache_read?, cache_write?, tiers?,
     context_over_200k?, reasoning?, input_audio?}     ← 7066/7502
temperature (7005), family (6837), reasoning_options (5326),
structured_output (5124), knowledge (3994), interleaved (984),
status: "beta"|"deprecated" (271), experimental (38)
```

Provider level: `id, name, env[], api, npm, doc, models{}`. **The `env[]` array is a gift** —
e.g. `google → ["GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY"]` — so you
can auto-detect which providers are configured and grey out the rest.

Extra endpoints (all HTTP 200, verified): `https://models.dev/models.json` (294 KB,
provider-agnostic model facts) and `https://models.dev/catalog.json` (4.7 MB, both). Logos at
`/logos/{provider}.svg`.

### LiteLLM schema, for completeness

162 distinct fields; load-bearing ones by frequency: `litellm_provider` (3517), `mode` (3509),
`max_input_tokens` (2983), `max_tokens` (2909), `input_cost_per_token` (2905),
`output_cost_per_token` (2901), `max_output_tokens` (2685), `supports_function_calling`
(2093), `supports_tool_choice` (1950), `supports_vision` (1312), `supports_reasoning` (1133),
`cache_read_input_token_cost` (1022), `deprecation_date` (625).

**Costs are per-token floats in scientific notation** (`3e-06`), not per-million.
`max_tokens` is a legacy duplicate. `mode` covers 17 values (`chat` 2678, `image_generation`
288, `embedding` 136, …). Note the first key is `"sample_spec"`, a self-documenting template
that must be skipped — it pollutes naive iteration.

### Why models.dev wins here specifically

LiteLLM's coverage skews to enterprise/cloud SKUs — `fireworks_ai` 316, `bedrock` 270,
`azure` 221 — while carrying only **100 OpenRouter models**. models.dev has **354**, and
OpenRouter's own live API returns **421**. For a vault full of aggregators, LiteLLM feels
badly out of date.

### "Is this model free" — honest answer

There is **no single boolean**. Measured today:
- models.dev: **594 models** with `cost.input == 0 && cost.output == 0`
- OpenRouter live API: **421 models**, of which **18** end in `:free` and **21** have zero prompt+completion price
- models.dev's OpenRouter count: **21** — matches the live API's zero-cost figure exactly

Zero cost conflates three genuinely different states; render three labels, not one:
1. **Free (pay-as-you-go, rate-limited)** — OpenRouter `:free`. ~20 req/min, ~200 req/day, then 429.
2. **Included in a subscription** — whole providers at cost 0 because a plan covers it:
   `alibaba-token-plan` (26/26), `zhipuai-coding-plan` (9/10), `tencent-coding-plan` (8/8),
   `gitlab` (23/23), `nvidia` (99/103), `kenari` (59/59). Labelling these "free" is misleading.
3. **Paid.**

Also surface `status: "deprecated"` (193) and `"beta"` (78) — users pick dead models constantly.

### Recommended architecture (what Cline does)

Cline uses a **static catalog generated from models.dev payloads**, plus a **live refresh**
for dynamic providers (`refreshOpenRouterModels.ts`). Copy it:

- **Baseline:** bundle `@opencode-ai/models` (zero deps) so the picker works offline and on first run.
- **Refresh:** conditional GET on `https://models.dev/api.json` with the stored ETag, ~24 h TTL, cached under your config dir. **aider does exactly this** — fetches LiteLLM's JSON to `~/.aider/caches/model_prices_and_context_window.json` with a 24-hour TTL.
- **Live overlay for aggregators only:** hit `https://openrouter.ai/api/v1/models` directly, because free-tier membership rotates faster than any static catalog. That endpoint gives `pricing.prompt/completion` as strings, `context_length`, `supported_parameters[]`, `top_provider.max_completion_tokens`, plus `expiration_date` and `knowledge_cutoff`.
- **User override file:** aider's `.aider.model.metadata.json` pattern — a small local JSON merged over the catalog. Ship this; users always have one model you don't know about.

## Per-tool survey

### 1. OpenRouter (web UI + API)

Left sidebar facets over ~500 models: **Price (incl. a "Free" facet), context length,
modality, series, supported parameters**, plus free-text search and sort by
newest/pricing/context/throughput/latency. Row shows name, short description, context,
input $/M, output $/M.

Steal:
- **Faceted sidebar + free text simultaneously**, not one or the other. Users arrive with either "I want a cheap 200k model" (facet) or "where's deepseek" (text).
- **`openrouter/free`** — a meta-model routing to a random currently-free model matching the request. Consider an equivalent pseudo-entry rather than making users chase a rotating list.

Avoid: the `:free` suffix is a leaky abstraction. Three zero-cost models don't carry it
(`google/lyria-3-pro-preview`, `google/lyria-3-clip-preview`, `openrouter/free`).
**Filter on price, not on the ID suffix.**

### 2. aider

No two-level picker. `/model <name>` switches; `/models <search>` does substring search over
names. Metadata is 100% delegated to LiteLLM's JSON (24 h cached) with a bundled
`aider/resources/model-metadata.json` override (28 KB — note it contains comments, so it is
not strictly parseable JSON) and a separate `.aider.model.settings.yml` for behaviour.

**Steal:** the fetch-cache-TTL-override layering. **Avoid:** substring-only search with no
provider grouping — it doesn't scale past a few hundred models.

### 3. simonw's `llm`

Registry is **code, not data**: plugins implement the `register_models` hook; `llm models list`
prints a flat `Provider: model-id` list, with `llm models --options` for per-model params.

Refresh is **manual and per-plugin** — `llm-replicate` is the reference:
`llm replicate fetch-models`, `llm replicate add <id> --alias <x>`, `llm replicate edit-models`.

**Steal: aliases.** With thousands of models, letting users pin `fast`/`cheap`/`smart` to
concrete IDs is the single highest-value affordance here. **Avoid:** the flat plain-text list
and manual refresh.

### 4. opencode / crush / charm

- **Crush** — Go + Bubble Tea v2, Elm architecture. Picker = `bubbles` `list` + `textinput` filter in a dialog overlay routed through `appModel`. Best reference for the canonical filterable-list-in-a-modal shape.
- **opencode** — migrated off Go/Bubble Tea to **OpenTUI** (React-for-terminal) in v1.0. Picker at `packages/opencode/src/cli/cmd/tui/component/dialog-model.tsx`. Structure is **provider-grouped sections with Recent and Favorites pinned on top** — *not* a hard two-level drill-down; one scrollable list with section headers.

**Steal:** Recent + Favorites sections. With 7,500 models the realistic user touches five.

**Avoid — a documented, reproducible bug:** opencode's picker de-duplicates by removing
models already shown in Recent/Favorites, making them **silently vanish** from their provider
section (opencode#6169: 23 models loaded across 3 providers, ~15 visible). Show duplicates,
or mark them — never hide.

### 5. cline / continue.dev / roo

- **Cline** — Gateway pattern; static catalog **generated from models.dev**, plus `refreshOpenRouterModels.ts`, plus `normalizeProviderSwitchModel` to restore the last-used model per provider when switching. **Copy that last one in spirit: remember a per-provider last selection.**
- **Roo Code** — deliberately avoids a global picker: **profiles**, each binding provider+model+settings, switched from one small dropdown. Strong pattern for a CLI (`mytool --profile fast`). Known UX trap in their release notes: users must click a checkmark to commit a model change or it silently doesn't stick — **never require a second confirmation gesture to commit a selection**.
- **continue.dev** — models declared in `config.yaml`, not a fetched dropdown. Least applicable.

Also relevant: cline#8306, an open regression where the model dropdown malfunctions for the
VS Code LM API — dynamic provider lists need a **visible failure state**, not an empty list.

## Wide-table TUI patterns

Consensus, and the recommendation: **prioritized-column list + master-detail drill-down.
Treat horizontal scroll as an escape hatch, not the mechanism.**

The argument against horizontal scroll is fundamental: a row's columns carry meaning
*relative to each other*, and that value is destroyed the moment they cannot be seen
simultaneously. Horizontal scroll shows all rows but never all fields; a detail pane shows
all fields of one row. For model metadata — where the question is always "what does *this*
model cost/support" — the detail pane wins.

Real prior art:
- **k9s** — drill-down stack (cluster → namespace → pod → container → logs). List views deliberately narrow; depth comes from drilling in, not scrolling right. Closest analogue to provider → model.
- **lazygit / btop** — persistent multi-panel, fixed positions. Rule they enforce: never rearrange panels without explicit user action; spatial memory is the feature.
- **yazi / ranger** — Miller columns (parent | current | preview). **Strongest fit for a two-level browse**: providers left, models middle, metadata right. Hierarchy maps onto horizontal flow naturally and you never lose level-1 context.
- **`perf` hists browser** — the cautionary tale: shipped with no horizontal scroll, so wide content was simply *unreachable*; `<`/`>` were added later, and reviewers insisted scrolling be **by column, not by character**, with tiered steps.

If you add horizontal scroll: **freeze the identifier column**, omit non-fitting columns
entirely rather than truncating mid-cell, and show a `MORE →` indicator.

**Concrete column priority** (drop right-to-left as width shrinks):
```
[name] [ctx] [$in/$out] [FREE badge] │ [tools] [vision] [reasoning] │ [released] [status]
 always   always   ≥60 cols            ≥90 cols                        ≥120 cols
```
Everything else (`description`, `family`, `modalities`, `knowledge`, `cache_read`,
`open_weights`) goes in the detail pane. Pin the detail pane to viewport width, not table
virtual width.

## Fuzzy filtering on Node/Windows

| Option | Maintained? | Windows | Verdict |
|---|---|---|---|
| **`fuzzysort`** v4.0.2, MIT, **0 deps**, 9.6M/wk, pushed 2026-08-13 | active | pure JS | **Recommended.** Purpose-built: fast, returns match indices for highlighting, `key`/`keys` for multi-field scoring. |
| **`fuse.js`** 20.5k★, 13.9M/wk, pushed 2026-08-09 | active | pure JS | Fine, but a *relevance* engine (Bitap, typo-tolerant, weighted fields). Heavier and slower than fuzzysort for the fzf-style prefix/subsequence matching users expect. |
| **`fzf` npm** (`ajitid/fzf-for-js`) v0.5.2, BSD-3 | **last publish 2023-04-25** | pure JS | The real fzf *algorithm* in JS with no subprocess — appealing, but **effectively unmaintained**. Its 3.6M weekly downloads are almost entirely transitive. Vendorable, not dependable. |
| **`fzf` binary as subprocess** v0.74.3 (2026-08-17) | very active | see toolchain report | Optional accelerator. |
| **`fzy`** 3.3k★, last pushed 2025-07-29 | quiet | **C, POSIX-only, no Windows build** | **Ruled out.** |
| **Ink** v7.1.1 (2026-07-16), 6.5M/wk | active | yes | Recommended render layer if going in-process. |

## Interaction details worth locking in

- **Filter at both levels should search the *flattened* space too.** Typing `sonnet` at the provider level should be able to jump straight to matching models across providers — a scope toggle. Two-level nav is good for browsing; it is actively hostile when the user already knows the model name.
- **Remember last selection per provider** (Cline's `normalizeProviderSwitchModel`).
- **Pin Recent + Favorites** (opencode) — but render duplicates visibly rather than removing them from their provider section, or you reproduce opencode#6169.
- **Never require a second gesture to commit a selection** (the Roo Code trap).

## Sources

- models.dev · github.com/anomalyco/models.dev (MIT) · `/api.json`, `/models.json`, `/catalog.json`
- `@opencode-ai/models` on npm
- LiteLLM `model_prices_and_context_window.json` · models.litellm.ai
- OpenRouter models + Models API + `openrouter/free`
- aider: Advanced model settings · aider/models.py
- simonw/llm (issues #82, #167) · llm-replicate
- charmbracelet/bubbletea · bubbles · Crush TUI architecture
- opencode#6169 (picker hides models) · OpenCode providers docs
- cline#8306 · Cline model selection · Roo Code 3.8 notes
- fzf (Windows packages) · fzf#2609 · fzf#2006 · PSFzf
- fuzzysort · Fuse.js · fzf-for-js · fzy · Ink
- perf hists horizontal-scrolling patch · awesome-tui-design

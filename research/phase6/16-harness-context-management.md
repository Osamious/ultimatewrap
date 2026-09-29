# Research: how ten agent harnesses manage context size and compaction (2026-09-04)

Written from source reads of ten harnesses, plus live measurements against UW's own
catalogue. Every constant below was read from the named file, not from documentation or a
blog post. Where a claim could not be verified from source it is marked.

This report exists because a protocol run raised a question the plan had deferred: Claude
Code auto-compacts a routed non-Anthropic model at 200,000 tokens regardless of the model's
real window. Rather than design a fix in isolation, the field was surveyed first — every
serious model-agnostic harness has the same problem and has had to answer it.

**The one-line answer:** the ideal — compaction that tracks each model's real window and
follows a model switch live — is achievable, and DeepSeek Harness does it. It is not
achievable inside Claude Code, for a structural reason given in the last section.

---

## The ten, at a glance

| Harness | Window source | Unknown/BYOK fallback | Trigger arithmetic | Token counting | Reactive recovery |
|---|---|---|---|---|---|
| **Roo Code** | in-repo maps + live fetch per provider | `128_000` | `ctx × 0.9 − reserved` | **real tiktoken** (worker pool) | truncation fallback |
| **Cline** | generated in-repo catalog | `128_000`; Ollama `32_768` | `0.9 × (ctx × 0.9)`, target `0.7` | chars **/ 3** | yes (`overflow_recovery`) |
| **Kilo Code** | **live models.dev**, 5-min TTL | **`0` → auto-compaction off** | `ctx − min(20k, out)` on **real usage** | chars/4 **× 1.3** | yes |
| **opencode** | **live models.dev**, 5-min TTL + hourly refresh | **`0` → auto-compaction off** | `ctx − max(out, 20_000)` | chars/4 | yes, 27-pattern classifier |
| **aider** | live litellm JSON, 24h TTL | none; `max_input` becomes `0` | `max_input/16`, clamped 1024–8192 | **litellm tokenizer** | **report only** |
| **DeepSeek Harness** | adapter defaults + catalog | `262_144` (BYOK) / `1_000_000` (native) | `thresholdRatio 0.8`, retain `0.16` | chars/4 + overheads | yes, code-keyed |
| **Codex CLI** | server-supplied per model | `272_000` | `effective_context_window_percent: 95` | provider-reported usage | code match only |
| **Gemini CLI** | hardcoded per-model switch | `1_048_576` | compress above **50%**, keep last **30%** | char estimate + reported | **none** |
| **Qwen Code** | hardcoded per-model switch | `200_000` | `COMPACT_MAX_OUTPUT_TOKENS 20_000`, margin `1_024` | chars/4 | **none** |
| **Crush** | Catwalk catalog | **`0` → auto-summarize skipped** | >200k: flat 20k buffer; else `ctx × 0.2` | provider-reported usage | **none** |

**Amp** (Sourcegraph) is an eleventh data point but closed source, so nothing here is
verifiable. Community reporting says it **removed automatic compaction** in favour of manual
Handoff/Fork/Edit-Restore, on the stated grounds that recursive summarization degrades
accuracy over long sessions. That is worth recording precisely because it disputes the
premise everything else shares.

---

## 1. Where the window comes from: three strategies

**Live external registry.** opencode and Kilo Code fetch models.dev at runtime. opencode's
loader (`packages/core/src/models-dev.ts`) is the most developed and is worth copying whole:

1. disk cache `~/.cache/opencode/models.json`, staleness `ttl = Duration.minutes(5)`
2. build-time inlined snapshot `OPENCODE_MODELS_DEV`, populated by the release pipeline
3. live HTTP fetch with `HttpClient.retryTransient` (2 retries, jittered backoff) behind a
   cross-process file lock (`Flock`)
4. a background fiber refreshing every 60 minutes

Three layers, so it works cold, works offline, and stays current. Kilo Code fetches the same
registry with the same 5-minute TTL (`packages/core/src/models-dev.ts`, `Flag.KILO_MODELS_URL`).

**Live fetch of a maintained JSON.** aider fetches litellm's file directly
(`aider/models.py:161-166`):

```python
MODEL_INFO_URL = ("https://raw.githubusercontent.com/BerriAI/litellm/main/"
                  "model_prices_and_context_window.json")
CACHE_TTL = 60 * 60 * 24  # 24 hours
```

cached to `~/.aider/caches/`. Precedence is subtler than it looks: `get_model_info`
(`models.py:249-274`) prefers `litellm.get_model_info(model)` — the *installed package's*
copy — over its own live cache when litellm is lazily loaded. So the freshly fetched file is
the fallback, not the primary. On fetch failure it writes `"{}"` to the cache and prints the
exception.

**In-repo maps.** Roo Code (`packages/types/src/providers/*.ts`), Cline
(`apps/vscode/src/shared/api.ts` plus a generated catalog), Gemini CLI and Qwen Code
(`packages/core/src/core/tokenLimits.ts`, a hardcoded per-model `switch`). These go stale
between releases by construction.

**Verdict.** The two harnesses that most recently rewrote their context handling — opencode,
and Kilo Code which adopted opencode's code wholesale — both chose a live external registry.
That is the direction of travel.

---

## 2. The unknown-model split, and it is a real disagreement

| approach | harnesses |
|---|---|
| **guess a number** | Roo `128_000` · Cline `128_000` · Codex `272_000` · Gemini `1_048_576` · Qwen `200_000` · DeepSeek `262_144` |
| **refuse to guess** | opencode `0` · Kilo Code `0` · Crush `0` |

The guessers expose a correction path. Roo and Cline both ship a numeric "Context Window"
field in the OpenAI-Compatible provider settings, defaulting to their constant
(`openAiModelInfoSaneDefaults` in Roo, `openAiModelInfoSafeDefaults` in Cline — the same
struct, renamed after the fork). aider's is a file, `.aider.model.metadata.json`, JSON5,
searched **home → git root → cwd → `--model-metadata-file`** with **later files winning**,
and consulted *before* any registry (`models.py:224-226`).

The refusers make the unknown case inert rather than wrong. Crush states the reasoning most
plainly (`internal/agent/agent.go`):

```go
cw := int64(largeModel.CatwalkCfg.ContextWindow)
if cw == 0 { return false }   // "If context window is unknown (0), skip auto-summarize
                              //  to avoid immediately truncating custom/local models."
```

opencode and Kilo Code do the same thing (`packages/opencode/src/session/overflow.ts`):

```ts
if (input.model.limit.context === 0) return false
```

**The guessing camp's failure is documented in their own repository.** Qwen Code issue #7960,
cited in a comment in their own source: on a vLLM backend with a reduced `max_model_len`,
their `COMPACTION_BUDGET_SAFETY_MARGIN = 1_024` is not enough and *"the backend rejects the
request with a 400… before the model runs."* A confident wrong number fails harder than no
number.

---

## 3. Trigger arithmetic: absolute buffers beat percentages

Two families.

**Absolute reserved buffer.** opencode (`packages/core/src/session/compaction.ts`):

```
DEFAULT_BUFFER = 20_000
OUTPUT_TOKEN_MAX = 32_000
DEFAULT_KEEP_TOKENS = 8_000
compact when estimated > context − max(reservedOutput, 20_000)
```

Kilo Code uses the same shape with `COMPACTION_BUFFER = 20_000`. aider reserves a flat
**512** tokens (`history.py`) against a **4096** fallback window. Crush uses a flat 20k
buffer above 200k of window and a proportional `× 0.2` below it — a deliberate hybrid.

**Ratio of window.** Roo (`src/core/context-management/index.ts`):

```ts
export const TOKEN_BUFFER_PERCENTAGE = 0.1
const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens
```

with `autoCondenseContextPercent` defaulting to **100**, so out of the box the buffer
condition drives it rather than the percentage slider. Cline
(`compaction-shared.ts`):

```ts
CONTEXT_WINDOW_INPUT_RATIO = 0.9    // usable input when no explicit maxInputTokens
COMPACTION_TRIGGER_RATIO  = 0.9     // compact at 90% of usable
DEFAULT_TARGET_RATIO      = 0.7     // shrink to 70% of trigger
DEFAULT_PRESERVE_RECENT_TOKENS = 20_000
```

Gemini CLI is the outlier at `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5` — compressing above
half the window, far earlier than anyone else.

**A correction worth recording.** Secondhand summaries (DeepWiki-derived) claim opencode uses
a 70/75/95% percentage threshold. Reading the current source shows it is **not
percentage-based at all**. Two of this survey's agents independently flagged wrong
percentages in web summaries. Constants in this area are widely misreported; read the source.

---

## 4. Token counting: nearly everyone estimates

Only **Roo** runs a real tokenizer generically — tiktoken in a `workerpool`, with a
per-provider override hook for native count-token endpoints
(`src/api/providers/base-provider.ts`). **aider** delegates to
`litellm.token_counter(model=…, messages=…)`, which is model-aware where litellm knows the
model, and **returns 0 silently on any exception** (`models.py:650-670`).

Everyone else estimates from character count:

| harness | divisor | note |
|---|---|---|
| Cline | **3** | *"slightly over-counts vs the conventional 4 so trigger thresholds fire before provider rejection rather than after"* |
| opencode | 4 | `CHARS_PER_TOKEN = 4` |
| Kilo Code | 4, **× 1.3** | *"Token.estimate undercounts provider tokenizers, especially for code and JSON payloads"* |
| DeepSeek | 4 | plus `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4` |
| Qwen Code | 4 | plus a `1_024`-token safety margin |

Note that tiktoken is not the right tokenizer for an arbitrary BYOK model either — it is a
fixed BPE. Nobody has the correct tokenizer for an unknown model, and the field has settled
on a cheap estimate plus a fat buffer instead of pretending otherwise.

**Kilo Code's refinement is the most accurate approach found.** Its default trigger uses the
provider's **real post-response usage** (`tokens.input + output + reasoning + cache.read +
cache.write`) rather than an estimate; estimation is confined to an opt-in preflight guard,
where the 1.3 correction is applied. Estimate to decide whether to send; measure to decide
whether to compact.

---

## 5. Reactive recovery: a genuine split

**Recover** — opencode, Kilo Code, Cline, DeepSeek Harness. opencode's classifier
(`packages/llm/src/provider-error.ts`) is the most developed: 27 regex patterns, an
`exclusions` list so rate-limit messages are not misread as overflow, plus HTTP 413 and
`error.code === "context_length_exceeded"` short-circuits. Recovery fires **once**, and only
if the assistant has not begun streaming; a second overflow is a hard failure. Live issues
(#13015, #27519, #27629) show the classifier is active whack-a-mole per provider — honest
evidence about how reliable error-shape matching really is.

DeepSeek Harness routes recovery through a `CONTEXT_WINDOW_EXCEEDED_CODE` listener that
forces a `'context-overflow'` compaction and replays. Cline has an `overflow_recovery` path
which forces deterministic ("basic") compaction, on the stated grounds that *"recovery must
not depend on another successful LLM request"* — a good constraint.

**Report only** — aider. Its docs state it outright: *"Aider never enforces token limits, it
only reports token limit errors from the API provider."* It catches
`ContextWindowExceededError` by **exception type**, prints an estimate using a `0.7` fudge
factor, and stops.

**Nothing** — Gemini CLI, Qwen Code, Crush have no context-specific reactive classifier at
all; overflow is a generic HTTP failure.

**Consequence for the proactive-versus-reactive question:** it is a false dichotomy. The four
harnesses that handle it best do **both** — declare the window when known, and keep an error
classifier as the net for when the declaration is wrong or absent.

---

## 6. The universal negative: nobody extracts the number from the error

**Confirmed across all ten.** Providers routinely state the limit in the rejection —
*"maximum context length is 128000 tokens"* — and every harness that classifies these errors
matches by shape or by error code and **discards the number**.

DeepSeek Harness makes it explicit. Its classifier (`packages/llm/llm/src/error.ts`) is a
chain of pure boolean tests with no capture groups, and a unit test feeds it
`"This model maximum context length is 128000 tokens"` asserting only `.toBe(true)`. An
architecture note records the decision:

> Let compaction-basic parse provider wording — **rejected because classification belongs at
> adapters** and must cover both thrown and in-band delivery.

**And Codex CLI proves the technique is trivial.** In one file
(`codex-rs/codex-api/src/sse/responses.rs`), twenty lines apart:

```rust
fn try_parse_retry_after(err: &Error) -> Option<Duration> {
    // regex-captures "please try again in 20s" into a real Duration
}
fn is_context_window_error(error: &Error) -> bool {
    error.code.as_deref() == Some("context_length_exceeded")   // number discarded
}
```

They capture a number out of provider error text for **rate-limit backoff** and deliberately
do not for **context sizing**.

The only number-extracting regex found anywhere in the survey is aider's
`context_match = re.search(r"([\d,]+)\s*context", text)` (`models.py:301`) — and it parses
**OpenRouter's rendered web page HTML**, not an API error. That a mature project resorts to
scraping a web page indicates how unsatisfying the alternatives are.

This is a real gap in the state of the art, not a failure to find prior art.

---

## 7. The aggregator problem: only Roo solved it

A registry records one window per *model*. For an aggregator that is a category error: the
model does not have one window, the **endpoint** does.

Measured live on 2026-09-04 against OpenRouter:

```
nvidia/nemotron-3-super-120b-a12b   DeepInfra 262,144  ·  DigitalOcean 1,000,000
thinkingmachines/inkling            DeepInfra 524,288  ·  BaseTen    1,048,576
gryphe/mythomax-l2-13b              NextBit/Parasail/DeepInfra 4,096  ·  Mancer 8,192
```

Up to 4× apart within one model id, and OpenRouter routes between them dynamically, so the
window that applies to the next request is not knowable in advance. The only safe value is
the **minimum across endpoints**.

**Roo fetches per-endpoint and keys its model list by endpoint**
(`src/api/providers/fetchers/openrouter.ts`):

```ts
models[endpoint.tag ?? endpoint.provider_name] = parseOpenRouterModel({ ...model: endpoint ... })
```

They stopped pretending the model has a single window. **aider explicitly does not**
(`aider/openrouter.py:69-73`) — it takes `top_provider.context_length or context_length` from
the list endpoint. Cline's handling was not conclusively verified. Kilo Code and opencode
inherit whatever models.dev states, which is per-model.

**Measured: `top_provider.context_length` is not a safe shortcut.** Sampled 17 models with
per-endpoint data: 16 agreed with the endpoint minimum, one did not, and that one was off by
4× — `xiaomi/mimo-v2.5-pro`, `top_provider = 1,048,576` against `min(endpoints) = 262,144`
across 7 endpoints. So aider's approach is wrong roughly 6% of the time, in the
over-declaring direction. Per-endpoint fetching is the only correct method of the two.

---

## 8. Registries compared

| Registry | URL | Scale | Licence | Cadence | Field |
|---|---|---|---|---|---|
| **models.dev** | `https://models.dev/api.json` | **7,527 models, 213 providers, 100% with a context value** (measured 2026-09-04) | MIT | community PR + schema-validated CI; same-day entries observed | `limit.context`, `limit.output` |
| **LiteLLM** | `raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | ~3,561 entries; 3,022 with `max_input_tokens` | GitHub classifies **"other/NOASSERTION"**, not MIT | multiple commits per day | `max_input_tokens`, `max_output_tokens` |
| **OpenRouter** | `/api/v1/models` and `/api/v1/models/:author/:slug/endpoints` | 427 models | proprietary API, free to query | continuous | `context_length`; **per-endpoint** `endpoints[].context_length` |
| **Helicone** | `/v1/public/model-registry/models` | 500+ (vendor claim) | unauthenticated endpoint | not stated | `contextLength` at model **and** endpoint level |
| **Hugging Face** | per-repo `config.json` | millions, **no bulk API** | per-repo | n/a | `max_position_embeddings` — **unreliable** |

Hugging Face deserves the warning. There is no batch endpoint, so it is a per-repo scrape;
and `max_position_embeddings` is documented as frequently wrong (`transformers#24986`,
`meta-llama/llama#359`), often deliberately set low, and silently extended by `rope_scaling`.

**No registry covers arbitrary obscure or self-hosted endpoints.** All are curated,
PR-driven lists. Even OpenRouter↔LiteLLM sync has open drift bugs. A reseller nobody has
submitted will not be there.

**Some inference servers do publish the limit**, without convergence:

| server | field | where |
|---|---|---|
| vLLM | `max_model_len` | top level of `/v1/models` (PR #4643) |
| llama.cpp | `meta.n_ctx`, `meta.n_ctx_train` | nested in `/v1/models` |
| LM Studio | `max_context_length` | **not** on `/v1/models` — only its own `/api/v0/models` |

Three servers, three shapes, one deliberately withholding it from the OpenAI-compatible
surface. The OpenAI-compatible `/v1/models` spec has no context field, which is the whole
reason `taylorwilsdon/llm-context-limits` exists as a hand-maintained markdown table.

---

## 9. Measurements against UW's own catalogue

Everything in this section was measured on 2026-09-04 against
`~/.uw/catalog/snapshot.json` (45 providers, 1,588 models).

**Current coverage: 1,500 of 1,588 have a context value (94.5%).** The 88 gaps are not what
they appear:

- ~25 tiny providers, **22 of which are absent from models.dev entirely** — resellers serving
  upstream models (`tokenharbor/deepseek-v4-flash`, `bluesminds/meta/llama-3.1-8b-instruct`,
  `gorouter/claude-opus-4-8`). The registry has never heard of the reseller but knows the model.
- 4 are the Anthropic relay rows, hardcoded `null` **deliberately** so the statusline shim
  does not override Claude Code's correct native windows (`menu/hud-shim.mjs:35-42`).
- the rest are mostly non-text — `dall-e-2`, `gpt-4o-mini-tts`, `sora-2-pro-high-res`,
  `container`, `edit` — which have no token context window to find.

**Resolving against live models.dev closes 37 of the 88**, by a three-step ladder: exact
`provider`+`model` (14), then bare model id across all providers (6), then ambiguous ids
taking the minimum (17). That lifts coverage to 1,537.

**After excluding non-text models, text-model coverage is 1,564 / 1,588 = 98.5%.** The
genuinely unknown chat models number about seven:

```
openai/gpt-41-copilot                 aihubmix/coding-glm-5.2-free
fanar/Fanar                           pollinations/openai
indeedwebid/ineed/freetier            deepseek/deepseek-r1-distill-qwen-1.5b
huggingface/prism-ml/Ternary-Bonsai-27B-AWQ-4bit:together
```

Roughly 0.4% of the catalogue. **"Models that do not report their context size" is a rounding
error, not a design constraint** — provided the registry is fetched live.

**Three defects in the current pipeline, all confirmed in source:**

1. **The catalogue is a static npm file.** `keysync/keysync.mjs:74` reads
   `@musistudio/claude-code-router/dist/models.json`, a models.dev mirror dated 2026-08-24,
   inside a dependency UW does not control. Live models.dev has 7,527 models at 100%
   coverage; the bundled copy has 4,298 at 94.3%. It refreshes only when CCR is upgraded.
2. **UW computes the right number and throws it away.** `keysync/keysync.mjs:312` attaches
   `contextTokens` to each picker row; `keysync/run.mjs:590` deletes it one step later:
   `options: built.picker.map(({ contextTokens, ...row }) => row)`. 1,500 correct values
   discarded.
3. **No live discovery exists.** No code path reads a context length from a provider's own
   `/v1/models`. The `/v1/models` calls in `keysync/extract*.mjs` and `probe*.mjs` are
   scratch spikes that read ids and pricing only.

**A live over-declaration in the shipped picker.** `openrouter/mimo-v2.5-pro` shows
**1,050,000** in UW; OpenRouter's worst endpoint for it serves **262,144**. The same model
family across UW's own providers carries four different numbers:

```
openrouter/mimo-v2.5-pro    1,050,000
kilo/mimo-v2.5-pro          1,048,576
zenmux/mimo-v2.5-pro        1,048,576
huggingface/mimo-v2.5-pro   1,048,576
huggingface/mimo-v2.5         262,144
```

---

## 10. Why the ideal is unreachable inside Claude Code

DeepSeek Harness demonstrates the target is achievable. Its compaction policy is
**re-resolved on every pre-step check against the currently routed provider and model**, so a
model switch mid-session changes capacity and policy immediately. That works because the
harness owns its own compaction loop.

Claude Code does not expose one. Its believed window is resolved by a single function
(minified `lU`, read from the 2.1.259 binary):

```js
function lU(e, n) {
  if (Gc(e)) return 1e6;                            // Gc = /\[1m\]/i.test(e)
  if (fJe(n)?.includes(qI.header) && Tk(e)) return 1e6;
  let r = bvn(e);
  if (r !== void 0) return zEt(e) ?? r.believed;    // catalogue hit RETURNS HERE
  if (og(e)) return 1e6;
  let o = zEt(e); if (o !== null) return o;
  let d = a.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
  if (d !== void 0 && d > 0 && sU(e)) return d;     // env var, reached only on a MISS
  return Ype;                                       // 200000
}
```

Three consequences, each verified:

**`autoCompactWindow` cannot raise the window.** Claude Code's own internal schema describes
`effective_window` as *"resolveAutoCompactWindow output **clamped to the model window**"*. The
setting hot-reloads, but it can only lower the compaction point, never raise it.

**The only lever that raises it arbitrarily is an environment variable, and environment is
read at process start.** `settings.json` hot-reloads and explicitly re-applies its `env`
block on change; the process environment does not. So per-model dynamic switching inside one
running process is closed.

**`behavesAs` blocks the lever.** `keysync/keysync.mjs:311` sets `row.behavesAs` on every
non-Anthropic picker row, with a verified comment explaining it was added because without it
Claude Code *"does not recognize a provider-format id, warns on every launch."* That same
recognition makes `bvn(e)` hit and return at step 3, so
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` is never read for those rows. This answers **probe P6**,
recorded as deferred at `plans/phase6-menu-and-catalogue.md:11124` and, as far as this pass
could determine, never run: `behavesAs` wins, and it was UW's own choice — a quiet launch
traded for a wrong context window.

The CCR route is independently closed: Claude Code's documented gateway-discovery contract
reads **only `id` and `display_name`**, so even if CCR fixed its open issue #1597 and
advertised a context length, Claude Code would ignore it.

---

## Addendum (2026-09-05): Anthropic rows are no longer static, new mechanism confirmed

Written after shipping dynamic `[1m]` tagging for UW's Anthropic subscription rows
(`claude-sub-models` branch) and a follow-up capability investigation. Updates sections 9
and 10; does not change sections 1-8 or 11's recommendations, which stand unchanged.

- **The "4 Anthropic relay rows, hardcoded null" in section 9 is stale.** Shipped this
  session: `[1m]` tags are computed live from Anthropic's real `/v1/models`
  `max_input_tokens` field (the relay is a confirmed pure passthrough), refreshed on every
  `keysync run`. Row count is whatever Anthropic currently serves — 11 at last
  measurement, not a static 4, and no longer hand-tagged. `hud-shim`'s exclusion of these
  rows is now correct for a stronger reason than before: Claude Code computes their window
  correctly natively via the `[1m]` marker, so there is nothing left for the shim to fix.

- **New mechanism: Claude Code's catalog matcher canonicalizes by substring, not exact or
  prefix match.** `Xh(e)` lowercases the id and checks `e.includes("claude-opus-5")`, etc.,
  falling back to stripping a trailing `-\d{8}` date suffix. A provider-prefixed,
  `[1m]`-suffixed id such as `anthropic/claude-opus-5[1m]` therefore resolves to the
  correct baked-catalog entry WITHOUT `behavesAs` — confirmed empirically, not just from
  source: a row with no `behavesAs` is still selectable in `/model`, and CC filters any
  `"unknown"`-status row out of that list entirely, so visibility itself is proof of
  correct resolution. `[1m]`/`[2m]` decoration is also stripped before this match, and
  dated ids (`claude-opus-4-5-20251101`) canonicalize to their family via the same rule.

- **`behavesAs` is a strict fallback, only consulted when a row is otherwise unrecognized**
  (`isKnown(id)` false) — not a general override, and not reachable at all for a row `Xh`
  already resolves. For the 83 non-Anthropic rows it is load-bearing precisely because
  their ids never match `Xh`'s Claude-shaped substring rules; there is no way to phrase a
  non-Anthropic id so Claude Code recognizes it without either `behavesAs` or the launch
  warning it exists to suppress.

- **Capability fields split cleanly from context, same ceiling for the gated ones.**
  Confirmed separately this session: Claude Code never reads Anthropic's API-reported
  `capabilities` object at all — the fetch path that would parse it is dead code in the
  build read, and its own schema strips `capabilities` even when live. Of the API's nine
  fields, six (`pdf_input`, `image_input`, `batch`, `citations`, `code_execution`,
  `structured_outputs`) have no client-side gate whatsoever — already fully dynamic
  through any pure-passthrough relay, no engineering needed. The remaining three
  (`effort`, `thinking`, `context_management`) are gated through the SAME baked catalog as
  the context window, so they carry the identical ceiling this section documents: correct
  and auto-updating for the dynamically-tagged Anthropic rows, frozen at whatever
  `claude-sonnet-4-6` was baked as for the 83 `behavesAs` rows, for the same reason context
  is.

- **`run.mjs:869` still strips `contextTokens` before writing `modelPicker.options`,
  confirmed present as of 2026-09-05** (current line number; untouched by this session's
  Anthropic-specific work, which runs through a different code path). Section 11's
  recommendation to stop doing this is unaffected and still open.

- **An investigation was in flight as this addendum was written**, chasing whether this
  section's "unreachable inside Claude Code" conclusion has a genuine loophole —
  specifically whether the window-resolver is re-evaluated fresh per model on every check
  (which would mean the `[1m]`/catalog branches already track a live switch, and only the
  env-var branch is frozen), whether the env-var read is a live `process.env` reference or
  a startup snapshot, and whether `behavesAs` could bucket the 83 rows across the baked
  catalog's several distinct real windows (some 1M, some 200k) instead of one blanket
  value. Results were not yet in when this addendum was written; expect a further update.

## 11. What transfers to UW regardless

Even with the Claude Code ceiling in place, most of this survey applies to UW's own picker,
which owns its display and its catalogue:

1. **Fetch the registry live**, three-layer as opencode does: compiled snapshot, disk cache
   with a short TTL, background refresh. Removes the dependency on CCR's npm version.
2. **Resolve by provider, then bare model id, then minimum on ambiguity.** Measured to close
   37 of 88 gaps. The minimum rule is not caution — for an aggregator it is correctness.
3. **Fetch OpenRouter per-endpoint**, as Roo does, for any aggregator provider. Measured
   necessary: `top_provider` is wrong ~6% of the time and 4× wrong in the observed case.
4. **Stop stripping `contextTokens`** at `run.mjs:590`.
5. **Do not guess for the ~7 genuine unknowns.** The refusers' argument is strong and their
   failure mode is inertness; the guessers' failure mode is documented in Qwen #7960.
6. **Bias every estimate toward compacting early.** Universal across the field: Cline chars/3
   over chars/4, Kilo × 1.3, Roo 10%, opencode 20k, aider 512.

---

## Not verified, and worth stating

- Whether `behavesAs` also excludes a row from
  `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT`. Inferred from the same recognition
  mechanism, not measured. It is a five-minute empirical check.
- The fraction of the window at which Claude Code's threshold-triggered compaction fires.
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` exists; the default was not found.
- Cline's OpenRouter fetcher was not exhaustively searched for per-endpoint handling.
- Whether `top_provider.context_length` equals the endpoint minimum generally. Sampled 17;
  16 agreed. Not established at scale.
- Amp: closed source. Everything about it here is community reporting.
- litellm's own unknown-model tokenizer fallback was not traced beyond aider's call site.

# Phase 6 — verified facts (2026-09-02)

Established by direct measurement, not inference. Everything here was read out of a
shipped binary or computed from live data. Findings from the parallel research pass
are folded in as they arrive.

## The host constraint: Claude Code's picker cannot do what was asked

Claude Code 2.1.258's own settings validator, quoted verbatim from the binary:

> `"modelPicker" must be an object with an "options" array of
> `{ model, label?, description?, behavesAs? }` rows`

Consequences, all hard:

- **No nesting.** No `children`, no submenu, no second level.
- **No columns.** Two text fields per row (`label`, `description`) and nothing else.
- **No search.** Measured at 89 rows: 10 visible, scroll-only, no type-to-jump, ~10 s
  to locate a row (Finding 12).
- **Read once at process start**, never re-read mid-session (established 2026-09-02
  by live test; this is why the `SessionStart` hook was dropped rather than deferred).

So the requested two-level, five-column, filterable menu **cannot be built inside
`/model`**. It has to live outside Claude Code. That is a relocation of the design,
not a refutation of it.

## The unlock: Router rules repoint aliases with no restart

CCR's restart predicate, extracted from `dist/main/cli.js`, compares exactly:

```
Providers, virtualModelProfiles, agent, mediaTools, plugins,
providerPlugins, toolHub, proxy.targets, proxy.upstream
```

`Router` appears **zero** times in it. Meanwhile a Router rule normalizes to:

```js
// YDe() — `target` is sugar for a body rewrite
r ? [{ key: "request.body.model", operation: "set", value: r }] : []
```

with rule types `condition | model-prefix | script`, conditions of the shape
`{left: "request.body.model", operator: "starts-with", right: <pattern>}`, and
operators `== != > >= < <= starts-with contains contains-deep not-contains`.

**Therefore**: put a small set of *stable alias rows* in `modelPicker` (`uw/slot-1`,
`uw/fast`, `uw/free`…). The user selects a slot once. An external tool then repoints
that slot at any of ~1,569 models by editing `Router.rules[].target` — which restarts
nothing and requires no Claude Code relaunch. The "picker is read only at startup"
blocker dissolves, because the picker contents never need to change again.

`rewrites` also accepts arbitrary `{key, operation, value}`, so per-slot `max_tokens`
and similar body fields are settable — relevant to the small-context failure class.

**Caveat to carry forward**: `guard.mjs` currently asserts *zero enabled Router rules*,
because Phase 2.5's provider-attribution test would be false-greened by a rewrite. That
assertion is correct for that test and must be scoped, not deleted, if rules go live.

## Scale — measured, and it justifies two levels

Bundled catalogue is CCR's `dist/models.json`: **217 providers, 4,298 models**,
generated 2026-08-24.

Restricted to the 44 providers we actually hold keys for:

| | count |
|---|---|
| providers with keys | 44 |
| covered by the bundled catalogue | 21 → **1,546 models** |
| **not** covered (only the vault `testModel` is known) | **23 → 1 model each** |
| realistic total today | ~1,569 |

Distribution is brutally skewed: alibaba 343, openai 337, mistral 193, google 185,
deepseek 105 — five providers hold 75% of it.

Two conclusions:

1. A flat list of ~1,569 rows in a 10-row scroll-only picker is unusable. The provider
   level, at 44 rows, is trivially browsable. **The two-level shape is justified by the
   data**, not merely by taste.
2. **Live discovery is not a refinement — it is what makes the menu non-empty for 23 of
   44 providers.** Half the key library currently shows one model.

The bundled catalogue also sits *inside a node_modules package*: it goes stale on CCR's
release cadence rather than the providers', and an `npm update` replaces it. We must
never write to it, and must not treat it as the source of truth.

## Vault: what the requested provider-level columns can actually be sourced from

`~/.llmkeys/registry.json` — 56 rows, fields `{id, bucket, provider, tier, envVarName,
added, notes}`. Verified `id === "{bucket}.{provider}.{tier}"`.

- buckets: personal 46, tamu 2, sportsvector* 5, personal_maestro 1, personal_mxene 2
- tiers: free 42, paid 13, management 1
- only 2 of 56 rows carry a non-empty `notes`

**Naming correction**: the requested format was "Bucket.Source.Tier" with a Source
column showing `personal`/`tamu`. The real format is `bucket.provider.tier` — what was
called "Source" is the **first** segment (`bucket`), not the middle one. The middle
segment is the provider.

**Redundancy to resolve in design**: the requested columns 1.1 (key id), 1.2 (provider)
and 1.3 (source) are not independent — 1.1 *contains* 1.2 and 1.3 verbatim. Three
columns carrying one fact, in a UI where width is the scarcest resource.

Also: the `tier` segment is `free`/`paid` and the user has stated it is unreliable, so
it must not feed the "free available?" column. That column needs a real signal.

## The metadata problem is already solved, and it is free

CCR's bundled `dist/models.json` (19.7 MB) carries a `sources` block naming three
**public, unauthenticated** endpoints it was built from:

- litellm's `model_prices_and_context_window.json` (raw GitHub)
- `models.dev/api.json`
- OpenRouter's public `/api/v1/models`

Summary block: **4,298 models, 217 providers, 4,078 with pricing**, plus
`limits.contextTokens`, `modalities` and `capabilities`.

**Consequence that reshapes the cost question**: refreshing pricing / context / modality
needs *zero API keys, zero quota, zero rate-limit exposure*. Only the model *lists* for
the ~23 providers absent from that catalogue require an authenticated
`GET {baseUrl}/models` — and that is a listing call, not a completion, so it burns no
tokens.

## Live defects found during this pass (not yet fixed — Phase 6 work)

1. **Non-total sort → gratuitous gateway restart.** `keysync.mjs:196-199` ranks models
   by `(free?0:1)` then `model.length`, with no final tiebreak. Ties keep *input order*,
   i.e. the order of the upstream catalogue file. Because `restartRelevantFingerprint`
   is deliberately order-sensitive (`safety.mjs:248-291`), an upstream reordering
   reshuffles `provider.models[]` and restarts the gateway for zero semantic change.
   Compounded by `inferTier` being broken: every model returns "unknown", so the
   free-tier term is a no-op and **id length is the only discriminator**, making ties
   common. Fix is a `|| a.m.model.localeCompare(b.m.model)` tiebreak — but it is a
   one-time reselection, so it belongs in a deliberate run, not a drive-by edit.

2. **The ratchet is only half fixed.** `verify-cli.mjs` now probes the pre-prune built
   set, but `verify-prune.mjs:113-117` still overwrites `working` with *only this run's*
   passes. A run during which six providers are transiently down therefore ships a
   picker without them. Needs `{model, lastOk, lastFail, consecutiveFails}` plus an age
   refusal — `run.mjs --verified-only` currently accepts a `verified-rows.json` of any
   age.

3. **`EXPECTED_PROVIDERS = 44` is an equality check** (`run.mjs:32`). Once provider
   churn is routine, a legitimately revoked key presents as a keysync failure rather
   than a catalogue signal. Should be a floor plus explicit delta acknowledgement.

4. **The catalogue is read from inside `node_modules`** (`keysync.mjs:73`). An
   `npm i -g @musistudio/claude-code-router` replaces or drops it and keysync then fails
   on a path it does not own. Must be copied out.

5. **CCR has its own auto-refresh timer** — 600 s, gated on any provider having
   `autoFetchModels: true`, and its result path returns `configChanged: true`, i.e. it
   hands the restart trigger to a timer we do not control. keysync sets the flag false
   everywhere; that should become a hard `validate()` invariant rather than a
   convention.

## Maestro: what it proves, and where it does not transfer

Maestro (`D:\TAMUQ\...\maestro`, Rust + ratatui) already implements the requested shape:
two-level provider → model menu, independent substring filters at both levels, 24 h
model cache (`~/.maestro/model_cache.json`, 50 backends, 4,282 models), and the same
Windows Credential Manager vault via `LLMKEY:{bucket}.{provider}.{tier}`.

Three things worth taking:

- **Three-state tier** `Free | Paid | Unknown`, where "Unknown means the heuristic found
  nothing to go on, not that the model is definitely paid" — exactly the requested
  "leave it blank if unsure" rule, already articulated.
- **`infer_tier`**: name suffix (`:free` / `-free` / `/free`) first, then a recursive
  numeric scan of any field whose name contains `pric` or `cost`; all-zero → Free, any
  non-zero → Paid, nothing found → Unknown. Current real distribution: **184 free /
  2,231 paid / 1,867 unknown** — i.e. 44% unknown. That is the honest ceiling of
  heuristics, and an argument for consuming pricing data rather than inferring it.
- **Provider-level filter keys include every member model's id and label**, so typing
  `opus` at the provider level finds `anthropic`. Cheap, and a genuinely good idea.

Two things not to copy:

- **Sequential fetch** of 45 providers at up to 15 s each — an 11-minute worst case.
- **Credential resolution errors abort the entire reload**, so one bad key blocks the
  refresh of all others.

**And the finding that matters most for the column request**: Maestro does *not* render
real columns either. Both levels are composed single strings
(`{provider} ({count}) [free available|paid]`), soft-wrapped, no `Table` widget, no
`Scrollbar`, no horizontal scrolling, explicitly ASCII-only. The tool that already
solved this problem chose composed strings over columns.

## Do not build a metadata store — consume models.dev

Verified live: **models.dev — 212 providers, 7,502 models, MIT**, bot-synced hourly,
served with **ETag + must-revalidate** (so refresh is a cheap conditional GET), and
mirrored as **`@opencode-ai/models`** on npm — zero dependencies, published daily.

Head-to-head against LiteLLM's `model_prices_and_context_window.json` (the other
candidate): 212 vs 131 providers, 7,502 vs 3,518 models, nested vs one flat map with the
provider baked into key strings. The gap matters most exactly where we live — LiteLLM
carries 100 OpenRouter models against models.dev's 354 and OpenRouter's own live 421,
because LiteLLM skews to enterprise cloud SKUs.

Per-model fields present on all 7,502: `id, name, description, attachment, reasoning,
tool_call, release_date, last_updated, modalities{input,output}, open_weights,
limit{context,output}`. `cost{input,output,cache_read,cache_write,tiers}` on 7,066.
`status: beta|deprecated` on 271. Provider level carries `env[]` — the env var names a
provider uses — which lets the UI mark which of our providers are actually configured.

This answers the "any other info we can reliably source" question comprehensively, and
answers it **without a single API key**.

## "Free?" is not a boolean — it is three states, and conflating them misleads

Measured today: models.dev has 594 models at `cost.input == 0 && cost.output == 0`.
OpenRouter's live API returns 421 models, of which **18 end in `:free` but 21 have zero
price** — so the suffix convention is already lossy on its own source of truth. Three
zero-cost OpenRouter models carry no `:free` suffix at all.

**Rule: filter on price, never on the id suffix.** The suffix is a display hint, not a
signal.

The deeper problem is that zero cost conflates three genuinely different situations:

1. **Free, pay-as-you-go, rate-limited** — OpenRouter `:free` (~20 req/min, ~200/day, then 429).
2. **Included in a subscription** — whole providers read as zero because a plan covers
   them: `alibaba-token-plan` 26/26, `nvidia` 99/103, `zhipuai-coding-plan` 9/10,
   `gitlab` 23/23. Labelling these "free" is actively misleading.
3. **Genuinely paid.**

Maestro's live distribution (184 free / 2,231 paid / **1,867 unknown**) shows heuristics
plateau at ~44% unknown. Consuming real pricing data is what collapses that.

Also worth surfacing, since users pick dead models constantly: `deprecated` (193) and
`beta` (78).

## Interaction pattern: Miller columns, not horizontal scroll

The prior art is unanimous and the reasoning is sound: **a row's columns carry meaning
relative to each other, and horizontal scrolling destroys exactly that.** Horizontal
scroll shows all rows but never all fields; a detail pane shows all fields of one row.
For "what does *this* model cost and support", the detail pane wins.

Strongest fit is the **yazi/ranger Miller-columns** shape, which maps the two-level
hierarchy onto horizontal flow without ever losing level-1 context:

```
┌ providers (filter) ─┬ models (filter) ────────────┬ detail ────────┐
│ > openrouter   354  │ > deepseek-v3.2        FREE │ ctx    163,840 │
│   anthropic     27  │   qwen3-coder      $0.3/1.2 │ in     $0.00   │
│   groq          20  │   glm-4.6          $0.6/2.2 │ tools  yes     │
└─────────────────────┴─────────────────────────────┴────────────────┘
```

Column priority, dropped right-to-left as width shrinks (omit whole columns rather than
truncating mid-cell; freeze the name column):
`[name][ctx][$in/$out][FREE] │ [tools][vision][reasoning] │ [released][status]`

The cautionary tale is `perf`'s hists browser, which shipped with no horizontal scroll
and made wide content simply unreachable; when it was added, reviewers insisted it move
**by column, not by character**.

## Toolchain: Ink + fuzzysort, and why fzf --preview is a trap on Windows

`fzf` the binary is fine on Windows (official builds, winget/scoop/choco). **`--preview`
is not**: fzf spawns preview commands through `cmd.exe` even when launched from
PowerShell, so previews need cmd syntax, and fzf auto-escapes placeholder expansions in
ways you cannot easily opt out of (upstream fzf#2609, labelled a Windows issue). The
standard workaround is shipping a helper script and paying `pwsh` startup per debounced
keystroke.

So the two-stage *pipeline* idea is right; the `--preview` half is where the pain is.

- **`fuzzysort`** v4.0.2, MIT, **zero deps**, 9.6M/wk, actively maintained — returns
  match indices for highlighting, which is what makes fzf *feel* good. Recommended.
- **`fuse.js`** — a relevance engine (Bitap, typo-tolerant); heavier and slower than
  needed for fzf-style prefix/subsequence matching.
- **`fzf` npm (`fzf-for-js`)** — the real algorithm in JS, but **no release since
  2023-04**. Vendorable, not dependable.
- **`fzy`** — C, POSIX-only, no Windows build. Ruled out.

## Affordances the prior art says matter more than columns

- **Aliases** (`llm`): with thousands of models, letting the user pin `fast` / `cheap` /
  `smart` to concrete ids is the single highest-value feature here. This maps *exactly*
  onto the Router-alias mechanism above — the alias is not a UI convenience, it is the
  routing primitive.
- **Recent + Favourites pinned on top** (opencode) — with 7,500 models the realistic
  user touches five. But **render duplicates visibly**: opencode's picker removes models
  already shown in Recent, which makes them silently vanish from their provider section
  (opencode#6169: 23 models loaded, ~15 visible).
- **Remember last selection per provider** (Cline's `normalizeProviderSwitchModel`) so
  bouncing between providers doesn't reset to index 0.
- **Filter must be able to search the flattened space**, not just within a level. Two-level
  navigation is good for browsing and actively hostile when the user already knows the
  model name — so a scope toggle is required, not optional.
- **Never require a second gesture to commit a selection** (a documented Roo Code trap).

## CRITICAL security finding: remote model lists are a routing-hijack primitive

This is the single most important result of the research pass, and it changes what may
be built.

Today `Providers[].models` comes from two **locally controlled** sources: the vault's
hand-authored `testModel`, and CCR's bundled catalogue. The proposed design replaces
both with a list **the remote provider writes**. That is precisely the input the bare-id
guard (added 2026-09-02) documents itself as unable to control.

The ranking rule makes it deterministic rather than lucky. A hostile or compromised
aggregator publishes `{"id":"opus","pricing":{"input":0,"output":0}}`; a *fixed*
`inferTier` returns `free`; free sorts first; it lands inside `MAX_MODELS_PER_PROVIDER`;
and if it is the unique provider listing that bare name, CCR's cross-provider fallback
binds Claude Code's built-in rows to it. Full system prompt, tool definitions, file
contents and responses route to an attacker-chosen host, silently.

Note the irony to carry into the design: **fixing `inferTier` is what arms this.** While
tier inference is broken, "free-first" is a no-op and the promotion path does not exist.

Of the 44 providers, a large share are small aggregator hosts with no meaningful security
assurance (`routllm.pro`, `seekai.cc`, `tabitoken.com`, `ineed.web.id`, `gorouter.app`,
`teamorouter.com`, `tokenharbor.ai`, `router.bynara.id`, `apihub.agnes-ai.com`,
`commandcode.ai`, `zenmux.ai`, `kilo.ai`). Any one of them gets this primitive.

**Required controls before any remote list is admitted:**

1. A reserved-name denylist at ingest — `/^(claude|opus|sonnet|haiku|fable)([-._\d]|$)/i`
   may only come from the trusted relay provider.
2. The existing bare-id `console.warn` becomes a **hard failure** once lists are remote.
3. `MAX_MODELS_PER_PROVIDER` must NOT be lifted when the source becomes remote — it is
   currently the only thing bounding both picker size and this attack surface.

### Other security constraints that shape the architecture

- **Fetch directly, never through the CCR gateway.** `request_logs.url` is stored
  **unredacted** (headers *are* redacted — verified across 40 live rows — the URL is
  not). Google's native model-list endpoint carries the key as `?key=<API_KEY>`. And a
  44-provider sweep is error-dominated (only 14 of 44 currently serve), which is exactly
  the population captured verbatim at 100% under the `errors` policy. Use
  `redirect: "manual"` — Node's `fetch` defaults to following, and forwards
  `Authorization` across same-scheme cross-origin redirects on some runtimes.
- **Never schedule a privileged write.** Split `refresh` (schedulable, cache-only, no
  `settings.json`, no `config.sqlite`, no gateway restart) from `apply` (manual,
  diff-then-confirm, `--i-know` stays meaningful). A scheduler supplying `--i-know` on
  every run converts a consent gate into a constant.
- **`settings.json` post-write verification is presence-only on three fields** while the
  file carries 20 top-level keys including `permissions`, `autoMode.environment`, 18
  `enabledPlugins`, and `skipDangerousModePermissionPrompt: true`. Needs a conservation
  check: no key lost, no security-critical key modified, no unexpected key added.
- **`resolveProtocol` matches on substring, not host** — `https://evil.example/anthropic/`
  would resolve as Anthropic. Latent today (no current entry matches), wrong by
  construction. Parse the URL, enforce https, match on hostname, and pin an expected-host
  allowlist in code rather than in the tamperable `providers.json`.
- **Terminal escape injection is real** for provider-controlled ids/labels rendered in a
  TUI. JSON injection into `settings.json` is **not** a risk (`JSON.stringify` is
  structurally safe) — do not spend effort there.

## Prior art recovered: a working Rust TUI, rescued from %TEMP%

`C:\Users\osami\.uw\prior-art\uw-rust-tui` (copied 2026-09-02 from a scratchpad that
would have been swept). A complete Cargo crate — ratatui + crossterm + Credential
Manager — that already implements the requested design:

- `model_tier.rs` (448 lines) — schema-agnostic `infer_tier`: suffix detection, then a
  recursive numeric scan of any key containing `pric`/`cost` at any depth, accepting
  numbers *and* numeric strings. **Verified against today's catalogue: `{paid: 3619,
  free: 405, unknown: 274}`** where the JS version returns 100% unknown. Also
  `ProviderPlanRegistry`, which keeps the credential's *plan* tier as a deliberately
  separate type from per-model pricing — exactly the distinction the "free?" column needs.
- `menu.rs` (475) — the two-level provider→model picker with independent filters.
- `ui.rs` (631) — renders per-model tier and plan hint so they cannot be confused.
- `http.rs` — load-bearing constraint: **the catalogue client's User-Agent must contain
  "claude"**, because CCR branches `/v1/models` on `isClaudeCodeUserAgent` and only that
  branch returns the Anthropic shape and the `[1m]` variants.
- `catalog.rs` — carries an `#[ignore]`d test pinning a real gap: CCR route ids are
  hex-encoded (`anthropic/claude-ccr-h<hex>`) and collapse to one bogus group.

## Confirmed dead code and unused signals in the current pipeline

- `inferTier` classifies **0 of 4,298** models. Correct path is
  `pricing.offers[].per1MTokens.{input,output}` → `{paid: 3387, unknown: 499, free: 412}`.
  Consequence: the free-first sort degrades to **pure shortest-id**, which is why
  `google/lyria` (music) and `google/veo-2` (video) beat `gemini-2.5-pro` into the picker.
- `description` is empty on **83 of 87** rows — the only differentiating display surface
  carries nothing.
- `contextTokens` is computed for 42 rows then stripped at write (`run.mjs:464`).
- `displayName` exists for 2,858 models and is never consulted; labels are mechanical
  `provider > raw-id` restatements of the `model` field.
- `capabilities.toolCalling` / `modalities` are carried by all 4,298 entries and read by
  nothing — which is why audio and video models ship into a chat picker.
- **34 of 47 providers document a live model-listing endpoint in their `notes`, and
  nothing calls any of them.**
- Only **6 of 44** providers have their `testModel` present in the catalogue.

## Provider call shapes: 7 clusters, and the long tail is only 6 providers

`providers.json` records **no model-listing field at all** — `ApiKeyVault.ps1` only ever
builds `{baseUrl}/chat/completions` or `{baseUrl}/messages`. The listing path is pure
convention (`{baseUrl}/models`), and every deviation lives in free-text `notes`. So a
refresher must default to the convention and hard-code the exceptions.

Second structural fact: **every baseUrl is already version-complete** (43 end in `/v1`,
google is `/v1beta/openai`, bigmodel `/api/paas/v4`, kilo has no version segment, and
githubcopilot is empty). Never append `/v1` — always append exactly `/models`. No
baseUrl has a trailing slash, so plain concatenation is safe for all 46 non-empty entries.

| Cluster | n | Handling |
|---|---|---|
| A — plain OpenAI | 38 | `GET {base}/models`, Bearer, `{data:[…]}` |
| B — non-`/v1` version segment | 3 | identical *if* you concatenate; breaks only on a hard-coded `/v1/models` (google, bigmodel, kilo) |
| C — non-`data` envelope | 1 | aionlabs returns `{models:[…]}` — parse `data ?? models` |
| D — WAF headers | 1 | agentrouter needs 3 static headers or 401s |
| E — non-Bearer auth | 2 | anthropic (`x-api-key` + `anthropic-version`), youcom (`X-API-Key`) |
| F — different or absent endpoint | 2 | cloudflare `/v1/models` **405s** (needs the native `…/ai/models/search`); youcom 403s |
| G — no HTTP surface | 1 | githubcopilot: empty baseUrl, must be skipped or it builds a garbage request |

**A+B+C = 41 of 47 through one loop.** Six need per-provider code.

`headersTemplate` already encodes auth variance in only 4 distinct values, and the extra
WAF headers are newline-separated inside it — so a parser that reads only the first line
silently 401s on agentrouter. That is the one parsing trap in the file.

### Data-quality issues found in the vault

- **`anthropic` has no credential in registry.json** — the only providers.json entry with
  zero registry match. A refresher would have nothing to authenticate with (irrelevant in
  practice: we reach Claude through the OAuth relay, not this entry).
- **Two orphaned credentials with no provider profile**: `personal.inferx.free`, and
  `personal.vercel.free` whose provider is `VERCEL` — uppercase, violating the lowercasing
  every other entry follows, so it fails profile lookup.
- **bigmodel's notes are wrong** — they say `GET /v1/models` but the host has no `/v1`.
- **commandcode path is ambiguous** — notes say `GET /models` while baseUrl already ends
  `/provider/v1`. Needs one probe to settle.
- **`accountInfo` is effectively a 7-entry field** — present on 29 but 22 of those are `{}`.
- **34 of 47 entries are stamped 2026-08-19** and several notes carry a mangled `$0`
  (`"No \ models"`), evidence of a lossy write path.
- **xai is missing from Maestro's cache** despite being a plain cluster-A entry with no
  explanatory note — worth one probe.

### The strongest recorded argument for "leave the free column blank"

The vault's own live-probe notes already document that a catalogue is not an entitlement:

- **b.ai** lists 42 models; **7** actually answer on a zero-balance key. The rest return
  `403 Deposit required`.
- **commandcode**: all 58 models on both endpoints return `400 insufficient credits`.
- **veniceai**: `/models` returns 200 with full pricing; every chat call returns
  `400 Insufficient USD or Diem balance`.
- **indeedwebid**: listing 200s, every chat call 502s.

A models endpoint tells you what a provider *lists*, never what your key can *call*.

### Cost warnings that must gate any probing

- **tabiai**: *"a trivial test prompt used 6554 prompt_tokens — a large hidden system
  prompt is injected server-side … At Opus pricing this is NOT a negligible-cost test."*
- **gorouter**: *"treat a first real call here as similarly non-negligible-cost."*
- **teamorouter**: *"avoid routing sensitive prompts until more trusted."*

Listing calls are safe for all of these; **chat probes are not**. The refresher must never
fall back to a chat probe on these providers.

### Existing proof the fan-out works

`~/.maestro/model_cache.json` — 659 KB, 50 credential slots, 4,282 models — is an
existing successful run of exactly this refresh. The five providers.json entries absent
from it are precisely the bespoke/skip set (githubcopilot, youcom, cloudflare, anthropic)
plus xai. That is independent corroboration of the cluster analysis.

## CCR already implements the fan-out — use `probeProvider`, not our own fetch loop

The single most build-avoiding finding of the pass. CCR exposes **64 RPC methods**, and
among them:

- **`probeProvider` / `probeProviderCandidates`** with `mode: "models"` returns
  `{models, modelDisplayNames, modelSource, detectedProtocol, capabilities,
  catalogModelMetadata, normalizedBaseUrl}` for **one provider, on demand**. It already
  handles protocol dispatch (`openai` → `{base}/models`, `anthropic` → `{base}/v1/models`
  with the version header, `gemini` → its own shape) and iterates **base-URL candidates**
  until one returns a non-empty list.
- `getProviderCatalogModels` — models.json lookup for one provider.
- `getConfig` — the real catalogue source: all providers with their `models[]`.
- `checkProviderConnectivity` — per-model reachability, and notably **parallel**
  (`Promise.all`), proving CCR can fan out even though its own refresh loop does not.

**Consequence for the 7-cluster problem**: we largely do not have to solve it. CCR's
probe path already absorbs protocol and base-URL variance. More importantly, **we never
have to hold the 44 keys in our own process** — CCR already has them, so the entire
"direct fetch with credentials" security surface (key-in-URL, redirect replay, proxy
inheritance, keys resident in a scheduled process) collapses to an RPC call on loopback.
That eliminates most of security findings F2, F5 and F6 by construction rather than by
mitigation.

Caveat to verify: whether RPC traffic on the management port (3458) reaches the request-log
store the way gateway traffic (3456) does. If it does not — and the log store is described
as gateway traffic — this is strictly safer than our own fetch.

## Do NOT enable `autoFetchModels` — it is a restart timer with an append-only merge

CCR ships exactly the feature we want and it is the wrong shape:

- Fires at startup then **every 600 s**, gated on any provider having the flag.
- **Strictly sequential** across providers with `await` inside the loop and **no
  per-provider timeout** — one slow provider stalls the entire cycle. At 44 providers
  this is the latency risk.
- Persists results by calling `saveConfig`, i.e. it mutates `Providers[]` — **the restart
  predicate** — on a timer we do not control.
- The merge is `Su` = a **pure union**. Models removed upstream are **never removed from
  config**. A catalogue built this way only ever grows and silently accumulates dead ids.
- First run is a no-op for additions: new models are only admitted once
  `autoFetchKnownModels` is non-empty, so the first fetch merely seeds the ledger.

keysync already sets `autoFetchModels: false` everywhere. That should become a hard
`validate()` invariant rather than a convention — and the reason recorded is not
"tidiness" but "it hands the gateway-restart trigger to a 10-minute timer".

## `GET /v1/models` on the gateway — useful, but not a neutral catalogue

It exists (both `/models` and `/v1/models`, GET, served synchronously from config, no
upstream call). It returns context windows, display names, and a rich capabilities object
in one of two shapes depending on the client. But:

- **Flat.** No per-provider grouping. `owned_by` is the only provenance hint in the
  OpenAI shape; the Anthropic shape has none.
- **No pricing.** CCR computes it internally (`iQe` emits a `pricing` field) and then
  drops it before serialization.
- **Profile-filtered.** Every builder gates on the active profile's `availableModels`
  allowlist, so it is not a complete dump.
- **IDs are hex-mangled for Claude clients**: arbitrary selectors become
  `anthropic/claude-ccrN-h<hex>` so they pass Claude's client-side `claude-*` validation.
  Decoding is `^anthropic\/claude-ccr(?:\d+)?-h([0-9a-f]+)$` → hex-decode group 1. This is
  the same gap the rescued Rust `catalog.rs` pinned with an `#[ignore]`d test.

So: read `getConfig` for grouping, join `models.json` for pricing, and treat `/v1/models`
as a convenience rather than the source of truth.

## Correction to an earlier note: `resolve()` has FIVE stages, not four

1. explicit `opts.providerName`
2. `provider/model` selector (splits on the **first** `/`; also accepts a `provider,model`
   comma form)
3. the `gatewayModels` map — built **purely from static config**, not from any network
   discovery (there is no separate "live-discovered map"; `autoFetchModels` is "live" only
   because it writes fetched models *into* config, which this map then reads)
4. bare-name, **case-sensitive**, across all providers
5. bare-name, **case-insensitive**, across all providers

And a sharpening that matters for the hijack analysis: a tie at stage 4 returns
`undefined` and **does not fall through** to stage 5. Ambiguity is a hard stop, which is
why two providers listing the same bare name is a clean failure rather than a coin flip.

## DEFINITION (user-set, governing): what "free" means

> **A free model is one with 0 pricing whose quota/limits reset regularly.**

A one-time starting wallet credit does **not** make a provider "free available". This is
the correct rule and it resolves the three-state ambiguity recorded earlier, because it
replaces a descriptive question ("is the price zero?") with an operational one ("can I
keep using this next week without paying?").

It introduces a second axis that no earlier analysis had, and that **no provider API
exposes**:

| axis | values | machine-readable? |
|---|---|---|
| price | 0 / non-zero / unknown | **often yes** — models.dev `cost`, OpenRouter `pricing`, provider `is_free` |
| **grant cadence** | **recurring / one-time / none** | **almost never** |

Both must be true for a `Yes`. Price alone is insufficient.

**What this reclassifies.** Providers whose zero-cost appearance comes from a signup
grant are now explicitly **not** free, and several were about to be labelled `Yes`:

- `youcom` — `accountInfo.freeCredits: "$100 complimentary"` → **one-time → not free**
- `aihubmix` — `accountInfo.balanceNote` → one-time balance → **not free**
- providers whose vault notes say "free credit allowance rather than free models"
  (huggingface, llm7, cerebras) → **not free**
- `ollama` — notes record a **daily** allowance → recurring → **free**, if price is 0
- OpenRouter `:free` — 20 req/min, ~200/day, resets daily → **recurring → free**

**Subscription-covered models are a genuine edge case and I want a decision rather than a
guess.** models.dev reports whole providers at `cost: 0` because a paid plan covers them —
`alibaba-token-plan` 26/26, `nvidia` 99/103, `zhipuai-coding-plan` 9/10, `gitlab` 23/23.
These satisfy the letter of the rule (marginal price 0, quota resets monthly) but you paid
for the plan. My reading is they should render as a distinct label — `plan` — rather than
`Yes` or blank, because calling them free hides a real cost and calling them paid hides
that they cost nothing *marginally*. **Flagged for the user, not decided.**

**Design consequence, and it is significant.** Grant cadence is not in any `/v1/models`
response, not in models.dev, and not in LiteLLM. It exists today only as prose in
`providers.json.notes` and `accountInfo`. Therefore:

- The `free available?` column **cannot be fully derived**. It requires a curated,
  hand-maintained, per-provider `grantCadence: recurring | one-time | none` annotation.
- That annotation belongs in `providers.json` (human-curated, never machine-overwritten —
  the architect's rule) as a new structured field, replacing the current situation where
  this knowledge is trapped in free text.
- Until a provider carries that annotation, its cell stays **blank**, per the standing
  rule. Blank is the correct default and will be common — that is honest, not a gap.
- `registry.json.tier` (`free`/`paid`) must still never feed this column: it describes the
  **credential's account plan**, not the model, and the vault's own routllm note says so
  explicitly.

Detection precedence for the `free?` column, in order:

1. **explicit per-model flag** — `is_free` (gmicloud, huggingface) → trust it, gated on cadence
2. **explicit price == 0** from a first-party models endpoint or models.dev → candidate
3. **curated `grantCadence`** for that provider decides whether a candidate becomes `Yes`
4. **id suffix** (`:free` / `-free` / `/free`) → weak positive only, never a negative, and
   never used alone outside a provider we have probed (it is demonstrably wrong on
   Pollinations, where suffixed ids carry non-zero prices)
5. otherwise → **blank**

## Free-detection, resolved: three findings that change the schema

### 1. A public, unauthenticated pricing endpoint exists for the New-API gateways

Several small gateways run the open-source **New-API / One-API** codebase, which exposes
an **unauthenticated `/api/pricing`** route that `/v1/models` does not. Live-probed:

| base | `/api/pricing` | entries |
|---|---|---|
| `api.tokenrouter.com` | **200, 62 KB** | 134 |
| `router.bynara.id` (nararouter) | **200, 27 KB** | 54 (custom, richer) |
| `agentrouter.org` | **200, 1.1 KB** | 5 |

That converts three providers from "id-suffix only" to **first-party price data**, with no
credential involved. Worth re-probing periodically for seekai, tabitoken, b.ai,
tokenharbor, teamorouter, ineed and aihubmix — they may open up.

### 2. THE LANDMINE: `model_price == 0` does not mean free, and the naive test labels Claude Opus as free

New-API bills two different ways. `model_price` is only used when `quota_type == 1`
(fixed per-call); when `quota_type == 0`, billing runs off `model_ratio × group_ratio`.

```
correct:  (quota_type == 0 && model_ratio == 0) || (quota_type == 1 && model_price == 0)
```

Measured false-positive rate of the naive `model_price == 0` test:

| gateway | naive says free | actually free |
|---|---|---|
| tokenrouter | **123 of 134** | **3** |
| agentrouter | **5 of 5** — including `claude-opus-4-8` at `model_ratio: 4` | **0** |

This compounds the CRITICAL hijack finding: a naive parser marks a *Claude-named* model
as free on a third-party gateway, free sorts first, and it lands in the picker. The two
defects would chain.

Also note `stealth/ox-alpha` on tokenrouter — genuinely free, **no suffix**. Another
recall failure for the id convention.

### 3. `free` cannot be a boolean — Nara Router proves it

Nara Router publishes `free_for_paid` (bool) and `free_min_balance` (int). Six models are
**simultaneously** suffixed `-free`, **non-zero priced**, and **genuinely free above a
balance threshold**:

```
deepseek-v4-flash-free  in=0.157  out=0.315  free_min_balance=10000
glm-5.3-free            in=7.435  out=23.366 free_min_balance=15000
```

No boolean represents that honestly, and forcing `false` would be exactly the wrong answer
the user's rule exists to prevent. Schema must be an enum plus provenance:

```
free_state          ∈ { zero_price, plan_covered, quota_covered, paid, unknown }
free_state_source   ∈ { api_price, api_flag, api_plan_field, curated, absent }
free_state_verified_at : timestamp        # curated entries also carry an expiry
```

### Guards that force BLANK regardless of price

- **G1 — zero *token* price on a non-text-output model** means billed in another unit, not
  free. (nararouter `agnes-image-*`, `grok-imagine`, `nano-banana-pro`.)
- **G2 — New-API parsed with the naive predicate** (see above).
- **G3 — internal/staging ids** (`ai_infer_test_*`, `dev/*`, `bunny`, `gt-4p`) or a
  non-available status (novita `status == 4`, fireworks `state != READY`).
- **G4 — "catalogue lies" providers** (b.ai, commandcode, veniceai, indeedwebid, tabiai,
  gorouter): a listing is not an entitlement, so blank unless a dated live probe exists.

`false` is only safe when a first-party feed returned **both** token prices, at least one
non-zero, for a text-output model, from a provider not on the G4 list.

### Rate-limit headers cannot help — measured, not assumed

Full response headers captured across 19 small-provider probes plus 12 majors:
**no `/v1/models` endpoint returns any `x-ratelimit-*`, `retry-after` or credit header.**
They exist only on **inference** endpoints — and OpenRouter emits them only on 429s.

This is the empirical proof behind the user's definition being hard to automate: the
"quota resets regularly" axis is visible only by making the billed call we are trying to
avoid. Groq is the clean case — its free-tier state exists *only* in inference response
headers, which is precisely why Groq's cell must stay blank.

Two quota signals that ARE free to read: Pollinations' `per_user_rpm` (210/362 models, in
the models response) and OpenRouter's `GET /api/v1/key` (`limit_remaining`, `usage_daily`,
`is_free_tier` — authenticated but not billed).

### Coverage reality for the 23 uncovered providers

- **Public `/v1/models` with usable price data: 3** — nousresearch (378 models, an
  OpenRouter-schema clone plus `synthesizedFreeVariant` and `pricing.original`; 6 free,
  price and suffix agree perfectly), routllm (price **and** `tier_required`), and
  commandcode (62 models, **zero** price information).
- **models.dev covers only 7 of 23**, and its coverage is thin where it exists:
  tokenrouter is **1 of 134** models, and its gmicloud entry **contradicts gmicloud's own
  `is_free` flag**. Rule: first-party beats models.dev whenever both exist.
- gorouter and tabiai are WAF-blocked (403) and their vault notes warn a probe bills real
  Opus usage — **do not probe**.

## Claude Code picker internals — read from the 2.1.258 binary

### Search exists in the code and is hard-disabled

The picker instantiates its search hook as `gSe({canEnter: !1, ...})`. With that flag
false, the keybinding registers as `isActive: false` and the literal `"/"` handler sits
behind `if(!I)return`. **Search mode can never be entered from the model picker**, so
`isSearchMode` stays false and `query` stays `""` for the dialog's life.

The dead machinery is fully built: a **substring, case-insensitive** filter over
`label + description` (not fuzzy), the `/` trigger, and unreachable strings
`"Search models…"`, `` `No models match "${Qo}"` ``, `"Type to filter"`. A subsequence
matcher exists elsewhere in the binary but is **not** wired to this filter.

Implication: this may be enabled in a future release, and if it is, it will match on
`label` and `description` — which is an argument for putting searchable words in those two
fields rather than treating them as decoration.

The complete ModelPicker keybinding set is `left`/`right` (effort) and `s`
(this-session-only), plus the generic Select bindings. **No type-to-jump of any kind.**

### Hard rendering limits, quantified

```js
xo = Math.max(2, Math.min(10, Math.floor((Ne - 14 - Wo - Ko - nn) / 2)))
```

- **10 visible rows maximum, 2 minimum**, regardless of terminal height. Two terminal
  lines are budgeted per row.
- **Label is truncated** to a column capped at **60% of terminal width**
  (`Math.floor(Co * 0.6)`).
- **Description is NOT truncated** — it renders with `wrap:"wrap"`, so a long description
  wraps onto extra lines and blows past the 2-lines-per-row budget the viewport assumes.
- Viewport, not pagination; scrolling **wraps** at both ends. Overflow shows a "+N more"
  line.
- Disabled rows are moved to the bottom, losing their declared position.
- **No horizontal scrolling** — zero matches for `scrollLeft`/`horizontalScroll` binary-wide.

### Finding 11's "+2" explained exactly

`replaceBuiltInOptions: true` executes `[...e.filter(T => T.value === null), ...y]`.

- **Extra row 1** is the **Default** row — the sole `value: null` row, which the filter
  deliberately preserves.
- **Extra row 2** is the **currently-selected model**, force-appended *after* the
  replacement runs, by a separate branch in the option builder.

So `Default + 87 curated + current = 89`, and `Default + 18 curated + current = 20`. Both
measurements reproduce exactly. The observed label `"Opus 5 (1M context)"` comes from the
generic path: catalogue `display_name` + `" (1M context)"`. **If the session's current
model is already one of the curated rows, the delta is +1, not +2.**

Finding 11's conclusion ("the flag does not remove built-ins") was directionally right but
imprecise: it *does* remove the built-in lineup — those two rows come from elsewhere.

### Two silent-failure modes that must be guarded

1. Every curated row must pass an eligibility predicate; failures are `continue`d **with
   no warning**.
2. **If every curated row fails, `if (y.length === 0) return e`** — the entire
   `modelPicker` block is silently ignored and the built-in lineup renders as though the
   setting were unset. A malformed picker therefore looks like no picker at all, which is
   the worst possible diagnostic.

Also: enabling `availableModels` re-resolves each row through the catalogue and **drops
rows that are not in it** — so an allowlist can silently delete curated rows.

### `behavesAs` does more than documented — it sets the context window

The schema describes it as prompt profile / capability / effort defaults. In fact it is
folded into `Ve`, the central model-normalisation function, so it also governs **context
window**, pricing, and effort support. Unmapped, uncatalogued models fall back to
`Rme = 200000`. Two sharp edges:

- Believed context is capped at 200k even when the catalogue declares more.
- The `[1m]` suffix test runs on the **raw** id *before* any `behavesAs` resolution, so an
  id ending in `[1m]` gets 1M regardless of mapping.

### A real dynamic-list mechanism exists, and CCR's hex-encoding is the key to it

`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` makes Claude Code fetch
`GET {ANTHROPIC_BASE_URL}/v1/models?limit=1000` at startup and build picker rows from it.
Gated on: the flag, first-party auth mode, and `ANTHROPIC_BASE_URL` pointing at a
**non**-first-party host — which is exactly our CCR gateway.

Four hard constraints:

1. The gateway must serve the Anthropic shape — **CCR already does.**
2. **Every model id must match `/(claude|anthropic)/i` or it is filtered out.**
3. Results are cached and read on the *next* start, so new models appear **one restart late**.
4. Rows are added *before* `replaceBuiltInOptions` is applied, so `true` erases them.

Constraint 2 finally explains CCR's hex-encoding: `anthropic/claude-ccrN-h<hex>` exists
precisely so arbitrary selectors survive this regex. The two mechanisms are designed for
each other. Worth evaluating as an alternative to a static picker — though the opaque ids
and the one-restart lag are real costs.

### Other extension points, swept

- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` (+`_NAME`/`_DESCRIPTION`) **replace**
  the corresponding built-in row with a custom id and label. Four slots.
- `ANTHROPIC_CUSTOM_MODEL_OPTION` adds exactly **one** row.
- **No hook can contribute rows.** `PreModelSwitch` is a veto (`block`/`ask`/`proceed`) only.
- **No custom slash command can shadow `/model` or render UI** — `/model` is a hardcoded
  `local-jsx` built-in, and every user/plugin command is `type: "prompt"`.
- **MCP cannot help**: elicitation is explicitly flat-primitives-only and unrelated to
  model selection.
- **No nesting concept exists anywhere in the Select module** — no column, group, submenu
  or tree. The only second dimension is the effort slider, which modifies the focused row
  rather than descending into it.

**Conclusion, now exhaustively verified rather than inferred: a two-level menu is not
possible anywhere inside Claude Code.**

### Where a selection goes

- **Save as default** → writes `model` into `~/.claude/settings.json`.
- **This session only** (`s` key) → in-memory app state, no settings write.

The option list is rebuilt every time the picker opens, but from a **cached** settings
store. An in-app settings write invalidates that cache; whether an *external* edit does is
unresolved — no evidence found either way.

---

# SETTLED DESIGN DECISIONS (user-approved)

## D1 — Two-level menu: CONFIRMED, over the flat-list recommendation

The information-architecture research recommended a flat filterable list, on the evidence
that the user's own traffic is 26 distinct models with the **top 5 at 91.3%**, and that the
hierarchy is already encoded in the `provider/model` string.

**The user has decided for the two-level menu.** That decision is sound and the earlier
analysis undersold one point in its favour:

**The credential axis is a genuine second dimension the model string does not encode.**
`google` appears under **4 separate credential rows**, `groq` 3, `zenmux`/`deepseek`/
`openrouter` 2 each. A flat list can only express that by repeating `personal.google.free` on
every one of google's 185 rows. The two-level shape states it once, at level 1.

Cost assessment, honestly: **not complex** (~120 lines for the whole state machine, with two
working reference implementations — Maestro's shipping `apps/tui`, and the rescued `menu.rs`
whose tests all pass; the broken module was `ui.rs`, the renderer, which is being replaced
anyway), and **not a serious regression** given three mitigations that are mandatory rather
than optional:

1. **Level-1 filter keys must include every member model's id and label** (Maestro's trick,
   `types.rs:1090-1098`), so typing `opus` at the provider level finds `anthropic`. This is
   what removes most of the navigation tax — you filter by the thing you are looking for even
   at the top level.
2. **A scope toggle** to search the flattened `provider/model` space when the model name is
   already known. Two-level nav is good for browsing and hostile when you know the answer.
3. **Recent + Favourites pinned at level 1**, so the 91% case costs zero navigation steps.
   **Render duplicates visibly** rather than removing them from their provider section, or
   opencode#6169 is reproduced (23 models loaded, ~15 visible).

## D2 — Provider-level columns: drop two, add one (APPROVED)

Requested columns were: key id, provider name, source/bucket, "free available?", model count.

**Dropped:**
- **provider name** — a verbatim substring of the key id
- **bucket / source** — likewise a verbatim substring

`personal.alibaba.paid` already contains both. Three columns carrying one fact, in the place
where width is scarcest.

**Kept:**
- **key id** (`bucket.provider.tier`) — the disambiguator, and the only thing that separates
  google's four credential rows. Max 30 chars, p50 22.
- **model count** — genuinely independent of the key.
- **"free available?"** — kept, but redefined per the governing definition (0 price AND a
  quota that resets regularly), rendered from real per-model data rather than the credential's
  `tier` segment, and **blank whenever uncertain**.

**Added:**
- **health** — 8 of 47 providers carry notes saying they are currently broken
  (`502 upstream_error on all tried models`, `key valid, chat backend down`,
  `Retest before relying on it`), 16 of 47 set `requiresBalance: true`, and 33 of 47 have not
  been re-verified since 2026-08-20. Browsing into a provider that 502s is worse than not
  seeing it listed at all.

## D3 — HARD CONSTRAINT: model switching must cost zero Anthropic tokens

The user rejected the conversational design (`/uwmodel <filter>` → assistant searches the
catalogue → assistant repoints the route) on the grounds that **every switch would burn
Anthropic tokens and add latency**. Switching is a frequent action; routing it through an
assistant turn is the wrong shape.

**Kept as PLAN B**, to be used only if no zero-token mechanism works.

This constraint eliminates a whole class of designs, and it is worth stating why:

- **MCP elicitation is out.** An MCP tool is invoked *by the assistant*, so any elicitation
  UI costs a turn — even though the UI itself would have been the nicest in-session picker.
- **Custom slash commands are out as the primary path.** They are `type: "prompt"`; by
  definition they inject a prompt and cost a turn.
- **Anything that requires the assistant to act is out.**

**The only zero-token surfaces are those that run without the assistant:**

1. **`/model` itself** — already user-driven and free. Its constraint is navigation (a 10-row
   viewport and disabled search), *not* capacity: 10 is the viewport, and 89 rows have already
   been rendered and scrolled. Whether ~1,569 rows can be held and navigated tolerably is the
   open question.
2. **Hooks** — they run as scripts on user action, before any model call. The infrastructure
   already exists (`~/.claude/hooks/hooks/*.mjs`), `keyword-detector.mjs` already handles
   `UserPromptSubmit`, and the return contract is JSON on stdout shaped
   `{continue, suppressOutput, hookSpecificOutput.additionalContext}`.

**The ideal shape, pending verification:** the user types `>>qwen3-max`; a `UserPromptSubmit`
hook matches the prefix, rewrites CCR's route file, and **blocks the prompt** so nothing
reaches the model. Full catalogue reachable by name, mid-conversation, in-session, zero
tokens, no assistant turn.

Two things must be verified before committing:
- Can a `UserPromptSubmit` hook actually block a prompt, with **no API request** made?
- If it blocks, **can it show the user a confirmation?** `additionalContext` reaches the
  model, not the user — which would defeat the purpose.

**Note a benign fallback:** even if the hook cannot block, the routing change still happens
*before* the prompt is dispatched — so the prompt would be answered *by the newly selected
model*. That is a natural confirmation, at the cost of one small turn rather than zero.

**Likely final shape (to confirm):** `/model` holds the ~20-row working set for visual,
zero-token switching between favourites; the hook reaches the full catalogue by name at zero
cost; and browse/survey — a genuinely rare action — is the only thing that may cost a turn.
The slots objection dissolves because the picker stops being the only door.

## D4 — THE MENU IS A LOCAL WEB PAGE (settled, after spiking every alternative)

The requirement that decided it: **live search-as-you-type, narrowing the list, at
BOTH the provider and model level.**

Every in-terminal surface was built and tested against real data before this was
concluded. None can meet that requirement, and the reasons are structural rather
than missing-flag:

| surface | spiked | why it fails |
|---|---|---|
| `/model` picker | — | filter code exists but sits behind `canEnter:!1`, a **literal, not a flag**. 10-row viewport. Read at process start |
| `UserPromptSubmit` hook | **built, worked** | genuinely zero-token and renders aligned columns — but it is **one-shot text with no keystroke loop**. Cannot filter live |
| MCP elicitation | **built, worked** | real cursor list, 40 visible rows, columns survive — but **the row set is fixed when the picker is created**, so the server never sees typing. At best prefix-jump, never narrowing |
| custom slash command | — | `type:"prompt"`; costs an assistant turn |
| local-jsx / IPC / control socket | — | not extensible; no `set_model` subtype on an interactive TUI session |

### What the spikes proved (keep these facts, they were expensive)

- **The hook block works and is genuinely free.** `continue:false` + `stopReason`
  renders the full text; the turn ends with **no API request**. Measured live.
- **`systemMessage` is a trap when blocking** — it is silently discarded and
  `reason`/`stopReason` is what displays. `systemMessage` only renders on a
  *pass-through*, which costs a turn. Building on it would have produced a menu that
  showed nothing while still billing.
- **Setting `decision:"block"` and `continue:false` together collides** — the coarse
  path wins and discards the text ("Operation stopped by hook" with no body).
- **Elicitation renders 40 rows** (vs `/model`'s 10), with padded columns intact and
  proper scroll indicators (`↑ 40 more above` / `↓ 320 more below`) at 400 rows.
  Better than `/model` on every axis except search.
- Elicitation labels render with a **leading `"`** under `enumNames`, which also
  likely defeats prefix type-ahead (nothing starts with `q`; everything starts with `"`).

### The decision

`~/.uw/spike/uwmodels-web.mjs` — a single-file local server, **built and working
against the real vault and catalogue: 44 providers, 1,584 models**. Two panes,
independent live filters, sortable columns, match highlighting, keyboard shortcuts.

**A browser tab is not "another terminal"**: the session is never left, and the
selection returns into it. The zero-token property is preserved because a
`UserPromptSubmit` hook can print the URL and block — so opening the menu costs
nothing either.

Design choices carried into it from the research, all deliberate:

- **`free` is nullable** — `—` when a provider has no price data at all, a number
  when measured. `0` and `—` are different claims and collapsing them is the single
  most likely way this design would start lying.
- **The badge reads `FREE?`, not `FREE`** — zero price is necessary but not
  sufficient under the governing definition; the recurring-quota axis is not yet
  proven, so the `?` is the honest rendering.
- **Guard G1 applied** — a zero *token* price on a non-text-output model renders
  blank, not free (it is billed per image/second in another unit).
- **The correct pricing path** (`pricing.offers[].per1MTokens`) is used, so tiers
  actually classify — unlike keysync's `inferTier`, which returns `unknown` for all
  4,298 models.
- **Level-1 filter searches model names too**, so typing `opus` finds the provider
  that *serves* it (Maestro's trick — what makes two levels tolerable).

### Security holes closed during the build

Both were the exact class the security review predicted for provider-controlled strings:
1. `esc()` covered `&<>` but **not quotes**, while ids land in HTML *attributes* —
   a `"` in a model id would have broken out.
2. The catalogue is embedded in a `<script>` block; a model id containing
   `</script>` would have closed the tag. `<` is now escaped in the serialized JSON.

## D5 — THE MENU IS A TERMINAL TUI INSIDE CLAUDE CODE'S EXTERNAL-EDITOR HANDOFF (settled 2026-09-02, supersedes D4)

The user tested `~/.uw/spike/uwpick.mjs` under `ctrl+g` with live filtering at both
levels, arrows, enter, and esc all working, and chose it: "this is it, i like this method."
The web page (D4) is dropped as a product surface and kept only as archived reference.

How it works, all measured:

- Claude Code's `chat:externalEditor` (`ctrl+g`) calls `enterAlternateScreen()`, which
  pauses its renderer and turns raw mode off, then `spawnSync`s `$EDITOR` with
  `stdio:"inherit"` and blocks. Whatever the editor leaves in the temp file becomes the
  new chat input on exit 0.
- `uwpick.cmd` is a dispatcher: it reads the first line of the temp file and only takes
  over on the sentinels `m`, `model`, `>>m`. Anything else is handed to
  `%UW_REAL_EDITOR%` unchanged, so `ctrl+g` keeps working as an editor everywhere else.
- Under the handoff the child's `process.stdin` is dead (`isTTY` undefined, no
  `setRawMode`, zero bytes ever). The console input device `//./CONIN$` (forward slashes
  only; both backslash spellings return ENOENT) opens and a blocking `readSync` on it
  returns keystrokes.
- The console arrives in mode `0x1F7` (line input + echo on), which swallows arrows and
  holds characters until Enter. Node cannot call `SetConsoleMode`; `uwpick-run.ps1` does,
  flipping to `0x280` (`ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT`) and
  restoring the saved mode in `finally`. Note: `0xC0000000` overflows to a negative Int32
  in PowerShell 5.1; the access mask must be written in decimal.
- Key log from the successful run: 170 sequences including `[27,91,65]`/`[27,91,66]`
  (arrows), `[127]` (backspace), `[13]` (enter), `[27]` (esc).

## D6 — Selection path is `/model provider/model` written into the chat input

The picker leaves `/model <provider>/<model>` in the temp file. Claude Code applies it
in-session with zero tokens; the status footer shows the real model; no CCR configuration
is touched. Known side effect, accepted by the user: Claude Code also saves the selection
as the default for new sessions (`settings.json` `model`). The slot-file +
`CUSTOM_ROUTER_PATH` mechanism remains proven and is kept as the alternative if a
session-only switch is ever needed.

## D7 — Subscription-covered models get a distinct `PLAN` badge

Models whose zero marginal price comes from a paid plan (models.dev `cost: 0` on
`alibaba-token-plan`, `nvidia`, `zhipuai-coding-plan`, `gitlab`, and the Anthropic relay)
are neither `FREE` nor `PAID`. They render as `PLAN`, and the provider-level free column
counts them separately (for example `12 +4 plan`).

## D8 — Phase 6 plan scope: menu and catalogue in one phased plan

Phase A ships the menu on the catalogue as it exists today. Phase B delivers the
catalogue refresh and labeling work: reserved-name denylist first, then the `inferTier`
fix, `grantCadence` curation in `providers.json`, three-tier refresh, and live discovery
for the 23 providers models.dev does not cover.

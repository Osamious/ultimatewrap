# Research: what is actually reachable, and which liveness labels can be kept honest (2026-09-06)

Written as an input to phase B. Two things prompted it: a decision about whether
`MAX_MODELS_PER_PROVIDER` should be raised or removed, and a governing aim the user set for the
picker while the measurement was running. The measurement answered the first question and then
undermined the premise of it; the aim answers a question the measurement raised.

All figures are from a live probe run on 2026-09-06: 270 requests across 44 keyed providers — 44
authenticated listing calls plus 226 minimal completions, of which 218 are in the parsed result
set. Total spend under $0.01. No key was logged or written to any file.

---

## 1. The governing aim

Set by the user, 2026-09-06. It governs the picker and the routing mechanism, and it is the
reason this report reaches the conclusions it does.

> The main aim for the uwpicker is to represent the **latest functional state** of each API's
> provider and model level as accurately as possible, through dynamic labels that refresh
> regularly. Very little blocking or deleting should be taken, because it restricts user
> capability, and when such measures are taken the picker must have **irrefutable evidence** for
> doing so.
>
> **If an at-a-glance label is difficult to maintain, update or refresh regularly — to the point it
> might go stale and be wrong most of the time, misleading the user — it is better taken down.**
> Let the user experience the error directly when they probe the provider or model.

The second paragraph is the sharper rule and the one with real consequences below. Call it the
**staleness budget**: a label must be refreshable at a cadence that keeps it true, or it must not
exist. A label that is usually wrong is worse than no label, because the user acts on it.

---

## 2. What is actually reachable

**~205 of 1,588 catalogued models are reachable at current account balances. ~260 would be
reachable if the unfunded accounts were paid.** Plausible range 150-300; confidently under 400.

The funnel, and where each number comes from:

| set | count | what it is |
|---|--:|---|
| CCR's bundled `models.json` | 4,298 / 217 providers | upstream merge: models.dev 2,796 + litellm 2,034 + openrouter 419 |
| `catalog/snapshot.json` | 1,588 / 45 | scoped to keyed providers — what uwpick displays |
| CCR `Providers[].models` | 91 entries / 87 models | what actually routes today (83 third-party + 4 Anthropic ids + 4 bare aliases) |
| **reachable at current balances** | **~205** | measured |
| **reachable if funded** | **~260** | measured entitlement × measured pass rate |

Tier 1 (entitlement) intersected each provider's authenticated listing against its slice of the
1,588: **301 exact matches**, rising to **664** if cosmetic id differences are normalised (vendor
prefixes, `models/`, `:free`/`:batch` suffixes, `.` vs `-`). Tier 2 (226 real completions) then
measured pass rates by stratum at providers that are not account-blocked: **EXACT 30/52 (58%)**,
**NORM 14/63 (22%)**, **ABSENT 4/31 (13%)**. Applying each provider's own rate to its own strata
gives 205; pooled rates give 260 with a Wilson 95% interval of [164, 407].

**A `/v1/models` listing over-reports real reachability by ~2.4×; the raw catalogue over-reports
by 7.7×.** Even after discounting account-blocked providers entirely, listings over-report by
1.7× — providers list embeddings, rerank, TTS, transcription, image and video models on the same
endpoint as chat models, plus deprecated ids they have not removed.

### The gaps are concentrated, not spread

Five providers hold 1,163 of 1,588 (73%) of the surface and contribute about 82 reachable models.

| provider | catalogued | listed | reachable | note |
|---|--:|--:|--:|---|
| alibaba | 343 | 165 | **0** | every probe `403`, over an unpaid bill — see §3 |
| openai | 337 | 125 | ~55 | much of the listing is embeddings/whisper/tts/dall-e/moderation |
| mistral | 193 | 46 | ~10 | OCR, embed, TTS, Labs-gated |
| google | 185 | 55 | ~17 | OpenAI-compat layer prefixes ids with `models/`, so **zero** exact matches |
| deepseek | 105 | **3** | 0 | the API serves exactly three models; the catalogue asserts 105 |
| openrouter | 99 | **431** | ~70 | the one provider whose catalogue *understates* reality |

openrouter + openai + cohere = 148 of ~205. **Thirty-nine of 44 providers have ≤3 reachable
models each.** A uniform per-provider cap is the wrong instrument for that shape.

Two structural causes worth naming. The catalogue stores bare model names while routers serve
vendor-prefixed ids — CCR's `models.json` splits `provider`/`model`, so OpenRouter's
`aion-labs/aion-2.0` is catalogued as provider `openrouter`, model `aion-2.0`. For OpenRouter and
Kilo the bare form happens to resolve; for HuggingFace it does not. And **99 of the 1,588 have
non-text output** per the catalogue's own `modalities.output`; only **907** are text-output *and*
tool-calling, which is the real precondition for a Claude Code row.

---

## 3. Money is not death — 26% of failures are recoverable

**57 of 218 probes (26%) failed on account state rather than on the model being absent.**

```
provider        pass  money-blocked  other-fail
alibaba            0            14           9
kilo               1            11           2
deepseek           0             9           0
aihubmix           2             8           0
google             5             4          14
zenmux             0             3           6
+ 8 more           0             1 each
TOTALS  pass 52 | money-blocked 57 | other-fail 109 | n 218
```

Exact strings: `402 Payment required`, `402 Insufficient Balance`, `403 Access to model denied.
Please make sure you are eligible for using the model`, `xai: your newly created team doesn't have
any credits or licenses yet`.

**Alibaba is the case that settles the design question.** 343 models catalogued, 73 entitled, and
two of them — `qwen3.8-27b` and `glm-5.2` — are recorded passing the *real-client* gate in
`keysync/verified-rows.json` on 2026-09-01. Five days later every probe returns 403, because of an
overdue balance. Nothing died. Any pipeline that treated that as death would have deleted ~50
working models the moment the balance cleared.

The repo already carries the scar of the milder version. `keysync/verify-cli.mjs:38-39`: pruning
on a transient failure is *"a one-way ratchet: a row dropped for a transient failure was never
probed again, which is how mistral was lost to a single 503."* An unpaid balance is strictly worse
than a 503 — a 503 clears itself, a balance does not clear until the user acts, so the wrongly
pruned row stays pruned indefinitely.

This produced the standing project rule recorded in `plans/open-questions.md`: **a provider that is
alive and responding is never classified dead or removed from routing.**

---

## 4. The classification table

Designed with the user from the 218 real responses, then revised under the governing aim so that
**nothing prunes**.

`prune` would mean deleting the row from *both* `built.picker` and `built.providers` — the model
leaves CCR's routing config, `resolve()` stage 2 misses, and selecting it errors. The weaker
actions all keep the row routable.

| # | class | signal | scope | recoverable by | action |
|---|---|---|---|---|---|
| 1 | absent | 404/400 "does not exist", "unknown model" | model | provider re-adding it | **dim only** |
| 2 | decommissioned | 410, "EOL", "no longer available" | model | nothing | dim + skip |
| 3 | not-chat | catalogue `modalities.output`; or 400 "not a chat model", wrong-endpoint errors | model | nothing | dim + skip |
| 4 | policy | 403 with a policy reason (OpenRouter *"only available on agentic harnesses"*) | model | request shape, maybe | mark, selectable |
| 5 | unfunded | 402 payment/balance/insufficient; 403 "access denied"/"not eligible" | **provider** | paying | `health` label |
| 6 | bad-auth | 401 invalid/inactive/missing key | **provider** | fixing the key | `health` label |
| 7 | undeployed | 404 `Function '<uuid>': Not found for account '<id>'` | **provider** | deploying at the provider | `health` label |
| 8 | transient | 429, 5xx, timeout, connection reset | either | waiting | nothing — retry |
| 9 | listing-empty | 200 with `data: []` | **provider** | unknown | `health` label |
| 10 | unreachable | DNS failure / connection refused, sustained across retries **and runs** | **provider** | provider returning | dim + skip |

**Nothing prunes.** Skip is reserved for categorical impossibility — a decommissioned model, a
non-chat model, a provider that does not answer. Everything else dims or labels.

Note class 1 is **dim only, not skip**, and this follows from the plan's own Principle 6 (*block
only when selection cannot possibly succeed; dim when it might*). A 404 is a measurement at a
moment, epistemically identical to `routable: false`. Alibaba proves such readings invert within
days. Skipping on a stale absence blocks a model that now works, with no override.

Two properties the table depends on:

- **The message classifies, not the status code.** nvidia returns `404` for account deployment
  state (class 7, 45 models); alibaba returns `403` for billing (class 5, 343 models); bluesminds
  returns `410` for genuine EOL (class 2). A code-only classifier misfiles classes 5 and 7 —
  precisely the cases the standing rule exists to protect.
- **Provider scope beats model scope.** Classes 5-7 and 9 settle every model under that provider at
  once, so one `402` needs no further probing. `health` is already per-provider (`healthOf(prof)`),
  so an unfunded provider reads once rather than as 343 identical per-row marks.

---

## 5. Applying the staleness budget — which of these labels can survive

This is the part of the aim with teeth, and it cuts against half the table above.

A label is only worth having if it can be refreshed often enough to stay true. Refresh cost is the
deciding variable, and it splits cleanly by scope:

| label | source | refresh cost | stays fresh? | verdict |
|---|---|--:|---|---|
| `outputKind` (class 3) | catalogue `modalities.output` | free, static | n/a — a property, not a reading | **keep** |
| `routable` | CCR config read | 1 local RPC | yes, every snapshot build | **keep** |
| classes 5-7, 9 (provider) | one authenticated call per provider | **44 requests** | yes — cheap enough to run on every refresh | **keep** |
| classes 1, 2 (model absence) | one completion per model | **~1,588 requests** | **no** | **do not label** |
| class 4 (policy) | one completion per model | ~1,588 requests | no | **do not label** |

**Provider-level liveness is cheap and can be kept honest. Model-level absence is not.**

A full model-level sweep is ~1,588 real completions, costs money at metered providers, and its
result decays — alibaba inverted in five days. A label refreshed monthly against a surface that
turns over weekly is wrong most of the time, which is exactly what the aim says to take down.

So the recommendation is:

- **Ship provider-level health labels** (unfunded / bad key / undeployed / empty / unreachable).
  44 requests, feasible on every refresh, and it is where the recoverable failures concentrate —
  57 of 218.
- **Do not ship model-level absence labels.** Let the user hit the 404 directly. It is a loud,
  immediate, self-explaining failure, and unlike a stale label it is never wrong.
- **Keep the two labels that are not measurements at all** — `outputKind` (a catalogue property)
  and `routable` (a local config read).

That collapses the table's ten classes into four things the picker actually renders, and every one
of them is refreshable within its own budget. Classes 1, 2 and 4 remain useful as a *probe-time
classification* — for deciding what not to prune — without becoming persistent UI.

---

## 6. The blocker: there is no refresher

The aim requires "dynamic labels that refresh regularly." **Nothing refreshes anything today.**

`menu/catalog.mjs:107-110` states that `routableSet` *"has exactly one caller, `refresh/cli.mjs`"*.
There is no `refresh/` directory. `plans/phase6-menu-and-catalogue.md:289` lists it in the file map
as *"the one place routability is resolved and stamped onto the snapshot"*, and it was never built.

That single absence is the root cause of the routability gap documented as B1-B5 in
`plans/model-capability-buckets-plan.md` §1.10: `routableSet` has zero non-test callers, the field
is dropped at serialisation, the `routableAsOf` stamp is read and rendered but never produced, and
a green test certifies the omission. Five breaks, one cause — the module that was supposed to own
liveness does not exist, under a comment asserting it does.

**Phase B's first structural task is building that refresher.** Everything in §5 depends on it:
provider health labels need a cadence, `routableAsOf` needs a writer, and "latest functional
state" needs something that refreshes state.

---

## 7. The finding that changes the cap question

`MAX_MODELS_PER_PROVIDER = 3` is deprecated as a design (user decision, recorded in
`plans/open-questions.md`). But the measurement found that **the cap is not the binding
constraint — the ranking is.**

`keysync/keysync.mjs:88-95`'s `inferTier` reads `pricing.inputPerMillion` / `pricing.input`. This
catalogue schema stores prices under `pricing.offers[].per1MTokens`. Run over the whole bundled
catalogue, **`inferTier` returns a usable value for 0 of 4,298 models.** `menu/catalog.mjs:29-31`
already documents this; the probe confirms it empirically.

Two live consequences:

1. The free-first sort at `keysync.mjs:365` is a **no-op**, so selection collapses to
   shortest-id-first — which is anti-correlated with reachability, because short ids are exactly
   the bare-name catalogue artifacts.
2. `keysync.mjs:412`'s tier label is always empty, so **every picker row's description is the
   answering host and nothing else.**

The result is visible in today's build:

```
google       gemini-3.5-flash-lite | lyria    | veo-2      ← music and video models
mistral      mistral-small-latest  | glm-5-2  | mistral    ← "mistral" is not a model
openrouter   gemma-...:free        | hy3      | auto
```

Row 1 in each is the vault's probe-verified `testModel`. Rows 2 and 3 are junk.

**So UW currently routes ~20 of the ~205 reachable models — 10% — and two of every three slots are
filled by a broken sort.** Coverage against cap, assuming the ranking stays uncorrelated:

| cap | picker rows | reachable captured | dead rows |
|--:|--:|--:|--:|
| 3 (today) | 86 | ~20 (10%) | 66 |
| 20 | 318 | ~61 (30%) | 257 |
| 100 | 925 | ~154 (75%) | 771 |
| removed | 1,588 | 205 (100%) | 1,383 |

Removing the cap while the ranking is broken buys dead rows faster than live ones. The ceiling is
~205 either way, so the target is not "route everything" — it is "route the 205", which is
achievable in far fewer than 1,588 rows.

Three changes get most of the way, and none of them is the cap:

1. **Fix `inferTier`** — point it at `pricing.offers[].per1MTokens`, matched per provider, exactly
   as `menu/catalog.mjs:priceOf` already does. Note reports 08 and 12 flagged that fixing it arms a
   routing hijack and the denylist had to land first; `admitRemoteModels` and `checkBareCollisions`
   now exist, so **that prerequisite is met**.
2. **Change the candidate source** from the bundled catalogue to each provider's authenticated
   listing. The catalogue disagrees with the keys wholesale — deepseek 105 vs 3, google 185 vs 55
   with zero exact matches, openrouter 99 vs 431. Listings over-report by 2.4× against the
   catalogue's 7.7×, and cost 44 requests.
3. **Per-provider limits rather than a global number.** `openrouter: 40, openai: 20, cohere: 12,
   google: 12` captures ~130 of the 205 in ~170 rows — better coverage than a global cap of 20 at
   half the row count.

Removing the cap also requires **decoupling** `keysync/keysync.mjs:349-372`, which produces
`Providers[].models` and `picker` from one array, and dealing with `checkBareCollisions` — a fatal
exit that would refuse to run once bare Claude-shaped reseller names arrive at scale.

---

## 8. Phase B scope: provider and key expandability

Added at the user's direction 2026-09-06. **Adding a new key — Anthropic or otherwise — must be
as simple, automated and reliable as it gets.** Today it is simple for the common case and
unreliable at the edges, and the edges are where a new provider actually lands.

### 8.1 What exists

The vault is `~/.llmkeys/`, two files, read by `loadVault()` at `keysync/keysync.mjs:22-26`:

```jsonc
// providers.json — 47 entries, the provider profile
{ "provider": "groq",
  "baseUrl": "https://api.groq.com/openai/v1",
  "protocol": "openai",
  "headersTemplate": "Authorization: Bearer {key}",
  "testModel": "openai/gpt-oss-20b",
  "requiresBalance": false, "docsUrl": "...", "notes": "..." }

// registry.json — 56 entries, the credential
{ "id": "personal.groq.free", "provider": "groq",
  "bucket": "personal", "tier": "free",
  "envVarName": "LLM_PERSONAL_GROQ_FREE" }
```

Secrets are never in the vault — only `envVarName`. Protocol distribution is **44 `openai`, 1
`anthropic`, 2 `generic`**, and `generic` is filtered out entirely at `keysync.mjs:36`. So the
happy path is: add two JSON entries, set one env var, run keysync. No code. That covers anything
OpenAI-compatible, which is most of the market.

### 8.2 Where it stops being config-only — four measured obstacles

**(a) A new provider gets exactly one model.** Model discovery reads CCR's bundled `models.json`
via `loadCatalog()`. A provider absent from that file returns `[]` from
`catalog.byProvider.get(name)`, so the only row is the `testModel` injected at
`menu/catalog.mjs:189-193` — with no context size, no capabilities, no pricing. This is the
largest limit, and §7's recommendation (switch the candidate source to each provider's own
authenticated listing) is the same fix.

**(b) `KEY_CHOICES` is a hardcoded map in source** (`keysync/keysync.mjs:43-49`). Multi-key
providers are tie-broken by name, deliberately rather than by timestamp — the reasoning is sound
and recorded — but it is code, not data. A third multi-key provider is a source edit.

**(c) `filterRegistry` carries hardcoded policy** (`:31-37`): a `/^sportsvector/i` bucket
exclusion, `tier !== "management"`, `protocol !== "generic"`. Reasonable rules living in the
wrong layer.

**(d) A third wire protocol needs gateway support.** CCR delegates translation to
`@the-next-ai/ai-gateway` — 43 providers on `openai_chat_completions`, 1 on
`gemini_generate_content`, 1 `anthropic_messages` passthrough (report 18 §7). A provider speaking
anything else is blocked upstream of UW entirely.

### 8.3 The Anthropic path is different, and sharper

Two distinct cases, and only one of them is the relay:

- **The subscription itself** is a single relay provider on the `anthropic` protocol, authenticated
  by OAuth through `apiKeyHelper`, not by an API key in the vault. Adding a *second* subscription
  is not a vault operation at all.
- **Anthropic resellers** (`tabiai`, `gorouter`, and any future one) take the ordinary `openai`
  path — but they list bare Claude-shaped ids, which is exactly what `checkBareCollisions` exists
  to police. That guard is a **fatal exit**, and it was hardened earlier in this work with a
  `relayOwned` set whose vouching logic assumes a small curated id list.

So **adding an Anthropic reseller can refuse to build**, and the failure is a hard stop rather than
a warning. There is no documented path for it today. Phase B must supply one: what a user does when
a legitimately-added reseller trips the guard, and how the guard distinguishes that from the hijack
it was built to catch (report 08 F1).

### 8.4 What phase B should deliver

1. **An `add` command that does the whole thing.** Take a provider name, base URL and key; probe
   the listing endpoint; confirm auth; discover models; pick and record a working `testModel`;
   write both vault entries. The pieces already exist as one-off scripts
   (`keysync/probe-account-endpoints.mjs`, `control-probe.mjs`, `key-health.mjs`) and as report
   01's 7 call-shape clusters. Nothing here is new capability — it is assembly.
2. **Detect the protocol rather than declaring it.** A probe distinguishes `openai` from
   `anthropic` from unsupported; a hand-typed `protocol` field is a silent misconfiguration waiting
   to happen.
3. **Move `KEY_CHOICES` and `filterRegistry`'s rules into data.** A `preferred: true` flag on a
   registry entry, and exclusion rules in config. Adding a provider should never require a source
   edit.
4. **Break the dependency on CCR's bundled catalogue** (obstacle (a)). A provider's own listing is
   ground truth, over-reports by 2.4× against the catalogue's 7.7×, and costs one request. This is
   the same change §7 recommends for candidate selection — one fix, two benefits.
5. **A documented, tested path for adding an Anthropic reseller** past `checkBareCollisions`
   (§8.3).
6. **Verify on add, not on next keysync.** The user should learn immediately whether the key works,
   which models answer, and what health class the provider is in (§4) — not discover it later
   through a failed selection.

### 8.5 Acceptance criteria

Adding a provider is *reliable* when all of these hold:

- One command, no source edit, no manual JSON.
- The command fails loudly and specifically on a bad key, an unreachable host, or an unsupported
  protocol — naming which, using the §4 classification.
- A newly added provider appears in the picker with **real** context and capability metadata, not
  a bare `testModel` row.
- Adding a multi-key provider, or an Anthropic reseller, needs no code change and no guard
  override.
- Removing a provider is equally clean, and leaves no orphaned routing entry.

---

## 9. Open decisions for phase B

1. **Where do provider health labels render?** The existing `health` column
   (`healthOf(prof)`) currently derives from static profile data, not probe results. Reuse it and
   change its source, or add a column?
2. **What cadence?** The refresher needs one. Provider listings are 44 requests; on picker launch
   is too hot (uwpick cannot `await` — `test/uwpick.test.mjs:124`), so it belongs on a schedule or
   an explicit command.
3. **The native `/model` menu has no dimming.** `modelPicker.options[]` renders every row plainly,
   so a decommissioned or non-chat model stays selectable there. Never-prune is only enforceable on
   the uwpick surface. Accept, or find a mechanism?
4. **`--verified-only` needs replacing, not patching.** It prunes both `built.picker` and
   `built.providers` (`keysync/run.mjs:363-380`), which the standing rule forbids. Under
   never-prune it becomes a labeller, and its name becomes wrong.

---

## Not verified

- **The residual over-report only `verify-cli.mjs` catches.** Tier 2 used bare synthetic probes —
  the exact thing `verify-cli.mjs`'s header warns over-reports. `groq/openai/gpt-oss-20b` **passed
  this probe** and is documented failing under Claude Code's real payload (~15 tool schemas plus a
  long system prompt). So the 52 passes are an upper bound; the true figure is plausibly 150-180.
- **Context windows and tool-calling were not verified.** HTTP 200 was measured, not whether a
  model honours tool schemas or its advertised context. The 907 text+toolCalling figure is
  catalogue metadata, unchecked against the keys.
- **Per-provider estimates resting on ≤3 probes** are single-observation extrapolations —
  huggingface (~1), nousresearch (~1), bluesminds (0) could each move by ±1.
- **`tabiai` and `gorouter` were not chat-probed**, by design: their vault notes record
  non-negligible per-call cost (~6,554 hidden prompt tokens at Opus pricing for tabiai). Both
  returned `200` with `data: []`.
- **`xai` and `indeedwebid` are unmeasurable by listing** — 403 credit-gated and 401 dead key
  respectively. `cloudflare`'s listing returns UUIDs with names in a separate field, so no id
  intersection is possible.
- **Whether normalized (NORM) matches survive CCR's own routing** was not tested — probes went
  directly to provider endpoints, and `resolve()` sits in between.
- **Volatility is unquantified.** One data point: alibaba inverted in five days. The staleness
  budget in §5 rests on that single observation plus the structural argument about refresh cost,
  not on a measured decay rate.

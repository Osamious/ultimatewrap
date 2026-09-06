# Research: the `behavesAs` capability over-declaration, and how far a fix can actually go (2026-09-06)

Scope: the 83 non-Anthropic picker rows that all carry `behavesAs: "claude-sonnet-4-6"`,
originally added so Claude Code recognizes a provider-format id and does not warn/refuse it
on launch. This report covers what that field actually does (more than context), what a true
fix would require, why it's out of reach, what CCR already neutralizes for free, and the
concrete approach recommended instead.

All findings are from direct reads of the installed `claude.exe` (v2.1.261) and CCR's actual
installed source (`@musistudio/claude-code-router` v3.0.22 and its translation dependency
`@the-next-ai/ai-gateway` v1.0.18) — not from documentation or assumption.

---

## 1. The problem is bigger than context

`behavesAs` was believed to affect only the context-window belief. Confirmed from the
binary's own settings schema description, it affects the model's **entire client-side
handling**: "prompt profile, capability and effort defaults." Concretely, this includes:

- Effort-level defaults and which tiers (`low/medium/high/xhigh/max`) are offered at all.
- Extended-thinking behavior — whether it's on by default, whether it can be disabled, a
  forced token budget in some cases.
- Model-SPECIFIC prompt-bundle and quirk-mitigation text — baked tokens like
  `opus_5_prompt_bundle`, `fable_5_mitigations`, `refusal_fallback`,
  `thinking_disabled_effort_cap` — instructions Anthropic wrote to correct known tendencies
  of ONE specific model, meaningless or actively confusing when inherited by an unrelated
  third-party model.

So the 83 rows currently inherit not just a wrong context number, but Sonnet 4.6's full
effort/thinking/prompt-adaptation profile — everything from `flux.1-schnell` (an image
model, not even a chat model) to small local Llama variants.

**The gated set, enumerated exactly** (added 2026-09-06, from the capability-predicate
dispatcher `Mre`, §6). Eight named predicates consult a per-model capability answer before
falling back to hardcoded rules:

`thinking`, `adaptive_thinking`, `interleaved_thinking`, `mid_conversation_system`,
`temperature`, `effort`, `max_effort`, `xhigh_effort`

Two of these (`temperature`, `mid_conversation_system`) were not in this report's original
prose description of the affected surface. **Context window is NOT among them** — it resolves
through separate machinery (`Cf()`/catalog/`[1m]`, report 17 §1), so nothing in this report's
subject area moves the compaction problem in either direction. The two workstreams are
orthogonal, which was not established before.

---

## 2. Capabilities, split cleanly: six fields already free, three share the same ceiling as context

Separately confirmed: Claude Code never reads Anthropic's API-reported `capabilities` object
at all — the fetch path that would parse it is dead code in this build, and its own schema
strips the field even when live.

- **Six of the API's nine capability fields** (`pdf_input`, `image_input`, `batch`,
  `citations`, `code_execution`, `structured_outputs`) have **no client-side gate at all**.
  Confirmed: these strings do not appear in Claude Code's capability-gating code. Already
  fully dynamic through any pure-passthrough relay — no engineering needed, no bucketing
  needed, they simply work correctly for any model that supports them.
- **Three fields** (`effort`, `thinking`, `context_management`) ARE gated — through the exact
  same baked internal catalog as context window. These carry the identical ceiling this
  report is about: correct for the curated, dynamically-tagged Anthropic rows; frozen at
  whatever `behavesAs` target implies, for everything else.

---

## 3. Tested and disproven: dropping `behavesAs` is not a safe fallback

Hypothesis going in: an unrecognized model with no `behavesAs` might get a neutral,
minimal-assumption default — genuinely "no wrong assumptions" rather than "assumptions
borrowed from the wrong model." Tested directly against the binary. **False, and the opposite
of what UW needs.**

The canonicalizer (`Xh`/`Fe`) for a genuine third-party id does NOT fall back to any Anthropic
model — a definitively unknown id stays unknown (`isKnown` is an exact catalog-id lookup, not
a fuzzy fallback). But every capability predicate's fallback, when the id is unknown, is a
**blanket provider default**, keyed by the current auth/routing shape:

```js
function Ie(){ ... a.CLAUDE_CODE_USE_BEDROCK?"bedrock": ... :"firstParty" }
function lH(e=Ie()){return e==="firstParty"||b0(e)||e==="foundry"||e==="mantle"}
```

UW's setup (`env.ANTHROPIC_BASE_URL` + `apiKeyHelper`, no `CLAUDE_CODE_USE_*` vars) resolves
to `firstParty`, where `lH()` is `true`. Consequence for an id with NO `behavesAs`:

| | curated `behavesAs` target | no mapping (unknown, on UW's firstParty shape) |
|---|---|---|
| effort / xhigh / max offered | depends on target's denylist | **all offered** |
| adaptive thinking | depends on target | **on** |
| thinking disableable | depends on target (can be `true`) | **no — forced un-disableable**, fixed 2048-token budget |
| prompt bundle | none, if target chosen carefully | none |
| `isKnown` / launch warning | suppressed | **shown** |

Dropping `behavesAs` is strictly worse on this axis than picking almost any real Anthropic
model as a target — it doesn't reduce assumptions, it maximizes them, and adds a launch
warning on top. **Recommendation reversed from an earlier hypothesis: never omit `behavesAs`
for a genuine chat model.**

---

## 4. `modelOverrides` is not identity-only either

Its schema description reads only as an id-remap ("Anthropic model ID → provider-specific
model ID," e.g. Bedrock ARNs). The consumer code says otherwise: it is a second, reverse-keyed
path into the exact same profile-borrowing machinery as `behavesAs` — mapping a third-party
id to a known Anthropic id causes it to inherit that Anthropic model's full capability/effort
profile, identically. It also flips `isKnown` to `true` for that id (matching the binary's own
help text: *"or modelOverrides, if it is a provider id of a model this version knows"*). No
additional precision over `behavesAs` — a parallel channel, not a better one.

---

## 5. Exhaustive settings.json sweep — confirmed, no hidden capability field exists

Full schema swept (~230 keys). Searched for `customCapabilities`, `modelProfile`,
`supportedCapabilities`, `capabilityProfile`, `effortLevels`, `modelBehavior` — zero hits for
all. `capabilityOverride*` and `modelCapabilities*` matches are internal in-memory cache keys
only, not user-facing configuration. There is no undiscovered per-model capability
declaration surface in `settings.json`.

---

## 6. The two channels that WOULD give exact per-model capabilities

**Revised 2026-09-06 after two dedicated scoping investigations. The original version of this
section was wrong on scope and is corrected below.** It claimed both channels required "a
fundamentally different, larger architecture change." That is true for two of the four
provider shapes and false for the other two. The channels are reachable at config scale. They
are still not adopted — for entirely different reasons than originally given.

### 6.1 The mechanism, exactly

```js
var Pre=[{modelEnvVar:"ANTHROPIC_DEFAULT_FABLE_MODEL", capabilitiesEnvVar:"ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES"},
 {modelEnvVar:"ANTHROPIC_DEFAULT_OPUS_MODEL",  capabilitiesEnvVar:"ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES"},
 {modelEnvVar:"ANTHROPIC_DEFAULT_SONNET_MODEL",capabilitiesEnvVar:"ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES"},
 {modelEnvVar:"ANTHROPIC_DEFAULT_HAIKU_MODEL", capabilitiesEnvVar:"ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES"},
 {modelEnvVar:"ANTHROPIC_CUSTOM_MODEL_OPTION", capabilitiesEnvVar:"ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES"}];
function Mre(e,t){if(ka())return;                       // <-- the gate
  for(let r of Pre){let o=process.env[r.modelEnvVar]?.trim(),d=process.env[r.capabilitiesEnvVar];
    if(!o||d===void 0)continue; if(e!==o.toLowerCase())continue;
    return d.toLowerCase().split(",").map((f)=>f.trim()).includes(t)}
  return}
```

Constraints not stated originally, both material:

- **Both** env vars of a pair must be set, and the model id must be *exactly equal*
  (lowercased) to the `modelEnvVar` value.
- It is a per-**slot** declaration, five slots per process — not a per-model table. It cannot
  cover 83 rows simultaneously.
- Values are read via direct `process.env[...]` access on every call, so they are live-read,
  not snapshotted at startup.

The gate:

```js
function Ie(){if(ns()||pOn()||gye())return"gateway";return a.CLAUDE_CODE_USE_BEDROCK?"bedrock":a.CLAUDE_CODE_USE_FOUNDRY?"foundry":a.CLAUDE_CODE_USE_ANTHROPIC_AWS?"anthropicAws":a.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD?"anthropicGoogleCloud":a.CLAUDE_CODE_USE_MANTLE?"mantle":a.CLAUDE_CODE_USE_VERTEX?"vertex":"firstParty"}
function ka(e=Ie()){return e==="firstParty"||b0(e)||e==="gateway"}
function b0(e=Ie()){return e==="anthropicAws"||e==="anthropicGoogleCloud"}
function lH(e=Ie()){return e==="firstParty"||b0(e)||e==="foundry"||e==="mantle"}
```

### 6.2 Correction: Foundry is config-scale, not an architecture change

```js
class d extends DH{ ... }   // DH is the same base class the firstParty client uses
export{d as AnthropicFoundry};
```

`AnthropicFoundry` has **no `backendMiddleware()` override**: no path rewrite, no
`anthropic_version` injection, no `delete body.model`. It is the plain Anthropic Messages API
at `baseURL + "/v1/messages"`, SSE streaming, `count_tokens` retained. Byte-identical on the
wire to what UW's relay already serves.

Auth is not a blocker either — every shape has a documented skip flag
(`CLAUDE_CODE_SKIP_{BEDROCK,VERTEX,FOUNDRY}_AUTH`), and with it set,
`async authHeaders(e){return this.skipAuth?void 0:super.authHeaders(e)}` means no SigV4 and no
Azure/GCP token acquisition. UW's existing `apiKeyHelper` Bearer survives to the wire —
`defaultHeaders` wins the SDK's header merge.

Model ids are not a blocker: for **every current model**, `provider_ids.foundry` is
byte-identical to `provider_ids.first_party`. Only 11 legacy dated rows differ (foundry drops
the date suffix). Foundry also skips Claude Code's date-suffix normalization entirely, making
it the most permissive shape for arbitrary id strings.

Config, complete:

```
CLAUDE_CODE_USE_FOUNDRY=1
ANTHROPIC_FOUNDRY_BASE_URL=http://127.0.0.1:<relay port>   # must NOT also set ANTHROPIC_FOUNDRY_RESOURCE
CLAUDE_CODE_SKIP_FOUNDRY_AUTH=1
```

Relay protocol work: **zero**. It already serves `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/models`, `/health` and routes on `url.pathname`.

**Scope: tens of lines.** The original "fundamentally different, larger architecture change"
claim holds only for Vertex (~40-60 lines: path parsing, `model` re-injection,
`anthropic_version` stripping) and Bedrock/Mantle (structural — needs an AWS binary
event-stream encoder *and* a fake Bedrock control plane serving `ListInferenceProfiles` /
`GetInferenceProfile`).

### 6.3 Why it is still not adopted — three real blockers

**Blocker 1 — five slots is not the limit it appears, but staleness is.** Claude Code runs one
active model at a time, so one slot (`ANTHROPIC_CUSTOM_MODEL_OPTION`) pointed at the active
row would give genuine exact per-model matching for the model actually in use. The 83-row
count is irrelevant. What is not solvable: env vars of a *running* process cannot be rewritten
from outside without process injection (the same wall report 17 closes exhaustively). The slot
is correct for the launch model and goes stale on the first switch. On a stale slot
`e!==o.toLowerCase()` fails, `Mre` returns undefined, and the hardcoded fallback applies.

The fallback direction differs by shape, via `lH()` above: **Foundry is inside `lH()`** — stale
falls permissive, the wrong failure direction. **Vertex and Bedrock are outside** — stale falls
conservative, i.e. fail-safe. This inverts the cost ordering: the cheap shape has the bad
failure mode, and the shape with the right defaults needs the relay work.

Corollary worth recording independently: because Vertex/Bedrock sit outside `lH()`, they give
conservative defaults for **every** unknown model with no declaration at all — the
"fewer wrong assumptions" property §3 concluded was unreachable. It is reachable, at the cost
of the relay path-rewriting work plus Blocker 3.

**Blocker 2 — not enough accurate data to declare, though more exists than first thought.**
This report originally stated UW had no per-model capability data at all. Measured 2026-09-06
(§9): a real `capabilities.reasoning` boolean is already loaded and unused, at 55.4% strict /
81.9% loose coverage of the 83 rows. That is enough to materially improve the §8 bucketing.
It is **not** enough to fill an exact-declaration channel, which needs a confident per-capability
true/false for the specific active model — a partial signal filled in with guesses produces
confidently wrong answers instead of honest defaults, which is strictly worse than bucketing.
This blocker is independent of every binary-level finding above and remains decisive.

**Blocker 3 — subscription identity, on any non-`firstParty` shape.**

```js
function cl(){ ... let e=!Pn(); ... return !(e||v) }   // hard false when not firstParty
function gt(){ if(!cl())return!1; return rH(Xt()?.scopes) }
```

Requests still authenticate — the Bearer reaches the wire. But Claude Code stops *believing*
it is a subscription session. Casualties: subscription-type display ("Claude Max"/"Claude
Pro"), the `anthropic-ratelimit-unified-*` quota surface (report 14's entire subject), cloud
sessions, claude.ai MCP, plugin skill search, design sync, and the server-side auto-mode
classifier. Telemetry additionally reports UW's deployment shape upstream as `foundry`.
`Ie()` is process-global, so a split (firstParty for Anthropic rows, Vertex for third-party)
is not possible — one shape per launch.

No impact on UW's other 43 providers: they run through CCR on a separate path.

### 6.4 The second channel: `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL` — worse than originally stated

Anthropic's own served catalog row (`runtime.effort_levels`, `runtime.default_effort`,
`runtime.capabilities`) is gated behind `Td() = Ie()==="firstParty" && po()`:

```js
function po(){if(a._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL)return!0;return Zk()}
function Zk(){let e=process.env.ANTHROPIC_BASE_URL;if(!e)return!0;return zE(e)}
function zE(e){try{let t=new URL(e).host;return["api.anthropic.com"].includes(t)}catch{return!1}}
```

Confirmed: the flag is a **client-side belief only** — it does not change the HTTP target. The
SDK constructor and the WIF/profile resolver both read `ANTHROPIC_BASE_URL` without consulting
it, and the binary's own Remote Control diagnostic states outright that the flag "does not
apply to Remote Control."

The original "wider blast radius... catalog masking and org state" was directionally right and
badly understated. It flips ~50 gates. Load-bearing consequences for UW specifically:

- **Kills gateway model discovery permanently**: `Mp(){ ... if(po())return!1 ... }`. UW has
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"` set; report 15 named this the best
  zero-token catalogue mechanism.
- **The `fable` alias loses its `[1m]`**:
  `case"fable":{let f=Jq();return cS(f+(o&&!Td()&&!tc(f)?"[1m]":""))}` — gated on `Td()` alone,
  with no `gg()` guard. 1M is then only restored if the compiled canonicalizer resolves the
  provider-prefixed id, which §3 establishes it does not.
- An activating served catalog **replaces the compiled picker** and suppresses both the
  gateway rows and the `MC()` additional-options merge.
- Sentry crash reporting turns on, direct to `o1158394.ingest.us.sentry.io`, bypassing the
  relay. `traceparent` headers begin flowing to every remote MCP server and into hook
  subprocess environments. `Wme()` inserts an extra system-prompt block into **all** requests
  including third-party ones (betas die at CCR's translation boundary per §7; system-prompt
  content does not). `kX()` begins silently dropping assistant content blocks globally.

Two clarifications on what "catalog masking" actually is: it does **not** hide models from the
picker. It substitutes the literal `"confidential"` for model-id strings in outgoing telemetry
for ids the org marked confidential, plus server-supplied `dropped_model_ids`. The picker
effect comes from a different place — an activated served catalog replacing the compiled one.

And the payoff is conditional on `gt()` being true (requires Claude Code's own scoped
`claudeAiOauth` credentials, unverified on this install) **and** on prefixed-id resolution
which §3 says fails. Likely a no-op that costs everything above.

**Verdict on this channel: dead.** The original "a real tradeoff, not a clean win" was right
and understated.

### 6.5 Conclusion, revised

True per-model capability matching **is** reachable on UW's current architecture at config
scale, contrary to this section's original claim. It is not adopted because it goes stale on
the first in-session model switch, because UW has no accurate per-model capability data to
declare, and because any non-`firstParty` shape costs the subscription surface the tool is
built around. The recommended approach in §8 is unchanged in shape; its justification is
corrected here.

---

## 7. What CCR already neutralizes — the wire-level risk was smaller than feared

Separately investigated: does the ACTUAL request Claude Code sends (potentially carrying
wrong capability assumptions — a `thinking` block, an effort parameter — for a model that
doesn't support them) ever reach the real provider unmodified?

**No, for 44 of UW's 45 configured providers, by two independent mechanisms already in
CCR's existing pipeline** (not built for this, pre-existing):

- CCR delegates protocol translation to `@the-next-ai/ai-gateway`. Confirmed via the live
  config (`config.sqlite`): 44 providers are on the translated path (43
  `openai_chat_completions`, 1 `gemini_generate_content`); the ONE `anthropic_messages`
  passthrough entry is UW's own relay to real Anthropic — exactly where passthrough belongs.
- The OpenAI-shaped target build is an explicit field allowlist that never reads
  `thinking`/`effort`/`output_config` — they die naturally at the conversion boundary.
- CCR ALSO deliberately strips these fields a second time, independently, before the
  gateway even sees them (`y9e`/`C9e`, a shipped, intentional sanitizer keyed on target
  protocol) — not incidental, a real function built for this.
- Empirically confirmed via captured request logs: Claude Code genuinely does send
  `thinking:{"type":"adaptive"}` on translated-path requests — and it's inert even where read,
  since `"adaptive"` doesn't match either accepted state string (`enabled/enable/on/true` or
  `disabled/disable/off/false`).

**The one residual exposure**: a THIRD-PARTY reseller configured as `anthropic_messages`
(genuine passthrough, not translated) would receive these fields verbatim. Zero such
providers exist in UW's config today.

**A real risk found in doing MORE than necessary**: a blanket strip across all providers
would break two currently-configured, working providers (`deepseek`, `bigmodel`/`zhipuai`),
both of which deliberately SET their own `thinking`/`reasoning_effort` fields via their own
normalizers after translation. The gateway also already gracefully degrades unsupported
effort levels to the nearest supported tier rather than dropping them — stripping would
replace that graceful behavior with outright removal. **Recommendation: do not build any
proactive stripping.** If a passthrough third-party reseller is ever added, the fix is a
single `providerPlugins[]` config entry with `request.bodyRemove` — no code fork, a
mechanism CCR's own shipped grok-OAuth plugin already uses the same way.

---

## 8. Recommended approach

**Replace the blanket `behavesAs: "claude-sonnet-4-6"` with two corrected bucket targets**,
chosen per row using its already-catalogued real context as a cheap, available proxy for
scale (UW does not have finer-grained capability data for arbitrary third-party models, so
this is the best available signal, not a precise match):

- **Weak/simple third-party models → `behavesAs: "claude-sonnet-4-5"`** (or `haiku-4-5`,
  `opus-4-1`). Confirmed these hit every relevant denylist: no effort selector offered, no
  adaptive thinking, thinking stays user-disableable, zero prompt-bundle bleed-through. The
  genuine "no wrong assumptions" bucket.
- **Capable-but-generic third-party models → `claude-opus-4-6`/`claude-sonnet-4-6`.**
  Confirmed capable (effort, adaptive thinking, context management), excluded from the
  `xhigh` effort tier, thinking stays disableable, no prompt-bundle bleed.
- **Never use `claude-opus-5`/`claude-fable-5*` as bucket targets** — confirmed these carry
  model-specific prompt bundles and mitigation text (`opus_5_prompt_bundle`,
  `fable_5_mitigations`, `refusal_fallback`, `thinking_disabled_effort_cap`) tuned for those
  exact Anthropic models, nonsensical when inherited by an unrelated model.
- **Never omit `behavesAs` for a genuine chat model** (§3) — confirmed worse than any
  reasonable bucket choice on UW's firstParty shape.
- **No CCR-side changes now** — the wire-level consequence this fix was originally worried
  about is already handled (§7); only revisit if a passthrough third-party reseller is added.
- **Non-chat models (image, audio, embedding, etc.) never reach this decision at all** —
  decided separately: add a model-type field to UW's catalogue, grey out and skip
  non-chat rows in the picker's row selector (never hide them — shown but unselectable,
  reusing the picker's existing "routable dimming" pattern), defaulting to selectable when
  type is genuinely unknown (catalogue coverage will have gaps, same as context data does).
  This makes the `behavesAs` question moot for rows that can never become the active model.

**Refinement added 2026-09-06**: bucket targets should be chosen by reading each candidate
reference model's actual profile across the eight gated predicates named in §1, out of the
baked catalog — not by which tier reads as closer. The checks below were done partially; the
exact predicate list makes it systematic. Same binary read, one pass, produces a small table.

**Input-signal revision, 2026-09-06 (§9)**: replace context-size-as-proxy with a composite.
Use `capabilities.reasoning` from the already-loaded merged catalogue as the primary
discriminator, falling back to catalogued context size where it is absent. Measured 55.4%
strict / 81.9% loose coverage of the 83 rows versus context's 90.4%, so the two compose to
100% with a real signal on the majority. Prefer strict same-provider id matching; cross-provider
name matching produces confirmed false positives on generic ids (`orcarouter/auto` matched
`morph/auto`) and the 22 loose matches were not individually audited. **Prerequisite: fix the
`!!` coercion at `menu/catalog.mjs:178` first (§9.2)** — today `unknown` is written as `false`,
so an unfixed bucketer silently buckets every unknown model as small. This also directly
mitigates the sharpest risk in the bucketing design: a genuine reasoning model
(`deepseek-reasoner` and similar) can be held in the capable bucket on its own `reasoning: true`
flag rather than on whatever its context size implies.

**What this achieves versus a true per-model match**: it does not make Claude Code's belief
about an arbitrary third-party model's capabilities exact. Per §6 (revised), that is reachable
at config scale rather than requiring an architecture change — but it goes stale on the first
in-session switch, has no accurate data to declare, and costs the subscription surface. What
it achieves: the part of the original concern that
sounded most severe (wrong data reaching the real model) turns out to already be handled by
infrastructure that predates this investigation; what remains is Claude Code's own local UI
and default assumptions not perfectly matching an arbitrary model — narrowed from "confidently
wrong for everyone" to "a deliberately minimal, honest default," at zero risk either way.

---

## 9. The bucketing input signal, measured (2026-09-06)

§8's bucketing originally used catalogued context size as a proxy for capability, on the stated
assumption that no real per-model capability signal existed. Measured against UW's actual data:
**a real signal exists, is already loaded, and is currently discarded.**

### 9.1 `capabilities.reasoning` — already in memory, unused

UW's catalogue comes from CCR's bundled merged file (`keysync/keysync.mjs:74`,
`@musistudio/claude-code-router/dist/models.json`, 19.7 MB, 4,298 models / 217 providers,
itself a merge of models.dev 2,796 + litellm 2,034 + openrouter 419). Its entries carry 46
distinct `capabilities.*` keys. Population across the merged file: `reasoning` 73.0%,
`toolCalling` 66.5%, `temperature` 58.3%, `attachments` 65.1%.

Coverage of UW's **actual 83 non-Anthropic picker rows** (`keysync/built-rows.json`):

| signal | strict id match | + cross-provider name match |
|---|---|---|
| `capabilities.reasoning` | **55.4%** | **81.9%** |
| `capabilities.toolCalling` | 53.0% | 79.5% |
| `limits.contextTokens` (today's proxy) | 63.9% | 90.4% |

Across the full 1,588-model snapshot, where match rate is ~97.5% and therefore near-free:
`contextTokens` 94.6%, `reasoning` 77.9%. The ~22% reasoning shortfall there is **confirmed
real field absence, not a matching artifact**. Where `reasoning` does resolve for the 83 rows
it discriminates genuinely (53 true / 15 false), it is not a constant.

**Conclusion: `reasoning` is a better signal than context size where it exists, and has worse
coverage. They compose — `reasoning` primary, context as fallback — for 100% coverage with a
real signal on the majority.**

### 9.2 The `!!` coercion bug — a prerequisite, not an optional cleanup

`menu/catalog.mjs:174-178`:

```js
const p = priceOf(e, cred.provider), caps = e?.capabilities ?? {};
models.push({ id: e.model, ctx: e?.limits?.contextTokens ?? null, ...
  tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning,
```

`!!undefined === false`. The snapshot's apparent 100% capability coverage is an artifact of
double-negation: a model whose upstream `reasoning` is genuinely unknown is written as
`reason: false`, indistinguishable from a model known not to reason. **Any bucketer reading
`snapshot.json` today would silently bucket every unknown as small.** The same file already
applies the correct `null`-for-unknown rule to `routable` (lines 137-144) and `free`
(line 198) — the three capability fields are the inconsistent ones. Fix before bucketing.

Also noted: `menu/catalog.mjs:190-193` and `:211` inject synthetic rows with hardcoded
capability values (testModel rows all-false, relay rows all-true).

### 9.3 models.dev directly: measured worse, do not add

Fetched live (213 providers, 7,562 models). Its schema is excellent — `reasoning`, `tool_call`,
`attachment`, `modalities`, `limit` all 100% populated, plus `reasoning_options` (71.5%)
describing effort/budget controls. But **25.3% of UW's rows do not exist in it at all**, giving
28.9% strict / 74.7% loose — worse than the merged catalogue's 55.4%/81.9%. CCR's litellm and
openrouter arms cover exactly what models.dev misses (`ollama/*`, `cohere/command`,
`cloudflare/*`, `nscale/*`). **Adding a direct models.dev fetch would not improve on what UW
already has.**

Also relevant to the model-type grey-out decision (§8): **models.dev has no model type/category
field at all.** That concept exists only in litellm's `mode` (47.1% of the merged catalogue).
The reliable discriminator is `modalities.output`.

### 9.4 The non-chat rows, enumerated

Four of the 83 rows have non-text output and would corrupt a two-bucket chat classification:
`google/lyria` (audio), `google/veo-2` (video), `nscale/flux.1-schnell` and
`nscale/stable-diffusion-xl-base-1.0` (image, litellm `mode: image_generation`). These are the
concrete targets for §8's grey-out rule, and `modalities.output` is the field that identifies
them.

### 9.5 Where the gaps are — the "obscure resellers" hypothesis is half wrong

Only **6 rows** are fully unmatchable (`fanar/Fanar`, `pollinations/openai`,
`huggingface/prism-ml/Ternary-Bonsai-27B-AWQ-4bit:together`, `agnes/agnes-2.0-flash`,
`aihubmix/coding-glm-5.2-free`, `indeedwebid/ineed/freetier`). The larger gap is **first-party
providers whose models are present but with the field simply absent** — `ollama` 0/15,
`cohere` 21/37, `mistral` 128/193, `openai` 246/337. **Source provenance predicts coverage,
not provider obscurity.**

### 9.6 Live provider capability data, fetched by nobody

UW's catalogue is built exclusively from CCR's static bundled file; no live `/v1/models` call
feeds third-party catalogue metadata. But `keysync/probe-account-endpoints.json` (301 recorded
probes) shows **11 providers return capability-shaped fields today**: `routllm`
(`capabilities{streaming,tools,vision,image_generation}`), `zenmux` (`capabilities{reasoning}`,
`input_modalities`), `huggingface`, `veniceai`, `llm7` (**`model_type: "chat"`** — exactly the
chat-vs-image discriminator models.dev lacks), `pollinations`, `kilo`, `orcarouter`,
`sambanova`, `aionlabs`, `commandcode`. Those cover **19/83 rows = 22.9%**.

This is a **lower bound**: only 20 of the 44 row-providers were probed on a `/models` path, and
every probe was unauthenticated (119 returned 401). Authenticated re-probing is the
highest-leverage available upgrade if 82% proves insufficient — it is the only measured source
returning data for rows the merged catalogue cannot match at all.

Separately, `keysync/anthropic-catalog.mjs`'s `toCatalog()` (lines 35-51) keeps only `id` and
`max_input_tokens` from the live relay fetch, discarding the rest. Deliberate, documented, and
out of scope here since Anthropic rows do not use `behavesAs`.

---

## 10. The predicate profile table, measured (2026-09-06)

§8's refinement asked for each candidate bucket target's actual profile across the eight
predicates. Done, against build `37ae3f38` (`BUILD_TIME 2026-09-06T01:08:56Z`). Three results
change the design's justification; one retires a risk this report raised.

### 10.1 The fallback is a baked catalog, not inline rules

The hardcoded fallback consults a per-model `capabilities` array in a baked catalog via `cm()`,
against a 22-entry vocabulary (`xRn`). Raw rows for the candidates:

```
claude-haiku-4-5   caps="context_management"
claude-sonnet-4-5  caps="context_management"
claude-opus-4-1    caps="context_management"
claude-sonnet-4-6  caps="effort","max_effort","adaptive_thinking","context_management"
claude-opus-4-6    caps="effort","max_effort","adaptive_thinking","context_management"
claude-opus-5      caps=...,"mid_conv_system","thinking_disabled_effort_cap","fast_mode",
                        "lean_prompt","refusal_fallback","opus_5_prompt_bundle"
claude-fable-5     caps=...,"rejects_disabled_thinking","mid_conv_system","fable_5_mitigations",
                        "refusal_fallback"
claude-fable-5-1   caps=...,+"per_turn_effort","fable_5_1_prompt_bundle"
```

Note the catalog key is `mid_conv_system`; `mid_conversation_system` is only the env-override
key. Different namespaces. Also `cm()` returns `undefined` (not `false`) for a catalog entry
lacking a capability — falsy at every call site, so it falls through to `lH(El(e))`.

### 10.2 Resolved profile, `firstParty`, no server grants

| model id | thinking | adaptive | interleaved | mid_conv_sys | temperature | effort | max_effort | xhigh |
|---|---|---|---|---|---|---|---|---|
| `claude-sonnet-4-5` | true | false | true | **false** | **true** | false | false | false |
| `claude-haiku-4-5` | true | false | true ¹ | **false** | **true** | false | false | false |
| `claude-opus-4-1` | true | false | true | **false** | **true** | false | false | false |
| `claude-sonnet-4-6` | true | true | true | **false** | **true** | true | true | false |
| `claude-opus-4-6` | true | true | true | **false** | **true** | true | true | false |
| `claude-opus-5` | true | true | true | **true** | **false** | true | true | true |
| `claude-fable-5` | true | true | true | **true** | **false** | true | true | true |
| `claude-fable-5-1` | true | true | true | **true** | **false** | true | true | true |

¹ `interleaved_thinking` is provider-dependent: on `bedrock`/`vertex`/`gateway`/custom base URL,
`claude-haiku-4-5` flips false. Others unaffected.

`temperature` has **inverted polarity** — an allowlist of legacy models, not a denylist:

```js
function M6t(e){let t=tQ(e,"temperature");if(t!==void 0)return t;
  let r=Fe(e);
  if(r.includes("claude-3-")||r==="claude-opus-4-0"||r==="claude-opus-4-1"||r==="claude-opus-4-5"
   ||r==="claude-opus-4-6"||r==="claude-sonnet-4-0"||r==="claude-sonnet-4-5"
   ||r==="claude-sonnet-4-6"||r==="claude-haiku-4-5")return!0;
  return!1}
```

Both proposed buckets therefore send `temperature`; `opus-5`/`fable-5*` would omit it — another
independent reason those are the wrong targets for third-party rows.

Extra gates found, ahead of the model rules: a HIPAA compliance profile forces
`mid_conversation_system` false for every model; `_xt(e)` is a **runtime latch set after the API
400s on the effort param**, permanently disabling all three effort predicates for that model for
the process lifetime; and org/entitlement-served `effort_levels` fully override the model rules
when present.

### 10.3 Prompt bundles — §8's exclusion rule confirmed exactly

All four names cited in §1 exist. Mapping:

| capability | carried by |
|---|---|
| `opus_5_prompt_bundle` | `claude-opus-5` |
| `fable_5_1_prompt_bundle` | `claude-fable-5-1`, `claude-mythos-5-1` |
| `fable_5_mitigations` | `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5-1` |
| `refusal_fallback` | `claude-opus-5`, `claude-fable-5`, `claude-fable-5-1` |
| `thinking_disabled_effort_cap` | `claude-opus-5` only — genuinely wire-affecting, rewrites `output_config.effort` down to `high` |
| `rejects_disabled_thinking` | `claude-fable-5`, `claude-fable-5-1` — blocks sending `thinking:{type:"disabled"}` |

**`sonnet-4-5`, `haiku-4-5`, `opus-4-1`, `opus-4-6`, `sonnet-4-6` carry no model-specific bundle
or mitigation at all.** §8's target list and its "never `opus-5`/`fable-5*`" rule are confirmed
on direct evidence rather than inference.

### 10.4 Correction: none of the eight is UI-only

This report and its surrounding discussion characterized the predicate effects as largely local
UI. **Wrong. All eight change the outgoing request body or headers.** Four (`thinking`,
`interleaved_thinking`, `mid_conversation_system`, `temperature`) have no UI surface at all.

| predicate | what false changes on the wire |
|---|---|
| `thinking` | `thinking` field omitted from body |
| `adaptive_thinking` | `{type:"adaptive"}` vs `{type:"enabled",budget_tokens:N}`; also `supportsAdaptiveThinking` in the picker payload |
| `interleaved_thinking` | drops `interleaved-thinking-2025-05-14`, `redact-thinking-2026-02-12`, `thinking-token-count-2026-05-13` betas |
| `mid_conversation_system` | drops `mid-conversation-system-2026-04-07`; `role:"system"` turns collapse into `<system-reminder>`-wrapped user meta messages; kills `mid_conv_tool_change` downstream; suppresses two ephemeral reminders entirely |
| `temperature` | `temperature` omitted from body (an omission, not a clamp) |
| `effort` / `max_effort` / `xhigh_effort` | `effort-2025-11-24` beta and `output_config.effort` values withheld; effort picker filtered |

This does not overturn §7's conclusion — CCR still strips `thinking`/`effort`/`output_config`
for 44 of 45 providers before the gateway, so these fields die downstream. But the reason is
"neutralized in transit," **not** "never sent."

### 10.5 The risk this report raised is retired: a false `thinking` predicate does NOT hide returned reasoning

The sharpest concern in the bucketing design was that assigning a conservative profile to a
genuine reasoning model might suppress rendering of reasoning it produces anyway. **Disproven.**

- The content-block renderer `x_()` gates thinking blocks only on transcript-mode and verbose —
  the same rule that applies to Opus. None of the three thinking predicates appears in it.
- Parsing is unconditional; the block healer *repairs* a thinking block missing a signature
  rather than rejecting it.
- `RX()` (`dropApiInvalidAssistantBlocks`, the `kX()` of earlier notes) targets exactly two
  things — `tool_result` blocks inside an assistant message, and `server_tool_use` with a name
  outside a built-in allowlist. Thinking is not in scope; it is explicitly *protected* by the
  spacer logic. It is also inert for any non-`api.anthropic.com` endpoint (`Wu()`), i.e. for
  every UW third-party route.

`thinking: false` means "do not request thinking." It never means "do not accept or display
thinking." **A reasoning model in the weak bucket keeps its visible reasoning output.**

Residual, and different in kind: the renderer's `default:` arm silently drops **non-standard
block types**. If a proxy emits reasoning as something other than `thinking`/`redacted_thinking`,
it is lost. That is a block-naming/translation concern for CCR, unrelated to `behavesAs`.

### 10.6 Why bucketing is safe by construction

Today every row is `claude-sonnet-4-6`. Every proposed bucket move is toward *fewer* declared
capabilities. Under-declaring is the safe direction for all eight:

- **Safe to under-declare** (cost is a capability you don't get, never breakage):
  `interleaved_thinking`, `adaptive_thinking`, `max_effort`, `xhigh_effort`,
  `mid_conversation_system`.
- **Self-healing**: `effort` — a server 400 trips the `_xt` latch and the client backs off
  permanently on its own.
- **Free either way**: `thinking` (§10.5).
- **Dangerous to OVER-declare**: `mid_conversation_system`, `temperature`, `max_effort`,
  `xhigh_effort` — none of which bucketing turns on. `mid_conv_system` is false for the current
  blanket target *and* for both proposed buckets, so the one structurally risky predicate stays
  off in every case.

---

## Not verified, and worth stating

- ~~The "closest bucket by context size" heuristic is a proxy...~~ **Superseded by §9**: a real
  `capabilities.reasoning` signal exists at 55.4-81.9% coverage. The residual band still falls
  back to the context proxy, so the caveat holds for that remainder only.
- ~~Coverage of "model type" classification has not been measured...~~ **Superseded by §9.3/9.4**:
  measured. models.dev has no type field at all; litellm `mode` covers 47.1%; `modalities.output`
  is the reliable discriminator and identifies four non-text rows among the 83.
- The true `reasoning` coverage for the 83 rows lies somewhere in the **55.4%-81.9% band** and
  was not narrowed further — that needs per-row manual adjudication of the 22 cross-provider
  matches, only one of which was inspected (and was a false positive).
- ~~Whether the eight gated predicates change real behavior rather than UI...~~ **Answered in
  §10**: all eight are wire-affecting, none UI-only; `mid_conversation_system` reshapes the
  `messages` array and is false in every proposed bucket; `temperature` is an omission on an
  inverted-polarity allowlist; and a false `thinking` predicate does **not** suppress rendering
  or parsing of returned reasoning. Bucketing only ever under-declares, which is the safe
  direction for all eight.
- `servedCapabilityLookup` / `runtimeCapabilityLookup` are populated from server bootstrap at
  runtime, and a server can grant **any** capability to **any** model id ahead of the baked
  catalog. §10.2's table is the client's belief with no server grants in play; what a live
  account actually receives was not observed.
- Org/entitlement-served `effort_levels` (`f6t`/`Wa`) and `maxEffortLevel` (`u7e`) override the
  effort rows entirely when present. Not statically visible.
- Whether a third-party reasoner proxy actually emits standard `thinking`/`redacted_thinking`
  blocks depends on CCR's translation layer, outside the binary. §10.5's conclusion holds for
  standard-shaped blocks; a non-standard type is dropped by the renderer's `default:` arm.
- Whether the two ephemeral reminders suppressed by a false `mid_conversation_system` have any
  alternate delivery path — `ZQn` returns null early and no second call site was found, but
  absence was not exhaustively proven.
- `keysync/built-rows.json` is stamped 2026-09-02 while `catalog/snapshot.json` is 2026-09-04;
  the 83 rows were not confirmed to be identical if the pipeline re-ran today, and the agent did
  not execute `run.mjs` (it writes CCR config and `settings.json`).
- CCR's bundled `models.json` is dated 2026-08-24 and lives in `node_modules`, so it is
  presumably pinned to the installed package version. Live models.dev now carries 7,562 models
  against the 2,796 CCR imported — **the bundled snapshot is already materially behind**, and
  its refresh mechanism was not confirmed. This is an upgrade-resilience concern for any feature
  built on it.
- How CCR's merge resolves conflicts when models.dev and litellm disagree on `reasoning` for the
  same model — its `scripts/generate-models-json.mjs` was not read, only its output manifest.
- Whether other CCR-configured providers beyond `deepseek`/`bigmodel` also rely on
  `thinking`/`reasoning_effort` surviving translation was not exhaustively enumerated across
  all 45 vault entries — only the two found via the vendor-normalizer registry were confirmed
  by name.

Added 2026-09-06 with §6's revision — all of §6 is static binary reading, nothing executed:

- No launch of `claude.exe` under `CLAUDE_CODE_USE_FOUNDRY=1` (or any other shape) was
  attempted. The wire-compatibility claim rests on class-hierarchy and middleware reading, not
  on an observed request.
- Whether `gt()` is currently true on this install — i.e. whether `~/.claude/.credentials.json`
  holds `claudeAiOauth` with the scopes Claude Code itself checks — was not determined. It
  decides how much of §6.4's payoff would even materialize.
- Whether the published catalog at `downloads.claude.ai` would activate for UW at all (the
  `Nme(ne).length===0` "no model this build offers" short-circuit), and how an activated
  catalog interacts with `modelPicker.replaceBuiltInOptions: true`.
- Whether the picker cleanly excludes `claude-mythos-5*` (foundry/vertex/bedrock ids are
  `null` for those rows) or would emit a broken id.
- `kelp_forest_sonnet`, cited in report 16's addendum, does not exist in build 2.1.261. Treat
  that reference as stale or from a different build.
- The §6.3 corollary (Vertex/Bedrock giving conservative defaults for all rows with no
  declaration) follows from `lH()`'s definition but was not observed in a running session.
</content>

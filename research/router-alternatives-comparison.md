# CCR Alternatives: Local Multi-Provider LLM Router Landscape

**Purpose:** Reference document for future decision-making about whether to keep patching
`@musistudio/claude-code-router` (CCR) or migrate to a different local, self-hosted
multi-provider LLM router/gateway. This is a fact-gathering document only — it does not
recommend a course of action.

**Trigger:** UW found and is patching a CCR bug where an internal per-request provider-metadata
lookup scales linearly with configured provider count (~7.3s at 46 providers vs ~110-150ms at
1 provider), caused by an uncached linear scan against a bundled provider-preset catalog on
every request. This raised the question of whether other routers have (or avoid) the same class
of bug, and whether one is a better long-term fit for UW's goal of routing hundreds-to-thousands
of providers/models through Claude Code.

**Evaluation criteria applied to each candidate:**
- Local/self-hosted (not just a hosted aggregator)
- Claude Code compatibility: serves an Anthropic-Messages-API-shaped endpoint (`/v1/messages`),
  since Claude Code does not speak plain OpenAI chat-completions
- Architecture for provider lookup: pre-built index/map (scalable) vs. per-request linear scan
  against a catalog (the CCR bug's pattern)
- License, self-hosting model, activity/maturity

---

## 1. LiteLLM (BerriAI/litellm)

**What it is:** An open-source AI gateway/proxy ("the fastest, litest AI Gateway") that fronts
100+ LLM providers behind a unified API. Runs as a Python proxy server (pip-installable) with,
per its current GitHub description, a "Rust core with Python SDK" — a fairly recent architectural
shift worth confirming in the changelog if it becomes relevant, since a Rust core would change the
performance profile of the exact code path that had the O(n) bug.

**Claude Code / Anthropic API compatibility:** Yes. LiteLLM proxy serves `/v1/messages` in
native Anthropic Messages API shape — it translates the Anthropic-format request to whatever
target provider is configured and translates the response back, so Claude Code can be pointed at
it via `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. Claude Code v2.1.129+ additionally does
gateway model discovery by calling `GET /v1/models` on startup and populating the `/model` picker
with whatever the proxy returns (labeled "From gateway") — directly relevant to UW's picker-based
workflow. Some rough edges exist: e.g. GitHub issue #26554 documents a Claude Code → LiteLLM →
Bedrock Converse 400 error ("text field is blank") on certain multi-turn tool-call shapes, and
issue #27180 is an open feature request for full Anthropic-native `/v1/models` response format
for Claude-Code-style gateway discovery — meaning the discovery/model-listing path may not be
100% polished yet.

**Provider-lookup architecture / the CCR-bug question:** LiteLLM has already hit and fixed
*exactly* this class of bug. PR #18867 ("perf: 92.7% faster provider config lookup") refactored
`ProviderConfigManager.get_provider_chat_config` from an O(n) if/elif chain to an O(1) dictionary
lookup, citing that this function runs inside the client decorator invoked on every single proxy
request — the fix reportedly let LiteLLM sustain 2.5x more request throughput. This is on top of
earlier related work: PR #13879 and PR #7672, both titled around "O(1) set lookups for
model/provider routing," suggests this has been a recurring category of perf debt in LiteLLM that
has been incrementally hunted down and fixed rather than architected away from the start.
Net: LiteLLM is *not* immune to this bug class architecturally, but it has active precedent of
finding and fixing these lookups, and has apparently landed O(1) lookups for the main provider
config path.

**Self-hosting model:** Docker (official images, DB-bundled and non-root variants exist;
community images like `hwdsl2/docker-litellm` add auto-config/persistence), or `pip install
litellm[proxy]` + `config.yaml`. Self-hosted deployment has no functional restrictions vs. the
hosted/cloud offering per public docs.

**License:** MIT.

**Scaling / config-size notes:** Docs describe routing "100+ models" through one config.yaml,
with wildcard model entries (e.g. `gemini/*`) to avoid enumerating every model explicitly, TPM/RPM
limits per model, and a `--num_workers` flag for multi-process scaling. No published hard ceiling
on provider/model count was found. One benchmark noted ~42 concurrent req/s on a single t3.medium
with Postgres enabled — a throughput figure, not a provider-count scaling curve, so it doesn't
directly confirm or refute behavior at hundreds-to-thousands of configured providers.

**Activity/maturity:** Very active. ~57.6k-58.2k GitHub stars (self-reported/search-indexed,
not independently re-verified here). Releases reported at high frequency (multiple per day
during some periods); most recent release found during this research was v1.101.0-rc.1
(Sept 6, 2026), with repo activity as recent as Sept 8, 2026. Large surface area (100+ providers,
proxy + SDK + admin UI + spend tracking + guardrails), which also means larger attack/bug surface.

**Sources:**
- https://github.com/BerriAI/litellm
- https://github.com/BerriAI/litellm/pull/18867
- https://github.com/BerriAI/litellm/pull/13879
- https://github.com/BerriAI/litellm/pull/7672
- https://github.com/BerriAI/litellm/issues/27180
- https://github.com/BerriAI/litellm/issues/26554
- https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models
- https://docs.litellm.ai/docs/providers/anthropic
- https://docs.litellm.ai/docs/proxy/configs
- https://docs.litellm.ai/docs/proxy/load_balancing
- https://github.com/hwdsl2/docker-litellm

---

## 2. Bifrost (maximhq/bifrost)

**What it is:** An open-source, Go-based LLM gateway from Maxim (getmaxim.ai), marketed as the
"fastest LLM gateway" with claims of being "50x faster than LiteLLM," ~11µs-100µs overhead at
5,000 RPS, ~9.5x faster / ~54x lower P99 latency / 68% less memory than LiteLLM in a published
benchmark (t3.medium, 2 vCPU, tier-5 OpenAI key — i.e. a specific, narrow benchmark configuration,
not a general provider-count scaling test). Claims support for 20-23+ providers and "1000+
models."

**Claude Code / Anthropic API compatibility:** Yes, explicitly documented and blogged about.
Bifrost exposes an Anthropic-Messages-API-compatible endpoint under `/anthropic` (so the full
path is `/anthropic/v1/messages`, not `/v1/anthropic` — a path detail worth getting right if
tested). Multiple Maxim/Bifrost blog posts and docs pages specifically cover "Claude Code with
Bifrost," including running Claude Code against non-Anthropic models by pointing
`ANTHROPIC_BASE_URL` at Bifrost, with Bifrost doing request/response translation between the
Anthropic shape and whatever target provider is configured. There is also documented support for
Claude Desktop pointing at `/v1/messages`-style paths.

**Provider-lookup architecture / the CCR-bug question:** Better-positioned by design than CCR's
bug pattern, per available docs (not independently verified against source). Bifrost has a
"Model Catalog" described as a central in-memory registry/map (`modelPool[provider][]models`)
that tracks which models belong to which provider, used for both governance routing and adaptive
load balancing — i.e., a pre-built map rather than a per-request scan. Providers are registered
by string-key identifiers (e.g. `"openai/gpt-4"`) mapped to Go struct implementations. Config
persistence uses a pluggable `ConfigStore` (SQLite or PostgreSQL out of the box) with hash-based
change detection between file and DB and live runtime updates via a REST API. Docs also cite a
specific "10ns" API-key-selection performance figure for weighted load balancing across many
keys/providers, which if accurate implies the hot path was designed with map/array-based O(1)
selection in mind rather than linear scanning. This is the most architecturally reassuring
candidate on paper for the specific bug class in question, but it has not been independently
load-tested by UW at CCR-comparable provider counts (46+).

**Self-hosting model:** Fully self-hosted: `npx`, Docker, or a native Go binary. "Zero to
production-ready gateway in under a minute" per marketing docs. No SaaS-only tier gate mentioned
for core routing.

**License:** Apache 2.0.

**Activity/maturity:** Newer and smaller than LiteLLM but active. ~7.9k GitHub stars, ~1.2k
forks (per a single fetch, not cross-verified), ~6,900+ commits on the `dev` branch. Actively
publishing docs/blog content through 2026 (multiple Claude-Code-integration articles dated 2026).
Notably younger project than LiteLLM, with a narrower (though growing) provider list (~20-23
explicitly named vs. LiteLLM's 100+), despite marketing claiming "1000+ models" support (models
vs. providers — many models per provider).

**Caveat on benchmark claims:** The "50x faster than LiteLLM" and similar headline figures come
from Bifrost's own vendor blog/marketing content, not a third-party benchmark; treat as directional
marketing framing pending independent reproduction, especially since LiteLLM's own perf fixes
(PR #18867 etc.) post-date some of that framing and may have closed part of the gap.

**Sources:**
- https://github.com/maximhq/bifrost
- https://www.getmaxim.ai/blog/bifrost-a-drop-in-llm-proxy-40x-faster-than-litellm/
- https://www.getmaxim.ai/bifrost/blog/integrating-claude-code-with-bifrost-gateway
- https://docs.getbifrost.ai/cli-agents/claude-desktop
- https://www.getmaxim.ai/bifrost/guides/providers/anthropic
- https://docs.getbifrost.ai/architecture/framework/config-store
- https://deepwiki.com/maximhq/bifrost/4.2-supported-providers
- https://deepwiki.com/maximhq/bifrost/7-configuration-management
- https://github.com/maximhq/bifrost/blob/dev/docs/providers/provider-routing.mdx

---

## 3. "Omniroute"

A real, verifiable open-source project **does** exist under this name (capitalized "OmniRoute"),
distinct from anything unrelated the name might collide with (no unrelated same-name product was
found competing for this term in search results).

**What it is:** "OmniRoute" (by "Cheaper Inference") is an open-source AI gateway claiming to
aggregate 338-352 LLM providers (150+ free) and 1200+ models behind a single OpenAI-compatible
endpoint, with quota-aware auto-fallback, 18 named routing strategies (priority, weighted,
round-robin, cost-optimized, etc.), and a token-compression feature ("RTK + Caveman" stacked
compression, claimed 15-95% token reduction — note: name collision with an unrelated
"Caveman"-branded tool is possible; not verified whether it's the same "Caveman" as any other
tool of that name).

**Claude Code / Anthropic API compatibility:** Documentation claims it "works with Claude Code,
Codex, Cursor, OpenCode, Cline & Copilot" and lists a primary OpenAI-compatible endpoint at
`/v1`. It is unclear from available docs whether it serves a true Anthropic-Messages-shaped
`/v1/messages` endpoint the way LiteLLM/Bifrost do, or whether Claude Code compatibility is
achieved some other way (e.g. pass-through to the real Anthropic API for Claude models while
OpenAI-shaping everything else). This needs hands-on verification before relying on it.

**Self-hosting model:** npm global package, Docker image (amd64+arm64), Electron desktop app,
Android via Termux, or PWA — broad and genuinely self-hostable.

**License:** MIT.

**Provider-lookup architecture:** Docs describe a "multi-tier resilience model" (circuit
breakers, connection cooldown, model-level lockout) and a "16-factor live scoring" auto-routing
engine for provider selection — implying active per-request scoring across providers rather
than a simple static map lookup. Whether this scoring pass itself scales linearly with configured
provider count (i.e., whether it has its own version of CCR's bug, just in the routing-decision
logic rather than the metadata-lookup logic) is **not resolved by documentation** and was not
verified against source in this pass.

**Caveat — verify before trusting adoption/scale claims:** This repository (and near-identical
forks/mirrors of it under multiple different GitHub usernames — e.g. `diegosouzapw/OmniRoute`,
`gentoopeng/omniroute`, `pitbaden/omniroute` — all with nearly identical READMEs) reports
unusually large numbers for its apparent age/obscurity: one fetch reported 62.8k stars, 8.8k
forks, and "550+ contributors" for a tool that does not otherwise show up prominently in
mainstream LLM-tooling discussion. The existence of several separately-named repos with
near-identical marketing copy and incrementing superlatives (varying provider counts: 338, 339,
352 across different mirrors) is a pattern worth treating with real skepticism — it resembles
SEO/star-farming repo cloning rather than a single well-known canonical project. Recommend
treating all quantitative claims about this project (star count, provider count, contributor
count, "20,000+ GitHub stars" per one blog aggregator) as unverified marketing copy until checked
directly against the live GitHub API for a specific canonical repo.

**Sources:**
- https://github.com/diegosouzapw/OmniRoute
- https://github.com/gentoopeng/omniroute
- https://github.com/pitbaden/omniroute
- https://www.omniroute.online/
- https://sourceforge.net/projects/omniroute.mirror/
- https://medium.com/data-science-in-your-pocket/omniroute-one-ai-gateway-to-access-290-ai-providers-through-a-single-api-40760179d64d

---

## 4. "CLIAPIPROXY" / "CLI API Proxy"

No project exactly named "CLIAPIPROXY" (that spelling/casing) was found. The closest verifiable
matches in this space are:

### CLIProxyAPI (router-for-me/CLIProxyAPI) — closest name match (letters transposed vs. the query)

**What it is:** An open-source Go proxy server that wraps *subscription-based* CLI AI tools
(ChatGPT/Codex, Claude Code, Gemini/Antigravity, Grok/xAI "Grok Build") and re-exposes them as
OpenAI/Gemini/Claude/Codex-compatible API endpoints. Its purpose is different from CCR/LiteLLM/
Bifrost/OmniRoute: rather than routing across many independently-configured provider *API keys*,
it lets someone with an existing ChatGPT Plus/Pro, Claude Pro/Max, or Gemini CLI *subscription*
present that subscription's access as a programmatic API endpoint (via OAuth login flows and
multi-account load balancing across several such subscriptions). This is a materially different
use case from UW's "route hundreds of provider API keys" goal — it's about multiplying/exposing
subscription seats, not aggregating many distinct providers.

**Claude Code / Anthropic API compatibility:** Yes, in the sense that it can present a
Claude-compatible endpoint, and it explicitly lists Claude Code as one of the CLI tools it wraps.

**Self-hosting model:** Runs as a local sidecar/binary.

**License:** MIT.

**Activity/maturity:** Reported at 51k stars / 7.7k forks / ~3,691 commits via a single WebFetch
pass (not independently cross-checked; treat with the same caution as other star/fork figures in
this document — see Open Questions). Appears to be a genuinely distinct and separately-maintained
project (not a mirror-farm pattern like OmniRoute above), and belongs to a broader family of
similar tools in this niche found during search (`ben-vargas/ai-cli-proxy-api`,
`vibheksoni/UniClaudeProxy`, `fuergaosi233/claude-code-proxy`, `jimmc414/claude_n_codex_api_proxy`),
suggesting "wrap a CLI subscription as an API" is a distinct, populated sub-category of tools
separate from "aggregate many provider API keys," which is UW's actual use case.

**Provider-lookup architecture / scaling relevance:** Not directly comparable to CCR's bug, since
this tool's core job (multiplexing a handful of subscription accounts) does not require scaling
to hundreds/thousands of distinct providers the way UW's use case does. Low relevance to UW's
specific performance question, included here only because it's the closest real project to the
name searched for.

**Verdict on the literal name "CLIAPIPROXY":** Not found as a distinct, verifiable open-source
project under that exact name. Treating this as "nothing verifiable turned up" per the task
instructions, with CLIProxyAPI flagged only as the nearest plausible name collision.

**Sources:**
- https://github.com/router-for-me/CLIProxyAPI
- https://help.router-for.me/introduction/what-is-cliproxyapi
- https://github.com/ben-vargas/ai-cli-proxy-api
- https://github.com/vibheksoni/UniClaudeProxy
- https://github.com/fuergaosi233/claude-code-proxy
- https://github.com/jimmc414/claude_n_codex_api_proxy
- https://fazm.ai/blog/clipproxy

---

## 5. Other prominent tools noted in passing

Found during searches for "claude code custom router" / "anthropic messages api proxy
multi-provider self-hosted" but not deep-dived (either lower relevance to UW's scale goal, or
narrower single-purpose scope):

- **musistudio/claude-code-router (CCR itself)** — described in its own README as "one local
  control plane for every AI agent," supporting OpenAI Chat/Responses, Anthropic Messages,
  Gemini, OpenRouter, DeepSeek, SiliconFlow, Moonshot, Kimi Code, Mistral, Z.AI, Bailian, and
  custom-compatible providers. Included here only for completeness/context, since it's the
  incumbent being evaluated against, not a new alternative.
- **VictorMinemu/CC-Router** — round-robin proxy specifically for multiple *Claude Max
  subscriptions* (OAuth token rotation), translating Anthropic Messages → OpenAI Responses and
  back. Same "multiply subscriptions" category as CLIProxyAPI, not a many-distinct-providers
  aggregator.
- **TrueFoundry AI Gateway** — a commercial/enterprise AI gateway product (not purely open-source
  self-hosted in the same sense as the others) that also accepts Anthropic-shaped requests for
  Claude Code and re-routes to other providers; oriented toward enterprise spend/budget
  governance features.
- **JulesMellot/Claude-Code-openrouter-proxy** — small, narrowly-scoped public proxy specifically
  for routing Claude Code through OpenRouter; not a general many-provider self-hosted gateway in
  its own right (it delegates the actual multi-provider aggregation to OpenRouter, a hosted
  aggregator, which the task explicitly excludes as a category).

None of these five were found to make an explicit claim of both (a) scaling to hundreds/thousands
of self-configured providers and (b) native Anthropic-Messages-API compatibility in the way
LiteLLM, Bifrost, and (partially/unverified) OmniRoute do, so they were not deep-dived further.

---

## Open questions (need hands-on testing, not resolvable by web research alone)

1. **Actual per-request latency vs. provider count for each candidate**, run against UW's real
   config shape (46+ providers, growing toward hundreds/thousands) — the only way to confirm
   whether LiteLLM's O(1) fix, Bifrost's in-memory model-catalog map, and OmniRoute's routing
   engine actually hold flat latency at scale, or whether some *other* per-request path in each
   (e.g. OmniRoute's "16-factor live scoring," LiteLLM's guardrail/logging middleware stack,
   Bifrost's governance/plugin chain) reintroduces an O(n)-with-provider-count cost that isn't
   visible from documentation alone.
2. **Whether LiteLLM's `/v1/messages` Anthropic-native path is fully equivalent to Claude Code's
   expectations** end-to-end (tool calling, streaming, multi-turn with tool results, model
   picker discovery via `/v1/models`) given the two open/recent GitHub issues found
   (#26554, #27180) suggesting some rough edges as of Sept 2026.
3. **Whether Bifrost's provider/model catalog (23 explicit providers vs. LiteLLM's 100+) can
   actually be extended to UW's long-tail of providers** without significant custom provider
   implementation work, given Bifrost registers providers as compiled Go struct implementations
   rather than declarative config entries (LiteLLM and CCR both appear to allow more purely
   config-driven "custom OpenAI-compatible provider" entries).
4. **OmniRoute's legitimacy and real adoption level** — the star/fork/contributor counts
   reported for this project could not be confidently verified in this pass (see caveat under
   §3) and should be checked directly against the GitHub API (not scraped page summaries) before
   any of its claims are used to inform a decision. Its actual `/v1/messages` Anthropic-shape
   support (vs. OpenAI-only) also needs direct testing.
5. **All star/fork/commit-count figures in this document were gathered via a single WebFetch
   pass per repo (an LLM summarizing a fetched GitHub page), not the GitHub API directly.** These
   numbers can drift or be summarization artifacts and should be re-pulled via `gh api
   repos/<org>/<repo>` (already available as a tool in this environment) before being cited in
   any decision document.
6. **Migration cost / config-model mismatch** for any candidate — none of this research touched
   how much of UW's existing CCR-specific tooling (config.sqlite manipulation, keysync pipeline,
   loopback RPC calls to `service.json` / `/api/ccr/rpc`) would need to be rebuilt against a
   different config store/API shape (e.g. Bifrost's SQLite/Postgres ConfigStore + REST API,
   LiteLLM's `config.yaml` + `LiteLLM_ProxyModelTable` DB model, or OmniRoute's own store) —
   this is a real cost but is an implementation question, not a research question, and was
   intentionally out of scope here per the task instructions (no recommendation to be made).

# Research: audit of the existing UW keysync pipeline (2026-09-02)

All findings verified by execution, not inspection alone.

## 1. Catalogue source

`C:\nvm4w\nodejs\node_modules\@musistudio\claude-code-router\dist\models.json` — hardcoded at
`keysync.mjs:73`, read by `loadCatalog()` (`:75-84`).

A **vendored artifact of the CCR npm package**, not UW-owned — `npm i` of claude-code-router
overwrites it. 19.7 MB, `schemaVersion: 2`,
`generatedBy: "scripts/generate-models-json.mjs"`, aggregated from LiteLLM
`model_prices_and_context_window.json`, `models.dev/api.json`, and the OpenRouter models API.

**`generatedAt: 2026-08-24T12:22:28.162Z`** — 9 days stale. Staleness is read and printed
(`run.mjs:41`) but **never enforced**; there is no refresh path and no max-age check.

4,298 models / 217 providers. The summary claims 10,176 raw records merged down to 4,298
(5,878 duplicates collapsed).

Per-model schema (all 4,298 carry `modalities` and `capabilities`):

| Field | Coverage |
|---|---|
| `limits.contextTokens` / `.outputTokens` / `.supports1MContext` | 3958 / 3871 / 827 |
| `modalities.input[]`, `modalities.output[]` | 4298 |
| `capabilities.{toolCalling, reasoning, imageInput, audioOutput, videoInput, openWeights, temperature, pdfInput, attachments, …}` | 4298 (toolCalling true on 2,206) |
| `pricing.offers[].per1MTokens.{input,output,cacheRead,cacheWrite,reasoningOutput,…}` | 4,078 models priced |
| `displayName`, `metadata.releaseDate`, `sourceRecords[]`, `aliases[]` | 2858 / 2796 |

**`loadCatalog` discards all of this except the provider/model grouping** — it returns only
`{generatedAt, byProvider}`.

## 2. Provider construction — `buildProviders()` (`keysync.mjs:167-240`)

Two-stage `models[]` fill per provider:

1. **testModel first** (`:184-192`) — `vp.testModel` from the vault is pushed as the lead entry, tier resolved via catalogue lookup if the id matches. The comment at `:177-181` records the measurement that justifies it: **preferring catalogue ids dropped the live pass rate to 4/44**, because the bundled catalogue lists models a given key/tier cannot actually call.
2. **Catalogue extras appended** (`:193-205`), capped by `MAX_MODELS_PER_PROVIDER` (`:114`, `UW_MAX_MODELS`, default **3**).

```js
const ranked = catalogEntries
  .map((m) => ({ m, tier: inferTier(m) }))
  .sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
    a.m.model.length - b.m.model.length);
for (const { m, tier } of ranked) {
  if (models.length >= MAX_MODELS_PER_PROVIDER || seen.has(m.model)) continue;
  models.push({ id: m.model, tier, contextTokens: m.limits?.contextTokens });
```

**No-catalogue path:** if `catalogEntries` is empty the provider ships exactly one row — its
testModel. If neither exists, it is skipped with a note (`:206-209`).

**Measured coverage against the live vault:**
- 56 registry keys → 46 after filter → **44 distinct providers**
- Only **21 of 44** have any catalogue entry at all
- Only **6 of 44** have their `testModel` present in the catalogue

The 23 uncovered are mostly aggregators/routers absent from litellm/models.dev/openrouter:
`tokenharbor, routllm, tokenrouter, nararouter, teamorouter, fanar, pollinations, llm7,
aionlabs, agnes, xai, bigmodel, tabiai, gorouter, bai, commandcode, veniceai, bluesminds,
agentrouter, nousresearch, indeedwebid, seekai, gmicloudai`.

Net: 83 vault rows + 4 Anthropic relay rows = **87 picker rows / 45 providers**.

## 3. The broken `inferTier` — CONFIRMED empirically

```js
export function inferTier(entry) {
  const p = entry.pricing ?? {};
  const nums = [p.inputPerMillion, p.outputPerMillion, p.input, p.output]
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  if (!nums.length) return "unknown";
  return nums.every((v) => v === 0) ? "free" : "paid";
}
```

The actual catalogue schema:
```json
"pricing": {
  "currency": "USD",
  "normalizedUnit": "per1MTokens values are USD per 1,000,000 tokens; ...",
  "offers": [
    { "source": "models.dev", "provider": "groq", "model": "allam-2-7b",
      "sourceUnit": "usd_per_1m_tokens",
      "per1MTokens": { "input": 0, "output": 0 } }
  ]
}
```

The only keys ever present under `pricing` are **`currency`, `normalizedUnit`, `offers`**.
Measured:

- `inferTier` over all 4,298 models → **`{"unknown": 4298}`**. Not one model classifies.
- Models carrying any of the four legacy fields → **0**.

**Correct path:** `entry.pricing.offers[].per1MTokens.input` / `.output`. Using it yields
`{paid: 3387, unknown: 499, free: 412}`.

**Does the catalogue have enough data?** Yes for ~88% (3,799 of 4,298 classify), with two
caveats: an offer can price a model at a *different provider* (`offers[].provider` is its own
field, and merged records carry up to 16 offers), so a naive all-offers fold answers "is this
free anywhere" rather than "is it free on my key". And 499 remain genuinely unknown.

**Consequences of universal `"unknown"`:**
- The free-tier comparator at `:198` evaluates `1 - 1 = 0` for every pair, so the sort degrades to **pure shortest-id**. That is why `google/lyria` (a music model, `output: ["audio"]`) and `google/veo-2` (video) beat `gemini-2.5-pro` into the picker, and why `ollama/llama2`, `ollama/llama3`, `mistral/mistral`, `openai/o1`, `huggingface/inkling` are shipped. The catalogue carries the `modalities`/`toolCalling` data that would exclude these; `buildProviders` reads none of it.
- The guard at `:229` (`if (m.tier !== "unknown") row.description = m.tier`) **never fires. 0 of 83 vault rows carry a description.**

## 4. Label / description generation

```js
const row = { model: `${name}/${m.id}`, label: `${name} > ${m.id}` };
if (m.tier !== "unknown") row.description = m.tier;   // dead code
row.behavesAs = BEHAVES_AS;                            // "claude-sonnet-4-6"
if (m.contextTokens) row.contextTokens = m.contextTokens;
```

`label` is mechanically `provider > raw-model-id` and carries **no** information the `model`
field doesn't already have — measured avg 25.0 chars (min 10, max 59) vs model avg 23.0.
Catalogue `displayName` (available for 2,858 models) is **never consulted**.

`description` is the only differentiating surface and is **empty on all 83 vault rows**. The
only 4 descriptions in the whole picker are `"subscription"`, hardcoded for the Anthropic
relay rows at `run.mjs:110`.

**`contextTokens` is computed and then discarded.** Set for 42 of 83 rows, then stripped at
`run.mjs:464`:
```js
options: built.picker.map(({ contextTokens, ...row }) => row),
```
Shipped per-row keys are exactly `{model, label, behavesAs}` (+ `description` on the 4
Anthropic rows).

## 5. The vault

`loadVault()` (`:21-25`) reads both files, BOM-stripped, keying providers by name.

**`registry.json`** — 56-entry array, 48 distinct providers. Fields `id, provider, bucket,
tier, envVarName, notes, added`. **`tier` ∈ {free, paid, management}** — a per-credential
plan claim. Buckets: `personal, tamu, sportsvector{,1,2,3}, personal_maestro, personal_mxene`.

**`filterRegistry()`** (`:30-36`) drops `/^sportsvector/i` buckets, `tier === "management"`,
orphans with no provider profile, and `protocol === "generic"`. 56 → 46.

**`chooseKeys()`** (`:50-70`) groups by provider; single-key providers pass through, multi-key
providers must have a deliberate name in `KEY_CHOICES` (`:42-48` — only `groq` and `deepseek`)
or it **throws** rather than let a timestamp decide.

**`providers.json`** — 47-entry array:

| Field | Present | Notes |
|---|---|---|
| `provider`, `docsUrl`, `baseUrl`, `protocol`, `headersTemplate`, `testModel`, `notes`, `requiresBalance`, `updated` | 47/47 | `testModel` non-empty on 45 |
| `maxTokensParam` | 30/47 | `max_completion_tokens` or `max_tokens` |
| `accountInfo` | 29/47 (7 non-empty) | free-form |

- `protocol` ∈ `{openai (44), generic (2), anthropic (1)}`
- `requiresBalance: true` on **16/47** — an existing paid-vs-free signal, currently unused by the picker
- `notes` is prose but **34/47 reference a live model-listing endpoint** ("GET /v1/models for full current catalog", "GET /v1beta/openai/models"). **These are per-provider live catalogue endpoints that nothing currently calls.**
- `accountInfo` keys observed: `freeCredits`, `freeModels`, `balanceNote`, `endpoints`, `console`, `portal`, `verifyMethod`, `apiHost`, `accountId`, `org`, `platform`, `dashscopeNativeEndpoint`, `loginFingerprintId`

Key **values** are never in these files — they live in Windows Credential Manager, read in one
batched PowerShell session via `loadAllKeys`/`readKey` (`run.mjs:48-64`), never logged.

`resolveProtocol()` (`:102-111`) pins protocol+baseUrl together because CCR resolves protocol
from the base-URL host and overrides any explicit `type`.

## 6. Verification data

**`verified-rows.json`** (3,386 B, `2026-09-01T21:46:19.342Z`). Shape
`{generatedAt, probe: "real Claude Code CLI (ground truth)", working: string[],
results: [{model, ok, ms, why}]}`. 22 probed → **18 working, 4 failed**. Latency 11.0-36.7 s.

Producer `verify-cli.mjs` spawns the real `claude.exe`
(`--settings <f> --model <m> -p "Reply with exactly this...: UW-CLI-OK"`) rather than
synthesizing a request. Its header (`:1-9`) records why: synthetic gateway probes over-report;
`groq/openai/gpt-oss-20b` returns 200 to a hand-built request and still fails with "400 All
target providers failed" under Claude Code's real payload. Env is aggressively scrubbed of
`CLAUDE*`/`ANTHROPIC_*`/`CCR_*` (`:66-70`).

**`--verified-only`** (`run.mjs:76-95`) intersects picker rows and provider `models[]` against
`verified.working`, and derives `verifiedOrder` = passing rows sorted **fastest-first**
(`:82`), used as an anchor-selection fallback at `:297`. It has a floor guard (`:91-94`)
because the count check becomes a tautology under this flag.

**`built-rows.json`** (`run.mjs:129-132`) is written *before* pruning specifically to break a
one-way ratchet — `verify-cli.mjs:37-50` re-probes the built set, not the shipped picker, so a
row dropped for a transient failure gets retried. The comment records that mistral was lost to
a single 503 under the old behaviour.

**Note:** current `built-rows.json` (83 rows, 2026-09-02T07:44) is **newer than**
`verified-rows.json` (2026-09-01T21:46) — the verification data is stale relative to the build.

## 7. Reusable machinery

All in `safety.mjs` unless noted:

| Function | Line | Description |
|---|---|---|
| `atomicWriteJson(file, obj)` | 353 | Temp+rename, 3 retries w/ in-process backoff, preserves and restores the file's SDDL ACL, removes temp on failure |
| `snapshotConfigDb(dbPath, stamp)` | 47 | WAL-safe `VACUUM INTO` snapshot of `config.sqlite`, then **DPAPI-encrypted at rest** (it holds every provider key in plaintext). Throws rather than proceed without a restore point |
| `ensureBackupDir()` | 26 | Creates `%LOCALAPPDATA%\uw-keysync\backups` with an owner-only DACL via `icacls` |
| `acquireLock()` | 162 | Single-writer mutex via atomic `open(…, "wx")`. Reclaims only a *provably dead* owner; a corrupt lock is treated as live |
| `isProcessAlive(pid)` | 210 | `kill(pid,0)`; treats `EPERM` as alive (elevated-process case) |
| `releaseIfOurs()` | 203 | Only deletes a lock whose recorded pid matches |
| `restartRelevantFingerprint(cfg)` | 248 | **Content-diff-and-skip.** Mirrors CCR's actual restart predicate read from the shipped dist. Deliberately unsorted (CCR compares by `JSON.stringify`) |
| `waitForGateway(port, 30s)` | 295 | Polls `/health` every 500 ms; 200/401/404 all count as listening |
| `otherClaudeSessions()` | 312 | Enumerates other running `claude.exe` pids (excluding own ancestors) to warn before a restart interrupts in-flight requests |
| `restoreSettings(backup, file)` | 134 | Rollback via temp+rename, with direct-copy fallback |
| `retainOnSuccess({snapshot, settingsFile})` | 106 | Deletes the key-bearing DB snapshot immediately, keeps newest settings backup, prunes older |
| `capFailedSnapshots(max=2)` | 121 | Bounds what survives a failed run so a rotated-out key cannot linger |
| `deleteStaleWifToken(dir, profileId)` | 93 | Removes CCR's duplicate plaintext gateway-key file |
| `psQuote(s)` | 23 | Escapes single-quoted PS/SQL literals (username may contain an apostrophe) |
| `validate({providers,picker}, n)` | keysync.mjs:243 | Provider count, cross-provider alias-collision detection, every picker row exists verbatim in `Providers[].models`, no empty credential |
| `reconcileUserModelPin(settings, rows)` | keysync.mjs:312 | Treats `settings.model` as user-owned: kept while it names a live row, cleared once stale |
| `stripOneMSuffix(settings)` | keysync.mjs:294 | Strips `[1m]` from third-party model env vars, leaves `anthropic/*` alone |
| bare-id hijack guard | run.mjs:163-187 | Warns when a Claude-ish bare id is listed by exactly one non-Anthropic provider |
| `why.mjs` | — | Reads CCR request logs over RPC and recovers the real provider error from nested `attempts[]` that CC truncates to "400 All target providers failed" |
| harness `guard.mjs` | — | `assertRouterClean(cfg)`, `assertPayloadIsolated(cfg, …)` |

## 8. The earlier Rust TUI — found, but not in git

`C:\Users\osami\.uw` is **not a git repository**, and neither is any parent. No repo on this
machine contains `menu.rs`/`ui.rs` in its history. **The "kept in git history, not deleted"
premise does not hold — there is no git history to recover from.**

The code survives as a **plain-file scratchpad copy** at
`…\Temp\claude\C--Users-osami\e3129c2d-…\scratchpad\uwcopy\` — a complete Cargo crate,
`name = "uw"`, `edition = "2024"`, *"UltimateWrap - a standalone Rust TUI companion to Claude
Code + CCR"*, deps `ratatui 0.29` + `crossterm 0.28` + `reqwest` + `windows` (Credential
Manager). 2,233 lines of `src/` plus 4 test files, dated 2026-09-01 12:55-13:09 — the day
before the Node rewrite. **Fully recoverable but at risk under `%TEMP%`.**
*(Since preserved to `~/.uw/prior-art/uw-rust-tui`.)*

| File | Lines | What it does |
|---|---|---|
| `model_tier.rs` | 448 | **Directly relevant.** A *working*, schema-agnostic `infer_tier(id, obj)`: (1) `:free`/`-free`/`/free` suffix detection covering three real router conventions; (2) recursive `scan_numeric` over any key containing `"pric"` or `"cost"`, at any nesting depth, accepting numbers *and* numeric strings; (3) `Unknown` otherwise. Plus `ProviderPlanRegistry` — reads `registry.json`'s per-key `tier` as a **deliberately separate** `ProviderPlanHint` type, folding conflicting credentials (the real `groq` case) to *no claim*, and mapping `management` to no claim. `resolve_label()` gates the plan hint to fire only where per-model tier is `Unknown`. 11 tests, 5 copied verbatim from Maestro as a port-fidelity proof |
| `menu.rs` | 475 | Two-level provider → model picker. `FilterList<T>` (keys lowercased once, whitespace-token-split AND'ed substring filter, cursor resets on refilter), `ModelChoice`, `ProviderChoice::group()` with case-insensitive grouping and alphabetical ordering, `ProviderTier` aggregate |
| `ui.rs` | 631 | ratatui rendering. `tier_label()` renders per-model tier as a coloured parenthesised word and a plan hint as dark-gray `[free plan]` / `[paid plan]` — structurally impossible to confuse. Three retained variants |
| `catalog.rs` | 272 | `rows_from_json()` for CCR's **live** `/v1/models` shape, with `#[serde(flatten)] rest` handing unrecognised keys to `infer_tier` verbatim. Carries an `#[ignore]`d test pinning a known gap: real CCR route ids are hex-encoded and collapse to one bogus `anthropic` group |
| `http.rs` | 42 | **Load-bearing constraint: the catalogue client's User-Agent must contain "claude"** — CCR branches `/v1/models` on `isClaudeCodeUserAgent`, and only that branch returns the Anthropic shape *and* the 1M-context `[1m]` variants. A generic UA silently yields a smaller catalogue |
| `credman.rs` / `fixture.rs` / `main.rs` | 99 / 119 / 115 | Credential Manager reads; embedded fixture; TUI event loop (Esc ladder, Windows press/release dedup) |

**Verification:** porting the Rust `infer_tier` to JS and running it against the current CCR
catalogue yields `{paid: 3619, free: 405, unknown: 274}` — i.e. it **works on today's schema
without modification**, where the JS `inferTier` returns 100% unknown. It differs from a
strict `per1MTokens`-only read on 241 models, because the recursive scan also picks up
`perImage`/`perQuery`/`perRequest` offers (e.g. `aiml/flux-pro` → paid rather than unknown).

---

## Gaps relative to a rich per-provider catalogue

1. **No UW-owned catalogue.** Source is a vendored file inside a third-party npm package; `npm i` overwrites it. No copy, no pinning, no provenance record.
2. **No freshness policy.** `generatedAt` printed but never checked; 9 days stale, no refresh mechanism.
3. **Tier inference is 100% dead** — wrong field path, verified across all 4,298 models. The free-tier sort is a silent no-op, degrading curation to shortest-id.
4. **Coverage is the dominant problem, not staleness.** 23 of 44 providers have no catalogue entry, and only 6 of 44 have their `testModel` in it. Even a perfect tier fix leaves >half the picker uninformed.
5. **Curation ignores every capability signal already present** — `modalities`, `capabilities.toolCalling`, `reasoning`. Audio/video/image-output models are actively shipped into a chat picker.
6. **`displayName` unused** (2,858 models have one); labels are mechanical restatements of `model`.
7. **`contextTokens` computed then thrown away** at `run.mjs:464`.
8. **Description surface empty** on 83/87 rows.
9. **Vault signals unused:** `registry.json.tier`, `providers.json.requiresBalance` (16/47), `accountInfo.freeCredits`/`freeModels`. The Rust `ProviderPlanRegistry` already implements exactly this fallback and is not ported.
10. **34 live per-provider model endpoints documented in `providers.json.notes` are never called** — no live discovery path exists; `autoFetchModels: false` on every generated provider.
11. **Offer-provenance not modelled.** `pricing.offers[].provider` can name a *different* provider than the key in hand.
12. **`MAX_MODELS_PER_PROVIDER = 3` is a flat global** with no per-provider or quality-aware allocation.
13. **Verification data is stale and unlinked** — `verified-rows.json` predates `built-rows.json`, has no schema version, and probe results never feed back into curation or ranking.
14. **The Rust prior art was un-versioned and in `%TEMP%`.** `model_tier.rs` in particular is a tested, working solution to gaps #3 and #9.

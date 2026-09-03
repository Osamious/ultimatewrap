# Research: build-avoidance — what can we reuse instead of writing? (2026-09-02)

**Headline:** the premise understates how much already exists, and **overstates the rescued
Rust crate's readiness — it has a non-terminating loop in its core layout routine.**
Recommendation: **Node, ~550 new lines**, reusing three things already on disk.

---

## 1. Reuse Maestro? — No to code, qualified yes to data

**(a) Shell out to Maestro's TUI binary — NOT VIABLE.** `/model` is an interactive slash
command inside a live chat session, guarded at `apps/tui/src/slash.rs:172-177` with *"`/model`
is only supported in local (in-process) mode"*. Documented headless modes (`--json`, `-p`,
`--workflow`) run prompts and workflows — there is no picker-only mode that prints a
selection. `maestro.exe` is 50 MB (debug) and boots a full engine + backend config before
reaching a picker. Adding `--pick-model` means owning Maestro's build.

**(b) Import the discovery crate — NOT VIABLE.** Three blockers:
- `harness/Cargo.toml` drags in `tokio`, `reqwest`, `axum`, `scraper`, `zeromq`,
  `tree-sitter` (+ rust + typescript grammars), `tokio-tungstenite`, `uuid`, `ignore`,
  `globset`, `serde_yaml` — that whole tree for ~50 lines of tier inference.
- `DiscoveredModel` is `pub(crate)`; `render_model_menu` is `pub(super)`. Not exported.
- `apps/tui` has **no `[lib]` target** and is 35,194 lines.

The rescued crate's own `lib.rs` records that this dependency was *"costed and rejected"* —
that judgement holds.

**(c) Consume `~/.maestro/model_cache.json` — VIABLE AS A SEED, NOT AS THE SOURCE.**

Measured: **50 backends, 4,282 models**. The format is designed for coexistence —
`write_cache` round-trips foreign entries as raw `serde_json::Value` specifically so another
writer's fields are never poisoned. Reading it is safe. But:

| Issue | Detail |
|---|---|
| Only 4 fields per model | `id`, `display_name`, `tier`, `capability` — **no context, no pricing, no modality** |
| 43.6% unknown tier | 1,867 of 4,282 `unknown` (184 free, 2,231 paid) |
| Wrong key space | Keyed by *Maestro backend name* (`groq-tamu-free`, `google-sportsvector1-paid`), not provider |
| Refresh coupling | 24 h TTL, refreshes only when Maestro runs. Current file dated Aug 31 — already stale |
| Portability | Lives on `D:`, requires Maestro installed |
| Undocumented | Schema is a private Rust struct, no version field |

**Verdict:** offline bootstrap and tier cross-check. Do not depend on it.

---

## 2. Rust crate vs Node — port the logic, drop the renderer

**Toolchain is NOT a blocker: cargo 1.96.0 and rustc 1.96.0 are installed**
(`C:\Users\osami\.cargo\bin\`).

**The crate genuinely works** — built and run: `cargo test --offline` compiles;
`target/debug/uw.exe` renders the two-level picker correctly on Windows Terminal with
provider counts, `(free available)` / `(paid)` aggregates, `[paid plan]` hints, filter line
and keybinding footer. **27 of 29 lib tests pass.** 2,229 src + 564 test lines.

### Two real defects, both in `ui.rs`

**1. `wrapped_height` over-counts by exactly 1** (`src/ui.rs:242-262`). The
`while len > width { lines += 1; len -= width }` loop adds a line the preceding `lines += 1`
already counted. Test `wrapped_height_matches_real_ratatui_wrapping` FAILS at every sample
and width (`mine=3 real=2`, `mine=37 real=36`, …). One-line fix: `lines += (len - 1) / width`.

**2. `menu_layout` does not terminate** (`src/ui.rs:186`). Its comment asserts *"The window
only ever shrinks, so this terminates in at most `rows.len()` turns"* — **that invariant is
false.** The loop exits only on the fixed point `next == window`. Adding the scroll note
changes the footer's wrapped height → changes the budget → changes the window → changes the
note text, and the note's own width flips (`(1-9 of 10)` vs `(1-10 of 10)`), so the window
oscillates between two values forever. Evidence: a pure-string test loop of 63,180 iterations
— milliseconds of work — exceeded 60 s in debug and was killed after ~10 min in release.
Defect 1 makes defect 2 more likely by inflating footer height.

### This inverts the reuse calculus

The correct, fully-tested parts are exactly the portable ones; the broken part is exactly the
part you would discard:

| Module | Lines | Status | Port cost to JS |
|---|---|---|---|
| `model_tier.rs` `infer_tier` + `scan_numeric` | **52** | all 5 tests pass | ~40 lines |
| `menu.rs` `FilterList` / `window_for` / `wrap_cursor` | ~150 of 475 | all tests pass | ~80 lines |
| `catalog.rs` | 272 | tests pass | mostly superseded by CCR's catalogue |
| **`ui.rs`** | **631** | **1 fail + 1 hang** | not ported — replaced |

**The valuable IP is not the code, it is the empirical knowledge in 52 lines:** that
`:free`/`-free`/`/free` are three separate wild conventions, that `contains("price")` misses
`"pricing"` so you must match `"pric"`, and that providers quote pricing values as strings.
That transfers as comments.

**Also against Rust:** distribution needs a native binary per platform; keysync has **no
`package.json` at all** (12 loose `.mjs`, 2,598 lines), so a Rust build step is a bigger step
change than adding a `package.json`. And the project already made this call once —
`keysync.mjs:4`: *"DEVIATION FROM THE PLAN, STATED UP FRONT: the plan specifies repurposing
the existing Rust crate. This is implemented in Node instead… A Rust port can follow."* That
deviation produced working code.

---

## 3. Off-the-shelf TUI components — live npm data (2026-09-02)

| Package | Version | Last publish | Weekly DL | Licence | Deps |
|---|---|---|---|---|---|
| `ink` | 7.1.1 | 2026-07-16 | 6,484,606 | MIT | 25 |
| `ink-select-input` | 6.2.0 | 2025-04-29 | 733,951 | MIT | 2 |
| `ink-text-input` | 6.0.0 | 2024-05-14 | 1,667,064 | MIT | 2 |
| `ink-table` | 3.1.0 | 2023-12-06 | 835,358 | MIT | 1 |
| `blessed` | 0.1.81 | **2015-09-03** | 1,573,384 | MIT | 0 |
| `neo-blessed` | 0.2.0 | 2018-06-13 | 40,358 | MIT | 0 |
| `terminal-kit` | 3.1.4 | 2026-07-19 | 229,654 | MIT | 8 |
| `enquirer` | 2.4.1 | 2023-07-28 | 35,327,860 | MIT | 2 |
| `@inquirer/prompts` | 8.7.0 | 2026-08-26 | 38,953,479 | MIT | 10 |
| `@inquirer/search` | 4.3.1 | 2026-08-26 | 33,372,612 | MIT | 3 |
| `inquirer-autocomplete-prompt` | 3.0.1 | 2023-09-25 | 1,774,754 | ISC | 5 |
| **`@opentui/core`** | **0.5.10** | **2026-09-01** | 808,619 | MIT | 5 |
| `@opentui/react` | 0.5.10 | 2026-09-01 | 267,910 | MIT | 2 |
| `fuzzysort` | 4.0.2 | 2026-08-13 | 9,586,478 | MIT | **0** |

**Which actually meet the requirement (filterable list + live detail pane + thousands of rows):**

- **`blessed` — dead** (2015). `neo-blessed` fork 2018. Its `listtable` would work; neither is maintainable.
- **`@inquirer/search` / `inquirer-autocomplete-prompt` — wrong shape.** Inquirer prompts are line-oriented: prompt line + result list. **No side/detail pane**, no persistent two-pane layout. Fine for a one-shot flat prompt; cannot express provider → model with a metadata pane.
- **`enquirer` — same limitation**, plus last publish 2023-07-28.
- **`ink-select-input` — half the job.** Verified from the packed tarball: has a `limit` prop (windowing), peer range `ink >= 5.0.0` so compatible with ink 7. But **no built-in filter** — you would add `ink-text-input` plus your own filter, i.e. write `FilterList` anyway. `ink-table` is stale (2023).
- **`terminal-kit` — maintained** (2026-07-19), `singleColumnMenu`/`gridMenu` exist, but they are blocking one-shot menus, not a composable two-pane layout with a live filter.
- **`@opentui/*` — strongest option, verified on this machine.** `@opentui/core@0.5.10` installed into a temp dir **imports successfully under Node v25.0.0 on Windows x64**, auto-selecting the `@opentui/core-win32-x64` prebuilt (no Zig/compiler needed). Prebuilts ship for win32-x64, win32-arm64, and all linux/darwin variants. `@opentui/react` (2 deps) exists alongside `@opentui/solid`.

**"Thousands of rows" is a red herring.** 1,569 rows never reach the renderer if you window —
you draw only the ~20 visible, exactly what the Rust `window_for` does. Every candidate
supports this. Choose on layout expressiveness and Windows behaviour, not row count.

**Unsettled:** interactive TTY behaviour could not be verified from inside the agent harness
(`process.stdout.isTTY` false, `setRawMode` absent — an artifact of piping, not of Windows).
The real terminal is Windows Terminal with `TERM=xterm-256color`, which is why the Rust
binary's 256-colour SGR rendered correctly. Note opencode ships a dedicated `./terminal-win32`
module — evidence that Windows TTY needs care, and that it is solvable.

---

## 4. Model-catalogue libraries — lists vs metadata

**Public catalogues give both lists AND metadata, but only for 31 of 48 providers.**

- **models.dev `api.json`**: **212 providers / 7,502 models**. It *does* enumerate per provider (`json[provider].models` is a map). **Cost on 7,066/7,502, context on 7,368/7,502**, plus `modalities`, `reasoning`, `tool_call`, `release_date`. Provider records carry `api` (base URL) and `env`. Covers **29/48** of these providers, including obscure ones — orcarouter (117), zenmux (120), kilo (363), venice (101), agnes (3), agentrouter (3), aihubmix (77), chutes (14), gmicloud (15), inferx (12). Repo `anomalyco/models.dev`, MIT, pushed today, 6,682 stars.
- **`@opencode-ai/models` 0.0.62** (2026-09-02, MIT, **zero runtime deps**): a thin typed client; `dist/client.js` is **2.4 KB**, stateless, "nothing is ever cached". Real value-add is `./snapshot`, a bundled 5.3 MB offline copy. Endpoints `/api.json`, `/models.json` (294 KB), `/catalog.json` (4.7 MB).
- **LiteLLM** `model_prices_and_context_window.json` — 2.0 MB, **3,518 entries / 130 providers**; each entry carries `litellm_provider`, so per-provider lists *are* derivable. **But it fills only 2 of the 19 models.dev gaps** (`nscale`, `you_com`).
- **`tokenlens`** 1.3.1 (2025-09-19, MIT, 740k/wk) — real, syncs from models.dev, but id-lookup only; no `getModelsByProvider`.
- **`llm-info`** 1.0.69 (2025-12-16, MIT, zero deps, 7.4k/wk) — covers only 8 providers. Too narrow.
- **`@ai-sdk/gateway`** 4.0.72 (2026-09-02, Apache-2.0, 22M/wk) — `getAvailableModels()` is a *live call* returning Vercel's own curated roster, not per-upstream enumeration.
- **OpenRouter `/api/v1/models`** — 421 models live, 18 tagged `:free`.
- **Do not exist on npm:** `ai-models`, `llm-model-list`, `model-list`. **`modelfusion`** exists but last published 2024-02-24 — abandoned.

### The finding that changes the design

**All three sources are already pre-merged, on disk, and already wired into keysync.**

`…\@musistudio\claude-code-router\dist\models.json` — 19.7 MB, `schemaVersion: 2`, generated
2026-08-24:
- **4,298 models across 217 providers**
- `sources`: **litellm + models.dev + openrouter** — exactly the three you would pick
- 10,176 raw records deduped into 4,298 (**5,878 duplicates merged**), 4,078 with pricing
- Normalised per model: `limits.contextTokens`, `limits.outputTokens`, `modalities.input/output`, `capabilities` (12 booleans incl. `reasoning`, `toolCalling`, `imageInput`), `pricing` with a stated `normalizedUnit`
- **`keysync.mjs` already loads it** via `loadCatalog()`

The fetch-three-sources-and-normalise-pricing-units work is **already done**.

### Coverage arithmetic (corrected)

```
vault providers:                                    48
  of which OpenAI-protocol (GET /models works):     44
covered by models.dev ∪ LiteLLM:                    31
UNCOVERED by any public catalogue:                  17
```

The 17: `tokenharbor, routllm, nararouter, teamorouter, fanar, pollinations, llm7, aionlabs,
bigmodel, tabiai, gorouter, bai, commandcode, bluesminds, nousresearch, indeedwebid, seekai`

(An earlier estimate said 23; measured is 17.)

### Live fetch is cheaper than assumed

**44 of 47 use `protocol: "openai"` with `Authorization: Bearer {key}`** — so
`GET {baseUrl}/models` covers almost everything. Only 3 exceptions (anthropic; githubcopilot
and youcom are `generic` and already excluded by `filterRegistry`).

Two uncovered providers tested live, without keys:
- **pollinations** → 200, **362 models**, fields include `pricing`, `context_length`, `input_modalities`, `output_modalities`, `capabilities`
- **llm7** → 200, **44 models**, fields include `tier`, `pricing`, `context_window`, `modalities`, `reasoning`, `tools_calling`

**So the providers no catalogue covers return the metadata themselves.** This is precisely
why `infer_tier`'s "scan any field whose name contains `pric`/`cost`, at any nesting depth,
numbers or numeric strings" heuristic was written that way. The catalogue is an *enrichment*
layer for providers whose `/models` is bare (OpenAI's returns only `id`/`created`/`owned_by`),
not the primary source.

---

## 5. Existing "pick a model" CLIs — nothing wrappable

| Project | Lang | Licence | Stars | Last push | Verdict |
|---|---|---|---|---|---|
| `anomalyco/opencode` | TypeScript | **MIT** | 203,139 | 2026-09-02 | Closest match |
| `charmbracelet/crush` | Go | **NOASSERTION** | 27,857 | 2026-09-02 | **Licence risk** — source-available, not OSI |
| `charmbracelet/mods` | Go | MIT | 4,524 | 2026-03-09 | **ARCHIVED** |
| `sigoden/aichat` | Rust | Apache-2.0 | 10,416 | 2026-02-23 | Welded into the app |
| `simonw/llm` | Python | Apache-2.0 | 12,449 | 2026-09-01 | `llm models` is a flat printer |

**opencode, examined directly:**
- `packages/opencode/src/cli/cmd/models.ts` — `opencode models [provider]` is a **non-interactive flat printer** (`process.stdout.write(providerID + "/" + modelID)`).
- `packages/tui/src/component/dialog-model.tsx` (6.5 KB) — Solid on `@opentui/solid`, filtering via `fuzzysort`. **It passes `flat={true}`** — a flat, *categorised* list (provider name as a category header), not a two-level drill-down. Two-level-ness is faked by dialog replacement (`DialogProvider` ↔ `DialogModel(providerID)`).
- `packages/tui/package.json` is **`"private": true`** — not on npm. Vendoring means lifting source out of a Bun-first monorepo using `catalog:` deps, `bun test` and `tsgo`.

**Nothing suitable found** as a drop-in. No npm/crates package renders a provider→model picker
over a user's own key set. Transferable: (a) the `@opentui` + `fuzzysort` stack choice,
validated at 203k-star scale, and (b) MIT licensing that makes reading `dialog-select.tsx` for
layout ideas legally clean.

---

## 6. Recommendation — ~550 new lines, one new dependency

### Avoid entirely (0 lines)
- **Maestro code** — no import, no shell-out. Read `model_cache.json` only as an offline seed.
- **Catalogue fetch/merge/normalise** — CCR's `models.json` already merges models.dev + LiteLLM + OpenRouter with pricing, context and modalities. Add a refresher that re-pulls models.dev `api.json` when CCR's snapshot ages out.
- **`ui.rs` (631 lines)** — the buggy module; discard rather than fix.
- **blessed / neo-blessed / ink-table / enquirer / inquirer prompts** — dead or wrong shape.

### Reuse as-is (0 lines)

| Asset | Gives |
|---|---|
| `keysync.mjs` `loadVault()`, `filterRegistry()`, `chooseKeys()`, `loadCatalog()` | Vault read with BOM strip, exclusion rules, multi-key tie-breaks, catalogue load — **already written and tested** |
| CCR `dist/models.json` | 4,298 models / 217 providers, pre-merged, pricing + context + modalities |
| `~/.llmkeys/providers.json` | `baseUrl` + `protocol` + `headersTemplate` for 47 providers — the fetch spec |
| `fuzzysort` 4.0.2 (MIT, zero deps) | Filter engine, better than substring |
| `@opentui/core` + `@opentui/react` (MIT) | Renderer — verified importing on Node v25 / Windows x64 |

### Write fresh (~550 lines)

| Component | Est. | Notes |
|---|---|---|
| Live `/models` fetch loop | ~60 | 44 providers, one shape |
| Merge live lists ← catalogue metadata | ~80 | Live gives lists; catalogue enriches; live wins on availability |
| Tier inference | ~40 | Port `infer_tier` + `scan_numeric` **verbatim in behaviour**, carrying the comments — **keysync's current `inferTier` only checks 4 named fields and will misclassify the nested/array/string-number shapes** |
| Cache + TTL | ~40 | Own file under `~/.uw/`; do not write Maestro's |
| Two-level menu state | ~120 | Port `FilterList` + `ModelMenu` + `window_for` + the Esc ladder |
| Render + key loop | ~150-200 | OpenTUI, or plain ANSI for zero deps |

Plus a `package.json` (keysync has none today).

### The one decision worth spiking first

**Zero-dep ANSI vs OpenTUI.** keysync is currently dependency-free loose `.mjs`. A hand-rolled
renderer keeps that property and is ~200 lines — the Rust binary's captured output shows
exactly the target frame (box-drawing + 256-colour SGR), so it is a transcription job.
OpenTUI saves those 200 lines and gives flexbox layout, at the cost of a native binary and a
`node_modules`. Import verified on Node 25/Windows; **interactive rendering not verified** —
a 30-minute spike in a real terminal should settle it.

### What NOT to do

Finish the Rust binary. It requires fixing a non-terminating loop plus an off-by-one in the
module you would otherwise throw away, then writing the entire catalogue-fetch layer in Rust
(`http.rs` is 42 lines and does nothing yet), then building a Node↔Rust bridge and a
per-platform build/distribution story — all to reuse ~200 lines of logic that ports to JS in
an afternoon, while the data layer already exists in Node.

## Key file references

- `~/.uw/prior-art/uw-rust-tui/src/ui.rs:186` — non-terminating `loop`; the "only ever shrinks" invariant is false
- `~/.uw/prior-art/uw-rust-tui/src/ui.rs:242` — `wrapped_height`, off-by-one
- `~/.uw/prior-art/uw-rust-tui/src/model_tier.rs:62` — `infer_tier`, 52 lines, port this
- `~/.uw/prior-art/uw-rust-tui/src/menu.rs:41` — `FilterList`, port this
- `~/.uw/keysync/keysync.mjs:21-100` — `loadVault`/`filterRegistry`/`chooseKeys`/`loadCatalog`/`inferTier`
- `…\claude-code-router\dist\models.json` — the pre-merged catalogue
- `~/.llmkeys/providers.json` — 44/47 OpenAI-protocol, the fetch spec
- `…\maestro\harness\src\backend\discovery.rs:519` — `CacheEntry`; `:566` foreign-entry preservation

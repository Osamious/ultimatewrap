# Phase 6 research — index

Twelve parallel research agents, 2026-09-02, on the UltimateWrap model-catalogue and menu
design; reports 14-16 were added later, 16 on 2026-09-04. These files are the **reconstructed agent reports**, written from the returned
results — the raw `.output` transcripts in `%TEMP%` were **0 bytes for every agent but one**,
so this directory is the record.

The working distillation, with running conclusions, is
`~/.uw/keysync/phase6-design-notes.md`.

| # | File | What it settles |
|---|---|---|
| 01 | `01-provider-api-shapes.md` | All 47 providers: baseUrl, protocol, auth, listing endpoint, testModel, flags. **7 call-shape clusters; 41 of 47 through one code path.** Data-quality issues in the vault |
| 02 | `02-free-detection.md` | Per-provider free/paid determinability. The **New-API `/api/pricing`** discovery and its `quota_type` landmine. Precedence order and the blank-not-false rules |
| 03 | `03-ccr-capabilities.md` | CCR internals: discovery loop, `autoFetchModels` merge, `resolve()`'s five stages, `/v1/models` shapes, the bundled catalogue, **all 64 RPC methods** |
| 04 | `04-claude-code-picker.md` | The `/model` picker read from the binary: disabled search, 10-row cap, 60% label truncation, the +2 explained, `behavesAs`, gateway discovery, every extension point |
| 05 | `05-handoff-and-information-architecture.md` | **The decisive report.** Router-is-restart-free confirmed; `CUSTOM_ROUTER_PATH` as the better handoff; and the evidence that a **flat list beats a two-level menu** |
| 06 | `06-maestro-implementation.md` | Maestro's working two-level menu, `/model refresh`, `infer_tier`, the shared vault — and what not to copy |
| 07 | `07-prior-art-survey.md` | models.dev vs LiteLLM head-to-head; OpenRouter/aider/llm/opencode/crush/cline/Roo patterns; Miller columns; fuzzy-filter library comparison |
| 08 | `08-security-review.md` | 13 findings. **CRITICAL: remote model lists are a routing-hijack primitive.** Plus logging, settings integrity, SSRF, terminal-escape injection |
| 09 | `09-build-avoidance.md` | What can be reused instead of written. **The rescued Rust crate has a non-terminating loop.** npm survey with live figures. ~550 new lines recommended |
| 10 | `10-upgrade-resilience.md` | **CC auto-updates.** The already-patched CCR binary. The coupling register (P0/P1/P2), the capability-probe layer, the `models.json` migration |
| 11 | `11-refresh-architecture.md` | Three-tier refresh (free metadata / keyed lists / paid verification), partial-failure merge policy, snapshot cache design, locking |
| 12 | `12-uw-pipeline-audit.md` | Inventory of the current keysync pipeline, the dead `inferTier` proven empirically, and 14 gaps |
| 13 | `13-tui-toolchain.md` | fzf on Windows: the `$SHELL` fork, `--with-shell`, dual renderers, `--listen`; Ink's Windows repaint landmine; what is dead |
| 14 | `14-quota-billing-and-display.md` | 47 providers x 20 candidate paths with a control probe and an invalid-key pass: which quota/billing endpoints exist and which credential each accepts |
| 15 | `15-zero-token-switching.md` | Zero-token, user-driven switching inside CC. Why MCP elicitation, slash commands and the conversational design are all disqualified |
| 16 | `16-harness-context-management.md` | **Ten harnesses read at source** on context windows and compaction. The unknown-model split (guess vs refuse), absolute buffers over percentages, the confirmed negative that **nobody parses the limit out of the error text**, and Roo's per-endpoint fix for the aggregator problem. Measures UW's own catalogue: 98.5% text-model coverage against live models.dev, a live 4x over-declaration in the picker, and **probe P6 answered** |

Also preserved: `~/.uw/prior-art/uw-rust-tui/` — the complete Rust crate rescued from a
`%TEMP%` scratchpad that would have been swept, including the **working** `model_tier.rs`
(the tier inference the JS version gets wrong).

## The three findings that most change the design

1. **A two-level menu cannot be built inside Claude Code** (04), but it does not need to be:
   Router rules repoint a stable alias with **no gateway restart and no relaunch**, and CCR
   **echoes the requested model back**, so the alias survives end-to-end and CC never learns
   the resolution (05).
2. **The usage data argues against the requested shape.** 1,019 requests, 26 distinct models,
   **top 5 = 91.3%**. A two-level menu taxes the 91% case to serve a rare one, and the
   hierarchy is already encoded in the `provider/model` string (05).
3. **Fixing `inferTier` arms a routing hijack** (08, 12). The denylist must land first. This is
   the clearest case in the whole pass of a correctness fix being a security regression if
   sequenced wrongly.

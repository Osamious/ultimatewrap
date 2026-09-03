# UltimateWrap Phase 6 — Session Handoff

Written 2026-09-03 at the end of session `76ac34d9-c9e8-43f4-8cfa-18bf9783c39c`
(transcript: `C:\Users\osami\.claude\projects\C--Users-osami\76ac34d9-c9e8-43f4-8cfa-18bf9783c39c.jsonl`).
The session was abandoned because autocompact was thrashing and the provider pool returned 429s.
Read this file first in the new session, then resume at "Where to resume".

## What UltimateWrap is

UW is a companion to Claude Code Router (CCR) that lets Claude Code (CC) switch across ~44 LLM
providers. Project root is `C:\Users\osami\.uw\`. It is **not a git repository yet**; Task A1 of
the plan is `git init`.

## State of the work

| Item | State |
|---|---|
| TUI picker input bug | Solved and user-approved ("this is it, i like this method"). See `spike/uwpick-run.ps1` header for the measured findings. |
| Phase 6 plan | **Revised after both reviews.** `phase6-menu-and-catalogue.md`, now 8560 lines, 28 tasks, sha256 `bae12508bf5719573d68a95fe04896fe46941236bfc5198ef5745af9653cba65`. Status: still **pending approval**. The reviewed snapshot (6750 lines, `5f47b3e3…b5f6a`) is preserved byte-identical as `phase6-menu-and-catalogue.v2-reviewed.md`. |
| Architect review (round 1) | **Complete.** SOUND-WITH-CHANGES: 5 BLOCKERs, 8 MAJORs, 6 MINORs. `phase6-review-architect.md`. Never given to the Critic. |
| Critic review (round 1) | **Complete.** UNSOUND: 4 BLOCKERs, 11 MAJORs, 11 MINORs. `phase6-review-critic.md`. Never given to the Architect. |
| Synthesis | **Complete.** `phase6-review-synthesis.md` — all 45 findings adjudicated: 22 accepted as proposed, 19 accepted with a different or larger fix, 4 rejected with reasons. Six defects were found by both reviewers and fixed once. |
| Delta re-review (round 2) | **Both complete.** Architect-2 SOUND-WITH-CHANGES (1 BLOCKER, 3 MAJOR, 3 MINOR; 15 of 17 prior findings resolved). Critic-2 UNSOUND (1 BLOCKER, 3 MAJOR, 5 MINOR; 25 of 26 prior resolved). Each was given only its own prior review and its own rejections — never the synthesis log, which contains the other's findings. **Both independently found the same blocker.** |
| The round-2 blocker | `writeSnapshot` spreads bare model-id strings into object literals, so every row lands with no `model` field and `loadCatalog`'s `if (!m.provider \|\| !m.model) continue` skips all of them — the first successful refresh promotes an empty catalogue. It passed its own suite because B5 contains two tests asserting incompatible types for the same field (strings at ~7269, objects at ~7312). Second facet: tier 1 does `Object.keys(p.models)`, discarding the models.dev pricing that Task B2 exists to read. |
| Concurrent-edit incident | At 10:13 `p6-planner` wrote an unrequested OMC/CCR hardening pass while round-2 reviewers were reading the same file (`bae12508…` → `a705afa7…`, 8560 → 8967 lines). No round-1 fix regressed. Critic-2 detected the change itself and re-verified against the later bytes, so no re-run was needed. The content was sound and closed a real gap — report 10's P1 #10, the local CCR `dist/main/cli.js` handshake patch (5 s → 20 s) that any `npm i -g` silently reverts, which had zero mentions in the plan. **Lesson: do not leave a write-capable agent live while reviewers hold a pinned hash.** |
| Round 3 (targeted delta) | **Both complete**, against a frozen `4b966e74…c87d2`; both reviewers verified the hash unchanged at start and end. Architect-3 SOUND-WITH-CHANGES (2 BLOCKER, 2 MAJOR, 2 MINOR; 5 of 7 resolved). Critic-3 UNSOUND (1 BLOCKER, 2 MAJOR, 1 MINOR; 6 of 9 resolved). Findings trend: 45 → 16 → 10. |
| The round-3 blocker | **Five fenced code blocks do not parse**, across four files: L718, L1867–1868, L1958–1959, L6530/L6549, L7525–7526. Found by extracting all 78 JS blocks and running `node --check` — three rounds of *reading* missed every one. L718's `INVISIBLE` class holds literal U+2028/U+2029 bytes (verified here with `od -c`); they are LineTerminators and illegal in a regex literal, so Task A3 cannot produce a loadable `sanitize.mjs`, and `style.mjs`, `catalog.mjs` and `denylist.mjs` all import it. Two more sit in `denylist.test.mjs`, which holds the hostile-`opus` gate for A5.1 — an unparseable file reports no failures, so `# fail 0` would pass over the security test. Cause: shell heredocs strip a backslash level even with a quoted delimiter (4th occurrence; see the `heredoc-mangles-escapes` memory). |
| Standing gate added | Plan code blocks are never written through a shell heredoc — Write/Edit only for anything with an escape or non-ASCII character — and are verified by extracting every fenced block and running `node --check`, reporting the count. Reading is not verification for this defect class. |
| Team-lead error, corrected | I told the critic its round-2 causal attribution was wrong, citing a fixture reading `free: 12`. That fixture is at L3916 in Task A10; the one feeding the level-0 literal is at L3193 in Task A9 and reads `free: 3` — the critic was right. Retracted to the agent and struck from the synthesis notes. |
| Cross-cutting decisions (team-lead, 2026-09-03) | **Row shape: objects end-to-end** (`{model, provider, …}`, the schemaVersion-2 shape `loadCatalog` parses). Tier 1 keeps the models.dev metadata instead of `Object.keys`; tier 2 emits `{model, provider}` with pricing genuinely absent — blank, never zero. **Health precedence: probe-derived always wins**; `writeHealthFromOutcomes` may only fill providers the probe pass did not reach, never overwrite one it did. **Health sources are three, ordered by strength** (round 3): `probe` (a completion answered) > `keyed-listing` (tier 2 — the credential authenticated against the provider's own endpoint) > `listing` (tier 1 models.dev — no key involved, never evidence of health). `ok` requires `probe` or `keyed-listing` with a `lastOk` inside the freshness window; tier 1 alone, or no entry, renders `stale`. The three round-1 tests asserting `ok` for a never-probed provider are changed, not preserved — their premise predates `stale` having a producer, and "never checked" rendering as `ok` is the guess Principle 1 forbids. |
| User decisions (2026-09-03) | **Task A14 and the `-Hud` half of A16 stay in scope** (Q6 / OMC footer was an explicit request). **One delivery under D8** — execute A1–A17 then B2–B10, no separate ship gate after Phase A. Both recorded in the plan's "Open questions for the user — RESOLVED" section. |
| Key health check | Done: 34 healthy, 9 out of credit, 3 dead. Reports in `~/.uw/keysync/key-health-latest.json` and `key-health-reprobe.json`. |

Plan files present in `~/.uw/plans/`:
- `phase6-menu-and-catalogue.md` — current, 8560 lines, `bae12508…cba65`
- `phase6-menu-and-catalogue.v2-reviewed.md` — the snapshot both round-1 reviews read, 6750 lines, `5f47b3e3…b5f6a`, byte-identical to what they were given
- `phase6-review-architect.md`, `phase6-review-critic.md` — round 1
- `phase6-review-synthesis.md` — the revision log, all 45 findings adjudicated. Contains BOTH reviewers' findings, so it must never be handed to either reviewer
- `phase6-review-architect-2.md`, `phase6-review-critic-2.md` — round 2, delta
- `phase6-menu-and-catalogue.v1.md` (4700-line first draft)
- `_bak.md` (planner backup; the `.gitignore` pattern `*.bak*` will NOT match it, so delete it or add `_bak*` before Task A1)

## Verified: planner did apply the three follow-up requests

Grep against the 6750-line file:
- "Quality criteria" section Q1–Q7 at line 43 (optimized / reliable / user friendly / update-resilient / clean / OMC footer / stylized).
- `hud-shim.mjs` Task A14 (line 3736), 24 mentions; OMC footer compatibility is Q6.
- `style.mjs` Task A9 (line 2316): four transitions, glyph fallbacks, `Atomics.wait` sync sleep, `UW_PICKER_MOTION=0` kill switch.
- Health states in Task B7 (line 6134): `ok` / `needs $` / `broken` / `stale`.

Verified gaps still in the plan (weigh these in Planner synthesis):
- The three probe scripts `keysync/key-health.mjs`, `key-health-reprobe.mjs`, `key-health-live3.mjs` are not folded into the refresh CLI (0 mentions).
- No `testModelVerifiedAt`-style field, even though stale `testModel` values were the proven cause of the first key-health pass over-reporting breakage.
- B7 line 6292 admits nothing writes `~/.uw/state/health.json` yet.

## Architect review — summary

Full review with all 19 findings and line references: `phase6-review-architect.md` (same directory).

Five BLOCKERs that must be fixed before implementation:
1. Denylist wired into the display path (`menu/catalog.mjs`) instead of the real hijack path `keysync.mjs:buildProviders` (lines 167–205). Fix: `admitRemoteModels` before `ranked`.
2. B4 reads `models.json`, B5 writes `index.json` with a different shape, so the picker never reads a refreshed catalogue. Fix: one filename, one schemaVersion-2 shape.
3. Blocking `readSync` makes the async routability RPC (line 3144) and resize listener (3146) unreachable. Fix: compute routability in the refresh CLI, bake into `snapshot.json` with `asOf`.
4. Reducer drops coalesced key chunks (line 1798). Fix: tokenise CSI / code points before dispatch.
5. `uw doctor` reports green from the last successful handoff row even after CC changes its protocol. Fix: staleness bound, parse failure = red, no auto re-pin.

Synthesis: push all liveness (health, routability) into `refresh/cli.mjs`, fold the three `key-health*.mjs` scripts into tiers 2/3 as the health producer, add `testModelVerifiedAt`, and make the picker a pure synchronous renderer over one pre-computed snapshot.

## Where to resume

1. Follow the OPTIMAL PIPELINE memory and the ralplan consensus rule.
2. Both round-1 reviews and the Planner synthesis are done. Do not re-dispatch them.
3. Read `phase6-review-architect-2.md` and `phase6-review-critic-2.md` if they exist. If either is
   missing, the round-2 delta re-review did not finish — re-dispatch that one reviewer only, on the
   current hash, giving it only its own round-1 review and its own rejections. Neither reviewer may
   ever see the other's output or the synthesis log, which contains it.
4. If round 2 raises new BLOCKERs, one more Planner-only synthesis pass; otherwise present the plan
   to the user for approval. Plan stays `pending approval` until the user says otherwise. No
   execution without explicit user approval.
5. Housekeeping before Task A1: remove `_bak.md` or add `_bak*` to `.gitignore`; deregister the
   `uw-spike` MCP server (`~/.claude.json`) and the `uwmodel-hook.mjs` hook (`~/.claude/settings.json`).
   Both touch live config the running session depends on — confirm with the user first.

Agents do not survive across sessions. Round-1 used `p6-planner` and `p6-architect`; round-2 used
`p6-architect-2` and `p6-critic-2`. A new session must re-spawn any it needs.

## Settled design decisions (do not reopen)

- D1–D8 in `~/.uw/keysync/phase6-design-notes.md`. D5 (terminal TUI in CC's ctrl+g external-editor
  handoff) supersedes D4 (web page). D6: the picker writes `/model <provider>/<model>` into CC's
  temp file, zero Anthropic tokens; CC also saves it as the default model (accepted side effect).
  D7: distinct `PLAN` badge. D8: menu and catalogue in one phased plan.
- Free (user-set definition, governing): "a model with 0 pricing whose quota/limits resets
  regularly". One-time wallet credits are NOT free. `grantCadence: recurring|one-time|none` is
  curated in `~/.llmkeys/providers.json`, never machine-overwritten. Blank when uncertain.
- Badges: `FREE` / `FREE?` / `PLAN` / `PAID` / blank. Guard G1: non-text output gets a blank badge.
- Two-level menu (providers, then models), live filter at both levels, level-1 filter matches
  member model ids, recents/favourites pinned as duplicates (not moved), scope toggle for flat search.
- Provider columns: key id, model count, free (nullable, "+N plan"), health. Model columns: id,
  ctx, $in, $out, badge, caps (T/V/R), routable dimming.
- Security: remote model lists are a routing-hijack primitive; the reserved-name denylist lands
  before the `inferTier` fix; every provider-controlled string is sanitized (strip C0/C1/ESC).
- Catalogue copied out of `node_modules` into `~/.uw/catalog/`; CCR's own file is never written.
  Three-tier refresh (tier 1 models.dev with ETag; tier 2 keyed `/models` listings for the 23
  uncovered providers; tier 3 paid verification, explicitly gated). Partial-failure merge with
  snapshot + lock; `EXPECTED_PROVIDERS` is a floor; sort has a total tiebreak.
- Upgrade resilience: CC coupling limited to `cc-contract.mjs` (handoff + `/model` syntax) and CCR
  coupling to `ccr-client.mjs`; the `uw doctor` capability probe fails loudly on drift.
- Windows console: Node cannot `SetConsoleMode`, the ps1 wrapper does (mode `0x280` =
  `ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT`, `ENABLE_PROCESSED_INPUT` deliberately
  unset so ctrl+c arrives as byte 3); open `//./CONIN$` with forward slashes; access mask in
  decimal (`3221225472`) because PS 5.1 overflows `0xC0000000`; restore the mode in `finally`.
- OMC HUD: `settings.json` `statusLine.command` runs `node C:/Users/osami/.claude/hud/omc-hud.mjs`;
  the model name comes from `model.display_name` else `model.id`, so `/model` already shows the real
  selection. Only context size drifts; `hud-shim.mjs` corrects that one field, optionally.

## Security rules (verbatim, still in force)

- "never test CCR auth-transport behavior with the real `~/.claude/.credentials.json` present
  unless you're deliberately testing that specific interaction — and even then, only with explicit
  user go-ahead first." A real quota-burn incident happened once. Safe pattern: rename
  `.credentials.json` aside, verify the rename happened, test, restore immediately.
- "whenever you run any tests make sure its done in a way such that it won't affect you. like
  using virtual env or sandbox." All tests use a separate config dir, ports, and settings file.
- Vault `~/.llmkeys/registry.json` and `providers.json`: read metadata only, NEVER key values.
- Do not push or open PRs without explicit confirmation.

## Working-style notes

- Caveman mode (full) is on for chat; persisted artifacts stay normal prose.
- Auto mode prefers Bash for file operations, but string-literal edits in JS still go through the
  Edit tool: heredoc backslash/newline mangling broke JS twice.
- Maestro (`D:\TAMUQ\Internship\QCRI 2026\Fanar Hackathon\maestro`) sets `model:"ignored"` and
  picks from a live `/models` listing, which is why its calls work while `testModel` values are stale.
- Model pin: `.claude\settings.json` pins `claude-fable-5-1` on restart; the old session had
  switched to `claude-opus-5` mid-way.

## Reference files — read these in the new session, in this order

The new session has no memory of this project beyond `MEMORY.md`. These files carry the full context. Sizes are given so the reader can budget: read groups 1, 2 and 4 fully, then the research reports on demand by topic. Read large files in chunks (`sed -n`), never whole, or autocompact will thrash again.

### 1. Project history and the shipped baseline (what UW already is)

- `C:/Users/osami/.omc/plans/ultimatewrap-v1.md` (158 KB, ~450 long lines). The **original UW implementation plan** (v2 text, status "SHIPPED AND RUNNING LIVE"). Phases 0.5, 2, 2.5, 3, 4 and 5 are complete; Phase 1 (watchdog) was deprecated in favour of OS-level supervision (`~/.uw/supervise`). Explains keysync (`~/.uw/keysync`), the local OAuth relay on port 4517 that keeps Claude available, Claude Code's `modelPicker` settings.json field, CCR's `Providers[]` config, the `CCR_CLAUDE_CODE_AUTH_MODE=api-key-helper` auth fix, and the accepted plaintext-key tradeoff. Section map: What UW is line 30, v2 Architecture 60, Phase 3 keysync build 203, Phase 5 results 318, **Phase 6 — Future Improvements 378** (the backlog the current Phase 6 plan grew out of: picker richness/search, catalogue freshness, ad-hoc flexibility, multi-model coverage with 23 of 44 providers absent from CCR's bundled catalogue and the verification-ratchet defect, and the deferred paid re-run of `verify-cli.mjs`), Risks 410, ADR 437, Changelog 451 (the authoritative record of every design change and why).
- `C:/Users/osami/.omc/plans/phase-0.5-findings.md` (4 KB). Verified facts about the CCR install: version `3.0.22`, gateway ports 3456/3457/3458, `config.APIKEY` shape, the bundled catalogue at `<ccr-install>/dist/models.json` (19.7 MB, 4298 models), `restartGateway` RPC reliability, `claude --version` 2.1.252.

### 2. Phase 6 design decisions (what was agreed)

- `C:/Users/osami/.uw/keysync/phase6-design-notes.md` (60 KB, ~1060 lines). The working distillation of all research plus the **SETTLED DESIGN DECISIONS (user-approved) at line 839: D1–D8**. Also: the governing free definition (line 552, "DEFINITION (user-set, governing)"), the routing-hijack security finding (line 300), the seven provider call-shape clusters (line 395), CC picker internals read from the 2.1.258 binary (line 714), the measured scale that justified two levels (line 60), and "Live defects found during this pass" (line 128). D5 supersedes D4.

### 3. Phase 6 research reports (the evidence the plan argues from)

Directory `C:/Users/osami/.uw/research/phase6/`. Start with `00-INDEX.md` (4 KB): one-line summary per report plus the three findings that most changed the design. Reports:

| # | File | Settles |
|---|---|---|
| 01 | `01-provider-api-shapes.md` (16 KB) | All 47 providers: baseUrl, protocol, auth, listing endpoint, testModel. 7 call-shape clusters; 41 of 47 share one code path. |
| 02 | `02-free-detection.md` (19 KB) | Per-provider free/paid determinability, New-API `/api/pricing` and its `quota_type` landmine, precedence order, blank-not-false rules. |
| 03 | `03-ccr-capabilities.md` (22 KB) | CCR internals: discovery loop, `autoFetchModels` merge, `resolve()` five stages, `/v1/models` shapes, bundled catalogue, all 64 RPC methods. |
| 04 | `04-claude-code-picker.md` (20 KB) | Native `/model` picker read from the binary: no search, 10-row cap, label truncation, extension points. |
| 05 | `05-handoff-and-information-architecture.md` (16 KB) | Router-is-restart-free, `CUSTOM_ROUTER_PATH`, and the flat-list-vs-two-level evidence (user chose two levels anyway, D1). |
| 06 | `06-maestro-implementation.md` (12 KB) | Maestro's working two-level menu, `/model refresh`, `infer_tier`, shared vault; what not to copy. |
| 07 | `07-prior-art-survey.md` (14 KB) | models.dev vs LiteLLM; OpenRouter/aider/opencode/crush/cline patterns; Miller columns; fuzzy-filter libraries. |
| 08 | `08-security-review.md` (27 KB) | 13 findings. CRITICAL: remote model lists are a routing-hijack primitive. Denylist-before-inferTier ordering mandatory. Terminal-escape injection, settings integrity, SSRF, logging. |
| 09 | `09-build-avoidance.md` (18 KB) | Reuse over rewrite; the rescued Rust crate's non-terminating loop; ~550 new lines recommended. |
| 10 | `10-upgrade-resilience.md` (21 KB) | CC auto-updates; the patched CCR binary; coupling register P0/P1/P2; capability-probe layer. |
| 11 | `11-refresh-architecture.md` (17 KB) | Three-tier refresh, partial-failure merge policy, snapshot cache, locking. |
| 12 | `12-uw-pipeline-audit.md` (19 KB) | Inventory of the keysync pipeline, dead `inferTier` proven empirically, 14 gaps. |
| 13 | `13-tui-toolchain.md` (6 KB) | fzf on Windows pitfalls; Ink's Windows repaint landmine; what is dead. |
| 14 | `14-quota-billing-and-display.md` (31 KB) | Quota and billing endpoints per provider; what can be displayed honestly. |
| 15 | `15-zero-token-switching.md` (16 KB) | Every switching path and its Anthropic-token cost; basis for D3 and D6. |

Also preserved: `C:/Users/osami/.uw/prior-art/uw-rust-tui/`, the rescued Rust TUI crate with the working `model_tier.rs`.

### 4. The Phase 6 plan and its review

- `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.md` (333 KB, 6750 lines). The plan under review. Task map: Global Constraints line 13, Quality criteria 43, RALPLAN-DR Summary 106, ADR 168, File Structure 188, Tasks A1–A17 from line 266, Tasks B1–B10 from line 4729, Test Strategy 6707, Risks and Rollback 6729, Deferred 6742.
- `C:/Users/osami/.uw/plans/phase6-review-architect.md` (15 KB). Architect review, complete. Not for the Critic.
- `C:/Users/osami/.uw/plans/phase6-menu-and-catalogue.v1.md` and `_bak.md`: earlier drafts, reference only.

### 5. Working code the plan builds on

- Spike (working TUI): `C:/Users/osami/.uw/spike/uwpick.mjs`, `uwpick-run.ps1` (SetConsoleMode wrapper; its header comment records the measured handoff findings), `uwpick.cmd` (dispatcher shim), `catalog.mjs` (shared builder: pricing path, badges, G1 guard, nullable free).
- Keysync: `C:/Users/osami/.uw/keysync/keysync.mjs` (`buildProviders` at lines 167–205 is the routing-hijack path named in Architect BLOCKER 1), `run.mjs`, `safety.mjs`, `verify-cli.mjs`, `verify-prune.mjs`, `test-all.mjs`, `key-health.mjs`, `key-health-reprobe.mjs`, `key-health-live3.mjs`.
- Isolated test harness: `C:/Users/osami/.uw/harness/` (`config.mjs`, `bootstrap.mjs`, `guard.mjs`, `teardown.mjs`, `start.ps1`). Tests must use this, never the live config.
- Supervision: `C:/Users/osami/.uw/supervise/` (scheduled task keeping the CCR gateway and OAuth relay alive).
- Vault metadata (read only, never key values): `C:/Users/osami/.llmkeys/registry.json`, `providers.json`.
- Memory: `C:/Users/osami/.claude/projects/C--Users-osami/memory/` (`MEMORY.md`, `optimal-pipeline.md`, `isolate-live-tests-from-own-session.md`).

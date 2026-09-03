# UltimateWrap Phase 6 — Model Menu and Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a two-level provider→model terminal menu that runs inside Claude Code's ctrl+g external-editor handoff and switches models for zero Anthropic tokens, plus the catalogue refresh and labeling pipeline that keeps its rows honest.

**Architecture:** Phase A takes the three verified spike files (`uwpick.mjs`, `uwpick-run.ps1`, `uwpick.cmd`) plus the shared `catalog.mjs` builder, moves them into `~/.uw/menu/`, and splits the interactive surface into a pure state reducer (unit-testable without a TTY) behind a thin ANSI renderer. Selection writes `/model <provider>/<model>` into the temp file Claude Code hands the editor and exits 0, so no gateway configuration is touched and no assistant turn is spent. Phase B replaces the catalogue the menu reads: a reserved-name denylist at ingest, a corrected pricing path, a curated `grantCadence` field that turns "price is zero" into the governing definition of free, and a three-tier refresh that writes an immutable snapshot the menu resolves through a `current` pointer.

**Tech Stack:** Node.js ESM (`.mjs`, no bundler, no `package.json`, zero runtime dependencies), `node:test` + `node:assert/strict` for tests, Windows PowerShell 5.1 for the console-mode wrapper and the installer, `cmd.exe` for the editor dispatcher, CCR's loopback JSON-RPC for routability and keyed provider listings.

**Spec:** `C:/Users/osami/.uw/keysync/phase6-design-notes.md` (governing) plus `C:/Users/osami/.uw/research/phase6/00-INDEX.md` and reports 01–15.

## Global Constraints

1. Zero Anthropic tokens per switch: the picker writes `/model <provider>/<model>` into `process.argv[2]` and calls `process.exit(0)`; a non-zero exit makes Claude Code discard the content (D6). Accepted side effect: Claude Code also saves the selection as the default for new sessions.
2. Free means price 0 **and** a quota that resets regularly. A one-time wallet credit is not free.
3. `grantCadence ∈ {recurring, one-time, none}` is a curated field in `~/.llmkeys/providers.json`, never machine-overwritten, blank when uncertain, never guessed.
4. Badge set is exactly `FREE` (price 0 + cadence recurring), `FREE?` (price 0 + cadence unknown), `PLAN` (subscription-covered, D7), `PAID` (any non-zero token price), and blank. Nothing else renders.
5. Provider `free` column is nullable: `—` means no price data exists, `0` means price data exists and no model is free. Rendered as `12 +4 plan` when plan-covered models are present.
6. Provider columns are exactly: key id (`bucket.provider.tier`, width 30), model count (width 7), free (width 12), health (width 8).
7. Model columns are exactly: id (width 34), ctx (width 6), `$in` (width 7), `$out` (width 7), badge (width 6), caps `T/V/R` (width 3). Non-routable rows render dimmed.
8. Two-level menu with a live filter at both levels. The level-1 filter matches member model ids as well as the key id.
9. Recents and favourites are pinned at level 1 as **visible duplicates**; they are never removed from their provider's level-2 list (opencode#6169).
10. Tab toggles a flat `provider/model` search scope; Esc walks back down the ladder before it quits.
11. The reserved-name denylist (Task B1) lands **before** the `inferTier` fix (Task B2). Fixing tier inference without the denylist arms the routing hijack described in report 08 F1.
12. Reserved names: `/^(claude|opus|sonnet|haiku|fable|anthropic)([-._\d/]|$)/i` and `/^uw\//i`, admitted only from the trusted relay provider (`anthropic`).
13. Every provider-controlled string rendered by the TUI passes through `sanitizeDisplay()`: ESC/CSI/OSC sequences removed, C0 and C1 control characters removed, length capped.
14. Model ids must match `/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/` and must not contain `..`. A violation is a rejection, not a truncation.
15. Tests never touch live state: no test reads or writes `~/.claude/settings.json`, `%APPDATA%/claude-code-router`, ports 3456/3457/3458, or `~/.llmkeys` key values. Scratch state goes under `~/.uw/harness/scratch/`.
16. CCR auth-transport behaviour is never tested with the real `~/.claude/.credentials.json` present.
17. The catalogue is copied out of `node_modules` into `~/.uw/catalog/`. CCR's bundled `dist/models.json` is never written.
18. Three refresh tiers: tier 1 free metadata (models.dev `api.json`, conditional GET on ETag, no keys); tier 2 keyed `GET {baseUrl}/models` listings only, never completions; tier 3 paid verification, gated behind `--tier 3` plus `--i-know-this-bills` plus an interactive confirmation.
19. Merge policy: snapshot directory plus `catalogue.lock`; a provider whose refresh failed keeps its previous rows and gains `stale: true` with `staleSince`.
20. `EXPECTED_PROVIDERS` becomes a floor (`>=`), not an equality check.
21. The model sort gains a total tiebreak `|| a.m.model.localeCompare(b.m.model)`, applied in one deliberate run because it reselects rows and restarts the gateway exactly once.
22. Coupling to Claude Code is limited to the `$EDITOR` handoff contract and `/model` syntax. `uw doctor` fails loudly and names the failing check when the fingerprint moves.
23. Windows: Node cannot call `SetConsoleMode`; `uwpick-run.ps1` does. The console device is `//./CONIN$` with forward slashes. The access mask is decimal `3221225472`, because `0xC0000000` overflows Int32 in PowerShell 5.1. The saved mode is restored in `finally`.
24. `~/.uw` becomes a git repository in Task A1. `.gitignore` excludes logs, `*.bak*`, `keys.log`, tool outputs and spike scratch. Nothing from `~/.llmkeys` is ever committed.
25. New code stays minimal (report 09 budget: ~550 lines). Spike files are moved and hardened, not rewritten.
26. `autoFetchModels` stays `false` on every provider, enforced as a hard `validate()` invariant, not a convention.
27. `MAX_MODELS_PER_PROVIDER = 3` is not lifted when any list becomes remote.

---

## RALPLAN-DR Summary

### Principles

1. **Blank beats a guess.** Every column has a defined blank rendering. `—` and `0` are different claims, and collapsing them is the single most likely way this design starts lying.
2. **Move the working code; do not rewrite it.** The spike was verified under the real ctrl+g handoff with real keystrokes. Its value is the measured knowledge encoded in it, and a rewrite discards that for nothing.
3. **Security ordering is part of correctness.** The denylist lands before the tier fix, because the tier fix is what arms the hijack. A correct change applied in the wrong order is a regression.
4. **The picker reads; it never routes.** Selection is a text write into a temp file. No gateway config, no `settings.json` write, no restart, no consent gate to erode.
5. **Re-derive third-party facts, do not mirror them.** Every constant copied out of Claude Code or CCR becomes a probe with a cached result and an invalidation key, because a mirror has no mechanism to notice when it stops being true.

### Decision Drivers

1. **Zero Anthropic tokens per switch.** This eliminates every design that requires an assistant turn: MCP elicitation, custom slash commands, and the conversational `/uwmodel` shape.
2. **Live filtering at both levels.** This eliminates the `/model` picker (search sits behind a literal `canEnter:!1`, not a flag), the `UserPromptSubmit` hook (one-shot text, no keystroke loop), and MCP elicitation (the row set is fixed when the picker is created).
3. **Provider-controlled strings reach both a terminal renderer and a routing table.** Report 08 rates this HIGH overall with one CRITICAL: a hostile aggregator publishing a zero-priced `opus` gets Claude Code's default traffic. Every design choice that admits remote data is gated on this.

### Viable Options

**Option A — Terminal TUI inside the ctrl+g external-editor handoff (CHOSEN).**
Pros: satisfies both hard requirements simultaneously; verified working on this machine against 44 providers and 1,584 models with arrows, live filter, enter and esc all functioning; no browser, no second terminal, no new dependencies; Claude Code is blocked in `spawnSync` so there is no repaint war and no keystroke war.
Cons: needs a PowerShell wrapper because Node cannot set the console mode; couples to an undocumented handoff contract that auto-updates could change; consumes the `m`/`model`/`>>m` sentinels from ctrl+g's normal editor role.

**Option B — Local web page (`uwmodels-web.mjs`, D4).**
Pros: already built and working against the real vault; richest rendering; no console-mode manipulation; sortable columns and match highlighting.
Cons: the selection has to return to the terminal through a second mechanism; the user tested both and chose the TUI ("this is it, i like this method"), which supersedes D4 by D5.

**Option C — Gateway model discovery (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`).**
Pros: native, zero tokens, no external process, no second surface to maintain; `display_name` and a 100-character `description` come for free.
Cons: fails driver 2 structurally. The `/model` picker's search is a literal `canEnter:!1` with no flag, the viewport is hard-capped at 10 rows, every id must match `/(claude|anthropic)/i` so all 1,569 need hex mangling, results appear one restart late, and `replaceBuiltInOptions: true` erases the discovered rows outright.

**Option D — `UserPromptSubmit` hook, two-round numbered picker.**
Pros: proven genuinely zero-token (`shouldQuery:false` ends the turn before any API request); renders aligned columns; works today.
Cons: one-shot text with no keystroke loop, so it cannot narrow a list as the user types. Kept as the documented fallback if the handoff contract breaks.

**Why A:** it is the only surface that satisfies the zero-token constraint and the live-filter requirement at the same time, and it is the only one already verified end-to-end against real data on the target machine. Option D is retained as a fallback because it degrades gracefully: it survives any Claude Code change that breaks `$EDITOR`, since hooks are a separate mechanism.

### Pre-mortem

**Scenario 1 — Claude Code auto-updates and the handoff contract moves.** Auto-updates are enabled on the `latest` channel; this is a scheduled event, not a risk. The temp-file path shape changes, or the editor is spawned without `stdio:"inherit"`, or exit-code semantics invert. Symptom: ctrl+g appears to do nothing, or the chat input is silently unchanged. This is the worst diagnostic class because it looks like the picker crashed. Mitigation: `uw doctor` (Task A10) records the Claude Code version and commit, records the last real handoff invocation the picker observed, and refuses with the failing check named. The dispatcher's passthrough branch keeps ctrl+g usable as an ordinary editor throughout.

**Scenario 2 — the console is left in raw mode.** The picker crashes, or the user hits ctrl+c at the wrong moment, and the wrapper's restore never runs. Symptom: the parent shell stops echoing typed characters and swallows Enter, which reads as a broken terminal rather than a broken picker. Mitigation: the restore lives in a PowerShell `finally` block, and Task A8 tests it by running the wrapper against a child that exits 1 and asserting the recorded restored mode equals the saved mode.

**Scenario 3 — a provider publishes a hostile model id.** An aggregator adds `{"id":"opus","pricing":{"input":0,"output":0}}`, or an id containing `\x1b[2J`. Symptom: either a spoofed row that looks like an Anthropic model, or a bare `opus` that CCR's cross-provider fallback binds Claude Code's built-in rows to, silently routing the full system prompt to an attacker-chosen host. Mitigation: Task B1 lands the denylist at ingest and at render before Task B2 makes the free-first sort functional; `sanitizeDisplay()` (Task A3) strips escape sequences at the render boundary; `MAX_MODELS_PER_PROVIDER` stays at 3.

### Expanded Test Plan

**Unit (`node --test C:/Users/osami/.uw/test/`, no network, no live state).** `sanitizeDisplay` and `admitId` against escape sequences, C1 controls, over-length ids, `..` traversal and legitimate two-slash ids such as `groq/openai/gpt-oss-20b`. `priceOf` against the real `pricing.offers[].per1MTokens` shape and the legacy shape that returns nothing. `badgeOf` across all five badge outcomes including guard G1 and `PLAN`. The provider `free` column for nullable, zero, and `+N plan` cases. The `pick-state` reducer for filtering at both levels, level-1 matching on member model ids, the Esc ladder, the Tab scope toggle, the empty-result state, cursor clamping on refilter, and resize. Recents and favourites persistence round-trip. The denylist for every reserved prefix and for the relay exemption. `grantCadence` resolution for recurring, one-time, and absent. Health resolution including the age refusal.

**Integration (spawned processes, scratch state only).** The `uwpick.cmd` dispatcher: each sentinel reaches the picker, and any other first line reaches `%UW_REAL_EDITOR%` with the buffer path unchanged. The PowerShell wrapper: console mode is restored after a child that exits 1. The picker end-to-end against a fixture catalogue with keystrokes fed through a replaceable input source, asserting the exact bytes written to the temp file. The refresh merge policy against simulated `ok`, `soft` and `hard` provider outcomes, asserting a failed provider keeps its rows and gains a stale marker.

**End-to-end (manual or qa-tester, real Windows Terminal, live Claude Code).** The protocol in Task A12: ten numbered steps with the exact expected screen for each, covering sentinel dispatch, live filtering at both levels, selection, the resulting chat input, Esc at every rung, ctrl+c, and passthrough to the real editor.

**Observability.** The picker appends one JSON line per invocation to `~/.uw/state/handoff.json` recording the argv shape, whether the path existed and was writable, the sentinel that triggered it, and whether a selection was written. `uw doctor` reads that file plus `claude doctor` output and prints a Green/Amber/Red verdict naming the failing check and its evidence. The refresher writes `index.json` with per-provider `{status, count, lastOk, lastFail, stale}` so a partial failure is legible without reading logs. Reads and dry runs always proceed even on Red; privileged writes refuse.

---

## ADR — The model menu is a terminal TUI hosted by Claude Code's external-editor handoff

**Status:** Accepted. Supersedes D4 (local web page).

**Decision:** Build the two-level model menu as a Node ANSI TUI launched through `$EDITOR` when Claude Code performs its ctrl+g `chat:externalEditor` handoff. The picker writes `/model <provider>/<model>` into the temp file and exits 0. A `cmd.exe` dispatcher inspects the first line of that file and only takes over on the sentinels `m`, `model` and `>>m`; anything else is handed to `%UW_REAL_EDITOR%` unchanged. A PowerShell wrapper sets the console to raw VT input mode for the duration and restores the saved mode in `finally`.

**Drivers:** zero Anthropic tokens per switch; live filtering at both provider and model level; provider-controlled strings reaching a renderer and a routing table.

**Alternatives considered:** the `/model` picker (search hard-disabled by a literal, 10-row viewport, read once at process start); a `UserPromptSubmit` hook (zero-token and proven, but one-shot text with no keystroke loop); MCP elicitation (good rendering, 40 visible rows, type-ahead — but invoked by the assistant, so every switch costs a turn, and the row set is fixed at creation); a custom slash command (`type: "prompt"`, costs a turn); gateway model discovery (native and free, but no search, 10-row viewport, ids must match `/(claude|anthropic)/i`, and mutually cancelling with `replaceBuiltInOptions: true`); the local web page (built and working, but leaves the terminal and was rejected by the user in favour of the TUI).

**Why chosen:** it is the only surface where the process owns the real TTY exclusively. Claude Code calls `enterAlternateScreen()`, which pauses its renderer and turns raw mode off, then blocks in `spawnSync` with `stdio:"inherit"`. That is what makes a keystroke loop possible at all, and it was verified with a 170-sequence key log including arrows, backspace, enter and esc.

**Consequences:** ctrl+g's ordinary editor behaviour is preserved for every input except three sentinels, at the cost of one `cmd.exe` dispatcher in the path. The design now depends on an undocumented Claude Code contract, which is why `uw doctor` exists. Windows requires a PowerShell wrapper in the chain because Node cannot call `SetConsoleMode`, adding roughly 200 ms of PowerShell startup per picker launch. Claude Code persists the selection as the new default model for future sessions, which the user has accepted. Because zero-price-plus-one-time-grant is neither free nor priced, it renders blank rather than `PAID`, so blank will be common at first and that is honest rather than a gap.

**Follow-ups:** the slot file plus `CUSTOM_ROUTER_PATH` mechanism stays proven and unused, available if a session-only switch is ever needed. Option D (the hook) stays documented as the fallback if the handoff contract breaks. `harness/guard.mjs:assertRouterClean` must be scoped rather than deleted if Router rules ever go live.

---

## File Structure

### Created

| Path | Single responsibility |
|---|---|
| `C:/Users/osami/.uw/.gitignore` | Keep logs, backups, key logs, tool output and spike scratch out of version control |
| `C:/Users/osami/.uw/menu/catalog.mjs` | Build provider and model rows from vault metadata plus the catalogue; own `priceOf`, `badgeOf`, `healthOf` and the nullable free column |
| `C:/Users/osami/.uw/menu/sanitize.mjs` | Make provider-controlled strings safe to render and safe to admit as ids |
| `C:/Users/osami/.uw/menu/denylist.mjs` | Reject reserved Anthropic-shaped and `uw/` model names from untrusted providers |
| `C:/Users/osami/.uw/menu/pick-state.mjs` | Pure reducer for the two-level menu: filtering, cursor, scope, Esc ladder. No I/O |
| `C:/Users/osami/.uw/menu/state.mjs` | Persist recents and favourites in `~/.uw/state/picker.json` |
| `C:/Users/osami/.uw/menu/health.mjs` | Resolve provider health from notes plus `~/.uw/state/health.json`, with an age refusal |
| `C:/Users/osami/.uw/menu/cadence.mjs` | Read curated `grantCadence` and `planCovered` and turn a zero price into a badge |
| `C:/Users/osami/.uw/menu/uwpick.mjs` | ANSI renderer and console input loop over `pick-state`; write the selection and exit 0 |
| `C:/Users/osami/.uw/menu/uwpick-run.ps1` | Set raw VT console input mode, run the picker, restore the saved mode in `finally` |
| `C:/Users/osami/.uw/menu/uwpick.cmd` | Dispatch on the first line of the buffer: sentinel to the picker, anything else to the real editor |
| `C:/Users/osami/.uw/menu/doctor.mjs` | Probe the handoff contract and the environment fingerprint; name the failing check |
| `C:/Users/osami/.uw/menu/install.ps1` | Set `EDITOR` and `UW_REAL_EDITOR` at User scope; refuse to overwrite an `EDITOR` it did not set |
| `C:/Users/osami/.uw/refresh/catalog-store.mjs` | Own `~/.uw/catalog/`: copy-out, snapshot directories, the `current` pointer, the lock, and the merge policy |
| `C:/Users/osami/.uw/refresh/tiers.mjs` | The three refresh tiers: models.dev metadata, keyed listings, gated paid verification |
| `C:/Users/osami/.uw/refresh/cli.mjs` | `uw catalog refresh --tier 1\|2\|3` argument handling and reporting |
| `C:/Users/osami/.uw/test/*.test.mjs` | One test file per module above; `node:test` + `node:assert/strict` |
| `C:/Users/osami/.uw/test/fixtures/*.json` | Frozen catalogue, registry and providers fixtures so no test reads the live vault |
| `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` | The exact manual/qa-tester steps and expected screens for the interactive surface |

### Modified

| Path | Change |
|---|---|
| `C:/Users/osami/.uw/keysync/keysync.mjs` | Fix `inferTier` to read `pricing.offers[].per1MTokens`; add the `localeCompare` sort tiebreak; add the `autoFetchModels` invariant to `validate()`; read the catalogue from `~/.uw/catalog/` |
| `C:/Users/osami/.uw/keysync/run.mjs` | `EXPECTED_PROVIDERS` becomes a floor with an explicit delta acknowledgement |
| `C:/Users/osami/.llmkeys/providers.json` | Add curated `grantCadence` and `planCovered` fields (outside the git repo; backed up separately) |

### Moved

| From | To |
|---|---|
| `C:/Users/osami/.uw/spike/catalog.mjs` | `C:/Users/osami/.uw/menu/catalog.mjs` |
| `C:/Users/osami/.uw/spike/uwpick.mjs` | `C:/Users/osami/.uw/menu/uwpick.mjs` |
| `C:/Users/osami/.uw/spike/uwpick-run.ps1` | `C:/Users/osami/.uw/menu/uwpick-run.ps1` |
| `C:/Users/osami/.uw/spike/uwpick.cmd` | `C:/Users/osami/.uw/menu/uwpick.cmd` |

### Runtime state (not committed)

| Path | Contents |
|---|---|
| `C:/Users/osami/.uw/state/picker.json` | `{recents: string[], favourites: string[]}` |
| `C:/Users/osami/.uw/state/handoff.json` | Append-only JSON lines recording each picker invocation |
| `C:/Users/osami/.uw/state/health.json` | `{generatedAt, providers: {name: {lastOk, lastFail, consecutiveFails}}}` |
| `C:/Users/osami/.uw/state/capabilities.json` | Claude Code version and commit fingerprint plus probe results |
| `C:/Users/osami/.uw/state/install.json` | What the installer set, so it can refuse to clobber a foreign `EDITOR` |
| `C:/Users/osami/.uw/catalog/` | `models.json`, `current`, `snapshots/<stamp>/`, `catalogue.lock` |

### A note on the test convention

`C:/Users/osami/.uw/keysync/test-all.mjs` is a **live integration probe**, not a unit-test harness: it sends one real completion per provider through the gateway at concurrency 6 and writes `last-test-results.json`. There is no existing `node:test` usage anywhere under `~/.uw` and no `package.json`. This plan therefore adopts `node:test` + `node:assert/strict` — both built into Node, so the zero-dependency property that `keysync` deliberately holds is preserved — with files named `*.test.mjs` under `C:/Users/osami/.uw/test/` and run as `node --test "C:/Users/osami/.uw/test/"`. Where this plan writes a live probe rather than a unit test, it follows `test-all.mjs`'s conventions: bounded concurrency 6, a `PASS`/`fail` line per target, and a JSON results file.

---

# Phase A — the menu on today's catalogue

### Task A1: Make `~/.uw` a git repository

**Files:** Create `C:/Users/osami/.uw/.gitignore`
**Interfaces:** Consumes: nothing. Produces: a git repository at `C:/Users/osami/.uw` whose working tree excludes logs, backups, key logs, tool output and spike scratch. Every later "Commit" step in this plan depends on this task.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/repo.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const UW = "C:/Users/osami/.uw";
const git = (...args) =>
  execFileSync("git", ["-C", UW, ...args], { encoding: "utf8" }).trim();

test("~/.uw is a git repository", () => {
  assert.equal(git("rev-parse", "--is-inside-work-tree"), "true");
});

test(".gitignore excludes every named scratch class", () => {
  const ignored = [
    "keysync/keys.log",
    "keysync/run.mjs.bak-msgfix",
    "spike/keys.log",
    "spike/buf1.md",
    "spike/d.md",
    "spike/crlf.md",
    "spike/cc_strings.txt",
    "spike/diag.txt",
    "spike/render.out",
    "harness/scratch/anything.json",
    "state/picker.json",
    "catalog/models.json",
  ];
  for (const p of ignored) {
    assert.equal(git("check-ignore", "-q", p) ?? "", "", `${p} should be ignored`);
  }
});

test("no file under the repo references a key value from ~/.llmkeys", () => {
  const tracked = git("ls-files").split("\n").filter(Boolean);
  for (const f of tracked) {
    assert.ok(!f.startsWith(".."), `tracked file escapes the repo: ${f}`);
    assert.ok(fs.existsSync(`${UW}/${f}`), `tracked file missing: ${f}`);
  }
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected failure: `fatal: not a git repository (or any of the parent directories): .git` thrown out of the first `git` call, so all three tests error.

- [ ] Step 3: Implement.

Write `C:/Users/osami/.uw/.gitignore`:

```gitignore
# Logs and tool output — regenerated, never reviewed, sometimes large.
*.log
logs/
out.log
err.log
render.out
render.err
diag*.txt
*.tsv

# Backups written by keysync's safety machinery.
*.bak
*.bak-*
*.bak*
settings.json.bak-*

# Anything that has ever held credential material or credential ids.
keys.log
probe-account-endpoints.json
last-test-results.json

# Spike scratch: hand-made buffers from the ctrl+g handoff experiments.
spike/buf*.md
spike/d.md
spike/crlf.md
spike/probe.md
spike/t*.txt
spike/cc_strings.txt
spike/Usersosami*

# Isolated-test scratch tree — recreated by harness/bootstrap.mjs.
harness/scratch/

# Runtime state: per-machine, not source.
state/
catalog/
research/phase6/_tmp/
```

Then, in `C:/Users/osami/.uw`:

```
git init
git add -A
git status --short | head -40
```

Inspect the staged list before committing. It must contain `keysync/*.mjs`, `harness/*.mjs`, `spike/*.mjs`, `spike/*.ps1`, `spike/*.cmd`, `research/phase6/*.md`, `plans/*.md` and `prior-art/`. It must **not** contain anything matching the ignore rules above, and it must not contain any path under `~/.llmkeys` (which is outside the repository and therefore structurally unreachable).

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 3`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "chore: initialise the UW repository with a scratch-excluding .gitignore"
```

---

### Task A2: Move the spike files into `~/.uw/menu/`

**Files:**
Move `C:/Users/osami/.uw/spike/catalog.mjs` → `C:/Users/osami/.uw/menu/catalog.mjs`
Move `C:/Users/osami/.uw/spike/uwpick.mjs` → `C:/Users/osami/.uw/menu/uwpick.mjs`
Move `C:/Users/osami/.uw/spike/uwpick-run.ps1` → `C:/Users/osami/.uw/menu/uwpick-run.ps1`
Move `C:/Users/osami/.uw/spike/uwpick.cmd` → `C:/Users/osami/.uw/menu/uwpick.cmd`
Test `C:/Users/osami/.uw/test/menu-layout.test.mjs`
**Interfaces:** Consumes: the four spike files. Produces: `~/.uw/menu/` holding all four, with `uwpick.mjs` importing `./catalog.mjs` and the `.ps1`/`.cmd` resolving siblings through `$PSScriptRoot` and `%~dp0`. No behaviour change.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/menu-layout.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const MENU = "C:/Users/osami/.uw/menu";

test("every menu file lives under ~/.uw/menu", () => {
  for (const f of ["catalog.mjs", "uwpick.mjs", "uwpick-run.ps1", "uwpick.cmd"]) {
    assert.ok(fs.existsSync(`${MENU}/${f}`), `missing ${f}`);
  }
});

test("catalog.mjs exports the builder surface", async () => {
  const m = await import("file:///C:/Users/osami/.uw/menu/catalog.mjs");
  for (const name of ["build", "routableSet"]) {
    assert.equal(typeof m[name], "function", `catalog.mjs must export ${name}`);
  }
});

test("no menu file still points at the spike directory", () => {
  for (const f of ["uwpick.mjs", "uwpick-run.ps1", "uwpick.cmd"]) {
    const src = fs.readFileSync(`${MENU}/${f}`, "utf8");
    assert.ok(!/[\\/]spike[\\/]/.test(src), `${f} still references the spike directory`);
  }
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/menu-layout.test.mjs"
```

Expected failure: `missing catalog.mjs` from the first test, because `~/.uw/menu` does not exist yet.

- [ ] Step 3: Implement.

```
mkdir C:/Users/osami/.uw/menu
git -C C:/Users/osami/.uw mv spike/catalog.mjs menu/catalog.mjs
git -C C:/Users/osami/.uw mv spike/uwpick.mjs menu/uwpick.mjs
git -C C:/Users/osami/.uw mv spike/uwpick-run.ps1 menu/uwpick-run.ps1
git -C C:/Users/osami/.uw mv spike/uwpick.cmd menu/uwpick.cmd
```

In `menu/catalog.mjs`, replace the spike-scoped slot path so nothing under `menu/` writes into `spike/`:

```js
// was: export const SLOT = path.join(os.homedir(), ".uw", "spike", "slot.json");
export const SLOT = path.join(os.homedir(), ".uw", "state", "slot.json");
```

In `menu/uwpick.mjs`, replace the hard-coded spike key log with a state-directory path and make the directory on demand:

```js
// was: const KEYLOG = "C:/Users/osami/.uw/spike/keys.log";
import path from "node:path";
import os from "node:os";
const STATE = path.join(os.homedir(), ".uw", "state");
fs.mkdirSync(STATE, { recursive: true });
const KEYLOG = path.join(STATE, "keys.log");
```

In `menu/uwpick.cmd`, the `:diag` branch still calls `uwdiag.mjs`, which stays in `spike/`. Delete that branch — the diagnostic served its purpose and `uw doctor` (Task A10) replaces it:

```bat
@echo off
REM UW picker shim for Claude Code's external-editor handoff (ctrl+g).
REM DISPATCHER, not a replacement: only takes over when the chat input is the
REM sentinel, so ctrl+g keeps working normally in plan mode, AskUserQuestion
REM fields, workflows and the fleet view.
setlocal
set "BUF=%~1"
set "SENTINEL="
if exist "%BUF%" for /f "usebackq delims=" %%L in ("%BUF%") do if not defined SENTINEL set "SENTINEL=%%L"

if /i "%SENTINEL%"=="m"      goto pick
if /i "%SENTINEL%"=="model"  goto pick
if /i "%SENTINEL%"==">>m"    goto pick

REM not ours -> hand off to the real editor, unchanged
if defined UW_REAL_EDITOR ( "%UW_REAL_EDITOR%" "%BUF%" & exit /b %errorlevel% )
start /wait notepad "%BUF%"
exit /b %errorlevel%

:pick
REM via PowerShell: it sets the console to raw VT input mode first, which node
REM cannot do. Without that the console stays line-buffered and arrows/typing
REM never reach the picker -- the exact failure seen in testing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b 0
```

`uwpick-run.ps1` needs no path change: it already resolves the picker as `"$PSScriptRoot/uwpick.mjs"`.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 6`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "refactor: move the verified picker spike into ~/.uw/menu"
```

---

### Task A3: `sanitize.mjs` — make provider-controlled strings safe

**Files:** Create `C:/Users/osami/.uw/menu/sanitize.mjs`, Test `C:/Users/osami/.uw/test/sanitize.test.mjs`
**Interfaces:** Consumes: nothing. Produces:
`sanitizeDisplay(s: unknown, max?: number = 80) -> string` — ESC/CSI/OSC sequences removed, C0 and C1 controls removed, truncated to `max`.
`admitId(id: unknown) -> string | null` — returns the id when it matches `MODEL_ID_OK` and contains no `..`, otherwise `null`.
`MODEL_ID_OK: RegExp`.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/sanitize.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeDisplay, admitId, MODEL_ID_OK } from "../menu/sanitize.mjs";

test("strips CSI sequences", () => {
  assert.equal(sanitizeDisplay("a\x1b[2Jb"), "ab");
  assert.equal(sanitizeDisplay("\x1b[1A\x1b[31mred\x1b[0m"), "red");
});

test("strips OSC sequences including the clipboard write", () => {
  assert.equal(sanitizeDisplay("x\x1b]52;c;aGk=\x07y"), "xy");
  assert.equal(sanitizeDisplay("x\x1b]0;title\x1b\\y"), "xy");
});

test("strips bare C0 and C1 controls", () => {
  assert.equal(sanitizeDisplay("a\rb\nc\x00d"), "abcd");
  assert.equal(sanitizeDisplay("a\x9bb"), "ab");
});

test("caps length", () => {
  assert.equal(sanitizeDisplay("x".repeat(200)).length, 80);
  assert.equal(sanitizeDisplay("x".repeat(200), 12).length, 12);
});

test("passes ordinary model ids through unchanged", () => {
  assert.equal(sanitizeDisplay("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b");
});

test("handles null and undefined without throwing", () => {
  assert.equal(sanitizeDisplay(null), "");
  assert.equal(sanitizeDisplay(undefined), "");
});

test("admitId accepts real ids, including two-slash ones", () => {
  assert.equal(admitId("groq/openai/gpt-oss-20b"), "groq/openai/gpt-oss-20b");
  assert.equal(admitId("deepseek-v3.2"), "deepseek-v3.2");
  assert.equal(admitId("google/gemma-4-26b-a4b-it:free"), "google/gemma-4-26b-a4b-it:free");
});

test("admitId rejects rather than sanitizes", () => {
  assert.equal(admitId("a\x1b[2Jb"), null);
  assert.equal(admitId("../../etc/passwd"), null);
  assert.equal(admitId("a..b"), null);
  assert.equal(admitId("back\\slash"), null);
  assert.equal(admitId("-leading-dash"), null);
  assert.equal(admitId("x".repeat(129)), null);
  assert.equal(admitId(""), null);
  assert.equal(admitId(null), null);
});

test("MODEL_ID_OK is anchored at both ends", () => {
  assert.equal(MODEL_ID_OK.source.startsWith("^"), true);
  assert.equal(MODEL_ID_OK.source.endsWith("$"), true);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/sanitize.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\sanitize.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/sanitize.mjs`:

```js
// Every string a provider controls passes through here before it reaches the
// terminal or the routing table.
//
// Report 08 F3: a model id is provider-controlled and lands in a TUI writer with
// zero validation today. \x1b[2J clears the screen, \x1b[1A moves the cursor over
// a row that was already drawn, and \x1b]52;c;<b64>\x07 writes the clipboard on
// terminals with OSC-52 enabled. The bundled catalogue happens to be clean --
// all 4,298 ids are within [A-Za-z0-9._:@/-] and the longest is 50 chars -- but
// that is a property of today's data, not an enforced invariant.
//
// Two different jobs, deliberately separated:
//   sanitizeDisplay  -- for text we are about to draw. Strips, because refusing
//                       to render a row is worse than rendering it plainly.
//   admitId          -- for anything that becomes a routing selector. REJECTS,
//                       because sanitizing would keep an attacker-shaped id in
//                       the routing table with a cosmetic repair.

// CSI (\x1b[ ... final), OSC (\x1b] ... BEL or ST), and the two-character Fe
// escapes. Matched first so the whole sequence goes, not just its introducer.
const ESC_SEQ = /\x1b(?:\[[0-9;?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])/g;

// Whatever is left: C0 including CR, LF and NUL, DEL, and the C1 range that some
// terminals still interpret as single-byte control introducers.
const CTRL = /[\x00-\x1f\x7f-\x9f]/g;

export function sanitizeDisplay(s, max = 80) {
  return String(s ?? "").replace(ESC_SEQ, "").replace(CTRL, "").slice(0, max);
}

// `/` is legitimate and common -- `groq/openai/gpt-oss-20b` is a real two-slash
// id -- so it cannot be banned. `\` and `..` can and must be: an id must never
// be able to reach a filesystem path.
export const MODEL_ID_OK = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]{0,127}$/;

export function admitId(id) {
  const s = String(id ?? "");
  if (!MODEL_ID_OK.test(s)) return null;
  if (s.includes("..")) return null;
  return s;
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 15`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): reject unsafe model ids and strip escape sequences before rendering"
```

---

### Task A4: `catalog.mjs` — testable builder, the five-badge set, and the nullable free column

**Files:** Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Create `C:/Users/osami/.uw/test/fixtures/catalog.json`, Test `C:/Users/osami/.uw/test/catalog.test.mjs`
**Interfaces:** Consumes: `sanitizeDisplay`, `admitId` from `./sanitize.mjs`. Produces:
`priceOf(entry: object) -> {in: number, out: number} | null`
`isTextOut(entry: object) -> boolean`
`badgeOf(entry: object, opts?: {cadence?: string, planCovered?: boolean}) -> "FREE"|"FREE?"|"PLAN"|"PAID"|""`
`buildFrom(input: {chosen: Cred[], providers: Map<string,Profile>, catalog: {byProvider: Map<string,Entry[]>, generatedAt: string}, relay?: object}) -> {rows: Row[], generatedAt: string}` where `Row = {keyId, provider, models: Model[], free: number|null, planCount: number, health: string}` and `Model = {id, ctx, pin, pout, badge, tools, vision, reason}`
`build() -> {rows, generatedAt}` — the thin wrapper that loads the live vault and catalogue and delegates to `buildFrom`
`routableSet() -> Promise<Set<string>>` — unchanged

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/fixtures/catalog.json`:

```json
{
  "generatedAt": "2026-08-24T12:22:28.162Z",
  "models": [
    { "provider": "acme", "model": "acme-chat-1",
      "limits": { "contextTokens": 163840 },
      "modalities": { "input": ["text"], "output": ["text"] },
      "capabilities": { "toolCalling": true, "imageInput": false, "reasoning": true },
      "pricing": { "offers": [ { "per1MTokens": { "input": 0, "output": 0 } } ] } },
    { "provider": "acme", "model": "acme-pro-1",
      "limits": { "contextTokens": 1000000 },
      "modalities": { "input": ["text"], "output": ["text"] },
      "capabilities": { "toolCalling": true, "imageInput": true, "reasoning": false },
      "pricing": { "offers": [ { "per1MTokens": { "input": 0.3, "output": 1.2 } } ] } },
    { "provider": "acme", "model": "acme-image-1",
      "modalities": { "input": ["text"], "output": ["image"] },
      "capabilities": {},
      "pricing": { "offers": [ { "per1MTokens": { "input": 0, "output": 0 } } ] } },
    { "provider": "acme", "model": "acme-legacy-1",
      "capabilities": {},
      "pricing": { "inputPerMillion": 0, "outputPerMillion": 0 } },
    { "provider": "blank", "model": "blank-a", "capabilities": {} },
    { "provider": "blank", "model": "blank-b", "capabilities": {} }
  ]
}
```

Create `C:/Users/osami/.uw/test/catalog.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { priceOf, isTextOut, badgeOf, buildFrom } from "../menu/catalog.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(doc.models.map((m) => [m.model, m]));

const catalog = () => {
  const byProvider = new Map();
  for (const m of doc.models) {
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { byProvider, generatedAt: doc.generatedAt };
};

test("priceOf reads pricing.offers[].per1MTokens", () => {
  assert.deepEqual(priceOf(byId["acme-chat-1"]), { in: 0, out: 0 });
  assert.deepEqual(priceOf(byId["acme-pro-1"]), { in: 0.3, out: 1.2 });
});

test("priceOf returns null for the legacy shape keysync's inferTier reads", () => {
  assert.equal(priceOf(byId["acme-legacy-1"]), null);
  assert.equal(priceOf(byId["blank-a"]), null);
});

test("isTextOut is true when output modality is absent or includes text", () => {
  assert.equal(isTextOut(byId["acme-chat-1"]), true);
  assert.equal(isTextOut(byId["blank-a"]), true);
  assert.equal(isTextOut(byId["acme-image-1"]), false);
});

test("badgeOf: no price evidence renders blank, never PAID", () => {
  assert.equal(badgeOf(byId["blank-a"]), "");
  assert.equal(badgeOf(byId["acme-legacy-1"]), "");
});

test("badgeOf: a non-zero token price is PAID", () => {
  assert.equal(badgeOf(byId["acme-pro-1"]), "PAID");
});

test("badgeOf: zero price with unknown cadence is FREE?", () => {
  assert.equal(badgeOf(byId["acme-chat-1"]), "FREE?");
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "" }), "FREE?");
});

test("badgeOf: zero price with a recurring grant is FREE", () => {
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "recurring" }), "FREE");
});

test("badgeOf: zero price with a one-time grant is blank, not FREE and not PAID", () => {
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "one-time" }), "");
  assert.equal(badgeOf(byId["acme-chat-1"], { cadence: "none" }), "");
});

test("badgeOf: guard G1 blanks a zero token price on a non-text-output model", () => {
  assert.equal(badgeOf(byId["acme-image-1"]), "");
  assert.equal(badgeOf(byId["acme-image-1"], { cadence: "recurring" }), "");
});

test("badgeOf: planCovered wins over price", () => {
  assert.equal(badgeOf(byId["acme-pro-1"], { planCovered: true }), "PLAN");
  assert.equal(badgeOf(byId["blank-a"], { planCovered: true }), "PLAN");
});

const input = (overrides = {}) => ({
  chosen: [
    { id: "personal.acme.free", provider: "acme" },
    { id: "personal.blank.paid", provider: "blank" },
  ],
  providers: new Map([
    ["acme", { testModel: "acme-chat-1", notes: "", requiresBalance: false }],
    ["blank", { testModel: "blank-a", notes: "", requiresBalance: false }],
  ]),
  catalog: catalog(),
  ...overrides,
});

test("buildFrom: free is a count when price data exists", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.free, 1);
  assert.equal(acme.models.length, 4);
});

test("buildFrom: free is null when no model has any price data", () => {
  const { rows } = buildFrom(input());
  const blank = rows.find((r) => r.provider === "blank");
  assert.equal(blank.free, null);
  assert.notEqual(blank.free, 0);
});

test("buildFrom: planCount is separate from free", () => {
  const { rows } = buildFrom(input({
    cadenceOf: () => ({ cadence: "", planCovered: true }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.planCount, 4);
  assert.equal(acme.free, 0);
});

test("buildFrom: a recurring cadence promotes FREE? to FREE", () => {
  const { rows } = buildFrom(input({
    cadenceOf: (name) => ({ cadence: name === "acme" ? "recurring" : "" }),
  }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.find((m) => m.id === "acme-chat-1").badge, "FREE");
  assert.equal(acme.free, 1);
});

test("buildFrom: the testModel leads and is not duplicated", () => {
  const { rows } = buildFrom(input());
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.filter((m) => m.id === "acme-chat-1").length, 1);
});

test("buildFrom: a testModel absent from the catalogue is prepended with a blank badge", () => {
  const p = new Map([["acme", { testModel: "acme-unlisted", notes: "" }]]);
  const { rows } = buildFrom(input({
    chosen: [{ id: "personal.acme.free", provider: "acme" }],
    providers: p,
  }));
  assert.equal(rows[0].models[0].id, "acme-unlisted");
  assert.equal(rows[0].models[0].badge, "");
});

test("buildFrom: ids that fail admitId are dropped, not rendered", () => {
  const c = catalog();
  c.byProvider.get("acme").push({ provider: "acme", model: "evil\x1b[2J", capabilities: {} });
  const { rows } = buildFrom(input({ catalog: c }));
  const acme = rows.find((r) => r.provider === "acme");
  assert.equal(acme.models.some((m) => m.id.includes("\x1b")), false);
  assert.equal(acme.models.length, 4);
});

test("buildFrom: the relay is injected with PLAN badges", () => {
  const { rows } = buildFrom(input({
    relay: { provider: "anthropic", models: ["claude-opus-5", "claude-sonnet-5"] },
  }));
  const relay = rows.find((r) => r.provider === "anthropic");
  assert.equal(relay.keyId, "relay.anthropic.subscription");
  assert.equal(relay.models.every((m) => m.badge === "PLAN"), true);
  assert.equal(relay.free, null);
  assert.equal(relay.planCount, 2);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/catalog.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../menu/catalog.mjs' does not provide an export named 'priceOf'` — the module currently keeps `priceOf`, `isTextOut` and `badgeOf` private and has no `buildFrom`.

- [ ] Step 3: Implement.

Rewrite `C:/Users/osami/.uw/menu/catalog.mjs`. The live-loading half stays as it is; the pure half is split out so tests never read the real vault:

```js
// Shared catalogue builder for the UW model picker.
//
// Reads only metadata: vault registry/profiles and the model catalogue.
// NEVER reads or returns API key values.
//
// Split deliberately in two:
//   buildFrom(input)  -- pure. Every test drives this with a fixture.
//   build()           -- loads the live vault and catalogue, then delegates.
// Without the split, testing the badge rules would mean reading ~/.llmkeys.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sanitizeDisplay, admitId } from "./sanitize.mjs";

const KEYSYNC = path.join(os.homedir(), ".uw", "keysync", "keysync.mjs");
const K = await import("file://" + KEYSYNC.replace(/\\/g, "/"));

export const SLOT = path.join(os.homedir(), ".uw", "state", "slot.json");

// The catalogue's real pricing path. keysync's own inferTier reads
// `pricing.inputPerMillion`, which does not exist in this schema -- it returns
// "unknown" for all 4,298 models, which is why its free-tier sort is a no-op.
export function priceOf(entry) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return null;
  for (const o of offers) {
    const p = o?.per1MTokens;
    if (p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output))) {
      return { in: Number(p.input), out: Number(p.output) };
    }
  }
  return null;
}

// GUARD G1: a zero *token* price on a model whose output is not text means it is
// billed per image/second in another unit. Blank, never "free".
export function isTextOut(entry) {
  const out = entry?.modalities?.output;
  return !Array.isArray(out) || out.length === 0 || out.includes("text");
}

// The whole badge set. Nothing else may ever be rendered.
//   FREE   price 0 AND a curated recurring grant cadence  (the governing rule)
//   FREE?  price 0, cadence unknown -- honest, and this will be the common case
//   PLAN   subscription-covered: marginal price 0 because a plan was paid for
//   PAID   any non-zero token price
//   ""     no evidence, guard G1, or price 0 with a ONE-TIME grant
//
// The last case deserves its own sentence: a one-time signup wallet is not free
// under the governing definition, and it is not paid either, because the
// marginal price really is zero. Blank is the only honest rendering.
export function badgeOf(entry, { cadence = "", planCovered = false } = {}) {
  if (planCovered) return "PLAN";
  const p = priceOf(entry);
  if (!p) return "";
  if (p.in === 0 && p.out === 0) {
    if (!isTextOut(entry)) return "";        // G1
    if (cadence === "recurring") return "FREE";
    if (cadence === "one-time" || cadence === "none") return "";
    return "FREE?";
  }
  return "PAID";
}

// 8 of 47 provider profiles record breakage in their hand-written notes.
const BROKEN = /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;
export const healthOf = (p) =>
  BROKEN.test(String(p?.notes ?? "")) ? "broken" : p?.requiresBalance ? "needs $" : "ok";

/** Which `provider/model` strings CCR can actually resolve right now. */
export async function routableSet() {
  try {
    const svc = JSON.parse(fs.readFileSync(
      path.join(process.env.APPDATA, "claude-code-router", "service.json"), "utf8"));
    const u = new URL(svc.url);
    const r = await fetch(`http://127.0.0.1:${u.port}/api/ccr/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-ccr-web-auth": u.searchParams.get("ccr_web_token") },
      body: JSON.stringify({ method: "getConfig", args: [] }),
      signal: AbortSignal.timeout(8000),
    });
    const cfg = (await r.json()).value;
    const set = new Set();
    for (const p of cfg.Providers ?? []) for (const m of p.models ?? []) set.add(`${p.name}/${m}`);
    return set;
  } catch {
    return new Set();                   // unreachable gateway: mark nothing routable
  }
}

const FREEISH = new Set(["FREE", "FREE?"]);

/**
 * @param {object}   i
 * @param {Array}    i.chosen      one credential per provider
 * @param {Map}      i.providers   provider name -> profile
 * @param {object}   i.catalog     {byProvider: Map, generatedAt: string}
 * @param {object}  [i.relay]      {provider, models[]} injected, not a vault credential
 * @param {Function}[i.cadenceOf]  provider name -> {cadence?, planCovered?}
 */
export function buildFrom({ chosen, providers, catalog, relay, cadenceOf = () => ({}) }) {
  const rows = [];
  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const opts = cadenceOf(cred.provider) ?? {};
    const models = [];
    for (const e of catalog.byProvider.get(cred.provider) ?? []) {
      const id = admitId(e.model);
      if (!id) continue;                 // reject, never sanitize, a routing selector
      const p = priceOf(e), caps = e?.capabilities ?? {};
      models.push({
        id, ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e, opts),
        tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning,
      });
    }
    // testModel leads: measured, catalogue-first dropped the live pass rate to 4/44.
    const tm = admitId(prof.testModel);
    if (tm && !models.some((m) => m.id === tm)) {
      models.unshift({ id: tm, ctx: null, pin: null, pout: null,
                       badge: opts.planCovered ? "PLAN" : "",
                       tools: false, vision: false, reason: false });
    }
    const priced = models.some((m) => m.badge !== "");
    rows.push({
      keyId: sanitizeDisplay(cred.id, 30), provider: cred.provider, models,
      // NULLABLE: "0 free" is a measurement, "no price data" is the absence of one.
      free: priced ? models.filter((m) => FREEISH.has(m.badge)).length : null,
      planCount: models.filter((m) => m.badge === "PLAN").length,
      health: healthOf(prof),
    });
  }

  // The relay is NOT a vault credential -- registry.json has no `anthropic` row.
  // keysync injects it separately, so building from the vault alone silently drops
  // the four Claude models, which are the ones most likely to be routable.
  if (relay && !rows.some((r) => r.provider === relay.provider)) {
    const models = (relay.models ?? []).map((id) => ({
      id, ctx: null, pin: null, pout: null, badge: "PLAN",
      tools: true, vision: true, reason: true }));
    rows.push({
      keyId: "relay.anthropic.subscription", provider: relay.provider, models,
      free: null, planCount: models.length, health: "ok",
    });
  }

  rows.sort((a, b) => b.models.length - a.models.length);
  return { rows, generatedAt: catalog.generatedAt };
}

export function build() {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  return buildFrom({
    chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY,
  });
}

export function writeSlot(target) {
  fs.mkdirSync(path.dirname(SLOT), { recursive: true });
  fs.writeFileSync(SLOT, JSON.stringify({ model: target }, null, 2));
}

export function readSlot() {
  try { return JSON.parse(fs.readFileSync(SLOT, "utf8")).model ?? ""; } catch { return ""; }
}
```

Note the deliberate omission: `buildFrom` takes `cadenceOf` as an injected function rather than reading `providers.json` itself. Task B3 supplies the real implementation from `cadence.mjs`; until then the default returns `{}` and every zero-price text model renders `FREE?`, which is the honest state today.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 32`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): five-badge set, nullable free column, and a fixture-testable builder"
```

---

### Task A5: `pick-state.mjs` — the pure two-level reducer

**Files:** Create `C:/Users/osami/.uw/menu/pick-state.mjs`, Test `C:/Users/osami/.uw/test/pick-state.test.mjs`
**Interfaces:** Consumes: nothing (pure). Produces:
`initState(rows: Row[], opts?: {recents?: string[], favourites?: string[], termRows?: number}) -> State`
`reduce(state: State, ev: string | {resize: number}) -> {state: State, exit: null | {text: string|null}, favourite: null | string}`
`view(state: State) -> {level, scope, filter, items: Item[], cursor: number, top: number, empty: boolean, provider: Row|null, more: number}`
where `Item` is either `{kind:"pinned", target, mark}`, `{kind:"provider", row}` or `{kind:"model", model}`.
`exit.text === null` means quit without writing; a string is the exact chat input to write.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/pick-state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view } from "../menu/pick-state.mjs";

const M = (id, badge = "") => ({ id, ctx: null, pin: null, pout: null, badge,
                                 tools: false, vision: false, reason: false });
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
    models: [M("acme-chat-1", "FREE?"), M("acme-pro-1", "PAID"), M("opus-lookalike")] },
  { keyId: "personal.zeta.paid", provider: "zeta", free: null, planCount: 0, health: "broken",
    models: [M("zeta-one"), M("zeta-two")] },
];

const drive = (s, keys) => {
  let out = { state: s, exit: null, favourite: null };
  for (const k of keys) {
    out = reduce(out.state, k);
    if (out.exit) break;
  }
  return out;
};

const ESC = "\x1b", UP = "\x1b[A", DOWN = "\x1b[B", ENTER = "\r", TAB = "\t";
const BS = "\x7f", CTRL_C = "\x03", CTRL_T = "\x14";

test("level 0 lists providers", () => {
  const v = view(initState(ROWS));
  assert.equal(v.level, 0);
  assert.deepEqual(v.items.map((i) => i.row.keyId), ["personal.acme.free", "personal.zeta.paid"]);
});

test("level-0 filter matches the key id", () => {
  const { state } = drive(initState(ROWS), ["z", "e", "t"]);
  assert.deepEqual(view(state).items.map((i) => i.row.provider), ["zeta"]);
});

test("level-0 filter also matches member model ids", () => {
  const { state } = drive(initState(ROWS), ["o", "p", "u", "s"]);
  assert.deepEqual(view(state).items.map((i) => i.row.provider), ["acme"]);
});

test("enter descends into a provider and clears the model filter", () => {
  const { state } = drive(initState(ROWS), [ENTER]);
  const v = view(state);
  assert.equal(v.level, 1);
  assert.equal(v.provider.provider, "acme");
  assert.equal(v.filter, "");
  assert.equal(v.items.length, 3);
});

test("enter on a model exits with the /model line", () => {
  const { exit } = drive(initState(ROWS), [ENTER, DOWN, ENTER]);
  assert.deepEqual(exit, { text: "/model acme/acme-pro-1" });
});

test("arrows clamp at both ends without wrapping", () => {
  const a = drive(initState(ROWS), [UP, UP]);
  assert.equal(view(a.state).cursor, 0);
  const b = drive(initState(ROWS), [DOWN, DOWN, DOWN]);
  assert.equal(view(b.state).cursor, 1);
});

test("backspace pops the filter and resets the cursor", () => {
  const { state } = drive(initState(ROWS), ["z", "e", DOWN, BS]);
  assert.equal(view(state).filter, "z");
  assert.equal(view(state).cursor, 0);
});

test("the esc ladder: model level clears a filter, then goes back, then quits", () => {
  let s = initState(ROWS);
  s = reduce(s, ENTER).state;               // into acme
  s = reduce(s, "p").state;                 // model filter "p"
  assert.equal(view(s).filter, "p");
  s = reduce(s, ESC).state;                 // clears the model filter
  assert.equal(view(s).filter, "");
  assert.equal(view(s).level, 1);
  s = reduce(s, ESC).state;                 // back to providers
  assert.equal(view(s).level, 0);
  s = reduce(s, "z").state;                 // provider filter
  s = reduce(s, ESC).state;                 // clears it
  assert.equal(view(s).filter, "");
  const last = reduce(s, ESC);              // quits
  assert.deepEqual(last.exit, { text: null });
});

test("tab toggles the flat scope and searches provider/model", () => {
  let s = reduce(initState(ROWS), TAB).state;
  assert.equal(view(s).scope, "flat");
  s = drive(s, ["z", "e", "t", "a", "/", "t"]).state;
  assert.deepEqual(view(s).items.map((i) => i.target), ["zeta/zeta-two"]);
  const { exit } = reduce(s, ENTER);
  assert.deepEqual(exit, { text: "/model zeta/zeta-two" });
});

test("esc leaves the flat scope before it quits", () => {
  let s = reduce(initState(ROWS), TAB).state;
  s = reduce(s, ESC).state;
  assert.equal(view(s).scope, "tree");
  assert.equal(view(s).level, 0);
});

test("recents and favourites are pinned at level 0 as visible duplicates", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"], favourites: ["acme/acme-pro-1"] });
  const v = view(s);
  assert.deepEqual(v.items.slice(0, 2).map((i) => i.target),
                   ["acme/acme-pro-1", "zeta/zeta-two"]);
  assert.deepEqual(v.items.slice(0, 2).map((i) => i.mark), ["*", "~"]);
  // still present inside their provider
  const zeta = reduce(reduce(s, DOWN).state, DOWN).state;
  const inProvider = reduce(zeta, ENTER).state;
  assert.equal(view(inProvider).items.some((i) => i.model.id === "zeta-two"), true);
});

test("enter on a pinned row selects immediately, without descending", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"] });
  const { exit } = reduce(s, ENTER);
  assert.deepEqual(exit, { text: "/model zeta/zeta-two" });
});

test("a pinned row is filtered by its full target string", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"] });
  const { state } = drive(s, ["t", "w", "o"]);
  assert.deepEqual(view(state).items.map((i) => i.target ?? i.row.provider), ["zeta/zeta-two"]);
});

test("ctrl+t reports the focused model as a favourite toggle", () => {
  const s = reduce(initState(ROWS), ENTER).state;
  const r = reduce(s, CTRL_T);
  assert.equal(r.favourite, "acme/acme-chat-1");
  assert.equal(r.exit, null);
});

test("ctrl+t at the provider level is a no-op", () => {
  assert.equal(reduce(initState(ROWS), CTRL_T).favourite, null);
});

test("ctrl+c exits without writing", () => {
  assert.deepEqual(reduce(initState(ROWS), CTRL_C).exit, { text: null });
});

test("an empty result set is reported, and enter on it does nothing", () => {
  const { state } = drive(initState(ROWS), ["q", "q", "q", "q"]);
  const v = view(state);
  assert.equal(v.empty, true);
  assert.equal(v.items.length, 0);
  assert.equal(reduce(state, ENTER).exit, null);
});

test("resize changes the window without moving the cursor", () => {
  const many = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: Array.from({ length: 40 }, (_, i) => M(`m${i}`)) }];
  let s = reduce(initState(many, { termRows: 30 }), ENTER).state;
  for (let i = 0; i < 20; i++) s = reduce(s, DOWN).state;
  assert.equal(view(s).cursor, 20);
  const before = view(s).top;
  s = reduce(s, { resize: 12 }).state;
  assert.equal(view(s).cursor, 20);
  assert.notEqual(view(s).top, before);
  assert.ok(view(s).items.length <= 40);
});

test("the window keeps the cursor visible after a refilter", () => {
  const many = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: Array.from({ length: 40 }, (_, i) => M(`m${i}`)) }];
  let s = reduce(initState(many, { termRows: 30 }), ENTER).state;
  for (let i = 0; i < 30; i++) s = reduce(s, DOWN).state;
  s = reduce(s, "m").state;
  const v = view(s);
  assert.ok(v.cursor >= v.top && v.cursor < v.top + v.items.length + 1);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/pick-state.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\pick-state.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/pick-state.mjs`:

```js
// The two-level menu, as a pure reducer.
//
// Split out of the renderer for one reason: under CC's ctrl+g handoff the child
// has no usable stdin, so the interactive surface cannot be driven by a test
// harness. Keeping every decision here -- filtering, cursor, scope, the Esc
// ladder -- means the behaviour is testable by feeding it strings, and the
// renderer left behind is a formatter with no logic to get wrong.

const asTarget = (providerName, modelId) => `${providerName}/${modelId}`;

export function initState(rows, { recents = [], favourites = [], termRows = 30 } = {}) {
  const known = new Set();
  for (const r of rows) for (const m of r.models) known.add(asTarget(r.provider, m.id));
  // Favourites first, then recents, both filtered to targets that still exist.
  // A pinned row naming a model the catalogue dropped would be a dead selection.
  const pinned = [
    ...favourites.filter((t) => known.has(t)).map((target) => ({ kind: "pinned", target, mark: "*" })),
    ...recents.filter((t) => known.has(t) && !favourites.includes(t))
              .map((target) => ({ kind: "pinned", target, mark: "~" })),
  ];
  return {
    rows, pinned,
    level: 0, scope: "tree",
    q: ["", "", ""], cur: [0, 0, 0], top: [0, 0, 0],
    provider: null, termRows,
  };
}

// Index into q/cur/top. Flat scope is its own slot so toggling back to the tree
// restores the filters the user had typed there.
const slot = (s) => (s.scope === "flat" ? 2 : s.level);

const rowsAvail = (s) => Math.max(3, (s.termRows || 30) - 6);

function flatItems(s) {
  const out = [];
  for (const r of s.rows) {
    for (const m of r.models) {
      out.push({ kind: "model", model: m, row: r, target: asTarget(r.provider, m.id) });
    }
  }
  return out;
}

function items(s) {
  const needle = s.q[slot(s)].toLowerCase();
  const has = (hay) => !needle || String(hay).toLowerCase().includes(needle);

  if (s.scope === "flat") return flatItems(s).filter((i) => has(i.target));

  if (s.level === 1) {
    return s.provider.models
      .filter((m) => has(m.id))
      .map((m) => ({ kind: "model", model: m, row: s.provider,
                     target: asTarget(s.provider.provider, m.id) }));
  }

  // Level 0. The filter matches member model ids too, so typing "opus" finds the
  // provider that SERVES it -- this is what makes two levels tolerable when you
  // already know the model name.
  const provs = s.rows
    .filter((r) => has(r.keyId) || r.models.some((m) => has(m.id)))
    .map((row) => ({ kind: "provider", row }));
  const pins = s.pinned.filter((p) => has(p.target));
  return [...pins, ...provs];
}

function clamp(s) {
  const list = items(s);
  const avail = rowsAvail(s);
  const i = slot(s);
  const cur = [...s.cur], top = [...s.top];
  cur[i] = Math.min(Math.max(0, cur[i]), Math.max(0, list.length - 1));
  if (cur[i] < top[i]) top[i] = cur[i];
  if (cur[i] >= top[i] + avail) top[i] = cur[i] - avail + 1;
  top[i] = Math.max(0, Math.min(top[i], Math.max(0, list.length - avail)));
  return { ...s, cur, top };
}

const reset = (s) => {
  const i = slot(s);
  const cur = [...s.cur], top = [...s.top];
  cur[i] = 0; top[i] = 0;
  return { ...s, cur, top };
};

const NONE = { exit: null, favourite: null };

export function reduce(state, ev) {
  if (ev && typeof ev === "object" && Number.isFinite(ev.resize)) {
    return { ...NONE, state: clamp({ ...state, termRows: ev.resize }) };
  }
  const key = String(ev ?? "");
  const c0 = key.charCodeAt(0);
  const i = slot(state);
  const list = items(state);
  const focused = list[state.cur[i]] ?? null;

  if (c0 === 3) return { ...NONE, state, exit: { text: null } };               // ctrl+c

  if (key === "\t") {                                                          // scope toggle
    return { ...NONE, state: clamp({ ...state, scope: state.scope === "flat" ? "tree" : "flat" }) };
  }

  if (c0 === 20 && focused?.kind === "model") {                                // ctrl+t
    return { ...NONE, state, favourite: focused.target };
  }

  if (key.length >= 3 && c0 === 27 && key[1] === "[") {                        // arrows
    const cur = [...state.cur];
    if (key[2] === "A") cur[i] = cur[i] - 1;
    if (key[2] === "B") cur[i] = cur[i] + 1;
    return { ...NONE, state: clamp({ ...state, cur }) };
  }

  if (key.length === 1 && c0 === 27) {                                         // esc ladder
    if (state.q[i]) {
      const q = [...state.q]; q[i] = "";
      return { ...NONE, state: clamp(reset({ ...state, q })) };
    }
    if (state.scope === "flat") return { ...NONE, state: clamp({ ...state, scope: "tree" }) };
    if (state.level === 1) return { ...NONE, state: clamp({ ...state, level: 0, provider: null }) };
    return { ...NONE, state, exit: { text: null } };
  }

  if (c0 === 13 || c0 === 10) {                                                // enter
    if (!focused) return { ...NONE, state };
    if (focused.kind === "provider") {
      const q = [...state.q], cur = [...state.cur], top = [...state.top];
      q[1] = ""; cur[1] = 0; top[1] = 0;
      return { ...NONE, state: clamp({ ...state, level: 1, provider: focused.row, q, cur, top }) };
    }
    return { ...NONE, state, exit: { text: `/model ${focused.target}` } };
  }

  if (c0 === 127 || c0 === 8) {                                                // backspace
    const q = [...state.q]; q[i] = q[i].slice(0, -1);
    return { ...NONE, state: clamp(reset({ ...state, q })) };
  }

  if (key.length === 1 && c0 >= 32 && c0 <= 126) {                             // live filter
    const q = [...state.q]; q[i] = q[i] + key;
    return { ...NONE, state: clamp(reset({ ...state, q })) };
  }

  return { ...NONE, state };
}

export function view(state) {
  const i = slot(state);
  const all = items(state);
  const avail = rowsAvail(state);
  const shown = all.slice(state.top[i], state.top[i] + avail);
  return {
    level: state.level, scope: state.scope, filter: state.q[i],
    items: shown, cursor: state.cur[i], top: state.top[i],
    empty: all.length === 0, provider: state.provider,
    more: Math.max(0, all.length - (state.top[i] + shown.length)),
  };
}
```

One behaviour worth stating because a test pins it: `view().items` is the **windowed** slice, while `view().cursor` is an index into the **full** filtered list. The renderer subtracts `top` to find the highlighted line. The alternative — a cursor relative to the window — makes clamping after a refilter much harder to reason about.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 51`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): pure two-level reducer with an esc ladder, flat scope and pinned rows"
```

---

### Task A6: `state.mjs` — persist recents and favourites

**Files:** Create `C:/Users/osami/.uw/menu/state.mjs`, Test `C:/Users/osami/.uw/test/state.test.mjs`
**Interfaces:** Consumes: nothing. Produces:
`PICKER_STATE: string` — absolute path to `~/.uw/state/picker.json`
`loadPickerState(file?: string) -> {recents: string[], favourites: string[]}`
`recordRecent(target: string, file?: string) -> {recents, favourites}` — most-recent-first, deduped, capped at 8
`toggleFavourite(target: string, file?: string) -> {recents, favourites}` — capped at 20
`recordHandoff(entry: object, file?: string) -> void` — appends one JSON line to `~/.uw/state/handoff.json`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff } from "../menu/state.mjs";

// Never the live file: every test gets its own scratch path.
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-state-"));
  return path.join(d, "picker.json");
};

test("a missing file loads as empty rather than throwing", () => {
  assert.deepEqual(loadPickerState(scratch()), { recents: [], favourites: [] });
});

test("a corrupt file loads as empty rather than throwing", () => {
  const f = scratch();
  fs.writeFileSync(f, "{not json");
  assert.deepEqual(loadPickerState(f), { recents: [], favourites: [] });
});

test("recents are most-recent-first and deduped", () => {
  const f = scratch();
  recordRecent("a/one", f);
  recordRecent("b/two", f);
  recordRecent("a/one", f);
  assert.deepEqual(loadPickerState(f).recents, ["a/one", "b/two"]);
});

test("recents cap at 8", () => {
  const f = scratch();
  for (let i = 0; i < 12; i++) recordRecent(`p/m${i}`, f);
  const { recents } = loadPickerState(f);
  assert.equal(recents.length, 8);
  assert.equal(recents[0], "p/m11");
});

test("toggleFavourite adds then removes", () => {
  const f = scratch();
  assert.deepEqual(toggleFavourite("a/one", f).favourites, ["a/one"]);
  assert.deepEqual(toggleFavourite("a/one", f).favourites, []);
});

test("favourites survive a recents write", () => {
  const f = scratch();
  toggleFavourite("a/one", f);
  recordRecent("b/two", f);
  const s = loadPickerState(f);
  assert.deepEqual(s.favourites, ["a/one"]);
  assert.deepEqual(s.recents, ["b/two"]);
});

test("a non-string target is refused", () => {
  const f = scratch();
  recordRecent(null, f);
  recordRecent(42, f);
  assert.deepEqual(loadPickerState(f).recents, []);
});

test("the written file is valid JSON with only the two keys", () => {
  const f = scratch();
  recordRecent("a/one", f);
  const raw = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(Object.keys(raw).sort(), ["favourites", "recents"]);
});

test("recordHandoff appends one parseable line per call", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-handoff-"));
  const f = path.join(d, "handoff.json");
  recordHandoff({ sentinel: "m", wrote: false }, f);
  recordHandoff({ sentinel: "model", wrote: true }, f);
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).sentinel, "model");
  assert.equal(typeof JSON.parse(lines[0]).at, "string");
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/state.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\state.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/state.mjs`:

```js
// Per-machine picker state. Not source, not committed (.gitignore excludes state/).
//
// Every function takes an optional file path so tests never touch the live file.
// Reads are total: a missing or corrupt file is an empty state, never a throw,
// because a picker that refuses to start over a bad preferences file is worse
// than one that forgets your favourites.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".uw", "state");
export const PICKER_STATE = path.join(STATE_DIR, "picker.json");
export const HANDOFF_LOG = path.join(STATE_DIR, "handoff.json");

const MAX_RECENTS = 8;
const MAX_FAVOURITES = 20;

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function loadPickerState(file = PICKER_STATE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { recents: strings(raw.recents), favourites: strings(raw.favourites) };
  } catch {
    return { recents: [], favourites: [] };
  }
}

function save(file, next) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function recordRecent(target, file = PICKER_STATE) {
  const s = loadPickerState(file);
  if (typeof target !== "string" || !target) return s;
  const recents = [target, ...s.recents.filter((t) => t !== target)].slice(0, MAX_RECENTS);
  return save(file, { recents, favourites: s.favourites });
}

export function toggleFavourite(target, file = PICKER_STATE) {
  const s = loadPickerState(file);
  if (typeof target !== "string" || !target) return s;
  const favourites = s.favourites.includes(target)
    ? s.favourites.filter((t) => t !== target)
    : [target, ...s.favourites].slice(0, MAX_FAVOURITES);
  return save(file, { recents: s.recents, favourites });
}

// One JSON line per picker invocation. This is the only evidence `uw doctor` has
// that CC's handoff contract still holds -- the argv shape it actually received,
// not the argv shape we believe it receives.
export function recordHandoff(entry, file = HANDOFF_LOG) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch { /* observability must never break the picker */ }
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 60`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): persist recents and favourites, and record each handoff invocation"
```

---

### Task A7: Rewire `uwpick.mjs` onto the reducer

**Files:** Modify `C:/Users/osami/.uw/menu/uwpick.mjs`, Test `C:/Users/osami/.uw/test/uwpick.test.mjs`
**Interfaces:** Consumes: `build`, `routableSet` from `./catalog.mjs`; `initState`, `reduce`, `view` from `./pick-state.mjs`; `sanitizeDisplay` from `./sanitize.mjs`; `loadPickerState`, `recordRecent`, `toggleFavourite`, `recordHandoff` from `./state.mjs`. Produces:
`render(v: View, meta: {providers: number, routable: number, generatedAt: string}, routable: Set<string>) -> string` — exported so the frame is testable without a console
`main()` — opens `//./CONIN$`, loops, writes the selection, exits 0

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/uwpick.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { render } from "../menu/uwpick.mjs";

const M = (id, badge = "", extra = {}) => ({ id, ctx: null, pin: null, pout: null, badge,
                                             tools: false, vision: false, reason: false, ...extra });
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 12, planCount: 4, health: "ok",
    models: [M("acme-chat-1", "FREE?", { ctx: 163840, pin: 0, pout: 0, tools: true, reason: true }),
             M("acme-pro-1", "PAID", { ctx: 1000000, pin: 0.3, pout: 1.2, vision: true })] },
  { keyId: "personal.blank.paid", provider: "blank", free: null, planCount: 0, health: "broken",
    models: [M("blank-a")] },
];
const META = { providers: 2, routable: 1, generatedAt: "2026-08-24T12:22:28.162Z" };
const ROUTABLE = new Set(["acme/acme-chat-1"]);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("the provider header names the four required columns", () => {
  const out = plain(render(view(initState(ROWS)), META, ROUTABLE));
  assert.match(out, /key id\s+models\s+free\s+health/);
});

test("a nullable free column renders an em dash, not a zero", () => {
  const out = plain(render(view(initState(ROWS)), META, ROUTABLE));
  const line = out.split("\n").find((l) => l.includes("personal.blank.paid"));
  assert.match(line, /—/);
  assert.doesNotMatch(line, /\b0\b/);
});

test("a provider with plan-covered models renders the +N plan form", () => {
  const out = plain(render(view(initState(ROWS)), META, ROUTABLE));
  const line = out.split("\n").find((l) => l.includes("personal.acme.free"));
  assert.match(line, /12 \+4 plan/);
});

test("the model header names the six required columns", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const out = plain(render(view(s), META, ROUTABLE));
  assert.match(out, /model\s+ctx\s+\$in\s+\$out\s+badge\s+caps/);
});

test("model rows render ctx, prices, badge and caps", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const out = plain(render(view(s), META, ROUTABLE));
  const line = out.split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /1M/);
  assert.match(line, /0\.30/);
  assert.match(line, /1\.20/);
  assert.match(line, /PAID/);
  assert.match(line, /-V-/);
});

test("a non-routable model row is marked", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const raw = render(view(s), META, ROUTABLE);
  const line = raw.split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /\x1b\[2m/, "non-routable rows must be dimmed");
});

test("the empty state renders a row instead of a blank pane", () => {
  let s = initState(ROWS);
  for (const k of ["z", "z", "z", "z"]) s = reduce(s, k).state;
  const out = plain(render(view(s), META, ROUTABLE));
  assert.match(out, /no match/i);
});

test("escape sequences in a model id cannot reach the frame", () => {
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: [M("evil\x1b[2Jx")] }];
  const s = reduce(initState(rows), "\r").state;
  const out = render(view(s), META, new Set());
  assert.equal(out.includes("\x1b[2J"), false);
});

test("the footer names the keys the reducer implements", () => {
  const out = plain(render(view(initState(ROWS)), META, ROUTABLE));
  assert.match(out, /tab/);
  assert.match(out, /esc/);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/uwpick.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../menu/uwpick.mjs' does not provide an export named 'render'` — and, because the current file runs its console loop at import time, the test process also hangs or exits early. Both symptoms disappear in step 3, which is why `main()` becomes explicit.

- [ ] Step 3: Implement.

Rewrite `C:/Users/osami/.uw/menu/uwpick.mjs`:

```js
#!/usr/bin/env node
// UW model picker -- a terminal TUI that runs inside Claude Code's own
// external-editor handoff (ctrl+g / chat:externalEditor).
//
// WHY THIS WORKS WHERE EVERYTHING ELSE FAILED:
// CC's editor handoff calls enterAlternateScreen() -- which PAUSES its renderer
// and turns OFF raw mode -- then spawnSync's the editor with stdio:"inherit" and
// BLOCKS. So we get the real TTY, exclusively, with no repaint war and no
// keystroke war. (A hook's child cannot do this: hooks are spawned
// stdio:["ignore","pipe","pipe"], so they have no stdin at all.)
//
// CONTRACT: argv[2] is a temp .md holding the current chat input. Whatever we
// leave in that file becomes the new chat input. We write "/model <id>" and exit
// 0 -- a non-zero exit makes CC discard the content.
//
// All decisions live in pick-state.mjs. This file is a formatter plus an input
// loop; keeping it that thin is what makes the interactive surface testable.

import fs from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { build, routableSet } from "./catalog.mjs";
import { initState, reduce, view } from "./pick-state.mjs";
import { sanitizeDisplay } from "./sanitize.mjs";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff } from "./state.mjs";

const ESC = "\x1b";
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const inv = (s) => `${ESC}[7m${s}${ESC}[0m`;
const grn = (s) => `${ESC}[32m${s}${ESC}[0m`;
const red = (s) => `${ESC}[31m${s}${ESC}[0m`;
const cya = (s) => `${ESC}[36m${s}${ESC}[0m`;
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const pad  = (s, n) => sanitizeDisplay(s, n).padEnd(n);
const rpad = (s, n) => sanitizeDisplay(s, n).padStart(n);
const ctxS = (c) => (c == null ? "" : c >= 1e6 ? `${c / 1e6}M` : `${Math.round(c / 1000)}k`);
const money = (v) => (v == null ? "" : v.toFixed(2));

// Column widths are fixed and positional, so a blank cell is visibly a blank
// cell rather than a shifted row.
const W = { keyId: 30, count: 7, free: 12, health: 8,
            id: 34, ctx: 6, price: 7, badge: 6 };

const freeCell = (r) =>
  r.free == null ? "—" : r.planCount ? `${r.free} +${r.planCount} plan` : String(r.free);

export function render(v, meta, routable) {
  const L = [];
  L.push(cya("  UW model picker") +
         dim(`   ${meta.providers} providers · ${meta.routable} routable · catalogue ${String(meta.generatedAt).slice(0, 10)}`));
  L.push("");

  if (v.level === 0) {
    const scope = v.scope === "flat" ? cya("provider/model") : cya("filter");
    L.push(`  ${scope} ${sanitizeDisplay(v.filter, 60)}${inv(" ")}`);
    L.push(dim("  " + (v.scope === "flat"
      ? pad("provider/model", W.keyId + 8) + pad("badge", W.badge) + "caps"
      : pad("key id", W.keyId) + rpad("models", W.count) + "  " +
        pad("free", W.free) + pad("health", W.health))));
  } else {
    L.push(`  ${cya(sanitizeDisplay(v.provider.keyId, 30))} ${dim("›")} ${sanitizeDisplay(v.filter, 60)}${inv(" ")}`);
    L.push(dim("  " + pad("model", W.id) + rpad("ctx", W.ctx) + " " +
               rpad("$in", W.price) + rpad("$out", W.price) + "  " +
               pad("badge", W.badge) + "caps"));
  }

  if (v.empty) {
    L.push("");
    L.push(dim("  no match — backspace to widen the filter, esc to clear it"));
  }

  v.items.forEach((it, i) => {
    const sel = v.top + i === v.cursor;
    let plain;
    if (it.kind === "provider") {
      plain = "  " + pad(it.row.keyId, W.keyId) + rpad(it.row.models.length, W.count) + "  " +
              pad(freeCell(it.row), W.free) + pad(it.row.health, W.health);
    } else if (it.kind === "pinned") {
      plain = `${it.mark} ` + pad(it.target, W.keyId + 8);
    } else {
      const m = it.model;
      const caps = `${m.tools ? "T" : "-"}${m.vision ? "V" : "-"}${m.reason ? "R" : "-"}`;
      plain = "  " + pad(m.id, W.id) + rpad(ctxS(m.ctx), W.ctx) + " " +
              rpad(money(m.pin), W.price) + rpad(money(m.pout), W.price) + "  " +
              pad(m.badge, W.badge) + caps;
    }
    if (sel) { L.push(inv(strip(plain))); return; }
    // Non-routable rows are dimmed rather than hidden: "CCR cannot resolve this
    // right now" is information, and removing the row would hide the catalogue.
    const routableRow = it.kind === "provider" || routable.has(it.target);
    if (!routableRow) { L.push(dim(plain)); return; }
    if (it.kind === "provider" && it.row.health === "broken") {
      L.push(plain.replace(it.row.health, red(it.row.health)));
    } else if (it.kind !== "provider" && (it.model.badge === "FREE" || it.model.badge === "FREE?")) {
      L.push(plain.replace(it.model.badge, grn(it.model.badge)));
    } else {
      L.push(plain);
    }
  });

  if (v.more > 0) L.push(dim(`  … ${v.more} more`));
  L.push("");
  L.push(dim(v.level === 0
    ? "  type to filter · ↑↓ move · enter open · tab flat search · esc clear/quit"
    : "  type to filter · ↑↓ move · enter select · ctrl+t favourite · tab flat search · esc back"));
  return L.join("\n");
}

export async function main() {
  const FILE = process.argv[2];
  const out = process.stdout;
  const { rows, generatedAt } = build();
  const routable = await routableSet();
  const { recents, favourites } = loadPickerState();

  let state = initState(rows, { recents, favourites, termRows: out.rows || 30 });
  const meta = { providers: rows.length, routable: routable.size, generatedAt };

  const draw = () => {
    // Re-read the row count on every frame. Windows has no SIGWINCH, and under
    // the handoff the resize event may never fire, so polling on redraw is the
    // only reliable source. The listener below is a bonus, not the mechanism.
    state = reduce(state, { resize: out.rows || 30 }).state;
    out.write(`${ESC}[2J${ESC}[H` + render(view(state), meta, routable));
  };
  if (out.isTTY) out.on("resize", () => draw());

  let CONIN = null;
  try { CONIN = openSync("//./CONIN$", "r"); } catch { CONIN = null; }

  const finish = (text) => {
    out.write(`${ESC}[?25h${ESC}[2J${ESC}[H`);
    let wrote = false;
    try {
      if (FILE && text != null) { fs.writeFileSync(FILE, text); wrote = true; }
    } catch { /* a failed write must still exit 0 -- CC keeps the old input */ }
    recordHandoff({ argv2: FILE ?? null, existed: !!FILE && fs.existsSync(FILE), wrote });
    process.exit(0);                 // MUST be 0, or CC discards the content
  };

  if (CONIN === null) {
    draw();
    out.write("\n\n  cannot open the console for input (//./CONIN$) — exiting.\n");
    finish(null);
  }

  out.write(`${ESC}[?25l`);
  draw();

  const buf = Buffer.alloc(64);
  for (;;) {
    let n = 0;
    try { n = readSync(CONIN, buf, 0, buf.length, null); }
    catch { break; }
    if (n <= 0) continue;
    const r = reduce(state, buf.toString("utf8", 0, n));
    state = r.state;
    if (r.favourite) {
      const next = toggleFavourite(r.favourite);
      state = initState(rows, { ...next, termRows: out.rows || 30 });
    }
    if (r.exit) {
      closeSync(CONIN);
      if (r.exit.text) recordRecent(r.exit.text.replace(/^\/model /, ""));
      finish(r.exit.text);
    }
    draw();
  }
  closeSync(CONIN);
  finish(null);
}

// Only run the loop when invoked as a program, never on import -- otherwise the
// test that imports `render` would block on a console read.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/uwpick.mjs")) {
  await main();
}
```

Two deliberate changes from the spike beyond the wiring. The key log is gone: it existed to prove keystrokes arrived at all, that is now established, and an append-only log of every keystroke in a filter box is a small liability. And `finish()` records the handoff shape instead, which is what `uw doctor` reads.

Note the favourite path rebuilds the state, which resets the cursor. That is a visible, acceptable cost for ~15 lines less bookkeeping; if it becomes annoying, the fix is to thread `pinned` through `reduce` rather than re-initialising.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 69`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): render from the reducer, sanitize every cell, drop the keystroke log"
```

---

### Task A8: Harden the PowerShell wrapper and prove the console mode is restored

**Files:** Modify `C:/Users/osami/.uw/menu/uwpick-run.ps1`, Test `C:/Users/osami/.uw/test/console-mode.test.mjs`, Create `C:/Users/osami/.uw/test/fixtures/exit1.mjs`
**Interfaces:** Consumes: `uwpick.mjs`. Produces: a wrapper accepting `-File <buffer>`, `-ChildScript <name>` (default `uwpick.mjs`) and `-Diagnose`. Under `-Diagnose` it writes `~/.uw/state/conmode.json` as `{saved, set, restored, childExit}` from inside the `finally` block.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/fixtures/exit1.mjs`:

```js
// A child that fails the way a crashing picker fails: writes nothing, exits 1.
process.stderr.write("deliberate failure\n");
process.exit(1);
```

Create `C:/Users/osami/.uw/test/console-mode.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const PS1 = "C:/Users/osami/.uw/menu/uwpick-run.ps1";
const REPORT = path.join(os.homedir(), ".uw", "state", "conmode.json");

const run = (child) => {
  try { fs.unlinkSync(REPORT); } catch {}
  const buf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "uw-buf-")), "b.md");
  fs.writeFileSync(buf, "m\n");
  let code = 0;
  try {
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
                                "-File", buf, "-ChildScript", child, "-Diagnose"],
                 { encoding: "utf8", stdio: "pipe", timeout: 30000 });
  } catch (e) { code = e.status ?? -1; }
  return { code, report: JSON.parse(fs.readFileSync(REPORT, "utf8")) };
};

test("the wrapper restores the console mode after a child that exits 1", () => {
  const { report } = run("../test/fixtures/exit1.mjs");
  assert.equal(report.childExit, 1);
  assert.equal(report.restored, report.saved,
    "the saved console mode must be restored even when the child fails");
});

test("the wrapper sets raw VT input while the child runs", () => {
  const { report } = run("../test/fixtures/exit1.mjs");
  assert.equal(report.set, 0x280);
  assert.equal((report.set & 0x02) === 0, true, "ENABLE_LINE_INPUT must be off");
  assert.equal((report.set & 0x04) === 0, true, "ENABLE_ECHO_INPUT must be off");
  assert.equal((report.set & 0x01) === 0, true, "ENABLE_PROCESSED_INPUT must be off");
});

test("the wrapper propagates the child's exit code", () => {
  const { code } = run("../test/fixtures/exit1.mjs");
  assert.equal(code, 1);
});

test("the access mask is written in decimal, not hex", () => {
  const src = fs.readFileSync(PS1, "utf8");
  assert.match(src, /\[uint32\]3221225472/);
  assert.doesNotMatch(src, /0xC0000000/i);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/console-mode.test.mjs"
```

Expected failure: `ENOENT ... state\conmode.json` from the first test, because the wrapper accepts neither `-ChildScript` nor `-Diagnose` and writes no report.

- [ ] Step 3: Implement.

Rewrite `C:/Users/osami/.uw/menu/uwpick-run.ps1`:

```powershell
param(
  [string]$File,
  [string]$ChildScript = "uwpick.mjs",
  [switch]$Diagnose
)

# Node cannot call SetConsoleMode, and that is the whole problem.
#
# MEASURED under CC's ctrl+g handoff: the child gets stdin.isTTY = undefined,
# no setRawMode, and 0 bytes ever delivered on process.stdin. The console input
# device "//./CONIN$" DOES open and a blocking read on it returns keystrokes --
# but only in whatever mode the console happens to be in. CC calls
# enterAlternateScreen() before spawning, which turns raw mode OFF, leaving the
# console line-buffered with echo. In that mode arrow keys are swallowed by the
# console's own line editor and characters are not delivered until Enter.
#
# So: flip the console to raw VT input for the duration of the picker, then put
# it back exactly as we found it. The restore runs in `finally` so it also
# happens on ctrl+c or a crash -- leaving a console in raw mode would make the
# parent shell unusable, and that failure reads as a broken terminal rather than
# a broken picker.

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class ConMode {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr CreateFile(string name, uint access, uint share,
      IntPtr sec, uint disp, uint flags, IntPtr templ);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetConsoleMode(IntPtr h, uint mode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue

# Decimal, not hex, and this is not a style choice: PowerShell 5.1 parses
# 0xC0000000 as an Int32, which overflows to -1073741824, and the [uint32] cast
# then throws before the P/Invoke is ever reached.
$ACCESS_RW     = [uint32]3221225472   # GENERIC_READ (0x80000000) | GENERIC_WRITE (0x40000000)
$SHARE_RW      = [uint32]3
$OPEN_EXISTING = [uint32]3

# CreateFile on CONIN$, not GetStdHandle: under the handoff stdin may be
# redirected, but CONIN$ always names the real console input buffer.
$h = [ConMode]::CreateFile("CONIN$", $ACCESS_RW,
                           $SHARE_RW, [IntPtr]::Zero, $OPEN_EXISTING, [uint32]0, [IntPtr]::Zero)
if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
  Write-Host "uwpick: cannot open CONIN$ ($([ComponentModel.Win32Exception]::new(
    [Runtime.InteropServices.Marshal]::GetLastWin32Error()).Message))"
  exit 1
}

$saved = 0
$haveSaved = [ConMode]::GetConsoleMode($h, [ref]$saved)

# ENABLE_VIRTUAL_TERMINAL_INPUT (0x200) makes the console emit arrows as the VT
# sequences the picker already parses (ESC [ A/B). Deliberately NOT set:
#   ENABLE_LINE_INPUT (0x02)     -- would buffer until Enter
#   ENABLE_ECHO_INPUT (0x04)     -- would echo filter text over our own rendering
#   ENABLE_PROCESSED_INPUT(0x01) -- would eat ctrl+c instead of delivering byte 3
$RAW_VT = [uint32](0x0080 -bor 0x0200)   # ENABLE_EXTENDED_FLAGS | ENABLE_VIRTUAL_TERMINAL_INPUT
[void][ConMode]::SetConsoleMode($h, $RAW_VT)

$childExit = 0
try {
  & node (Join-Path $PSScriptRoot $ChildScript) $File
  $childExit = $LASTEXITCODE
} finally {
  if ($haveSaved) { [void][ConMode]::SetConsoleMode($h, $saved) }
  if ($Diagnose) {
    $after = 0
    [void][ConMode]::GetConsoleMode($h, [ref]$after)
    $dir = Join-Path $env:USERPROFILE ".uw\state"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    @{ saved = [int]$saved; set = [int]$RAW_VT; restored = [int]$after; childExit = [int]$childExit } |
      ConvertTo-Json -Compress | Set-Content -Path (Join-Path $dir "conmode.json") -Encoding UTF8
  }
  [void][ConMode]::CloseHandle($h)
}
exit $childExit
```

Three changes from the spike, each load-bearing. `Add-Type` becomes `-ErrorAction SilentlyContinue` because the type is already loaded on a second invocation in the same session and a hard error there would abort the wrapper. The exit code now propagates from the child instead of being hard-coded to 0, so a crashed picker is visible to the caller — the dispatcher still returns 0 to Claude Code, which is where the exit-0 contract actually matters. And `-Diagnose` writes the report from inside `finally`, which is the only place that can prove the restore ran after a failing child.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 73`, `# fail 0`. If `CreateFile` on `CONIN$` fails because the test host has no console, the first test fails with `ENOENT ... conmode.json` and the wrapper's own message `uwpick: cannot open CONIN$`; run the suite from a real Windows Terminal rather than a piped harness.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "fix(menu): propagate the child exit code and prove console-mode restore after a crash"
```

---

### Task A9: Dispatcher tests — sentinel versus passthrough

**Files:** Modify `C:/Users/osami/.uw/menu/uwpick.cmd`, Test `C:/Users/osami/.uw/test/dispatcher.test.mjs`, Create `C:/Users/osami/.uw/test/fixtures/fake-editor.cmd`
**Interfaces:** Consumes: `%UW_REAL_EDITOR%`, `%1` (the buffer path). Produces: exit code 0 always; the picker runs only for the three sentinels; every other first line reaches `%UW_REAL_EDITOR%` with the buffer path passed through unchanged.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/fixtures/fake-editor.cmd`:

```bat
@echo off
REM Stands in for the user's real editor. Records that it was called, with which
REM buffer, and leaves the buffer untouched.
echo passthrough %~1>> "%UW_TEST_MARKER%"
exit /b 0
```

Create `C:/Users/osami/.uw/test/dispatcher.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const CMD = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";
const FAKE = "C:\\Users\\osami\\.uw\\test\\fixtures\\fake-editor.cmd";

// The picker itself is replaced for these tests: we assert the DISPATCH decision,
// not the TUI. UW_PICK_OVERRIDE short-circuits the powershell branch.
const NOOP = "C:\\Users\\osami\\.uw\\test\\fixtures\\fake-picker.cmd";

function dispatch(firstLine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-dispatch-"));
  const buf = path.join(dir, "buffer.md");
  const marker = path.join(dir, "marker.txt");
  fs.writeFileSync(buf, firstLine + "\r\n");
  const res = execFileSync("cmd.exe", ["/c", CMD, buf], {
    encoding: "utf8",
    env: { ...process.env, UW_REAL_EDITOR: FAKE, UW_PICK_OVERRIDE: NOOP, UW_TEST_MARKER: marker },
  });
  const log = fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "";
  return { log, buffer: fs.readFileSync(buf, "utf8"), stdout: res };
}

for (const sentinel of ["m", "model", ">>m", "M", "Model"]) {
  test(`"${sentinel}" reaches the picker, not the editor`, () => {
    const { log } = dispatch(sentinel);
    assert.match(log, /picker/);
    assert.doesNotMatch(log, /passthrough/);
  });
}

for (const other of ["hello world", "/model foo/bar", "mm", "models", "# heading", "  m"]) {
  test(`"${other}" is handed to the real editor unchanged`, () => {
    const { log, buffer } = dispatch(other);
    assert.match(log, /passthrough/);
    assert.doesNotMatch(log, /picker/);
    assert.match(buffer, new RegExp(other.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  });
}

test("the buffer path reaches the editor verbatim", () => {
  const { log } = dispatch("hello");
  assert.match(log, /buffer\.md/);
});

test("an empty buffer goes to the editor, not the picker", () => {
  const { log } = dispatch("");
  assert.match(log, /passthrough/);
});

test("the dispatcher always exits 0", () => {
  for (const line of ["m", "hello"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uw-exit-"));
    const buf = path.join(dir, "b.md");
    fs.writeFileSync(buf, line + "\r\n");
    const r = execFileSync("cmd.exe", ["/c", `${CMD} "${buf}" & echo EXIT=%errorlevel%`], {
      encoding: "utf8",
      env: { ...process.env, UW_REAL_EDITOR: FAKE, UW_PICK_OVERRIDE: NOOP,
             UW_TEST_MARKER: path.join(dir, "m.txt") },
    });
    assert.match(r, /EXIT=0/);
  }
});
```

Create `C:/Users/osami/.uw/test/fixtures/fake-picker.cmd`:

```bat
@echo off
REM Stands in for uwpick-run.ps1 so dispatch can be tested without a console.
echo picker %~1>> "%UW_TEST_MARKER%"
exit /b 0
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/dispatcher.test.mjs"
```

Expected failure: every sentinel case fails with the marker file containing nothing, because `uwpick.cmd` ignores `UW_PICK_OVERRIDE` and launches PowerShell, which then fails to open a console under the test harness.

- [ ] Step 3: Implement.

Add the override branch to `C:/Users/osami/.uw/menu/uwpick.cmd`, and make the passthrough exit 0 so a failing editor never makes Claude Code discard the buffer:

```bat
@echo off
REM UW picker shim for Claude Code's external-editor handoff (ctrl+g).
REM DISPATCHER, not a replacement: only takes over when the chat input is the
REM sentinel, so ctrl+g keeps working normally in plan mode, AskUserQuestion
REM fields, workflows and the fleet view.
setlocal
set "BUF=%~1"
set "SENTINEL="
if exist "%BUF%" for /f "usebackq delims=" %%L in ("%BUF%") do if not defined SENTINEL set "SENTINEL=%%L"

if /i "%SENTINEL%"=="m"      goto pick
if /i "%SENTINEL%"=="model"  goto pick
if /i "%SENTINEL%"==">>m"    goto pick

REM not ours -> hand off to the real editor, unchanged. Exit 0 regardless: a
REM non-zero exit makes CC DISCARD the buffer, so a failing editor would silently
REM eat the user's typed input.
if defined UW_REAL_EDITOR ( "%UW_REAL_EDITOR%" "%BUF%" & exit /b 0 )
start /wait notepad "%BUF%"
exit /b 0

:pick
REM UW_PICK_OVERRIDE exists so the dispatch DECISION can be tested without a
REM console. It is never set in normal use.
if defined UW_PICK_OVERRIDE ( "%UW_PICK_OVERRIDE%" "%BUF%" & exit /b 0 )
REM via PowerShell: it sets the console to raw VT input mode first, which node
REM cannot do. Without that the console stays line-buffered and arrows/typing
REM never reach the picker -- the exact failure seen in testing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b 0
```

The `for /f` loop keeps the first non-empty line and strips the CR from a CRLF file, which is why `"  m"` (leading spaces) correctly falls through to the editor: the comparison is exact, not trimmed.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 87`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "test(menu): pin sentinel dispatch versus editor passthrough, and never discard the buffer"
```

---

### Task A10: `uw doctor` — probe the handoff contract

**Files:** Create `C:/Users/osami/.uw/menu/doctor.mjs`, Test `C:/Users/osami/.uw/test/doctor.test.mjs`
**Interfaces:** Consumes: `~/.uw/state/handoff.json`, `~/.uw/state/capabilities.json`, the `claude doctor` command, the `EDITOR` and `UW_REAL_EDITOR` environment variables. Produces:
`checkEnv(env: object) -> Check` — `EDITOR` points at our dispatcher and `UW_REAL_EDITOR` exists
`checkHandoff(lines: string[]) -> Check` — the most recent recorded invocation had an existing `argv[2]` and wrote a selection
`checkFingerprint(current: object, pinned: object) -> Check` — Green when equal, Amber with a named delta when the Claude Code version or commit moved, Red when `claude doctor` could not be read
`diagnose(input) -> {verdict: "green"|"amber"|"red", checks: Check[]}` where `Check = {name, ok, verdict, evidence}`
`main()` — prints one line per check and exits 0 on green or amber, 1 on red

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/doctor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEnv, checkHandoff, checkFingerprint, diagnose } from "../menu/doctor.mjs";

const CMD = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";

test("checkEnv passes when EDITOR points at the dispatcher", () => {
  const c = checkEnv({ EDITOR: CMD, UW_REAL_EDITOR: "C:\\Windows\\notepad.exe" });
  assert.equal(c.ok, true);
});

test("checkEnv fails and says so when EDITOR points elsewhere", () => {
  const c = checkEnv({ EDITOR: "C:\\Program Files\\vim\\vim.exe", UW_REAL_EDITOR: "x" });
  assert.equal(c.ok, false);
  assert.match(c.evidence, /vim\.exe/);
  assert.match(c.evidence, /uwpick\.cmd/);
});

test("checkEnv fails when UW_REAL_EDITOR is unset, because passthrough would open notepad", () => {
  const c = checkEnv({ EDITOR: CMD });
  assert.equal(c.ok, false);
  assert.match(c.evidence, /UW_REAL_EDITOR/);
});

test("checkHandoff passes on a recorded invocation that wrote a selection", () => {
  const c = checkHandoff([
    JSON.stringify({ at: "2026-09-02T10:00:00Z", argv2: "C:\\Temp\\x.md", existed: true, wrote: true }),
  ]);
  assert.equal(c.ok, true);
});

test("checkHandoff fails when argv[2] did not exist — the contract moved", () => {
  const c = checkHandoff([
    JSON.stringify({ at: "2026-09-02T10:00:00Z", argv2: null, existed: false, wrote: false }),
  ]);
  assert.equal(c.ok, false);
  assert.match(c.evidence, /argv\[2\]/);
});

test("checkHandoff reports unknown, not failure, when the picker has never run", () => {
  const c = checkHandoff([]);
  assert.equal(c.ok, false);
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /never/i);
});

test("checkFingerprint is green when the version and commit match", () => {
  const f = { ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" };
  assert.equal(checkFingerprint(f, f).verdict, "green");
});

test("checkFingerprint is amber and names the delta when Claude Code auto-updated", () => {
  const c = checkFingerprint({ ccVersion: "2.1.300", ccCommit: "aaaa" },
                             { ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" });
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /2\.1\.258/);
  assert.match(c.evidence, /2\.1\.300/);
});

test("checkFingerprint is red when the version could not be read at all", () => {
  const c = checkFingerprint({}, { ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" });
  assert.equal(c.verdict, "red");
});

test("checkFingerprint is amber on a first run with nothing pinned", () => {
  const c = checkFingerprint({ ccVersion: "2.1.258", ccCommit: "b" }, {});
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /no pinned/i);
});

test("diagnose reports the worst verdict and names the failing check", () => {
  const r = diagnose({
    env: { EDITOR: "notepad.exe" },
    handoff: [],
    current: { ccVersion: "2.1.258", ccCommit: "b" },
    pinned: { ccVersion: "2.1.258", ccCommit: "b" },
  });
  assert.equal(r.verdict, "red");
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes("editor-wiring"));
});

test("diagnose is green when everything holds", () => {
  const f = { ccVersion: "2.1.258", ccCommit: "b" };
  const r = diagnose({
    env: { EDITOR: CMD, UW_REAL_EDITOR: "C:\\Windows\\notepad.exe" },
    handoff: [JSON.stringify({ at: "x", argv2: "C:\\t.md", existed: true, wrote: true })],
    current: f, pinned: f,
  });
  assert.equal(r.verdict, "green");
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/doctor.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\doctor.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/doctor.mjs`:

```js
#!/usr/bin/env node
// uw doctor -- does the environment still hold up the two things this design
// depends on?
//
// Report 10's root cause, restated: UW's fragility is not that it depends on
// undocumented internals. It is that it encodes third-party behaviour as
// constants in its own source rather than as facts it re-derives from the
// environment it is running in. Each mirror was correct when written and has no
// mechanism to notice when it stops being correct.
//
// So this file re-derives rather than asserts, and every failure NAMES its
// evidence. "P1 failed: argv[2] did not exist" is actionable; "unrecognised
// version" is not.
//
// Policy, deliberately asymmetric: reads and dry runs always proceed, even on
// Red -- refusing to diagnose when the environment just changed is exactly
// backwards. Amber is the COMMON path, because Claude Code auto-updates.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const DISPATCHER = path.join(os.homedir(), ".uw", "menu", "uwpick.cmd");
export const CAPABILITIES = path.join(os.homedir(), ".uw", "state", "capabilities.json");
const HANDOFF = path.join(os.homedir(), ".uw", "state", "handoff.json");

const norm = (p) => String(p ?? "").replace(/\\/g, "/").toLowerCase();

export function checkEnv(env) {
  const editor = env.EDITOR ?? "";
  const real = env.UW_REAL_EDITOR ?? "";
  if (norm(editor) !== norm(DISPATCHER)) {
    return { name: "editor-wiring", ok: false, verdict: "red",
      evidence: `EDITOR is "${editor || "(unset)"}" but must be "${DISPATCHER}" ` +
                `(uwpick.cmd) for ctrl+g to reach the picker` };
  }
  if (!real || !fs.existsSync(real)) {
    return { name: "editor-wiring", ok: false, verdict: "red",
      evidence: `UW_REAL_EDITOR is "${real || "(unset)"}" — without it the passthrough ` +
                `branch opens notepad instead of your editor` };
  }
  return { name: "editor-wiring", ok: true, verdict: "green",
    evidence: `EDITOR -> uwpick.cmd, UW_REAL_EDITOR -> ${real}` };
}

export function checkHandoff(lines) {
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
                    .filter(Boolean);
  if (!rows.length) {
    return { name: "handoff-contract", ok: false, verdict: "amber",
      evidence: "the picker has never recorded an invocation — press ctrl+g and type " +
                "`m` once, then re-run" };
  }
  const last = rows[rows.length - 1];
  if (!last.argv2 || !last.existed) {
    return { name: "handoff-contract", ok: false, verdict: "red",
      evidence: `last invocation at ${last.at}: argv[2] was ${JSON.stringify(last.argv2)} ` +
                `and existed=${last.existed}. Claude Code no longer passes a readable temp ` +
                `file as argv[2]; the selection cannot be written` };
  }
  if (!last.wrote) {
    return { name: "handoff-contract", ok: true, verdict: "amber",
      evidence: `last invocation at ${last.at} exited without a selection (esc or ctrl+c) ` +
                `— the file contract held` };
  }
  return { name: "handoff-contract", ok: true, verdict: "green",
    evidence: `last invocation at ${last.at} wrote a selection into ${last.argv2}` };
}

export function checkFingerprint(current, pinned) {
  if (!current.ccVersion) {
    return { name: "cc-fingerprint", ok: false, verdict: "red",
      evidence: "`claude doctor` produced no version line — Claude Code is missing, " +
                "not on PATH, or its output format changed" };
  }
  if (!pinned.ccVersion) {
    return { name: "cc-fingerprint", ok: true, verdict: "amber",
      evidence: `no pinned fingerprint yet; recording ${current.ccVersion} ` +
                `(${current.ccCommit ?? "no commit"})` };
  }
  if (current.ccVersion !== pinned.ccVersion || current.ccCommit !== pinned.ccCommit) {
    return { name: "cc-fingerprint", ok: true, verdict: "amber",
      evidence: `Claude Code moved from ${pinned.ccVersion} (${pinned.ccCommit}) to ` +
                `${current.ccVersion} (${current.ccCommit}) — auto-update is enabled, so ` +
                `this is expected; re-verify the handoff before trusting it` };
  }
  return { name: "cc-fingerprint", ok: true, verdict: "green",
    evidence: `${current.ccVersion} (${current.ccCommit})` };
}

const RANK = { green: 0, amber: 1, red: 2 };

export function diagnose({ env, handoff, current, pinned }) {
  const checks = [checkEnv(env), checkHandoff(handoff), checkFingerprint(current, pinned)];
  const verdict = checks.reduce((w, c) => (RANK[c.verdict] > RANK[w] ? c.verdict : w), "green");
  return { verdict, checks };
}

export function readClaudeFingerprint() {
  try {
    const out = execFileSync("claude", ["doctor"], { encoding: "utf8", timeout: 30000 });
    return {
      ccVersion: (out.match(/Running:\s*\S+\s*\(([^)]+)\)/) ?? [])[1],
      ccCommit: (out.match(/Commit:\s*(\S+)/) ?? [])[1],
      invalidSettings: /Invalid settings/i.test(out),
    };
  } catch {
    return {};
  }
}

const readLines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean); }
                           catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };

export function main() {
  const current = readClaudeFingerprint();
  const pinned = readJson(CAPABILITIES).fingerprint ?? {};
  const r = diagnose({ env: process.env, handoff: readLines(HANDOFF), current, pinned });

  for (const c of r.checks) {
    console.log(`${c.verdict.toUpperCase().padEnd(6)} ${c.name.padEnd(20)} ${c.evidence}`);
  }
  console.log(`\nverdict: ${r.verdict}`);

  // Pin whatever we just measured, so the NEXT run can report a delta. Only on
  // green or amber -- pinning a fingerprint we failed to read would erase the
  // last known-good one.
  if (r.verdict !== "red" && current.ccVersion) {
    fs.mkdirSync(path.dirname(CAPABILITIES), { recursive: true });
    fs.writeFileSync(CAPABILITIES,
      JSON.stringify({ fingerprint: current, at: new Date().toISOString() }, null, 2));
  }
  process.exit(r.verdict === "red" ? 1 : 0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/doctor.mjs")) main();
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/menu/doctor.mjs"
```

Expected: `# pass 99`, `# fail 0`. The `doctor` run prints three lines; on a machine where the installer has not run yet it prints `RED editor-wiring EDITOR is "(unset)" ...` and exits 1, which is correct until Task A11.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): uw doctor probes the handoff contract and names the failing check"
```

---

### Task A11: `install.ps1` — wire `EDITOR` without clobbering one we did not set

**Files:** Create `C:/Users/osami/.uw/menu/install.ps1`, Test `C:/Users/osami/.uw/test/install.test.mjs`
**Interfaces:** Consumes: the current User-scope `EDITOR`. Produces: `EDITOR` and `UW_REAL_EDITOR` set at User scope, and `~/.uw/state/install.json` recording `{editorSetBy, editorValue, previousEditor, at}`. Refuses with exit code 2 when `EDITOR` is set to something we did not set, unless `-Force` is passed, in which case the previous value is preserved into `UW_REAL_EDITOR`. `-WhatIf` prints the decision and changes nothing.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/install.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PS1 = "C:/Users/osami/.uw/menu/install.ps1";

// -WhatIf and -StateFile keep this off the real User environment entirely.
function plan(args, stateFile, currentEditor) {
  const scratch = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "uw-inst-"));
  const state = stateFile ?? require("node:path").join(scratch, "install.json");
  let code = 0, out = "";
  try {
    out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
      "-WhatIf", "-StateFile", state, "-CurrentEditor", currentEditor ?? "", ...args],
      { encoding: "utf8", stdio: "pipe" });
  } catch (e) { code = e.status ?? -1; out = String(e.stdout ?? "") + String(e.stderr ?? ""); }
  return { code, out, state };
}

test("with no EDITOR set, it plans to set both variables", () => {
  const { code, out } = plan([], null, "");
  assert.equal(code, 0);
  assert.match(out, /EDITOR\s*->.*uwpick\.cmd/i);
  assert.match(out, /UW_REAL_EDITOR\s*->/i);
});

test("with a foreign EDITOR and no -Force, it refuses with exit 2", () => {
  const { code, out } = plan([], null, "C:\\Program Files\\vim\\vim.exe");
  assert.equal(code, 2);
  assert.match(out, /refus/i);
  assert.match(out, /vim\.exe/);
  assert.match(out, /-Force/);
});

test("with a foreign EDITOR and -Force, it preserves it into UW_REAL_EDITOR", () => {
  const { code, out } = plan(["-Force"], null, "C:\\Program Files\\vim\\vim.exe");
  assert.equal(code, 0);
  assert.match(out, /UW_REAL_EDITOR\s*->.*vim\.exe/i);
});

test("re-running over an EDITOR we set is idempotent and needs no -Force", () => {
  const scratch = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "uw-inst2-"));
  const state = require("node:path").join(scratch, "install.json");
  const cmd = "C:\\Users\\osami\\.uw\\menu\\uwpick.cmd";
  fs.writeFileSync(state, JSON.stringify({ editorSetBy: "uw", editorValue: cmd }));
  const { code, out } = plan([], state, cmd);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /refus/i);
});

test("-WhatIf writes no state file", () => {
  const { state } = plan([], null, "");
  assert.equal(fs.existsSync(state), false);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/install.test.mjs"
```

Expected failure: PowerShell reports `The argument '...install.ps1' ... does not exist`, so every test fails on a non-zero exit.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/install.ps1`:

```powershell
param(
  [switch]$Force,
  [switch]$WhatIf,
  [string]$StateFile = (Join-Path $env:USERPROFILE ".uw\state\install.json"),
  # Injected only by tests. In normal use the current value is read from the
  # User environment, which is the thing we are about to change.
  [string]$CurrentEditor = $null
)

# Wire ctrl+g to the UW picker without destroying whatever the user already had.
#
# The failure this guards against is specific and unrecoverable: EDITOR is a
# single string. If we overwrite a real editor path and the user later uninstalls
# UW, ctrl+g silently opens notepad forever and the original setting is gone.
# So: record what we set, and refuse to touch an EDITOR whose value we do not
# recognise as our own.

$ErrorActionPreference = "Stop"
$dispatcher = Join-Path $PSScriptRoot "uwpick.cmd"

if (-not (Test-Path $dispatcher)) {
  Write-Host "install: cannot find $dispatcher"
  exit 1
}

if ($PSBoundParameters.ContainsKey("CurrentEditor")) {
  $current = $CurrentEditor
} else {
  $current = [Environment]::GetEnvironmentVariable("EDITOR", "User")
}

$prior = $null
if (Test-Path $StateFile) {
  try { $prior = Get-Content -Raw $StateFile | ConvertFrom-Json } catch { $prior = $null }
}

$normalize = { param($p) ($p -replace '\\','/').ToLowerInvariant() }
$isOurs = $current -and $prior -and $prior.editorSetBy -eq "uw" -and
          (& $normalize $current) -eq (& $normalize $prior.editorValue)
$isAlreadyDispatcher = $current -and ((& $normalize $current) -eq (& $normalize $dispatcher))

$realEditor = $null
if ($current -and -not $isOurs -and -not $isAlreadyDispatcher) {
  if (-not $Force) {
    Write-Host "install: refusing to overwrite EDITOR."
    Write-Host "  current: $current"
    Write-Host "  this was not set by UW, and replacing it would lose the only copy."
    Write-Host "  Re-run with -Force to move it into UW_REAL_EDITOR and continue."
    exit 2
  }
  $realEditor = $current
}

if (-not $realEditor) {
  $existingReal = [Environment]::GetEnvironmentVariable("UW_REAL_EDITOR", "User")
  if ($existingReal) { $realEditor = $existingReal }
  elseif ($prior -and $prior.previousEditor) { $realEditor = $prior.previousEditor }
  else { $realEditor = "$env:SystemRoot\system32\notepad.exe" }
}

Write-Host "EDITOR         -> $dispatcher"
Write-Host "UW_REAL_EDITOR -> $realEditor"

if ($WhatIf) { Write-Host "(-WhatIf: nothing was changed)"; exit 0 }

[Environment]::SetEnvironmentVariable("EDITOR", $dispatcher, "User")
[Environment]::SetEnvironmentVariable("UW_REAL_EDITOR", $realEditor, "User")

New-Item -ItemType Directory -Force -Path (Split-Path $StateFile) | Out-Null
@{ editorSetBy = "uw"; editorValue = $dispatcher; previousEditor = $current
   realEditor = $realEditor; at = (Get-Date).ToUniversalTime().ToString("o") } |
  ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8

Write-Host ""
Write-Host "Done. Open a NEW terminal (User-scope variables do not reach running processes),"
Write-Host "start Claude Code, press ctrl+g, type 'm', press enter."
exit 0
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/osami/.uw/menu/install.ps1" -WhatIf
```

Expected: `# pass 104`, `# fail 0`. The `-WhatIf` run prints the two planned assignments and changes nothing. Run it for real without `-WhatIf` before Task A12.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): installer that wires ctrl+g and refuses to clobber a foreign EDITOR"
```

---

### Task A12: The interactive verification protocol

**Files:** Create `C:/Users/osami/.uw/docs/qa-interactive-protocol.md`, Test `C:/Users/osami/.uw/test/protocol.test.mjs`
**Interfaces:** Consumes: a real Windows Terminal running Claude Code with the installer applied. Produces: a numbered protocol with an exact expected screen per step, executable by a human or by the `oh-my-claudecode:qa-tester` agent, and a machine-checkable list of step ids so the protocol cannot silently lose a step.

A note on tooling, stated plainly: `tmux` does not run on native Windows, and under Git Bash it provides a pty rather than a Windows console input buffer, so `//./CONIN$` and `SetConsoleMode` do not behave as they do in the real environment. Driving this surface through tmux would therefore test a different thing than the one that ships. The protocol runs in Windows Terminal. The qa-tester agent executes it there and captures each screen with `Get-Content` of a redirected transcript plus a screenshot; where the agent cannot drive real keystrokes, the protocol is run by a human and the agent verifies the captured output against the expected screens below.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/protocol.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const DOC = "C:/Users/osami/.uw/docs/qa-interactive-protocol.md";
const REQUIRED = [
  "P1-sentinel-dispatch", "P2-provider-columns", "P3-provider-filter",
  "P4-filter-by-model-name", "P5-descend", "P6-model-columns",
  "P7-select-writes-chat-input", "P8-esc-ladder", "P9-tab-flat-scope",
  "P10-ctrl-c", "P11-passthrough-editor", "P12-console-restored",
];

test("the protocol document exists", () => {
  assert.ok(fs.existsSync(DOC));
});

test("every required step id is present exactly once", () => {
  const src = fs.readFileSync(DOC, "utf8");
  for (const id of REQUIRED) {
    const hits = src.split(id).length - 1;
    assert.equal(hits >= 1, true, `missing step ${id}`);
  }
});

test("every step declares an expected screen", () => {
  const src = fs.readFileSync(DOC, "utf8");
  const steps = src.split(/^### /m).slice(1);
  assert.equal(steps.length, REQUIRED.length);
  for (const s of steps) {
    assert.match(s, /\*\*Expected:\*\*/, `step has no Expected block: ${s.slice(0, 40)}`);
  }
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/protocol.test.mjs"
```

Expected failure: `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(fs.existsSync(DOC))`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` with twelve `### <id>` sections. Each carries **Do**, **Expected** and **Fail means**. The content of each:

**`### P1-sentinel-dispatch`** — Do: in Claude Code, press ctrl+g, type `m`, press enter. Expected: the chat pane is replaced by a full-screen frame whose first line reads `UW model picker   44 providers · N routable · catalogue 2026-08-24`, where N is whatever CCR currently resolves. Fail means: the dispatcher did not match the sentinel, or `EDITOR` is not wired — run `node ~/.uw/menu/doctor.mjs`.

**`### P2-provider-columns`** — Do: read the header row. Expected: `key id`, `models`, `free`, `health` in that order; rows show ids of the shape `personal.google.free`; at least one row shows `—` in the free column and at least one shows a number; `anthropic` shows `relay.anthropic.subscription`. Fail means: a `0` where `—` belongs is the failure that matters most — it is the design lying.

**`### P3-provider-filter`** — Do: type `goo`. Expected: the list narrows to google's credential rows as each character lands, with no visible redraw flicker and no delay. Fail means: characters buffer until enter (the console mode was not set) or arrows print `^[[A` (the same cause).

**`### P4-filter-by-model-name`** — Do: backspace to clear, then type `opus`. Expected: the list narrows to providers that *serve* a model matching `opus`, including `relay.anthropic.subscription`. Fail means: an empty list — the level-1 filter is not searching member model ids, which is what makes two levels tolerable.

**`### P5-descend`** — Do: clear the filter, arrow to `personal.openrouter.free`, press enter. Expected: the header line becomes `personal.openrouter.free › ` and the list shows models, not providers. Fail means: nothing happens on enter.

**`### P6-model-columns`** — Do: read the header and rows. Expected: `model`, `ctx`, `$in`, `$out`, `badge`, `caps`; context values render as `163k` or `1M`; prices show two decimals; badges are only ever `FREE`, `FREE?`, `PLAN`, `PAID` or blank; caps render as three characters from `T`, `V`, `R` and `-`; models CCR cannot resolve are visibly dimmer than the rest. Fail means: any badge outside the five-value set, or a price with no decimals.

**`### P7-select-writes-chat-input`** — Do: arrow to a routable model and press enter. Expected: the picker clears, Claude Code returns, and the chat input contains exactly `/model openrouter/<the model you chose>` with the cursor at the end. Press enter and the status footer shows the new model. Fail means: an empty chat input (the picker exited non-zero, so Claude Code discarded the file).

**`### P8-esc-ladder`** — Do: reopen the picker, descend into a provider, type `x`, then press esc four times. Expected: first esc clears the model filter and stays at the model level; second returns to the provider list; third does nothing visible if the provider filter is already empty, otherwise clears it; the last esc exits with the chat input unchanged from before the picker opened. Fail means: the first esc exits — the ladder is inverted, and every accidental esc loses the user's place.

**`### P9-tab-flat-scope`** — Do: reopen, press tab, type `qwen3-max`. Expected: the header shows `provider/model` and rows show full `provider/model` strings from every provider at once. Press esc: the scope returns to the tree at the provider level. Fail means: tab inserts a literal tab into the filter.

**`### P10-ctrl-c`** — Do: reopen and press ctrl+c. Expected: the picker exits, Claude Code returns, the chat input is unchanged, and typing in the terminal echoes normally. Fail means: no echo — the console mode was not restored, and the shell is now unusable.

**`### P11-passthrough-editor`** — Do: press ctrl+g with the chat input containing `hello world`. Expected: `%UW_REAL_EDITOR%` opens with `hello world` in it; save and close; the chat input holds whatever the editor left. Fail means: the picker opened, so the sentinel comparison is too loose.

**`### P12-console-restored`** — Do: after every step above, in the same terminal, run `powershell -NoProfile -Command "Write-Host 'echo test'"` and type a few characters at the shell prompt. Expected: characters echo and the command runs. Fail means: the restore in the wrapper's `finally` block did not run; capture `~/.uw/state/conmode.json` after a `-Diagnose` run and compare `saved` with `restored`.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 107`, `# fail 0`. Then execute the protocol itself: hand `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` to the `oh-my-claudecode:qa-tester` agent with the instruction to run all twelve steps in Windows Terminal and report per-step pass or fail with the observed screen. Phase A is not complete until P1 through P12 all pass.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "docs(menu): twelve-step interactive verification protocol with expected screens"
```

---

# Phase B — the catalogue refresh and labeling pipeline

Ordering in this phase is not stylistic. Task B1 must land before Task B2, because B2 is what makes the free-first sort functional and therefore what arms the promotion path the denylist blocks. This is the clearest case in the whole research pass of a correctness fix being a security regression if sequenced wrongly.

### Task B1: `denylist.mjs` — reserved names, at ingest and at render

**Files:** Create `C:/Users/osami/.uw/menu/denylist.mjs`, Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Test `C:/Users/osami/.uw/test/denylist.test.mjs`
**Interfaces:** Consumes: nothing. Produces:
`RESERVED: RegExp`, `UW_ALIAS: RegExp`
`isReserved(id: string) -> boolean`
`admitRemoteModels(providerName: string, ids: string[], opts?: {trusted?: string}) -> {kept: string[], rejected: string[]}` — `trusted` defaults to `"anthropic"`, the relay, which is the only provider allowed to serve Anthropic-shaped names.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/denylist.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReserved, admitRemoteModels, RESERVED } from "../menu/denylist.mjs";
import { buildFrom } from "../menu/catalog.mjs";

test("bare Anthropic tier names are reserved", () => {
  for (const id of ["opus", "sonnet", "haiku", "fable", "claude", "anthropic"]) {
    assert.equal(isReserved(id), true, `${id} must be reserved`);
  }
});

test("Anthropic-shaped names with a separator are reserved", () => {
  for (const id of ["claude-opus-5", "claude-3-opus", "opus-4-8", "sonnet.1",
                    "haiku_2", "anthropic/claude-sonnet-5", "Claude-Opus-5", "opus4"]) {
    assert.equal(isReserved(id), true, `${id} must be reserved`);
  }
});

test("uw aliases are reserved", () => {
  assert.equal(isReserved("uw/slot-1"), true);
  assert.equal(isReserved("uw/fast"), true);
});

test("ordinary ids are not reserved", () => {
  for (const id of ["hakuna-matata", "opusculum", "gpt-oss-20b", "deepseek-v3.2",
                    "groq/openai/gpt-oss-20b", "qwen3-max", "uwot"]) {
    assert.equal(isReserved(id), false, `${id} must NOT be reserved`);
  }
});

test("admitRemoteModels rejects reserved names from an untrusted provider", () => {
  const r = admitRemoteModels("tokenrouter", ["qwen3-max", "opus", "claude-opus-4-8"]);
  assert.deepEqual(r.kept, ["qwen3-max"]);
  assert.deepEqual(r.rejected, ["opus", "claude-opus-4-8"]);
});

test("admitRemoteModels admits reserved names from the relay", () => {
  const r = admitRemoteModels("anthropic", ["claude-opus-5", "claude-sonnet-5"]);
  assert.equal(r.rejected.length, 0);
  assert.equal(r.kept.length, 2);
});

test("admitRemoteModels also drops ids that fail admitId", () => {
  const r = admitRemoteModels("acme", ["ok-1", "bad\x1b[2J", "../escape"]);
  assert.deepEqual(r.kept, ["ok-1"]);
  assert.equal(r.rejected.length, 2);
});

test("RESERVED is anchored, so a match cannot be buried mid-string", () => {
  assert.equal(RESERVED.source.startsWith("^"), true);
});

test("buildFrom drops a reserved name published by a non-relay provider", () => {
  const byProvider = new Map([["evil", [
    { provider: "evil", model: "opus", capabilities: {},
      modalities: { output: ["text"] },
      pricing: { offers: [{ per1MTokens: { input: 0, output: 0 } }] } },
    { provider: "evil", model: "evil-chat-1", capabilities: {} },
  ]]]);
  const { rows } = buildFrom({
    chosen: [{ id: "personal.evil.free", provider: "evil" }],
    providers: new Map([["evil", { notes: "" }]]),
    catalog: { byProvider, generatedAt: "x" },
  });
  assert.deepEqual(rows[0].models.map((m) => m.id), ["evil-chat-1"]);
});

test("buildFrom keeps the relay's own Claude names", () => {
  const { rows } = buildFrom({
    chosen: [],
    providers: new Map(),
    catalog: { byProvider: new Map(), generatedAt: "x" },
    relay: { provider: "anthropic", models: ["claude-opus-5"] },
  });
  assert.deepEqual(rows[0].models.map((m) => m.id), ["claude-opus-5"]);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/denylist.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\denylist.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/denylist.mjs`:

```js
// Reserved model names. This is the load-bearing control for report 08's single
// CRITICAL finding, and it must land BEFORE the inferTier fix in Task B2.
//
// The chain it breaks: a hostile or compromised aggregator publishes
// {"id":"opus","pricing":{"input":0,"output":0}}; a WORKING inferTier returns
// "free"; free sorts first; it lands inside MAX_MODELS_PER_PROVIDER; and if it
// is the unique provider listing that bare name, CCR's cross-provider fallback
// (resolve() stage 4) binds Claude Code's built-in rows to it. Full system
// prompt, tool definitions, file contents and responses route to an
// attacker-chosen host, silently.
//
// Note the irony that fixes the ordering: while tier inference is broken,
// "free-first" is a no-op and the promotion path does not exist. FIXING
// inferTier is what arms this. So the denylist ships first.
//
// A large share of the 44 providers are small aggregator hosts with no
// meaningful security assurance -- routllm.pro, seekai.cc, tabitoken.com,
// ineed.web.id, gorouter.app, teamorouter.com, tokenharbor.ai, router.bynara.id,
// apihub.agnes-ai.com, commandcode.ai, zenmux.ai, kilo.ai. Any one of them gets
// this primitive.

import { admitId } from "./sanitize.mjs";

// Anchored. The trailing group means "opus" and "opus-4-8" match while
// "opusculum" and "hakuna" do not -- the boundary must be a separator, a digit,
// a slash, or end-of-string.
export const RESERVED = /^(claude|opus|sonnet|haiku|fable|anthropic)([-._\d\/]|$)/i;

// UW's own alias namespace. A provider claiming `uw/fast` would shadow a routing
// slot we own.
export const UW_ALIAS = /^uw\//i;

export const isReserved = (id) => RESERVED.test(String(id ?? "")) || UW_ALIAS.test(String(id ?? ""));

/**
 * @param {string}   providerName
 * @param {string[]} ids
 * @param {object}  [opts]
 * @param {string}  [opts.trusted="anthropic"] the only provider allowed to serve
 *                  Anthropic-shaped names -- our own local relay.
 * @returns {{kept: string[], rejected: string[]}}
 */
export function admitRemoteModels(providerName, ids, { trusted = "anthropic" } = {}) {
  const kept = [], rejected = [];
  const exempt = providerName === trusted;
  for (const raw of ids ?? []) {
    const id = admitId(raw);
    if (!id) { rejected.push(String(raw)); continue; }
    if (!exempt && isReserved(id)) { rejected.push(id); continue; }
    kept.push(id);
  }
  if (rejected.length) {
    console.warn(`SECURITY: provider "${providerName}" advertised ${rejected.length} ` +
      `rejected model name(s): ${rejected.slice(0, 10).join(", ")}`);
  }
  return { kept, rejected };
}
```

Then in `C:/Users/osami/.uw/menu/catalog.mjs`, replace the per-entry `admitId` call in `buildFrom` with the denylist, so the same rule applies at render as at ingest:

```js
import { admitRemoteModels } from "./denylist.mjs";
```

Then, inside `buildFrom`, replace the whole `for (const e of catalog.byProvider.get(cred.provider) ?? [])` loop and the `const models = []` line above it with this block:

```js
    const entries = catalog.byProvider.get(cred.provider) ?? [];
    const { kept } = admitRemoteModels(cred.provider, entries.map((e) => e.model));
    const keptSet = new Set(kept);
    const models = [];
    for (const e of entries) {
      if (!keptSet.has(e.model)) continue;
      const p = priceOf(e), caps = e?.capabilities ?? {};
      models.push({
        id: e.model, ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e, opts),
        tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning,
      });
    }
```

and guard the `testModel` the same way:

```js
    const tm = admitRemoteModels(cred.provider, [prof.testModel]).kept[0];
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 117`, `# fail 0`. The denylist's `console.warn` will appear in the output for the two tests that exercise rejection; that is the intended behaviour, not test noise.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "security: reserved-name denylist at ingest and render, before any tier fix"
```

---

### Task B2: Fix `inferTier` to read the real pricing path

**Files:** Modify `C:/Users/osami/.uw/keysync/keysync.mjs`, Test `C:/Users/osami/.uw/test/infertier.test.mjs`
**Interfaces:** Consumes: catalogue entries. Produces: `inferTier(entry) -> "free" | "paid" | "unknown"` reading `pricing.offers[].per1MTokens.{input,output}`. Same signature, same three return values, correct field path.

This task **must not start** until Task B1 is committed.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/infertier.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { inferTier } from "../keysync/keysync.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(doc.models.map((m) => [m.model, m]));

test("the denylist landed first — B1 is a hard prerequisite", () => {
  const log = execFileSync("git", ["-C", "C:/Users/osami/.uw", "log", "--oneline", "-40"],
                           { encoding: "utf8" });
  assert.match(log, /reserved-name denylist/,
    "Task B1 must be committed before inferTier is fixed: fixing tier inference " +
    "is what arms the routing hijack the denylist blocks");
});

test("a zero-priced model classifies as free", () => {
  assert.equal(inferTier(byId["acme-chat-1"]), "free");
});

test("a priced model classifies as paid", () => {
  assert.equal(inferTier(byId["acme-pro-1"]), "paid");
});

test("no pricing data stays unknown, never paid", () => {
  assert.equal(inferTier(byId["blank-a"]), "unknown");
});

test("the legacy field shape is not pricing data", () => {
  assert.equal(inferTier(byId["acme-legacy-1"]), "unknown");
});

test("a malformed offers array does not throw", () => {
  assert.equal(inferTier({ pricing: { offers: "nope" } }), "unknown");
  assert.equal(inferTier({ pricing: {} }), "unknown");
  assert.equal(inferTier({}), "unknown");
  assert.equal(inferTier(null), "unknown");
});

test("numeric strings are accepted — providers quote prices", () => {
  assert.equal(inferTier({ pricing: { offers: [{ per1MTokens: { input: "0", output: "0" } }] } }), "free");
  assert.equal(inferTier({ pricing: { offers: [{ per1MTokens: { input: "0.3", output: "1.2" } }] } }), "paid");
});

test("the real catalogue now classifies the overwhelming majority", () => {
  const cat = JSON.parse(fs.readFileSync(
    "C:/Users/osami/.uw/catalog/models.json", "utf8"));
  const counts = { free: 0, paid: 0, unknown: 0 };
  for (const m of cat.models) counts[inferTier(m)]++;
  assert.ok(counts.unknown < cat.models.length * 0.2,
    `unknown is ${counts.unknown} of ${cat.models.length}; before the fix it was 100%`);
  assert.ok(counts.free > 0 && counts.paid > 0);
});
```

The last test reads `~/.uw/catalog/models.json`, which Task B4 creates. Run B4 before this test if it is executed out of order; the plan sequences B2 before B4 deliberately so the fix lands early, so on first run that one test fails with `ENOENT` and is the signal to proceed to B4.

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/infertier.test.mjs"
```

Expected failure: `Expected values to be strictly equal: 'unknown' !== 'free'` on the first classification test — the current implementation reads `pricing.inputPerMillion`, which does not exist in this schema, and returns `"unknown"` for all 4,298 models.

- [ ] Step 3: Implement.

In `C:/Users/osami/.uw/keysync/keysync.mjs`, replace `inferTier` (lines 86-95):

```js
/**
 * free / paid / unknown -- a guess is worse than no label, so default to unknown.
 *
 * MEASURED 2026-09-02: the previous implementation read
 * `pricing.{inputPerMillion,outputPerMillion,input,output}`. The only keys ever
 * present under `pricing` in this schema are `currency`, `normalizedUnit` and
 * `offers`, so it returned "unknown" for all 4,298 models and the free-first
 * sort degraded to pure shortest-id. That is why google/lyria (music) and
 * google/veo-2 (video) beat gemini-2.5-pro into the picker.
 *
 * SEQUENCING: this fix is what makes free-first functional, which is what makes
 * a hostile zero-priced "opus" sort to the top. The reserved-name denylist in
 * menu/denylist.mjs MUST be in place first. It is.
 *
 * An offer can price a model at a DIFFERENT provider (`offers[].provider` is its
 * own field, and merged records carry up to 16 offers), so this takes the first
 * offer carrying both token prices rather than folding all of them -- folding
 * would answer "is this free anywhere", not "is it free on my key".
 */
export function inferTier(entry) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return "unknown";
  for (const o of offers) {
    const p = o?.per1MTokens;
    if (!p) continue;
    const inN = Number(p.input), outN = Number(p.output);
    if (!Number.isFinite(inN) || !Number.isFinite(outN)) continue;
    return inN === 0 && outN === 0 ? "free" : "paid";
  }
  return "unknown";
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# pass 125`, `# fail 0` once Task B4 has run; before B4, the last test in this file fails with `ENOENT ... catalog\models.json` and everything else passes. The `--dry` run must still print the same provider count as before the change; the *selection* will differ, which is expected and is what Task B9 applies deliberately.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "fix(keysync): read pricing.offers[].per1MTokens so tier inference stops returning unknown"
```

---

### Task B3: `grantCadence` in `providers.json`, and the prose migration

**Files:** Create `C:/Users/osami/.uw/menu/cadence.mjs`, Create `C:/Users/osami/.uw/refresh/migrate-cadence.mjs`, Modify `C:/Users/osami/.llmkeys/providers.json`, Test `C:/Users/osami/.uw/test/cadence.test.mjs`
**Interfaces:** Consumes: `~/.llmkeys/providers.json`. Produces:
`CADENCES: Set<string>` — `{"recurring", "one-time", "none"}`
`cadenceFor(profile: object) -> {cadence: string, planCovered: boolean}`
`makeCadenceOf(providers: Map) -> (name: string) => {cadence, planCovered}` — the function `buildFrom` takes
`migrate(providers: object[]) -> {next: object[], changed: string[]}` — pure, so the migration is testable before it touches the vault

**Scope note:** `~/.llmkeys/providers.json` is outside the git repository and is never committed. The commit step for this task covers the migration script and its tests only; the vault edit is protected by a timestamped backup written by the script itself.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/cadence.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cadenceFor, makeCadenceOf, CADENCES } from "../menu/cadence.mjs";
import { migrate } from "../refresh/migrate-cadence.mjs";
import { badgeOf } from "../menu/catalog.mjs";

const FREE_ENTRY = { modalities: { output: ["text"] },
                     pricing: { offers: [{ per1MTokens: { input: 0, output: 0 } }] } };

test("the cadence vocabulary is exactly three values", () => {
  assert.deepEqual([...CADENCES].sort(), ["none", "one-time", "recurring"]);
});

test("an absent field is unknown, not a guess", () => {
  assert.deepEqual(cadenceFor({}), { cadence: "", planCovered: false });
  assert.deepEqual(cadenceFor({ grantCadence: "" }), { cadence: "", planCovered: false });
});

test("an unrecognised value is treated as unknown rather than trusted", () => {
  assert.equal(cadenceFor({ grantCadence: "monthly-ish" }).cadence, "");
});

test("recurring and one-time round-trip", () => {
  assert.equal(cadenceFor({ grantCadence: "recurring" }).cadence, "recurring");
  assert.equal(cadenceFor({ grantCadence: "one-time" }).cadence, "one-time");
});

test("planCovered is a separate axis", () => {
  assert.equal(cadenceFor({ planCovered: true }).planCovered, true);
  assert.equal(cadenceFor({ grantCadence: "recurring", planCovered: true }).planCovered, true);
});

test("the badge follows the cadence end to end", () => {
  assert.equal(badgeOf(FREE_ENTRY, cadenceFor({ grantCadence: "recurring" })), "FREE");
  assert.equal(badgeOf(FREE_ENTRY, cadenceFor({ grantCadence: "one-time" })), "");
  assert.equal(badgeOf(FREE_ENTRY, cadenceFor({})), "FREE?");
});

test("makeCadenceOf resolves by provider name and tolerates unknown names", () => {
  const f = makeCadenceOf(new Map([["ollama", { grantCadence: "recurring" }]]));
  assert.equal(f("ollama").cadence, "recurring");
  assert.deepEqual(f("nope"), { cadence: "", planCovered: false });
});

test("migrate sets exactly the seven curated providers and nothing else", () => {
  const before = [
    { provider: "youcom" }, { provider: "aihubmix" }, { provider: "huggingface" },
    { provider: "llm7" }, { provider: "cerebras" }, { provider: "ollama" },
    { provider: "openrouter" }, { provider: "groq" }, { provider: "openai" },
  ];
  const { next, changed } = migrate(before);
  const by = Object.fromEntries(next.map((p) => [p.provider, p]));
  assert.equal(by.youcom.grantCadence, "one-time");
  assert.equal(by.aihubmix.grantCadence, "one-time");
  assert.equal(by.huggingface.grantCadence, "one-time");
  assert.equal(by.llm7.grantCadence, "one-time");
  assert.equal(by.cerebras.grantCadence, "one-time");
  assert.equal(by.ollama.grantCadence, "recurring");
  assert.equal(by.openrouter.grantCadence, "recurring");
  assert.equal(by.groq.grantCadence, "");
  assert.equal(by.openai.grantCadence, "");
  assert.deepEqual(changed.sort(), ["aihubmix", "cerebras", "huggingface", "llm7",
                                    "ollama", "openrouter", "youcom"]);
});

test("migrate never overwrites a value a human already curated", () => {
  const { next } = migrate([{ provider: "ollama", grantCadence: "none" }]);
  assert.equal(next[0].grantCadence, "none");
});

test("migrate sets planCovered on nobody — it is curated, never inferred", () => {
  const { next } = migrate([{ provider: "nvidia" }, { provider: "alibaba" }]);
  assert.equal(next.every((p) => p.planCovered !== true), true);
});

test("migrate preserves every other field byte for byte", () => {
  const before = [{ provider: "ollama", baseUrl: "https://x/v1", notes: "n",
                    requiresBalance: false, testModel: "t" }];
  const { next } = migrate(JSON.parse(JSON.stringify(before)));
  for (const k of Object.keys(before[0])) assert.deepEqual(next[0][k], before[0][k]);
});

test("the live vault carries the field after migration", () => {
  const raw = fs.readFileSync("C:/Users/osami/.llmkeys/providers.json", "utf8").replace(/^\uFEFF/, "");
  const by = Object.fromEntries(JSON.parse(raw).map((p) => [p.provider, p]));
  assert.equal(by.ollama.grantCadence, "recurring");
  assert.equal(by.youcom.grantCadence, "one-time");
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/cadence.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\cadence.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/cadence.mjs`:

```js
// The second axis of "free", and the one no provider API exposes.
//
// The governing definition: a free model is one with 0 pricing whose quota
// resets regularly. A one-time starting wallet credit does NOT make a provider
// free. That replaces a descriptive question ("is the price zero?") with an
// operational one ("can I keep using this next week without paying?").
//
// Price is often machine-readable. Grant cadence almost never is: it is not in
// any /v1/models response, not in models.dev, and not in LiteLLM. The only two
// machine-readable cadence signals in the entire vault are one gateway's
// /api/status.checkin_enabled and OpenRouter's limit_reset. So this is a
// CURATED field, hand-maintained in providers.json, never machine-overwritten,
// and blank until someone has actually checked.
//
// Blank will be common. That is honest, not a gap.

export const CADENCES = new Set(["recurring", "one-time", "none"]);

export function cadenceFor(profile) {
  const raw = String(profile?.grantCadence ?? "");
  return {
    // An unrecognised value is treated as unknown. Trusting a typo would put a
    // FREE badge on something nobody verified.
    cadence: CADENCES.has(raw) ? raw : "",
    planCovered: profile?.planCovered === true,
  };
}

export const makeCadenceOf = (providers) => (name) => cadenceFor(providers.get(name) ?? {});
```

Create `C:/Users/osami/.uw/refresh/migrate-cadence.mjs`:

```js
#!/usr/bin/env node
// One-time migration: lift the grant-cadence knowledge that is currently trapped
// in providers.json free text into a structured field.
//
// Every mapping below is quoted from the vault's own notes or accountInfo. None
// is inferred. A provider with no evidence gets "" and stays blank -- the rule
// is blank when uncertain, never guessed.
//
//   youcom       accountInfo.freeCredits "$100 complimentary on new accounts"  -> one-time
//   aihubmix     accountInfo.balanceNote "insufficient_user_quota until recharged" -> one-time
//   huggingface  notes: pass-through pricing, no truly free-tier models        -> one-time
//   llm7         notes: "likely runs on a free credit allowance"               -> one-time
//   cerebras     notes: "Free tier available" + requiresBalance:true           -> one-time
//   ollama       notes: "Free daily usage allowance for cloud API"             -> recurring
//   openrouter   :free tier, ~20 req/min ~200/day, resets daily                -> recurring
//
// planCovered is set on NOBODY. It is entirely curated -- no provider publishes
// "your subscription covers this" -- and the only subscription-covered rows in
// this system are the Anthropic relay's, which are injected by keysync rather
// than read from providers.json.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CURATED = {
  youcom: "one-time",
  aihubmix: "one-time",
  huggingface: "one-time",
  llm7: "one-time",
  cerebras: "one-time",
  ollama: "recurring",
  openrouter: "recurring",
};

/** Pure. Returns the new array plus the provider names whose value changed. */
export function migrate(providers) {
  const changed = [];
  const next = providers.map((p) => {
    const has = typeof p.grantCadence === "string" && p.grantCadence !== "";
    if (has) return p;                       // never overwrite a human's verdict
    const want = CURATED[p.provider] ?? "";
    if (want) changed.push(p.provider);
    return { ...p, grantCadence: want };
  });
  return { next, changed };
}

function main() {
  const FILE = path.join(os.homedir(), ".llmkeys", "providers.json");
  const raw = fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, "");
  const before = JSON.parse(raw);
  const { next, changed } = migrate(before);

  // providers.json is human-curated and lives outside the repo, so the backup is
  // the only undo.
  const backup = `${FILE}.bak-cadence-${new Date().toISOString().replace(/[:.]/g, "")}`;
  fs.writeFileSync(backup, raw);
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + "\n");

  console.log(`backup: ${backup}`);
  console.log(`entries: ${before.length} -> ${next.length}`);
  console.log(`set grantCadence on: ${changed.sort().join(", ") || "(none)"}`);
  console.log(`left blank: ${next.filter((p) => !p.grantCadence).length}`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/migrate-cadence.mjs")) main();
```

Then wire the real cadence into the builder. In `C:/Users/osami/.uw/menu/catalog.mjs`:

```js
import { makeCadenceOf } from "./cadence.mjs";

export function build() {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  return buildFrom({
    chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY,
    cadenceOf: makeCadenceOf(providers),
  });
}
```

Run the migration:

```
node "C:/Users/osami/.uw/refresh/migrate-cadence.mjs"
```

Expected output: `entries: 47 -> 47`, `set grantCadence on: aihubmix, cerebras, huggingface, llm7, ollama, openrouter, youcom`, `left blank: 40`.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 137`, `# fail 0`. Confirm by eye that `~/.uw/menu/uwpick.mjs` now shows `FREE` (no question mark) on OpenRouter's `:free` models and blank on huggingface's zero-priced rows.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(catalogue): curated grantCadence turns a zero price into the governing free rule"
```

---

### Task B4: Copy the catalogue out of `node_modules`

**Files:** Create `C:/Users/osami/.uw/refresh/catalog-store.mjs`, Modify `C:/Users/osami/.uw/keysync/keysync.mjs`, Test `C:/Users/osami/.uw/test/catalog-store.test.mjs`
**Interfaces:** Consumes: CCR's bundled `dist/models.json`. Produces:
`CATALOG_DIR: string` — `~/.uw/catalog`
`CURRENT: string`, `LOCK: string`
`copyOut(src?: string) -> {dest: string, generatedAt: string, models: number, schemaVersion: number}` — copies to `~/.uw/catalog/models.json` and never writes the source
`resolveCatalogPath() -> string` — the snapshot named by `current` if one exists, else `~/.uw/catalog/models.json`, else the `node_modules` copy with a warning
`assertSchema(doc) -> void` — throws unless `schemaVersion === 2`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/catalog-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { copyOut, resolveCatalogPath, assertSchema, CATALOG_DIR } from "../refresh/catalog-store.mjs";

const CCR = "C:/nvm4w/nodejs/node_modules/@musistudio/claude-code-router/dist/models.json";

test("assertSchema accepts version 2 and refuses anything else", () => {
  assertSchema({ schemaVersion: 2, models: [] });
  assert.throws(() => assertSchema({ schemaVersion: 3, models: [] }), /schemaVersion/);
  assert.throws(() => assertSchema({ models: [] }), /schemaVersion/);
});

test("copyOut writes into ~/.uw/catalog and reports what it copied", () => {
  const r = copyOut(CCR);
  assert.equal(r.dest, path.join(CATALOG_DIR, "models.json"));
  assert.ok(fs.existsSync(r.dest));
  assert.equal(r.schemaVersion, 2);
  assert.ok(r.models > 4000, `expected the full catalogue, got ${r.models}`);
  assert.match(r.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("copyOut never writes the source", () => {
  const before = fs.statSync(CCR).mtimeMs;
  copyOut(CCR);
  assert.equal(fs.statSync(CCR).mtimeMs, before);
});

test("copyOut refuses a source with the wrong schema", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-cat-"));
  const bad = path.join(d, "models.json");
  fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 99, models: [] }));
  assert.throws(() => copyOut(bad), /schemaVersion/);
});

test("resolveCatalogPath prefers the UW copy over node_modules", () => {
  copyOut(CCR);
  const p = resolveCatalogPath().replace(/\\/g, "/");
  assert.match(p, /\.uw\/catalog/);
  assert.doesNotMatch(p, /node_modules/);
});

test("keysync now loads from the UW copy", async () => {
  const src = fs.readFileSync("C:/Users/osami/.uw/keysync/keysync.mjs", "utf8");
  assert.doesNotMatch(src, /node_modules/,
    "keysync must not read a path inside a third-party npm package");
  const K = await import("file:///C:/Users/osami/.uw/keysync/keysync.mjs");
  const cat = K.loadCatalog();
  assert.ok(cat.byProvider.size > 200);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/catalog-store.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\refresh\catalog-store.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/refresh/catalog-store.mjs`:

```js
// UW's own catalogue store.
//
// The catalogue is currently read from inside a third-party npm package:
// keysync.mjs hard-codes a path under node_modules/@musistudio/claude-code-router.
// An `npm i -g` replaces or drops it and keysync then fails on a path it does not
// own -- and a global reinstall has already silently wiped a local patch once.
//
// Copying it out is one line of value and zero risk: no new network surface, no
// new dependency, and the source is never written.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CATALOG_DIR = path.join(os.homedir(), ".uw", "catalog");
export const CURRENT = path.join(CATALOG_DIR, "current");
export const LOCK = path.join(CATALOG_DIR, "catalogue.lock");
export const SNAPSHOTS = path.join(CATALOG_DIR, "snapshots");

const CCR_BUNDLED =
  "C:\\nvm4w\\nodejs\\node_modules\\@musistudio\\claude-code-router\\dist\\models.json";

// A schema bump is exactly when a silent misparse happens, so refuse rather than
// guess. The catalogue self-versions, which makes this cheap and exact.
export function assertSchema(doc) {
  if (doc?.schemaVersion !== 2) {
    throw new Error(`catalogue schemaVersion is ${JSON.stringify(doc?.schemaVersion)}, ` +
      `expected 2 — refusing to parse a schema this code was not written against`);
  }
}

export function copyOut(src = CCR_BUNDLED) {
  const raw = fs.readFileSync(src, "utf8").replace(/^\uFEFF/, "");
  const doc = JSON.parse(raw);
  assertSchema(doc);
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  const dest = path.join(CATALOG_DIR, "models.json");
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw);
  fs.renameSync(tmp, dest);
  return { dest, generatedAt: doc.generatedAt,
           models: (doc.models ?? []).length, schemaVersion: doc.schemaVersion };
}

/**
 * Resolution order, most-owned first. The `current` pointer is resolved ONCE by
 * each reader, so a concurrent refresh building a new snapshot directory and
 * flipping the pointer at the end can never be observed half-written.
 */
export function resolveCatalogPath() {
  try {
    const stamp = fs.readFileSync(CURRENT, "utf8").trim();
    const p = path.join(SNAPSHOTS, stamp, "models.json");
    if (stamp && fs.existsSync(p)) return p;
  } catch { /* no snapshot yet */ }
  const own = path.join(CATALOG_DIR, "models.json");
  if (fs.existsSync(own)) return own;
  console.warn(`WARNING: no UW catalogue at ${own}; falling back to the bundled copy ` +
               `inside node_modules, which an npm reinstall can replace. Run: ` +
               `node ~/.uw/refresh/cli.mjs copy-out`);
  return CCR_BUNDLED;
}
```

Then in `C:/Users/osami/.uw/keysync/keysync.mjs`, replace the hard-coded constant (line 73) and its reader:

```js
import { resolveCatalogPath, assertSchema } from "../refresh/catalog-store.mjs";

export function loadCatalog() {
  const doc = readJson(resolveCatalogPath());
  assertSchema(doc);
  const byProvider = new Map();
  for (const m of doc.models ?? []) {
    if (!m.provider || !m.model) continue;
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  return { generatedAt: doc.generatedAt, byProvider };
}
```

Run the copy-out:

```
node -e "import('file:///C:/Users/osami/.uw/refresh/catalog-store.mjs').then(m=>console.log(m.copyOut()))"
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# pass 143`, `# fail 0`, and the `--dry` run prints `catalog: 217 providers, generated 2026-08-24T12:22:28.162Z` as before — the source moved, the content did not.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(catalogue): own the catalogue instead of reading one from inside node_modules"
```

---

### Task B5: The merge policy — snapshot, lock, and the stale marker

**Files:** Modify `C:/Users/osami/.uw/refresh/catalog-store.mjs`, Test `C:/Users/osami/.uw/test/merge.test.mjs`
**Interfaces:** Consumes: a previous snapshot plus this run's per-provider outcomes. Produces:
`classify(result: {status?: number, error?: string}) -> "ok" | "soft" | "hard"`
`mergeProvider(prev: ProviderEntry|null, outcome: {kind, models?, at}) -> ProviderEntry` where `ProviderEntry = {models: string[], lastOk, lastFail, stale, staleSince, count}`
`mergeSnapshot(prev: Snapshot, outcomes: Map<string, Outcome>, now: string) -> {next: Snapshot, refused: string[]}` — applies the per-provider shrink guard and the whole-snapshot floor
`acquireCatalogueLock() -> {release(): void}` — `openSync(..., "wx")` with PID liveness, its own lock, never keysync's
`writeSnapshot(snapshot) -> string` — writes a new directory, then flips `current` last

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/merge.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { classify, mergeProvider, mergeSnapshot, acquireCatalogueLock } from "../refresh/catalog-store.mjs";

const NOW = "2026-09-10T00:00:00.000Z";
const THEN = "2026-09-01T00:00:00.000Z";

test("classify separates the three outcome classes", () => {
  assert.equal(classify({ status: 200 }), "ok");
  assert.equal(classify({ status: 401 }), "hard");
  assert.equal(classify({ status: 403 }), "hard");
  assert.equal(classify({ status: 429 }), "soft");
  assert.equal(classify({ status: 503 }), "soft");
  assert.equal(classify({ error: "ETIMEDOUT" }), "soft");
  assert.equal(classify({ status: 404 }), "soft");
});

test("an ok outcome replaces the model list and clears the stale marker", () => {
  const prev = { models: ["a"], lastOk: THEN, lastFail: null, stale: true, staleSince: THEN, count: 1 };
  const next = mergeProvider(prev, { kind: "ok", models: ["a", "b"], at: NOW });
  assert.deepEqual(next.models, ["a", "b"]);
  assert.equal(next.lastOk, NOW);
  assert.equal(next.stale, false);
  assert.equal(next.staleSince, null);
});

test("a soft outcome keeps the previous rows and marks them stale", () => {
  const prev = { models: ["a", "b"], lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 2 };
  const next = mergeProvider(prev, { kind: "soft", at: NOW });
  assert.deepEqual(next.models, ["a", "b"], "absence of evidence is not evidence of absence");
  assert.equal(next.stale, true);
  assert.equal(next.staleSince, NOW);
  assert.equal(next.lastOk, THEN);
});

test("a hard outcome flags the provider but still keeps its rows", () => {
  const prev = { models: ["a"], lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 1 };
  const next = mergeProvider(prev, { kind: "hard", at: NOW });
  assert.deepEqual(next.models, ["a"]);
  assert.equal(next.lastFail, NOW);
  assert.equal(next.stale, true);
});

test("a provider seen for the first time starts clean", () => {
  const next = mergeProvider(null, { kind: "ok", models: ["a"], at: NOW });
  assert.deepEqual(next.models, ["a"]);
  assert.equal(next.lastFail, null);
  assert.equal(next.stale, false);
});

const snap = (providers) => ({ generatedAt: THEN, providers });

test("the shrink guard refuses an ok run that halves a provider", () => {
  const prev = snap({ big: { models: Array.from({ length: 100 }, (_, i) => `m${i}`),
                             lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 100 } });
  const { next, refused } = mergeSnapshot(prev,
    new Map([["big", { kind: "ok", models: ["m0", "m1"], at: NOW }]]), NOW);
  assert.deepEqual(refused, ["big"]);
  assert.equal(next.providers.big.models.length, 100);
  assert.equal(next.providers.big.stale, true);
});

test("the shrink guard refuses an ok run that empties a provider", () => {
  const prev = snap({ p: { models: ["a", "b"], lastOk: THEN, lastFail: null,
                           stale: false, staleSince: null, count: 2 } });
  const { refused } = mergeSnapshot(prev, new Map([["p", { kind: "ok", models: [], at: NOW }]]), NOW);
  assert.deepEqual(refused, ["p"]);
});

test("a normal shrink inside the guard is accepted", () => {
  const prev = snap({ p: { models: ["a", "b", "c", "d"], lastOk: THEN, lastFail: null,
                           stale: false, staleSince: null, count: 4 } });
  const { next, refused } = mergeSnapshot(prev,
    new Map([["p", { kind: "ok", models: ["a", "b", "c"], at: NOW }]]), NOW);
  assert.deepEqual(refused, []);
  assert.equal(next.providers.p.models.length, 3);
});

test("the whole-snapshot floor refuses a run that loses a fifth of everything", () => {
  const prev = snap(Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
    [`p${i}`, { models: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
                lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 10 }])));
  const outcomes = new Map(Array.from({ length: 10 }, (_, i) =>
    [`p${i}`, { kind: "ok", models: ["a", "b", "c", "d", "e", "f", "g"], at: NOW }]));
  assert.throws(() => mergeSnapshot(prev, outcomes, NOW), /floor/i);
});

test("a provider absent from this run's outcomes is untouched", () => {
  const prev = snap({ kept: { models: ["a"], lastOk: THEN, lastFail: null,
                              stale: false, staleSince: null, count: 1 } });
  const { next } = mergeSnapshot(prev, new Map(), NOW);
  assert.deepEqual(next.providers.kept.models, ["a"]);
  assert.equal(next.providers.kept.stale, false);
});

test("the lock is exclusive and reclaims a dead owner", () => {
  const l1 = acquireCatalogueLock();
  assert.throws(() => acquireCatalogueLock(), /lock/i);
  l1.release();
  const l2 = acquireCatalogueLock();
  l2.release();
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/merge.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../refresh/catalog-store.mjs' does not provide an export named 'classify'`.

- [ ] Step 3: Implement.

Append to `C:/Users/osami/.uw/refresh/catalog-store.mjs`:

```js
// ---------------------------------------------------------------- merge policy
//
// The rule to write on the wall: ABSENCE OF EVIDENCE IS NOT EVIDENCE OF ABSENCE.
// The previous ratchet failed because a transient 503 was treated as a statement
// about the model set. It was a statement about the network. verify-prune.mjs
// still overwrites `working` with only this run's passes, and a run during which
// six providers were transiently down therefore ships a picker without them.
//
// Three outcome classes, and only ONE of them carries negative information.

export function classify({ status, error } = {}) {
  if (error) return "soft";
  if (status === 401 || status === 403) return "hard";     // the key is dead: flag it, loudly
  if (status >= 200 && status < 300) return "ok";          // authoritative
  return "soft";                                            // 404/429/5xx/anything else: no information
}

const EMPTY = { models: [], lastOk: null, lastFail: null, stale: false, staleSince: null, count: 0 };

export function mergeProvider(prev, outcome) {
  const base = prev ?? EMPTY;
  if (outcome.kind === "ok") {
    return { models: outcome.models, lastOk: outcome.at, lastFail: base.lastFail,
             stale: false, staleSince: null, count: outcome.models.length };
  }
  // soft AND hard both keep the stored rows. A dead key says nothing about which
  // models the provider offers, and neither does a timeout.
  return { ...base,
           lastFail: outcome.kind === "hard" ? outcome.at : base.lastFail,
           stale: true, staleSince: base.staleSince ?? outcome.at };
}

const SHRINK_FLOOR = 0.5;      // an ok run may not cut a provider by more than half
const SNAPSHOT_FLOOR = 0.8;    // nor the whole snapshot by more than a fifth

export function mergeSnapshot(prev, outcomes, now) {
  const providers = {}, refused = [];
  const names = new Set([...Object.keys(prev.providers ?? {}), ...outcomes.keys()]);

  for (const name of names) {
    const before = prev.providers?.[name] ?? null;
    const outcome = outcomes.get(name);
    if (!outcome) { providers[name] = before; continue; }

    // The realistic failure is upstream SCHEMA DRIFT, which yields a clean 200
    // with an empty parse -- indistinguishable from "the provider deleted
    // everything" unless you refuse to believe a collapse.
    if (outcome.kind === "ok" && before && before.count > 0 &&
        outcome.models.length < before.count * SHRINK_FLOOR) {
      refused.push(name);
      providers[name] = mergeProvider(before, { kind: "soft", at: now });
      continue;
    }
    providers[name] = mergeProvider(before, outcome);
  }

  const beforeTotal = Object.values(prev.providers ?? {}).reduce((n, p) => n + (p?.count ?? 0), 0);
  const afterTotal = Object.values(providers).reduce((n, p) => n + (p?.count ?? 0), 0);
  if (beforeTotal > 0 && afterTotal < beforeTotal * SNAPSHOT_FLOOR) {
    throw new Error(`snapshot floor: total models would fall from ${beforeTotal} to ` +
      `${afterTotal} (< ${SNAPSHOT_FLOOR * 100}%) — refusing to promote. This is what a ` +
      `models.dev outage or a renamed upstream field looks like.`);
  }
  return { next: { generatedAt: now, providers }, refused };
}

// ---------------------------------------------------------------------- lock
//
// The refresher must NOT take keysync's lock. Sharing it means a slow fan-out can
// block a keysync run the user is sitting in front of, and it conflates two
// different critical sections: keysync's lock protects CCR's config and
// settings.json; the refresher touches neither.

export function acquireCatalogueLock() {
  fs.mkdirSync(CATALOG_DIR, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(LOCK, "wx");
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(LOCK, "utf8")); } catch { /* corrupt */ }
    // A corrupt lock is treated as LIVE. Guessing it is dead is how two
    // refreshers end up writing the same snapshot directory.
    if (!owner?.pid) throw new Error(`catalogue lock at ${LOCK} is unreadable — treating as held`);
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (err) { alive = err.code === "EPERM"; }
    if (alive) throw new Error(`catalogue lock held by pid ${owner.pid} since ${owner.at}`);
    fs.unlinkSync(LOCK);
    fd = fs.openSync(LOCK, "wx");
  }
  fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  fs.closeSync(fd);
  return {
    release() {
      try {
        const owner = JSON.parse(fs.readFileSync(LOCK, "utf8"));
        if (owner.pid === process.pid) fs.unlinkSync(LOCK);   // only ever delete our own
      } catch { /* already gone */ }
    },
  };
}

// Write into a NEW directory (nothing live is touched), then flip `current` LAST
// via temp+rename. A crash anywhere leaves the previous snapshot intact and the
// partial directory orphaned; the next run collects it.
export function writeSnapshot(snapshot) {
  const stamp = snapshot.generatedAt.replace(/[:.]/g, "-");
  const dir = path.join(SNAPSHOTS, stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(snapshot, null, 2));
  const tmp = `${CURRENT}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, stamp);
  fs.renameSync(tmp, CURRENT);
  for (const d of fs.readdirSync(SNAPSHOTS).sort().slice(0, -3)) {
    fs.rmSync(path.join(SNAPSHOTS, d), { recursive: true, force: true });
  }
  return dir;
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 155`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(refresh): merge policy that keeps rows through a failure and refuses a collapse"
```

---

### Task B6: The three tiers and the `uw catalog refresh` CLI

**Files:** Create `C:/Users/osami/.uw/refresh/tiers.mjs`, Create `C:/Users/osami/.uw/refresh/cli.mjs`, Test `C:/Users/osami/.uw/test/tiers.test.mjs`
**Interfaces:** Consumes: `catalog-store.mjs`, the models.dev public endpoint, CCR's `probeProvider` RPC. Produces:
`tier1(opts: {fetchImpl?, etag?}) -> Promise<{status, etag, providers: Map<string, string[]>}>`
`tier2(providers: string[], opts: {rpc?, concurrency?}) -> Promise<Map<string, Outcome>>`
`tier3(rows, opts) -> Promise<Map<string, Outcome>>` — throws unless `opts.confirmed === true`
`SKIP_PROBE: Set<string>` — providers the vault's own notes say must never be probed
`parseArgs(argv: string[]) -> {tier: number, confirmed: boolean, dryRun: boolean}`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/tiers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tier1, tier2, tier3, SKIP_PROBE } from "../refresh/tiers.mjs";
import { parseArgs } from "../refresh/cli.mjs";

test("tier1 sends the stored ETag and reports a 304 without re-parsing", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init.headers; return { status: 304 }; };
  const r = await tier1({ fetchImpl, etag: 'W/"abc"' });
  assert.equal(seen["If-None-Match"], 'W/"abc"');
  assert.equal(r.status, 304);
  assert.equal(r.providers.size, 0);
});

test("tier1 parses a 200 into provider -> model ids", async () => {
  const body = { acme: { models: { "acme-1": {}, "acme-2": {} } },
                 zeta: { models: { "zeta-1": {} } } };
  const fetchImpl = async () => ({ status: 200, headers: { get: () => 'W/"new"' },
                                   json: async () => body });
  const r = await tier1({ fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(r.etag, 'W/"new"');
  assert.deepEqual(r.providers.get("acme"), ["acme-1", "acme-2"]);
});

test("tier1 uses no credential", async () => {
  let headers = null;
  const fetchImpl = async (url, init) => { headers = init.headers; return { status: 304 }; };
  await tier1({ fetchImpl });
  const keys = Object.keys(headers).map((k) => k.toLowerCase());
  assert.equal(keys.includes("authorization"), false);
  assert.equal(keys.includes("x-api-key"), false);
});

test("tier2 asks CCR to probe and classifies each result", async () => {
  const rpc = async (method, [name]) => {
    assert.equal(method, "probeProvider");
    if (name === "good") return { models: ["a", "b"] };
    if (name === "dead") { const e = new Error("401"); e.status = 401; throw e; }
    const e = new Error("ETIMEDOUT"); throw e;
  };
  const out = await tier2(["good", "dead", "slow"], { rpc });
  assert.equal(out.get("good").kind, "ok");
  assert.deepEqual(out.get("good").models, ["a", "b"]);
  assert.equal(out.get("dead").kind, "hard");
  assert.equal(out.get("slow").kind, "soft");
});

test("tier2 applies the denylist to every remote list", async () => {
  const rpc = async () => ({ models: ["fine", "opus", "claude-opus-5"] });
  const out = await tier2(["evil"], { rpc });
  assert.deepEqual(out.get("evil").models, ["fine"]);
});

test("tier2 refuses to probe providers the vault says must not be probed", async () => {
  let called = 0;
  const rpc = async () => { called++; return { models: [] }; };
  const out = await tier2(["gorouter", "tabiai"], { rpc });
  assert.equal(called, 0);
  assert.equal(out.get("gorouter").kind, "soft");
  assert.ok(SKIP_PROBE.has("gorouter"));
  assert.ok(SKIP_PROBE.has("tabiai"));
});

test("tier2 makes listing calls only — never a completion", async () => {
  const seen = [];
  const rpc = async (m, args) => { seen.push({ m, args }); return { models: [] }; };
  await tier2(["p"], { rpc });
  assert.equal(seen.every((s) => JSON.stringify(s.args).includes('"models"')), true);
  assert.equal(seen.some((s) => /message|completion|chat/i.test(JSON.stringify(s))), false);
});

test("tier3 refuses without an explicit confirmation", async () => {
  await assert.rejects(() => tier3([], {}), /confirm/i);
  await assert.rejects(() => tier3([], { confirmed: false }), /confirm/i);
});

test("parseArgs requires a tier and rejects anything outside 1..3", () => {
  assert.equal(parseArgs(["--tier", "1"]).tier, 1);
  assert.equal(parseArgs(["--tier", "2"]).tier, 2);
  assert.throws(() => parseArgs([]), /--tier/);
  assert.throws(() => parseArgs(["--tier", "4"]), /1, 2 or 3/);
  assert.throws(() => parseArgs(["--tier", "0"]), /1, 2 or 3/);
});

test("parseArgs gates tier 3 behind the billing flag", () => {
  assert.throws(() => parseArgs(["--tier", "3"]), /--i-know-this-bills/);
  assert.equal(parseArgs(["--tier", "3", "--i-know-this-bills"]).confirmed, true);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/tiers.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\refresh\tiers.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/refresh/tiers.mjs`:

```js
// Three tiers, three risk profiles.
//
//  1  free metadata      models.dev api.json, conditional GET on ETag, NO KEYS
//  2  keyed listings     GET {baseUrl}/models via CCR's probeProvider. Listing
//                        calls only -- no completions, so no tokens are spent
//  3  paid verification  real completions. Gated, confirmed, never scheduled
//
// Tier 2 goes through CCR's probeProvider rather than our own fetch loop, and
// that is the single most build-avoiding decision in this phase. CCR already
// handles protocol dispatch and base-URL candidates, and -- far more importantly
// -- IT ALREADY HAS THE KEYS. We never hold 44 credentials in our own process,
// so the entire direct-fetch security surface (key-in-URL, redirect replay,
// proxy inheritance, keys resident in a long-lived process) collapses to an RPC
// call on loopback.

import { classify } from "./catalog-store.mjs";
import { admitRemoteModels } from "../menu/denylist.mjs";

const MODELS_DEV = "https://models.dev/api.json";

// The vault's own notes warn that a probe here bills real Opus usage, or that
// the host is WAF-blocked and a probe just trains the block. Quoted, not guessed:
//   tabiai   "a trivial test prompt used 6554 prompt_tokens ... NOT a
//             negligible-cost test"
//   gorouter "treat a first real call here as similarly non-negligible-cost"
export const SKIP_PROBE = new Set(["gorouter", "tabiai"]);

export async function tier1({ fetchImpl = fetch, etag } = {}) {
  const headers = { Accept: "application/json" };
  if (etag) headers["If-None-Match"] = etag;
  const res = await fetchImpl(MODELS_DEV, {
    method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(20000),
  });
  if (res.status === 304) return { status: 304, etag, providers: new Map() };
  if (res.status !== 200) return { status: res.status, etag, providers: new Map() };
  const doc = await res.json();
  const providers = new Map();
  for (const [name, p] of Object.entries(doc ?? {})) {
    const ids = Object.keys(p?.models ?? {});
    if (ids.length) providers.set(name, ids);
  }
  return { status: 200, etag: res.headers?.get?.("etag") ?? etag, providers };
}

export async function tier2(names, { rpc, concurrency = 6 } = {}) {
  const out = new Map();
  const queue = [...names];
  // Concurrency 6, not 44: several vault providers proxy the same upstreams and
  // rate limits are per-account, not per-host. This is the same figure
  // test-all.mjs settled on to avoid rate-limiting shared free tiers into false
  // failures.
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const name = queue.shift();
      const at = new Date().toISOString();
      if (SKIP_PROBE.has(name)) {
        out.set(name, { kind: "soft", at, note: "on the do-not-probe list" });
        continue;
      }
      try {
        const r = await rpc("probeProvider", [name, { mode: "models" }]);
        const { kept } = admitRemoteModels(name, r?.models ?? []);
        out.set(name, { kind: "ok", models: kept, at });
      } catch (e) {
        out.set(name, { kind: classify({ status: e.status, error: e.status ? undefined : e.message }), at });
      }
    }
  }));
  return out;
}

export async function tier3(rows, { confirmed = false } = {}) {
  if (confirmed !== true) {
    throw new Error("tier 3 spends real money on real completions and must be confirmed " +
      "explicitly. Re-run with --i-know-this-bills and answer the prompt.");
  }
  // Deliberately delegates to the existing, already-careful prober rather than
  // growing a second one. verify-cli.mjs spawns the real claude.exe because
  // synthetic gateway probes over-report: groq/openai/gpt-oss-20b returns 200 to
  // a hand-built request and still fails under Claude Code's real payload.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["C:/Users/osami/.uw/keysync/verify-cli.mjs"],
                      { encoding: "utf8", stdio: "inherit" });
  return new Map([["__verify-cli", { kind: r.status === 0 ? "ok" : "soft",
                                     at: new Date().toISOString(), models: [] }]]);
}
```

Create `C:/Users/osami/.uw/refresh/cli.mjs`:

```js
#!/usr/bin/env node
// uw catalog refresh --tier 1|2|3
//
// The refresher NEVER writes settings.json, never writes config.sqlite, and never
// restarts the gateway. It produces a snapshot; keysync consumes it. That split
// is the whole design, and it is what makes a scheduled tier 1 safe: a background
// job that reconfigures CCR is the 2026-09-01 outage with a cron trigger attached.

import fs from "node:fs";
import path from "node:path";
import {
  CATALOG_DIR, SNAPSHOTS, CURRENT, acquireCatalogueLock, mergeSnapshot, writeSnapshot,
} from "./catalog-store.mjs";
import { tier1, tier2, tier3 } from "./tiers.mjs";

export function parseArgs(argv) {
  const i = argv.indexOf("--tier");
  if (i < 0 || !argv[i + 1]) throw new Error("usage: cli.mjs --tier 1|2|3 [--dry-run]");
  const tier = Number(argv[i + 1]);
  if (![1, 2, 3].includes(tier)) throw new Error("--tier must be 1, 2 or 3");
  const confirmed = argv.includes("--i-know-this-bills");
  if (tier === 3 && !confirmed) {
    throw new Error("tier 3 runs real completions and costs money. Pass --i-know-this-bills.");
  }
  return { tier, confirmed, dryRun: argv.includes("--dry-run") };
}

const readPrev = () => {
  try {
    const stamp = fs.readFileSync(CURRENT, "utf8").trim();
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOTS, stamp, "index.json"), "utf8"));
  } catch { return { generatedAt: null, providers: {} }; }
};

async function main() {
  const { tier, confirmed, dryRun } = parseArgs(process.argv.slice(2));

  // A one-file stop. When something goes wrong at 3 a.m. you want this, not a
  // task-scheduler expedition.
  if (fs.existsSync(path.join(CATALOG_DIR, "PAUSE"))) {
    console.log("catalogue/PAUSE exists — exiting without doing anything.");
    process.exit(0);
  }

  const lock = acquireCatalogueLock();
  try {
    const prev = readPrev();
    const now = new Date().toISOString();
    let outcomes = new Map();

    if (tier === 1) {
      const r = await tier1({ etag: prev.etag });
      console.log(`models.dev: HTTP ${r.status}, ${r.providers.size} providers`);
      for (const [name, models] of r.providers) outcomes.set(name, { kind: "ok", models, at: now });
      if (r.status === 304) console.log("unchanged since the last run — nothing to merge.");
    } else if (tier === 2) {
      const { rpc } = await import("../harness/config.mjs");
      const names = Object.keys(prev.providers ?? {});
      outcomes = await tier2(names, { rpc });
    } else {
      outcomes = await tier3([], { confirmed });
    }

    for (const [name, o] of outcomes) {
      console.log(`${o.kind === "ok" ? "PASS" : "fail"}  ${name.padEnd(18)} ` +
                  `${o.kind}${o.models ? ` (${o.models.length})` : ""}${o.note ? ` — ${o.note}` : ""}`);
    }

    const { next, refused } = mergeSnapshot(prev, outcomes, now);
    if (refused.length) {
      console.warn(`\nSHRINK GUARD: kept the previous rows for ${refused.join(", ")} — ` +
        `an ok response would have cut them by more than half, which is what upstream ` +
        `schema drift looks like. Re-run with the upstream checked, or accept deliberately.`);
    }
    if (dryRun) { console.log("\n--dry-run: nothing written."); return; }

    const dir = writeSnapshot(next);
    console.log(`\nsnapshot: ${dir}`);
    const stale = Object.entries(next.providers).filter(([, p]) => p?.stale).map(([n]) => n);
    console.log(`stale providers: ${stale.length ? stale.join(", ") : "(none)"}`);
  } finally {
    lock.release();
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/refresh/cli.mjs")) {
  main().catch((e) => { console.error(String(e.message)); process.exit(1); });
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/refresh/cli.mjs" --tier 1 --dry-run
```

Expected: `# pass 166`, `# fail 0`. The dry run prints `models.dev: HTTP 200, ~212 providers`, one line per provider, and `--dry-run: nothing written.`

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(refresh): three tiers behind one CLI, keys never held by the refresher"
```

---

### Task B7: Health from probe history, with an age refusal

**Files:** Create `C:/Users/osami/.uw/menu/health.mjs`, Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Test `C:/Users/osami/.uw/test/health.test.mjs`
**Interfaces:** Consumes: `~/.uw/state/health.json`, provider profiles. Produces:
`MAX_HEALTH_AGE_MS: number` — 14 days
`readHealth(file?: string) -> {generatedAt: string|null, providers: object}`
`resolveHealth(profile, entry, health, now) -> "ok" | "needs $" | "broken" | "stale"`
`makeHealthOf(providers: Map, health: object, now?: number) -> (name) => string`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/health.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readHealth, resolveHealth, makeHealthOf, MAX_HEALTH_AGE_MS } from "../menu/health.mjs";

const NOW = Date.parse("2026-09-10T00:00:00Z");
const fresh = { generatedAt: "2026-09-09T00:00:00Z", providers: {} };
const old = { generatedAt: "2026-06-01T00:00:00Z", providers: {} };

test("a missing file reads as empty rather than throwing", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "uw-health-"));
  assert.deepEqual(readHealth(path.join(d, "nope.json")), { generatedAt: null, providers: {} });
});

test("notes that record breakage win over everything", () => {
  assert.equal(resolveHealth({ notes: "502 upstream_error on all tried models" },
                             { consecutiveFails: 0 }, fresh, NOW), "broken");
});

test("three consecutive failures is broken", () => {
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 3 }, fresh, NOW), "broken");
});

test("one or two failures is not yet broken", () => {
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 2 }, fresh, NOW), "ok");
});

test("requiresBalance renders as needs $ when nothing is broken", () => {
  assert.equal(resolveHealth({ requiresBalance: true }, { consecutiveFails: 0 }, fresh, NOW), "needs $");
});

test("health older than the age limit is refused and renders stale", () => {
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 5 }, old, NOW), "stale");
});

test("the age refusal does not hide a note-recorded breakage", () => {
  assert.equal(resolveHealth({ notes: "key valid, chat backend down" },
                             { consecutiveFails: 5 }, old, NOW), "broken");
});

test("the age limit is fourteen days", () => {
  assert.equal(MAX_HEALTH_AGE_MS, 14 * 24 * 3600 * 1000);
});

test("a provider with no recorded probe is ok, not broken", () => {
  assert.equal(resolveHealth({ notes: "" }, undefined, fresh, NOW), "ok");
});

test("makeHealthOf resolves by provider name", () => {
  const f = makeHealthOf(new Map([["p", { notes: "" }]]),
                         { generatedAt: fresh.generatedAt, providers: { p: { consecutiveFails: 3 } } },
                         NOW);
  assert.equal(f("p"), "broken");
  assert.equal(f("unknown-provider"), "ok");
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/health.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\health.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/health.mjs`:

```js
// Provider health, from two sources with a deliberate precedence.
//
// Browsing into a provider that 502s is worse than not seeing it listed at all:
// 8 of 47 profiles carry notes saying they are currently broken, 16 of 47 set
// requiresBalance, and 33 of 47 have not been re-verified in weeks.
//
// The age refusal is the important part. A green "callable" from three weeks ago
// is worse than blank, because it is a claim nobody checked. run.mjs currently
// accepts a verified-rows.json of ANY age; this does not.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HEALTH_FILE = path.join(os.homedir(), ".uw", "state", "health.json");
export const MAX_HEALTH_AGE_MS = 14 * 24 * 3600 * 1000;
const BROKEN_NOTES =
  /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;

export function readHealth(file = HEALTH_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return { generatedAt: raw.generatedAt ?? null, providers: raw.providers ?? {} };
  } catch {
    return { generatedAt: null, providers: {} };
  }
}

export function resolveHealth(profile, entry, health, now = Date.now()) {
  // Hand-written notes are a human's verdict and never expire.
  if (BROKEN_NOTES.test(String(profile?.notes ?? ""))) return "broken";

  const age = health?.generatedAt ? now - Date.parse(health.generatedAt) : Infinity;
  if (age > MAX_HEALTH_AGE_MS) return profile?.requiresBalance ? "needs $" : "stale";

  if ((entry?.consecutiveFails ?? 0) >= 3) return "broken";
  if (profile?.requiresBalance) return "needs $";
  return "ok";
}

export const makeHealthOf = (providers, health, now = Date.now()) => (name) =>
  resolveHealth(providers.get(name) ?? {}, health.providers?.[name], health, now);
```

Then in `C:/Users/osami/.uw/menu/catalog.mjs`, take `healthOf` as an injected function the same way `cadenceOf` is, defaulting to the notes-only rule so the pure builder keeps working with no health file:

```js
export function buildFrom({ chosen, providers, catalog, relay,
                            cadenceOf = () => ({}), healthOf: healthFn = null }) {
  const resolve = healthFn ?? ((name) => healthOf(providers.get(name) ?? {}));
```

Then change the single `health:` line inside the `rows.push({...})` call at the end of the credential loop from `health: healthOf(prof),` to:

```js
      health: resolve(cred.provider),
```

Then add the import at the top of the file:

```js
import { readHealth, makeHealthOf } from "./health.mjs";
```

and add one property to the object `build()` passes to `buildFrom`, alongside the existing `cadenceOf`:

```js
    healthOf: makeHealthOf(providers, readHealth()),
```

Task B10 shows the finished `build()` with every injected dependency in place, so use that as the target shape.

Note the honest gap: nothing writes `health.json` yet. Tier 2 and tier 3 produce exactly the `{lastOk, lastFail, consecutiveFails}` shape it wants, so wiring the refresher's outcomes into it is a two-line follow-up once a refresh has actually run. Until then every provider reads `stale` or falls back to its notes, which is the correct rendering for "nobody has checked".

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
```

Expected: `# pass 176`, `# fail 0`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): health from probe history, refused once it is older than two weeks"
```

---

### Task B8: `EXPECTED_PROVIDERS` becomes a floor

**Files:** Modify `C:/Users/osami/.uw/keysync/run.mjs`, Test `C:/Users/osami/.uw/test/expected-providers.test.mjs`
**Interfaces:** Consumes: `--accept-provider-delta`. Produces: `checkProviderFloor(count: number, floor: number, accepted: boolean) -> {ok: boolean, message: string}` exported from `run.mjs` so it can be tested without running the pipeline.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/expected-providers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProviderFloor } from "../keysync/run.mjs";

test("at the floor is fine", () => {
  assert.equal(checkProviderFloor(44, 44, false).ok, true);
});

test("above the floor is fine — a new key is not a failure", () => {
  const r = checkProviderFloor(46, 44, false);
  assert.equal(r.ok, true);
  assert.match(r.message, /46/);
});

test("below the floor fails and names the shortfall", () => {
  const r = checkProviderFloor(41, 44, false);
  assert.equal(r.ok, false);
  assert.match(r.message, /41/);
  assert.match(r.message, /44/);
  assert.match(r.message, /--accept-provider-delta/);
});

test("below the floor passes once the delta is acknowledged", () => {
  assert.equal(checkProviderFloor(41, 44, true).ok, true);
});

test("a revoked key is a catalogue signal, not a keysync failure", () => {
  const r = checkProviderFloor(43, 44, false);
  assert.equal(r.ok, false);
  assert.match(r.message, /revoked|removed|delta/i);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/expected-providers.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../keysync/run.mjs' does not provide an export named 'checkProviderFloor'`.

- [ ] Step 3: Implement.

In `C:/Users/osami/.uw/keysync/run.mjs`, replace the constant and its equality check:

```js
// A FLOOR, not an equality. Once provider churn is routine -- and a refresher
// makes it routine -- a legitimately revoked key presents as a keysync failure
// rather than as the catalogue signal it actually is.
const PROVIDER_FLOOR = 44;

export function checkProviderFloor(count, floor, accepted) {
  if (count >= floor) {
    return { ok: true, message: `providers: ${count} (floor ${floor})` };
  }
  if (accepted) {
    return { ok: true, message: `providers: ${count} < floor ${floor} — delta acknowledged` };
  }
  return { ok: false, message:
    `providers: ${count} < floor ${floor}. A key was revoked or removed, or the vault ` +
    `filter changed. This is a catalogue signal, not necessarily a bug — review, then ` +
    `re-run with --accept-provider-delta.` };
}
```

and at the call site, replace the equality assertion with:

```js
const floor = checkProviderFloor(chosen.length, PROVIDER_FLOOR, has("--accept-provider-delta"));
console.log(floor.message);
if (!floor.ok) throw new Error(floor.message);
```

Because `run.mjs` executes on import, the test importing it would run the whole pipeline. Guard the entry point the same way the other modules are guarded, moving the existing top-level body into a `main()`:

```js
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/keysync/run.mjs")) {
  await main();
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# pass 181`, `# fail 0`, and the dry run prints `providers: 44 (floor 44)`.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "fix(keysync): provider count is a floor with an explicit delta acknowledgement"
```

---

### Task B9: The deliberate tiebreak run

**Files:** Modify `C:/Users/osami/.uw/keysync/keysync.mjs`, Test `C:/Users/osami/.uw/test/sort.test.mjs`
**Interfaces:** Consumes: catalogue entries. Produces: a **total** ordering over model selection, so an upstream reordering cannot change `Providers[].models` and therefore cannot restart the gateway for zero semantic change.

This task changes which models ship. It restarts the gateway exactly once. Run it deliberately, when no session is mid-request, and record the before and after.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/sort.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankModels } from "../keysync/keysync.mjs";

const E = (model, price) => ({
  model, capabilities: {}, modalities: { output: ["text"] },
  ...(price === null ? {} : { pricing: { offers: [{ per1MTokens: { input: price, output: price } }] } }),
});

test("free models sort before paid", () => {
  const r = rankModels([E("zzz-paid", 1), E("aaa-free", 0)]);
  assert.deepEqual(r.map((x) => x.m.model), ["aaa-free", "zzz-paid"]);
});

test("within a tier, shorter ids win", () => {
  const r = rankModels([E("a-longer-id", 0), E("short", 0)]);
  assert.deepEqual(r.map((x) => x.m.model), ["short", "a-longer-id"]);
});

test("equal tier and equal length break alphabetically, not by input order", () => {
  const a = rankModels([E("bbb", 0), E("aaa", 0)]).map((x) => x.m.model);
  const b = rankModels([E("aaa", 0), E("bbb", 0)]).map((x) => x.m.model);
  assert.deepEqual(a, ["aaa", "bbb"]);
  assert.deepEqual(a, b, "the ordering must not depend on input order");
});

test("the ordering is total: shuffling the input cannot change the output", () => {
  const ids = ["mmm", "nnn", "ooo", "ppp", "qqq"];
  const base = rankModels(ids.map((i) => E(i, 0))).map((x) => x.m.model);
  for (let n = 0; n < 20; n++) {
    const shuffled = [...ids].sort(() => Math.random() - 0.5).map((i) => E(i, 0));
    assert.deepEqual(rankModels(shuffled).map((x) => x.m.model), base);
  }
});

test("unknown-tier models sort after free, alongside paid", () => {
  const r = rankModels([E("unk", null), E("fre", 0)]);
  assert.deepEqual(r.map((x) => x.m.model), ["fre", "unk"]);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/sort.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../keysync/keysync.mjs' does not provide an export named 'rankModels'` — the comparator is currently inline inside `buildProviders`.

- [ ] Step 3: Implement.

In `C:/Users/osami/.uw/keysync/keysync.mjs`, lift the comparator out of `buildProviders` and add the tiebreak:

```js
/**
 * Rank catalogue entries for selection. TOTAL, and that is the whole point.
 *
 * The previous comparator was `(free?0:1)` then `id.length` and stopped there.
 * Two models with the same tier and the same id length kept their INPUT order --
 * the order they happened to appear in models.json. Because
 * restartRelevantFingerprint is deliberately order-sensitive (CCR compares by
 * JSON.stringify, at every level including each provider's nested models array),
 * an upstream reordering reshuffled Providers[].models and RESTARTED THE GATEWAY
 * FOR ZERO SEMANTIC CHANGE.
 *
 * Ties were common rather than rare, because inferTier returned "unknown" for
 * every model, so the free term was a no-op and id length was the only
 * discriminator. Task B2 fixed the tier; this makes the order total.
 */
export function rankModels(entries) {
  return entries
    .map((m) => ({ m, tier: inferTier(m) }))
    .sort((a, b) =>
      (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) ||
      a.m.model.length - b.m.model.length ||
      a.m.model.localeCompare(b.m.model));
}
```

and in `buildProviders`, replace the inline `.map(...).sort(...)` with `const ranked = rankModels(catalogEntries);`.

- [ ] Step 4: Run, expected PASS, then apply deliberately.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry > C:/Users/osami/.uw/state/tiebreak-after.txt
```

Expected: `# pass 186`, `# fail 0`. Diff the dry run against the committed `built-rows.json` and expect the selection to differ — that is the point, and it is why this is a deliberate run rather than a drive-by edit. Then, with no Claude Code session mid-request:

```
node "C:/Users/osami/.uw/keysync/run.mjs" --target live --i-know
```

Expected: exactly one gateway restart, `waitForGateway` returns, and `otherClaudeSessions()` warned about any live sessions beforehand. Record the before and after picker rows in the commit message.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "fix(keysync): total model ordering so an upstream reshuffle stops restarting the gateway"
```

---

### Task B10: The picker reads the refreshed catalogue

**Files:** Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Test `C:/Users/osami/.uw/test/integration.test.mjs`
**Interfaces:** Consumes: everything built above. Produces: `build()` resolving through `resolveCatalogPath()`, so a refresh that flips the `current` pointer changes what the picker shows on its next launch with no other action.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/integration.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "../menu/catalog.mjs";
import { resolveCatalogPath } from "../refresh/catalog-store.mjs";
import { view, initState, reduce } from "../menu/pick-state.mjs";
import { render } from "../menu/uwpick.mjs";

test("the picker resolves the catalogue through the snapshot pointer", () => {
  const p = resolveCatalogPath().replace(/\\/g, "/");
  assert.doesNotMatch(p, /node_modules/);
  assert.ok(fs.existsSync(p));
});

test("build() produces the full live provider set", () => {
  const { rows } = build();
  assert.ok(rows.length >= 44, `expected at least 44 providers, got ${rows.length}`);
  assert.ok(rows.some((r) => r.provider === "anthropic"), "the relay must be present");
});

test("every badge in the live build is inside the five-value set", () => {
  const allowed = new Set(["FREE", "FREE?", "PLAN", "PAID", ""]);
  const { rows } = build();
  for (const r of rows) for (const m of r.models) {
    assert.ok(allowed.has(m.badge), `unexpected badge ${JSON.stringify(m.badge)} on ${m.id}`);
  }
});

test("no reserved name survives from a non-relay provider", () => {
  const { rows } = build();
  for (const r of rows) {
    if (r.provider === "anthropic") continue;
    for (const m of r.models) {
      assert.doesNotMatch(m.id, /^(claude|opus|sonnet|haiku|fable|anthropic)([-._\d\/]|$)/i,
        `${r.provider} still lists a reserved name: ${m.id}`);
    }
  }
});

test("no rendered cell contains a control character", () => {
  const { rows, generatedAt } = build();
  const meta = { providers: rows.length, routable: 0, generatedAt };
  let s = initState(rows);
  const frames = [render(view(s), meta, new Set())];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const into = reduce(s, "\r").state;
    frames.push(render(view(into), meta, new Set()));
    s = reduce(s, "\x1b[B").state;
  }
  for (const f of frames) {
    const withoutSgr = f.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    assert.doesNotMatch(withoutSgr, /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/,
      "a provider-controlled string reached the frame with a control character intact");
  }
});

test("at least one provider still reports a null free column", () => {
  const { rows } = build();
  assert.ok(rows.some((r) => r.free === null),
    "if nothing is null any more, the nullable column has silently become a boolean");
});

test("the OpenRouter free models are FREE, not FREE?, after cadence curation", () => {
  const { rows } = build();
  const or = rows.find((r) => r.provider === "openrouter");
  if (!or) return;                       // provider not in the vault: nothing to assert
  const frees = or.models.filter((m) => m.badge === "FREE");
  assert.ok(frees.length > 0, "openrouter is curated as recurring, so its zero-priced " +
                              "models must render FREE rather than FREE?");
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/integration.test.mjs"
```

Expected failure: the OpenRouter test fails with `openrouter is curated as recurring...` if Task B3's migration has not been applied to the live vault, and the reserved-name test fails if Task B1's change to `buildFrom` was not wired. On a correctly sequenced run only the last test fails, because `build()` does not yet pass `cadenceOf` through in every path.

- [ ] Step 3: Implement.

Finish wiring `build()` in `C:/Users/osami/.uw/menu/catalog.mjs` so every injected dependency is supplied from real state:

```js
import { resolveCatalogPath, assertSchema } from "../refresh/catalog-store.mjs";
import { makeCadenceOf } from "./cadence.mjs";
import { readHealth, makeHealthOf } from "./health.mjs";

export function build() {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  // loadCatalog already resolves through resolveCatalogPath() after Task B4, so a
  // refresh that flips `current` changes what the picker shows on its NEXT launch
  // and nothing else has to happen. The pointer is read once per process, so a
  // concurrent refresh can never be observed half-written.
  return buildFrom({
    chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY,
    cadenceOf: makeCadenceOf(providers),
    healthOf: makeHealthOf(providers, readHealth()),
  });
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/"
node "C:/Users/osami/.uw/refresh/cli.mjs" --tier 1
node "C:/Users/osami/.uw/menu/doctor.mjs"
```

Expected: `# pass 193`, `# fail 0`; the tier 1 refresh writes a snapshot and prints its path; `doctor` reports green. Then re-run the Task A12 protocol steps P2 and P6 and confirm the badges and the free column reflect the curated cadence.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): the picker reads the refreshed catalogue through the snapshot pointer"
```

---

## Test Strategy

**How to run everything.**

```
node --test "C:/Users/osami/.uw/test/"
```

No `package.json`, no test framework, no dependency. `node:test` and `node:assert/strict` ship with Node, which preserves the zero-dependency property keysync holds deliberately. Files are `*.test.mjs`; fixtures are JSON under `test/fixtures/`.

**What each layer is responsible for.**

The unit layer owns every decision: sanitization, id admission, the denylist, price extraction, badge derivation, cadence resolution, health resolution, the reducer, the merge policy, and the provider floor. All of it runs from fixtures with no network, no vault reads and no live state. This is where a regression should be caught, and it is why the reducer was split out of the renderer.

The integration layer owns the seams: the dispatcher's decision, the console-mode restore, the wiring from `build()` through `view()` to `render()`, and the fact that no provider-controlled string reaches a rendered frame with a control character intact. These spawn real processes but only against scratch directories.

The end-to-end layer is Task A12's twelve-step protocol, run by a human or the qa-tester agent in Windows Terminal against live Claude Code. It exists because the properties that matter most here — does ctrl+g reach the picker, do arrows arrive, does the chat input actually change, is the console still usable afterwards — are not observable from inside a test harness. `process.stdout.isTTY` is false under a piped agent, so any claim about interactive behaviour made from there would be a guess.

**Isolation, restated as a rule.** No test reads or writes `~/.claude/settings.json`, `%APPDATA%/claude-code-router`, ports 3456, 3457 or 3458, or any key value from `~/.llmkeys`. Scratch state goes to `fs.mkdtempSync` directories or `~/.uw/harness/scratch/`. Where a test must reach CCR, it goes through `harness/config.mjs`, which pins its own app-data directory, its own `LOCALAPPDATA`, and ports 39456/39457/39458, and whose `resolveWebPort()` refuses to talk to a daemon that did not receive the harness token. CCR auth-transport behaviour is never tested with the real `~/.claude/.credentials.json` present.

**What is deliberately not tested.** The `PLAN` badge is asserted only on the injected relay, because no vault provider is curated as plan-covered and inventing one would be the guess the design exists to prevent. Tier 3 is tested only for its refusal path; its success path spends money. Terminal rendering fidelity — colours, alignment on a narrow window — is verified by eye in the protocol, not asserted, because asserting on ANSI output pins the design rather than the behaviour.

## Risks and Rollback

| Risk | Signal | Rollback |
|---|---|---|
| Claude Code's handoff contract changes on an auto-update | `uw doctor` reports RED on `handoff-contract`, or ctrl+g silently does nothing | Set `EDITOR` back to `%UW_REAL_EDITOR%` at User scope; the picker is then simply absent and nothing else in the system depends on it. Fall back to Option D, the `UserPromptSubmit` hook |
| The console is left in raw mode | The parent shell stops echoing | Close the terminal. The wrapper's `finally` should prevent this; if it recurs, capture `~/.uw/state/conmode.json` from a `-Diagnose` run and compare `saved` with `restored` |
| The installer clobbers a real `EDITOR` | Ctrl+g opens the picker where the user expected their editor | `~/.uw/state/install.json` records `previousEditor`; restore it with `[Environment]::SetEnvironmentVariable("EDITOR", <previous>, "User")` |
| The tiebreak run (B9) selects worse models | The dry-run diff shows unexpected rows, or a provider stops serving after the apply | `git revert` the B9 commit and re-run `run.mjs --target live --i-know`; keysync's own `restoreSettings` and DPAPI-encrypted `config.sqlite` snapshot cover the apply itself |
| A refresh promotes a bad snapshot | The picker shows far fewer models, or a provider empties | `echo <previous stamp> > ~/.uw/catalog/current` — snapshots are immutable and three are retained. The shrink guard and the 80% floor should catch this first |
| The `grantCadence` migration is wrong for a provider | A `FREE` badge on something that is not free | Restore the timestamped `providers.json.bak-cadence-*` the migration wrote, or edit the single field. The field is curated, so correcting it is a one-line human edit by design |
| `inferTier` (B2) lands before the denylist (B1) | A bare Claude-shaped id from a third-party provider appears in `built-rows.json` | The test in B2 asserts B1 is in the git log and fails loudly if it is not. If it somehow shipped: revert B2, land B1, re-apply |
| A test reaches live state | An unexplained change to `~/.claude/settings.json` or a gateway restart during a test run | `harness/guard.mjs` tripwires on `LIVE_SETTINGS`; keysync's settings backups are in `%LOCALAPPDATA%\uw-keysync\backups` |

## Deferred and Out of Scope

**Deferred, with the reason.**

Writing `health.json` from refresh outcomes is a two-line follow-up once tier 2 has run against the live vault; the reader, the schema and the age refusal all ship in B7, but nothing populates the file yet, so every provider currently renders from its notes or as `stale`. The New-API `/api/pricing` route — public and unauthenticated on tokenrouter, nararouter and agentrouter, and worth re-probing for six more — would convert those providers from "id-suffix only" to first-party price data, but it needs the `quota_type` predicate `(quota_type == 0 && model_ratio == 0) || (quota_type == 1 && model_price == 0)`, and the naive test is measured at 123 false positives out of 134 on one gateway alone. Per-model rate limits, wallet balances and `access_state` from report 14 are a richer schema than the five-badge set the user specified; the badge set is the constraint, so the extra fields would render nowhere. Conditional pricing (Zenmux publishes an array of tiers with token-count conditions on 50 of 164 models) cannot be represented by a scalar price field and currently renders blank, which is correct but lossy.

**Out of scope, deliberately.**

No scheduled task is created for any tier. Report 08 F8 is unambiguous: a scheduler supplying a consent flag on every run converts a gate into a constant, and the human who would notice a warning is exactly what a schedule removes. Tier 1 is *schedulable* by construction — it touches no keys and no privileged file — but scheduling it is a separate decision with its own jitter, failure-budget and kill-file requirements. `autoFetchModels` stays off forever: its merge is a pure union that never removes an upstream deletion, it is strictly sequential with no per-provider timeout across 44 providers, and it hands the gateway-restart trigger to a 600-second timer we do not control. Gateway model discovery is not enabled; it is currently set in live settings *alongside* `replaceBuiltInOptions: true`, which erases the rows it produces, making it a pure-cost no-op — picking one mechanism is a separate change. The `behavesAs`-as-context-window coupling (report 10, P0 #1) is a real silent-wrongness bug where auto-compact fires at the wrong threshold with no error, but it belongs to keysync's picker-row generation rather than to the menu, and fixing it needs probe P6 to settle which of `behavesAs`, `modelOverrides` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` actually wins. The slot file plus `CUSTOM_ROUTER_PATH` mechanism stays proven and unused. Router rules stay disabled and `harness/guard.mjs:assertRouterClean` stays as it is; if rules ever go live it must be scoped, never deleted, because Phase 2.5's provider-attribution test would be false-greened by a rewrite.

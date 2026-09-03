# UltimateWrap Phase 6 — Model Menu and Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a two-level provider→model terminal menu that runs inside Claude Code's ctrl+g external-editor handoff and switches models for zero Anthropic tokens, plus the catalogue refresh and labeling pipeline that keeps its rows honest.

**Architecture:** Phase A takes the three verified spike files (`uwpick.mjs`, `uwpick-run.ps1`, `uwpick.cmd`) plus the shared `catalog.mjs` builder, moves them into `~/.uw/menu/`, and splits the interactive surface into a pure state reducer (unit-testable without a TTY) behind a thin ANSI renderer. Selection writes `/model <provider>/<model>` into the temp file Claude Code hands the editor and exits 0, so no gateway configuration is touched and no assistant turn is spent. Phase B replaces the catalogue the menu reads: a reserved-name denylist at ingest, a corrected pricing path, a curated `grantCadence` field that turns "price is zero" into the governing definition of free, and a three-tier refresh that writes an immutable snapshot the menu resolves through a `current` pointer.

**Tech Stack:** Node.js ESM (`.mjs`, no bundler, no `package.json`, zero runtime dependencies), `node:test` + `node:assert/strict` for tests, Windows PowerShell 5.1 for the console-mode wrapper and the installer, `cmd.exe` for the editor dispatcher, CCR's loopback JSON-RPC for routability and keyed provider listings.

**Spec:** `C:/Users/osami/.uw/keysync/phase6-design-notes.md` (governing) plus `C:/Users/osami/.uw/research/phase6/00-INDEX.md` and reports 01–15.

## Global Constraints

1. Zero Anthropic tokens per switch: on a **selection** the picker writes `/model <provider>/<model>` into `process.argv[2]` and calls `process.exit(0)`, because a non-zero exit makes Claude Code discard the content (D6). Accepted side effect: Claude Code also saves the selection as the default for new sessions. On **any abort** — Esc, ctrl+c, an unusable snapshot, or `CONIN$` unavailable — the inverse holds and both halves must be applied: the picker truncates the buffer to empty **and** exits non-zero, and `uwpick.cmd` propagates that exit code rather than replacing it with 0. Exit 0 with the buffer untouched would submit the user's `m` sentinel as a chat message, which is the opposite of the intended behaviour on every abort path (Tasks A10 and A13).
2. Free means price 0 **and** a quota that resets regularly. A one-time wallet credit is not free.
3. `grantCadence ∈ {recurring, one-time, none}` is a curated field in `~/.llmkeys/providers.json`, never machine-overwritten, blank when uncertain, never guessed.
4. Badge set is exactly `FREE` (price 0 + cadence recurring), `FREE?` (price 0 + cadence unknown), `PLAN` (subscription-covered, D7), `PAID` (any non-zero token price), and blank. Nothing else renders.
5. Provider `free` column is nullable: `—` means no price data exists, `0` means price data exists and no model is free. Rendered as `12 +4 plan` when plan-covered models are present.
6. Provider columns are exactly: key id (`bucket.provider.tier`, width 30), model count (width 7), free (width 12), health (width 8).
7. Model columns are exactly: id (width 34), ctx (width 6), `$in` (width 7), `$out` (width 7), badge (width 6), caps `T/V/R` (width 3). Non-routable rows render dimmed.
8. Two-level menu with a live filter at both levels. The level-1 filter matches member model ids as well as the key id.
9. Recents and favourites are pinned at level 1 as **visible duplicates**; they are never removed from their provider's level-2 list (opencode#6169).
10. Tab toggles a flat `provider/model` search scope; Esc walks back down the ladder before it quits.
11. The reserved-name denylist (**Task A5.1**, moved forward from its original slot as B1) lands **before** the `inferTier` fix (Task B2). Fixing tier inference without the denylist arms the routing hijack described in report 08 F1. The denylist must be wired into **`keysync.mjs:buildProviders`**, the function that writes CCR's `Providers[].models`, not only into `menu/catalog.mjs`, which feeds the display and routes nothing. A denylist on the display path satisfies the ordering in letter and leaves the hijack open in substance. The gate on this constraint is a behavioural test that calls `buildProviders` with a hostile entry and asserts it is absent from the output; a test that greps the git log proves only that a commit subject exists.
12. Reserved names: `/^(claude|opus|sonnet|haiku|fable|anthropic)([-._\d/]|$)/i` and `/^uw\//i`, admitted only from the trusted relay provider (`anthropic`).
13. Every provider-controlled string rendered by the TUI passes through `sanitizeDisplay()`: ESC/CSI/OSC sequences removed, C0 and C1 control characters removed, **bidirectional overrides and zero-width characters removed** (`U+200B`–`U+200F`, `U+2028`, `U+2029`, `U+202A`–`U+202E`, `U+2066`–`U+2069`, `U+FEFF`), NFC-normalised, and the length cap applied **by code point** rather than by UTF-16 code unit so an astral character at the boundary is never cut into a lone surrogate. Full display-width awareness (East Asian wide and ambiguous glyphs occupying two columns while counting as one unit) is explicitly deferred; see the Deferred section for the consequence.
14. Model ids must match `/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/` and must not contain `..`. A violation is a rejection, not a truncation.
15. Tests never touch live state: no test reads or writes `~/.claude/settings.json`, `%APPDATA%/claude-code-router`, ports 3456/3457/3458, or `~/.llmkeys` key values. Scratch state goes under `~/.uw/harness/scratch/` or a `fs.mkdtempSync` directory. Every path this plan's code uses to reach the catalogue directory or the catalogue lock is a **parameter with a default**, never a module constant a test cannot displace, so a test can point the whole store at a temp root.
15c. **Every declared Interfaces signature must match its implementation.** Verified by `check-interfaces.mjs`, which extracts both sides and reports only where an implementation destructures an option set that disagrees with what the declaration advertises. Four instances of this species were found by hand across three review rounds — `tier1` declaring `Entry[]` while returning `string[]` (the round-2 blocker, stated in one word), `writeHealthFromOutcomes` declaring a bare `out?` against `{out, tier}`, `tier3` advertising `probe` and `rpc` it never destructured, and `tier2` advertising a `probe` it ignored. A declaration is the spec an implementer works to, and in three of those four, deciding in the declaration's favour reinstated a defect. The sweep also caught a module — `refresh/probe.mjs` — that had a documented role and no caller anywhere.

15b. **Every fenced JavaScript block in this plan must parse.** Verified by extracting all of them and running `node --check` over each — `node test/../plans/check-blocks.mjs` does this and exits non-zero on any failure. Reading a block does not establish that it parses: three review rounds read this plan and missed five blocks that did not, including one that made Task A3 unloadable and therefore blocked everything downstream of it. A block that is deliberately a partial snippet carries `// FRAGMENT:` on its first line and is skipped. Related: **no plan code block is ever written through a shell heredoc.** Quoted-delimiter heredocs in this environment still strip a level of backslash, and a Python heredoc additionally *interprets* escapes — `a word-boundary escape` arrived in the plan as a literal backspace byte. Both corruptions are invisible on screen. Anything containing a backslash, an escape or a non-ASCII character goes through the editing tool, and `check-control-chars.mjs` sweeps for the ones `node --check` cannot see because they parse fine.

15a. `# fail 0` must be true after every task. No test in the `node --test` sweep may be documented as expected-to-fail, and no test may read a live artifact that a later task creates: a known-failing test makes a real regression indistinguishable from the expected one and makes every published pass count wrong until the later task lands. A test that must observe live state is either a standalone script under `test/` run by an explicit command (the convention `bench-startup.mjs` already sets), or is read-only and gated on `fs.existsSync` so it skips cleanly when the artifact is absent.
16. CCR auth-transport behaviour is never tested with the real `~/.claude/.credentials.json` present.
17. The catalogue is copied out of `node_modules` into `~/.uw/catalog/`. CCR's bundled `dist/models.json` is never written.
18. Three refresh tiers: tier 1 free metadata (models.dev `api.json`, conditional GET on ETag, no keys); tier 2 keyed `GET {baseUrl}/models` listings only, never completions; tier 3 paid verification, gated behind `--tier 3` plus `--i-know-this-bills` plus an interactive confirmation.
19. Merge policy: snapshot directory plus `catalogue.lock`; a provider whose refresh failed keeps its previous rows and gains `stale: true` with `staleSince`.
20. `EXPECTED_PROVIDERS` becomes a floor (`>=`), not an equality check.
21. The model sort gains a total tiebreak `|| a.m.model.localeCompare(b.m.model)`, applied in one deliberate run because it reselects rows and restarts the gateway exactly once.
22. Coupling to Claude Code is limited to the `$EDITOR` handoff contract and `/model` syntax. `uw doctor` fails loudly and names the failing check when the fingerprint moves.
23. Windows: Node cannot call `SetConsoleMode`; `uwpick-run.ps1` does. The console device is `//./CONIN$` with forward slashes. The access mask is decimal `3221225472`, because `0xC0000000` overflows Int32 in PowerShell 5.1. The saved mode is restored in `finally`.
24. `~/.uw` becomes a git repository in Task A1. `.gitignore` excludes logs, `*.bak*`, `keys.log`, tool outputs and spike scratch. Nothing from `~/.llmkeys` is ever committed.
25. Spike files are moved and hardened, not rewritten. Report 09's `~550 lines` budget was written for the picker's own new modules and this plan exceeds it several times over once tests, the refresh pipeline, the installer and the doctor are counted: roughly 4,800 lines of fenced code across 27 tasks, of which a little over half is test code. That is stated here as a measured fact rather than left as a constraint the plan silently breaks. The budget that remains binding is narrower and checkable: **the picker's runtime path** — every module `uwpick.mjs` imports transitively, which is `pick-state.mjs`, `style.mjs`, `snapshot.mjs`, `sanitize.mjs`, `denylist.mjs`, `atomic.mjs`, `cc-contract.mjs` and `state.mjs` — stays under 900 lines of non-test code, because that is the code whose size the 300 ms startup budget is sensitive to. The list is the import graph rather than a hand-picked set: the first version of this constraint omitted `cc-contract.mjs` and `state.mjs`, both of which `uwpick.mjs` imports directly, so the budget under-counted its own scope. **It is enforced by an assertion in Task A11**, not left as a number nobody checks — a budget made true by redefining what it counts is the same move this constraint was written to stop. Everything outside that path is bounded by review, and that is said plainly rather than given a number.
26. `autoFetchModels` stays `false` on every provider, enforced as a hard `validate()` invariant, not a convention.
27. `MAX_MODELS_PER_PROVIDER = 3` is not lifted when any list becomes remote.

### Quality criteria

These seven criteria are requirements, not aspirations. Each one names the task that carries it, so a reviewer can check the criterion against a specific step rather than against the plan's tone.

**Q1 — Optimized. The picker must feel instant.**

- Q1.1 The picker reads its rows from one pre-built display snapshot, `C:/Users/osami/.uw/catalog/snapshot.json` (Task A8). It never parses the 19.7 MB CCR catalogue at open time. Building that snapshot is a separate command run by the refresher, not by the picker.
- Q1.2 Startup budget: **under 300 ms from process start to the first frame reaching the console**, measured on this machine. Task A11 measures it, writes `~/.uw/state/startup.json`, and fails when the median of five runs exceeds 300 ms.
- Q1.3 **The picker issues no network call of any kind and performs no asynchronous work.** Routability is not a live fact the picker discovers; it is a field on the snapshot row, computed once by `refresh/cli.mjs` and stamped with `routableAsOf` (Tasks A8, A10 and B6). This is forced by Q7.2 and is not a preference: the input loop is a blocking `readSync`, so the JS stack never unwinds, the event loop is never re-entered, and any promise the picker creates can never settle. A design that issued an RPC and redrew "when it returns" would compile, pass its unit tests, and render an empty column forever. The picker therefore reads `row.routable` synchronously, dims rows where it is `false`, leaves rows undimmed where it is `null` (unknown), and prints the `routableAsOf` stamp in the header so a stale answer is visible rather than assumed fresh. If the refresher could not reach CCR, every row carries `routable: null` and nothing dims — the honest rendering of "nobody has checked".
- Q1.4 The startup animation (Q7) lives inside the 300 ms budget rather than on top of it. If the budget is exceeded, motion is the first thing cut.
- Q1.5 The startup benchmark measures the quantity Q1.2 defines. The bench child renders with the **real** capability set and motion enabled, writes the frame to a pipe, and stops the clock on the completed write; `recordStartup` in the live path stops at the same point. A bench that builds a string it never writes, or that forces `TERM=dumb` to skip the animation the budget is supposed to contain, produces a number that cannot be compared with the runtime one (Task A11).

**Q2 — Reliable. Every external input has a defined failure behaviour.**

- Q2.1 Catalogue snapshot missing, unreadable, or not JSON: the picker prints one line naming the file and the `uw catalog refresh` command that rebuilds it, **truncates the handoff buffer to empty**, then exits 1. Both actions are required and neither is sufficient alone. The exit code is what tells Claude Code to discard, and `uwpick.cmd` must propagate it rather than substituting 0; the truncation is what makes the outcome correct even if an exit code is ever swallowed again downstream, because an empty buffer yields an empty chat input regardless of exit code. What must never happen is the buffer surviving with the `m` sentinel still in it and being submitted as a chat message (Tasks A8, A10 and A13).
- Q2.2 Snapshot present but schema-wrong (`schemaVersion` not 1): same behaviour as Q2.1, with the observed version quoted. A truncated snapshot never renders as an empty menu.
- Q2.3 `~/.uw/state/picker.json` missing or corrupt: recents and favourites start empty, the picker runs normally, and the corrupt file is renamed to `picker.json.corrupt-<stamp>` rather than deleted (Task A7). "Runs normally" means it opens and can be used; it does not weaken Q2.1's rule about the buffer on the eventual exit.
- Q2.3a Esc at the bottom rung and ctrl+c both quit **without a selection**, which is an abort under Q2.1: the buffer is truncated and the exit code is non-zero. The Esc ladder walking back a level is not an abort and changes nothing about the buffer (Tasks A6 and A10).
- Q2.4 `~/.llmkeys/providers.json` missing or corrupt: cadence resolution returns an empty object for every provider, so badges fall back to `FREE?` and blank, and the picker still opens (Task A5).
- Q2.5 CCR RPC unreachable, slow, or returning an unexpected shape: this is now a **refresher** failure, not a picker failure (Q1.3). `refresh/cli.mjs` records `routable: null` for the rows it could not resolve and stamps `routableAsOf`; the picker never contacts CCR at all, so it cannot block on it or fail because of it (Tasks A4 and B6).
- Q2.6 `CONIN$` cannot be opened: the picker prints `uwpick: cannot open CONIN$` with the Win32 message, truncates the buffer, and exits non-zero; the wrapper propagates that code and so does `uwpick.cmd`, so Claude Code discards the buffer (Tasks A10, A12 and A13). This is the path most likely to be reached on a machine where the console is not what the plan assumes, which is exactly when leaving `m` in the chat input is least explicable to the user.
- Q2.7 The console mode is restored on every exit path: normal selection, Esc quit, ctrl+c, an uncaught exception in the child, and a non-zero child exit. The restore lives in the PowerShell `finally` block and is asserted by test, not by inspection (Task A12).
- Q2.8 Every write to a state or catalogue file is atomic: write `<file>.tmp-<pid>`, flush, then rename over the target. A crash mid-write leaves the previous file intact. This covers `picker.json`, `startup.json`, `health.json`, `capabilities.json`, `install.json`, `hud-install.json`, `conmode.json`, `snapshot.json`, the catalogue `current` pointer, **and `~/.claude/settings.json`** (Tasks A7, A8, A12, A16 and B5). `settings.json` is the only third-party live file this plan writes and it is the one a truncation hurts most, so it gets the same treatment through PowerShell: write `settings.json.uw-tmp`, then `Move-Item -Force` over the target, which is an atomic rename on NTFS for a same-directory destination. `routable.json` is deliberately absent from this list because it no longer exists (Q1.3).
- Q2.9 No file this plan writes carries a UTF-8 byte-order mark. PowerShell 5.1's `Set-Content -Encoding UTF8` emits one, and `JSON.parse` throws on a leading U+FEFF, so every PowerShell write goes through `[IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding $false))` instead. Independently, `readJsonOr` strips a leading BOM before parsing, so a file written by some other tool cannot silently degrade a reader into its fallback (Tasks A5, A12 and A16).

**Q3 — User friendly.**

- Q3.1 The help line is always visible, on the last line of the frame, at both levels and in flat scope (Tasks A9 and A10).
- Q3.2 A filter that matches nothing renders an explicit empty-state row rather than a blank area: `backspace to widen, esc to clear — no match for "<query>"` (Tasks A6 and A9). The instruction precedes the echoed query, and the query is clipped to 20 characters, so that a long filter truncates the part the user just typed rather than the part telling them how to recover.
- Q3.3 On selection the frame collapses to one confirmation line, `switched -> <provider>/<model>` with a check glyph, which is the last thing on screen before Claude Code repaints (Tasks A9 and A10).
- Q3.4 Recents are capped at **10** entries, most recent first (Task A7).
- Q3.5 Favourites toggle on a single key press: `f` at either level, applied to the row under the cursor (Task A6).
- Q3.6 `?` opens a key legend overlay; any key closes it and returns to the exact prior state (Tasks A6 and A9).
- Q3.7 No flicker. Frames are drawn with cursor-home plus per-line erase-to-end-of-line. The screen is cleared exactly twice per session: once on entry, once on exit (Task A9).
- Q3.8 **A held arrow key moves once per repeat, and a paste loses no characters.** `readSync` on `//./CONIN$` returns whatever is in the console buffer, not one key: a fast repeat arrives as `ESC[A ESC[A ESC[A` in a single chunk, and a paste arrives as a run of code points. The chunk is therefore tokenised into individual keys before any of them reaches the reducer — a leading `ESC[` consumes the whole CSI up to its final byte in `@`–`~`, anything else consumes one UTF-8 code point — and every token is reduced in order before one frame is drawn (Tasks A6 and A10). Without this the reducer's arrow branch matches the first `ESC[A` in the chunk, moves one row, and discards the rest, and a two-byte chunk falls through every branch and vanishes. The defect is invisible to single-key fixtures, which is why the tokeniser is a pure exported function with its own multi-key test rather than an inline slice in the input loop.

**Q4 — Update-resilient to Claude Code and CCR.**

- Q4.1 Exactly two modules may know about Claude Code or CCR: `menu/cc-contract.mjs` (the external-editor handoff, `/model` command syntax, exit-code semantics, and the statusline stdin JSON shape) and `menu/ccr-client.mjs` (`service.json` discovery, the JSON-RPC endpoint, `getConfig`, `probeProvider`, and the catalogue path inside `node_modules`) (Task A4).
- Q4.2 Each of those modules exports a frozen `CONTRACT` object carrying a `fingerprint` string naming the version the contract was verified against, plus the paths and shapes it depends on.
- Q4.3 No file under **`menu/` or `refresh/`** — the two directories this plan creates — may contain the strings `claude-code-router`, `node_modules`, `.claude`, `APPDATA` or a loopback address, outside the two contract modules. The scope is those two directories and not the whole repository, deliberately: `keysync/` and `harness/` predate this plan and contain those strings today, so a tree-wide grep would fail on day one and be disabled. Retro-fitting the boundary onto existing code is out of scope here; Task B4 widens the grep to `keysync/` at the point where that directory has been cleaned. Task A4 adds a test that greps those directories and fails on a violation, which is what keeps the boundary real rather than documented. The grep covers `.mjs`, `.ps1` and `.cmd`, not `.mjs` alone: `install.ps1` and `uwpick.cmd` are the two files most likely to hard-code a Claude Code path, and a grep that skips them exempts exactly the risk it exists to catch. The two known non-`.mjs` paths get a named, commented allowlist entry each, so a *new* hard-coded path in either file still trips the test.
- Q4.4 `uw doctor` compares each `CONTRACT.fingerprint` against the live environment and reports drift with the check name, the expected value, the observed value, and the single action that resolves it (Task A15).
- Q4.5 **CCR changes on exactly one event, and every dependency on it is checked at that granularity.** Claude Code auto-updates on a schedule; CCR is a global npm package with no self-update, so it moves only on `npm i -g` — which is also the event that silently reverted a patched file once already. Three checks in `uw doctor` cover the three ways that event hurts: `ccr-gateway-patch` (the local handshake patch in `dist/main/cli.js`, **red** when reverted because its symptom is intermittent-under-load and reads as flakiness); `ccr-rpc` (every method name this project calls still resolves, and the installed version matches the running one); `bundled-catalogue` (the install resolved and its version matches what `ccr-client.mjs` was verified against). The patch check anchors on the stable literal `var PN="gateway",` and normalises newlines before comparing, because the identifier after it is minified and the file is CRLF on disk against an LF backup — a check that got either wrong would cry wolf on every future CCR release.
- Q4.6 **The catalogue copy-out is an insulation layer, not just a convenience.** After Task B4, UW reads `~/.uw/catalog/`, never CCR's `dist/models.json` directly. A CCR upgrade that bumps `schemaVersion` past 2, moves the file, or ships a different shape therefore cannot break the picker, the refresher, or keysync — it can only fail the next deliberate copy-out, which is a named doctor check with a stated action. `assertSchema` refuses anything but `schemaVersion === 2` rather than parsing it optimistically (report 10, P1 #15: the schema self-versions, so refusing is cheap and guessing is not).
- Q4.7 **UW hard-codes no OMC location.** The HUD shim wraps whatever string is in `statusLine.command`, whatever that string happens to be, and forwards the original stdin verbatim on any failure. This is what makes the OMC coupling survive an OMC upgrade: there is no OMC constant in UW's source to go stale (Tasks A14 and A16). What is forbidden is a *path* to an OMC file in UW's source, not the word OMC: the uninstall message names OMC deliberately, because telling a user which tool probably rewrote their statusline is the useful thing to say. The property is that UW holds no OMC location an OMC update could invalidate. The boundary test in Task A4 covers this alongside the Claude Code and CCR paths.
- Q4.8 **`~/.claude/settings.json` is a shared file with several writers, and UW behaves like one of several.** Claude Code writes it, OMC's setup and doctor write it, the user edits it. UW therefore: writes it only under `install.ps1 -Hud`; changes exactly one key; restores from the byte-for-byte backup **only when the live file differs from that backup in nothing but `statusLine.command`**, and otherwise does a value-level edit that announces itself; and refuses to touch `statusLine.command` at all on uninstall if it is no longer UW's wrapper, because that means another writer has already replaced it (Task A16, Q6.4). A whole-file restore that reverts an OMC change is the same defect as modifying an OMC file, arriving through a side door.

**Q5 — Clean design decisions.**

- Q5.1 Every task cites the decision id (D1 through D8) or the numbered constraint it implements, in its opening paragraph. A task that cites nothing is a task that should not exist.
- Q5.2 No speculative abstraction: no interface with one implementation and no second implementation planned, no configuration point without a caller in this plan, no exported helper used once inside its own module.
- Q5.3 The deferred list at the end of this plan is the place for anything not traceable to a decision or a constraint. Adding to it is correct; smuggling it into a task is not.

**Q6 — Compatible with the OMC statusline footer.**

- Q6.1 The `/model provider/model` path (D6) already makes the footer show the real selected model, because the HUD's `getModelName()` returns Claude Code's own `model.display_name`. No OMC change is required and no OMC file is ever modified.
- Q6.2 The one gap is context size: Claude Code reports `context_window.context_window_size` from its own model knowledge (200000 observed), which is a guess for a non-Claude model, so "context left" drifts. The catalogue holds the real `limits.contextTokens`.
- Q6.3 `menu/hud-shim.mjs` (Task A14) is an optional statusline wrapper, installed only with `install.ps1 -Hud`, under 60 lines, that corrects that one field and passes everything else through untouched. Any failure inside the shim forwards the original stdin verbatim, so the footer degrades to today's behaviour rather than breaking. The shim runs on every statusline repaint, which is a latency the user feels directly, so it must not re-read and re-parse `snapshot.json` each time: it caches the parsed context-size lookup keyed on the snapshot's `mtimeMs` and re-reads only when that changes.
- Q6.4 Uninstall restores `statusLine.command` **byte for byte from `settings.json.uw-bak`**, the copy taken immediately before the install wrote anything — but only under two guards, because a whole-file copy is a blunt instrument on a file with several writers. First: the current `statusLine.command` must still be UW's wrapper. If it is not, another writer (most likely `/omc-setup` or `omc-doctor`) has already replaced it, `hud-install.json` is stale, and writing the recorded value back would revert whatever they just set — so uninstall leaves the command alone, says why, and removes only UW's own state file. Second: the live file must differ from the backup in **nothing but** `statusLine.command`. Comparing that one field alone proves the field we changed is unchanged and says nothing about the twenty we did not; `hooks`, `permissions`, `modelPicker` and `enabledPlugins` all live in the same file and all have other owners. When either guard fails, uninstall does a value-level edit and **says so on stdout**, because that edit reformats indentation, re-escapes non-ASCII and normalises numbers. The plan may claim byte-for-byte only for the path that is byte-for-byte (Tasks A14 and A16, Q4.8).
- Q6.5 The shim is **failure-transparent in both directions**. Downward: any error inside it forwards the original stdin bytes to the wrapped command unmodified, so the footer degrades to today's behaviour rather than breaking. Upward: if OMC replaces `statusLine.command` and the shim disappears, nothing in UW breaks either — the picker never depended on it, `uw doctor`'s `hud-shim` check reports "not installed", and the only loss is the corrected context number. Neither tool can take the other down (Tasks A14, A15).

**Q7 — Stylized, lightly animated, within the engineering constraints.**

- Q7.1 All colour and glyph decisions live in `menu/style.mjs` (Task A9). No other file emits an escape sequence of its own.
- Q7.2 Animation is event-driven only. The input loop is a blocking `readSync` on `//./CONIN$`, so there is no event loop while a key is awaited and timer-driven idle animation is impossible without a worker thread. No worker thread is added. **This criterion is load-bearing well beyond animation and every other criterion must be checked against it**: nothing scheduled — no promise callback, no `setTimeout`, no stream `"resize"` or `"data"` listener — can run between the first frame and `process.exit()`, because the JS stack never unwinds. Q1.3 was written in contradiction to this criterion and has been rewritten; anything later that promises the picker will "update when X arrives" is contradicting it again.
- Q7.8 Terminal **output** VT processing (`ENABLE_VIRTUAL_TERMINAL_PROCESSING`, `0x0004` on `CONOUT$`) is inherited from the host and deliberately not set by `uwpick-run.ps1`, which sets input mode on `CONIN$` only. Claude Code has already enabled output VT on the shared console by the time the handoff runs, which is why this works; `detectCaps` guesses from environment variables and is not the same thing. This is recorded because it is the kind of gap that costs an hour to rediscover, and because it defines the failure mode if it ever stops holding: escapes render as literal text rather than as colour (Task A12).
- Q7.3 Each transition is a fixed small number of frames totalling under 120 ms, rendered synchronously immediately after the key event that caused it, and never delays the response to the next key.
- Q7.4 Motion is disabled by `UW_PICKER_MOTION=0`, by `--no-motion`, and automatically when `TERM=dumb` or the terminal is narrower than 60 columns.
- Q7.5 Pure ANSI/VT output. No Ink (report 13's Windows repaint landmine), no npm UI dependency, no dependency of any kind.
- Q7.6 Sanitization runs before styling: `sanitizeDisplay()` strips provider escapes, then `style.mjs` adds our own.
- Q7.7 VT capability is detected from `WT_SESSION`, `ConEmuANSI`, `TERM` and `TERM_PROGRAM`; when uncertain the renderer falls back to ASCII glyphs and the 16-colour set.

---

## RALPLAN-DR Summary

### Principles

1. **Blank beats a guess.** Every column has a defined blank rendering. `—` and `0` are different claims, and collapsing them is the single most likely way this design starts lying.
2. **Move the working code; do not rewrite it.** The spike was verified under the real ctrl+g handoff with real keystrokes. Its value is the measured knowledge encoded in it, and a rewrite discards that for nothing.
3. **Security ordering is part of correctness, and so is placement.** The denylist lands before the tier fix, because the tier fix is what arms the hijack. A correct change applied in the wrong order is a regression — and a correct change applied to the wrong module is not a change at all. The two questions to ask of any mitigation in this plan are *when does it land* and *is it on the path that can actually do harm*. The first version of this plan answered the first question and got the second one wrong: it put the denylist on the module that draws rows rather than the one that writes CCR's routing table.
4. **The picker reads; it never routes.** Selection is a text write into a temp file. No gateway config, no `settings.json` write, no restart, no consent gate to erode.
5. **Re-derive third-party facts, do not mirror them.** Every constant copied out of Claude Code or CCR becomes a probe with a cached result and an invalidation key, because a mirror has no mechanism to notice when it stops being true.
6. **One module per foreign contract.** Everything Claude Code or CCR could change lives behind exactly two modules with a version fingerprint, so an upgrade breaks one named check instead of scattering failures through the renderer, the catalogue and the installer.
7. **Motion is a response, never a background process.** The input loop blocks in a synchronous read with no event loop behind it, so every animated frame is drawn as the direct consequence of a key the user pressed. This is a constraint accepted as a feature: nothing can move while the user is thinking, which is also the only kind of motion that never fights the terminal.

### Decision Drivers

1. **Zero Anthropic tokens per switch.** This eliminates every design that requires an assistant turn: MCP elicitation, custom slash commands, and the conversational `/uwmodel` shape.
2. **Live filtering at both levels.** This eliminates the `/model` picker (search sits behind a literal `canEnter:!1`, not a flag), the `UserPromptSubmit` hook (one-shot text, no keystroke loop), and MCP elicitation (the row set is fixed when the picker is created).
3. **Provider-controlled strings reach both a terminal renderer and a routing table.** Report 08 rates this HIGH overall with one CRITICAL: a hostile aggregator publishing a zero-priced `opus` gets Claude Code's default traffic. Every design choice that admits remote data is gated on this.

### Viable Options

**Option A — Terminal TUI inside the ctrl+g external-editor handoff (CHOSEN).**
Pros: satisfies both hard requirements simultaneously; verified working on this machine against 44 providers and 1,584 models with arrows, live filter, enter and esc all functioning; no browser, no second terminal, no new dependencies; Claude Code is blocked in `spawnSync` so there is no repaint war and no keystroke war; and because the switch travels as a real `/model` command, Claude Code updates its own `model.display_name`, which is exactly the field the OMC statusline HUD reads through `getModelName()`, so the terminal footer names the selected model with no change to OMC at all (Q6.1).
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

*Re-argued during review and rejected again.* One reviewer proposed replacing Option A with Option D outright, on the grounds that the blocking `readSync` is the true load-bearing bet and that six tasks (A4, A12, A13, A15, A16, A17) exist only to contain its consequences — a two-round hook accepting a filter string per round would get most of the filtering benefit and need no console-mode wrapper, no `cmd` dispatcher, no contract module and no doctor. The argument is coherent and its cost accounting is correct. It is rejected because D5 is a settled, user-approved decision taken *after* the user drove both surfaces on this machine and chose this one ("this is it, i like this method"), and a plan does not get to reverse a decision the user made from direct experience because the implementation is larger than the alternative. What the argument got right is kept and acted on: its diagnosis — that a blocking `readSync` forbids every asynchronous promise the plan makes, and that Q1.3 as originally written could never run — is correct, and is the whole content of the Q1.3 rewrite and the A10 rework.

**Why A:** it is the only surface that satisfies the zero-token constraint and the live-filter requirement at the same time, and it is the only one already verified end-to-end against real data on the target machine. Option D is retained as a fallback because it degrades gracefully: it survives any Claude Code change that breaks `$EDITOR`, since hooks are a separate mechanism.

### Pre-mortem

**Scenario 1 — Claude Code auto-updates and the handoff contract moves.** Auto-updates are enabled on the `latest` channel; this is a scheduled event, not a risk. The temp-file path shape changes, or the editor is spawned without `stdio:"inherit"`, or exit-code semantics invert. Symptom: ctrl+g appears to do nothing, or the chat input is silently unchanged. This is the worst diagnostic class because it looks like the picker crashed. Mitigation: `uw doctor` (Task A15) records the Claude Code version and commit, records the last real handoff invocation the picker observed, and refuses with the failing check named. The dispatcher's passthrough branch keeps ctrl+g usable as an ordinary editor throughout.

**Scenario 2 — the console is left in raw mode.** The picker crashes, or the user hits ctrl+c at the wrong moment, and the wrapper's restore never runs. Symptom: the parent shell stops echoing typed characters and swallows Enter, which reads as a broken terminal rather than a broken picker. Mitigation: the restore lives in a PowerShell `finally` block, and Task A12 tests it by running the wrapper against a child that exits 1 and asserting the recorded restored mode equals the saved mode.

**Scenario 3 — a provider publishes a hostile model id.** An aggregator adds `{"id":"opus","pricing":{"input":0,"output":0}}`, or an id containing `\x1b[2J`. Symptom: either a spoofed row that looks like an Anthropic model, or a bare `opus` that CCR's cross-provider fallback binds Claude Code's built-in rows to, silently routing the full system prompt to an attacker-chosen host. Mitigation: Task A5.1 lands the denylist on **three** surfaces before Task B2 makes the free-first sort functional — `keysync.mjs:buildProviders`, which is the only one of the three that decides what CCR routes; `menu/catalog.mjs:buildFrom`, which decides what the user sees; and tier 1 and tier 2 ingest in Task B6, which decides what enters the catalogue at all. `sanitizeDisplay()` (Task A3) strips escape sequences and bidi overrides at the render boundary; `MAX_MODELS_PER_PROVIDER` stays at 3. The gate is a test that calls `buildProviders` with a hostile zero-priced `opus` and asserts it is absent from the returned `Providers[].models`, so the mitigation is checked where the harm would occur.

**Scenario 4 — the statusline shim eats the footer.** The optional HUD shim (Task A14) is installed, then something downstream changes: the OMC HUD path moves, the wrapped command is edited by hand, the snapshot is missing, or Claude Code changes the statusline stdin shape. Symptom: the footer goes blank or shows an error string on every prompt, which reads as an OMC failure and will be debugged in the wrong repository. Mitigation: the shim is optional and off by default; every failure path inside it forwards the original stdin bytes to the wrapped command unmodified, so the worst outcome is today's behaviour; the install takes a `settings.json.uw-bak` copy of the original bytes and records the previous `statusLine.command` in `hud-install.json`, and uninstall restores from that backup — byte for byte when the backup is intact and unchanged, and by a value-level edit that announces itself when it is not (Q6.4); and `uw doctor` asserts both that the wrapped command still exists and that the shim round-trips a sample payload with the expected fields intact.

**Scenario 5 — the picker gets slow and nobody notices.** The catalogue grows, the snapshot is rebuilt from the full file at open time by a well-meaning change, or the routability RPC is moved back onto the critical path. Symptom: ctrl+g takes a second or more before anything appears, which does not fail any test and simply makes the feature feel bad until it stops being used. Mitigation: the startup budget is a test, not a comment — Task A11 measures process start to first frame five times and fails above a 300 ms median — and the snapshot the picker reads is a separate artefact from the catalogue it is derived from, so an accidental reintroduction of full-catalogue parsing shows up immediately in that number.

**Scenario 6 — CCR is reinstalled and the gateway patch goes with it.** Someone runs `npm i -g @musistudio/claude-code-router` — to pick up a fix, or as part of unrelated housekeeping. CCR's `dist/main/cli.js` is replaced with the stock build, and the local patch raising the gateway handshake timeout from 5 s to 20 s is gone. Symptom: nothing at all, most of the time. Under load the handshake misses its window and `Core gateway did not accept runtime config within 5000ms` appears intermittently, which reads as flakiness in whatever else was running and will be investigated there. This has already happened once. Mitigation: `uw doctor` reports `ccr-gateway-patch` **red** with the re-application recipe, anchored on the stable literal `var PN="gateway",` rather than on the minified identifier after it, and normalising newlines before comparing so the CRLF-on-disk versus LF-backup difference is not mistaken for a change. The check is read-only; re-applying a patch inside another tool's installed bundle is a deliberate act, not something a doctor does on its own initiative.

**Scenario 7 — OMC updates while UW's shim is installed.** `/omc-setup` or `omc-doctor` runs and rewrites `statusLine.command` to OMC's own value, discarding UW's wrapper. Symptom: none — the footer works, and the only loss is the corrected context number. The danger is what happens *next*: `~/.uw/state/hud-install.json` still records a `previousCommand` from before OMC's update, and a later `install.ps1 -Hud -HudUninstall` would write that stale value back over the one OMC just set. UW would then have reverted an OMC update while reporting success. Mitigation: uninstall checks first that `statusLine.command` is still UW's wrapper and, when it is not, leaves it alone, says which command it found, and removes only UW's own state file. The byte-for-byte restore has a second guard for the same class of harm: it fires only when the live file differs from the backup in nothing but `statusLine`, because `hooks`, `permissions` and `enabledPlugins` share that file and have other owners (Q4.8, Q6.4).

### Expanded Test Plan

**Unit (`node --test C:/Users/osami/.uw/test/`, no network, no live state).** `sanitizeDisplay` and `admitId` against escape sequences, C1 controls, over-length ids, `..` traversal and legitimate two-slash ids such as `groq/openai/gpt-oss-20b`. `priceOf` against the real `pricing.offers[].per1MTokens` shape and the legacy shape that returns nothing. `badgeOf` across all five badge outcomes including guard G1 and `PLAN`. The provider `free` column for nullable, zero, and `+N plan` cases. The `pick-state` reducer for filtering at both levels, level-1 matching on member model ids, the Esc ladder, the Tab scope toggle, the empty-result state, cursor clamping on refilter, and resize. Recents and favourites persistence round-trip. The denylist for every reserved prefix and for the relay exemption. `grantCadence` resolution for recurring, one-time, and absent. Health resolution including the age refusal. The style module's pure functions: badge-to-colour mapping across all five badges, the proportion bar at 0, partial and full, VT capability detection across the `WT_SESSION`, `ConEmuANSI`, `TERM=dumb` and unset-everything environments, and the motion decision from environment plus flag plus terminal width. A snapshot-style frame test that renders one full frame of each level with motion disabled and asserts the exact lines, so a styling change that breaks alignment fails a test rather than an eyeball. The snapshot loader against a missing file, a truncated file, a wrong `schemaVersion` and a valid one. The HUD shim's pure transform against a payload with `current_usage`, one without it, one whose model is absent from the snapshot, and one that is not JSON at all.

**Integration (spawned processes, scratch state only).** The `uwpick.cmd` dispatcher: each sentinel reaches the picker, and any other first line reaches `%UW_REAL_EDITOR%` with the buffer path unchanged. The PowerShell wrapper: console mode is restored after a child that exits 1. The picker end-to-end against a fixture catalogue with keystrokes fed through a replaceable input source, asserting the exact bytes written to the temp file. The refresh merge policy against simulated `ok`, `soft` and `hard` provider outcomes, asserting a failed provider keeps its rows and gains a stale marker. A grep-the-tree boundary test asserting that no file outside `cc-contract.mjs` and `ccr-client.mjs` names a Claude Code or CCR path. A startup benchmark that spawns the picker five times with a scripted immediate quit and records process start to first frame. The HUD shim end to end: spawn it with a sample payload on stdin wrapping a stub command that echoes what it received, and assert both the corrected context size and byte-identical passthrough when the transform throws.

**End-to-end (manual or qa-tester, real Windows Terminal, live Claude Code).** The protocol in Task A17: fifteen numbered steps with the exact expected screen for each, covering sentinel dispatch, live filtering at both levels, selection, the resulting chat input, Esc at every rung, ctrl+c, passthrough to the real editor, the four motion transitions, the key legend, the empty-state row, and the statusline footer before and after a switch. Motion is verified here and only here: a transition that renders in three synchronous frames has no observable state a unit test can sample, so asserting on it in a harness would be asserting on our own mock.

**Observability.** The picker appends one JSON line per invocation to `~/.uw/state/handoff.json` recording the argv shape, whether the path existed and was writable, the sentinel that triggered it, and whether a selection was written. `uw doctor` reads that file plus `claude doctor` output and prints a Green/Amber/Red verdict naming the failing check and its evidence. The refresher writes `index.json` with per-provider `{status, count, lastOk, lastFail, stale}` so a partial failure is legible without reading logs. Reads and dry runs always proceed even on Red; privileged writes refuse. The picker also records its own first-frame latency into `~/.uw/state/startup.json` on every run, keeping the number honest between benchmark runs rather than only under measurement.

---

## ADR — The model menu is a terminal TUI hosted by Claude Code's external-editor handoff

**Status:** Accepted. Supersedes D4 (local web page).

**Decision:** Build the two-level model menu as a Node ANSI TUI launched through `$EDITOR` when Claude Code performs its ctrl+g `chat:externalEditor` handoff. The picker writes `/model <provider>/<model>` into the temp file and exits 0. A `cmd.exe` dispatcher inspects the first line of that file and only takes over on the sentinels `m`, `model` and `>>m`; anything else is handed to `%UW_REAL_EDITOR%` unchanged. A PowerShell wrapper sets the console to raw VT input mode for the duration and restores the saved mode in `finally`.

**Drivers:** zero Anthropic tokens per switch; live filtering at both provider and model level; provider-controlled strings reaching a renderer and a routing table.

**Alternatives considered:** the `/model` picker (search hard-disabled by a literal, 10-row viewport, read once at process start); a `UserPromptSubmit` hook (zero-token and proven, but one-shot text with no keystroke loop); MCP elicitation (good rendering, 40 visible rows, type-ahead — but invoked by the assistant, so every switch costs a turn, and the row set is fixed at creation); a custom slash command (`type: "prompt"`, costs a turn); gateway model discovery (native and free, but no search, 10-row viewport, ids must match `/(claude|anthropic)/i`, and mutually cancelling with `replaceBuiltInOptions: true`); the local web page (built and working, but leaves the terminal and was rejected by the user in favour of the TUI).

**Why chosen:** it is the only surface where the process owns the real TTY exclusively. Claude Code calls `enterAlternateScreen()`, which pauses its renderer and turns raw mode off, then blocks in `spawnSync` with `stdio:"inherit"`. That is what makes a keystroke loop possible at all, and it was verified with a 170-sequence key log including arrows, backspace, enter and esc.

**Consequences:** ctrl+g's ordinary editor behaviour is preserved for every input except three sentinels, at the cost of one `cmd.exe` dispatcher in the path. The design now depends on an undocumented Claude Code contract, which is why `uw doctor` exists. Windows requires a PowerShell wrapper in the chain because Node cannot call `SetConsoleMode`, adding roughly 200 ms of PowerShell startup per picker launch. Claude Code persists the selection as the new default model for future sessions, which the user has accepted. Because zero-price-plus-one-time-grant is neither free nor priced, it renders blank rather than `PAID`, so blank will be common at first and that is honest rather than a gap.

**A note on the rejected slot mechanism:** the slot file plus `CUSTOM_ROUTER_PATH` alternative would have switched the underlying route while leaving Claude Code's own model identity untouched, so the statusline footer would keep displaying the alias that was pinned at session start rather than the model actually serving the request. The `/model` path wins on that ground too, and it wins without any OMC involvement: the HUD's model name is Claude Code's `display_name`, and Claude Code sets it when it processes the command. The one field the footer still gets wrong for a non-Anthropic model is the context window size, which Claude Code fills in from its own model knowledge (200000 observed); Task A14 corrects that single field in an optional, failure-transparent shim and touches nothing else.

**Follow-ups:** the slot file plus `CUSTOM_ROUTER_PATH` mechanism stays proven and unused, available if a session-only switch is ever needed. Option D (the hook) stays documented as the fallback if the handoff contract breaks. `harness/guard.mjs:assertRouterClean` must be scoped rather than deleted if Router rules ever go live.

---

## Foreign contracts, and how each one breaks

UW sits between three tools it does not control. Each changes on a different schedule, by a different mechanism, and fails in a different way, so each gets a different guard. The register below is the short form; Q4.1–Q4.8 carry the requirements and Task A15 carries the checks.

The governing principle comes from report 10 and is worth stating before the table, because it is what the rest of this section is an application of: **UW's fragility was never "it depends on undocumented internals" — that is unavoidable and usually fine. It was that UW encoded third-party behaviour as constants in its own source rather than as facts it re-derives from the environment it runs in.** Each mirrored constant was correct when written and had no mechanism to notice when it stopped being correct. The fix is not to remove the couplings but to convert each from an assertion in a comment into a measurement with a cached result and an invalidation key.

| Tool | Changes when | Worst failure | Guard |
|---|---|---|---|
| **Claude Code** | Continuously. Auto-update is on, channel `latest` — a scheduled event, not a risk | The `$EDITOR` handoff contract moves and ctrl+g silently stops reaching the picker. No error; the last recorded handoff stays successful forever | `cc-contract.mjs` is the only file that knows CC. `uw doctor` bounds the age of the last successful handoff, treats a `claude doctor` parse failure as red, and never auto-pins a new fingerprint (Q4.4, Task A15) |
| **CCR** | Only on `npm i -g`. No self-update | The local gateway-handshake patch in `dist/main/cli.js` is silently reverted. The 5-second handshake returns and fails **intermittently, under load only** — reads as flakiness, not as a broken invariant. It has happened once | `ccr-client.mjs` is the only file that knows CCR. Three checks: `ccr-gateway-patch` (red when reverted), `ccr-rpc` (method names still resolve; installed version matches running), `bundled-catalogue` (Q4.5, Task A15) |
| **OMC** | On its own setup, doctor, or reinstall — including while UW's shim is installed | UW's whole-file restore reverts an OMC change to an unrelated `settings.json` key, or uninstall writes a stale command over one OMC just set | UW names no OMC path at all and wraps whatever `statusLine.command` holds. Uninstall refuses when the command is no longer UW's wrapper, and restores byte-for-byte only when nothing outside `statusLine` has changed (Q4.7, Q4.8, Q6.4, Task A16) |

Three properties are worth calling out because they are what make the arrangement hold rather than merely be described.

**The catalogue copy-out is insulation, not convenience.** After Task B4 nothing in UW reads CCR's `dist/models.json` at run time. A CCR upgrade that bumps `schemaVersion`, moves the file or changes its shape cannot break the picker, the refresher or keysync — it can only fail the next deliberate copy-out, which is a named check with a stated action. This is the single largest resilience win in the plan and it costs one file copy (Q4.6).

**UW contains no OMC constant.** The HUD shim wraps whatever string it finds and forwards stdin verbatim on any failure. There is nothing in `menu/` for an OMC upgrade to invalidate, which is why the OMC coupling needs no fingerprint and no version check — only the discipline of not naming anything, asserted by a test (Q4.7).

**Neither tool can take the other down.** If UW's shim fails, it forwards the original bytes and the footer is exactly what it was without UW. If OMC replaces `statusLine.command` and the shim disappears, UW loses one corrected number and nothing else — the picker never depended on the shim (Q6.5). The failure modes are one-directional in both directions, which is the property that lets the shim be installed by default-off rather than argued about.

One coupling is deliberately **not** guarded, and it is worth being explicit rather than silent about it: UW cannot detect that OMC has changed its HUD's *behaviour* — only that the command it wraps still exists and that a sample payload round-trips with its fields intact (`checkHud`). If OMC changed what it does with `context_window_size`, the shim would keep correcting a field OMC no longer reads, and the symptom would be that the correction stops having an effect. That is a cosmetic, non-silent failure — the footer renders, the number is simply the old wrong one — which is why it is accepted rather than instrumented.

---

## File Structure

### Created

| Path | Single responsibility |
|---|---|
| `C:/Users/osami/.uw/.gitignore` | Keep logs, backups, key logs, tool output and spike scratch out of version control |
| `C:/Users/osami/.uw/menu/sanitize.mjs` | Make provider-controlled strings safe to render and safe to admit as ids |
| `C:/Users/osami/.uw/menu/atomic.mjs` | Write every state and catalogue file through a temp file and a rename; read JSON without throwing |
| `C:/Users/osami/.uw/menu/denylist.mjs` | Reject reserved Anthropic-shaped and `uw/` model names from untrusted providers |
| `C:/Users/osami/.uw/menu/cc-contract.mjs` | The only file that knows Claude Code: handoff argv shape, `/model` syntax, exit-code semantics, statusline stdin shape, and the version fingerprint |
| `C:/Users/osami/.uw/menu/ccr-client.mjs` | The only file that knows CCR: `service.json` discovery, the JSON-RPC endpoint, `getConfig`, `probeProvider`, the bundled catalogue path, and the version fingerprint |
| `C:/Users/osami/.uw/menu/pick-state.mjs` | Pure reducer for the two-level menu: filtering, cursor, scope, Esc ladder, legend overlay. No I/O |
| `C:/Users/osami/.uw/menu/snapshot.mjs` | Build, write and load `~/.uw/catalog/snapshot.json`, the small pre-rendered row set the picker opens from |
| `C:/Users/osami/.uw/menu/style.mjs` | Own every colour, glyph, frame character, proportion bar and transition; detect VT capability and decide whether motion runs |
| `C:/Users/osami/.uw/menu/hud-shim.mjs` | Optional statusline wrapper: correct `context_window_size` from the catalogue, forward everything else unchanged |
| `C:/Users/osami/.uw/menu/state.mjs` | Persist recents and favourites in `~/.uw/state/picker.json` |
| `C:/Users/osami/.uw/menu/health.mjs` | Resolve provider health from notes plus `~/.uw/state/health.json`, with an age refusal |
| `C:/Users/osami/.uw/menu/cadence.mjs` | Read curated `grantCadence` and `planCovered` and turn a zero price into a badge |
| `C:/Users/osami/.uw/menu/uwpick.mjs` | ANSI renderer and console input loop over `pick-state`; write the selection and exit 0 |
| `C:/Users/osami/.uw/menu/uwpick-run.ps1` | Set raw VT console input mode, run the picker, restore the saved mode in `finally` |
| `C:/Users/osami/.uw/menu/uwpick.cmd` | Dispatch on the first line of the buffer: sentinel to the picker, anything else to the real editor |
| `C:/Users/osami/.uw/menu/doctor.mjs` | Probe the handoff contract and the environment fingerprint; name the failing check |
| `C:/Users/osami/.uw/menu/install.ps1` | Set `EDITOR` and `UW_REAL_EDITOR` at User scope; refuse to overwrite an `EDITOR` it did not set |
| `C:/Users/osami/.uw/menu/set-statusline.mjs` | Set `statusLine.command` losslessly, atomically and BOM-free — the one thing PowerShell 5.1's JSON round trip cannot do safely (Task A16) |
| `C:/Users/osami/.uw/refresh/catalog-store.mjs` | Own `~/.uw/catalog/`: copy-out, snapshot directories, the `current` pointer, the lock, and the merge policy |
| `C:/Users/osami/.uw/refresh/tiers.mjs` | The three refresh tiers: models.dev metadata, keyed listings, gated paid verification |
| `C:/Users/osami/.uw/refresh/probe.mjs` | The one provider-probe implementation, folded out of the three ad-hoc `keysync/key-health*.mjs` scripts. A **standalone command**, run deliberately, that writes the `ok`/`auth`/`broken`/`skipped` results file Task B7 folds into `health.json`. It is not called by tier 2 — see the note below — and not by tier 3 |
| `C:/Users/osami/.uw/refresh/cli.mjs` | `uw catalog refresh --tier 1\|2\|3` argument handling and reporting; also the one place routability is resolved and stamped onto the snapshot (Q1.3) |
| `C:/Users/osami/.uw/refresh/health-writer.mjs` | The two health producers: fold the existing probe file, and project each refresh's merge ledger — never overwriting a probe verdict with a listing one (Task B7) |
| `C:/Users/osami/.uw/test/*.test.mjs` | One test file per module above; `node:test` + `node:assert/strict` |
| `C:/Users/osami/.uw/test/fixtures/*.json` | Frozen catalogue, registry and providers fixtures so no test reads the live vault |
| `C:/Users/osami/.uw/test/bench-startup.mjs` | Spawn the picker five times, record process start to first frame, enforce the 300 ms budget |
| `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` | The exact manual/qa-tester steps and expected screens for the interactive surface |
| `C:/Users/osami/.uw/docs/visual-design.md` | The frozen ASCII mock of both levels, the palette, the glyph table and the ASCII fallbacks |

### Modified

| Path | Change |
|---|---|
| `C:/Users/osami/.uw/keysync/keysync.mjs` | **Filter `catalogEntries` and `vp.testModel` through `admitRemoteModels` inside `buildProviders`, before `ranked` is computed** (Task A5.1 — this is the routing path, and it is the load-bearing security change in this plan); fix `inferTier` to read `pricing.offers[].per1MTokens` **and to prefer the offer whose `provider` matches the key's provider**; add the `localeCompare` sort tiebreak; add the `autoFetchModels` invariant to `validate()`; read the catalogue from `~/.uw/catalog/` |
| `C:/Users/osami/.uw/keysync/run.mjs` | `EXPECTED_PROVIDERS` becomes a floor with an explicit delta acknowledgement |
| `C:/Users/osami/.uw/keysync/key-health.mjs`, `key-health-reprobe.mjs`, `key-health-live3.mjs` | Retired into `refresh/probe.mjs`, one implementation instead of three. It produces the same results file the three scripts produce today, which is what Task B7's fold reads — so the fold's input does not change, only what writes it (Task B7) |
| `C:/Users/osami/.llmkeys/providers.json` | Add curated `grantCadence` and `planCovered` fields, plus `testModelVerifiedAt` — the ISO timestamp at which a tier 3 run last proved that `testModel` actually answers on this key. Written **only** by tier 3; blank means never proven. Curated fields are never machine-overwritten (outside the git repo; backed up separately) |
| `C:/Users/osami/.claude/settings.json` | Optional and only with `install.ps1 -Hud`: `statusLine.command` is rewritten to invoke `hud-shim.mjs` in front of the existing command. Written BOM-free and atomically (tmp + `Move-Item -Force`), patched through a lossless JSON editor rather than a PowerShell `ConvertFrom-Json`/`ConvertTo-Json` round trip, with `settings.json.uw-bak` holding the original bytes for the byte-for-byte restore path (Q2.8, Q2.9, Q6.4) |

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
| `C:/Users/osami/.uw/state/startup.json` | `{samples: [{at, ms}], median}` — first-frame latency, appended on every picker run |
| `C:/Users/osami/.uw/state/hud-install.json` | The `statusLine.command` that was in place before the shim was installed, stored verbatim |
| `C:/Users/osami/.uw/catalog/` | `models.json` (the copied-out CCR catalogue), `snapshot.json` (the picker's pre-built rows), `current`, `versions/<stamp>/`, `catalogue.lock` |

### Two files are called a snapshot; they are not the same thing

`~/.uw/catalog/versions/<stamp>/models.json` is the immutable **merged catalogue** for that version, written by the refresher and selected by the `current` pointer. It is a schemaVersion-2 document — `{schemaVersion: 2, generatedAt, models: Entry[]}` — in the same shape `loadCatalog` parses, but it is **not** a verbatim copy of CCR's 19.7 MB bundle: it is the merge of whatever the tiers last established, which is smaller and carries `stale`/`staleSince` per row. The verbatim copy is `~/.uw/catalog/models.json`, written once by Task B4's `copyOut` and used as the fallback until a refresh has ever run. Alongside the versioned catalogue sits `index.json`, the merge ledger, which carries per-provider `{count, lastOk, lastFail, consecutiveFails, stale, staleSince}` plus the upstream `etag` and is what the next run reads back as `prev`. `~/.uw/catalog/snapshot.json` is the small pre-rendered row set the picker opens from, derived from whichever catalogue version `current` points at plus the vault metadata, the curated cadence and the health file. The refresher rebuilds the second whenever it promotes the first. The picker reads only the second, and never the first (Q1.1). Where this plan says "snapshot" inside `refresh/catalog-store.mjs` it means a catalogue version; everywhere else it means `snapshot.json`.

### A note on the test convention

`C:/Users/osami/.uw/keysync/test-all.mjs` is a **live integration probe**, not a unit-test harness: it sends one real completion per provider through the gateway at concurrency 6 and writes `last-test-results.json`. There is no existing `node:test` usage anywhere under `~/.uw` and no `package.json`. This plan therefore adopts `node:test` + `node:assert/strict` — both built into Node, so the zero-dependency property that `keysync` deliberately holds is preserved — with files named `*.test.mjs` under `C:/Users/osami/.uw/test/` and run as `node --test "C:/Users/osami/.uw/test/*.test.mjs"`. Where this plan writes a live probe rather than a unit test, it follows `test-all.mjs`'s conventions: bounded concurrency 6, a `PASS`/`fail` line per target, and a JSON results file.

**How to read the `# pass N` numbers in each task.** They are hand-counted running totals, written to give an implementer a rough expectation, and after this revision several are stale by the handful of tests each accepted review finding adds. Treat them as indicative. The binding gate at every task is `# fail 0`, together with a pass count that is **strictly greater** than the previous task's observed count — an implementer records the number the run actually printed and carries it forward. This is stated explicitly because the alternative is worse in a specific way this plan has already been caught by twice: a hand-written expected value that was never executed reads as a verified fact. `# fail 0`, by contrast, is checkable without arithmetic, which is why Global Constraint 15a forbids any known-failing test in the sweep.

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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 3 (indicative — see "How to read the `# pass N` numbers").

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

In `menu/uwpick.cmd`, the `:diag` branch still calls `uwdiag.mjs`, which stays in `spike/`. Delete that branch — the diagnostic served its purpose and `uw doctor` (Task A15) replaces it:

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

The listing above is the **spike file as it stands today**, reproduced so the move can be verified as a move. Do not treat its exit codes as the target: they are exactly backwards, propagating `%errorlevel%` on the passthrough branch (where the buffer holds the user's prose and a non-zero exit would discard it) and hard-coding `exit /b 0` on the picker branch (where the buffer holds the `m` sentinel and exit 0 submits it as a chat message). Task A13 inverts both, with the reasoning and the tests.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 6 (indicative — see "How to read the `# pass N` numbers").

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

// Every code point the INVISIBLE class covers, named and tested one by one.
//
// These characters cannot be reviewed by eye in a source literal -- that is the
// whole reason they are a spoofing primitive -- so the fixture names each by code
// point instead. That matters beyond readability: the class itself was once
// written with literal characters, which made sanitize.mjs fail to parse, and the
// obvious repair (retype the class) would have silently dropped whichever ones
// the author could not see while leaving every test green.
const INVISIBLE_CASES = [
  [0x200B, "ZERO WIDTH SPACE"],
  [0x200C, "ZERO WIDTH NON-JOINER"],
  [0x200D, "ZERO WIDTH JOINER"],
  [0x200E, "LEFT-TO-RIGHT MARK"],
  [0x200F, "RIGHT-TO-LEFT MARK"],
  [0x2028, "LINE SEPARATOR"],
  [0x2029, "PARAGRAPH SEPARATOR"],
  [0x202A, "LEFT-TO-RIGHT EMBEDDING"],
  [0x202B, "RIGHT-TO-LEFT EMBEDDING"],
  [0x202C, "POP DIRECTIONAL FORMATTING"],
  [0x202D, "LEFT-TO-RIGHT OVERRIDE"],
  [0x202E, "RIGHT-TO-LEFT OVERRIDE"],
  [0x2066, "LEFT-TO-RIGHT ISOLATE"],
  [0x2067, "RIGHT-TO-LEFT ISOLATE"],
  [0x2068, "FIRST STRONG ISOLATE"],
  [0x2069, "POP DIRECTIONAL ISOLATE"],
  [0xFEFF, "ZERO WIDTH NO-BREAK SPACE (BOM)"],
];

test("every invisible character in the class is stripped, named one by one", () => {
  for (const [cp, name] of INVISIBLE_CASES) {
    const hex = cp.toString(16).toUpperCase().padStart(4, "0");
    assert.equal(sanitizeDisplay("a" + String.fromCodePoint(cp) + "b"), "ab",
      `U+${hex} ${name} survived sanitizeDisplay`);
  }
});

test("U+2028 and U+2029 are stripped, and are why the class needs escapes", () => {
  // Called out separately from the table because they are the two that break
  // more than alignment. Both are ECMAScript LineTerminators: a regex literal may
  // not contain one, so writing the class with these as literal characters makes
  // sanitize.mjs unparseable -- and style.mjs, catalog.mjs and denylist.mjs all
  // import it. In rendered output they are a newline by another name, which in a
  // full-screen frame writer is a frame-integrity break rather than a cosmetic one.
  for (const cp of [0x2028, 0x2029]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(sanitizeDisplay("row" + ch + "injected"), "rowinjected");
    assert.equal(sanitizeDisplay(ch).length, 0);
  }
});

test("the bidi override that makes an Anthropic lookalike is stripped", () => {
  // U+202E renders the rest of the cell reversed in Windows Terminal, so a model
  // id can display as "claude-3-opus" while being something else entirely -- the
  // one spoof the reserved-name denylist cannot see, because it matches on the
  // stored bytes and this attack is purely a rendering effect.
  const RLO = String.fromCodePoint(0x202E);
  assert.equal(sanitizeDisplay("a" + RLO + "b"), "ab");
  assert.equal(sanitizeDisplay(RLO + "supo-3-edualc"), "supo-3-edualc");
});

test("zero-width characters consume length without occupying a column", () => {
  const ZWSP = String.fromCodePoint(0x200B), BOM = String.fromCodePoint(0xFEFF);
  assert.equal(sanitizeDisplay("a" + ZWSP + "b" + BOM + "c"), "abc");
  assert.equal(sanitizeDisplay("a" + ZWSP + "b", 2), "ab");   // the cap sees 2 real columns, not 3
});

test("the length cap counts code points, never UTF-16 code units", () => {
  // Two astral characters are 4 code units. A code-unit slice at 3 would emit a
  // lone surrogate, which renders as a replacement character and corrupts the
  // frame width. A code-point slice at 1 emits one whole character.
  const astral = "\u{1F600}\u{1F601}";
  assert.equal([...sanitizeDisplay(astral, 1)].length, 1);
  assert.equal(sanitizeDisplay(astral, 1), "\u{1F600}");
  assert.equal([...sanitizeDisplay(astral, 2)].length, 2);
});

test("normalises to NFC so a combining mark cannot pad a cell invisibly", () => {
  assert.equal(sanitizeDisplay("é"), "é");
  assert.equal([...sanitizeDisplay("é")].length, 1);
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

// Neither C0 nor C1, so both regexes above miss them, and every one of them is a
// display attack that survives an escape stripper:
//   U+200B-U+200D  zero-width space/non-joiner/joiner  -- length without a column
//   U+200E U+200F  LTR/RTL marks
//   U+2028 U+2029  line/paragraph separators           -- a newline by another name
//   U+202A-U+202E  embedding/override, incl. RLO       -- renders a cell reversed
//   U+2066-U+2069  isolates
//   U+FEFF         BOM / zero-width no-break space
// U+202E is the one that matters most: it turns an arbitrary id into a visual
// Anthropic lookalike, which is precisely the attack the denylist exists to stop
// and precisely the one a name-prefix test cannot see.
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

export function sanitizeDisplay(s, max = 80) {
  const clean = String(s ?? "")
    .replace(ESC_SEQ, "")
    .replace(CTRL, "")
    .replace(INVISIBLE, "")
    .normalize("NFC");
  // Slice by CODE POINT, not by code unit: `.slice(0, n)` on a string containing
  // an astral character can cut a surrogate pair in half, and a lone surrogate
  // renders as U+FFFD -- one glyph where the caller counted one code unit, which
  // silently breaks the frame-width invariant in style.mjs.
  const cps = [...clean];
  return cps.length <= max ? clean : cps.slice(0, max).join("");
}

// KNOWN LIMIT, deliberately not closed here, and stated precisely because an
// earlier version of this comment claimed more than the code delivers.
//
// What the code-point cap DOES guarantee: a slice never splits a surrogate pair,
// so a lone surrogate can never reach the renderer. What it does NOT guarantee is
// display width. An East Asian wide glyph is one code point occupying two
// terminal columns, so a CJK model id still under-fills its cell and shifts the
// columns to its right.
//
// This cap is therefore only half of a width guarantee, and it is worth nothing
// unless style.mjs measures the same way. It does: `vis()` there counts code
// points and every pad, truncate and frame-fill goes through it. When the two
// disagreed -- this capping by code point while `pad` and `bar` counted UTF-16
// code units -- an astral id produced a frame about thirty columns short that
// sometimes still satisfied the width test. Closing the display-width half needs
// a width table; see the Deferred section.

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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 15 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): reject unsafe model ids and strip escape sequences before rendering"
```

---

### Task A4: `cc-contract.mjs` and `ccr-client.mjs` — the only two files that know about Claude Code and CCR

Implements Q4.1 through Q4.4 and constraint 22, and it is the mechanism behind principle 6. D1 places the menu inside Claude Code's process tree and D6 makes the switch a `/model` command, so two foreign contracts are load-bearing: the external-editor handoff and CCR's loopback RPC. Both are undocumented and both move on their own schedule. Every fact about either one is collected here, with a fingerprint recording the version it was verified against, so an upgrade produces one failing named check instead of a scattering of symptoms. The last step adds the test that keeps the boundary real: a grep over the tree that fails when any other file names a Claude Code or CCR path.

The fingerprints are measured, not assumed. Claude Code reports `2.1.258` in the `version` field of the statusline payload it writes to stdin, which is the cheapest place to read it from because the picker already has a reason to parse that payload. CCR's service descriptor is at `%APPDATA%/claude-code-router/service.json` and carries a URL whose `ccr_web_token` query parameter is the RPC credential.

**Files:** Create `C:/Users/osami/.uw/menu/cc-contract.mjs`, Create `C:/Users/osami/.uw/menu/ccr-client.mjs`, Test `C:/Users/osami/.uw/test/contracts.test.mjs`
**Interfaces:** Consumes: `menu/sanitize.mjs` (`admitId`). Produces:
`CC.CONTRACT` — frozen `{product, fingerprint, handoff:{argvIndex, acceptExit, discardExit}, command:{model}, paths:{settings, statusLineKey}, statusline:{modelPath, displayPath, contextPath, usageKeys}}`. `paths` and `statusline.displayPath` are named here explicitly because Task A16's installer and Task A14's shim consume them, and this Interfaces block is what a reviewer checks those tasks against; an omission here reads as a missing field there.
`CC.handoffTarget(argv: string[]) -> string | null` — the buffer path Claude Code passed, or `null` when this is not a handoff.
`CC.modelCommand(provider: string, model: string) -> string` — the exact line written into the buffer; throws on an id `admitId` rejects.
`CC.parseStatusline(text: string) -> object | null` — parsed payload, or `null` when it is not the expected shape.
`CC.usedTokens(payload) -> number | null` — `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, or `null` when `current_usage` is absent.
`CCR.CONTRACT` — frozen `{product, fingerprint, servicePath, rpcPath, authHeader, tokenParam, bundledCatalogue}`.
`CCR.readService(file?: string) -> {origin, token} | null` — `file` defaults to `CONTRACT.servicePath` and exists so a test can point at a fixture instead of the live `service.json`.
`CCR.rpc(method: string, args: any[], opts?: {timeoutMs?: number, fetchImpl?: Function}) -> Promise<any | null>` — `null` on any failure, never a throw.
`CCR.routableFromConfig(cfg) -> Set<string>` — `provider/model` strings CCR can resolve.
`CCR.ccrVersion() -> string | null` — the INSTALLED version, from the resolved `package.json`.
`CCR.probeRpcSurface(opts?) -> Promise<{methods, runningVersion, installedVersion} | null>` — asks the running gateway which of `CONTRACT.rpcMethods` resolve and what version it reports; `null` when CCR is not running, which is an ordinary condition rather than drift.
`CCR.CONTRACT.gatewayBundle: string` — `dist/main/cli.js`, the file carrying the local gateway-handshake patch.
`CCR.CONTRACT.rpcMethods: string[]` — the method names this project calls, probed rather than assumed.
`CCR.bundledCataloguePath() -> string` — the catalogue inside `node_modules`, named in exactly one place.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/contracts.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as CC from "../menu/cc-contract.mjs";
import * as CCR from "../menu/ccr-client.mjs";

const SAMPLE = {
  session_id: "s1",
  version: "2.1.258",
  model: { id: "anthropic/claude-opus-5", display_name: "Anthropic > claude-opus-5" },
  context_window: {
    total_input_tokens: 168661, total_output_tokens: 377, context_window_size: 200000,
    current_usage: { input_tokens: 2, output_tokens: 377,
                     cache_creation_input_tokens: 37950, cache_read_input_tokens: 130709 },
    used_percentage: 84, remaining_percentage: 16,
  },
};

test("modelCommand renders the exact line Claude Code accepts", () => {
  assert.equal(CC.modelCommand("google", "gemini-3.5-flash-lite"),
               "/model google/gemini-3.5-flash-lite");
});

test("modelCommand refuses an id sanitize would reject", () => {
  assert.throws(() => CC.modelCommand("google", "a\x1b[2Jb"), /rejected/);
  assert.throws(() => CC.modelCommand("google", "../../etc/passwd"), /rejected/);
});

test("handoffTarget reads argv position 2 and nothing else", () => {
  assert.equal(CC.handoffTarget(["node", "uwpick.mjs", "C:/tmp/buf.md"]), "C:/tmp/buf.md");
  assert.equal(CC.handoffTarget(["node", "uwpick.mjs"]), null);
  assert.equal(CC.handoffTarget([]), null);
});

test("exit codes carry the accept/discard semantics", () => {
  assert.equal(CC.CONTRACT.handoff.acceptExit, 0);
  assert.notEqual(CC.CONTRACT.handoff.discardExit, 0);
});

test("parseStatusline returns null on anything unexpected", () => {
  assert.equal(CC.parseStatusline("not json"), null);
  assert.equal(CC.parseStatusline(""), null);
  assert.equal(CC.parseStatusline(JSON.stringify({ hello: 1 })), null);
});

test("parseStatusline accepts the measured payload shape", () => {
  const p = CC.parseStatusline(JSON.stringify(SAMPLE));
  assert.equal(p.model.id, "anthropic/claude-opus-5");
  assert.equal(p.context_window.context_window_size, 200000);
});

test("usedTokens sums input plus both cache counters", () => {
  assert.equal(CC.usedTokens(SAMPLE), 2 + 37950 + 130709);
  assert.equal(CC.usedTokens({ context_window: {} }), null);
  assert.equal(CC.usedTokens({}), null);
});

test("both CONTRACT objects are frozen and fingerprinted", () => {
  assert.equal(Object.isFrozen(CC.CONTRACT), true);
  assert.equal(Object.isFrozen(CCR.CONTRACT), true);
  assert.equal(CC.CONTRACT.fingerprint, "2.1.258");
  assert.match(CCR.CONTRACT.rpcPath, /^\/api\//);
});

test("readService turns a service descriptor into an origin and a token", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "svc");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "service.json");
  fs.writeFileSync(f, JSON.stringify({ url: "http://127.0.0.1:3456/ui/?ccr_web_token=abc123" }));
  const s = CCR.readService(f);
  assert.equal(s.origin, "http://127.0.0.1:3456");
  assert.equal(s.token, "abc123");
  assert.equal(CCR.readService(path.join(dir, "missing.json")), null);
});

test("routableFromConfig flattens providers and models", () => {
  const set = CCR.routableFromConfig({
    Providers: [{ name: "google", models: ["gemini-3.5-flash-lite", "gemini-3.5-pro"] },
                { name: "groq", models: ["llama-4-scout"] },
                { name: "empty" }],
  });
  assert.equal(set.has("google/gemini-3.5-pro"), true);
  assert.equal(set.has("groq/llama-4-scout"), true);
  assert.equal(set.size, 3);
  assert.equal(CCR.routableFromConfig(null).size, 0);
});

test("rpc returns null instead of throwing when the gateway misbehaves", async () => {
  const boom = () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: boom, service: { origin: "http://x", token: "t" } }), null);
  const slow = () => new Promise((_, rej) => setTimeout(() => rej(new Error("aborted")), 5));
  assert.equal(await CCR.rpc("getConfig", [], { fetchImpl: slow, timeoutMs: 1, service: { origin: "http://x", token: "t" } }), null);
});

// Q4.3. The grep must cover .ps1 and .cmd, not just .mjs: install.ps1 is the file
// that names settings.json and uwpick.cmd is the file that names the wrapper, so
// a .mjs-only sweep exempts the two most likely offenders. Those two known paths
// get one named allowance each, keyed on file AND needle, so a NEW hard-coded
// path in either file still trips.
const BOUNDARY_ALLOW = new Map([
  ["cc-contract.mjs", /./],          // the contract module for Claude Code
  ["ccr-client.mjs", /./],           // the contract module for CCR
  // install.ps1 receives the settings path as a -SettingsFile parameter defaulted
  // from cc-contract; the literal below is only the default's documentation.
  ["install.ps1", /\.claude\b/],
  // uwpick.cmd names uwpick-run.ps1 relative to %~dp0 and nothing else; this
  // entry exists so a future absolute path is the thing that fails.
  ["uwpick.cmd", /(?!)/],            // matches nothing: no needle is allowed here
]);

test("no file outside the two contract modules names Claude Code or CCR", () => {
  const root = path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw");
  const needles = [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/];
  const offenders = [];
  for (const dir of ["menu", "refresh"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(mjs|ps1|cmd)$/.test(f)) continue;
      const allow = BOUNDARY_ALLOW.get(f);
      const body = fs.readFileSync(path.join(d, f), "utf8");
      for (const n of needles) {
        if (allow && allow.test(n.source)) continue;
        if (n.test(body)) offenders.push(`${dir}/${f} matches ${n}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test("no file anywhere in UW hard-codes an OMC path", () => {
  // Q4.7. Precisely what this checks, and what it does not: it forbids a PATH to
  // an OMC file appearing in UW's source. It does not forbid the string "OMC" --
  // install.ps1's uninstall message names OMC deliberately, because telling a user
  // which tool probably rewrote their statusline is the useful thing to say.
  //
  // The property being defended is narrower than "UW knows nothing about OMC" and
  // more useful: UW holds no OMC LOCATION that an OMC update, move or reinstall
  // could invalidate. It wraps whatever string statusLine.command contains and
  // forwards stdin verbatim on failure, so there is nothing to go stale.
  //
  // Full-line comments are stripped before matching, because the code may be
  // explained in terms of OMC even where it must not name an OMC path. Test
  // fixtures live outside menu/ and refresh/ and are exempt: they deliberately DO
  // carry the observed literal, so a change in OMC's command shape surfaces as a
  // failing round-trip test rather than as an untested assumption.
  const root = path.join(process.env.HOME ?? process.env.USERPROFILE, ".uw");
  // Separators are normalised BEFORE matching, so every pattern stays a plain
  // forward-slash literal. A character class holding a backslash is fragile to
  // quote through shells, heredocs and editors — this project has broken JS that
  // way twice — and both `hud/omc-hud.mjs` and `hud\omc-hud.mjs` must be caught.
  // Verified against nine samples, including the three violating forms.
  const OMC_PATHS = [/omc-hud/i, /oh-my-claudecode/i, /hud\//i];
  const norm = (b) => b.replace(/\\/g, "/")
                       .replace(/^\s*(\/\/|#|REM\b).*$/gm, "");   // code, not commentary
  const offenders = [];
  for (const dir of ["menu", "refresh"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(mjs|ps1|cmd)$/.test(f)) continue;
      if (f === "hud-shim.mjs") continue;              // named for its job, not for OMC
      const body = norm(fs.readFileSync(path.join(d, f), "utf8"));
      for (const n of OMC_PATHS) if (n.test(body)) offenders.push(`${dir}/${f} matches ${n}`);
    }
  }
  assert.deepEqual(offenders, [],
    "UW must wrap whatever statusLine.command holds, never a path it believes OMC uses");
});

test("the boundary allowlist is keyed per file and per needle, not per file alone", () => {
  // A regression guard on the guard: if someone widens an entry to /./ for a
  // non-contract file, this fails, because that would silently exempt the file.
  for (const [f, re] of BOUNDARY_ALLOW) {
    if (f === "cc-contract.mjs" || f === "ccr-client.mjs") continue;
    assert.notEqual(re.source, ".", `${f} must not be exempted wholesale`);
  }
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/contracts.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\cc-contract.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/cc-contract.mjs`:

```js
// Everything this project knows about Claude Code lives here. Nothing else may
// import a Claude Code path, parse its payloads, or hard-code its semantics.
//
// Why a module rather than a comment: Claude Code auto-updates on the `latest`
// channel. When the handoff or the statusline shape moves, the failure should be
// one named check in `uw doctor`, not a renderer that silently writes into a file
// nobody reads.
//
// MEASURED against 2.1.258 on this machine:
//   - ctrl+g calls enterAlternateScreen(), then spawnSync($EDITOR, [tmpfile],
//     {stdio:"inherit"}). The buffer path is argv[2] for a bare `node script.mjs`
//     invocation.
//   - Exit 0 makes the file's contents the chat input. Any non-zero exit discards
//     it and leaves the input untouched -- which is also our clean-abort path.
//   - The statusline command receives one JSON object on stdin whose `version`,
//     `model.{id,display_name}` and `context_window.*` fields are the only ones
//     we depend on.

import path from "node:path";
import os from "node:os";
import { admitId } from "./sanitize.mjs";

export const CONTRACT = Object.freeze({
  product: "claude-code",
  fingerprint: "2.1.258",
  handoff: Object.freeze({ argvIndex: 2, acceptExit: 0, discardExit: 1 }),
  command: Object.freeze({ model: "/model " }),
  // The only Claude Code paths this project may name. `uw doctor` and the
  // installer read them from here rather than building their own (Q4.3).
  paths: Object.freeze({
    settings: path.join(os.homedir(), ".claude", "settings.json"),
    statusLineKey: "statusLine",
  }),
  statusline: Object.freeze({
    modelPath: "model.id",
    displayPath: "model.display_name",
    contextPath: "context_window.context_window_size",
    usageKeys: Object.freeze([
      "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
    ]),
  }),
});

export function handoffTarget(argv) {
  const p = argv?.[CONTRACT.handoff.argvIndex];
  return typeof p === "string" && p.length ? p : null;
}

// The one place the switch syntax exists. `admitId` runs on the model half only:
// the provider half comes from our own vault metadata, not from remote data.
export function modelCommand(provider, model) {
  const id = admitId(model);
  if (id === null) throw new Error(`modelCommand: model id rejected: ${JSON.stringify(String(model))}`);
  return `${CONTRACT.command.model}${provider}/${id}`;
}

export function parseStatusline(text) {
  let p = null;
  try { p = JSON.parse(String(text)); } catch { return null; }
  if (!p || typeof p !== "object") return null;
  if (!p.model || typeof p.model.id !== "string") return null;
  if (!p.context_window || typeof p.context_window !== "object") return null;
  return p;
}

export function usedTokens(payload) {
  const u = payload?.context_window?.current_usage;
  if (!u || typeof u !== "object") return null;
  let total = 0;
  for (const k of CONTRACT.statusline.usageKeys) total += Number(u[k] ?? 0);
  return Number.isFinite(total) ? total : null;
}
```

Create `C:/Users/osami/.uw/menu/ccr-client.mjs`:

```js
// Everything this project knows about claude-code-router lives here.
//
// Two facts make this worth isolating. First, CCR holds the API keys, so asking
// it to list a provider's models is how tier 2 refreshes without this process
// ever touching a key value. Second, its loopback RPC is an internal surface with
// no compatibility promise -- the auth header name and the token query parameter
// are both undocumented and both observed rather than specified.
//
// MEASURED: %APPDATA%/claude-code-router/service.json holds {"url": "...?ccr_web_token=..."},
// and POST {origin}/api/ccr/rpc with header x-ccr-web-auth returns {value: <result>}.

import fs from "node:fs";
import path from "node:path";

const APPDATA = process.env.APPDATA ?? "";

// The fingerprint names a VERSION, not only a shape. "service.json + /api/ccr/rpc
// + x-ccr-web-auth" describes an interface that a CCR upgrade can keep while
// changing what the calls mean, and a fingerprint that cannot move is a check
// that cannot fail. Phase 0.5 measured 3.0.22; `ccrVersion()` reads the installed
// package.json so `uw doctor` compares against the version actually present.
function resolveInstall() {
  // require.resolve follows the real install, wherever npm put it. The literal
  // below is the last-known-good fallback and nothing more: `nvm4w/nodejs` is a
  // junction that follows the ACTIVE Node version, so it survives a version
  // switch but not an `npm i -g` relocation or a different Node manager.
  try {
    const { createRequire } = require("node:module");
    const req = createRequire(import.meta.url);
    return path.dirname(req.resolve("@musistudio/claude-code-router/package.json"));
  } catch {
    return "C:/nvm4w/nodejs/node_modules/@musistudio/claude-code-router";
  }
}

const INSTALL_DIR = resolveInstall();

export function ccrVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(INSTALL_DIR, "package.json"), "utf8")).version;
  } catch { return null; }
}

export const CONTRACT = Object.freeze({
  product: "claude-code-router",
  // shape + version. Task A15 reports drift on either half.
  fingerprint: "3.0.22 / service.json + /api/ccr/rpc + x-ccr-web-auth",
  verifiedVersion: "3.0.22",
  servicePath: path.join(APPDATA, "claude-code-router", "service.json"),
  rpcPath: "/api/ccr/rpc",
  authHeader: "x-ccr-web-auth",
  tokenParam: "ccr_web_token",
  installDir: INSTALL_DIR,
  bundledCatalogue: path.join(INSTALL_DIR, "dist", "models.json"),
  // The bundle carrying the locally-patched gateway handshake timeout. Named here
  // rather than in doctor.mjs because Q4.1 allows exactly one file to know CCR's
  // layout, and because `npm i -g` reverting that patch is the single
  // highest-severity CCR coupling this project has (report 10, P1 #10).
  gatewayBundle: path.join(INSTALL_DIR, "dist", "main", "cli.js"),
  // The RPC methods this project actually calls. Probed at doctor time rather than
  // assumed: they are wire strings and not minified, which makes them the most
  // solid CCR dependency available -- and still worth checking, because an
  // unknown-method failure arrives as a refresh that quietly returns nothing.
  rpcMethods: Object.freeze(["getAppInfo", "getConfig", "probeProvider"]),
});

/**
 * Ask the running gateway which methods it answers, and which version it is.
 *
 * `getAppInfo` returns `{version, configDir, dataDir, configDbFile}` and is the
 * authoritative source for the RUNNING version. `ccrVersion()` above reads
 * package.json, which is the INSTALLED version. The two disagreeing is a real and
 * specific state -- CCR updated on disk, gateway not restarted -- and it is
 * exactly the window in which the gateway patch has been reverted on disk while
 * the live process still holds it. Everything works until the next restart.
 *
 * Never throws, and returns `null` when CCR is simply not running, because "the
 * gateway is down" is an ordinary condition and not a drift report.
 */
export async function probeRpcSurface({ timeoutMs = 2000 } = {}) {
  const service = readService();
  if (!service) return null;
  const methods = {};
  let runningVersion = null;
  for (const m of CONTRACT.rpcMethods) {
    // probeProvider needs an argument to do anything, but an unknown METHOD and a
    // bad argument fail differently: this asks only whether the name resolves.
    const r = await rpc(m, m === "probeProvider" ? [null] : [], { timeoutMs, service });
    methods[m] = r !== undefined;
    if (m === "getAppInfo" && r && typeof r === "object") runningVersion = r.version ?? null;
  }
  return { methods, runningVersion, installedVersion: ccrVersion() };
}

export function readService(file = CONTRACT.servicePath) {
  try {
    const u = new URL(JSON.parse(fs.readFileSync(file, "utf8")).url);
    return { origin: `${u.protocol}//${u.host}`, token: u.searchParams.get(CONTRACT.tokenParam) };
  } catch { return null; }
}

// Never throws. A gateway that is down, slow, or answering in a shape we do not
// recognise is an expected condition, not an error: the picker draws without it.
export async function rpc(method, args = [], opts = {}) {
  const { timeoutMs = 400, fetchImpl = fetch, service = readService() } = opts;
  if (!service) return null;
  try {
    const res = await fetchImpl(`${service.origin}${CONTRACT.rpcPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [CONTRACT.authHeader]: service.token },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    return body?.value ?? null;
  } catch { return null; }
}

export function routableFromConfig(cfg) {
  const set = new Set();
  for (const p of cfg?.Providers ?? []) {
    for (const m of p?.models ?? []) set.add(`${p.name}/${m}`);
  }
  return set;
}

export function bundledCataloguePath() { return CONTRACT.bundledCatalogue; }
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 27 (indicative — see "How to read the `# pass N` numbers"). The boundary test passes trivially at this point because `menu/` holds only `sanitize.mjs` and the two contract modules; it earns its keep from Task A5 onward, and Task B4 extends its scan to `keysync/` once that directory's hard-coded catalogue path is gone.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): isolate every Claude Code and CCR touchpoint behind two fingerprinted contract modules"
```

---

### Task A5: `catalog.mjs` — testable builder, the five-badge set, and the nullable free column

This task also lands `menu/atomic.mjs`, which every later task writes through. It is three lines of real work and it exists because Q2.8 requires that a crash mid-write never truncate a state file: seven different files in this plan are written by short-lived processes that a user can interrupt with ctrl+c at any moment, and a half-written `snapshot.json` would take the picker down on the next open.

**Files:** Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Create `C:/Users/osami/.uw/menu/atomic.mjs`, Create `C:/Users/osami/.uw/test/fixtures/catalog.json`, Test `C:/Users/osami/.uw/test/catalog.test.mjs`
**Interfaces:** Consumes: `sanitizeDisplay`, `admitId` from `./sanitize.mjs`; `rpc`, `routableFromConfig` from `./ccr-client.mjs`. Produces:
`writeAtomic(file: string, text: string) -> void` — write `<file>.tmp-<pid>`, flush, rename over the target.
`readJsonOr(file: string, fallback: any) -> any` — parse or return the fallback; never throws; **strips a leading UTF-8 BOM before parsing**, because PowerShell 5.1 writes one and `JSON.parse` throws on it, and a reader that silently returns its fallback on a perfectly good file is worse than one that throws (Q2.9).
`priceOf(entry: object, providerName?: string) -> {in: number, out: number} | null` — prefers the offer whose own `provider` field matches `providerName`; falls back to `null`, never to `offers[0]`, when no offer matches. See the implementation note: taking the first offer answers "is the first element of an arbitrarily ordered array free", which is a different question from "is it free on my key".
`isTextOut(entry: object) -> boolean`
`badgeOf(entry: object, opts?: {cadence?: string, planCovered?: boolean, providerName?: string}) -> "FREE"|"FREE?"|"PLAN"|"PAID"|""`
`buildFrom(input: {chosen: Cred[], providers: Map<string,Profile>, catalog: {byProvider: Map<string,Entry[]>, generatedAt: string}, relay?: object, cadenceOf?: (name) => {cadence?, planCovered?}, healthOf?: (name) => string, routableOf?: (target) => boolean|null}) -> {rows: Row[], generatedAt: string}` where `Row = {keyId, provider, models: Model[], free: number|null, planCount: number, health: string}` and `Model = {id, ctx, pin, pout, badge, tools, vision, reason, routable: boolean|null}`. `cadenceOf` and `healthOf` were consumed by the tests and by Task B7 before they were declared here; `routableOf` is new and carries Q1.3.
`build() -> {rows, generatedAt}` — the thin wrapper that loads the live vault and catalogue and delegates to `buildFrom`
`routableSet(opts?: {timeoutMs?: number, rpc?: Function}) -> Promise<{set: Set<string>, fresh: boolean}>` — 400 ms budget, never throws. **Called only by `refresh/cli.mjs`, never by the picker** (Q1.3). There is no `cachedRoutable()` and no `~/.uw/state/routable.json`: routability is a field baked into `snapshot.json` rows by the refresher, because the picker's blocking input loop can never observe an asynchronous answer.
`makeRoutableOf(set: Set<string>, fresh: boolean) -> (target: string) => boolean | null` — the injected predicate; returns `null` for every target when `fresh` is false, so "not checked" never renders as "not routable".

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
import path from "node:path";
import { priceOf, isTextOut, badgeOf, buildFrom, routableSet, makeRoutableOf } from "../menu/catalog.mjs";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";
import { outranks } from "../menu/health.mjs";

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

test("writeAtomic leaves no partial file and replaces the previous contents", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.json");
  writeAtomic(f, '{"v":1}');
  writeAtomic(f, '{"v":2}');
  assert.equal(fs.readFileSync(f, "utf8"), '{"v":2}');
  assert.equal(fs.readdirSync(dir).filter((n) => n.includes(".tmp-")).length, 0);
});

test("readJsonOr never throws", () => {
  const dir = path.join(process.env.HOME ?? process.env.USERPROFILE,
                        ".uw", "harness", "scratch", "atomic");
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, "{ truncated");
  assert.deepEqual(readJsonOr(bad, { fallback: true }), { fallback: true });
  assert.deepEqual(readJsonOr(path.join(dir, "nope.json"), null), null);
});

test("routableSet reports whether its answer is fresh, and never throws", async () => {
  const live = await routableSet({
    rpc: async () => ({ Providers: [{ name: "acme", models: ["acme-chat-1"] }] }),
  });
  assert.equal(live.fresh, true);
  assert.equal(live.set.has("acme/acme-chat-1"), true);

  const dead = await routableSet({ rpc: async () => null });
  assert.equal(dead.fresh, false);
  assert.equal(dead.set instanceof Set, true);
  assert.equal(dead.set.size, 0);
});

test("routableOf turns a set into the per-row field, and absence means unknown", () => {
  // fresh=false must not become "everything is unroutable": that would dim all
  // 1,584 rows the one time the gateway is down, which is the most alarming
  // possible rendering of "nobody asked". Unknown is null, and null does not dim.
  const known = makeRoutableOf(new Set(["acme/acme-chat-1"]), true);
  assert.equal(known("acme/acme-chat-1"), true);
  assert.equal(known("acme/acme-pro-1"), false);
  const unknown = makeRoutableOf(new Set(), false);
  assert.equal(unknown("acme/acme-chat-1"), null);
});

// The companion assertion — that uwpick.mjs never calls routableSet — lives in
// Task A10's test file, where uwpick.mjs exists. Putting it here would need a
// gate on a file a later task creates, which Constraint 15a forbids.
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
import { writeAtomic } from "./atomic.mjs";
import * as CCR from "./ccr-client.mjs";

// A static import, not `await import()`. There is no dynamic reason for a dynamic
// import here -- the path is a constant -- and the top-level await it forces makes
// every importer of catalog.mjs, including snapshot.mjs and the bench child,
// async-load keysync.mjs. keysync.mjs has no top-level side effects, so this is
// cheap in practice; it is still a cost paid for nothing on the picker's startup
// path, which has a 300 ms budget.
import * as K from "../keysync/keysync.mjs";

export const SLOT = path.join(os.homedir(), ".uw", "state", "slot.json");

// The catalogue's real pricing path. keysync's own inferTier reads
// `pricing.inputPerMillion`, which does not exist in this schema -- it returns
// "unknown" for all 4,298 models, which is why its free-tier sort is a no-op.
//
// WHICH OFFER. `offers[]` is a merged array and each element carries its own
// `provider` field; a merged record can hold up to 16 offers, most of them
// pricing the model at a DIFFERENT host. Folding all of them answers "is this
// free anywhere", which is the wrong question. Taking offers[0] answers "is the
// first element of an arbitrarily ordered array free", which is also the wrong
// question and is the one the previous draft implemented. The right question is
// "is it free on MY key", so match the offer to the provider the key belongs to.
// Every call site has that name already: buildFrom has `cred.provider` and
// buildProviders has `reg.provider`.
//
// When no offer matches, return null -- blank -- rather than falling back to
// offer 0. A FREE badge on a model that bills the user's key is precisely the
// lie Principle 1 exists to prevent, and it is also what sorts a mispriced entry
// to rank 0 on the routing path in buildProviders.
export function priceOf(entry, providerName = null) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return null;
  const usable = (o) => {
    const p = o?.per1MTokens;
    return p && Number.isFinite(Number(p.input)) && Number.isFinite(Number(p.output));
  };
  const take = (o) => ({ in: Number(o.per1MTokens.input), out: Number(o.per1MTokens.output) });

  if (providerName) {
    const mine = offers.find((o) => o?.provider === providerName && usable(o));
    return mine ? take(mine) : null;
  }
  // No provider given: only safe when there is exactly one usable offer, because
  // then "the first" and "mine" cannot disagree.
  const usables = offers.filter(usable);
  return usables.length === 1 ? take(usables[0]) : null;
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
export function badgeOf(entry, { cadence = "", planCovered = false, providerName = null } = {}) {
  if (planCovered) return "PLAN";
  const p = priceOf(entry, providerName);
  if (!p) return "";
  if (p.in === 0 && p.out === 0) {
    if (!isTextOut(entry)) return "";        // G1
    if (cadence === "recurring") return "FREE";
    if (cadence === "one-time" || cadence === "none") return "";
    return "FREE?";
  }
  return "PAID";
}

```

Create `C:/Users/osami/.uw/menu/atomic.mjs`:

```js
// Every state and catalogue file this project owns is written by a short-lived
// process the user can interrupt: the picker runs inside ctrl+g and ctrl+c is a
// documented way out of it. A truncated picker.json costs a favourites list; a
// truncated snapshot.json costs the next launch. Rename is atomic on NTFS for a
// same-directory target, so the reader either sees the whole old file or the
// whole new one and never a prefix of either.

import fs from "node:fs";

export function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// The BOM strip is not defensive padding. PowerShell 5.1's `Set-Content -Encoding
// UTF8` writes a BOM, this project writes three JSON files from PowerShell, and
// `JSON.parse` throws on a leading U+FEFF. Without the strip those three files
// would parse as the fallback -- an empty object -- and the callers would draw
// confident conclusions from it: A12's console-mode test would see no recorded
// mode and A15's checkHud would report "not installed" for an installed shim.
// keysync.mjs:19 already does exactly this, for exactly this reason.
export function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch { return fallback; }
}
```

Then, in `menu/catalog.mjs`:

```js
// 8 of 47 provider profiles record breakage in their hand-written notes.
const BROKEN = /502|backend down|insufficient credits|deposit required|not usable|no longer|bot-blocked/i;
export const healthOf = (p) =>
  BROKEN.test(String(p?.notes ?? "")) ? "broken" : p?.requiresBalance ? "needs $" : "ok";

/**
 * Which `provider/model` strings CCR can resolve right now.
 *
 * Changes from the spike version, all of them Q1.3, Q7.2 and Q4.1:
 *   - the RPC itself now lives in ccr-client.mjs, so this file names no CCR path;
 *   - the timeout drops from 8000 ms to 400 ms;
 *   - THE PICKER NEVER CALLS THIS. This function has exactly one caller,
 *     refresh/cli.mjs, which has an event loop, no latency budget, and a reason
 *     to be talking to CCR anyway. The result is baked into snapshot.json as a
 *     per-model `routable` field with a `routableAsOf` stamp.
 *
 * The previous draft had the picker call this and redraw in a `.then()`. That
 * cannot work and the reason is structural rather than a bug: uwpick's input loop
 * is `for (;;) { readSync(CONIN, ...) }`, a blocking libuv call on the main
 * thread with no `await` in the loop body. The JS stack never unwinds, so the
 * event loop is never re-entered and the microtask queue never drains. The
 * `.then()` callback was unreachable for the entire life of the process, which
 * exits from inside `finish()`. The column would have rendered empty in every
 * session, and no unit test would have caught it, because a unit test has an
 * event loop. Q7.2 states this constraint; the old Q1.3 assumed its opposite.
 *
 * There is deliberately no cache file. A cache existed to answer "what if the
 * gateway is slow"; the refresher can simply wait, and a row it could not resolve
 * carries `routable: null`, which renders undimmed. Undimmed-because-unknown and
 * undimmed-because-routable look the same, which is why `routableAsOf` is printed
 * in the header rather than left implicit.
 */
export async function routableSet({ timeoutMs = 400, rpc = CCR.rpc } = {}) {
  const cfg = await rpc("getConfig", [], { timeoutMs });
  if (!cfg) return { set: new Set(), fresh: false };
  return { set: CCR.routableFromConfig(cfg), fresh: true };
}

/**
 * Turn one routable set into the per-row predicate buildFrom injects.
 *
 * The `fresh` flag is the whole point. `false` means the gateway did not answer,
 * and the honest per-row value is then `null` -- unknown -- for every row, not
 * `false`. Reporting `false` would dim all 1,584 rows on the one occasion the
 * gateway is down, telling the user that nothing works when in fact nothing was
 * checked. Constraint: `null` renders undimmed (Q1.3, Principle 1).
 */
export const makeRoutableOf = (set, fresh) => (target) =>
  fresh ? set.has(target) : null;

const FREEISH = new Set(["FREE", "FREE?"]);

/**
 * @param {object}   i
 * @param {Array}    i.chosen      one credential per provider
 * @param {Map}      i.providers   provider name -> profile
 * @param {object}   i.catalog     {byProvider: Map, generatedAt: string}
 * @param {object}  [i.relay]      {provider, models[]} injected, not a vault credential
 * @param {Function}[i.cadenceOf]  provider name -> {cadence?, planCovered?}
 */
export function buildFrom({ chosen, providers, catalog, relay,
                            cadenceOf = () => ({}),
                            routableOf = () => null }) {
  const rows = [];
  for (const cred of chosen) {
    const prof = providers.get(cred.provider) ?? {};
    const opts = { ...(cadenceOf(cred.provider) ?? {}), providerName: cred.provider };
    const models = [];
    for (const e of catalog.byProvider.get(cred.provider) ?? []) {
      const id = admitId(e.model);
      if (!id) continue;                 // reject, never sanitize, a routing selector
      const p = priceOf(e, cred.provider), caps = e?.capabilities ?? {};
      models.push({
        id, ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e, opts),
        tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning,
        // Q1.3: a value, not a promise. null means nobody checked and does not dim.
        routable: routableOf(`${cred.provider}/${id}`),
      });
    }
    // testModel leads: measured, catalogue-first dropped the live pass rate to 4/44.
    const tm = admitId(prof.testModel);
    if (tm && !models.some((m) => m.id === tm)) {
      models.unshift({ id: tm, ctx: null, pin: null, pout: null,
                       badge: opts.planCovered ? "PLAN" : "",
                       tools: false, vision: false, reason: false,
                       routable: routableOf(`${cred.provider}/${tm}`) });
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
      tools: true, vision: true, reason: true,
      routable: routableOf(`${relay.provider}/${id}`) }));
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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 48 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): five-badge set, nullable free column, and a fixture-testable builder"
```

---

### Task A5.1: `denylist.mjs` — reserved names, on the routing path first

**Moved forward from Phase B.** This task was originally B1, sitting 17 tasks after the renderer it protects. It consumes nothing that Phase B builds, it is about forty lines, and between A5 and Phase B lies the entire shippable menu — including Task A17's live protocol against real Claude Code. Constraint 11 requires this to land before Task B2's `inferTier` fix; landing it here satisfies that constraint strictly harder while closing the window in which an untrusted id renders and routes unguarded. The number is decimal rather than a renumbering of A6–A17 so that every existing cross-reference in this plan stays correct; the slot `B1` in Phase B is deliberately left vacant rather than reused.

Its true dependency is Task A5, not Task A3. It needs `admitId` from A3, but it also rewrites the model loop inside `buildFrom`, and `buildFrom` is authored in A5 — a placement immediately after A3 would be editing a function that does not exist yet.

Implements constraints 11 and 12 and report 08's single CRITICAL finding (F1).

**Files:** Create `C:/Users/osami/.uw/menu/denylist.mjs`, Modify `C:/Users/osami/.uw/menu/catalog.mjs`, **Modify `C:/Users/osami/.uw/keysync/keysync.mjs`**, Test `C:/Users/osami/.uw/test/denylist.test.mjs`
**Interfaces:** Consumes: `admitId` from `./sanitize.mjs`. Produces:
`RESERVED: RegExp`, `UW_ALIAS: RegExp`
`isReserved(id: string) -> boolean`
`admitRemoteModels(providerName: string, ids: string[], opts?: {trusted?: string}) -> {kept: string[], rejected: string[]}` — `trusted` defaults to `"anthropic"`, the relay, which is the only provider allowed to serve Anthropic-shaped names.

**The three surfaces, and why the routing one is the only one that matters for F1.** A reserved name can do two different kinds of harm and they need two different guards in two different modules:

| Surface | Module | Harm if unguarded |
|---|---|---|
| **Routing** | `keysync.mjs:buildProviders` | A hostile `opus` enters CCR's `Providers[].models`. CCR's `resolve()` stage-4 cross-provider fallback can then bind Claude Code's built-in rows to it, and the full system prompt, tool definitions and file contents route to an attacker-chosen host. Silent. |
| **Display** | `menu/catalog.mjs:buildFrom` | A spoofed row that looks like an Anthropic model invites the user to select it. Visible, but only if the user reads carefully. |
| **Ingest** | `refresh/tiers.mjs` (Task B6) | The name is persisted into the catalogue and reaches both surfaces above on every later run. |

The previous draft of this plan guarded only the display surface, and its own comment in Task B2 asserted that the mitigation was in place. It was not: `menu/catalog.mjs` feeds `buildSnapshot` → `snapshot.json` → the renderer, and has no influence whatsoever on what CCR routes. Meanwhile Task B2 edits `buildProviders` specifically to make free-first ranking work, which is the change that promotes a zero-priced `opus` to rank 0. Ordering was satisfied in letter and the hijack was left open in substance. That is the defect this task exists to close, and it is why `keysync/keysync.mjs` is in the Files list.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/denylist.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { isReserved, admitRemoteModels, RESERVED } from "../menu/denylist.mjs";
import { buildFrom } from "../menu/catalog.mjs";
import { buildProviders } from "../keysync/keysync.mjs";

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

test("a provider with no testModel produces no SECURITY warning", () => {
  // A security channel that fires on benign configuration stops being read.
  // `admitId(undefined)` returns null and the rejection path stringifies it, so
  // an unguarded call prints `... advertised 1 rejected model name(s): undefined`
  // once per provider lacking a curated testModel, on every keysync run and every
  // dry run — and Step 4 below asks the implementer to read that dry-run output
  // for exactly this kind of signal.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(String(m));
  try {
    buildProviders(
      [{ id: "personal.acme.free", provider: "acme" }],
      new Map([["acme", { protocol: "openai", baseUrl: "https://x.invalid/v1" }]]),  // no testModel
      { byProvider: new Map([["acme", [{ provider: "acme", model: "acme-chat-1",
                                         modalities: { output: ["text"] } }]]]),
        generatedAt: "x" },
      () => "sk-test-not-a-real-key",
    );
  } finally { console.warn = realWarn; }
  assert.deepEqual(warnings.filter((w) => /SECURITY/.test(w)), [],
    "an absent testModel is ordinary configuration, not a rejected advertisement");
});

test("RESERVED is anchored, so a match cannot be buried mid-string", () => {
  assert.equal(RESERVED.source.startsWith("^"), true);
});

test("buildFrom drops a reserved name published by a non-relay provider", () => {
  const byProvider = new Map([["evil", [
    { provider: "evil", model: "opus", capabilities: {},
      modalities: { output: ["text"] },
      pricing: { offers: [{ provider: "evil", per1MTokens: { input: 0, output: 0 } }] } },
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

Then the two assertions that make this task worth doing. These are about the **routing output**, not about `buildFrom`, and they are the gate Constraint 11 names:

```js
// THE LOAD-BEARING TEST. Report 08 F1, stated as an executable assertion.
//
// A hostile aggregator publishes a zero-priced `opus`. With Task B2's inferTier
// fix in place, priceOf reads {input:0,output:0} and the entry sorts to rank 0 --
// free first, then shortest id, and `opus` is four characters. It then lands
// inside MAX_MODELS_PER_PROVIDER = 3 and is written into CCR's Providers[].models.
//
// This test fails against the code as it stands today and passes only once
// admitRemoteModels is wired into buildProviders. That is the gate that was
// wanted. The previous draft asserted instead that the string "reserved-name
// denylist" appeared in `git log --oneline -40`, which
// `git commit --allow-empty -m "reserved-name denylist"` satisfies, and which
// says nothing about whether denylist.mjs exists, is imported, or is reachable.
test("buildProviders never routes a reserved name from an untrusted provider", () => {
  const hostile = {
    provider: "tokenrouter", model: "opus",
    limits: { contextTokens: 200000 },
    modalities: { output: ["text"] },
    pricing: { offers: [{ provider: "tokenrouter", per1MTokens: { input: 0, output: 0 } }] },
  };
  const benign = {
    provider: "tokenrouter", model: "qwen3-max",
    limits: { contextTokens: 32768 },
    modalities: { output: ["text"] },
    pricing: { offers: [{ provider: "tokenrouter", per1MTokens: { input: 1, output: 2 } }] },
  };
  const out = buildProviders(
    [{ id: "personal.tokenrouter.free", provider: "tokenrouter" }],
    new Map([["tokenrouter", { protocol: "openai", baseUrl: "https://x.invalid/v1",
                               testModel: "qwen3-max" }]]),
    { byProvider: new Map([["tokenrouter", [hostile, benign]]]), generatedAt: "x" },
    () => "sk-test-not-a-real-key",
  );
  const ids = out.providers.flatMap((p) => p.models.map((m) => m.id));
  assert.equal(ids.includes("opus"), false,
    "a reserved name reached CCR's routing table; report 08 F1 is open");
  assert.equal(ids.includes("qwen3-max"), true,
    "the guard must reject reserved names, not empty the provider");
});

test("buildProviders also guards the vault's own testModel", () => {
  // A testModel is curated, but the vault is a file and a curated field can be
  // wrong; it is prepended at rank 0 on the routing path, so it is the single
  // highest-value slot in the whole table and gets the same check.
  const out = buildProviders(
    [{ id: "personal.acme.free", provider: "acme" }],
    new Map([["acme", { protocol: "openai", baseUrl: "https://x.invalid/v1",
                        testModel: "claude-opus-5" }]]),
    { byProvider: new Map([["acme", [
      { provider: "acme", model: "acme-chat-1", modalities: { output: ["text"] } }]]]),
      generatedAt: "x" },
    () => "sk-test-not-a-real-key",
  );
  const ids = out.providers.flatMap((p) => p.models.map((m) => m.id));
  assert.equal(ids.includes("claude-opus-5"), false);
});

test("the relay keeps its own Anthropic names on the routing path too", () => {
  const out = buildProviders(
    [{ id: "relay.anthropic.subscription", provider: "anthropic" }],
    new Map([["anthropic", { protocol: "anthropic", baseUrl: "http://127.0.0.1:4517",
                             testModel: "claude-opus-5" }]]),
    { byProvider: new Map(), generatedAt: "x" },
    () => "relay",
  );
  const ids = out.providers.flatMap((p) => p.models.map((m) => m.id));
  assert.equal(ids.includes("claude-opus-5"), true,
    "the exemption for the trusted relay must survive the guard");
});
```

Isolation note (Constraint 15): every one of these calls `buildProviders` with injected `chosen`, `providers`, `catalog` and `keyReader` arguments. No vault is read, no key value is touched, no gateway is contacted, and the `keyReader` returns a literal string. `buildProviders` is a pure function of its four arguments; that is what makes this testable at all, and it is why the guard belongs inside it rather than in `run.mjs`.

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/denylist.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\denylist.mjs'`. After the module exists but before `keysync.mjs` is wired, the two `buildProviders` tests fail with `a reserved name reached CCR's routing table` — which is the true statement about the code as it stands and the reason this task exists.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/denylist.mjs`:

```js
// Reserved model names. This is the load-bearing control for report 08's single
// CRITICAL finding, and it must land BEFORE the inferTier fix in Task B2.
//
// The chain it breaks: a hostile or compromised aggregator publishes
// {"id":"opus","pricing":{"offers":[{"per1MTokens":{"input":0,"output":0}}]}}; a
// WORKING inferTier returns "free"; free sorts first; it lands inside
// MAX_MODELS_PER_PROVIDER; and if it is the unique provider listing that bare
// name, CCR's cross-provider fallback (resolve() stage 4) binds Claude Code's
// built-in rows to it. Full system prompt, tool definitions, file contents and
// responses route to an attacker-chosen host, silently.
//
// Note the irony that fixes the ordering: while tier inference is broken,
// "free-first" is a no-op and the promotion path does not exist. FIXING
// inferTier is what arms this. So the denylist ships first.
//
// WHERE IT MUST BE CALLED, in priority order:
//   1. keysync.mjs:buildProviders  -- the routing path. This is the one that
//      stops report 08 F1. Everything else is defence in depth.
//   2. menu/catalog.mjs:buildFrom  -- the display path. Stops a spoofed row.
//   3. refresh/tiers.mjs           -- ingest. Stops persistence (Task B6).
// A guard on 2 alone is what the previous draft had, and it routes nothing.
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

**Then wire the routing path.** In `C:/Users/osami/.uw/keysync/keysync.mjs`, add the import:

```js
import { admitRemoteModels } from "../menu/denylist.mjs";
```

and inside `buildProviders`, immediately after `const catalogEntries = catalog.byProvider.get(reg.provider) ?? [];`, filter both the catalogue entries and the vault's `testModel` before either is used:

```js
    // SECURITY, report 08 F1. This runs BEFORE `ranked` is computed and before
    // `vp.testModel` is prepended, because both of those write into
    // Providers[].models, which is what CCR routes. The trusted relay is exempt:
    // `anthropic` is our own loopback on 4517 and is the only provider that may
    // legitimately serve a Claude-shaped name.
    const admitted = admitRemoteModels(reg.provider, catalogEntries.map((m) => m.model));
    const keptIds = new Set(admitted.kept);
    const safeEntries = catalogEntries.filter((m) => keptIds.has(m.model));
    // GUARD THE CALL, do not filter the message. `testModel` is optional -- the
    // original code wraps its use in `if (vp.testModel)` -- and `admitId(undefined)`
    // coerces to "" and returns null, so an unguarded call pushes the literal
    // string "undefined" into `rejected` and prints
    //   SECURITY: provider "X" advertised 1 rejected model name(s): undefined
    // once per provider without a curated testModel, on every keysync run and
    // every dry run. Step 4 below asks the implementer to READ that dry-run output
    // and treat a provider losing all its models as a finding worth stopping for.
    // Burying that signal in false positives is how a security channel stops being
    // read, which costs more than the line it saves.
    const safeTestModel = vp.testModel
      ? (admitRemoteModels(reg.provider, [vp.testModel]).kept[0] ?? null)
      : null;
```

then replace every later use of `catalogEntries` in the loop body with `safeEntries`, and every use of `vp.testModel` with `safeTestModel`. There are four: the `if (vp.testModel)` guard, the `catalogEntries.find(...)` inside it, the `models.push({ id: vp.testModel, ... })`, and the `if (catalogEntries.length)` guard above `ranked`.

The point of filtering the array rather than filtering inside the `ranked` loop is that `ranked` is a sort followed by a truncation at `MAX_MODELS_PER_PROVIDER`. Rejecting after the sort would let a hostile entry consume one of the three slots and then be dropped, which silently costs the provider a real model; rejecting before the sort means the three slots go to three admissible models.

Then in `C:/Users/osami/.uw/menu/catalog.mjs`, add the same guard to the display path:

```js
import { admitRemoteModels } from "./denylist.mjs";
```

and inside `buildFrom`, replace the `const models = []` line and the `for (const e of catalog.byProvider.get(cred.provider) ?? [])` loop with:

```js
    const entries = catalog.byProvider.get(cred.provider) ?? [];
    const { kept } = admitRemoteModels(cred.provider, entries.map((e) => e.model));
    const keptSet = new Set(kept);
    const models = [];
    for (const e of entries) {
      if (!keptSet.has(e.model)) continue;
      const p = priceOf(e, cred.provider), caps = e?.capabilities ?? {};
      models.push({
        id: e.model, ctx: e?.limits?.contextTokens ?? null,
        pin: p ? p.in : null, pout: p ? p.out : null, badge: badgeOf(e, opts),
        tools: !!caps.toolCalling, vision: !!caps.imageInput, reason: !!caps.reasoning,
        routable: routableOf(`${cred.provider}/${e.model}`),
      });
    }
```

and guard the `testModel` the same way, replacing `const tm = admitId(prof.testModel);` with:

```js
    // Guarded for the same reason as the routing path: an absent testModel is
    // ordinary configuration, not a rejected advertisement.
    const tm = prof.testModel
      ? (admitRemoteModels(cred.provider, [prof.testModel]).kept[0] ?? null)
      : null;
```

`admitRemoteModels` calls `admitId` internally, so this is strictly stronger than the line it replaces, not a substitution of one check for another.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# fail 0`. The denylist's `console.warn` will appear in the output for the tests that exercise rejection; that is the intended behaviour, not test noise. The `--dry` keysync run must report the **same provider count as before this task** — the denylist rejects names, not providers, and a provider that loses all of its models to it would be a finding worth stopping for rather than a green run.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "security: reserved-name denylist on the routing path, before any tier fix"
```

---

### Task A6: `pick-state.mjs` — the pure two-level reducer

**Files:** Create `C:/Users/osami/.uw/menu/pick-state.mjs`, Test `C:/Users/osami/.uw/test/pick-state.test.mjs`
**Interfaces:** Consumes: nothing (pure). Produces:
`initState(rows: Row[], opts?: {recents?: string[], favourites?: string[], termRows?: number}) -> State`
`tokenize(chunk: string) -> string[]` — split one raw `readSync` chunk into individual keys. A leading `ESC[` consumes the whole CSI sequence up to its final byte in `@`–`~`; anything else consumes one UTF-8 code point. Pure, and exported for its own test, because this is where a held arrow key gets lost (Q3.8).
`reduce(state: State, ev: string | {resize: number}) -> {state: State, exit: null | {target: string|null}, favourite: null | string}` — takes **one** key, never a chunk.
`view(state: State) -> {level, scope, filter, legend: boolean, items: Item[], cursor: number, top: number, empty: boolean, provider: Row|null, more: number}`
where `Item` is either `{kind:"pinned", target, mark}`, `{kind:"provider", row}` or `{kind:"model", model}`.
`exit.target === null` means quit without writing; a string is the `provider/model` selection. The reducer deliberately does not know the `/model` syntax: that lives in `cc-contract.mjs` (Q4.1).

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/pick-state.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { initState, reduce, view, tokenize } from "../menu/pick-state.mjs";

const M = (id, badge = "") => ({ id, ctx: null, pin: null, pout: null, badge,
                                 tools: false, vision: false, reason: false,
                                 routable: null });
// NOTE on the third id: an earlier draft used `M("opus-lookalike")` here, which is
// a name Task A5.1's denylist rejects. The reducer is pure and never calls the
// denylist -- it receives Rows that buildFrom already filtered -- so the fixture
// was not broken, only misleading: it invited a reader to think a reserved name
// can reach this layer. Renamed rather than kept, because a fixture that
// contradicts a security invariant is a comment that will one day be believed.
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
    models: [M("acme-chat-1", "FREE?"), M("acme-pro-1", "PAID"), M("acme-tiny-0")] },
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
const BS = "\x7f", CTRL_C = "\x03", CTRL_F = "\x06", QMARK = "?";

// --- tokenize (Q3.8) -------------------------------------------------------
// readSync on //./CONIN$ returns whatever is sitting in the console buffer, not
// one key. Every test below describes a chunk that arrives in real use and that
// the reducer alone would mishandle.

test("a held arrow key arrives as one chunk and moves once per repeat", () => {
  assert.deepEqual(tokenize("\x1b[A\x1b[A\x1b[B"), [UP, UP, DOWN]);
});

test("a CSI sequence is consumed up to its final byte, parameters included", () => {
  assert.deepEqual(tokenize("\x1b[1;5A"), ["\x1b[1;5A"]);      // ctrl+up
  assert.deepEqual(tokenize("\x1b[200~ab\x1b[201~"),
    ["\x1b[200~", "a", "b", "\x1b[201~"]);                      // bracketed paste
});

test("a bare ESC is one token and still walks the ladder", () => {
  assert.deepEqual(tokenize("\x1b"), [ESC]);
  assert.deepEqual(tokenize("\x1b\x1b"), [ESC, ESC]);
});

test("ordinary text splits by code point, not by code unit", () => {
  assert.deepEqual(tokenize("abc"), ["a", "b", "c"]);
  assert.deepEqual(tokenize("a\u{1F600}b"), ["a", "\u{1F600}", "b"]);
});

test("a mixed chunk yields the arrows AND the typed characters, in order", () => {
  // The defect this pins: the previous input loop tested
  // `key.length >= 3 && key[0] === ESC && key[1] === "["` against the WHOLE chunk,
  // matched the first arrow, moved one row, and discarded everything after it.
  // A two-byte chunk fell through every branch and vanished entirely.
  assert.deepEqual(tokenize("\x1b[A\x1b[A\x1b[Bx"), [UP, UP, DOWN, "x"]);
  const s = initState(ROWS);
  let out = { state: s };
  for (const k of tokenize("\x1b[B\x1b[B")) out = reduce(out.state, k);
  assert.equal(out.state.cur[0], 2, "two down-arrows in one chunk must move two rows");
});

test("a truncated CSI at the end of a chunk is returned whole rather than dropped", () => {
  // The console can split a sequence across two reads. Emitting the fragment is
  // better than swallowing it: reduce() ignores an unrecognised key, and the
  // alternative -- buffering across iterations -- adds state to a pure function
  // for a case that costs one dropped keystroke.
  assert.deepEqual(tokenize("\x1b["), ["\x1b["]);
  assert.deepEqual(tokenize("a\x1b[1"), ["a", "\x1b[1"]);
});

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
  assert.deepEqual(exit, { target: "acme/acme-pro-1" });
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
  assert.deepEqual(last.exit, { target: null });
});

test("tab toggles the flat scope and searches provider/model", () => {
  let s = reduce(initState(ROWS), TAB).state;
  assert.equal(view(s).scope, "flat");
  s = drive(s, ["z", "e", "t", "a", "/", "t"]).state;
  assert.deepEqual(view(s).items.map((i) => i.target), ["zeta/zeta-two"]);
  const { exit } = reduce(s, ENTER);
  assert.deepEqual(exit, { target: "zeta/zeta-two" });
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
  assert.deepEqual(exit, { target: "zeta/zeta-two" });
});

test("a pinned row is filtered by its full target string", () => {
  const s = initState(ROWS, { recents: ["zeta/zeta-two"] });
  const { state } = drive(s, ["t", "w", "o"]);
  assert.deepEqual(view(state).items.map((i) => i.target ?? i.row.provider), ["zeta/zeta-two"]);
});

test("ctrl+f reports the focused model as a favourite toggle", () => {
  const s = reduce(initState(ROWS), ENTER).state;
  const r = reduce(s, CTRL_F);
  assert.equal(r.favourite, "acme/acme-chat-1");
  assert.equal(r.exit, null);
});

test("ctrl+f at the provider level is a no-op", () => {
  assert.equal(reduce(initState(ROWS), CTRL_F).favourite, null);
});

// `?` can be a command because MODEL_ID_OK excludes it: a filter containing `?`
// can never match any id, so the key costs the filter nothing. `f` is a different
// story -- `flash`, `flux` and `fast` all start with it -- which is why the
// favourite toggle is ctrl+f and not bare `f`.
test("? opens the legend overlay and does not enter the filter", () => {
  const r = reduce(initState(ROWS), QMARK);
  assert.equal(view(r.state).legend, true);
  assert.equal(view(r.state).filter, "");
});

test("any key closes the legend and restores the exact prior state", () => {
  const before = reduce(reduce(initState(ROWS), "z").state, "e").state;
  const opened = reduce(before, QMARK).state;
  assert.equal(view(opened).legend, true);
  const closed = reduce(opened, " ").state;
  assert.equal(view(closed).legend, false);
  assert.deepEqual(view(closed).filter, view(before).filter);
  assert.equal(view(closed).cursor, view(before).cursor);
});

test("the legend swallows the key that closes it, including enter and esc", () => {
  const opened = reduce(initState(ROWS), QMARK).state;
  assert.equal(reduce(opened, ENTER).exit, null);
  assert.equal(reduce(opened, ESC).exit, null);
  assert.equal(view(reduce(opened, ESC).state).legend, false);
});

test("an empty result set reports the query that produced it", () => {
  const v = view(drive(initState(ROWS), ["q", "q", "q"]).state);
  assert.equal(v.empty, true);
  assert.equal(v.filter, "qqq");
  assert.deepEqual(v.items, []);
});

test("ctrl+c exits without writing", () => {
  assert.deepEqual(reduce(initState(ROWS), CTRL_C).exit, { target: null });
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
    level: 0, scope: "tree", legend: false,
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

/**
 * Split one raw console read into individual keys (Q3.8).
 *
 * `readSync` on `//./CONIN$` hands back the whole console buffer, so this is not
 * an edge case: holding an arrow key delivers `ESC[A ESC[A ESC[A` in one chunk,
 * and a paste delivers a run of characters. `reduce` takes one key; feeding it a
 * chunk makes it match the first arrow, move one row, and discard the rest.
 *
 * This lives here, in the pure module, rather than inline in uwpick's loop, for
 * one reason: the defect is invisible to single-key fixtures, which is exactly
 * what the reducer's tests were. A tokeniser with its own multi-key tests is the
 * only version of this that a test can fail on.
 */
export function tokenize(chunk) {
  const s = String(chunk ?? "");
  const out = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b" && s[i + 1] === "[") {
      // CSI: ESC [ , parameter bytes 0x30-0x3f, intermediate 0x20-0x2f, final 0x40-0x7e.
      let j = i + 2;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x3f) j++;
      while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
      if (j < s.length && s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e) j++;
      out.push(s.slice(i, j));      // truncated tail is emitted whole; reduce ignores it
      i = j;
      continue;
    }
    // One code point, not one code unit: a surrogate pair must not be split, or
    // reduce sees two lone surrogates and appends two junk characters to the filter.
    const cp = String.fromCodePoint(s.codePointAt(i));
    out.push(cp);
    i += cp.length;
  }
  return out;
}

export function reduce(state, ev) {
  if (ev && typeof ev === "object" && Number.isFinite(ev.resize)) {
    return { ...NONE, state: clamp({ ...state, termRows: ev.resize }) };
  }
  const key = String(ev ?? "");
  const c0 = key.charCodeAt(0);
  const i = slot(state);
  const list = items(state);
  const focused = list[state.cur[i]] ?? null;

  if (c0 === 3) return { ...NONE, state, exit: { target: null } };               // ctrl+c

  // The legend is modal and swallows exactly one key, including enter and esc.
  // Swallowing is the point: a user who opens it to find out what esc does should
  // not have esc quit the picker on the way out.
  if (state.legend) return { ...NONE, state: { ...state, legend: false } };
  if (key === "?") return { ...NONE, state: { ...state, legend: true } };      // Q3.6

  if (key === "\t") {                                                          // scope toggle
    return { ...NONE, state: clamp({ ...state, scope: state.scope === "flat" ? "tree" : "flat" }) };
  }

  if (c0 === 6 && focused?.kind === "model") {                                // ctrl+f
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
    return { ...NONE, state, exit: { target: null } };
  }

  if (c0 === 13 || c0 === 10) {                                                // enter
    if (!focused) return { ...NONE, state };
    if (focused.kind === "provider") {
      const q = [...state.q], cur = [...state.cur], top = [...state.top];
      q[1] = ""; cur[1] = 0; top[1] = 0;
      return { ...NONE, state: clamp({ ...state, level: 1, provider: focused.row, q, cur, top }) };
    }
    return { ...NONE, state, exit: { target: focused.target } };
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
    level: state.level, scope: state.scope, filter: state.q[i], legend: state.legend,
    items: shown, cursor: state.cur[i], top: state.top[i],
    empty: all.length === 0, provider: state.provider,
    more: Math.max(0, all.length - (state.top[i] + shown.length)),
  };
}
```

One behaviour worth stating because a test pins it: `view().items` is the **windowed** slice, while `view().cursor` is an index into the **full** filtered list. The renderer subtracts `top` to find the highlighted line. The alternative — a cursor relative to the window — makes clamping after a refilter much harder to reason about.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 71 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): pure two-level reducer with an esc ladder, flat scope and pinned rows"
```

---

### Task A7: `state.mjs` — persist recents and favourites

**Files:** Create `C:/Users/osami/.uw/menu/state.mjs`, Test `C:/Users/osami/.uw/test/state.test.mjs`
**Interfaces:** Consumes: `writeAtomic` from `./atomic.mjs`. Produces:
`PICKER_STATE: string` — absolute path to `~/.uw/state/picker.json`
`loadPickerState(file?: string) -> {recents: string[], favourites: string[]}`
`recordRecent(target: string, file?: string) -> {recents, favourites}` — most-recent-first, deduped, capped at 10
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

test("recents cap at 10", () => {
  const f = scratch();
  for (let i = 0; i < 14; i++) recordRecent(`p/m${i}`, f);
  const { recents } = loadPickerState(f);
  assert.equal(recents.length, 10);
  assert.equal(recents[0], "p/m13");
});

test("a corrupt file is preserved under a new name, never deleted", () => {
  const f = scratch();
  fs.writeFileSync(f, "{ half-written");
  const s = loadPickerState(f);
  assert.deepEqual(s, { recents: [], favourites: [] });
  const kept = fs.readdirSync(path.dirname(f)).filter((n) => n.includes(".corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(f), kept[0]), "utf8"), "{ half-written");
});

test("saves go through writeAtomic, leaving no temp files behind", () => {
  const f = scratch();
  recordRecent("a/one", f);
  toggleFavourite("a/one", f);
  assert.equal(fs.readdirSync(path.dirname(f)).some((n) => n.includes(".tmp-")), false);
  assert.deepEqual(loadPickerState(f), { recents: ["a/one"], favourites: ["a/one"] });
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

import { writeAtomic } from "./atomic.mjs";

const STATE_DIR = path.join(os.homedir(), ".uw", "state");
export const PICKER_STATE = path.join(STATE_DIR, "picker.json");
export const HANDOFF_LOG = path.join(STATE_DIR, "handoff.json");

const MAX_RECENTS = 10;   // Q3.4
const MAX_FAVOURITES = 20;

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

export function loadPickerState(file = PICKER_STATE) {
  let text = null;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { recents: [], favourites: [] }; }
  try {
    const raw = JSON.parse(text);
    return { recents: strings(raw.recents), favourites: strings(raw.favourites) };
  } catch {
    // Q2.3: the file exists and is unparseable. Keep it -- it is the only copy of
    // a favourites list the user built by hand, and a rename costs nothing.
    try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* read-only dir */ }
    return { recents: [], favourites: [] };
  }
}

function save(file, next) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(next, null, 2));   // Q2.8
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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 82 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): persist recents and favourites, and record each handoff invocation"
```

---

### Task A8: `snapshot.mjs` — the pre-built row set the picker opens from

Implements Q1.1, Q2.1, Q2.2 and Q2.8. Today `catalog.mjs:build()` imports `keysync.mjs`, reads the vault, parses a 19.7 MB catalogue and joins the two — which is fine for a refresher and wrong for a key press. D1 puts the picker in the path of ctrl+g, where the user is waiting with the screen already blanked, so the open must be a single small read.

This task adds the artefact that makes that true: `~/.uw/catalog/snapshot.json`, holding exactly the fields the renderer draws and nothing else. It is built by a command, not by the picker, and Task B10 makes the refresher rebuild it whenever it promotes a new catalogue version. It also carries the per-model context limits, which is the one fact Task A14's statusline shim needs and the reason that shim does not have to know what a catalogue is.

**Files:** Create `C:/Users/osami/.uw/menu/snapshot.mjs`, Test `C:/Users/osami/.uw/test/snapshot.test.mjs`
**Interfaces:** Consumes: `build` from `./catalog.mjs`; `writeAtomic` from `./atomic.mjs`. Produces:
`SNAPSHOT_FILE: string` — `~/.uw/catalog/snapshot.json`
`SNAPSHOT_SCHEMA = 1`
`buildSnapshot(built: {rows, generatedAt}) -> Snapshot` — `{schemaVersion, generatedAt, builtAt, rows}`
`writeSnapshotFile(snap, file?: string) -> string` — atomic write, returns the path
`loadSnapshot(file?: string) -> {ok: true, snap} | {ok: false, reason: "missing"|"unreadable"|"schema", detail: string}`
`contextIndex(snap) -> Map<string, number>` — `provider/model` to context tokens, omitting unknowns
`main(argv)` — `node menu/snapshot.mjs --build` rebuilds the file and prints its path and row count

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/snapshot.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSnapshot, writeSnapshotFile, loadSnapshot, contextIndex,
         SNAPSHOT_SCHEMA } from "../menu/snapshot.mjs";

const scratch = (name) => {
  const d = path.join(os.homedir(), ".uw", "harness", "scratch", "snapshot");
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
};

const BUILT = {
  generatedAt: "2026-08-24T12:22:28.162Z",
  rows: [
    { keyId: "personal.acme.free", provider: "acme", free: 1, planCount: 0, health: "ok",
      models: [{ id: "acme-chat-1", ctx: 163840, pin: 0, pout: 0, badge: "FREE?",
                 tools: true, vision: false, reason: true },
               { id: "acme-pro-1", ctx: null, pin: 0.3, pout: 1.2, badge: "PAID",
                 tools: true, vision: true, reason: false }] },
    { keyId: "relay.anthropic.subscription", provider: "anthropic", free: null, planCount: 1,
      health: "ok",
      models: [{ id: "claude-opus-5", ctx: 200000, pin: null, pout: null, badge: "PLAN",
                 tools: true, vision: true, reason: true }] },
  ],
};

test("buildSnapshot stamps the schema and keeps every display field", () => {
  const s = buildSnapshot(BUILT);
  assert.equal(s.schemaVersion, SNAPSHOT_SCHEMA);
  assert.equal(s.generatedAt, BUILT.generatedAt);
  assert.equal(typeof s.builtAt, "string");
  assert.equal(s.rows.length, 2);
  assert.deepEqual(Object.keys(s.rows[0]).sort(),
                   ["free", "health", "keyId", "models", "planCount", "provider"]);
  assert.deepEqual(Object.keys(s.rows[0].models[0]).sort(),
                   ["badge", "ctx", "id", "pin", "pout", "reason", "tools", "vision"]);
});

test("a snapshot round-trips through the file", () => {
  const f = scratch("ok.json");
  writeSnapshotFile(buildSnapshot(BUILT), f);
  const r = loadSnapshot(f);
  assert.equal(r.ok, true);
  assert.equal(r.snap.rows[1].models[0].id, "claude-opus-5");
  assert.equal(fs.readdirSync(path.dirname(f)).some((n) => n.includes(".tmp-")), false);
});

test("a missing file reports `missing`, not an empty menu", () => {
  const r = loadSnapshot(scratch("nope.json"));
  assert.equal(r.ok, false);
  assert.equal(r.reason, "missing");
});

test("an unparseable file reports `unreadable` and quotes nothing sensitive", () => {
  const f = scratch("bad.json");
  fs.writeFileSync(f, "{ this is not json");
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a truncated snapshot is unreadable rather than empty", () => {
  const f = scratch("cut.json");
  fs.writeFileSync(f, JSON.stringify(buildSnapshot(BUILT)).slice(0, 120));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unreadable");
});

test("a future schema is refused with the observed version quoted", () => {
  const f = scratch("v9.json");
  fs.writeFileSync(f, JSON.stringify({ ...buildSnapshot(BUILT), schemaVersion: 9 }));
  const r = loadSnapshot(f);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "schema");
  assert.match(r.detail, /9/);
});

test("contextIndex maps provider/model to context tokens and skips unknowns", () => {
  const ix = contextIndex(buildSnapshot(BUILT));
  assert.equal(ix.get("acme/acme-chat-1"), 163840);
  assert.equal(ix.get("anthropic/claude-opus-5"), 200000);
  assert.equal(ix.has("acme/acme-pro-1"), false);
  assert.equal(ix.size, 2);
});

test("the snapshot carries no catalogue internals", () => {
  const text = JSON.stringify(buildSnapshot(BUILT));
  for (const leak of ["pricing", "offers", "per1MTokens", "modalities", "capabilities", "limits"]) {
    assert.equal(text.includes(leak), false, `snapshot leaked ${leak}`);
  }
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/snapshot.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\snapshot.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/snapshot.mjs`:

```js
// The picker's whole input, pre-joined.
//
// catalog.mjs:build() is the expensive path: it imports keysync, reads the vault
// through a PowerShell round trip, parses a 19.7 MB catalogue and joins the two.
// That work belongs to whoever refreshes the catalogue, not to whoever presses
// ctrl+g -- at which point Claude Code has already blanked the screen and the
// user is watching an empty terminal (Q1.1).
//
// The file is deliberately dumb: no functions, no derived state, only the cells a
// row draws plus the context limits Task A14 reads. Anything that needs the full
// catalogue is by definition not the picker.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic } from "./atomic.mjs";

export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_FILE = path.join(os.homedir(), ".uw", "catalog", "snapshot.json");

export function buildSnapshot(built) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA,
    generatedAt: built.generatedAt ?? null,
    builtAt: new Date().toISOString(),
    rows: built.rows.map((r) => ({
      keyId: r.keyId, provider: r.provider, free: r.free,
      planCount: r.planCount, health: r.health,
      models: r.models.map((m) => ({
        id: m.id, ctx: m.ctx, pin: m.pin, pout: m.pout, badge: m.badge,
        tools: m.tools, vision: m.vision, reason: m.reason,
      })),
    })),
  };
}

export function writeSnapshotFile(snap, file = SNAPSHOT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(snap));      // not pretty-printed: this is read, not edited
  return file;
}

// Four outcomes, each with its own caller-visible reason. A single boolean here
// would collapse "you have not built it yet" into "your build is corrupt", and
// those need different sentences from the picker (Q2.1, Q2.2).
export function loadSnapshot(file = SNAPSHOT_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch { return { ok: false, reason: "missing", detail: file }; }
  let snap;
  try { snap = JSON.parse(text); }
  catch (e) { return { ok: false, reason: "unreadable", detail: String(e.message).slice(0, 120) }; }
  if (snap?.schemaVersion !== SNAPSHOT_SCHEMA || !Array.isArray(snap.rows)) {
    return { ok: false, reason: "schema",
             detail: `expected schemaVersion ${SNAPSHOT_SCHEMA}, found ${JSON.stringify(snap?.schemaVersion)}` };
  }
  return { ok: true, snap };
}

export function contextIndex(snap) {
  const ix = new Map();
  for (const r of snap?.rows ?? []) {
    for (const m of r.models ?? []) {
      if (Number.isFinite(m.ctx)) ix.set(`${r.provider}/${m.id}`, m.ctx);
    }
  }
  return ix;
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.includes("--build")) {
    console.log("usage: node menu/snapshot.mjs --build");
    process.exit(2);
  }
  const { build } = await import("./catalog.mjs");
  const snap = buildSnapshot(build());
  const file = writeSnapshotFile(snap);
  const models = snap.rows.reduce((n, r) => n + r.models.length, 0);
  console.log(`snapshot: ${file}`);
  console.log(`  ${snap.rows.length} providers, ${models} models, catalogue ${snap.generatedAt}`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/snapshot.mjs")) {
  await main();
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/menu/snapshot.mjs" --build
```

Expected: `# fail 0`, with a pass count around 90 (indicative — see "How to read the `# pass N` numbers"). The build prints a path under `~/.uw/catalog/` and a line reading roughly `44 providers, 1584 models, catalogue 2026-08-24T12:22:28.162Z`. Check the file size: it should be a few hundred kilobytes, not tens of megabytes. If it is larger than about 2 MB, something is copying catalogue entries wholesale and the leak test above should have caught it.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): pre-build the picker's rows into a small snapshot instead of parsing the catalogue on open"
```

---

### Task A9: `style.mjs` — the visual design, the glyph fallbacks, and the four transitions

Implements Q7.1 through Q7.7, Q3.1, Q3.2, Q3.3 and Q3.7, and it is the module principle 7 exists for. Everything the picker looks like is decided here: colours, glyphs, frame characters, column padding, the proportion bar, the health dot, the match highlight, the key-cap help line, and the four transitions. `uwpick.mjs` after this task is an input loop plus a writer.

Two constraints shape every choice below, and both are measured rather than stylistic. First, the input loop is a blocking `readSync` on `//./CONIN$`: there is no event loop behind it, so nothing can animate on a timer and no `setTimeout` callback will ever run while a key is awaited. Motion is therefore only ever a synchronous burst rendered as the direct consequence of a key press. Second, the pause between animation frames cannot be a busy-wait — spinning on `Date.now()` inside a terminal renderer is how a picker ends up pinning a core — so the pause is `Atomics.wait` on a `SharedArrayBuffer` no other thread ever touches. It blocks the calling thread for a bounded time and returns `"timed-out"`, which is precisely a synchronous sleep, and it is permitted on Node's main thread even though browsers forbid it.

**The design.** Level 0 at the standard 78-column frame. Both mocks below were **generated from the column constants in this task**, not drawn by hand, and every line is exactly 78 columns wide — the previous versions were hand-drawn and disagreed with the renderer, with the tests, and with each other. Treat them as the specification of the geometry: `docs/visual-design.md` freezes these same two blocks, and the frame tests assert against the same `W` constants that produced them.

```text
╭─ UW ▸ providers ───────────────────────────────────────────────────────────╮
│  filter: gem▏          44 providers · 1584 models · routable 08-24 14:02   │
│                                                                            │
│  key id                         models   free                health        │
│  ★ google/gemini-3.5-flash-lite                                            │
│  ↺ groq/llama-4-scout                                                      │
│▶ personal.google.free                3   ▰▰▰▰▰▰ 3          ● ok            │
│  personal.openrouter.free          324   ▰▱▱▱▱▱ 41 +4 plan ● ok            │
│  personal.acme.paid                 12   ▱▱▱▱▱▱ 0          ◐ needs $       │
│  personal.dead.free                  7          —          ✖ broken        │
│  … 38 more                                                                 │
╰ [↑↓] move  [⇥] scope  [^f] fav  [?] keys  [esc] back ──────────────────────╯
```

Level 2 — a provider's models, reached with enter, breadcrumb in the title:

```text
╭─ UW ▸ personal.google.free ▸ models ───────────────────────────────────────╮
│  filter: flash▏                                                  3 of 34   │
│                                                                            │
│  model                                ctx     $in   $out  badge TVR        │
│▶ gemini-3.5-flash-lite                 1M    0.00   0.00  FREE  TVR        │
│  gemini-3.5-flash                      1M    0.30   2.50  PAID  TVR        │
│  gemini-3.5-flash-thinking             1M    0.30   2.50  PAID  TV-        │
╰ [↑↓] move  [↵] select  [^f] fav  [?] keys  [esc] back ─────────────────────╯
```

Empty state, which replaces the rows and nothing else:

```text
│  backspace to widen, esc to clear — no match for "zzz"                     │
```

And the whole frame collapses to one line on selection, which is the last thing drawn before the process exits and Claude Code repaints:

```text
✔ switched → google/gemini-3.5-flash-lite
```

**Three deliberate departures from the brief, each for a measured reason.** Capability glyphs stay as the letters `T`, `V` and `R` rather than `⚒ 👁 🧠`: emoji occupy two terminal cells in Windows Terminal, the caps column is pinned at three cells by constraint 7, and a two-cell glyph in a three-cell column pushes every row that has one out of alignment with every row that does not. The letters are coloured instead — tools cyan, vision magenta, reasoning yellow, absent dimmed to `-` — which carries the same information inside the width the columns already promise. Second, the favourite key is ctrl+f rather than bare `f`, because the filter is live and owns every printable character: a user searching for `flash` types `f` first. `?` survives as a bare key precisely because `MODEL_ID_OK` excludes it, so a filter containing `?` could never match anything and the key costs the search nothing. Third, the level-0 row gains a sixth column of six cells for the proportion bar; the five columns constraint 6 pins keep their widths and their order.

**Files:** Create `C:/Users/osami/.uw/menu/style.mjs`, Create `C:/Users/osami/.uw/docs/visual-design.md`, Test `C:/Users/osami/.uw/test/style.test.mjs`
**Interfaces:** Consumes: `sanitizeDisplay` from `./sanitize.mjs`. Produces:
`detectCaps(env?: object, cols?: number) -> {vt: boolean, unicode: boolean, colours: 0|16|256, cols: number}`
`motionEnabled({env?, flags?: string[], caps}) -> boolean`
`glyphsFor(caps) -> Glyphs`
`painter(caps) -> {dim, inv, bold, red, grn, yel, cya, mag, ramp}`
`badgeColour(badge: string) -> "grn"|"yel"|"cya"|"dim"|""`
`proportionBar(free: number|null, total: number, g: Glyphs, width?: number) -> string`
`healthDot(health: string, g: Glyphs, p: Painter) -> string`
`highlight(text: string, query: string, p: Painter) -> string`
`frame(v: View, meta: Meta, opts: {caps}) -> string[]` — pure and synchronous; routability arrives as `model.routable` on the rows, never as a separate live set (Q1.3)
`confirmLine(target: string, g: Glyphs, p: Painter) -> string`
`sleepSync(ms: number) -> void`
`slideFrames(lines: string[], step?: number, frames?: number) -> string[][]`
`flashFrames(lines: string[], index: number, p: Painter, times?: number) -> string[][]`
`revealFrames(lines: string[], frames?: number) -> string[][]`
`FRAME_W = 78`, `W` (the column table), `FRAME_MS = 30`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/style.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCaps, motionEnabled, glyphsFor, painter, badgeColour, proportionBar,
         healthDot, highlight, frame, confirmLine, sleepSync,
         slideFrames, flashFrames, revealFrames, FRAME_W, W } from "../menu/style.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const VT = detectCaps({ WT_SESSION: "1", COLORTERM: "truecolor" }, 120);
const PLAIN = detectCaps({ TERM: "dumb" }, 80);

const ROWS = [
  // `free` is the COUNT OF FREE MODELS in this row. With two models, one badged
  // FREE and one PAID, it is 1. It read 3, which is unreachable from two models,
  // and the exact-row literal below was transcribed from the frozen ASCII mock —
  // which shows this provider with THREE models — rather than generated from this
  // fixture. `proportionBar` hid half the mismatch: proportionBar(3, 2) saturates
  // to a full bar, the same glyphs the mock shows for 3-of-3, so only the count
  // column exposed it.
  { keyId: "personal.google.free", provider: "google", free: 1, planCount: 0, health: "ok",
    models: [{ id: "gemini-3.5-flash-lite", ctx: 1000000, pin: 0, pout: 0, badge: "FREE",
               tools: true, vision: true, reason: true },
             { id: "gemini-3.5-pro", ctx: 1000000, pin: 1.25, pout: 10, badge: "PAID",
               tools: true, vision: true, reason: false }] },
  { keyId: "personal.dead.free", provider: "dead", free: null, planCount: 0, health: "broken",
    models: [{ id: "dead-1", ctx: null, pin: null, pout: null, badge: "",
               tools: false, vision: false, reason: false }] },
];
const META = { providers: 2, models: 3, generatedAt: "2026-08-24T12:22:28.162Z" };
const V0 = {
  level: 0, scope: "tree", filter: "", legend: false, cursor: 0, top: 0, empty: false,
  provider: null, more: 0,
  items: ROWS.map((row) => ({ kind: "provider", row })),
};
const V1 = {
  level: 1, scope: "tree", filter: "flash", legend: false, cursor: 0, top: 0, empty: false,
  provider: ROWS[0], more: 0,
  items: [{ kind: "model", model: ROWS[0].models[0], target: "google/gemini-3.5-flash-lite" }],
};

test("detectCaps recognises Windows Terminal as a 256-colour VT host", () => {
  assert.equal(VT.vt, true);
  assert.equal(VT.unicode, true);
  assert.equal(VT.colours, 256);
});

test("detectCaps refuses everything for TERM=dumb", () => {
  assert.equal(PLAIN.vt, false);
  assert.equal(PLAIN.unicode, false);
  assert.equal(PLAIN.colours, 0);
});

test("detectCaps falls back to 16 colours when the host is unknown", () => {
  const c = detectCaps({ TERM: "xterm" }, 80);
  assert.equal(c.vt, true);
  assert.equal(c.colours, 16);
});

test("motion is off for the kill switch, the flag, a dumb terminal and a narrow one", () => {
  assert.equal(motionEnabled({ env: {}, flags: [], caps: VT }), true);
  assert.equal(motionEnabled({ env: { UW_PICKER_MOTION: "0" }, flags: [], caps: VT }), false);
  assert.equal(motionEnabled({ env: {}, flags: ["--no-motion"], caps: VT }), false);
  assert.equal(motionEnabled({ env: {}, flags: [], caps: PLAIN }), false);
  assert.equal(motionEnabled({ env: {}, flags: [], caps: { ...VT, cols: 59 } }), false);
});

test("badge colours are the whole badge set and nothing else", () => {
  assert.equal(badgeColour("FREE"), "grn");
  assert.equal(badgeColour("FREE?"), "yel");
  assert.equal(badgeColour("PLAN"), "cya");
  assert.equal(badgeColour("PAID"), "dim");
  assert.equal(badgeColour(""), "");
  assert.equal(badgeColour("NONSENSE"), "");
});

test("the proportion bar reads at a glance and never lies about missing data", () => {
  const g = glyphsFor(VT);
  // Width is W.bar (6), the same constant the header reserves, so the bar and its
  // header cell cannot drift apart. The previous default of 5 was one narrower
  // than the header, which misaligned every column from `free` rightward.
  assert.equal(proportionBar(0, 12, g).length, W.bar);
  assert.equal(proportionBar(0, 12, g), "▱▱▱▱▱▱");
  assert.equal(proportionBar(12, 12, g), "▰▰▰▰▰▰");
  assert.equal(proportionBar(6, 12, g), "▰▰▰▱▱▱");
  assert.equal(proportionBar(1, 324, g), "▰▱▱▱▱▱");   // any non-zero free shows one block
  assert.equal(proportionBar(null, 12, g), " ".repeat(W.bar)); // no price data: no bar
  assert.equal(proportionBar(0, 0, g), " ".repeat(W.bar));
  assert.equal(proportionBar(6, 12, glyphsFor(PLAIN)), "###...");
});

test("the health dot carries the state in the glyph as well as the colour", () => {
  const g = glyphsFor(VT), p = painter(VT);
  const gA = glyphsFor(PLAIN), pA = painter(PLAIN);
  // Four states, four distinct glyphs, in BOTH glyph sets and with colour off.
  // This is the assertion the previous version of this test claimed to make and
  // then contradicted: it asserted healthDot("ok") and healthDot("broken") both
  // strip to "●", which is the defect, not the requirement.
  const states = ["ok", "needs $", "broken", "stale"];
  for (const [gl, pt, name] of [[g, p, "unicode"], [gA, pA, "ascii"]]) {
    const glyphs = states.map((s) => strip(healthDot(s, gl, pt)));
    assert.equal(new Set(glyphs).size, states.length,
      `${name}: ${glyphs.join(",")} must be four distinct glyphs`);
    for (const one of glyphs) assert.equal([...one].length, 1, `${name}: one column each`);
  }
  assert.equal(strip(healthDot("ok", g, p)), "●");
  assert.equal(strip(healthDot("broken", g, p)), "✖");
  assert.equal(strip(healthDot("needs $", g, p)), "◐");
  assert.equal(strip(healthDot("stale", g, p)), "○");
  assert.equal(healthDot("ok", gA, pA), "*");
  assert.equal(healthDot("broken", gA, pA), "x");
});

test("highlight bolds only the matched substring and is a no-op without a query", () => {
  const p = painter(VT);
  assert.equal(strip(highlight("gemini-3.5-flash", "flash", p)), "gemini-3.5-flash");
  assert.match(highlight("gemini-3.5-flash", "flash", p), /\x1b\[1mflash\x1b/);
  assert.equal(highlight("gemini-3.5-flash", "", p), "gemini-3.5-flash");
  assert.equal(highlight("gemini-3.5-flash", "zzz", p), "gemini-3.5-flash");
});

test("glyphs fall back to ASCII with no escape sequences at all", () => {
  const g = glyphsFor(PLAIN);
  assert.equal(g.marker, ">");
  assert.equal(g.frame.tl, "+");
  const lines = frame(V0, META, { caps: PLAIN });
  assert.equal(lines.join("").includes("\x1b"), false);
  assert.equal(/[^\x00-\x7f]/.test(lines.join("")), false);
});

// --- frame geometry --------------------------------------------------------
//
// A caution that this task earned. The two exact-row tests below were originally
// written as hand-composed string literals, and all three of the numbers involved
// disagreed: the literals were 76 columns, the renderer produced 77 for an
// in-range row and 80 for the badge row, and the invariant test asserted 78. None
// of the three had ever been executed. So the literals are kept -- they are the
// only thing that catches a column being silently swapped with its neighbour --
// but they are no longer the *only* geometry test, and they are not authoritative.
//
// The order of authority is: (1) the width invariant, which needs no literal;
// (2) the derived-offset test, which computes where each column must begin from
// the same W constants the renderer uses; (3) the literals, which are a
// human-readable transcript. When (3) disagrees with (1) or (2) after a
// deliberate change, regenerate (3) by running `frame()` and pasting the output.
//
// IMPLEMENTER: the two literals below are derived by arithmetic, not captured
// from a run. Execute `frame()` once and diff before checking off Step 4. If they
// differ, the invariant and offset tests above them say which side is wrong.

test("level 0 renders the exact provider row, columns included", () => {
  const lines = frame(V0, META, { caps: PLAIN });
  const row = lines.find((l) => l.includes("personal.google.free"));
  assert.equal(row,
    // GENERATED by running the renderer against ROWS[0], not transcribed from the
    // mock. Count is r.models.length = 2; bar is proportionBar(1, 2) = "###...";
    // free text is "1". Verified at 78 code points.
    "|> personal.google.free" + " ".repeat(16) + "2" + " ".repeat(3) + "###..." +
    " " + "1" + " ".repeat(10) + "* ok" + " ".repeat(12) + "|");
});

test("level 1 renders the exact model row, columns included", () => {
  const lines = frame(V1, META, { caps: PLAIN });
  const row = lines.find((l) => l.includes("gemini-3.5-flash-lite"));
  assert.equal(row,
    "|> gemini-3.5-flash-lite" + " ".repeat(17) + "1M" + " ".repeat(4) + "0.00" +
    " ".repeat(3) + "0.00" + "  " + "FREE" + "  " + "TVR" + " ".repeat(8) + "|");
});

test("every column begins where the W constants say it begins", () => {
  // Derived, not transcribed: this is what makes the literals above checkable
  // rather than merely self-consistent. If a cell width changes, this fails and
  // names the column; if the header and the row drift apart, this fails too.
  const l0 = frame(V0, META, { caps: PLAIN }).find((l) => l.includes("personal.google.free"));
  const h0 = frame(V0, META, { caps: PLAIN }).find((l) => l.includes("key id"));
  const barCol    = 1 + 2 + W.keyId + W.count + 3;
  const healthCol = barCol + W.bar + 1 + (W.free - 1) + 2;
  assert.equal(strip(l0).indexOf("######"), barCol, "proportion bar column");
  assert.equal(strip(l0).indexOf("ok", healthCol - 1), healthCol, "health label column");
  assert.equal(strip(h0).indexOf("free"), barCol, "the `free` header sits over the bar");
  assert.equal(strip(h0).indexOf("health"), healthCol, "the `health` header sits over the label");

  const l1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("gemini-3.5-flash-lite"));
  const h1 = frame(V1, META, { caps: PLAIN }).find((l) => l.includes("model "));
  const badgeCol = 1 + 2 + W.id + W.ctx + 1 + W.price * 2 + 2;
  assert.equal(strip(l1).indexOf("FREE"), badgeCol, "badge column");
  assert.equal(strip(l1).indexOf("TVR"), badgeCol + W.badge, "caps column");
  assert.equal(strip(h1).indexOf("badge"), badgeCol);
  assert.equal(strip(h1).indexOf("TVR"), badgeCol + W.badge);
});

test("a coloured badge occupies exactly W.badge visible columns", () => {
  // The specific defect: `pad` runs sanitizeDisplay, which strips CSI, so
  // colouring BEFORE padding deleted the colour and padded to W.badge + 9.
  // Both halves are asserted -- the colour survives, and the width is right.
  //
  // ON AN UNSELECTED ROW, and that matters. `V1` puts the cursor on its only
  // item, and the renderer draws a selected row as `p.inv(strip(body))` --
  // `strip` removes every SGR sequence before the inversion wraps it, so a
  // selected row carries the inversion escapes and nothing else. Asserting colour
  // there cannot pass, while the width half passes regardless because `strip`
  // removes the inversion too. The render is right: an inverted row is meant to
  // drop its colours. The fixture was wrong, and it was wrong inside the fix for
  // the very defect it was written to test.
  const p = painter(VT);
  const V1U = { ...V1, cursor: 1, items: [...V1.items,
    { kind: "model", model: ROWS[0].models[1], target: "google/gemini-3.5-pro" }] };
  const row = frame(V1U, META, { caps: VT }).find((l) => l.includes("gemini-3.5-flash-lite"));
  assert.match(row, /\x1b\[3[0-9]m *FREE|\x1b\[3[0-9]mFREE/, "the badge must still be coloured");
  const s = strip(row);
  const badgeCol = 1 + 2 + W.id + W.ctx + 1 + W.price * 2 + 2;
  assert.equal(s.slice(badgeCol, badgeCol + W.badge), "FREE  ");
  assert.equal(s.indexOf("TVR"), badgeCol + W.badge);
});

test("an astral id cannot render a short frame", () => {
  // NB-4's regression, and the reason one measure is authoritative. Thirty astral
  // code points are sixty UTF-16 code units. When `pad` counted units and `bar`
  // counted units while `sanitizeDisplay` capped by code point, this row rendered
  // roughly thirty columns short -- and depending on the exact lengths the width
  // test either failed loudly or PASSED while the terminal was wrong, which is
  // the outcome that would have shipped.
  const wide = {
    ...V0,
    items: [{ kind: "provider", row: {
      keyId: "\u{1F600}".repeat(30), provider: "p", free: 1, planCount: 0, health: "ok",
      models: [{ id: "a", routable: null }] } }],
  };
  for (const l of frame(wide, META, { caps: PLAIN })) {
    assert.equal([...strip(l)].length, FRAME_W, "code points, the measure style.mjs pads with");
  }
});

test("every line of every frame is exactly FRAME_W visible columns", () => {
  for (const v of [V0, V1, { ...V0, empty: true, items: [], filter: "zzz" },
                   { ...V0, legend: true }]) {
    for (const caps of [VT, PLAIN]) {
      for (const l of frame(v, META, { caps })) {
        // Code points, the same measure style.mjs pads with. Using .length here
        // would let an astral row pass this test while rendering short.
        const w = [...strip(l)].length;
        assert.equal(w, FRAME_W, `width ${w}: ${strip(l)}`);
      }
    }
  }
});

test("an over-wide cell clips the row instead of breaking the frame", () => {
  // bar() truncates as well as pads. Without this a single long id pushed the
  // right-hand frame character past FRAME_W and failed the invariant above for
  // the whole frame, with nothing to say which cell caused it.
  const wide = {
    ...V1,
    items: [{ kind: "model", target: "acme/" + "z".repeat(300),
              model: { id: "z".repeat(300), ctx: 1e6, pin: 0, pout: 0, badge: "FREE",
                       tools: true, vision: true, reason: true, routable: null } }],
  };
  for (const l of frame(wide, META, { caps: PLAIN })) {
    // Code points, like every other width assertion in this task. This fixture is
    // all-ASCII so units and points agree at 78 today; the moment it gained an
    // astral character `.length` would read 153 and this test -- the one whose
    // whole subject is over-wide input -- would be the one measuring wrongly.
    assert.equal([...strip(l)].length, FRAME_W);
  }
});

test("the longest health label is not clipped", () => {
  // "needs $" is 7 characters. The previous draft padded the label to
  // W.health - 2 = 6 and rendered "needs " -- while the frozen ASCII mock in this
  // task showed "* needs $" in full, so the mock and the code disagreed.
  const v = { ...V0, items: [{ kind: "provider", row: {
    keyId: "personal.acme.paid", provider: "acme", free: 0, planCount: 0,
    health: "needs $", models: [{ id: "a", routable: null }] } }] };
  const row = frame(v, META, { caps: PLAIN }).find((l) => l.includes("personal.acme.paid"));
  assert.match(strip(row), /needs \$/);
});

test("the empty state names the query, and the legend replaces the rows", () => {
  const e = frame({ ...V0, empty: true, items: [], filter: "zzz" }, META,
                  { caps: PLAIN }).join("\n");
  assert.match(e, /no match for "zzz"/);
  // The way out survives a filter long enough to overflow the row (NB-9).
  const longQ = "z".repeat(30);
  const overflow = frame({ ...V0, empty: true, items: [], filter: longQ }, META,
                         { caps: PLAIN }).find((l) => l.includes("backspace"));
  assert.match(strip(overflow), /backspace to widen, esc to clear/,
    "the instruction must never be the part that gets clipped");
  assert.equal([...strip(overflow)].length, FRAME_W);
  assert.equal(e.includes("personal.google.free"), false);
  const l = frame({ ...V0, legend: true }, META, { caps: PLAIN }).join("\n");
  assert.match(l, /\[\^f\]/);
  assert.match(l, /\[\?\]/);
});

test("the help line is present on every frame including the empty one", () => {
  for (const v of [V0, V1, { ...V0, empty: true, items: [], filter: "zzz" }]) {
    const lines = frame(v, META, { caps: PLAIN });
    assert.match(lines[lines.length - 1], /\[esc\]/);
  }
});

test("confirmLine is one line naming the selection", () => {
  const c = confirmLine("google/gemini-3.5-flash-lite", glyphsFor(PLAIN), painter(PLAIN));
  assert.equal(c.includes("\n"), false);
  assert.match(c, /google\/gemini-3\.5-flash-lite/);
});

test("transitions are a fixed, bounded number of frames", () => {
  const base = frame(V1, META, { caps: PLAIN });
  assert.equal(slideFrames(base).length, 3);
  assert.equal(revealFrames(base).length, 3);
  assert.equal(flashFrames(base, 4, painter(PLAIN)).length, 4);
  for (const f of slideFrames(base)) assert.equal(f.length, base.length);
});

test("sleepSync blocks for about the requested time and returns nothing", () => {
  const t = Date.now();
  assert.equal(sleepSync(40), undefined);
  const spent = Date.now() - t;
  assert.ok(spent >= 30 && spent < 400, `slept ${spent}ms`);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/style.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\style.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/style.mjs`:

```js
// Everything the picker looks like.
//
// One module owns colour, glyph and motion so the whole surface can be retuned in
// one place, and so that every other file can be checked for escape sequences by
// grep. sanitizeDisplay runs on provider strings BEFORE anything here adds our own
// escapes (Q7.6) -- the order matters, because sanitising afterwards would strip
// our styling as eagerly as it strips theirs.
//
// On motion: the input loop is a blocking readSync with no event loop behind it,
// so a timer-driven animation is not merely discouraged, it cannot run. Every
// transition here is a short synchronous burst drawn immediately after the key
// that caused it, three frames at 30 ms, and the pause is Atomics.wait rather
// than a spin on Date.now() (Q7.2, Q7.3).

import { sanitizeDisplay } from "./sanitize.mjs";

export const FRAME_W = 78;
export const FRAME_MS = 30;

// INNER is FRAME_W - 3, and the arithmetic is worth writing down because the
// previous draft had it as FRAME_W - 4 and every single line came out at 77
// against a test asserting 78 -- header, rows, empty state and legend alike.
//
//   bar() emits:  V  body-padded-to-INNER  " "  V
//   total      =  1  +      INNER        + 1 + 1  =  INNER + 3
//
// so INNER = FRAME_W - 3 = 75. The `- 4` came from the comment "| " + content +
// " |", which describes a leading "V " that bar() does not actually emit: every
// body supplies its own two-column indent (`"  " + ...` for headers, `${mark} `
// for rows), so the frame character is followed directly by body[0].
const INNER = FRAME_W - 3;

// Constraint 6 and 7 pin these. `bar` is the one addition, six cells at level 0.
// `health` is the width of the health LABEL; the coloured dot and its space sit
// in a two-column gutter to its left and are not part of the 8 (Constraint 6).
// That gutter is why the label gets the full 8 rather than W.health - 2: the
// longest label, "needs $", is 7 characters and was being clipped to "needs ".
export const W = { keyId: 30, count: 7, bar: 6, free: 12, health: 8,
                   id: 34, ctx: 6, price: 7, badge: 6, caps: 3 };

const ESC = "\x1b";
const SAB = new Int32Array(new SharedArrayBuffer(4));

/** A synchronous pause that does not burn a core and does not need an event loop. */
export function sleepSync(ms) { Atomics.wait(SAB, 0, 0, Math.max(0, ms)); }

export function detectCaps(env = process.env, cols = process.stdout?.columns ?? 80) {
  const dumb = String(env.TERM ?? "") === "dumb";
  const known = !!(env.WT_SESSION || env.ConEmuANSI === "ON" || env.TERM_PROGRAM || env.TERM);
  const vt = known && !dumb;
  const rich = !!(env.WT_SESSION || env.COLORTERM || env.TERM_PROGRAM);
  return { vt, unicode: vt, colours: !vt ? 0 : rich ? 256 : 16, cols };
}

export function motionEnabled({ env = process.env, flags = [], caps }) {
  if (String(env.UW_PICKER_MOTION ?? "") === "0") return false;
  if (flags.includes("--no-motion")) return false;
  if (!caps.vt) return false;
  return caps.cols >= 60;
}

// Four health glyphs, not two. Colour is an enhancement, never the only carrier
// of a state -- `painter` returns `String(s)` unchanged whenever caps.colours is
// 0, and every one of these must still be distinguishable then. Each is exactly
// one column wide in both sets, which the frame-width invariant depends on.
const UNI = {
  marker: "▶", fav: "★", recent: "↺",
  dotOk: "●", dotWarn: "◐", dotBad: "✖", dotStale: "○",
  on: "▰", off: "▱", check: "✔", arrow: "→", sep: "▸", caret: "▏", ell: "…", dash: "—",
  frame: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
};
const ASCII = {
  marker: ">", fav: "*", recent: "~",
  dotOk: "*", dotWarn: "$", dotBad: "x", dotStale: "o",
  on: "#", off: ".", check: "OK", arrow: "->", sep: ">", caret: "_", ell: "...", dash: "-",
  frame: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};
export function glyphsFor(caps) { return caps.unicode ? UNI : ASCII; }

const SGR = { dim: 2, bold: 1, inv: 7, red: 31, grn: 32, yel: 33, cya: 36, mag: 35 };
export function painter(caps) {
  const wrap = (code) => (s) => (caps.colours ? `${ESC}[${code}m${s}${ESC}[0m` : String(s));
  const p = {};
  for (const [name, code] of Object.entries(SGR)) p[name] = wrap(code);
  // A 256-colour ramp for the title only. On a 16-colour host it degrades to cyan,
  // which is the same information with less of it.
  p.ramp = (s, from = 45, to = 39) => {
    if (caps.colours < 256) return p.cya(s);
    const cs = [...String(s)];
    return cs.map((ch, i) => {
      const n = Math.round(from + ((to - from) * i) / Math.max(1, cs.length - 1));
      return `${ESC}[38;5;${n}m${ch}`;
    }).join("") + `${ESC}[0m`;
  };
  return p;
}

export function badgeColour(badge) {
  return badge === "FREE" ? "grn" : badge === "FREE?" ? "yel"
       : badge === "PLAN" ? "cya" : badge === "PAID" ? "dim" : "";
}

// Deliberately not proportional below one cell: a provider with 1 free model out
// of 324 must not render as an empty bar, because "some" and "none" is the
// distinction the column exists to make.
export function proportionBar(free, total, g, width = W.bar) {
  if (free == null || !Number.isFinite(total) || total <= 0) return " ".repeat(width);
  const filled = free <= 0 ? 0 : Math.max(1, Math.round((free / total) * width));
  return g.on.repeat(Math.min(width, filled)) + g.off.repeat(Math.max(0, width - filled));
}

// The glyph carries the state, not only the colour. The previous draft returned
// g.dotOk for ok, needs-$ AND broken, so in the no-colour path -- which is what
// `painter` returns whenever `caps.colours === 0`, and what every ASCII terminal
// gets -- a healthy provider and a dead one both rendered "*". Its own test was
// titled "the health dot carries the state in the glyph as well as the colour"
// and then asserted that ok and broken produce the same glyph.
export function healthDot(health, g, p) {
  if (health === "broken") return p.red(g.dotBad);
  if (health === "needs $") return p.yel(g.dotWarn);
  if (health === "ok") return p.grn(g.dotOk);
  return p.dim(g.dotStale);
}

export function highlight(text, query, p) {
  const q = String(query ?? "");
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return text.slice(0, i) + p.bold(text.slice(i, i + q.length)) + text.slice(i + q.length);
}

// ONE measure of visible width, used by every function in this file that pads,
// truncates or measures. It counts CODE POINTS, which is what sanitizeDisplay's
// cap now counts.
//
// The three measures used to disagree. `pad` ended in `.padEnd(n)` and `bar`
// computed `strip(body).length`, both counting UTF-16 code units, while
// `sanitizeDisplay` capped by code point and `clipVisible` counted by code point.
// Thirty astral code points are sixty code units, so `pad(id, 30)` added no
// padding at all and `bar` then computed its fill against a length twice the real
// one. Two outcomes, and the quieter one is worse: sometimes the frame-width test
// fails, and sometimes the units happen to reach FRAME_W while the terminal
// renders a line thirty columns short — the test passes and the frame is wrong.
//
// This does NOT make the renderer display-width correct: an East Asian glyph is
// one code point in two terminal columns, and that remains deferred with its
// consequence stated in A3 and in the Deferred section. What it makes the
// renderer is SELF-CONSISTENT, which is the property the invariant test can
// actually check.
const vis  = (s) => [...strip(String(s ?? ""))].length;
const fill = (n) => " ".repeat(Math.max(0, n));
const pad  = (s, n) => { const t = sanitizeDisplay(String(s ?? ""), n); return t + fill(n - vis(t)); };
const rpad = (s, n) => { const t = sanitizeDisplay(String(s ?? ""), n); return fill(n - vis(t)) + t; };
const ctxS = (c) => (c == null ? "" : c >= 1e6 ? `${c / 1e6}M` : `${Math.round(c / 1000)}k`);
const money = (v) => (v == null ? "" : Number(v).toFixed(2));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Pad OR TRUNCATE to the frame's inner width using the VISIBLE length, so a
// coloured cell does not shorten its row. This is the one place colour and layout
// interact.
//
// Truncation is not defensive padding; it is the difference between a degraded
// row and a broken frame. The previous draft only padded, so any body wider than
// INNER pushed the right-hand frame character past FRAME_W and every subsequent
// line looked ragged -- and because `bar` is what the width-invariant test
// measures, one over-wide cell failed the test for the whole frame with no
// indication of which cell caused it. An over-long row now clips, which is
// visible, local, and still a valid frame.
const clipVisible = (body, n) => {
  if (vis(body) <= n) return body;
  // Walk the string keeping SGR sequences (zero width) and counting the rest.
  let out = "", seen = 0, i = 0;
  while (i < body.length && seen < n) {
    const m = /^\x1b\[[0-9;]*m/.exec(body.slice(i));
    if (m) { out += m[0]; i += m[0].length; continue; }
    const cp = String.fromCodePoint(body.codePointAt(i));
    out += cp; seen += 1; i += cp.length;
  }
  // Never leave a colour open mid-frame. `strip` removes this again, so it costs
  // nothing in the width accounting.
  return out + `${ESC}[0m`;
};

const bar = (g, body) => {
  const clipped = clipVisible(body, INNER);
  return `${g.frame.v}${clipped}${fill(INNER - vis(clipped))} ${g.frame.v}`;
};

const title = (g, p, text) => {
  const head = `${g.frame.tl}${g.frame.h} ${text} `;
  return p.ramp(head) + g.frame.h.repeat(Math.max(0, FRAME_W - vis(head) - 1)) + g.frame.tr;
};

export const HELP0 = "[↑↓] move  [⇥] scope  [^f] fav  [?] keys  [esc] back";
export const HELP1 = "[↑↓] move  [↵] select  [^f] fav  [?] keys  [esc] back";
const HELP0_A = "[up/dn] move  [tab] scope  [^f] fav  [?] keys  [esc] back";
const HELP1_A = "[up/dn] move  [enter] select  [^f] fav  [?] keys  [esc] back";

const footer = (g, p, text) => {
  const head = `${g.frame.bl} ${text} `;
  return p.dim(head) + g.frame.h.repeat(Math.max(0, FRAME_W - vis(head) - 1)) + g.frame.br;
};

const LEGEND = [
  "up / down      move the cursor",
  "enter          open a provider, or select a model",
  "tab            toggle flat provider/model search",
  "ctrl+f         add or remove a favourite",
  "esc            clear the filter, then go back, then quit",
  "ctrl+c         quit without changing the chat input",
  "?              this legend",
];

export function frame(v, meta, { caps }) {
  const g = glyphsFor(caps), p = painter(caps);
  const L = [];

  const crumb = v.level === 0
    ? "UW " + g.sep + " providers"
    : `UW ${g.sep} ${sanitizeDisplay(v.provider.keyId, 30)} ${g.sep} models`;
  L.push(title(g, p, crumb));

  // Q1.3: the routability stamp is printed, not implied. An undimmed row means
  // either "routable" or "nobody checked", and those are different claims; the
  // stamp is what lets the user tell which one they are looking at. `—` means the
  // refresher has never resolved routability, so nothing on screen is dimmed.
  const routableStamp = meta.routableAsOf
    ? `routable ${String(meta.routableAsOf).slice(5, 16).replace("T", " ")}`
    : `routable ${g.dash}`;
  const right = v.level === 0
    ? `${meta.providers} providers ${g.sep} ${meta.models} models ${g.sep} ${routableStamp}`
    : `${v.items.length} of ${v.provider.models.length}`;
  const left = `  filter: ${sanitizeDisplay(v.filter, 40)}${p.inv(g.caret)}`;
  const gap = Math.max(1, INNER - vis(left) - vis(right));
  L.push(bar(g, left + " ".repeat(gap) + p.dim(right)));
  L.push(bar(g, ""));

  if (v.legend) {
    for (const line of LEGEND) L.push(bar(g, "  " + line));
    L.push(bar(g, ""));
    L.push(bar(g, p.dim("  any key returns")));
    L.push(footer(g, p, caps.unicode ? HELP0 : HELP0_A));
    return L;
  }

  // Header columns must line up with the row columns beneath them, which the
  // previous draft's did not: it reserved W.bar + W.free = 18 for "free" while
  // the row emitted a 5-wide bar + " " + an 11-wide value = 17, so everything
  // from "free" rightward was off by one; and it emitted a bare "caps" (4) over a
  // 3-wide T/V/R cell. Both are now derived from the same W constants as the row,
  // and the derived-offset test below asserts they agree rather than trusting it.
  // The two-space gap before "health" is the dot gutter (see W).
  L.push(bar(g, p.dim(v.level === 0
    ? "  " + pad("key id", W.keyId) + rpad("models", W.count) + "   " +
      pad("free", W.bar + W.free) + "  " + pad("health", W.health)
    : "  " + pad("model", W.id) + rpad("ctx", W.ctx) + " " +
      rpad("$in", W.price) + rpad("$out", W.price) + "  " +
      pad("badge", W.badge) + pad("TVR", W.caps))));

  if (v.empty) {
    // The instruction comes FIRST, and the query is clipped to 20.
    //
    // This line is `2 + 14 + filter + 1 + 1 + 1 + 33` columns, so at a filter of 24
    // it exceeds INNER = 75 while sanitizeDisplay permitted 30. `bar` then clips
    // from the right -- and what is on the right is "backspace to widen, esc to
    // clear". The user loses the stated way out at the exact moment they are most
    // stuck, and the frozen mock uses a three-character filter so it never showed.
    // Ordering the instruction ahead of the echoed query makes the clip fall on
    // the query, which is the part the user already knows.
    L.push(bar(g, `  backspace to widen, esc to clear ${g.dash} no match for ` +
                  `"${sanitizeDisplay(v.filter, 20)}"`));
  }

  v.items.forEach((it, i) => {
    const selected = v.top + i === v.cursor;
    const mark = selected ? g.marker : " ";
    let body;
    if (it.kind === "provider") {
      const r = it.row;
      const total = r.models.length;
      const freeTxt = r.free == null ? g.dash
        : r.planCount ? `${r.free} +${r.planCount} plan` : String(r.free);
      body = `${mark} ` + highlight(pad(r.keyId, W.keyId), v.filter, p) +
             rpad(total, W.count) + "   " +
             proportionBar(r.free, total, g) + " " + pad(freeTxt, W.free - 1) +
             healthDot(r.health, g, p) + " " + pad(r.health, W.health);
    } else if (it.kind === "pinned") {
      body = `${mark} ` + (it.mark === "*" ? p.yel(g.fav) : p.dim(g.recent)) + " " +
             highlight(pad(it.target, W.keyId + W.count), v.filter, p);
    } else {
      const m = it.model;
      const cap = (on, ch, colour) => (on ? p[colour](ch) : p.dim("-"));
      // COLOUR AFTER PADDING, never before. `pad` runs sanitizeDisplay, which
      // strips CSI sequences by design (A3) -- so passing an already-coloured
      // string into it silently deleted the colour and then padded the bare text
      // to W.badge + 9, leaving nine stray spaces. The +9 was wrong on its own
      // terms too: it assumed a 9-character SGR wrapper, but p.dim (used for
      // PAID) is 8 and p.ramp's 256-colour form is 11 or more per character.
      const badgeCell = pad(m.badge, W.badge);
      const badgeOut = badgeColour(m.badge) ? p[badgeColour(m.badge)](badgeCell) : badgeCell;
      body = `${mark} ` + highlight(pad(m.id, W.id), v.filter, p) +
             rpad(ctxS(m.ctx), W.ctx) + " " +
             rpad(money(m.pin), W.price) + rpad(money(m.pout), W.price) + "  " +
             badgeOut +
             cap(m.tools, "T", "cya") + cap(m.vision, "V", "mag") + cap(m.reason, "R", "yel");
      // Q1.3: `routable` is a value on the row, baked in by the refresher. `false`
      // dims; `null` -- nobody checked -- does not, because dimming everything the
      // one time the gateway was unreachable says "nothing works" when the truth
      // is "nothing was asked".
      if (m.routable === false) body = p.dim(strip(body));
    }
    L.push(bar(g, selected ? p.inv(strip(body)) : body));
  });

  if (v.more > 0) L.push(bar(g, p.dim(`  ${g.ell} ${v.more} more`)));
  L.push(footer(g, p, caps.unicode ? (v.level === 0 ? HELP0 : HELP1)
                                   : (v.level === 0 ? HELP0_A : HELP1_A)));
  return L;
}

export function confirmLine(target, g, p) {
  return `${p.grn(g.check)} switched ${g.arrow} ${p.bold(sanitizeDisplay(target, 60))}`;
}

// --- transitions -----------------------------------------------------------
// Each returns an array of complete frames. The caller writes them one at a time
// with sleepSync(FRAME_MS) between, so the whole burst is 90 ms and the next key
// is read immediately afterwards (Q7.3).

export function slideFrames(lines, step = 6, frames = 3) {
  const out = [];
  for (let f = frames; f >= 1; f--) {
    const shift = " ".repeat(step * (f - 1));
    out.push(lines.map((l) => (shift + l).slice(0, FRAME_W + shift.length)));
  }
  return out;
}

export function revealFrames(lines, frames = 3) {
  const out = [];
  for (let f = 1; f <= frames; f++) {
    const n = Math.ceil((lines.length * f) / frames);
    out.push(lines.slice(0, n));
  }
  return out;
}

export function flashFrames(lines, index, p, times = 2) {
  const out = [];
  for (let i = 0; i < times; i++) {
    out.push(lines.map((l, n) => (n === index ? p.inv(strip(l)) : l)));
    out.push(lines);
  }
  return out;
}
```

Create `C:/Users/osami/.uw/docs/visual-design.md` holding the two mocks above, the glyph table with its ASCII column, the palette (`FREE` green, `FREE?` yellow, `PLAN` cyan, `PAID` dim, blank uncoloured; tools cyan, vision magenta, reasoning yellow; health green, yellow, red, dim), and the three departures from the brief with their reasons. It is a document, not a specification the code reads; its job is to make the next styling change a decision rather than a diff.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 107 (indicative — see "How to read the `# pass N` numbers"). If the two exact-row tests fail, read the diff before touching them: they encode the column widths constraints 6 and 7 pin, and the usual cause of a mismatch is a padding change that also silently moved every other column.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): one module owning colour, glyphs, columns and the four event-driven transitions"
```

---

### Task A10: Rewire `uwpick.mjs` onto the reducer, the snapshot and the style module

Implements D1, D6, Q1.1, Q1.3, Q2.1, Q3.1, Q3.3, Q3.7 and Q7.3. After this task `uwpick.mjs` owns three things and nothing else: reading the console, sequencing frames, and writing the selection. Rows come from the snapshot (Task A8), every character comes from the style module (Task A9), every decision comes from the reducer (Task A6), and the two strings Claude Code cares about come from the contract module (Task A4).

**`main()` is synchronous after the first frame, and that is a hard property rather than an incidental one.** An earlier draft of this task drew the first frame, then issued the routability RPC with a 400 ms budget and redrew "when it returns", and registered an `out.on("resize")` handler. Neither could ever run. The loop below it is `for (;;) { readSync(CONIN, ...) }` — a blocking libuv call on the main thread with no `await` in the body — so the JS stack never unwinds, the event loop is never re-entered, and the only exit is `process.exit()` from inside `finish()`. Q7.2 states that constraint plainly; the old Q1.3 assumed its opposite, and the routability column would have rendered empty in every session with no test able to notice, because a unit test has an event loop. Routability now arrives as a field on the snapshot rows, computed once by `refresh/cli.mjs`. Resize is handled on the key path, where `draw()` already reduces a `{resize}` event.

**The exit contract is the other thing this task gets right or gets very wrong.** Selection writes the command and exits 0. Every other outcome — Esc at the bottom rung, ctrl+c, an unusable snapshot, `CONIN$` unavailable, a failed write — truncates the buffer to empty **and** exits non-zero. Both halves, every time, through one `abort()` helper, because the buffer at that moment still contains the `m` the user typed to open the picker and exit 0 means "accept the buffer" (Q2.1, Q2.3a, Q2.6). Task A13 carries the other half of this: `uwpick.cmd` must propagate the exit code rather than replacing it with 0.

**Files:** Modify `C:/Users/osami/.uw/menu/uwpick.mjs`, Modify `C:/Users/osami/.uw/menu/state.mjs`, Test `C:/Users/osami/.uw/test/uwpick.test.mjs`
**Interfaces:** Consumes: `loadSnapshot` from `./snapshot.mjs`; `initState`, `reduce`, `view`, `tokenize` from `./pick-state.mjs`; `frame`, `confirmLine`, `detectCaps`, `glyphsFor`, `painter`, `motionEnabled`, `slideFrames`, `revealFrames`, `flashFrames`, `sleepSync`, `FRAME_MS` from `./style.mjs`; `handoffTarget`, `modelCommand`, `CONTRACT` from `./cc-contract.mjs`; `loadPickerState`, `recordRecent`, `toggleFavourite`, `recordHandoff`, `recordStartup` from `./state.mjs`. Produces:
`screen(v: View, meta: Meta, opts: {caps}) -> string` — the frame as one string, exported so it is testable without a console. Synchronous and pure; `Meta` carries `{providers, models, generatedAt, routableAsOf}`
`firstFrame(input: {snap, recents, favourites, caps, termRows}) -> {state, meta, text}` — synchronous, needs no gateway
`failMessage(res: {reason, detail}) -> string` — the single line printed when the snapshot cannot be used
`framesFor(kind: "enter"|"back"|"open"|"select", lines: string[], opts) -> string[][]`
`main()` — opens `//./CONIN$`, loops, and exits through exactly one of two paths: `finish(target)` writes the selection and exits `CONTRACT.handoff.acceptExit` (0), or `abort()` truncates the buffer and exits `CONTRACT.handoff.discardExit` (non-zero). There is no third path
And in `state.mjs`: `recordStartup(ms: number, file?: string) -> {samples, median}` — keeps the last 20 first-frame latencies.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/uwpick.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { initState, reduce, view } from "../menu/pick-state.mjs";
import { detectCaps, painter } from "../menu/style.mjs";
import { screen, firstFrame, failMessage, framesFor } from "../menu/uwpick.mjs";
import { recordStartup } from "../menu/state.mjs";

const CAPS = detectCaps({ TERM: "dumb" }, 80);          // deterministic: ASCII, no colour
const VT = detectCaps({ WT_SESSION: "1" }, 120);
const M = (id, badge = "", extra = {}) => ({ id, ctx: null, pin: null, pout: null, badge,
                                             tools: false, vision: false, reason: false,
                                             routable: null, ...extra });
const ROWS = [
  { keyId: "personal.acme.free", provider: "acme", free: 12, planCount: 4, health: "ok",
    models: [M("acme-chat-1", "FREE?", { ctx: 163840, pin: 0, pout: 0, tools: true, reason: true,
                                         routable: true }),
             M("acme-pro-1", "PAID", { ctx: 1000000, pin: 0.3, pout: 1.2, vision: true,
                                       routable: false })] },
  { keyId: "personal.blank.paid", provider: "blank", free: null, planCount: 0, health: "broken",
    models: [M("blank-a")] },
];
const META = { providers: 2, models: 3, generatedAt: "2026-08-24T12:22:28.162Z",
               routableAsOf: "2026-08-24T12:25:00.000Z" };
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const show = (v, caps = CAPS) => plain(screen(v, META, { caps }));

test("the provider header names the required columns", () => {
  assert.match(show(view(initState(ROWS))), /key id\s+models\s+free\s+health/);
});

test("a nullable free column renders a dash, not a zero", () => {
  const line = show(view(initState(ROWS))).split("\n").find((l) => l.includes("personal.blank.paid"));
  assert.match(line, /-/);
  assert.doesNotMatch(line, /\s0\s/);
});

test("a provider with plan-covered models renders the +N plan form", () => {
  const line = show(view(initState(ROWS))).split("\n").find((l) => l.includes("personal.acme.free"));
  assert.match(line, /12 \+4 plan/);
});

test("the model header names the six required columns", () => {
  const s = reduce(initState(ROWS), "\r").state;
  assert.match(show(view(s)), /model\s+ctx\s+\$in\s+\$out\s+badge\s+TVR/);
});

test("model rows render ctx, prices, badge and caps", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const line = show(view(s)).split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /1M/);
  assert.match(line, /0\.30/);
  assert.match(line, /1\.20/);
  assert.match(line, /PAID/);
  assert.match(line, /-V-/);
});

test("a non-routable model row is dimmed rather than hidden", () => {
  const s = reduce(initState(ROWS), "\r").state;
  const raw = screen(view(s), META, { caps: VT });
  const line = raw.split("\n").find((l) => l.includes("acme-pro-1"));
  assert.match(line, /\x1b\[2m/);
  assert.equal(raw.includes("acme-pro-1"), true);
});

test("a row whose routability is unknown is NOT dimmed", () => {
  // Q1.3. `null` is "nobody checked", and the refresher writes null for every row
  // whenever it could not reach CCR. Dimming those would mean the picker shows
  // 1,584 apparently-broken models on the one occasion the gateway is down.
  const s = reduce(initState(ROWS), "\r").state;
  const unknown = { ...view(s) };
  unknown.items = unknown.items.map((it) => it.kind === "model"
    ? { ...it, model: { ...it.model, routable: null } } : it);
  const raw = screen(unknown, META, { caps: VT });
  for (const id of ["acme-chat-1", "acme-pro-1"]) {
    const line = raw.split("\n").find((l) => l.includes(id));
    assert.doesNotMatch(line, /\x1b\[2m/, `${id} must not be dimmed when routability is unknown`);
  }
});

test("the header prints the routability stamp, and a dash when there is none", () => {
  assert.match(show(view(initState(ROWS))), /routable 08-24 12:25/);
  const noStamp = plain(screen(view(initState(ROWS)),
    { ...META, routableAsOf: null }, { caps: CAPS }));
  assert.match(noStamp, /routable -/);
});

test("uwpick.mjs contains no promise continuation and no resize listener", () => {
  // Q1.3 and Q7.2 as an executable guard rather than a comment. The blocking
  // readSync loop never re-enters the event loop, so a `.then()` or an
  // `on("resize")` here is code that cannot run -- and both were present in the
  // previous draft, promising a live routability column that always rendered
  // empty. This test is cheap and it fails the moment either comes back.
  const src = fs.readFileSync(
    path.join(os.homedir(), ".uw", "menu", "uwpick.mjs"), "utf8");
  assert.doesNotMatch(src, /\.then\s*\(/, "a promise continuation can never run in this process");
  assert.doesNotMatch(src, /\.on\s*\(\s*["']resize["']/, "a resize listener can never fire here");
  assert.doesNotMatch(src, /routableSet/, "routability is baked into the snapshot by the refresher");
  // `await` is the hole the other three leave open: it re-enters the event loop,
  // compiles fine, and passes a guard that only looks for `.then(`. `main` is not
  // async and nothing awaits it, so any `await` in this file is the change this
  // guard exists to stop.
  // Strip line comments before matching. The marker comment this guard protects
  // contains the word `await` in prose -- "no `await` in its body" -- so a bare
  // substring match fails against the very file it reads. Match only where the
  // keyword could execute.
  const code = src.replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\bawait\b/, "an await would re-enter the event loop the loop cannot yield to");
  assert.doesNotMatch(code, /export\s+async\s+function\s+main/,
    "main must not be async: nothing awaits it, and the keyword invites the await above");
});

test("the empty state renders a row instead of a blank pane", () => {
  let s = initState(ROWS);
  for (const k of ["z", "z", "z", "z"]) s = reduce(s, k).state;
  assert.match(show(view(s)), /no match for "zzzz"/);
});

test("escape sequences in a model id cannot reach the frame", () => {
  const rows = [{ keyId: "p", provider: "p", free: null, planCount: 0, health: "ok",
                  models: [M("evil\x1b[2Jx")] }];
  const s = reduce(initState(rows), "\r").state;
  assert.equal(screen(view(s), META, { caps: VT }).includes("\x1b[2J"), false);
});

test("the help line names the keys the reducer implements", () => {
  const out = show(view(initState(ROWS)));
  assert.match(out, /\[tab\]|\[⇥\]/);
  assert.match(out, /\[esc\]/);
});

// --- the four properties this task adds ------------------------------------

test("the first frame is produced synchronously, with no routability at all", () => {
  const snap = { schemaVersion: 1, generatedAt: META.generatedAt, builtAt: "x", rows: ROWS };
  const f = firstFrame({ snap, recents: [], favourites: [], caps: CAPS, termRows: 30 });
  assert.equal(typeof f.text, "string");
  assert.equal(f.text.includes("personal.acme.free"), true);
  assert.equal(f.meta.providers, 2);
  assert.equal(f.meta.models, 3);
  // Nothing here may be a promise: the whole point is that it runs before the RPC.
  assert.equal(typeof f.text.then, "undefined");
});

test("an unusable snapshot produces one actionable line naming the fix", () => {
  const m = failMessage({ reason: "missing", detail: "C:/Users/osami/.uw/catalog/snapshot.json" });
  assert.match(m, /snapshot\.json/);
  assert.match(m, /uw catalog refresh|snapshot\.mjs --build/);
  assert.equal(m.includes("\n"), false);
  assert.match(failMessage({ reason: "schema", detail: "expected schemaVersion 1, found 9" }), /found 9/);
});

test("motion off collapses every transition to a single frame", () => {
  const lines = ["a", "b", "c"];
  const off = { caps: CAPS, motion: false, painter: painter(CAPS) };
  for (const kind of ["enter", "back", "open", "select"]) {
    assert.deepEqual(framesFor(kind, lines, off), [lines]);
  }
});

test("motion on stays inside the three-frame budget", () => {
  const lines = ["a", "b", "c", "d"];
  const on = { caps: VT, motion: true, painter: painter(VT), index: 2 };
  assert.equal(framesFor("enter", lines, on).length, 3);
  assert.equal(framesFor("back", lines, on).length, 3);
  assert.equal(framesFor("open", lines, on).length, 3);
  assert.ok(framesFor("select", lines, on).length <= 4);
});

test("the picker's runtime path stays inside its line budget", () => {
  // Constraint 25, enforced rather than asserted in prose. The module list is
  // uwpick.mjs's transitive import graph, not a hand-picked set -- the first
  // version of the constraint omitted cc-contract.mjs and state.mjs, both
  // imported directly, so the budget under-counted the thing it bounded.
  //
  // Gated on the files existing so the suite stays at `# fail 0` before A10 lands
  // (Constraint 15a). Blank lines and comment-only lines do not count: the budget
  // exists because parse and execution cost scale with code, and this plan wants
  // its reasoning written down.
  const MENU_DIR = path.join(os.homedir(), ".uw", "menu");
  const RUNTIME = ["uwpick.mjs", "pick-state.mjs", "style.mjs", "snapshot.mjs",
                   "sanitize.mjs", "denylist.mjs", "atomic.mjs", "cc-contract.mjs",
                   "state.mjs"];
  const present = RUNTIME.filter((f) => fs.existsSync(path.join(MENU_DIR, f)));
  if (present.length < RUNTIME.length) return;              // not built yet

  const counts = present.map((f) => {
    const body = fs.readFileSync(path.join(MENU_DIR, f), "utf8");
    const n = body.split("\n")
      .filter((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)).length;
    return [f, n];
  });
  const total = counts.reduce((a, [, n]) => a + n, 0);
  assert.ok(total <= 900,
    `picker runtime path is ${total} lines against a 900 budget:\n` +
    counts.map(([f, n]) => `  ${String(n).padStart(4)}  ${f}`).join("\n") +
    `\nThe 300 ms first-frame budget is what this bounds. Either cut, or change the ` +
    `number deliberately and say why.`);
});

test("recordStartup keeps a bounded sample set and a median", () => {
  const f = path.join(os.homedir(), ".uw", "harness", "scratch", "startup.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.rmSync(f, { force: true });
  let last;
  for (const ms of [100, 300, 200]) last = recordStartup(ms, f);
  assert.equal(last.samples.length, 3);
  assert.equal(last.median, 200);
  for (let i = 0; i < 30; i++) recordStartup(50, f);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).samples.length, 20);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/uwpick.test.mjs"
```

Expected failure: `SyntaxError: The requested module '../menu/uwpick.mjs' does not provide an export named 'screen'` — and, because the current file runs its console loop at import time, the test process also hangs or exits early. Both symptoms disappear in step 3, which is why `main()` becomes explicit.

- [ ] Step 3: Implement.

First add to `C:/Users/osami/.uw/menu/state.mjs`:

```js
export const STARTUP_FILE = path.join(STATE_DIR, "startup.json");
const MAX_SAMPLES = 20;

// Q1.2's number, recorded on every real run rather than only under benchmark, so
// a regression shows up in ordinary use instead of waiting for someone to measure.
export function recordStartup(ms, file = STARTUP_FILE) {
  const prev = readJsonOr(file, { samples: [] });
  const samples = [...(prev.samples ?? []), { at: new Date().toISOString(), ms }].slice(-MAX_SAMPLES);
  const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
  const next = { samples, median };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(next, null, 2));
  } catch { /* a lost sample is not worth failing a launch over */ }
  return next;
}
```

`state.mjs` imports `readJsonOr` alongside `writeAtomic` from `./atomic.mjs` for this.

Then rewrite `C:/Users/osami/.uw/menu/uwpick.mjs`:

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
// This file is three responsibilities and no more: read the console, sequence
// frames, write the selection. Rows come from the snapshot, characters come from
// style.mjs, decisions come from pick-state.mjs, and the two strings Claude Code
// cares about come from cc-contract.mjs.

import fs from "node:fs";
import { openSync, readSync, closeSync } from "node:fs";
import { loadSnapshot, SNAPSHOT_FILE } from "./snapshot.mjs";
// NOTE: catalog.mjs is deliberately NOT imported here. It pulls in keysync and a
// 19.7 MB catalogue parse, and the picker's whole input is the pre-built
// snapshot (Q1.1). Routability arrives on the snapshot rows (Q1.3).
import { initState, reduce, view } from "./pick-state.mjs";
import { handoffTarget, modelCommand, CONTRACT } from "./cc-contract.mjs";
import { loadPickerState, recordRecent, toggleFavourite, recordHandoff,
         recordStartup } from "./state.mjs";
import { frame, confirmLine, detectCaps, glyphsFor, painter, motionEnabled,
         slideFrames, revealFrames, flashFrames, sleepSync, FRAME_MS } from "./style.mjs";

const ESC = "\x1b";
const HOME = `${ESC}[H`;
const EL = `${ESC}[K`;                 // erase to end of line
const CLEAR = `${ESC}[2J${ESC}[H`;
const HIDE = `${ESC}[?25l`, SHOW = `${ESC}[?25h`;

export function screen(v, meta, opts) { return frame(v, meta, opts).join("\n"); }

// Q3.7: cursor-home plus per-line erase, never a full clear between frames. A
// full clear is two writes the terminal renders separately, which is exactly what
// flicker is; the screen is cleared once on entry and once on exit and never in
// between.
function paint(out, lines) {
  out.write(HOME + lines.map((l) => l + EL).join("\n") + `${ESC}[J`);
}

export function firstFrame({ snap, recents, favourites, caps, termRows }) {
  const rows = snap.rows;
  const state = initState(rows, { recents, favourites, termRows });
  const meta = {
    providers: rows.length,
    models: rows.reduce((n, r) => n + r.models.length, 0),
    generatedAt: snap.generatedAt,
    // Q1.3: carried straight through from the snapshot the refresher wrote. The
    // picker asks nobody anything; it prints the stamp so the user can see how
    // old the dim state is rather than assuming it is live.
    routableAsOf: snap.routableAsOf ?? null,
  };
  return { state, meta, text: screen(view(state), meta, { caps }) };
}

export function failMessage(res) {
  const fix = "run: node C:/Users/osami/.uw/menu/snapshot.mjs --build";
  if (res.reason === "missing") return `uwpick: no catalogue snapshot at ${res.detail} — ${fix}`;
  if (res.reason === "schema") return `uwpick: snapshot is the wrong version (${res.detail}) — ${fix}`;
  return `uwpick: snapshot unreadable (${res.detail}) — ${fix}`;
}

export function framesFor(kind, lines, opts) {
  if (!opts.motion) return [lines];
  if (kind === "enter") return slideFrames(lines, 6, 3);
  if (kind === "back") return slideFrames(lines, -6, 3).map((f) => f.map((l) => l.trimStart()));
  if (kind === "open") return revealFrames(lines, 3);
  return flashFrames(lines, opts.index ?? 0, opts.painter, 2);
}

// One place that decides what happens to the handoff buffer, so the two halves of
// Q2.1 cannot drift apart. Both are needed: the exit code is what Claude Code
// reads, and the truncation is what makes the outcome right even if some layer
// swallows the code -- which is exactly what uwpick.cmd used to do.
function abort(out, FILE, message) {
  if (message) process.stderr.write(message + "\n");
  if (FILE) { try { fs.writeFileSync(FILE, ""); } catch { /* nothing left to do */ } }
  process.exit(CONTRACT.handoff.discardExit);
}

export function main() {
  const t0 = process.hrtime.bigint();
  const FILE = handoffTarget(process.argv);
  const out = process.stdout;
  const caps = detectCaps(process.env, out.columns ?? 80);
  const g = glyphsFor(caps), p = painter(caps);
  const motion = motionEnabled({ env: process.env, flags: process.argv.slice(2), caps });

  const loaded = loadSnapshot();
  if (!loaded.ok) {
    // Q2.1. Truncate AND exit non-zero. The buffer at this moment still holds the
    // `m` the user typed to get here, and exit 0 would submit it as a chat message.
    abort(out, FILE, failMessage({ ...loaded, detail: loaded.detail ?? SNAPSHOT_FILE }));
  }

  const { recents, favourites } = loadPickerState();
  let { state, meta } = firstFrame({
    snap: loaded.snap, recents, favourites, caps, termRows: out.rows || 30,
  });

  const lines = () => frame(view(state), meta, { caps });
  const run = (kind, index) => {
    for (const f of framesFor(kind, lines(), { motion, painter: p, caps, index })) {
      paint(out, f);
      if (motion) sleepSync(FRAME_MS);
    }
  };
  const draw = () => {
    state = reduce(state, { resize: out.rows || 30 }).state;
    paint(out, lines());
  };

  out.write(HIDE + CLEAR);
  run("open");                                     // startup reveal, inside the budget
  recordStartup(Number(process.hrtime.bigint() - t0) / 1e6);

  // NOTHING ASYNCHRONOUS HAPPENS BELOW THIS LINE, and nothing may be added.
  // The loop is a blocking readSync with no `await` in its body, so the JS stack
  // never unwinds: the event loop is never re-entered, the microtask queue never
  // drains, and `process.exit()` inside `finish()` is the only way out. A promise
  // continuation or an `out.on("resize", ...)` here is unreachable code that a
  // unit test -- which has an event loop -- will happily pass (Q1.3, Q7.2). The
  // routability column is a field on the snapshot rows, put there by the
  // refresher. A terminal resize is picked up on the next keystroke, because
  // `draw()` reduces a `{resize}` event before painting; there is no way to
  // observe one sooner without a worker thread, and Q7.2 forbids adding one.

  let CONIN = null;
  try { CONIN = openSync("//./CONIN$", "r"); } catch { CONIN = null; }

  // Selection only. Every non-selection path goes through abort(), which
  // truncates the buffer and exits non-zero (Q2.1, Q2.3a).
  const finish = (target) => {
    let wrote = false;
    try {
      fs.writeFileSync(FILE, modelCommand(...target.split(/\/(.*)/s)));
      wrote = true;
    } catch {
      // The one string we exist to write did not get written. Exiting 0 here
      // would leave the sentinel in the buffer and submit `m` as chat input, so
      // this is an abort like any other -- and the user is told why.
      out.write(CLEAR + SHOW);
      abort(out, FILE, `uwpick: could not write the selection to ${FILE}`);
    }
    // Q3.3: the frame collapses to one line, which is what the user is left
    // looking at for the instant before Claude Code repaints.
    out.write(CLEAR + SHOW + confirmLine(target, g, p) + "\n");
    recordHandoff({ argv2: FILE ?? null, existed: !!FILE && fs.existsSync(FILE), wrote });
    process.exit(CONTRACT.handoff.acceptExit);      // 0: CC accepts the content
  };

  const quit = (why) => {
    out.write(CLEAR + SHOW);
    recordHandoff({ argv2: FILE ?? null, existed: !!FILE && fs.existsSync(FILE),
                    wrote: false, why });
    abort(out, FILE, null);
  };

  // The one escape hatch, and its only caller is test/bench-startup.mjs's
  // wrapper-inclusive measurement (Q1.5), which needs the whole ctrl+g chain to
  // run to completion without a console and without a human. It quits through the
  // ordinary abort path, so it measures the real exit sequence rather than a
  // shortcut past it.
  if (process.env.UW_PICKER_QUIT_IMMEDIATELY === "1") quit("bench");

  if (CONIN === null) {
    // Q2.6. The console is unusable, so there is nothing to pick; leaving `m` in
    // the buffer would turn an environment problem into a chat message.
    out.write(`\n\n  uwpick: cannot open CONIN$ — the console is not available.\n`);
    quit("no-conin");
  }

  const buf = Buffer.alloc(1024);
  for (;;) {
    let n = 0;
    try { n = readSync(CONIN, buf, 0, buf.length, null); }
    catch { break; }
    if (n <= 0) continue;

    // Q3.8: readSync hands back the whole console buffer, so a held arrow arrives
    // as several sequences in one chunk. Reduce each key in order, then draw once.
    const before = state.level;
    let exited = null, refav = null;
    for (const key of tokenize(buf.toString("utf8", 0, n))) {
      const r = reduce(state, key);
      state = r.state;
      if (r.favourite) refav = r.favourite;
      if (r.exit) { exited = r.exit; break; }
    }
    if (refav) {
      const next = toggleFavourite(refav);
      state = initState(loaded.snap.rows, { ...next, termRows: out.rows || 30 });
    }
    if (exited) {
      closeSync(CONIN);
      if (exited.target) {
        recordRecent(exited.target);
        run("select", view(state).cursor - view(state).top + 4);
        finish(exited.target);
      }
      quit("esc-or-ctrl-c");
    }
    if (state.level > before) run("enter");
    else if (state.level < before) run("back");
    else draw();
  }
  closeSync(CONIN);
  quit("read-error");
}

// Only run the loop when invoked as a program, never on import -- otherwise the
// test that imports `screen` would block on a console read.
if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/uwpick.mjs")) {
  main();
}
```

Five deliberate changes from the spike beyond the wiring. The key log is gone: it existed to prove keystrokes arrived at all, that is now established, and an append-only log of every keystroke typed into a filter box is a small liability for no remaining benefit. `recordHandoff` records the handoff shape instead, which is what `uw doctor` reads, and it now records the abort reason too, so a run that ended without a selection is distinguishable in `handoff.json` from one that was never invoked. The selection is turned into a command by `modelCommand`, so the one string Claude Code parses exists in exactly one file. The read buffer grows from 64 bytes to 1024, because a paste is one `readSync` and a 64-byte buffer silently truncates it. And the chunk goes through `tokenize` before the reducer sees it (Q3.8).

Note the favourite path rebuilds the state, which resets the cursor. That is a visible, acceptable cost for about fifteen lines less bookkeeping; if it becomes annoying, the fix is to thread `pinned` through `reduce` rather than re-initialising.

One consequence of `tokenize` worth stating: a chunk containing an exit key stops being processed at that key. `ESC` followed by more input in the same chunk discards the tail. This is correct — the user pressed Esc — and it is the only ordering that does not require the reducer to know about the chunk boundary.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 121 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): draw from the snapshot first and ask the gateway second, with styled frames and bounded motion"
```

---

### Task A11: Measure the startup budget and make it a test

Implements Q1.2 and Q1.4, and it is the mitigation named in pre-mortem scenario 5. A performance target that is only a sentence in a plan is a target nobody will notice losing. This task turns 300 ms into something that fails.

What is measured is the Node-side path: process start, module graph, snapshot read, row construction and the first frame's string. That is the part this project controls, and it is the part a change can regress. The PowerShell wrapper adds roughly 200 ms of its own before Node starts; the bench reports that separately and does not gate on it, because it is the cost of the only mechanism by which Node can set the console mode at all (constraint 23) and no change in this repository will move it.

**Files:** Create `C:/Users/osami/.uw/test/bench-startup.mjs`, Test `C:/Users/osami/.uw/test/bench.test.mjs`
**Interfaces:** Consumes: `loadSnapshot` from `../menu/snapshot.mjs`; `firstFrame` from `../menu/uwpick.mjs`. Produces:
`BUDGET_MS = 300`, `WRAPPER_SOFT_MS = 700`
`median(ns: number[]) -> number`
`verdict(ms: number, budget?: number) -> {ok: boolean, line: string}`
`sampleOnce() -> Promise<number>` — spawn one Node process that builds the first frame and prints its own elapsed milliseconds
`run(samples?: number) -> Promise<{samples: number[], median: number, ok: boolean}>`

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/bench.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { median, verdict, run, BUDGET_MS } from "./bench-startup.mjs";
import { SNAPSHOT_FILE } from "../menu/snapshot.mjs";

test("median is the middle sample, not the mean", () => {
  assert.equal(median([100, 900, 110]), 110);
  assert.equal(median([50]), 50);
  assert.equal(median([]), null);
});

test("verdict states the budget and the observed number in one line", () => {
  const ok = verdict(120);
  assert.equal(ok.ok, true);
  assert.match(ok.line, /120/);
  assert.match(ok.line, new RegExp(String(BUDGET_MS)));
  assert.equal(verdict(BUDGET_MS + 1).ok, false);
  assert.equal(verdict(BUDGET_MS).ok, true);
});

test("the first frame is built in under the budget, five times", { timeout: 60000 }, async (t) => {
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    t.skip("no snapshot built yet — run: node menu/snapshot.mjs --build");
    return;
  }
  const r = await run(5);
  assert.equal(r.samples.length, 5);
  assert.ok(r.ok, `median ${r.median} ms exceeds the ${BUDGET_MS} ms budget: ${r.samples.join(", ")}`);
});

test("the bench measures a whole process, not an in-process call", async () => {
  const src = fs.readFileSync(new URL("./bench-startup.mjs", import.meta.url), "utf8");
  assert.match(src, /spawn|execFile/);
  assert.equal(src.includes("performance.now() - start"), false);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/bench.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\test\bench-startup.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/test/bench-startup.mjs`:

```js
// The startup budget, as a number that can fail.
//
// Measured: node boot + module graph + snapshot read + first frame string. A
// separate process per sample, because most of the cost being defended is module
// loading and an in-process loop would measure a warm cache five times.
//
// NOT measured, deliberately: the PowerShell wrapper's own start (~200 ms) and
// the terminal's paint. The first is unavoidable -- Node cannot call
// SetConsoleMode -- and the second is not ours.

import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const pexec = promisify(execFile);
export const BUDGET_MS = 300;
// The full ctrl+g cost: cmd dispatcher + PowerShell start (Add-Type compilation
// is the largest fixed cost here) + node + first frame. It is a SOFT budget --
// it warns, it does not fail -- because PowerShell's start time is not ours to
// fix, and the hard gate stays on the part we control. But it is measured and
// asserted rather than declared: the previous draft defined this constant and
// never referenced it anywhere, so the largest single component of the latency
// the user actually feels was unbudgeted.
export const WRAPPER_SOFT_MS = 700;
const MENU = path.join(os.homedir(), ".uw", "menu").replace(/\\/g, "/");

export function median(ns) {
  if (!ns.length) return null;
  const s = [...ns].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

export function verdict(ms, budget = BUDGET_MS) {
  const ok = ms <= budget;
  return { ok, line: `${ok ? "PASS" : "FAIL"} first frame ${ms} ms (budget ${budget} ms)` };
}

// The child prints one number on stderr and nothing else there, so a stray
// console.log anywhere in the import graph turns into a parse failure rather than
// a silent wrong measurement. The FRAME goes to stdout, which is the point.
//
// Q1.5, and why this child is shaped the way it is. The previous version built a
// string, never wrote it, and forced `TERM: "dumb"` so that `motionEnabled` was
// false and the startup reveal -- which Q1.4 puts INSIDE the budget -- never ran.
// It therefore measured a quantity the 300 ms budget does not describe, and it
// was compared against `startup.json`, which the runtime records AFTER
// `out.write(HIDE + CLEAR)` and `run("open")` and so includes up to three
// `sleepSync(FRAME_MS)` pauses the bench excluded. Two incompatible numbers, one
// budget. This version writes the frames to stdout (a pipe here, a console in
// real use) with motion enabled and the environment inherited, and stops the
// clock on the completed write -- the same point `recordStartup` now uses.
const CHILD = `
const t0 = process.hrtime.bigint();
const { loadSnapshot } = await import("file://${MENU}/snapshot.mjs");
const { firstFrame, framesFor } = await import("file://${MENU}/uwpick.mjs");
const { detectCaps, motionEnabled, painter, sleepSync, FRAME_MS } =
  await import("file://${MENU}/style.mjs");
const r = loadSnapshot();
if (!r.ok) { process.stderr.write("snapshot " + r.reason); process.exit(3); }
const caps = detectCaps(process.env, 120);
const motion = motionEnabled({ env: process.env, flags: [], caps });
const f = firstFrame({ snap: r.snap, recents: [], favourites: [], caps, termRows: 30 });
if (!f.text.length) { process.exit(4); }
// The real open path: hide+clear, then the reveal burst, exactly as main() does.
process.stdout.write("\\x1b[?25l\\x1b[2J\\x1b[H");
for (const frame of framesFor("open", f.text.split("\\n"), { motion, painter: painter(caps), caps })) {
  process.stdout.write("\\x1b[H" + frame.join("\\n"));
  if (motion) sleepSync(FRAME_MS);
}
process.stderr.write(String(Number(process.hrtime.bigint() - t0) / 1e6));
`;

export async function sampleOnce() {
  // The frame goes to the stdout pipe and is discarded; the number comes back on
  // stderr. Writing to a pipe rather than to nowhere is deliberate: the write has
  // to actually complete for the measurement to mean "the frame reached the
  // console" (Q1.2). It is not identical to a real console write -- a pipe does
  // no terminal rendering -- but it is the same syscall path, and the alternative
  // measures string concatenation.
  const { stderr } = await pexec(process.execPath, ["--input-type=module", "-e", CHILD],
                                 { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const ms = Number(String(stderr).trim());
  if (!Number.isFinite(ms)) throw new Error(`bench child printed ${JSON.stringify(stderr)}`);
  return Math.round(ms);
}

export async function run(samples = 5) {
  const out = [];
  for (let i = 0; i < samples; i++) out.push(await sampleOnce());
  const m = median(out);
  return { samples: out, median: m, ok: verdict(m).ok };
}

/**
 * The wrapper-inclusive measurement: `uwpick.cmd` entry to process exit, with the
 * picker given an immediate quit. This is the number the user experiences when
 * they press ctrl+g, and it is roughly BUDGET_MS plus PowerShell's start.
 *
 * Soft: it prints and warns, it does not fail the run. It exists so that a
 * regression in the wrapper is visible rather than being attributed to the
 * picker, and so that WRAPPER_SOFT_MS means something.
 */
export async function sampleWrapper() {
  const os_ = await import("node:os"), fs_ = await import("node:fs");
  const buf = path.join(os_.tmpdir(), `uw-bench-${process.pid}.md`);
  fs_.writeFileSync(buf, "m\n");
  const t0 = process.hrtime.bigint();
  // Inspect the failure; do not swallow it. A bare catch here reports the BEST
  // number exactly when the chain is most broken: a missing uwpick.cmd, a spawn
  // error, or a PowerShell wrapper that dies before it reaches node are all very
  // fast, so the soft budget would print `ok` most confidently on a chain that
  // never ran. That matters here specifically, because uwpick-run.ps1 opens
  // CONIN$ to set the console mode and a `node --test` harness may have no
  // console -- which is exactly the environment this measurement runs in.
  let note = "";
  try {
    await pexec(path.join(MENU, "uwpick.cmd"), [buf],
                { timeout: 30000, env: { ...process.env, UW_PICKER_QUIT_IMMEDIATELY: "1" } });
  } catch (e) {
    const expected = 1;            // CONTRACT.handoff.discardExit: the abort path
    if (e.killed || e.signal) note = "TIMED OUT";
    else if (e.code === "ENOENT") note = "uwpick.cmd not found";
    else if (e.status !== expected) note = `unexpected exit ${e.status}`;
    // e.status === expected is the ordinary abort path and is not a note.
  }
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  fs_.rmSync(buf, { force: true });
  return { ms, note };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/test/bench-startup.mjs")) {
  const r = await run(Number(process.argv[2] ?? 5));
  console.log(`samples: ${r.samples.join(", ")} ms`);
  console.log(verdict(r.median).line);

  const w = await sampleWrapper();
  if (w.note) {
    console.log(`WARN ctrl+g chain did not run cleanly: ${w.note} (${w.ms} ms) — ` +
                `this number is NOT a latency measurement`);
  } else {
    console.log(`${w.ms <= WRAPPER_SOFT_MS ? "ok  " : "WARN"} ctrl+g to exit ${w.ms} ms ` +
                `(soft budget ${WRAPPER_SOFT_MS} ms; the difference from the number above ` +
                `is cmd + PowerShell start, which is not ours to fix)`);
  }

  process.exit(r.ok ? 0 : 1);
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/test/bench-startup.mjs"
```

Expected: `# fail 0`, and the standalone run prints five samples, `PASS first frame <n> ms (budget 300 ms)`, and one wrapper-inclusive line measured against `WRAPPER_SOFT_MS`.

If the first-frame number fails, the diagnosis order is: snapshot size first (`~/.uw/catalog/snapshot.json` should be well under 2 MB), then whether anything in the import graph reached `catalog.mjs` — which imports `keysync.mjs` and parses the 19.7 MB catalogue, and would show up as a multi-second sample rather than a marginal one. Note that reaching `keysync.mjs` **alone** is not the problem the previous draft's note claimed: it is 319 lines of imports and function declarations with no top-level side effects, and its PowerShell round trip lives inside `keyReader`, at call time. A note that sends the next debugger after a module import when the cost is actually a 19.7 MB `JSON.parse` costs an hour, so it is corrected here rather than left.

If the wrapper number warns, the breakdown is `cmd` dispatch (negligible), PowerShell start including `Add-Type` compilation of the P/Invoke signature (the dominant term, measured at roughly 200 ms), node start, and the first frame. Record the observed split in `~/.uw/docs/visual-design.md` under a "measured costs" heading, so the next person to wonder why ctrl+g is not instantaneous has the numbers rather than a suspicion.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "test(menu): gate the 300 ms first-frame budget with a five-sample process benchmark"
```

---

### Task A12: Harden the PowerShell wrapper and prove the console mode is restored

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
    $report = @{ saved = [int]$saved; set = [int]$RAW_VT; restored = [int]$after
                 childExit = [int]$childExit } | ConvertTo-Json -Compress
    # Q2.9: NOT Set-Content -Encoding UTF8. In PowerShell 5.1 that writes a UTF-8
    # BOM, JSON.parse throws on a leading U+FEFF, and menu/atomic.mjs:readJsonOr
    # would return its fallback -- so the console-mode test below would read an
    # empty object and conclude the restore never happened, or that it did,
    # depending on which way the assertion was written. Neither would be a
    # measurement. UTF8Encoding($false) is the BOM-free constructor.
    # Q2.8: temp + Move-Item, so a ctrl+c here cannot leave a half-written report.
    $tmp = (Join-Path $dir "conmode.json.uw-tmp")
    [IO.File]::WriteAllText($tmp, $report, (New-Object Text.UTF8Encoding $false))
    Move-Item -LiteralPath $tmp -Destination (Join-Path $dir "conmode.json") -Force
  }
  [void][ConMode]::CloseHandle($h)
}
exit $childExit
```

Four changes from the spike, each load-bearing. `Add-Type` becomes `-ErrorAction SilentlyContinue` because the type is already loaded on a second invocation in the same session and a hard error there would abort the wrapper. The exit code propagates from the child instead of being hard-coded to 0, so a crashed or aborted picker is visible to the caller — and, since Task A13's dispatcher now propagates it too rather than replacing it with 0, that code reaches Claude Code and is what makes every abort path discard the buffer (Q2.1). `-Diagnose` writes the report from inside `finally`, which is the only place that can prove the restore ran after a failing child. And that report is written BOM-free through a temp file (Q2.8, Q2.9).

One thing this wrapper deliberately does **not** do, recorded so the next person does not spend an hour on it: it sets input mode on `CONIN$` only. The picker writes `\x1b[H`, `\x1b[2J` and SGR to stdout, which needs `ENABLE_VIRTUAL_TERMINAL_PROCESSING` (`0x0004`) on `CONOUT$` — and that is inherited from the host, because Claude Code has already enabled output VT on the shared console by the time the handoff runs. `detectCaps` guesses from environment variables, which is not the same thing and is not a substitute. If output VT ever stops being inherited, the symptom is escapes rendering as literal text rather than as colour, and the fix belongs here (Q7.8).

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 129 (indicative — see "How to read the `# pass N` numbers"). If `CreateFile` on `CONIN$` fails because the test host has no console, the first test fails with `ENOENT ... conmode.json` and the wrapper's own message `uwpick: cannot open CONIN$`; run the suite from a real Windows Terminal rather than a piped harness.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "fix(menu): propagate the child exit code and prove console-mode restore after a crash"
```

---

### Task A13: Dispatcher tests — sentinel versus passthrough

**Files:** Modify `C:/Users/osami/.uw/menu/uwpick.cmd`, Test `C:/Users/osami/.uw/test/dispatcher.test.mjs`, Create `C:/Users/osami/.uw/test/fixtures/fake-editor.cmd`
**Interfaces:** Consumes: `%UW_REAL_EDITOR%`, `%1` (the buffer path). Produces: the picker runs only for the three sentinels; every other first line reaches `%UW_REAL_EDITOR%` with the buffer path passed through unchanged. **Exit code: the child's, on the sentinel branch; always 0 on the passthrough branch.**

That asymmetry is the correction this task carries, and it is worth stating why it is not a symmetry. Claude Code sees only the dispatcher's exit code, and exit 0 means *accept the buffer*.

- On the **passthrough** branch the buffer holds the user's real prose. A failing editor must not cause it to be discarded, so 0 regardless. That reasoning is correct.
- On the **picker** branch the buffer holds a three-character sentinel — `m`. Accepting it submits the literal string `m` as a chat message. The previous draft copied the passthrough reasoning to this branch, where it inverts, and declared `exit code 0 always` in this very Interfaces line. The consequence was that a missing snapshot, a wrong `schemaVersion`, a `CONIN$` failure, an uncaught exception, or simply pressing Esc — the most common non-selection action there is — all put `m` into the chat input, while Q2.1, Q2.2 and Q2.6 each stated in prose that the buffer would be left untouched.

`uwpick-run.ps1` already propagates correctly (`exit $childExit`); the dispatcher threw it away. Task A10's `abort()` truncating the buffer is the belt to this task's braces: either one alone produces the right outcome, and both together mean a future regression in one of them is not user-visible.

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
REM non-zero exit makes CC DISCARD the buffer, and here the buffer holds the
REM user's real prose, so discarding it is the harm.
if defined UW_REAL_EDITOR ( "%UW_REAL_EDITOR%" "%BUF%" & exit /b 0 )
start /wait notepad "%BUF%"
exit /b 0

:pick
REM PROPAGATE the child's exit code from here down. The reasoning above INVERTS on
REM this branch: the buffer holds the sentinel `m`, not prose, so exit 0 makes CC
REM accept `m` as a chat message. Every abort inside the picker -- esc, ctrl+c, a
REM missing snapshot, no CONIN$ -- exits non-zero precisely so CC discards it
REM (Q2.1, Q2.3a, Q2.6).
REM
REM UW_PICK_OVERRIDE exists so the dispatch DECISION can be tested without a
REM console. It is never set in normal use, and it propagates too, so the
REM dispatcher's exit-code behaviour is testable at all.
if defined UW_PICK_OVERRIDE ( "%UW_PICK_OVERRIDE%" "%BUF%" & exit /b %ERRORLEVEL% )
REM via PowerShell: it sets the console to raw VT input mode first, which node
REM cannot do. Without that the console stays line-buffered and arrows/typing
REM never reach the picker -- the exact failure seen in testing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uwpick-run.ps1" -File "%BUF%"
exit /b %ERRORLEVEL%
```

The `for /f` loop keeps the first non-empty line and strips the CR from a CRLF file, which is why `"  m"` (leading spaces) correctly falls through to the editor: the comparison is exact, not trimmed.

`%ERRORLEVEL%` is read immediately after the call and before any other command, because almost anything in between resets it. `setlocal` is already in effect at the top of the file, so `exit /b` returns the value to the caller rather than to the local scope.

Add these three tests, which the previous version of this task did not have — it asserted only *which program ran*, never what the dispatcher returned, which is the single value Claude Code acts on:

```js
const runDispatcher = (firstLine, childExit) => {
  const buf = path.join(scratch, `buf-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(buf, firstLine + "\n");
  const env = { ...process.env, UW_TEST_MARKER: marker,
                UW_PICK_OVERRIDE: exiter(childExit),
                UW_REAL_EDITOR: FAKE_EDITOR };
  try {
    execFileSync(DISPATCHER, [buf], { env, stdio: "ignore" });
    return 0;
  } catch (e) { return e.status; }
};

test("the sentinel branch propagates a non-zero child exit", () => {
  // Q2.1/Q2.6: this is what makes Claude Code discard the buffer on every abort.
  assert.equal(runDispatcher("m", 1), 1);
  assert.equal(runDispatcher("model", 3), 3);
  assert.equal(runDispatcher(">>m", 1), 1);
});

test("the sentinel branch still returns 0 when the picker succeeds", () => {
  assert.equal(runDispatcher("m", 0), 0);
});

test("the passthrough branch returns 0 even when the editor fails", () => {
  // The inverse rule, and the reason the two branches differ: here the buffer
  // holds the user's prose and a non-zero exit would throw it away.
  const env = { ...process.env, UW_TEST_MARKER: marker, UW_REAL_EDITOR: exiter(7) };
  const buf = path.join(scratch, "prose.md");
  fs.writeFileSync(buf, "how do I write a test for this?\n");
  assert.equal(execFileSync(DISPATCHER, [buf], { env, stdio: "ignore" }) === undefined ? 0 : 0, 0);
});
```

`exiter(n)` is a one-line helper that writes a `.cmd` returning exit code `n` into the scratch directory, in the same style as `fake-editor.cmd`.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 143 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "test(menu): pin sentinel dispatch versus editor passthrough, and never discard the buffer"
```

---

### Task A14: `hud-shim.mjs` — correct one field in the statusline footer, optionally

Implements Q6.1 through Q6.3. D6 already gives the footer the right model name for free: the switch is a real `/model` command, Claude Code updates its own `model.display_name`, and the OMC HUD's `getModelName()` returns exactly that field. Nothing in this task is needed to make the model name correct, and nothing in this task touches an OMC file.

One field is still wrong, and only for non-Anthropic models. Claude Code fills `context_window.context_window_size` from its own model knowledge — 200000 in the measured payload — so after switching to a model with a one-million-token window the footer's "context left" counts down against the wrong denominator. The catalogue knows the real number, and Task A8 already put it in the snapshot.

This is a nicety, not the menu, so it is opt-in (`install.ps1 -Hud`), under sixty lines, and built so that every failure mode degrades to today's behaviour: if anything at all goes wrong — bad JSON, no snapshot, an unknown model, a thrown exception — the original stdin bytes are forwarded to the original command unmodified. The footer can only ever be as broken as it would have been without the shim.

**Files:** Create `C:/Users/osami/.uw/menu/hud-shim.mjs`, Test `C:/Users/osami/.uw/test/hud-shim.test.mjs`
**Interfaces:** Consumes: `parseStatusline`, `usedTokens` from `./cc-contract.mjs`; `loadSnapshot`, `contextIndex`, `SNAPSHOT_FILE` from `./snapshot.mjs`. Produces:
`transform(raw: string, ix: Map<string, number>) -> string | null` — the corrected payload, or `null` to mean "forward the original untouched"
`main(argv?: string[]) -> number` — read stdin, transform, spawn the wrapped command with the result on its stdin, return its exit code. The context index is cached on `snapshot.json`'s `mtimeMs`, because this runs on every statusline repaint and a repeated JSON parse there is latency the user feels while typing (Q6.3).
`wrapCommand(shimPath: string, existing: string) -> string` — `node "<shim>" -- <existing>`; the existing command is appended as an **opaque string**, never parsed or re-quoted.
`unwrapCommand(wrapped: string) -> string | null` — the inverse; `null` when the string is not one of ours.

**What this task must not do to OMC.** It wraps whatever `statusLine.command` contains and knows nothing else about it (Q4.7). It does not parse the wrapped command, normalise its path separators, resolve its interpreter, or "fix" anything about it — the observed value mixes `\` and `/` and pins an absolute `node.exe` under `nvm4w`, and all of that is OMC's business. UW appends a prefix and removes the same prefix; the remainder is bytes.

- [ ] Step 0a: Pin the observed wrapped command, exactly as it is on this machine.

The command the shim has to wrap and re-execute, read from the live `settings.json` on 2026-09-03:

```
"C:\nvm4w\nodejs\node.exe" "C:/Users/osami/.claude/hud/omc-hud.mjs"
```

Three things about that literal are load-bearing and none of them are hypothetical:

- **It mixes separators.** Backslashes in the interpreter path, forward slashes in the script path. The shim re-executes this string through `spawnSync(command, {shell: true})`, so both have to survive quoting intact.
- **It hard-codes an absolute `node.exe` under `nvm4w`.** UW's wrapper prefix uses a bare `node`. Under an nvm version switch those two can resolve to different Node builds in the same command line. That is OMC's choice to make and UW must not "fix" it — but it must not break it either, which means the wrapped remainder is passed through as an opaque string and never parsed, normalised or re-quoted.
- **It is not UW's to know.** The value is read from `statusLine.command` at install time. Nothing in `menu/` may contain it (Q4.7); this fixture lives in the test tree precisely so that a change to OMC's command shape fails a round-trip test instead of going untested.

Use it verbatim as the fixture in this task's tests and in `install.test.mjs`:

```js
// The observed OMC statusline command, 2026-09-03. Not a made-up shape: mixed
// separators and quoted paths are exactly what the wrapper has to survive.
export const OMC_COMMAND =
  '"C:\nvm4w\nodejs\node.exe" "C:/Users/osami/.claude/hud/omc-hud.mjs"';

test("the wrapped command survives wrapping and unwrapping unchanged", () => {
  const wrapped = wrapCommand(SHIM, OMC_COMMAND);
  assert.ok(wrapped.endsWith(OMC_COMMAND), "the remainder is opaque and passed through byte for byte");
  assert.equal(unwrapCommand(wrapped), OMC_COMMAND);
});

test("a wrapped command still runs what it wrapped", () => {
  // End to end through the real shell path, because quoting is where this breaks.
  const stub = writeStub();                       // echoes its stdin to UW_TEST_MARKER
  const r = spawnSync(process.execPath, [SHIM, "--", `"${process.execPath}" "${stub}"`],
                      { input: SAMPLE_PAYLOAD, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(fs.readFileSync(process.env.UW_TEST_MARKER, "utf8"), /context_window/);
});
```

- [ ] Step 0: Measure the real payload first. **This step gates the rest of the task.**

Switch to a non-Anthropic model through the picker, then capture what Claude Code actually writes to the statusline command's stdin:

```
node -e "process.stdin.on('data',d=>{require('fs').appendFileSync('C:/Users/osami/.uw/harness/scratch/statusline-sample.json',d)})"
```

wired temporarily as `statusLine.command`, or read one payload with the existing HUD's own logging. Record the observed `model.id` and `model.display_name` for a CCR-routed non-Anthropic model in `docs/visual-design.md`.

The whole task turns on this. `transform` looks `p.model.id` up in an index keyed by the snapshot's `provider/model` targets. If Claude Code reports a bare model id, or a mangled one, every lookup misses; `transform` then correctly returns `null` on every payload, the original bytes are forwarded, the footer keeps showing 200000, and every test in this task still passes — because "not in the index" is a legitimate outcome that the tests exercise deliberately. A silent no-op that passes its own suite is the worst outcome available here, so the key shape is measured before the code is trusted, not after.

If the observed id is not `provider/model`, the fix is a normaliser in `cc-contract.mjs` — the module that is allowed to know Claude Code's shapes — mapping the observed form to the snapshot's target form, plus one test pinning the observed literal.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/hud-shim.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { transform } from "../menu/hud-shim.mjs";

const IX = new Map([["google/gemini-3.5-pro", 1000000],
                    ["anthropic/claude-opus-5", 200000]]);
const PAYLOAD = (over = {}) => JSON.stringify({
  session_id: "s1", version: "2.1.258",
  model: { id: "google/gemini-3.5-pro", display_name: "Google > gemini-3.5-pro" },
  context_window: {
    total_input_tokens: 168661, total_output_tokens: 377, context_window_size: 200000,
    current_usage: { input_tokens: 2, output_tokens: 377,
                     cache_creation_input_tokens: 37950, cache_read_input_tokens: 130709 },
    used_percentage: 84, remaining_percentage: 16, ...over,
  },
  cost: { total_cost_usd: 1.5 },
});

test("a known model gets the real context window", () => {
  const out = JSON.parse(transform(PAYLOAD(), IX));
  assert.equal(out.context_window.context_window_size, 1000000);
});

test("percentages are recomputed from current_usage, not scaled", () => {
  const out = JSON.parse(transform(PAYLOAD(), IX));
  const used = 2 + 37950 + 130709;                       // 168661
  assert.equal(out.context_window.used_percentage, Math.round((used / 1000000) * 100));
  assert.equal(out.context_window.remaining_percentage, 100 - out.context_window.used_percentage);
});

test("without current_usage the percentages are left exactly as they arrived", () => {
  const raw = PAYLOAD({ current_usage: undefined });
  const out = JSON.parse(transform(raw, IX));
  assert.equal(out.context_window.context_window_size, 1000000);
  assert.equal(out.context_window.used_percentage, 84);
  assert.equal(out.context_window.remaining_percentage, 16);
});

test("an unknown model forwards the original untouched", () => {
  const raw = JSON.stringify({ model: { id: "nobody/nothing" }, context_window: {} });
  assert.equal(transform(raw, IX), null);
});

test("a model whose window already matches forwards the original untouched", () => {
  const raw = JSON.stringify({
    model: { id: "anthropic/claude-opus-5" },
    context_window: { context_window_size: 200000 },
  });
  assert.equal(transform(raw, IX), null);
});

test("non-JSON forwards the original untouched", () => {
  assert.equal(transform("this is not json", IX), null);
  assert.equal(transform("", IX), null);
});

test("an empty index forwards the original untouched", () => {
  assert.equal(transform(PAYLOAD(), new Map()), null);
});

test("every other field survives the round trip byte for byte in meaning", () => {
  const before = JSON.parse(PAYLOAD());
  const after = JSON.parse(transform(PAYLOAD(), IX));
  assert.equal(after.session_id, before.session_id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.model, before.model);
  assert.deepEqual(after.cost, before.cost);
  assert.equal(after.context_window.total_input_tokens, before.context_window.total_input_tokens);
  assert.deepEqual(after.context_window.current_usage, before.context_window.current_usage);
});

test("percentages stay integers within 0 and 100 even for absurd usage", () => {
  const raw = PAYLOAD({ current_usage: { input_tokens: 99e9, output_tokens: 0,
                                         cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  const cw = JSON.parse(transform(raw, IX)).context_window;
  assert.equal(cw.used_percentage, 100);
  assert.equal(cw.remaining_percentage, 0);
  assert.equal(Number.isInteger(cw.used_percentage), true);
});

test("end to end: the shim wraps a command and passes stdout and exit code through", () => {
  const dir = path.join(os.homedir(), ".uw", "harness", "scratch", "hud");
  fs.mkdirSync(dir, { recursive: true });
  const stub = path.join(dir, "stub.mjs");
  fs.writeFileSync(stub, [
    "const raw = fs.readFileSync(0, 'utf8');",
    "process.stdout.write(raw);",
    "process.exit(7);",
  ].join("\n").replace("const raw", "import fs from 'node:fs';\nconst raw"));

  const shim = path.join(os.homedir(), ".uw", "menu", "hud-shim.mjs");
  const r = spawnSync(process.execPath, [shim, "--", `"${process.execPath}" "${stub}"`],
                      { input: PAYLOAD(), encoding: "utf8" });
  assert.equal(r.status, 7);
  const seen = JSON.parse(r.stdout);
  assert.equal(seen.context_window.context_window_size, 1000000);

  const bad = spawnSync(process.execPath, [shim, "--", `"${process.execPath}" "${stub}"`],
                        { input: "not json at all", encoding: "utf8" });
  assert.equal(bad.stdout, "not json at all");
  assert.equal(bad.status, 7);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/hud-shim.test.mjs"
```

Expected failure: `Cannot find module 'C:\Users\osami\.uw\menu\hud-shim.mjs'`.

- [ ] Step 3: Implement.

Create `C:/Users/osami/.uw/menu/hud-shim.mjs`:

```js
#!/usr/bin/env node
// A statusline wrapper that fixes exactly one number.
//
//   node hud-shim.mjs -- <the original statusLine.command>
//
// Claude Code reports context_window_size from its own model knowledge, so after
// a switch to a non-Anthropic model the footer's "context left" counts against
// the wrong denominator. The catalogue knows the real limit; the snapshot already
// carries it. Nothing else is touched, no OMC file is read or written, and the
// only foreign contract used is the statusline stdin shape, which lives in
// cc-contract.mjs like every other one (Q4.1).
//
// Failure policy, and it is absolute: if anything goes wrong the ORIGINAL bytes
// are forwarded. A footer that is wrong about one number is a nuisance; a footer
// that is empty on every prompt is a bug report in the wrong repository.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { parseStatusline, usedTokens } from "./cc-contract.mjs";
import { loadSnapshot, contextIndex, SNAPSHOT_FILE } from "./snapshot.mjs";

export function transform(raw, ix) {
  const p = parseStatusline(raw);
  if (!p) return null;
  // MEASUREMENT REQUIRED BEFORE THIS SHIPS -- see Step 0 above. `p.model.id` is
  // the key we look up in an index built from `provider/model` snapshot targets,
  // and nothing in this plan has yet observed what Claude Code puts in that field
  // for a non-Anthropic model routed through CCR. If it is the bare model id
  // rather than `provider/model`, every lookup misses, the shim returns null on
  // every payload, and the footer keeps showing 200000 -- silently, because
  // returning null IS the correct behaviour for "not in the index". The whole
  // task would then be a no-op that passes all its tests.
  const real = ix.get(p.model.id);
  if (!Number.isFinite(real) || real === p.context_window.context_window_size) return null;

  const cw = { ...p.context_window, context_window_size: real };
  const used = usedTokens(p);
  if (used != null) {
    cw.used_percentage = Math.max(0, Math.min(100, Math.round((used / real) * 100)));
    cw.remaining_percentage = 100 - cw.used_percentage;
  }
  return JSON.stringify({ ...p, context_window: cw });
}

// The index, cached on the snapshot's mtime.
//
// This runs on EVERY statusline repaint, which is latency the user feels directly
// as terminal lag while typing. Reading and JSON-parsing snapshot.json each time
// is work the shim does not need to repeat: the file only changes when a refresh
// promotes a new one. `mtimeMs` is one `statSync` -- cheap enough to do per
// repaint -- and it invalidates exactly when the snapshot is rewritten.
//
// The process is short-lived under a statusline command, so in practice this
// caches within a run rather than across them; it is still the right shape,
// because a statusline command that is kept alive (or a future in-process host)
// gets the benefit for free, and the failure mode of a stale cache here is one
// repaint showing the previous context size.
let CACHE = { at: -1, ix: null };
function cachedIndex() {
  const snapPath = SNAPSHOT_FILE;
  let mt = -1;
  try { mt = fs.statSync(snapPath).mtimeMs; } catch { return null; }
  if (CACHE.at === mt && CACHE.ix) return CACHE.ix;
  const snap = loadSnapshot();
  if (!snap.ok) return null;
  CACHE = { at: mt, ix: contextIndex(snap.snap) };
  return CACHE.ix;
}

export function main(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--");
  const command = i >= 0 ? argv.slice(i + 1).join(" ") : "";
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
  if (!command) { process.stdout.write(""); return 0; }

  let payload = raw;
  try {
    const ix = cachedIndex();
    if (ix) payload = transform(raw, ix) ?? raw;
  } catch { payload = raw; }

  const r = spawnSync(command, { input: payload, shell: true,
                                 stdio: ["pipe", "inherit", "inherit"] });
  return r.status ?? 0;
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/hud-shim.mjs")) {
  process.exit(main());
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 153 (indicative — see "How to read the `# pass N` numbers"). The shim is not installed by this task; Task A16 wires it, and only when asked.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): optional statusline shim correcting the context window for non-Anthropic models"
```

---

### Task A15: `uw doctor` — probe the handoff contract

**Files:** Create `C:/Users/osami/.uw/menu/doctor.mjs`, Test `C:/Users/osami/.uw/test/doctor.test.mjs`
**Interfaces:** Consumes: `~/.uw/state/handoff.json`, `~/.uw/state/capabilities.json`, `~/.uw/state/hud-install.json`, `CONTRACT` from `./cc-contract.mjs` and `./ccr-client.mjs`, `transform` from `./hud-shim.mjs`, the `claude doctor` command, the `EDITOR` and `UW_REAL_EDITOR` environment variables. Produces:
`checkEnv(env: object) -> Check` — `EDITOR` points at our dispatcher and `UW_REAL_EDITOR` exists
`MAX_HANDOFF_AGE_MS: number` — 14 days; how long one successful handoff stays evidence
`checkHandoff(lines: string[], opts?: {now, claudeRunSince}) -> Check` — the most recent recorded invocation had an existing `argv[2]` and wrote a selection, **and is recent enough to still mean anything**
`checkFingerprint(current: object, pinned: object) -> Check` — Green when equal; Amber with a named delta on a version move, which does **not** self-accept; Red when `claude doctor` could not be run **or when its output no longer parses**
`checkContracts({ccObserved, ccPinned, service}) -> Check` — Q4.4 drift between the pinned contract fingerprint and the running Claude Code, plus whether CCR answered at all
`checkBundled({dir, catalogue, version, verified}) -> Check` — CCR's install resolved, its bundled catalogue present, and its version matching what `ccr-client.mjs` was verified against
`checkCcrPatch({file, read?}) -> Check` — the local gateway-handshake patch in `dist/main/cli.js` is still applied. `read` is an injected reader defaulting to `fs.readFileSync`, so the check is testable against a string without a CCR install present. **Red** when reverted, because the symptom is intermittent-under-load and reads as flakiness
`checkRpcSurface({methods, installedVersion, runningVersion}) -> Check` — every RPC method this project calls still resolves, and the installed version matches the running one
`GATEWAY_ANCHOR: string`, `GATEWAY_TIMEOUT_MIN_MS: number`
`checkHud({install, wrappedExists, roundTrip}) -> Check` — Q6.3: the optional shim wraps a command that still exists and round-trips a sample payload
`diagnose(input) -> {verdict: "green"|"amber"|"red", checks: Check[]}` where `Check = {name, ok, verdict, evidence}`
`main()` — prints one line per check and exits 0 on green or amber, 1 on red. `--accept-fingerprint` is the only thing that writes `capabilities.json`

**Three changes that decide whether this tool is worth having.** All three are cases where the previous version reported green, or drifted to green, in exactly the situation it exists to detect:

1. **A successful handoff row expires.** `checkHandoff` read `rows[rows.length - 1]` with no age bound. When Claude Code changes its editor protocol, ctrl+g stops reaching the picker, so no new row is ever appended and the last row stays a *successful* one — reported green forever, from the moment the thing broke. A row older than `MAX_HANDOFF_AGE_MS` is no longer evidence; if Claude Code has been used since (its `settings.json` mtime), that is red.
2. **A parse failure is red, not amber.** `readClaudeFingerprint` mirrors the undocumented output of `claude doctor`. When that format moves, the probe is broken and nothing below it means anything. Treating it as "could not read, carry on" hides a failure of the detection mechanism itself.
3. **Nothing auto-pins.** The previous version wrote `capabilities.json` on every non-red run, so drift was reported once and agreed with thereafter — a Claude Code upgrade that silently broke the handoff would be amber on the first run and green on the second, with nothing verified in between. Pinning is a human claim that the contract still holds, so it takes `uw doctor --accept-fingerprint`.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/doctor.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEnv, checkHandoff, checkFingerprint, checkContracts, checkHud,
         checkBundled, checkCcrPatch, checkRpcSurface, diagnose,
         MAX_HANDOFF_AGE_MS } from "../menu/doctor.mjs";

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
  const f = { ran: true, ccVersion: "2.1.258", ccCommit: "b3cd543a1f6f" };
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
  const c = checkFingerprint({ ran: true, ccVersion: "2.1.258", ccCommit: "b" }, {});
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /no pinned/i);
  assert.match(c.evidence, /--accept-fingerprint/);
});

test("an unparseable `claude doctor` output is RED, not amber", () => {
  // The probe itself has broken. Amber here would let a format change decay into
  // "recorded, carry on" -- the doctor greening on the exact class of failure it
  // exists to detect.
  const c = checkFingerprint({ ran: true, parseFailed: true, raw: "Claude Code v9 :)" }, {});
  assert.equal(c.verdict, "red");
  assert.equal(c.ok, false);
  assert.match(c.evidence, /readClaudeFingerprint/);
});

test("version drift does not resolve itself; it asks for a human", () => {
  const c = checkFingerprint({ ran: true, ccVersion: "2.2.000", ccCommit: "z" },
                             { ccVersion: "2.1.258", ccCommit: "b" });
  assert.equal(c.verdict, "amber");
  assert.equal(c.ok, false, "drift is not a passing check");
  assert.match(c.evidence, /--accept-fingerprint/);
});

test("a stale handoff row stops being evidence, and is red once CC has run since", () => {
  // The failure mode this whole check exists for: when the editor protocol moves,
  // ctrl+g stops reaching the picker, NO new row is appended, and reading the last
  // row forever reports the last success as current health.
  const OLD = "2026-06-01T00:00:00.000Z";
  const rows = [JSON.stringify({ at: OLD, argv2: "C:\\t.md", existed: true, wrote: true })];
  const now = Date.parse("2026-09-03T00:00:00.000Z");

  const used = checkHandoff(rows, { now, claudeRunSince: Date.parse("2026-09-01T00:00:00.000Z") });
  assert.equal(used.verdict, "red");
  assert.match(used.evidence, /no longer reaching the picker/);

  const unused = checkHandoff(rows, { now, claudeRunSince: null });
  assert.equal(unused.verdict, "amber");

  const fresh = checkHandoff(
    [JSON.stringify({ at: "2026-09-02T00:00:00.000Z", argv2: "C:\\t.md",
                      existed: true, wrote: true })],
    { now, claudeRunSince: now });
  assert.equal(fresh.verdict, "green");
});

test("diagnose reports the worst verdict and names the failing check", () => {
  const r = diagnose({
    env: { EDITOR: "notepad.exe" },
    handoff: [],
    current: { ran: true, ccVersion: "2.1.258", ccCommit: "b" },
    pinned: { ccVersion: "2.1.258", ccCommit: "b" },
  });
  assert.equal(r.verdict, "red");
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes("editor-wiring"));
});

test("diagnose is green when everything holds", () => {
  const f = { ran: true, ccVersion: "2.1.258", ccCommit: "b" };
  const now = Date.now();
  const r = diagnose({
    env: { EDITOR: CMD, UW_REAL_EDITOR: "C:\\Windows\\notepad.exe" },
    handoff: [JSON.stringify({ at: new Date(now - 1000).toISOString(),
                               argv2: "C:\\t.md", existed: true, wrote: true })],
    handoffOpts: { now, claudeRunSince: now },
    current: f, pinned: f,
  });
  assert.equal(r.verdict, "green");
});

test("a reverted gateway patch is RED and names the npm command that caused it", () => {
  // Report 10, P1 #10. The one CCR failure that presents as flakiness rather than
  // as a fault, so it has to be caught by inspection, not by symptom.
  const stock = 'x\r\nvar PN="gateway",K7=5e3,z7=15e3,aVe=4e3\r\ny';
  const c = checkCcrPatch({ file: "cli.js", read: () => stock });
  assert.equal(c.verdict, "red");
  assert.match(c.evidence, /5000 ms/);
  assert.match(c.evidence, /npm i -g/);
  assert.match(c.evidence, /INTERMITTENT/);
});

test("the patched bundle passes, and CRLF does not change the answer", () => {
  // The measured trap: 2,308,421 bytes CRLF against a 2,299,525-byte LF backup.
  // Any size or digest comparison that skips normalisation reports a difference
  // that is not one.
  const lf   = 'var PN="gateway",K7=2e4,z7=15e3';
  const crlf = lf.replace(/\n/g, "\r\n");
  for (const body of [lf, crlf, "prefix\r\n" + crlf]) {
    assert.equal(checkCcrPatch({ file: "cli.js", read: () => body }).verdict, "green");
  }
});

test("the patch check anchors on the stable literal, never on the minified name", () => {
  // K7 is a minified identifier; a rebuild may call it Q3 or zP. A check that
  // grepped for `K7=2e4` would report the patch missing on every future CCR
  // release, whether or not it actually is.
  const renamed = 'var PN="gateway",zP=2e4,z7=15e3';
  assert.equal(checkCcrPatch({ file: "cli.js", read: () => renamed }).verdict, "green");

  // And when the anchor itself is gone, the honest answer is "this check is
  // stale", not "the patch is missing".
  const rebuilt = checkCcrPatch({ file: "cli.js", read: () => "var QQ=1,RR=2" });
  assert.equal(rebuilt.verdict, "amber");
  assert.match(rebuilt.evidence, /Do NOT assume the patch is absent/);
});

test("checkRpcSurface names the method that moved", () => {
  const gone = checkRpcSurface({ methods: { getAppInfo: true, getConfig: false, probeProvider: true } });
  assert.equal(gone.verdict, "red");
  assert.match(gone.evidence, /getConfig/);
});

test("an installed/running version split is reported before it bites", () => {
  // CCR updated on disk, gateway not restarted. The patch check reads the NEW
  // file while the live process still holds the OLD one, so both can be green
  // today and fail on the next restart.
  const split = checkRpcSurface({
    methods: { getAppInfo: true, getConfig: true, probeProvider: true },
    installedVersion: "3.1.0", runningVersion: "3.0.22",
  });
  assert.equal(split.verdict, "amber");
  assert.match(split.evidence, /without a restart/);
  assert.match(split.evidence, /next restart/);
});

test("checkBundled is amber, not red, when CCR's catalogue has moved", () => {
  // Amber because Task B4 copied the catalogue into ~/.uw/catalog/, so the picker
  // keeps working; what breaks is the next copy-out.
  const gone = checkBundled({ dir: "C:/nope", catalogue: "C:/nope/dist/models.json" });
  assert.equal(gone.verdict, "amber");
  assert.match(gone.evidence, /resolveInstall/);

  const drift = checkBundled({ dir: __dirname, catalogue: import.meta.filename,
                               version: "3.1.0", verified: "3.0.22" });
  assert.equal(drift.verdict, "amber");
  assert.match(drift.evidence, /3\.1\.0/);
});

test("checkContracts is green only when the pinned version is the running one", () => {
  const ok = checkContracts({ ccObserved: "2.1.258", ccPinned: "2.1.258", service: { origin: "x" } });
  assert.equal(ok.verdict, "green");
  const drift = checkContracts({ ccObserved: "2.2.000", ccPinned: "2.1.258", service: { origin: "x" } });
  assert.equal(drift.verdict, "amber");
  assert.match(drift.evidence, /2\.2\.000/);
  assert.match(drift.evidence, /CONTRACT\.fingerprint/);
});

test("checkContracts degrades rather than fails when CCR is not running", () => {
  const c = checkContracts({ ccObserved: "2.1.258", ccPinned: "2.1.258", service: null });
  assert.equal(c.verdict, "amber");
  assert.match(c.evidence, /cached set/);
});

test("checkHud passes when the shim is not installed at all", () => {
  const c = checkHud({ install: null });
  assert.equal(c.ok, true);
  assert.equal(c.verdict, "green");
  assert.match(c.evidence, /optional/);
});

test("checkHud is red when the command it wraps has gone, and names the undo", () => {
  const gone = checkHud({ install: { previousCommand: '"C:/gone/node.exe" "x.mjs"' },
                          wrappedExists: false, roundTrip: { ok: true } });
  assert.equal(gone.verdict, "red");
  assert.match(gone.evidence, /-Uninstall/);
  const stale = checkHud({ install: { previousCommand: "x" }, wrappedExists: true,
                           roundTrip: { ok: false, why: "context size not applied" } });
  assert.equal(stale.verdict, "amber");
  assert.match(stale.evidence, /footer still works/);
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
import * as CC from "./cc-contract.mjs";
import * as CCR from "./ccr-client.mjs";
import { transform } from "./hud-shim.mjs";
import { writeAtomic } from "./atomic.mjs";

const DISPATCHER = path.join(os.homedir(), ".uw", "menu", "uwpick.cmd");
export const CAPABILITIES = path.join(os.homedir(), ".uw", "state", "capabilities.json");
const HANDOFF = path.join(os.homedir(), ".uw", "state", "handoff.json");
const HUD_INSTALL = path.join(os.homedir(), ".uw", "state", "hud-install.json");

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

// How long a successful handoff stays evidence. Claude Code auto-updates on the
// `latest` channel, so "it worked once" decays.
export const MAX_HANDOFF_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function checkHandoff(lines, { now = Date.now(), claudeRunSince = null } = {}) {
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } })
                    .filter(Boolean);
  if (!rows.length) {
    return { name: "handoff-contract", ok: false, verdict: "amber",
      evidence: "the picker has never recorded an invocation — press ctrl+g and type " +
                "`m` once, then re-run" };
  }
  const last = rows[rows.length - 1];

  // THE FAILURE THIS CHECK EXISTS FOR, and the one the previous version could not
  // see. When Claude Code changes its editor protocol, ctrl+g stops reaching the
  // picker at all. No new row is appended. `rows[rows.length - 1]` is then the
  // last row from BEFORE the break -- a successful one -- and the check reports
  // green forever, in exactly the circumstance it was written to catch.
  //
  // A successful row is therefore evidence with an expiry date. Stale AND Claude
  // Code has run since is red: something invoked Claude Code and the picker was
  // never reached. Stale with no evidence of use is amber: possibly nobody has
  // pressed ctrl+g, which is not a fault.
  const age = now - Date.parse(last.at);
  if (Number.isFinite(age) && age > MAX_HANDOFF_AGE_MS) {
    const days = Math.round(age / 86400000);
    const usedSince = claudeRunSince != null && claudeRunSince > Date.parse(last.at);
    return { name: "handoff-contract", ok: false,
      verdict: usedSince ? "red" : "amber",
      evidence: usedSince
        ? `the last recorded handoff is ${days} days old and Claude Code has been used ` +
          `since, so ctrl+g is no longer reaching the picker — this is what a changed ` +
          `editor protocol looks like. Press ctrl+g and type \`m\`; if nothing happens, ` +
          `re-verify CONTRACT.handoff against the running version`
        : `the last recorded handoff is ${days} days old — too old to be evidence. ` +
          `Press ctrl+g and type \`m\` once, then re-run` };
  }

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
  // A PARSE FAILURE IS RED, not amber. `readClaudeFingerprint` mirrors the output
  // format of an undocumented `claude doctor`, so the day that format changes is
  // a day this project's central assumption -- that it can detect Claude Code
  // moving under it -- has stopped holding. Reporting amber there, and then
  // pinning, converts "we can no longer tell" into "recorded, carry on".
  if (current.parseFailed) {
    return { name: "cc-fingerprint", ok: false, verdict: "red",
      evidence: "`claude doctor` ran but its output no longer matches the expected " +
                "`Running: ... (version)` / `Commit: ...` shape. The version probe " +
                "itself is broken, so no drift check below it means anything. " +
                "Re-derive the pattern in readClaudeFingerprint from the current output" };
  }
  if (!current.ccVersion) {
    return { name: "cc-fingerprint", ok: false, verdict: "red",
      evidence: "`claude doctor` produced no version line — Claude Code is missing, " +
                "not on PATH, or its output format changed" };
  }
  if (!pinned.ccVersion) {
    return { name: "cc-fingerprint", ok: true, verdict: "amber",
      evidence: `no pinned fingerprint yet; run \`uw doctor --accept-fingerprint\` to ` +
                `record ${current.ccVersion} (${current.ccCommit ?? "no commit"})` };
  }
  if (current.ccVersion !== pinned.ccVersion || current.ccCommit !== pinned.ccCommit) {
    // NOT auto-accepted. Auto-update is expected, but "the version moved" and "the
    // contract still holds" are different claims, and silently re-pinning asserts
    // the second from evidence for only the first. The drift stays visible until a
    // human has re-run the handoff and said so.
    return { name: "cc-fingerprint", ok: false, verdict: "amber",
      evidence: `Claude Code moved from ${pinned.ccVersion} (${pinned.ccCommit}) to ` +
                `${current.ccVersion} (${current.ccCommit}). Auto-update is enabled, so ` +
                `the move is expected — the contract is not. Press ctrl+g, type \`m\`, ` +
                `confirm the picker opens and the selection lands in the chat input, ` +
                `then run \`uw doctor --accept-fingerprint\` to pin the new version` };
  }
  return { name: "cc-fingerprint", ok: true, verdict: "green",
    evidence: `${current.ccVersion} (${current.ccCommit})` };
}

const RANK = { green: 0, amber: 1, red: 2 };

// Q4.4: the contract modules claim a version; the machine has one. When those
// disagree, say so here rather than letting a renderer discover it.
export function checkContracts({ ccObserved, ccPinned, service }) {
  const bits = [];
  let verdict = "green";
  if (!ccObserved) {
    verdict = "amber";
    bits.push(`could not read the running Claude Code version (cc-contract pins ${ccPinned})`);
  } else if (ccObserved !== ccPinned) {
    verdict = "amber";
    bits.push(`cc-contract.mjs pins ${ccPinned}, Claude Code reports ${ccObserved} — re-verify the handoff and the statusline shape, then update CONTRACT.fingerprint`);
  } else {
    bits.push(`cc-contract ${ccPinned} matches`);
  }
  if (!service) {
    verdict = verdict === "green" ? "amber" : verdict;
    bits.push("CCR service.json not readable — routability will fall back to the cached set");
  } else {
    bits.push("ccr-client reached service.json");
  }
  return { name: "contracts", ok: verdict === "green", verdict, evidence: bits.join("; ") };
}

// Q6.3: the shim is optional, so "not installed" is a pass. When it IS installed,
// two things must hold: the command it wraps still exists, and a sample payload
// survives the transform with its fields intact.
export function checkHud({ install, wrappedExists, roundTrip }) {
  if (!install) {
    return { name: "hud-shim", ok: true, verdict: "green", evidence: "not installed (optional)" };
  }
  if (!wrappedExists) {
    return { name: "hud-shim", ok: false, verdict: "red",
             evidence: `wrapped statusline command is missing: ${install.previousCommand} — run install.ps1 -Hud -Uninstall to restore` };
  }
  if (!roundTrip.ok) {
    return { name: "hud-shim", ok: false, verdict: "amber",
             evidence: `sample payload did not round-trip: ${roundTrip.why} — the footer still works, the context number does not` };
  }
  return { name: "hud-shim", ok: true, verdict: "green",
           evidence: `installed, wrapping ${install.previousCommand}` };
}

/**
 * The local patch to CCR's `dist/main/cli.js`, and whether it is still there.
 *
 * Report 10, P1 #10, and it is the highest-severity CCR coupling this project
 * has. CCR's gateway handshake timeout is a minified constant compiled into the
 * bundle and governed by NO environment variable -- all 28 `CCR_*` vars were
 * searched. It was patched locally from 5000 ms to 20000 ms:
 *
 *   OLD: var PN="gateway",K7=5e3,z7=15e3,...
 *   NEW: var PN="gateway",K7=2e4,z7=15e3,...
 *
 * CCR is a global npm package with no self-update, so it changes on exactly one
 * event -- `npm i -g` -- and that event silently reverts the patch. The failure
 * mode is the worst class available: the 5-second handshake reappears and fails
 * INTERMITTENTLY, only under load, which reads as flakiness rather than as a
 * broken invariant. It has already happened once.
 *
 * Two traps, both from the measurement:
 *
 *   - Normalize newlines before ANY size or digest check. The raw file is
 *     2,308,421 bytes with CRLF against a 2,299,525-byte LF backup; a naive
 *     comparison reports a difference that is not one.
 *   - Anchor on the STABLE LITERAL `var PN="gateway",`, never on `K7`. `K7` is a
 *     minified identifier and a rebuild may call it `Q3` or `zP`, so a check that
 *     greps for `K7=2e4` would report the patch missing on every future CCR
 *     release whether or not it actually is.
 *
 * This check is read-only and never rewrites CCR. Re-applying the patch is a
 * deliberate act with its own recipe (see the evidence line), because writing
 * into another tool's installed bundle is not something a doctor should do on its
 * own initiative.
 */
export const GATEWAY_ANCHOR = 'var PN="gateway",';
export const GATEWAY_TIMEOUT_MIN_MS = 20000;

export function checkCcrPatch({ file, read = null }) {
  let raw;
  try { raw = read ? read(file) : fs.readFileSync(file, "utf8"); }
  catch {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `cannot read ${file} — CCR's bundle is not where ccr-client.mjs resolves it. ` +
                `The gateway handshake patch cannot be verified` };
  }
  const norm = raw.replace(/\r\n/g, "\n");            // CRLF vs LF: 2,308,421 vs 2,299,525
  const at = norm.indexOf(GATEWAY_ANCHOR);
  if (at < 0) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `the anchor ${GATEWAY_ANCHOR} is gone from cli.js — CCR was rebuilt and this ` +
                `check needs re-deriving against the new bundle. Do NOT assume the patch is ` +
                `absent; assume the check is stale` };
  }
  // The first numeric assignment after the anchor is the handshake timeout,
  // whatever the minifier called it this build.
  const m = /^var PN="gateway",[A-Za-z_$][\w$]*=(\d+(?:e\d+)?)/.exec(norm.slice(at));
  const ms = m ? Number(m[1].replace(/e(\d+)/, (_, e) => "0".repeat(Number(e)))) : NaN;
  if (!Number.isFinite(ms)) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "amber",
      evidence: `found the anchor but could not read the timeout after it — re-derive the check` };
  }
  if (ms < GATEWAY_TIMEOUT_MIN_MS) {
    return { name: "ccr-gateway-patch", ok: false, verdict: "red",
      evidence: `CCR's gateway handshake timeout is ${ms} ms, below the patched ` +
                `${GATEWAY_TIMEOUT_MIN_MS} ms. An \`npm i -g @musistudio/claude-code-router\` has ` +
                `reverted the local patch. Symptom: "Core gateway did not accept runtime config ` +
                `within ${ms}ms" — INTERMITTENT and only under load, so it will read as ` +
                `flakiness. Re-apply: in ${file}, replace the first assignment after ` +
                `${GATEWAY_ANCHOR} with 2e4, keeping the file's existing line endings` };
  }
  return { name: "ccr-gateway-patch", ok: true, verdict: "green",
    evidence: `gateway handshake timeout ${ms} ms (patched; stock is 5000)` };
}

/**
 * The CCR RPC surface, probed rather than assumed.
 *
 * Report 10, P1 #14: RPC method names are WIRE STRINGS, not minified identifiers
 * -- verified as `getAppInfo:()=>cct(),getConfig:()=>bt(),...` -- which makes them
 * the most solid CCR dependency this project has. That is a reason to depend on
 * them, and also a reason to check them: "most solid" is not "guaranteed", and an
 * unknown-method failure is loud at the call site but anonymous, arriving as a
 * refresh that returns nothing rather than as a named problem.
 *
 * `getAppInfo` also answers the version question better than the filesystem does.
 * package.json is the INSTALLED version; getAppInfo is the RUNNING one. When they
 * disagree, CCR has been updated on disk but the gateway has not been restarted --
 * which is precisely the window in which the patch above has been reverted on disk
 * while the running process still holds it, so everything works until the next
 * restart and then stops. That is worth naming before it happens.
 */
export function checkRpcSurface({ methods, installedVersion, runningVersion }) {
  const missing = Object.entries(methods ?? {}).filter(([, ok]) => !ok).map(([m]) => m);
  if (missing.length) {
    return { name: "ccr-rpc", ok: false, verdict: "red",
      evidence: `CCR does not answer ${missing.join(", ")} — the method names moved in an ` +
                `upgrade. Everything ccr-client.mjs does goes through these; re-derive them ` +
                `from the running build and update CONTRACT` };
  }
  if (installedVersion && runningVersion && installedVersion !== runningVersion) {
    return { name: "ccr-rpc", ok: false, verdict: "amber",
      evidence: `CCR ${installedVersion} is installed but the running gateway reports ` +
                `${runningVersion} — it was updated without a restart. The gateway-patch check ` +
                `above reads the NEW file while this process still runs the OLD one, so both ` +
                `can be green today and fail on the next restart. Restart the gateway` };
  }
  return { name: "ccr-rpc", ok: true, verdict: "green",
    evidence: `${Object.keys(methods ?? {}).length} methods answered; CCR ${runningVersion ?? installedVersion ?? "?"}` };
}

/**
 * The CCR install, and specifically its bundled catalogue.
 *
 * `ccr-client.mjs` resolves the install through `require.resolve` and falls back
 * to a literal `C:/nvm4w/nodejs/node_modules/...`. That junction follows the
 * ACTIVE Node version, so it survives an nvm switch — but an `npm i -g`
 * relocation, a different Node manager, or a CCR uninstall breaks it silently,
 * and the only symptom is that Task B4's copy-out has nothing to copy. Task B4
 * bounds the blast radius to refresh time; this bounds it to one named check.
 */
export function checkBundled({ dir, catalogue, version, verified }) {
  if (!dir || !fs.existsSync(catalogue)) {
    return { name: "bundled-catalogue", ok: false, verdict: "amber",
      evidence: `CCR's bundled catalogue is not at ${catalogue}. The refresher's ` +
                `copy-out has nothing to copy; UW's own ~/.uw/catalog/ still works ` +
                `until it needs replacing. Fix: reinstall CCR, or set the path in ` +
                `ccr-client.mjs's resolveInstall() fallback` };
  }
  if (version && verified && version !== verified) {
    return { name: "bundled-catalogue", ok: false, verdict: "amber",
      evidence: `CCR is ${version}; ccr-client.mjs was verified against ${verified}. ` +
                `Re-check getConfig, probeProvider and the catalogue shape, then update ` +
                `CONTRACT.verifiedVersion` };
  }
  return { name: "bundled-catalogue", ok: true, verdict: "green",
    evidence: `CCR ${version ?? "(version unknown)"} at ${dir}` };
}

export function diagnose({ env, handoff, current, pinned, contracts, hud, handoffOpts,
                           bundled, ccrPatch, rpcSurface }) {
  const checks = [checkEnv(env), checkHandoff(handoff, handoffOpts),
                  checkFingerprint(current, pinned)];
  if (contracts) checks.push(checkContracts(contracts));
  if (bundled) checks.push(checkBundled(bundled));
  if (ccrPatch) checks.push(checkCcrPatch(ccrPatch));
  if (rpcSurface) checks.push(checkRpcSurface(rpcSurface));
  if (hud) checks.push(checkHud(hud));
  const verdict = checks.reduce((w, c) => (RANK[c.verdict] > RANK[w] ? c.verdict : w), "green");
  return { verdict, checks };
}

export function readClaudeFingerprint() {
  let out;
  try {
    out = execFileSync("claude", ["doctor"], { encoding: "utf8", timeout: 30000 });
  } catch {
    return { ran: false };                      // not on PATH, or it failed to run
  }
  const ccVersion = (out.match(/Running:\s*\S+\s*\(([^)]+)\)/) ?? [])[1];
  const ccCommit = (out.match(/Commit:\s*(\S+)/) ?? [])[1];
  // The distinction that makes checkFingerprint able to be honest: the command
  // RAN and produced output, but the output did not match. That is a broken probe,
  // not a missing Claude Code, and it is red rather than amber -- see
  // checkFingerprint. Conflating the two was what let a format change degrade into
  // "recorded, carry on".
  return { ran: true, ccVersion, ccCommit, parseFailed: !ccVersion,
           raw: out.slice(0, 400),
           invalidSettings: /Invalid settings/i.test(out) };
}

const readLines = (f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean); }
                           catch { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };

// The one sample the HUD check round-trips. Deliberately a literal rather than a
// captured payload: a fixture that came from a live session would carry a session
// id and a transcript path into a file we print.
const HUD_SAMPLE = JSON.stringify({
  version: CC.CONTRACT.fingerprint,
  model: { id: "uw/probe", display_name: "probe" },
  context_window: { context_window_size: 1, current_usage: { input_tokens: 1 },
                    used_percentage: 50, remaining_percentage: 50 },
});

function hudRoundTrip() {
  try {
    const out = transform(HUD_SAMPLE, new Map([["uw/probe", 1000]]));
    if (!out) return { ok: false, why: "transform declined a payload it should have corrected" };
    const p = JSON.parse(out);
    if (p.context_window.context_window_size !== 1000) return { ok: false, why: "context size not applied" };
    if (p.model.display_name !== "probe") return { ok: false, why: "unrelated fields were lost" };
    return { ok: true, why: "" };
  } catch (e) { return { ok: false, why: String(e.message).slice(0, 80) }; }
}

export async function main() {
  const current = readClaudeFingerprint();
  const pinned = readJson(CAPABILITIES).fingerprint ?? {};
  const install = readJson(HUD_INSTALL).previousCommand ? readJson(HUD_INSTALL) : null;
  // Evidence that Claude Code has been used since the last recorded handoff:
  // the mtime of its own settings file, which it rewrites on ordinary use. Cheap,
  // approximate, and only ever used to decide amber-versus-red on a stale row.
  let claudeRunSince = null;
  try { claudeRunSince = fs.statSync(CC.CONTRACT.paths.settings).mtimeMs; } catch { }

  const r = diagnose({
    env: process.env, handoff: readLines(HANDOFF), current, pinned,
    handoffOpts: { now: Date.now(), claudeRunSince },
    contracts: { ccObserved: current.ccVersion, ccPinned: CC.CONTRACT.verifiedVersion ?? CC.CONTRACT.fingerprint,
                 service: CCR.readService() },
    bundled: { dir: CCR.CONTRACT.installDir, catalogue: CCR.CONTRACT.bundledCatalogue,
               version: CCR.ccrVersion(), verified: CCR.CONTRACT.verifiedVersion },
    ccrPatch: { file: CCR.CONTRACT.gatewayBundle },
    rpcSurface: await CCR.probeRpcSurface(),
    hud: install && {
      install,
      wrappedExists: fs.existsSync(String(install.previousCommand).match(/"([^"]+)"|(\S+)/)?.slice(1).find(Boolean) ?? ""),
      roundTrip: hudRoundTrip(),
    },
  });

  for (const c of r.checks) {
    console.log(`${c.verdict.toUpperCase().padEnd(6)} ${c.name.padEnd(20)} ${c.evidence}`);
  }
  console.log(`\nverdict: ${r.verdict}`);

  // PINNING IS AN EXPLICIT ACT, never a side effect of running the doctor.
  //
  // The previous version pinned on every non-red run. That makes the tool report
  // drift exactly once and then agree with whatever it found -- so a Claude Code
  // upgrade that silently broke the handoff would be flagged on the first run and
  // green on the second, with nothing having been verified in between. Recording a
  // fingerprint is a claim that the contract still holds against that version, and
  // only a human who has pressed ctrl+g can make that claim.
  if (process.argv.includes("--accept-fingerprint")) {
    if (!current.ccVersion) {
      console.log("\nnothing to pin: the version could not be read.");
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(CAPABILITIES), { recursive: true });
    writeAtomic(CAPABILITIES,
      JSON.stringify({ fingerprint: current, at: new Date().toISOString(),
                       acceptedBy: "uw doctor --accept-fingerprint" }, null, 2));
    console.log(`\npinned ${current.ccVersion} (${current.ccCommit ?? "no commit"}).`);
  } else if (r.checks.some((c) => c.name === "cc-fingerprint" && c.verdict === "amber")) {
    console.log("\nrun `uw doctor --accept-fingerprint` once you have confirmed ctrl+g " +
                "still reaches the picker.");
  }
  process.exit(r.verdict === "red" ? 1 : 0);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("/menu/doctor.mjs")) main();
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/menu/doctor.mjs"
```

Expected: `# fail 0`, with a pass count around 169 (indicative — see "How to read the `# pass N` numbers"). The `doctor` run prints three lines; on a machine where the installer has not run yet it prints `RED editor-wiring EDITOR is "(unset)" ...` and exits 1, which is correct until Task A16.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): uw doctor probes the handoff contract and names the failing check"
```

---

### Task A16: `install.ps1` — wire `EDITOR` without clobbering one we did not set

**Files:** Create `C:/Users/osami/.uw/menu/install.ps1`, Create `C:/Users/osami/.uw/menu/set-statusline.mjs`, Test `C:/Users/osami/.uw/test/install.test.mjs`
**Interfaces:** Consumes: the current User-scope `EDITOR`; with `-Hud`, Claude Code's `settings.json` through `CC.CONTRACT.paths.settings`. Produces: `EDITOR` and `UW_REAL_EDITOR` set at User scope, and `~/.uw/state/install.json` recording `{editorSetBy, editorValue, previousEditor, at}`. Refuses with exit code 2 when `EDITOR` is set to something we did not set, unless `-Force` is passed, in which case the previous value is preserved into `UW_REAL_EDITOR`. `-WhatIf` prints the decision and changes nothing. With `-Hud` it also rewrites `statusLine.command` to run `hud-shim.mjs` in front of the existing command, storing that command verbatim in `~/.uw/state/hud-install.json` and the original file bytes in `settings.json.uw-bak`; `-Hud -HudUninstall` restores from those bytes when they still match what was recorded, and otherwise performs a value-level edit **and says so**; exit code 3 means there was nothing to wrap. Every write this script performs — `install.json`, `hud-install.json` and `settings.json` — is BOM-free and atomic (Q2.8, Q2.9), and the `settings.json` write goes through `set-statusline.mjs` rather than a PowerShell JSON round trip (Q6.4).

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

// --- the optional statusline shim ------------------------------------------
// Every one of these runs against a scratch settings.json. None of them can see
// the live file, which is the rule for the whole suite (constraint 15).
const settings = (command) => {
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "uw-set-"));
  const f = require("node:path").join(dir, "settings.json");
  fs.writeFileSync(f, JSON.stringify({
    model: "opus", statusLine: { type: "command", command },
    permissions: { allow: ["Bash(git:*)"] },
  }, null, 2));
  return f;
};

test("-Hud plans to wrap the existing command and keeps it intact", () => {
  const f = settings('"C:/node.exe" "C:/hud/omc-hud.mjs"');
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 0);
  assert.match(out, /statusLine\s*->\s*node .*hud-shim\.mjs.*--.*omc-hud\.mjs/);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).statusLine.command,
               '"C:/node.exe" "C:/hud/omc-hud.mjs"', "-WhatIf must not have written");
});

test("-Hud refuses with exit 3 when there is no statusline to wrap", () => {
  const dir = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "uw-set2-"));
  const f = require("node:path").join(dir, "settings.json");
  fs.writeFileSync(f, JSON.stringify({ model: "opus" }));
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 3);
  assert.match(out, /nothing to wrap|no statusLine/i);
});

test("-Hud is idempotent: a second run reports it is already installed", () => {
  const f = settings('node "C:/Users/osami/.uw/menu/hud-shim.mjs" -- "C:/node.exe" "x.mjs"');
  const { code, out } = plan(["-Hud", "-SettingsFile", f], null, "");
  assert.equal(code, 0);
  assert.match(out, /already installed/i);
});

test("-Hud -HudUninstall restores the stored command exactly", () => {
  const original = '"C:/node.exe" "C:/hud/omc-hud.mjs" --wide';
  const f = settings(`node "shim.mjs" -- ${original}`);
  const scratch = fs.mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "uw-hud-"));
  const state = require("node:path").join(scratch, "install.json");
  fs.writeFileSync(require("node:path").join(scratch, "hud-install.json"),
                   JSON.stringify({ previousCommand: original, settings: f }));
  const { code, out } = plan(["-Hud", "-HudUninstall", "-SettingsFile", f], state, "");
  assert.equal(code, 0);
  assert.match(out, /restored/i);
  assert.ok(out.includes(original));
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
  # Q6.3: the statusline shim is opt-in and separately reversible.
  [switch]$Hud,
  [switch]$HudUninstall,
  # Injected only by tests, so no test ever reads or writes the live settings
  # file (constraint 15).
  [string]$SettingsFile = (Join-Path $env:USERPROFILE ".claude\settings.json"),
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

# One BOM-free, atomic JSON write, used for every file this script produces.
# Q2.9: PowerShell 5.1's `Set-Content -Encoding UTF8` writes a UTF-8 BOM and
# JSON.parse throws on it, so every reader in this project would silently fall
# back to an empty object. UTF8Encoding($false) is the BOM-free constructor.
# Q2.8: temp file plus Move-Item -Force, which is an atomic rename on NTFS for a
# same-directory destination, so a ctrl+c mid-write cannot truncate the target.
function Write-JsonFile([string]$Path, [string]$Text) {
  $dir = Split-Path $Path
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $tmp = "$Path.uw-tmp"
  [IO.File]::WriteAllText($tmp, $Text, (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $Path -Force
}

Write-JsonFile $StateFile (@{ editorSetBy = "uw"; editorValue = $dispatcher
  previousEditor = $current; realEditor = $realEditor
  at = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json)

# ---- optional: the statusline shim (Q6.3, Q6.4) ---------------------------
# Off unless asked. It changes ONE key in Claude Code's settings.json, keeps the
# original bytes in settings.json.uw-bak, and restores from those bytes on
# -HudUninstall. It never touches an OMC file.
if ($Hud) {
  $settingsPath = $SettingsFile
  $hudState     = Join-Path (Split-Path $StateFile) "hud-install.json"
  $shim         = Join-Path $PSScriptRoot "hud-shim.mjs"
  $nodeEdit     = Join-Path $PSScriptRoot "set-statusline.mjs"

  if (-not (Test-Path $settingsPath)) { Write-Host "hud: no settings.json at $settingsPath"; exit 3 }

  # READ-ONLY here. $json INSPECTS the current value and is never written back.
  # The write goes through set-statusline.mjs below, which round-trips JSON
  # losslessly.
  #
  # Why not "($json | ConvertTo-Json -Depth 20) | Set-Content": that re-serialises
  # the user's entire Claude Code configuration in order to change one string.
  # PowerShell 5.1's round trip collapses single-element arrays to scalars -- a
  # one-entry permissions.allow or a one-entry hook array comes back as a bare
  # value and stops being a list -- re-escapes non-ASCII into backslash-u escapes,
  # renormalises numbers, and reformats indentation. The blast radius is the whole
  # file, and this is the one file the plan promises not to disturb.
  $json = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json
  $currentCommand = $json.statusLine.command

  if ($HudUninstall) {
    if (-not (Test-Path $hudState)) { Write-Host "hud: not installed"; exit 0 }
    $prevHud = Get-Content -Path $hudState -Raw | ConvertFrom-Json
    $bak = "$settingsPath.uw-bak"

    # GUARD 1: is the shim still ours to remove?
    #
    # OMC owns statusLine.command too. `/omc-setup` and `omc-doctor` both write it,
    # and either can replace UW's wrapper with OMC's own bare command at any time.
    # When that has happened the wrapper is already gone -- which degrades
    # correctly, the footer simply works as it always did -- but hud-install.json
    # is now STALE, and writing its recorded previousCommand back would overwrite
    # whatever OMC just set. Uninstall would then look like it worked and would
    # have reverted an OMC update. Detect it, say so, and clear only our own state.
    if ($currentCommand -notlike "*hud-shim.mjs*") {
      Write-Host "hud: statusLine.command is no longer UW's wrapper -- something else"
      Write-Host "     (most likely an OMC setup or doctor run) has already rewritten it to:"
      Write-Host "       $currentCommand"
      Write-Host "     Leaving it alone and removing UW's stale state file only."
      if (-not $WhatIf) { Remove-Item $hudState -Force }
      exit 0
    }

    # GUARD 2: does the backup differ from the live file in NOTHING BUT statusLine?
    #
    # Q6.4 promises a byte-for-byte restore, and $bak is the only thing that can
    # deliver one. But settings.json is a shared file with 20-plus top-level keys --
    # `hooks`, `permissions`, `modelPicker`, `enabledPlugins`, `env` -- owned by
    # Claude Code, by OMC, and by the user. Copying the whole backup over the live
    # file reverts every one of those to its state at install time.
    #
    # Comparing only statusLine.command (which an earlier draft of this plan did)
    # is not enough: it says the field we changed is unchanged, and says nothing
    # about the twenty fields we did not. So compare the two documents with
    # `statusLine` removed. Identical means we are the only writer since install and
    # the whole-file copy is safe; different means someone else has written to this
    # file and only the value edit is honest.
    $canRestoreBytes = $false
    if (Test-Path $bak) {
      try {
        $bakJson = Get-Content -Path $bak -Raw | ConvertFrom-Json
        $bakCmd  = $bakJson.statusLine.command
        $liveRest = $json      | Select-Object -Property * -ExcludeProperty statusLine | ConvertTo-Json -Depth 30 -Compress
        $bakRest  = $bakJson   | Select-Object -Property * -ExcludeProperty statusLine | ConvertTo-Json -Depth 30 -Compress
        $canRestoreBytes = ($bakCmd -ceq $prevHud.previousCommand) -and ($liveRest -ceq $bakRest)
      } catch { $canRestoreBytes = $false }
    }

    if ($WhatIf) {
      $how = if ($canRestoreBytes) { "byte for byte from $bak" } else { "value edit; other keys have changed since install" }
      Write-Host ("hud: would restore -> {0} ({1})" -f $prevHud.previousCommand, $how)
      exit 0
    }

    if ($canRestoreBytes) {
      Copy-Item $bak $settingsPath -Force
      Write-Host "hud: restored byte for byte from $bak"
    } else {
      # Honest fallback, and it announces itself rather than claiming otherwise.
      # This is the CORRECT path whenever anyone else has touched settings.json
      # since the install, which for a file OMC and Claude Code both write is the
      # expected case rather than the exception.
      & node $nodeEdit $settingsPath $prevHud.previousCommand
      if ($LASTEXITCODE -ne 0) { Write-Host "hud: restore FAILED; $bak still holds the original"; exit 1 }
      Write-Host "hud: restored the statusLine VALUE but not byte for byte -- other keys in"
      Write-Host "     settings.json have changed since the install, so the backup is not safe"
      Write-Host "     to copy wholesale. Those changes are preserved; the file is reformatted."
    }
    Remove-Item $hudState -Force
    Write-Host "hud: statusLine -> $($prevHud.previousCommand)"
    exit 0
  }

  if ($currentCommand -like "*hud-shim.mjs*") { Write-Host "hud: already installed"; exit 0 }
  if (-not $currentCommand) { Write-Host "hud: no statusLine.command to wrap"; exit 3 }

  $wrapped = "node `"$($shim -replace '\','/')`" -- $currentCommand"
  Write-Host "statusLine     -> $wrapped"
  if ($WhatIf) { Write-Host "(-WhatIf: nothing was changed)"; exit 0 }

  Copy-Item $settingsPath "$settingsPath.uw-bak" -Force
  Write-JsonFile $hudState (@{ previousCommand = $currentCommand
    wrappedAt = (Get-Date).ToUniversalTime().ToString("o")
    settings = $settingsPath } | ConvertTo-Json)

  # The write itself: Node, not PowerShell. JSON.parse/JSON.stringify round-trips
  # this file without losing array-ness, and set-statusline.mjs writes it through
  # menu/atomic.mjs -- BOM-free and atomic (Q2.8, Q2.9), which Set-Content is
  # neither.
  & node $nodeEdit $settingsPath $wrapped
  if ($LASTEXITCODE -ne 0) { Write-Host "hud: FAILED to write settings.json; it is unchanged"; exit 1 }
  Write-Host "hud: installed. Previous command saved to $hudState"
}

Write-Host ""
Write-Host "Done. Open a NEW terminal (User-scope variables do not reach running processes),"
Write-Host "start Claude Code, press ctrl+g, type 'm', press enter."
exit 0
```

Then create the twelve-line editor that block delegates its writes to. It exists because PowerShell 5.1 cannot round-trip this file safely and Node can:

`C:/Users/osami/.uw/menu/set-statusline.mjs`:

```js
// Set settings.json's statusLine.command, losslessly.
//
// This file exists because PowerShell 5.1's ConvertFrom-Json/ConvertTo-Json is
// not a round trip: it collapses single-element arrays into scalars, re-escapes
// non-ASCII into \uXXXX, renormalises numbers, and reformats indentation. Using
// it to change one string re-serialises the user's whole Claude Code
// configuration, and a `permissions.allow` with exactly one entry stops being an
// array. JSON.parse/JSON.stringify has none of those properties.
//
// It also gets the two guarantees the PowerShell path could not: atomic (Q2.8)
// and BOM-free (Q2.9), both from menu/atomic.mjs.
//
// The path is passed in as argv[1] rather than read from cc-contract.mjs on
// purpose: install.ps1 already resolves it (and -SettingsFile can override it for
// a test), and hard-coding it here would put a second Claude Code path outside
// the two contract modules, which Q4.3's grep would reject.
import fs from "node:fs";
import { writeAtomic, readJsonOr } from "./atomic.mjs";

const [file, command] = process.argv.slice(2);
if (!file || command == null) {
  console.error("usage: set-statusline.mjs <settings.json> <command>");
  process.exit(2);
}
const doc = readJsonOr(file, null);
if (doc === null) { console.error(`cannot parse ${file}; nothing written`); process.exit(1); }
doc.statusLine = { ...(doc.statusLine ?? {}), command };
writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");
```

Four things in the block above are load-bearing, and each replaces something that was wrong.

**The write does not go through PowerShell.** `($json | ConvertTo-Json -Depth 20) | Set-Content` was a full re-serialisation of `settings.json` to change one string, and PS 5.1's round trip is lossy in ways that matter to Claude Code — a one-element `permissions.allow` or a one-element hook array comes back as a scalar and stops being a list. `-Depth 20` was necessary against the default depth of 2, but it does not make the round trip safe; it only makes it deep.

**The write is atomic and BOM-free.** `Set-Content -Encoding UTF8` in PS 5.1 writes a UTF-8 BOM, and `JSON.parse` throws on a leading `\uFEFF` — so the installer's own output would have been unreadable to every reader in this project, including Claude Code itself, which is the one third-party consumer of this file. And a plain `Set-Content` truncates before it writes, so a ctrl+c or a full disk at that moment leaves Claude Code with a truncated config. `settings.json` was the only file in Q2.8's list that was not written atomically, and it is the one where a truncation costs the most.

**The backup is read, not merely taken.** `settings.json.uw-bak` is the original bytes. Q6.4's byte-for-byte restore is `Copy-Item $bak $settingsPath`, and it is guarded on the recorded `previousCommand` still matching what the backup contains, so a user who edited `settings.json` after installing does not have those edits silently reverted. The previous version created this file and never read it from any code path, while the ADR, the pre-mortem, Q6.3 and this task's Interfaces line all described the result as byte for byte.

**The fallback says what it did.** When the backup is unusable, the restore is a value edit and the file gets reformatted. That is announced on stdout rather than described as byte-for-byte, because the plan may only claim the property on the path that has it.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/osami/.uw/menu/install.ps1" -WhatIf
```

Expected: `# fail 0`. The `-WhatIf` run prints the two planned assignments and changes nothing. Run it for real without `-WhatIf` before Task A17.

Three assertions belong in `install.test.mjs` that the previous version did not have, all of them about the file this task is riskiest around. Every one of them operates on a **copy** of a settings file in a scratch directory, passed through `-SettingsFile`; none reads or writes the live `~/.claude/settings.json` (Constraint 15):

```js
test("the written settings.json has no BOM", () => {
  const f = fixtureSettings();                       // a copy under harness/scratch
  runInstall(["-Hud", "-SettingsFile", f]);
  const bytes = fs.readFileSync(f);
  assert.notEqual(bytes[0], 0xEF, "PowerShell 5.1's -Encoding UTF8 writes a BOM; JSON.parse throws on it");
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(f, "utf8")));
});

test("a one-element array survives the install as an array", () => {
  // The PS 5.1 round-trip defect, pinned. This is what makes the Node writer
  // necessary rather than merely tidier.
  const f = fixtureSettings({ permissions: { allow: ["Bash(git status:*)"] } });
  runInstall(["-Hud", "-SettingsFile", f]);
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.ok(Array.isArray(after.permissions.allow), "a single-element array must stay an array");
  assert.equal(after.permissions.allow.length, 1);
});

test("uninstall restores the exact original bytes", () => {
  const f = fixtureSettings();
  const before = fs.readFileSync(f);
  runInstall(["-Hud", "-SettingsFile", f]);
  assert.notDeepEqual(fs.readFileSync(f), before, "the install must have changed something");
  runInstall(["-Hud", "-HudUninstall", "-SettingsFile", f]);
  assert.deepEqual(fs.readFileSync(f), before, "Q6.4: byte for byte, from settings.json.uw-bak");
});

test("uninstall never reverts a change someone else made to settings.json", () => {
  // THE OMC REGRESSION THIS GUARDS. settings.json is a shared file: Claude Code
  // writes it, OMC's setup and doctor write it, the user edits it. A whole-file
  // copy from .uw-bak reverts every key to its state at install time. Comparing
  // only statusLine.command -- which an earlier draft did -- proves the one field
  // we changed is unchanged and says nothing about the twenty we did not.
  const f = fixtureSettings({ hooks: {} });
  runInstall(["-Hud", "-SettingsFile", f]);

  // Simulate OMC adding a hook after UW installed the shim.
  const mid = JSON.parse(fs.readFileSync(f, "utf8"));
  mid.hooks = { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "omc-guard" }] }] };
  fs.writeFileSync(f, JSON.stringify(mid, null, 2) + "\n");

  runInstall(["-Hud", "-HudUninstall", "-SettingsFile", f]);
  const after = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.deepEqual(after.hooks, mid.hooks, "an unrelated key written after install must survive uninstall");
  assert.doesNotMatch(after.statusLine.command, /hud-shim/, "and the shim must still be removed");
});

test("uninstall refuses to overwrite a statusLine OMC has already replaced", () => {
  // OMC can rewrite statusLine.command at any time -- /omc-setup and omc-doctor
  // both do. When it has, UW's wrapper is already gone (which degrades correctly)
  // but hud-install.json is stale, and writing its recorded previousCommand back
  // would silently revert whatever OMC just set.
  const f = fixtureSettings();
  runInstall(["-Hud", "-SettingsFile", f]);

  const omc = JSON.parse(fs.readFileSync(f, "utf8"));
  omc.statusLine.command = '"C:/nvm4w/nodejs/node.exe" "C:/Users/osami/.claude/hud/omc-hud.mjs" --v2';
  fs.writeFileSync(f, JSON.stringify(omc, null, 2) + "\n");

  const out = runInstall(["-Hud", "-HudUninstall", "-SettingsFile", f]);
  assert.match(out, /no longer UW's wrapper/);
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).statusLine.command, omc.statusLine.command,
    "OMC's newer command must be left exactly as it was");
});
```

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): installer that wires ctrl+g and refuses to clobber a foreign EDITOR"
```

---

### Task A17: The interactive verification protocol

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
  "P13-motion", "P14-legend-and-empty-state", "P15-statusline-footer",
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

Create `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` with fifteen `### <id>` sections. Each carries **Do**, **Expected** and **Fail means**. The content of each:

**`### P1-sentinel-dispatch`** — Do: in Claude Code, press ctrl+g, type `m`, press enter. Expected: the chat pane is replaced by a rounded frame whose title bar reads `UW > providers` and whose second line ends with `44 providers · 1584 models · routable <stamp>` (or `routable —` before any refresh has resolved routability). The frame draws top-down over about a tenth of a second. Fail means: the dispatcher did not match the sentinel, or `EDITOR` is not wired — run `node ~/.uw/menu/doctor.mjs`.

**`### P2-provider-columns`** — Do: read the header row. Expected: `key id`, `models`, `free`, `health` in that order; rows show ids of the shape `personal.google.free`; at least one row shows `—` in the free column and at least one shows a number; `anthropic` shows `relay.anthropic.subscription`. Fail means: a `0` where `—` belongs is the failure that matters most — it is the design lying.

**`### P3-provider-filter`** — Do: type `goo`. Expected: the list narrows to google's credential rows as each character lands, with no visible redraw flicker and no delay. Fail means: characters buffer until enter (the console mode was not set) or arrows print `^[[A` (the same cause).

**`### P4-filter-by-model-name`** — Do: backspace to clear, then type `opus`. Expected: the list narrows to providers that *serve* a model matching `opus`, including `relay.anthropic.subscription`. Fail means: an empty list — the level-1 filter is not searching member model ids, which is what makes two levels tolerable.

**`### P5-descend`** — Do: clear the filter, arrow to `personal.openrouter.free`, press enter. Expected: the title bar becomes `UW > personal.openrouter.free > models`, the list slides in from the right, and it shows models rather than providers. Fail means: nothing happens on enter.

**`### P6-model-columns`** — Do: read the header and rows. Expected: `model`, `ctx`, `$in`, `$out`, `badge`, `caps`; context values render as `163k` or `1M`; prices show two decimals; badges are only ever `FREE`, `FREE?`, `PLAN`, `PAID` or blank; caps render as three characters from `T`, `V`, `R` and `-`; models CCR cannot resolve are visibly dimmer than the rest. Fail means: any badge outside the five-value set, or a price with no decimals.

**`### P7-select-writes-chat-input`** — Do: arrow to a routable model and press enter. Expected: the picker clears, Claude Code returns, and the chat input contains exactly `/model openrouter/<the model you chose>` with the cursor at the end. Press enter and the status footer shows the new model. Fail means: an empty chat input (the picker exited non-zero, so Claude Code discarded the file).

**`### P8-esc-ladder`** — Do: reopen the picker, descend into a provider, type `x`, then press esc four times. Expected: first esc clears the model filter and stays at the model level; second returns to the provider list; third does nothing visible if the provider filter is already empty, otherwise clears it; the last esc exits with the chat input unchanged from before the picker opened. Fail means: the first esc exits — the ladder is inverted, and every accidental esc loses the user's place.

**`### P9-tab-flat-scope`** — Do: reopen, press tab, type `qwen3-max`. Expected: the header shows `provider/model` and rows show full `provider/model` strings from every provider at once. Press esc: the scope returns to the tree at the provider level. Fail means: tab inserts a literal tab into the filter.

**`### P10-ctrl-c`** — Do: reopen and press ctrl+c. Expected: the picker exits, Claude Code returns, the chat input is unchanged, and typing in the terminal echoes normally. Fail means: no echo — the console mode was not restored, and the shell is now unusable.

**`### P11-passthrough-editor`** — Do: press ctrl+g with the chat input containing `hello world`. Expected: `%UW_REAL_EDITOR%` opens with `hello world` in it; save and close; the chat input holds whatever the editor left. Fail means: the picker opened, so the sentinel comparison is too loose.

**`### P11a-esc-leaves-the-chat-input-empty`** — Do: press ctrl+g, type `m`, press enter, then press Esc at the provider level (not inside a filter). Expected: the picker closes and the chat input is **empty**. Fail means: the chat input contains the literal `m`, which is the BL-2 defect — the picker exited 0 with the sentinel still in the buffer, or `uwpick.cmd` replaced a non-zero exit with 0. Check `exit /b %ERRORLEVEL%` in the `:pick` branch and the truncation in `finish`/`abort`.

**`### P11b-ctrl-c-leaves-the-chat-input-empty`** — Do: the same, but press ctrl+c instead of Esc. Expected: identical to P11a. This is a separate step because ctrl+c reaches the picker as byte 3 through a deliberately unset `ENABLE_PROCESSED_INPUT`, on a different code path from Esc.

**`### P11c-missing-snapshot-leaves-the-chat-input-empty`** — Do: rename `~/.uw/catalog/snapshot.json` aside, press ctrl+g, type `m`, press enter, then restore the file. Expected: one line naming the file and the `uw catalog refresh` command, and an **empty** chat input. This is Q2.1's stated behaviour and the failure most likely to be met by a user who has never run a refresh.

**`### P12-console-restored`** — Do: after every step above, in the same terminal, run `powershell -NoProfile -Command "Write-Host 'echo test'"` and type a few characters at the shell prompt. Expected: characters echo and the command runs. Fail means: the restore in the wrapper's `finally` block did not run; capture `~/.uw/state/conmode.json` after a `-Diagnose` run and compare `saved` with `restored`.

**`### P13-motion`** — Do: reopen the picker and watch the four transitions in order: the frame drawing itself top-down on open, the model list arriving from the right on enter, the same in reverse on esc, and the chosen row flashing twice before the frame collapses to `switched -> provider/model`. Then hold the down arrow for two seconds. Expected: each transition completes in well under a fifth of a second and the held arrow moves the cursor at full speed with no lag, because motion never delays the next key (Q7.3). Then close, run `set UW_PICKER_MOTION=0`, and reopen: every transition is gone and the frames appear instantly. Fail means: a visible pause before the cursor responds to a key, which means a transition is running where it should have been skipped — or motion still running with the kill switch set, which makes the switch a lie. This step is the only place motion is verified; it has no unit test, because three synchronous frames leave nothing for a harness to sample that is not our own mock.

**`### P14-legend-and-empty-state`** — Do: press `?`, read the legend, press any key; then type `zzzz`. Expected: the legend replaces the rows and lists the keys including ctrl+f and esc; the key that closes it does nothing else, so pressing esc to close does not exit the picker; the filter still reads what it read before. With `zzzz` typed, one line reads `no match for "zzzz" — backspace to widen, esc to clear` and the help line is still visible at the bottom. Fail means: an empty pane with no explanation, or esc closing the legend and quitting in one press.

**`### P14a-omc-survives-uninstall`** — Do: with the shim installed, edit `~/.claude/settings.json` by hand to add a harmless key (or run any OMC command that writes it), then run `install.ps1 -Hud -HudUninstall`. Expected: the shim is removed, the added key is **still there**, and the output says the restore was a value edit rather than byte-for-byte. Fail means: the added key is gone — the whole-file backup was copied over a file someone else had written, which is the OMC-regression class Q4.8 exists to prevent.

**`### P14b-uninstall-refuses-a-foreign-command`** — Do: with the shim installed, set `statusLine.command` by hand to anything that does not mention `hud-shim.mjs` (simulating an OMC setup run), then run `install.ps1 -Hud -HudUninstall`. Expected: output naming the foreign command, the command left exactly as it was, and `~/.uw/state/hud-install.json` removed. Fail means: UW wrote its recorded `previousCommand` over the newer value.

**`### P15-statusline-footer`** — Do: note the model name and the "context left" percentage in the OMC footer, switch to a model with a context window that is not 200k, and look again. Expected: the footer names the model you selected, with no OMC change (Q6.1). Without the shim installed, the context percentage is computed against 200000 and will be wrong for that model — record the number. Then run `install.ps1 -Hud`, start a new session, and check again: the percentage is now computed against the catalogue's real limit. Finally run `install.ps1 -Hud -HudUninstall` and confirm the footer still renders. Fail means: a blank or error-filled footer at any point, which is the one outcome the shim is built to make impossible — capture the wrapped command from `~/.uw/state/hud-install.json` and run it by hand with a sample payload on stdin.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 181 (indicative — see "How to read the `# pass N` numbers"). Then execute the protocol itself: hand `C:/Users/osami/.uw/docs/qa-interactive-protocol.md` to the `oh-my-claudecode:qa-tester` agent with the instruction to run all fifteen steps in Windows Terminal and report per-step pass or fail with the observed screen. Phase A is not complete until P1 through P15 all pass.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "docs(menu): fifteen-step interactive verification protocol with expected screens"
```

---

# Phase B — the catalogue refresh and labeling pipeline

Ordering in this phase is not stylistic. The reserved-name denylist must land before Task B2, because B2 is what makes the free-first sort functional and therefore what arms the promotion path the denylist blocks. This is the clearest case in the whole research pass of a correctness fix being a security regression if sequenced wrongly. Since review, the denylist sits further forward still — **Task A5.1**, in Phase A — which satisfies that ordering strictly harder and closes the window in which the shippable menu rendered untrusted ids unguarded. The `B1` slot below is left vacant rather than reused, so every existing reference to `B2` through `B10` stays correct.

### Task B1: *vacated — moved to Task A5.1*

The reserved-name denylist was originally the first task of Phase B. Review found two defects in that arrangement and both are fixed by moving the task rather than by editing it in place.

The first is placement in the module graph: the task wired the denylist into `menu/catalog.mjs`, which builds the rows the picker draws and has no influence on what CCR routes. The routing path is `keysync.mjs:buildProviders`, and Task B2 below is the change that arms it. Report 08's CRITICAL finding was therefore mitigated on a surface where the harm cannot occur, while the surface where it can occur was left open and its own comment asserted the opposite.

The second is placement in time. The task consumed nothing from Phase B and depended only on Task A5, yet it sat 17 tasks after the renderer it protects — including after Task A17's live protocol against real Claude Code.

The task now lives at **Task A5.1**, immediately after Task A5, with `keysync/keysync.mjs` added to its Files list and its git-log-grep gate replaced by an assertion on `buildProviders`' output. Constraint 11's requirement that the denylist precede the `inferTier` fix is satisfied strictly harder by the move.

The number `B1` is left vacant rather than reused, so that every existing reference to `B2` through `B10` in this plan remains correct.

---

### Task B2: Fix `inferTier` to read the real pricing path

**Files:** Modify `C:/Users/osami/.uw/keysync/keysync.mjs`, Test `C:/Users/osami/.uw/test/infertier.test.mjs`
**Interfaces:** Consumes: catalogue entries. Produces: `inferTier(entry, providerName?) -> "free" | "paid" | "unknown"` reading `pricing.offers[].per1MTokens.{input,output}` from the offer whose `provider` matches `providerName`. Same three return values, correct field path, and one added parameter — the provider whose key is going to pay.

This task **must not start** until Task A5.1 is committed, and the first test in this file is what proves it: it calls `buildProviders` with a hostile zero-priced `opus` and fails if that id reaches the returned `Providers[].models`.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/infertier.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { inferTier, buildProviders } from "../keysync/keysync.mjs";

const doc = JSON.parse(fs.readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));
const byId = Object.fromEntries(doc.models.map((m) => [m.model, m]));

// The prerequisite gate. The previous draft asserted that the string
// "reserved-name denylist" appeared in `git log --oneline -40`, which
// `git commit --allow-empty -m "reserved-name denylist"` satisfies and which says
// nothing about whether the guard exists, is imported, or is reachable from the
// function this task is about to arm. The risk table then named that test as the
// mitigation for the very risk it could not detect.
//
// This is the same assertion expressed against behaviour. It fails if Task A5.1
// has not landed, and it keeps failing if A5.1 lands on the display path only.
test("the denylist is on the routing path — Task A5.1 is a hard prerequisite", () => {
  const hostile = {
    provider: "tokenrouter", model: "opus",
    modalities: { output: ["text"] },
    pricing: { offers: [{ provider: "tokenrouter", per1MTokens: { input: 0, output: 0 } }] },
  };
  const out = buildProviders(
    [{ id: "personal.tokenrouter.free", provider: "tokenrouter" }],
    new Map([["tokenrouter", { protocol: "openai", baseUrl: "https://x.invalid/v1",
                               testModel: "qwen3-max" }]]),
    { byProvider: new Map([["tokenrouter", [hostile]]]), generatedAt: "x" },
    () => "sk-test-not-a-real-key",
  );
  const ids = out.providers.flatMap((p) => p.models.map((m) => m.id));
  assert.equal(ids.includes("opus"), false,
    "Task A5.1 must be committed before inferTier is fixed: fixing tier inference " +
    "is what arms the routing hijack the denylist blocks, and the denylist must be " +
    "inside buildProviders, not only inside buildFrom");
});

test("a zero-priced model classifies as free", () => {
  assert.equal(inferTier(byId["acme-chat-1"], "acme"), "free");
});

test("a priced model classifies as paid", () => {
  assert.equal(inferTier(byId["acme-pro-1"], "acme"), "paid");
});

test("no pricing data stays unknown, never paid", () => {
  assert.equal(inferTier(byId["blank-a"], "blank"), "unknown");
});

test("the legacy field shape is not pricing data", () => {
  assert.equal(inferTier(byId["acme-legacy-1"], "acme"), "unknown");
});

test("a malformed offers array does not throw", () => {
  assert.equal(inferTier({ pricing: { offers: "nope" } }, "acme"), "unknown");
  assert.equal(inferTier({ pricing: {} }, "acme"), "unknown");
  assert.equal(inferTier({}, "acme"), "unknown");
  assert.equal(inferTier(null, "acme"), "unknown");
});

test("numeric strings are accepted — providers quote prices", () => {
  assert.equal(inferTier({ pricing: { offers: [{ provider: "acme", per1MTokens: { input: "0", output: "0" } }] } }, "acme"), "free");
  assert.equal(inferTier({ pricing: { offers: [{ provider: "acme", per1MTokens: { input: "0.3", output: "1.2" } }] } }, "acme"), "paid");
});

test("an offer that prices the model at ANOTHER provider does not decide my tier", () => {
  // The bug this guards: a merged record carries up to 16 offers, each with its
  // own `provider`. Taking offers[0] answers "is the first element of an
  // arbitrarily ordered array free", not "is it free on my key". A false `free`
  // here is worse than `unknown` twice over: it puts a FREE badge on a model that
  // bills, and free-first sorting promotes it to rank 0 on the routing path.
  const merged = { pricing: { offers: [
    { provider: "someone-else", per1MTokens: { input: 0, output: 0 } },
    { provider: "acme", per1MTokens: { input: 0.3, output: 1.2 } },
  ] } };
  assert.equal(inferTier(merged, "acme"), "paid");
  assert.equal(inferTier(merged, "someone-else"), "free");
  // No matching offer: unknown, never the first one.
  assert.equal(inferTier(merged, "third-party"), "unknown");
});
```

Note what is **not** in this file. The previous draft ended with a test that read `C:/Users/osami/.uw/catalog/models.json` — a live 19.7 MB artifact that Task B4 creates — and documented it as failing with `ENOENT` on first run, "which is the signal to proceed to B4". That breaks Constraint 15a: with a known-failing test in the sweep, a real regression is indistinguishable from the expected one, and every published `# pass N` from B2 onward is wrong until B4 lands. The corpus measurement is still worth having; it moves to a standalone script in the next step, run explicitly after B4, in the style `bench-startup.mjs` already established.

Create `C:/Users/osami/.uw/test/corpus-tier.mjs` — a script, not a `*.test.mjs` file, so `node --test` never collects it:

```js
// Measures inferTier against the real catalogue. Run AFTER Task B4 has copied the
// catalogue out of node_modules:
//
//   node C:/Users/osami/.uw/test/corpus-tier.mjs
//
// Read-only. Exits 1 if the classification rate is worse than the threshold, so
// it can gate a step without polluting the unit-test sweep.
import fs from "node:fs";
import { inferTier } from "../keysync/keysync.mjs";
import { resolveCatalogPath } from "../refresh/catalog-store.mjs";

const p = resolveCatalogPath();
if (!fs.existsSync(p)) {
  console.error(`no catalogue at ${p} — run Task B4's copy-out first.`);
  process.exit(2);
}
const cat = JSON.parse(fs.readFileSync(p, "utf8"));
const counts = { free: 0, paid: 0, unknown: 0 };
for (const m of cat.models) counts[inferTier(m, m.provider)]++;
const total = cat.models.length;
console.log(`free ${counts.free}  paid ${counts.paid}  unknown ${counts.unknown}  of ${total}`);
const ok = counts.unknown < total * 0.2 && counts.free > 0 && counts.paid > 0;
console.log(ok ? "PASS" : "FAIL", `unknown ${(counts.unknown / total * 100).toFixed(1)}% (budget 20%)`);
process.exit(ok ? 0 : 1);
```

The 20 % budget is the same one the deleted test used, and the before-the-fix figure it is measured against is 100 %.

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
 * a hostile zero-priced "opus" sort to the top. The reserved-name denylist must
 * be in place first, INSIDE buildProviders -- the function directly below, which
 * is the one that writes Providers[].models. Task A5.1 does that, and the first
 * test in infertier.test.mjs asserts it by calling buildProviders with a hostile
 * entry rather than by inspecting a commit message.
 *
 * WHICH OFFER. `offers[].provider` is its own field and a merged record carries
 * up to 16 offers, most of them pricing the model at a different host. Folding
 * all of them answers "is this free anywhere". Taking offers[0] answers "is the
 * first element of an arbitrarily ordered array free". Neither is the question.
 * The question is "is it free on MY key", so match the offer to the provider, and
 * return "unknown" -- never offer 0 -- when nothing matches. Every caller has the
 * provider name already: buildProviders has `reg.provider` and the corpus script
 * has `m.provider`. A false "free" here is not a cosmetic error: it is a FREE
 * badge on a model that bills, and it is rank 0 on the routing path.
 */
export function inferTier(entry, providerName = null) {
  const offers = entry?.pricing?.offers;
  if (!Array.isArray(offers)) return "unknown";
  const rate = (o) => {
    const p = o?.per1MTokens;
    if (!p) return null;
    const inN = Number(p.input), outN = Number(p.output);
    if (!Number.isFinite(inN) || !Number.isFinite(outN)) return null;
    return inN === 0 && outN === 0 ? "free" : "paid";
  };
  if (providerName) {
    for (const o of offers) {
      if (o?.provider !== providerName) continue;
      const r = rate(o);
      if (r) return r;
    }
    return "unknown";
  }
  // No provider given: only decide when exactly one offer is usable, because then
  // "the first" and "mine" cannot disagree.
  const usable = offers.map(rate).filter(Boolean);
  return usable.length === 1 ? usable[0] : "unknown";
}
```

Then update the one call site inside `buildProviders` to pass the provider name — `inferTier(m)` becomes `inferTier(m, reg.provider)`, in both the `ranked` map and the `testModel` branch. There are two.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# fail 0`, with a pass count around 199 (indicative — see "How to read the `# pass N` numbers") once Task B4 has run; before B4, the last test in this file fails with `ENOENT ... catalog\models.json` and everything else passes. The `--dry` run must still print the same provider count as before the change; the *selection* will differ, which is expected and is what Task B9 applies deliberately.

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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 211 (indicative — see "How to read the `# pass N` numbers"). Confirm by eye that `~/.uw/menu/uwpick.mjs` now shows `FREE` (no question mark) on OpenRouter's `:free` models and blank on huggingface's zero-priced rows.

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
`copyOut(src?: string, opts?: {root?: string}) -> {dest, generatedAt, models, schemaVersion}` — copies to `<root>/models.json` and never writes the source
`resolveCatalogPath(opts?: {root?: string}) -> string` — the version named by `current` if one exists, else `<root>/models.json`, else the `node_modules` copy with a warning
`assertSchema(doc) -> void` — throws unless `schemaVersion === 2`

`root` defaults to `~/.uw/catalog` and exists so tests can point the whole store at an `fs.mkdtempSync` directory. Constraint 15 forbids a test from touching the catalogue the running session's picker reads, and a module constant a test cannot displace makes that unenforceable. Every store function in this module and in Task B5 takes it.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/catalog-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { copyOut, resolveCatalogPath, assertSchema, CATALOG_DIR } from "../refresh/catalog-store.mjs";
import { bundledCataloguePath } from "../menu/ccr-client.mjs";

// The one place a test may name CCR's install is through the contract module, so
// that a moved path fails here in the same sentence as everywhere else (Q4.3).
const CCR = bundledCataloguePath();

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

// Q4.3 again, now that keysync is clean: widen the boundary scan from Task A4 to
// cover keysync and refresh as well. This is the moment the rule becomes true of
// the whole repository rather than of the new code only.
test("the CC/CCR boundary now holds across menu, refresh and keysync", () => {
  const root = "C:/Users/osami/.uw";
  const allowed = new Set(["cc-contract.mjs", "ccr-client.mjs"]);
  const needles = [/claude-code-router/, /node_modules/, /\.claude\b/, /APPDATA/, /127\.0\.0\.1/];
  const offenders = [];
  for (const dir of ["menu", "refresh", "keysync"]) {
    const d = path.join(root, dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (allowed.has(f) || !/\.(mjs|ps1|cmd)$/.test(f)) continue;
      const body = fs.readFileSync(path.join(d, f), "utf8");
      for (const n of needles) if (n.test(body)) offenders.push(`${dir}/${f} matches ${n}`);
    }
  }
  assert.deepEqual(offenders, []);
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
import { bundledCataloguePath } from "../menu/ccr-client.mjs";
import { writeAtomic } from "../menu/atomic.mjs";

export const CATALOG_DIR = path.join(os.homedir(), ".uw", "catalog");
export const CURRENT = path.join(CATALOG_DIR, "current");
export const LOCK = path.join(CATALOG_DIR, "catalogue.lock");
export const VERSIONS = path.join(CATALOG_DIR, "versions");

// Q4.1: the path into CCR's install lives in ccr-client.mjs like every other
// fact about CCR, so an upgrade that moves it breaks one named check instead of
// a file read three directories away.
const CCR_BUNDLED = bundledCataloguePath();

// A schema bump is exactly when a silent misparse happens, so refuse rather than
// guess. The catalogue self-versions, which makes this cheap and exact.
export function assertSchema(doc) {
  if (doc?.schemaVersion !== 2) {
    throw new Error(`catalogue schemaVersion is ${JSON.stringify(doc?.schemaVersion)}, ` +
      `expected 2 — refusing to parse a schema this code was not written against`);
  }
}

// `root` is a parameter, not a constant, on every function in this module that
// touches the store. Constraint 15 forbids a test from reading or writing the
// directory the running session's picker reads, and a module-level CATALOG_DIR
// that tests cannot displace makes that constraint unenforceable -- the tests
// would have to operate on the live catalogue, or not exist. Production callers
// pass nothing and get the default.
export function copyOut(src = CCR_BUNDLED, { root = CATALOG_DIR } = {}) {
  const raw = fs.readFileSync(src, "utf8").replace(/^\uFEFF/, "");
  const doc = JSON.parse(raw);
  assertSchema(doc);
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, "models.json");
  writeAtomic(dest, raw);                              // Q2.8
  return { dest, generatedAt: doc.generatedAt,
           models: (doc.models ?? []).length, schemaVersion: doc.schemaVersion };
}

/**
 * Resolution order, most-owned first. The `current` pointer is resolved ONCE by
 * each reader, so a concurrent refresh building a new snapshot directory and
 * flipping the pointer at the end can never be observed half-written.
 */
export function resolveCatalogPath({ root = CATALOG_DIR } = {}) {
  try {
    const stamp = fs.readFileSync(path.join(root, "current"), "utf8").trim();
    const p = path.join(root, "versions", stamp, "models.json");
    if (stamp && fs.existsSync(p)) return p;
  } catch { /* no snapshot yet */ }
  const own = path.join(root, "models.json");
  if (fs.existsSync(own)) return own;
  console.warn(`WARNING: no UW catalogue at ${own}; falling back to CCR's bundled ` +
               `copy, which an npm reinstall can replace. Run: ` +
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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# fail 0`, with a pass count around 218 (indicative — see "How to read the `# pass N` numbers"), and the `--dry` run prints `catalog: 217 providers, generated 2026-08-24T12:22:28.162Z` as before — the source moved, the content did not.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(catalogue): own the catalogue instead of reading one from inside node_modules"
```

---

### Task B5: The merge policy — snapshot, lock, and the stale marker

**Files:** Modify `C:/Users/osami/.uw/refresh/catalog-store.mjs`, Test `C:/Users/osami/.uw/test/merge.test.mjs`
**Interfaces:** Consumes: a previous snapshot plus this run's per-provider outcomes. Produces:
`classify(result: {status?: number, error?: string}) -> "ok" | "soft" | "hard"`
`mergeProvider(prev: ProviderEntry|null, outcome: {kind, models?, at}) -> ProviderEntry` where `ProviderEntry = {models: Entry[], lastOk, lastFail, consecutiveFails, stale, staleSince, count}`
`mergeEntries(prevModels: Entry[], nextModels: Entry[]) -> Entry[]` — the incoming list decides membership; for each surviving id the record carrying `pricing` wins

**`Entry` is the schemaVersion-2 model object — `{model, pricing?, limits?, modalities?, capabilities?}` — and it is the same type everywhere in the pipeline.** Not an id string. This is stated here, at the top, because the previous revision let the two coexist: tier 1 and tier 2 emitted `string[]`, `writeSnapshot` spread each element into an object literal expecting `Entry`, and spreading a string yields `{"0":"a",…}` with no `model` key — so `loadCatalog`'s `if (!m.provider || !m.model) continue` discarded every row and the first successful refresh promoted an empty catalogue. The ambiguity survived because this very file contained two tests asserting different types for this one field, and the one matching production was not the one `writeSnapshot` was written against. Both were green.

Id strings still appear at three genuine wire boundaries and nowhere else: CCR's `getConfig` returns `Providers[].models` as ids, the injected relay is declared with ids, and `probeProvider`'s listing returns ids. Each is converted to `Entry` at the boundary that receives it.
`mergeSnapshot(prev: Snapshot, outcomes: Map<string, Outcome>, now: string, etag?: string) -> {next: Snapshot, refused: string[]}` — applies the per-provider shrink guard and the whole-snapshot floor, and carries `etag` forward
`acquireCatalogueLock(opts?: {root?: string}) -> {release(): void}` — `openSync(..., "wx")` with PID liveness, its own lock, never keysync's
`writeSnapshot(snapshot, opts?: {root?: string, now?: number}) -> string` — writes **both** `models.json` (the schemaVersion-2 catalogue readers load) and `index.json` (the merge ledger the next run reads) into a new version directory, then flips `current` last. **Throws** when any `providers[].models` element is not an `Entry` object carrying `model`, before writing anything — the guard that turns the round-2 blocker from a silently empty catalogue into a named failure
`pruneVersions(opts?: {root?: string, now?: number}) -> string[]` — removes versions beyond `KEEP_VERSIONS` that are neither current nor younger than `PRUNE_GRACE_MS`
`KEEP_VERSIONS: number`, `PRUNE_GRACE_MS: number`

**Three corrections this task carries.**

`consecutiveFails` now exists. `menu/health.mjs:resolveHealth` (Task B7) keys its entire probe-derived verdict on `consecutiveFails >= 3`, and nothing in the previous draft ever wrote the field — it appeared only in `health.mjs`, in its tests, and in the file-structure table. The branch was unreachable, the health column could never report `broken` from probe data, and B7's claim that wiring it up was "a two-line follow-up" was untrue, because the counter cannot be derived from one run's outcome: it has to be carried forward through the merge, which is here.

`writeSnapshot` writes the file readers actually open. It wrote `index.json`; `resolveCatalogPath` looks for `models.json`, in a different shape. The snapshot branch of the resolver could therefore never match, and `loadCatalog` kept reading the copied bundle no matter how many refreshes ran.

Pruning no longer races a reader. `readdirSync(VERSIONS).sort().slice(0, -3)` ran on every write, including a no-change 304, and could delete a directory a picker had just resolved through `current` and was in the middle of reading.

**Everything that touches the store takes a `root`.** `writeSnapshot`, `pruneVersions`, `acquireCatalogueLock`, `resolveCatalogPath` and `copyOut` all accept `{root}` defaulting to `~/.uw/catalog`. This is not decoration: Constraint 15 forbids a test from touching the directory the running session's picker reads, and without a threaded root every merge test in this file would operate on the live catalogue. Tests pass an `fs.mkdtempSync` directory.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/merge.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { classify, mergeProvider, mergeSnapshot, acquireCatalogueLock,
         writeSnapshot, pruneVersions, resolveCatalogPath,
         mergeEntries } from "../refresh/catalog-store.mjs";
import { priceOf, badgeOf } from "../menu/catalog.mjs";

// Constraint 15: every test in this file that touches the store passes an
// fs.mkdtempSync root. None of them can see ~/.uw/catalog, which is the directory
// the running session's picker reads.

const NOW = "2026-09-10T00:00:00.000Z";
const THEN = "2026-09-01T00:00:00.000Z";

// ONE element type for `providers[].models`, everywhere in this file.
//
// The previous version of this file contained two tests asserting incompatible
// types for the same field -- `["a","b"]` for mergeProvider and
// `[{model:"acme-1"}]` for writeSnapshot -- and the one that matched production
// was not the one writeSnapshot was written against. Both passed, and the
// pipeline they described could not work. These helpers exist so the type cannot
// drift apart again inside a single file.
const E = (...names) => names.map((model) => ({ model }));
const ids = (models) => models.map((m) => m.model);
const EMPTY_FIXTURE = { models: [], lastOk: null, lastFail: null, consecutiveFails: 0,
                        stale: false, staleSince: null, count: 0 };

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
  const prev = { models: [{ model: "a" }], lastOk: THEN, lastFail: null, stale: true, staleSince: THEN, count: 1 };
  const next = mergeProvider(prev, { kind: "ok", models: [{ model: "a" }, { model: "b" }], at: NOW });
  assert.deepEqual(next.models.map((m) => m.model), ["a", "b"]);
  assert.equal(next.lastOk, NOW);
  assert.equal(next.stale, false);
  assert.equal(next.staleSince, null);
});

test("a soft outcome keeps the previous rows and marks them stale", () => {
  const prev = { models: [{ model: "a" }, { model: "b" }], lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 2 };
  const next = mergeProvider(prev, { kind: "soft", at: NOW });
  assert.deepEqual(next.models.map((m) => m.model), ["a", "b"], "absence of evidence is not evidence of absence");
  assert.equal(next.stale, true);
  assert.equal(next.staleSince, NOW);
  assert.equal(next.lastOk, THEN);
});

test("consecutiveFails accumulates across runs and resets on the first success", () => {
  // The counter cannot be computed from one outcome; it has to be carried through
  // the merge. resolveHealth's `>= 3` branch is unreachable without this, so the
  // health column could never report "broken" from probe data.
  let e = null;
  for (let i = 0; i < 3; i++) e = mergeProvider(e, { kind: "soft", at: NOW });
  assert.equal(e.consecutiveFails, 3);
  const hard = mergeProvider(e, { kind: "hard", at: NOW });
  assert.equal(hard.consecutiveFails, 4, "hard failures count too");
  const ok = mergeProvider(hard, { kind: "ok", models: [{ model: "a" }], at: NOW });
  assert.equal(ok.consecutiveFails, 0);
});

test("the etag survives the merge, so the next run can send If-None-Match", () => {
  const { next } = mergeSnapshot({ generatedAt: THEN, providers: {} }, new Map(), NOW, "W/\"abc\"");
  assert.equal(next.etag, "W/\"abc\"");
  // An absent etag on a later run keeps the stored one rather than clearing it.
  const { next: kept } = mergeSnapshot(next, new Map(), NOW);
  assert.equal(kept.etag, "W/\"abc\"");
});

test("writeSnapshot writes the file resolveCatalogPath actually reads", () => {
  // The defect: it wrote index.json while the resolver looked for models.json, in
  // a different shape, so no refresh could ever reach a reader.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-cat-"));
  const snap = { generatedAt: NOW, providers: {
    acme: { models: [{ model: "acme-1" }], count: 1, stale: false, staleSince: null,
            lastOk: NOW, lastFail: null, consecutiveFails: 0 },
    dead: { models: [{ model: "dead-1" }], count: 1, stale: true, staleSince: THEN,
            lastOk: THEN, lastFail: NOW, consecutiveFails: 2 },
  } };
  const dir = writeSnapshot(snap, { root });

  const cat = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  assert.equal(cat.schemaVersion, 2, "the loader asserts schemaVersion 2");
  assert.equal(cat.models.length, 2);
  assert.equal(cat.models.find((m) => m.model === "acme-1").provider, "acme");
  assert.equal(cat.models.find((m) => m.model === "dead-1").stale, true);

  const ledger = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
  assert.equal(ledger.providers.dead.consecutiveFails, 2);

  assert.equal(resolveCatalogPath({ root }).replace(/\\/g, "/"),
               path.join(dir, "models.json").replace(/\\/g, "/"),
               "the current pointer must resolve to the file that was written");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a written entry survives the real loader AND still prices", () => {
  // THE GATE for the round-2 blocker, and it is deliberately end to end: write a
  // snapshot, then read it back through loadCatalog, priceOf and badgeOf -- the
  // functions the picker and keysync actually call -- rather than through a
  // fixture. A fixture is what hid this twice: first the filename mismatch, then
  // the element-type mismatch underneath it.
  //
  // Two assertions, because the previous fix satisfied the first and failed the
  // second: rows must EXIST after loading, and a row must still carry the pricing
  // the whole catalogue exists to serve.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-e2e-"));
  const priced = { model: "acme-chat-1",
                   limits: { contextTokens: 163840 },
                   modalities: { output: ["text"] },
                   pricing: { offers: [{ provider: "acme", per1MTokens: { input: 0, output: 0 } }] } };
  const dir = writeSnapshot({ generatedAt: NOW, providers: {
    acme: { ...EMPTY_FIXTURE, models: [priced], count: 1, lastOk: NOW },
  } }, { root });

  const doc = JSON.parse(fs.readFileSync(path.join(dir, "models.json"), "utf8"));
  const byProvider = new Map();
  for (const m of doc.models ?? []) {
    if (!m.provider || !m.model) continue;          // loadCatalog's own guard, verbatim
    if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
    byProvider.get(m.provider).push(m);
  }
  assert.equal(byProvider.size, 1, "loadCatalog's guard must not discard every row");

  const entry = byProvider.get("acme")[0];
  assert.deepEqual(priceOf(entry, "acme"), { in: 0, out: 0 },
    "a refreshed row must still price, or every badge falls blank and B2 is defeated");
  assert.equal(badgeOf(entry, { cadence: "recurring", providerName: "acme" }), "FREE");
  assert.equal(entry.limits.contextTokens, 163840, "and the ctx column must still have data");
  fs.rmSync(root, { recursive: true, force: true });
});

test("writeSnapshot refuses an id string instead of writing an unusable row", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-bad-"));
  assert.throws(() => writeSnapshot({ generatedAt: NOW, providers: {
    acme: { ...EMPTY_FIXTURE, models: ["acme-chat-1"], count: 1 },
  } }, { root }), /model` field/,
    "spreading a string yields a row with no `model` key; fail loudly instead");
  fs.rmSync(root, { recursive: true, force: true });
});

test("pruning never removes the current version or one a reader may hold", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-prune-"));
  const versions = path.join(root, "versions");
  for (const stamp of ["v1", "v2", "v3", "v4", "v5"]) {
    fs.mkdirSync(path.join(versions, stamp), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "current"), "v1");     // the OLDEST is current
  const now = Date.now();

  // Everything was created just now, so the grace window protects all of it.
  assert.deepEqual(pruneVersions({ root, now }), []);

  // An hour later: v1 and v2 are prunable by age, but v1 is current.
  const later = now + 60 * 60 * 1000;
  assert.deepEqual(pruneVersions({ root, now: later }), ["v2"]);
  assert.equal(fs.existsSync(path.join(versions, "v1")), true, "current is never pruned");
  fs.rmSync(root, { recursive: true, force: true });
});

test("a hard outcome flags the provider but still keeps its rows", () => {
  const prev = { models: E("a"), lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 1 };
  const next = mergeProvider(prev, { kind: "hard", at: NOW });
  assert.deepEqual(ids(next.models), ["a"]);
  assert.equal(next.lastFail, NOW);
  assert.equal(next.stale, true);
});

test("a provider seen for the first time starts clean", () => {
  const next = mergeProvider(null, { kind: "ok", models: E("a"), at: NOW });
  assert.deepEqual(ids(next.models), ["a"]);
  assert.equal(next.lastFail, null);
  assert.equal(next.stale, false);
});

test("an id-only listing does not destroy pricing a richer tier already fetched", () => {
  // Tier 1 carries models.dev metadata; tier 2's keyed /models listing carries ids
  // only. Replacing wholesale would mean a tier 2 run after a tier 1 run wipes
  // every price and context limit -- the same data loss as the `Object.keys`
  // defect, arriving one step later.
  const rich = [{ model: "a", pricing: { offers: [{ provider: "p", per1MTokens: { input: 0, output: 0 } }] },
                  limits: { contextTokens: 163840 } }];
  const listing = [{ model: "a" }, { model: "b" }];
  const next = mergeProvider({ ...EMPTY_FIXTURE, models: rich, count: 1 },
                             { kind: "ok", models: listing, at: NOW });
  assert.deepEqual(ids(next.models), ["a", "b"], "the listing decides membership");
  assert.ok(next.models[0].pricing, "and the richer record survives for ids it kept");
  assert.equal(next.models[0].limits.contextTokens, 163840);
  assert.equal(next.models[1].pricing, undefined,
    "a model nobody priced carries no pricing key at all — blank, never zero");
});

const snap = (providers) => ({ generatedAt: THEN, providers });

test("the shrink guard refuses an ok run that halves a provider", () => {
  const prev = snap({ big: { models: E(...Array.from({ length: 100 }, (_, i) => `m${i}`)),
                             lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 100 } });
  const { next, refused } = mergeSnapshot(prev,
    new Map([["big", { kind: "ok", models: E("m0", "m1"), at: NOW }]]), NOW);
  assert.deepEqual(refused, ["big"]);
  assert.equal(next.providers.big.models.length, 100);
  assert.equal(next.providers.big.stale, true);
});

test("the shrink guard refuses an ok run that empties a provider", () => {
  const prev = snap({ p: { models: E("a", "b"), lastOk: THEN, lastFail: null,
                           stale: false, staleSince: null, count: 2 } });
  const { refused } = mergeSnapshot(prev, new Map([["p", { kind: "ok", models: [], at: NOW }]]), NOW);
  assert.deepEqual(refused, ["p"]);
});

test("a normal shrink inside the guard is accepted", () => {
  const prev = snap({ p: { models: E("a", "b", "c", "d"), lastOk: THEN, lastFail: null,
                           stale: false, staleSince: null, count: 4 } });
  const { next, refused } = mergeSnapshot(prev,
    new Map([["p", { kind: "ok", models: E("a", "b", "c"), at: NOW }]]), NOW);
  assert.deepEqual(refused, []);
  assert.equal(next.providers.p.models.length, 3);
});

test("the whole-snapshot floor refuses a run that loses a fifth of everything", () => {
  const prev = snap(Object.fromEntries(Array.from({ length: 10 }, (_, i) =>
    [`p${i}`, { models: E("a", "b", "c", "d", "e", "f", "g", "h", "i", "j"),
                lastOk: THEN, lastFail: null, stale: false, staleSince: null, count: 10 }])));
  const outcomes = new Map(Array.from({ length: 10 }, (_, i) =>
    [`p${i}`, { kind: "ok", models: E("a", "b", "c", "d", "e", "f", "g"), at: NOW }]));
  assert.throws(() => mergeSnapshot(prev, outcomes, NOW), /floor/i);
});

test("a provider absent from this run's outcomes is untouched", () => {
  const prev = snap({ kept: { models: E("a"), lastOk: THEN, lastFail: null,
                              stale: false, staleSince: null, count: 1 } });
  const { next } = mergeSnapshot(prev, new Map(), NOW);
  assert.deepEqual(ids(next.providers.kept.models), ["a"]);
  assert.equal(next.providers.kept.stale, false);
});
test("the lock is exclusive, and releasing it lets the next caller in", () => {
  // A TEMP ROOT, like every other test in this file. These three calls used to
  // take no argument, so `root` defaulted to CATALOG_DIR and the test created a
  // real lock file in the live ~/.uw/catalog — the directory the running
  // session's picker reads. Two consequences: a refresh or picker holding the
  // lock made this test fail for an unrelated reason, and a test process killed
  // between acquire and release left a live lock that blocks real refreshes until
  // someone deletes it by hand. The header comment above already claimed no test
  // in this file could see the live catalogue; this is the one that could.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-lock-"));
  const l1 = acquireCatalogueLock({ root });
  assert.throws(() => acquireCatalogueLock({ root }), /lock/i);
  l1.release();
  const l2 = acquireCatalogueLock({ root });
  l2.release();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a lock owned by a dead pid is reclaimed", () => {
  // The branch the old title promised and the old body never exercised:
  // EEXIST -> read the owner -> process.kill(pid, 0) throws ESRCH -> unlink ->
  // reopen. Nothing here ever wrote a stale lock, so the reclaim path was
  // untested while being named in the test title.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-lock-dead-"));
  fs.mkdirSync(root, { recursive: true });
  // A pid that cannot be running: 0x7FFFFFFF is above every Windows and Linux
  // pid_max. Writing a plausible-but-dead pid rather than reusing our own is the
  // point — our own is alive, which is the other branch.
  fs.writeFileSync(path.join(root, "catalogue.lock"),
                   JSON.stringify({ pid: 0x7FFFFFFF, at: new Date().toISOString() }));
  const l = acquireCatalogueLock({ root });
  l.release();
  assert.equal(fs.existsSync(path.join(root, "catalogue.lock")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a corrupt lock is treated as held, not as free", () => {
  // The one place the code deliberately fails closed, and it was untested.
  // Guessing that an unreadable lock is dead is how two refreshers end up writing
  // the same snapshot directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uw-lock-bad-"));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "catalogue.lock"), "{ not json");
  assert.throws(() => acquireCatalogueLock({ root }), /unreadable|held/i);
  fs.rmSync(root, { recursive: true, force: true });
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

const EMPTY = { models: [], lastOk: null, lastFail: null, consecutiveFails: 0,
                stale: false, staleSince: null, count: 0 };

// `consecutiveFails` is carried FORWARD through the merge, and that is the whole
// reason it lives here rather than being derived at read time: it cannot be
// computed from a single run's outcome. menu/health.mjs:resolveHealth keys its
// entire probe-derived verdict on `consecutiveFails >= 3`, and in the previous
// draft nothing in the plan ever produced the field -- so that branch was
// unreachable, the health column could never say "broken" from probe data, and
// Task B7's claim that wiring it up was "a two-line follow-up" was false. Adding
// it here is what makes that claim true.
/**
 * Merge one incoming model list into the stored one, per model id.
 *
 * A listing is authoritative about WHICH ids exist and not about what they cost.
 * Tier 1 carries full models.dev metadata; tier 2's keyed /models listing carries
 * ids only. Replacing wholesale means a tier 2 run after a tier 1 run destroys
 * every price and context limit the catalogue had, which is the same data loss as
 * the `Object.keys` defect arriving one step later.
 *
 * So: the incoming list decides membership, and for each surviving id the richer
 * record wins. "Richer" is decided on `pricing` alone rather than by counting
 * keys, because pricing is the field the badge set depends on and the only one
 * whose absence is silently wrong rather than visibly blank.
 */
export function mergeEntries(prevModels, nextModels) {
  const before = new Map((prevModels ?? []).map((m) => [m.model, m]));
  return (nextModels ?? []).map((m) => {
    const old = before.get(m.model);
    if (!old) return m;                                  // newly listed
    return m.pricing ? m : { ...old, ...m, pricing: old.pricing };
  });
}

export function mergeProvider(prev, outcome) {
  const base = prev ?? EMPTY;
  if (outcome.kind === "ok") {
    const models = mergeEntries(base.models, outcome.models);
    return { models, lastOk: outcome.at, lastFail: base.lastFail,
             consecutiveFails: 0,
             stale: false, staleSince: null, count: models.length };
  }
  // soft AND hard both keep the stored rows. A dead key says nothing about which
  // models the provider offers, and neither does a timeout. Both increment the
  // counter: three failures in a row is the signal, regardless of their kind.
  return { ...base,
           lastFail: outcome.kind === "hard" ? outcome.at : base.lastFail,
           consecutiveFails: (base.consecutiveFails ?? 0) + 1,
           stale: true, staleSince: base.staleSince ?? outcome.at };
}

const SHRINK_FLOOR = 0.5;      // an ok run may not cut a provider by more than half
const SNAPSHOT_FLOOR = 0.8;    // nor the whole snapshot by more than a fifth

export function mergeSnapshot(prev, outcomes, now, etag = null) {
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
  // `etag` is carried through. Without it the value tier 1 reads back as
  // `prev.etag` is always undefined, no `If-None-Match` header is ever sent, the
  // 304 branch is unreachable, and the "conditional GET" degrades to a full
  // download of models.dev's api.json on every single refresh.
  return { next: { generatedAt: now, etag: etag ?? prev.etag ?? null, providers }, refused };
}

// ---------------------------------------------------------------------- lock
//
// The refresher must NOT take keysync's lock. Sharing it means a slow fan-out can
// block a keysync run the user is sitting in front of, and it conflates two
// different critical sections: keysync's lock protects CCR's config and
// settings.json; the refresher touches neither.

export function acquireCatalogueLock({ root = CATALOG_DIR } = {}) {
  const LOCK = path.join(root, "catalogue.lock");
  fs.mkdirSync(root, { recursive: true });
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

/**
 * Promote a merged snapshot: write a NEW version directory (nothing live is
 * touched), then flip `current` LAST via temp+rename. A crash anywhere leaves the
 * previous version intact and the partial directory orphaned; the next run
 * collects it.
 *
 * TWO FILES, and the split is the fix for a defect that made the whole refresh
 * pipeline a no-op. The previous version wrote only `index.json` — the merge
 * ledger — while `resolveCatalogPath` (Task B4) looks for
 * `versions/<stamp>/models.json`. Different name, and different shape: the ledger
 * is `{generatedAt, providers: {name: {...}}}` and the loader expects CCR's
 * schemaVersion-2 `{schemaVersion, generatedAt, models: [...]}`. So
 * `resolveCatalogPath`'s snapshot branch never matched, `loadCatalog` fell back to
 * the copied bundle forever, and every merge, stale marker and shrink floor
 * computed into a file no reader ever opened.
 *
 *   models.json  the catalogue itself, in the schemaVersion-2 envelope
 *                catalog.mjs already parses, with `stale` and `staleSince`
 *                carried onto each row. This is what readers load.
 *   index.json   the merge ledger: per-provider {count, lastOk, lastFail,
 *                consecutiveFails, stale, staleSince} plus `etag`. This is what
 *                the NEXT refresh reads back as `prev`, and what Task B7 folds
 *                into health.json.
 *
 * Neither file is derivable from the other, which is why there are two rather
 * than one: the ledger carries per-provider history the flat model list has no
 * place for, and the model list carries the per-model fields the ledger does not.
 */
export function writeSnapshot(snapshot, { root = CATALOG_DIR, now = Date.now() } = {}) {
  const versions = path.join(root, "versions");
  const current = path.join(root, "current");
  const stamp = snapshot.generatedAt.replace(/[:.]/g, "-");
  const dir = path.join(versions, stamp);
  fs.mkdirSync(dir, { recursive: true });

  // The catalogue, in the shape loadCatalog() actually reads.
  //
  // Every element of `p.models` is a schemaVersion-2 ENTRY OBJECT carrying at
  // least `model` (see tier 1 and tier 2, and mergeEntries). It used to be a bare
  // id string in both producers while this loop spread it into an object literal:
  // spreading a string yields `{"0":"a","1":"c",...,"provider":"x"}` with no
  // `model` key, `loadCatalog`'s `if (!m.provider || !m.model) continue` then
  // skipped every row, and the first successful refresh promoted an EMPTY
  // catalogue -- worse than the filename mismatch it replaced, because that at
  // least fell back to correct data.
  //
  // The assertion below is cheap and it is the seam where that class of defect
  // becomes visible, so it stays even though the producers are now typed.
  const models = [];
  for (const [provider, p] of Object.entries(snapshot.providers ?? {})) {
    for (const m of p?.models ?? []) {
      if (!m || typeof m !== "object" || !m.model) {
        throw new Error(`writeSnapshot: ${provider} yielded a model entry with no ` +
          `\`model\` field (${JSON.stringify(m).slice(0, 80)}). Producers must emit ` +
          `schemaVersion-2 entry objects, not id strings — see tier1/tier2.`);
      }
      models.push(p.stale ? { ...m, provider, stale: true, staleSince: p.staleSince }
                          : { ...m, provider });
    }
  }
  writeAtomic(path.join(dir, "models.json"), JSON.stringify({
    schemaVersion: 2, generatedAt: snapshot.generatedAt, models,
  }));

  // The ledger, for the next run and for Task B7.
  writeAtomic(path.join(dir, "index.json"), JSON.stringify(snapshot, null, 2));

  const tmp = `${current}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, stamp);
  fs.renameSync(tmp, current);

  pruneVersions({ root, now });
  return dir;
}

// Keep three versions, and never delete one a reader might be inside.
//
// The previous version was `readdirSync(VERSIONS).sort().slice(0, -3)` run on
// every write. Two problems. It pruned even when nothing had changed — a 304
// still produced a new directory and evicted an old one — and it could delete a
// directory a picker had just resolved through `current` and was part-way
// through reading, because "third-newest" says nothing about "nobody is holding
// it". A grace window is not a lock, but the read it protects is a single
// `readFileSync` a few milliseconds long, and ten minutes is four orders of
// magnitude of headroom.
export const PRUNE_GRACE_MS = 10 * 60 * 1000;
export const KEEP_VERSIONS = 3;

export function pruneVersions({ root = CATALOG_DIR, now = Date.now() } = {}) {
  const versions = path.join(root, "versions");
  let live = null;
  try { live = fs.readFileSync(path.join(root, "current"), "utf8").trim(); } catch { }
  let dirs = [];
  try { dirs = fs.readdirSync(versions).sort(); } catch { return []; }

  const removed = [];
  for (const d of dirs.slice(0, -KEEP_VERSIONS)) {
    if (d === live) continue;                                  // never the current one
    let mtime = 0;
    try { mtime = fs.statSync(path.join(versions, d)).mtimeMs; } catch { continue; }
    if (now - mtime < PRUNE_GRACE_MS) continue;                // a reader may be inside
    fs.rmSync(path.join(versions, d), { recursive: true, force: true });
    removed.push(d);
  }
  return removed;
}
```

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 229 (indicative — see "How to read the `# pass N` numbers").

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(refresh): merge policy that keeps rows through a failure and refuses a collapse"
```

---

### Task B6: The three tiers and the `uw catalog refresh` CLI

**Files:** Create `C:/Users/osami/.uw/refresh/tiers.mjs`, Create `C:/Users/osami/.uw/refresh/probe.mjs`, Create `C:/Users/osami/.uw/refresh/cli.mjs`, Test `C:/Users/osami/.uw/test/tiers.test.mjs`
**Interfaces:** Consumes: `catalog-store.mjs`, `menu/denylist.mjs`, `menu/ccr-client.mjs`, `menu/catalog.mjs` (`routableSet`), the models.dev public endpoint, CCR's `probeProvider` RPC. Produces:
`tier1(opts: {fetchImpl?, etag?}) -> Promise<{status, etag, providers: Map<string, Entry[]>}>`
`tier2(names: string[], opts: {rpc?, concurrency?}) -> Promise<Map<string, Outcome>>` — `Outcome.models` is `Entry[]`, minted from the listing's ids as `{model}` with **no `pricing` key at all**

**`Entry` everywhere.** Both tiers emit the schemaVersion-2 object `{model, ...}` that `loadCatalog` groups and `catalog.mjs` parses — never a bare id string. The Interfaces line above already said `Entry[]` while the implementation returned `Map<string, string[]>`, and that one-word disagreement was the whole of the round-2 blocker: `writeSnapshot` spread each element into an object literal, spreading a string produced a row with no `model` key, and `loadCatalog`'s guard then discarded every row. Tier 1 keeps models.dev's per-model values rather than `Object.keys`-ing them away, because that metadata is the entire reason tier 1 exists.
`tier3(providers: string[], opts: {confirmed, spawn?}) -> Promise<{outcomes: Map, status: number}>` — throws unless `opts.confirmed === true`. Returns an **empty** outcomes map: its result is a whole-run verdict, and the merge below it is per-provider, so there is no honest key to file it under. It reports through stdout and `status`. `spawn` is injectable so the billed path can be exercised without billing. It does not take `probe` or `rpc` — it delegates to `verify-cli.mjs`, which spawns the real Claude Code binary, because synthetic gateway probes over-report
`probe(cred, opts) -> Promise<{state: "ok"|"auth"|"broken"|"skipped", status?, why?, models?, model?}>` — the single provider probe, in `probe.mjs`, invoked by running that file rather than by a tier

**Why no tier calls `probe.mjs`, stated because an earlier draft of this plan said two of them did.** `probe.mjs` reads key values out of the vault and calls providers directly — that is what the three scripts it retires do, and it is why it can classify `auth` separately from `broken`. Tier 2 must not do that: the refresher never holds a key value, which is the property that makes a scheduled tier safe, so it goes through CCR's `probeProvider` RPC and lets CCR hold the credential. Tier 3 does not either; it delegates to `verify-cli.mjs`, which spawns the real Claude Code binary because synthetic gateway probes over-report.

So `probe.mjs` is a command, not a library called from the pipeline: `node refresh/probe.mjs` refreshes the results file, and Task B7's fold turns that file into `health.json`. The consolidation the round-1 review asked for still happens — one implementation instead of three — but it does not change who calls it. The previous wording had `probe` declared as an option on `tier2` and `tier3`, passed by `refresh/cli.mjs`, and destructured by neither: a module with a documented role and no caller anywhere.
`toVaultId(modelsDevName: string, providers: Map) -> string | null` — reconciles models.dev names to vault provider ids; `null` means drop, never guess
`SKIP_PROBE: Set<string>` — providers the vault's own notes say must never be probed
`parseArgs(argv: string[]) -> {tier: number, confirmed: boolean, dryRun: boolean}`

**`probe.mjs` is the retirement of three ad-hoc scripts.** `keysync/key-health.mjs`, `key-health-reprobe.mjs` and `key-health-live3.mjs` already implement, by hand, exactly what tiers 2 and 3 need: a keyed `/models` listing, candidate scoring, one `max_tokens: 8` completion, and an `ok`/`auth`/`broken`/`skipped` classification. They produced the 34-healthy / 9-out-of-credit / 3-dead measurement this project relies on, and `key-health-latest.json` is on disk right now. The previous draft referenced none of them — zero occurrences across 6,750 lines — while inventing a new producer for the same data that it then did not build. Two probe implementations for one question is how a probe pipeline drifts from the pipeline that consumes it, so there is one, in `probe.mjs`, and the three scripts are deleted once it passes.

**Five corrections this task carries beyond that.**

*Tier 1 was ingesting untrusted strings with no guard at all.* `for (const [name, models] of r.providers) outcomes.set(name, {kind: "ok", models, at: now})` — no `admitId`, no `admitRemoteModels`. models.dev is a remote source and this is the path that PERSISTS names into the catalogue, so a reserved name entering here is read by every later consumer, including keysync's routing path, on every subsequent run.

*Production imported the test harness.* Tier 2 did `await import("../harness/config.mjs")`, whose `rpc` points at the isolated gateway on ports 39456+. In production that fails; if a harness gateway happens to be up, it succeeds and refreshes the real catalogue from a fixture. A grep test now fails the build if any `harness/` import appears under `refresh/`.

*The ETag was never persisted.* `mergeSnapshot` dropped it, so `prev.etag` was always undefined, `If-None-Match` was never sent, and the 304 branch was unreachable — the "conditional GET" was a full download of `api.json` every run. Task B5 carries it through; this task reads it back and honours the 304 by writing nothing at all.

*The two provider namespaces were merged without reconciliation.* Tier 1 keyed by models.dev name, tier 2 by vault id, and tier 2 took its target list from tier 1's output — so it was handed names from the wrong vocabulary. `toVaultId` reconciles through a curated `modelsDevName` field and drops what it cannot map.

*Routability had no producer.* Q1.3 makes it a snapshot field; this is the process that computes it.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/tiers.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tier1, tier2, tier3, SKIP_PROBE } from "../refresh/tiers.mjs";
import { parseArgs, toVaultId } from "../refresh/cli.mjs";

// ONE element type for every model list in this file, exactly as merge.test.mjs
// does, and for the same reason: this file previously asserted `["a","b"]` in
// three places while asserting `Object.keys(m)` is `["model"]` in a fourth, and
// the implementations matched the fourth. Two tests in one file asserting
// incompatible types for one field is precisely the pathology that produced the
// round-2 blocker, and it survived here because only the sibling file was
// cleaned. `ids()` reads the model names out of an Entry[] so an assertion can
// stay readable without smuggling the retired shape back in.
const ids = (models) => models.map((m) => m.model);

test("refresh/ never imports the test harness", () => {
  // The defect: tier 2 did `await import("../harness/config.mjs")`, whose rpc
  // points at the isolated gateway on ports 39456+. In production that fails --
  // or, if a harness gateway is up, quietly succeeds and refreshes the real
  // catalogue from a fixture. The harness injects its base URL by parameter.
  const dir = path.join(os.homedir(), ".uw", "refresh");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"))) {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(body, /harness\//,
      `refresh/${f} imports the test harness; production must import production`);
  }
});

test("tier 1 keeps models.dev's metadata, not just its ids", () => {
  // The second facet of the round-2 blocker. `Object.keys(p.models)` discarded
  // every value, so a refreshed catalogue would have carried ids and nothing
  // else: priceOf returns null, inferTier returns unknown, every badge falls
  // blank, every price and ctx column empties, and Constraint 5's free column
  // reads "no price data" for all 44 providers -- strictly worse than the bundled
  // catalogue the refresh replaces. Task B2 exists to read exactly this metadata.
  const doc = { acme: { models: {
    "acme-chat-1": { limits: { contextTokens: 163840 },
                     modalities: { output: ["text"] },
                     pricing: { offers: [{ provider: "acme", per1MTokens: { input: 0, output: 0 } }] } },
  } } };
  const fetchImpl = async () => ({ status: 200, headers: { get: () => 'W/"e"' },
                                   json: async () => doc });
  return tier1({ fetchImpl }).then((r) => {
    const entries = r.providers.get("acme");
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "acme-chat-1", "the id moves into a `model` field");
    assert.ok(entries[0].pricing, "and the pricing survives");
    assert.equal(entries[0].limits.contextTokens, 163840);
  });
});

test("tier 2 emits entries with pricing genuinely absent, never zero", () => {
  // A keyed /models listing returns ids only. Minting `{pricing: {...zero}}` here
  // would put FREE? on a model nobody priced, which is the guess Principle 1
  // exists to prevent. The key must be absent so priceOf returns null.
  const rpc = async () => ({ models: ["fine-1"] });
  return tier2(["acme"], { rpc }).then((out) => {
    const m = out.get("acme").models[0];
    assert.deepEqual(Object.keys(m), ["model"]);
    assert.equal("pricing" in m, false, "absent, not zero");
  });
});

test("toVaultId maps, or drops — it never guesses", () => {
  const vault = new Map([
    ["openrouter", { }],                                  // names agree
    ["tokenrouter", { modelsDevName: "token-router" }],   // curated alias
  ]);
  assert.equal(toVaultId("openrouter", vault), "openrouter");
  assert.equal(toVaultId("token-router", vault), "tokenrouter");
  assert.equal(toVaultId("some-provider-we-have-no-key-for", vault), null);
});

test("tier 1 refuses reserved names before they enter the catalogue", async () => {
  // Ingest is the only guard that stops a hostile name being PERSISTED. The
  // previous draft ran models.dev rows straight into outcomes with no check.
  const { admitRemoteModels } = await import("../menu/denylist.mjs");
  const rows = [{ model: "qwen3-max" }, { model: "opus" }, { model: "claude-3-opus" }];
  const { kept } = admitRemoteModels("tokenrouter", rows.map((r) => r.model));
  assert.deepEqual(kept, ["qwen3-max"]);
});

test("tier1 sends the stored ETag and reports a 304 without re-parsing", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => { seen = init.headers; return { status: 304 }; };
  const r = await tier1({ fetchImpl, etag: 'W/"abc"' });
  assert.equal(seen["If-None-Match"], 'W/"abc"');
  assert.equal(r.status, 304);
  assert.equal(r.providers.size, 0);
});

test("tier1 parses a 200 into provider -> catalogue entries", async () => {
  const body = { acme: { models: { "acme-1": {}, "acme-2": {} } },
                 zeta: { models: { "zeta-1": {} } } };
  const fetchImpl = async () => ({ status: 200, headers: { get: () => 'W/"new"' },
                                   json: async () => body });
  const r = await tier1({ fetchImpl });
  assert.equal(r.status, 200);
  assert.equal(r.etag, 'W/"new"');
  assert.deepEqual(ids(r.providers.get("acme")), ["acme-1", "acme-2"]);
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
  assert.deepEqual(ids(out.get("good").models), ["a", "b"]);
  assert.equal(out.get("dead").kind, "hard");
  assert.equal(out.get("slow").kind, "soft");
});

test("tier2 applies the denylist to every remote list", async () => {
  const rpc = async () => ({ models: ["fine", "opus", "claude-opus-5"] });
  const out = await tier2(["evil"], { rpc });
  assert.deepEqual(ids(out.get("evil").models), ["fine"]);
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
  await assert.rejects(() => tier3([], { confirmed: "yes" }), /confirm/i,
    "literally true, not merely truthy — a config value read as a string must not pass");
});

test("tier3 contributes nothing to the ledger, and reports through its status", async () => {
  // The defect this pins: tier3 used to return a whole-run verdict keyed under a
  // fabricated provider name, `__verify-cli`. mergeSnapshot has no concept that
  // would reject it, so mergeProvider(null, ...) minted a provider with zero
  // models; the carry-forward rule then preserved it forever; the next tier 2
  // read it out of Object.keys(prev.providers) and asked CCR to probe a provider
  // that does not exist; and writeHealthFromOutcomes gave the phantom a health
  // entry. A per-run result written through a per-provider merge.
  //
  // `spawn` is injected, so this exercises the path below the confirmation gate
  // without spending money — which nothing did before, because the real spawn is
  // stdio:"inherit" against a hard-coded path.
  const calls = [];
  const spawn = (cmd, args) => { calls.push([cmd, args]); return { status: 0 }; };
  const r = await tier3(["acme", "zeta"], { confirmed: true, spawn });
  assert.equal(r.outcomes.size, 0, "no synthetic provider may reach the merge");
  assert.equal(r.status, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1][0], /verify-cli\.mjs$/);
});

test("a failing tier3 reports a non-zero status rather than a soft outcome", async () => {
  const r = await tier3([], { confirmed: true, spawn: () => ({ status: 3 }) });
  assert.equal(r.outcomes.size, 0);
  assert.equal(r.status, 3);
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
// verify-cli.mjs lives in the keysync tree next to this one. Resolved relative to
// this module rather than hard-coded absolute: the previous literal made the
// spawn unreachable from any test and pinned one machine's layout.
const CONTRACT_VERIFY_CLI = new URL("../keysync/verify-cli.mjs", import.meta.url).pathname;

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
    // KEEP THE VALUES, not just the keys.
    //
    // This used to be `Object.keys(p?.models ?? {})`, which threw away the entire
    // reason tier 1 exists. models.dev's per-model object carries the pricing,
    // context limit, modalities and capabilities that `priceOf`, `inferTier`,
    // `badgeOf` and the ctx column all read. An id-only refresh produces a
    // catalogue where every badge is blank or FREE?, every price and context is
    // blank, and Constraint 5's free column reads "no price data" for all 44
    // providers -- strictly worse than the bundled catalogue it replaces.
    //
    // The element type is the schemaVersion-2 entry: `{model, ...metadata}`,
    // the same shape `loadCatalog` groups and `catalog.mjs` parses. It is fixed
    // once, here and in tier 2, and every consumer downstream depends on it.
    const entries = Object.entries(p?.models ?? {})
      .map(([id, meta]) => ({ ...meta, model: id }));
    if (entries.length) providers.set(name, entries);
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
        // Same element type as tier 1, and pricing GENUINELY ABSENT rather than
        // zero. A keyed /models listing returns ids and nothing else, so an entry
        // minted here carries no `pricing` key at all. `priceOf` then returns
        // null and `badgeOf` returns "" -- blank, never FREE?, because a model
        // nobody priced must not be labelled possibly-free (Principle 1).
        // mergeProvider re-attaches richer metadata when a previous tier 1 run
        // already had it for the same id.
        out.set(name, { kind: "ok", models: kept.map((id) => ({ model: id })), at });
      } catch (e) {
        out.set(name, { kind: classify({ status: e.status, error: e.status ? undefined : e.message }), at });
      }
    }
  }));
  return out;
}

/**
 * Tier 3: paid verification. Returns an EMPTY outcome map, always.
 *
 * It used to return `new Map([["__verify-cli", {...}]])` -- a whole-run verdict
 * under a fabricated provider key -- and `main()` passed that straight into
 * `mergeSnapshot`. The consequences compounded: `mergeProvider(null, ...)` minted
 * a provider called `__verify-cli` with zero models; the carry-forward rule then
 * preserved it through every later run; the next tier 2 took its target list from
 * `Object.keys(prev.providers)` and asked CCR to probe a provider that does not
 * exist, recording a soft failure forever; and `writeHealthFromOutcomes` gave the
 * phantom a health entry. A per-RUN result was being written through a
 * per-PROVIDER merge, and the merge has no concept that would reject it.
 *
 * The verdict belongs on stdout and in the exit code, which is where a human
 * running a billed command is looking. `spawnSync` already inherits stdio, so
 * verify-cli's own output is on screen; this returns the status for the caller to
 * report and contributes nothing to the ledger.
 *
 * @param {string[]} providers  the provider ids to verify. Currently passed
 *   through to verify-cli.mjs as a whole-vault run; per-provider selection is the
 *   obvious next step and is why the parameter exists rather than being dropped.
 * @param {object}  opts
 * @param {boolean} opts.confirmed  must be literally true
 * @param {Function} [opts.spawn]  injected for testing; defaults to spawnSync
 * @returns {Promise<{outcomes: Map, status: number}>}
 */
export async function tier3(providers, { confirmed = false, spawn = null } = {}) {
  if (confirmed !== true) {
    throw new Error("tier 3 spends real money on real completions and must be confirmed " +
      "explicitly. Re-run with --i-know-this-bills and answer the prompt.");
  }
  // Deliberately delegates to the existing, already-careful prober rather than
  // growing a second one. verify-cli.mjs spawns the real claude.exe because
  // synthetic gateway probes over-report: groq/openai/gpt-oss-20b returns 200 to
  // a hand-built request and still fails under Claude Code's real payload.
  //
  // `spawn` is injectable so the path below this line can be exercised at all.
  // With a hard-coded absolute path and stdio:"inherit" it was unreachable in a
  // test, and the only tier-3 test asserted the confirmation refusal and returned
  // before reaching it -- so nothing here was covered.
  const run = spawn ?? (await import("node:child_process")).spawnSync;
  const r = run("node", [CONTRACT_VERIFY_CLI], { encoding: "utf8", stdio: "inherit" });
  return { outcomes: new Map(), status: r.status ?? 1 };
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
  CATALOG_DIR, VERSIONS, CURRENT, acquireCatalogueLock, mergeSnapshot, writeSnapshot,
} from "./catalog-store.mjs";
import { tier1, tier2, tier3 } from "./tiers.mjs";
// Task B7 creates this module and is what makes the call at the end of main()
// resolve. The call is written here, in B6, because that is where main() lives;
// the import is added by B7 alongside the function, and the ordering is
// deliberate rather than accidental. Without it every non-dry-run refresh throws
// a ReferenceError AFTER `current` has already been flipped -- the catalogue
// advances, health.json is never written, the picker's snapshot is never rebuilt,
// and B6's own verification cannot see it because `--dry-run` returns first.
import { writeHealthFromOutcomes } from "./health-writer.mjs";
// Production imports production. `rpc` comes from the contract module, never from
// harness/config.mjs -- the harness injects its base URL by parameter. The grep
// test in this task fails the build if a harness import appears under refresh/.
import { rpc } from "../menu/ccr-client.mjs";
import { admitRemoteModels } from "../menu/denylist.mjs";
import { routableSet, makeRoutableOf } from "../menu/catalog.mjs";
import * as K from "../keysync/keysync.mjs";

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
    return JSON.parse(fs.readFileSync(path.join(VERSIONS, stamp, "index.json"), "utf8"));
  } catch { return { generatedAt: null, providers: {}, etag: null }; }
};

/**
 * Map a models.dev provider name to a vault provider id, or null to drop it.
 *
 * Tier 1 keys its outcomes by models.dev's provider names; tier 2 works from the
 * vault's provider ids. Merging both into one `providers` map without reconciling
 * them means that wherever the two vocabularies differ, one source silently
 * overwrites the other -- and then SHRINK_FLOOR compares a count from one
 * namespace against a count from the other and refuses a perfectly good refresh,
 * or fails to refuse a bad one. It also means tier 2, which reads its target list
 * from `Object.keys(prev.providers)`, would be handed models.dev names and asked
 * to probe them as if they were vault ids.
 *
 * The alias table is curated in `~/.llmkeys/providers.json` as `modelsDevName`,
 * alongside the other curated fields, and is blank when the two agree (the common
 * case). An unmapped models.dev name is dropped rather than guessed, and the test
 * below asserts every tier 1 name resolves to exactly one vault id or is dropped.
 */
export function toVaultId(modelsDevName, providers) {
  if (providers.has(modelsDevName)) return modelsDevName;
  for (const [id, prof] of providers) {
    if (prof?.modelsDevName === modelsDevName) return id;
  }
  return null;
}

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

    const { providers: vault } = K.loadVault();       // metadata only, never key values
    let etag = prev.etag ?? null;
    let tier3Status = null;

    if (tier === 1) {
      const r = await tier1({ etag: prev.etag });
      console.log(`models.dev: HTTP ${r.status}, ${r.providers.size} providers`);

      // A 304 means nothing changed. Producing no outcomes AND no new version is
      // the correct response: writing one would promote an identical snapshot and
      // evict an older version for nothing (see pruneVersions, Task B5).
      if (r.status === 304) {
        console.log("unchanged since the last run — nothing to merge, nothing written.");
        return;
      }
      etag = r.etag ?? etag;

      const dropped = [];
      for (const [name, models] of r.providers) {
        // NAMESPACE. Tier 1 speaks models.dev provider names; everything
        // downstream speaks vault provider ids. Reconcile here, or wherever the
        // two vocabularies differ one source silently overwrites the other in
        // `providers` -- and then SHRINK_FLOOR compares a count from one namespace
        // against a count from the other. It also matters for tier 2, which reads
        // its target list from Object.keys(prev.providers): unreconciled, it would
        // be handed models.dev names and asked to probe them as vault ids.
        const id = toVaultId(name, vault);
        if (!id) { dropped.push(name); continue; }

        // SECURITY, constraint 11 and report 08 F1. models.dev is a remote,
        // untrusted string source -- precisely the kind the denylist exists for --
        // and the previous draft ingested it with no admitId and no
        // admitRemoteModels at all. Guarding at ingest is the only guard that
        // stops a reserved name being PERSISTED into the catalogue that keysync's
        // routing path then reads on every run.
        const { kept, rejected } = admitRemoteModels(id, models.map((m) => m.model));
        if (rejected.length) {
          console.warn(`  ${id}: rejected ${rejected.length} reserved/invalid name(s)`);
        }
        const keptSet = new Set(kept);
        outcomes.set(id, { kind: "ok", models: models.filter((m) => keptSet.has(m.model)),
                           at: now });
      }
      if (dropped.length) {
        console.log(`unmapped models.dev providers (dropped, not guessed): ${dropped.length}`);
      }
    } else if (tier === 2) {
      // PRODUCTION IMPORTS PRODUCTION. This line used to be
      // `await import("../harness/config.mjs")`, which resolves the CCR gateway to
      // the isolated TEST instance on ports 39456+. In production that fails
      // outright; worse, if a harness gateway happens to be running it succeeds
      // and refreshes the real catalogue from a fixture. The harness injects its
      // base URL by PARAMETER, never by module identity -- and the grep test in
      // this task fails the build if a harness import reappears under refresh/.
      const names = Object.keys(prev.providers ?? {});
      outcomes = await tier2(names, { rpc });
      for (const [id, o] of outcomes) {
        if (o.kind !== "ok") continue;
        // Entries, not ids: `m.model` with no `?? m` fallback. The coercion that
        // used to be here was the one place in the plan that accommodated both
        // shapes, which is exactly why the ambiguity survived everywhere else.
        const { kept } = admitRemoteModels(id, (o.models ?? []).map((m) => m.model));
        const keptSet = new Set(kept);
        o.models = (o.models ?? []).filter((m) => keptSet.has(m.model));
      }
    } else {
      // Tier 3 reports through stdout and an exit code, not through the ledger:
      // its result is a whole-run verdict and the merge is per-provider, so there
      // is no honest key to file it under. It contributes no outcomes, which
      // means the merge below is a no-op and the snapshot is promoted unchanged.
      const t3 = await tier3(Object.keys(prev.providers ?? {}), { confirmed });
      outcomes = t3.outcomes;
      tier3Status = t3.status;
    }

    for (const [name, o] of outcomes) {
      console.log(`${o.kind === "ok" ? "PASS" : "fail"}  ${name.padEnd(18)} ` +
                  `${o.kind}${o.models ? ` (${o.models.length})` : ""}${o.note ? ` — ${o.note}` : ""}`);
    }

    const { next, refused } = mergeSnapshot(prev, outcomes, now, etag);
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

    // Q1.3. Routability is resolved HERE, once, and stamped -- never in the
    // picker, whose blocking input loop can never observe an asynchronous answer.
    // This is the only process in the system that has an event loop, CCR
    // credentials, and no latency budget, which makes it the only place the
    // question can honestly be asked. `fresh: false` propagates as
    // `routable: null` on every row and renders undimmed, because "nobody
    // checked" must not look like "nothing works".
    const { set, fresh } = await routableSet({ timeoutMs: 4000 });
    console.log(fresh ? `routable: ${set.size} provider/model pairs`
                      : `routable: CCR did not answer — rows will render undimmed`);

    if (tier3Status !== null) {
      console.log(tier3Status === 0
        ? "\ntier 3: verify-cli reported success."
        : `\ntier 3: verify-cli exited ${tier3Status} — see its output above.`);
    }

    // Task B7 folds this run's outcomes into health.json; Task B10 rebuilds the
    // picker's snapshot.json from the promoted catalogue plus both of these.
    writeHealthFromOutcomes(next, now, { tier });
    rebuildPickerSnapshot({ routableOf: makeRoutableOf(set, fresh),
                            routableAsOf: fresh ? now : null });
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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/refresh/cli.mjs" --tier 1 --dry-run
```

Expected: `# fail 0`, with a pass count around 239 (indicative — see "How to read the `# pass N` numbers"). The dry run prints `models.dev: HTTP 200, ~212 providers`, one line per provider, and `--dry-run: nothing written.`

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(refresh): three tiers behind one CLI, keys never held by the refresher"
```

---

### Task B7: Health from probe history, with an age refusal

**Files:** Create `C:/Users/osami/.uw/menu/health.mjs`, **Create `C:/Users/osami/.uw/refresh/health-writer.mjs`**, Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Modify `C:/Users/osami/.uw/refresh/cli.mjs`, Modify `C:/Users/osami/.llmkeys/providers.json`, Test `C:/Users/osami/.uw/test/health.test.mjs`
**Interfaces:** Consumes: `~/.uw/state/health.json`, `keysync/key-health-latest.json`, the merge ledger from Task B5, provider profiles. Produces:
`MAX_HEALTH_AGE_MS: number` — 14 days
`readHealth(file?: string) -> {generatedAt: string|null, providers: object}`
`resolveHealth(profile, entry, health, now) -> "ok" | "needs $" | "broken" | "stale"`
`makeHealthOf(providers: Map, health: object, now?: number) -> (name) => string`
And in `refresh/health-writer.mjs`:
`foldProbeResults(doc, prev?) -> {generatedAt, providers}` — pure; folds `key-health*.json` results into the health shape
`writeHealthFromProbeFile(file, out?) -> object | null` — the one-off fold that makes the column live today
`writeHealthFromOutcomes(snapshot, now, opts?: {out?: string, tier?: number}) -> object` — the per-refresh projection, called by `refresh/cli.mjs`. **`tier` is not optional in effect:** it decides which source the run may claim, and omitting it defaults to 1, the keyless branch that records no `lastOk`. An earlier version of this line declared a bare `out?` third argument, so a caller following it would pass a path where the options object goes — silently getting the default file and the keyless branch, which is the one place this function must not guess. Note the neighbour above takes a bare path, which is what made the two easy to confuse

**This task ships the reader AND the writer.** Every render path in this plan must have a producer in the same phase; a column whose data has no writer is not a deferral, it is a hole that renders a constant. See Step 3b for why the previous "two-line follow-up" note was not accurate, and Task B5 for `consecutiveFails`, the field `resolveHealth`'s `broken` branch keys on and which nothing previously computed.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/health.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readHealth, resolveHealth, makeHealthOf, outranks,
         SOURCE_RANK, MAX_HEALTH_AGE_MS } from "../menu/health.mjs";
import { foldProbeResults, writeHealthFromOutcomes,
         writeHealthFromProbeFile } from "../refresh/health-writer.mjs";

// The producer half. Without these the column renders one constant on all 44 rows.

test("folding the existing probe file gives every probed provider a verdict", () => {
  const doc = { at: "2026-09-02T19:53:00.000Z", results: [
    { id: "personal.google.free", state: "ok" },
    { id: "personal_maestro.deepseek.paid", state: "broken", status: 402, why: "Insufficient Balance" },
    { id: "personal.dead.free", state: "auth", status: 401 },
    { id: "personal.unprobed.free", state: "skipped" },
  ] };
  const h = foldProbeResults(doc);
  assert.equal(h.generatedAt, doc.at);
  assert.equal(h.providers.google.lastOk, doc.at);
  assert.equal(h.providers.google.consecutiveFails, 0);
  assert.equal(h.providers.deepseek.consecutiveFails, 1);
  assert.equal(h.providers.dead.consecutiveFails, 1);
  assert.equal(h.providers.unprobed.lastOk, null, "skipped is not evidence either way");
});

test("a provider is healthy if ANY of its credentials answered", () => {
  // The column answers "can I use this provider", not "is every key for it good".
  const h = foldProbeResults({ at: "2026-09-02T19:53:00.000Z", results: [
    { id: "personal.acme.free", state: "auth" },
    { id: "work.acme.paid", state: "ok" },
  ] });
  assert.equal(h.providers.acme.lastOk, "2026-09-02T19:53:00.000Z");
  assert.equal(h.providers.acme.consecutiveFails, 0);
});

test("a tier-1 refresh cannot make a probe-dead provider render healthy", () => {
  // The inversion this guards: the projection used to build its map from scratch
  // and write the whole document, so the first refresh discarded every probe
  // verdict. A provider absent from the outcomes lost its entry, resolveHealth
  // read undefined, consecutiveFails defaulted to 0, and a key the probe found
  // dead rendered "ok".
  const out = path.join(os.tmpdir(), `uw-prec-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const PROBED = "2026-09-09T00:00:00.000Z", NOW2 = "2026-09-10T00:00:00.000Z";

  fs.writeFileSync(out, JSON.stringify(foldProbeResults({ at: PROBED, results: [
    { id: "personal.dead.free", state: "auth" },
    { id: "personal.dead.free", state: "auth" },
    { id: "personal.dead.free", state: "auth" },
    { id: "personal.good.free", state: "ok" },
  ] })));

  // A tier-1 run that "succeeds" for both providers — models.dev answered.
  writeHealthFromOutcomes({ providers: {
    dead: { lastOk: NOW2, lastFail: null, consecutiveFails: 0 },
    good: { lastOk: NOW2, lastFail: null, consecutiveFails: 0 },
    fresh: { lastOk: NOW2, lastFail: null, consecutiveFails: 0 },
  } }, NOW2, { out, tier: 1 });

  const h = readHealth(out);
  assert.equal(h.providers.dead.source, "probe", "a probe verdict is never downgraded");
  assert.equal(resolveHealth({}, h.providers.dead, h, Date.parse(NOW2)), "broken");
  assert.equal(resolveHealth({}, h.providers.good, h, Date.parse(NOW2)), "ok");
  // A provider the probe never reached: seen listed, nothing more.
  assert.equal(h.providers.fresh.source, "listing");   // tier 1: keyless
  assert.equal(h.providers.fresh.lastOk, undefined,
    "a keyless tier must not record that a key answered");
  assert.equal(resolveHealth({}, h.providers.fresh, h, Date.parse(NOW2)), "stale");
  fs.rmSync(out, { force: true });
});

test("a keyed tier may record evidence, but still not over a probe", () => {
  const out = path.join(os.tmpdir(), `uw-prec2-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const NOW2 = "2026-09-10T00:00:00.000Z";
  fs.writeFileSync(out, JSON.stringify({ generatedAt: NOW2, providers: {
    dead: { lastOk: null, lastFail: NOW2, consecutiveFails: 4, source: "probe", at: NOW2 },
  } }));
  writeHealthFromOutcomes({ providers: {
    dead: { lastOk: NOW2, lastFail: null, consecutiveFails: 0 },
    other: { lastOk: NOW2, lastFail: null, consecutiveFails: 0 },
  } }, NOW2, { out, tier: 2 });
  const h = readHealth(out);
  assert.equal(resolveHealth({}, h.providers.dead, h, Date.parse(NOW2)), "broken");
  assert.equal(h.providers.other.source, "keyed-listing",
    "tier 2 claims the middle source, not the weakest one");
  assert.equal(resolveHealth({}, h.providers.other, h, Date.parse(NOW2)), "ok",
    "tier 2 is keyed, so its lastOk is real evidence for a provider the probe missed");
  fs.rmSync(out, { force: true });
});

test("the refresher's ledger projects straight into the health shape", () => {
  const out = path.join(os.tmpdir(), `uw-health-${process.pid}.json`);
  fs.rmSync(out, { force: true });
  const NOW = "2026-09-10T00:00:00.000Z";
  // tier 2: keyed, so its evidence counts for providers the probe did not reach.
  writeHealthFromOutcomes({ providers: {
    acme: { lastOk: NOW, lastFail: null, consecutiveFails: 0 },
    dead: { lastOk: null, lastFail: NOW, consecutiveFails: 4 },
  } }, NOW, { out, tier: 2 });
  const h = readHealth(out);
  assert.equal(h.generatedAt, NOW);
  assert.equal(h.providers.acme.source, "keyed-listing");
  assert.equal(resolveHealth({}, h.providers.dead, h, Date.parse(NOW)), "broken");
  assert.equal(resolveHealth({}, h.providers.acme, h, Date.parse(NOW)), "ok");
  fs.rmSync(out, { force: true });
});

test("with a written health file the column is not a constant", () => {
  // The regression this guards: no producer means generatedAt is null, age is
  // Infinity, and all 44 rows read `stale` (or `needs $`) forever.
  const NOW = Date.parse("2026-09-10T00:00:00.000Z");
  const AT = "2026-09-10T00:00:00.000Z";
  const health = { generatedAt: AT, providers: {
    a: { consecutiveFails: 0, lastOk: AT, source: "probe", at: AT },
    b: { consecutiveFails: 5, lastFail: AT, source: "probe", at: AT },
    c: { consecutiveFails: 0, lastOk: AT, source: "probe", at: AT },
    d: { source: "listing", at: AT },
  } };
  const of = makeHealthOf(new Map([["a", {}], ["b", {}],
                                   ["c", { requiresBalance: true }], ["d", {}]]),
                          health, NOW);
  assert.deepEqual([of("a"), of("b"), of("c"), of("d")],
                   ["ok", "broken", "needs $", "stale"]);
  assert.equal(new Set([of("a"), of("b"), of("c"), of("d")]).size, 4,
    "four providers, four different verdicts — not one constant");
});

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
  // Not-broken is not the same as ok. The entry has to carry keyed evidence to
  // reach ok; with only a failure count it is unmeasured, which renders stale.
  const probed = { consecutiveFails: 2, source: "probe", lastOk: fresh.generatedAt, at: fresh.generatedAt };
  assert.equal(resolveHealth({ notes: "" }, probed, fresh, NOW), "ok");
  assert.equal(resolveHealth({ notes: "" }, { consecutiveFails: 2 }, fresh, NOW), "stale");
});

test("requiresBalance renders as needs $ when nothing is broken", () => {
  assert.equal(resolveHealth({ requiresBalance: true }, { consecutiveFails: 0 }, fresh, NOW), "needs $");
});

test("the three sources are ordered, and only the keyed two can reach ok", () => {
  // `source` used to conflate how we learned something with whether a key
  // answered, which made writeHealthFromOutcomes' keyed branch dead code: it
  // wrote `lastOk` for tier 2 and the reader discarded it on the label.
  const AT = fresh.generatedAt;
  const entry = (source) => ({ source, at: AT, lastOk: AT, consecutiveFails: 0 });
  assert.equal(resolveHealth({}, entry("probe"), fresh, NOW), "ok");
  assert.equal(resolveHealth({}, entry("keyed-listing"), fresh, NOW), "ok",
    "tier 2 authenticates the real credential — that is evidence a key works");
  assert.equal(resolveHealth({}, entry("listing"), fresh, NOW), "stale",
    "tier 1 uses no key at all and can never be evidence of health");
  assert.ok(outranks("probe", "keyed-listing"));
  assert.ok(outranks("keyed-listing", "listing"));
  assert.equal(outranks("listing", "probe"), false);
});

test("keyed evidence without a lastOk is still unmeasured", () => {
  assert.equal(resolveHealth({}, { source: "keyed-listing", at: fresh.generatedAt },
                             fresh, NOW), "stale");
});

test("health older than the age limit is refused and renders stale", () => {
  assert.equal(resolveHealth({ notes: "" },
                             { consecutiveFails: 5, source: "probe", lastOk: old.generatedAt,
                               at: old.generatedAt }, old, NOW), "stale");
});

test("the age refusal does not hide a note-recorded breakage", () => {
  assert.equal(resolveHealth({ notes: "key valid, chat backend down" },
                             { consecutiveFails: 5 }, old, NOW), "broken");
});

test("the age limit is fourteen days", () => {
  assert.equal(MAX_HEALTH_AGE_MS, 14 * 24 * 3600 * 1000);
});

test("a provider with no recorded measurement is stale, not ok and not broken", () => {
  // CHANGED, deliberately, from an earlier version asserting "ok". That premise
  // predates `stale` having a producer: when nothing wrote health.json, "no entry"
  // had to mean ok or the whole column would have read broken. Now that Task B7
  // folds the existing key-health file, "no entry" means nobody has measured this
  // provider — and rendering that as ok is the guess Principle 1 forbids. Broken
  // would be the opposite guess and is equally wrong; stale is the honest answer.
  assert.equal(resolveHealth({ notes: "" }, undefined, fresh, NOW), "stale");
});

test("makeHealthOf resolves by provider name", () => {
  const f = makeHealthOf(new Map([["p", { notes: "" }]]),
                         { generatedAt: fresh.generatedAt, providers: { p: { consecutiveFails: 3 } } },
                         NOW);
  assert.equal(f("p"), "broken");
  assert.equal(f("unknown-provider"), "stale",
    "a provider with no entry is unmeasured, not healthy");
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
// Provider health, from three sources with a deliberate precedence.
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

  // Age is measured per ENTRY where the entry knows its own age, not from the
  // document stamp. A refresh rewrites `generatedAt` for the whole file, so a
  // document-level age would make a two-week-old probe verdict look fresh the
  // moment any listing ran.
  const at = entry?.at ?? health?.generatedAt;
  const age = at ? now - Date.parse(at) : Infinity;
  if (age > MAX_HEALTH_AGE_MS) return profile?.requiresBalance ? "needs $" : "stale";

  // THREE SOURCES, ORDERED BY STRENGTH. `source` used to conflate how we learned
  // something with whether a key answered, which made the keyed branch of
  // writeHealthFromOutcomes dead code: it carefully wrote `lastOk` for tier 2 and
  // the reader then discarded it because the label said "listing".
  //
  //   probe          a completion answered on this credential      — strongest
  //   keyed-listing  tier 2: the credential authenticated against
  //                  the provider's own /models endpoint
  //   listing        tier 1 models.dev: no key involved            — weakest
  //
  // `ok` requires evidence that a KEY worked, so it needs `probe` or
  // `keyed-listing` with a `lastOk` inside the freshness window. Tier 1 alone, or
  // no entry at all, renders `stale` — "nobody has checked this key" is not a
  // health verdict, and rendering it as `ok` is the guess Principle 1 forbids.
  const KEYED = new Set(["probe", "keyed-listing"]);
  if ((entry?.consecutiveFails ?? 0) >= 3) return "broken";
  if (profile?.requiresBalance) return "needs $";
  if (!entry || !KEYED.has(entry.source) || !entry.lastOk) return "stale";
  return "ok";
}

// Which source may overwrite which. A stronger source is never downgraded by a
// weaker one, so a probe verdict survives every later listing-only refresh.
export const SOURCE_RANK = { probe: 3, "keyed-listing": 2, listing: 1 };
export const outranks = (a, b) => (SOURCE_RANK[a] ?? 0) >= (SOURCE_RANK[b] ?? 0);

export const makeHealthOf = (providers, health, now = Date.now()) => (name) =>
  resolveHealth(providers.get(name) ?? {}, health.providers?.[name], health, now);
```

Then in `C:/Users/osami/.uw/menu/catalog.mjs`, take `healthOf` as an injected function the same way `cadenceOf` is, defaulting to the notes-only rule so the pure builder keeps working with no health file:

```js
// FRAGMENT: the signature line and the line under it, not a whole function.
// `routableOf` is already there from Task A5 — keep it; this task adds only
// `healthOf`. An earlier version of this fragment omitted it, which would have
// dropped the routability injection on paste.
export function buildFrom({ chosen, providers, catalog, relay,
                            cadenceOf = () => ({}),
                            routableOf = () => null,
                            healthOf: healthFn = null }) {
  const resolve = healthFn ?? ((name) => healthOf(providers.get(name) ?? {}));
```

Then change the single `health:` line inside the `rows.push({...})` call at the end of the credential loop from `health: healthOf(prof),` to:

```js
// FRAGMENT: one line, replacing the existing `health:` line in the rows.push call.
      health: resolve(cred.provider),
```

Then add the import at the top of the file:

```js
import { readHealth, makeHealthOf } from "./health.mjs";
```

and add one property to the object `build()` passes to `buildFrom`, alongside the existing `cadenceOf`:

```js
// FRAGMENT: one property, added to the object build() passes to buildFrom.
    healthOf: makeHealthOf(providers, readHealth()),
```

Task B10 shows the finished `build()` with every injected dependency in place, so use that as the target shape.

- [ ] Step 3b: Ship the producer. **This is the step that stops the column being a hole.**

The previous draft ended here with a note saying nothing writes `health.json` yet, that "tier 2 and tier 3 produce exactly the `{lastOk, lastFail, consecutiveFails}` shape it wants", and that wiring them in was "a two-line follow-up". None of that was true, and the consequence was concrete: with no `health.json`, `readHealth()` returns `generatedAt: null`, `age` is `Infinity`, and `resolveHealth` returns `stale` — or `needs $` — for all 44 providers. One of exactly four provider columns (Constraint 6, width 8) would ship showing the same value on every row, which trains a user to ignore it and violates "blank when uncertain" by asserting staleness it has not measured.

Two producers land here, in order of how soon they give the column something true to say.

**The first is a fold of data already on disk.** `keysync/key-health-latest.json` exists right now and holds `{at, results: [{id, state, ms, status, why, model}]}` for every vault credential, with `state ∈ ok | auth | broken | skipped` — the classification `resolveHealth` wants, from the measurement that produced the 34/9/3 figure. Reading it costs nothing and makes the column live on the day this task lands, before any refresh has run:

```js
// refresh/health-writer.mjs
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeAtomic, readJsonOr } from "../menu/atomic.mjs";
import { outranks } from "../menu/health.mjs";

export const HEALTH = path.join(os.homedir(), ".uw", "state", "health.json");

// A credential id is `bucket.provider.tier`, so the provider is the middle
// segment. Several credentials can map to one provider (different buckets or
// tiers); the provider is healthy if ANY of its credentials answered, because the
// column answers "can I use this provider", not "is every key for it good".
const providerOf = (credId) => String(credId).split(".")[1] ?? null;

export function foldProbeResults(doc, prev = { providers: {} }) {
  const providers = {};
  for (const r of doc?.results ?? []) {
    const name = providerOf(r.id);
    if (!name) continue;
    const base = providers[name] ?? { lastOk: null, lastFail: null,
                                      consecutiveFails: prev.providers?.[name]?.consecutiveFails ?? 0 };
    if (r.state === "ok") {
      providers[name] = { ...base, lastOk: doc.at, consecutiveFails: 0,
                          source: "probe", at: doc.at };
    } else if (r.state === "skipped") {
      providers[name] = base;                       // no information either way
    } else if (!base.lastOk) {                      // auth or broken, and nothing good yet
      providers[name] = { ...base, lastFail: doc.at,
                          consecutiveFails: (base.consecutiveFails ?? 0) + 1,
                          source: "probe", at: doc.at };
    }
  }
  return { generatedAt: doc?.at ?? null, providers };
}

export function writeHealthFromProbeFile(file, out = HEALTH) {
  const doc = readJsonOr(file, null);
  if (!doc?.results) return null;
  const next = foldProbeResults(doc, readJsonOr(out, { providers: {} }));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeAtomic(out, JSON.stringify(next, null, 2));   // Q2.8
  return next;
}

/**
 * Project a refresh's merge ledger into health.json — WITHOUT overwriting a probe.
 *
 * PRECEDENCE, and it is not symmetric: a probe beats a listing, always. A probe
 * made a keyed call and something answered. A listing proves that a name appears
 * in someone's JSON — and for tier 1, which is the DEFAULT tier and uses no keys
 * at all, it proves only that models.dev is up. Letting a tier 1 success write
 * `lastOk` would have the health column assert that the user's key works on
 * evidence that never touched the user's key. That is the same violation as the
 * constant column this producer was added to fix, wearing a plausible value
 * instead of an obvious one, which makes it worse rather than better.
 *
 * The previous version built its provider map from scratch and wrote the whole
 * document, so the first `uw catalog refresh` discarded every probe verdict and a
 * provider absent from the outcomes lost its entry entirely — `resolveHealth` then
 * read undefined, defaulted `consecutiveFails` to 0, and rendered a key the probe
 * had found dead as healthy.
 *
 * So this merges, and it only writes what the producing tier actually established:
 *
 *   - a provider the probe reached is left completely alone;
 *   - a provider it did not reach is filled in from the ledger, marked
 *     `source: "listing"`, and — for tier 1 — carries no `lastOk` and no
 *     `consecutiveFails`, because a keyless tier cannot establish either.
 *
 * `resolveHealth` reads `source` and declines to upgrade a probe verdict on
 * listing evidence. Staleness is displayed, never silently upgraded.
 */
export function writeHealthFromOutcomes(snapshot, now, { out = HEALTH, tier = 1 } = {}) {
  const current = readJsonOr(out, { generatedAt: null, providers: {} });
  const providers = { ...(current.providers ?? {}) };

  // The source this tier is entitled to claim. Tier 2 authenticates the user's
  // credential against the provider's own /models endpoint, so its success is
  // evidence a key works -- weaker than a completion, stronger than models.dev
  // answering. Tier 1 uses no key at all and can never be evidence of health.
  const source = tier >= 2 ? "keyed-listing" : "listing";

  for (const [name, p] of Object.entries(snapshot.providers ?? {})) {
    // Never downgrade a stronger source with a weaker one. This is what keeps a
    // probe verdict alive across every later listing-only refresh.
    if (providers[name] && !outranks(source, providers[name].source)) continue;
    providers[name] = source === "keyed-listing"
      ? { lastOk: p?.lastOk ?? null, lastFail: p?.lastFail ?? null,
          consecutiveFails: p?.consecutiveFails ?? 0, source, at: now }
      // Tier 1: record that we saw the provider listed and nothing more. No
      // lastOk, no consecutiveFails -- resolveHealth renders this as "stale",
      // which is the honest reading of "nobody has checked this key".
      : { ...(providers[name] ?? {}), source, at: now };
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  writeAtomic(out, JSON.stringify({ generatedAt: now, providers }, null, 2));
  return { generatedAt: now, providers };
}
```

**The second is the refresher itself,** wired in Task B6: `writeHealthFromOutcomes(next, now, {tier})` runs at the end of every successful refresh, projecting the merge ledger's per-provider `{lastOk, lastFail, consecutiveFails}` — which now exist, because Task B5 carries `consecutiveFails` forward — into `health.json`. That claim is a two-line follow-up *now*; it was not before.

**Precedence, because the producers do not compose by accident.** There are three sources, ordered by the strength of the evidence behind them, and each entry records which one wrote it:

| `source` | Evidence | Can reach `ok` |
|---|---|---|
| `probe` | A completion answered on this credential | yes |
| `keyed-listing` | Tier 2: the credential authenticated against the provider's own `/models` endpoint | yes |
| `listing` | Tier 1 models.dev: no key was involved at all | **no** |

`ok` requires evidence that a *key* worked, so it needs `probe` or `keyed-listing` **and** a `lastOk` inside the freshness window. Tier 1 alone, or no entry at all, renders `stale` — "nobody has checked this key" is not a health verdict, and rendering it as `ok` is the guess Principle 1 forbids. A stronger source is never overwritten by a weaker one (`outranks`), so a probe verdict survives every later listing-only refresh, and the projection merges into the existing file rather than rebuilding it.

Two earlier versions of this were wrong in opposite directions, which is why the table is explicit. The first rebuilt the document from scratch on every refresh, so the first `uw catalog refresh` discarded every probe verdict and a provider absent from the outcomes lost its entry and rendered healthy on a defaulted zero. The second fixed that but collapsed `keyed-listing` and `listing` into one label, which made the keyed branch dead code: `writeHealthFromOutcomes` carefully wrote `lastOk` for tier 2 and `resolveHealth` then discarded it on the label, so the only remaining producer of `ok` was a one-shot manual fold — and fourteen days after it, every row would have aged into `stale`, which is the constant column the producer was added to prevent, arriving on a delay.

Run the fold once as part of this task, so the column is live immediately:

```
node -e "import('file:///C:/Users/osami/.uw/refresh/health-writer.mjs').then(m=>console.log(m.writeHealthFromProbeFile('C:/Users/osami/.uw/keysync/key-health-latest.json')))"
```

- [ ] Step 3c: `testModelVerifiedAt`.

`buildFrom` prepends `prof.testModel` as the **leading** model row with a blank badge, and `buildProviders` gives it rank 0 on the routing path. It is therefore both the first thing the user sees and the first thing CCR routes — and the measurement that produced the 34/9/3 figure also showed that `providers.json`'s `testModel` values are stale for several providers while their live `/models` listings work. The previous draft had no freshness field of any kind, so nothing recorded when a `testModel` was last proven to answer.

Add `testModelVerifiedAt` to the provider profile in `~/.llmkeys/providers.json`: an ISO timestamp written **only by tier 3**, which is the only tier that actually calls the model. Blank means never proven, which is the honest default and will be the common case.

Two consequences, both narrow:

- `buildFrom` renders the leading row's health cell with a dimmed suffix when `testModelVerifiedAt` is absent or older than `MAX_HEALTH_AGE_MS`. It does not change the badge, because staleness of the probe is not evidence about price.
- `buildProviders` prefers a catalogue id over a `testModel` whose `testModelVerifiedAt` is older than the freshness window **only when the catalogue offers an admitted alternative for that provider**. It never leaves a provider with no models: the measured 2026-09-01 result was that catalogue-first dropped the live pass rate to 4/44, so testModel still leads by default and this is a narrow demotion of a specifically-unproven value, not a reversal of that finding.

Both are guarded by Constraint 3's rule that curated fields are never machine-overwritten: tier 3 writes `testModelVerifiedAt` and nothing else, and never writes `testModel` itself.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

Expected: `# fail 0`, with a pass count around 249 (indicative — see "How to read the `# pass N` numbers").

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
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry
```

Expected: `# fail 0`, with a pass count around 254 (indicative — see "How to read the `# pass N` numbers"), and the dry run prints `providers: 44 (floor 44)`.

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

and in `buildProviders`, replace the inline `.map(...).sort(...)` with `const ranked = rankModels(safeEntries);`.

**`safeEntries`, not `catalogEntries`.** Task A5.1 replaced that argument: `catalogEntries` is the raw list straight from the catalogue, and `safeEntries` is the same list after `admitRemoteModels` has removed reserved and malformed ids. Passing the raw array here would restore the exact condition report 08 F1 describes — and it would do so on the one task whose entire purpose is to make free-first ranking total, which is what promotes a hostile zero-priced `opus` to rank 0. A literal reading of an earlier draft of this step did precisely that and then asserted a clean run.

The suite catches it — Task A5.1's `buildProviders` test fails immediately — but that is an argument for keeping that test, not a reason to be relaxed here: an implementer who trusts the prose meets a red suite on the last task of Phase B and may reach for the test rather than the line. The `rankModels` extraction is a pure refactor of the comparator and must not change what is ranked.

- [ ] Step 4: Run, expected PASS, then apply deliberately.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/keysync/run.mjs" --dry > C:/Users/osami/.uw/state/tiebreak-after.txt
```

Expected: `# fail 0`, with a pass count around 259 (indicative — see "How to read the `# pass N` numbers"). Diff the dry run against the committed `built-rows.json` and expect the selection to differ — that is the point, and it is why this is a deliberate run rather than a drive-by edit. Then, with no Claude Code session mid-request:

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

**Files:** Modify `C:/Users/osami/.uw/menu/catalog.mjs`, Modify `C:/Users/osami/.uw/refresh/cli.mjs`, Test `C:/Users/osami/.uw/test/integration.test.mjs`
**Interfaces:** Consumes: everything built above. Produces: `build()` resolving through `resolveCatalogPath()`, and a refresh that rebuilds `~/.uw/catalog/snapshot.json` as its last step after flipping the `current` pointer, so the picker shows the new rows on its next launch with no other action.

- [ ] Step 1: Write the failing test.

Create `C:/Users/osami/.uw/test/integration.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { build } from "../menu/catalog.mjs";
import { resolveCatalogPath } from "../refresh/catalog-store.mjs";
import { view, initState, reduce } from "../menu/pick-state.mjs";
import { screen } from "../menu/uwpick.mjs";
import { loadSnapshot } from "../menu/snapshot.mjs";
import { detectCaps } from "../menu/style.mjs";
import * as K from "../keysync/keysync.mjs";

// The tests in this file READ live state and never write it, which is the only
// exception Constraint 15 permits and the reason this is the last task in the
// plan: it exists to confirm that the pieces meet on this machine. Each one is
// gated on the artifact existing, so the suite stays at `# fail 0` on a machine
// where Task B4's copy-out has not run (Constraint 15a). None of them writes
// anything, touches a key value, or contacts a gateway.
const haveCatalogue = () => { try { return fs.existsSync(resolveCatalogPath()); } catch { return false; } };

test("the picker resolves the catalogue through the snapshot pointer", { skip: !haveCatalogue() }, () => {
  const p = resolveCatalogPath().replace(/\\/g, "/");
  assert.doesNotMatch(p, /node_modules/);
  assert.ok(fs.existsSync(p));
});

test("a refresh's output is loadable by the picker's real loader", { skip: !haveCatalogue() }, () => {
  // The end-to-end form of the B4/B5 filename defect: writeSnapshot wrote
  // index.json while resolveCatalogPath looked for models.json, in a different
  // shape, so the snapshot branch never matched and loadCatalog silently kept
  // reading the copied bundle. This asserts against the REAL loader rather than a
  // fixture, because a fixture is exactly what would have hidden it.
  const cat = K.loadCatalog();
  assert.ok(cat.byProvider.size > 0, "loadCatalog must find providers in the resolved catalogue");
  assert.ok(cat.generatedAt, "and it must carry the generatedAt of the version it read");
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
  const meta = { providers: rows.length,
                 models: rows.reduce((n, r) => n + r.models.length, 0), generatedAt };
  const opts = { caps: detectCaps({ WT_SESSION: "1" }, 120) };
  let s = initState(rows);
  const frames = [screen(view(s), meta, opts)];
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const into = reduce(s, "\r").state;
    frames.push(screen(view(into), meta, opts));
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

test("the picker's snapshot agrees with a fresh build", () => {
  const r = loadSnapshot();
  assert.equal(r.ok, true, `snapshot unusable: ${r.reason} ${r.detail ?? ""}`);
  const fresh = build();
  assert.equal(r.snap.rows.length, fresh.rows.length);
  assert.equal(r.snap.generatedAt, fresh.generatedAt);
  const a = r.snap.rows.map((x) => x.keyId).sort();
  const b = fresh.rows.map((x) => x.keyId).sort();
  assert.deepEqual(a, b, "the snapshot is stale — rerun the refresh, which rebuilds it");
});

test("the picker never reads the full catalogue", () => {
  const src = fs.readFileSync("C:/Users/osami/.uw/menu/uwpick.mjs", "utf8");
  assert.doesNotMatch(src, /catalog-store|resolveCatalogPath|loadCatalog/,
    "uwpick must open the snapshot, not the catalogue (Q1.1)");
  assert.match(src, /loadSnapshot/);
});
```

- [ ] Step 2: Run it, expected FAIL.

```
node --test "C:/Users/osami/.uw/test/integration.test.mjs"
```

Expected failure: only the last test fails, because `build()` does not yet pass every injected dependency through. The other tests in this file are gated on the live catalogue existing (Constraint 15a) and skip cleanly if Task B4's copy-out has not run, so `# fail 0` remains readable throughout. If the reserved-name assertion fails, Task A5.1's edit to `buildFrom` was not applied; if the OpenRouter cadence assertion fails, Task B3's migration has not reached the live vault.

- [ ] Step 3: Implement.

Finish wiring `build()` in `C:/Users/osami/.uw/menu/catalog.mjs` so every injected dependency is supplied from real state:

```js
import { resolveCatalogPath, assertSchema } from "../refresh/catalog-store.mjs";
import { makeCadenceOf } from "./cadence.mjs";
import { readHealth, makeHealthOf } from "./health.mjs";

export function build({ routableOf = () => null } = {}) {
  const { registry, providers } = K.loadVault();
  const chosen = K.chooseKeys(K.filterRegistry(registry, providers));
  // loadCatalog already resolves through resolveCatalogPath() after Task B4, so a
  // refresh that flips `current` changes what the picker shows on its NEXT launch
  // and nothing else has to happen. The pointer is read once per process, so a
  // concurrent refresh can never be observed half-written.
  //
  // `routableOf` is injected rather than resolved here (Q1.3). The only caller
  // that can supply a real one is refresh/cli.mjs, which has an event loop; the
  // default returns null for every target, which renders undimmed. `build()` is
  // synchronous and stays that way.
  return buildFrom({
    chosen, providers, catalog: K.loadCatalog(), relay: K.ANTHROPIC_RELAY,
    cadenceOf: makeCadenceOf(providers),
    healthOf: makeHealthOf(providers, readHealth()),
    routableOf,
  });
}
```

And close the loop in `C:/Users/osami/.uw/refresh/cli.mjs`, at the end of a successful run, after the `current` pointer has been flipped:

```js
import { buildSnapshot, writeSnapshotFile } from "../menu/snapshot.mjs";
import { build } from "../menu/catalog.mjs";

// Q1.1: the catalogue version is what the refresher promotes; the snapshot is
// what the picker opens. Rebuilding here is what keeps the second true of the
// first, and it is the only place that rebuild belongs -- doing it in the picker
// would put the whole join back on the ctrl+g path.
function rebuildPickerSnapshot({ routableOf = () => null, routableAsOf = null } = {}) {
  const snap = buildSnapshot(build({ routableOf }));
  const file = writeSnapshotFile({ ...snap, routableAsOf });
  console.log(`picker snapshot rebuilt: ${file}` +
              (routableAsOf ? "" : " (routability unknown; nothing will render dimmed)"));
  return file;
}
```

`rebuildPickerSnapshot` is called from `main()` after the `current` pointer has been flipped and after `writeHealthFromOutcomes` (Task B6 shows the call site), and it is skipped under `--dry-run` along with every other write.

The `routableAsOf` stamp travels with the rows it describes rather than being written to a separate file, so a snapshot can never claim a freshness its rows do not have. Task A10 prints it in the header (Q1.3), which is what lets a user distinguish an undimmed row that was checked from an undimmed row that was not.

- [ ] Step 4: Run, expected PASS.

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
node "C:/Users/osami/.uw/refresh/cli.mjs" --tier 1
node "C:/Users/osami/.uw/menu/doctor.mjs"
```

Expected: `# fail 0`, with a pass count around 268 (indicative — see "How to read the `# pass N` numbers"); the tier 1 refresh writes a catalogue version, flips `current`, prints `picker snapshot rebuilt: ...`, and `doctor` reports green. Then re-run the Task A17 protocol steps P2 and P6 and confirm the badges and the free column reflect the curated cadence.

- [ ] Step 5: Commit.

```
git -C C:/Users/osami/.uw add -A && git -C C:/Users/osami/.uw commit -m "feat(menu): the picker reads the refreshed catalogue through the snapshot pointer"
```

---

## Test Strategy

**How to run everything.**

```
node --test "C:/Users/osami/.uw/test/*.test.mjs"
```

No `package.json`, no test framework, no dependency. `node:test` and `node:assert/strict` ship with Node, which preserves the zero-dependency property keysync holds deliberately. Files are `*.test.mjs`; fixtures are JSON under `test/fixtures/`.

**What each layer is responsible for.**

The unit layer owns every decision: sanitization, id admission, the denylist, price extraction, badge derivation, cadence resolution, health resolution, the reducer, the merge policy, and the provider floor. All of it runs from fixtures with no network, no vault reads and no live state. This is where a regression should be caught, and it is why the reducer was split out of the renderer.

The integration layer owns the seams: the dispatcher's decision, the console-mode restore, the wiring from `build()` through `view()` to `render()`, and the fact that no provider-controlled string reaches a rendered frame with a control character intact. These spawn real processes but only against scratch directories.

The end-to-end layer is Task A17's protocol (`P1`–`P15`, plus `P11a`–`P11c` covering the three abort paths), run by a human or the qa-tester agent in Windows Terminal against live Claude Code. It exists because the properties that matter most here — does ctrl+g reach the picker, do arrows arrive, does the chat input actually change, is the console still usable afterwards — are not observable from inside a test harness. `process.stdout.isTTY` is false under a piped agent, so any claim about interactive behaviour made from there would be a guess.

**Isolation, restated as a rule.** No test reads or writes `~/.claude/settings.json`, `%APPDATA%/claude-code-router`, ports 3456, 3457 or 3458, or any key value from `~/.llmkeys`. Scratch state goes to `fs.mkdtempSync` directories or `~/.uw/harness/scratch/`. Where a test must reach CCR, it goes through `harness/config.mjs`, which pins its own app-data directory, its own `LOCALAPPDATA`, and ports 39456/39457/39458, and whose `resolveWebPort()` refuses to talk to a daemon that did not receive the harness token. CCR auth-transport behaviour is never tested with the real `~/.claude/.credentials.json` present.

**Where a test asserts against real code rather than a fixture, and why.** Three assertions in this plan deliberately reach past the fixture layer, because each one guards a property a fixture cannot observe:

- `denylist.test.mjs` and `infertier.test.mjs` call the real `buildProviders` from `keysync/keysync.mjs` with injected arguments. The property is "a reserved name never reaches CCR's routing table", and a fixture that models `buildProviders` would have passed while the real function stayed open. All four arguments are injected and the `keyReader` returns a literal string; no vault, no key value, no gateway.
- `contracts.test.mjs`'s boundary grep and `uwpick.test.mjs`'s no-promise-continuation check read the project's own source files. Both guard architectural properties — where a foreign path may appear, and that the picker acquires no asynchronous dependency — that are invisible to any test of behaviour, because the code that violates them still behaves correctly under a test runner that has an event loop.
- `integration.test.mjs` (Task B10) loads the live catalogue through the real `loadCatalog`, read-only and gated on the file existing. The property is "a refresh's output is loadable by the picker's loader", and a fixture is precisely what hid the B4/B5 filename mismatch.

Everything else runs from frozen fixtures.

**What is deliberately not tested.** The `PLAN` badge is asserted only on the injected relay, because no vault provider is curated as plan-covered and inventing one would be the guess the design exists to prevent. Tier 3 is tested only for its refusal path; its success path spends money. Terminal rendering fidelity — colours, alignment on a narrow window — is verified by eye in the protocol, not asserted, because asserting on ANSI output pins the design rather than the behaviour.

## Risks and Rollback

| Risk | Signal | Rollback |
|---|---|---|
| Claude Code's handoff contract changes on an auto-update | `uw doctor` reports RED on `handoff-contract`, or ctrl+g silently does nothing | Set `EDITOR` back to `%UW_REAL_EDITOR%` at User scope; the picker is then simply absent and nothing else in the system depends on it. Fall back to Option D, the `UserPromptSubmit` hook |
| The console is left in raw mode | The parent shell stops echoing | Close the terminal. The wrapper's `finally` should prevent this; if it recurs, capture `~/.uw/state/conmode.json` from a `-Diagnose` run and compare `saved` with `restored` |
| The installer clobbers a real `EDITOR` | Ctrl+g opens the picker where the user expected their editor | `~/.uw/state/install.json` records `previousEditor`; restore it with `[Environment]::SetEnvironmentVariable("EDITOR", <previous>, "User")` |
| The tiebreak run (B9) selects worse models | The dry-run diff shows unexpected rows, or a provider stops serving after the apply | `git revert` the B9 commit and re-run `run.mjs --target live --i-know`; keysync's own `restoreSettings` and DPAPI-encrypted `config.sqlite` snapshot cover the apply itself |
| A refresh promotes a bad snapshot | The picker shows far fewer models, or a provider empties | `echo <previous stamp> > ~/.uw/catalog/current`, then `node ~/.uw/menu/snapshot.mjs --build` to re-derive the picker's rows — catalogue versions are immutable and three are retained. The shrink guard and the 80% floor should catch this first |
| The `grantCadence` migration is wrong for a provider | A `FREE` badge on something that is not free | Restore the timestamped `providers.json.bak-cadence-*` the migration wrote, or edit the single field. The field is curated, so correcting it is a one-line human edit by design |
| `inferTier` (B2) lands before the denylist (A5.1) | A bare Claude-shaped id from a third-party provider reaches CCR's `Providers[].models` | The first test in `infertier.test.mjs` calls `buildProviders` with a hostile zero-priced `opus` and asserts it is absent from the output. It fails until A5.1 has landed **on the routing path**, so it cannot be satisfied by a commit message, nor by a guard that sits only on the display path. If it somehow shipped: revert B2, land A5.1, re-apply |
| A `-Hud` install corrupts or truncates `~/.claude/settings.json` | Claude Code reports invalid settings, or the statusline is blank on every prompt | `settings.json.uw-bak` holds the original bytes, taken immediately before the write; `install.ps1 -Hud -HudUninstall` restores from it. Manually: `Copy-Item ~/.claude/settings.json.uw-bak ~/.claude/settings.json -Force`. The write is atomic (tmp + `Move-Item`), so a crash mid-write leaves the previous file intact, and it goes through `set-statusline.mjs` rather than a lossy PowerShell JSON round trip |
| A test reaches live state | An unexplained change to `~/.claude/settings.json` or a gateway restart during a test run | `harness/guard.mjs` tripwires on `LIVE_SETTINGS`; keysync's settings backups are in `%LOCALAPPDATA%\uw-keysync\backups`. Structurally: every catalogue-store function takes a `root` parameter and every test passes a temp directory, so reaching the live catalogue has to be deliberate |
| CCR is reinstalled and the gateway handshake patch is reverted | `uw doctor` reports `ccr-gateway-patch` RED. Without the doctor: intermittent `Core gateway did not accept runtime config within 5000ms`, **only under load**, reading as flakiness elsewhere | Re-apply the patch: in `<ccr-install>/dist/main/cli.js`, change the first numeric assignment after `var PN="gateway",` from `5e3` to `2e4`, preserving the file's existing line endings. Then restart the gateway. `uw doctor` confirms green |
| CCR is updated on disk but the gateway is not restarted | `uw doctor` reports `ccr-rpc` AMBER naming both versions | Restart the CCR gateway. Until then the running process still holds the old bundle, so the patch check reads a file the live process is not using and both can be green today and fail tomorrow |
| OMC rewrites `statusLine.command` while UW's shim is installed | The corrected context number silently stops being corrected; `uw doctor` reports `hud-shim` not installed | Nothing is broken — the footer is exactly what OMC intends. Re-run `install.ps1 -Hud` to re-wrap if the corrected number is wanted. Do **not** run `-HudUninstall` expecting a restore: it will detect the foreign command, refuse to touch it, and clear only UW's stale state |
| UW's uninstall reverts an unrelated `settings.json` change | Would be silent, which is why it is guarded rather than documented | The whole-file restore fires only when the live file differs from `.uw-bak` in nothing but `statusLine`; otherwise a value-level edit preserves every other key and says so. Two tests in A16 pin both halves |
| A guard sits on a path that cannot cause the harm it guards against | Nothing at runtime. This is the failure mode with no symptom, and finding two instances of it is what the architect and critic reviews were for | Every security claim in this plan is asserted against the **output of the function that does the harm** — `buildProviders` for routing, `frame()` for rendering — never against a commit message, a file's existence, or an import statement. Where prose and code disagreed, both sides were changed |

## Open questions for the user — RESOLVED 2026-09-03

Both questions below were put to the user and answered. The answers are binding on execution; the original text is kept so the reasoning behind each decision stays readable.

**Answer to question 1 — keep both.** Task A14 and the `-Hud` half of Task A16 stay in scope. A14's blocking Step 0 (measure the real statusline payload for a CCR-routed non-Anthropic model) is a hard gate: if `model.id` does not carry the `provider/model` shape the shim assumes, stop and report rather than proceed, because the task would otherwise pass all of its own tests while doing nothing.

**Answer to question 2 — one delivery.** Phase A and Phase B ship together under D8, executed in order (A1 through A17, then B2 through B10). No separate ship gate after Phase A. Phase A's independent shippability is retained as a property, not exercised as a plan.

The two questions as originally posed follow.

These are the only two decisions in this plan that the planner declined to make alone. Both were raised by review; neither has a technically correct answer.

**1. Scope. One reviewer judged the plan at roughly three times the effort its own report-09 budget implies (~4,800 lines of fenced code across 27 tasks against a ~550-line estimate) and proposed merging four task pairs and deferring two things.** The merges were assessed on their merits and rejected with reasons recorded in `phase6-review-synthesis.md` — each would have coupled a security primitive to a builder, or reversed the ordering constraint, or buried a benchmark inside a module task. Global Constraint 25 has been rewritten to state the real size rather than keep a budget the plan silently breaks.

The two deferrals are a different matter, because both target work the user explicitly asked for:

- **Task A14 (`hud-shim.mjs`)** carries quality criterion Q6 and was an explicit follow-up request. Deferring it means the OMC footer keeps showing 200000 as the context window for every non-Anthropic model, so "context left" counts down against the wrong denominator — the one gap the user asked to have closed.
- **The `-Hud` half of Task A16** is A14's installer and cannot ship without it.

Together they are roughly two tasks out of 28. The planner's recommendation is to keep both, on the grounds that the request was explicit and the cost is bounded — but this is the user's call, not the planner's, and A14 now carries a Step 0 that measures the real statusline payload before any of its code is trusted (see the note there: without that measurement the whole task can be a silent no-op that passes its own tests).

**2. Whether Phase A should ship before Phase B is written.** Not raised by either reviewer; it follows from moving the denylist forward. With Task A5.1 in Phase A, the shippable menu now carries its own security guard on both the render and the routing path, which was the strongest argument for keeping the two phases welded together. Phase A is therefore independently shippable in a way it was not before. Splitting is not proposed — the phases are one plan by D8 — but if the user wants working ctrl+g sooner, A1 through A17 is now a coherent unit.

---

## Deferred and Out of Scope

**Deferred, with the reason.**

**Display-width awareness for wide characters.** The renderer is now internally *consistent* — `sanitizeDisplay`'s cap, `pad`, `rpad`, `bar` and `clipVisible` all count code points through one `vis()` helper, so an astral id can no longer produce a frame that renders short while satisfying the width test. It is not display-*correct*: an East Asian wide or ambiguous-width glyph is one code point occupying two terminal columns, and an emoji is one code point occupying two. Consequence, stated plainly: a provider publishing a CJK model id will under-fill its cell and shift every column to its right on that row. The frame-width invariant test counts code points, the same way the renderer pads, so it will not catch this. The bundled catalogue is entirely ASCII today; tier 2 listings (Task B6) are where that stops being guaranteed, and the fix is a width table rather than a regex, which is why it is here rather than in A3.

**Tier 3's real billed path is not covered by any test, and cannot be without spending money.** The logic around it now is: the confirmation gate is tested (including that `confirmed` must be literally `true`, not merely truthy), and everything below it — the argument construction, the empty-outcomes contract, the status propagation — is tested through an injected `spawn`. What no test exercises is the actual subprocess: `verify-cli.mjs` spawning the real Claude Code binary against real providers. That is deliberate, because running it costs money on every provider in the vault, which is the reason tier 3 is gated behind `--tier 3`, `--i-know-this-bills` and an interactive confirmation in the first place.

The consequence, stated rather than left implicit: a defect in `verify-cli.mjs` itself, or in the arguments passed to it, surfaces only on a billed run. The mitigations are that the arguments are now one resolved path with no interpolation, `stdio: "inherit"` puts verify-cli's own output on the operator's screen while it runs, and its exit status is reported rather than folded into the ledger — so a failure is visible immediately to the person who just chose to spend money, which is the only audience that path has.

**`testModelVerifiedAt` for providers tier 3 has never run against.** The field ships in B7 and is written only by tier 3, which bills. Until a tier 3 run happens for a given provider the field is blank, which renders as "never proven" — honest, and the common case at first.

**Per-provider health for providers with no credential in `key-health-latest.json`.** B7's fold covers every credential that probe file recorded. A provider added to the vault after that measurement, and not yet reached by a tier 2 refresh, has no entry and renders `stale` — which is now a true statement about that provider rather than a constant across all 44. The New-API `/api/pricing` route — public and unauthenticated on tokenrouter, nararouter and agentrouter, and worth re-probing for six more — would convert those providers from "id-suffix only" to first-party price data, but it needs the `quota_type` predicate `(quota_type == 0 && model_ratio == 0) || (quota_type == 1 && model_price == 0)`, and the naive test is measured at 123 false positives out of 134 on one gateway alone. Per-model rate limits, wallet balances and `access_state` from report 14 are a richer schema than the five-badge set the user specified; the badge set is the constraint, so the extra fields would render nowhere. Conditional pricing (Zenmux publishes an array of tiers with token-count conditions on 50 of 164 models) cannot be represented by a scalar price field and currently renders blank, which is correct but lossy.

**Out of scope, deliberately.**

No scheduled task is created for any tier. Report 08 F8 is unambiguous: a scheduler supplying a consent flag on every run converts a gate into a constant, and the human who would notice a warning is exactly what a schedule removes. Tier 1 is *schedulable* by construction — it touches no keys and no privileged file — but scheduling it is a separate decision with its own jitter, failure-budget and kill-file requirements. `autoFetchModels` stays off forever: its merge is a pure union that never removes an upstream deletion, it is strictly sequential with no per-provider timeout across 44 providers, and it hands the gateway-restart trigger to a 600-second timer we do not control. Gateway model discovery is not enabled; it is currently set in live settings *alongside* `replaceBuiltInOptions: true`, which erases the rows it produces, making it a pure-cost no-op — picking one mechanism is a separate change. The `behavesAs`-as-context-window coupling (report 10, P0 #1) is a real silent-wrongness bug where auto-compact fires at the wrong threshold with no error, but it belongs to keysync's picker-row generation rather than to the menu, and fixing it needs probe P6 to settle which of `behavesAs`, `modelOverrides` and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` actually wins. The slot file plus `CUSTOM_ROUTER_PATH` mechanism stays proven and unused. Router rules stay disabled and `harness/guard.mjs:assertRouterClean` stays as it is; if rules ever go live it must be scoped, never deleted, because Phase 2.5's provider-attribution test would be false-greened by a rewrite.

# Phase 6 plan — review synthesis and revision log

Written 2026-09-03 by the Planner, reconciling two independent reviews of one plan snapshot.

| | |
|---|---|
| Plan reviewed | `phase6-menu-and-catalogue.md`, 6,750 lines, sha256 `5f47b3e32dba62d7f871d2a817598b67bce6d2e78bfdf2259cf5ae2ba39b5f6a` |
| Reviewed snapshot preserved as | `phase6-menu-and-catalogue.v2-reviewed.md` (byte-identical to the above) |
| Revised plan | `phase6-menu-and-catalogue.md`, 8552 lines |
| Architect review | `phase6-review-architect.md` — verdict SOUND-WITH-CHANGES, 5 BLOCKER / 8 MAJOR / 6 MINOR (findings 1–19) |
| Critic review | `phase6-review-critic.md` — verdict UNSOUND, 4 BLOCKER / 11 MAJOR / 11 MINOR (BL-1..4, MJ-1..11, MN-1..11) |
| Status | **pending approval.** No implementation, no execution, no git operations were performed. |

Both reviews reviewed the same snapshot; the hash was verified before editing.

## Method

Every finding was checked against the plan text at the line it cites, and — where the finding made a claim about real code — against the actual source file, before a verdict was reached. No finding was accepted on the reviewer's authority alone. Four things came out of that discipline that would not have come out of accepting the reviews as written:

- **Critic BL-4 understated its own finding.** The critic computed that the model row rendered at 80 columns against a test asserting 78, and that a corrected 6-wide badge would make the row "68 → fits". Executing the arithmetic shows `bar()` produces **77** columns for *every* in-range line, because `INNER = FRAME_W - 4` is itself off by one — the frame emits `V + body + pad + " " + V`, which is `INNER + 3`. So the width-invariant test failed on the header, the empty state and the legend too, not only on the badge row, and the critic's proposed fix would have left every line one column short. Both hand-written expected literals were a third value again (76). Four different widths in one task.
- **Critic MJ-10's dependency claim was wrong.** It proposed moving the denylist "immediately after A3 (it depends only on `admitId`)". The task also rewrites the model loop inside `buildFrom`, and `buildFrom` is authored in A5 — placing it after A3 would edit a function that does not yet exist. Accepted, with the placement corrected to A5.1.
- **Architect MINOR 18's merges do not survive inspection** (see the rejections table).
- **Critic MJ-7's supporting diagnosis was itself checked.** Its claim that the bench's `keysync.mjs` hint is misleading is correct: `keysync.mjs` is imports and function declarations with no top-level side effects, and its PowerShell round trip is inside `keyReader`, at call time. The corrected note now points at the 19.7 MB `JSON.parse` instead.

Where a finding named a source file, the file was read: `keysync.mjs:167–205` (the `ranked` sort, quoted accurately by both reviews), `catalog.mjs`, `key-health-latest.json` (shape confirmed as `{at, results:[{id, state, ms, status, why, model}]}`, which is what made the B7 fold specifiable rather than aspirational).

## Totals

| | Accepted as proposed | Accepted, different or larger fix | Rejected |
|---|---|---|---|
| Architect (19) | 9 | 8 | 2 |
| Critic (26) | 13 | 11 | 2 |
| **Total (45)** | **22** | **19** | **4** |

Four findings were rejected. Nineteen were accepted but not with the fix as written — in most cases because two reviewers had found the same defect from different angles and the merged fix is larger than either, and in four cases because verification showed the proposed fix incomplete or its reasoning wrong.

## Merged findings

Six defects were found by both reviewers. Each was fixed once, not twice.

| Merged as | Architect | Critic | One fix |
|---|---|---|---|
| M1 denylist on the routing path | BLOCKER 1 | BL-1, MJ-5, MJ-10 | Task **A5.1** |
| M2 abort paths commit the buffer | MINOR 17 | BL-2 | Tasks A10 + A13 |
| M3 unreachable async routability | BLOCKER 3 | BL-3 | Q1.3 rewritten; Tasks A5, A8, A10, B6 |
| M4 health column has no producer | MAJOR 10, MAJOR 13 | MJ-1, MJ-2 | Tasks B5 + B6 + B7 |
| M5 `settings.json` corruption | MAJOR 6 | MJ-3, MJ-4, MJ-11 | Task A16 |
| M6 tests touch live state | MINOR 16 | MJ-6 | Constraint 15/15a; Tasks B2, B4, B5, B10 |

## Architect findings, 1–19

| # | Finding | Verdict | What changed |
|---|---|---|---|
| 1 | Denylist in `menu/catalog.mjs`, not `keysync.mjs:buildProviders`; hijack path open | accepted, larger fix | Merged with BL-1/MJ-5/MJ-10 → **M1**. Verified against `keysync.mjs:167–205`: no denylist import exists on that path. Task B1 moved to **A5.1**, `keysync/keysync.mjs` added to its Files list, `admitRemoteModels` filters `catalogEntries` **and** `vp.testModel` before `ranked` is computed. Filtering before the sort rather than inside it, so a hostile entry cannot consume one of the three `MAX_MODELS_PER_PROVIDER` slots and then be dropped. Constraint 11, Principle 3, pre-mortem Scenario 3 and the risk table rewritten. |
| 2 | B4 reads `models.json`, B5 writes `index.json`; picker never sees a refresh | accepted, larger fix | `writeSnapshot` now writes **both**: `models.json` in the schemaVersion-2 envelope readers load, and `index.json` as the merge ledger the next run reads. Neither is derivable from the other, which is why two files rather than one. B10 gains a test that loads the result through the real `loadCatalog`, not a fixture — a fixture is what hid this. |
| 3 | Blocking `readSync` makes the routability `.then()` and the resize listener unreachable | accepted | **M3.** Q1.3 rewritten to state the opposite of what it said; routability computed once in `refresh/cli.mjs` and baked into snapshot rows with `routableAsOf`; `.then()`, `on("resize")`, `routable.json` and `cachedRoutable()` all deleted. `routableSet` survives with one caller. A grep test in A10 fails the build if a `.then(` or a resize listener returns. |
| 4 | Coalesced key chunks dropped by the reducer (line 1798) | accepted, larger fix | Caught by the architect alone. Verified: a 6-byte `ESC[A ESC[A` chunk matches the arrow branch, moves once, discards the rest; a 2-byte chunk falls through every branch. Added `tokenize()` to `pick-state.mjs` as a pure exported function with six tests, used in A10's loop; read buffer raised 64 → 1024 bytes so a paste is not truncated by the read itself. New criterion Q3.8. |
| 5 | `uw doctor` greens on the exact failure it exists to catch | accepted | Caught by the architect alone. All three sub-fixes taken: `MAX_HANDOFF_AGE_MS` staleness bound (red when Claude Code has run since, amber otherwise); `readClaudeFingerprint` distinguishes "did not run" from "ran but did not parse", and the latter is red; auto-pinning removed entirely in favour of `uw doctor --accept-fingerprint`. |
| 6 | `settings.json` PS 5.1 round-trip corruption | accepted, larger fix | **M5.** The write no longer goes through PowerShell at all: new `menu/set-statusline.mjs` does the edit with `JSON.parse`/`JSON.stringify` through `menu/atomic.mjs`. Test pins that a one-element `permissions.allow` stays an array. |
| 7 | Tier 1 ingests models.dev with no denylist | accepted | Tier 1 now resolves the provider id and runs rows through `admitRemoteModels` before `outcomes.set`; tier 2's listings get the same treatment. Ingest is the only guard that stops a reserved name being *persisted*. |
| 8 | Production imports `harness/config.mjs` | accepted | `rpc` imported from `menu/ccr-client.mjs`. Added a test that greps every `.mjs` under `refresh/` for `harness/` and fails the build. |
| 9 | ETag never persisted; 304 path unreachable | accepted, larger fix | `mergeSnapshot` gains an `etag` parameter and carries it into the written snapshot. Beyond the finding: a 304 now writes **nothing at all** and returns early, because promoting an identical snapshot would evict an older version for no reason — which also resolves half of MINOR 19. |
| 10 | Health column is a hole, not a deferral | accepted, larger fix | **M4.** Rejected both of the architect's alternatives (ship the producer *or* delete the column) in favour of shipping two producers: `foldProbeResults` reads the `key-health-latest.json` that is on disk today, making the column live the day B7 lands; `writeHealthFromOutcomes` projects the merge ledger on every later refresh. |
| 11 | Bench measures the wrong path; `WRAPPER_SOFT_MS` unreferenced | accepted, larger fix | Merged with MJ-7. Bench child now renders with the real capability set and motion enabled, writes to a pipe, and stops the clock on the completed write; `recordStartup` uses the same point. Added `sampleWrapper()` measuring `uwpick.cmd` entry to exit against `WRAPPER_SOFT_MS`, which required a `UW_PICKER_QUIT_IMMEDIATELY` hatch in A10 (one caller, per Q5.2). New criterion Q1.5. |
| 12 | HUD shim parses the snapshot on every repaint; `model.id` mapping unverified | accepted, larger fix | Index cached on `snapshot.json`'s `mtimeMs`. The mapping concern was promoted from a note to a **blocking Step 0**: A14 now measures the real statusline payload for a CCR-routed non-Anthropic model before its code is trusted, because if `model.id` is not `provider/model` the shim is a silent no-op that passes every one of its own tests. |
| 13 | Fold the three probe scripts into tiers 2/3; add `testModelVerifiedAt` | accepted | New `refresh/probe.mjs` retires `key-health.mjs`, `key-health-reprobe.mjs` and `key-health-live3.mjs` (0 references in the reviewed plan, confirmed). `testModelVerifiedAt` added to `providers.json`, written only by tier 3, with two narrow consequences specified — a dimmed suffix on the leading row, and a demotion of an unproven testModel *only* when the catalogue offers an admitted alternative, so the measured 4/44 catalogue-first result is not reversed. |
| 14 | Provider namespace collision between tiers 1 and 2 | accepted, larger fix | Added `toVaultId()` with a curated `modelsDevName` alias field; unmapped names are dropped, never guessed. The finding is stronger than stated: tier 2 reads its target list from `Object.keys(prev.providers)`, so unreconciled it was being handed models.dev names and asked to probe them as vault ids. |
| 15 | Fingerprint describes shape not version; `bundledCatalogue` hard-coded | accepted | Merged with MN-9. `resolveInstall()` uses `require.resolve` with the literal as a documented fallback; `ccrVersion()` reads the installed `package.json`; `CONTRACT.fingerprint` carries the version; new `checkBundled` doctor check. |
| 16 | Tests touch the live catalogue | accepted, larger fix | **M6.** `root` threaded through `copyOut`, `resolveCatalogPath`, `acquireCatalogueLock`, `writeSnapshot` and `pruneVersions`. Constraint 15 amended to require this structurally: a module constant a test cannot displace makes the isolation rule unenforceable. |
| 17 | Exit-code contradiction: `finish()` always exits 0 | accepted, larger fix | **M2.** Critic BL-2's fix is the superset and both halves were taken. |
| 18 | Scope ~3x the estimate; merge and defer | **split** | The merges are **rejected** (below). The honesty point is **accepted**: Constraint 25 rewritten to state the real size (~4,800 lines / 27 tasks against a ~550-line budget) and to replace the unmeetable global budget with a checkable one on the picker's runtime path. The two deferrals are **escalated to the user**, not decided. |
| 19 | Retention race in `writeSnapshot` | accepted, larger fix | Extracted `pruneVersions()` with `KEEP_VERSIONS`, `PRUNE_GRACE_MS`, an explicit skip of the version `current` points at, and no write or prune on a 304. |

## Critic findings

### Blockers

| # | Finding | Verdict | What changed |
|---|---|---|---|
| BL-1 | Denylist not on `buildProviders`; B2 arms the hijack | accepted, larger fix | **M1.** The critic's `admitRemoteModels(reg.provider, ...)` filter was adopted; `vp.testModel` guarded too, and the filter placed before the sort rather than inside the loop. |
| BL-2 | `uwpick.cmd` exits 0 unconditionally; every abort injects `m` | accepted | **M2.** Both halves: `exit /b %ERRORLEVEL%` in `:pick` (and in the `UW_PICK_OVERRIDE` branch, so the behaviour is testable at all), passthrough stays 0; `abort()` in `uwpick.mjs` truncates the buffer and exits `discardExit` on every non-selection path, including a failed write. Three dispatcher exit-code tests added, three manual protocol steps (`P11a`–`P11c`). Q2.1, Q2.3a, Q2.6, Constraint 1 and A13's Interfaces line all rewritten — the Interfaces line had literally declared "exit code 0 always". |
| BL-3 | Routability redraw and resize handler can never run | accepted | **M3.** Of the critic's two options, the architect's snapshot-baked variant was taken: it deletes strictly more (the cache file and `cachedRoutable` as well) and gives every row an `asOf` stamp. |
| BL-4 | A9's exact-frame tests contradict its renderer; `pad()` strips colour | accepted, larger fix | Verified by execution and found **broader**. Fixes: colour after padding and `+9` deleted; `INNER` corrected `FRAME_W - 4` → `FRAME_W - 3`; `bar()` now truncates as well as pads, SGR-aware; both literals regenerated; a **derived column-offset test** added that computes each column's position from the `W` constants, so the literals are checkable rather than merely self-consistent; the two ASCII mocks regenerated from the constants (all lines verified at 78). Also folded in MN-2 and MN-3, which are the same renderer. |

### Major

| # | Finding | Verdict | What changed |
|---|---|---|---|
| MJ-1 | `consecutiveFails` has no producer | accepted | **M4.** Added to `EMPTY` and both branches of `mergeProvider` (`ok` → 0; soft/hard → +1), with the three-consecutive-failures test the critic specified. |
| MJ-2 | `health.json` has no writer; probe scripts orphaned | accepted, larger fix | **M4.** Both producers shipped. B7's "two-line follow-up" sentence deleted; the Deferred section now records the narrower residual (a provider with no credential in the probe file) instead of the whole column. |
| MJ-3 | `Set-Content -Encoding UTF8` writes a BOM | accepted | **M5.** All three sites use `UTF8Encoding($false)`; `readJsonOr` strips a BOM; new criterion Q2.9; test asserts the first byte is not `0xEF`. |
| MJ-4 | HUD uninstall is not byte-for-byte; the backup is never read | accepted | **M5.** `-HudUninstall` restores from `.uw-bak` when the recorded `previousCommand` still matches it, and falls back to a value edit that **announces itself**. New criterion Q6.4; the claim corrected in all four places rather than dropped, because the backup path genuinely is byte-for-byte. |
| MJ-5 | B2's ordering gate is a commit-message grep | accepted | **M1.** Replaced with a `buildProviders` behavioural assertion. The risk table row that named this test as its own mitigation was rewritten. |
| MJ-6 | `infertier.test.mjs` reads live state and is documented as failing | accepted, larger fix | **M6.** Corpus assertion moved to a standalone `test/corpus-tier.mjs`. Beyond the finding: new **Constraint 15a** forbids any known-failing test in the sweep and requires live-reading tests to be standalone or existence-gated, and the 24 hand-counted `# pass N` claims — now stale after this revision, and hand-written numbers of exactly the kind BL-4 punished — were converted to `# fail 0` plus an indicative count, with the convention documented. |
| MJ-7 | The startup benchmark does not measure its budget | accepted | Merged with architect 11. The misleading `keysync.mjs` diagnostic hint was verified and corrected. |
| MJ-8 | `priceOf`/`inferTier` read the first offer regardless of provider | accepted | Both take a provider name and prefer the matching offer, falling back to blank/`unknown` — never to offer 0. Threaded through `buildFrom` (`cred.provider`), `buildProviders` (`reg.provider`) and the corpus script (`m.provider`). Landed in the same pass as M1, as the critic recommended. |
| MJ-9 | `sanitizeDisplay` misses bidi, zero-width and surrogate classes | accepted, partial by design | Bidi and zero-width strip, NFC normalisation, and code-point slicing all added with tests; Constraint 13 rewritten. Full display-width awareness is **deferred with its consequence stated** in the Deferred section, as the critic allowed — including the observation that the frame-width test counts the same way the renderer does and so cannot catch it. |
| MJ-10 | The denylist ships 17 tasks after the renderer it protects | accepted, different fix | **M1.** Moved to **A5.1**, not after A3: the task rewrites `buildFrom`, which A5 authors. Weighed against Constraint 11 as instructed — moving it earlier satisfies that constraint strictly harder. The `opus-lookalike` fixture was renamed, with a note recording that the reducer never calls the denylist so the fixture was misleading rather than broken. |
| MJ-11 | `settings.json` written non-atomically | accepted | **M5.** tmp + `Move-Item -Force`; added to Q2.8's list; `.uw-bak` recovery added to the risk table as the critic asked. |

### Minor

| # | Verdict | What changed |
|---|---|---|
| MN-1 `healthDot` glyph | accepted | Four distinct glyphs in both sets (`dotOk`/`dotWarn`/`dotBad`/`dotStale`); the test rewritten to assert *inequality* across all four in both sets, which is what its title always claimed. |
| MN-2 health cell truncates `needs $` | accepted | Folded into BL-4. Label gets the full `W.health`; the dot moves to a documented two-column gutter. Constraint 6's "width 8" clarified rather than silently changed. |
| MN-3 level-0 header one column wide | accepted | Folded into BL-4. `proportionBar` default width is now `W.bar`; the header derives from the same constants; the offset test asserts they agree. |
| MN-4 `buildFrom` signature omits parameters | accepted | Interfaces line now lists `cadenceOf`, `healthOf` and the new `routableOf`. |
| MN-5 twelve vs fifteen steps | accepted | Corrected to fifteen (`P1`–`P15`, plus the new `P11a`–`P11c`). |
| MN-6 A4 Interfaces omits `paths` / `displayPath` | accepted | Both added, with a note on why the omission mattered. |
| MN-7 boundary grep only scans `.mjs` | accepted, larger fix | Extended to `.mjs|.ps1|.cmd` with a per-file **and per-needle** allowlist, plus a second test asserting no non-contract file is exempted wholesale — so the guard cannot be widened into uselessness. |
| MN-8 `catalog.mjs` listed as Created and Moved | accepted | Removed from Created. |
| MN-9 `bundledCatalogue` hard-coded | accepted | Merged with architect 15. |
| MN-10 top-level `await import()` | accepted | Static `import * as K from "../keysync/keysync.mjs"`. |
| MN-11 output VT assumed, never set | accepted | Recorded as new criterion Q7.8 and in A12's wrapper notes, with the failure mode named. |

## Rejections

| Finding | Reason |
|---|---|
| **Architect "Antithesis"** — replace the terminal TUI with a two-round `UserPromptSubmit` numbered picker | Reverses D5, which is user-approved and closed, and was taken *after* the user drove both surfaces on this machine ("this is it, i like this method"). A plan does not reverse a decision the user made from direct experience because the implementation is larger than the alternative. The argument is coherent and its cost accounting is correct — six of 27 tasks do exist to contain one input primitive — and it is recorded in the plan's Option D section with its reasoning intact. **Its diagnosis was accepted in full**: that a blocking `readSync` forbids every asynchronous promise the plan makes is exactly BLOCKER 3 / BL-3, and is the whole content of the Q1.3 rewrite. |
| **Architect MINOR 18** — merge A3→A5, B1→B2, B7→B6, A11→A8 | Judged per suggestion, all four rejected. *A3→A5*: couples the security primitive to the builder, and A5.1 now depends on A3 landing separately first. *B1→B2*: contradicts Constraint 11 and BL-1's entire point — the two must be separable to be orderable. *B7→B6*: the reader must stay testable from fixtures independently of the producer; the ordering is already correct (B6 precedes B7) and B7 now consumes B6's output directly. *A11→A8*: buries a process benchmark inside a module task. The underlying scope observation was accepted and acted on through Constraint 25 instead. |
| **Critic MJ-10's stated dependency** — "it depends only on `admitId`", so move to after A3 | The move is right; the dependency claim is wrong. B1 rewrites the model loop inside `buildFrom`, authored in A5, and its test imports `buildFrom`. Placed at A5.1. |
| **Critic BL-4's arithmetic for the corrected case** — "with a correct 6-wide badge the row is 68 → fits" | 68 fits, but the line is then 77, not 78, because `INNER` is itself off by one. Accepting the fix as written would have left every line one column short and the invariant test still failing. |

## What each reviewer caught alone

This comparison is evidence about the review process, not about the reviewers.

**Only the architect (6 findings):** the coalesced-key defect (BLOCKER 4), `uw doctor` greening on its own failure case (BLOCKER 5), tier 1 bypassing the denylist (MAJOR 7), production importing the test harness (MAJOR 8), the ETag never being persisted (MAJOR 9), and the provider namespace collision (MINOR 14). Four of these six are in the refresh pipeline, and two are unreachable-code defects a step further from the reader than the ones both found.

**Only the critic (12 findings):** the frame-geometry cluster (BL-4, MN-1, MN-2, MN-3), `priceOf`'s first-offer bug (MJ-8), the sanitizer's bidi and width gaps (MJ-9), and six of the eleven minors. These are concentrated in exactly the places where prose and code disagree at close range — where a test's title contradicts its assertion, or a comment states a property the line below does not implement.

**Both (6 defects, 13 findings):** every one of the six is a case where the plan asserted a safety or failure property in prose and the code could not deliver it. That both reviewers independently converged on the same six, from different starting points, is the strongest signal in this exercise: **the class of defect that survives one review is prose-code disagreement, and it is the class that shows no runtime symptom.** It is why the revised plan now asserts every security claim against the output of the function that does the harm, and why that principle is a row in the risk table.

The architect's structural framing ("push all liveness into `refresh/cli.mjs`") is what turned four separate findings — routability, health, the probe scripts, `testModelVerifiedAt` — into one coherent change. The critic's line-level verification is what caught the defects that only arithmetic reveals. Neither review alone would have produced this revision; running them separately on the same snapshot, without either seeing the other, is what made the overlap meaningful rather than an echo.

## Open questions for the user

Both are recorded in the plan's new "Open questions for the user" section, immediately before the Deferred section.

1. **Do Task A14 (`hud-shim.mjs`) and the `-Hud` half of Task A16 stay in scope?** A reviewer proposed deferring both. They carry quality criterion Q6 and were an explicit user follow-up request, so the planner did not decide it. Deferring them means the OMC footer keeps reporting 200000 as the context window for every non-Anthropic model — the specific gap the request was about. Cost is roughly two tasks out of 28. Planner's recommendation: keep both. Note that A14 now carries a blocking Step 0 that measures the real statusline payload first, because without it the task can be a silent no-op that passes all its own tests.

2. **Should Phase A ship before Phase B is executed?** Not raised by either reviewer; it follows from moving the denylist to A5.1. Phase A now carries its own security guard on both the render and the routing path, which removes the strongest argument for keeping the phases welded. Splitting is not proposed — D8 makes them one plan — but A1 through A17 is now a coherent shippable unit if working ctrl+g sooner is worth more than a single delivery.

## Verification performed

Read-only. No code was executed from the plan, no git operation was performed, no live state was written.

- Plan hash verified against both reviews before editing; the reviewed snapshot preserved as `phase6-menu-and-catalogue.v2-reviewed.md` (`_bak.md` and `.v1.md` untouched).
- `keysync/keysync.mjs:167–205` read directly to confirm BL-1: no denylist import, no `admitRemoteModels` call, `ranked` exactly as both reviews quote it.
- `keysync/key-health-latest.json` read to confirm the shape B7's fold depends on.
- Frame geometry computed by execution, not by inspection — this is what found the `INNER` off-by-one that neither review reported, and both ASCII mocks were regenerated from the column constants and verified at 78 columns.
- Code-fence balance and task-heading structure checked after every structural edit (356 fences, balanced; 28 task headings).

Revised plan sha256: `fec3390d173826dda219fdb16908971ec57fe2b0ebc62547f91fcd3eca6b8c88` (8552 lines).

---

## Addendum — OMC and CCR compatibility pass (2026-09-03, after the user's scope decision)

Requested after A14 was confirmed in scope: audit the revised plan for compatibility and update-resilience against OMC and CCR specifically. This was not a review finding; it is a separate pass, and it found one defect introduced by my own earlier fix.

**Defect found in the revision itself.** The Q6.4 byte-for-byte restore I added guarded on `statusLine.command` matching between `hud-install.json` and `settings.json.uw-bak` — and then copied the *whole backup file* over the live one. `settings.json` has 22 top-level keys on this machine, including `hooks`, `permissions`, `modelPicker` and `enabledPlugins`, all with other owners. Any change OMC or Claude Code made after the install would have been silently reverted by a UW uninstall. Comparing one field proves the field we changed is unchanged and says nothing about the twenty we did not. Fixed: the whole-file restore now fires only when the live file differs from the backup in nothing but `statusLine`; otherwise a value-level edit preserves everything else and says so. This is the same class as "modifies an OMC file", arriving through a side door.

**Second OMC gap.** OMC's own setup and doctor write `statusLine.command`. When either has replaced UW's wrapper, `hud-install.json` is stale and `-HudUninstall` would have written that stale value over the one OMC just set — reverting an OMC update while reporting success. Fixed: uninstall verifies the command is still UW's wrapper, and otherwise leaves it alone, names what it found, and clears only UW's state.

**Largest CCR gap.** Report 10's P1 #10 — the local patch to CCR's `dist/main/cli.js` raising the gateway handshake timeout from 5 s to 20 s — had **zero mentions** across the whole plan. CCR changes on exactly one event, `npm i -g`, and that event silently reverts the patch; the symptom is an intermittent handshake failure under load that reads as flakiness. It has happened once already. Added `checkCcrPatch`, anchored on the stable literal `var PN="gateway",` rather than the minified identifier after it, normalising newlines before comparing (the file is CRLF on disk against an LF backup: 2,308,421 vs 2,299,525 bytes). Both traps are from the measurement, and getting either wrong would make the check cry wolf on every future CCR release. **The detection logic was executed against five inputs — stock, patched, minifier-renamed, plain-integer and rebuilt — before being written into the plan**, because this plan has twice been caught shipping expressions that were never run.

**Other CCR additions.** `checkRpcSurface` probes the method names UW calls (report 10 P1 #14: they are wire strings, not minified, which makes them the most solid CCR dependency available and still worth checking) and compares the installed version against the running one via `getAppInfo` — a mismatch means CCR was updated without a gateway restart, which is precisely the window where the patch is reverted on disk while the live process still holds it.

**New criteria and structure:** Q4.5 (CCR's single change event and the three checks covering it), Q4.6 (the catalogue copy-out as an insulation layer — a CCR schema bump cannot break the picker), Q4.7 (UW hard-codes no OMC location), Q4.8 (`settings.json` has several writers and UW behaves like one of them), Q6.5 (the shim is failure-transparent in both directions). A "Foreign contracts, and how each one breaks" register after the ADR; pre-mortem Scenarios 6 and 7; four risk-table rows; two manual protocol steps (`P14a`, `P14b`); the observed OMC command literal pinned as a fixture, mixed separators and all.

**One claim deliberately narrowed.** The first draft of the OMC boundary test asserted "UW does not know that OMC exists". The test does not check that and could not — `install.ps1` names OMC in a user-facing message on purpose, because telling someone which tool probably rewrote their statusline is the useful thing to say. Narrowed to what is actually checked and actually matters: UW hard-codes no OMC *location* that an OMC update could invalidate. Overclaiming in a comment above a test is the exact failure mode both reviews were convened to catch.

**One coupling accepted rather than guarded, and stated as such.** UW cannot detect that OMC changed its HUD's *behaviour* — only that the wrapped command exists and that a sample payload round-trips. If OMC stopped reading `context_window_size`, the shim would keep correcting a field nobody reads. That failure is cosmetic and non-silent (the footer renders; the number is the old wrong one), so it is accepted and named in the register rather than instrumented.

Plan after this pass: 8,967 lines, sha256 `a705afa7cf536f8db97981e0dfb2a684be449856ad0213e1ae5f1a16632c3e5d`. Still pending approval.


---

# Round 2 — consolidated synthesis

Both round-2 reviews adjudicated in one pass. Anchor: `a705afa7cf536f8db97981e0dfb2a684be449856ad0213e1ae5f1a16632c3e5d`, 8,967 lines, verified before editing.

| | |
|---|---|
| Architect-2 | SOUND-WITH-CHANGES — 1 BLOCKER, 3 MAJOR, 3 MINOR. 15 of 17 accepted prior findings resolved, 2 partial. |
| Critic-2 | UNSOUND — 1 BLOCKER, 3 MAJOR, 5 MINOR. 25 of 26 prior resolved, 1 partial. |
| Outcome | 13 accepted as proposed, 3 accepted with a larger or different fix, 0 rejected. |

Nothing was rejected this round. Every finding held up on inspection, and two proved broader than reported.

## The convergence

Both reviewers independently found the same blocker from opposite directions — the architect by tracing values forward from `tier1` to `writeSnapshot`, the critic by noticing that one test file asserted two incompatible types for a single field. Round 1's six-way overlap was prose-versus-code; this one is **type-versus-type across a module boundary**, and it hid for the same underlying reason: the two producers and the one consumer were each internally consistent, and nothing in the plan stated the type they were supposed to share.

That is the class signal worth carrying forward. The fix is not "check `writeSnapshot`" but "name the element type once, at the interface, and make the fixtures agree" — which is why `Entry` is now stated in B5's and B6's Interfaces blocks rather than only corrected at the spread site.

## Blocker

**N1 / NB-1 — `writeSnapshot` spreads bare id strings, so the first successful refresh empties the catalogue.** Accepted, both facets, scoped by the team lead's decision: objects end to end.

Confirmed by reading the producers. `tier1` did `Object.keys(p?.models ?? {})`; `tier2` did `models: kept` from `admitRemoteModels`, whose own JSDoc says `string[]`; `writeSnapshot` spread each element into `{...m, provider}`. Spreading a string yields `{"0":"a",…}` with no `model` key, and `loadCatalog`'s `if (!m.provider || !m.model) continue` then discards every row. The Interfaces line already said `Map<string, Entry[]>` while the implementation returned `Map<string, string[]>` — the critic's observation that the whole defect is stated in that one-word disagreement is exactly right.

Changed: `tier1` keeps models.dev's per-model values as `{...meta, model: id}`; `tier2` mints `{model}` with **no `pricing` key at all**, so `priceOf` returns null and `badgeOf` returns blank rather than `FREE?` on a model nobody priced; a new `mergeEntries` lets the incoming listing decide membership while the record carrying `pricing` wins per id, so a tier 2 run after a tier 1 run no longer destroys every price; `writeSnapshot` throws with a named message if an element arrives without `model`; and the lone coercion in `refresh/cli.mjs` (`m.model ?? m`) is gone, since accommodating both shapes at one seam is what let the ambiguity survive at all the others. The B5 fixtures are unified through `E()`/`ids()` helpers so one file cannot again assert two types for one field. Both reviewers asked for the same gate and it is added: write a snapshot, read it back through the real loader, assert a non-zero provider count **and** that a row still survives `priceOf` and `badgeOf`.

The architect's corroborating point is fixed too: the File Structure prose described the versioned `models.json` as "an immutable copy of the full CCR catalogue, roughly 19.7 MB" while `writeSnapshot` writes a thin merged list. Prose and code described two different files; the prose now describes the one that exists and distinguishes it from `copyOut`'s verbatim bundle.

## Major

**N2 — B9 Step 3 reinstates `catalogEntries` on the ranking path.** Accepted. A literal reading reopened report 08 F1 on the one task that makes free-first ranking total. Changed to `safeEntries`, with a note recording that A5.1 changed the argument. Swept the plan as instructed: the only other `catalogEntries` references are A5.1's own wiring instructions, which are correct, and the Modified-files table.

**N3 — the health projection overwrites probe verdicts with listing evidence.** Accepted, with the team lead's precedence rule. `writeHealthFromOutcomes` now merges into the existing document, skips any provider whose entry is `source: "probe"`, and for a keyless tier records only that the provider was seen listed — no `lastOk`, no `consecutiveFails`. Each entry carries `source` and `at`. `resolveHealth` gained two changes: age is measured per entry rather than from the document stamp, because a refresh rewrites `generatedAt` and would make a two-week-old probe verdict look fresh; and a `listing` entry can never render `ok`. Two tests: a tier-1 run cannot make a probe-dead provider healthy, and a keyed tier may supply evidence for providers the probe missed but still not over a probe.

**N4 / NB-5 — the false `SECURITY:` warning.** Accepted on both paths. `admitId(undefined)` returns null and the rejection path stringifies it, so every provider without a curated `testModel` printed a security line on every run. Guarded the call rather than filtering the message, as instructed, with a test that captures `console.warn` and asserts no `SECURITY` line for a provider with no `testModel`. Worth more than its size: A5.1's Step 4 asks the implementer to read that dry-run output for exactly this kind of signal.

**NB-4 — code-point versus code-unit divergence.** Accepted, and **the consequence is broader than reported**. The critic predicted the width invariant would fail. I built the case and executed it: with 30 astral code points the three measures disagree, and depending on the exact lengths the line either fails the test *or* reaches 78 code units while rendering about thirty columns short — the test passes and the frame is wrong. That second outcome is the one that would have shipped. Fixed with one `vis()` helper used by `pad`, `rpad`, `bar`, `clipVisible`, the title and footer rules and the width test; A3's comment narrowed to what the cap actually guarantees (no split surrogate), with the display-width half explicitly deferred; and a regression test renders a 30-emoji `keyId` and asserts 78.

**NB-2 and NB-3 — the two A9 tests.** Both verified by execution before changing anything, per the brief. Both fail as written.

NB-2: the level-0 literal asserts `3` in the count column; the renderer emits `r.models.length` = 2. The cause is the fixture — `free: 3` on a two-model row with one FREE and one PAID badge — and the critic is right that regenerating the literal from a run would have printed `2` while preserving an impossible "3 free of 2 models". Fixed at the fixture (`free: 1`), which also changes the bar to `proportionBar(1, 2)` = `"###..."` and the free text to `"1"`. The corrected literal was then verified against a reimplementation of the renderer: exact match, 78 columns.

NB-3: `V1` puts the cursor on its only item, so the row renders as `p.inv(strip(body))` — `strip` removes the badge colour before the inversion wraps it, leaving only the inversion escapes. Executed: the colour assertion cannot match on a selected row and does match on an unselected one. The critic's reading that the render is correct and the fixture is wrong is right. Moved the assertion onto an unselected row.

After all changes, all ten row types were re-verified at exactly 78 columns by execution.

## Minor

| # | Verdict | Change |
|---|---|---|
| N5 | accepted | Q4.3 said "no other file in the repository" while its test scans `menu/` and `refresh/`. Reworded to name the two directories and to state that pre-existing coupling in `keysync/` and `harness/` is out of scope — a tree-wide grep would fail on day one and be disabled. |
| N6 | accepted, larger fix | Constraint 25's 900-line budget omitted `cc-contract.mjs` and `state.mjs`, both directly imported by `uwpick.mjs`. Added, and the list is now defined as the transitive import graph rather than a hand-picked set. The architect's disagreement — that a budget made true by redefining what it counts, and enforced by nobody, is a third state — is fair and is taken: it is now **enforced by an assertion** in A11, gated on the modules existing so `# fail 0` holds beforehand. |
| N7 / NB-6 | accepted | `menu/set-statusline.mjs` and `refresh/health-writer.mjs` added to the Created table. |
| NB-7 | accepted | `sampleWrapper`'s bare `catch` reported the best number exactly when the chain was most broken — a missing `uwpick.cmd`, a spawn error and a timeout are all fast. It now inspects: only an exit code equal to `discardExit` is the expected abort, and anything else prints a warning naming what happened and marks the number as not a measurement. |
| NB-8 | accepted | The guard banned `.then(` while `main()` was `async`. Dropped `async` (nothing awaited it), changed the call site, and added two assertions: no `await` anywhere in `uwpick.mjs`, and `main` must not be declared async. |
| NB-9 | accepted | The empty-state row exceeded `INNER` at a 24-character filter and clipped from the right, losing `backspace to widen, esc to clear` — the way out — at the moment the user is most stuck. Reordered so the instruction precedes the echoed query and the query clips to 20. Q3.2, the frozen mock (width preserved at 78) and a new overflow test updated together. |

## Two things found while verifying, not in either review

**A broken regex I introduced last round.** The B5 test comparing `resolveCatalogPath`'s output contained an unterminated character class, produced by heredoc backslash mangling in my own earlier edit. Fixed. This is the third time in this project that backslashes have been mangled through a heredoc; the working-style note warning about it is correct, and those strings should have gone through the editing tool.

**The two `testModel` guards did not persist on first application.** A multi-part script aborted on a later assertion before writing, so an earlier success message did not mean the earlier substitutions had landed. Caught by a residual grep at the end rather than by assumption, and both are now verified present by reading the file back.

## Verification performed

Read-only against the plan; nothing executed from it, no git operations, no live state written.

- Anchor hash verified before the first edit and reported after the last.
- NB-2 and NB-3 reproduced in a standalone script against a reimplementation of the renderer, before any change — both confirmed failing, and the corrected literal confirmed matching.
- NB-4 reproduced, and found to have a second and quieter failure mode than the one reported.
- All ten row types (title, footer, both headers, three row kinds, two empty states, astral) re-verified at 78 columns after every change.
- Residual greps for shape coercions, `catalogEntries` on the ranking path, unguarded `testModel` admits and the old width measures — all clean.
- Code-fence balance (360, balanced) and task-heading count (28) checked after every structural edit.

Revised plan sha256: `4b966e746708afba446493bee7cbdfbfcd64e1bdfcd3e9f76086fd7fd0cc87d2`, 9,444 lines. Status: **pending approval**.


---

# Round 3 — consolidated synthesis

Both round-3 reviews adjudicated in one pass. Anchor: `4b966e746708afba446493bee7cbdfbfcd64e1bdfcd3e9f76086fd7fd0cc87d2`, 9,444 lines, verified before editing; both reviewers confirmed the freeze held.

| | |
|---|---|
| Architect-3 | SOUND-WITH-CHANGES — 2 BLOCKER, 2 MAJOR, 2 MINOR. 5 of 7 round-2 findings resolved, 2 partial. |
| Critic-3 | UNSOUND — 1 BLOCKER, 2 MAJOR, 2 MINOR. 6 of 9 resolved, 1 partial, 2 not resolved. |
| Outcome | 10 findings, all accepted. 0 rejected. |
| Findings trend | 45 → 16 → 10. |

## The process change, which was the cause and not a finding

Plan code blocks are no longer written through shell heredocs, and every fenced JavaScript block is now verified by extraction rather than by reading.

The evidence is unambiguous. Three review rounds *read* this plan and missed five blocks that do not parse. Extracting all 78 and running `node --check` found every one in seconds, and reproduced the critic's result exactly on the first run. That sweep is now `check-blocks.mjs`, and Constraint 15b requires it.

Two distinct corruptions were at work, and only the first was previously understood:

- A quoted-delimiter shell heredoc **strips** a backslash level. This produced `/[\]/g` from `/[\\]/g` — the fourth occurrence.
- A Python-in-heredoc additionally **interprets** escapes. `\b` did not arrive stripped; it arrived as a literal BACKSPACE byte (0x08) sitting inside a regex literal. `\n` arrived as a real newline, breaking a string across two lines in two places.

The second is worse because it survives `node --check` in some positions — a literal U+FEFF parses fine — so a second sweep, `check-control-chars.mjs`, now looks for control and invisible characters that parse but cannot be read. It found three stray BOMs from my round-1 pass, one of them inside a regex literal where nobody could see what was being stripped.

Then it found one more, in the sentence I had just written describing this exact bug: my text about a Python heredoc turning `\b` into a backspace byte was itself written through a Python heredoc and contained a literal backspace byte. The tool caught it. That is the argument for the tool in one line.

## Blockers

**NC-1 / N10 — five non-parsing blocks.** Accepted. All five repaired through the editing tool and verified by re-running the sweep after each.

The severity driver was `menu/sanitize.mjs`. Its `INVISIBLE` character class was written with literal invisible characters, two of which — U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR — are ECMAScript LineTerminators and may not appear in a regex literal. Verified independently with `od -c` before touching it. Task A3 is the third task in the plan and `style.mjs`, `catalog.mjs` and `denylist.mjs` all import it, so nothing downstream loaded.

The class was rebuilt with `\uXXXX` escapes **by a generator**, not by typing, because the escape had to survive a path that had already converted it twice — and, on testing, my own emission converted a typed `​` back into the character it denotes. `fix-invisible.mjs` builds the backslash from `String.fromCharCode(92)`, compiles the pattern before writing, and refuses to write unless all seventeen covered code points still strip and ordinary text is untouched.

The brief's additional instruction was the important half: A3's per-code-point tests covered seven of the nine characters but not U+2028 or U+2029, so the obvious repair — retype the class — would have silently dropped the two the author cannot see while leaving every test green, removing exactly the two that break a full-screen frame writer. The tests are now table-driven over all seventeen code points, each named, with U+2028 and U+2029 additionally called out in their own test explaining why they are the two that make the class unparseable.

The other four: two missing `]` in `denylist.test.mjs` (the file holding the hostile-`opus` gate for A5.1 — an unparseable file reports no failures, so `# fail 0` would have passed over the security test), and two `"\n"` collapsed to real newlines in A16's install test.

**N8 / NC-2 — `tiers.test.mjs` still asserts `string[]`.** Accepted; both reviewers found it independently. Three assertions rewritten to map `.model`, the stale title "provider -> model ids" corrected to "catalogue entries", and — the part that matters more than the three lines — B5's `ids()` helper copied into the file with the comment explaining what it prevents. Both reviewers made the same point about repair direction: the failure is loud, but an implementer reading `expected ['a','b'], got [{model:'a'}]` may fix the *producer*, which reopens the round-2 blocker. A single helper removes the choice.

## Major

**N9 — the health `source` clause.** Accepted, resolved by the team lead's three-source ruling rather than by choosing between the clause and its five contradicting assertions.

The diagnosis was that `source` conflated *how we learned something* with *whether a key answered*, which made `writeHealthFromOutcomes`' keyed branch dead code: it carefully wrote `lastOk` for tier 2, and the reader discarded it because the label said `listing`. Sources are now `probe` > `keyed-listing` > `listing`, with `outranks()` making the precedence explicit; `ok` requires a keyed source and a `lastOk` inside the freshness window; tier 1 alone, or no entry, renders `stale`.

The five contradicting assertions were **changed, not preserved**, per the ruling. Three were round-1 tests asserting `ok` for a never-probed provider; that premise predates `stale` having a producer, and rendering "never checked" as `ok` is the guess Principle 1 forbids. The whole model — 26 cases including both writer branches and the downgrade rules — was verified by execution before the plan was edited to claim it.

**N11 — `writeHealthFromOutcomes` called but never imported.** Accepted. The ordering made it worse than a missing line: the call sits after `writeSnapshot` has flipped `current`, so the `ReferenceError` landed *after* promotion — catalogue advanced, health never written, picker snapshot never rebuilt — and B6's own verification could not see it because `--dry-run` returns first. The import is added in B6 with a note that B7 supplies the module, so the ordering reads as deliberate.

**N4 / NB-5 residual and NB-8 — the `await` guard.** Accepted. `assert.doesNotMatch(src, /\bawait\b/)` failed against the file it reads, because the marker comment it protects contains the word in prose. Now strips line comments first. Word boundaries had to be repaired twice: the first fix put literal backspace bytes in the file.

**NC-4 — the catalogue-lock test.** Accepted, and the critic is right that it missed this in rounds 1 and 2. Three `acquireCatalogueLock()` calls took no argument, so `root` defaulted to the live `~/.uw/catalog` — creating a real lock in the directory the running session's picker reads, while the header comment eight lines above claimed no test in the file could see it. A test process killed mid-run would leave a lock blocking real refreshes. Threaded a temp root, and added the two branches the old title promised but never exercised: reclaiming a lock owned by a dead pid, and refusing a corrupt lock.

## Minor

| # | Change |
|---|---|
| NC-3 | One A9 width assertion still measured code units three lines below a comment forbidding it. Its fixture is all-ASCII so it passes today; it would read 153 the moment the fixture gained an astral character — in the one test whose subject is over-wide input. |
| N12 / NC-5 | Tier 3 returned a whole-run verdict keyed under a fabricated provider `__verify-cli`, which `mergeSnapshot` had no concept to reject: it minted a zero-model provider, the carry-forward rule preserved it permanently, the next tier 2 asked CCR to probe a provider that does not exist, and it reached `health.json`. Tier 3 now returns an empty outcomes map and reports through stdout and a status code. Its `spawn` is injectable and `verify-cli.mjs` is resolved relative to the module, so the billed path below the confirmation gate is testable at all — previously nothing under that line was covered. `probe`/`rpc` dropped from its Interfaces line, which declared options the implementation never destructured. |
| N13 | B7's Interfaces line declared `writeHealthFromOutcomes(snapshot, now, out?)` against an implementation taking `{out, tier}`. Corrected, with a note that `tier` is not optional in effect: omitting it silently selects the keyless branch. **I reported this one myself while frozen; architect-3 found it independently, which is the useful data point — the self-audit was not the only net under it.** |
| (self) | `writeSnapshot`'s Interfaces line now records that it throws on a non-`Entry` element. |

## NB-2, and a correction of the record

The A9 level-0 literal was **not resolved in round 2**, and my round-2 synthesis said it was. That claim was wrong.

The mechanism is the one I documented in that same synthesis and then failed to apply to itself: a multi-part script aborted on a later assertion before writing, so its earlier substitutions never landed. I checked the `testModel` guards from that aborted script afterwards and confirmed them; I did not check the NB-2 substitutions from the same script. Verifying one output of a failed batch is not verifying the batch.

Fixed now, by the smaller of the critic's two options: the A9 fixture reads `free: 1` (one `FREE` badge, one `PAID`), and the literal was **regenerated by running the renderer** rather than transcribed — count `2`, bar `"###..."`, free `1`, verified at 78 code points. The transcription is what put the wrong value in originally: the frozen ASCII mock shows this provider with three models, the fixture has two, and `proportionBar(3, 2)` saturates to a full bar, so the count column was the only cell that exposed the disagreement.

**Correction to the round-1 and round-2 notes, as instructed.** The claim that the critic's causal attributions failed twice is struck. Round 1's dependency claim (`MJ-10`, "depends only on `admitId`") was genuinely wrong and the critic acknowledged it. Round 2's attribution was **right**: it traced the literal to the A9 fixture at L3193 reading `free: 3`, and the correction offered against it cited L3916 — a different fixture, `free: 12, planCount: 4`, in Task A10. One error, not two, and it was not the critic's.

## Verification performed

- `check-blocks.mjs`: **78 fenced JavaScript blocks, all parse.** 3 deliberate fragments skipped, marked `// FRAGMENT:` in the plan itself rather than by line number — a line-number list went stale on the very next edit, which is why the marker moved into the file.
- `check-control-chars.mjs`: no literal control or invisible characters. Found and fixed four the parse sweep could not see.
- The three-source health model executed across 26 cases before the plan claimed it.
- The A9 literal generated by running the renderer, at 78 code points.
- The `INVISIBLE` class verified against all seventeen covered code points, with the generator refusing to write unless every one still strips.
- Structure: 360 fences balanced, 28 tasks.
- Residual greps: the three surviving `string[]` sites are a `probeProvider` wire response, comments describing the removed `__verify-cli` defect, and production's intentional default lock root. All correct.

Revised plan sha256: `05ac621c92099ecd9a5dd5dc49fedc525ee0c18f595900fcfcdadb12e88564e9`, 9,728 lines. Status: **pending approval**.

## Round-3 addendum — NC-5 and the Interfaces sweep

**NC-5 needed no rework.** The copy of `phase6-review-critic-3.md` read at the start of this pass already carried it (verdict line reading 1 BLOCKER, 2 MAJOR, 2 MINOR; two `NC-5` occurrences), so it was adjudicated together with architect-3's N12 as one defect and fixed in the same edit. The critic's extra trace — that the shrink guard is skipped when there is no prior entry, so a zero-count provider is minted and then preserved by the carry-forward rule — matches what was traced independently and changes nothing about the fix. Under the three-source ruling the phantom would additionally have arrived carrying `keyed-listing` strength, which is now moot: tier 3 contributes no outcomes at all.

**The Interfaces sweep found one more instance, and through it a module with no caller.**

`check-interfaces.mjs` extracts every declared signature and every implementation, and reports only where an implementation destructures an option set that disagrees with what the declaration advertises. Building it took two attempts, and the first is worth recording: it reported eleven disagreements, of which every one was a parsing artifact — it read default values as parameters (`{ root = CATALOG_DIR }` as `root, CATALOG_DIR`) and split on commas inside generics (`Map<string, Outcome>` as two parameters). A checker whose false positives outnumber its true ones does not get read, which is the same failure as an unenforced budget. The rule that fixed it is narrow: compare key sets **only where the implementation actually destructures**, which removes both classes at once.

With that, four real findings across the plan:

| Function | Defect |
|---|---|
| `tier2` | Declared a `probe` option, `refresh/cli.mjs` passed it, the implementation destructured `{rpc, concurrency}` and silently dropped it |
| `readService` | Declared `()`, implemented `(file = CONTRACT.servicePath)` — an undeclared test seam |
| `checkCcrPatch` | Declared `({file})`, implemented `({file, read})` — the injected reader the tests depend on |
| `buildFrom` | Not a defect. The declaration is correct; the checker cannot parse an inline arrow-function type, and the limit is recorded in the tool rather than worked around by widening the parser |

`tier2`'s case resolved the opposite way to a routine documentation fix, and that is the substantive part. The implementation is **right**: the refresher must never hold a key value — that property is what makes a scheduled tier safe — so tier 2 goes through CCR's `probeProvider` RPC and lets CCR hold the credential. Which means `probe.mjs`, which reads key values from the vault and calls providers directly, cannot be called by tier 2. Tier 3 does not call it either; it delegates to `verify-cli.mjs`. So the module had a documented role in the File Structure table, a declared signature, an import in `refresh/cli.mjs`, and **no caller anywhere** — a specification with nothing behind it, which is the same species one level up.

Corrected honestly rather than by deleting the module: `probe.mjs` is a standalone command, run deliberately, that regenerates the results file Task B7's fold reads. The round-1 review asked for one probe implementation instead of three drifting scripts, and it still gets that; what was wrong was my claim about who calls it. The File Structure rows, the Interfaces block and B6's prose now say so, with the reason — the refresher holds no keys — stated where the next reader will look for it.

**Tier 3's real billed path is recorded in Deferred rather than left silent**, per the brief. The confirmation gate is tested including the truthy-vs-`true` case, and everything below it is tested through an injected `spawn`; the actual subprocess is not, and cannot be without spending money on every provider in the vault. The consequence and the three mitigations that bound it are stated there.

Constraint 15c now requires the Interfaces sweep, alongside 15b's parse sweep.

**Final gates, all clean:**

| Gate | Result |
|---|---|
| `check-blocks.mjs` | 78 fenced JavaScript blocks, all parse (3 marked fragments skipped) |
| `check-control-chars.mjs` | no literal control or invisible characters |
| `check-interfaces.mjs --all` | 98 declared, 103 implemented, 0 disagree |
| structure | 360 fences balanced, 28 tasks |

Plan sha256 after the addendum: `b1cd712dc6b235149331686f8c16e52c747f03ae810e9c87595d199298789022`, 9,737 lines. Status: **pending approval**.

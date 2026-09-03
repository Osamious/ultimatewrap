# Architect Re-Review (delta) — Phase 6 plan

Reviewer: `oh-my-claudecode:architect` (read-only), 2026-09-03.
Plan snapshot: `phase6-menu-and-catalogue.md`, 8,560 lines, sha256 `bae12508bf5719573d68a95fe04896fe46941236bfc5198ef5745af9653cba65` (verified).
Prior snapshot diffed against: `phase6-menu-and-catalogue.v2-reviewed.md`, sha256 `5f47b3e32dba62d7f871d2a817598b67bce6d2e78bfdf2259cf5ae2ba39b5f6a`.

Verdict: **SOUND-WITH-CHANGES** — 1 BLOCKER, 3 MAJOR, 3 MINOR new. Of seventeen accepted prior findings, **fifteen are genuinely resolved** and two are partially resolved.

The revision is substantially better than what it replaced. The pattern I complained about — a safety property asserted in prose that the code cannot deliver — has been removed at its two worst sites (Q1.3's unreachable async, Constraint 11's display-path denylist) rather than relocated. The one place it survives is Task B5, where the fix for my BLOCKER 2 corrected the filename and left the shape wrong, and the surviving defect is worse than the one it replaced.

## Disposition of the nineteen prior findings

| # | Sev | Finding | Status | Evidence |
|---|---|---|---|---|
| — | — | Antithesis: replace the TUI with a `UserPromptSubmit` picker | REJECTED-BY-PLANNER | Reverses approved decision D5; the diagnosis was accepted and is the substance of the finding 3 fix. |
| 1 | BLOCKER | Denylist lands in the wrong module; hijack path stays open | RESOLVED | Task A5.1 (line 1648) lists `keysync/keysync.mjs` in **Files**; the wiring at 1971–1977 filters `catalogEntries` into `safeEntries` and `vp.testModel` into `safeTestModel` before `ranked` and before the prepend, and names all four use sites. Verified against real `keysync.mjs:167-205`: `vp.testModel` is pushed at 183 ahead of `ranked` at 196, so both did need filtering. The replacement test calls `buildProviders(...)` and asserts on the ids in its returned `providers` array; the real function returns `{providers, picker, notes}`, so the assertion binds. The relay exemption survives, tested separately. The git-log test is gone. |
| 2 | BLOCKER | Refresh output can never be read by the picker | **PARTIALLY RESOLVED** | `writeSnapshot` now writes both `models.json` and `index.json` (7480 region) and the filename mismatch is closed, but the row shape it writes is not one `loadCatalog` accepts. See new BLOCKER N1. |
| 3 | BLOCKER | Routability column and resize are unreachable code | RESOLVED | Q1.3 rewritten to make `row.routable` a snapshot field with `routableAsOf`; Q7.2 promoted to a criterion every other criterion is checked against. A10 (3643) removes the RPC and the listener, and adds a grep test banning promise continuations, `on("resize"` and `routableSet` in `uwpick.mjs`. `null` renders undimmed, which is the honest "nobody checked". |
| 4 | BLOCKER | Coalesced key reads are dropped | RESOLVED | `tokenize()` is an exported pure function (A6, 1990; body at 2374) with its own multi-key suite, including the three-arrows-plus-a-character case I asked for, astral code points, and a truncated trailing CSI. Q3.8 states the property. |
| 5 | BLOCKER | `uw doctor` greens on its own failure case | RESOLVED | All three sub-fixes present with tests: `MAX_HANDOFF_AGE_MS` (5019) with a red verdict when Claude Code has run since; a fingerprint parse failure is red not amber (5111); pinning requires `--accept-fingerprint` and nothing else writes `capabilities.json` (5026). |
| 6 | MAJOR | `settings.json` round-trip corruption | RESOLVED | New `menu/set-statusline.mjs` replaces the PowerShell JSON round trip; `settings.json.uw-bak` is taken before any write; a second guard compares everything but `statusLine` between backup and live before restoring; Q6.4 now claims byte-for-byte only for the byte-for-byte path and requires the fallback to say so on stdout. |
| 7 | MAJOR | Tier 1 bypasses the denylist | RESOLVED | B6 imports `admitRemoteModels` and applies it at tier 1 and tier 2 ingest; a test asserts tier 2 drops the reserved names while keeping the benign one. |
| 8 | MAJOR | Production imports the test harness | RESOLVED | `rpc` now comes from `menu/ccr-client.mjs`; a test greps every file under `refresh/` for a harness import and fails the build. |
| 9 | MAJOR | ETag never persisted | RESOLVED | `mergeSnapshot` takes and carries `etag`; an absent etag on a later run keeps the stored one rather than clearing it; tier 1 sends the conditional header and returns 304 without re-parsing, both tested. |
| 10 | MAJOR | Health column is a hole, not a deferral | **PARTIALLY RESOLVED** | Two producers now exist (`writeHealthFromProbeFile`, `writeHealthFromOutcomes`, 8219/8231) and `consecutiveFails` is carried through the merge in B5, so `resolveHealth`'s `broken` branch is reachable. But the second producer overwrites the first with weaker data. See new MAJOR N3. |
| 11 | MAJOR | Bench measures the wrong path | RESOLVED | The bench child now uses the real capability set with motion enabled and writes the frame to a pipe; `sampleWrapper()` (4291) measures wrapper entry to exit against `WRAPPER_SOFT_MS`, so the constant is referenced rather than decorative. Q1.5 states the property. |
| 12 | MAJOR | HUD shim parses the full snapshot per repaint | RESOLVED | `cachedIndex()` keys on the snapshot's `mtimeMs` (4964). Step 0 is a blocking measurement of the real statusline payload for a CCR-routed non-Anthropic model, and the task explicitly names the silent-no-op-that-passes-its-own-suite failure it prevents. |
| 13 | MAJOR | Fold the three probe scripts; `testModelVerifiedAt` | RESOLVED | `refresh/probe.mjs` is the single probe, called by tiers 2 and 3; the three `keysync/key-health*.mjs` scripts are in the retired table. `testModelVerifiedAt` is added to `providers.json`, written only by tier 3, and demotes an unproven `testModel` only when an admitted catalogue alternative exists — which correctly preserves the measured 4/44 finding. |
| 14 | MINOR | Provider namespace collision | RESOLVED | `toVaultId(modelsDevName, providers)` maps through a curated alias field and returns `null` rather than guessing; tested including the drop case. |
| 15 | MINOR | Fingerprint describes shape, not version | RESOLVED | The Claude Code contract fingerprint is now a version string; the CCR catalogue path resolves through `require.resolve` on the package's own `package.json`, with the `nvm4w` literal demoted to a commented last-known-good fallback. |
| 16 | MINOR | Tests touch the live catalogue | RESOLVED | `root` is threaded through `writeSnapshot`, `pruneVersions`, `acquireCatalogueLock`, `resolveCatalogPath` and `copyOut`, each defaulting; Constraint 15 now requires every catalogue path to be a parameter with a default rather than a module constant a test cannot displace. |
| 17 | MINOR | Exit-code contradiction | RESOLVED | Constraint 1 states both halves of the abort (truncate **and** non-zero) and requires the dispatcher to propagate; the error-level propagation appears on the `:pick` branch only (4686, 4691), with a note that it is read before any intervening command. |
| 18 | MINOR | Scope is ~3x the estimate; four task merges | REJECTED-BY-PLANNER | Each merge assessed and declined with a reason; the scope observation was acted on through Global Constraint 25. See new MINOR N6 on the quality of that response. |
| 19 | MINOR | Retention race | RESOLVED | `pruneVersions` never removes the version named by `current`, honours `PRUNE_GRACE_MS` (10 min), and is tested with the oldest directory as current. |

## New findings

### BLOCKER

**N1. `writeSnapshot` writes model-id strings through an object spread, so every refreshed row loses its `model` field and `loadCatalog` discards all of them (line 7480).**

The fix for prior finding 2 corrected the filename and left the shape. Trace the values:

- Tier 1 builds its id list with `Object.keys(...)` over the models.dev per-provider models object and stores that array — an array of **strings**.
- Tier 2 stores `models: kept`, where `kept` comes from `admitRemoteModels(...)` — also an array of **strings**.
- `mergeProvider` stores those verbatim; B5's own tests use two-string model arrays, confirming the intent.
- `writeSnapshot` then spreads each element into an object literal alongside `provider`, `stale` and `staleSince`.

Spreading a bare string yields an object with a numeric index key and no `model` property. The emitted `models.json` therefore contains rows with no `model`, no `limits`, no `pricing` and no `capabilities`. `loadCatalog` guards with a check that skips any row missing `provider` or `model`, so **every row is skipped and the resulting provider map is empty**.

This is worse than the defect it replaced. Previously the resolver's snapshot branch never matched and readers fell back to the copied bundle, which is at least correct data. Now the branch does match and returns an empty catalogue, so the first successful `uw catalog refresh` empties the picker and empties keysync's routing input. B4's and B10's assertions on provider-map size both pass before a refresh has ever run and fail only afterwards, which is the wrong order for a plan whose Phase B ends with a live run.

The second facet is data loss upstream of the shape. Taking only the keys of the models.dev models object discards the per-model values — cost, limits, modalities, capabilities — which is precisely the metadata tier 1 exists to fetch. Even with the spread corrected to build a real object, the refreshed catalogue would carry no pricing, so `inferTier` returns unknown for every row, Task B2's whole purpose is defeated, every badge falls to blank or the uncertain variant, and Constraint 5's free column reads as no-price-data for all 44 providers.

Corroborating: the file-structure note (line ~265) still describes the versioned `models.json` as "an immutable copy of the full CCR catalogue, roughly 19.7 MB". `writeSnapshot` writes a thin merged list. The prose and the code describe two different files.

Fix: decide which artifact the versioned `models.json` is. If it is the catalogue readers load, tier 1 must retain the models.dev values and the merge must carry full entry objects, with `writeSnapshot` spreading objects rather than strings. If the merge ledger is to stay id-only, then the version directory must carry a genuine catalogue copy alongside it and `writeSnapshot` must join ids against that copy. Either way the gate is a test that runs a refresh into a temp root and then loads the result through the real `loadCatalog`, asserting a non-zero provider count **and** that a known row still carries pricing.

### MAJOR

**N2. Task B9 Step 3 reinstates `catalogEntries` on the ranking path, undoing Task A5.1's denylist (line 8539).**

B9 extracts the comparator into `rankModels(entries)` and instructs the implementer to replace the inline sort in `buildProviders` with a call passing `catalogEntries`. Task A5.1 had already replaced that argument with `safeEntries`. Following B9 literally re-opens report 08 F1 on the exact task that makes free-first ranking total, and B9's Step 4 then claims a clean run.

A5.1's `buildProviders` test is the thing that stops this shipping, which is an argument for that test rather than a mitigation of this defect: the plan instructs a security regression and asserts the suite is green, so an implementer who trusts the prose will hit a red suite on the last task of Phase B and may reach for the test rather than the line. Fix: pass `safeEntries`, and add a sentence in B9 noting the argument was changed by A5.1.

**N3. `writeHealthFromOutcomes` overwrites probe-derived health with listing-derived health, and lets tier 1 metadata assert that a key answered (line 8231).**

The two producers do not compose. `writeHealthFromProbeFile` folds the existing probe file, whose classification comes from real keyed calls — the measurement behind the 34/9/3 figure. `writeHealthFromOutcomes` builds its provider map from scratch out of the merge ledger and writes the whole document. It does not read the existing `health.json` and does not merge, so the first `uw catalog refresh` discards the probe verdicts.

Two consequences, both of which reintroduce the failure mode prior finding 10 was about, inverted:

- A provider absent from the refresh outcomes loses its entry entirely. `resolveHealth` then reads undefined, the `consecutiveFails` default is zero, and a provider the probe found broken renders as healthy.
- Tier 1 is the default tier and uses no keys. A tier-1 success sets `lastOk` in the merge ledger, which this function projects into `health.json` as evidence the provider is healthy. models.dev answering says nothing about whether the user's key works. The column then asserts a fact it has not measured, which is the same violation of "blank beats a guess" as before, now wearing a plausible value instead of a constant.

Fix: make the projection a merge that reads the current `health.json`, and have it write only fields the producing tier actually established — tier 1 must not touch `lastOk` or `consecutiveFails` at all. Carry a per-provider source marker (probe or listing) so `resolveHealth` can decline to upgrade a probe verdict on listing evidence. Test: fold the probe file, run a tier-1-only refresh, and assert a broken provider is still broken.

**N4. The `testModel` guard fires a false security warning for every provider that has no `testModel` (line 1974, and the display-path equivalent below it).**

`admitId` coerces a nullish argument to the empty string and returns null, so wrapping a missing `testModel` in a single-element array pushes the literal text `undefined` into the rejected list and reaches `admitRemoteModels`'s `console.warn`. `testModel` is optional — the original code guards it with an `if` — so every keysync run and every dry run prints one spurious security warning per provider lacking one. The same construct exists on the display path in `catalog.mjs`.

This matters more than the noise suggests. A5.1's Step 4 explicitly asks the implementer to read the dry-run output and treat a provider losing all its models as "a finding worth stopping for". Burying that signal in false positives is how a security control stops being read. Fix: guard the call so a missing `testModel` never reaches the admitter, or have `admitRemoteModels` skip nullish entries silently and warn only on entries that were actually present.

### MINOR

**N5. Q4.3 claims a repository-wide property that its test does not check (criterion text vs. the test at line ~871).** The criterion says no other file *in the repository* may contain the Claude Code or CCR path strings, and the task prose calls it "a grep over the tree". The test iterates two directories, `menu` and `refresh`. Twenty-plus existing files under `keysync/` and `harness/` contain those strings today, so a tree-wide grep would fail immediately — the narrower scope is almost certainly deliberate and correct, but the criterion should say what it checks. This is the same prose-overstates-code shape as my original complaint, at low stakes. Fix: reword Q4.3 to name the two directories, and note that pre-existing coupling elsewhere is out of scope.

**N6. Constraint 25's 900-line budget omits two modules the picker imports and has no check.** `uwpick.mjs` imports `./cc-contract.mjs` and `./state.mjs` (lines 3939–3941), both on the runtime path the budget claims to bound; neither appears in the seven-module list. There is also no test asserting the number — the only other occurrence of it in the plan is an unrelated median fixture. A budget that under-counts its own scope and is enforced by nobody is weaker than the scope observation it was written to answer. Fix: add both modules to the list and add a one-assertion test summing non-test line counts, or state plainly that the number is a review guideline.

**N7. Two files created by tasks are missing from the Created file table (lines 199–232).** `menu/set-statusline.mjs` (created by A16, and the mechanism of the prior finding 6 fix) and `refresh/health-writer.mjs` (created by B7, and the mechanism of the prior finding 10 fix) are named in their tasks' **Files** lines but absent from the table. Both are new in this revision. Fix: add both rows.

## Disagreement

One paragraph, as requested, and it is narrow. I accept the rejection of the Antithesis without reservation — the user drove both surfaces and D5 is theirs to make, and the diagnosis I actually cared about was adopted whole. On the four merges I also accept three of the four reasons as better than mine: coupling the security primitive to the builder, contradicting the ordering constraint, and burying a process benchmark in a module task are all real costs I underweighted. My remaining disagreement is with the response to the scope observation rather than with any of the merge rejections. Constraint 25 converts a budget into a measured fact plus a narrower budget, which is honest, but it is the one place in this revision where a number was made true by redefining what it counts rather than by checking it — and N6 shows the redefinition already under-counts. That is a small instance of exactly the pattern the rest of this revision fixed well, and I would rather see the 900 either enforced by an assertion or dropped to prose than left as a third state.

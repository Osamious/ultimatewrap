# Architect Re-Review 3 (targeted delta) — Phase 6 plan

Reviewer: `oh-my-claudecode:architect` (read-only), 2026-09-03.
Plan snapshot: `phase6-menu-and-catalogue.md`, 9,444 lines, sha256 `4b966e746708afba446493bee7cbdfbfcd64e1bdfcd3e9f76086fd7fd0cc87d2` — **verified against the anchor before reading.**
Scope: the regions the round-2 fixes touched, and defects those fixes introduced. The rest of the plan was verified in round 2 and was not re-read.

Verdict: **SOUND-WITH-CHANGES** — 2 BLOCKER, 2 MAJOR, 2 MINOR new. Of my seven round-2 findings, **five are resolved and two are partially resolved**.

The round-2 edits are directionally right everywhere I checked. Both partial resolutions share one shape, and it is worth naming before the detail: the fix changed the production code and the prose, and left assertions in the same file still encoding the old contract. In a plan whose every task writes the test first and then supplies the implementation, that is not a cosmetic mismatch — the test is the spec the implementer works to, and where the two disagree the implementer is being asked to make an unguided decision on exactly the property the fix was written to secure. In both cases, deciding in the test-first direction reinstates the original defect.

## Disposition of the seven round-2 findings

| # | Sev | Finding | Status | Evidence |
|---|---|---|---|---|
| N1 | BLOCKER | `writeSnapshot` spreads id strings; refreshed catalogue loads empty | **PARTIALLY RESOLVED** | `Entry` is declared once in B5 (7401) and again in B6 (7968) and the production path honours it end to end: `tier1` maps `Object.entries` to `{...meta, model: id}` (8206) instead of `Object.keys`; `tier2` mints `{model}` with no `pricing` key (8248); `mergeEntries` (7735) keeps the priced record for surviving ids; `writeSnapshot` throws by name on a non-`Entry` element (7889); the `m.model ?? m` coercion is gone from `refresh/cli.mjs` (8420, with the reason stated). `merge.test.mjs` uses one element type throughout and the end-to-end gate at 7531 asserts both existence and pricing through the real loader. But `tiers.test.mjs` still asserts id-string arrays in three places. See N8. |
| N2 | MAJOR | B9 Step 3 reinstates `catalogEntries` on the ranking path | RESOLVED | 9126 reads `const ranked = rankModels(safeEntries);`, and 9128–9130 add the paragraph naming A5.1 as the task that changed the argument and report 08 F1 as what a literal reading would reopen. Swept every post-A5.1 occurrence of `catalogEntries` (2068, 2076, 2078, 2094 only, all inside A5.1's own wiring) and every `rankModels` call site (9049–9126): nothing else binds ranking or the `testModel` path to an unfiltered array. |
| N3 | MAJOR | `writeHealthFromOutcomes` overwrites probe verdicts with listing evidence | **PARTIALLY RESOLVED** | The writer is correct: it reads the current file and merges (8868–8869), skips any provider already carrying `source: "probe"` (8872), and for a keyless tier writes only `{source, at}` — no `lastOk`, no `consecutiveFails` (8879). `resolveHealth` ages per entry off `entry.at ?? health.generatedAt` (8739–8741), so a refresh rewriting `generatedAt` no longer refreshes a stale probe verdict. A dead key cannot render `ok` by any path I could trace. But the reader's new clause contradicts five assertions in its own test file and discards the keyed/keyless distinction the writer just made. See N9. |
| N4 | MAJOR | `testModel` guard emits a false `SECURITY: … undefined` warning | RESOLVED | The **call** is guarded, not the message: routing path 2085–2087 (`vp.testModel ? (admitRemoteModels(...).kept[0] ?? null) : null`) and display path 2136–2140 for `prof.testModel`. The comment at 2078–2084 states the mechanism (`admitId(undefined)` coercing to `""`) and why burying A5.1 Step 4's dry-run signal in false positives costs more than the line saved. |
| N5 | MINOR | Q4.3 claims a repository-wide property its test does not check | RESOLVED | Line 84 now scopes the criterion to `menu/` and `refresh/`, says why (`keysync/` and `harness/` predate the plan and would fail on day one), and points at B4 as the task that widens the grep once `keysync/` is clean. |
| N6 | MINOR | Constraint 25's 900-line budget under-counts and is unenforced | RESOLVED | Constraint 25 (line 40) now derives the list from `uwpick.mjs`'s import graph and names `cc-contract.mjs` and `state.mjs`; the assertion exists in Task A11 at 4078–4094, sums non-comment lines over the same eight modules, and prints the per-file breakdown on failure. |
| N7 | MINOR | Two created files missing from the Created file table | RESOLVED | `menu/set-statusline.mjs` at 254, `refresh/health-writer.mjs` at 259. |

## Regression check

No regressions found. The round-1 fixes are all still present and still wired: `tokenize` (19 occurrences), `MAX_HANDOFF_AGE_MS` (5), `--accept-fingerprint` (9), `routableAsOf` (15), `testModelVerifiedAt` (7), `PRUNE_GRACE_MS` (4), `toVaultId` (9), `sampleWrapper`, `cachedIndex`, `settings.json.uw-bak` (12). Task A5.1's routing-path denylist is intact at 2062–2094 with all four use sites named. The OMC/CCR additions survive: `checkCcrPatch` (5851) and `checkRpcSurface` (5905) with their tests at 5517–5563, and the foreign-contracts register at 206.

## Self-reported fixes

**The `testModel` guards did land.** Both, in full, at 2085 and 2136. This was one of the two edits the Planner reported as having silently not persisted; it has persisted.

**The backslash-mangled regex did not fully land.** See N10 — two instances survive, in the one test file the N1 fix is built around. I swept every regex literal in the plan containing a backslash (`replace(/…`, `match(/…`, `split(/…`, `test(/…`): every other one is well-formed, and the correct `/\\/g` form appears at 963, 3087, 4364, 4486, 4592, 5326, 5660, 6065, 7131, 7232, 8470, 9013, 9185. The defect is isolated to 7525–7526, not systemic.

I found no third instance of an edit that reported success without landing, with one adjacent exception recorded as N11: a call site the round-2 edits added an argument to, whose import was never added anywhere in the plan.

## New findings

### BLOCKER

**N8. `tiers.test.mjs` still asserts that tier 1 and tier 2 emit id strings, contradicting both implementations and the `Entry` declaration three lines above them (lines 8086, 8107, 8115).**

The N1 fix declares the canonical type in B6's own Interfaces block: "**`Entry` everywhere.** Both tiers emit the schemaVersion-2 object `{model, ...}` … never a bare id string" (7968). The implementations comply — `tier1` returns `[{model: "acme-1", ...meta}]` (8206) and `tier2` returns `kept.map((id) => ({model: id}))` (8248). Three tests in the same file assert the opposite:

- 8078–8086, `tier1 parses a 200 into provider -> model ids`: `assert.deepEqual(r.providers.get("acme"), ["acme-1", "acme-2"])`. The implementation returns `[{model:"acme-1"},{model:"acme-2"}]`.
- 8107, `tier2 asks CCR to probe and classifies each result`: `assert.deepEqual(out.get("good").models, ["a", "b"])`. The implementation returns `[{model:"a"},{model:"b"}]`.
- 8115, `tier2 applies the denylist to every remote list`: `assert.deepEqual(out.get("evil").models, ["fine"])`. The implementation returns `[{model:"fine"}]`.

All three fail against the code the same task supplies, so B6 Step 4's `# fail 0` cannot hold. That much is loud and self-correcting. What is not self-correcting is which side the implementer corrects. B6 is a test-first task: Step 1 writes this file, Step 2 confirms it fails, Step 3 supplies the implementation. An implementer working that order has three tests demanding `string[]` and one test — `tier 1 keeps models.dev's metadata, not just its ids` at 8043 — demanding `Entry[]`, and the majority is on the side that reinstates the round-2 blocker exactly: id strings reach `writeSnapshot`, which now throws rather than writing an unusable row, so the failure relocates from an empty catalogue to a refresh that cannot complete.

This is the same defect the N1 fix diagnosed in its own prose — "this very file contained two tests asserting different types for this one field, and the one matching production was not the one `writeSnapshot` was written against" — reproduced one file along. `merge.test.mjs` was cleaned of it with a comment explaining why; `tiers.test.mjs` was not.

Fix: rewrite the three assertions against `Entry[]`. For 8086, assert `r.providers.get("acme").map((m) => m.model)` equals the id list, and rename the test, whose title still says "model ids". For 8107 and 8115, the same mapping. Then add to B6 the check `merge.test.mjs` already carries: one helper minting entries, used by every fixture in the file, so the type cannot drift apart inside a single file a third time.

**N9. `resolveHealth` refuses `ok` for every listing-sourced entry, which contradicts five assertions in its own test file and throws away the keyed/keyless distinction `writeHealthFromOutcomes` was just rewritten to make (line 8750).**

The new clause is `if (entry?.source === "listing" || !entry?.lastOk) return "stale";`. It has two independent problems.

*It discards the writer's distinction.* `writeHealthFromOutcomes` computes `const keyed = tier >= 2` (8869) and branches: a keyed tier writes `{lastOk, lastFail, consecutiveFails, source: "listing", at}`, a keyless tier writes `{source: "listing", at}` and nothing else. The comment at 8879–8881 explains that the keyless branch omits `lastOk` precisely so the reader renders it stale. But `source` has only two values and the writer stamps `"listing"` on both branches, so the reader's first disjunct returns `stale` for the keyed branch too. Every field the keyed branch carefully writes is then unreachable: `lastOk` is never read on that path, and `consecutiveFails` is read only by the `>= 3` broken check above. Tier 2 — a real keyed `/models` call against the user's own credential — can never promote a provider to `ok`. The only remaining producer of `ok` is `writeHealthFromProbeFile`, which is a manual one-shot fold run once by hand in Step 3b and re-run by nothing. Fourteen days after that fold, every probe entry ages past `MAX_HEALTH_AGE_MS` and all 44 rows read `stale` — which is the constant column Step 3b exists to prevent, arriving on a delay.

*It contradicts five assertions in `health.test.mjs`.* Two are new tests written for this very fix; three are round-1 tests the new clause broke without being reconciled:

- 8598: `resolveHealth({}, h.providers.other, h, …)` expected `"ok"`, with the rationale "tier 2 is keyed, so its `lastOk` is real evidence for a provider the probe missed". The entry is `{lastOk: NOW2, consecutiveFails: 0, source: "listing", at: NOW2}` → returns `"stale"`.
- 8615: same shape, same expectation, same result.
- 8658: `resolveHealth({notes: ""}, {consecutiveFails: 2}, fresh, NOW)` expected `"ok"`. The entry has no `lastOk`, so the second disjunct fires → `"stale"`.
- 8679: `resolveHealth({notes: ""}, undefined, fresh, NOW)` expected `"ok"` — the test is titled `a provider with no recorded probe is ok, not broken`. `entry` is `undefined`, so `!entry?.lastOk` is true → `"stale"`.
- 8687: `f("unknown-provider")` expected `"ok"` → `"stale"` by the same path.

B7 Step 4's `# fail 0` cannot hold. As with N8, the danger is the direction of repair: satisfying the five tests means deleting the clause, and deleting the clause restores exactly what N3 was raised about — a listing, including a keyless tier-1 listing, asserting that the user's key works.

Both sides are individually defensible and the plan does not say which is intended, which is why this blocks rather than merely annoys. My reading of the design intent, offered as a starting point rather than a decision: the writer's branching is the honest part and the reader should key on the evidence rather than on the source label. Give the entry a third state — either `source: "listing-keyed"` or a separate `keyed: true` — write it from the `keyed` branch, and have `resolveHealth` return `stale` for keyless listings and unrecorded entries, and `ok` for a keyed listing with a fresh `lastOk` and fewer than three consecutive failures. That keeps `ok` off keyless evidence, keeps tier 2 useful, and preserves the probe precedence at 8872 unchanged. Whichever way it goes, the five assertions and the clause have to be brought into agreement in the same edit, and 8679/8687 need an explicit decision about what an entirely unmeasured provider renders — today they say `ok`, and the surrounding argument for `stale` applies to them at least as strongly as it does to a listing.

### MAJOR

**N10. `/[\]/g` at lines 7525 and 7526 is an unterminated character class — a `SyntaxError` that stops `merge.test.mjs` from loading at all, including the two gate tests written for the round-2 blocker.**

Both lines read `.replace(/[\]/g, "/")`. Inside a character class `\]` is an escaped literal `]`, so the class never closes and the regex literal never terminates. Node raises `SyntaxError: Invalid regular expression: /[\]/: Unterminated character class` while parsing the module, before any test runs. The intent is plainly a backslash-to-forward-slash path normalisation; every other instance of this idiom in the plan is written correctly as `/\\/g` (963, 3087, 4364, 4486, 4592, 5326, 5660, 6065, 7131, 7232, 8470, 9013, 9185), which is what makes these two recognisable as the shell-heredoc mangling the Planner reported fixing rather than a deliberate variant.

The consequence is larger than two lines. B5 Step 2 expects the specific failure `does not provide an export named 'classify'` and will instead get a parse error, and B5 Step 4 expects `# fail 0` from a file that cannot be loaded. Everything in `merge.test.mjs` is disabled — including `a written entry survives the real loader AND still prices` (7531), which is the end-to-end gate the round-2 blocker fix was built around, and `writeSnapshot refuses an id string` (7567), which is the assertion that would otherwise catch N8's fallout. The two tests most load-bearing for N1 are the ones this silences.

Fix: `/\\/g` on both lines.

**N11. `refresh/cli.mjs` calls `writeHealthFromOutcomes` but no task ever imports it, so every non-dry-run refresh throws after the catalogue has already been promoted (call at 8462, import block at 8288–8300).**

`main()` calls `writeHealthFromOutcomes(next, now, { tier })` at 8462 and `rebuildPickerSnapshot(...)` at 8463. The second is fine: B10 defines it as a local function in the same file at 9327 and adds its two imports at 9320–9321. The first is not defined or imported anywhere. B6's import block imports `catalog-store`, `tiers`, `probe`, `ccr-client`, `denylist`, `catalog` and `keysync` — not `health-writer`. B7 lists `Modify refresh/cli.mjs` in its Files line and adds an import instruction for `menu/catalog.mjs` ("Then add the import at the top of the file"), but never for `cli.mjs`. B10 also modifies `cli.mjs` and adds only the snapshot imports.

The ordering makes this worse than a missing line. `writeSnapshot` at 8452 has already created the version directory and flipped `current`, so the `ReferenceError` lands after promotion: the catalogue advances, `health.json` is never written, `rebuildPickerSnapshot` never runs, and the picker keeps rendering the previous `snapshot.json` against a catalogue that has moved. The process exits 1 via the `main().catch` at 8471, so it is at least loud — but it is invisible to B6's own verification, whose only CLI exercise is `--tier 1 --dry-run` (8484), and `dryRun` returns at 8441 before reaching either call. The first execution that reaches line 8462 is B10 Step 4's live `node refresh/cli.mjs --tier 1`, at the very end of Phase B.

Fix: add `import { writeHealthFromOutcomes } from "./health-writer.mjs";` to `cli.mjs`, in B7 Step 3b where the function is created, and say in B6 that the call at 8462 is satisfied by a later task so the module ordering is deliberate rather than accidental.

### MINOR

**N12. Tier 3 injects a synthetic `__verify-cli` provider into the merge ledger and, through it, into `health.json` (line 8267).**

`tier3` returns `new Map([["__verify-cli", {kind, at, models: []}]])`. `main()` passes that straight to `mergeSnapshot` (8449), which unions the outcome keys with the previous provider names, finds no prior entry, skips the shrink guard (which requires `before && before.count > 0`) and calls `mergeProvider(null, …)`. A provider named `__verify-cli` with zero models is written into `index.json` and persists. Three downstream effects, each small: the next tier-2 run takes its target list from `Object.keys(prev.providers)` (8414) and asks CCR to `probeProvider("__verify-cli")`, which fails and records a soft outcome forever; `writeHealthFromOutcomes` gives it a health entry; and it appears in the `stale providers:` line at 8456 once it starts failing. The `Entry` type itself holds here — an empty array is a valid `Entry[]` — so this is not an N8 instance, and I could not tell whether it predates the round-2 edits. Fix: have `main()` skip outcome keys that are not vault provider ids, or have `tier3` return an empty map and report its result on stdout instead of through the ledger.

**N13. B7's Interfaces line for `writeHealthFromOutcomes` no longer matches the function it describes (line 8503 vs. 8867).** The Interfaces block declares `writeHealthFromOutcomes(snapshot, now, out?) -> object`; the implementation is `(snapshot, now, { out = HEALTH, tier = 1 } = {})`, and the call site at 8462 passes `{ tier }`. A caller following the declaration would pass a path string as the options object, silently getting `out = HEALTH` and `tier = 1` — which is the keyless branch, so a tier-2 refresh would record no keyed evidence. `writeHealthFromProbeFile(file, out?)` on the line above genuinely does take a bare path, which makes the two easy to confuse. This is a one-line documentation drift, and it is the same prose-versus-code disagreement that N1 grew out of, at very low stakes. Fix: `writeHealthFromOutcomes(snapshot, now, opts?: {out?, tier?}) -> object`.

## Closing note

I found nothing to contest this round — every round-2 finding was accepted, and the two partial resolutions are partial in execution rather than in judgement. Both N8 and N9 are the fix being applied to the production code and the prose while assertions encoding the superseded contract stayed behind, and both were reachable only by reading the tests against the implementation line by line rather than by reading either alone. That is worth saying plainly because it is the third consecutive round in which the highest-severity finding has been a disagreement between two parts of the plan that were each individually correct. The mechanism the plan already uses against this — `merge.test.mjs`'s single `E()` helper and the comment above it explaining what it prevents — works, and is the thing to copy into `tiers.test.mjs` and `health.test.mjs` rather than fixing the individual assertions and moving on.

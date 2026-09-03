# Architect Review — Phase 6 plan

Reviewer: `oh-my-claudecode:architect` (read-only), session `76ac34d9-c9e8-43f4-8cfa-18bf9783c39c`, 2026-09-03.
Plan snapshot: `phase6-menu-and-catalogue.md`, 6750 lines, sha256 `5f47b3e32dba62d7f871d2a817598b67bce6d2e78bfdf2259cf5ae2ba39b5f6a`.
Verdict: **SOUND-WITH-CHANGES** — 5 BLOCKERs, 8 MAJORs, 6 MINORs.

This file must NOT be given to the Critic. It is input for Planner synthesis only, after the Critic has also reviewed the same snapshot.

## Antithesis

The load-bearing bet is not "a TUI" but a synchronous blocking `readSync` on `//./CONIN$` as the input primitive. It kills the event loop, which kills the asynchronous routability RPC the plan promises in Q1.3 and then implements as a `.then()` that can never fire (line 3144); it kills the `on("resize")` listener at line 3146; it forces `Atomics.wait` as a sleep; it forces a PowerShell wrapper whose ~200 ms is roughly two-thirds of the 300 ms budget the plan then measures without counting it; and it forces the key-coalescing defect at line 1798. Option D (the `UserPromptSubmit` two-round numbered picker) was rejected only because it cannot narrow a list per keystroke, but the two-level structure already cuts 1,584 models to 44 providers and then one provider's models. A two-round hook picker accepting a filter string per round gets most of the filtering benefit and needs no `cc-contract.mjs`, no `SetConsoleMode`, no `cmd` dispatcher, no sentinel capture, no console-mode restore proof, no installer rewriting `EDITOR`, and no `uw doctor`. Six of 27 tasks (A4, A12, A13, A15, A16, A17) exist solely to contain the consequences of one input primitive.

## Tradeoff tension

The plan requires an instant static snapshot (Q1.1, Q1.2) AND two live columns: health (constraint 6) and routable dimming (constraint 7). Freshness costs a round trip; the blocking read forbids one. Routability is made async, which the input loop makes unreachable; health is a file nothing writes (B7 says so). With `readHealth()` returning `generatedAt: null`, `resolveHealth` computes `age = Infinity` and returns `stale` or `needs $` for all 44 providers: eight columns of noise that contradict "blank beats a guess". Unasked question: is a six-column picker with two dead columns better than a four-column picker with four live ones?

## Synthesis

Move both live facts out of the picker and into the snapshot build. `refresh/cli.mjs` already has an event loop, credentials via CCR, a lock, a version directory, and no latency budget. Fold the three probe scripts (`key-health.mjs`, `key-health-reprobe.mjs`, `key-health-live3.mjs`) into tier 2/3 as the health producer (`key-health.mjs` already produces the `ok/auth/broken` classification `health.json` needs; `key-health-live3.mjs` is already tier 2 written by hand). Have the same CLI compute routability once, and bake both columns into `snapshot.json` with per-column `asOf` stamps. The picker then does zero async work and becomes what its architecture actually is: a synchronous renderer over one pre-computed file. Every column is live-as-of a printed timestamp. Cost: one field per row. Buys deletion of `routable.json`, the async RPC path, the `resolveHealth` staleness ladder, and the resize handler that cannot fire. Makes Q1.2's 300 ms budget trivially satisfiable.

## Findings

### BLOCKERs

**1. B1/B2 (lines 4729–5070). Denylist lands in the wrong module; the hijack path stays open.**
B1 creates `menu/denylist.mjs` and B2 wires it into `menu/catalog.mjs`, the display path. The real routing-hijack primitive from report 08 is `keysync.mjs:buildProviders` (lines 167–205), which sorts remote catalogue entries free-first and takes the top `MAX_MODELS_PER_PROVIDER = 3` into CCR's live config:

```js
const ranked = catalogEntries
  .map((m) => ({ m, tier: inferTier(m) }))
  .sort((a, b) => (a.tier === "free" ? 0 : 1) - (b.tier === "free" ? 0 : 1) || a.m.model.length - b.m.model.length);
```

No denylist call exists on this path anywhere in the plan. A hostile aggregator publishing a zero-priced `opus` still gets promoted. The ordering constraint is satisfied in letter, violated in substance, because B2's `inferTier` fix arms free-first ranking in the one function with no guard.
Fix: call `admitRemoteModels(catalogEntries)` immediately before the `ranked` assignment in `buildProviders`, exempting only `provider === "anthropic"`. Replace B1's git-log-ordering test with a source assertion that greps `keysync.mjs` for the denylist import and fails if `ranked` is computed without it.

**2. B4/B5 (lines 5492, 5790). Refresh output can never be read by the picker.**
B4's `resolveCatalogPath` resolves `path.join(VERSIONS, stamp, "models.json")`. B5's `writeSnapshot` writes `path.join(dir, "index.json")`. Different filename, and different shapes (CCR schemaVersion-2 model list vs `{ generatedAt, providers }`). The `models.json` branch is dead the moment a refresh runs, so B10 keeps reading the copied bundle forever and every merge, stale marker and shrink floor in B5 computes into a file nothing loads.
Fix: one filename, one shape. `writeSnapshot` emits `models.json` in the schemaVersion-2 envelope `catalog.mjs` already parses, with `stale`/`staleSince` as extra per-row fields. Test must run a refresh and then load the result through `catalog.mjs`'s real loader, not a fixture.

**3. A10/Q1.3 (lines 3125, 3144, 3146). Routability column and terminal resize are unreachable code.**
`let routable = new Set();` … `routableSet({timeoutMs:400}).then((r) => { routable = r.set; draw(); }).catch(() => {});` … `if (out.isTTY) out.on("resize", () => draw());` then `for (;;) { readSync(CONIN, ...) }`. Blocking `readSync` never yields, so `.then` cannot run and resize cannot fire; `out.isTTY` is also false under the handoff per the plan's own measured facts. The column renders empty every session.
Fix: compute routability in `refresh/cli.mjs`, persist into `snapshot.json` with `asOf`, delete `routable.json`, the async call and the resize listener. A truly live column needs a timed `readSync` returning control each frame, a much larger change than a task edit.

**4. A6 (line 1798). Coalesced key reads are dropped.**
`if (key.length >= 3 && c0 === 27 && key[1] === "[") { // arrows` — `readSync` on `//./CONIN$` returns the whole buffer, so a fast repeat delivers `ESC[A ESC[A ESC[A` as one chunk and moves once; a 2-byte chunk falls through every branch and is discarded. Held arrows feel broken, paste loses characters. This sits in the reducer, the most-tested module, so single-key fixtures pass.
Fix: tokenise before dispatch. If the chunk starts with `ESC[`, consume the full CSI (final byte `@`–`~`), else one UTF-8 code point; feed each token to the reducer; draw once. Test: `Buffer.from("\x1b[A\x1b[A\x1b[Bx")` asserts net one row up plus one filter character.

**5. A15 (lines 3950–4343). `uw doctor` greens on the exact failure it exists to catch.**
`checkHandoff` reads `rows[rows.length-1]` from `~/.uw/state/handoff.json`, written by the last successful handoff. After CC changes its editor protocol the picker stops being invoked, no row is appended, and doctor reports stale success as green forever. `readClaudeFingerprint` regex `/Running:\s*\S+\s*\(([^)]+)\)/` mirrors undocumented `claude doctor` output, so a format change makes it silently unparseable; the amber path exits 0 and re-pins, turning "CC changed under us" into "recorded, carry on".
Fix: (a) staleness bound: newest row older than N days AND claude run since = red; (b) fingerprint-parse failure = red, not amber; (c) never auto-re-pin, require `uw doctor --accept-fingerprint`.

### MAJORs

**6. A16 (lines 4573, 4591). `settings.json` round-trip corruption.**
`($json | ConvertTo-Json -Depth 20) | Set-Content` round-trips the user's whole `settings.json`. PS 5.1 unrolls single-element arrays on ConvertFrom/ConvertTo, so a one-element `permissions.allow` or one-hook array can come back scalar and break the OMC config the plan promises not to disturb. Blast radius is the entire CC config.
Fix: do not round-trip. Read as text and patch only the `statusLine` node (targeted edit, or shell to `node -e`, which round-trips JSON losslessly). Timestamped backup before any write, print its path.

**7. B6 (line 6080). Tier 1 bypasses the denylist.**
`for (const [name, models] of r.providers) outcomes.set(name, { kind: "ok", models, at: now });` ingests models.dev `api.json` with no `admitId`, no `admitRemoteModels`. models.dev is exactly the untrusted remote-string source the security constraint names.
Fix: run tier 1 rows through `admitId` + `admitRemoteModels` before `outcomes.set`; same at line 6083.

**8. B6 (line 6083). Production imports the test harness.**
`const { rpc } = await import("../harness/config.mjs");` — tier 2 pulls its CCR gateway from the harness (test ports 39456+). Fails in production, or worse succeeds against a stale test gateway and refreshes from a fixture.
Fix: import `rpc` from `menu/ccr-client.mjs`; the harness injects the base URL by parameter, not module identity. Add a test grepping `refresh/` for `harness/` imports.

**9. B5/B6 (line 6054). ETag never persisted.**
`mergeSnapshot` returns `{ next: { generatedAt: now, providers }, refused }`; the upstream ETag is dropped, so the next run cannot send `If-None-Match` and the 304 path is unreachable. The conditional check degrades to a full download every refresh.
Fix: carry `etag` through `mergeSnapshot` into the written snapshot and read it back in tier 1; assert that a second consecutive refresh sends `If-None-Match`.

**10. B7 (~line 6290). Health column is a hole, not a deferral.**
The plan states "nothing writes health.json yet." `resolveHealth` branches on `consecutiveFails`, which `mergeProvider` never computes; `age` from a null `generatedAt` is Infinity, so every row gets the same stale/needs-$ verdict. A constant column trains the user to ignore it and violates "blank when uncertain".
Fix: either ship the producer in the same phase (fold `key-health.mjs`'s ok/auth/broken into tier 2, emit `consecutiveFails` + `lastOkAt` per provider), or delete the column and `resolveHealth` from Phase A and land both in Phase B. Never ship a render path for data with no writer.

**11. A11 (lines 3312, 3336). Bench measures the wrong path.**
`detectCaps({ TERM: "dumb" }, 80)` runs the no-colour no-motion branch, skipping exactly the animation/styling work the 300 ms budget bounds. `WRAPPER_SOFT_MS = 700` is declared and never referenced, so the PS wrapper (where `Add-Type` compilation happens, the largest fixed cost) is unbudgeted.
Fix: bench the real capability set; add a wrapper-inclusive measurement (`uwpick.cmd` entry to first frame) asserted against `WRAPPER_SOFT_MS`, or delete the constant.

**12. A14 (lines 3736–3949). HUD shim parses the full snapshot on every statusline repaint.**
File I/O plus JSON parse on a hot path the user feels as terminal latency. It also derives the name from `model.display_name`, but the plan never measures what `model.id` looks like for a non-Anthropic model routed through CCR, so the snapshot-row mapping is unverified.
Fix: cache the parsed snapshot keyed on mtime, or have refresh write a tiny `hud.json` with only the needed fields. Measure the real statusline JSON for a CCR-routed non-Anthropic model first.

**13. Cross-cutting. Fold the three probe scripts into tiers 2/3; `testModelVerifiedAt` is warranted.**
`key-health.mjs` / `-reprobe` / `-live3` already implement tier 2+3: keyed `/models` listing, candidate scoring, one `max_tokens: 8` chat, ok/auth/broken. Ad-hoc scripts guarantee drift. The plan asserts testModel-leads as settled, but the same measurement that gave 34/9/3 showed `providers.json` `testModel` values are stale while live `/models` works; the plan has zero references to any verifiedAt field, so nothing records when a testModel was last proven.
Fix: `refresh/probe.mjs` called by tier 2 (listing) and tier 3 (billed, behind `--i-know-this-bills`); add `testModelVerifiedAt` to `providers.json`, written only by tier 3; keysync prefers a catalogue id over a testModel older than the freshness window.

### MINORs

**14. B5/B6. Provider namespace collision.** Tier 1 keys outcomes by models.dev provider name, tier 2 by vault provider id; where they differ one silently overwrites the other and `SHRINK_FLOOR` compares counts across sources. Fix: namespace keys (`modelsdev:<name>` / `vault:<id>`) or an alias table with a test that every tier 1 name resolves to exactly one vault provider or is dropped.

**15. A4 (lines 662–966). Fingerprint describes shape, not version.** `fingerprint: "service.json + /api/ccr/rpc + x-ccr-web-auth"` passes a CCR upgrade that keeps the shape but changes semantics. `bundledCatalogue` hard-codes `C:/nvm4w/nodejs/node_modules/...`, which breaks on any Node version change under nvm4w. Fix: include the CCR `package.json` version in the fingerprint; resolve via `require.resolve("@musistudio/claude-code-router/package.json")` with a configured fallback.

**16. B4/B5. Tests touch the live catalogue.** Several tests operate on `~/.uw/catalog/`, the directory the running session's picker reads, violating the isolation non-negotiable. Fix: thread a root path through `resolveCatalogPath` / `acquireCatalogueLock` / `writeSnapshot`; tests use a temp dir.

**17. A10 vs ADR. Exit-code contradiction.** The ADR says non-zero exit is the clean-abort path and Q2.6 depends on it, but `finish()` always exits `CONTRACT.handoff.acceptExit` (0), including Esc, ctrl+c, and the no-CONIN fallback, so Esc commits the buffer as chat input. Fix: non-zero on Esc/ctrl+c/CONIN-unavailable, 0 only after a model is chosen and written; dispatcher test per outcome.

**18. Scope is ~3x the estimate.** Report 09 said ~550 new lines; the plan carries 27 tasks and ~4,820 lines of fenced code. Mergeable: A3 into A5, B1 into B2, B7 into B6, A11 into A8. Deferrable: A14 entirely, and the `-Hud` half of A16. Removes five task boundaries and about a third of the surface with no behaviour lost.

**19. B5 (line 5793). Retention race.** `fs.readdirSync(VERSIONS).sort().slice(0, -3)` prunes on every write including no-change writes; a picker that just resolved `current` can lose its directory mid-read. A 304 should produce no new version at all. Fix: skip write and prune on 304; prune only versions older than the current pointer AND older than a ~10 minute grace window.

## Verdict

SOUND-WITH-CHANGES. The free definition, badge semantics and phase split are right, but the five blockers (denylist in the wrong module, refresh output the picker cannot read, unreachable async columns, dropped coalesced keys, doctor greening on its own failure case) must be fixed before implementation starts.

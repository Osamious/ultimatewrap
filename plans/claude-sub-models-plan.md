# Plan: dynamic Anthropic subscription models (branch `claude-sub-models`)

Written 2026-09-05. Branches from `phase6` (bookmark of `master` @ `f2ff7ca`).

## Problem

`ANTHROPIC_PICKER` in `keysync.mjs` is a static, hand-tagged `[1m]` array. Anthropic
changing a model's context window, or shipping a new model, requires a manual code edit
or it silently goes stale. Established this session via live verification (not assumption):

- Relay's `/v1/models` is a pure, unmutated passthrough of Anthropic's real API (confirmed
  by curl + relay source read). It already returns `max_input_tokens` per model, live,
  official documented field (`platform.claude.com/docs/en/api/models/list`).
- CC's `modelPicker.options[]` schema has exactly 4 fields: `model`, `label`, `description`,
  `behavesAs`. No numeric context field. CC's client-side `Gc(e) = /\[1m\]/i.test(e) → 1e6`
  (report 16, confirmed) is the ONLY lever — string suffix, nothing else.
- Prior art: `hishamkaram/claude-code-router` fork ships the same pattern — `[1m]` from
  live discovery, discovered values over static hints, stale cache preferred over nothing.

## Decisions already made (do not reopen without asking)

1. Context-window tagging: fully dynamic, computed from live `max_input_tokens`, for the
   curated 4 ids only (`ANTHROPIC_FULL`: opus-5, sonnet-5, haiku-4-5-20251001, fable-5-1).
2. Model existence (routing/co-ownership side, `ANTHROPIC_RELAY.models`/`.routing`):
   auto-add. A live id beyond the curated set joins routing automatically — this is our
   own authenticated relay call, not third-party data, so no reseller-hijack risk; more
   co-owned ids only strengthens `checkBareCollisions`.
3. Model existence (picker side, what shows as a numbered `/model` row): detect-and-warn,
   NOT auto-add. Reasons: row-number stability (muscle memory), `/v1/models` can list
   non-chat variants, subscription-tier inclusion isn't guaranteed by an id merely existing.
4. Native `modelPicker.options[]` is repurposed to Anthropic-subscription-only (curated 4
   rows). All other 43 providers stay reachable via `uwpick.mjs` (Ctrl+G) exactly as today
   — confirmed via code read that `uwpick.mjs` deliberately does not read
   `modelPicker.options` at all; it reads an independent pre-built catalogue snapshot.
   `built.providers` (CCR's actual routing config, all 44) is untouched.
5. Detect-and-warn surfaces in two places: a real banner in `uwpick.mjs`'s TUI, and a
   passive note appended to a picker row's `description` in the native menu (schema has no
   room for a 5th non-selectable info row).
6. Ceiling, accepted: `Gc()` only recognizes `[1m]`. A hypothetical 2M-context model needs
   a CC release regardless of path — not a regression versus native mode.

## Interface changes

### `keysync/anthropic-catalog.mjs`

- Extend the cache record to `{at, models: [{id, max_input_tokens}]}` (was `{at, ids}`).
- Add `fetchAnthropicCatalog(opts)` → same fetch/cache/TTL/fallback machinery as
  `fetchAnthropicIds`, returns `{ids: Set<string>, contextById: Map<string, number>} | null`.
- `fetchAnthropicIds` becomes a thin wrapper: `(await fetchAnthropicCatalog(opts))?.ids ?? null`.
  Existing call site in `run.mjs` (item 4's `realIds`) and its 8 existing tests are
  unaffected — same null/stale-cache/empty-response semantics apply to the richer shape.

### `keysync/keysync.mjs`

- Keep `ANTHROPIC_FULL` (curated, reviewed, static — adding a new id here stays a
  deliberate 1-line human edit).
- Remove the static `ANTHROPIC_PICKER` constant. Replace with a pure, exported function:
  `buildAnthropicPickerRows(curatedIds, contextById, fallbackTags)` — for each curated id,
  tag `[1m]` iff `contextById.get(id) >= 1_000_000`; if `contextById` has no entry for that
  id (live data unavailable for it specifically), use `fallbackTags[id]` (the current
  hand-tagged default, kept as the safety net, never deleted).
- `ANTHROPIC_RELAY.picker` (as a static export) becomes the FALLBACK tag set used when the
  live fetch fails entirely — i.e. today's exact hardcoded array, now documented as a
  fallback rather than the live truth. `ANTHROPIC_RELAY.models`/`.routing` stay
  `ANTHROPIC_FULL` as the static safety net for the same failure case.
- `validate()`'s `[1m]`-tolerance check is unaffected (still strips-and-compares).

### `keysync/run.mjs`

- Reuse the existing `await fetchAnthropicIds()` call site (item 4) — upgrade it to
  `await fetchAnthropicCatalog()`, deriving `liveIds`/`contextById` from one result so the
  network call isn't duplicated. `realIds` computation (item 4, security guard) unchanged
  in behavior.
- `routingIds = liveCatalog ? new Set([...liveCatalog.ids, ...ANTHROPIC_FULL]) : new Set(ANTHROPIC_FULL)`
  — feeds `ANTHROPIC_RELAY`'s provider entry `.models` for `built.providers` (auto-add,
  decision 2). This is what CCR actually routes on — full 44-provider `built.providers`
  unaffected otherwise.
- `pickerRows = buildAnthropicPickerRows(ANTHROPIC_FULL, liveCatalog?.contextById ?? new Map(), FALLBACK_TAGS)`
  — curated ids only, dynamically tagged.
- `newIds = liveCatalog ? [...liveCatalog.ids].filter(id => !ANTHROPIC_FULL.includes(id)) : []`.
  If non-empty: console warning block (existing style, see current relay-status lines),
  AND write `~/.uw/state/new-anthropic-models.json` (`{at, ids: newIds, contextById: {...}}`)
  via the existing atomic-write helper. If empty, delete that file if present (self-clearing
  once a human adds the id to `ANTHROPIC_FULL` and re-runs).
- Settings write (`options: ...`): use `pickerRows` only (curated 4, not `built.picker`'s
  full 87) for `modelPicker.options`. If `newIds` non-empty, append a short note to the
  first row's `description` (e.g. `"subscription (new: <id> detected, not added)"`).
- `built.picker` (full 87) still exists internally for whatever else currently reads it
  (verify `rowExists`/`ANCHOR_PREFERENCE`/`reconcileUserModelPin` — confirm before changing
  whether they need the full list or the scoped one; do not assume).

### `menu/uwpick.mjs`

- New, narrow addition: on startup, check `~/.uw/state/new-anthropic-models.json`. If
  present, render one banner line at the top of the TUI. This is the one new coupling
  point between keysync's Anthropic-catalog concern and uwpick's UI — everything else
  about their existing decoupling (uwpick never reads `modelPicker.options`) stays as-is.

### Tests

- `anthropic-catalog.test.mjs`: existing 8 tests stay valid for `fetchAnthropicIds`
  (wrapper). Add tests for `fetchAnthropicCatalog`'s `contextById` — same fallback/failure
  matrix, extended for the new field.
- `denylist.test.mjs`: reframe the two exact-`deepEqual` tests on `ANTHROPIC_RELAY.picker`
  as "fallback shape when live data is unavailable" (still valid assertions, just
  re-labeled). Add new tests for `buildAnthropicPickerRows` covering: live data confirms
  1M → tags; live data confirms <1M → bare; live data missing for one id → falls back to
  that id's hand-tagged default; mutation-test the boundary (`>=` vs `>` at exactly
  1,000,000) the same way the original `[1m]` fix was verified.
- New tests for the `newIds` diff logic and the settings-write scoping (picker rows
  written = curated 4, not all 87).

## Sequencing

1. `anthropic-catalog.mjs`: add `fetchAnthropicCatalog`, keep `fetchAnthropicIds` as wrapper.
2. `keysync.mjs`: add `buildAnthropicPickerRows`, keep old array as named fallback constant.
3. `run.mjs`: wire the above, add `newIds` diff + warning + state file, scope the
   `modelPicker.options` write.
4. `uwpick.mjs`: read the state file, render banner.
5. Rewrite/add tests per above. Run full suite.
6. Mutation-test the new dynamic-tagging boundary and the picker-scoping change, same
   rigor as the original `[1m]` fix (that work found two real gaps this way already).
7. Independent review pass before calling it done.

## Addendum (post-review, decisions 2 and 3 revised)

Both an independent code review and a security review ran against the first implementation.
Two real findings changed the design:

**Security review, HIGH: decision 2 as first implemented broke the collision guard.**
`routingIds` (feeding `Providers[].models`, decision 2's auto-add) and `realIds` (the
guard's filter, item 4) reduced to the identical set (`liveCatalog.ids ∪ ANTHROPIC_FULL`
both). Since the relay's actual `Providers[]` entry then owned every id the guard even
considers, `hijackable` (the FATAL path) became structurally unreachable whenever the
catalog resolved — verified directly against live data (`claude-opus-4-8`, served live by
the relay and also listed by `tabiai`/`gorouter`, went from FATAL on master to a silent
informational note on this branch). A second, independent code review concluded the guard
was untouched, checking only whether `realIds`'s formula text changed (it hadn't) without
tracing that `routingIds` now feeds the relay's actual owned set — a reminder that
"the line didn't change" is not the same claim as "the behavior didn't change."

**Decision, superseding the original decision 2 wording:** keep routing auto-add (a live id
still joins `Providers[].models`, still reachable), but the guard's ownership check no
longer treats the relay as a *safe* co-owner for an id unless that id is also in
`ANTHROPIC_FULL` (curated). A reseller sole-listing a live-but-uncurated id must still be
FATAL, exactly as it is against `ANTHROPIC_FULL` alone today — auto-add must not be able to
silently launder a real hijack into an accepted ambiguity. `checkBareCollisions` gains a
`relayOwned` set (curated-only), used only to decide whether the relay's presence in an
id's owner set counts toward safety; `realIds` keeps its existing broad role (which ids the
analysis considers at all).

**User decision, decision 3 reversed: the native `/model` picker shows every live id, not
just the curated four.** Live evidence changed the calculus: all 11 ids currently returned
by `/v1/models` report `type: "model"` (no field exists to classify chat vs. non-chat
variants — the concern behind the original decision 3 caution is unfalsified but also
unsupported by anything observed), and the seven ids beyond the curated four are
recognizable prior-generation Claude models (`claude-opus-4-8/-4-7/-4-6`,
`claude-sonnet-4-6`, `claude-fable-5`, dated `claude-opus-4-5-20251101` and
`claude-sonnet-4-5-20250929`) — not obscure or specialized entries. Row-number stability
(the original concern) is explicitly waived by the user. `ANTHROPIC_FULL` stops being "the
rows we show" and becomes fallback-only, used when the live fetch fails entirely with no
cache. An id with neither live context data nor a hand-tagged fallback default renders
bare (no `[1m]`) — under-claiming context is a display inaccuracy; over-claiming risks a
model accepting a prompt larger than it can actually hold.

**Consequence: decision 3's reversal makes Option B for the guard fix mandatory, not just
preferred.** If the picker shows a live-but-uncurated id as a selectable row, it must
actually route (Option A — revert auto-add to curated-only — would leave freshly-shown rows
dead on selection).

Also folding in, from the same two reviews, independent of the above:
- `diffNewAnthropicIds`'s null (`liveCatalog` unavailable) and empty (`confirmed no new ids`)
  results are indistinguishable to the caller; the state-file deletion at the call site must
  only fire on the confirmed-empty case, never on "could not check."
- The uwpick banner line must be clipped to `FRAME_W`, the same as every other line via
  `bar()`/`clipVisible` — unclipped, it breaks the `+ (banner ? 1 : 0)` flash-row
  compensation and wraps on an ordinary terminal.
- `routingIds`/`relayAliases` (or whatever the post-fix equivalents are named) must be
  extracted as exported, directly testable pure functions, same precedent as
  `checkBareCollisions`.
- Three hardcoded `"anthropic"` string literals restating `ANTHROPIC_RELAY.name` should
  derive from the one constant.
- The new-id description note must never land on a non-Anthropic row when scoping produces
  zero Anthropic rows.
- `atomicWriteJson`'s target directory must be created before write, not assumed to exist.
- The stale `relayHelps` remedy message must check against the effective (post-fix) routing
  set, not the old static `ANTHROPIC_RELAY.routing`.
- A test should pin whatever relationship the fixed `relayOwned`/`routingIds`/`realIds`
  sets are required to hold, so a future edit cannot silently reintroduce this class of bug.
- Apply a staleness ceiling to the cache when it feeds routing specifically (not the guard).
- The new-models state file write should not precede the guard's fatal-exit check in a way
  that leaves a stale/wrong banner advertising a rejected configuration.

## Decision 4 REVERSED, 2026-09-06 — the native picker carries all rows again

Decision 4 scoped `modelPicker.options[]` to Anthropic-subscription rows only, to drop "83 rows
of third-party noise from a flat native menu." That was decided without knowing the field
serves two roles at once.

Established 2026-09-06 by direct binary read (build 2.1.261): `options[]` is **simultaneously
the rendered `/model` row list and the only registry that can hold `behavesAs` for an arbitrary
number of models.** `Ato()` builds the visible rows from it and `_re()` reads `behavesAs` from
the same array. Dropping a row therefore drops that model's capability declaration.

Consequence, which decision 4 was never weighed against: a third-party id with no `behavesAs`
on UW's `firstParty` shape resolves through `lH()` to the **maximal** assumption set — every
effort tier offered, adaptive thinking on, thinking forced un-disableable — plus an
unknown-model launch warning. Report 18 §3 measures that as strictly worse than any bucket
choice. So the scoping traded menu tidiness for a silent capability regression on all 83 rows.

Alternatives checked before reversing, both dead:
- **`modelOverrides`** — right visibility (produces no picker rows), confers the identical
  eight-predicate profile through the same `Fe`→`RL`→`_i` chain, flips `isKnown`. But its key is
  the *Anthropic* id and the baked catalog holds 19 models, so unique JSON keys cap it at **19
  declarations, not 83**. A first-party-spelled key also hijacks that Anthropic model's outgoing
  id (`a_()` rewrites the resolved-model table), which is the Bedrock-ARN feature working as
  designed and fatal for use as a silent declaration.
- **A hidden-row field** — none exists. The row schema is exactly `{model, label?, description?,
  behavesAs?}`, confirmed from the binary's own zod definition. The one structural way to hide a
  row while keeping its `behavesAs` (failing `Gun()` via the `availableModels` allowlist) also
  makes the model unselectable and unusable.
- **`modelSettings`** — keyed by model id with unbounded cardinality and no rows, so the right
  shape, but it carries only `effortLevel`, a preference rather than a capability declaration.

**Decision: revert the scoping.** All rows go back into `modelPicker.options[]`, each carrying
its own bucketed `behavesAs`, with the Anthropic subscription rows ordered **first** — `Ato()`
iterates `options[]` in array order, so render order is controllable. The menu length that
decision 4 objected to returns; it is the price of the declaration channel, and ordering keeps
the rows that matter at the top.

`scopeNativePickerOptions` in `keysync/run.mjs` and its relay-down fallback become an ordering
function rather than a filter. Note the live `settings.json` still holds the pre-scoping 87 rows
— keysync has not run `--target live` since commit `4151639`, so this reversal restores what is
on disk today rather than changing it.

## Decided, not yet built — model-type filtering in the picker

Decided 2026-09-06, alongside the `behavesAs` bucketing work (context/compaction work parked
separately). Add a "model type" field to UW's catalogue (chat / image / audio / embedding /
etc.). In `uwpick.mjs`, non-chat rows are shown (never hidden — matches this project's own
"never silently hide" stance) but greyed out and skipped by the row selector, reusing the
existing "routable dimming" UI pattern already designed for a different reason (not
currently reachable). Effect: a non-chat row can never become the active model, which also
makes the `behavesAs`-for-non-chat-models question moot — no capability profile needs to be
chosen for a row nobody can select. Default when type is genuinely unknown (catalogue
coverage will have gaps, same as context data does): SELECTABLE, not blocked — wrongly hiding
a real chat model is worse than occasionally letting an ambiguous one through.

## Explicitly out of scope for this branch

- The `behavesAs: claude-sonnet-4-6` 83-row over-declaration issue (separate, unaffected).
- BACKLOG item 5 (`run.mjs` libuv exit-code bug), parked.
- Any change to `~/.claude.json` or the deregistered spike files.
